/**
 * Discord embed builders for tasks fast-read commands. Agent replies are
 * plain markdown; these embeds are only for the deterministic fast paths
 * (/tasks bare, /tasks-open, /tasks-next, /tasks-blocked, /tasks-due).
 */

import { EmbedColor, type Embed } from '../discord/types';
import type { TaskRow } from './loop';

const STATUS_ICON: Record<string, string> = {
  todo: '⬜',
  in_progress: '🔄',
  blocked: '⛔',
  done: '✅',
  cancelled: '❌',
};

const PRIORITY_BADGE: Record<string, string> = {
  urgent: '🔥 ',
  high: '⬆️ ',
  normal: '',
  low: '⬇️ ',
};

function formatDueChip(ms: number | null): string {
  if (ms === null) return '';
  const now = Date.now();
  const diff = ms - now;
  const day = 86_400_000;
  if (diff < -day) return ` ⚠️ \`${Math.floor(-diff / day)}d overdue\``;
  if (diff < 0) return ' ⚠️ `overdue`';
  if (diff < day) return ' 🕒 `due today`';
  if (diff < 2 * day) return ' 🕒 `due tomorrow`';
  if (diff < 7 * day) return ` 🕒 \`due in ${Math.floor(diff / day)}d\``;
  return ` 📅 \`${new Date(ms).toISOString().slice(0, 10)}\``;
}

function taskLine(t: TaskRow): string {
  const icon = STATUS_ICON[t.status] ?? '⬜';
  const badge = PRIORITY_BADGE[t.priority ?? 'normal'] ?? '';
  const typeLabel = t.type === 'long' ? ' `long`' : '';
  const due = formatDueChip(t.due_at ?? null);
  return `${icon} ${badge}**${t.title}**${typeLabel}${due} \`${t.id}\``;
}

export function taskSummaryEmbed(stats: {
  total: number;
  byStatus: Record<string, number>;
  byPriority: Record<string, number>;
  readyTasks: TaskRow[];
  blockedTasks: Array<TaskRow & { blocker_count: number }>;
  inProgressTasks: TaskRow[];
  overdueTasks: TaskRow[];
}): Embed {
  const { total, byStatus, byPriority, readyTasks, blockedTasks, inProgressTasks, overdueTasks } = stats;
  const open = (byStatus['todo'] ?? 0) + (byStatus['in_progress'] ?? 0) + (byStatus['blocked'] ?? 0);

  if (total === 0) {
    return {
      title: '📋 Tasks',
      description: 'No tasks yet. Use `/tasks message: add a task` or just chat to get started.',
      color: EmbedColor.archived,
    };
  }

  const descLines = [
    `**${open}** open · **${byStatus['done'] ?? 0}** done · **${byStatus['cancelled'] ?? 0}** cancelled`,
  ];
  const callouts = [
    (byPriority['urgent'] ?? 0) > 0 ? `🔥 ${byPriority['urgent']} urgent` : null,
    (byPriority['high'] ?? 0) > 0 ? `⬆️ ${byPriority['high']} high` : null,
    overdueTasks.length > 0 ? `⚠️ ${overdueTasks.length} overdue` : null,
  ].filter(Boolean);
  if (callouts.length > 0) descLines.push(callouts.join(' · '));

  const fields = [];

  // Overdue is the most urgent surface — put it first.
  if (overdueTasks.length > 0) {
    fields.push({
      name: '⚠️ Overdue',
      value: overdueTasks.slice(0, 5).map(taskLine).join('\n').slice(0, 1024),
    });
  }

  if (inProgressTasks.length > 0) {
    fields.push({
      name: '🔄 In progress',
      value: inProgressTasks.map(taskLine).join('\n').slice(0, 1024),
    });
  }

  if (readyTasks.length > 0) {
    fields.push({
      name: '✅ Ready to start',
      value: readyTasks.map(taskLine).join('\n').slice(0, 1024),
    });
  }

  if (blockedTasks.length > 0) {
    fields.push({
      name: '⛔ Blocked',
      value: blockedTasks
        .map((t) => `${taskLine(t)} — ${t.blocker_count} blocker(s)`)
        .join('\n')
        .slice(0, 1024),
    });
  }

  const color = overdueTasks.length > 0
    ? EmbedColor.error
    : open > 0
    ? EmbedColor.inProgress
    : EmbedColor.approved;

  return {
    title: `📋 Tasks — ${total} total`,
    description: descLines.join('\n'),
    color,
    fields: fields.length > 0 ? fields : undefined,
  };
}

export function tasksListEmbed(title: string, tasks: TaskRow[]): Embed {
  if (tasks.length === 0) {
    return {
      title,
      description: 'No tasks in this view.',
      color: EmbedColor.archived,
    };
  }

  const lines = tasks.map((t) => {
    const icon = STATUS_ICON[t.status] ?? '⬜';
    const badge = PRIORITY_BADGE[t.priority ?? 'normal'] ?? '';
    const typeLabel = t.type === 'long' ? ' `long`' : '';
    const due = formatDueChip(t.due_at ?? null);
    const notes = t.notes ? ` — ${t.notes.slice(0, 60)}` : '';
    return `${icon} ${badge}**${t.title}**${typeLabel}${due} \`${t.id}\`${notes}`;
  });

  return {
    title,
    description: lines.join('\n').slice(0, 4096),
    color: EmbedColor.inProgress,
    footer: { text: `${tasks.length} task${tasks.length === 1 ? '' : 's'}` },
  };
}

export function tasksDueEmbed(tasks: TaskRow[]): Embed {
  if (tasks.length === 0) {
    return {
      title: '📅 Due Soon',
      description: 'Nothing overdue and nothing due in the next 7 days. Nice.',
      color: EmbedColor.approved,
    };
  }

  const now = Date.now();
  const overdue = tasks.filter((t) => (t.due_at ?? 0) < now);
  const dueSoon = tasks.filter((t) => (t.due_at ?? 0) >= now);

  const fields = [];
  if (overdue.length > 0) {
    fields.push({
      name: `⚠️ Overdue (${overdue.length})`,
      value: overdue.map(taskLine).join('\n').slice(0, 1024),
    });
  }
  if (dueSoon.length > 0) {
    fields.push({
      name: `🕒 Due within 7 days (${dueSoon.length})`,
      value: dueSoon.map(taskLine).join('\n').slice(0, 1024),
    });
  }

  return {
    title: '📅 Due Soon',
    color: overdue.length > 0 ? EmbedColor.error : EmbedColor.inProgress,
    fields,
    footer: { text: `${tasks.length} task${tasks.length === 1 ? '' : 's'}` },
  };
}
