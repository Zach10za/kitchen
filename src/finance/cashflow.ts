/**
 * Daily cash flow — inflows vs. outflows per day, with inter-account transfers
 * excluded.
 *
 * "Inter-account transfer" means money moving between the user's own accounts
 * (checking → savings, a credit-card payment, brokerage funding). Those aren't
 * income or spending, so they must not inflate either side of the cash-flow
 * graph. We exclude a transaction when:
 *
 *   1. its sheet Category says so (authoritative) — a category matching
 *      /transfer|credit card payment/ is treated as a transfer, anything else
 *      is treated as real flow; OR
 *   2. (only for UNCATEGORIZED rows) it's one leg of a detected paired flow —
 *      an equal-and-opposite amount on a *different* account within a few days —
 *      or its description literally says "transfer"/"xfer".
 *
 * Paired-flow detection runs over EVERY account's transactions (we ingest them
 * all, even balance-only accounts), so a checking→savings transfer matches even
 * though the savings leg never appears in the spending sheet. The cash-flow
 * totals themselves are built only from spending accounts (checking/credit/cash)
 * — the only accounts with real transaction-level inflow/outflow.
 */

import { spendingFilter } from './accounts';

/** How far apart the two legs of a transfer can post and still pair. */
const PAIR_WINDOW_SEC = 4 * 86_400;
const TRANSFER_KEYWORD = /\b(transfer|xfer)\b/i;
const TRANSFER_CATEGORY = /transfer|credit\s*card\s*payment|cc\s*payment/i;

export interface DailyFlow {
  date: string;
  inflow: number;
  /** Positive magnitude of money out (not signed). */
  outflow: number;
  net: number;
}

interface FlowTx {
  id: string;
  account_id: string;
  posted: number;
  amount: number;
  description: string;
  [key: string]: SqlStorageValue;
}

/** Local YYYY-MM-DD for a unix-seconds timestamp in the given timezone. */
function localDateOf(postedSec: number, timezone: string): string {
  return new Date(postedSec * 1000).toLocaleDateString('en-CA', { timeZone: timezone });
}

/**
 * Greedy paired-flow detection: match each debit to an unused credit of the same
 * absolute amount (to the cent) on a different account within the window, and
 * mark both transaction ids as transfers.
 */
function detectTransferIds(rows: readonly FlowTx[]): Set<string> {
  const creditsByCents = new Map<number, FlowTx[]>();
  for (const r of rows) {
    if (r.amount > 0) {
      const cents = Math.round(r.amount * 100);
      (creditsByCents.get(cents) ?? creditsByCents.set(cents, []).get(cents)!).push(r);
    }
  }
  const used = new Set<string>();
  const transfers = new Set<string>();
  for (const debit of rows) {
    if (debit.amount >= 0) continue;
    const candidates = creditsByCents.get(Math.round(-debit.amount * 100)) ?? [];
    let best: FlowTx | null = null;
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

/**
 * Daily inflow/outflow series for the last `days` days (rolling), transfers
 * excluded. Days with no activity are omitted.
 */
export function dailyCashFlow(sql: SqlStorage, timezone: string, days: number): DailyFlow[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStart = nowSec - days * 86_400;
  // Fetch a little before the window so a transfer whose other leg posted just
  // before the window can still pair.
  const fetchStart = windowStart - PAIR_WINDOW_SEC;

  const allRows = sql
    .exec<FlowTx>(
      'SELECT id, account_id, posted, amount, description FROM transactions WHERE posted >= ? ORDER BY posted ASC',
      fetchStart,
    )
    .toArray();

  const spendingIds = new Set(
    sql
      .exec<{ id: string }>(`SELECT id FROM transactions t WHERE posted >= ? AND ${spendingFilter('t')}`, fetchStart)
      .toArray()
      .map((r) => r.id),
  );
  const categoryByTx = new Map<string, string>();
  for (const r of sql.exec<{ tx_id: string; category: string }>('SELECT tx_id, category FROM sheet_rows').toArray()) {
    categoryByTx.set(r.tx_id, r.category);
  }

  const transferIds = detectTransferIds(allRows);

  const byDate = new Map<string, { inflow: number; outflow: number }>();
  for (const tx of allRows) {
    if (tx.posted < windowStart) continue; // buffer rows are for pairing only
    if (!spendingIds.has(tx.id)) continue; // only spending accounts carry real flow

    const category = (categoryByTx.get(tx.id) ?? '').trim();
    const isTransfer = category
      ? TRANSFER_CATEGORY.test(category)
      : transferIds.has(tx.id) || TRANSFER_KEYWORD.test(tx.description);
    if (isTransfer) continue;

    const date = localDateOf(tx.posted, timezone);
    const bucket = byDate.get(date) ?? { inflow: 0, outflow: 0 };
    if (tx.amount > 0) bucket.inflow += tx.amount;
    else bucket.outflow += -tx.amount;
    byDate.set(date, bucket);
  }

  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, b]) => ({ date, inflow: b.inflow, outflow: b.outflow, net: b.inflow - b.outflow }));
}
