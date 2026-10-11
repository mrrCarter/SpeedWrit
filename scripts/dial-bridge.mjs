#!/usr/bin/env node
// Node 22+. Calls the owner through the local Dial relay (demo/owner-local, `npm run dial`) when something
// on the live SpeedWrit database needs a human: a held version waiting for approval, an agent attempt the
// job refused, an UNKNOWN send outcome, or a refused approval. Read-only: the connection runs with
// default_transaction_read_only=on and only SELECTs. It sends short labels, never an address, subject or body,
// and starts from the newest row, so history is not replayed. The relay decides dry run vs live call.
//
// Usage (on the host, next to the app):
//   DATABASE_URL=... OWNER_ID=own_... node scripts/dial-bridge.mjs          # poll every 5 s, one owner's events
//   DATABASE_URL=... OWNER_ID=own_... node scripts/dial-bridge.mjs --once   # one pass from the start of today
// Events are marked seen only after the relay accepts them, so a relay error retries them on the next poll.
// Optional: DIAL_RELAY_URL (default http://127.0.0.1:5175), POLL_MS (default 5000).
import { pathToFileURL } from "node:url";

const RECEIPT_ALERTS = {
  ATTEMPT_DENIED: "out_of_policy",
  OUTCOME_UNKNOWN: "unusual",
  APPROVAL_REFUSED: "unusual",
};

const words = (code) => String(code ?? "").replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();

/** One alert item per new row: a category the relay knows and a short, content-free label. */
export function alertItems(receipts, heldVersions) {
  const items = [];
  for (const r of receipts) {
    const category = RECEIPT_ALERTS[r.type];
    if (!category) continue;
    let reason = "";
    try {
      const detail = JSON.parse(r.payload).detail ?? {};
      reason = words(detail.reason_code ?? detail.reason ?? "");
    } catch {
      reason = "";
    }
    const what =
      r.type === "ATTEMPT_DENIED" ? "An agent attempt" : r.type === "OUTCOME_UNKNOWN" ? "A send outcome" : "An approval";
    items.push({ category, label: reason ? `${what}, ${reason}` : what });
  }
  for (const v of heldVersions) items.push({ category: "ambiguous", label: `A held draft, version ${Number(v.version) || 1}` });
  return items;
}

async function main() {
  const url = process.env.DATABASE_URL;
  const owner = process.env.OWNER_ID?.trim();
  if (!url || !owner) {
    console.error("DATABASE_URL and OWNER_ID (the own_... id whose phone the relay rings) are required");
    process.exit(2);
  }
  const relay = (process.env.DIAL_RELAY_URL ?? "http://127.0.0.1:5175").replace(/\/+$/, "");
  const pollMs = Math.max(1000, Number(process.env.POLL_MS) || 5000);
  const once = process.argv.includes("--once");
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: 1, options: "-c default_transaction_read_only=on" });
  pool.on("error", (err) => console.error(`[dial-bridge] pool error: ${err.code ?? err.name}`));

  const start = once
    ? new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z")
    : (await pool.query("SELECT COALESCE(max(created_at), now()) AS t FROM receipts WHERE owner_id = $1", [owner])).rows[0].t;
  let since = start;
  const seen = new Set();
  console.log(`[dial-bridge] watching owner ${owner} from ${new Date(since).toISOString()} -> ${relay} (read-only)`);

  // The relay takes at most 50 items per request. Returns true only when every chunk was accepted (2xx), or the
  // owner switched alerts off (409 paused: those events are dropped on purpose, not retried later).
  const post = async (items) => {
    for (let i = 0; i < items.length; i += 50) {
      const chunk = items.slice(i, i + 50);
      try {
        const res = await fetch(`${relay}/alert`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ items: chunk }),
          signal: AbortSignal.timeout(5000),
        });
        const answer = await res.json().catch(() => ({}));
        console.log(`[dial-bridge] ${chunk.length} event(s) -> relay ${res.status} ${answer.mode ?? answer.error ?? ""}`);
        if (res.status === 409) return true;
        if (!res.ok) return false;
      } catch (err) {
        console.error(`[dial-bridge] relay unreachable (${err.name}); will retry ${items.length - i} event(s)`);
        return false;
      }
    }
    return true;
  };

  const tick = async () => {
    const receipts = (
      await pool.query(
        "SELECT id, type, payload, created_at FROM receipts WHERE owner_id = $1 AND created_at > $2 AND type = ANY($3) ORDER BY created_at",
        [owner, since, Object.keys(RECEIPT_ALERTS)],
      )
    ).rows.filter((r) => !seen.has(r.id));
    const held = (
      await pool.query(
        `SELECT v.id, v.version, v.created_at FROM proposal_versions v
           JOIN proposals p ON p.id = v.proposal_id JOIN jobs j ON j.id = p.job_id
          WHERE j.owner_id = $1 AND v.created_at > $2 AND v.state = 'pending' AND cardinality(v.review_reasons) > 0
          ORDER BY v.created_at`,
        [owner, since],
      )
    ).rows.filter((v) => !seen.has(v.id));
    const items = alertItems(receipts, held);
    // Advance only after the relay accepted, so a relay error retries these events on the next poll.
    if (items.length > 0 && !(await post(items))) return;
    for (const row of [...receipts, ...held]) {
      seen.add(row.id);
      if (row.created_at > since) since = row.created_at;
    }
  };

  if (once) {
    await tick();
    await pool.end();
    return;
  }
  for (;;) {
    try {
      await tick();
    } catch (err) {
      console.error(`[dial-bridge] poll failed: ${err.code ?? err.name}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
