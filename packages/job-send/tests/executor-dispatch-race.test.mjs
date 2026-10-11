import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { startPostgres } from "./executor-support/pg.mjs";
import {
  CUSTOM,
  assertReceiptChain,
  dispatchesOf,
  jobRow,
  makeExecutor,
  seedJob,
  storeVersion,
  waitFor,
} from "./executor-support/fixtures.mjs";

// Concurrency on real Postgres with separate connections from one pool: double approval (A8), the
// last slot (A9), the receipt sequence under load, and the lock order itself.

let db;
before(async () => {
  db = await startPostgres({ poolSize: 16 });
});
after(async () => {
  await db?.stop();
});

test("A8: concurrent approvals of one version give one approval, one dispatch, one provider call", async () => {
  for (let round = 0; round < 3; round++) {
    const seed = await seedJob(db.pool);
    const { executor, stub } = makeExecutor(db.pool);
    const v = await storeVersion(executor, db.pool, seed, { call: { ...CUSTOM }, reasons: ["custom_content"] });
    const outcomes = await Promise.all(Array.from({ length: 4 }, () => executor.approve(v.proposalId, 1, v.sha256, seed.owner)));

    const sent = outcomes.filter((o) => o.kind === "provider");
    const refused = outcomes.filter((o) => o.kind === "refused");
    assert.equal(sent.length, 1, `round ${round}: one send`);
    assert.equal(sent[0].outcome.status, "accepted");
    assert.deepEqual(
      refused.map((o) => o.reason),
      ["not_pending", "not_pending", "not_pending"],
    );
    assert.equal(stub.callCount, 1, "one provider call");
    assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM approvals WHERE proposal_version_id = $1", [v.versionId])).rows[0].n, 1);
    assert.equal((await dispatchesOf(db.pool, v.versionId)).length, 1);
    assert.equal((await jobRow(db.pool, seed.job)).sends_reserved, 1);
    const receipts = await assertReceiptChain(db.pool, seed.owner);
    assert.equal(receipts.filter((r) => r.type === "APPROVAL_GRANTED").length, 1);
    assert.equal(receipts.filter((r) => r.type === "APPROVAL_REFUSED").length, 3);
  }
});

test("A9: racers for the last slots get exactly max_sends reservations", async () => {
  for (const [maxSends, racers] of [
    [2, 8],
    [1, 6],
  ]) {
    const seed = await seedJob(db.pool, { max_sends: maxSends });
    const { executor, stub } = makeExecutor(db.pool);
    const versions = [];
    for (let i = 0; i < racers; i++) versions.push(await storeVersion(executor, db.pool, seed));
    const outcomes = await Promise.all(versions.map((v) => executor.dispatch_auto(v.versionId)));

    assert.equal(outcomes.filter((o) => o.kind === "provider" && o.outcome.status === "accepted").length, maxSends);
    assert.deepEqual(
      outcomes.filter((o) => o.kind === "refused").map((o) => o.reason),
      Array(racers - maxSends).fill("limit_reached"),
    );
    assert.equal(stub.callCount, maxSends);
    assert.equal((await jobRow(db.pool, seed.job)).sends_reserved, maxSends);
    const dispatched = (await db.pool.query(
      "SELECT count(*)::int AS n FROM dispatches d JOIN proposal_versions v ON v.id = d.proposal_version_id JOIN proposals p ON p.id = v.proposal_id WHERE p.job_id = $1",
      [seed.job],
    )).rows[0].n;
    assert.equal(dispatched, maxSends);
  }
});

test("the receipt sequence is gap-free and ordered under concurrency", async () => {
  const seed = await seedJob(db.pool, { max_sends: 5 });
  const { executor } = makeExecutor(db.pool, { script: ["accept", "not_sent:http_429", "unknown:http_503"] });
  const autos = [];
  for (let i = 0; i < 8; i++) autos.push(await storeVersion(executor, db.pool, seed));
  const held = await storeVersion(executor, db.pool, seed, { call: { ...CUSTOM }, reasons: ["custom_content"] });
  await Promise.all([
    ...autos.map((v) => executor.dispatch_auto(v.versionId)),
    executor.approve(held.proposalId, 1, held.sha256, seed.owner),
    executor.approve(held.proposalId, 1, held.sha256, seed.owner),
    executor.withTx(seed.owner, (tx) => executor.writeReceipt(tx, "AI_REVIEW", { job: seed.job, detail: { outcome: "clear" } })),
  ]);

  const receipts = await assertReceiptChain(db.pool, seed.owner);
  // Causality inside each dispatch: the reservation's receipt comes before its outcome's.
  const byDispatch = new Map();
  for (const r of receipts) {
    const id = r.body.detail?.dispatch;
    if (id) byDispatch.set(id, [...(byDispatch.get(id) ?? []), r]);
  }
  assert.ok(byDispatch.size >= 5);
  for (const [id, list] of byDispatch) {
    assert.equal(list[0].type, "DISPATCH_RESERVED", id);
    assert.ok(["PROVIDER_ACCEPTED", "NOT_SENT", "OUTCOME_UNKNOWN"].includes(list[1]?.type), id);
    assert.ok(list[0].seq < list[1].seq);
  }
  // The job's counter agrees with the outcomes: NOT SENT released its slot.
  const used = (await db.pool.query(
    `SELECT count(*)::int AS n FROM dispatches d JOIN proposal_versions v ON v.id = d.proposal_version_id
     JOIN proposals p ON p.id = v.proposal_id WHERE p.job_id = $1 AND d.status <> 'not_sent'`,
    [seed.job],
  )).rows[0].n;
  assert.equal((await jobRow(db.pool, seed.job)).sends_reserved, used);
});

// Lock order: proposal, version, job, connection, then the owner's receipt counter. Hold one row
// from another connection, start a dispatch, and once it is waiting, probe every row with NOWAIT:
// the rows before the held one must already be locked by the dispatch, the rows after it free.
test("lock order: proposal, version, job, connection, then the owner counter", async (t) => {
  const order = ["proposals", "proposal_versions", "jobs", "connections", "owners"];
  for (const heldTable of order.slice(1)) {
    await t.test(`holding ${heldTable}`, async () => {
      const seed = await seedJob(db.pool);
      const { executor, stub } = makeExecutor(db.pool);
      const v = await storeVersion(executor, db.pool, seed);
      const ids = { proposals: v.proposalId, proposal_versions: v.versionId, jobs: seed.job, connections: seed.connection, owners: seed.owner };
      const holder = await db.client();
      const prober = await db.client();
      try {
        await holder.query("BEGIN");
        await holder.query(`SELECT 1 FROM ${heldTable} WHERE id = $1 FOR UPDATE`, [ids[heldTable]]);
        const running = executor.dispatch_auto(v.versionId);
        await waitFor(
          async () =>
            (await db.pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()")).rows[0].n > 0,
          10_000,
          "the dispatch to wait on the held row",
        );
        const heldAt = order.indexOf(heldTable);
        for (const table of order) {
          if (table === heldTable) continue;
          await prober.query("BEGIN");
          let locked = false;
          try {
            await prober.query(`SELECT 1 FROM ${table} WHERE id = $1 FOR UPDATE NOWAIT`, [ids[table]]);
          } catch (error) {
            if (error.code !== "55P03") throw error;
            locked = true;
          }
          await prober.query("ROLLBACK");
          assert.equal(locked, order.indexOf(table) < heldAt, `${table} ${order.indexOf(table) < heldAt ? "is taken before" : "waits behind"} ${heldTable}`);
        }
        await holder.query("ROLLBACK");
        assert.equal((await running).outcome.status, "accepted");
        assert.equal(stub.callCount, 1);
      } finally {
        await holder.end().catch(() => undefined);
        await prober.end().catch(() => undefined);
      }
    });
  }
});

// db_now() is read after the locks are held. now() would be the transaction's start, before the
// lock wait, so a reservation that waited past expires_at would still go through.
test("the reservation's clock is read after its locks: a wait past expires_at gives job_expired", async () => {
  const expiresAt = new Date(Date.now() + 1500);
  const seed = await seedJob(db.pool, { expires_at: expiresAt });
  const { executor, stub } = makeExecutor(db.pool);
  const v = await storeVersion(executor, db.pool, seed);
  const holder = await db.client();
  try {
    await holder.query("BEGIN");
    await holder.query("SELECT 1 FROM jobs WHERE id = $1 FOR UPDATE", [seed.job]);
    const running = executor.dispatch_auto(v.versionId);
    await waitFor(
      async () =>
        (await db.pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()")).rows[0].n > 0,
      10_000,
      "the dispatch to wait on the job",
    );
    await waitFor(() => Date.now() > expiresAt.getTime() + 300, 10_000, "the job to expire while the dispatch waits");
    await holder.query("ROLLBACK");
    const outcome = await running;
    assert.equal(outcome.kind, "refused");
    assert.equal(outcome.reason, "job_expired");
    assert.equal(stub.callCount, 0);
  } finally {
    await holder.end().catch(() => undefined);
  }
});
