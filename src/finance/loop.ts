/**
 * Finance tool implementations. The workflow runner (FinanceSteerWorkflow)
 * drives the agent loop via runtime/agent-round; tool execution lives here
 * and is called from the DO's /workflow/finance/exec-tool endpoint.
 */

import type OpenAI from 'openai';
import type { Env } from '../env';
import { type AccountRow, type TransactionRow } from './tools';
import { runSync } from './sync';

export interface FinanceToolCtx {
  env: Env;
  sql: SqlStorage;
  client: OpenAI;
}

export async function executeFinanceTool(name: string, args: any, ctx: FinanceToolCtx): Promise<string> {
  try {
    switch (name) {
      case 'list_accounts':         return toolListAccounts(ctx);
      case 'recent_transactions':   return toolRecentTransactions(args, ctx);
      case 'top_merchants':         return toolTopMerchants(args, ctx);
      case 'merchant_history':      return toolMerchantHistory(args, ctx);
      case 'period_total':          return toolPeriodTotal(args, ctx);
      case 'compare_periods':       return toolComparePeriods(args, ctx);
      case 'unusual_transactions':  return toolUnusualTransactions(args, ctx);
      case 'sync_now':              return await toolSyncNow(ctx);
      case 'get_transactions_raw':  return toolGetTransactionsRaw(args, ctx);
      default:                      return `Unknown finance tool: ${name}`;
    }
  } catch (err) {
    return `Tool ${name} failed: ${(err as Error).message}`;
  }
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function toolListAccounts(ctx: FinanceToolCtx): string {
  const rows = ctx.sql.exec<AccountRow>('SELECT * FROM accounts ORDER BY name').toArray();
  if (rows.length === 0) return 'No accounts synced yet. Call sync_now to pull from SimpleFin.';
  const lines = rows.map(
    (a) => `- ${a.name}${a.org_name ? ` (${a.org_name})` : ''}: ${a.currency} ${a.balance}${a.available_balance ? ` (avail ${a.available_balance})` : ''} — last sync ${new Date(a.last_synced_at).toISOString()}`
  );
  return `${rows.length} account${rows.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
}

function toolRecentTransactions(
  args: { days?: number; limit?: number; merchant?: string; min_amount?: number },
  ctx: FinanceToolCtx
): string {
  const days = args.days ?? 7;
  const limit = args.limit ?? 50;
  const since = nowSec() - days * 86_400;

  const filters = ['posted >= ?'];
  const params: SqlStorageValue[] = [since];
  if (args.merchant) {
    filters.push('normalized_payee = ?');
    params.push(args.merchant.toLowerCase());
  }
  if (args.min_amount != null) {
    filters.push('ABS(amount) >= ?');
    params.push(args.min_amount);
  }
  params.push(limit);

  const rows = ctx.sql
    .exec<TransactionRow>(
      `SELECT * FROM transactions WHERE ${filters.join(' AND ')} ORDER BY posted DESC LIMIT ?`,
      ...params
    )
    .toArray();

  if (rows.length === 0) return `No transactions in the last ${days} days matching the filter.`;
  const lines = rows.map((t) => formatTxLine(t));
  return `${rows.length} transaction${rows.length === 1 ? '' : 's'} (last ${days}d):\n${lines.join('\n')}`;
}

function toolTopMerchants(
  args: { days?: number; limit?: number },
  ctx: FinanceToolCtx
): string {
  const days = args.days ?? 30;
  const limit = args.limit ?? 10;
  const since = nowSec() - days * 86_400;

  const rows = ctx.sql
    .exec<{ normalized_payee: string; total: number; count: number }>(
      `SELECT normalized_payee, SUM(amount) AS total, COUNT(*) AS count
         FROM transactions
        WHERE posted >= ? AND amount < 0
        GROUP BY normalized_payee
        ORDER BY total ASC
        LIMIT ?`,
      since, limit
    )
    .toArray();

  if (rows.length === 0) return `No outflow in the last ${days} days.`;
  const lines = rows.map(
    (r, i) => `${i + 1}. ${r.normalized_payee}: ${formatMoney(-r.total)} (${r.count} tx)`
  );
  return `Top ${rows.length} merchants by spend (last ${days}d):\n${lines.join('\n')}`;
}

function toolMerchantHistory(
  args: { merchant: string; days?: number },
  ctx: FinanceToolCtx
): string {
  const days = args.days ?? 90;
  const since = nowSec() - days * 86_400;
  const merchant = args.merchant.toLowerCase();

  const rows = ctx.sql
    .exec<TransactionRow>(
      'SELECT * FROM transactions WHERE normalized_payee = ? AND posted >= ? ORDER BY posted DESC',
      merchant, since
    )
    .toArray();

  if (rows.length === 0) {
    return `No transactions for "${merchant}" in the last ${days} days. (Spelling may differ from the normalized name — check top_merchants for canonical names.)`;
  }

  const amounts = rows.map((r) => r.amount);
  const total = amounts.reduce((a, b) => a + b, 0);
  const outflow = amounts.filter((a) => a < 0);
  const inflow = amounts.filter((a) => a > 0);
  const minOut = outflow.length ? Math.min(...outflow.map(Math.abs)) : 0;
  const maxOut = outflow.length ? Math.max(...outflow.map(Math.abs)) : 0;
  const avgOut = outflow.length ? outflow.reduce((a, b) => a + b, 0) / outflow.length : 0;

  const lines = rows.slice(0, 30).map((t) => formatTxLine(t));
  const summary = [
    `Merchant: ${merchant}`,
    `Window: last ${days}d`,
    `Transactions: ${rows.length} (out: ${outflow.length}, in: ${inflow.length})`,
    `Net: ${formatMoney(total)}`,
    outflow.length > 0
      ? `Outflow: total ${formatMoney(outflow.reduce((a, b) => a + b, 0))}, avg ${formatMoney(avgOut)}, min ${formatMoney(-minOut)}, max ${formatMoney(-maxOut)}`
      : 'No outflow.',
  ].join('\n');

  return `${summary}\n\nRecent (up to 30):\n${lines.join('\n')}`;
}

function toolPeriodTotal(
  args: { days?: number },
  ctx: FinanceToolCtx
): string {
  const days = args.days ?? 30;
  const since = nowSec() - days * 86_400;

  const row = ctx.sql
    .exec<{ inflow: number; outflow: number; count: number }>(
      `SELECT
         COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS inflow,
         COALESCE(SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END), 0) AS outflow,
         COUNT(*) AS count
       FROM transactions
       WHERE posted >= ?`,
      since
    )
    .toArray()[0]!;

  return [
    `Window: last ${days}d (${row.count} tx)`,
    `Inflow: ${formatMoney(row.inflow)}`,
    `Outflow: ${formatMoney(row.outflow)}`,
    `Net: ${formatMoney(row.inflow + row.outflow)}`,
  ].join('\n');
}

function toolComparePeriods(
  args: { days?: number; merchant_limit?: number },
  ctx: FinanceToolCtx
): string {
  const days = args.days ?? 30;
  const merchantLimit = args.merchant_limit ?? 10;
  const now = nowSec();
  const recentStart = now - days * 86_400;
  const priorStart = now - 2 * days * 86_400;

  const period = (start: number, end: number) =>
    ctx.sql.exec<{ outflow: number; inflow: number }>(
      `SELECT
         COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS inflow,
         COALESCE(SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END), 0) AS outflow
       FROM transactions
       WHERE posted >= ? AND posted < ?`,
      start, end
    ).toArray()[0]!;

  const recent = period(recentStart, now);
  const prior = period(priorStart, recentStart);

  const movers = ctx.sql
    .exec<{ normalized_payee: string; recent: number; prior: number }>(
      `SELECT normalized_payee,
              COALESCE(SUM(CASE WHEN posted >= ? AND amount < 0 THEN amount ELSE 0 END), 0) AS recent,
              COALESCE(SUM(CASE WHEN posted < ? AND amount < 0 THEN amount ELSE 0 END), 0) AS prior
       FROM transactions
       WHERE posted >= ? AND amount < 0
       GROUP BY normalized_payee
       ORDER BY ABS(
         COALESCE(SUM(CASE WHEN posted >= ? AND amount < 0 THEN amount ELSE 0 END), 0)
         - COALESCE(SUM(CASE WHEN posted < ? AND amount < 0 THEN amount ELSE 0 END), 0)
       ) DESC
       LIMIT ?`,
      recentStart, recentStart, priorStart,
      recentStart, recentStart,
      merchantLimit
    )
    .toArray();

  const recentOut = -recent.outflow;
  const priorOut = -prior.outflow;
  const delta = recentOut - priorOut;
  const pct = priorOut > 0 ? ((delta / priorOut) * 100).toFixed(1) : 'n/a';

  const moverLines = movers.map((m) => {
    const r = -m.recent, p = -m.prior;
    const d = r - p;
    return `- ${m.normalized_payee}: ${formatMoney(-r)} now vs ${formatMoney(-p)} prior (Δ ${formatMoneySigned(-d)})`;
  });

  return [
    `Compare: last ${days}d vs prior ${days}d`,
    `Outflow: ${formatMoney(-recentOut)} now vs ${formatMoney(-priorOut)} prior (Δ ${formatMoneySigned(-delta)}${pct !== 'n/a' ? `, ${pct}%` : ''})`,
    `Inflow: ${formatMoney(recent.inflow)} now vs ${formatMoney(prior.inflow)} prior`,
    '',
    'Top movers by absolute change in spend:',
    ...moverLines,
  ].join('\n');
}

function toolUnusualTransactions(
  args: { days?: number },
  ctx: FinanceToolCtx
): string {
  const days = args.days ?? 7;
  const now = nowSec();
  const recentSince = now - days * 86_400;
  const historySince = now - 180 * 86_400;

  const recent = ctx.sql
    .exec<TransactionRow>(
      'SELECT * FROM transactions WHERE posted >= ? AND amount < 0 ORDER BY posted DESC',
      recentSince
    )
    .toArray();

  const flagged: { tx: TransactionRow; reason: string }[] = [];
  for (const tx of recent) {
    const history = ctx.sql
      .exec<{ count: number; avg: number; std: number }>(
        `SELECT COUNT(*) AS count, AVG(ABS(amount)) AS avg,
                COALESCE(
                  (SELECT SQRT(AVG((ABS(amount) - sub.avg) * (ABS(amount) - sub.avg)))
                   FROM transactions, (SELECT AVG(ABS(amount)) AS avg FROM transactions
                                       WHERE normalized_payee = ? AND posted < ? AND posted >= ? AND amount < 0) sub
                   WHERE normalized_payee = ? AND posted < ? AND posted >= ? AND amount < 0),
                  0
                ) AS std
         FROM transactions
         WHERE normalized_payee = ? AND posted < ? AND posted >= ? AND amount < 0`,
        tx.normalized_payee, recentSince, historySince,
        tx.normalized_payee, recentSince, historySince,
        tx.normalized_payee, recentSince, historySince
      )
      .toArray()[0]!;

    if (history.count === 0) {
      flagged.push({ tx, reason: 'new merchant' });
      continue;
    }
    const absAmount = Math.abs(tx.amount);
    if (history.std > 0) {
      const z = (absAmount - history.avg) / history.std;
      if (z >= 2.5 || absAmount >= history.avg * 3) {
        flagged.push({ tx, reason: `${formatMoney(-absAmount)} vs typical ${formatMoney(-history.avg)} at this merchant (z=${z.toFixed(1)})` });
      }
    } else if (absAmount >= history.avg * 3 && history.count >= 3) {
      flagged.push({ tx, reason: `${formatMoney(-absAmount)} vs typical ${formatMoney(-history.avg)} at this merchant` });
    }
  }

  if (flagged.length === 0) return `No unusual transactions in the last ${days} days.`;
  const lines = flagged.slice(0, 25).map(({ tx, reason }) => `${formatTxLine(tx)} — ${reason}`);
  return `${flagged.length} unusual transaction${flagged.length === 1 ? '' : 's'} (last ${days}d):\n${lines.join('\n')}`;
}

/**
 * Return raw transaction rows as a JSON string. Designed to feed into
 * code_interpreter — the model picks columns and runs whatever Python it
 * needs (cadence detection, paired-flow matching, clustering, forecasts).
 *
 * Output is a JSON object so code_interpreter can consume it directly:
 *   { count, transactions: [{id, account_id, posted, amount, ...}] }
 */
function toolGetTransactionsRaw(
  args: { days?: number; account_id?: string; merchant?: string; only_outflow?: boolean; limit?: number },
  ctx: FinanceToolCtx
): string {
  const days = Math.max(1, Math.min(730, args.days ?? 90));
  const limit = Math.max(1, Math.min(5000, args.limit ?? 2000));
  const since = nowSec() - days * 86_400;

  const filters = ['posted >= ?'];
  const params: SqlStorageValue[] = [since];
  if (args.account_id) {
    filters.push('account_id = ?');
    params.push(args.account_id);
  }
  if (args.merchant) {
    filters.push('normalized_payee = ?');
    params.push(args.merchant.toLowerCase());
  }
  if (args.only_outflow) {
    filters.push('amount < 0');
  }
  params.push(limit);

  const rows = ctx.sql
    .exec<TransactionRow>(
      `SELECT id, account_id, posted, amount, description, payee, normalized_payee, memo, pending
         FROM transactions
        WHERE ${filters.join(' AND ')}
        ORDER BY posted DESC
        LIMIT ?`,
      ...params
    )
    .toArray();

  return JSON.stringify({
    count: rows.length,
    truncated: rows.length === limit,
    days,
    transactions: rows.map((r) => ({
      id: r.id,
      account_id: r.account_id,
      posted: r.posted,
      amount: r.amount,
      description: r.description,
      payee: r.payee,
      normalized_payee: r.normalized_payee,
      memo: r.memo,
      pending: r.pending === 1,
    })),
  });
}

async function toolSyncNow(ctx: FinanceToolCtx): Promise<string> {
  const result = await runSync(ctx.env, ctx.sql);
  return [
    `Synced. ${result.accountsUpdated} account${result.accountsUpdated === 1 ? '' : 's'} updated.`,
    `New transactions: ${result.transactionsInserted}. Updated: ${result.transactionsUpdated}.`,
    result.errors.length > 0 ? `Errors: ${result.errors.join('; ')}` : null,
  ].filter(Boolean).join(' ');
}

function formatMoney(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  return `${sign}$${abs.toFixed(2)}`;
}

function formatMoneySigned(n: number): string {
  return `${n >= 0 ? '+' : ''}${formatMoney(n)}`;
}

function formatTxLine(t: TransactionRow): string {
  const date = new Date(t.posted * 1000).toISOString().slice(0, 10);
  const pending = t.pending ? ' [pending]' : '';
  return `${date} ${formatMoney(t.amount)} · ${t.normalized_payee} (${t.description})${pending}`;
}
