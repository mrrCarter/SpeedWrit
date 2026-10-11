import { createCipheriv, createDecipheriv, createSecretKey, randomBytes, type KeyObject } from "node:crypto";

// Token custody for provider refresh tokens (spec, "Gmail connection"): AES-256-GCM with a 32-byte
// key from a deploy secret, a fresh random 96-bit nonce per record, and the connection id bound as
// associated data, so a record copied onto another connection's row does not decrypt.
//
// Envelope: "v1." + base64url(nonce[12] | ciphertext | tag[16]), no padding.
// The version prefix is also inside the associated data, so it cannot be swapped silently.
//
// Nothing here logs, and no error message carries plaintext, key bytes or the envelope.

export const CUSTODY_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const VERSION = "v1";
const PREFIX = `${VERSION}.`;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export type CustodyErrorCode = "invalid_key" | "invalid_input" | "malformed_envelope" | "decrypt_failed";

export class CustodyError extends Error {
  readonly code: CustodyErrorCode;

  constructor(code: CustodyErrorCode, message: string) {
    super(message);
    this.name = "CustodyError";
    this.code = code;
  }
}

export interface TokenCustody {
  /** Encrypts `plaintext` for `connectionId`. Each call uses a fresh random nonce. */
  seal(connectionId: string, plaintext: string): string;
  /** Decrypts an envelope sealed for `connectionId`; throws decrypt_failed on any mismatch. */
  open(connectionId: string, envelope: string): string;
}

/**
 * Builds a custody object around a 32-byte key. The key bytes are copied into a KeyObject, so later
 * changes to the caller's buffer have no effect and the object holds no enumerable secret.
 */
export function createTokenCustody(key: Uint8Array): TokenCustody {
  if (!(key instanceof Uint8Array) || key.byteLength !== CUSTODY_KEY_BYTES) {
    throw new CustodyError("invalid_key", `custody key must be exactly ${CUSTODY_KEY_BYTES} bytes`);
  }
  const secret: KeyObject = createSecretKey(Buffer.from(key));
  return Object.freeze({
    seal: (connectionId: string, plaintext: string) => seal(secret, connectionId, plaintext),
    open: (connectionId: string, envelope: string) => open(secret, connectionId, envelope),
    toJSON: () => "[TokenCustody]",
  });
}

/** Decodes a deploy secret holding the key as base64 or base64url; it must decode to 32 bytes. */
export function custodyKeyFromSecret(secret: string): Uint8Array {
  const compact = typeof secret === "string" ? secret.trim() : "";
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) {
    throw new CustodyError("invalid_key", "custody secret must be base64");
  }
  const bytes = Buffer.from(compact.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (bytes.byteLength !== CUSTODY_KEY_BYTES) {
    throw new CustodyError("invalid_key", `custody secret must decode to exactly ${CUSTODY_KEY_BYTES} bytes`);
  }
  return new Uint8Array(bytes);
}

function associatedData(connectionId: string): Buffer {
  if (typeof connectionId !== "string" || connectionId === "") {
    throw new CustodyError("invalid_input", "connection id must be a non-empty string");
  }
  return Buffer.from(`writ.token-custody.${VERSION}:${connectionId}`, "utf8");
}

function seal(key: KeyObject, connectionId: string, plaintext: string): string {
  const aad = associatedData(connectionId);
  if (typeof plaintext !== "string") throw new CustodyError("invalid_input", "plaintext must be a string");
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([nonce, ciphertext, tag]).toString("base64url");
}

function open(key: KeyObject, connectionId: string, envelope: string): string {
  const aad = associatedData(connectionId);
  if (typeof envelope !== "string" || !envelope.startsWith(PREFIX)) {
    throw new CustodyError("malformed_envelope", "envelope is not a v1 custody record");
  }
  const encoded = envelope.slice(PREFIX.length);
  if (!BASE64URL.test(encoded)) throw new CustodyError("malformed_envelope", "envelope is not base64url");
  const raw = Buffer.from(encoded, "base64url");
  if (raw.byteLength < NONCE_BYTES + TAG_BYTES || raw.toString("base64url") !== encoded) {
    throw new CustodyError("malformed_envelope", "envelope has the wrong length or encoding");
  }
  const nonce = raw.subarray(0, NONCE_BYTES);
  const ciphertext = raw.subarray(NONCE_BYTES, raw.byteLength - TAG_BYTES);
  const tag = raw.subarray(raw.byteLength - TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new CustodyError("decrypt_failed", "custody record did not decrypt for this connection and key");
  }
}
