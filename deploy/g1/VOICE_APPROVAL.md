# Exact-draft phone decisions

Phone decisions are a separate authority channel, off by default. Existing generic Dial notices,
test calls, UNKNOWN alerts, and historical calls cannot approve or reject a message. They remain
content-free notifications. When the configured owner explicitly enables phone decisions, future
committed held drafts get a dedicated call for one immutable proposal version. This replaces the
generic draft notice for that owner; it does not combine several drafts into one decision. If a
readback is too long and no call was attempted, a separately opted-in generic notice remains
available. Uncertain or placed calls do not produce a fallback redial.

The owner authorizes the controller of the configured phone to decide. This is not biometric
identity verification: a shared or forwarded phone can be answered by someone else. Dial receives
the recipient, exact subject/body, and voice responses, and processes/transcribes the conversation.
SpeedWrit stores the transcript hash and signed decision provenance, not raw transcript text.
Dial's own retention applies to its records. The ordinary authenticated browser approval remains.

## Contract

- `GET /owner/voice/preferences` returns `configured`, `eligible_owner`, `enabled`, and
  `disclosure_version: "voice-approval-v1"`. GET writes nothing; enabled is effective authority.
- `POST /owner/voice/preferences` requires the owner session and exact canonical Origin. Enable
  accepts `{ "enabled": true, "disclosure_version": "voice-approval-v1" }`; disable accepts
  `{ "enabled": false }`. The response has the same complete shape as GET. Only the configured
  owner can enable it. Enabling starts at the current receipt cursor and makes no historical call.
  Consent binds the configured owner, destination phone, source number and disclosure version.
  Changing that configuration requires a fresh explicit opt-in; saved consent is not transferred.
- `POST /owner/voice/calls` optionally requests a current held draft with `proposal_id`, `version`,
  `shown_sha256`, and `disclosure_version`. It deduplicates on the immutable version; an uncertain
  or completed attempt is never redialed by retrying this request.
- `GET /owner/voice/calls?proposal_id=...` returns at most five session statuses and version hashes
  for that owner. It returns no phone number, provider call ID, token, transcript or instruction.
- `POST /integrations/dial/voice/events` accepts a signed `call.transcribed` event. It does not use
  browser cookies as authorization. The edge must allow exactly this callback path plus the two
  owner paths above. No general owner API or MCP authority is exposed to Dial.

## Decision protocol

A server-generated 256-bit token, exact version hash, owner, configured phone hash and short expiry
are committed before one call request. Only token/instruction hashes are stored. The provider call
ID and source-number hash must be confirmed by the response. An ambiguous placement is never
automatically retried. A session is cancelled across a restart, not replayed.

The voice agent reads the complete recipient, subject and body as data, then asks Allow or Deny.
After a clear answer it reads back that choice and asks for `confirm allow` or `confirm deny`.
The server checks timed, role-separated transcript turns; only user turns after the complete
readback can decide. The supported first responses include “allow”, “yes, go ahead and send it”,
“I approve this exact message”, “deny” and “do not send this message”. This is deliberately bounded
recognition, not an arbitrary-language approval classifier. Conditional, contradictory, partial,
interrupted, transferred or unconfirmed responses make no decision. Long messages that cannot fit
the bounded readout remain for browser review.

The voice agent says only that the decision was recorded and checks are pending. It never promises
provider acceptance or delivery. A signed callback is checked over the exact raw bytes, within a
five-minute timestamp window, with matching event identity. Only the saved call ID is retrieved
from the fixed Dial API origin; callback URLs are never followed. The returned outbound call,
numbers, managed runtime, instruction hash, token and completed transcript must all match.

The executor then locks the proposal/version/job/connection, preference and session. It checks
opt-in, expiry, token consumption, current version/state and the existing STOP/capacity/integrity
rules inside the same transaction as approval and reservation. A valid refused response is also
consumed. Signed APPROVAL_GRANTED, APPROVAL_REJECTED or APPROVAL_REFUSED records name the phone
channel, call ID, session and transcript hash. The existing one-send dispatch path runs afterward.

## Deployment prerequisites and rollback

This feature needs a reviewed eight-migration image; migration `0008_voice_decisions.sql` is
additive. After applying it, a seven-migration image refuses the database. Roll back with an
eight-migration-capable image and `DIAL_VOICE_LIVE=0`; do not restore an old production database.

Keep existing server-only Dial credentials and configured owner/phone. Add `DIAL_VOICE_LIVE=1`
and a private `DIAL_WEBHOOK_SECRET` only after review. An operator must create a provider webhook
subscription for `call.transcribed` pointing at the canonical callback above, and privately save
its signing secret. This code does not create subscriptions, import secrets, enable preferences,
or place setup calls. The callback currently accepts only `call.transcribed`, not dashboard ping.

Use a fresh owner opt-in and fresh held draft for the first controlled live proof. Stub tests prove
local handling, not that the managed voice agent will reproduce the exact readback/transcript.
Missing or differently rendered provider fields fail closed. A genuine end-to-end call must verify
that contract before claiming voice approval works live. Existing approved messages and old calls
must never be replayed to demonstrate it.

Primary provider contracts:

- [Managed call request](https://docs.getdial.ai/api-reference/rest-api/calls/make-call)
- [Signed webhook format](https://docs.getdial.ai/documentation/platform/webhooks)
- [Call transcript retrieval](https://docs.getdial.ai/api-reference/rest-api/calls/get-call)
- [Transcript event](https://docs.getdial.ai/documentation/cli/listen-service)
- [Context MCP scope limits](https://docs.getdial.ai/documentation/platform/context-mcp)

Context MCP's documented number/direction headers do not include a call ID. Its account-level
credential is shared across calls, so it is not used as an owner approval channel here.
