// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveOwnerApp } from "../src/serve/ownerApp";

let server: Server;
let port: number;
let dir: string;
const privateMarker = "PRIVATE_OWNER_CONTACT_AND_JOB";

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "public-pages-"));
  writeFileSync(join(dir, "index.html"), "owner fixture");
  writeFileSync(join(dir, "app.js"), "owner script");
  writeFileSync(join(dir, "app.css"), "body{}");
  writeFileSync(join(dir, "receipt-key.json"), "PRIVATE_KEY_MANIFEST");
  const handle = serveOwnerApp({ dir, config: {
    jobDefaults: { templateId: privateMarker, purpose: privateMarker, autoSend: true },
    contacts: [{ name: privateMarker, email: "private-owner@example.test" }], connectGmailHref: "/auth/gmail/connect",
  } });
  server = createServer((req, res) => { void handle(req, res).then((handled) => { if (!handled) { res.writeHead(404); res.end(); } }); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => { await new Promise<void>((done) => server.close(() => done())); rmSync(dir, { recursive: true, force: true }); });

function call(path: string, method = "GET"): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host: "untrusted-host.example", cookie: "private-cookie-marker" } }, (res) => {
      let body = ""; res.setEncoding("utf8"); res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on("error", reject); req.end();
  });
}

describe("public information routes", () => {
  it.each(["/about", "/privacy", "/terms"])("serves %s without sign-in, scripts or private configuration", async (path) => {
    const page = await call(path);
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers["content-security-policy"]).toBe("default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["x-frame-options"]).toBe("DENY");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.headers["set-cookie"]).toBeUndefined();
    expect(page.headers["www-authenticate"]).toBeUndefined();
    expect(page.headers.location).toBeUndefined();
    expect(page.body).toContain('<html lang="en">');
    expect(page.body).toContain('<h1>');
    expect(page.body).not.toMatch(/<script|<style|<form|\son\w+=/i);
    for (const secret of [privateMarker, "private-owner@example.test", "private-cookie-marker", "untrusted-host.example", "PRIVATE_KEY_MANIFEST", "config.json", "receipt-key.json"]) expect(page.body).not.toContain(secret);
    const withQuery = await call(`${path}?token=never-reflect-this`);
    expect(withQuery.body).toBe(page.body);
    const head = await call(path, "HEAD");
    expect(head.status).toBe(200); expect(head.body).toBe("");
    expect(head.headers["content-length"]).toBe(String(Buffer.byteLength(page.body)));
    expect(head.headers["content-security-policy"]).toBe(page.headers["content-security-policy"]);
  });

  it("links all public documents and the owner entry on the same origin, with a packaged stylesheet", async () => {
    for (const path of ["/about", "/privacy", "/terms"]) {
      const { body } = await call(path);
      for (const link of ["/about", "/privacy", "/terms", "/owner-app/", "/public.css"]) expect(body).toContain(`href="${link}"`);
      const links = [...body.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!);
      expect(links.every((href) => ["/about", "/privacy", "/terms", "/owner-app/", "/owner-app/#/connect", "/public.css", "mailto:carther91@gmail.com"].includes(href))).toBe(true);
    }
    const css = await call("/public.css");
    expect(css.status).toBe(200); expect(css.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect(css.body).toContain(":focus-visible"); expect(css.body).not.toMatch(/url\(|@import/);
    const head = await call("/public.css", "HEAD");
    expect(head.status).toBe(200); expect(head.body).toBe(""); expect(head.headers["content-length"]).toBe(String(Buffer.byteLength(css.body)));
  });

  it("points to Connections for the actual MCP endpoint and explains the recipient restriction", async () => {
    const { body } = await call("/about");
    expect(body).toContain('href="/owner-app/#/connect"');
    expect(body).not.toContain('href="/mcp"');
    expect(body).toContain("configured list of demonstration recipients");
    expect(body).toContain("Adding your own contacts or selecting arbitrary recipients is not available");
  });

  it("keeps the root redirect and the fixed file boundary", async () => {
    expect((await call("/")).headers.location).toBe("/owner-app/");
    for (const path of ["/about/", "/About", "/privacy.html", "/public.css.map", "/publicPages.ts", "/receipt-key.json", "/owner-app/receipt-key.json", "/about/%2e%2e/receipt-key.json", "/privacy/..%2fpackage.json"]) {
      const res = await call(path); expect(res.status, path).toBe(404); expect(res.body).not.toContain("PRIVATE_KEY_MANIFEST");
    }
    for (const path of ["/about", "/privacy", "/terms", "/public.css"]) {
      const res = await call(path, "POST"); expect(res.status).toBe(405); expect(res.headers.allow).toBe("GET, HEAD");
    }
  });
});
