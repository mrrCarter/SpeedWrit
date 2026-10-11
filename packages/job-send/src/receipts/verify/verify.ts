// Standalone receipt verification for Node and the browser (the interface Bundle's /verify page
// consumes).
//
// The import graph of this module is ../../executor/jcs.js and ./base64url.js, plus type-only
// imports: nothing from node:*, no Buffer, no signing or custody code. Ed25519 and SHA-256 come from
// WebCrypto (globalThis.crypto.subtle), present in Node 20+ and current Chrome, Edge, Firefox and
// Safari. A browser exposes crypto.subtle only in a secure context (HTTPS or localhost).
//
// Where WebCrypto is missing or lacks Ed25519, the returned promise REJECTS (an environment
// problem, not a verdict), so no browser ever shows "invalid" for a receipt it could not check.
// The /verify page may catch that and retry with a pinned pure-JS Ed25519 library as a fallback.
//
// Checks, in order; the first failure is the reason:
// - malformed:         the envelope is not { payload, signature, key_id } with three strings; for
//                      pasted text, it is not exactly receiptEnvelopeText() of those strings;
// - unknown_key:       key_id is not the pinned key's id (another signer, not a forgery);
// - invalid_signature: the signature is not canonical base64url of 64 bytes, or it does not verify
//                      over utf8(payload) under the pinned key;
// - not_canonical:     canonicalize(JSON.parse(payload)) !== payload. A signed text that is not its
//                      own canonical form (reordered keys, duplicate keys, whitespace, a float)
//                      could read differently in different parsers, so a good signature is not
//                      enough.
// ok is true only for "verified": these exact bytes were signed by the holder of the pinned key and
// are unchanged. It says nothing about whether the provider's answer was true.

import { canonicalize } from "../../executor/jcs.js";
import { decodeBase64Url } from "./base64url.js";

const RAW_PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const KEY_ID = /^[0-9a-f]{16}$/;

/** The pinned receipt key: its id and the full raw 32-byte Ed25519 public key. */
export type Pinned = { keyId: string; publicKeyRaw: Uint8Array };

export type VerifyReason = "verified" | "invalid_signature" | "unknown_key" | "not_canonical" | "malformed";

export type VerifyResult = { ok: boolean; reason: VerifyReason };

function subtleCrypto(): SubtleCrypto {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) throw new Error("receipt verification needs WebCrypto (crypto.subtle), which this runtime lacks");
  return subtle;
}

function rawKey(publicKeyRaw: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!(publicKeyRaw instanceof Uint8Array) || publicKeyRaw.byteLength !== RAW_PUBLIC_KEY_BYTES) {
    throw new TypeError("pinned.publicKeyRaw must be the raw 32-byte Ed25519 public key");
  }
  return new Uint8Array(publicKeyRaw);
}

/** First 16 hex characters of sha256(raw public key): the receipt key id and fingerprint. */
export async function keyIdOf(publicKeyRaw: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await subtleCrypto().digest("SHA-256", rawKey(publicKeyRaw)));
  return Array.from(digest.subarray(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const result = (reason: VerifyReason): VerifyResult => ({ ok: reason === "verified", reason });

/**
 * Verifies a signed receipt against the pinned key. Throws (rejects) when the pinned pair is
 * inconsistent, which is a programmer error, or when the runtime cannot do Ed25519.
 */
export async function verifyReceipt(
  r: { payload: string; signature: string; key_id: string },
  pinned: Pinned,
): Promise<VerifyResult> {
  return verifyWithKey(r, pinned, await pinnedKey(pinned));
}

/**
 * The one text form a signed receipt is shared in: the canonical JSON of exactly
 * { key_id, payload, signature }. verifyReceiptText accepts this text and nothing else.
 */
export function receiptEnvelopeText(signed: { payload: string; signature: string; key_id: string }): string {
  const { payload, signature, key_id } = signed;
  if (typeof payload !== "string" || typeof signature !== "string" || typeof key_id !== "string") {
    throw new TypeError("a receipt envelope holds string payload, signature and key_id");
  }
  return canonicalize({ key_id, payload, signature });
}

const ENVELOPE_KEYS = ["key_id", "payload", "signature"];
/** JSON's own whitespace. Anything else around the text (a BOM, NBSP, U+2028) is malformed. */
const SURROUNDING_ASCII_WHITESPACE = /^[ \t\n\r]+|[ \t\n\r]+$/g;

/**
 * Verifies pasted text. After surrounding ASCII whitespace is trimmed, the text must be exactly
 * receiptEnvelopeText() of its own parse, with exactly the three string keys; anything else is
 * "malformed". JSON.parse keeps the last of duplicate keys and would carry extra keys along, so
 * without the exact-text rule a forged "payload" key or an appended "status" could sit beside a
 * good signature and be shown as verified.
 */
export async function verifyReceiptText(text: string, pinned: Pinned): Promise<VerifyResult> {
  const publicKey = await pinnedKey(pinned);
  if (typeof text !== "string") return result("malformed");
  const trimmed = text.replace(SURROUNDING_ASCII_WHITESPACE, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return result("malformed");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return result("malformed");
  const keys = Object.keys(parsed).sort();
  if (keys.length !== ENVELOPE_KEYS.length || keys.some((key, i) => key !== ENVELOPE_KEYS[i])) return result("malformed");
  const { payload, signature, key_id } = parsed as Record<string, unknown>;
  if (typeof payload !== "string" || typeof signature !== "string" || typeof key_id !== "string") return result("malformed");
  const envelope = { payload, signature, key_id };
  try {
    if (receiptEnvelopeText(envelope) !== trimmed) return result("malformed");
  } catch {
    return result("malformed");
  }
  return verifyWithKey(envelope, pinned, publicKey);
}

/** Validates the pinned pair and returns a private copy of its key bytes. */
async function pinnedKey(pinned: Pinned): Promise<Uint8Array<ArrayBuffer>> {
  if (pinned === null || typeof pinned !== "object" || typeof pinned.keyId !== "string" || !KEY_ID.test(pinned.keyId)) {
    throw new TypeError("pinned.keyId must be 16 lowercase hex characters");
  }
  const publicKey = rawKey(pinned.publicKeyRaw);
  if ((await keyIdOf(publicKey)) !== pinned.keyId) {
    throw new TypeError("pinned.keyId is not the id of pinned.publicKeyRaw");
  }
  return publicKey;
}

async function verifyWithKey(
  r: { payload: unknown; signature: unknown; key_id: unknown },
  pinned: Pinned,
  publicKey: Uint8Array<ArrayBuffer>,
): Promise<VerifyResult> {
  if (
    r === null ||
    typeof r !== "object" ||
    typeof r.payload !== "string" ||
    typeof r.signature !== "string" ||
    typeof r.key_id !== "string"
  ) {
    return result("malformed");
  }
  if (r.key_id !== pinned.keyId) return result("unknown_key");

  const signature = decodeBase64Url(r.signature);
  if (signature === null || signature.byteLength !== SIGNATURE_BYTES) return result("invalid_signature");
  const subtle = subtleCrypto();
  const key = await subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
  const good = await subtle.verify({ name: "Ed25519" }, key, new Uint8Array(signature), new TextEncoder().encode(r.payload));
  if (!good) return result("invalid_signature");

  try {
    if (canonicalize(JSON.parse(r.payload)) !== r.payload) return result("not_canonical");
  } catch {
    // Not JSON, or JSON holding a value outside the canonical subset.
    return result("not_canonical");
  }
  return result("verified");
}
