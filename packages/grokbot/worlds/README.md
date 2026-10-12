# Local Sparta runner

This optional Grok runner operates Sparta Worlds' local ticket connector through function tools. It consumes only the public task and connector observations; it does not read the world seed, hidden checks, or scripted answer agents. Custom mission IDs work without a lookup table. It leaves the existing remote-MCP client, application server, and frontend unchanged.

The supported contract is `sparta_worlds@0.9.0-beta.5`'s `customer-desk` or `team-inbox` starter: `WORLDS_TASK_JSON` (or JSON on stdin), `WORLDS_BASE_URL`, and `WORLDS_API_KEY`. The connector must use a numeric loopback HTTP origin with an explicit port. Native Worlds profiles with different Zendesk bindings are not supported by this entrypoint.

Four tools read tickets, read comments, and update status/priority/tags/comment visibility. Paths are fixed; there is no arbitrary URL, admin, shell, billing, or email tool. A ticket must be read before it can be updated. Writes use stable idempotency keys, repeated identical writes reuse the first result, and an uncertain write stops the run without retry. Ticket policy is evaluated by Worlds; this adapter does not hardcode Dana, Bo, ticket IDs, or a job allowlist.

Each run permits at most 12 model steps, 32 tool calls, 120 seconds, and bounded task/response/context sizes. Tool batches are validated before execution, call IDs cannot be replayed, redirects are refused, and errors use fixed codes. The model receives no connector credential. The provider key is sent only to the fixed `https://api.x.ai/v1/responses` endpoint. There are no automatic retries or alternate model endpoints. Responses use `store:false`, explicit function tools, and full conversation input; see the [xAI function-calling contract](https://docs.x.ai/developers/tools/function-calling).

## Local verification, with no model key

Run the focused tests from the repository root with Node 22 or newer:

```sh
node --test packages/grokbot/tests/worlds.test.mjs
```

Create the world using `sparta/README.md` (PR48's world generator), then invoke the installed Worlds CLI with Node 24, telemetry off, and this deliberately scripted fixture:

```sh
WORLDS_TELEMETRY=0 DO_NOT_TRACK=1 worlds starters run \
  --project /absolute/path/speedwrit-world --all --runs 1 \
  --evidence /new/path/protocol-fixture.json \
  -- node /absolute/path/SpeedWrit/packages/grokbot/worlds/protocol-fixture.mjs
```

The fixture uses the production function loop and connector adapter. Its expected ticket comes from the public mission prompt. A passing grade proves the local protocol wiring and fixture behavior only. It is **not model-backed evidence**, does not measure Grok's quality, and does not prove SpeedWrit job enforcement or Gmail delivery. The world has no email connector; its D4 comment-count rule is also not currently graded. Inspect final world state/request evidence instead of treating the agent's reply as proof.

## Explicit model run

Only an operator intending to make paid model calls should set all of the following in a private environment outside the repository:

- `WORLDS_MODEL_PROVIDER=xai`
- `WORLDS_MODEL` to the exact model selected for the run
- `XAI_API_KEY` to that operator's private provider key
- `WORLDS_ALLOW_PAID=1`

Invoke the same Worlds command with `worlds/cli.mjs` instead of `worlds/protocol-fixture.mjs`. The CLI emits only its final reply on stdout and count-only metrics on stderr. Keep evidence private until reviewed: world evidence can contain synthetic ticket text and the agent's reply. The provider receives the public mission and synthetic connector observations; do not seed this world with production inbox data. A model run is not part of CI and never happens automatically.

This runner does not expose a local SpeedWrit MCP server to a remote provider and cannot call the production service. Combining Worlds grading with a separately authorized local stub-mail SpeedWrit instance would be a distinct integration, not an existing capability of this ticket runner.
