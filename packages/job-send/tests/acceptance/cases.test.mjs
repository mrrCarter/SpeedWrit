// Acceptance cases A1-A22 from the spec, one test each, end to end. The agent acts only through
// POST /mcp on the real server (createJobSendServer over createMcpBackend); the owner acts through
// the owner core; everything runs on real Postgres with the fault-injecting stub provider
// (support/stub-mail-provider.mjs). Every case asserts the state AND the receipts. A1 and A7 use
// real Gmail at the gates and the stub here.
import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { FLAGS, generateReceiptKeyPair } from "../../dist/index.js";
import { receiptEnvelopeText, verifyReceiptText } from "../../dist/receipts/verify/index.js";
import { startPostgres } from "../executor-support/pg.mjs";
import { CUSTOM, FIELDS, PINNED, assertReceiptChain, jobRow, receiptsOf, typesOf, waitFor } from "../executor-support/fixtures.mjs";
import { barrier, codeParams, register, seedCode, token } from "../server/support/harness.mjs";
import { RESOURCE, mintToken, openWorld } from "./support/world.mjs";

let db;
before(async () => {
  db = await startPostgres();
});
after(async () => {
  await db?.stop();
});

const rows = async (sql, values) => (await db.pool.query(sql, values)).rows;
const versionOf = async (proposalId, version) =>
  (await rows("SELECT id, sha256, mime, state FROM proposal_versions WHERE proposal_id = $1 AND version = $2", [proposalId, version]))[0];
const hold = (flags) => ({
  outcome: "hold",
  flags,
  probs_bp: Object.fromEntries(FLAGS.map((flag) => [flag, flags.includes(flag) ? 9100 : 100])),
  model: "test-model",
  ms: 5,
});

/** Runs `body` in a fresh world and always closes its server. */
async function inWorld(options, body) {
  const world = await openWorld(db, options);
  try {
    await body(world);
  } finally {
    await world.close();
  }
}

test("A1: a template send inside the job is ACCEPTED: sends_reserved 1 of 2; receipts created, reserved, accepted; the stored bytes reach the provider", () =>
  inWorld({}, async (w) => {
    const r = await w.propose({ fields: { ...FIELDS } });
    assert.equal(r.sc.status, "sent");
    assert.equal(r.sc.sends_left, 1);
    assert.match(r.text, /1 of 2 sends left/);
    assert.equal((await jobRow(db.pool, w.seed.job)).sends_reserved, 1);
    assert.deepEqual(typesOf(await assertReceiptChain(db.pool, w.seed.owner)), ["PROPOSAL_CREATED", "DISPATCH_RESERVED", "PROVIDER_ACCEPTED"]);
    const v = await versionOf(r.sc.proposal_id, 1);
    assert.equal(w.stub.callCount, 1);
    assert.deepEqual(Buffer.from(w.stub.calls[0].bytes), v.mime, "exactly the stored bytes");
  }));

test("A2: a send to another client in contacts is denied recipient_not_in_job: no proposal row and nothing approvable", () =>
  inWorld({}, async (w) => {
    await db.pool.query("INSERT INTO contacts (id, owner_id, email, name, client_label) VALUES ($1, $2, 'bo@globex.example', 'Bo', 'Globex')", [
      `ct_${w.seed.job}`,
      w.seed.owner,
    ]);
    const r = await w.propose({ to: "bo@globex.example", fields: { ...FIELDS } });
    assert.equal(r.sc.status, "denied");
    assert.equal(r.sc.reason_code, "recipient_not_in_job");
    assert.equal(r.sc.approvable, false);
    assert.match(r.text, /cannot be approved/);
    assert.deepEqual(await rows("SELECT id FROM proposals WHERE job_id = $1", [w.seed.job]), []);
    assert.deepEqual(await w.owner.listPendingVersions(w.seed.owner), [], "no Approve control anywhere");
    assert.deepEqual(typesOf(await receiptsOf(db.pool, w.seed.owner)), ["ATTEMPT_DENIED"]);
  }));

test("A3: two addresses, a display name or a line break in `to` is denied recipient_invalid", () =>
  inWorld({}, async (w) => {
    for (const to of ["dana@test.example, bo@test.example", "Dana <dana@test.example>", "dana@test.example\r\nbcc: bo@test.example"]) {
      const r = await w.propose({ to, fields: { ...FIELDS } });
      assert.equal(r.sc.reason_code, "recipient_invalid", JSON.stringify(to));
    }
    assert.equal(w.stub.callCount, 0);
    assert.deepEqual(typesOf(await receiptsOf(db.pool, w.seed.owner)), ["ATTEMPT_DENIED", "ATTEMPT_DENIED", "ATTEMPT_DENIED"]);
  }));

test("A4: an extra argument such as cc, or an unknown field, is rejected by the schema or denied field_not_allowed; nothing sent", () =>
  inWorld({}, async (w) => {
    const schema = await w.propose({ fields: { ...FIELDS }, cc: "bo@test.example" });
    assert.equal(schema.result.isError, true);
    assert.equal(schema.sc.error, "invalid_arguments", "rejected by the schema before the gate");
    const field = await w.propose({ fields: { ...FIELDS, cc: "bo@test.example" } });
    assert.equal(field.sc.reason_code, "field_not_allowed");
    assert.equal(w.stub.callCount, 0);
    assert.deepEqual(await rows("SELECT id FROM proposals WHERE job_id = $1", [w.seed.job]), []);
    assert.deepEqual(typesOf(await receiptsOf(db.pool, w.seed.owner)), ["ATTEMPT_DENIED"], "only the gate's denial is recorded");
  }));

test("A5: a field with a URL, or over its length, is denied field_invalid naming the field", () =>
  inWorld({}, async (w) => {
    const url = await w.propose({ fields: { ...FIELDS, recap: "The deck is at https://example.com/deck." } });
    const long = await w.propose({ fields: { ...FIELDS, recap: "x".repeat(601) } });
    for (const r of [url, long]) assert.equal(r.sc.reason_code, "field_invalid");
    const receipts = await receiptsOf(db.pool, w.seed.owner);
    assert.deepEqual(receipts.map((rc) => rc.body.detail.field), ["recap", "recap"], "the receipt names the field");
    assert.equal(w.stub.callCount, 0);
  }));

test("A6: custom wording is a pending version 1 with custom_content and no provider call", () =>
  inWorld({}, async (w) => {
    const r = await w.propose({ ...CUSTOM });
    assert.equal(r.sc.status, "pending_approval");
    assert.equal(r.sc.version, 1);
    assert.ok(r.sc.review_reasons.includes("custom_content"));
    assert.equal(w.stub.callCount, 0);
    const [pending] = await w.owner.listPendingVersions(w.seed.owner);
    assert.equal(pending.proposalId, r.sc.proposal_id);
    assert.equal(pending.version, 1);
  }));

test("A7: revise, approve the old hash (409 superseded), then approve version 2: version 2's stored bytes are exactly what the provider receives", () =>
  inWorld({}, async (w) => {
    const v1 = (await w.propose({ ...CUSTOM })).sc;
    const v2 = (await w.tool("revise_proposal", { proposal_id: v1.proposal_id, custom_subject: "Kickoff", custom_body: "Does Thursday at 3pm work instead?" })).sc;
    assert.equal(v2.version, 2);
    const old = await versionOf(v1.proposal_id, 1);
    const cur = await versionOf(v1.proposal_id, 2);
    assert.equal(old.state, "superseded");
    const stale = await w.owner.approve(v1.proposal_id, 1, old.sha256, w.seed.owner);
    assert.deepEqual([stale.kind, stale.reason], ["refused", "superseded"]);
    const sent = await w.owner.approve(v1.proposal_id, 2, cur.sha256, w.seed.owner);
    assert.equal(sent.kind, "provider");
    assert.equal(sent.outcome.status, "accepted");
    assert.equal(w.stub.callCount, 1);
    assert.deepEqual(Buffer.from(w.stub.calls[0].bytes), cur.mime, "version 2's stored bytes, exactly");
    const types = typesOf(await assertReceiptChain(db.pool, w.seed.owner));
    assert.ok(types.indexOf("APPROVAL_REFUSED") < types.indexOf("APPROVAL_GRANTED"));
  }));

test("A8: two approvals of the same version at once give one approval row, one dispatch row and one provider call (stub, held)", () =>
  inWorld({ script: ["hold"] }, async (w) => {
    const v1 = (await w.propose({ ...CUSTOM })).sc;
    const { sha256 } = await versionOf(v1.proposal_id, 1);
    const racers = [1, 2].map(() => w.owner.approve(v1.proposal_id, 1, sha256, w.seed.owner));
    await waitFor(() => w.stub.callCount === 1, 5000, "the provider call");
    w.stub.release(0, "accept");
    const outcomes = await Promise.all(racers);
    assert.deepEqual(outcomes.map((o) => o.kind).sort(), ["provider", "refused"]);
    assert.equal(outcomes.find((o) => o.kind === "refused").reason, "not_pending");
    const { id } = await versionOf(v1.proposal_id, 1);
    assert.equal((await rows("SELECT count(*)::int AS n FROM approvals WHERE proposal_version_id = $1", [id]))[0].n, 1);
    assert.equal((await rows("SELECT count(*)::int AS n FROM dispatches WHERE proposal_version_id = $1", [id]))[0].n, 1);
    assert.equal(w.stub.callCount, 1);
  }));

test("A9: two automatic sends racing for the last slot give one ACCEPTED and one limit_reached (stub)", () =>
  inWorld({}, async (w) => {
    await db.pool.query("UPDATE jobs SET sends_reserved = 1 WHERE id = $1", [w.seed.job]);
    const results = await Promise.all([1, 2].map((i) => w.propose({ fields: { ...FIELDS, topic: `call ${i}` } })));
    const statuses = results.map((r) => r.sc.status).sort();
    assert.deepEqual(statuses, ["denied", "sent"]);
    assert.equal(results.find((r) => r.sc.status === "denied").sc.reason_code, "limit_reached");
    assert.equal(w.stub.callCount, 1);
    assert.equal((await jobRow(db.pool, w.seed.job)).sends_reserved, 2);
  }));

test("A10: a send after the limit is limit_reached, and one after expiry is job_expired", () =>
  inWorld({}, async (w) => {
    await db.pool.query("UPDATE jobs SET sends_reserved = max_sends WHERE id = $1", [w.seed.job]);
    assert.equal((await w.propose({ fields: { ...FIELDS } })).sc.reason_code, "limit_reached");
    await db.pool.query("UPDATE jobs SET sends_reserved = 0, expires_at = clock_timestamp() - interval '1 second' WHERE id = $1", [w.seed.job]);
    assert.equal((await w.propose({ fields: { ...FIELDS } })).sc.reason_code, "job_expired");
    assert.equal(w.stub.callCount, 0);
  }));

test("A11: a provider timeout or a 503 is UNKNOWN: the reservation is kept, no second provider call, the agent is told not to resend (stub)", async () => {
  for (const step of ["unknown:timeout", "unknown:http_503"]) {
    await inWorld({ script: [step] }, async (w) => {
      const r = await w.propose({ fields: { ...FIELDS } });
      assert.equal(r.sc.status, "unknown", step);
      assert.equal(r.sc.sent, null);
      assert.match(r.text, /Do not resend/);
      assert.equal((await jobRow(db.pool, w.seed.job)).sends_reserved, 1, "the reservation is kept");
      assert.equal(w.stub.callCount, 1);
      assert.equal((await receiptsOf(db.pool, w.seed.owner)).at(-1).type, "OUTCOME_UNKNOWN");
    });
  }
});

test("A12: a provider 400, 401, 403 or 429 is NOT SENT and the reservation is released (stub)", () =>
  inWorld({ script: ["not_sent:http_400", "not_sent:http_401", "not_sent:http_403", "not_sent:http_429"] }, async (w) => {
    for (const status of [400, 401, 403, 429]) {
      const r = await w.propose({ fields: { ...FIELDS, topic: `try ${status}` } });
      assert.equal(r.sc.status, "not_sent", String(status));
      assert.equal(r.sc.error_class, `http_${status}`);
      assert.equal((await jobRow(db.pool, w.seed.job)).sends_reserved, 0, "released");
    }
    assert.equal(w.stub.callCount, 4);
    assert.deepEqual(typesOf(await receiptsOf(db.pool, w.seed.owner)).filter((t) => t === "NOT_SENT").length, 4);
  }));

test("A13: a process killed between reserve and result is marked UNKNOWN by the sweeper, and nothing resends", () =>
  inWorld({ script: ["hold"] }, async (w) => {
    const inFlight = w.propose({ fields: { ...FIELDS } });
    await waitFor(() => w.stub.callCount === 1, 5000, "the provider call");
    // The process "dies" here: no result arrives. The sweeper finds the reservation.
    const swept = await w.executor.sweep(new Date(Date.now() + 61_000));
    assert.equal(swept.length, 1);
    const [d] = await rows("SELECT status, error_class FROM dispatches WHERE id = $1", [swept[0]]);
    assert.deepEqual(d, { status: "unknown", error_class: "no_provider_result" });
    assert.ok(typesOf(await receiptsOf(db.pool, w.seed.owner)).includes("OUTCOME_UNKNOWN"));
    // The dead connection finally resets; the late answer is recorded, the state stays UNKNOWN.
    w.stub.reset(0);
    await inFlight;
    assert.equal((await rows("SELECT status FROM dispatches WHERE id = $1", [swept[0]]))[0].status, "unknown");
    assert.equal((await jobRow(db.pool, w.seed.job)).sends_reserved, 1);
    assert.equal(w.stub.callCount, 1, "nothing resends");
  }));

test("A14: after STOP, a new attempt and an approval of a pending version are both dispatch_stopped; STOP_ENGAGED precedes the revoke receipts", () =>
  inWorld({ revoke: async () => ({ ok: true, status: 200 }) }, async (w) => {
    const held = (await w.propose({ ...CUSTOM })).sc;
    const { sha256 } = await versionOf(held.proposal_id, 1);
    const stopped = await w.owner.engageStop(w.seed.connection, w.seed.owner);
    assert.equal(stopped.receipt_ids.length, 3);
    assert.equal((await w.propose({ fields: { ...FIELDS } })).sc.reason_code, "dispatch_stopped");
    const approval = await w.owner.approve(held.proposal_id, 1, sha256, w.seed.owner);
    assert.deepEqual([approval.kind, approval.reason], ["refused", "dispatch_stopped"]);
    const types = typesOf(await assertReceiptChain(db.pool, w.seed.owner));
    const at = (type) => types.indexOf(type);
    assert.ok(at("STOP_ENGAGED") < at("PROVIDER_REVOKE_REQUESTED") && at("PROVIDER_REVOKE_REQUESTED") < at("PROVIDER_REVOKE_RESULT"));
    assert.equal(w.stub.callCount, 0);
  }));

test("A15: editing the job while a version is pending makes its approval fail with policy_changed", () =>
  inWorld({}, async (w) => {
    const held = (await w.propose({ ...CUSTOM })).sc;
    const { sha256 } = await versionOf(held.proposal_id, 1);
    // An edit is a new authority: policy_version moves on.
    await db.pool.query("UPDATE jobs SET policy_version = policy_version + 1, max_sends = 3 WHERE id = $1", [w.seed.job]);
    const approval = await w.owner.approve(held.proposal_id, 1, sha256, w.seed.owner);
    assert.deepEqual([approval.kind, approval.reason], ["refused", "policy_changed"]);
    assert.equal(w.stub.callCount, 0);
    assert.equal((await receiptsOf(db.pool, w.seed.owner)).at(-1).type, "APPROVAL_REFUSED");
  }));

test("A16: a token from another agent connection gets job_not_found", () =>
  inWorld({}, async (w) => {
    const other = `${w.seed.agentConnection}_other`;
    await db.pool.query("INSERT INTO agent_connections (id, owner_id, client_id, client_label) VALUES ($1, $2, 'client-2', 'Other agent')", [
      other,
      w.seed.owner,
    ]);
    const r = await w.propose({ fields: { ...FIELDS } }, mintToken(w.store, other));
    assert.equal(r.sc.reason_code, "job_not_found");
    assert.equal(w.stub.callCount, 0);
    const [receipt] = await receiptsOf(db.pool, w.seed.owner);
    assert.equal(receipt.body.job, null, "the receipt does not name another connection's job");
  }));

test("A17: a receipt verifies; one changed byte is invalid; another key is invalid", () =>
  inWorld({}, async (w) => {
    await w.propose({ fields: { ...FIELDS } });
    const receipts = await w.owner.listReceipts(w.seed.owner, { job: w.seed.job });
    assert.equal(receipts.length, 3);
    for (const receipt of receipts) assert.deepEqual(await verifyReceiptText(receiptEnvelopeText(receipt), PINNED), { ok: true, reason: "verified" });
    const accepted = receipts.at(-1);
    const changed = { ...accepted, payload: accepted.payload.replace("stub-msg-1", "stub-msg-2") };
    assert.notEqual(changed.payload, accepted.payload);
    assert.equal((await verifyReceiptText(receiptEnvelopeText(changed), PINNED)).ok, false, "one changed byte");
    const other = generateReceiptKeyPair();
    assert.equal((await verifyReceiptText(receiptEnvelopeText(accepted), { keyId: other.keyId, publicKeyRaw: other.publicKeyRaw })).ok, false, "another key");
  }));

test("A18: an AI-review flag holds with ai_review:*; an unreachable review holds with ai_review_unavailable; review never changes a denial", async () => {
  const seen = [];
  await inWorld({ review: async (input) => (seen.push(input), hold(["commitment"])) }, async (w) => {
    const flagged = await w.propose({ ...CUSTOM });
    assert.deepEqual(flagged.sc.review_reasons, ["custom_content", "ai_review:commitment"]);
    const denied = await w.propose({ to: "bo@test.example", ...CUSTOM });
    assert.equal(denied.sc.reason_code, "recipient_not_in_job", "the denial stands");
    assert.equal(seen.length, 1, "a denied call is never reviewed");
    assert.equal(w.stub.callCount, 0);
  });
  await inWorld({ review: async () => { throw new Error("review endpoint unreachable"); } }, async (w) => {
    const r = await w.propose({ ...CUSTOM });
    assert.deepEqual(r.sc.review_reasons, ["custom_content", "ai_review_unavailable"]);
    assert.equal(w.stub.callCount, 0);
  });
});

test("A19: no token string appears in logs, receipts or MCP output", () =>
  inWorld({}, async (w) => {
    // A real OAuth pair from the token endpoint, beside the minted bearer the calls use.
    const { client_id } = (await register(w.base)).body;
    const issued = (await token(w.base, codeParams(client_id, await seedCode(w.store, client_id)))).body;
    const secrets = [w.bearer, issued.access_token, issued.refresh_token];
    assert.ok(secrets.every((s) => typeof s === "string" && s.length > 20));
    await w.propose({ fields: { ...FIELDS } });
    await w.propose({ to: "bo@test.example", fields: { ...FIELDS } });
    await w.propose({ ...CUSTOM });
    await w.tool("list_jobs", {});
    await w.tool("get_status", { proposal_id: "prp_unknown" });
    const unauthorized = await w.tool("list_jobs", {}, issued.access_token); // a token for a connection that does not exist here
    assert.equal(unauthorized.status, 401);
    const everything = [
      ...w.answers,
      ...w.errors,
      ...(await receiptsOf(db.pool, w.seed.owner)).map((r) => r.payload),
      JSON.stringify(await rows("SELECT * FROM attempts WHERE agent_connection_id = $1", [w.seed.agentConnection])),
      JSON.stringify(await rows("SELECT p.*, v.subject, v.body, v.canonical FROM proposals p JOIN proposal_versions v ON v.proposal_id = p.id WHERE p.job_id = $1", [w.seed.job])),
    ].join("\n");
    for (const secret of secrets) assert.equal(everything.includes(secret), false, "a token string leaked");
  }));

test("A20: the eleventh denied attempt inside an hour is rate_limited", () =>
  inWorld({}, async (w) => {
    for (let i = 0; i < 10; i++) assert.equal((await w.propose({ to: "bo@test.example", fields: { ...FIELDS } })).sc.reason_code, "recipient_not_in_job");
    const eleventh = await w.propose({ fields: { ...FIELDS } });
    assert.equal(eleventh.sc.reason_code, "rate_limited");
    assert.match(eleventh.text, /Stop and tell the user/);
    assert.equal(w.stub.callCount, 0);
  }));

test("A21: two concurrent redemptions of one authorization code issue tokens once: the compare-and-set on used_at decides (Bundle, #510)", () =>
  inWorld({}, async (w) => {
    const { client_id } = (await register(w.base)).body;
    const code = await seedCode(w.store, client_id);
    barrier(w.store, "findCode", 2); // both requests read the unused code before either redeems it
    const answers = await Promise.all([1, 2].map(() => token(w.base, codeParams(client_id, code))));
    assert.deepEqual(answers.map((a) => a.status).sort(), [200, 400]);
    assert.equal(answers.find((a) => a.status === 400).body.error, "invalid_grant");
    assert.equal(w.store.access.size, 2, "the minted bearer, plus exactly one issued pair");
  }));

test("A22: two concurrent refreshes of one refresh token rotate once, and the loser is treated as reuse: the grant is revoked (Bundle, #510)", () =>
  inWorld({}, async (w) => {
    const { client_id } = (await register(w.base)).body;
    const first = (await token(w.base, codeParams(client_id, await seedCode(w.store, client_id)))).body;
    barrier(w.store, "findRefresh", 2);
    const refresh = { grant_type: "refresh_token", refresh_token: first.refresh_token, client_id, resource: RESOURCE };
    const answers = await Promise.all([1, 2].map(() => token(w.base, refresh)));
    assert.deepEqual(answers.map((a) => a.status).sort(), [200, 400]);
    const issuedConnection = [...w.store.refresh.values()][0].agent_connection_id;
    const grant = [...w.store.access.values(), ...w.store.refresh.values()].filter((t) => t.agent_connection_id === issuedConnection);
    assert.ok(grant.length >= 4);
    assert.ok(grant.every((t) => t.revoked_at !== null), "every token of the grant, including the winner's new pair, is revoked");
  }));
