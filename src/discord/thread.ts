/**
 * Helpers for replying to users in threads instead of the main channel.
 *
 * Two entry points:
 *   - prepareInteractionThread(...) — for slash commands. Sets the deferred
 *     response's content to a generated title (which doubles as the channel-
 *     visible preview) and starts a thread off of it.
 *   - prepareChatThread(...) — for plain-text chat messages forwarded by the
 *     gateway relay. Starts a thread off the user's own message.
 *
 * Both return a `replyChannelId` (the thread's channel id). Callers post all
 * subsequent replies to that id via DiscordAPI#postMessage — same path as
 * the main channel, just into the thread.
 *
 * Title generation goes through the configured "fast" model, with a tight
 * timeout and a verbatim fallback so we never block on the LLM.
 */

import OpenAI from 'openai';
import type { Env } from '../env';
import { DiscordAPI } from './api';

const TITLE_FALLBACK = 'Kitchen reply';
const TITLE_MAX = 90;

/**
 * Produce a short, human-readable thread title. Short user messages skip the
 * LLM entirely (verbatim). Anything longer or multi-line gets a one-shot
 * summarization through env.OPENAI_MODEL_FAST.
 */
export async function generateThreadTitle(env: Env, message: string): Promise<string> {
  const trimmed = message.trim();
  if (!trimmed) return TITLE_FALLBACK;

  // Short single-line messages are already perfect titles. Avoid the LLM hop.
  if (trimmed.length <= 60 && !trimmed.includes('\n')) {
    return trimmed.slice(0, TITLE_MAX);
  }

  try {
    const client = new OpenAI({
      apiKey: env.OPENAI_API_KEY,
      baseURL: env.AI_GATEWAY_URL || undefined,
      timeout: 8_000,
      maxRetries: 0,
    });
    const res = await client.responses.create({
      model: env.OPENAI_MODEL_FAST,
      input: [
        {
          role: 'system',
          content:
            'Return a SHORT thread title (≤6 words, ≤80 chars) that names the user request. Plain text only — no quotes, no trailing period, no markdown, no emoji.',
        },
        { role: 'user', content: trimmed.slice(0, 1000) },
      ],
    });
    const cleaned = (res.output_text ?? '')
      .trim()
      .replace(/^["'`]+|["'`.]+$/g, '')
      .replace(/[\r\n]+/g, ' ')
      .slice(0, TITLE_MAX);
    if (cleaned) return cleaned;
  } catch {
    // Fall through to truncation.
  }
  return trimmed.slice(0, TITLE_MAX);
}

/**
 * Slash-command path: edit the deferred response so its visible content is
 * the title (also serves as the thread-parent message), then start a thread
 * on it. Returns the thread's channel id.
 */
export async function prepareInteractionThread(args: {
  discord: DiscordAPI;
  env: Env;
  interactionToken: string;
  /** Best-effort source text for the title — user message, command name, etc. */
  titleSeed: string;
}): Promise<string> {
  const { discord, env, interactionToken, titleSeed } = args;
  const title = await generateThreadTitle(env, titleSeed);
  await discord.editOriginal(interactionToken, title);
  const original = await discord.getOriginalMessage(interactionToken);
  const thread = await discord.startThreadFromMessage(original.channel_id, original.id, title);
  return thread.id;
}

/**
 * Chat path: anchor a thread to the user's own message in the channel.
 * Returns the thread's channel id.
 */
export async function prepareChatThread(args: {
  discord: DiscordAPI;
  env: Env;
  channelId: string;
  parentMessageId: string;
  titleSeed: string;
}): Promise<string> {
  const { discord, env, channelId, parentMessageId, titleSeed } = args;
  const title = await generateThreadTitle(env, titleSeed);
  const thread = await discord.startThreadFromMessage(channelId, parentMessageId, title);
  return thread.id;
}
