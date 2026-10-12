#!/usr/bin/env node
// Public, read-only transport checks. No account credentials or private runtime config.
import { createHash } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { constants as fsConstants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CANONICAL_SOURCE = Object.freeze({
  repository: 'https://github.com/mrrCarter/SpeedWrit',
  revision: '653d1571c109b95db27a0fd3247c5bfe03abb889',
  path: 'scripts/g1-preflight.mjs',
  normalized_lf_sha256: 'ba7b8dee1923ccb4a07b595a100cc7585d241f899e8ea99936ac9b913acf690f',
  normalization: 'CRLF_to_LF_only',
});
const CANONICAL_ORIGIN = 'https://speedwrit.aidenid.com';
export const PUBLIC_DNS_SERVERS = Object.freeze(['1.1.1.1', '8.8.8.8']);
const BUNDLE_PATH = '/owner-app/app.js';
const METADATA_PATHS = new Set([
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server',
  '/mcp',
]);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
/** Preserve every byte except CR immediately followed by LF; never trim or decode source. */
export function canonicalSourceMatches(source) {
  if (!(source instanceof Uint8Array)) return false;
  const normalized = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === 13 && source[index + 1] === 10) continue;
    normalized.push(source[index]);
  }
  return sha256(Buffer.from(normalized)) === CANONICAL_SOURCE.normalized_lf_sha256;
}
const hex = (value, length) => typeof value === 'string' && new RegExp(`^[0-9a-f]{${length}}$`).test(value) && !/^0+$/.test(value);
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function origin(value) {
  if (typeof value !== 'string') throw new Error('invalid_manifest');
  const url = new URL(value);
  if (value !== url.origin || url.protocol !== 'https:' || url.port || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || isIP(url.hostname)) throw new Error('invalid_manifest');
  return url;
}

/** No deployment/image/bundle defaults: every release supplies its packaged artifact values. */
export function validateManifest(value) {
  try {
    if (!exactKeys(value, ['schema_version', 'canonical_origin', 'upstream_origin', 'deployment', 'receipt_pin', 'limits']) ||
        value.schema_version !== 1 || value.canonical_origin !== CANONICAL_ORIGIN) throw new Error();
    origin(value.canonical_origin);
    const upstream = origin(value.upstream_origin);
    if (value.upstream_origin === value.canonical_origin ||
        !/^[a-z0-9-]+\.(?:trycloudflare\.com|aidenid\.com)$/.test(upstream.hostname)) throw new Error();
    const d = value.deployment;
    if (!exactKeys(d, ['repository', 'runtime_revision', 'image_digest', 'bundle_sha256', 'bundle_source']) ||
        d.repository !== CANONICAL_SOURCE.repository || !hex(d.runtime_revision, 40) ||
        typeof d.image_digest !== 'string' || !d.image_digest.startsWith('sha256:') || !hex(d.image_digest.slice(7), 64) ||
        !hex(d.bundle_sha256, 64) || d.bundle_source !== '/app/packages/job-send-ui/dist/owner-app/app.js') throw new Error();
    const pin = value.receipt_pin;
    if (!exactKeys(pin, ['key_id', 'public_key_b64url']) || !hex(pin.key_id, 16) ||
        typeof pin.public_key_b64url !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(pin.public_key_b64url)) throw new Error();
    const bytes = Buffer.from(pin.public_key_b64url, 'base64url');
    if (bytes.length !== 32 || bytes.toString('base64url') !== pin.public_key_b64url ||
        sha256(bytes).slice(0, 16) !== pin.key_id) throw new Error();
    const limits = value.limits;
    if (!exactKeys(limits, ['timeout_ms', 'max_metadata_bytes', 'max_bundle_bytes']) ||
        !Number.isInteger(limits.timeout_ms) || limits.timeout_ms < 1 || limits.timeout_ms > 10_000 ||
        !Number.isInteger(limits.max_metadata_bytes) || limits.max_metadata_bytes < 1 || limits.max_metadata_bytes > 65_536 ||
        !Number.isInteger(limits.max_bundle_bytes) || limits.max_bundle_bytes < 1 || limits.max_bundle_bytes > 8_388_608) throw new Error();
    return JSON.parse(JSON.stringify(value));
  } catch { throw new Error('invalid_manifest'); }
}

function cancel(response) {
  try { response?.body?.cancel().catch(() => {}); } catch { /* best effort */ }
}
function check(id, ok, reason, extra = {}) {
  return { id, ok, ...(ok ? {} : { reason }), ...extra };
}
function fixedFailure(id, reason) { return check(id, false, reason); }

/** Public DNS only; isolated cancellation and no fallback to OS-discovered servers. */
export async function resolveAddresses(hostname, { signal, resolverFactory = () => new Resolver() } = {}) {
  const resolver = resolverFactory();
  resolver.setServers([...PUBLIC_DNS_SERVERS]);
  const abort = () => resolver.cancel();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new Error('dns_failed');
    const results = await Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]);
    return results.flatMap((result) => result.status === 'fulfilled' ? result.value : []);
  } finally { signal?.removeEventListener('abort', abort); }
}

async function dnsCheck(hostname, timeoutMs, resolver) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((done) => {
    timer = setTimeout(() => { controller.abort(); done(fixedFailure('upstream.dns', 'dns_timeout')); }, timeoutMs);
  });
  const work = (async () => {
    try {
      const values = await resolver(hostname, { signal: controller.signal });
      if (!Array.isArray(values) || !values.length || values.some((value) => typeof value !== 'string' || !isIP(value)))
        return fixedFailure('upstream.dns', 'dns_failed');
      return check('upstream.dns', true, null, { address_count: new Set(values).size });
    } catch { return fixedFailure('upstream.dns', 'dns_failed'); }
  })();
  try { return await Promise.race([work, deadline]); } finally { clearTimeout(timer); }
}

function makeFetchGuard(manifest, fetchImpl, responseErrors) {
  return async (value, options) => {
    const url = new URL(value);
    const validPath = url.pathname === BUNDLE_PATH ||
      (url.origin === manifest.canonical_origin && METADATA_PATHS.has(url.pathname));
    if (![manifest.canonical_origin, manifest.upstream_origin].includes(url.origin) || !validPath ||
        url.username || url.password || url.search || url.hash || options.method !== 'GET' ||
        options.redirect !== 'manual' || options.credentials !== 'omit') throw new Error('request_guard');
    // Do not inherit caller headers or credentials, even if an injected implementation supplied them.
    const response = await fetchImpl(url.href, {
      method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store',
      headers: { Accept: url.pathname === BUNDLE_PATH ? 'application/javascript' : 'application/json, text/event-stream' },
      signal: options.signal,
    });
    if (!response || response.redirected || (response.status >= 300 && response.status < 400)) {
      cancel(response); responseErrors.add('redirect_rejected'); throw new Error('redirect_rejected');
    }
    // Native fetch returns this even for manual redirects. Require exact URL, not only a matching host.
    if (response.url !== url.href) {
      cancel(response); responseErrors.add('unexpected_response_url'); throw new Error('unexpected_response_url');
    }
    return response;
  };
}

async function bundleCheck(id, url, manifest, fetchImpl) {
  const controller = new AbortController();
  let timer, response, timedOut = false;
  const deadline = new Promise((done) => {
    timer = setTimeout(() => {
      timedOut = true; controller.abort(); cancel(response);
      done([fixedFailure(`${id}.response`, 'timeout')]);
    }, manifest.limits.timeout_ms);
  });
  const work = (async () => {
    try {
      response = await fetchImpl(url, { method: 'GET', redirect: 'manual', credentials: 'omit', signal: controller.signal });
      if (timedOut) { cancel(response); return [fixedFailure(`${id}.response`, 'timeout')]; }
      if (response.status !== 200) {
        cancel(response);
        return [check(`${id}.response`, false, 'unexpected_status', { status: response.status })];
      }
      const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
      if (!['application/javascript', 'text/javascript', 'application/ecmascript', 'text/ecmascript'].includes(mediaType)) {
        cancel(response); return [fixedFailure(`${id}.response`, 'invalid_content_type')];
      }
      const declaredLength = response.headers.get('content-length');
      const limit = manifest.limits.max_bundle_bytes;
      if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > limit) {
        cancel(response); return [fixedFailure(`${id}.response`, 'body_too_large')];
      }
      if (!response.body) return [fixedFailure(`${id}.response`, 'missing_body')];
      const reader = response.body.getReader();
      const chunks = []; let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > limit) {
            reader.cancel().catch(() => {});
            return [fixedFailure(`${id}.response`, 'body_too_large')];
          }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = Buffer.concat(chunks, size);
      const digest = sha256(bytes);
      const text = bytes.toString('utf8');
      return [
        check(`${id}.response`, true, null, { bytes: size }),
        check(`${id}.sha256`, digest === manifest.deployment.bundle_sha256, 'bundle_hash_mismatch', { observed_sha256: digest }),
        check(`${id}.receipt_pin`, text.includes(manifest.receipt_pin.key_id) && text.includes(manifest.receipt_pin.public_key_b64url), 'receipt_pin_missing'),
      ];
    } catch { return [fixedFailure(`${id}.response`, timedOut ? 'timeout' : 'request_failed')]; }
  })();
  try { return await Promise.race([work, deadline]); } finally { clearTimeout(timer); }
}

async function canonicalChecker() {
  const url = new URL('./g1-preflight.mjs', import.meta.url);
  if (!canonicalSourceMatches(await readFile(url))) throw new Error('canonical_source_mismatch');
  return (await import(url.href)).checkReadiness;
}

export function observePid(pid) {
  if (!Number.isInteger(pid) || pid < 1 || pid > 2_147_483_647) throw new Error('invalid_pid');
  try { process.kill(pid, 0); return { pid, alive: true }; }
  catch (error) { return { pid, alive: error?.code === 'ESRCH' ? false : null }; }
}

/** Dependencies exist solely for offline tests. CLI uses fixed public-only implementations. */
export async function checkTransport(input, {
  fetchImpl = globalThis.fetch, resolver = resolveAddresses, resolverFactory, processObservation = null,
  now = () => new Date().toISOString(),
} = {}) {
  const started = Date.now();
  const timestamp = now();
  const base = { schema_version: 1, observed_at: timestamp, readiness_only: true, g1_pass: false };
  let manifest;
  try { manifest = validateManifest(input); }
  catch { return { ...base, healthy: false, reasons: ['invalid_manifest'], checks: [] }; }
  let checkReadiness;
  try { checkReadiness = await canonicalChecker(); }
  catch { return { ...base, healthy: false, reasons: ['canonical_source_mismatch'], checks: [] }; }
  const responseErrors = new Set();
  const safeFetch = makeFetchGuard(manifest, fetchImpl, responseErrors);
  const dns = dnsCheck(new URL(manifest.upstream_origin).hostname, manifest.limits.timeout_ms,
    (hostname, options) => resolver(hostname, { ...options, resolverFactory }));
  const readiness = checkReadiness(manifest.canonical_origin, {
    fetchImpl: safeFetch, timeoutMs: manifest.limits.timeout_ms, maxBodyBytes: manifest.limits.max_metadata_bytes,
  });
  const [dnsResult, canonicalResult, canonicalBundle, upstreamBundle] = await Promise.all([
    dns, readiness,
    bundleCheck('canonical.bundle', manifest.canonical_origin + BUNDLE_PATH, manifest, safeFetch),
    dns.then((result) => result.ok
      ? bundleCheck('upstream.bundle', manifest.upstream_origin + BUNDLE_PATH, manifest, safeFetch)
      : [fixedFailure('upstream.bundle.response', 'skipped_dns_failure')]),
  ]);
  const checks = [dnsResult, ...canonicalResult.checks.map(({ id, ok, error, status }) =>
    check(`canonical.${id}`, ok, error, status === undefined ? {} : { status })),
    ...canonicalBundle, ...upstreamBundle,
    ...[...responseErrors].sort().map((reason) => fixedFailure('transport.response_guard', reason)),
  ];
  let processResult = { supplied: false, affects_health: false };
  if (processObservation !== null) {
    try {
      // Observation is synchronous and may only return this fixed metadata shape.
      const p = processObservation();
      if (!p || !Number.isInteger(p.pid) || p.pid < 1 || p.pid > 2_147_483_647 || ![true, false, null].includes(p.alive)) throw new Error();
      processResult = { supplied: true, pid: p.pid, alive: p.alive, affects_health: false };
    } catch { processResult = { supplied: true, alive: null, affects_health: false, reason: 'observation_failed' }; }
  }
  return {
    ...base, completed_at: now(), duration_ms: Date.now() - started,
    healthy: checks.every((item) => item.ok),
    reasons: [...new Set(checks.filter((item) => !item.ok).map((item) => item.reason))],
    expected_deployment: manifest.deployment,
    canonical_readiness: { ready: canonicalResult.ready, passed: canonicalResult.checks.filter((item) => item.ok).length, total: canonicalResult.checks.length },
    process_observation: processResult,
    dns_servers: [...PUBLIC_DNS_SERVERS],
    dns_configuration_verified: false,
    canonical_source: CANONICAL_SOURCE,
    checks,
  };
}

export async function runCli(args, { write = console.log, ...dependencies } = {}) {
  if (args.length === 1 && args[0] === '--help') {
    write(JSON.stringify({ usage: 'node scripts/g1-transport-health.mjs --manifest DEPLOYMENT.json [--pid PID]', public_get_only: true })); return 0;
  }
  try {
    if (![2, 4].includes(args.length) || args[0] !== '--manifest' || !args[1] ||
        (args.length === 4 && (args[2] !== '--pid' || !/^[1-9][0-9]{0,9}$/.test(args[3])))) throw new Error();
    const file = await open(args[1], fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0));
    let bytes;
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size > 16_384) throw new Error();
      const buffer = Buffer.alloc(16_385);
      let count = 0;
      while (count < buffer.length) {
        const result = await file.read(buffer, count, buffer.length - count, null);
        if (!result.bytesRead) break;
        count += result.bytesRead;
      }
      if (count > 16_384) throw new Error();
      bytes = buffer.subarray(0, count);
    } finally { await file.close(); }
    const pid = args.length === 4 ? Number(args[3]) : null;
    if (pid !== null && pid > 2_147_483_647) throw new Error();
    const result = await checkTransport(JSON.parse(bytes.toString('utf8')), {
      ...dependencies, ...(pid === null ? {} : { processObservation: () => observePid(pid) }),
    });
    write(JSON.stringify(result)); return result.healthy ? 0 : 1;
  } catch {
    write(JSON.stringify({ readiness_only: true, g1_pass: false, healthy: false, reasons: ['invalid_arguments_or_manifest_file'] })); return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
