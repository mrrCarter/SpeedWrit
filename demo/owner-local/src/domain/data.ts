// Synthetic, deterministic seed data. Every name, company and address is invented; addresses use the
// reserved .test TLD (RFC 2606) so nothing here can ever reach a real inbox.

import type { CleanupJob, Contact, Email, EmailLabel, SendJob, State } from "./types";

export const DAY = 86_400_000;
export const HOUR = 3_600_000;

/** 13:00 PT on Oct 11, 2026: the demo's clock starts here and only moves when the owner advances it. */
export const START = Date.parse("2026-10-11T20:00:00Z");

export const OWNER = { name: "Aman", email: "aman@speedwrit.test" };

export const CONTACTS: Contact[] = [
  { id: "dana", name: "Dana Reyes", company: "Acme", email: "dana@acme.test" },
  { id: "bo", name: "Bo Lindqvist", company: "Birch", email: "bo@birch.test" },
];

export const CLEANUP_JOB_ID = "job_cleanup";
export const SEND_JOB_ID = "job_recap_dana";
export const MAX_PER_BATCH = 10;

export const RECAP_TEMPLATE = {
  id: "tpl_recap",
  subject: "Recap: {{topic}}",
  body: "Hi {{first_name}},\n\nThanks for the call about {{topic}}.\n\nRecap: {{recap}}\n\nBest,\nAman",
  fields: { topic: { max: 80 }, recap: { max: 600 } },
} as const;

const BRANDS = [
  "Northwind Outfitters",
  "Lumen Coffee Club",
  "Parcel & Pine",
  "Orbit Fitness",
  "Kestrel Travel",
  "Copperleaf Books",
  "Harbor Home Goods",
  "Saffron Table",
  "Quill & Co",
  "Tidepool Swim",
  "Nimbus Audio",
];

const PROMO_SUBJECTS = [
  "48 hours only: 30% off everything",
  "Your cart misses you",
  "New arrivals just landed",
  "Members save more this week",
  "Last chance: free shipping ends tonight",
  "We picked these for you",
  "Flash sale starts now",
  "Your exclusive code is inside",
];

const NEWSLETTERS: [string, string][] = [
  ["Bright Ledger Weekly", "This week in small-business finance"],
  ["The Async Review", "Five essays on remote work"],
  ["Field Notes Digest", "Trail reports and gear picks"],
  ["Commit Log", "What shipped in open source this week"],
];

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function pick<T>(list: readonly T[], i: number): T {
  return list[i % list.length] as T;
}

export function seedEmails(): Email[] {
  const out: Email[] = [];
  let n = 0;
  const add = (e: Omit<Email, "id" | "state">) => {
    n += 1;
    out.push({ ...e, id: `m${String(n).padStart(2, "0")}`, state: "inbox" });
  };
  const promo = (i: number, ageDays: number, starred = false) => {
    const brand = pick(BRANDS, i);
    add({
      fromName: brand,
      fromEmail: `deals@${slug(brand)}.test`,
      subject: pick(PROMO_SUBJECTS, i),
      snippet: `${brand} · Unsubscribe anytime. Offer details inside.`,
      label: "Promotions",
      receivedAt: START - ageDays * DAY,
      starred,
      contactId: null,
    });
  };
  // m01-m22: old promotions. In the cleanup job's scope.
  for (let i = 0; i < 22; i += 1) promo(i, 35 + i * 3);
  // m23-m28: recent promotions. Outside the age rule, so a batch with them is held for the owner.
  for (let i = 0; i < 6; i += 1) promo(i + 3, 2 + i * 3);
  // m29-m36: old newsletters. In scope.
  for (let i = 0; i < 8; i += 1) {
    const [name, subject] = pick(NEWSLETTERS, i);
    add({
      fromName: name,
      fromEmail: `hello@${slug(name)}.test`,
      subject: `${subject} (#${112 + i})`,
      snippet: "Read online · Manage preferences",
      label: "Newsletters",
      receivedAt: START - (40 + i * 5) * DAY,
      starred: false,
      contactId: null,
    });
  }
  // m37-m39: old promotions the owner starred. Protected.
  for (let i = 0; i < 3; i += 1) promo(i + 7, 60 + i * 10, true);
  // m40-m42: mail from contacts. Protected.
  const danaOrBo: [string, string, string][] = [
    ["dana", "Re: onboarding call notes", "Thanks Aman, the pilot Monday works for us."],
    ["dana", "Kickoff time?", "Could we find a slot later this week?"],
    ["bo", "Birch renewal questions", "Two quick questions about the renewal terms."],
  ];
  danaOrBo.forEach(([id, subject, snippet], i) => {
    const c = CONTACTS.find((x) => x.id === id) as Contact;
    add({ fromName: c.name, fromEmail: c.email, subject, snippet, label: "Primary", receivedAt: START - (3 + i * 20) * DAY, starred: false, contactId: c.id });
  });
  // m43-m46: old receipts. Wrong label for the job: held, never auto-deleted.
  for (let i = 0; i < 4; i += 1) {
    const brand = pick(BRANDS, i + 5);
    add({
      fromName: brand,
      fromEmail: `orders@${slug(brand)}.test`,
      subject: `Your receipt #${40211 + i}`,
      snippet: "Order summary · Keep this for your records",
      label: "Receipts",
      receivedAt: START - (45 + i * 7) * DAY,
      starred: false,
      contactId: null,
    });
  }
  // m47-m48: old account updates. Wrong label.
  for (let i = 0; i < 2; i += 1) {
    add({
      fromName: "Account Security",
      fromEmail: "no-reply@accounts.test",
      subject: i === 0 ? "New sign-in on a Mac" : "Your password was changed",
      snippet: "If this was you, no action is needed.",
      label: "Updates",
      receivedAt: START - (50 + i * 9) * DAY,
      starred: false,
      contactId: null,
    });
  }
  return out;
}

export const PRIMARY_CONNECTION_ID = "ac_primary";

/** The sample setup: one OAuth agent, the stage send job and the inbox-cleanup lab job, both bound to it. */
export function sampleJobs(): [CleanupJob, SendJob] {
  return [
    {
      kind: "cleanup",
      id: CLEANUP_JOB_ID,
      title: "Inbox cleanup",
      purpose: "Clear out old promotions and newsletters.",
      maxPerBatch: MAX_PER_BATCH,
      labels: ["Promotions", "Newsletters"] satisfies EmailLabel[],
      minAgeDays: 30,
      expiresAt: START + 8 * HOUR,
      agentConnectionId: PRIMARY_CONNECTION_ID,
      policyVersion: 1,
    },
    {
      kind: "send",
      id: SEND_JOB_ID,
      title: "Tuesday recap to Dana",
      purpose: "Send Dana a recap of our call.",
      recipient: "dana@acme.test",
      templateId: RECAP_TEMPLATE.id,
      maxSends: 2,
      sendsReserved: 0,
      allowCustom: true,
      // 23:59 PT tonight.
      expiresAt: Date.parse("2026-10-12T06:59:00Z"),
      agentConnectionId: PRIMARY_CONNECTION_ID,
      policyVersion: 1,
    },
  ];
}

/**
 * "fresh" matches the live host before setup: Gmail connected, no agent, no jobs.
 * "sample" adds one OAuth agent and the two sample jobs, for the edge cases and quick exploring.
 */
export function seedState(seed: "fresh" | "sample" = "sample"): State {
  return {
    rev: 0,
    clock: START,
    connection: { account: OWNER.email, scopes: ["gmail.send", "userinfo.email", "openid"], dispatchEnabled: true, status: "active" },
    agentConnections:
      seed === "sample" ? [{ id: PRIMARY_CONNECTION_ID, label: "ChatGPT-SpeedWrit", kind: "oauth", createdAt: START, lastUsedAt: null, revoked: false }] : [],
    contacts: CONTACTS.map((c) => ({ ...c })),
    emails: seedEmails(),
    jobs: seed === "sample" ? sampleJobs() : [],
    proposals: [],
    dispatches: [],
    receipts: [],
    nextFault: "ok",
    providerCalls: 0,
    operations: {},
    agentLog: [],
  };
}

export function ageDays(e: Email, now: number): number {
  return Math.floor((now - e.receivedAt) / DAY);
}
