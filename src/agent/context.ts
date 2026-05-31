/**
 * Shared context loaders. Both the daily-suggestion alarm and the unified
 * AgentChatWorkflow build their system prompt from the same snapshot of the
 * household state — keeping the queries here means the two paths can't drift.
 */

import type { Meal, MealRow, PantryItem, PreferenceRow } from './tools';
import { buildSystemPrompt } from './prompts';
import { todayISO } from '../util/datetime';

export interface RecentMeal {
  date: string;
  name: string;
  cuisine: string;
}

export interface AgentContext {
  today: Meal[];
  preferences: PreferenceRow[];
  pantry: PantryItem[];
  recentMeals: RecentMeal[];
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
  };
}

/** All decisions recorded for a given date (usually 0 or 1). A non-empty
 *  result is what suppresses the daily noon suggestion ping. */
export function loadDayDecision(sql: SqlStorage, dateISO: string): Meal[] {
  return sql
    .exec<MealRow>('SELECT * FROM meals WHERE date = ? ORDER BY id DESC', dateISO)
    .toArray()
    .map(parseMeal);
}

export function loadPreferences(sql: SqlStorage): PreferenceRow[] {
  return sql
    .exec<PreferenceRow>(
      'SELECT * FROM preferences ORDER BY weight DESC, learned_at DESC LIMIT 25'
    )
    .toArray();
}

export function loadPantry(sql: SqlStorage): PantryItem[] {
  return sql.exec<PantryItem>('SELECT * FROM pantry ORDER BY added_at DESC').toArray();
}

export function loadProfile(sql: SqlStorage): string | null {
  const row = sql
    .exec<{ value: string }>("SELECT value FROM settings WHERE key = 'cooking_profile'")
    .toArray()[0];
  return row?.value ?? null;
}

/**
 * Recently cooked or planned dishes, used to discourage repetition. No-cook
 * ('out') and skipped rows are excluded — they aren't dishes.
 */
export function loadRecentMeals(sql: SqlStorage, limit = 12): RecentMeal[] {
  return sql
    .exec<MealRow>(
      "SELECT * FROM meals WHERE status IN ('cooked', 'planned') AND name IS NOT NULL ORDER BY date DESC, id DESC LIMIT ?",
      limit
    )
    .toArray()
    .map((r) => ({ date: r.date, name: r.name ?? '', cuisine: r.cuisine ?? '' }));
}

export function loadContext(sql: SqlStorage, timezone: string): AgentContext {
  return {
    today: loadDayDecision(sql, todayISO(timezone)),
    preferences: loadPreferences(sql),
    pantry: loadPantry(sql),
    recentMeals: loadRecentMeals(sql),
    profile: loadProfile(sql),
  };
}

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/** Compute the current local time in the household's timezone, in the
 *  shape the system prompt expects. Centralized so every call site renders
 *  the same string. */
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

export function buildSystemPromptFor(sql: SqlStorage, timezone: string): string {
  return buildSystemPrompt({
    ...loadContext(sql, timezone),
    now: currentNowFor(timezone),
  });
}
