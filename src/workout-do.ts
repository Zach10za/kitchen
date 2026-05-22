import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';
import type { Interaction, MessagePayload } from './discord/types';
import { DiscordAPI } from './discord/api';
import { prepareInteractionThread } from './discord/thread';
import { captureError } from './error-triage';
import { runMigrations, type Migration } from './runtime/migrations';
import {
  checkRelayRateLimit as checkRelayRate,
  ensureRelayRateSchema,
} from './runtime/relay-rate-limit';
import {
  ensureUsageSchema,
  recordUsage,
  sumUsageByThread,
  sumUsageSince,
  countTurnsByThread,
} from './runtime/usage';
import { buildWorkoutSystemPrompt } from './workout/prompts';
import {
  executeWorkoutTool,
  buildWorkoutStats,
  recentSetsForExercise,
  topPRs,
  weeklyVolume,
  fullWorkout,
  type WorkoutRow,
  type SetRow,
  type ExerciseRow,
} from './workout/loop';
import {
  workoutSummaryEmbed,
  workoutLastEmbed,
  workoutPRsEmbed,
  workoutWeekEmbed,
  workoutProgramEmbed,
} from './workout/render';

const CONVERSATION_PRUNE_KEEP = 400;
const CONVERSATION_PRUNE_INTERVAL_MS = 24 * 3600 * 1000;

/**
 * WorkoutDO holds all home-gym training state: exercises catalog, programs,
 * routines, completed workouts, individual sets, and conversation history.
 * Shape mirrors FinanceDO + TasksDO — SQLite schema with conversation +
 * relay-rate + usage helpers shared across bots.
 */
export class WorkoutDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private discord: DiscordAPI;
  private lastConversationPruneAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.discord = new DiscordAPI(env.DISCORD_BOT_TOKEN, env.DISCORD_APP_ID);
    runMigrations(this.sql, WorkoutDO.MIGRATIONS);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/interaction') {
      const interaction = (await request.json()) as Interaction;
      this.ctx.waitUntil(
        this.handleInteraction(interaction).catch(async (err) => {
          console.error('workout handleInteraction failed', err);
          await captureError(this.env, err, {
            source: `workout-interaction:${interaction.data?.name ?? 'unknown'}`,
            tags: {
              interaction_type: interaction.type,
              channel_id: interaction.channel_id,
              guild_id: interaction.guild_id,
            },
          });
          await this.discord
            .editOriginal(interaction.token, `Something broke: ${(err as Error).message}`)
            .catch(() => {});
        })
      );
      return new Response('queued');
    }

    if (url.pathname === '/heartbeat') {
      this.maybePruneConversation();
      return new Response('ok');
    }

    if (url.pathname === '/relay-allowed' && request.method === 'POST') {
      const body = (await request.json()) as { channelId: string };
      if (!body.channelId) return Response.json({ allowed: false, reason: 'missing channelId' }, { status: 400 });
      const limit = Number(this.env.RELAY_RATE_LIMIT_PER_HOUR ?? '') || undefined;
      const decision = checkRelayRate(this.sql, body.channelId, limit);
      return Response.json(decision, { status: decision.allowed ? 200 : 429 });
    }

    if (url.pathname === '/fast-read') {
      const interaction = (await request.json()) as Interaction;
      const payload = this.handleFastRead(interaction);
      return Response.json(payload);
    }

    if (url.pathname === '/reset' && request.method === 'POST') {
      this.sql.exec('DELETE FROM sets');
      this.sql.exec('DELETE FROM workouts');
      this.sql.exec('DELETE FROM routine_exercises');
      this.sql.exec('DELETE FROM routines');
      this.sql.exec('DELETE FROM programs');
      this.sql.exec('DELETE FROM exercises');
      this.sql.exec('DELETE FROM conversation');
      return Response.json({
        status: 'ok',
        cleared: ['sets', 'workouts', 'routine_exercises', 'routines', 'programs', 'exercises', 'conversation'],
      });
    }

    // ─── WorkoutSteerWorkflow IO ──────────────────────────────────────

    if (url.pathname === '/workflow/workout/load-context') {
      const threadId = url.searchParams.get('thread_id');
      const systemPrompt = buildWorkoutSystemPrompt(this.sql, this.env.TIMEZONE);
      const history = threadId
        ? this.sql
            .exec<{ role: string; content: string }>(
              "SELECT role, content FROM conversation WHERE thread_id = ? AND role IN ('user', 'assistant') ORDER BY id DESC LIMIT 30",
              threadId
            )
            .toArray()
            .reverse()
        : this.sql
            .exec<{ role: string; content: string }>(
              "SELECT role, content FROM conversation WHERE thread_id IS NULL AND role IN ('user', 'assistant') ORDER BY id DESC LIMIT 30"
            )
            .toArray()
            .reverse();
      return Response.json({ systemPrompt, history });
    }

    if (url.pathname === '/workflow/workout/save-turn' && request.method === 'POST') {
      const body = (await request.json()) as {
        role: string;
        content: string;
        tool_call_json?: string;
        thread_id?: string;
      };
      this.sql.exec(
        'INSERT INTO conversation (role, content, tool_call_json, thread_id, ts) VALUES (?, ?, ?, ?, ?)',
        body.role, body.content, body.tool_call_json ?? null, body.thread_id ?? null, Date.now()
      );
      return Response.json({ ok: true });
    }

    if (url.pathname === '/workflow/workout/record-usage' && request.method === 'POST') {
      const body = (await request.json()) as Parameters<typeof recordUsage>[1];
      const totals = recordUsage(this.sql, body);
      return Response.json({ thread_total_usage: totals });
    }

    if (url.pathname === '/workflow/workout/cost-summary') {
      const threadId = url.searchParams.get('thread_id');
      const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days') ?? 30)));
      const sinceMs = Date.now() - days * 86_400_000;
      const totals = threadId ? sumUsageByThread(this.sql, threadId) : sumUsageSince(this.sql, sinceMs);
      const turnCount = threadId
        ? countTurnsByThread(this.sql, threadId)
        : this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM usage WHERE ts >= ?', sinceMs).toArray()[0]?.n ?? 0;
      return Response.json({ usage: totals, turn_count: turnCount, days, thread_id: threadId });
    }

    if (url.pathname === '/workflow/workout/exec-tool' && request.method === 'POST') {
      const body = (await request.json()) as { name: string; args: any };
      const result = executeWorkoutTool(body.name, body.args, { sql: this.sql });
      return new Response(result, { headers: { 'content-type': 'text/plain' } });
    }

    if (url.pathname === '/dump') {
      const stats = buildWorkoutStats(this.sql);
      const recentWorkouts = this.sql
        .exec<WorkoutRow>('SELECT * FROM workouts ORDER BY started_at DESC LIMIT 10')
        .toArray();
      const recentSets = this.sql
        .exec<SetRow>('SELECT * FROM sets ORDER BY logged_at DESC LIMIT 30')
        .toArray();
      const exercises = this.sql.exec<ExerciseRow>('SELECT * FROM exercises ORDER BY name').toArray();
      const programs = this.sql.exec('SELECT * FROM programs ORDER BY status, name').toArray();
      const routines = this.sql.exec('SELECT * FROM routines ORDER BY program_id, day_order').toArray();
      const routineExercises = this.sql
        .exec('SELECT * FROM routine_exercises ORDER BY routine_id, exercise_order')
        .toArray();
      const recentConv = this.sql
        .exec('SELECT id, role, ts, substr(content, 1, 200) AS preview FROM conversation ORDER BY id DESC LIMIT 30')
        .toArray();
      return new Response(
        JSON.stringify(
          {
            now: Date.now(),
            stats,
            recent_workouts: recentWorkouts,
            recent_sets: recentSets,
            exercises,
            programs,
            routines,
            routine_exercises: routineExercises,
            recent_conversation: recentConv,
          },
          null,
          2
        ),
        { headers: { 'content-type': 'application/json' } }
      );
    }

    return new Response('not found', { status: 404 });
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    const commandName = interaction.data?.name ?? '';
    const optionMap = Object.fromEntries(
      (interaction.data?.options ?? []).map((o) => [o.name, o.value])
    );

    if (commandName === 'workout' && optionMap.message) {
      const message = String(optionMap.message);
      const replyChannelId = await this.openReplyThread(interaction, `workout: ${message}`);
      await this.env.WORKOUT_STEER_WORKFLOW.create({
        params: { userMessage: message, replyChannelId },
      });
      return;
    }

    await this.discord.editOriginal(
      interaction.token,
      `Unknown workout command: \`${commandName}\``
    );
  }

  private handleFastRead(interaction: Interaction): MessagePayload {
    const cmd = interaction.data?.name ?? '';
    const optionMap = Object.fromEntries(
      (interaction.data?.options ?? []).map((o) => [o.name, o.value])
    );

    if (cmd === 'workout') {
      const stats = buildWorkoutStats(this.sql);
      return { embeds: [workoutSummaryEmbed(stats)] };
    }

    if (cmd === 'workout-last') {
      const last = this.sql
        .exec<WorkoutRow>('SELECT * FROM workouts ORDER BY started_at DESC LIMIT 1')
        .toArray()[0];
      if (!last) return { content: 'No workouts logged yet. Use `/workout message: ...` to log one.' };
      const full = fullWorkout(this.sql, last.id);
      return { embeds: [workoutLastEmbed(full)] };
    }

    if (cmd === 'workout-prs') {
      const exerciseName = optionMap.exercise ? String(optionMap.exercise) : null;
      const prs = topPRs(this.sql, exerciseName);
      return { embeds: [workoutPRsEmbed(prs, exerciseName)] };
    }

    if (cmd === 'workout-week') {
      const days = Number(optionMap.days ?? 7);
      const safeDays = Math.max(1, Math.min(90, days));
      const volume = weeklyVolume(this.sql, safeDays);
      return { embeds: [workoutWeekEmbed(volume, safeDays)] };
    }

    if (cmd === 'workout-program') {
      const active = this.sql
        .exec<{ id: string; name: string; description: string | null }>(
          "SELECT id, name, description FROM programs WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1"
        )
        .toArray()[0];
      if (!active) {
        return {
          content: 'No active program. Use `/workout message: set up a 5/3/1 program` (or whatever split you want) to create one.',
        };
      }
      const routines = this.sql
        .exec<{ id: string; name: string; day_order: number; notes: string | null }>(
          'SELECT id, name, day_order, notes FROM routines WHERE program_id = ? ORDER BY day_order ASC, name ASC',
          active.id
        )
        .toArray();
      const routinesWithExercises = routines.map((r) => ({
        ...r,
        exercises: this.sql
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
            r.id
          )
          .toArray(),
      }));
      return { embeds: [workoutProgramEmbed(active, routinesWithExercises)] };
    }

    return { content: `Unknown fast-read workout command: ${cmd}` };
  }

  private async openReplyThread(interaction: Interaction, titleSeed: string): Promise<string> {
    return prepareInteractionThread({
      discord: this.discord,
      env: this.env,
      interactionToken: interaction.token,
      titleSeed,
    });
  }

  private maybePruneConversation(): void {
    const now = Date.now();
    if (now - this.lastConversationPruneAt < CONVERSATION_PRUNE_INTERVAL_MS) return;
    this.lastConversationPruneAt = now;
    this.sql.exec(
      `DELETE FROM conversation
        WHERE id NOT IN (SELECT id FROM conversation ORDER BY id DESC LIMIT ?)`,
      CONVERSATION_PRUNE_KEEP
    );
  }

  /**
   * Schema migrations. Append-only — never mutate or remove existing entries.
   * Independent of other DOs' schema_version (each DO gets its own SQLite db).
   */
  private static readonly MIGRATIONS: readonly Migration[] = [
    {
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
    {
      version: 2,
      up: (sql) => ensureRelayRateSchema(sql),
    },
    {
      version: 3,
      up: (sql) => ensureUsageSchema(sql),
    },
  ];
}
