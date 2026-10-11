import assert from "node:assert/strict";
import { test } from "node:test";

import { readConfig, redactMcpUrl } from "../dist/index.js";

const SECRET = "A".repeat(43);

test("a secret-path URL is the secret_path credential; /mcp is bearer", () => {
  const secret = readConfig({ SPEEDWRIT_MCP_URL: `https://speedwrit.test/mcp/c/${SECRET}`, XAI_API_KEY: "k" }, "/home/o");
  assert.equal(secret.ok, true);
  assert.equal(secret.config.credential, "secret_path");
  assert.equal(secret.config.origin, "https://speedwrit.test");
  assert.equal(secret.config.model, "grok-4.7");
  assert.equal(secret.config.tokenFile, "/home/o/.config/grokbot/tokens.json");
  const bearer = readConfig({ SPEEDWRIT_MCP_URL: "https://speedwrit.test/mcp" }, "/home/o");
  assert.equal(bearer.config.credential, "bearer");
  assert.equal(bearer.config.xaiApiKey, null);
});

test("refused: no URL, plain http off loopback, other paths, queries, bad options", () => {
  const problems = (env) => {
    const read = readConfig(env, "/h");
    assert.equal(read.ok, false);
    return read.problems.map((p) => p.name);
  };
  assert.deepEqual(problems({}), ["SPEEDWRIT_MCP_URL"]);
  assert.deepEqual(problems({ SPEEDWRIT_MCP_URL: "http://speedwrit.test/mcp" }), ["SPEEDWRIT_MCP_URL"]);
  assert.deepEqual(problems({ SPEEDWRIT_MCP_URL: "https://speedwrit.test/api" }), ["SPEEDWRIT_MCP_URL"]);
  assert.deepEqual(problems({ SPEEDWRIT_MCP_URL: `https://speedwrit.test/mcp/c/${SECRET}x` }), ["SPEEDWRIT_MCP_URL"]);
  assert.deepEqual(problems({ SPEEDWRIT_MCP_URL: "https://speedwrit.test/mcp?x=1" }), ["SPEEDWRIT_MCP_URL"]);
  assert.deepEqual(problems({ SPEEDWRIT_MCP_URL: "https://speedwrit.test/mcp", GROKBOT_XAI_AUTH_STYLE: "basic" }), ["GROKBOT_XAI_AUTH_STYLE"]);
  assert.deepEqual(problems({ SPEEDWRIT_MCP_URL: "https://speedwrit.test/mcp", GROKBOT_TIMEOUT_MS: "5" }), ["GROKBOT_TIMEOUT_MS"]);
  assert.deepEqual(problems({ SPEEDWRIT_MCP_URL: "https://speedwrit.test/mcp", XAI_BASE_URL: "http://api.x.ai/v1" }), ["XAI_BASE_URL"]);
  assert.equal(readConfig({ SPEEDWRIT_MCP_URL: "http://127.0.0.1:8080/mcp" }, "/h").ok, true);
});

test("the secret never prints", () => {
  assert.equal(redactMcpUrl(`https://speedwrit.test/mcp/c/${SECRET}`), "https://speedwrit.test/mcp/c/[redacted]");
  assert.equal(redactMcpUrl("https://speedwrit.test/mcp"), "https://speedwrit.test/mcp");
});
