import test from "node:test";
import assert from "node:assert/strict";

import { MCP_INSTRUCTIONS, MCP_SCOPE, MCP_TOOLS } from "../../dist/mcp/tools.js";
import { CUSTOM_BODY_MAX, CUSTOM_SUBJECT_MAX } from "../../dist/gate/checks.js";

const byName = Object.fromEntries(MCP_TOOLS.map((tool) => [tool.name, tool]));

test("the spec's four tools, and no others", () => {
  assert.deepEqual(MCP_TOOLS.map((tool) => tool.name).sort(), ["get_status", "list_jobs", "propose_send", "revise_proposal"]);
});

test("every input schema refuses unknown properties", () => {
  for (const tool of MCP_TOOLS) assert.equal(tool.inputSchema.additionalProperties, false, tool.name);
});

test("read tools are read-only; write tools are never marked read-only and are not destructive", () => {
  for (const name of ["list_jobs", "get_status"]) assert.equal(byName[name].annotations.readOnlyHint, true, name);
  for (const name of ["propose_send", "revise_proposal"]) {
    assert.deepEqual(byName[name].annotations, { readOnlyHint: false, destructiveHint: false, openWorldHint: true }, name);
  }
});

test("every tool requires the oauth2 scheme with scope jobs.act", () => {
  assert.equal(MCP_SCOPE, "jobs.act");
  for (const tool of MCP_TOOLS) assert.deepEqual(tool.securitySchemes, [{ type: "oauth2", scopes: ["jobs.act"] }], tool.name);
});

test("propose_send takes exactly the spec's arguments, with no cc, bcc or header fields", () => {
  const schema = byName.propose_send.inputSchema;
  assert.deepEqual(Object.keys(schema.properties).sort(), ["custom_body", "custom_subject", "fields", "job_id", "operation_id", "to"]);
  assert.deepEqual(schema.required, ["job_id", "to"]);
  for (const forbidden of ["cc", "bcc", "headers", "from", "reply_to", "attachments", "html"]) {
    assert.equal(forbidden in schema.properties, false, forbidden);
  }
});

test("schema limits match the gate's", () => {
  for (const name of ["propose_send", "revise_proposal"]) {
    const props = byName[name].inputSchema.properties;
    assert.equal(props.custom_subject.maxLength, CUSTOM_SUBJECT_MAX, name);
    assert.equal(props.custom_body.maxLength, CUSTOM_BODY_MAX, name);
  }
  assert.equal(byName.propose_send.inputSchema.properties.to.maxLength, 254);
});

test("the instructions stand alone within 512 characters and say when an email went out", () => {
  assert.ok(MCP_INSTRUCTIONS.length <= 512, `${MCP_INSTRUCTIONS.length} characters`);
  for (const phrase of ['only if the result says status "sent"', "do not resend", "Never claim success otherwise"]) {
    assert.ok(MCP_INSTRUCTIONS.includes(phrase), phrase);
  }
});

test("no tool text names the review vendor or model", () => {
  const all = [MCP_INSTRUCTIONS, ...MCP_TOOLS.flatMap((tool) => [tool.title, tool.description, JSON.stringify(tool.inputSchema)])].join(" ");
  assert.doesNotMatch(all, /typesafe|jev|systemone/i);
});
