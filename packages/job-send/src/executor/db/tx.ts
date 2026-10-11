import { randomBytes } from "node:crypto";
import type { Pool, PoolClient, QueryResultRow } from "pg";

import type { Tx } from "../../contract/types.js";

/**
 * The executor's transaction handle (the contract's opaque Tx). It is bound to the one owner the
 * transaction acts for: every receipt written inside it lands in that owner's sequence, and the
 * owner's counter is the last lock taken.
 */
export interface ExecutorTx extends Tx {
  readonly client: PoolClient;
  readonly owner: string;
}

export function asExecutorTx(tx: Tx): ExecutorTx {
  const candidate = tx as Partial<ExecutorTx>;
  if (tx?.kind !== "tx" || typeof candidate.owner !== "string" || typeof candidate.client?.query !== "function") {
    throw new TypeError("not an executor transaction; open one with withTx()");
  }
  return tx as ExecutorTx;
}

/** Runs `fn` in one transaction for `owner`: COMMIT when it returns, ROLLBACK when it throws. */
export async function withTx<T>(pool: Pool, owner: string, fn: (tx: ExecutorTx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await fn({ kind: "tx", client, owner });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      broken = rollbackError instanceof Error ? rollbackError : new Error("rollback failed");
    }
    throw error;
  } finally {
    // A connection whose ROLLBACK failed is destroyed rather than returned to the pool.
    client.release(broken);
  }
}

/** The first row of a query, or undefined. */
export async function one<R extends QueryResultRow>(
  client: Pick<PoolClient, "query">,
  text: string,
  values: unknown[] = [],
): Promise<R | undefined> {
  const { rows } = await client.query<R>(text, values);
  return rows[0];
}

/** A random id with a type prefix, e.g. "dsp_3VJk...". */
export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

/** True for a Postgres unique_violation, optionally on one named constraint. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const e = error as { code?: unknown; constraint?: unknown } | null;
  return e?.code === "23505" && (constraint === undefined || e.constraint === constraint);
}
