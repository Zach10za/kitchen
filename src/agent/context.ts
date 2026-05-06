/**
 * Shared context loaders. Both the in-process agent (`runAgent` in loop.ts)
 * and the durable SteerWorkflow build their system prompt from the same
 * snapshot of the household state — keeping the queries here means the two
 * paths can't drift.
 */

import type { WeekRow } from '../kitchen-do';
import type { MealSlot, PantryItem, PreferenceRow, WeekState } from './tools';
import { buildSystemPrompt } from './prompts';

export interface RecentMeal {
  weekOf: string;
  day: string;
  name: string;
  cuisine: string;
}

export interface AgentContext {
  plan: WeekState | null;
  preferences: PreferenceRow[];
  pantry: PantryItem[];
  recentMeals: RecentMeal[];
  profile: string | null;
}

/** Most-recent draft within the last `withinDays` days, or null. */
export function findActiveWeek(sql: SqlStorage, withinDays = 14): WeekRow | null {
  const cutoff = Date.now() - withinDays * 86_400_000;
  return sql
    .exec<WeekRow>(
      'SELECT * FROM weeks WHERE drafted_at >= ? ORDER BY drafted_at DESC LIMIT 1',
      cutoff
    )
    .toArray()[0] ?? null;
}

export function loadWeek(sql: SqlStorage, weekOf: string): WeekState | null {
  const row = sql.exec<WeekRow>('SELECT * FROM weeks WHERE week_of = ?', weekOf).toArray()[0];
  if (!row) return null;
  return {
    week_of: row.week_of,
    status: row.status,
    drafted_at: row.drafted_at,
    approved_at: row.approved_at,
    meals: JSON.parse(row.meals_json) as MealSlot[],
    constraints: JSON.parse(row.constraints_json) as string[],
  };
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
 * Recent meals from prior approved weeks, used to discourage repetition.
 * Drafts are intentionally excluded — they may not actually get cooked.
 */
export function loadRecentMeals(
  sql: SqlStorage,
  excludeWeekOf: string,
  daysBack: number
): RecentMeal[] {
  const cutoff = Date.now() - daysBack * 86_400_000;
  const rows = sql
    .exec<WeekRow>(
      "SELECT * FROM weeks WHERE week_of != ? AND drafted_at >= ? AND status IN ('approved', 'in_progress') ORDER BY week_of DESC LIMIT 4",
      excludeWeekOf,
      cutoff
    )
    .toArray();
  const out: RecentMeal[] = [];
  for (const row of rows) {
    const meals = JSON.parse(row.meals_json) as MealSlot[];
    for (const m of meals) {
      out.push({ weekOf: row.week_of, day: m.day, name: m.name, cuisine: m.cuisine });
    }
  }
  return out;
}

export function loadContext(sql: SqlStorage, weekOf: string): AgentContext {
  return {
    plan: loadWeek(sql, weekOf),
    preferences: loadPreferences(sql),
    pantry: loadPantry(sql),
    recentMeals: loadRecentMeals(sql, weekOf, 14),
    profile: loadProfile(sql),
  };
}

export function buildSystemPromptFor(sql: SqlStorage, weekOf: string): string {
  return buildSystemPrompt(loadContext(sql, weekOf));
}
