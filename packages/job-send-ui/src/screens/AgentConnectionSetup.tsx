import { useEffect, useRef, useState } from "react";
import { OwnerApiError, type ConnectState, type OwnerApi } from "../app/api";
import { SAY } from "../lib/copy";

export interface AgentConnectionSetupProps {
  api: Pick<OwnerApi, "createAgentConnection" | "revokeAgentConnection">;
  connection: { id: string; label: string } | null;
  call: <T>(request: () => Promise<T>) => Promise<T | undefined>;
  reload: () => Promise<ConnectState>;
}

/** Owner-initiated setup only. The URL never leaves this component's temporary state. */
export function AgentConnectionSetup({ api, connection, call, reload }: AgentConnectionSetupProps) {
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState<string | null>(null);
  const [created, setCreated] = useState<{ id: string; label: string } | null>(null);
  const [uncertainRevocation, setUncertainRevocation] = useState<{ id: string; label: string } | null>(null);
  const [inactiveIds, setInactiveIds] = useState<ReadonlySet<string>>(() => new Set());
  const [unavailable, setUnavailable] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<"create" | "revoke" | "refresh" | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  // Keep the returned id even when its URL is hidden or the status refresh fails.
  const target = uncertainRevocation ?? created ?? (connection && !inactiveIds.has(connection.id) ? connection : null);

  // These requests may precede any job. Keep their uncertainty here; only sign-in uses the app flow.
  const request = <T,>(action: () => Promise<T>, creating = false, onUnconfirmed?: () => void) => call(async () => {
    try { return await action(); }
    catch (error) {
      if (error instanceof OwnerApiError && error.code === "sign_in") throw error;
      if (mounted.current) {
        if (creating && error instanceof OwnerApiError && error.status === 404) setUnavailable(true);
        else {
          setUnconfirmed(true);
          onUnconfirmed?.();
        }
      }
      return undefined;
    }
  });

  const create = async () => {
    const clientLabel = label.trim();
    if (busy.current || unavailable || uncertainRevocation || url !== null || !clientLabel) return;
    busy.current = true;
    setPending("create");
    setMessage(null);
    setUnconfirmed(false);
    try {
      const answer = await request(() => api.createAgentConnection(clientLabel), true);
      if (!answer || !mounted.current) return;
      setUrl(answer.url);
      setCreated({ id: answer.agent_connection_id, label: clientLabel });
      setMessage(SAY.agentConnectionCreated);
      await request(reload);
    } finally {
      busy.current = false;
      if (mounted.current) setPending(null);
    }
  };

  const revoke = async () => {
    if (busy.current || !target) return;
    busy.current = true;
    setPending("revoke");
    setMessage(null);
    setUnconfirmed(false);
    try {
      const answer = await request(() => api.revokeAgentConnection(target.id), false, () => setUncertainRevocation(target));
      if (!answer || !mounted.current) return;
      setUrl(null);
      setCreated(null);
      setUncertainRevocation(null);
      setInactiveIds(previous => new Set(previous).add(target.id));
      setMessage(SAY.agentConnectionRevoked);
      await request(reload);
    } finally {
      busy.current = false;
      if (mounted.current) setPending(null);
    }
  };

  const refresh = async () => {
    if (busy.current) return;
    busy.current = true;
    setPending("refresh");
    setMessage(null);
    setUnconfirmed(false);
    try {
      const next = await request(reload);
      if (!next || !mounted.current || !uncertainRevocation) return;
      // The snapshot lists only the latest active connection. A different ID does not resolve
      // this target; absence confirms none are active, without proving a revocation receipt.
      if (next.agentConnectionId === null) {
        setInactiveIds(previous => new Set(previous).add(uncertainRevocation.id));
        setUrl(null);
        setCreated(null);
        setUncertainRevocation(null);
        setMessage(SAY.agentConnectionNoneActive);
      } else if (next.agentConnectionId === uncertainRevocation.id) {
        setUncertainRevocation(null);
        setMessage(SAY.agentConnectionStillActive);
      } else {
        setUnconfirmed(true);
      }
    }
    finally {
      busy.current = false;
      if (mounted.current) setPending(null);
    }
  };

  return (
    <section aria-label="Agent connection setup">
      <h2>Private URL setup</h2>
      <p>Use this fallback for the terminal Grokbot client or another client that accepts a private MCP URL. Enter it only in the client's local configuration; never paste it into chat. Anyone with this URL can use that agent connection. Sending still requires a job you approve.</p>
      <p>Creating a private URL makes a separate connection; existing jobs keep their original connection.</p>
      {unavailable ? <p role="status">{SAY.agentConnectionUnavailable}</p> : (
        <form onSubmit={(event) => { event.preventDefault(); void create(); }}>
          <label>
            Agent label
            <input value={label} onChange={(event) => setLabel(event.target.value)} disabled={pending !== null} maxLength={100} autoComplete="off" />
          </label>
          <button type="submit" disabled={pending !== null || !label.trim() || url !== null || uncertainRevocation !== null}>
            {pending === "create" ? "Creating private connection…" : "Create private connection URL"}
          </button>
        </form>
      )}
      {unconfirmed ? <p role="alert">{uncertainRevocation ? <><bdi style={{ overflowWrap: "anywhere" }}>{uncertainRevocation.label}</bdi>: {SAY.agentConnectionRevocationUnconfirmed}</> : SAY.agentConnectionUnconfirmed}</p> : null}
      {message ? <p role="status">{message}</p> : null}
      {url !== null ? (
        <div>
          <p>This private URL is shown only here. Save it in the client's local configuration before hiding it or leaving this page.</p>
          <label>
            Agent connection URL
            <textarea value={url} readOnly autoComplete="off" spellCheck={false} />
          </label>
          <button type="button" onClick={() => setUrl(null)}>Hide URL</button>
        </div>
      ) : null}
      {target ? (
        <p>
          Current agent connection: <bdi style={{ overflowWrap: "anywhere" }}>{target.label}</bdi>{" "}
          <button type="button" disabled={pending !== null} onClick={() => void revoke()}>
            {pending === "revoke" ? "Revoking agent connection…" : "Revoke agent connection"}
          </button>
        </p>
      ) : null}
      <button type="button" disabled={pending !== null} onClick={() => void refresh()}>
        {pending === "refresh" ? "Refreshing connections…" : "Refresh Connections"}
      </button>
    </section>
  );
}
