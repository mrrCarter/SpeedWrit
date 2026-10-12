import { useState } from "react";
import { ageDays } from "../domain/data";
import type { CleanupJob, DeleteProposal, OwnerResult, SendJob, SendProposal, SendVersion } from "../domain/types";
import { useEngine, useEngineState } from "../engineContext";
import { Card, Chip, short } from "./ui";

function lineDiff(before: string, after: string) {
  const a = before.split("\n");
  const b = after.split("\n");
  const rows: { kind: "same" | "add" | "del"; text: string }[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i];
    const y = b[i];
    if (x === y && x !== undefined) rows.push({ kind: "same", text: x });
    else {
      if (x !== undefined) rows.push({ kind: "del", text: x });
      if (y !== undefined) rows.push({ kind: "add", text: y });
    }
  }
  return rows;
}

export function Waiting() {
  const s = useEngineState();
  const engine = useEngine();
  const [last, setLast] = useState<OwnerResult | null>(null);
  const held = s.proposals.filter((p) => p.status === "pending_approval");
  const unknown = s.proposals.filter((p) => p.status === "unknown" && p.ownerObservation === null);
  const act = async (fn: () => Promise<OwnerResult>) => setLast(await fn());

  return (
    <div className="grid">
      {last && (
        <div className={`result ${last.ok ? "ok" : "bad"}`}>
          <div className="row"><Chip tone={last.ok ? "ok" : "bad"}>{last.ok ? "ok" : last.code ?? "refused"}</Chip>{last.agentResult?.controlledTest && <Chip tone="unk">controlled test</Chip>}</div>
          <p className="msg">{last.message}</p>
        </div>
      )}
      {held.length === 0 && unknown.length === 0 && <Card sunk><p className="muted">Nothing is waiting for you. Inside a job, the agent just works.</p></Card>}

      {unknown.map((p) => (
        <Card key={p.id} title={<>Did it arrive? · <span className="faint">{p.id}</span></>} right={<span className="row">{p.controlledTest && <Chip tone="unk">controlled test</Chip>}<Chip tone="unk">outcome unknown</Chip></span>}>
          <p>
            The provider never confirmed {p.kind === "delete" ? "this batch" : "this send"}. SpeedWrit can't check on its own, so nothing retries.
            {p.kind === "send" ? " Either answer is recorded; the send slot stays used either way." : " No other batch runs until you answer."}
          </p>
          <div className="row">
            <button className="btn" onClick={() => act(() => engine.resolveUnknown(p.id, true))}>I see it arrived</button>
            <button className="btn" onClick={() => act(() => engine.resolveUnknown(p.id, false))}>It did not arrive</button>
          </div>
        </Card>
      ))}

      {held.map((p) => (p.kind === "send" ? <HeldSend key={p.id} p={p} onResult={setLast} /> : <HeldDelete key={p.id} p={p} onResult={setLast} />))}
    </div>
  );
}

function HeldSend({ p, onResult }: { p: SendProposal; onResult: (r: OwnerResult) => void }) {
  const s = useEngineState();
  const engine = useEngine();
  const v = p.versions[p.currentVersion - 1] as SendVersion;
  const prev = p.versions[p.currentVersion - 2];
  const stale = p.versions.find((x) => x.state === "superseded");
  const job = s.jobs.find((j) => j.id === p.jobId) as SendJob;
  return (
    <Card title={<>Email to {v.to} · v{v.n}</>} right={<Chip tone="hold">held · {v.reviewReasons.join(", ")}</Chip>}>
      <div className="rule"><span className="k">job</span><span>{job.title} · {job.maxSends - job.sendsReserved} of {job.maxSends} sends left</span></div>
      <div className="rule"><span className="k">subject</span><span>{v.subject}</span></div>
      <h3 style={{ marginTop: 10 }}>{prev ? `Changes from v${prev.n}` : "Exact message"}</h3>
      <div className="diff">
        {(prev ? lineDiff(prev.body, v.body) : v.body.split("\n").map((t) => ({ kind: "same" as const, text: t }))).map((r, i) => (
          <div key={i} className={r.kind}>{r.kind === "add" ? "+ " : r.kind === "del" ? "- " : "  "}{r.text || " "}</div>
        ))}
      </div>
      <p className="hash" style={{ marginTop: 10 }}>Approving binds version v{v.n} · {short(v.hash, 32)}</p>
      <div className="row">
        {stale && <button className="btn small ghost" onClick={async () => onResult(await engine.approve(p.id, stale.hash))}>Try the old v{stale.n} (should fail)</button>}
        <span className="spacer" />
        <button className="btn danger" onClick={async () => onResult(await engine.denyProposal(p.id))}>Deny</button>
        <button className="btn primary" onClick={async () => onResult(await engine.approve(p.id, v.hash))}>Approve v{v.n} and send</button>
      </div>
    </Card>
  );
}

function HeldDelete({ p, onResult }: { p: DeleteProposal; onResult: (r: OwnerResult) => void }) {
  const s = useEngineState();
  const engine = useEngine();
  const v = p.versions[p.currentVersion - 1];
  const job = s.jobs.find((j) => j.id === p.jobId) as CleanupJob;
  if (!v) return null;
  return (
    <Card title={<>Delete {v.messageIds.length} email(s)? <span className="faint">· labs</span></>} right={<Chip tone="hold">held · outside the job's rule</Chip>}>
      <table>
        <thead><tr><th>from</th><th>subject</th><th>why held</th></tr></thead>
        <tbody>
          {v.messageIds.map((id) => {
            const e = s.emails.find((m) => m.id === id);
            if (!e) return null;
            const age = ageDays(e, s.clock);
            return <tr key={id} className={e.state !== "inbox" ? "dim" : ""}><td>{e.fromName}</td><td>{e.subject}</td><td>{!job.labels.includes(e.label) ? `label ${e.label}` : `only ${age}d old`}{e.state !== "inbox" ? ` · now ${e.state}` : ""}</td></tr>;
          })}
        </tbody>
      </table>
      <p className="hash" style={{ marginTop: 10 }}>Approving binds this exact batch · {short(v.hash, 32)}</p>
      <div className="row">
        <span className="spacer" />
        <button className="btn danger" onClick={async () => onResult(await engine.denyProposal(p.id))}>Deny</button>
        <button className="btn primary" onClick={async () => onResult(await engine.approve(p.id, v.hash))}>Approve this batch</button>
      </div>
    </Card>
  );
}
