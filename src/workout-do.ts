import type { Env } from './env';
import type { Interaction } from './discord/types';
import { AgentDOBase } from './runtime/agent-do-base';
import { WORKOUT_SPEC } from './workout/spec';
import {
  buildWorkoutStats,
  type WorkoutRow,
  type SetRow,
  type ExerciseRow,
} from './workout/loop';

/**
 * WorkoutDO holds home-gym training state. Universal endpoints live in
 * `AgentDOBase`; workout-only concerns here are slash-command dispatch and a
 * richer /dump payload.
 */
export class WorkoutDO extends AgentDOBase<Env> {
  protected readonly spec = WORKOUT_SPEC;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ensureSchema();
  }

  protected async dispatchCommand(interaction: Interaction): Promise<void> {
    const commandName = interaction.data?.name ?? '';
    const optionMap = Object.fromEntries(
      (interaction.data?.options ?? []).map((o) => [o.name, o.value]),
    );

    if (commandName === 'workout' && optionMap.message) {
      const message = String(optionMap.message);
      await this.dispatchChatInteraction(interaction, message, `workout: ${message}`);
      return;
    }

    await this.discord.editOriginal(
      interaction.token,
      `Unknown workout command: \`${commandName}\``,
    );
  }

  protected async customDump(): Promise<Record<string, unknown>> {
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
    return {
      stats,
      recent_workouts: recentWorkouts,
      recent_sets: recentSets,
      exercises,
      programs,
      routines,
      routine_exercises: routineExercises,
      recent_conversation: recentConv,
    };
  }
}
