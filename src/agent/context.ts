/**
 * Shared context loaders. Both the daily-suggestion alarm and the unified
 * AgentChatWorkflow build their system prompt from the same snapshot of the
 * household state — keeping the queries here means the two paths can't drift.
 */

import type { GroceryRow, Meal, MealRow, RecipeExtras } from './tools';
import { buildSystemPrompt } from './prompts';
import { todayISO } from '../util/datetime';

export interface RecentMeal {
  date: string;
  name: string;
  cuisine: string;
  protein: string;
  effort: string;
  rating: number | null;
}

/** One dish in the house repertoire: rated at least once, deduped by name,
 *  carrying the latest rating and accumulated next-time notes. */
export interface RepertoireDish {
  name: string;
  cuisine: string;
  rating: number;
  timesCooked: number;
  lastDate: string;
  notes: string | null;
}

export interface AgentContext {
  today: Meal[];
  recentMeals: RecentMeal[];
  repertoire: RepertoireDish[];
  grocery: GroceryRow[];
  recentPitches: string[];
  profile: string | null;
}

/** Parse a raw `meals` row into its decoded JSON columns. */
export function parseMeal(row: MealRow): Meal {
  const safeArray = <T>(json: string | null): T[] => {
    if (!json) return [];
    try {
      const v = JSON.parse(json);
      return Array.isArray(v) ? (v as T[]) : [];
    } catch {
      return [];
    }
  };
  return {
    id: row.id,
    date: row.date,
    name: row.name,
    cuisine: row.cuisine,
    description: row.description,
    ingredients: safeArray(row.ingredients_json),
    steps: safeArray(row.steps_json),
    requires_defrost: safeArray(row.requires_defrost_json),
    status: row.status,
    created_at: row.created_at,
    protein: row.protein ?? null,
    effort: row.effort ?? null,
    extras: parseExtras(row.extras_json),
    rating: row.rating ?? null,
    cook_notes: row.cook_notes ?? null,
  };
}

export function parseExtras(json: string | null): RecipeExtras {
  if (!json) return {};
  try {
    const v = JSON.parse(json);
    return v && typeof v === 'object' ? (v as RecipeExtras) : {};
  } catch {
    return {};
  }
}

/** All decisions recorded for a given date (usually 0 or 1). A non-empty
 *  result is what suppresses the daily noon suggestion ping. */
export function loadDayDecision(sql: SqlStorage, dateISO: string): Meal[] {
  return sql
    .exec<MealRow>('SELECT * FROM meals WHERE date = ? ORDER BY id DESC', dateISO)
    .toArray()
    .map(parseMeal);
}

export function loadGrocery(sql: SqlStorage): GroceryRow[] {
  return sql.exec<GroceryRow>('SELECT * FROM grocery ORDER BY added_at ASC').toArray();
}

export function loadProfile(sql: SqlStorage): string | null {
  const row = sql
    .exec<{ value: string }>("SELECT value FROM settings WHERE key = 'cooking_profile'")
    .toArray()[0];
  return row?.value ?? null;
}

/**
 * Recently cooked or planned dishes, used to discourage repetition and to
 * rotate protein/effort, not just dish names. No-cook ('out') and skipped
 * rows are excluded — they aren't dishes.
 */
export function loadRecentMeals(sql: SqlStorage, limit = 12): RecentMeal[] {
  return sql
    .exec<MealRow>(
      "SELECT * FROM meals WHERE status IN ('cooked', 'planned') AND name IS NOT NULL ORDER BY date DESC, id DESC LIMIT ?",
      limit
    )
    .toArray()
    .map((r) => ({
      date: r.date,
      name: r.name ?? '',
      cuisine: r.cuisine ?? '',
      protein: r.protein ?? '',
      effort: r.effort ?? '',
      rating: r.rating ?? null,
    }));
}

/**
 * The house repertoire: cooked-and-rated dishes, deduped by name (latest
 * cook wins for rating/notes), best-rated first. This is the user's personal
 * cookbook — the prompt serves these back with their notes applied.
 */
export function loadRepertoire(sql: SqlStorage, limit = 10): RepertoireDish[] {
  const rows = sql
    .exec<MealRow>(
      "SELECT * FROM meals WHERE status = 'cooked' AND name IS NOT NULL ORDER BY date DESC, id DESC LIMIT 200",
    )
    .toArray();

  const byName = new Map<string, { rows: MealRow[] }>();
  for (const r of rows) {
    const key = (r.name ?? '').trim().toLowerCase();
    if (!key) continue;
    (byName.get(key) ?? byName.set(key, { rows: [] }).get(key)!).rows.push(r);
  }

  const dishes: RepertoireDish[] = [];
  for (const { rows: cooks } of byName.values()) {
    const rating = cooks.find((c) => c.rating != null)?.rating ?? null;
    if (rating == null) continue;
    const notes = cooks.find((c) => c.cook_notes)?.cook_notes ?? null;
    const latest = cooks[0]!;
    dishes.push({
      name: latest.name!,
      cuisine: latest.cuisine ?? '',
      rating,
      timesCooked: cooks.length,
      lastDate: latest.date,
      notes,
    });
  }
  dishes.sort((a, b) => b.rating - a.rating || (a.lastDate < b.lastDate ? 1 : -1));
  return dishes.slice(0, limit);
}

/** The most recent cooked-but-unrated meal within the last few days — the
 *  daily ping uses this to ask "how was it?" exactly once, while it's fresh. */
export function loadUnratedRecentCooked(sql: SqlStorage, timezone: string): MealRow | null {
  const today = todayISO(timezone);
  const row = sql
    .exec<MealRow>(
      "SELECT * FROM meals WHERE status = 'cooked' AND name IS NOT NULL AND rating IS NULL AND cook_notes IS NULL AND date < ? AND date >= date(?, '-3 days') ORDER BY date DESC, id DESC LIMIT 1",
      today, today,
    )
    .toArray()[0];
  return row ?? null;
}

/** Matches the suggestion-format header the prompt mandates:
 *  `**1. Dish Name** — ~25 min, easy` (also tolerates `1)` and a model that
 *  bolds the whole line — the ` — ` suffix is stripped). */
const PITCH_HEADER_RE = /\*\*\s*\d+[.)]\s*([^*\n]+?)\s*\*\*/g;

/**
 * Dish names the bot has pitched recently, parsed from its own replies across
 * ALL conversation scopes (noon pings, /cook threads, chat threads). The
 * anti-repeat rule injects these into every prompt deterministically instead
 * of hoping the right scope's history happens to be in view — per-scope
 * history can't see what was offered in other threads.
 */
export function loadRecentPitches(sql: SqlStorage, days = 14, cap = 30): string[] {
  const cutoff = Date.now() - days * 86_400_000;
  const rows = sql
    .exec<{ content: string }>(
      "SELECT content FROM conversation WHERE role = 'assistant' AND ts >= ? ORDER BY id DESC LIMIT 200",
      cutoff,
    )
    .toArray();

  const seen = new Set<string>();
  const pitches: string[] = [];
  for (const row of rows) {
    for (const match of row.content.matchAll(PITCH_HEADER_RE)) {
      const name = match[1]!.split(' — ')[0]!.trim();
      if (name.length < 3 || name.length > 80) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      pitches.push(name);
      if (pitches.length >= cap) return pitches;
    }
  }
  return pitches;
}

export function loadContext(sql: SqlStorage): AgentContext {
  return {
    today: loadDayDecision(sql, todayISO('UTC')),
    recentMeals: loadRecentMeals(sql),
    repertoire: loadRepertoire(sql),
    grocery: loadGrocery(sql),
    recentPitches: loadRecentPitches(sql),
    profile: loadProfile(sql),
  };
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

function currentNowFor(timezone: string): { iso: string; localFormatted: string; dayKey: string } {
  const date = new Date();
  const localFormatted = date.toLocaleString('en-US', {
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
  const weekdayShort = date.toLocaleString('en-US', {
    timeZone: timezone,
    weekday: 'short',
  }).toLowerCase().slice(0, 3);
  const dayKey = (DAY_KEYS as readonly string[]).includes(weekdayShort) ? weekdayShort : 'mon';
  return { iso: date.toISOString(), localFormatted, dayKey };
}

export function buildSystemPromptFor(sql: SqlStorage, timezone: string, dinnerHourLocal: number): string {
  return buildSystemPrompt({
    ...loadContext(sql),
    now: currentNowFor(timezone),
    dinnerHourLocal,
  });
}