/**
 * Tool definitions for the agent. These are the *only* ways the agent can
 * mutate state. Keeping the surface small improves model selection accuracy.
 *
 * Schema is OpenAI tool-calling format (functions with JSON Schema params).
 */
export const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'generate_draft',
      description: 'Create or regenerate the meal plan for a week. Use when starting fresh, when the user wants a do-over, or when no draft exists yet.',
      parameters: {
        type: 'object',
        properties: {
          week_of: { type: 'string', description: 'ISO date of the Monday of the target week' },
          constraints: {
            type: 'array',
            items: { type: 'string' },
            description: 'Per-week constraints from user, e.g. "guests Friday", "traveling Wed"',
          },
        },
        required: ['week_of'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'swap_meal',
      description: 'Replace one day\'s meal with a different recipe matching given criteria.',
      parameters: {
        type: 'object',
        properties: {
          week_of: { type: 'string' },
          day: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
          criteria: { type: 'string', description: 'What the new meal should be like, e.g. "uses salmon", "20 min, low effort"' },
        },
        required: ['week_of', 'day', 'criteria'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'adjust_servings',
      description: 'Change serving count for one meal (e.g., guests, leftovers wanted).',
      parameters: {
        type: 'object',
        properties: {
          week_of: { type: 'string' },
          day: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
          servings: { type: 'integer', minimum: 1, maximum: 20 },
        },
        required: ['week_of', 'day', 'servings'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'reschedule_meal',
      description: 'Move a meal from one day to another (e.g., user did not cook it, push to later).',
      parameters: {
        type: 'object',
        properties: {
          week_of: { type: 'string' },
          from: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
          to: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
        },
        required: ['week_of', 'from', 'to'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'update_pantry',
      description: 'Add or remove items from inventory. Track location (freezer/fridge/shelf) — freezer items get defrost reminders. Capture quantities when the user gives them ("1 lb ground beef" → qty_value=1, qty_unit=lb). Use "count" for whole items ("2 chicken breasts" → qty_value=2, qty_unit=count).',
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
      description: 'Update the household cooking profile — stable, declarative info: equipment, dietary rules (allergies, restrictions), cuisines liked/disliked, ingredients loved/avoided, cooking ability, time budget, default servings, anything that should always be considered when planning. Pass the COMPLETE merged content as Markdown. CRITICAL: preserve every detail the user provided verbatim — do not summarize, paraphrase, or compress their wording. Reorganize into Markdown sections (## Equipment, ## Dietary, ## Cuisines, ## Style, ## Time, ## Notes) but keep the substance intact. If a profile already exists, MERGE — never drop existing info. Distinguish hard rules (allergies, equipment they don\'t have) from soft preferences (cuisines liked).',
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
      description: 'Silently record a learned preference for future planning. Call whenever user feedback reveals a pattern (likes, dislikes, dietary, schedule). Always include rationale.',
      parameters: {
        type: 'object',
        properties: {
          insight: { type: 'string', description: 'The preference, e.g. "deprioritize curries on weeknights"' },
          rationale: { type: 'string', description: 'Why we believe this, e.g. "user rejected curry 3 weeks running"' },
          weight: { type: 'integer', minimum: 1, maximum: 10, description: 'How strong this preference is (1=hint, 10=hard rule)' },
        },
        required: ['insight', 'rationale', 'weight'],
      },
    },
  },
  // approve_plan and generate_grocery_list intentionally NOT exposed as tools —
  // those run as Cloudflare Workflows triggered by `/approve`. Doing them
  // inline from the agent loop would blow the DO request budget on the
  // 7-recipe materialization.
  {
    type: 'function' as const,
    function: {
      name: 'mark_meal_cooked',
      description: 'Mark a meal as cooked. Decrements pantry inventory used by the recipe. Use when user says they made/cooked a meal.',
      parameters: {
        type: 'object',
        properties: {
          week_of: { type: 'string' },
          day: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
        },
        required: ['week_of', 'day'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'mark_meal_skipped',
      description: 'Mark a meal as skipped (user did not cook it). Cancels its defrost reminder. Use when user says they skipped or did not make a meal.',
      parameters: {
        type: 'object',
        properties: {
          week_of: { type: 'string' },
          day: { type: 'string', enum: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] },
        },
        required: ['week_of', 'day'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'show_state',
      description: 'Read-only: get the current plan, preferences, and pantry. Use when answering "what is in the plan", "what do I have", etc.',
      parameters: {
        type: 'object',
        properties: { week_of: { type: 'string' } },
        required: ['week_of'],
      },
    },
  },
] as const;

export type Day = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export interface MealSlot {
  day: Day;
  // Stub fields — always present, generated by /draft and refined by /chat
  name: string;
  description: string;
  cuisine: string;
  active_minutes: number;
  total_minutes: number;
  effort: 'easy' | 'medium' | 'hard';
  // Per-meal state
  servings: number;
  notes: string[];
  status: 'planned' | 'cooked' | 'skipped';
  // Lazy-materialized — populated on /approve or first /now
  ingredients?: { item: string; qty: string }[];
  steps?: string[];
  requires_defrost?: { item: string; hours: number }[];
}

/** Stub form returned by generate_draft / swap_meal. */
export interface MealStub {
  name: string;
  description: string;
  cuisine: string;
  active_minutes: number;
  total_minutes: number;
  effort: 'easy' | 'medium' | 'hard';
}

/** Materialized form populated by approve_plan. */
export interface RecipeDetails {
  ingredients: { item: string; qty: string }[];
  steps: string[];
  /** Frozen items needing defrost. The model emits these so we don't keyword-match. */
  requires_defrost: { item: string; hours: number }[];
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

export interface GroceryItem {
  item: string;
  qty: string;
  category: 'produce' | 'protein' | 'dairy' | 'pantry' | 'frozen' | 'other';
}

export interface WeekState {
  week_of: string;
  status: 'draft' | 'approved' | 'in_progress' | 'archived';
  drafted_at: number;
  approved_at: number | null;
  meals: MealSlot[];
  constraints: string[];
}
