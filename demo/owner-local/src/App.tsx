import { useEffect, useState } from "react";
import { useEngineState } from "./engineContext";
import { AgentPanel } from "./components/AgentPanel";
import { Connections } from "./components/Connections";
import { DemoGuide, WhatJustHappened } from "./components/Explainers";
import { Jobs } from "./components/Jobs";
import { Logo } from "./components/Logo";
import { NewJob } from "./components/NewJob";
import { TestLab } from "./components/TestLab";
import { Verify } from "./components/Verify";
import { Waiting } from "./components/Waiting";

// The real owner app's navigation, in its order, plus one Test lab tab for the local simulation.
const TABS = [
  ["connections", "Connections"],
  ["new", "New job"],
  ["waiting", "Waiting for you"],
  ["jobs", "Jobs"],
  ["verify", "Verify"],
  ["lab", "Test lab"],
] as const;
type TabId = (typeof TABS)[number][0];

export function App() {
  const s = useEngineState();
  const [tab, setTab] = useState<TabId>(() => (TABS.some(([id]) => id === location.hash.slice(1)) ? (location.hash.slice(1) as TabId) : "connections"));
  const [agentOpen, setAgentOpen] = useState(true);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => history.replaceState(null, "", `#${tab}`), [tab]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3600);
    return () => clearTimeout(t);
  }, [toast]);

  const waiting = s.proposals.filter((p) => p.status === "pending_approval" || (p.status === "unknown" && p.ownerObservation === null)).length;
  const stopped = !s.connection.dispatchEnabled;

  return (
    <>
      <header className="top">
        <div className="top-row">
          <a className="brand" href="#connections" aria-label="SpeedWrit home" onClick={() => setTab("connections")}>
            <Logo height={62} />
          </a>
          <nav className="tabs" role="tablist">
            {TABS.map(([id, label]) => (
              <button key={id} className={`tab${id === "lab" ? " lab" : ""}`} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>
                {label}
                {id === "waiting" && waiting > 0 && <span className="count">{waiting}</span>}
              </button>
            ))}
          </nav>
          <div className="controls">
            <button className={`btn small${agentOpen ? " primary" : ""}`} onClick={() => setAgentOpen(!agentOpen)}>ChatGPT</button>
          </div>
        </div>
        {stopped && <div className="banner-stop"><div><b>STOP is engaged.</b> Nothing new can be reserved, approved or sent. Reconnect in Connections.</div></div>}
      </header>
      <div className={`layout${agentOpen ? " with-agent" : ""}`}>
        <main>
          {tab !== "lab" && <DemoGuide go={(t) => setTab(t as TabId)} />}
          <WhatJustHappened />
          {tab === "connections" && <Connections />}
          {tab === "new" && <NewJob done={() => { setTab("jobs"); setToast("Job confirmed. Ask ChatGPT what jobs it can do."); }} />}
          {tab === "waiting" && <Waiting />}
          {tab === "jobs" && <Jobs newJob={() => setTab("new")} />}
          {tab === "verify" && <Verify />}
          {tab === "lab" && <TestLab toast={setToast} />}
        </main>
        {agentOpen && <AgentPanel close={() => setAgentOpen(false)} />}
      </div>
      {toast && <div className="toast">{toast}</div>}
    </>
  );
}
