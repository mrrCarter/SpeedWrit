#!/usr/bin/env node
// Build the owner UI and service with one receipt key. No install, migration, or server startup.
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const OS_ENV_NAMES = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'OS',
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'TERM', 'COLORTERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
]);

export class BuildError extends Error {
  constructor(code) {
    super(code);
    this.name = 'BuildError';
    this.code = code;
  }
}

/** Only public metadata leaves this function; parse failures never include the PEM. */
export function deriveReceiptMetadata(env) {
  if (typeof env.RECEIPT_SIGNING_KEY !== 'string' || !env.RECEIPT_SIGNING_KEY.trim()) {
    throw new BuildError('signing_key_required');
  }
  let raw;
  try {
    const key = createPrivateKey(env.RECEIPT_SIGNING_KEY);
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('wrong key type');
    const publicJwk = createPublicKey(key).export({ format: 'jwk' });
    raw = Buffer.from(publicJwk.x, 'base64url');
    if (raw.length !== 32) throw new Error('wrong public key size');
  } catch {
    throw new BuildError('signing_key_must_be_ed25519_private_pem');
  }
  const metadata = {
    RECEIPT_KEY_ID: createHash('sha256').update(raw).digest('hex').slice(0, 16),
    RECEIPT_PUBLIC_KEY_B64URL: raw.toString('base64url'),
  };
  for (const name of Object.keys(metadata)) {
    if (env[name] !== undefined && env[name] !== metadata[name]) {
      throw new BuildError(name === 'RECEIPT_KEY_ID' ? 'receipt_key_id_mismatch' : 'receipt_public_key_mismatch');
    }
  }
  return metadata;
}

/** Neither build subprocess receives application secrets or Node/npm preload/config variables. */
export function childBuildEnv(env, metadata) {
  const child = {};
  for (const [name, value] of Object.entries(env)) {
    if (OS_ENV_NAMES.has(name.toUpperCase()) && typeof value === 'string') child[name] = value;
  }
  child.RECEIPT_KEY_ID = metadata.RECEIPT_KEY_ID;
  child.RECEIPT_PUBLIC_KEY_B64URL = metadata.RECEIPT_PUBLIC_KEY_B64URL;
  return child;
}

function isFile(path) {
  try { return statSync(path).isFile(); } catch { return false; }
}

/** A matching ID alone cannot establish that the browser has the intended verification key. */
export function checkReceiptManifest({ manifestPath, metadata, readFile = readFileSync }) {
  let contents;
  try {
    contents = readFile(manifestPath, 'utf8');
  } catch {
    throw new BuildError('ui_receipt_manifest_unreadable');
  }
  let manifest;
  try {
    manifest = JSON.parse(contents);
  } catch {
    throw new BuildError('ui_receipt_manifest_invalid');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || typeof manifest.key_id !== 'string' || typeof manifest.public_key_b64url !== 'string') {
    throw new BuildError('ui_receipt_manifest_invalid');
  }
  if (manifest.key_id !== metadata.RECEIPT_KEY_ID) throw new BuildError('ui_receipt_key_id_mismatch');
  if (manifest.public_key_b64url !== metadata.RECEIPT_PUBLIC_KEY_B64URL) {
    throw new BuildError('ui_receipt_public_key_mismatch');
  }
}

/** Inject spawn/file checks for tests; the production launcher is always this Node, without a shell. */
export function buildArtifacts({
  env = process.env,
  npmCli,
  repoRoot = REPO_ROOT,
  execPath = process.execPath,
  spawn = spawnSync,
  fileExists = isFile,
  readFile = readFileSync,
} = {}) {
  const metadata = deriveReceiptMetadata(env);
  const selectedNpm = npmCli ?? env.npm_execpath ?? join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (typeof selectedNpm !== 'string' || !selectedNpm.trim()) throw new BuildError('npm_cli_required');
  const npmPath = resolve(selectedNpm);
  if (!fileExists(npmPath)) throw new BuildError('npm_cli_not_found');
  const childEnv = childBuildEnv(env, metadata);
  for (const [workspace, script, error] of [
    ['packages/job-send-ui', 'build:app', 'ui_build_failed'],
    ['packages/job-send-app', 'build', 'app_build_failed'],
  ]) {
    let result;
    try {
      result = spawn(execPath, [npmPath, 'run', '-w', workspace, script], {
        cwd: repoRoot,
        env: { ...childEnv },
        shell: false,
        // Build tools can echo environment/config values. Expose only fixed failure codes below.
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      throw new BuildError(error);
    }
    if (!result || result.error || result.signal || result.status !== 0) throw new BuildError(error);
  }
  for (const [artifact, error] of [
    ['packages/job-send-ui/dist/owner-app/index.html', 'ui_index_missing'],
    ['packages/job-send-ui/dist/owner-app/app.js', 'ui_script_missing'],
    ['packages/job-send-ui/dist/owner-app/receipt-key.json', 'ui_receipt_manifest_missing'],
    ['packages/job-send-app/dist/main.mjs', 'app_entry_missing'],
  ]) {
    if (!fileExists(join(repoRoot, artifact))) throw new BuildError(error);
  }
  checkReceiptManifest({
    manifestPath: join(repoRoot, 'packages/job-send-ui/dist/owner-app/receipt-key.json'),
    metadata,
    readFile,
  });
  return metadata;
}

export function runCli(args, { write = console.log, ...options } = {}) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    write('Usage: node deploy/g1/build.mjs [--npm-cli PATH]');
    return 0;
  }
  try {
    if (!(args.length === 0 || (args.length === 2 && args[0] === '--npm-cli' && args[1]))) {
      throw new BuildError('invalid_arguments');
    }
    const metadata = buildArtifacts({ ...options, ...(args.length ? { npmCli: args[1] } : {}) });
    write(JSON.stringify(metadata));
    return 0;
  } catch (error) {
    write(JSON.stringify({ error: error instanceof BuildError ? error.code : 'build_failed' }));
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli(process.argv.slice(2));
}
