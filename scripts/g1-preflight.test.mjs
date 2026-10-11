import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkReadiness, runCli, validateOrigin } from './g1-preflight.mjs';

const HOST = 'https://speedwrit.example';
const ROOT = '/.well-known/oauth-protected-resource';
const AUTH = '/.well-known/oauth-authorization-server';

function fixture(overrides = {}) {
  const resource = {
    resource: `${HOST}/mcp`, authorization_servers: [HOST], scopes_supported: ['jobs.act'],
  };
  const auth = {
    issuer: HOST,
    authorization_endpoint: `${HOST}/oauth/authorize`,
    token_endpoint: `${HOST}/oauth/token`,
    registration_endpoint: `${HOST}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: ['jobs.act'],
    authorization_response_iss_parameter_supported: true,
  };
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const path = new URL(url).pathname;
    if (overrides[path]) return overrides[path](options);
    if (path === '/mcp') return new Response(null, {
      status: 401, headers: { 'WWW-Authenticate': `Bearer resource_metadata="${HOST}${ROOT}"` },
    });
    if (path === ROOT || path === `${ROOT}/mcp`) return Response.json(resource);
    if (path === AUTH) return Response.json(auth);
    throw new Error('Unexpected fixture path');
  };
  return { fetchImpl, calls, resource, auth };
}

function failed(result, id, error) {
  assert.equal(result.ready, false);
  const check = result.checks.find((item) => item.id === id);
  assert.equal(check?.ok, false, `Expected failing check ${id}`);
  if (error) assert.equal(check.error, error);
}

test('conforming documents and challenge establish readiness, never a G1 pass', async () => {
  const server = fixture();
  const result = await checkReadiness(HOST, server);
  assert.equal(result.ready, true);
  assert.equal(result.readiness_only, true);
  assert.equal(result.g1_pass, false);
  assert.deepEqual(server.calls.map(({ url }) => url).sort(), [
    `${HOST}${ROOT}`, `${HOST}${ROOT}/mcp`, `${HOST}${AUTH}`, `${HOST}/mcp`,
  ].sort());
  for (const { options } of server.calls) {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.body, undefined);
    assert.equal(new Headers(options.headers).has('authorization'), false);
  }
});

test('issuer and resource must match the supplied origin exactly', async () => {
  const server = fixture();
  server.auth.issuer = `${HOST}/`;
  server.resource.resource = 'https://another.example/mcp';
  server.resource.authorization_servers = ['https://another.example'];
  const result = await checkReadiness(HOST, server);
  failed(result, 'authorization.issuer');
  failed(result, 'resource.root.resource');
  failed(result, 'resource.mcp.authorization_servers');
});

test('metadata endpoints, supported capabilities and scopes follow the contract', async () => {
  const server = fixture();
  server.auth.token_endpoint = `${HOST}/secret-token-path`;
  server.auth.grant_types_supported = ['authorization_code'];
  server.auth.code_challenge_methods_supported = ['plain'];
  server.auth.token_endpoint_auth_methods_supported = ['client_secret_basic'];
  server.auth.scopes_supported.push('openid', 'profile', 'email');
  server.resource.scopes_supported.push('openid');
  const result = await checkReadiness(HOST, server);
  for (const id of ['token_endpoint', 'grant_types_supported', 'code_challenge_methods_supported',
    'token_endpoint_auth_methods_supported', 'scopes_supported']) failed(result, `authorization.${id}`);
  failed(result, 'resource.root.scopes');
  assert.equal(JSON.stringify(result).includes('secret-token-path'), false);
});

test('resource aliases serve the same document independent of key order', async () => {
  const server = fixture({ [`${ROOT}/mcp`]: () => Response.json({
    scopes_supported: ['jobs.act'], authorization_servers: [HOST], resource: `${HOST}/mcp`,
  }) });
  assert.equal((await checkReadiness(HOST, server)).ready, true);
  server.resource.extension = 'root-only';
  failed(await checkReadiness(HOST, server), 'resource.alias_consistency');
});

test('all metadata endpoints require a JSON media type without exposing header values', async () => {
  for (const path of [ROOT, `${ROOT}/mcp`, AUTH]) {
    for (const contentType of [null, 'text/plain', 'text/html; secret=header-value', 'application/jsonp']) {
      const server = fixture({ [path]: () => {
        const response = Response.json(path === AUTH ? server.auth : server.resource);
        if (contentType === null) response.headers.delete('content-type');
        else response.headers.set('content-type', contentType);
        return response;
      } });
      const result = await checkReadiness(HOST, server);
      const id = path === AUTH ? 'authorization' : path === ROOT ? 'resource.root' : 'resource.mcp';
      failed(result, `${id}.response`, 'invalid_json_content_type');
      assert.equal(JSON.stringify(result).includes('header-value'), false);
    }
  }
});

test('JSON media types support charset parameters, case differences, and structured JSON suffixes', async () => {
  for (const contentType of ['application/json; charset=utf-8', 'Application/JSON',
    'application/oauth-metadata+json', 'application/vnd.example.metadata+json; charset=utf-8']) {
    const server = fixture({ [ROOT]: () => new Response(JSON.stringify(server.resource), {
      headers: { 'content-type': contentType },
    }) });
    assert.equal((await checkReadiness(HOST, server)).ready, true);
  }
});

test('issuer identification allows boolean values or an omitted fallback flag', async () => {
  for (const value of [true, false, undefined]) {
    const server = fixture();
    if (value === undefined) delete server.auth.authorization_response_iss_parameter_supported;
    else server.auth.authorization_response_iss_parameter_supported = value;
    assert.equal((await checkReadiness(HOST, server)).ready, true);
  }
});

test('issuer identification rejects non-boolean values without disclosing them', async () => {
  for (const value of [null, 0, 1, 'true-secret', [], {}]) {
    const server = fixture();
    server.auth.authorization_response_iss_parameter_supported = value;
    const result = await checkReadiness(HOST, server);
    failed(result, 'authorization.issuer_identification_flag', 'invalid_issuer_identification_flag');
    assert.equal(JSON.stringify(result).includes('true-secret'), false);
  }
});

test('redirects fail without following or reporting their destination', async () => {
  const server = fixture({ [ROOT]: () => new Response(null, {
    status: 302, headers: { Location: 'https://other.example/mcp/c/secret-path' },
  }) });
  const result = await checkReadiness(HOST, server);
  failed(result, 'resource.root.response', 'redirect_rejected');
  assert.equal(server.calls.length, 4);
  assert.equal(JSON.stringify(result).includes('secret-path'), false);
});

test('unexpected statuses fail, including an unprotected MCP endpoint', async () => {
  const server = fixture({ [AUTH]: () => new Response(null, { status: 503 }),
    '/mcp': () => Response.json({ potentially: 'sensitive-body' }),
  });
  const result = await checkReadiness(HOST, server);
  failed(result, 'authorization.response', 'unexpected_status');
  failed(result, 'mcp.unauthenticated_response', 'unexpected_status');
  assert.equal(result.checks.find(({ id }) => id === 'authorization.response').status, 503);
  assert.equal(JSON.stringify(result).includes('sensitive-body'), false);
});

test('deadline covers a fetch that ignores cancellation', async () => {
  let signal;
  const server = fixture({ [ROOT]: (options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  const result = await checkReadiness(HOST, { ...server, timeoutMs: 15 });
  failed(result, 'resource.root.response', 'timeout');
  assert.equal(signal.aborted, true);
});

test('deadline also covers a stalled response body', async () => {
  const server = fixture({ [ROOT]: () => new Response(new ReadableStream({
    pull() { return new Promise(() => {}); },
  }), { headers: { 'content-type': 'application/json' } }) });
  failed(await checkReadiness(HOST, { ...server, timeoutMs: 15 }), 'resource.root.response', 'timeout');
});

test('rejected fetch errors are redacted', async () => {
  const server = fixture({ [ROOT]: () => { throw new Error('Bearer secret-token /mcp/c/secret-path'); } });
  const result = await checkReadiness(HOST, server);
  failed(result, 'resource.root.response', 'request_failed');
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('invalid origins are rejected before any network request', async () => {
  const server = fixture();
  for (const input of [undefined, '', 'http://speedwrit.example', 'https://user:password@speedwrit.example',
    `${HOST}/mcp`, `${HOST}?token=secret`, `${HOST}#secret`, `${HOST}?`, `${HOST}#`,
    `${HOST}/../`, ` ${HOST}`, `${HOST}\n`, 'https://speedwrit.example\\path']) {
    failed(await checkReadiness(input, server), 'origin', 'invalid_origin');
  }
  assert.equal(server.calls.length, 0);
  assert.equal(validateOrigin(`${HOST}/`), HOST);
  assert.equal(validateOrigin('https://speedwrit.example:8443'), 'https://speedwrit.example:8443');
});

test('either exact resource metadata alias is accepted in the Bearer challenge', async () => {
  for (const path of [ROOT, `${ROOT}/mcp`]) {
    const server = fixture({ '/mcp': () => new Response(null, { status: 401, headers: {
      'www-authenticate': `bEaReR realm="demo, readiness", resource_metadata="${HOST}${path}"`,
    } }) });
    assert.equal((await checkReadiness(HOST, server)).ready, true);
  }
});

test('missing, malformed, duplicate, or wrong-origin challenges fail without leaking data', async () => {
  for (const challenge of ['', 'Basic realm="demo"', 'Bearer error="invalid_token"',
    `Bearer resource_metadata="https://wrong.example${ROOT}"`,
    `Bearer resource_metadata="${HOST}/mcp/c/secret"`,
    `Bearer resource_metadata="${HOST}${ROOT}", resource_metadata="${HOST}${ROOT}"`,
    `Bearer resource_metadata="${HOST}${ROOT}",`]) {
    const server = fixture({ '/mcp': () => new Response(null, {
      status: 401, headers: { 'www-authenticate': challenge },
    }) });
    const result = await checkReadiness(HOST, server);
    failed(result, 'mcp.bearer_challenge', 'invalid_bearer_challenge');
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
});

test('malformed JSON and non-object metadata fail safely', async () => {
  for (const [body, error] of [['secret invalid JSON', 'invalid_json'], ['[]', 'invalid_json_object'],
    ['null', 'invalid_json_object'], ['"secret-string"', 'invalid_json_object']]) {
    const server = fixture({ [ROOT]: () => new Response(body, { headers: { 'content-type': 'application/json' } }) });
    const result = await checkReadiness(HOST, server);
    failed(result, 'resource.root.response', error);
    assert.equal(JSON.stringify(result).includes('secret'), false);
  }
});

test('response size is bounded by actual bytes even without Content-Length', async () => {
  const server = fixture({ [ROOT]: () => Response.json({ huge: '🧪'.repeat(17_000) }) });
  failed(await checkReadiness(HOST, server), 'resource.root.response', 'body_too_large');
});

test('oversized Content-Length fails without reading the body', async () => {
  const server = fixture({ [ROOT]: () => Response.json({}, { headers: { 'content-length': '65537' } }) });
  failed(await checkReadiness(HOST, server), 'resource.root.response', 'body_too_large');
});

test('CLI supports positional and --host origins and returns a failing exit code on errors', async () => {
  for (const args of [[HOST], ['--host', HOST]]) {
    const output = [];
    assert.equal(await runCli(args, { ...fixture(), write: (line) => output.push(line) }), 0);
    assert.equal(JSON.parse(output[0]).ready, true);
    assert.equal(JSON.parse(output[0]).g1_pass, false);
  }
  for (const args of [[], ['--host'], [HOST, HOST], ['--host', `${HOST}/mcp/c/secret`]]) {
    const output = [];
    const server = fixture();
    assert.equal(await runCli(args, { ...server, write: (line) => output.push(line) }), 1);
    assert.equal(JSON.parse(output[0]).ready, false);
    assert.equal(output[0].includes('secret'), false);
    assert.equal(server.calls.length, 0);
  }
});

test('invalid request limits fail before fetching', async () => {
  const server = fixture();
  failed(await checkReadiness(HOST, { ...server, timeoutMs: 0 }), 'configuration', 'invalid_configuration');
  failed(await checkReadiness(HOST, { ...server, maxBodyBytes: Infinity }), 'configuration', 'invalid_configuration');
  assert.equal(server.calls.length, 0);
});
