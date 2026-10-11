import assert from "node:assert/strict";
import { createServer } from "node:http";
import test, { after, before } from "node:test";

import { DEMO_RECAP_TEMPLATE, canonicalSha256Hex, ensureSharedTemplate, newId, templateSha256 } from "../dist/index.js";
import { OwnerError, OwnerRefusal, createMcpBackend, createOwnerApi, createOwnerCore } from "../dist/server/index.js";
import { startPostgres } from "./executor-support/pg.mjs";
import { CUSTOM, FIELDS, FIELD_RULES, TEMPLATE_TEXT, assertReceiptChain, makeExecutor, receiptsOf, seedJob, typesOf } from "./executor-support/fixtures.mjs";

// The owner's side of the core, as the owner API's OwnerCore: drafting a job, confirming exactly the
// authority the screen showed, rejecting a version, STOP, resolving UNKNOWN, disconnecting an agent,
// and the owner-scoped reads. The last test runs it behind the real owner API routes.

let db;
before(async () => {
  db = await startPostgres();
});
after(async () => {
  await db?.stop();
});

const HOST = "https://jobs.example.com";
const connOf = (seed) => ({ id: seed.agentConnection, owner_id: seed.owner, client_id: "client-1", client_label: "ChatGPT (declared)" });
const inAnHour = () => new Date(Date.now() + 3600_000).toISOString();

/** A shared template whose `fields` carries its default rules, as the demo's seeded one does. */
async function sharedTemplate() {
  const id = newId("tpl");
  await db.pool.query("INSERT INTO templates (id, owner_id, subject_tpl, body_tpl, fields, sha256) VALUES ($1, NULL, $2, $3, $4::jsonb, $5)", [
    id,
    TEMPLATE_TEXT.subject_tpl,
    TEMPLATE_TEXT.body_tpl,
    JSON.stringify(FIELD_RULES),
    templateSha256(TEMPLATE_TEXT),
  ]);
  return id;
}

function setup(options = {}) {
  const { executor, stub } = makeExecutor(db.pool);
  const owner = createOwnerCore({ pool: db.pool, executor, mcpUrl: `${HOST}/mcp`, ...options });
  return { executor, stub, owner, backend: createMcpBackend({ pool: db.pool, executor }) };
}

const refuses = (promise, reason, code) =>
  assert.rejects(promise, (error) => error instanceof OwnerRefusal && error.reason === reason && error.code === code, reason);
const answers = (promise, code) => assert.rejects(promise, (error) => error instanceof OwnerError && error.code === code, code);

test("createJobDraft: the front door's draft becomes a draft job; the authority and its hash come back", async () => {
  const seed = await seedJob(db.pool);
  const template = await sharedTemplate();
  const { owner } = setup({ defaultTemplateId: template });
  const expiresAt = new Date(Date.now() + 3600_000 + 456);
  const draft = await owner.createJobDraft(seed.owner, { recipient: " Dana@Test.Example ", maxSends: 2, expiresAt: expiresAt.toISOString(), allowCustomWithApproval: true });

  assert.equal(draft.job.recipient, "dana@test.example");
  assert.equal(draft.job.owner, seed.owner);
  assert.equal(draft.job.connection, seed.connection, "the owner's one Gmail connection");
  assert.equal(draft.job.agent_connection, seed.agentConnection, "the owner's one agent connection");
  assert.equal(draft.job.sender, "owner@example.com");
  assert.deepEqual(draft.job.template, { id: template, sha256: templateSha256(TEMPLATE_TEXT) });
  assert.deepEqual(draft.job.field_rules, { ...FIELD_RULES }, "the template's default rules");
  assert.equal(draft.job.expires_at, expiresAt.toISOString().replace(/\.\d{3}Z$/, "Z"), "whole seconds");
  assert.equal(draft.job.auto_send, false);
  assert.equal(draft.job.ai_review, "custom_only");
  assert.equal(draft.authoritySha256, canonicalSha256Hex(draft.job), "sha256(JCS(job))");
  const [row] = (await db.pool.query("SELECT status, policy_version FROM jobs WHERE id = $1", [draft.job.job_id])).rows;
  assert.deepEqual(row, { status: "draft", policy_version: 1 });
  assert.deepEqual(await receiptsOf(db.pool, seed.owner), [], "a draft writes no receipt");
});

test("ensureSharedTemplate seeds the demo template once, refuses new text under its id, and drafts use its rules", async () => {
  const seed = await seedJob(db.pool);
  const first = await ensureSharedTemplate(db.pool, DEMO_RECAP_TEMPLATE);
  assert.deepEqual(await ensureSharedTemplate(db.pool, DEMO_RECAP_TEMPLATE), first, "idempotent");
  await assert.rejects(ensureSharedTemplate(db.pool, { ...DEMO_RECAP_TEMPLATE, bodyTpl: `${DEMO_RECAP_TEMPLATE.bodyTpl}!` }), /new id/);
  await assert.rejects(ensureSharedTemplate(db.pool, { ...DEMO_RECAP_TEMPLATE, id: "tpl_other", fieldRules: { topic: { max: 80 } } }), /exactly its placeholders/);
  const { owner } = setup({ defaultTemplateId: DEMO_RECAP_TEMPLATE.id });
  const draft = await owner.createJobDraft(seed.owner, { recipient: "dana@test.example", maxSends: 2, expiresAt: inAnHour() });
  assert.deepEqual(draft.job.template, first);
  assert.deepEqual(draft.job.field_rules, {
    first_name: { max: 40, single_line: true, required: true },
    topic: { max: 80, single_line: true, required: true },
    recap: { max: 600, required: true, free_text: true },
  });
});

test("createJobDraft refuses what the owner could not mean (invalid_job to the route), and names no other owner's rows", async () => {
  const seed = await seedJob(db.pool);
  const stranger = await seedJob(db.pool);
  const template = await sharedTemplate();
  const { owner } = setup({ defaultTemplateId: template });
  const base = { recipient: "dana@test.example", maxSends: 2, expiresAt: inAnHour() };
  // The field each draft refusal names for the confirm screen (an independent copy of the rule).
  const FIELD = { recipient_invalid: "recipient", max_sends_invalid: "max_sends", expires_at_invalid: "expires_at", purpose_invalid: "purpose", options_invalid: undefined, template_required: "template", template_not_found: "template", field_rules_required: "field_rules", field_rules_invalid: "field_rules", connection_required: "connection", agent_connection_required: "agent_connection" };
  const invalid = (input, reason) =>
    assert.rejects(
      owner.createJobDraft(seed.owner, { ...base, ...input }),
      (error) => error instanceof OwnerRefusal && error.reason === reason && error.code === "invalid_job" && error.options.field === FIELD[reason],
      reason,
    );
  await invalid({ recipient: "dana@test.example, bo@test.example" }, "recipient_invalid");
  for (const maxSends of [0, 51, 1.5, "2"]) await invalid({ maxSends }, "max_sends_invalid");
  for (const expiresAt of ["2020-01-01T00:00:00Z", new Date(Date.now() + 40 * 86400_000).toISOString(), "tonight"]) await invalid({ expiresAt }, "expires_at_invalid");
  await invalid({ purpose: `Recap${String.fromCharCode(0x202e)}` }, "purpose_invalid");
  await invalid({ aiReview: "sometimes" }, "options_invalid");
  await invalid({ templateId: stranger.template.id }, "template_not_found");
  await invalid({ templateId: seed.template.id }, "field_rules_required");
  await invalid({ fieldRules: { first_name: { max: 40 } } }, "field_rules_invalid");
  await invalid({ fieldRules: { ...FIELD_RULES, cc: { max: 10 } } }, "field_rules_invalid");
  await invalid({ fieldRules: { ...FIELD_RULES, topic: { max: 0 } } }, "field_rules_invalid");
  await invalid({ fieldRules: { ...FIELD_RULES, topic: { max: 80, sneaky: true } } }, "field_rules_invalid");
  await invalid({ connectionId: stranger.connection }, "connection_required");
  await invalid({ agentConnectionId: stranger.agentConnection }, "agent_connection_required");
  await refuses(setup().owner.createJobDraft(seed.owner, base), "template_required", "invalid_job");
  // Two Gmail connections and none named: the owner must say which.
  await db.pool.query("INSERT INTO connections (id, owner_id, provider, account_email) VALUES ($1, $2, 'gmail', 'second@example.com')", [newId("con"), seed.owner]);
  await invalid({}, "connection_required");
  assert.ok((await owner.createJobDraft(seed.owner, { ...base, connectionId: seed.connection, templateId: seed.template.id, fieldRules: { ...FIELD_RULES } })).job.job_id);
});

test("confirmJob: exactly the authority the screen showed, once; then the agent can use it", async () => {
  const seed = await seedJob(db.pool);
  await db.pool.query("UPDATE jobs SET status = 'stopped' WHERE id = $1", [seed.job]); // the seed's own job is out of the way
  const template = await sharedTemplate();
  const { owner, backend, stub } = setup({ defaultTemplateId: template });
  const draft = await owner.createJobDraft(seed.owner, { recipient: "dana@test.example", maxSends: 2, expiresAt: inAnHour(), autoSend: true });

  await refuses(owner.confirmJob(seed.owner, draft.job.job_id, "0".repeat(64)), "authority_changed", "authority_changed");
  await answers(owner.confirmJob((await seedJob(db.pool)).owner, draft.job.job_id, draft.authoritySha256), "not_found");
  const confirmed = await owner.confirmJob(seed.owner, draft.job.job_id, draft.authoritySha256);
  assert.equal(confirmed.policyVersion, 1);
  const receipts = await assertReceiptChain(db.pool, seed.owner);
  assert.deepEqual(typesOf(receipts), ["JOB_CONFIRMED"]);
  assert.equal(receipts[0].id, confirmed.receipt_id);
  assert.deepEqual(receipts[0].body.detail, { authority_sha256: draft.authoritySha256 });
  await refuses(owner.confirmJob(seed.owner, draft.job.job_id, draft.authoritySha256), "not_draft", "not_draft");

  assert.deepEqual((await backend.listJobs(connOf(seed))).map((j) => j.job_id), [draft.job.job_id]);
  const { result } = await backend.proposeSend({ job_id: draft.job.job_id, to: "dana@test.example", fields: { ...FIELDS } }, connOf(seed));
  assert.equal(result.status, "sent");
  assert.equal(stub.callCount, 1);
});

test("confirmJob refuses a job that changed since it was shown, expired, was stopped, or lost its agent", async () => {
  const template = await sharedTemplate();
  const cases = [
    ["authority_changed", "authority_changed", (seed, jobId) => db.pool.query("UPDATE jobs SET max_sends = 3 WHERE id = $1", [jobId])],
    ["job_expired", "job_expired", (seed, jobId) => db.pool.query("UPDATE jobs SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [jobId]), true],
    ["dispatch_stopped", "dispatch_stopped", (seed) => db.pool.query("UPDATE connections SET dispatch_enabled = false WHERE id = $1", [seed.connection])],
    ["agent_connection_revoked", "agent_connection_revoked", (seed) => db.pool.query("UPDATE agent_connections SET revoked_at = now() WHERE id = $1", [seed.agentConnection])],
  ];
  for (const [reason, code, change, rehash] of cases) {
    const seed = await seedJob(db.pool);
    const { owner } = setup({ defaultTemplateId: template });
    const draft = await owner.createJobDraft(seed.owner, { recipient: "dana@test.example", maxSends: 2, expiresAt: inAnHour() });
    await change(seed, draft.job.job_id);
    // An expired job also changed its authority (expires_at is in it): show the screen's new hash.
    const shown = rehash ? (await owner.listJobs(seed.owner)).find((j) => j.job.job_id === draft.job.job_id).authoritySha256 : draft.authoritySha256;
    await refuses(owner.confirmJob(seed.owner, draft.job.job_id, shown), reason, code);
    const [row] = (await db.pool.query("SELECT status FROM jobs WHERE id = $1", [draft.job.job_id])).rows;
    assert.equal(row.status, "draft", `${reason}: nothing changed`);
  }
});

test("rejectVersion: exactly the shown version, once, refusals thrown as listed codes; the agent then hears it is closed", async () => {
  const seed = await seedJob(db.pool);
  const { owner, backend, stub } = setup();
  const held = (await backend.proposeSend({ job_id: seed.job, to: "dana@test.example", ...CUSTOM, operation_id: "op-r" }, connOf(seed))).result;
  const [v1] = (await db.pool.query("SELECT sha256 FROM proposal_versions WHERE proposal_id = $1 AND version = 1", [held.proposal_id])).rows;

  await answers(owner.rejectVersion(held.proposal_id, 1, "0".repeat(64), seed.owner), "hash_mismatch");
  await answers(owner.rejectVersion(held.proposal_id, 1, v1.sha256, (await seedJob(db.pool)).owner), "not_found");
  const rejected = await owner.rejectVersion(held.proposal_id, 1, v1.sha256, seed.owner);
  assert.deepEqual(Object.keys(rejected), ["receipt_id"]);
  await answers(owner.rejectVersion(held.proposal_id, 1, v1.sha256, seed.owner), "not_pending");
  const last = (await receiptsOf(db.pool, seed.owner)).at(-1);
  assert.equal(last.type, "APPROVAL_REJECTED");
  assert.equal(last.id, rejected.receipt_id);
  assert.deepEqual(last.body.detail, { approver: seed.owner });

  assert.equal((await backend.getStatus(held.proposal_id, connOf(seed))).status, "rejected");
  assert.equal((await backend.revise({ proposal_id: held.proposal_id, ...CUSTOM }, connOf(seed))).result.reason_code, "not_revisable");
  const replay = (await backend.proposeSend({ job_id: seed.job, to: "dana@test.example", ...CUSTOM, operation_id: "op-r" }, connOf(seed))).result;
  assert.deepEqual(replay, { status: "denied", sent: false, approvable: false, reason_code: "not_revisable", receipt_id: rejected.receipt_id });
  assert.equal(stub.callCount, 0);

  const p = (await backend.proposeSend({ job_id: seed.job, to: "dana@test.example", ...CUSTOM }, connOf(seed))).result;
  const [old] = (await db.pool.query("SELECT sha256 FROM proposal_versions WHERE proposal_id = $1 AND version = 1", [p.proposal_id])).rows;
  await backend.revise({ proposal_id: p.proposal_id, fields: { ...FIELDS } }, connOf(seed));
  await answers(owner.rejectVersion(p.proposal_id, 1, old.sha256, seed.owner), "superseded");
});

test("STOP, resolve and approve in the route's shapes: receipt_ids, thrown refusals, another owner's row is not_found", async () => {
  const seed = await seedJob(db.pool);
  const stranger = await seedJob(db.pool);
  const { owner } = setup();
  await answers(owner.engageStop(seed.connection, stranger.owner), "not_found");
  const stopped = await owner.engageStop(seed.connection, seed.owner);
  assert.equal(stopped.receipt_ids.length, 1, "STOP_ENGAGED (no provider revoke configured)");
  assert.equal((await receiptsOf(db.pool, seed.owner)).at(-1).type, "STOP_ENGAGED");
  await answers(owner.resolveUnknown(newId("dsp"), "seen", seed.owner), "not_found");
  await answers(owner.approve(newId("prp"), 1, "0".repeat(64), seed.owner), "not_found");

  // A send the provider accepted is not UNKNOWN: resolving it is refused, never answered as done.
  const sent = await seedJob(db.pool);
  const { backend } = setup();
  const { result } = await backend.proposeSend({ job_id: sent.job, to: "dana@test.example", fields: { ...FIELDS } }, connOf(sent));
  assert.equal(result.status, "sent");
  const [dispatch] = (await db.pool.query("SELECT d.id FROM dispatches d JOIN proposal_versions v ON v.id = d.proposal_version_id WHERE v.proposal_id = $1", [result.proposal_id])).rows;
  await answers(owner.resolveUnknown(dispatch.id, "seen", sent.owner), "not_unknown");
  await answers(owner.resolveUnknown(dispatch.id, "not_arrived", sent.owner), "not_unknown");
});

test("connectState, assertAgentConnection and revokeAgentConnection: what the Connect screen shows, and an agent cut off at once", async () => {
  const seed = await seedJob(db.pool);
  const stranger = await seedJob(db.pool);
  const { owner, backend } = setup();
  await db.pool.query("UPDATE connections SET granted_scopes = $2 WHERE id = $1", [seed.connection, ["https://www.googleapis.com/auth/gmail.send"]]);
  let state = await owner.connectState(seed.owner);
  assert.deepEqual(state, {
    gmail: { address: "owner@example.com", grantedScopes: ["https://www.googleapis.com/auth/gmail.send"], status: "active" },
    agentConnection: { mcpUrl: `${HOST}/mcp`, label: "ChatGPT (declared)", lastUsedAt: null },
    stopped: false,
    connectionId: seed.connection,
    agentConnectionId: seed.agentConnection,
  });
  assert.ok(await backend.connection(seed.agentConnection));
  state = await owner.connectState(seed.owner);
  assert.match(state.agentConnection.lastUsedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/, "an /mcp call is seen");

  await owner.assertAgentConnection(seed.agentConnection, seed.owner);
  await answers(owner.assertAgentConnection(seed.agentConnection, stranger.owner), "not_found");
  await answers(owner.revokeAgentConnection(seed.agentConnection, stranger.owner), "not_found");
  const revoked = await owner.revokeAgentConnection(seed.agentConnection, seed.owner);
  const last = (await assertReceiptChain(db.pool, seed.owner)).at(-1);
  assert.equal(last.type, "AGENT_REVOKED");
  assert.equal(last.id, revoked.receipt_id);
  assert.equal(last.body.agent_connection, seed.agentConnection);
  assert.equal(await backend.connection(seed.agentConnection), null, "/mcp refuses it at once");
  await answers(owner.revokeAgentConnection(seed.agentConnection, seed.owner), "not_found");
  await answers(owner.assertAgentConnection(seed.agentConnection, seed.owner), "not_found");
  assert.equal((await owner.connectState(seed.owner)).agentConnection, null);

  await owner.engageStop(seed.connection, seed.owner);
  assert.equal((await owner.connectState(seed.owner)).stopped, true);
  assert.equal((await owner.connectState(seed.owner)).gmail.status, "stopped");
});

test("listPendingVersions, listJobs and listReceipts: this owner's only, with the diff baseline for a revision", async () => {
  const seed = await seedJob(db.pool);
  const other = await seedJob(db.pool);
  const { owner, backend } = setup();
  const held = (await backend.proposeSend({ job_id: seed.job, to: "dana@test.example", ...CUSTOM }, connOf(seed))).result;
  await backend.proposeSend({ job_id: other.job, to: "dana@test.example", ...CUSTOM }, connOf(other));

  let pending = await owner.listPendingVersions(seed.owner);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].proposalId, held.proposal_id);
  assert.equal(pending[0].baseline, null);
  assert.deepEqual(pending[0].reviewReasons, ["custom_content", "ai_review_unavailable"]);
  await backend.revise({ proposal_id: held.proposal_id, custom_subject: "Kickoff v2", custom_body: "Thursday at 3pm instead?" }, connOf(seed));
  pending = await owner.listPendingVersions(seed.owner);
  assert.equal(pending.length, 1, "only the current version is pending");
  assert.equal(pending[0].version, 2);
  assert.deepEqual(pending[0].baseline, { subject: CUSTOM.custom_subject, body: CUSTOM.custom_body });

  const jobs = await owner.listJobs(seed.owner);
  assert.deepEqual(jobs.map((j) => j.job.job_id), [seed.job]);
  assert.equal(jobs[0].authoritySha256, canonicalSha256Hex(jobs[0].job));
  const receipts = await owner.listReceipts(seed.owner, { job: seed.job });
  assert.ok(receipts.length >= 3 && receipts.every((r) => JSON.parse(r.payload).job === seed.job));
  assert.deepEqual(await owner.listReceipts(seed.owner, { job: other.job }), [], "another owner's job reads empty");
});

test("behind the real owner API: refusals are 409 by code, another owner's row is 404, never a 200 or a 500", async () => {
  const seed = await seedJob(db.pool);
  const stranger = await seedJob(db.pool);
  const { owner, backend } = setup();
  const errors = [];
  const handler = createOwnerApi({
    host: HOST,
    core: owner,
    owners: { owner: async (req) => ({ [seed.owner]: { id: seed.owner, email: "owner@example.com" } })[req.headers["x-test-owner"]] ?? null },
    oauthStore: { revokeAgentConnection: async () => undefined },
    onError: (error) => errors.push(error),
  });
  const server = createServer(async (req, res) => {
    if (!(await handler(req, res))) res.writeHead(418).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, value) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: HOST, "x-test-owner": seed.owner }, body: JSON.stringify(value) });
  try {
    const held = (await backend.proposeSend({ job_id: seed.job, to: "dana@test.example", ...CUSTOM }, connOf(seed))).result;
    const wrong = await post("/owner/versions/reject", { proposal_id: held.proposal_id, version: 1, shown_sha256: "0".repeat(64) });
    assert.equal(wrong.status, 409);
    assert.deepEqual(await wrong.json(), { error: "hash_mismatch" });
    const theirs = await post("/owner/stop", { connection_id: stranger.connection });
    assert.equal(theirs.status, 404);
    assert.deepEqual(await theirs.json(), { error: "not_found" });
    const confirm = await post("/owner/jobs/confirm", { job_id: seed.job, authority_sha256: "0".repeat(64) });
    assert.equal(confirm.status, 409);
    assert.deepEqual(await confirm.json(), { error: "not_draft" });
    const template = await sharedTemplate();
    const badDraft = await post("/owner/jobs", {
      connection_id: seed.connection,
      agent_connection_id: seed.agentConnection,
      recipient: "not an address",
      purpose: "Recap",
      template_id: template,
      max_sends: 2,
      expires_at: inAnHour(),
      auto_send: false,
      allow_custom_with_approval: true,
      ai_review: "custom_only",
    });
    assert.equal(badDraft.status, 409);
    assert.deepEqual(await badDraft.json(), { error: "invalid_job", field: "recipient" }, "the screen can point at the field");
    const stop = await post("/owner/stop", { connection_id: seed.connection });
    assert.equal(stop.status, 200);
    assert.equal((await stop.json()).receipt_ids.length, 1);
    assert.deepEqual(errors, [], "no refusal reached the 500 path");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
