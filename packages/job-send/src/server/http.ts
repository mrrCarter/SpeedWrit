// The agent connection over HTTP (spec: "Agent connection: MCP tools and OAuth"), on node:http:
// the OAuth metadata, dynamic client registration, /oauth/authorize with the owner's consent
// screen, the token endpoint, and /mcp behind a bearer token. The decisions are the pure
// functions in ../oauth and ../mcp; this file reads requests, calls them, and writes what they
// decide.

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";

import type { AgentConnection, JobListing, ProposeSendCall, ReviseCall, SendResult, StatusResult } from "../contract/types.js";
import { argumentProblem } from "../mcp/arguments.js";
import { listJobsToolResult, sendToolResult, statusToolResult, type McpToolResult } from "../mcp/results.js";
import { MCP_INSTRUCTIONS, MCP_TOOLS } from "../mcp/tools.js";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  AUTHORIZATION_CODE_TTL_SECONDS,
  assertOrigin,
  authorizationRedirect,
  checkAccessToken,
  checkAuthorizeRequest,
  checkRegistration,
  checkTokenRequest,
  generateOpaqueToken,
  hashToken,
  oauthMetadata,
  unauthorizedChallenge,
} from "../oauth/oauth.js";
import { SECRET_PATH } from "./secret-path.js";
import type { OAuthStore } from "./store.js";

/** The signed-in owner (spec: the owner session cookie, from Google sign-in with openid email). */
export type Owner = { id: string; email: string };

export interface OwnerSessions {
  /** The owner the request's session cookie names, or null. */
  owner(req: IncomingMessage): Promise<Owner | null>;
  /**
   * Where to send a visitor with no session. `returnTo` is always a relative path that begins
   * "/oauth/authorize?". Sign-in must return only to a relative path, never to an absolute URL.
   */
  signInUrl(returnTo: string): string;
}

/** What the consent screen shows: the job-send-ui ConsentRequest fields, plus the form's request id. */
export type ConsentView = {
  /** Posted back as request_id. One-time, bound to this owner, and the only thing the answer is trusted for. */
  requestId: string;
  request: { clientId: string; clientName: string; redirectUri: string; codeChallenge: string; state: string | null; scope: string };
  ownerEmail: string;
};

export type AuthorizeOptions = {
  owners: OwnerSessions;
  /** Creates the agent_connection for one grant and returns its id. `clientLabel` is the client's declared name. */
  createAgentConnection(ownerId: string, clientId: string, clientLabel: string): Promise<string>;
  /** The consent page's HTML. Its form posts request_id and decision ("allow" or "deny") to POST /oauth/authorize. */
  renderConsent(view: ConsentView): string;
};

/** A propose_send or revise_proposal outcome, with what the result sentence names. */
export type SendOutcome = { result: SendResult; recipient: string; maxSends: number };

/** What /mcp calls once a token is good. Every method is scoped to the connection it is given. */
export interface McpBackend {
  /** The connection a token names, or null when it is stopped or revoked (answered as 401). */
  connection(agentConnectionId: string): Promise<AgentConnection | null>;
  listJobs(conn: AgentConnection): Promise<JobListing[]>;
  proposeSend(call: ProposeSendCall, conn: AgentConnection): Promise<SendOutcome>;
  revise(call: ReviseCall, conn: AgentConnection): Promise<SendOutcome>;
  /** Null when the proposal does not exist or belongs to another connection. */
  getStatus(proposalId: string, conn: AgentConnection): Promise<StatusResult | null>;
}

export type JobSendHttpOptions = {
  /** The public https origin, such as https://jobs.example.com. */
  host: string;
  store: OAuthStore;
  backend: McpBackend;
  authorize: AuthorizeOptions;
  /** Redirect URIs allowed besides ChatGPT's (isAllowedRedirectUri). */
  redirectFallbacks?: readonly string[];
  /**
   * The secret-path fallback (spec: "10:30 with no OAuth link from ChatGPT"). When set,
   * /mcp/c/<43-character secret> serves MCP with no bearer token, for the agent connection the
   * secret names. Off unless set. The secret sits in the connector's configuration, so an access log
   * in front of this server must never record that path.
   */
  secretPaths?: { connectionFor(secretHash: string): Promise<string | null> };
  /** Seconds since the epoch. */
  now?: () => number;
  /** Told about a failure the caller only sees as a 500 or an internal-error result. */
  onError?: (error: unknown) => void;
};

const OAUTH_BODY_LIMIT = 16 * 1024;
const MCP_BODY_LIMIT = 1024 * 1024;
/** How long the owner has to answer the consent screen. */
const PENDING_TTL_SECONDS = 600;

// Browser clients such as MCP Inspector call these from another origin. They carry no cookie
// and no ambient authority (a bearer token or nothing), so any origin may call them, without
// credentials. /oauth/authorize runs on the owner's session cookie and is never on this list.
const CORS_PATHS = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/mcp",
  "/.well-known/oauth-authorization-server",
  "/oauth/register",
  "/oauth/token",
  "/mcp",
]);
const CORS_PREFLIGHT = {
  "access-control-allow-methods": "GET, POST",
  "access-control-allow-headers": "authorization, content-type, accept, mcp-protocol-version",
  "access-control-max-age": "600",
};

/** The tools as tools/list sends them: securitySchemes top level, and again in _meta for clients that read it there. */
const LISTED_TOOLS = MCP_TOOLS.map((tool) => ({ ...tool, _meta: { securitySchemes: tool.securitySchemes } }));

const INTERNAL_ERROR_RESULT: McpToolResult = {
  isError: true,
  content: [{ type: "text", text: "This call failed on our side, and its outcome is not known. Do not resend. Check list_jobs or get_status first." }],
  structuredContent: { error: "internal_error" },
};

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" };

/** A page for the owner's browser: plain text, so nothing in it can become markup. */
function page(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", ...NO_STORE });
  res.end(text);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, "referrer-policy": "no-referrer", ...NO_STORE });
  res.end();
}

/** Every parameter once, or null when any appears twice (RFC 6749 sections 3.1 and 3.2). */
function singleParams(params: URLSearchParams): Record<string, string> | null {
  const single: Record<string, string> = {};
  for (const key of params.keys()) {
    if (params.getAll(key).length > 1) return null;
    single[key] = params.get(key)!;
  }
  return single;
}

function oauthError(res: ServerResponse, status: number, error: string, description: string, headers: Record<string, string> = {}): void {
  send(res, status, { error, error_description: description }, headers);
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > limit) throw new HttpError(413);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The media type without parameters, lowercased. */
function mediaType(req: IncomingMessage): string {
  return (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
}

/** The request handler. Use it with node:http, or through createJobSendServer. */
export function createJobSendHandler(options: JobSendHttpOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const host = assertOrigin(options.host);
  const metadata = oauthMetadata(host);
  const challenge = unauthorizedChallenge(host);
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const { store, backend, authorize } = options;

  async function register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (mediaType(req) !== "application/json") return oauthError(res, 400, "invalid_client_metadata", "send application/json");
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req, OAUTH_BODY_LIMIT));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      return oauthError(res, 400, "invalid_client_metadata", "the body is not JSON");
    }
    const checked = checkRegistration(body, options.redirectFallbacks ?? []);
    if (!checked.ok) return oauthError(res, 400, checked.error, checked.description);
    const issuedAt = now();
    const client = { client_id: randomUUID(), redirect_uris: checked.redirect_uris, client_name: checked.client_name, created_at: issuedAt };
    await store.saveClient(client);
    send(res, 201, {
      client_id: client.client_id,
      client_id_issued_at: issuedAt,
      client_name: client.client_name,
      redirect_uris: client.redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  }

  async function showConsent(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const query = singleParams(url.searchParams);
    if (!query) return page(res, 400, "This connection request repeats a parameter. Start again from your agent.");
    const client = query.client_id === undefined ? null : await store.getClient(query.client_id);
    const checked = checkAuthorizeRequest(query, client, host);
    if (!checked.ok) {
      // Until the client and its redirect URI are known good, an error is shown here, never redirected.
      const redirectKnownGood = client !== null && query.redirect_uri !== undefined && client.redirect_uris.includes(query.redirect_uri);
      if (!redirectKnownGood) return page(res, 400, `This connection request is not valid: ${checked.description}.`);
      const state = query.state !== undefined && query.state.length <= 512 ? query.state : null;
      return redirect(res, authorizationRedirect(query.redirect_uri!, host, { error: checked.error, state }));
    }
    const owner = await authorize.owners.owner(req);
    if (!owner) return redirect(res, authorize.owners.signInUrl(`/oauth/authorize${url.search}`));
    const clientName = client?.client_name ?? "unnamed client";
    const requestId = generateOpaqueToken();
    await store.savePending(hashToken(requestId), {
      owner_id: owner.id,
      client_id: checked.client_id,
      client_name: clientName,
      redirect_uri: checked.redirect_uri,
      code_challenge: checked.code_challenge,
      scope: checked.scope,
      resource: checked.resource,
      state: checked.state,
      expires_at: now() + PENDING_TTL_SECONDS,
    });
    const html = authorize.renderConsent({
      requestId,
      ownerEmail: owner.email,
      request: {
        clientId: checked.client_id,
        clientName,
        redirectUri: checked.redirect_uri,
        codeChallenge: checked.code_challenge,
        state: checked.state,
        scope: checked.scope,
      },
    });
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      // form-action names the redirect's origin: browsers apply it to the redirect after the POST too, so 'self'
      // alone would stop Allow and Deny before they reach the client (machine measured it in Chrome, #515).
      "content-security-policy": `default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' ${new URL(checked.redirect_uri).origin}`,
      "x-frame-options": "DENY",
      "referrer-policy": "no-referrer",
      ...NO_STORE,
    });
    res.end(html);
  }

  async function answerConsent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== host) return page(res, 403, "This answer did not come from the WRIT consent page.");
    if (mediaType(req) !== "application/x-www-form-urlencoded") return page(res, 400, "This answer is not valid. Start again from your agent.");
    const form = singleParams(new URLSearchParams(await readBody(req, OAUTH_BODY_LIMIT)));
    if (!form || form.request_id === undefined || (form.decision !== "allow" && form.decision !== "deny")) {
      return page(res, 400, "This answer is not valid. Start again from your agent.");
    }
    const owner = await authorize.owners.owner(req);
    if (!owner) return page(res, 401, "Your session ended. Sign in, then start again from your agent.");
    // Taken before anything else is decided, so a double submit can never mint two codes.
    const pending = await store.takePending(hashToken(form.request_id));
    if (!pending || now() >= pending.expires_at) return page(res, 400, "This request expired or was already answered. Start again from your agent.");
    if (pending.owner_id !== owner.id) return page(res, 403, "This request belongs to another account.");
    if (form.decision === "deny") {
      return redirect(res, authorizationRedirect(pending.redirect_uri, host, { error: "access_denied", state: pending.state }));
    }
    const agentConnectionId = await authorize.createAgentConnection(owner.id, pending.client_id, pending.client_name);
    const code = generateOpaqueToken();
    await store.saveCode(hashToken(code), {
      client_id: pending.client_id,
      redirect_uri: pending.redirect_uri,
      code_challenge: pending.code_challenge,
      resource: pending.resource,
      scope: pending.scope,
      agent_connection_id: agentConnectionId,
      expires_at: now() + AUTHORIZATION_CODE_TTL_SECONDS,
      used_at: null,
    });
    redirect(res, authorizationRedirect(pending.redirect_uri, host, { code, state: pending.state }));
  }

  async function token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (mediaType(req) !== "application/x-www-form-urlencoded") {
      return oauthError(res, 400, "invalid_request", "send application/x-www-form-urlencoded", NO_STORE);
    }
    const params = singleParams(new URLSearchParams(await readBody(req, OAUTH_BODY_LIMIT)));
    if (!params) return oauthError(res, 400, "invalid_request", "a parameter appears more than once", NO_STORE);
    const at = now();
    const presented = params.grant_type === "authorization_code" ? params.code : params.grant_type === "refresh_token" ? params.refresh_token : undefined;
    const presentedHash = typeof presented === "string" ? hashToken(presented) : null;
    const stored = {
      code: presentedHash && params.grant_type === "authorization_code" ? await store.findCode(presentedHash) : null,
      refresh: presentedHash && params.grant_type === "refresh_token" ? await store.findRefresh(presentedHash) : null,
    };
    const decision = checkTokenRequest(params, stored, host, at);
    if (!decision.ok) {
      if ("revokeAgentConnection" in decision) await store.revokeAgentConnection(decision.revokeAgentConnection, at);
      return oauthError(res, 400, decision.error, decision.description, NO_STORE);
    }
    const access = generateOpaqueToken();
    const refresh = generateOpaqueToken();
    const issued = await store.redeem(
      presentedHash!,
      { accessHash: hashToken(access), refreshHash: hashToken(refresh), client_id: params.client_id!, grant: decision },
      at,
    );
    if (!issued) {
      // Another request consumed it first. For a refresh token that may be a replay: revoke the grant.
      if (decision.consume === "refresh") await store.revokeAgentConnection(decision.agent_connection_id, at);
      return oauthError(res, 400, "invalid_grant", `the ${decision.consume === "code" ? "code" : "refresh token"} was already used`, NO_STORE);
    }
    send(
      res,
      200,
      { access_token: access, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_SECONDS, refresh_token: refresh, scope: decision.scope },
      NO_STORE,
    );
  }

  async function authenticate(req: IncomingMessage): Promise<AgentConnection | null> {
    const header = req.headers.authorization;
    const match = typeof header === "string" ? /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(header) : null;
    if (!match) return null;
    const checked = checkAccessToken(await store.findAccess(hashToken(match[1]!)), host, now());
    return checked.ok ? backend.connection(checked.agent_connection_id) : null;
  }

  async function callTool(name: string, args: unknown, conn: AgentConnection): Promise<McpToolResult> {
    const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
    if (!tool) throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${name.slice(0, 64)}`);
    const problem = argumentProblem(tool.inputSchema, args ?? {});
    if (problem) {
      return { isError: true, content: [{ type: "text", text: `Invalid arguments: ${problem}.` }], structuredContent: { error: "invalid_arguments", detail: problem } };
    }
    try {
      switch (tool.name) {
        case "list_jobs":
          return listJobsToolResult(await backend.listJobs(conn));
        case "propose_send": {
          const outcome = await backend.proposeSend(args as ProposeSendCall, conn);
          return sendToolResult(outcome.result, outcome);
        }
        case "revise_proposal": {
          const outcome = await backend.revise(args as ReviseCall, conn);
          return sendToolResult(outcome.result, outcome);
        }
        case "get_status": {
          const status = await backend.getStatus((args as { proposal_id: string }).proposal_id, conn);
          return status
            ? statusToolResult(status)
            : { isError: true, content: [{ type: "text", text: "No proposal with that id on this connection." }], structuredContent: { error: "not_found" } };
        }
      }
    } catch (error) {
      options.onError?.(error);
      return INTERNAL_ERROR_RESULT;
    }
  }

  async function mcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const conn = await authenticate(req);
    if (!conn) return send(res, 401, { error: "invalid_token" }, { "www-authenticate": challenge });
    return serveMcp(req, res, conn);
  }

  /** The secret-path fallback: the path is the credential, so a wrong one is simply not found. */
  async function secretMcp(req: IncomingMessage, res: ServerResponse, secret: string): Promise<void> {
    const id = await options.secretPaths!.connectionFor(hashToken(secret));
    const conn = id === null ? null : await backend.connection(id);
    if (!conn) return send(res, 404, { error: "not_found" });
    return serveMcp(req, res, conn);
  }

  async function serveMcp(req: IncomingMessage, res: ServerResponse, conn: AgentConnection): Promise<void> {
    // Stateless: no session, so no server-initiated stream and nothing to delete.
    if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" }, { allow: "POST" });
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req, MCP_BODY_LIMIT));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      return send(res, 400, { jsonrpc: "2.0", error: { code: ErrorCode.ParseError, message: "Parse error" }, id: null });
    }
    const server = new Server({ name: "writ-job-send", version: "0.1.0" }, { capabilities: { tools: {} }, instructions: MCP_INSTRUCTIONS });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: LISTED_TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => callTool(request.params.name, request.params.arguments, conn));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  return async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      if (CORS_PATHS.has(path)) {
        res.setHeader("access-control-allow-origin", "*");
        res.setHeader("access-control-expose-headers", "www-authenticate");
        if (req.method === "OPTIONS") {
          res.writeHead(204, CORS_PREFLIGHT);
          return void res.end();
        }
      }
      if (req.method === "GET" && (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp")) {
        return send(res, 200, metadata.protectedResource);
      }
      if (req.method === "GET" && path === "/.well-known/oauth-authorization-server") return send(res, 200, metadata.authorizationServer);
      if (req.method === "GET" && path === "/oauth/authorize") return await showConsent(req, res, url);
      if (req.method === "POST" && path === "/oauth/authorize") return await answerConsent(req, res);
      if (req.method === "POST" && path === "/oauth/register") return await register(req, res);
      if (req.method === "POST" && path === "/oauth/token") return await token(req, res);
      if (path === "/mcp") return await mcp(req, res);
      const secret = options.secretPaths ? SECRET_PATH.exec(path) : null;
      if (secret) return await secretMcp(req, res, secret[1]!);
      send(res, 404, { error: "not_found" });
    } catch (error) {
      if (res.headersSent) return void res.destroy();
      if (error instanceof HttpError) return send(res, error.status, { error: "request_too_large" });
      options.onError?.(error);
      send(res, 500, { error: "server_error" });
    }
  };
}

/** A node:http server with the handler. Call listen on it. */
export function createJobSendServer(options: JobSendHttpOptions): HttpServer {
  const handler = createJobSendHandler(options);
  return createServer((req, res) => void handler(req, res));
}
