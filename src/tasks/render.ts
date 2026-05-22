/**
 * Discord embed builders for tasks fast-read commands. Agent replies are
 * plain markdown; these embeds are only for the deterministic fast paths
 * (/tasks bare, /tasks-open, /tasks-next, /tasks-blocked).
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

function taskLine(t: TaskRow): string {
  const icon = STATUS_ICON[t.status] ?? '⬜';
  const typeLabel = t.type === 'long' ? ' `long`' : '';
  return `${icon}${typeLabel} **${t.title}** \`${t.id}\``;
}

export function taskSummaryEmbed(stats: {
  total: number;
  byStatus: Record<string, number>;
  readyTasks: TaskRow[];
  blockedTasks: Array<TaskRow & { blocker_count: number }>;
  inProgressTasks: TaskRow[];
}): Embed {
  const { total, byStatus, readyTasks, blockedTasks, inProgressTasks } = stats;
  const open = (byStatus['todo'] ?? 0) + (byStatus['in_progress'] ?? 0) + (byStatus['blocked'] ?? 0);

  if (total === 0) {
    return {
      title: '📋 Tasks',
      description: 'No tasks yet. Use `/tasks message: add a task` or just chat to get started.',
      color: EmbedColor.archived,
    };
  }

  const description = [
    `**${open}** open · **${byStatus['done'] ?? 0}** done · **${byStatus['cancelled'] ?? 0}** cancelled`,
  ].join('\n');

  const fields = [];

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
        .map((t) => `${taskLine(t)} — ${(t as any).blocker_count} blocker(s)`)
        .join('\n')
        .slice(0, 1024),
    });
  }

  return {
    title: `📋 Tasks — ${total} total`,
    description,
    color: open > 0 ? EmbedColor.inProgress : EmbedColor.approved,
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
    const typeLabel = t.type === 'long' ? ' `long`' : '';
    const notes = t.notes ? ` — ${t.notes.slice(0, 80)}` : '';
    return `${icon}${typeLabel} **${t.title}** \`${t.id}\`${notes}`;
  });

  return {
    title,
    description: lines.join('\n').slice(0, 4096),
    color: EmbedColor.inProgress,
    footer: { text: `${tasks.length} task${tasks.length === 1 ? '' : 's'}` },
  };
}
