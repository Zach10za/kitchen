import OpenAI from 'openai';
import type { Env } from '../env';
import type { RoundUsage } from './agent-round';
import { extractUsage } from './agent-round';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Build an LLM client routed through OpenRouter — or Cloudflare's AI Gateway
 * when `AI_GATEWAY_URL` is set (its path must end in `/openrouter`). Long
 * timeout (3 min) lets the planner take its time on hard tasks; two retries
 * cover transient gateway hiccups (workflow round steps no longer retry, so
 * the client handles transient errors).
 *
 * Used by every bot's agent loop in this repo. Still the `openai` SDK — the
 * Chat Completions wire format is the lingua franca of every provider now.
 */
export function makeLLMClient(env: Env, opts?: { timeoutMs?: number; maxRetries?: number }): OpenAI {
  return new OpenAI({
    // Keep OPENAI_API_KEY as a transition fallback; retire it once all
    // secrets are rotated to OPENROUTER_API_KEY.
    apiKey: env.OPENROUTER_API_KEY || env.OPENAI_API_KEY,
    baseURL: env.AI_GATEWAY_URL || OPENROUTER_BASE_URL,
    timeout: opts?.timeoutMs ?? 180_000,
    maxRetries: opts?.maxRetries ?? 2,
  });
}

/** Options for one structured-extraction call. */
export interface StructuredExtractArgs {
  /** Name for the extraction tool. Must be unique per call. */
  name: string;
  /** JSON Schema for the tool's arguments. Must be an object schema. */
  schema: Record<string, any>;
  system: string;
  user: string;
}

/** Result of a structured-extraction call. `output` is the raw JSON string the
 *  model produced (already constrained by the tool schema); parse & validate
 *  it at the call site. `null` means the model didn't call the extraction
 *  tool (e.g. it answered in prose or refused). */
export interface StructuredExtractResult {
  output: string | null;
  usage: RoundUsage;
}

/**
 * Robust structured output for any tool-capable provider. DeepSeek (and most
 * non-OpenAI providers) don't implement strict JSON-schema response_format, so
 * instead of schema mode we declare the schema as the arguments of a single
 * function tool and force `tool_choice` to it. The model returns the JSON in
 * the tool call's arguments, and the extraction tool is never executed.
 */
export async function structuredExtract(
  client: OpenAI,
  model: string,
  args: StructuredExtractArgs,
): Promise<StructuredExtractResult> {
  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: args.system },
      { role: 'user', content: args.user },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: args.name,
          description: `Return the extracted data as JSON matching the provided schema. Only call this tool, with exactly the schema shape — no prose.`,
          parameters: args.schema,
        },
      },
    ],
    tool_choice: { type: 'function', function: { name: args.name } },
  });

  const message = response.choices[0]?.message;
  const calls = (message?.tool_calls ?? []) as Array<{
    id: string;
    function: { name: string; arguments: string };
  }>;
  const call = calls[0];
  return {
    output: call?.function?.name === args.name ? call.function.arguments : null,
    usage: extractUsage(response),
  };
}