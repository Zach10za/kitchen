import OpenAI from 'openai';
import type { Env } from '../env';
import type {
  Day,
  GroceryItem,
  MealSlot,
  MealStub,
  PantryItem,
  PreferenceRow,
  RecipeDetails,
  WeekState,
} from './tools';
import { TOOLS } from './tools';
import { buildSystemPrompt } from './prompts';
import { renderPlan, renderRecipe, renderGroceryList } from './render';
import type { WeekRow } from '../kitchen-do';
import type { DiscordAPI } from '../discord/api';

interface AgentArgs {
  env: Env;
  sql: SqlStorage;
  userMessage: string;
  weekOf: string;
}

export interface AgentResult {
  summary: string;
}

const MAX_TOOL_ROUNDS = 6;

/**
 * Run one turn of the agent: append user message, loop OpenAI tool calls,
 * persist conversation + tool results, return final assistant text.
 */
export async function runAgent(args: AgentArgs): Promise<AgentResult> {
  const { env, sql, userMessage, weekOf } = args;
  const client = makeClient(env);

  sql.exec(
    'INSERT INTO conversation (week_of, role, content, ts) VALUES (?, ?, ?, ?)',
    weekOf, 'user', userMessage, Date.now()
  );

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(loadContext(sql, weekOf)) },
    ...recentConversation(sql, weekOf, 30),
    { role: 'user', content: userMessage },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const completion = await client.chat.completions.create({
      model: env.OPENAI_MODEL,
      messages,
      tools: TOOLS as unknown as OpenAI.Chat.Completions.ChatCompletionTool[],
    });

    const choice = completion.choices[0];
    if (!choice) throw new Error('OpenAI returned no choices');
    const msg = choice.message;
    messages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const finalText = msg.content ?? '(no text)';
      sql.exec(
        'INSERT INTO conversation (week_of, role, content, ts) VALUES (?, ?, ?, ?)',
        weekOf, 'assistant', finalText, Date.now()
      );
      return { summary: finalText };
    }

    for (const toolCall of msg.tool_calls) {
      if (toolCall.type !== 'function') continue;
      const result = await executeTool(
        toolCall.function.name,
        JSON.parse(toolCall.function.arguments),
        { env, sql, client }
      );
      sql.exec(
        'INSERT INTO conversation (week_of, role, content, tool_call_json, ts) VALUES (?, ?, ?, ?, ?)',
        weekOf,
        'tool',
        result,
        JSON.stringify({ name: toolCall.function.name, args: toolCall.function.arguments }),
        Date.now()
      );
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result,
      });
    }
  }

  return { summary: 'I got stuck in a tool loop. Try again with a simpler request.' };
}

function makeClient(env: Env): OpenAI {
  return new OpenAI({
    apiKey: env.OPENAI_API_KEY,
    baseURL: env.AI_GATEWAY_URL || undefined,
    // 3 min per call. Lets gpt-5 take its time on hard tasks (grocery list
    // transformation, complex tool decisions) without falsely aborting.
    timeout: 180_000,
    maxRetries: 1,
  });
}

export interface ToolCtx { env: Env; sql: SqlStorage; client: OpenAI }

function loadContext(sql: SqlStorage, weekOf: string) {
  return {
    plan: loadWeek(sql, weekOf),
    preferences: loadPreferences(sql),
    pantry: loadPantry(sql),
    recentMeals: loadRecentMeals(sql, weekOf, 14), // 2 weeks of history
    profile: loadProfile(sql),
  };
}

function loadProfile(sql: SqlStorage): string | null {
  const row = sql
    .exec<{ value: string }>("SELECT value FROM settings WHERE key = 'cooking_profile'")
    .toArray()[0];
  return row?.value ?? null;
}

/**
 * Recent meals from prior weeks, used to discourage repetition. Pulls only
 * approved or in-progress weeks; ignores still-draft weeks.
 */
function loadRecentMeals(
  sql: SqlStorage,
  excludeWeekOf: string,
  daysBack: number
): { weekOf: string; day: string; name: string; cuisine: string }[] {
  const cutoff = Date.now() - daysBack * 86_400_000;
  const rows = sql.exec<WeekRow>(
    "SELECT * FROM weeks WHERE week_of != ? AND drafted_at >= ? AND status IN ('approved', 'in_progress') ORDER BY week_of DESC LIMIT 4",
    excludeWeekOf, cutoff
  ).toArray();
  const out: { weekOf: string; day: string; name: string; cuisine: string }[] = [];
  for (const row of rows) {
    const meals = JSON.parse(row.meals_json) as MealSlot[];
    for (const m of meals) {
      out.push({ weekOf: row.week_of, day: m.day, name: m.name, cuisine: m.cuisine });
    }
  }
  return out;
}

function loadWeek(sql: SqlStorage, weekOf: string): WeekState | null {
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

function loadPreferences(sql: SqlStorage): PreferenceRow[] {
  return sql.exec<PreferenceRow>('SELECT * FROM preferences ORDER BY weight DESC, learned_at DESC LIMIT 25').toArray();
}

function loadPantry(sql: SqlStorage): PantryItem[] {
  return sql.exec<PantryItem>('SELECT * FROM pantry ORDER BY added_at DESC').toArray();
}

function recentConversation(
  sql: SqlStorage,
  weekOf: string,
  limit: number
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
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
      case 'approve_plan':          return await toolApprovePlan(args, ctx);
      case 'generate_grocery_list': return await toolGenerateGroceryList(args, ctx);
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

const RECIPE_DETAILS_SCHEMA = {
  type: 'object',
  properties: {
    ingredients: {
      type: 'array',
      items: {
        type: 'object',
        properties: { item: { type: 'string' }, qty: { type: 'string' } },
        required: ['item', 'qty'],
        additionalProperties: false,
      },
    },
    steps: { type: 'array', items: { type: 'string' } },
  },
  required: ['ingredients', 'steps'],
  additionalProperties: false,
};

/** One LLM call generates all 7 stubs as a coherent week. */
async function generateWeekStubs(
  ctx: ToolCtx,
  args: { prefs: PreferenceRow[]; pantry: PantryItem[]; constraints: string[] }
): Promise<(MealStub & { day: Day })[]> {
  const completion = await ctx.client.chat.completions.create({
    model: ctx.env.OPENAI_MODEL,
    messages: [
      {
        role: 'system',
        content: 'You plan a 7-day dinner menu (Mon-Sun) for two adults. Pick real, well-known dishes. Vary cuisines and proteins across the week. Default to ~30 min weeknights (Mon-Fri) and one ~45-75 min "project" meal on a weekend. Use pantry ingredients when sensible.',
      },
      { role: 'user', content: buildWeekStubPrompt(args) },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'week_stubs', schema: WEEK_STUBS_SCHEMA, strict: true },
    },
  });
  const content = completion.choices[0]?.message.content;
  if (!content) throw new Error('Week stub generation returned no content');
  return (JSON.parse(content) as { meals: (MealStub & { day: Day })[] }).meals;
}

/** Single-meal stub for swap operations. */
async function generateMealStub(
  ctx: ToolCtx,
  prompt: string
): Promise<MealStub> {
  const completion = await ctx.client.chat.completions.create({
    model: ctx.env.OPENAI_MODEL,
    messages: [
      { role: 'system', content: 'You pick one real, well-known dish matching the request.' },
      { role: 'user', content: prompt },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'stub', schema: STUB_SCHEMA, strict: true },
    },
  });
  const content = completion.choices[0]?.message.content;
  if (!content) throw new Error('Stub generation returned no content');
  return JSON.parse(content) as MealStub;
}

/** Materialize ingredients + steps for an already-decided meal. */
async function materializeRecipe(
  ctx: ToolCtx,
  meal: MealSlot
): Promise<RecipeDetails> {
  const completion = await ctx.client.chat.completions.create({
    model: ctx.env.OPENAI_MODEL,
    messages: [
      {
        role: 'system',
        content: 'Generate the ingredient list and ordered steps for the given dish, scaled to the requested serving count. Concrete quantities. 4-8 steps.',
      },
      {
        role: 'user',
        content: `Dish: ${meal.name}\nDescription: ${meal.description}\nCuisine: ${meal.cuisine}\nServings: ${meal.servings}\nTotal time target: ${meal.total_minutes} min`,
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'recipe_details', schema: RECIPE_DETAILS_SCHEMA, strict: true },
    },
  });
  const content = completion.choices[0]?.message.content;
  if (!content) throw new Error('Recipe materialization returned no content');
  return JSON.parse(content) as RecipeDetails;
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

async function toolApprovePlan(args: { week_of: string }, ctx: ToolCtx): Promise<string> {
  const week = loadWeek(ctx.sql, args.week_of);
  if (!week) return `No plan exists for ${args.week_of}.`;

  // Materialize all 7 full recipes in parallel (only the ones not yet materialized).
  const materializedMeals = await Promise.all(
    week.meals.map(async (m) => {
      if (m.ingredients && m.steps) return m;
      const details = await materializeRecipe(ctx, m);
      return { ...m, ingredients: details.ingredients, steps: details.steps };
    })
  );

  ctx.sql.exec(
    'UPDATE weeks SET status = ?, approved_at = ?, meals_json = ? WHERE week_of = ?',
    'approved', Date.now(), JSON.stringify(materializedMeals), args.week_of
  );

  // Schedule defrost reminders for any freezer items used by the meals.
  const remindersScheduled = scheduleDefrostReminders(ctx, args.week_of, materializedMeals);

  return `Approved plan for ${args.week_of} and materialized full recipes. Scheduled ${remindersScheduled} defrost reminder(s). Now call generate_grocery_list.`;
}

/**
 * For each meal, find ingredients that match a freezer pantry item by fuzzy
 * substring match. Schedule a reminder DEFROST_HOURS_AHEAD before the meal's
 * default cook time (6pm local on that day).
 */
const DEFROST_DEFAULTS: Record<string, number> = {
  // hours of advance warning by item keyword
  'chicken': 24,
  'beef': 24,
  'pork': 24,
  'lamb': 36,
  'salmon': 12,
  'fish': 12,
  'shrimp': 6,
  'turkey': 48,
  'roast': 48,
};

function scheduleDefrostReminders(
  ctx: ToolCtx,
  weekOf: string,
  meals: MealSlot[]
): number {
  // Clear any pending reminders for this week first (re-approval should reset).
  ctx.sql.exec(
    'DELETE FROM reminders WHERE week_of = ? AND type = ? AND sent_at IS NULL',
    weekOf, 'defrost'
  );

  // Load freezer items (lowercased name set).
  const freezerItems = ctx.sql
    .exec<PantryItem>("SELECT * FROM pantry WHERE location = 'freezer'")
    .toArray();
  if (freezerItems.length === 0) return 0;

  const weekStart = parseWeekOf(weekOf); // Monday at midnight local-ish (ms epoch)
  const dayOffset: Record<Day, number> = {
    mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6,
  };

  let count = 0;
  for (const meal of meals) {
    if (meal.status === 'skipped' || meal.status === 'cooked') continue;
    if (!meal.ingredients) continue;

    for (const ing of meal.ingredients) {
      const ingLower = ing.item.toLowerCase();
      const match = freezerItems.find((f) => ingLower.includes(f.name) || f.name.includes(ingLower.split(' ').pop() ?? ''));
      if (!match) continue;

      const hoursAhead = pickDefrostHours(match.name);
      const cookTime = weekStart + dayOffset[meal.day] * 86_400_000 + 18 * 3_600_000; // 6pm
      const dueAt = cookTime - hoursAhead * 3_600_000;
      if (dueAt < Date.now()) continue; // already past — skip silently

      const message = `🧊 **Defrost reminder**: pull the ${match.name} out of the freezer for ${dayLabel(meal.day)}'s ${meal.name} (~${hoursAhead}h before cook time).`;
      ctx.sql.exec(
        'INSERT INTO reminders (due_at, type, week_of, day, message) VALUES (?, ?, ?, ?, ?)',
        dueAt, 'defrost', weekOf, meal.day, message
      );
      count++;
    }
  }
  return count;
}

function pickDefrostHours(itemName: string): number {
  const lower = itemName.toLowerCase();
  for (const [keyword, hours] of Object.entries(DEFROST_DEFAULTS)) {
    if (lower.includes(keyword)) return hours;
  }
  return 12; // safe default for "I don't know what this is"
}

/** Convert a YYYY-MM-DD Monday string to a ms epoch at midnight UTC. */
function parseWeekOf(weekOf: string): number {
  return new Date(weekOf + 'T00:00:00Z').getTime();
}

async function toolGenerateGroceryList(
  args: { week_of: string },
  ctx: ToolCtx
): Promise<string> {
  const week = loadWeek(ctx.sql, args.week_of);
  if (!week) return `No plan exists for ${args.week_of}.`;

  // Lazy materialization: if any meals lack full recipes, generate them now.
  const needsMaterialize = week.meals.some((m) => !m.ingredients || !m.steps);
  let mealsToUse = week.meals;
  if (needsMaterialize) {
    mealsToUse = await Promise.all(
      week.meals.map(async (m) => {
        if (m.ingredients && m.steps) return m;
        const details = await materializeRecipe(ctx, m);
        return { ...m, ingredients: details.ingredients, steps: details.steps };
      })
    );
    ctx.sql.exec('UPDATE weeks SET meals_json = ? WHERE week_of = ?', JSON.stringify(mealsToUse), args.week_of);
  }

  const pantry = new Set(loadPantry(ctx.sql).map((p) => p.name.toLowerCase()));
  const aggregated: { item: string; qty: string; servings: number }[] = [];
  for (const meal of mealsToUse) {
    for (const ing of (meal.ingredients ?? [])) {
      if (pantry.has(ing.item.toLowerCase().trim())) continue;
      aggregated.push({ item: ing.item, qty: ing.qty, servings: meal.servings });
    }
  }

  const items: GroceryItem[] = await categorizeGrocery(ctx, aggregated);

  ctx.sql.exec(
    'INSERT INTO grocery_lists (week_of, items_json, generated_at) VALUES (?, ?, ?) ON CONFLICT(week_of) DO UPDATE SET items_json=excluded.items_json, generated_at=excluded.generated_at',
    args.week_of, JSON.stringify(items), Date.now()
  );

  return `Generated ${items.length} grocery items.\n\n${renderGroceryList(items)}`;
}

const GROCERY_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          item: { type: 'string' },
          qty: { type: 'string' },
          category: { type: 'string', enum: ['produce', 'protein', 'dairy', 'pantry', 'frozen', 'other'] },
        },
        required: ['item', 'qty', 'category'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

async function categorizeGrocery(
  ctx: ToolCtx,
  aggregated: { item: string; qty: string; servings: number }[]
): Promise<GroceryItem[]> {
  const completion = await ctx.client.chat.completions.create({
    model: ctx.env.OPENAI_MODEL,
    messages: [
      {
        role: 'system',
        content: 'Combine duplicate grocery items, sum sensible quantities, and categorize each. Use the item name as it would appear on a receipt.',
      },
      { role: 'user', content: JSON.stringify(aggregated) },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'grocery', schema: GROCERY_SCHEMA, strict: true },
    },
  });
  const content = completion.choices[0]?.message.content;
  if (!content) throw new Error('Grocery categorization returned no content');
  return (JSON.parse(content) as { items: GroceryItem[] }).items;
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

  // Decrement pantry for items consumed.
  const consumed: string[] = [];
  for (const ing of (meal.ingredients ?? [])) {
    const itemName = ing.item.toLowerCase().trim();
    const row = ctx.sql.exec<PantryItem>('SELECT * FROM pantry WHERE name = ?', itemName).toArray()[0];
    if (!row) continue;
    consumed.push(itemName);
    // Best-effort qty subtraction: if both pantry and ingredient parsed as same unit, subtract.
    const parsed = parseQty(ing.qty);
    if (parsed && row.qty_value != null && row.qty_unit && row.qty_unit === parsed.unit) {
      const remaining = row.qty_value - parsed.value;
      if (remaining <= 0) {
        ctx.sql.exec('DELETE FROM pantry WHERE name = ?', itemName);
      } else {
        ctx.sql.exec('UPDATE pantry SET qty_value = ? WHERE name = ?', remaining, itemName);
      }
    } else {
      // No parseable qty match — assume fully consumed (conservative).
      ctx.sql.exec('DELETE FROM pantry WHERE name = ?', itemName);
    }
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

/** Parse a quantity string like "1 lb", "2 cups", "8 oz" into structured form. */
function parseQty(raw: string): { value: number; unit: string } | null {
  const match = raw.trim().toLowerCase().match(/^([\d.]+)\s*([a-z]+)/);
  if (!match || !match[1] || !match[2]) return null;
  const value = parseFloat(match[1]);
  if (Number.isNaN(value)) return null;
  return { value, unit: match[2] };
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

export { renderRecipe };

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
  interactionToken: string;
  weekOf: string;
  notes?: string;
}): Promise<void> {
  const { env, sql, discord, interactionToken, weekOf, notes } = args;
  const client = makeClient(env);
  const ctx: ToolCtx = { env, sql, client };

  // Step 1: announce
  await discord.editOriginal(
    interactionToken,
    `📝 Drafting plan for week of **${weekOf}**…\n_(one LLM call to plan all 7 meals — about 10-15s)_`
  );

  // Step 2: generate
  const constraints = notes ? [notes] : [];
  const result = await toolGenerateDraft({ week_of: weekOf, constraints }, ctx);
  // result string includes the meal list

  // Step 3: render the new plan and reply
  const week = sql
    .exec<WeekRow>('SELECT * FROM weeks WHERE week_of = ?', weekOf)
    .toArray()[0];
  if (!week) {
    await discord.editOriginal(interactionToken, `Draft generation failed: ${result}`);
    return;
  }

  const planText = renderPlan(week);
  const reply = [
    `📋 **Draft for week of ${weekOf}**`,
    '',
    planText,
    '',
    'Use `/steer` to refine, `/approve` to lock it in.',
  ].join('\n');

  await discord.editOriginal(interactionToken, reply);
}

/**
 * Direct (non-agent) /pantry flow. Parses the user's free-text into structured
 * inventory items via one LLM call (json_schema, gpt-5-nano), inserts them,
 * confirms in Discord. ~1-2s vs ~5-10s through the agent.
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
  interactionToken: string;
  userMessage: string;
}): Promise<void> {
  const { env, sql, discord, interactionToken, userMessage } = args;
  const client = makeClient(env);

  // Use gpt-5-nano for pure extraction — much faster than mini, no creativity needed.
  const completion = await client.chat.completions.create({
    model: 'gpt-5-nano',
    messages: [
      {
        role: 'system',
        content: 'You parse natural-language inventory updates into structured items. Default location is shelf unless the user mentions freezer/fridge or the item is obviously a frozen/refrigerated good. Default action is add unless the user says they used/finished/ran out (then remove). Use lowercase singular names. If quantity is unspecified, set qty_value and qty_unit to null. For "2 chicken thighs" use qty_value=2, qty_unit=count. For "1.5 lb ground beef" use qty_value=1.5, qty_unit=lb.',
      },
      { role: 'user', content: userMessage },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'pantry_update', schema: PANTRY_PARSE_SCHEMA, strict: true },
    },
  });

  const content = completion.choices[0]?.message.content;
  if (!content) {
    await discord.editOriginal(interactionToken, 'Failed to parse the input. Try again with simpler wording.');
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

  // Build confirmation grouped by action + location.
  const added = parsed.items.filter((i) => i.action === 'add');
  const removed = parsed.items.filter((i) => i.action === 'remove');
  const lines: string[] = [];
  if (added.length > 0) {
    const byLocation: Record<string, string[]> = {};
    for (const item of added) {
      const qty = item.qty_value != null ? `${item.qty_value}${item.qty_unit ? ' ' + item.qty_unit : ''} ` : '';
      (byLocation[item.location] ??= []).push(`${qty}${item.name}`);
    }
    for (const loc of ['freezer', 'fridge', 'shelf']) {
      if (byLocation[loc]?.length) {
        lines.push(`**${loc.toUpperCase()}** (added): ${byLocation[loc]!.join(', ')}`);
      }
    }
  }
  if (removed.length > 0) {
    lines.push(`**Removed**: ${removed.map((i) => i.name).join(', ')}`);
  }

  const reply = lines.length > 0 ? lines.join('\n') : 'No items parsed from that input.';
  await discord.editOriginal(interactionToken, reply);
}

/**
 * Direct (non-agent) /approve flow with streaming progress updates.
 *
 * Replaces the agent-driven path: avoids ~3 LLM turns of routing overhead and
 * gives the user live progress in Discord instead of 30s of "Bot is thinking…".
 *
 * Steps:
 *  1. Find most recent draft plan (within 14 days)
 *  2. Edit Discord message: "locking in"
 *  3. Materialize all 7 recipes in parallel (LLM)
 *  4. Edit Discord message: "recipes ready, building grocery list"
 *  5. Schedule defrost reminders (no LLM)
 *  6. Categorize grocery list (LLM)
 *  7. Edit Discord message: final result with plan + grocery list
 */
export async function runApproveFlow(args: {
  env: Env;
  sql: SqlStorage;
  discord: DiscordAPI;
  interactionToken: string;
}): Promise<void> {
  const { env, sql, discord, interactionToken } = args;
  const client = makeClient(env);
  const ctx: ToolCtx = { env, sql, client };

  // Step 1: find the active plan — same logic as /plan fast-read so they
  // agree on which plan we're operating on.
  const cutoff = Date.now() - 14 * 86_400_000;
  const week = sql
    .exec<WeekRow>(
      'SELECT * FROM weeks WHERE drafted_at >= ? ORDER BY drafted_at DESC LIMIT 1',
      cutoff
    )
    .toArray()[0];

  if (!week) {
    await discord.editOriginal(
      interactionToken,
      'No plan in the last 14 days. Use `/steer message: make a plan` to create one first.'
    );
    return;
  }

  if (week.status === 'approved') {
    await discord.editOriginal(
      interactionToken,
      `The plan for **${week.week_of}** is already approved. Use \`/grocery\` to see the list, or \`/steer message: regenerate\` to start a new draft.`
    );
    return;
  }

  const weekOf = week.week_of;
  const meals = JSON.parse(week.meals_json) as MealSlot[];

  // Step 2: announce intent
  await discord.editOriginal(
    interactionToken,
    `🔒 Approving plan for week of **${weekOf}**…\n👨‍🍳 Generating full recipes (7 in parallel) — about 10-15s.`
  );

  // Step 3: materialize all recipes in parallel
  const materializedMeals = await Promise.all(
    meals.map(async (m) => {
      if (m.ingredients && m.steps) return m;
      const details = await materializeRecipe(ctx, m);
      return { ...m, ingredients: details.ingredients, steps: details.steps };
    })
  );

  sql.exec(
    'UPDATE weeks SET status = ?, approved_at = ?, meals_json = ? WHERE week_of = ?',
    'approved',
    Date.now(),
    JSON.stringify(materializedMeals),
    weekOf
  );

  const remindersScheduled = scheduleDefrostReminders(ctx, weekOf, materializedMeals);

  // Step 4: progress update
  await discord.editOriginal(
    interactionToken,
    `🔒 Plan approved for **${weekOf}**\n👨‍🍳 ${materializedMeals.length} recipes ready\n🧊 ${remindersScheduled} defrost reminder(s) scheduled\n🛒 Building grocery list…`
  );

  // Step 5: aggregate ingredients minus pantry
  const pantryItems = sql
    .exec<PantryItem>('SELECT * FROM pantry')
    .toArray();
  const pantry = new Set(pantryItems.map((p) => p.name.toLowerCase()));

  const aggregated: { item: string; qty: string; servings: number }[] = [];
  for (const meal of materializedMeals) {
    for (const ing of meal.ingredients ?? []) {
      if (pantry.has(ing.item.toLowerCase().trim())) continue;
      aggregated.push({ item: ing.item, qty: ing.qty, servings: meal.servings });
    }
  }

  const items: GroceryItem[] = await categorizeGrocery(ctx, aggregated);

  sql.exec(
    'INSERT INTO grocery_lists (week_of, items_json, generated_at) VALUES (?, ?, ?) ON CONFLICT(week_of) DO UPDATE SET items_json=excluded.items_json, generated_at=excluded.generated_at',
    weekOf,
    JSON.stringify(items),
    Date.now()
  );

  // Step 6: final result
  const planText = renderPlan({ ...week, status: 'approved', meals_json: JSON.stringify(materializedMeals) });
  const groceryText = renderGroceryList(items);

  const final = [
    `✅ **Approved plan for week of ${weekOf}**`,
    '',
    planText,
    '',
    `🧊 ${remindersScheduled} defrost reminder(s) scheduled — you'll get pings in this channel.`,
    '',
    '🛒 **Grocery list:**',
    '',
    groceryText,
  ].join('\n');

  // Discord has a 2000-char limit per message. If we're over, truncate the
  // grocery section and follow up with the rest.
  if (final.length <= 2000) {
    await discord.editOriginal(interactionToken, final);
  } else {
    const head = [
      `✅ **Approved plan for week of ${weekOf}**`,
      '',
      planText,
      '',
      `🧊 ${remindersScheduled} defrost reminder(s) scheduled.`,
      '',
      '🛒 Grocery list (in follow-up):',
    ].join('\n');
    await discord.editOriginal(interactionToken, head);
    await discord.followUp(interactionToken, '🛒 **Grocery list:**\n\n' + groceryText.slice(0, 1900));
  }
}
