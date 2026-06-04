/**
 * Merchant categorization via the LLM.
 *
 * Categories aren't free-form bank data — we assign them. We classify each
 * distinct cleaned merchant once (cheap LLM call) and the result seeds the
 * Mappings tab's category map (merchant → category). The Transactions Category
 * column is a live formula that looks up that map, so the assignment applies to
 * every transaction of the merchant and the user can override it in one place.
 *
 * "Transfer" IS in the classify taxonomy here so obvious inter-account merchants
 * (transfers, card payments) get tagged and excluded from cash flow; the user
 * adjusts any in the map.
 */

import type { Env } from '../env';
import { makeOpenAIClient } from '../runtime/openai';

/** Spend/income categories (no Transfer) — used by the Spend-by-Category tab. */
export const CATEGORY_TAXONOMY = [
  'Income', 'Dining', 'Groceries', 'Gas', 'Transport', 'Travel', 'Shopping',
  'Entertainment', 'Subscriptions', 'Utilities', 'Housing', 'Health', 'Insurance',
  'Education', 'Fees', 'Personal Care', 'Gifts & Donations', 'Taxes', 'Other',
] as const;

/** What the classifier may assign — the taxonomy plus Transfer. */
export const CLASSIFY_TAXONOMY = [...CATEGORY_TAXONOMY, 'Transfer'] as const;

/** Merchants per LLM request. */
const CHUNK = 60;

const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          merchant: { type: 'string' },
          category: { type: 'string', enum: [...CLASSIFY_TAXONOMY] },
        },
        required: ['merchant', 'category'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
} as const;

/**
 * Classify merchant names into categories. Returns a Map of input name → category
 * (only entries the model returned with a valid category). Resilient: a failed
 * chunk is just omitted. Names are matched case-insensitively to tolerate the
 * model echoing them back with different casing.
 */
export async function classifyMerchants(env: Env, names: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (unique.length === 0) return out;

  const client = makeOpenAIClient(env, { timeoutMs: 60_000 });
  const valid = new Set<string>(CLASSIFY_TAXONOMY);

  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const byLower = new Map(chunk.map((n) => [n.toLowerCase(), n]));
    try {
      const resp = await client.responses.create({
        model: env.OPENAI_MODEL_EXTRACT,
        input: [
          {
            role: 'system',
            content:
              `You categorize a merchant name into exactly one category from this set: ${CLASSIFY_TAXONOMY.join(', ')}. ` +
              `Use "Income" for paychecks, payroll, interest, dividends. Use "Transfer" for movements between someone's own accounts (transfers, credit-card payments). ` +
              `Use "Other" only when genuinely unclear. Return one entry per input merchant, echoing the merchant string exactly.`,
          },
          { role: 'user', content: JSON.stringify(chunk) },
        ],
        text: { format: { type: 'json_schema', name: 'merchant_categories', schema: SCHEMA, strict: true } },
      });
      const items = (JSON.parse(resp.output_text || '{"items":[]}') as { items: { merchant: string; category: string }[] }).items ?? [];
      for (const it of items) {
        const name = byLower.get((it.merchant ?? '').trim().toLowerCase());
        const category = (it.category ?? '').trim();
        if (name && valid.has(category)) out.set(name, category);
      }
    } catch {
      continue; // failed chunk → those merchants get categorized next run
    }
  }
  return out;
}
