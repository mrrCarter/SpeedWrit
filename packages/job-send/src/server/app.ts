// The one HTTP service (spec: "one standalone service in the event repo: web UI, owner API, MCP
// endpoint, executor"), as a composition: the handlers are tried in the order the entry point
// lists them (owner sign-in, Connect Gmail, the owner API, the owner app), and the first that
// answers wins; the agent connection (OAuth, /mcp, the secret path, the metadata) answers whatever
// is left, with a 404 for anything unknown.
//
// The access log never records a secret path: the path is the credential (spec: "strip the path
// from access logs"). The env-to-database wiring lives with the app's entry point, not here.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

/** A handler that answers its own requests and returns true, or returns false to pass one on. */
export type AppHandler = (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>;

export type AppOptions = {
  /** Tried in this order; the first that answers wins. */
  handlers: readonly AppHandler[];
  /** OAuth, /mcp, the secret path and the metadata (createJobSendHandler): answers whatever is left. */
  agent: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  /** One line per answered request, with any secret path redacted. */
  log?: (line: string) => void;
  onError?: (error: unknown) => void;
};

/** The path the handlers route on, parsed the same way they parse it. */
function routedPath(rawUrl: string | undefined): string | null {
  try {
    return new URL(rawUrl ?? "/", "http://localhost").pathname;
  } catch {
    return null;
  }
}

/**
 * A request path fit for a log: parsed exactly as the router parses it (so an absolute-form or
 * "//host/..." target that routes to a secret path is caught too), host and query dropped, and
 * anything under /mcp/c/ replaced.
 */
export function redactPath(rawUrl: string | undefined): string {
  const path = routedPath(rawUrl);
  if (path === null) return "[unparsable]";
  return path.startsWith("/mcp/c/") ? "/mcp/c/[redacted]" : path;
}

/** The composed request handler. */
export function createApp(options: AppOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (options.log) {
      const log = options.log;
      res.on("finish", () => log(`${req.method} ${redactPath(req.url)} ${res.statusCode}`));
    }
    try {
      if (req.method === "GET" && routedPath(req.url) === "/healthz") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end('{"ok":true}');
        return;
      }
      for (const handler of options.handlers) {
        if (await handler(req, res)) return;
      }
      await options.agent(req, res);
    } catch (error) {
      options.onError?.(error);
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
        res.end('{"error":"server_error"}');
      }
    }
  };
}

/** A node:http server with the composed handler. Call listen on it, behind TLS. */
export function createAppServer(options: AppOptions): Server {
  const handler = createApp(options);
  return createServer((req, res) => void handler(req, res));
}
