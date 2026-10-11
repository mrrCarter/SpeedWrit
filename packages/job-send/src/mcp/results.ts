// What a tool call returns to the agent (spec: the result examples under "Agent connection").
// Every result carries one plain sentence in `content` and the same facts in `structuredContent`.
// `sent: true` appears only for a send the provider accepted; an unknown outcome says "do not
// resend"; a denial is an error result that says it cannot be approved.

import { agentSentence, type AskMeReason } from "../contract/reasons.js";
import type { JobListing, SendResult, StatusResult } from "../contract/types.js";

export type McpToolResult = {
  isError: boolean;
  content: [{ type: "text"; text: string }];
  structuredContent: Record<string, unknown>;
};

const result = (isError: boolean, text: string, structured: object): McpToolResult => ({
  isError,
  content: [{ type: "text", text }],
  structuredContent: { ...structured },
});

/** Plain words for a hold reason, never the vendor or model behind AI review. */
export function holdReasonWords(reason: AskMeReason): string {
  if (reason === "custom_content") return "custom wording";
  if (reason === "mentions_other_client") return "it names another client";
  if (reason === "ai_review_unavailable") return "the review could not run";
  return "held for review";
}

/**
 * A propose_send or revise_proposal result. `recipient` and `maxSends` only shape the sentence
 * ("Sent to dana@... 1 of 2 sends left."); the facts come from `send`.
 */
export function sendToolResult(send: SendResult, context: { recipient: string; maxSends: number }): McpToolResult {
  switch (send.status) {
    case "sent":
      return result(
        false,
        `Sent to ${context.recipient}. The provider accepted it. ${send.sends_left} of ${context.maxSends} sends left.`,
        send,
      );
    case "pending_approval": {
      const why = [...new Set(send.review_reasons.map(holdReasonWords))].join(", ");
      return result(
        false,
        `Not sent yet. Version ${send.version} is waiting for the owner's approval${why ? ` (${why})` : ""}.`,
        send,
      );
    }
    case "denied":
      return result(true, agentSentence(send.reason_code), send);
    case "not_sent":
      return result(true, "Not sent. The provider refused it, and nothing was sent.", send);
    case "unknown":
      return result(false, "Outcome unknown. The provider did not confirm. Do not resend. The owner will check.", send);
  }
}

/** A get_status result. */
export function statusToolResult(status: StatusResult): McpToolResult {
  const words: Record<StatusResult["status"], string> = {
    pending: "waiting for the owner",
    dispatching: "being sent",
    accepted: "sent; the provider accepted it",
    not_sent: "not sent",
    unknown: "unknown; do not resend",
    rejected: "rejected by the owner",
  };
  return result(false, `Proposal ${status.proposal_id}, version ${status.version}: ${words[status.status]}.`, status);
}

/** A list_jobs result. */
export function listJobsToolResult(jobs: readonly JobListing[]): McpToolResult {
  const text =
    jobs.length === 0
      ? "No active jobs. Ask the owner to confirm one."
      : `${jobs.length} active ${jobs.length === 1 ? "job" : "jobs"}: ${jobs
          .map((job) => `${job.job_id} (${job.purpose}; to ${job.recipient}; ${job.sends_left} sends left)`)
          .join("; ")}.`;
  return result(false, text, { jobs });
}
