import OpenAI from 'openai';
import type { Env } from '../env';

/**
 * Build an OpenAI client routed through Cloudflare's AI Gateway when
 * configured. Long timeout (3 min) lets the planner take its time on
 * hard tasks; one retry covers transient gateway hiccups.
 *
 * Used by every bot's agent loop in this repo.
 */
export function makeOpenAIClient(env: Env, opts?: { timeoutMs?: number; maxRetries?: number }): OpenAI {
  return new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    baseURL: env.AI_GATEWAY_URL || undefined,
    timeout: opts?.timeoutMs ?? 180_000,
    maxRetries: opts?.maxRetries ?? 1,
  });
}
