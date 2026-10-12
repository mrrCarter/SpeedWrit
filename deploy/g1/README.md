# G1 deployment

Run commands from the repository root with Node 22 and npm 11. The service starts on port 8080, applies its bundled migrations before listening, and starts the outcome sweeper. Use the complete seed and preserve `packages/job-send/src/executor/db/migrations`; a service restart is not a read-only check.

Install dependencies before loading private build configuration:

```sh
npm ci
node --env-file=/absolute/private/writ-build.env deploy/g1/build.mjs
```

Keep that env file outside the repository. It supplies `RECEIPT_SIGNING_KEY`, an Ed25519 PKCS#8 PEM. The helper derives the raw 32-byte public key as `RECEIPT_PUBLIC_KEY_B64URL` and its SHA-256 prefix as `RECEIPT_KEY_ID`; it prints only those public values. Optional existing values must match. The helper builds the UI, then the service, and checks their output files, including the required owner-app `receipt-key.json`. Both manifest fields must match the derived public metadata; a missing, unreadable, malformed, or mismatched manifest fails the build with a fixed error code. Both child processes receive only OS/runtime variables and public receipt metadata. It neither installs dependencies nor starts or migrates the service.

If npm is not beside the Node executable and `npm_execpath` is unset, pass its installed JavaScript entrypoint explicitly:

```sh
node --env-file=/absolute/private/writ-build.env deploy/g1/build.mjs --npm-cli /absolute/path/to/npm/bin/npm-cli.js
```

For a container, set the two public environment variables from the helper's JSON, then build with the adjacent context filter:

```sh
docker build --file deploy/g1/Dockerfile --build-arg RECEIPT_KEY_ID --build-arg RECEIPT_PUBLIC_KEY_B64URL --tag speedwrit:g1 .
```

Only public metadata belongs in build arguments. Runtime signing, custody, database, and Google secrets are supplied separately. The image builds with Node 22/npm 11.6.1, retains the external job-send package and SQL migrations, and runs as `node`. The startup log's `receipt signing key` must match the image's public key ID; changing the signing key requires rebuilding the browser bundle. The Docker command above builds a local image; it does not push or deploy it.

[receipt-key.json](receipt-key.json) pins the G1 deployment's public verification key before its first receipt. Its `key_id` and `public_key_b64url` correspond to the two build variables above. Keep the private signing key outside the repository; a deliberate key rotation must update this pin and rebuild the browser bundle together.

The Azure templates target an existing resource group in two stages:

| Template | Inputs and result |
| --- | --- |
| [azure-infra.bicep](azure-infra.bicep) | `location`, `prefix`, `databaseAdminLogin`, and secure `databasePassword`. Creates the VNet, private PostgreSQL 16 database/DNS, Basic container registry, image-pull identity/AcrPull assignment, and Container Apps environment. Registry admin authentication and PostgreSQL public access are disabled. |
| [azure-app.bicep](azure-app.bicep) | Infra outputs `environmentId`, `environmentDomain`, `registryServer`, `pullIdentityId`; published `image`; `googleClientId`; nonempty `demoRecipients`; optional `location`, `appName`, `ownerAppContacts`, `jobPurpose`, `secretPathFallback`, and `redirectFallbacks`. Secure inputs are `databaseUrl`, `googleClientSecret`, `receiptSigningKey`, and `custodyKey`. Creates one HTTPS app with one replica and runtime secret references. |

Infra also returns `registryName`, `databaseHost`, and `databaseName`. Publish the image to that registry before deploying the app. Construct the private `databaseUrl` for those database outputs with `sslmode=verify-full` and correctly encoded credentials. `custodyKey` is 32 random bytes encoded as base64; `receiptSigningKey` must be the key used for the browser build. Store private deployment parameter files outside the repository; `@secure()` does not encrypt a local parameter file. Neither template outputs credentials. App outputs are `host` and `appId`.

The app computes `HOST` as `https://<appName>.<environmentDomain>`. Configure the Google OAuth client with exactly:

- `HOST/auth/google/callback`
- `HOST/auth/gmail/callback`

Enable sign-in scopes `openid email` and Gmail's `https://www.googleapis.com/auth/gmail.send`; add each human as a consent-screen test user. Connect ChatGPT to `HOST/mcp` using OAuth. `secretPathFallback` defaults to `off` and accepts only `off` or `on`; use `on` only for the agreed fallback flow. Secret-path URLs are credentials and stay out of logs, screenshots, and the repository. `redirectFallbacks` defaults to empty and accepts comma-separated exact callback URIs through the service's existing allowlist. For a separately authorized local Grok client, its callback is `http://127.0.0.1:8976/callback`; enable that value only when that client is needed.

Set `demoRecipients` to comma-separated owned test inboxes. It becomes the executor's `DEMO_RECIPIENTS` allowlist, in addition to each job's single-recipient restriction. The template trims the value and fails deployment if nothing remains; the service itself disables this allowlist for a blank value. Stage contacts are separate: `ownerAppContacts` supplies `OWNER_APP_CONTACTS` as a JSON array of `{ "name", "email", "company"? }` and defaults to an empty list. Coordinate that input with the stage seed owner before confirming the two-send demo job.

Once the HTTPS app is running, check its public discovery contract:

```sh
node scripts/g1-preflight.mjs --host https://your-app.example
```

This makes four unauthenticated GETs: both protected-resource metadata aliases, authorization-server metadata, and the `/mcp` 401 challenge. Output always includes `readiness_only: true` and `g1_pass: false`. A ready result does not prove owner consent, token exchange, Gmail connectivity, or delivery. G1 still needs a real client connection, an authorized send witnessed in the owned inbox, a wrong-client refusal before Gmail, and signed receipts for both decisions.

Compile and validate the templates against the selected Azure subscription before deploying. A successful local build or template compilation is not evidence of a live deployment. PostgreSQL, registry storage, and the always-running replica continue to incur charges until their resources are removed.
