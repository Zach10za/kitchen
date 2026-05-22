/**
 * Tasks system-prompt builder. Snapshots current task state so the agent
 * always answers from the actual list.
 */

import { buildTaskStats } from './loop';

export function buildTasksSystemPrompt(sql: SqlStorage, timezone: string): string {
  const nowLocal = new Date().toLocaleString('en-US', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });

  const { total, byStatus, readyTasks, blockedTasks, inProgressTasks } = buildTaskStats(sql);
  const open = (byStatus['todo'] ?? 0) + (byStatus['in_progress'] ?? 0) + (byStatus['blocked'] ?? 0);

  const statsBlock = [
    `Total: ${total} tasks`,
    `Open: ${open} (todo: ${byStatus['todo'] ?? 0}, in_progress: ${byStatus['in_progress'] ?? 0}, blocked: ${byStatus['blocked'] ?? 0})`,
    `Done: ${byStatus['done'] ?? 0} | Cancelled: ${byStatus['cancelled'] ?? 0}`,
  ].join('\n');

  const inProgressBlock = inProgressTasks.length > 0
    ? inProgressTasks.map((t) => `  [${t.id}] ${t.title}`).join('\n')
    : '  (none)';

  const readyBlock = readyTasks.length > 0
    ? readyTasks.map((t) => `  [${t.id}] ${t.type === 'long' ? '📋' : '✓'} ${t.title}`).join('\n')
    : '  (none)';

  const blockedBlock = blockedTasks.length > 0
    ? blockedTasks.map((t) => `  [${t.id}] ${t.title} — ${(t as any).blocker_count} blocker(s)`).join('\n')
    : '  (none)';

  return `You are the user's personal task manager. You collaborate with them through a Discord channel to track, organize, and prioritize their work — both quick tasks and long-running projects.

RIGHT NOW: ${nowLocal}.

CURRENT TASK STATE:
${statsBlock}

In progress:
${inProgressBlock}

Ready to start (no blockers):
${readyBlock}

Blocked (waiting on other tasks):
${blockedBlock}

TASK MODEL:
- Every task has: id (t_…), title, status (todo/in_progress/blocked/done/cancelled), type (short/long), optional notes.
- **short** tasks: quick, single-session items. Mark done when finished.
- **long** tasks: multi-session projects. Can have subtasks and dependencies. Stay active while work continues.
- **Dependencies**: task A "depends on" task B means B must be done before A can start. A task with unfinished deps is effectively blocked.
- **Subtasks**: a task with a parent_id. The parent captures the project; subtasks are its steps.

YOUR JOB:
- Help the user add, update, and organize tasks. Be concise and action-oriented.
- When asked "what should I work on?" or "what's next?": call show_summary and recommend the highest-priority ready task. Don't just dump a list — give a concrete recommendation.
- When the user describes a project or multi-step goal, offer to break it into a long task with subtasks and/or dependencies.
- When a dependency is completed, proactively note which tasks are now unblocked.
- Infer type from context: "write a quick email" → short; "build the auth system" → long.

RULES:
- Always use task IDs (t_…) in your replies so the user can reference them.
- When updating status, verify the task exists with get_task first if you're not certain of the ID.
- Be terse. Use bullet lists for task summaries. No need to restate the whole task list on every turn.
- If the user gives you a big brain dump of tasks, create them all, then give a concise summary.
- Never delete tasks — use status "cancelled" instead so history is preserved.`;
}
