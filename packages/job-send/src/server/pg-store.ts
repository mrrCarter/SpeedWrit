// The OAuthStore on Postgres: the tables in migrations 0001 (oauth_clients, oauth_codes,
// access_tokens, refresh_tokens) and 0002 (oauth_pending_authorizations). Every token and request
// id is stored and found by its hash only. The places where concurrent requests race are decided
// by the database, not by timing:
// - redeem: TOKEN_CONSUME_SQL's compare-and-set, also requiring an unexpired row, then the insert
//   of both new tokens, in one transaction. A loser changes no row and saves nothing.
// - takePending: DELETE ... RETURNING, so one request id is taken once.
// - redeem against revoke: both lock the agent connection's row first (redeem FOR SHARE, revoke FOR
//   UPDATE). Under READ COMMITTED a revoke's statements cannot see a redeem's uncommitted pair, so
//   without the lock a pair minted during a revoke would outlive it (Bundle, #531). With it, a revoke
//   that comes first makes the redeem's compare-and-set fail, and one that comes second waits for the
//   redeem to commit and then revokes its pair too. Redeems of one connection still share the lock.
// Times cross this boundary as seconds since the epoch, the unit the HTTP layer decides in.

import type { StoredAccess, StoredCode, StoredRefresh } from "../oauth/oauth.js";
import type { IssuedTokens, OAuthStore, PendingAuthorization, StoredClient } from "./store.js";

/** The slice of a node-postgres Pool (or PoolClient) this store uses. */
export interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

/** A node-postgres Pool: queries, and a dedicated client for a transaction. */
export interface PgPoolLike extends PgQueryable {
  connect(): Promise<PgQueryable & { release(error?: Error | boolean): void }>;
}

/** Seconds since the epoch, as stored: to_timestamp on the way in, extract(epoch) on the way out. */
const epoch = (column: string) => `extract(epoch from ${column})::float8 AS ${column}`;
const seconds = (value: unknown): number => Number(value);
const secondsOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

export class PgOAuthStore implements OAuthStore {
  constructor(private readonly pool: PgPoolLike) {}

  /** Runs `fn` in one transaction on one connection: COMMIT when it returns, ROLLBACK when it throws. */
  private async transaction<T>(fn: (client: PgQueryable) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken: Error | undefined;
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        broken = rollbackError instanceof Error ? rollbackError : new Error("rollback failed");
      }
      throw error;
    } finally {
      // A connection whose ROLLBACK failed is destroyed rather than returned to the pool.
      client.release(broken);
    }
  }

  async getClient(clientId: string): Promise<StoredClient | null> {
    const { rows } = await this.pool.query(
      `SELECT client_id, client_name, redirect_uris, ${epoch("created_at")} FROM oauth_clients WHERE client_id = $1`,
      [clientId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      client_id: String(row.client_id),
      client_name: typeof row.client_name === "string" ? row.client_name : "unnamed client",
      redirect_uris: (row.redirect_uris as string[]).map(String),
      created_at: seconds(row.created_at),
    };
  }

  async saveClient(client: StoredClient): Promise<void> {
    await this.pool.query(
      "INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES ($1, $2, $3, to_timestamp($4))",
      [client.client_id, client.client_name, [...client.redirect_uris], client.created_at],
    );
  }

  async saveCode(codeHash: string, code: StoredCode): Promise<void> {
    await this.pool.query(
      `INSERT INTO oauth_codes (code_hash, client_id, agent_connection_id, redirect_uri, code_challenge, resource, scope, expires_at, used_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, to_timestamp($8), CASE WHEN $9::float8 IS NULL THEN NULL ELSE to_timestamp($9::float8) END)`,
      [codeHash, code.client_id, code.agent_connection_id, code.redirect_uri, code.code_challenge, code.resource, code.scope, code.expires_at, code.used_at],
    );
  }

  async findCode(codeHash: string): Promise<StoredCode | null> {
    const { rows } = await this.pool.query(
      `SELECT client_id, agent_connection_id, redirect_uri, code_challenge, resource, scope, ${epoch("expires_at")}, ${epoch("used_at")}
       FROM oauth_codes WHERE code_hash = $1`,
      [codeHash],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      client_id: String(row.client_id),
      agent_connection_id: String(row.agent_connection_id),
      redirect_uri: String(row.redirect_uri),
      code_challenge: String(row.code_challenge),
      resource: String(row.resource),
      scope: String(row.scope),
      expires_at: seconds(row.expires_at),
      used_at: secondsOrNull(row.used_at),
    };
  }

  async savePending(requestHash: string, pending: PendingAuthorization): Promise<void> {
    // Answered or abandoned requests are deleted by the take; this sweeps the abandoned ones.
    await this.pool.query("DELETE FROM oauth_pending_authorizations WHERE expires_at < to_timestamp($1) - interval '1 hour'", [pending.expires_at]);
    await this.pool.query(
      `INSERT INTO oauth_pending_authorizations
         (request_hash, owner_id, client_id, client_name, redirect_uri, code_challenge, scope, resource, state, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, to_timestamp($10))`,
      [
        requestHash,
        pending.owner_id,
        pending.client_id,
        pending.client_name,
        pending.redirect_uri,
        pending.code_challenge,
        pending.scope,
        pending.resource,
        pending.state,
        pending.expires_at,
      ],
    );
  }

  async takePending(requestHash: string): Promise<PendingAuthorization | null> {
    const { rows } = await this.pool.query(
      `DELETE FROM oauth_pending_authorizations WHERE request_hash = $1
       RETURNING owner_id, client_id, client_name, redirect_uri, code_challenge, scope, resource, state, ${epoch("expires_at")}`,
      [requestHash],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      owner_id: String(row.owner_id),
      client_id: String(row.client_id),
      client_name: String(row.client_name),
      redirect_uri: String(row.redirect_uri),
      code_challenge: String(row.code_challenge),
      scope: String(row.scope),
      resource: String(row.resource),
      state: row.state === null ? null : String(row.state),
      expires_at: seconds(row.expires_at),
    };
  }

  async findRefresh(tokenHash: string): Promise<StoredRefresh | null> {
    const { rows } = await this.pool.query(
      `SELECT client_id, agent_connection_id, resource, scope, ${epoch("expires_at")}, ${epoch("rotated_at")}, ${epoch("revoked_at")}
       FROM refresh_tokens WHERE token_hash = $1`,
      [tokenHash],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      client_id: String(row.client_id),
      agent_connection_id: String(row.agent_connection_id),
      resource: String(row.resource),
      scope: String(row.scope),
      expires_at: seconds(row.expires_at),
      rotated_at: secondsOrNull(row.rotated_at),
      revoked_at: secondsOrNull(row.revoked_at),
    };
  }

  async findAccess(tokenHash: string): Promise<StoredAccess | null> {
    const { rows } = await this.pool.query(
      `SELECT agent_connection_id, resource, scope, ${epoch("expires_at")}, ${epoch("revoked_at")} FROM access_tokens WHERE token_hash = $1`,
      [tokenHash],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      agent_connection_id: String(row.agent_connection_id),
      resource: String(row.resource),
      scope: String(row.scope),
      expires_at: seconds(row.expires_at),
      revoked_at: secondsOrNull(row.revoked_at),
    };
  }

  async redeem(consumedHash: string, { accessHash, refreshHash, client_id, grant }: IssuedTokens, now: number): Promise<boolean> {
    return this.transaction(async (client) => {
      const connection = await client.query("SELECT revoked_at IS NOT NULL AS revoked FROM agent_connections WHERE id = $1 FOR SHARE", [
        grant.agent_connection_id,
      ]);
      if (connection.rows[0]?.revoked !== false) return false;
      // TOKEN_CONSUME_SQL's compare-and-set, also requiring the row to be unexpired at `now`.
      const consumed =
        grant.consume === "code"
          ? await client.query(
              "UPDATE oauth_codes SET used_at = to_timestamp($2) WHERE code_hash = $1 AND used_at IS NULL AND expires_at > to_timestamp($2)",
              [consumedHash, now],
            )
          : await client.query(
              `UPDATE refresh_tokens SET rotated_at = to_timestamp($2)
               WHERE token_hash = $1 AND rotated_at IS NULL AND revoked_at IS NULL AND expires_at > to_timestamp($2)`,
              [consumedHash, now],
            );
      if (consumed.rowCount !== 1) return false;
      await client.query(
        "INSERT INTO access_tokens (token_hash, agent_connection_id, resource, scope, expires_at) VALUES ($1, $2, $3, $4, to_timestamp($5))",
        [accessHash, grant.agent_connection_id, grant.resource, grant.scope, grant.access_expires_at],
      );
      await client.query(
        `INSERT INTO refresh_tokens (token_hash, client_id, agent_connection_id, resource, scope, expires_at)
         VALUES ($1, $2, $3, $4, $5, to_timestamp($6))`,
        [refreshHash, client_id, grant.agent_connection_id, grant.resource, grant.scope, grant.refresh_expires_at],
      );
      return true;
    });
  }

  async revokeAgentConnection(agentConnectionId: string, now: number): Promise<void> {
    await this.transaction(async (client) => {
      // Waits for any redeem of this connection in flight, so the UPDATEs below see its pair.
      await client.query("SELECT id FROM agent_connections WHERE id = $1 FOR UPDATE", [agentConnectionId]);
      await client.query("UPDATE access_tokens SET revoked_at = to_timestamp($2) WHERE agent_connection_id = $1 AND revoked_at IS NULL", [agentConnectionId, now]);
      await client.query("UPDATE refresh_tokens SET revoked_at = to_timestamp($2) WHERE agent_connection_id = $1 AND revoked_at IS NULL", [agentConnectionId, now]);
      await client.query("UPDATE oauth_codes SET used_at = to_timestamp($2) WHERE agent_connection_id = $1 AND used_at IS NULL", [agentConnectionId, now]);
    });
  }
}

/** The secret-path fallback's store (#521) on Postgres: secret hash to agent connection. */
export class PgSecretPaths {
  constructor(private readonly pool: PgQueryable) {}

  async add(secretHash: string, agentConnectionId: string): Promise<void> {
    await this.pool.query("INSERT INTO oauth_secret_paths (secret_hash, agent_connection_id) VALUES ($1, $2)", [secretHash, agentConnectionId]);
  }

  async revoke(secretHash: string): Promise<void> {
    await this.pool.query("DELETE FROM oauth_secret_paths WHERE secret_hash = $1", [secretHash]);
  }

  async connectionFor(secretHash: string): Promise<string | null> {
    const { rows } = await this.pool.query("SELECT agent_connection_id FROM oauth_secret_paths WHERE secret_hash = $1", [secretHash]);
    return rows[0] ? String(rows[0].agent_connection_id) : null;
  }
}
