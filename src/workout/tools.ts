/**
 * Workout agent tool definitions. All state mutations go through these tools;
 * the executor lives in workout/loop.ts and is called from WorkoutDO's
 * /workflow/workout/exec-tool endpoint.
 *
 * Convention: every weight is pounds (lbs). Bodyweight exercises omit weight.
 */

import { WEB_SEARCH_TOOL } from '../runtime/tavily';

export const WORKOUT_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'show_summary',
      description:
        'Get a high-level snapshot: last workout, active program, weekly volume, and a few recent PRs. Call this first when the user asks an open-ended question like "what should I do today" or "how am I progressing".',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'log_workout',
      description:
        'Start a new workout session and return its id. If the user is following a routine (push day, leg day, etc.), pass routine_id to link the session. Optionally specify started_at as ms epoch — defaults to now.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Optional name for the workout, e.g. "Push Day A".' },
          routine_id: { type: 'string', description: 'Routine this session is following (use list_programs to find).' },
          started_at: { type: 'number', description: 'ms epoch when the workout began. Defaults to now.' },
          is_deload: { type: 'boolean', description: 'Set true if this is a deload session.' },
          notes: { type: 'string', description: 'Initial notes (mood, energy, focus).' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'end_workout',
      description:
        'Mark a workout finished by setting ended_at. If id is omitted, finalizes the most recent unfinished workout. Add an optional summary in notes.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Workout id to end. Defaults to most recent open workout.' },
          notes: { type: 'string', description: 'Closing notes (how it went, soreness, etc).' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'add_set',
      description:
        'Log a single set in a workout. If workout_id is omitted, the most recent open workout is used (or a fresh one is auto-created if none is open). Exercise name is matched against the catalog by exact normalized name (case- and whitespace-insensitive); on miss the exercise is auto-created. Use precise names ("Overhead Press", not "press") to avoid creating duplicates. Pass equipment + primary_muscle on first mention to populate the catalog — on later mentions they backfill NULL fields but never overwrite existing values.',
      parameters: {
        type: 'object',
        properties: {
          exercise: { type: 'string', description: 'Exercise name, e.g. "Bench Press", "Front Squat".' },
          weight_lbs: { type: 'number', description: 'Pounds. Omit for bodyweight exercises.' },
          reps: { type: 'number', description: 'Reps completed.' },
          rpe: { type: 'number', description: 'Optional RPE (1–10). RPE 10 = max effort, RPE 7 = 3 reps in reserve.' },
          is_warmup: { type: 'boolean', description: 'True for warmup sets so they\'re excluded from PRs/volume.' },
          workout_id: { type: 'string', description: 'Workout id; omit to append to current/latest open workout.' },
          equipment: {
            type: 'string',
            enum: ['barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'kettlebell', 'band', 'other'],
            description: 'Used only when auto-creating the exercise in the catalog.',
          },
          primary_muscle: {
            type: 'string',
            description: 'Primary muscle worked, e.g. chest, quads, back, shoulders. Used when auto-creating.',
          },
          notes: { type: 'string', description: 'Set-level notes (form cue, "felt heavy", etc).' },
        },
        required: ['exercise', 'reps'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'add_sets_bulk',
      description:
        'Log many sets at once for a single exercise. Use this when the user says "3x5 squat at 225" — pass sets=3, reps=5, weight_lbs=225. All sets attach to the same workout (current/latest if omitted). Max 30 sets per call. Exercise resolution and catalog backfill behave the same as add_set.',
      parameters: {
        type: 'object',
        properties: {
          exercise: { type: 'string', description: 'Exercise name.' },
          sets: { type: 'number', description: 'Number of sets to record (each gets the same weight + reps).' },
          reps: { type: 'number', description: 'Reps per set.' },
          weight_lbs: { type: 'number', description: 'Weight per set. Omit for bodyweight.' },
          rpe: { type: 'number', description: 'Optional RPE applied to every set.' },
          is_warmup: { type: 'boolean', description: 'True for warmup sets.' },
          workout_id: { type: 'string', description: 'Workout id; defaults to current/latest open.' },
          equipment: { type: 'string', description: 'Used when auto-creating the exercise.' },
          primary_muscle: { type: 'string', description: 'Used when auto-creating the exercise.' },
        },
        required: ['exercise', 'sets', 'reps'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'exercise_history',
      description:
        'Get the last N sessions for an exercise: weight × reps × RPE for each set, grouped by workout date. Use when the user asks "how\'s my bench been" or wants to pick next session\'s weight.',
      parameters: {
        type: 'object',
        properties: {
          exercise: { type: 'string', description: 'Exercise name (matched by exact normalized name — case- and whitespace-insensitive). Use the same precise name you used when logging.' },
          sessions: { type: 'number', description: 'How many recent workouts to include. Default 5.' },
        },
        required: ['exercise'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'find_prs',
      description:
        'Show personal records. With exercise: top set per strict rep count (1RM, 3RM, 5RM, 8RM, 10RM, 15RM — only exact rep counts are recognized) plus estimated 1RM using Epley. Without exercise: best estimated-1RM across every exercise the user has logged. Warmups + bodyweight sets excluded. Exercise name matched by exact normalized name.',
      parameters: {
        type: 'object',
        properties: {
          exercise: { type: 'string', description: 'Optional exercise name. Omit for top PRs across all exercises.' },
          limit: { type: 'number', description: 'Limit for top-PRs mode. Default 10.' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'weekly_volume',
      description:
        'Sets, reps × weight (tonnage) per muscle group AND top exercises by set count over the last N days. Use to assess balance ("am I doing enough back work?") or spot which lifts dominate volume.',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'Window in days. Default 7.' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_workouts',
      description: 'Recent workouts (id, date, name, set count, total tonnage, status open/done, deload flag). Use to find an id to reference or check whether a session is still open.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'How many workouts. Default 10.' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_workout',
      description: 'Full details of one workout — every set grouped by exercise (each exercise appears in the order it was first logged), with sets within an exercise ordered by set_index.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Workout id (starts with w_).' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_exercises',
      description: 'List the exercise catalog with primary muscle + equipment. Use before suggesting an accessory to check what the user already does.',
      parameters: {
        type: 'object',
        properties: {
          muscle: { type: 'string', description: 'Filter by primary muscle (chest, quads, back, etc).' },
          equipment: { type: 'string', description: 'Filter by equipment.' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_exercise',
      description: 'Update an exercise catalog entry: fix display_name, set primary_muscle, equipment, or notes. Use when the user clarifies categorization.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Exercise id (starts with ex_).' },
          display_name: { type: 'string' },
          primary_muscle: { type: 'string' },
          equipment: { type: 'string' },
          category: { type: 'string', description: 'Movement pattern: push, pull, hinge, squat, carry, core, accessory.' },
          notes: { type: 'string' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'create_program',
      description:
        'Create a new training program (e.g. "5/3/1 Main", "PPL 6-day"). Programs hold routines (training days). Set status=active to make it the user\'s current plan — only one program is active at a time; creating an active one demotes the previous active program to paused.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Program name.' },
          description: { type: 'string', description: 'How the program is structured.' },
          status: {
            type: 'string',
            enum: ['active', 'paused', 'archived'],
            description: 'Default paused. Use active to mark as current.',
          },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'add_routine',
      description: 'Add a training day to a program (e.g. "Push A", "Lower B"). day_order controls ordering within the week.',
      parameters: {
        type: 'object',
        properties: {
          program_id: { type: 'string', description: 'Program id (starts with p_).' },
          name: { type: 'string', description: 'Routine name.' },
          day_order: { type: 'number', description: 'Integer used to sort routines within the program (lower first). Not bound to a calendar week.' },
          notes: { type: 'string', description: 'Day-level notes.' },
        },
        required: ['program_id', 'name'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'add_routine_exercise',
      description:
        'Add a planned exercise to a routine, with target sets/reps/weight/RPE. target_reps is freeform: "5", "8-12", "AMRAP at RPE 8".',
      parameters: {
        type: 'object',
        properties: {
          routine_id: { type: 'string', description: 'Routine id (starts with r_).' },
          exercise: { type: 'string', description: 'Exercise name (auto-creates if new).' },
          target_sets: { type: 'number' },
          target_reps: { type: 'string', description: '"5", "8-12", "AMRAP", etc.' },
          target_weight_lbs: { type: 'number' },
          target_rpe: { type: 'number' },
          exercise_order: { type: 'number', description: 'Position in the routine. Default 0.' },
          notes: { type: 'string' },
        },
        required: ['routine_id', 'exercise'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_programs',
      description: 'List all programs with their routines. Use to find an id to reference or to show the user what programs they have set up.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_program',
      description: 'Full program structure: every routine, every planned exercise with targets.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Program id.' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'set_active_program',
      description: 'Mark a program as active (and demote any currently active program to paused). Omit id (or pass null) to clear the active program entirely.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Program id to activate. Omit to clear the active program.' },
        },
      },
    },
  },
  // ─── Profile / gym equipment / injuries ─────────────────────────────
  {
    type: 'function' as const,
    function: {
      name: 'get_profile',
      description: 'Read the current lifter profile (bio, goals, preferences) plus owned equipment and active injuries. Use when you need the full context (the prompt already includes a snapshot, but this returns the canonical values).',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_profile',
      description: 'Update lifter profile. Each field is independently optional and REPLACES the existing value when provided — to add a new note, read the current value (from the prompt header or get_profile) and pass the merged text. Pass empty string to clear a field.\n\nhealth_notes is the catch-all for injuries, niggles, and recent tweaks. Append things like "tweaked right knee 2026-05-21 — avoid bilateral squats until pain-free" rather than spinning up structured records; keep older items chronologically with a date stamp so you can see what\'s active.',
      parameters: {
        type: 'object',
        properties: {
          bio: { type: 'string', description: 'Free-form bio: age, bodyweight, training years, background.' },
          goals: { type: 'string', description: 'What the user is training for: strength, hypertrophy, performance, longevity, etc.' },
          preferences: { type: 'string', description: 'Schedule, frequency, training style preferences, dislikes.' },
          health_notes: { type: 'string', description: 'Injuries, niggles, movement restrictions. Date-stamp new entries; keep historic ones so the agent can see trends.' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'add_equipment',
      description: 'Add a piece of equipment the user owns. Name must be unique (case-insensitive). Category is freeform — useful values: "barbell", "plates", "dumbbells", "rack", "bench", "machine", "cable", "kettlebell", "band", "cardio", "accessory". Use details for capacity ("315 lb in plates", "adjustable 5–100 lb"). This is the user\'s home-gym inventory — use it to constrain exercise suggestions.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Equipment name, e.g. "Barbell", "Adjustable Dumbbells", "Power Rack".' },
          category: { type: 'string', description: 'Optional category for grouping.' },
          details: { type: 'string', description: 'Capacity / specs, e.g. "olympic 45lb", "5-100lb adjustable", "315lb in plates".' },
          notes: { type: 'string', description: 'Optional notes (brand, condition, etc).' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_equipment',
      description: 'Update an existing equipment entry. Use to fix categorization, update capacity ("now 365 lb in plates"), or rename.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Equipment id (starts with eq_).' },
          name: { type: 'string', description: 'New name (must remain unique).' },
          category: { type: 'string' },
          details: { type: 'string' },
          notes: { type: 'string' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'remove_equipment',
      description: 'Hard-delete a piece of equipment from the inventory. Use when the user sold/got rid of something.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Equipment id (starts with eq_).' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_equipment',
      description: 'List all owned equipment, optionally filtered by category. Returns name, category, details, notes per item.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Optional category filter.' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'set_hiatus',
      description: 'Record a training break (injury, travel, illness, life). Suppresses all proactive check-ins/nudges until the end date, then triggers a welcome-back check-in. Call this whenever the user says they\'ll be off training for a while ("can\'t work out for the next few weeks", "out until July"). If the end is vague ("a few weeks"), pick a reasonable date and say which you picked.',
      parameters: {
        type: 'object',
        properties: {
          until_date: { type: 'string', description: 'Last day of the break, YYYY-MM-DD (user-local). Check-ins resume the morning after.' },
          note: { type: 'string', description: 'Optional reason ("shoulder surgery recovery", "travel") — used to shape the comeback plan.' },
        },
        required: ['until_date'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'clear_hiatus',
      description: 'End a recorded training break early — the user is back before the date they originally said. Re-enables proactive check-ins.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'plan_session',
      description: "Save today's prescribed session (the SESSION CARD you composed from their history). ALWAYS call this after generating a workout for the user — it's what lets them later say just \"done\" to log the whole thing. Replaces any other still-planned session. Use concrete integer reps (not ranges) so as-written logging is unambiguous; for an AMRAP final set, prescribe the floor and note AMRAP in why.",
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD the session is for. Omit for today.' },
          title: { type: 'string', description: 'Short session name, e.g. "Push — heavy bench focus".' },
          focus: { type: 'string', description: 'The coach blurb: why this session today, how it connects to last time, what it builds toward. 2-3 sentences.' },
          exercises: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                exercise: { type: 'string', description: 'Exercise name (catalog-matched; auto-created if new).' },
                sets: { type: 'integer', description: 'Working sets.' },
                reps: { type: 'integer', description: 'Target reps per set — concrete integer.' },
                weight_lbs: { type: 'number', description: 'Target weight. Omit for bodyweight.' },
                rpe_target: { type: 'number', description: 'Target RPE if relevant.' },
                why: { type: 'string', description: 'One-line rationale or cue ("RPE 7 last week → +5 lb", "elbows ~45°").' },
                is_new: { type: 'boolean', description: 'True if this movement is new/rotated-in for freshness.' },
                equipment: { type: 'string', description: 'barbell/dumbbell/machine/cable/bodyweight/kettlebell/band/other — helps catalog + plate math.' },
                primary_muscle: { type: 'string', description: 'Primary muscle, lowercase.' },
              },
              required: ['exercise', 'sets', 'reps'],
            },
          },
        },
        required: ['title', 'focus', 'exercises'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'log_planned_session',
      description: 'Log the planned session as performed — the "done" path. With no adjustments, every exercise is logged exactly as prescribed. Pass adjustments only for what deviated (different weight, per-set reps like [5,5,4], extra/fewer sets, or skipped). Creates the workout, runs PR detection, and marks the plan done. Returns debrief stats.',
      parameters: {
        type: 'object',
        properties: {
          plan_id: { type: 'string', description: 'Specific plan (sp_…). Omit for the current open plan.' },
          adjustments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                exercise: { type: 'string', description: 'Which planned exercise this adjusts.' },
                weight_lbs: { type: 'number', description: 'Actual weight if it differed.' },
                reps_per_set: { type: 'array', items: { type: 'integer' }, description: 'Actual reps per set, e.g. [5,5,4]. Overrides sets count too.' },
                sets: { type: 'integer', description: 'Actual set count if it differed (same reps each).' },
                rpe: { type: 'number', description: 'RPE of the toughest set.' },
                skipped: { type: 'boolean', description: 'True if they skipped this exercise.' },
              },
              required: ['exercise'],
            },
          },
          notes: { type: 'string', description: 'Session notes ("felt strong", "cut short").' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'loadout',
      description: 'Deterministic barbell math: per-side plate breakdown for a target weight plus a warm-up ladder (each rung with its own plates). Use when presenting any barbell work weight so the numbers are exact — never do plate arithmetic yourself.',
      parameters: {
        type: 'object',
        properties: {
          work_weight_lbs: { type: 'number', description: 'The working weight including the bar.' },
          bar_weight_lbs: { type: 'number', description: 'Bar weight. Default 45.' },
          warmup: { type: 'boolean', description: 'Include the warm-up ladder. Default true.' },
        },
        required: ['work_weight_lbs'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'lift_trends',
      description: "Estimated-1RM trend per lift over recent weeks: weekly best e1RM series, net change, and a plateau flag (no improvement in 4+ weeks despite regular training). Without an exercise, covers the most-trained lifts. Use for the weekly recap and any 'how's my bench coming along?' question.",
      parameters: {
        type: 'object',
        properties: {
          exercise: { type: 'string', description: 'One exercise. Omit for the top trained lifts.' },
          weeks: { type: 'integer', description: 'Lookback window in weeks. Default 12.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'log_niggle',
      description: 'Record an active niggle/injury as a first-class item: the area, what aggravates it, what to avoid. Call when the user mentions ANY pain/tweak/click ("knee was clicking on squats") — even casually. Sessions you generate must work around active niggles. Use update_profile health_notes only for chronic/structural conditions, not transient niggles.',
      parameters: {
        type: 'object',
        properties: {
          area: { type: 'string', description: 'Body area, e.g. "right shoulder", "lower back".' },
          note: { type: 'string', description: 'What happened / what aggravates it.' },
          avoid: { type: 'string', description: 'Movements/patterns to avoid while active, e.g. "overhead pressing, dips".' },
        },
        required: ['area'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'resolve_niggle',
      description: 'Mark a niggle as healed/cleared so it stops constraining session generation. Match by id (n_…) or area.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Niggle id (n_…).' },
          area: { type: 'string', description: 'Or the body area, if unambiguous.' },
        },
        required: [],
      },
    },
  },
  // Shared Tavily-backed search (executed centrally in AgentDOBase). Use it to
  // ground training advice in reputable sources (returns facts only, no links).
  WEB_SEARCH_TOOL,
] as const;

// ─── TypeScript Row Types ─────────────────────────────────────────────

export type Equipment = 'barbell' | 'dumbbell' | 'machine' | 'cable' | 'bodyweight' | 'kettlebell' | 'band' | 'other';

export interface ExerciseRow {
  id: string;
  name: string;
  display_name: string;
  category: string | null;
  primary_muscle: string | null;
  equipment: Equipment | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
  [key: string]: SqlStorageValue;
}

export interface WorkoutRow {
  id: string;
  routine_id: string | null;
  name: string | null;
  started_at: number;
  ended_at: number | null;
  is_deload: 0 | 1;
  notes: string | null;
  created_at: number;
  updated_at: number;
  [key: string]: SqlStorageValue;
}

export interface SetRow {
  id: number;
  workout_id: string;
  exercise_id: string;
  set_index: number;
  weight_lbs: number | null;
  reps: number;
  rpe: number | null;
  is_warmup: 0 | 1;
  notes: string | null;
  logged_at: number;
  [key: string]: SqlStorageValue;
}

export interface ProgramRow {
  id: string;
  name: string;
  description: string | null;
  status: 'active' | 'paused' | 'archived';
  start_date: number | null;
  created_at: number;
  updated_at: number;
  [key: string]: SqlStorageValue;
}

export interface RoutineRow {
  id: string;
  program_id: string;
  name: string;
  day_order: number;
  notes: string | null;
  created_at: number;
  [key: string]: SqlStorageValue;
}

export interface RoutineExerciseRow {
  id: number;
  routine_id: string;
  exercise_id: string;
  exercise_order: number;
  target_sets: number | null;
  target_reps: string | null;
  target_weight_lbs: number | null;
  target_rpe: number | null;
  notes: string | null;
  [key: string]: SqlStorageValue;
}

export interface ProfileRow {
  id: string;
  bio: string | null;
  goals: string | null;
  preferences: string | null;
  health_notes: string | null;
  updated_at: number;
  [key: string]: SqlStorageValue;
}

export interface GymEquipmentRow {
  id: string;
  name: string;
  display_name: string;
  category: string | null;
  details: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
  [key: string]: SqlStorageValue;
}

export interface SessionPlanRow {
  id: string;
  date: string;
  title: string;
  focus: string | null;
  status: 'planned' | 'done' | 'skipped';
  created_at: number;
  updated_at: number;
  [key: string]: SqlStorageValue;
}

export interface SessionPlanExerciseRow {
  id: number;
  plan_id: string;
  exercise_id: string;
  exercise_order: number;
  sets: number;
  reps: number;
  weight_lbs: number | null;
  rpe_target: number | null;
  why: string | null;
  is_new: 0 | 1;
  [key: string]: SqlStorageValue;
}

export interface NiggleRow {
  id: string;
  area: string;
  note: string | null;
  avoid: string | null;
  opened_at: number;
  resolved_at: number | null;
  [key: string]: SqlStorageValue;
}
