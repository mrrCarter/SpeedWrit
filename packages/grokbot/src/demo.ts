// A conversation with Grok: each prompt goes in with the turns before it, and each answer comes
// back with the SpeedWrit calls Grok made. The stage prompts are the spec's demo path.

import type { McpToolSpec, ParsedResponse, Turn } from "./xai.js";
import { buildResponsesRequest } from "./xai.js";

/** The spec's demo path, prompts 1 to 6, as they are said to the agent on stage. */
export const DEMO_PROMPTS: readonly string[] = Object.freeze([
  "What jobs can you do for me right now?",
  "Do the Tuesday recap for Dana. Topic: onboarding call. Recap: we agreed to start the pilot Monday, and I'll send the checklist by Friday.",
  "Send the same recap to Bo at Birch too.",
  "Dana needs a short custom note asking if Thursday at 2pm works for a kickoff.",
  "Make it Friday at 10am instead.",
  "Send Dana one more reminder.",
]);

export type Exchange = { prompt: string; response: ParsedResponse };

/** Runs the prompts in order, in one conversation. `send` is one Responses call; `tool` is built per call so a bearer can refresh between turns. */
export async function converse(
  prompts: readonly string[],
  deps: { model: string; tool: () => Promise<McpToolSpec>; send: (request: ReturnType<typeof buildResponsesRequest>) => Promise<ParsedResponse>; onExchange?: (exchange: Exchange, index: number) => void },
): Promise<Exchange[]> {
  const turns: Turn[] = [];
  const exchanges: Exchange[] = [];
  for (const [index, prompt] of prompts.entries()) {
    turns.push({ role: "user", content: prompt });
    const response = await deps.send(buildResponsesRequest({ model: deps.model, turns, tool: await deps.tool() }));
    turns.push({ role: "assistant", content: response.text || "(no text)" });
    const exchange = { prompt, response };
    exchanges.push(exchange);
    deps.onExchange?.(exchange, index);
  }
  return exchanges;
}

/** What one exchange looks like in a terminal: the prompt, each SpeedWrit call and its result, then Grok's words. */
export function formatExchange(exchange: Exchange, index: number): string {
  const lines = [`\n[${index + 1}] you: ${exchange.prompt}`];
  for (const call of exchange.response.calls) {
    lines.push(`    -> speedwrit.${call.name} ${JSON.stringify(call.arguments)}`);
    if (call.error) lines.push(`    <- error: ${call.error}`);
    else if (call.output !== null) lines.push(`    <- ${summarizeOutput(call.output)}`);
  }
  if (exchange.response.calls.length === 0) lines.push("    (no SpeedWrit call)");
  lines.push(`    grok: ${exchange.response.text.trim() || "(no text)"}`);
  return lines.join("\n");
}

/** A tool output's status line: the structured status and reason when the output is JSON, else its first 200 characters. */
export function summarizeOutput(output: string): string {
  try {
    const parsed = JSON.parse(output) as Record<string, unknown>;
    const bits = ["status", "reason_code", "review_reasons", "sends_left", "receipt_id"].flatMap((key) => (parsed[key] === undefined ? [] : [`${key}=${JSON.stringify(parsed[key])}`]));
    if (bits.length > 0) return bits.join(" ");
  } catch {
    // Not JSON: SpeedWrit's text result. Shown as is.
  }
  return output.replace(/\s+/g, " ").slice(0, 200);
}
