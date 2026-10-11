// grokbot against the real SpeedWrit OAuth + MCP handler (in memory, on loopback): sign-in by
// dynamic registration, PKCE and a loopback redirect; token refresh; the secret path; refusals.
// HOST is https://speedwrit.test; a fetch shim routes it to the loopback server.
import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { createJobSendServer, createSecretPath, InMemoryOAuthStore, InMemorySecretPaths } from "@writ/job-send/server";

import { checkMcp, currentBearer, login, readTokens, waitForCallback, CLIENT_NAME } from "../dist/index.js";

const HOST = "https://speedwrit.test";
const OWNER = { id: "owner_1", email: "owner@speedwrit.test" };
const CALLBACK_PORT = 20000 + Math.floor(Math.random() * 20000);
const LOOPBACK = `http://127.0.0.1:${CALLBACK_PORT}/callback`;

const connections = new Map();
const secretPaths = new InMemorySecretPaths();
const fallbacks = [LOOPBACK];
let server;
let base;
let dir;

const backend = {
  async connection(id) {
    return connections.get(id) ?? null;
  },
  async listJobs() {
    return [];
  },
  async proposeSend() {
    throw new Error("not in this test");
  },
  async revise() {
    throw new Error("not in this test");
  },
  async getStatus() {
    return null;
  },
};

/** fetch, with the public HOST routed to the loopback server. */
const routed = (input, init) => fetch(input.startsWith(HOST) ? base + input.slice(HOST.length) : input, init);

/** The owner's browser: open the consent page, press Allow, follow the redirect to grokbot's loopback. */
async function ownerAllows(url) {
  const consent = await routed(url, { method: "GET", redirect: "manual" });
  assert.equal(consent.status, 200, "the consent page shows");
  const requestId = /name=request_id value="([^"]+)"/.exec(await consent.text())[1];
  const answer = await routed(`${HOST}/oauth/authorize`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: HOST },
    body: new URLSearchParams({ request_id: requestId, decision: "allow" }).toString(),
  });
  assert.equal(answer.status, 302);
  const location = answer.headers.get("location");
  assert.ok(location.startsWith(`${LOOPBACK}?`), "the code goes to grokbot's loopback redirect");
  const landed = await fetch(location);
  assert.match(await landed.text(), /grokbot is connected/);
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "grokbot-"));
  server = createJobSendServer({
    host: HOST,
    store: new InMemoryOAuthStore(),
    backend,
    redirectFallbacks: fallbacks,
    secretPaths,
    authorize: {
      owners: { owner: async () => OWNER, signInUrl: (returnTo) => returnTo },
      async createAgentConnection(ownerId, clientId, clientLabel) {
        const id = `ac_${connections.size + 1}`;
        connections.set(id, { id, owner_id: ownerId, client_id: clientId, client_label: clientLabel });
        return id;
      },
      renderConsent: (view) => `<form method=post action="/oauth/authorize"><input type=hidden name=request_id value="${view.requestId}"></form>`,
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test("grokbot signs in as its own client, gets its own agent connection, and lists SpeedWrit's tools", async () => {
  const file = join(dir, "tokens.json");
  const tokens = await login(routed, { origin: HOST, file, openUrl: ownerAllows, now: () => 1_000_000, port: CALLBACK_PORT, timeoutMs: 10000 });
  assert.equal(tokens.origin, HOST);
  assert.equal(tokens.expires_at, 1_000_000 + 3600);
  assert.equal((await stat(file)).mode & 0o777, 0o600, "the token file is owner-only");

  const [conn] = [...connections.values()];
  assert.equal(conn.client_label, CLIENT_NAME, "the owner's consent screen and the receipts name grokbot");

  const check = await checkMcp(routed, { url: `${HOST}/mcp`, bearer: tokens.access_token });
  assert.equal(check.ok, true, JSON.stringify(check));
  assert.equal(check.serverName, "speedwrit");
  assert.deepEqual(check.missing, []);
  assert.deepEqual([...check.tools].sort(), ["get_status", "list_jobs", "propose_send", "revise_proposal"]);

  // Near expiry: refresh, save the rotated pair, and the new bearer works.
  const before = await readTokens(file);
  const fresh = await currentBearer(routed, { file, origin: HOST, resource: `${HOST}/mcp`, now: before.expires_at - 10 });
  const afterRefresh = await readTokens(file);
  assert.notEqual(fresh, before.access_token);
  assert.equal(afterRefresh.access_token, fresh);
  assert.notEqual(afterRefresh.refresh_token, before.refresh_token, "the rotated refresh token is on disk");
  assert.equal((await checkMcp(routed, { url: `${HOST}/mcp`, bearer: fresh })).ok, true);
  // Still valid: no refresh, same token.
  assert.equal(await currentBearer(routed, { file, origin: HOST, resource: `${HOST}/mcp`, now: before.expires_at - 3000 }), fresh);
});

test("the secret path works with no bearer; a wrong one is not found", async () => {
  connections.set("ac_secret", { id: "ac_secret", owner_id: OWNER.id, client_id: "c", client_label: CLIENT_NAME });
  const { url, secretHash } = createSecretPath(HOST);
  await secretPaths.add(secretHash, "ac_secret");
  const ok = await checkMcp(routed, { url, bearer: null });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  const wrong = await checkMcp(routed, { url: `${HOST}/mcp/c/${"Z".repeat(43)}`, bearer: null });
  assert.equal(wrong.ok, false);
  assert.match(wrong.problem, /^404/);
});

test("no bearer: the 401 challenge, and doctor says to sign in", async () => {
  const check = await checkMcp(routed, { url: `${HOST}/mcp`, bearer: null });
  assert.equal(check.ok, false);
  assert.equal(check.status, 401);
  assert.match(check.problem, /grokbot login/);
});

test("a host without the loopback redirect refuses registration, and the error names the fix", async () => {
  const other = 20000 + ((CALLBACK_PORT + 7) % 20000);
  await assert.rejects(
    login(routed, { origin: HOST, file: join(dir, "never.json"), openUrl: () => assert.fail("no consent without registration"), now: () => 1, port: other, timeoutMs: 2000 }),
    /invalid_redirect_uri.*REDIRECT_FALLBACKS/,
  );
});

test("the loopback refuses an answer with the wrong state or from another issuer", async () => {
  for (const [query, problem] of [
    ["state=wrong&iss=https%3A%2F%2Fspeedwrit.test&code=c", /state/],
    ["state=s1&iss=https%3A%2F%2Fevil.test&code=c", /iss/],
    ["state=s1&iss=https%3A%2F%2Fspeedwrit.test&error=access_denied", /access_denied/],
  ]) {
    const waiting = waitForCallback({ port: 0, path: "/callback", state: "s1", issuer: HOST, timeoutMs: 5000 });
    const port = await waiting.ready;
    const rejected = assert.rejects(waiting.code, problem);
    await fetch(`http://127.0.0.1:${port}/callback?${query}`);
    await rejected;
  }
});
