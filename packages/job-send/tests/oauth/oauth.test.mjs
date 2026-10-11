import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  ACCESS_TOKEN_TTL_SECONDS,
  CHATGPT_REDIRECT,
  GROK_REDIRECT,
  assertOrigin,
  authorizationRedirect,
  checkAccessToken,
  checkAuthorizeRequest,
  checkRegistration,
  checkTokenRequest,
  generateOpaqueToken,
  hashToken,
  isAllowedRedirectUri,
  oauthMetadata,
  unauthorizedChallenge,
  verifyPkceS256,
} from "../../dist/oauth/oauth.js";

const HOST = "https://jobs.example.test";
const RESOURCE = `${HOST}/mcp`;
// RFC 7636 Appendix B.
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const NOW = 1_800_000_000;

test("metadata: the issuer equals the authorization server entry, S256 only, one scope, no OIDC", () => {
  const { protectedResource, authorizationServer } = oauthMetadata(HOST);
  assert.equal(protectedResource.resource, RESOURCE);
  assert.deepEqual(protectedResource.authorization_servers, [HOST]);
  assert.equal(authorizationServer.issuer, protectedResource.authorization_servers[0]);
  assert.deepEqual(authorizationServer.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(authorizationServer.token_endpoint_auth_methods_supported, ["none"]);
  assert.deepEqual(authorizationServer.scopes_supported, ["jobs.act"]);
  assert.equal(authorizationServer.authorization_response_iss_parameter_supported, true);
  assert.doesNotMatch(JSON.stringify({ protectedResource, authorizationServer }), /openid|email|profile/);
  assert.equal(unauthorizedChallenge(HOST), `Bearer resource_metadata="${HOST}/.well-known/oauth-protected-resource"`);
});

test("the origin must be a bare https origin", () => {
  for (const bad of ["http://jobs.example.test", "https://jobs.example.test/", "https://jobs.example.test/x", "https://u@jobs.example.test", "https://JOBS.example.test", ""]) {
    assert.throws(() => assertOrigin(bad), TypeError, bad);
  }
  assert.equal(assertOrigin("https://localhost:8443"), "https://localhost:8443");
});

test("PKCE S256: the RFC 7636 vector passes; plain, short, padded or wrong verifiers fail", () => {
  assert.equal(verifyPkceS256(VERIFIER, CHALLENGE), true);
  assert.equal(verifyPkceS256(VERIFIER.replace("d", "e"), CHALLENGE), false);
  assert.equal(verifyPkceS256(CHALLENGE, CHALLENGE), false, "the plain method is not accepted");
  assert.equal(verifyPkceS256("short", createHash("sha256").update("short").digest("base64url")), false, "verifier under 43 characters");
  assert.equal(verifyPkceS256(VERIFIER, `${CHALLENGE}=`), false, "a padded challenge");
  assert.equal(verifyPkceS256(undefined, CHALLENGE), false);
});

test("redirect URIs: ChatGPT's callbacks and configured fallbacks, by exact string only", () => {
  assert.equal(isAllowedRedirectUri(CHATGPT_REDIRECT), true);
  assert.equal(isAllowedRedirectUri("https://chatgpt.com/connector/oauth/cb_123-abc"), true);
  assert.equal(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback", ["https://claude.ai/api/mcp/auth_callback"]), true);
  for (const bad of [
    "https://chatgpt.com.evil.test/connector_platform_oauth_redirect",
    `${CHATGPT_REDIRECT}?next=https://evil.test`,
    `${CHATGPT_REDIRECT}#x`,
    "https://user@chatgpt.com/connector_platform_oauth_redirect",
    "HTTPS://chatgpt.com/connector_platform_oauth_redirect",
    "http://chatgpt.com/connector_platform_oauth_redirect",
    "https://chatgpt.com/connector/oauth/../../evil",
    "https://chatgpt.com/connector/oauth/a/b",
    "https://chatgpt.com:8443/connector_platform_oauth_redirect",
    "https://claude.ai/api/mcp/auth_callback",
  ]) {
    assert.equal(isAllowedRedirectUri(bad), false, bad);
  }
});

test("redirect URIs: Grok's grok.com connector callback, exactly, and no lookalike", () => {
  assert.equal(GROK_REDIRECT, "https://grok.com/connectors-oauth-exchange-code/");
  assert.equal(isAllowedRedirectUri(GROK_REDIRECT), true);
  assert.equal(checkRegistration({ redirect_uris: [GROK_REDIRECT], client_name: "Grok" }).ok, true);
  for (const bad of [
    "https://grok.com/connectors-oauth-exchange-code",
    "https://grok.com/connectors-oauth-exchange-code/x",
    `${GROK_REDIRECT}?next=https://evil.test`,
    `${GROK_REDIRECT}#x`,
    "https://grok.com.evil.test/connectors-oauth-exchange-code/",
    "https://evil.grok.com/connectors-oauth-exchange-code/",
    "https://user@grok.com/connectors-oauth-exchange-code/",
    "http://grok.com/connectors-oauth-exchange-code/",
    "HTTPS://grok.com/connectors-oauth-exchange-code/",
    "https://grok.com:8443/connectors-oauth-exchange-code/",
    "https://grok.com/connectors/oauth/callback",
  ]) {
    assert.equal(isAllowedRedirectUri(bad), false, bad);
  }
});

test("registration: public clients, the code flow and allowed redirects only", () => {
  assert.equal(checkRegistration({ redirect_uris: [CHATGPT_REDIRECT], client_name: "ChatGPT" }).ok, true);
  assert.equal(checkRegistration({ redirect_uris: ["https://evil.test/cb"] }).error, "invalid_redirect_uri");
  assert.equal(checkRegistration({ redirect_uris: [] }).error, "invalid_redirect_uri");
  assert.equal(checkRegistration({ redirect_uris: [CHATGPT_REDIRECT], token_endpoint_auth_method: "client_secret_basic" }).error, "invalid_client_metadata");
  assert.equal(checkRegistration({ redirect_uris: [CHATGPT_REDIRECT], grant_types: ["implicit"] }).error, "invalid_client_metadata");
  assert.equal(checkRegistration({ redirect_uris: [CHATGPT_REDIRECT], response_types: ["token"] }).error, "invalid_client_metadata");
});

test("registration: the declared client_name holds no invisible character, and is cut by code point", () => {
  const register = (client_name) => checkRegistration({ redirect_uris: [CHATGPT_REDIRECT], client_name });
  // A right-to-left override would visually reorder the consent screen's "(declared)".
  for (const cp of [0x202e, 0x2066, 0x200b, 0x200f, 0xfeff, 0xad, 0x0, 0x9, 0xa, 0x7f, 0x2028, 0xe000, 0xd800, 0x378]) {
    const result = register(`Chat${String.fromCodePoint(cp)}GPT`);
    assert.equal(result.error, "invalid_client_metadata", `U+${cp.toString(16)}`);
  }
  assert.equal(register("ChatGPT").client_name, "ChatGPT");
  assert.equal(register(`Caf${String.fromCodePoint(0xe9)} ${String.fromCodePoint(0x6771, 0x4eac)}`).ok, true, "accented and CJK letters pass");
  assert.equal(register("   ").client_name, "unnamed client");
  assert.equal(register(undefined).client_name, "unnamed client");
  assert.equal(register(`${" ".repeat(100)}ChatGPT`).client_name, "unnamed client", "blank after the cut is blank");
  const emoji = String.fromCodePoint(0x1f600);
  const cut = register(`${"a".repeat(99)}${emoji}tail`).client_name;
  assert.equal(cut, `${"a".repeat(99)}${emoji}`, "100 code points, the pair kept whole");
  assert.equal(/[\p{Cs}]/u.test(cut), false);
});

const CLIENT = { client_id: "cli_1", redirect_uris: [CHATGPT_REDIRECT] };
const AUTHZ = {
  response_type: "code", client_id: "cli_1", redirect_uri: CHATGPT_REDIRECT, code_challenge: CHALLENGE,
  code_challenge_method: "S256", scope: "jobs.act", resource: RESOURCE, state: "st_1",
};

test("authorize: a good request passes; each bad parameter is refused with its OAuth error", () => {
  const ok = checkAuthorizeRequest(AUTHZ, CLIENT, HOST);
  assert.equal(ok.ok, true);
  assert.equal(checkAuthorizeRequest({ ...AUTHZ, scope: undefined }, CLIENT, HOST).scope, "jobs.act", "scope defaults to jobs.act");
  const cases = [
    [{ client_id: "cli_2" }, "invalid_client"],
    [{ redirect_uri: "https://chatgpt.com/connector/oauth/other" }, "invalid_redirect_uri"],
    [{ response_type: "token" }, "unsupported_response_type"],
    [{ code_challenge_method: "plain" }, "invalid_request"],
    [{ code_challenge: "short" }, "invalid_request"],
    [{ scope: "openid jobs.act" }, "invalid_scope"],
    [{ resource: "https://evil.test/mcp" }, "invalid_target"],
    [{ resource: undefined }, "invalid_target"],
  ];
  for (const [patch, error] of cases) assert.equal(checkAuthorizeRequest({ ...AUTHZ, ...patch }, CLIENT, HOST).error, error, JSON.stringify(patch));
  assert.equal(checkAuthorizeRequest(AUTHZ, null, HOST).error, "invalid_client");
});

test("the authorization redirect always carries iss, and echoes state", () => {
  const ok = new URL(authorizationRedirect(CHATGPT_REDIRECT, HOST, { code: "c1", state: "st_1" }));
  assert.deepEqual([ok.searchParams.get("code"), ok.searchParams.get("state"), ok.searchParams.get("iss")], ["c1", "st_1", HOST]);
  const err = new URL(authorizationRedirect(CHATGPT_REDIRECT, HOST, { error: "invalid_scope", state: null }));
  assert.deepEqual([err.searchParams.get("error"), err.searchParams.get("state"), err.searchParams.get("iss")], ["invalid_scope", null, HOST]);
});

const CODE = {
  client_id: "cli_1", redirect_uri: CHATGPT_REDIRECT, code_challenge: CHALLENGE, resource: RESOURCE,
  scope: "jobs.act", agent_connection_id: "ac_1", expires_at: NOW + 60, used_at: null,
};
const CODE_PARAMS = { grant_type: "authorization_code", code: "c1", client_id: "cli_1", redirect_uri: CHATGPT_REDIRECT, code_verifier: VERIFIER, resource: RESOURCE };
const tokenFor = (params, code = CODE, refresh = null) => checkTokenRequest(params, { code, refresh }, HOST, NOW);

test("token, authorization_code: a good exchange issues one-hour access for the code's agent connection", () => {
  const grant = tokenFor(CODE_PARAMS);
  assert.equal(grant.ok, true);
  assert.equal(grant.agent_connection_id, "ac_1");
  assert.equal(grant.access_expires_at, NOW + ACCESS_TOKEN_TTL_SECONDS);
  assert.equal(grant.consume, "code");
});

test("token, authorization_code: every mismatch is refused", () => {
  const cases = [
    [{}, { used_at: NOW - 1 }, "invalid_grant"],
    [{}, { expires_at: NOW }, "invalid_grant"],
    [{ client_id: "cli_2" }, {}, "invalid_grant"],
    [{ redirect_uri: "https://chatgpt.com/connector/oauth/other" }, {}, "invalid_grant"],
    [{ code_verifier: VERIFIER.replace("d", "e") }, {}, "invalid_grant"],
    [{ code_verifier: undefined }, {}, "invalid_grant"],
    [{ resource: "https://evil.test/mcp" }, {}, "invalid_target"],
    [{}, { resource: "https://evil.test/mcp" }, "invalid_target"],
  ];
  for (const [paramsPatch, codePatch, error] of cases) {
    const result = tokenFor({ ...CODE_PARAMS, ...paramsPatch }, { ...CODE, ...codePatch });
    assert.equal(result.error, error, JSON.stringify([paramsPatch, codePatch]));
  }
  assert.equal(tokenFor(CODE_PARAMS, null).error, "invalid_grant", "unknown code");
});

const REFRESH = { client_id: "cli_1", agent_connection_id: "ac_1", resource: RESOURCE, scope: "jobs.act", expires_at: NOW + 1000, rotated_at: null, revoked_at: null };
const REFRESH_PARAMS = { grant_type: "refresh_token", refresh_token: "r1", client_id: "cli_1" };

test("token, refresh_token: a good refresh rotates; a rotated token presented again revokes the grant", () => {
  const grant = tokenFor(REFRESH_PARAMS, null, REFRESH);
  assert.deepEqual([grant.ok, grant.consume, grant.agent_connection_id], [true, "refresh", "ac_1"]);
  const replay = tokenFor(REFRESH_PARAMS, null, { ...REFRESH, rotated_at: NOW - 5 });
  assert.deepEqual([replay.ok, replay.error, replay.revokeAgentConnection], [false, "invalid_grant", "ac_1"]);
  assert.equal(tokenFor(REFRESH_PARAMS, null, { ...REFRESH, revoked_at: NOW - 5 }).error, "invalid_grant");
  assert.equal(tokenFor(REFRESH_PARAMS, null, { ...REFRESH, expires_at: NOW }).error, "invalid_grant");
  assert.equal(tokenFor({ ...REFRESH_PARAMS, client_id: "cli_2" }, null, REFRESH).error, "invalid_grant");
  assert.equal(tokenFor(REFRESH_PARAMS, null, null).error, "invalid_grant");
});

test("token: any other grant type is unsupported", () => {
  for (const grant_type of ["client_credentials", "password", "implicit", undefined]) {
    assert.equal(tokenFor({ ...CODE_PARAMS, grant_type }).error, "unsupported_grant_type", String(grant_type));
  }
});

test("access tokens at /mcp: only an unexpired, unrevoked token for our resource and scope passes", () => {
  const good = { agent_connection_id: "ac_1", resource: RESOURCE, scope: "jobs.act", expires_at: NOW + 10, revoked_at: null };
  assert.deepEqual(checkAccessToken(good, HOST, NOW), { ok: true, agent_connection_id: "ac_1" });
  for (const patch of [{ revoked_at: NOW - 1 }, { expires_at: NOW }, { resource: "https://evil.test/mcp" }, { scope: "other" }]) {
    assert.equal(checkAccessToken({ ...good, ...patch }, HOST, NOW).ok, false, JSON.stringify(patch));
  }
  assert.equal(checkAccessToken(null, HOST, NOW).ok, false);
});

test("opaque tokens are 32 random bytes in base64url, and the database keeps only their sha256", () => {
  const a = generateOpaqueToken();
  const b = generateOpaqueToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  assert.match(hashToken(a), /^[0-9a-f]{64}$/);
  assert.equal(hashToken(a), hashToken(a));
  assert.notEqual(hashToken(a), a);
});

test("token grants are consumed by a compare-and-set that only one concurrent request can win", async () => {
  const { TOKEN_CONSUME_SQL } = await import("../../dist/oauth/oauth.js");
  assert.match(TOKEN_CONSUME_SQL.code, /^UPDATE oauth_codes SET used_at = now\(\) WHERE code_hash = \$1 AND used_at IS NULL$/);
  assert.match(TOKEN_CONSUME_SQL.refresh, /WHERE token_hash = \$1 AND rotated_at IS NULL AND revoked_at IS NULL$/);
});
