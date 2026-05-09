/**
 * Per-bot cost tracking. Each bot DO owns a `usage` table with the same
 * shape; this module provides the schema + helpers + footer formatter so
 * kitchen and finance both behave the same way.
 *
 * Storage is *raw counts*, never derived dollar amounts. Cost is computed
 * on read via `computeCost(usage, env)` so when OpenAI changes pricing you
 * bump wrangler vars and every historical thread re-prices automatically.
 */

import type { Env } from '../env';
import type { RoundUsage } from './agent-round';
import { computeCost, formatUsd } from './pricing';

export interface RecordUsageBody {
  thread_id?: string | null;
  model: string;
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  web_search_calls: number;
  code_interpreter_calls: number;
}

export function ensureUsageSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT,
      ts INTEGER NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      cached_input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      web_search_calls INTEGER NOT NULL DEFAULT 0,
      code_interpreter_calls INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_usage_thread_ts ON usage(thread_id, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage(ts DESC);
  `);
}

/** Insert a row, return the running thread total (for footer rendering). */
export function recordUsage(sql: SqlStorage, body: RecordUsageBody): RoundUsage {
  sql.exec(
    `INSERT INTO usage
       (thread_id, ts, model, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, web_search_calls, code_interpreter_calls)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    body.thread_id ?? null,
    Date.now(),
    body.model,
    body.input_tokens | 0,
    body.cached_input_tokens | 0,
    body.output_tokens | 0,
    body.reasoning_tokens | 0,
    body.web_search_calls | 0,
    body.code_interpreter_calls | 0,
  );
  if (body.thread_id) return sumUsageByThread(sql, body.thread_id);
  return zeroUsage();
}

export function sumUsageByThread(sql: SqlStorage, threadId: string): RoundUsage {
  return readSum(sql, 'thread_id = ?', [threadId]);
}

export function sumUsageSince(sql: SqlStorage, sinceMs: number): RoundUsage {
  return readSum(sql, 'ts >= ?', [sinceMs]);
}

export function countTurnsByThread(sql: SqlStorage, threadId: string): number {
  return sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM usage WHERE thread_id = ?', threadId)
    .toArray()[0]?.n ?? 0;
}

/**
 * Standard "$X this turn · $Y thread total" footer appended to every
 * Discord-bound assistant reply. Auto-precision keeps tiny charges legible.
 */
export function costFooter(turnUsage: RoundUsage, threadUsage: RoundUsage, env: Env): string {
  const turn = computeCost(turnUsage, env);
  const thread = computeCost(threadUsage, env);
  return `\n\n_${formatUsd(turn.total_usd)} this turn · ${formatUsd(thread.total_usd)} thread total_`;
}

function readSum(sql: SqlStorage, whereClause: string, params: SqlStorageValue[]): RoundUsage {
  const row = sql
    .exec<{
      input_tokens: number;
      cached_input_tokens: number;
      output_tokens: number;
      reasoning_tokens: number;
      web_search_calls: number;
      code_interpreter_calls: number;
    }>(
      `SELECT
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
         COALESCE(SUM(web_search_calls), 0) AS web_search_calls,
         COALESCE(SUM(code_interpreter_calls), 0) AS code_interpreter_calls
       FROM usage WHERE ${whereClause}`,
      ...params
    )
    .toArray()[0];
  return {
    input_tokens: row?.input_tokens ?? 0,
    cached_input_tokens: row?.cached_input_tokens ?? 0,
    output_tokens: row?.output_tokens ?? 0,
    reasoning_tokens: row?.reasoning_tokens ?? 0,
    web_search_calls: row?.web_search_calls ?? 0,
    code_interpreter_calls: row?.code_interpreter_calls ?? 0,
  };
}

function zeroUsage(): RoundUsage {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    web_search_calls: 0,
    code_interpreter_calls: 0,
  };
}

/** Public helper for one-shot LLM calls outside the round runner —
 *  ApproveWorkflow's per-recipe materialization etc. */
export function extractUsageFromResponse(response: any): RoundUsage {
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
