// Plain-English explanations of what SpeedWrit just did, for people watching the screen.
// Each receipt gets an icon, a short title and one sentence; the technical code stays visible but small.

import type { DetailValue, Receipt, State } from "./domain/types";
import type { Tone } from "./components/ui";

export interface Explained {
  icon: string;
  tone: Tone;
  title: string;
  detail: string;
}

const REASONS: Record<string, string> = {
  recipient_not_in_job: "that address isn't this job's recipient, so it can't be approved",
  recipient_invalid: "the recipient must be exactly one plain address",
  field_invalid: "a field broke the template's rules (a link, too long, or missing)",
  field_not_allowed: "the agent added a field the template doesn't have, like Cc",
  custom_not_allowed: "this job only sends its template; custom wording isn't allowed",
  limit_reached: "the job's sends are used up",
  job_expired: "the job has expired",
  job_not_found: "this agent isn't allowed to use that job",
  dispatch_stopped: "STOP is on",
  superseded: "the agent changed the message, so that older version can't be approved",
  policy_changed: "the job was edited after this was shown",
  already_deleted: "some of those emails are no longer in the inbox",
  batch_in_flight: "another batch is still running or waiting for your check",
  batch_limit_exceeded: "more than 10 deletions in one batch",
  protected_message: "starred mail and mail from contacts are never deleted",
  duplicate_ids: "the same email was listed twice",
  batch_empty: "the batch was empty",
  message_not_found: "an email in the batch doesn't exist",
  http_429: "Gmail asked us to slow down",
  stopped_before_call: "STOP was pressed before Gmail was called",
  provider_partial: "Gmail finished only part of the batch",
};

export function reasonText(code: string | null | undefined): string {
  if (!code) return "";
  return REASONS[code] ?? code.replace(/_/g, " ");
}

const str = (v: DetailValue | undefined) => (v === undefined || v === null ? "" : Array.isArray(v) ? v.join(", ") : String(v));

export function explain(r: Receipt, s: State): Explained {
  const job = r.jobId ? s.jobs.find((j) => j.id === r.jobId) : undefined;
  const isSend = job?.kind === "send";
  const reason = reasonText(r.reason);
  switch (r.type) {
    case "GMAIL_CONNECTED":
      return { icon: "✉", tone: "info", title: "Gmail connected", detail: `SpeedWrit can send from ${str(r.detail.account)}. It never reads the inbox.` };
    case "AGENT_CONNECTED":
      return { icon: "🔗", tone: "info", title: "Agent connected", detail: `${str(r.detail.label)} can now ask SpeedWrit to work, but only inside jobs you confirm.` };
    case "AGENT_REVOKED":
      return { icon: "⛓", tone: "bad", title: "Agent disconnected", detail: `${str(r.detail.label)} can't call SpeedWrit anymore.` };
    case "JOB_CONFIRMED":
      return job?.kind === "send"
        ? { icon: "✔", tone: "info", title: "You confirmed a job", detail: `${job.title}: only ${job.recipient}, at most ${job.maxSends} sends, ${job.allowCustom ? "custom wording asks you first" : "template only"}.` }
        : { icon: "✔", tone: "info", title: "You confirmed a job", detail: job ? `${job.title}.` : "" };
    case "JOB_EDITED":
      return { icon: "✎", tone: "info", title: "You edited the job", detail: "Anything shown before the edit can no longer be approved." };
    case "PROPOSAL_DENIED": {
      const who = r.detail.attempted ? `The agent tried to email ${str(r.detail.attempted)}, but ` : "The agent asked for something outside the job: ";
      return { icon: "⛔", tone: "bad", title: "Refused before Gmail", detail: `${who}${reason}. Gmail was not called.` };
    }
    case "PROPOSAL_HELD":
      return {
        icon: "⏸",
        tone: "hold",
        title: "Held for your approval",
        detail: r.reason === "outside_scope" ? "This batch goes beyond the job's rules, so it waits for you." : r.reason === "revised" ? "The agent revised the message; you approve the new version." : "The agent wrote its own wording, so nothing is sent until you approve this exact version.",
      };
    case "VERSION_SUPERSEDED":
      return { icon: "↻", tone: "hold", title: "Old version replaced", detail: "The agent changed the message. The earlier version can't be approved anymore." };
    case "APPROVED":
      return { icon: "👍", tone: "ok", title: "You approved this exact version", detail: "Your approval is tied to this version's fingerprint (hash)." };
    case "APPROVAL_REFUSED":
      return { icon: "✋", tone: "bad", title: "Approval refused", detail: `${reason.charAt(0).toUpperCase()}${reason.slice(1)}. Nothing was sent.` };
    case "DENIED_BY_OWNER":
      return { icon: "✕", tone: "bad", title: "You said no", detail: "Nothing was sent." };
    case "DISPATCH_RESERVED":
      return { icon: "⏳", tone: "info", title: isSend ? "Send slot reserved" : "Batch reserved", detail: isSend ? "One of the job's sends is set aside, then Gmail is called exactly once." : "The batch is locked in, then Gmail is called once." };
    case "PROVIDER_ACCEPTED":
      return isSend
        ? { icon: "📤", tone: "ok", title: "Gmail accepted the email", detail: `Sent to ${str(r.detail.to)}. Check the inbox to confirm it arrived.` }
        : { icon: "🗑", tone: "ok", title: "Moved to Trash", detail: `${str(r.detail.deleted)} email(s) moved to Trash.` };
    case "DELIVERY_WITNESSED":
      return { icon: "👀", tone: "ok", title: "You saw it in the inbox", detail: "Delivery witnessed, separately from Gmail's acceptance." };
    case "PARTIAL":
      return { icon: "◐", tone: "hold", title: "Partly done", detail: `${str(r.detail.deleted)} done, ${str(r.detail.failed)} not. Nothing was retried.` };
    case "NOT_DONE":
      return { icon: "✕", tone: "bad", title: isSend ? "Not sent" : "Not done", detail: `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.${r.detail.released ? " The send slot was given back." : ""}` };
    case "OUTCOME_UNKNOWN":
      return { icon: "?", tone: "unk", title: "Gmail didn't confirm", detail: "SpeedWrit can't tell if it went out, so it won't retry. The send slot stays used, even if you later say it didn't arrive." };
    case "OUTCOME_RESOLVED":
      return { icon: "✓", tone: "unk", title: `You answered: ${r.detail.observation === "arrived" ? "it arrived" : "it did not arrive"}`, detail: r.detail.slotKept ? "Recorded. The slot stays used, and nothing resends." : "Recorded." };
    case "STOP_ENGAGED":
      return { icon: "■", tone: "bad", title: "STOP pressed", detail: "Nothing new can be reserved, approved or sent." };
    case "TOKEN_REVOKED":
      return { icon: "🔒", tone: "bad", title: "Gmail access revoked", detail: "The sending permission is withdrawn." };
    case "STOP_RELEASED":
      return { icon: "▶", tone: "info", title: "Reconnected", detail: "Sending inside jobs works again." };
  }
}

// ── The demo guide: the MVP story, ticked off from what actually happened ──

export interface Step {
  id: string;
  label: string;
  hint: string;
  tab: string;
  done: boolean;
}

// The run in which a receipt was verified. Start fresh, Load sample and Replay start a new engine generation,
// so an earlier run's check never carries into a fresh one.
let verifiedGeneration: number | null = null;
const listeners = new Set<() => void>();
export const verifyStore = {
  mark(generation: number): void {
    if (verifiedGeneration === generation) return;
    verifiedGeneration = generation;
    for (const l of listeners) l();
  },
  get: (): number | null => verifiedGeneration,
  doneFor: (generation: number): boolean => verifiedGeneration === generation,
  subscribe: (fn: () => void): (() => void) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export function demoSteps(s: State, verified: boolean): Step[] {
  const has = (f: (r: Receipt) => boolean) => s.receipts.some(f);
  const sendJob = (r: Receipt) => s.jobs.find((j) => j.id === r.jobId)?.kind === "send";
  return [
    { id: "agent", label: "Connect ChatGPT", hint: "Connections → Connect ChatGPT → Allow", tab: "connections", done: s.agentConnections.some((a) => !a.revoked) },
    { id: "job", label: "Confirm a job", hint: "New job → Use starter lines → Confirm job", tab: "new", done: s.jobs.some((j) => j.kind === "send") },
    { id: "sent", label: "Agent sends inside the job", hint: "ChatGPT panel → Recap to Dana", tab: "jobs", done: has((r) => r.type === "PROVIDER_ACCEPTED" && sendJob(r)) },
    { id: "refused", label: "Wrong client refused", hint: "ChatGPT panel → Same recap to Bo", tab: "jobs", done: has((r) => r.type === "PROPOSAL_DENIED" && r.reason === "recipient_not_in_job") },
    { id: "approved", label: "Held, then you approve", hint: "ChatGPT → Custom note, then Waiting for you → Approve", tab: "waiting", done: has((r) => r.type === "APPROVED" && sendJob(r)) },
    { id: "verify", label: "Check a receipt", hint: "Verify → Verify (then change one byte)", tab: "verify", done: verified },
    { id: "stop", label: "STOP", hint: "Connections → STOP sending", tab: "connections", done: has((r) => r.type === "STOP_ENGAGED") },
  ];
}
