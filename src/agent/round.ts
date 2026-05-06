/**
 * One round of the OpenAI Responses-API tool-call loop, factored out so the
 * in-process agent (runAgent) and the durable SteerWorkflow can share it.
 *
 * The shared piece is: send a request, decide final-vs-continue, and append
 * function_call + function_call_output items to the running input array. The
 * differing piece — how a tool actually runs and how its turn gets persisted
 * — is delegated to callbacks.
 */

import type OpenAI from 'openai';
import { TOOLS } from './tools';
import { toResponsesTools } from './loop';

export const MAX_TOOL_ROUNDS = 6;

export interface RoundResult {
  type: 'final' | 'continue';
  finalText?: string;
  /** The complete input array for the next round (or to persist). */
  newMessages: any[];
}

export interface RunRoundArgs {
  client: OpenAI;
  model: string;
  messages: any[];
  /** Filled in for tools whose schema has a week_of param when the model omitted it. */
  weekOf: string;
  /** Run a single tool by name and return its string output. */
  executeTool: (name: string, args: any) => Promise<string>;
  /** Optional hook fired after each tool runs (used to persist conversation rows). */
  onToolCall?: (call: { name: string; args: any; output: string }) => Promise<void>;
}

export async function runAgentRound(args: RunRoundArgs): Promise<RoundResult> {
  const response = await args.client.responses.create({
    model: args.model,
    input: args.messages,
    tools: toResponsesTools(TOOLS),
  });

  const toolCalls = (response.output as any[]).filter((o) => o.type === 'function_call');

  if (toolCalls.length === 0) {
    return {
      type: 'final',
      finalText: response.output_text || '(no text)',
      // Echo the response output so the next caller can persist a clean tail.
      newMessages: [...args.messages, ...(response.output as any[])],
    };
  }

  // Echo every output item back in original order. Reasoning items (rs_...)
  // must accompany their paired function_call items or the next request 400s
  // with "function_call ... was provided without its required 'reasoning' item".
  const newMessages: any[] = [...args.messages, ...(response.output as any[])];

  for (const toolCall of toolCalls) {
    const parsed = JSON.parse(toolCall.arguments);
    if (!('week_of' in parsed) && needsWeekOf(toolCall.name)) {
      parsed.week_of = args.weekOf;
    }
    const output = await args.executeTool(toolCall.name, parsed);
    newMessages.push({
      type: 'function_call_output',
      call_id: toolCall.call_id,
      output,
    });
    if (args.onToolCall) {
      await args.onToolCall({ name: toolCall.name, args: parsed, output });
    }
  }

  return { type: 'continue', newMessages };
}

/** Tools whose schema declares week_of as required — used to backfill if missing. */
export function needsWeekOf(toolName: string): boolean {
  return [
    'generate_draft',
    'swap_meal',
    'adjust_servings',
    'reschedule_meal',
    'mark_meal_cooked',
    'mark_meal_skipped',
    'show_state',
  ].includes(toolName);
}
