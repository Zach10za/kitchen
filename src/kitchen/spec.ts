import type { BotSpec } from '../runtime/bot-spec';
import type { MessagePayload } from '../discord/types';
import { EmbedColor } from '../discord/types';
import { ensureRelayRateSchema } from '../runtime/relay-rate-limit';
import { ensureUsageSchema } from '../runtime/usage';
import { TOOLS as KITCHEN_TOOLS } from '../agent/tools';
import { executeTool as runKitchenTool } from '../agent/loop';
import { buildSystemPromptFor, loadRepertoire } from '../agent/context';
import { statusEmbed } from '../agent/render';
import type { ReminderRow } from '../kitchen-do';

// DDL hoisted to module-scope constants so the multi-statement schema is
// passed to sql.exec() by reference (keeps each migration body readable).
const SCHEMA_V1_DDL = `
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
`;

const SCHEMA_V6_MEALS_DDL = `
  CREATE TABLE IF NOT EXISTS meals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    name TEXT,
    cuisine TEXT,
    description TEXT,
    ingredients_json TEXT,
    steps_json TEXT,
    requires_defrost_json TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_meals_date ON meals(date);
`;

// v7: the living-cookbook layer — post-cook feedback + cookbook-page extras on
// meals, and an item-level grocery list (distinct from the weekly
// grocery_lists table v6 dropped).
const SCHEMA_V7_GROCERY_DDL = `
  CREATE TABLE IF NOT EXISTS grocery (
    name TEXT PRIMARY KEY,
    qty TEXT,
    for_dish TEXT,
    location TEXT,
    added_at INTEGER NOT NULL
  );
`;
const MEALS_V7_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['protein', 'TEXT'],
  ['effort', 'TEXT'],
  ['extras_json', 'TEXT'],
  ['rating', 'INTEGER'],
  ['cook_notes', 'TEXT'],
];

/**
 * Kitchen bot spec. Daily-first: the agent suggests dinner for today and records
 * a decision only when the user makes one. Conversation is partitioned by
 * `thread_id` like the other bots — there is no weekly plan, so no week scoping.
 */
export const KITCHEN_SPEC: BotSpec = {
  id: 'kitchen',
  channelEnvKey: 'DISCORD_CHANNEL_ID',
  commands: new Set([
    // Kitchen owns /chat as the catch-all chat command for the household.
    // `botForCommand` in bot-registry uses Kitchen as the fallback when a
    // command isn't listed in any other bot's set.
    'cook', 'chat', 'now', 'pantry', 'profile', 'reminders', 'grocery', 'cookbook',
  ]),
  tools: KITCHEN_TOOLS,
  // Drop user data tables, preserve `settings` (schema_version + cooking_profile).
  // KitchenDO overrides onReset() to re-arm the daily suggestion alarm.
  resetTables: ['meals', 'conversation', 'pantry', 'preferences', 'reminders', 'grocery'],
  scopeColumn: 'thread_id',

  buildSystemPrompt: (sql, env) =>
    buildSystemPromptFor(sql, env.TIMEZONE, Number(env.DINNER_HOUR_LOCAL) || 18),

  executeTool: (name, args, ctx) =>
    runKitchenTool(name, args, { env: ctx.env, sql: ctx.sql, client: ctx.client }),

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

    if (cmd === 'grocery') {
      const items = sql
        .exec<{ name: string; qty: string | null; for_dish: string | null }>(
          'SELECT name, qty, for_dish FROM grocery ORDER BY added_at ASC',
        )
        .toArray();
      if (items.length === 0) {
        return { embeds: [statusEmbed({
          title: '🛒 Grocery list',
          description: 'Nothing on the list. Items land here when you pick a dish that needs something, or say `/grocery message: add ...`.',
          color: EmbedColor.archived,
        })] };
      }
      const lines = items.map((i) => {
        const qty = i.qty ? `${i.qty} ` : '';
        const why = i.for_dish ? ` — _${i.for_dish}_` : '';
        return `• ${qty}${i.name}${why}`;
      });
      return { embeds: [{
        title: `🛒 Grocery list — ${items.length} item${items.length === 1 ? '' : 's'}`,
        description: lines.join('\n').slice(0, 4096),
        color: EmbedColor.inProgress,
        footer: { text: 'Say "got everything" after shopping and it all moves to the pantry' },
      }] };
    }

    if (cmd === 'cookbook') {
      const dishes = loadRepertoire(sql, 15);
      if (dishes.length === 0) {
        return { embeds: [statusEmbed({
          title: '📖 House cookbook',
          description: 'No rated dishes yet. After you cook something, tell me how it went — rated dishes build your repertoire here.',
          color: EmbedColor.archived,
        })] };
      }
      const lines = dishes.map((d) => {
        const times = d.timesCooked > 1 ? `, cooked ${d.timesCooked}x` : '';
        const notes = d.notes ? `\n  ↳ _${d.notes.slice(0, 150)}_` : '';
        return `**${d.name}** — ${d.rating}/10${times}, last ${d.lastDate}${notes}`;
      });
      return { embeds: [{
        title: `📖 House cookbook — ${dishes.length} rated dish${dishes.length === 1 ? '' : 'es'}`,
        description: lines.join('\n').slice(0, 4096),
        color: EmbedColor.approved,
        footer: { text: 'Ask for any of these and you get YOUR version, notes applied' },
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

    return null;
  },

  /** Relay + slash-command chat both land in the reply thread's own context. */
  defaultScope: (_env, replyChannelId) => ({
    column: 'thread_id',
    value: replyChannelId,
  }),

  migrations: [
    { version: 1, up: (sql) => { sql.exec(SCHEMA_V1_DDL); } },
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
      version: 3,
      up: (sql) => {
        sql.exec(
          'CREATE INDEX IF NOT EXISTS idx_conversation_week ON conversation(week_of, id DESC)',
        );
      },
    },
    { version: 4, up: (sql) => ensureRelayRateSchema(sql) },
    { version: 5, up: (sql) => ensureUsageSchema(sql) },
    {
      // Daily-first pivot: drop the weekly plan + grocery tables, add `meals`
      // (one decided dish or no-cook night per date) + a thread_id column on
      // conversation so kitchen scopes like the other bots. Existing week-scoped
      // conversation rows are left in place — week_of is simply no longer read.
      version: 6,
      up: (sql) => {
        sql.exec('DROP TABLE IF EXISTS weeks');
        sql.exec('DROP TABLE IF EXISTS grocery_lists');
        sql.exec(SCHEMA_V6_MEALS_DDL);
        const cols = sql
          .exec<{ name: string }>('SELECT name FROM pragma_table_info(?)', 'conversation')
          .toArray()
          .map((r) => r.name);
        if (!cols.includes('thread_id')) {
          sql.exec('ALTER TABLE conversation ADD COLUMN thread_id TEXT');
          sql.exec('CREATE INDEX IF NOT EXISTS idx_conversation_thread ON conversation(thread_id, id DESC)');
        }
      },
    },
    {
      // Living cookbook: rating + next-time notes + cookbook-page extras on
      // meals, plus the running grocery list.
      version: 7,
      up: (sql) => {
        const cols = sql
          .exec<{ name: string }>('SELECT name FROM pragma_table_info(?)', 'meals')
          .toArray()
          .map((r) => r.name);
        const have = new Set(cols);
        for (const [col, type] of MEALS_V7_COLUMNS) {
          if (!have.has(col)) {
            sql.exec(`ALTER TABLE meals ADD COLUMN ${col} ${type}`);
          }
        }
        sql.exec(SCHEMA_V7_GROCERY_DDL);
      },
    },
  ],
};
