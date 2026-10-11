import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";

import { createAppServer, redactPath } from "../../dist/server/app.js";

const SECRET = "S".repeat(43);

/** The app with stand-in handlers that say who answered. */
async function start(overrides = {}) {
  const lines = [];
  const errors = [];
  const answered = (who) => (res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(who);
  };
  const handlers = {
    ownerAuth: async (req, res) => (req.url.startsWith("/auth/") ? (answered("ownerAuth")(res), true) : false),
    ownerApi: async (req, res) => (req.url.startsWith("/owner/") ? (answered("ownerApi")(res), true) : false),
    // Synchronous, as a static file handler may be.
    ownerApp: (req, res) => (req.url === "/" || req.url.startsWith("/owner-app/") || req.url.startsWith("/owner/me") ? (answered("ownerApp")(res), true) : false),
    ...overrides,
  };
  const server = createAppServer({
    handlers: [handlers.ownerAuth, handlers.ownerApi, handlers.ownerApp],
    agent: async (req, res) => {
      const path = new URL(req.url, "http://localhost").pathname;
      if (path === "/mcp" || path.startsWith("/mcp/c/") || path.startsWith("/oauth/")) return answered("agent")(res);
      res.writeHead(404);
      res.end("agent 404");
    },
    log: (line) => lines.push(line),
    onError: (error) => errors.push(error),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, port, lines, errors, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** A raw request with any request target, for the forms fetch() would normalize away. */
function raw(port, method, target) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path: target }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("handlers answer in a fixed order: sign-in, the owner API, the owner app, then the agent connection", async () => {
  const app = await start();
  try {
    assert.equal(await (await fetch(`${app.base}/auth/sign-in`)).text(), "ownerAuth");
    assert.equal(await (await fetch(`${app.base}/owner/me`)).text(), "ownerApi", "the owner API before the app, even where both would answer");
    assert.equal(await (await fetch(`${app.base}/owner-app/`)).text(), "ownerApp");
    assert.equal(await (await fetch(`${app.base}/`)).text(), "ownerApp");
    assert.equal(await (await fetch(`${app.base}/oauth/token`, { method: "POST" })).text(), "agent");
    assert.equal(await (await fetch(`${app.base}/mcp`, { method: "POST" })).text(), "agent");
    assert.equal((await fetch(`${app.base}/nothing`)).status, 404);
    const health = await fetch(`${app.base}/healthz`);
    assert.deepEqual(await health.json(), { ok: true });
    assert.equal(health.headers.get("cache-control"), "no-store");
  } finally {
    await app.close();
  }
});

test("the access log never holds a secret path, however the request target is written", async () => {
  const app = await start();
  try {
    await fetch(`${app.base}/mcp/c/${SECRET}?x=1`, { method: "POST" });
    for (const target of [`http://jobs.example.test/mcp/c/${SECRET}`, `//jobs.example.test/mcp/c/${SECRET}`, `/mcp/c/${SECRET}#frag`]) {
      const res = await raw(app.port, "POST", target);
      assert.equal(res.body, "agent", `${target.replace(SECRET, "<secret>")} routes to the secret path`);
    }
    await fetch(`${app.base}/owner/me?token=abc`);
    assert.equal(app.lines.length, 5);
    for (const line of app.lines) {
      assert.equal(line.includes(SECRET), false, line);
      assert.equal(line.includes("token=abc"), false, "no query in the log");
    }
    assert.deepEqual(app.lines.slice(0, 4), ["POST /mcp/c/[redacted] 200", "POST /mcp/c/[redacted] 200", "POST /mcp/c/[redacted] 200", "POST /mcp/c/[redacted] 200"]);
  } finally {
    await app.close();
  }
  assert.equal(redactPath(`/mcp/c/${SECRET}`), "/mcp/c/[redacted]");
  assert.equal(redactPath("/mcp"), "/mcp");
  assert.equal(redactPath("http://[bad"), "[unparsable]");
});

test("a handler that throws is a plain 500, reported, and the server keeps serving", async () => {
  const app = await start({
    ownerApi: async (req) => {
      if (req.url.startsWith("/owner/")) throw new Error("connection refused 10.0.0.5:5432");
      return false;
    },
  });
  try {
    const res = await fetch(`${app.base}/owner/me`);
    assert.equal(res.status, 500);
    assert.equal((await res.text()).includes("10.0.0.5"), false);
    assert.equal(app.errors.length, 1);
    assert.equal((await fetch(`${app.base}/healthz`)).status, 200);
  } finally {
    await app.close();
  }
});
