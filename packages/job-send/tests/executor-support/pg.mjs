// A throwaway Postgres database per test file. Not a test file itself. Two modes:
//
// - JOBSEND_PG_DSN set (a role allowed to CREATE DATABASE, e.g. the crew's shared cluster): each file
//   gets a fresh database on that server, dropped after the file. No cluster is started.
// - Otherwise, an embedded-postgres cluster, on a free port, in a fresh directory, torn down after the
//   file. A lock file lets only ONE such cluster be alive on the machine at a time, however the test
//   files are run, and the postmaster is stopped in stop(), on process exit and on SIGINT/SIGTERM.
//   The data directory goes under JOBSEND_PG_TMPDIR, or else this package's node_modules/.cache
//   (ignored by git, on the same drive as the checkout), or under WSL with the checkout on a Windows
//   drive, the Linux temp directory. Settings keep each cluster small.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";

import { migrate } from "../../dist/index.js";

const PACKAGE_CACHE_ROOT = fileURLToPath(new URL("../../node_modules/.cache/job-send-pg/", import.meta.url));
/**
 * initdb needs a data directory it can chmod to 0700, which a Windows drive mounted into WSL
 * (/mnt/c, /mnt/h) cannot hold. There the default is the Linux temp directory instead.
 */
const DEFAULT_ROOT =
  process.platform === "linux" && /^\/mnt\/[a-z]\//.test(PACKAGE_CACHE_ROOT) ? join(tmpdir(), "job-send-pg") : PACKAGE_CACHE_ROOT;
/** How long a test file waits for another file's cluster to finish. */
const LOCK_WAIT_MS = 15 * 60 * 1000;

/** The installed @embedded-postgres platform package's directory, or null. */
function embeddedPackageDir() {
  try {
    const entry = fileURLToPath(import.meta.resolve(`@embedded-postgres/${process.platform}-${process.arch}`));
    return resolve(dirname(entry), "..");
  } catch {
    return null;
  }
}

/**
 * The repo's .npmrc sets ignore-scripts=true, so the platform package's postinstall
 * (scripts/hydrate-symlinks.js) never runs, and on Linux initdb then cannot load its bundled ICU:
 * libicuuc.so.60 is a symlink that was never made. Recreate the links the package lists in its own
 * native/pg-symlinks.json, without running third-party code. The Windows package lists none.
 */
function hydrateEmbeddedPostgresSymlinks() {
  if (process.platform === "win32") return;
  const packageDir = embeddedPackageDir();
  if (!packageDir) return;
  const listFile = join(packageDir, "native", "pg-symlinks.json");
  if (!existsSync(listFile)) return;
  const native = join(packageDir, "native") + sep;
  for (const { source, target } of JSON.parse(readFileSync(listFile, "utf8"))) {
    const from = resolve(packageDir, source);
    const link = resolve(packageDir, target);
    if (!from.startsWith(native) || !link.startsWith(native)) throw new Error(`refusing a symlink outside the package: ${target}`);
    try {
      lstatSync(link);
      continue;
    } catch {
      // Missing: create it below.
    }
    try {
      symlinkSync(relative(dirname(link), from), link);
    } catch (error) {
      // Another test file may have made the same link a moment ago.
      if (error?.code !== "EEXIST") throw error;
    }
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True when a process with this id exists (a signal-0 probe; it sends nothing). */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/** Takes the machine-wide cluster lock: one embedded cluster at a time. A dead holder's lock is taken over. */
async function takeClusterLock(root) {
  const lockPath = join(root, "cluster.lock");
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return lockPath;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    let holder = NaN;
    try {
      holder = Number.parseInt(readFileSync(lockPath, "utf8"), 10);
    } catch {
      continue; // released between our open and read
    }
    if (!Number.isInteger(holder) || !alive(holder)) {
      rmSync(lockPath, { force: true });
      continue;
    }
    if (Date.now() > deadline) throw new Error(`waited ${LOCK_WAIT_MS / 60000} min for the Postgres cluster lock held by pid ${holder}`);
    await sleep(250);
  }
}

function releaseClusterLock(lockPath) {
  try {
    if (readFileSync(lockPath, "utf8") === String(process.pid)) unlinkSync(lockPath);
  } catch {
    // Already gone.
  }
}

/** Stops a postmaster synchronously (usable from an exit handler): pg_ctl stop -m immediate. */
function stopPostmasterSync(dataDir) {
  const packageDir = embeddedPackageDir();
  if (!packageDir || !existsSync(join(dataDir, "postmaster.pid"))) return;
  const pgCtl = join(packageDir, "native", "bin", process.platform === "win32" ? "pg_ctl.exe" : "pg_ctl");
  spawnSync(pgCtl, ["-D", dataDir, "-m", "immediate", "-w", "stop"], { stdio: "ignore", timeout: 30_000 });
}

/** Runs `cleanup` once: from stop(), or on exit / SIGINT / SIGTERM if the file never reached stop(). */
function onExitOnce(cleanup) {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    cleanup();
  };
  const onSignal = (signal) => {
    once();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("exit", once);
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return () => {
    process.off("exit", once);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    once();
  };
}

/** A fresh database on JOBSEND_PG_DSN's server. */
async function startOnServer(dsn, poolSize) {
  const database = `jobsend_test_${process.pid}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: dsn });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${database}`);
  } finally {
    await admin.end();
  }
  const url = new URL(dsn);
  url.pathname = `/${database}`;
  const connectionString = url.toString();
  const pool = new pg.Pool({ connectionString, max: poolSize });
  const drop = async () => {
    await pool.end().catch(() => undefined);
    const client = new pg.Client({ connectionString: dsn });
    await client.connect();
    try {
      await client.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
    } finally {
      await client.end();
    }
  };
  try {
    await migrate(pool);
  } catch (error) {
    await drop().catch(() => undefined);
    throw error;
  }
  let stopped = false;
  return {
    pool,
    async client() {
      const client = new pg.Client({ connectionString });
      await client.connect();
      return client;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await drop();
    },
  };
}

/** An embedded cluster, one per machine at a time. */
async function startEmbedded(poolSize) {
  hydrateEmbeddedPostgresSymlinks();
  const root = process.env.JOBSEND_PG_TMPDIR || DEFAULT_ROOT;
  mkdirSync(root, { recursive: true });
  const lockPath = await takeClusterLock(root);
  const dir = mkdtempSync(join(root, "cluster-"));
  const dataDir = join(dir, "data");
  // Whatever happens next, the postmaster is stopped, the directory removed and the lock released.
  const cleanup = onExitOnce(() => {
    stopPostmasterSync(dataDir);
    rmSync(dir, { recursive: true, force: true });
    releaseClusterLock(lockPath);
  });
  const port = await freePort();
  const password = `pw-${process.pid}-${port}`;
  const log = [];
  const cluster = new EmbeddedPostgres({
    databaseDir: dataDir,
    port,
    user: "postgres",
    password,
    persistent: false,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    postgresFlags: [
      "-c", "listen_addresses=127.0.0.1",
      "-c", "shared_buffers=16MB",
      "-c", "max_connections=40",
      "-c", "fsync=off",
      "-c", "synchronous_commit=off",
      "-c", "full_page_writes=off",
      "-c", "deadlock_timeout=200ms",
    ],
    onLog: (message) => log.push(String(message)),
    onError: (message) => log.push(`[error] ${String(message)}`),
  });
  const config = { host: "127.0.0.1", port, user: "postgres", password, database: "jobsend" };
  let pool;
  try {
    await cluster.initialise();
    await cluster.start();
    await cluster.createDatabase("jobsend");
    pool = new pg.Pool({ ...config, max: poolSize });
    await migrate(pool);
  } catch (error) {
    await pool?.end().catch(() => undefined);
    await cluster.stop().catch(() => undefined);
    cleanup();
    throw new Error(`embedded Postgres did not start: ${error?.message ?? error}\n${log.slice(-20).join("\n")}`);
  }
  let stopped = false;
  return {
    pool,
    async client() {
      const client = new pg.Client(config);
      await client.connect();
      return client;
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      await pool.end().catch(() => undefined);
      await cluster.stop().catch(() => undefined);
      cleanup();
    },
  };
}

/** Starts a throwaway database with every migration applied, and returns a pool on it. */
export async function startPostgres({ poolSize = 12 } = {}) {
  const dsn = process.env.JOBSEND_PG_DSN;
  return dsn ? startOnServer(dsn, poolSize) : startEmbedded(poolSize);
}
