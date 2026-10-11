import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DEFAULT_HOLD_AT, FLAGS } from "../../dist/ai-review/provider.js";
import { scoreCalibration, formatCalibrationReport } from "../../dist/ai-review/calibration.js";

const SET = JSON.parse(readFileSync(new URL("../../calibration/ai-review-set.json", import.meta.url), "utf8"));

test("the calibration set is 20 messages: 10 clean and 10 with one planted concern, every question covered", () => {
  assert.equal(SET.samples.length, 20);
  assert.equal(SET.samples.filter((s) => s.label === "clean").length, 10);
  for (const flag of FLAGS) assert.ok(SET.samples.some((s) => s.label === flag), `no sample planted with ${flag}`);
  for (const s of SET.samples) assert.ok(s.label === "clean" || FLAGS.includes(s.label), `${s.id}: unknown label`);
  assert.equal(new Set(SET.samples.map((s) => s.id)).size, 20, "ids are unique");
});

test("the set holds no addresses or links, and only other-client samples name another client", () => {
  const names = SET.other_clients.map((name) => name.toLowerCase());
  const mentionsOther = (text) => names.some((name) => new RegExp(`\\b${name}\\b`, "i").test(text));
  for (const s of SET.samples) {
    const text = `${s.subject} ${s.free_text}`;
    assert.doesNotMatch(text, /@|:\/\/|www\./i, `${s.id}: address or link`);
    assert.equal(mentionsOther(text), s.label === "other_client", `${s.id}: other-client mention`);
  }
  for (const name of SET.other_clients) assert.doesNotMatch(name, /@/, "other clients are names only");
});

// Scores for a run where every planted sample scores 9000 on its own question and 100 elsewhere,
// except where `tweak` says otherwise.
function syntheticResults(tweak = () => undefined) {
  return SET.samples.map((s) => {
    const probs = Object.fromEntries(FLAGS.map((f) => [f, s.label === f ? 9000 : 100]));
    tweak(s, probs);
    return { id: s.id, probs_bp: probs };
  });
}

test("a perfect run scores every planted sample a hit, no false holds, and finds a separating threshold", () => {
  const report = scoreCalibration(SET.samples, syntheticResults(), DEFAULT_HOLD_AT);
  assert.equal(report.n, 20);
  assert.equal(report.unavailable, 0);
  assert.equal(report.clean_held, 0);
  for (const q of report.questions) {
    assert.equal(q.misses, 0, q.flag);
    assert.equal(q.hits, q.planted, q.flag);
    assert.equal(q.false_holds, 0, q.flag);
    assert.ok(q.separating_bp > q.max_other_bp && q.separating_bp <= q.min_planted_bp, q.flag);
  }
});

test("a clean message scoring over a threshold is a false hold, and an overlap has no separating threshold", () => {
  const results = syntheticResults((s, probs) => {
    if (s.id === "clean-01-stage-recap") probs.commitment = 9500;
  });
  const report = scoreCalibration(SET.samples, results, DEFAULT_HOLD_AT);
  const commitment = report.questions.find((q) => q.flag === "commitment");
  assert.equal(commitment.false_holds, 1);
  assert.equal(commitment.separating_bp, null);
  assert.equal(report.clean_held, 1);
  assert.match(formatCalibrationReport(report), /\| commitment \| 3500 \| 2 \| 2 \| 0 \| 1 \| 9500 \| 9000 \| none \|/);
});

test("a planted sample under its threshold is a miss, and an unavailable review is counted, not scored", () => {
  const results = syntheticResults((s, probs) => {
    if (s.id === "asks-secrets-01") probs.asks_secrets = 1000;
  }).map((r) => (r.id === "clean-02" ? { id: r.id, probs_bp: null } : r));
  const report = scoreCalibration(SET.samples, results, DEFAULT_HOLD_AT);
  const secrets = report.questions.find((q) => q.flag === "asks_secrets");
  assert.deepEqual([secrets.planted, secrets.hits, secrets.misses], [2, 1, 1]);
  assert.equal(report.unavailable, 1);
  assert.equal(report.clean, 9);
  assert.match(formatCalibrationReport(report), /one run of our own labeled set \(n=20, unavailable 1\)/);
});
