/**
 * Per-channel rolling-window rate limit for /relay/message. Bot DOs call
 * `ensureRelayRateSchema` from their migration, then `checkRelayRateLimit`
 * on each forwarded relay message.
 *
 * Stored in a `relay_rate` table per DO so a compromised relay can't drive
 * unbounded LLM spend, and the limit survives DO restarts (no in-memory
 * counter or cache TTL dependency).
 */

export const DEFAULT_RELAY_RATE_LIMIT_PER_HOUR = 30;

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  reason?: string;
}

export function ensureRelayRateSchema(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS relay_rate (
      channel_id TEXT NOT NULL,
      hit_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_relay_rate_channel ON relay_rate(channel_id, hit_at);
  `);
}

export function checkRelayRateLimit(
  sql: SqlStorage,
  channelId: string,
  limit: number = DEFAULT_RELAY_RATE_LIMIT_PER_HOUR
): RateLimitDecision {
  const now = Date.now();
  const windowStart = now - 3_600_000;
  // Count within the rolling window directly — no DELETE needed for the
  // accept/deny decision. The previous code DELETEd on every check (even
  // denied ones), creating cross-channel write contention and letting a
  // flood from a rate-limited channel evict other channels' rows.
  const count =
    sql.exec<{ n: number }>(
      'SELECT COUNT(*) AS n FROM relay_rate WHERE channel_id = ? AND hit_at >= ?',
      channelId, windowStart,
    ).toArray()[0]?.n ?? 0;
  if (count >= limit) {
    return { allowed: false, remaining: 0, reason: 'rate_limit_exceeded' };
  }
  sql.exec('INSERT INTO relay_rate (channel_id, hit_at) VALUES (?, ?)', channelId, now);
  // Opportunistic vacuum AFTER the accept decision so a denied request
  // never moves the table state. Cheap because the index covers it.
  sql.exec('DELETE FROM relay_rate WHERE hit_at < ?', windowStart);
  return { allowed: true, remaining: limit - count - 1 };
}
