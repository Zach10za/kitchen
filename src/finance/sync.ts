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

  const lastSynced = sql
    .exec<{ ts: number | null }>('SELECT MAX(last_synced_at) AS ts FROM accounts')
    .toArray()[0]?.ts ?? 0;

  const startDate =
    lastSynced > 0
      ? Math.floor(lastSynced / 1000) - SYNC_OVERLAP_DAYS * 86_400
      : Math.floor(Date.now() / 1000) - FIRST_SYNC_LOOKBACK_DAYS * 86_400;

  const response = await client.fetchAccounts({ startDate });

  const result: SyncResult = {
    accountsUpdated: 0,
    transactionsInserted: 0,
    transactionsUpdated: 0,
    errors: response.errors ?? [],
    startDate,
  };

  const now = Date.now();
  for (const account of response.accounts) {
    upsertAccount(sql, account, now);
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

  const existing = sql
    .exec<{ id: string }>('SELECT id FROM transactions WHERE id = ?', tx.id)
    .toArray()[0];

  if (existing) {
    sql.exec(
      `UPDATE transactions SET
         account_id=?, posted=?, amount=?, description=?, payee=?, normalized_payee=?, memo=?, pending=?, raw_json=?, updated_at=?
       WHERE id=?`,
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
      tx.id
    );
    return 'updated';
  }

  sql.exec(
    `INSERT INTO transactions
       (id, account_id, posted, amount, description, payee, normalized_payee, memo, pending, raw_json, ingested_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    now
  );
  return 'inserted';
}
