import { describe, expect, it } from "vitest";
import { NEVER_SAY, SAY, findNeverSay } from "../src/lib/copy";
import { formatExpiry } from "../src/lib/time";
import { buildTimeline, type TimelineReceipt } from "../src/lib/timeline";
import { wordDiff } from "../src/lib/wordDiff";

describe("copy: the Say / Never-say table", () => {
  it("no SAY phrase contains a NEVER_SAY phrase", () => {
    for (const [key, phrase] of Object.entries(SAY)) expect([key, findNeverSay(phrase)]).toEqual([key, []]);
  });

  it("an unconfirmed request points to the recorder without claiming a recorded provider outcome", () => {
    expect(SAY.requestUnconfirmed).toContain("Flight Recorder before repeating an action");
    expect(SAY.requestUnconfirmed).not.toMatch(/nothing (?:new )?was sent|not sent|outcome unknown|provider accepted/i);
  });

  it("finds a never-say phrase as a whole word, ignoring case", () => {
    expect(findNeverSay("Your email was delivered.")).toEqual(["Delivered"]);
    expect(findNeverSay("This is tamper-proof and 100% routed")).toEqual(["tamper-proof", "100% routed"]);
    expect(findNeverSay("Unblocked queue")).toEqual([]); // a word containing "blocked" is not "Blocked"
  });

  it("covers every phrase the spec forbids", () => {
    expect(NEVER_SAY).toEqual(expect.arrayContaining(["Delivered", "Failed, retrying", "Verified true", "100% routed", "Investigation done"]));
  });
});

describe("wordDiff", () => {
  const rebuild = (segments: ReturnType<typeof wordDiff>, keep: "added" | "removed") =>
    segments.filter((segment) => segment.kind === "same" || segment.kind === keep).map((segment) => segment.text).join("");

  it("marks the words a revision changed, keeping the rest", () => {
    expect(wordDiff("Hi Dana, here is the recap.", "Hi Dana, here is the full recap.")).toEqual([
      { kind: "same", text: "Hi Dana, here is the " },
      { kind: "added", text: "full " },
      { kind: "same", text: "recap." },
    ]);
  });

  it("an identical text is one unchanged run; an empty side is all added or all removed", () => {
    expect(wordDiff("same text", "same text")).toEqual([{ kind: "same", text: "same text" }]);
    expect(wordDiff("", "new words")).toEqual([{ kind: "added", text: "new words" }]);
    expect(wordDiff("old words", "")).toEqual([{ kind: "removed", text: "old words" }]);
  });

  it("always rebuilds both texts exactly, whitespace and line breaks included", () => {
    let seed = 7;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const words = ["Dana", "recap", "Tuesday", "call", "Acme", "the", "of", "\n", "  ", "Bo", "Birch"];
    const sentence = () => Array.from({ length: Math.floor(random() * 30) }, () => words[Math.floor(random() * words.length)]).join(" ");
    for (let run = 0; run < 200; run++) {
      const before = sentence();
      const after = sentence();
      const segments = wordDiff(before, after);
      expect(rebuild(segments, "removed")).toBe(before);
      expect(rebuild(segments, "added")).toBe(after);
    }
  });
});

describe("formatExpiry", () => {
  it("shows the owner's local time and UTC", () => {
    const { local, utc } = formatExpiry("2026-10-12T06:59:00Z", "America/Los_Angeles");
    expect(local).toBe("Oct 11, 2026, 11:59 PM PDT");
    expect(utc).toBe("Oct 12, 2026, 6:59 AM UTC");
  });

  it("refuses something that is not a timestamp", () => {
    expect(() => formatExpiry("tonight")).toThrow(RangeError);
  });
});

describe("buildTimeline", () => {
  const r = (seq: number, type: TimelineReceipt["type"], extra: Partial<TimelineReceipt> = {}): TimelineReceipt => ({
    id: `rcp_${seq}`,
    seq,
    type,
    ts: `2026-10-11T19:0${seq % 10}:00Z`,
    ...extra,
  });

  it("orders rows by seq, whatever order the receipts arrive in", () => {
    const rows = buildTimeline([r(3, "DISPATCH_RESERVED"), r(1, "JOB_CONFIRMED"), r(2, "PROPOSAL_CREATED", { proposal: "p1", version: 1 })]);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3]);
  });

  it("a denial reads 'Prohibited by your job: not approvable', keeps its reason and carries NO control", () => {
    const [row] = buildTimeline([r(1, "ATTEMPT_DENIED", { detail: { reason_code: "recipient_not_in_job" } })]);
    expect(row).toMatchObject({ label: SAY.prohibited, control: "none", tone: "denied", reason: "recipient_not_in_job" });
  });

  it.each([
    ["APPROVAL_GRANTED", "Approved by phone · version 2", "ok"],
    ["APPROVAL_REJECTED", "Rejected by phone", "info"],
    ["APPROVAL_REFUSED", "Phone approval not used", "info"],
  ] as const)("attributes a phone %s to its channel without claiming a send", (type, label, tone) => {
    // Synthetic executor-shaped detail; the phone's controller is not an identified speaker.
    const receipt = r(1, type, { proposal: "prp_phone", version: 2, detail: {
      approver: "own_test", channel: "phone", call_id: "call_test", voice_session: "voice_test", transcript_sha256: "a".repeat(64),
      ...(type === "APPROVAL_GRANTED" ? { approval: "apv_test" } : {}),
      ...(type === "APPROVAL_REFUSED" ? { reason: "dispatch_stopped" } : {}),
    } });
    const before = JSON.stringify(receipt);
    const [row] = buildTimeline([receipt]);
    expect(row).toMatchObject({ receiptId: receipt.id, seq: 1, ts: receipt.ts, label, tone, control: "none", badges: [] });
    expect(row?.reason).toBe(type === "APPROVAL_REFUSED" ? "dispatch_stopped" : undefined);
    if (type === "APPROVAL_REFUSED") expect(row?.explanation).toContain("Gmail was not enabled for sending at that attempt");
    expect(row?.label).not.toMatch(/you|accepted|sent|witnessed/i);
    expect(JSON.stringify(receipt)).toBe(before);
  });

  it.each([undefined, "browser", "future"])("does not infer phone attribution from channel %s", (channel) => {
    const types = ["APPROVAL_GRANTED", "APPROVAL_REJECTED", "APPROVAL_REFUSED"] as const;
    const receipts = types.map((type, i) => r(i + 1, type, { proposal: `prp_${i}`, version: 2, detail: {
      approver: "own_test", ...(channel === undefined ? {} : { channel }),
      ...(type === "APPROVAL_GRANTED" ? { approval: "apv_test" } : {}),
      ...(type === "APPROVAL_REFUSED" ? { reason: "not_pending" } : {}),
    } }));
    const before = JSON.stringify(receipts);
    const rows = buildTimeline(receipts);
    expect(rows.map((row) => row.label)).toEqual(["You approved version 2", "Rejected by you", "Approval not used"]);
    expect(rows.map((row) => row.control)).toEqual(["none", "none", "none"]);
    expect(rows[2]?.reason).toBe("not_pending");
    expect(JSON.stringify(receipts)).toBe(before);
  });

  it("keeps phone approval, provider acceptance, witness and a later refused decision distinct", () => {
    const binding = { proposal: "prp_phone", version: 2 };
    const phone = { approver: "own_test", channel: "phone", call_id: "call_test", voice_session: "voice_test", transcript_sha256: "a".repeat(64) };
    const rows = buildTimeline([
      r(1, "APPROVAL_GRANTED", { ...binding, detail: { ...phone, approval: "apv_test" } }),
      r(2, "DISPATCH_RESERVED", { ...binding, detail: { dispatch: "dsp_test", approval: "apv_test" } }),
      r(3, "PROVIDER_ACCEPTED", { ...binding, detail: { dispatch: "dsp_test", provider_message_id: "synthetic_message" } }),
      r(4, "DELIVERY_WITNESSED", binding),
      r(5, "APPROVAL_REFUSED", { ...binding, detail: { ...phone, call_id: "call_later", voice_session: "voice_later", reason: "not_pending" } }),
    ]);
    expect(rows.map((row) => row.label)).toEqual(["Approved by phone · version 2", "Send reserved", SAY.providerAccepted, "Phone approval not used"]);
    expect(rows.map((row) => row.badges)).toEqual([[], [], [SAY.witnessed], []]);
    expect(rows.every((row) => row.control === "none")).toBe(true);
    expect(rows[3]).toMatchObject({ reason: "not_pending", tone: "info" });
    expect(rows[3]?.explanation).toContain("earlier decisions and send outcomes");
  });

  it("explains only supported AI-review outcomes without changing receipt controls or reasons", () => {
    const explanations = new Set<string>();
    for (const outcome of ["clear", "hold", "unavailable"]) {
      const receipt = r(1, "AI_REVIEW", { detail: { outcome, reason: "existing_reason" } });
      const before = JSON.stringify(receipt);
      const [row] = buildTimeline([receipt]);
      expect(row).toMatchObject({ label: SAY.aiReview, tone: "info", control: "none", reason: "existing_reason" });
      expect(row?.explanation).toEqual(expect.any(String));
      expect(row?.explanation?.length).toBeGreaterThan(0);
      expect(findNeverSay(row?.explanation ?? "")).toEqual([]);
      explanations.add(row!.explanation!);
      expect(JSON.stringify(receipt)).toBe(before);
    }
    expect(explanations.size).toBe(3);
    for (const outcome of [undefined, null, false, 1, [], {}, "future", "CLEAR", "hold ", "toString"]) {
      expect(buildTimeline([r(1, "AI_REVIEW", { detail: { outcome } })])[0]?.explanation).toBeUndefined();
    }
    expect(buildTimeline([r(1, "JOB_CONFIRMED", { detail: { outcome: "hold" } })])[0]?.explanation).toBeUndefined();
  });

  it("UNKNOWN offers the two resolve buttons until the owner resolves THAT send", () => {
    const unknown = r(5, "OUTCOME_UNKNOWN", { proposal: "p1", version: 2, detail: { error_class: "timeout", dispatch: "d7" } });
    expect(buildTimeline([unknown])[0]).toMatchObject({ label: SAY.outcomeUnknown, control: "resolve", dispatchId: "d7", reason: "timeout" });
    const otherSend = r(6, "OUTCOME_RESOLVED", { proposal: "p2", version: 1, detail: { resolution: "sent" } });
    expect(buildTimeline([unknown, otherSend])[0]?.control).toBe("resolve"); // another send's resolution does not count
    const resolved = r(7, "OUTCOME_RESOLVED", { proposal: "p1", version: 2, detail: { resolution: "not_arrived" } });
    const rows = buildTimeline([unknown, resolved]);
    expect(rows[0]?.control).toBe("none");
    expect(rows[1]?.label).toBe(SAY.resolvedNotArrived);
    expect(SAY.resolvedNotArrived).toContain("still counts as a send");
    // An older receipt says "not_sent" for the same observation.
    const older = r(7, "OUTCOME_RESOLVED", { proposal: "p1", version: 2, detail: { resolution: "not_sent" } });
    expect(buildTimeline([unknown, older])[1]?.label).toBe(SAY.resolvedNotArrived);
    const seen = r(8, "OUTCOME_RESOLVED", { proposal: "p1", version: 2, detail: { resolution: "sent" } });
    expect(buildTimeline([unknown, seen])[1]?.label).toBe("You saw it arrive");
    const noId = r(5, "OUTCOME_UNKNOWN", { proposal: "p1", version: 2, detail: { error_class: "timeout" } });
    expect(buildTimeline([noId])[0]?.control).toBe("none");
  });

  it("'Witnessed' is a separate badge on the send's row, never folded into 'Provider accepted'", () => {
    const rows = buildTimeline([
      r(1, "PROVIDER_ACCEPTED", { proposal: "p1", version: 1, detail: { provider_message_id: "m1" } }),
      r(2, "DELIVERY_WITNESSED", { proposal: "p1", version: 1 }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: SAY.providerAccepted, badges: [SAY.witnessed] });
  });

  it("no row label says anything the spec forbids", () => {
    const every: TimelineReceipt["type"][] = [
      "CONNECTION_CREATED", "AGENT_CONNECTED", "JOB_CONFIRMED", "ATTEMPT_DENIED", "PROPOSAL_CREATED", "PROPOSAL_REVISED",
      "AI_REVIEW", "APPROVAL_GRANTED", "APPROVAL_REJECTED", "APPROVAL_REFUSED", "DISPATCH_RESERVED", "DISPATCH_REFUSED",
      "PROVIDER_ACCEPTED", "NOT_SENT", "OUTCOME_UNKNOWN", "OUTCOME_RESOLVED", "DELIVERY_WITNESSED", "STOP_ENGAGED",
      "PROVIDER_REVOKE_REQUESTED", "PROVIDER_REVOKE_RESULT",
    ];
    const rows = buildTimeline(every.map((type, index) => r(index + 1, type)));
    for (const row of rows) expect([row.label, findNeverSay(row.label)]).toEqual([row.label, []]);
  });
});
