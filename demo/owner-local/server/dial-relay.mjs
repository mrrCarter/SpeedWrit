// Local Dial alert relay for the SpeedWrit demo.
//
// The browser never sees the Dial key: the demo POSTs alert events here (through Vite's /dial proxy), and this
// process places the phone call. Voice only: Dial's SMS to regular phones needs 10DLC registration, which
// isn't available during the hackathon. Bursts are coalesced into at most ONE call per window, so a run of
// refusals rings once with a summary instead of once per event.
//
// Config comes from .env.local (gitignored): DIAL_API_KEY, DIAL_NUMBER (your Dial number or its id),
// ALERT_PHONE (E.164, e.g. +14155550123). Missing key or number, or DIAL_DRY_RUN=1: dry run, which logs the call.

import http from "node:http";
import { DialClient } from "@getdial/sdk";

const PORT = 5175;
const WINDOW_MS = 60_000;
const DEBOUNCE_MS = 8_000;
const KEY = process.env.DIAL_API_KEY?.trim() ?? "";
const FROM = process.env.DIAL_NUMBER?.trim() ?? "";
const TO = process.env.ALERT_PHONE?.trim() ?? "";
const E164 = /^\+[1-9]\d{7,14}$/;

const problems = [!KEY && "DIAL_API_KEY missing", !FROM && "DIAL_NUMBER missing", !E164.test(TO) && "ALERT_PHONE missing or not E.164", process.env.DIAL_DRY_RUN === "1" && "DIAL_DRY_RUN=1"].filter(Boolean);
const live = problems.length === 0;
const dial = live ? new DialClient({ apiKey: KEY }) : null;
const mask = (n) => (n.length > 4 ? `•••${n.slice(-4)}` : n ? "•••" : "");

const CATEGORIES = new Set(["ambiguous", "out_of_policy", "unusual", "test"]);
const SPOKEN = {
  ambiguous: ["needs your decision", "need your decision"],
  out_of_policy: ["was refused by policy", "were refused by policy"],
  unusual: ["was out of the ordinary", "were out of the ordinary"],
  test: ["is a test alert", "are test alerts"],
};
let pending = [];
let timer = null;
let lastCallAt = 0;
let lastCall = null;

// Only our own short labels reach the voice prompt: letters, digits and simple punctuation, bounded.
const clean = (s) => String(s ?? "").replace(/[^A-Za-z0-9 _.,:'-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);

function summary(items) {
  const by = new Map();
  for (const it of items) by.set(it.category, [...(by.get(it.category) ?? []), it.label]);
  return [...by.entries()]
    .map(([cat, labels]) => {
      const uniq = [...new Set(labels)].slice(0, 3);
      const one = labels.length === 1;
      return `${labels.length} ${one ? "event" : "events"} ${SPOKEN[cat][one ? 0 : 1]}: ${uniq.join("; ")}`;
    })
    .join(". ");
}

function instruction(text) {
  return [
    "You are SpeedWrit's notification caller for Aman. You only deliver this notice.",
    "You cannot approve, send, delete or change anything, and you must never ask for or accept passwords, codes, or personal or payment details.",
    `When the person answers, say: "Hi, this is SpeedWrit for Aman. ${text}. Please review it in the SpeedWrit owner app; nothing on this call can approve anything."`,
    "Answer only questions about this notice, in one short sentence, and end the call within 60 seconds.",
  ].join(" ");
}

async function flush() {
  timer = null;
  if (pending.length === 0) return;
  const wait = lastCallAt + WINDOW_MS - Date.now();
  if (wait > 0) {
    timer = setTimeout(flush, wait);
    return;
  }
  const items = pending;
  pending = [];
  lastCallAt = Date.now();
  const text = summary(items);
  if (!live) {
    lastCall = { at: new Date().toISOString(), ok: true, mode: "dry_run", events: items.length, said: text };
    console.log(`[dial dry-run] would call ${mask(TO)}: ${text}`);
    return;
  }
  try {
    const call = await dial.makeCall({ to: TO, fromNumber: FROM, outboundInstruction: instruction(text) });
    lastCall = { at: new Date().toISOString(), ok: true, mode: "live", callId: call.id, events: items.length, said: text };
    console.log(`[dial] call ${call.id} placed to ${mask(TO)} (${items.length} event(s))`);
  } catch (err) {
    // Never echo the key or the full number; the class of failure is enough to act on.
    lastCall = { at: new Date().toISOString(), ok: false, mode: "live", events: items.length, error: clean(err?.status ? `http_${err.status}` : err?.name ?? "error") };
    console.log(`[dial] call failed: ${lastCall.error}`);
  }
}

function queue(items) {
  pending.push(...items);
  if (!timer) timer = setTimeout(flush, DEBOUNCE_MS);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 16_384) reject(new Error("too_large"));
      else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("bad_json"));
      }
    });
  });
}

const send = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

http
  .createServer(async (req, res) => {
    const origin = req.headers.origin;
    if (origin && origin !== "http://127.0.0.1:5174") return send(res, 403, { error: "origin" });
    const path = (req.url ?? "").replace(/^\/dial/, "") || "/";
    try {
      if (req.method === "GET" && path === "/status") {
        return send(res, 200, { mode: live ? "live" : "dry_run", problems, to: mask(TO), from: mask(FROM), windowSeconds: WINDOW_MS / 1000, pending: pending.length, lastCall });
      }
      if (req.method === "POST" && (path === "/alert" || path === "/test")) {
        const body = path === "/test" ? { items: [{ category: "test", label: "SpeedWrit alerts are connected" }] } : await readJson(req);
        const items = (Array.isArray(body.items) ? body.items : [])
          .filter((it) => it && CATEGORIES.has(it.category))
          .slice(0, 50)
          .map((it) => ({ category: it.category, label: clean(it.label) || "event" }));
        if (items.length === 0) return send(res, 400, { error: "no_items" });
        queue(items);
        return send(res, 202, { queued: items.length, mode: live ? "live" : "dry_run" });
      }
      return send(res, 404, { error: "not_found" });
    } catch (err) {
      return send(res, 400, { error: clean(err?.message) });
    }
  })
  .listen(PORT, "127.0.0.1", () => {
    console.log(`dial relay on http://127.0.0.1:${PORT} · ${live ? `LIVE → ${mask(TO)}` : `dry run (${problems.join(", ")})`}`);
  });
