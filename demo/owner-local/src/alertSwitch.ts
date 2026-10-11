// The owner's on/off switch for phone alerts, remembered in this browser only.
const KEY = "speedwrit.alerts";

export function alertsEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function setAlertsEnabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // Storage blocked: the switch still applies for this page load via the caller's state.
  }
}
