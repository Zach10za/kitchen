/**
 * Discord embed builders for finance fast-read commands. Anything the agent
 * loop produces is rendered as plain markdown in its final reply — these
 * embeds are only for the deterministic /spending and /merchant fast paths.
 */

import { EmbedColor, type Embed } from '../discord/types';
import type { AccountRow, TransactionRow } from './tools';

export function accountsEmbed(accounts: AccountRow[]): Embed {
  if (accounts.length === 0) {
    return {
      title: '🏦 Accounts',
      description: 'No accounts synced yet. Run `/finance-sync` to pull from SimpleFin.',
      color: EmbedColor.archived,
    };
  }
  const lines = accounts.map(
    (a) => `**${a.name}**${a.org_name ? ` (${a.org_name})` : ''} — ${a.currency} \`${a.balance}\``
  );
  return {
    title: '🏦 Accounts',
    description: lines.join('\n'),
    color: EmbedColor.inProgress,
    footer: { text: `Last sync: ${new Date(Math.max(...accounts.map((a) => a.last_synced_at))).toISOString()}` },
  };
}

export function spendingSummaryEmbed(opts: {
  days: number;
  inflow: number;
  outflow: number;
  count: number;
  topMerchants: { normalized_payee: string; total: number; count: number }[];
}): Embed {
  const net = opts.inflow + opts.outflow;
  const lines = [
    `**Spending (last ${opts.days}d):** \`${formatMoney(-opts.outflow)}\` across ${opts.count} tx`,
    `**Income:** \`${formatMoney(opts.inflow)}\``,
    `**Net:** \`${formatMoney(net)}\``,
  ];
  const fields = opts.topMerchants.length > 0
    ? [{
        name: 'Top merchants',
        value: opts.topMerchants
          .map((m, i) => `${i + 1}. \`${m.normalized_payee}\` — ${formatMoney(-m.total)} (${m.count})`)
          .join('\n')
          .slice(0, 1024),
      }]
    : undefined;
  return {
    title: `💵 Spending — last ${opts.days}d`,
    description: lines.join('\n'),
    color: EmbedColor.inProgress,
    fields,
  };
}

export function merchantHistoryEmbed(opts: {
  merchant: string;
  days: number;
  rows: TransactionRow[];
}): Embed {
  if (opts.rows.length === 0) {
    return {
      title: `🔍 ${opts.merchant}`,
      description: `No transactions in the last ${opts.days}d. (Names are normalized lowercase — try \`/spending\` to see canonical names.)`,
      color: EmbedColor.archived,
    };
  }
  const outflow = opts.rows.filter((r) => r.amount < 0);
  const total = outflow.reduce((acc, r) => acc + r.amount, 0);
  const avg = outflow.length > 0 ? total / outflow.length : 0;
  const recent = opts.rows.slice(0, 12).map(
    (t) => `\`${new Date(t.posted * 1000).toISOString().slice(0, 10)}\` ${formatMoney(t.amount)} — ${t.description.slice(0, 60)}`
  );
  return {
    title: `🔍 ${opts.merchant} — last ${opts.days}d`,
    description: [
      `**${opts.rows.length}** transactions, **${formatMoney(-total)}** total spend (avg ${formatMoney(avg)})`,
      '',
      ...recent,
    ].join('\n').slice(0, 4096),
    color: EmbedColor.inProgress,
  };
}

export function syncResultEmbed(opts: { inserted: number; updated: number; accounts: number; errors: string[] }): Embed {
  const ok = opts.errors.length === 0;
  return {
    title: ok ? '✅ Sync complete' : '⚠️ Sync finished with errors',
    description: [
      `${opts.accounts} account${opts.accounts === 1 ? '' : 's'} refreshed.`,
      `${opts.inserted} new transaction${opts.inserted === 1 ? '' : 's'}, ${opts.updated} updated.`,
      ...opts.errors.map((e) => `\n- ${e}`),
    ].join(' '),
    color: ok ? EmbedColor.inProgress : EmbedColor.error,
  };
}

function formatMoney(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  return `${sign}$${abs.toFixed(2)}`;
}
