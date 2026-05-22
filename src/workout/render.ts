/**
 * Discord embed builders for workout fast-read commands. Agent replies are
 * plain markdown; these embeds are only for the deterministic fast paths
 * (/workout with no message, /workout-last, /workout-prs, /workout-week, /workout-program).
 */

import { EmbedColor, type Embed } from '../discord/types';
import type { WorkoutStats, PRRow, WeeklyVolume, FullWorkout } from './loop';

function fmtLbs(n: number | null): string {
  if (n === null) return 'BW';
  return `${n.toLocaleString()} lbs`;
}

function fmtDate(ms: number, withTime = false): string {
  const iso = new Date(ms).toISOString();
  return withTime ? iso.slice(0, 16).replace('T', ' ') : iso.slice(0, 10);
}

export function workoutSummaryEmbed(stats: WorkoutStats): Embed {
  if (stats.totalWorkouts === 0) {
    return {
      title: '🏋️ Workouts',
      description:
        'No workouts logged yet. Try `/workout message: log 3x5 squat at 225` or set up a program with `/workout message: create a 3-day full-body program`.',
      color: EmbedColor.archived,
    };
  }

  const fields = [];

  if (stats.openWorkout) {
    fields.push({
      name: '🟢 Open workout',
      value: `\`${stats.openWorkout.id}\` — ${stats.openWorkout.name ?? '(unnamed)'}\nStarted ${fmtDate(stats.openWorkout.started_at, true)}.`,
    });
  } else if (stats.lastWorkout) {
    const ago = Math.max(0, Math.floor((Date.now() - stats.lastWorkout.started_at) / 86_400_000));
    fields.push({
      name: '🏁 Last workout',
      value: `\`${stats.lastWorkout.id}\` — ${stats.lastWorkout.name ?? '(unnamed)'}\n${ago === 0 ? 'Today' : `${ago}d ago`}${stats.lastWorkout.is_deload ? ' · deload' : ''}.`,
    });
  }

  fields.push({
    name: '⭐ Active program',
    value: stats.activeProgram
      ? `\`${stats.activeProgram.id}\` ${stats.activeProgram.name}`
      : '_None — chat with the bot to set one up._',
  });

  const muscleVal = stats.muscleBreakdown.length > 0
    ? stats.muscleBreakdown.slice(0, 6).map((m) => `${m.muscle} — **${m.sets}** sets · ${m.tonnage.toLocaleString()} lbs`).join('\n')
    : '_No working sets in window._';
  fields.push({
    name: `📊 This week (${stats.daysWindow}d) — ${stats.weeklySetCount} sets · ${stats.weeklyTonnageLbs.toLocaleString()} lbs`,
    value: muscleVal.slice(0, 1024),
  });

  if (stats.recentPRs.length > 0) {
    fields.push({
      name: '🏆 Top e1RMs',
      value: stats.recentPRs
        .map((p) => `**${p.exercise_display}** — ~${p.estimated_1rm.toLocaleString()} lbs (from ${p.weight_lbs}×${p.reps})`)
        .join('\n')
        .slice(0, 1024),
    });
  }

  return {
    title: `🏋️ Workouts — ${stats.totalWorkouts} session(s), ${stats.totalSets} working sets`,
    color: stats.openWorkout ? EmbedColor.draft : EmbedColor.inProgress,
    fields,
  };
}

export function workoutLastEmbed(full: FullWorkout): Embed {
  const { workout, exercises } = full;
  const duration = workout.ended_at
    ? `${Math.round((workout.ended_at - workout.started_at) / 60_000)} min`
    : 'still open';

  if (exercises.length === 0) {
    return {
      title: `🏁 ${workout.name ?? 'Last workout'}`,
      description: `\`${workout.id}\` · ${fmtDate(workout.started_at)} · ${duration}\n\n_No sets logged in this workout._`,
      color: EmbedColor.archived,
    };
  }

  const fields = exercises.map((group) => {
    const working = group.sets.filter((s) => !s.is_warmup);
    const warmups = group.sets.filter((s) => s.is_warmup);
    const lines: string[] = [];
    if (warmups.length > 0) {
      lines.push(`_warmup: ${warmups.map((s) => `${fmtLbs(s.weight_lbs)}×${s.reps}`).join(', ')}_`);
    }
    for (const s of working) {
      const rpe = s.rpe !== null ? ` @${s.rpe}` : '';
      lines.push(`Set ${s.set_index}: **${fmtLbs(s.weight_lbs)}** × ${s.reps}${rpe}`);
    }
    return {
      name: group.exercise.display_name,
      value: lines.join('\n').slice(0, 1024),
    };
  });

  const total = exercises.flatMap((g) => g.sets).filter((s) => !s.is_warmup && s.weight_lbs !== null)
    .reduce((acc, s) => acc + (s.weight_lbs ?? 0) * s.reps, 0);
  return {
    title: `🏁 ${workout.name ?? 'Last workout'}${workout.is_deload ? ' (deload)' : ''}`,
    description: `\`${workout.id}\` · ${fmtDate(workout.started_at)} · ${duration} · ${Math.round(total).toLocaleString()} lbs tonnage${workout.notes ? `\n_${workout.notes.slice(0, 200)}_` : ''}`,
    color: workout.ended_at ? EmbedColor.approved : EmbedColor.draft,
    fields,
  };
}

export function workoutPRsEmbed(prs: PRRow[], exerciseFilter: string | null): Embed {
  if (prs.length === 0) {
    return {
      title: exerciseFilter ? `🏆 ${exerciseFilter} PRs` : '🏆 Top PRs',
      description: 'No working sets logged yet.',
      color: EmbedColor.archived,
    };
  }
  const lines = prs.map(
    (p) =>
      `**${p.exercise_display}** — ~${p.estimated_1rm.toLocaleString()} lbs e1RM (from ${p.weight_lbs}×${p.reps} on ${fmtDate(p.logged_at)})`
  );
  return {
    title: exerciseFilter ? `🏆 ${exerciseFilter} PRs` : '🏆 Top estimated 1RMs',
    description: lines.join('\n').slice(0, 4096),
    color: EmbedColor.approved,
    footer: { text: `${prs.length} record(s) · Epley estimate` },
  };
}

export function workoutWeekEmbed(vol: WeeklyVolume, days: number): Embed {
  if (vol.totalSets === 0) {
    return {
      title: `📊 Last ${days}d`,
      description: 'No working sets logged in this window.',
      color: EmbedColor.archived,
    };
  }
  const fields = [];
  if (vol.byMuscle.length > 0) {
    fields.push({
      name: 'By primary muscle',
      value: vol.byMuscle
        .map((m) => `**${m.muscle}** — ${m.sets} sets · ${m.tonnage.toLocaleString()} lbs`)
        .join('\n')
        .slice(0, 1024),
    });
  }
  if (vol.byExercise.length > 0) {
    fields.push({
      name: 'Top exercises',
      value: vol.byExercise
        .slice(0, 8)
        .map((e) => `**${e.exercise_display}** — ${e.sets} sets · ${e.tonnage.toLocaleString()} lbs`)
        .join('\n')
        .slice(0, 1024),
    });
  }
  return {
    title: `📊 Last ${days}d — ${vol.totalSets} sets · ${vol.totalTonnageLbs.toLocaleString()} lbs`,
    color: EmbedColor.inProgress,
    fields,
  };
}

export function workoutProgramEmbed(
  program: { id: string; name: string; description: string | null },
  routines: Array<{
    id: string;
    name: string;
    day_order: number;
    notes: string | null;
    exercises: Array<{
      exercise_id: string;
      display_name: string;
      target_sets: number | null;
      target_reps: string | null;
      target_weight_lbs: number | null;
      target_rpe: number | null;
      notes: string | null;
    }>;
  }>
): Embed {
  if (routines.length === 0) {
    return {
      title: `⭐ ${program.name}`,
      description: `\`${program.id}\`${program.description ? `\n_${program.description}_` : ''}\n\n_No routines yet — chat to plan some._`,
      color: EmbedColor.draft,
    };
  }

  const fields = routines.map((r) => {
    if (r.exercises.length === 0) {
      return { name: `Day ${r.day_order} — ${r.name}`, value: '_no exercises planned_' };
    }
    const lines = r.exercises.map((ex) => {
      const parts: string[] = [];
      if (ex.target_sets) parts.push(`${ex.target_sets} sets`);
      if (ex.target_reps) parts.push(`× ${ex.target_reps}`);
      if (ex.target_weight_lbs) parts.push(`@ ${ex.target_weight_lbs} lbs`);
      if (ex.target_rpe) parts.push(`RPE ${ex.target_rpe}`);
      return `**${ex.display_name}**${parts.length ? ` — ${parts.join(' ')}` : ''}`;
    });
    return { name: `Day ${r.day_order} — ${r.name}`, value: lines.join('\n').slice(0, 1024) };
  });

  return {
    title: `⭐ ${program.name}`,
    description: `\`${program.id}\`${program.description ? `\n_${program.description.slice(0, 300)}_` : ''}`,
    color: EmbedColor.approved,
    fields,
  };
}
