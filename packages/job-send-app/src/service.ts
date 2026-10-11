// The SpeedWrit job-send service, wired: one process and one Postgres (spec: "one standalone service in
// the event repo: web UI, owner API, MCP endpoint, executor"). Every decision lives in the lanes'
// modules; this file only connects them, in the order the spec's handler list gives:
//   owner sign-in, Connect Gmail, the owner API, the owner app, then the agent connection.
// It never logs a token or a secret path; configuration problems were already refused by name.

import { createServer, type Server } from "node:http";

import pg from "pg";

import {
  aiReview,
  createExecutor,
  createTokenCustody,
  custodyKeyFromSecret,
  DEMO_RECAP_TEMPLATE,
  ensureSharedTemplate,
  exportRawPublicKey,
  migrate,
  newId,
  parseDemoRecipients,
  receiptKeyId,
} from "@writ/job-send";
import {
  createApp,
  createGmailConnect,
  createGmailTokens,
  createGoogleJwks,
  createJobSendHandler,
  createMcpBackend,
  createOwnerApi,
  createOwnerAuth,
  createOwnerCore,
  GMAIL_CONNECT_PATH,
  PgOAuthStore,
  PgOwnerStore,
  PgSecretPaths,
} from "@writ/job-send/server";
import { renderConsentHtml } from "@writ/job-send-ui/consent-html";
import { serveOwnerApp } from "@writ/job-send-ui/serve";

import type { AppConfig } from "./config.js";

export type Service = {
  server: Server;
  /** The receipt signing key's id, also logged at boot: the owner app's verify page must be built with the same key. */
  receiptKeyId: string;
  /** Stops the sweeper, closes the server and ends the pool. */
  stop(): Promise<void>;
};

export type ServiceOptions = {
  /** A pool to use instead of one from DATABASE_URL (tests). The service then leaves it open on stop. */
  pool?: pg.Pool;
  /** Injected for tests (Google's token, JWKS and revoke endpoints); defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** The boot line, then one line per answered request; secret paths are already redacted. */
  log?: (line: string) => void;
  onError?: (error: unknown) => void;
};

/** Builds the whole service on a migrated database. The caller listens on `server`. */
export async function startService(config: AppConfig, options: ServiceOptions = {}): Promise<Service> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const onError = options.onError ?? ((error: unknown) => console.error(error instanceof Error ? error.stack ?? error.message : String(error)));
  const log = options.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  const ownPool = options.pool === undefined;
  const pool = options.pool ?? new pg.Pool({ connectionString: config.databaseUrl, max: 20 });
  // An idle client whose backend dies (a Postgres restart, a network blip) makes the pool emit "error";
  // unhandled, that event exits the process. An injected pool belongs to the caller.
  if (ownPool) pool.on("error", onError);
  // Started partway through: a failure after it (an owner app built for another key) must stop it too.
  let stopSweeper: (() => void) | undefined;
  try {
    // A public key id, not a secret: compare it with build:app's "key <id>" line, or every receipt on the
    // owner app's verify page reads "Signature invalid".
    const keyId = receiptKeyId(exportRawPublicKey(config.receiptSigningKey));
    log(`receipt signing key ${keyId}`);
    await migrate(pool);
    const template = config.defaultTemplateId ?? (await ensureSharedTemplate(pool, DEMO_RECAP_TEMPLATE)).id;

    const google = config.google;
    const jwks = createGoogleJwks(fetchImpl, () => Math.floor(Date.now() / 1000));
    const custody = createTokenCustody(custodyKeyFromSecret(config.custodyKey));
    const tokens = createGmailTokens({ pool, custody, google, fetchImpl });
    const executor = createExecutor({
      pool,
      signingKey: config.receiptSigningKey,
      mailProviderFor: tokens.mailProviderFor,
      revoke: tokens.revoke,
      demoRecipients: parseDemoRecipients(config.demoRecipients),
    });
    stopSweeper = executor.startSweeper(undefined, onError);

    const ownerAuth = createOwnerAuth({ host: config.host, google, store: new PgOwnerStore(pool), fetchImpl, jwks, onError });
    const gmail = createGmailConnect({ host: config.host, google, pool, executor, custody, owners: ownerAuth, fetchImpl, jwks, onError });
    const oauthStore = new PgOAuthStore(pool);
    const secretPaths = config.secretPathFallback ? new PgSecretPaths(pool) : undefined;

    const core = createOwnerCore({ pool, executor, mcpUrl: `${config.host}/mcp`, defaultTemplateId: template });
    const ownerApi = createOwnerApi({ host: config.host, owners: ownerAuth, core, oauthStore, secretPaths, onError });
    const ownerApp = serveOwnerApp({
      dir: config.ownerAppDir,
      config: {
        jobDefaults: { templateId: template, purpose: config.jobPurpose, autoSend: true },
        contacts: config.contacts,
        connectGmailHref: GMAIL_CONNECT_PATH,
      },
      // An app built for another receipt key would call every receipt "Signature invalid": refuse to start.
      receiptKeyId: keyId,
    });

    const backend = createMcpBackend({
      pool,
      executor,
      review: (input) => aiReview(input, { apiKey: config.aiReviewKey ?? undefined }),
    });
    const agent = createJobSendHandler({
      host: config.host,
      store: oauthStore,
      backend,
      redirectFallbacks: config.redirectFallbacks,
      secretPaths,
      onError,
      authorize: {
        owners: ownerAuth,
        renderConsent: renderConsentHtml,
        // One agent connection per grant (spec), with AGENT_CONNECTED in the same transaction.
        createAgentConnection: (ownerId, clientId, clientLabel) =>
          executor.withTx(ownerId, async (tx) => {
            const id = newId("ac");
            await tx.client.query("INSERT INTO agent_connections (id, owner_id, client_id, client_label) VALUES ($1, $2, $3, $4)", [
              id,
              ownerId,
              clientId,
              clientLabel,
            ]);
            await executor.writeReceipt(tx, "AGENT_CONNECTED", { agent_connection: id, client_label: clientLabel, detail: { client_id: clientId } });
            return id;
          }),
      },
    });

    const handler = createApp({
      handlers: [ownerAuth.handle, gmail.handle, ownerApi, ownerApp],
      agent,
      log: config.accessLog ? log : undefined,
      onError,
    });
    const server = createServer((req, res) => void handler(req, res));
    return {
      server,
      receiptKeyId: keyId,
      async stop() {
        stopSweeper?.();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        if (ownPool) await pool.end();
      },
    };
  } catch (error) {
    stopSweeper?.();
    if (ownPool) await pool.end().catch(() => undefined);
    throw error;
  }
}
