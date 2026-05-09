/**
 * One round of an OpenAI Responses-API tool-call loop, parameterized so
 * multiple bots in this repo (kitchen, finance, …) can share it.
 *
 * The loop mechanics — send a request, decide final-vs-continue, append
 * function_call + function_call_output items to the running input array —
 * are bot-agnostic. Each bot supplies its own tools, executor, and (optional)
 * default-arg backfill.
 */

import type OpenAI from 'openai';

export const MAX_TOOL_ROUNDS = 6;

/** OpenAI Chat-Completions-style function tool. The runtime converts these
 *  into Responses-API form on the wire. */
export interface FunctionToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: any;
  };
}

/** OpenAI server-side built-in tools — executed by OpenAI, not by us.
 *  Their output items appear in `response.output` alongside function calls
 *  and we echo them forward like everything else. We never call
 *  `executeTool` for them; the model gets results inline. */
export type BuiltinToolDef =
  | { type: 'web_search' }
  | { type: 'web_search_preview' }
  | { type: 'code_interpreter'; container: { type: 'auto' } | { type: 'static'; file_ids?: string[] } };

export type ToolDef = FunctionToolDef | BuiltinToolDef;

export interface RoundResult {
  type: 'final' | 'continue';
  finalText?: string;
  /** Complete input array for the next round (or to persist). */
  newMessages: any[];
}

export interface RunRoundArgs {
  client: OpenAI;
  model: string;
  tools: readonly ToolDef[];
  messages: any[];
  executeTool: (name: string, args: any) => Promise<string>;
  /** Fired after each tool runs — used by callers to persist conversation rows. */
  onToolCall?: (call: { name: string; args: any; output: string }) => Promise<void>;
  /** Optionally rewrite parsed tool args before execution (e.g. backfill
   *  context the model commonly omits, like a default `week_of`). */
  fillDefaultArgs?: (toolName: string, parsed: any) => any;
}

/**
 * Convert ToolDef into Responses API format.
 * Function tools get reshaped (Chat → Responses); built-ins pass through
 * unchanged because the API expects them in their declared form.
 */
export function toResponsesTools(tools: readonly ToolDef[]): any[] {
  return tools.map((t) => {
    if (t.type === 'function') {
      return {
        type: 'function' as const,
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
        strict: false,
      };
    }
    return t;
  });
}

export async function runAgentRound(args: RunRoundArgs): Promise<RoundResult> {
  const response = await args.client.responses.create({
    model: args.model,
    input: args.messages,
    tools: toResponsesTools(args.tools),
  });

  const toolCalls = (response.output as any[]).filter((o) => o.type === 'function_call');

  if (toolCalls.length === 0) {
    return {
      type: 'final',
      finalText: response.output_text || '(no text)',
      newMessages: [...args.messages, ...(response.output as any[])],
    };
  }

  // Echo every output item back in original order. Reasoning items (rs_...)
  // must accompany their paired function_call items or the next request 400s
  // with "function_call ... was provided without its required 'reasoning' item".
  const newMessages: any[] = [...args.messages, ...(response.output as any[])];

  for (const toolCall of toolCalls) {
    let parsed = JSON.parse(toolCall.arguments);
    if (args.fillDefaultArgs) parsed = args.fillDefaultArgs(toolCall.name, parsed);
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
