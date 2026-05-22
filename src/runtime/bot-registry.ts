/**
 * Channel-to-bot routing. The Worker uses this to pick which DO handles a
 * given Discord channel (for /relay/message) or slash command (for
 * /interactions). Adding a new bot is one entry here.
 */

import type { Env } from '../env';

export type BotId = 'kitchen' | 'finance' | 'tasks';

export interface BotEntry {
  id: BotId;
  /** Single-tenant DO name used to mint the stub. */
  doName: string;
  getStub(env: Env): DurableObjectStub;
}

const KITCHEN: BotEntry = {
  id: 'kitchen',
  doName: 'default-household',
  getStub(env) {
    return env.KITCHEN.get(env.KITCHEN.idFromName('default-household'));
  },
};

const FINANCE: BotEntry = {
  id: 'finance',
  doName: 'default-household',
  getStub(env) {
    return env.FINANCE.get(env.FINANCE.idFromName('default-household'));
  },
};

const TASKS: BotEntry = {
  id: 'tasks',
  doName: 'default-household',
  getStub(env) {
    return env.TASKS.get(env.TASKS.idFromName('default-household'));
  },
};

/** Resolve the bot owning a Discord channel by ID. Returns null if unknown. */
export function botForChannel(env: Env, channelId: string): BotEntry | null {
  if (channelId === env.DISCORD_CHANNEL_ID) return KITCHEN;
  if (channelId === env.DISCORD_FINANCE_CHANNEL_ID) return FINANCE;
  if (channelId === env.DISCORD_TASKS_CHANNEL_ID) return TASKS;
  return null;
}

/** Resolve the bot owning a slash-command by name. Finance commands are
 *  prefixed `finance-`; tasks commands are prefixed `tasks`; everything else
 *  routes to kitchen. */
export function botForCommand(commandName: string): BotEntry {
  if (commandName.startsWith('finance') || commandName === 'spending' || commandName === 'merchant' || commandName === 'sync-finance') {
    return FINANCE;
  }
  if (commandName.startsWith('tasks')) {
    return TASKS;
  }
  return KITCHEN;
}

/** All registered bots, useful for the cron heartbeat which fans out to each. */
export const ALL_BOTS: readonly BotEntry[] = [KITCHEN, FINANCE, TASKS];
