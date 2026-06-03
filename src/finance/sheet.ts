/**
 * Google Sheets reconciliation — the working layer on top of the raw SQLite
 * ledger.
 *
 * Ownership split (decided with the operator):
 *   - SQLite is the source of truth for **raw** SimpleFin data (date, account,
 *     amount, description). The bot owns these columns and refreshes them.
 *   - The Sheet is the source of truth for **enrichment** (cleaned Merchant,
 *     Category) and Notes. You edit those in place; the bot must never clobber
 *     your edits.
 *
 * The mechanism is a per-cell three-way merge, exactly like a git merge:
 *   base   = the value the bot last wrote to that cell (mirror in `sheet_rows`)
 *   theirs = the value currently in the sheet (live read each run)
 *   ours   = the value the bot would now write from its rules
 * If theirs !== base the human edited it → keep theirs, lock it, and harvest a
 * rule so the edit propagates. Otherwise the bot owns it and may write ours.
 *
 * `base` only ever records bot writes, so a human edit stays detected forever
 * (theirs !== base) until the human clears the cell — which we treat as
 * "hand it back to the bot".
 *
 * Row positions are NEVER trusted across runs: we re-read the whole sheet each
 * time and locate rows by tx_id (hidden column H). That makes the sync robust
 * to the user sorting or filtering the sheet.
 */

import type { Env } from '../env';
import { SheetsClient, type ValueRange } from '../runtime/sheets';
import { loadRules, applyRules, upsertRule, type Enrichment } from './rules';

const TAB = 'Transactions';
/** A:H — Date | Account | Amount | Raw Description | Merchant | Category | Notes | tx_id */
const DATA_RANGE = `${TAB}!A2:H`;
const HEADER = ['Date', 'Account', 'Amount', 'Raw Description', 'Merchant', 'Category', 'Notes', 'tx_id'];
/** 0-based column offsets within a row read from A:H. */
const COL = { date: 0, account: 1, amount: 2, desc: 3, merchant: 4, category: 5, notes: 6, txId: 7 } as const;

export interface ReconcileResult {
  configured: boolean;
  appended: number;
  updated: number;
  /** Cells where a human edit was detected and preserved this run. */
  humanEdits: number;
  /** Rules created/updated by harvesting human edits this run. */
  rulesHarvested: number;
  errors: string[];
}

interface TxForSheet {
  id: string;
  posted: number;
  amount: number;
  description: string;
  normalized_payee: string;
  account_name: string;
  [key: string]: SqlStorageValue;
}

interface MirrorRow {
  tx_id: string;
  bot_merchant: string;
  bot_category: string;
  locked_merchant: number;
  locked_category: number;
  [key: string]: SqlStorageValue;
}

/** Per-field three-way merge outcome. */
interface FieldMerge {
  /** Effective value now in the sheet after the merge. */
  value: string;
  /** True if the bot should write `value` to the cell. */
  botWrote: boolean;
  /** True if this is a preserved human override. */
  locked: boolean;
  /** Non-null when a human override should be harvested into a rule. */
  harvest: string | null;
}

function mergeField(theirsRaw: string, base: string, proposed: string): FieldMerge {
  const theirs = theirsRaw.trim();
  if (theirs !== base) {
    // Human (or some external actor) changed this cell.
    if (theirs === '') {
      // Cleared an override → hand it back to the bot, refill with proposed.
      return { value: proposed, botWrote: proposed !== '', locked: false, harvest: null };
    }
    return { value: theirs, botWrote: false, locked: true, harvest: theirs };
  }
  // Untouched since the bot last wrote (or both empty) → bot owns the cell.
  if (proposed !== theirs) {
    return { value: proposed, botWrote: true, locked: false, harvest: null };
  }
  return { value: theirs, botWrote: false, locked: false, harvest: null };
}

/**
 * Push new transactions into the sheet, pull back human edits, and harvest
 * rules from those edits. Safe to call on every heartbeat. No-ops (configured:
 * false) when the Google service account or sheet id isn't configured.
 */
export async function reconcileSheet(env: Env, sql: SqlStorage): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    configured: false,
    appended: 0,
    updated: 0,
    humanEdits: 0,
    rulesHarvested: 0,
    errors: [],
  };

  const client = SheetsClient.fromEnv(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const sheetId = env.FINANCE_SHEET_ID;
  if (!client || !sheetId) return result;
  result.configured = true;

  await ensureTab(client, sheetId);

  // 1. Live read of the whole data range — authoritative for row positions.
  const sheetRows = await client.getValues(sheetId, DATA_RANGE);
  const sheetByTx = new Map<string, { rowIndex: number; merchant: string; category: string; notes: string }>();
  sheetRows.forEach((r, i) => {
    const txId = r[COL.txId];
    if (txId) {
      sheetByTx.set(txId, {
        rowIndex: i + 2, // data starts at row 2
        merchant: r[COL.merchant] ?? '',
        category: r[COL.category] ?? '',
        notes: r[COL.notes] ?? '',
      });
    }
  });

  // 2. DB state: every transaction (joined to its account name) + the mirror.
  const txs = sql
    .exec<TxForSheet>(
      `SELECT t.id, t.posted, t.amount, t.description, t.normalized_payee,
              COALESCE(a.name, t.account_id) AS account_name
         FROM transactions t
         LEFT JOIN accounts a ON a.id = t.account_id
        ORDER BY t.posted ASC`,
    )
    .toArray();
  const mirror = new Map<string, MirrorRow>();
  for (const m of sql.exec<MirrorRow>('SELECT * FROM sheet_rows').toArray()) {
    mirror.set(m.tx_id, m);
  }
  const rules = loadRules(sql);

  const cellUpdates: ValueRange[] = [];
  const appendValues: (string | number | null)[][] = [];
  const appendTxIds: string[] = [];
  // Harvested edits, deduped by normalized_payee so N edited rows of the same
  // merchant produce one rule upsert.
  const harvestMerchant = new Map<string, string>();
  const harvestCategory = new Map<string, string>();

  for (const tx of txs) {
    const proposed: Enrichment = applyRules(rules, tx);
    const existing = sheetByTx.get(tx.id);

    if (!existing) {
      // New to the sheet → append. The bot owns both enrichment cells initially.
      appendValues.push([
        isoDate(tx.posted),
        tx.account_name,
        tx.amount,
        tx.description,
        proposed.merchant,
        proposed.category,
        '',
        tx.id,
      ]);
      appendTxIds.push(tx.id);
      upsertMirror(sql, {
        tx_id: tx.id,
        merchant: proposed.merchant,
        category: proposed.category,
        bot_merchant: proposed.merchant,
        bot_category: proposed.category,
        locked_merchant: 0,
        locked_category: 0,
        notes: '',
      });
      continue;
    }

    const base = mirror.get(tx.id);
    const baseMerchant = base?.bot_merchant ?? '';
    const baseCategory = base?.bot_category ?? '';

    const mMerge = mergeField(existing.merchant, baseMerchant, proposed.merchant);
    const cMerge = mergeField(existing.category, baseCategory, proposed.category);

    if (mMerge.harvest != null) {
      harvestMerchant.set(tx.normalized_payee, mMerge.harvest);
      result.humanEdits++;
    }
    if (cMerge.harvest != null) {
      harvestCategory.set(tx.normalized_payee, cMerge.harvest);
      result.humanEdits++;
    }

    if (mMerge.botWrote || cMerge.botWrote) {
      // Write E:F together — rewriting an unchanged cell is idempotent.
      cellUpdates.push({
        range: `${TAB}!E${existing.rowIndex}:F${existing.rowIndex}`,
        values: [[mMerge.value, cMerge.value]],
      });
    }

    upsertMirror(sql, {
      tx_id: tx.id,
      merchant: mMerge.value,
      category: cMerge.value,
      bot_merchant: mMerge.botWrote ? mMerge.value : baseMerchant,
      bot_category: cMerge.botWrote ? cMerge.value : baseCategory,
      locked_merchant: mMerge.locked ? 1 : 0,
      locked_category: cMerge.locked ? 1 : 0,
      notes: existing.notes,
    });
  }

  // 3. Harvest rules from detected edits. These take effect on the next
  //    reconcile, propagating to other unlocked rows of the same merchant.
  for (const [payee, merchant] of harvestMerchant) {
    upsertRule(sql, { match_type: 'merchant', pattern: payee, merchant, source: 'manual' });
    result.rulesHarvested++;
  }
  for (const [payee, category] of harvestCategory) {
    upsertRule(sql, { match_type: 'merchant', pattern: payee, category, source: 'manual' });
    // Avoid double-counting a merchant that had both dimensions edited.
    if (!harvestMerchant.has(payee)) result.rulesHarvested++;
  }

  // 4. Flush writes. Updates first (positions still valid), then appends.
  try {
    if (cellUpdates.length > 0) {
      await client.batchUpdateValues(sheetId, cellUpdates);
      result.updated = cellUpdates.length;
    }
    if (appendValues.length > 0) {
      const { firstRow } = await client.appendRows(sheetId, DATA_RANGE, appendValues);
      result.appended = appendValues.length;
      if (firstRow != null) {
        appendTxIds.forEach((txId, i) => recordRowIndex(sql, txId, firstRow + i));
      }
    }
  } catch (err) {
    result.errors.push((err as Error).message);
  }

  return result;
}

/** Ensure the Transactions tab exists with a header row + sensible formatting. */
async function ensureTab(client: SheetsClient, sheetId: string): Promise<void> {
  const tabs = await client.listTabs(sheetId);
  if (tabs.some((t) => t.title === TAB)) return;

  await client.batchUpdate(sheetId, [{ addSheet: { properties: { title: TAB } } }]);
  const created = (await client.listTabs(sheetId)).find((t) => t.title === TAB);
  await client.batchUpdateValues(sheetId, [{ range: `${TAB}!A1:H1`, values: [HEADER] }]);

  if (created) {
    await client.batchUpdate(sheetId, [
      // Freeze the header row.
      {
        updateSheetProperties: {
          properties: { sheetId: created.sheetId, gridProperties: { frozenRowCount: 1 } },
          fields: 'gridProperties.frozenRowCount',
        },
      },
      // Bold the header.
      {
        repeatCell: {
          range: { sheetId: created.sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: { userEnteredFormat: { textFormat: { bold: true } } },
          fields: 'userEnteredFormat.textFormat.bold',
        },
      },
      // Hide the tx_id join key (column H, index 7).
      {
        updateDimensionProperties: {
          range: { sheetId: created.sheetId, dimension: 'COLUMNS', startIndex: 7, endIndex: 8 },
          properties: { hiddenByUser: true },
          fields: 'hiddenByUser',
        },
      },
    ]);
  }
}

function upsertMirror(
  sql: SqlStorage,
  row: {
    tx_id: string;
    merchant: string;
    category: string;
    bot_merchant: string;
    bot_category: string;
    locked_merchant: number;
    locked_category: number;
    notes: string;
  },
): void {
  sql.exec(
    `INSERT INTO sheet_rows
       (tx_id, merchant, category, bot_merchant, bot_category, locked_merchant, locked_category, notes, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tx_id) DO UPDATE SET
       merchant=excluded.merchant,
       category=excluded.category,
       bot_merchant=excluded.bot_merchant,
       bot_category=excluded.bot_category,
       locked_merchant=excluded.locked_merchant,
       locked_category=excluded.locked_category,
       notes=excluded.notes,
       synced_at=excluded.synced_at`,
    row.tx_id,
    row.merchant,
    row.category,
    row.bot_merchant,
    row.bot_category,
    row.locked_merchant,
    row.locked_category,
    row.notes,
    Date.now(),
  );
}

function recordRowIndex(sql: SqlStorage, txId: string, rowIndex: number): void {
  sql.exec('UPDATE sheet_rows SET row_index = ? WHERE tx_id = ?', rowIndex, txId);
}

function isoDate(postedSec: number): string {
  return new Date(postedSec * 1000).toISOString().slice(0, 10);
}
