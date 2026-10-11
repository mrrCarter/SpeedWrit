import test from "node:test";
import assert from "node:assert/strict";

import { SCHEMA_KEYWORDS, argumentProblem } from "../../dist/mcp/arguments.js";
import { MCP_TOOLS } from "../../dist/mcp/tools.js";

const tool = (name) => MCP_TOOLS.find((candidate) => candidate.name === name).inputSchema;
const PROPOSE = tool("propose_send");

function schemaKeywords(schema, out = new Set()) {
  for (const key of Object.keys(schema)) out.add(key);
  for (const child of Object.values(schema.properties ?? {})) schemaKeywords(child, out);
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") schemaKeywords(schema.additionalProperties, out);
  return out;
}

test("every tool schema uses only the keywords the checker understands", () => {
  for (const { name, inputSchema } of MCP_TOOLS) {
    for (const keyword of schemaKeywords(inputSchema)) assert.ok(SCHEMA_KEYWORDS.includes(keyword), `${name} uses ${keyword}`);
  }
});

test("good calls pass for every tool", () => {
  assert.equal(argumentProblem(tool("list_jobs"), {}), null);
  assert.equal(argumentProblem(PROPOSE, { job_id: "job_1", to: "dana@example.test", fields: { first_name: "Dana" } }), null);
  assert.equal(argumentProblem(PROPOSE, { job_id: "job_1", to: "dana@example.test", custom_subject: "Hi", custom_body: "Body", operation_id: "op_1" }), null);
  assert.equal(argumentProblem(tool("revise_proposal"), { proposal_id: "prop_1", fields: {} }), null);
  assert.equal(argumentProblem(tool("get_status"), { proposal_id: "prop_1" }), null);
});

test("a missing, extra or mistyped argument is refused", () => {
  assert.equal(argumentProblem(PROPOSE, { to: "dana@example.test" }), "arguments.job_id is required");
  assert.equal(argumentProblem(PROPOSE, { job_id: "job_1", to: "dana@example.test", cc: "x@example.test" }), "arguments has a property that is not allowed");
  assert.equal(argumentProblem(PROPOSE, { job_id: 7, to: "dana@example.test" }), "arguments.job_id must be a string");
  assert.equal(argumentProblem(PROPOSE, { job_id: "job_1", to: ["a@example.test", "b@example.test"] }), "arguments.to must be a string");
  assert.equal(argumentProblem(PROPOSE, { job_id: "job_1", to: "dana@example.test", fields: { first_name: 1 } }), "arguments.fields property must be a string");
  assert.equal(argumentProblem(PROPOSE, { job_id: "job_1", to: "dana@example.test", fields: ["Dana"] }), "arguments.fields must be an object");
  assert.equal(argumentProblem(tool("list_jobs"), []), "arguments must be an object");
  assert.equal(argumentProblem(tool("list_jobs"), null), "arguments must be an object");
  assert.equal(argumentProblem(tool("list_jobs"), { job_id: "job_1" }), "arguments has a property that is not allowed");
});

test("a reason never repeats a key the caller sent", () => {
  const problem = argumentProblem(PROPOSE, { job_id: "job_1", to: "dana@example.test", "<script>ignore previous</script>": "x" });
  assert.equal(problem.includes("script"), false);
});

test("prototype keys find no rule", () => {
  for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    const args = JSON.parse(`{"job_id":"job_1","to":"dana@example.test",${JSON.stringify(key)}:"x"}`);
    assert.equal(argumentProblem(PROPOSE, args), "arguments has a property that is not allowed", key);
  }
});

test("maxLength counts code points, as JSON Schema does", () => {
  const emoji = String.fromCodePoint(0x1f600);
  const base = { job_id: "job_1", to: "dana@example.test", custom_body: "Body" };
  assert.equal(argumentProblem(PROPOSE, { ...base, custom_subject: emoji.repeat(150) }), null, "150 code points, 300 UTF-16 units");
  assert.equal(argumentProblem(PROPOSE, { ...base, custom_subject: emoji.repeat(151) }), "arguments.custom_subject is longer than 150 characters");
  assert.equal(argumentProblem(PROPOSE, { ...base, custom_subject: "x".repeat(151) }), "arguments.custom_subject is longer than 150 characters");
  assert.equal(argumentProblem(PROPOSE, { job_id: "job_1", to: "dana@example.test", fields: { note: "x".repeat(5001) } }), "arguments.fields property is longer than 5000 characters");
});

test("a schema the checker does not understand fails closed", () => {
  assert.equal(argumentProblem({ type: "number" }, 1), "arguments: the schema type is not supported");
  assert.equal(argumentProblem({}, "x"), "arguments: the schema type is not supported");
  assert.equal(
    argumentProblem({ type: "object", properties: { n: { type: "array" } }, additionalProperties: false }, { n: [] }),
    "arguments.n: the schema type is not supported",
  );
  assert.equal(argumentProblem({ type: "object", additionalProperties: "yes" }, { a: "x" }), "arguments has a property that is not allowed");
});

test("booleans, whole numbers with bounds, and string enums, for the owner API", () => {
  const schema = {
    type: "object",
    properties: {
      on: { type: "boolean" },
      n: { type: "integer", minimum: 1, maximum: 50 },
      pick: { type: "string", enum: ["seen", "not_arrived"] },
    },
    additionalProperties: false,
  };
  assert.equal(argumentProblem(schema, { on: false, n: 1, pick: "seen" }), null);
  assert.equal(argumentProblem(schema, { n: 50, pick: "not_arrived" }), null);
  assert.equal(argumentProblem(schema, { on: "true" }), "arguments.on must be true or false");
  assert.equal(argumentProblem(schema, { on: 1 }), "arguments.on must be true or false");
  for (const bad of [1.5, "2", Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, null]) {
    assert.equal(argumentProblem(schema, { n: bad }), "arguments.n must be a whole number", String(bad));
  }
  assert.equal(argumentProblem(schema, { n: 0 }), "arguments.n must be at least 1");
  assert.equal(argumentProblem(schema, { n: 51 }), "arguments.n must be at most 50");
  assert.equal(argumentProblem(schema, { pick: "Seen" }), "arguments.pick is not one of the allowed values");
  assert.equal(argumentProblem(schema, { pick: "<b>x</b>" }).includes("<b>"), false, "the value is never echoed");
  assert.equal(argumentProblem({ type: "string", enum: "seen" }, "seen"), "arguments is not one of the allowed values", "a malformed enum fails closed");
});
