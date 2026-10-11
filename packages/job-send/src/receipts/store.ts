import { createPrivateKey, type KeyObject } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { RECEIPT_TYPES, type ReceiptFields, type ReceiptType, type Tx } from "../contract/types.js";
import { asExecutorTx, newId } from "../executor/db/tx.js";
import { signReceipt } from "./sign.js";

// writeReceipt (spec: "Receipts and Flight Recorder"; contract: JobSendCore.writeReceipt).
// Inside the caller's transaction it
//   1. increments the owner's receipt_seq under the owner row lock, which is the LAST lock in the
//      spec's order (proposal, version, job, connection, owner counter), and reads the database
//      clock for the timestamp;
//   2. builds and signs the receipt with the receipt key;
//   3. inserts it.
// A rollback of the caller's transaction takes back the receipt and its sequence number together:
// no receipt, no change, and no gap.

const TYPES: ReadonlySet<string> = new Set(RECEIPT_TYPES);

export type WriteReceipt = (tx: Tx, type: ReceiptType, fields: ReceiptFields) => Promise<string>;

/** A stored receipt as the Flight Recorder and /verify read it. */
export interface StoredReceipt {
  id: string;
  seq: number;
  type: ReceiptType;
  payload: string;
  signature: string;
  key_id: string;
}

/** Returns writeReceipt bound to the receipt signing key (an Ed25519 private key or its PEM). */
export function createReceiptWriter(signingKey: KeyObject | string): WriteReceipt {
  const key = typeof signingKey === "string" ? createPrivateKey(signingKey) : signingKey;
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    throw new TypeError("the receipt key must be an Ed25519 private key");
  }
  return async function writeReceipt(tx: Tx, type: ReceiptType, fields: ReceiptFields): Promise<string> {
    const { client, owner } = asExecutorTx(tx);
    if (!TYPES.has(type)) throw new TypeError(`unknown receipt type ${String(type)}`);
    const { rows } = await client.query<{ seq: number; ts: string }>(
      `UPDATE owners SET receipt_seq = receipt_seq + 1 WHERE id = $1
       RETURNING receipt_seq AS seq,
                 to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ts`,
      [owner],
    );
    const counter = rows[0];
    if (!counter) throw new Error("writeReceipt: the transaction's owner does not exist");
    const id = newId("rcp");
    const signed = signReceipt(key, { ...fields, id, seq: counter.seq, type, ts: counter.ts, owner, prev_sha256: null });
    await client.query(
      "INSERT INTO receipts (id, owner_id, seq, type, payload, signature, key_id) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [id, owner, counter.seq, type, signed.payload, signed.signature, signed.key_id],
    );
    return id;
  };
}

/** An owner's receipts in sequence order, optionally only those naming one job. */
export async function listReceipts(
  db: Pick<Pool | PoolClient, "query">,
  owner: string,
  filter: { job?: string } = {},
): Promise<StoredReceipt[]> {
  const { rows } = await db.query<StoredReceipt>(
    `SELECT id, seq, type, payload, signature, key_id FROM receipts
     WHERE owner_id = $1 AND ($2::text IS NULL OR (payload::jsonb ->> 'job') = $2)
     ORDER BY seq`,
    [owner, filter.job ?? null],
  );
  return rows;
}
