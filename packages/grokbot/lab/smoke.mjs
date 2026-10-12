#!/usr/bin/env node
// The demo path as raw MCP calls against a running lab, the way Grok will make them: proves the
// server side before any Grok tokens are spent. Uses the lab's secret path, on loopback.
//
//   node packages/grokbot/lab/smoke.mjs http://127.0.0.1:8790/mcp/c/<secret>
import assert from "node:assert/strict";

const url = process.argv[2];
if (!url || !/\/mcp\/c\/[A-Za-z0-9_-]{43}$/.test(url)) {
  console.error("usage: node smoke.mjs http://127.0.0.1:8790/mcp/c/<secret>   (the lab prints it)");
  process.exit(2);
}
const lab = new URL(url).origin;
let id = 0;

async function call(name, args = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }),
  });
  assert.equal(res.status, 200, `${name}: HTTP ${res.status}`);
  const { result } = await res.json();
  return { sc: result.structuredContent, text: result.content.map((c) => c.text).join(" ") };
}
const state = async () => (await fetch(`${lab}/lab/state.json`)).json();
const step = (n, what, out) => console.log(`[${n}] ${what}\n    ${out.text}\n    ${JSON.stringify(out.sc)}`);

const jobs = await call("list_jobs");
step(1, "What jobs can you do for me right now?", jobs);
const job = jobs.sc.jobs.find((j) => j.purpose === "Tuesday recap to Dana");
assert.ok(job, "the seeded job is listed");

const fields = { first_name: "Dana", topic: "onboarding call", recap: "We agreed to start the pilot Monday, and I'll send the checklist by Friday." };
const sent = await call("propose_send", { job_id: job.job_id, to: job.recipient, fields });
step(2, "Tuesday recap for Dana", sent);
assert.equal(sent.sc.status, "sent");
assert.equal(sent.sc.sends_left, 1);

const bo = await call("propose_send", { job_id: job.job_id, to: "bo@birch.test", fields: { ...fields, first_name: "Bo" } });
step(3, "Same recap to Bo at Birch", bo);
assert.equal(bo.sc.status, "denied");
assert.equal(bo.sc.reason_code, "recipient_not_in_job");

const held = await call("propose_send", { job_id: job.job_id, to: job.recipient, custom_subject: "Kickoff", custom_body: "Hi Dana, does Thursday at 2pm work for a kickoff?" });
step(4, "Custom note: Thursday 2pm", held);
assert.equal(held.sc.status, "pending_approval");

const v2 = await call("revise_proposal", { proposal_id: held.sc.proposal_id, custom_subject: "Kickoff", custom_body: "Hi Dana, does Friday at 10am work for a kickoff?" });
step(5, "Make it Friday 10am", v2);
assert.equal(v2.sc.version, 2);

const pending = (await state()).pending.find((p) => p.proposal_id === held.sc.proposal_id);
const answer = await fetch(`${lab}/lab/answer`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", origin: lab },
  body: new URLSearchParams({ proposal: pending.proposal_id, version: String(pending.version), sha: pending.sha256, decision: "approve" }).toString(),
});
assert.equal(answer.status, 200);
const status = await call("get_status", { proposal_id: held.sc.proposal_id });
console.log(`    owner approved version ${pending.version}; get_status: ${JSON.stringify(status.sc)}`);
assert.equal(status.sc.version, 2);

const limit = await call("propose_send", { job_id: job.job_id, to: job.recipient, fields: { ...fields, recap: "A reminder about the checklist." } });
step(6, "One more reminder", limit);
assert.equal(limit.sc.status, "denied");
assert.equal(limit.sc.reason_code, "limit_reached");

const after = await state();
console.log(`\nSMOKE PASS: outbox ${after.outbox} sends; receipts ${after.receipts.join(", ")}`);
