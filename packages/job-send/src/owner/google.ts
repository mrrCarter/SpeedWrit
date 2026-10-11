// The one Google client module. Owner sign-in and Connect Gmail share it, so Google's tokens are
// read one way: the endpoints, the authorization URL, the code exchange, and ID-token verification
// against Google's published keys. node:crypto only; every network call goes through an injected
// fetch, and the client secret comes from the environment, never from the repo.

import { createHash, createPublicKey, verify as verifySignature, type JsonWebKey } from "node:crypto";

export const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_URI = "https://www.googleapis.com/oauth2/v3/certs";
/** Google signs ID tokens with either issuer string. */
export const GOOGLE_ISSUERS: readonly string[] = Object.freeze(["https://accounts.google.com", "accounts.google.com"]);
/** Owner sign-in asks for these and nothing else. Connect Gmail adds gmail.send in its own authorization. */
export const SIGN_IN_SCOPES: readonly string[] = Object.freeze(["openid", "email"]);
/** Clock skew allowed on exp and iat, in seconds. */
export const ID_TOKEN_SKEW_SECONDS = 60;
/** How long fetched keys are reused, and the least time between refetches for an unknown key id. */
export const JWKS_TTL_SECONDS = 3600;
export const JWKS_MISS_REFETCH_SECONDS = 60;

export type GoogleClientConfig = { clientId: string; clientSecret: string };

/** The client from GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET; throws when either is missing. */
export function googleClientConfigFromEnv(env: Record<string, string | undefined>): GoogleClientConfig {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set");
  return { clientId, clientSecret };
}

/** The slice of fetch this module uses. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** RFC 7636 S256: base64url(sha256(verifier)). */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

const RESERVED_PARAMS = new Set([
  "client_id",
  "redirect_uri",
  "response_type",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
  "nonce",
]);

/**
 * Google's authorization URL for the code flow with PKCE S256. `extra` adds parameters such as
 * access_type=offline and prompt=consent for Connect Gmail; it can never replace one of the
 * parameters set here.
 */
export function googleAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  codeChallenge: string;
  nonce?: string;
  extra?: Readonly<Record<string, string>>;
}): string {
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  const params = url.searchParams;
  params.set("client_id", input.clientId);
  params.set("redirect_uri", input.redirectUri);
  params.set("response_type", "code");
  params.set("scope", input.scopes.join(" "));
  params.set("state", input.state);
  params.set("code_challenge", input.codeChallenge);
  params.set("code_challenge_method", "S256");
  if (input.nonce !== undefined) params.set("nonce", input.nonce);
  for (const [key, value] of Object.entries(input.extra ?? {})) {
    if (RESERVED_PARAMS.has(key)) throw new TypeError(`extra may not set ${key}`);
    params.set(key, value);
  }
  return url.toString();
}

/** Why a Google step failed. `reason` is a fixed code; nothing from Google's response body is kept. */
export class GoogleAuthError extends Error {
  constructor(readonly reason: string) {
    super(`google: ${reason}`);
    this.name = "GoogleAuthError";
  }
}

export type GoogleTokens = {
  idToken: string;
  accessToken: string | null;
  refreshToken: string | null;
  /** The scopes Google granted, space-separated. A person can untick one on Google's consent screen. */
  scope: string;
  expiresIn: number | null;
};

/** Exchanges an authorization code at Google's token endpoint (confidential web client, with PKCE). */
export async function exchangeGoogleCode(input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  config: GoogleClientConfig;
  fetchImpl: FetchLike;
}): Promise<GoogleTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: input.redirectUri,
    client_id: input.config.clientId,
    client_secret: input.config.clientSecret,
  });
  const res = await input.fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
  });
  if (!res.ok) throw new GoogleAuthError(`token_endpoint_http_${res.status}`);
  const data = (await res.json()) as Record<string, unknown> | null;
  if (data === null || typeof data !== "object" || typeof data.id_token !== "string") throw new GoogleAuthError("no_id_token");
  return {
    idToken: data.id_token,
    accessToken: typeof data.access_token === "string" ? data.access_token : null,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : null,
    scope: typeof data.scope === "string" ? data.scope : "",
    expiresIn: typeof data.expires_in === "number" ? data.expires_in : null,
  };
}

/** Google's signing keys, looked up by key id. */
export type GoogleJwks = { key(kid: string): Promise<JsonWebKey | null> };

/**
 * Google's published keys, cached for JWKS_TTL_SECONDS. An unknown key id (Google rotated) refetches,
 * but at most once per JWKS_MISS_REFETCH_SECONDS, so made-up key ids cannot drive a refetch storm.
 */
export function createGoogleJwks(fetchImpl: FetchLike, now: () => number): GoogleJwks {
  let keys = new Map<string, JsonWebKey>();
  let fetchedAt = Number.NEGATIVE_INFINITY;
  let lastMissFetch = Number.NEGATIVE_INFINITY;
  const load = async () => {
    const res = await fetchImpl(GOOGLE_JWKS_URI);
    if (!res.ok) throw new GoogleAuthError(`jwks_http_${res.status}`);
    const data = (await res.json()) as { keys?: unknown } | null;
    const list = Array.isArray(data?.keys) ? (data.keys as Array<Record<string, unknown>>) : [];
    keys = new Map(
      list
        .filter((jwk) => jwk && jwk.kty === "RSA" && typeof jwk.kid === "string" && typeof jwk.n === "string" && typeof jwk.e === "string")
        .map((jwk) => [jwk.kid as string, { kty: "RSA", n: jwk.n as string, e: jwk.e as string }]),
    );
    fetchedAt = now();
  };
  return {
    async key(kid) {
      if (now() - fetchedAt >= JWKS_TTL_SECONDS) await load();
      let jwk = keys.get(kid);
      if (!jwk && now() - lastMissFetch >= JWKS_MISS_REFETCH_SECONDS) {
        lastMissFetch = now();
        await load();
        jwk = keys.get(kid);
      }
      return jwk ?? null;
    },
  };
}

/** Who signed in: the stable Google subject, and the verified email shown to the owner. */
export type GoogleIdentity = { sub: string; email: string };

function decodeJson(segment: string, reason: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new GoogleAuthError(reason);
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw new GoogleAuthError(reason);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new GoogleAuthError(reason);
  return value as Record<string, unknown>;
}

/**
 * Verifies a Google ID token: RS256 under one of Google's keys, issued by Google, for this client,
 * inside its lifetime (with ID_TOKEN_SKEW_SECONDS), carrying the expected nonce, with a verified
 * email. Any failure throws GoogleAuthError with a fixed reason. Owners are keyed by `sub`, never
 * by email.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  options: { clientId: string; now: number; nonce?: string; jwks: GoogleJwks },
): Promise<GoogleIdentity> {
  if (typeof idToken !== "string") throw new GoogleAuthError("malformed");
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new GoogleAuthError("malformed");
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = decodeJson(headerPart, "malformed");
  if (header.alg !== "RS256") throw new GoogleAuthError("alg");
  if (typeof header.kid !== "string") throw new GoogleAuthError("malformed");
  const jwk = await options.jwks.key(header.kid);
  if (!jwk) throw new GoogleAuthError("unknown_key");
  if (!/^[A-Za-z0-9_-]+$/.test(signaturePart)) throw new GoogleAuthError("malformed");
  const good = verifySignature(
    "RSA-SHA256",
    Buffer.from(`${headerPart}.${payloadPart}`, "ascii"),
    createPublicKey({ key: jwk, format: "jwk" }),
    Buffer.from(signaturePart, "base64url"),
  );
  if (!good) throw new GoogleAuthError("signature");

  const claims = decodeJson(payloadPart, "malformed");
  if (typeof claims.iss !== "string" || !GOOGLE_ISSUERS.includes(claims.iss)) throw new GoogleAuthError("iss");
  if (claims.aud !== options.clientId) throw new GoogleAuthError("aud");
  if (claims.azp !== undefined && claims.azp !== options.clientId) throw new GoogleAuthError("azp");
  if (typeof claims.exp !== "number" || options.now >= claims.exp + ID_TOKEN_SKEW_SECONDS) throw new GoogleAuthError("expired");
  if (typeof claims.iat !== "number" || claims.iat > options.now + ID_TOKEN_SKEW_SECONDS) throw new GoogleAuthError("iat");
  if (options.nonce !== undefined && claims.nonce !== options.nonce) throw new GoogleAuthError("nonce");
  if (claims.email_verified !== true) throw new GoogleAuthError("email_unverified");
  if (typeof claims.sub !== "string" || claims.sub.length === 0 || claims.sub.length > 255) throw new GoogleAuthError("sub");
  if (typeof claims.email !== "string" || claims.email.length === 0) throw new GoogleAuthError("email");
  return { sub: claims.sub, email: claims.email.toLowerCase() };
}
