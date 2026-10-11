import test from "node:test";
import assert from "node:assert/strict";

import { aiReview, reviewReasons, DEFAULT_HOLD_AT, FLAGS } from "../../dist/ai-review/provider.js";

const INPUT = {
  jobPurpose: "Send Dana at Acme a recap of Tuesday's call.",
  otherClients: ["Bo", "Birch Labs"],
  subject: "Recap: onboarding call",
  freeText: "We agreed to start the pilot Monday.",
};

// A fetch stub that records every call and answers with `respond(call)`.
function stubFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const call = { url, init, body: JSON.parse(init.body) };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetchImpl };
}

function answersWith(nouls, model = "jev-1.13") {
  const answers = Object.fromEntries(FLAGS.map((flag) => [flag, { type: "noul", noul: nouls[flag] ?? 0.01 }]));
  return new Response(JSON.stringify({ model, answers }), { status: 200, headers: { "Content-Type": "application/json" } });
}

const options = (fetchImpl, extra = {}) => ({ apiKey: "test-key", fetchImpl, ...extra });

test("a message under every threshold is clear, with probabilities as integer basis points", async () => {
  const { calls, fetchImpl } = stubFetch(() => answersWith({ commitment: 0.12345 }));
  const review = await aiReview(INPUT, options(fetchImpl));
  assert.equal(review.outcome, "clear");
  assert.deepEqual(review.flags, []);
  assert.equal(review.probs_bp.commitment, 1235);
  for (const flag of FLAGS) assert.ok(Number.isInteger(review.probs_bp[flag]), flag);
  assert.equal(calls.length, 1);
  assert.deepEqual(reviewReasons(review), []);
});

test("a score at or above a question's threshold holds, and only that question flags", async () => {
  const { fetchImpl } = stubFetch(() => answersWith({ commitment: DEFAULT_HOLD_AT.commitment, hostile_tone: 0.49 }));
  const review = await aiReview(INPUT, options(fetchImpl));
  assert.equal(review.outcome, "hold");
  assert.deepEqual(review.flags, ["commitment"]);
  assert.deepEqual(reviewReasons(review), ["ai_review:commitment"]);
});

test("the request carries only the purpose, other client names and the message, under a bearer key", async () => {
  const { calls, fetchImpl } = stubFetch(() => answersWith({}));
  await aiReview(INPUT, options(fetchImpl));
  const [call] = calls;
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers.Authorization, "Bearer test-key");
  assert.deepEqual(Object.keys(call.body).sort(), ["model", "questions", "state"]);
  assert.deepEqual(call.body.state, {
    job_purpose: INPUT.jobPurpose,
    other_clients: INPUT.otherClients,
    message: { subject: INPUT.subject, body: INPUT.freeText },
  });
  assert.deepEqual(Object.keys(call.body.questions).sort(), [...FLAGS].sort());
  assert.equal(call.body.model, "jev-1.13");
});

test("an email address among the other clients is refused before any request", async () => {
  const { calls, fetchImpl } = stubFetch(() => answersWith({}));
  const review = await aiReview({ ...INPUT, otherClients: ["Bo", "bo@birch.test"] }, options(fetchImpl));
  assert.deepEqual([review.outcome, review.error], ["unavailable", "input_contains_address"]);
  assert.equal(calls.length, 0);
  assert.deepEqual(reviewReasons(review), ["ai_review_unavailable"]);
});

test("with no key configured nothing is sent and the review is unavailable", async () => {
  const saved = process.env.TYPESAFE_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    const { calls, fetchImpl } = stubFetch(() => answersWith({}));
    const review = await aiReview(INPUT, { fetchImpl });
    assert.deepEqual([review.outcome, review.error], ["unavailable", "not_configured"]);
    assert.equal(calls.length, 0);
  } finally {
    if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
  }
});

for (const status of [401, 403, 422, 429, 500, 529]) {
  test(`HTTP ${status} is unavailable after exactly one attempt`, async () => {
    const { calls, fetchImpl } = stubFetch(() => new Response("{}", { status }));
    const review = await aiReview(INPUT, options(fetchImpl));
    assert.deepEqual([review.outcome, review.error], ["unavailable", `http_${status}`]);
    assert.equal(calls.length, 1);
  });
}

test("a missing, mistyped or out-of-range answer is unavailable, never a partial clear", async () => {
  const shapes = [
    { model: "x", answers: {} },
    { model: "x", answers: Object.fromEntries(FLAGS.map((f) => [f, { type: "choice", choice: "a" }])) },
    { model: "x", answers: Object.fromEntries(FLAGS.map((f) => [f, { type: "noul", noul: "0.9" }])) },
    { model: "x", answers: Object.fromEntries(FLAGS.map((f) => [f, { type: "noul", noul: 1.5 }])) },
    null,
  ];
  for (const shape of shapes) {
    const { fetchImpl } = stubFetch(() => new Response(JSON.stringify(shape), { status: 200 }));
    const review = await aiReview(INPUT, options(fetchImpl));
    assert.deepEqual([review.outcome, review.error], ["unavailable", "bad_shape"], JSON.stringify(shape));
  }
});

test("a reply slower than the budget is unavailable, with one attempt", async () => {
  const { calls, fetchImpl } = stubFetch(
    ({ init }) =>
      new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
  );
  const started = Date.now();
  const review = await aiReview(INPUT, options(fetchImpl, { budgetMs: 50 }));
  assert.deepEqual([review.outcome, review.error], ["unavailable", "timeout_or_network"]);
  assert.ok(Date.now() - started < 2000, "returned within the budget, not the default");
  assert.equal(calls.length, 1);
});

test("a network error is unavailable", async () => {
  const { fetchImpl } = stubFetch(() => {
    throw new TypeError("fetch failed");
  });
  const review = await aiReview(INPUT, options(fetchImpl));
  assert.deepEqual([review.outcome, review.error], ["unavailable", "timeout_or_network"]);
});

test("review reasons never name the vendor or the model", async () => {
  const { fetchImpl } = stubFetch(() => answersWith(Object.fromEntries(FLAGS.map((f) => [f, 0.99]))));
  const reasons = [
    ...reviewReasons(await aiReview(INPUT, options(fetchImpl))),
    ...reviewReasons({ outcome: "unavailable", error: "http_529", ms: 1 }),
  ];
  assert.equal(reasons.length, FLAGS.length + 1);
  for (const reason of reasons) assert.doesNotMatch(reason, /typesafe|jev|systemone/i);
});

test("a 200 reply that is not JSON is unavailable as bad_shape, not as a network failure", async () => {
  const { calls, fetchImpl } = stubFetch(() => new Response("<html>gateway</html>", { status: 200 }));
  const review = await aiReview(INPUT, options(fetchImpl));
  assert.deepEqual([review.outcome, review.error], ["unavailable", "bad_shape"]);
  assert.equal(calls.length, 1);
});

test("a body that stalls past the budget is a timeout, not bad_shape", async () => {
  // Headers arrive at once; the body never finishes until the budget's abort cancels it.
  const { fetchImpl } = stubFetch(({ init }) => {
    const body = new ReadableStream({
      start(controller) {
        init.signal.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
      },
    });
    return new Response(body, { status: 200 });
  });
  const review = await aiReview(INPUT, options(fetchImpl, { budgetMs: 50 }));
  assert.deepEqual([review.outcome, review.error], ["unavailable", "timeout_or_network"]);
});
