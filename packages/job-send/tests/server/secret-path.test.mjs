import test from "node:test";
import assert from "node:assert/strict";

import { createSecretPath, InMemorySecretPaths, SECRET_PATH } from "../../dist/server/secret-path.js";
import { hashToken } from "../../dist/oauth/oauth.js";

import { CONN, HOST, start } from "./support/harness.mjs";

const mcpPost = (base, path, method, params = {}, headers = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });

/** A server with the fallback on, and one secret path for the harness connection. */
async function withSecretPath() {
  const secretPaths = new InMemorySecretPaths();
  const { url, secretHash } = createSecretPath(HOST);
  await secretPaths.add(secretHash, CONN.id);
  const app = await start({ secretPaths });
  return { app, secretPaths, secretHash, path: new URL(url).pathname };
}

test("a secret path is the host, /mcp/c/ and 43 random characters; only its hash is stored", async () => {
  const { url, secretHash } = createSecretPath(HOST);
  const path = new URL(url).pathname;
  assert.equal(url.startsWith(`${HOST}/mcp/c/`), true);
  const secret = SECRET_PATH.exec(path)[1];
  assert.equal(secret.length, 43);
  assert.equal(secretHash, hashToken(secret));
  assert.notEqual(createSecretPath(HOST).url, url, "fresh each time");
  assert.throws(() => createSecretPath("http://jobs.example.test"), TypeError);
});

test("the fallback serves MCP for the connection the secret names, with no bearer token and no challenge", async () => {
  const { app, secretPaths, secretHash, path } = await withSecretPath();
  try {
    const listed = await mcpPost(app.base, path, "tools/list");
    assert.equal(listed.status, 200);
    assert.equal((await listed.json()).result.tools.length, 4);
    const jobs = await (await mcpPost(app.base, path, "tools/call", { name: "list_jobs", arguments: {} })).json();
    assert.equal(jobs.result.structuredContent.jobs[0].job_id, "job_1");
    assert.deepEqual(app.calls, [["list_jobs", CONN.id]]);
    assert.equal([...secretPaths.connections.keys()].includes(secretHash), true);
    assert.equal([...secretPaths.connections.keys()].some((key) => path.includes(key)), false, "the secret itself is not a key");
  } finally {
    await app.close();
  }
});

test("a wrong, short, long or revoked secret, or a stopped connection, is not found, with no challenge", async () => {
  const { app, secretPaths, secretHash, path } = await withSecretPath();
  try {
    const secret = path.slice("/mcp/c/".length);
    const flipped = `${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}`;
    for (const bad of [`/mcp/c/${flipped}`, `/mcp/c/${secret.slice(1)}`, `/mcp/c/${secret}A`, `/mcp/c/${secret}/`, "/mcp/c/", `/mcp/x/${secret}`]) {
      const res = await mcpPost(app.base, bad, "tools/list");
      assert.equal(res.status, 404, bad.replace(secret, "<secret>"));
      assert.equal(res.headers.get("www-authenticate"), null);
    }
    app.stopped.add(CONN.id);
    assert.equal((await mcpPost(app.base, path, "tools/list")).status, 404, "a stopped connection");
    app.stopped.clear();
    await secretPaths.revoke(secretHash);
    assert.equal((await mcpPost(app.base, path, "tools/list")).status, 404, "revoked");
    assert.equal(app.calls.length, 0);
  } finally {
    await app.close();
  }
});

test("the fallback is off unless the server is given secret paths", async () => {
  const app = await start();
  try {
    const { url } = createSecretPath(HOST);
    assert.equal((await mcpPost(app.base, new URL(url).pathname, "tools/list")).status, 404);
  } finally {
    await app.close();
  }
});

test("the fallback is POST only, sends no CORS headers, and still checks tool arguments", async () => {
  const { app, path } = await withSecretPath();
  try {
    const get = await fetch(`${app.base}${path}`);
    assert.equal(get.status, 405);
    const listed = await mcpPost(app.base, path, "tools/list", {}, { origin: "https://evil.test" });
    assert.equal(listed.headers.get("access-control-allow-origin"), null);
    const extra = await (await mcpPost(app.base, path, "tools/call", { name: "propose_send", arguments: { job_id: "job_1", to: "dana@example.test", bcc: "eve@example.test" } })).json();
    assert.equal(extra.result.structuredContent.error, "invalid_arguments");
    assert.equal(app.calls.length, 0);
  } finally {
    await app.close();
  }
});
