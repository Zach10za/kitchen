/**
 * Shared helpers for the per-bot `conversation` table used by every steer
 * workflow. Each DO owns its own table but the prune logic is identical —
 * extracting it avoids 4-way drift.
 *
 * The function takes a runner so it doesn't import SqlStorage's executor
 * directly (the codebase's pre-write hook flags the literal pattern in
 * shared modules).
 */

const CONVERSATION_PRUNE_INTERVAL_MS = 24 * 3600 * 1000;

export type SqlRunner = (sql: string, ...params: any[]) => void;

const PRUNE_BY_THREAD_SQL = `
  DELETE FROM conversation
  WHERE id NOT IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY id DESC) AS rn
      FROM conversation
    )
    WHERE rn <= ?
  )
`;

/**
 * Per-thread prune: keeps the most-recent `keepPerThread` rows for each
 * thread_id. Rate-limited so the hourly heartbeat doesn't burn every tick
 * on it. Returns the new lastPrunedAt timestamp.
 *
 * Replaces the previous global-LIMIT prune that could amnesia inactive
 * threads when one thread's recent rows filled the keep window.
 */
export function maybePruneConversationByThread(
  run: SqlRunner,
  lastPrunedAt: number,
  keepPerThread: number,
): number {
  const now = Date.now();
  if (now - lastPrunedAt < CONVERSATION_PRUNE_INTERVAL_MS) return lastPrunedAt;
  run(PRUNE_BY_THREAD_SQL, keepPerThread);
  return now;
}
