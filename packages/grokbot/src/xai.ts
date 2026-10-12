// Grok over xAI's Responses API with SpeedWrit as a remote MCP tool (docs.x.ai, "Remote MCP
// Tools"). xAI calls SpeedWrit's /mcp itself, from its side; grokbot never relays a tool call.
// xAI has no `require_approval`, so nothing on the client asks before a write. SpeedWrit's gate
// is the only authority, which is the point: the job decides, not the client.

import type { AuthStyle } from "./config.js";

/** SpeedWrit's four tools. Nothing else is exposed to Grok. */
export const SPEEDWRIT_TOOLS = ["list_jobs", "propose_send", "revise_proposal", "get_status"] as const;

export const SERVER_LABEL = "speedwrit";

export const SERVER_DESCRIPTION =
  "SpeedWrit: send email for the owner only inside a job the owner confirmed (one recipient, a send limit, an expiry). Every decision gets a signed receipt.";

/** grokbot's standing instruction. It restates the result rules SpeedWrit's tools already enforce. */
export const GROKBOT_INSTRUCTIONS = [
  "You are grokbot, the owner's assistant. You can send email only through the speedwrit tools.",
  "Call list_jobs before acting, and act only inside a job it returns.",
  "Only a result with status \"sent\" means the email went out. \"pending_approval\" means the owner must approve it first; say so and stop.",
  "\"denied\" cannot be approved: say why, in the tool's words. \"unknown\" means do not resend; the owner will check.",
  "Never claim an email was sent unless the tool said so.",
].join(" ");

export type Turn = { role: "system" | "user" | "assistant"; content: string };

export type McpToolSpec = {
  type: "mcp";
  server_url: string;
  server_label: string;
  server_description: string;
  allowed_tools: string[];
  authorization?: string;
};

/** The remote MCP tool entry. A secret-path URL carries its own credential, so it gets no authorization. */
export function mcpTool(serverUrl: string, bearer: string | null, authStyle: AuthStyle): McpToolSpec {
  const tool: McpToolSpec = {
    type: "mcp",
    server_url: serverUrl,
    server_label: SERVER_LABEL,
    server_description: SERVER_DESCRIPTION,
    allowed_tools: [...SPEEDWRIT_TOOLS],
  };
  if (bearer !== null) tool.authorization = authStyle === "bearer" ? `Bearer ${bearer}` : bearer;
  return tool;
}

export type ResponsesRequest = { model: string; input: Turn[]; tools: McpToolSpec[]; store: false };

export function buildResponsesRequest(options: { model: string; turns: readonly Turn[]; tool: McpToolSpec }): ResponsesRequest {
  return { model: options.model, input: [{ role: "system", content: GROKBOT_INSTRUCTIONS }, ...options.turns], tools: [options.tool], store: false };
}

/** One SpeedWrit call Grok made, as xAI reports it. */
export type ToolCallTrace = { name: string; arguments: unknown; output: string | null; error: string | null; status: string | null };

export type ParsedResponse = { id: string | null; text: string; calls: ToolCallTrace[]; listedTools: string[] | null };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

function parseArguments(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function errorText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string") return raw;
  if (isRecord(raw) && typeof raw.message === "string") return raw.message;
  return JSON.stringify(raw);
}

/**
 * The answer text and the MCP calls, from a Responses API body. Tolerant by design: the output
 * item types follow the OpenAI-compatible shape (message, mcp_call, mcp_list_tools), and anything
 * unrecognized is skipped, never guessed at.
 */
export function parseResponse(body: unknown): ParsedResponse {
  const parsed: ParsedResponse = { id: null, text: "", calls: [], listedTools: null };
  if (!isRecord(body)) return parsed;
  parsed.id = str(body.id);
  const texts: string[] = [];
  for (const item of Array.isArray(body.output) ? body.output : []) {
    if (!isRecord(item)) continue;
    const type = str(item.type) ?? "";
    if (type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (isRecord(part) && (part.type === "output_text" || part.type === "text") && typeof part.text === "string") texts.push(part.text);
      }
    } else if (type === "mcp_list_tools" && Array.isArray(item.tools)) {
      parsed.listedTools = item.tools.flatMap((tool) => (isRecord(tool) && typeof tool.name === "string" ? [tool.name] : []));
    } else if (type === "mcp_call" || (type.endsWith("_call") && typeof item.server_label === "string")) {
      parsed.calls.push({
        name: str(item.name) ?? "unknown",
        arguments: parseArguments(item.arguments),
        output: str(item.output),
        error: errorText(item.error),
        status: str(item.status),
      });
    }
  }
  parsed.text = texts.length > 0 ? texts.join("\n") : (str(body.output_text) ?? "");
  return parsed;
}

export class XaiError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(`xAI answered ${status}: ${detail}`);
    this.name = "XaiError";
  }
}

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<Response>;

/** POST /responses. One attempt; a failure is reported, never retried (a retry could repeat a send request). */
export async function createResponse(
  fetchImpl: FetchLike,
  options: { baseUrl: string; apiKey: string; request: ResponsesRequest; timeoutMs: number },
): Promise<ParsedResponse> {
  const res = await fetchImpl(`${options.baseUrl}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify(options.request),
    signal: AbortSignal.timeout(options.timeoutMs),
  });
  const raw = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  if (!res.ok) {
    const detail = isRecord(body) ? (errorText(body.error) ?? str(body.message) ?? raw) : raw;
    throw new XaiError(res.status, String(detail).slice(0, 300));
  }
  return parseResponse(body);
}
