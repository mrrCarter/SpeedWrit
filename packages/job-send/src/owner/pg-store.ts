// The OwnerStore on Postgres (migration 0003: owner_sign_ins, owner_sessions; owners from 0001), so
// sessions and a sign-in in flight survive a restart. Every state and session id is stored and found
// by its hash only. A pending sign-in is taken with DELETE ... RETURNING, so a state is spent once even
// when two callbacks race. Times cross this boundary as seconds since the epoch, as in PgOAuthStore.

import { newId } from "../executor/db/tx.js";
import type { PgPoolLike } from "../server/pg-store.js";
import type { GoogleIdentity } from "./google.js";
import { PENDING_SIGN_INS_MAX, SESSION_TTL_SECONDS, SIGN_IN_TTL_SECONDS, type Owner, type OwnerStore, type PendingSignIn } from "./signin.js";

const seconds = (value: unknown): number => Number(value);

export class PgOwnerStore implements OwnerStore {
  private readonly pendingMax: number;

  /** `pendingMax` caps the pending sign-ins kept, oldest dropped first (default PENDING_SIGN_INS_MAX). */
  constructor(
    private readonly pool: PgPoolLike,
    options: { pendingMax?: number } = {},
  ) {
    this.pendingMax = options.pendingMax ?? PENDING_SIGN_INS_MAX;
  }

  // Any page can send a browser to /auth/sign-in, writing one row each time. Saving one drops the rows
  // already expired at that moment, then the oldest beyond pendingMax.
  async savePendingSignIn(stateHash: string, pending: PendingSignIn): Promise<void> {
    const now = pending.expiresAt - SIGN_IN_TTL_SECONDS;
    await this.pool.query("DELETE FROM owner_sign_ins WHERE expires_at <= to_timestamp($1)", [now]);
    await this.pool.query(
      `INSERT INTO owner_sign_ins (state_hash, binding_hash, code_verifier, nonce, return_to, expires_at)
       VALUES ($1, $2, $3, $4, $5, to_timestamp($6))`,
      [stateHash, pending.bindingHash, pending.codeVerifier, pending.nonce, pending.returnTo, pending.expiresAt],
    );
    await this.pool.query(
      `DELETE FROM owner_sign_ins WHERE state_hash IN
         (SELECT state_hash FROM owner_sign_ins ORDER BY expires_at DESC, state_hash OFFSET $1)`,
      [this.pendingMax],
    );
  }

  async takePendingSignIn(stateHash: string): Promise<PendingSignIn | null> {
    const { rows } = await this.pool.query(
      `DELETE FROM owner_sign_ins WHERE state_hash = $1
       RETURNING binding_hash, code_verifier, nonce, return_to, extract(epoch from expires_at)::float8 AS expires_at`,
      [stateHash],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      bindingHash: String(row.binding_hash),
      codeVerifier: String(row.code_verifier),
      nonce: String(row.nonce),
      returnTo: String(row.return_to),
      expiresAt: seconds(row.expires_at),
    };
  }

  /** The owner for this Google subject, created on first sign-in; the email is refreshed every time. */
  async upsertOwner(identity: GoogleIdentity): Promise<Owner> {
    const { rows } = await this.pool.query(
      `INSERT INTO owners (id, google_sub, email) VALUES ($1, $2, $3)
       ON CONFLICT (google_sub) DO UPDATE SET email = EXCLUDED.email
       RETURNING id, email`,
      [newId("own"), identity.sub, identity.email],
    );
    const row = rows[0];
    if (!row) throw new Error("upsertOwner: no owner row returned");
    return { id: String(row.id), email: String(row.email) };
  }

  async saveSession(sessionHash: string, session: { ownerId: string; expiresAt: number }): Promise<void> {
    const now = session.expiresAt - SESSION_TTL_SECONDS;
    await this.pool.query("DELETE FROM owner_sessions WHERE expires_at <= to_timestamp($1)", [now]);
    await this.pool.query("INSERT INTO owner_sessions (session_hash, owner_id, expires_at) VALUES ($1, $2, to_timestamp($3))", [
      sessionHash,
      session.ownerId,
      session.expiresAt,
    ]);
  }

  async findSession(sessionHash: string): Promise<{ owner: Owner; expiresAt: number } | null> {
    const { rows } = await this.pool.query(
      `SELECT o.id, o.email, extract(epoch from s.expires_at)::float8 AS expires_at
       FROM owner_sessions s JOIN owners o ON o.id = s.owner_id
       WHERE s.session_hash = $1`,
      [sessionHash],
    );
    const row = rows[0];
    if (!row) return null;
    return { owner: { id: String(row.id), email: String(row.email) }, expiresAt: seconds(row.expires_at) };
  }

  async deleteSession(sessionHash: string): Promise<void> {
    await this.pool.query("DELETE FROM owner_sessions WHERE session_hash = $1", [sessionHash]);
  }
}
