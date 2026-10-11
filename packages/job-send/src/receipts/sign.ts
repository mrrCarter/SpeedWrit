import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";

import { canonicalize } from "../executor/jcs.js";
import { buildReceipt, type ReceiptFields } from "./build.js";
import type { Receipt, SignedReceipt } from "./types.js";

// Receipt signing (spec, "Receipts and Flight Recorder"):
//   payload   = JCS(receipt), stored as text byte for byte
//   signature = Ed25519.sign(private_key, utf8(payload)), base64url without padding
//   key_id    = first 16 hex of sha256(raw 32-byte public key)
// A signed receipt is shared as receiptEnvelopeText(signed) (from ./verify): the canonical JSON of
// exactly { key_id, payload, signature }, the only text verifyReceiptText accepts.
// node:crypto only; no dependencies. The browser-side check lives in ./verify and shares no code
// with this file except the JCS module.

const RAW_PUBLIC_KEY_BYTES = 32;

export interface ReceiptKeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
  /** PKCS#8 PEM, for the deploy secret. */
  privateKeyPem: string;
  /** SPKI PEM. */
  publicKeyPem: string;
  /** The raw 32-byte public key to pin in the verify page. */
  publicKeyRaw: Uint8Array;
  keyId: string;
}

/** Generates an Ed25519 key pair for receipt signing. */
export function generateReceiptKeyPair(): ReceiptKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyRaw = exportRawPublicKey(publicKey);
  return {
    privateKey,
    publicKey,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    publicKeyRaw,
    keyId: receiptKeyId(publicKeyRaw),
  };
}

/** The raw 32-byte Ed25519 public key of a public or private key (KeyObject or PEM). */
export function exportRawPublicKey(key: KeyObject | string): Uint8Array {
  const publicKey = typeof key === "string" ? createPublicKey(key) : key.type === "private" ? createPublicKey(key) : key;
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
    throw new TypeError("receipt keys must be Ed25519");
  }
  const jwk = publicKey.export({ format: "jwk" });
  const raw = Buffer.from(typeof jwk.x === "string" ? jwk.x : "", "base64url");
  if (raw.byteLength !== RAW_PUBLIC_KEY_BYTES) throw new TypeError("Ed25519 public key must be 32 bytes");
  return new Uint8Array(raw);
}

/** First 16 hex characters of sha256(raw 32-byte public key). */
export function receiptKeyId(publicKeyRaw: Uint8Array): string {
  if (!(publicKeyRaw instanceof Uint8Array) || publicKeyRaw.byteLength !== RAW_PUBLIC_KEY_BYTES) {
    throw new TypeError("raw Ed25519 public key must be 32 bytes");
  }
  return createHash("sha256").update(publicKeyRaw).digest("hex").slice(0, 16);
}

/**
 * Validates `receipt` with buildReceipt, canonicalizes it, and signs the canonical text.
 * `privateKey` is an Ed25519 KeyObject or a PKCS#8 PEM string.
 */
export function signReceipt(privateKey: KeyObject | string, receipt: Receipt | ReceiptFields): SignedReceipt {
  const key = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    throw new TypeError("receipts are signed with an Ed25519 private key");
  }
  const payload = canonicalize(buildReceipt(receipt));
  const signature = sign(null, Buffer.from(payload, "utf8"), key).toString("base64url");
  return { payload, signature, key_id: receiptKeyId(exportRawPublicKey(key)) };
}
