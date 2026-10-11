import { SAY } from "./copy";
import { formatExpiry } from "./time";

/**
 * The type-a-sentence front door (spec: "Type-a-sentence front door (after Gate 3)"). The owner types one limit per
 * line. Code parses every value; the classifier only says what kind of line an unmatched one is. A line becomes a
 * Never or Ask me chip only after it parsed into a concrete check; anything else is "Needs one detail".
 */

export type Contact = { name: string; company?: string; email: string };

export type LineKind = "recipient" | "count" | "expiry" | "content" | "approval" | "vague";

/** The AI-review checks a content line can switch on (packages/job-send ai-review QUESTIONS); the review runs them all. */
export type AiCheck = "off_purpose" | "other_client" | "commitment" | "hostile_tone" | "asks_secrets" | "ai_instructions";

export const AI_CHECK_LABELS: Readonly<Record<AiCheck, string>> = {
  hostile_tone: "rude or hostile tone",
  commitment: "promises of a price, discount, refund or deadline",
  other_client: "mentions of another client",
  off_purpose: "text unrelated to the job",
  asks_secrets: "requests for a password, payment details or a login code",
  ai_instructions: "instructions written to an AI",
};

/** A concrete check a line parsed into. */
export type Limit =
  | { kind: "recipient"; email: string; label: string }
  | { kind: "count"; maxSends: number }
  | { kind: "expiry"; expiresAt: string }
  | { kind: "approval" }
  | { kind: "builtin"; what: string }
  | { kind: "ai_review"; checks: AiCheck[] };

export type LineState =
  | { status: "limit"; limit: Limit }
  /** Two or more contacts matched: the owner picks one. */
  | { status: "choose"; matches: Contact[] }
  | { status: "needs_detail"; kind: LineKind; why: string }
  /** No pattern matched; the classifier decides what kind of line it is. */
  | { status: "unmatched" };

export interface ParseContext {
  contacts: readonly Contact[];
  /** IANA zone the owner's times are in; the runtime's zone when absent. */
  timeZone?: string;
  now: Date;
}

export const MAX_SENDS_LIMIT = 10;

const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};
const NUMBER = "(\\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)";
const MESSAGES = "(?:sends?|emails?|e-mails?|messages?)";
const COUNT_PATTERNS = [
  new RegExp(`\\b${NUMBER}\\s+${MESSAGES}\\s+(?:max|maximum|at\\s+most|tops)\\b`, "i"),
  new RegExp(`\\b(?:max|maximum|at\\s+most|up\\s+to|no\\s+more\\s+than|only)\\s+(?:of\\s+)?${NUMBER}\\s+${MESSAGES}\\b`, "i"),
];
const RECIPIENT = /^(?:only|just)\s+(?:email|e-mail|mail|message|contact|send\s+to|write\s+to)\s+(.+?)\s*[.!]?$/i;
const TONIGHT = /\b(?:expires?|ends?|until|till|good\s+until|valid\s+until)\s+tonight\b|^tonight$/i;
const UNTIL_TIME = /\b(?:expires?\s+at|ends?\s+at|until|till|by)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?=\s*[.!]?$|\s)/i;
const APPROVAL = /\b(?:ask|check\s+with)\s+(?:me\s+)?(?:first\s+)?before\b.*\b(?:custom|own|different|new|other)\s+(?:wording|words|text|messages?|emails?)\b/i;
const BUILTIN = /\b(?:no|never|don'?t\s+(?:add|include|put|send|use))\s+(?:any\s+)?(links?|urls?|attachments?|html|cc|bcc)\b/i;
const CONTENT_CHECKS: ReadonlyArray<[AiCheck, RegExp]> = [
  ["hostile_tone", /\b(?:rude|rudely|rudeness|tone|polite|impolite|hostile|sarcastic|sarcasm|aggressive|snarky|condescending)\b/i],
  ["commitment", /\b(?:promise|promises|promising|discounts?|prices?|pricing|refunds?|deadlines?|contract\s+terms?)\b/i],
  ["other_client", /\b(?:other\s+clients?|another\s+client|competitors?|other\s+customers?)\b/i],
  ["off_purpose", /\b(?:off[- ]topic|on[- ]topic|unrelated|stick\s+to\s+the\s+(?:point|topic|purpose))\b/i],
  ["asks_secrets", /\b(?:passwords?|payment\s+details|card\s+numbers?|login\s+codes?|bank\s+details)\b/i],
  ["ai_instructions", /\b(?:prompt\s+injection|instructions\s+to\s+(?:an?\s+)?(?:ai|bot|assistant))\b/i],
];
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const words = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9@.'-]+/).filter(Boolean);
const hasAllWords = (haystack: string, needle: string): boolean => {
  const have = new Set(words(haystack));
  const want = words(needle);
  return want.length > 0 && want.every((word) => have.has(word));
};

function parseNumber(text: string): number {
  const lower = text.toLowerCase();
  return NUMBER_WORDS[lower] ?? Number.parseInt(lower, 10);
}

/** The contacts a recipient phrase names: an address, "Name at Company", or a name. */
export function matchContacts(target: string, contacts: readonly Contact[]): Contact[] {
  const phrase = target.trim().replace(/[.!]+$/, "");
  if (ADDRESS.test(phrase)) return contacts.filter((contact) => contact.email.toLowerCase() === phrase.toLowerCase());
  const split = /^(.+?)\s+(?:at|from)\s+(.+)$/i.exec(phrase);
  const person = split?.[1] ?? phrase;
  const company = split?.[2];
  return contacts.filter(
    (contact) => hasAllWords(contact.name, person) && (company === undefined || hasAllWords(contact.company ?? "", company)),
  );
}

function zoneOf(timeZone: string | undefined): string {
  return timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Wall-clock parts of `at` in `timeZone`. */
function wallParts(at: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** The instant a wall-clock time on the owner's calendar day falls on, across a DST change. */
export function wallTimeToInstant(date: { year: number; month: number; day: number }, hour: number, minute: number, timeZone?: string): Date {
  const zone = zoneOf(timeZone);
  const guess = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  const offsetAt = (at: number) => {
    const wall = wallParts(at, zone);
    const base = Math.floor(at / 1000) * 1000;
    return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - base;
  };
  const first = guess - offsetAt(guess);
  return new Date(guess - offsetAt(first));
}

function parseExpiry(line: string, ctx: ParseContext): LineState | null {
  const today = wallParts(ctx.now.getTime(), zoneOf(ctx.timeZone));
  let hour: number;
  let minute: number;
  if (TONIGHT.test(line)) {
    hour = 23;
    minute = 59;
  } else {
    const match = UNTIL_TIME.exec(line);
    if (!match) return null;
    hour = Number(match[1]);
    minute = match[2] === undefined ? 0 : Number(match[2]);
    const meridiem = match[3]?.toLowerCase().replace(/\./g, "");
    if (minute > 59) return { status: "needs_detail", kind: "expiry", why: "That time doesn't exist." };
    if (meridiem) {
      if (hour < 1 || hour > 12) return { status: "needs_detail", kind: "expiry", why: "That time doesn't exist." };
      hour = (hour % 12) + (meridiem === "pm" ? 12 : 0);
    } else if (hour < 13 || hour > 23) {
      return { status: "needs_detail", kind: "expiry", why: "Morning or evening? Add am or pm." };
    }
  }
  const at = wallTimeToInstant(today, hour, minute, ctx.timeZone);
  if (at.getTime() <= ctx.now.getTime()) {
    return { status: "needs_detail", kind: "expiry", why: "That time has already passed today." };
  }
  return { status: "limit", limit: { kind: "expiry", expiresAt: at.toISOString() } };
}

/**
 * The regular-expression step: every pattern runs on the line, and a line that matches more than one kind of limit
 * is sent back, because one line holds one limit. Returns "unmatched" when no pattern matched.
 */
export function parseLine(line: string, ctx: ParseContext): LineState {
  const text = line.trim();
  const found: LineState[] = [];

  const recipient = RECIPIENT.exec(text);
  if (recipient) {
    const matches = matchContacts(recipient[1] ?? "", ctx.contacts);
    const only = matches[0];
    if (matches.length === 1 && only) {
      const label = only.company ? `${only.name} (${only.company}) <${only.email}>` : `${only.name} <${only.email}>`;
      found.push({ status: "limit", limit: { kind: "recipient", email: only.email.toLowerCase(), label } });
    } else if (matches.length > 1) {
      found.push({ status: "choose", matches });
    } else {
      found.push({ status: "needs_detail", kind: "recipient", why: "No contact matches that. Pick one." });
    }
  }

  const count = COUNT_PATTERNS.map((pattern) => pattern.exec(text)).find((match) => match !== null);
  if (count) {
    const maxSends = parseNumber(count[1] ?? "");
    found.push(
      Number.isInteger(maxSends) && maxSends >= 1 && maxSends <= MAX_SENDS_LIMIT
        ? { status: "limit", limit: { kind: "count", maxSends } }
        : { status: "needs_detail", kind: "count", why: `A job allows 1 to ${MAX_SENDS_LIMIT} sends.` },
    );
  }

  const expiry = parseExpiry(text, ctx);
  if (expiry) found.push(expiry);

  if (APPROVAL.test(text)) found.push({ status: "limit", limit: { kind: "approval" } });

  const builtin = BUILTIN.exec(text);
  if (builtin) found.push({ status: "limit", limit: { kind: "builtin", what: (builtin[1] ?? "").toLowerCase() } });

  const checks = CONTENT_CHECKS.filter(([, pattern]) => pattern.test(text)).map(([check]) => check);
  if (checks.length > 0) found.push({ status: "limit", limit: { kind: "ai_review", checks } });

  if (found.length > 1) return { status: "needs_detail", kind: "vague", why: "One limit per line. Split this into separate lines." };
  return found[0] ?? { status: "unmatched" };
}

// ---- The classifier, for lines no pattern matched ------------------------------------------------------------------

export const LINE_KIND_OPTIONS: Readonly<Record<LineKind, string>> = {
  recipient: "Says who may or may not receive messages",
  count: "States a maximum number of messages",
  expiry: "States when the permission ends",
  content: "Restricts wording, tone, topics, links or attachments",
  approval: "Says the owner must be asked before something happens",
  vague: "Expresses a wish with no condition a program could check",
};

export type ChoiceQuestion = { type: "choice"; instructions: string; criteria: Record<string, string> };
export type ChoiceAnswer = { choice: string; confidence: number };
/** The server's thin wrapper over the AI-review endpoint, asked both option orders in one request. */
export type ClassifyRequest = { state: { line: string }; questions: { a: ChoiceQuestion; b: ChoiceQuestion } };
export type Classify = (request: ClassifyRequest) => Promise<{ answers: { a: ChoiceAnswer; b: ChoiceAnswer } }>;

export const MIN_CONFIDENCE = 0.6;

/** The kind of an unmatched line: both orders must agree with confidence >= 0.6, or it is vague. Errors are vague. */
export async function classifyLine(line: string, classify: Classify): Promise<LineKind> {
  const question = (criteria: Record<string, string>): ChoiceQuestion => ({
    type: "choice",
    instructions: "Which kind of limit does `line` express?",
    criteria,
  });
  const reversed = Object.fromEntries(Object.entries(LINE_KIND_OPTIONS).reverse());
  try {
    const { answers } = await classify({ state: { line }, questions: { a: question({ ...LINE_KIND_OPTIONS }), b: question(reversed) } });
    const agree = answers.a.choice === answers.b.choice;
    const sure = Math.min(answers.a.confidence, answers.b.confidence) >= MIN_CONFIDENCE;
    const known = Object.hasOwn(LINE_KIND_OPTIONS, answers.a.choice);
    return agree && sure && known ? (answers.a.choice as LineKind) : "vague";
  } catch {
    return "vague";
  }
}

const DETAIL_ASKS: Readonly<Record<LineKind, string>> = {
  recipient: "Who may receive it? Pick one contact.",
  count: "How many sends at most?",
  expiry: "When does the permission end?",
  content: "Which check should AI review run?",
  approval: "Ask you before what?",
  vague: "Nothing here a program could check.",
};

/** parseLine, then the classifier for an unmatched line. A classified line still needs one detail: only code makes a chip. */
export async function readLine(line: string, ctx: ParseContext, classify?: Classify): Promise<LineState> {
  const parsed = parseLine(line, ctx);
  if (parsed.status !== "unmatched") return parsed;
  const kind = classify ? await classifyLine(line, classify) : "vague";
  return { status: "needs_detail", kind, why: DETAIL_ASKS[kind] };
}

// ---- Chips and the job draft ---------------------------------------------------------------------------------------

const ORDINALS = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh"];

/** "a third send" for a limit of two. */
export function nextSendPhrase(maxSends: number): string {
  const word = ORDINALS[maxSends + 1] ?? `${maxSends + 1}th`;
  return `${/^[aeiou]/.test(word) ? "an" : "a"} ${word} send`;
}

export type ChipTone = "never" | "ask" | "detail";
export type Chip = { tone: ChipTone; text: string; detail: string; label?: string };

export const NEEDS_DETAIL = "Needs one detail";

/**
 * What every job already enforces, said no stronger than the gate enforces it. The gate refuses text holding "://" or
 * "www." (after NFKC), not a bare domain, so the links chip says exactly that (gate #507; widening is Carter's call).
 */
export const LINKS_RULE = "Links written with :// or www. are refused for every job. A bare domain such as example.com is not.";
const BUILTIN_DETAILS: Readonly<Record<string, string>> = {
  link: LINKS_RULE,
  links: LINKS_RULE,
  url: LINKS_RULE,
  urls: LINKS_RULE,
};

/** The chip a line shows on the job card. */
export function chipFor(state: Exclude<LineState, { status: "unmatched" }>, timeZone?: string): Chip {
  if (state.status === "choose") return { tone: "detail", text: NEEDS_DETAIL, detail: "More than one contact matches. Which one?" };
  if (state.status === "needs_detail") return { tone: "detail", text: NEEDS_DETAIL, detail: state.why };
  const { limit } = state;
  switch (limit.kind) {
    case "recipient":
      return { tone: "never", text: "Never: anyone else", detail: `Only ${limit.label}` };
    case "count":
      return { tone: "never", text: `Never: ${nextSendPhrase(limit.maxSends)}`, detail: `At most ${limit.maxSends} ${limit.maxSends === 1 ? "send" : "sends"}` };
    case "expiry": {
      const shown = formatExpiry(limit.expiresAt, timeZone);
      return { tone: "never", text: "Never: after that", detail: `Ends ${shown.local} (${shown.utc})` };
    }
    case "approval":
      return { tone: "ask", text: "Ask me", detail: "Before any wording outside the template" };
    case "builtin":
      return { tone: "never", text: "Never", detail: BUILTIN_DETAILS[limit.what] ?? `No ${limit.what}: already on for every job` };
    case "ai_review":
      return {
        tone: "ask",
        text: "Ask me",
        label: SAY.aiReviewed,
        detail: `AI review reads every message, including for ${limit.checks.map((check) => AI_CHECK_LABELS[check]).join("; ")}`,
      };
  }
}

/** The job fields the front door fills. The owner still confirms the whole job on the Confirm screen. */
export type FrontDoorDraft = {
  recipient?: string;
  maxSends?: number;
  expiresAt?: string;
  allowCustomWithApproval?: boolean;
  aiReview?: "all_free_text";
};

export type DraftResult = {
  draft: FrontDoorDraft;
  /** Required fields no line gave yet. */
  missing: Array<"recipient" | "maxSends" | "expiresAt">;
  /** Lines that contradict each other. */
  problems: string[];
};

/** Folds the parsed limits into one draft: the smallest send count and the earliest expiry win; a job has one recipient. */
export function draftFrom(limits: readonly Limit[]): DraftResult {
  const draft: FrontDoorDraft = {};
  const problems: string[] = [];
  const recipients = new Set<string>();
  for (const limit of limits) {
    if (limit.kind === "recipient") recipients.add(limit.email);
    if (limit.kind === "count") draft.maxSends = Math.min(draft.maxSends ?? limit.maxSends, limit.maxSends);
    if (limit.kind === "expiry" && (draft.expiresAt === undefined || limit.expiresAt < draft.expiresAt)) draft.expiresAt = limit.expiresAt;
    if (limit.kind === "approval") draft.allowCustomWithApproval = true;
    if (limit.kind === "ai_review") draft.aiReview = "all_free_text";
  }
  if (recipients.size > 1) problems.push("A job emails one person. Keep one recipient line.");
  else if (recipients.size === 1) draft.recipient = [...recipients][0];
  const missing: DraftResult["missing"] = [];
  if (recipients.size === 0) missing.push("recipient");
  if (draft.maxSends === undefined) missing.push("maxSends");
  if (draft.expiresAt === undefined) missing.push("expiresAt");
  return { draft, missing, problems };
}

/** The one-tap starter pack, as the lines an owner would type: 2 sends, expires tonight, ask before custom wording. */
export const STARTER_PACK_LINES = ["two sends max", "expires tonight", "ask me before custom wording"] as const;
