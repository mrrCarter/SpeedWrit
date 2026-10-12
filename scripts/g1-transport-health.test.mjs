import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkTransport, runCli, validateManifest, CANONICAL_SOURCE, canonicalSourceMatches } from './g1-transport-health.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const publicKey = Buffer.alloc(32, 7);
const pin = { key_id: sha(publicKey).slice(0, 16), public_key_b64url: publicKey.toString('base64url') };
const bundle = `// synthetic build fixture\nconst keyId="${pin.key_id}", publicKey="${pin.public_key_b64url}";`;
const canonical = 'https://speedwrit.aidenid.com';
const upstream = 'https://speedwrit-origin.aidenid.com';
const fixture = () => ({
  schema_version: 1, canonical_origin: canonical, upstream_origin: upstream,
  deployment: { repository: CANONICAL_SOURCE.repository, runtime_revision: '1'.repeat(40),
    image_digest: `sha256:${'2'.repeat(64)}`, bundle_sha256: sha(bundle),
    bundle_source: '/app/packages/job-send-ui/dist/owner-app/app.js' },
  receipt_pin: { ...pin },
  limits: { timeout_ms: 100, max_metadata_bytes: 65_536, max_bundle_bytes: 8_388_608 },
});
function response(url, body, { status = 200, headers = {}, responseUrl = url, redirected = false } = {}) {
  const r = new Response(body, { status, headers });
  Object.defineProperty(r, 'url', { value: responseUrl });
  Object.defineProperty(r, 'redirected', { value: redirected });
  return r;
}
function metadata(url, mutate = (value) => value) {
  const path = new URL(url).pathname;
  if (path === '/mcp') return response(url, null, { status: 401,
    headers: { 'www-authenticate': `Bearer resource_metadata="${canonical}/.well-known/oauth-protected-resource/mcp"` } });
  let value = path === '/.well-known/oauth-authorization-server' ? {
    issuer: canonical, authorization_endpoint: canonical + '/oauth/authorize', token_endpoint: canonical + '/oauth/token',
    registration_endpoint: canonical + '/oauth/register', response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['jobs.act'],
  } : { resource: canonical + '/mcp', authorization_servers: [canonical], scopes_supported: ['jobs.act'] };
  return response(url, JSON.stringify(mutate(value)), { headers: { 'content-type': 'application/json' } });
}
function harness(handler) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const overridden = handler?.(url, options);
    if (overridden !== undefined) return overridden;
    if (new URL(url).pathname === '/owner-app/app.js')
      return response(url, bundle, { headers: { 'content-type': 'text/javascript; charset=utf-8' } });
    return metadata(url);
  };
  return { calls, fetchImpl, resolver: async () => ['203.0.113.10'] };
}
const failed = (r, id) => r.checks.find((item) => item.id === id && !item.ok);

for (const variant of ['LF', 'CRLF', 'altered']) {
  test(`repository-relative canonical import accepts only pinned source: ${variant}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'transport-source-fixture-'));
    try {
      const scripts = join(root, 'scripts'); await mkdir(scripts);
      const checker = await readFile(new URL('./g1-transport-health.mjs', import.meta.url));
      const original = await readFile(new URL('./g1-preflight.mjs', import.meta.url), 'utf8');
      const lf = original.replace(/\r\n/g, '\n');
      const source = variant === 'CRLF' ? lf.replace(/\n/g, '\r\n') : variant === 'altered' ? lf + '\n// changed source\n' : lf;
      await writeFile(join(scripts, 'g1-transport-health.mjs'), checker);
      await writeFile(join(scripts, 'g1-preflight.mjs'), source);
      const imported = await import(pathToFileURL(join(scripts, 'g1-transport-health.mjs')).href);
      const h = harness(); let dnsCalls = 0;
      const result = await imported.checkTransport(fixture(), { ...h, resolver: async () => { dnsCalls += 1; return ['203.0.113.10']; } });
      assert.equal(result.healthy, variant !== 'altered');
      if (variant === 'altered') {
        assert.deepEqual(result.reasons, ['canonical_source_mismatch']);
        assert.equal(h.calls.length, 0); assert.equal(dnsCalls, 0);
      } else {
        assert.equal(result.canonical_readiness.passed, 22); assert.equal(h.calls.length, 6);
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('normalization preserves bare CR, BOM, whitespace and arbitrary bytes as significant', async () => {
  const source = Buffer.from((await readFile(new URL('./g1-preflight.mjs', import.meta.url), 'utf8')).replace(/\r\n/g, '\n'));
  assert.equal(canonicalSourceMatches(source), true);
  assert.equal(canonicalSourceMatches(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), source])), false);
  assert.equal(canonicalSourceMatches(Buffer.concat([source, Buffer.from('\r')])), false);
  assert.equal(canonicalSourceMatches(Buffer.concat([source, Buffer.from(' ')])), false);
  assert.equal(canonicalSourceMatches(Buffer.concat([source, Buffer.from([0xff])])), false);
});

test('complete contract uses only six fixed unauthenticated GETs and canonical 22 checks', async () => {
  const h = harness(); const r = await checkTransport(fixture(), h);
  assert.equal(r.healthy, true); assert.equal(r.g1_pass, false);
  assert.deepEqual(r.canonical_readiness, { ready: true, passed: 22, total: 22 });
  assert.equal(r.dns_configuration_verified, false);
  assert.equal(h.calls.length, 6);
  for (const { url, options } of h.calls) {
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'manual'); assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store'); assert.deepEqual(Object.keys(options.headers), ['Accept']);
    assert.ok([canonical, upstream].includes(new URL(url).origin));
    assert.equal(new URL(url).search, '');
  }
  assert.equal(h.calls.filter(({ url }) => url.startsWith(upstream)).length, 1);
  assert.ok(Number.isFinite(Date.parse(r.observed_at)));
});

test('DNS failure fails health despite alive PID and skips upstream HTTP', async () => {
  const h = harness(); h.resolver = async () => { throw new Error('sensitive resolver text'); };
  const r = await checkTransport(fixture(), { ...h, processObservation: () => ({ pid: 123, alive: true }) });
  assert.equal(r.healthy, false); assert.equal(failed(r, 'upstream.dns').reason, 'dns_failed');
  assert.equal(r.process_observation.alive, true); assert.equal(r.process_observation.affects_health, false);
  assert.equal(h.calls.some(({ url }) => url.startsWith(upstream)), false);
  assert.ok(!JSON.stringify(r).includes('sensitive resolver'));
});

test('public 530 fails even with a healthy upstream bundle and local-process observation', async () => {
  const h = harness((url) => url.startsWith(canonical) ? response(url, 'untrusted private error', { status: 530 }) : undefined);
  const r = await checkTransport(fixture(), { ...h, processObservation: () => ({ pid: 123, alive: true, localHealthy: true }) });
  assert.equal(r.healthy, false); assert.equal(r.canonical_readiness.ready, false);
  assert.equal(r.checks.find((item) => item.id === 'upstream.bundle.sha256').ok, true);
  assert.equal(failed(r, 'canonical.resource.root.response').status, 530);
  assert.ok(!JSON.stringify(r).includes('untrusted private error')); assert.ok(!JSON.stringify(r).includes('localHealthy'));
});

test('dead process observation does not negate healthy transport or claim host process ownership', async () => {
  const r = await checkTransport(fixture(), { ...harness(), processObservation: () => ({ pid: 123, alive: false }) });
  assert.equal(r.healthy, true); assert.equal(r.process_observation.alive, false);
});

test('upstream returns wrong bundle while canonical bundle matches', async () => {
  const h = harness((url) => url.startsWith(upstream) ? response(url, bundle + '\n// stale', { headers: { 'content-type': 'text/javascript' } }) : undefined);
  const r = await checkTransport(fixture(), h);
  assert.equal(r.healthy, false); assert.equal(failed(r, 'upstream.bundle.sha256').reason, 'bundle_hash_mismatch');
  assert.equal(r.checks.find((item) => item.id === 'canonical.bundle.sha256').ok, true);
});

test('matching expected hash still requires compiled receipt public key metadata', async () => {
  const m = fixture(); const wrongBundle = 'const keyId="different";'; m.deployment.bundle_sha256 = sha(wrongBundle);
  const h = harness((url) => url.endsWith('/app.js') ? response(url, wrongBundle, { headers: { 'content-type': 'text/javascript' } }) : undefined);
  const r = await checkTransport(m, h);
  assert.equal(r.healthy, false); assert.equal(failed(r, 'canonical.bundle.receipt_pin').reason, 'receipt_pin_missing');
  assert.equal(r.checks.find((item) => item.id === 'canonical.bundle.sha256').ok, true);
});

test('stale issuer is rejected without following its advertised endpoints', async () => {
  const h = harness((url) => url.endsWith('/oauth-authorization-server')
    ? metadata(url, (data) => ({ ...data, issuer: 'https://old-host.example', token_endpoint: 'https://old-host.example/oauth/token' })) : undefined);
  const r = await checkTransport(fixture(), h);
  assert.equal(r.healthy, false); assert.ok(failed(r, 'canonical.authorization.issuer'));
  assert.ok(h.calls.every(({ url }) => !url.includes('old-host')));
  assert.ok(!JSON.stringify(r).includes('old-host'));
});

test('wrong Bearer resource-metadata challenge fails readiness', async () => {
  const h = harness((url) => url.endsWith('/mcp') && !url.includes('.well-known')
    ? response(url, null, { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://wrong.example/?secret=value"' } }) : undefined);
  const r = await checkTransport(fixture(), h);
  assert.ok(failed(r, 'canonical.mcp.bearer_challenge')); assert.ok(!JSON.stringify(r).includes('secret=value'));
});

for (const route of ['/owner-app/app.js', '/.well-known/oauth-protected-resource']) {
  test(`redirect rejected with no follow-up for ${route}`, async () => {
    const h = harness((url) => url === canonical + route ? response(url, null, { status: 302, headers: { location: 'https://external.example/?token=private' } }) : undefined);
    const r = await checkTransport(fixture(), h);
    assert.equal(r.healthy, false); assert.ok(r.reasons.includes('redirect_rejected'));
    assert.ok(!JSON.stringify(r).includes('private')); assert.equal(h.calls.length, 6);
  });
}

for (const badUrl of ['https://evil.example/owner-app/app.js?token=private', canonical + '/owner-app/app.js?token=private', '']) {
  test(`unexpected response URL fails safely (${badUrl ? 'nonmatching' : 'missing'})`, async () => {
    const h = harness((url) => url === canonical + '/owner-app/app.js'
      ? response(url, bundle, { headers: { 'content-type': 'text/javascript' }, responseUrl: badUrl }) : undefined);
    const r = await checkTransport(fixture(), h);
    assert.equal(r.healthy, false); assert.ok(r.reasons.includes('unexpected_response_url'));
    assert.ok(!JSON.stringify(r).includes('token=private'));
  });
}

test('unexpected metadata response origin is rejected by wrapper around canonical helper', async () => {
  const h = harness((url) => url.endsWith('/oauth-authorization-server')
    ? response(url, '{}', { headers: { 'content-type': 'application/json' }, responseUrl: 'https://evil.example/meta' }) : undefined);
  const r = await checkTransport(fixture(), h);
  assert.equal(r.healthy, false); assert.ok(r.reasons.includes('unexpected_response_url'));
});

test('declared oversized bundle is rejected without reading its body', async () => {
  const m = fixture(); m.limits.max_bundle_bytes = 256;
  const h = harness((url) => url.startsWith(upstream)
    ? response(url, bundle, { headers: { 'content-type': 'text/javascript', 'content-length': '257' } }) : undefined);
  const r = await checkTransport(m, h); assert.equal(failed(r, 'upstream.bundle.response').reason, 'body_too_large');
});

test('chunked oversized bundle is bounded without trusting Content-Length', async () => {
  const m = fixture(); m.limits.max_bundle_bytes = 256;
  let cancelled = false;
  const h = harness((url) => url.startsWith(upstream) ? response(url, new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(128)); }, cancel() { cancelled = true; },
  }), { headers: { 'content-type': 'text/javascript' } }) : undefined);
  const r = await checkTransport(m, h);
  assert.equal(failed(r, 'upstream.bundle.response').reason, 'body_too_large'); assert.equal(cancelled, true);
});

test('metadata body bound remains enforced by canonical helper', async () => {
  const m = fixture(); m.limits.max_metadata_bytes = 128;
  const r = await checkTransport(m, harness()); assert.equal(r.healthy, false);
  assert.ok(r.reasons.includes('body_too_large'));
});

test('fetch that ignores abort cannot hold the result past its deadline', async () => {
  const m = fixture(); m.limits.timeout_ms = 25;
  const h = harness((url) => url.startsWith(upstream) ? new Promise(() => {}) : undefined);
  const start = Date.now(); const r = await checkTransport(m, h);
  assert.equal(failed(r, 'upstream.bundle.response').reason, 'timeout'); assert.ok(Date.now() - start < 1000);
});

test('body that stalls after headers cannot evade deadline', async () => {
  const m = fixture(); m.limits.timeout_ms = 25;
  const h = harness((url) => url.startsWith(upstream)
    ? response(url, new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/javascript' } }) : undefined);
  const start = Date.now(); const r = await checkTransport(m, h);
  assert.equal(failed(r, 'upstream.bundle.response').reason, 'timeout'); assert.ok(Date.now() - start < 1000);
});

test('DNS that ignores abort is bounded and cannot be rescued by PID', async () => {
  const m = fixture(); m.limits.timeout_ms = 25;
  const r = await checkTransport(m, { ...harness(), resolver: () => new Promise(() => {}), processObservation: () => ({ pid: 1, alive: true }) });
  assert.equal(failed(r, 'upstream.dns').reason, 'dns_timeout'); assert.equal(r.healthy, false);
});

test('fetch and process exceptions are projected without raw text', async () => {
  const h = harness(() => { throw new Error('token=super-private'); });
  const r = await checkTransport(fixture(), { ...h, processObservation: () => { throw new Error('cookie=private'); } });
  assert.equal(r.healthy, false); assert.equal(r.process_observation.reason, 'observation_failed');
  assert.ok(!JSON.stringify(r).includes('private'));
});

for (const [name, change] of [
  ['stale canonical origin', (m) => { m.canonical_origin = 'https://old.trycloudflare.com'; }],
  ['credentials in upstream', (m) => { m.upstream_origin = 'https://token@speedwrit-origin.aidenid.com'; }],
  ['query in upstream', (m) => { m.upstream_origin += '?token=private'; }],
  ['unapproved upstream domain', (m) => { m.upstream_origin = 'https://external.example'; }],
  ['loop to canonical', (m) => { m.upstream_origin = canonical; }],
  ['missing image attribution', (m) => { delete m.deployment.image_digest; }],
  ['unknown secret field', (m) => { m.secret = 'private'; }],
  ['invalid key identity', (m) => { m.receipt_pin.key_id = '9'.repeat(16); }],
  ['unbounded timeout', (m) => { m.limits.timeout_ms = 10001; }],
]) {
  test(`manifest rejects ${name} before network`, async () => {
    const m = fixture(); change(m); const h = harness();
    const r = await checkTransport(m, h);
    assert.deepEqual(r.reasons, ['invalid_manifest']); assert.equal(h.calls.length, 0);
    assert.ok(!JSON.stringify(r).includes('private'));
  });
}

test('example is intentionally incomplete with no durable fallback defaults', async () => {
  const m = JSON.parse(await readFile(new URL('../deploy/transport-health/manifest.example.json', import.meta.url), 'utf8'));
  assert.throws(() => validateManifest(m), /invalid_manifest/);
});

test('CLI valid explicit manifest has a structured result; malformed file has fixed error only', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'transport-fixture-'));
  try {
    const path = join(dir, 'manifest.json'); await writeFile(path, JSON.stringify(fixture()));
    const out = []; const code = await runCli(['--manifest', path], { ...harness(), write: (s) => out.push(JSON.parse(s)) });
    assert.equal(code, 0); assert.equal(out[0].healthy, true);
    await writeFile(path, 'token=private'); const bad = [];
    assert.equal(await runCli(['--manifest', path], { ...harness(), write: (s) => bad.push(s) }), 1);
    assert.ok(!bad.join('').includes('private'));
    await writeFile(path, 'x'.repeat(16_385));
    assert.equal(await runCli(['--manifest', path], { ...harness(), write() {} }), 1);
    assert.equal(await runCli(['--manifest', dir], { ...harness(), write() {} }), 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
