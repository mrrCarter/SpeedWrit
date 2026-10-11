import test from "node:test";
import assert from "node:assert/strict";

import { checkCall, mentionsAny, normalizeRecipient } from "../../dist/gate/checks.js";

// Special characters are built from code points, so no editor or tool can turn an escape into raw
// bytes in this file.
const ch = (cp) => String.fromCodePoint(cp);
const CR = ch(0x0d);
const LF = ch(0x0a);
const BOM = ch(0xfeff);
const LINE_SEP = ch(0x2028);
const KELVIN = ch(0x212a);
const RLO = ch(0x202e);
const NUL = ch(0x00);

const JOB = {
  v: 1,
  job_id: "job_1",
  policy_version: 1,
  owner: "own_1",
  connection: "con_1",
  agent_connection: "ac_1",
  provider: "gmail",
  sender: "owner@example.com",
  recipient: "dana@test.example",
  purpose: "Send Dana at Acme a recap of Tuesday's call.",
  template: { id: "tpl_recap", sha256: "0".repeat(64) },
  field_rules: {
    first_name: { max: 40, single_line: true, required: true },
    topic: { max: 80, single_line: true, required: true },
    recap: { max: 600, required: true, free_text: true },
  },
  max_sends: 2,
  expires_at: "2026-10-12T06:59:00Z",
  auto_send: true,
  allow_custom_with_approval: true,
  ai_review: "custom_only",
};
const CTX = { sendsReserved: 0, otherClientLabels: ["Bo", "Birch"] };
const FIELDS = { first_name: "Dana", topic: "onboarding call", recap: "We agreed to start the pilot Monday." };
const call = (extra = {}) => ({ job_id: "job_1", to: "dana@test.example", fields: { ...FIELDS }, ...extra });
const reasonOf = (result) => (result.ok ? "pass" : result.reason);

test("a template call inside the job passes with no reasons, so it can auto-send", () => {
  const result = checkCall(JOB, call(), CTX);
  assert.equal(result.ok, true);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.mode, "template");
  assert.equal(result.to, "dana@test.example");
  assert.equal(result.freeText, FIELDS.recap);
});

test("A2: another client in contacts is recipient_not_in_job", () => {
  assert.equal(reasonOf(checkCall(JOB, call({ to: "bo@birch.test" }), CTX)), "recipient_not_in_job");
});

test("A3: two addresses, a display name or a line break is recipient_invalid, checked before any trim", () => {
  const bad = [
    "dana@test.example, bo@birch.test",
    "dana@test.example;bo@birch.test",
    "Dana <dana@test.example>",
    `dana@test.example${CR}${LF}`,
    `${LF}dana@test.example`,
    `dana@test.example${LF}Bcc: x@y.test`,
    `${BOM}dana@test.example`,
    `dana@test.example${LINE_SEP}`,
    `dana@test.exampl${KELVIN}`.replace("exampl", "exampl"),
    `${KELVIN}ana@test.example`,
    "",
    "dana@test",
    "@test.example",
  ];
  for (const to of bad) assert.equal(reasonOf(checkCall(JOB, call({ to }), CTX)), "recipient_invalid", JSON.stringify(to));
  assert.equal(normalizeRecipient("  Dana@Test.Example  "), "dana@test.example", "spaces and case are fine");
});

test("A4: cc, bcc or any unknown argument is field_not_allowed, naming it", () => {
  for (const key of ["cc", "bcc", "headers", "from"]) {
    const result = checkCall(JOB, call({ [key]: "x@y.test" }), CTX);
    assert.deepEqual([result.ok, result.reason, result.field], [false, "field_not_allowed", key]);
  }
  const unknownField = checkCall(JOB, call({ fields: { ...FIELDS, promo: "x" } }), CTX);
  assert.deepEqual([unknownField.reason, unknownField.field], ["field_not_allowed", "promo"]);
  assert.equal(reasonOf(checkCall(JOB, call({ custom_body: "x" }), CTX)), "field_not_allowed", "fields and custom text together");
});

test("A5: a URL, an overlong value, a missing required field or a control character is field_invalid naming the field", () => {
  const cases = [
    [{ recap: "See https://example.test" }, "recap"],
    [{ recap: "See www.example.test for details" }, "recap"],
    [{ recap: "x".repeat(601) }, "recap"],
    [{ topic: `onboarding${LF}call` }, "topic"],
    [{ first_name: `Da${NUL}na` }, "first_name"],
    [{ recap: `ok ${RLO}txet` }, "recap"],
    [{ topic: undefined }, "topic"],
  ];
  for (const [patch, field] of cases) {
    const fields = { ...FIELDS, ...patch };
    for (const key of Object.keys(fields)) if (fields[key] === undefined) delete fields[key];
    const result = checkCall(JOB, call({ fields }), CTX);
    assert.deepEqual([result.reason, result.field], ["field_invalid", field], JSON.stringify(patch));
  }
  const multiline = checkCall(JOB, call({ fields: { ...FIELDS, recap: `Line one.${CR}${LF}Line two.` } }), CTX);
  assert.equal(multiline.ok, true, "a multi-line free-text field may hold newlines");
});

test("A6: custom wording passes the checks but holds with custom_content", () => {
  const result = checkCall(JOB, { job_id: "job_1", to: "dana@test.example", custom_subject: "Kickoff", custom_body: "Does Thursday at 2pm work?" }, CTX);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "custom");
  assert.deepEqual(result.reasons, ["custom_content"]);
});

test("custom wording is custom_not_allowed when the job allows only the template, and limits apply", () => {
  const strict = { ...JOB, allow_custom_with_approval: false };
  assert.equal(reasonOf(checkCall(strict, { job_id: "job_1", to: "dana@test.example", custom_subject: "x", custom_body: "y" }, CTX)), "custom_not_allowed");
  const base = { job_id: "job_1", to: "dana@test.example", custom_subject: "Kickoff", custom_body: "ok" };
  assert.deepEqual(checkCall(JOB, { ...base, custom_subject: "x".repeat(151) }, CTX).field, "custom_subject");
  assert.deepEqual(checkCall(JOB, { ...base, custom_subject: `two${LF}lines` }, CTX).field, "custom_subject");
  assert.deepEqual(checkCall(JOB, { ...base, custom_body: "x".repeat(5001) }, CTX).field, "custom_body");
  assert.deepEqual(checkCall(JOB, { ...base, custom_body: "see https://x.test" }, CTX).field, "custom_body");
  assert.deepEqual(checkCall(JOB, { job_id: "job_1", to: "dana@test.example" }, CTX).field, "custom_subject", "nothing to send");
});

test("naming another client holds with mentions_other_client, in fields, custom bodies and custom subjects", () => {
  assert.deepEqual(checkCall(JOB, call({ fields: { ...FIELDS, recap: "Same plan as Birch." } }), CTX).reasons, ["mentions_other_client"]);
  const custom = { job_id: "job_1", to: "dana@test.example", custom_subject: "Note from Bo's team", custom_body: "Hello." };
  assert.deepEqual(checkCall(JOB, custom, CTX).reasons, ["custom_content", "mentions_other_client"]);
  assert.equal(mentionsAny("Bobby and Birchwood are fine", ["Bo", "Birch"]), false, "whole words only");
  assert.equal(mentionsAny("thanks, BIRCH!", ["Birch"]), true, "case does not matter");
});

test("A10: at the send limit the answer is limit_reached before any content check", () => {
  assert.equal(reasonOf(checkCall(JOB, call({ fields: { recap: "www.x.test" } }), { ...CTX, sendsReserved: 2 })), "limit_reached");
});

test("the first failure wins: unknown arguments first (the schema step), then the recipient before any content", () => {
  assert.equal(reasonOf(checkCall(JOB, call({ to: "bo@birch.test", cc: "x@y.test" }), CTX)), "field_not_allowed");
  assert.equal(reasonOf(checkCall(JOB, call({ to: "bo@birch.test", fields: { recap: "https://x" } }), CTX)), "recipient_not_in_job");
});

// machine's HOLD on #507: invisible and compatibility characters must not hide a client name or a
// link. Every character below is built from its code point.
const INVISIBLE = [
  [0x00ad, "soft hyphen"],
  [0x200b, "zero-width space"],
  [0x200c, "zero-width non-joiner"],
  [0x200d, "zero-width joiner"],
  [0x200e, "left-to-right mark"],
  [0x200f, "right-to-left mark"],
  [0x2060, "word joiner"],
  [0x2061, "function application"],
  [0x2064, "invisible plus"],
  [0x061c, "arabic letter mark"],
  [0x180e, "mongolian vowel separator"],
  [0xfeff, "byte-order mark"],
  [0x202e, "right-to-left override"],
  [0x2066, "left-to-right isolate"],
  [0x2028, "line separator"],
  [0x2029, "paragraph separator"],
  [0xe000, "private use"],
  [0x0009, "tab"],
  [0x000d, "lone carriage return"],
  [0x0085, "next line (C1)"],
];

for (const [cp, name] of INVISIBLE) {
  test(`a ${name} (U+${cp.toString(16).toUpperCase().padStart(4, "0")}) in agent text is field_invalid`, () => {
    const hidden = `Bi${ch(cp)}rch`;
    const field = checkCall(JOB, call({ fields: { ...FIELDS, recap: `Same plan as ${hidden}.` } }), CTX);
    assert.deepEqual([field.reason, field.field], ["field_invalid", "recap"]);
    const custom = checkCall(JOB, { job_id: "job_1", to: "dana@test.example", custom_subject: "Note", custom_body: `Hi ${hidden}` }, CTX);
    assert.deepEqual([custom.reason, custom.field], ["field_invalid", "custom_body"]);
  });
}

test("an unassigned code point and a lone surrogate are field_invalid", () => {
  for (const bad of [ch(0x0378), String.fromCharCode(0xd800)]) {
    assert.equal(checkCall(JOB, call({ fields: { ...FIELDS, recap: `x${bad}y` } }), CTX).reason, "field_invalid");
  }
});

test("fullwidth and other compatibility forms of a link are caught after NFKC", () => {
  const fullwidth = (text) => [...text].map((c) => (c >= "!" && c <= "~" ? ch(c.codePointAt(0) + 0xfee0) : c)).join("");
  for (const link of [`${fullwidth("www.")}evil.test`, `https${fullwidth("://")}evil.test`]) {
    const result = checkCall(JOB, call({ fields: { ...FIELDS, recap: `See ${link}` } }), CTX);
    assert.deepEqual([result.reason, result.field], ["field_invalid", "recap"], link);
  }
});

test("a fullwidth client name still holds with mentions_other_client", () => {
  const name = [..."Birch"].map((c) => ch(c.codePointAt(0) + 0xfee0)).join("");
  assert.deepEqual(checkCall(JOB, call({ fields: { ...FIELDS, recap: `Same as ${name}.` } }), CTX).reasons, ["mentions_other_client"]);
});

test("ordinary accented and non-Latin letters are still allowed", () => {
  const text = `Thanks Jos${ch(0xe9)} and ${ch(0x5f20)}${ch(0x4f1f)} for the call.`;
  assert.equal(checkCall(JOB, call({ fields: { ...FIELDS, recap: text } }), CTX).ok, true);
});

// Bundle's review of #507: the gate must agree with the renderer, and every agent-written value
// is read for other clients.
test("a required field sent as an empty string is field_invalid, as the renderer treats it", () => {
  const result = checkCall(JOB, call({ fields: { ...FIELDS, topic: "" } }), CTX);
  assert.deepEqual([result.reason, result.field], ["field_invalid", "topic"]);
});

test("the job's recipient is normalized the same way as the call's, so case does not split them", () => {
  const mixed = { ...JOB, recipient: "Dana@Test.Example" };
  assert.equal(checkCall(mixed, call({ to: "dana@test.example" }), CTX).ok, true);
  assert.equal(checkCall(mixed, call({ to: "DANA@test.EXAMPLE" }), CTX).ok, true);
  const broken = { ...JOB, recipient: "not an address" };
  assert.equal(checkCall(broken, call(), CTX).reason, "recipient_not_in_job", "a job with no valid recipient sends nothing");
});

test("fields: null reads as absent, so custom wording goes down the custom path", () => {
  const result = checkCall(JOB, { job_id: "job_1", to: "dana@test.example", fields: null, custom_subject: "Kickoff", custom_body: "Thursday?" }, CTX);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "custom");
});

test("another client's name in a non-free-text field also holds", () => {
  assert.deepEqual(checkCall(JOB, call({ fields: { ...FIELDS, first_name: "Birch" } }), CTX).reasons, ["mentions_other_client"]);
});

test("a client name with a different separator, or none, between its words still holds", () => {
  const labels = ["Beta Labs"];
  for (const text of ["Unlike Beta Labs, we ship.", "Unlike Beta  Labs, we ship.", "Unlike Beta-Labs, we ship.", "Unlike Beta_Labs.", `Unlike Beta${LF}Labs.`, "Unlike BetaLabs.", "unlike BETA. labs"]) {
    assert.equal(mentionsAny(text, labels), true, JSON.stringify(text));
  }
  assert.equal(mentionsAny("Alphabeta Labs and Beta Labsworth", labels), false, "the ends are still whole words");
  assert.equal(mentionsAny("Beta Lab", labels), false, "every word must be there");
  // Text with punctuation: an empty pattern would match between "," and " ", so this pins the guard.
  assert.equal(mentionsAny("Thanks, see you Monday.", ["", " - "]), false, "a label with no letters or digits names nothing");
  // Through the gate: the stage job auto-sends a template recap, so this must hold, not send.
  assert.deepEqual(checkCall(JOB, call({ fields: { ...FIELDS, recap: "Same plan as Birch  Group." } }), { ...CTX, otherClientLabels: ["Birch Group"] }).reasons, ["mentions_other_client"]);
});
