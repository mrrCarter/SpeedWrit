// The owner core's answers (machine, #526) as the owner app reads them. The fixtures use the core's exact field
// names; a test fails if the client stops mapping them, and the types fail to compile if a field is renamed.
import { generateReceiptKeyPair, signReceipt } from "@writ/job-send";
import { verifyReceiptText } from "@writ/job-send/verify";
import { describe, expect, it } from "vitest";
import type { Job } from "@writ/job-send/contract";
import { jobFromApi, OwnerApi, pendingFromApi, receiptFromApi, type ApiJobItem, type ApiPendingVersion, type ApiStoredReceipt } from "../src/app/api";
import { buildTimeline } from "../src/lib/timeline";

const SHA = "9f2c1e0b7a6d5c4b3a291807f6e5d4c3b2a19087f6e5d4c3b2a19087f6e5d4c3";
const REVISION: ApiPendingVersion = {
  proposalId: "prp_1",
  jobId: "job_1",
  version: 2,
  sha256: SHA,
  reviewReasons: ["custom_content", "ai_review:hostile_tone", "ai_review_unavailable"],
  recipient: "dana@acme.com",
  subject: "Recap",
  body: "Hi Dana, here is the full recap.",
  createdAt: "2026-10-11T19:02:00Z",
  baseline: { subject: "Recap", body: "Hi Dana, here is the recap." },
};

describe("pendingFromApi", () => {
  it("maps the core's pending version to the exception card's: the hash, the reasons, the AI flags, the baseline", () => {
    expect(pendingFromApi(REVISION)).toEqual({
      proposalId: "prp_1",
      version: 2,
      versionSha256: SHA,
      reasons: ["custom_content", "ai_review:hostile_tone", "ai_review_unavailable"],
      aiFlags: ["hostile_tone"],
      subject: "Recap",
      body: "Hi Dana, here is the full recap.",
      baseline: { label: "version 1", subject: "Recap", body: "Hi Dana, here is the recap." },
    });
  });

  it("version 1 has no baseline in the core; the card compares it with nothing earlier", () => {
    expect(pendingFromApi({ ...REVISION, version: 1, baseline: null }).baseline).toEqual({ label: "nothing earlier (the first version)", subject: "", body: "" });
  });
});

describe("receiptFromApi", () => {
  const pair = generateReceiptKeyPair();
  const pinned = { keyId: pair.keyId, publicKeyRaw: pair.publicKeyRaw };

  it("reads the timeline fields from the signed payload, and gives /verify the canonical envelope, which verifies", async () => {
    const signed = signReceipt(pair.privateKey, {
      id: "rcp_9",
      seq: 9,
      type: "OUTCOME_UNKNOWN",
      ts: "2026-10-11T19:04:11Z",
      owner: "own_1",
      job: "job_1",
      proposal: "prp_1",
      version: 2,
      detail: { dispatch: "dsp_1", error_class: "timeout" },
    });
    const stored: ApiStoredReceipt = { id: "rcp_9", seq: 9, type: "OUTCOME_UNKNOWN", ...signed };
    const listed = receiptFromApi(stored);
    expect(listed).toMatchObject({
      id: "rcp_9",
      seq: 9,
      type: "OUTCOME_UNKNOWN",
      ts: "2026-10-11T19:04:11Z",
      proposal: "prp_1",
      version: 2,
      detail: { dispatch: "dsp_1", error_class: "timeout" },
    });
    expect(await verifyReceiptText(listed.text, pinned)).toEqual({ ok: true, reason: "verified" });
    // The timeline offers the resolve control for this dispatch.
    expect(buildTimeline([listed])[0]).toMatchObject({ control: "resolve", dispatchId: "dsp_1" });
  });

  it("a payload that does not parse gives empty fields and no resolve control, never a throw", () => {
    const listed = receiptFromApi({ id: "r", seq: 1, type: "OUTCOME_UNKNOWN", payload: "{not json", signature: "s", key_id: "k" });
    expect(listed).toMatchObject({ ts: "", proposal: null, version: null, detail: {} });
    expect(buildTimeline([listed])[0]?.control).toBe("none");
  });
});

describe("jobFromApi", () => {
  const JOB: Job = {
    v: 1,
    job_id: "job_1",
    policy_version: 1,
    owner: "own_1",
    connection: "conn_1",
    agent_connection: "ac_1",
    provider: "gmail",
    sender: "owner@test.example",
    recipient: "dana@acme.com",
    purpose: "Recap of Tuesday's call",
    template: { id: "tpl_recap", sha256: SHA },
    field_rules: {},
    max_sends: 2,
    expires_at: "2026-10-12T06:59:00Z",
    auto_send: true,
    allow_custom_with_approval: true,
    ai_review: "custom_only",
  };

  it("reads the jobs list's fields from the job's authority object", () => {
    const item: ApiJobItem = { job: JOB, authoritySha256: SHA, status: "active", sendsReserved: 1, sendsLeft: 1 };
    expect(jobFromApi(item)).toEqual({
      jobId: "job_1",
      purpose: "Recap of Tuesday's call",
      recipient: "dana@acme.com",
      status: "active",
      expiresAt: "2026-10-12T06:59:00Z",
      sendsLeft: 1,
    });
  });
});

describe("the client maps the core's answers", () => {
  it("pending() and receipts() hand the screens their own shapes", async () => {
    const pair = generateReceiptKeyPair();
    const signed = signReceipt(pair.privateKey, { id: "rcp_1", seq: 1, type: "JOB_CONFIRMED", ts: "2026-10-11T19:00:00Z", owner: "own_1", job: "job_1" });
    const answers: Record<string, unknown> = {
      "/owner/pending": { pending: [REVISION] },
      "/owner/receipts?job_id=job_1": { receipts: [{ id: "rcp_1", seq: 1, type: "JOB_CONFIRMED", ...signed }] },
    };
    const api = new OwnerApi(async (url) => ({ ok: true, status: 200, json: async () => answers[url] }));
    expect((await api.pending()).pending[0]?.versionSha256).toBe(SHA);
    expect((await api.receipts("job_1")).receipts[0]).toMatchObject({ id: "rcp_1", type: "JOB_CONFIRMED", ts: "2026-10-11T19:00:00Z" });
  });
});
