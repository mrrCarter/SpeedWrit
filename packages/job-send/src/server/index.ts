// The HTTP server, as its own entry point ("@writ/job-send/server"), so the package root stays
// free of node:http and the MCP SDK for the owner screens that import it.
export {
  createJobSendHandler,
  createJobSendServer,
  type AuthorizeOptions,
  type ConsentView,
  type JobSendHttpOptions,
  type McpBackend,
  type Owner,
  type OwnerSessions,
  type SendOutcome,
} from "./http.js";
export { createApp, createAppServer, redactPath, type AppHandler, type AppOptions } from "./app.js";
export { SECRET_PATH_CLIENT_ID, createSecretPath, InMemorySecretPaths, SECRET_PATH } from "./secret-path.js";
export {
  approvalAnswer,
  createOwnerApi,
  OWNER_BODY_SCHEMAS,
  OWNER_ERROR_FIELDS,
  OWNER_ERRORS,
  OwnerError,
  type JobDraftInput,
  type OwnerApiOptions,
  type OwnerCore,
  type OwnerErrorCode,
  type OwnerErrorField,
} from "./owner-api.js";
export { PgOAuthStore, PgSecretPaths, type PgPoolLike, type PgQueryable } from "./pg-store.js";
export { InMemoryOAuthStore, type IssuedTokens, type OAuthStore, type PendingAuthorization, type StoredClient } from "./store.js";
export {
  createOwnerAuth,
  InMemoryOwnerStore,
  safeReturnTo,
  readCookie,
  hostCookie,
  SIGN_IN_PATH,
  SIGN_IN_CALLBACK_PATH,
  SIGN_OUT_PATH,
  SESSION_COOKIE,
  SIGN_IN_COOKIE,
  SESSION_TTL_SECONDS,
  SIGN_IN_TTL_SECONDS,
  type OwnerAuth,
  type OwnerAuthOptions,
  type OwnerStore,
  type PendingSignIn,
} from "../owner/signin.js";
export {
  GOOGLE_AUTHORIZATION_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  GOOGLE_JWKS_URI,
  GOOGLE_ISSUERS,
  SIGN_IN_SCOPES,
  ID_TOKEN_SKEW_SECONDS,
  googleClientConfigFromEnv,
  googleAuthorizationUrl,
  exchangeGoogleCode,
  createGoogleJwks,
  verifyGoogleIdToken,
  pkceChallenge,
  GoogleAuthError,
  type FetchLike,
  type GoogleClientConfig,
  type GoogleIdentity,
  type GoogleJwks,
  type GoogleTokens,
} from "../owner/google.js";
export { DENIALS_PER_HOUR, createMcpBackend, type BackendOptions } from "../executor/backend.js";
export {
  MAX_JOB_DAYS,
  MAX_SENDS_LIMIT,
  OwnerRefusal,
  createOwnerCore,
  type ExecutorOwnerCore,
  type JobDraftRequest,
  type OwnerCoreOptions,
  type OwnerRefusalReason,
} from "../executor/owner.js";
export {
  ACCESS_TOKEN_MARGIN_SECONDS,
  GOOGLE_REVOKE_ENDPOINT,
  GmailTokenError,
  TOKEN_FETCH_TIMEOUT_MS,
  createGmailTokens,
  type GmailTokens,
  type GmailTokensOptions,
} from "../executor/gmail-tokens.js";
export {
  GMAIL_CALLBACK_PATH,
  GMAIL_CONNECT_COOKIE,
  GMAIL_CONNECT_PATH,
  GMAIL_CONNECT_SCOPES,
  GMAIL_CONNECT_TTL_SECONDS,
  GMAIL_CONNECTS_PER_OWNER,
  GMAIL_SEND_SCOPE,
  createGmailConnect,
  type GmailConnect,
  type GmailConnectOptions,
} from "../owner/gmail-connect.js";
export { PgOwnerStore } from "../owner/pg-store.js";
