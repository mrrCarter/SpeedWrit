import type { Contact } from "../lib/frontDoor";

/** What the app server serves at /owner-app/config.json (serve/ownerApp.ts), and the owner app reads at start. */
export type OwnerAppConfig = {
  jobDefaults: { templateId: string; purpose: string; autoSend: boolean };
  contacts: Contact[];
  /** Machine's Connect Gmail route, as a same-site path. */
  connectGmailHref: string;
  timeZone?: string;
};

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Browser-side shape check before any screen consumes a config response. */
export function isOwnerAppConfig(value: unknown): value is OwnerAppConfig {
  if (!record(value)) return false;
  const { jobDefaults, contacts, connectGmailHref, timeZone } = value;
  if (!record(jobDefaults) || typeof jobDefaults.templateId !== "string" || jobDefaults.templateId === "" || typeof jobDefaults.purpose !== "string" || typeof jobDefaults.autoSend !== "boolean") return false;
  if (!Array.isArray(contacts) || !contacts.every((contact) => record(contact) && typeof contact.name === "string" && typeof contact.email === "string" && (contact.company === undefined || typeof contact.company === "string"))) return false;
  if (typeof connectGmailHref !== "string" || !connectGmailHref.startsWith("/") || connectGmailHref.startsWith("//")) return false;
  if (timeZone !== undefined) {
    if (typeof timeZone !== "string") return false;
    try {
      new Intl.DateTimeFormat("en", { timeZone });
    } catch {
      return false;
    }
  }
  return true;
}
