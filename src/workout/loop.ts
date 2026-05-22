/**
 * Workout tool implementations. WorkoutSteerWorkflow drives the agent via
 * runtime/agent-round; tool execution lives here and is called from
 * WorkoutDO's /workflow/workout/exec-tool endpoint.
 *
 * All weights are pounds. Bodyweight exercises have NULL weight.
 */

import type { ExerciseRow, WorkoutRow, SetRow, ProgramRow, RoutineRow } from './tools';

export type { ExerciseRow, WorkoutRow, SetRow, ProgramRow, RoutineRow };

export interface WorkoutToolCtx {
  sql: SqlStorage;
}

// ─── Public constants ────────────────────────────────────────────────

export const VALID_PROGRAM_STATUS = ['active', 'paused', 'archived'] as const;
export const VALID_EQUIPMENT = [
  'barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'kettlebell', 'band', 'other',
] as const;

// ─── Tool dispatch ───────────────────────────────────────────────────

export function executeWorkoutTool(name: string, args: any, ctx: WorkoutToolCtx): string {
  try {
    switch (name) {
      case 'show_summary':         return toolShowSummary(ctx);
      case 'log_workout':          return toolLogWorkout(args, ctx);
      case 'end_workout':          return toolEndWorkout(args, ctx);
      case 'add_set':              return toolAddSet(args, ctx);
      case 'add_sets_bulk':        return toolAddSetsBulk(args, ctx);
      case 'exercise_history':     return toolExerciseHistory(args, ctx);
      case 'find_prs':             return toolFindPRs(args, ctx);
      case 'weekly_volume':        return toolWeeklyVolume(args, ctx);
      case 'list_workouts':        return toolListWorkouts(args, ctx);
      case 'get_workout':          return toolGetWorkout(args, ctx);
      case 'list_exercises':       return toolListExercises(args, ctx);
      case 'update_exercise':      return toolUpdateExercise(args, ctx);
      case 'create_program':       return toolCreateProgram(args, ctx);
      case 'add_routine':          return toolAddRoutine(args, ctx);
      case 'add_routine_exercise': return toolAddRoutineExercise(args, ctx);
      case 'list_programs':        return toolListPrograms(ctx);
      case 'get_program':          return toolGetProgram(args, ctx);
      case 'set_active_program':   return toolSetActiveProgram(args, ctx);
      default:                     return `Unknown workout tool: ${name}`;
    }
  } catch (err) {
    return `Tool ${name} failed: ${(err as Error).message}`;
  }
}

// ─── ID helpers ──────────────────────────────────────────────────────

function shortId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Normalize an exercise name to a canonical lowercase form for catalog
 * lookups. "Bench Press" / "bench press" / "  Bench  Press  " all collapse
 * to "bench press".
 */
function normalizeExerciseName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Epley 1RM formula. Valid for ~1–10 reps; deteriorates past that. */
function epley1RM(weight: number, reps: number): number {
  if (reps <= 0) return 0;
  if (reps === 1) return weight;
  return Math.round(weight * (1 + reps / 30) * 10) / 10;
}

// ─── Exercise resolution (used by add_set, add_sets_bulk, exercise_history, find_prs) ──

interface ResolveOptions {
  equipment?: string;
  primary_muscle?: string;
  createIfMissing?: boolean;
}

function resolveExercise(
  sql: SqlStorage,
  rawName: string,
  opts: ResolveOptions = {}
): ExerciseRow | null {
  const name = normalizeExerciseName(rawName);
  if (!name) return null;

  let row = sql.exec<ExerciseRow>('SELECT * FROM exercises WHERE name = ?', name).toArray()[0];
  if (row) return row;

  // Soft match: try simple substring fallback before creating.
  const like = sql
    .exec<ExerciseRow>('SELECT * FROM exercises WHERE name LIKE ? LIMIT 1', `%${name}%`)
    .toArray()[0];
  if (like) return like;

  if (!opts.createIfMissing) return null;

  const now = Date.now();
  const id = shortId('ex');
  const display = rawName.trim().replace(/\b\w/g, (c) => c.toUpperCase());
  sql.exec(
    `INSERT INTO exercises (id, name, display_name, category, primary_muscle, equipment, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, name, display, null, opts.primary_muscle ?? null, opts.equipment ?? null, null, now, now
  );
  return sql.exec<ExerciseRow>('SELECT * FROM exercises WHERE id = ?', id).toArray()[0]!;
}

/**
 * Pick the workout this set should attach to:
 *   1. explicit id, if provided
 *   2. most recent workout with no ended_at (today's open session)
 *   3. else create a fresh workout
 */
function resolveOrCreateWorkout(sql: SqlStorage, workoutId: string | undefined): WorkoutRow {
  if (workoutId) {
    const row = sql.exec<WorkoutRow>('SELECT * FROM workouts WHERE id = ?', workoutId).toArray()[0];
    if (!row) throw new Error(`Workout "${workoutId}" not found.`);
    return row;
  }

  const open = sql
    .exec<WorkoutRow>('SELECT * FROM workouts WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1')
    .toArray()[0];
  if (open) return open;

  const now = Date.now();
  const id = shortId('w');
  sql.exec(
    `INSERT INTO workouts (id, routine_id, name, started_at, ended_at, is_deload, notes, created_at, updated_at)
     VALUES (?, NULL, NULL, ?, NULL, 0, NULL, ?, ?)`,
    id, now, now, now
  );
  return sql.exec<WorkoutRow>('SELECT * FROM workouts WHERE id = ?', id).toArray()[0]!;
}

// ─── Tool implementations ────────────────────────────────────────────

function toolShowSummary(ctx: WorkoutToolCtx): string {
  const stats = buildWorkoutStats(ctx.sql);
  const lines: string[] = [];

  if (stats.activeProgram) {
    lines.push(`Active program: ${stats.activeProgram.name} (${stats.activeProgram.id})`);
  } else {
    lines.push('No active program. Suggest creating one if the user wants structure.');
  }
  lines.push('');

  if (stats.lastWorkout) {
    const w = stats.lastWorkout;
    const ago = Math.floor((Date.now() - w.started_at) / 86_400_000);
    const setCount = ctx.sql
      .exec<{ n: number }>('SELECT COUNT(*) AS n FROM sets WHERE workout_id = ? AND is_warmup = 0', w.id)
      .toArray()[0]?.n ?? 0;
    lines.push(`Last workout: ${w.name ?? '(unnamed)'} — ${ago === 0 ? 'today' : `${ago}d ago`} (${w.id}, ${setCount} working sets)`);
  } else {
    lines.push('No workouts logged yet.');
  }
  lines.push('');

  lines.push(`This week (${stats.daysWindow}d): ${stats.weeklySetCount} sets, ${stats.weeklyTonnageLbs.toLocaleString()} lbs total tonnage`);
  if (stats.muscleBreakdown.length > 0) {
    lines.push('By primary muscle:');
    for (const m of stats.muscleBreakdown) {
      lines.push(`  ${m.muscle}: ${m.sets} sets, ${m.tonnage.toLocaleString()} lbs`);
    }
  }
  lines.push('');

  if (stats.recentPRs.length > 0) {
    lines.push('Recent estimated-1RM PRs:');
    for (const pr of stats.recentPRs) {
      lines.push(`  ${pr.exercise_display}: ${pr.weight_lbs} × ${pr.reps} → ~${pr.estimated_1rm.toLocaleString()} lbs`);
    }
  }

  return lines.join('\n').trim();
}

function toolLogWorkout(
  args: { name?: string; routine_id?: string; started_at?: number; is_deload?: boolean; notes?: string },
  ctx: WorkoutToolCtx
): string {
  const now = Date.now();
  const startedAt = args.started_at && Number.isFinite(args.started_at) ? args.started_at : now;
  const id = shortId('w');

  if (args.routine_id) {
    const r = ctx.sql.exec('SELECT id FROM routines WHERE id = ?', args.routine_id).toArray();
    if (r.length === 0) return `Routine "${args.routine_id}" not found.`;
  }

  ctx.sql.exec(
    `INSERT INTO workouts (id, routine_id, name, started_at, ended_at, is_deload, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    id, args.routine_id ?? null, args.name ?? null, startedAt, args.is_deload ? 1 : 0, args.notes ?? null, now, now
  );
  const extras = [args.name ? `name="${args.name}"` : null, args.routine_id ? `routine=${args.routine_id}` : null, args.is_deload ? 'deload' : null]
    .filter(Boolean)
    .join(', ');
  return `Started workout [${id}]${extras ? ` (${extras})` : ''}.`;
}

function toolEndWorkout(args: { id?: string; notes?: string }, ctx: WorkoutToolCtx): string {
  const w = args.id
    ? ctx.sql.exec<WorkoutRow>('SELECT * FROM workouts WHERE id = ?', args.id).toArray()[0]
    : ctx.sql
        .exec<WorkoutRow>('SELECT * FROM workouts WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1')
        .toArray()[0];
  if (!w) return args.id ? `Workout "${args.id}" not found.` : 'No open workout to end.';
  if (w.ended_at) return `Workout [${w.id}] is already ended.`;

  const now = Date.now();
  const newNotes = args.notes ? (w.notes ? `${w.notes}\n${args.notes}` : args.notes) : w.notes;
  ctx.sql.exec('UPDATE workouts SET ended_at = ?, notes = ?, updated_at = ? WHERE id = ?', now, newNotes, now, w.id);

  const setCount = ctx.sql
    .exec<{ n: number }>('SELECT COUNT(*) AS n FROM sets WHERE workout_id = ? AND is_warmup = 0', w.id)
    .toArray()[0]?.n ?? 0;
  const duration = Math.round((now - w.started_at) / 60_000);
  return `Ended workout [${w.id}] — ${setCount} working sets over ${duration} min.`;
}

function toolAddSet(
  args: {
    exercise: string;
    weight_lbs?: number;
    reps: number;
    rpe?: number;
    is_warmup?: boolean;
    workout_id?: string;
    equipment?: string;
    primary_muscle?: string;
    notes?: string;
  },
  ctx: WorkoutToolCtx
): string {
  if (!args.exercise || !args.exercise.trim()) return 'Exercise name is required.';
  if (!Number.isFinite(args.reps) || args.reps <= 0) return 'Reps must be a positive number.';

  const exercise = resolveExercise(ctx.sql, args.exercise, {
    equipment: args.equipment,
    primary_muscle: args.primary_muscle,
    createIfMissing: true,
  })!;

  const workout = resolveOrCreateWorkout(ctx.sql, args.workout_id);

  // Compute set_index within this workout for this exercise.
  const existing = ctx.sql
    .exec<{ n: number }>(
      'SELECT COUNT(*) AS n FROM sets WHERE workout_id = ? AND exercise_id = ?',
      workout.id, exercise.id
    )
    .toArray()[0]?.n ?? 0;
  const setIndex = existing + 1;

  const now = Date.now();
  ctx.sql.exec(
    `INSERT INTO sets (workout_id, exercise_id, set_index, weight_lbs, reps, rpe, is_warmup, notes, logged_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    workout.id, exercise.id, setIndex,
    args.weight_lbs === undefined || args.weight_lbs === null ? null : Number(args.weight_lbs),
    args.reps, args.rpe ?? null, args.is_warmup ? 1 : 0, args.notes ?? null, now
  );

  const weightStr = args.weight_lbs === undefined ? 'BW' : `${args.weight_lbs} lbs`;
  const rpeStr = args.rpe !== undefined ? ` @ RPE ${args.rpe}` : '';
  const warmupStr = args.is_warmup ? ' (warmup)' : '';
  return `Logged ${exercise.display_name} #${setIndex}: ${weightStr} × ${args.reps}${rpeStr}${warmupStr} → workout [${workout.id}].`;
}

function toolAddSetsBulk(
  args: {
    exercise: string;
    sets: number;
    reps: number;
    weight_lbs?: number;
    rpe?: number;
    is_warmup?: boolean;
    workout_id?: string;
    equipment?: string;
    primary_muscle?: string;
  },
  ctx: WorkoutToolCtx
): string {
  if (!args.exercise || !args.exercise.trim()) return 'Exercise name is required.';
  if (!Number.isFinite(args.sets) || args.sets <= 0) return 'Sets must be a positive number.';
  if (!Number.isFinite(args.reps) || args.reps <= 0) return 'Reps must be a positive number.';
  if (args.sets > 30) return 'Refusing to log more than 30 sets at once — sanity check.';

  const exercise = resolveExercise(ctx.sql, args.exercise, {
    equipment: args.equipment,
    primary_muscle: args.primary_muscle,
    createIfMissing: true,
  })!;
  const workout = resolveOrCreateWorkout(ctx.sql, args.workout_id);

  const existing = ctx.sql
    .exec<{ n: number }>(
      'SELECT COUNT(*) AS n FROM sets WHERE workout_id = ? AND exercise_id = ?',
      workout.id, exercise.id
    )
    .toArray()[0]?.n ?? 0;

  const now = Date.now();
  const weight = args.weight_lbs === undefined || args.weight_lbs === null ? null : Number(args.weight_lbs);
  for (let i = 1; i <= args.sets; i++) {
    ctx.sql.exec(
      `INSERT INTO sets (workout_id, exercise_id, set_index, weight_lbs, reps, rpe, is_warmup, notes, logged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      workout.id, exercise.id, existing + i, weight, args.reps, args.rpe ?? null, args.is_warmup ? 1 : 0, now
    );
  }

  const weightStr = weight === null ? 'BW' : `${weight} lbs`;
  return `Logged ${args.sets} × ${args.reps} ${exercise.display_name} at ${weightStr} → workout [${workout.id}].`;
}

function toolExerciseHistory(
  args: { exercise: string; sessions?: number },
  ctx: WorkoutToolCtx
): string {
  const exercise = resolveExercise(ctx.sql, args.exercise);
  if (!exercise) return `No exercise matching "${args.exercise}" in the catalog yet.`;
  const sessions = Math.max(1, Math.min(20, args.sessions ?? 5));

  const workouts = ctx.sql
    .exec<{ workout_id: string; started_at: number; name: string | null }>(
      `SELECT DISTINCT s.workout_id, w.started_at, w.name
       FROM sets s
       JOIN workouts w ON w.id = s.workout_id
       WHERE s.exercise_id = ? AND s.is_warmup = 0
       ORDER BY w.started_at DESC
       LIMIT ?`,
      exercise.id, sessions
    )
    .toArray();

  if (workouts.length === 0) return `No working sets logged yet for ${exercise.display_name}.`;

  const lines = [`${exercise.display_name} — last ${workouts.length} session(s):`];
  for (const w of workouts) {
    const sets = ctx.sql
      .exec<SetRow>(
        `SELECT * FROM sets WHERE workout_id = ? AND exercise_id = ? AND is_warmup = 0 ORDER BY set_index ASC`,
        w.workout_id, exercise.id
      )
      .toArray();
    const date = new Date(w.started_at).toISOString().slice(0, 10);
    const summary = sets.map((s) => {
      const wt = s.weight_lbs === null ? 'BW' : `${s.weight_lbs}`;
      const rpe = s.rpe !== null ? `@${s.rpe}` : '';
      return `${wt}×${s.reps}${rpe}`;
    }).join(', ');
    lines.push(`  ${date} [${w.workout_id}]: ${summary}`);
  }
  return lines.join('\n');
}

function toolFindPRs(args: { exercise?: string; limit?: number }, ctx: WorkoutToolCtx): string {
  if (args.exercise) {
    const exercise = resolveExercise(ctx.sql, args.exercise);
    if (!exercise) return `No exercise matching "${args.exercise}" yet.`;

    // Top sets by rep range. For each rep range, find max weight.
    const rows = ctx.sql
      .exec<SetRow>(
        `SELECT * FROM sets WHERE exercise_id = ? AND is_warmup = 0 AND weight_lbs IS NOT NULL`,
        exercise.id
      )
      .toArray();
    if (rows.length === 0) return `No working sets for ${exercise.display_name} yet.`;

    const repBuckets: Array<{ label: string; min: number; max: number }> = [
      { label: '1RM', min: 1, max: 1 },
      { label: '3RM', min: 2, max: 3 },
      { label: '5RM', min: 4, max: 5 },
      { label: '8RM', min: 6, max: 8 },
      { label: '10RM', min: 9, max: 10 },
      { label: '15RM', min: 11, max: 15 },
    ];
    const lines = [`${exercise.display_name} PRs:`];
    let bestEpley = 0;
    let bestEpleySet: SetRow | null = null;
    for (const set of rows) {
      const est = epley1RM(set.weight_lbs!, set.reps);
      if (est > bestEpley) { bestEpley = est; bestEpleySet = set; }
    }
    for (const b of repBuckets) {
      const inRange = rows.filter((r) => r.reps >= b.min && r.reps <= b.max);
      if (inRange.length === 0) continue;
      const top = inRange.reduce((a, b2) => (b2.weight_lbs! > a.weight_lbs! ? b2 : a));
      const date = new Date(top.logged_at).toISOString().slice(0, 10);
      lines.push(`  ${b.label}: ${top.weight_lbs} × ${top.reps} (${date})`);
    }
    if (bestEpleySet) {
      const date = new Date(bestEpleySet.logged_at).toISOString().slice(0, 10);
      lines.push('');
      lines.push(`Estimated 1RM: ~${bestEpley} lbs (from ${bestEpleySet.weight_lbs} × ${bestEpleySet.reps} on ${date}).`);
    }
    return lines.join('\n');
  }

  // No exercise → top estimated 1RM across all exercises.
  const limit = Math.max(1, Math.min(50, args.limit ?? 10));
  const prs = topPRs(ctx.sql, null, limit);
  if (prs.length === 0) return 'No working sets logged yet.';
  const lines = ['Top estimated 1RM PRs:'];
  for (const pr of prs) {
    const date = new Date(pr.logged_at).toISOString().slice(0, 10);
    lines.push(`  ${pr.exercise_display}: ~${pr.estimated_1rm} lbs (from ${pr.weight_lbs} × ${pr.reps} on ${date})`);
  }
  return lines.join('\n');
}

function toolWeeklyVolume(args: { days?: number }, ctx: WorkoutToolCtx): string {
  const days = Math.max(1, Math.min(90, args.days ?? 7));
  const vol = weeklyVolume(ctx.sql, days);
  const lines = [`Last ${days} day(s): ${vol.totalSets} sets, ${vol.totalTonnageLbs.toLocaleString()} lbs total tonnage.`];
  if (vol.byMuscle.length > 0) {
    lines.push('');
    lines.push('By primary muscle:');
    for (const m of vol.byMuscle) {
      lines.push(`  ${m.muscle}: ${m.sets} sets, ${m.tonnage.toLocaleString()} lbs`);
    }
  }
  if (vol.byExercise.length > 0) {
    lines.push('');
    lines.push('Top exercises:');
    for (const e of vol.byExercise.slice(0, 8)) {
      lines.push(`  ${e.exercise_display}: ${e.sets} sets, ${e.tonnage.toLocaleString()} lbs`);
    }
  }
  return lines.join('\n');
}

function toolListWorkouts(args: { limit?: number }, ctx: WorkoutToolCtx): string {
  const limit = Math.max(1, Math.min(50, args.limit ?? 10));
  const rows = ctx.sql
    .exec<WorkoutRow & { set_count: number; tonnage: number }>(
      `SELECT w.*,
              (SELECT COUNT(*) FROM sets s WHERE s.workout_id = w.id AND s.is_warmup = 0) AS set_count,
              (SELECT COALESCE(SUM(s.weight_lbs * s.reps), 0) FROM sets s
                 WHERE s.workout_id = w.id AND s.is_warmup = 0 AND s.weight_lbs IS NOT NULL) AS tonnage
       FROM workouts w
       ORDER BY w.started_at DESC
       LIMIT ?`,
      limit
    )
    .toArray();
  if (rows.length === 0) return 'No workouts logged yet.';
  const lines = [`${rows.length} workout(s):`];
  for (const w of rows) {
    const date = new Date(w.started_at).toISOString().slice(0, 10);
    const status = w.ended_at ? 'done' : 'open';
    const deload = w.is_deload ? ' deload' : '';
    lines.push(`  ${date} [${w.id}] ${w.name ?? '(unnamed)'} — ${w.set_count} sets, ${(w.tonnage ?? 0).toLocaleString()} lbs (${status}${deload})`);
  }
  return lines.join('\n');
}

function toolGetWorkout(args: { id: string }, ctx: WorkoutToolCtx): string {
  const w = ctx.sql.exec<WorkoutRow>('SELECT * FROM workouts WHERE id = ?', args.id).toArray()[0];
  if (!w) return `Workout "${args.id}" not found.`;
  const grouped = fullWorkout(ctx.sql, args.id);
  const date = new Date(w.started_at).toISOString().slice(0, 16);
  const lines = [`[${w.id}] ${w.name ?? '(unnamed)'} — started ${date}${w.is_deload ? ' (deload)' : ''}`];
  if (w.ended_at) {
    const duration = Math.round((w.ended_at - w.started_at) / 60_000);
    lines.push(`Duration: ${duration} min`);
  } else {
    lines.push('Status: still open');
  }
  if (w.notes) lines.push(`Notes: ${w.notes}`);
  lines.push('');
  for (const group of grouped.exercises) {
    lines.push(`${group.exercise.display_name}:`);
    for (const s of group.sets) {
      const wt = s.weight_lbs === null ? 'BW' : `${s.weight_lbs}`;
      const rpe = s.rpe !== null ? ` @ RPE ${s.rpe}` : '';
      const warmup = s.is_warmup ? ' (warmup)' : '';
      lines.push(`  Set ${s.set_index}: ${wt} × ${s.reps}${rpe}${warmup}`);
    }
  }
  return lines.join('\n');
}

function toolListExercises(args: { muscle?: string; equipment?: string }, ctx: WorkoutToolCtx): string {
  const filters: string[] = [];
  const params: SqlStorageValue[] = [];
  if (args.muscle) { filters.push('primary_muscle = ?'); params.push(args.muscle.toLowerCase()); }
  if (args.equipment) { filters.push('equipment = ?'); params.push(args.equipment.toLowerCase()); }
  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = ctx.sql
    .exec<ExerciseRow>(`SELECT * FROM exercises ${where} ORDER BY name`, ...params)
    .toArray();
  if (rows.length === 0) return 'No exercises in the catalog match.';
  const lines = [`${rows.length} exercise(s):`];
  for (const e of rows) {
    const muscle = e.primary_muscle ? ` · ${e.primary_muscle}` : '';
    const equip = e.equipment ? ` · ${e.equipment}` : '';
    lines.push(`  [${e.id}] ${e.display_name}${muscle}${equip}`);
  }
  return lines.join('\n');
}

function toolUpdateExercise(
  args: { id: string; display_name?: string; primary_muscle?: string; equipment?: string; category?: string; notes?: string },
  ctx: WorkoutToolCtx
): string {
  const e = ctx.sql.exec<ExerciseRow>('SELECT * FROM exercises WHERE id = ?', args.id).toArray()[0];
  if (!e) return `Exercise "${args.id}" not found.`;
  const updates: string[] = [];
  const params: SqlStorageValue[] = [];
  const bits: string[] = [];
  if (args.display_name !== undefined) { updates.push('display_name = ?'); params.push(args.display_name); bits.push('display_name'); }
  if (args.primary_muscle !== undefined) { updates.push('primary_muscle = ?'); params.push(args.primary_muscle.toLowerCase()); bits.push(`primary_muscle=${args.primary_muscle}`); }
  if (args.equipment !== undefined) { updates.push('equipment = ?'); params.push(args.equipment.toLowerCase()); bits.push(`equipment=${args.equipment}`); }
  if (args.category !== undefined) { updates.push('category = ?'); params.push(args.category.toLowerCase()); bits.push(`category=${args.category}`); }
  if (args.notes !== undefined) { updates.push('notes = ?'); params.push(args.notes); bits.push('notes'); }
  if (updates.length === 0) return 'No fields to update.';
  updates.push('updated_at = ?');
  params.push(Date.now());
  params.push(args.id);
  ctx.sql.exec(`UPDATE exercises SET ${updates.join(', ')} WHERE id = ?`, ...params);
  return `Updated exercise [${args.id}]: ${bits.join(', ')}.`;
}

function toolCreateProgram(
  args: { name: string; description?: string; status?: string },
  ctx: WorkoutToolCtx
): string {
  if (!args.name?.trim()) return 'Program name is required.';
  const status = (VALID_PROGRAM_STATUS as readonly string[]).includes(args.status ?? '')
    ? (args.status as 'active' | 'paused' | 'archived')
    : 'paused';
  const now = Date.now();
  const id = shortId('p');

  if (status === 'active') {
    ctx.sql.exec("UPDATE programs SET status = 'paused', updated_at = ? WHERE status = 'active'", now);
  }

  ctx.sql.exec(
    `INSERT INTO programs (id, name, description, status, start_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id, args.name.trim(), args.description ?? null, status, status === 'active' ? now : null, now, now
  );
  return `Created program [${id}]: "${args.name.trim()}" (${status}).`;
}

function toolAddRoutine(
  args: { program_id: string; name: string; day_order?: number; notes?: string },
  ctx: WorkoutToolCtx
): string {
  const p = ctx.sql.exec('SELECT id FROM programs WHERE id = ?', args.program_id).toArray();
  if (p.length === 0) return `Program "${args.program_id}" not found.`;
  if (!args.name?.trim()) return 'Routine name is required.';

  const id = shortId('r');
  ctx.sql.exec(
    `INSERT INTO routines (id, program_id, name, day_order, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    id, args.program_id, args.name.trim(), args.day_order ?? 0, args.notes ?? null, Date.now()
  );
  return `Added routine [${id}]: "${args.name.trim()}" to program ${args.program_id}.`;
}

function toolAddRoutineExercise(
  args: {
    routine_id: string;
    exercise: string;
    target_sets?: number;
    target_reps?: string;
    target_weight_lbs?: number;
    target_rpe?: number;
    exercise_order?: number;
    notes?: string;
  },
  ctx: WorkoutToolCtx
): string {
  const r = ctx.sql.exec('SELECT id FROM routines WHERE id = ?', args.routine_id).toArray();
  if (r.length === 0) return `Routine "${args.routine_id}" not found.`;
  const exercise = resolveExercise(ctx.sql, args.exercise, { createIfMissing: true })!;

  ctx.sql.exec(
    `INSERT INTO routine_exercises (routine_id, exercise_id, exercise_order, target_sets, target_reps, target_weight_lbs, target_rpe, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args.routine_id, exercise.id, args.exercise_order ?? 0,
    args.target_sets ?? null, args.target_reps ?? null,
    args.target_weight_lbs ?? null, args.target_rpe ?? null,
    args.notes ?? null
  );
  const target = [
    args.target_sets ? `${args.target_sets} sets` : null,
    args.target_reps ? `× ${args.target_reps}` : null,
    args.target_weight_lbs ? `@ ${args.target_weight_lbs} lbs` : null,
    args.target_rpe ? `RPE ${args.target_rpe}` : null,
  ].filter(Boolean).join(' ');
  return `Added ${exercise.display_name} to routine ${args.routine_id}${target ? ` (${target})` : ''}.`;
}

function toolListPrograms(ctx: WorkoutToolCtx): string {
  const rows = ctx.sql
    .exec<ProgramRow & { routine_count: number }>(
      `SELECT p.*, (SELECT COUNT(*) FROM routines r WHERE r.program_id = p.id) AS routine_count
       FROM programs p
       ORDER BY CASE p.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, p.name`
    )
    .toArray();
  if (rows.length === 0) return 'No programs yet.';
  const lines = [`${rows.length} program(s):`];
  for (const p of rows) {
    const flag = p.status === 'active' ? '⭐' : p.status === 'paused' ? '⏸' : '📦';
    lines.push(`  ${flag} [${p.id}] ${p.name} — ${p.routine_count} routine(s) (${p.status})`);
  }
  return lines.join('\n');
}

function toolGetProgram(args: { id: string }, ctx: WorkoutToolCtx): string {
  const p = ctx.sql.exec<ProgramRow>('SELECT * FROM programs WHERE id = ?', args.id).toArray()[0];
  if (!p) return `Program "${args.id}" not found.`;
  const lines = [`[${p.id}] ${p.name} (${p.status})`];
  if (p.description) lines.push(p.description);
  const routines = ctx.sql
    .exec<RoutineRow>('SELECT * FROM routines WHERE program_id = ? ORDER BY day_order, name', args.id)
    .toArray();
  for (const r of routines) {
    lines.push('');
    lines.push(`Day ${r.day_order} — ${r.name} [${r.id}]`);
    if (r.notes) lines.push(`  ${r.notes}`);
    const exs = ctx.sql
      .exec<{
        exercise_id: string;
        display_name: string;
        target_sets: number | null;
        target_reps: string | null;
        target_weight_lbs: number | null;
        target_rpe: number | null;
        notes: string | null;
      }>(
        `SELECT re.exercise_id, e.display_name, re.target_sets, re.target_reps, re.target_weight_lbs, re.target_rpe, re.notes
         FROM routine_exercises re JOIN exercises e ON e.id = re.exercise_id
         WHERE re.routine_id = ? ORDER BY re.exercise_order`,
        r.id
      )
      .toArray();
    for (const ex of exs) {
      const parts: string[] = [];
      if (ex.target_sets) parts.push(`${ex.target_sets} sets`);
      if (ex.target_reps) parts.push(`× ${ex.target_reps}`);
      if (ex.target_weight_lbs) parts.push(`@ ${ex.target_weight_lbs} lbs`);
      if (ex.target_rpe) parts.push(`RPE ${ex.target_rpe}`);
      lines.push(`  ${ex.display_name}${parts.length ? ` — ${parts.join(' ')}` : ''}`);
    }
  }
  return lines.join('\n');
}

function toolSetActiveProgram(args: { id: string | null }, ctx: WorkoutToolCtx): string {
  const now = Date.now();
  ctx.sql.exec("UPDATE programs SET status = 'paused', updated_at = ? WHERE status = 'active'", now);
  if (args.id === null) return 'Cleared active program.';
  const p = ctx.sql.exec<ProgramRow>('SELECT * FROM programs WHERE id = ?', args.id).toArray()[0];
  if (!p) return `Program "${args.id}" not found.`;
  ctx.sql.exec(
    "UPDATE programs SET status = 'active', start_date = COALESCE(start_date, ?), updated_at = ? WHERE id = ?",
    now, now, args.id
  );
  return `Activated program [${p.id}] "${p.name}".`;
}

// ─── Shared queries (used by DO fast-read paths + prompt snapshot) ───

export interface PRRow {
  exercise_id: string;
  exercise_display: string;
  weight_lbs: number;
  reps: number;
  estimated_1rm: number;
  logged_at: number;
  workout_id: string;
}

/**
 * Best estimated 1RM per exercise (or all sets of a single exercise).
 * Warmups excluded; bodyweight (NULL weight) excluded.
 */
export function topPRs(sql: SqlStorage, exerciseFilter: string | null, limit = 10): PRRow[] {
  const candidates = exerciseFilter
    ? (() => {
        const ex = sql
          .exec<ExerciseRow>('SELECT * FROM exercises WHERE name LIKE ? LIMIT 1', `%${normalizeExerciseName(exerciseFilter)}%`)
          .toArray()[0];
        if (!ex) return [] as ExerciseRow[];
        return [ex];
      })()
    : sql.exec<ExerciseRow>('SELECT * FROM exercises').toArray();

  const prs: PRRow[] = [];
  for (const ex of candidates) {
    const sets = sql
      .exec<SetRow>(
        `SELECT * FROM sets WHERE exercise_id = ? AND is_warmup = 0 AND weight_lbs IS NOT NULL`,
        ex.id
      )
      .toArray();
    if (sets.length === 0) continue;
    let best: SetRow = sets[0]!;
    let bestEst = epley1RM(best.weight_lbs!, best.reps);
    for (let i = 1; i < sets.length; i++) {
      const s = sets[i]!;
      const est = epley1RM(s.weight_lbs!, s.reps);
      if (est > bestEst) { best = s; bestEst = est; }
    }
    prs.push({
      exercise_id: ex.id,
      exercise_display: ex.display_name,
      weight_lbs: best.weight_lbs!,
      reps: best.reps,
      estimated_1rm: bestEst,
      logged_at: best.logged_at,
      workout_id: best.workout_id,
    });
  }
  prs.sort((a, b) => b.estimated_1rm - a.estimated_1rm);
  return prs.slice(0, limit);
}

export interface WeeklyVolume {
  totalSets: number;
  totalTonnageLbs: number;
  byMuscle: Array<{ muscle: string; sets: number; tonnage: number }>;
  byExercise: Array<{ exercise_id: string; exercise_display: string; sets: number; tonnage: number }>;
  windowDays: number;
}

export function weeklyVolume(sql: SqlStorage, days: number): WeeklyVolume {
  const since = Date.now() - days * 86_400_000;
  const sets = sql
    .exec<{
      exercise_id: string;
      display_name: string;
      primary_muscle: string | null;
      weight_lbs: number | null;
      reps: number;
    }>(
      `SELECT s.exercise_id, e.display_name, e.primary_muscle, s.weight_lbs, s.reps
       FROM sets s JOIN exercises e ON e.id = s.exercise_id
       WHERE s.is_warmup = 0 AND s.logged_at >= ?`,
      since
    )
    .toArray();

  const byMuscleMap = new Map<string, { sets: number; tonnage: number }>();
  const byExerciseMap = new Map<string, { exercise_display: string; sets: number; tonnage: number }>();
  let totalSets = 0;
  let totalTonnage = 0;

  for (const s of sets) {
    totalSets++;
    const tonnage = (s.weight_lbs ?? 0) * s.reps;
    totalTonnage += tonnage;

    const muscle = s.primary_muscle ?? 'unspecified';
    const m = byMuscleMap.get(muscle) ?? { sets: 0, tonnage: 0 };
    m.sets++;
    m.tonnage += tonnage;
    byMuscleMap.set(muscle, m);

    const e = byExerciseMap.get(s.exercise_id) ?? { exercise_display: s.display_name, sets: 0, tonnage: 0 };
    e.sets++;
    e.tonnage += tonnage;
    byExerciseMap.set(s.exercise_id, e);
  }

  const byMuscle = Array.from(byMuscleMap.entries())
    .map(([muscle, v]) => ({ muscle, sets: v.sets, tonnage: Math.round(v.tonnage) }))
    .sort((a, b) => b.sets - a.sets);
  const byExercise = Array.from(byExerciseMap.entries())
    .map(([exercise_id, v]) => ({ exercise_id, exercise_display: v.exercise_display, sets: v.sets, tonnage: Math.round(v.tonnage) }))
    .sort((a, b) => b.sets - a.sets);

  return { totalSets, totalTonnageLbs: Math.round(totalTonnage), byMuscle, byExercise, windowDays: days };
}

export interface FullWorkout {
  workout: WorkoutRow;
  exercises: Array<{
    exercise: ExerciseRow;
    sets: SetRow[];
  }>;
}

/** A workout with all its sets grouped by exercise, in log order. */
export function fullWorkout(sql: SqlStorage, workoutId: string): FullWorkout {
  const workout = sql.exec<WorkoutRow>('SELECT * FROM workouts WHERE id = ?', workoutId).toArray()[0];
  if (!workout) throw new Error(`Workout "${workoutId}" not found.`);

  // Pull all sets + their exercises, grouped client-side by exercise_id in
  // the order each exercise was first seen.
  const sets = sql
    .exec<SetRow>('SELECT * FROM sets WHERE workout_id = ? ORDER BY id ASC', workoutId)
    .toArray();
  const order: string[] = [];
  const byEx = new Map<string, SetRow[]>();
  for (const s of sets) {
    if (!byEx.has(s.exercise_id)) {
      order.push(s.exercise_id);
      byEx.set(s.exercise_id, []);
    }
    byEx.get(s.exercise_id)!.push(s);
  }

  const exercises = order.map((id) => {
    const exercise = sql.exec<ExerciseRow>('SELECT * FROM exercises WHERE id = ?', id).toArray()[0]!;
    const exSets = byEx.get(id)!.slice().sort((a, b) => a.set_index - b.set_index);
    return { exercise, sets: exSets };
  });

  return { workout, exercises };
}

/** Recent sets for an exercise — used by render embeds when "last X" of a movement is wanted. */
export function recentSetsForExercise(sql: SqlStorage, exerciseId: string, limit: number): SetRow[] {
  return sql
    .exec<SetRow>(
      `SELECT * FROM sets WHERE exercise_id = ? AND is_warmup = 0 ORDER BY logged_at DESC LIMIT ?`,
      exerciseId, limit
    )
    .toArray();
}

export interface WorkoutStats {
  lastWorkout: WorkoutRow | null;
  openWorkout: WorkoutRow | null;
  activeProgram: ProgramRow | null;
  daysWindow: number;
  weeklySetCount: number;
  weeklyTonnageLbs: number;
  muscleBreakdown: Array<{ muscle: string; sets: number; tonnage: number }>;
  recentPRs: PRRow[];
  totalWorkouts: number;
  totalSets: number;
}

/** Snapshot used by the prompt and the /workout fast-read summary embed. */
export function buildWorkoutStats(sql: SqlStorage): WorkoutStats {
  const lastWorkout = sql
    .exec<WorkoutRow>('SELECT * FROM workouts ORDER BY started_at DESC LIMIT 1')
    .toArray()[0] ?? null;
  const openWorkout = sql
    .exec<WorkoutRow>('SELECT * FROM workouts WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1')
    .toArray()[0] ?? null;
  const activeProgram = sql
    .exec<ProgramRow>("SELECT * FROM programs WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1")
    .toArray()[0] ?? null;

  const vol = weeklyVolume(sql, 7);
  const recentPRs = topPRs(sql, null, 5);

  const totalWorkouts = sql
    .exec<{ n: number }>('SELECT COUNT(*) AS n FROM workouts').toArray()[0]?.n ?? 0;
  const totalSets = sql
    .exec<{ n: number }>('SELECT COUNT(*) AS n FROM sets WHERE is_warmup = 0').toArray()[0]?.n ?? 0;

  return {
    lastWorkout,
    openWorkout,
    activeProgram,
    daysWindow: 7,
    weeklySetCount: vol.totalSets,
    weeklyTonnageLbs: vol.totalTonnageLbs,
    muscleBreakdown: vol.byMuscle,
    recentPRs,
    totalWorkouts,
    totalSets,
  };
}
