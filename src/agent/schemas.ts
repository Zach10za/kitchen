// Shared JSON schemas for OpenAI structured outputs.

export const RECIPE_DETAILS_SCHEMA = {
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
    // Frozen items the cook should defrost in advance. Lets us schedule
    // defrost reminders without keyword-matching ingredient strings.
    requires_defrost: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          /** The frozen ingredient name (lowercase, normalized to match pantry rows). */
          item: { type: 'string' },
          /** Hours of fridge defrost before cook time (≈12 for thin fish, 24 for chicken/beef cuts, 36-48 for larger roasts/turkey). */
          hours: { type: 'integer' },
        },
        required: ['item', 'hours'],
        additionalProperties: false,
      },
    },
  },
  required: ['ingredients', 'steps', 'requires_defrost'],
  additionalProperties: false,
} as const;

export const GROCERY_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          item: { type: 'string' },
          qty: { type: 'string' },
          category: {
            type: 'string',
            enum: ['produce', 'protein', 'dairy', 'pantry', 'frozen', 'other'],
          },
        },
        required: ['item', 'qty', 'category'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
} as const;
