import { useRef, useState } from "react";
import {
  AI_CHECK_LABELS,
  MAX_SENDS_LIMIT,
  STARTER_PACK_LINES,
  chipFor,
  draftFrom,
  parseLine,
  readLine,
  type AiCheck,
  type Classify,
  type Contact,
  type DraftResult,
  type FrontDoorDraft,
  type Limit,
  type LineState,
  type ParseContext,
} from "../lib/frontDoor";

/** A draft with everything a job needs from the front door; the owner still confirms the whole job on Confirm. */
export type CompleteDraft = FrontDoorDraft & { recipient: string; maxSends: number; expiresAt: string };

export interface FrontDoorProps {
  contacts: readonly Contact[];
  timeZone?: string;
  /** The clock; tests pin it. */
  now?: () => Date;
  /** The classifier for lines no pattern matched. Without one, such a line is vague. */
  classify?: Classify;
  onUse: (draft: CompleteDraft) => void;
}

type Line = { id: number; text: string; state: Exclude<LineState, { status: "unmatched" }> | null };

const MISSING_LABELS: Readonly<Record<DraftResult["missing"][number], string>> = {
  recipient: "who may receive it",
  maxSends: "a send limit",
  expiresAt: "when it ends",
};

const contactLabel = (contact: Contact) => (contact.company ? `${contact.name} (${contact.company})` : contact.name);

function recipientLimit(contact: Contact): Limit {
  return { kind: "recipient", email: contact.email.toLowerCase(), label: `${contactLabel(contact)} <${contact.email}>` };
}

/** The small form a line that needs one detail shows; each choice turns the line into a concrete limit. */
function DetailForm({
  line,
  contacts,
  setLimit,
  starterPack,
  parse,
}: {
  line: Line;
  contacts: readonly Contact[];
  setLimit: (limit: Limit) => void;
  starterPack: () => void;
  parse: (text: string) => LineState;
}) {
  const [picked, setPicked] = useState(0);
  const [count, setCount] = useState(2);
  const state = line.state;
  if (state?.status === "choose") {
    return (
      <span>
        {state.matches.map((contact) => (
          <button key={contact.email} type="button" onClick={() => setLimit(recipientLimit(contact))}>
            {contactLabel(contact)} &lt;{contact.email}&gt;
          </button>
        ))}
      </span>
    );
  }
  if (state?.status !== "needs_detail") return null;
  switch (state.kind) {
    case "recipient": {
      const chosen = contacts[picked];
      return (
        <span>
          <select aria-label="Recipient" value={picked} onChange={(event) => setPicked(Number(event.target.value))}>
            {contacts.map((contact, index) => (
              <option key={contact.email} value={index}>
                {contactLabel(contact)} &lt;{contact.email}&gt;
              </option>
            ))}
          </select>
          <button type="button" disabled={!chosen} onClick={() => chosen && setLimit(recipientLimit(chosen))}>
            Use this contact
          </button>
        </span>
      );
    }
    case "count":
      return (
        <span>
          <input
            aria-label="Sends at most"
            type="number"
            min={1}
            max={MAX_SENDS_LIMIT}
            value={count}
            onChange={(event) => setCount(Number(event.target.value))}
          />
          <button
            type="button"
            disabled={!Number.isInteger(count) || count < 1 || count > MAX_SENDS_LIMIT}
            onClick={() => setLimit({ kind: "count", maxSends: count })}
          >
            Set the limit
          </button>
        </span>
      );
    case "expiry": {
      const tonight = parse("expires tonight");
      return tonight.status === "limit" ? (
        <button type="button" onClick={() => setLimit(tonight.limit)}>
          Ends tonight
        </button>
      ) : null;
    }
    case "approval":
      return (
        <button type="button" onClick={() => setLimit({ kind: "approval" })}>
          Ask me before custom wording
        </button>
      );
    case "content":
      return (
        <span>
          {(Object.keys(AI_CHECK_LABELS) as AiCheck[]).map((check) => (
            <button key={check} type="button" onClick={() => setLimit({ kind: "ai_review", checks: [check] })}>
              AI review: {AI_CHECK_LABELS[check]}
            </button>
          ))}
        </span>
      );
    case "vague":
      return (
        <button type="button" onClick={starterPack}>
          Use the starter pack instead
        </button>
      );
  }
}

/**
 * The type-a-sentence front door (spec, after Gate 3). One limit per line; Enter adds it. Each line shows what code
 * made of it as a chip: Never, Ask me, or "Needs one detail" with a small form. "Use these limits" stays off until
 * every line is a concrete check, nothing contradicts, and the job has a recipient, a send limit and an end.
 */
export function FrontDoor({ contacts, timeZone, now = () => new Date(), classify, onUse }: FrontDoorProps) {
  const [lines, setLines] = useState<Line[]>([]);
  const [typed, setTyped] = useState("");
  const nextId = useRef(1);
  const ctx = (): ParseContext => ({ contacts, timeZone, now: now() });

  const add = (text: string) => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    const id = nextId.current++;
    const parsed = parseLine(trimmed, ctx());
    if (parsed.status !== "unmatched") {
      setLines((current) => [...current, { id, text: trimmed, state: parsed }]);
      return;
    }
    setLines((current) => [...current, { id, text: trimmed, state: null }]);
    // A line removed while the classifier runs stays removed: the answer finds no line to update.
    void readLine(trimmed, ctx(), classify).then((state) => {
      if (state.status === "unmatched") return;
      setLines((current) => current.map((line) => (line.id === id ? { ...line, state } : line)));
    });
  };
  const remove = (id: number) => setLines((current) => current.filter((line) => line.id !== id));
  const setLimit = (id: number, limit: Limit) =>
    setLines((current) => current.map((line) => (line.id === id ? { ...line, state: { status: "limit", limit } } : line)));
  const starterPack = (replacing?: number) => {
    if (replacing !== undefined) remove(replacing);
    for (const text of STARTER_PACK_LINES) add(text);
  };

  const limits = lines.flatMap((line) => (line.state?.status === "limit" ? [line.state.limit] : []));
  const { draft, missing, problems } = draftFrom(limits);
  const unsettled = lines.some((line) => line.state?.status !== "limit");
  const ready = !unsettled && problems.length === 0 && missing.length === 0;

  return (
    <section aria-label="Describe the job">
      <h2>What may the agent do?</h2>
      <label>
        One limit per line, then Enter
        <input
          value={typed}
          placeholder="two sends max"
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            add(typed);
            setTyped("");
          }}
        />
      </label>
      <button type="button" onClick={() => starterPack()}>
        Starter pack: one recipient, 2 sends, ends tonight, template only, ask before custom wording
      </button>
      <ul aria-label="Limits">
        {lines.map((line) => {
          const chip = line.state ? chipFor(line.state, timeZone) : null;
          return (
            <li key={line.id} aria-label={line.text}>
              <q>{line.text}</q>{" "}
              {chip ? (
                <>
                  <strong data-tone={chip.tone}>{chip.text}</strong>
                  {chip.label ? <em> {chip.label}</em> : null} <span>{chip.detail}</span>{" "}
                  <DetailForm
                    line={line}
                    contacts={contacts}
                    setLimit={(limit) => setLimit(line.id, limit)}
                    starterPack={() => starterPack(line.id)}
                    parse={(text) => parseLine(text, ctx())}
                  />
                </>
              ) : (
                <span>Reading the line…</span>
              )}{" "}
              <button type="button" aria-label={`Remove "${line.text}"`} onClick={() => remove(line.id)}>
                Remove
              </button>
            </li>
          );
        })}
      </ul>
      {problems.map((problem) => (
        <p key={problem} role="alert">
          {problem}
        </p>
      ))}
      {missing.length > 0 ? <p>Still needed: {missing.map((field) => MISSING_LABELS[field]).join(", ")}.</p> : null}
      <button
        type="button"
        disabled={!ready}
        onClick={() => {
          const { recipient, maxSends, expiresAt } = draft;
          if (ready && recipient !== undefined && maxSends !== undefined && expiresAt !== undefined) {
            onUse({ ...draft, recipient, maxSends, expiresAt });
          }
        }}
      >
        Use these limits
      </button>
      <p>Nothing is allowed yet. You confirm the whole job on the next screen.</p>
    </section>
  );
}
