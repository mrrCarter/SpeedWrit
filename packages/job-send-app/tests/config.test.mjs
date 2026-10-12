import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";

import { ConfigError, loadConfig } from "../dist/config.mjs";

// Generated here, so no key-shaped text sits in the repository.
const SIGNING_KEY = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const CUSTODY = randomBytes(32).toString("base64");
const CLIENT_SECRET = `client-secret-${randomBytes(6).toString("hex")}`;

const ENV = {
  HOST: "https://jobs.example.test",
  DATABASE_URL: "postgres://jobsend@db.example.test:5432/jobsend",
  GOOGLE_CLIENT_ID: "client-id.apps.example.test",
  GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
  RECEIPT_SIGNING_KEY: SIGNING_KEY,
  CUSTODY_KEY: CUSTODY,
  OWNER_APP_DIR: "/srv/owner-app",
};

function problemsOf(env) {
  try {
    loadConfig(env);
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    return error;
  }
  assert.fail("expected a ConfigError");
}

test("a complete environment loads, with safe defaults for the optional parts", () => {
  const config = loadConfig(ENV);
  assert.equal(config.host, "https://jobs.example.test");
  assert.equal(config.port, 8080);
  assert.equal(config.secretPathFallback, false, "the fallback is off unless asked for");
  assert.equal(config.accessLog, true);
  assert.equal(config.demoRecipients, null);
  assert.deepEqual(config.redirectFallbacks, []);
  assert.equal(config.aiReviewKey, null);
  assert.equal(config.defaultTemplateId, null);
  const full = loadConfig({
    ...ENV,
    PORT: "9443",
    SECRET_PATH_FALLBACK: "on",
    ACCESS_LOG: "off",
    DEMO_RECIPIENTS: "dana@test.example, bo@test.example",
    REDIRECT_FALLBACKS: "http://localhost:6274/oauth/callback, https://claude.ai/api/mcp/auth_callback",
    DEFAULT_TEMPLATE_ID: "tpl_recap",
  });
  assert.equal(full.port, 9443);
  assert.equal(full.secretPathFallback, true);
  assert.equal(full.accessLog, false);
  assert.equal(full.demoRecipients, "dana@test.example, bo@test.example", "passed as set to the executor's one parser");
  assert.deepEqual(full.redirectFallbacks, ["http://localhost:6274/oauth/callback", "https://claude.ai/api/mcp/auth_callback"]);
  assert.equal(full.defaultTemplateId, "tpl_recap");
});

test("every missing required variable is named at once", () => {
  const error = problemsOf({});
  assert.deepEqual(
    error.problems.map((p) => p.name),
    ["HOST", "DATABASE_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "RECEIPT_SIGNING_KEY", "CUSTODY_KEY", "OWNER_APP_DIR"],
  );
  assert.ok(error.problems.every((p) => p.problem === "is required"));
  assert.equal(problemsOf({ ...ENV, HOST: "   " }).problems[0].name, "HOST", "blank is missing");
});

test("malformed values are named, and no value ever appears in the error", () => {
  const bad = {
    ...ENV,
    HOST: "http://jobs.example.test/",
    PORT: "80800",
    DATABASE_URL: "mysql://root:hunter2@db/x",
    RECEIPT_SIGNING_KEY: "not-a-pem-signing-key-value",
    CUSTODY_KEY: randomBytes(16).toString("base64"),
    SECRET_PATH_FALLBACK: "yes",
    ACCESS_LOG: "true",
    REDIRECT_FALLBACKS: "javascript:alert(1)",
  };
  const error = problemsOf(bad);
  assert.deepEqual(
    error.problems.map((p) => p.name),
    ["HOST", "PORT", "DATABASE_URL", "RECEIPT_SIGNING_KEY", "CUSTODY_KEY", "REDIRECT_FALLBACKS", "SECRET_PATH_FALLBACK", "ACCESS_LOG"],
  );
  for (const value of [bad.DATABASE_URL, "hunter2", bad.RECEIPT_SIGNING_KEY, bad.CUSTODY_KEY, CLIENT_SECRET, bad.REDIRECT_FALLBACKS]) {
    assert.equal(error.message.includes(value), false, "a value leaked into the message");
    assert.equal(JSON.stringify(error.problems).includes(value), false, "a value leaked into the problems");
  }
});

test("HOST must be exactly an https origin", () => {
  for (const host of ["https://jobs.example.test/", "https://jobs.example.test/app", "http://jobs.example.test", "https://Jobs.example.test", "jobs.example.test"]) {
    assert.equal(problemsOf({ ...ENV, HOST: host }).problems[0].name, "HOST", host);
  }
  assert.equal(loadConfig({ ...ENV, HOST: "https://127.0.0.1:18443" }).host, "https://127.0.0.1:18443");
});

test("Dial is private, disabled by default, and requires explicit complete live configuration", () => {
  const defaults = loadConfig(ENV);
  assert.deepEqual(defaults.dial, { apiKey: null, fromNumber: null, ownerId: null, phone: null, live: false });
  assert.equal(defaults.aiReviewModel, "jev-1.13.0");
  const fields = { DIAL_API_KEY: "test-private-key", DIAL_FROM_NUMBER: "test-source", ALERT_OWNER_ID: "own_test", OWNER_ALERT_PHONE: "+14155550123" };
  assert.equal(loadConfig({ ...ENV, ...fields }).dial.live, false);
  assert.equal(loadConfig({ ...ENV, ...fields, DIAL_LIVE: "1" }).dial.live, true);
  assert.deepEqual(problemsOf({ ...ENV, DIAL_LIVE: "1" }).problems.map(p => p.name), Object.keys(fields));
  assert.equal(problemsOf({ ...ENV, DIAL_LIVE: "true" }).problems[0].name, "DIAL_LIVE");
  const bad = { ...ENV, ...fields, OWNER_ALERT_PHONE: "private-invalid-number", AI_REVIEW_MODEL: "private invalid model" };
  const error = problemsOf(bad);
  for (const value of Object.values(fields).concat(bad.OWNER_ALERT_PHONE, bad.AI_REVIEW_MODEL)) {
    assert.equal(error.message.includes(value), false);
  }
});
