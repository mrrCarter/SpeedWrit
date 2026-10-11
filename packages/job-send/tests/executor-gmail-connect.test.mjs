import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer } from "node:http";
import test, { after, before } from "node:test";

import { createTokenCustody } from "../dist/index.js";
import {
  GMAIL_CONNECT_COOKIE,
  GMAIL_SEND_SCOPE,
  GOOGLE_REVOKE_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  GmailTokenError,
  createGmailConnect,
  createGmailTokens,
} from "../dist/server/index.js";
import { startPostgres } from "./executor-support/pg.mjs";
import { assertReceiptChain, makeExecutor, receiptsOf, seedJob, typesOf } from "./executor-support/fixtures.mjs";

// Connect Gmail and the executor's Gmail access, against real Postgres and a fake Google that signs
// real RS256 ID tokens: the connect flow and every refusal, the sealed refresh token, access tokens
// from it, and disconnect (STOP, then revoke at Google, then delete the sealed token).

let db;
before(async () => {
  db = await startPostgres();
});
after(async () => {
  await db?.stop();
});

const HOST = "https://jobs.example.com";
const CLIENT = "client-123.apps.googleusercontent.com";
const GOOGLE = { clientId: CLIENT, clientSecret: "shh" };
const custody = createTokenCustody(randomBytes(32));
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: "k1" };
const jwks = { key: async (kid) => (kid === "k1" ? JWK : null) };
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** `promise`, or a rejection after `ms`: a regression that hangs fails here instead of keeping the file open. */
const within = (promise, ms = 2_000) => {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};

function idToken(claims) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "RS256", kid: "k1", typ: "JWT" });
  const body = b64({ iss: "https://accounts.google.com", aud: CLIENT, azp: CLIENT, iat: now, exp: now + 3600, email_verified: true, ...claims });
  return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
}

/** A fake Google token and revoke endpoint. `answer` shapes the next code exchange. */
function fakeGoogle() {
  const google = { calls: [], revoked: [], answer: {}, refreshFails: false, refreshHangs: false, refreshBodyHangs: false, revokeHangs: false, nonces: new Map() };
  google.fetchImpl = async (url, init) => {
    const form = new URLSearchParams(init?.body ?? "");
    google.calls.push({ url, form: Object.fromEntries(form), signal: init?.signal });
    const json = (status, value) => ({ ok: status < 300, status, json: async () => value });
    if (url === GOOGLE_REVOKE_ENDPOINT) {
      if (google.revokeHangs) return new Promise(() => {});
      google.revoked.push(form.get("token"));
      return json(200, {});
    }
    if (url !== GOOGLE_TOKEN_ENDPOINT) return json(404, {});
    if (form.get("grant_type") === "refresh_token") {
      if (google.refreshHangs) return new Promise(() => {});
      // The status line arrives and the body never does.
      if (google.refreshBodyHangs) return { ok: true, status: 200, json: () => new Promise(() => {}) };
      if (google.refreshFails) return json(400, { error: "invalid_grant" });
      return json(200, { access_token: `at-${google.calls.length}`, expires_in: 3600 });
    }
    const code = form.get("code");
    const { email = "dana.owner@gmail.com", scope = `openid email ${GMAIL_SEND_SCOPE}`, refresh = `rt-${code}`, nonce } = google.answer;
    return json(200, {
      id_token: idToken({ sub: `sub-${email}`, email, nonce: nonce ?? google.nonces.get(code) }),
      access_token: `at-code-${code}`,
      ...(refresh ? { refresh_token: refresh } : {}),
      scope,
      expires_in: 3600,
    });
  };
  return google;
}

async function start(overrides = {}) {
  const seed = await seedJob(db.pool);
  const google = fakeGoogle();
  const { executor } = makeExecutor(db.pool);
  const sessions = new Map([["s-owner", { id: seed.owner, email: "owner@example.com" }]]);
  const connect = createGmailConnect({
    host: HOST,
    google: GOOGLE,
    pool: db.pool,
    executor,
    custody,
    owners: {
      owner: async (req) => sessions.get(/(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1]) ?? null,
      signInUrl: (returnTo) => `/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`,
    },
    fetchImpl: google.fetchImpl,
    jwks,
    ...overrides,
  });
  const server = createServer(async (req, res) => {
    if (!(await connect.handle(req, res))) res.writeHead(418).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, cookie) => fetch(`${base}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} });

  /** Start a connect as the owner; returns what Google would be handed, and the browser's binding cookie. */
  async function begin(returnTo = "/owner-app/#connect") {
    const res = await get(`/auth/gmail/connect?return_to=${encodeURIComponent(returnTo)}`, "sid=s-owner");
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get("location"));
    const binding = /__Host-writ_gmail=([^;]+)/.exec(res.headers.get("set-cookie"))?.[1];
    return { location, params: location.searchParams, binding };
  }

  /** Google sends the browser back with a code for this state. */
  async function finish(started, { code = `c-${Math.random().toString(36).slice(2)}`, cookie, query = "" } = {}) {
    google.nonces.set(code, started.params.get("nonce"));
    const jar = cookie ?? `sid=s-owner; ${GMAIL_CONNECT_COOKIE}=${started.binding}`;
    return get(`/auth/gmail/callback?state=${encodeURIComponent(started.params.get("state"))}&code=${code}${query}`, jar);
  }

  const close = () => new Promise((resolve) => server.close(resolve));
  return { seed, google, executor, sessions, connect, get, begin, finish, close };
}

const gmailRows = async (owner) =>
  (await db.pool.query("SELECT * FROM connections WHERE owner_id = $1 AND account_email <> 'owner@example.com' ORDER BY created_at", [owner])).rows;

test("connect: openid email + gmail.send, offline, with consent; the sealed refresh token and CONNECTION_CREATED", async () => {
  const app = await start();
  try {
    const started = await app.begin();
    assert.equal(started.location.origin + started.location.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(started.params.get("scope"), `openid email ${GMAIL_SEND_SCOPE}`);
    assert.equal(started.params.get("access_type"), "offline");
    assert.equal(started.params.get("prompt"), "consent");
    assert.equal(started.params.get("code_challenge_method"), "S256");
    assert.equal(started.params.get("redirect_uri"), `${HOST}/auth/gmail/callback`);
    assert.ok(started.binding);

    const done = await app.finish(started, { code: "c-1" });
    assert.equal(done.status, 302);
    assert.equal(done.headers.get("location"), "/owner-app/#connect");
    assert.equal(done.headers.get("referrer-policy"), "no-referrer");
    assert.match(done.headers.get("set-cookie"), /__Host-writ_gmail=;.*Max-Age=0/);
    const exchange = app.google.calls.find((c) => c.form.grant_type === "authorization_code");
    assert.equal(exchange.form.code_verifier.length > 40, true, "PKCE verifier sent");

    const [row] = await gmailRows(app.seed.owner);
    assert.equal(row.account_email, "dana.owner@gmail.com", "the address comes from the verified ID token");
    assert.deepEqual(row.granted_scopes, ["openid", "email", GMAIL_SEND_SCOPE]);
    assert.match(row.refresh_token_enc, /^v1\./);
    assert.equal(row.refresh_token_enc.includes("rt-c-1"), false, "sealed, not stored in the clear");
    assert.equal(custody.open(row.id, row.refresh_token_enc), "rt-c-1");
    const receipts = await assertReceiptChain(db.pool, app.seed.owner);
    assert.deepEqual(typesOf(receipts), ["CONNECTION_CREATED"]);
    assert.deepEqual(receipts[0].body.detail, { connection: row.id, provider: "gmail", scopes: ["openid", "email", GMAIL_SEND_SCOPE], reconnected: false });
    assert.equal(JSON.stringify(receipts).includes("rt-c-1"), false);

    const again = await app.finish(started, { code: "c-2" });
    assert.equal(again.status, 400, "a state is used once");
  } finally {
    await app.close();
  }
});

test("connect refuses: no session, another browser, another owner, gmail.send left unticked, no refresh token, cancelled, a wrong nonce", async () => {
  const app = await start();
  try {
    const noSession = await app.get("/auth/gmail/connect?return_to=/x");
    assert.equal(noSession.status, 302);
    assert.equal(noSession.headers.get("location"), `/auth/sign-in?return_to=${encodeURIComponent("/auth/gmail/connect?return_to=/x")}`);

    assert.equal((await app.finish(await app.begin(), { cookie: "sid=s-owner; __Host-writ_gmail=forged" })).status, 400, "another browser");
    const stranger = await seedJob(db.pool);
    app.sessions.set("s-stranger", { id: stranger.owner, email: "x@example.com" });
    const s1 = await app.begin();
    assert.equal((await app.finish(s1, { cookie: `sid=s-stranger; ${GMAIL_CONNECT_COOKIE}=${s1.binding}` })).status, 400, "another owner");

    app.google.answer = { scope: "openid email" };
    const unticked = await app.finish(await app.begin(), { code: "c-unticked" });
    assert.equal(unticked.status, 400);
    assert.match(await unticked.text(), /not allowed to send email/);
    assert.deepEqual(app.google.revoked, ["rt-c-unticked"], "the useless grant is given back");

    app.google.answer = { refresh: null };
    assert.equal((await app.finish(await app.begin())).status, 400, "no refresh token");
    app.google.answer = {};
    assert.equal((await app.finish(await app.begin(), { query: "&error=access_denied" })).status, 400, "cancelled");
    app.google.answer = { nonce: "someone-elses" };
    assert.equal((await app.finish(await app.begin())).status, 400, "an ID token for another request");

    assert.deepEqual(await gmailRows(app.seed.owner), [], "nothing was connected");
    assert.deepEqual(await receiptsOf(db.pool, app.seed.owner), []);
  } finally {
    await app.close();
  }
});

test("access tokens come from the sealed refresh token and are reused; a revoked grant marks the connection needs_reconnect", async () => {
  const app = await start();
  try {
    await app.finish(await app.begin(), { code: "c-at" });
    const [row] = await gmailRows(app.seed.owner);
    const tokens = createGmailTokens({ pool: db.pool, custody, google: GOOGLE, fetchImpl: app.google.fetchImpl });
    const first = await tokens.accessToken(row.id);
    const refresh = app.google.calls.filter((c) => c.form.grant_type === "refresh_token");
    assert.equal(refresh.length, 1);
    assert.equal(refresh[0].form.refresh_token, "rt-c-at");
    assert.equal(await tokens.accessToken(row.id), first, "reused until near expiry");
    assert.equal(app.google.calls.filter((c) => c.form.grant_type === "refresh_token").length, 1);

    app.google.refreshFails = true;
    const fresh = createGmailTokens({ pool: db.pool, custody, google: GOOGLE, fetchImpl: app.google.fetchImpl });
    await assert.rejects(fresh.accessToken(row.id), (error) => error instanceof GmailTokenError && error.reason === "grant_revoked");
    assert.equal((await gmailRows(app.seed.owner))[0].status, "needs_reconnect");

    // Reconnecting the same address refreshes that connection and lifts needs_reconnect.
    app.google.refreshFails = false;
    await app.finish(await app.begin(), { code: "c-again" });
    const rows = await gmailRows(app.seed.owner);
    assert.equal(rows.length, 1, "the same connection, not a second one");
    assert.equal(rows[0].id, row.id);
    assert.equal(rows[0].status, "active");
    assert.equal(custody.open(row.id, rows[0].refresh_token_enc), "rt-c-again");
    assert.equal((await receiptsOf(db.pool, app.seed.owner)).at(-1).body.detail.reconnected, true);
  } finally {
    await app.close();
  }
});

test("disconnect: STOP first, then revoke at Google, then the sealed token is deleted; a reconnect never lifts STOP", async () => {
  const app = await start();
  try {
    await app.finish(await app.begin(), { code: "c-stop" });
    const [row] = await gmailRows(app.seed.owner);
    const tokens = createGmailTokens({ pool: db.pool, custody, google: GOOGLE, fetchImpl: app.google.fetchImpl });
    const { executor } = makeExecutor(db.pool, { revoke: tokens.revoke });
    const result = await executor.engageStop(row.id, app.seed.owner);
    assert.equal(result.revoked, true);
    assert.deepEqual(app.google.revoked, ["rt-c-stop"]);
    const [after] = await gmailRows(app.seed.owner);
    assert.equal(after.refresh_token_enc, null, "the sealed token is gone");
    assert.equal(after.status, "revoked");
    assert.equal(after.dispatch_enabled, false);
    assert.deepEqual(typesOf(await receiptsOf(db.pool, app.seed.owner)).slice(-3), ["STOP_ENGAGED", "PROVIDER_REVOKE_REQUESTED", "PROVIDER_REVOKE_RESULT"]);
    await assert.rejects(tokens.accessToken(row.id), (error) => error instanceof GmailTokenError && error.reason === "no_refresh_token");

    // A revoked connection is not reused: connecting again makes a new one.
    await app.finish(await app.begin(), { code: "c-new" });
    const rows = await gmailRows(app.seed.owner);
    assert.equal(rows.length, 2);
    // STOP (without revoke) on the new one, then reconnect: STOP stays.
    await db.pool.query("UPDATE connections SET dispatch_enabled = false, status = 'stopped' WHERE id = $1", [rows[1].id]);
    await app.finish(await app.begin(), { code: "c-after-stop" });
    const [, stopped] = await gmailRows(app.seed.owner);
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.dispatch_enabled, false);
  } finally {
    await app.close();
  }
});

test("a hung token endpoint is NOT SENT, never UNKNOWN; pending connects expire on the DB clock and are capped per owner", async () => {
  // The process clock is wrong (the epoch): the expiry still comes from the database clock.
  const app = await start({ now: () => 0 });
  try {
    const started = await app.begin();
    const [pending] = (await db.pool.query("SELECT (expires_at > clock_timestamp()) AS live FROM gmail_connect_pending WHERE owner_id = $1", [app.seed.owner])).rows;
    assert.equal(pending.live, true, "the expiry comes from the database clock");
    for (let i = 0; i < 6; i++) await app.begin();
    const { rows } = await db.pool.query("SELECT count(*)::int AS n FROM gmail_connect_pending WHERE owner_id = $1", [app.seed.owner]);
    assert.equal(rows[0].n, 5, "at most five connects in progress per owner");
    const first = await app.finish(started, { code: "c-dropped" });
    assert.equal(first.status, 400, "the oldest was dropped");
  } finally {
    await app.close();
  }

  const live = await start();
  try {
    await live.finish(await live.begin(), { code: "c-hang" });
    const [row] = await gmailRows(live.seed.owner);
    live.google.refreshHangs = true;
    const tokens = createGmailTokens({ pool: db.pool, custody, google: GOOGLE, fetchImpl: live.google.fetchImpl, tokenFetchTimeoutMs: 50 });
    await assert.rejects(within(tokens.accessToken(row.id)), (error) => error instanceof GmailTokenError && error.reason === "token_endpoint");
    const outcome = await within(tokens.mailProviderFor({ id: row.id, provider: "gmail", account_email: row.account_email }).send(new Uint8Array([1])));
    assert.deepEqual(outcome, { status: "not_sent", errorClass: "provider_auth" }, "no request was made, so nothing was sent");
  } finally {
    await live.close();
  }
});

test("a token answer whose body stalls, and a revoke Google never answers, end within the budget", { timeout: 10_000 }, async () => {
  const app = await start();
  try {
    await app.finish(await app.begin(), { code: "c-stall" });
    const [row] = await gmailRows(app.seed.owner);
    const tokens = createGmailTokens({ pool: db.pool, custody, google: GOOGLE, fetchImpl: app.google.fetchImpl, tokenFetchTimeoutMs: 50 });

    app.google.refreshBodyHangs = true;
    await assert.rejects(within(tokens.accessToken(row.id)), (error) => error instanceof GmailTokenError && error.reason === "token_endpoint");
    const refresh = app.google.calls.at(-1);
    assert.equal(refresh.form.grant_type, "refresh_token");
    assert.equal(refresh.signal?.aborted, true, "the stalled request is aborted, not left open");

    app.google.revokeHangs = true;
    await assert.rejects(within(tokens.revoke({ id: row.id, provider: "gmail", account_email: row.account_email })), GmailTokenError);
    assert.equal(app.google.calls.at(-1).signal?.aborted, true);
    const [kept] = await gmailRows(app.seed.owner);
    assert.ok(kept.refresh_token_enc, "a revoke that didn't happen keeps the sealed token, so the owner can retry");
  } finally {
    await app.close();
  }
});
