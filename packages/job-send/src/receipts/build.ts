import { canonicalize, type JsonObject } from "../executor/jcs.js";
import { RECEIPT_TYPES, type Receipt, type ReceiptType } from "./types.js";

/** Input to buildReceipt. Omitted nullable fields become null; an omitted detail becomes {}. */
export interface ReceiptFields {
  v?: 1;
  id: string;
  seq: number;
  type: ReceiptType;
  ts: string;
  owner: string;
  job?: string | null;
  policy_version?: number | null;
  agent_connection?: string | null;
  client_label?: string | null;
  proposal?: string | null;
  version?: number | null;
  version_sha256?: string | null;
  detail?: JsonObject;
  prev_sha256?: string | null;
}

export class ReceiptError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`receipt ${field}: ${message}`);
    this.name = "ReceiptError";
    this.field = field;
  }
}

const KEYS = [
  "v",
  "id",
  "seq",
  "type",
  "ts",
  "owner",
  "job",
  "policy_version",
  "agent_connection",
  "client_label",
  "proposal",
  "version",
  "version_sha256",
  "detail",
  "prev_sha256",
] as const;

const RECEIPT_ID = /^rcp_[A-Za-z0-9_-]{1,120}$/;
const UTC_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const TYPES: ReadonlySet<string> = new Set(RECEIPT_TYPES);

/** The current time as a receipt timestamp, to the second: "2026-10-11T19:04:11Z". */
export function receiptTimestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Validates the fields and returns a receipt with every key present. Throws ReceiptError on a bad
 * field, and JcsError when detail holds a float or any value outside the canonical subset.
 */
export function buildReceipt(fields: ReceiptFields): Receipt {
  if (fields === null || typeof fields !== "object" || Array.isArray(fields)) {
    throw new ReceiptError("fields", "must be an object");
  }
  for (const key of Object.keys(fields)) {
    if (!(KEYS as readonly string[]).includes(key)) throw new ReceiptError(key, "is not a receipt field");
  }
  if (fields.v !== undefined && fields.v !== 1) throw new ReceiptError("v", "must be 1");
  if (typeof fields.id !== "string" || !RECEIPT_ID.test(fields.id)) throw new ReceiptError("id", "must look like rcp_<id>");
  if (!Number.isSafeInteger(fields.seq) || fields.seq < 0) throw new ReceiptError("seq", "must be a non-negative integer");
  if (typeof fields.type !== "string" || !TYPES.has(fields.type)) throw new ReceiptError("type", "is not a receipt type");
  if (!isUtcTimestamp(fields.ts)) throw new ReceiptError("ts", "must be a UTC timestamp ending in Z");
  if (typeof fields.owner !== "string" || fields.owner === "") throw new ReceiptError("owner", "must be a non-empty string");

  const detail: unknown = fields.detail === undefined ? {} : fields.detail;
  if (detail === null || typeof detail !== "object" || Array.isArray(detail)) {
    throw new ReceiptError("detail", "must be an object");
  }

  const receipt: Receipt = {
    v: 1,
    id: fields.id,
    seq: fields.seq,
    type: fields.type,
    ts: fields.ts,
    owner: fields.owner,
    job: optionalId("job", fields.job),
    policy_version: optionalPositive("policy_version", fields.policy_version),
    agent_connection: optionalId("agent_connection", fields.agent_connection),
    client_label: optionalString("client_label", fields.client_label),
    proposal: optionalId("proposal", fields.proposal),
    version: optionalPositive("version", fields.version),
    version_sha256: optionalHash("version_sha256", fields.version_sha256),
    // A copy through canonical JSON: rejects floats and non-plain values, and detaches the caller's object.
    detail: JSON.parse(canonicalize(detail)) as JsonObject,
    prev_sha256: optionalHash("prev_sha256", fields.prev_sha256),
  };
  canonicalize(receipt);
  return receipt;
}

function isUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !UTC_TS.test(value)) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const iso = date.toISOString();
  return iso === value || iso.replace(/\.000Z$/, "Z") === value;
}

function optionalString(field: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new ReceiptError(field, "must be a string or null");
  return value;
}

function optionalId(field: string, value: unknown): string | null {
  const text = optionalString(field, value);
  if (text === "") throw new ReceiptError(field, "must not be empty");
  return text;
}

function optionalPositive(field: string, value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ReceiptError(field, "must be a positive integer or null");
  }
  return value;
}

function optionalHash(field: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !SHA256_HEX.test(value)) throw new ReceiptError(field, "must be 64 lowercase hex or null");
  return value;
}
