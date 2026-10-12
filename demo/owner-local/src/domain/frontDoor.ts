// The type-a-sentence front door: one limit per line, the same phrasings the real owner app accepts
// (packages/job-send-ui/src/lib/frontDoor.ts). "ask me before custom wording" is what turns custom text
// into a hold; without it, custom wording is refused.

import type { Contact } from "./types";

export const MAX_SENDS_LIMIT = 10;
export const STARTER_LINES = ["only email Dana", "two sends max", "expires tonight", "ask me before custom wording"] as const;

export type Limit =
  | { kind: "recipient"; email: string; label: string }
  | { kind: "count"; maxSends: number }
  | { kind: "expiry"; expiresAt: number }
  | { kind: "approval" }
  | { kind: "builtin"; what: string };

export type LineState = { status: "limit"; limit: Limit } | { status: "needs_detail"; why: string } | { status: "unmatched" };

const NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const NUMBER = "(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)";
const MESSAGES = "(?:sends?|emails?|e-mails?|messages?)";
const COUNT = [
  new RegExp(`\\b${NUMBER}\\s+${MESSAGES}\\s+(?:max|maximum|at\\s+most|tops)\\b`, "i"),
  new RegExp(`\\b(?:max|maximum|at\\s+most|up\\s+to|no\\s+more\\s+than|only)\\s+(?:of\\s+)?${NUMBER}\\s+${MESSAGES}\\b`, "i"),
];
const RECIPIENT = /^(?:only|just)\s+(?:email|e-mail|mail|message|contact|send\s+to|write\s+to)\s+(.+?)\s*[.!]?$/i;
const TONIGHT = /\b(?:expires?|ends?|until|till|good\s+until|valid\s+until)\s+tonight\b|^tonight$/i;
const UNTIL_TIME = /\b(?:expires?\s+at|ends?\s+at|until|till|by)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i;
const APPROVAL = /\b(?:ask|check\s+with)\s+(?:me\s+)?(?:first\s+)?before\b.*\b(?:custom|own|different|new|other)\s+(?:wording|words|text|messages?|emails?)\b/i;
const BUILTIN = /\b(?:no|never|don'?t\s+(?:add|include|put|send|use))\s+(?:any\s+)?(links?|urls?|attachments?|html|cc|bcc)\b/i;

/** Wall-clock hh:mm today in Pacific time, as an instant (the demo's clock is PT). */
function todayAtPT(now: number, hour: number, minute: number): number {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
  // PDT in October: UTC-7.
  return Date.parse(`${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00-07:00`);
}

export function parseLine(line: string, contacts: readonly Contact[], now: number): LineState {
  const text = line.trim();
  if (!text) return { status: "unmatched" };
  const found: LineState[] = [];

  const only = RECIPIENT.exec(text);
  if (only) {
    const target = (only[1] ?? "").toLowerCase();
    const match = contacts.filter((c) => [c.name, c.company, c.email, `${c.name} at ${c.company}`].some((v) => v.toLowerCase() === target || v.toLowerCase().split(" ")[0] === target));
    found.push(
      match.length === 1 && match[0]
        ? { status: "limit", limit: { kind: "recipient", email: match[0].email, label: `${match[0].name} (${match[0].company}) <${match[0].email}>` } }
        : { status: "needs_detail", why: match.length > 1 ? "More than one contact matches. Pick one." : "No contact matches that. Pick one." },
    );
  }
  const count = COUNT.map((re) => re.exec(text)).find((m) => m !== null);
  if (count) {
    const raw = (count[1] ?? "").toLowerCase();
    const n = NUMBERS[raw] ?? Number(raw);
    found.push(Number.isInteger(n) && n >= 1 && n <= MAX_SENDS_LIMIT ? { status: "limit", limit: { kind: "count", maxSends: n } } : { status: "needs_detail", why: `A job allows 1 to ${MAX_SENDS_LIMIT} sends.` });
  }
  if (TONIGHT.test(text)) found.push({ status: "limit", limit: { kind: "expiry", expiresAt: todayAtPT(now, 23, 59) } });
  else {
    const until = UNTIL_TIME.exec(text);
    if (until) {
      let hour = Number(until[1]);
      const minute = Number(until[2] ?? "0");
      const pm = (until[3] ?? "").toLowerCase() === "pm";
      if (hour === 12) hour = pm ? 12 : 0;
      else if (pm) hour += 12;
      const at = todayAtPT(now, hour, minute);
      found.push(at > now ? { status: "limit", limit: { kind: "expiry", expiresAt: at } } : { status: "needs_detail", why: "That time has already passed today." });
    }
  }
  if (APPROVAL.test(text)) found.push({ status: "limit", limit: { kind: "approval" } });
  const builtin = BUILTIN.exec(text);
  if (builtin) found.push({ status: "limit", limit: { kind: "builtin", what: (builtin[1] ?? "").toLowerCase() } });

  if (found.length > 1) return { status: "needs_detail", why: "One limit per line. Split this into separate lines." };
  return found[0] ?? { status: "unmatched" };
}

export interface Draft {
  recipient?: string;
  recipientLabel?: string;
  maxSends?: number;
  expiresAt?: number;
  allowCustom: boolean;
}

/** Folds the lines into one draft: the smallest send count and the earliest expiry win; one recipient. */
export function draftFrom(states: readonly LineState[]): { draft: Draft; missing: string[]; problems: string[] } {
  const draft: Draft = { allowCustom: false };
  const problems: string[] = [];
  for (const st of states) {
    if (st.status === "needs_detail") problems.push(st.why);
    if (st.status !== "limit") continue;
    const l = st.limit;
    if (l.kind === "recipient") {
      if (draft.recipient && draft.recipient !== l.email) problems.push("A job has one recipient.");
      draft.recipient = l.email;
      draft.recipientLabel = l.label;
    } else if (l.kind === "count") draft.maxSends = Math.min(draft.maxSends ?? l.maxSends, l.maxSends);
    else if (l.kind === "expiry") draft.expiresAt = Math.min(draft.expiresAt ?? l.expiresAt, l.expiresAt);
    else if (l.kind === "approval") draft.allowCustom = true;
  }
  const missing = [!draft.recipient && "who it may email", !draft.maxSends && "how many sends", !draft.expiresAt && "when it expires"].filter(Boolean) as string[];
  return { draft, missing, problems };
}
