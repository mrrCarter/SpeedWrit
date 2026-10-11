// Executor and receipts lane: JCS and hashing, rendering and the version hash, token custody, the
// schema and the dispatch transactions, the Gmail provider, and signed receipts with the
// browser-safe verify library. src/index.ts re-exports this file.
export { JcsError, canonicalize, compareUtf16, isWellFormed, type JsonObject, type JsonPrimitive, type JsonValue } from "./jcs.js";
export { canonicalSha256Hex, sha256Hex } from "./hash.js";
export * from "./render/index.js";
export * from "./custody/index.js";
export * from "../receipts/index.js";
export { MIGRATIONS_DIR, migrate, readMigrations, type Migration } from "./db/migrate.js";
export { asExecutorTx, isUniqueViolation, newId, withTx, type ExecutorTx } from "./db/tx.js";
export {
  MAX_VERSIONS,
  NotFoundError,
  PROVIDER_TIMEOUT_MS,
  Refusal,
  SWEEP_AFTER_MS,
  createExecutor,
  parseDemoRecipients,
  type ApproveResult,
  type ConnectionRef,
  type Denial,
  type Executor,
  type ExecutorDeps,
  type PreparedVersion,
  type Reservation,
  type ResolveResult,
  type RevokeResult,
  type StoredVersion,
} from "./dispatch.js";
export { JOB_RECORD_SQL, authorityOf, authoritySha256, isoSeconds, type JobRecord } from "./jobs.js";
export { GMAIL_SEND_URL, GMAIL_TIMEOUT_MS, createGmailProvider, type GmailProviderOptions } from "./providers/gmail.js";
export { DEMO_RECAP_TEMPLATE, ensureSharedTemplate, type SharedTemplate } from "./templates.js";
