import assert from "node:assert/strict";
import test from "node:test";

import { GMAIL_SEND_URL, GMAIL_TIMEOUT_MS, GMAIL_TOKEN_TIMEOUT_MS, PROVIDER_TIMEOUT_MS, createGmailProvider, gmailRaw } from "../dist/index.js";
import { TOKEN_FETCH_TIMEOUT_MS } from "../dist/server/index.js";

// No network: every test injects fetch.
const MIME = new TextEncoder().encode("From: owner@example.com\r\nTo: dana@test.example\r\nSubject: Hi\r\n\r\nSGk=\r\n");
const TOKEN = "ya29.a0-secret-access-token";

/**
 * `promise`, or a rejection after `ms`: a regression that hangs fails here instead of being
 * cancelled. The timer is ref'd, so the event loop can't drain first.
 */
const within = (promise, ms = 2_000) => {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still waiting after ${ms} ms`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
};

function fakeFetch(respond) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return respond(url, init);
  };
  return { fetch, calls };
}

const provider = (respond, options = {}) => {
  const fake = fakeFetch(respond);
  return { fake, gmail: createGmailProvider({ accessToken: async () => TOKEN, fetch: fake.fetch, ...options }) };
};

test("gmail: one POST of {raw: base64url(bytes)} with the bearer token; 2xx with an id is accepted", async () => {
  const { fake, gmail } = provider(() => new Response(JSON.stringify({ id: "18c2f0a1b2c3d4e5", threadId: "t1", labelIds: ["SENT"] }), { status: 200 }));
  const outcome = await gmail.send(MIME);
  assert.deepEqual(outcome, { status: "accepted", providerMessageId: "18c2f0a1b2c3d4e5" });
  assert.equal(fake.calls.length, 1);
  const [{ url, init }] = fake.calls;
  assert.equal(url, GMAIL_SEND_URL);
  assert.equal(GMAIL_SEND_URL, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.equal(init.redirect, "error");
  assert.ok(init.signal instanceof AbortSignal);
  const body = JSON.parse(init.body);
  assert.deepEqual(Object.keys(body), ["raw"]);
  assert.equal(body.raw, gmailRaw(MIME));
  assert.match(body.raw, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(new Uint8Array(Buffer.from(body.raw, "base64url")), MIME);
  assert.equal(GMAIL_TIMEOUT_MS, 20_000);
});

test("gmail: 400, 401, 403 and 429 are NOT SENT", async () => {
  for (const status of [400, 401, 403, 429]) {
    const { fake, gmail } = provider(() => new Response(JSON.stringify({ error: { message: "nope" } }), { status }));
    assert.deepEqual(await gmail.send(MIME), { status: "not_sent", errorClass: `http_${status}` });
    assert.equal(fake.calls.length, 1, "no retry");
  }
});

test("gmail: 5xx, other statuses and 2xx without an id are UNKNOWN", async () => {
  for (const status of [500, 502, 503, 504, 404, 409, 302]) {
    const { fake, gmail } = provider(() => new Response("x", { status }));
    assert.deepEqual(await gmail.send(MIME), { status: "unknown", errorClass: `http_${status}` }, String(status));
    assert.equal(fake.calls.length, 1, "no retry");
  }
  for (const body of ["{}", '{"id":""}', '{"id":7}', "not json", ""]) {
    const { gmail } = provider(() => new Response(body, { status: 200 }));
    assert.deepEqual(await gmail.send(MIME), { status: "unknown", errorClass: "accepted_without_id" }, body);
  }
});

test("gmail: a network error or a reset is UNKNOWN; so is the timeout", async () => {
  const reset = provider(() => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
  });
  assert.deepEqual(await reset.gmail.send(MIME), { status: "unknown", errorClass: "network" });
  assert.equal(reset.fake.calls.length, 1);

  const slow = provider(
    (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      }),
    { timeoutMs: 50 },
  );
  // AbortSignal.timeout does not hold the event loop open, and this fake holds no socket that would.
  const keepAlive = setInterval(() => undefined, 1000);
  const started = Date.now();
  try {
    assert.deepEqual(await slow.gmail.send(MIME), { status: "unknown", errorClass: "timeout" });
  } finally {
    clearInterval(keepAlive);
  }
  assert.ok(Date.now() - started < 5000);
  assert.equal(slow.fake.calls.length, 1);
});

test("gmail: no access token means NOT SENT provider_auth and no request at all", async () => {
  for (const accessToken of [async () => Promise.reject(new Error("invalid_grant")), async () => "", async () => undefined]) {
    const fake = fakeFetch(() => new Response("{}", { status: 200 }));
    const gmail = createGmailProvider({ accessToken, fetch: fake.fetch });
    assert.deepEqual(await gmail.send(MIME), { status: "not_sent", errorClass: "provider_auth" });
    assert.equal(fake.calls.length, 0);
  }
});

test("gmail: an access token that doesn't come in time is NOT SENT, and no request is made", { timeout: 5_000 }, async () => {
  const fake = fakeFetch(() => new Response(JSON.stringify({ id: "m1" }), { status: 200 }));
  const gmail = createGmailProvider({ accessToken: () => new Promise(() => {}), fetch: fake.fetch, tokenTimeoutMs: 30 });
  assert.deepEqual(await within(gmail.send(MIME)), { status: "not_sent", errorClass: "provider_auth" });
  assert.equal(fake.calls.length, 0);
  // The budgets nest: Google's token call ends inside the token's budget, and the token's ends
  // inside the executor's budget for the whole call (whose timeout is UNKNOWN).
  assert.ok(TOKEN_FETCH_TIMEOUT_MS < GMAIL_TOKEN_TIMEOUT_MS, "Google's token call ends inside the token budget");
  assert.ok(GMAIL_TOKEN_TIMEOUT_MS < PROVIDER_TIMEOUT_MS, "the token budget ends before the executor calls the send UNKNOWN");
});

test("gmail: the token never appears in an outcome", async () => {
  for (const status of [200, 401, 503]) {
    const { gmail } = provider(() => new Response(JSON.stringify({ id: status === 200 ? "m1" : undefined, echo: TOKEN }), { status }));
    assert.ok(!JSON.stringify(await gmail.send(MIME)).includes(TOKEN));
  }
  const { gmail } = provider(() => {
    throw new Error(`failed with ${TOKEN}`);
  });
  assert.ok(!JSON.stringify(await gmail.send(MIME)).includes(TOKEN));
  await assert.rejects(gmail.send("not bytes"), TypeError);
});
