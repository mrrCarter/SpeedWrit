import type { ReactNode } from "react";
import type { AgentResult, ReceiptType } from "../domain/types";

export type Tone = "ok" | "bad" | "hold" | "unk" | "info" | "plain";

export function toneOfStatus(status: string): Tone {
  if (status === "done" || status === "sent") return "ok";
  if (status === "denied" || status === "not_done" || status === "not_sent" || status === "denied_by_owner") return "bad";
  if (status === "pending_approval" || status === "partial") return "hold";
  if (status === "jobs") return "info";
  if (status === "unknown") return "unk";
  if (status === "dispatching") return "info";
  return "plain";
}

export function toneOfReceipt(type: ReceiptType): Tone {
  switch (type) {
    case "PROVIDER_ACCEPTED":
    case "DELIVERY_WITNESSED":
    case "APPROVED":
      return "ok";
    case "PROPOSAL_DENIED":
    case "APPROVAL_REFUSED":
    case "DENIED_BY_OWNER":
    case "NOT_DONE":
    case "STOP_ENGAGED":
    case "TOKEN_REVOKED":
    case "AGENT_REVOKED":
      return "bad";
    case "PROPOSAL_HELD":
    case "PARTIAL":
    case "VERSION_SUPERSEDED":
      return "hold";
    case "OUTCOME_UNKNOWN":
    case "OUTCOME_RESOLVED":
      return "unk";
    default:
      return "info";
  }
}

export function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span className={`chip ${tone}`}>
      <span className="dot" />
      {children}
    </span>
  );
}

export function Card({ title, right, children, sunk }: { title?: ReactNode; right?: ReactNode; children: ReactNode; sunk?: boolean }) {
  return (
    <section className={`card${sunk ? " sunk" : ""}`}>
      {(title || right) && (
        <div className="card-head">
          {title ? <h2>{title}</h2> : <span />}
          {right}
        </div>
      )}
      {children}
    </section>
  );
}

/** The agent-facing result, the way an MCP client receives it: one sentence plus structured facts. */
export function ResultView({ result, compact }: { result: AgentResult; compact?: boolean }) {
  const tone = toneOfStatus(result.status);
  const { message, ...facts } = result;
  const isError = result.status === "denied";
  return (
    <div className={`result ${tone}`}>
      <div className="row">
        <Chip tone={tone}>{result.status}</Chip>
        {result.reasonCode && <code className="muted">{result.reasonCode}</code>}
        {result.approvable === false && <span className="faint">· cannot be approved</span>}
        {result.controlledTest && <Chip tone="unk">controlled test</Chip>}
        {result.providerCalls && result.status !== "jobs" && (
          <span className="faint">· {result.providerCalls.after === result.providerCalls.before ? "Gmail not called" : `Gmail called ${result.providerCalls.after - result.providerCalls.before}×`}</span>
        )}
      </div>
      <p className="msg">{message}</p>
      {!compact && (
        <details>
          <summary>MCP result</summary>
          <pre className="mono-box">{JSON.stringify({ isError, content: [{ type: "text", text: message }], structuredContent: facts }, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString("en-US", { timeZone: "America/Los_Angeles", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) + " PT";
}

export function short(hash: string | null | undefined, n = 10): string {
  return hash ? hash.slice(0, n) : "—";
}
