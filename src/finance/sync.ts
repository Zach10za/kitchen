/**
 * Incremental SimpleFin sync. Pulls accounts + recent transactions, upserts
 * by transaction ID, and tracks the most recent posted timestamp per account
 * so subsequent syncs only re-fetch the tail.
 *
 * The hourly cron (in src/index.ts) calls runSync. The DO also exposes a
 * `sync_now` agent tool for on-demand refresh.
 */

import type { Env } from '../env';
import { SimplefinClient, type SimplefinAccount, type SimplefinTransaction } from './simplefin';
import { normalizeMerchant } from './normalize';
import { guessAccountType, reguessAccountMeta, captureBalance, localDate } from './accounts';

/** How far back to look on the very first sync (no prior data). */
const FIRST_SYNC_LOOKBACK_DAYS = 90;
/** Overlap window so re-posted/edited transactions get re-ingested. SimpleFin
 *  occasionally rewrites a transaction's payee/amount as the institution
 *  finalizes it; pulling a 7-day overlap catches those without re-fetching
 *  the whole history. */
const SYNC_OVERLAP_DAYS = 7;

export interface SyncResult {
  accountsUpdated: number;
  transactionsInserted: number;
  transactionsUpdated: number;
  errors: string[];
  /** Earliest posted timestamp covered by this sync, for reporting. */
  startDate: number;
}

export async function runSync(env: Env, sql: SqlStorage): Promise<SyncResult> {
  const client = new SimplefinClient(env.SIMPLEFIN_ACCESS_URL);

  // Anchor `startDate` to the most recent transaction's `posted` (unix
  // seconds) — not the wall-clock `last_synced_at`. Otherwise an
  // institution that hasn't posted in weeks still triggers only the
  // 7-day overlap window from each sync's run time, never re-pulling
  // earlier history. With no transactions yet, fall back to the
  // FIRST_SYNC_LOOKBACK_DAYS window from now.
  const lastPosted = sql
    .exec<{ ts: number | null }>('SELECT MAX(posted) AS ts FROM transactions')
    .toArray()[0]?.ts ?? 0;
  const nowSec = Math.floor(Date.now() / 1000);
  const startDate =
    lastPosted > 0
      ? lastPosted - SYNC_OVERLAP_DAYS * 86_400
      : nowSec - FIRST_SYNC_LOOKBACK_DAYS * 86_400;

  const response = await client.fetchAccounts({ startDate });

  const result: SyncResult = {
    accountsUpdated: 0,
    transactionsInserted: 0,
    transactionsUpdated: 0,
    errors: response.errors ?? [],
    startDate,
  };

  const now = Date.now();
  const today = localDate(env.TIMEZONE);
  for (const account of response.accounts) {
    // SimpleFin sometimes returns a per-account `error` field instead of (or
    // alongside) transactions when a particular institution's connection has
    // issues. Surface those so a single broken bank doesn't fail silently.
    const accountError = (account as unknown as { error?: string }).error;
    if (accountError) {
      result.errors.push(`${account.name ?? account.id}: ${accountError}`);
    }
    upsertAccount(sql, account, now);
    // Classify on every sync (keyword + balance-sign guess; auto-corrects
    // unlocked accounts) and snapshot today's balance so net worth can be
    // tracked over time across every account type — including the investment/
    // loan accounts whose transactions we don't track row-level.
    const bal = parseFloat(account.balance);
    reguessAccountMeta(sql, account.id, guessAccountType(account.name, account.org?.name, bal));
    captureBalance(sql, account.id, bal, today);
    result.accountsUpdated++;
    for (const tx of account.transactions ?? []) {
      const action = upsertTransaction(sql, account.id, tx, now);
      if (action === 'inserted') result.transactionsInserted++;
      else if (action === 'updated') result.transactionsUpdated++;
    }
  }

  return result;
}

function upsertAccount(sql: SqlStorage, account: SimplefinAccount, now: number): void {
  sql.exec(
    `INSERT INTO accounts (id, name, org_name, currency, balance, available_balance, last_synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name,
       org_name=excluded.org_name,
       currency=excluded.currency,
       balance=excluded.balance,
       available_balance=excluded.available_balance,
       last_synced_at=excluded.last_synced_at`,
    account.id,
    account.name,
    account.org?.name ?? null,
    account.currency,
    account.balance,
    account['available-balance'] ?? null,
    now
  );
}

function upsertTransaction(
  sql: SqlStorage,
  accountId: string,
  tx: SimplefinTransaction,
  now: number
): 'inserted' | 'updated' | 'skipped' {
  const normalized = normalizeMerchant(tx.description ?? '', tx.payee);
  const amount = parseFloat(tx.amount);
  if (!Number.isFinite(amount)) return 'skipped';

  // Atomic INSERT ON CONFLICT. The previous SELECT-then-write pattern could
  // race when two syncs (hourly cron + sync_now tool + manual /sync) ran
  // overlapping waitUntil tasks on the same DO: both would observe no
  // existing row and both attempt INSERT, triggering a PK conflict.
  const existed = sql
    .exec<{ existed: number }>(
      'SELECT 1 AS existed FROM transactions WHERE id = ? LIMIT 1',
      tx.id,
    )
    .toArray()[0];

  sql.exec(
    `INSERT INTO transactions
       (id, account_id, posted, amount, description, payee, normalized_payee, memo, pending, raw_json, ingested_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       account_id=excluded.account_id,
       posted=excluded.posted,
       amount=excluded.amount,
       description=excluded.description,
       payee=excluded.payee,
       normalized_payee=excluded.normalized_payee,
       memo=excluded.memo,
       pending=excluded.pending,
       raw_json=excluded.raw_json,
       updated_at=excluded.updated_at`,
    tx.id,
    accountId,
    tx.posted,
    amount,
    tx.description ?? '',
    tx.payee ?? null,
    normalized,
    tx.memo ?? null,
    tx.pending ? 1 : 0,
    JSON.stringify(tx),
    now,
    now,
  );

  return existed ? 'updated' : 'inserted';
}
