import type { Pool } from "pg";

import { GOOGLE_TOKEN_ENDPOINT, type FetchLike, type GoogleClientConfig } from "../owner/google.js";
import type { TokenCustody } from "./custody/custody.js";
import { one } from "./db/tx.js";
import type { ConnectionRef, RevokeResult } from "./dispatch.js";
import { createGmailProvider } from "./providers/gmail.js";

// Gmail access for the executor (spec: "Gmail connection", "Token custody"). The refresh token is
// stored sealed (custody: AES-256-GCM, the connection id as associated data) and is opened only
// here, inside the executor. Access tokens live in this process's memory and nowhere else: not in a
// receipt, an outcome, an error or a log line.

export const GOOGLE_REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
/** An access token is reused until this many seconds before it expires. */
export const ACCESS_TOKEN_MARGIN_SECONDS = 60;
/**
 * The budget for one call to Google (token or revoke), the answer's body included. It sits well
 * inside the provider call's 20 s, so a hung Google token endpoint is NOT SENT (no request was
 * made), never UNKNOWN.
 */
export const TOKEN_FETCH_TIMEOUT_MS = 8_000;

/** Why an access token could not be had. The code only; Google's answer body is never kept. */
export class GmailTokenError extends Error {
  constructor(readonly reason: "no_refresh_token" | "grant_revoked" | "token_endpoint" | "malformed_answer") {
    super(`gmail token: ${reason}`);
    this.name = "GmailTokenError";
  }
}

export type GmailTokensOptions = {
  pool: Pool;
  custody: TokenCustody;
  google: GoogleClientConfig;
  fetchImpl: FetchLike;
  /** Seconds since the epoch. */
  now?: () => number;
  /** The token endpoint's budget; default TOKEN_FETCH_TIMEOUT_MS. */
  tokenFetchTimeoutMs?: number;
};

const form = (fields: Record<string, string>, signal: AbortSignal) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
  body: new URLSearchParams(fields).toString(),
  signal,
});

/**
 * One call to Google, its answer's body included, within `ms`. At the deadline the request is
 * aborted and the call fails `token_endpoint`, even for a fetch that ignores the signal.
 */
async function withinBudget<T>(ms: number, call: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new GmailTokenError("token_endpoint"));
      controller.abort();
    }, ms);
  });
  try {
    return await Promise.race([call(controller.signal), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

const jsonOf = (res: { json(): Promise<unknown> }) => res.json().catch(() => null) as Promise<Record<string, unknown> | null>;

export function createGmailTokens(options: GmailTokensOptions) {
  const { pool, custody, google, fetchImpl } = options;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const tokenFetchTimeoutMs = options.tokenFetchTimeoutMs ?? TOKEN_FETCH_TIMEOUT_MS;
  const cache = new Map<string, { token: string; expiresAt: number }>();

  async function refreshTokenOf(connectionId: string): Promise<string> {
    const row = await one<{ refresh_token_enc: string | null }>(pool, "SELECT refresh_token_enc FROM connections WHERE id = $1", [connectionId]);
    if (!row?.refresh_token_enc) throw new GmailTokenError("no_refresh_token");
    return custody.open(connectionId, row.refresh_token_enc);
  }

  /**
   * A current access token for the connection, from the sealed refresh token. A refresh token
   * Google no longer honours (revoked, or a Testing-mode token past its 7 days) marks the
   * connection needs_reconnect, which also stops new reservations on it.
   */
  async function accessToken(connectionId: string): Promise<string> {
    const cached = cache.get(connectionId);
    if (cached && now() < cached.expiresAt - ACCESS_TOKEN_MARGIN_SECONDS) return cached.token;
    cache.delete(connectionId);
    const refreshToken = await refreshTokenOf(connectionId);
    const fields = { grant_type: "refresh_token", refresh_token: refreshToken, client_id: google.clientId, client_secret: google.clientSecret };
    const { res, data } = await withinBudget(tokenFetchTimeoutMs, async (signal) => {
      const res = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, form(fields, signal));
      return { res, data: await jsonOf(res) };
    });
    if (!res.ok) {
      if (res.status === 400 && data?.error === "invalid_grant") {
        await pool.query("UPDATE connections SET status = 'needs_reconnect' WHERE id = $1 AND status = 'active'", [connectionId]);
        throw new GmailTokenError("grant_revoked");
      }
      throw new GmailTokenError("token_endpoint");
    }
    if (typeof data?.access_token !== "string" || data.access_token === "" || typeof data.expires_in !== "number") {
      throw new GmailTokenError("malformed_answer");
    }
    cache.set(connectionId, { token: data.access_token, expiresAt: now() + data.expires_in });
    return data.access_token;
  }

  /**
   * The provider revoke STOP runs after it has engaged (executor engageStop's `revoke`): revoke the
   * refresh token at Google, then delete the sealed token. A token Google already considers invalid
   * counts as revoked. With no stored token there is nothing to revoke.
   */
  async function revoke(connection: ConnectionRef): Promise<RevokeResult> {
    cache.delete(connection.id);
    let refreshToken: string;
    try {
      refreshToken = await refreshTokenOf(connection.id);
    } catch (error) {
      if (error instanceof GmailTokenError) return { ok: true, status: "no_token" };
      throw error;
    }
    // A revoke Google doesn't answer in time throws; engageStop records it as not revoked, and the
    // sealed token stays so the owner can retry.
    const { res, data } = await withinBudget(tokenFetchTimeoutMs, async (signal) => {
      const res = await fetchImpl(GOOGLE_REVOKE_ENDPOINT, form({ token: refreshToken }, signal));
      return { res, data: res.ok ? null : await jsonOf(res) };
    });
    const gone = res.ok || (res.status === 400 && data?.error === "invalid_token");
    if (gone) await pool.query("UPDATE connections SET refresh_token_enc = NULL WHERE id = $1", [connection.id]);
    return { ok: gone, status: res.status };
  }

  return {
    accessToken,
    revoke,
    /** The executor's mailProviderFor: a Gmail provider that asks this module for its token. */
    mailProviderFor: (connection: ConnectionRef) => createGmailProvider({ accessToken: () => accessToken(connection.id) }),
  };
}

export type GmailTokens = ReturnType<typeof createGmailTokens>;
