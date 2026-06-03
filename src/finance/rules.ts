/**
 * Categorization rules — the learning loop's memory.
 *
 * A rule maps a transaction to a cleaned merchant and/or a category. Rules come
 * from two places:
 *   - **harvested** (source='manual'): when the reconciler detects you edited a
 *     Merchant/Category cell in the sheet, it records a rule so the same edit
 *     applies to every other (unlocked) row of that merchant going forward.
 *   - **explicit** (source='chat'): created via the `set_rule` chat tool, e.g.
 *     "categorize all amazon as Shopping".
 *
 * Matching:
 *   - `merchant`  — exact match on the transaction's normalized_payee.
 *   - `contains`  — case-insensitive substring of the raw description.
 * `contains` rules apply first, then `merchant` rules, so the more specific
 * exact-merchant rule wins when both match.
 */

export type RuleMatchType = 'merchant' | 'contains';
export type RuleSource = 'manual' | 'chat';

export interface RuleRow {
  id: number;
  match_type: RuleMatchType;
  pattern: string;
  merchant: string | null;
  category: string | null;
  source: RuleSource;
  created_at: number;
  [key: string]: SqlStorageValue;
}

/** Minimal transaction shape the rules engine needs to classify a row. */
export interface ClassifiableTx {
  normalized_payee: string;
  description: string;
}

export interface Enrichment {
  merchant: string;
  category: string;
}

export function loadRules(sql: SqlStorage): RuleRow[] {
  return sql.exec<RuleRow>('SELECT * FROM rules ORDER BY id ASC').toArray();
}

/**
 * Compute the proposed enrichment for a transaction. Starts from the cleaned
 * merchant the sync already stored (normalized_payee) and an empty category,
 * then layers matching rules on top.
 */
export function applyRules(rules: readonly RuleRow[], tx: ClassifiableTx): Enrichment {
  const result: Enrichment = { merchant: tx.normalized_payee, category: '' };
  const desc = tx.description.toLowerCase();

  const matched = rules.filter((r) =>
    r.match_type === 'contains'
      ? desc.includes(r.pattern.toLowerCase())
      : tx.normalized_payee === r.pattern,
  );
  // `contains` first, then `merchant` exact — exact is more specific, wins last.
  matched.sort((a, b) => (a.match_type === b.match_type ? 0 : a.match_type === 'contains' ? -1 : 1));

  for (const r of matched) {
    if (r.merchant) result.merchant = r.merchant;
    if (r.category) result.category = r.category;
  }
  return result;
}

/**
 * Insert or merge a rule. Keyed on (match_type, pattern) so a merchant override
 * and a category override for the same merchant collapse into one row. Only the
 * dimensions provided are written — passing `merchant: null` leaves any existing
 * merchant mapping intact (COALESCE), so harvesting a category edit never wipes
 * a previously-learned merchant rename.
 */
export function upsertRule(
  sql: SqlStorage,
  rule: {
    match_type: RuleMatchType;
    pattern: string;
    merchant?: string | null;
    category?: string | null;
    source: RuleSource;
  },
): void {
  sql.exec(
    `INSERT INTO rules (match_type, pattern, merchant, category, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(match_type, pattern) DO UPDATE SET
       merchant = COALESCE(excluded.merchant, rules.merchant),
       category = COALESCE(excluded.category, rules.category),
       source   = excluded.source`,
    rule.match_type,
    rule.pattern,
    rule.merchant ?? null,
    rule.category ?? null,
    rule.source,
    Date.now(),
  );
}
