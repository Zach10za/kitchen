/**
 * Channel-to-bot routing. The Worker uses this to pick which DO handles a
 * given Discord channel (for /relay/message) or slash command (for
 * /interactions). Adding a new bot is one entry here.
 *
 * All three DOs share the `default-household` instance name because this is a
 * single-tenant deployment — admin tooling and the cron heartbeat can address
 * each by a single constant. If the app ever goes multi-tenant, this is the
 * one place that needs to change.
 */

import type { Env } from '../env';
import { currentOrNextMondayISO } from '../util/datetime';

export type BotId = 'kitchen' | 'finance' | 'tasks' | 'workout';

export interface BotEntry {
  id: BotId;
  /** Single-tenant DO name used to mint the stub. */
  doName: string;
  /** Slash-command names this bot owns. Grep-friendly source of truth. */
  commands: ReadonlySet<string>;
  getStub(env: Env): DurableObjectStub;
  /**
   * Dispatch a plain-text relay message into this bot's steer workflow.
   * Each bot owns its own workflow binding; collecting the dispatch logic
   * here lets the Worker's relay handler stay a single registry lookup
   * instead of a per-bot if/else ladder.
   */
  dispatchRelay(env: Env, userMessage: string, replyChannelId: string): Promise<void>;
}

const KITCHEN: BotEntry = {
  id: 'kitchen',
  doName: 'default-household',
  // Kitchen-owned commands (also the catch-all per `botForCommand`). Listed
  // explicitly so adding a new command makes ownership grep-able.
  commands: new Set([
    'plan', 'draft', 'steer', 'now', 'pantry', 'profile',
    'approve', 'grocery', 'reminders',
  ]),
  getStub(env) {
    return env.KITCHEN.get(env.KITCHEN.idFromName('default-household'));
  },
  async dispatchRelay(env, userMessage, replyChannelId) {
    await env.STEER_WORKFLOW.create({
      params: { weekOf: currentOrNextMondayISO(env.TIMEZONE), replyChannelId, userMessage },
    });
  },
};

const FINANCE: BotEntry = {
  id: 'finance',
  doName: 'default-household',
  commands: new Set([
    'finance',
    'finance-sync',
    'spending',
    'merchant',
    'accounts',
    'sync-finance',
  ]),
  getStub(env) {
    return env.FINANCE.get(env.FINANCE.idFromName('default-household'));
  },
  async dispatchRelay(env, userMessage, replyChannelId) {
    await env.FINANCE_STEER_WORKFLOW.create({
      params: { userMessage, replyChannelId },
    });
  },
};

const TASKS: BotEntry = {
  id: 'tasks',
  doName: 'default-household',
  commands: new Set([
    'tasks',
    'tasks-open',
    'tasks-next',
    'tasks-blocked',
    'tasks-due',
  ]),
  getStub(env) {
    return env.TASKS.get(env.TASKS.idFromName('default-household'));
  },
  async dispatchRelay(env, userMessage, replyChannelId) {
    await env.TASKS_STEER_WORKFLOW.create({
      params: { userMessage, replyChannelId },
    });
  },
};

const WORKOUT: BotEntry = {
  id: 'workout',
  doName: 'default-household',
  commands: new Set([
    'workout',
    'workout-last',
    'workout-prs',
    'workout-week',
    'workout-program',
    'workout-profile',
  ]),
  getStub(env) {
    return env.WORKOUT.get(env.WORKOUT.idFromName('default-household'));
  },
  async dispatchRelay(env, userMessage, replyChannelId) {
    await env.WORKOUT_STEER_WORKFLOW.create({
      params: { userMessage, replyChannelId },
    });
  },
};

/** Resolve the bot owning a Discord channel by ID. Returns null if unknown. */
export function botForChannel(env: Env, channelId: string): BotEntry | null {
  if (channelId === env.DISCORD_CHANNEL_ID) return KITCHEN;
  if (channelId === env.DISCORD_FINANCE_CHANNEL_ID) return FINANCE;
  if (channelId === env.DISCORD_TASKS_CHANNEL_ID) return TASKS;
  if (channelId === env.DISCORD_WORKOUT_CHANNEL_ID) return WORKOUT;
  return null;
}

/** Resolve the bot owning a slash-command by name. Explicit allow-list per
 *  non-kitchen bot; kitchen is the catch-all so legacy commands keep working. */
export function botForCommand(commandName: string): BotEntry {
  if (FINANCE.commands.has(commandName)) return FINANCE;
  if (TASKS.commands.has(commandName)) return TASKS;
  if (WORKOUT.commands.has(commandName)) return WORKOUT;
  return KITCHEN;
}

/** All registered bots, useful for the cron heartbeat which fans out to each. */
export const ALL_BOTS: readonly BotEntry[] = [KITCHEN, FINANCE, TASKS, WORKOUT];
