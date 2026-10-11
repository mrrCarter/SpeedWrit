# SpeedWrit

**Give people their time back: approve once, stop watching, get interrupted only by exception, audit everything later.**

AI agents can already draft your client emails. The problem is that you still read every one before it goes out, and that reading eats the time the agent saved. SpeedWrit replaces per-message checking with one decision up front.

- The owner approves a **job** once: one recipient, a send limit, an expiry, an approved template.
- Inside the job the agent just works: the message renders from validated fields and sends.
- Outside the job, **code refuses before Gmail**: the wrong recipient, a send beyond the job's limit, a link, anything after expiry. These cannot be approved — not by the owner at approval time, not by an AI.
- Gray areas (custom wording, a message that names another client, an AI-review flag) **wait for the owner to approve that exact version**. Revising supersedes the old version, so its approval is refused; approving an already-used version returns `not_pending` and creates no second dispatch.
- Every decision writes an **Ed25519-signed receipt** in the same database transaction as the change, and anyone can verify a receipt in the browser.

Built at SpeedHacks (SF Tech Week, Oct 11 2026) for the theme *remove a meaningful bottleneck in how people work*. Prior work, as disclosed on the submission form: the core job-send packages were adapted from the lead's earlier private work, then renamed and extended during the event.

## What a judge can verify right now

Live acceptance run, ChatGPT connected over OAuth, real Gmail, Aman-owned test inboxes. The rows below ran on deployed build `480ee1f`.

**The runtime is now `910252e`,** deployed at 23:01:45Z as image `94144b1f`, with the same database and the same receipt key `8d7fe1becc5eff89`. Any item still to come runs there.
- **Code changes since `480ee1f`:** the Grok redirect allow-list and its exports, workspace metadata, and the setup-guide UI copy.
- **Configuration change:** the terminal grokbot callback was added.

Every row is a signed receipt, readable in the Flight Recorder and checkable at `/owner-app/#/verify`.

| Claim | Evidence |
| --- | --- |
| A real agent acted inside an owner-confirmed job | job `job_BJW_zpuGmVAy_6Pa` (Dana, 2 sends) |
| Routine send accepted by the provider, then seen in the owned inbox | `PROVIDER_ACCEPTED rcp_A_i3OZ22WSdaS0ij` at 21:52:06Z; shown in the owned inbox with a displayed time of 2:52 PM PT — sender, subject and opening preview matched (not a full-body comparison) |
| Wrong recipient refused at the gate, before Gmail, while the job still had an unused send (per its signed receipt sequence) | `ATTEMPT_DENIED rcp_QfnP4-NpIeD0etqn` (`recipient_not_in_job`); an earlier refusal is `rcp_bUOsSbgLsX2Qt2V2` |
| Another agent connection cannot use the job | `ATTEMPT_DENIED rcp_Inj40qVf69D8xhqm` (`job_not_found`) |
| Custom wording held, exact version approved, then sent | `prp_Wgtcoe0j1nKrQqMO`: `APPROVAL_GRANTED rcp_QD2lfO9NJuIKsdXL` → `PROVIDER_ACCEPTED rcp_V8zlL_P8gApSqzFu` |
| Controlled UNKNOWN kept its reserved slot, and the owner's "did not arrive" did not release it | `OUTCOME_UNKNOWN rcp__lT7ioEP7xwZMzbJ`: a labeled controlled test, with a network fault injected for the mail API only, before provider acceptance. The owner's "did not arrive" is `rcp_gGUhLCj966G_J1kh`. Never retrying automatically is source policy; retry counts were not measured. |
| Browser verify on the host | PASSED on `480ee1f`: `rcp_A_i3OZ22WSdaS0ij` verifies, and a one-byte edit gives `invalid_signature`. Re-checked on `910252e` at 23:03:51Z with the same result. |

Open at the time of writing (see the final acceptance matrix in the room for PASSED / MISSING / CONTROLLED-TEST): stale-approval refusal after a revision, STOP with a free slot, and the measurement run.

**Two facts, two labels.** "Provider accepted" means Google took the message. "Witnessed" appears only when an owned inbox showed it. We never say "delivered".

## How it works

```
ChatGPT / Grok ──propose_send──▶ /mcp ──▶ GATE (code checks, fixed order, first failure wins)
                                             │ deny ─▶ ATTEMPT_DENIED receipt, no proposal, nothing approvable
                                             ▼
                                   render exact bytes, hash the version (RFC 8785 JCS + SHA-256)
                                             │
              in template, inside the job ───┼─── custom / names another client / AI-review flag
                        │                                              │
                 dispatch_auto                              pending_approval ─▶ owner approves THAT hash
                        │                                              │
                        └───────────▶ reserve one send in a transaction ◀──────┘
                                      one Gmail call, 20 s, no retry
                                      ACCEPTED | NOT_SENT | UNKNOWN  (+ receipt, same transaction)
```

- **Gate order:** job exists for this connection → rate limit → job active → not expired → dispatch not stopped → exactly one recipient → recipient is the job's → send limit → fields within rules (length, single line, no control chars, no URL) → other-client mention → render → AI review (can only add a hold).
- **Invariants the code keeps:** a version is immutable after insert; at most one approval and one dispatch per version (unique constraints); `sends_reserved` never exceeds `max_sends` (conditional update under lock); no receipt, no change; dispatch sends the stored MIME bytes, nothing is re-rendered.
- **STOP** sets `dispatch_enabled = false` first (instant, `STOP_ENGAGED`), then revokes the Google token. It blocks every reservation that starts afterwards; nothing recalls an email already submitted.
- **UNKNOWN** (timeout, reset, 5xx) keeps the reservation and never resends; the owner resolves it ("I see it" / "It did not arrive"), with a receipt naming the owner as the source.
- **AI review** reads only agent-written free text, runs after every code check passed and before any transaction opens, one attempt within a budget. `hold` and `unavailable` both add a review reason; `clear` changes nothing. It can never override a code denial or waive an approval.

## Agent connection

`/mcp` is a stateless MCP server (streamable HTTP, JSON responses) with four tools: `list_jobs`, `propose_send`, `revise_proposal`, `get_status`. Write tools are declared as writes (`readOnlyHint: false`); input schemas reject unknown properties. Results carry one plain sentence and the same facts in `structuredContent`: `sent`, `pending_approval`, `denied`, `not_sent`, `unknown`. `sent: true` appears only after the provider accepted.

OAuth per the MCP authorization spec: `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` (S256, `iss`), dynamic registration at `/oauth/register`, opaque hour-long bearers stored hashed, `resource`-bound. Allowed redirect URIs: ChatGPT's, grok.com's connector callback, Grok Bot's two callbacks, plus `REDIRECT_FALLBACKS`. A secret-path connection (`/mcp/c/<43 chars>`) exists as a labeled fallback when a client cannot finish OAuth; it is never called OAuth.

**Clients**
- **ChatGPT** — custom MCP server at `HOST/mcp`, OAuth. Used for the live acceptance run.
- **Grok** — three ways in: the grok.com connector, the Grok Bot desktop app (both OAuth), or `packages/grokbot`, a terminal client that calls the same four tools over the xAI Responses API (`npm run -w packages/grokbot build`; set `SPEEDWRIT_MCP_URL` and `XAI_API_KEY`; `node packages/grokbot/dist/cli.js doctor | ask | demo`). Grok support merged after the live acceptance run and was not part of it. Four review follow-ups on the terminal client are open (conversation state across turns, token-refresh locking, output redaction, HTTP deadlines); until they land, run one grokbot process at a time and do not present its raw output as evidence.

The same gate governs every client. Receipts record the client's self-declared name (`client_label`; Grok Bot, for example, registers as "Cursor") as given, not as a verified identity.

## Owner app

Connect (Gmail account and exact granted permission; agent connections; STOP), Confirm job (the three lists: Never / Ask me / Runs without asking, the authority hash), Exceptions (one card per pending version with a word-level diff; Approve binds the hash it shows; approving from a stale tab answers `status: refused, reason: superseded` with an `APPROVAL_REFUSED` receipt), Flight Recorder (a timeline per job, each row opens its receipt; denials read "Prohibited by your job: not approvable"), Verify (paste a receipt: key fingerprint, "Signature verified" or "Signature invalid"; edit one byte and watch it fail).

## Run it

```
npm ci
RECEIPT_KEY_ID=<id> RECEIPT_PUBLIC_KEY_B64URL=<pub> npm run -w packages/job-send-ui build:app
npm run build
node packages/job-send-app/dist/main.mjs      # first log line: "receipt signing key <id>" — must equal RECEIPT_KEY_ID
```

Node 22, npm 11, Postgres. Migrations run at boot, in order, once each.

Required: `HOST` (exact https origin), `DATABASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `RECEIPT_SIGNING_KEY` (Ed25519 PKCS#8 PEM), `CUSTODY_KEY` (32 random bytes, base64; seals Gmail refresh tokens with AES-256-GCM), `OWNER_APP_DIR`.
Optional: `PORT`, `ACCESS_LOG`, `SECRET_PATH_FALLBACK`, `REDIRECT_FALLBACKS`, `OWNER_APP_CONTACTS`, `DEFAULT_TEMPLATE_ID`, `JOB_PURPOSE`, `DEMO_RECIPIENTS` (an allowlist checked right before the provider call), the AI-review provider key named in `packages/job-send-app/src/config.ts`, `AI_REVIEW_MODEL` (pinned).

Google OAuth client: redirect URIs `HOST/auth/google/callback` and `HOST/auth/gmail/callback`; scopes `openid email` and `gmail.send`; Testing mode, each human added as a test user. Connect Gmail asks with `access_type=offline` and `prompt=consent`; the connected address comes from the verified ID token.

## Repository

| Path | What |
| --- | --- |
| `packages/job-send` | Contract types and reason codes, the gate, executor (render, reservation transaction, Gmail provider, sweeper, STOP), receipts and verify, OAuth server, MCP tools, owner API, Postgres stores and migrations |
| `packages/job-send-app` | The one process: config from the environment (problems reported by name, never value), `startService` |
| `packages/job-send-ui` | The owner app and the in-browser receipt verifier |
| `packages/grokbot` | Grok as a second agent client |
| `demo/owner-local` | A local, synthetic owner UI for rehearsal; not the product |

CI on every PR: clean install, typecheck, the full suite with an embedded Postgres, and a commit-identity check. Merges are single-owner, with a non-author key on the exact head and two keys on the reservation transaction, the gate, token custody, the OAuth token endpoint and receipt signing.

## Security model, in one table

| Credential | Lives in | Valid at |
| --- | --- | --- |
| Owner session cookie | the owner's browser | the owner app and API |
| Agent access token | the client's connector storage | `/mcp` only; opaque, 1 h, hashed at rest |
| Google refresh token | our database, AES-256-GCM | Google; decrypted only inside the executor |
| Receipt signing key | deploy secret | nowhere external; the public key is pinned in the owner app |

The service is built not to serialize secrets to MCP output, the UI, receipts, its logs or AI-review requests. Its access logs redact secret paths. This covers the server only: output redaction in the grokbot terminal client is an open follow-up.

## What we say and never say

| Say | Never say |
| --- | --- |
| Provider accepted | Delivered |
| Outcome unknown. Do not resend. | Failed, retrying |
| Signature verified | Tamper-proof |
| Prohibited by your job: not approvable | Blocked (beside an Approve button) |
| AI-reviewed, may miss | Protected, guaranteed |
| One scripted run, our own test | Proven at scale |

## Limits, honestly

- The live acceptance run used ChatGPT; Grok support is merged but was not part of it.
- Gmail send has no idempotency key and send-only cannot read the mailbox, so UNKNOWN is resolved by the owner, not by us.
- AI review was not configured in the live run; held drafts show `ai_review_unavailable`. Approval is on screen.
- **The measurement** compares a manual baseline with one scripted SpeedWrit run that produces the same two emails, each run by a different operator. Timings and savings are reported as measured, or as missing. Any savings claim needs that measured baseline.
- Not in this build: Cc, Bcc, attachments, HTML, links, inbox reading, delivery checks, risk scores, arbitrary policy generation.

## Team

Carter (lead; ship and connect), Ali (Gmail paths, Grok client), Aman (owner experience, stage, measurement), with Claude and Codex agents coordinating in a SentinelLayer room under a two-key review rule.
