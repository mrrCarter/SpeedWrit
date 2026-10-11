import type { MailOutcome, MailProvider } from "../../contract/types.js";
import { gmailRaw } from "../render/mime.js";

// Gmail send-only (spec: "Gmail connection"): POST users/me/messages/send with {"raw": base64url},
// one attempt, a 20-second timeout, no retry at any layer. The access token comes from the
// injected function (custody decrypt and refresh in the executor process), stays in memory, and is
// never part of an outcome, an error class or a log line.
//
// Outcome mapping, from the spec's send_reserved:
//   2xx with a message id         -> accepted
//   400, 401, 403, 429            -> not_sent  (http_<status>)
//   anything else: other statuses, a timeout, a reset, a network error, 2xx without an id -> unknown
//   the access token cannot be had -> not_sent provider_auth (no request is made)

export const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
export const GMAIL_TIMEOUT_MS = 20_000;
const NOT_SENT_STATUSES = new Set([400, 401, 403, 429]);

export interface GmailProviderOptions {
  /** Returns a current access token for this connection. */
  accessToken: () => Promise<string>;
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export function createGmailProvider(options: GmailProviderOptions): MailProvider {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? GMAIL_TIMEOUT_MS;

  return {
    async send(bytes: Uint8Array): Promise<MailOutcome> {
      if (!(bytes instanceof Uint8Array)) throw new TypeError("MailProvider.send takes the stored MIME bytes");
      let token: string;
      try {
        token = await options.accessToken();
        if (typeof token !== "string" || token === "") throw new Error("empty token");
      } catch {
        return { status: "not_sent", errorClass: "provider_auth" };
      }

      let response: Response;
      try {
        response = await fetchImpl(GMAIL_SEND_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ raw: gmailRaw(bytes) }),
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "error",
        });
      } catch (error) {
        const name = (error as { name?: unknown } | null)?.name;
        return { status: "unknown", errorClass: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" };
      }

      if (response.status >= 200 && response.status < 300) {
        let id: unknown;
        try {
          id = ((await response.json()) as { id?: unknown } | null)?.id;
        } catch {
          id = undefined;
        }
        return typeof id === "string" && id !== ""
          ? { status: "accepted", providerMessageId: id }
          : { status: "unknown", errorClass: "accepted_without_id" };
      }
      // Drain the body so the connection is released; its content is not recorded.
      await response.body?.cancel().catch(() => undefined);
      if (NOT_SENT_STATUSES.has(response.status)) return { status: "not_sent", errorClass: `http_${response.status}` };
      return { status: "unknown", errorClass: `http_${response.status}` };
    },
  };
}
