/**
 * Every phrase the owner screens show about an outcome, from the build spec's "Say / Never say" table. One place,
 * so a test can check every rendered screen against NEVER_SAY.
 */
export const SAY = {
  providerAccepted: "Provider accepted",
  witnessed: "Witnessed",
  outcomeUnknown: "Outcome unknown. Do not resend.",
  /** A request failure is not a recorded provider outcome; inspect receipts before acting again. */
  requestUnconfirmed: "We could not confirm the request result. Check the job's Flight Recorder before repeating an action.",
  agentConnectionCreated: "Agent connection created. Sending still requires a job you approve.",
  agentConnectionRevoked: "Agent connection revoked.",
  agentConnectionUnavailable: "Secret URL setup is unavailable on this server. Connect the agent using OAuth instead.",
  agentConnectionUnconfirmed: "We could not confirm the connection request result. Refresh Connections to inspect its current status before repeating an action.",
  agentConnectionRevocationUnconfirmed: "Revocation is unconfirmed. Refresh Connections to inspect this connection's status before repeating an action.",
  agentConnectionNoneActive: "No active agent connection was found. The connection URL is no longer shown.",
  agentConnectionStillActive: "This agent connection is still active. Revocation has not been confirmed.",
  resolveSeen: "I see it",
  resolveNotArrived: "It did not arrive",
  resolvedNotArrived: "You said it did not arrive. It still counts as a send, because it may only be late or in spam.",
  signatureVerified: "Signature verified",
  signatureInvalid: "Signature invalid",
  /** Not a result: the verify library could not run here (no WebCrypto Ed25519), so nothing was checked. */
  notChecked: "Not checked: this browser could not run the check",
  prohibited: "Prohibited by your job: not approvable",
  aiReviewed: "AI-reviewed, may miss",
  evidenceReady: "Evidence ready to inspect",
  routes: "Observed routes, unresolved routes",
  aiReview: "AI review",
  notSent: "Not sent",
} as const;

/**
 * Phrases no owner screen may render: each claims more than SpeedWrit can know ("Delivered", "tamper-proof"), or names
 * the AI-review vendor instead of saying "AI review".
 */
export const NEVER_SAY = [
  "Delivered",
  "Failed, retrying",
  "Verified true",
  "tamper-proof",
  "Blocked",
  "Protected",
  "secure",
  "guaranteed",
  "Investigation done",
  "100% routed",
  "fully covered",
  "Jev",
  "TypeSafe",
] as const;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The NEVER_SAY phrases present in `text`, matched as whole words, ignoring case. */
export function findNeverSay(text: string): string[] {
  return NEVER_SAY.filter((phrase) => new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(phrase)}($|[^A-Za-z0-9])`, "i").test(text));
}
