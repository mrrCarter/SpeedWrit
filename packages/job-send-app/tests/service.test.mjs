import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CHATGPT_REDIRECT, exportRawPublicKey, hashToken, receiptKeyId } from "@writ/job-send";
import { PgOAuthStore } from "@writ/job-send/server";
import { startPostgres } from "../../job-send/tests/executor-support/pg.mjs";
import { CHALLENGE, codeParams, token } from "../../job-send/tests/server/support/harness.mjs";
import { loadConfig } from "../dist/config.mjs";
import { startService } from "../dist/service.mjs";

// The whole service booted on real Postgres: every route family answers, in the spec's handler order,
// with the stores and core it is wired to. Google is never called here (sign-in only builds a URL).

const HOST = "https://jobs.example.test";

/** A built owner app as build:app writes it, compiled for the receipt key `keyId`. */
function ownerAppDir(keyId) {
  const dir = mkdtempSync(join(tmpdir(), "owner-app-"));
  writeFileSync(join(dir, "index.html"), '<!doctype html><script type="module" src="/owner-app/app.js"></script>');
  writeFileSync(join(dir, "app.js"), "console.log('owner app');");
  writeFileSync(join(dir, "receipt-key.json"), JSON.stringify({ key_id: keyId, public_key_b64url: "unused-here" }));
  return dir;
}

let db;
let service;
let base;
const signingKey = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const lines = [];
const errors = [];
const fetched = [];

before(async () => {
  db = await startPostgres({ poolSize: 12 });
  const config = loadConfig({
    HOST,
    DATABASE_URL: "postgres://injected.invalid/jobsend",
    GOOGLE_CLIENT_ID: "client-id.apps.example.test",
    GOOGLE_CLIENT_SECRET: `secret-${randomBytes(6).toString("hex")}`,
    RECEIPT_SIGNING_KEY: signingKey,
    CUSTODY_KEY: randomBytes(32).toString("base64"),
    OWNER_APP_DIR: ownerAppDir(receiptKeyId(exportRawPublicKey(signingKey))),
    SECRET_PATH_FALLBACK: "on",
    OWNER_APP_CONTACTS: JSON.stringify([{ name: "Dana", email: "dana@test.example", company: "Acme" }]),
  });
  service = await startService(config, {
    pool: db.pool,
    fetchImpl: async (url) => {
      fetched.push(String(url));
      throw new Error("no network in this test");
    },
    log: (line) => lines.push(line),
    onError: (error) => errors.push(error),
  });
  await new Promise((resolve) => service.server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${service.server.address().port}`;
});

after(async () => {
  await service?.stop();
  await db?.stop();
});

test("health, the OAuth metadata and the 401s answer", async () => {
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true });
  const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(meta.issuer, HOST);
  assert.equal(meta.authorization_endpoint, `${HOST}/oauth/authorize`);
  const mcp = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(mcp.status, 401);
  assert.equal(mcp.headers.get("www-authenticate"), `Bearer resource_metadata="${HOST}/.well-known/oauth-protected-resource"`);
  assert.deepEqual(await (await fetch(`${base}/owner/me`)).json(), { error: "sign_in" });
});

test("the owner app is served under its CSP, and / leads to it", async () => {
  const page = await fetch(`${base}/owner-app/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'/);
  const config = await (await fetch(`${base}/owner-app/config.json`)).json();
  assert.equal(config.jobDefaults.templateId, "tpl_recap", "the demo template was seeded and wired");
  assert.equal(config.connectGmailHref, "/auth/gmail/connect");
  assert.deepEqual(config.contacts, [{ name: "Dana", email: "dana@test.example", company: "Acme" }]);
  const home = await fetch(`${base}/`, { redirect: "manual" });
  assert.equal(home.status, 302);
});

test("sign-in and Connect Gmail start their Google flows; Connect Gmail needs a session first", async () => {
  const signIn = await fetch(`${base}/auth/sign-in?return_to=/owner-app/`, { redirect: "manual" });
  assert.equal(signIn.status, 302);
  const google = new URL(signIn.headers.get("location"));
  assert.equal(google.hostname, "accounts.google.com");
  assert.equal(google.searchParams.get("redirect_uri"), `${HOST}/auth/google/callback`);
  const gmail = await fetch(`${base}/auth/gmail/connect`, { redirect: "manual" });
  assert.equal(gmail.status, 302);
  assert.match(gmail.headers.get("location"), /^\/auth\/sign-in\?return_to=/);
  assert.deepEqual(fetched, [], "nothing reached Google");
});

test("registration writes to Postgres, and an unknown secret path is not found", async () => {
  const res = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"], client_name: "ChatGPT" }),
  });
  assert.equal(res.status, 201);
  const { client_id } = await res.json();
  const { rows } = await db.pool.query("SELECT client_name FROM oauth_clients WHERE client_id = $1", [client_id]);
  assert.equal(rows[0].client_name, "ChatGPT");
  const secretPath = `/mcp/c/${"S".repeat(43)}`;
  assert.equal((await fetch(`${base}${secretPath}`, { method: "POST" })).status, 404);
  assert.equal(lines.some((line) => line.includes("S".repeat(43))), false, "the access log never holds a secret path");
  assert.deepEqual(errors, []);
});

test("A19 through the composed service: no issued token appears in a log line, an error or an MCP answer", async () => {
  // A real code exchange and refresh on Postgres, then the access token used on /mcp. Every log line,
  // every error and every answer is then scanned for the three token strings.
  await db.pool.query("INSERT INTO owners (id, google_sub, email) VALUES ('own_a19', 'sub-own_a19', 'a19@example.test')");
  await db.pool.query("INSERT INTO agent_connections (id, owner_id, client_id, client_label) VALUES ('conn_a19', 'own_a19', 'cli_a19', 'ChatGPT')");
  const registered = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [CHATGPT_REDIRECT], client_name: "ChatGPT" }),
  });
  const { client_id } = await registered.json();
  const code = `code_${randomBytes(16).toString("hex")}`;
  await new PgOAuthStore(db.pool).saveCode(hashToken(code), {
    client_id,
    redirect_uri: CHATGPT_REDIRECT,
    code_challenge: CHALLENGE,
    resource: `${HOST}/mcp`,
    scope: "jobs.act",
    agent_connection_id: "conn_a19",
    expires_at: Math.floor(Date.now() / 1000) + 60,
    used_at: null,
  });
  const answers = [];
  const first = await token(base, { ...codeParams(client_id, code), resource: `${HOST}/mcp` });
  // The token endpoint's own answer carries the tokens by design; it is not scanned.
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const second = await token(base, { grant_type: "refresh_token", refresh_token: first.body.refresh_token, client_id, resource: `${HOST}/mcp` });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const secrets = [first.body.access_token, first.body.refresh_token, second.body.access_token, second.body.refresh_token];
  assert.ok(secrets.every((s) => typeof s === "string" && s.length > 20));
  for (const [method, params] of [["tools/list", {}], ["tools/call", { name: "list_jobs", arguments: {} }]]) {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${second.body.access_token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    assert.equal(res.status, 200, method);
    answers.push(await res.text());
  }
  // A token in a query string must not reach the log either: the access log records the path only.
  answers.push(await (await fetch(`${base}/mcp?access_token=${second.body.access_token}`)).text());
  assert.ok(lines.some((line) => line.includes("/oauth/token")), "the access log is on, so the scan can find something");
  // Tokens are base64url, so joining with a space cannot make or hide a match.
  const everything = [...lines, ...answers, ...errors.map((e) => String(e?.stack ?? e))].join(" ");
  for (const secret of secrets) assert.equal(everything.includes(secret), false, "a token string leaked");
});

test("the boot line names the receipt signing key's id, so the owner app's verify key can be checked against it", () => {
  const expected = receiptKeyId(exportRawPublicKey(signingKey));
  assert.match(expected, /^[0-9a-f]{16}$/);
  assert.equal(service.receiptKeyId, expected);
  assert.equal(lines[0], `receipt signing key ${expected}`, "the first line, before any request");
  assert.equal(lines.some((line) => line.includes("PRIVATE KEY")), false);
});

test("an owner app built for another receipt key refuses to start with a rebuild instruction", async () => {
  const config = loadConfig({
    HOST,
    DATABASE_URL: "postgres://injected.invalid/jobsend",
    GOOGLE_CLIENT_ID: "client-id.apps.example.test",
    GOOGLE_CLIENT_SECRET: `secret-${randomBytes(6).toString("hex")}`,
    RECEIPT_SIGNING_KEY: signingKey,
    CUSTODY_KEY: randomBytes(32).toString("base64"),
    OWNER_APP_DIR: ownerAppDir("0000000000000000"),
  });
  await assert.rejects(startService(config, { pool: db.pool, log: () => {}, onError: () => {} }), /built for receipt key 0000000000000000, but this service signs with [0-9a-f]{16}; rebuild it with build:app/);
});
