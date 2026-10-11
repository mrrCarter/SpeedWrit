import test from "node:test";
import assert from "node:assert/strict";

import { holdReasonWords, listJobsToolResult, sendToolResult, statusToolResult } from "../../dist/mcp/results.js";
import { ASK_ME_REASONS, agentSentence } from "../../dist/contract/reasons.js";

const CTX = { recipient: "dana@test.example", maxSends: 2 };

const SENT = {
  status: "sent", sent: true, proposal_id: "prp_1", version: 1, version_sha256: "a".repeat(64),
  provider_message_id: "m1", receipt_id: "rcp_1", sends_left: 1,
};
const PENDING = { status: "pending_approval", sent: false, proposal_id: "prp_1", version: 2, review_reasons: ["custom_content"] };
const DENIED = { status: "denied", sent: false, approvable: false, reason_code: "recipient_not_in_job", receipt_id: "rcp_2" };
const UNKNOWN = { status: "unknown", sent: null, proposal_id: "prp_1", receipt_id: "rcp_3" };
const NOT_SENT = { status: "not_sent", sent: false, proposal_id: "prp_1", error_class: "http_429", receipt_id: "rcp_4" };

test("a sent result says so in the spec's words, with sent: true", () => {
  const r = sendToolResult(SENT, CTX);
  assert.equal(r.isError, false);
  assert.deepEqual(r.content, [{ type: "text", text: "Sent to dana@test.example. The provider accepted it. 1 of 2 sends left." }]);
  assert.equal(r.structuredContent.sent, true);
  assert.equal(r.structuredContent.provider_message_id, "m1");
});

test("a pending version names its version and why, and is not sent", () => {
  const r = sendToolResult(PENDING, CTX);
  assert.equal(r.isError, false);
  assert.equal(r.content[0].text, "Not sent yet. Version 2 is waiting for the owner's approval (custom wording).");
  assert.equal(r.structuredContent.sent, false);
});

test("a denial is an error result, says it cannot be approved, and carries approvable: false", () => {
  const r = sendToolResult(DENIED, CTX);
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, agentSentence("recipient_not_in_job"));
  assert.match(r.content[0].text, /cannot be approved/);
  assert.equal(r.structuredContent.approvable, false);
});

test("an unknown outcome says do not resend, with sent: null", () => {
  const r = sendToolResult(UNKNOWN, CTX);
  assert.equal(r.isError, false);
  assert.equal(r.content[0].text, "Outcome unknown. The provider did not confirm. Do not resend. The owner will check.");
  assert.equal(r.structuredContent.sent, null);
});

test("a provider refusal is an error result that says nothing was sent", () => {
  const r = sendToolResult(NOT_SENT, CTX);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /nothing was sent/);
});

test("sent: true appears only for a send the provider accepted", () => {
  for (const send of [PENDING, DENIED, UNKNOWN, NOT_SENT]) {
    const r = sendToolResult(send, CTX);
    assert.notEqual(r.structuredContent.sent, true, send.status);
    assert.doesNotMatch(r.content[0].text, /^Sent /, send.status);
  }
});

test("hold reasons read as plain words, never the review vendor or model", () => {
  for (const reason of ASK_ME_REASONS) {
    const words = holdReasonWords(reason);
    assert.ok(words.length > 0, reason);
    assert.doesNotMatch(words, /typesafe|jev|ai_review|_/i, reason);
  }
  const both = sendToolResult({ ...PENDING, review_reasons: ["custom_content", "mentions_other_client"] }, CTX);
  assert.equal(both.content[0].text, "Not sent yet. Version 2 is waiting for the owner's approval (custom wording, it names another client).");
});

test("get_status and list_jobs carry the facts in structured content", () => {
  const status = statusToolResult({ proposal_id: "prp_1", status: "accepted", version: 2, version_sha256: "b".repeat(64), provider_message_id: "m2" });
  assert.equal(status.content[0].text, "Proposal prp_1, version 2: sent; the provider accepted it.");
  assert.equal(status.structuredContent.provider_message_id, "m2");
  const none = listJobsToolResult([]);
  assert.equal(none.content[0].text, "No active jobs. Ask the owner to confirm one.");
  const one = listJobsToolResult([{ job_id: "job_1", purpose: "Tuesday recap to Dana", recipient: "dana@test.example", template_fields: {}, allow_custom_with_approval: true, sends_left: 2, expires_at: "2026-10-12T06:59:00Z" }]);
  assert.match(one.content[0].text, /^1 active job: job_1 \(Tuesday recap to Dana; to dana@test.example; 2 sends left\)\.$/);
  assert.equal(one.structuredContent.jobs.length, 1);
});
