import { useState } from "react";
import { ageDays, CLEANUP_JOB_ID, DAY, HOUR } from "../domain/data";
import { Engine } from "../domain/engine";
import { runScenario, SCENARIOS, type ScenarioRun } from "../domain/scenarios";
import type { AgentResult, CleanupJob, Email, ProviderFault } from "../domain/types";
import { useEngine, useEngineState } from "../engineContext";
import { Card, Chip, fmtTime, ResultView } from "./ui";

const FAULTS: [ProviderFault, string][] = [
  ["ok", "normal"],
  ["partial", "partial: 3 fail"],
  ["timeout", "timeout → unknown"],
  ["http503", "503 → unknown"],
  ["http429", "429 → not sent"],
];

export function TestLab({ toast }: { toast: (m: string) => void }) {
  const s = useEngineState();
  const engine = useEngine();
  const [runs, setRuns] = useState<Record<string, ScenarioRun>>({});
  const [running, setRunning] = useState(false);
  const order = ["Send · job-bound email", "Connections & jobs", "Receipts", "Labs · inbox cleanup, max 10 per batch"];
  const groups = [...new Set(SCENARIOS.map((x) => x.group))].sort((x, y) => order.indexOf(x) - order.indexOf(y));
  const done = Object.values(runs);

  const runAll = async () => {
    setRunning(true);
    const next: Record<string, ScenarioRun> = {};
    for (const sc of SCENARIOS) next[sc.id] = await runScenario(sc, new Engine({ latencyMs: 0, signer: engine.signer, seed: "sample" }));
    setRuns(next);
    setRunning(false);
  };
  const replay = async (id: string) => {
    const sc = SCENARIOS.find((x) => x.id === id);
    if (!sc) return;
    await engine.reset("sample");
    await runScenario(sc, engine);
    toast(`Replayed “${sc.title}” in the demo. See Waiting for you and Jobs.`);
  };

  return (
    <div className="grid">
      <Card title="Simulation">
        <div className="row">
          <span className="muted">clock {fmtTime(s.clock)}</span>
          <button className="btn small" onClick={() => engine.advanceClock(HOUR)}>+1h</button>
          <button className="btn small" onClick={() => engine.advanceClock(DAY)}>+1d</button>
          <label className="row muted">next Gmail call
            <select className="btn small" value={s.nextFault} onChange={(e) => engine.setNextFault(e.target.value as ProviderFault)}>
              {FAULTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          {s.nextFault !== "ok" && <Chip tone="unk">next call is a controlled test</Chip>}
          <span className="spacer" />
          <button className="btn small" onClick={async () => { await engine.reset("fresh"); toast("Fresh: Gmail connected, no agent, no jobs, like the live host before setup."); }}>Start fresh</button>
          <button className="btn small" onClick={async () => { await engine.reset("sample"); toast("Sample setup: ChatGPT connected over OAuth, the Dana job and the cleanup lab."); }}>Load sample setup</button>
        </div>
      </Card>

      <Card title="Edge cases and failure modes" right={<span className="row">{done.length > 0 && <span className={done.every((r) => r.pass) ? "pass" : "fail"}>{done.filter((r) => r.pass).length}/{done.length} pass</span>}<button className="btn primary" onClick={runAll} disabled={running}>{running ? "Running…" : `Run all ${SCENARIOS.length}`}</button></span>}>
        <p className="muted">Each case runs on its own fresh copy. Replay runs it in the demo so you can inspect what it leaves behind.</p>
        {groups.map((g) => (
          <details key={g} open={g !== "Labs · inbox cleanup, max 10 per batch"}>
            <summary style={{ margin: "10px 0 4px" }}><b>{g}</b></summary>
            <table>
              <tbody>
                {SCENARIOS.filter((x) => x.group === g).map((sc) => {
                  const r = runs[sc.id];
                  return (
                    <tr key={sc.id}>
                      <td style={{ width: 56 }}>{r ? (r.pass ? <span className="pass">PASS</span> : <span className="fail">FAIL</span>) : <span className="faint">—</span>}</td>
                      <td>
                        {sc.title}
                        {r && !r.pass && <div className="fail" style={{ fontSize: 12 }}>{r.error ?? r.checks.filter((c) => !c.ok).map((c) => `${c.label} (got ${c.got})`).join("; ")}</div>}
                      </td>
                      <td className="muted">{sc.expect}</td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}><button className="btn small" onClick={() => replay(sc.id)}>Replay</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </details>
        ))}
      </Card>

      <CleanupLab />
    </div>
  );
}

/** Labs: the owner's rule "never delete more than 10 emails at a time". Outside the MVP; local only. */
function CleanupLab() {
  const s = useEngineState();
  const engine = useEngine();
  const [picked, setPicked] = useState<string[]>([]);
  const [result, setResult] = useState<AgentResult | null>(null);
  const job = s.jobs.find((j) => j.id === CLEANUP_JOB_ID) as CleanupJob | undefined;
  if (!job) return <Card title="Labs · inbox cleanup (max 10 per batch)"><p className="muted">Load the sample setup to try it.</p></Card>;

  const rule = (e: Email): { tone: "ok" | "bad" | "hold"; text: string } => {
    if (e.starred) return { tone: "bad", text: "never · starred" };
    if (e.contactId) return { tone: "bad", text: "never · contact" };
    if (!job.labels.includes(e.label)) return { tone: "hold", text: `ask · ${e.label}` };
    if (ageDays(e, s.clock) < job.minAgeDays) return { tone: "hold", text: "ask · recent" };
    return { tone: "ok", text: "in scope" };
  };
  const toggle = (id: string) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const over = picked.length > job.maxPerBatch;

  return (
    <Card
      title={<>Labs · inbox cleanup <span className="faint">(local only, not in the MVP)</span></>}
      right={
        <span className="row">
          <span className={over ? "fail" : "muted"}>{picked.length} selected{over ? ` · over ${job.maxPerBatch}` : ""}</span>
          <button className="btn primary" disabled={picked.length === 0} onClick={async () => { setResult(await engine.proposeDelete({ jobId: job.id, messageIds: picked })); setPicked([]); }}>Ask agent to delete</button>
        </span>
      }
    >
      <p className="muted">Rule: at most {job.maxPerBatch} per batch, one batch at a time; only {job.labels.join(", ")} older than {job.minAgeDays} days; never starred or contact mail.</p>
      {result && <ResultView result={result} compact />}
      <div className="scroll" style={{ marginTop: 10 }}>
        <table>
          <thead><tr><th /><th>from</th><th>subject</th><th>label</th><th>age</th><th>rule</th><th>state</th></tr></thead>
          <tbody>
            {s.emails.map((e) => {
              const r = rule(e);
              return (
                <tr key={e.id} className={`${e.state === "trash" ? "dim" : ""}${picked.includes(e.id) ? " sel" : ""}`} onClick={() => e.state === "inbox" && toggle(e.id)} style={{ cursor: e.state === "inbox" ? "pointer" : "default" }}>
                  <td><input type="checkbox" checked={picked.includes(e.id)} disabled={e.state !== "inbox"} onChange={() => toggle(e.id)} onClick={(ev) => ev.stopPropagation()} /></td>
                  <td>{e.starred ? "★ " : ""}{e.fromName}</td>
                  <td>{e.subject}</td>
                  <td>{e.label}</td>
                  <td>{ageDays(e, s.clock)}d</td>
                  <td><Chip tone={r.tone}>{r.text}</Chip></td>
                  <td><Chip tone={e.state === "inbox" ? "plain" : e.state === "trash" ? "info" : "unk"}>{e.state}</Chip></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
