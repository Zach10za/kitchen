import type { BotSpec } from '../runtime/bot-spec';
import type { MessagePayload } from '../discord/types';
import { ensureRelayRateSchema } from '../runtime/relay-rate-limit';
import { ensureUsageSchema } from '../runtime/usage';
import { FINANCE_TOOLS, type AccountRow, type TransactionRow } from './tools';
import { executeFinanceTool } from './loop';
import { buildFinanceSystemPrompt } from './prompts';
import {
  accountsEmbed,
  spendingSummaryEmbed,
  merchantHistoryEmbed,
} from './render';

/** Finance bot spec — see runtime/bot-spec.ts for the contract. */
export const FINANCE_SPEC: BotSpec = {
  id: 'finance',
  channelEnvKey: 'DISCORD_FINANCE_CHANNEL_ID',
  commands: new Set([
    'finance',
    'finance-sync',
    'spending',
    'merchant',
    'accounts',
  ]),
  tools: FINANCE_TOOLS,
  resetTables: ['transactions', 'accounts', 'conversation'],
  scopeColumn: 'thread_id',

  buildSystemPrompt: (sql, env) => buildFinanceSystemPrompt(sql, env.TIMEZONE),

  executeTool: async (name, args, ctx) =>
    executeFinanceTool(name, args, { env: ctx.env, sql: ctx.sql, client: ctx.client }),

  fastRead: (sql, _env, interaction): MessagePayload | null => {
    const cmd = interaction.data?.name ?? '';
    const optionMap = Object.fromEntries(
      (interaction.data?.options ?? []).map((o) => [o.name, o.value]),
    );

    if (cmd === 'finance') {
      return { embeds: [spendingSummary(sql, 30)] };
    }
    if (cmd === 'spending') {
      const days = Math.max(1, Math.min(365, Number(optionMap.days ?? 30)));
      return { embeds: [spendingSummary(sql, days)] };
    }
    if (cmd === 'merchant') {
      const name = String(optionMap.name ?? '').trim().toLowerCase();
      const days = Math.max(1, Math.min(730, Number(optionMap.days ?? 90)));
      if (!name) return { content: 'Usage: `/merchant name:<merchant> [days:90]`' };
      const rows = sql
        .exec<TransactionRow>(
          'SELECT * FROM transactions WHERE normalized_payee = ? AND posted >= ? ORDER BY posted DESC',
          name,
          Math.floor(Date.now() / 1000) - days * 86_400,
        )
        .toArray();
      return { embeds: [merchantHistoryEmbed({ merchant: name, days, rows })] };
    }
    if (cmd === 'accounts') {
      const accounts = sql.exec<AccountRow>('SELECT * FROM accounts ORDER BY name').toArray();
      return { embeds: [accountsEmbed(accounts)] };
    }
    return null;
  },

  defaultScope: (_env, replyChannelId) => ({ column: 'thread_id', value: replyChannelId }),

  // Migrations preserved verbatim from finance-do.ts (versions 1-4). Append
  // new entries — never mutate existing ones.
  migrations: [
    {
      version: 1,
      up: (sql) => {
        sql.exec(`
          CREATE TABLE IF NOT EXISTS accounts (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            org_name TEXT,
            currency TEXT NOT NULL,
            balance TEXT NOT NULL,
            available_balance TEXT,
            last_synced_at INTEGER NOT NULL
          );
          CREATE TABLE IF NOT EXISTS transactions (
            id TEXT PRIMARY KEY,
            account_id TEXT NOT NULL,
            posted INTEGER NOT NULL,
            amount REAL NOT NULL,
            description TEXT NOT NULL,
            payee TEXT,
            normalized_payee TEXT NOT NULL,
            memo TEXT,
            pending INTEGER NOT NULL DEFAULT 0,
            raw_json TEXT NOT NULL,
            ingested_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_tx_posted ON transactions(posted DESC);
          CREATE INDEX IF NOT EXISTS idx_tx_merchant_posted
            ON transactions(normalized_payee, posted DESC);
          CREATE INDEX IF NOT EXISTS idx_tx_account_posted
            ON transactions(account_id, posted DESC);
          CREATE TABLE IF NOT EXISTS conversation (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            tool_call_json TEXT,
            ts INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_conv_id ON conversation(id DESC);
        `);
      },
    },
    { version: 2, up: (sql) => ensureRelayRateSchema(sql) },
    {
      version: 3,
      up: (sql) => {
        const cols = sql
          .exec<{ name: string }>('SELECT name FROM pragma_table_info(?)', 'conversation')
          .toArray()
          .map((r) => r.name);
        if (!cols.includes('thread_id')) {
          sql.exec('ALTER TABLE conversation ADD COLUMN thread_id TEXT');
        }
        sql.exec('CREATE INDEX IF NOT EXISTS idx_conv_thread ON conversation(thread_id, id DESC)');
      },
    },
    { version: 4, up: (sql) => ensureUsageSchema(sql) },
  ],
};

function spendingSummary(sql: SqlStorage, days: number) {
  const since = Math.floor(Date.now() / 1000) - days * 86_400;
  const totals = sql
    .exec<{ inflow: number; outflow: number; count: number }>(
      `SELECT
         COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS inflow,
         COALESCE(SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END), 0) AS outflow,
         COUNT(*) AS count
       FROM transactions
       WHERE posted >= ?`,
      since,
    )
    .toArray()[0]!;
  const topMerchants = sql
    .exec<{ normalized_payee: string; total: number; count: number }>(
      `SELECT normalized_payee, SUM(amount) AS total, COUNT(*) AS count
         FROM transactions
        WHERE posted >= ? AND amount < 0
        GROUP BY normalized_payee
        ORDER BY total ASC
        LIMIT 8`,
      since,
    )
    .toArray();
  return spendingSummaryEmbed({ days, ...totals, topMerchants });
}
