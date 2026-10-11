#!/usr/bin/env node
// Node 22+. Readiness only: this does not exercise consent, tokens, or MCP tools.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const RESOURCE_PATHS = [
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
];
const AUTH_PATH = '/.well-known/oauth-authorization-server';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BODY_BYTES = 65_536;

/** Require a canonical HTTPS origin; never accept credentials or secret paths. */
export function validateOrigin(value) {
  if (typeof value !== 'string') throw new Error('invalid_origin');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('invalid_origin');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search ||
      url.hash || url.pathname !== '/' ||
      (value !== url.origin && value !== `${url.origin}/`)) {
    throw new Error('invalid_origin');
  }
  return url.origin;
}

function cancelBody(response) {
  // Cancellation is best effort; an uncooperative stream cannot delay the result.
  try { response.body?.cancel().catch(() => {}); } catch { /* No body to cancel. */ }
}

async function readJson(response, maxBodyBytes) {
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim();
  if (!mediaType || !/^application\/(?:json|[!#$%&'*+.^_`|~0-9A-Za-z-]+\+json)$/i.test(mediaType)) {
    cancelBody(response);
    return { ok: false, error: 'invalid_json_content_type' };
  }
  const length = response.headers.get('content-length');
  if (length !== null && /^\d+$/.test(length) && Number(length) > maxBodyBytes) {
    cancelBody(response);
    return { ok: false, error: 'body_too_large' };
  }
  if (!response.body) return { ok: false, error: 'invalid_json' };
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBodyBytes) {
        reader.cancel().catch(() => {});
        return { ok: false, error: 'body_too_large' };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.concat(chunks, bytes),
    ));
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, error: 'invalid_json_object' };
    }
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
}

async function request(url, kind, { fetchImpl, timeoutMs, maxBodyBytes }) {
  const controller = new AbortController();
  let timedOut = false;
  let response;
  let timer;
  const deadline = new Promise((done) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      if (response) cancelBody(response);
      done({ ok: false, error: 'timeout' });
    }, timeoutMs);
  });
  const operation = (async () => {
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
        headers: { Accept: kind === 'metadata' ? 'application/json' : 'application/json, text/event-stream' },
        signal: controller.signal,
      });
      if (timedOut) {
        cancelBody(response);
        return { ok: false, error: 'timeout' };
      }
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        cancelBody(response);
        return { ok: false, error: 'redirect_rejected' };
      }
      const expectedStatus = kind === 'metadata' ? 200 : 401;
      if (response.status !== expectedStatus) {
        cancelBody(response);
        return { ok: false, error: 'unexpected_status', status: response.status };
      }
      if (kind === 'challenge') {
        const challenge = response.headers.get('www-authenticate');
        cancelBody(response);
        return { ok: true, challenge };
      }
      return await readJson(response, maxBodyBytes);
    } catch {
      // Fetch errors can contain credentials or paths; only emit fixed codes.
      return { ok: false, error: timedOut ? 'timeout' : 'request_failed' };
    }
  })();
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

function sameValues(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    expected.every((value) => actual.includes(value));
}

function challengeMetadata(header) {
  if (typeof header !== 'string' || header.length > 8_192 || !/^Bearer[ \t]+/i.test(header)) return null;
  let rest = header.replace(/^Bearer[ \t]+/i, '');
  const parameters = new Map();
  // Parse auth-params without treating commas inside quoted values as separators.
  while (rest) {
    const match = /^[ \t]*([!#$%&'*+.^_`|~0-9A-Za-z-]+)[ \t]*=[ \t]*(?:"((?:[^"\\\r\n]|\\[^\r\n])*)"|([!#$%&'*+.^_`|~0-9A-Za-z-]+))[ \t]*(,|$)/.exec(rest);
    if (!match) return null;
    const name = match[1].toLowerCase();
    if (parameters.has(name)) return null;
    parameters.set(name, match[2] === undefined ? match[3] : match[2].replace(/\\(.)/g, '$1'));
    rest = rest.slice(match[0].length);
    if (match[4] === ',' && !rest) return null;
  }
  return parameters.get('resource_metadata') ?? null;
}

function report(checks) {
  return {
    readiness_only: true,
    g1_pass: false,
    ready: checks.every((check) => check.ok),
    checks,
  };
}

/** Only four predetermined public GETs; advertised URLs are never followed. */
export async function checkReadiness(host, options = {}) {
  let origin;
  try { origin = validateOrigin(host); } catch {
    return report([{ id: 'origin', ok: false, error: 'invalid_origin' }]);
  }
  const config = {
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
  };
  if (typeof config.fetchImpl !== 'function' ||
      !Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 30_000 ||
      !Number.isInteger(config.maxBodyBytes) || config.maxBodyBytes < 1 || config.maxBodyBytes > 1_048_576) {
    return report([{ id: 'configuration', ok: false, error: 'invalid_configuration' }]);
  }
  const results = await Promise.all([
    ...RESOURCE_PATHS.map((path) => request(`${origin}${path}`, 'metadata', config)),
    request(`${origin}${AUTH_PATH}`, 'metadata', config),
    request(`${origin}/mcp`, 'challenge', config),
  ]);
  const checks = [];
  function add(id, ok, error = 'contract_mismatch') {
    checks.push(ok ? { id, ok: true } : { id, ok: false, error });
  }
  function requestCheck(id, result) {
    const check = { id, ok: result.ok };
    if (!result.ok) {
      check.error = result.error;
      if (result.status !== undefined) check.status = result.status;
    }
    checks.push(check);
    return result.ok;
  }
  for (let i = 0; i < RESOURCE_PATHS.length; i += 1) {
    const id = i === 0 ? 'resource.root' : 'resource.mcp';
    if (!requestCheck(`${id}.response`, results[i])) continue;
    const data = results[i].data;
    add(`${id}.resource`, data.resource === `${origin}/mcp`);
    add(`${id}.authorization_servers`, sameValues(data.authorization_servers, [origin]));
    add(`${id}.scopes`, sameValues(data.scopes_supported, ['jobs.act']));
  }
  if (results[0].ok && results[1].ok) {
    add('resource.alias_consistency', isDeepStrictEqual(results[0].data, results[1].data));
  }
  if (requestCheck('authorization.response', results[2])) {
    const data = results[2].data;
    add('authorization.issuer', data.issuer === origin);
    for (const [property, path] of [
      ['authorization_endpoint', '/oauth/authorize'],
      ['token_endpoint', '/oauth/token'],
      ['registration_endpoint', '/oauth/register'],
    ]) add(`authorization.${property}`, data[property] === `${origin}${path}`);
    for (const [property, values] of [
      ['response_types_supported', ['code']],
      ['grant_types_supported', ['authorization_code', 'refresh_token']],
      ['code_challenge_methods_supported', ['S256']],
      ['token_endpoint_auth_methods_supported', ['none']],
      ['scopes_supported', ['jobs.act']],
    ]) add(`authorization.${property}`, sameValues(data[property], values));
    add('authorization.issuer_identification_flag',
      !Object.hasOwn(data, 'authorization_response_iss_parameter_supported') ||
        typeof data.authorization_response_iss_parameter_supported === 'boolean',
      'invalid_issuer_identification_flag');
  }
  if (requestCheck('mcp.unauthenticated_response', results[3])) {
    add('mcp.bearer_challenge', RESOURCE_PATHS.some((path) =>
      challengeMetadata(results[3].challenge) === `${origin}${path}`), 'invalid_bearer_challenge');
  }
  return report(checks);
}

export async function runCli(args, { write = console.log, ...options } = {}) {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    write(JSON.stringify({ usage: 'node scripts/g1-preflight.mjs HOST | --host HOST', readiness_only: true }));
    return 0;
  }
  const host = args.length === 1 && !args[0].startsWith('-') ? args[0]
    : args.length === 2 && args[0] === '--host' ? args[1] : null;
  const result = host === null
    ? report([{ id: 'arguments', ok: false, error: 'expected_https_origin_or_host_flag' }])
    : await checkReadiness(host, options);
  write(JSON.stringify(result));
  return result.ready ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
