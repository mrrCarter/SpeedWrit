import type { ConnectionStatus, FieldRule, Job, JobStatus, Provider } from "../contract/types.js";
import { canonicalSha256Hex } from "./hash.js";

// A job as the executor reads it: the row, plus what its authority names from the connection (the
// provider and the sender) and the agent connection's declared label. One query, one mapping, so
// the gate, the renderer and confirmJob all see the same job.

export interface JobRecord {
  id: string;
  owner_id: string;
  connection_id: string;
  agent_connection_id: string;
  client_label: string;
  purpose: string;
  recipient_email: string;
  template_id: string;
  template_sha256: string;
  field_rules: Record<string, FieldRule>;
  max_sends: number;
  sends_reserved: number;
  expires_at: Date;
  auto_send: boolean;
  allow_custom_with_approval: boolean;
  ai_review: Job["ai_review"];
  policy_version: number;
  status: JobStatus;
  provider: Provider;
  sender: string;
  dispatch_enabled: boolean;
  connection_status: ConnectionStatus;
}

/** Select JobRecord columns; append a WHERE clause on `j`. */
export const JOB_RECORD_SQL = `SELECT j.id, j.owner_id, j.connection_id, j.agent_connection_id, a.client_label, j.purpose,
       j.recipient_email, j.template_id, j.template_sha256, j.field_rules, j.max_sends, j.sends_reserved,
       j.expires_at, j.auto_send, j.allow_custom_with_approval, j.ai_review, j.policy_version, j.status,
       c.provider, c.account_email AS sender, c.dispatch_enabled, c.status AS connection_status
  FROM jobs j
  JOIN connections c ON c.id = j.connection_id
  JOIN agent_connections a ON a.id = j.agent_connection_id`;

/** The timestamp form the authority and the version canonical use: UTC, whole seconds, "Z". */
export function isoSeconds(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The job as the owner confirms it (spec: "The job is the authority"). JOB_CONFIRMED carries sha256(JCS(this)). */
export function authorityOf(job: JobRecord): Job {
  return {
    v: 1,
    job_id: job.id,
    policy_version: job.policy_version,
    owner: job.owner_id,
    connection: job.connection_id,
    agent_connection: job.agent_connection_id,
    provider: job.provider,
    sender: job.sender,
    recipient: job.recipient_email,
    purpose: job.purpose,
    template: { id: job.template_id, sha256: job.template_sha256 },
    field_rules: job.field_rules,
    max_sends: job.max_sends,
    expires_at: isoSeconds(job.expires_at),
    auto_send: job.auto_send,
    allow_custom_with_approval: job.allow_custom_with_approval,
    ai_review: job.ai_review,
  };
}

/** sha256(JCS(job)): the hash the confirm screen shows and JOB_CONFIRMED records. */
export function authoritySha256(job: Job): string {
  return canonicalSha256Hex(job);
}
