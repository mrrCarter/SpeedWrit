// The MCP tools an agent sees (spec: "Agent connection: MCP tools and OAuth"). Definitions only:
// names, input schemas, annotations and the server instructions. The handlers call the gate.
//
// - Input schemas set additionalProperties: false.
// - Read tools carry readOnlyHint: true. Write tools carry readOnlyHint: false,
//   destructiveHint: false, openWorldHint: true, so the client asks before running them; a write
//   tool is never marked read-only to skip that confirmation.
// - Every tool declares the oauth2 security scheme with scope jobs.act.

export const MCP_SCOPE = "jobs.act";

export type JsonSchemaObject = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
};

export type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
};

export type McpToolDefinition = {
  name: "list_jobs" | "propose_send" | "revise_proposal" | "get_status";
  title: string;
  description: string;
  inputSchema: JsonSchemaObject;
  annotations: ToolAnnotations;
  securitySchemes: [{ type: "oauth2"; scopes: [typeof MCP_SCOPE] }];
};

const SECURITY: McpToolDefinition["securitySchemes"] = [{ type: "oauth2", scopes: [MCP_SCOPE] }];
const READ: ToolAnnotations = { readOnlyHint: true };
const WRITE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };

const text = (maxLength: number, description: string) => ({ type: "string", maxLength, description });
const FIELDS = {
  type: "object",
  description: "Template field values, by field name. The job lists its fields and their rules.",
  additionalProperties: { type: "string", maxLength: 5000 },
};

export const MCP_TOOLS: readonly McpToolDefinition[] = Object.freeze([
  {
    name: "list_jobs",
    title: "List my jobs",
    description:
      "The active jobs this connection may act in: each job's id, purpose, recipient, template fields and their rules, sends left and expiry.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: READ,
    securitySchemes: SECURITY,
  },
  {
    name: "propose_send",
    title: "Send an email inside a job",
    description:
      "Sends one email inside a job the owner confirmed. Give the job id and the recipient, then either the template fields or a custom subject and body. Only status \"sent\" means the email went out.",
    inputSchema: {
      type: "object",
      properties: {
        job_id: text(100, "The job to act in, from list_jobs."),
        to: text(254, "Exactly one email address: the job's recipient."),
        fields: FIELDS,
        custom_subject: text(150, "Custom wording only: one line. Needs the owner's approval."),
        custom_body: text(5000, "Custom wording only: plain text. Needs the owner's approval."),
        operation_id: text(100, "Optional. Repeating an operation_id returns the existing result and sends nothing new."),
      },
      required: ["job_id", "to"],
      additionalProperties: false,
    },
    annotations: WRITE,
    securitySchemes: SECURITY,
  },
  {
    name: "revise_proposal",
    title: "Revise a pending email",
    description:
      "Replaces a pending proposal's wording with new template fields or new custom text. The new version waits for the owner's approval.",
    inputSchema: {
      type: "object",
      properties: {
        proposal_id: text(100, "The pending proposal, from propose_send."),
        fields: FIELDS,
        custom_subject: text(150, "One line."),
        custom_body: text(5000, "Plain text."),
      },
      required: ["proposal_id"],
      additionalProperties: false,
    },
    annotations: WRITE,
    securitySchemes: SECURITY,
  },
  {
    name: "get_status",
    title: "Check a proposal",
    description: "The current status and version of a proposal, and the provider's message id once it was accepted.",
    inputSchema: {
      type: "object",
      properties: { proposal_id: text(100, "The proposal, from propose_send.") },
      required: ["proposal_id"],
      additionalProperties: false,
    },
    annotations: READ,
    securitySchemes: SECURITY,
  },
]);

/** The server instructions, as the spec writes them. The first 512 characters stand alone. */
export const MCP_INSTRUCTIONS =
  "WRIT sends email only inside jobs the owner confirmed. Call list_jobs first. Use propose_send for " +
  'every message. An email went out only if the result says status "sent". If status is "denied", do not ' +
  "retry with another recipient or wording; tell the user which rule stopped it. If status is " +
  '"pending_approval", say it is waiting for the owner and check get_status later. If status is "unknown", ' +
  "do not resend. Never claim success otherwise.";
