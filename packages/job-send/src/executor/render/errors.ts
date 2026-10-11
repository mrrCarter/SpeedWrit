export type RenderErrorCode =
  | "malformed_template"
  | "unknown_placeholder"
  | "missing_field"
  | "field_not_allowed"
  | "invalid_field_value"
  | "custom_not_allowed"
  | "invalid_call"
  | "template_mismatch"
  | "recipient_not_in_job"
  | "header_injection"
  | "invalid_address"
  | "invalid_text"
  | "invalid_version_tag";

/**
 * A render refusal. The gate runs its own checks first, so in normal operation these fire only
 * when a caller skipped the gate or the stored job and template disagree.
 */
export class RenderError extends Error {
  readonly code: RenderErrorCode;
  /** The field or header the error is about, when there is one. */
  readonly subject: string | undefined;

  constructor(code: RenderErrorCode, message: string, subject?: string) {
    super(message);
    this.name = "RenderError";
    this.code = code;
    this.subject = subject;
  }
}
