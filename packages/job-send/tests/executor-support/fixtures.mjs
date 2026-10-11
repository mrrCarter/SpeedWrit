// Seed data, a store_version stand-in and assertion helpers for the dispatch tests. Not a test file.
import assert from "node:assert/strict";

import {
  buildMime,
  createExecutor,
  generateReceiptKeyPair,
  listReceipts,
  newId,
  render,
  templateSha256,
  verifyReceipt,
  versionCanonical,
  versionSha256,
  withTx,
} from "../../dist/index.js";
import { createStubMailProvider } from "../acceptance/support/stub-mail-provider.mjs";

export const KEY = generateReceiptKeyPair();
export const PINNED = { keyId: KEY.keyId, publicKeyRaw: KEY.publicKeyRaw };

export const TEMPLATE_TEXT = Object.freeze({
  subject_tpl: "Recap: {{topic}}",
  body_tpl: "Hi {{first_name}},\n\nThanks for the {{topic}}. Here is the recap:\n\n{{recap}}\n\nBest,\nOwner",
});

export const FIELD_RULES = Object.freeze({
  first_name: { max: 40, single_line: true, required: true },
  topic: { max: 80, single_line: true, required: true },
  recap: { max: 600, required: true, free_text: true },
});

export const FIELDS = Object.freeze({
  first_name: "Dana",
  topic: "onboarding call",
  recap: "We agreed to start the pilot Monday, and I'll send the checklist by Friday.",
});

export const CUSTOM = Object.freeze({ custom_subject: "Kickoff", custom_body: "Does Thursday at 2pm work for a kickoff?" });

const isoSeconds = (date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

/** An owner with a Gmail connection, an agent connection, a template and one active job. */
export async function seedJob(pool, overrides = {}) {
  const owner = newId("own");
  const connection = newId("con");
  const agentConnection = newId("ac");
  const template = newId("tpl");
  const job = newId("job");
  const sha = templateSha256(TEMPLATE_TEXT);
  const expires = overrides.expires_at ?? new Date(Date.now() + 24 * 3600 * 1000);
  const row = {
    max_sends: 2,
    auto_send: true,
    allow_custom_with_approval: true,
    status: "active",
    recipient_email: "dana@test.example",
    ...overrides,
    expires_at: expires,
  };
  await pool.query("INSERT INTO owners (id, google_sub, email) VALUES ($1, $2, $3)", [owner, `sub-${owner}`, "owner@example.com"]);
  await pool.query("INSERT INTO connections (id, owner_id, provider, account_email) VALUES ($1, $2, 'gmail', 'owner@example.com')", [
    connection,
    owner,
  ]);
  await pool.query("INSERT INTO agent_connections (id, owner_id, client_id, client_label) VALUES ($1, $2, 'client-1', 'ChatGPT (declared)')", [
    agentConnection,
    owner,
  ]);
  await pool.query("INSERT INTO templates (id, owner_id, subject_tpl, body_tpl, fields, sha256) VALUES ($1, $2, $3, $4, $5::jsonb, $6)", [
    template,
    owner,
    TEMPLATE_TEXT.subject_tpl,
    TEMPLATE_TEXT.body_tpl,
    JSON.stringify(Object.keys(FIELD_RULES)),
    sha,
  ]);
  await pool.query(
    `INSERT INTO jobs (id, owner_id, connection_id, agent_connection_id, purpose, recipient_email, template_id, template_sha256,
                       field_rules, max_sends, expires_at, auto_send, allow_custom_with_approval, ai_review, policy_version, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, 'custom_only', 1, $14)`,
    [
      job,
      owner,
      connection,
      agentConnection,
      "Send Dana at Acme a recap of Tuesday's call.",
      row.recipient_email,
      template,
      sha,
      JSON.stringify(FIELD_RULES),
      row.max_sends,
      row.expires_at,
      row.auto_send,
      row.allow_custom_with_approval,
      row.status,
    ],
  );
  return {
    owner,
    connection,
    agentConnection,
    job,
    template: { id: template, sha256: sha, ...TEMPLATE_TEXT },
    renderJob: {
      v: 1,
      job_id: job,
      policy_version: 1,
      owner,
      connection,
      agent_connection: agentConnection,
      provider: "gmail",
      sender: "owner@example.com",
      recipient: row.recipient_email,
      purpose: "Send Dana at Acme a recap of Tuesday's call.",
      template: { id: template, sha256: sha },
      field_rules: FIELD_RULES,
      max_sends: row.max_sends,
      expires_at: isoSeconds(row.expires_at),
      auto_send: row.auto_send,
      allow_custom_with_approval: row.allow_custom_with_approval,
      ai_review: "custom_only",
    },
  };
}

/**
 * store_version's stand-in: render with slice 1, insert the proposal (if new) and the version, and
 * write PROPOSAL_CREATED in the same transaction. `versionTag` stores bytes a re-render would not
 * produce, so a test can tell stored bytes from re-rendered ones.
 */
export async function storeVersion(executor, pool, seed, options = {}) {
  const { call = { fields: { ...FIELDS } }, reasons = [], proposalId: existing, version = 1, versionTag, policyVersion = 1 } = options;
  const job = { ...seed.renderJob, policy_version: policyVersion };
  const { draft } = render(job, job.recipient, call, call.fields ? seed.template : null);
  const mime = versionTag
    ? buildMime({ from: job.sender, to: job.recipient, subject: draft.subject, body: draft.body, versionTag })
    : draft.mime;
  const canonical = versionCanonical(job, { ...draft, mime });
  const sha256 = versionSha256(canonical);
  const proposalId = existing ?? newId("prp");
  const versionId = newId("pv");
  await withTx(pool, seed.owner, async (tx) => {
    if (!existing) {
      await tx.client.query("INSERT INTO proposals (id, job_id, current_version, status) VALUES ($1, $2, $3, 'pending')", [
        proposalId,
        seed.job,
        version,
      ]);
    } else {
      await tx.client.query("UPDATE proposal_versions SET state = 'superseded' WHERE proposal_id = $1 AND state = 'pending'", [proposalId]);
      await tx.client.query("UPDATE proposals SET current_version = $2 WHERE id = $1", [proposalId, version]);
    }
    await tx.client.query(
      `INSERT INTO proposal_versions (id, proposal_id, version, recipient, subject, body, mime, canonical, sha256, policy_version, review_reasons)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
      [versionId, proposalId, version, draft.recipient, draft.subject, draft.body, Buffer.from(mime), JSON.stringify(canonical), sha256, policyVersion, reasons],
    );
    await executor.writeReceipt(tx, existing ? "PROPOSAL_REVISED" : "PROPOSAL_CREATED", {
      job: seed.job,
      policy_version: policyVersion,
      agent_connection: seed.agentConnection,
      client_label: "ChatGPT (declared)",
      proposal: proposalId,
      version,
      version_sha256: sha256,
      detail: { review_reasons: reasons },
    });
  });
  return { proposalId, versionId, version, sha256, mime };
}

/** An executor over warden's fault-injecting stub provider. */
export function makeExecutor(pool, options = {}) {
  const stub = options.stub ?? createStubMailProvider({ script: options.script ?? [] });
  const connections = [];
  const executor = createExecutor({
    pool,
    signingKey: KEY.privateKeyPem,
    mailProviderFor: options.mailProviderFor ?? ((connection) => (connections.push(connection), stub.provider)),
    demoRecipients: options.demoRecipients,
    revoke: options.revoke,
    providerTimeoutMs: options.providerTimeoutMs,
    sweepAfterMs: options.sweepAfterMs,
  });
  return { executor, stub, connections };
}

export async function jobRow(pool, jobId) {
  return (await pool.query("SELECT * FROM jobs WHERE id = $1", [jobId])).rows[0];
}

export async function dispatchesOf(pool, versionId) {
  return (await pool.query("SELECT * FROM dispatches WHERE proposal_version_id = $1", [versionId])).rows;
}

/** The owner's receipts with parsed payloads, in sequence order. */
export async function receiptsOf(pool, owner) {
  return (await listReceipts(pool, owner)).map((r) => ({ ...r, body: JSON.parse(r.payload) }));
}

export const typesOf = (receipts) => receipts.map((r) => r.type);

/** Every receipt verifies, and the owner's sequence is 1..n with no gap or repeat. */
export async function assertReceiptChain(pool, owner) {
  const receipts = await receiptsOf(pool, owner);
  assert.deepEqual(
    receipts.map((r) => r.seq),
    receipts.map((_, i) => i + 1),
    "receipt seq is 1..n",
  );
  const counter = (await pool.query("SELECT receipt_seq FROM owners WHERE id = $1", [owner])).rows[0].receipt_seq;
  assert.equal(counter, receipts.length, "the owner's counter matches the receipts written");
  for (const r of receipts) {
    assert.equal(r.body.seq, r.seq, "the signed seq is the stored seq");
    assert.equal(r.body.owner, owner);
    assert.deepEqual(await verifyReceipt(r, PINNED), { ok: true, reason: "verified" }, `${r.type} #${r.seq} verifies`);
  }
  return receipts;
}

/** Waits until `check()` is truthy, polling every 10 ms, for at most `ms`. */
export async function waitFor(check, ms = 5000, label = "condition") {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Edits a stored version behind the immutability trigger, as a direct database edit would. */
export async function tamperVersion(pool, versionId, setSql, values = []) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("ALTER TABLE proposal_versions DISABLE TRIGGER proposal_versions_immutable");
    await client.query(`UPDATE proposal_versions SET ${setSql} WHERE id = $1`, [versionId, ...values]);
    await client.query("ALTER TABLE proposal_versions ENABLE TRIGGER proposal_versions_immutable");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
