#!/usr/bin/env node
// grokbot lab: the real SpeedWrit agent side (OAuth, /mcp, secret path, gate, executor, receipts)
// on this machine, with two seams so Grok can be tested end to end with no Google and no email:
//   1. the owner is always signed in (one lab owner), so consent needs no Google sign-in;
//   2. the mail provider is a stub that accepts every send and records it in the lab outbox.
// It seeds the demo's job, "Tuesday recap to Dana" (2 sends), for every agent connection that
// connects, and prints a secret-path URL for Grok Bot. Each Grok client's registration (its
// redirect URIs, auth method and name) is logged, which is how their callbacks are learned.
//
// NEVER deploy this: anyone who can reach it is the owner. It listens on 127.0.0.1 only; a tunnel
// you start yourself is what makes it reachable from xAI. Mail never leaves this process.
//
//   HOST=https://<your-tunnel> node packages/grokbot/lab/lab.mjs
//   open http://127.0.0.1:8790/lab   (pending approvals, outbox, receipts)
//
// Env: HOST (required, the tunnel's https origin), PORT (8790), REDIRECT_FALLBACKS (comma list),
// LAB_ACCEPT_ANY_REDIRECT=on (capture mode: allow whatever a client registers; logged loudly),
// JOBSEND_PG_DSN (use that server instead of an embedded Postgres).
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { Readable } from "node:stream";

import {
  aiReview,
  createExecutor,
  DEMO_RECAP_TEMPLATE,
  ensureSharedTemplate,
  generateReceiptKeyPair,
  listReceipts,
  newId,
} from "@writ/job-send";
import { createApp, createJobSendHandler, createMcpBackend, createOwnerCore, createSecretPath, PgOAuthStore, PgSecretPaths, redactPath } from "@writ/job-send/server";

import { createStubMailProvider } from "../../job-send/tests/acceptance/support/stub-mail-provider.mjs";
import { startPostgres } from "../../job-send/tests/executor-support/pg.mjs";

const HOST = process.env.HOST?.trim();
if (!HOST || !/^https:\/\/[a-z0-9.-]+(:\d+)?$/.test(HOST)) {
  console.error("HOST must be your tunnel's https origin, e.g. HOST=https://abc.ngrok-free.app (no path, no trailing slash).");
  process.exit(2);
}
const PORT = Number(process.env.PORT ?? 8790);
const LOCAL = `http://127.0.0.1:${PORT}`;
const ACCEPT_ANY = process.env.LAB_ACCEPT_ANY_REDIRECT === "on";
const LOG_FILE = new URL("./lab-log.jsonl", import.meta.url).pathname;
const fallbacks = (process.env.REDIRECT_FALLBACKS ?? "http://127.0.0.1:8976/callback,https://grok.com/connectors-oauth-exchange-code/").split(",").map((s) => s.trim()).filter(Boolean);

const log = (entry) => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  console.log(line);
  appendFileSync(LOG_FILE, `${line}\n`);
};

// ---- Database, keys, the stub provider, the real executor -----------------------------------
const db = await startPostgres({ poolSize: 10 });
const pool = db.pool;
const key = generateReceiptKeyPair();
const stub = createStubMailProvider({ fallback: "accept" });
const executor = createExecutor({ pool, signingKey: key.privateKeyPem, mailProviderFor: () => stub.provider });
const stopSweeper = executor.startSweeper(undefined, (error) => log({ kind: "error", where: "sweeper", message: String(error) }));
const template = await ensureSharedTemplate(pool, DEMO_RECAP_TEMPLATE);

const OWNER = { id: newId("own"), email: "owner@speedwrit.lab" };
const MAIL = newId("con");
await pool.query("INSERT INTO owners (id, google_sub, email) VALUES ($1, $2, $3)", [OWNER.id, `lab-${OWNER.id}`, OWNER.email]);
await pool.query("INSERT INTO connections (id, owner_id, provider, account_email) VALUES ($1, $2, 'gmail', $3)", [MAIL, OWNER.id, OWNER.email]);

const core = createOwnerCore({ pool, executor, mcpUrl: `${HOST}/mcp`, defaultTemplateId: template.id });
const backend = createMcpBackend({ pool, executor, review: (input) => aiReview(input, { apiKey: undefined }) });
const secretPaths = new PgSecretPaths(pool);

/** The demo's job for one agent connection: Dana at Acme, 2 sends, auto-send, custom wording held for approval. */
async function seedDemoJob(agentConnectionId) {
  const { job, authoritySha256 } = await core.createJobDraft(OWNER.id, {
    connectionId: MAIL,
    agentConnectionId,
    recipient: "dana@acme.test",
    purpose: "Tuesday recap to Dana",
    templateId: template.id,
    maxSends: 2,
    expiresAt: new Date(Date.now() + 8 * 3600_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    autoSend: true,
    allowCustomWithApproval: true,
    aiReview: "custom_only",
  });
  await core.confirmJob(OWNER.id, job.job_id, authoritySha256);
  return job.job_id;
}

async function newAgentConnection(clientId, clientLabel) {
  const id = await executor.withTx(OWNER.id, async (tx) => {
    const connection = newId("ac");
    await tx.client.query("INSERT INTO agent_connections (id, owner_id, client_id, client_label) VALUES ($1, $2, $3, $4)", [connection, OWNER.id, clientId, clientLabel]);
    await executor.writeReceipt(tx, "AGENT_CONNECTED", { agent_connection: connection, client_label: clientLabel, detail: { client_id: clientId } });
    return connection;
  });
  const job = await seedDemoJob(id);
  log({ kind: "agent_connection", id, client_label: clientLabel, seeded_job: job });
  return id;
}

// ---- The agent side: the real handler, with the lab owner ------------------------------------
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const agent = createJobSendHandler({
  host: HOST,
  store: new PgOAuthStore(pool),
  backend,
  redirectFallbacks: fallbacks,
  secretPaths,
  onError: (error) => log({ kind: "error", message: String(error?.stack ?? error) }),
  authorize: {
    owners: { owner: async () => OWNER, signInUrl: (returnTo) => returnTo },
    createAgentConnection: (_owner, clientId, clientLabel) => newAgentConnection(clientId, clientLabel),
    renderConsent: (view) => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>SpeedWrit lab: connect</title>
<body style="font:16px system-ui;max-width:560px;margin:40px auto;padding:0 16px">
<h2>Connect <em>${esc(view.request.clientName)}</em> to SpeedWrit (lab)</h2>
<p>It will be able to send email for ${esc(view.ownerEmail)} only inside jobs you confirm. This lab seeds "Tuesday recap to Dana" for it; mail goes to the lab outbox, never out.</p>
<p style="color:#666;font-size:13px">Redirect: <code>${esc(view.request.redirectUri)}</code></p>
<form method=post action="/oauth/authorize"><input type=hidden name=request_id value="${esc(view.requestId)}">
<button name=decision value=allow style="font-size:16px;padding:8px 20px">Allow</button>
<button name=decision value=deny style="font-size:16px;padding:8px 20px">Deny</button></form>`,
  },
});

// ---- The lab page: approvals, outbox, receipts -------------------------------------------------
const page = (res, html) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(html);
};

async function labPage(res, notice = "") {
  const { rows: conns } = await pool.query("SELECT id, client_label, created_at FROM agent_connections WHERE owner_id = $1 ORDER BY created_at", [OWNER.id]);
  const jobs = await core.listJobs(OWNER.id);
  const pending = await core.listPendingVersions(OWNER.id);
  const receipts = (await listReceipts(pool, OWNER.id)).slice(-20).reverse();
  const outbox = stub.calls.map((call) => {
    const text = new TextDecoder().decode(call.bytes);
    return { to: /^To: (.*)$/m.exec(text)?.[1] ?? "?", subject: /^Subject: (.*)$/m.exec(text)?.[1] ?? "?", at: new Date(call.at).toISOString().slice(11, 19) };
  });
  const row = (cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
  page(res, `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width"><title>SpeedWrit lab</title>
<style>body{font:15px system-ui;max-width:900px;margin:24px auto;padding:0 16px}table{border-collapse:collapse;width:100%;margin-bottom:20px}td,th{border-bottom:1px solid #ddd;padding:6px;text-align:left;vertical-align:top}pre{white-space:pre-wrap;margin:0}.n{background:#eef;padding:8px}</style>
<h1>SpeedWrit lab</h1><p>HOST ${esc(HOST)} · MCP <code>${esc(HOST)}/mcp</code> · <a href="/lab">refresh</a></p>
${notice ? `<p class=n>${esc(notice)}</p>` : ""}
<h2>Waiting for you (${pending.length})</h2><table><tr><th>proposal</th><th>version</th><th>reasons</th><th>wording</th><th></th></tr>
${pending.map((p) => row([esc(p.proposalId), p.version, esc((p.reviewReasons ?? []).join(", ")), `<pre>${esc(p.subject)}\n\n${esc(p.body)}</pre>${p.baseline ? `<p style="color:#888">was: ${esc(p.baseline.body)}</p>` : ""}`,
  `<form method=post action="/lab/answer"><input type=hidden name=proposal value="${esc(p.proposalId)}"><input type=hidden name=version value="${p.version}"><input type=hidden name=sha value="${esc(p.sha256)}"><button name=decision value=approve>Approve this version</button> <button name=decision value=reject>Reject</button></form>`])).join("")}</table>
<h2>Outbox (stub provider, ${outbox.length})</h2><table><tr><th>at</th><th>to</th><th>subject</th></tr>${outbox.map((m) => row([m.at, esc(m.to), esc(m.subject)])).join("")}</table>
<h2>Agent connections</h2><table><tr><th>id</th><th>client</th></tr>${conns.map((c) => row([esc(c.id), esc(c.client_label)])).join("")}</table>
<h2>Jobs</h2><table><tr><th>job</th><th>purpose</th><th>recipient</th><th>agent connection</th><th>status</th></tr>${jobs.map((j) => row([esc(j.job.job_id), esc(j.job.purpose), esc(j.job.recipient), esc(j.job.agent_connection), `${esc(j.status)} · ${j.sendsLeft} left`])).join("")}</table>
<h2>Receipts (last 20)</h2><table><tr><th>type</th><th>id</th></tr>${receipts.map((r) => row([esc(r.type), esc(r.id)])).join("")}</table>`);
}

async function labAnswer(req, res, raw) {
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== LOCAL && origin !== HOST) return page(res, "refused: another origin");
  const form = new URLSearchParams(raw.toString("utf8"));
  const proposal = form.get("proposal");
  const version = Number(form.get("version"));
  const sha = form.get("sha");
  try {
    const result = form.get("decision") === "approve" ? await core.approve(proposal, version, sha, OWNER.id) : await core.rejectVersion(proposal, version, sha, OWNER.id);
    log({ kind: "owner_answer", decision: form.get("decision"), proposal, version, result });
    return labPage(res, `${form.get("decision")}: ${JSON.stringify(result)}`);
  } catch (error) {
    return labPage(res, `refused: ${error?.message ?? error}`);
  }
}

const app = createApp({
  handlers: [
    async (req, res) => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      if (req.method === "GET" && (path === "/lab" || path === "/")) return (await labPage(res), true);
      if (req.method === "GET" && path === "/lab/state.json") {
        const pending = (await core.listPendingVersions(OWNER.id)).map((p) => ({ proposal_id: p.proposalId, version: p.version, sha256: p.sha256, review_reasons: p.reviewReasons }));
        const receipts = (await listReceipts(pool, OWNER.id)).map((r) => r.type);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ pending, outbox: stub.calls.length, receipts }));
        return true;
      }
      if (req.method === "POST" && path === "/lab/answer") return (await labAnswer(req, res, req.labBody), true);
      return false;
    },
  ],
  agent,
  onError: (error) => log({ kind: "error", message: String(error?.stack ?? error) }),
});

// ---- The front: buffer the body once, log what each client sends, then hand on ----------------
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  const url = new URL(req.url ?? "/", "http://x");
  const entry = { kind: "req", method: req.method, path: redactPath(req.url), ua: req.headers["user-agent"] };
  try {
    if (url.pathname === "/oauth/register" && raw.length) {
      const body = JSON.parse(raw.toString("utf8"));
      entry.registration = { client_name: body.client_name, redirect_uris: body.redirect_uris, token_endpoint_auth_method: body.token_endpoint_auth_method, grant_types: body.grant_types, response_types: body.response_types, scope: body.scope };
      if (ACCEPT_ANY) for (const uri of body.redirect_uris ?? []) if (typeof uri === "string" && !fallbacks.includes(uri)) { fallbacks.push(uri); log({ kind: "capture", allowed_redirect: uri }); }
    }
    if (url.pathname === "/oauth/authorize" && req.method === "GET") entry.authorize = { client_id: url.searchParams.get("client_id"), redirect_uri: url.searchParams.get("redirect_uri"), resource: url.searchParams.get("resource"), scope: url.searchParams.get("scope"), method: url.searchParams.get("code_challenge_method") };
    if (url.pathname === "/oauth/token" && raw.length) {
      const p = new URLSearchParams(raw.toString("utf8"));
      entry.token = { grant_type: p.get("grant_type"), redirect_uri: p.get("redirect_uri"), resource: p.get("resource"), has_verifier: p.has("code_verifier"), has_secret: p.has("client_secret"), basic_auth: /^basic /i.test(req.headers.authorization ?? "") };
    }
    if (url.pathname.startsWith("/mcp") && raw.length) {
      const body = JSON.parse(raw.toString("utf8"));
      entry.rpc = { method: body.method, tool: body.params?.name, client: body.params?.clientInfo?.name, auth: req.headers.authorization ? "bearer" : "none" };
    }
  } catch {
    entry.unparsed = true;
  }
  res.on("finish", () => log({ ...entry, status: res.statusCode }));
  const replay = Readable.from(raw.length ? [raw] : []);
  // The MCP SDK reads rawHeaders, httpVersion and the rest, so the replay carries every request field.
  for (const field of ["headers", "rawHeaders", "headersDistinct", "trailers", "rawTrailers", "method", "url", "httpVersion", "httpVersionMajor", "httpVersionMinor", "socket", "connection"]) {
    Object.defineProperty(replay, field, { value: req[field], configurable: true, enumerable: true, writable: true });
  }
  replay.complete = true;
  replay.labBody = raw;
  await app(replay, res);
});

// Grok Bot (and grokbot's secret-path mode) get a ready connection, job and URL at start.
const botConnection = await newAgentConnection("lab-secret-path", "Grok Bot (lab, secret path)");
const { url: secretUrl, secretHash } = createSecretPath(HOST);
await secretPaths.add(secretHash, botConnection);

server.listen(PORT, "127.0.0.1", () => {
  console.log(`
SpeedWrit lab on ${LOCAL}, public as ${HOST}  (stub mail; the owner is always signed in; never deploy)
  lab page        ${LOCAL}/lab
  OAuth MCP URL   ${HOST}/mcp            (grok.com connector, Grok Bot OAuth, grokbot login)
  secret path     ${secretUrl}
                  (Grok Bot / grokbot without sign-in; local doctor: ${LOCAL}/mcp/c/${secretUrl.split("/mcp/c/")[1]})
  redirects ok    ChatGPT${fallbacks.length ? `, ${fallbacks.join(", ")}` : ""}${ACCEPT_ANY ? "  + CAPTURE MODE: any registered redirect" : ""}
  log             ${LOG_FILE}
`);
});

const shutdown = async () => {
  stopSweeper();
  server.close();
  await pool.end().catch(() => undefined);
  await db.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
