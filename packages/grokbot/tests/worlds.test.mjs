import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createServer } from 'node:http';
import { createWorldsAdapter, loopbackOrigin, validateCall, TOOLS } from '../worlds/adapter.mjs';
import { parseTask, createXaiModel, runAgent } from '../worlds/runner.mjs';
import { readTaskInput, main } from '../worlds/cli.mjs';

const key = 'sk_twin_fixture000000000';
const task = { templateId: 'customer-desk', mission: { id: 'participant-custom-id', title: 'An independent task', prompt: 'Read ticket 17 and follow its policy.', policy: ['Only ticket 17 is in scope.'] } };
const call = (name, args, call_id = 'call_1') => ({ type: 'function_call', call_id, name, arguments: JSON.stringify(args) });
const response = (...output) => ({ status: 'completed', output });
const done = text => response({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
const fixture = outputs => async () => { assert.ok(outputs.length, 'fixture exhausted'); return outputs.shift(); };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const stubAdapter = () => ({ stats: {}, calls: [], async execute(name, args) { this.calls.push({ name, args }); return { ok: true }; } });

test('numeric loopback only; reject normalization, credentials, DNS, paths and redirects as destinations', () => {
  assert.equal(loopbackOrigin('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
  assert.equal(loopbackOrigin('http://[::1]:9011'), 'http://[::1]:9011');
  for (const value of ['http://localhost:8080', 'https://127.0.0.1:8080', 'http://127.1:8080', 'http://2130706433:8080', 'http://user@127.0.0.1:8080', 'http://127.0.0.1:8080/admin', 'http://127.0.0.1:8080?x=1', 'http://127.0.0.1:99999', 'http://127.0.0.1:80']) assert.throws(() => loopbackOrigin(value));
});
test('task projection omits hidden checks and supports custom mission IDs', () => {
  assert.deepEqual(parseTask(JSON.stringify({ ...task, checks: ['hidden'], seed: 'hidden', mission: { ...task.mission, adminToken: 'secret' } })), task);
  assert.throws(() => parseTask('x'.repeat(32769)));
  assert.throws(() => parseTask(JSON.stringify({ ...task, mission: { ...task.mission, policy: 'not an array' } })));
});
test('task can arrive through stdin without reading project files', async () => {
  assert.deepEqual(await readTaskInput({}, Readable.from([JSON.stringify(task), '\n'])), task);
  await assert.rejects(readTaskInput({}, Readable.from(['x'.repeat(32769)])), /task_invalid/);
});
test('tool schema refuses arbitrary paths, billing tools, extra fields and implicit comment visibility', () => {
  assert.equal(TOOLS.length, 4);
  for (const [name, args] of [['refund', {}], ['get_ticket', { ticket_id: '../admin' }], ['get_ticket', { ticket_id: '17', url: 'http://example.test' }], ['update_ticket', { ticket_id: '17', comment: { body: 'hello' } }], ['update_ticket', { ticket_id: '17' }], ['update_ticket', { ticket_id: '17', status: 'closed' }]]) assert.throws(() => validateCall(name, args));
});
test('adapter reads before writes, preserves patch shape, memoizes equivalent write, and redacts twin key', async () => {
  const requests = [];
  const adapter = createWorldsAdapter({ baseUrl: 'http://127.0.0.1:8080', apiKey: key, taskId: task.mission.id, fetchImpl: async (url, init) => { requests.push({ url, init }); return json({ ticket: { id: 17, status: init.method === 'PUT' ? 'solved' : 'open', note: key } }); } });
  await assert.rejects(adapter.execute('update_ticket', { ticket_id: '17', status: 'solved' }), /ticket_read_required/);
  const ticket = await adapter.execute('get_ticket', { ticket_id: '17' }); assert.equal(ticket.ticket.note, '[redacted]');
  await adapter.execute('update_ticket', { ticket_id: '17', status: 'solved', comment: { body: 'Fixture reply.', public: true } });
  await adapter.execute('update_ticket', { comment: { public: true, body: 'Fixture reply.' }, status: 'solved', ticket_id: '17' });
  assert.equal(requests.length, 2); assert.equal(adapter.stats.write_replays, 1);
  assert.deepEqual(JSON.parse(requests[1].init.body), { ticket: { status: 'solved', comment: { body: 'Fixture reply.', public: true } } });
  assert.equal(requests[1].init.redirect, 'manual'); assert.match(requests[1].init.headers['Idempotency-Key'], /^worlds-[a-f0-9]{64}$/);
  assert.equal(requests[1].init.headers.Authorization, `Bearer ${key}`);
});
test('an ambiguous write is not attempted again, including a new call ID', async () => {
  let puts = 0;
  const adapter = createWorldsAdapter({ baseUrl: 'http://127.0.0.1:8080', apiKey: key, taskId: 'id', fetchImpl: async (_url, init) => {
    if (init.method === 'PUT') { puts++; throw Error('sensitive transport detail'); } return json({ ticket: { id: 17 } });
  } });
  await adapter.execute('get_ticket', { ticket_id: '17' });
  for (let i = 0; i < 2; i++) await assert.rejects(adapter.execute('update_ticket', { ticket_id: '17', status: 'solved' }), /^WorldsError: worlds_write_unconfirmed$/);
  assert.equal(puts, 1);
});
test('malformed or wrong-ticket write acknowledgement stays unconfirmed and cannot be retried', async () => {
  for (const acknowledgement of [{}, { ticket: { id: 999 } }]) {
    let puts = 0;
    const adapter = createWorldsAdapter({ baseUrl: 'http://127.0.0.1:8080', apiKey: key, taskId: 'id', fetchImpl: async (_url, init) => {
      if (init.method === 'PUT') { puts++; return json(acknowledgement); } return json({ ticket: { id: 17 } });
    } });
    await adapter.execute('get_ticket', { ticket_id: '17' });
    for (let i = 0; i < 2; i++) await assert.rejects(adapter.execute('update_ticket', { ticket_id: '17', status: 'solved' }), /worlds_write_unconfirmed/);
    assert.equal(puts, 1); assert.equal(adapter.stats.writes, 0);
  }
});
test('redirect is never followed and raw connector errors do not escape', async () => {
  let calls = 0;
  const adapter = createWorldsAdapter({ baseUrl: 'http://127.0.0.1:8080', apiKey: key, taskId: 'id', fetchImpl: async (_url, init) => {
    calls++; assert.equal(init.redirect, 'manual'); return new Response('private body', { status: 302, headers: { location: 'https://example.test' } });
  } });
  await assert.rejects(adapter.execute('get_ticket', { ticket_id: '17' }), /^WorldsError: worlds_read_failed$/); assert.equal(calls, 1);
});
test('wrong ticket identity and oversized connector JSON fail closed', async () => {
  for (const body of [{ ticket: { id: 99 } }, { ticket: { id: 17, note: 'x'.repeat(262144) } }]) {
    const adapter = createWorldsAdapter({ baseUrl: 'http://127.0.0.1:8080', apiKey: key, taskId: 'id', fetchImpl: async () => json(body) });
    await assert.rejects(adapter.execute('get_ticket', { ticket_id: '17' }));
    await assert.rejects(adapter.execute('update_ticket', { ticket_id: '17', status: 'solved' }), /ticket_read_required/);
  }
});
test('whole model batch is validated before any valid call can mutate', async () => {
  const adapter = stubAdapter();
  await assert.rejects(runAgent({ task, adapter, modelStep: fixture([response(call('update_ticket', { ticket_id: '17', status: 'solved' }), call('shell', {}, 'call_2'))]) }), /tool_unknown/);
  assert.equal(adapter.calls.length, 0);
});
test('duplicate and replayed model call IDs stop before executing them', async () => {
  for (const outputs of [[response(call('get_ticket', { ticket_id: '17' }), call('get_ticket', { ticket_id: '17' }))], [response(call('get_ticket', { ticket_id: '17' })), response(call('get_ticket', { ticket_id: '17' }))]]) {
    const adapter = stubAdapter();
    await assert.rejects(runAgent({ task, adapter, modelStep: fixture(outputs) }), /model_response_invalid/); assert.ok(adapter.calls.length <= 1);
  }
});
test('tool and step limits stop a model that never finishes', async () => {
  const adapter = stubAdapter(); let counter = 0;
  const modelStep = async () => response(call('get_ticket', { ticket_id: '17' }, `call_${++counter}`));
  await assert.rejects(runAgent({ task, adapter, modelStep, maxCalls: 2 }), /tool_call_limit/); assert.equal(adapter.calls.length, 2);
  await assert.rejects(runAgent({ task, adapter: stubAdapter(), modelStep, maxSteps: 1 }), /model_step_limit/);
});
test('deadline bounds a hung model even if it ignores the abort signal', async () => {
  await assert.rejects(runAgent({ task, adapter: stubAdapter(), modelStep: () => new Promise(() => {}), timeoutMs: 20 }), /run_timeout/);
});
test('incomplete or unexpected model output cannot perform a write', async () => {
  for (const result of [{ status: 'incomplete', output: [call('update_ticket', { ticket_id: '17', status: 'solved' })] }, response({ type: 'web_search_call' }), done('')]) {
    const adapter = stubAdapter(); await assert.rejects(runAgent({ task, adapter, modelStep: fixture([result]) }), /model_response_invalid/); assert.equal(adapter.calls.length, 0);
  }
});
test('xAI adapter requires explicit opt-in, fixed provider URL, bounded request and no twin credential', async () => {
  assert.throws(() => createXaiModel({ apiKey: 'fixture-model-key', model: 'fixture-model', enabled: false }), /paid_model_opt_in_required/);
  let actual;
  const modelStep = createXaiModel({ apiKey: 'fixture-model-key', model: 'fixture-model', enabled: true, fetchImpl: async (url, init) => { actual = { url, init }; return json(done('Finished.')); } });
  await modelStep({ input: [{ role: 'user', content: JSON.stringify(task) }] });
  assert.equal(actual.url, 'https://api.x.ai/v1/responses');
  const body = JSON.parse(actual.init.body); assert.equal(body.store, false); assert.equal(body.parallel_tool_calls, false); assert.equal(body.max_output_tokens, 2048);
  assert.deepEqual(body.include, ['reasoning.encrypted_content']);
  assert.equal(actual.init.body.includes(key), false); assert.equal(actual.init.body.includes('fixture-model-key'), false);
});
test('known credentials accidentally included in public mission are scrubbed before the first model step', async () => {
  const secretTask = { ...task, mission: { ...task.mission, prompt: `Never disclose ${key} or fixture-model-key` } };
  const result = await runAgent({ task: secretTask, adapter: stubAdapter(), secrets: [key, 'fixture-model-key'], modelStep: async ({ input }) => {
    const text = JSON.stringify(input); assert.equal(text.includes(key), false); assert.equal(text.includes('fixture-model-key'), false);
    assert.match(text, /\[redacted\]/); return done('No credential disclosed.');
  } });
  assert.equal(result.tool_calls, 0);
});
test('stateless function continuation preserves encrypted reasoning output unchanged', async () => {
  const reasoning = { type: 'reasoning', id: 'reason_1', encrypted_content: 'fixture-encrypted-context', summary: [] };
  let count = 0;
  await runAgent({ task, adapter: stubAdapter(), modelStep: async ({ input }) => {
    if (count++ === 0) return response(reasoning, call('get_ticket', { ticket_id: '17' }));
    assert.deepEqual(input[1], reasoning); assert.equal(input[2].type, 'function_call'); assert.equal(input[3].type, 'function_call_output');
    return done('Read verified.');
  } });
});
test('model HTTP failures are fixed errors and never retried', async () => {
  let calls = 0;
  const modelStep = createXaiModel({ apiKey: 'fixture-model-key', model: 'fixture-model', enabled: true, fetchImpl: async () => { calls++; return new Response('credential or provider detail', { status: 429 }); } });
  await assert.rejects(modelStep({ input: [] }), /^WorldsError: model_request_failed$/); assert.equal(calls, 1);
});
test('CLI cannot implicitly spend when the environment contains a model key', async () => {
  await assert.rejects(main({ WORLDS_MODEL_PROVIDER: 'xai', WORLDS_MODEL: 'fixture-model', XAI_API_KEY: 'fixture-model-key', WORLDS_BASE_URL: 'http://127.0.0.1:8080', WORLDS_API_KEY: key, WORLDS_TASK_JSON: JSON.stringify(task) }), /paid_model_opt_in_required/);
});
test('local HTTP fixture runs read, comments, update, verify and final reply through function results', async () => {
  let ticket = { id: 17, status: 'open', priority: 'normal', tags: ['preserve'] }; const requests = [];
  const server = createServer(async (request, reply) => {
    requests.push({ method: request.method, path: request.url, auth: request.headers.authorization });
    let body = ''; for await (const chunk of request) body += chunk;
    if (request.method === 'PUT') ticket = { ...ticket, ...JSON.parse(body).ticket };
    reply.setHeader('Content-Type', 'application/json'); reply.end(JSON.stringify(request.url.endsWith('/comments.json') ? { comments: [] } : { ticket }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const adapter = createWorldsAdapter({ baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: key, taskId: task.mission.id });
    const outputs = [response(call('get_ticket', { ticket_id: '17' }, 'read')), response(call('get_ticket_comments', { ticket_id: '17' }, 'comments')), response(call('update_ticket', { ticket_id: '17', status: 'solved', comment: { body: 'Local fixture reply.', public: true } }, 'write')), response(call('get_ticket', { ticket_id: '17' }, 'verify')), done(`Verified ticket 17. ${key}`)];
    const modelStep = async ({ input }) => { assert.equal(JSON.stringify(input).includes(key), false); return outputs.shift(); };
    const result = await runAgent({ task, adapter, modelStep, secrets: [key] });
    assert.equal(result.tool_calls, 4); assert.equal(result.writes, 1); assert.equal(result.reads, 3); assert.match(result.reply, /\[redacted\]/);
    assert.equal(ticket.status, 'solved'); assert.deepEqual(ticket.tags, ['preserve']); assert.equal(requests.length, 4);
    assert.ok(requests.every(request => request.auth === `Bearer ${key}`));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
