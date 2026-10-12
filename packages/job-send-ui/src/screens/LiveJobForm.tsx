import { useState } from "react";
import { MAX_SENDS_LIMIT, parseLine } from "../lib/frontDoor";
import { formatExpiry } from "../lib/time";
import type { CompleteDraft, FrontDoorProps } from "./FrontDoor";

export type LiveJobFormProps = Pick<FrontDoorProps, "contacts" | "timeZone" | "now" | "onUse">;

/** Collects a real job draft; the caller still creates, reviews and confirms the server's authority. */
export function LiveJobForm({ contacts, timeZone, now = () => new Date(), onUse }: LiveJobFormProps) {
  const [recipient, setRecipient] = useState(contacts[0]?.email ?? "");
  const [count, setCount] = useState("3");
  const [allowCustom, setAllowCustom] = useState(true);
  // Keep the expiry the owner saw. A draft left open past midnight must not silently gain another day.
  const [expiry] = useState(() => parseLine("expires tonight", { contacts, timeZone, now: now() }));
  const [submitError, setSubmitError] = useState<string | null>(null);
  const expiresAt = expiry.status === "limit" && expiry.limit.kind === "expiry" ? expiry.limit.expiresAt : null;
  const shownExpiry = expiresAt ? formatExpiry(expiresAt, timeZone) : null;
  const contact = contacts.find((item) => item.email === recipient && item.email.trim() !== "");
  const maxSends = Number(count);
  const countValid = count.trim() !== "" && Number.isInteger(maxSends) && maxSends >= 1 && maxSends <= MAX_SENDS_LIMIT;

  const validate = (): { draft: CompleteDraft; error?: never } | { draft?: never; error: string } => {
    if (!contact) return { error: "Choose a recipient from your contacts." };
    if (!countValid) return { error: `Enter a whole number from 1 to ${MAX_SENDS_LIMIT}.` };
    if (!expiresAt || !(new Date(expiresAt).getTime() > now().getTime())) {
      return { error: "Tonight's expiry has passed. This draft cannot be used." };
    }
    return { draft: { recipient: contact.email.toLowerCase(), maxSends, expiresAt, allowCustomWithApproval: allowCustom } };
  };
  const checked = validate();

  return (
    <form
      aria-label="New job"
      className="grid"
      onSubmit={(event) => {
        event.preventDefault();
        const current = validate();
        if (!current.draft) {
          setSubmitError(current.error);
          return;
        }
        setSubmitError(null);
        onUse(current.draft);
      }}
    >
      <section className="card" aria-label="Job limits">
        <h2>New job</h2>
        <p className="muted">Choose one recipient and the limits the agent must follow.</p>
        <div className="grid g2">
          <label>
            Recipient
            <select value={recipient} onChange={(event) => { setRecipient(event.target.value); setSubmitError(null); }}>
              <option value="">Choose a contact</option>
              {contacts.map((item) => (
                <option key={item.email} value={item.email}>
                  {item.name}{item.company ? ` (${item.company})` : ""} &lt;{item.email}&gt;
                </option>
              ))}
            </select>
          </label>
          <label>
            Sends at most
            <input type="number" min={1} max={MAX_SENDS_LIMIT} step={1} required value={count} onChange={(event) => { setCount(event.target.value); setSubmitError(null); }} />
          </label>
        </div>
        <p>Expires tonight{shownExpiry ? `: ${shownExpiry.local} (${shownExpiry.utc})` : ": unavailable"}.</p>
        <label className="row">
          <input type="checkbox" checked={allowCustom} onChange={(event) => setAllowCustom(event.target.checked)} />
          Ask me before custom wording
        </label>
      </section>

      <section className="card" aria-label="This job">
        <h2>This job</h2>
        <div className="grid g2">
          <div>
            <h3>Never</h3>
            <ul>
              <li>{contact ? `Anyone other than ${contact.email}` : "Anyone but the recipient you choose"}</li>
              <li>{countValid ? `More than ${maxSends} ${maxSends === 1 ? "send" : "sends"}` : "Sending without a valid send limit"}</li>
              <li>{shownExpiry ? `After ${shownExpiry.local} (${shownExpiry.utc})` : "Sending without a future expiry"}</li>
              {!allowCustom && <li>Wording outside the template</li>}
            </ul>
          </div>
          <div>
            <h3>Ask me</h3>
            <p>{allowCustom ? "Before wording outside the template" : "Custom wording is refused."}</p>
          </div>
        </div>
        {checked.error || submitError ? <p role="alert">{checked.error ?? submitError}</p> : null}
        <p className="muted">Review the complete job on the next screen before confirming it.</p>
        <button className="btn primary" type="submit" disabled={!checked.draft}>Review this job</button>
      </section>
    </form>
  );
}
