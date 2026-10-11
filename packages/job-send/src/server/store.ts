// What the HTTP layer needs from storage for OAuth. Every token is stored and found by its hash
// only (hashToken). redeem is the compare-and-set TOKEN_CONSUME_SQL describes, plus the insert of
// the new tokens, in one transaction: it issues for exactly one caller.

import type { RegisteredClient, StoredAccess, StoredCode, StoredRefresh, TokenGrant } from "../oauth/oauth.js";

export type StoredClient = RegisteredClient & { client_name: string; created_at: number };

/**
 * An authorize request waiting for the owner's answer on the consent screen, found by the hash
 * of its one-time request id. It holds the request exactly as checkAuthorizeRequest accepted it.
 */
export type PendingAuthorization = {
  owner_id: string;
  client_id: string;
  client_name: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  resource: string;
  state: string | null;
  expires_at: number;
};

/** What one successful token request saves: the hashes of the new tokens and the grant they carry. */
export type IssuedTokens = { accessHash: string; refreshHash: string; client_id: string; grant: TokenGrant };

export interface OAuthStore {
  getClient(clientId: string): Promise<StoredClient | null>;
  saveClient(client: StoredClient): Promise<void>;
  saveCode(codeHash: string, code: StoredCode): Promise<void>;
  findCode(codeHash: string): Promise<StoredCode | null>;
  savePending(requestHash: string, pending: PendingAuthorization): Promise<void>;
  /** Deletes and returns it, once: a concurrent or later take of the same id gets null. */
  takePending(requestHash: string): Promise<PendingAuthorization | null>;
  findRefresh(tokenHash: string): Promise<StoredRefresh | null>;
  findAccess(tokenHash: string): Promise<StoredAccess | null>;
  /**
   * In one transaction: run TOKEN_CONSUME_SQL[grant.consume] on `consumedHash`; only if it changed
   * one row, save the new tokens. False (and nothing saved) when another request consumed it first.
   */
  redeem(consumedHash: string, issued: IssuedTokens, now: number): Promise<boolean>;
  /** Revokes every access and refresh token of an agent connection, and voids its unused codes. */
  revokeAgentConnection(agentConnectionId: string, now: number): Promise<void>;
}

/** An in-memory store for tests and a local demo. Not for production: nothing survives a restart. */
export class InMemoryOAuthStore implements OAuthStore {
  readonly clients = new Map<string, StoredClient>();
  readonly codes = new Map<string, StoredCode>();
  readonly refresh = new Map<string, StoredRefresh>();
  readonly access = new Map<string, StoredAccess>();
  readonly pending = new Map<string, PendingAuthorization>();

  async getClient(clientId: string) {
    const client = this.clients.get(clientId);
    return client ? { ...client, redirect_uris: [...client.redirect_uris] } : null;
  }

  async saveClient(client: StoredClient) {
    this.clients.set(client.client_id, { ...client, redirect_uris: [...client.redirect_uris] });
  }

  async saveCode(codeHash: string, code: StoredCode) {
    this.codes.set(codeHash, { ...code });
  }

  async findCode(codeHash: string) {
    const code = this.codes.get(codeHash);
    return code ? { ...code } : null;
  }

  async savePending(requestHash: string, pending: PendingAuthorization) {
    this.pending.set(requestHash, { ...pending });
  }

  async takePending(requestHash: string) {
    const pending = this.pending.get(requestHash);
    if (!pending) return null;
    this.pending.delete(requestHash);
    return pending;
  }

  async findRefresh(tokenHash: string) {
    const token = this.refresh.get(tokenHash);
    return token ? { ...token } : null;
  }

  async findAccess(tokenHash: string) {
    const token = this.access.get(tokenHash);
    return token ? { ...token } : null;
  }

  // No await between the check and the writes, so this is atomic on one event loop.
  async redeem(consumedHash: string, { accessHash, refreshHash, client_id, grant }: IssuedTokens, now: number) {
    if (grant.consume === "code") {
      const code = this.codes.get(consumedHash);
      if (!code || code.used_at !== null) return false;
      code.used_at = now;
    } else {
      const token = this.refresh.get(consumedHash);
      if (!token || token.rotated_at !== null || token.revoked_at !== null) return false;
      token.rotated_at = now;
    }
    this.access.set(accessHash, {
      agent_connection_id: grant.agent_connection_id,
      resource: grant.resource,
      scope: grant.scope,
      expires_at: grant.access_expires_at,
      revoked_at: null,
    });
    this.refresh.set(refreshHash, {
      client_id,
      agent_connection_id: grant.agent_connection_id,
      resource: grant.resource,
      scope: grant.scope,
      expires_at: grant.refresh_expires_at,
      rotated_at: null,
      revoked_at: null,
    });
    return true;
  }

  async revokeAgentConnection(agentConnectionId: string, now: number) {
    for (const token of [...this.access.values(), ...this.refresh.values()]) {
      if (token.agent_connection_id === agentConnectionId && token.revoked_at === null) token.revoked_at = now;
    }
    for (const code of this.codes.values()) {
      if (code.agent_connection_id === agentConnectionId && code.used_at === null) code.used_at = now;
    }
  }
}
