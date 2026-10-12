import type { KeyObject } from "node:crypto";
import type { Pool } from "pg";

import type {
  ConnectionStatus,
  DispatchOutcome,
  JobSendCore,
  JobStatus,
  MailOutcome,
  MailProvider,
  ProposalStatus,
  ReceiptFields,
  ReceiptValue,
  VersionState,
} from "../contract/types.js";
import type { Review } from "../ai-review/provider.js";
import type { AskMeReason, DispatchRefusal, NeverReason } from "../contract/reasons.js";
import type { Job } from "../contract/types.js";
import { createReceiptWriter, type WriteReceipt } from "../receipts/store.js";
import { isUniqueViolation, newId, one, withTx, type ExecutorTx } from "./db/tx.js";
import { normalizeAddress } from "./render/address.js";
import { storedVersionIntact, type Draft, type VersionCanonical } from "./render/render.js";
import { sha256Hex } from "./hash.js";

// Dispatch, STOP and UNKNOWN (spec: "Dispatch, STOP and UNKNOWN" and the transactional core of
// "Approval and revision"). The shape follows the spec's pseudo-code:
//
//   reserve       one transaction, rows locked in order, the clock read after the locks;
//   dispatch_auto BEGIN, lock, reserve, COMMIT; a refusal rolls back, then DISPATCH_REFUSED;
//   approve       the approval and the reservation in one transaction; a refusal rolls both back,
//                 then APPROVAL_REFUSED;
//   sendReserved  outside any transaction: re-read the STOP flag, check the demo allowlist, one
//                 provider call with a timeout, no retry at any layer;
//   finish        its own transaction; NOT_SENT releases the reservation.
//
// Lock order everywhere: proposal, version, job, connection, then the version's dispatch row, then
// the owner's receipt counter, which writeReceipt takes last.

export const PROVIDER_TIMEOUT_MS = 20_000;
export const SWEEP_AFTER_MS = 60_000;

/** The connection a provider call goes out on. */
export interface ConnectionRef {
  id: string;
  provider: string;
  account_email: string;
}

export interface RevokeResult {
  ok: boolean;
  /** The provider's answer, e.g. an HTTP status. Integers or strings only. */
  status: number | string;
}

export interface ExecutorDeps {
  pool: Pool;
  /** The receipt signing key: an Ed25519 private key or its PKCS#8 PEM (a deploy secret). */
  signingKey: KeyObject | string;
  /**
   * The MailProvider for one connection. It gets its access token itself (custody decrypt and
   * refresh inside the executor process; see createGmailProvider), so no token passes through here.
   */
  mailProviderFor(connection: ConnectionRef): MailProvider;
  /** DEMO_RECIPIENTS: when set, any other recipient is NOT SENT right before the provider call. */
  demoRecipients?: readonly string[] | null;
  /** Revokes the provider grant during STOP. Without it, STOP still engages but revokes nothing. */
  revoke?(connection: ConnectionRef): Promise<RevokeResult>;
  /** The provider call's budget. Default 20 s. */
  providerTimeoutMs?: number;
  /** How long a dispatch may stay reserved before the sweeper calls it UNKNOWN. Default 60 s. */
  sweepAfterMs?: number;
}

export class NotFoundError extends Error {
  readonly status = 404;

  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}

/** A reservation, approval or revision refused with a contract reason. Rolls its transaction back. */
export class Refusal extends Error {
  readonly reason: DispatchRefusal;

  constructor(reason: DispatchRefusal) {
    super(`refused: ${reason}`);
    this.name = "Refusal";
    this.reason = reason;
  }
}

/** A committed reservation, ready for exactly one provider call. */
export interface Reservation {
  dispatchId: string;
  versionId: string;
  proposalId: string;
  owner: string;
  via: string;
  connection: ConnectionRef;
  recipient: string;
  /** The stored MIME bytes. Nothing is rendered again after a version is stored. */
  mime: Uint8Array;
  receiptId: string;
}

export type ApproveResult = { ok: true; reservation: Reservation } | { ok: false; outcome: DispatchOutcome };

/** The most versions one proposal may have (spec: revise, "p.current_version < 5"). */
export const MAX_VERSIONS = 5;

/**
 * A version rendered (and reviewed) before any transaction opens: what store_version and a revision
 * insert. No external call runs while a transaction is open.
 */
export interface PreparedVersion {
  /** The job's authority the version was rendered under. */
  job: Job;
  /** The agent connection's declared label, for the receipts. */
  clientLabel: string;
  draft: Draft;
  canonical: VersionCanonical;
  sha256: string;
  reasons: AskMeReason[];
  /** The AI review that ran, if one did; recorded as AI_REVIEW in the same transaction. */
  review: Review | null;
  /** The tool call this version answers, for the attempts row (its arguments only as a hash). */
  attempt: { agentConnectionId: string; tool: "propose_send" | "revise_proposal"; argsSha256: string };
}

/** A stored version. */
export interface StoredVersion {
  proposalId: string;
  versionId: string;
  version: number;
  sha256: string;
}

/** A refused tool call: the attempt row and ATTEMPT_DENIED, nothing else. */
export interface Denial {
  owner: string;
  agentConnectionId: string;
  clientLabel: string;
  /** The job the call named, when it is one of this connection's; null otherwise. */
  job: { id: string; policy_version: number } | null;
  tool: string;
  argsSha256: string;
  reason: NeverReason;
  /** The field that broke its rule, when the gate names one the job defines. */
  field?: string;
}

export type ResolveResult = { resolved: true; receipt_id: string } | { resolved: false; reason: "not_unknown" };

interface ProposalRow {
  id: string;
  job_id: string;
  current_version: number;
  status: ProposalStatus;
}

interface VersionRow {
  id: string;
  proposal_id: string;
  version: number;
  recipient: string;
  mime: Buffer;
  canonical: VersionCanonical;
  sha256: string;
  policy_version: number;
  review_reasons: string[];
  state: VersionState;
}

interface JobRow {
  id: string;
  owner_id: string;
  connection_id: string;
  agent_connection_id: string;
  client_label: string;
  recipient_email: string;
  max_sends: number;
  sends_reserved: number;
  expires_at: Date;
  auto_send: boolean;
  status: JobStatus;
  policy_version: number;
}

interface ConnectionRow {
  id: string;
  owner_id: string;
  provider: string;
  account_email: string;
  dispatch_enabled: boolean;
  status: ConnectionStatus;
}

interface Locked {
  p: ProposalRow;
  v: VersionRow;
  job: JobRow;
  con: ConnectionRow;
}

const VERSION_COLUMNS =
  "id, proposal_id, version, recipient, mime, canonical, sha256, policy_version, review_reasons, state";

/**
 * Locks one proposal version and everything it needs, in the spec's order: proposal, version, job,
 * connection. The owner's receipt counter comes last, inside writeReceipt.
 */
async function lockInOrder(tx: ExecutorTx, proposalId: string, version: { id: string } | { number: number }): Promise<Locked> {
  const c = tx.client;
  const p = await one<ProposalRow>(c, "SELECT id, job_id, current_version, status FROM proposals WHERE id = $1 FOR UPDATE", [
    proposalId,
  ]);
  if (!p) throw new NotFoundError("proposal");
  const v =
    "id" in version
      ? await one<VersionRow>(c, `SELECT ${VERSION_COLUMNS} FROM proposal_versions WHERE id = $1 AND proposal_id = $2 FOR UPDATE`, [
          version.id,
          p.id,
        ])
      : await one<VersionRow>(
          c,
          `SELECT ${VERSION_COLUMNS} FROM proposal_versions WHERE proposal_id = $1 AND version = $2 FOR UPDATE`,
          [p.id, version.number],
        );
  if (!v) throw new NotFoundError("proposal version");
  const job = await one<JobRow>(
    c,
    `SELECT j.id, j.owner_id, j.connection_id, j.agent_connection_id, a.client_label, j.recipient_email, j.max_sends,
            j.sends_reserved, j.expires_at, j.auto_send, j.status, j.policy_version
     FROM jobs j JOIN agent_connections a ON a.id = j.agent_connection_id
     WHERE j.id = $1 FOR UPDATE OF j`,
    [p.job_id],
  );
  if (!job || job.owner_id !== tx.owner) throw new NotFoundError("job");
  const con = await one<ConnectionRow>(
    c,
    "SELECT id, owner_id, provider, account_email, dispatch_enabled, status FROM connections WHERE id = $1 FOR UPDATE",
    [job.connection_id],
  );
  if (!con) throw new NotFoundError("connection");
  return { p, v, job, con };
}

async function lockVersion(tx: ExecutorTx, versionId: string): Promise<Locked> {
  // A version's proposal never changes (invariant 1), so this unlocked read is safe.
  const ref = await one<{ proposal_id: string }>(tx.client, "SELECT proposal_id FROM proposal_versions WHERE id = $1", [versionId]);
  if (!ref) throw new NotFoundError("proposal version");
  return lockInOrder(tx, ref.proposal_id, { id: versionId });
}

/** The receipt fields that name the authority a decision ran under. */
function receiptContext({ p, v, job }: Locked): ReceiptFields {
  return {
    job: job.id,
    policy_version: job.policy_version,
    agent_connection: job.agent_connection_id,
    client_label: job.client_label,
    proposal: p.id,
    version: v.version,
    version_sha256: v.sha256,
  };
}

/** The stored canonical still describes this row, job and connection (beyond the hash checks). */
function canonicalMatchesRows({ v, job, con }: Locked): boolean {
  const c = v.canonical;
  return (
    c !== null &&
    typeof c === "object" &&
    c.job_id === job.id &&
    c.recipient === v.recipient &&
    c.policy_version === v.policy_version &&
    c.connection_id === con.id &&
    c.provider === con.provider &&
    c.sender === con.account_email
  );
}

/** Wraps a sync or async value so a slow provider resolves as a timeout instead of hanging forever. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    // Kept referenced: the budget must fire even if nothing else holds the process open.
    timer = setTimeout(() => reject(Object.assign(new Error("provider call timed out"), { code: "ETIMEDOUT" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** An error class for a thrown provider error. Codes only: messages can carry request details. */
function errorClassOf(error: unknown): string {
  const code = (error as { code?: unknown; name?: unknown } | null)?.code;
  if (code === "ETIMEDOUT") return "timeout";
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(code)) return code;
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  return "exception";
}

/** Trusts only a well-formed MailOutcome; anything else is UNKNOWN. */
function checkedOutcome(value: unknown): MailOutcome {
  const o = value as Partial<{ status: unknown; providerMessageId: unknown; errorClass: unknown }> | null;
  if (o?.status === "accepted" && typeof o.providerMessageId === "string" && o.providerMessageId !== "") {
    return { status: "accepted", providerMessageId: o.providerMessageId };
  }
  if ((o?.status === "not_sent" || o?.status === "unknown") && typeof o.errorClass === "string" && o.errorClass !== "") {
    return { status: o.status, errorClass: o.errorClass };
  }
  return { status: "unknown", errorClass: "invalid_provider_outcome" };
}

const OUTCOME_RECEIPT = { accepted: "PROVIDER_ACCEPTED", not_sent: "NOT_SENT", unknown: "OUTCOME_UNKNOWN" } as const;

/** Inserts one immutable version row (invariant 1: only `state` may change after this). */
async function insertVersion(tx: ExecutorTx, id: string, proposalId: string, version: number, prepared: PreparedVersion): Promise<void> {
  const { draft } = prepared;
  await tx.client.query(
    `INSERT INTO proposal_versions (id, proposal_id, version, recipient, subject, body, mime, canonical, sha256, policy_version, review_reasons)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11)`,
    [
      id,
      proposalId,
      version,
      draft.recipient,
      draft.subject,
      draft.body,
      Buffer.from(draft.mime),
      JSON.stringify(prepared.canonical),
      prepared.sha256,
      prepared.job.policy_version,
      prepared.reasons,
    ],
  );
}

/** record_attempt for a call that produced a version. The arguments are kept only as their hash. */
async function recordAttempt(tx: ExecutorTx, prepared: PreparedVersion, decision: "proposed" | "held" | "revised"): Promise<void> {
  await tx.client.query(
    "INSERT INTO attempts (id, job_id, agent_connection_id, tool, args_sha256, decision) VALUES ($1, $2, $3, $4, $5, $6)",
    [newId("att"), prepared.job.job_id, prepared.attempt.agentConnectionId, prepared.attempt.tool, prepared.attempt.argsSha256, decision],
  );
}

/** The AI_REVIEW receipt's detail: integers only (probabilities in basis points, whole milliseconds). */
function reviewDetail(review: Review): { [key: string]: ReceiptValue } {
  if (review.outcome === "unavailable") return { outcome: "unavailable", error: review.error, ms: Math.round(review.ms) };
  return {
    outcome: review.outcome,
    flags: [...review.flags],
    probs_bp: Object.fromEntries(Object.entries(review.probs_bp).map(([flag, bp]) => [flag, Math.round(bp)])),
    model: review.model,
    ms: Math.round(review.ms),
  };
}

/** The receipt fields that name a freshly stored version. */
function versionContext(prepared: PreparedVersion, proposalId: string, version: number): ReceiptFields {
  return {
    job: prepared.job.job_id,
    policy_version: prepared.job.policy_version,
    agent_connection: prepared.job.agent_connection,
    client_label: prepared.clientLabel,
    proposal: proposalId,
    version,
    version_sha256: prepared.sha256,
  };
}

/** Parses DEMO_RECIPIENTS ("a@x.com,b@y.com"); unset or empty means no allowlist. */
export function parseDemoRecipients(value: string | undefined | null): string[] | null {
  if (value === undefined || value === null || value.trim() === "") return null;
  return value.split(",").map((entry) => {
    const address = normalizeAddress(entry);
    if (!address) throw new Error("DEMO_RECIPIENTS holds an entry that is not one email address");
    return address;
  });
}

export function createExecutor(deps: ExecutorDeps) {
  const { pool } = deps;
  const writeReceipt: WriteReceipt = createReceiptWriter(deps.signingKey);
  const providerTimeoutMs = deps.providerTimeoutMs ?? PROVIDER_TIMEOUT_MS;
  const sweepAfterMs = deps.sweepAfterMs ?? SWEEP_AFTER_MS;
  const demoRecipients = deps.demoRecipients ? new Set(deps.demoRecipients) : null;

  async function ownerOfVersion(versionId: string): Promise<string | undefined> {
    const row = await one<{ owner_id: string }>(
      pool,
      `SELECT j.owner_id FROM proposal_versions v JOIN proposals p ON p.id = v.proposal_id JOIN jobs j ON j.id = p.job_id
       WHERE v.id = $1`,
      [versionId],
    );
    return row?.owner_id;
  }

  async function ownerOfProposal(proposalId: string): Promise<string | undefined> {
    const row = await one<{ owner_id: string }>(
      pool,
      "SELECT j.owner_id FROM proposals p JOIN jobs j ON j.id = p.job_id WHERE p.id = $1",
      [proposalId],
    );
    return row?.owner_id;
  }

  /** The spec's reserve(p, v, job, con, via), inside an open transaction with the rows locked. */
  async function reserve(tx: ExecutorTx, locked: Locked, via: string): Promise<Reservation> {
    const c = tx.client;
    const { p, v, job, con } = locked;
    // db_now(): the statement clock, read after the locks are held (now() would be the start of the
    // transaction, before any lock wait).
    const clock = await one<{ now: Date }>(c, "SELECT clock_timestamp() AS now");
    const now = clock?.now ?? new Date(Number.NaN);

    if (!con.dispatch_enabled || con.status !== "active") throw new Refusal("dispatch_stopped");
    if (job.status === "expired") throw new Refusal("job_expired");
    if (job.status !== "active") throw new Refusal("job_inactive");
    if (!(now.getTime() < job.expires_at.getTime())) throw new Refusal("job_expired");
    if (v.version !== p.current_version || v.state !== "pending") throw new Refusal("superseded");
    if (v.policy_version !== job.policy_version) throw new Refusal("policy_changed");
    if (v.recipient !== job.recipient_email) throw new Refusal("recipient_not_in_job");
    if (!storedVersionIntact({ canonical: v.canonical, sha256: v.sha256, mime: v.mime }) || !canonicalMatchesRows(locked)) {
      throw new Refusal("integrity");
    }
    if (via === "auto" && (!job.auto_send || v.review_reasons.length > 0)) throw new Refusal("needs_review");

    const taken = await c.query("UPDATE jobs SET sends_reserved = sends_reserved + 1 WHERE id = $1 AND sends_reserved < max_sends", [
      job.id,
    ]);
    if (taken.rowCount !== 1) throw new Refusal("limit_reached");

    const dispatchId = newId("dsp");
    try {
      await c.query("INSERT INTO dispatches (id, proposal_version_id, via, status, reserved_at) VALUES ($1, $2, $3, 'reserved', $4)", [
        dispatchId,
        v.id,
        via,
        now,
      ]);
    } catch (error) {
      // UNIQUE (proposal_version_id): a second reservation of one version fails here.
      if (isUniqueViolation(error)) throw new Refusal("superseded");
      throw error;
    }
    await c.query("UPDATE proposal_versions SET state = 'dispatched' WHERE id = $1", [v.id]);
    await c.query("UPDATE proposals SET status = 'dispatching' WHERE id = $1", [p.id]);
    const receiptId = await writeReceipt(tx, "DISPATCH_RESERVED", {
      ...receiptContext(locked),
      detail: { dispatch: dispatchId, via, sends_reserved: job.sends_reserved + 1, max_sends: job.max_sends },
    });
    return {
      dispatchId,
      versionId: v.id,
      proposalId: p.id,
      owner: job.owner_id,
      via,
      connection: { id: con.id, provider: con.provider, account_email: con.account_email },
      recipient: v.recipient,
      mime: new Uint8Array(v.mime.buffer, v.mime.byteOffset, v.mime.byteLength),
      receiptId,
    };
  }

  /** dispatch_auto(version_id): reserve a version that needs no review, then send it. */
  async function dispatch_auto(versionId: string): Promise<DispatchOutcome> {
    const owner = await ownerOfVersion(versionId);
    if (!owner) throw new NotFoundError("proposal version");
    const context: { fields: ReceiptFields } = { fields: {} };
    let reservation: Reservation;
    try {
      reservation = await withTx(pool, owner, async (tx) => {
        const locked = await lockVersion(tx, versionId);
        context.fields = receiptContext(locked);
        return reserve(tx, locked, "auto");
      });
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      const receipt_id = await withTx(pool, owner, (tx) =>
        writeReceipt(tx, "DISPATCH_REFUSED", { ...context.fields, detail: { reason: error.reason, via: "auto" } }),
      );
      return { kind: "refused", reason: error.reason, receipt_id };
    }
    return sendReserved(reservation);
  }

  /**
   * The transactional core of approve(proposal_id, version, shown_sha256, owner): the approval and
   * the reservation commit together or not at all. Throws NotFoundError (404) when the proposal or
   * version does not exist or is not this owner's.
   */
  async function approveAndReserve(proposalId: string, version: number, shownSha256: string, owner: string): Promise<ApproveResult> {
    // Ownership first and without locks, so a stranger's request takes no lock on the owner's rows.
    if ((await ownerOfProposal(proposalId)) !== owner) throw new NotFoundError("proposal");
    const context: { fields: ReceiptFields } = { fields: { proposal: proposalId, version } };
    try {
      const reservation = await withTx(pool, owner, async (tx) => {
        const locked = await lockInOrder(tx, proposalId, { number: version });
        context.fields = receiptContext(locked);
        const { p, v } = locked;
        if (v.version !== p.current_version) throw new Refusal("superseded");
        if (v.state !== "pending") throw new Refusal("not_pending");
        if (shownSha256 !== v.sha256) throw new Refusal("hash_mismatch");
        const approvalId = newId("apv");
        try {
          await tx.client.query(
            "INSERT INTO approvals (id, proposal_version_id, version_sha256, approver) VALUES ($1, $2, $3, $4)",
            [approvalId, v.id, v.sha256, owner],
          );
        } catch (error) {
          // UNIQUE (proposal_version_id): one approval per version.
          if (isUniqueViolation(error)) throw new Refusal("not_pending");
          throw error;
        }
        await writeReceipt(tx, "APPROVAL_GRANTED", { ...context.fields, detail: { approval: approvalId, approver: owner } });
        return reserve(tx, locked, approvalId);
      });
      return { ok: true, reservation };
    } catch (error) {
      if (!(error instanceof Refusal)) throw error;
      const receipt_id = await withTx(pool, owner, (tx) =>
        writeReceipt(tx, "APPROVAL_REFUSED", { ...context.fields, detail: { reason: error.reason, approver: owner } }),
      );
      return { ok: false, outcome: { kind: "refused", reason: error.reason, receipt_id } };
    }
  }

  /** approve: the transactional core, then the one provider call. */
  async function approve(proposalId: string, version: number, shownSha256: string, owner: string): Promise<DispatchOutcome> {
    const result = await approveAndReserve(proposalId, version, shownSha256, owner);
    return result.ok ? sendReserved(result.reservation) : result.outcome;
  }

  /** A verified Dial response is still only a candidate. Claim its exact-version authority under
   * the same locks as approval/reservation. Opt-out, expiry, revision and STOP cannot be checked
   * in an earlier application transaction. No public MCP or browser endpoint exposes this method. */
  async function decideVoice(owner: string, proof: {
    sessionId: string; callId: string; token: string; eventId: string;
    decision: "allow" | "deny"; transcriptSha256: string; configSha256: string;
  }): Promise<{ applied: boolean; status: "allowed" | "denied" | "no_decision"; receipt_id?: string; outcome?: DispatchOutcome }> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(proof.token) || !/^[a-f0-9]{64}$/.test(proof.transcriptSha256) || !/^[a-f0-9]{64}$/.test(proof.configSha256)
      || !/^[A-Za-z0-9_-]{1,200}$/.test(proof.callId) || !/^[A-Za-z0-9_-]{1,200}$/.test(proof.eventId)
      || !["allow","deny"].includes(proof.decision)) return { applied: false, status: "no_decision" };
    const ref = await one<{ proposal_id: string; version: number }>(pool,
      `SELECT v.proposal_id,v.version FROM owner_voice_sessions s JOIN proposal_versions v ON v.id=s.proposal_version_id
       JOIN proposals p ON p.id=v.proposal_id JOIN jobs j ON j.id=p.job_id WHERE s.id=$1 AND s.owner_id=$2 AND j.owner_id=$2`,
      [proof.sessionId,owner]);
    if (!ref) return { applied: false, status: "no_decision" };
    const result = await withTx(pool, owner, async (tx): Promise<{
      applied: boolean; status: "allowed" | "denied" | "no_decision"; receipt_id?: string; reservation?: Reservation;
    }> => {
      const locked = await lockInOrder(tx,ref.proposal_id,{number:ref.version});
      const {p,v,job,con}=locked;
      // Additional authority locks follow the existing proposal/version/job/connection locks,
      // and precede the owner's receipt counter. Opt-out takes only the preference/session locks.
      const pref=await one<{enabled:boolean;config_sha256:string}>(tx.client,"SELECT enabled,config_sha256 FROM owner_voice_preferences WHERE owner_id=$1 FOR UPDATE",[owner]);
      const session=await one<{status:string;call_id:string;token_sha256:string;version_sha256:string;config_sha256:string;proposal_version_id:string;expires_at:Date;consumed_at:Date|null}>(tx.client,
        "SELECT * FROM owner_voice_sessions WHERE id=$1 AND owner_id=$2 FOR UPDATE",[proof.sessionId,owner]);
      if (!session || session.status!=="awaiting_reply" || session.consumed_at!==null || session.call_id!==proof.callId
        || session.token_sha256!==sha256Hex(proof.token) || session.proposal_version_id!==v.id) return {applied:false,status:"no_decision"};
      // Consume a valid callback before the savepoint: a refused decision is also single-use.
      await tx.client.query(`UPDATE owner_voice_sessions SET consumed_at=clock_timestamp(),event_id=$2,decision=$3,
        transcript_sha256=$4,status='no_decision',finished_at=clock_timestamp() WHERE id=$1`,
        [proof.sessionId,proof.eventId,proof.decision,proof.transcriptSha256]);
      const now=(await one<{now:Date}>(tx.client,"SELECT clock_timestamp() AS now"))!.now;
      const fields=receiptContext(locked);
      const channel={channel:"phone",call_id:proof.callId,voice_session:proof.sessionId,transcript_sha256:proof.transcriptSha256};
      const unavailableReason=!pref?.enabled ? "voice_disabled"
        : pref.config_sha256!==proof.configSha256 || session.config_sha256!==proof.configSha256 ? "config_changed"
        : session.expires_at<=now ? "expired" : null;
      if(unavailableReason) {
        const receipt_id=await writeReceipt(tx,"APPROVAL_REFUSED",{...fields,detail:{reason:unavailableReason,approver:owner,...channel}});
        return {applied:false,status:"no_decision",receipt_id};
      }
      await tx.client.query("SAVEPOINT voice_decision");
      try {
        if(v.version!==p.current_version)throw new Refusal("superseded");
        if(v.state!=="pending"||p.status!=="pending")throw new Refusal("not_pending");
        if(session.version_sha256!==v.sha256)throw new Refusal("hash_mismatch");
        // Denial also refuses a stale/stopped session; it never resurrects or changes job authority.
        if(job.status!=="active"||con.status!=="active"||!con.dispatch_enabled)throw new Refusal("dispatch_stopped");
        if(job.expires_at<=now)throw new Refusal("job_expired");
        if(proof.decision==="deny") {
          await tx.client.query("UPDATE proposal_versions SET state='rejected' WHERE id=$1",[v.id]);
          await tx.client.query("UPDATE proposals SET status='rejected' WHERE id=$1",[p.id]);
          const receipt_id=await writeReceipt(tx,"APPROVAL_REJECTED",{...fields,detail:{approver:owner,...channel}});
          await tx.client.query("UPDATE owner_voice_sessions SET status='denied' WHERE id=$1",[proof.sessionId]);
          return {applied:true,status:"denied",receipt_id};
        }
        const approvalId=newId("apv");
        await tx.client.query("INSERT INTO approvals(id,proposal_version_id,version_sha256,approver) VALUES($1,$2,$3,$4)",[approvalId,v.id,v.sha256,owner]);
        const receipt_id=await writeReceipt(tx,"APPROVAL_GRANTED",{...fields,detail:{approval:approvalId,approver:owner,...channel}});
        const reservation=await reserve(tx,locked,approvalId);
        await tx.client.query("UPDATE owner_voice_sessions SET status='allowed' WHERE id=$1",[proof.sessionId]);
        return {applied:true,status:"allowed",receipt_id,reservation};
      } catch(error) {
        if(!(error instanceof Refusal))throw error;
        await tx.client.query("ROLLBACK TO SAVEPOINT voice_decision");
        const receipt_id=await writeReceipt(tx,"APPROVAL_REFUSED",{...fields,detail:{reason:error.reason,approver:owner,...channel}});
        return {applied:false,status:"no_decision",receipt_id};
      }
    });
    if(result.reservation) {
      const outcome=await sendReserved(result.reservation);
      return {applied:true,status:"allowed",...(result.receipt_id?{receipt_id:result.receipt_id}:{}),outcome};
    }
    return result;
  }

  /** send_reserved(d): outside any transaction, exactly one provider call. */
  async function sendReserved(r: Reservation): Promise<DispatchOutcome> {
    const con = await one<{ dispatch_enabled: boolean; status: ConnectionStatus }>(
      pool,
      "SELECT dispatch_enabled, status FROM connections WHERE id = $1",
      [r.connection.id],
    );
    if (!con || !con.dispatch_enabled || con.status !== "active") {
      return finish(r, { status: "not_sent", errorClass: "stopped_before_call" });
    }
    if (demoRecipients && !demoRecipients.has(r.recipient)) {
      return finish(r, { status: "not_sent", errorClass: "demo_recipient_not_allowed" });
    }
    let outcome: MailOutcome;
    try {
      const provider = deps.mailProviderFor(r.connection);
      outcome = checkedOutcome(await withTimeout(Promise.resolve(provider.send(r.mime)), providerTimeoutMs));
    } catch (error) {
      // A throw, a reset or a timeout: the provider may have the message. Never resend.
      outcome = { status: "unknown", errorClass: errorClassOf(error) };
    }
    return finish(r, outcome);
  }

  /** finish(d, status, detail): records the provider result in its own transaction. */
  async function finish(r: Reservation, outcome: MailOutcome): Promise<DispatchOutcome> {
    const receipt_id = await withTx(pool, r.owner, async (tx) => {
      const c = tx.client;
      const locked = await lockVersion(tx, r.versionId);
      const d = await one<{ id: string; status: string }>(c, "SELECT id, status FROM dispatches WHERE id = $1 FOR UPDATE", [
        r.dispatchId,
      ]);
      if (!d) throw new NotFoundError("dispatch");
      const detail: { [key: string]: ReceiptValue } =
        outcome.status === "accepted"
          ? { dispatch: d.id, provider: r.connection.provider, provider_message_id: outcome.providerMessageId }
          : { dispatch: d.id, provider: r.connection.provider, error_class: outcome.errorClass };
      if (d.status !== "reserved") {
        // The sweeper already recorded UNKNOWN. Keep that state (the owner resolves it) and record
        // the late answer as what it is.
        return writeReceipt(tx, OUTCOME_RECEIPT[outcome.status], {
          ...receiptContext(locked),
          detail: { ...detail, late: true, recorded_status: d.status },
        });
      }
      await c.query(
        "UPDATE dispatches SET status = $2, provider_message_id = $3, error_class = $4, finished_at = clock_timestamp() WHERE id = $1",
        [
          d.id,
          outcome.status,
          outcome.status === "accepted" ? outcome.providerMessageId : null,
          outcome.status === "accepted" ? null : outcome.errorClass,
        ],
      );
      await c.query("UPDATE proposals SET status = $2 WHERE id = $1", [locked.p.id, outcome.status]);
      if (outcome.status === "not_sent") {
        const released = await c.query("UPDATE jobs SET sends_reserved = sends_reserved - 1 WHERE id = $1 AND sends_reserved > 0", [
          locked.job.id,
        ]);
        if (released.rowCount !== 1) throw new Error("finish: no reservation to release");
      }
      return writeReceipt(tx, OUTCOME_RECEIPT[outcome.status], { ...receiptContext(locked), detail });
    });
    return { kind: "provider", outcome, receipt_id };
  }

  /**
   * The sweeper: any dispatch still `reserved` after sweepAfterMs becomes UNKNOWN with an
   * OUTCOME_UNKNOWN receipt. It never sends. Returns the dispatch ids it changed.
   */
  async function sweep(now?: Date): Promise<string[]> {
    // The cutoff comes from the database clock that stamped reserved_at, so skew between this
    // process and the database cannot sweep an in-flight send early. `now` overrides it (tests).
    const clock = await one<{ cutoff: Date }>(
      pool,
      "SELECT COALESCE($1::timestamptz, clock_timestamp()) - make_interval(secs => $2) AS cutoff",
      [now ?? null, sweepAfterMs / 1000],
    );
    if (!clock) throw new Error("sweep: no clock");
    const cutoff = clock.cutoff;
    const { rows } = await pool.query<{ id: string; proposal_version_id: string; owner_id: string }>(
      `SELECT d.id, d.proposal_version_id, j.owner_id
       FROM dispatches d JOIN proposal_versions v ON v.id = d.proposal_version_id
         JOIN proposals p ON p.id = v.proposal_id JOIN jobs j ON j.id = p.job_id
       WHERE d.status = 'reserved' AND d.reserved_at <= $1
       ORDER BY d.reserved_at`,
      [cutoff],
    );
    const swept: string[] = [];
    for (const row of rows) {
      const changed = await withTx(pool, row.owner_id, async (tx) => {
        const c = tx.client;
        const locked = await lockVersion(tx, row.proposal_version_id);
        const d = await one<{ id: string; status: string; reserved_at: Date }>(
          c,
          "SELECT id, status, reserved_at FROM dispatches WHERE id = $1 FOR UPDATE",
          [row.id],
        );
        if (!d || d.status !== "reserved" || d.reserved_at.getTime() > cutoff.getTime()) return false;
        await c.query(
          "UPDATE dispatches SET status = 'unknown', error_class = 'no_provider_result', finished_at = clock_timestamp() WHERE id = $1",
          [d.id],
        );
        await c.query("UPDATE proposals SET status = 'unknown' WHERE id = $1", [locked.p.id]);
        await writeReceipt(tx, "OUTCOME_UNKNOWN", {
          ...receiptContext(locked),
          detail: { dispatch: d.id, error_class: "no_provider_result", source: "sweeper" },
        });
        return true;
      });
      if (changed) swept.push(row.id);
    }
    return swept;
  }

  /** Sweeps at once and then every `intervalMs`. Returns a stop function. Never sends. */
  function startSweeper(intervalMs = SWEEP_AFTER_MS, onError: (error: unknown) => void = () => undefined): () => void {
    const run = () => {
      sweep().catch(onError);
    };
    run();
    const timer = setInterval(run, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /**
   * STOP, in the spec's order: first dispatch_enabled = false with STOP_ENGAGED (instant, ours),
   * then the provider revoke with its request and result receipts. Throws NotFoundError for a
   * connection that is not this owner's.
   */
  async function engageStop(connectionId: string, owner: string) {
    const stopped = await withTx(pool, owner, async (tx) => {
      const con = await one<ConnectionRow>(
        tx.client,
        "SELECT id, owner_id, provider, account_email, dispatch_enabled, status FROM connections WHERE id = $1 FOR UPDATE",
        [connectionId],
      );
      if (!con || con.owner_id !== owner) throw new NotFoundError("connection");
      await tx.client.query(
        "UPDATE connections SET dispatch_enabled = false, status = CASE WHEN status = 'active' THEN 'stopped' ELSE status END WHERE id = $1",
        [con.id],
      );
      const receiptId = await writeReceipt(tx, "STOP_ENGAGED", {
        detail: { connection: con.id, provider: con.provider, was_enabled: con.dispatch_enabled },
      });
      return { con, receiptId };
    });
    const ref: ConnectionRef = { id: stopped.con.id, provider: stopped.con.provider, account_email: stopped.con.account_email };
    if (!deps.revoke) return { stopReceipt: stopped.receiptId, revoked: null };

    const requestReceipt = await withTx(pool, owner, (tx) =>
      writeReceipt(tx, "PROVIDER_REVOKE_REQUESTED", { detail: { connection: ref.id, provider: ref.provider } }),
    );
    let result: RevokeResult;
    try {
      const answer = await deps.revoke(ref);
      result = { ok: answer.ok === true, status: typeof answer.status === "number" && Number.isSafeInteger(answer.status) ? answer.status : String(answer.status) };
    } catch (error) {
      result = { ok: false, status: errorClassOf(error) };
    }
    const resultReceipt = await withTx(pool, owner, async (tx) => {
      await tx.client.query("SELECT id FROM connections WHERE id = $1 FOR UPDATE", [ref.id]);
      if (result.ok) await tx.client.query("UPDATE connections SET status = 'revoked' WHERE id = $1", [ref.id]);
      return writeReceipt(tx, "PROVIDER_REVOKE_RESULT", {
        detail: { connection: ref.id, provider: ref.provider, ok: result.ok, status: result.status },
      });
    });
    return { stopReceipt: stopped.receiptId, requestReceipt, resultReceipt, revoked: result.ok };
  }

  /**
   * The owner records what they observed about an UNKNOWN outcome: "seen" (it arrived) or
   * "not_arrived" (not seen yet). Either way the reservation stays used and the proposal stays
   * unknown: a message that hasn't arrived may only be late or in spam, so releasing the slot could
   * allow a second send. Writes OUTCOME_RESOLVED naming the owner and the observation.
   */
  async function resolveUnknown(dispatchId: string, resolution: "seen" | "not_arrived", owner: string): Promise<ResolveResult> {
    if (resolution !== "seen" && resolution !== "not_arrived") throw new TypeError("resolution must be seen or not_arrived");
    const ref = await one<{ proposal_version_id: string; owner_id: string }>(
      pool,
      `SELECT d.proposal_version_id, j.owner_id
       FROM dispatches d JOIN proposal_versions v ON v.id = d.proposal_version_id
         JOIN proposals p ON p.id = v.proposal_id JOIN jobs j ON j.id = p.job_id
       WHERE d.id = $1`,
      [dispatchId],
    );
    if (!ref || ref.owner_id !== owner) throw new NotFoundError("dispatch");
    return withTx(pool, owner, async (tx): Promise<ResolveResult> => {
      const c = tx.client;
      const locked = await lockVersion(tx, ref.proposal_version_id);
      const d = await one<{ id: string; status: string; witness: string | null }>(
        c,
        "SELECT id, status, witness FROM dispatches WHERE id = $1 FOR UPDATE",
        [dispatchId],
      );
      if (!d || d.status !== "unknown" || d.witness !== null) return { resolved: false, reason: "not_unknown" };
      await c.query("UPDATE dispatches SET witness = $2, resolved_by = $3, resolved_at = clock_timestamp() WHERE id = $1", [
        d.id,
        resolution,
        owner,
      ]);
      const receipt_id = await writeReceipt(tx, "OUTCOME_RESOLVED", {
        ...receiptContext(locked),
        detail: { dispatch: d.id, resolution: resolution === "seen" ? "sent" : "not_arrived", source: "owner", resolved_by: owner },
      });
      return { resolved: true, receipt_id };
    });
  }

  /**
   * store_version for a new proposal: the proposal, version 1, the attempt row, AI_REVIEW (when a
   * review ran) and PROPOSAL_CREATED, in one transaction. A repeated `operationId` on the same job
   * stores nothing and names the existing proposal instead (UNIQUE (job_id, operation_id) decides
   * a race between two such calls).
   */
  async function storeVersion(prepared: PreparedVersion, operationId: string | null): Promise<StoredVersion | { replayOf: string }> {
    const proposalId = newId("prp");
    const versionId = newId("pv");
    try {
      await withTx(pool, prepared.job.owner, async (tx) => {
        await tx.client.query("INSERT INTO proposals (id, job_id, operation_id) VALUES ($1, $2, $3)", [proposalId, prepared.job.job_id, operationId]);
        await insertVersion(tx, versionId, proposalId, 1, prepared);
        await recordAttempt(tx, prepared, prepared.reasons.length > 0 ? "held" : "proposed");
        const context = versionContext(prepared, proposalId, 1);
        if (prepared.review) await writeReceipt(tx, "AI_REVIEW", { ...context, detail: reviewDetail(prepared.review) });
        await writeReceipt(tx, "PROPOSAL_CREATED", { ...context, detail: { review_reasons: prepared.reasons } });
      });
    } catch (error) {
      if (operationId !== null && isUniqueViolation(error, "proposals_job_id_operation_id_key")) {
        const existing = await one<{ id: string }>(pool, "SELECT id FROM proposals WHERE job_id = $1 AND operation_id = $2", [
          prepared.job.job_id,
          operationId,
        ]);
        if (existing) return { replayOf: existing.id };
      }
      throw error;
    }
    return { proposalId, versionId, version: 1, sha256: prepared.sha256 };
  }

  /**
   * The transactional half of revise: under the proposal's locks, the proposal must still be
   * pending at `baseVersion` (the version the revision was rendered against) and below
   * MAX_VERSIONS, or Refusal("not_revisable"). Then the old version is superseded, the new one
   * stored as baseVersion + 1, and PROPOSAL_REVISED records both hashes.
   */
  async function storeRevision(prepared: PreparedVersion, proposalId: string, baseVersion: number): Promise<StoredVersion> {
    const versionId = newId("pv");
    const version = baseVersion + 1;
    await withTx(pool, prepared.job.owner, async (tx) => {
      const locked = await lockInOrder(tx, proposalId, { number: baseVersion });
      const { p, v } = locked;
      if (p.job_id !== prepared.job.job_id) throw new NotFoundError("proposal");
      if (p.status !== "pending" || p.current_version !== baseVersion || v.state !== "pending" || baseVersion >= MAX_VERSIONS) {
        throw new Refusal("not_revisable");
      }
      await tx.client.query("UPDATE proposal_versions SET state = 'superseded' WHERE id = $1", [v.id]);
      await insertVersion(tx, versionId, proposalId, version, prepared);
      await tx.client.query("UPDATE proposals SET current_version = $2 WHERE id = $1", [p.id, version]);
      await recordAttempt(tx, prepared, "revised");
      const context = versionContext(prepared, proposalId, version);
      if (prepared.review) await writeReceipt(tx, "AI_REVIEW", { ...context, detail: reviewDetail(prepared.review) });
      await writeReceipt(tx, "PROPOSAL_REVISED", {
        ...context,
        detail: { from_version: baseVersion, from_sha256: v.sha256, to_sha256: prepared.sha256, review_reasons: prepared.reasons },
      });
    });
    return { proposalId, versionId, version, sha256: prepared.sha256 };
  }

  /**
   * reject(proposal_id, version, shown_sha256, owner): the owner turns down exactly the version the
   * screen showed. The version and the proposal become `rejected`, with APPROVAL_REJECTED. A stale
   * or decided version is a refusal (superseded, not_pending, hash_mismatch) and changes nothing.
   * NotFoundError when the proposal is not this owner's.
   */
  async function rejectVersion(
    proposalId: string,
    version: number,
    shownSha256: string,
    owner: string,
  ): Promise<{ ok: true; receipt_id: string } | { ok: false; reason: DispatchRefusal }> {
    if ((await ownerOfProposal(proposalId)) !== owner) throw new NotFoundError("proposal");
    try {
      return await withTx(pool, owner, async (tx) => {
        const locked = await lockInOrder(tx, proposalId, { number: version });
        const { p, v } = locked;
        if (v.version !== p.current_version) throw new Refusal("superseded");
        if (v.state !== "pending" || p.status !== "pending") throw new Refusal("not_pending");
        if (shownSha256 !== v.sha256) throw new Refusal("hash_mismatch");
        await tx.client.query("UPDATE proposal_versions SET state = 'rejected' WHERE id = $1", [v.id]);
        await tx.client.query("UPDATE proposals SET status = 'rejected' WHERE id = $1", [p.id]);
        const receipt_id = await writeReceipt(tx, "APPROVAL_REJECTED", { ...receiptContext(locked), detail: { approver: owner } });
        return { ok: true as const, receipt_id };
      });
    } catch (error) {
      if (error instanceof Refusal) return { ok: false, reason: error.reason };
      throw error;
    }
  }

  /** deny(): the attempt row and ATTEMPT_DENIED in one transaction. No proposal is created. */
  async function recordDenial(denial: Denial): Promise<string> {
    return withTx(pool, denial.owner, async (tx) => {
      await tx.client.query(
        "INSERT INTO attempts (id, job_id, agent_connection_id, tool, args_sha256, decision, reason_code) VALUES ($1, $2, $3, $4, $5, 'denied', $6)",
        [newId("att"), denial.job?.id ?? null, denial.agentConnectionId, denial.tool, denial.argsSha256, denial.reason],
      );
      return writeReceipt(tx, "ATTEMPT_DENIED", {
        job: denial.job?.id ?? null,
        policy_version: denial.job?.policy_version ?? null,
        agent_connection: denial.agentConnectionId,
        client_label: denial.clientLabel,
        detail: { reason_code: denial.reason, args_sha256: denial.argsSha256, ...(denial.field !== undefined ? { field: denial.field } : {}) },
      });
    });
  }

  // The two contract signatures this lane can meet as written (JobSendCore); approve needs the
  // owner the spec's pseudo-code checks, which the contract's approve does not carry.
  const core = { dispatch_auto, writeReceipt } satisfies Pick<JobSendCore, "dispatch_auto" | "writeReceipt">;

  return {
    ...core,
    core,
    withTx: <T>(owner: string, fn: (tx: ExecutorTx) => Promise<T>) => withTx(pool, owner, fn),
    approveAndReserve,
    approve,
    decideVoice,
    sendReserved,
    finish,
    sweep,
    startSweeper,
    engageStop,
    resolveUnknown,
    storeVersion,
    storeRevision,
    recordDenial,
    rejectVersion,
  };
}

export type Executor = ReturnType<typeof createExecutor>;
