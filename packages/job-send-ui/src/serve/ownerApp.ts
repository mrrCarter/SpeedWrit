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
export const OWNER_APP_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
export const OWNER_APP_PATH = "/owner-app/";
/** Written by build:app beside app.js: the receipt key compiled into the app. Read at start, never served. */
export const RECEIPT_KEY_FILE = "receipt-key.json";

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
 * Refuses an owner app built with another receipt key than the one the service signs with: its Verify page would
 * call every receipt "Signature invalid". `receiptKeyId` is the signing key's id, receiptKeyId(exportRawPublicKey(pem)).
 */
export function checkOwnerAppReceiptKey(dir: string, receiptKeyId: string): void {
  let built: unknown;
  try {
    built = JSON.parse(readFileSync(join(dir, RECEIPT_KEY_FILE), "utf8"));
  } catch {
    throw new Error(`owner app: no readable ${RECEIPT_KEY_FILE} in ${dir}; rebuild it with build:app`);
  }
  const builtId = built !== null && typeof built === "object" ? (built as { key_id?: unknown }).key_id : undefined;
  if (builtId !== receiptKeyId) {
    throw new Error(`owner app: built for receipt key ${String(builtId)}, but this service signs with ${receiptKeyId}; rebuild it with build:app`);
  }
}

/**
 * The handler: true when it answered (a path it owns), false for any other path. `dir` is the build output
 * (dist/owner-app); its two files are read now, so a missing build fails at start, not on the first visit. With
 * `receiptKeyId`, an app built for another receipt key fails at start too.
 */
export function serveOwnerApp(options: { dir: string; config: OwnerAppConfig; receiptKeyId?: string }): (req: IncomingMessage, res: ServerResponse) => Promise<boolean> {
  checkOwnerAppConfig(options.config);
  if (options.receiptKeyId !== undefined) checkOwnerAppReceiptKey(options.dir, options.receiptKeyId);
  let css: Buffer | undefined;
  try { css = readFileSync(join(options.dir, "app.css")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
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
    } else if (path === `${OWNER_APP_PATH}app.css` && css) {
      send(req, res, 200, { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache" }, css);
    } else if (path === `${OWNER_APP_PATH}config.json`) {
      send(req, res, 200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, files.config);
    } else {
      send(req, res, 404, { "content-type": "text/plain; charset=utf-8" }, Buffer.from("Not found"));
    }
    return true;
  };
}
