# Read-only stable transport health checker

This checker makes public GETs only. It checks upstream DNS, the canonical owned OAuth/MCP readiness contract, and the exact expected JavaScript bundle and public receipt pin through both origins. It does not configure or repair infrastructure.

There are no runtime image, bundle or key defaults. Copy `deploy/transport-health/manifest.example.json` to a deployment-specific file and fill its placeholders from a reviewed deployment report and the packaged image. The example deliberately fails validation. Do not obtain the expected bundle hash from the same public response you are checking: that would only prove self-consistency. The packaged source is `/app/packages/job-send-ui/dist/owner-app/app.js`.

Record the full runtime Git revision, immutable image digest, packaged bundle SHA256 and public Ed25519 key metadata. The key ID must equal the first 16 hexadecimal SHA256 characters of the 32 raw public-key bytes. The manifest contains no tokens, cookies, private signing material or environment variables. Its schema rejects unknown fields. A new image requires a freshly attributed manifest even if its bundle bytes happen to be unchanged.

The canonical origin is fixed to `https://speedwrit.aidenid.com`. The upstream must be one explicit HTTPS origin with a single hostname label under `aidenid.com` or `trycloudflare.com`, with no port, credentials, path, query or fragment. That allowance does not prove a hostname is yours: confirm it separately in the reviewed operator plan. The example named upstream is proposed, not provisioned.

After review and authorization for actual read-only probes:

```text
node scripts/g1-transport-health.mjs --manifest DEPLOYMENT.json
node scripts/g1-transport-health.mjs --manifest DEPLOYMENT.json --pid 1234
```

The optional PID observation uses signal zero only. It reports alive, absent or unknown; it neither affects transport health nor proves the process is cloudflared. A healthy local process does not override DNS, edge HTTP, metadata, challenge or bundle failures. This checker does not probe localhost or read Docker state.

There are six HTTP GETs on success: four canonical readiness paths, canonical `/owner-app/app.js`, and upstream `/owner-app/app.js`. Upstream HTTP is skipped if its A/AAAA lookup fails. No advertised metadata URL is followed. Redirects, unexpected response URLs, non-JavaScript bundle content and oversized bodies fail closed. The fetch wrapper supplies only a fixed Accept header, omits credentials, disables caching and never retries. The CLI does not read Cloudflare credentials or private runtime configuration.

Each DNS, metadata or bundle operation has a maximum timeout of 10 seconds. Canonical probes run in parallel with DNS; the upstream bundle follows DNS, so total network time is bounded by approximately twice the configured timeout, plus local scheduling and file work. Metadata is limited to 64 KiB and bundles to 8 MiB, including decoded chunked bodies. The manifest is a bounded 16 KiB regular-file read. Error output contains fixed reason codes, status numbers, hashes, counts and timestamps, never response bodies, challenge strings, redirect URLs or exception messages.

The checker imports the repository's `scripts/g1-preflight.mjs`, pinned to the behavior at SpeedWrit revision `653d1571c109b95db27a0fd3247c5bfe03abb889`. Its SHA256 after replacing CRLF pairs with LF is `ba7b8dee1923ccb4a07b595a100cc7585d241f899e8ea99936ac9b913acf690f`. Only CRLF pairs are normalized: bare CR, whitespace, a BOM and all other bytes remain significant. The source is verified before import, so Windows CRLF and Linux LF checkouts share the same pin while a content change fails before any probe. Its successful canonical result contains 22 checks. Update this attribution deliberately if the canonical contract changes; no redundant vendor copy is maintained.

A healthy result establishes only the observed DNS answer, public contracts and expected bundle/pin. The image/revision fields are expected source attribution, not independently observed runtime identity. DNS answers do not prove the configured tunnel UUID or Cloudflare account/zone ownership, particularly behind proxied DNS. Separate operator checks must establish those facts, local app/PG identity, service configuration, metrics, connector restart recovery and host availability. Bundle pin presence is a packaging check, not an independent receipt signature verification. Readiness never establishes consent, authenticated tool execution, provider acceptance, delivery, phone behavior or a G1 gate pass.

Use results as an operator gate before and after a reviewed fixed Worker upstream change. Keep canonical HOST, OAuth callbacks, job/connection bindings and database unchanged. A rollback can select only a previously recorded upstream that is still healthy. The checker does not publish a Worker, restart a service, select a fallback, retry writes or infer an incident cause from PID observations.

Run offline tests (all networking is injected):

```text
node --test scripts/g1-transport-health.test.mjs scripts/g1-preflight.test.mjs
```

Fixtures exercise LF and CRLF imports and altered-source rejection before network access. They also cover DNS failure despite a live PID, canonical HTTP 530 despite an available upstream, bundle and key mismatch, stale issuer, challenge mismatch, redirects, unexpected origins, bounded declared/chunked/stalled responses, ignored abort signals and secret-free errors.
