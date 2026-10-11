// Owner sign-in with Google ("openid email" only), and the owner session every owner route reads.
// It satisfies PR B's OwnerSessions (owner(req), signInUrl(returnTo)), and requireOwner is the same
// check for Connect Gmail.
//
// - Sign-in: the code flow with PKCE S256, a state and a nonce. The pending sign-in is one-time,
//   lives SIGN_IN_TTL_SECONDS, and is bound to the browser that started it by a __Host- cookie, so
//   nobody can finish a sign-in into their own account in someone else's browser (login CSRF).
// - Owners are keyed by Google's `sub`, never by email; the email is only shown.
// - Session: an opaque random id; the store keeps only its hash. The cookie is __Host-, HttpOnly,
//   Secure, SameSite=Lax (the authorize redirect from ChatGPT is a top-level GET, so it carries it).
// - Sign-out is a POST whose Origin must be this host.
// - return_to is a relative path or "/", so sign-in can never send anyone to another site.

import type { IncomingMessage, ServerResponse } from "node:http";

import { assertOrigin, generateOpaqueToken, hashToken } from "../oauth/oauth.js";
import {
  exchangeGoogleCode,
  googleAuthorizationUrl,
  pkceChallenge,
  SIGN_IN_SCOPES,
  verifyGoogleIdToken,
  type FetchLike,
  type GoogleClientConfig,
  type GoogleIdentity,
  type GoogleJwks,
} from "./google.js";

export const SIGN_IN_PATH = "/auth/sign-in";
export const SIGN_IN_CALLBACK_PATH = "/auth/google/callback";
export const SIGN_OUT_PATH = "/auth/sign-out";
export const SESSION_COOKIE = "__Host-writ_session";
export const SIGN_IN_COOKIE = "__Host-writ_signin";
export const SESSION_TTL_SECONDS = 12 * 3600;
export const SIGN_IN_TTL_SECONDS = 600;
/** Long enough for ChatGPT's authorize query (an encoded redirect_uri and resource, a challenge, a state of unknown length). */
export const RETURN_TO_MAX = 8192;
/** The most pending sign-ins the in-memory store keeps; the oldest go first. */
export const PENDING_SIGN_INS_MAX = 10_000;

export type Owner = { id: string; email: string };

/** A sign-in between the redirect to Google and the callback. Stored under hashToken(state). */
export type PendingSignIn = { bindingHash: string; codeVerifier: string; nonce: string; returnTo: string; expiresAt: number };

export interface OwnerStore {
  savePendingSignIn(stateHash: string, pending: PendingSignIn): Promise<void>;
  /** One time: returns the record and removes it in the same step, so a state is spent once. */
  takePendingSignIn(stateHash: string): Promise<PendingSignIn | null>;
  /** The owner for this Google subject, created on first sign-in; the email is refreshed each time. */
  upsertOwner(identity: GoogleIdentity, now: number): Promise<Owner>;
  saveSession(sessionHash: string, session: { ownerId: string; expiresAt: number }): Promise<void>;
  findSession(sessionHash: string): Promise<{ owner: Owner; expiresAt: number } | null>;
  deleteSession(sessionHash: string): Promise<void>;
}

/** An in-memory store for tests and a local demo. Not for production: nothing survives a restart. */
export class InMemoryOwnerStore implements OwnerStore {
  readonly pending = new Map<string, PendingSignIn>();
  readonly owners = new Map<string, Owner & { sub: string }>();
  readonly sessions = new Map<string, { ownerId: string; expiresAt: number }>();
  private nextOwner = 1;

  // Any page can send a browser to /auth/sign-in, and each visit writes one pending sign-in. Saving one drops the ones
  // already expired at that moment, and the oldest beyond PENDING_SIGN_INS_MAX. A Postgres store deletes expired
  // rows the same way (and the take ignores an expired row).
  async savePendingSignIn(stateHash: string, pending: PendingSignIn) {
    const nowAtSave = pending.expiresAt - SIGN_IN_TTL_SECONDS;
    for (const [hash, existing] of this.pending) if (existing.expiresAt <= nowAtSave) this.pending.delete(hash);
    this.pending.set(stateHash, { ...pending });
    while (this.pending.size > PENDING_SIGN_INS_MAX) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
  }

  // No await between the read and the delete, so this is one step on one event loop.
  async takePendingSignIn(stateHash: string) {
    const pending = this.pending.get(stateHash) ?? null;
    this.pending.delete(stateHash);
    return pending;
  }

  async upsertOwner(identity: GoogleIdentity) {
    const existing = this.owners.get(identity.sub);
    if (existing) {
      existing.email = identity.email;
      return { id: existing.id, email: existing.email };
    }
    const owner = { id: `own_${this.nextOwner++}`, email: identity.email, sub: identity.sub };
    this.owners.set(identity.sub, owner);
    return { id: owner.id, email: owner.email };
  }

  async saveSession(sessionHash: string, session: { ownerId: string; expiresAt: number }) {
    this.sessions.set(sessionHash, { ...session });
  }

  async findSession(sessionHash: string) {
    const session = this.sessions.get(sessionHash);
    if (!session) return null;
    const owner = [...this.owners.values()].find((candidate) => candidate.id === session.ownerId);
    return owner ? { owner: { id: owner.id, email: owner.email }, expiresAt: session.expiresAt } : null;
  }

  async deleteSession(sessionHash: string) {
    this.sessions.delete(sessionHash);
  }
}

/**
 * A relative path on this site, or "/". It must start with one "/", and may not start with "//" or
 * hold a backslash (browsers read both as another host), nor any character outside printable ASCII.
 */
export function safeReturnTo(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > RETURN_TO_MAX) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return "/";
  if (!/^[\x21-\x7e]+$/.test(raw)) return "/";
  return raw;
}

/** One cookie's value from a Cookie header; null when it is absent or appears more than once. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (typeof header !== "string") return null;
  const values = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1));
  return values.length === 1 && values[0] ? values[0] : null;
}

/** A __Host- cookie: Secure, Path=/, no Domain, HttpOnly, SameSite=Lax. Max-Age 0 clears it. */
export function hostCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

const sameHash = (token: string, hash: string) => hashToken(token) === hash;

export type OwnerAuthOptions = {
  /** The public https origin; the Google redirect URI is this plus SIGN_IN_CALLBACK_PATH. */
  host: string;
  google: GoogleClientConfig;
  store: OwnerStore;
  /** For Google's token endpoint. */
  fetchImpl: FetchLike;
  jwks: GoogleJwks;
  /** Seconds since the epoch. */
  now?: () => number;
  /** Told about a failure the visitor only sees as a plain error page. */
  onError?: (error: unknown) => void;
};

export type OwnerAuth = {
  /** Handles the three sign-in routes; false when the request is for another route. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /** The signed-in owner, or null. PR B's OwnerSessions.owner. */
  owner(req: IncomingMessage): Promise<Owner | null>;
  /** The same check, under the name Connect Gmail uses. */
  requireOwner(req: IncomingMessage): Promise<Owner | null>;
  /** Where to send a visitor with no session; returns there after sign-in. PR B's OwnerSessions.signInUrl. */
  signInUrl(returnTo: string): string;
  /** The redirect URI to register with Google for sign-in. */
  redirectUri: string;
};

function plain(res: ServerResponse, status: number, text: string, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(text);
}

/** Owner sign-in and the owner session, as one handler plus the checks other routes call. */
export function createOwnerAuth(options: OwnerAuthOptions): OwnerAuth {
  const host = assertOrigin(options.host);
  const redirectUri = `${host}${SIGN_IN_CALLBACK_PATH}`;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const { store } = options;

  async function owner(req: IncomingMessage): Promise<Owner | null> {
    const session = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (!session) return null;
    const found = await store.findSession(hashToken(session));
    return found && now() < found.expiresAt ? found.owner : null;
  }

  async function start(url: URL, res: ServerResponse): Promise<void> {
    const state = generateOpaqueToken();
    const codeVerifier = generateOpaqueToken();
    const nonce = generateOpaqueToken();
    const binding = generateOpaqueToken();
    await store.savePendingSignIn(hashToken(state), {
      bindingHash: hashToken(binding),
      codeVerifier,
      nonce,
      returnTo: safeReturnTo(url.searchParams.get("return_to")),
      expiresAt: now() + SIGN_IN_TTL_SECONDS,
    });
    const location = googleAuthorizationUrl({
      clientId: options.google.clientId,
      redirectUri,
      scopes: SIGN_IN_SCOPES,
      state,
      codeChallenge: pkceChallenge(codeVerifier),
      nonce,
      extra: { prompt: "select_account" },
    });
    res.writeHead(302, { location, "cache-control": "no-store", "set-cookie": hostCookie(SIGN_IN_COOKIE, binding, SIGN_IN_TTL_SECONDS) });
    res.end();
  }

  async function callback(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    // The callback URL carries the code: keep it out of Referer headers. Every answer clears the binding cookie.
    const clearBinding = hostCookie(SIGN_IN_COOKIE, "", 0);
    const fail = (status: number, text: string) => plain(res, status, text, { "referrer-policy": "no-referrer", "set-cookie": clearBinding });
    const state = url.searchParams.get("state");
    if (!state) return fail(400, "This sign-in link is not valid. Start again.");
    const pending = await store.takePendingSignIn(hashToken(state));
    if (!pending || now() >= pending.expiresAt) return fail(400, "This sign-in link expired or was already used. Start again.");
    const binding = readCookie(req.headers.cookie, SIGN_IN_COOKIE);
    if (!binding || !sameHash(binding, pending.bindingHash)) return fail(400, "Finish signing in in the browser where you started. Start again.");
    if (url.searchParams.has("error")) return fail(400, "Sign-in was cancelled.");
    const code = url.searchParams.get("code");
    if (!code) return fail(400, "This sign-in link is not valid. Start again.");

    let identity: GoogleIdentity;
    try {
      const tokens = await exchangeGoogleCode({ code, codeVerifier: pending.codeVerifier, redirectUri, config: options.google, fetchImpl: options.fetchImpl });
      identity = await verifyGoogleIdToken(tokens.idToken, { clientId: options.google.clientId, now: now(), nonce: pending.nonce, jwks: options.jwks });
    } catch (error) {
      options.onError?.(error);
      return fail(400, "Google did not confirm this sign-in. Start again.");
    }
    const signedIn = await store.upsertOwner(identity, now());
    const session = generateOpaqueToken();
    await store.saveSession(hashToken(session), { ownerId: signedIn.id, expiresAt: now() + SESSION_TTL_SECONDS });
    res.writeHead(302, {
      location: pending.returnTo,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "set-cookie": [hostCookie(SESSION_COOKIE, session, SESSION_TTL_SECONDS), clearBinding],
    });
    res.end();
  }

  async function signOut(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.headers.origin !== host) return plain(res, 403, "Sign out from this site.");
    const session = readCookie(req.headers.cookie, SESSION_COOKIE);
    if (session) await store.deleteSession(hashToken(session));
    res.writeHead(303, { location: "/", "cache-control": "no-store", "set-cookie": hostCookie(SESSION_COOKIE, "", 0) });
    res.end();
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === SIGN_IN_PATH) {
      await start(url, res);
      return true;
    }
    if (req.method === "GET" && url.pathname === SIGN_IN_CALLBACK_PATH) {
      await callback(req, url, res);
      return true;
    }
    if (req.method === "POST" && url.pathname === SIGN_OUT_PATH) {
      await signOut(req, res);
      return true;
    }
    return false;
  }

  return {
    handle,
    owner,
    requireOwner: owner,
    signInUrl: (returnTo) => `${SIGN_IN_PATH}?return_to=${encodeURIComponent(safeReturnTo(returnTo))}`,
    redirectUri,
  };
}
