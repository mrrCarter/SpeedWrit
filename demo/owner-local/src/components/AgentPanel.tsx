import { useEffect, useRef, useState } from "react";
import type { SendJob } from "../domain/types";
import { useEngine, useEngineState } from "../engineContext";
import { ResultView } from "./ui";

const RECAP = { topic: "onboarding call", recap: "we agreed to start the pilot Monday, and I'll send the checklist by Friday." };
const NOTE = "Hi Dana,\n\nDoes Thursday at 2pm work for a kickoff?\n\nBest,\nAman";

/** A simulated ChatGPT: the demo's prompts as chips, each one real tool call into the local gate. */
export function AgentPanel({ close }: { close: () => void }) {
  const s = useEngineState();
  const engine = useEngine();
  const [busy, setBusy] = useState(false);
  const agents = s.agentConnections.filter((a) => !a.revoked);
  const [agentId, setAgentId] = useState("");
  const agent = agents.find((a) => a.id === agentId) ?? agents[0];
  const jobs = s.jobs.filter((j): j is SendJob => j.kind === "send" && j.agentConnectionId === agent?.id);
  const [jobId, setJobId] = useState("");
  const job = jobs.find((j) => j.id === jobId) ?? jobs[0];
  const pending = s.proposals.find((p) => p.kind === "send" && p.jobId === job?.id && p.status === "pending_approval");
  const log = s.agentLog.filter((e) => e.connectionId === agent?.id).slice(0, 30).reverse();
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "end" }), [log.length]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };
  const send = (prompt: string, to: string, fields: Record<string, string> = RECAP) =>
    job && run(() => engine.proposeSend({ connectionId: agent?.id, jobId: job.id, to, fields, prompt }));

  const MORE: Record<string, () => void> = {
    "Two addresses in to": () => send("Send it to Dana and Bo in one email.", "dana@acme.test, bo@birch.test"),
    "Display name in to": () => send("Send it to Dana <dana@acme.test>.", "Dana <dana@acme.test>"),
    "A link in a field": () => send("Add the login link to the recap.", "dana@acme.test", { ...RECAP, recap: "details at https://example.test/login" }),
    "An extra cc field": () => send("Cc Bo on the recap.", "dana@acme.test", { ...RECAP, cc: "bo@birch.test" }),
    "A field over its limit": () => send("Use a very long topic.", "dana@acme.test", { ...RECAP, topic: "x".repeat(90) }),
  };

  return (
    <aside className="agent">
      <div className="row" style={{ marginBottom: 8 }}>
        <b>ChatGPT</b><span className="faint">simulated</span>
        <span className="spacer" />
        <button className="btn small ghost" onClick={close}>close</button>
      </div>
      {!agent ? (
        <p className="muted">No agent connected. Connect ChatGPT in Connections first.</p>
      ) : (
        <>
          <div className="row muted" style={{ fontSize: 12, marginBottom: 8 }}>
            {agents.length > 1 ? (
              <select className="btn small" value={agent.id} onChange={(e) => setAgentId(e.target.value)}>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.label} · {a.kind}</option>)}
              </select>
            ) : (
              <span>{agent.label} · {agent.kind === "oauth" ? "OAuth" : "fallback"}</span>
            )}
            {jobs.length > 1 && (
              <select className="btn small" value={job?.id} onChange={(e) => setJobId(e.target.value)}>
                {jobs.map((j) => <option key={j.id} value={j.id}>{j.title} ({j.maxSends - j.sendsReserved}/{j.maxSends})</option>)}
              </select>
            )}
          </div>
          <div className="chips">
            <button className="btn small" disabled={busy} onClick={() => run(() => engine.listJobs(agent.id, "What jobs can you do for me right now?"))}>What jobs can you do?</button>
            <button className="btn small" disabled={busy || !job} onClick={() => send("Do the Tuesday recap for Dana. Topic: onboarding call.", "dana@acme.test")}>Recap to Dana</button>
            <button className="btn small" disabled={busy || !job} onClick={() => send("Send the same recap to Bo at Birch too.", "bo@birch.test")}>Same recap to Bo</button>
            <button className="btn small" disabled={busy || !job} onClick={() => job && run(() => engine.proposeSend({ connectionId: agent.id, jobId: job.id, to: "dana@acme.test", custom: { subject: "Kickoff?", body: NOTE }, prompt: "Dana needs a short custom note asking if Thursday at 2pm works for a kickoff." }))}>Custom note: Thu 2pm</button>
            <button className="btn small" disabled={busy || !pending} onClick={() => pending && run(() => engine.reviseSend(pending.id, { connectionId: agent.id, custom: { subject: "Kickoff?", body: NOTE.replace("Thursday at 2pm", "Friday at 10am") }, prompt: "Make it Friday at 10am instead." }))}>Make it Fri 10am</button>
            <button className="btn small" disabled={busy || !job} onClick={() => send("Send Dana one more reminder.", "dana@acme.test")}>One more reminder</button>
            <select className="btn small" value="" disabled={busy || !job} onChange={(e) => MORE[e.target.value]?.()}>
              <option value="">More tests…</option>
              {Object.keys(MORE).map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
          <div className="transcript">
            {log.length === 0 && <p className="faint">Pick a prompt above.</p>}
            {log.map((e) => (
              <div key={e.n} className="turn">
                {e.prompt && <div className="bubble">{e.prompt}</div>}
                <div className="faint" style={{ fontSize: 11.5 }}>called <code>{e.tool}</code> {e.input !== "{}" ? e.input : ""}</div>
                <ResultView result={e.result} />
              </div>
            ))}
            <div ref={end} />
          </div>
        </>
      )}
    </aside>
  );
}
