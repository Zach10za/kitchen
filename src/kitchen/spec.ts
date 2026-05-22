import type { BotSpec } from '../runtime/bot-spec';
import type { MessagePayload } from '../discord/types';
import { EmbedColor } from '../discord/types';
import { ensureRelayRateSchema } from '../runtime/relay-rate-limit';
import { ensureUsageSchema } from '../runtime/usage';
import { TOOLS as KITCHEN_TOOLS } from '../agent/tools';
import { executeTool as runKitchenTool } from '../agent/loop';
import { buildSystemPromptFor, findActiveWeek } from '../agent/context';
import { needsWeekOf } from '../agent/round';
import { planEmbed, statusEmbed } from '../agent/render';
import { currentOrNextMondayISO } from '../util/datetime';
import type { ReminderRow } from '../kitchen-do';

/**
 * Kitchen bot spec. Differs from the other three bots in two ways:
 *  - Conversation is partitioned by `week_of`, not `thread_id`.
 *  - Tools may call OpenAI internally (generate_draft, swap_meal) and return
 *    `{ output, usage }` so their token spend folds into the round footer.
 */
export const KITCHEN_SPEC: BotSpec = {
  id: 'kitchen',
  channelEnvKey: 'DISCORD_CHANNEL_ID',
  commands: new Set([
    // Kitchen historically owns /chat as the catch-all chat command for the
    // household. `botForCommand` in bot-registry uses Kitchen as the fallback
    // when a command isn't listed in any other bot's set.
    'plan', 'draft', 'chat', 'now', 'pantry', 'profile',
    'approve', 'grocery', 'reminders',
  ]),
  tools: KITCHEN_TOOLS,
  // Order matters: drop user data tables, preserve `settings` (which holds
  // schema_version + cooking_profile + other config keys). KitchenDO overrides
  // onReset() to re-arm the weekly draft alarm.
  resetTables: ['weeks', 'conversation', 'pantry', 'preferences', 'grocery_lists', 'reminders'],
  scopeColumn: 'week_of',

  buildSystemPrompt: (sql, env, scope) => {
    // Kitchen's prompt is week-scoped. Scope value IS the week_of identifier;
    // relay paths default to currentOrNextMondayISO via defaultScope() below.
    const weekOf = scope.column === 'week_of' ? scope.value : currentOrNextMondayISO(env.TIMEZONE);
    return buildSystemPromptFor(sql, weekOf, env.TIMEZONE);
  },

  executeTool: async (name, args, ctx) =>
    runKitchenTool(name, args, { env: ctx.env, sql: ctx.sql, client: ctx.client }),

  fillDefaultArgs: (toolName, parsed, scope) => {
    if (scope.column !== 'week_of') return parsed;
    if ('week_of' in parsed) return parsed;
    if (!needsWeekOf(toolName)) return parsed;
    return { ...parsed, week_of: scope.value };
  },

  fastRead: (sql, _env, interaction): MessagePayload | null => {
    const cmd = interaction.data?.name ?? '';

    if (cmd === 'profile') {
      const row = sql
        .exec<{ value: string }>("SELECT value FROM settings WHERE key = 'cooking_profile'")
        .toArray()[0];
      if (!row?.value) {
        return { embeds: [statusEmbed({
          title: '👤 Cooking profile',
          description: 'No profile set yet. Use `/profile message: ...` to create one.',
          color: EmbedColor.archived,
        })] };
      }
      return { embeds: [{
        title: '👤 Cooking profile',
        description: row.value.length > 4096 ? row.value.slice(0, 4093) + '…' : row.value,
        color: EmbedColor.inProgress,
      }] };
    }

    if (cmd === 'plan') {
      const week = findActiveWeek(sql);
      if (!week) {
        return { embeds: [statusEmbed({
          title: '🍴 No active plan',
          description: 'No plan in the last 14 days. Use `/chat message: make a plan` to create one.',
          color: EmbedColor.archived,
        })] };
      }
      return { embeds: [planEmbed(week, { includeFooterHint: true })] };
    }

    if (cmd === 'pantry') {
      const items = sql
        .exec<any>('SELECT * FROM pantry ORDER BY location, added_at DESC')
        .toArray();
      if (items.length === 0) {
        return { embeds: [statusEmbed({
          title: '🥫 Pantry',
          description: 'Pantry is empty. Use `/pantry message: I have ...` to add items.',
          color: EmbedColor.archived,
        })] };
      }
      const grouped: Record<string, string[]> = {};
      for (const item of items) {
        const loc = item.location || 'shelf';
        const qty = item.qty_value != null ? ` (${item.qty_value}${item.qty_unit ? ' ' + item.qty_unit : ''})` : '';
        (grouped[loc] ??= []).push(`• ${item.name}${qty}`);
      }
      const fields = (['freezer', 'fridge', 'shelf'] as const)
        .filter((l) => grouped[l]?.length)
        .map((l) => ({
          name: `${l === 'freezer' ? '🧊' : l === 'fridge' ? '🧴' : '🥫'} ${l.toUpperCase()}`,
          value: grouped[l]!.join('\n').slice(0, 1024),
          inline: true,
        }));
      return { embeds: [{
        title: '🥫 Pantry',
        description: `**${items.length}** items`,
        color: EmbedColor.inProgress,
        fields,
      }] };
    }

    if (cmd === 'reminders') {
      const now = Date.now();
      const upcoming = sql.exec<ReminderRow>(
        'SELECT * FROM reminders WHERE sent_at IS NULL AND due_at >= ? ORDER BY due_at ASC LIMIT 25',
        now,
      ).toArray();
      if (upcoming.length === 0) {
        return { embeds: [statusEmbed({
          title: '⏰ Upcoming reminders',
          description: 'No upcoming reminders.',
          color: EmbedColor.archived,
        })] };
      }
      const lines = upcoming.map((r) => {
        const icon = r.type === 'defrost' ? '🧊' : r.type === 'prep' ? '🥣' : '⏰';
        const preview = r.message.split('\n')[0]!.replace(/\*\*/g, '').slice(0, 100);
        return `${icon} <t:${Math.floor(r.due_at / 1000)}:R> · ${preview}`;
      });
      return { embeds: [{
        title: '⏰ Upcoming reminders',
        description: lines.join('\n').slice(0, 4096),
        color: EmbedColor.reminder,
      }] };
    }

    // /grocery is intentionally NOT a fast-read — sometimes large enough to
    // warrant the deferred + follow-up path; KitchenDO handles it directly.

    return null;
  },

  /** Default for relay-path messages (no SQL access in the worker).
   *  Slash-command paths have SQL and may override with findActiveWeek before
   *  dispatching, so the agent sees the slice of history relevant to the
   *  currently-active plan. */
  defaultScope: (env, _replyChannelId) => ({
    column: 'week_of',
    value: currentOrNextMondayISO(env.TIMEZONE),
  }),

  // Migrations preserved verbatim from kitchen-do.ts (versions 1-5).
  migrations: [
    {
      version: 1,
      up: (sql) => {
        sql.exec(`
          CREATE TABLE IF NOT EXISTS weeks (
            week_of TEXT PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'draft',
            meals_json TEXT NOT NULL DEFAULT '[]',
            constraints_json TEXT NOT NULL DEFAULT '[]',
            drafted_at INTEGER NOT NULL,
            approved_at INTEGER
          );
          CREATE TABLE IF NOT EXISTS conversation (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            week_of TEXT,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            tool_call_json TEXT,
            ts INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS preferences (
            id TEXT PRIMARY KEY,
            insight TEXT NOT NULL,
            rationale TEXT NOT NULL,
            weight INTEGER NOT NULL DEFAULT 5,
            learned_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS pantry (
            name TEXT PRIMARY KEY,
            qty TEXT,
            added_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS grocery_lists (
            week_of TEXT PRIMARY KEY,
            items_json TEXT NOT NULL,
            generated_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS reminders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            due_at INTEGER NOT NULL,
            type TEXT NOT NULL,
            week_of TEXT,
            day TEXT,
            message TEXT NOT NULL,
            sent_at INTEGER
          );
          CREATE INDEX IF NOT EXISTS idx_reminders_due
            ON reminders(due_at) WHERE sent_at IS NULL;
          CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
          );
        `);
      },
    },
    {
      // Freezer-tracking columns on pantry. SQLite has no native "ADD COLUMN IF
      // NOT EXISTS" so we introspect via pragma_table_info.
      version: 2,
      up: (sql) => {
        const cols = sql
          .exec<{ name: string }>('SELECT name FROM pragma_table_info(?)', 'pantry')
          .toArray()
          .map((r) => r.name);
        const have = new Set(cols);
        if (!have.has('location')) {
          sql.exec("ALTER TABLE pantry ADD COLUMN location TEXT DEFAULT 'shelf'");
        }
        if (!have.has('qty_value')) {
          sql.exec('ALTER TABLE pantry ADD COLUMN qty_value REAL');
        }
        if (!have.has('qty_unit')) {
          sql.exec('ALTER TABLE pantry ADD COLUMN qty_unit TEXT');
        }
      },
    },
    {
      // Index for unbounded conversation table + the prune helper that runs hourly.
      version: 3,
      up: (sql) => {
        sql.exec(
          'CREATE INDEX IF NOT EXISTS idx_conversation_week ON conversation(week_of, id DESC)',
        );
      },
    },
    { version: 4, up: (sql) => ensureRelayRateSchema(sql) },
    { version: 5, up: (sql) => ensureUsageSchema(sql) },
  ],
};
