/**
 * Tasks tool implementations. AgentChatWorkflow drives the agent loop via
 * runtime/agent-round; tool execution lives here and is called from the
 * universal `/workflow/agent/exec-tool` endpoint on TasksDO.
 */

import type { TaskRow } from './tools';

export interface TasksToolCtx {
  sql: SqlStorage;
  /** IANA timezone for the household. Used to convert bare YYYY-MM-DD
   *  due-dates into end-of-day in the user's local time instead of UTC. */
  timezone?: string;
}

// ─── Public constants ────────────────────────────────────────────────

export const VALID_STATUSES = ['todo', 'in_progress', 'blocked', 'done', 'cancelled'] as const;
export const VALID_TYPES = ['short', 'long'] as const;
export const VALID_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

export type TaskStatus = (typeof VALID_STATUSES)[number];
export type TaskType = (typeof VALID_TYPES)[number];
export type TaskPriority = (typeof VALID_PRIORITIES)[number];

/** 7 days, the "due soon" cutoff used by /tasks-due and the summary surface. */
export const DUE_SOON_WINDOW_MS = 7 * 24 * 3600 * 1000;

/**
 * Canonical ORDER BY fragment for task lists. Used everywhere a list of tasks
 * is rendered so the user sees a consistent priority ordering:
 *   1. status: in_progress → todo → blocked → done → cancelled
 *   2. priority: urgent → high → normal → low
 *   3. due_at: soonest first, nulls last
 *   4. created_at: oldest first (tie-breaker)
 *
 * Always referenced with the `t.` alias for the tasks table.
 */
export const TASK_ORDER_SQL = `
  CASE t.status
    WHEN 'in_progress' THEN 0
    WHEN 'todo'        THEN 1
    WHEN 'blocked'     THEN 2
    WHEN 'done'        THEN 3
    WHEN 'cancelled'   THEN 4
    ELSE 5
  END,
  CASE t.priority
    WHEN 'urgent' THEN 0
    WHEN 'high'   THEN 1
    WHEN 'normal' THEN 2
    WHEN 'low'    THEN 3
    ELSE 4
  END,
  CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END,
  t.due_at ASC,
  t.created_at ASC
`;

// ─── Tool dispatch ───────────────────────────────────────────────────

export function executeTasksTool(name: string, args: any, ctx: TasksToolCtx): string {
  try {
    switch (name) {
      case 'show_summary':      return toolShowSummary(ctx);
      case 'list_tasks':        return toolListTasks(args, ctx);
      case 'get_task':          return toolGetTask(args, ctx);
      case 'add_task':          return toolAddTask(args, ctx);
      case 'update_task':       return toolUpdateTask(args, ctx);
      case 'add_dependency':    return toolAddDependency(args, ctx);
      case 'remove_dependency': return toolRemoveDependency(args, ctx);
      default:                  return `Unknown tasks tool: ${name}`;
    }
  } catch (err) {
    return `Tool ${name} failed: ${(err as Error).message}`;
  }
}

// ─── ID + parsing helpers ────────────────────────────────────────────

function newTaskId(): string {
  return `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Accept either an ISO-8601 date/datetime string or a YYYY-MM-DD. Returns ms
 * epoch, or null if the input is falsy. Throws on unparseable input so the
 * LLM can self-correct from the error message.
 */
function parseDueDate(input: string | null | undefined, timezone?: string): number | null {
  if (input === null || input === undefined || input === '') return null;
  const trimmed = String(input).trim();
  // Bare date → end of that day in the user's local timezone so "due Friday"
  // means by end-of-Friday LOCAL (not UTC midnight). The previous
  // implementation always stored UTC midnight, which appeared as Thursday
  // evening for any timezone west of UTC.
  const bareDate = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
  if (bareDate) {
    if (timezone) {
      // 23:59 local on that date.
      return localDateAtHourMinute(trimmed, 23, 59, timezone);
    }
    // No timezone available: fall back to UTC end-of-day.
    const ms = Date.parse(`${trimmed}T23:59:59Z`);
    if (Number.isNaN(ms)) {
      throw new Error(`Could not parse "${input}" as a date. Use YYYY-MM-DD or an ISO-8601 datetime.`);
    }
    return ms;
  }
  const ms = Date.parse(trimmed);
  if (Number.isNaN(ms)) {
    throw new Error(`Could not parse "${input}" as a date. Use YYYY-MM-DD or an ISO-8601 datetime.`);
  }
  return ms;
}

/**
 * Inline helper: like `localDateAtHour` but with explicit minute precision.
 * Lives here (not in util/datetime) to keep tasks/loop self-contained.
 */
function localDateAtHourMinute(localDate: string, hour: number, minute: number, timezone: string): number {
  const [y, m, d] = localDate.split('-').map(Number) as [number, number, number];
  const utcGuess = Date.UTC(y, m - 1, d, hour, minute, 0);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(utcGuess));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const tzAsUtc = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    get('hour') % 24, get('minute'), 0,
  );
  const targetAsUtc = Date.UTC(y, m - 1, d, hour, minute, 0);
  const offsetMinutes = (tzAsUtc - targetAsUtc) / 60_000;
  return utcGuess - offsetMinutes * 60_000;
}

function formatDue(ms: number | null): string {
  if (ms === null) return '';
  const now = Date.now();
  const diff = ms - now;
  const day = 86_400_000;
  if (diff < -day) return ` ⚠️ overdue ${Math.floor(-diff / day)}d`;
  if (diff < 0) return ' ⚠️ overdue';
  if (diff < day) return ' 🕒 due today';
  if (diff < 2 * day) return ' 🕒 due tomorrow';
  if (diff < DUE_SOON_WINDOW_MS) return ` 🕒 due in ${Math.floor(diff / day)}d`;
  return ` 📅 due ${new Date(ms).toISOString().slice(0, 10)}`;
}

const PRIORITY_BADGE: Record<string, string> = {
  urgent: '🔥',
  high: '⬆️',
  normal: '',
  low: '⬇️',
};

function priorityBadge(p: string | null | undefined): string {
  return PRIORITY_BADGE[p ?? 'normal'] ?? '';
}

function statusIcon(status: string): string {
  switch (status) {
    case 'done':        return '✅';
    case 'in_progress': return '🔄';
    case 'blocked':     return '⛔';
    case 'cancelled':   return '❌';
    default:            return '⬜';
  }
}

// ─── Tool implementations ─────────────────────────────────────────────

function toolShowSummary(ctx: TasksToolCtx): string {
  const stats = buildTaskStats(ctx.sql);
  const { total, byStatus, byPriority, readyTasks, blockedTasks, inProgressTasks, overdueTasks } = stats;
  const open = (byStatus['todo'] ?? 0) + (byStatus['in_progress'] ?? 0) + (byStatus['blocked'] ?? 0);

  const lines = [
    `Total: ${total} tasks (${open} open, ${byStatus['done'] ?? 0} done, ${byStatus['cancelled'] ?? 0} cancelled)`,
    `Priority breakdown (open): urgent=${byPriority['urgent'] ?? 0}, high=${byPriority['high'] ?? 0}, normal=${byPriority['normal'] ?? 0}, low=${byPriority['low'] ?? 0}`,
  ];

  if (overdueTasks.length > 0) {
    lines.push('');
    lines.push(`⚠️ Overdue (${overdueTasks.length}):`);
    lines.push(...overdueTasks.slice(0, 5).map(formatTaskShort));
  }

  if (inProgressTasks.length > 0) {
    lines.push('');
    lines.push('In progress:');
    lines.push(...inProgressTasks.map(formatTaskShort));
  }

  if (readyTasks.length > 0) {
    lines.push('');
    lines.push('Ready to start (no blockers):');
    lines.push(...readyTasks.slice(0, 5).map(formatTaskShort));
  }

  if (blockedTasks.length > 0) {
    lines.push('');
    lines.push('Blocked (waiting on other tasks):');
    lines.push(...blockedTasks.slice(0, 5).map((t) => `${formatTaskShort(t)} — waiting on ${t.blocker_count} task(s)`));
  }

  return lines.join('\n').trim();
}

function formatTaskShort(t: TaskRow): string {
  const badge = priorityBadge(t.priority);
  const due = formatDue(t.due_at ?? null);
  const typeIcon = t.type === 'long' ? '📋' : '✓';
  return `  [${t.id}] ${typeIcon} ${badge ? badge + ' ' : ''}${t.title} (${t.status})${due}`;
}

function toolListTasks(
  args: {
    status?: string;
    type?: string;
    priority?: string;
    parent_id?: string;
    include_done?: boolean;
    due_within_days?: number;
  },
  ctx: TasksToolCtx
): string {
  const filters: string[] = [];
  const params: SqlStorageValue[] = [];

  if (args.status === 'open') {
    filters.push(`t.status IN ('todo', 'in_progress', 'blocked')`);
  } else if (args.status) {
    if (!(VALID_STATUSES as readonly string[]).includes(args.status)) {
      return `Invalid status "${args.status}". Use one of: ${VALID_STATUSES.join(', ')}, or "open".`;
    }
    filters.push('t.status = ?');
    params.push(args.status);
  } else if (!args.include_done) {
    filters.push(`t.status NOT IN ('done', 'cancelled')`);
  }

  if (args.type) {
    if (!(VALID_TYPES as readonly string[]).includes(args.type)) {
      return `Invalid type "${args.type}". Use one of: ${VALID_TYPES.join(', ')}.`;
    }
    filters.push('t.type = ?');
    params.push(args.type);
  }

  if (args.priority) {
    if (!(VALID_PRIORITIES as readonly string[]).includes(args.priority)) {
      return `Invalid priority "${args.priority}". Use one of: ${VALID_PRIORITIES.join(', ')}.`;
    }
    filters.push('t.priority = ?');
    params.push(args.priority);
  }

  if (args.parent_id !== undefined) {
    if (args.parent_id) {
      filters.push('t.parent_id = ?');
      params.push(args.parent_id);
    } else {
      filters.push('t.parent_id IS NULL');
    }
  }

  if (args.due_within_days !== undefined && args.due_within_days !== null) {
    const days = Math.max(0, Math.min(365, Number(args.due_within_days)));
    const cutoff = Date.now() + days * 86_400_000;
    filters.push('t.due_at IS NOT NULL AND t.due_at <= ?');
    params.push(cutoff);
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
       ORDER BY ${TASK_ORDER_SQL}`,
      ...params
    )
    .toArray();

  if (rows.length === 0) return 'No tasks match the filter.';

  const lines = rows.map((t) => {
    const icon = statusIcon(t.status);
    const badge = priorityBadge(t.priority);
    const typeLabel = t.type === 'long' ? '[long]' : '';
    const due = formatDue(t.due_at ?? null);
    const extra: string[] = [];
    if (t.subtask_count > 0) extra.push(`${t.subtask_count} subtask(s)`);
    if (t.blocker_count > 0) extra.push(`⛔ ${t.blocker_count} blocker(s)`);
    const suffix = extra.length > 0 ? ` — ${extra.join(', ')}` : '';
    return `${icon} [${t.id}] ${badge ? badge + ' ' : ''}${typeLabel} ${t.title}${due}${suffix}`;
  });
  return `${rows.length} task${rows.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
}

function toolGetTask(args: { id: string }, ctx: TasksToolCtx): string {
  const task = ctx.sql
    .exec<TaskRow>('SELECT * FROM tasks WHERE id = ?', args.id)
    .toArray()[0];

  if (!task) return `No task found with id "${args.id}".`;

  const subtasks = ctx.sql
    .exec<TaskRow>(
      `SELECT t.* FROM tasks t WHERE t.parent_id = ? ORDER BY ${TASK_ORDER_SQL}`,
      args.id
    )
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

  const badge = priorityBadge(task.priority);
  const due = formatDue(task.due_at ?? null);
  const lines = [
    `[${task.id}] ${badge ? badge + ' ' : ''}${task.title}${due}`,
    `Status: ${task.status} | Type: ${task.type} | Priority: ${task.priority ?? 'normal'}`,
    task.parent_id ? `Parent: ${task.parent_id}` : 'Top-level task',
    task.notes ? `Notes: ${task.notes}` : '',
    `Created: ${new Date(task.created_at).toISOString().slice(0, 16)}`,
  ].filter(Boolean);

  if (task.due_at) {
    lines.push(`Due: ${new Date(task.due_at).toISOString().slice(0, 16)}`);
  }

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
  args: {
    title: string;
    type?: string;
    priority?: string;
    notes?: string;
    parent_id?: string;
    due_date?: string;
  },
  ctx: TasksToolCtx
): string {
  if (!args.title || !args.title.trim()) return 'Cannot create a task with an empty title.';

  const type = args.type === 'long' ? 'long' : 'short';
  const priority = (VALID_PRIORITIES as readonly string[]).includes(args.priority ?? '')
    ? (args.priority as TaskPriority)
    : 'normal';
  const dueAt = parseDueDate(args.due_date, ctx.timezone);

  if (args.parent_id) {
    const parent = ctx.sql.exec('SELECT id FROM tasks WHERE id = ?', args.parent_id).toArray();
    if (parent.length === 0) return `Parent task "${args.parent_id}" not found.`;
  }

  const id = newTaskId();
  const now = Date.now();
  ctx.sql.exec(
    `INSERT INTO tasks
       (id, title, status, type, priority, parent_id, notes, due_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, args.title.trim(), 'todo', type, priority,
    args.parent_id ?? null, args.notes ?? null, dueAt, now, now
  );

  const extras: string[] = [`type=${type}`, `priority=${priority}`];
  if (args.parent_id) extras.push(`parent=${args.parent_id}`);
  if (dueAt) extras.push(`due=${new Date(dueAt).toISOString().slice(0, 10)}`);
  return `Created task [${id}]: "${args.title.trim()}" (${extras.join(', ')})`;
}

function toolUpdateTask(
  args: {
    id: string;
    title?: string;
    status?: string;
    type?: string;
    priority?: string;
    notes?: string;
    due_date?: string | null;
  },
  ctx: TasksToolCtx
): string {
  const task = ctx.sql
    .exec<TaskRow>('SELECT * FROM tasks WHERE id = ?', args.id)
    .toArray()[0];

  if (!task) return `No task found with id "${args.id}".`;

  const updates: string[] = [];
  const params: SqlStorageValue[] = [];
  const changeBits: string[] = [];

  if (args.title !== undefined) {
    if (!args.title.trim()) return 'Title cannot be empty.';
    updates.push('title = ?');
    params.push(args.title.trim());
    changeBits.push(`title="${args.title.trim()}"`);
  }
  if (args.status !== undefined) {
    if (!(VALID_STATUSES as readonly string[]).includes(args.status)) {
      return `Invalid status "${args.status}". Use one of: ${VALID_STATUSES.join(', ')}.`;
    }
    updates.push('status = ?');
    params.push(args.status);
    changeBits.push(`status=${args.status}`);
  }
  if (args.type !== undefined) {
    if (!(VALID_TYPES as readonly string[]).includes(args.type)) {
      return `Invalid type "${args.type}". Use one of: ${VALID_TYPES.join(', ')}.`;
    }
    updates.push('type = ?');
    params.push(args.type);
    changeBits.push(`type=${args.type}`);
  }
  if (args.priority !== undefined) {
    if (!(VALID_PRIORITIES as readonly string[]).includes(args.priority)) {
      return `Invalid priority "${args.priority}". Use one of: ${VALID_PRIORITIES.join(', ')}.`;
    }
    updates.push('priority = ?');
    params.push(args.priority);
    changeBits.push(`priority=${args.priority}`);
  }
  if (args.notes !== undefined) {
    updates.push('notes = ?');
    params.push(args.notes);
    changeBits.push(`notes`);
  }
  if (args.due_date !== undefined) {
    const dueAt = args.due_date === null ? null : parseDueDate(args.due_date, ctx.timezone);
    updates.push('due_at = ?');
    params.push(dueAt);
    changeBits.push(dueAt === null ? 'due_date=cleared' : `due_date=${new Date(dueAt).toISOString().slice(0, 10)}`);
  }

  if (updates.length === 0) return 'No fields to update.';

  updates.push('updated_at = ?');
  params.push(Date.now());
  params.push(args.id);

  ctx.sql.exec(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`, ...params);
  return `Updated task [${args.id}]: ${changeBits.join(', ')}.`;
}

function toolAddDependency(
  args: { task_id: string; depends_on_id: string },
  ctx: TasksToolCtx
): string {
  if (args.task_id === args.depends_on_id) {
    return 'A task cannot depend on itself.';
  }

  const task = ctx.sql.exec('SELECT id FROM tasks WHERE id = ?', args.task_id).toArray();
  if (task.length === 0) return `Task "${args.task_id}" not found.`;
  const dep = ctx.sql.exec('SELECT id FROM tasks WHERE id = ?', args.depends_on_id).toArray();
  if (dep.length === 0) return `Task "${args.depends_on_id}" not found.`;

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
  // Check existence BEFORE deleting so the response reflects reality. The
  // previous version queried after the DELETE, which always returned 0 rows.
  const existed = ctx.sql
    .exec(
      'SELECT 1 FROM task_deps WHERE task_id = ? AND depends_on_id = ? LIMIT 1',
      args.task_id, args.depends_on_id
    )
    .toArray();

  if (existed.length === 0) {
    return `No dependency found between [${args.task_id}] and [${args.depends_on_id}].`;
  }

  ctx.sql.exec(
    'DELETE FROM task_deps WHERE task_id = ? AND depends_on_id = ?',
    args.task_id, args.depends_on_id
  );
  return `Removed dependency: [${args.task_id}] is no longer blocked by [${args.depends_on_id}].`;
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Check if adding edge (task_id → depends_on_id) would create a cycle.
 * BFS from depends_on_id along existing depends_on edges; if we reach
 * task_id, the new edge closes a loop.
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

export interface TaskStats {
  total: number;
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
  readyTasks: TaskRow[];
  blockedTasks: Array<TaskRow & { blocker_count: number }>;
  inProgressTasks: TaskRow[];
  overdueTasks: TaskRow[];
}

/**
 * Build summary stats for the fast-read embed and the system prompt snapshot.
 */
export function buildTaskStats(sql: SqlStorage): TaskStats {
  const statusCounts = sql
    .exec<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status')
    .toArray();
  const byStatus: Record<string, number> = {};
  for (const row of statusCounts) byStatus[row.status] = row.n;
  const total = Object.values(byStatus).reduce((a, b) => a + b, 0);

  const priorityCounts = sql
    .exec<{ priority: string; n: number }>(
      `SELECT priority, COUNT(*) AS n FROM tasks
       WHERE status NOT IN ('done', 'cancelled') GROUP BY priority`
    )
    .toArray();
  const byPriority: Record<string, number> = {};
  for (const row of priorityCounts) byPriority[row.priority] = row.n;

  // "Ready" = todo with no unfinished blockers. In-progress tasks are
  // surfaced separately in `inProgressTasks`; including them here caused
  // both the summary embed and the LLM prompt to list the same task twice.
  const readyTasks = sql
    .exec<TaskRow>(
      `SELECT t.* FROM tasks t
       WHERE t.status = 'todo'
         AND NOT EXISTS (
           SELECT 1 FROM task_deps d
           JOIN tasks blocker ON blocker.id = d.depends_on_id
           WHERE d.task_id = t.id AND blocker.status NOT IN ('done', 'cancelled')
         )
       ORDER BY ${TASK_ORDER_SQL}
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
       ORDER BY ${TASK_ORDER_SQL}
       LIMIT 10`
    )
    .toArray();

  const inProgressTasks = sql
    .exec<TaskRow>(
      `SELECT t.* FROM tasks t
       WHERE t.status = 'in_progress'
       ORDER BY ${TASK_ORDER_SQL}
       LIMIT 5`
    )
    .toArray();

  const overdueTasks = sql
    .exec<TaskRow>(
      `SELECT t.* FROM tasks t
       WHERE t.status NOT IN ('done', 'cancelled')
         AND t.due_at IS NOT NULL
         AND t.due_at < ?
       ORDER BY t.due_at ASC
       LIMIT 10`,
      Date.now()
    )
    .toArray();

  return { total, byStatus, byPriority, readyTasks, blockedTasks, inProgressTasks, overdueTasks };
}
