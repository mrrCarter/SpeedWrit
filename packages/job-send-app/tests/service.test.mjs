import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CHATGPT_REDIRECT, exportRawPublicKey, hashToken, receiptKeyId } from "@writ/job-send";
import { GOOGLE_JWKS_URI, GOOGLE_TOKEN_ENDPOINT, PgOAuthStore, SESSION_COOKIE, SIGN_IN_COOKIE } from "@writ/job-send/server";
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
  writeFileSync(join(dir, "app.css"), "body { color: white; }");
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
  for (const path of ["/owner/integrations", "/owner/alerts/preferences", "/owner/alerts/test"]) {
    const response = await fetch(`${base}${path}`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "sign_in" });
  }
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

test("the built service includes public information pages without sign-in or provider requests", async () => {
  const priorFetches = fetched.length;
  for (const path of ["/about", "/privacy", "/terms", "/public.css"]) {
    const response = await fetch(`${base}${path}`, { redirect: "manual" });
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.equal(response.headers.get("location"), null);
    assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    const body = await response.text();
    assert.ok(body.length > 0);
    assert.equal(body.includes("dana@test.example"), false);
    assert.equal(body.includes("receipt-key.json"), false);
    const head = await fetch(`${base}${path}`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(Buffer.byteLength(body)));
    assert.equal(await head.text(), "");
  }
  assert.equal(fetched.length, priorFetches, "public pages do not call a provider");
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

test("the ChatGPT connect path through the composed service: sign in, allow, code, token, /mcp, one AGENT_CONNECTED", async () => {
  // A second service on the same database whose Google is faked: the token endpoint returns an ID token signed
  // by a key the faked JWKS publishes. Everything else is the real wiring, as main.mjs builds it.
  const CLIENT = "client-id.apps.example.test";
  const google = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...google.publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  let nonce = "";
  const fakeGoogle = async (url) => {
    if (String(url) === GOOGLE_JWKS_URI) return { ok: true, status: 200, json: async () => ({ keys: [jwk] }) };
    if (String(url) === GOOGLE_TOKEN_ENDPOINT) {
      const at = Math.floor(Date.now() / 1000);
      const claims = { iss: "https://accounts.google.com", aud: CLIENT, sub: "sub-connect-flow", email: "connect@test.example", email_verified: true, iat: at, exp: at + 3600, nonce };
      const signing = `${b64({ alg: "RS256", kid: "k1" })}.${b64(claims)}`;
      return { ok: true, status: 200, json: async () => ({ id_token: `${signing}.${sign("RSA-SHA256", Buffer.from(signing), google.privateKey).toString("base64url")}` }) };
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const config = loadConfig({
    HOST,
    DATABASE_URL: "postgres://injected.invalid/jobsend",
    GOOGLE_CLIENT_ID: CLIENT,
    GOOGLE_CLIENT_SECRET: `secret-${randomBytes(6).toString("hex")}`,
    RECEIPT_SIGNING_KEY: signingKey,
    CUSTODY_KEY: randomBytes(32).toString("base64"),
    OWNER_APP_DIR: ownerAppDir(receiptKeyId(exportRawPublicKey(signingKey))),
  });
  const connectErrors = [];
  const connect = await startService(config, { pool: db.pool, fetchImpl: fakeGoogle, log: () => {}, onError: (e) => connectErrors.push(e) });
  await new Promise((resolve) => connect.server.listen(0, "127.0.0.1", resolve));
  const at = `http://127.0.0.1:${connect.server.address().port}`;
  const cookieOf = (res, name) => res.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.startsWith(`${name}=`) && c.length > name.length + 1);
  try {
    // ChatGPT registers, then sends the owner to /oauth/authorize; with no session that leads to sign-in.
    const registered = await (await fetch(`${at}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [CHATGPT_REDIRECT], client_name: "ChatGPT" }),
    })).json();
    const query = new URLSearchParams({
      response_type: "code",
      client_id: registered.client_id,
      redirect_uri: CHATGPT_REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      scope: "jobs.act",
      resource: `${HOST}/mcp`,
      state: "st_connect",
    });
    const anonymous = await fetch(`${at}/oauth/authorize?${query}`, { redirect: "manual" });
    assert.equal(anonymous.status, 302);
    const signInPath = anonymous.headers.get("location");
    assert.match(signInPath, /^\/auth\/sign-in\?return_to=/);

    // Google sign-in, faked at Google's side only.
    const start = await fetch(`${at}${signInPath}`, { redirect: "manual" });
    const toGoogle = new URL(start.headers.get("location"));
    nonce = toGoogle.searchParams.get("nonce");
    const callback = await fetch(`${at}/auth/google/callback?code=g1&state=${toGoogle.searchParams.get("state")}`, {
      redirect: "manual",
      headers: { cookie: cookieOf(start, SIGN_IN_COOKIE) },
    });
    assert.equal(callback.status, 302);
    const session = cookieOf(callback, SESSION_COOKIE);
    assert.ok(session, "a session cookie");

    // The consent page, then Allow, exactly as the browser posts it.
    const consent = await fetch(`${at}/oauth/authorize?${query}`, { headers: { cookie: session }, redirect: "manual" });
    assert.equal(consent.status, 200);
    const requestId = /name="request_id" value="([^"]+)"/.exec(await consent.text())?.[1];
    assert.ok(requestId, "the consent form carries its request id");
    const allowed = await fetch(`${at}/oauth/authorize`, {
      method: "POST",
      headers: { cookie: session, origin: HOST, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request_id: requestId, decision: "allow" }).toString(),
      redirect: "manual",
    });
    assert.equal(allowed.status, 302);
    const back = new URL(allowed.headers.get("location"));
    assert.equal(`${back.origin}${back.pathname}`, CHATGPT_REDIRECT);
    assert.equal(back.searchParams.get("state"), "st_connect");

    // ChatGPT redeems the code, then calls /mcp with the token.
    const issued = await token(at, { ...codeParams(registered.client_id, back.searchParams.get("code")), resource: `${HOST}/mcp` });
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    const tools = await fetch(`${at}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${issued.body.access_token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(tools.status, 200);
    assert.ok((await tools.json()).result.tools.some((tool) => tool.name === "propose_send"));

    // Exactly one agent connection for this owner, the token's, recorded by one AGENT_CONNECTED receipt.
    const { rows: owner } = await db.pool.query("SELECT id FROM owners WHERE google_sub = 'sub-connect-flow'");
    const { rows: connections } = await db.pool.query("SELECT id, client_label FROM agent_connections WHERE owner_id = $1", [owner[0].id]);
    assert.deepEqual(connections.map((c) => c.client_label), ["ChatGPT"]);
    const { rows: tokenRows } = await db.pool.query("SELECT agent_connection_id FROM access_tokens WHERE token_hash = $1", [hashToken(issued.body.access_token)]);
    assert.equal(tokenRows[0]?.agent_connection_id, connections[0].id, "the token belongs to the connection the consent made");
    const { rows: receipts } = await db.pool.query("SELECT payload FROM receipts WHERE owner_id = $1 AND type = 'AGENT_CONNECTED'", [owner[0].id]);
    assert.equal(receipts.length, 1);
    assert.equal(JSON.parse(receipts[0].payload).agent_connection, connections[0].id);
    assert.deepEqual(connectErrors, []);
  } finally {
    await connect.stop();
  }
});
