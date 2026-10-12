// Canonical JSON, SHA-256 and receipt signing with WebCrypto. Ed25519 where the runtime has it,
// ECDSA P-256 otherwise; the receipt names the key, and verification uses the same algorithm.

import type { Receipt, ReceiptBody } from "./types";

export const GENESIS = "0".repeat(64);

/** Sorted-key JSON: one byte string per value, so a hash or a signature means one thing. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(",")}}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function b64url(bytes: ArrayBuffer): string {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export interface Signer {
  alg: "Ed25519" | "ECDSA-P256";
  keyId: string;
  publicKey: string;
  sign(message: string): Promise<string>;
  verify(message: string, signature: string): Promise<boolean>;
}

export async function createSigner(): Promise<Signer> {
  let alg: Signer["alg"] = "Ed25519";
  let pair: CryptoKeyPair;
  let params: AlgorithmIdentifier | EcdsaParams;
  try {
    pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    params = { name: "Ed25519" };
  } catch {
    alg = "ECDSA-P256";
    pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    params = { name: "ECDSA", hash: "SHA-256" };
  }
  const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
  const publicKey = b64url(raw);
  const keyId = `swk_${(await sha256Hex(publicKey)).slice(0, 12)}`;
  const enc = new TextEncoder();
  return {
    alg,
    keyId,
    publicKey,
    async sign(message) {
      return b64url(await crypto.subtle.sign(params, pair.privateKey, enc.encode(message)));
    },
    async verify(message, signature) {
      try {
        return await crypto.subtle.verify(params, pair.publicKey, unb64url(signature), enc.encode(message));
      } catch {
        return false;
      }
    },
  };
}

export function bodyOf(r: Receipt): ReceiptBody {
  return {
    seq: r.seq,
    ts: r.ts,
    type: r.type,
    jobId: r.jobId,
    proposalId: r.proposalId,
    versionHash: r.versionHash,
    reason: r.reason,
    detail: r.detail,
    prevHash: r.prevHash,
    keyId: r.keyId,
  };
}

export interface Verification {
  hashOk: boolean;
  signatureOk: boolean;
  chainOk: boolean;
  keyOk: boolean;
}

/** Recomputes the hash from the body, checks the signature over it, and the link to the previous receipt. */
export async function verifyReceipt(r: Receipt, signer: Signer, prev: Receipt | undefined): Promise<Verification> {
  const hash = await sha256Hex(canonical(bodyOf(r)));
  return {
    hashOk: hash === r.hash,
    signatureOk: hash === r.hash && (await signer.verify(r.hash, r.sig)),
    chainOk: r.prevHash === (prev ? prev.hash : GENESIS),
    keyOk: r.keyId === signer.keyId,
  };
}

/** Changes exactly one character of the receipt's content: the demo's tamper test. */
export function tamperOneByte(r: Receipt): Receipt {
  const reason = r.reason ?? "";
  const flipped = reason.length > 0 ? `${reason.slice(0, -1)}${reason.endsWith("x") ? "y" : "x"}` : "x";
  return { ...r, reason: flipped };
}
