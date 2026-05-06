/**
 * Thin wrapper over Discord REST API. Only the calls we use:
 *   - send a new message to a channel (proactive draft / reminders)
 *   - send a follow-up message via interaction webhook (response to slash command)
 *   - edit the original interaction response
 *
 * Each send accepts either a plain string (treated as content) or a structured
 * payload with `content` and/or `embeds`. Plain-text payloads auto-split when
 * over Discord's 2000-char per-message limit; embed-bearing payloads send
 * once and rely on Discord's higher per-embed budget (≤6000 chars, ≤10 embeds
 * per message).
 */

import type { Embed, MessagePayload } from './types';

const DISCORD_API = 'https://discord.com/api/v10';
const MESSAGE_CHAR_LIMIT = 1990;

type Sendable = string | MessagePayload;

function normalize(input: Sendable): MessagePayload {
  if (typeof input === 'string') return { content: input };
  return input;
}

export class DiscordAPI {
  constructor(private botToken: string, private appId: string) {}

  /** Post a new message to a channel (used by the alarm-driven draft + reminders). */
  async postMessage(channelId: string, input: Sendable): Promise<{ id: string }> {
    const payload = normalize(input);
    const messages = splitForSend(payload);
    let firstId: { id: string } | undefined;
    for (const body of messages) {
      const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ ...body, allowed_mentions: { parse: [] } }),
      });
      if (!res.ok) throw new Error(`Discord postMessage failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { id: string };
      firstId ??= json;
    }
    return firstId!;
  }

  /** Send a follow-up message in response to an interaction (after deferring). */
  async followUp(interactionToken: string, input: Sendable): Promise<void> {
    const payload = normalize(input);
    for (const body of splitForSend(payload)) {
      const res = await fetch(
        `${DISCORD_API}/webhooks/${this.appId}/${interactionToken}`,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify({ ...body, allowed_mentions: { parse: [] } }),
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
   * If a payload is too big to fit in one message, the first chunk replaces the
   * deferred message and the rest are appended as follow-ups.
   */
  async editOriginal(interactionToken: string, input: Sendable): Promise<void> {
    const payload = normalize(input);
    const messages = splitForSend(payload);
    const first = messages[0] ?? { content: '' };
    const res = await fetch(
      `${DISCORD_API}/webhooks/${this.appId}/${interactionToken}/messages/@original`,
      {
        method: 'PATCH',
        headers: this.headers(),
        body: JSON.stringify({ ...first, allowed_mentions: { parse: [] } }),
      }
    );
    if (!res.ok) throw new Error(`Discord editOriginal failed: ${res.status} ${await res.text()}`);
    for (let i = 1; i < messages.length; i++) {
      await this.followUp(interactionToken, messages[i]!);
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
 * Decide whether to send the payload as one message or split it across many.
 * - Plain-text payloads get chunked at MESSAGE_CHAR_LIMIT (no embeds).
 * - Payloads with embeds send as-is. Embeds carry their own larger budget
 *   (≤6000 chars per embed, ≤10 embeds per message); chunking them is awkward
 *   and the callers we have generate well-bounded embeds.
 */
function splitForSend(payload: MessagePayload): MessagePayload[] {
  if (payload.embeds && payload.embeds.length > 0) {
    return [payload];
  }
  const content = payload.content ?? '';
  if (content.length <= MESSAGE_CHAR_LIMIT) return [payload];
  return chunkContent(content).map((c) => ({ content: c }));
}

/**
 * Split content into ≤MESSAGE_CHAR_LIMIT-char chunks, preferring (in order)
 * paragraph, line, and word boundaries. Hard slice only when the remaining
 * text has no whitespace within the limit (e.g. a long URL).
 */
function chunkContent(content: string): string[] {
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

export type { Embed, MessagePayload };
