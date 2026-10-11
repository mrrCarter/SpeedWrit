import test from "node:test";
import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";

import {
  createGoogleJwks,
  exchangeGoogleCode,
  GoogleAuthError,
  googleAuthorizationUrl,
  googleClientConfigFromEnv,
  GOOGLE_JWKS_URI,
  GOOGLE_TOKEN_ENDPOINT,
  pkceChallenge,
  verifyGoogleIdToken,
} from "../../dist/owner/google.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const CLIENT = "cid.apps.googleusercontent.com";
const NOW = 1_800_000_000;
const CLAIMS = {
  iss: "https://accounts.google.com",
  aud: CLIENT,
  azp: CLIENT,
  sub: "110169484474386276334",
  email: "Owner@Test.Example",
  email_verified: true,
  iat: NOW - 10,
  exp: NOW + 3600,
  nonce: "n1",
};
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
function idToken(claims = CLAIMS, header = { alg: "RS256", kid: "k1", typ: "JWT" }, key = privateKey) {
  const signing = `${b64(header)}.${b64(claims)}`;
  return `${signing}.${sign("RSA-SHA256", Buffer.from(signing), key).toString("base64url")}`;
}
const jwks = { key: async (kid) => (kid === "k1" ? JWK : null) };
const verify = (token, extra = {}) => verifyGoogleIdToken(token, { clientId: CLIENT, now: NOW, nonce: "n1", jwks, ...extra });
const rejects = (promise, reason) => assert.rejects(promise, (error) => error instanceof GoogleAuthError && error.reason === reason);

test("a good ID token gives the Google subject and the verified email, lowercased", async () => {
  assert.deepEqual(await verify(idToken()), { sub: CLAIMS.sub, email: "owner@test.example" });
  assert.deepEqual(await verify(idToken({ ...CLAIMS, iss: "accounts.google.com" })), { sub: CLAIMS.sub, email: "owner@test.example" });
});

test("the signature, algorithm and key are checked before any claim is trusted", async () => {
  await rejects(verify(idToken(CLAIMS, { alg: "RS256", kid: "k1" }, other.privateKey)), "signature");
  const [h, , s] = idToken().split(".");
  await rejects(verify(`${h}.${b64({ ...CLAIMS, sub: "attacker" })}.${s}`), "signature");
  await rejects(verify(idToken(CLAIMS, { alg: "RS256", kid: "k9" })), "unknown_key");
  await rejects(verify(`${b64({ alg: "none", kid: "k1" })}.${b64(CLAIMS)}.`), "alg");
  // HS256 keyed with the public key: the classic algorithm confusion.
  const hsSigning = `${b64({ alg: "HS256", kid: "k1" })}.${b64(CLAIMS)}`;
  const hs = createHmac("sha256", publicKey.export({ format: "pem", type: "spki" })).update(hsSigning).digest("base64url");
  await rejects(verify(`${hsSigning}.${hs}`), "alg");
  for (const bad of ["", "a.b", "a.b.c.d", "!!.b.c", `${b64({ alg: "RS256" })}.${b64(CLAIMS)}.x`]) await assert.rejects(verify(bad), GoogleAuthError);
});

test("each claim must hold: issuer, audience, azp, lifetime with 60 s skew, nonce, verified email, subject", async () => {
  await rejects(verify(idToken({ ...CLAIMS, iss: "https://evil.example" })), "iss");
  await rejects(verify(idToken({ ...CLAIMS, aud: "another-client" })), "aud");
  await rejects(verify(idToken({ ...CLAIMS, aud: [CLIENT] })), "aud");
  await rejects(verify(idToken({ ...CLAIMS, azp: "another-client" })), "azp");
  await rejects(verify(idToken({ ...CLAIMS, exp: NOW - 60 })), "expired");
  assert.ok(await verify(idToken({ ...CLAIMS, exp: NOW - 59 })), "inside the skew");
  await rejects(verify(idToken({ ...CLAIMS, iat: NOW + 61 })), "iat");
  await rejects(verify(idToken({ ...CLAIMS, nonce: "n2" })), "nonce");
  await rejects(verify(idToken({ ...CLAIMS, nonce: undefined })), "nonce");
  for (const value of [false, "true", undefined]) await rejects(verify(idToken({ ...CLAIMS, email_verified: value })), "email_unverified");
  await rejects(verify(idToken({ ...CLAIMS, sub: "" })), "sub");
  await rejects(verify(idToken({ ...CLAIMS, email: undefined })), "email");
});

test("the JWKS cache: one fetch per hour; an unknown key id refetches at most once a minute", async () => {
  let clock = NOW;
  let fetches = 0;
  let served = [JWK];
  const fetchImpl = async (url) => {
    assert.equal(url, GOOGLE_JWKS_URI);
    fetches += 1;
    return { ok: true, status: 200, json: async () => ({ keys: served }) };
  };
  const cache = createGoogleJwks(fetchImpl, () => clock);
  assert.ok(await cache.key("k1"));
  assert.ok(await cache.key("k1"));
  assert.equal(fetches, 1);
  assert.equal(await cache.key("rotated"), null);
  assert.equal(fetches, 2, "an unknown kid refetches once");
  assert.equal(await cache.key("made-up"), null);
  assert.equal(fetches, 2, "but not again inside a minute");
  served = [JWK, { ...JWK, kid: "rotated" }];
  clock += 61;
  assert.ok(await cache.key("rotated"));
  assert.equal(fetches, 3);
  clock += 3600;
  assert.ok(await cache.key("k1"));
  assert.equal(fetches, 4, "an hour later the keys are fetched again");
});

test("the authorization URL is the code flow with S256; extra parameters can never replace ours", () => {
  const url = new URL(
    googleAuthorizationUrl({
      clientId: CLIENT,
      redirectUri: "https://jobs.example.com/auth/google/callback",
      scopes: ["openid", "email"],
      state: "s1",
      codeChallenge: pkceChallenge("v".repeat(43)),
      nonce: "n1",
      extra: { prompt: "select_account" },
    }),
  );
  assert.equal(url.origin + url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    client_id: CLIENT,
    redirect_uri: "https://jobs.example.com/auth/google/callback",
    response_type: "code",
    scope: "openid email",
    state: "s1",
    code_challenge: createHash("sha256").update("v".repeat(43)).digest("base64url"),
    code_challenge_method: "S256",
    nonce: "n1",
    prompt: "select_account",
  });
  for (const key of ["scope", "redirect_uri", "client_id", "state"]) {
    assert.throws(() => googleAuthorizationUrl({ clientId: CLIENT, redirectUri: "https://x", scopes: [], state: "s", codeChallenge: "c", extra: { [key]: "x" } }), TypeError);
  }
});

test("the code exchange posts the verifier and the client, and keeps nothing of a failed response", async () => {
  let posted;
  const ok = async (url, init) => {
    posted = { url, ...init };
    return { ok: true, status: 200, json: async () => ({ id_token: "tok", access_token: "at", scope: "openid email", expires_in: 3599 }) };
  };
  const tokens = await exchangeGoogleCode({ code: "c1", codeVerifier: "v1", redirectUri: "https://x/cb", config: { clientId: CLIENT, clientSecret: "shh" }, fetchImpl: ok });
  assert.deepEqual(tokens, { idToken: "tok", accessToken: "at", refreshToken: null, scope: "openid email", expiresIn: 3599 });
  assert.equal(posted.url, GOOGLE_TOKEN_ENDPOINT);
  assert.equal(posted.method, "POST");
  assert.deepEqual(Object.fromEntries(new URLSearchParams(posted.body)), {
    grant_type: "authorization_code",
    code: "c1",
    code_verifier: "v1",
    redirect_uri: "https://x/cb",
    client_id: CLIENT,
    client_secret: "shh",
  });
  const refused = async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant", error_description: "secret detail" }) });
  await assert.rejects(exchangeGoogleCode({ code: "c", codeVerifier: "v", redirectUri: "r", config: { clientId: CLIENT, clientSecret: "s" }, fetchImpl: refused }), (error) => error.reason === "token_endpoint_http_400" && !error.message.includes("secret detail"));
  const noId = async () => ({ ok: true, status: 200, json: async () => ({ access_token: "at" }) });
  await rejects(exchangeGoogleCode({ code: "c", codeVerifier: "v", redirectUri: "r", config: { clientId: CLIENT, clientSecret: "s" }, fetchImpl: noId }), "no_id_token");
});

test("the client config comes from the environment and refuses to run without it", () => {
  assert.deepEqual(googleClientConfigFromEnv({ GOOGLE_CLIENT_ID: "a", GOOGLE_CLIENT_SECRET: "b" }), { clientId: "a", clientSecret: "b" });
  assert.throws(() => googleClientConfigFromEnv({ GOOGLE_CLIENT_ID: "a" }));
});
