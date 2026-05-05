import { WorkflowEntrypoint, type WorkflowStep, type WorkflowEvent } from 'cloudflare:workers';
import OpenAI from 'openai';
import type { Env } from '../env';
import type { GroceryItem, MealSlot, RecipeDetails } from '../agent/tools';
import { GROCERY_SCHEMA, RECIPE_DETAILS_SCHEMA } from '../agent/schemas';
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
     - "Garlic, 1 head" + "Garlic, 1 head" → "Garlic, 1 head" (one head covers normal weekly use)
     - "Heavy cream, 1 pint" + "Heavy cream, 1 pint" → "Heavy cream, 1 pint"
     - "Soy sauce, 1 bottle" → "1 bottle" (one bottle is sufficient)
3. Categorize each final entry: produce, protein, dairy, pantry, frozen, other.
4. Use receipt-style names.
5. Spices keep qty as "".

Return the final unified list. No duplicates. Real grocery quantities only.`;

/**
 * Durable approve flow. Each step.do(...) gets its own request lifetime + retries.
 *
 * Steps:
 *   1. load-draft         — fetch the draft from the DO
 *   2. check-grocery      — recover-from-partial: if approved+no grocery, skip to grocery
 *   3. announce + materialize-{day} (parallel) + save-approved
 *   4. progress-grocery   — Discord update
 *   5. load-pantry        — pantry items to exclude
 *   6. shop-{day} (parallel) + combine-grocery — per-recipe + merge
 *   7. save-grocery       — persist
 *   8. final-post         — Discord message with plan + grocery list
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

    // Recovery: if already approved, check whether grocery list was actually built.
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

      // Materialize 7 meals in parallel — each independently retriable.
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

      // save-approved is idempotent: only flips status if not already approved.
      // This guards against retry-induced timestamp clobber.
      remindersScheduled = await step.do('save-approved', async () => {
        const res = await stub.fetch('https://internal/workflow/save-approved', {
          method: 'POST',
          body: JSON.stringify({ week_of: weekOf, meals: materialized }),
        });
        return ((await res.json()) as { remindersScheduled: number }).remindersScheduled;
      });
    }

    await step.do('progress-grocery', async () => {
      await discord.editOriginal(
        interactionToken,
        `🔒 Plan approved for **${weekOf}**\n👨‍🍳 ${materialized.length} recipes ready\n🧊 ${remindersScheduled} defrost reminder(s) scheduled\n🛒 Building grocery list…`
      );
    });

    const pantry = await step.do('load-pantry', async () => {
      const res = await stub.fetch('https://internal/workflow/get-pantry');
      return (await res.json()) as { name: string }[];
    });

    // Per-recipe shopping lists in parallel. Wall-clock = max(per-recipe latency).
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

    // Combine the 7 lists into one unified list.
    const groceryItems = await step.do(
      'combine-grocery',
      { retries: { limit: 2, delay: '2 seconds', backoff: 'linear' } },
      async (): Promise<GroceryItem[]> => {
        return await this.combineGroceryLists(perRecipeLists);
      }
    );

    await step.do('save-grocery', async () => {
      await stub.fetch('https://internal/workflow/save-grocery', {
        method: 'POST',
        body: JSON.stringify({ week_of: weekOf, items: groceryItems }),
      });
    });

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
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 180_000);
    try {
      const response = await this.openai().responses.create(
        {
          model: 'gpt-5-nano',
          input: [
            {
              role: 'system',
              content: 'Generate the ingredient list and ordered steps for the given dish, scaled to the requested serving count. Concrete quantities. 4-8 steps.',
            },
            {
              role: 'user',
              content: `Dish: ${meal.name}\nDescription: ${meal.description}\nCuisine: ${meal.cuisine}\nServings: ${meal.servings}\nTotal time target: ${meal.total_minutes} min`,
            },
          ],
          text: {
            format: {
              type: 'json_schema',
              name: 'recipe_details',
              schema: RECIPE_DETAILS_SCHEMA,
              strict: true,
            },
          },
        },
        { signal: ac.signal }
      );
      const content = response.output_text;
      if (!content) throw new Error('Recipe materialization returned no content');
      return JSON.parse(content) as RecipeDetails;
    } finally {
      clearTimeout(timer);
    }
  }

  private async shopForRecipe(meal: MealSlot, pantry: string[]): Promise<GroceryItem[]> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60_000);
    try {
      const response = await this.openai().responses.create(
        {
          model: 'gpt-5-mini',
          input: [
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
          text: {
            format: {
              type: 'json_schema',
              name: 'grocery',
              schema: GROCERY_SCHEMA,
              strict: true,
            },
          },
        },
        { signal: ac.signal }
      );
      const content = response.output_text;
      if (!content) throw new Error('Per-recipe grocery returned no content');
      return (JSON.parse(content) as { items: GroceryItem[] }).items;
    } finally {
      clearTimeout(timer);
    }
  }

  private async combineGroceryLists(lists: GroceryItem[][]): Promise<GroceryItem[]> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 60_000);
    try {
      const flat = lists.flat();
      const response = await this.openai().responses.create(
        {
          model: 'gpt-5-mini',
          input: [
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
          text: {
            format: {
              type: 'json_schema',
              name: 'grocery',
              schema: GROCERY_SCHEMA,
              strict: true,
            },
          },
        },
        { signal: ac.signal }
      );
      const content = response.output_text;
      if (!content) throw new Error('Combine grocery returned no content');
      return (JSON.parse(content) as { items: GroceryItem[] }).items;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Split text into Discord-message-sized chunks (≤2000 chars each), preferring
 * newline boundaries so sections stay grouped.
 */
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
