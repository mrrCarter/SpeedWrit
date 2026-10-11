// The gate's content checks (spec: "The gate"), as a pure function. The database steps that come
// before them (token authentication, record_attempt, find_job, rate_limited, job status, expiry,
// dispatch_enabled) and after them (AI review, store_version, dispatch) live with the gate's
// wiring. Here: the recipient, the early send-limit answer, field rules, custom wording, and the
// "mentions another client" hold, in the spec's order. The first failure wins, and a denial names
// only the rule that fired.

import type { AskMeReason, NeverReason } from "../contract/reasons.js";
import type { Job, ProposeSendCall } from "../contract/types.js";
import { normalizeAddress } from "../executor/render/address.js";

export const CUSTOM_SUBJECT_MAX = 150;
export const CUSTOM_BODY_MAX = 5000;

export type GateDenial = { ok: false; reason: NeverReason; field?: string };

export type GatePass = {
  ok: true;
  /** The normalized recipient: the job's recipient, exactly. */
  to: string;
  mode: "template" | "custom";
  fields: Record<string, string> | null;
  subject: string | null;
  body: string | null;
  /** Agent-written text the AI review and the other-client check read. */
  freeText: string;
  /** The ask-me reasons so far; the wiring may add AI-review reasons. Empty means auto-send. */
  reasons: AskMeReason[];
};

export type GateCheckContext = {
  /** The job's sends_reserved, read with the job (an early answer; dispatch re-checks under lock). */
  sendsReserved: number;
  /** The labels of the owner's other clients (names only), for mentions_other_client. */
  otherClientLabels: readonly string[];
};

/**
 * Exactly one dot-atom addr-spec, lowercased; null for anything else (spec A3). The one normalizer
 * the gate and the renderer share (executor/render/address.ts): raw printable ASCII is checked
 * BEFORE any trimming or lowercasing, so CR, LF, a BOM, U+2028 or the Kelvin sign never
 * normalizes into a match.
 */
export const normalizeRecipient = normalizeAddress;

// Characters agent-written text may not hold, by whole Unicode category: controls (Cc; a newline
// is allowed where the rule allows more than one line), format characters (Cf: zero-width spaces
// and joiners, soft hyphens, direction marks and overrides, the BOM), private use (Co),
// unassigned (Cn), lone surrogates (Cs), and line and paragraph separators (Zl, Zp). A category,
// not a list: one invisible character inside a word could otherwise hide a client name or a link.
export const FORBIDDEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Cs}\p{Zl}\p{Zp}]/u;
// Read after NFKC normalization, so fullwidth and other compatibility forms of "://" and "www."
// are caught too.
const URL_LIKE = /:\/\/|www\./i;

function textProblem(value: unknown, max: number, singleLine: boolean): boolean {
  if (typeof value !== "string") return true;
  const text = value.replace(/\r\n/g, "\n");
  if (text.length > max) return true;
  if (singleLine && text.includes("\n")) return true;
  if (FORBIDDEN_CHARACTERS.test(singleLine ? text : text.replace(/\n/g, ""))) return true;
  return URL_LIKE.test(text.normalize("NFKC"));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Between a label's words: any run of non-letters and non-digits, or nothing, so "Beta  Labs", "Beta-Labs",
// "Beta_Labs", a line break and "BetaLabs" all name "Beta Labs". Matching more can only add a hold.
const BETWEEN_WORDS = "[^\\p{L}\\p{N}]*";

/**
 * Whether `text` names any label, ignoring case, after NFKC normalization of both: the label's words in order, as
 * whole words at the ends, with any separator (or none) between them.
 */
export function mentionsAny(text: string, labels: readonly string[]): boolean {
  const haystack = text.normalize("NFKC");
  return labels.some((label) => {
    const words = label.normalize("NFKC").split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);
    if (words.length === 0) return false;
    const name = words.map(escapeRegExp).join(BETWEEN_WORDS);
    return new RegExp(`(^|[^\\p{L}\\p{N}])${name}($|[^\\p{L}\\p{N}])`, "iu").test(haystack);
  });
}

const deny = (reason: NeverReason, field?: string): GateDenial => (field ? { ok: false, reason, field } : { ok: false, reason });

const CALL_KEYS = new Set(["job_id", "to", "fields", "custom_subject", "custom_body", "operation_id"]);

/** The gate's content checks for one call against its job. Pure: same inputs, same answer. */
export function checkCall(job: Job, call: ProposeSendCall, ctx: GateCheckContext): GateDenial | GatePass {
  // The tool schema already rejects unknown properties (cc, bcc, headers); this holds even if a
  // caller skips the schema.
  const extra = Object.keys(call).find((key) => !CALL_KEYS.has(key));
  if (extra !== undefined) return deny("field_not_allowed", extra);

  // One normalizer on both sides, the one the renderer uses, so the gate and render can never
  // disagree about whether this is the job's recipient.
  const to = normalizeRecipient(call.to);
  if (!to) return deny("recipient_invalid");
  const expected = normalizeRecipient(job.recipient);
  if (!expected || to !== expected) return deny("recipient_not_in_job");
  if (ctx.sendsReserved >= job.max_sends) return deny("limit_reached");

  const reasons: AskMeReason[] = [];
  const hasCustom = call.custom_subject !== undefined || call.custom_body !== undefined;
  // null reads as absent, as the renderer reads it.
  const callFields = call.fields === null ? undefined : call.fields;

  if (callFields !== undefined) {
    if (hasCustom) return deny("field_not_allowed");
    if (typeof callFields !== "object" || Array.isArray(callFields)) return deny("field_not_allowed");
    for (const name of Object.keys(callFields)) {
      if (!Object.prototype.hasOwnProperty.call(job.field_rules, name)) return deny("field_not_allowed", name);
    }
    for (const [name, rule] of Object.entries(job.field_rules)) {
      const value = callFields[name];
      // An empty string is missing, as the renderer treats it.
      if (value === undefined || value === "") {
        if (rule.required) return deny("field_invalid", name);
        continue;
      }
      if (textProblem(value, rule.max, rule.single_line === true)) return deny("field_invalid", name);
    }
    const values = Object.values(callFields).filter((value): value is string => typeof value === "string");
    const freeText = Object.entries(job.field_rules)
      .filter(([name, rule]) => rule.free_text && typeof callFields[name] === "string")
      .map(([name]) => callFields[name] as string)
      .join("\n");
    // Every agent-written value is read for other clients, not only the free-text fields: a name
    // field can carry one too. This can only add a hold.
    if (mentionsAny(values.join("\n"), ctx.otherClientLabels)) reasons.push("mentions_other_client");
    return { ok: true, to, mode: "template", fields: { ...callFields }, subject: null, body: null, freeText, reasons };
  }

  if (!job.allow_custom_with_approval) return deny("custom_not_allowed");
  if (textProblem(call.custom_subject, CUSTOM_SUBJECT_MAX, true)) return deny("field_invalid", "custom_subject");
  if (textProblem(call.custom_body, CUSTOM_BODY_MAX, false)) return deny("field_invalid", "custom_body");
  const subject = call.custom_subject as string;
  const body = (call.custom_body as string).replace(/\r\n/g, "\n");
  reasons.push("custom_content");
  // The spec's free text for custom wording is the body; the subject is checked for other clients
  // too, which can only add a hold.
  if (mentionsAny(`${subject}\n${body}`, ctx.otherClientLabels)) reasons.push("mentions_other_client");
  return { ok: true, to, mode: "custom", fields: null, subject, body, freeText: body, reasons };
}
