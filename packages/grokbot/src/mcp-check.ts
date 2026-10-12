// `grokbot doctor`: speak MCP to SpeedWrit directly, with the same URL and credential xAI will
// use, before spending any Grok tokens. initialize, then tools/list.

import type { FetchLike } from "./xai.js";
import { SPEEDWRIT_TOOLS } from "./xai.js";

export type McpCheck =
  | { ok: true; serverName: string | null; protocolVersion: string | null; tools: string[]; missing: string[] }
  | { ok: false; step: "initialize" | "tools/list"; status: number | null; problem: string };

const PROTOCOL_VERSION = "2025-06-18";

/** The JSON-RPC message from a JSON body or from the first SSE `data:` line that parses. */
function readRpc(contentType: string, raw: string): unknown {
  if (contentType.includes("text/event-stream")) {
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        return JSON.parse(line.slice(5).trim());
      } catch {
        continue;
      }
    }
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function rpc(fetchImpl: FetchLike, url: string, bearer: string | null, id: number, method: string, params: unknown, timeoutMs: number) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL_VERSION,
  };
  if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
  const res = await fetchImpl(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(timeoutMs) });
  const raw = await res.text();
  return { res, message: readRpc(res.headers.get("content-type") ?? "", raw) as { result?: Record<string, unknown>; error?: { message?: string } } | null };
}

function explainStatus(res: Response): string {
  if (res.status === 401) {
    return res.headers.get("www-authenticate")
      ? "401 with an OAuth challenge: the bearer is missing, expired or revoked. Run `grokbot login`."
      : "401 without an OAuth challenge.";
  }
  if (res.status === 404) return "404: a secret path that is unknown or revoked, or no MCP endpoint at this URL.";
  return `HTTP ${res.status}`;
}

export async function checkMcp(fetchImpl: FetchLike, options: { url: string; bearer: string | null; timeoutMs?: number }): Promise<McpCheck> {
  const timeoutMs = options.timeoutMs ?? 15000;
  const init = await rpc(fetchImpl, options.url, options.bearer, 1, "initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "grokbot-doctor", version: "0.1.0" },
  }, timeoutMs);
  if (!init.res.ok) return { ok: false, step: "initialize", status: init.res.status, problem: explainStatus(init.res) };
  if (!init.message?.result) return { ok: false, step: "initialize", status: init.res.status, problem: init.message?.error?.message ?? "no JSON-RPC result" };
  const serverInfo = init.message.result.serverInfo as { name?: unknown } | undefined;

  const list = await rpc(fetchImpl, options.url, options.bearer, 2, "tools/list", {}, timeoutMs);
  if (!list.res.ok) return { ok: false, step: "tools/list", status: list.res.status, problem: explainStatus(list.res) };
  const tools = list.message?.result?.tools;
  if (!Array.isArray(tools)) return { ok: false, step: "tools/list", status: list.res.status, problem: list.message?.error?.message ?? "no tool list" };
  const names = tools.flatMap((tool: unknown) => (typeof tool === "object" && tool !== null && typeof (tool as { name?: unknown }).name === "string" ? [(tool as { name: string }).name] : []));
  return {
    ok: true,
    serverName: typeof serverInfo?.name === "string" ? serverInfo.name : null,
    protocolVersion: typeof init.message.result.protocolVersion === "string" ? init.message.result.protocolVersion : null,
    tools: names,
    missing: SPEEDWRIT_TOOLS.filter((name) => !names.includes(name)),
  };
}
