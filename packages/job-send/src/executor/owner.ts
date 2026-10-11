import type { Pool } from "pg";

import type { FieldRule, Job } from "../contract/types.js";
import { FORBIDDEN_CHARACTERS } from "../gate/checks.js";
import { listReceipts } from "../receipts/store.js";
import { OWNER_ERRORS, OwnerError, type JobDraftInput, type OwnerCore, type OwnerErrorCode, type OwnerErrorField } from "../server/owner-api.js";
import { newId, one, withTx } from "./db/tx.js";
import { NotFoundError, type Executor } from "./dispatch.js";
import { JOB_RECORD_SQL, authorityOf, authoritySha256, isoSeconds, type JobRecord } from "./jobs.js";
import { normalizeAddress } from "./render/address.js";
import { placeholderNames } from "./render/fill.js";

// The owner's side of the core, as the owner API's OwnerCore (server/owner-api.ts): a job is drafted,
// shown with its authority hash, and confirmed only for exactly that hash; a version is rejected
// only as shown; STOP, UNKNOWN resolution, disconnecting an agent; and the owner-scoped reads. Every
// function takes the signed-in owner and touches only that owner's rows. Every refusal is an
// OwnerError with a listed code, so the route answers it by name; another owner's id is not_found.

/** Why the owner's request was refused: finer than the route's code, for tests and logs. */
export type OwnerRefusalReason =
  | "recipient_invalid"
  | "max_sends_invalid"
  | "expires_at_invalid"
  | "purpose_invalid"
  | "options_invalid"
  | "template_required"
  | "template_not_found"
  | "field_rules_required"
  | "field_rules_invalid"
  | "connection_required"
  | "agent_connection_required"
  | "authority_changed"
  | "not_draft"
  | "job_expired"
  | "dispatch_stopped"
  | "agent_connection_revoked";

/** The route's code for each reason; a draft's validation reasons are invalid_job with the field named. */
const listed = (code: string): code is OwnerErrorCode => (OWNER_ERRORS as readonly string[]).includes(code);
function codeOf(reason: OwnerRefusalReason): OwnerErrorCode {
  if (listed(reason)) return reason;
  return "invalid_job";
}

/** Which listed field a draft refusal is about, so the confirm screen can point at it. */
const FIELD_OF: Partial<Record<OwnerRefusalReason, OwnerErrorField>> = {
  recipient_invalid: "recipient",
  max_sends_invalid: "max_sends",
  expires_at_invalid: "expires_at",
  purpose_invalid: "purpose",
  template_required: "template",
  template_not_found: "template",
  field_rules_required: "field_rules",
  field_rules_invalid: "field_rules",
  connection_required: "connection",
  agent_connection_required: "agent_connection",
};

/** An OwnerError that also says exactly which rule refused. */
export class OwnerRefusal extends OwnerError {
  constructor(readonly reason: OwnerRefusalReason) {
    const field = FIELD_OF[reason];
    super(codeOf(reason), field ? { field } : {});
    this.name = "OwnerRefusal";
  }
}

/** The most sends one job may allow, and how far ahead it may expire. */
export const MAX_SENDS_LIMIT = 50;
export const MAX_JOB_DAYS = 31;
const PURPOSE_MAX = 500;
const FIELD_MAX_LIMIT = 5000;
const RULE_KEYS = new Set(["max", "single_line", "required", "free_text"]);

/**
 * What createJobDraft accepts: the route's JobDraftInput, or less. A missing templateId uses the
 * app's default template; missing field rules, the template's own; missing connection ids, the
 * owner's one active Gmail connection and one unrevoked agent connection.
 */
export type JobDraftRequest = Partial<JobDraftInput> &
  Pick<JobDraftInput, "recipient" | "maxSends" | "expiresAt"> & { fieldRules?: Record<string, FieldRule> };

export type OwnerCoreOptions = {
  pool: Pool;
  executor: Executor;
  /** The agent connection URL the Connect screen shows: the public origin plus "/mcp". */
  mcpUrl: string;
  /** The template a draft uses when it names none (the demo's seeded one). */
  defaultTemplateId?: string;
};

/** Field rules: exactly the template's placeholders, each with a whole-number max and boolean flags. */
function checkedFieldRules(value: unknown, placeholders: readonly string[]): Record<string, FieldRule> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const rules = value as Record<string, unknown>;
  const names = Object.keys(rules).sort();
  const wanted = [...new Set(placeholders)].sort();
  if (names.length !== wanted.length || names.some((name, i) => name !== wanted[i])) return null;
  const out: Record<string, FieldRule> = {};
  for (const name of names) {
    const rule = rules[name];
    if (rule === null || typeof rule !== "object" || Array.isArray(rule)) return null;
    const r = rule as Record<string, unknown>;
    if (Object.keys(r).some((key) => !RULE_KEYS.has(key))) return null;
    if (!Number.isInteger(r.max) || (r.max as number) < 1 || (r.max as number) > FIELD_MAX_LIMIT) return null;
    for (const flag of ["single_line", "required", "free_text"] as const) {
      if (r[flag] !== undefined && typeof r[flag] !== "boolean") return null;
    }
    out[name] = {
      max: r.max as number,
      ...(r.single_line !== undefined ? { single_line: r.single_line as boolean } : {}),
      ...(r.required !== undefined ? { required: r.required as boolean } : {}),
      ...(r.free_text !== undefined ? { free_text: r.free_text as boolean } : {}),
    };
  }
  return out;
}

const optionalBoolean = (value: unknown) => value === undefined || typeof value === "boolean";

/** Runs a core call; another owner's row (NotFoundError) becomes the route's not_found. */
async function scoped<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof NotFoundError) throw new OwnerError("not_found");
    throw error;
  }
}

export function createOwnerCore(options: OwnerCoreOptions) {
  const { pool, executor } = options;

  async function jobRecord(jobId: string, owner: string): Promise<JobRecord> {
    const job = await one<JobRecord>(pool, `${JOB_RECORD_SQL} WHERE j.id = $1 AND j.owner_id = $2`, [jobId, owner]);
    if (!job) throw new OwnerError("not_found");
    return job;
  }

  /** The owner's one row of a kind, or the named one if it is the owner's; else the refusal. */
  async function pick(sql: string, owner: string, id: string | undefined, refusal: OwnerRefusalReason): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(sql, [owner]);
    if (id !== undefined) {
      if (typeof id !== "string" || !rows.some((row) => row.id === id)) throw new OwnerRefusal(refusal);
      return id;
    }
    if (rows.length !== 1) throw new OwnerRefusal(refusal);
    return rows[0]!.id;
  }

  /**
   * createJobDraft(owner, draft): a `draft` job, and the authority object with the hash the confirm
   * screen shows. Nothing is approved yet and no receipt is written: JOB_CONFIRMED comes at confirm.
   */
  async function createJobDraft(owner: string, input: JobDraftRequest): Promise<{ job: Job; authoritySha256: string }> {
    if (input === null || typeof input !== "object") throw new OwnerRefusal("options_invalid");
    const recipient = normalizeAddress(input.recipient);
    if (!recipient) throw new OwnerRefusal("recipient_invalid");
    if (!Number.isInteger(input.maxSends) || input.maxSends < 1 || input.maxSends > MAX_SENDS_LIMIT) throw new OwnerRefusal("max_sends_invalid");
    const purpose = input.purpose ?? "";
    if (typeof purpose !== "string" || purpose.length > PURPOSE_MAX || FORBIDDEN_CHARACTERS.test(purpose.replace(/\n/g, " "))) {
      throw new OwnerRefusal("purpose_invalid");
    }
    const aiReview = input.aiReview ?? "custom_only";
    if (!["off", "custom_only", "all_free_text"].includes(aiReview) || !optionalBoolean(input.autoSend) || !optionalBoolean(input.allowCustomWithApproval)) {
      throw new OwnerRefusal("options_invalid");
    }
    const expires = typeof input.expiresAt === "string" ? new Date(input.expiresAt) : new Date(Number.NaN);
    const clock = await one<{ now: Date }>(pool, "SELECT clock_timestamp() AS now");
    const now = clock?.now.getTime() ?? Number.NaN;
    if (!(expires.getTime() > now && expires.getTime() <= now + MAX_JOB_DAYS * 86400_000)) throw new OwnerRefusal("expires_at_invalid");

    const templateId = input.templateId ?? options.defaultTemplateId;
    if (typeof templateId !== "string") throw new OwnerRefusal("template_required");
    const template = await one<{ id: string; sha256: string; subject_tpl: string; body_tpl: string; fields: unknown }>(
      pool,
      "SELECT id, sha256, subject_tpl, body_tpl, fields FROM templates WHERE id = $1 AND (owner_id IS NULL OR owner_id = $2)",
      [templateId, owner],
    );
    if (!template) throw new OwnerRefusal("template_not_found");
    const placeholders = [...placeholderNames(template.subject_tpl), ...placeholderNames(template.body_tpl)];
    // A template's `fields` is its default rules object; a list of names carries no rules.
    const ruleSource = input.fieldRules ?? template.fields;
    if (input.fieldRules === undefined && (ruleSource === null || Array.isArray(ruleSource) || typeof ruleSource !== "object")) {
      throw new OwnerRefusal("field_rules_required");
    }
    const fieldRules = checkedFieldRules(ruleSource, placeholders);
    if (!fieldRules) throw new OwnerRefusal("field_rules_invalid");

    const connectionId = await pick(
      "SELECT id FROM connections WHERE owner_id = $1 AND provider = 'gmail' AND status = 'active' AND dispatch_enabled ORDER BY created_at",
      owner,
      input.connectionId,
      "connection_required",
    );
    const agentConnectionId = await pick(
      "SELECT id FROM agent_connections WHERE owner_id = $1 AND revoked_at IS NULL ORDER BY created_at",
      owner,
      input.agentConnectionId,
      "agent_connection_required",
    );

    const jobId = newId("job");
    // Whole seconds: the authority shows expires_at as "YYYY-MM-DDTHH:MM:SSZ".
    const expiresAt = new Date(Math.floor(expires.getTime() / 1000) * 1000);
    await pool.query(
      `INSERT INTO jobs (id, owner_id, connection_id, agent_connection_id, purpose, recipient_email, template_id, template_sha256,
                         field_rules, max_sends, expires_at, auto_send, allow_custom_with_approval, ai_review, policy_version, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, 1, 'draft')`,
      [
        jobId,
        owner,
        connectionId,
        agentConnectionId,
        purpose,
        recipient,
        template.id,
        template.sha256,
        JSON.stringify(fieldRules),
        input.maxSends,
        expiresAt,
        input.autoSend ?? false,
        input.allowCustomWithApproval ?? false,
        aiReview,
      ],
    );
    const job = authorityOf(await jobRecord(jobId, owner));
    return { job, authoritySha256: authoritySha256(job) };
  }

  /**
   * confirmJob(owner, jobId, shownAuthoritySha256): under the job's row lock, the authority is
   * rebuilt from the row and must hash to what the screen showed; then the job is active and
   * JOB_CONFIRMED records the hash. A job that changed since it was shown is authority_changed.
   */
  async function confirmJob(owner: string, jobId: string, shownAuthoritySha256: string) {
    return withTx(pool, owner, async (tx) => {
      const job = await one<JobRecord>(tx.client, `${JOB_RECORD_SQL} WHERE j.id = $1 AND j.owner_id = $2 FOR UPDATE OF j`, [jobId, owner]);
      if (!job) throw new OwnerError("not_found");
      if (job.status !== "draft") throw new OwnerRefusal("not_draft");
      const sha = authoritySha256(authorityOf(job));
      if (shownAuthoritySha256 !== sha) throw new OwnerRefusal("authority_changed");
      const state = await one<{ now: Date; revoked: boolean }>(
        tx.client,
        "SELECT clock_timestamp() AS now, (revoked_at IS NOT NULL) AS revoked FROM agent_connections WHERE id = $1",
        [job.agent_connection_id],
      );
      if (!state || !(state.now.getTime() < job.expires_at.getTime())) throw new OwnerRefusal("job_expired");
      if (!job.dispatch_enabled || job.connection_status !== "active") throw new OwnerRefusal("dispatch_stopped");
      if (state.revoked) throw new OwnerRefusal("agent_connection_revoked");
      await tx.client.query("UPDATE jobs SET status = 'active' WHERE id = $1", [job.id]);
      const receipt_id = await executor.writeReceipt(tx, "JOB_CONFIRMED", {
        job: job.id,
        policy_version: job.policy_version,
        agent_connection: job.agent_connection_id,
        client_label: job.client_label,
        detail: { authority_sha256: sha },
      });
      return { policyVersion: job.policy_version, authoritySha256: sha, receipt_id };
    });
  }

  /** The owner's jobs, newest first, each with its authority, its hash and its status. */
  async function listJobs(owner: string) {
    const { rows } = await pool.query<JobRecord>(`${JOB_RECORD_SQL} WHERE j.owner_id = $1 ORDER BY j.created_at DESC, j.id`, [owner]);
    return rows.map((job) => {
      const authority = authorityOf(job);
      return {
        job: authority,
        authoritySha256: authoritySha256(authority),
        status: job.status,
        sendsReserved: job.sends_reserved,
        sendsLeft: Math.max(0, job.max_sends - job.sends_reserved),
      };
    });
  }

  /** The versions waiting for this owner, newest first, with what the exception card shows. */
  async function listPendingVersions(owner: string) {
    const { rows } = await pool.query<{
      proposal_id: string;
      job_id: string;
      version: number;
      sha256: string;
      review_reasons: string[];
      subject: string;
      body: string;
      recipient: string;
      created_at: Date;
      previous_subject: string | null;
      previous_body: string | null;
    }>(
      `SELECT p.id AS proposal_id, p.job_id, v.version, v.sha256, v.review_reasons, v.subject, v.body, v.recipient, v.created_at,
              prev.subject AS previous_subject, prev.body AS previous_body
       FROM proposals p
       JOIN jobs j ON j.id = p.job_id
       JOIN proposal_versions v ON v.proposal_id = p.id AND v.version = p.current_version
       LEFT JOIN proposal_versions prev ON prev.proposal_id = p.id AND prev.version = p.current_version - 1
       WHERE j.owner_id = $1 AND p.status = 'pending' AND v.state = 'pending'
       ORDER BY v.created_at DESC, p.id`,
      [owner],
    );
    return rows.map((row) => ({
      proposalId: row.proposal_id,
      jobId: row.job_id,
      version: row.version,
      sha256: row.sha256,
      reviewReasons: row.review_reasons,
      recipient: row.recipient,
      subject: row.subject,
      body: row.body,
      createdAt: isoSeconds(row.created_at),
      // The diff baseline: version N-1 for a revision; none for version 1.
      baseline: row.previous_subject === null ? null : { subject: row.previous_subject, body: row.previous_body ?? "" },
    }));
  }

  /** What the Connect screen shows: the Gmail connection, the agent connection, and whether STOP is on. */
  async function connectState(owner: string) {
    const gmail = await one<{ id: string; account_email: string; granted_scopes: string[]; dispatch_enabled: boolean; status: string }>(
      pool,
      `SELECT id, account_email, granted_scopes, dispatch_enabled, status FROM connections
       WHERE owner_id = $1 AND provider = 'gmail' AND status <> 'revoked' ORDER BY created_at DESC, id LIMIT 1`,
      [owner],
    );
    const agent = await one<{ id: string; client_label: string; last_used_at: Date | null }>(
      pool,
      "SELECT id, client_label, last_used_at FROM agent_connections WHERE owner_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC, id LIMIT 1",
      [owner],
    );
    return {
      // status tells a lapsed connection (needs_reconnect: Reconnect Gmail) from a STOP.
      gmail: gmail ? { address: gmail.account_email, grantedScopes: gmail.granted_scopes, status: gmail.status } : null,
      agentConnection: agent
        ? { mcpUrl: options.mcpUrl, label: agent.client_label, lastUsedAt: agent.last_used_at ? isoSeconds(agent.last_used_at) : null }
        : null,
      stopped: gmail ? !gmail.dispatch_enabled || gmail.status !== "active" : false,
      connectionId: gmail?.id ?? null,
      agentConnectionId: agent?.id ?? null,
    };
  }

  /** Resolves when the agent connection is this owner's and not revoked. */
  async function assertAgentConnection(agentConnectionId: string, owner: string): Promise<void> {
    const row = await one<{ id: string }>(pool, "SELECT id FROM agent_connections WHERE id = $1 AND owner_id = $2 AND revoked_at IS NULL", [
      agentConnectionId,
      owner,
    ]);
    if (!row) throw new OwnerError("not_found");
  }

  /**
   * The owner disconnects an agent: revoked_at with AGENT_REVOKED, so /mcp refuses the connection at
   * once (McpBackend.connection reads revoked_at); the route then revokes its OAuth tokens. Revoking
   * an already revoked connection is not_found, like any connection the owner cannot use.
   */
  async function revokeAgentConnection(agentConnectionId: string, owner: string): Promise<{ receipt_id: string }> {
    return withTx(pool, owner, async (tx) => {
      const row = await one<{ id: string; client_label: string }>(
        tx.client,
        "SELECT id, client_label FROM agent_connections WHERE id = $1 AND owner_id = $2 AND revoked_at IS NULL FOR UPDATE",
        [agentConnectionId, owner],
      );
      if (!row) throw new OwnerError("not_found");
      await tx.client.query("UPDATE agent_connections SET revoked_at = clock_timestamp() WHERE id = $1", [row.id]);
      const receipt_id = await executor.writeReceipt(tx, "AGENT_REVOKED", {
        agent_connection: row.id,
        client_label: row.client_label,
        detail: { revoked_by: owner },
      });
      return { receipt_id };
    });
  }

  const core = {
    connectState,
    async engageStop(connectionId: string, owner: string) {
      const stopped = await scoped(() => executor.engageStop(connectionId, owner));
      const receipt_ids = [stopped.stopReceipt, stopped.requestReceipt, stopped.resultReceipt].filter((id): id is string => typeof id === "string");
      return { receipt_ids };
    },
    revokeAgentConnection,
    assertAgentConnection,
    createJobDraft: (owner: string, draft: JobDraftInput) => createJobDraft(owner, draft),
    confirmJob,
    listJobs,
    listPendingVersions,
    approve: (proposalId: string, version: number, shownSha256: string, owner: string) =>
      scoped(() => executor.approve(proposalId, version, shownSha256, owner)),
    async rejectVersion(proposalId: string, version: number, shownSha256: string, owner: string) {
      const result = await scoped(() => executor.rejectVersion(proposalId, version, shownSha256, owner));
      if (!result.ok) {
        if (!listed(result.reason)) throw new Error(`rejectVersion refused with ${result.reason}`);
        throw new OwnerError(result.reason);
      }
      return { receipt_id: result.receipt_id };
    },
    async resolveUnknown(dispatchId: string, outcome: "seen" | "not_arrived", owner: string) {
      const result = await scoped(() => executor.resolveUnknown(dispatchId, outcome, owner));
      if (!result.resolved) throw new OwnerError("not_unknown");
      return { receipt_id: result.receipt_id };
    },
    listReceipts: (owner: string, filter: { job: string }) => listReceipts(pool, owner, filter),
  } satisfies OwnerCore;

  // createJobDraft also takes the shorter JobDraftRequest (defaults filled in), for the app and tests.
  return { ...core, createJobDraft };
}

export type ExecutorOwnerCore = ReturnType<typeof createOwnerCore>;
