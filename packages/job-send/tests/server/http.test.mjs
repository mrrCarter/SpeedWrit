import test from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { InMemoryOAuthStore } from "../../dist/server/store.js";
import { CHATGPT_REDIRECT, hashToken, unauthorizedChallenge } from "../../dist/oauth/oauth.js";
import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../../dist/mcp/tools.js";

import { CONN, HOST, JOB, NOW, RESOURCE, barrier, callTool, codeParams, connect, register, rpc, seedCode, start, token } from "./support/harness.mjs";

test("metadata: both protected-resource paths and the authorization server document", async () => {
  const app = await start();
  try {
    const resource = await (await fetch(`${app.base}/.well-known/oauth-protected-resource`)).json();
    const resourceMcp = await (await fetch(`${app.base}/.well-known/oauth-protected-resource/mcp`)).json();
    const server = await (await fetch(`${app.base}/.well-known/oauth-authorization-server`)).json();
    assert.deepEqual(resource, { resource: RESOURCE, authorization_servers: [HOST], scopes_supported: ["jobs.act"] });
    assert.deepEqual(resourceMcp, resource);
    assert.equal(server.issuer, HOST);
    assert.equal(server.token_endpoint, `${HOST}/oauth/token`);
    assert.deepEqual(server.code_challenge_methods_supported, ["S256"]);
    assert.equal((await fetch(`${app.base}/nothing-here`)).status, 404);
  } finally {
    await app.close();
  }
});

test("registration: a good client is stored; a bad redirect, a bidi name or a non-JSON body is refused", async () => {
  const app = await start();
  try {
    const ok = await register(app.base);
    assert.equal(ok.status, 201);
    assert.equal(ok.body.token_endpoint_auth_method, "none");
    assert.equal(app.store.clients.get(ok.body.client_id).client_name, "ChatGPT");
    assert.equal((await register(app.base, { redirect_uris: ["https://evil.test/cb"] })).body.error, "invalid_redirect_uri");
    const bidi = await register(app.base, { redirect_uris: [CHATGPT_REDIRECT], client_name: `Chat${String.fromCodePoint(0x202e)}TPG` });
    assert.equal(bidi.status, 400);
    assert.equal(bidi.body.error, "invalid_client_metadata");
    const notJson = await fetch(`${app.base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    assert.equal(notJson.status, 400);
    const form = await fetch(`${app.base}/oauth/register`, { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    assert.equal(form.status, 400);
    assert.equal(app.store.clients.size, 1, "nothing refused was stored");
  } finally {
    await app.close();
  }
});

test("token: a code redeems once, with no-store, for jobs.act; a second use is invalid_grant", async () => {
  const app = await start();
  try {
    const { client_id } = (await register(app.base)).body;
    const code = await seedCode(app.store, client_id);
    const first = await token(app.base, codeParams(client_id, code));
    assert.equal(first.status, 200);
    assert.equal(first.cache, "no-store");
    assert.equal(first.body.token_type, "Bearer");
    assert.equal(first.body.expires_in, 3600);
    assert.equal(first.body.scope, "jobs.act");
    assert.equal(app.store.access.has(hashToken(first.body.access_token)), true, "stored by hash");
    assert.equal(app.store.access.has(first.body.access_token), false, "never stored raw");
    const again = await token(app.base, codeParams(client_id, code));
    assert.equal(again.status, 400);
    assert.equal(again.body.error, "invalid_grant");
    assert.equal(again.cache, "no-store");
  } finally {
    await app.close();
  }
});

test("token: a wrong verifier, a repeated parameter or a JSON body is refused, and nothing is issued", async () => {
  const app = await start();
  try {
    const { client_id } = (await register(app.base)).body;
    const code = await seedCode(app.store, client_id);
    const wrong = await token(app.base, { ...codeParams(client_id, code), code_verifier: "x".repeat(43) });
    assert.equal(wrong.body.error, "invalid_grant");
    const repeated = `${new URLSearchParams(codeParams(client_id, code))}&client_id=other`;
    assert.equal((await token(app.base, repeated)).body.error, "invalid_request");
    const json = await token(app.base, JSON.stringify(codeParams(client_id, code)), "application/json");
    assert.equal(json.body.error, "invalid_request");
    assert.equal(app.store.access.size, 0);
    assert.equal((await token(app.base, codeParams(client_id, code))).status, 200, "the code was not burned by the refusals");
  } finally {
    await app.close();
  }
});

test("token: two concurrent redemptions of one code issue exactly one token pair", async () => {
  const app = await start({ store: barrier(new InMemoryOAuthStore(), "findCode", 2) });
  try {
    const { client_id } = (await register(app.base)).body;
    const code = await seedCode(app.store, client_id);
    const results = await Promise.all([token(app.base, codeParams(client_id, code)), token(app.base, codeParams(client_id, code))]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
    assert.equal(results.find((r) => r.status === 400).body.error, "invalid_grant");
    assert.equal(app.store.access.size, 1);
    assert.equal(app.store.refresh.size, 1);
  } finally {
    await app.close();
  }
});

test("refresh: rotation issues a new pair; presenting the old one again revokes the whole grant", async () => {
  const app = await start();
  try {
    const first = await connect(app.base, app.store);
    const refresh = { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: first.clientId };
    const second = await token(app.base, refresh);
    assert.equal(second.status, 200);
    assert.notEqual(second.body.access_token, first.access_token);
    assert.equal((await rpc(app.base, second.body.access_token, "tools/list")).status, 200);
    const replay = await token(app.base, refresh);
    assert.equal(replay.body.error, "invalid_grant");
    assert.equal((await rpc(app.base, second.body.access_token, "tools/list")).status, 401, "the replay revoked the newest token too");
    const next = await token(app.base, { ...refresh, refresh_token: second.body.refresh_token });
    assert.equal(next.body.error, "invalid_grant", "and the newest refresh token");
  } finally {
    await app.close();
  }
});

test("revoking a grant also voids the connection's unused codes", async () => {
  const app = await start();
  try {
    const first = await connect(app.base, app.store);
    const spare = await seedCode(app.store, first.clientId);
    const refresh = { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: first.clientId };
    assert.equal((await token(app.base, refresh)).status, 200);
    assert.equal((await token(app.base, refresh)).body.error, "invalid_grant", "the replay revokes");
    const late = await token(app.base, codeParams(first.clientId, spare));
    assert.equal(late.status, 400, "a code minted before the revoke cannot start a new grant");
    assert.equal(late.body.error, "invalid_grant");
  } finally {
    await app.close();
  }
});

test("refresh: two concurrent refreshes of one token issue one pair, and the loser revokes the grant", async () => {
  const store = new InMemoryOAuthStore();
  const app = await start({ store });
  try {
    const first = await connect(app.base, store);
    barrier(store, "findRefresh", 2);
    const refresh = { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: first.clientId };
    const results = await Promise.all([token(app.base, refresh), token(app.base, refresh)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 400]);
    const winner = results.find((r) => r.status === 200).body;
    assert.equal(store.access.size, 2, "the first pair and the winner's");
    assert.equal((await rpc(app.base, winner.access_token, "tools/list")).status, 401, "zero rows changed is treated as reuse");
  } finally {
    await app.close();
  }
});

test("/mcp: no token, a bad, expired or stopped one, or a token in the URL gets 401 with the challenge", async () => {
  const app = await start();
  try {
    const { access_token } = await connect(app.base, app.store);
    const none = await rpc(app.base, null, "tools/list");
    assert.equal(none.status, 401);
    assert.equal(none.challenge, unauthorizedChallenge(HOST));
    assert.equal((await rpc(app.base, "not-a-real-token", "tools/list")).status, 401);
    const inUrl = await fetch(`${app.base}/mcp?access_token=${access_token}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(inUrl.status, 401);
    const getNoToken = await fetch(`${app.base}/mcp`);
    assert.equal(getNoToken.status, 401, "authentication comes before the method check");
    const get = await fetch(`${app.base}/mcp`, { headers: { authorization: `Bearer ${access_token}` } });
    assert.equal(get.status, 405);
    assert.equal(get.headers.get("allow"), "POST");
    assert.equal((await rpc(app.base, access_token, "tools/list")).status, 200);
    app.stopped.add(CONN.id);
    assert.equal((await rpc(app.base, access_token, "tools/list")).status, 401, "a stopped connection");
    app.stopped.clear();
    app.clock.now = NOW + 3600;
    assert.equal((await rpc(app.base, access_token, "tools/list")).status, 401, "expired after one hour");
    assert.equal(app.calls.length, 0, "no backend call without a good token");
  } finally {
    await app.close();
  }
});

test("/mcp: the Authorization header is exactly one Bearer token; the scheme's case does not matter", async () => {
  const app = await start();
  try {
    const { access_token } = await connect(app.base, app.store);
    const list = (authorization) =>
      fetch(`${app.base}/mcp`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      });
    for (const bad of [`xBearer ${access_token}`, `Bearer ${access_token} extra`, `Bearer  ${access_token}`, `Bearer ${access_token},Bearer other`, `Basic ${access_token}`, access_token]) {
      assert.equal((await list(bad)).status, 401, bad.replace(access_token, "<token>"));
    }
    assert.equal((await list(`bearer ${access_token}`)).status, 200);
    assert.equal((await list(`BEARER ${access_token}`)).status, 200);
  } finally {
    await app.close();
  }
});

test("token and register: a body over 16 KiB gets 413", async () => {
  const app = await start();
  try {
    const big = await token(app.base, `grant_type=authorization_code&code=${"x".repeat(16 * 1024)}`);
    assert.equal(big.status, 413);
    const res = await fetch(`${app.base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [CHATGPT_REDIRECT], client_name: "x".repeat(16 * 1024) }),
    });
    assert.equal(res.status, 413);
    assert.equal(app.store.clients.size, 0);
  } finally {
    await app.close();
  }
});

test("/mcp: initialize carries the instructions; tools/list carries securitySchemes top level and in _meta", async () => {
  const app = await start();
  try {
    const { access_token } = await connect(app.base, app.store);
    const init = await rpc(app.base, access_token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    assert.equal(init.body.result.instructions, MCP_INSTRUCTIONS);
    assert.deepEqual(init.body.result.capabilities.tools, {});
    const { tools } = (await rpc(app.base, access_token, "tools/list")).body.result;
    assert.deepEqual(tools.map((t) => t.name), MCP_TOOLS.map((t) => t.name));
    for (const listed of tools) {
      const defined = MCP_TOOLS.find((t) => t.name === listed.name);
      assert.deepEqual(listed.securitySchemes, [{ type: "oauth2", scopes: ["jobs.act"] }]);
      assert.deepEqual(listed._meta.securitySchemes, listed.securitySchemes);
      assert.deepEqual(listed.annotations, defined.annotations);
      assert.deepEqual(listed.inputSchema, defined.inputSchema);
    }
  } finally {
    await app.close();
  }
});

test("/mcp: tools/call runs each tool for the token's connection and returns the result builders' output", async () => {
  const app = await start();
  try {
    const { access_token } = await connect(app.base, app.store);
    const call = { job_id: "job_1", to: "dana@example.test", fields: { first_name: "Dana" } };
    const sent = (await callTool(app.base, access_token, "propose_send", call)).body.result;
    assert.equal(sent.isError, false);
    assert.equal(sent.structuredContent.status, "sent");
    assert.match(sent.content[0].text, /^Sent to dana@example\.test\. .* 1 of 2 sends left\.$/);
    assert.deepEqual(app.calls[0], ["propose_send", call, "conn_1"]);
    const listed = (await callTool(app.base, access_token, "list_jobs", {})).body.result;
    assert.deepEqual(listed.structuredContent.jobs, [JOB]);
    const revised = (await callTool(app.base, access_token, "revise_proposal", { proposal_id: "prop_1", custom_subject: "Hi", custom_body: "Body" })).body.result;
    assert.equal(revised.structuredContent.status, "pending_approval");
    const status = (await callTool(app.base, access_token, "get_status", { proposal_id: "prop_1" })).body.result;
    assert.equal(status.structuredContent.status, "accepted");
    const missing = (await callTool(app.base, access_token, "get_status", { proposal_id: "prop_x" })).body.result;
    assert.equal(missing.isError, true);
    assert.equal(missing.structuredContent.error, "not_found");
  } finally {
    await app.close();
  }
});

test("/mcp: bad arguments never reach the backend; an unknown tool is a protocol error", async () => {
  const app = await start();
  try {
    const { access_token } = await connect(app.base, app.store);
    const extra = (await callTool(app.base, access_token, "propose_send", { job_id: "job_1", to: "dana@example.test", bcc: "eve@example.test" })).body.result;
    assert.equal(extra.isError, true);
    assert.equal(extra.structuredContent.error, "invalid_arguments");
    const long = (await callTool(app.base, access_token, "propose_send", { job_id: "job_1", to: "dana@example.test", custom_subject: "x".repeat(151), custom_body: "b" })).body.result;
    assert.equal(long.structuredContent.error, "invalid_arguments");
    const missing = (await callTool(app.base, access_token, "get_status", {})).body.result;
    assert.equal(missing.structuredContent.detail, "arguments.proposal_id is required");
    assert.equal(app.calls.length, 0);
    const unknown = (await callTool(app.base, access_token, "delete_everything", {})).body;
    assert.equal(unknown.error.code, -32602);
  } finally {
    await app.close();
  }
});

test("/mcp: a backend failure is an internal-error result that says not to resend", async () => {
  const app = await start({
    backend: {
      async proposeSend() {
        throw new Error("db down");
      },
    },
  });
  try {
    const { access_token } = await connect(app.base, app.store);
    const failed = (await callTool(app.base, access_token, "propose_send", { job_id: "job_1", to: "dana@example.test", fields: {} })).body.result;
    assert.equal(failed.isError, true);
    assert.equal(failed.structuredContent.error, "internal_error");
    assert.match(failed.content[0].text, /Do not resend/);
    assert.equal(failed.content[0].text.includes("db down"), false, "the cause stays on the server");
    assert.equal(app.errors[0].message, "db down");
  } finally {
    await app.close();
  }
});

test("/mcp: a body over the limit gets 413, and a non-JSON body a parse error", async () => {
  const app = await start();
  try {
    const { access_token } = await connect(app.base, app.store);
    const headers = { authorization: `Bearer ${access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };
    const big = await fetch(`${app.base}/mcp`, { method: "POST", headers, body: "x".repeat(1024 * 1024 + 1) });
    assert.equal(big.status, 413);
    const bad = await fetch(`${app.base}/mcp`, { method: "POST", headers, body: "{" });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, -32700);
  } finally {
    await app.close();
  }
});

test("/mcp: the SDK's own client connects with the bearer token, lists tools and calls one", async () => {
  const app = await start();
  try {
    const { access_token } = await connect(app.base, app.store);
    const client = new Client({ name: "interop", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${app.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${access_token}` } } }));
    assert.equal(client.getInstructions(), MCP_INSTRUCTIONS);
    assert.equal((await client.listTools()).tools.length, MCP_TOOLS.length);
    const result = await client.callTool({ name: "list_jobs", arguments: {} });
    assert.equal(result.structuredContent.jobs[0].job_id, "job_1");
    await client.close();
  } finally {
    await app.close();
  }
});

test("the server is its own entry point; the package root does not export it", async () => {
  const server = await import("@writ/job-send/server");
  assert.equal(typeof server.createJobSendServer, "function");
  assert.equal(typeof server.InMemoryOAuthStore, "function");
  const root = await import("@writ/job-send");
  assert.equal("createJobSendServer" in root, false);
  assert.equal("InMemoryOAuthStore" in root, false);
});
