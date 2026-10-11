import { useState } from "react";
import type { Job, Receipt } from "../domain/types";
import { useEngine, useEngineState } from "../engineContext";
import { Card, Chip, fmtTime, short, toneOfReceipt } from "./ui";

/** Jobs, each with its Flight Recorder: every decision for that job, newest first. */
export function Jobs({ newJob }: { newJob: () => void }) {
  const s = useEngineState();
  const account = s.receipts.filter((r) => r.jobId === null);
  return (
    <div className="grid">
      <div className="row">
        <p className="lede" style={{ margin: 0 }}>Each job's Flight Recorder shows the authority, every decision and every provider result. Gmail calls so far: <b>{s.providerCalls}</b>.</p>
        <span className="spacer" />
        <button className="btn primary" onClick={newJob}>New job</button>
      </div>
      {s.jobs.length === 0 && <Card sunk><p className="muted">No jobs yet. Create one in New job.</p></Card>}
      {[...s.jobs].reverse().map((j, i) => <JobCard key={j.id} job={j} open={i === 0} />)}
      <Card title="Account" right={<span className="faint">connections, STOP, refusals outside any job</span>}>
        <Timeline receipts={account} />
      </Card>
    </div>
  );
}

function JobCard({ job, open }: { job: Job; open: boolean }) {
  const s = useEngineState();
  const [show, setShow] = useState(open);
  const agent = s.agentConnections.find((a) => a.id === job.agentConnectionId);
  const expired = s.clock >= job.expiresAt;
  const receipts = s.receipts.filter((r) => r.jobId === job.id);
  return (
    <Card
      title={<>{job.title} {job.kind === "cleanup" && <span className="faint">· labs</span>}</>}
      right={expired ? <Chip tone="bad">expired</Chip> : !s.connection.dispatchEnabled ? <Chip tone="bad">stopped</Chip> : <Chip tone="ok">active</Chip>}
    >
      {job.kind === "send" ? (
        <div className="grid g4">
          <div className="stat"><b>{job.maxSends - job.sendsReserved} / {job.maxSends}</b><span>sends left</span></div>
          <div className="stat"><b style={{ fontSize: 14 }}>{job.recipient}</b><span>only recipient</span></div>
          <div className="stat"><b style={{ fontSize: 14 }}>{job.allowCustom ? "ask me" : "never"}</b><span>custom wording</span></div>
          <div className="stat"><b style={{ fontSize: 14 }}>{fmtTime(job.expiresAt)}</b><span>expires · {agent?.label ?? "?"} ({agent?.kind})</span></div>
        </div>
      ) : (
        <div className="grid g4">
          <div className="stat"><b>{job.maxPerBatch}</b><span>max deletions per batch</span></div>
          <div className="stat"><b style={{ fontSize: 14 }}>{job.labels.join(", ")}</b><span>older than {job.minAgeDays} days</span></div>
          <div className="stat"><b style={{ fontSize: 14 }}>never</b><span>starred, contacts</span></div>
          <div className="stat"><b style={{ fontSize: 14 }}>{fmtTime(job.expiresAt)}</b><span>expires</span></div>
        </div>
      )}
      <hr />
      <button className="btn small ghost" onClick={() => setShow(!show)}>{show ? "▾" : "▸"} Flight Recorder · {receipts.length} receipt(s)</button>
      {show && <Timeline receipts={receipts} />}
    </Card>
  );
}

function Timeline({ receipts }: { receipts: Receipt[] }) {
  const s = useEngineState();
  const engine = useEngine();
  const [open, setOpen] = useState<number | null>(null);
  if (receipts.length === 0) return <p className="faint">Nothing yet.</p>;
  return (
    <div className="timeline" style={{ marginTop: 8 }}>
      {[...receipts].reverse().map((r) => {
        const p = r.proposalId ? s.proposals.find((x) => x.id === r.proposalId) : undefined;
        const witnessed = p?.kind === "send" && p.deliveryWitnessed;
        return (
          <div key={r.seq} className={`tl-item ${toneOfReceipt(r.type)}`}>
            <div className="row">
              <span className="faint">#{r.seq}</span>
              <Chip tone={toneOfReceipt(r.type)}>{r.type}</Chip>
              {r.reason && <code>{r.reason}</code>}
              {r.detail.injected === true && <Chip tone="unk">controlled test</Chip>}
              {r.type === "PROPOSAL_DENIED" && <span className="faint">Gmail not called</span>}
              {r.type === "PROVIDER_ACCEPTED" && p?.kind === "send" && (witnessed ? <Chip tone="ok">delivery witnessed</Chip> : (
                <button className="btn small ghost" onClick={() => void engine.witnessDelivery(p.id)}>delivery not witnessed · I see it in the inbox</button>
              ))}
              {r.type === "OUTCOME_RESOLVED" && <span className="muted">owner: {String(r.detail.observation)}{r.detail.slotKept ? " · slot kept" : ""}</span>}
              {typeof r.detail.deleted === "number" && <span className="muted">deleted {r.detail.deleted}</span>}
              {typeof r.detail.requested === "number" && <span className="muted">requested {r.detail.requested} / max {String(r.detail.maxPerBatch)}</span>}
              <span className="spacer" />
              <span className="faint">{fmtTime(Date.parse(r.ts))}</span>
              <button className="btn small ghost" onClick={() => setOpen(open === r.seq ? null : r.seq)}>{open === r.seq ? "hide" : "json"}</button>
            </div>
            <div className="hash">prev {short(r.prevHash, 10)} → {short(r.hash, 10)}{r.versionHash ? ` · version ${short(r.versionHash, 10)}` : ""}</div>
            {open === r.seq && <pre className="mono-box" style={{ marginTop: 6 }}>{JSON.stringify(r, null, 2)}</pre>}
          </div>
        );
      })}
    </div>
  );
}
