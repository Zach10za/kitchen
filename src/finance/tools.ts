/**
 * Finance agent tool definitions. Reactive only in v1 — every tool is a
 * read against local SQLite (synced hourly from SimpleFin). Adding a
 * proactive tool later (e.g. notify_unusual) will fit the same shape.
 */

import { WEB_SEARCH_TOOL } from '../runtime/tavily';

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
  {
    type: 'function' as const,
    function: {
      name: 'sync_sheet',
      description: 'Reconcile the Google Sheet now: push any new transactions into it, pull back merchant/category edits the user made in the sheet, and harvest those edits into reusable rules. Normally runs hourly via cron — call this when the user asks to refresh the sheet, says they just edited it, or after you create a rule and want it applied immediately.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'set_rule',
      description: 'Create or update a categorization rule, then apply it to the sheet. Use for bulk commands like "categorize all amazon as Shopping" or "rename TST* PHILZ to Philz Coffee". A rule can set a cleaned merchant name, a category, or both. Rules apply to all matching transactions except rows the user has manually overridden in the sheet.',
      parameters: {
        type: 'object',
        properties: {
          match_type: { type: 'string', enum: ['merchant', 'contains'], description: '"merchant" matches the exact normalized merchant name (lowercase, as shown by top_merchants). "contains" matches a case-insensitive substring of the raw bank description — use it when the merchant name is messy or varies.' },
          pattern: { type: 'string', description: 'For match_type "merchant": the normalized merchant name (lowercase). For "contains": the substring to look for in the raw description.' },
          merchant: { type: 'string', description: 'Optional. Cleaned merchant name to set on matching rows.' },
          category: { type: 'string', description: 'Optional. Category to set on matching rows (e.g. "Dining", "Groceries", "Subscriptions").' },
        },
        required: ['match_type', 'pattern'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'list_rules',
      description: 'List the active categorization/merchant rules, including which were learned from the user\'s manual sheet edits vs. set explicitly. Use when the user asks "what rules do I have", "why is X categorized as Y", or before editing rules.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'net_worth',
      description: 'Report current net worth (assets minus liabilities) and its trend over a window, using balance snapshots taken once per day across ALL account types — including investment, retirement, and loan accounts whose transactions are not tracked. Use for "what\'s my net worth", "how has my net worth changed", or any assets-vs-liabilities question.',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'integer', minimum: 1, maximum: 3650, description: 'Trend window in days. Default 90.' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'cash_flow',
      description: 'Monthly inflows vs outflows. Excludes transactions categorized "Transfer" (inter-account moves, auto-tagged) or "Exclude" (manual escape hatch for one-offs like a big bonus that aren\'t transfers but skew the view). Mirrors the live Cash Flow tab + chart in the sheet. Use for "what\'s my monthly cash flow", "income vs spending by month", "am I cash-flow positive". To drop a row, tell the user to categorize it "Exclude" (or set a rule).',
      parameters: {
        type: 'object',
        properties: {
          months: { type: 'integer', minimum: 1, maximum: 60, description: 'How many recent months. Default 12.' },
        },
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'set_account_type',
      description: 'Set an account\'s type, which controls whether its transactions count as spending and whether its balance is an asset or a liability for net worth. Use when the user says an account is miscategorized ("the Fidelity account is my 401k, not a brokerage", "mark Chase Sapphire as credit"). Types: checking, savings, credit, cash, brokerage, retirement, mortgage, loan, other. Spending types (checking, credit, cash) get transaction-level tracking; the rest are balance-only.',
      parameters: {
        type: 'object',
        properties: {
          account: { type: 'string', description: 'Account name, nickname, or a distinctive part of it.' },
          type: { type: 'string', enum: ['checking', 'savings', 'credit', 'cash', 'brokerage', 'retirement', 'mortgage', 'loan', 'other'], description: 'The account type to set.' },
        },
        required: ['account', 'type'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'set_nickname',
      description: "Give an account a nickname (display name) used across the sheet — handy when the bank's name is cryptic. Use when the user says \"rename\", \"nickname\", or \"call my X account Y\". The original bank name is preserved; the nickname is shown everywhere (Accounts, Balances, Transactions) and updates live via references.",
      parameters: {
        type: 'object',
        properties: {
          account: { type: 'string', description: 'Account name, current nickname, or a distinctive part of it.' },
          nickname: { type: 'string', description: 'The display name to use for this account.' },
        },
        required: ['account', 'nickname'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'category_breakdown',
      description: 'Spending grouped by category over a window, using the categories maintained in the Google Sheet. Use for "where does my money go by category", "how much on Dining this month", or any category-level analysis. Uncategorized spend is reported separately so the user knows how much is still unlabeled.',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'integer', minimum: 1, maximum: 365, description: 'Lookback window. Default 30.' },
        },
      },
    },
  },
  // Shared Tavily-backed search (executed centrally in AgentDOBase).
  WEB_SEARCH_TOOL,
  // OpenAI server-side built-in: executes on OpenAI's side, output echoed
  // forward, no executor here. (web_search is now Tavily; code_interpreter stays.)
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
