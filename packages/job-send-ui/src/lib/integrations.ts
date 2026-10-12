export type DialStatus = "unconfigured" | "disabled" | "calling" | "unknown" | "queued" | "failed" | "ready";
export type DialResult = "accepted" | "unknown" | "failed";

export interface IntegrationMetadata {
  jev: { configured: boolean; model: string };
  dial: {
    configured: boolean;
    live: boolean;
    enabled: boolean;
    status: DialStatus;
    pending: number;
    last_result: { at: string; status: DialResult } | null;
  };
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const malformed = (): never => { throw new Error("unconfirmed_integration_response"); };
const STATUSES: readonly unknown[] = ["unconfigured", "disabled", "calling", "unknown", "queued", "failed", "ready"];
const RESULTS: readonly unknown[] = ["accepted", "unknown", "failed"];

/** Return only the public fields the UI understands; never carry unknown response values into the page. */
export function parseIntegrationMetadata(value: unknown): IntegrationMetadata {
  if (!record(value) || !record(value.jev) || !record(value.dial)) return malformed();
  const { jev, dial } = value;
  if (typeof jev.configured !== "boolean" || typeof jev.model !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(jev.model) ||
      typeof dial.configured !== "boolean" || typeof dial.live !== "boolean" || typeof dial.enabled !== "boolean" ||
      !STATUSES.includes(dial.status) || !Number.isSafeInteger(dial.pending) || (dial.pending as number) < 0 ||
      (dial.enabled && (!dial.configured || !dial.live))) return malformed();
  const last = dial.last_result;
  if (last !== null && (!record(last) || typeof last.at !== "string" || last.at.length > 40 ||
      !Number.isFinite(Date.parse(last.at)) || !RESULTS.includes(last.status))) return malformed();
  return {
    jev: { configured: jev.configured, model: jev.model },
    dial: {
      configured: dial.configured, live: dial.live, enabled: dial.enabled,
      status: dial.status as DialStatus, pending: dial.pending as number,
      last_result: last === null ? null : { at: last.at as string, status: last.status as DialResult },
    },
  };
}

export function parseAlertPreference(value: unknown): { enabled: boolean } {
  if (!record(value) || typeof value.enabled !== "boolean") return malformed();
  return { enabled: value.enabled };
}

export function parseAlertTest(value: unknown): { queued: true } {
  if (!record(value) || value.queued !== true) return malformed();
  return { queued: true };
}
