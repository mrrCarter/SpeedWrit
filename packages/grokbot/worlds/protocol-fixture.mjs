// Deliberately scripted protocol fixture, NOT a model agent or performance evidence.
// This exercises the production adapter/loop against a freshly seeded Worlds project.
// It reads only the public task and connector responses; never project checks or seed files.
import { createWorldsAdapter } from './adapter.mjs';
import { parseTask, runAgent } from './runner.mjs';

const task = parseTask(process.env.WORLDS_TASK_JSON);
const match = /\bticket (\d+)\b/i.exec(task.mission.prompt);
if (!match) throw Error('fixture_requires_public_ticket_id');
const ticket_id = match[1];
const specs = [
  ['get_ticket', { ticket_id }],
  ['get_ticket_comments', { ticket_id }],
  ['update_ticket', { ticket_id, status: 'solved', comment: { body: 'Protocol fixture reply for this simulated follow-up.', public: true } }],
  ['get_ticket', { ticket_id }],
];
let step = 0;
const modelStep = async () => {
  const spec = specs[step++];
  return { status: 'completed', output: spec ? [{ type: 'function_call', call_id: `fixture_${step}`, name: spec[0], arguments: JSON.stringify(spec[1]) }] :
    [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Protocol fixture completed. No model or email provider was called.' }] }] };
};
const adapter = createWorldsAdapter({ baseUrl: process.env.WORLDS_BASE_URL, apiKey: process.env.WORLDS_API_KEY, taskId: task.mission.id });
try {
  const { reply, ...counts } = await runAgent({ task, modelStep, adapter, secrets: [process.env.WORLDS_API_KEY] });
  process.stdout.write(`${reply}\n`);
  process.stderr.write(`${JSON.stringify({ kind: 'protocol_fixture', model_provider_called: false, ...counts })}\n`);
} catch {
  process.stderr.write('{"kind":"protocol_fixture","error":"fixture_failed"}\n');
  process.exitCode = 1;
}
