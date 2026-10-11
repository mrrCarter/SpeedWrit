// One acceptance "world": a seeded owner, Gmail connection, agent connection and job on real
// Postgres; the executor over the fault-injecting stub provider; the real agent server
// (createJobSendServer with createMcpBackend) on a local port, and a bearer token for the job's
// agent connection; and the owner core. The agent acts only through POST /mcp, as ChatGPT would.
import { generateOpaqueToken, hashToken } from "../../../dist/oauth/oauth.js";
import { InMemoryOAuthStore, createJobSendServer, createMcpBackend, createOwnerCore } from "../../../dist/server/index.js";
import { makeExecutor, seedJob } from "../../executor-support/fixtures.mjs";

export const HOST = "https://jobs.example.test";
export const RESOURCE = `${HOST}/mcp`;

/** A bearer token for `agentConnectionId`, stored by hash as the token endpoint would store it. */
export function mintToken(store, agentConnectionId) {
  const token = generateOpaqueToken();
  store.access.set(hashToken(token), {
    agent_connection_id: agentConnectionId,
    resource: RESOURCE,
    scope: "jobs.act",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    revoked_at: null,
  });
  return token;
}

let rpcId = 0;

export async function openWorld(db, { seed: seedOverrides = {}, script, review, revoke, sweepAfterMs } = {}) {
  const seed = await seedJob(db.pool, seedOverrides);
  const { executor, stub } = makeExecutor(db.pool, { script, revoke, sweepAfterMs });
  const backend = createMcpBackend({ pool: db.pool, executor, review });
  const owner = createOwnerCore({ pool: db.pool, executor, mcpUrl: RESOURCE });
  const store = new InMemoryOAuthStore();
  const errors = [];
  const answers = [];
  const server = createJobSendServer({
    host: HOST,
    store,
    backend,
    authorize: {
      owners: { owner: async () => null, signInUrl: () => "/" },
      createAgentConnection: async () => {
        throw new Error("not used by the acceptance world");
      },
      renderConsent: () => "",
    },
    onError: (error) => errors.push(String(error?.stack ?? error)),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const bearer = mintToken(store, seed.agentConnection);

  /** One MCP tools/call over HTTP; returns the tool result, its structured content and its text. */
  async function tool(name, args, token = bearer) {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
    });
    const text = await res.text();
    answers.push(text);
    if (res.status !== 200) return { status: res.status, text };
    const result = JSON.parse(text).result;
    return { status: res.status, result, sc: result.structuredContent, text: result.content?.map((c) => c.text).join("\n") ?? "" };
  }

  const propose = (args, token) => tool("propose_send", { job_id: seed.job, to: "dana@test.example", ...args }, token);
  const close = () => new Promise((resolve) => server.close(resolve));
  return { seed, executor, stub, backend, owner, store, base, bearer, errors, answers, tool, propose, close };
}
