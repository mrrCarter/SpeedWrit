import test from "node:test";
import assert from "node:assert/strict";

import {
  agentSentence,
  ASK_ME_BASE_REASONS,
  ASK_ME_REASONS,
  DISPATCH_REFUSALS,
  FLAGS,
  NEVER_REASONS,
  RECEIPT_TYPES,
  reasonClass,
} from "../../dist/index.js";

const ASK_ME = [...ASK_ME_BASE_REASONS, ...FLAGS.map((flag) => `ai_review:${flag}`), "ai_review_unavailable"];

test("the never class is exactly the spec's eleven hard denials, plus revise's not_revisable", () => {
  assert.deepEqual([...NEVER_REASONS].sort(), [
    "custom_not_allowed",
    "dispatch_stopped",
    "field_invalid",
    "field_not_allowed",
    "job_expired",
    "job_inactive",
    "job_not_found",
    "limit_reached",
    "not_revisable",
    "rate_limited",
    "recipient_invalid",
    "recipient_not_in_job",
  ]);
  for (const reason of NEVER_REASONS) assert.equal(reasonClass(reason), "never", reason);
});

test("custom wording, another client's name and every AI-review reason ask the owner", () => {
  for (const reason of ASK_ME) assert.equal(reasonClass(reason), "ask_me", reason);
});

test("every reason has the spec's fixed sentence, and a denial names no other detail", () => {
  assert.equal(
    agentSentence("recipient_not_in_job"),
    "Not sent. This job may only email its one recipient. This cannot be approved. The owner would need a separate job.",
  );
  assert.equal(agentSentence("custom_content"), "Not sent yet. This version needs the owner's approval.");
  assert.equal(agentSentence("ai_review:commitment"), "Not sent yet. Held for the owner's review.");
  for (const reason of [...NEVER_REASONS, ...ASK_ME]) {
    const sentence = agentSentence(reason);
    assert.ok(sentence && sentence.endsWith("."), reason);
    assert.doesNotMatch(sentence, /@|typesafe|jev/i, `${reason}: no address or vendor in what the agent is told`);
  }
});

test("receipt types and dispatch refusals are the spec's lists", () => {
  assert.equal(RECEIPT_TYPES.length, 21);
  assert.equal(new Set(RECEIPT_TYPES).size, 21);
  for (const refusal of ["superseded", "policy_changed", "integrity", "needs_review", "hash_mismatch", "not_pending"]) {
    assert.ok(DISPATCH_REFUSALS.includes(refusal), refusal);
  }
});

// Reasons reach reasonClass from the database and from JSON at runtime. Anything that is not an
// exact, allow-listed ask-me reason must be "never": not approvable.
const NOT_ASK_ME = [
  "superseded",
  "integrity",
  "hash_mismatch",
  "policy_changed",
  "ai_review:nonsense",
  "ai_review:",
  "Recipient_not_in_job",
  "recipient_not_in_job ",
  "Custom_content",
  "custom_content ",
  "",
  null,
  undefined,
  42,
];

for (const input of NOT_ASK_ME) {
  test(`reasonClass(${JSON.stringify(input) ?? String(input)}) fails closed to never`, () => {
    assert.equal(reasonClass(input), "never");
    assert.doesNotMatch(agentSentence(input), /approval|review/i, "no sentence suggests an approval");
  });
}

test("the ask-me side is exactly the allow-list: 2 base reasons, one per AI-review flag, and unavailable", () => {
  assert.deepEqual([...ASK_ME_REASONS].sort(), [...ASK_ME].sort());
  assert.equal(ASK_ME_REASONS.length, 2 + FLAGS.length + 1);
});
