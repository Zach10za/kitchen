import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import type { Interaction, MessagePayload } from './discord/types';
import { DiscordAPI } from './discord/api';
import { prepareInteractionThread } from './discord/thread';
import { captureError } from './error-triage';
import { runMigrations, type Migration } from './runtime/migrations';
import { maybePruneConversationByThread } from './runtime/conversation';
import {
  checkRelayRateLimit as checkRelayRate,
  ensureRelayRateSchema,
} from './runtime/relay-rate-limit';
import {
  ensureUsageSchema,
  recordUsage,
  sumUsageByThread,
  sumUsageSince,
  countTurnsByThread,
} from './runtime/usage';
import { buildTasksSystemPrompt } from './tasks/prompts';
import {
  executeTasksTool,
  buildTaskStats,
  TASK_ORDER_SQL,
  DUE_SOON_WINDOW_MS,
  type TaskRow,
} from './tasks/loop';
import { taskSummaryEmbed, tasksListEmbed, tasksDueEmbed } from './tasks/render';

/** Keep this many most-recent conversation rows per thread when pruning. */
const CONVERSATION_PRUNE_KEEP = 400;

/**
 * TasksDO holds all task-tracking state for the user. Mirrors FinanceDO in
 * shape — same SQLite + conversation + rate-limit + usage patterns, completely
 * separate schema.
 *
 * Responsibilities:
 *  - Persist tasks, dependencies, and conversation in SQLite
 *  - Serve as state backing for TasksSteerWorkflow (which runs the agent)
 *  - Handle fast-read commands directly
 */
export class TasksDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private discord: DiscordAPI;
  private lastConversationPruneAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.discord = new DiscordAPI(env.DISCORD_BOT_TOKEN, env.DISCORD_APP_ID);
    runMigrations(this.sql, TasksDO.MIGRATIONS);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/interaction') {
      const interaction = (await request.json()) as Interaction;
      this.ctx.waitUntil(
        this.handleInteraction(interaction).catch(async (err) => {
          console.error('tasks handleInteraction failed', err);
          await captureError(this.env, err, {
            source: `tasks-interaction:${interaction.data?.name ?? 'unknown'}`,
            tags: {
              interaction_type: interaction.type,
              channel_id: interaction.channel_id,
              guild_id: interaction.guild_id,
            },
          });
          await this.discord
            .editOriginal(interaction.token, `Something broke: ${(err as Error).message}`)
            .catch(() => {});
        })
      );
      return new Response('queued');
    }

    if (url.pathname === '/heartbeat') {
      this.maybePruneConversation();
      return new Response('ok');
    }

    if (url.pathname === '/relay-allowed' && request.method === 'POST') {
      const body = (await request.json()) as { channelId: string };
      if (!body.channelId) return Response.json({ allowed: false, reason: 'missing channelId' }, { status: 400 });
      const limit = Number(this.env.RELAY_RATE_LIMIT_PER_HOUR ?? '') || undefined;
      const decision = checkRelayRate(this.sql, body.channelId, limit);
      return Response.json(decision, { status: decision.allowed ? 200 : 429 });
    }

    if (url.pathname === '/fast-read') {
      // Wrap in try/catch so a SQL or schema error doesn't return a bare 500 to
      // the Worker (and thus a silent "did not respond" to the user) — match
      // the workout-do pattern.
      try {
        const interaction = (await request.json()) as Interaction;
        const payload = this.handleFastRead(interaction);
        return Response.json(payload);
      } catch (err) {
        console.error('tasks /fast-read failed', err);
        await captureError(this.env, err, { source: 'tasks:fast-read' });
        return Response.json({ content: `Something broke: ${(err as Error).message}` });
      }
    }

    if (url.pathname === '/reset' && request.method === 'POST') {
      this.sql.exec('DELETE FROM tasks');
      this.sql.exec('DELETE FROM task_deps');
      this.sql.exec('DELETE FROM conversation');
      return Response.json({ status: 'ok', cleared: ['tasks', 'task_deps', 'conversation'] });
    }

    // ─── TasksSteerWorkflow IO ────────────────────────────────────────

    if (url.pathname === '/workflow/tasks/load-context') {
      const threadId = url.searchParams.get('thread_id');
      const systemPrompt = buildTasksSystemPrompt(this.sql, this.env.TIMEZONE);
      const history = threadId
        ? this.sql
            .exec<{ role: string; content: string }>(
              "SELECT role, content FROM conversation WHERE thread_id = ? AND role IN ('user', 'assistant') ORDER BY id DESC LIMIT 30",
              threadId
            )
            .toArray()
            .reverse()
        : this.sql
            .exec<{ role: string; content: string }>(
              "SELECT role, content FROM conversation WHERE thread_id IS NULL AND role IN ('user', 'assistant') ORDER BY id DESC LIMIT 30"
            )
            .toArray()
            .reverse();
      return Response.json({ systemPrompt, history });
    }

    if (url.pathname === '/workflow/tasks/save-turn' && request.method === 'POST') {
      const body = (await request.json()) as {
        role: string;
        content: string;
        tool_call_json?: string;
        thread_id?: string;
      };
      this.sql.exec(
        'INSERT INTO conversation (role, content, tool_call_json, thread_id, ts) VALUES (?, ?, ?, ?, ?)',
        body.role, body.content, body.tool_call_json ?? null, body.thread_id ?? null, Date.now()
      );
      return Response.json({ ok: true });
    }

    if (url.pathname === '/workflow/tasks/record-usage' && request.method === 'POST') {
      const body = (await request.json()) as Parameters<typeof recordUsage>[1];
      const totals = recordUsage(this.sql, body);
      return Response.json({ thread_total_usage: totals });
    }

    if (url.pathname === '/workflow/tasks/cost-summary') {
      const threadId = url.searchParams.get('thread_id');
      const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days') ?? 30)));
      const sinceMs = Date.now() - days * 86_400_000;
      const totals = threadId ? sumUsageByThread(this.sql, threadId) : sumUsageSince(this.sql, sinceMs);
      const turnCount = threadId
        ? countTurnsByThread(this.sql, threadId)
        : this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM usage WHERE ts >= ?', sinceMs).toArray()[0]?.n ?? 0;
      return Response.json({ usage: totals, turn_count: turnCount, days, thread_id: threadId });
    }

    if (url.pathname === '/workflow/tasks/exec-tool' && request.method === 'POST') {
      const body = (await request.json()) as { name: string; args: any };
      const result = executeTasksTool(body.name, body.args, { sql: this.sql, timezone: this.env.TIMEZONE });
      return new Response(result, { headers: { 'content-type': 'text/plain' } });
    }

    if (url.pathname === '/dump') {
      const stats = buildTaskStats(this.sql);
      const recentTasks = this.sql.exec('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT 30').toArray();
      const deps = this.sql.exec('SELECT * FROM task_deps').toArray();
      const recentConv = this.sql.exec('SELECT id, role, ts, substr(content, 1, 200) AS preview FROM conversation ORDER BY id DESC LIMIT 30').toArray();
      return new Response(
        JSON.stringify(
          {
            now: Date.now(),
            stats: {
              total: stats.total,
              by_status: stats.byStatus,
              by_priority: stats.byPriority,
              overdue_count: stats.overdueTasks.length,
              ready_count: stats.readyTasks.length,
              blocked_count: stats.blockedTasks.length,
              in_progress_count: stats.inProgressTasks.length,
            },
            in_progress: stats.inProgressTasks,
            ready: stats.readyTasks,
            blocked: stats.blockedTasks,
            overdue: stats.overdueTasks,
            recent_tasks: recentTasks,
            deps,
            recent_conversation: recentConv,
          },
          null,
          2
        ),
        { headers: { 'content-type': 'application/json' } }
      );
    }

    return new Response('not found', { status: 404 });
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    const commandName = interaction.data?.name ?? '';
    const optionMap = Object.fromEntries(
      (interaction.data?.options ?? []).map((o) => [o.name, o.value])
    );

    // /tasks with a message → run via TasksSteerWorkflow
    if (commandName === 'tasks' && optionMap.message) {
      const message = String(optionMap.message);
      const replyChannelId = await this.openReplyThread(interaction, `tasks: ${message}`);
      await this.env.TASKS_STEER_WORKFLOW.create({
        params: { userMessage: message, replyChannelId },
      });
      return;
    }

    await this.discord.editOriginal(
      interaction.token,
      `Unknown tasks command: \`${commandName}\``
    );
  }

  /**
   * Synchronous read-only command handler. Returns a {content?, embeds?} payload
   * directly without LLM calls.
   */
  private handleFastRead(interaction: Interaction): MessagePayload {
    const cmd = interaction.data?.name ?? '';

    if (cmd === 'tasks') {
      // Bare /tasks — show the summary embed
      const stats = buildTaskStats(this.sql);
      return { embeds: [taskSummaryEmbed(stats)] };
    }

    if (cmd === 'tasks-open') {
      const tasks = this.sql
        .exec<TaskRow>(
          `SELECT t.* FROM tasks t
           WHERE t.status NOT IN ('done','cancelled')
           ORDER BY ${TASK_ORDER_SQL}`
        )
        .toArray();
      return { embeds: [tasksListEmbed('📋 Open Tasks', tasks)] };
    }

    if (cmd === 'tasks-next') {
      const tasks = this.sql
        .exec<TaskRow>(
          `SELECT t.* FROM tasks t
           WHERE t.status IN ('todo', 'in_progress')
             AND NOT EXISTS (
               SELECT 1 FROM task_deps d
               JOIN tasks blocker ON blocker.id = d.depends_on_id
               WHERE d.task_id = t.id AND blocker.status NOT IN ('done', 'cancelled')
             )
           ORDER BY ${TASK_ORDER_SQL}`
        )
        .toArray();
      return { embeds: [tasksListEmbed('✅ Ready to Work On', tasks)] };
    }

    if (cmd === 'tasks-blocked') {
      const tasks = this.sql
        .exec<TaskRow>(
          `SELECT DISTINCT t.* FROM tasks t
           JOIN task_deps d ON d.task_id = t.id
           JOIN tasks blocker ON blocker.id = d.depends_on_id
           WHERE t.status NOT IN ('done', 'cancelled')
             AND blocker.status NOT IN ('done', 'cancelled')
           ORDER BY ${TASK_ORDER_SQL}`
        )
        .toArray();
      return { embeds: [tasksListEmbed('⛔ Blocked Tasks', tasks)] };
    }

    if (cmd === 'tasks-due') {
      // Overdue + due within the next 7d. Done/cancelled excluded — past-due
      // tasks you already closed aren't actionable.
      const cutoff = Date.now() + DUE_SOON_WINDOW_MS;
      const tasks = this.sql
        .exec<TaskRow>(
          `SELECT t.* FROM tasks t
           WHERE t.status NOT IN ('done','cancelled')
             AND t.due_at IS NOT NULL
             AND t.due_at <= ?
           ORDER BY t.due_at ASC, ${TASK_ORDER_SQL}`,
          cutoff
        )
        .toArray();
      return { embeds: [tasksDueEmbed(tasks)] };
    }

    return { content: `Unknown fast-read tasks command: ${cmd}` };
  }

  /** Wrap a Discord interaction with our standard "open thread + reply" pattern. */
  private async openReplyThread(interaction: Interaction, titleSeed: string): Promise<string> {
    return prepareInteractionThread({
      discord: this.discord,
      env: this.env,
      interactionToken: interaction.token,
      titleSeed,
    });
  }

  private maybePruneConversation(): void {
    this.lastConversationPruneAt = maybePruneConversationByThread(
      (sql, ...params) => this.sql.exec(sql, ...params),
      this.lastConversationPruneAt,
      CONVERSATION_PRUNE_KEEP,
    );
  }

  /**
   * Schema migrations. Append-only, never mutate or remove existing entries.
   * Independent of KitchenDO's and FinanceDO's schema_version.
   */
  private static readonly MIGRATIONS: readonly Migration[] = [
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
    {
      version: 2,
      up: (sql) => ensureRelayRateSchema(sql),
    },
    {
      version: 3,
      up: (sql) => ensureUsageSchema(sql),
    },
    {
      // v4 adds priority + due_at. Migrations are append-only — we never
      // mutate v1 — so new installs also reach these columns via this step.
      // SQLite has no `ALTER TABLE ADD COLUMN IF NOT EXISTS`, so probe first.
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
  ];
}
