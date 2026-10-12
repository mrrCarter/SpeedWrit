// The owner's on/off switch for phone alerts. One in-memory value is the truth for both the checkbox and the
// event watcher; localStorage only remembers it across reloads. If storage can't be read, alerts start OFF
// (the safe choice: no call the owner didn't ask for). Turning alerts off also tells the relay to drop any
// call it has queued but not yet placed.

const KEY = "speedwrit.alerts";
let current: boolean | null = null;
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return false;
  }
}

export function alertsEnabled(): boolean {
  if (current === null) current = read();
  return current;
}

export function setAlertsEnabled(on: boolean): void {
  // Memory first, so the watcher honours the choice even when persisting it fails.
  current = on;
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // Not remembered across reloads, but it applies for this page.
  }
  for (const fn of listeners) fn();
  syncRelay(on);
}

export function subscribeAlerts(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Pause or resume the relay so an "off" also cancels anything queued in its debounce or cooldown window. */
export function syncRelay(on: boolean): void {
  if (typeof location === "undefined") return; // not in a browser (tests)
  void fetch(on ? "/dial/resume" : "/dial/pause", { method: "POST" }).catch(() => undefined);
}

/** Test hook: forget the in-memory value so the next read goes back to storage. */
export function resetAlertsForTest(): void {
  current = null;
}
