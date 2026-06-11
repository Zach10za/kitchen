/**
 * Tool definitions for the kitchen agent. These are the *only* ways the agent
 * can mutate state. Keeping the surface small improves model selection accuracy.
 *
 * The bot is daily-first: the agent suggests dinner for *today* (or whenever the
 * user asks), and persists a decision only when the user actually makes one —
 * picks a dish (`log_meal`), declares a no-cook night (`set_no_cook`), or reports
 * cooking something (`mark_meal_cooked`). There is no weekly plan.
 *
 * Schema is OpenAI tool-calling format (functions with JSON Schema params).
 */
import { WEB_SEARCH_TOOL } from '../runtime/tavily';

export const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'log_meal',
      description: "Record that the user has decided to make a specific dish. Call this when they pick one of your suggestions or tell you what they're cooking. Save the FULL cookbook-grade recipe — ingredients, steps, headnote, finishing, riffs, keeps, pairing — so the saved page is worth returning to. Defaults to today and status 'planned'. Pass status 'cooked' if they say they already made it (this also decrements the pantry).",
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: "ISO date YYYY-MM-DD. Omit for today." },
          name: { type: 'string', description: 'Real, well-known dish name' },
          cuisine: { type: 'string', description: 'e.g. italian, thai, mexican, american' },
          description: { type: 'string', description: 'One-line summary' },
          protein: { type: 'string', description: 'Primary protein, lowercase: chicken, beef, pork, salmon, shrimp, tofu, beans, eggs, none, etc. Used for rotation.' },
          effort: { type: 'string', enum: ['quick', 'standard', 'project'], description: 'quick ≤30 min, standard = normal weeknight, project = weekend-scale (bread, ramen, long braise).' },
          headnote: { type: 'string', description: "Cookbook headnote: 2-3 sentences — why this dish, what makes it sing, the one thing not to screw up." },
          ingredients: {
            type: 'array',
            description: 'Full ingredient list with quantities.',
            items: {
              type: 'object',
              properties: {
                item: { type: 'string', description: 'Lowercase ingredient name, normalized to match pantry rows' },
                qty: { type: 'string', description: 'e.g. "1 lb", "2 cups", "3 count"' },
              },
              required: ['item', 'qty'],
            },
          },
          steps: { type: 'array', items: { type: 'string' }, description: 'Ordered cooking steps with sensory checkpoints and the why behind load-bearing steps.' },
          finishing: { type: 'string', description: 'The finishing move + plating: acid/herb/flake salt/texture, and a "serve with" line.' },
          variations: { type: 'array', items: { type: 'string' }, description: '1-2 riffs keyed to the pantry, e.g. "No anchovies? Two minced capers and extra parm."' },
          keeps: { type: 'string', description: 'Storage/leftover note, e.g. "Keeps 3 days; the flavors are better on day two."' },
          pairing: { type: 'string', description: 'One-line drink pairing (wine/beer/NA).' },
          requires_defrost: {
            type: 'array',
            description: 'Frozen items to pull ahead of cook time, so a defrost reminder can be scheduled.',
            items: {
              type: 'object',
              properties: {
                item: { type: 'string', description: 'Frozen ingredient name (lowercase, matches pantry)' },
                hours: { type: 'integer', description: 'Hours of fridge defrost before dinner (~12 thin fish, 24 chicken/beef, 36-48 large roasts)' },
              },
              required: ['item', 'hours'],
            },
          },
          status: { type: 'string', enum: ['planned', 'cooked'], description: "Default 'planned'. Use 'cooked' only if they already made it." },
        },
        required: ['name', 'cuisine', 'ingredients', 'steps'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'rate_meal',
      description: 'Record how a cooked meal turned out — a rating and/or "next time" notes ("needed more lemon", "thighs over breasts"). Call whenever the user gives post-cook feedback, prompted or volunteered. Targets the most recent cooked meal unless a date is given. Notes accumulate; they are served back when the dish is cooked again.',
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'ISO date YYYY-MM-DD of the cooked meal. Omit for the most recently cooked.' },
          rating: { type: 'integer', minimum: 1, maximum: 10, description: '1-10. Map vague feedback sensibly: "amazing" ≈ 9, "solid" ≈ 7, "meh" ≈ 4.' },
          notes: { type: 'string', description: 'Next-time adjustments in the user\'s words. Omit if they only gave a rating.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'find_recipes',
      description: 'Search past logged recipes by dish name. Returns matches with date, rating, and next-time notes, plus the full saved recipe for the best match. Use when the user wants to re-make something ("that miso salmon from last month") or asks what\'s in their cookbook.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Dish name or fragment, e.g. "salmon", "carbonara".' },
          limit: { type: 'integer', description: 'Max matches to list. Default 5.' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_grocery',
      description: 'Maintain the running grocery list. "add" when a picked dish needs ingredients not on hand (same turn as log_meal) or the user asks to add something. "remove" to drop items. "bought" when the user shopped — moves the named items (or the WHOLE list if items omitted) into the pantry and clears them from the list. "clear" wipes the list without touching the pantry.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'remove', 'bought', 'clear'] },
          items: {
            type: 'array',
            description: 'Required for add/remove. For "bought", omit to mean the entire list.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Lowercase, singular item name' },
                qty: { type: 'string', description: 'e.g. "1 lb", "2 count". Omit if unspecified.' },
                for_dish: { type: 'string', description: 'Dish that wants it, if any.' },
                location: { type: 'string', enum: ['freezer', 'fridge', 'shelf'], description: 'Where it will live once bought (used by "bought"/"add"). Default shelf.' },
              },
              required: ['name'],
            },
          },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'set_no_cook',
      description: "Record that the user is NOT cooking on a given day — date night, takeout, eating out, leftovers, or just skipping. This stops the daily noon suggestion ping for that day. Defaults to today.",
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'ISO date YYYY-MM-DD. Omit for today.' },
          reason: { type: 'string', description: 'Short reason, e.g. "date night", "ordering in", "leftovers".' },
        },
        required: ['reason'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'mark_meal_cooked',
      description: "Mark today's (or a given date's) planned meal as cooked. Decrements pantry inventory used by the recipe and cancels its defrost reminder. Use when the user says they made/finished the meal they had planned.",
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'ISO date YYYY-MM-DD. Omit for today.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'mark_meal_skipped',
      description: "Mark a planned meal as skipped (the user didn't make it). Cancels its defrost reminder; pantry is untouched. Defaults to today.",
      parameters: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'ISO date YYYY-MM-DD. Omit for today.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_pantry',
      description: 'Add or remove items from inventory. Track location (freezer/fridge/shelf) — freezer items get prioritized and can trigger defrost reminders. Capture quantities when given ("1 lb ground beef" → qty_value=1, qty_unit=lb). Use "count" for whole items ("2 chicken breasts" → qty_value=2, qty_unit=count).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'remove'] },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Lowercase, singular item name' },
                qty_value: { type: 'number', description: 'Numeric quantity (omit if user said "some" / unspecified)' },
                qty_unit: { type: 'string', description: 'Unit: lb, oz, count, cup, etc.' },
                location: { type: 'string', enum: ['freezer', 'fridge', 'shelf'], description: 'Where it lives. Default shelf.' },
              },
              required: ['name'],
            },
          },
        },
        required: ['action', 'items'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_profile',
      description: 'Update the household cooking profile — stable, declarative info: equipment, dietary rules (allergies, restrictions), cuisines liked/disliked, ingredients loved/avoided, cooking ability, time budget, default servings, anything that should always be considered when suggesting meals. Pass the COMPLETE merged content as Markdown. CRITICAL: preserve every detail the user provided verbatim — do not summarize, paraphrase, or compress their wording. Reorganize into Markdown sections (## Equipment, ## Dietary, ## Cuisines, ## Style, ## Time, ## Notes) but keep the substance intact. If a profile already exists, MERGE — never drop existing info. Distinguish hard rules (allergies, equipment they don\'t have) from soft preferences (cuisines liked).',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: 'Full merged profile content as Markdown' },
        },
        required: ['content'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'show_profile',
      description: 'Read-only: return the current cooking profile.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'record_preference',
      description: 'Silently record a learned preference for future suggestions. Call whenever user feedback reveals a pattern (likes, dislikes, dietary, schedule, cadence — e.g. "rarely cooks on Fridays"). Always include rationale.',
      parameters: {
        type: 'object',
        properties: {
          insight: { type: 'string', description: 'The preference, e.g. "deprioritize curries on weeknights"' },
          rationale: { type: 'string', description: 'Why we believe this, e.g. "user rejected curry 3 times running"' },
          weight: { type: 'integer', minimum: 1, maximum: 10, description: 'How strong this preference is (1=hint, 10=hard rule)' },
        },
        required: ['insight', 'rationale', 'weight'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'show_state',
      description: "Read-only: get today's decision (if any), recent meals, and the current pantry. Use when answering \"what am I making\", \"what have I cooked lately\", \"what do I have\", etc.",
      parameters: { type: 'object', properties: {} },
    },
  },
  WEB_SEARCH_TOOL,
] as const;

export type MealStatus = 'planned' | 'cooked' | 'skipped' | 'out';

export interface RecipeIngredient {
  item: string;
  qty: string;
}

/** Frozen items needing defrost. The model emits these so we don't keyword-match. */
export interface DefrostEntry {
  item: string;
  hours: number;
}

/** Cookbook-page extras stored as one JSON column on meals. */
export interface RecipeExtras {
  headnote?: string;
  finishing?: string;
  variations?: string[];
  keeps?: string;
  pairing?: string;
}

/** A single decided meal (or a no-cook night) for one date. Persisted in the
 *  `meals` table; the source of truth for recipe history and the noon-ping gate. */
export interface MealRow {
  id: number;
  date: string;
  name: string | null;
  cuisine: string | null;
  description: string | null;
  ingredients_json: string | null;
  steps_json: string | null;
  requires_defrost_json: string | null;
  status: MealStatus;
  created_at: number;
  protein: string | null;
  effort: string | null;
  extras_json: string | null;
  rating: number | null;
  cook_notes: string | null;
  [key: string]: SqlStorageValue;
}

/** Parsed view of a MealRow, used by render + prompt builders. */
export interface Meal {
  id: number;
  date: string;
  name: string | null;
  cuisine: string | null;
  description: string | null;
  ingredients: RecipeIngredient[];
  steps: string[];
  requires_defrost: DefrostEntry[];
  status: MealStatus;
  created_at: number;
  protein: string | null;
  effort: string | null;
  extras: RecipeExtras;
  rating: number | null;
  cook_notes: string | null;
}

/** A grocery-list row. Items accumulate from "Need to buy" picks and chat,
 *  and move into the pantry when the user reports shopping ("bought"). */
export interface GroceryRow {
  name: string;
  qty: string | null;
  for_dish: string | null;
  location: string | null;
  added_at: number;
  [key: string]: SqlStorageValue;
}

export interface PreferenceRow {
  id: string;
  insight: string;
  rationale: string;
  weight: number;
  learned_at: number;
  [key: string]: SqlStorageValue;
}

export interface PantryItem {
  name: string;
  qty: string | null;
  qty_value: number | null;
  qty_unit: string | null;
  location: string | null; // 'freezer' | 'fridge' | 'shelf'
  added_at: number;
  [key: string]: SqlStorageValue;
}
