import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

import { approvalAnswer, createOwnerApi, OWNER_BODY_SCHEMAS, OwnerError } from "../../dist/server/owner-api.js";
import { SECRET_PATH } from "../../dist/server/secret-path.js";
import { SCHEMA_KEYWORDS } from "../../dist/mcp/arguments.js";
import { hashToken } from "../../dist/oauth/oauth.js";

import { HOST, NOW, OWNERS } from "./support/harness.mjs";

const SHA = "a".repeat(64);
const JOB = {
  connection_id: "con_1",
  agent_connection_id: "ac_1",
  recipient: "dana@test.example",
  purpose: "Send Dana at Acme a recap of Tuesday's call.",
  template_id: "tpl_recap",
  max_sends: 2,
  expires_at: "2026-10-12T06:59:00Z",
  auto_send: true,
  allow_custom_with_approval: true,
  ai_review: "custom_only",
};

/** The owner API in front of a stand-in "next handler", with a fake core that records every call. */
async function start({ core: overrides = {}, secretPaths } = {}) {
  const calls = [];
  const revoked = [];
  const errors = [];
  const record = (name, value) => async (...args) => {
    calls.push([name, ...args]);
    return typeof value === "function" ? value(...args) : value;
  };
  const core = {
    connectState: record("connectState", { gmail: null, agentConnection: null, stopped: false }),
    engageStop: record("engageStop", { receipt_ids: ["r_stop", "r_revoke"] }),
    revokeAgentConnection: record("revokeAgentConnection", { receipt_id: "r_rev" }),
    assertAgentConnection: record("assertAgentConnection", undefined),
    createJobDraft: record("createJobDraft", { job: { v: 1, job_id: "job_1" }, authoritySha256: SHA }),
    confirmJob: record("confirmJob", { policyVersion: 1, receipt_id: "r_job" }),
    listJobs: record("listJobs", [{ job_id: "job_1" }]),
    listPendingVersions: record("listPendingVersions", []),
    approve: record("approve", { kind: "provider", outcome: { status: "accepted", providerMessageId: "m1" }, receipt_id: "r_acc" }),
    rejectVersion: record("rejectVersion", { receipt_id: "r_rej" }),
    resolveUnknown: record("resolveUnknown", { receipt_id: "r_res" }),
    listReceipts: record("listReceipts", [{ receipt_id: "r_1" }]),
    ...overrides,
  };
  const handler = createOwnerApi({
    host: HOST,
    core,
    owners: {
      async owner(req) {
        const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
        return sid !== undefined && Object.hasOwn(OWNERS, sid) ? OWNERS[sid] : null;
      },
    },
    oauthStore: { revokeAgentConnection: async (id, at) => revoked.push([id, at]) },
    secretPaths,
    now: () => NOW,
    onError: (error) => errors.push(error),
  });
  const server = createServer(async (req, res) => {
    if (!(await handler(req, res))) {
      res.writeHead(418);
      res.end("next handler");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, calls, revoked, errors, close: () => new Promise((resolve) => server.close(resolve)) };
}

const get = (base, path, sid = "dana") => fetch(`${base}${path}`, { headers: sid ? { cookie: `sid=${sid}` } : {} });

function post(base, path, value, { sid = "dana", origin = HOST, contentType = "application/json", raw } = {}) {
  const headers = { "content-type": contentType };
  if (sid) headers.cookie = `sid=${sid}`;
  if (origin) headers.origin = origin;
  return fetch(`${base}${path}`, { method: "POST", headers, body: raw ?? JSON.stringify(value) });
}

function keywords(schema, out = new Set()) {
  for (const key of Object.keys(schema)) out.add(key);
  for (const child of Object.values(schema.properties ?? {})) keywords(child, out);
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") keywords(schema.additionalProperties, out);
  return out;
}

test("every owner body schema uses only keywords the checker understands, and refuses unknown keys", () => {
  for (const [path, schema] of Object.entries(OWNER_BODY_SCHEMAS)) {
    for (const keyword of keywords(schema)) assert.ok(SCHEMA_KEYWORDS.includes(keyword), `${path} uses ${keyword}`);
    assert.equal(schema.additionalProperties, false, path);
  }
});

test("without a session every /owner/* route is 401 and the core is never called; other paths pass through", async () => {
  const app = await start();
  try {
    for (const path of ["/owner/me", "/owner/connect", "/owner/jobs", "/owner/pending", "/owner/receipts?job_id=job_1"]) {
      const res = await get(app.base, path, null);
      assert.equal(res.status, 401, path);
      assert.deepEqual(await res.json(), { error: "sign_in" });
    }
    assert.equal((await post(app.base, "/owner/stop", { connection_id: "con_1" }, { sid: null })).status, 401);
    assert.equal(app.calls.length, 0);
    assert.equal((await get(app.base, "/mcp")).status, 418, "not ours");
    assert.equal((await get(app.base, "/ownerx")).status, 418, "a prefix that only looks like ours");
  } finally {
    await app.close();
  }
});

test("reads answer for the signed-in owner, with no-store and no CORS", async () => {
  const app = await start();
  try {
    const me = await get(app.base, "/owner/me");
    assert.deepEqual(await me.json(), { owner: { id: "own_1", email: "owner@example.test" } });
    assert.equal(me.headers.get("cache-control"), "no-store");
    assert.equal(me.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(await (await get(app.base, "/owner/jobs")).json(), { jobs: [{ job_id: "job_1" }] });
    assert.deepEqual(await (await get(app.base, "/owner/receipts?job_id=job_1", "eve")).json(), { receipts: [{ receipt_id: "r_1" }] });
    assert.deepEqual(app.calls.at(-1), ["listReceipts", "own_2", { job: "job_1" }], "scoped to the signed-in owner");
    assert.equal((await get(app.base, "/owner/receipts")).status, 400, "job_id is required");
    assert.equal((await get(app.base, "/owner/receipts?job_id=a&job_id=b")).status, 400, "once");
  } finally {
    await app.close();
  }
});

test("a write needs this site's Origin and a JSON body that fits its schema, before the core runs", async () => {
  const app = await start();
  try {
    const path = "/owner/versions/approve";
    const good = { proposal_id: "prop_1", version: 2, shown_sha256: SHA };
    assert.equal((await post(app.base, path, good, { origin: null })).status, 403, "no Origin");
    assert.equal((await post(app.base, path, good, { origin: "https://evil.test" })).status, 403);
    assert.equal((await post(app.base, path, good, { origin: "null" })).status, 403);
    assert.equal((await post(app.base, path, good, { contentType: "text/plain" })).status, 415, "a cross-site form's type");
    assert.equal((await post(app.base, path, good, { contentType: "application/x-www-form-urlencoded" })).status, 415);
    assert.equal((await post(app.base, path, null, { raw: "{" })).status, 400);
    assert.equal((await post(app.base, path, null, { raw: `{"x":"${"y".repeat(64 * 1024)}"}` })).status, 413);
    const extra = await post(app.base, path, { ...good, owner: "own_2" });
    assert.deepEqual(await extra.json(), { error: "invalid", detail: "body has a property that is not allowed" });
    assert.equal((await post(app.base, path, { ...good, version: "2" })).status, 400);
    assert.equal((await post(app.base, path, { ...good, version: 6 })).status, 400, "at most 5 versions");
    assert.equal((await post(app.base, path, { proposal_id: "prop_1", version: 2 })).status, 400, "shown_sha256 is required");
    assert.equal(app.calls.length, 0, "nothing reached the core");
    const ok = await post(app.base, path, good);
    assert.equal(ok.status, 200);
    assert.deepEqual(app.calls, [["approve", "prop_1", 2, SHA, "own_1"]]);
  } finally {
    await app.close();
  }
});

test("an approval answers the provider's result or the refusal, never more", async () => {
  assert.deepEqual(approvalAnswer({ kind: "provider", outcome: { status: "accepted", providerMessageId: "m" }, receipt_id: "r" }), { status: "accepted", receipt_id: "r" });
  assert.deepEqual(approvalAnswer({ kind: "provider", outcome: { status: "not_sent", errorClass: "http_400" }, receipt_id: "r" }), { status: "not_sent", receipt_id: "r" });
  assert.deepEqual(approvalAnswer({ kind: "provider", outcome: { status: "unknown", errorClass: "timeout" }, receipt_id: "r" }), { status: "unknown", receipt_id: "r" });
  assert.deepEqual(approvalAnswer({ kind: "refused", reason: "superseded", receipt_id: "r" }), { status: "refused", reason: "superseded", receipt_id: "r" });
  const app = await start({ core: { approve: async () => ({ kind: "refused", reason: "policy_changed", receipt_id: "r_pc" }) } });
  try {
    const res = await post(app.base, "/owner/versions/approve", { proposal_id: "prop_1", version: 1, shown_sha256: SHA });
    assert.deepEqual(await res.json(), { status: "refused", reason: "policy_changed", receipt_id: "r_pc" });
  } finally {
    await app.close();
  }
});

test("the core's refusals answer by code; anything else is a server error that names nothing", async () => {
  const app = await start({
    core: {
      confirmJob: async () => {
        throw new OwnerError("authority_changed");
      },
      rejectVersion: async () => {
        throw new OwnerError("not_found");
      },
      resolveUnknown: async () => {
        throw new Error("relation dispatches does not exist");
      },
    },
  });
  try {
    const confirm = await post(app.base, "/owner/jobs/confirm", { job_id: "job_1", authority_sha256: SHA });
    assert.equal(confirm.status, 409);
    assert.deepEqual(await confirm.json(), { error: "authority_changed" });
    assert.equal((await post(app.base, "/owner/versions/reject", { proposal_id: "p", version: 1, shown_sha256: SHA })).status, 404);
    const broken = await post(app.base, "/owner/dispatches/resolve", { dispatch_id: "d", outcome: "seen" });
    assert.equal(broken.status, 500);
    assert.deepEqual(await broken.json(), { error: "server_error" });
    assert.equal(app.errors.length, 1);
  } finally {
    await app.close();
  }
});

test("revoking: the core checks the connection is this owner's before any OAuth token is revoked", async () => {
  const app = await start();
  try {
    const ok = await post(app.base, "/owner/agent-connections/revoke", { agent_connection_id: "ac_1" });
    assert.deepEqual(await ok.json(), { revoked: true, receipt_id: "r_rev" });
    assert.deepEqual(app.revoked, [["ac_1", NOW]]);
  } finally {
    await app.close();
  }
  const other = await start({
    core: {
      revokeAgentConnection: async () => {
        throw new OwnerError("not_found");
      },
    },
  });
  try {
    const res = await post(other.base, "/owner/agent-connections/revoke", { agent_connection_id: "ac_of_someone_else" }, { sid: "eve" });
    assert.equal(res.status, 404);
    assert.deepEqual(other.revoked, [], "another owner's tokens are untouched");
  } finally {
    await other.close();
  }
});

test("a secret path is created only for the owner's own connection, shown once, and stored as a hash", async () => {
  const added = [];
  const secretPaths = { add: async (hash, id) => added.push([hash, id]) };
  const app = await start({ secretPaths });
  try {
    const res = await post(app.base, "/owner/agent-connections/secret-path", { agent_connection_id: "ac_1" });
    const { url } = await res.json();
    assert.equal(url.startsWith(`${HOST}/mcp/c/`), true);
    const secret = SECRET_PATH.exec(new URL(url).pathname)[1];
    assert.deepEqual(added, [[hashToken(secret), "ac_1"]]);
    assert.deepEqual(app.calls, [["assertAgentConnection", "ac_1", "own_1"]]);
  } finally {
    await app.close();
  }
  const notMine = await start({
    secretPaths,
    core: {
      assertAgentConnection: async () => {
        throw new OwnerError("not_found");
      },
    },
  });
  try {
    added.length = 0;
    assert.equal((await post(notMine.base, "/owner/agent-connections/secret-path", { agent_connection_id: "ac_x" })).status, 404);
    assert.deepEqual(added, []);
  } finally {
    await notMine.close();
  }
  const off = await start();
  try {
    assert.equal((await post(off.base, "/owner/agent-connections/secret-path", { agent_connection_id: "ac_1" })).status, 404, "fallback off");
  } finally {
    await off.close();
  }
});

test("jobs: a draft returns its authority hash, and confirming passes the hash the screen showed", async () => {
  const app = await start();
  try {
    const draft = await (await post(app.base, "/owner/jobs", JOB)).json();
    assert.equal(draft.authoritySha256, SHA);
    assert.deepEqual(app.calls[0], [
      "createJobDraft",
      "own_1",
      {
        connectionId: "con_1",
        agentConnectionId: "ac_1",
        recipient: "dana@test.example",
        purpose: JOB.purpose,
        templateId: "tpl_recap",
        maxSends: 2,
        expiresAt: "2026-10-12T06:59:00Z",
        autoSend: true,
        allowCustomWithApproval: true,
        aiReview: "custom_only",
      },
    ], "the flat body, mapped to the core's shape");
    for (const bad of [{ ...JOB, ai_review: "always" }, { ...JOB, max_sends: 0 }, { ...JOB, auto_send: "yes" }, { ...JOB, field_rules: { x: { max: 10 } } }, { ...JOB, cc: "x@example.test" }]) {
      assert.equal((await post(app.base, "/owner/jobs", bad)).status, 400);
    }
    await post(app.base, "/owner/jobs/confirm", { job_id: "job_1", authority_sha256: SHA });
    assert.deepEqual(app.calls.at(-1), ["confirmJob", "own_1", "job_1", SHA]);
  } finally {
    await app.close();
  }
});

test("STOP and UNKNOWN resolve take exactly their words; a wrong method or path is answered, not passed on", async () => {
  const app = await start();
  try {
    assert.deepEqual(await (await post(app.base, "/owner/stop", { connection_id: "con_1" })).json(), { stopped: true, receipt_ids: ["r_stop", "r_revoke"] });
    assert.equal((await post(app.base, "/owner/dispatches/resolve", { dispatch_id: "d1", outcome: "sent" })).status, 400, "only the core's own words");
    await post(app.base, "/owner/dispatches/resolve", { dispatch_id: "d1", outcome: "not_arrived" });
    assert.deepEqual(app.calls.at(-1), ["resolveUnknown", "d1", "not_arrived", "own_1"]);
    assert.equal((await get(app.base, "/owner/stop")).status, 405);
    assert.equal((await fetch(`${app.base}/owner/jobs`, { method: "DELETE", headers: { cookie: "sid=dana" } })).status, 405);
    const preflight = await fetch(`${app.base}/owner/stop`, { method: "OPTIONS", headers: { cookie: "sid=dana", origin: "https://evil.test" } });
    assert.equal(preflight.status, 405);
    assert.equal(preflight.headers.get("access-control-allow-origin"), null);
    assert.equal((await get(app.base, "/owner/nothing")).status, 404);
  } finally {
    await app.close();
  }
});

test("only listed OwnerError codes are answered by name; any other error, even a typed one, is a plain 500", async () => {
  const app = await start({
    core: {
      listJobs: async () => {
        throw new TypeError("Cannot read properties of undefined (reading 'owner_id')");
      },
      engageStop: async () => {
        throw new OwnerError("drop_table");
      },
    },
  });
  try {
    for (const res of [await get(app.base, "/owner/jobs"), await post(app.base, "/owner/stop", { connection_id: "con_1" })]) {
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: "server_error" });
    }
    assert.equal(app.errors.length, 2);
  } finally {
    await app.close();
  }
});

test("an invalid_job refusal may name one listed field; an unlisted one is dropped, never echoed", async () => {
  const app = await start({
    core: {
      createJobDraft: async (_owner, draft) => {
        throw new OwnerError("invalid_job", { field: draft.purpose === "bad" ? "secret_column<script>" : "recipient" });
      },
      confirmJob: async () => {
        throw new OwnerError("job_expired");
      },
      resolveUnknown: async () => {
        throw new OwnerError("not_unknown");
      },
    },
  });
  try {
    const named = await post(app.base, "/owner/jobs", JOB);
    assert.equal(named.status, 409);
    assert.deepEqual(await named.json(), { error: "invalid_job", field: "recipient" });
    const unlisted = await post(app.base, "/owner/jobs", { ...JOB, purpose: "bad" });
    assert.deepEqual(await unlisted.json(), { error: "invalid_job" });
    assert.deepEqual(await (await post(app.base, "/owner/jobs/confirm", { job_id: "job_1", authority_sha256: SHA })).json(), { error: "job_expired" });
    assert.deepEqual(await (await post(app.base, "/owner/dispatches/resolve", { dispatch_id: "d1", outcome: "seen" })).json(), { error: "not_unknown" });
  } finally {
    await app.close();
  }
});
