// grokbot's configuration, from the environment. Nothing secret is ever printed: the secret-path
// URL and the xAI key are redacted wherever a value is shown.

/** How grokbot proves it is an agent connection: the secret path, or an OAuth bearer from `grokbot login`. */
export type Credential = "secret_path" | "bearer";

/** How the bearer goes into xAI's `authorization` field: "Bearer <token>" (default) or the bare token. */
export type AuthStyle = "bearer" | "raw";

export type GrokbotConfig = {
  /** https://HOST/mcp (bearer) or https://HOST/mcp/c/<43-character secret> (secret path). */
  mcpUrl: string;
  /** The server's origin, https://HOST. */
  origin: string;
  credential: Credential;
  xaiApiKey: string | null;
  xaiBaseUrl: string;
  model: string;
  authStyle: AuthStyle;
  tokenFile: string;
  timeoutMs: number;
};

export type ConfigProblem = { name: string; problem: string };

export const DEFAULT_MODEL = "grok-4.7";
export const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
const SECRET_PATH = /^\/mcp\/c\/[A-Za-z0-9_-]{43}$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** The MCP URL with any secret path replaced, safe to print or log. */
export function redactMcpUrl(url: string): string {
  return url.replace(/\/mcp\/c\/[^/?#]+/, "/mcp/c/[redacted]");
}

export function readConfig(
  env: Record<string, string | undefined>,
  home: string,
): { ok: true; config: GrokbotConfig } | { ok: false; problems: ConfigProblem[] } {
  const problems: ConfigProblem[] = [];
  const text = (name: string) => {
    const value = env[name]?.trim();
    return value === undefined || value === "" ? null : value;
  };

  let mcpUrl = "";
  let origin = "";
  let credential: Credential = "bearer";
  const rawUrl = text("SPEEDWRIT_MCP_URL");
  if (!rawUrl) {
    problems.push({ name: "SPEEDWRIT_MCP_URL", problem: "required: https://HOST/mcp, or the secret-path URL https://HOST/mcp/c/<secret>" });
  } else {
    let url: URL | null = null;
    try {
      url = new URL(rawUrl);
    } catch {
      problems.push({ name: "SPEEDWRIT_MCP_URL", problem: "is not a URL" });
    }
    if (url) {
      const secure = url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname));
      if (!secure) problems.push({ name: "SPEEDWRIT_MCP_URL", problem: "must be https (http only for a loopback test host)" });
      if (url.search || url.hash || url.username || url.password) problems.push({ name: "SPEEDWRIT_MCP_URL", problem: "may not carry a query, fragment or credentials" });
      if (url.pathname === "/mcp") credential = "bearer";
      else if (SECRET_PATH.test(url.pathname)) credential = "secret_path";
      else problems.push({ name: "SPEEDWRIT_MCP_URL", problem: "the path must be /mcp or /mcp/c/<43-character secret>" });
      mcpUrl = `${url.origin}${url.pathname}`;
      origin = url.origin;
    }
  }

  const authStyleText = text("GROKBOT_XAI_AUTH_STYLE") ?? "bearer";
  if (authStyleText !== "bearer" && authStyleText !== "raw") problems.push({ name: "GROKBOT_XAI_AUTH_STYLE", problem: 'must be "bearer" or "raw"' });

  const timeoutText = text("GROKBOT_TIMEOUT_MS") ?? "180000";
  const timeoutMs = Number(timeoutText);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) problems.push({ name: "GROKBOT_TIMEOUT_MS", problem: "must be an integer from 1000 to 600000" });

  const xaiBaseUrl = (text("XAI_BASE_URL") ?? DEFAULT_XAI_BASE_URL).replace(/\/+$/, "");
  if (!/^https:\/\/[^/?#]+(\/[^?#]*)?$/.test(xaiBaseUrl)) problems.push({ name: "XAI_BASE_URL", problem: "must be an https URL" });

  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    config: {
      mcpUrl,
      origin,
      credential,
      xaiApiKey: text("XAI_API_KEY"),
      xaiBaseUrl,
      model: text("GROK_MODEL") ?? DEFAULT_MODEL,
      authStyle: authStyleText as AuthStyle,
      tokenFile: text("GROKBOT_TOKEN_FILE") ?? `${home}/.config/grokbot/tokens.json`,
      timeoutMs,
    },
  };
}
