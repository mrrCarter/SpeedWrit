// OAuth for the MCP endpoint (spec: "OAuth contract"), as pure functions over stored records.
// The HTTP routes and the database do the I/O; every decision is made here.
//
// - The metadata documents and the 401 challenge ChatGPT reads first.
// - PKCE S256 only, with a strict verifier and a constant-time compare.
// - Redirect URIs: ChatGPT's connector callbacks plus configured fallbacks, matched on the raw
//   string, never through a URL parser that could normalize an attacker's input into a match.
// - The token endpoint's checks (a two-key surface): authorization codes are one-time, bound to
//   client, redirect URI, PKCE challenge and resource; refresh tokens rotate, and presenting a
//   rotated one revokes the whole grant.
// - Access tokens: opaque, one hour, stored hashed, valid only for our resource and scope.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { FORBIDDEN_CHARACTERS } from "../gate/checks.js";
import { MCP_SCOPE } from "../mcp/tools.js";

export const ACCESS_TOKEN_TTL_SECONDS = 3600;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 3600;
export const AUTHORIZATION_CODE_TTL_SECONDS = 60;

/** ChatGPT's callback when issuer identification is met, and its per-connection fallback. */
export const CHATGPT_REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";
const CHATGPT_PER_CONNECTION = /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/;

// ---- Origin and metadata ---------------------------------------------------------------------

/** A public origin: https, a host, no path, query, fragment, credentials or trailing slash. */
export function assertOrigin(host: string): string {
  if (typeof host !== "string" || !/^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?$/.test(host)) {
    throw new TypeError("HOST must be an https origin such as https://jobs.example.com, with no path or trailing slash");
  }
  return host;
}

export type OAuthMetadata = {
  protectedResource: { resource: string; authorization_servers: [string]; scopes_supported: [string] };
  authorizationServer: {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint: string;
    response_types_supported: ["code"];
    grant_types_supported: ["authorization_code", "refresh_token"];
    code_challenge_methods_supported: ["S256"];
    token_endpoint_auth_methods_supported: ["none"];
    scopes_supported: [string];
    authorization_response_iss_parameter_supported: true;
  };
};

/**
 * Both documents. The issuer equals the authorization_servers entry character for character, and
 * no OIDC scope (openid, email, profile) is advertised, because ChatGPT requests whatever is.
 * Serve protectedResource at /.well-known/oauth-protected-resource and at
 * /.well-known/oauth-protected-resource/mcp; serve authorizationServer at
 * /.well-known/oauth-authorization-server.
 */
export function oauthMetadata(host: string): OAuthMetadata {
  const origin = assertOrigin(host);
  return {
    protectedResource: { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: [MCP_SCOPE] },
    authorizationServer: {
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: [MCP_SCOPE],
      authorization_response_iss_parameter_supported: true,
    },
  };
}

/** The WWW-Authenticate value for any unauthenticated request to /mcp (with HTTP 401). */
export function unauthorizedChallenge(host: string): string {
  return `Bearer resource_metadata="${assertOrigin(host)}/.well-known/oauth-protected-resource"`;
}

// ---- Tokens and PKCE -------------------------------------------------------------------------

/** A fresh opaque token: 32 random bytes, base64url. Only its hash is ever stored. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

/** sha256 of a token, hex: what the database stores and looks tokens up by. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** RFC 7636 S256: base64url(sha256(verifier)) equals the stored challenge. Nothing else passes. */
export function verifyPkceS256(verifier: unknown, challenge: unknown): boolean {
  if (typeof verifier !== "string" || typeof challenge !== "string") return false;
  if (!PKCE_VERIFIER.test(verifier) || !PKCE_CHALLENGE.test(challenge)) return false;
  return constantTimeEqual(createHash("sha256").update(verifier, "ascii").digest("base64url"), challenge);
}

// ---- Redirect URIs, registration and the authorization request ------------------------------

/** Whether a redirect URI is ChatGPT's or one of the configured fallbacks, by exact string. */
export function isAllowedRedirectUri(uri: unknown, fallbacks: readonly string[] = []): boolean {
  if (typeof uri !== "string") return false;
  return uri === CHATGPT_REDIRECT || CHATGPT_PER_CONNECTION.test(uri) || fallbacks.includes(uri);
}

export type OAuthError =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_grant_type"
  | "unsupported_response_type"
  | "invalid_scope"
  | "invalid_target"
  | "invalid_redirect_uri"
  | "invalid_client_metadata"
  | "access_denied";

export type Refusal = { ok: false; error: OAuthError; description: string };
const refuse = (error: OAuthError, description: string): Refusal => ({ ok: false, error, description });

/** Dynamic client registration: public clients only, code flow only, allowed redirects only. */
export function checkRegistration(
  body: unknown,
  fallbacks: readonly string[] = [],
): Refusal | { ok: true; redirect_uris: string[]; client_name: string } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return refuse("invalid_client_metadata", "body must be an object");
  const meta = body as Record<string, unknown>;
  const uris = meta.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5) {
    return refuse("invalid_redirect_uri", "redirect_uris must list 1 to 5 URIs");
  }
  if (!uris.every((uri) => isAllowedRedirectUri(uri, fallbacks))) return refuse("invalid_redirect_uri", "a redirect URI is not allowed");
  const method = meta.token_endpoint_auth_method ?? "none";
  if (method !== "none") return refuse("invalid_client_metadata", "only public clients (token_endpoint_auth_method none)");
  const grants = meta.grant_types ?? ["authorization_code", "refresh_token"];
  if (!Array.isArray(grants) || !grants.every((g) => g === "authorization_code" || g === "refresh_token")) {
    return refuse("invalid_client_metadata", "grant_types may be authorization_code and refresh_token only");
  }
  const responses = meta.response_types ?? ["code"];
  if (!Array.isArray(responses) || !responses.every((r) => r === "code")) {
    return refuse("invalid_client_metadata", "response_types may be code only");
  }
  // The owner's consent screen shows this name. It may not hold a direction override or any other
  // invisible character (the gate's rule), and it is cut by code point, so a cut never leaves half
  // a surrogate pair.
  const declared = typeof meta.client_name === "string" ? meta.client_name : "";
  if (FORBIDDEN_CHARACTERS.test(declared)) {
    return refuse("invalid_client_metadata", "client_name may not hold control, format or unassigned characters");
  }
  const name = declared.trim() === "" ? "unnamed client" : [...declared].slice(0, 100).join("");
  return { ok: true, redirect_uris: [...(uris as string[])], client_name: name };
}

export type RegisteredClient = { client_id: string; redirect_uris: readonly string[] };

export type AuthorizeRequest = {
  response_type?: unknown;
  client_id?: unknown;
  redirect_uri?: unknown;
  code_challenge?: unknown;
  code_challenge_method?: unknown;
  scope?: unknown;
  resource?: unknown;
  state?: unknown;
};

/**
 * The /oauth/authorize request, before the owner's consent screen. `client` is the registered
 * client the request's client_id names, or null. The redirect URI must be one the client
 * registered; until it is known good, errors are shown to the owner, never redirected.
 */
export function checkAuthorizeRequest(
  request: AuthorizeRequest,
  client: RegisteredClient | null,
  host: string,
): Refusal | { ok: true; client_id: string; redirect_uri: string; code_challenge: string; scope: string; resource: string; state: string | null } {
  const resource = `${assertOrigin(host)}/mcp`;
  if (!client || request.client_id !== client.client_id) return refuse("invalid_client", "unknown client");
  if (typeof request.redirect_uri !== "string" || !client.redirect_uris.includes(request.redirect_uri)) {
    return refuse("invalid_redirect_uri", "redirect_uri is not registered for this client");
  }
  if (request.response_type !== "code") return refuse("unsupported_response_type", "response_type must be code");
  if (request.code_challenge_method !== "S256") return refuse("invalid_request", "code_challenge_method must be S256");
  if (typeof request.code_challenge !== "string" || !PKCE_CHALLENGE.test(request.code_challenge)) {
    return refuse("invalid_request", "code_challenge must be a base64url S256 challenge");
  }
  const scope = request.scope === undefined || request.scope === "" ? MCP_SCOPE : request.scope;
  if (scope !== MCP_SCOPE) return refuse("invalid_scope", `the only scope is ${MCP_SCOPE}`);
  if (request.resource !== resource) return refuse("invalid_target", "resource must be this server's /mcp");
  const state = typeof request.state === "string" && request.state.length <= 512 ? request.state : null;
  return { ok: true, client_id: client.client_id, redirect_uri: request.redirect_uri, code_challenge: request.code_challenge, scope, resource, state };
}

/**
 * The redirect back to the client after consent (or a refusal once the redirect URI is known
 * good). It always carries iss, as the metadata advertises, and echoes state.
 */
export function authorizationRedirect(
  redirectUri: string,
  host: string,
  outcome: { code: string; state: string | null } | { error: OAuthError; state: string | null },
): string {
  const url = new URL(redirectUri);
  if ("code" in outcome) url.searchParams.set("code", outcome.code);
  else url.searchParams.set("error", outcome.error);
  if (outcome.state !== null) url.searchParams.set("state", outcome.state);
  url.searchParams.set("iss", assertOrigin(host));
  return url.toString();
}

// ---- The token endpoint ----------------------------------------------------------------------

/** A stored authorization code (looked up by hashToken(code)). */
export type StoredCode = {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  resource: string;
  scope: string;
  agent_connection_id: string;
  expires_at: number;
  used_at: number | null;
};

/** A stored refresh token (looked up by hashToken(token)). */
export type StoredRefresh = {
  client_id: string;
  agent_connection_id: string;
  resource: string;
  scope: string;
  expires_at: number;
  rotated_at: number | null;
  revoked_at: number | null;
};

export type TokenGrant = {
  ok: true;
  agent_connection_id: string;
  scope: string;
  resource: string;
  access_expires_at: number;
  refresh_expires_at: number;
  /**
   * What the caller must consume, as a compare-and-set, before issuing anything (see
   * TOKEN_CONSUME_SQL). This decision was made on a record read earlier; two concurrent
   * redemptions both see it unused, so only the conditional update decides which one wins.
   */
  consume: "code" | "refresh";
};

/**
 * The compare-and-set each grant needs, in the transaction that issues the tokens. Issue only
 * when it changes exactly one row; zero rows means another request consumed it first, and the
 * answer is invalid_grant. For a refresh, that loser may be a replay, so treat zero rows as the
 * reuse case: revoke the agent connection's grant.
 */
export const TOKEN_CONSUME_SQL = Object.freeze({
  code: "UPDATE oauth_codes SET used_at = now() WHERE code_hash = $1 AND used_at IS NULL",
  refresh:
    "UPDATE refresh_tokens SET rotated_at = now() WHERE token_hash = $1 AND rotated_at IS NULL AND revoked_at IS NULL",
} as const);

/** Presenting a refresh token that was already rotated: the grant is compromised. */
export type GrantRevocation = { ok: false; error: "invalid_grant"; description: string; revokeAgentConnection: string };

/**
 * POST /oauth/token. `stored` is the record found by hashToken of the presented code or refresh
 * token (null when none). `now` is seconds since the epoch, read from the database clock.
 *
 * This only decides. A grant is real once its TOKEN_CONSUME_SQL changes exactly one row in the
 * transaction that issues the tokens; without that, two concurrent redemptions of one code (or
 * refreshes of one token) both pass here. Code reuse does not revoke anything here; if that is
 * added, revoke only when the replay proves possession (client, redirect URI and PKCE all
 * match), so a guessed or leaked code alone cannot revoke someone's grant.
 */
export function checkTokenRequest(
  params: Record<string, unknown>,
  stored: { code: StoredCode | null; refresh: StoredRefresh | null },
  host: string,
  now: number,
): Refusal | GrantRevocation | TokenGrant {
  const resource = `${assertOrigin(host)}/mcp`;
  const issue = (agent: string, scope: string, consume: TokenGrant["consume"]): TokenGrant => ({
    ok: true,
    agent_connection_id: agent,
    scope,
    resource,
    access_expires_at: now + ACCESS_TOKEN_TTL_SECONDS,
    refresh_expires_at: now + REFRESH_TOKEN_TTL_SECONDS,
    consume,
  });
  if (params.resource !== undefined && params.resource !== resource) return refuse("invalid_target", "resource must be this server's /mcp");

  if (params.grant_type === "authorization_code") {
    const code = stored.code;
    if (typeof params.code !== "string" || !code) return refuse("invalid_grant", "unknown code");
    if (code.used_at !== null) return refuse("invalid_grant", "the code was already used");
    if (now >= code.expires_at) return refuse("invalid_grant", "the code expired");
    if (params.client_id !== code.client_id) return refuse("invalid_grant", "the code belongs to another client");
    if (params.redirect_uri !== code.redirect_uri) return refuse("invalid_grant", "redirect_uri does not match the authorization request");
    if (code.resource !== resource) return refuse("invalid_target", "the code is for another resource");
    if (!verifyPkceS256(params.code_verifier, code.code_challenge)) return refuse("invalid_grant", "PKCE verification failed");
    return issue(code.agent_connection_id, code.scope, "code");
  }

  if (params.grant_type === "refresh_token") {
    const refresh = stored.refresh;
    if (typeof params.refresh_token !== "string" || !refresh) return refuse("invalid_grant", "unknown refresh token");
    if (refresh.rotated_at !== null) {
      return {
        ok: false,
        error: "invalid_grant",
        description: "a rotated refresh token was presented again; the grant is revoked",
        revokeAgentConnection: refresh.agent_connection_id,
      };
    }
    if (refresh.revoked_at !== null) return refuse("invalid_grant", "the grant was revoked");
    if (now >= refresh.expires_at) return refuse("invalid_grant", "the refresh token expired");
    if (params.client_id !== refresh.client_id) return refuse("invalid_grant", "the token belongs to another client");
    if (refresh.resource !== resource) return refuse("invalid_target", "the token is for another resource");
    return issue(refresh.agent_connection_id, refresh.scope, "refresh");
  }

  return refuse("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
}

// ---- Access tokens at /mcp -------------------------------------------------------------------

export type StoredAccess = {
  agent_connection_id: string;
  resource: string;
  scope: string;
  expires_at: number;
  revoked_at: number | null;
};

/**
 * A bearer token presented at /mcp. `stored` is the record found by hashToken(token), or null.
 * Any failure is a 401 with unauthorizedChallenge(host); the token never reaches the gate.
 */
export function checkAccessToken(
  stored: StoredAccess | null,
  host: string,
  now: number,
): { ok: true; agent_connection_id: string } | { ok: false } {
  const resource = `${assertOrigin(host)}/mcp`;
  if (!stored) return { ok: false };
  if (stored.revoked_at !== null || now >= stored.expires_at) return { ok: false };
  if (stored.resource !== resource) return { ok: false };
  if (!stored.scope.split(" ").includes(MCP_SCOPE)) return { ok: false };
  return { ok: true, agent_connection_id: stored.agent_connection_id };
}
