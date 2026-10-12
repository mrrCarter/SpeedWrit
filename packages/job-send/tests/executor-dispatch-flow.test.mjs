import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { NotFoundError, createGmailProvider, gmailRaw } from "../dist/index.js";
import { createStubMailProvider } from "./acceptance/support/stub-mail-provider.mjs";
import { startPostgres } from "./executor-support/pg.mjs";
import {
  CUSTOM,
  assertReceiptChain,
  dispatchesOf,
  jobRow,
  makeExecutor,
  receiptsOf,
  seedJob,
  storeVersion,
  tamperVersion,
  typesOf,
  waitFor,
} from "./executor-support/fixtures.mjs";

let db;
before(async () => {
  db = await startPostgres();
});
after(async () => {
  await db?.stop();
});

const versionRow = async (id) => (await db.pool.query("SELECT * FROM proposal_versions WHERE id = $1", [id])).rows[0];
const proposalRow = async (id) => (await db.pool.query("SELECT * FROM proposals WHERE id = $1", [id])).rows[0];
const lastReceipt = async (owner) => (await receiptsOf(db.pool, owner)).at(-1);

test("auto send: exactly one provider call, carrying the STORED bytes (A1)", async () => {
  const seed = await seedJob(db.pool);
  const { executor, stub, connections } = makeExecutor(db.pool);
  // The stored bytes carry a header a re-render would not produce.
  const v = await storeVersion(executor, db.pool, seed, { versionTag: "0123456789abcdef" });
  const outcome = await executor.dispatch_auto(v.versionId);

  assert.equal(outcome.kind, "provider");
  assert.deepEqual(outcome.outcome, { status: "accepted", providerMessageId: "stub-msg-1" });
  assert.equal(stub.callCount, 1);
  const stored = (await versionRow(v.versionId)).mime;
  assert.deepEqual(Buffer.from(stub.calls[0].bytes), stored, "the provider got the stored bytes");
  assert.ok(stub.sentText(0).includes("X-Writ-Version: 0123456789abcdef"));
  assert.deepEqual(connections, [{ id: seed.connection, provider: "gmail", account_email: "owner@example.com" }]);

  const [d] = await dispatchesOf(db.pool, v.versionId);
  assert.equal(d.status, "accepted");
  assert.equal(d.provider_message_id, "stub-msg-1");
  assert.equal(d.via, "auto");
  assert.equal((await versionRow(v.versionId)).state, "dispatched");
  assert.equal((await proposalRow(v.proposalId)).status, "accepted");
  assert.equal((await jobRow(db.pool, seed.job)).sends_reserved, 1, "1 of 2 used");

  const receipts = await assertReceiptChain(db.pool, seed.owner);
  assert.deepEqual(typesOf(receipts), ["PROPOSAL_CREATED", "DISPATCH_RESERVED", "PROVIDER_ACCEPTED"]);
  const accepted = receipts.at(-1);
  assert.equal(outcome.receipt_id, accepted.id);
  assert.deepEqual(accepted.body.detail, { dispatch: d.id, provider: "gmail", provider_message_id: "stub-msg-1" });
  assert.equal(accepted.body.version_sha256, v.sha256);
  assert.equal(accepted.body.client_label, "ChatGPT (declared)");
});

test("a refused reservation creates no dispatch and writes DISPATCH_REFUSED", async (t) => {
  const cases = {
    needs_review: { reasons: ["custom_content"] },
    "needs_review (auto_send off)": { job: { auto_send: false } },
    job_expired: { job: { expires_at: new Date(Date.now() - 1000) } },
    "job_expired (status)": { job: { status: "expired" } },
    job_inactive: { job: { status: "stopped" } },
  };
  for (const [label, spec] of Object.entries(cases)) {
    await t.test(label, async () => {
      const seed = await seedJob(db.pool, spec.job ?? {});
      const { executor, stub } = makeExecutor(db.pool);
      const v = await storeVersion(executor, db.pool, seed, { reasons: spec.reasons ?? [] });
      const outcome = await executor.dispatch_auto(v.versionId);
      const reason = label.split(" ")[0];
      assert.equal(outcome.kind, "refused");
      assert.equal(outcome.reason, reason);
      assert.equal(stub.callCount, 0);
      assert.deepEqual(await dispatchesOf(db.pool, v.versionId), []);
      assert.equal((await versionRow(v.versionId)).state, "pending");
      assert.equal((await proposalRow(v.proposalId)).status, "pending");
      assert.equal((await jobRow(db.pool, seed.job)).sends_reserved, 0);
      const receipts = await assertReceiptChain(db.pool, seed.owner);
      assert.deepEqual(typesOf(receipts), ["PROPOSAL_CREATED", "DISPATCH_REFUSED"]);
      assert.equal(outcome.receipt_id, receipts[1].id);
      assert.deepEqual(receipts[1].body.detail, { reason, via: "auto" });
      assert.equal(receipts[1].body.proposal, v.proposalId);
    });
  }

  await t.test("superseded: an older version, and a version already dispatched", async () => {
    const seed = await seedJob(db.pool);
    const { executor, stub } = makeExecutor(db.pool);
    const v1 = await storeVersion(executor, db.pool, seed);
    const v2 = await storeVersion(executor, db.pool, seed, { proposalId: v1.proposalId, version: 2, call: { fields: { first_name: "Dana", topic: "kickoff", recap: "See you Friday." } } });
    assert.deepEqual(await executor.dispatch_auto(v1.versionId), { kind: "refused", reason: "superseded", receipt_id: (await lastReceipt(seed.owner)).id });
    assert.equal((await executor.dispatch_auto(v2.versionId)).kind, "provider");
    const again = await executor.dispatch_auto(v2.versionId);
    assert.equal(again.kind, "refused");
    assert.equal(again.reason, "superseded");
    assert.equal(stub.callCount, 1, "a dispatched version is never sent twice");
    assert.equal((await dispatchesOf(db.pool, v2.versionId)).length, 1);
  });

  await t.test("recipient_not_in_job: the job's recipient changed under the stored version", async () => {
    const seed = await seedJob(db.pool);
    const { executor, stub } = makeExecutor(db.pool);
    const v = await storeVersion(executor, db.pool, seed);
    await db.pool.query("UPDATE jobs SET recipient_email = 'bo@test.example' WHERE id = $1", [seed.job]);
    const outcome = await executor.dispatch_auto(v.versionId);
    assert.equal(outcome.reason, "recipient_not_in_job");
    assert.equal(stub.callCount, 0);
  });

  await t.test("an unknown version is a NotFoundError and writes nothing", async () => {
    const { executor } = makeExecutor(db.pool);
    await assert.rejects(executor.dispatch_auto("pv_missing"), NotFoundError);
  });
});

test("NOT SENT releases the reservation (A12)", async (t) => {
  for (const status of [400, 401, 403, 429]) {
    await t.test(`provider ${status}`, async () => {
      const seed = await seedJob(db.pool, { max_sends: 1 });
      const { executor, stub } = makeExecutor(db.pool, { script: [`not_sent:http_${status}`] });
      const v = await storeVersion(executor, db.pool, seed);
      const outcome = await executor.dispatch_auto(v.versionId);
      assert.deepEqual(outcome.outcome, { status: "not_sent", errorClass: `http_${status}` });
      assert.equal(stub.callCount, 1);
      assert.equal((await jobRow(db.pool, seed.job)).sends_reserved, 0, "the slot is free again");
      const [d] = await dispatchesOf(db.pool, v.versionId);
      assert.equal(d.status, "not_sent");
      assert.equal(d.error_class, `http_${status}`);
      assert.equal((await proposalRow(v.proposalId)).status, "not_sent");
      const receipts = await assertReceiptChain(db.pool, seed.owner);
      assert.deepEqual(typesOf(receipts), ["PROPOSAL_CREATED", "DISPATCH_RESERVED", "NOT_SENT"]);
      assert.equal(receipts.at(-1).body.detail.error_class, `http_${status}`);
      // The released slot is usable: with max_sends 1, a new version still goes out.
      const next = await storeVersion(executor, db.pool, seed);
      assert.equal((await executor.dispatch_auto(next.versionId)).outcome.status, "accepted");
      assert.equal((await jobRow(db.pool, seed.job)).sends_reserved, 1);
    });
  }
});

test("UNKNOWN keeps the reservation, makes one call and never resends (A11)", async (t) => {
  const cases = {
    "provider timeout": { script: ["unknown:timeout"], errorClass: "timeout" },
    "provider 503": { script: ["unknown:http_503"], errorClass: "http_503" },
    "connection reset": { script: ["hold"], reset: true, errorClass: "ECONNRESET" },
    "the provider throws": { throws: true, errorClass: "exception" },
    "no answer within the executor's budget": { script: ["hold"], timeoutMs: 150, errorClass: "timeout" },
  };
  for (const [label, spec] of Object.entries(cases)) {
    await t.test(label, async () => {
      const seed = await seedJob(db.pool);
      const stub = createStubMailProvider({ script: spec.script ?? [] });
      let calls = 0;
      const throwing = { send: async () => { calls += 1; throw new TypeError("boom: do not record me"); } };
      const { executor } = makeExecutor(db.pool, {
        stub,
        providerTimeoutMs: spec.timeoutMs,
        mailProviderFor: spec.throws ? () => throwing : () => stub.provider,
      });
      const v = await storeVersion(executor, db.pool, seed);
      const pending = executor.dispatch_auto(v.versionId);
      if (spec.reset) {
        await waitFor(() => stub.heldCount === 1, 5000, "the held call");
        stub.reset(0);
      }
      const outcome = await pending;
      assert.deepEqual(outcome.outcome, { status: "unknown", errorClass: spec.errorClass });
      assert.equal(spec.throws ? calls : stub.callCount, 1, "one provider call");
      assert.equal((await jobRow(db.pool, seed.job)).sends_reserved, 1, "the reservation stays held");
      assert.equal((await dispatchesOf(db.pool, v.versionId))[0].status, "unknown");
      assert.equal((await proposalRow(v.proposalId)).status, "unknown");
      const again = await executor.dispatch_auto(v.versionId);
      assert.equal(again.reason, "superseded");
      assert.equal(spec.throws ? calls : stub.callCount, 1, "nothing resends");
      const receipts = await assertReceiptChain(db.pool, seed.owner);
      assert.deepEqual(typesOf(receipts), ["PROPOSAL_CREATED", "DISPATCH_RESERVED", "OUTCOME_UNKNOWN", "DISPATCH_REFUSED"]);
      assert.ok(!receipts.some((r) => r.payload.includes("do not record me")), "error messages are not recorded");
      if (spec.timeoutMs) stub.release(0);
    });
  }
});

test("A13: a send that never returns becomes UNKNOWN through the sweeper, and is never resent", async () => {
  const seed = await seedJob(db.pool);
  const { executor, stub } = makeExecutor(db.pool, { script: ["hold"] });
  const v = await storeVersion(executor, db.pool, seed);
  const inFlight = executor.dispatch_auto(v.versionId);
  await waitFor(() => stub.heldCount === 1, 5000, "the provider call");
  const [reserved] = await dispatchesOf(db.pool, v.versionId);
  assert.equal(reserved.status, "reserved");

  assert.deepEqual(await executor.sweep(new Date(Date.now() + 30_000)), [], "not before 60 s");
  assert.deepEqual(await executor.sweep(new Date(Date.now() + 61_000)), [reserved.id]);
  const [swept] = await dispatchesOf(db.pool, v.versionId);
  assert.equal(swept.status, "unknown");
  assert.equal(swept.error_class, "no_provider_result");
  assert.equal((await proposalRow(v.proposalId)).status, "unknown");
  assert.equal((await jobRow(db.pool, seed.job)).sends_reserved, 1, "the reservation stays held");
  assert.deepEqual(await executor.sweep(new Date(Date.now() + 120_000)), [], "a swept dispatch is not swept again");
  assert.equal(stub.callCount, 1, "the sweeper never sends");
  assert.equal((await executor.dispatch_auto(v.versionId)).reason, "superseded");
  assert.equal(stub.callCount, 1, "and nothing resends");

  let receipts = await assertReceiptChain(db.pool, seed.owner);
  assert.deepEqual(typesOf(receipts), ["PROPOSAL_CREATED", "DISPATCH_RESERVED", "OUTCOME_UNKNOWN", "DISPATCH_REFUSED"]);
  assert.deepEqual(receipts[2].body.detail, { dispatch: reserved.id, error_class: "no_provider_result", source: "sweeper" });

  // If the "dead" call ever answers, the answer is recorded as late and the state stays UNKNOWN.
  stub.release(0, "accept");
  const late = await inFlight;
  assert.equal(late.outcome.status, "accepted");
  assert.equal((await dispatchesOf(db.pool, v.versionId))[0].status, "unknown");
  receipts = await assertReceiptChain(db.pool, seed.owner);
  assert.equal(receipts.at(-1).type, "PROVIDER_ACCEPTED");
  assert.equal(receipts.at(-1).body.detail.late, true);
  assert.equal(stub.callCount, 1);
});

test("STOP before a reservation: dispatch_stopped for a new send and for an approval (A14)", async () => {
  const seed = await seedJob(db.pool);
  const revoked = [];
  const { executor, stub } = makeExecutor(db.pool, {
    revoke: async (connection) => (revoked.push(connection.id), { ok: true, status: 200 }),
  });
  const held = await storeVersion(executor, db.pool, seed, { call: { ...CUSTOM }, reasons: ["custom_content"] });
  const auto = await storeVersion(executor, db.pool, seed);

  const stop = await executor.engageStop(seed.connection, seed.owner);
  assert.equal(stop.revoked, true);
  assert.deepEqual(revoked, [seed.connection]);
  const con = (await db.pool.query("SELECT dispatch_enabled, status FROM connections WHERE id = $1", [seed.connection])).rows[0];
  assert.deepEqual(con, { dispatch_enabled: false, status: "revoked" });

  assert.equal((await executor.dispatch_auto(auto.versionId)).reason, "dispatch_stopped");
  const approval = await executor.approve(held.proposalId, 1, held.sha256, seed.owner);
  assert.equal(approval.kind, "refused");
  assert.equal(approval.reason, "dispatch_stopped");
  assert.equal(stub.callCount, 0);
  assert.deepEqual(
    (await db.pool.query("SELECT id FROM approvals WHERE proposal_version_id = $1", [held.versionId])).rows,
    [],
    "the refused approval left no approval row",
  );

  const receipts = await assertReceiptChain(db.pool, seed.owner);
  assert.deepEqual(typesOf(receipts), [
    "PROPOSAL_CREATED",
    "PROPOSAL_CREATED",
    "STOP_ENGAGED",
    "PROVIDER_REVOKE_REQUESTED",
    "PROVIDER_REVOKE_RESULT",
    "DISPATCH_REFUSED",
    "APPROVAL_REFUSED",
  ]);
  assert.deepEqual(receipts[4].body.detail, { connection: seed.connection, provider: "gmail", ok: true, status: 200 });
  assert.deepEqual(receipts[6].body.detail, { reason: "dispatch_stopped", approver: seed.owner });
});

test("STOP between the reservation and the call: NOT SENT stopped_before_call, no provider call", async () => {
  const seed = await seedJob(db.pool);
  const { executor, stub } = makeExecutor(db.pool, { revoke: async () => ({ ok: false, status: 503 }) });
  const v = await storeVersion(executor, db.pool, seed, { call: { ...CUSTOM }, reasons: ["custom_content"] });
  const reserved = await executor.approveAndReserve(v.proposalId, 1, v.sha256, seed.owner);
  assert.equal(reserved.ok, true);
  const stop = await executor.engageStop(seed.connection, seed.owner);
  assert.equal(stop.revoked, false);

  const outcome = await executor.sendReserved(reserved.reservation);
  assert.deepEqual(outcome.outcome, { status: "not_sent", errorClass: "stopped_before_call" });
  assert.equal(stub.callCount, 0);
  assert.equal((await jobRow(db.pool, seed.job)).sends_reserved, 0, "released");
  const con = (await db.pool.query("SELECT dispatch_enabled, status FROM connections WHERE id = $1", [seed.connection])).rows[0];
  assert.deepEqual(con, { dispatch_enabled: false, status: "stopped" }, "a failed revoke leaves it stopped, not revoked");
  const receipts = await assertReceiptChain(db.pool, seed.owner);
  assert.deepEqual(typesOf(receipts), [
    "PROPOSAL_CREATED",
    "APPROVAL_GRANTED",
    "DISPATCH_RESERVED",
    "STOP_ENGAGED",
    "PROVIDER_REVOKE_REQUESTED",
    "PROVIDER_REVOKE_RESULT",
    "NOT_SENT",
  ]);
  assert.equal(receipts.at(-1).body.detail.error_class, "stopped_before_call");
});

test("integrity: a stored version edited behind the code is refused", async (t) => {
  const flip = (buffer) => {
    const copy = Buffer.from(buffer);
    copy[copy.length - 5] ^= 0x01;
    return copy;
  };
  const cases = {
    "one MIME byte": async (v) => tamperVersion(db.pool, v.versionId, "mime = $2", [flip(v.mime)]),
    "the canonical subject": async (v) => tamperVersion(db.pool, v.versionId, "canonical = jsonb_set(canonical, '{subject}', '\"Other\"')"),
    "the stored hash": async (v) => tamperVersion(db.pool, v.versionId, "sha256 = $2", ["0".repeat(64)]),
    "canonical and hash rewritten together, MIME untouched": async (v) => {
      const row = await versionRow(v.versionId);
      const { versionSha256 } = await import("../dist/index.js");
      const canonical = { ...row.canonical, mime_sha256: "1".repeat(64) };
      await tamperVersion(db.pool, v.versionId, "canonical = $2::jsonb, sha256 = $3", [JSON.stringify(canonical), versionSha256(canonical)]);
    },
    "a consistent canonical that names another connection": async (v) => {
      const row = await versionRow(v.versionId);
      const { versionSha256 } = await import("../dist/index.js");
      const canonical = { ...row.canonical, connection_id: "con_other" };
      await tamperVersion(db.pool, v.versionId, "canonical = $2::jsonb, sha256 = $3", [JSON.stringify(canonical), versionSha256(canonical)]);
    },
  };
  for (const [label, tamper] of Object.entries(cases)) {
    await t.test(label, async () => {
      const seed = await seedJob(db.pool);
      const { executor, stub } = makeExecutor(db.pool);
      const v = await storeVersion(executor, db.pool, seed);
      await tamper(v);
      const outcome = await executor.dispatch_auto(v.versionId);
      assert.equal(outcome.kind, "refused");
      assert.equal(outcome.reason, "integrity");
      assert.equal(stub.callCount, 0);
      assert.deepEqual(await dispatchesOf(db.pool, v.versionId), []);
    });
  }
  await t.test("the immutability trigger refuses the same edit made normally", async () => {
    const seed = await seedJob(db.pool);
    const { executor } = makeExecutor(db.pool);
    const v = await storeVersion(executor, db.pool, seed);
    await assert.rejects(db.pool.query("UPDATE proposal_versions SET mime = $2 WHERE id = $1", [v.versionId, flip(v.mime)]), /immutable/);
  });
});

test("a policy_version change refuses the pending version with policy_changed (A15)", async () => {
  const seed = await seedJob(db.pool);
  const { executor, stub } = makeExecutor(db.pool);
  const held = await storeVersion(executor, db.pool, seed, { call: { ...CUSTOM }, reasons: ["custom_content"] });
  const auto = await storeVersion(executor, db.pool, seed);
  await db.pool.query("UPDATE jobs SET policy_version = 2 WHERE id = $1", [seed.job]);

  const approval = await executor.approve(held.proposalId, 1, held.sha256, seed.owner);
  assert.equal(approval.kind, "refused");
  assert.equal(approval.reason, "policy_changed");
  assert.equal((await executor.dispatch_auto(auto.versionId)).reason, "policy_changed");
  assert.equal(stub.callCount, 0);
  // The approval and its APPROVAL_GRANTED receipt rolled back with the refused reservation.
  assert.deepEqual((await db.pool.query("SELECT id FROM approvals WHERE proposal_version_id = $1", [held.versionId])).rows, []);
  const receipts = await assertReceiptChain(db.pool, seed.owner);
  assert.deepEqual(typesOf(receipts), ["PROPOSAL_CREATED", "PROPOSAL_CREATED", "APPROVAL_REFUSED", "DISPATCH_REFUSED"]);
});

test("approve: owner, version and hash checks, then the stored bytes go out (A7)", async () => {
  const seed = await seedJob(db.pool);
  const stranger = await seedJob(db.pool);
  const { executor, stub } = makeExecutor(db.pool);
  const v1 = await storeVersion(executor, db.pool, seed, { call: { ...CUSTOM }, reasons: ["custom_content"] });

  await assert.rejects(executor.approve(v1.proposalId, 1, v1.sha256, stranger.owner), NotFoundError);
  await assert.rejects(executor.approve(v1.proposalId, 9, v1.sha256, seed.owner), NotFoundError);
  assert.equal((await executor.approve(v1.proposalId, 1, "0".repeat(64), seed.owner)).reason, "hash_mismatch");

  const v2 = await storeVersion(executor, db.pool, seed, {
    proposalId: v1.proposalId,
    version: 2,
    call: { custom_subject: "Kickoff", custom_body: "Does Friday at 10am work instead?" },
    reasons: ["custom_content"],
  });
  assert.equal((await executor.approve(v1.proposalId, 1, v1.sha256, seed.owner)).reason, "superseded", "a stale tab");
  const sent = await executor.approve(v1.proposalId, 2, v2.sha256, seed.owner);
  assert.equal(sent.outcome.status, "accepted");
  assert.equal(stub.callCount, 1);
  assert.deepEqual(Buffer.from(stub.calls[0].bytes), (await versionRow(v2.versionId)).mime);
  assert.equal((await executor.approve(v1.proposalId, 2, v2.sha256, seed.owner)).reason, "not_pending", "a second click");
  assert.equal(stub.callCount, 1);

  const [d] = await dispatchesOf(db.pool, v2.versionId);
  const approvals = (await db.pool.query("SELECT * FROM approvals WHERE proposal_version_id = $1", [v2.versionId])).rows;
  assert.equal(approvals.length, 1);
  assert.equal(d.via, approvals[0].id);
  assert.equal(approvals[0].version_sha256, v2.sha256);
  assert.equal(approvals[0].approver, seed.owner);
  const receipts = await assertReceiptChain(db.pool, seed.owner);
  assert.deepEqual(typesOf(receipts), [
    "PROPOSAL_CREATED",
    "APPROVAL_REFUSED",
    "PROPOSAL_REVISED",
    "APPROVAL_REFUSED",
    "APPROVAL_GRANTED",
    "DISPATCH_RESERVED",
    "PROVIDER_ACCEPTED",
    "APPROVAL_REFUSED",
  ]);
  assert.deepEqual(await receiptsOf(db.pool, stranger.owner), [], "a stranger's attempt writes nothing anywhere");
});

test("DEMO_RECIPIENTS: any other recipient is NOT SENT right before the call", async () => {
  const seed = await seedJob(db.pool);
  const { executor, stub } = makeExecutor(db.pool, { demoRecipients: ["inbox-a@test.example"] });
  const v = await storeVersion(executor, db.pool, seed);
  const outcome = await executor.dispatch_auto(v.versionId);
  assert.deepEqual(outcome.outcome, { status: "not_sent", errorClass: "demo_recipient_not_allowed" });
  assert.equal(stub.callCount, 0);
  assert.equal((await jobRow(db.pool, seed.job)).sends_reserved, 0);

  const allowed = makeExecutor(db.pool, { demoRecipients: ["dana@test.example"] });
  const next = await storeVersion(allowed.executor, db.pool, seed);
  assert.equal((await allowed.executor.dispatch_auto(next.versionId)).outcome.status, "accepted");
});

test("resolveUnknown records what the owner saw; either way the send still counts and the proposal stays unknown", async () => {
  for (const resolution of ["not_arrived", "seen"]) {
    // One send allowed, so a released slot would show as a second send going out.
    const seed = await seedJob(db.pool, { max_sends: 1 });
    const stranger = await seedJob(db.pool);
    const { executor, stub } = makeExecutor(db.pool, { script: ["unknown:http_502"] });
    const v = await storeVersion(executor, db.pool, seed);
    await executor.dispatch_auto(v.versionId);
    const [d] = await dispatchesOf(db.pool, v.versionId);
    await assert.rejects(executor.resolveUnknown(d.id, resolution, stranger.owner), NotFoundError);
    const result = await executor.resolveUnknown(d.id, resolution, seed.owner);
    assert.equal(result.resolved, true);
    assert.deepEqual(await executor.resolveUnknown(d.id, resolution, seed.owner), { resolved: false, reason: "not_unknown" });
    const after = (await dispatchesOf(db.pool, v.versionId))[0];
    assert.equal(after.witness, resolution);
    assert.equal(after.resolved_by, seed.owner);
    // "It did not arrive" is an observation: the message may only be late or in spam.
    assert.equal((await jobRow(db.pool, seed.job)).sends_reserved, 1, "the reservation stays used");
    assert.equal((await proposalRow(v.proposalId)).status, "unknown", "the proposal stays unknown");
    const receipts = await assertReceiptChain(db.pool, seed.owner);
    assert.equal(receipts.at(-1).type, "OUTCOME_RESOLVED");
    assert.equal(receipts.at(-1).id, result.receipt_id);
    assert.deepEqual(receipts.at(-1).body.detail, {
      dispatch: d.id,
      resolution: resolution === "seen" ? "sent" : "not_arrived",
      source: "owner",
      resolved_by: seed.owner,
    });
    const again = await executor.dispatch_auto((await storeVersion(executor, db.pool, seed)).versionId);
    assert.deepEqual([again.kind, again.reason], ["refused", "limit_reached"], "no second send takes the slot");
    assert.equal(stub.callCount, 1);
  }
});

test("no receipt, no change: a receipt written in a transaction that rolls back is gone with it", async () => {
  const seed = await seedJob(db.pool);
  const { executor } = makeExecutor(db.pool);
  await executor.withTx(seed.owner, (tx) => executor.writeReceipt(tx, "STOP_ENGAGED", { detail: { n: 1 } }));
  await assert.rejects(
    executor.withTx(seed.owner, async (tx) => {
      await executor.writeReceipt(tx, "STOP_ENGAGED", { detail: { n: 2 } });
      throw new Error("the change failed after its receipt was written");
    }),
    /the change failed/,
  );
  await executor.withTx(seed.owner, (tx) => executor.writeReceipt(tx, "STOP_ENGAGED", { detail: { n: 3 } }));
  const receipts = await assertReceiptChain(db.pool, seed.owner);
  assert.deepEqual(receipts.map((r) => r.body.detail.n), [1, 3], "the rolled-back receipt and its number are both gone");
  await assert.rejects(executor.withTx(seed.owner, (tx) => executor.writeReceipt(tx, "STOP_ENGAGED", { detail: { p: 0.5 } })));
  await assert.rejects(executor.withTx(seed.owner, (tx) => executor.writeReceipt(tx, "SENT", {})), TypeError);
  await assert.rejects(executor.writeReceipt({ kind: "tx" }, "STOP_ENGAGED", {}), TypeError);
  assert.equal((await assertReceiptChain(db.pool, seed.owner)).length, 2);
});

test("Gmail end to end: the executor's one call posts base64url of the stored bytes", async () => {
  const seed = await seedJob(db.pool);
  const requests = [];
  const fakeFetch = async (url, init) => {
    requests.push({ url, init });
    return new Response(JSON.stringify({ id: "18c2f0a1b2c3d4e5", threadId: "t" }), { status: 200 });
  };
  const tokenFor = [];
  const { executor } = makeExecutor(db.pool, {
    mailProviderFor: (connection) =>
      createGmailProvider({ accessToken: async () => (tokenFor.push(connection.id), "ya29.secret-token"), fetch: fakeFetch }),
  });
  const v = await storeVersion(executor, db.pool, seed);
  const outcome = await executor.dispatch_auto(v.versionId);
  assert.deepEqual(outcome.outcome, { status: "accepted", providerMessageId: "18c2f0a1b2c3d4e5" });
  assert.equal(requests.length, 1);
  assert.deepEqual(tokenFor, [seed.connection]);
  const body = JSON.parse(requests[0].init.body);
  assert.deepEqual(Object.keys(body), ["raw"]);
  assert.equal(body.raw, gmailRaw((await versionRow(v.versionId)).mime));
  const receipts = await assertReceiptChain(db.pool, seed.owner);
  // The whole token: "ya29" alone can occur inside a random base64url id; "." never can.
  const leaked = receipts.filter((r) => r.payload.includes("ya29.secret-token"));
  assert.deepEqual(leaked, [], "no token in any receipt (A19)");
});
