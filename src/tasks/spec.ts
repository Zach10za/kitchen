import type { BotSpec } from '../runtime/bot-spec';
import type { MessagePayload } from '../discord/types';
import { ensureRelayRateSchema } from '../runtime/relay-rate-limit';
import { ensureUsageSchema } from '../runtime/usage';
import { TASKS_TOOLS } from './tools';
import { executeTasksTool, buildTaskStats, TASK_ORDER_SQL, DUE_SOON_WINDOW_MS, type TaskRow } from './loop';
import { buildTasksSystemPrompt } from './prompts';
import { taskSummaryEmbed, tasksListEmbed, tasksDueEmbed } from './render';

/** Tasks bot spec — see runtime/bot-spec.ts for the contract. */
export const TASKS_SPEC: BotSpec = {
  id: 'tasks',
  channelEnvKey: 'DISCORD_TASKS_CHANNEL_ID',
  commands: new Set([
    'tasks',
    'tasks-open',
    'tasks-next',
    'tasks-blocked',
    'tasks-due',
  ]),
  tools: TASKS_TOOLS,
  resetTables: ['tasks', 'task_deps', 'conversation'],
  scopeColumn: 'thread_id',

  buildSystemPrompt: (sql, env) => buildTasksSystemPrompt(sql, env.TIMEZONE),

  executeTool: (name, args, ctx) =>
    executeTasksTool(name, args, { sql: ctx.sql, timezone: ctx.timezone }),

  fastRead: (sql, _env, interaction): MessagePayload | null => {
    const cmd = interaction.data?.name ?? '';

    if (cmd === 'tasks') {
      return { embeds: [taskSummaryEmbed(buildTaskStats(sql))] };
    }

    if (cmd === 'tasks-open') {
      const tasks = sql
        .exec<TaskRow>(
          `SELECT t.* FROM tasks t
           WHERE t.status NOT IN ('done','cancelled')
           ORDER BY ${TASK_ORDER_SQL}`,
        )
        .toArray();
      return { embeds: [tasksListEmbed('📋 Open Tasks', tasks)] };
    }

    if (cmd === 'tasks-next') {
      const tasks = sql
        .exec<TaskRow>(
          `SELECT t.* FROM tasks t
           WHERE t.status IN ('todo', 'in_progress')
             AND NOT EXISTS (
               SELECT 1 FROM task_deps d
               JOIN tasks blocker ON blocker.id = d.depends_on_id
               WHERE d.task_id = t.id AND blocker.status NOT IN ('done', 'cancelled')
             )
           ORDER BY ${TASK_ORDER_SQL}`,
        )
        .toArray();
      return { embeds: [tasksListEmbed('✅ Ready to Work On', tasks)] };
    }

    if (cmd === 'tasks-blocked') {
      const tasks = sql
        .exec<TaskRow>(
          `SELECT DISTINCT t.* FROM tasks t
           JOIN task_deps d ON d.task_id = t.id
           JOIN tasks blocker ON blocker.id = d.depends_on_id
           WHERE t.status NOT IN ('done', 'cancelled')
             AND blocker.status NOT IN ('done', 'cancelled')
           ORDER BY ${TASK_ORDER_SQL}`,
        )
        .toArray();
      return { embeds: [tasksListEmbed('⛔ Blocked Tasks', tasks)] };
    }

    if (cmd === 'tasks-due') {
      // Overdue + due within the next 7d. Done/cancelled excluded — past-due
      // tasks you already closed aren't actionable.
      const cutoff = Date.now() + DUE_SOON_WINDOW_MS;
      const tasks = sql
        .exec<TaskRow>(
          `SELECT t.* FROM tasks t
           WHERE t.status NOT IN ('done','cancelled')
             AND t.due_at IS NOT NULL
             AND t.due_at <= ?
           ORDER BY t.due_at ASC, ${TASK_ORDER_SQL}`,
          cutoff,
        )
        .toArray();
      return { embeds: [tasksDueEmbed(tasks)] };
    }

    return null;
  },

  defaultScope: (_env, replyChannelId) => ({ column: 'thread_id', value: replyChannelId }),

  // Migrations preserved verbatim from tasks-do.ts (versions 1-4).
  migrations: [
    {
      version: 1,
      up: (sql) => {
        sql.exec(`
          CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'todo',
            type TEXT NOT NULL DEFAULT 'short',
            parent_id TEXT REFERENCES tasks(id),
            notes TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
          CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);

          CREATE TABLE IF NOT EXISTS task_deps (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL,
            depends_on_id TEXT NOT NULL,
            UNIQUE(task_id, depends_on_id)
          );
          CREATE INDEX IF NOT EXISTS idx_deps_task ON task_deps(task_id);
          CREATE INDEX IF NOT EXISTS idx_deps_on ON task_deps(depends_on_id);

          CREATE TABLE IF NOT EXISTS conversation (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            tool_call_json TEXT,
            thread_id TEXT,
            ts INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_conv_thread ON conversation(thread_id, id DESC);
        `);
      },
    },
    { version: 2, up: (sql) => ensureRelayRateSchema(sql) },
    { version: 3, up: (sql) => ensureUsageSchema(sql) },
    {
      // v4 adds priority + due_at. SQLite has no `ALTER TABLE ADD COLUMN IF NOT
      // EXISTS`, so probe first.
      version: 4,
      up: (sql) => {
        const existingColumns = sql
          .exec<{ name: string }>("PRAGMA table_info(tasks)")
          .toArray()
          .map((r) => r.name);
        if (!existingColumns.includes('priority')) {
          sql.exec("ALTER TABLE tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal'");
        }
        if (!existingColumns.includes('due_at')) {
          sql.exec("ALTER TABLE tasks ADD COLUMN due_at INTEGER");
        }
        sql.exec("CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_at) WHERE due_at IS NOT NULL");
        sql.exec("CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority)");
      },
    },
  ],
};
