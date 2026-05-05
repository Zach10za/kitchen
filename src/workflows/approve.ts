import { WorkflowEntrypoint, type WorkflowStep, type WorkflowEvent } from 'cloudflare:workers';
import OpenAI from 'openai';
import type { Env } from '../env';
import type { GroceryItem, MealSlot, RecipeDetails } from '../agent/tools';
import { DiscordAPI } from '../discord/api';
import { renderPlan, renderGroceryList } from '../agent/render';

interface ApproveParams {
  weekOf: string;
  interactionToken: string;
}

const SHOP_FOR_RECIPE_PROMPT = `You convert ONE recipe's ingredients into grocery shopping items.

Output rules:
1. Use STORE units, not recipe units.
   - 200 g pasta → "1 lb" pasta
   - 2 cloves garlic → "1 head" garlic
   - 1/2 cup heavy cream → "1 pint" heavy cream
   - 1/2 cup grated parmesan → "1 small wedge" parmesan
   - 8 leaves fresh basil → "1 small bunch" fresh basil
   - 2 tbsp lemon juice + zest → "1 lemon"
   - 1/4 cup chopped onion → "1 yellow onion"
   - 4 oz mushrooms → "1 small package (8 oz)" mushrooms
   - 1 (15 oz) can chickpeas → "1 (15 oz) can" (already store unit, keep)
   - 1 lb ground beef → "1 lb" (already store unit, keep)
2. Skip these entirely (already stocked): salt, pepper, olive oil, cooking spray, water.
3. Skip anything in the user's pantry (listed in user message).
4. Dried spices (cumin, paprika, oregano, etc.): set qty to "" — name only.
5. Item names are receipt-style. Capitalize. No prep words ("Garlic" not "Garlic, minced").
6. Categorize: produce, protein, dairy, pantry, frozen, other.

Output GroceryItem[] for THIS recipe only. The list will be combined with other recipes' lists later — your job is just this recipe.`;

const COMBINE_GROCERY_PROMPT = `You merge per-recipe shopping items into ONE unified grocery list.

Rules:
1. DEDUPE: same shoppable item = ONE entry.
   - "Garlic" + "Garlic, minced" → ONE entry "Garlic"
   - "Lemons" + "Lemons" → ONE entry "Lemons"
   - "Unsalted butter" + "Butter" → ONE entry "Unsalted butter"
   - "Fresh basil" + "Basil" → ONE entry "Fresh basil"
2. SUM quantities sensibly when items are countable:
   - "Lemons, 2" + "Lemons, 3" → "Lemons, 5"
   - "Yellow onions, 2" + "Yellow onions, 1" → "Yellow onions, 3"
   - For non-countable / containers, keep the larger or the standard size:
     - "Pasta, 1 lb" + "Pasta, 1 lb" → "Pasta, 2 lb"
     - "Garlic, 1 head" + "Garlic, 1 head" → "Garlic, 1 head" (one head covers normal weekly use; only bump to 2 heads if recipe count is high)
     - "Heavy cream, 1 pint" + "Heavy cream, 1 pint" → "Heavy cream, 1 pint" (unless very heavy use, then 1 quart)
     - "Soy sauce, 1 bottle" → "1 bottle" (one bottle is sufficient)
3. Categorize each final entry: produce, protein, dairy, pantry, frozen, other.
4. Use receipt-style names.
5. Spices keep qty as "".

Return the final unified list. No duplicates. Real grocery quantities only.`;

const SHOPPING_LIST_PROMPT = `You translate a week of dinner recipes into a unified grocery shopping list. The cook reads this at the store — they need to know WHAT TO BUY in the units the store sells.

Your job has three parts and you must do all three:

1. DEDUPE. Merge every variant of the same shoppable item into ONE entry across all recipes. The user should never see two entries that map to the same trip-to-the-shelf.
   - "garlic" + "garlic cloves" + "minced garlic" + "1 clove" + "2 cloves" → ONE entry: Garlic
   - "butter" + "unsalted butter" + "1 tbsp butter" → ONE entry: Unsalted butter
   - "lemon juice" + "lemon zest" + "1/2 lemon" → ONE entry: Lemons
   - "fresh thyme" + "thyme leaves" + "thyme sprigs" → ONE entry: Fresh thyme
   - "parmesan" + "grated parmesan" + "parmigiano-reggiano" → ONE entry: Parmesan

2. TRANSFORM TO STORE UNITS. Recipe units (cup, tbsp, tsp, ml, g, cloves, leaves) are FORBIDDEN in the qty field. Convert to how the store sells the item:
   - 200 g pasta → 1 lb pasta
   - 2 cloves garlic → 1 head garlic
   - 1/2 cup heavy cream → 1 pint heavy cream
   - 1/2 cup grated parmesan → 1 small wedge parmesan
   - 8 leaves fresh basil → 1 small bunch fresh basil
   - 2 tbsp lemon juice + zest of 1 lemon → 2 lemons
   - 1/2 cup chopped onion + 1/4 cup diced onion → 2 medium onions
   - 4 oz mushrooms → 1 small package mushrooms (8 oz)
   - 3 oz feta → 1 small block feta (6 oz)
   - 1 (28 oz) can crushed tomatoes → 1 (28 oz) can crushed tomatoes (already store unit, keep it)
   - 1 lb ground beef → 1 lb ground beef (already store unit, keep it)
   When the recipe quantity already matches a store unit, keep it. When it doesn't (anything in cups/tbsp/tsp/ml/g/cloves/leaves/sprigs), CONVERT IT. Round UP to typical pack sizes.

3. CATEGORIZE into one of: produce, protein, dairy, pantry, frozen, other.
   - produce: fresh fruits, vegetables, fresh herbs
   - protein: meat, poultry, fish, tofu, eggs
   - dairy: milk, butter, cheese, yogurt, cream
   - pantry: oils, vinegars, canned goods, dry pasta/rice/beans, condiments, dried spices, sauces
   - frozen: anything sold frozen
   - other: anything that doesn't fit

OMIT ENTIRELY (never include in output): salt, pepper, olive oil, cooking spray, water, and anything the user already has in pantry/freezer (will be listed in user message).

For dried spices (cumin, paprika, oregano, chili powder, cinnamon, etc.), set qty to "" — the cook has them and container sizes are universal. Fresh herbs DO get quantities ("1 small bunch").

Item names should look like grocery receipt labels. Capitalize. Drop prep words ("minced", "chopped", "grated", "sliced"). "Garlic, minced" → "Garlic". "Onion, diced" → "Yellow onions".

REMEMBER: passing through recipe quantities ("200 g", "1/2 cup", "2 cloves") is the most common failure mode. Don't do it. Transform every quantity to a store unit.`;

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

/**
 * Durable approve flow. Each step.do(...) gets its own request lifetime and
 * automatic retries. Materialization steps run in parallel — if one recipe
 * call hangs, only that step retries, the others have already succeeded.
 *
 * Steps:
 *   1. load-draft        — fetch the draft from the DO
 *   2. announce          — initial Discord message
 *   3. materialize-{day} — 7 parallel steps, one per meal (each retries 2x)
 *   4. save-approved     — persist meals + schedule defrost reminders
 *   5. progress          — Discord update before grocery
 *   6. categorize        — LLM call to categorize aggregated ingredients
 *   7. save-grocery      — persist grocery list to DO
 *   8. final-post        — Discord message with the full plan + grocery list
 */
export class ApproveWorkflow extends WorkflowEntrypoint<Env, ApproveParams> {
  async run(event: WorkflowEvent<ApproveParams>, step: WorkflowStep) {
    const { weekOf, interactionToken } = event.payload;
    const discord = new DiscordAPI(this.env.DISCORD_BOT_TOKEN, this.env.DISCORD_APP_ID);
    const stub = this.kitchen();

    // Step 1: load the draft
    const draft = await step.do('load-draft', async () => {
      const res = await stub.fetch(`https://internal/workflow/load-draft?week_of=${weekOf}`);
      return (await res.json()) as { week_of: string; status: string; meals: MealSlot[] } | null;
    });

    if (!draft) {
      await step.do('post-no-draft', async () => {
        await discord.editOriginal(
          interactionToken,
          `No plan found for ${weekOf}. Use \`/draft\` to create one first.`
        );
      });
      return;
    }

    // If already approved, check whether the grocery list was actually built.
    // A previous workflow may have died mid-flight (approved meals saved but
    // grocery generation killed). Recover by running grocery from here.
    let needsMaterialization = true;
    if (draft.status === 'approved') {
      const groceryCheck = await step.do('check-grocery', async () => {
        const res = await stub.fetch(`https://internal/workflow/has-grocery?week_of=${weekOf}`);
        return ((await res.json()) as { exists: boolean }).exists;
      });
      if (groceryCheck) {
        await step.do('post-already-approved', async () => {
          await discord.editOriginal(
            interactionToken,
            `Plan for **${weekOf}** is already approved with grocery list. Use \`/grocery\` to see it.`
          );
        });
        return;
      }
      // Approved but grocery missing — skip materialization (already done),
      // jump straight to grocery generation.
      needsMaterialization = false;
      await step.do('announce-recovery', async () => {
        await discord.editOriginal(
          interactionToken,
          `🔧 Plan for **${weekOf}** is approved but grocery list is missing. Generating it now…`
        );
      });
    }

    // Steps 2-4: only run if not already materialized
    let materialized: MealSlot[] = draft.meals;
    let remindersScheduled = 0;

    if (needsMaterialization) {
      await step.do('announce', async () => {
        await discord.editOriginal(
          interactionToken,
          `🔒 Approving plan for week of **${weekOf}**…\n👨‍🍳 Generating full recipes (7 in parallel)…`
        );
      });

      // Step 3: materialize all 7 meals in parallel — each is independently retriable.
      materialized = await Promise.all(
        draft.meals.map((meal) =>
          step.do(
            `materialize-${meal.day}`,
            { retries: { limit: 2, delay: '2 seconds', backoff: 'linear' } },
            async (): Promise<MealSlot> => {
              if (meal.ingredients && meal.steps) return meal;
              const details = await this.materializeOne(meal);
              return { ...meal, ingredients: details.ingredients, steps: details.steps };
            }
          )
        )
      );

      // Step 4: save and schedule reminders
      remindersScheduled = await step.do('save-approved', async () => {
        const res = await stub.fetch('https://internal/workflow/save-approved', {
          method: 'POST',
          body: JSON.stringify({ week_of: weekOf, meals: materialized }),
        });
        return ((await res.json()) as { remindersScheduled: number }).remindersScheduled;
      });
    }

    // Step 5: progress update
    await step.do('progress-grocery', async () => {
      await discord.editOriginal(
        interactionToken,
        `🔒 Plan approved for **${weekOf}**\n👨‍🍳 ${materialized.length} recipes ready\n🧊 ${remindersScheduled} defrost reminder(s) scheduled\n🛒 Building grocery list…`
      );
    });

    // Step 6: load pantry so the LLM can exclude already-stocked items.
    const pantry = await step.do('load-pantry', async () => {
      const res = await stub.fetch('https://internal/workflow/get-pantry');
      return (await res.json()) as { name: string }[];
    });

    // Step 7a: per-recipe shopping lists in parallel. Each call sees one
    // small recipe (~10 items), runs in parallel, has its own retry budget.
    // Wall-clock = max(per-recipe latency) instead of sum.
    const pantryNames = pantry.map((p) => p.name);
    const perRecipeLists = await Promise.all(
      materialized.map((meal) =>
        step.do(
          `shop-${meal.day}`,
          { retries: { limit: 2, delay: '2 seconds', backoff: 'linear' } },
          async (): Promise<GroceryItem[]> => {
            return await this.shopForRecipe(meal, pantryNames);
          }
        )
      )
    );

    // Step 7b: combine the 7 lists into one unified grocery list.
    // Input is small (~50 items already in store units), so this is fast.
    const groceryItems = await step.do(
      'combine-grocery',
      { retries: { limit: 2, delay: '2 seconds', backoff: 'linear' } },
      async (): Promise<GroceryItem[]> => {
        return await this.combineGroceryLists(perRecipeLists);
      }
    );

    // Step 8: save grocery list
    await step.do('save-grocery', async () => {
      await stub.fetch('https://internal/workflow/save-grocery', {
        method: 'POST',
        body: JSON.stringify({ week_of: weekOf, items: groceryItems }),
      });
    });

    // Step 9: final Discord message
    await step.do('final-post', async () => {
      const planText = renderPlan({
        week_of: weekOf,
        status: 'approved',
        meals_json: JSON.stringify(materialized),
        constraints_json: '[]',
        drafted_at: 0,
        approved_at: Date.now(),
      } as any);
      const groceryText = renderGroceryList(groceryItems);

      const head = [
        `✅ **Approved plan for week of ${weekOf}**`,
        '',
        planText,
        '',
        `🧊 ${remindersScheduled} defrost reminder(s) scheduled.`,
        '',
        '🛒 Grocery list incoming…',
      ].join('\n');

      await discord.editOriginal(interactionToken, head.slice(0, 2000));
      // Send grocery sections as separate follow-up messages.
      const groceryChunks = chunkBy(groceryText, 1900);
      for (const chunk of groceryChunks) {
        await discord.followUp(interactionToken, chunk);
      }
    });
  }

  private kitchen() {
    const id = this.env.KITCHEN.idFromName('default-household');
    return this.env.KITCHEN.get(id);
  }

  private openai(): OpenAI {
    return new OpenAI({
      apiKey: this.env.OPENAI_API_KEY,
      baseURL: this.env.AI_GATEWAY_URL || undefined,
      timeout: 180_000,
      maxRetries: 1,
    });
  }

  private async materializeOne(meal: MealSlot): Promise<RecipeDetails> {
    // Use gpt-5-nano for materialization — pure pattern-matching ("given a
    // dish, list ingredients + steps"), no creative judgment needed.
    // AbortController is the reliable way to timeout in the Workflow runtime
    // (the SDK's `timeout` option doesn't always fire here).
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 180_000);
    try {
      const completion = await this.openai().chat.completions.create(
        {
          model: 'gpt-5-nano',
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
        },
        { signal: ac.signal }
      );
      const content = completion.choices[0]?.message.content;
      if (!content) throw new Error('Recipe materialization returned no content');
      return JSON.parse(content) as RecipeDetails;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Build a grocery list for ONE recipe. Small input, focused task —
   * gpt-5-mini handles this reliably in 3-8s.
   */
  private async shopForRecipe(
    meal: MealSlot,
    pantry: string[]
  ): Promise<GroceryItem[]> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60_000);
    try {
      const completion = await this.openai().chat.completions.create(
        {
          model: 'gpt-5-mini',
          messages: [
            { role: 'system', content: SHOP_FOR_RECIPE_PROMPT },
            {
              role: 'user',
              content: [
                `Recipe: ${meal.name} (${meal.cuisine}, serves ${meal.servings})`,
                '',
                pantry.length > 0
                  ? `Items I already have (skip these):\n${pantry.map((p) => `- ${p}`).join('\n')}\n`
                  : '',
                'Ingredients:',
                ...(meal.ingredients ?? []).map((i) => `- ${i.qty} ${i.item}`),
              ].filter(Boolean).join('\n'),
            },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'grocery', schema: GROCERY_SCHEMA, strict: true },
          },
        },
        { signal: ac.signal }
      );
      const content = completion.choices[0]?.message.content;
      if (!content) throw new Error('Per-recipe grocery returned no content');
      return (JSON.parse(content) as { items: GroceryItem[] }).items;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Merge 7 per-recipe shopping lists into one unified list. Input is small
   * (already-store-format items, ~50 total). gpt-5-mini handles this fast.
   */
  private async combineGroceryLists(
    lists: GroceryItem[][]
  ): Promise<GroceryItem[]> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60_000);
    try {
      const flat = lists.flat();
      const completion = await this.openai().chat.completions.create(
        {
          model: 'gpt-5-mini',
          messages: [
            { role: 'system', content: COMBINE_GROCERY_PROMPT },
            {
              role: 'user',
              content: [
                'Combine these per-recipe shopping items into ONE unified list.',
                '',
                '```json',
                JSON.stringify(flat, null, 2),
                '```',
              ].join('\n'),
            },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'grocery', schema: GROCERY_SCHEMA, strict: true },
          },
        },
        { signal: ac.signal }
      );
      const content = completion.choices[0]?.message.content;
      if (!content) throw new Error('Combine grocery returned no content');
      return (JSON.parse(content) as { items: GroceryItem[] }).items;
    } finally {
      clearTimeout(timer);
    }
  }

  // Kept for fallback / experimentation, no longer called from run().
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async categorizeGrocery(
    aggregated: { item: string; qty: string; servings: number }[]
  ): Promise<GroceryItem[]> {
    // Explicit AbortController timeout — the OpenAI SDK's `timeout` config
    // doesn't reliably fire inside the Workflow runtime, so we enforce it
    // ourselves. 90s is generous; categorize usually returns in 10-20s.
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 180_000);
    try {
      const completion = await this.openai().chat.completions.create(
        {
          // Use nano — pure classification task, no creativity needed.
          model: 'gpt-5-nano',
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
        },
        { signal: ac.signal }
      );
      const content = completion.choices[0]?.message.content;
      if (!content) throw new Error('Grocery categorization returned no content');
      return (JSON.parse(content) as { items: GroceryItem[] }).items;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ─── Deterministic grocery categorization ──────────────────────────────────
//
// Keyword-based merging + categorization. Faster, free, and never hangs.

const PROTEIN_WORDS = [
  'chicken', 'beef', 'pork', 'lamb', 'bacon', 'sausage', 'turkey', 'ham',
  'salmon', 'tuna', 'shrimp', 'cod', 'tilapia', 'trout', 'fish', 'scallop',
  'tofu', 'tempeh', 'egg', 'eggs',
];
const DAIRY_WORDS = [
  'milk', 'cream', 'cheese', 'butter', 'yogurt', 'sour cream', 'half-and-half',
  'parmesan', 'mozzarella', 'feta', 'ricotta', 'gruyere', 'cheddar',
];
const PRODUCE_WORDS = [
  'onion', 'garlic', 'shallot', 'leek', 'scallion', 'green onion', 'tomato',
  'lettuce', 'carrot', 'celery', 'pepper', 'cilantro', 'parsley', 'basil',
  'thyme', 'rosemary', 'mint', 'dill', 'lemon', 'lime', 'orange', 'avocado',
  'spinach', 'kale', 'arugula', 'broccoli', 'cauliflower', 'potato', 'sweet potato',
  'mushroom', 'cucumber', 'zucchini', 'squash', 'eggplant', 'apple', 'banana',
  'berry', 'grape', 'cabbage', 'fennel', 'ginger', 'jalapeño', 'jalapeno',
  'serrano', 'asparagus', 'green bean', 'corn',
];
const FROZEN_WORDS = ['frozen', 'ice cream'];

// Chunks a long string into pieces fitting Discord's 2000-char message limit.
// Splits on newlines first to keep sections intact when possible.
function chunkBy(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  const lines = text.split('\n');
  let current = '';
  for (const line of lines) {
    if ((current + '\n' + line).length > limit && current.length > 0) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ─── Deterministic grocery list builder ───────────────────────────────────
//
// Maps recipe ingredients to grocery shopping items. Each rule defines:
//   - matches: substring patterns (lowercase) that identify the ingredient
//   - storeName: how it should appear on the receipt
//   - storeQty: store-buyable quantity (or function for count-based items)
//   - category: produce | protein | dairy | pantry | frozen | other

interface GroceryRule {
  matches: string[];                                    // any substring matches
  storeName: string;
  storeQty: string | ((uses: number) => string);        // 'uses' = number of recipes using this
  category: GroceryItem['category'];
}

// Counts how many recipes used the item, used for variable-qty rules.
const countingFn = (uses: number) => `${uses}`;
const minCountingFn = (min: number) => (uses: number) => `${Math.max(min, uses)}`;

const GROCERY_RULES: GroceryRule[] = [
  // PROTEINS — sold by weight
  { matches: ['ground beef', 'lean ground beef'], storeName: 'Ground beef', storeQty: '1 lb', category: 'protein' },
  { matches: ['ground turkey'], storeName: 'Ground turkey', storeQty: '1 lb', category: 'protein' },
  { matches: ['ground pork'], storeName: 'Ground pork', storeQty: '1 lb', category: 'protein' },
  { matches: ['chicken thigh', 'boneless chicken'], storeName: 'Boneless chicken thighs', storeQty: '1.5 lb', category: 'protein' },
  { matches: ['chicken breast'], storeName: 'Chicken breasts', storeQty: '1.5 lb', category: 'protein' },
  { matches: ['chicken wings', 'chicken wing'], storeName: 'Chicken wings', storeQty: '2 lb', category: 'protein' },
  { matches: ['salmon fillet', 'salmon'], storeName: 'Salmon fillets', storeQty: '1 lb', category: 'protein' },
  { matches: ['shrimp'], storeName: 'Shrimp', storeQty: '1 lb', category: 'protein' },
  { matches: ['scallop'], storeName: 'Scallops', storeQty: '1 lb', category: 'protein' },
  { matches: ['cod'], storeName: 'Cod fillets', storeQty: '1 lb', category: 'protein' },
  { matches: ['pork chop'], storeName: 'Pork chops', storeQty: '1.5 lb', category: 'protein' },
  { matches: ['pork tenderloin'], storeName: 'Pork tenderloin', storeQty: '1', category: 'protein' },
  { matches: ['tri-tip', 'tri tip'], storeName: 'Tri-tip steak', storeQty: '1.5 lb', category: 'protein' },
  { matches: ['ribeye', 'rib eye', 'rib-eye'], storeName: 'Ribeye steak', storeQty: '1 lb', category: 'protein' },
  { matches: ['strip steak'], storeName: 'Strip steak', storeQty: '1 lb', category: 'protein' },
  { matches: ['flank steak', 'skirt steak'], storeName: 'Flank steak', storeQty: '1.5 lb', category: 'protein' },
  { matches: ['bacon'], storeName: 'Bacon', storeQty: '1 package', category: 'protein' },
  { matches: ['italian sausage', 'sausage'], storeName: 'Italian sausage', storeQty: '1 lb', category: 'protein' },
  { matches: ['tofu'], storeName: 'Firm tofu', storeQty: '1 block', category: 'protein' },
  { matches: ['eggs', 'egg '], storeName: 'Eggs', storeQty: '1 dozen', category: 'protein' },

  // DAIRY
  { matches: ['heavy cream', 'heavy whipping cream'], storeName: 'Heavy cream', storeQty: '1 pint', category: 'dairy' },
  { matches: ['half-and-half', 'half and half'], storeName: 'Half-and-half', storeQty: '1 pint', category: 'dairy' },
  { matches: ['whole milk', 'milk'], storeName: 'Whole milk', storeQty: '1 quart', category: 'dairy' },
  { matches: ['butter'], storeName: 'Unsalted butter', storeQty: '1 lb (4 sticks)', category: 'dairy' },
  { matches: ['greek yogurt', 'plain yogurt', 'yogurt'], storeName: 'Greek yogurt', storeQty: '1 large container (32 oz)', category: 'dairy' },
  { matches: ['sour cream'], storeName: 'Sour cream', storeQty: '1 small tub (8 oz)', category: 'dairy' },
  { matches: ['cream cheese'], storeName: 'Cream cheese', storeQty: '1 block (8 oz)', category: 'dairy' },
  { matches: ['parmesan', 'parmigiano'], storeName: 'Parmesan', storeQty: '1 small wedge', category: 'dairy' },
  { matches: ['ricotta salata'], storeName: 'Ricotta salata', storeQty: '1 small wedge', category: 'dairy' },
  { matches: ['ricotta'], storeName: 'Ricotta cheese', storeQty: '1 small tub (15 oz)', category: 'dairy' },
  { matches: ['mozzarella, fresh', 'fresh mozzarella'], storeName: 'Fresh mozzarella', storeQty: '1 ball', category: 'dairy' },
  { matches: ['mozzarella'], storeName: 'Shredded mozzarella', storeQty: '1 small bag (8 oz)', category: 'dairy' },
  { matches: ['feta'], storeName: 'Feta', storeQty: '1 small block (6 oz)', category: 'dairy' },
  { matches: ['cheddar'], storeName: 'Cheddar', storeQty: '1 block (8 oz)', category: 'dairy' },
  { matches: ['gruyere', 'gruyère'], storeName: 'Gruyère', storeQty: '1 small wedge', category: 'dairy' },
  { matches: ['cotija'], storeName: 'Cotija', storeQty: '1 small block (6 oz)', category: 'dairy' },

  // PRODUCE — by count
  { matches: ['lemon'], storeName: 'Lemons', storeQty: minCountingFn(2), category: 'produce' },
  { matches: ['lime'], storeName: 'Limes', storeQty: minCountingFn(2), category: 'produce' },
  { matches: ['orange'], storeName: 'Oranges', storeQty: minCountingFn(2), category: 'produce' },
  { matches: ['yellow onion', 'onion, yellow'], storeName: 'Yellow onions', storeQty: countingFn, category: 'produce' },
  { matches: ['red onion'], storeName: 'Red onion', storeQty: '1', category: 'produce' },
  { matches: ['white onion', 'onion'], storeName: 'Yellow onions', storeQty: countingFn, category: 'produce' },
  { matches: ['shallot'], storeName: 'Shallots', storeQty: countingFn, category: 'produce' },
  { matches: ['garlic'], storeName: 'Garlic', storeQty: '1 head', category: 'produce' },
  { matches: ['ginger'], storeName: 'Fresh ginger', storeQty: '1 small piece', category: 'produce' },
  { matches: ['eggplant'], storeName: 'Eggplant', storeQty: countingFn, category: 'produce' },
  { matches: ['zucchini'], storeName: 'Zucchini', storeQty: countingFn, category: 'produce' },
  { matches: ['cherry tomato', 'grape tomato'], storeName: 'Cherry tomatoes', storeQty: '1 pint', category: 'produce' },
  { matches: ['roma tomato', 'tomato, fresh', 'fresh tomato'], storeName: 'Roma tomatoes', storeQty: countingFn, category: 'produce' },
  { matches: ['tomato'], storeName: 'Tomatoes', storeQty: countingFn, category: 'produce' },
  { matches: ['avocado'], storeName: 'Avocados', storeQty: countingFn, category: 'produce' },
  { matches: ['cucumber'], storeName: 'Cucumbers', storeQty: countingFn, category: 'produce' },
  { matches: ['bell pepper, red', 'red bell pepper'], storeName: 'Red bell peppers', storeQty: countingFn, category: 'produce' },
  { matches: ['bell pepper'], storeName: 'Bell peppers', storeQty: countingFn, category: 'produce' },
  { matches: ['jalapeño', 'jalapeno'], storeName: 'Jalapeños', storeQty: minCountingFn(2), category: 'produce' },
  { matches: ['serrano'], storeName: 'Serrano peppers', storeQty: minCountingFn(2), category: 'produce' },
  { matches: ['carrot'], storeName: 'Carrots', storeQty: '1 small bag', category: 'produce' },
  { matches: ['celery'], storeName: 'Celery', storeQty: '1 bunch', category: 'produce' },
  { matches: ['potato, russet', 'russet potato'], storeName: 'Russet potatoes', storeQty: '2 lb', category: 'produce' },
  { matches: ['yukon gold', 'baby potato', 'baby yukon'], storeName: 'Yukon gold potatoes', storeQty: '2 lb', category: 'produce' },
  { matches: ['sweet potato'], storeName: 'Sweet potatoes', storeQty: countingFn, category: 'produce' },
  { matches: ['potato'], storeName: 'Yukon gold potatoes', storeQty: '2 lb', category: 'produce' },
  { matches: ['mushroom'], storeName: 'Mushrooms', storeQty: '1 small package (8 oz)', category: 'produce' },
  { matches: ['kale'], storeName: 'Kale', storeQty: '1 bunch', category: 'produce' },
  { matches: ['spinach'], storeName: 'Spinach', storeQty: '1 bag (5 oz)', category: 'produce' },
  { matches: ['arugula'], storeName: 'Arugula', storeQty: '1 bag (5 oz)', category: 'produce' },
  { matches: ['romaine'], storeName: 'Romaine', storeQty: '1 head', category: 'produce' },
  { matches: ['lettuce'], storeName: 'Lettuce', storeQty: '1 head', category: 'produce' },
  { matches: ['cabbage, napa', 'napa cabbage'], storeName: 'Napa cabbage', storeQty: '1 small head', category: 'produce' },
  { matches: ['cabbage'], storeName: 'Cabbage', storeQty: '1 small head', category: 'produce' },
  { matches: ['broccoli'], storeName: 'Broccoli', storeQty: '1 small head', category: 'produce' },
  { matches: ['cauliflower'], storeName: 'Cauliflower', storeQty: '1 small head', category: 'produce' },
  { matches: ['brussels sprout'], storeName: 'Brussels sprouts', storeQty: '1 lb', category: 'produce' },
  { matches: ['asparagus'], storeName: 'Asparagus', storeQty: '1 bunch', category: 'produce' },
  { matches: ['green bean'], storeName: 'Green beans', storeQty: '1 lb', category: 'produce' },
  { matches: ['snap pea', 'sugar snap'], storeName: 'Sugar snap peas', storeQty: '8 oz', category: 'produce' },
  { matches: ['scallion', 'green onion'], storeName: 'Scallions', storeQty: '1 bunch', category: 'produce' },
  { matches: ['cilantro'], storeName: 'Fresh cilantro', storeQty: '1 small bunch', category: 'produce' },
  { matches: ['parsley'], storeName: 'Fresh parsley', storeQty: '1 small bunch', category: 'produce' },
  { matches: ['fresh basil', 'basil leaves', 'basil, fresh', 'basil'], storeName: 'Fresh basil', storeQty: '1 small bunch', category: 'produce' },
  { matches: ['fresh thyme', 'thyme, fresh'], storeName: 'Fresh thyme', storeQty: '1 small bunch', category: 'produce' },
  { matches: ['fresh rosemary', 'rosemary, fresh'], storeName: 'Fresh rosemary', storeQty: '1 small bunch', category: 'produce' },
  { matches: ['mint'], storeName: 'Fresh mint', storeQty: '1 small bunch', category: 'produce' },
  { matches: ['dill, fresh', 'fresh dill'], storeName: 'Fresh dill', storeQty: '1 small bunch', category: 'produce' },

  // PANTRY — packaged goods
  { matches: ['spaghetti', 'rigatoni', 'penne', 'fettuccine', 'linguine', 'orecchiette', 'rotini', 'fusilli'], storeName: 'Pasta', storeQty: '1 lb', category: 'pantry' },
  { matches: ['pasta'], storeName: 'Pasta', storeQty: '1 lb', category: 'pantry' },
  { matches: ['rice, jasmine', 'jasmine rice'], storeName: 'Jasmine rice', storeQty: '2 lb', category: 'pantry' },
  { matches: ['basmati'], storeName: 'Basmati rice', storeQty: '2 lb', category: 'pantry' },
  { matches: ['arborio'], storeName: 'Arborio rice', storeQty: '1 lb', category: 'pantry' },
  { matches: ['rice'], storeName: 'Rice', storeQty: '2 lb', category: 'pantry' },
  { matches: ['polenta'], storeName: 'Polenta', storeQty: '1 package', category: 'pantry' },
  { matches: ['couscous'], storeName: 'Couscous', storeQty: '1 box', category: 'pantry' },
  { matches: ['quinoa'], storeName: 'Quinoa', storeQty: '1 lb', category: 'pantry' },
  { matches: ['orzo'], storeName: 'Orzo', storeQty: '1 lb', category: 'pantry' },
  { matches: ['crushed tomato'], storeName: 'Crushed tomatoes', storeQty: '1 (28 oz) can', category: 'pantry' },
  { matches: ['diced tomato', 'tomatoes, diced'], storeName: 'Diced tomatoes', storeQty: '1 (28 oz) can', category: 'pantry' },
  { matches: ['tomato sauce'], storeName: 'Tomato sauce', storeQty: '1 jar', category: 'pantry' },
  { matches: ['tomato paste'], storeName: 'Tomato paste', storeQty: '1 small can', category: 'pantry' },
  { matches: ['chicken broth', 'chicken stock'], storeName: 'Chicken broth', storeQty: '1 carton', category: 'pantry' },
  { matches: ['vegetable broth', 'vegetable stock'], storeName: 'Vegetable broth', storeQty: '1 carton', category: 'pantry' },
  { matches: ['beef broth', 'beef stock'], storeName: 'Beef broth', storeQty: '1 carton', category: 'pantry' },
  { matches: ['soy sauce'], storeName: 'Soy sauce', storeQty: '1 bottle', category: 'pantry' },
  { matches: ['sesame oil'], storeName: 'Sesame oil', storeQty: '1 small bottle', category: 'pantry' },
  { matches: ['rice vinegar'], storeName: 'Rice vinegar', storeQty: '1 bottle', category: 'pantry' },
  { matches: ['white wine vinegar'], storeName: 'White wine vinegar', storeQty: '1 bottle', category: 'pantry' },
  { matches: ['red wine vinegar'], storeName: 'Red wine vinegar', storeQty: '1 bottle', category: 'pantry' },
  { matches: ['balsamic vinegar'], storeName: 'Balsamic vinegar', storeQty: '1 bottle', category: 'pantry' },
  { matches: ['apple cider vinegar', 'cider vinegar'], storeName: 'Apple cider vinegar', storeQty: '1 bottle', category: 'pantry' },
  { matches: ['mirin'], storeName: 'Mirin', storeQty: '1 bottle', category: 'pantry' },
  { matches: ['fish sauce'], storeName: 'Fish sauce', storeQty: '1 bottle', category: 'pantry' },
  { matches: ['oyster sauce'], storeName: 'Oyster sauce', storeQty: '1 bottle', category: 'pantry' },
  { matches: ['hoisin'], storeName: 'Hoisin sauce', storeQty: '1 jar', category: 'pantry' },
  { matches: ['gochujang'], storeName: 'Gochujang', storeQty: '1 tub', category: 'pantry' },
  { matches: ['miso'], storeName: 'White miso', storeQty: '1 tub', category: 'pantry' },
  { matches: ['tahini'], storeName: 'Tahini', storeQty: '1 jar', category: 'pantry' },
  { matches: ['dijon mustard', 'dijon'], storeName: 'Dijon mustard', storeQty: '1 jar', category: 'pantry' },
  { matches: ['worcestershire'], storeName: 'Worcestershire sauce', storeQty: '1 bottle', category: 'pantry' },
  { matches: ['honey'], storeName: 'Honey', storeQty: '1 jar', category: 'pantry' },
  { matches: ['maple syrup'], storeName: 'Maple syrup', storeQty: '1 small bottle', category: 'pantry' },
  { matches: ['brown sugar'], storeName: 'Brown sugar', storeQty: '1 box', category: 'pantry' },
  { matches: ['chickpea', 'garbanzo'], storeName: 'Chickpeas', storeQty: '1 (15 oz) can', category: 'pantry' },
  { matches: ['black bean'], storeName: 'Black beans', storeQty: '1 (15 oz) can', category: 'pantry' },
  { matches: ['pinto bean'], storeName: 'Pinto beans', storeQty: '1 (15 oz) can', category: 'pantry' },
  { matches: ['kidney bean'], storeName: 'Kidney beans', storeQty: '1 (15 oz) can', category: 'pantry' },
  { matches: ['cannellini', 'white bean'], storeName: 'Cannellini beans', storeQty: '1 (15 oz) can', category: 'pantry' },
  { matches: ['lentil'], storeName: 'Lentils', storeQty: '1 lb', category: 'pantry' },
  { matches: ['coconut milk'], storeName: 'Coconut milk', storeQty: '1 (14 oz) can', category: 'pantry' },
  { matches: ['curry paste, red', 'red curry paste'], storeName: 'Red curry paste', storeQty: '1 small jar', category: 'pantry' },
  { matches: ['curry paste, green', 'green curry paste'], storeName: 'Green curry paste', storeQty: '1 small jar', category: 'pantry' },
  { matches: ['breadcrumb', 'panko'], storeName: 'Panko breadcrumbs', storeQty: '1 box', category: 'pantry' },
  { matches: ['flour, all-purpose', 'all-purpose flour'], storeName: 'All-purpose flour', storeQty: '1 bag', category: 'pantry' },
  { matches: ['cornstarch'], storeName: 'Cornstarch', storeQty: '1 small box', category: 'pantry' },
  { matches: ['baking soda'], storeName: 'Baking soda', storeQty: '1 box', category: 'pantry' },
  { matches: ['baking powder'], storeName: 'Baking powder', storeQty: '1 small can', category: 'pantry' },
  { matches: ['tortilla, corn', 'corn tortilla'], storeName: 'Corn tortillas', storeQty: '1 package', category: 'pantry' },
  { matches: ['tortilla, flour', 'flour tortilla'], storeName: 'Flour tortillas', storeQty: '1 package', category: 'pantry' },
  { matches: ['bread, crusty', 'crusty bread', 'baguette'], storeName: 'Crusty bread', storeQty: '1 loaf', category: 'pantry' },
];

const STAPLE_PATTERNS_RE = [
  /\bsalt\b/i,
  /\bpepper(corns?)?\b/i,
  /\bolive oil\b/i,
  /\bcooking spray\b/i,
  /^water$/i,
];

const SPICE_PATTERNS_RE = [
  /\bcumin\b/i, /\bpaprika\b/i, /\boregano\b/i, /\bdried thyme\b/i,
  /\bdried basil\b/i, /\bchili powder\b/i, /\bcinnamon\b/i, /\bnutmeg\b/i,
  /\bgaram masala\b/i, /\bcurry powder\b/i, /\bturmeric\b/i, /\bcayenne\b/i,
  /red pepper flakes/i, /\ballspice\b/i, /\bcardamom\b/i, /\bcoriander\b/i,
  /\bsmoked paprika\b/i, /\bsumac\b/i, /\bdried dill\b/i,
  /\bbay leaves?\b/i, /\bground ginger\b/i, /\bonion powder\b/i,
  /\bgarlic powder\b/i,
];

/**
 * Build a grocery list from raw recipe ingredients using the rules table.
 * Each rule maps recipe-ingredient patterns to store-buyable items.
 * Unknown items pass through with their original recipe info.
 */
function buildGroceryListFromIngredients(
  rawItems: { item: string; qty: string; servings: number }[]
): GroceryItem[] {
  // Group raw items by which rule they match (or 'unknown' if none).
  type Bucket = {
    storeName: string;
    storeQty: string | ((uses: number) => string);
    category: GroceryItem['category'];
    uses: number;
    rawNames: Set<string>;
  };
  const buckets: Record<string, Bucket> = {};
  const unknowns: { item: string; qty: string }[] = [];

  for (const raw of rawItems) {
    const name = raw.item.toLowerCase();

    // Skip always-stocked staples entirely.
    if (STAPLE_PATTERNS_RE.some((p) => p.test(name))) continue;

    // Spices: name only, no qty.
    if (SPICE_PATTERNS_RE.some((p) => p.test(name))) {
      const niceName = titleCase(stripPrep(raw.item));
      const key = `spice:${niceName.toLowerCase()}`;
      if (!buckets[key]) {
        buckets[key] = {
          storeName: niceName,
          storeQty: '',
          category: 'pantry',
          uses: 0,
          rawNames: new Set(),
        };
      }
      buckets[key].uses++;
      buckets[key].rawNames.add(raw.item);
      continue;
    }

    // Match against rules table.
    let matched = false;
    for (const rule of GROCERY_RULES) {
      if (rule.matches.some((m) => name.includes(m))) {
        const key = rule.storeName;
        if (!buckets[key]) {
          buckets[key] = {
            storeName: rule.storeName,
            storeQty: rule.storeQty,
            category: rule.category,
            uses: 0,
            rawNames: new Set(),
          };
        }
        buckets[key].uses++;
        buckets[key].rawNames.add(raw.item);
        matched = true;
        break;
      }
    }
    if (!matched) {
      unknowns.push({ item: raw.item, qty: raw.qty });
    }
  }

  // Resolve buckets to grocery items.
  const out: GroceryItem[] = Object.values(buckets).map((b) => ({
    item: b.storeName,
    qty: typeof b.storeQty === 'function' ? b.storeQty(b.uses) : b.storeQty,
    category: b.category,
  }));

  // Append unknowns with a flag so the user can spot them.
  const uniqueUnknowns: Record<string, string> = {};
  for (const u of unknowns) {
    const key = u.item.toLowerCase().trim();
    if (!uniqueUnknowns[key]) uniqueUnknowns[key] = u.qty;
  }
  for (const [name, qty] of Object.entries(uniqueUnknowns)) {
    out.push({
      item: titleCase(stripPrep(name)) + ' _(review)_',
      qty: qty,
      category: 'other',
    });
  }

  return out;
}

function stripPrep(name: string): string {
  return name
    .replace(/,\s*(minced|chopped|diced|grated|sliced|crushed|torn|halved|quartered|cubed|julienned|shredded|ground|finely chopped|finely diced|roughly chopped|peeled|seeded|stemmed|trimmed|drained|rinsed|cooked).*/i, '')
    .replace(/\b(minced|chopped|diced|grated|sliced|crushed|torn|halved|quartered|cubed|julienned|shredded|finely chopped|finely diced|roughly chopped)\b/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/\(.*?\)/g, '')
    .trim();
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Staple filtering & spice handling ────────────────────────────────────

const ALWAYS_STOCKED_PATTERNS = [
  /\bsalt\b/i,
  /\bpepper(corns?)?\b/i,
  /\bolive oil\b/i,
  /\bcooking spray\b/i,
  /^water$/i,
];

const SPICE_PATTERNS = [
  /\bcumin\b/i, /\bpaprika\b/i, /\boregano\b/i, /\bdried thyme\b/i,
  /\bdried basil\b/i, /\bchili powder\b/i, /\bcinnamon\b/i, /\bnutmeg\b/i,
  /\bgaram masala\b/i, /\bcurry powder\b/i, /\bturmeric\b/i, /\bcayenne\b/i,
  /red pepper flakes/i, /\ballspice\b/i, /\bcardamom\b/i, /\bcoriander\b/i,
  /\bsmoked paprika\b/i, /\bsumac\b/i, /\bdried dill\b/i,
  /\bbay leaves?\b/i, /\bground ginger\b/i, /\bonion powder\b/i,
  /\bgarlic powder\b/i,
];

function isAlwaysStocked(name: string): boolean {
  return ALWAYS_STOCKED_PATTERNS.some((p) => p.test(name));
}

function isSpice(name: string): boolean {
  return SPICE_PATTERNS.some((p) => p.test(name));
}

function postProcessGrocery(items: GroceryItem[]): GroceryItem[] {
  return items
    .filter((i) => !isAlwaysStocked(i.item))
    .map((i) => (isSpice(i.item) ? { ...i, qty: '' } : i));
}

/**
 * Cheap pre-merge: collapse exact-name duplicates by lowercased key. Reduces
 * the input the LLM has to reason about, improving reliability.
 */
function preMergeExact(
  items: { item: string; qty: string; servings: number }[]
): { item: string; qty: string }[] {
  const merged: Record<string, { item: string; qty: string }> = {};
  for (const it of items) {
    const key = it.item.toLowerCase().trim();
    if (!merged[key]) {
      merged[key] = { item: it.item, qty: it.qty };
    } else if (!merged[key].qty.includes(it.qty)) {
      merged[key].qty = `${merged[key].qty} + ${it.qty}`;
    }
  }
  return Object.values(merged);
}

function categorizeDeterministically(
  items: { item: string; qty: string; servings: number }[]
): GroceryItem[] {
  // Merge by lowercased name. When a duplicate is encountered, concat the
  // quantity strings — we don't try to numerically sum since "1 lb" + "200 g"
  // would need unit conversion.
  const merged: Record<string, { item: string; qty: string }> = {};
  for (const it of items) {
    const key = it.item.toLowerCase().trim();
    if (!merged[key]) {
      merged[key] = { item: it.item, qty: it.qty };
    } else {
      // Avoid duplicating identical qty strings (common case: same recipe items
      // referenced twice with the same quantity).
      if (!merged[key].qty.includes(it.qty)) {
        merged[key].qty = `${merged[key].qty} + ${it.qty}`;
      }
    }
  }

  return Object.values(merged).map((m) => ({
    item: m.item,
    qty: m.qty,
    category: pickCategory(m.item),
  }));
}

function pickCategory(name: string): GroceryItem['category'] {
  const lower = name.toLowerCase();
  if (FROZEN_WORDS.some((w) => lower.includes(w))) return 'frozen';
  if (PROTEIN_WORDS.some((w) => lower.includes(w))) return 'protein';
  if (DAIRY_WORDS.some((w) => lower.includes(w))) return 'dairy';
  if (PRODUCE_WORDS.some((w) => lower.includes(w))) return 'produce';
  return 'pantry';
}
