import { canonicalSha256Hex, sha256Hex } from "../hash.js";
import { normalizeAddress } from "./address.js";
import { RenderError } from "./errors.js";
import { fill } from "./fill.js";
import { buildMime, toCrlf } from "./mime.js";
import type { RenderJob, SendCall, Template } from "./types.js";

/** What render() produces. `body` is CRLF-normalized and is exactly the text inside `mime`. */
export interface Draft {
  recipient: string;
  subject: string;
  body: string;
  mime: Uint8Array;
  /** Agent-written text: the custom body, or the free_text field values joined by "\n". */
  free_text: string;
  custom: boolean;
  /** The call's fields as given, or null for custom wording. */
  fields: Record<string, string> | null;
}

/** The hashed description of one proposal version (spec, store_version). */
export interface VersionCanonical {
  v: 1;
  job_id: string;
  policy_version: number;
  connection_id: string;
  provider: string;
  sender: string;
  recipient: string;
  template_id: string;
  template_sha256: string;
  fields: Record<string, string> | null;
  custom: boolean;
  subject: string;
  body_sha256: string;
  mime_sha256: string;
  job_expires_at: string;
}

export interface RenderResult {
  draft: Draft;
  canonical: VersionCanonical;
  version_sha256: string;
}

/**
 * sha256(JCS({v, subject_tpl, body_tpl})). The job names a template by id and this hash, so the
 * text rendered is the text the owner confirmed. To be reconciled with the contract's definition.
 */
export function templateSha256(template: Pick<Template, "subject_tpl" | "body_tpl">): string {
  return canonicalSha256Hex({ v: 1, subject_tpl: template.subject_tpl, body_tpl: template.body_tpl });
}

/**
 * Renders the message the executor would send. A pure function of its inputs: the gate has already
 * checked the field rules; this re-checks only what rendering depends on. The recipient is compared
 * with the gate's normalizer on both sides, so the two can never disagree about whether `to` is the
 * job's recipient, and the message goes to that normalized address.
 * `template` is the templates row the job names; it may be null for custom wording.
 *
 * The MIME carries no X-Writ-Version header: version_sha256 covers mime_sha256, so the stored
 * bytes cannot name their own version hash. buildMime accepts a versionTag for a tag defined
 * some other way.
 */
export function render(job: RenderJob, to: string, call: SendCall, template: Template | null): RenderResult {
  const recipient = normalizeAddress(to);
  if (recipient === null || recipient !== normalizeAddress(job.recipient)) {
    throw new RenderError("recipient_not_in_job", "to must be the job's recipient", "to");
  }
  const hasFields = call.fields !== undefined && call.fields !== null;
  const hasCustom = call.custom_subject !== undefined || call.custom_body !== undefined;
  if (hasFields && hasCustom) {
    throw new RenderError("field_not_allowed", "fields and custom text cannot be combined");
  }
  if (!hasFields && !hasCustom) {
    throw new RenderError("invalid_call", "a call needs fields or custom_subject with custom_body");
  }

  const content = hasFields ? fromTemplate(job, call.fields as Record<string, string>, template) : fromCustom(job, call);
  const mime = buildMime({ from: job.sender, to: recipient, subject: content.subject, body: content.body });
  const draft: Draft = { recipient, mime, ...content };
  const canonical = versionCanonical(job, draft);
  return { draft, canonical, version_sha256: versionSha256(canonical) };
}

type Content = Omit<Draft, "recipient" | "mime">;

function fromTemplate(job: RenderJob, fields: Record<string, string>, template: Template | null): Content {
  if (
    template === null ||
    template.id !== job.template.id ||
    template.sha256 !== job.template.sha256 ||
    templateSha256(template) !== template.sha256
  ) {
    throw new RenderError("template_mismatch", "the template is not the one the job names");
  }
  if (typeof fields !== "object" || Array.isArray(fields)) {
    throw new RenderError("invalid_call", "fields must be an object");
  }
  const rules = job.field_rules;
  const entries = Object.entries(fields);
  for (const [name, value] of entries) {
    if (!Object.hasOwn(rules, name)) {
      throw new RenderError("field_not_allowed", `field ${name} is not in the job's rules`, name);
    }
    if (typeof value !== "string") {
      throw new RenderError("invalid_field_value", `field ${name} must be a string`, name);
    }
  }
  // fromEntries defines own properties, so even a "__proto__" name stays a plain data field.
  const given = Object.fromEntries(entries) as Record<string, string>;

  // Every rule name has a value; an optional field the agent left out renders as "".
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, rule] of Object.entries(rules)) {
    const value = Object.hasOwn(given, name) ? given[name] : undefined;
    if (rule.required && (value === undefined || value === "")) {
      throw new RenderError("missing_field", `required field ${name} is missing`, name);
    }
    values[name] = value ?? "";
  }

  const freeText = Object.keys(rules)
    .filter((name) => rules[name]?.free_text === true && (values[name] ?? "") !== "")
    .sort()
    .map((name) => values[name] ?? "")
    .join("\n");

  return {
    subject: fill(template.subject_tpl, values),
    body: toCrlf(fill(template.body_tpl, values)),
    free_text: freeText,
    custom: false,
    fields: given,
  };
}

function fromCustom(job: RenderJob, call: SendCall): Content {
  if (!job.allow_custom_with_approval) {
    throw new RenderError("custom_not_allowed", "this job allows only the approved template");
  }
  if (typeof call.custom_subject !== "string" || typeof call.custom_body !== "string") {
    throw new RenderError("invalid_call", "custom wording needs both custom_subject and custom_body");
  }
  const body = toCrlf(call.custom_body);
  return { subject: call.custom_subject, body, free_text: body, custom: true, fields: null };
}

/** The canonical object store_version hashes, from the job and a rendered draft. */
export function versionCanonical(job: RenderJob, draft: Draft): VersionCanonical {
  return {
    v: 1,
    job_id: job.job_id,
    policy_version: job.policy_version,
    connection_id: job.connection,
    provider: job.provider,
    sender: job.sender,
    recipient: draft.recipient,
    template_id: job.template.id,
    template_sha256: job.template.sha256,
    fields: draft.fields,
    custom: draft.custom,
    subject: draft.subject,
    body_sha256: sha256Hex(draft.body),
    mime_sha256: sha256Hex(draft.mime),
    job_expires_at: job.expires_at,
  };
}

/** version_sha256 = sha256(JCS(canonical)). */
export function versionSha256(canonical: VersionCanonical): string {
  return canonicalSha256Hex(canonical);
}

/**
 * The reservation's integrity check on a stored version: the canonical still hashes to the stored
 * sha256, and the stored MIME bytes still hash to the canonical's mime_sha256.
 */
export function storedVersionIntact(stored: { canonical: VersionCanonical; sha256: string; mime: Uint8Array }): boolean {
  try {
    return versionSha256(stored.canonical) === stored.sha256 && sha256Hex(stored.mime) === stored.canonical.mime_sha256;
  } catch {
    return false;
  }
}
