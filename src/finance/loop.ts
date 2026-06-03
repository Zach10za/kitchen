/**
 * Finance tool implementations. AgentChatWorkflow drives the agent loop via
 * runtime/agent-round; tool execution lives here and is called from the
 * universal `/workflow/agent/exec-tool` endpoint on FinanceDO.
 */

import type OpenAI from 'openai';
import type { Env } from '../env';
import { type TransactionRow } from './tools';
import { runSync } from './sync';
import { reconcileSheet } from './sheet';
import { loadRules, upsertRule, type RuleMatchType, type RuleRow } from './rules';
import {
  spendingFilter,
  currentBalances,
  summarizeNetWorth,
  netWorthSeries,
  setAccountType,
  coerceType,
  ACCOUNT_TYPES,
} from './accounts';

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
      case 'sync_sheet':            return await toolSyncSheet(ctx);
      case 'set_rule':              return await toolSetRule(args, ctx);
      case 'list_rules':            return toolListRules(ctx);
      case 'category_breakdown':    return toolCategoryBreakdown(args, ctx);
      case 'net_worth':             return toolNetWorth(args, ctx);
      case 'set_account_type':      return await toolSetAccountType(args, ctx);
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
  const balances = currentBalances(ctx.sql);
  if (balances.length === 0) return 'No accounts synced yet. Call sync_now to pull from SimpleFin.';
  const { assets, liabilities, net } = summarizeNetWorth(balances);
  const isLiability = (type: string) => ['credit', 'mortgage', 'loan'].includes(type);

  const assetLines = balances
    .filter((b) => !isLiability(b.type))
    .map((b) => `  - ${b.name}${b.org ? ` (${b.org})` : ''} [${b.type}]: ${formatMoney(b.balance)}`);
  const liabLines = balances
    .filter((b) => isLiability(b.type))
    .map((b) => `  - ${b.name}${b.org ? ` (${b.org})` : ''} [${b.type}]: ${formatMoney(-Math.abs(b.balance))}`);

  return [
    `${balances.length} account${balances.length === 1 ? '' : 's'} — net worth ${formatMoney(net)}:`,
    `Assets ${formatMoney(assets)}:`,
    ...assetLines,
    liabLines.length > 0 ? `Liabilities ${formatMoney(liabilities)}:` : null,
    ...liabLines,
  ].filter(Boolean).join('\n');
}

function toolNetWorth(args: { days?: number }, ctx: FinanceToolCtx): string {
  const balances = currentBalances(ctx.sql);
  if (balances.length === 0) return 'No accounts synced yet — net worth is unavailable until SimpleFin syncs.';
  const { assets, liabilities, net } = summarizeNetWorth(balances);

  const days = Math.max(1, Math.min(3650, args.days ?? 90));
  const series = netWorthSeries(ctx.sql, days);

  const lines = [
    `Net worth now: ${formatMoney(net)} (assets ${formatMoney(assets)}, liabilities ${formatMoney(liabilities)}).`,
  ];
  if (series.length >= 2) {
    const first = series[0]!;
    const last = series[series.length - 1]!;
    const delta = last.net - first.net;
    lines.push(
      `Trend (${first.date} → ${last.date}): ${formatMoneySigned(delta)} over ${series.length} snapshot${series.length === 1 ? '' : 's'}.`,
    );
  } else {
    lines.push('Not enough history yet to show a trend — balance snapshots accrue one per day. Check back tomorrow.');
  }
  return lines.join('\n');
}

async function toolSetAccountType(
  args: { account?: string; type?: string },
  ctx: FinanceToolCtx,
): Promise<string> {
  const query = (args.account ?? '').trim().toLowerCase();
  const rawType = (args.type ?? '').trim().toLowerCase();
  const type = coerceType(rawType);
  if (!query) return 'set_account_type needs an account name (or part of one).';
  // coerceType maps anything unrecognized to 'other'; reject that unless the
  // user literally asked for 'other', so a typo'd type isn't applied silently.
  if (type === 'other' && rawType !== 'other') {
    return `Unknown type "${args.type}". Use one of: ${ACCOUNT_TYPES.join(', ')}.`;
  }

  const matches = currentBalances(ctx.sql).filter(
    (b) => b.name.toLowerCase().includes(query) || (b.org ?? '').toLowerCase().includes(query),
  );
  if (matches.length === 0) return `No account matches "${args.account}". Call list_accounts to see names.`;
  if (matches.length > 1) {
    return `"${args.account}" matches ${matches.length} accounts: ${matches.map((m) => m.name).join(', ')}. Be more specific.`;
  }

  const acct = matches[0]!;
  setAccountType(ctx.sql, acct.account_id, type);
  const r = await reconcileSheet(ctx.env, ctx.sql);
  const note = r.configured
    ? r.deleted > 0
      ? ` Removed ${r.deleted} now-non-spending row${r.deleted === 1 ? '' : 's'} from the Transactions tab.`
      : ''
    : '';
  return `Set ${acct.name} to "${type}".${note}`;
}

function toolRecentTransactions(
  args: { days?: number; limit?: number; merchant?: string; min_amount?: number },
  ctx: FinanceToolCtx
): string {
  const days = args.days ?? 7;
  const limit = args.limit ?? 50;
  const since = nowSec() - days * 86_400;

  const filters = ['posted >= ?', spendingFilter()];
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
        WHERE posted >= ? AND amount < 0 AND ${spendingFilter()}
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
      `SELECT * FROM transactions WHERE normalized_payee = ? AND posted >= ? AND ${spendingFilter()} ORDER BY posted DESC`,
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
       WHERE posted >= ? AND ${spendingFilter()}`,
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
       WHERE posted >= ? AND posted < ? AND ${spendingFilter()}`,
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
       WHERE posted >= ? AND amount < 0 AND ${spendingFilter()}
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

  // SQL returns negative outflows (debits stored as negative amounts). Flip
  // once into positive spend so the user-facing strings read naturally as
  // dollar amounts. The previous code flipped twice — once here, then
  // again in formatMoney(-recentOut) — which rendered spend as "-$500".
  const recentOut = -recent.outflow;
  const priorOut = -prior.outflow;
  const delta = recentOut - priorOut;
  const pct = priorOut > 0 ? ((delta / priorOut) * 100).toFixed(1) : 'n/a';

  const moverLines = movers.map((m) => {
    const r = -m.recent, p = -m.prior;
    const d = r - p;
    return `- ${m.normalized_payee}: ${formatMoney(r)} now vs ${formatMoney(p)} prior (Δ ${formatMoneySigned(d)})`;
  });

  return [
    `Compare: last ${days}d vs prior ${days}d`,
    `Outflow: ${formatMoney(recentOut)} now vs ${formatMoney(priorOut)} prior (Δ ${formatMoneySigned(delta)}${pct !== 'n/a' ? `, ${pct}%` : ''})`,
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
      `SELECT * FROM transactions WHERE posted >= ? AND amount < 0 AND ${spendingFilter()} ORDER BY posted DESC`,
      recentSince
    )
    .toArray();

  // Single aggregate query for per-merchant history stats. The previous
  // implementation issued one query per recent transaction (50–200 round
  // trips per tool call); this is a single GROUP BY.
  // Std deviation derived via SUM(x²) instead of a nested AVG subquery so
  // it computes in one pass alongside count + avg.
  const historyRows = ctx.sql
    .exec<{ normalized_payee: string; count: number; avg: number; sum_sq: number }>(
      `SELECT normalized_payee,
              COUNT(*) AS count,
              AVG(ABS(amount)) AS avg,
              SUM(ABS(amount) * ABS(amount)) AS sum_sq
         FROM transactions
        WHERE posted < ? AND posted >= ? AND amount < 0 AND ${spendingFilter()}
        GROUP BY normalized_payee`,
      recentSince, historySince,
    )
    .toArray();

  const historyByMerchant = new Map<string, { count: number; avg: number; std: number }>();
  for (const h of historyRows) {
    const variance = h.count > 0 ? Math.max(0, h.sum_sq / h.count - h.avg * h.avg) : 0;
    historyByMerchant.set(h.normalized_payee, {
      count: h.count,
      avg: h.avg,
      std: Math.sqrt(variance),
    });
  }

  const flagged: { tx: TransactionRow; reason: string }[] = [];
  for (const tx of recent) {
    const history = historyByMerchant.get(tx.normalized_payee) ?? { count: 0, avg: 0, std: 0 };
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
  // Capped at 500 — anything larger blows the LLM context window. 2000 rows
  // at ~100 tokens each is ~200K tokens, which exceeds the input limit on
  // most models. Tool callers wanting analytics should use the aggregate
  // tools (top_merchants, period_total) instead of asking for raw rows.
  const limit = Math.max(1, Math.min(500, args.limit ?? 200));
  const since = nowSec() - days * 86_400;

  const filters = ['posted >= ?', spendingFilter()];
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

async function toolSyncSheet(ctx: FinanceToolCtx): Promise<string> {
  const r = await reconcileSheet(ctx.env, ctx.sql);
  if (!r.configured) {
    return 'The Google Sheet is not configured (missing GOOGLE_SERVICE_ACCOUNT_JSON or FINANCE_SHEET_ID). Sheet sync is unavailable.';
  }
  const parts = [
    `Sheet reconciled. ${r.appended} new row${r.appended === 1 ? '' : 's'} added, ${r.updated} updated.`,
    r.humanEdits > 0 ? `Picked up ${r.humanEdits} of your edit${r.humanEdits === 1 ? '' : 's'} (${r.rulesHarvested} rule${r.rulesHarvested === 1 ? '' : 's'} learned).` : null,
    r.errors.length > 0 ? `Errors: ${r.errors.join('; ')}` : null,
  ];
  return parts.filter(Boolean).join(' ');
}

async function toolSetRule(
  args: { match_type?: string; pattern?: string; merchant?: string; category?: string },
  ctx: FinanceToolCtx,
): Promise<string> {
  const matchType = args.match_type === 'contains' ? 'contains' : 'merchant';
  const pattern = (args.pattern ?? '').trim();
  const merchant = args.merchant?.trim() || null;
  const category = args.category?.trim() || null;
  if (!pattern) return 'set_rule needs a non-empty pattern.';
  if (!merchant && !category) return 'set_rule needs at least one of merchant or category to set.';

  // Match on the normalized (lowercase) merchant name to line up with how the
  // sync stores normalized_payee and how applyRules compares it.
  const normalizedPattern = matchType === 'merchant' ? pattern.toLowerCase() : pattern;
  upsertRule(ctx.sql, {
    match_type: matchType as RuleMatchType,
    pattern: normalizedPattern,
    merchant,
    category,
    source: 'chat',
  });

  // Apply immediately so the user sees it reflected in the sheet right away.
  const r = await reconcileSheet(ctx.env, ctx.sql);
  const set = [merchant ? `merchant → "${merchant}"` : null, category ? `category → "${category}"` : null]
    .filter(Boolean)
    .join(', ');
  const applied = r.configured
    ? ` Applied to the sheet (${r.updated} row${r.updated === 1 ? '' : 's'} updated).`
    : ' (Sheet not configured, so the rule is stored but not yet reflected anywhere.)';
  return `Rule saved: ${matchType} "${normalizedPattern}" sets ${set}.${applied}`;
}

function toolListRules(ctx: FinanceToolCtx): string {
  const rules = loadRules(ctx.sql);
  if (rules.length === 0) return 'No rules yet. Edit the sheet or use set_rule to create some.';
  const lines = rules.map((r: RuleRow) => {
    const sets = [r.merchant ? `merchant="${r.merchant}"` : null, r.category ? `category="${r.category}"` : null]
      .filter(Boolean)
      .join(', ');
    const origin = r.source === 'manual' ? 'learned from sheet edit' : 'set via chat';
    return `- ${r.match_type} "${r.pattern}" → ${sets} (${origin})`;
  });
  return `${rules.length} rule${rules.length === 1 ? '' : 's'}:\n${lines.join('\n')}`;
}

function toolCategoryBreakdown(args: { days?: number }, ctx: FinanceToolCtx): string {
  const days = args.days ?? 30;
  const since = nowSec() - days * 86_400;

  // Join the raw ledger to the sheet mirror so categories reflect what's in the
  // Google Sheet (including the user's manual edits). Outflow only.
  const rows = ctx.sql
    .exec<{ category: string; total: number; count: number }>(
      `SELECT COALESCE(NULLIF(TRIM(s.category), ''), '(uncategorized)') AS category,
              SUM(t.amount) AS total,
              COUNT(*) AS count
         FROM transactions t
         LEFT JOIN sheet_rows s ON s.tx_id = t.id
        WHERE t.posted >= ? AND t.amount < 0 AND ${spendingFilter('t')}
        GROUP BY category
        ORDER BY total ASC`,
      since,
    )
    .toArray();

  if (rows.length === 0) return `No outflow in the last ${days} days.`;
  const total = rows.reduce((sum, r) => sum + r.total, 0);
  const lines = rows.map((r) => {
    const pct = total !== 0 ? ((r.total / total) * 100).toFixed(0) : '0';
    return `- ${r.category}: ${formatMoney(-r.total)} (${pct}%, ${r.count} tx)`;
  });
  return [
    `Spend by category (last ${days}d), total ${formatMoney(-total)}:`,
    ...lines,
    'Note: categories come from the Google Sheet. "(uncategorized)" rows still need labeling there or via set_rule.',
  ].join('\n');
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
