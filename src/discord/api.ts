/**
 * Thin wrapper over Discord REST API. Only the calls we use:
 *   - send a new message to a channel (proactive draft)
 *   - send a follow-up message via interaction webhook (response to slash command)
 *   - edit the original interaction response
 *
 * All three send paths auto-split content longer than Discord's 2000-char
 * per-message limit so callers never need to think about chunking. Content
 * above the limit becomes multiple sequential messages, split on the safest
 * available boundary (paragraph → line → word → hard cut).
 */

const DISCORD_API = 'https://discord.com/api/v10';
const MESSAGE_CHAR_LIMIT = 1990;

export class DiscordAPI {
  constructor(private botToken: string, private appId: string) {}

  /** Post a new message to a channel (used by the alarm-driven draft). */
  async postMessage(channelId: string, content: string): Promise<{ id: string }> {
    const chunks = chunkForDiscord(content);
    let firstId: { id: string } | undefined;
    for (const chunk of chunks) {
      const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ content: chunk, allowed_mentions: { parse: [] } }),
      });
      if (!res.ok) throw new Error(`Discord postMessage failed: ${res.status} ${await res.text()}`);
      const body = (await res.json()) as { id: string };
      firstId ??= body;
    }
    return firstId!;
  }

  /** Send a follow-up message in response to an interaction (after deferring). */
  async followUp(interactionToken: string, content: string): Promise<void> {
    for (const chunk of chunkForDiscord(content)) {
      const res = await fetch(
        `${DISCORD_API}/webhooks/${this.appId}/${interactionToken}`,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ content: chunk, allowed_mentions: { parse: [] } }),
        }
      );
      if (!res.ok) throw new Error(`Discord followUp failed: ${res.status} ${await res.text()}`);
    }
  }

  /**
   * Post a typing indicator to a channel. The indicator is ephemeral (~10s)
   * and ignored if user is already seeing one. Cheap to call repeatedly.
   */
  async postTyping(channelId: string): Promise<void> {
    const res = await fetch(`${DISCORD_API}/channels/${channelId}/typing`, {
      method: 'POST',
      headers: this.headers(),
    });
    if (!res.ok && res.status !== 429) {
      // 429 (rate limited) is fine for typing — just stops indicating.
      // Other errors we'd want to know about but not break the workflow over.
      console.warn(`postTyping failed: ${res.status}`);
    }
  }

  /**
   * Edit the deferred response (preferred when the agent finishes within ~15 min).
   * If content exceeds the per-message limit, the first chunk replaces the
   * deferred message and the rest are appended as follow-ups — Discord only
   * lets you edit the @original message, so longer output has to spill over.
   */
  async editOriginal(interactionToken: string, content: string): Promise<void> {
    const chunks = chunkForDiscord(content);
    const res = await fetch(
      `${DISCORD_API}/webhooks/${this.appId}/${interactionToken}/messages/@original`,
      {
        method: 'PATCH',
        headers: this.headers(),
        body: JSON.stringify({ content: chunks[0], allowed_mentions: { parse: [] } }),
      }
    );
    if (!res.ok) throw new Error(`Discord editOriginal failed: ${res.status} ${await res.text()}`);
    for (let i = 1; i < chunks.length; i++) {
      await this.followUp(interactionToken, chunks[i]!);
    }
  }

  private headers(): HeadersInit {
    return {
      Authorization: `Bot ${this.botToken}`,
      'Content-Type': 'application/json',
      'User-Agent': 'KitchenBot (https://github.com/zachloza/kitchen, 0.1)',
    };
  }
}

/**
 * Split content into ≤1990-char chunks, preferring (in order) paragraph,
 * line, and word boundaries. Falls back to a hard slice only when the
 * remaining text has no whitespace within the limit (e.g. a long URL).
 */
function chunkForDiscord(content: string): string[] {
  if (content.length <= MESSAGE_CHAR_LIMIT) return [content];
  const chunks: string[] = [];
  let remaining = content;
  while (remaining.length > MESSAGE_CHAR_LIMIT) {
    const window = remaining.slice(0, MESSAGE_CHAR_LIMIT);
    let cut = window.lastIndexOf('\n\n');
    if (cut <= 0) cut = window.lastIndexOf('\n');
    if (cut <= 0) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = MESSAGE_CHAR_LIMIT;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).replace(/^\s+/, '');
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}
