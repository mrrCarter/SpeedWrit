import test from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";

import { GOOGLE_TOKEN_ENDPOINT } from "../../dist/owner/google.js";
import {
  createOwnerAuth,
  InMemoryOwnerStore,
  PENDING_SIGN_INS_MAX,
  readCookie,
  RETURN_TO_MAX,
  safeReturnTo,
  SESSION_COOKIE,
  SIGN_IN_COOKIE,
  SIGN_IN_TTL_SECONDS,
} from "../../dist/owner/signin.js";

const HOST = "https://jobs.example.com";
const CLIENT = "cid.apps.googleusercontent.com";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: "k1" };
const jwks = { key: async (kid) => (kid === "k1" ? JWK : null) };
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
function idToken(claims) {
  const signing = `${b64({ alg: "RS256", kid: "k1" })}.${b64(claims)}`;
  return `${signing}.${sign("RSA-SHA256", Buffer.from(signing), privateKey).toString("base64url")}`;
}

/** A running sign-in server with a fake Google token endpoint that signs ID tokens for `identity`. */
async function app({ identity = { sub: "sub-1", email: "Owner@Test.Example" }, nonceOverride, clock } = {}) {
  let now = clock ?? 1_800_000_000;
  const store = new InMemoryOwnerStore();
  const exchanges = [];
  const fetchImpl = async (url, init) => {
    assert.equal(url, GOOGLE_TOKEN_ENDPOINT);
    const form = Object.fromEntries(new URLSearchParams(init.body));
    exchanges.push(form);
    const nonce = nonceOverride ?? app.lastNonce;
    return {
      ok: true,
      status: 200,
      json: async () => ({ id_token: idToken({ iss: "https://accounts.google.com", aud: CLIENT, sub: identity.sub, email: identity.email, email_verified: true, iat: now, exp: now + 3600, nonce }), access_token: "dropped" }),
    };
  };
  const auth = createOwnerAuth({ host: HOST, google: { clientId: CLIENT, clientSecret: "shh" }, store, fetchImpl, jwks, now: () => now });
  const server = createServer((req, res) => {
    auth.handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, cookie, headers = {}) => fetch(`${base}${path}`, { redirect: "manual", headers: { ...(cookie ? { cookie } : {}), ...headers } });
  const post = (path, cookie, headers = {}) => fetch(`${base}${path}`, { method: "POST", redirect: "manual", headers: { ...(cookie ? { cookie } : {}), ...headers } });
  return { auth, store, exchanges, get, post, tick: (seconds) => (now += seconds), close: () => new Promise((resolve) => server.close(resolve)) };
}

/** Starts a sign-in; returns Google's URL parameters and the binding cookie. */
async function startSignIn(t, returnTo = "/oauth/authorize?client_id=c1") {
  const res = await t.get(`/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`);
  assert.equal(res.status, 302);
  const google = new URL(res.headers.get("location"));
  const setCookie = res.headers.getSetCookie();
  const binding = setCookie.map((c) => c.split(";")[0]).find((c) => c.startsWith(`${SIGN_IN_COOKIE}=`));
  app.lastNonce = google.searchParams.get("nonce");
  return { google, setCookie, binding, state: google.searchParams.get("state") };
}

const sessionFrom = (res) => res.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith(`${SESSION_COOKIE}=`) && c.length > SESSION_COOKIE.length + 1);
const ownerFor = (t, cookie) => t.auth.owner({ headers: { cookie } });

test("sign-in asks Google for openid email only, with S256, state and nonce, and binds this browser with a __Host- cookie", async () => {
  const t = await app();
  try {
    const { google, setCookie } = await startSignIn(t);
    assert.equal(google.origin + google.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(google.searchParams.get("scope"), "openid email");
    assert.equal(google.searchParams.get("redirect_uri"), `${HOST}/auth/google/callback`);
    assert.equal(google.searchParams.get("code_challenge_method"), "S256");
    for (const key of ["state", "nonce", "code_challenge"]) assert.ok((google.searchParams.get(key) ?? "").length >= 43, key);
    assert.match(setCookie[0], /^__Host-writ_signin=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/);
  } finally {
    await t.close();
  }
});

test("the callback exchanges the code with the matching verifier, keys the owner by sub, sets the session and returns", async () => {
  const t = await app();
  try {
    const { google, binding, state } = await startSignIn(t);
    const res = await t.get(`/auth/google/callback?code=c1&state=${state}`, binding);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/oauth/authorize?client_id=c1");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.get("cache-control"), "no-store", "the redirect that sets the session is never cached (machine S16)");
    const exchange = t.exchanges[0];
    assert.equal(createHash("sha256").update(exchange.code_verifier).digest("base64url"), google.searchParams.get("code_challenge"));
    assert.equal(exchange.code, "c1");
    const cookies = res.headers.getSetCookie();
    assert.match(cookies[0], /^__Host-writ_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200$/);
    assert.match(cookies[1], /^__Host-writ_signin=; .*Max-Age=0$/);
    const session = sessionFrom(res);
    assert.deepEqual(await ownerFor(t, session), { id: "own_1", email: "owner@test.example" });
    assert.equal([...t.store.sessions.keys()][0].length, 64, "only the session's hash is stored");
    assert.ok(![...t.store.sessions.keys()].includes(session.split("=")[1]));
  } finally {
    await t.close();
  }
});

test("without this browser's binding cookie the callback refuses, and the state is spent either way", async () => {
  const t = await app();
  try {
    const { binding, state } = await startSignIn(t);
    const foreign = await t.get(`/auth/google/callback?code=c1&state=${state}`, `${SIGN_IN_COOKIE}=someone-elses`);
    assert.equal(foreign.status, 400);
    assert.equal(sessionFrom(foreign), undefined);
    const retry = await t.get(`/auth/google/callback?code=c1&state=${state}`, binding);
    assert.equal(retry.status, 400, "a state is one-time");
    assert.equal(t.exchanges.length, 0, "no code was exchanged");
  } finally {
    await t.close();
  }
});

test("a cancelled, expired, replayed or wrong-nonce sign-in sets no session", async () => {
  const t = await app();
  try {
    const cancelled = await startSignIn(t);
    assert.equal((await t.get(`/auth/google/callback?error=access_denied&state=${cancelled.state}`, cancelled.binding)).status, 400);

    const expired = await startSignIn(t);
    t.tick(601);
    assert.equal((await t.get(`/auth/google/callback?code=c1&state=${expired.state}`, expired.binding)).status, 400);

    const good = await startSignIn(t);
    const first = await t.get(`/auth/google/callback?code=c1&state=${good.state}`, good.binding);
    assert.equal(first.status, 302);
    assert.equal((await t.get(`/auth/google/callback?code=c1&state=${good.state}`, good.binding)).status, 400, "replay");
    assert.equal(t.exchanges.length, 1);
  } finally {
    await t.close();
  }
  const wrongNonce = await app({ nonceOverride: "not-the-one-sent" });
  try {
    const { binding, state } = await startSignIn(wrongNonce);
    const res = await wrongNonce.get(`/auth/google/callback?code=c1&state=${state}`, binding);
    assert.equal(res.status, 400);
    assert.equal(sessionFrom(res), undefined);
  } finally {
    await wrongNonce.close();
  }
});

test("return_to is a relative path or '/': never another host", async () => {
  for (const [raw, expected] of [
    ["/oauth/authorize?client_id=c1&state=x", "/oauth/authorize?client_id=c1&state=x"],
    ["//evil.example/x", "/"],
    ["https://evil.example", "/"],
    ["/" + String.fromCharCode(92) + "evil.example", "/"],
    ["/ok path", "/"],
    ["javascript:alert(1)", "/"],
    ["", "/"],
    [undefined, "/"],
  ]) {
    assert.equal(safeReturnTo(raw), expected, JSON.stringify(raw));
  }
  const t = await app();
  try {
    const { binding, state } = await startSignIn(t, "//evil.example/steal");
    const res = await t.get(`/auth/google/callback?code=c1&state=${state}`, binding);
    assert.equal(res.headers.get("location"), "/");
    assert.equal(t.auth.signInUrl("https://evil.example"), "/auth/sign-in?return_to=%2F");
    assert.equal(t.auth.signInUrl("/oauth/authorize?a=1"), "/auth/sign-in?return_to=%2Foauth%2Fauthorize%3Fa%3D1");
  } finally {
    await t.close();
  }
});

test("owners are keyed by Google's sub: a changed email is the same owner; another sub is another owner", async () => {
  const store = new InMemoryOwnerStore();
  const a = await store.upsertOwner({ sub: "sub-1", email: "old@test.example" });
  const b = await store.upsertOwner({ sub: "sub-1", email: "new@test.example" });
  const c = await store.upsertOwner({ sub: "sub-2", email: "new@test.example" });
  assert.equal(a.id, b.id);
  assert.equal(b.email, "new@test.example");
  assert.notEqual(c.id, a.id);
});

test("a session ends at its TTL; sign-out needs this site's Origin and ends it at once", async () => {
  const t = await app();
  try {
    const { binding, state } = await startSignIn(t);
    const session = sessionFrom(await t.get(`/auth/google/callback?code=c1&state=${state}`, binding));
    assert.ok(await ownerFor(t, session));
    assert.equal((await t.post("/auth/sign-out", session)).status, 403, "no Origin");
    assert.equal((await t.post("/auth/sign-out", session, { origin: "https://evil.example" })).status, 403);
    assert.ok(await ownerFor(t, session), "a refused sign-out changes nothing");
    const out = await t.post("/auth/sign-out", session, { origin: HOST });
    assert.equal(out.status, 303);
    assert.match(out.headers.getSetCookie()[0], /^__Host-writ_session=; .*Max-Age=0$/);
    assert.equal(await ownerFor(t, session), null);

    const again = await startSignIn(t);
    const second = sessionFrom(await t.get(`/auth/google/callback?code=c1&state=${again.state}`, again.binding));
    t.tick(12 * 3600);
    assert.equal(await ownerFor(t, second), null, "expired");
  } finally {
    await t.close();
  }
});

test("a session cookie sent twice, or not at all, is no session", async () => {
  assert.equal(readCookie("a=1; __Host-writ_session=x; __Host-writ_session=y", SESSION_COOKIE), null);
  assert.equal(readCookie("a=1", SESSION_COOKIE), null);
  assert.equal(readCookie(undefined, SESSION_COOKIE), null);
  assert.equal(readCookie("a=1; __Host-writ_session=x", SESSION_COOKIE), "x");
  const t = await app();
  try {
    assert.equal(await ownerFor(t, undefined), null);
    assert.equal(await ownerFor(t, `${SESSION_COOKIE}=forged`), null);
    assert.equal((await t.get("/somewhere-else")).status, 404, "other routes are not handled");
  } finally {
    await t.close();
  }
});

test("a realistic ChatGPT authorize query survives sign-in as the return path; past the limit it is '/'", async () => {
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  const query = new URLSearchParams({
    response_type: "code",
    client_id: "2b7f1c9e-5d0a-4c3e-9f1b-7a6d5c4b3a29",
    redirect_uri: "https://chatgpt.com/connector/oauth/" + "c".repeat(64),
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "jobs.act",
    resource: "https://jobs.example.com/mcp",
    state: "s".repeat(2500),
  }).toString();
  const returnTo = `/oauth/authorize?${query}`;
  assert.ok(returnTo.length > 2048, "longer than the old limit");
  assert.equal(safeReturnTo(returnTo), returnTo);
  assert.equal(safeReturnTo("/" + "a".repeat(RETURN_TO_MAX)), "/", "past the limit, home");
  const t = await app();
  try {
    const { binding, state } = await startSignIn(t, returnTo);
    const res = await t.get(`/auth/google/callback?code=c1&state=${state}`, binding);
    assert.equal(res.headers.get("location"), returnTo);
  } finally {
    await t.close();
  }
});

test("the in-memory store drops expired pending sign-ins on each save, and keeps at most PENDING_SIGN_INS_MAX", async () => {
  const store = new InMemoryOwnerStore();
  const at = 1_800_000_000;
  const pending = (now) => ({ bindingHash: "b", codeVerifier: "v", nonce: "n", returnTo: "/", expiresAt: now + SIGN_IN_TTL_SECONDS });
  await store.savePendingSignIn("old", pending(at));
  await store.savePendingSignIn("fresh", pending(at + SIGN_IN_TTL_SECONDS - 1));
  assert.deepEqual([...store.pending.keys()], ["old", "fresh"], "not yet expired");
  await store.savePendingSignIn("later", pending(at + SIGN_IN_TTL_SECONDS));
  assert.deepEqual([...store.pending.keys()], ["fresh", "later"], "the expired one is gone");
  for (let i = 0; i < PENDING_SIGN_INS_MAX + 5; i += 1) await store.savePendingSignIn(`p${i}`, pending(at + SIGN_IN_TTL_SECONDS));
  assert.equal(store.pending.size, PENDING_SIGN_INS_MAX);
  assert.equal(store.pending.has("fresh"), false, "the oldest went first");
  assert.equal(store.pending.has(`p${PENDING_SIGN_INS_MAX + 4}`), true);
});
