/**
 * A job's expiry as the confirm screen shows it: in the owner's local time AND in UTC, so a demo across time zones
 * can't misread when the permission ends (spec: "Screens and UI copy", Confirm job).
 */
export function formatExpiry(iso: string, timeZone?: string): { local: string; utc: string } {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) throw new RangeError(`not a timestamp: ${iso}`);
  const options: Intl.DateTimeFormatOptions = {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  };
  return {
    local: new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(at),
    utc: new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(at),
  };
}
