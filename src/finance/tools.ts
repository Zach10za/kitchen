/**
 * Finance agent tool definitions. Reactive only in v1 — every tool is a
 * read against local SQLite (synced hourly from SimpleFin). Adding a
 * proactive tool later (e.g. notify_unusual) will fit the same shape.
 */

export const FINANCE_TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'list_accounts',
      description: 'List all linked bank/card accounts with current balance and last sync time. Use when the user asks about their balances, what accounts are connected, or "how much do I have".',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'recent_transactions',
      description: 'List the most recent transactions, optionally filtered. Default is last 7 days, all accounts. Use when the user asks "what did I spend on", "show recent charges", or wants to see specific items.',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'integer', minimum: 1, maximum: 365, description: 'Lookback window in days. Default 7.' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max rows. Default 50.' },
          merchant: { type: 'string', description: 'Filter to one normalized merchant name (lowercase). Optional.' },
          min_amount: { type: 'number', description: 'Only include transactions whose absolute amount is at least this. Optional.' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'top_merchants',
      description: 'Aggregate spending by merchant over a period and return the top N by total outflow. Use when the user asks "where am I spending the most", "top merchants", or wants a breakdown.',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'integer', minimum: 1, maximum: 365, description: 'Lookback window. Default 30.' },
          limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Max merchants returned. Default 10.' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'merchant_history',
      description: 'Show every transaction for a specific normalized merchant within the period, plus aggregate stats (count, total, avg, min, max). Use when the user asks "how much did I spend at X", "history at Y", or wants to drill in.',
      parameters: {
        type: 'object',
        properties: {
          merchant: { type: 'string', description: 'Normalized merchant name (lowercase). The agent should match the user\'s wording against names in the recent data.' },
          days: { type: 'integer', minimum: 1, maximum: 730, description: 'Lookback window. Default 90.' },
        },
        required: ['merchant'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'period_total',
      description: 'Total inflow and outflow over a period. Returns income, spending, and net. Use for "how much did I spend this month", "what was my total in November", etc.',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'integer', minimum: 1, maximum: 365, description: 'Lookback window. Default 30.' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'compare_periods',
      description: 'Compare spending in two equal-length periods (current vs prior). Returns deltas overall and by merchant. Use for "is my spending up", "what changed vs last month", etc.',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'integer', minimum: 1, maximum: 180, description: 'Length of each window. Default 30 (compares last 30 days vs the 30 before that).' },
          merchant_limit: { type: 'integer', minimum: 1, maximum: 25, description: 'How many top movers to surface. Default 10.' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'unusual_transactions',
      description: 'Surface transactions that look anomalous — large amount relative to that merchant\'s history, brand-new merchant, or first charge in a long time. Use for "anything weird recently", smart-notification-style scans.',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'integer', minimum: 1, maximum: 30, description: 'Recent window to scan. Default 7.' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'sync_now',
      description: 'Force an immediate sync from SimpleFin. Normally syncs run hourly via cron — only call this when the user explicitly asks to refresh or says recent activity is missing.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_transactions_raw',
      description: 'Return raw transaction rows as a JSON array — feed these into code_interpreter when you need cadence detection, paired-flow matching (e.g. transfer detection), forecasting, clustering, or any analysis the SQL tools don\'t already provide. Returns the same fields as the database: id, account_id, posted (unix sec), amount (signed: negative=outflow), description, payee, normalized_payee, memo, pending. Default window 90d, max 5000 rows.',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'integer', minimum: 1, maximum: 730, description: 'Lookback window in days. Default 90.' },
          account_id: { type: 'string', description: 'Optional: only return rows for this account.' },
          merchant: { type: 'string', description: 'Optional: only return rows for this normalized merchant name (lowercase).' },
          only_outflow: { type: 'boolean', description: 'If true, only negative-amount rows. Default false.' },
          limit: { type: 'integer', minimum: 1, maximum: 5000, description: 'Max rows. Default 2000.' },
        },
      },
    },
  },
  // ── OpenAI server-side built-ins ──────────────────────────────────
  // These execute on OpenAI's side; their output appears in the response
  // alongside function calls and we just echo it forward. The agent uses
  // them by emitting tool calls of these types — no executor on our side.
  { type: 'web_search' as const },
  { type: 'code_interpreter' as const, container: { type: 'auto' as const } },
] as const;

export interface AccountRow {
  id: string;
  name: string;
  org_name: string | null;
  currency: string;
  balance: string;
  available_balance: string | null;
  last_synced_at: number;
  [key: string]: SqlStorageValue;
}

export interface TransactionRow {
  id: string;
  account_id: string;
  posted: number;
  amount: number;
  description: string;
  payee: string | null;
  normalized_payee: string;
  memo: string | null;
  pending: number;
  raw_json: string;
  ingested_at: number;
  updated_at: number;
  [key: string]: SqlStorageValue;
}
