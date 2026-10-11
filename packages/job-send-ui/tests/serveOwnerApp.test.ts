// @vitest-environment node
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { OWNER_APP_CSP, RECEIPT_KEY_FILE, serveOwnerApp, type OwnerAppConfig } from "../src/serve/ownerApp";

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/test-owner-app");
const BUILD_SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/build-owner-app.mjs");
const CSS = ".owner-shell { color: #123456; }";
const CONFIG: OwnerAppConfig = {
  jobDefaults: { templateId: "tpl_recap", purpose: "Recap of Tuesday's call", autoSend: true },
  contacts: [{ name: "Dana Ruiz", company: "Acme", email: "dana@acme.com" }],
  connectGmailHref: "/connect/gmail",
  timeZone: "America/Los_Angeles",
};

const KEY_ID = "0123456789abcdef";

let server: Server;
let port = 0;

beforeAll(async () => {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(resolve(DIR, "index.html"), "<!doctype html><title>SpeedWrit</title>");
  writeFileSync(resolve(DIR, "app.js"), "export const app = 1;");
  writeFileSync(resolve(DIR, "app.css"), CSS);
  writeFileSync(resolve(DIR, RECEIPT_KEY_FILE), JSON.stringify({ key_id: KEY_ID, public_key_b64url: "x" }));
  const handle = serveOwnerApp({ dir: DIR, config: CONFIG, receiptKeyId: KEY_ID });
  server = createServer((req, res) => {
    void handle(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(418);
        res.end("not mine");
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(DIR, { recursive: true, force: true });
});

/** A raw request, so the path is sent exactly as written (fetch would normalize it). */
function call(method: string, path: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((done, fail) => {
    const req = request({ host: "127.0.0.1", port, method, path }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => done({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", fail);
    req.end();
  });
}

describe("serveOwnerApp", () => {
  it("refuses at start an app built for another receipt key, or with no record of its key", () => {
    expect(() => serveOwnerApp({ dir: DIR, config: CONFIG, receiptKeyId: "fedcba9876543210" })).toThrow(
      "owner app: built for receipt key 0123456789abcdef, but this service signs with fedcba9876543210; rebuild it with build:app",
    );
    const bare = resolve(DIR, "../test-owner-app-bare");
    mkdirSync(bare, { recursive: true });
    writeFileSync(resolve(bare, "index.html"), "<!doctype html>");
    writeFileSync(resolve(bare, "app.js"), "");
    writeFileSync(resolve(bare, "app.css"), "");
    try {
      expect(() => serveOwnerApp({ dir: bare, config: CONFIG, receiptKeyId: KEY_ID })).toThrow(`no readable ${RECEIPT_KEY_FILE}`);
      // Without receiptKeyId the key is not checked (a caller that has none, such as a page-only preview).
      expect(typeof serveOwnerApp({ dir: bare, config: CONFIG })).toBe("function");
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it("never serves the key record", async () => {
    expect((await call("GET", `/owner-app/${RECEIPT_KEY_FILE}`)).status).toBe(404);
  });

  it("build:app refuses a key id that is not the id of the public key it compiles in", () => {
    const run = (keyId: string) =>
      spawnSync(process.execPath, [BUILD_SCRIPT], {
        env: { ...process.env, RECEIPT_KEY_ID: keyId, RECEIPT_PUBLIC_KEY_B64URL: "A".repeat(43) },
        encoding: "utf8",
      });
    // sha256 of 32 zero bytes starts 66687aadf862bd77; any other id names another key.
    const wrong = run(KEY_ID);
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain("RECEIPT_KEY_ID 0123456789abcdef is not the id of RECEIPT_PUBLIC_KEY_B64URL (whose id is 66687aadf862bd77)");
  });

  it("build:app emits and links imported CSS, and refuses a build that only has stale CSS", () => {
    const fixture = resolve(DIR, "../test-owner-css-build");
    mkdirSync(resolve(fixture, "scripts"), { recursive: true });
    mkdirSync(resolve(fixture, "src/app"), { recursive: true });
    copyFileSync(BUILD_SCRIPT, resolve(fixture, "scripts/build-owner-app.mjs"));
    writeFileSync(resolve(fixture, "src/app/main.tsx"), 'import "./owner-app.css";\ndocument.title = "Fixture";\n');
    writeFileSync(resolve(fixture, "src/app/owner-app.css"), CSS);
    const run = () => spawnSync(process.execPath, [resolve(fixture, "scripts/build-owner-app.mjs")], {
      cwd: fixture,
      env: { ...process.env, RECEIPT_KEY_ID: "66687aadf862bd77", RECEIPT_PUBLIC_KEY_B64URL: "A".repeat(43) },
      encoding: "utf8",
    });
    try {
      const built = run();
      expect(built.status, built.stderr).toBe(0);
      expect(readFileSync(resolve(fixture, "dist/owner-app/app.css"), "utf8")).toContain("#123456");
      const html = readFileSync(resolve(fixture, "dist/owner-app/index.html"), "utf8");
      expect(html).toContain('<link rel="stylesheet" href="/owner-app/app.css">');
      expect(html).not.toContain("<style");
      writeFileSync(resolve(fixture, "src/app/main.tsx"), 'document.title = "No stylesheet import";\n');
      const missing = run();
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain("owner app build did not emit app.css");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 10_000);

  it("'/' and '/owner-app' redirect to /owner-app/", async () => {
    for (const path of ["/", "/owner-app"]) {
      const res = await call("GET", path);
      expect(res.status, path).toBe(302);
      expect(res.headers.location).toBe("/owner-app/");
    }
  });

  it("serves the page, script, stylesheet and config with their types and the app's CSP", async () => {
    const page = await call("GET", "/owner-app/");
    expect(page.status).toBe(200);
    expect(page.body).toBe("<!doctype html><title>SpeedWrit</title>");
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers["content-security-policy"]).toBe(OWNER_APP_CSP);
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect((await call("GET", "/owner-app/index.html")).body).toBe(page.body);

    const script = await call("GET", "/owner-app/app.js");
    expect(script.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(script.body).toBe("export const app = 1;");

    const stylesheet = await call("GET", "/owner-app/app.css");
    expect(stylesheet.status).toBe(200);
    expect(stylesheet.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect(stylesheet.headers["content-security-policy"]).toBe(OWNER_APP_CSP);
    expect(stylesheet.headers["x-content-type-options"]).toBe("nosniff");
    expect(stylesheet.headers["cache-control"]).toBe("no-cache");
    expect(stylesheet.body).toBe(CSS);

    const config = await call("GET", "/owner-app/config.json");
    expect(config.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(config.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(config.body)).toEqual(CONFIG);
  });

  it("the CSP permits same-origin scripts, stylesheets and API calls without inline styles", () => {
    expect(OWNER_APP_CSP).toBe("default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  });

  it("serves only those names: anything else under /owner-app is 404, and no path reaches the disk", async () => {
    for (const path of ["/owner-app/app.js.map", "/owner-app/test-owner-app/index.html", "/owner-app/%2e%2e/package.json", "/owner-app/..%2fpackage.json", "/owner-app/index.html/"]) {
      const res = await call("GET", path);
      expect([404, 418], path).toContain(res.status);
      expect(res.body, path).not.toContain('"name"');
    }
    expect((await call("GET", "/owner-app/../../package.json")).status).toBe(418);
  });

  it("only GET and HEAD; HEAD sends the length without the body; other paths are not handled", async () => {
    const post = await call("POST", "/owner-app/");
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe("GET, HEAD");
    const head = await call("HEAD", "/owner-app/app.js");
    expect(head.status).toBe(200);
    expect(head.headers["content-length"]).toBe(String(Buffer.byteLength("export const app = 1;")));
    expect(head.body).toBe("");
    const cssHead = await call("HEAD", "/owner-app/app.css");
    expect(cssHead.status).toBe(200);
    expect(cssHead.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect(cssHead.headers["content-length"]).toBe(String(Buffer.byteLength(CSS)));
    expect(cssHead.body).toBe("");
    expect((await call("POST", "/owner-app/app.css")).status).toBe(405);
    for (const path of ["/mcp", "/oauth/authorize", "/owner/me", "/owner-apps/"]) expect((await call("GET", path)).status, path).toBe(418);
    expect((await call("POST", "/")).status).toBe(418);
  });

  it("refuses to start when the stylesheet is missing even if the script exists", () => {
    const noCss = resolve(DIR, "../test-owner-app-no-css");
    mkdirSync(noCss, { recursive: true });
    writeFileSync(resolve(noCss, "index.html"), "<!doctype html>");
    writeFileSync(resolve(noCss, "app.js"), "export const app = 1;");
    try {
      expect(() => serveOwnerApp({ dir: noCss, config: CONFIG })).toThrow("app.css");
    } finally {
      rmSync(noCss, { recursive: true, force: true });
    }
  });

  it("refuses to start without a build, or with a config the app would misuse", () => {
    expect(() => serveOwnerApp({ dir: resolve(DIR, "missing"), config: CONFIG })).toThrow();
    for (const bad of [
      { ...CONFIG, connectGmailHref: "https://evil.example/connect" },
      { ...CONFIG, connectGmailHref: "//evil.example/connect" },
      { ...CONFIG, jobDefaults: { ...CONFIG.jobDefaults, templateId: "" } },
      { ...CONFIG, contacts: [{ name: "x" }] },
    ]) {
      expect(() => serveOwnerApp({ dir: DIR, config: bad as OwnerAppConfig })).toThrow(TypeError);
    }
  });
});
