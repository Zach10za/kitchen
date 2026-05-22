/**
 * Keep Discord's typing indicator alive while a long-running task runs.
 *
 * Discord's POST /typing fades after ~10s. We refresh well before that so the
 * indicator stays continuously visible. If the surrounding work crashes, the
 * loop stops and the indicator dies on its own — that absence is the
 * user-visible failure signal.
 *
 * Shared across all four steer workflows.
 */

import type { DiscordAPI } from '../discord/api';

const TYPING_REFRESH_MS = 7_000;

export async function withTypingRefresh<T>(
  discord: DiscordAPI,
  channelId: string,
  fn: () => Promise<T>,
): Promise<T> {
  let stopped = false;
  const refresh = (async () => {
    while (!stopped) {
      await discord.postTyping(channelId).catch(() => {});
      const start = Date.now();
      while (!stopped && Date.now() - start < TYPING_REFRESH_MS) {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  })();
  try {
    return await fn();
  } finally {
    stopped = true;
    await refresh.catch(() => {});
  }
}
