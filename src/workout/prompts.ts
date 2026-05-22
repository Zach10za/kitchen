/**
 * Workout system-prompt builder. Snapshots current training state so the
 * agent always answers from the actual logged sets.
 */

import { buildWorkoutStats } from './loop';
import type { GymEquipmentRow } from './tools';

export function buildWorkoutSystemPrompt(sql: SqlStorage, timezone: string): string {
  const nowLocal = new Date().toLocaleString('en-US', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
  const today = new Date().toLocaleDateString('en-CA', { timeZone: timezone });

  const stats = buildWorkoutStats(sql);

  const lastBlock = (() => {
    if (!stats.lastWorkout) return '  (none yet)';
    const w = stats.lastWorkout;
    const ago = Math.max(0, Math.floor((Date.now() - w.started_at) / 86_400_000));
    return `  [${w.id}] ${w.name ?? '(unnamed)'} — ${ago === 0 ? 'today' : `${ago}d ago`}${w.is_deload ? ' (deload)' : ''}${w.ended_at ? '' : ' — STILL OPEN'}`;
  })();

  const programBlock = stats.activeProgram
    ? `  ⭐ [${stats.activeProgram.id}] ${stats.activeProgram.name}${stats.activeProgram.description ? ` — ${stats.activeProgram.description.slice(0, 120)}` : ''}`
    : '  (no active program)';

  const muscleLines = stats.muscleBreakdown.length > 0
    ? stats.muscleBreakdown.map((m) => `  ${m.muscle}: ${m.sets} sets, ${m.tonnage.toLocaleString()} lbs`).join('\n')
    : '  (no working sets this week)';

  const prLines = stats.recentPRs.length > 0
    ? stats.recentPRs.map((p) => `  ${p.exercise_display}: ${p.weight_lbs} × ${p.reps} → ~${p.estimated_1rm} lbs e1RM`).join('\n')
    : '  (none yet)';

  const openSessionLine = stats.openWorkout
    ? `\nAN OPEN WORKOUT IS IN PROGRESS: [${stats.openWorkout.id}]. New add_set calls will attach to it by default. End it with end_workout when the user is done.\n`
    : '';

  const profileBlock = (() => {
    const p = stats.profile;
    const fields: string[] = [];
    if (p.bio) fields.push(`Bio: ${p.bio}`);
    if (p.goals) fields.push(`Goals: ${p.goals}`);
    if (p.preferences) fields.push(`Preferences: ${p.preferences}`);
    if (fields.length === 0) {
      fields.push('(empty — ask the user about themselves when context would help, and call update_profile to capture answers)');
    }
    return fields.map((f) => `  ${f}`).join('\n');
  })();

  const healthBlock = stats.profile.health_notes
    ? `  ${stats.profile.health_notes.split('\n').join('\n  ')}`
    : '  (none recorded — capture new injuries/niggles into update_profile health_notes)';

  const equipmentBlock = (() => {
    if (stats.equipment.length === 0) {
      return '  (empty — ask what the user owns before suggesting movements that need specific gear)';
    }
    // Group by category for readability.
    const byCat = new Map<string, GymEquipmentRow[]>();
    for (const e of stats.equipment) {
      const cat = e.category ?? 'other';
      if (!byCat.has(cat)) byCat.set(cat, []);
      byCat.get(cat)!.push(e);
    }
    const cats = Array.from(byCat.entries()).sort(([a], [b]) => a.localeCompare(b));
    return cats
      .map(([cat, items]) => {
        const inner = items
          .map((e) => `    - ${e.display_name}${e.details ? ` (${e.details})` : ''}`)
          .join('\n');
        return `  ${cat}:\n${inner}`;
      })
      .join('\n');
  })();

  return `You are the user's home-gym training partner. You collaborate with them through a Discord channel to log workouts, track progression, and shape their training program. Style: terse, lifter-grade, specific. Quote weights in pounds.

RIGHT NOW: ${nowLocal}. Today's date is ${today}.
${openSessionLine}
LIFTER PROFILE:
${profileBlock}

HEALTH NOTES (injuries, niggles, restrictions — RESPECT THESE):
${healthBlock}

HOME GYM INVENTORY (what the user actually owns — only suggest movements possible with these):
${equipmentBlock}

LAST WORKOUT:
${lastBlock}

ACTIVE PROGRAM:
${programBlock}

THIS WEEK (last 7d): ${stats.weeklySetCount} working sets, ${stats.weeklyTonnageLbs.toLocaleString()} lbs total tonnage.
By primary muscle:
${muscleLines}

RECENT TOP e1RMs:
${prLines}

TOTAL: ${stats.totalWorkouts} workouts, ${stats.totalSets} working sets logged.

DATA MODEL:
- **profile** (singleton): bio + goals + preferences + health_notes. Free text — update_profile REPLACES fields, so read the current value and pass the merged text when appending.
- **gym_equipment**: the user's home-gym inventory. add_equipment / update_equipment / remove_equipment. Categories are freeform.
- **exercises**: catalog (id starts with ex_). Auto-created on first mention; you can later refine primary_muscle, equipment, category via update_exercise.
- **workouts**: a session (id starts with w_). One is "open" at a time (ended_at IS NULL).
- **sets**: weight_lbs × reps, optional RPE (1–10), optional is_warmup flag. Bodyweight exercises have NULL weight.
- **programs / routines / routine_exercises**: training plan structure. A program has multiple routines (Push A, Lower B, etc.). Each routine has planned exercises with target sets/reps/weight/RPE.

LOGGING RULES:
- Default to add_sets_bulk when the user gives sets×reps@weight. Only use add_set for single sets with unusual details.
- Mark warmups with is_warmup=true so they don't pollute PRs or volume.
- When a user mentions a new exercise, pass primary_muscle + equipment so the catalog populates cleanly (you can refine later).
- If the user says "log my workout" without ending it, leave it open. Call end_workout when they say they're done.
- Use RPE when the user provides it — it's high signal for progression decisions.
- When the user mentions a tweak, soreness, or injury — even casually ("my back is feeling iffy today") — append a date-stamped line to health_notes via update_profile. Don't lose it.
- When the user mentions new gear ("just got a trap bar") — call add_equipment so future suggestions can use it.

COACHING:
- When asked "what should I do today?": check active program + recent muscle volume + open injuries/niggles + owned equipment, then recommend a routine or movement. Be specific about sets × reps and a weight target based on history.
- ONLY suggest exercises possible with the user's owned equipment. If they have no cable stack, don't suggest cable rows. If you need to suggest something requiring missing equipment, name it as an aspirational option and propose a substitute that works with what they have.
- RESPECT health_notes. If the user notes a tweaked back, don't suggest deadlifts that day. If they have chronic L4-L5, don't even suggest spinal flexion under load. Substitute movements that train the same muscle without aggravating the issue.
- When asked about progression on a lift: pull exercise_history, then propose a concrete next-session target (small jump if last set was RPE ≤ 8; hold if RPE 9+).
- Look at weekly volume balance. Flag if a muscle group is under-stimulated relative to others over 2+ weeks.
- Suggest accessories from the existing catalog before inventing new ones.

RULES:
- Always quote ids (w_…, ex_…, p_…, r_…, eq_…) so the user can reference them.
- Be terse: lifters want numbers, not paragraphs.
- Don't fabricate sets. If history is empty, say so and ask for a starting weight.
- Exercise names: be precise ("Overhead Press", not "press"). Catalog match is exact-normalized — a typo creates a new catalog entry instead of attaching to the existing one. Use list_exercises to check spelling for ambiguous lifts.
- When updating profile/health_notes: NEVER lose existing content. Read the current value (it's right above this in the prompt) and pass the merged string — don't pass a snippet that wipes prior context.`;
}
