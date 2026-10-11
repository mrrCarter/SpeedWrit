# grokbot: Grok as a SpeedWrit agent client

Grok connects to SpeedWrit the way ChatGPT does: over MCP, to the same `/mcp`, behind the same gate. Grok gets SpeedWrit's four tools (`list_jobs`, `propose_send`, `revise_proposal`, `get_status`) and nothing else. Every send is decided by the job the owner confirmed, never by the client.

Each Grok surface reaches SpeedWrit from xAI's servers, so the host must be public HTTPS. A laptop's `localhost` is not reachable from xAI.

## Which way to connect

| Surface | How it authenticates | What the host needs |
| --- | --- | --- |
| **grokbot CLI** (this package, xAI Responses API) | OAuth sign-in as its own client, or the secret path | `REDIRECT_FALLBACKS` includes `http://127.0.0.1:8976/callback` (OAuth), or `SECRET_PATH_FALLBACK=on` |
| **Grok on grok.com** (custom connector) | OAuth: dynamic registration, PKCE S256 | Grok's callback allowed (see below) |
| **Grok Bot desktop app** | OAuth, or the secret-path URL with no sign-in | The secret path works today; its OAuth callback is not yet confirmed |

Each OAuth consent creates its **own agent connection**, and every job is bound to one. A job confirmed for ChatGPT refuses grokbot with a wrong-client denial before Gmail is touched. To let Grok send, confirm a job for Grok's connection.

## grokbot CLI

Grok over xAI's Responses API with SpeedWrit as a remote MCP tool ([docs.x.ai, Remote MCP Tools](https://docs.x.ai/docs/guides/tools/remote-mcp-tools)). xAI calls `/mcp` itself; grokbot only sends prompts and prints what Grok did. xAI has no `require_approval`, so no client-side confirmation exists. SpeedWrit's gate is the only authority.

```sh
npm ci && npm run -w packages/grokbot build
export SPEEDWRIT_MCP_URL=https://HOST/mcp        # or the secret-path URL
export XAI_API_KEY=...                           # console.x.ai; never commit it

node packages/grokbot/dist/cli.js login          # bearer mode only: the owner presses Allow once
node packages/grokbot/dist/cli.js doctor         # MCP initialize + tools/list, no Grok tokens spent
node packages/grokbot/dist/cli.js ask "What jobs can you do for me right now?"
node packages/grokbot/dist/cli.js demo           # the spec's six stage prompts, one conversation
node packages/grokbot/dist/cli.js demo --from 2 --to 3 --json
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `SPEEDWRIT_MCP_URL` | required | `https://HOST/mcp` for OAuth, or `https://HOST/mcp/c/<secret>` |
| `XAI_API_KEY` | none | Needed for `ask` and `demo` |
| `GROK_MODEL` | `grok-4.7` | Any xAI model with remote MCP tools |
| `GROKBOT_XAI_AUTH_STYLE` | `bearer` | `bearer` sends `authorization: "Bearer <token>"` to xAI; `raw` sends the bare token |
| `GROKBOT_TOKEN_FILE` | `~/.config/grokbot/tokens.json` | Written owner-only (0600) |
| `GROKBOT_TIMEOUT_MS` | `180000` | One xAI call, tool calls included |
| `XAI_BASE_URL` | `https://api.x.ai/v1` | |

**OAuth mode.** `login` registers grokbot as a public client named "grokbot (xAI Grok)", opens the consent page, and catches the code on `http://127.0.0.1:8976/callback`. It checks `state` and RFC 9207 `iss`. Access tokens last one hour; grokbot refreshes five minutes early and saves the rotated pair before using it, because SpeedWrit revokes the whole grant when a rotated refresh token is shown twice.

**Secret-path mode.** The owner mints `HOST/mcp/c/<secret>` for an existing agent connection with `POST /owner/agent-connections/secret-path` (host needs `SECRET_PATH_FALLBACK=on`). The URL is the credential: grokbot sends no `authorization` and redacts the secret in everything it prints.

**One attempt per call.** grokbot never retries an xAI call, because a retry could repeat a send request. A failure is reported with its HTTP status, never the key.

## Grok on grok.com

1. grok.com/connectors, then **New Connector**, then **Custom**.
2. Server URL: `https://HOST/mcp`.
3. Grok discovers the OAuth metadata, registers itself, and opens SpeedWrit's sign-in and consent. Press **Allow**.

Grok's callback is `https://grok.com/connectors-oauth-exchange-code/` according to public reports (xAI does not document it). Until it is built into SpeedWrit's allow-list, add it to the host's `REDIRECT_FALLBACKS`.

## Grok Bot desktop app

In a Grok Bot chat:

```text
Add a custom MCP server called speedwrit at https://HOST/mcp
```

Confirm with **Add it**. If Grok Bot shows an **Authorize** card, sign in and press **Allow**. If its sign-in fails on a redirect it does not list, use the secret path instead, which needs no sign-in:

```text
Add a custom MCP server called speedwrit at https://HOST/mcp/c/<secret>
```

Then attach it to a task with `@speedwrit`. Check it under Settings, then Plugins, then Yours.
