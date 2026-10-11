import { useEffect, useState } from "react";
import { alertsEnabled, setAlertsEnabled } from "../alertSwitch";
import { Card, Chip } from "./ui";

interface RelayStatus {
  mode: "live" | "dry_run";
  problems: string[];
  to: string;
  windowSeconds: number;
  pending: number;
  lastCall: { at: string; ok: boolean; mode: string; callId?: string; events: number; said?: string; error?: string } | null;
}

/** Dial phone alerts: status of the local relay, the rule, one test button and an on/off switch. */
export function AlertsCard() {
  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [down, setDown] = useState(false);
  const [on, setOn] = useState(alertsEnabled());

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch("/dial/status");
        if (!r.ok) throw new Error(String(r.status));
        const s = (await r.json()) as RelayStatus;
        if (alive) {
          setStatus(s);
          setDown(false);
        }
      } catch {
        if (alive) setDown(true);
      }
    };
    void poll();
    const t = setInterval(poll, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <Card
      title="Phone alerts · Dial"
      right={down ? <Chip tone="bad">relay not running</Chip> : status?.mode === "live" ? <Chip tone="ok">live · calls {status.to}</Chip> : <Chip tone="hold">dry run</Chip>}
    >
      <p className="muted">
        A voice call for anything <b>ambiguous</b> (held for approval, unknown outcome), <b>outside the policy</b> (any refusal) or <b>out of the ordinary</b> (STOP,
        partial or failed provider result, a revoked agent). At most one call per {status?.windowSeconds ?? 60} s, with a summary. The call can't approve anything.
      </p>
      {down && <p className="fail">Start it with <code>npm run dial</code> in speedwrit-local.</p>}
      {status?.mode === "dry_run" && <p className="muted">Dry run: {status.problems.join(", ")}. Add them to <code>.env.local</code> and restart the relay.</p>}
      {status?.lastCall && (
        <div className={`result ${status.lastCall.ok ? "ok" : "bad"}`}>
          <div className="row">
            <Chip tone={status.lastCall.ok ? "ok" : "bad"}>{status.lastCall.ok ? (status.lastCall.mode === "live" ? "call placed" : "would call") : `failed · ${status.lastCall.error}`}</Chip>
            <span className="faint">{new Date(status.lastCall.at).toLocaleTimeString("en-US", { timeZone: "America/Los_Angeles" })} PT · {status.lastCall.events} event(s)</span>
          </div>
          {status.lastCall.said && <p className="msg">“{status.lastCall.said}”</p>}
        </div>
      )}
      <hr />
      <div className="row">
        <label className="row"><input type="checkbox" checked={on} onChange={(e) => { setAlertsEnabled(e.target.checked); setOn(e.target.checked); }} /> alerts on</label>
        <span className="muted">{status?.pending ? `${status.pending} event(s) waiting for the next call` : ""}</span>
        <span className="spacer" />
        <button className="btn" disabled={down} onClick={() => void fetch("/dial/test", { method: "POST" })}>Send test call</button>
      </div>
    </Card>
  );
}
