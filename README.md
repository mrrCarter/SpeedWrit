# SpeedWrit

**Give people their time back: approve once, stop watching, get interrupted only by exception, inspect recorded decisions later.**

AI agents can already draft your client emails. The problem is that you still read every one before it goes out, and that reading eats the time the agent saved. SpeedWrit replaces per-message checking with one decision up front. It governs the sends an agent makes **through SpeedWrit**; it does not observe other agent actions or Gmail access it does not hold.

- The owner approves a **job** once: one recipient, a send limit, an expiry, an approved template.
- Inside the job the agent just works: the message renders from validated fields and sends. Validated fields satisfy structural rules (length, single line, no links); they do not guarantee that the content is accurate or that every statement matches the owner's intent.
- Outside the job, **code refuses before Gmail**: the wrong recipient, exceeding the job's send limit, a link, anything after expiry. These cannot be approved — not by the owner at approval time, not by an AI.
- Gray areas (custom wording, a message that names another client, an AI-review flag) **wait for the owner to approve that exact version**. Revising supersedes the old version, so its approval is refused; approving an already-used version returns `not_pending` and creates no second dispatch.
- The job decisions and state changes SpeedWrit records (for example a job confirmation, a gate denial, an approval, a send outcome, STOP) each write an **Ed25519-signed receipt** in the same database transaction as the change, and anyone can verify a receipt in the browser. Requests rejected before they reach a job, such as failed authentication or malformed input, are not necessarily receipted.

Built at SpeedHacks (SF Tech Week, Oct 11 2026) for the theme *remove a meaningful bottleneck in how people work*. Prior work, as disclosed on the submission form: the core job-send packages were adapted from the lead's earlier private work, then renamed and extended during the event.

## What a judge can verify right now

Live acceptance run, ChatGPT connected over OAuth, real Gmail, Aman-owned test inboxes. The historical rows below ran on deployed build `480ee1f`. The runtime is now `910252e` (image `94144b1f`, same database, same receipt key `8d7fe1becc5eff89`); evidence stays attributed to the build it ran on, and anything still to come runs on `910252e`. The `rcp_…` IDs are signed receipts recorded by the live host; the job row and the browser-verify row are context, not receipts. A receipt's exported JSON can be checked at `/owner-app/#/verify`.

**Evidence bundle:** [`docs/evidence/2026-10-11`](docs/evidence/2026-10-11/) holds seven of these receipts as original signed files, with the pinned public key, the browser-check screenshots and a dependency-free checker. Running `node docs/evidence/2026-10-11/verify.mjs` verifies every signature and rejects a one-byte edit of each, with no network access.

| Claim | Evidence |
| --- | --- |
| A real agent acted inside an owner-confirmed job | job `job_BJW_zpuGmVAy_6Pa` (Dana, 2 sends) |
| Routine send accepted by the provider, then seen in the owned inbox | `PROVIDER_ACCEPTED rcp_A_i3OZ22WSdaS0ij` at 21:52:06Z; shown in the owned inbox with a displayed time of 2:52 PM PT — sender, subject and opening preview matched (not a full-body comparison) |
| Wrong recipient refused at the gate, before Gmail, with send capacity still free | `ATTEMPT_DENIED rcp_QfnP4-NpIeD0etqn` (`recipient_not_in_job`; capacity shown by the signed sequence, so the refusal is the recipient rule, not an exhausted limit). Earlier refusal on a full job: `rcp_bUOsSbgLsX2Qt2V2` |
| Another agent connection cannot use the job | `ATTEMPT_DENIED rcp_Inj40qVf69D8xhqm` (`job_not_found`; this denial has no job attribution, so it is not in the job's Flight Recorder timeline) |
| Custom wording held, exact version approved, then sent | `prp_Wgtcoe0j1nKrQqMO`: `APPROVAL_GRANTED rcp_QD2lfO9NJuIKsdXL` → `PROVIDER_ACCEPTED rcp_V8zlL_P8gApSqzFu` |
| Controlled UNKNOWN retained its reserved slot; the owner's did-not-arrive observation did not release it | `OUTCOME_UNKNOWN rcp__lT7ioEP7xwZMzbJ` (a network fault injected for the mail API only, before provider acceptance, labeled); `rcp_gGUhLCj966G_J1kh`. No automatic retry is source policy; retry and provider-call counters were not measured. A later, separate approved proposal sent |
| Browser verify on the host (`/owner-app/#/verify`) | PASSED on `480ee1f` and again on `910252e` at 23:03:51Z: `rcp_A_i3OZ22WSdaS0ij` verifies; exactly one changed byte gives `invalid_signature` |

Open at the time of writing: stale-approval refusal after a revision, STOP with a free slot, and the measurement run.

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
- **Invariants the code keeps:** a version is immutable after insert; at most one approval and one dispatch per version (unique constraints); `sends_reserved` never exceeds `max_sends` (conditional update under lock); each recorded job state change commits together with its receipt (unconfirmed drafts are not receipted); dispatch sends the stored MIME bytes, nothing is re-rendered.
- **STOP** sets `dispatch_enabled = false` and records `STOP_ENGAGED`; it takes effect when that local transaction commits and blocks every reservation that starts afterwards. Revoking the Google token is then attempted separately and can fail. Nothing recalls an email already submitted.
- **UNKNOWN** (timeout, reset, 5xx) keeps the reservation and does not automatically resend. The owner records whether they observed arrival ("I see it" / "It did not arrive"), with a receipt naming the owner as the source; the outcome remains UNKNOWN and the reservation stays consumed.
- **AI review** reads only agent-written free text, runs after every code check passed and before any transaction opens, one attempt within a budget. `hold` and `unavailable` both add a review reason; `clear` changes nothing. It can never override a code denial or waive an approval.

## Agent connection

`/mcp` is a stateless MCP server (streamable HTTP, JSON responses) with four tools: `list_jobs`, `propose_send`, `revise_proposal`, `get_status`. Write tools are declared as writes (`readOnlyHint: false`); input schemas reject unknown properties. Results carry one plain sentence and the same facts in `structuredContent`: `sent`, `pending_approval`, `denied`, `not_sent`, `unknown`. `sent: true` appears only after the provider accepted.

OAuth per the MCP authorization spec: `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` (S256, `iss`), dynamic registration at `/oauth/register`, opaque hour-long bearers stored hashed, `resource`-bound. Allowed redirect URIs: ChatGPT's, grok.com's connector callback, Grok Bot's two callbacks, plus `REDIRECT_FALLBACKS`. A secret-path connection (`/mcp/c/<43 chars>`) exists as a labeled fallback when a client cannot finish OAuth; it is never called OAuth.

**Clients**
- **ChatGPT** — custom MCP server at `HOST/mcp`, OAuth. The demonstrated client: used for the live acceptance run.
- **Grok (experimental)** — three ways in: the grok.com connector, the Grok Bot desktop app (both OAuth), or `packages/grokbot`, a terminal client that calls the same four tools over the xAI Responses API. Grok support merged after the live acceptance run and was not part of it. Four review follow-ups on the terminal client are open (conversation state across turns, token-refresh locking, output redaction, HTTP deadlines). Running one process at a time avoids only the refresh race; treat its output as unreviewed, and never as evidence.

```
npm run -w packages/grokbot build
export SPEEDWRIT_MCP_URL=https://HOST/mcp              # set privately
export XAI_API_KEY=...                                  # set privately; never commit it
node packages/grokbot/dist/cli.js login                 # OAuth mode, first; the host must list http://127.0.0.1:8976/callback in REDIRECT_FALLBACKS (not built in). The owner presses Allow once
node packages/grokbot/dist/cli.js doctor                # MCP initialize + tools/list, no model call
node packages/grokbot/dist/cli.js ask "List my jobs only."
```

The same gate governs every client. Receipts record the client's self-declared name (`client_label`; Grok Bot, for example, registers as "Cursor") as given, not as a verified identity.

## Owner app

Connect (Gmail account and exact granted permission; agent connections; STOP), Confirm job (the three lists: Never / Ask me / Runs without asking, the authority hash), Exceptions (one card per pending version with a word-level diff; Approve binds the hash it shows; approving from a stale tab answers `status: refused, reason: superseded` with an `APPROVAL_REFUSED` receipt), Flight Recorder (a timeline per job, each row opens its receipt; denials read "Prohibited by your job: not approvable"), Verify at `/owner-app/#/verify` (paste a receipt: key fingerprint, "Signature verified" or "Signature invalid"; edit one byte and watch it fail).

## Run it

Node 22, npm 11, Postgres.

```
npm ci
export RECEIPT_SIGNING_KEY="$(cat receipt-signing-key.pem)"   # Ed25519 PKCS#8 PEM, kept private
node deploy/g1/build.mjs        # derives RECEIPT_KEY_ID and the public key, then builds the owner app and the service
npm test                        # the suites, on an embedded Postgres
node packages/job-send-app/dist/main.mjs   # first log line: "receipt signing key <id>"; it must equal the derived RECEIPT_KEY_ID
```

`RECEIPT_KEY_ID` is not a label you choose: it is the first 16 hex characters of SHA-256 over the raw 32-byte Ed25519 public key, and `RECEIPT_PUBLIC_KEY_B64URL` is that public key in base64url ([`deploy/g1/build.mjs`](deploy/g1/build.mjs)). To build by hand, pass both to `npm run -w packages/job-send-ui build:app`, then run `npm run build`.

The service reads its configuration from the process environment only; it does not load a `.env` file, so export every variable before starting it. Migrations run at boot, in order, once each.

Required: `HOST` (exact https origin), `DATABASE_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `RECEIPT_SIGNING_KEY` (Ed25519 PKCS#8 PEM), `CUSTODY_KEY` (32 random bytes, base64; seals Gmail refresh tokens with AES-256-GCM), `OWNER_APP_DIR=packages/job-send-ui/dist/owner-app` (the `build:app` output).
Optional: `PORT`, `ACCESS_LOG`, `SECRET_PATH_FALLBACK`, `REDIRECT_FALLBACKS`, `OWNER_APP_CONTACTS`, `DEFAULT_TEMPLATE_ID`, `JOB_PURPOSE`, `DEMO_RECIPIENTS` (an allowlist checked right before the provider call), `TYPESAFE_API_KEY` (the AI-review key), `AI_REVIEW_MODEL` (the AI-review provider defaults to and accepts only `jev-1.13.0`; an absent or different resolved response model makes review unavailable and holds the proposal). AI review was not configured in the historical live run.

Google Cloud project: enable the **Gmail API**; configure the OAuth consent screen in Testing mode and add each human as a test user; create an OAuth client with redirect URIs `HOST/auth/google/callback` and `HOST/auth/gmail/callback`; scopes `openid email` and `gmail.send`. Connect Gmail asks with `access_type=offline` and `prompt=consent`; the connected address comes from the verified ID token.

## Repository

| Path | What |
| --- | --- |
| `packages/job-send` | Contract types and reason codes, the gate, executor (render, reservation transaction, Gmail provider, sweeper, STOP), receipts and verify, OAuth server, MCP tools, owner API, Postgres stores and migrations |
| `packages/job-send-app` | The one process: config from the environment (problems reported by name, never value), `startService` |
| `packages/job-send-ui` | The owner app and the in-browser receipt verifier |
| `packages/grokbot` | Grok as a second agent client (experimental) |
| `demo/owner-local` | A local, synthetic owner UI for rehearsal; not the product |

CI on every PR: clean install, typecheck, the full suite with an embedded Postgres, and a commit-identity check. Merges are single-owner, with a non-author key on the exact head and two keys on the reservation transaction, the gate, token custody, the OAuth token endpoint and receipt signing.

## Security model, in one table

| Credential | Lives in | Valid at |
| --- | --- | --- |
| Owner session cookie | the owner's browser | the owner app and API |
| Agent access token | the client's connector storage | `/mcp` only; opaque, 1 h, hashed at rest |
| Google refresh token | our database, AES-256-GCM | Google; decrypted only inside the executor |
| Receipt signing key | deploy secret | nowhere external; the public key is pinned in the owner app |

Gmail credentials and the signing key remain server-side. Connection setup intentionally supplies an agent credential to its owner or authorized client; treat it as private. Receipts and AI-review content omit credentials. Access logs redact private connection paths. Grokbot raw-output redaction remains an open follow-up.

## What we say and never say

| Say | Never say |
| --- | --- |
| Provider accepted | Delivered |
| Outcome unknown. Do not resend. | Failed, retrying |
| Signature verified | Tamper-proof |
| Prohibited by your job: not approvable | Blocked (beside an Approve button) |
| AI-reviewed, may miss | Protected, guaranteed |
| One scripted run, our own test | Proven at scale |
