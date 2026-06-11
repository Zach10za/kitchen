import type { BotSpec } from '../runtime/bot-spec';
import type { MessagePayload } from '../discord/types';
import { ensureRelayRateSchema } from '../runtime/relay-rate-limit';
import { ensureUsageSchema } from '../runtime/usage';
import { WORKOUT_TOOLS } from './tools';
import {
  executeWorkoutTool,
  buildWorkoutStats,
  topPRs,
  weeklyVolume,
  fullWorkout,
  type WorkoutRow,
} from './loop';
import { buildWorkoutSystemPrompt } from './prompts';
import {
  workoutSummaryEmbed,
  workoutLastEmbed,
  workoutPRsEmbed,
  workoutWeekEmbed,
  workoutProgramEmbed,
  workoutProfileEmbed,
} from './render';

/** Workout bot spec — see runtime/bot-spec.ts for the contract. */
export const WORKOUT_SPEC: BotSpec = {
  id: 'workout',
  channelEnvKey: 'DISCORD_WORKOUT_CHANNEL_ID',
  commands: new Set([
    'workout',
    'workout-last',
    'workout-prs',
    'workout-week',
    'workout-program',
    'workout-profile',
  ]),
  tools: WORKOUT_TOOLS,
  // Children before parents — DO SQLite doesn't enable foreign_keys, so the
  // REFERENCES clauses in the schema are documentation only and /reset has to
  // delete in dependency order to match the implicit constraint shape.
  resetTables: [
    'sets',
    'workouts',
    'routine_exercises',
    'routines',
    'programs',
    'exercises',
    'gym_equipment',
    'profile',
    'settings',
    'conversation',
  ],
  scopeColumn: 'thread_id',

  buildSystemPrompt: (sql, env) => buildWorkoutSystemPrompt(sql, env.TIMEZONE),

  executeTool: (name, args, ctx) =>
    executeWorkoutTool(name, args, { sql: ctx.sql, timezone: ctx.timezone }),

  fastRead: (sql, _env, interaction): MessagePayload | null => {
    const cmd = interaction.data?.name ?? '';
    const optionMap = Object.fromEntries(
      (interaction.data?.options ?? []).map((o) => [o.name, o.value]),
    );

    if (cmd === 'workout') {
      const stats = buildWorkoutStats(sql);
      return { embeds: [workoutSummaryEmbed(stats)] };
    }

    if (cmd === 'workout-last') {
      const last = sql
        .exec<WorkoutRow>('SELECT * FROM workouts ORDER BY started_at DESC LIMIT 1')
        .toArray()[0];
      if (!last) {
        return { content: 'No workouts logged yet. Use `/workout message: ...` to log one.' };
      }
      const full = fullWorkout(sql, last.id);
      return { embeds: [workoutLastEmbed(full)] };
    }

    if (cmd === 'workout-prs') {
      const exerciseName = optionMap.exercise ? String(optionMap.exercise) : null;
      const prs = topPRs(sql, exerciseName);
      return { embeds: [workoutPRsEmbed(prs, exerciseName)] };
    }

    if (cmd === 'workout-week') {
      const days = Number(optionMap.days ?? 7);
      const safeDays = Math.max(1, Math.min(90, days));
      const volume = weeklyVolume(sql, safeDays);
      return { embeds: [workoutWeekEmbed(volume, safeDays)] };
    }

    if (cmd === 'workout-program') {
      const active = sql
        .exec<{ id: string; name: string; description: string | null }>(
          "SELECT id, name, description FROM programs WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1",
        )
        .toArray()[0];
      if (!active) {
        return {
          content: 'No active program. Use `/workout message: set up a 5/3/1 program` (or whatever split you want) to create one.',
        };
      }
      const routines = sql
        .exec<{ id: string; name: string; day_order: number; notes: string | null }>(
          'SELECT id, name, day_order, notes FROM routines WHERE program_id = ? ORDER BY day_order ASC, name ASC',
          active.id,
        )
        .toArray();
      const routinesWithExercises = routines.map((r) => ({
        ...r,
        exercises: sql
          .exec<{
            exercise_id: string;
            display_name: string;
            target_sets: number | null;
            target_reps: string | null;
            target_weight_lbs: number | null;
            target_rpe: number | null;
            notes: string | null;
          }>(
            `SELECT re.exercise_id, e.display_name,
                    re.target_sets, re.target_reps, re.target_weight_lbs, re.target_rpe, re.notes
             FROM routine_exercises re
             JOIN exercises e ON e.id = re.exercise_id
             WHERE re.routine_id = ?
             ORDER BY re.exercise_order ASC`,
            r.id,
          )
          .toArray(),
      }));
      return { embeds: [workoutProgramEmbed(active, routinesWithExercises)] };
    }

    if (cmd === 'workout-profile') {
      const stats = buildWorkoutStats(sql);
      return { embeds: [workoutProfileEmbed(stats.profile, stats.equipment)] };
    }

    return null;
  },

  defaultScope: (_env, replyChannelId) => ({ column: 'thread_id', value: replyChannelId }),

  // Migrations preserved verbatim from workout-do.ts (versions 1-4).
  migrations: [
    {
      // REFERENCES clauses are documentation only — DO SQLite does not enable
      // foreign_keys PRAGMA, so cascades and FK constraints do not fire.
      version: 1,
      up: (sql) => {
        sql.exec(`
          CREATE TABLE IF NOT EXISTS exercises (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            category TEXT,
            primary_muscle TEXT,
            equipment TEXT,
            notes TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_exercises_name ON exercises(name);
          CREATE INDEX IF NOT EXISTS idx_exercises_muscle ON exercises(primary_muscle);

          CREATE TABLE IF NOT EXISTS programs (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            status TEXT NOT NULL DEFAULT 'active',
            start_date INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_programs_status ON programs(status);
          CREATE UNIQUE INDEX IF NOT EXISTS idx_programs_one_active
            ON programs(status) WHERE status = 'active';

          CREATE TABLE IF NOT EXISTS routines (
            id TEXT PRIMARY KEY,
            program_id TEXT NOT NULL REFERENCES programs(id),
            name TEXT NOT NULL,
            day_order INTEGER NOT NULL DEFAULT 0,
            notes TEXT,
            created_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_routines_program ON routines(program_id);

          CREATE TABLE IF NOT EXISTS routine_exercises (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            routine_id TEXT NOT NULL REFERENCES routines(id),
            exercise_id TEXT NOT NULL REFERENCES exercises(id),
            exercise_order INTEGER NOT NULL DEFAULT 0,
            target_sets INTEGER,
            target_reps TEXT,
            target_weight_lbs REAL,
            target_rpe REAL,
            notes TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_re_routine ON routine_exercises(routine_id);

          CREATE TABLE IF NOT EXISTS workouts (
            id TEXT PRIMARY KEY,
            routine_id TEXT REFERENCES routines(id),
            name TEXT,
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            is_deload INTEGER NOT NULL DEFAULT 0,
            notes TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_workouts_started ON workouts(started_at DESC);
          CREATE INDEX IF NOT EXISTS idx_workouts_routine ON workouts(routine_id);

          CREATE TABLE IF NOT EXISTS sets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            workout_id TEXT NOT NULL REFERENCES workouts(id),
            exercise_id TEXT NOT NULL REFERENCES exercises(id),
            set_index INTEGER NOT NULL,
            weight_lbs REAL,
            reps INTEGER NOT NULL,
            rpe REAL,
            is_warmup INTEGER NOT NULL DEFAULT 0,
            notes TEXT,
            logged_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_sets_workout ON sets(workout_id, set_index);
          CREATE INDEX IF NOT EXISTS idx_sets_exercise_date ON sets(exercise_id, logged_at DESC);

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
    { version: 2, up: (sql) => ensureRelayRateSchema(sql) },
    { version: 3, up: (sql) => ensureUsageSchema(sql) },
    {
      // v4: profile (singleton free-text doc) + gym_equipment (structured).
      version: 4,
      up: (sql) => {
        sql.exec(`
          CREATE TABLE IF NOT EXISTS profile (
            id TEXT PRIMARY KEY,
            bio TEXT,
            goals TEXT,
            preferences TEXT,
            health_notes TEXT,
            updated_at INTEGER NOT NULL
          );

          CREATE TABLE IF NOT EXISTS gym_equipment (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            display_name TEXT NOT NULL,
            category TEXT,
            details TEXT,
            notes TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_gym_equipment_category ON gym_equipment(category);
        `);
      },
    },
    {
      // v5: key-value settings for the proactive layer (training hiatus,
      // inactivity-nudge bookkeeping).
      version: 5,
      up: (sql) => {
        sql.exec(`
          CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL
          );
        `);
      },
    },
  ],
};
