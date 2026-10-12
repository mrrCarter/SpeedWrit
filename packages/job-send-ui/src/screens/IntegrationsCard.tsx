import { useCallback, useEffect, useRef, useState } from "react";
import { parseAlertPreference, parseAlertTest, parseIntegrationMetadata, type DialStatus, type IntegrationMetadata } from "../lib/integrations";

export interface IntegrationsCardProps {
  load: () => Promise<IntegrationMetadata>;
  setEnabled: (enabled: boolean) => Promise<{ enabled: boolean }>;
  test: () => Promise<{ queued: true }>;
  onSignIn?: () => void;
}

const STATUS: Record<DialStatus, string> = {
  unconfigured: "Phone alerts are not configured.",
  disabled: "Phone alerts are off.",
  calling: "A call request is in progress. Its outcome is not confirmed yet.",
  unknown: "Call outcome unknown. Check the status before requesting another call.",
  queued: "A notice is queued; no call outcome is confirmed yet.",
  failed: "The notification service reported a failure. Refresh to check its current status.",
  ready: "Phone alerts are enabled and waiting for eligible events.",
};
const LAST = {
  accepted: "Dial accepted the call request. This does not confirm the call was answered.",
  unknown: "The call request outcome is unknown.",
  failed: "The call request failed.",
} as const;

/** Configuration and owner-initiated notification controls. Mounting and refreshing only read metadata. */
export function IntegrationsCard({ load, setEnabled, test, onSignIn }: IntegrationsCardProps) {
  const [metadata, setMetadata] = useState<IntegrationMetadata | null>(null);
  const [pending, setPending] = useState<"refresh" | "preference" | "test" | null>("refresh");
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const mounted = useRef(false);
  const sequence = useRef(0);
  const busy = useRef(false);
  const signIn = useRef(onSignIn);
  signIn.current = onSignIn;

  const failure = useCallback((cause: unknown, write: boolean) => {
    setUncertain(true);
    setMessage(null);
    setError(write
      ? "We could not confirm the request result. Refresh integrations before repeating the action."
      : "Integration status is unavailable. Refresh integrations to check it again.");
    if (cause !== null && typeof cause === "object" && "status" in cause && cause.status === 401) signIn.current?.();
  }, []);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const request = ++sequence.current;
    setPending("refresh");
    setMessage(null);
    try {
      const next = parseIntegrationMetadata(await load());
      if (!mounted.current || sequence.current !== request) return;
      setMetadata(next); setUncertain(false); setError(null);
    } catch (cause) {
      if (mounted.current && sequence.current === request) failure(cause, false);
    } finally {
      if (mounted.current && sequence.current === request) { busy.current = false; setPending(null); }
    }
  }, [load, failure]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; sequence.current++; busy.current = false; };
  }, [refresh]);

  const change = async (enabled?: boolean) => {
    if (busy.current || uncertain || !metadata || !metadata.dial.configured || !metadata.dial.live ||
        (enabled === undefined && !metadata.dial.enabled)) return;
    busy.current = true;
    const request = ++sequence.current;
    setPending(enabled === undefined ? "test" : "preference");
    setMessage(null); setError(null);
    try {
      if (enabled === undefined) parseAlertTest(await test());
      else {
        const answer = parseAlertPreference(await setEnabled(enabled));
        if (answer.enabled !== enabled) throw new Error("unconfirmed_integration_response");
        if (mounted.current && sequence.current === request) {
          // The checkbox changes only after the server confirms this preference.
          setMetadata(previous => previous && ({ ...previous, dial: { ...previous.dial, enabled: answer.enabled } }));
        }
      }
      if (!mounted.current || sequence.current !== request) return;
      const next = parseIntegrationMetadata(await load());
      if (!mounted.current || sequence.current !== request) return;
      setMetadata(next); setUncertain(false);
      setMessage(enabled === undefined
        ? "Test request accepted for queuing. This does not confirm a call was placed or answered."
        : "Alert preference saved. Current status is shown above.");
    } catch (cause) {
      if (mounted.current && sequence.current === request) failure(cause, true);
    } finally {
      if (mounted.current && sequence.current === request) { busy.current = false; setPending(null); }
    }
  };

  const dial = metadata?.dial;
  const disabled = pending !== null || uncertain || !dial?.configured || !dial.live;
  return (
    <section aria-label="Integrations" className="card">
      <h2>Integrations</h2>
      <p className="muted">Status reflects the last refresh. Refresh after changing settings elsewhere or using STOP.</p>
      {metadata ? <>
        <h3>AI review</h3>
        <p>{metadata.jev.configured ? "Server configuration is present." : "AI review is not configured."} Model: <code>{metadata.jev.model}</code>.</p>
        <p className="muted">Configuration does not confirm that a review ran or succeeded. Review flags or unavailable review can require your approval; AI review cannot approve or send.</p>
        <h3>Phone alerts · Dial</h3>
        <p className="muted">Drafts waiting for review or unknown email outcomes can queue a generic notice. Calls cannot approve a draft or send an email.</p>
        <p className="muted">After a notice, check <a href="#/exceptions">Waiting for you</a> for pending drafts. For an unknown email outcome, open the relevant job in <a href="#/jobs">Jobs</a> to inspect its Flight Recorder.</p>
        <p className="muted">Automatic notices require Gmail to be connected with sending enabled. After turning phone alerts on, you can request a test call even without Gmail.</p>
        {!dial?.live && <p>Live calls are disabled in the server configuration.</p>}
        {uncertain ? <p>Current alert status is unconfirmed. The switch shows the last confirmed preference.</p> : pending === null && dial ? <>
          <p role="status">{STATUS[dial.status]}</p>
          <p>Queued notices: {dial.pending}</p>
          {dial.last_result && <p>Last call request: {LAST[dial.last_result.status]} <time dateTime={dial.last_result.at}>{dial.last_result.at}</time></p>}
        </> : null}
        <label className="row"><input type="checkbox" checked={dial?.enabled ?? false} disabled={disabled} onChange={event => void change(event.target.checked)} /> Enable phone alerts</label>
        <p className="muted">Turning alerts off cancels queued notices. A call already placed cannot be recalled.</p>
        <button type="button" disabled={disabled || !dial?.enabled} onClick={() => void change()}>Send test call</button>
      </> : null}
      {pending !== null && <p role="status">{pending === "refresh" ? "Loading integration status…" : "Waiting for the server to confirm the request…"}</p>}
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <button type="button" disabled={pending !== null} onClick={() => void refresh()}>Refresh integrations</button>
    </section>
  );
}
