/**
 * Tasks tool implementations. The workflow runner (TasksSteerWorkflow) drives
 * the agent loop via runtime/agent-round; tool execution lives here and is
 * called from TasksDO's /workflow/tasks/exec-tool endpoint.
 */

import type { TaskRow } from './tools';

export interface TasksToolCtx {
  sql: SqlStorage;
}

export function executeTasksTool(name: string, args: any, ctx: TasksToolCtx): string {
  try {
    switch (name) {
      case 'show_summary':    return toolShowSummary(ctx);
      case 'list_tasks':      return toolListTasks(args, ctx);
      case 'get_task':        return toolGetTask(args, ctx);
      case 'add_task':        return toolAddTask(args, ctx);
      case 'update_task':     return toolUpdateTask(args, ctx);
      case 'add_dependency':  return toolAddDependency(args, ctx);
      case 'remove_dependency': return toolRemoveDependency(args, ctx);
      default:                return `Unknown tasks tool: ${name}`;
    }
  } catch (err) {
    return `Tool ${name} failed: ${(err as Error).message}`;
  }
}

// ─── ID generation ────────────────────────────────────────────────────

function newTaskId(): string {
  return `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

// ─── Tool implementations ─────────────────────────────────────────────

function toolShowSummary(ctx: TasksToolCtx): string {
  const counts = ctx.sql
    .exec<{ status: string; n: number }>(
      `SELECT status, COUNT(*) AS n FROM tasks GROUP BY status`
    )
    .toArray();

  const byStatus: Record<string, number> = {};
  for (const row of counts) byStatus[row.status] = row.n;

  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
  const open = (byStatus['todo'] ?? 0) + (byStatus['in_progress'] ?? 0) + (byStatus['blocked'] ?? 0);

  // "Ready" tasks: todo/in_progress with no unfinished dependencies
  const ready = ctx.sql
    .exec<TaskRow>(
      `SELECT t.* FROM tasks t
       WHERE t.status IN ('todo', 'in_progress')
         AND NOT EXISTS (
           SELECT 1 FROM task_deps d
           JOIN tasks blocker ON blocker.id = d.depends_on_id
           WHERE d.task_id = t.id
             AND blocker.status NOT IN ('done', 'cancelled')
         )
       ORDER BY t.created_at ASC
       LIMIT 5`
    )
    .toArray();

  // Blocked tasks: have at least one unfinished dependency
  const blocked = ctx.sql
    .exec<TaskRow & { blocker_count: number }>(
      `SELECT t.*, COUNT(d.depends_on_id) AS blocker_count
       FROM tasks t
       JOIN task_deps d ON d.task_id = t.id
       JOIN tasks blocker ON blocker.id = d.depends_on_id
       WHERE t.status NOT IN ('done', 'cancelled')
         AND blocker.status NOT IN ('done', 'cancelled')
       GROUP BY t.id
       ORDER BY t.created_at ASC
       LIMIT 5`
    )
    .toArray();

  const inProgress = ctx.sql
    .exec<TaskRow>(
      `SELECT * FROM tasks WHERE status = 'in_progress' ORDER BY updated_at DESC LIMIT 5`
    )
    .toArray();

  const lines = [
    `Total: ${total} tasks (${open} open, ${byStatus['done'] ?? 0} done, ${byStatus['cancelled'] ?? 0} cancelled)`,
    '',
  ];

  if (inProgress.length > 0) {
    lines.push('In progress:');
    lines.push(...inProgress.map((t) => `  [${t.id}] ${t.type === 'long' ? '📋' : '✓'} ${t.title}`));
    lines.push('');
  }

  if (ready.length > 0) {
    lines.push('Ready to start (no blockers):');
    lines.push(...ready.map((t) => `  [${t.id}] ${t.type === 'long' ? '📋' : '✓'} ${t.title} (${t.status})`));
    lines.push('');
  }

  if (blocked.length > 0) {
    lines.push('Blocked (waiting on other tasks):');
    lines.push(...blocked.map((t) => `  [${t.id}] ${t.title} — waiting on ${(t as any).blocker_count} task(s)`));
  }

  return lines.join('\n').trim();
}

function toolListTasks(
  args: { status?: string; type?: string; parent_id?: string; include_done?: boolean },
  ctx: TasksToolCtx
): string {
  const filters: string[] = [];
  const params: SqlStorageValue[] = [];

  if (args.status === 'open') {
    filters.push(`t.status IN ('todo', 'in_progress', 'blocked')`);
  } else if (args.status) {
    filters.push('t.status = ?');
    params.push(args.status);
  } else if (!args.include_done) {
    filters.push(`t.status NOT IN ('done', 'cancelled')`);
  }

  if (args.type) {
    filters.push('t.type = ?');
    params.push(args.type);
  }

  if (args.parent_id !== undefined) {
    if (args.parent_id) {
      filters.push('t.parent_id = ?');
      params.push(args.parent_id);
    } else {
      filters.push('t.parent_id IS NULL');
    }
  }

  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = ctx.sql
    .exec<TaskRow & { subtask_count: number; blocker_count: number }>(
      `SELECT t.*,
              (SELECT COUNT(*) FROM tasks sub WHERE sub.parent_id = t.id AND sub.status NOT IN ('done','cancelled')) AS subtask_count,
              (SELECT COUNT(*) FROM task_deps d
               JOIN tasks b ON b.id = d.depends_on_id
               WHERE d.task_id = t.id AND b.status NOT IN ('done','cancelled')) AS blocker_count
       FROM tasks t
       ${where}
       ORDER BY t.status ASC, t.created_at ASC`,
      ...params
    )
    .toArray();

  if (rows.length === 0) return 'No tasks match the filter.';

  const lines = rows.map((t) => {
    const icon = statusIcon(t.status);
    const typeLabel = t.type === 'long' ? '[long]' : '';
    const extra: string[] = [];
    if ((t as any).subtask_count > 0) extra.push(`${(t as any).subtask_count} subtask(s)`);
    if ((t as any).blocker_count > 0) extra.push(`⛔ ${(t as any).blocker_count} blocker(s)`);
    const suffix = extra.length > 0 ? ` — ${extra.join(', ')}` : '';
    return `${icon} [${t.id}] ${typeLabel} ${t.title}${suffix}`;
  });
  return `${rows.length} task${rows.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
}

function toolGetTask(args: { id: string }, ctx: TasksToolCtx): string {
  const task = ctx.sql
    .exec<TaskRow>('SELECT * FROM tasks WHERE id = ?', args.id)
    .toArray()[0];

  if (!task) return `No task found with id "${args.id}".`;

  const subtasks = ctx.sql
    .exec<TaskRow>('SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at ASC', args.id)
    .toArray();

  const blockers = ctx.sql
    .exec<{ id: string; title: string; status: string }>(
      `SELECT t.id, t.title, t.status
       FROM task_deps d
       JOIN tasks t ON t.id = d.depends_on_id
       WHERE d.task_id = ?`,
      args.id
    )
    .toArray();

  const blocking = ctx.sql
    .exec<{ id: string; title: string; status: string }>(
      `SELECT t.id, t.title, t.status
       FROM task_deps d
       JOIN tasks t ON t.id = d.task_id
       WHERE d.depends_on_id = ?`,
      args.id
    )
    .toArray();

  const lines = [
    `[${task.id}] ${task.title}`,
    `Status: ${task.status} | Type: ${task.type}`,
    task.parent_id ? `Parent: ${task.parent_id}` : 'Top-level task',
    task.notes ? `Notes: ${task.notes}` : '',
    `Created: ${new Date(task.created_at).toISOString().slice(0, 16)}`,
  ].filter(Boolean);

  if (blockers.length > 0) {
    lines.push('');
    lines.push('Blocked by (must finish first):');
    lines.push(...blockers.map((b) => `  ${statusIcon(b.status)} [${b.id}] ${b.title}`));
  }

  if (blocking.length > 0) {
    lines.push('');
    lines.push('Blocking (waiting for this task):');
    lines.push(...blocking.map((b) => `  ${statusIcon(b.status)} [${b.id}] ${b.title}`));
  }

  if (subtasks.length > 0) {
    lines.push('');
    lines.push('Subtasks:');
    lines.push(...subtasks.map((s) => `  ${statusIcon(s.status)} [${s.id}] ${s.title}`));
  }

  return lines.join('\n');
}

function toolAddTask(
  args: { title: string; type?: string; notes?: string; parent_id?: string },
  ctx: TasksToolCtx
): string {
  const id = newTaskId();
  const type = args.type === 'long' ? 'long' : 'short';
  const now = Date.now();

  // Validate parent exists if given
  if (args.parent_id) {
    const parent = ctx.sql.exec('SELECT id FROM tasks WHERE id = ?', args.parent_id).toArray();
    if (parent.length === 0) return `Parent task "${args.parent_id}" not found.`;
  }

  ctx.sql.exec(
    'INSERT INTO tasks (id, title, status, type, parent_id, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, args.title, 'todo', type, args.parent_id ?? null, args.notes ?? null, now, now
  );

  const parentClause = args.parent_id ? ` (subtask of ${args.parent_id})` : '';
  return `Created task [${id}]: "${args.title}" (${type})${parentClause}`;
}

function toolUpdateTask(
  args: { id: string; title?: string; status?: string; type?: string; notes?: string },
  ctx: TasksToolCtx
): string {
  const task = ctx.sql
    .exec<TaskRow>('SELECT * FROM tasks WHERE id = ?', args.id)
    .toArray()[0];

  if (!task) return `No task found with id "${args.id}".`;

  const updates: string[] = [];
  const params: SqlStorageValue[] = [];

  if (args.title !== undefined) { updates.push('title = ?'); params.push(args.title); }
  if (args.status !== undefined) { updates.push('status = ?'); params.push(args.status); }
  if (args.type !== undefined) { updates.push('type = ?'); params.push(args.type); }
  if (args.notes !== undefined) { updates.push('notes = ?'); params.push(args.notes); }

  if (updates.length === 0) return 'No fields to update.';

  updates.push('updated_at = ?');
  params.push(Date.now());
  params.push(args.id);

  ctx.sql.exec(
    `UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`,
    ...params
  );

  const changes = Object.entries(args)
    .filter(([k]) => k !== 'id')
    .map(([k, v]) => `${k}="${v}"`)
    .join(', ');
  return `Updated task [${args.id}]: ${changes}.`;
}

function toolAddDependency(
  args: { task_id: string; depends_on_id: string },
  ctx: TasksToolCtx
): string {
  if (args.task_id === args.depends_on_id) {
    return 'A task cannot depend on itself.';
  }

  // Validate both tasks exist
  const task = ctx.sql.exec('SELECT id FROM tasks WHERE id = ?', args.task_id).toArray();
  if (task.length === 0) return `Task "${args.task_id}" not found.`;
  const dep = ctx.sql.exec('SELECT id FROM tasks WHERE id = ?', args.depends_on_id).toArray();
  if (dep.length === 0) return `Task "${args.depends_on_id}" not found.`;

  // Cycle detection: would adding this edge create a cycle?
  if (wouldCycle(ctx.sql, args.task_id, args.depends_on_id)) {
    return `Cannot add dependency: would create a cycle (${args.depends_on_id} already depends on ${args.task_id} directly or transitively).`;
  }

  try {
    ctx.sql.exec(
      'INSERT INTO task_deps (task_id, depends_on_id) VALUES (?, ?)',
      args.task_id, args.depends_on_id
    );
  } catch (err) {
    if ((err as Error).message.includes('UNIQUE')) {
      return `Dependency already exists.`;
    }
    throw err;
  }

  return `Added dependency: [${args.task_id}] now requires [${args.depends_on_id}] to be done first.`;
}

function toolRemoveDependency(
  args: { task_id: string; depends_on_id: string },
  ctx: TasksToolCtx
): string {
  const result = ctx.sql.exec(
    'DELETE FROM task_deps WHERE task_id = ? AND depends_on_id = ?',
    args.task_id, args.depends_on_id
  );
  if ((result as any).rowsWritten === 0 || !result) {
    // Check if it existed at all
    const exists = ctx.sql
      .exec('SELECT 1 FROM task_deps WHERE task_id = ? AND depends_on_id = ?', args.task_id, args.depends_on_id)
      .toArray();
    if (exists.length === 0) return `No dependency found between [${args.task_id}] and [${args.depends_on_id}].`;
  }
  return `Removed dependency: [${args.task_id}] is no longer blocked by [${args.depends_on_id}].`;
}

// ─── Helpers ──────────────────────────────────────────────────────────

function statusIcon(status: string): string {
  switch (status) {
    case 'done':        return '✅';
    case 'in_progress': return '🔄';
    case 'blocked':     return '⛔';
    case 'cancelled':   return '❌';
    default:            return '⬜'; // todo
  }
}

/**
 * Check if adding edge (task_id → depends_on_id) would create a cycle.
 * We do a BFS from depends_on_id following existing depends_on edges; if we
 * reach task_id, adding the new edge would create a cycle.
 */
function wouldCycle(sql: SqlStorage, taskId: string, dependsOnId: string): boolean {
  const visited = new Set<string>();
  const queue = [dependsOnId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === taskId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const deps = sql
      .exec<{ depends_on_id: string }>('SELECT depends_on_id FROM task_deps WHERE task_id = ?', current)
      .toArray();
    for (const d of deps) queue.push(d.depends_on_id);
  }
  return false;
}

// ─── Re-exports for DO and fast-read path ────────────────────────────

export type { TaskRow };

/**
 * Build summary stats for the fast-read embed. Called directly from TasksDO
 * rather than through the workflow/tool path.
 */
export function buildTaskStats(sql: SqlStorage): {
  total: number;
  byStatus: Record<string, number>;
  readyTasks: TaskRow[];
  blockedTasks: Array<TaskRow & { blocker_count: number }>;
  inProgressTasks: TaskRow[];
} {
  const counts = sql
    .exec<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status')
    .toArray();
  const byStatus: Record<string, number> = {};
  for (const row of counts) byStatus[row.status] = row.n;
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);

  const readyTasks = sql
    .exec<TaskRow>(
      `SELECT t.* FROM tasks t
       WHERE t.status IN ('todo', 'in_progress')
         AND NOT EXISTS (
           SELECT 1 FROM task_deps d
           JOIN tasks blocker ON blocker.id = d.depends_on_id
           WHERE d.task_id = t.id AND blocker.status NOT IN ('done', 'cancelled')
         )
       ORDER BY t.status DESC, t.created_at ASC
       LIMIT 10`
    )
    .toArray();

  const blockedTasks = sql
    .exec<TaskRow & { blocker_count: number }>(
      `SELECT t.*, COUNT(d.depends_on_id) AS blocker_count
       FROM tasks t
       JOIN task_deps d ON d.task_id = t.id
       JOIN tasks blocker ON blocker.id = d.depends_on_id
       WHERE t.status NOT IN ('done', 'cancelled')
         AND blocker.status NOT IN ('done', 'cancelled')
       GROUP BY t.id
       ORDER BY t.created_at ASC
       LIMIT 10`
    )
    .toArray();

  const inProgressTasks = sql
    .exec<TaskRow>('SELECT * FROM tasks WHERE status = ? ORDER BY updated_at DESC LIMIT 5', 'in_progress')
    .toArray();

  return { total, byStatus, readyTasks, blockedTasks, inProgressTasks };
}
