import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { buildArtifacts, checkReceiptManifest, childBuildEnv, deriveReceiptMetadata, runCli } from './build.mjs';

const pair = generateKeyPairSync('ed25519');
const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const raw = Buffer.from(pair.publicKey.export({ format: 'jwk' }).x, 'base64url');
const publicMetadata = {
  RECEIPT_KEY_ID: createHash('sha256').update(raw).digest('hex').slice(0, 16),
  RECEIPT_PUBLIC_KEY_B64URL: raw.toString('base64url'),
};
const manifest = { key_id: publicMetadata.RECEIPT_KEY_ID, public_key_b64url: publicMetadata.RECEIPT_PUBLIC_KEY_B64URL };

function fixture(overrides = {}) {
  const calls = [];
  return {
    env: { RECEIPT_SIGNING_KEY: pem, PATH: '/runtime/bin', npm_execpath: resolve('npm-cli.js') },
    fileExists: () => true,
    readFile: () => JSON.stringify(manifest),
    spawn: (...args) => { calls.push(args); return { status: 0 }; },
    ...overrides,
    calls,
  };
}

test('public metadata derives from raw Ed25519 bytes and matches the signer contract', () => {
  assert.deepEqual(deriveReceiptMetadata({ RECEIPT_SIGNING_KEY: pem }), publicMetadata);
  assert.match(publicMetadata.RECEIPT_KEY_ID, /^[a-f0-9]{16}$/);
  assert.match(publicMetadata.RECEIPT_PUBLIC_KEY_B64URL, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(publicMetadata.RECEIPT_PUBLIC_KEY_B64URL, 'base64url').length, 32);
  assert.deepEqual(deriveReceiptMetadata({ RECEIPT_SIGNING_KEY: pem, ...publicMetadata }), publicMetadata);
});

test('missing, malformed, public-only, and non-Ed25519 keys fail without echoing input', () => {
  const wrongPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  for (const input of [undefined, '', 'secret malformed key',
    pair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    wrongPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()]) {
    assert.throws(() => deriveReceiptMetadata({ RECEIPT_SIGNING_KEY: input }), (error) => {
      assert.ok(['signing_key_required', 'signing_key_must_be_ed25519_private_pem'].includes(error.code));
      assert.equal(error.message.includes('secret'), false);
      assert.equal(error.message.includes('BEGIN'), false);
      return true;
    });
  }
});

test('expected receipt key ID or public key mismatches stop before either build', () => {
  for (const [name, code] of [['RECEIPT_KEY_ID', 'receipt_key_id_mismatch'],
    ['RECEIPT_PUBLIC_KEY_B64URL', 'receipt_public_key_mismatch']]) {
    const f = fixture();
    f.env[name] = 'wrong-secret-value';
    assert.throws(() => buildArtifacts(f), { code });
    assert.equal(f.calls.length, 0);
  }
});

test('child environment carries only OS/runtime variables and derived public metadata', () => {
  const env = {
    Path: 'C:\\runtime', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\cmd.exe',
    HOME: '/user', USERPROFILE: 'C:\\Users\\test', TEMP: '/tmp', TMP: '/tmp',
    RECEIPT_SIGNING_KEY: pem, CUSTODY_KEY: 'custody-secret', GOOGLE_CLIENT_SECRET: 'google-secret',
    GOOGLE_CLIENT_ID: 'google-id', DATABASE_URL: 'db-secret', DIAL_API_KEY: 'dial-secret',
    XAI_API_KEY: 'xai-secret', TYPESAFE_API_KEY: 'review-secret', API_KEY: 'generic-secret',
    NODE_OPTIONS: '--require secret-module', NODE_PATH: '/secret-modules',
    npm_config_userconfig: '/secret-npmrc', npm_execpath: '/npm-cli.js',
    RECEIPT_KEY_ID: 'untrusted-key-id', RECEIPT_PUBLIC_KEY_B64URL: 'untrusted-public-key',
  };
  const child = childBuildEnv(env, publicMetadata);
  assert.deepEqual(child, {
    Path: env.Path, SystemRoot: env.SystemRoot, ComSpec: env.ComSpec,
    HOME: env.HOME, USERPROFILE: env.USERPROFILE, TEMP: env.TEMP, TMP: env.TMP,
    ...publicMetadata,
  });
  assert.equal(JSON.stringify(child).includes('secret'), false);
});

test('build uses this Node and explicit npm CLI, no shell, UI before service', () => {
  const f = fixture({ npmCli: resolve('path with spaces', 'npm-cli.js'), repoRoot: resolve('workspace') });
  assert.deepEqual(buildArtifacts(f), publicMetadata);
  assert.equal(f.calls.length, 2);
  for (const [i, [executable, args, options]] of f.calls.entries()) {
    assert.equal(executable, process.execPath);
    assert.deepEqual(args, [f.npmCli, 'run', '-w',
      i === 0 ? 'packages/job-send-ui' : 'packages/job-send-app', i === 0 ? 'build:app' : 'build']);
    assert.equal(options.cwd, f.repoRoot);
    assert.equal(options.shell, false);
    assert.equal(options.stdio, 'ignore');
    assert.deepEqual(options.env, { PATH: f.env.PATH, ...publicMetadata });
    assert.equal(Object.hasOwn(options.env, 'RECEIPT_SIGNING_KEY'), false);
  }
});

test('npm CLI resolution uses npm_execpath or the Node executable sibling npm installation', () => {
  const f = fixture();
  buildArtifacts(f);
  assert.equal(f.calls[0][1][0], f.env.npm_execpath);
  const fallback = fixture({ env: { RECEIPT_SIGNING_KEY: pem } });
  buildArtifacts(fallback);
  assert.equal(fallback.calls[0][1][0], join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  const missing = fixture({ fileExists: () => false });
  assert.throws(() => buildArtifacts(missing), { code: 'npm_cli_not_found' });
  assert.equal(missing.calls.length, 0);
});

test('UI failures and spawn exceptions stop immediately; failed builds emit no child diagnostics', () => {
  for (const spawn of [() => ({ status: 1, stderr: 'secret child diagnostic' }),
    () => ({ status: null, error: new Error('secret spawn diagnostic') }),
    () => ({ status: null, signal: 'SIGTERM' }),
    () => { throw new Error('secret thrown diagnostic'); }]) {
    let calls = 0;
    const output = [];
    const f = fixture({ spawn: (...args) => { calls++; return spawn(...args); } });
    assert.equal(runCli([], { ...f, write: (line) => output.push(line) }), 1);
    assert.equal(calls, 1);
    assert.deepEqual(output, ['{"error":"ui_build_failed"}']);
  }
});

test('service build failure prevents artifact checks and does not report success', () => {
  let calls = 0;
  let checks = 0;
  const f = fixture({
    spawn: () => ({ status: ++calls === 2 ? 1 : 0 }),
    fileExists: () => { checks++; return true; },
  });
  assert.throws(() => buildArtifacts(f), { code: 'app_build_failed' });
  assert.equal(calls, 2);
  assert.equal(checks, 1); // npm CLI only
});

test('all four deployment artifacts are required after both builds succeed', () => {
  const artifacts = [
    ['packages/job-send-ui/dist/owner-app/index.html', 'ui_index_missing'],
    ['packages/job-send-ui/dist/owner-app/app.js', 'ui_script_missing'],
    ['packages/job-send-ui/dist/owner-app/receipt-key.json', 'ui_receipt_manifest_missing'],
    ['packages/job-send-app/dist/main.mjs', 'app_entry_missing'],
  ];
  for (const [missing, code] of artifacts) {
    const root = resolve('workspace');
    const f = fixture({ repoRoot: root, fileExists: (file) => file !== join(root, missing) });
    assert.throws(() => buildArtifacts(f), { code });
    assert.equal(f.calls.length, 2);
  }
});

test('real manifest file must contain both intended public fields', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'speedwrit-manifest-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manifestPath = join(dir, 'receipt-key.json');
  assert.throws(() => checkReceiptManifest({ manifestPath, metadata: publicMetadata }), {
    code: 'ui_receipt_manifest_unreadable',
  });
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
  assert.doesNotThrow(() => checkReceiptManifest({ manifestPath, metadata: publicMetadata }));
  const otherKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x;
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, public_key_b64url: otherKey }));
  assert.throws(() => checkReceiptManifest({ manifestPath, metadata: publicMetadata }), {
    code: 'ui_receipt_public_key_mismatch',
  });
});

test('malformed manifest JSON and missing or non-string public fields fail', () => {
  for (const contents of ['secret malformed JSON', 'null', '[]', '"secret string"', '{}',
    JSON.stringify({ ...manifest, key_id: 123 }),
    JSON.stringify({ key_id: manifest.key_id }),
    JSON.stringify({ ...manifest, public_key_b64url: null })]) {
    const f = fixture({ readFile: () => contents });
    assert.throws(() => buildArtifacts(f), { code: 'ui_receipt_manifest_invalid' });
    assert.equal(f.calls.length, 2);
  }
});

test('manifest is checked after both builds, at the expected path, with exact ID and key equality', () => {
  const root = resolve('workspace');
  const f = fixture({ repoRoot: root, readFile: (file, encoding) => {
    assert.equal(f.calls.length, 2);
    assert.equal(file, join(root, 'packages/job-send-ui/dist/owner-app/receipt-key.json'));
    assert.equal(encoding, 'utf8');
    return JSON.stringify(manifest);
  } });
  assert.deepEqual(buildArtifacts(f), publicMetadata);
  for (const [field, code] of [['key_id', 'ui_receipt_key_id_mismatch'],
    ['public_key_b64url', 'ui_receipt_public_key_mismatch']]) {
    assert.throws(() => buildArtifacts(fixture({
      readFile: () => JSON.stringify({ ...manifest, [field]: 'secret wrong value' }),
    })), { code });
  }
});

test('manifest failure CLI output never includes file contents or read diagnostics', () => {
  for (const [readFile, code] of [
    [() => { throw new Error('secret filesystem diagnostic'); }, 'ui_receipt_manifest_unreadable'],
    [() => 'secret JSON parse diagnostic', 'ui_receipt_manifest_invalid'],
    [() => JSON.stringify({ ...manifest, public_key_b64url: pem }), 'ui_receipt_public_key_mismatch'],
  ]) {
    const lines = [];
    assert.equal(runCli([], { ...fixture({ readFile }), write: (line) => lines.push(line) }), 1);
    assert.deepEqual(lines, [JSON.stringify({ error: code })]);
  }
});

test('CLI prints only public metadata on success and fixed codes for invalid arguments', () => {
  const output = [];
  const f = fixture();
  assert.equal(runCli(['--npm-cli', resolve('explicit npm-cli.js')], {
    ...f, write: (line) => output.push(line),
  }), 0);
  assert.deepEqual(JSON.parse(output[0]), publicMetadata);
  assert.equal(output[0].includes('PRIVATE'), false);
  for (const args of [['--npm-cli'], ['--unknown', 'secret-value'], ['secret-value']]) {
    const lines = [];
    const invalid = fixture();
    assert.equal(runCli(args, { ...invalid, write: (line) => lines.push(line) }), 1);
    assert.deepEqual(lines, ['{"error":"invalid_arguments"}']);
    assert.equal(invalid.calls.length, 0);
  }
});
