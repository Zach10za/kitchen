import type { WeekRow } from '../kitchen-do';
import type { MealSlot, GroceryItem } from './tools';
import type { Embed } from '../discord/types';
import { EmbedColor } from '../discord/types';

const DAY_LABEL: Record<string, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
};

// Each builder returns one Embed (or an array, when content overflows
// Discord's 6000-char-per-embed budget). Callers send via DiscordAPI which
// accepts { content?, embeds? } payloads.

const STATUS_COLOR: Record<string, number> = {
  draft: EmbedColor.draft,
  approved: EmbedColor.approved,
  in_progress: EmbedColor.inProgress,
  archived: EmbedColor.archived,
};

const STATUS_BADGE: Record<string, string> = {
  draft: '📝 Draft',
  approved: '✅ Approved',
  in_progress: '👨‍🍳 In progress',
  archived: '🗄️ Archived',
};

const STATUS_ICON: Record<string, string> = {
  cooked: '✅',
  skipped: '⏭️',
  planned: '',
};

/**
 * Build the plan embed. One embed, seven inline fields (Mon..Sun) — Discord
 * lays inline fields out in rows of 3, so the layout is 3 + 3 + 1 = a clean
 * mini-calendar. Cuisine + time + status live in the field value as a small
 * stat block.
 */
export function planEmbed(week: WeekRow, opts?: { includeFooterHint?: boolean }): Embed {
  const meals = JSON.parse(week.meals_json) as MealSlot[];
  const status = week.status;
  const fields: NonNullable<Embed['fields']> = meals.length === 0
    ? [{ name: '​', value: '_(no meals yet)_', inline: false }]
    : meals.map((m) => ({
        name: `${DAY_LABEL[m.day] ?? m.day} · ${truncate(m.name, 80)} ${STATUS_ICON[m.status] ?? ''}`.trim(),
        value: truncate(
          [
            `_${m.cuisine}_ · ${m.total_minutes} min · ${m.effort}`,
            m.description,
            m.notes.length > 0 ? `\n_${m.notes.join('; ')}_` : '',
          ].filter(Boolean).join('\n'),
          1000
        ),
        inline: true,
      }));

  const description = [
    `${STATUS_BADGE[status] ?? status} · **${meals.length}** meals`,
    week.approved_at ? `Approved <t:${Math.floor(week.approved_at / 1000)}:R>` : null,
  ].filter(Boolean).join(' · ');

  const footer = opts?.includeFooterHint
    ? status === 'draft'
      ? 'Use /steer to refine · /approve to lock it in'
      : status === 'approved'
        ? 'Use /grocery to see the list · /now for what to cook'
        : undefined
    : undefined;

  return {
    title: `🍴 Plan · week of ${week.week_of}`,
    description,
    color: STATUS_COLOR[status] ?? EmbedColor.inProgress,
    fields,
    ...(footer ? { footer: { text: footer } } : {}),
    timestamp: new Date(week.drafted_at).toISOString(),
  };
}

/**
 * Build the grocery embed(s). One embed per call when it fits; if a single
 * category's items overflow 1024 chars we split that category across multiple
 * fields with "(cont.)" suffixes. If the whole list overflows 6000 chars we
 * fall back to multiple embeds (rare).
 */
export function groceryEmbeds(items: GroceryItem[], weekOf: string): Embed[] {
  const grouped: Record<string, GroceryItem[]> = {};
  for (const item of items) (grouped[item.category] ??= []).push(item);
  const order: GroceryItem['category'][] = ['produce', 'protein', 'dairy', 'pantry', 'frozen', 'other'];

  const fields: NonNullable<Embed['fields']> = [];
  for (const cat of order) {
    const list = grouped[cat];
    if (!list || list.length === 0) continue;
    const label = `${categoryEmoji(cat)} ${cat.toUpperCase()} (${list.length})`;
    const lines = list.map((i) => (i.qty ? `☐ ${i.qty} ${i.item}` : `☐ ${i.item}`));
    // Field value cap = 1024. Split across continuation fields if needed.
    const chunks = packLines(lines, 1000);
    chunks.forEach((value, idx) => {
      fields.push({
        name: idx === 0 ? label : `${label} (cont.)`,
        value,
        inline: false,
      });
    });
  }

  const head: Embed = {
    title: `🛒 Grocery list · week of ${weekOf}`,
    description: `**${items.length}** items across ${countCategories(grouped)} categories`,
    color: EmbedColor.grocery,
    fields,
    footer: { text: 'Tap each ☐ to mark off as you shop' },
    timestamp: new Date().toISOString(),
  };

  // Embed cap is 6000 chars. If we'd blow that, split into multiple embeds.
  if (estimateEmbedSize(head) <= 5800) return [head];

  // Fallback: one embed per category.
  const embeds: Embed[] = [];
  for (const cat of order) {
    const list = grouped[cat];
    if (!list || list.length === 0) continue;
    const lines = list.map((i) => (i.qty ? `☐ ${i.qty} ${i.item}` : `☐ ${i.item}`));
    embeds.push({
      title: embeds.length === 0 ? `🛒 Grocery list · week of ${weekOf}` : undefined,
      description: `${categoryEmoji(cat)} **${cat.toUpperCase()}** · ${list.length} items`,
      color: EmbedColor.grocery,
      fields: packLines(lines, 1000).map((value, idx) => ({
        name: idx === 0 ? '​' : '​',
        value,
        inline: false,
      })),
    });
    if (embeds.length === 10) break; // Discord cap
  }
  return embeds;
}

/** Build a recipe embed for /now or per-meal lookups. */
export function recipeEmbed(meal: MealSlot): Embed {
  if (!meal.ingredients || !meal.steps) {
    return {
      title: `🍳 ${meal.name}`,
      description: 'Full recipe not materialized yet — approve the plan or ask for it specifically.',
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
  if (meal.requires_defrost && meal.requires_defrost.length > 0) {
    fields.unshift({
      name: '🧊 Defrost',
      value: meal.requires_defrost
        .map((d) => `${d.item} — ${d.hours}h ahead`)
        .join('\n'),
      inline: false,
    });
  }

  return {
    title: `🍳 ${meal.name}`,
    description: `_${meal.cuisine}_ · ${meal.total_minutes} min total · ${meal.active_minutes} min active · ${meal.servings} servings\n${meal.description}`,
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

function packLines(lines: string[], max: number): string[] {
  const out: string[] = [];
  let buf = '';
  for (const line of lines) {
    const next = buf ? buf + '\n' + line : line;
    if (next.length > max) {
      if (buf) out.push(buf);
      buf = line;
    } else {
      buf = next;
    }
  }
  if (buf) out.push(buf);
  return out.length > 0 ? out : [''];
}

function categoryEmoji(cat: GroceryItem['category']): string {
  switch (cat) {
    case 'produce': return '🥬';
    case 'protein': return '🍖';
    case 'dairy': return '🥛';
    case 'pantry': return '🥫';
    case 'frozen': return '🧊';
    default: return '🛒';
  }
}

function countCategories(grouped: Record<string, unknown[]>): number {
  return Object.values(grouped).filter((v) => v.length > 0).length;
}

function estimateEmbedSize(e: Embed): number {
  let n = (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text.length ?? 0);
  for (const f of e.fields ?? []) n += f.name.length + f.value.length;
  return n;
}
