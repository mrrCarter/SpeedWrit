import { useState } from "react";
import { SAY } from "../lib/copy";
import { buildTimeline, type TimelineReceipt } from "../lib/timeline";

export interface FlightRecorderProps {
  jobId: string;
  receipts: readonly TimelineReceipt[];
  /** The full signed receipt, opened from its row (the canonical text, shown as is). */
  receiptText: (receiptId: string) => string | undefined;
  /** The owner resolves an UNKNOWN send's dispatch: "I see it" (seen) or "It did not arrive" (not_arrived). */
  onResolve: (dispatchId: string, outcome: "seen" | "not_arrived") => void;
}

/**
 * One job's timeline (spec: "Screens and UI copy", Flight Recorder). Each row opens its receipt. A denial reads
 * "Prohibited by your job: not approvable" and has no control at all; an UNKNOWN row has the two resolve buttons;
 * "Witnessed" is its own badge beside "Provider accepted".
 */
export function FlightRecorder({ jobId, receipts, receiptText, onResolve }: FlightRecorderProps) {
  const [open, setOpen] = useState<string | null>(null);
  const rows = buildTimeline(receipts);
  return (
    <section aria-label={`Flight Recorder for ${jobId}`}>
      <h2>Flight Recorder</h2>
      <p>{SAY.evidenceReady}</p>
      <ol>
        {rows.map((row) => (
          <li key={row.receiptId} data-tone={row.tone}>
            <button type="button" aria-expanded={open === row.receiptId} onClick={() => setOpen(open === row.receiptId ? null : row.receiptId)}>
              <time dateTime={row.ts}>{row.ts}</time> {row.label}
              {row.reason ? <code> {row.reason}</code> : null}
            </button>
            {row.explanation ? <p className="muted">{row.explanation}</p> : null}
            {row.badges.map((badge) => (
              <span key={badge} role="status">
                {badge}
              </span>
            ))}
            {row.control === "resolve" && row.dispatchId ? (
              <span>
                <button type="button" onClick={() => onResolve(row.dispatchId!, "seen")}>
                  {SAY.resolveSeen}
                </button>
                <button type="button" onClick={() => onResolve(row.dispatchId!, "not_arrived")}>
                  {SAY.resolveNotArrived}
                </button>
              </span>
            ) : null}
            {open === row.receiptId ? <pre aria-label={`Receipt ${row.receiptId}`}>{receiptText(row.receiptId) ?? "Receipt not loaded"}</pre> : null}
          </li>
        ))}
      </ol>
    </section>
  );
}
