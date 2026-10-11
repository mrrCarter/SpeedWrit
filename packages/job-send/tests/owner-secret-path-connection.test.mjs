import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { after, before } from "node:test";

import { hashToken } from "../dist/oauth/oauth.js";
import {
  InMemoryOAuthStore,
  PgSecretPaths,
  SECRET_PATH_CLIENT_ID,
  createApp,
  createJobSendHandler,
  createMcpBackend,
  createOwnerApi,
  createOwnerCore,
} from "../dist/server/index.js";
import { startPostgres } from "./executor-support/pg.mjs";
import { assertReceiptChain, makeExecutor, receiptsOf, seedJob } from "./executor-support/fixtures.mjs";

// The secret-path fallback on its own: when the agent can't finish OAuth, the owner makes the agent
// connection and its path in one step (POST /owner/agent-connections/secret-path-new), with no OAuth
// consent first. Real core, real MCP backend, real owner API and agent handler, on Postgres.

let db;
before(async () => {
  db = await startPostgres();
});
after(async () => {
  await db?.stop();
});

const HOST = "https://jobs.example.com";

/** One app (owner API first, then the agent handler) for a seeded owner; `fallback` is SECRET_PATH_FALLBACK. */
async function start({ fallback = true } = {}) {
  const seed = await seedJob(db.pool);
  const { executor } = makeExecutor(db.pool);
  const core = createOwnerCore({ pool: db.pool, executor, mcpUrl: `${HOST}/mcp` });
  const store = new InMemoryOAuthStore();
  const secretPaths = fallback ? new PgSecretPaths(db.pool) : undefined;
  const errors = [];
  const ownerApi = createOwnerApi({
    host: HOST,
    core,
    owners: { owner: async (req) => (req.headers["x-test-owner"] === seed.owner ? { id: seed.owner, email: "owner@example.com" } : null) },
    oauthStore: store,
    secretPaths,
    onError: (error) => errors.push(error),
  });
  const agent = createJobSendHandler({
    host: HOST,
    store,
    backend: createMcpBackend({ pool: db.pool, executor }),
    secretPaths,
    onError: (error) => errors.push(error),
    authorize: {
      owners: { owner: async () => null, signInUrl: () => "/" },
      createAgentConnection: async () => {
        throw new Error("no OAuth consent in these tests");
      },
      renderConsent: () => "",
    },
  });
  const handler = createApp({ handlers: [ownerApi], agent, onError: (error) => errors.push(error) });
  const server = createServer((req, res) => void handler(req, res));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const owner = (path, value) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: HOST, "x-test-owner": seed.owner }, body: JSON.stringify(value) });
  const toolsList = (path) =>
    fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
  const connectionsOf = async () =>
    (await db.pool.query("SELECT id, client_id, client_label, revoked_at FROM agent_connections WHERE owner_id = $1 AND id <> $2", [seed.owner, seed.agentConnection]))
      .rows;
  const close = () => new Promise((resolve) => server.close(resolve));
  return { seed, core, errors, owner, toolsList, connectionsOf, close };
}

test("secret-path-new: one step makes the agent connection and its path; the path serves /mcp until the owner revokes it", async () => {
  const app = await start();
  try {
    const res = await app.owner("/owner/agent-connections/secret-path-new", { client_label: "Grok (secret path)" });
    assert.equal(res.status, 200);
    const made = await res.json();
    assert.deepEqual(Object.keys(made).sort(), ["agent_connection_id", "receipt_id", "url"]);
    assert.match(made.url, /^https:\/\/jobs\.example\.com\/mcp\/c\/[A-Za-z0-9_-]{43}$/);
    const path = new URL(made.url).pathname;
    const secret = path.slice("/mcp/c/".length);

    const [row] = await app.connectionsOf();
    assert.deepEqual(
      { id: row.id, client_id: row.client_id, client_label: row.client_label, revoked_at: row.revoked_at },
      { id: made.agent_connection_id, client_id: SECRET_PATH_CLIENT_ID, client_label: "Grok (secret path)", revoked_at: null },
    );
    const { rows: paths } = await db.pool.query("SELECT secret_hash FROM oauth_secret_paths WHERE agent_connection_id = $1", [row.id]);
    assert.deepEqual(paths.map((p) => p.secret_hash), [hashToken(secret)], "only the secret's hash is stored, with the new connection");

    const receipts = await assertReceiptChain(db.pool, app.seed.owner);
    const connected = receipts.find((r) => r.id === made.receipt_id);
    assert.equal(connected.type, "AGENT_CONNECTED");
    assert.equal(connected.body.agent_connection, made.agent_connection_id);
    assert.equal(connected.body.client_label, "Grok (secret path)");
    assert.deepEqual(connected.body.detail, { client_id: SECRET_PATH_CLIENT_ID });
    assert.ok(!receipts.some((r) => r.payload.includes(secret)), "the secret is in no receipt");

    const listed = await app.toolsList(path);
    assert.equal(listed.status, 200, "the path acts as the new connection, with no OAuth");
    assert.ok((await listed.text()).includes("propose_send"));

    const revoked = await app.owner("/owner/agent-connections/revoke", { agent_connection_id: made.agent_connection_id });
    assert.equal(revoked.status, 200);
    assert.equal((await app.toolsList(path)).status, 404, "a revoked connection's path is not found");
    assert.deepEqual(app.errors, []);
  } finally {
    await app.close();
  }
});

test("secret-path-new: with the fallback off it is not found, and nothing is made", async () => {
  const app = await start({ fallback: false });
  try {
    const res = await app.owner("/owner/agent-connections/secret-path-new", { client_label: "Grok" });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "not_found" });
    assert.deepEqual(await app.connectionsOf(), []);
    assert.deepEqual((await receiptsOf(db.pool, app.seed.owner)).filter((r) => r.type === "AGENT_CONNECTED"), []);
  } finally {
    await app.close();
  }
});

test("secret-path-new: a blank label, or one with a control or format character, is invalid_client_label; one over 100 is refused by the schema", async () => {
  const app = await start();
  try {
    // A right-to-left override and a zero-width space, built here so this file holds no invisible character.
    const [rlo, zwsp] = [String.fromCodePoint(0x202e), String.fromCodePoint(0x200b)];
    for (const label of ["   ", `Grok${rlo}`, `Gr${zwsp}ok`, "Grok\nAdmin"]) {
      const res = await app.owner("/owner/agent-connections/secret-path-new", { client_label: label });
      assert.equal(res.status, 409, JSON.stringify(label));
      assert.deepEqual(await res.json(), { error: "invalid_client_label" });
    }
    const long = await app.owner("/owner/agent-connections/secret-path-new", { client_label: "g".repeat(101) });
    assert.equal(long.status, 400);
    assert.deepEqual(await app.connectionsOf(), [], "nothing was made, so no path either (a path needs its connection)");
  } finally {
    await app.close();
  }
});

test("createAgentConnection is one transaction: a path that can't be stored leaves no connection and no receipt", async () => {
  const app = await start();
  try {
    const before = (await receiptsOf(db.pool, app.seed.owner)).length;
    // Not a sha256 hex: the oauth_secret_paths CHECK refuses it after the connection row is written.
    await assert.rejects(app.core.createAgentConnection(app.seed.owner, SECRET_PATH_CLIENT_ID, "Grok", { secretHash: "not-a-hash" }));
    assert.deepEqual(await app.connectionsOf(), []);
    assert.equal((await receiptsOf(db.pool, app.seed.owner)).length, before);
    // The OAuth consent's way: its registered client, no path.
    const made = await app.core.createAgentConnection(app.seed.owner, "client-9", "ChatGPT (declared)");
    const [row] = await app.connectionsOf();
    assert.deepEqual([row.id, row.client_id], [made.agent_connection_id, "client-9"]);
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM oauth_secret_paths WHERE agent_connection_id = $1", [row.id])).rows[0].n, 0);
  } finally {
    await app.close();
  }
});
