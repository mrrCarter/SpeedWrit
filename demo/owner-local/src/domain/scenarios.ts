// Every edge case and failure mode the demo should show, as runnable checks. The same list drives the
// "Edge cases" tab (run all, or replay one into the live demo) and the unit tests.

import { verifyReceipt, tamperOneByte } from "./crypto";
import { ageDays, CLEANUP_JOB_ID, DAY, HOUR, PRIMARY_CONNECTION_ID, SEND_JOB_ID } from "./data";
import { draftFrom, parseLine, STARTER_LINES } from "./frontDoor";
import type { Engine } from "./engine";
import type { AgentResult, CleanupJob, Email, SendJob } from "./types";

export interface Check {
  label: string;
  ok: boolean;
  got: string;
}

export interface Scenario {
  id: string;
  group: "Send · job-bound email" | "Connections & jobs" | "Receipts" | "Labs · inbox cleanup, max 10 per batch";
  title: string;
  expect: string;
  run: (e: Engine) => Promise<Check[]>;
}

const eq = (label: string, got: unknown, want: unknown): Check => ({ label: `${label} = ${String(want)}`, ok: got === want, got: String(got) });

function fixture(e: Engine) {
  const s = e.getState();
  const job = s.jobs.find((j) => j.id === CLEANUP_JOB_ID) as CleanupJob;
  const inbox = (f: (m: Email) => boolean) => s.emails.filter((m) => m.state === "inbox" && f(m)).map((m) => m.id);
  const plain = (m: Email) => !m.starred && m.contactId === null;
  const old = (m: Email) => ageDays(m, s.clock) >= job.minAgeDays;
  return {
    inScope: inbox((m) => plain(m) && old(m) && job.labels.includes(m.label)),
    recentPromos: inbox((m) => plain(m) && m.label === "Promotions" && !old(m)),
    starred: inbox((m) => m.starred),
    fromDana: inbox((m) => m.contactId === "dana"),
    receipts: inbox((m) => m.label === "Receipts"),
  };
}

const trash = (e: Engine) => e.getState().emails.filter((m) => m.state === "trash").length;
const calls = (e: Engine) => e.getState().providerCalls;
const sendJob = (e: Engine) => e.getState().jobs.find((j) => j.id === SEND_JOB_ID) as SendJob;
const left = (e: Engine) => sendJob(e).maxSends - sendJob(e).sendsReserved;
const del = (e: Engine, messageIds: string[], operationId?: string) => e.proposeDelete({ jobId: CLEANUP_JOB_ID, messageIds, operationId });
const recap = { topic: "onboarding call", recap: "we agreed to start the pilot Monday, and I'll send the checklist by Friday." };
const send = (e: Engine, to = "dana@acme.test", fields: Record<string, string> = recap) => e.proposeSend({ jobId: SEND_JOB_ID, to, fields });
const custom = (e: Engine) =>
  e.proposeSend({ jobId: SEND_JOB_ID, to: "dana@acme.test", custom: { subject: "Kickoff?", body: "Hi Dana,\n\nDoes Thursday at 2pm work for a kickoff?\n\nBest,\nAman" } });
const denied = (r: AgentResult, code: string): Check[] => [eq("status", r.status, "denied"), eq("reason", r.reasonCode, code), eq("approvable", r.approvable, false)];

export const SCENARIOS: Scenario[] = [
  // ── Cleanup ──────────────────────────────────────────────────────────────
  {
    id: "c-10",
    group: "Labs · inbox cleanup, max 10 per batch",
    title: "Delete 10 old promotions",
    expect: "done · 10 in Trash · 1 provider call",
    run: async (e) => {
      const r = await del(e, fixture(e).inScope.slice(0, 10));
      return [eq("status", r.status, "done"), eq("in Trash", trash(e), 10), eq("provider calls", calls(e), 1)];
    },
  },
  {
    id: "c-11",
    group: "Labs · inbox cleanup, max 10 per batch",
    title: "Delete 11 in one batch",
    expect: "denied batch_limit_exceeded · not approvable · nothing deleted",
    run: async (e) => {
      const r = await del(e, fixture(e).inScope.slice(0, 11));
      return [...denied(r, "batch_limit_exceeded"), eq("in Trash", trash(e), 0), eq("provider calls", calls(e), 0), eq("held proposals", e.getState().proposals.length, 0)];
    },
  },
  {
    id: "c-split",
    group: "Labs · inbox cleanup, max 10 per batch",
    title: "Split 11 into 10 + 1",
    expect: "both done, one after the other · 11 in Trash",
    run: async (e) => {
      const ids = fixture(e).inScope.slice(0, 11);
      const a = await del(e, ids.slice(0, 10));
      const b = await del(e, ids.slice(10));
      return [eq("first", a.status, "done"), eq("second", b.status, "done"), eq("in Trash", trash(e), 11)];
    },
  },
  {
    id: "c-race",
    group: "Labs · inbox cleanup, max 10 per batch",
    title: "Two batches of 10 at the same moment",
    expect: "one done · the other denied batch_in_flight · 10 in Trash, not 20",
    run: async (e) => {
      const ids = fixture(e).inScope;
      const [a, b] = await Promise.all([del(e, ids.slice(0, 10)), del(e, ids.slice(10, 20))]);
      const statuses = [a.status, b.status].sort().join("+");
      const codes = [a.reasonCode, b.reasonCode].filter(Boolean).join(",");
      return [eq("outcomes", statuses, "denied+done"), eq("denial", codes, "batch_in_flight"), eq("in Trash", trash(e), 10)];
    },
  },
  {
    id: "c-starred",
    group: "Labs · inbox cleanup, max 10 per batch",
    title: "Batch includes a starred email",
    expect: "denied protected_message · the whole batch, nothing deleted",
    run: async (e) => {
      const f = fixture(e);
      const r = await del(e, [...f.inScope.slice(0, 9), f.starred[0] as string]);
      return [...denied(r, "protected_message"), eq("in Trash", trash(e), 0)];
    },
  },
  {
    id: "c-contact",
    group: "Labs · inbox cleanup, max 10 per batch",
    title: "Batch includes mail from Dana (a contact)",
    expect: "denied protected_message · nothing deleted",
    run: async (e) => {
      const f = fixture(e);
      const r = await del(e, [...f.inScope.slice(0, 5), f.fromDana[0] as string]);
      return [...denied(r, "protected_message"), eq("in Trash", trash(e), 0)];
    },
  },
  {
    id: "c-dup",
    group: "Labs · inbox cleanup, max 10 per batch",
    title: "Same id twice (to look like fewer)",
    expect: "denied duplicate_ids",
    run: async (e) => {
      const id = fixture(e).inScope[0] as string;
      return denied(await del(e, [id, id]), "duplicate_ids");
    },
  },
  {
    id: "c-empty",
    group: "Labs · inbox cleanup, max 10 per batch",
    title: "Empty batch",
    expect: "denied batch_empty",
    run: async (e) => denied(await del(e, []), "batch_empty"),
  },
  {
    id: "c-missing",
    group: "Labs · inbox cleanup, max 10 per batch",
    title: "An id that doesn't exist",
    expect: "denied message_not_found",
    run: async (e) => denied(await del(e, ["m999"]), "message_not_found"),
  },
  {
    id: "c-again",
    group: "Labs · inbox cleanup, max 10 per batch",
    title: "Delete an email that's already in Trash",
    expect: "denied already_deleted",
    run: async (e) => {
      const id = fixture(e).inScope[0] as string;
      await del(e, [id]);
      return denied(await del(e, [id]), "already_deleted");
    },
  },
  {
    id: "c-scope",
    group: "Labs · inbox cleanup, max 10 per batch",
    title: "Recent promotions (outside the 30-day rule)",
    expect: "held outside_scope · owner approves this exact batch · done",
    run: async (e) => {
      const ids = fixture(e).recentPromos.slice(0, 3);
      const held = await del(e, ids);
      const before = calls(e);
      const ok = await e.approve(held.proposalId as string, held.versionHash as string);
      return [eq("first", held.status, "pending_approval"), eq("review", held.reviewReasons?.join(","), "outside_scope"), eq("calls while held", before, 0), eq("after approval", ok.agentResult?.status, "done"), eq("in Trash", trash(e), 3)];
    },
  },
  {
    id: "c-label",
    group: "Labs · inbox cleanup, max 10 per batch",
    title: "Old receipts (wrong label for this job)",
    expect: "held outside_scope · never auto-deleted",
    run: async (e) => {
      const r = await del(e, fixture(e).receipts.slice(0, 2));
      return [eq("status", r.status, "pending_approval"), eq("in Trash", trash(e), 0)];
    },
  },
  {
    id: "c-stale",
    group: "Labs · inbox cleanup, max 10 per batch",
    title: "Approve a held batch after one of its emails was deleted",
    expect: "approval refused already_deleted",
    run: async (e) => {
      const [x, y] = fixture(e).recentPromos;
      const a = await del(e, [x as string, y as string]);
      const b = await del(e, [x as string]);
      await e.approve(b.proposalId as string, b.versionHash as string);
      const late = await e.approve(a.proposalId as string, a.versionHash as string);
      return [eq("refused", late.ok, false), eq("code", late.code, "already_deleted"), eq("in Trash", trash(e), 1)];
    },
  },
  {
    id: "c-edited",
    group: "Labs · inbox cleanup, max 10 per batch",
    title: "Owner edits the job while a batch is held",
    expect: "approval refused policy_changed",
    run: async (e) => {
      const held = await del(e, fixture(e).recentPromos.slice(0, 2));
      await e.editJob(CLEANUP_JOB_ID);
      const r = await e.approve(held.proposalId as string, held.versionHash as string);
      return [eq("refused", r.ok, false), eq("code", r.code, "policy_changed"), eq("in Trash", trash(e), 0)];
    },
  },
  {
    id: "c-timeout",
    group: "Labs · inbox cleanup, max 10 per batch",
    title: "Provider times out mid-batch",
    expect: "unknown · next batch blocked · owner says it didn't happen · next batch runs",
    run: async (e) => {
      const ids = fixture(e).inScope;
      e.setNextFault("timeout");
      const a = await del(e, ids.slice(0, 10));
      const blocked = await del(e, ids.slice(10, 12));
      await e.resolveUnknown(a.proposalId as string, false);
      const after = await del(e, ids.slice(10, 12));
      return [eq("first", a.status, "unknown"), eq("while unknown", blocked.reasonCode, "batch_in_flight"), eq("after owner check", after.status, "done"), eq("in Trash", trash(e), 2), eq("provider calls", calls(e), 2)];
    },
  },
  {
    id: "c-partial",
    group: "Labs · inbox cleanup, max 10 per batch",
    title: "Provider deletes 7 of 10",
    expect: "partial · 7 in Trash · 3 stay · no automatic retry",
    run: async (e) => {
      e.setNextFault("partial");
      const r = await del(e, fixture(e).inScope.slice(0, 10));
      return [eq("status", r.status, "partial"), eq("deleted", r.deleted, 7), eq("failed", r.failed, 3), eq("in Trash", trash(e), 7), eq("provider calls", calls(e), 1)];
    },
  },
  {
    id: "c-429",
    group: "Labs · inbox cleanup, max 10 per batch",
    title: "Provider rate-limits (429)",
    expect: "not_done · nothing deleted · the next batch may run",
    run: async (e) => {
      const ids = fixture(e).inScope;
      e.setNextFault("http429");
      const a = await del(e, ids.slice(0, 10));
      const b = await del(e, ids.slice(0, 10));
      return [eq("first", a.status, "not_done"), eq("retry by agent", b.status, "done"), eq("in Trash", trash(e), 10)];
    },
  },
  {
    id: "c-stop",
    group: "Labs · inbox cleanup, max 10 per batch",
    title: "Owner presses STOP, then the agent deletes",
    expect: "denied dispatch_stopped",
    run: async (e) => {
      await e.stop();
      return [...denied(await del(e, fixture(e).inScope.slice(0, 3)), "dispatch_stopped"), eq("in Trash", trash(e), 0)];
    },
  },
  {
    id: "c-stop-held",
    group: "Labs · inbox cleanup, max 10 per batch",
    title: "STOP while a batch is held, then approve it",
    expect: "approval refused dispatch_stopped",
    run: async (e) => {
      const held = await del(e, fixture(e).recentPromos.slice(0, 2));
      await e.stop();
      const r = await e.approve(held.proposalId as string, held.versionHash as string);
      return [eq("code", r.code, "dispatch_stopped"), eq("in Trash", trash(e), 0)];
    },
  },
  {
    id: "c-expired",
    group: "Labs · inbox cleanup, max 10 per batch",
    title: "Job expired (clock +9h)",
    expect: "denied job_expired",
    run: async (e) => {
      e.advanceClock(9 * HOUR);
      return denied(await del(e, fixture(e).inScope.slice(0, 2)), "job_expired");
    },
  },
  {
    id: "c-idem",
    group: "Labs · inbox cleanup, max 10 per batch",
    title: "Agent retries with the same operation_id",
    expect: "same answer · one provider call · nothing deleted twice",
    run: async (e) => {
      const ids = fixture(e).inScope.slice(0, 5);
      const a = await del(e, ids, "op-cleanup-1");
      const b = await del(e, ids, "op-cleanup-1");
      return [eq("first", a.status, "done"), eq("same receipt", b.receiptSeq, a.receiptSeq), eq("provider calls", calls(e), 1), eq("in Trash", trash(e), 5)];
    },
  },
  {
    id: "c-wrongjob",
    group: "Labs · inbox cleanup, max 10 per batch",
    title: "Delete through the send job's id",
    expect: "denied job_not_found",
    run: async (e) => denied(await e.proposeDelete({ jobId: SEND_JOB_ID, messageIds: fixture(e).inScope.slice(0, 1) }), "job_not_found"),
  },

  // ── Connections, jobs and the MVP's honesty rules ───────────────────────
  {
    id: "j-frontdoor",
    group: "Connections & jobs",
    title: "Front door: the four starter lines",
    expect: "Dana only · 2 sends · 23:59 PT · custom wording held",
    run: async (e) => {
      const s = e.getState();
      const { draft, missing, problems } = draftFrom(STARTER_LINES.map((l) => parseLine(l, s.contacts, s.clock)));
      return [eq("recipient", draft.recipient, "dana@acme.test"), eq("sends", draft.maxSends, 2), eq("expires", new Date(draft.expiresAt ?? 0).toISOString(), "2026-10-12T06:59:00.000Z"), eq("custom held", draft.allowCustom, true), eq("missing", missing.length + problems.length, 0)];
    },
  },
  {
    id: "j-noapproval",
    group: "Connections & jobs",
    title: "Job without \"ask me before custom wording\"",
    expect: "custom wording denied custom_not_allowed (not held)",
    run: async (e) => {
      const s = e.getState();
      const { draft } = draftFrom(STARTER_LINES.slice(0, 3).map((l) => parseLine(l, s.contacts, s.clock)));
      const made = await e.confirmSendJob(draft, PRIMARY_CONNECTION_ID);
      const r = await e.proposeSend({ jobId: made.jobId as string, to: "dana@acme.test", custom: { subject: "Kickoff?", body: "Hi Dana, does Thursday work?" } });
      return [eq("confirmed", made.ok, true), ...denied(r, "custom_not_allowed"), eq("provider calls", calls(e), 0)];
    },
  },
  {
    id: "j-wrongconn",
    group: "Connections & jobs",
    title: "Another agent connection calls the Dana job",
    expect: "denied job_not_found · provider not called",
    run: async (e) => {
      const other = await e.connectAgent("Other agent", "oauth");
      const r = await e.proposeSend({ connectionId: other.connection?.id, jobId: SEND_JOB_ID, to: "dana@acme.test", fields: recap });
      return [...denied(r, "job_not_found"), eq("provider calls", calls(e), 0), eq("calls before = after", r.providerCalls?.before === r.providerCalls?.after, true)];
    },
  },
  {
    id: "j-revoked",
    group: "Connections & jobs",
    title: "Agent connection revoked, then the agent sends",
    expect: "denied invalid_token before the gate",
    run: async (e) => {
      await e.revokeAgent(PRIMARY_CONNECTION_ID);
      const r = await send(e);
      return [eq("status", r.status, "denied"), eq("reason", r.reasonCode, "invalid_token"), eq("provider calls", calls(e), 0)];
    },
  },
  {
    id: "j-listjobs",
    group: "Connections & jobs",
    title: "list_jobs shows only this connection's jobs",
    expect: "the primary sees its job; a new connection sees none",
    run: async (e) => {
      const mine = await e.listJobs(PRIMARY_CONNECTION_ID);
      const other = await e.connectAgent("Other agent", "oauth");
      const theirs = await e.listJobs(other.connection?.id);
      return [eq("primary jobs", mine.jobs?.length, 1), eq("other jobs", theirs.jobs?.length, 0)];
    },
  },
  {
    id: "j-fallback",
    group: "Connections & jobs",
    title: "Fallback connection URL",
    expect: "labeled fallback (never OAuth) · URL shown once",
    run: async (e) => {
      const r = await e.connectAgent("", "fallback");
      return [eq("kind", r.connection?.kind, "fallback"), eq("secret path", /\/mcp\/c\/[A-Za-z0-9_-]{43}$/.test(r.secretUrl ?? ""), true)];
    },
  },
  {
    id: "j-revise-conn",
    group: "Connections & jobs",
    title: "Revise through a newly connected agent (PR #28 review)",
    expect: "revision logged under that connection · another connection can't revise",
    run: async (e) => {
      const mine = await e.connectAgent("ChatGPT-SpeedWrit", "oauth");
      const id = mine.connection?.id as string;
      const s = e.getState();
      const { draft } = draftFrom(STARTER_LINES.map((l) => parseLine(l, s.contacts, s.clock)));
      const made = await e.confirmSendJob(draft, id);
      const v1 = await e.proposeSend({ connectionId: id, jobId: made.jobId as string, to: "dana@acme.test", custom: { subject: "Kickoff?", body: "Hi Dana, does Thursday at 2pm work?" } });
      const other = await e.reviseSend(v1.proposalId as string, { connectionId: PRIMARY_CONNECTION_ID, custom: { subject: "Kickoff?", body: "Hi Dana, does Monday work?" } });
      const v2 = await e.reviseSend(v1.proposalId as string, { connectionId: id, custom: { subject: "Kickoff?", body: "Hi Dana, does Friday at 10am work?" } });
      const logged = e.getState().agentLog.find((x) => x.tool === "revise_proposal" && x.result.version === 2);
      return [eq("held", v1.status, "pending_approval"), eq("other connection", other.reasonCode, "proposal_not_found"), eq("revised", v2.version, 2), eq("logged under", logged?.connectionId, id)];
    },
  },
  {
    id: "s-notarrived",
    group: "Send · job-bound email",
    title: "UNKNOWN, then owner says it did not arrive",
    expect: "observation recorded · slot kept · nothing resends",
    run: async (e) => {
      e.setNextFault("http503");
      const r = await send(e);
      const resolved = await e.resolveUnknown(r.proposalId as string, false);
      const p = e.getState().proposals.find((x) => x.id === r.proposalId);
      return [eq("first", r.status, "unknown"), eq("controlled test", r.controlledTest, true), eq("resolved", resolved.ok, true), eq("observation", p?.ownerObservation, "not_arrived"), eq("sends left", left(e), 1), eq("provider calls", calls(e), 1)];
    },
  },
  {
    id: "s-witness",
    group: "Send · job-bound email",
    title: "Provider accepted, then the owner sees it in the inbox",
    expect: "PROVIDER_ACCEPTED and DELIVERY_WITNESSED are separate receipts",
    run: async (e) => {
      const r = await send(e);
      const w = await e.witnessDelivery(r.proposalId as string);
      const types = e.getState().receipts.map((x) => x.type);
      return [eq("sent", r.status, "sent"), eq("witness", w.ok, true), eq("accepted receipt", types.includes("PROVIDER_ACCEPTED"), true), eq("witness receipt", types.includes("DELIVERY_WITNESSED"), true)];
    },
  },
  {
    id: "s-stopfree",
    group: "Send · job-bound email",
    title: "STOP refusal names the free slots",
    expect: "\"2 of 2 sends free\": STOP, not the limit",
    run: async (e) => {
      const v1 = await custom(e);
      await e.stop();
      const r = await e.approve(v1.proposalId as string, v1.versionHash as string);
      return [eq("code", r.code, "dispatch_stopped"), eq("names free slots", /2 of 2 sends free/.test(r.message), true)];
    },
  },

  // ── Send ─────────────────────────────────────────────────────────────────
  {
    id: "s-template",
    group: "Send · job-bound email",
    title: "Template recap to Dana",
    expect: "sent · 1 of 2 left",
    run: async (e) => {
      const r = await send(e);
      return [eq("status", r.status, "sent"), eq("sends left", left(e), 1)];
    },
  },
  {
    id: "s-bo",
    group: "Send · job-bound email",
    title: "Same recap to Bo at Birch",
    expect: "denied recipient_not_in_job · no proposal · nothing to approve",
    run: async (e) => [...denied(await send(e, "bo@birch.test"), "recipient_not_in_job"), eq("proposals", e.getState().proposals.length, 0), eq("provider calls", calls(e), 0)],
  },
  {
    id: "s-two",
    group: "Send · job-bound email",
    title: "Two addresses in `to`",
    expect: "denied recipient_invalid",
    run: async (e) => denied(await send(e, "dana@acme.test, bo@birch.test"), "recipient_invalid"),
  },
  {
    id: "s-display",
    group: "Send · job-bound email",
    title: "Display name in `to`",
    expect: "denied recipient_invalid",
    run: async (e) => denied(await send(e, "Dana <dana@acme.test>"), "recipient_invalid"),
  },
  {
    id: "s-link",
    group: "Send · job-bound email",
    title: "A link inside a field",
    expect: "denied field_invalid",
    run: async (e) => denied(await send(e, "dana@acme.test", { ...recap, recap: "see https://evil.example/login" }), "field_invalid"),
  },
  {
    id: "s-cc",
    group: "Send · job-bound email",
    title: "An extra field (cc)",
    expect: "denied field_not_allowed",
    run: async (e) => denied(await send(e, "dana@acme.test", { ...recap, cc: "bo@birch.test" }), "field_not_allowed"),
  },
  {
    id: "s-custom",
    group: "Send · job-bound email",
    title: "Custom wording",
    expect: "held custom_content · no provider call",
    run: async (e) => {
      const r = await custom(e);
      return [eq("status", r.status, "pending_approval"), eq("review", r.reviewReasons?.join(","), "custom_content"), eq("provider calls", calls(e), 0)];
    },
  },
  {
    id: "s-revise",
    group: "Send · job-bound email",
    title: "Revise, approve the old hash, then the new one",
    expect: "old hash 409 superseded · version 2 sends",
    run: async (e) => {
      const v1 = await custom(e);
      const v2 = await e.reviseSend(v1.proposalId as string, { custom: { subject: "Kickoff?", body: "Hi Dana,\n\nDoes Friday at 10am work for a kickoff?\n\nBest,\nAman" } });
      const stale = await e.approve(v1.proposalId as string, v1.versionHash as string);
      const ok = await e.approve(v2.proposalId as string, v2.versionHash as string);
      return [eq("old hash", stale.code, "superseded"), eq("version", v2.version, 2), eq("new hash", ok.agentResult?.status, "sent"), eq("provider calls", calls(e), 1)];
    },
  },
  {
    id: "s-double",
    group: "Send · job-bound email",
    title: "Two approvals of the same version at once",
    expect: "one send · one provider call",
    run: async (e) => {
      const v1 = await custom(e);
      const [a, b] = await Promise.all([e.approve(v1.proposalId as string, v1.versionHash as string), e.approve(v1.proposalId as string, v1.versionHash as string)]);
      return [eq("approved", [a.ok, b.ok].filter(Boolean).length, 1), eq("provider calls", calls(e), 1), eq("sends left", left(e), 1)];
    },
  },
  {
    id: "s-limit",
    group: "Send · job-bound email",
    title: "A third send",
    expect: "denied limit_reached",
    run: async (e) => {
      await send(e);
      await send(e);
      return denied(await send(e), "limit_reached");
    },
  },
  {
    id: "s-503",
    group: "Send · job-bound email",
    title: "Provider 503",
    expect: "unknown · reservation kept · agent told not to resend",
    run: async (e) => {
      e.setNextFault("http503");
      const r = await send(e);
      return [eq("status", r.status, "unknown"), eq("sends left", left(e), 1), eq("says don't resend", /Do not resend/.test(r.message), true)];
    },
  },
  {
    id: "s-429",
    group: "Send · job-bound email",
    title: "Provider 429",
    expect: "not_sent · reservation released",
    run: async (e) => {
      e.setNextFault("http429");
      const r = await send(e);
      return [eq("status", r.status, "not_sent"), eq("sends left", left(e), 2)];
    },
  },
  {
    id: "s-stop",
    group: "Send · job-bound email",
    title: "STOP, then approve a pending version",
    expect: "approval refused dispatch_stopped",
    run: async (e) => {
      const v1 = await custom(e);
      await e.stop();
      const r = await e.approve(v1.proposalId as string, v1.versionHash as string);
      return [eq("code", r.code, "dispatch_stopped"), eq("provider calls", calls(e), 0)];
    },
  },
  {
    id: "s-expired",
    group: "Send · job-bound email",
    title: "Send after the job expires (clock +1d)",
    expect: "denied job_expired",
    run: async (e) => {
      e.advanceClock(DAY);
      return denied(await send(e), "job_expired");
    },
  },

  // ── Receipts ─────────────────────────────────────────────────────────────
  {
    id: "r-verify",
    group: "Receipts",
    title: "Every receipt verifies and the chain is intact",
    expect: "all verified",
    run: async (e) => {
      await del(e, fixture(e).inScope.slice(0, 10));
      await send(e, "bo@birch.test");
      const signer = await e.signer;
      const list = e.getState().receipts;
      let bad = 0;
      for (const [i, r] of list.entries()) {
        const v = await verifyReceipt(r, signer, list[i - 1]);
        if (!(v.hashOk && v.signatureOk && v.chainOk && v.keyOk)) bad += 1;
      }
      return [eq("receipts", list.length > 5, true), eq("failing", bad, 0)];
    },
  },
  {
    id: "r-tamper",
    group: "Receipts",
    title: "Change one byte of a receipt",
    expect: "invalid",
    run: async (e) => {
      await send(e, "bo@birch.test");
      const signer = await e.signer;
      const list = e.getState().receipts;
      const last = list[list.length - 1];
      if (!last) return [eq("receipt exists", false, true)];
      const v = await verifyReceipt(tamperOneByte(last), signer, list[list.length - 2]);
      return [eq("hash", v.hashOk, false), eq("signature", v.signatureOk, false)];
    },
  },
];

export interface ScenarioRun {
  id: string;
  pass: boolean;
  checks: Check[];
  error?: string;
}

export async function runScenario(s: Scenario, e: Engine): Promise<ScenarioRun> {
  try {
    await e.ready;
    const checks = await s.run(e);
    return { id: s.id, pass: checks.every((c) => c.ok), checks };
  } catch (err) {
    return { id: s.id, pass: false, checks: [], error: err instanceof Error ? err.message : String(err) };
  }
}
