// The shared contract for job-bound sending (spec: "Interfaces to freeze before anything else").
// Signed and hashed JSON holds strings, integers, booleans and null only, with UTC timestamps.

import type { AskMeReason, DispatchRefusal, NeverReason } from "./reasons.js";

export type Provider = "gmail";

// ---- The provider ----------------------------------------------------------------------------

/** One provider call's result. `unknown` means the provider did not confirm: never resend. */
export type MailOutcome =
  | { status: "accepted"; providerMessageId: string }
  | { status: "not_sent"; errorClass: string }
  | { status: "unknown"; errorClass: string };

/** Sends the stored MIME bytes exactly once. No retry at any layer. */
export interface MailProvider {
  send(bytes: Uint8Array): Promise<MailOutcome>;
}

// ---- The job ---------------------------------------------------------------------------------

export type FieldRule = { max: number; single_line?: boolean; required?: boolean; free_text?: boolean };

/** The owner's signed-off work order. Confirming it writes JOB_CONFIRMED with sha256(JCS(job)). */
export type Job = {
  v: 1;
  job_id: string;
  policy_version: number;
  owner: string;
  connection: string;
  agent_connection: string;
  provider: Provider;
  sender: string;
  recipient: string;
  purpose: string;
  template: { id: string; sha256: string };
  field_rules: Record<string, FieldRule>;
  max_sends: number;
  expires_at: string;
  auto_send: boolean;
  allow_custom_with_approval: boolean;
  ai_review: "off" | "custom_only" | "all_free_text";
};

export type JobStatus = "draft" | "active" | "stopped" | "expired";
export type ConnectionStatus = "active" | "stopped" | "revoked" | "needs_reconnect";
export type ProposalStatus = "pending" | "dispatching" | "accepted" | "not_sent" | "unknown" | "rejected";
export type VersionState = "pending" | "superseded" | "rejected" | "dispatched";
export type DispatchStatus = "reserved" | "accepted" | "not_sent" | "unknown";

// ---- The agent's call ------------------------------------------------------------------------

/** propose_send's input. Either `fields` or `custom_subject` with `custom_body`; nothing else. */
export type ProposeSendCall = {
  job_id: string;
  to: string;
  fields?: Record<string, string>;
  custom_subject?: string;
  custom_body?: string;
  operation_id?: string;
};

/** The authenticated agent connection a bearer token resolves to. */
export type AgentConnection = {
  id: string;
  owner_id: string;
  client_id: string;
  client_label: string;
};

// ---- Results the agent sees (structuredContent) ----------------------------------------------

export type SendResult =
  | {
      status: "sent";
      sent: true;
      proposal_id: string;
      version: number;
      version_sha256: string;
      provider_message_id: string;
      receipt_id: string;
      sends_left: number;
    }
  | {
      status: "pending_approval";
      sent: false;
      proposal_id: string;
      version: number;
      review_reasons: AskMeReason[];
    }
  | {
      status: "denied";
      sent: false;
      approvable: false;
      reason_code: NeverReason;
      receipt_id: string;
    }
  | { status: "not_sent"; sent: false; proposal_id: string; error_class: string; receipt_id: string }
  | { status: "unknown"; sent: null; proposal_id: string; receipt_id: string };

/** revise_proposal input: new fields or new custom text for a pending proposal (at most 5 versions). */
export type ReviseCall = {
  proposal_id: string;
  fields?: Record<string, string>;
  custom_subject?: string;
  custom_body?: string;
};

/** get_status result: the current status and version; the provider message id once accepted. */
export type StatusResult = {
  proposal_id: string;
  status: ProposalStatus;
  version: number;
  version_sha256: string;
  provider_message_id: string | null;
};

/** One list_jobs entry: what the agent may do, and how much of it is left. The spec's "title" is the job's purpose. */
export type JobListing = {
  job_id: string;
  purpose: string;
  recipient: string;
  template_fields: Record<string, FieldRule>;
  allow_custom_with_approval: boolean;
  sends_left: number;
  expires_at: string;
};

/** What dispatch_auto and approve end in: a provider result, or a refusal before any call. */
export type DispatchOutcome =
  | { kind: "provider"; outcome: MailOutcome; receipt_id: string }
  | { kind: "refused"; reason: DispatchRefusal; receipt_id: string };

// ---- Receipts --------------------------------------------------------------------------------

export const RECEIPT_TYPES = [
  "CONNECTION_CREATED",
  "AGENT_CONNECTED",
  "JOB_CONFIRMED",
  "ATTEMPT_DENIED",
  "PROPOSAL_CREATED",
  "PROPOSAL_REVISED",
  "AI_REVIEW",
  "APPROVAL_GRANTED",
  "APPROVAL_REJECTED",
  "APPROVAL_REFUSED",
  "DISPATCH_RESERVED",
  "DISPATCH_REFUSED",
  "PROVIDER_ACCEPTED",
  "NOT_SENT",
  "OUTCOME_UNKNOWN",
  "OUTCOME_RESOLVED",
  "DELIVERY_WITNESSED",
  "STOP_ENGAGED",
  "PROVIDER_REVOKE_REQUESTED",
  "PROVIDER_REVOKE_RESULT",
  // The owner disconnects an agent (migration 0004).
  "AGENT_REVOKED",
] as const;
export type ReceiptType = (typeof RECEIPT_TYPES)[number];

/** JSON a receipt may carry: no floats, so canonical bytes are stable. */
export type ReceiptValue = string | number | boolean | null | ReceiptValue[] | { [key: string]: ReceiptValue };

/** The signed fields (spec: "Receipts and Flight Recorder"). `client_label` is declared, not verified. */
export type ReceiptFields = {
  job?: string | null;
  policy_version?: number | null;
  agent_connection?: string | null;
  client_label?: string | null;
  proposal?: string | null;
  version?: number | null;
  version_sha256?: string | null;
  detail?: { [key: string]: ReceiptValue };
};

// ---- The frozen interfaces -------------------------------------------------------------------

/** A transaction handle; the executor lane defines it. Every state change writes its receipt in the same one. */
export interface Tx {
  readonly kind: "tx";
}

export interface JobSendCore {
  /** The gate: code checks in a fixed order, first failure wins; AI review last and can only add a hold. */
  gate(call: ProposeSendCall, conn: AgentConnection): Promise<SendResult>;
  /** Reserve and send one version that needs no review. */
  dispatch_auto(version_id: string): Promise<DispatchOutcome>;
  /** The owner approves exactly the version whose hash the screen showed. */
  approve(proposal_id: string, version: number, shown_sha256: string): Promise<DispatchOutcome>;
  /** Write one signed receipt inside `tx`; returns its id. */
  writeReceipt(tx: Tx, type: ReceiptType, fields: ReceiptFields): Promise<string>;
}
