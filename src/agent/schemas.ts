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
  },
  required: ['ingredients', 'steps'],
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
