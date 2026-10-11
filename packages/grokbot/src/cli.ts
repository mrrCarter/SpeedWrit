#!/usr/bin/env node
// grokbot: Grok as a SpeedWrit agent client.
//
//   grokbot doctor              check SpeedWrit's MCP endpoint with grokbot's credential (no Grok tokens spent)
//   grokbot login               OAuth sign-in as grokbot (bearer mode, SPEEDWRIT_MCP_URL=https://HOST/mcp)
//   grokbot ask "<prompt>"      one prompt to Grok, with SpeedWrit's four tools
//   grokbot demo [--from N] [--to N]   the spec's six stage prompts, in one conversation
//
// Add --json to ask or demo for the parsed responses as JSON. Exit codes: 0 done, 1 failed, 2 configuration.

import { spawn } from "node:child_process";
import { homedir } from "node:os";

import { readConfig, redactMcpUrl, type GrokbotConfig } from "./config.js";
import { converse, DEMO_PROMPTS, formatExchange } from "./demo.js";
import { checkMcp } from "./mcp-check.js";
import { currentBearer, login, LOOPBACK_REDIRECT } from "./oauth-login.js";
import { createResponse, mcpTool, type FetchLike } from "./xai.js";

const fetchImpl: FetchLike = (input, init) => fetch(input, init);
const nowSeconds = () => Math.floor(Date.now() / 1000);

function usage(): never {
  console.error('usage: grokbot doctor | login | ask "<prompt>" | demo [--from N] [--to N]   (add --json to ask or demo)');
  process.exit(2);
}

async function bearerFor(config: GrokbotConfig): Promise<string | null> {
  if (config.credential === "secret_path") return null;
  return currentBearer(fetchImpl, { file: config.tokenFile, origin: config.origin, resource: `${config.origin}/mcp`, now: nowSeconds() });
}

function openInBrowser(url: string): void {
  console.log(`\nOpen this link, sign in to SpeedWrit as the owner, and press Allow:\n\n  ${url}\n`);
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  try {
    spawn(command, [url], { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
  } catch {
    // The link is printed above; opening a browser is only a convenience.
  }
}

function flag(args: string[], name: string): number | null {
  const at = args.indexOf(name);
  if (at === -1) return null;
  const value = Number(args[at + 1]);
  if (!Number.isInteger(value)) usage();
  return value;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === "--help" || command === "help") usage();
  const read = readConfig(process.env, homedir());
  if (!read.ok) {
    for (const problem of read.problems) console.error(`${problem.name}: ${problem.problem}`);
    return 2;
  }
  const config = read.config;
  const asJson = args.includes("--json");

  if (command === "login") {
    if (config.credential === "secret_path") {
      console.error("SPEEDWRIT_MCP_URL is a secret-path URL, which needs no sign-in. Use https://HOST/mcp to sign in with OAuth.");
      return 2;
    }
    console.log(`Signing grokbot in to ${config.origin}. The host must allow ${LOOPBACK_REDIRECT} in REDIRECT_FALLBACKS.`);
    const tokens = await login(fetchImpl, { origin: config.origin, file: config.tokenFile, openUrl: openInBrowser, now: nowSeconds });
    console.log(`Signed in. Tokens saved to ${config.tokenFile} (owner-only). Access token valid until ${new Date(tokens.expires_at * 1000).toISOString()}; grokbot refreshes it.`);
    return 0;
  }

  if (command === "doctor") {
    console.log(`SpeedWrit MCP: ${redactMcpUrl(config.mcpUrl)} (${config.credential === "secret_path" ? "secret path" : "OAuth bearer"})`);
    const check = await checkMcp(fetchImpl, { url: config.mcpUrl, bearer: await bearerFor(config) });
    if (!check.ok) {
      console.error(`FAIL at ${check.step}: ${check.problem}`);
      return 1;
    }
    console.log(`OK: server ${check.serverName ?? "?"}, protocol ${check.protocolVersion ?? "?"}, tools ${check.tools.join(", ")}`);
    if (check.missing.length > 0) console.error(`missing tools: ${check.missing.join(", ")}`);
    console.log(`xAI: ${config.xaiApiKey ? "XAI_API_KEY is set" : "XAI_API_KEY is NOT set (needed for ask and demo)"}; model ${config.model}`);
    if (config.mcpUrl.startsWith("http://")) console.error("note: xAI calls the MCP URL from its own servers, so ask and demo need a public https URL.");
    return check.missing.length > 0 ? 1 : 0;
  }

  if (command === "ask" || command === "demo") {
    if (!config.xaiApiKey) {
      console.error("XAI_API_KEY: required for ask and demo (console.x.ai). It never leaves this machine except to api.x.ai.");
      return 2;
    }
    let prompts: readonly string[];
    if (command === "ask") {
      const prompt = args.filter((arg) => arg !== "--json").join(" ").trim();
      if (!prompt) usage();
      prompts = [prompt];
    } else {
      const from = flag(args, "--from") ?? 1;
      const to = flag(args, "--to") ?? DEMO_PROMPTS.length;
      prompts = DEMO_PROMPTS.slice(Math.max(0, from - 1), to);
    }
    const apiKey = config.xaiApiKey;
    console.log(`grokbot -> ${config.model} -> SpeedWrit ${redactMcpUrl(config.mcpUrl)}`);
    const exchanges = await converse(prompts, {
      model: config.model,
      tool: async () => mcpTool(config.mcpUrl, await bearerFor(config), config.authStyle),
      send: (request) => createResponse(fetchImpl, { baseUrl: config.xaiBaseUrl, apiKey, request, timeoutMs: config.timeoutMs }),
      onExchange: (exchange, index) => {
        if (!asJson) console.log(formatExchange(exchange, index));
      },
    });
    if (asJson) console.log(JSON.stringify(exchanges, null, 2));
    return 0;
  }

  usage();
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exit(1);
  },
);
