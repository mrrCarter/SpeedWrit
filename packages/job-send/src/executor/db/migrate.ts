import { readdirSync, readFileSync } from "node:fs";
import type { Pool } from "pg";

import { sha256Hex } from "../hash.js";

// A tiny migration runner. Each lane adds its tables as its own numbered file in migrations/
// ("0002_oauth_pending.sql"); every file is applied once, in name order, in one transaction under an
// advisory lock, and recorded with its hash. Running it again is a no-op. It refuses, instead of
// guessing: an applied file that was edited, a database holding a migration this code does not
// know, and a new file that sorts before one already applied.

/** One migration: its file name and its SQL. */
export type Migration = { name: string; sql: string };

const MIGRATION_NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

/** The migration files ship beside the TypeScript sources; tsc does not copy them, so the build reads them from src/. */
export const MIGRATIONS_DIR = new URL("../../../src/executor/db/migrations/", import.meta.url);

/** Every migration file, in name order. */
export function readMigrations(dir: URL = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((name) => MIGRATION_NAME.test(name))
    .sort()
    .map((name) => ({ name, sql: readFileSync(new URL(name, dir), "utf8") }));
}

/** Hashed with LF line endings, so a CRLF checkout of the same file is the same migration. */
const digestOf = (sql: string) => sha256Hex(sql.replace(/\r\n/g, "\n"));

/** Applies every migration this database does not have yet, in order. "current" when there was none. */
export async function migrate(pool: Pool, migrations: readonly Migration[] = readMigrations()): Promise<"applied" | "current"> {
  for (const [index, migration] of migrations.entries()) {
    if (!MIGRATION_NAME.test(migration.name)) throw new Error(`not a migration file name: ${migration.name}`);
    if (index > 0 && migrations[index - 1]!.name >= migration.name) throw new Error("migrations must be unique and in name order");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('job-send schema migration'))");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const { rows } = await client.query<{ name: string; sha256: string }>("SELECT name, sha256 FROM schema_migrations ORDER BY name");
    const known = new Map(migrations.map((migration) => [migration.name, migration]));
    for (const row of rows) {
      const migration = known.get(row.name);
      if (!migration) throw new Error(`this database has migration ${row.name}, which this code does not know`);
      if (digestOf(migration.sql) !== row.sha256) {
        throw new Error(`${row.name} differs from the one this database has; add a migration instead of editing it`);
      }
    }
    const last = rows.at(-1)?.name;
    const pending = migrations.filter((migration) => !rows.some((row) => row.name === migration.name));
    for (const migration of pending) {
      if (last !== undefined && migration.name < last) throw new Error(`${migration.name} sorts before ${last}, which is already applied`);
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)", [migration.name, digestOf(migration.sql)]);
    }
    await client.query("COMMIT");
    return pending.length > 0 ? "applied" : "current";
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
