// Turns new receipts into Dial alert events for the local relay (server/dial-relay.mjs). The owner's rule:
// call about anything ambiguous, out of the ordinary, or outside the policy already defined. Labels are our own
// short words; no message text, addresses or ids leave the page.

import type { Engine } from "./domain/engine";
import type { Receipt } from "./domain/types";

export type AlertCategory = "ambiguous" | "out_of_policy" | "unusual";
export interface AlertItem {
  category: AlertCategory;
  label: string;
}

export function classify(r: Receipt): AlertItem | null {
  const reason = (r.reason ?? "").replace(/_/g, " ");
  switch (r.type) {
    case "PROPOSAL_HELD":
      return { category: "ambiguous", label: r.reason === "outside_scope" ? "a cleanup batch is held for approval" : "a message is held for your approval" };
    case "OUTCOME_UNKNOWN":
      return { category: "ambiguous", label: "a send has an unknown outcome" };
    case "PROPOSAL_DENIED":
      return { category: "out_of_policy", label: `an attempt was refused, ${reason}` };
    case "APPROVAL_REFUSED":
      return { category: "out_of_policy", label: `an approval was refused, ${reason}` };
    case "PARTIAL":
      return { category: "unusual", label: "a cleanup batch partly failed" };
    case "NOT_DONE":
      return { category: "unusual", label: `the provider did not complete it, ${reason}` };
    case "STOP_ENGAGED":
      return { category: "unusual", label: "STOP was engaged" };
    case "AGENT_REVOKED":
      return { category: "unusual", label: "an agent connection was revoked" };
    default:
      return null;
  }
}

/** Watches the live engine and posts each batch of new alertable receipts to the relay. */
export function startAlerts(engine: Engine, enabled: () => boolean): void {
  let seen = engine.getState().receipts.length;
  engine.subscribe(() => {
    const list = engine.getState().receipts;
    if (list.length < seen) seen = 0; // the demo was reset
    const fresh = list.slice(seen);
    seen = list.length;
    if (!enabled()) return;
    const items = fresh.map(classify).filter((x): x is AlertItem => x !== null);
    if (items.length === 0) return;
    void fetch("/dial/alert", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ items }) }).catch(() => undefined);
  });
}
