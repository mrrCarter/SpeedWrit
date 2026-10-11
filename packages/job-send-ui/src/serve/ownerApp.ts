// Serves the built owner app (scripts/build-owner-app.mjs) from the app server: index.html, app.js and config.json
// under /owner-app/, and "/" redirects there. Plain node:http, no React; its own entry
// ("@writ/job-send-ui/serve"). Only these fixed names are served, read once at start; no request path ever reaches
// the file system, so there is nothing to traverse or list.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OwnerAppConfig } from "../app/config";

export type { OwnerAppConfig };

/** The owner app's page policy: its own script and API, nothing else, never framed. */
export const OWNER_APP_CSP = "default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
export const OWNER_APP_PATH = "/owner-app/";

const COMMON = {
  "content-security-policy": OWNER_APP_CSP,
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

const sameSitePath = (href: unknown) => typeof href === "string" && href.startsWith("/") && !href.startsWith("//");

/** Checks the config the app will be served with; throws on anything the app would refuse or misuse. */
export function checkOwnerAppConfig(config: OwnerAppConfig): void {
  const { jobDefaults, contacts, connectGmailHref } = config ?? ({} as OwnerAppConfig);
  if (!jobDefaults || typeof jobDefaults.templateId !== "string" || jobDefaults.templateId === "" || typeof jobDefaults.purpose !== "string" || typeof jobDefaults.autoSend !== "boolean") {
    throw new TypeError("owner app config: jobDefaults needs templateId, purpose and autoSend");
  }
  if (!Array.isArray(contacts) || !contacts.every((c) => c && typeof c.name === "string" && typeof c.email === "string")) {
    throw new TypeError("owner app config: contacts must be a list of { name, email, company? }");
  }
  if (!sameSitePath(connectGmailHref)) throw new TypeError("owner app config: connectGmailHref must be a same-site path such as /connect/gmail");
}

/**
 * The handler: true when it answered (a path it owns), false for any other path. `dir` is the build output
 * (dist/owner-app); its two files are read now, so a missing build fails at start, not on the first visit.
 */
export function serveOwnerApp(options: { dir: string; config: OwnerAppConfig }): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  checkOwnerAppConfig(options.config);
  const files = {
    html: readFileSync(join(options.dir, "index.html")),
    js: readFileSync(join(options.dir, "app.js")),
    config: Buffer.from(JSON.stringify(options.config), "utf8"),
  };

  const send = (req: IncomingMessage, res: ServerResponse, status: number, headers: Record<string, string>, body?: Buffer) => {
    res.writeHead(status, { ...COMMON, ...headers, ...(body ? { "content-length": String(body.byteLength) } : {}) });
    res.end(req.method === "HEAD" ? undefined : body);
  };

  return async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/") {
      if (req.method !== "GET" && req.method !== "HEAD") return false;
      send(req, res, 302, { location: OWNER_APP_PATH, "cache-control": "no-store" });
      return true;
    }
    if (path !== "/owner-app" && !path.startsWith(OWNER_APP_PATH)) return false;
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(req, res, 405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" }, Buffer.from("Method not allowed"));
      return true;
    }
    if (path === "/owner-app") send(req, res, 302, { location: OWNER_APP_PATH, "cache-control": "no-store" });
    else if (path === OWNER_APP_PATH || path === `${OWNER_APP_PATH}index.html`) {
      send(req, res, 200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, files.html);
    } else if (path === `${OWNER_APP_PATH}app.js`) {
      send(req, res, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" }, files.js);
    } else if (path === `${OWNER_APP_PATH}config.json`) {
      send(req, res, 200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, files.config);
    } else {
      send(req, res, 404, { "content-type": "text/plain; charset=utf-8" }, Buffer.from("Not found"));
    }
    return true;
  };
}
