import type { ReceiptType } from "@writ/job-send/contract";
import { SAY } from "./copy";

/** The receipt types the executor writes: the contract's 20 (spec: "Receipts and Flight Recorder"). */
export type { ReceiptType };

/** The fields of a receipt the timeline reads. The full signed receipt opens from its row. */
export interface TimelineReceipt {
  id: string;
  seq: number;
  type: ReceiptType;
  ts: string;
  proposal?: string | null;
  version?: number | null;
  detail?: Record<string, unknown>;
}

/** One Flight Recorder row. `control` says what the owner can do from it; a denial never carries one. */
export interface TimelineRow {
  receiptId: string;
  seq: number;
  ts: string;
  label: string;
  tone: "ok" | "denied" | "held" | "unknown" | "info";
  control: "none" | "resolve";
  /** The dispatch an UNKNOWN row resolves (the signed receipt's detail.dispatch); the resolve control needs it. */
  dispatchId?: string;
  reason?: string;
  /** Historical context for this receipt, not a claim about the proposal's current state. */
  explanation?: string;
  badges: string[];
}

const PLAIN_LABELS: Partial<Record<ReceiptType, string>> = {
  CONNECTION_CREATED: "Gmail connected",
  AGENT_CONNECTED: "Agent connected",
  JOB_CONFIRMED: "Job confirmed",
  APPROVAL_REJECTED: "Rejected by you",
  APPROVAL_REFUSED: "Approval not used",
  DISPATCH_RESERVED: "Send reserved",
  DISPATCH_REFUSED: "Send refused",
  STOP_ENGAGED: "Sending stopped",
  PROVIDER_REVOKE_REQUESTED: "Gmail access revoke requested",
  PROVIDER_REVOKE_RESULT: "Gmail access revoke result",
};

const sameSend = (a: TimelineReceipt, b: TimelineReceipt) =>
  a.proposal != null && a.proposal === b.proposal && a.version === b.version;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function reviewExplanation(outcome: unknown): string | undefined {
  switch (outcome) {
    case "clear":
      return "AI review added no flags. Other job rules still apply.";
    case "hold":
      return "AI review flagged this version, so it required owner review. Check Waiting for you for versions still awaiting review.";
    case "unavailable":
      return "AI review was unavailable, so this version required owner review. Check Waiting for you for versions still awaiting review.";
    default:
      return undefined;
  }
}

function refusalExplanation(reason: string | undefined): string | undefined {
  switch (reason) {
    case "superseded":
      return "This version was no longer current or available for that attempt. Check Waiting for you for versions still awaiting review.";
    case "not_pending":
      return "This version was no longer awaiting approval. Check this Flight Recorder for earlier decisions and send outcomes.";
    case "dispatch_stopped":
      return "Gmail was not enabled for sending at that attempt. Check Connections for its current status.";
    default:
      return undefined;
  }
}

/**
 * The Flight Recorder rows for one job, in receipt order (the per-owner `seq`). The spec's rules:
 * - a denial reads "Prohibited by your job: not approvable", with its reason code and no control;
 * - an UNKNOWN outcome offers the two resolve buttons until the owner resolves that send;
 * - "Witnessed" is its own badge on the send's row, never folded into "Provider accepted".
 */
export function buildTimeline(receipts: readonly TimelineReceipt[]): TimelineRow[] {
  const ordered = [...receipts].sort((a, b) => a.seq - b.seq);
  const rows: TimelineRow[] = [];
  const rowFor = new Map<string, TimelineRow>(); // the send's row, for its badges

  for (const receipt of ordered) {
    const base = { receiptId: receipt.id, seq: receipt.seq, ts: receipt.ts, badges: [] as string[] };
    const reason = text(receipt.detail?.reason_code) ?? text(receipt.detail?.reason) ?? text(receipt.detail?.error_class);
    switch (receipt.type) {
      case "AI_REVIEW":
        rows.push({ ...base, label: SAY.aiReview, tone: "info", control: "none", reason, explanation: reviewExplanation(receipt.detail?.outcome) });
        break;
      case "ATTEMPT_DENIED":
        rows.push({ ...base, label: SAY.prohibited, tone: "denied", control: "none", reason });
        break;
      case "APPROVAL_REFUSED":
      case "DISPATCH_REFUSED":
        rows.push({ ...base, label: PLAIN_LABELS[receipt.type]!, tone: "info", control: "none", reason, explanation: refusalExplanation(reason) });
        break;
      case "PROPOSAL_CREATED":
      case "PROPOSAL_REVISED":
        rows.push({
          ...base,
          label: `${receipt.type === "PROPOSAL_CREATED" ? "Proposal" : "Revised to"} version ${receipt.version ?? "?"}`,
          tone: "held",
          control: "none",
        });
        break;
      case "APPROVAL_GRANTED":
        rows.push({ ...base, label: `You approved version ${receipt.version ?? "?"}`, tone: "ok", control: "none" });
        break;
      case "PROVIDER_ACCEPTED": {
        const row: TimelineRow = { ...base, label: SAY.providerAccepted, tone: "ok", control: "none" };
        rows.push(row);
        if (receipt.proposal != null) rowFor.set(`${receipt.proposal}#${receipt.version}`, row);
        break;
      }
      case "NOT_SENT":
        rows.push({ ...base, label: SAY.notSent, tone: "denied", control: "none", reason });
        break;
      case "OUTCOME_UNKNOWN": {
        const resolved = ordered.some((later) => later.type === "OUTCOME_RESOLVED" && later.seq > receipt.seq && sameSend(later, receipt));
        // Resolving names the dispatch (owner API: POST /owner/dispatches/resolve), so a row without its id offers no control.
        const dispatchId = text(receipt.detail?.dispatch);
        const row: TimelineRow = {
          ...base,
          label: SAY.outcomeUnknown,
          tone: "unknown",
          control: resolved || !dispatchId ? "none" : "resolve",
          ...(dispatchId ? { dispatchId } : {}),
          reason,
        };
        rows.push(row);
        if (receipt.proposal != null) rowFor.set(`${receipt.proposal}#${receipt.version}`, row);
        break;
      }
      case "OUTCOME_RESOLVED": {
        // As the executor signs it: resolution "sent" when the owner saw it arrive, "not_arrived" when they
        // have not (older receipts say "not_sent"). Not arriving is an observation: the send still counts.
        const seen = receipt.detail?.resolution === "sent";
        rows.push({ ...base, label: seen ? "You saw it arrive" : SAY.resolvedNotArrived, tone: "info", control: "none" });
        break;
      }
      case "DELIVERY_WITNESSED": {
        const row = receipt.proposal != null ? rowFor.get(`${receipt.proposal}#${receipt.version}`) : undefined;
        if (row) row.badges.push(SAY.witnessed);
        else rows.push({ ...base, label: SAY.witnessed, tone: "info", control: "none" });
        break;
      }
      default:
        rows.push({ ...base, label: PLAIN_LABELS[receipt.type] ?? receipt.type, tone: "info", control: "none", reason });
    }
  }
  return rows;
}
