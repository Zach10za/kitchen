/**
 * Cash-flow support: detecting inter-account transfers (to auto-tag them) and a
 * monthly inflow/outflow series for the chat tool.
 *
 * Design (decided with the operator): ALL accounts' transactions live in the
 * sheet, transfers are identified by the **Category** column, and the monthly
 * cash-flow table/chart is computed by sheet **formulas** (a SUMPRODUCT that
 * buckets by month and excludes Category = "Transfer"). The bot's only cash-flow
 * job is to *propose* the "Transfer" category on transactions it detects as
 * paired flows — the user can override any, and the formulas do the math (live).
 *
 * `detectTransferIds` is the auto-tagger's engine; `monthlyCashFlow` mirrors the
 * sheet formula for chat answers (all accounts, minus Category = "Transfer").
 */

/** Category value the bot writes for detected transfers and the formulas exclude. */
export const TRANSFER_CATEGORY = 'Transfer';

/** How far apart the two legs of a transfer can post and still pair. */
const PAIR_WINDOW_SEC = 4 * 86_400;

interface PairTx {
  id: string;
  account_id: string;
  posted: number;
  amount: number;
}

/**
 * Greedy paired-flow detection: match each debit to an unused credit of the same
 * absolute amount (to the cent) on a DIFFERENT account within the window, and
 * mark both transaction ids as transfers. Runs over every account's
 * transactions, so a checking→savings move pairs even though savings isn't a
 * spending account.
 */
export function detectTransferIds(rows: readonly PairTx[]): Set<string> {
  const creditsByCents = new Map<number, PairTx[]>();
  for (const r of rows) {
    if (r.amount > 0) {
      const cents = Math.round(r.amount * 100);
      const list = creditsByCents.get(cents);
      if (list) list.push(r);
      else creditsByCents.set(cents, [r]);
    }
  }
  const used = new Set<string>();
  const transfers = new Set<string>();
  for (const debit of rows) {
    if (debit.amount >= 0) continue;
    const candidates = creditsByCents.get(Math.round(-debit.amount * 100)) ?? [];
    let best: PairTx | null = null;
    for (const c of candidates) {
      if (used.has(c.id) || c.account_id === debit.account_id) continue;
      if (Math.abs(c.posted - debit.posted) > PAIR_WINDOW_SEC) continue;
      if (!best || Math.abs(c.posted - debit.posted) < Math.abs(best.posted - debit.posted)) best = c;
    }
    if (best) {
      used.add(best.id);
      used.add(debit.id);
      transfers.add(best.id);
      transfers.add(debit.id);
    }
  }
  return transfers;
}

export interface MonthlyFlow {
  /** YYYY-MM. */
  month: string;
  inflow: number;
  /** Positive magnitude of money out (not signed). */
  outflow: number;
  net: number;
}

interface FlowTx {
  posted: number;
  amount: number;
  category: string | null;
  [key: string]: SqlStorageValue;
}

/** Local YYYY-MM for a unix-seconds timestamp in the given timezone. */
function localMonthOf(postedSec: number, timezone: string): string {
  return new Date(postedSec * 1000).toLocaleDateString('en-CA', { timeZone: timezone }).slice(0, 7);
}

/**
 * Monthly inflow/outflow series for the last `months` months, mirroring the
 * sheet's Cash Flow formulas: every account, minus rows whose sheet Category is
 * "Transfer". Months with no activity are omitted.
 */
export function monthlyCashFlow(sql: SqlStorage, timezone: string, months: number): MonthlyFlow[] {
  // Generous lower bound (≈31 days/month) so we capture the requested window.
  const since = Math.floor(Date.now() / 1000) - months * 31 * 86_400;
  const rows = sql
    .exec<FlowTx>(
      `SELECT t.posted, t.amount, s.category AS category
         FROM transactions t
         LEFT JOIN sheet_rows s ON s.tx_id = t.id
        WHERE t.posted >= ?`,
      since,
    )
    .toArray();

  const byMonth = new Map<string, { inflow: number; outflow: number }>();
  for (const tx of rows) {
    if ((tx.category ?? '').trim().toLowerCase() === TRANSFER_CATEGORY.toLowerCase()) continue;
    const month = localMonthOf(tx.posted, timezone);
    const bucket = byMonth.get(month) ?? { inflow: 0, outflow: 0 };
    if (tx.amount > 0) bucket.inflow += tx.amount;
    else bucket.outflow += -tx.amount;
    byMonth.set(month, bucket);
  }

  return [...byMonth.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .slice(-months)
    .map(([month, b]) => ({ month, inflow: b.inflow, outflow: b.outflow, net: b.inflow - b.outflow }));
}
