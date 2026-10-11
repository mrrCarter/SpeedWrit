// The owner API (spec: "Owner API routes"): what the owner screens call. A thin node:http layer over
// an injected core (the executor lane's functions), in the shape of the agent-connection server.
//
// - Every route needs the owner session, and the core scopes every row to that owner. Another
//   owner's id is not_found, never forbidden, so an answer never reveals that a row exists.
// - Writes are POST with a JSON body and an Origin equal to this host. A cross-site form cannot
//   send JSON without a preflight, and no /owner/* path answers one.
// - Bodies are checked against a declared schema (unknown keys refused) before the core runs.
// - The "exactly what you saw" routes pass the hash the screen showed; the core recomputes it and
//   refuses on a mismatch.
// - Answers are JSON with no-store. Errors are { error } with a code from a closed list.

import type { IncomingMessage, ServerResponse } from "node:http";

import type { DispatchOutcome } from "../contract/types.js";
import { argumentProblem } from "../mcp/arguments.js";
import { assertOrigin } from "../oauth/oauth.js";
import type { OwnerSessions } from "./http.js";
import { SECRET_PATH_CLIENT_ID, createSecretPath } from "./secret-path.js";
import type { OAuthStore } from "./store.js";

/** The refusals the core may throw as OwnerError. Anything else it throws is a server error. */
export const OWNER_ERRORS = Object.freeze([
  "not_found",
  "authority_changed",
  "superseded",
  "policy_changed",
  "not_pending",
  "hash_mismatch",
  "dispatch_stopped",
  "invalid_job",
  "not_draft",
  "job_expired",
  "agent_connection_revoked",
  "not_unknown",
  "invalid_client_label",
] as const);
export type OwnerErrorCode = (typeof OWNER_ERRORS)[number];

/** The job fields an invalid_job refusal may name, so the screen can point at one. */
export const OWNER_ERROR_FIELDS = Object.freeze([
  "recipient",
  "max_sends",
  "expires_at",
  "purpose",
  "template",
  "field_rules",
  "connection",
  "agent_connection",
] as const);
export type OwnerErrorField = (typeof OWNER_ERROR_FIELDS)[number];

/** An expected refusal from the core, answered to the owner by its code (and a listed field, if any). */
export class OwnerError extends Error {
  constructor(
    readonly code: OwnerErrorCode,
    readonly options: { field?: OwnerErrorField } = {},
  ) {
    super(`owner: ${code}`);
    this.name = "OwnerError";
  }
}

/**
 * A job the owner is about to confirm (the spec's job, before ids and policy_version exist), in the
 * executor core's shape. The field rules come from the template row, so the screen never restates
 * them. The route requires every binding the core could otherwise default, so a job never guesses
 * which connection it belongs to.
 */
export type JobDraftInput = {
  connectionId: string;
  agentConnectionId: string;
  recipient: string;
  purpose: string;
  templateId: string;
  maxSends: number;
  expiresAt: string;
  autoSend: boolean;
  allowCustomWithApproval: boolean;
  aiReview: "off" | "custom_only" | "all_free_text";
};

/** The executor lane's functions. Each takes the signed-in owner's id and touches only that owner's rows. */
export interface OwnerCore {
  connectState(ownerId: string): Promise<unknown>;
  engageStop(connectionId: string, ownerId: string): Promise<{ receipt_ids: string[] }>;
  revokeAgentConnection(agentConnectionId: string, ownerId: string): Promise<{ receipt_id: string }>;
  /** Resolves when the agent connection is this owner's and not revoked; otherwise throws OwnerError("not_found"). */
  assertAgentConnection(agentConnectionId: string, ownerId: string): Promise<void>;
  /**
   * Creates an agent connection with AGENT_CONNECTED in one transaction; with `secretHash`, its secret
   * path too, in that same transaction. A blank label, or one with control, format or unassigned
   * characters, is OwnerError("invalid_client_label").
   */
  createAgentConnection(
    ownerId: string,
    clientId: string,
    clientLabel: string,
    options?: { secretHash?: string },
  ): Promise<{ agent_connection_id: string; receipt_id: string }>;
  /** Writes a draft job; `job` is the contract's Job, the object the authority hash covers. */
  createJobDraft(ownerId: string, draft: JobDraftInput): Promise<{ job: unknown; authoritySha256: string }>;
  /** Rebuilds the Job under its lock; throws OwnerError("authority_changed") on a mismatch, ("not_draft") if not a draft. */
  confirmJob(ownerId: string, jobId: string, shownAuthoritySha256: string): Promise<{ policyVersion: number; receipt_id: string }>;
  listJobs(ownerId: string): Promise<unknown[]>;
  listPendingVersions(ownerId: string): Promise<unknown[]>;
  approve(proposalId: string, version: number, shownSha256: string, ownerId: string): Promise<DispatchOutcome>;
  rejectVersion(proposalId: string, version: number, shownSha256: string, ownerId: string): Promise<{ receipt_id: string }>;
  resolveUnknown(dispatchId: string, outcome: "seen" | "not_arrived", ownerId: string): Promise<{ receipt_id: string }>;
  listReceipts(ownerId: string, filter: { job: string }): Promise<unknown[]>;
}

export type OwnerApiOptions = {
  /** The public https origin. Writes must carry it as their Origin. */
  host: string;
  owners: Pick<OwnerSessions, "owner">;
  core: OwnerCore;
  /** Revoking an agent connection also revokes its OAuth tokens here. */
  oauthStore: Pick<OAuthStore, "revokeAgentConnection">;
  /** Where a new secret path is recorded; without it the secret-path route is not found. */
  secretPaths?: { add(secretHash: string, agentConnectionId: string): Promise<void> };
  /** Seconds since the epoch. */
  now?: () => number;
  onError?: (error: unknown) => void;
};

const BODY_LIMIT = 64 * 1024;

const text = (maxLength: number) => ({ type: "string", maxLength });
const id = text(100);
const sha256 = text(64);
const body = (properties: Record<string, object>) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/** The JSON body each write route accepts. Exported so a test can pin every keyword to the checker's subset. */
export const OWNER_BODY_SCHEMAS = Object.freeze({
  "/owner/stop": body({ connection_id: id }),
  "/owner/agent-connections/revoke": body({ agent_connection_id: id }),
  "/owner/agent-connections/secret-path": body({ agent_connection_id: id }),
  "/owner/agent-connections/secret-path-new": body({ client_label: text(100) }),
  "/owner/jobs": body({
    connection_id: id,
    agent_connection_id: id,
    recipient: text(254),
    purpose: text(300),
    template_id: id,
    max_sends: { type: "integer", minimum: 1, maximum: 50 },
    expires_at: text(40),
    auto_send: { type: "boolean" },
    allow_custom_with_approval: { type: "boolean" },
    ai_review: { type: "string", enum: ["off", "custom_only", "all_free_text"] },
  }),
  "/owner/jobs/confirm": body({ job_id: id, authority_sha256: sha256 }),
  "/owner/versions/approve": body({ proposal_id: id, version: { type: "integer", minimum: 1, maximum: 5 }, shown_sha256: sha256 }),
  "/owner/versions/reject": body({ proposal_id: id, version: { type: "integer", minimum: 1, maximum: 5 }, shown_sha256: sha256 }),
  "/owner/dispatches/resolve": body({ dispatch_id: id, outcome: { type: "string", enum: ["seen", "not_arrived"] } }),
} as const);

type WritePath = keyof typeof OWNER_BODY_SCHEMAS;

/**
 * An approval's result as codes the screen turns into the spec's words ("Provider accepted", "Not
 * sent", "Outcome unknown. Do not resend."). It claims no more than the provider said.
 */
export function approvalAnswer(outcome: DispatchOutcome): { status: "accepted" | "not_sent" | "unknown" | "refused"; reason?: string; receipt_id: string } {
  if (outcome.kind === "refused") return { status: "refused", reason: outcome.reason, receipt_id: outcome.receipt_id };
  if (outcome.outcome.status === "accepted") return { status: "accepted", receipt_id: outcome.receipt_id };
  if (outcome.outcome.status === "not_sent") return { status: "not_sent", receipt_id: outcome.receipt_id };
  return { status: "unknown", receipt_id: outcome.receipt_id };
}

class BodyError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string,
  ) {
    super(code);
  }
}

function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(value));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if ((req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase() !== "application/json") throw new BodyError(415, "json_only");
  if (Number(req.headers["content-length"] ?? 0) > BODY_LIMIT) throw new BodyError(413, "too_large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT) throw new BodyError(413, "too_large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BodyError(400, "invalid", "the body is not JSON");
  }
}

/**
 * The owner API as a handler that answers every /owner/* request and returns true, or returns false
 * for any other path, so the app can try the next handler.
 */
export function createOwnerApi(options: OwnerApiOptions): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  const host = assertOrigin(options.host);
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const { core } = options;

  const reads: Record<string, (ownerId: string, url: URL) => Promise<unknown>> = {
    "/owner/connect": async (ownerId) => core.connectState(ownerId),
    "/owner/jobs": async (ownerId) => ({ jobs: await core.listJobs(ownerId) }),
    "/owner/pending": async (ownerId) => ({ pending: await core.listPendingVersions(ownerId) }),
    "/owner/receipts": async (ownerId, url) => {
      const jobId = url.searchParams.get("job_id");
      if (jobId === null || url.searchParams.getAll("job_id").length !== 1 || argumentProblem(id, jobId) !== null) {
        throw new BodyError(400, "invalid", "job_id is required");
      }
      return { receipts: await core.listReceipts(ownerId, { job: jobId }) };
    },
  };

  // Each write gets a body its schema has already accepted.
  const writes: Record<WritePath, (ownerId: string, input: Record<string, unknown>) => Promise<unknown>> = {
    "/owner/stop": async (ownerId, input) => ({ stopped: true, ...(await core.engageStop(input.connection_id as string, ownerId)) }),
    "/owner/agent-connections/revoke": async (ownerId, input) => {
      const agentConnectionId = input.agent_connection_id as string;
      const done = await core.revokeAgentConnection(agentConnectionId, ownerId);
      await options.oauthStore.revokeAgentConnection(agentConnectionId, now());
      return { revoked: true, ...done };
    },
    "/owner/agent-connections/secret-path": async (ownerId, input) => {
      if (!options.secretPaths) throw new OwnerError("not_found");
      const agentConnectionId = input.agent_connection_id as string;
      await core.assertAgentConnection(agentConnectionId, ownerId);
      const { url, secretHash } = createSecretPath(host);
      await options.secretPaths.add(secretHash, agentConnectionId);
      return { url };
    },
    // The fallback when the agent can't finish OAuth: a new agent connection and its path, made in one
    // transaction, so no OAuth consent is needed first. The URL is shown once. secretPaths is the switch
    // (SECRET_PATH_FALLBACK); the core stores the path with the connection.
    "/owner/agent-connections/secret-path-new": async (ownerId, input) => {
      if (!options.secretPaths) throw new OwnerError("not_found");
      const { url, secretHash } = createSecretPath(host);
      const created = await core.createAgentConnection(ownerId, SECRET_PATH_CLIENT_ID, input.client_label as string, { secretHash });
      return { url, ...created };
    },
    "/owner/jobs": async (ownerId, input) =>
      core.createJobDraft(ownerId, {
        connectionId: input.connection_id as string,
        agentConnectionId: input.agent_connection_id as string,
        recipient: input.recipient as string,
        purpose: input.purpose as string,
        templateId: input.template_id as string,
        maxSends: input.max_sends as number,
        expiresAt: input.expires_at as string,
        autoSend: input.auto_send as boolean,
        allowCustomWithApproval: input.allow_custom_with_approval as boolean,
        aiReview: input.ai_review as JobDraftInput["aiReview"],
      }),
    "/owner/jobs/confirm": async (ownerId, input) => core.confirmJob(ownerId, input.job_id as string, input.authority_sha256 as string),
    "/owner/versions/approve": async (ownerId, input) =>
      approvalAnswer(await core.approve(input.proposal_id as string, input.version as number, input.shown_sha256 as string, ownerId)),
    "/owner/versions/reject": async (ownerId, input) =>
      core.rejectVersion(input.proposal_id as string, input.version as number, input.shown_sha256 as string, ownerId),
    "/owner/dispatches/resolve": async (ownerId, input) => core.resolveUnknown(input.dispatch_id as string, input.outcome as "seen" | "not_arrived", ownerId),
  };

  return async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (!path.startsWith("/owner/")) return false;
    try {
      const owner = await options.owners.owner(req);
      if (!owner) {
        send(res, 401, { error: "sign_in" });
        return true;
      }
      const isWrite = Object.hasOwn(OWNER_BODY_SCHEMAS, path);
      if (req.method === "GET" && path === "/owner/me") {
        send(res, 200, { owner: { id: owner.id, email: owner.email } });
      } else if (req.method === "GET" && Object.hasOwn(reads, path)) {
        send(res, 200, await reads[path]!(owner.id, url));
      } else if (req.method === "POST" && isWrite) {
        if (req.headers.origin !== host) throw new BodyError(403, "origin");
        const input = await readJson(req);
        const problem = argumentProblem(OWNER_BODY_SCHEMAS[path as WritePath], input, "body");
        if (problem) throw new BodyError(400, "invalid", problem);
        send(res, 200, await writes[path as WritePath](owner.id, input as Record<string, unknown>));
      } else if (isWrite || Object.hasOwn(reads, path) || path === "/owner/me") {
        send(res, 405, { error: "method_not_allowed" });
      } else {
        send(res, 404, { error: "not_found" });
      }
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
      } else if (error instanceof BodyError) {
        send(res, error.status, error.detail ? { error: error.code, detail: error.detail } : { error: error.code });
      } else if (error instanceof OwnerError && (OWNER_ERRORS as readonly string[]).includes(error.code)) {
        // A field is answered only when it is on the closed list; anything else is dropped, never echoed.
        const field = error.options?.field;
        const named = field !== undefined && (OWNER_ERROR_FIELDS as readonly string[]).includes(field) ? { field } : {};
        send(res, error.code === "not_found" ? 404 : 409, { error: error.code, ...named });
      } else {
        options.onError?.(error);
        send(res, 500, { error: "server_error" });
      }
    }
    return true;
  };
}
