// Exactly one RFC 5322 addr-spec, restricted to the dot-atom form: no display name, no quoted
// local part, no comments, no group syntax, no IP-literal domain, ASCII only. A comma, semicolon,
// angle bracket, space, CR or LF can never appear, so a string that passes holds one address.

const DOT_ATOM_LOCAL = /^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+)*$/;
const DOMAIN_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
/** Visible ASCII, U+0021..U+007E: an addr-spec never holds a space, a control or a non-ASCII character. */
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;
/** Printable ASCII, U+0020..U+007E: what raw recipient input may hold at all. */
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/** True when `value` is exactly one dot-atom addr-spec with a dotted DNS domain. */
export function isAddrSpec(value: string): boolean {
  if (typeof value !== "string" || value.length > 254 || !VISIBLE_ASCII.test(value)) return false;
  const at = value.lastIndexOf("@");
  if (at <= 0 || at !== value.indexOf("@")) return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > 64 || !DOT_ATOM_LOCAL.test(local)) return false;
  const labels = domain.split(".");
  return labels.length >= 2 && labels.every((label) => DOMAIN_LABEL.test(label));
}

/**
 * The gate's recipient normalization (spec A3). In this order:
 * 1. any character outside printable ASCII (U+0020..U+007E) anywhere in the raw input gives null,
 *    checked BEFORE trimming, so a line break, tab, NUL, BOM, U+2028 or a lookalike such as the
 *    Kelvin sign is refused instead of being trimmed away or case-mapped onto ASCII;
 * 2. surrounding ASCII spaces are trimmed;
 * 3. ASCII letters are lowercased (A-Z only, no Unicode case mapping);
 * 4. the result must be exactly one addr-spec.
 * Returns null for anything else (two addresses, a display name, a comma or a semicolon).
 */
export function normalizeAddress(raw: unknown): string | null {
  if (typeof raw !== "string" || !PRINTABLE_ASCII.test(raw)) return null;
  const candidate = raw.replace(/^ +| +$/g, "").replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32));
  return isAddrSpec(candidate) ? candidate : null;
}
