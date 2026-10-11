import type { Pool } from "pg";

import { reviewReasons, type Review, type ReviewInput } from "../ai-review/provider.js";
import { isAskMeReason, isNeverReason, type AskMeReason, type NeverReason } from "../contract/reasons.js";
import type { AgentConnection, DispatchOutcome, JobListing, ProposalStatus, ProposeSendCall, ReviseCall, SendResult, StatusResult } from "../contract/types.js";
import { checkCall, type GatePass } from "../gate/checks.js";
import type { McpBackend, SendOutcome } from "../server/http.js";
import { one } from "./db/tx.js";
import { MAX_VERSIONS, Refusal, type Executor, type PreparedVersion, type StoredVersion } from "./dispatch.js";
import { canonicalSha256Hex, sha256Hex } from "./hash.js";
import { JOB_RECORD_SQL, authorityOf, isoSeconds, type JobRecord } from "./jobs.js";
import { RenderError, type RenderErrorCode } from "./render/errors.js";
import { render } from "./render/render.js";
import type { SendCall, Template } from "./render/types.js";

// The gate's wiring (spec: "The gate") and the McpBackend /mcp calls. Around the pure content
// checks in gate/checks.ts, in the spec's order:
//   record_attempt  the arguments only as their hash (an attempts row, written with the outcome);
//   find_job        this owner's job, for this agent connection;
//   rate_limited    ten refused attempts in the last hour, per connection and job;
//   status, expiry and STOP, on the database clock;
//   content checks  checkCall: recipient, the early send-limit answer, fields or custom wording;
//   render, the other-client labels and AI review, all before any transaction opens;
//   store_version   PROPOSAL_CREATED; then dispatch_auto when nothing asks for the owner.
// A denial writes the attempt and ATTEMPT_DENIED and nothing else.

/** Refused attempts per agent connection and job in one hour before rate_limited (spec: 10). */
export const DENIALS_PER_HOUR = 10;

export type BackendOptions = {
  pool: Pool;
  executor: Executor;
  /**
   * The AI review: ai-review/provider's aiReview with its options bound. Without one, a version
   * that wants review is held with ai_review_unavailable (review can only add a hold).
   */
  review?: (input: ReviewInput) => Promise<Review>;
  denialsPerHour?: number;
};

type Tool = "propose_send" | "revise_proposal";

/** Render errors that are the agent's call breaking a rule; any other render error is ours. */
const RENDER_DENIALS: Partial<Record<RenderErrorCode, NeverReason>> = {
  missing_field: "field_invalid",
  invalid_field_value: "field_invalid",
  invalid_text: "field_invalid",
  header_injection: "field_invalid",
  field_not_allowed: "field_not_allowed",
  invalid_call: "field_not_allowed",
  custom_not_allowed: "custom_not_allowed",
  recipient_not_in_job: "recipient_not_in_job",
};

/** The tool call's arguments as a hash; the arguments themselves are never stored. */
function argsSha256(args: unknown): string {
  try {
    return canonicalSha256Hex(args);
  } catch {
    // Not representable in JCS (a float, a lone surrogate): hash its JSON text instead.
    return sha256Hex(JSON.stringify(args) ?? "null");
  }
}

/** custom_only: custom wording; all_free_text: any agent-written free text; off: never. */
function wantsReview(job: JobRecord, pass: GatePass): boolean {
  if (job.ai_review === "custom_only") return pass.mode === "custom";
  if (job.ai_review === "all_free_text") return pass.freeText.trim() !== "";
  return false;
}

/**
 * The ask-me reasons, once each. A reason outside the allow-list is a bug upstream (a new AI-review
 * flag, say): it fails closed, storing and sending nothing, rather than being dropped, which would
 * lift a hold.
 */
function askMe(reasons: readonly string[]): AskMeReason[] {
  const unknown = reasons.find((reason) => !isAskMeReason(reason));
  if (unknown !== undefined) throw new Error(`not an ask-me reason: ${unknown.slice(0, 80)}`);
  return [...new Set(reasons)] as AskMeReason[];
}

type Prepared = { ok: true; prepared: PreparedVersion } | { ok: false; reason: NeverReason; field?: string };

export function createMcpBackend(options: BackendOptions): McpBackend {
  const { pool, executor } = options;
  const denialsPerHour = options.denialsPerHour ?? DENIALS_PER_HOUR;

  async function findJob(jobId: unknown, conn: AgentConnection): Promise<JobRecord | null> {
    if (typeof jobId !== "string") return null;
    const job = await one<JobRecord>(pool, `${JOB_RECORD_SQL} WHERE j.id = $1 AND j.owner_id = $2 AND j.agent_connection_id = $3`, [
      jobId,
      conn.owner_id,
      conn.id,
    ]);
    return job ?? null;
  }

  const outcomeOf = (job: JobRecord | null, result: SendResult): SendOutcome => ({
    result,
    recipient: job?.recipient_email ?? "",
    maxSends: job?.max_sends ?? 0,
  });

  async function deny(conn: AgentConnection, job: JobRecord | null, tool: Tool, argsSha: string, reason: NeverReason, field?: string) {
    const receipt_id = await executor.recordDenial({
      owner: conn.owner_id,
      agentConnectionId: conn.id,
      clientLabel: conn.client_label,
      job: job ? { id: job.id, policy_version: job.policy_version } : null,
      tool,
      argsSha256: argsSha,
      reason,
      ...(field !== undefined ? { field } : {}),
    });
    return outcomeOf(job, { status: "denied", sent: false, approvable: false, reason_code: reason, receipt_id });
  }

  /** The gate's database checks before the content checks; the first failure wins. */
  async function preflight(conn: AgentConnection, job: JobRecord): Promise<NeverReason | null> {
    const row = await one<{ denials: number; now: Date }>(
      pool,
      `SELECT count(*)::int AS denials, clock_timestamp() AS now FROM attempts
       WHERE agent_connection_id = $1 AND job_id = $2 AND decision = 'denied' AND created_at > clock_timestamp() - interval '1 hour'`,
      [conn.id, job.id],
    );
    if (!row || row.denials >= denialsPerHour) return "rate_limited";
    if (job.status !== "active") return "job_inactive";
    if (!(row.now.getTime() < job.expires_at.getTime())) return "job_expired";
    if (!job.dispatch_enabled || job.connection_status !== "active") return "dispatch_stopped";
    return null;
  }

  /** other_client_labels(job): the owner's other clients by label, never the recipient's own. */
  async function otherClientLabels(job: JobRecord): Promise<string[]> {
    const { rows } = await pool.query<{ label: string }>(
      `SELECT DISTINCT client_label AS label FROM contacts
       WHERE owner_id = $1 AND client_label IS NOT NULL AND email <> $2
         AND client_label NOT IN (SELECT client_label FROM contacts WHERE owner_id = $1 AND email = $2 AND client_label IS NOT NULL)
       ORDER BY 1`,
      [job.owner_id, job.recipient_email],
    );
    return rows.map((row) => row.label);
  }

  async function templateOf(job: JobRecord): Promise<Template | null> {
    const row = await one<Template>(pool, "SELECT id, sha256, subject_tpl, body_tpl FROM templates WHERE id = $1", [job.template_id]);
    return row ?? null;
  }

  async function runReview(input: ReviewInput): Promise<Review> {
    if (!options.review) return { outcome: "unavailable", error: "not_configured", ms: 0 };
    try {
      return await options.review(input);
    } catch {
      return { outcome: "unavailable", error: "exception", ms: 0 };
    }
  }

  /** The content checks, render and AI review: everything before store_version, outside any transaction. */
  async function prepare(conn: AgentConnection, job: JobRecord, call: ProposeSendCall, tool: Tool, argsSha: string): Promise<Prepared> {
    const authority = authorityOf(job);
    const labels = await otherClientLabels(job);
    const checked = checkCall(authority, call, { sendsReserved: job.sends_reserved, otherClientLabels: labels });
    if (!checked.ok) {
      // Name the field only when the job defines it: an agent-made key never reaches a receipt.
      const known = checked.field !== undefined && (checked.field in job.field_rules || checked.field === "custom_subject" || checked.field === "custom_body");
      return { ok: false, reason: checked.reason, ...(known ? { field: checked.field } : {}) };
    }
    const sendCall: SendCall =
      checked.mode === "template" ? { fields: checked.fields ?? {} } : { custom_subject: checked.subject ?? "", custom_body: checked.body ?? "" };
    let rendered;
    try {
      rendered = render(authority, checked.to, sendCall, checked.mode === "template" ? await templateOf(job) : null);
    } catch (error) {
      const reason = error instanceof RenderError ? RENDER_DENIALS[error.code] : undefined;
      if (reason) return { ok: false, reason };
      throw error;
    }
    let review: Review | null = null;
    const reasons: string[] = [...checked.reasons];
    if (wantsReview(job, checked)) {
      review = await runReview({ jobPurpose: job.purpose, otherClients: labels, subject: rendered.draft.subject, freeText: checked.freeText });
      reasons.push(...reviewReasons(review));
    }
    return {
      ok: true,
      prepared: {
        job: authority,
        clientLabel: job.client_label,
        draft: rendered.draft,
        canonical: rendered.canonical,
        sha256: rendered.version_sha256,
        reasons: askMe(reasons),
        review,
        attempt: { agentConnectionId: conn.id, tool, argsSha256: argsSha },
      },
    };
  }

  /** The newest receipt naming this proposal, of one of `types`. */
  async function lastReceipt(owner: string, proposalId: string, types: readonly string[]): Promise<string> {
    const row = await one<{ id: string }>(
      pool,
      "SELECT id FROM receipts WHERE owner_id = $1 AND type = ANY($3) AND (payload::jsonb ->> 'proposal') = $2 ORDER BY seq DESC LIMIT 1",
      [owner, proposalId, types],
    );
    if (!row) throw new Error(`no ${types.join("/")} receipt for proposal ${proposalId}`);
    return row.id;
  }

  async function sendsLeft(jobId: string): Promise<number> {
    const row = await one<{ left: number }>(pool, "SELECT max_sends - sends_reserved AS left FROM jobs WHERE id = $1", [jobId]);
    return Math.max(0, row?.left ?? 0);
  }

  /** What a repeated operation_id answers: the existing proposal's state, creating nothing. */
  async function proposalResult(proposalId: string, job: JobRecord): Promise<SendResult> {
    const row = await one<{
      status: ProposalStatus;
      version: number;
      sha256: string;
      review_reasons: string[];
      provider_message_id: string | null;
      error_class: string | null;
    }>(
      pool,
      `SELECT p.status, p.current_version AS version, v.sha256, v.review_reasons, d.provider_message_id, d.error_class
       FROM proposals p
       JOIN proposal_versions v ON v.proposal_id = p.id AND v.version = p.current_version
       LEFT JOIN dispatches d ON d.proposal_version_id = v.id
       WHERE p.id = $1`,
      [proposalId],
    );
    if (!row) throw new Error(`proposal ${proposalId} not found`);
    const owner = job.owner_id;
    switch (row.status) {
      case "pending":
        return { status: "pending_approval", sent: false, proposal_id: proposalId, version: row.version, review_reasons: askMe(row.review_reasons) };
      case "accepted":
        return {
          status: "sent",
          sent: true,
          proposal_id: proposalId,
          version: row.version,
          version_sha256: row.sha256,
          provider_message_id: row.provider_message_id ?? "",
          receipt_id: await lastReceipt(owner, proposalId, ["PROVIDER_ACCEPTED"]),
          sends_left: await sendsLeft(job.id),
        };
      case "not_sent":
        return {
          status: "not_sent",
          sent: false,
          proposal_id: proposalId,
          error_class: row.error_class ?? "not_sent",
          receipt_id: await lastReceipt(owner, proposalId, ["NOT_SENT", "OUTCOME_RESOLVED"]),
        };
      case "rejected":
        return {
          status: "denied",
          sent: false,
          approvable: false,
          reason_code: "not_revisable",
          receipt_id: await lastReceipt(owner, proposalId, ["APPROVAL_REJECTED"]),
        };
      default: // dispatching or unknown: the provider may have it.
        return {
          status: "unknown",
          sent: null,
          proposal_id: proposalId,
          receipt_id: await lastReceipt(owner, proposalId, ["OUTCOME_UNKNOWN", "DISPATCH_RESERVED"]),
        };
    }
  }

  /** dispatch_auto's outcome, in the agent's terms. */
  async function dispatchResult(outcome: DispatchOutcome, stored: StoredVersion, job: JobRecord): Promise<SendResult> {
    if (outcome.kind === "refused") {
      // auto_send was turned off after the gate read the job: the version is waiting for the owner.
      if (outcome.reason === "needs_review") {
        return { status: "pending_approval", sent: false, proposal_id: stored.proposalId, version: stored.version, review_reasons: [] };
      }
      // A reservation refused right after its version was stored: the job changed in between.
      const reason: NeverReason | null = isNeverReason(outcome.reason) ? outcome.reason : outcome.reason === "policy_changed" ? "job_inactive" : null;
      if (!reason) throw new Error(`dispatch_auto refused a version it had just stored: ${outcome.reason}`);
      return { status: "denied", sent: false, approvable: false, reason_code: reason, receipt_id: outcome.receipt_id };
    }
    const { outcome: mail, receipt_id } = outcome;
    if (mail.status === "accepted") {
      return {
        status: "sent",
        sent: true,
        proposal_id: stored.proposalId,
        version: stored.version,
        version_sha256: stored.sha256,
        provider_message_id: mail.providerMessageId,
        receipt_id,
        sends_left: await sendsLeft(job.id),
      };
    }
    if (mail.status === "not_sent") return { status: "not_sent", sent: false, proposal_id: stored.proposalId, error_class: mail.errorClass, receipt_id };
    return { status: "unknown", sent: null, proposal_id: stored.proposalId, receipt_id };
  }

  return {
    async connection(agentConnectionId) {
      // The Connect screen shows when the agent last called; touched at most once a minute.
      const touched = await one<AgentConnection>(
        pool,
        `UPDATE agent_connections SET last_used_at = clock_timestamp()
         WHERE id = $1 AND revoked_at IS NULL AND (last_used_at IS NULL OR last_used_at < clock_timestamp() - interval '1 minute')
         RETURNING id, owner_id, client_id, client_label`,
        [agentConnectionId],
      );
      if (touched) return touched;
      const row = await one<AgentConnection>(
        pool,
        "SELECT id, owner_id, client_id, client_label FROM agent_connections WHERE id = $1 AND revoked_at IS NULL",
        [agentConnectionId],
      );
      return row ?? null;
    },

    async listJobs(conn): Promise<JobListing[]> {
      const { rows } = await pool.query<JobRecord>(
        `${JOB_RECORD_SQL}
         WHERE j.owner_id = $1 AND j.agent_connection_id = $2 AND j.status = 'active' AND j.expires_at > clock_timestamp()
         ORDER BY j.created_at, j.id`,
        [conn.owner_id, conn.id],
      );
      return rows.map((job) => ({
        job_id: job.id,
        purpose: job.purpose,
        recipient: job.recipient_email,
        template_fields: job.field_rules,
        allow_custom_with_approval: job.allow_custom_with_approval,
        sends_left: Math.max(0, job.max_sends - job.sends_reserved),
        expires_at: isoSeconds(job.expires_at),
      }));
    },

    async proposeSend(call, conn) {
      const tool = "propose_send";
      const argsSha = argsSha256(call);
      const job = await findJob(call?.job_id, conn);
      if (!job) return deny(conn, null, tool, argsSha, "job_not_found");
      const operationId = typeof call.operation_id === "string" ? call.operation_id : null;
      if (operationId !== null) {
        const existing = await one<{ id: string }>(pool, "SELECT id FROM proposals WHERE job_id = $1 AND operation_id = $2", [job.id, operationId]);
        if (existing) return outcomeOf(job, await proposalResult(existing.id, job));
      }
      const stop = await preflight(conn, job);
      if (stop) return deny(conn, job, tool, argsSha, stop);
      const ready = await prepare(conn, job, call, tool, argsSha);
      if (!ready.ok) return deny(conn, job, tool, argsSha, ready.reason, ready.field);
      const stored = await executor.storeVersion(ready.prepared, operationId);
      if ("replayOf" in stored) return outcomeOf(job, await proposalResult(stored.replayOf, job));
      if (ready.prepared.reasons.length === 0 && job.auto_send) {
        return outcomeOf(job, await dispatchResult(await executor.dispatch_auto(stored.versionId), stored, job));
      }
      return outcomeOf(job, {
        status: "pending_approval",
        sent: false,
        proposal_id: stored.proposalId,
        version: stored.version,
        review_reasons: ready.prepared.reasons,
      });
    },

    async revise(call: ReviseCall, conn) {
      const tool = "revise_proposal";
      const argsSha = argsSha256(call);
      const base =
        typeof call?.proposal_id === "string"
          ? await one<{ job_id: string; current_version: number; status: ProposalStatus }>(
              pool,
              `SELECT p.job_id, p.current_version, p.status FROM proposals p JOIN jobs j ON j.id = p.job_id
               WHERE p.id = $1 AND j.owner_id = $2 AND j.agent_connection_id = $3`,
              [call.proposal_id, conn.owner_id, conn.id],
            )
          : undefined;
      const job = base ? await findJob(base.job_id, conn) : null;
      if (!base || !job) return deny(conn, null, tool, argsSha, "job_not_found");
      if (base.status !== "pending" || base.current_version >= MAX_VERSIONS) return deny(conn, job, tool, argsSha, "not_revisable");
      const stop = await preflight(conn, job);
      if (stop) return deny(conn, job, tool, argsSha, stop);
      const { proposal_id: proposalId, ...content } = call;
      const ready = await prepare(conn, job, { ...content, job_id: job.id, to: job.recipient_email }, tool, argsSha);
      if (!ready.ok) return deny(conn, job, tool, argsSha, ready.reason, ready.field);
      let stored: StoredVersion;
      try {
        stored = await executor.storeRevision(ready.prepared, proposalId, base.current_version);
      } catch (error) {
        // Revised or decided by someone else since it was read.
        if (error instanceof Refusal) return deny(conn, job, tool, argsSha, "not_revisable");
        throw error;
      }
      return outcomeOf(job, {
        status: "pending_approval",
        sent: false,
        proposal_id: stored.proposalId,
        version: stored.version,
        review_reasons: ready.prepared.reasons,
      });
    },

    async getStatus(proposalId, conn): Promise<StatusResult | null> {
      if (typeof proposalId !== "string") return null;
      const row = await one<{ id: string; status: ProposalStatus; version: number; sha256: string; provider_message_id: string | null }>(
        pool,
        `SELECT p.id, p.status, p.current_version AS version, v.sha256, d.provider_message_id
         FROM proposals p
         JOIN jobs j ON j.id = p.job_id
         JOIN proposal_versions v ON v.proposal_id = p.id AND v.version = p.current_version
         LEFT JOIN dispatches d ON d.proposal_version_id = v.id
         WHERE p.id = $1 AND j.owner_id = $2 AND j.agent_connection_id = $3`,
        [proposalId, conn.owner_id, conn.id],
      );
      if (!row) return null;
      return {
        proposal_id: row.id,
        status: row.status,
        version: row.version,
        version_sha256: row.sha256,
        provider_message_id: row.status === "accepted" ? row.provider_message_id : null,
      };
    },
  };
}
