// Domain types for the local SpeedWrit demo. Everything here is synthetic: no network, no real mailbox.

export type EmailLabel = "Primary" | "Promotions" | "Newsletters" | "Updates" | "Receipts";

export interface Contact {
  id: string;
  name: string;
  company: string;
  email: string;
}

export interface Email {
  id: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  snippet: string;
  label: EmailLabel;
  receivedAt: number;
  starred: boolean;
  /** Set when the sender is one of the owner's contacts. Contact mail is never deletable by a job. */
  contactId: string | null;
  /** "unknown" while a delete batch that included it has an unconfirmed provider outcome. */
  state: "inbox" | "trash" | "unknown";
}

/** How an agent reaches /mcp: OAuth (the primary path) or the secret-URL fallback. Never call a fallback OAuth. */
export interface AgentConnection {
  id: string;
  label: string;
  kind: "oauth" | "fallback";
  createdAt: number;
  lastUsedAt: number | null;
  revoked: boolean;
}

interface JobBase {
  id: string;
  title: string;
  purpose: string;
  expiresAt: number;
  /** The agent connection this job is bound to. Any other connection gets job_not_found. */
  agentConnectionId: string;
  /** Bumped by every owner edit. An approval binds the policy version it was shown under. */
  policyVersion: number;
}

export interface SendJob extends JobBase {
  kind: "send";
  recipient: string;
  templateId: string;
  maxSends: number;
  sendsReserved: number;
  /** "ask me before custom wording": custom text is held for approval. Off: it is refused. */
  allowCustom: boolean;
}

export interface CleanupJob extends JobBase {
  kind: "cleanup";
  /** The owner's rule: never more than this many deletions in one batch. */
  maxPerBatch: number;
  labels: EmailLabel[];
  minAgeDays: number;
}

export type Job = SendJob | CleanupJob;

/** The fault the simulated provider injects into its NEXT call (then it goes back to "ok"). */
export type ProviderFault = "ok" | "partial" | "timeout" | "http503" | "http429";

export type VersionState = "pending" | "superseded" | "approved" | "dispatched" | "denied";

export interface DeleteVersion {
  n: number;
  hash: string;
  policyVersion: number;
  messageIds: string[];
  reviewReasons: string[];
  state: VersionState;
}

export interface SendVersion {
  n: number;
  hash: string;
  policyVersion: number;
  to: string;
  subject: string;
  body: string;
  custom: boolean;
  reviewReasons: string[];
  state: VersionState;
}

export type ProposalStatus =
  | "pending_approval"
  | "dispatching"
  | "done"
  | "partial"
  | "not_done"
  | "sent"
  | "not_sent"
  | "unknown"
  | "denied_by_owner";

interface ProposalBase {
  id: string;
  jobId: string;
  createdAt: number;
  status: ProposalStatus;
  currentVersion: number;
  /** The provider fault picker caused this outcome: a controlled test, labeled everywhere. */
  controlledTest: boolean;
  /** The owner's answer to an UNKNOWN. Recorded, never a resend. */
  ownerObservation: "arrived" | "not_arrived" | null;
}

export interface DeleteProposal extends ProposalBase {
  kind: "delete";
  versions: DeleteVersion[];
  failedIds: string[];
}

export interface SendProposal extends ProposalBase {
  kind: "send";
  versions: SendVersion[];
  providerMessageId: string | null;
  /** The owner saw it in the recipient's inbox. Separate from provider acceptance. */
  deliveryWitnessed: boolean;
}

export type Proposal = DeleteProposal | SendProposal;

export interface Dispatch {
  id: string;
  proposalId: string;
  version: number;
  jobId: string;
  kind: "delete" | "send";
  status: "reserved" | "done" | "partial" | "not_done" | "unknown" | "resolved";
}

export type ReceiptType =
  | "GMAIL_CONNECTED"
  | "AGENT_CONNECTED"
  | "AGENT_REVOKED"
  | "JOB_CONFIRMED"
  | "JOB_EDITED"
  | "PROPOSAL_DENIED"
  | "PROPOSAL_HELD"
  | "VERSION_SUPERSEDED"
  | "APPROVED"
  | "APPROVAL_REFUSED"
  | "DENIED_BY_OWNER"
  | "DISPATCH_RESERVED"
  | "PROVIDER_ACCEPTED"
  | "DELIVERY_WITNESSED"
  | "PARTIAL"
  | "NOT_DONE"
  | "OUTCOME_UNKNOWN"
  | "OUTCOME_RESOLVED"
  | "STOP_ENGAGED"
  | "TOKEN_REVOKED"
  | "STOP_RELEASED";

export type DetailValue = string | number | boolean | null | string[];

export interface ReceiptBody {
  seq: number;
  ts: string;
  type: ReceiptType;
  jobId: string | null;
  proposalId: string | null;
  versionHash: string | null;
  reason: string | null;
  detail: Record<string, DetailValue>;
  prevHash: string;
  keyId: string;
}

export interface Receipt extends ReceiptBody {
  hash: string;
  sig: string;
}

/** What the agent gets back from a tool call: one plain sentence plus the same facts as fields. */
export interface AgentResult {
  status: "done" | "partial" | "not_done" | "sent" | "not_sent" | "denied" | "pending_approval" | "unknown" | "jobs";
  message: string;
  reasonCode?: string;
  approvable?: boolean;
  proposalId?: string;
  version?: number;
  versionHash?: string;
  reviewReasons?: string[];
  receiptSeq?: number;
  deleted?: number;
  failed?: number;
  sendsLeft?: number;
  controlledTest?: boolean;
  /** Provider calls before and after this tool call: equal means the provider was never called. */
  providerCalls?: { before: number; after: number };
  jobs?: { id: string; title: string; recipient: string; sendsLeft: number; expiresAt: string; custom: string }[];
}

export interface OwnerResult {
  ok: boolean;
  code?: string;
  message: string;
  agentResult?: AgentResult;
}

export interface AgentLogEntry {
  n: number;
  at: number;
  connectionId: string;
  tool: "list_jobs" | "propose_delete" | "propose_send" | "revise_proposal";
  prompt: string;
  input: string;
  result: AgentResult;
}

export interface State {
  rev: number;
  clock: number;
  connection: { account: string; scopes: string[]; dispatchEnabled: boolean; status: "active" | "stopped" };
  agentConnections: AgentConnection[];
  contacts: Contact[];
  emails: Email[];
  jobs: Job[];
  proposals: Proposal[];
  dispatches: Dispatch[];
  receipts: Receipt[];
  nextFault: ProviderFault;
  providerCalls: number;
  operations: Record<string, AgentResult>;
  agentLog: AgentLogEntry[];
}
