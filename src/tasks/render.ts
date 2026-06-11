/**
 * Discord embed builders for projects fast-read commands and the daily due
 * nudge. Agent replies are plain markdown; these embeds are only for the
 * deterministic paths (/projects bare, /projects-open, /projects-next,
 * /projects-blocked, /projects-due, and the alarm's due-check post).
 */

import { EmbedColor, type Embed } from '../discord/types';
import type { ProjectsSnapshot, TaskRow } from './loop';

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

function progressBar(done: number, total: number): string {
  if (total === 0) return '`no steps yet`';
  const filled = Math.round((done / total) * 5);
  return `\`${'▰'.repeat(filled)}${'▱'.repeat(5 - filled)}\` ${done}/${total} steps`;
}

export function projectsOverviewEmbed(snapshot: ProjectsSnapshot): Embed {
  const { projects, loose } = snapshot;

  if (projects.length === 0 && loose.length === 0) {
    return {
      title: '📁 Projects',
      description:
        'No projects yet. Describe one and I\'ll break it into steps — e.g. `/projects message: new project: reseed the lawn — buy seed, dethatch, overseed`.',
      color: EmbedColor.archived,
    };
  }

  const fields = projects.slice(0, 10).map((p) => {
    const t = p.project;
    const badge = PRIORITY_BADGE[t.priority ?? 'normal'] ?? '';
    const due = formatDueChip(t.due_at ?? null);
    const staleDays = Math.floor((Date.now() - p.lastActivity) / 86_400_000);
    const lines = [progressBar(p.doneSteps, p.totalSteps) + due];
    if (p.nextSteps.length > 0) {
      lines.push(...p.nextSteps.map((s) => `↳ ${taskLine(s)}`));
    } else if (p.totalSteps > 0 && p.doneSteps === p.totalSteps) {
      lines.push('🎉 all steps done — close it out?');
    }
    if (p.stale) lines.push(`⚠️ stale — no activity in ${staleDays}d`);
    return {
      name: `📁 ${badge}${t.title} \`${t.id}\``,
      value: lines.join('\n').slice(0, 1024),
    };
  });

  if (loose.length > 0) {
    fields.push({
      name: '📌 Loose tasks',
      value: loose.slice(0, 8).map(taskLine).join('\n').slice(0, 1024),
    });
  }

  const anyStale = projects.some((p) => p.stale);
  return {
    title: `📁 Projects — ${projects.length} active`,
    color: anyStale ? EmbedColor.error : EmbedColor.inProgress,
    fields,
    footer: { text: 'Chat to add steps, mark things done, or start a new project' },
  };
}

export function projectsNudgeEmbed(newlyOverdue: TaskRow[], dueToday: TaskRow[]): Embed {
  const fields = [];
  if (newlyOverdue.length > 0) {
    fields.push({
      name: `⚠️ Just went overdue (${newlyOverdue.length})`,
      value: newlyOverdue.map(taskLine).join('\n').slice(0, 1024),
    });
  }
  if (dueToday.length > 0) {
    fields.push({
      name: `🕒 Due today (${dueToday.length})`,
      value: dueToday.map(taskLine).join('\n').slice(0, 1024),
    });
  }
  return {
    title: '⏰ Due check',
    color: newlyOverdue.length > 0 ? EmbedColor.error : EmbedColor.inProgress,
    fields,
    footer: { text: 'Mark done or push the date — e.g. /projects message: done with the door seal' },
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
