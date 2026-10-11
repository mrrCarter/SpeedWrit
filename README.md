# SpeedWrit

Job-bound sending for AI agents. An agent (ChatGPT, over MCP) sends email for its owner only inside a **job**: a work order with one recipient, a send limit and an expiry, which the owner confirms once.

- **Inside the job, it just works.** The approved template with fields inside the rules goes out without asking.
- **Outside the job, code refuses before Gmail.** A different recipient, one send too many, an expired job, a link, Cc or Bcc. Nothing to approve, because it can't be approved.
- **Gray areas wait for the owner.** Custom wording, a message naming another client, an AI-review flag: the owner approves that exact version, by its hash, or it doesn't send.
- **Every decision gets a signed receipt** (Ed25519 over canonical JSON), and anyone can verify it in the browser.

## Packages

| Package | What |
| --- | --- |
| `packages/job-send` | The gate, executor (reservation transaction, Gmail provider, STOP and UNKNOWN, sweeper), receipts, the OAuth and MCP server, the owner API and core, Google sign-in, Connect Gmail, Postgres stores and migrations |
| `packages/job-send-ui` | The owner app: confirm a job, exceptions with the version diff, the Flight Recorder timeline, receipt verification |
| `packages/job-send-app` | The one service: web UI, owner API, MCP endpoint and executor on one Postgres |

## Run

Node 22 and npm 11.

```sh
npm ci
RECEIPT_KEY_ID=<id> RECEIPT_PUBLIC_KEY_B64URL=<public key> npm run -w packages/job-send-ui build:app
npm run build
node packages/job-send-app/dist/main.mjs
```

Required environment: `HOST` (an https origin), `DATABASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `RECEIPT_SIGNING_KEY` (Ed25519 PKCS#8 PEM), `CUSTODY_KEY` (32 random bytes, base64), `OWNER_APP_DIR` (the `build:app` output, `packages/job-send-ui/dist/owner-app`). The first log line, `receipt signing key <id>`, must match `RECEIPT_KEY_ID`.

Connect a client at `HOST/mcp` (OAuth with dynamic registration). The Google OAuth client needs the redirect URIs `HOST/auth/google/callback` and `HOST/auth/gmail/callback`.

## Test

```sh
npm test
```

The job-send and job-send-app suites run on a real, embedded Postgres.
