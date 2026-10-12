// Owner-opted-in notifications from committed receipts, never from browser-supplied events.
// No message, recipient, contact, receipt payload or credential enters a voice instruction/log.
import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool, PoolClient } from "pg";
import type { AppHandler, OwnerSessions } from "@writ/job-send/server";
import type { AppConfig } from "./config.js";

export type DialResult = "accepted" | "unknown" | "failed";
export type DialCaller = (attemptId: string, signal: AbortSignal) => Promise<DialResult>;
const CALL_URL = "https://api.getdial.ai/api/v1/calls";
const WINDOW_MS = 60_000;
const DEBOUNCE_MS = 8_000;
const ELIGIBLE = `((r.type IN ('PROPOSAL_CREATED','PROPOSAL_REVISED') AND p.status='pending'
  AND p.current_version=(r.payload::jsonb->>'version')::int AND v.state='pending'
  AND cardinality(v.review_reasons)>0) OR
  (r.type='OUTCOME_UNKNOWN' AND d.status='unknown' AND d.witness IS NULL))`;
const RECEIPT_JOINS = `LEFT JOIN proposals p ON p.id=r.payload::jsonb->>'proposal'
  LEFT JOIN proposal_versions v ON v.proposal_id=p.id AND v.version=p.current_version
  LEFT JOIN dispatches d ON d.proposal_version_id=v.id`;

/** Contract from @getdial/sdk 0.41.1 makeCall. One request, bounded, no retry. */
export function createDialCaller(config: AppConfig["dial"], fetchImpl: typeof fetch = fetch): DialCaller {
  return async (attemptId, signal) => {
    if (!config.live || !config.apiKey || !config.fromNumber || !config.phone || !config.ownerId) return "failed";
    try {
      const response = await fetchImpl(CALL_URL, {
        method: "POST", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json", "Idempotency-Key": attemptId },
        body: JSON.stringify({ to: config.phone, fromNumber: config.fromNumber, maxCallDurationSeconds: 60,
          outboundInstruction: "You are SpeedWrit's notification caller. Say only: SpeedWrit has an item for your attention. Open your SpeedWrit owner app to review it. This call cannot approve, send, delete or change anything. Never request passwords, codes, payment details or personal information. End the call after this notice." }),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return response.status >= 400 && response.status < 500 && response.status !== 408 ? "failed" : "unknown";
      }
      const answer = await response.json() as { call?: { id?: unknown } };
      return typeof answer?.call?.id === "string" && answer.call.id.length > 0 ? "accepted" : "unknown";
    } catch { return "unknown"; }
  };
}

type Options = {
  pool: Pool; host: string; owners: Pick<OwnerSessions, "owner">;
  dial: AppConfig["dial"]; jev: { configured: boolean; model: string };
  call: DialCaller; pollMs?: number; now?: () => number;
};
class Refusal extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}
function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(value));
}
async function input(req: IncomingMessage): Promise<Record<string, unknown>> {
  if ((req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() !== "application/json") throw new Refusal("json_only", 415);
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1024) throw new Refusal("too_large", 413);
    chunks.push(chunk as Buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new Refusal("invalid", 400); }
}

export function createOwnerAlerts(options: Options) {
  const { pool, dial } = options;
  const now = options.now ?? Date.now;
  const configured = Boolean(dial.apiKey && dial.fromNumber && dial.ownerId && dial.phone);
  let paused = true, generation = 0, closing = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | null = null;
  let controller: AbortController | null = null;
  let workerFailed = false;
  let controls: Promise<unknown> = Promise.resolve();
  function control<T>(action: () => Promise<T>): Promise<T> {
    // Preserve the order of overlapping owner toggles and STOP, including across DB waits.
    const result = controls.then(action);
    controls = result.catch(() => undefined);
    return result;
  }

  async function transaction<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await pool.connect();
    try { await c.query("BEGIN"); const result = await work(c); await c.query("COMMIT"); return result; }
    catch (error) { await c.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { c.release(); }
  }
  const maxSeq = async (c: PoolClient, owner: string) => Number((await c.query("SELECT COALESCE(MAX(seq),0) AS seq FROM receipts WHERE owner_id=$1", [owner])).rows[0].seq);
  async function cancel(c: PoolClient, owner: string) {
    await c.query("UPDATE owner_alert_outbox SET status='cancelled',finished_at=clock_timestamp() WHERE owner_id=$1 AND status='queued'", [owner]);
  }
  async function setEnabled(owner: string, enabled: boolean) {
    if (owner !== dial.ownerId) throw new Refusal("not_found", 404);
    if (enabled && (!configured || !dial.live)) throw new Refusal("not_configured");
    // Synchronous cancellation wins over any worker awaiting its reservation commit.
    const epoch = ++generation;
    if (!enabled) paused = true;
    await control(() => transaction(async (c) => {
      await c.query("INSERT INTO owner_alert_preferences(owner_id) VALUES($1) ON CONFLICT DO NOTHING", [owner]);
      await c.query("SELECT owner_id FROM owner_alert_preferences WHERE owner_id=$1 FOR UPDATE", [owner]);
      await cancel(c, owner);
      await c.query("UPDATE owner_alert_preferences SET enabled=$2,cursor_seq=$3,updated_at=clock_timestamp() WHERE owner_id=$1", [owner, enabled, await maxSeq(c, owner)]);
    }));
    if (generation === epoch) paused = !enabled;
    return preference(owner);
  }
  async function disableForStop(owner: string) {
    if (owner !== dial.ownerId) return;
    paused = true; generation++;
    await control(() => transaction(async (c) => {
      await c.query("SELECT owner_id FROM owner_alert_preferences WHERE owner_id=$1 FOR UPDATE", [owner]);
      await c.query("UPDATE owner_alert_preferences SET enabled=false,updated_at=clock_timestamp() WHERE owner_id=$1", [owner]);
      await cancel(c, owner);
    }));
  }
  async function preference(owner: string) {
    const row = (await pool.query("SELECT enabled FROM owner_alert_preferences WHERE owner_id=$1", [owner])).rows[0];
    return { enabled: owner === dial.ownerId && configured && dial.live && row?.enabled === true && !paused };
  }
  async function metadata(owner: string) {
    const matches = owner === dial.ownerId;
    const pref = await preference(owner);
    const queue = matches ? (await pool.query("SELECT COUNT(*) FILTER (WHERE status='queued') AS n,BOOL_OR(status='attempted') AS uncertain FROM owner_alert_outbox WHERE owner_id=$1", [owner])).rows[0] : null;
    const pending = Number(queue?.n ?? 0);
    const last = matches ? (await pool.query("SELECT status,finished_at FROM owner_alert_outbox WHERE owner_id=$1 AND status IN ('accepted','unknown','failed') ORDER BY finished_at DESC LIMIT 1", [owner])).rows[0] : null;
    return { jev: options.jev, dial: { configured: matches && configured, live: matches && dial.live, enabled: pref.enabled,
      status: !matches || !configured ? "unconfigured" : !pref.enabled ? "disabled" : controller ? "calling" : queue?.uncertain ? "unknown" : pending ? "queued" : workerFailed ? "failed" : last?.status === "unknown" ? "unknown" : last?.status === "failed" ? "failed" : "ready",
      pending, last_result: last ? { at: new Date(last.finished_at).toISOString(), status: last.status } : null } };
  }
  async function queueTest(owner: string) {
    await transaction(async (c) => {
      const pref = (await c.query("SELECT enabled FROM owner_alert_preferences WHERE owner_id=$1 FOR UPDATE", [owner])).rows[0];
      if (owner !== dial.ownerId || !configured || !dial.live || paused || pref?.enabled !== true) throw new Refusal("alerts_disabled");
      await c.query("INSERT INTO owner_alert_outbox(id,owner_id,kind,due_at) VALUES($1,$2,'test',$3)", [randomUUID(), owner, new Date(now())]);
    });
    return { queued: true };
  }

  async function work() {
    if (closing || !configured || !dial.live || !dial.ownerId) return;
    const owner = dial.ownerId;
    const epoch = generation;
    const attempt = await transaction(async (c): Promise<string | null> => {
      const pref = (await c.query("SELECT * FROM owner_alert_preferences WHERE owner_id=$1 FOR UPDATE", [owner])).rows[0];
      if (!pref || !pref.enabled || paused) { await cancel(c, owner); return null; }
      const receipts = (await c.query(`SELECT r.seq,r.type,${ELIGIBLE} AS eligible
        FROM receipts r ${RECEIPT_JOINS}
        WHERE r.owner_id=$1 AND r.seq>$2 ORDER BY r.seq LIMIT 500`, [owner, pref.cursor_seq])).rows;
      if (receipts.some((r) => r.type === "STOP_ENGAGED")) {
        paused = true; generation++;
        await c.query("UPDATE owner_alert_preferences SET enabled=false,cursor_seq=$2 WHERE owner_id=$1", [owner, receipts.at(-1).seq]);
        await cancel(c, owner); return null;
      }
      for (const receipt of receipts) {
        if (receipt.eligible === true) {
          await c.query("INSERT INTO owner_alert_outbox(id,owner_id,receipt_seq,kind,due_at) VALUES($1,$2,$3,'attention',$4) ON CONFLICT(owner_id,receipt_seq) DO NOTHING", [randomUUID(), owner, receipt.seq, new Date(now()+DEBOUNCE_MS)]);
        }
      }
      if (receipts.length) await c.query("UPDATE owner_alert_preferences SET cursor_seq=$2 WHERE owner_id=$1", [owner, receipts.at(-1).seq]);
      // The owner may have approved/resolved it while the notice was coalescing.
      await c.query(`UPDATE owner_alert_outbox o SET status='cancelled',finished_at=clock_timestamp()
        WHERE o.owner_id=$1 AND o.status='queued' AND o.receipt_seq IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM receipts r ${RECEIPT_JOINS}
          WHERE r.owner_id=o.owner_id AND r.seq=o.receipt_seq AND ${ELIGIBLE})`, [owner]);
      // STOP state is checked again even when its receipt is beyond this bounded page.
      const { active, stopped } = (await c.query(`SELECT
        EXISTS(SELECT 1 FROM connections WHERE owner_id=$1 AND status='active' AND dispatch_enabled) AS active,
        EXISTS(SELECT 1 FROM receipts WHERE owner_id=$1 AND seq>$2 AND type='STOP_ENGAGED') AS stopped`, [owner,pref.cursor_seq])).rows[0];
      if (stopped) {
        paused = true; generation++;
        await c.query("UPDATE owner_alert_preferences SET enabled=false WHERE owner_id=$1", [owner]);
        await cancel(c, owner); return null;
      }
      // A fresh owner opt-in and explicit test are independent of Gmail connectivity.
      // Automatic notices still need Gmail; STOP and Off above cancel both kinds.
      if (!active) await c.query("UPDATE owner_alert_outbox SET status='cancelled',finished_at=clock_timestamp() WHERE owner_id=$1 AND status='queued' AND kind='attention'", [owner]);
      if (pref.last_attempt_at && now()-new Date(pref.last_attempt_at).getTime()<WINDOW_MS) return null;
      const ready = (await c.query("SELECT 1 FROM owner_alert_outbox WHERE owner_id=$1 AND status='queued' AND due_at<=$2 LIMIT 1", [owner,new Date(now())])).rowCount;
      if (!ready) return null;
      const id = randomUUID();
      // Commit the attempt before any external call. An interrupted attempt is never retried.
      await c.query("UPDATE owner_alert_outbox SET status='attempted',attempt_id=$2 WHERE owner_id=$1 AND status='queued'", [owner,id]);
      await c.query("UPDATE owner_alert_preferences SET last_attempt_at=$2 WHERE owner_id=$1", [owner,new Date(now())]);
      return id;
    });
    if (!attempt) return;
    if (closing || paused || generation !== epoch) {
      await pool.query("UPDATE owner_alert_outbox SET status='cancelled',finished_at=clock_timestamp() WHERE owner_id=$1 AND attempt_id=$2 AND status='attempted'", [owner,attempt]);
      return;
    }
    controller = new AbortController();
    let result: DialResult;
    try { result = await options.call(attempt, controller.signal); }
    catch { result = "unknown"; }
    finally { controller = null; }
    if (!["accepted","unknown","failed"].includes(result)) result = "unknown";
    await pool.query("UPDATE owner_alert_outbox SET status=$3,finished_at=clock_timestamp() WHERE owner_id=$1 AND attempt_id=$2 AND status='attempted'", [owner,attempt,result]);
  }
  async function tick() {
    if (running) return running;
    running = work().then(() => { workerFailed=false; }, () => { workerFailed=true; }).finally(() => { running=null; });
    return running;
  }
  async function start() {
    const owner = dial.ownerId;
    if (owner) await transaction(async (c) => {
      const pref = (await c.query("SELECT enabled FROM owner_alert_preferences WHERE owner_id=$1 FOR UPDATE", [owner])).rows[0];
      if (!pref) return;
      // Skip historical events and pending stale notices after every process start.
      await c.query("UPDATE owner_alert_preferences SET cursor_seq=$2 WHERE owner_id=$1", [owner,await maxSeq(c,owner)]);
      await cancel(c,owner);
      await c.query("UPDATE owner_alert_outbox SET status='unknown',finished_at=clock_timestamp() WHERE owner_id=$1 AND status='attempted'", [owner]);
      paused = !(configured && dial.live && pref.enabled);
    });
    if (configured && dial.live) { timer=setInterval(() => { void tick(); },options.pollMs??2000); timer.unref(); }
  }
  const handle: AppHandler = async (req,res) => {
    const path=new URL(req.url??"/",options.host).pathname;
    if (!["/owner/integrations","/owner/alerts/preferences","/owner/alerts/test"].includes(path)) return false;
    try {
      const owner=await options.owners.owner(req);
      if (!owner) throw new Refusal("sign_in",401);
      if (path==="/owner/integrations" && req.method==="GET") send(res,200,await metadata(owner.id));
      else {
        if (owner.id!==dial.ownerId) throw new Refusal("not_found",404);
        if (path==="/owner/alerts/preferences" && req.method==="GET") send(res,200,await preference(owner.id));
        else if (req.method==="POST" && path!=="/owner/integrations") {
          if (req.headers.origin!==options.host) throw new Refusal("origin",403);
          const body=await input(req);
          if (path.endsWith("preferences")) {
            if (Object.keys(body).length!==1 || typeof body.enabled!=="boolean") throw new Refusal("invalid",400);
            send(res,200,await setEnabled(owner.id,body.enabled));
          } else {
            if (Object.keys(body).length!==0) throw new Refusal("invalid",400);
            send(res,202,await queueTest(owner.id));
          }
        } else throw new Refusal("method_not_allowed",405);
      }
    } catch (error) { send(res,error instanceof Refusal?error.status:500,{error:error instanceof Refusal?error.code:"server_error"}); }
    return true;
  };
  return { handle,start,tick,disableForStop, async stop() { closing=true;paused=true;generation++;if(timer)clearInterval(timer);controller?.abort();await running;await controls; } };
}
