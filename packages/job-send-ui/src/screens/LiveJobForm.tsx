import { useState } from "react";
import { AI_CHECK_LABELS, MAX_SENDS_LIMIT, chipFor, draftFrom, parseLine, type Limit, type LineState } from "../lib/frontDoor";
import { formatExpiry } from "../lib/time";
import type { CompleteDraft, FrontDoorProps } from "./FrontDoor";

export type LiveJobFormProps = Pick<FrontDoorProps, "contacts" | "timeZone" | "now" | "onUse">;

/** Collects a real job draft; the caller still creates, reviews and confirms the server's authority. */
export function LiveJobForm({ contacts, timeZone, now = () => new Date(), onUse }: LiveJobFormProps) {
  const [recipient, setRecipient] = useState(contacts[0]?.email ?? "");
  const [count, setCount] = useState("3");
  const [allowCustom, setAllowCustom] = useState(true);
  const [rules, setRules] = useState("");
  const [draftTime] = useState(() => now());
  // Keep the expiry the owner saw. A draft left open past midnight must not silently gain another day.
  const [expiry] = useState(() => parseLine("expires tonight", { contacts, timeZone, now: draftTime }));
  const [submitError, setSubmitError] = useState<string | null>(null);
  const expiresAt = expiry.status === "limit" && expiry.limit.kind === "expiry" ? expiry.limit.expiresAt : null;
  const contact = contacts.find((item) => item.email === recipient && item.email.trim() !== "");
  const maxSends = Number(count);
  const countValid = count.trim() !== "" && Number.isInteger(maxSends) && maxSends >= 1 && maxSends <= MAX_SENDS_LIMIT;

  // Parse every nonblank line, including text the owner has not submitted with Enter.
  // Values remain tied to the day this draft opened; typing later cannot extend its authority.
  const lines = rules.split(/\r?\n/).map((text) => text.trim()).filter(Boolean).map((text) => {
    const parsed = parseLine(text, { contacts, timeZone, now: draftTime });
    const state: Exclude<LineState, { status: "unmatched" }> = parsed.status === "unmatched"
      ? { status: "needs_detail", kind: "vague", why: "Reword this as a supported limit, or remove it. This rule has not been added." }
      : parsed;
    return { text, state };
  });
  const limits = lines.flatMap(({ state }) => state.status === "limit" ? [state.limit] : []);
  const base: Limit[] = [
    ...(contact ? [{ kind: "recipient" as const, email: contact.email.toLowerCase(), label: contact.name }] : []),
    ...(countValid ? [{ kind: "count" as const, maxSends }] : []),
    ...(expiresAt ? [{ kind: "expiry" as const, expiresAt }] : []),
  ];
  const resolved = draftFrom([...base, ...limits]);
  const shownExpiry = resolved.draft.expiresAt ? formatExpiry(resolved.draft.expiresAt, timeZone) : null;
  const countConflict = limits.some((limit) => limit.kind === "count" && limit.maxSends !== maxSends);
  const approvalConflict = !allowCustom && limits.some((limit) => limit.kind === "approval");
  const unresolved = lines.some(({ state }) => state.status !== "limit");

  const validate = (): { draft: CompleteDraft; error?: never } | { draft?: never; error: string } => {
    if (!contact) return { error: "Choose a recipient from your contacts." };
    if (!countValid) return { error: `Enter a whole number from 1 to ${MAX_SENDS_LIMIT}.` };
    if (!expiresAt || !(new Date(expiresAt).getTime() > now().getTime())) {
      return { error: "Tonight's expiry has passed. This draft cannot be used." };
    }
    if (rules.length > 4000 || lines.length > 20) return { error: "Use at most 20 rules and 4,000 characters." };
    if (unresolved) return { error: "Clarify or remove every rule marked Needs one detail before reviewing this job." };
    if (countConflict) return { error: "The typed send limit disagrees with Sends at most. Make both counts match before reviewing." };
    if (resolved.problems.length) return { error: "The typed recipient disagrees with the selected recipient. Make both match before reviewing." };
    if (approvalConflict) return { error: "Custom wording is switched off. Remove the typed approval rule or explicitly enable Ask me before custom wording." };
    const draft = resolved.draft;
    if (!draft.recipient || draft.maxSends === undefined || !draft.expiresAt || !(new Date(draft.expiresAt).getTime() > now().getTime())) {
      return { error: "The resolved expiry has passed. Edit the rule before reviewing this job." };
    }
    return { draft: { ...draft, recipient: draft.recipient, maxSends: draft.maxSends, expiresAt: draft.expiresAt, allowCustomWithApproval: allowCustom } };
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
        <p>Ends no later than tonight. Resolved expiry{shownExpiry ? `: ${shownExpiry.local} (${shownExpiry.utc})` : ": unavailable"}.</p>
        <label className="row">
          <input type="checkbox" checked={allowCustom} onChange={(event) => setAllowCustom(event.target.checked)} />
          Ask me before custom wording
        </label>
      </section>

      <section className="card" aria-label="Natural-language rules">
        <h2>Custom rules in your words</h2>
        <label>
          Custom rules in your words
          <textarea rows={5} maxLength={4000} value={rules} placeholder={"don't sound rude\nno promises of discounts\nno links"}
            onChange={(event) => { setRules(event.target.value); setSubmitError(null); }} />
        </label>
        <p>One rule per line. For example: “three sends max”, “until 5pm”, or “don't sound rude”. Check the resolved meaning below.</p>
        <p>Typed counts and recipients must match the controls above. A typed expiry can only end the job earlier.</p>
        <p className="muted">Content wording selects built-in AI review; it does not create a custom hard rule. Only the resolved meaning below is included in the job. All six built-in AI checks then run on every message: {Object.values(AI_CHECK_LABELS).join("; ")}. AI review may miss a problem; a flag or unavailable review asks you.</p>
        <ul aria-label="Resolved custom rules">
          {lines.map(({ text, state }, index) => {
            const chip = chipFor(state, timeZone);
            return <li key={index}><q>{text}</q>{" "}<strong data-tone={chip.tone}>{chip.text}</strong>{" "}
              {chip.label ? <em>{chip.label} </em> : null}<span>{chip.detail}</span></li>;
          })}
        </ul>
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
            {resolved.draft.aiReview === "all_free_text" && <p>AI review of every message: a flag or unavailable review asks you. AI-reviewed, may miss.</p>}
          </div>
        </div>
        {checked.error || submitError ? <p role="alert">{checked.error ?? submitError}</p> : null}
        <p className="muted">Review the complete job on the next screen before confirming it.</p>
        <button className="btn primary" type="submit" disabled={!checked.draft}>Review this job</button>
      </section>
    </form>
  );
}
