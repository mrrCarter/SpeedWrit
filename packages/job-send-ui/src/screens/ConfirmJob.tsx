import { SAY } from "../lib/copy";
import { formatExpiry } from "../lib/time";

/** The parts of a job the confirm screen shows (spec: "The job is the authority"). */
export interface JobDraft {
  jobId: string;
  policyVersion: number;
  recipient: string;
  purpose: string;
  template: { id: string };
  fieldRules: Readonly<Record<string, { max: number; required?: boolean; free_text?: boolean }>>;
  maxSends: number;
  expiresAt: string;
  autoSend: boolean;
  allowCustomWithApproval: boolean;
  aiReview: "off" | "custom_only" | "all_free_text";
}

export interface ConfirmJobProps {
  job: JobDraft;
  /** sha256(JCS(job)), computed by the server; the screen shows its first characters and confirms exactly it. */
  authoritySha256: string;
  timeZone?: string;
  onConfirm: (jobId: string, authoritySha256: string) => void;
}

/** The three lists, in the order and wording the server enforces (Never / Ask me / Runs without asking). */
export function jobLists(job: JobDraft, timeZone?: string): { never: string[]; askMe: string[]; runs: string[] } {
  const expiry = formatExpiry(job.expiresAt, timeZone);
  const never = [
    `Anyone other than ${job.recipient}`,
    `More than ${job.maxSends} ${job.maxSends === 1 ? "send" : "sends"}`,
    `Anything after ${expiry.local} (${expiry.utc})`,
    "Cc, Bcc, attachments, HTML, or links written with :// or www.",
    "Fields outside their rules",
    "Sending while stopped",
  ];
  const askMe = ["A message that names another client"];
  if (job.allowCustomWithApproval) askMe.unshift("Wording outside the template");
  else never.push("Wording outside the template");
  if (job.aiReview !== "off") askMe.push(`An AI-review flag, or AI review being unavailable (${SAY.aiReviewed})`);
  const runs: string[] = [];
  if (job.autoSend) runs.push(`The approved template (${job.template.id}) with fields inside their rules, to ${job.recipient}`);
  else askMe.unshift(`Every template send to ${job.recipient}`);
  return { never, askMe, runs };
}

/**
 * Confirm job (spec: "Screens and UI copy"). The owner sees exactly what the agent may do, the recipient, the send
 * count, the expiry in local time and UTC, and the first characters of the authority hash it confirms.
 */
export function ConfirmJob({ job, authoritySha256, timeZone, onConfirm }: ConfirmJobProps) {
  const { never, askMe, runs } = jobLists(job, timeZone);
  const expiry = formatExpiry(job.expiresAt, timeZone);
  return (
    <section aria-label={`Confirm job ${job.jobId}`}>
      <h2>Confirm this job</h2>
      <p>{job.purpose}</p>
      <dl>
        <dt>Recipient</dt>
        <dd>{job.recipient}</dd>
        <dt>Sends</dt>
        <dd>{job.maxSends}</dd>
        <dt>Expires</dt>
        <dd>
          {expiry.local} ({expiry.utc})
        </dd>
        <dt>Authority</dt>
        <dd>
          <code title={authoritySha256}>{authoritySha256.slice(0, 12)}</code> · policy version {job.policyVersion}
        </dd>
      </dl>
      <h3>Never</h3>
      <ul aria-label="Never">{never.map((item) => <li key={item}>{item}</li>)}</ul>
      <h3>Ask me</h3>
      <ul aria-label="Ask me">{askMe.map((item) => <li key={item}>{item}</li>)}</ul>
      <h3>Runs without asking</h3>
      <ul aria-label="Runs without asking">
        {runs.length > 0 ? runs.map((item) => <li key={item}>{item}</li>) : <li>Nothing runs without asking</li>}
      </ul>
      <button type="button" onClick={() => onConfirm(job.jobId, authoritySha256)}>
        Confirm job
      </button>
    </section>
  );
}
