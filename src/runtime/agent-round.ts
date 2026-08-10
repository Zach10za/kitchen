/**
 * One round of a Chat-Completions tool-call loop, parameterized so multiple
 * bots in this repo (kitchen, finance, …) can share it.
 *
 * Transport is the OpenAI Chat Completions wire format against any
 * provider that speaks it (OpenRouter today). The loop mechanics — send a
 * request, decide final-vs-continue, append assistant tool_calls + role:
 * tool outputs to the running messages array — are bot-agnostic. Each bot
 * supplies its own tools, executor, and (optional) default-arg backfill.
 *
 * Reasoning-model notes (DeepSeek): reasoning content may arrive in
 * `message.reasoning_content` (native) or `message.reasoning` (OpenRouter).
 * When a reasoning turn is echoed back, providers reject it without the
 * original reasoning field (DeepSeek: "reasoning_content must be included"),
 * so `echoAssistantMessage` preserves whichever field the model emitted.
 */

import type OpenAI from 'openai';

export const MAX_TOOL_ROUNDS = 10;

/** OpenAI Chat-Completions-style function tool. Passed through unchanged. */
export interface FunctionToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: any;
  };
}

export type ToolDef = FunctionToolDef;

/** Token usage from one Chat Completions call. Cached tokens are a subset of
 *  input. Providers differ in where they report these (OpenAI-style nests
 *  them in `*_details`, DeepSeek uses flat fields) — read both. */
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
  /** Complete messages array for the next round (or to persist). */
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

/** Rebuild an assistant message for the next request. Whitelists fields so
 *  provider-specific noise (refusal, annotations, …) can't 400 the next call,
 *  but preserves the reasoning field for DeepSeek-style models that require
 *  it back on continuation. */
function echoAssistantMessage(message: any): any {
  const echo: any = {
    role: 'assistant',
    content: message.content ?? null,
  };
  if (message.tool_calls?.length) echo.tool_calls = message.tool_calls;
  if (typeof message.reasoning_content === 'string') echo.reasoning_content = message.reasoning_content;
  else if (typeof message.reasoning === 'string') echo.reasoning = message.reasoning;
  return echo;
}

export async function runAgentRound(args: RunRoundArgs): Promise<RoundResult> {
  const response = await args.client.chat.completions.create({
    model: args.model,
    messages: args.messages,
    tools: args.tools as any,
  });

  let usage = extractUsage(response);
  const message = response.choices[0]?.message;

  // Narrow the SDK's tool_calls union (function | custom) to function calls —
  // this loop only declares function tools.
  const toolCalls = (message?.tool_calls ?? []) as Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;

  if (!message || toolCalls.length === 0) {
    return {
      type: 'final',
      finalText: stripCitationMarkers(message?.content) || '(no text)',
      newMessages: [...args.messages, echoAssistantMessage(message ?? { content: null })],
      usage,
    };
  }

  const newMessages: any[] = [...args.messages, echoAssistantMessage(message)];

  for (const toolCall of toolCalls) {
    // Malformed JSON from the model used to throw and crash the whole round —
    // which under retry caused the round to re-run and tools that had already
    // succeeded to execute again. Catch it, return the parse error as the
    // tool output, and let the model self-correct on the next turn.
    let parsed: any;
    try {
      parsed = JSON.parse(toolCall.function.arguments);
    } catch (err) {
      const output = `Error: arguments were not valid JSON: ${(err as Error).message}. Re-issue the tool call with corrected JSON.`;
      newMessages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: output,
      });
      if (args.onToolCall) {
        await args.onToolCall({ name: toolCall.function.name, args: {}, output });
      }
      continue;
    }
    if (args.fillDefaultArgs) parsed = args.fillDefaultArgs(toolCall.function.name, parsed);
    const result = await args.executeTool(toolCall.function.name, parsed);
    const output = typeof result === 'string' ? result : result.output;
    if (typeof result !== 'string' && result.usage) {
      // Tool made its own LLM calls (e.g. kitchen's generate_draft) — fold
      // that token spend into this round's usage so the workflow's footer
      // reflects the *full* cost of the turn, not just the wrapper LLM.
      usage = addUsage(usage, result.usage);
    }
    newMessages.push({
      role: 'tool',
      tool_call_id: toolCall.id,
      content: output,
    });
    if (args.onToolCall) {
      await args.onToolCall({ name: toolCall.function.name, args: parsed, output });
    }
  }

  return { type: 'continue', newMessages, usage };
}

/**
 * OpenAI's hosted web_search used to embed inline citation markers in output
 * text, delimited by private-use-area unicode chars (U+E200 start … U+E201
 * end) that wrap tokens like "cite…turn0search0". Discord can't render the
 * delimiters, so they surfaced as garbage boxes plus literal
 * "citeturn0search0" text. Stripped for compat — web_search is now Tavily
 * (plain text), but other providers may still emit markers. Marker chars are
 * built via fromCharCode so no unprintable private-use bytes live in this
 * source file.
 */
const CITE_START = String.fromCharCode(0xe200);
const CITE_END = String.fromCharCode(0xe201);
const CITE_BLOCK = new RegExp(`${CITE_START}[^${CITE_END}]*${CITE_END}`, 'gu');
const CITE_STRAY = new RegExp(`[${String.fromCharCode(0xe200)}-${String.fromCharCode(0xe20f)}]`, 'gu');

export function stripCitationMarkers(text: string | undefined | null): string {
  if (!text) return '';
  return text
    // Full citation blocks: start-marker … end-marker (incl. the ASCII tokens).
    .replace(CITE_BLOCK, '')
    // Any stray private-use citation/navigation markers left behind.
    .replace(CITE_STRAY, '')
    // Tidy whitespace the removal can leave (space before punctuation/newline).
    .replace(/ +([.,;:!?])/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Tolerant usage extraction across provider shapes (OpenAI-style *_details
 *  nesting and DeepSeek's flat prompt_cache_hit_tokens / reasoning_tokens). */
export function extractUsage(response: any): RoundUsage {
  const u = response?.usage ?? {};
  return {
    input_tokens: u.prompt_tokens ?? 0,
    cached_input_tokens: u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0,
    output_tokens: u.completion_tokens ?? 0,
    reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens ?? 0,
    // OpenAI-hosted built-ins don't exist on OpenRouter/DeepSeek — always 0.
    web_search_calls: 0,
    code_interpreter_calls: 0,
  };
}