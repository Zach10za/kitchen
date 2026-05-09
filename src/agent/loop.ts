import type OpenAI from 'openai';
import type { Env } from '../env';
import type {
  Day,
  MealSlot,
  MealStub,
  PantryItem,
  PreferenceRow,
} from './tools';
import { planEmbed } from './render';
import { EmbedColor } from '../discord/types';
import {
  buildSystemPromptFor,
  loadPantry,
  loadPreferences,
  loadProfile,
  loadWeek,
} from './context';
import { MAX_TOOL_ROUNDS, runAgentRound } from './round';
import type { WeekRow } from '../kitchen-do';
import type { DiscordAPI } from '../discord/api';
import { makeOpenAIClient } from '../runtime/openai';

interface AgentArgs {
  env: Env;
  sql: SqlStorage;
  userMessage: string;
  weekOf: string;
}

export interface AgentResult {
  summary: string;
}

/**
 * Run one turn of the agent: append user message, loop Responses API tool
 * calls, persist conversation + tool results, return final assistant text.
 */
export async function runAgent(args: AgentArgs): Promise<AgentResult> {
  const { env, sql, userMessage, weekOf } = args;
  const client = makeClient(env);

  sql.exec(
    'INSERT INTO conversation (week_of, role, content, ts) VALUES (?, ?, ?, ?)',
    weekOf, 'user', userMessage, Date.now()
  );

  let messages: any[] = [
    { role: 'system', content: buildSystemPromptFor(sql, weekOf, env.TIMEZONE) },
    ...recentConversation(sql, weekOf, 30),
    { role: 'user', content: userMessage },
  ];

  const ctx: ToolCtx = { env, sql, client };

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await runAgentRound({
      client,
      model: env.OPENAI_MODEL,
      messages,
      weekOf,
      executeTool: (name, parsed) => executeTool(name, parsed, ctx),
      onToolCall: async ({ name, args: parsed, output }) => {
        sql.exec(
          'INSERT INTO conversation (week_of, role, content, tool_call_json, ts) VALUES (?, ?, ?, ?, ?)',
          weekOf, 'tool', output,
          JSON.stringify({ name, args: parsed }),
          Date.now()
        );
      },
    });

    messages = result.newMessages;

    if (result.type === 'final') {
      const finalText = result.finalText ?? '(no text)';
      sql.exec(
        'INSERT INTO conversation (week_of, role, content, ts) VALUES (?, ?, ?, ?)',
        weekOf, 'assistant', finalText, Date.now()
      );
      return { summary: finalText };
    }
  }

  return { summary: 'I got stuck in a tool loop. Try again with a simpler request.' };
}

function makeClient(env: Env): OpenAI {
  // 3 min per call lets gpt-5 take its time on hard tasks (grocery list
  // transformation, complex tool decisions) without falsely aborting.
  return makeOpenAIClient(env);
}

export interface ToolCtx { env: Env; sql: SqlStorage; client: OpenAI }

/** Conversation history shaped for the Responses API `input` array. */
function recentConversation(
  sql: SqlStorage,
  weekOf: string,
  limit: number
): { role: 'user' | 'assistant'; content: string }[] {
  const rows = sql.exec<{ role: string; content: string }>(
    'SELECT role, content FROM conversation WHERE week_of = ? AND role IN (?, ?) ORDER BY id DESC LIMIT ?',
    weekOf, 'user', 'assistant', limit
  ).toArray();
  return rows.reverse().map((r) => ({
    role: r.role as 'user' | 'assistant',
    content: r.content,
  }));
}

export async function executeTool(name: string, args: any, ctx: ToolCtx): Promise<string> {
  try {
    switch (name) {
      case 'generate_draft':        return await toolGenerateDraft(args, ctx);
      case 'swap_meal':             return await toolSwapMeal(args, ctx);
      case 'adjust_servings':       return toolAdjustServings(args, ctx);
      case 'reschedule_meal':       return toolRescheduleMeal(args, ctx);
      case 'update_pantry':         return toolUpdatePantry(args, ctx);
      case 'record_preference':     return toolRecordPreference(args, ctx);
      case 'mark_meal_cooked':      return toolMarkMealCooked(args, ctx);
      case 'mark_meal_skipped':     return toolMarkMealSkipped(args, ctx);
      case 'update_profile':        return toolUpdateProfile(args, ctx);
      case 'show_profile':          return toolShowProfile(ctx);
      case 'show_state':            return toolShowState(args, ctx);
      default:                      return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Tool ${name} failed: ${(err as Error).message}`;
  }
}

const STUB_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Real, well-known dish name' },
    description: { type: 'string', description: 'One-line summary, ~10-15 words' },
    cuisine: { type: 'string', description: 'e.g. italian, thai, mexican, american' },
    active_minutes: { type: 'integer' },
    total_minutes: { type: 'integer' },
    effort: { type: 'string', enum: ['easy', 'medium', 'hard'] },
  },
  required: ['name', 'description', 'cuisine', 'active_minutes', 'total_minutes', 'effort'],
  additionalProperties: false,
};

const WEEK_STUBS_SCHEMA = {
  type: 'object',
  properties: {
    meals: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          day: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
          ...STUB_SCHEMA.properties,
        },
        required: ['day', ...STUB_SCHEMA.required],
        additionalProperties: false,
      },
    },
  },
  required: ['meals'],
  additionalProperties: false,
};

/** One LLM call generates all 7 stubs as a coherent week. */
async function generateWeekStubs(
  ctx: ToolCtx,
  args: { prefs: PreferenceRow[]; pantry: PantryItem[]; constraints: string[] }
): Promise<(MealStub & { day: Day })[]> {
  const response = await ctx.client.responses.create({
    model: ctx.env.OPENAI_MODEL,
    input: [
      {
        role: 'system',
        content: 'You plan a 7-day dinner menu (Mon-Sun) for two adults. Pick real, well-known dishes. Vary cuisines and proteins across the week. Default to ~30 min weeknights (Mon-Fri) and one ~45-75 min "project" meal on a weekend. Use pantry ingredients when sensible.',
      },
      { role: 'user', content: buildWeekStubPrompt(args) },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'week_stubs',
        schema: WEEK_STUBS_SCHEMA,
        strict: true,
      },
    },
  });
  const content = response.output_text;
  if (!content) throw new Error('Week stub generation returned no content');
  return (JSON.parse(content) as { meals: (MealStub & { day: Day })[] }).meals;
}

/** Single-meal stub for swap operations. */
async function generateMealStub(
  ctx: ToolCtx,
  prompt: string
): Promise<MealStub> {
  const response = await ctx.client.responses.create({
    model: ctx.env.OPENAI_MODEL,
    input: [
      { role: 'system', content: 'You pick one real, well-known dish matching the request.' },
      { role: 'user', content: prompt },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'stub',
        schema: STUB_SCHEMA,
        strict: true,
      },
    },
  });
  const content = response.output_text;
  if (!content) throw new Error('Stub generation returned no content');
  return JSON.parse(content) as MealStub;
}

async function toolGenerateDraft(
  args: { week_of: string; constraints?: string[] },
  ctx: ToolCtx
): Promise<string> {
  const { sql } = ctx;
  const prefs = loadPreferences(sql);
  const pantry = loadPantry(sql);
  const constraints = args.constraints ?? [];

  const stubs = await generateWeekStubs(ctx, { prefs, pantry, constraints });

  const meals: MealSlot[] = stubs.map((s) => ({
    day: s.day,
    name: s.name,
    description: s.description,
    cuisine: s.cuisine,
    active_minutes: s.active_minutes,
    total_minutes: s.total_minutes,
    effort: s.effort,
    servings: 2,
    notes: [],
    status: 'planned',
  }));

  sql.exec(
    'INSERT INTO weeks (week_of, status, meals_json, constraints_json, drafted_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(week_of) DO UPDATE SET status=?, meals_json=excluded.meals_json, constraints_json=excluded.constraints_json, drafted_at=excluded.drafted_at, approved_at=NULL',
    args.week_of, 'draft', JSON.stringify(meals), JSON.stringify(constraints), Date.now(), 'draft'
  );

  // Archive any older lingering drafts so they can't be accidentally approved.
  // We keep the row (history is useful) but mark it 'archived' so /approve skips.
  sql.exec(
    "UPDATE weeks SET status = 'archived' WHERE status = 'draft' AND week_of != ?",
    args.week_of
  );

  return `Generated 7-day draft for week of ${args.week_of}. Meals: ${meals.map((m) => `${m.day}=${m.name}`).join(', ')}.`;
}

function buildWeekStubPrompt(args: {
  prefs: PreferenceRow[];
  pantry: PantryItem[];
  constraints: string[];
}): string {
  return [
    'Plan dinners for Mon-Sun (one meal per day).',
    '',
    'Constraints for this week:',
    ...args.constraints.map((c) => `- ${c}`),
    '',
    'Preferences (high weight first):',
    ...args.prefs.slice(0, 12).map((p) => `- [w${p.weight}] ${p.insight}`),
    '',
    'Pantry (use these when sensible):',
    ...args.pantry.map((p) => `- ${p.name}`),
    '',
    'Vary cuisines and proteins across the week. No two meals should share the same primary cuisine. One meal can be a longer weekend project.',
  ].filter(Boolean).join('\n');
}

async function toolSwapMeal(
  args: { week_of: string; day: Day; criteria: string },
  ctx: ToolCtx
): Promise<string> {
  const week = loadWeek(ctx.sql, args.week_of);
  if (!week) return `No plan exists for ${args.week_of}.`;

  const otherMeals = week.meals.filter((m) => m.day !== args.day);
  const stub = await generateMealStub(
    ctx,
    [
      `Pick a dinner for ${dayLabel(args.day)} matching: ${args.criteria}.`,
      `Servings: 2.`,
      `Pantry: ${loadPantry(ctx.sql).map((p) => p.name).join(', ')}.`,
      `Other meals already in this week (avoid repeating cuisine): ${otherMeals.map((m) => `${m.name} (${m.cuisine})`).join(', ')}.`,
    ].join(' ')
  );

  const meals: MealSlot[] = week.meals.map((m) =>
    m.day === args.day
      ? {
          ...m,
          name: stub.name,
          description: stub.description,
          cuisine: stub.cuisine,
          active_minutes: stub.active_minutes,
          total_minutes: stub.total_minutes,
          effort: stub.effort,
          notes: [],
          ingredients: undefined,
          steps: undefined,
        }
      : m
  );

  ctx.sql.exec('UPDATE weeks SET meals_json = ? WHERE week_of = ?', JSON.stringify(meals), args.week_of);
  return `Swapped ${args.day} to ${stub.name} (${stub.total_minutes} min, ${stub.cuisine}).`;
}

function toolAdjustServings(
  args: { week_of: string; day: Day; servings: number },
  ctx: ToolCtx
): string {
  const week = loadWeek(ctx.sql, args.week_of);
  if (!week) return `No plan exists for ${args.week_of}.`;
  const meals = week.meals.map((m) =>
    m.day === args.day ? { ...m, servings: args.servings } : m
  );
  ctx.sql.exec('UPDATE weeks SET meals_json = ? WHERE week_of = ?', JSON.stringify(meals), args.week_of);
  return `Set ${args.day} to ${args.servings} servings.`;
}

function toolRescheduleMeal(
  args: { week_of: string; from: Day; to: Day },
  ctx: ToolCtx
): string {
  const week = loadWeek(ctx.sql, args.week_of);
  if (!week) return `No plan exists for ${args.week_of}.`;
  const fromMeal = week.meals.find((m) => m.day === args.from);
  const toMeal = week.meals.find((m) => m.day === args.to);
  if (!fromMeal || !toMeal) return 'One of the days has no meal to swap.';
  const meals = week.meals.map((m) => {
    if (m.day === args.from) return { ...toMeal, day: args.from };
    if (m.day === args.to) return { ...fromMeal, day: args.to };
    return m;
  });
  ctx.sql.exec('UPDATE weeks SET meals_json = ? WHERE week_of = ?', JSON.stringify(meals), args.week_of);
  return `Swapped ${args.from} <-> ${args.to}.`;
}

interface PantryUpdateItem {
  name: string;
  qty_value?: number;
  qty_unit?: string;
  location?: 'freezer' | 'fridge' | 'shelf';
}

function toolUpdatePantry(
  args: { action: 'add' | 'remove'; items: PantryUpdateItem[] },
  ctx: ToolCtx
): string {
  for (const item of args.items) {
    const name = item.name?.trim().toLowerCase();
    if (!name) continue;
    if (args.action === 'add') {
      ctx.sql.exec(
        'INSERT INTO pantry (name, qty, qty_value, qty_unit, location, added_at) VALUES (?, NULL, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET qty_value=excluded.qty_value, qty_unit=excluded.qty_unit, location=excluded.location, added_at=excluded.added_at',
        name,
        item.qty_value ?? null,
        item.qty_unit ?? null,
        item.location ?? 'shelf',
        Date.now()
      );
    } else {
      ctx.sql.exec('DELETE FROM pantry WHERE name = ?', name);
    }
  }
  const summary = args.items
    .map((i) => `${i.name}${i.qty_value ? ` (${i.qty_value} ${i.qty_unit ?? ''})` : ''}${i.location && i.location !== 'shelf' ? ` [${i.location}]` : ''}`)
    .join(', ');
  return `Pantry ${args.action}: ${summary}.`;
}

function toolRecordPreference(
  args: { insight: string; rationale: string; weight: number },
  ctx: ToolCtx
): string {
  const id = crypto.randomUUID();
  ctx.sql.exec(
    'INSERT INTO preferences (id, insight, rationale, weight, learned_at) VALUES (?, ?, ?, ?, ?)',
    id, args.insight, args.rationale, args.weight, Date.now()
  );
  return `Recorded preference: "${args.insight}" (weight ${args.weight}).`;
}


function toolMarkMealCooked(
  args: { week_of: string; day: Day },
  ctx: ToolCtx
): string {
  const week = loadWeek(ctx.sql, args.week_of);
  if (!week) return `No plan exists for ${args.week_of}.`;
  const meal = week.meals.find((m) => m.day === args.day);
  if (!meal) return `No meal on ${args.day}.`;

  const meals = week.meals.map((m) =>
    m.day === args.day ? { ...m, status: 'cooked' as const } : m
  );
  ctx.sql.exec('UPDATE weeks SET meals_json = ? WHERE week_of = ?', JSON.stringify(meals), args.week_of);

  // Decrement pantry for items consumed. Only operate on pantry rows that
  // genuinely match the consumed quantity. If the units don't match (e.g.,
  // pantry has "1.5 lb chicken" and recipe says "3 chicken breasts"), we skip
  // — DON'T delete the row, since the user clearly has more than what was used.
  // Only delete when there's no qty info on the pantry row at all (treat it
  // as a "have/don't have" flag rather than a quantity tracker).
  const consumed: string[] = [];
  for (const ing of (meal.ingredients ?? [])) {
    const itemName = ing.item.toLowerCase().trim();
    const row = ctx.sql.exec<PantryItem>('SELECT * FROM pantry WHERE name = ?', itemName).toArray()[0];
    if (!row) continue;
    const parsed = parseQty(ing.qty);
    if (parsed && row.qty_value != null && row.qty_unit && row.qty_unit === parsed.unit) {
      // Units match → subtract. Delete if depleted.
      const remaining = row.qty_value - parsed.value;
      consumed.push(itemName);
      if (remaining <= 0) {
        ctx.sql.exec('DELETE FROM pantry WHERE name = ?', itemName);
      } else {
        ctx.sql.exec('UPDATE pantry SET qty_value = ? WHERE name = ?', remaining, itemName);
      }
    } else if (row.qty_value == null && row.qty_unit == null) {
      // Pantry row has no qty (boolean "I have this" tracker) → remove on use.
      ctx.sql.exec('DELETE FROM pantry WHERE name = ?', itemName);
      consumed.push(itemName);
    }
    // Otherwise: pantry has qty info but it doesn't match recipe units →
    // skip silently. Don't delete or modify.
  }

  // Cancel any unsent reminders for this meal.
  ctx.sql.exec(
    'UPDATE reminders SET sent_at = ? WHERE week_of = ? AND day = ? AND sent_at IS NULL',
    Date.now(), args.week_of, args.day
  );

  return `Marked ${args.day} cooked. Decremented from pantry: ${consumed.join(', ') || '(nothing)'}.`;
}

function toolMarkMealSkipped(
  args: { week_of: string; day: Day },
  ctx: ToolCtx
): string {
  const week = loadWeek(ctx.sql, args.week_of);
  if (!week) return `No plan exists for ${args.week_of}.`;

  const meals = week.meals.map((m) =>
    m.day === args.day ? { ...m, status: 'skipped' as const } : m
  );
  ctx.sql.exec('UPDATE weeks SET meals_json = ? WHERE week_of = ?', JSON.stringify(meals), args.week_of);

  // Cancel pending reminders.
  ctx.sql.exec(
    'UPDATE reminders SET sent_at = ? WHERE week_of = ? AND day = ? AND sent_at IS NULL',
    Date.now(), args.week_of, args.day
  );

  return `Marked ${args.day} skipped. Pantry items remain available.`;
}

/**
 * Parse a quantity string into structured form. Handles:
 *   "1 lb"        -> { value: 1, unit: 'lb' }
 *   "1.5 lb"      -> { value: 1.5, unit: 'lb' }
 *   "1/2 cup"     -> { value: 0.5, unit: 'cup' }
 *   "1 1/2 cups"  -> { value: 1.5, unit: 'cups' }
 *   "a pinch"     -> null  (caller treats pantry row as boolean)
 */
export function parseQty(raw: string): { value: number; unit: string } | null {
  const trimmed = raw.trim().toLowerCase();
  const mixed = trimmed.match(/^(\d+)\s+(\d+)\/(\d+)\s+([a-z]+)/);
  if (mixed) {
    const den = Number(mixed[3]);
    if (den === 0) return null;
    return { value: Number(mixed[1]) + Number(mixed[2]) / den, unit: mixed[4]! };
  }
  const frac = trimmed.match(/^(\d+)\/(\d+)\s+([a-z]+)/);
  if (frac) {
    const den = Number(frac[2]);
    if (den === 0) return null;
    return { value: Number(frac[1]) / den, unit: frac[3]! };
  }
  const decimal = trimmed.match(/^([\d.]+)\s*([a-z]+)/);
  if (decimal) {
    const value = parseFloat(decimal[1]!);
    if (Number.isNaN(value)) return null;
    return { value, unit: decimal[2]! };
  }
  return null;
}

function toolUpdateProfile(args: { content: string }, ctx: ToolCtx): string {
  const trimmed = args.content.trim();
  if (!trimmed) return 'Profile content is empty.';
  ctx.sql.exec(
    "INSERT INTO settings (key, value, updated_at) VALUES ('cooking_profile', ?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
    trimmed, Date.now()
  );
  return `Profile updated (${trimmed.length} chars). It will be applied on every future plan.`;
}

function toolShowProfile(ctx: ToolCtx): string {
  const profile = loadProfile(ctx.sql);
  return profile ?? 'No cooking profile set yet. Use /profile with a message to create one.';
}

function toolShowState(args: { week_of: string }, ctx: ToolCtx): string {
  const week = loadWeek(ctx.sql, args.week_of);
  if (!week) return `No plan for ${args.week_of}.`;
  const lines = week.meals.map(
    (m) => `${m.day}: ${m.name} (${m.cuisine}, ${m.total_minutes}min, ${m.servings} servings${m.ingredients ? ', recipe ready' : ''})`
  );
  return `Plan for ${args.week_of} (${week.status}):\n${lines.join('\n')}`;
}

function dayLabel(day: Day): string {
  return { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' }[day];
}

/**
 * Direct (non-agent) /draft flow with streaming progress.
 *
 * Generates a fresh meal plan for next week without going through the agent
 * loop's pre-call and post-call LLM round-trips. Reliable in ~10-15s because
 * we're not stacking "decide tool" + "tool call" + "compose reply" within the
 * same waitUntil budget.
 */
export async function runDraftFlow(args: {
  env: Env;
  sql: SqlStorage;
  discord: DiscordAPI;
  replyChannelId: string;
  weekOf: string;
  notes?: string;
}): Promise<void> {
  const { env, sql, discord, replyChannelId, weekOf, notes } = args;
  const client = makeClient(env);
  const ctx: ToolCtx = { env, sql, client };

  await discord.postMessage(replyChannelId, {
    embeds: [{
      title: `📝 Drafting plan for week of ${weekOf}…`,
      description: '_One LLM call to plan all 7 meals — about 10–15s._',
      color: EmbedColor.draft,
    }],
  });

  const constraints = notes ? [notes] : [];
  const result = await toolGenerateDraft({ week_of: weekOf, constraints }, ctx);

  const week = sql
    .exec<WeekRow>('SELECT * FROM weeks WHERE week_of = ?', weekOf)
    .toArray()[0];
  if (!week) {
    await discord.postMessage(replyChannelId, {
      embeds: [{
        title: '⚠️ Draft generation failed',
        description: result,
        color: EmbedColor.error,
      }],
    });
    return;
  }

  await discord.postMessage(replyChannelId, {
    embeds: [planEmbed(week, { includeFooterHint: true })],
  });
}

/**
 * Direct (non-agent) /pantry flow. Parses the user's free-text into structured
 * inventory items via one LLM call, inserts them, confirms in Discord.
 */
const PANTRY_PARSE_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'remove'] },
          name: { type: 'string', description: 'Lowercase singular item name' },
          qty_value: { type: ['number', 'null'] },
          qty_unit: { type: ['string', 'null'], description: 'lb, oz, count, cup, etc.' },
          location: { type: 'string', enum: ['freezer', 'fridge', 'shelf'] },
        },
        required: ['action', 'name', 'qty_value', 'qty_unit', 'location'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

interface ParsedPantryItem {
  action: 'add' | 'remove';
  name: string;
  qty_value: number | null;
  qty_unit: string | null;
  location: 'freezer' | 'fridge' | 'shelf';
}

export async function runPantryFlow(args: {
  env: Env;
  sql: SqlStorage;
  discord: DiscordAPI;
  replyChannelId: string;
  userMessage: string;
}): Promise<void> {
  const { env, sql, discord, replyChannelId, userMessage } = args;
  const client = makeClient(env);

  // Use the configured extract model — pure structured-output, no creativity needed.
  const response = await client.responses.create({
    model: env.OPENAI_MODEL_EXTRACT,
    input: [
      {
        role: 'system',
        content: 'You parse natural-language inventory updates into structured items. Default location is shelf unless the user mentions freezer/fridge or the item is obviously a frozen/refrigerated good. Default action is add unless the user says they used/finished/ran out (then remove). Use lowercase singular names. If quantity is unspecified, set qty_value and qty_unit to null. For "2 chicken thighs" use qty_value=2, qty_unit=count. For "1.5 lb ground beef" use qty_value=1.5, qty_unit=lb.',
      },
      { role: 'user', content: userMessage },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'pantry_update',
        schema: PANTRY_PARSE_SCHEMA,
        strict: true,
      },
    },
  });

  const content = response.output_text;
  if (!content) {
    await discord.postMessage(replyChannelId, {
      embeds: [{
        title: '🥫 Pantry update failed',
        description: 'Could not parse the input. Try again with simpler wording.',
        color: EmbedColor.error,
      }],
    });
    return;
  }

  const parsed = JSON.parse(content) as { items: ParsedPantryItem[] };
  const now = Date.now();

  for (const item of parsed.items) {
    const name = item.name?.trim().toLowerCase();
    if (!name) continue;
    if (item.action === 'add') {
      sql.exec(
        'INSERT INTO pantry (name, qty, qty_value, qty_unit, location, added_at) VALUES (?, NULL, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET qty_value=excluded.qty_value, qty_unit=excluded.qty_unit, location=excluded.location, added_at=excluded.added_at',
        name,
        item.qty_value,
        item.qty_unit,
        item.location,
        now
      );
    } else {
      sql.exec('DELETE FROM pantry WHERE name = ?', name);
    }
  }

  const added = parsed.items.filter((i) => i.action === 'add');
  const removed = parsed.items.filter((i) => i.action === 'remove');
  const fields: { name: string; value: string; inline?: boolean }[] = [];
  if (added.length > 0) {
    const byLocation: Record<string, string[]> = {};
    for (const item of added) {
      const qty = item.qty_value != null ? `${item.qty_value}${item.qty_unit ? ' ' + item.qty_unit : ''} ` : '';
      (byLocation[item.location] ??= []).push(`${qty}${item.name}`);
    }
    for (const loc of ['freezer', 'fridge', 'shelf'] as const) {
      const list = byLocation[loc];
      if (!list?.length) continue;
      fields.push({
        name: `${loc === 'freezer' ? '🧊' : loc === 'fridge' ? '🧴' : '🥫'} ${loc.toUpperCase()} added`,
        value: list.map((s) => `• ${s}`).join('\n').slice(0, 1024),
        inline: true,
      });
    }
  }
  if (removed.length > 0) {
    fields.push({
      name: '➖ Removed',
      value: removed.map((i) => `• ${i.name}`).join('\n').slice(0, 1024),
      inline: false,
    });
  }

  const description = fields.length === 0 ? 'No items parsed from that input.' : undefined;
  await discord.postMessage(replyChannelId, {
    embeds: [{
      title: '🥫 Pantry updated',
      ...(description ? { description } : {}),
      color: fields.length === 0 ? EmbedColor.archived : EmbedColor.inProgress,
      fields: fields.length > 0 ? fields : undefined,
    }],
  });
}
