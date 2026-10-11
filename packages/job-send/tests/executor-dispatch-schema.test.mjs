import assert from "node:assert/strict";
import test, { after, before } from "node:test";

import { RECEIPT_TYPES, migrate, newId, readMigrations } from "../dist/index.js";
import { startPostgres } from "./executor-support/pg.mjs";
import { assertReceiptChain, makeExecutor, seedJob, storeVersion } from "./executor-support/fixtures.mjs";

// The invariants the database itself enforces, so a code path that forgets one still cannot break it.

let db;
before(async () => {
  db = await startPostgres();
});
after(async () => {
  await db?.stop();
});

const fails = (promise, code, label) => assert.rejects(promise, (error) => error?.code === code, label);

test("schema: migrate applies each file once, in order, and refuses edited, unknown and out-of-order files", async () => {
  // Every lane adds its own numbered file, so this pins the rules, not the list: 0001 first, then
  // unique names in order. The probe files below sort after any real one (9998, 9999).
  const files = readMigrations();
  const names = files.map((m) => m.name);
  assert.equal(names[0], "0001_job_send.sql");
  assert.deepEqual(names, [...new Set(names)].sort());
  assert.ok(names.every((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name) && name < "9998"));
  assert.ok(names.includes("0003_owner_sign_in.sql"), "the owner sign-in tables (bundle)");
  assert.equal(await migrate(db.pool), "current");
  const lf = files.map((m) => ({ ...m, sql: m.sql.replace(/\r\n/g, "\n") }));
  assert.equal(await migrate(db.pool, lf), "current", "an LF checkout");
  assert.equal(await migrate(db.pool, lf.map((m) => ({ ...m, sql: m.sql.replace(/\n/g, "\r\n") }))), "current", "a CRLF checkout is the same migration");
  await assert.rejects(migrate(db.pool, [{ ...files[0], sql: `${files[0].sql}\n-- edited\n` }]), /differs/);
  await assert.rejects(migrate(db.pool, []), /does not know/);
  await assert.rejects(migrate(db.pool, [...files, files[0]]), /in name order/);
  await assert.rejects(migrate(db.pool, [...files, { name: "schema.sql", sql: "SELECT 1;" }]), /not a migration file name/);

  // A failed file rolls back whole: nothing recorded, nothing created.
  await assert.rejects(migrate(db.pool, [...files, { name: "9999_broken.sql", sql: "CREATE TABLE migration_broken (id integer); SELECT * FROM no_such_table;" }]));
  const recorded = async () => (await db.pool.query("SELECT name FROM schema_migrations ORDER BY name")).rows.map((r) => r.name);
  assert.deepEqual(await recorded(), names);
  assert.equal((await db.pool.query("SELECT to_regclass('migration_broken') AS t")).rows[0].t, null);

  const probe = { name: "9999_probe.sql", sql: "CREATE TABLE migration_probe (id integer PRIMARY KEY);" };
  try {
    assert.equal(await migrate(db.pool, [...files, probe]), "applied");
    assert.equal(await migrate(db.pool, [...files, probe]), "current", "applied once");
    assert.deepEqual(await recorded(), [...names, "9999_probe.sql"]);
    await assert.rejects(migrate(db.pool, [...files, { name: "9998_late.sql", sql: "SELECT 1;" }, probe]), /sorts before 9999_probe\.sql/);
  } finally {
    await db.pool.query("DROP TABLE IF EXISTS migration_probe");
    await db.pool.query("DELETE FROM schema_migrations WHERE name = '9999_probe.sql'");
  }
  assert.equal(await migrate(db.pool), "current");
});

test("schema: the tables", async () => {
  const tables = (await db.pool.query("SELECT tablename FROM pg_tables WHERE schemaname = current_schema() ORDER BY 1")).rows.map(
    (r) => r.tablename,
  );
  assert.deepEqual(tables, [
    "access_tokens",
    "agent_connections",
    "approvals",
    "attempts",
    "connections",
    "contacts",
    "dispatches",
    "gmail_connect_pending",
    "jobs",
    "oauth_clients",
    "oauth_codes",
    "oauth_pending_authorizations",
    "oauth_secret_paths",
    "owner_sessions",
    "owner_sign_ins",
    "owners",
    "proposal_versions",
    "proposals",
    "receipts",
    "refresh_tokens",
    "schema_migrations",
    "templates",
  ]);
});

test("schema: a job binds only its own owner's connections and templates", async () => {
  const a = await seedJob(db.pool);
  const b = await seedJob(db.pool);
  const insertJob = ({ connection = a.connection, agentConnection = a.agentConnection, template = a.template.id } = {}) =>
    db.pool.query(
      `INSERT INTO jobs (id, owner_id, connection_id, agent_connection_id, recipient_email, template_id, template_sha256, max_sends, expires_at)
       VALUES ($1, $2, $3, $4, 'dana@test.example', $5, $6, 1, now() + interval '1 hour')`,
      [newId("job"), a.owner, connection, agentConnection, template, a.template.sha256],
    );
  await insertJob();
  await fails(insertJob({ connection: b.connection }), "23503", "another owner's Gmail connection");
  await fails(insertJob({ agentConnection: b.agentConnection }), "23503", "another owner's agent connection");
  await fails(insertJob({ template: b.template.id }), "23503", "another owner's private template");
  const shared = newId("tpl");
  await db.pool.query("INSERT INTO templates (id, owner_id, subject_tpl, body_tpl, sha256) VALUES ($1, NULL, 's', 'b', $2)", [shared, "0".repeat(64)]);
  await insertJob({ template: shared });
  await fails(db.pool.query("UPDATE jobs SET connection_id = $2 WHERE id = $1", [a.job, b.connection]), "23503", "moved by an UPDATE");
  await fails(db.pool.query("UPDATE jobs SET template_id = $2 WHERE id = $1", [a.job, b.template.id]), "23503", "template moved by an UPDATE");
});

test("schema: one approval and one dispatch per version (invariant 2)", async () => {
  const seed = await seedJob(db.pool);
  const { executor } = makeExecutor(db.pool);
  const v = await storeVersion(executor, db.pool, seed);
  const approve = () =>
    db.pool.query("INSERT INTO approvals (id, proposal_version_id, version_sha256, approver) VALUES ($1, $2, $3, $4)", [
      newId("apv"),
      v.versionId,
      v.sha256,
      seed.owner,
    ]);
  await approve();
  await fails(approve(), "23505", "a second approval");
  const dispatch = () =>
    db.pool.query("INSERT INTO dispatches (id, proposal_version_id, via, reserved_at) VALUES ($1, $2, 'auto', now())", [
      newId("dsp"),
      v.versionId,
    ]);
  await dispatch();
  await fails(dispatch(), "23505", "a second dispatch");
});

test("schema: sends_reserved stays between 0 and max_sends (invariant 3)", async () => {
  const seed = await seedJob(db.pool, { max_sends: 2 });
  await db.pool.query("UPDATE jobs SET sends_reserved = 2 WHERE id = $1", [seed.job]);
  await fails(db.pool.query("UPDATE jobs SET sends_reserved = 3 WHERE id = $1", [seed.job]), "23514", "above max");
  await fails(db.pool.query("UPDATE jobs SET sends_reserved = -1 WHERE id = $1", [seed.job]), "23514", "below zero");
  await fails(db.pool.query("UPDATE jobs SET max_sends = 1 WHERE id = $1", [seed.job]), "23514", "max below reserved");
});

test("schema: a proposal version is immutable except its state (invariant 1)", async () => {
  const seed = await seedJob(db.pool);
  const { executor } = makeExecutor(db.pool);
  const v = await storeVersion(executor, db.pool, seed);
  await db.pool.query("UPDATE proposal_versions SET state = 'rejected' WHERE id = $1", [v.versionId]);
  for (const [column, value] of [
    ["mime", Buffer.from("x")],
    ["subject", "Other"],
    ["body", "Other"],
    ["recipient", "bo@test.example"],
    ["sha256", "0".repeat(64)],
    ["policy_version", 2],
    ["review_reasons", ["custom_content"]],
    ["canonical", "{}"],
  ]) {
    await assert.rejects(db.pool.query(`UPDATE proposal_versions SET ${column} = $2 WHERE id = $1`, [v.versionId, value]), /immutable/, column);
  }
  await assert.rejects(db.pool.query("DELETE FROM proposal_versions WHERE id = $1", [v.versionId]), /never deleted/);
});

test("schema: receipts are append-only with one row per (owner, seq)", async () => {
  const seed = await seedJob(db.pool);
  const { executor } = makeExecutor(db.pool);
  await storeVersion(executor, db.pool, seed);
  const [receipt] = (await db.pool.query("SELECT * FROM receipts WHERE owner_id = $1", [seed.owner])).rows;
  await assert.rejects(db.pool.query("UPDATE receipts SET payload = payload || ' ' WHERE id = $1", [receipt.id]), /append-only/);
  await assert.rejects(db.pool.query("UPDATE receipts SET seq = 99 WHERE id = $1", [receipt.id]), /append-only/);
  await assert.rejects(db.pool.query("DELETE FROM receipts WHERE id = $1", [receipt.id]), /append-only/);
  await assert.rejects(db.pool.query("DELETE FROM receipts"), /append-only/);
  await assert.rejects(db.pool.query("TRUNCATE receipts CASCADE"), /append-only/);
  const insert = (seq, type = "STOP_ENGAGED") =>
    db.pool.query("INSERT INTO receipts (id, owner_id, seq, type, payload, signature, key_id) VALUES ($1, $2, $3, $4, '{}', 'x', $5)", [
      newId("rcp"),
      seed.owner,
      seq,
      type,
      receipt.key_id,
    ]);
  await fails(insert(receipt.seq), "23505", "a repeated seq");
  await fails(insert(500, "SENT"), "23514", "an unknown type");
  await fails(insert(0), "23514", "seq 0");
  assert.equal((await db.pool.query("SELECT count(*)::int AS n FROM receipts WHERE owner_id = $1", [seed.owner])).rows[0].n, 1);
});

test("schema: other column checks", async () => {
  const seed = await seedJob(db.pool);
  await fails(db.pool.query("UPDATE jobs SET recipient_email = 'Dana@test.example' WHERE id = $1", [seed.job]), "23514", "uppercase recipient");
  await fails(db.pool.query("UPDATE jobs SET status = 'paused' WHERE id = $1", [seed.job]), "23514", "job status");
  await fails(db.pool.query("UPDATE connections SET status = 'paused' WHERE id = $1", [seed.connection]), "23514", "connection status");
  await fails(db.pool.query("UPDATE connections SET refresh_token_enc = 'plaintext-token' WHERE id = $1", [seed.connection]), "23514", "unwrapped token");
  await db.pool.query("UPDATE connections SET refresh_token_enc = 'v1.AAAA' WHERE id = $1", [seed.connection]);
});

test("writeReceipt: every contract type writes, signs and verifies in sequence", async () => {
  const seed = await seedJob(db.pool);
  const { executor } = makeExecutor(db.pool);
  for (const type of RECEIPT_TYPES) {
    await executor.withTx(seed.owner, (tx) => executor.writeReceipt(tx, type, { job: seed.job, detail: { type } }));
  }
  const receipts = await assertReceiptChain(db.pool, seed.owner);
  assert.deepEqual(
    receipts.map((r) => r.type),
    [...RECEIPT_TYPES],
  );
  assert.ok(receipts.every((r) => /^rcp_[A-Za-z0-9_-]+$/.test(r.id) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(r.body.ts)));
});
