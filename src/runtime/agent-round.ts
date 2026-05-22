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

/** Token + built-in-tool usage from one Responses API call. The model's
 *  `output_tokens` already includes reasoning; cached tokens are a subset of
 *  input. Built-in tool counts come from the output items, not response.usage. */
export interface RoundUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  web_search_calls: number;
  code_interpreter_calls: number;
}

export interface RoundResult {
  type: 'final' | 'continue';
  finalText?: string;
  /** Complete input array for the next round (or to persist). */
  newMessages: any[];
  /** Usage from this single round. Callers should accumulate across rounds. */
  usage: RoundUsage;
}

export function emptyUsage(): RoundUsage {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    web_search_calls: 0,
    code_interpreter_calls: 0,
  };
}

export function addUsage(a: RoundUsage, b: RoundUsage): RoundUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    cached_input_tokens: a.cached_input_tokens + b.cached_input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    reasoning_tokens: a.reasoning_tokens + b.reasoning_tokens,
    web_search_calls: a.web_search_calls + b.web_search_calls,
    code_interpreter_calls: a.code_interpreter_calls + b.code_interpreter_calls,
  };
}

/** A tool's return value. Plain string for tools that don't make their
 *  own LLM calls (the common case); object form when a tool internally
 *  used the model and wants its usage rolled into the round's total. */
export type ToolResult = string | { output: string; usage?: RoundUsage };

export interface RunRoundArgs {
  client: OpenAI;
  model: string;
  tools: readonly ToolDef[];
  messages: any[];
  executeTool: (name: string, args: any) => Promise<ToolResult>;
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

  let usage = extractUsage(response);
  const toolCalls = (response.output as any[]).filter((o) => o.type === 'function_call');

  if (toolCalls.length === 0) {
    return {
      type: 'final',
      finalText: response.output_text || '(no text)',
      newMessages: [...args.messages, ...(response.output as any[])],
      usage,
    };
  }

  // Echo every output item back in original order. Reasoning items (rs_...)
  // must accompany their paired function_call items or the next request 400s
  // with "function_call ... was provided without its required 'reasoning' item".
  const newMessages: any[] = [...args.messages, ...(response.output as any[])];

  for (const toolCall of toolCalls) {
    // Malformed JSON from the model used to throw and crash the whole round —
    // which under retry caused the round to re-run and tools that had already
    // succeeded to execute again. Catch it, return the parse error as the
    // tool output, and let the model self-correct on the next turn.
    let parsed: any;
    try {
      parsed = JSON.parse(toolCall.arguments);
    } catch (err) {
      const output = `Error: arguments were not valid JSON: ${(err as Error).message}. Re-issue the tool call with corrected JSON.`;
      newMessages.push({
        type: 'function_call_output',
        call_id: toolCall.call_id,
        output,
      });
      if (args.onToolCall) {
        await args.onToolCall({ name: toolCall.name, args: {}, output });
      }
      continue;
    }
    if (args.fillDefaultArgs) parsed = args.fillDefaultArgs(toolCall.name, parsed);
    const result = await args.executeTool(toolCall.name, parsed);
    const output = typeof result === 'string' ? result : result.output;
    if (typeof result !== 'string' && result.usage) {
      // Tool made its own LLM calls (e.g. kitchen's generate_draft) — fold
      // that token spend into this round's usage so the workflow's footer
      // reflects the *full* cost of the turn, not just the wrapper LLM.
      usage = addUsage(usage, result.usage);
    }
    newMessages.push({
      type: 'function_call_output',
      call_id: toolCall.call_id,
      output,
    });
    if (args.onToolCall) {
      await args.onToolCall({ name: toolCall.name, args: parsed, output });
    }
  }

  return { type: 'continue', newMessages, usage };
}

function extractUsage(response: any): RoundUsage {
  const u = response?.usage ?? {};
  const output = (response?.output as any[]) ?? [];
  return {
    input_tokens: u.input_tokens ?? 0,
    cached_input_tokens: u.input_tokens_details?.cached_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    reasoning_tokens: u.output_tokens_details?.reasoning_tokens ?? 0,
    web_search_calls: output.filter((o) => o.type === 'web_search_call').length,
    code_interpreter_calls: output.filter((o) => o.type === 'code_interpreter_call').length,
  };
}
