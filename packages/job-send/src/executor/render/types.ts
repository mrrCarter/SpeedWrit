// Local mirrors of the spec's job, template and propose_send shapes.
// TO BE REPLACED BY CONTRACT TYPES (src/contract) when the Contract lane lands; field names follow
// the spec's job JSON ("The job is the authority") and the propose_send tool input.

export interface FieldRule {
  max: number;
  single_line?: boolean;
  required?: boolean;
  free_text?: boolean;
}

/** The job as the owner confirmed it. JOB_CONFIRMED hashes sha256(JCS(job)). */
export interface RenderJob {
  v: 1;
  job_id: string;
  policy_version: number;
  owner: string;
  connection: string;
  agent_connection: string;
  provider: string;
  sender: string;
  recipient: string;
  purpose: string;
  template: { id: string; sha256: string };
  field_rules: Record<string, FieldRule>;
  max_sends: number;
  expires_at: string;
  auto_send: boolean;
  allow_custom_with_approval: boolean;
  ai_review: "off" | "custom_only" | "all_free_text";
}

/** A row of the templates table. `sha256` must equal templateSha256() of its text. */
export interface Template {
  id: string;
  sha256: string;
  subject_tpl: string;
  body_tpl: string;
}

/** The content half of a propose_send or revise_proposal call: either `fields` or custom text. */
export interface SendCall {
  fields?: Record<string, string> | null;
  custom_subject?: string;
  custom_body?: string;
}
