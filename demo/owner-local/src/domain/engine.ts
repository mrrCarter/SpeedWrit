// The local SpeedWrit engine: the code gate, the reservation, the simulated provider and the signed
// receipts, all in memory. It mirrors the spec's shape so the demo shows real decisions:
// - every check runs in code, in a fixed order, before anything reaches the provider;
// - a reservation happens under the lock, and the provider is called once, after it, outside the lock;
// - every state change writes a signed, hash-chained receipt in the same locked step.

import { canonical, createSigner, GENESIS, sha256Hex, type Signer } from "./crypto";
import { ageDays, CONTACTS, OWNER, PRIMARY_CONNECTION_ID, RECAP_TEMPLATE, seedState } from "./data";
import type { Draft } from "./frontDoor";
import type {
  AgentConnection,
  AgentLogEntry,
  AgentResult,
  DeleteProposal,
  DeleteVersion,
  DetailValue,
  Dispatch,
  Job,
  OwnerResult,
  ProviderFault,
  Proposal,
  Receipt,
  ReceiptType,
  SendJob,
  SendProposal,
  SendVersion,
  State,
} from "./types";

type ProviderOutcome =
  | { kind: "ok" }
  | { kind: "partial"; injected: true }
  | { kind: "unknown"; detail: string; injected: true }
  | { kind: "refused"; detail: string; injected: true }
  | { kind: "stopped" };

export interface DeleteInput {
  connectionId?: string;
  jobId: string;
  messageIds: string[];
  operationId?: string;
}

export interface SendInput {
  connectionId?: string;
  prompt?: string;
  jobId: string;
  to: string;
  fields?: Record<string, string>;
  custom?: { subject: string; body: string };
  operationId?: string;
}

const ADDRESS = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const LINK = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|co|app|dev|test|example)\b)/i;

const delay = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? "");
}

export class Engine {
  private s: State;
  private readonly seed: "fresh" | "sample";
  private readonly listeners = new Set<() => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  private ids = 0;
  readonly signer: Promise<Signer>;
  readonly ready: Promise<void>;
  latencyMs: number;

  constructor(options: { latencyMs?: number; signer?: Signer | Promise<Signer>; seed?: "fresh" | "sample" } = {}) {
    this.seed = options.seed ?? "sample";
    this.s = seedState(this.seed);
    this.latencyMs = options.latencyMs ?? 600;
    this.signer = Promise.resolve(options.signer ?? createSigner());
    this.ready = this.lock(() => this.seedReceipts());
  }

  // ── store plumbing ─────────────────────────────────────────────────────────

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = (): State => this.s;

  private commit(): void {
    this.s = { ...this.s, rev: this.s.rev + 1 };
    for (const fn of this.listeners) fn();
  }

  /** One at a time: every read-check-write below runs under this, like one database transaction. */
  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private nextId(prefix: string): string {
    this.ids += 1;
    return `${prefix}_${String(this.ids).padStart(3, "0")}`;
  }

  private async receipt(
    type: ReceiptType,
    f: { jobId?: string | null; proposalId?: string | null; versionHash?: string | null; reason?: string | null; detail?: Record<string, DetailValue> } = {},
  ): Promise<Receipt> {
    const signer = await this.signer;
    const prev = this.s.receipts[this.s.receipts.length - 1];
    const body = {
      seq: this.s.receipts.length + 1,
      ts: new Date(this.s.clock).toISOString(),
      type,
      jobId: f.jobId ?? null,
      proposalId: f.proposalId ?? null,
      versionHash: f.versionHash ?? null,
      reason: f.reason ?? null,
      detail: f.detail ?? {},
      prevHash: prev ? prev.hash : GENESIS,
      keyId: signer.keyId,
    };
    const hash = await sha256Hex(canonical(body));
    const r: Receipt = { ...body, hash, sig: await signer.sign(hash) };
    this.s.receipts.push(r);
    return r;
  }

  private async seedReceipts(): Promise<void> {
    await this.receipt("GMAIL_CONNECTED", { detail: { account: OWNER.email, scopes: this.s.connection.scopes } });
    for (const c of this.s.agentConnections) await this.receipt("AGENT_CONNECTED", { detail: { connection: c.id, label: c.label, kind: c.kind } });
    for (const job of this.s.jobs) {
      await this.receipt("JOB_CONFIRMED", { jobId: job.id, detail: this.jobSummary(job) });
    }
    this.commit();
  }

  private jobSummary(job: Job): Record<string, DetailValue> {
    if (job.kind === "cleanup") {
      return { kind: "cleanup", maxPerBatch: job.maxPerBatch, labels: job.labels, minAgeDays: job.minAgeDays, policyVersion: job.policyVersion, expiresAt: new Date(job.expiresAt).toISOString() };
    }
    return { kind: "send", recipient: job.recipient, maxSends: job.maxSends, templateId: job.templateId, allowCustom: job.allowCustom, agentConnection: job.agentConnectionId, policyVersion: job.policyVersion, expiresAt: new Date(job.expiresAt).toISOString() };
  }

  private recipientOf(job: SendJob): string {
    return job.recipient;
  }

  /** The bearer check: an unknown or revoked connection never reaches the gate (HTTP 401 on the real host). */
  private connection(id: string | undefined): AgentConnection | undefined {
    const c = this.s.agentConnections.find((x) => x.id === (id ?? PRIMARY_CONNECTION_ID));
    if (c && !c.revoked) {
      c.lastUsedAt = this.s.clock;
      return c;
    }
    return undefined;
  }

  private unauthenticated(): AgentResult {
    return { status: "denied", reasonCode: "invalid_token", approvable: false, message: "Not authorized. This agent connection does not exist or was revoked. Reconnect the agent." };
  }

  private job<K extends Job["kind"]>(id: string, kind: K): Extract<Job, { kind: K }> | undefined {
    const job = this.s.jobs.find((j) => j.id === id);
    return job && job.kind === kind ? (job as Extract<Job, { kind: K }>) : undefined;
  }

  private proposal(id: string): Proposal | undefined {
    return this.s.proposals.find((p) => p.id === id);
  }

  private batchInFlight(jobId: string): boolean {
    return this.s.dispatches.some((d) => d.jobId === jobId && d.kind === "delete" && (d.status === "reserved" || d.status === "unknown"));
  }

  private sendsLeft(job: SendJob): number {
    return job.maxSends - job.sendsReserved;
  }

  private log(tool: AgentLogEntry["tool"], input: string, result: AgentResult, meta: { connectionId?: string; prompt?: string; before: number }): AgentResult {
    const withCalls: AgentResult = { ...result, providerCalls: { before: meta.before, after: this.s.providerCalls } };
    this.s.agentLog.unshift({ n: this.s.agentLog.length + 1, at: this.s.clock, connectionId: meta.connectionId ?? PRIMARY_CONNECTION_ID, tool, prompt: meta.prompt ?? "", input, result: withCalls });
    this.commit();
    return withCalls;
  }

  private remember(operationId: string | undefined, result: AgentResult): AgentResult {
    if (operationId) this.s.operations[operationId] = result;
    return result;
  }

  private async deny(
    code: string,
    message: string,
    f: { jobId: string | null; operationId?: string; detail?: Record<string, DetailValue> },
  ): Promise<AgentResult> {
    const r = await this.receipt("PROPOSAL_DENIED", { jobId: f.jobId, reason: code, detail: { ...(f.detail ?? {}), providerCalled: false } });
    return this.remember(f.operationId, { status: "denied", reasonCode: code, approvable: false, message, receiptSeq: r.seq });
  }

  // ── owner controls ─────────────────────────────────────────────────────────

  setNextFault(fault: ProviderFault): void {
    this.s.nextFault = fault;
    this.commit();
  }

  advanceClock(ms: number): void {
    this.s.clock += ms;
    this.commit();
  }

  reset(seed?: "fresh" | "sample"): Promise<void> {
    return this.lock(async () => {
      this.epoch += 1;
      this.ids = 0;
      this.s = seedState(seed ?? this.seed);
      await this.seedReceipts();
    });
  }

  stop(): Promise<OwnerResult> {
    return this.lock(async () => {
      if (!this.s.connection.dispatchEnabled) return { ok: true, message: "STOP is already engaged." };
      // Spec order: our own switch first (instant), then the provider revoke.
      this.s.connection = { ...this.s.connection, dispatchEnabled: false, status: "stopped" };
      await this.receipt("STOP_ENGAGED", { detail: { source: "owner" } });
      await this.receipt("TOKEN_REVOKED", { detail: { provider_answer: "revoked (synthetic)" } });
      this.commit();
      return { ok: true, message: "STOP engaged. Nothing new can be reserved; the provider token is revoked." };
    });
  }

  reconnect(): Promise<OwnerResult> {
    return this.lock(async () => {
      if (this.s.connection.dispatchEnabled) return { ok: true, message: "Already connected." };
      this.s.connection = { ...this.s.connection, dispatchEnabled: true, status: "active" };
      await this.receipt("STOP_RELEASED", { detail: { source: "owner", note: "demo reconnect" } });
      this.commit();
      return { ok: true, message: "Reconnected (demo)." };
    });
  }

  editJob(jobId: string): Promise<OwnerResult> {
    return this.lock(async () => {
      const job = this.s.jobs.find((j) => j.id === jobId);
      if (!job) return { ok: false, code: "job_not_found", message: "No such job." };
      job.policyVersion += 1;
      await this.receipt("JOB_EDITED", { jobId, detail: { policyVersion: job.policyVersion } });
      this.commit();
      return { ok: true, message: `Job edited. Policy version ${job.policyVersion}; anything shown under an older version can no longer be approved.` };
    });
  }

  // ── agent tool: propose_delete ─────────────────────────────────────────────

  async proposeDelete(input: DeleteInput): Promise<AgentResult> {
    const summary = `${input.messageIds.length} id(s): ${input.messageIds.slice(0, 12).join(", ")}${input.messageIds.length > 12 ? ", …" : ""}${input.operationId ? ` · op ${input.operationId}` : ""}`;
    const before = this.s.providerCalls;
    const step = await this.lock(() => this.gateDelete(input));
    const result = "result" in step ? step.result : await this.runDelete(step.dispatch, input.operationId);
    return this.log("propose_delete", summary, result, { connectionId: input.connectionId, before });
  }

  private async gateDelete(input: DeleteInput): Promise<{ result: AgentResult } | { dispatch: Dispatch }> {
    const { jobId, messageIds: ids, operationId } = input;
    const prior = operationId ? this.s.operations[operationId] : undefined;
    if (prior) return { result: prior };
    const deny = async (code: string, message: string, detail?: Record<string, DetailValue>) => ({
      result: await this.deny(code, message, { jobId, operationId, detail }),
    });

    // The checks, in order. The first failure ends it: no proposal, nothing to approve.
    if (!this.connection(input.connectionId)) return { result: this.unauthenticated() };
    if (!this.s.connection.dispatchEnabled) return deny("dispatch_stopped", "Not done. The owner engaged STOP. Nothing can be deleted until they reconnect.");
    const job = this.job(jobId, "cleanup");
    if (!job || job.agentConnectionId !== (input.connectionId ?? PRIMARY_CONNECTION_ID)) {
      return { result: await this.deny("job_not_found", "Not done. No cleanup job with that id is open to this agent.", { jobId: null, operationId }) };
    }
    if (this.s.clock >= job.expiresAt) return deny("job_expired", "Not done. This cleanup job has expired. The owner would need a new job.");
    if (ids.length === 0) return deny("batch_empty", "Not done. The batch has no emails in it.");
    if (new Set(ids).size !== ids.length) return deny("duplicate_ids", "Not done. The batch names the same email more than once. Send each id once.");
    if (ids.length > job.maxPerBatch) {
      return deny(
        "batch_limit_exceeded",
        `Not done. This job deletes at most ${job.maxPerBatch} emails at a time, and this batch had ${ids.length}. This cannot be approved; split it into batches of ${job.maxPerBatch} or fewer.`,
        { requested: ids.length, maxPerBatch: job.maxPerBatch },
      );
    }
    if (this.batchInFlight(job.id)) {
      return deny("batch_in_flight", "Not done. Another batch is still in progress or awaiting the owner's check. One batch at a time.");
    }
    const byId = new Map(this.s.emails.map((e) => [e.id, e]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length) return deny("message_not_found", `Not done. ${missing.length} id(s) don't exist in this mailbox.`, { ids: missing });
    const gone = ids.filter((id) => byId.get(id)?.state === "trash");
    if (gone.length) return deny("already_deleted", `Not done. ${gone.length} email(s) are already in Trash.`, { ids: gone });
    const guarded = ids.filter((id) => {
      const e = byId.get(id);
      return !!e && (e.starred || e.contactId !== null);
    });
    if (guarded.length) {
      return deny("protected_message", `Not done. ${guarded.length} email(s) in the batch are starred or from a contact, and this job never deletes those. Nothing in the batch was deleted.`, { ids: guarded });
    }

    // Gray area: outside the job's labels or age rule. Held for the owner to approve this exact batch.
    const outside = ids.filter((id) => {
      const e = byId.get(id);
      return !!e && (!job.labels.includes(e.label) || ageDays(e, this.s.clock) < job.minAgeDays);
    });
    const reviewReasons = outside.length ? ["outside_scope"] : [];
    const hash = await sha256Hex(canonical({ v: 1, kind: "delete", jobId, policyVersion: job.policyVersion, messageIds: [...ids].sort() }));
    const version: DeleteVersion = { n: 1, hash, policyVersion: job.policyVersion, messageIds: [...ids], reviewReasons, state: "pending" };
    const p: DeleteProposal = { kind: "delete", id: this.nextId("prp"), jobId, createdAt: this.s.clock, status: "pending_approval", currentVersion: 1, versions: [version], failedIds: [], controlledTest: false, ownerObservation: null };
    this.s.proposals.push(p);

    if (reviewReasons.length) {
      const r = await this.receipt("PROPOSAL_HELD", { jobId, proposalId: p.id, versionHash: hash, reason: "outside_scope", detail: { count: ids.length, outside } });
      this.commit();
      return {
        result: this.remember(operationId, {
          status: "pending_approval",
          message: `Not done yet. ${outside.length} of ${ids.length} email(s) are outside this job's labels or age rule, so the owner must approve this exact batch.`,
          proposalId: p.id,
          version: 1,
          versionHash: hash,
          reviewReasons,
          receiptSeq: r.seq,
        }),
      };
    }
    return { dispatch: await this.reserveDelete(p, version, "auto") };
  }

  private async reserveDelete(p: DeleteProposal, v: DeleteVersion, via: "auto" | "owner"): Promise<Dispatch> {
    const d: Dispatch = { id: this.nextId("dsp"), proposalId: p.id, version: v.n, jobId: p.jobId, kind: "delete", status: "reserved" };
    this.s.dispatches.push(d);
    v.state = "dispatched";
    p.status = "dispatching";
    await this.receipt("DISPATCH_RESERVED", { jobId: p.jobId, proposalId: p.id, versionHash: v.hash, detail: { via, count: v.messageIds.length } });
    this.commit();
    return d;
  }

  private async callProvider(): Promise<ProviderOutcome> {
    const fault = this.s.nextFault;
    this.s.nextFault = "ok";
    this.s.providerCalls += 1;
    this.commit();
    await delay(this.latencyMs);
    switch (fault) {
      case "ok":
        return { kind: "ok" };
      case "partial":
        return { kind: "partial", injected: true };
      case "timeout":
        return { kind: "unknown", detail: "timeout", injected: true };
      case "http503":
        return { kind: "unknown", detail: "http_503", injected: true };
      case "http429":
        return { kind: "refused", detail: "http_429", injected: true };
    }
  }

  private async runDelete(d: Dispatch, operationId: string | undefined): Promise<AgentResult> {
    const epoch = this.epoch;
    // Re-read STOP after the reservation committed and before the one provider call.
    const outcome: ProviderOutcome = this.s.connection.dispatchEnabled ? await this.callProvider() : { kind: "stopped" };
    return this.lock(() => this.finishDelete(d, outcome, operationId, epoch));
  }

  private async finishDelete(d: Dispatch, outcome: ProviderOutcome, operationId: string | undefined, epoch: number): Promise<AgentResult> {
    if (epoch !== this.epoch) return { status: "not_done", message: "The demo was reset while this batch was running." };
    const p = this.proposal(d.proposalId) as DeleteProposal;
    const v = p.versions[d.version - 1] as DeleteVersion;
    const ids = v.messageIds;
    const setState = (list: string[], state: "inbox" | "trash" | "unknown") => {
      for (const e of this.s.emails) if (list.includes(e.id)) e.state = state;
    };
    const injected = "injected" in outcome;
    p.controlledTest = injected;
    const base = { proposalId: p.id, version: v.n, versionHash: v.hash, ...(injected ? { controlledTest: true } : {}) };
    let result: AgentResult;

    if (outcome.kind === "ok" || (outcome.kind === "partial" && ids.length < 2)) {
      setState(ids, "trash");
      d.status = "done";
      p.status = "done";
      const r = await this.receipt("PROVIDER_ACCEPTED", { jobId: p.jobId, proposalId: p.id, versionHash: v.hash, detail: { deleted: ids.length } });
      result = { ...base, status: "done", deleted: ids.length, failed: 0, receiptSeq: r.seq, message: `Done. ${ids.length} email(s) moved to Trash. The provider confirmed each one.` };
    } else if (outcome.kind === "partial") {
      const failN = Math.min(3, ids.length - 1);
      const ok = ids.slice(0, ids.length - failN);
      const failed = ids.slice(ids.length - failN);
      setState(ok, "trash");
      d.status = "partial";
      p.status = "partial";
      p.failedIds = failed;
      const r = await this.receipt("PARTIAL", { jobId: p.jobId, proposalId: p.id, versionHash: v.hash, reason: "provider_partial", detail: { deleted: ok.length, failed: failed.length, failedIds: failed, injected: true } });
      result = { ...base, status: "partial", deleted: ok.length, failed: failed.length, receiptSeq: r.seq, message: `Partly done. ${ok.length} moved to Trash; ${failed.length} were not. Nothing was retried. Tell the owner which ones remain.` };
    } else if (outcome.kind === "unknown") {
      setState(ids, "unknown");
      d.status = "unknown";
      p.status = "unknown";
      const r = await this.receipt("OUTCOME_UNKNOWN", { jobId: p.jobId, proposalId: p.id, versionHash: v.hash, reason: outcome.detail, detail: { count: ids.length, injected: true } });
      result = { ...base, status: "unknown", receiptSeq: r.seq, message: "Outcome unknown. The provider did not confirm. Do not retry. The owner will check, and no other batch runs until then." };
    } else {
      const reason = outcome.kind === "stopped" ? "stopped_before_call" : outcome.detail;
      d.status = "not_done";
      p.status = "not_done";
      const r = await this.receipt("NOT_DONE", { jobId: p.jobId, proposalId: p.id, versionHash: v.hash, reason, detail: { count: ids.length, injected: outcome.kind !== "stopped" } });
      result = {
        ...base,
        status: "not_done",
        reasonCode: reason,
        receiptSeq: r.seq,
        message: outcome.kind === "stopped" ? "Not done. The owner engaged STOP before the provider was called." : "Not done. The provider refused (rate limited). Nothing was deleted; try again later.",
      };
    }
    this.commit();
    return this.remember(operationId, result);
  }

  // ── agent tool: propose_send / revise_proposal ─────────────────────────────

  async proposeSend(input: SendInput): Promise<AgentResult> {
    const summary = `to ${JSON.stringify(input.to)} · ${input.custom ? "custom wording" : `fields ${JSON.stringify(input.fields ?? {})}`}${input.operationId ? ` · op ${input.operationId}` : ""}`;
    const before = this.s.providerCalls;
    const step = await this.lock(() => this.gateSend(input));
    const result = "result" in step ? step.result : await this.runSend(step.dispatch, input.operationId);
    return this.log("propose_send", summary, result, { connectionId: input.connectionId, prompt: input.prompt, before });
  }

  private validateFields(fields: Record<string, string>): { code: string; message: string } | null {
    const allowed = Object.keys(RECAP_TEMPLATE.fields) as (keyof typeof RECAP_TEMPLATE.fields)[];
    for (const key of Object.keys(fields)) {
      if (!allowed.includes(key as keyof typeof RECAP_TEMPLATE.fields)) return { code: "field_not_allowed", message: `Not sent. "${key}" is not a field of this job's template.` };
    }
    for (const key of allowed) {
      const value = fields[key];
      if (typeof value !== "string" || value.trim() === "") return { code: "field_invalid", message: `Not sent. The field "${key}" is missing.` };
      if (value.length > RECAP_TEMPLATE.fields[key].max) return { code: "field_invalid", message: `Not sent. The field "${key}" is longer than ${RECAP_TEMPLATE.fields[key].max} characters.` };
      if (LINK.test(value)) return { code: "field_invalid", message: `Not sent. The field "${key}" contains a link, and this job sends no links.` };
      if (key === "topic" && /[\r\n]/.test(value)) return { code: "field_invalid", message: 'Not sent. The field "topic" contains a line break.' };
    }
    return null;
  }

  private async sendVersion(job: SendJob, to: string, n: number, input: Pick<SendInput, "fields" | "custom">): Promise<SendVersion> {
    const first = CONTACTS.find((c) => c.email === to)?.name.split(" ")[0] ?? "";
    const custom = !!input.custom;
    const subject = custom ? (input.custom as { subject: string }).subject : fill(RECAP_TEMPLATE.subject, { ...input.fields });
    const body = custom ? (input.custom as { body: string }).body : fill(RECAP_TEMPLATE.body, { ...input.fields, first_name: first });
    const hash = await sha256Hex(
      canonical({ v: 1, kind: "send", jobId: job.id, policyVersion: job.policyVersion, provider: "gmail", sender: OWNER.email, recipient: to, templateId: custom ? null : job.templateId, fields: custom ? null : input.fields, custom, subject, body_sha256: await sha256Hex(body) }),
    );
    return { n, hash, policyVersion: job.policyVersion, to, subject, body, custom, reviewReasons: custom ? ["custom_content"] : [], state: "pending" };
  }

  private async gateSend(input: SendInput): Promise<{ result: AgentResult } | { dispatch: Dispatch }> {
    const { jobId, to, operationId } = input;
    const prior = operationId ? this.s.operations[operationId] : undefined;
    if (prior) return { result: prior };
    const deny = async (code: string, message: string, detail?: Record<string, DetailValue>) => ({
      result: await this.deny(code, message, { jobId, operationId, detail }),
    });

    if (!this.connection(input.connectionId)) return { result: this.unauthenticated() };
    if (!this.s.connection.dispatchEnabled) return deny("dispatch_stopped", "Not sent. The owner engaged STOP.");
    const job = this.job(jobId, "send");
    if (!job || job.agentConnectionId !== (input.connectionId ?? PRIMARY_CONNECTION_ID)) {
      return { result: await this.deny("job_not_found", "Not sent. No send job with that id is open to this agent.", { jobId: null, operationId }) };
    }
    if (this.s.clock >= job.expiresAt) return deny("job_expired", "Not sent. This job has expired. The owner would need a new job.");
    if (typeof to !== "string" || !ADDRESS.test(to.trim()) || to.trim() !== to) {
      return deny("recipient_invalid", "Not sent. The recipient must be exactly one plain address: no display name, list or line break.");
    }
    const allowedTo = this.recipientOf(job);
    if (to.toLowerCase() !== allowedTo) {
      return deny("recipient_not_in_job", `Not sent. This job may only email ${allowedTo}. This cannot be approved. The owner would need a separate job.`, { attempted: to });
    }
    if (!input.custom) {
      const bad = this.validateFields(input.fields ?? {});
      if (bad) return deny(bad.code, bad.message);
    } else if (!job.allowCustom) {
      return deny("custom_not_allowed", "Not sent. This job only sends its template. Wording outside the template is never allowed for this job.");
    } else if (LINK.test(input.custom.body) || LINK.test(input.custom.subject)) {
      return deny("field_invalid", "Not sent. The custom text contains a link, and this job sends no links.");
    }
    if (this.sendsLeft(job) <= 0) return deny("limit_reached", `Not sent. This job's ${job.maxSends} sends are used up.`);

    const version = await this.sendVersion(job, to, 1, input);
    const p: SendProposal = { kind: "send", id: this.nextId("prp"), jobId, createdAt: this.s.clock, status: "pending_approval", currentVersion: 1, versions: [version], providerMessageId: null, deliveryWitnessed: false, controlledTest: false, ownerObservation: null };
    this.s.proposals.push(p);
    if (version.reviewReasons.length) {
      const r = await this.receipt("PROPOSAL_HELD", { jobId, proposalId: p.id, versionHash: version.hash, reason: "custom_content", detail: { version: 1 } });
      this.commit();
      return {
        result: this.remember(operationId, {
          status: "pending_approval",
          message: "Not sent yet. Version 1 is waiting for the owner's approval (custom wording).",
          proposalId: p.id,
          version: 1,
          versionHash: version.hash,
          reviewReasons: version.reviewReasons,
          receiptSeq: r.seq,
        }),
      };
    }
    return { dispatch: await this.reserveSend(job, p, version, "auto") };
  }

  async reviseSend(proposalId: string, change: Pick<SendInput, "fields" | "custom" | "prompt" | "connectionId">): Promise<AgentResult> {
    const before = this.s.providerCalls;
    const result = await this.lock(async (): Promise<AgentResult> => {
      if (!this.connection(change.connectionId)) return this.unauthenticated();
      const p = this.proposal(proposalId);
      const bound = p ? this.s.jobs.find((j) => j.id === p.jobId)?.agentConnectionId : undefined;
      // Only the connection the job is bound to may revise its proposals; anyone else sees nothing.
      if (!p || p.kind !== "send" || bound !== (change.connectionId ?? PRIMARY_CONNECTION_ID)) {
        return { status: "denied", reasonCode: "proposal_not_found", message: "Not revised. No such proposal." };
      }
      if (p.status !== "pending_approval") return { status: "denied", reasonCode: "not_pending", message: "Not revised. That proposal is no longer waiting for approval." };
      const job = this.job(p.jobId, "send") as SendJob;
      const old = p.versions[p.currentVersion - 1] as SendVersion;
      const next = await this.sendVersion(job, old.to, old.n + 1, change);
      // A revision is always reviewed: the owner approves the version they can see.
      next.reviewReasons = next.custom ? ["custom_content"] : ["revised"];
      old.state = "superseded";
      p.versions.push(next);
      p.currentVersion = next.n;
      await this.receipt("VERSION_SUPERSEDED", { jobId: p.jobId, proposalId: p.id, versionHash: old.hash, detail: { version: old.n, supersededBy: next.n } });
      const r = await this.receipt("PROPOSAL_HELD", { jobId: p.jobId, proposalId: p.id, versionHash: next.hash, reason: next.reviewReasons[0] ?? null, detail: { version: next.n } });
      this.commit();
      return { status: "pending_approval", message: `Not sent yet. Version ${next.n} is waiting for the owner's approval.`, proposalId: p.id, version: next.n, versionHash: next.hash, reviewReasons: next.reviewReasons, receiptSeq: r.seq };
    });
    return this.log("revise_proposal", `${proposalId} → ${change.custom ? "custom wording" : "fields"}`, result, { connectionId: change.connectionId, before, prompt: change.prompt });
  }

  private async reserveSend(job: SendJob, p: SendProposal, v: SendVersion, via: "auto" | "owner"): Promise<Dispatch> {
    job.sendsReserved += 1;
    const d: Dispatch = { id: this.nextId("dsp"), proposalId: p.id, version: v.n, jobId: job.id, kind: "send", status: "reserved" };
    this.s.dispatches.push(d);
    v.state = "dispatched";
    p.status = "dispatching";
    await this.receipt("DISPATCH_RESERVED", { jobId: job.id, proposalId: p.id, versionHash: v.hash, detail: { via, sendsReserved: job.sendsReserved, maxSends: job.maxSends } });
    this.commit();
    return d;
  }

  private async runSend(d: Dispatch, operationId: string | undefined): Promise<AgentResult> {
    const epoch = this.epoch;
    const outcome: ProviderOutcome = this.s.connection.dispatchEnabled ? await this.callProvider() : { kind: "stopped" };
    return this.lock(() => this.finishSend(d, outcome, operationId, epoch));
  }

  private async finishSend(d: Dispatch, outcome: ProviderOutcome, operationId: string | undefined, epoch: number): Promise<AgentResult> {
    if (epoch !== this.epoch) return { status: "not_sent", message: "The demo was reset while this send was running." };
    const p = this.proposal(d.proposalId) as SendProposal;
    const v = p.versions[d.version - 1] as SendVersion;
    const job = this.job(p.jobId, "send") as SendJob;
    const injected = "injected" in outcome && outcome.kind !== "partial";
    p.controlledTest = injected;
    const base = { proposalId: p.id, version: v.n, versionHash: v.hash, ...(injected ? { controlledTest: true } : {}) };
    let result: AgentResult;
    if (outcome.kind === "ok" || outcome.kind === "partial") {
      d.status = "done";
      p.status = "sent";
      p.providerMessageId = `gm_${v.hash.slice(0, 12)}`;
      const r = await this.receipt("PROVIDER_ACCEPTED", { jobId: job.id, proposalId: p.id, versionHash: v.hash, detail: { providerMessageId: p.providerMessageId, to: v.to } });
      result = { ...base, status: "sent", sendsLeft: this.sendsLeft(job), receiptSeq: r.seq, message: `Sent to ${v.to}. The provider accepted it. ${this.sendsLeft(job)} of ${job.maxSends} sends left.` };
    } else if (outcome.kind === "unknown") {
      d.status = "unknown";
      p.status = "unknown";
      const r = await this.receipt("OUTCOME_UNKNOWN", { jobId: job.id, proposalId: p.id, versionHash: v.hash, reason: outcome.detail, detail: { injected: true, slotKept: true } });
      result = { ...base, status: "unknown", sendsLeft: this.sendsLeft(job), receiptSeq: r.seq, message: "Outcome unknown. The provider did not confirm. Do not resend. The owner will check." };
    } else {
      const reason = outcome.kind === "stopped" ? "stopped_before_call" : outcome.detail;
      job.sendsReserved -= 1;
      d.status = "not_done";
      p.status = "not_sent";
      const r = await this.receipt("NOT_DONE", { jobId: job.id, proposalId: p.id, versionHash: v.hash, reason, detail: { released: true, injected: outcome.kind !== "stopped" } });
      result = { ...base, status: "not_sent", reasonCode: reason, sendsLeft: this.sendsLeft(job), receiptSeq: r.seq, message: `Not sent (${reason}). The send was released; ${this.sendsLeft(job)} of ${job.maxSends} left.` };
    }
    this.commit();
    return this.remember(operationId, result);
  }

  // ── owner decisions ────────────────────────────────────────────────────────

  async approve(proposalId: string, versionHash: string): Promise<OwnerResult> {
    const step = await this.lock(() => this.gateApproval(proposalId, versionHash));
    if ("result" in step) return step.result;
    const agentResult = step.kind === "delete" ? await this.runDelete(step.dispatch, undefined) : await this.runSend(step.dispatch, undefined);
    return { ok: true, message: `Approved. ${agentResult.message}`, agentResult };
  }

  private async gateApproval(proposalId: string, versionHash: string): Promise<{ result: OwnerResult } | { kind: "delete" | "send"; dispatch: Dispatch }> {
    const p = this.proposal(proposalId);
    if (!p) return { result: { ok: false, code: "not_found", message: "No such proposal." } };
    const current = p.versions[p.currentVersion - 1];
    if (!current) return { result: { ok: false, code: "not_found", message: "No such version." } };
    const refuse = async (code: string, message: string): Promise<{ result: OwnerResult }> => {
      await this.receipt("APPROVAL_REFUSED", { jobId: p.jobId, proposalId: p.id, versionHash, reason: code });
      this.commit();
      return { result: { ok: false, code, message } };
    };
    if (versionHash !== current.hash) {
      const older = p.versions.some((v) => v.hash === versionHash);
      return refuse(older ? "superseded" : "unknown_version", older ? "409 superseded. That version was replaced; approve the version on screen." : "That hash is not a version of this proposal.");
    }
    if (current.state !== "pending") return { result: { ok: false, code: "already_decided", message: "Already decided. Nothing new happened." } };
    const job = this.s.jobs.find((j) => j.id === p.jobId) as Job;
    if (!this.s.connection.dispatchEnabled) {
      const free = job.kind === "send" ? ` The job still has ${this.sendsLeft(job)} of ${job.maxSends} sends free, so this is STOP, not the limit.` : "";
      return refuse("dispatch_stopped", `STOP is engaged, so nothing can be approved into sending.${free}`);
    }
    if (this.s.clock >= job.expiresAt) return refuse("job_expired", "The job has expired.");
    if (current.policyVersion !== job.policyVersion) return refuse("policy_changed", "The job was edited after this was shown. Ask the agent to propose again.");

    if (p.kind === "delete" && job.kind === "cleanup") {
      const v = current as DeleteVersion;
      if (this.batchInFlight(job.id)) return refuse("batch_in_flight", "Another batch is still in progress or unresolved. One batch at a time.");
      const gone = v.messageIds.filter((id) => this.s.emails.find((e) => e.id === id)?.state !== "inbox");
      if (gone.length) return refuse("already_deleted", `${gone.length} email(s) in this batch are no longer in the inbox. Ask the agent to propose again.`);
      await this.receipt("APPROVED", { jobId: job.id, proposalId: p.id, versionHash, detail: { source: "owner", version: v.n } });
      return { kind: "delete", dispatch: await this.reserveDelete(p, v, "owner") };
    }
    if (p.kind === "send" && job.kind === "send") {
      const v = current as SendVersion;
      if (this.sendsLeft(job) <= 0) return refuse("limit_reached", "This job's sends are used up.");
      await this.receipt("APPROVED", { jobId: job.id, proposalId: p.id, versionHash, detail: { source: "owner", version: v.n } });
      return { kind: "send", dispatch: await this.reserveSend(job, p, v, "owner") };
    }
    return { result: { ok: false, code: "kind_mismatch", message: "Proposal and job kinds differ." } };
  }

  denyProposal(proposalId: string): Promise<OwnerResult> {
    return this.lock(async () => {
      const p = this.proposal(proposalId);
      const v = p?.versions[p.currentVersion - 1];
      if (!p || !v || v.state !== "pending") return { ok: false, code: "not_pending", message: "Nothing to deny." };
      v.state = "denied";
      p.status = "denied_by_owner";
      await this.receipt("DENIED_BY_OWNER", { jobId: p.jobId, proposalId: p.id, versionHash: v.hash });
      this.commit();
      return { ok: true, message: "Denied. Nothing was done." };
    });
  }

  /**
   * UNKNOWN is resolved only by the owner, and nothing ever resends. Carter's rule (#49159): "It did not arrive"
   * records the observation and KEEPS the send slot, because a send-only connection cannot prove it never left.
   */
  resolveUnknown(proposalId: string, arrived: boolean): Promise<OwnerResult> {
    return this.lock(async () => {
      const p = this.proposal(proposalId);
      const d = this.s.dispatches.find((x) => x.proposalId === proposalId && x.status === "unknown");
      if (!p || !d || p.ownerObservation !== null) return { ok: false, code: "not_unknown", message: "Nothing to resolve." };
      const v = p.versions[d.version - 1];
      p.ownerObservation = arrived ? "arrived" : "not_arrived";
      if (p.kind === "delete") {
        // Lab job: one batch at a time, so the owner's answer releases the in-flight batch.
        d.status = "resolved";
        const ids = (v as DeleteVersion).messageIds;
        for (const e of this.s.emails) if (ids.includes(e.id)) e.state = arrived ? "trash" : "inbox";
        p.status = arrived ? "done" : "not_done";
      } else if (arrived) {
        d.status = "resolved";
        p.status = "sent";
        p.deliveryWitnessed = true;
      }
      await this.receipt("OUTCOME_RESOLVED", {
        jobId: p.jobId,
        proposalId: p.id,
        versionHash: v?.hash ?? null,
        detail: { source: "owner", observation: arrived ? "arrived" : "not_arrived", slotKept: p.kind === "send" },
      });
      this.commit();
      return {
        ok: true,
        message: arrived
          ? "Recorded: you saw it arrive."
          : p.kind === "send"
            ? "Recorded: you didn't see it arrive. The slot stays used, and nothing resends."
            : "Recorded: it did not happen. The next batch may run.",
      };
    });
  }

  /** The owner saw the message in the recipient's inbox: a separate fact from the provider's acceptance. */
  witnessDelivery(proposalId: string): Promise<OwnerResult> {
    return this.lock(async () => {
      const p = this.proposal(proposalId);
      if (!p || p.kind !== "send" || p.status !== "sent" || p.deliveryWitnessed) return { ok: false, code: "not_sent", message: "Nothing to witness." };
      p.deliveryWitnessed = true;
      await this.receipt("DELIVERY_WITNESSED", { jobId: p.jobId, proposalId: p.id, versionHash: p.versions[p.currentVersion - 1]?.hash ?? null, detail: { source: "owner", inbox: "owned test inbox" } });
      this.commit();
      return { ok: true, message: "Recorded: you saw it in the recipient's inbox." };
    });
  }

  // ── connections and jobs (owner) ───────────────────────────────────────────

  connectAgent(label: string, kind: "oauth" | "fallback"): Promise<{ ok: boolean; message: string; connection?: AgentConnection; secretUrl?: string }> {
    return this.lock(async () => {
      const name = label.trim() || (kind === "oauth" ? "ChatGPT-SpeedWrit" : "ChatGPT-SpeedWrit (fallback)");
      const c: AgentConnection = { id: this.nextId("ac"), label: name, kind, createdAt: this.s.clock, lastUsedAt: null, revoked: false };
      this.s.agentConnections.push(c);
      await this.receipt("AGENT_CONNECTED", { detail: { connection: c.id, label: c.label, kind } });
      this.commit();
      if (kind === "oauth") return { ok: true, message: `Connected ${c.label} over OAuth.`, connection: c };
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      const secret = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      return { ok: true, message: "Agent connection created. Sending still requires a job you approve.", connection: c, secretUrl: `https://speedwrit.local/mcp/c/${secret}` };
    });
  }

  revokeAgent(connectionId: string): Promise<OwnerResult> {
    return this.lock(async () => {
      const c = this.s.agentConnections.find((x) => x.id === connectionId);
      if (!c || c.revoked) return { ok: false, code: "not_found", message: "No such connection." };
      c.revoked = true;
      await this.receipt("AGENT_REVOKED", { detail: { connection: c.id, label: c.label } });
      this.commit();
      return { ok: true, message: `Revoked ${c.label}. Its calls now fail before the gate.` };
    });
  }

  /** The front door's draft, confirmed by the owner: binds the job to one agent connection. */
  confirmSendJob(draft: Draft, connectionId: string): Promise<OwnerResult & { jobId?: string }> {
    return this.lock(async () => {
      if (!draft.recipient || !draft.maxSends || !draft.expiresAt) return { ok: false, code: "incomplete", message: "The draft is missing a limit." };
      const c = this.s.agentConnections.find((x) => x.id === connectionId && !x.revoked);
      if (!c) return { ok: false, code: "no_agent", message: "Connect an agent first." };
      const name = CONTACTS.find((x) => x.email === draft.recipient)?.name.split(" ")[0] ?? draft.recipient;
      const job: SendJob = {
        kind: "send",
        id: this.nextId("job"),
        title: `Recap to ${name}`,
        purpose: `Send ${name} a recap of our call.`,
        recipient: draft.recipient,
        templateId: RECAP_TEMPLATE.id,
        maxSends: draft.maxSends,
        sendsReserved: 0,
        allowCustom: draft.allowCustom,
        expiresAt: draft.expiresAt,
        agentConnectionId: c.id,
        policyVersion: 1,
      };
      this.s.jobs.push(job);
      await this.receipt("JOB_CONFIRMED", { jobId: job.id, detail: this.jobSummary(job) });
      this.commit();
      return { ok: true, message: `Job confirmed: ${job.title}, ${job.maxSends} sends.`, jobId: job.id };
    });
  }

  /** Agent tool: list_jobs. Read-only; only jobs bound to this connection. */
  async listJobs(connectionId?: string, prompt?: string): Promise<AgentResult> {
    const before = this.s.providerCalls;
    const result = await this.lock(async (): Promise<AgentResult> => {
      const c = this.connection(connectionId);
      if (!c) return this.unauthenticated();
      const open = this.s.jobs.filter((j): j is SendJob => j.kind === "send" && j.agentConnectionId === c.id && this.s.clock < j.expiresAt && this.sendsLeft(j) > 0);
      return {
        status: "jobs",
        message: open.length ? `${open.length} active job(s): ${open.map((j) => `${j.title} (${this.sendsLeft(j)} of ${j.maxSends} sends left)`).join("; ")}.` : "No active jobs.",
        jobs: open.map((j) => ({ id: j.id, title: j.title, recipient: j.recipient, sendsLeft: this.sendsLeft(j), expiresAt: new Date(j.expiresAt).toISOString(), custom: j.allowCustom ? "ask the owner" : "never" })),
      };
    });
    return this.log("list_jobs", "{}", result, { connectionId, prompt, before });
  }
}
