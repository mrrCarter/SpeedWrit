import { useMemo, useState } from "react";
import { draftFrom, parseLine, STARTER_LINES, type LineState } from "../domain/frontDoor";
import { useEngine, useEngineState } from "../engineContext";
import { Card, Chip, fmtTime } from "./ui";

/** Near misses get the exact phrase the parser (and the live app) accepts, instead of a silent "not a limit". */
function suggestion(line: string): string | null {
  const t = line.toLowerCase();
  if (/expir|tonight|until|valid/.test(t)) return "expires tonight";
  if (/\bsends?\b|emails?|messages?|max|at most/.test(t)) return "two sends max";
  if (/custom|wording|approv|ask/.test(t)) return "ask me before custom wording";
  if (/dana|bo\b|email|only|recipient/.test(t)) return "only email Dana";
  return null;
}

function chipOf(st: LineState, line: string) {
  if (st.status === "unmatched") {
    const hint = suggestion(line);
    return <Chip tone="hold">{hint ? `not a limit: did you mean "${hint}"?` : "not a limit: try the examples above"}</Chip>;
  }
  if (st.status === "needs_detail") return <Chip tone="hold">{st.why}</Chip>;
  const l = st.limit;
  if (l.kind === "recipient") return <Chip tone="bad">Never: anyone else · only {l.label}</Chip>;
  if (l.kind === "count") return <Chip tone="bad">Never: more than {l.maxSends} sends</Chip>;
  if (l.kind === "expiry") return <Chip tone="bad">Never: after {fmtTime(l.expiresAt)}</Chip>;
  if (l.kind === "approval") return <Chip tone="hold">Ask me: wording outside the template</Chip>;
  return <Chip tone="plain">already on for every job: no {l.what}</Chip>;
}

/** One screen: type the limits, see what each line means, see the whole job, confirm. */
export function NewJob({ done }: { done: () => void }) {
  const s = useEngineState();
  const engine = useEngine();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const agents = s.agentConnections.filter((a) => !a.revoked);
  const [agentId, setAgentId] = useState<string>("");
  const agent = agents.find((a) => a.id === agentId) ?? agents[agents.length - 1];

  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const states = useMemo(() => lines.map((l) => parseLine(l, s.contacts, s.clock)), [text, s.contacts, s.clock]); // eslint-disable-line react-hooks/exhaustive-deps
  const { draft, missing, problems } = draftFrom(states);
  const ready = missing.length === 0 && problems.length === 0 && !!agent && !!draft.recipient && !!draft.maxSends && !!draft.expiresAt;

  if (agents.length === 0) {
    return (
      <Card title="New job">
        <p className="muted">A job is bound to one agent connection, so connect ChatGPT first. Then type the job's limits here, one per line.</p>
        <div className="row">
          <button className="btn primary" onClick={() => void engine.connectAgent("ChatGPT-SpeedWrit", "oauth")}>Connect ChatGPT (OAuth)</button>
          <span className="faint">or use Connections for the consent screen or a fallback URL</span>
        </div>
      </Card>
    );
  }

  const never = [
    draft.recipient ? `Anyone other than ${draft.recipient}` : "Anyone but the one recipient (add: only email Dana)",
    draft.maxSends ? `More than ${draft.maxSends} ${draft.maxSends === 1 ? "send" : "sends"}` : "More than N sends (add: two sends max)",
    draft.expiresAt ? `After ${fmtTime(draft.expiresAt)}` : "After the expiry (add: expires tonight)",
    "Links, Cc, Bcc, attachments",
    ...(draft.allowCustom ? [] : ["Wording outside the template"]),
  ];

  const confirm = async () => {
    if (!agent) return;
    const r = await engine.confirmSendJob(draft, agent.id);
    if (r.ok) {
      setText("");
      setError(null);
      done();
    } else setError(r.message);
  };

  return (
    <div className="grid">
      <Card title="New job" right={<button className="btn small" onClick={() => setText(STARTER_LINES.join("\n"))}>Use starter lines</button>}>
        <p className="muted">One limit per line, for example: <code>only email Dana</code> · <code>two sends max</code> · <code>expires tonight</code> · <code>ask me before custom wording</code></p>
        <textarea className="mono-box" style={{ width: "100%", minHeight: 110 }} value={text} onChange={(e) => setText(e.target.value)} aria-label="Job limits, one per line" />
        {lines.length > 0 && (
          <div className="rows" style={{ marginTop: 10 }}>
            {lines.map((l, i) => (
              <div key={i} className="row"><code style={{ minWidth: 260 }}>{l}</code>{states[i] && chipOf(states[i], l)}</div>
            ))}
          </div>
        )}
      </Card>

      <Card title="This job" right={ready ? <Chip tone="ok">ready to confirm</Chip> : <Chip tone="hold">{missing.length ? `still needed: ${missing.join(", ")}` : problems[0] ?? "type the limits above"}</Chip>}>
        <div className="grid g3">
          <div><h3 style={{ color: "var(--bad)" }}>Never</h3>{never.map((x) => <div key={x}>· {x}</div>)}</div>
          <div><h3 style={{ color: "var(--hold)" }}>Ask me</h3>{draft.allowCustom ? <div>· Wording outside the template</div> : <div className="faint">nothing (add: ask me before custom wording)</div>}</div>
          <div><h3 style={{ color: "var(--ok)" }}>Runs without asking</h3><div>· The recap template, fields inside their rules{draft.recipient ? `, to ${draft.recipient}` : ""}</div></div>
        </div>
        {!draft.allowCustom && lines.length > 0 && <p style={{ color: "var(--hold)", marginTop: 10 }}>Without "ask me before custom wording", custom wording is refused, not held.</p>}
        {error && <p className="fail">{error}</p>}
        <hr />
        <div className="row">
          {agents.length > 1 ? (
            <label className="row muted">agent
              <select className="btn small" value={agent?.id} onChange={(e) => setAgentId(e.target.value)}>
                {agents.map((a) => <option key={a.id} value={a.id}>{a.label} · {a.kind}</option>)}
              </select>
            </label>
          ) : (
            <span className="muted">agent: {agent?.label} · {agent?.kind === "oauth" ? "OAuth" : "fallback"}</span>
          )}
          <span className="spacer" />
          <button className="btn primary" disabled={!ready} onClick={() => void confirm()}>Confirm job</button>
        </div>
      </Card>
    </div>
  );
}
