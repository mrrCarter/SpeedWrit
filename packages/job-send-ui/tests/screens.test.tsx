import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SAY, findNeverSay } from "../src/lib/copy";
import type { TimelineReceipt } from "../src/lib/timeline";
import { ConfirmJob, jobLists, type JobDraft } from "../src/screens/ConfirmJob";
import { Connect } from "../src/screens/Connect";
import { ExceptionCard, type PendingVersion } from "../src/screens/ExceptionCard";
import { FlightRecorder } from "../src/screens/FlightRecorder";
import { VerifyPage, type VerifyResult } from "../src/screens/VerifyPage";

afterEach(cleanup);

const JOB: JobDraft = {
  jobId: "job_1",
  policyVersion: 1,
  agentConnectionId: "ac_1",
  recipient: "dana@test.example",
  purpose: "Send Dana at Acme a recap of Tuesday's call.",
  template: { id: "tpl_recap" },
  fieldRules: { first_name: { max: 40, required: true }, recap: { max: 600, required: true, free_text: true } },
  maxSends: 2,
  expiresAt: "2026-10-12T06:59:00Z",
  autoSend: true,
  allowCustomWithApproval: true,
  aiReview: "custom_only",
};

const RECEIPTS: TimelineReceipt[] = [
  { id: "r1", seq: 1, type: "JOB_CONFIRMED", ts: "2026-10-11T19:00:00Z" },
  { id: "r2", seq: 2, type: "ATTEMPT_DENIED", ts: "2026-10-11T19:01:00Z", detail: { reason_code: "recipient_not_in_job" } },
  { id: "r3", seq: 3, type: "PROPOSAL_CREATED", ts: "2026-10-11T19:02:00Z", proposal: "p1", version: 1 },
  { id: "r4", seq: 4, type: "DISPATCH_RESERVED", ts: "2026-10-11T19:03:00Z", proposal: "p1", version: 1 },
  { id: "r5", seq: 5, type: "OUTCOME_UNKNOWN", ts: "2026-10-11T19:04:00Z", proposal: "p1", version: 1, detail: { error_class: "timeout", dispatch: "d1" } },
];

const PENDING: PendingVersion = {
  proposalId: "p2",
  version: 2,
  versionSha256: "9f2c1e0b7a6d5c4b3a291807f6e5d4c3b2a19087f6e5d4c3b2a19087f6e5d4c3",
  reasons: ["custom_content"],
  aiFlags: [],
  subject: "Recap of Tuesday's call",
  body: "Hi Dana, here is the full recap.",
  baseline: { label: "version 1", subject: "Recap of Tuesday's call", body: "Hi Dana, here is the recap." },
};

describe("FlightRecorder", () => {
  it("a denial reads 'Prohibited by your job: not approvable' and its row offers NO approve or resolve control", () => {
    render(<FlightRecorder jobId="job_1" receipts={RECEIPTS} receiptText={() => "{}"} onResolve={vi.fn()} />);
    const denial = screen.getByText(SAY.prohibited).closest("li")!;
    expect(within(denial).getAllByRole("button")).toHaveLength(1); // only the row's own "open receipt" toggle
    expect(within(denial).queryByText(/Approve/)).toBeNull();
    expect(within(denial).getByText("recipient_not_in_job")).toBeTruthy();
  });

  it("an UNKNOWN row carries the two resolve buttons, and each reports its outcome", () => {
    const onResolve = vi.fn();
    render(<FlightRecorder jobId="job_1" receipts={RECEIPTS} receiptText={() => "{}"} onResolve={onResolve} />);
    fireEvent.click(screen.getByRole("button", { name: SAY.resolveSeen }));
    fireEvent.click(screen.getByRole("button", { name: SAY.resolveNotArrived }));
    expect(onResolve.mock.calls).toEqual([
      ["d1", "seen"],
      ["d1", "not_arrived"],
    ]);
  });

  it("an UNKNOWN row without its dispatch id offers no resolve control (it could not name what it resolves)", () => {
    const noId = RECEIPTS.map((receipt) => (receipt.id === "r5" ? { ...receipt, detail: { error_class: "timeout" } } : receipt));
    render(<FlightRecorder jobId="job_1" receipts={noId} receiptText={() => "{}"} onResolve={vi.fn()} />);
    expect(screen.queryByRole("button", { name: SAY.resolveSeen })).toBeNull();
    expect(screen.getByText(SAY.outcomeUnknown)).toBeTruthy();
  });

  it("keeps AI-review explanations informational after approval and preserves the opened receipt", () => {
    const review: TimelineReceipt = { id: "review", seq: 1, type: "AI_REVIEW", ts: "2026-10-11T19:00:00Z", proposal: "p1", version: 1, detail: { outcome: "hold", flags: ["hostile_tone"], probs_bp: { hostile_tone: 7500 }, model: "jev-1.13.0", ms: 7 } };
    const history: TimelineReceipt[] = [
      review,
      { ...review, id: "approval", seq: 2, type: "APPROVAL_GRANTED", detail: {} },
      { ...review, id: "accepted", seq: 3, type: "PROVIDER_ACCEPTED", detail: { provider_message_id: "message" } },
    ];
    const canonical = JSON.stringify({ key_id: "test", payload: JSON.stringify(review), signature: "test-only" });
    const onResolve = vi.fn();
    const { rerender } = render(<FlightRecorder jobId="job_1" receipts={[review]} receiptText={() => canonical} onResolve={onResolve} />);
    const toggle = screen.getByRole("button", { name: /AI review/ });
    const row = toggle.closest("li")!;
    const explanation = row.querySelector("p")?.textContent;
    expect(explanation?.length).toBeGreaterThan(0);
    rerender(<FlightRecorder jobId="job_1" receipts={history} receiptText={() => canonical} onResolve={onResolve} />);
    expect(row.querySelector("p")?.textContent).toBe(explanation);
    expect(within(row).getAllByRole("button")).toEqual([toggle]);
    expect(within(row).queryByRole("link")).toBeNull();
    expect(within(row).queryByRole("status")).toBeNull();
    expect(screen.getByText(SAY.providerAccepted)).toBeTruthy();
    expect(findNeverSay(document.body.textContent ?? "")).toEqual([]);
    fireEvent.click(toggle);
    expect(screen.getByLabelText("Receipt review").textContent).toBe(canonical);
    expect(onResolve).not.toHaveBeenCalled();
  });

  it("each row opens its receipt", () => {
    render(<FlightRecorder jobId="job_1" receipts={RECEIPTS} receiptText={(id) => `{"id":"${id}"}`} onResolve={vi.fn()} />);
    fireEvent.click(screen.getByText(/Job confirmed/));
    expect(screen.getByLabelText("Receipt r1").textContent).toBe('{"id":"r1"}');
  });
});

const VERIFIED: VerifyResult = { ok: true, reason: "verified" };
const BAD_SIGNATURE: VerifyResult = { ok: false, reason: "invalid_signature" };

describe("VerifyPage", () => {
  it("shows the pinned key, then 'Signature verified' or 'Signature invalid'; an edit clears the old result", async () => {
    const verify = vi.fn(async (text: string) => (text === "good" ? VERIFIED : BAD_SIGNATURE));
    render(<VerifyPage keyFingerprint="5a1f00c0ffee1234" verify={verify} initialReceipt="good" />);
    expect(screen.getByText("5a1f00c0ffee1234")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Verify" })));
    expect(screen.getByRole("status").textContent).toBe(SAY.signatureVerified);

    fireEvent.change(screen.getByLabelText("Receipt"), { target: { value: "gooD" } }); // one byte changed
    expect(screen.queryByRole("status")).toBeNull(); // not checked yet: no stale "verified"
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Verify" })));
    expect(screen.getByRole("status").textContent).toBe(`${SAY.signatureInvalid} invalid_signature`);
  });

  // warden's #496 repro, kept as the regression test: the stage's one-byte demo, edited while a check runs.
  it("a check that resolves after the receipt was edited shows no result for the edited text", async () => {
    let resolveCheck: (result: VerifyResult) => void = () => {};
    const verify = () => new Promise<VerifyResult>((resolve) => (resolveCheck = resolve));
    render(<VerifyPage keyFingerprint="abcd" verify={verify} initialReceipt='{"v":1,"seq":1}' />);
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: '{"v":1,"seq":2}' } });
    await act(async () => resolveCheck(VERIFIED));
    expect(screen.queryByText(SAY.signatureVerified)).toBeNull();
  });

  it("the receipt is read-only while a check runs, and editable again after", async () => {
    let resolveCheck: (result: VerifyResult) => void = () => {};
    render(<VerifyPage keyFingerprint="abcd" verify={() => new Promise((resolve) => (resolveCheck = resolve))} initialReceipt="x" />);
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).readOnly).toBe(true);
    await act(async () => resolveCheck(VERIFIED));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).readOnly).toBe(false);
  });

  it("a key this page doesn't pin reads 'Signature invalid' with the code unknown_key, never 'verified' (A17)", async () => {
    render(<VerifyPage keyFingerprint="k" verify={async () => ({ ok: false, reason: "unknown_key" })} initialReceipt="x" />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Verify" })));
    expect(screen.getByRole("status").textContent).toBe(`${SAY.signatureInvalid} unknown_key`);
  });

  it("only ok with reason 'verified' reads as verified", async () => {
    render(<VerifyPage keyFingerprint="k" verify={async () => ({ ok: true, reason: "not_canonical" })} initialReceipt="x" />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Verify" })));
    expect(screen.getByRole("status").textContent).toBe(`${SAY.signatureInvalid} not_canonical`);
  });

  // The library rejects only when it could not check (no WebCrypto Ed25519, an inconsistent pin): not a verdict.
  it("a verifier that rejects shows 'Not checked', neither 'Signature verified' nor 'Signature invalid'", async () => {
    render(<VerifyPage keyFingerprint="k" verify={async () => Promise.reject(new Error("no Ed25519 here"))} initialReceipt="x" />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Verify" })));
    expect(screen.getByRole("status").textContent).toBe(SAY.notChecked);
    expect(screen.queryByText(SAY.signatureVerified)).toBeNull();
    expect(screen.queryByText(new RegExp(SAY.signatureInvalid))).toBeNull();
  });
});

describe("ExceptionCard", () => {
  it("Reject also posts the hash THIS card rendered", () => {
    const onReject = vi.fn();
    render(<ExceptionCard pending={PENDING} onApprove={vi.fn()} onReject={onReject} />);
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect(onReject).toHaveBeenCalledWith("p2", 2, PENDING.versionSha256);
  });

  it("Approve posts the version and the hash THIS card rendered", () => {
    const onApprove = vi.fn();
    render(<ExceptionCard pending={PENDING} onApprove={onApprove} onReject={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve version 2" }));
    expect(onApprove).toHaveBeenCalledWith("p2", 2, PENDING.versionSha256);
  });

  it("shows the reasons, the hash prefix and the word-level change against its baseline", () => {
    render(<ExceptionCard pending={PENDING} onApprove={vi.fn()} onReject={vi.fn()} />);
    expect(screen.getByText("custom_content")).toBeTruthy();
    expect(screen.getByText(PENDING.versionSha256.slice(0, 16))).toBeTruthy();
    expect(document.querySelector("ins")?.textContent).toBe("full ");
  });

  // Spec, the gate: "if reasons is empty and job.auto_send: dispatch_auto; return pending_approval(version, reasons)".
  // With auto_send off, a template send is pending with NO reasons and is the owner's to approve. Failing closed on an
  // empty list would make every such job unapprovable: keep this case approvable.
  it("a template send in a job without auto-send (pending, no reasons) still offers Approve", () => {
    const onApprove = vi.fn();
    render(<ExceptionCard pending={{ ...PENDING, reasons: [] }} onApprove={onApprove} onReject={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Approve version 2" }));
    expect(onApprove).toHaveBeenCalledWith("p2", 2, PENDING.versionSha256);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers Approve when every reason is an allow-listed ask-me reason", () => {
    for (const reasons of [["custom_content"], ["mentions_other_client", "ai_review:hostile_tone", "ai_review_unavailable"]]) {
      render(<ExceptionCard pending={{ ...PENDING, reasons }} onApprove={vi.fn()} onReject={vi.fn()} />);
      expect(screen.getByRole("button", { name: "Approve version 2" })).toBeTruthy();
      cleanup();
    }
  });

  it("any other reason fails closed: no Approve, and the card says it is prohibited", () => {
    for (const reasons of [["superseded"], ["custom_content", "recipient_not_in_job"], ["ai_review:nonsense"], ["Custom_content"], [""]]) {
      render(<ExceptionCard pending={{ ...PENDING, reasons }} onApprove={vi.fn()} onReject={vi.fn()} />);
      expect(screen.queryByRole("button", { name: /Approve/ })).toBeNull();
      expect(screen.getByRole("alert").textContent).toBe(SAY.prohibited);
      cleanup();
    }
  });
});

describe("ConfirmJob", () => {
  it("splits the job into Never / Ask me / Runs without asking, as the server enforces it", () => {
    const lists = jobLists(JOB, "America/Los_Angeles");
    expect(lists.never[0]).toBe("Anyone other than dana@test.example");
    expect(lists.never).toContain("More than 2 sends");
    // No stronger than the gate (#507): "://" and "www." links are refused, a bare domain is not.
    expect(lists.never).toContain("Cc, Bcc, attachments, HTML, or links written with :// or www.");
    expect(lists.never).toContain("Anything after Oct 11, 2026, 11:59 PM PDT (Oct 12, 2026, 6:59 AM UTC)");
    expect(lists.askMe).toContain("Wording outside the template");
    expect(lists.runs).toEqual(["The approved template (tpl_recap) with fields inside their rules, to dana@test.example"]);
  });

  it("without custom approval, custom wording is Never; without auto-send, nothing runs without asking", () => {
    const lists = jobLists({ ...JOB, allowCustomWithApproval: false, autoSend: false, aiReview: "off" });
    expect(lists.never).toContain("Wording outside the template");
    expect(lists.askMe).not.toContain("Wording outside the template");
    expect(lists.runs).toEqual([]);
    expect(lists.askMe.some((item) => item.includes("AI-review"))).toBe(false);
  });

  it("confirms exactly the authority hash it showed", () => {
    const onConfirm = vi.fn();
    render(<ConfirmJob job={JOB} authoritySha256="abc123def456789" timeZone="UTC" onConfirm={onConfirm} />);
    expect(screen.getByText("ac_1")).toBeVisible();
    expect(screen.getByText("abc123def456")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm job" }));
    expect(onConfirm).toHaveBeenCalledWith("job_1", "abc123def456789");
  });
});

describe("Connect", () => {
  it("shows the exact granted scope and the declared agent label; STOP reports, and a stopped tab offers no STOP", () => {
    const onStop = vi.fn();
    const props = {
      gmail: { address: "owner@test.example", grantedScopes: ["https://www.googleapis.com/auth/gmail.send"] },
      agentConnection: { mcpUrl: "https://job-send.test/mcp", label: "ChatGPT", lastUsedAt: null },
      onStop,
    };
    const { rerender } = render(<Connect {...props} stopped={false} />);
    expect(screen.getByText(/gmail\.send/)).toBeTruthy();
    // The declared label sits in a <bdi> (a direction override inside it cannot reorder "(declared)").
    const agentLine = screen.getByText((_, el) => el?.tagName === "P" && (el.textContent ?? "").includes("(declared)"));
    expect(agentLine.textContent).toContain("ChatGPT (declared)");
    expect(agentLine.querySelector("bdi")?.textContent).toBe("ChatGPT");
    fireEvent.click(screen.getByRole("button", { name: "STOP sending" }));
    expect(onStop).toHaveBeenCalledTimes(1);
    rerender(<Connect {...props} stopped />);
    expect(screen.queryByRole("button", { name: "STOP sending" })).toBeNull();
  });
});

describe("every screen", () => {
  it("renders nothing the Say / Never-say table forbids", async () => {
    render(
      <div>
        <Connect gmail={{ address: "o@test.example", grantedScopes: ["gmail.send"] }} agentConnection={null} stopped={false} onStop={vi.fn()} />
        <ConfirmJob job={JOB} authoritySha256="abc" timeZone="UTC" onConfirm={vi.fn()} />
        <ExceptionCard pending={{ ...PENDING, aiFlags: ["tone"] }} onApprove={vi.fn()} onReject={vi.fn()} />
        <FlightRecorder jobId="job_1" receipts={RECEIPTS} receiptText={() => "{}"} onResolve={vi.fn()} />
        <VerifyPage keyFingerprint="k" verify={async () => VERIFIED} initialReceipt="x" />
      </div>
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Verify" })));
    expect(findNeverSay(document.body.textContent ?? "")).toEqual([]);
  });
});
