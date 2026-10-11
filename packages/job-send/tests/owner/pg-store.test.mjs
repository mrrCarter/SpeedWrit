import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";

import { startPostgres } from "../executor-support/pg.mjs";
import { PgOwnerStore } from "../../dist/owner/pg-store.js";
import { createOwnerAuth, SESSION_COOKIE, SIGN_IN_COOKIE, SIGN_IN_TTL_SECONDS } from "../../dist/owner/signin.js";
import { hashToken } from "../../dist/oauth/oauth.js";

// The OwnerStore on real Postgres (0003): what survives a restart, and the one race the database decides,
// two callbacks taking one state.

let db;
before(async () => {
  db = await startPostgres({ poolSize: 8 });
});
after(async () => {
  await db?.stop();
});

const NOW = 1_800_000_000;
const pending = (expiresAt, returnTo = "/owner-app/") => ({
  bindingHash: hashToken(`binding-${expiresAt}`),
  codeVerifier: "v".repeat(43),
  nonce: "n1",
  returnTo,
  expiresAt,
});

test("a pending sign-in is taken once, even by two callbacks at the same moment", async () => {
  const store = new PgOwnerStore(db.pool);
  const state = hashToken("state-race");
  await store.savePendingSignIn(state, pending(NOW + SIGN_IN_TTL_SECONDS));
  const [a, b] = await Promise.all([store.takePendingSignIn(state), store.takePendingSignIn(state)]);
  assert.equal([a, b].filter(Boolean).length, 1);
  assert.deepEqual(a ?? b, pending(NOW + SIGN_IN_TTL_SECONDS));
  assert.equal(await store.takePendingSignIn(state), null);
});

test("saving drops the sign-ins already expired, and keeps at most pendingMax, oldest first", async () => {
  await db.pool.query("DELETE FROM owner_sign_ins");
  const store = new PgOwnerStore(db.pool, { pendingMax: 3 });
  await store.savePendingSignIn(hashToken("old"), pending(NOW));
  await store.savePendingSignIn(hashToken("fresh"), pending(NOW + SIGN_IN_TTL_SECONDS - 1));
  await store.savePendingSignIn(hashToken("later"), pending(NOW + SIGN_IN_TTL_SECONDS));
  const left = async () => (await db.pool.query("SELECT state_hash FROM owner_sign_ins")).rows.map((r) => r.state_hash).sort();
  assert.deepEqual(await left(), [hashToken("fresh"), hashToken("later")].sort(), "the expired one is gone");
  for (const name of ["p1", "p2", "p3"]) await store.savePendingSignIn(hashToken(name), pending(NOW + SIGN_IN_TTL_SECONDS + 1));
  assert.equal((await left()).length, 3);
  assert.equal((await left()).includes(hashToken("fresh")), false, "the oldest went first");
});

test("the database refuses a return path that is not this site's, and a malformed hash", async () => {
  const store = new PgOwnerStore(db.pool);
  for (const returnTo of ["https://evil.example/", "//evil.example/", "evil"]) {
    await assert.rejects(store.savePendingSignIn(hashToken(`r-${returnTo}`), pending(NOW + SIGN_IN_TTL_SECONDS, returnTo)), { code: "23514" }, returnTo);
  }
  await assert.rejects(store.savePendingSignIn("not-a-hash", pending(NOW + SIGN_IN_TTL_SECONDS)), { code: "23514" });
});

test("owners are keyed by Google sub: a new email is the same owner, another sub another owner", async () => {
  const store = new PgOwnerStore(db.pool);
  const a = await store.upsertOwner({ sub: "sub-pg-1", email: "old@test.example" });
  const b = await store.upsertOwner({ sub: "sub-pg-1", email: "new@test.example" });
  const c = await store.upsertOwner({ sub: "sub-pg-2", email: "new@test.example" });
  assert.equal(a.id, b.id);
  assert.equal(b.email, "new@test.example");
  assert.notEqual(c.id, a.id);
  const row = (await db.pool.query("SELECT google_sub, email, receipt_seq FROM owners WHERE id = $1", [a.id])).rows[0];
  assert.deepEqual(row, { google_sub: "sub-pg-1", email: "new@test.example", receipt_seq: 0 });
});

test("a session survives a new store on the same database (a restart), ends when deleted, and expired ones are pruned", async () => {
  const owner = await new PgOwnerStore(db.pool).upsertOwner({ sub: "sub-pg-session", email: "owner@test.example" });
  const first = new PgOwnerStore(db.pool);
  await first.saveSession(hashToken("session-1"), { ownerId: owner.id, expiresAt: NOW + 43200 });
  const restarted = new PgOwnerStore(db.pool);
  assert.deepEqual(await restarted.findSession(hashToken("session-1")), { owner, expiresAt: NOW + 43200 });
  // A session that ended before the next one starts is pruned when that one is saved.
  await restarted.saveSession(hashToken("session-2"), { ownerId: owner.id, expiresAt: NOW + 2 * 43200 + 1 });
  assert.equal(await restarted.findSession(hashToken("session-1")), null);
  await restarted.deleteSession(hashToken("session-2"));
  assert.equal(await restarted.findSession(hashToken("session-2")), null);
  assert.equal(await restarted.findSession(hashToken("never")), null);
});

test("the whole sign-in on Postgres: start, callback, session, and the session read back after a restart", async () => {
  const CLIENT = "cid.apps.googleusercontent.com";
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1" };
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  let nonce = "";
  let clock = NOW;
  const fetchImpl = async () => {
    const signing = `${b64({ alg: "RS256", kid: "k1" })}.${b64({ iss: "https://accounts.google.com", aud: CLIENT, sub: "sub-pg-flow", email: "Flow@Test.Example", email_verified: true, iat: clock, exp: clock + 3600, nonce })}`;
    return { ok: true, status: 200, json: async () => ({ id_token: `${signing}.${sign("RSA-SHA256", Buffer.from(signing), privateKey).toString("base64url")}` }) };
  };
  const make = () =>
    createOwnerAuth({ host: "https://jobs.example.com", google: { clientId: CLIENT, clientSecret: "s" }, store: new PgOwnerStore(db.pool), fetchImpl, jwks: { key: async () => jwk }, now: () => clock });
  const auth = make();
  const server = createServer((req, res) => void auth.handle(req, res).then((handled) => handled || (res.writeHead(404), res.end())));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const start = await fetch(`${base}/auth/sign-in?return_to=${encodeURIComponent("/owner-app/#/connect")}`, { redirect: "manual" });
    const google = new URL(start.headers.get("location"));
    nonce = google.searchParams.get("nonce");
    const binding = start.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith(`${SIGN_IN_COOKIE}=`));
    const callback = await fetch(`${base}/auth/google/callback?code=c1&state=${google.searchParams.get("state")}`, { redirect: "manual", headers: { cookie: binding } });
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), "/owner-app/#/connect");
    const session = callback.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith(`${SESSION_COOKIE}=`) && c.length > SESSION_COOKIE.length + 1);
    // A second process on the same database reads the same owner from the cookie.
    assert.deepEqual(await make().owner({ headers: { cookie: session } }), { id: (await db.pool.query("SELECT id FROM owners WHERE google_sub = 'sub-pg-flow'")).rows[0].id, email: "flow@test.example" });
    const replay = await fetch(`${base}/auth/google/callback?code=c1&state=${google.searchParams.get("state")}`, { redirect: "manual", headers: { cookie: binding } });
    assert.equal(replay.status, 400, "the state was spent");
    clock += 12 * 3600;
    assert.equal(await make().owner({ headers: { cookie: session } }), null, "and the session ends at its TTL");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
