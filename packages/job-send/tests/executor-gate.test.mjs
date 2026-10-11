import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { FLAGS, canonicalSha256Hex } from "../dist/index.js";
import { createMcpBackend } from "../dist/server/index.js";
import { startPostgres } from "./executor-support/pg.mjs";
import { CUSTOM, FIELDS, assertReceiptChain, jobRow, makeExecutor, receiptsOf, seedJob, typesOf } from "./executor-support/fixtures.mjs";

// The gate's wiring (spec: "The gate") and the McpBackend /mcp calls, against real Postgres: the
// database steps around the pure checks, store_version, dispatch_auto for what needs no owner, and
// revise / get_status / list_jobs scoped to the calling connection.

let db;
before(async () => {
  db = await startPostgres();
});
after(async () => {
  await db?.stop();
});

const connOf = (seed) => ({ id: seed.agentConnection, owner_id: seed.owner, client_id: "client-1", client_label: "ChatGPT (declared)" });
const rows = async (sql, values) => (await db.pool.query(sql, values)).rows;
const proposalsOf = (jobId) => rows("SELECT * FROM proposals WHERE job_id = $1", [jobId]);
const attemptsOf = (jobId) => rows("SELECT * FROM attempts WHERE job_id = $1 ORDER BY created_at", [jobId]);

function setup(options = {}) {
  const { executor, stub } = makeExecutor(db.pool);
  const backend = createMcpBackend({ pool: db.pool, executor, ...options });
  return { executor, stub, backend };
}

const hold = (flags) => ({
  outcome: "hold",
  flags,
  probs_bp: Object.fromEntries(FLAGS.map((flag) => [flag, flags.includes(flag) ? 9100 : 120])),
  model: "test-model",
  ms: 12,
});

test("propose_send: template fields inside the rules go out once, without asking", async () => {
  const seed = await seedJob(db.pool);
  const { stub, backend } = setup();
  const call = { job_id: seed.job, to: "Dana@Test.Example", fields: { ...FIELDS } };
  const { result, recipient, maxSends } = await backend.proposeSend(call, connOf(seed));

  assert.equal(result.status, "sent");
  assert.equal(result.version, 1);
  assert.equal(result.provider_message_id, "stub-msg-1");
  assert.equal(result.sends_left, 1);
  assert.equal(recipient, "dana@test.example");
  assert.equal(maxSends, 2);
  assert.equal(stub.callCount, 1);
  assert.ok(stub.sentText(0).includes("To: dana@test.example\r\n"), "sent to the job's recipient in its normalized form");

  const receipts = await assertReceiptChain(db.pool, seed.owner);
  assert.deepEqual(typesOf(receipts), ["PROPOSAL_CREATED", "DISPATCH_RESERVED", "PROVIDER_ACCEPTED"]);
  assert.equal(result.receipt_id, receipts.at(-1).id);
  assert.deepEqual(receipts[0].body.detail, { review_reasons: [] });
  assert.equal(receipts[0].body.version_sha256, result.version_sha256);

  const [attempt] = await attemptsOf(seed.job);
  assert.equal(attempt.tool, "propose_send");
  assert.equal(attempt.decision, "proposed");
  assert.equal(attempt.args_sha256, canonicalSha256Hex(call));
  assert.equal(JSON.stringify(attempt).includes(FIELDS.recap), false, "the arguments are stored only as their hash");

  assert.deepEqual(await backend.getStatus(result.proposal_id, connOf(seed)), {
    proposal_id: result.proposal_id,
    status: "accepted",
    version: 1,
    version_sha256: result.version_sha256,
    provider_message_id: "stub-msg-1",
  });
});

test("a job without auto_send holds even clean template fields for the owner", async () => {
  const seed = await seedJob(db.pool, { auto_send: false });
  const { stub, backend } = setup();
  const { result } = await backend.proposeSend({ job_id: seed.job, to: "dana@test.example", fields: { ...FIELDS } }, connOf(seed));
  assert.equal(result.status, "pending_approval");
  assert.deepEqual(result.review_reasons, []);
  assert.equal(stub.callCount, 0);
});

test("custom wording is held for the owner; with no reviewer configured the review counts as unavailable", async () => {
  const seed = await seedJob(db.pool);
  const { stub, backend } = setup();
  const { result } = await backend.proposeSend({ job_id: seed.job, to: "dana@test.example", ...CUSTOM }, connOf(seed));

  assert.equal(result.status, "pending_approval");
  assert.equal(result.version, 1);
  assert.deepEqual(result.review_reasons, ["custom_content", "ai_review_unavailable"]);
  assert.equal(stub.callCount, 0, "nothing reaches the provider without the owner");
  const receipts = await assertReceiptChain(db.pool, seed.owner);
  assert.deepEqual(typesOf(receipts), ["AI_REVIEW", "PROPOSAL_CREATED"]);
  assert.deepEqual(receipts[0].body.detail, { outcome: "unavailable", error: "not_configured", ms: 0 });
  assert.deepEqual(receipts[1].body.detail, { review_reasons: ["custom_content", "ai_review_unavailable"] });
  assert.equal((await attemptsOf(seed.job))[0].decision, "held");
  assert.equal((await backend.getStatus(result.proposal_id, connOf(seed))).status, "pending");
});

test("AI review runs per the job's setting, outside the transaction, and can only add a hold", async () => {
  const seen = [];
  const custom = await seedJob(db.pool);
  const held = setup({ review: async (input) => (seen.push(input), hold(["commitment"])) });
  const a = await held.backend.proposeSend({ job_id: custom.job, to: "dana@test.example", ...CUSTOM }, connOf(custom));
  assert.deepEqual(a.result.review_reasons, ["custom_content", "ai_review:commitment"]);
  assert.deepEqual(seen, [{ jobPurpose: "Send Dana at Acme a recap of Tuesday's call.", otherClients: [], subject: "Kickoff", freeText: CUSTOM.custom_body }]);
  const [review] = typesOf(await receiptsOf(db.pool, custom.owner));
  assert.equal(review, "AI_REVIEW");

  // custom_only: template fields are not reviewed and go out.
  const template = await seedJob(db.pool);
  const notAsked = setup({ review: async () => assert.fail("custom_only must not review template fields") });
  assert.equal((await notAsked.backend.proposeSend({ job_id: template.job, to: "dana@test.example", fields: { ...FIELDS } }, connOf(template))).result.status, "sent");

  // all_free_text: the free-text field is reviewed; a clear review adds nothing, so it goes out.
  const all = await seedJob(db.pool);
  await db.pool.query("UPDATE jobs SET ai_review = 'all_free_text' WHERE id = $1", [all.job]);
  const clearSeen = [];
  const clear = setup({ review: async (input) => (clearSeen.push(input), { ...hold([]), outcome: "clear" }) });
  assert.equal((await clear.backend.proposeSend({ job_id: all.job, to: "dana@test.example", fields: { ...FIELDS } }, connOf(all))).result.status, "sent");
  assert.equal(clearSeen[0].freeText, FIELDS.recap);

  // off: custom wording still needs the owner, but nothing is reviewed.
  const off = await seedJob(db.pool);
  await db.pool.query("UPDATE jobs SET ai_review = 'off' WHERE id = $1", [off.job]);
  const quiet = setup({ review: async () => assert.fail("off must not review") });
  assert.deepEqual((await quiet.backend.proposeSend({ job_id: off.job, to: "dana@test.example", ...CUSTOM }, connOf(off))).result.review_reasons, ["custom_content"]);

  // A reviewer that throws is unavailable, never a pass.
  const broken = await seedJob(db.pool);
  const throws = setup({ review: async () => { throw new Error("boom"); } });
  assert.deepEqual((await throws.backend.proposeSend({ job_id: broken.job, to: "dana@test.example", ...CUSTOM }, connOf(broken))).result.review_reasons, [
    "custom_content",
    "ai_review_unavailable",
  ]);
});

test("a review flag outside the allow-list fails closed; auto_send turned off mid-call leaves the version waiting", async () => {
  // An unknown flag from the reviewer: nothing is stored or sent, rather than the hold being dropped.
  const unknown = await seedJob(db.pool);
  const odd = setup({ review: async () => ({ ...hold([]), outcome: "hold", flags: ["made_up_flag"] }) });
  await assert.rejects(odd.backend.proposeSend({ job_id: unknown.job, to: "dana@test.example", ...CUSTOM }, connOf(unknown)), /not an ask-me reason/);
  assert.deepEqual(await proposalsOf(unknown.job), []);
  assert.equal(odd.stub.callCount, 0);

  // The owner turns auto_send off while the review runs: the reservation says needs_review, and the
  // agent hears the truth, that the version waits for the owner.
  const flipped = await seedJob(db.pool);
  await db.pool.query("UPDATE jobs SET ai_review = 'all_free_text' WHERE id = $1", [flipped.job]);
  const mid = setup({
    review: async () => {
      await db.pool.query("UPDATE jobs SET auto_send = false WHERE id = $1", [flipped.job]);
      return { ...hold([]), outcome: "clear" };
    },
  });
  const { result } = await mid.backend.proposeSend({ job_id: flipped.job, to: "dana@test.example", fields: { ...FIELDS } }, connOf(flipped));
  assert.equal(result.status, "pending_approval");
  assert.deepEqual(result.review_reasons, []);
  assert.equal(mid.stub.callCount, 0);
  assert.equal((await mid.backend.getStatus(result.proposal_id, connOf(flipped))).status, "pending");
});

test("denials: the rule that fired, ATTEMPT_DENIED and an attempts row, and nothing else", async () => {
  const cases = [
    ["job_not_found", async (seed) => ({ job_id: (await seedJob(db.pool)).job, to: "dana@test.example", fields: { ...FIELDS } })],
    // The same owner's job, bound to the owner's OTHER agent connection: still not this connection's.
    [
      "job_not_found",
      async (seed) => {
        await db.pool.query("INSERT INTO agent_connections (id, owner_id, client_id, client_label) VALUES ($1, $2, 'client-2', 'Other agent')", [
          `${seed.agentConnection}_2`,
          seed.owner,
        ]);
        await db.pool.query("UPDATE jobs SET agent_connection_id = $2 WHERE id = $1", [seed.job, `${seed.agentConnection}_2`]);
        return null;
      },
    ],
    ["job_inactive", async (seed) => (await db.pool.query("UPDATE jobs SET status = 'draft' WHERE id = $1", [seed.job]), null)],
    ["job_expired", async (seed) => (await db.pool.query("UPDATE jobs SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [seed.job]), null)],
    ["dispatch_stopped", async (seed) => (await db.pool.query("UPDATE connections SET dispatch_enabled = false WHERE id = $1", [seed.connection]), null)],
    ["recipient_invalid", async (seed) => ({ job_id: seed.job, to: "dana@test.example, bo@test.example", fields: { ...FIELDS } })],
    ["recipient_not_in_job", async (seed) => ({ job_id: seed.job, to: "bo@test.example", fields: { ...FIELDS } })],
    ["limit_reached", async (seed) => (await db.pool.query("UPDATE jobs SET sends_reserved = max_sends WHERE id = $1", [seed.job]), null)],
    ["field_invalid", async (seed) => ({ job_id: seed.job, to: "dana@test.example", fields: { ...FIELDS, topic: "a\nb" } }), "topic"],
    ["field_not_allowed", async (seed) => ({ job_id: seed.job, to: "dana@test.example", fields: { ...FIELDS, cc: "bo@test.example" } }), undefined],
    ["custom_not_allowed", async (seed) => (await db.pool.query("UPDATE jobs SET allow_custom_with_approval = false WHERE id = $1", [seed.job]), { job_id: seed.job, to: "dana@test.example", ...CUSTOM })],
  ];
  for (const [reason, arrange, field] of cases) {
    const seed = await seedJob(db.pool);
    const { stub, backend } = setup();
    const call = (await arrange(seed)) ?? { job_id: seed.job, to: "dana@test.example", fields: { ...FIELDS } };
    const { result } = await backend.proposeSend(call, connOf(seed));
    assert.equal(result.status, "denied", reason);
    assert.equal(result.reason_code, reason);
    assert.equal(result.approvable, false);
    assert.equal(stub.callCount, 0, reason);
    assert.deepEqual(await proposalsOf(seed.job), [], `${reason}: no proposal`);
    const receipts = await assertReceiptChain(db.pool, seed.owner);
    assert.deepEqual(typesOf(receipts), ["ATTEMPT_DENIED"], reason);
    const detail = receipts[0].body.detail;
    assert.equal(detail.reason_code, reason);
    assert.equal(detail.args_sha256, canonicalSha256Hex(call));
    assert.equal(detail.field, field, `${reason}: only a field the job defines is named`);
    assert.equal(receipts[0].body.job, reason === "job_not_found" ? null : seed.job, `${reason}: another connection's job is never named`);
    const attempts = await rows("SELECT * FROM attempts WHERE agent_connection_id = $1", [seed.agentConnection]);
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0].decision, "denied");
    assert.equal(attempts[0].reason_code, reason);
  }
});

test("rate_limited: ten refused attempts in an hour, per connection and job, stop the next call", async () => {
  const seed = await seedJob(db.pool);
  const { stub, backend } = setup();
  for (let i = 0; i < 10; i++) {
    const { result } = await backend.proposeSend({ job_id: seed.job, to: "bo@test.example", fields: { ...FIELDS } }, connOf(seed));
    assert.equal(result.reason_code, "recipient_not_in_job");
  }
  const { result } = await backend.proposeSend({ job_id: seed.job, to: "dana@test.example", fields: { ...FIELDS } }, connOf(seed));
  assert.equal(result.reason_code, "rate_limited", "even a good call");
  assert.equal(stub.callCount, 0);
  // Denials older than an hour no longer count.
  await db.pool.query("UPDATE attempts SET created_at = created_at - interval '61 minutes' WHERE job_id = $1", [seed.job]);
  assert.equal((await backend.proposeSend({ job_id: seed.job, to: "dana@test.example", fields: { ...FIELDS } }, connOf(seed))).result.status, "sent");
});

test("a repeated operation_id answers with the existing proposal and creates nothing, even in a race", async () => {
  const seed = await seedJob(db.pool);
  const { stub, backend } = setup();
  const call = { job_id: seed.job, to: "dana@test.example", fields: { ...FIELDS }, operation_id: "op-1" };
  const first = (await backend.proposeSend(call, connOf(seed))).result;
  const again = (await backend.proposeSend(call, connOf(seed))).result;
  assert.equal(first.status, "sent");
  assert.deepEqual(again, first, "the same answer, receipt and all");
  assert.equal(stub.callCount, 1, "one send");
  assert.equal((await proposalsOf(seed.job)).length, 1);
  assert.equal((await attemptsOf(seed.job)).length, 1, "a replay records no new attempt");
  // The replay reports the proposal, even after STOP: it is a status read, not a new send.
  await db.pool.query("UPDATE connections SET dispatch_enabled = false WHERE id = $1", [seed.connection]);
  assert.deepEqual((await backend.proposeSend(call, connOf(seed))).result, first);

  // A real race: every caller passes the replay check, then waits in the AI review until all four
  // are there, so all four reach store_version together and UNIQUE (job_id, operation_id) decides.
  const raced = await seedJob(db.pool);
  let arrived = 0;
  let release;
  const allThere = new Promise((resolve) => (release = resolve));
  const racing = setup({
    review: async () => {
      if (++arrived === 4) release();
      await allThere;
      return { outcome: "unavailable", error: "not_configured", ms: 0 };
    },
  });
  const held = { job_id: raced.job, to: "dana@test.example", ...CUSTOM, operation_id: "op-race" };
  const answers = await Promise.all([1, 2, 3, 4].map(() => racing.backend.proposeSend(held, connOf(raced))));
  assert.equal(arrived, 4, "all four reached the review");
  assert.equal(new Set(answers.map((a) => a.result.proposal_id)).size, 1, "every racer names one proposal");
  assert.ok(answers.every((a) => a.result.status === "pending_approval"));
  assert.equal((await proposalsOf(raced.job)).length, 1);
});

test("revise: a new pending version, the old one superseded, PROPOSAL_REVISED with both hashes, never sent by itself", async () => {
  const seed = await seedJob(db.pool);
  const { stub, backend, executor } = setup();
  const v1 = (await backend.proposeSend({ job_id: seed.job, to: "dana@test.example", ...CUSTOM }, connOf(seed))).result;
  const v2 = (await backend.revise({ proposal_id: v1.proposal_id, fields: { ...FIELDS } }, connOf(seed))).result;
  assert.equal(v2.status, "pending_approval");
  assert.equal(v2.version, 2);
  assert.deepEqual(v2.review_reasons, []);
  assert.equal(stub.callCount, 0, "a revision waits for the owner even when nothing holds it");
  const versions = await rows("SELECT version, state, sha256 FROM proposal_versions WHERE proposal_id = $1 ORDER BY version", [v1.proposal_id]);
  assert.deepEqual(versions.map((v) => [v.version, v.state]), [[1, "superseded"], [2, "pending"]]);
  const revised = (await receiptsOf(db.pool, seed.owner)).at(-1);
  assert.equal(revised.type, "PROPOSAL_REVISED");
  assert.deepEqual(revised.body.detail, { from_version: 1, from_sha256: versions[0].sha256, to_sha256: versions[1].sha256, review_reasons: [] });
  assert.equal(revised.body.version, 2);

  // Approved and sent, it is closed: another revision is refused.
  const outcome = await executor.approve(v1.proposal_id, 2, versions[1].sha256, seed.owner);
  assert.equal(outcome.kind, "provider");
  const late = (await backend.revise({ proposal_id: v1.proposal_id, ...CUSTOM }, connOf(seed))).result;
  assert.equal(late.reason_code, "not_revisable");

  // Another connection cannot see it at all.
  const other = await seedJob(db.pool);
  assert.equal((await backend.revise({ proposal_id: v1.proposal_id, ...CUSTOM }, connOf(other))).result.reason_code, "job_not_found");
  assert.equal(await backend.getStatus(v1.proposal_id, connOf(other)), null);

  // Nor can the same owner's other agent connection.
  await db.pool.query("INSERT INTO agent_connections (id, owner_id, client_id, client_label) VALUES ($1, $2, 'client-2', 'Other agent')", [
    `${seed.agentConnection}_2`,
    seed.owner,
  ]);
  const sibling = { id: `${seed.agentConnection}_2`, owner_id: seed.owner, client_id: "client-2", client_label: "Other agent" };
  assert.equal(await backend.getStatus(v1.proposal_id, sibling), null);
  assert.equal((await backend.revise({ proposal_id: v1.proposal_id, ...CUSTOM }, sibling)).result.reason_code, "job_not_found");
  assert.deepEqual(await backend.listJobs(sibling), []);
});

test("revise stops at version 5, and two racing revisions of one version make exactly one", async () => {
  const seed = await seedJob(db.pool);
  const { backend } = setup();
  const { proposal_id } = (await backend.proposeSend({ job_id: seed.job, to: "dana@test.example", ...CUSTOM }, connOf(seed))).result;
  const racers = await Promise.all([1, 2].map((i) => backend.revise({ proposal_id, custom_subject: `Try ${i}`, custom_body: "Same plan?" }, connOf(seed))));
  const statuses = racers.map((r) => r.result.status).sort();
  assert.deepEqual(statuses, ["denied", "pending_approval"]);
  assert.equal(racers.find((r) => r.result.status === "denied").result.reason_code, "not_revisable");
  for (let v = 3; v <= 5; v++) {
    assert.equal((await backend.revise({ proposal_id, custom_subject: `v${v}`, custom_body: "Same plan?" }, connOf(seed))).result.version, v);
  }
  assert.equal((await backend.revise({ proposal_id, custom_subject: "v6", custom_body: "Same plan?" }, connOf(seed))).result.reason_code, "not_revisable");
  assert.equal((await rows("SELECT count(*)::int AS n FROM proposal_versions WHERE proposal_id = $1", [proposal_id]))[0].n, 5);
});

test("list_jobs and connection(): only this connection's active, unexpired jobs; a revoked connection is gone", async () => {
  const seed = await seedJob(db.pool);
  const other = await seedJob(db.pool);
  const { backend } = setup();
  const listed = await backend.listJobs(connOf(seed));
  assert.deepEqual(listed.map((j) => j.job_id), [seed.job]);
  assert.deepEqual(listed[0], {
    job_id: seed.job,
    purpose: "Send Dana at Acme a recap of Tuesday's call.",
    recipient: "dana@test.example",
    template_fields: { ...seed.renderJob.field_rules },
    allow_custom_with_approval: true,
    sends_left: 2,
    expires_at: seed.renderJob.expires_at,
  });
  await db.pool.query("UPDATE jobs SET sends_reserved = 1 WHERE id = $1", [seed.job]);
  assert.equal((await backend.listJobs(connOf(seed)))[0].sends_left, 1);
  await db.pool.query("UPDATE jobs SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [seed.job]);
  assert.deepEqual(await backend.listJobs(connOf(seed)), []);
  assert.deepEqual((await backend.listJobs(connOf(other))).map((j) => j.job_id), [other.job]);

  assert.deepEqual(await backend.connection(seed.agentConnection), connOf(seed));
  await db.pool.query("UPDATE agent_connections SET revoked_at = now() WHERE id = $1", [seed.agentConnection]);
  assert.equal(await backend.connection(seed.agentConnection), null);
});

test("mentions_other_client: another client's label holds the version; the recipient's own label does not", async () => {
  const seed = await seedJob(db.pool);
  const contact = (email, name, label) =>
    db.pool.query("INSERT INTO contacts (id, owner_id, email, name, client_label) VALUES ($1, $2, $3, $4, $5)", [
      `ct_${Math.random().toString(36).slice(2)}`,
      seed.owner,
      email,
      name,
      label,
    ]);
  await contact("dana@test.example", "Dana", "Acme");
  // A colleague at the recipient's own company: "Acme" is still not another client.
  await contact("carl@test.example", "Carl", "Acme");
  await contact("bo@globex.example", "Bo", "Globex");
  const { stub, backend } = setup();
  const own = await backend.proposeSend({ job_id: seed.job, to: "dana@test.example", fields: { ...FIELDS, recap: "Acme starts Monday." } }, connOf(seed));
  assert.equal(own.result.status, "sent");
  const other = await backend.proposeSend({ job_id: seed.job, to: "dana@test.example", fields: { ...FIELDS, recap: "Globex starts Monday too." } }, connOf(seed));
  assert.equal(other.result.status, "pending_approval");
  assert.deepEqual(other.result.review_reasons, ["mentions_other_client"]);
  assert.equal(stub.callCount, 1);
  assert.equal((await jobRow(db.pool, seed.job)).sends_reserved, 1);
});
