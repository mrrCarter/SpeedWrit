import assert from "node:assert/strict";
import { test } from "node:test";

import { buildResponsesRequest, createResponse, DEMO_PROMPTS, formatExchange, mcpTool, parseResponse, SPEEDWRIT_TOOLS, summarizeOutput, XaiError, converse } from "../dist/index.js";

const SECRET_URL = `https://speedwrit.test/mcp/c/${"S".repeat(43)}`;

test("a secret-path tool carries no authorization; the four tools only; never require_approval", () => {
  const tool = mcpTool(SECRET_URL, null, "bearer");
  assert.deepEqual(tool, {
    type: "mcp",
    server_url: SECRET_URL,
    server_label: "speedwrit",
    server_description: tool.server_description,
    allowed_tools: ["list_jobs", "propose_send", "revise_proposal", "get_status"],
  });
  assert.equal("authorization" in tool, false);
  assert.equal("require_approval" in tool, false);
});

test("a bearer goes in as 'Bearer <token>' by default, or bare when the style is raw", () => {
  assert.equal(mcpTool("https://speedwrit.test/mcp", "tok", "bearer").authorization, "Bearer tok");
  assert.equal(mcpTool("https://speedwrit.test/mcp", "tok", "raw").authorization, "tok");
});

test("the request puts grokbot's instruction first, then the turns, and stores nothing at xAI", () => {
  const request = buildResponsesRequest({ model: "grok-4.7", turns: [{ role: "user", content: "hi" }], tool: mcpTool(SECRET_URL, null, "bearer") });
  assert.equal(request.model, "grok-4.7");
  assert.equal(request.store, false);
  assert.equal(request.input[0].role, "system");
  assert.match(request.input[0].content, /Only a result with status "sent" means the email went out/);
  assert.deepEqual(request.input[1], { role: "user", content: "hi" });
  assert.equal(request.tools.length, 1);
});

test("parseResponse reads the answer text, the MCP calls and the listed tools", () => {
  const parsed = parseResponse({
    id: "resp_1",
    output: [
      { type: "mcp_list_tools", server_label: "speedwrit", tools: SPEEDWRIT_TOOLS.map((name) => ({ name })) },
      { type: "mcp_call", server_label: "speedwrit", name: "propose_send", arguments: '{"job_id":"job_1","to":"bo@birch.test"}', output: '{"status":"denied","reason_code":"recipient_not_in_job"}', error: null, status: "completed" },
      { type: "mcp_call", server_label: "speedwrit", name: "get_status", arguments: "not json", output: null, error: { message: "boom" } },
      { type: "reasoning", summary: [] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Bo is not in this job." }] },
    ],
  });
  assert.equal(parsed.id, "resp_1");
  assert.equal(parsed.text, "Bo is not in this job.");
  assert.deepEqual(parsed.listedTools, [...SPEEDWRIT_TOOLS]);
  assert.deepEqual(parsed.calls[0], { name: "propose_send", arguments: { job_id: "job_1", to: "bo@birch.test" }, output: '{"status":"denied","reason_code":"recipient_not_in_job"}', error: null, status: "completed" });
  assert.deepEqual(parsed.calls[1], { name: "get_status", arguments: "not json", output: null, error: "boom", status: null });
});

test("parseResponse never throws on shapes it does not know", () => {
  for (const body of [null, 7, "x", [], {}, { output: "x" }, { output: [null, 1, { type: "message", content: "x" }] }]) {
    const parsed = parseResponse(body);
    assert.equal(parsed.calls.length, 0);
  }
  assert.equal(parseResponse({ output: [], output_text: "fallback" }).text, "fallback");
});

test("createResponse posts to /responses with the xAI key, and a failure names the status without the key", async () => {
  const seen = [];
  const fetchOk = async (url, init) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ id: "r", output: [{ type: "message", content: [{ type: "output_text", text: "ok" }] }] }), { status: 200 });
  };
  const request = buildResponsesRequest({ model: "grok-4.7", turns: [], tool: mcpTool(SECRET_URL, null, "bearer") });
  const parsed = await createResponse(fetchOk, { baseUrl: "https://api.x.ai/v1", apiKey: "xai-secret", request, timeoutMs: 5000 });
  assert.equal(parsed.text, "ok");
  assert.equal(seen[0].url, "https://api.x.ai/v1/responses");
  assert.equal(seen[0].init.headers.authorization, "Bearer xai-secret");
  assert.deepEqual(JSON.parse(seen[0].init.body), request);

  const fetchBad = async () => new Response(JSON.stringify({ error: { message: "Incorrect API key" } }), { status: 401 });
  await assert.rejects(createResponse(fetchBad, { baseUrl: "https://api.x.ai/v1", apiKey: "xai-secret", request, timeoutMs: 5000 }), (error) => {
    assert.ok(error instanceof XaiError);
    assert.equal(error.status, 401);
    assert.match(error.message, /Incorrect API key/);
    assert.doesNotMatch(error.message, /xai-secret/);
    return true;
  });
});

test("the demo is the spec's six prompts, sent as one conversation with the earlier turns", async () => {
  assert.equal(DEMO_PROMPTS.length, 6);
  assert.match(DEMO_PROMPTS[2], /Bo at Birch/);
  const requests = [];
  let tools = 0;
  const exchanges = await converse(DEMO_PROMPTS.slice(0, 3), {
    model: "grok-4.7",
    tool: async () => {
      tools += 1;
      return mcpTool(SECRET_URL, null, "bearer");
    },
    send: async (request) => {
      requests.push(structuredClone(request));
      return { id: null, text: `answer ${requests.length}`, calls: [], listedTools: null };
    },
  });
  assert.equal(exchanges.length, 3);
  assert.equal(tools, 3, "the tool is rebuilt per call, so a bearer can refresh between turns");
  assert.deepEqual(requests[2].input.slice(1).map((turn) => turn.role), ["user", "assistant", "user", "assistant", "user"]);
  assert.equal(requests[2].input[4].content, "answer 2");
});

test("an exchange prints each call's status, and a bare text result is shortened", () => {
  const text = formatExchange({ prompt: "p", response: { id: null, text: "done", listedTools: null, calls: [{ name: "propose_send", arguments: { to: "dana@acme.test" }, output: '{"status":"sent","sends_left":1,"receipt_id":"rcp_1"}', error: null, status: "completed" }] } }, 1);
  assert.match(text, /\[2\] you: p/);
  assert.match(text, /speedwrit\.propose_send/);
  assert.match(text, /status="sent" sends_left=1 receipt_id="rcp_1"/);
  assert.equal(summarizeOutput("Sent to dana.   1 of 2 left."), "Sent to dana. 1 of 2 left.");
});
