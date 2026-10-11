// Reason codes and what the agent is told, from the spec's gate table. A denial names only the
// rule that fired, with a fixed sentence. "never" reasons create no proposal and nothing
// approvable; "ask_me" reasons hold one exact version for the owner.

import { FLAGS, type Flag } from "../ai-review/flags.js";

export const NEVER_REASONS = [
  "job_not_found",
  "job_inactive",
  "job_expired",
  "dispatch_stopped",
  "recipient_invalid",
  "recipient_not_in_job",
  "limit_reached",
  "field_not_allowed",
  "field_invalid",
  "custom_not_allowed",
  "rate_limited",
  // revise_proposal on a proposal that was sent, rejected or reached its version limit (spec:
  // revise, "else deny(not_revisable)"); also a repeated operation_id whose proposal was rejected.
  "not_revisable",
] as const;
export type NeverReason = (typeof NEVER_REASONS)[number];

export type AiReviewReason = `ai_review:${Flag}` | "ai_review_unavailable";
export const ASK_ME_BASE_REASONS = ["custom_content", "mentions_other_client"] as const;
export type AskMeReason = (typeof ASK_ME_BASE_REASONS)[number] | AiReviewReason;

/** Why the gate stopped (never) or held (ask me) a call. */
export type ReasonCode = NeverReason | AskMeReason;

/** Why a reservation, approval or revision was refused after the gate (spec: dispatch, approval and revision). */
export const DISPATCH_REFUSALS = [
  "dispatch_stopped",
  "job_inactive",
  "job_expired",
  "superseded",
  "policy_changed",
  "recipient_not_in_job",
  "integrity",
  "needs_review",
  "limit_reached",
  "not_pending",
  "hash_mismatch",
  "not_revisable",
] as const;
export type DispatchRefusal = (typeof DISPATCH_REFUSALS)[number];

/** Every reason that asks the owner. Allow-listed: anything not in it is never approvable. */
export const ASK_ME_REASONS: readonly AskMeReason[] = Object.freeze([
  ...ASK_ME_BASE_REASONS,
  ...FLAGS.map((flag): AskMeReason => `ai_review:${flag}`),
  "ai_review_unavailable",
]);

export function isAskMeReason(reason: unknown): reason is AskMeReason {
  return typeof reason === "string" && (ASK_ME_REASONS as readonly string[]).includes(reason);
}

export function isNeverReason(reason: unknown): reason is NeverReason {
  return typeof reason === "string" && (NEVER_REASONS as readonly string[]).includes(reason);
}

/**
 * Whether the owner may approve past a reason. Fails CLOSED: reasons reach this from the database
 * and from JSON at runtime, so only an exact, allow-listed ask-me reason is "ask_me". A refusal
 * code, a typo, a case or whitespace variant, an unknown AI-review flag or an empty string is
 * "never".
 */
export function reasonClass(reason: unknown): "never" | "ask_me" {
  return isAskMeReason(reason) ? "ask_me" : "never";
}

const NEVER_SENTENCES: Record<NeverReason, string> = {
  job_not_found: "No active job with that id for this connection.",
  job_inactive: "This job is closed. Nothing was sent.",
  job_expired: "This job is closed. Nothing was sent.",
  dispatch_stopped: "The owner has stopped sending. Nothing was sent.",
  recipient_invalid: "The recipient must be exactly one email address.",
  recipient_not_in_job:
    "Not sent. This job may only email its one recipient. This cannot be approved. The owner would need a separate job.",
  limit_reached: "Not sent. This job's send limit is used up.",
  field_not_allowed: "Not sent. The named field breaks the job's rule. Fix it and try again.",
  field_invalid: "Not sent. The named field breaks the job's rule. Fix it and try again.",
  custom_not_allowed: "Not sent. This job allows only the approved template.",
  rate_limited: "Too many refused attempts. Stop and tell the user.",
  not_revisable:
    "This proposal is closed: it was sent, rejected, or reached its version limit. Nothing more was sent. Start a new one with propose_send.",
};

/** The fixed sentence the agent is told for a reason (spec: the gate's table). */
export function agentSentence(reason: unknown): string {
  if (isNeverReason(reason)) return NEVER_SENTENCES[reason];
  if (reason === "custom_content" || reason === "mentions_other_client") {
    return "Not sent yet. This version needs the owner's approval.";
  }
  if (isAskMeReason(reason)) return "Not sent yet. Held for the owner's review.";
  // Not a known reason: say nothing about it, and never suggest an approval.
  return "Not sent. This cannot be approved.";
}
