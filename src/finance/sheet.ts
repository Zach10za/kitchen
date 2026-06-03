/**
 * Google Sheets reconciliation — the working layer on top of the raw SQLite
 * ledger. Maintains four tabs:
 *
 *   Transactions — one row per transaction, SPENDING accounts only (checking,
 *                  credit, cash). Cleaned Merchant + Category are editable; the
 *                  bot proposes, you override, the bot never clobbers your edit.
 *   Accounts     — one row per account with an editable Type. The bot guesses
 *                  the type; you correct it here and the correction sticks.
 *   Balances     — append-only daily snapshot of every account's balance, so
 *                  every account's balance history is captured over time.
 *   Net Worth    — append-only daily assets / liabilities / net total.
 *
 * Ownership split: SQLite is the source of truth for raw SimpleFin data and for
 * account classification (account_meta, seeded on sync); the sheet is the source
 * of truth for cleaned merchant names, categories, and type corrections. Edits
 * are reconciled with a per-cell three-way merge (base = the value the bot last
 * wrote, theirs = the current sheet value, ours = the value rules/classification
 * now imply): theirs !== base means a human edit, which is preserved and learned.
 *
 * Row positions are never trusted across runs — the whole sheet is re-read each
 * time and rows located by a hidden key column, so sorting/filtering is safe.
 */

import type { Env } from '../env';
import { SheetsClient, type ValueRange } from '../runtime/sheets';
import { loadRules, applyRules, upsertRule, type Enrichment } from './rules';
import {
  loadAccountMeta,
  setAccountType,
  currentBalances,
  summarizeNetWorth,
  coerceType,
  localDate,
  spendingFilter,
  ACCOUNT_TYPES,
  type AccountMetaRow,
} from './accounts';

const TX_TAB = 'Transactions';
const ACCT_TAB = 'Accounts';
const BAL_TAB = 'Balances';
const NW_TAB = 'Net Worth';

const TX_RANGE = `${TX_TAB}!A2:H`;
const TX_HEADER = ['Date', 'Account', 'Amount', 'Raw Description', 'Merchant', 'Category', 'Notes', 'tx_id'];
const TX_COL = { date: 0, account: 1, amount: 2, desc: 3, merchant: 4, category: 5, notes: 6, txId: 7 } as const;

const ACCT_RANGE = `${ACCT_TAB}!A2:G`;
const ACCT_HEADER = ['Account', 'Institution', 'Type', 'Balance', 'Currency', 'Last Synced', 'account_id'];
const ACCT_COL = { name: 0, org: 1, type: 2, balance: 3, currency: 4, synced: 5, id: 6 } as const;

const BAL_HEADER = ['Date', 'Account', 'Type', 'Balance'];
const NW_HEADER = ['Date', 'Assets', 'Liabilities', 'Net Worth'];

export interface ReconcileResult {
  configured: boolean;
  appended: number;
  updated: number;
  deleted: number;
  humanEdits: number;
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

interface FieldMerge {
  value: string;
  botWrote: boolean;
  locked: boolean;
  harvest: string | null;
}

function mergeField(theirsRaw: string, base: string, proposed: string): FieldMerge {
  const theirs = theirsRaw.trim();
  if (theirs !== base) {
    if (theirs === '') {
      // Human cleared an override → hand the cell back to the bot.
      return { value: proposed, botWrote: proposed !== '', locked: false, harvest: null };
    }
    return { value: theirs, botWrote: false, locked: true, harvest: theirs };
  }
  if (proposed !== theirs) {
    return { value: proposed, botWrote: true, locked: false, harvest: null };
  }
  return { value: theirs, botWrote: false, locked: false, harvest: null };
}

/**
 * Reconcile every tab. Safe to call on each heartbeat. No-ops (configured:
 * false) when the Google service account or sheet id isn't configured. Each
 * section is wrapped so one failing tab can't abort the others.
 */
export async function reconcileSheet(env: Env, sql: SqlStorage): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    configured: false,
    appended: 0,
    updated: 0,
    deleted: 0,
    humanEdits: 0,
    rulesHarvested: 0,
    errors: [],
  };

  const client = SheetsClient.fromEnv(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const sheetId = env.FINANCE_SHEET_ID;
  if (!client || !sheetId) return result;
  result.configured = true;

  for (const section of [reconcileTransactions, reconcileAccountsTab, reconcileHistory]) {
    try {
      await section(client, sheetId, env, sql, result);
    } catch (err) {
      result.errors.push(`${section.name}: ${(err as Error).message}`);
    }
  }
  return result;
}

// ─── Transactions tab ──────────────────────────────────────────────────────

async function reconcileTransactions(
  client: SheetsClient,
  sheetId: string,
  _env: Env,
  sql: SqlStorage,
  result: ReconcileResult,
): Promise<void> {
  const { tabId, created } = await ensureTab(client, sheetId, TX_TAB, TX_HEADER, TX_COL.txId);
  if (created) {
    await client.setColumnFormats(sheetId, tabId, [
      { col: TX_COL.date, kind: 'date' },
      { col: TX_COL.amount, kind: 'currency' },
    ]);
    // A basic filter gives instant per-column sort/filter UI — the main lever
    // for diagnosing spend (filter to a category, sort by amount).
    await client.batchUpdate(sheetId, [
      { setBasicFilter: { filter: { range: { sheetId: tabId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: TX_HEADER.length } } } },
    ]);
  }
  // Refresh the Category dropdown from the categories in use (non-strict, so new
  // ones can still be typed). Cheap and keeps the menu current as labels grow.
  const categories = sql
    .exec<{ category: string }>(
      "SELECT DISTINCT TRIM(category) AS category FROM sheet_rows WHERE TRIM(category) <> '' ORDER BY category",
    )
    .toArray()
    .map((r) => r.category);
  if (categories.length > 0) {
    await client.setListValidation(sheetId, tabId, TX_COL.category, categories, false);
  }

  const sheetRows = await client.getValues(sheetId, TX_RANGE);
  const sheetByTx = new Map<string, { rowIndex: number; merchant: string; category: string; notes: string }>();
  sheetRows.forEach((r, i) => {
    const txId = r[TX_COL.txId];
    if (txId) {
      sheetByTx.set(txId, {
        rowIndex: i + 2,
        merchant: r[TX_COL.merchant] ?? '',
        category: r[TX_COL.category] ?? '',
        notes: r[TX_COL.notes] ?? '',
      });
    }
  });

  // Spending accounts only. Investment/loan transactions never enter the sheet.
  const txs = sql
    .exec<TxForSheet>(
      `SELECT t.id, t.posted, t.amount, t.description, t.normalized_payee,
              COALESCE(a.name, t.account_id) AS account_name
         FROM transactions t
         LEFT JOIN accounts a ON a.id = t.account_id
        WHERE ${spendingFilter('t')}
        ORDER BY t.posted ASC`,
    )
    .toArray();
  const spendingIds = new Set(txs.map((t) => t.id));

  const mirror = new Map<string, MirrorRow>();
  for (const m of sql.exec<MirrorRow>('SELECT * FROM sheet_rows').toArray()) mirror.set(m.tx_id, m);
  const rules = loadRules(sql);

  const cellUpdates: ValueRange[] = [];
  const appendValues: (string | number | null)[][] = [];
  const appendTxIds: string[] = [];
  const harvestMerchant = new Map<string, string>();
  const harvestCategory = new Map<string, string>();

  for (const tx of txs) {
    const proposed: Enrichment = applyRules(rules, tx);
    const existing = sheetByTx.get(tx.id);

    if (!existing) {
      appendValues.push([
        isoDate(tx.posted), tx.account_name, tx.amount, tx.description,
        proposed.merchant, proposed.category, '', tx.id,
      ]);
      appendTxIds.push(tx.id);
      upsertMirror(sql, {
        tx_id: tx.id, merchant: proposed.merchant, category: proposed.category,
        bot_merchant: proposed.merchant, bot_category: proposed.category,
        locked_merchant: 0, locked_category: 0, notes: '',
      });
      continue;
    }

    const base = mirror.get(tx.id);
    const baseMerchant = base?.bot_merchant ?? '';
    const baseCategory = base?.bot_category ?? '';
    const mMerge = mergeField(existing.merchant, baseMerchant, proposed.merchant);
    const cMerge = mergeField(existing.category, baseCategory, proposed.category);

    if (mMerge.harvest != null) { harvestMerchant.set(tx.normalized_payee, mMerge.harvest); result.humanEdits++; }
    if (cMerge.harvest != null) { harvestCategory.set(tx.normalized_payee, cMerge.harvest); result.humanEdits++; }

    if (mMerge.botWrote || cMerge.botWrote) {
      cellUpdates.push({
        range: `${TX_TAB}!E${existing.rowIndex}:F${existing.rowIndex}`,
        values: [[mMerge.value, cMerge.value]],
      });
    }

    upsertMirror(sql, {
      tx_id: tx.id, merchant: mMerge.value, category: cMerge.value,
      bot_merchant: mMerge.botWrote ? mMerge.value : baseMerchant,
      bot_category: cMerge.botWrote ? cMerge.value : baseCategory,
      locked_merchant: mMerge.locked ? 1 : 0, locked_category: cMerge.locked ? 1 : 0,
      notes: existing.notes,
    });
  }

  // Rows whose account is no longer spending (reclassified) or whose tx is gone.
  const orphanRows: number[] = [];
  for (const [txId, row] of sheetByTx) {
    if (!spendingIds.has(txId)) {
      orphanRows.push(row.rowIndex);
      sql.exec('DELETE FROM sheet_rows WHERE tx_id = ?', txId);
    }
  }

  // Harvest edits into rules (apply to other unlocked rows next reconcile).
  for (const [payee, merchant] of harvestMerchant) {
    upsertRule(sql, { match_type: 'merchant', pattern: payee, merchant, source: 'manual' });
    result.rulesHarvested++;
  }
  for (const [payee, category] of harvestCategory) {
    upsertRule(sql, { match_type: 'merchant', pattern: payee, category, source: 'manual' });
    if (!harvestMerchant.has(payee)) result.rulesHarvested++;
  }

  // Apply writes: updates first (original indices valid), then deletes
  // (descending), then appends (always go to the bottom).
  if (cellUpdates.length > 0) {
    await client.batchUpdateValues(sheetId, cellUpdates);
    result.updated += cellUpdates.length;
  }
  if (orphanRows.length > 0) {
    await client.deleteRows(sheetId, tabId, orphanRows);
    result.deleted += orphanRows.length;
  }
  if (appendValues.length > 0) {
    const { firstRow } = await client.appendRows(sheetId, TX_RANGE, appendValues);
    result.appended += appendValues.length;
    if (firstRow != null) appendTxIds.forEach((txId, i) => recordRowIndex(sql, txId, firstRow + i));
  }
}

// ─── Accounts tab (classification surface) ───────────────────────────────────

async function reconcileAccountsTab(
  client: SheetsClient,
  sheetId: string,
  _env: Env,
  sql: SqlStorage,
  result: ReconcileResult,
): Promise<void> {
  const { tabId, created } = await ensureTab(client, sheetId, ACCT_TAB, ACCT_HEADER, ACCT_COL.id);
  if (created) {
    await client.setColumnFormats(sheetId, tabId, [
      { col: ACCT_COL.balance, kind: 'currency' },
      { col: ACCT_COL.synced, kind: 'date' },
    ]);
    // Strict dropdown — keeps Type to the known vocabulary so it always maps to
    // a real classification (no coerce-to-'other' surprises from a typo).
    await client.setListValidation(sheetId, tabId, ACCT_COL.type, [...ACCOUNT_TYPES], true);
  }

  const sheetRows = await client.getValues(sheetId, ACCT_RANGE);
  const sheetByAcct = new Map<string, { rowIndex: number; type: string }>();
  sheetRows.forEach((r, i) => {
    const id = r[ACCT_COL.id];
    if (id) sheetByAcct.set(id, { rowIndex: i + 2, type: r[ACCT_COL.type] ?? '' });
  });

  const balances = currentBalances(sql);
  const meta = loadAccountMeta(sql);

  const rowUpdates: ValueRange[] = [];
  const appendValues: (string | number | null)[][] = [];

  for (const acct of balances) {
    const m: AccountMetaRow | undefined = meta.get(acct.account_id);
    const effectiveType = m?.type ?? acct.type;
    const baseType = m?.bot_type ?? '';
    const existing = sheetByAcct.get(acct.account_id);
    const liveCells = [acct.name, acct.org ?? '', '', acct.balance, acct.currency, isoDate(Math.floor(acct.last_synced_at / 1000))];

    if (!existing) {
      liveCells[ACCT_COL.type] = effectiveType;
      appendValues.push([...liveCells, acct.account_id]);
      // Record the type we just wrote as the merge base.
      setBotType(sql, acct.account_id, effectiveType);
      continue;
    }

    const merge = mergeField(coerceType(existing.type), baseType, effectiveType);
    if (merge.harvest != null) {
      // User changed the Type cell → persist as the locked classification.
      setAccountType(sql, acct.account_id, coerceType(merge.value));
      result.humanEdits++;
    } else if (merge.botWrote) {
      setBotType(sql, acct.account_id, merge.value);
    }
    liveCells[ACCT_COL.type] = merge.value;
    // Refresh the whole row (writing the Type cell with its current effective
    // value is idempotent when it's a human-owned override).
    rowUpdates.push({ range: `${ACCT_TAB}!A${existing.rowIndex}:F${existing.rowIndex}`, values: [liveCells] });
  }

  if (rowUpdates.length > 0) {
    await client.batchUpdateValues(sheetId, rowUpdates);
    result.updated += rowUpdates.length;
  }
  if (appendValues.length > 0) {
    await client.appendRows(sheetId, ACCT_RANGE, appendValues);
    result.appended += appendValues.length;
  }
}

// ─── History tabs (Balances + Net Worth), once per local day ─────────────────

async function reconcileHistory(
  client: SheetsClient,
  sheetId: string,
  env: Env,
  sql: SqlStorage,
  result: ReconcileResult,
): Promise<void> {
  const today = localDate(env.TIMEZONE);
  if (getSetting(sql, 'sheet_history_date') === today) return; // already captured today

  const bal = await ensureTab(client, sheetId, BAL_TAB, BAL_HEADER, null);
  if (bal.created) {
    await client.setColumnFormats(sheetId, bal.tabId, [{ col: 0, kind: 'date' }, { col: 3, kind: 'currency' }]);
  }
  const nwTab = await ensureTab(client, sheetId, NW_TAB, NW_HEADER, null);
  if (nwTab.created) {
    await client.setColumnFormats(sheetId, nwTab.tabId, [
      { col: 0, kind: 'date' }, { col: 1, kind: 'currency' }, { col: 2, kind: 'currency' }, { col: 3, kind: 'currency' },
    ]);
  }
  // Add the net-worth line chart once. Open-ended source ranges auto-extend as
  // daily rows are appended, so the chart stays current without maintenance.
  if (await client.countCharts(sheetId, nwTab.tabId) === 0) {
    await client.batchUpdate(sheetId, [netWorthChartRequest(nwTab.tabId)]);
  }

  const balances = currentBalances(sql);
  if (balances.length === 0) return;

  const balRows = balances.map((b) => [today, b.name, b.type, b.balance]);
  await client.appendRows(sheetId, `${BAL_TAB}!A2:D`, balRows);
  result.appended += balRows.length;

  const nw = summarizeNetWorth(balances);
  await client.appendRows(sheetId, `${NW_TAB}!A2:D`, [[today, nw.assets, nw.liabilities, nw.net]]);
  result.appended += 1;

  setSetting(sql, 'sheet_history_date', today);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Ensure a tab exists with a header row; freeze + bold the header and
 *  optionally hide one key column. Reports whether it was just created so
 *  callers can apply one-time formatting only on first creation. */
async function ensureTab(
  client: SheetsClient,
  sheetId: string,
  title: string,
  header: string[],
  hideColIndex: number | null,
): Promise<{ tabId: number; created: boolean }> {
  const existing = (await client.listTabs(sheetId)).find((t) => t.title === title);
  if (existing) return { tabId: existing.sheetId, created: false };

  await client.batchUpdate(sheetId, [{ addSheet: { properties: { title } } }]);
  const made = (await client.listTabs(sheetId)).find((t) => t.title === title);
  if (!made) return { tabId: 0, created: false };

  const colLetter = String.fromCharCode(65 + header.length - 1);
  await client.batchUpdateValues(sheetId, [{ range: `${title}!A1:${colLetter}1`, values: [header] }]);

  const requests: unknown[] = [
    {
      updateSheetProperties: {
        properties: { sheetId: made.sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    },
    {
      repeatCell: {
        range: { sheetId: made.sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: 'userEnteredFormat.textFormat.bold',
      },
    },
  ];
  if (hideColIndex != null) {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId: made.sheetId, dimension: 'COLUMNS', startIndex: hideColIndex, endIndex: hideColIndex + 1 },
        properties: { hiddenByUser: true },
        fields: 'hiddenByUser',
      },
    });
  }
  await client.batchUpdate(sheetId, requests);
  return { tabId: made.sheetId, created: true };
}

function upsertMirror(
  sql: SqlStorage,
  row: {
    tx_id: string; merchant: string; category: string;
    bot_merchant: string; bot_category: string;
    locked_merchant: number; locked_category: number; notes: string;
  },
): void {
  sql.exec(
    `INSERT INTO sheet_rows
       (tx_id, merchant, category, bot_merchant, bot_category, locked_merchant, locked_category, notes, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tx_id) DO UPDATE SET
       merchant=excluded.merchant, category=excluded.category,
       bot_merchant=excluded.bot_merchant, bot_category=excluded.bot_category,
       locked_merchant=excluded.locked_merchant, locked_category=excluded.locked_category,
       notes=excluded.notes, synced_at=excluded.synced_at`,
    row.tx_id, row.merchant, row.category, row.bot_merchant, row.bot_category,
    row.locked_merchant, row.locked_category, row.notes, Date.now(),
  );
}

/** Record the type the bot last wrote to the Accounts sheet (the merge base),
 *  without changing the effective type or lock flag. */
function setBotType(sql: SqlStorage, accountId: string, botType: string): void {
  sql.exec('UPDATE account_meta SET bot_type = ?, synced_at = ? WHERE account_id = ?', botType, Date.now(), accountId);
}

function recordRowIndex(sql: SqlStorage, txId: string, rowIndex: number): void {
  sql.exec('UPDATE sheet_rows SET row_index = ? WHERE tx_id = ?', rowIndex, txId);
}

function getSetting(sql: SqlStorage, key: string): string | null {
  return sql.exec<{ value: string }>('SELECT value FROM settings WHERE key = ?', key).toArray()[0]?.value ?? null;
}

function setSetting(sql: SqlStorage, key: string, value: string): void {
  sql.exec(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
    key, value, Date.now(),
  );
}

function isoDate(postedSec: number): string {
  return new Date(postedSec * 1000).toISOString().slice(0, 10);
}

/** A LINE chart of Assets / Liabilities / Net Worth over Date for the Net Worth
 *  tab. Source ranges omit endRowIndex so the chart grows with the data. */
function netWorthChartRequest(tabId: number): unknown {
  const colRange = (col: number) => ({
    sourceRange: { sources: [{ sheetId: tabId, startRowIndex: 0, startColumnIndex: col, endColumnIndex: col + 1 }] },
  });
  return {
    addChart: {
      chart: {
        spec: {
          title: 'Net Worth Over Time',
          basicChart: {
            chartType: 'LINE',
            legendPosition: 'BOTTOM_LEGEND',
            headerCount: 1,
            axis: [
              { position: 'BOTTOM_AXIS', title: 'Date' },
              { position: 'LEFT_AXIS', title: 'USD' },
            ],
            domains: [{ domain: colRange(0) }],
            series: [
              { series: colRange(1), targetAxis: 'LEFT_AXIS' }, // Assets
              { series: colRange(2), targetAxis: 'LEFT_AXIS' }, // Liabilities
              { series: colRange(3), targetAxis: 'LEFT_AXIS' }, // Net Worth
            ],
          },
        },
        position: { overlayPosition: { anchorCell: { sheetId: tabId, rowIndex: 1, columnIndex: 5 } } },
      },
    },
  };
}
