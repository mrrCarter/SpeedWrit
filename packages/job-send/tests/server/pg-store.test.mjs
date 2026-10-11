import test, { after, before } from "node:test";
import assert from "node:assert/strict";

import { startPostgres } from "../executor-support/pg.mjs";
import { PgOAuthStore, PgSecretPaths } from "../../dist/server/pg-store.js";
import { createSecretPath } from "../../dist/server/secret-path.js";
import { CHATGPT_REDIRECT, hashToken } from "../../dist/oauth/oauth.js";

import { CHALLENGE, CONN, HOST, NOW, RESOURCE, codeParams, register, rpc, start, token } from "./support/harness.mjs";

// The OAuthStore on real Postgres, with separate connections from one pool, so the races are
// decided by the database: one code redemption, one refresh rotation, one take of a pending request.

let db;
let store;
before(async () => {
  db = await startPostgres({ poolSize: 12 });
  store = new PgOAuthStore(db.pool);
  // The harness server's owner (sid=dana -> own_1) and the connection its consent creates (conn_1).
  await db.pool.query("INSERT INTO owners (id, google_sub, email) VALUES ('own_1', 'sub-own_1', 'owner@example.test')");
  await db.pool.query("INSERT INTO agent_connections (id, owner_id, client_id, client_label) VALUES ($1, 'own_1', 'cli', 'ChatGPT')", [CONN.id]);
});
after(async () => {
  await db?.stop();
});

let serial = 0;
/** A fresh client and agent connection, so each test owns its rows. */
async function seed() {
  const n = ++serial;
  const owner = `own_t${n}`;
  const connection = `conn_t${n}`;
  const clientId = `cli_t${n}`;
  await db.pool.query("INSERT INTO owners (id, google_sub, email) VALUES ($1, $2, 'owner@example.test')", [owner, `sub-${owner}`]);
  await db.pool.query("INSERT INTO agent_connections (id, owner_id, client_id, client_label) VALUES ($1, $2, $3, 'ChatGPT')", [connection, owner, clientId]);
  await store.saveClient({ client_id: clientId, client_name: "ChatGPT", redirect_uris: [CHATGPT_REDIRECT], created_at: NOW });
  return { owner, connection, clientId };
}

const code = (s, overrides = {}) => ({
  client_id: s.clientId,
  redirect_uri: CHATGPT_REDIRECT,
  code_challenge: CHALLENGE,
  resource: RESOURCE,
  scope: "jobs.act",
  agent_connection_id: s.connection,
  expires_at: NOW + 60,
  used_at: null,
  ...overrides,
});

const grant = (s, consume) => ({
  ok: true,
  agent_connection_id: s.connection,
  scope: "jobs.act",
  resource: RESOURCE,
  access_expires_at: NOW + 3600,
  refresh_expires_at: NOW + 30 * 24 * 3600,
  consume,
});

const issued = (s, consume, tag) => ({ accessHash: hashToken(`a-${tag}`), refreshHash: hashToken(`r-${tag}`), client_id: s.clientId, grant: grant(s, consume) });

test("clients, codes and pending requests round-trip exactly, times in whole seconds", async () => {
  const s = await seed();
  assert.deepEqual(await store.getClient(s.clientId), { client_id: s.clientId, client_name: "ChatGPT", redirect_uris: [CHATGPT_REDIRECT], created_at: NOW });
  assert.equal(await store.getClient("nobody"), null);
  await store.saveCode(hashToken("c1"), code(s));
  assert.deepEqual(await store.findCode(hashToken("c1")), code(s));
  assert.equal(await store.findCode(hashToken("c2")), null);
  const pending = {
    owner_id: s.owner,
    client_id: s.clientId,
    client_name: "ChatGPT",
    redirect_uri: CHATGPT_REDIRECT,
    code_challenge: CHALLENGE,
    scope: "jobs.act",
    resource: RESOURCE,
    state: null,
    expires_at: NOW + 600,
  };
  await store.savePending(hashToken("req1"), pending);
  assert.deepEqual(await store.takePending(hashToken("req1")), pending);
  assert.equal(await store.takePending(hashToken("req1")), null, "taken once");
});

test("four concurrent redemptions of one code: one issues, and only its tokens exist", async () => {
  const s = await seed();
  await store.saveCode(hashToken("race"), code(s));
  const results = await Promise.all([0, 1, 2, 3].map((i) => store.redeem(hashToken("race"), issued(s, "code", `race${i}`), NOW)));
  assert.deepEqual(results.filter(Boolean).length, 1);
  const { rows } = await db.pool.query("SELECT count(*)::int AS n FROM access_tokens WHERE agent_connection_id = $1", [s.connection]);
  assert.equal(rows[0].n, 1);
  assert.equal((await store.findCode(hashToken("race"))).used_at, NOW);
});

test("an expired code or refresh token is not consumed, even if the caller's check passed", async () => {
  const s = await seed();
  await store.saveCode(hashToken("old"), code(s, { expires_at: NOW + 60 }));
  assert.equal(await store.redeem(hashToken("old"), issued(s, "code", "old"), NOW + 60), false);
  assert.equal((await store.findCode(hashToken("old"))).used_at, null, "nothing changed");
  await store.saveCode(hashToken("fresh"), code(s));
  assert.equal(await store.redeem(hashToken("fresh"), issued(s, "code", "fresh"), NOW), true);
  const late = { ...issued(s, "refresh", "late") };
  assert.equal(await store.redeem(hashToken("r-fresh"), late, NOW + 30 * 24 * 3600), false);
});

test("four concurrent rotations of one refresh token: one issues", async () => {
  const s = await seed();
  await store.saveCode(hashToken("seed"), code(s));
  assert.equal(await store.redeem(hashToken("seed"), issued(s, "code", "seed"), NOW), true);
  const results = await Promise.all([0, 1, 2, 3].map((i) => store.redeem(hashToken("r-seed"), issued(s, "refresh", `rot${i}`), NOW + 10)));
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal((await store.findRefresh(hashToken("r-seed"))).rotated_at, NOW + 10);
});

test("four concurrent takes of one pending request: one gets it", async () => {
  const s = await seed();
  await store.savePending(hashToken("req-race"), {
    owner_id: s.owner,
    client_id: s.clientId,
    client_name: "ChatGPT",
    redirect_uri: CHATGPT_REDIRECT,
    code_challenge: CHALLENGE,
    scope: "jobs.act",
    resource: RESOURCE,
    state: "st",
    expires_at: NOW + 600,
  });
  const taken = await Promise.all([0, 1, 2, 3].map(() => store.takePending(hashToken("req-race"))));
  assert.equal(taken.filter(Boolean).length, 1);
});

test("revoking a connection revokes its tokens and voids its unused codes, and nothing of another connection", async () => {
  const a = await seed();
  const b = await seed();
  await store.saveCode(hashToken("a-used"), code(a));
  assert.equal(await store.redeem(hashToken("a-used"), issued(a, "code", "a"), NOW), true);
  await store.saveCode(hashToken("a-spare"), code(a));
  await store.saveCode(hashToken("b-used"), code(b));
  assert.equal(await store.redeem(hashToken("b-used"), issued(b, "code", "b"), NOW), true);
  await store.revokeAgentConnection(a.connection, NOW + 5);
  assert.equal((await store.findAccess(hashToken("a-a"))).revoked_at, NOW + 5);
  assert.equal((await store.findRefresh(hashToken("r-a"))).revoked_at, NOW + 5);
  assert.equal((await store.findCode(hashToken("a-spare"))).used_at, NOW + 5);
  assert.equal((await store.findCode(hashToken("a-used"))).used_at, NOW, "a used code keeps its time");
  assert.equal((await store.findAccess(hashToken("a-b"))).revoked_at, null);
  assert.equal((await store.findRefresh(hashToken("r-b"))).revoked_at, null);
});

test("the whole connection over HTTP on Postgres: consent, code, token, /mcp, then a refresh replay revokes", async () => {
  const app = await start({ store });
  try {
    const { client_id } = (await register(app.base)).body;
    const query = new URLSearchParams({
      response_type: "code",
      client_id,
      redirect_uri: CHATGPT_REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      scope: "jobs.act",
      resource: RESOURCE,
      state: "st_pg",
    });
    const consent = await fetch(`${app.base}/oauth/authorize?${query}`, { headers: { cookie: "sid=dana" }, redirect: "manual" });
    assert.equal(consent.status, 200);
    const allowed = await fetch(`${app.base}/oauth/authorize`, {
      method: "POST",
      headers: { cookie: "sid=dana", origin: HOST, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: app.views[0].requestId, decision: "allow" }),
      redirect: "manual",
    });
    const back = new URL(allowed.headers.get("location"));
    assert.equal(back.searchParams.get("state"), "st_pg");
    const first = await token(app.base, codeParams(client_id, back.searchParams.get("code")));
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal((await rpc(app.base, first.body.access_token, "tools/list")).status, 200);
    const refresh = { grant_type: "refresh_token", refresh_token: first.body.refresh_token, client_id };
    const second = await token(app.base, refresh);
    assert.equal(second.status, 200);
    assert.equal((await token(app.base, refresh)).body.error, "invalid_grant", "the replay");
    assert.equal((await rpc(app.base, second.body.access_token, "tools/list")).status, 401, "revoked on Postgres too");
  } finally {
    await app.close();
  }
});

/** A pool whose transactions stop at COMMIT until released: `reached` resolves when one gets there. */
function heldAtCommit(pool) {
  let release;
  let reached;
  const gate = new Promise((resolve) => (release = resolve));
  const atCommit = new Promise((resolve) => (reached = resolve));
  const held = {
    query: (text, values) => pool.query(text, values),
    async connect() {
      const client = await pool.connect();
      return {
        query: async (text, values) => {
          if (text === "COMMIT") {
            reached();
            await gate;
          }
          return client.query(text, values);
        },
        release: (error) => client.release(error),
      };
    },
  };
  return { held, release, atCommit };
}

/** Waits until some backend is blocked on a row lock while running `fragment`, or until `done` settles, up to 2 s. */
async function untilWaiting(fragment, done) {
  let settled = false;
  done.then(
    () => (settled = true),
    () => (settled = true),
  );
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline && !settled) {
    const { rows } = await db.pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND position($1 in query) > 0", [fragment]);
    if (rows[0].n > 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

const liveTokens = async (connection) =>
  (
    await db.pool.query(
      `SELECT 'access' AS kind FROM access_tokens WHERE agent_connection_id = $1 AND revoked_at IS NULL
       UNION ALL SELECT 'refresh' FROM refresh_tokens WHERE agent_connection_id = $1 AND revoked_at IS NULL`,
      [connection],
    )
  ).rows.map((row) => row.kind);

test("a revoke during a refresh in flight waits for it, then revokes its new pair too (Bundle, #531)", async () => {
  const s = await seed();
  await store.saveCode(hashToken("race-a"), code(s));
  assert.equal(await store.redeem(hashToken("race-a"), issued(s, "code", "race-a"), NOW), true);
  const { held, release, atCommit } = heldAtCommit(db.pool);
  // The real client's refresh: rotated and its new pair inserted, not yet committed.
  const redeeming = new PgOAuthStore(held).redeem(hashToken("r-race-a"), issued(s, "refresh", "race-a2"), NOW + 1);
  await atCommit;
  // The replay's revoke, meanwhile.
  const revoking = store.revokeAgentConnection(s.connection, NOW + 2);
  let waited;
  try {
    waited = await untilWaiting("FROM agent_connections WHERE id = $1 FOR UPDATE", revoking);
  } finally {
    // Always let the held transaction finish, so a failing assertion cannot hang the run.
    release();
  }
  assert.equal(await redeeming, true);
  await revoking;
  assert.deepEqual(await liveTokens(s.connection), [], "no token outlives the revoke");
  assert.equal(waited, true, "the revoke waited for the redeem");
});

test("a refresh during a revoke in flight waits for it, then mints nothing", async () => {
  const s = await seed();
  await store.saveCode(hashToken("race-b"), code(s));
  assert.equal(await store.redeem(hashToken("race-b"), issued(s, "code", "race-b"), NOW), true);
  const { held, release, atCommit } = heldAtCommit(db.pool);
  const revoking = new PgOAuthStore(held).revokeAgentConnection(s.connection, NOW + 1);
  await atCommit;
  const redeeming = store.redeem(hashToken("r-race-b"), issued(s, "refresh", "race-b2"), NOW + 2);
  let waited;
  try {
    waited = await untilWaiting("FROM agent_connections WHERE id = $1 FOR SHARE", redeeming);
  } finally {
    release();
  }
  await revoking;
  assert.equal(await redeeming, false, "the revoked refresh token cannot be redeemed");
  assert.deepEqual(await liveTokens(s.connection), []);
  assert.equal(waited, true, "the redeem waited for the revoke");
});

test("a redeem for an agent connection the owner revoked mints nothing", async () => {
  const s = await seed();
  await store.saveCode(hashToken("gone"), code(s));
  await db.pool.query("UPDATE agent_connections SET revoked_at = now() WHERE id = $1", [s.connection]);
  assert.equal(await store.redeem(hashToken("gone"), issued(s, "code", "gone"), NOW), false);
  assert.equal((await store.findCode(hashToken("gone"))).used_at, null, "nothing consumed either");
  assert.deepEqual(await liveTokens(s.connection), []);
});

test("the secret-path fallback on Postgres: only the hash is stored, and the path serves until it is revoked", async () => {
  const secretPaths = new PgSecretPaths(db.pool);
  const { url, secretHash } = createSecretPath(HOST);
  const path = new URL(url).pathname;
  const secret = path.slice("/mcp/c/".length);
  await secretPaths.add(secretHash, CONN.id);
  assert.equal(await secretPaths.connectionFor(secretHash), CONN.id);
  assert.equal(await secretPaths.connectionFor("0".repeat(64)), null);
  const { rows } = await db.pool.query("SELECT secret_hash FROM oauth_secret_paths");
  assert.equal(rows.some((row) => row.secret_hash === secret), false, "the secret itself is never stored");
  const app = await start({ store, secretPaths });
  try {
    const list = () =>
      fetch(`${app.base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
    assert.equal((await list()).status, 200);
    await secretPaths.revoke(secretHash);
    assert.equal((await list()).status, 404);
  } finally {
    await app.close();
  }
});
