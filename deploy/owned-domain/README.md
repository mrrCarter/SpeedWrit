# Owned-domain app transport

This Worker serves SpeedWrit at `https://speedwrit.aidenid.com`. `/` redirects to
`/owner-app/#/connect` on that same origin. Public information pages import the
repository's reviewed static module; app assets, OAuth, MCP and owner APIs use an
explicit route allowlist and the fixed retained tunnel upstream.

The transport preserves request method, body, Origin, authorization, cookies and
MCP headers. It streams backend responses, preserves separate `Set-Cookie` values,
CSP and authentication headers, and returns external redirects without following
them. Requests bypass caching; responses use `no-store, no-transform`. Failed
requests are not retried. The Worker stores no application credentials or state
and does not log request bodies, authorization values or callback queries.

The checked-in account ID and custom-domain configuration are public identifiers.
Credentials belong in the operator's private Wrangler login, never in this directory.
Workers previews and observability are disabled. Only the named account, Worker
and domain are intended deployment targets.

## Local validation

After the repository's normal dependency install:

```sh
node deploy/owned-domain/build.mjs
node --test deploy/owned-domain/transport.test.mjs
```

Tests use stub fetch implementations and synthetic credentials. They do not call
Google, Gmail, Dial, Jev or the live upstream. This establishes local forwarding
semantics, not a successful live connection or provider action.

## Canonical-origin cutover

Publish only the exact reviewed checkout, with Wrangler pointed at this
directory's `wrangler.jsonc`; do not rewrite imports or create an unreviewed copy.
Record the commit, source/config/imported-module hashes and Worker version. The
separate backend keeps its reviewed image, database, signing key and custody key.

Before coordinated publication and runtime cutover, save both authorized Google
redirects, `/auth/google/callback` and `/auth/gmail/callback`, under the owned
origin. Set backend `HOST=https://speedwrit.aidenid.com`. The Worker deliberately
does not repair mismatched Origin or OAuth resource values.

Browser sessions use `__Host-` cookies, so sign in on the owned domain. Existing
stored owner/Gmail state remains in the database. Restart any old-origin pending
Google authorization flow. OAuth clients need fresh consent for the owned MCP
resource; a new agent connection does not inherit jobs bound to an older agent.
Historical receipts retain their original runtime and connection attribution.

The retained tunnel is still the fixed transport upstream, so its availability
remains required. Coordinate a quiet cutover and preserve the previous Worker
version and backend container. If backend rollback restores the previous HOST,
the owned-origin write flow will fail closed until its matching Worker/runtime
configuration is restored. Never restore or rewrite production data to change
the public hostname.

After cutover, independently verify owned metadata/issuer/resource, unauthenticated
MCP challenges, app bundle and receipt pin, browser-profile analytics suppression,
Google sign-in/cookies and fresh OAuth consent. Do not claim these live checks
from the local transport test suite.
