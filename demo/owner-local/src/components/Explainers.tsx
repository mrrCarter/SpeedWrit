import { useState, useSyncExternalStore } from "react";
import { demoSteps, explain, verifyStore } from "../explain";
import { useEngine, useEngineState } from "../engineContext";
import { fmtTime } from "./ui";

/** The MVP story as a row of steps that tick off from what actually happened, with the next one highlighted. */
export function DemoGuide({ go }: { go: (tab: string) => void }) {
  const s = useEngineState();
  const engine = useEngine();
  useSyncExternalStore(verifyStore.subscribe, verifyStore.get);
  const verified = verifyStore.doneFor(engine.generation);
  const [hidden, setHidden] = useState(false);
  const steps = demoSteps(s, verified);
  const next = steps.find((x) => !x.done);
  const doneCount = steps.filter((x) => x.done).length;
  if (hidden) {
    return <button className="btn small ghost guide-show" onClick={() => setHidden(false)}>Show demo guide ({doneCount}/{steps.length})</button>;
  }
  return (
    <section className="guide" aria-label="Demo guide">
      <div className="guide-steps">
        {steps.map((st, i) => (
          <button key={st.id} className={`guide-step${st.done ? " done" : ""}${st === next ? " next" : ""}`} onClick={() => go(st.tab)} title={st.hint}>
            <span className="guide-num">{st.done ? "✓" : i + 1}</span>
            <span>{st.label}</span>
          </button>
        ))}
      </div>
      <div className="row guide-foot">
        {next ? (
          <>
            <span><b>Next:</b> {next.label} <span className="muted">· {next.hint}</span></span>
            <button className="btn small primary" onClick={() => go(next.tab)}>Go</button>
          </>
        ) : (
          <span className="pass">The whole story is done: inside the job it just works, outside it's refused, gray areas wait for you, and every step is signed.</span>
        )}
        <span className="spacer" />
        <button className="btn small ghost" onClick={() => setHidden(true)}>hide</button>
      </div>
    </section>
  );
}

/** The latest decision, in plain English, on every page. */
export function WhatJustHappened() {
  const s = useEngineState();
  const last = s.receipts[s.receipts.length - 1];
  if (!last || s.receipts.length <= 1) return null;
  const e = explain(last, s);
  return (
    <section className={`happened ${e.tone}`} aria-live="polite">
      <span className="happened-icon" aria-hidden="true">{e.icon}</span>
      <div>
        <div className="faint" style={{ fontSize: 11.5 }}>What just happened · {fmtTime(Date.parse(last.ts))}</div>
        <div><b>{e.title}.</b> {e.detail}</div>
      </div>
    </section>
  );
}
