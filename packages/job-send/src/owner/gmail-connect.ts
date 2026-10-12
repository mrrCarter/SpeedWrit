// Connect Gmail (spec: "Gmail connection"): the owner's second Google flow on the same OAuth client.
// It asks for "openid email" plus gmail.send, offline and with consent, so a refresh token always
// comes back. Same shape as owner sign-in (signin.ts): PKCE S256, a state and a nonce, a one-time
// pending connect bound to the browser by a __Host- cookie, and here also to the signed-in owner,
// so nobody can attach their Gmail to someone else's SpeedWrit.
//
// - The address comes from the verified ID token, never from a Gmail profile call (send-only).
// - The granted scopes must include gmail.send: Google's consent screen lets a person untick it.
// - The refresh token is sealed (custody, the connection id as associated data) before it is
//   stored; nothing else about it is kept. CONNECTION_CREATED records the connection and its scopes.
// - Reconnecting the same address refreshes that connection's token and lifts needs_reconnect, but
//   never lifts a STOP: only the owner's own STOP control does that.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";

import type { TokenCustody } from "../executor/custody/custody.js";
import { newId, one, withTx } from "../executor/db/tx.js";
import type { Executor } from "../executor/dispatch.js";
import { GOOGLE_REVOKE_ENDPOINT } from "../executor/gmail-tokens.js";
import { assertOrigin, generateOpaqueToken, hashToken } from "../oauth/oauth.js";
import {
  exchangeGoogleCode,
  googleAccessTokenScopes,
  GoogleAuthError,
  googleAuthorizationUrl,
  pkceChallenge,
  verifyGoogleIdToken,
  type FetchLike,
  type GoogleClientConfig,
  type GoogleIdentity,
  type GoogleJwks,
  type GoogleTokens,
} from "./google.js";
import { hostCookie, readCookie, safeReturnTo, type Owner } from "./signin.js";

export const GMAIL_CONNECT_PATH = "/auth/gmail/connect";
export const GMAIL_CALLBACK_PATH = "/auth/gmail/callback";
export const GMAIL_CONNECT_COOKIE = "__Host-writ_gmail";
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const GMAIL_CONNECT_SCOPES: readonly string[] = Object.freeze(["openid", "email", GMAIL_SEND_SCOPE]);
export const GMAIL_CONNECT_TTL_SECONDS = 600;
/** The most connects one owner may have in progress; starting another drops the oldest. */
export const GMAIL_CONNECTS_PER_OWNER = 5;

export type GmailConnectOptions = {
  /** The public https origin; the Google redirect URI is this plus GMAIL_CALLBACK_PATH. */
  host: string;
  google: GoogleClientConfig;
  pool: Pool;
  executor: Executor;
  custody: TokenCustody;
  /** The owner session (createOwnerAuth): who is signed in, and where to send someone who is not. */
  owners: { owner(req: IncomingMessage): Promise<Owner | null>; signInUrl(returnTo: string): string };
  fetchImpl: FetchLike;
  jwks: GoogleJwks;
  /** Seconds since the epoch. */
  now?: () => number;
  /** Told about a failure the owner only sees as a plain error page. */
  onError?: (error: unknown) => void;
};

function plain(res: ServerResponse, status: number, text: string, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...headers });
  res.end(text);
}

export function createGmailConnect(options: GmailConnectOptions) {
  const host = assertOrigin(options.host);
  const redirectUri = `${host}${GMAIL_CALLBACK_PATH}`;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const { pool, google } = options;

  async function start(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    const owner = await options.owners.owner(req);
    if (!owner) {
      res.writeHead(302, { location: options.owners.signInUrl(`${GMAIL_CONNECT_PATH}${url.search}`), "cache-control": "no-store" });
      res.end();
      return;
    }
    const state = generateOpaqueToken();
    const codeVerifier = generateOpaqueToken();
    const nonce = generateOpaqueToken();
    const binding = generateOpaqueToken();
    // Any page can send a signed-in owner here: expired rows go on each start, and an owner keeps at
    // most GMAIL_CONNECTS_PER_OWNER pending connects (the oldest go), so they cannot pile up.
    await pool.query("DELETE FROM gmail_connect_pending WHERE expires_at < clock_timestamp()");
    await pool.query(
      `DELETE FROM gmail_connect_pending WHERE state_hash IN (
         SELECT state_hash FROM gmail_connect_pending WHERE owner_id = $1 ORDER BY expires_at DESC, state_hash OFFSET $2)`,
      [owner.id, GMAIL_CONNECTS_PER_OWNER - 1],
    );
    // The expiry comes from the database clock, the same clock the callback checks it against.
    await pool.query(
      `INSERT INTO gmail_connect_pending (state_hash, owner_id, binding_hash, code_verifier, nonce, return_to, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp() + make_interval(secs => $7))`,
      [
        hashToken(state),
        owner.id,
        hashToken(binding),
        codeVerifier,
        nonce,
        safeReturnTo(url.searchParams.get("return_to")),
        GMAIL_CONNECT_TTL_SECONDS,
      ],
    );
    const location = googleAuthorizationUrl({
      clientId: google.clientId,
      redirectUri,
      scopes: GMAIL_CONNECT_SCOPES,
      state,
      codeChallenge: pkceChallenge(codeVerifier),
      nonce,
      extra: { access_type: "offline", prompt: "consent" },
    });
    res.writeHead(302, { location, "cache-control": "no-store", "set-cookie": hostCookie(GMAIL_CONNECT_COOKIE, binding, GMAIL_CONNECT_TTL_SECONDS) });
    res.end();
  }

  /** A grant without gmail.send is useless to us: give it back rather than leave it at Google. */
  async function giveBack(tokens: GoogleTokens): Promise<void> {
    const token = tokens.refreshToken ?? tokens.accessToken;
    if (!token) return;
    await options
      .fetchImpl(GOOGLE_REVOKE_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }).toString(),
      })
      .catch(() => undefined);
  }

  /** Seals the refresh token and stores the connection, with CONNECTION_CREATED, in one transaction. */
  async function store(owner: string, identity: GoogleIdentity, refreshToken: string, scopes: string[]): Promise<string> {
    return withTx(pool, owner, async (tx) => {
      const existing = await one<{ id: string }>(
        tx.client,
        `SELECT id FROM connections WHERE owner_id = $1 AND provider = 'gmail' AND account_email = $2 AND status <> 'revoked'
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [owner, identity.email],
      );
      const id = existing?.id ?? newId("con");
      const sealed = options.custody.seal(id, refreshToken);
      if (existing) {
        await tx.client.query(
          `UPDATE connections SET refresh_token_enc = $2, granted_scopes = $3,
                  status = CASE WHEN status = 'needs_reconnect' THEN 'active' ELSE status END
           WHERE id = $1`,
          [id, sealed, scopes],
        );
      } else {
        await tx.client.query(
          "INSERT INTO connections (id, owner_id, provider, account_email, refresh_token_enc, granted_scopes) VALUES ($1, $2, 'gmail', $3, $4, $5)",
          [id, owner, identity.email, sealed, scopes],
        );
      }
      await options.executor.writeReceipt(tx, "CONNECTION_CREATED", {
        detail: { connection: id, provider: "gmail", scopes, reconnected: existing !== undefined },
      });
      return id;
    });
  }

  async function callback(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    // The callback URL carries the code: keep it out of Referer headers. Every answer clears the binding cookie.
    const clearBinding = hostCookie(GMAIL_CONNECT_COOKIE, "", 0);
    const fail = (text: string) => plain(res, 400, text, { "referrer-policy": "no-referrer", "set-cookie": clearBinding });
    const state = url.searchParams.get("state");
    if (!state) return fail("This Gmail link is not valid. Start again from SpeedWrit.");
    const pending = await one<{ owner_id: string; binding_hash: string; code_verifier: string; nonce: string; return_to: string; expired: boolean }>(
      pool,
      `DELETE FROM gmail_connect_pending WHERE state_hash = $1
       RETURNING owner_id, binding_hash, code_verifier, nonce, return_to, (expires_at <= clock_timestamp()) AS expired`,
      [hashToken(state)],
    );
    if (!pending || pending.expired) return fail("This Gmail link expired or was already used. Start again from SpeedWrit.");
    const binding = readCookie(req.headers.cookie, GMAIL_CONNECT_COOKIE);
    if (!binding || hashToken(binding) !== pending.binding_hash) return fail("Finish connecting Gmail in the browser where you started. Start again.");
    const owner = await options.owners.owner(req);
    if (!owner || owner.id !== pending.owner_id) return fail("Sign in as the account that started connecting Gmail, then start again.");
    if (url.searchParams.has("error")) return fail("Connecting Gmail was cancelled.");
    const code = url.searchParams.get("code");
    if (!code) return fail("This Gmail link is not valid. Start again from SpeedWrit.");

    let tokens: GoogleTokens;
    let identity: GoogleIdentity;
    try {
      tokens = await exchangeGoogleCode({ code, codeVerifier: pending.code_verifier, redirectUri, config: google, fetchImpl: options.fetchImpl });
      identity = await verifyGoogleIdToken(tokens.idToken, { clientId: google.clientId, now: now(), nonce: pending.nonce, jwks: options.jwks });
    } catch (error) {
      options.onError?.(error);
      return fail("Google did not confirm this connection. Start again.");
    }
    let scopes = tokens.scope.split(" ").filter((scope) => scope !== "");
    if (!scopes.includes(GMAIL_SEND_SCOPE)) {
      try {
        scopes = await googleAccessTokenScopes({ accessToken: tokens.accessToken, clientId: google.clientId, subject: identity.sub, fetchImpl: options.fetchImpl, now: now() });
      } catch (error) {
        const reason = error instanceof GoogleAuthError ? error.reason : "tokeninfo_unavailable";
        options.onError?.(new GoogleAuthError(reason, { exchange_scope_present: tokens.scopePresent, exchange_send_granted: false, tokeninfo_send_granted: null }));
        await giveBack(tokens);
        return fail("Google did not confirm Gmail sending permission. Connect again.");
      }
    }
    if (!scopes.includes(GMAIL_SEND_SCOPE)) {
      options.onError?.(new GoogleAuthError("gmail_send_not_granted", { exchange_scope_present: tokens.scopePresent, exchange_send_granted: false, tokeninfo_send_granted: false }));
      await giveBack(tokens);
      return fail("SpeedWrit was not allowed to send email. Connect again and allow sending email on your behalf.");
    }
    if (!tokens.refreshToken) return fail("Google did not grant lasting access. Connect again.");

    await store(owner.id, identity, tokens.refreshToken, scopes);
    res.writeHead(302, { location: pending.return_to, "cache-control": "no-store", "referrer-policy": "no-referrer", "set-cookie": clearBinding });
    res.end();
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === GMAIL_CONNECT_PATH) {
      await start(req, url, res);
      return true;
    }
    if (req.method === "GET" && url.pathname === GMAIL_CALLBACK_PATH) {
      await callback(req, url, res);
      return true;
    }
    return false;
  }

  return { handle, redirectUri };
}

export type GmailConnect = ReturnType<typeof createGmailConnect>;
