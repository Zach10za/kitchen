import type { BotSpec } from '../runtime/bot-spec';
import type { MessagePayload } from '../discord/types';
import { ensureRelayRateSchema } from '../runtime/relay-rate-limit';
import { ensureUsageSchema } from '../runtime/usage';
import { FINANCE_TOOLS, type AccountRow, type TransactionRow } from './tools';
import { executeFinanceTool } from './loop';
import { buildFinanceSystemPrompt } from './prompts';
import { spendingFilter } from './accounts';
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
  resetTables: ['sheet_rows', 'rules', 'balance_history', 'account_meta', 'transactions', 'accounts', 'conversation'],
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
          `SELECT * FROM transactions WHERE normalized_payee = ? AND posted >= ? AND ${spendingFilter()} ORDER BY posted DESC`,
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
    {
      // Google Sheets working layer. `sheet_rows` mirrors the sheet's
      // enrichment columns: it holds the effective merchant/category (for
      // offline analysis) plus the "base" the bot last wrote and per-field
      // lock flags, which together drive the three-way merge in sheet.ts.
      // `rules` is the learning loop's memory (see rules.ts).
      version: 5,
      up: (sql) => {
        sql.exec(`
          CREATE TABLE IF NOT EXISTS sheet_rows (
            tx_id TEXT PRIMARY KEY,
            merchant TEXT NOT NULL DEFAULT '',
            category TEXT NOT NULL DEFAULT '',
            bot_merchant TEXT NOT NULL DEFAULT '',
            bot_category TEXT NOT NULL DEFAULT '',
            locked_merchant INTEGER NOT NULL DEFAULT 0,
            locked_category INTEGER NOT NULL DEFAULT 0,
            notes TEXT NOT NULL DEFAULT '',
            row_index INTEGER,
            synced_at INTEGER NOT NULL DEFAULT 0
          );
          CREATE INDEX IF NOT EXISTS idx_sheet_category ON sheet_rows(category);
          CREATE TABLE IF NOT EXISTS rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            match_type TEXT NOT NULL,
            pattern TEXT NOT NULL,
            merchant TEXT,
            category TEXT,
            source TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE(match_type, pattern)
          );
        `);
      },
    },
    {
      // Account classification + balance history. `account_meta` holds each
      // account's type (seeded by a keyword guess on sync, overridable in the
      // sheet's Accounts tab or via set_account_type) and drives spend-account
      // filtering + net-worth asset/liability signing. `balance_history` is a
      // once-per-day snapshot of every account's balance, so net worth can be
      // charted over time rather than shown only as a current number.
      version: 6,
      up: (sql) => {
        sql.exec(`
          CREATE TABLE IF NOT EXISTS account_meta (
            account_id TEXT PRIMARY KEY,
            type TEXT NOT NULL DEFAULT 'other',
            bot_type TEXT NOT NULL DEFAULT 'other',
            locked_type INTEGER NOT NULL DEFAULT 0,
            synced_at INTEGER NOT NULL DEFAULT 0
          );
          CREATE TABLE IF NOT EXISTS balance_history (
            account_id TEXT NOT NULL,
            as_of_date TEXT NOT NULL,
            balance REAL NOT NULL,
            captured_at INTEGER NOT NULL,
            PRIMARY KEY (account_id, as_of_date)
          );
          CREATE INDEX IF NOT EXISTS idx_balance_history_date ON balance_history(as_of_date);
        `);
      },
    },
    {
      // User-editable account nicknames (the sheet's Accounts "Nickname" column).
      // nickname = effective display name override; bot_nickname = merge base
      // (last value the bot wrote to the Nickname cell); locked_nickname = 1 once
      // the user has set one. Display name elsewhere = nickname || SimpleFin name.
      version: 7,
      up: (sql) => {
        for (const ddl of [
          "ALTER TABLE account_meta ADD COLUMN nickname TEXT NOT NULL DEFAULT ''",
          "ALTER TABLE account_meta ADD COLUMN bot_nickname TEXT NOT NULL DEFAULT ''",
          'ALTER TABLE account_meta ADD COLUMN locked_nickname INTEGER NOT NULL DEFAULT 0',
        ]) {
          sql.exec(ddl);
        }
      },
    },
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
       WHERE posted >= ? AND ${spendingFilter()}`,
      since,
    )
    .toArray()[0]!;
  const topMerchants = sql
    .exec<{ normalized_payee: string; total: number; count: number }>(
      `SELECT normalized_payee, SUM(amount) AS total, COUNT(*) AS count
         FROM transactions
        WHERE posted >= ? AND amount < 0 AND ${spendingFilter()}
        GROUP BY normalized_payee
        ORDER BY total ASC
        LIMIT 8`,
      since,
    )
    .toArray();
  return spendingSummaryEmbed({ days, ...totals, topMerchants });
}
