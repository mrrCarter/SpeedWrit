// A job-send HTTP server on a free port with an in-memory store, a fake MCP backend, stub owner
// sessions (cookie sid=<name>), a stub consent renderer and a settable clock; plus the client
// calls the tests make.

import assert from "node:assert/strict";

import { createJobSendServer } from "../../../dist/server/http.js";
import { InMemoryOAuthStore } from "../../../dist/server/store.js";
import { CHATGPT_REDIRECT, hashToken } from "../../../dist/oauth/oauth.js";

export const HOST = "https://jobs.example.test";
export const RESOURCE = `${HOST}/mcp`;
// RFC 7636 Appendix B.
export const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
export const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
export const NOW = 1_800_000_000;
export const CONN = { id: "conn_1", owner_id: "own_1", client_id: "cli", client_label: "ChatGPT" };
export const OWNERS = {
  dana: { id: "own_1", email: "owner@example.test" },
  eve: { id: "own_2", email: "eve@example.test" },
};
export const JOB = {
  job_id: "job_1",
  purpose: "Interview recap",
  recipient: "dana@example.test",
  template_fields: { first_name: { max: 40, single_line: true, required: true } },
  allow_custom_with_approval: true,
  sends_left: 2,
  expires_at: "2027-01-15T00:00:00Z",
};
export const SENT = {
  status: "sent",
  sent: true,
  proposal_id: "prop_1",
  version: 1,
  version_sha256: "a".repeat(64),
  provider_message_id: "msg_1",
  receipt_id: "rcpt_1",
  sends_left: 1,
};

export async function start({ store = new InMemoryOAuthStore(), backend: overrides = {}, redirectFallbacks = [], secretPaths } = {}) {
  const calls = [];
  const errors = [];
  const stopped = new Set();
  const clock = { now: NOW };
  const connections = [];
  const views = [];
  const backend = {
    async connection(id) {
      return id === CONN.id && !stopped.has(id) ? CONN : null;
    },
    async listJobs(conn) {
      calls.push(["list_jobs", conn.id]);
      return [JOB];
    },
    async proposeSend(call, conn) {
      calls.push(["propose_send", call, conn.id]);
      return { result: SENT, recipient: JOB.recipient, maxSends: 2 };
    },
    async revise(call, conn) {
      calls.push(["revise_proposal", call, conn.id]);
      return {
        result: { status: "pending_approval", sent: false, proposal_id: call.proposal_id, version: 2, review_reasons: ["custom_content"] },
        recipient: JOB.recipient,
        maxSends: 2,
      };
    },
    async getStatus(id, conn) {
      calls.push(["get_status", id, conn.id]);
      return id === "prop_1" ? { proposal_id: "prop_1", status: "accepted", version: 1, version_sha256: "a".repeat(64), provider_message_id: "msg_1" } : null;
    },
    ...overrides,
  };
  const authorize = {
    owners: {
      async owner(req) {
        const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
        return sid !== undefined && Object.hasOwn(OWNERS, sid) ? OWNERS[sid] : null;
      },
      signInUrl: (returnTo) => `/signin?return_to=${encodeURIComponent(returnTo)}`,
    },
    async createAgentConnection(ownerId, clientId, clientLabel) {
      connections.push({ ownerId, clientId, clientLabel });
      return CONN.id;
    },
    renderConsent(view) {
      views.push(view);
      return `<form method="post" action="/oauth/authorize"><input type="hidden" name="request_id" value="${view.requestId}"></form>`;
    },
  };
  const server = createJobSendServer({ host: HOST, store, backend, authorize, redirectFallbacks, secretPaths, now: () => clock.now, onError: (error) => errors.push(error) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, store, calls, errors, stopped, clock, connections, views, authorize, close: () => new Promise((resolve) => server.close(resolve)) };
}

export async function register(base, body = { redirect_uris: [CHATGPT_REDIRECT], client_name: "ChatGPT" }) {
  const res = await fetch(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

/** Writes a code as POST /oauth/authorize would, for tests that start at the token endpoint. */
export async function seedCode(store, clientId, code = `code_${Math.random().toString(36).slice(2)}`) {
  await store.saveCode(hashToken(code), {
    client_id: clientId,
    redirect_uri: CHATGPT_REDIRECT,
    code_challenge: CHALLENGE,
    resource: RESOURCE,
    scope: "jobs.act",
    agent_connection_id: CONN.id,
    expires_at: NOW + 60,
    used_at: null,
  });
  return code;
}

export async function token(base, params, contentType = "application/x-www-form-urlencoded") {
  const body = typeof params === "string" ? params : new URLSearchParams(params).toString();
  const res = await fetch(`${base}/oauth/token`, { method: "POST", headers: { "content-type": contentType }, body });
  return { status: res.status, cache: res.headers.get("cache-control"), body: await res.json() };
}

export const codeParams = (clientId, code) => ({
  grant_type: "authorization_code",
  code,
  client_id: clientId,
  redirect_uri: CHATGPT_REDIRECT,
  code_verifier: VERIFIER,
  resource: RESOURCE,
});

export async function connect(base, store) {
  const client = (await register(base)).body;
  const issued = await token(base, codeParams(client.client_id, await seedCode(store, client.client_id)));
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  return { clientId: client.client_id, ...issued.body };
}

let rpcId = 0;
export async function rpc(base, accessToken, method, params = {}) {
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const res = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
  const text = await res.text();
  return { status: res.status, challenge: res.headers.get("www-authenticate"), body: text ? JSON.parse(text) : null };
}

export const callTool = (base, accessToken, name, args) => rpc(base, accessToken, "tools/call", { name, arguments: args });

/** Holds every call to `method` until `count` calls are waiting, so concurrent requests all read before any writes. */
export function barrier(store, method, count) {
  const waiting = [];
  const original = store[method].bind(store);
  store[method] = async (...args) => {
    const found = await original(...args);
    await new Promise((resolve) => {
      waiting.push(resolve);
      if (waiting.length === count) waiting.forEach((release) => release());
    });
    return found;
  };
  return store;
}
