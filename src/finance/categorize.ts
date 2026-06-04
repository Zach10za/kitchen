/**
 * Automatic transaction categorization.
 *
 * Categories aren't free-form bank data — we assign them. Rather than
 * categorize every transaction (expensive, repetitive), we classify each
 * distinct *merchant* once via a cheap LLM call and store the result as a
 * `source: 'auto'` rule. The normal rule application (applyRules in the
 * reconcile) then stamps that category onto every transaction of that merchant,
 * past and future — and a manual edit always wins (it harvests a 'manual' rule
 * that overwrites the auto one).
 *
 * Transfers are deliberately NOT in this taxonomy: per-transaction paired-flow
 * detection owns "Transfer" (and overrides any merchant category), so the LLM
 * can't mass-mislabel spending as transfers and drop it from cash flow.
 */

import type { Env } from '../env';
import { makeOpenAIClient } from '../runtime/openai';
import { upsertRule } from './rules';

export const CATEGORY_TAXONOMY = [
  'Income', 'Dining', 'Groceries', 'Gas', 'Transport', 'Travel', 'Shopping',
  'Entertainment', 'Subscriptions', 'Utilities', 'Housing', 'Health', 'Insurance',
  'Education', 'Fees', 'Personal Care', 'Gifts & Donations', 'Taxes', 'Other',
] as const;

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
          category: { type: 'string', enum: [...CATEGORY_TAXONOMY] },
        },
        required: ['merchant', 'category'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
} as const;

interface MerchantRow {
  merchant: string;
  sample: string;
  inflows: number;
  cnt: number;
  [key: string]: SqlStorageValue;
}

/**
 * Classify uncategorized merchants and store each as an 'auto' category rule.
 * Returns the number of merchants newly categorized. Only touches merchants that
 * don't already have a category rule, so it's incremental: after the first pass
 * it's near-free (only new merchants), and it never overrides a manual rule.
 */
export async function autoCategorize(env: Env, sql: SqlStorage, opts?: { max?: number }): Promise<number> {
  const max = opts?.max ?? 120;
  const merchants = sql
    .exec<MerchantRow>(
      `SELECT normalized_payee AS merchant,
              MAX(description) AS sample,
              SUM(CASE WHEN amount > 0 THEN 1 ELSE 0 END) AS inflows,
              COUNT(*) AS cnt
         FROM transactions
        WHERE TRIM(normalized_payee) <> ''
          AND normalized_payee NOT IN (SELECT pattern FROM rules WHERE match_type = 'merchant' AND category IS NOT NULL)
        GROUP BY normalized_payee
        ORDER BY cnt DESC
        LIMIT ?`,
      max,
    )
    .toArray();
  if (merchants.length === 0) return 0;

  const client = makeOpenAIClient(env, { timeoutMs: 60_000 });
  const valid = new Set<string>(CATEGORY_TAXONOMY);
  let count = 0;

  for (let i = 0; i < merchants.length; i += CHUNK) {
    const chunk = merchants.slice(i, i + CHUNK);
    // Map lowercased name → the real normalized_payee, so the LLM echoing the
    // name back with different casing/spacing still resolves to a real merchant.
    const byName = new Map(chunk.map((m) => [m.merchant.trim().toLowerCase(), m.merchant]));
    const input = chunk.map((m) => ({
      merchant: m.merchant,
      example: m.sample,
      mostly_income: m.inflows > m.cnt / 2,
    }));

    let items: { merchant: string; category: string }[];
    try {
      const resp = await client.responses.create({
        model: env.OPENAI_MODEL_EXTRACT,
        input: [
          {
            role: 'system',
            content:
              `You categorize bank/card transactions by merchant into exactly one category from this set: ${CATEGORY_TAXONOMY.join(', ')}. ` +
              `Use "Income" for paychecks, payroll, interest, dividends. Use "Other" only when genuinely unclear. ` +
              `Decide from the merchant name and example description; "mostly_income" hints the sign of the flow. ` +
              `Return one entry per input merchant, echoing the merchant string exactly.`,
          },
          { role: 'user', content: JSON.stringify(input) },
        ],
        text: { format: { type: 'json_schema', name: 'merchant_categories', schema: SCHEMA, strict: true } },
      });
      items = (JSON.parse(resp.output_text || '{"items":[]}') as { items: { merchant: string; category: string }[] }).items ?? [];
    } catch {
      continue; // a failed chunk just leaves those merchants for the next run
    }

    for (const it of items) {
      const pattern = byName.get((it.merchant ?? '').trim().toLowerCase());
      const category = (it.category ?? '').trim();
      if (!pattern || !valid.has(category)) continue;
      upsertRule(sql, { match_type: 'merchant', pattern, category, source: 'auto' });
      count++;
    }
  }
  return count;
}
