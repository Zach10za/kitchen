import type { Env } from './env';
import type { Interaction } from './discord/types';
import { AgentDOBase } from './runtime/agent-do-base';
import { dispatchChat } from './runtime/bot-registry';
import { captureError } from './error-triage';
import { nextDailyTime } from './util/datetime';
import { WORKOUT_SPEC } from './workout/spec';
import {
  buildWorkoutStats,
  loadHiatus,
  clearHiatus,
  getSetting,
  setSetting,
  SETTING_LAST_NUDGE_AT,
  type WorkoutRow,
  type SetRow,
  type ExerciseRow,
} from './workout/loop';

/** Nudge when the training gap reaches this many days… */
const NUDGE_AFTER_DAYS = 3;
/** …but not more often than this. */
const NUDGE_MIN_GAP_DAYS = 3;
/** Past this gap, assume life happened and go quiet — nagging a 3-week-cold
 *  channel trains the user to mute it. The bot re-engages when they return
 *  (or records a hiatus, which handles long breaks properly). */
const NUDGE_QUIET_AFTER_DAYS = 21;

const DAY_MS = 86_400_000;

/**
 * WorkoutDO holds home-gym training state. Universal endpoints live in
 * `AgentDOBase`; workout-only concerns here are slash-command dispatch, a
 * richer /dump, and the proactive daily check-in alarm:
 *
 *  - During a recorded hiatus: silent. The morning after it ends: one
 *    welcome-back check-in with a ramp-back plan.
 *  - Mondays: weekly recap (volume, PRs, what's lagging) if there was any
 *    training in the last 14 days.
 *  - Other days: a "been N days" nudge when the gap is 3–21 days, at most
 *    every 3 days. Silence is the default.
 */
export class WorkoutDO extends AgentDOBase<Env> {
  protected getSpec() { return WORKOUT_SPEC; }

  protected async onHeartbeat(): Promise<void> {
    await this.ensureAlarmSet();
  }

  protected async onReset(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.armNextCheckin();
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
    const alarm = await this.ctx.storage.getAlarm();
    const hiatus = loadHiatus(this.sql);
    const sessionPlans = this.sql
      .exec('SELECT * FROM session_plans ORDER BY created_at DESC LIMIT 10')
      .toArray();
    const niggles = this.sql.exec('SELECT * FROM niggles ORDER BY opened_at DESC LIMIT 20').toArray();
    return {
      alarm_at: alarm,
      alarm_iso: alarm ? new Date(alarm).toISOString() : null,
      hiatus: hiatus
        ? { until_iso: new Date(hiatus.until).toISOString(), note: hiatus.note }
        : null,
      session_plans: sessionPlans,
      niggles,
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

  // ─── Proactive surface ─────────────────────────────────────────────────

  async alarm(): Promise<void> {
    try {
      await this.runDailyCheckin();
    } catch (err) {
      // Don't let a thrown alarm cancel the next one — captureError + rearm.
      console.error('workout alarm failed', err);
      await captureError(this.env, err, { source: 'workout:alarm' });
    } finally {
      await this.armNextCheckin();
    }
  }

  private async runDailyCheckin(): Promise<void> {
    const now = Date.now();
    const hiatus = loadHiatus(this.sql);

    if (hiatus) {
      if (now < hiatus.until) return; // on break — stay quiet
      // Break just ended: clear it BEFORE the network call so a Discord
      // outage can't replay the welcome-back every day.
      clearHiatus(this.sql);
      await this.sendChat(
        `The user's training break just ended${hiatus.note ? ` (it was for: ${hiatus.note})` : ''}. Welcome them back briefly and propose a concrete first session back: pick from the active program (or their most-trained lifts), at roughly 10-20% reduced weight and volume, scaled to how long they were out and the break reason. Ask how they're feeling, but lead with the plan. A few lines, not a lecture.`,
      );
      return;
    }

    const stats = buildWorkoutStats(this.sql);
    if (!stats.lastWorkout) return; // never trained — nothing to nudge about

    const gapDays = Math.floor((now - stats.lastWorkout.started_at) / DAY_MS);
    const weekday = new Date().toLocaleDateString('en-US', {
      timeZone: this.env.TIMEZONE,
      weekday: 'short',
    });

    if (weekday === 'Mon') {
      // Weekly recap, but only while training is actually happening.
      if (gapDays > 14) return;
      await this.sendChat(
        "It's the Monday training recap. Call lift_trends first, then summarize last week from the logged data: sessions, working sets and tonnage vs the week before, any new PRs, which muscle groups are lagging over the last 2 weeks, and each main lift's trend — flag any plateau WITH a concrete prescription (deload, rep-range switch, volume bump), never just 'you plateaued'. If an active niggle has been open 2+ weeks, ask whether it's cleared. Close with the plan for this week. Terse, numbers first.",
      );
      return;
    }

    if (gapDays < NUDGE_AFTER_DAYS || gapDays > NUDGE_QUIET_AFTER_DAYS) return;
    const lastNudgeAt = Number(getSetting(this.sql, SETTING_LAST_NUDGE_AT) ?? 0);
    if (now - lastNudgeAt < NUDGE_MIN_GAP_DAYS * DAY_MS) return;

    // Stamp BEFORE the network call so a Discord outage can't double-nudge.
    setSetting(this.sql, SETTING_LAST_NUDGE_AT, String(now));
    await this.sendChat(
      `It's been ${gapDays} days since the user's last logged session. Generate today's session for them per SESSION GENERATION (history, lagging volume, active niggles, equipment), save it with plan_session, and present the SESSION CARD — lead with one inviting line, not a guilt trip. Remind them they can just say "done" afterward, and that if they're actually on a break they can say so (set_hiatus) and you'll stop nudging.`,
    );
  }

  private async sendChat(prompt: string): Promise<void> {
    await dispatchChat(
      this.env,
      'workout',
      prompt,
      this.env.DISCORD_WORKOUT_CHANNEL_ID,
      { column: 'thread_id', value: this.env.DISCORD_WORKOUT_CHANNEL_ID },
    );
  }

  async ensureAlarmSet(): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null) {
      await this.armNextCheckin();
    }
  }

  private async armNextCheckin(): Promise<void> {
    const hour = Number(this.env.WORKOUT_CHECKIN_HOUR_LOCAL) || 9;
    const next = nextDailyTime(hour, this.env.TIMEZONE);
    await this.ctx.storage.setAlarm(next.getTime());
  }
}
