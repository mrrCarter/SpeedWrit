// `grokbot login`: grokbot as its own OAuth client of SpeedWrit, the way ChatGPT is. Dynamic
// registration as a public client, PKCE S256, a loopback redirect (RFC 8252), and RFC 9207's iss
// check. The owner consents once in the browser; that consent creates grokbot's own agent
// connection, so jobs are confirmed for grokbot and a ChatGPT job refuses grokbot.
//
// The host must allow the loopback redirect: REDIRECT_FALLBACKS=http://127.0.0.1:8976/callback.

import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname } from "node:path";

import type { FetchLike } from "./xai.js";

export const LOOPBACK_PORT = 8976;
export const LOOPBACK_REDIRECT = `http://127.0.0.1:${LOOPBACK_PORT}/callback`;
export const CLIENT_NAME = "grokbot (xAI Grok)";
/** Refresh this many seconds before the access token's expiry, so xAI never carries a dying token. */
const REFRESH_MARGIN_SECONDS = 300;

export type ServerMetadata = { issuer: string; authorization_endpoint: string; token_endpoint: string; registration_endpoint: string; scopes_supported?: string[] };

export type StoredTokens = {
  origin: string;
  client_id: string;
  token_endpoint: string;
  access_token: string;
  refresh_token: string;
  /** Seconds since the epoch. */
  expires_at: number;
};

export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginError";
  }
}

async function json(res: Response): Promise<Record<string, unknown>> {
  try {
    const body = (await res.json()) as unknown;
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const oauthProblem = (body: Record<string, unknown>, res: Response) =>
  `${res.status} ${typeof body.error === "string" ? body.error : ""} ${typeof body.error_description === "string" ? body.error_description : ""}`.trim();

/** The authorization server metadata. Its issuer must be the origin character for character. */
export async function discover(fetchImpl: FetchLike, origin: string): Promise<ServerMetadata> {
  const res = await fetchImpl(`${origin}/.well-known/oauth-authorization-server`, { method: "GET", headers: { accept: "application/json" } });
  const body = await json(res);
  if (!res.ok) throw new LoginError(`metadata: ${oauthProblem(body, res)}`);
  if (body.issuer !== origin) throw new LoginError(`metadata: issuer ${String(body.issuer)} is not ${origin}`);
  for (const key of ["authorization_endpoint", "token_endpoint", "registration_endpoint"] as const) {
    if (typeof body[key] !== "string" || !String(body[key]).startsWith(`${origin}/`)) throw new LoginError(`metadata: ${key} is missing or on another origin`);
  }
  return body as unknown as ServerMetadata;
}

export async function registerClient(fetchImpl: FetchLike, metadata: ServerMetadata, redirectUri: string): Promise<string> {
  const res = await fetchImpl(metadata.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  const body = await json(res);
  if (!res.ok || typeof body.client_id !== "string") {
    const hint = body.error === "invalid_redirect_uri" ? ` (the host must list ${redirectUri} in REDIRECT_FALLBACKS)` : "";
    throw new LoginError(`registration: ${oauthProblem(body, res)}${hint}`);
  }
  return body.client_id;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier, "ascii").digest("base64url") };
}

export function authorizeUrl(metadata: ServerMetadata, options: { clientId: string; redirectUri: string; challenge: string; state: string; resource: string; scope?: string }): string {
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("redirect_uri", options.redirectUri);
  url.searchParams.set("code_challenge", options.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", options.state);
  url.searchParams.set("resource", options.resource);
  const scope = options.scope ?? metadata.scopes_supported?.[0];
  if (scope) url.searchParams.set("scope", scope);
  return url.toString();
}

/**
 * Waits on 127.0.0.1 for the one redirect back. The state must match, and iss must be the
 * issuer (RFC 9207), or the code is refused: a code from another server is never redeemed here.
 */
export function waitForCallback(options: { port: number; path: string; state: string; issuer: string; timeoutMs: number }): {
  ready: Promise<number>;
  code: Promise<string>;
} {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== options.path) {
      res.writeHead(404).end();
      return;
    }
    const finish = (status: number, text: string, outcome: { code: string } | { error: string }) => {
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }).end(text);
      clearTimeout(timer);
      server.close();
      if ("code" in outcome) resolveCode(outcome.code);
      else rejectCode(new LoginError(outcome.error));
    };
    const params = url.searchParams;
    if (params.get("state") !== options.state) return finish(400, "This sign-in answer does not match the request. Run grokbot login again.", { error: "callback: state does not match" });
    if (params.get("iss") !== options.issuer) return finish(400, "This sign-in answer came from another server. Run grokbot login again.", { error: "callback: iss is not the issuer" });
    const error = params.get("error");
    if (error) return finish(200, `SpeedWrit answered: ${error}. You can close this tab.`, { error: `callback: ${error}` });
    const value = params.get("code");
    if (!value) return finish(400, "No code in this answer. Run grokbot login again.", { error: "callback: no code" });
    finish(200, "grokbot is connected to SpeedWrit. You can close this tab.", { code: value });
  });
  const timer = setTimeout(() => {
    server.close();
    rejectCode(new LoginError("callback: timed out waiting for the owner's answer"));
  }, options.timeoutMs);
  timer.unref();
  const ready = new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : options.port);
    });
  });
  return { ready, code };
}

async function tokenRequest(fetchImpl: FetchLike, tokenEndpoint: string, form: Record<string, string>, nowSeconds: number) {
  const res = await fetchImpl(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
  });
  const body = await json(res);
  if (!res.ok || typeof body.access_token !== "string" || typeof body.refresh_token !== "string") {
    throw new LoginError(`token: ${oauthProblem(body, res)}`);
  }
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 3600;
  return { access_token: body.access_token, refresh_token: body.refresh_token, expires_at: nowSeconds + expiresIn };
}

export async function exchangeCode(
  fetchImpl: FetchLike,
  options: { origin: string; tokenEndpoint: string; clientId: string; code: string; verifier: string; redirectUri: string; resource: string; now: number },
): Promise<StoredTokens> {
  const issued = await tokenRequest(
    fetchImpl,
    options.tokenEndpoint,
    { grant_type: "authorization_code", code: options.code, code_verifier: options.verifier, client_id: options.clientId, redirect_uri: options.redirectUri, resource: options.resource },
    options.now,
  );
  return { origin: options.origin, client_id: options.clientId, token_endpoint: options.tokenEndpoint, ...issued };
}

export async function readTokens(file: string): Promise<StoredTokens | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as StoredTokens;
  } catch {
    return null;
  }
}

/** Written owner-only (0600) and swapped in whole, so a crash never leaves half a token file. */
export async function saveTokens(file: string, tokens: StoredTokens): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, file);
}

/**
 * A usable access token for `origin`. Refreshes when it is near expiry and saves the rotated
 * pair before returning: SpeedWrit revokes the whole grant if a rotated refresh token is shown
 * twice, so the new one must be on disk before anything else can fail.
 */
export async function currentBearer(fetchImpl: FetchLike, options: { file: string; origin: string; resource: string; now: number }): Promise<string> {
  const stored = await readTokens(options.file);
  if (!stored || stored.origin !== options.origin) throw new LoginError(`no grokbot sign-in for ${options.origin}. Run grokbot login.`);
  if (stored.expires_at - REFRESH_MARGIN_SECONDS > options.now) return stored.access_token;
  const issued = await tokenRequest(
    fetchImpl,
    stored.token_endpoint,
    { grant_type: "refresh_token", refresh_token: stored.refresh_token, client_id: stored.client_id, resource: options.resource },
    options.now,
  );
  const next = { ...stored, ...issued };
  await saveTokens(options.file, next);
  return next.access_token;
}

/** The whole sign-in. `openUrl` shows the consent URL to the owner (a browser, or a test's driver). */
export async function login(
  fetchImpl: FetchLike,
  options: { origin: string; file: string; openUrl: (url: string) => Promise<void> | void; now: () => number; port?: number; timeoutMs?: number },
): Promise<StoredTokens> {
  const metadata = await discover(fetchImpl, options.origin);
  const port = options.port ?? LOOPBACK_PORT;
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const clientId = await registerClient(fetchImpl, metadata, redirectUri);
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(16).toString("base64url");
  const resource = `${options.origin}/mcp`;
  const callback = waitForCallback({ port, path: "/callback", state, issuer: metadata.issuer, timeoutMs: options.timeoutMs ?? 300000 });
  await callback.ready;
  await options.openUrl(authorizeUrl(metadata, { clientId, redirectUri, challenge, state, resource }));
  const code = await callback.code;
  const tokens = await exchangeCode(fetchImpl, { origin: options.origin, tokenEndpoint: metadata.token_endpoint, clientId, code, verifier, redirectUri, resource, now: options.now() });
  await saveTokens(options.file, tokens);
  return tokens;
}
