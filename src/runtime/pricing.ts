/**
 * Compute USD cost from accumulated usage. Prices are configurable via
 * wrangler vars (PRICE_INPUT_PER_M, PRICE_OUTPUT_PER_M, etc.) so they can
 * be updated when OpenAI changes its pricing without a code deploy.
 *
 * `output_tokens` from the Responses API already includes reasoning, so
 * don't double-count reasoning_tokens here.
 *
 * Cached input tokens get the cached price; the rest of input gets the
 * normal price. cached_input_tokens is a subset of input_tokens.
 */

import type { Env } from '../env';
import type { RoundUsage } from './agent-round';

export interface CostBreakdown {
  total_usd: number;
  input_usd: number;
  cached_input_usd: number;
  output_usd: number;
  web_search_usd: number;
  code_interpreter_usd: number;
}

export function computeCost(usage: RoundUsage, env: Env): CostBreakdown {
  const priceInputPerM = num(env.PRICE_INPUT_PER_M, 0);
  const priceCachedInputPerM = num(env.PRICE_CACHED_INPUT_PER_M, 0);
  const priceOutputPerM = num(env.PRICE_OUTPUT_PER_M, 0);
  const priceWebSearch = num(env.PRICE_WEB_SEARCH_PER_CALL, 0);
  const priceCodeInterpreter = num(env.PRICE_CODE_INTERPRETER_PER_CALL, 0);

  const billableInput = Math.max(0, usage.input_tokens - usage.cached_input_tokens);

  const input_usd = (billableInput * priceInputPerM) / 1_000_000;
  const cached_input_usd = (usage.cached_input_tokens * priceCachedInputPerM) / 1_000_000;
  const output_usd = (usage.output_tokens * priceOutputPerM) / 1_000_000;
  const web_search_usd = usage.web_search_calls * priceWebSearch;
  const code_interpreter_usd = usage.code_interpreter_calls * priceCodeInterpreter;

  return {
    total_usd: input_usd + cached_input_usd + output_usd + web_search_usd + code_interpreter_usd,
    input_usd,
    cached_input_usd,
    output_usd,
    web_search_usd,
    code_interpreter_usd,
  };
}

/** Format a USD amount for compact inline display. Always shows enough
 *  precision to distinguish small charges; a $0.0003 turn shouldn't render
 *  as "$0.00". */
export function formatUsd(amount: number): string {
  if (amount >= 1) return `$${amount.toFixed(2)}`;
  if (amount >= 0.01) return `$${amount.toFixed(3)}`;
  if (amount >= 0.0001) return `$${amount.toFixed(4)}`;
  return amount === 0 ? '$0' : `$${amount.toExponential(1)}`;
}

function num(input: string | undefined, fallback: number): number {
  if (!input) return fallback;
  const n = parseFloat(input);
  return Number.isFinite(n) ? n : fallback;
}
