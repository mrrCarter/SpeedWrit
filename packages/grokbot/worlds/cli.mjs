#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { createWorldsAdapter, WorldsError } from './adapter.mjs';
import { parseTask, createXaiModel, runAgent } from './runner.mjs';

export async function readTaskInput(env, stdin) {
  if (env.WORLDS_TASK_JSON) return parseTask(env.WORLDS_TASK_JSON);
  let text = '';
  for await (const chunk of stdin) {
    text += chunk.toString();
    if (Buffer.byteLength(text) > 32768) throw new WorldsError('task_invalid');
  }
  return parseTask(text);
}
export async function main(env = process.env, stdin = process.stdin) {
  if (env.WORLDS_MODEL_PROVIDER !== 'xai') throw new WorldsError('model_provider_invalid');
  const task = await readTaskInput(env, stdin);
  const adapter = createWorldsAdapter({ baseUrl: env.WORLDS_BASE_URL, apiKey: env.WORLDS_API_KEY, taskId: task.mission.id });
  const modelStep = createXaiModel({ apiKey: env.XAI_API_KEY, model: env.WORLDS_MODEL, enabled: env.WORLDS_ALLOW_PAID === '1' });
  return runAgent({ task, modelStep, adapter, secrets: [env.XAI_API_KEY, env.WORLDS_API_KEY] });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await main();
    process.stdout.write(`${result.reply}\n`);
    const { reply: _reply, ...metrics } = result;
    process.stderr.write(`${JSON.stringify({ kind: 'worlds_agent_metrics', provider: 'xai', ...metrics })}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ kind: 'worlds_agent_error', error: error instanceof WorldsError ? error.code : 'runner_failed' })}\n`);
    process.exitCode = 1;
  }
}
