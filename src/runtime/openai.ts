import OpenAI from 'openai';
import type { Env } from '../env';

/**
 * Build an OpenAI-compatible client routed through OpenRouter by default.
 * Long timeout (3 min) lets the planner take its time on
 * hard tasks; two retries cover transient gateway hiccups (workflow
 * round steps no longer retry, so the client handles transient errors).
 *
 * Used by every bot's agent loop in this repo.
 */
export function makeOpenAIClient(env: Env, opts?: { timeoutMs?: number; maxRetries?: number }): OpenAI {
  const apiKey = env.OPENROUTER_API_KEY || env.OPENAI_API_KEY;
  const baseURL = env.OPENROUTER_BASE_URL || env.AI_GATEWAY_URL || 'https://openrouter.ai/api/v1';
  return new OpenAI({
    apiKey,
    baseURL,
    timeout: opts?.timeoutMs ?? 180_000,
    maxRetries: opts?.maxRetries ?? 2,
  });
}
