/**
 * Channel-to-bot routing. The Worker uses this to pick which DO handles a
 * given Discord channel (for /relay/message) or slash command (for
 * /interactions). Adding a new bot is one BotSpec import here.
 *
 * The registry is built from the per-bot spec files (kitchen/spec.ts,
 * finance/spec.ts, …). The spec is the single source of truth for the bot's
 * id, channel binding, command set, tools, migrations, prompt, etc. — this
 * file just composes them and exposes lookup helpers.
 *
 * All four DOs share the `default-household` instance name because this is a
 * single-tenant deployment.
 */

import type { Env } from '../env';
import type { BotId, BotSpec, ConversationScope, AgentChatParams } from './bot-spec';
import { getStubFor } from './bot-spec';
import { KITCHEN_SPEC } from '../kitchen/spec';
import { FINANCE_SPEC } from '../finance/spec';
import { TASKS_SPEC } from '../tasks/spec';
import { WORKOUT_SPEC } from '../workout/spec';

/** All registered bots, indexed by id. Adding a new bot = add its spec here. */
export const BOT_REGISTRY: Record<BotId, BotSpec> = {
  kitchen: KITCHEN_SPEC,
  finance: FINANCE_SPEC,
  tasks: TASKS_SPEC,
  workout: WORKOUT_SPEC,
};

export const ALL_BOTS: readonly BotSpec[] = Object.values(BOT_REGISTRY);

/** Resolve a spec by id. Throws when given an unregistered id — that's a
 *  programming error, not a runtime variable. */
export function getBotSpec(id: BotId): BotSpec {
  const spec = BOT_REGISTRY[id];
  if (!spec) throw new Error(`Unknown bot id: ${id}`);
  return spec;
}

/** Resolve the bot owning a Discord channel by ID. Returns null if unknown. */
export function botForChannel(env: Env, channelId: string): BotSpec | null {
  for (const spec of ALL_BOTS) {
    if (env[spec.channelEnvKey] === channelId) return spec;
  }
  return null;
}

/** Resolve the bot owning a slash-command by name. Non-kitchen specs declare
 *  their owned commands explicitly; kitchen is the catch-all so unknown names
 *  also land on kitchen (matches the legacy behavior). */
export function botForCommand(commandName: string): BotSpec {
  for (const spec of ALL_BOTS) {
    if (spec.id === 'kitchen') continue;
    if (spec.commands.has(commandName)) return spec;
  }
  return KITCHEN_SPEC;
}

/** Resolve a DO stub by spec id. Single-tenant for now. */
export function getStub(env: Env, id: BotId): DurableObjectStub {
  return getStubFor(env, id);
}

/**
 * Dispatch a chat message into the unified AgentChatWorkflow. The default
 * scope comes from the spec; callers with richer context (KitchenDO's
 * findActiveWeek) may pass an explicit scope override.
 *
 * Used both by the Worker's /relay/message handler and by each DO's
 * slash-command dispatcher (via `AgentDOBase.dispatchChatInteraction`).
 */
export async function dispatchChat(
  env: Env,
  botId: BotId,
  userMessage: string,
  replyChannelId: string,
  scopeOverride?: ConversationScope,
): Promise<void> {
  const spec = getBotSpec(botId);
  const scope = scopeOverride ?? spec.defaultScope(env, replyChannelId);
  const params: AgentChatParams = { botId, userMessage, replyChannelId, scope };
  await env.AGENT_CHAT_WORKFLOW.create({ params });
}
