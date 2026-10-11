# grokbot: Grok as a SpeedWrit agent client

Grok connects to SpeedWrit the way ChatGPT does: over MCP, to the same `/mcp`, behind the same gate. Grok gets SpeedWrit's four tools (`list_jobs`, `propose_send`, `revise_proposal`, `get_status`) and nothing else. Every send is decided by the job the owner confirmed, never by the client.

Each Grok surface reaches SpeedWrit from xAI's servers, so the host must be public HTTPS. A laptop's `localhost` is not reachable from xAI.

## Which way to connect

| Surface | How it authenticates | What the host needs |
| --- | --- | --- |
| **grokbot CLI** (this package, xAI Responses API) | The secret path, or OAuth sign-in as its own client | `SECRET_PATH_FALLBACK=on`, or `REDIRECT_FALLBACKS` includes `http://127.0.0.1:8976/callback` |
| **Grok on grok.com** (custom connector) | OAuth: dynamic registration, PKCE S256 | Nothing: its callback is built in |
| **Grok Bot desktop app** | OAuth (observed), or the secret-path URL | Nothing for OAuth: its two callbacks are built in |

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

**Secret-path mode.** The owner creates a connection and its URL `HOST/mcp/c/<secret>` in one step: in the owner app, or with `POST /owner/agent-connections/secret-path-new` and `client_label: "grokbot"`. An existing connection gets one with `POST /owner/agent-connections/secret-path`. The host needs `SECRET_PATH_FALLBACK=on`. The URL is the credential: grokbot sends no `authorization` and redacts the secret in everything it prints.

**One attempt per call.** grokbot never retries an xAI call, because a retry could repeat a send request. A failure is reported with its HTTP status, never the key.

## Grok on grok.com

1. grok.com/connectors, then **New Connector**, then **Custom**.
2. Server URL: `https://HOST/mcp`.
3. Grok discovers the OAuth metadata, registers itself, and opens SpeedWrit's sign-in and consent. Press **Allow**.

Grok's callback is `https://grok.com/connectors-oauth-exchange-code/`, built into SpeedWrit's allow-list. xAI does not document it; it comes from MCP server operators' reports and has not been observed here yet.

## Grok Bot desktop app

In a Grok Bot chat:

```text
Add a custom MCP server called speedwrit at https://HOST/mcp
```

Confirm with **Add it**, press **Authorize**, then **Allow** on SpeedWrit's consent page. Or add it under Settings, then Plugins.

What Grok Bot sends, observed on 2026-10-11 against the lab: it signs in as `client_name: "Cursor"` (user agent `Cursor/1.0.0`), registers `https://www.cursor.com/agents/mcp/oauth/callback` and `http://localhost:8787/callback` together, and authorizes with the first and `resource=HOST/mcp`. Both callbacks are built into SpeedWrit's allow-list, because registration needs every listed URI allowed. The consent screen names the client "Cursor".

Without sign-in, give it a secret-path URL instead:

```text
Add a custom MCP server called speedwrit at https://HOST/mcp/c/<secret>
```

Then attach it to a task with `@speedwrit`. Check it under Settings, then Plugins, then Yours.

## The lab: test every Grok surface before the real host exists

`lab/lab.mjs` runs SpeedWrit's real agent side on this machine: OAuth, `/mcp`, the secret path, the gate, the executor and signed receipts, on an embedded Postgres. Two things are swapped so nothing real is needed:

- **The owner is always signed in.** Consent needs no Google sign-in.
- **Mail goes to a stub outbox.** Every send is accepted and recorded, and nothing leaves the process.

Every agent connection that connects gets the demo's job, "Tuesday recap to Dana" with 2 sends, confirmed for it. At start the lab also makes a "Grok Bot (lab, secret path)" connection with its own job and prints its secret-path URL. It logs what each client registers (redirect URIs, auth method, name) to `lab/lab-log.jsonl`, which is how Grok's callbacks are learned.

**Never deploy the lab.** Anyone who reaches it is the owner. It listens on 127.0.0.1 only, and only a tunnel you start yourself makes it public.

### Runbook

1. Start a tunnel to port 8790 and note its https origin. A fixed domain is best, because every saved connector breaks when the URL changes.
2. Start the lab with that origin. Capture mode allows whatever redirect a client registers, and logs it:
   ```sh
   HOST=https://<tunnel> LAB_ACCEPT_ANY_REDIRECT=on node packages/grokbot/lab/lab.mjs
   ```
3. Prove the server side with no Grok involved. Use the local secret-path URL the lab prints:
   ```sh
   node packages/grokbot/lab/smoke.mjs http://127.0.0.1:8790/mcp/c/<secret>
   ```
   Restart the lab afterwards, since the smoke uses up that job's two sends.
4. **grokbot**, using the public secret path or OAuth:
   ```sh
   SPEEDWRIT_MCP_URL=https://<tunnel>/mcp/c/<secret> node packages/grokbot/dist/cli.js doctor
   SPEEDWRIT_MCP_URL=https://<tunnel>/mcp/c/<secret> XAI_API_KEY=... node packages/grokbot/dist/cli.js demo
   ```
5. **grok.com**: add a custom connector with `https://<tunnel>/mcp`, press Allow, then say the six demo prompts in a Grok chat.
6. **Grok Bot**: say "Add a custom MCP server called speedwrit at https://<tunnel>/mcp", then Authorize and Allow. Watch the lab log for its registration.
7. Approve held versions at `http://127.0.0.1:8790/lab`. The outbox and receipts are on the same page.

Any redirect URI the log shows that SpeedWrit does not already allow goes into `REDIRECT_FALLBACKS` on the real host, or into the allow-list by PR.
