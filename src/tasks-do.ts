import type { Env } from './env';
import type { Interaction } from './discord/types';
import { AgentDOBase } from './runtime/agent-do-base';
import { TASKS_SPEC } from './tasks/spec';
import { buildTaskStats } from './tasks/loop';

/**
 * TasksDO holds task-tracking state. Shape identical to the other thread-
 * scoped bots; everything universal lives in `AgentDOBase`. Tasks-specific
 * concerns here are limited to slash-command dispatch and a richer /dump.
 */
export class TasksDO extends AgentDOBase<Env> {
  protected readonly spec = TASKS_SPEC;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ensureSchema();
  }

  protected async dispatchCommand(interaction: Interaction): Promise<void> {
    const commandName = interaction.data?.name ?? '';
    const optionMap = Object.fromEntries(
      (interaction.data?.options ?? []).map((o) => [o.name, o.value]),
    );

    // /tasks with a message → AgentChatWorkflow. Bare /tasks short-circuits
    // through the Worker fast-read path before this handler runs.
    if (commandName === 'tasks' && optionMap.message) {
      const message = String(optionMap.message);
      await this.dispatchChatInteraction(interaction, message, `tasks: ${message}`);
      return;
    }

    await this.discord.editOriginal(
      interaction.token,
      `Unknown tasks command: \`${commandName}\``,
    );
  }

  protected async customDump(): Promise<Record<string, unknown>> {
    const stats = buildTaskStats(this.sql);
    const recentTasks = this.sql.exec('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT 30').toArray();
    const deps = this.sql.exec('SELECT * FROM task_deps').toArray();
    const recentConv = this.sql.exec(
      'SELECT id, role, ts, substr(content, 1, 200) AS preview FROM conversation ORDER BY id DESC LIMIT 30',
    ).toArray();
    return {
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
    };
  }
}
