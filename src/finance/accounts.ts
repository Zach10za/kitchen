/**
 * Account classification + balance history.
 *
 * SimpleFin gives us no account-type field (just name, org, balance, currency),
 * but the kind of account changes what its transactions *mean*: a -$5,000 row
 * is overspending on a checking account and a routine contribution on a 401k.
 * So we classify every account into a type, which drives two things:
 *   - which accounts count as "spending" (transaction-level tracking + spend
 *     analysis) vs. balance-only, and
 *   - whether a balance is an asset or a liability for net worth.
 *
 * Classification lives in SQLite (`account_meta`), seeded by a keyword guess on
 * every sync, so spend tools filter correctly even when the Google Sheet isn't
 * configured. The sheet's Accounts tab and the `set_account_type` chat tool are
 * just surfaces to correct the guess; corrections are respected (locked).
 *
 * Balance history (`balance_history`) snapshots every account's balance once per
 * local day, so net worth can be charted over time — not just shown as a
 * current number.
 */

export type AccountType =
  | 'checking'
  | 'savings'
  | 'credit'
  | 'cash'
  | 'brokerage'
  | 'retirement'
  | 'mortgage'
  | 'loan'
  | 'other';

export const ACCOUNT_TYPES: AccountType[] = [
  'checking', 'savings', 'credit', 'cash', 'brokerage', 'retirement', 'mortgage', 'loan', 'other',
];

/** Types whose transactions are real spending — tracked row-by-row in the sheet
 *  and counted by the spend tools. A credit card is spending AND a liability. */
const SPENDING_TYPES = new Set<AccountType>(['checking', 'credit', 'cash']);

/** Types that count as debt for net worth (balance subtracts). Everything else
 *  is treated as an asset (balance adds). */
const LIABILITY_TYPES = new Set<AccountType>(['credit', 'mortgage', 'loan']);

export function isSpendingType(type: string): boolean {
  return SPENDING_TYPES.has(type as AccountType);
}

/** SQL list of spending types for IN clauses. */
const SPENDING_TYPES_SQL = `(${[...SPENDING_TYPES].map((t) => `'${t}'`).join(', ')})`;

/**
 * A WHERE-clause fragment that restricts a `transactions` query to spending
 * accounts. Excludes only accounts EXPLICITLY classified as non-spending, so an
 * account not yet in account_meta is treated as spending (nothing silently
 * vanishes before the first post-migration sync seeds classifications).
 *
 * Pass the table alias used in the query (e.g. 't'); omit for unaliased queries.
 */
export function spendingFilter(alias?: string): string {
  const col = alias ? `${alias}.account_id` : 'account_id';
  return `${col} NOT IN (SELECT account_id FROM account_meta WHERE type NOT IN ${SPENDING_TYPES_SQL})`;
}

export function isLiabilityType(type: string): boolean {
  return LIABILITY_TYPES.has(type as AccountType);
}

export function coerceType(value: string): AccountType {
  const v = value.trim().toLowerCase();
  return (ACCOUNT_TYPES as string[]).includes(v) ? (v as AccountType) : 'other';
}

/**
 * Keyword guess from the account + institution name. Order matters: check the
 * most specific liability/investment markers before the generic deposit ones
 * (a "Fidelity 401k" is retirement, not brokerage; a "Chase Sapphire" card is
 * credit, not checking). Unknown accounts default to `checking` — the loudest
 * failure mode (a real spending account miscategorized away from spend) is one
 * the user notices immediately and fixes in the Accounts tab, whereas the guess
 * is reliable for the investment/loan names that actually need excluding.
 */
export function guessAccountType(name: string, org?: string | null): AccountType {
  const s = `${name} ${org ?? ''}`.toLowerCase();
  if (/\bmortgage\b|home\s*loan|heloc/.test(s)) return 'mortgage';
  if (/\bloan\b|auto\s*loan|student\s*loan|line\s*of\s*credit/.test(s)) return 'loan';
  if (/401|403\s*b|\bira\b|roth|\bsep\b|pension|retire/.test(s)) return 'retirement';
  if (/brokerage|invest|securities|\betf\b|\bhsa\b|529|robinhood|vanguard|schwab|e\*?trade|merrill/.test(s)) return 'brokerage';
  if (/credit\s*card|\bcredit\b|\bvisa\b|mastercard|\bamex\b|american\s*express|discover|\bcard\b/.test(s)) return 'credit';
  if (/saving|\bhysa\b|money\s*market/.test(s)) return 'savings';
  if (/\bcash\b|wallet/.test(s)) return 'cash';
  if (/check|chequing|debit/.test(s)) return 'checking';
  return 'checking';
}

export interface AccountMetaRow {
  account_id: string;
  type: string;
  bot_type: string;
  locked_type: number;
  synced_at: number;
  [key: string]: SqlStorageValue;
}

export function loadAccountMeta(sql: SqlStorage): Map<string, AccountMetaRow> {
  const map = new Map<string, AccountMetaRow>();
  for (const r of sql.exec<AccountMetaRow>('SELECT * FROM account_meta').toArray()) {
    map.set(r.account_id, r);
  }
  return map;
}

/** Seed a guessed type the first time we see an account. Never overwrites an
 *  existing row — once classified, the type only changes via sheet edits or the
 *  set_account_type tool. */
export function seedAccountMeta(sql: SqlStorage, accountId: string, guess: AccountType): void {
  sql.exec(
    `INSERT INTO account_meta (account_id, type, bot_type, locked_type, synced_at)
     VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(account_id) DO NOTHING`,
    accountId, guess, guess, Date.now(),
  );
}

/** Explicitly set an account's type (from the sheet edit or chat tool). Marks
 *  it locked so the guesser never second-guesses a human decision. */
export function setAccountType(sql: SqlStorage, accountId: string, type: AccountType): void {
  sql.exec(
    `INSERT INTO account_meta (account_id, type, bot_type, locked_type, synced_at)
     VALUES (?, ?, ?, 1, ?)
     ON CONFLICT(account_id) DO UPDATE SET type=excluded.type, locked_type=1, synced_at=excluded.synced_at`,
    accountId, type, type, Date.now(),
  );
}

/** Local YYYY-MM-DD for the given timezone (en-CA renders ISO date order). */
export function localDate(timezone: string): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: timezone });
}

/** Snapshot one account's balance for `date`. First write of the day wins, so
 *  the history is a stable daily close-ish series regardless of how many times
 *  the hourly sync runs. */
export function captureBalance(
  sql: SqlStorage,
  accountId: string,
  balance: number,
  date: string,
): void {
  if (!Number.isFinite(balance)) return;
  sql.exec(
    `INSERT INTO balance_history (account_id, as_of_date, balance, captured_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(account_id, as_of_date) DO NOTHING`,
    accountId, date, balance, Date.now(),
  );
}

export interface NetWorthPoint {
  date: string;
  assets: number;
  liabilities: number;
  net: number;
}

/**
 * Net worth time series from balance_history, signing each account by its
 * current type. Each synced day carries a balance for every account (the sync
 * captures them all together), so a plain per-date sum is correct without
 * carry-forward. Liabilities are reported as positive magnitudes; net = assets
 * − liabilities.
 */
export function netWorthSeries(sql: SqlStorage, days: number): NetWorthPoint[] {
  const sinceDate = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const rows = sql
    .exec<{ as_of_date: string; account_id: string; balance: number }>(
      'SELECT as_of_date, account_id, balance FROM balance_history WHERE as_of_date >= ? ORDER BY as_of_date ASC',
      sinceDate,
    )
    .toArray();
  const meta = loadAccountMeta(sql);

  const byDate = new Map<string, { assets: number; liabilities: number }>();
  for (const r of rows) {
    const type = meta.get(r.account_id)?.type ?? 'other';
    const bucket = byDate.get(r.as_of_date) ?? { assets: 0, liabilities: 0 };
    if (isLiabilityType(type)) bucket.liabilities += Math.abs(r.balance);
    else bucket.assets += r.balance;
    byDate.set(r.as_of_date, bucket);
  }

  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, b]) => ({ date, assets: b.assets, liabilities: b.liabilities, net: b.assets - b.liabilities }));
}

export interface AccountBalance {
  account_id: string;
  name: string;
  org: string | null;
  type: string;
  currency: string;
  balance: number;
  last_synced_at: number;
}

/** Current balance + classification for every account (joins the live accounts
 *  table to account_meta, defaulting unclassified accounts to 'other'). */
export function currentBalances(sql: SqlStorage): AccountBalance[] {
  return sql
    .exec<AccountBalance & { [key: string]: SqlStorageValue }>(
      `SELECT a.id AS account_id, a.name, a.org_name AS org, a.currency,
              CAST(a.balance AS REAL) AS balance,
              a.last_synced_at,
              COALESCE(m.type, 'other') AS type
         FROM accounts a
         LEFT JOIN account_meta m ON m.account_id = a.id
        ORDER BY a.name`,
    )
    .toArray();
}

export interface NetWorthSummary {
  assets: number;
  liabilities: number;
  net: number;
}

export function summarizeNetWorth(balances: readonly AccountBalance[]): NetWorthSummary {
  let assets = 0;
  let liabilities = 0;
  for (const b of balances) {
    if (isLiabilityType(b.type)) liabilities += Math.abs(b.balance);
    else assets += b.balance;
  }
  return { assets, liabilities, net: assets - liabilities };
}
