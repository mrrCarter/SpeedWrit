import { isAskMeReason } from "@writ/job-send/contract";
import { SAY } from "../lib/copy";
import { wordDiff, type DiffSegment } from "../lib/wordDiff";

/** One pending, reviewable version. Hard denials never become one (spec: "The job is the authority"). */
export interface PendingVersion {
  proposalId: string;
  version: number;
  versionSha256: string;
  /** Why it is held: `custom_content`, `mentions_other_client`, `ai_review:*`, `ai_review_unavailable`. */
  reasons: readonly string[];
  /** The AI-review flags shown with it; AI review can only add a hold, never lift one. */
  aiFlags: readonly string[];
  subject: string;
  body: string;
  /** What it is compared with: the template rendering for version 1, version N-1 otherwise. */
  baseline: { label: string; subject: string; body: string };
}

export interface ExceptionCardProps {
  pending: PendingVersion;
  /** Posts the version and the hash this card RENDERED, so a stale card is refused (409 superseded). */
  onApprove: (proposalId: string, version: number, shownSha256: string) => void;
  /** Rejects exactly the version this card rendered (owner API: the hash it showed). */
  onReject: (proposalId: string, version: number, shownSha256: string) => void;
}

function Diff({ segments }: { segments: DiffSegment[] }) {
  return (
    <span>
      {segments.map((segment, index) =>
        segment.kind === "added" ? (
          <ins key={index}>{segment.text}</ins>
        ) : segment.kind === "removed" ? (
          <del key={index}>{segment.text}</del>
        ) : (
          <span key={index}>{segment.text}</span>
        )
      )}
    </span>
  );
}

/**
 * One card on the Exceptions screen: its reasons, its AI-review flags, a word-level diff against its baseline, and
 * the version hash. Approve applies to exactly this version.
 */
export function ExceptionCard({ pending, onApprove, onReject }: ExceptionCardProps) {
  const { proposalId, version, versionSha256, baseline } = pending;
  // Fails closed, like the server's reasonClass: Approve only when every reason is an allow-listed ask-me reason.
  // An empty list is approvable (a template send in a job without auto-send); any other code is not.
  const approvable = pending.reasons.every((reason) => isAskMeReason(reason));
  return (
    <article aria-label={`Version ${version} of ${proposalId}`}>
      <h3>
        Version {version} <code title={versionSha256}>{versionSha256.slice(0, 16)}</code>
      </h3>
      <ul aria-label="Why it is held">
        {pending.reasons.map((reason) => (
          <li key={reason}>
            <code>{reason}</code>
          </li>
        ))}
      </ul>
      {pending.aiFlags.length > 0 ? (
        <p>
          {SAY.aiReviewed}: {pending.aiFlags.join(", ")}
        </p>
      ) : null}
      <p>Compared with {baseline.label}</p>
      <p>
        Subject: <Diff segments={wordDiff(baseline.subject, pending.subject)} />
      </p>
      <p style={{ whiteSpace: "pre-wrap" }}>
        <Diff segments={wordDiff(baseline.body, pending.body)} />
      </p>
      {approvable ? (
        <button type="button" onClick={() => onApprove(proposalId, version, versionSha256)}>
          Approve version {version}
        </button>
      ) : (
        <p role="alert">{SAY.prohibited}</p>
      )}
      <button type="button" onClick={() => onReject(proposalId, version, versionSha256)}>
        Reject
      </button>
    </article>
  );
}
