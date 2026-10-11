// Strict base64url decoding without Buffer or atob, so it runs unchanged in a browser.
// Rejects padding, characters outside the URL-safe alphabet, an impossible length, and non-zero
// trailing bits, so exactly one string decodes to a given byte sequence.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const LOOKUP: ReadonlyMap<string, number> = new Map(Array.from(ALPHABET, (char, index) => [char, index]));

/** Decodes unpadded base64url, or returns null when `text` is not its one canonical encoding. */
export function decodeBase64Url(text: string): Uint8Array | null {
  if (typeof text !== "string" || text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of text) {
    const value = LOOKUP.get(char);
    if (value === undefined) return null;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (buffer >> bits) & 0xff;
      buffer &= (1 << bits) - 1;
    }
  }
  if ((buffer & ((1 << bits) - 1)) !== 0) return null;
  return out;
}
