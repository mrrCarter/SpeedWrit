import { useState } from "react";
import { useEngine, useEngineState } from "../engineContext";
import { AlertsCard } from "./AlertsCard";
import { Card, Chip, fmtTime } from "./ui";

const HOST = "https://speedwrit.local";

export function Connections() {
  const s = useEngineState();
  const engine = useEngine();
  const [label, setLabel] = useState("ChatGPT-SpeedWrit");
  const [secretUrl, setSecretUrl] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const stopped = !s.connection.dispatchEnabled;
  const agents = s.agentConnections;

  return (
    <div className="grid">
      {note && <div className="result ok"><p className="msg">{note}</p></div>}

      <Card title="Gmail" right={stopped ? <Chip tone="bad">stopped</Chip> : <Chip tone="ok">connected</Chip>}>
        <div className="rule"><span className="k">account</span><span>{s.connection.account}</span></div>
        <div className="rule"><span className="k">granted</span><span className="row">{s.connection.scopes.map((x) => <code key={x} className="chip plain">{x}</code>)}</span></div>
        <div className="rule"><span className="k">Gmail calls</span><span>{s.providerCalls} so far</span></div>
        <hr />
        <div className="row">
          <span className="muted">{stopped ? "Nothing new can be reserved, approved or sent." : "STOP blocks every new send instantly, then revokes the Gmail token."}</span>
          <span className="spacer" />
          {stopped ? (
            <button className="btn" onClick={async () => setNote((await engine.reconnect()).message)}>Reconnect</button>
          ) : (
            <button className="btn stop" onClick={async () => setNote((await engine.stop()).message)}>STOP sending</button>
          )}
        </div>
      </Card>

      <AlertsCard />

      <Card title="Agents">
        {agents.length === 0 && <p className="muted">No agent connected yet.</p>}
        <div className="rows">
          {agents.map((a) => (
            <div key={a.id} className="row" style={{ opacity: a.revoked ? 0.5 : 1 }}>
              <b>{a.label}</b>
              <span className="faint">(declared)</span>
              <Chip tone={a.kind === "oauth" ? "info" : "hold"}>{a.kind === "oauth" ? "OAuth" : "fallback · secret URL"}</Chip>
              <code className="faint">{a.kind === "oauth" ? `${HOST}/mcp` : `${HOST}/mcp/c/••••••`}</code>
              <span className="faint">last used {a.lastUsedAt ? fmtTime(a.lastUsedAt) : "never"}</span>
              <span className="spacer" />
              {a.revoked ? <Chip tone="bad">revoked</Chip> : <button className="btn small danger" onClick={async () => setNote((await engine.revokeAgent(a.id)).message)}>Revoke</button>}
            </div>
          ))}
        </div>
      </Card>

      <Card title="Connect an agent">
        <div className="grid g2">
          <div>
            <h3>ChatGPT · OAuth <span className="faint">(primary)</span></h3>
            <p className="muted">ChatGPT adds SpeedWrit as a custom MCP server at <code>{HOST}/mcp</code> with OAuth, then you allow it here.</p>
            {consent ? (
              <div className="card sunk">
                <h3>Connect an agent to SpeedWrit</h3>
                <div className="rule"><span className="k">agent</span><span>ChatGPT (declared)</span></div>
                <div className="rule"><span className="k">owner</span><span>{s.connection.account}</span></div>
                <div className="rule"><span className="k">returns to</span><span>chatgpt.com</span></div>
                <div className="rule"><span className="k">may</span><span>jobs.act: only jobs you confirm</span></div>
                <div className="row" style={{ marginTop: 10 }}>
                  <button className="btn" onClick={() => setConsent(false)}>Deny</button>
                  <button
                    className="btn primary"
                    onClick={async () => {
                      const r = await engine.connectAgent("ChatGPT-SpeedWrit", "oauth");
                      setConsent(false);
                      setNote(r.message);
                    }}
                  >
                    Allow
                  </button>
                </div>
              </div>
            ) : (
              <button className="btn primary" onClick={() => setConsent(true)}>Connect ChatGPT</button>
            )}
          </div>
          <div>
            <h3>Fallback · secret connection URL</h3>
            <p className="muted">Anyone with a secret connection URL can use that agent connection. Sending still requires a job you approve.</p>
            {secretUrl ? (
              <div className="card sunk">
                <p className="muted">This URL is shown only here. Enter it in your agent before hiding it or leaving this page.</p>
                <input className="mono-box" style={{ width: "100%" }} readOnly value={secretUrl} onFocus={(e) => e.currentTarget.select()} />
                <div className="row" style={{ marginTop: 8 }}>
                  <span className="spacer" />
                  <button className="btn" onClick={() => setSecretUrl(null)}>Hide URL</button>
                </div>
              </div>
            ) : (
              <div className="row">
                <input className="btn" style={{ flex: 1, minWidth: 180 }} value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Agent label" />
                <button
                  className="btn"
                  onClick={async () => {
                    const r = await engine.connectAgent(label, "fallback");
                    setSecretUrl(r.secretUrl ?? null);
                    setNote(r.message);
                  }}
                >
                  Create agent connection URL
                </button>
              </div>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
