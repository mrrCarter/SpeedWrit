// The owner API client (warden's OWNER-API.md): JSON over same-origin fetch. Writes are POST with
// content-type application/json; the browser adds Origin, and the server checks it. Every answer is
// JSON; an error is { error: "<code>" } from a closed list, and 401 means "sign in".
import type { Job, ReceiptType } from "@writ/job-send/contract";
import { receiptEnvelopeText } from "@writ/job-send/verify";
import type { JobDraft } from "../screens/ConfirmJob";
import type { ConnectProps } from "../screens/Connect";
import type { PendingVersion } from "../screens/ExceptionCard";
import type { CompleteDraft } from "../screens/FrontDoor";
import type { TimelineReceipt } from "../lib/timeline";
import { parseIntegrationMetadata, parseAlertPreference, parseAlertTest } from "../lib/integrations";

export type Owner = { id: string; email: string };

/** GET /owner/connect: what Connect shows, plus the ids STOP and a new job bind to (null while not linked). */
export type ConnectState = {
  gmail: ConnectProps["gmail"];
  agentConnection: ConnectProps["agentConnection"];
  stopped: boolean;
  connectionId: string | null;
  agentConnectionId: string | null;
};

/** POST /owner/jobs (machine's createJobDraft): the job as the spec's JSON, which sha256(JCS(job)) covers, and that hash. */
export type CreatedJob = { job: Job; authoritySha256: string };

/** The new secret URL is returned once; callers keep it only in component memory. */
export type CreatedAgentConnection = { url: string; agent_connection_id: string; receipt_id: string };

/** POST /owner/jobs body (OWNER_BODY_SCHEMAS["/owner/jobs"]): flat snake_case, unknown keys refused. */
export type JobDraftBody = {
  connection_id: string;
  agent_connection_id: string;
  recipient: string;
  purpose: string;
  template_id: string;
  max_sends: number;
  expires_at: string;
  auto_send: boolean;
  allow_custom_with_approval: boolean;
  ai_review: "off" | "custom_only" | "all_free_text";
};

/** The front door's draft as the job body, bound to the owner's own connections. */
export function jobDraftBody(
  draft: CompleteDraft,
  ids: { connectionId: string; agentConnectionId: string },
  defaults: { templateId: string; purpose: string; autoSend: boolean },
): JobDraftBody {
  return {
    connection_id: ids.connectionId,
    agent_connection_id: ids.agentConnectionId,
    recipient: draft.recipient,
    purpose: defaults.purpose,
    template_id: defaults.templateId,
    max_sends: draft.maxSends,
    expires_at: draft.expiresAt,
    auto_send: defaults.autoSend,
    allow_custom_with_approval: draft.allowCustomWithApproval ?? false,
    ai_review: draft.aiReview ?? "custom_only",
  };
}

/** The confirm screen's view of the job, read from exactly the object the authority hash covers. */
export function jobDraftFromAuthority(job: Job): JobDraft {
  return {
    jobId: job.job_id,
    policyVersion: job.policy_version,
    recipient: job.recipient,
    purpose: job.purpose,
    template: { id: job.template.id },
    fieldRules: job.field_rules,
    maxSends: job.max_sends,
    expiresAt: job.expires_at,
    autoSend: job.auto_send,
    allowCustomWithApproval: job.allow_custom_with_approval,
    aiReview: job.ai_review,
  };
}
export type JobSummary = { jobId: string; purpose: string; recipient: string; status: string; expiresAt: string; sendsLeft: number };

/** GET /owner/jobs items exactly as the owner core returns them (listJobs, #526). */
export type ApiJobItem = { job: Job; authoritySha256: string; status: string; sendsReserved: number; sendsLeft: number };

/** The jobs list's view of one job, read from its authority object. */
export function jobFromApi(item: ApiJobItem): JobSummary {
  return {
    jobId: item.job.job_id,
    purpose: item.job.purpose,
    recipient: item.job.recipient,
    status: item.status,
    expiresAt: item.job.expires_at,
    sendsLeft: item.sendsLeft,
  };
}
/** A receipt as the Flight Recorder lists it, with its signed text for /verify. */
export type ListedReceipt = TimelineReceipt & { text: string };

/** GET /owner/pending items exactly as the owner core returns them (listPendingVersions, #526). */
export type ApiPendingVersion = {
  proposalId: string;
  jobId: string;
  version: number;
  sha256: string;
  reviewReasons: string[];
  recipient: string;
  subject: string;
  body: string;
  createdAt: string;
  /** Version N-1 for a revision; null for version 1. */
  baseline: { subject: string; body: string } | null;
};

/** The exception card's view of a pending version. */
export function pendingFromApi(item: ApiPendingVersion): PendingVersion {
  return {
    proposalId: item.proposalId,
    version: item.version,
    versionSha256: item.sha256,
    reasons: item.reviewReasons,
    aiFlags: item.reviewReasons.filter((reason) => reason.startsWith("ai_review:")).map((reason) => reason.slice("ai_review:".length)),
    subject: item.subject,
    body: item.body,
    baseline: item.baseline
      ? { label: `version ${item.version - 1}`, subject: item.baseline.subject, body: item.baseline.body }
      : { label: "nothing earlier (the first version)", subject: "", body: "" },
  };
}

/** GET /owner/receipts items exactly as stored (receipts/store.ts StoredReceipt): the signed payload is JCS text. */
export type ApiStoredReceipt = { id: string; seq: number; type: ReceiptType; payload: string; signature: string; key_id: string };

/**
 * A stored receipt as the Flight Recorder reads it: the timeline fields from its signed payload, and `text`, the
 * canonical envelope (receiptEnvelopeText) that /verify checks. A payload that does not parse gives empty fields.
 */
export function receiptFromApi(stored: ApiStoredReceipt): ListedReceipt {
  let payload: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(stored.payload);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch {
    payload = {};
  }
  const detail = payload.detail;
  let text = "";
  try {
    text = receiptEnvelopeText({ payload: stored.payload, signature: stored.signature, key_id: stored.key_id });
  } catch {
    text = "";
  }
  return {
    id: stored.id,
    seq: stored.seq,
    type: stored.type,
    ts: typeof payload.ts === "string" ? payload.ts : "",
    proposal: typeof payload.proposal === "string" ? payload.proposal : null,
    version: typeof payload.version === "number" ? payload.version : null,
    detail: detail !== null && typeof detail === "object" && !Array.isArray(detail) ? (detail as Record<string, unknown>) : {},
    text,
  };
}
/** What an approval ended in (approvalAnswer): codes the screen says in the Say table's words. */
export type ApproveAnswer = { status: "accepted" | "not_sent" | "unknown" | "refused"; reason?: string; receipt_id: string };

export class OwnerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`owner api: ${status} ${code}`);
    this.name = "OwnerApiError";
  }
}

type FetchLike = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; credentials?: "same-origin" }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** The owner API. `fetchImpl` defaults to the page's fetch; tests pass a fake. */
export class OwnerApi {
  constructor(private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init)) {}

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? { accept: "application/json" } : { accept: "application/json", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    if (!res.ok) {
      const code = data !== null && typeof data === "object" && typeof (data as { error?: unknown }).error === "string" ? (data as { error: string }).error : "unknown_error";
      throw new OwnerApiError(res.status, res.status === 401 ? "sign_in" : code);
    }
    return data as T;
  }

  private confirmed<T>(value: unknown, parse: (input: unknown) => T): T {
    try { return parse(value); }
    catch { throw new OwnerApiError(200, "unconfirmed_response"); }
  }
  async integrations() {
    return this.confirmed(await this.call<unknown>("GET", "/owner/integrations"), parseIntegrationMetadata);
  }
  async setAlertsEnabled(enabled: boolean) {
    return this.confirmed(await this.call<unknown>("POST", "/owner/alerts/preferences", { enabled }), parseAlertPreference);
  }
  async testAlert() {
    return this.confirmed(await this.call<unknown>("POST", "/owner/alerts/test", {}), parseAlertTest);
  }

  me() {
    return this.call<{ owner: Owner }>("GET", "/owner/me");
  }
  async connectState(): Promise<ConnectState> {
    const answer = await this.call<ConnectState>("GET", "/owner/connect");
    const gmail = answer?.gmail;
    const agent = answer?.agentConnection;
    const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
    // Missing status is not evidence that a connection is absent. Keep the last confirmed view.
    if (!answer || typeof answer !== "object" || Array.isArray(answer) || typeof answer.stopped !== "boolean" ||
        !(answer.connectionId === null || text(answer.connectionId)) ||
        !(answer.agentConnectionId === null || text(answer.agentConnectionId)) ||
        !(gmail === null || (gmail && text(gmail.address) && Array.isArray(gmail.grantedScopes) &&
          gmail.grantedScopes.every(scope => typeof scope === "string") &&
          (gmail.status === undefined || ["active", "stopped", "needs_reconnect"].includes(gmail.status)))) ||
        !(agent === null || (agent && text(agent.mcpUrl) && typeof agent.label === "string" &&
          (agent.lastUsedAt === null || text(agent.lastUsedAt)))) ||
        (gmail === null) !== (answer.connectionId === null) ||
        (agent === null) !== (answer.agentConnectionId === null)) {
      throw new OwnerApiError(200, "unconfirmed_response");
    }
    return answer;
  }
  stop(connectionId: string) {
    return this.call<{ stopped: true; receipt_ids: string[] }>("POST", "/owner/stop", { connection_id: connectionId });
  }
  async createAgentConnection(clientLabel: string): Promise<CreatedAgentConnection> {
    const answer = await this.call<CreatedAgentConnection>("POST", "/owner/agent-connections/secret-path-new", { client_label: clientLabel });
    if (!answer || typeof answer.url !== "string" || !answer.url.trim() ||
        typeof answer.agent_connection_id !== "string" || !answer.agent_connection_id.trim() ||
        typeof answer.receipt_id !== "string" || !answer.receipt_id.trim()) {
      throw new OwnerApiError(200, "unconfirmed_response");
    }
    return answer;
  }
  async revokeAgentConnection(agentConnectionId: string): Promise<{ revoked: true; receipt_id: string }> {
    const answer = await this.call<{ revoked: true; receipt_id: string }>("POST", "/owner/agent-connections/revoke", { agent_connection_id: agentConnectionId });
    if (!answer || answer.revoked !== true || typeof answer.receipt_id !== "string" || !answer.receipt_id.trim()) {
      throw new OwnerApiError(200, "unconfirmed_response");
    }
    return answer;
  }
  createJob(body: JobDraftBody) {
    return this.call<CreatedJob>("POST", "/owner/jobs", body);
  }
  confirmJob(jobId: string, authoritySha256: string) {
    return this.call<{ policyVersion: number; receipt_id: string }>("POST", "/owner/jobs/confirm", { job_id: jobId, authority_sha256: authoritySha256 });
  }
  async jobs(): Promise<{ jobs: JobSummary[] }> {
    const answer = await this.call<{ jobs: ApiJobItem[] }>("GET", "/owner/jobs");
    return { jobs: answer.jobs.map(jobFromApi) };
  }
  async pending(): Promise<{ pending: PendingVersion[] }> {
    const answer = await this.call<{ pending: ApiPendingVersion[] }>("GET", "/owner/pending");
    return { pending: answer.pending.map(pendingFromApi) };
  }
  approve(proposalId: string, version: number, shownSha256: string) {
    return this.call<ApproveAnswer>("POST", "/owner/versions/approve", { proposal_id: proposalId, version, shown_sha256: shownSha256 });
  }
  reject(proposalId: string, version: number, shownSha256: string) {
    return this.call<{ receipt_id: string }>("POST", "/owner/versions/reject", { proposal_id: proposalId, version, shown_sha256: shownSha256 });
  }
  resolve(dispatchId: string, outcome: "seen" | "not_arrived") {
    return this.call<{ receipt_id: string }>("POST", "/owner/dispatches/resolve", { dispatch_id: dispatchId, outcome });
  }
  async receipts(jobId: string): Promise<{ receipts: ListedReceipt[] }> {
    const answer = await this.call<{ receipts: ApiStoredReceipt[] }>("GET", `/owner/receipts?job_id=${encodeURIComponent(jobId)}`);
    return { receipts: answer.receipts.map(receiptFromApi) };
  }
}

/** Where a request that needs a session sends the browser: sign-in, then back to this page. */
export function signInHref(currentPath: string): string {
  return `/auth/sign-in?return_to=${encodeURIComponent(currentPath.startsWith("/") && !currentPath.startsWith("//") ? currentPath : "/")}`;
}
