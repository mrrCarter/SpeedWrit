# @writ/job-send

Job-bound sending: an agent sends email only inside a job its owner confirmed. Code decides what
is allowed; anything outside the job is refused before it reaches the provider, gray areas wait
for the owner's approval of one exact version, and every decision writes a signed receipt.

The design is the SpeedHacks build spec (Oct 10, 2026). This package holds the proven parts so a
new service can copy them whole.

## Layout

Each lane adds files only under its own folders.

| Folder | Lane | What |
| --- | --- | --- |
| `src/contract/` | Contract | Shared types, `ReasonCode`, and the frozen interfaces: `MailProvider.send`, `gate`, `dispatch_auto`, `approve`, `writeReceipt` |
| `src/gate/`, `src/mcp/` | Contract | The gate checks and the MCP tools with OAuth |
| `src/db/`, `src/executor/`, `src/render/`, `src/receipts/`, `src/custody/`, `src/providers/` | Executor | Schema, reservation transaction, rendering and hashing, signed receipts, token custody, Gmail |
| `src/ai-review/`, `tests/acceptance/` | Acceptance | The AI-review adapter, its calibration set, and acceptance cases A1-A20 |

Owner screens live in `packages/job-send-ui`, so this package carries no UI dependencies.

## Rules

- A non-author approves any change to the reservation transaction, the gate, token custody, the
  OAuth token endpoint or receipt signing.
- Tests run on Linux and Windows. Race cases (double approve, last slot, a kill between reserve
  and result) run against real Postgres with concurrent connections.
- No secret is ever serialized to MCP output, a receipt, a log or an AI-review request.

## Commands

```sh
npm run -w packages/job-send build
npm run -w packages/job-send test
```
