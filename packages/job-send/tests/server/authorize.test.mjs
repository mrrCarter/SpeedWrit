import test from "node:test";
import assert from "node:assert/strict";

import { CHATGPT_REDIRECT, hashToken } from "../../dist/oauth/oauth.js";

import { request } from "node:http";

import { CHALLENGE, HOST, NOW, RESOURCE, barrier, codeParams, connect, register, rpc, start, token } from "./support/harness.mjs";

const PER_CONNECTION = "https://chatgpt.com/connector/oauth/conn_abc123";
const CSP = (redirectOrigin) => `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' ${redirectOrigin}`;

const authorizeQuery = (clientId, overrides = {}) =>
  new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: CHATGPT_REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    scope: "jobs.act",
    resource: RESOURCE,
    state: "st_1",
    ...overrides,
  });

const showConsent = (base, query, sid = "dana") =>
  fetch(`${base}/oauth/authorize?${query}`, { headers: sid ? { cookie: `sid=${sid}` } : {}, redirect: "manual" });

const answer = (base, fields, { sid = "dana", origin = HOST } = {}) => {
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  if (sid) headers.cookie = `sid=${sid}`;
  if (origin) headers.origin = origin;
  return fetch(`${base}/oauth/authorize`, { method: "POST", headers, body: new URLSearchParams(fields), redirect: "manual" });
};

/** Register, then show the consent screen; returns the client and the view the screen got. */
async function consentFor(app, query = {}) {
  const { client_id } = (await register(app.base, { redirect_uris: [CHATGPT_REDIRECT, PER_CONNECTION], client_name: "ChatGPT" })).body;
  const res = await showConsent(app.base, authorizeQuery(client_id, query));
  assert.equal(res.status, 200);
  return { clientId: client_id, view: app.views.at(-1), res };
}

function location(res) {
  const url = new URL(res.headers.get("location"));
  return { at: `${url.origin}${url.pathname}`, params: Object.fromEntries(url.searchParams) };
}

test("the whole connection: register, consent, allow, code, token, /mcp", async () => {
  const app = await start();
  try {
    const { clientId, view, res } = await consentFor(app);
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("content-security-policy"), CSP("https://chatgpt.com"));
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(view.ownerEmail, "owner@example.test");
    assert.deepEqual(view.request, { clientId, clientName: "ChatGPT", redirectUri: CHATGPT_REDIRECT, codeChallenge: CHALLENGE, state: "st_1", scope: "jobs.act" });
    assert.equal(app.store.pending.has(hashToken(view.requestId)), true, "stored by hash");
    assert.equal(app.store.pending.has(view.requestId), false);

    const allowed = await answer(app.base, { request_id: view.requestId, decision: "allow" });
    assert.equal(allowed.status, 302);
    const { at, params } = location(allowed);
    assert.equal(at, CHATGPT_REDIRECT);
    assert.equal(params.state, "st_1");
    assert.equal(params.iss, HOST);
    assert.deepEqual(app.connections, [{ ownerId: "own_1", clientId, clientLabel: "ChatGPT" }]);
    const stored = app.store.codes.get(hashToken(params.code));
    assert.equal(stored.expires_at, NOW + 60);
    assert.equal(stored.resource, RESOURCE);

    const issued = await token(app.base, codeParams(clientId, params.code));
    assert.equal(issued.status, 200);
    assert.equal((await rpc(app.base, issued.body.access_token, "tools/list")).status, 200);
  } finally {
    await app.close();
  }
});

test("the per-connection callback is used exactly as the request named it", async () => {
  const app = await start();
  try {
    const { view } = await consentFor(app, { redirect_uri: PER_CONNECTION });
    assert.equal(view.request.redirectUri, PER_CONNECTION);
    assert.equal(location(await answer(app.base, { request_id: view.requestId, decision: "allow" })).at, PER_CONNECTION);
  } finally {
    await app.close();
  }
});

test("no owner session: off to sign-in with a relative return path, and nothing is pending", async () => {
  const app = await start();
  try {
    const { client_id } = (await register(app.base)).body;
    const query = authorizeQuery(client_id);
    const res = await showConsent(app.base, query, null);
    assert.equal(res.status, 302);
    const target = new URL(res.headers.get("location"), "http://x");
    assert.equal(target.pathname, "/signin");
    assert.equal(target.searchParams.get("return_to"), `/oauth/authorize?${query}`);
    assert.equal(app.store.pending.size, 0);
    assert.equal(app.views.length, 0);
  } finally {
    await app.close();
  }
});

test("an unknown client, an unregistered redirect or a repeated parameter is shown, never redirected", async () => {
  const app = await start();
  try {
    const { client_id } = (await register(app.base)).body;
    for (const query of [
      authorizeQuery("no-such-client"),
      authorizeQuery(client_id, { redirect_uri: "https://evil.test/cb" }),
      authorizeQuery(client_id, { redirect_uri: PER_CONNECTION }),
      // The registered value last, so a parser that keeps the last value would find nothing wrong.
      new URLSearchParams(`redirect_uri=${encodeURIComponent("https://evil.test/cb")}&${authorizeQuery(client_id)}`),
    ]) {
      const res = await showConsent(app.base, query);
      assert.equal(res.status, 400, `${query}`);
      assert.equal(res.headers.get("location"), null);
      assert.match(res.headers.get("content-type"), /^text\/plain/);
    }
    assert.equal(app.store.pending.size, 0);
  } finally {
    await app.close();
  }
});

test("other bad requests go back to the known-good redirect with the error, state and iss", async () => {
  const app = await start();
  try {
    const { client_id } = (await register(app.base)).body;
    const cases = [
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ scope: "jobs.act admin" }, "invalid_scope"],
      [{ resource: "https://other.test/mcp" }, "invalid_target"],
      [{ response_type: "token" }, "unsupported_response_type"],
    ];
    for (const [override, error] of cases) {
      const res = await showConsent(app.base, authorizeQuery(client_id, override));
      assert.equal(res.status, 302, error);
      const { at, params } = location(res);
      assert.equal(at, CHATGPT_REDIRECT);
      assert.deepEqual(params, { error, state: "st_1", iss: HOST });
    }
    assert.equal(app.store.pending.size, 0);
  } finally {
    await app.close();
  }
});

test("deny: access_denied with state and iss; no connection and no code", async () => {
  const app = await start();
  try {
    const { view } = await consentFor(app);
    const denied = await answer(app.base, { request_id: view.requestId, decision: "deny" });
    assert.equal(denied.status, 302);
    assert.deepEqual(location(denied).params, { error: "access_denied", state: "st_1", iss: HOST });
    assert.equal(app.connections.length, 0);
    assert.equal(app.store.codes.size, 0);
  } finally {
    await app.close();
  }
});

test("an answer is used once: a second allow mints nothing", async () => {
  const app = await start();
  try {
    const { view } = await consentFor(app);
    const [first, second] = await Promise.all([
      answer(app.base, { request_id: view.requestId, decision: "allow" }),
      answer(app.base, { request_id: view.requestId, decision: "allow" }),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [302, 400]);
    assert.equal(app.store.codes.size, 1);
    assert.equal(app.connections.length, 1);
  } finally {
    await app.close();
  }
});

test("another account cannot answer the owner's request, and it burns", async () => {
  const app = await start();
  try {
    const { view } = await consentFor(app);
    const res = await answer(app.base, { request_id: view.requestId, decision: "allow" }, { sid: "eve" });
    assert.equal(res.status, 403);
    assert.equal(app.store.codes.size, 0);
    assert.equal((await answer(app.base, { request_id: view.requestId, decision: "allow" })).status, 400, "taken, so the owner starts again");
  } finally {
    await app.close();
  }
});

test("a cross-origin answer, a bad decision or no session is refused before the request is taken", async () => {
  const app = await start();
  try {
    const { view } = await consentFor(app);
    const crossOrigin = await answer(app.base, { request_id: view.requestId, decision: "allow" }, { origin: "https://evil.test" });
    assert.equal(crossOrigin.status, 403);
    const nullOrigin = await answer(app.base, { request_id: view.requestId, decision: "allow" }, { origin: "null" });
    assert.equal(nullOrigin.status, 403);
    assert.equal((await answer(app.base, { request_id: view.requestId, decision: "yes" })).status, 400);
    assert.equal((await answer(app.base, { request_id: view.requestId, decision: "allow" }, { sid: null })).status, 401);
    const repeated = await fetch(`${app.base}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: "sid=dana", origin: HOST },
      body: `request_id=${view.requestId}&decision=deny&decision=allow`,
      redirect: "manual",
    });
    assert.equal(repeated.status, 400);
    assert.equal(app.store.codes.size, 0);
    assert.equal(app.store.pending.size, 1, "still pending");
    const allowed = await answer(app.base, { request_id: view.requestId, decision: "allow" }, { origin: null });
    assert.equal(allowed.status, 302, "a same-site answer without an Origin header still works");
  } finally {
    await app.close();
  }
});

test("the answer trusts only request_id and decision, never posted request fields", async () => {
  const app = await start();
  try {
    const { view } = await consentFor(app);
    const res = await answer(app.base, {
      request_id: view.requestId,
      decision: "allow",
      redirect_uri: "https://evil.test/cb",
      client_id: "other",
      code_challenge: "x".repeat(43),
      scope: "admin",
      state: "forged",
    });
    const { at, params } = location(res);
    assert.equal(at, CHATGPT_REDIRECT);
    assert.equal(params.state, "st_1");
    const stored = app.store.codes.get(hashToken(params.code));
    assert.equal(stored.code_challenge, CHALLENGE);
    assert.equal(stored.scope, "jobs.act");
    assert.equal(stored.client_id, view.request.clientId);
  } finally {
    await app.close();
  }
});

test("a consent screen left open past ten minutes cannot be answered", async () => {
  const app = await start();
  try {
    const { view } = await consentFor(app);
    app.clock.now = NOW + 600;
    assert.equal((await answer(app.base, { request_id: view.requestId, decision: "allow" })).status, 400);
    assert.equal(app.store.codes.size, 0);
  } finally {
    await app.close();
  }
});

test("CORS: the token-based endpoints allow any origin without credentials; /oauth/authorize never does", async () => {
  const app = await start();
  try {
    const preflight = (path, method = "POST") =>
      fetch(`${app.base}${path}`, { method: "OPTIONS", headers: { origin: "http://localhost:6274", "access-control-request-method": method } });
    for (const path of ["/oauth/token", "/oauth/register", "/mcp", "/.well-known/oauth-authorization-server", "/.well-known/oauth-protected-resource/mcp"]) {
      const res = await preflight(path);
      assert.equal(res.status, 204, path);
      assert.equal(res.headers.get("access-control-allow-origin"), "*", path);
      assert.match(res.headers.get("access-control-allow-headers"), /authorization/);
      assert.match(res.headers.get("access-control-allow-headers"), /mcp-protocol-version/);
      assert.equal(res.headers.get("access-control-allow-credentials"), null, path);
    }
    const metadata = await fetch(`${app.base}/.well-known/oauth-protected-resource`);
    assert.equal(metadata.headers.get("access-control-allow-origin"), "*");
    const challenge = await rpc(app.base, null, "tools/list");
    assert.equal(challenge.status, 401);
    const unauthorized = await fetch(`${app.base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(unauthorized.headers.get("access-control-allow-origin"), "*");
    assert.equal(unauthorized.headers.get("access-control-expose-headers"), "www-authenticate", "a browser client can read the challenge");

    const { access_token } = await connect(app.base, app.store);
    const listed = await fetch(`${app.base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(listed.status, 200);
    assert.equal(listed.headers.get("access-control-allow-origin"), "*", "kept through the SDK transport");

    const { res } = await consentFor(app);
    assert.equal(res.headers.get("access-control-allow-origin"), null, "the consent page");
    const authorizePreflight = await preflight("/oauth/authorize");
    assert.equal(authorizePreflight.headers.get("access-control-allow-origin"), null);
    assert.notEqual(authorizePreflight.status, 204);
  } finally {
    await app.close();
  }
});

test("the consent page's form-action names the origin the answer redirects to, for each kind of redirect", async () => {
  const fallback = "http://localhost:6274/oauth/callback";
  const app = await start({ redirectFallbacks: [fallback] });
  try {
    const { client_id } = (await register(app.base, { redirect_uris: [PER_CONNECTION, fallback], client_name: "Inspector" })).body;
    const perConnection = await showConsent(app.base, authorizeQuery(client_id, { redirect_uri: PER_CONNECTION }));
    assert.equal(perConnection.headers.get("content-security-policy"), CSP("https://chatgpt.com"));
    const local = await showConsent(app.base, authorizeQuery(client_id, { redirect_uri: fallback }));
    assert.equal(local.headers.get("content-security-policy"), CSP("http://localhost:6274"));
  } finally {
    await app.close();
  }
});

test("two concurrent allows of one request mint exactly one code", async () => {
  const app = await start();
  try {
    const { view } = await consentFor(app);
    // Both answers pass the session check before either takes the request, so only the take decides.
    barrier(app.authorize.owners, "owner", 2);
    const results = await Promise.all([
      answer(app.base, { request_id: view.requestId, decision: "allow" }),
      answer(app.base, { request_id: view.requestId, decision: "allow" }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [302, 400]);
    assert.equal(app.store.codes.size, 1);
    assert.equal(app.connections.length, 1);
  } finally {
    await app.close();
  }
});

test("the sign-in return path is built from the route, never from the raw request target", async () => {
  const app = await start();
  try {
    const { client_id } = (await register(app.base)).body;
    const query = authorizeQuery(client_id);
    const { port } = new URL(app.base);
    // A request target that starts with "//" still routes to /oauth/authorize; it must not become a protocol-relative return path.
    const location = await new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, method: "GET", path: `//elsewhere.example/oauth/authorize?${query}` }, (res) => {
        res.resume();
        resolve(res.headers.location);
      });
      req.on("error", reject);
      req.end();
    });
    const target = new URL(location, "http://x");
    assert.equal(target.searchParams.get("return_to"), `/oauth/authorize?${query}`);
  } finally {
    await app.close();
  }
});

test("an answer that is not form-encoded is refused, even when its body would parse, and the request stays pending", async () => {
  const app = await start();
  try {
    const { view } = await consentFor(app);
    for (const contentType of ["text/plain", "application/json", "multipart/form-data; boundary=x"]) {
      const res = await fetch(`${app.base}/oauth/authorize`, {
        method: "POST",
        headers: { "content-type": contentType, cookie: "sid=dana", origin: HOST },
        body: new URLSearchParams({ request_id: view.requestId, decision: "allow" }).toString(),
        redirect: "manual",
      });
      assert.equal(res.status, 400, contentType);
    }
    assert.equal(app.store.codes.size, 0);
    assert.equal(app.store.pending.size, 1);
  } finally {
    await app.close();
  }
});
