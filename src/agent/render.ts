import type { Meal } from './tools';
import type { Embed } from '../discord/types';
import { EmbedColor } from '../discord/types';

// Each builder returns one Embed. Callers send via DiscordAPI which accepts
// { content?, embeds? } payloads.

/** Build a recipe embed for a decided meal (ingredients + steps + defrost). */
export function recipeEmbed(meal: Meal): Embed {
  if (meal.ingredients.length === 0 || meal.steps.length === 0) {
    return {
      title: `🍳 ${meal.name ?? 'Meal'}`,
      description: meal.description ?? 'No recipe details recorded.',
      color: EmbedColor.archived,
    };
  }
  const ingredients = meal.ingredients
    .map((i) => `• ${i.qty ? `${i.qty} ` : ''}${i.item}`)
    .join('\n');
  const steps = meal.steps
    .map((s, i) => `**${i + 1}.** ${s}`)
    .join('\n');

  const fields: NonNullable<Embed['fields']> = [
    { name: '🥬 Ingredients', value: truncate(ingredients, 1024), inline: false },
    { name: '👨‍🍳 Steps', value: truncate(steps, 1024), inline: false },
  ];
  if (meal.requires_defrost.length > 0) {
    fields.unshift({
      name: '🧊 Defrost',
      value: meal.requires_defrost
        .map((d) => `${d.item} — ${d.hours}h ahead`)
        .join('\n'),
      inline: false,
    });
  }

  return {
    title: `🍳 ${meal.name ?? 'Meal'}`,
    description: [meal.cuisine ? `_${meal.cuisine}_` : '', meal.description ?? '']
      .filter(Boolean)
      .join('\n'),
    color: EmbedColor.recipe,
    fields,
  };
}

/** Render a small status embed (errors, transient progress messages). */
export function statusEmbed(args: {
  title: string;
  description?: string;
  color?: number;
}): Embed {
  return {
    title: args.title,
    description: args.description,
    color: args.color ?? EmbedColor.inProgress,
  };
}

// ─── helpers ───────────────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
