// Receipt shapes from the spec ("Receipts and Flight Recorder"). No imports at runtime beyond the
// contract module, so the browser verify library may depend on this file.

import type { JsonObject } from "../executor/jcs.js";
import { RECEIPT_TYPES, type ReceiptType } from "../contract/types.js";

// The receipt types are the contract's one list (src/contract), re-exported here under the same names.
export { RECEIPT_TYPES, type ReceiptType };

/** A receipt. Every key is always present; fields that do not apply are null. */
export interface Receipt {
  v: 1;
  id: string;
  /** Per-owner counter. */
  seq: number;
  type: ReceiptType;
  /** UTC, "YYYY-MM-DDTHH:MM:SSZ" or with milliseconds. */
  ts: string;
  owner: string;
  job: string | null;
  policy_version: number | null;
  /** The authenticated agent connection. */
  agent_connection: string | null;
  /** Declared by the client; not a verified model identity. */
  client_label: string | null;
  proposal: string | null;
  version: number | null;
  version_sha256: string | null;
  /** Strings, safe integers, booleans, null, arrays and objects only. Probabilities in basis points. */
  detail: JsonObject;
  /** Hash chain, after Gate 3. */
  prev_sha256: string | null;
}

/** What is stored and shipped: the JCS text byte for byte, its Ed25519 signature and the key id. */
export interface SignedReceipt {
  payload: string;
  /** base64url, no padding, of the 64-byte Ed25519 signature over utf8(payload). */
  signature: string;
  /** First 16 hex characters of sha256(raw 32-byte public key). */
  key_id: string;
}
