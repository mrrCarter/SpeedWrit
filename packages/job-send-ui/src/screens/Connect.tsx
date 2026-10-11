export interface ConnectProps {
  /** The linked Gmail account and the exact scopes Google granted. */
  gmail: {
    address: string;
    grantedScopes: readonly string[];
    /** needs_reconnect: Google no longer honours the grant (e.g. a Testing-mode token after 7 days); nothing can send until reconnected. */
    status?: "active" | "stopped" | "needs_reconnect";
  } | null;
  /** The agent's MCP connection, as authenticated (the label is declared by the client, not verified). */
  agentConnection: { mcpUrl: string; label: string; lastUsedAt: string | null } | null;
  stopped: boolean;
  onStop: () => void;
}

/**
 * Connect (spec: "Screens and UI copy"): the Gmail account and the exact granted permission, the agent connection
 * (MCP URL, label, last used), and STOP. STOP turns dispatch off locally first; revoking Google's access follows.
 */
export function Connect({ gmail, agentConnection, stopped, onStop }: ConnectProps) {
  return (
    <section aria-label="Connections">
      <h2>Connections</h2>
      <h3>Gmail</h3>
      {gmail ? (
        <p>
          {gmail.address} · granted: {gmail.grantedScopes.map((scope) => <code key={scope}>{scope} </code>)}
          {gmail.status === "needs_reconnect" ? <strong> · Google access lapsed. Reconnect to send again.</strong> : null}
        </p>
      ) : (
        <p>No Gmail account connected</p>
      )}
      <h3>Agent</h3>
      {agentConnection ? (
        <p>
          {/* The label is declared by the client: <bdi> keeps a direction override inside it from reordering the line. */}
          <bdi style={{ overflowWrap: "anywhere" }}>{agentConnection.label}</bdi> (declared) · <code>{agentConnection.mcpUrl}</code> · last used{" "}
          {agentConnection.lastUsedAt ? <time dateTime={agentConnection.lastUsedAt}>{agentConnection.lastUsedAt}</time> : "never"}
        </p>
      ) : (
        <p>No agent connected</p>
      )}
      {stopped ? (
        <p role="status">Sending is stopped. Nothing new is sent.</p>
      ) : (
        <button type="button" onClick={onStop}>
          STOP sending
        </button>
      )}
    </section>
  );
}
