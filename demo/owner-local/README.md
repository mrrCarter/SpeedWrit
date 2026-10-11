# SpeedWrit owner app: local demo

A standalone, browser-only demo of the SpeedWrit owner experience, for rehearsal and edge-case exploration without the live host. Everything is synthetic: `.test` addresses, an in-memory engine, no network, no server. It imports nothing from `packages/*` and is outside the npm workspaces, so the root install, build and CI are unaffected.

```sh
cd demo/owner-local
npm ci
npm run dev        # http://127.0.0.1:5174
npm test           # 47 edge cases and failure modes
npm run typecheck
npm run build
```

Node 22 or newer.

## What it shows

The owner app's navigation, in its order: **Connections · New job · Waiting for you · Jobs · Verify**, plus a separate **Test lab**.

- **Connections:** Gmail account and scopes, a Gmail call counter, STOP sending and Reconnect. Agent connections show label, type (OAuth or fallback, never mixed up), MCP address, last used, and Revoke. Connect ChatGPT over OAuth (consent with Allow/Deny), or create a fallback secret connection URL, shown once, then hidden.
- **New job:** the type-a-sentence front door (`only email Dana` · `two sends max` · `expires tonight` · `ask me before custom wording`), then Confirm with Never / Ask me / Runs without asking. Without the approval line, custom wording is refused rather than held.
- **Waiting for you:** held versions with their diff, plus "Approving binds version vN · hash". A stale version is refused as superseded. An UNKNOWN outcome offers *I see it arrived* / *It did not arrive*. "Did not arrive" records the observation and keeps the send slot (#49159). Nothing resends.
- **Jobs:** each job with its Flight Recorder: authority, decisions, provider results. Refusals show "Gmail not called". Provider acceptance and the owner's delivery witness are separate receipts. Controlled tests are labeled.
- **Verify:** recomputes a receipt's hash, checks its Ed25519 signature (WebCrypto; ECDSA P-256 where Ed25519 is missing) and its chain link. Change one byte and it fails.
- **ChatGPT panel (simulated):** the demo prompts as chips, each a real tool call into the local gate (`list_jobs`, `propose_send`, `revise_proposal`), plus a "More tests…" menu.
- **Test lab:** clock, a next-provider-call fault picker (controlled tests), Start fresh / Load sample setup, the edge-case runner (Run all; Replay a case into the live demo), and **Labs · inbox cleanup**, an owner rule of at most 10 deletions per batch, one batch at a time. Labs is outside the MVP.

## Not the product

This is a model of the spec's behavior, not the service. The gate, reservation, receipts and OAuth that ship are in `packages/job-send`, `job-send-ui` and `job-send-app`. Nothing here is a live pass.
