import { useCallback, useEffect, useRef, useState } from "react";
import { parseVoiceApprovalPreference, type VoiceApprovalPreference } from "../lib/voiceApproval";

export interface PhoneApprovalSettingsProps {
  load: () => Promise<VoiceApprovalPreference>;
  setEnabled: (enabled: boolean) => Promise<VoiceApprovalPreference>;
  onSignIn?: () => void;
}

/** Separate authority from generic alerts. Mount/refresh only read; every write needs an owner action. */
export function PhoneApprovalSettings({ load, setEnabled, onSignIn }: PhoneApprovalSettingsProps) {
  const [preference, setPreference] = useState<VoiceApprovalPreference | null>(null);
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const mounted = useRef(false);
  const busy = useRef(false);
  const sequence = useRef(0);
  const signIn = useRef(onSignIn);
  signIn.current = onSignIn;

  const failed = useCallback((cause: unknown) => {
    setUncertain(true); setMessage(null);
    if (cause !== null && typeof cause === "object" && "status" in cause && cause.status === 401) signIn.current?.();
  }, []);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    const request = ++sequence.current;
    setPending(true); setMessage(null);
    try {
      const next = parseVoiceApprovalPreference(await load());
      if (!mounted.current || sequence.current !== request) return;
      setPreference(next); setUncertain(false);
    } catch (cause) {
      if (mounted.current && sequence.current === request) failed(cause);
    } finally {
      if (mounted.current && sequence.current === request) { busy.current = false; setPending(false); }
    }
  }, [load, failed]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; sequence.current++; busy.current = false; };
  }, [refresh]);

  const change = async (enabled: boolean) => {
    if (busy.current || uncertain || !preference?.configured || !preference.eligible_owner) return;
    busy.current = true;
    const request = ++sequence.current;
    setPending(true); setMessage(null);
    try {
      const next = parseVoiceApprovalPreference(await setEnabled(enabled));
      if (next.enabled !== enabled) throw new Error("unconfirmed_voice_preference");
      if (!mounted.current || sequence.current !== request) return;
      setPreference(next); setUncertain(false);
      setMessage(enabled ? "Phone approvals are enabled for future held drafts." : "Phone approvals are off. Outstanding phone approval authority is invalidated.");
    } catch (cause) {
      if (mounted.current && sequence.current === request) failed(cause);
    } finally {
      if (mounted.current && sequence.current === request) { busy.current = false; setPending(false); }
    }
  };

  // An unknown initial state can recover through GET without offering enrollment or authority.
  if (preference === null && (uncertain || pending)) return (
    <section className="card" aria-labelledby="phone-approval-recovery-title">
      <h2 id="phone-approval-recovery-title">Phone approval settings</h2>
      {pending ? <p role="status">Checking phone approval settings…</p> :
        <p role="alert">Phone approval settings are unconfirmed. Refresh to check availability. Refreshing does not enable approvals or place a call.</p>}
      <button type="button" disabled={pending} onClick={() => void refresh()}>Refresh phone approval settings</button>
    </section>
  );
  // Do not offer enrollment or authority unless the backend confirms this configured owner.
  // An existing confirmed card retains its last state on a failed refresh.
  if (!preference?.configured || !preference.eligible_owner) return null;
  return (
    <section className="card" aria-labelledby="phone-approval-title">
      <h2 id="phone-approval-title">Approve exact drafts by phone</h2>
      <p className="muted">Settings reflect the last confirmation. Refresh after STOP or changes elsewhere.</p>
      <p id="phone-approval-authority">Off by default and separate from generic phone alerts. Turning this on lets whoever controls your configured phone approve or deny <strong>one exact pending draft</strong> after its recipient, subject and full message are read back. Approval can send that draft if its job still permits it.</p>
      <p id="phone-approval-identity">This does not verify a speaker's identity. Do not enable it for a shared or forwarded phone unless you intend its controller to have this authority.</p>
      <p id="phone-approval-data">Dial receives the exact recipient, subject and message for readout, and processes and transcribes the conversation. SpeedWrit retains a transcript hash and signed decision evidence with the action history, not the full transcript text. Dial may retain the conversation under its own policies. Read the <a href="/privacy">privacy notice</a>.</p>
      <p id="phone-approval-limits">Automatic calls apply only to future held draft versions after enabling. An unclear answer or no response leaves the draft waiting for review in the owner app. A changed version, expired authority, STOP or turning this off invalidates outstanding phone approval authority.</p>
      <p id="phone-approval-applied">Turning this off cannot undo a decision already applied, recall a call already placed or recall a message already accepted. Use STOP to stop applicable future email actions. Generic phone notices and the owner app's normal approval controls remain separate.</p>
      <label className="row"><input type="checkbox" checked={preference.enabled} disabled={pending || uncertain} aria-describedby="phone-approval-authority phone-approval-identity phone-approval-data phone-approval-limits phone-approval-applied" onChange={event => void change(event.target.checked)} /> Enable exact-draft phone approvals</label>
      {pending ? <p role="status">Waiting for the server to confirm phone approval settings…</p> : uncertain ? (
        <p role="alert">Phone approval status is unconfirmed. The switch shows the last confirmed preference. Refresh settings before another change.</p>
      ) : <p role="status">{message ?? (preference.enabled ? "Phone approvals are enabled for future held drafts." : "Phone approvals are off.")}</p>}
      <button type="button" disabled={pending} onClick={() => void refresh()}>Refresh phone approval settings</button>
    </section>
  );
}
