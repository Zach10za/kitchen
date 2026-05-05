import type { WeekRow } from '../kitchen-do';
import type { MealSlot, GroceryItem } from './tools';

const DAY_LABEL: Record<string, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
};

/** Render a plan as a Discord-friendly markdown block. */
export function renderPlan(week: WeekRow): string {
  const meals = JSON.parse(week.meals_json) as MealSlot[];
  if (meals.length === 0) return '_(no meals yet)_';

  const lines = meals.map((m) => {
    const noteSuffix = m.notes.length > 0 ? `  _${m.notes.join('; ')}_` : '';
    return `\`${DAY_LABEL[m.day]}\`  **${m.name}**  _${m.cuisine}_  (${m.total_minutes} min, ${m.effort})${noteSuffix}\n     ${m.description}`;
  });
  return lines.join('\n');
}

/** Render a single recipe with steps for "what now?" prompts. */
export function renderRecipe(meal: MealSlot): string {
  if (!meal.ingredients || !meal.steps) {
    return `**${meal.name}** — full recipe not yet generated. Approve the plan or ask for it specifically.`;
  }
  return [
    `**${meal.name}** (${meal.total_minutes} min total, ${meal.active_minutes} min active)`,
    meal.description,
    '',
    '**Ingredients:**',
    ...meal.ingredients.map((i: { qty: string; item: string }) => `- ${i.qty} ${i.item}`),
    '',
    '**Steps:**',
    ...meal.steps.map((s: string, i: number) => `${i + 1}. ${s}`),
  ].join('\n');
}

/** Render a categorized grocery list. */
export function renderGroceryList(items: GroceryItem[]): string {
  const grouped: Record<string, GroceryItem[]> = {};
  for (const item of items) {
    (grouped[item.category] ??= []).push(item);
  }
  const order = ['produce', 'protein', 'dairy', 'pantry', 'frozen', 'other'];
  const sections: string[] = [];
  for (const cat of order) {
    const list = grouped[cat];
    if (!list || list.length === 0) continue;
    sections.push(`**${cat.toUpperCase()}**`);
    sections.push(...list.map((i) => (i.qty ? `- ${i.qty} ${i.item}` : `- ${i.item}`)));
    sections.push('');
  }
  return sections.join('\n').trim();
}
