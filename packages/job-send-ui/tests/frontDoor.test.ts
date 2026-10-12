import {
  chipFor,
  classifyLine,
  draftFrom,
  LINE_KIND_OPTIONS,
  nextSendPhrase,
  parseLine,
  readLine,
  wallTimeToInstant,
  LINKS_RULE,
  type Classify,
  type Contact,
  type LineState,
  type ParseContext,
} from "../src/lib/frontDoor";
import { SAY } from "../src/lib/copy";

const CONTACTS: Contact[] = [
  { name: "Dana Ruiz", company: "Acme", email: "dana@acme.com" },
  { name: "Dana Lee", company: "Beta Labs", email: "dana.lee@beta.io" },
  { name: "Sam Ortiz", company: "Acme", email: "sam@acme.com" },
];
// 09:00 in San Francisco on the event day.
const CTX: ParseContext = { contacts: CONTACTS, timeZone: "America/Los_Angeles", now: new Date("2026-10-11T16:00:00Z") };

const limitOf = (state: LineState) => (state.status === "limit" ? state.limit : null);
const chipText = (line: string) => {
  const state = parseLine(line, CTX);
  if (state.status === "unmatched") throw new Error(`unmatched: ${line}`);
  return chipFor(state, CTX.timeZone).text;
};

describe("parseLine: the spec's table, row by row", () => {
  it("'only email Dana at Acme' resolves against contacts to one recipient: Never anyone else", () => {
    expect(limitOf(parseLine("only email Dana at Acme", CTX))).toEqual({
      kind: "recipient",
      email: "dana@acme.com",
      label: "Dana Ruiz (Acme) <dana@acme.com>",
    });
    expect(chipText("only email Dana at Acme")).toBe("Never: anyone else");
  });

  it("two matches ask which one, and no match needs one detail", () => {
    const twoDanas = [...CONTACTS, { name: "Dana Park", company: "Acme", email: "dpark@acme.com" }];
    const state = parseLine("only email Dana at Acme", { ...CTX, contacts: twoDanas });
    expect(state.status).toBe("choose");
    expect(state.status === "choose" && state.matches.map((contact) => contact.email)).toEqual(["dana@acme.com", "dpark@acme.com"]);
    expect(parseLine("only email Priya at Acme", CTX)).toMatchObject({ status: "needs_detail", kind: "recipient" });
    // An address must be a contact too: the job's recipient is someone the owner knows.
    expect(parseLine("only email stranger@evil.example", CTX)).toMatchObject({ status: "needs_detail", kind: "recipient" });
    expect(limitOf(parseLine("only send to SAM@acme.com", CTX))).toMatchObject({ email: "sam@acme.com" });
  });

  it("'two sends max' is max_sends 2: Never a third send", () => {
    expect(limitOf(parseLine("two sends max", CTX))).toEqual({ kind: "count", maxSends: 2 });
    expect(chipText("two sends max")).toBe("Never: a third send");
    expect(limitOf(parseLine("no more than 3 emails", CTX))).toEqual({ kind: "count", maxSends: 3 });
    expect(parseLine("11 sends max", CTX)).toMatchObject({ status: "needs_detail", kind: "count" });
    expect(parseLine("0 sends max", CTX)).toMatchObject({ status: "needs_detail", kind: "count" });
  });

  it.each(["3.5 sends max", ".3 sends max", "1,000 sends max", "1/3 sends max", "-3 sends max", "+3 sends max", "3 sends max or 5", "3 sends max and two sends max", "three sends max except on Friday"])("does not truncate a count or discard a contradictory suffix in %j", (text) => {
    expect(parseLine(text, CTX)).not.toMatchObject({ status: "limit" });
  });

  it.each(["three sends max", "3 sends max.", "no more than 3 emails!"])("still accepts the complete count phrase %j", (text) => {
    expect(limitOf(parseLine(text, CTX))).toEqual({ kind: "count", maxSends: 3 });
  });

  it("'expires tonight' and 'until 6pm' are computed in the owner's time zone: Never after that", () => {
    expect(limitOf(parseLine("expires tonight", CTX))).toEqual({ kind: "expiry", expiresAt: "2026-10-12T06:59:00.000Z" });
    expect(limitOf(parseLine("until 6pm", CTX))).toEqual({ kind: "expiry", expiresAt: "2026-10-12T01:00:00.000Z" });
    expect(limitOf(parseLine("until 18:30", CTX))).toEqual({ kind: "expiry", expiresAt: "2026-10-12T01:30:00.000Z" });
    expect(chipText("expires tonight")).toBe("Never: after that");
  });

  it.each(["until 5pm tomorrow", "until 5pm except Friday", "do not expire tonight", "expires tonight unless I say otherwise", "until 5pm or 6pm"])("does not discard an expiry condition or negation in %j", (text) => {
    expect(parseLine(text, CTX)).toMatchObject({ status: "needs_detail", kind: "expiry" });
  });

  it.each(["tonight", "expires tonight", "ends tonight!", "until tonight", "till tonight", "good until tonight", "valid until tonight."])("preserves the complete tonight phrase %j", (text) => {
    expect(limitOf(parseLine(text, CTX))).toEqual({ kind: "expiry", expiresAt: "2026-10-12T06:59:00.000Z" });
  });

  it.each(["until 5pm", "until 5 p.m.", "expires at 5pm.", "ends at 5pm", "till 5pm!", "by 17:00"])("preserves the complete time phrase %j", (text) => {
    expect(limitOf(parseLine(text, CTX))).toEqual({ kind: "expiry", expiresAt: "2026-10-12T00:00:00.000Z" });
  });

  it("an hour without am or pm, a time already past, or a time that doesn't exist needs one detail", () => {
    // 10 is still ahead at 09:00 either way, so only the missing am/pm can send it back.
    expect(parseLine("until 10", CTX)).toMatchObject({ status: "needs_detail", kind: "expiry", why: "Morning or evening? Add am or pm." });
    expect(parseLine("until 8am", CTX)).toMatchObject({ status: "needs_detail", kind: "expiry", why: "That time has already passed today." });
    expect(parseLine("until 13pm", CTX)).toMatchObject({ status: "needs_detail", kind: "expiry" });
    expect(parseLine("until 6:75pm", CTX)).toMatchObject({ status: "needs_detail", kind: "expiry" });
  });

  it("'ask me before custom wording' is allow_custom_with_approval: Ask me", () => {
    expect(limitOf(parseLine("ask me before custom wording", CTX))).toEqual({ kind: "approval" });
    expect(chipText("ask me before custom wording")).toBe("Ask me");
  });

  it.each(["do not ask me before custom wording", "don't ask me before custom wording", "never check with me before custom wording", "ask me before custom wording unless I am away", "ask me before not custom wording"])("does not reverse approval wording or discard a condition in %j", (text) => {
    expect(parseLine(text, CTX)).not.toMatchObject({ status: "limit" });
  });

  it.each(["ask me before custom wording", "ask before custom wording!", "ask me first before any new messages", "check with me before writing different words."])("preserves supported approval wording %j", (text) => {
    expect(limitOf(parseLine(text, CTX))).toEqual({ kind: "approval" });
  });

  it("'no links' and 'no attachments' are already on for every job: Never", () => {
    expect(limitOf(parseLine("no links", CTX))).toEqual({ kind: "builtin", what: "links" });
    expect(limitOf(parseLine("no attachments", CTX))).toEqual({ kind: "builtin", what: "attachments" });
    expect(chipText("no links")).toBe("Never");
    // The chip is no stronger than the gate: "://" and "www." are refused, a bare domain is not.
    const links = parseLine("no links", CTX);
    expect(links.status === "limit" && chipFor(links).detail).toBe(LINKS_RULE);
    const attachments = parseLine("no attachments", CTX);
    expect(attachments.status === "limit" && chipFor(attachments).detail).toBe("No attachments: already on for every job");
  });

  it.each(["no links except for invoices", "do not say no links", "no attachments unless approved"])("does not discard a prohibition condition in %j", (text) => {
    expect(parseLine(text, CTX)).toMatchObject({ status: "needs_detail", kind: "content" });
  });

  it.each(["no more than 0.5 emails until tonight", "up to 1,000 messages until tonight", "only +3 messages until tonight", "up to 1/3 sends until 5pm", "until 5pm or until 4pm"])("does not salvage an expiry after an unsupported clause in %j", (text) => {
    expect(parseLine(text, CTX)).not.toMatchObject({ status: "limit" });
  });

  it("'don't sound rude' maps to an existing AI-review check: Ask me, labeled AI-reviewed, may miss", () => {
    const state = parseLine("don't sound rude", CTX);
    expect(limitOf(state)).toEqual({ kind: "ai_review", checks: ["hostile_tone"] });
    const chip = state.status === "limit" ? chipFor(state) : null;
    expect(chip).toMatchObject({ tone: "ask", text: "Ask me", label: SAY.aiReviewed });
  });

  it("'don't fuck my shit up' matches no pattern, and without a classifier it is vague: Needs one detail", async () => {
    expect(parseLine("don't fuck my shit up", CTX)).toEqual({ status: "unmatched" });
    const state = await readLine("don't fuck my shit up", CTX);
    expect(state).toMatchObject({ status: "needs_detail", kind: "vague" });
    expect(state.status === "needs_detail" && chipFor(state).text).toBe("Needs one detail");
  });

  it("a line holding two limits is sent back: one limit per line", () => {
    expect(parseLine("only email Dana at Acme, two sends max", CTX)).toMatchObject({ status: "needs_detail", kind: "vague" });
  });
});

describe("wallTimeToInstant", () => {
  it("uses the offset in force at that wall time, across the autumn DST change", () => {
    // New York falls back at 02:00 on 2026-11-01: 18:00 that day is EST (UTC-5), though midnight was EDT.
    expect(wallTimeToInstant({ year: 2026, month: 11, day: 1 }, 18, 0, "America/New_York").toISOString()).toBe("2026-11-01T23:00:00.000Z");
    expect(wallTimeToInstant({ year: 2026, month: 10, day: 31 }, 18, 0, "America/New_York").toISOString()).toBe("2026-10-31T22:00:00.000Z");
  });

  it("re-reads the offset when the first guess lands on the other side of the change", () => {
    // 04:00 EST on Nov 1 is 09:00Z; a guess made at 04:00Z still sees EDT and would answer 08:00Z.
    expect(wallTimeToInstant({ year: 2026, month: 11, day: 1 }, 4, 0, "America/New_York").toISOString()).toBe("2026-11-01T09:00:00.000Z");
    // Spring forward on Mar 8: 05:00 EDT is 09:00Z; a guess made at 05:00Z still sees EST and would answer 10:00Z.
    expect(wallTimeToInstant({ year: 2026, month: 3, day: 8 }, 5, 0, "America/New_York").toISOString()).toBe("2026-03-08T09:00:00.000Z");
  });
});

describe("classifyLine: only for unmatched lines, both option orders, agree and sure", () => {
  const answering = (a: [string, number], b: [string, number]) =>
    vi.fn<Classify>(async () => ({ answers: { a: { choice: a[0], confidence: a[1] }, b: { choice: b[0], confidence: b[1] } } }));

  it("asks both option orders in one request", async () => {
    const classify = answering(["vague", 0.9], ["vague", 0.9]);
    await classifyLine("keep it classy", classify);
    expect(classify).toHaveBeenCalledTimes(1);
    const { questions, state } = classify.mock.calls[0]![0];
    expect(state).toEqual({ line: "keep it classy" });
    expect(Object.keys(questions.a.criteria)).toEqual(Object.keys(LINE_KIND_OPTIONS));
    expect(Object.keys(questions.b.criteria)).toEqual(Object.keys(LINE_KIND_OPTIONS).reverse());
  });

  it("agreement at confidence 0.6 or more is the kind; disagreement, doubt, an unknown kind or an error is vague", async () => {
    expect(await classifyLine("x", answering(["count", 0.6], ["count", 0.9]))).toBe("count");
    expect(await classifyLine("x", answering(["count", 0.59], ["count", 0.9]))).toBe("vague");
    expect(await classifyLine("x", answering(["count", 0.9], ["expiry", 0.9]))).toBe("vague");
    expect(await classifyLine("x", answering(["toString", 0.9], ["toString", 0.9]))).toBe("vague");
    expect(await classifyLine("x", vi.fn<Classify>(async () => Promise.reject(new Error("down"))))).toBe("vague");
  });

  it("a classified line still needs one detail, and a line a pattern matched never reaches the classifier", async () => {
    const classify = answering(["count", 0.95], ["count", 0.95]);
    expect(await readLine("keep it to a couple", CTX, classify)).toEqual({ status: "needs_detail", kind: "count", why: "How many sends at most?" });
    classify.mockClear();
    await readLine("two sends max", CTX, classify);
    expect(classify).not.toHaveBeenCalled();
  });
});

describe("draftFrom", () => {
  it("the smallest count and the earliest expiry win; one recipient; nothing missing", () => {
    const { draft, missing, problems } = draftFrom([
      { kind: "recipient", email: "dana@acme.com", label: "Dana" },
      // The winners come FIRST, so "the last line wins" would pick 3 and 06:59.
      { kind: "count", maxSends: 2 },
      { kind: "count", maxSends: 3 },
      { kind: "expiry", expiresAt: "2026-10-12T01:00:00.000Z" },
      { kind: "expiry", expiresAt: "2026-10-12T06:59:00.000Z" },
      { kind: "approval" },
      { kind: "ai_review", checks: ["hostile_tone"] },
    ]);
    expect(draft).toEqual({
      recipient: "dana@acme.com",
      maxSends: 2,
      expiresAt: "2026-10-12T01:00:00.000Z",
      allowCustomWithApproval: true,
      aiReview: "all_free_text",
    });
    expect(missing).toEqual([]);
    expect(problems).toEqual([]);
  });

  it("two recipients are a problem, and an empty draft is missing all three required fields", () => {
    const two = draftFrom([
      { kind: "recipient", email: "dana@acme.com", label: "Dana" },
      { kind: "recipient", email: "sam@acme.com", label: "Sam" },
    ]);
    expect(two.problems).toHaveLength(1);
    expect(two.draft.recipient).toBeUndefined();
    expect(draftFrom([]).missing).toEqual(["recipient", "maxSends", "expiresAt"]);
  });
});

it("nextSendPhrase reads naturally", () => {
  expect([1, 2, 7, 10].map(nextSendPhrase)).toEqual(["a second send", "a third send", "an eighth send", "an eleventh send"]);
});
