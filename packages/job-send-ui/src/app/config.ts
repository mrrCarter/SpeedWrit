import type { Contact } from "../lib/frontDoor";

/** What the app server serves at /owner-app/config.json (serve/ownerApp.ts), and the owner app reads at start. */
export type OwnerAppConfig = {
  jobDefaults: { templateId: string; purpose: string; autoSend: boolean };
  contacts: Contact[];
  /** Machine's Connect Gmail route, as a same-site path. */
  connectGmailHref: string;
  timeZone?: string;
};
