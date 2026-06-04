/**
 * Cash-flow support: a monthly inflow/outflow series for the chat tool.
 *
 * Design (decided with the operator): ALL accounts' transactions live in the
 * sheet, and the monthly cash-flow table/chart is computed by sheet **formulas**
 * (a SUMPRODUCT bucketed by month) that exclude two things: inter-account
 * transfers (Category = "Transfer") and any row the user checked the **Exclude**
 * box on (a separate column, so the row keeps its real category — e.g. a one-off
 * bonus). Transfers are tagged by category, not paired-flow detection: the LLM
 * classifies each merchant in the Mappings tab (Transfer included) and the user
 * curates it. `monthlyCashFlow` mirrors the sheet formula for chat answers (all
 * accounts, minus Category = "Transfer" and minus Exclude-checked rows).
 */

/** Category value that marks a transfer and the cash-flow formulas exclude. */
export const TRANSFER_CATEGORY = 'Transfer';

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
  excluded: number;
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
      `SELECT t.posted, t.amount, s.category AS category, COALESCE(s.is_excluded, 0) AS excluded
         FROM transactions t
         LEFT JOIN sheet_rows s ON s.tx_id = t.id
        WHERE t.posted >= ?`,
      since,
    )
    .toArray();

  const byMonth = new Map<string, { inflow: number; outflow: number }>();
  for (const tx of rows) {
    // Excluded from cash flow: inter-account transfers (Category) or rows the
    // user checked "Exclude" (mirrored from the sheet's Exclude column).
    if (tx.excluded === 1) continue;
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
