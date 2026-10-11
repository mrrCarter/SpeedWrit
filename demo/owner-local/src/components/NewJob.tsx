import { useMemo, useState } from "react";
import { draftFrom, parseLine, STARTER_LINES, type LineState } from "../domain/frontDoor";
import { useEngine, useEngineState } from "../engineContext";
import { Card, Chip, fmtTime } from "./ui";

function chipOf(st: LineState) {
  if (st.status === "unmatched") return <Chip tone="plain">not a limit</Chip>;
  if (st.status === "needs_detail") return <Chip tone="hold">{st.why}</Chip>;
  const l = st.limit;
  if (l.kind === "recipient") return <Chip tone="bad">Never: anyone else · only {l.label}</Chip>;
  if (l.kind === "count") return <Chip tone="bad">Never: more than {l.maxSends} sends</Chip>;
  if (l.kind === "expiry") return <Chip tone="bad">Never: after {fmtTime(l.expiresAt)}</Chip>;
  if (l.kind === "approval") return <Chip tone="hold">Ask me: wording outside the template</Chip>;
  return <Chip tone="plain">already on for every job: no {l.what}</Chip>;
}

export function NewJob({ done }: { done: () => void }) {
  const s = useEngineState();
  const engine = useEngine();
  const [text, setText] = useState("");
  const [review, setReview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const agents = s.agentConnections.filter((a) => !a.revoked);
  const [agentId, setAgentId] = useState<string>("");
  const agent = agents.find((a) => a.id === agentId) ?? agents[0];

  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const states = useMemo(() => lines.map((l) => parseLine(l, s.contacts, s.clock)), [text, s.contacts, s.clock]); // eslint-disable-line react-hooks/exhaustive-deps
  const { draft, missing, problems } = draftFrom(states);
  const ready = missing.length === 0 && problems.length === 0 && !!agent;

  if (agents.length === 0) {
    return <Card sunk><p className="muted">Connect an agent first (Connections). A job is bound to one agent connection.</p></Card>;
  }

  if (review && draft.recipient && draft.maxSends && draft.expiresAt && agent) {
    const never = [`Anyone other than ${draft.recipient}`, `More than ${draft.maxSends} ${draft.maxSends === 1 ? "send" : "sends"}`, `After ${fmtTime(draft.expiresAt)}`, "Links, Cc, Bcc, attachments", ...(draft.allowCustom ? [] : ["Wording outside the template"])];
    const askMe = draft.allowCustom ? ["Wording outside the template"] : [];
    return (
      <Card title="Confirm this job">
        <p>Send {draft.recipientLabel} a recap of our call.</p>
        <div className="rule"><span className="k">recipient</span><span>{draft.recipient}</span></div>
        <div className="rule"><span className="k">sends</span><span>{draft.maxSends}</span></div>
        <div className="rule"><span className="k">expires</span><span>{fmtTime(draft.expiresAt)}</span></div>
        <div className="rule"><span className="k">agent</span><span>{agent.label} · {agent.kind === "oauth" ? "OAuth" : "fallback"}</span></div>
        <div className="grid g3" style={{ marginTop: 12 }}>
          <div><h3 style={{ color: "var(--bad)" }}>Never</h3>{never.map((x) => <div key={x}>· {x}</div>)}</div>
          <div><h3 style={{ color: "var(--hold)" }}>Ask me</h3>{askMe.length ? askMe.map((x) => <div key={x}>· {x}</div>) : <div className="faint">nothing</div>}</div>
          <div><h3 style={{ color: "var(--ok)" }}>Runs without asking</h3><div>· The recap template with fields inside their rules, to {draft.recipient}</div></div>
        </div>
        {!draft.allowCustom && <p className="hold" style={{ color: "var(--hold)", marginTop: 10 }}>No "ask me before custom wording" line: custom wording will be refused, not held.</p>}
        {error && <p className="fail">{error}</p>}
        <hr />
        <div className="row">
          <button className="btn" onClick={() => setReview(false)}>Back</button>
          <span className="spacer" />
          <button
            className="btn primary"
            onClick={async () => {
              const r = await engine.confirmSendJob(draft, agent.id);
              if (r.ok) {
                setText("");
                setReview(false);
                done();
              } else setError(r.message);
            }}
          >
            Confirm job
          </button>
        </div>
      </Card>
    );
  }

  return (
    <Card title="New job" right={<button className="btn small ghost" onClick={() => setText(STARTER_LINES.join("\n"))}>Use starter lines</button>}>
      <p className="muted">One limit per line. For example: <code>only email Dana</code>, <code>two sends max</code>, <code>expires tonight</code>, <code>ask me before custom wording</code>.</p>
      <textarea className="mono-box" style={{ width: "100%", minHeight: 120 }} value={text} onChange={(e) => setText(e.target.value)} placeholder={STARTER_LINES.join("\n")} />
      <div className="rows" style={{ marginTop: 10 }}>
        {lines.map((l, i) => (
          <div key={i} className="row"><code style={{ minWidth: 260 }}>{l}</code>{states[i] && chipOf(states[i])}</div>
        ))}
      </div>
      <hr />
      <div className="row">
        {agents.length > 1 && (
          <label className="row muted">agent
            <select className="btn small" value={agent?.id} onChange={(e) => setAgentId(e.target.value)}>
              {agents.map((a) => <option key={a.id} value={a.id}>{a.label} · {a.kind}</option>)}
            </select>
          </label>
        )}
        <span className="muted">{missing.length ? `Still needed: ${missing.join(", ")}` : problems[0] ?? "Ready to review."}</span>
        <span className="spacer" />
        <button className="btn primary" disabled={!ready} onClick={() => setReview(true)}>Use these limits</button>
      </div>
    </Card>
  );
}
