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
 * Two correctness invariants this module upholds:
 *   1. The SQLite mirror (the merge `base`) is advanced ONLY after the sheet
 *      write it represents succeeds. Writing the mirror first would, on a failed
 *      write, make the next run mistake the un-written value for a human edit —
 *      fabricating rules and locking cells. So: sheet first, mirror second.
 *   2. Reconciles are serialized (see the module-level lock). reconcileSheet is
 *      called from the hourly heartbeat and from chat tools; Durable Objects
 *      interleave at await points, so without serialization two runs could
 *      double-append rows or double-create tabs.
 *
 * Row positions are never trusted across runs — the whole sheet is re-read each
 * time and rows located by a hidden key column, so sorting/filtering is safe.
 */

import type { Env } from '../env';
import { SheetsClient, type ValueRange } from '../runtime/sheets';
import { TRANSFER_CATEGORY } from './cashflow';
import { CATEGORY_TAXONOMY, CLASSIFY_TAXONOMY, classifyMerchants } from './categorize';
import {
  loadAccountMeta,
  setAccountType,
  setNickname,
  setBotNickname,
  currentBalances,
  summarizeNetWorth,
  coerceType,
  localDate,
  ACCOUNT_TYPES,
  type AccountMetaRow,
  type AccountBalance,
} from './accounts';

const TX_TAB = 'Transactions';
const ACCT_TAB = 'Accounts';
const BAL_TAB = 'Balances';
const NW_TAB = 'Net Worth';

/** Build a quoted A1 range. Sheet titles with spaces or punctuation (e.g.
 *  "Net Worth") MUST be single-quoted in A1 notation or the API rejects the
 *  range. Quoting an already-safe title is harmless, so we quote everywhere. */
function a1(tab: string, range: string): string {
  return `'${tab.replace(/'/g, "''")}'!${range}`;
}

/** Run a non-essential formatting call, recording (not throwing) any failure so
 *  a cosmetic error never aborts the data reconcile. */
async function applyFormatting(
  result: ReconcileResult,
  label: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    result.errors.push(`${label}: ${(err as Error).message}`);
  }
}

const MAP_TAB = 'Mappings';
// A: the bot's merchant grouping key (normalized). B: the user's clean name.
// D: clean merchant. E: its category. C is a spacer between the two tables.
const MAP_HEADER = ['Merchant (raw)', 'Clean Name', '', 'Merchant', 'Category'];
const MAP_CAT_COL = 4; // column E (Category) on the Mappings tab
/** Merchant (E) resolves the row's normalized key (col K) → Clean Name via the
 *  merchant map; Category (F) resolves the Clean Name (col E) → category. Both
 *  are live, so editing the Mappings tab updates every matching transaction. */
const merchantRef = (row: number) => `=IFERROR(XLOOKUP($K${row},${MAP_TAB}!$A:$A,${MAP_TAB}!$B:$B),$K${row})`;
const categoryRef = (row: number) => `=IFERROR(XLOOKUP($E${row},${MAP_TAB}!$D:$D,${MAP_TAB}!$E:$E),"")`;

const TX_RANGE = a1(TX_TAB, 'A2:K');
const TX_HEADER = ['Date', 'Account', 'Amount', 'Raw Description', 'Merchant', 'Category', 'Notes', 'tx_id', 'account_id', 'Exclude', 'merchant_key'];
const TX_COL = { date: 0, account: 1, amount: 2, desc: 3, merchant: 4, category: 5, notes: 6, txId: 7, acctId: 8, exclude: 9, mkey: 10 } as const;
/** Hidden bot-owned columns: tx_id, account_id, merchant_key. */
const TX_HIDDEN = [TX_COL.txId, TX_COL.acctId, TX_COL.mkey];
/** Column letter of the user-checkable Exclude column (J), for formulas. */
const TX_EXCLUDE_COL = 'J';

const ACCT_RANGE = a1(ACCT_TAB, 'A2:H');
const ACCT_HEADER = ['Account', 'Institution', 'Type', 'Balance', 'Currency', 'Last Synced', 'account_id', 'Nickname'];
const ACCT_COL = { name: 0, org: 1, type: 2, balance: 3, currency: 4, synced: 5, id: 6, nickname: 7 } as const;

const BAL_RANGE = a1(BAL_TAB, 'A2:E');
const BAL_HEADER = ['Date', 'Account', 'Type', 'Balance', 'account_id'];
const BAL_COL = { date: 0, account: 1, type: 2, balance: 3, id: 4 } as const;
const NW_HEADER = ['Date', 'Assets', 'Liabilities', 'Net Worth'];

const CF_TAB = 'Cash Flow';
const CF_HEADER = ['Month', 'Inflows', 'Outflows', 'Net'];
/** Cap on how many recent months the Cash Flow tab shows (it starts at the
 *  first month with data, so it won't show empty leading months). */
const CF_MAX_MONTHS = 36;

const SC_TAB = 'Spend by Category';
/** Spend-analysis columns: the taxonomy minus Income (inflow, not spend). */
const SPEND_CATEGORIES = CATEGORY_TAXONOMY.filter((c) => c !== 'Income');
/** Months (rows) the spend-by-category matrix shows. */
const SC_MONTHS = 12;

/** Column letters (1-based A=1) for building A1 cell refs inside formulas. */
const COL_LETTER = (idx0: number) => String.fromCharCode(65 + idx0);

/** Display-name reference: nickname (Accounts col H) if set, else the SimpleFin
 *  name (col A), looked up by account_id (col G). Keyed on id so it survives
 *  renames. `idCell` is an A1 ref like `$I5` (the row's hidden account_id cell). */
function accountNameRef(idCell: string): string {
  const G = `${ACCT_TAB}!$G:$G`;
  return `=IFERROR(LET(n,XLOOKUP(${idCell},${G},${ACCT_TAB}!$H:$H),IF(n="",XLOOKUP(${idCell},${G},${ACCT_TAB}!$A:$A),n)),"")`;
}

/** Type reference, looked up by account_id (Accounts col G → col C). */
function accountTypeRef(idCell: string): string {
  return `=IFERROR(XLOOKUP(${idCell},${ACCT_TAB}!$G:$G,${ACCT_TAB}!$C:$C),"")`;
}

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
  account_id: string;
  [key: string]: SqlStorageValue;
}

interface MirrorWrite {
  tx_id: string;
  merchant: string;
  category: string;
  bot_merchant: string;
  bot_category: string;
  locked_merchant: number;
  locked_category: number;
  notes: string;
  excluded: number;
}

interface FieldMerge {
  value: string;
  /** The bot should write `value` to the cell, and `value` becomes the new base. */
  botWrote: boolean;
  /** A preserved human override (don't write, keep base where it is). */
  locked: boolean;
  /** Non-null when a fresh human override should be harvested into a rule. */
  harvest: string | null;
}

/**
 * Per-cell three-way merge.
 *
 * The non-obvious case is `proposed === theirs && theirs !== base`: the rule (or
 * classification) now reproduces exactly what's in the cell — typically because
 * a *previous* run harvested this very edit into a rule. We adopt it as
 * bot-owned (botWrote, so base catches up) and DON'T harvest again. That's what
 * makes the merge converge: a harvested edit stops being re-detected after one
 * more run, instead of re-firing every reconcile.
 */
function mergeField(theirsRaw: string, base: string, proposed: string): FieldMerge {
  const theirs = theirsRaw.trim();
  if (theirs === base) {
    if (proposed !== theirs) return { value: proposed, botWrote: true, locked: false, harvest: null };
    return { value: theirs, botWrote: false, locked: false, harvest: null };
  }
  // theirs !== base
  if (theirs === '') {
    // Cleared cell → hand back to the bot. NOTE: `proposed` still reflects any
    // rule harvested from a prior edit, so a learned categorization re-appears;
    // to truly drop it, remove the rule (list_rules), not just the cell.
    return { value: proposed, botWrote: proposed !== '', locked: false, harvest: null };
  }
  if (proposed === theirs) {
    return { value: theirs, botWrote: true, locked: false, harvest: null };
  }
  return { value: theirs, botWrote: false, locked: true, harvest: theirs };
}

// ─── Serialization ───────────────────────────────────────────────────────────

/** Serializes reconciles within a DO isolate (one FinanceDO instance). Chained
 *  so the heartbeat and the chat tools can't interleave their reads/writes. */
let reconcileChain: Promise<unknown> = Promise.resolve();

export function reconcileSheet(env: Env, sql: SqlStorage): Promise<ReconcileResult> {
  const next = reconcileChain.then(() => runReconcile(env, sql));
  // Keep the chain alive regardless of this run's outcome.
  reconcileChain = next.catch(() => undefined);
  return next;
}

/**
 * Reconcile every tab. No-ops (configured: false) when the Google service
 * account or sheet id isn't configured. Each section is wrapped so one failing
 * tab can't abort the others; individual sheet writes are wrapped so the mirror
 * only advances for writes that actually landed.
 */
async function runReconcile(env: Env, sql: SqlStorage): Promise<ReconcileResult> {
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

  for (const section of [reconcileMappings, reconcileTransactions, reconcileAccountsTab, reconcileHistory, reconcileCashFlow, reconcileSpendByCategory]) {
    try {
      await section(client, sheetId, env, sql, result);
    } catch (err) {
      result.errors.push(`${section.name}: ${(err as Error).message}`);
    }
  }
  return result;
}

// ─── Mappings tab (merchant renames + category map; bot seeds, user curates) ──

/**
 * Maintains the Mappings tab — the single editable source of truth for cleaned
 * merchant names and categories. Two side-by-side tables:
 *   A: Merchant (raw)  B: Clean Name        — one row per distinct merchant key
 *   D: Merchant        E: Category          — one row per distinct clean name
 *
 * The bot SEEDS rows (clean = bot's normalized name; category = LLM-classified,
 * incl. "Transfer") and PRESERVES the user's edits — it reads the existing
 * values first, then rewrites the full lists, so a clean name/category the user
 * typed is kept. The Transactions tab resolves both maps with live XLOOKUP
 * formulas, so editing one cell here updates every matching transaction.
 */
async function reconcileMappings(
  client: SheetsClient,
  sheetId: string,
  env: Env,
  sql: SqlStorage,
  result: ReconcileResult,
): Promise<void> {
  const { tabId } = await ensureTab(client, sheetId, MAP_TAB, MAP_HEADER, []);

  // Merchant map: one row per distinct merchant key (normalized_payee). Preserve
  // existing clean names; seed new keys with the bot's normalized guess.
  const existingClean = await readMap(client, sheetId, a1(MAP_TAB, 'A2:B'));
  const keys = sql
    .exec<{ k: string }>("SELECT DISTINCT normalized_payee AS k FROM transactions WHERE TRIM(normalized_payee) <> '' ORDER BY normalized_payee")
    .toArray()
    .map((r) => r.k);
  const merchantRows = keys.map((k) => [k, existingClean.get(k) || k]);
  const cleanNames = [...new Set(merchantRows.map((r) => (r[1] as string).trim()).filter(Boolean))];

  // Category map: one row per distinct clean name. Preserve existing categories;
  // classify the new ones (LLM, "Transfer" included).
  const existingCat = await readMap(client, sheetId, a1(MAP_TAB, 'D2:E'));
  const newCleans = cleanNames.filter((c) => !existingCat.has(c));
  let classified = new Map<string, string>();
  if (newCleans.length > 0) {
    try {
      classified = await classifyMerchants(env, newCleans);
    } catch (err) {
      result.errors.push(`classify: ${(err as Error).message}`);
    }
  }
  const catRows = cleanNames.map((c) => [c, existingCat.get(c) || classified.get(c) || 'Other']);

  try {
    await client.batchUpdateValues(sheetId, [{ range: a1(MAP_TAB, 'A1:E1'), values: [MAP_HEADER] }]);
    await client.clearValues(sheetId, a1(MAP_TAB, 'A2:E'));
    if (merchantRows.length > 0) await client.batchUpdateValues(sheetId, [{ range: a1(MAP_TAB, `A2:B${merchantRows.length + 1}`), values: merchantRows }]);
    if (catRows.length > 0) await client.batchUpdateValues(sheetId, [{ range: a1(MAP_TAB, `D2:E${catRows.length + 1}`), values: catRows }]);
  } catch (err) {
    result.errors.push(`mappings: ${(err as Error).message}`);
  }

  await applyFormatting(result, 'map-cat-dropdown', () =>
    client.setListValidation(sheetId, tabId, MAP_CAT_COL, [...CLASSIFY_TAXONOMY], false),
  );
}

// ─── Transactions tab ──────────────────────────────────────────────────────

async function reconcileTransactions(
  client: SheetsClient,
  sheetId: string,
  _env: Env,
  sql: SqlStorage,
  result: ReconcileResult,
): Promise<void> {
  const { tabId, created } = await ensureTab(client, sheetId, TX_TAB, TX_HEADER, TX_HIDDEN);
  if (created) {
    await client.batchUpdate(sheetId, [
      { setBasicFilter: { filter: { range: { sheetId: tabId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: TX_HEADER.length } } } },
    ]);
  }
  await ensureLayout(client, sheetId, tabId, TX_TAB, TX_HEADER, TX_HIDDEN, result);

  // Maps drive Merchant (merchant_key→clean) and Category (clean→category). The
  // sheet resolves them with live XLOOKUP formulas; the bot reads them here only
  // to compute the SQLite category mirror the chat tools use.
  const cleanByKey = await readMap(client, sheetId, a1(MAP_TAB, 'A2:B'));
  const categoryByClean = await readMap(client, sheetId, a1(MAP_TAB, 'D2:E'));

  const sheetRows = await client.getValues(sheetId, TX_RANGE);
  const sheetByTx = new Map<string, { rowIndex: number; acctId: string; excluded: number; mkey: string }>();
  sheetRows.forEach((r, i) => {
    const txId = r[TX_COL.txId];
    if (txId) {
      sheetByTx.set(txId, {
        rowIndex: i + 2,
        acctId: r[TX_COL.acctId] ?? '',
        excluded: (r[TX_COL.exclude] ?? '').toString().toUpperCase() === 'TRUE' ? 1 : 0,
        mkey: r[TX_COL.mkey] ?? '',
      });
    }
  });

  const txs = sql
    .exec<TxForSheet>(
      `SELECT t.id, t.posted, t.amount, t.description, t.normalized_payee, t.account_id
         FROM transactions t
        ORDER BY t.posted ASC`,
    )
    .toArray();
  const allTxIds = new Set(txs.map((t) => t.id));

  const cellUpdates: ValueRange[] = [];   // RAW: account_id (I) + merchant_key (K) — written last
  const formulaWrites: ValueRange[] = []; // USER_ENTERED: Account (B) + Merchant (E) + Category (F)
  const appendValues: (string | number | null)[][] = [];
  const appendTxIds: string[] = [];
  const appendTxAccountIds: string[] = [];

  for (const tx of txs) {
    // Mirror the sheet's formula result into SQLite for the chat tools.
    const clean = cleanByKey.get(tx.normalized_payee) || tx.normalized_payee;
    const category = categoryByClean.get(clean) ?? '';
    const existing = sheetByTx.get(tx.id);

    if (!existing) {
      // B/E/F are formulas filled after append; account_id (I) written last as a
      // commit marker. merchant_key (K) carries the grouping key for the Merchant formula.
      appendValues.push([isoDate(tx.posted), '', tx.amount, tx.description, '', '', '', tx.id, '', '', tx.normalized_payee]);
      appendTxIds.push(tx.id);
      appendTxAccountIds.push(tx.account_id);
      upsertMirror(sql, mirrorRow(tx.id, category, 0));
      continue;
    }
    upsertMirror(sql, mirrorRow(tx.id, category, existing.excluded));
    if (existing.acctId !== tx.account_id) {
      cellUpdates.push({ range: a1(TX_TAB, `I${existing.rowIndex}:I${existing.rowIndex}`), values: [[tx.account_id]] });
    }
    if (existing.mkey !== tx.normalized_payee) {
      cellUpdates.push({ range: a1(TX_TAB, `K${existing.rowIndex}:K${existing.rowIndex}`), values: [[tx.normalized_payee]] });
    }
    // Account/Merchant/Category formulas (idempotent — written for every row).
    formulaWrites.push({ range: a1(TX_TAB, `B${existing.rowIndex}:B${existing.rowIndex}`), values: [[accountNameRef(`$I${existing.rowIndex}`)]] });
    formulaWrites.push({ range: a1(TX_TAB, `E${existing.rowIndex}:F${existing.rowIndex}`), values: [[merchantRef(existing.rowIndex), categoryRef(existing.rowIndex)]] });
  }

  const orphanRows: number[] = [];
  const orphanTxIds: string[] = [];
  for (const [txId, row] of sheetByTx) {
    if (!allTxIds.has(txId)) { orphanRows.push(row.rowIndex); orphanTxIds.push(txId); }
  }

  if (orphanRows.length > 0) {
    try {
      await client.deleteRows(sheetId, tabId, orphanRows);
      result.deleted += orphanRows.length;
      for (const txId of orphanTxIds) sql.exec('DELETE FROM sheet_rows WHERE tx_id = ?', txId);
    } catch (err) {
      result.errors.push(`tx-deletes: ${(err as Error).message}`);
    }
  }

  if (appendValues.length > 0) {
    try {
      const { firstRow } = await client.appendRows(sheetId, TX_RANGE, appendValues);
      result.appended += appendValues.length;
      if (firstRow != null) {
        appendTxIds.forEach((txId, i) => {
          const row = firstRow + i;
          recordRowIndex(sql, txId, row);
          formulaWrites.push({ range: a1(TX_TAB, `B${row}:B${row}`), values: [[accountNameRef(`$I${row}`)]] });
          formulaWrites.push({ range: a1(TX_TAB, `E${row}:F${row}`), values: [[merchantRef(row), categoryRef(row)]] });
          // account_id written via cellUpdates (RAW) below, after the formulas.
          cellUpdates.push({ range: a1(TX_TAB, `I${row}:I${row}`), values: [[appendTxAccountIds[i]!]] });
        });
      }
    } catch (err) {
      result.errors.push(`tx-appends: ${(err as Error).message}`);
    }
  }

  // Formulas first (Account/Merchant/Category live links), THEN account_id (RAW)
  // as the commit marker so a partial failure re-runs next reconcile.
  if (formulaWrites.length > 0) {
    try {
      await client.batchUpdateValues(sheetId, formulaWrites, 'USER_ENTERED');
      if (cellUpdates.length > 0) await client.batchUpdateValues(sheetId, cellUpdates); // RAW account_id
    } catch (err) {
      result.errors.push(`tx-formulas: ${(err as Error).message}`);
    }
  }

  // Formats + checkbox on the data rows. Merchant/Category are formulas now
  // (edited via the Mappings tab), so no Category dropdown on this tab.
  await applyFormatting(result, 'tx-format', () =>
    client.setColumnFormats(sheetId, tabId, [{ col: TX_COL.date, kind: 'date' }, { col: TX_COL.amount, kind: 'currency' }]),
  );
  await applyFormatting(result, 'tx-exclude-checkbox', () =>
    client.setCheckbox(sheetId, tabId, TX_COL.exclude),
  );
}

/** Read a 2-column key→value range into a Map (trimmed keys; first wins). */
async function readMap(client: SheetsClient, sheetId: string, range: string): Promise<Map<string, string>> {
  const rows = await client.getValues(sheetId, range);
  const map = new Map<string, string>();
  for (const r of rows) {
    const key = (r[0] ?? '').trim();
    if (key && !map.has(key)) map.set(key, (r[1] ?? '').trim());
  }
  return map;
}

/** Mirror row for SQLite (only category + excluded matter now; merge columns
 *  are vestigial but kept non-null for the schema). */
function mirrorRow(txId: string, category: string, excluded: number): MirrorWrite {
  return { tx_id: txId, merchant: '', category, bot_merchant: '', bot_category: '', locked_merchant: 0, locked_category: 0, notes: '', excluded };
}

// ─── Accounts tab (classification surface) ───────────────────────────────────

async function reconcileAccountsTab(
  client: SheetsClient,
  sheetId: string,
  _env: Env,
  sql: SqlStorage,
  result: ReconcileResult,
): Promise<void> {
  const { tabId } = await ensureTab(client, sheetId, ACCT_TAB, ACCT_HEADER, [ACCT_COL.id]);
  // Repair the header on tabs created before the Nickname column existed.
  await ensureLayout(client, sheetId, tabId, ACCT_TAB, ACCT_HEADER, [ACCT_COL.id], result);

  const sheetRows = await client.getValues(sheetId, ACCT_RANGE);
  const sheetByAcct = new Map<string, { rowIndex: number; type: string; nickname: string }>();
  sheetRows.forEach((r, i) => {
    const id = r[ACCT_COL.id];
    if (id) sheetByAcct.set(id, { rowIndex: i + 2, type: r[ACCT_COL.type] ?? '', nickname: r[ACCT_COL.nickname] ?? '' });
  });

  const balances = currentBalances(sql);
  const meta = loadAccountMeta(sql);

  const rowUpdates: ValueRange[] = [];
  const botTypeUpdates: { id: string; type: string }[] = [];      // applied iff updates land
  const botNickUpdates: { id: string; nickname: string }[] = [];  // applied iff updates land
  const appendValues: (string | number | null)[][] = [];
  const appendBots: { id: string; type: string; nickname: string }[] = []; // applied iff append lands

  for (const acct of balances) {
    const m: AccountMetaRow | undefined = meta.get(acct.account_id);
    const effectiveType = m?.type ?? acct.type;
    const baseType = m?.bot_type ?? '';
    const effectiveNick = m?.nickname ?? acct.nickname;
    const baseNick = m?.bot_nickname ?? '';
    const existing = sheetByAcct.get(acct.account_id);
    // Row layout A:H = name | org | type | balance | currency | synced | id | nickname.
    const rowFor = (type: string, nick: string) => [
      acct.name, acct.org ?? '', type, acct.balance, acct.currency,
      isoDate(Math.floor(acct.last_synced_at / 1000)), acct.account_id, nick,
    ];

    if (!existing) {
      appendValues.push(rowFor(effectiveType, effectiveNick));
      appendBots.push({ id: acct.account_id, type: effectiveType, nickname: effectiveNick });
      continue;
    }

    // Type: an unrecognized free-typed value (e.g. "credit card") coerces to
    // 'other'. Treat that (and an empty cell) as blank → hand back to the bot
    // rather than overwriting with 'other' (which once destroyed a typed value).
    const typed = (existing.type ?? '').trim();
    const coerced = coerceType(typed);
    const theirsType = typed === '' || (coerced === 'other' && typed.toLowerCase() !== 'other') ? '' : coerced;
    const typeMerge = mergeField(theirsType, baseType, effectiveType);
    if (typeMerge.harvest != null) {
      setAccountType(sql, acct.account_id, coerceType(typeMerge.value));
      result.humanEdits++;
    } else if (typeMerge.botWrote) {
      botTypeUpdates.push({ id: acct.account_id, type: typeMerge.value });
    }

    // Nickname: free text, three-way merged like Type. The bot never proposes a
    // nickname, so `effectiveNick` is whatever the user set (or '').
    const nickMerge = mergeField((existing.nickname ?? '').trim(), baseNick, effectiveNick);
    if (nickMerge.harvest != null) {
      setNickname(sql, acct.account_id, nickMerge.value);
      result.humanEdits++;
    } else if (nickMerge.botWrote) {
      botNickUpdates.push({ id: acct.account_id, nickname: nickMerge.value });
    }

    rowUpdates.push({ range: a1(ACCT_TAB, `A${existing.rowIndex}:H${existing.rowIndex}`), values: [rowFor(typeMerge.value, nickMerge.value)] });
  }

  if (rowUpdates.length > 0) {
    try {
      await client.batchUpdateValues(sheetId, rowUpdates);
      result.updated += rowUpdates.length;
      for (const b of botTypeUpdates) setBotType(sql, b.id, b.type);
      for (const b of botNickUpdates) setBotNickname(sql, b.id, b.nickname);
    } catch (err) {
      result.errors.push(`acct-updates: ${(err as Error).message}`);
    }
  }
  if (appendValues.length > 0) {
    try {
      await client.appendRows(sheetId, ACCT_RANGE, appendValues);
      result.appended += appendValues.length;
      for (const b of appendBots) { setBotType(sql, b.id, b.type); setBotNickname(sql, b.id, b.nickname); }
    } catch (err) {
      result.errors.push(`acct-appends: ${(err as Error).message}`);
    }
  }

  // Formats + the strict Type dropdown, applied to the data rows AFTER writes
  // (see the note in reconcileTransactions — appended rows don't inherit
  // column-level formatting/validation, so it must be set once rows exist).
  if (balances.length > 0) {
    await applyFormatting(result, 'acct-format', () =>
      client.setColumnFormats(sheetId, tabId, [
        { col: ACCT_COL.balance, kind: 'currency' },
        { col: ACCT_COL.synced, kind: 'date' },
      ]),
    );
    await applyFormatting(result, 'acct-type-dropdown', () =>
      client.setListValidation(sheetId, tabId, ACCT_COL.type, [...ACCOUNT_TYPES], true),
    );
  }
}

// ─── History tabs (Balances + Net Worth), one row per account per day ────────

async function reconcileHistory(
  client: SheetsClient,
  sheetId: string,
  env: Env,
  sql: SqlStorage,
  result: ReconcileResult,
): Promise<void> {
  const today = localDate(env.TIMEZONE);

  const bal = await ensureTab(client, sheetId, BAL_TAB, BAL_HEADER, [BAL_COL.id]);
  // Repair the header/hidden account_id on Balances tabs that predate it.
  await ensureLayout(client, sheetId, bal.tabId, BAL_TAB, BAL_HEADER, [BAL_COL.id], result);
  const nwTab = await ensureTab(client, sheetId, NW_TAB, NW_HEADER, []);
  if (await client.countCharts(sheetId, nwTab.tabId) === 0) {
    await client.batchUpdate(sheetId, [netWorthChartRequest(nwTab.tabId)]);
  }

  const balances = currentBalances(sql);
  if (balances.length === 0) return; // nothing to snapshot yet

  // Idempotent per (account, day): we never trust a once-a-day "claim". Instead
  // we read today's rows and UPDATE them (latest balance) or APPEND any account
  // missing — so an account connected later in the day (a brokerage/401k that
  // synced after the morning's first run) still gets captured today, and today's
  // net worth reflects every account. The reconcile mutex prevents concurrent
  // double-appends; matching by (date, name) prevents duplicates across runs.
  try {
    await captureBalancesRows(client, sheetId, today, balances, result);
    await captureNetWorthRow(client, sheetId, today, summarizeNetWorth(balances), result);
  } catch (err) {
    result.errors.push(`history: ${(err as Error).message}`);
  }

  // Formats applied after the rows exist (appended rows don't inherit
  // column-level formats — see reconcileTransactions).
  await applyFormatting(result, 'bal-format', () =>
    client.setColumnFormats(sheetId, bal.tabId, [{ col: 0, kind: 'date' }, { col: 3, kind: 'currency' }]),
  );
  await applyFormatting(result, 'nw-format', () =>
    client.setColumnFormats(sheetId, nwTab.tabId, [
      { col: 0, kind: 'date' }, { col: 1, kind: 'currency' }, { col: 2, kind: 'currency' }, { col: 3, kind: 'currency' },
    ]),
  );
}

/** Upsert today's per-account balance rows: update the Balance cell of an
 *  existing (today, account) row, or append a new row (with a live Type
 *  formula) for any account missing one. */
async function captureBalancesRows(
  client: SheetsClient,
  sheetId: string,
  today: string,
  balances: readonly AccountBalance[],
  result: ReconcileResult,
): Promise<void> {
  const rows = await client.getValues(sheetId, BAL_RANGE);
  // Map every known account_id and SimpleFin name to the account, so we can
  // resolve a row's account_id from a legacy row that only has a name.
  const byId = new Map(balances.map((b) => [b.account_id, b]));
  const nameToId = new Map(balances.map((b) => [b.name.trim(), b.account_id]));

  const idBackfill: ValueRange[] = [];     // RAW: account_id (col E) — kept text for exact XLOOKUP
  const balanceUpdates: ValueRange[] = []; // USER_ENTERED: today's balance (col D)
  const formulaWrites: ValueRange[] = [];  // USER_ENTERED: Account (B) + Type (C) id-keyed formulas
  const seenTodayIds = new Set<string>();

  rows.forEach((r, i) => {
    const rowNum = i + 2;
    const cellId = (r[BAL_COL.id] ?? '').trim();
    const id = cellId || nameToId.get((r[BAL_COL.account] ?? '').trim()) || '';
    // Migrate legacy rows (any day) that lack the account_id key: backfill the id
    // and switch Account/Type to live id-keyed references. This is what fixes the
    // stale "Type" cell and makes renames propagate to history.
    if (!cellId && id) {
      idBackfill.push({ range: a1(BAL_TAB, `E${rowNum}:E${rowNum}`), values: [[id]] });
      formulaWrites.push({
        range: a1(BAL_TAB, `B${rowNum}:C${rowNum}`),
        values: [[accountNameRef(`$E${rowNum}`), accountTypeRef(`$E${rowNum}`)]],
      });
    }
    if (r[BAL_COL.date] === today && id) {
      seenTodayIds.add(id);
      const b = byId.get(id);
      if (b) balanceUpdates.push({ range: a1(BAL_TAB, `D${rowNum}:D${rowNum}`), values: [[b.balance]] });
    }
  });

  // Append a row for any account missing one today (incl. late-synced accounts).
  const appendAccounts = balances.filter((b) => !seenTodayIds.has(b.account_id));

  if (balanceUpdates.length > 0) await client.batchUpdateValues(sheetId, balanceUpdates, 'USER_ENTERED');
  // Formulas first, account_id (commit marker) last: a partial failure leaves
  // the id blank so the next reconcile re-migrates rather than stranding a row.
  if (formulaWrites.length > 0) await client.batchUpdateValues(sheetId, formulaWrites, 'USER_ENTERED');
  if (idBackfill.length > 0) await client.batchUpdateValues(sheetId, idBackfill); // RAW (text id)

  if (appendAccounts.length > 0) {
    // account_id is in the appended row itself (forced text via a leading ') so
    // the row is always matchable by id next run — otherwise a failed formula
    // write would make the row unmatchable and we'd append a duplicate. Date +
    // Balance are USER_ENTERED → native date/number; Account/Type formulas next.
    const { firstRow } = await client.appendRows(
      sheetId,
      BAL_RANGE,
      appendAccounts.map((b) => [today, '', '', b.balance, `'${b.account_id}`]),
      'USER_ENTERED',
    );
    result.appended += appendAccounts.length;
    if (firstRow != null) {
      const formulas: ValueRange[] = appendAccounts.map((_, i) => {
        const row = firstRow + i;
        return { range: a1(BAL_TAB, `B${row}:C${row}`), values: [[accountNameRef(`$E${row}`), accountTypeRef(`$E${row}`)]] };
      });
      await client.batchUpdateValues(sheetId, formulas, 'USER_ENTERED');
    }
  }
}

/** Upsert today's single Net Worth total row (update if present, else append),
 *  so the total reflects every account even as accounts are added through the day. */
async function captureNetWorthRow(
  client: SheetsClient,
  sheetId: string,
  today: string,
  nw: { assets: number; liabilities: number; net: number },
  result: ReconcileResult,
): Promise<void> {
  const dates = await client.getValues(sheetId, a1(NW_TAB, 'A2:A'));
  let rowIndex: number | null = null;
  dates.forEach((r, i) => {
    if (r[0] === today) rowIndex = i + 2;
  });

  if (rowIndex != null) {
    await client.batchUpdateValues(
      sheetId,
      [{ range: a1(NW_TAB, `B${rowIndex}:D${rowIndex}`), values: [[nw.assets, nw.liabilities, nw.net]] }],
      'USER_ENTERED',
    );
  } else {
    await client.appendRows(sheetId, a1(NW_TAB, 'A2:D'), [[today, nw.assets, nw.liabilities, nw.net]], 'USER_ENTERED');
    result.appended += 1;
  }
}

// ─── Cash Flow tab (daily inflows/outflows via live formulas) ────────────────

// Monthly inflow/outflow via SUMPRODUCT keyed on the YYYY-MM month label in the
// row's own A cell (LEFT(date,7) prefix match). N() coerces the header/blank
// text cells to 0 so the full-column refs don't #VALUE. SUMIFS date-RANGE does
// NOT work here — it returns 0 against the text dates the bot writes (verified).
// Exclude transfers (by Category) and rows the user checked Exclude (col J).
const cfExcluded = `(Transactions!$F:$F<>"${TRANSFER_CATEGORY}")*(Transactions!$${TX_EXCLUDE_COL}:$${TX_EXCLUDE_COL}<>TRUE)`;
const cfInflowFormula = (row: number) =>
  `=SUMPRODUCT((LEFT(Transactions!$A:$A,7)=$A${row})*(N(Transactions!$C:$C)>0)*${cfExcluded}*N(Transactions!$C:$C))`;
const cfOutflowFormula = (row: number) =>
  `=-SUMPRODUCT((LEFT(Transactions!$A:$A,7)=$A${row})*(N(Transactions!$C:$C)<0)*${cfExcluded}*N(Transactions!$C:$C))`;

/** Inclusive list of YYYY-MM labels from `firstYm` to `lastYm`, oldest→newest. */
function monthsRange(firstYm: string, lastYm: string): string[] {
  let [y, m] = firstYm.split('-').map(Number) as [number, number];
  const [ly, lm] = lastYm.split('-').map(Number) as [number, number];
  const months: string[] = [];
  while ((y < ly || (y === ly && m <= lm)) && months.length < 600) {
    months.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m === 13) { m = 1; y++; }
  }
  return months;
}

/**
 * The Cash Flow tab is **live formulas**, not bot-computed values: a column of
 * recent months with SUMPRODUCTs that sum the Transactions tab by month and
 * exclude Category = "Transfer". So categorizing a row updates the numbers
 * instantly, no sync. The bot only maintains the month scaffold + formulas.
 */
async function reconcileCashFlow(
  client: SheetsClient,
  sheetId: string,
  env: Env,
  sql: SqlStorage,
  result: ReconcileResult,
): Promise<void> {
  const { tabId } = await ensureTab(client, sheetId, CF_TAB, CF_HEADER, []);
  if ((await client.countCharts(sheetId, tabId)) === 0) {
    await client.batchUpdate(sheetId, [cashFlowChartRequest(tabId)]);
  }

  // Start the scaffold at the first month that has any transaction (so the chart
  // doesn't lead with empty months), capped to the most recent CF_MAX_MONTHS.
  const tz = env.TIMEZONE;
  const currentYm = new Date().toLocaleDateString('en-CA', { timeZone: tz }).slice(0, 7);
  const minPosted = sql.exec<{ min: number | null }>('SELECT MIN(posted) AS min FROM transactions').toArray()[0]?.min ?? null;
  const firstYm = minPosted ? new Date(minPosted * 1000).toLocaleDateString('en-CA', { timeZone: tz }).slice(0, 7) : currentYm;
  const months = monthsRange(firstYm, currentYm).slice(-CF_MAX_MONTHS);
  if (months.length === 0) return;
  const lastRow = months.length + 1;

  try {
    // Header + clear any prior data (handles the daily→monthly transition: the
    // earlier daily version wrote a "Date" header and up to 90 day-rows).
    await client.batchUpdateValues(sheetId, [{ range: a1(CF_TAB, 'A1:D1'), values: [CF_HEADER] }]);
    await client.clearValues(sheetId, a1(CF_TAB, 'A2:D'));
    await client.batchUpdateValues(sheetId, [{ range: a1(CF_TAB, `A2:A${lastRow}`), values: months.map((m) => [m]) }]); // RAW text
    await client.batchUpdateValues(
      sheetId,
      [{
        range: a1(CF_TAB, `B2:D${lastRow}`),
        values: months.map((_, i) => [cfInflowFormula(i + 2), cfOutflowFormula(i + 2), `=B${i + 2}-C${i + 2}`]),
      }],
      'USER_ENTERED',
    );
  } catch (err) {
    result.errors.push(`cash-flow: ${(err as Error).message}`);
  }

  await applyFormatting(result, 'cf-format', () =>
    client.setColumnFormats(sheetId, tabId, [
      { col: 1, kind: 'currency' }, { col: 2, kind: 'currency' }, { col: 3, kind: 'currency' },
    ]),
  );
}

// ─── Spend by Category tab (month × category matrix via live formulas) ───────

/** Spend (outflow magnitude) for one (month, category) cell, excluding the
 *  user-checked Exclude rows. Transfers don't match a spend category, so they're
 *  naturally absent. monthCell/catCell are A1 refs like $A2 / B$1. */
const spendCell = (monthCell: string, catCell: string) =>
  `=-SUMPRODUCT((LEFT(Transactions!$A:$A,7)=${monthCell})*(Transactions!$F:$F=${catCell})*(N(Transactions!$C:$C)<0)*(Transactions!$J:$J<>TRUE)*N(Transactions!$C:$C))`;

/**
 * A live month × spending-category matrix (months down, categories across) plus
 * a per-category Total row, with a stacked-column chart (spend by category over
 * time) and a pie chart (overall category breakdown). Formula-driven, so
 * re-categorizing updates it instantly. Categories are the fixed taxonomy (minus
 * Income) so the layout + charts are stable; custom categories aren't shown here.
 */
async function reconcileSpendByCategory(
  client: SheetsClient,
  sheetId: string,
  env: Env,
  sql: SqlStorage,
  result: ReconcileResult,
): Promise<void> {
  const header = ['Month', ...SPEND_CATEGORIES];
  const lastCol = COL_LETTER(SPEND_CATEGORIES.length); // category cols are B..lastCol
  const { tabId } = await ensureTab(client, sheetId, SC_TAB, header, []);

  const tz = env.TIMEZONE;
  const currentYm = new Date().toLocaleDateString('en-CA', { timeZone: tz }).slice(0, 7);
  const minPosted = sql.exec<{ min: number | null }>('SELECT MIN(posted) AS min FROM transactions').toArray()[0]?.min ?? null;
  const firstYm = minPosted ? new Date(minPosted * 1000).toLocaleDateString('en-CA', { timeZone: tz }).slice(0, 7) : currentYm;
  const months = monthsRange(firstYm, currentYm).slice(-SC_MONTHS);
  if (months.length === 0) return;
  const lastMonthRow = months.length + 1; // months occupy rows 2..lastMonthRow
  const totalRow = lastMonthRow + 1;

  try {
    await client.batchUpdateValues(sheetId, [{ range: a1(SC_TAB, `A1:${lastCol}1`), values: [header] }]);
    await client.clearValues(sheetId, a1(SC_TAB, `A2:${lastCol}1000`));
    await client.batchUpdateValues(sheetId, [{ range: a1(SC_TAB, `A2:A${lastMonthRow}`), values: months.map((m) => [m]) }]); // RAW months
    const matrix = months.map((_, ri) => SPEND_CATEGORIES.map((_, ci) => spendCell(`$A${ri + 2}`, `${COL_LETTER(ci + 1)}$1`)));
    await client.batchUpdateValues(sheetId, [{ range: a1(SC_TAB, `B2:${lastCol}${lastMonthRow}`), values: matrix }], 'USER_ENTERED');
    const totals = SPEND_CATEGORIES.map((_, ci) => { const L = COL_LETTER(ci + 1); return `=SUM(${L}2:${L}${lastMonthRow})`; });
    await client.batchUpdateValues(sheetId, [{ range: a1(SC_TAB, `A${totalRow}:${lastCol}${totalRow}`), values: [['Total', ...totals]] }], 'USER_ENTERED');
  } catch (err) {
    result.errors.push(`spend-by-category: ${(err as Error).message}`);
  }

  if ((await client.countCharts(sheetId, tabId)) === 0) {
    await client.batchUpdate(sheetId, spendByCategoryCharts(tabId, lastMonthRow, SPEND_CATEGORIES.length, totalRow));
  }
  await applyFormatting(result, 'sc-format', () =>
    client.setColumnFormats(sheetId, tabId, SPEND_CATEGORIES.map((_, ci) => ({ col: ci + 1, kind: 'currency' as const }))),
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Ensure a tab exists with a header row; freeze + bold the header and
 *  optionally hide one key column. Reports whether it was just created so
 *  callers can apply one-time formatting only on first creation. Throws if a
 *  just-created tab can't be located (never returns a sentinel id — 0 is a
 *  valid sheetId and would silently target the wrong tab). */
async function ensureTab(
  client: SheetsClient,
  sheetId: string,
  title: string,
  header: string[],
  hideCols: number[],
): Promise<{ tabId: number; created: boolean }> {
  const existing = (await client.listTabs(sheetId)).find((t) => t.title === title);
  if (existing) return { tabId: existing.sheetId, created: false };

  await client.batchUpdate(sheetId, [{ addSheet: { properties: { title } } }]);
  const made = (await client.listTabs(sheetId)).find((t) => t.title === title);
  if (!made) throw new Error(`Failed to create tab "${title}" (addSheet returned no matching sheet).`);

  await client.batchUpdateValues(sheetId, [{ range: a1(title, `A1:${COL_LETTER(header.length - 1)}1`), values: [header] }]);

  await client.batchUpdate(sheetId, [
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
    ...hideCols.map((c) => ({
      updateDimensionProperties: {
        range: { sheetId: made.sheetId, dimension: 'COLUMNS', startIndex: c, endIndex: c + 1 },
        properties: { hiddenByUser: true },
        fields: 'hiddenByUser',
      },
    })),
  ]);
  return { tabId: made.sheetId, created: true };
}

/** Repair an existing tab whose header predates a column addition (e.g. the new
 *  Nickname / account_id columns). When the header row doesn't match, rewrite it
 *  and (re)hide the key columns. No-op once the header matches, so it costs one
 *  read per reconcile and only writes during the one-time migration. */
async function ensureLayout(
  client: SheetsClient,
  sheetId: string,
  tabId: number,
  title: string,
  header: string[],
  hideCols: number[],
  result: ReconcileResult,
): Promise<void> {
  try {
    const lastCol = COL_LETTER(header.length - 1);
    const row1 = (await client.getValues(sheetId, a1(title, `A1:${lastCol}1`)))[0] ?? [];
    if (header.every((h, i) => (row1[i] ?? '') === h)) return;
    await client.batchUpdateValues(sheetId, [{ range: a1(title, `A1:${lastCol}1`), values: [header] }]);
    if (hideCols.length > 0) {
      await client.batchUpdate(
        sheetId,
        hideCols.map((c) => ({
          updateDimensionProperties: {
            range: { sheetId: tabId, dimension: 'COLUMNS', startIndex: c, endIndex: c + 1 },
            properties: { hiddenByUser: true },
            fields: 'hiddenByUser',
          },
        })),
      );
    }
  } catch (err) {
    result.errors.push(`${title}-layout: ${(err as Error).message}`);
  }
}

function upsertMirror(sql: SqlStorage, row: MirrorWrite): void {
  sql.exec(
    `INSERT INTO sheet_rows
       (tx_id, merchant, category, bot_merchant, bot_category, locked_merchant, locked_category, notes, is_excluded, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(tx_id) DO UPDATE SET
       merchant=excluded.merchant, category=excluded.category,
       bot_merchant=excluded.bot_merchant, bot_category=excluded.bot_category,
       locked_merchant=excluded.locked_merchant, locked_category=excluded.locked_category,
       notes=excluded.notes, is_excluded=excluded.is_excluded, synced_at=excluded.synced_at`,
    row.tx_id, row.merchant, row.category, row.bot_merchant, row.bot_category,
    row.locked_merchant, row.locked_category, row.notes, row.excluded, Date.now(),
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

/** Two charts for the Spend by Category tab: a stacked column of spend by
 *  category over months, and a pie of the overall category breakdown. Ranges are
 *  fixed (the matrix is a fixed month×taxonomy grid), so the charts stay correct
 *  as the formulas recompute each reconcile. */
function spendByCategoryCharts(tabId: number, lastMonthRow: number, nCats: number, totalRow: number): unknown[] {
  const anchorCol = nCats + 2; // park charts to the right of the matrix
  const monthDomain = { sourceRange: { sources: [{ sheetId: tabId, startRowIndex: 0, endRowIndex: lastMonthRow, startColumnIndex: 0, endColumnIndex: 1 }] } };
  const series = Array.from({ length: nCats }, (_, ci) => ({
    series: { sourceRange: { sources: [{ sheetId: tabId, startRowIndex: 0, endRowIndex: lastMonthRow, startColumnIndex: ci + 1, endColumnIndex: ci + 2 }] } },
    targetAxis: 'LEFT_AXIS',
  }));
  const stacked = {
    addChart: {
      chart: {
        spec: {
          title: 'Spend by Category over Time',
          basicChart: {
            chartType: 'COLUMN',
            stackedType: 'STACKED',
            legendPosition: 'RIGHT_LEGEND',
            headerCount: 1,
            axis: [{ position: 'BOTTOM_AXIS', title: 'Month' }, { position: 'LEFT_AXIS', title: 'Spend (USD)' }],
            domains: [{ domain: monthDomain }],
            series,
          },
        },
        position: { overlayPosition: { anchorCell: { sheetId: tabId, rowIndex: 1, columnIndex: anchorCol } } },
      },
    },
  };
  const pie = {
    addChart: {
      chart: {
        spec: {
          title: 'Total Spend by Category',
          pieChart: {
            legendPosition: 'RIGHT_LEGEND',
            domain: { sourceRange: { sources: [{ sheetId: tabId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 1, endColumnIndex: nCats + 1 }] } },
            series: { sourceRange: { sources: [{ sheetId: tabId, startRowIndex: totalRow - 1, endRowIndex: totalRow, startColumnIndex: 1, endColumnIndex: nCats + 1 }] } },
          },
        },
        position: { overlayPosition: { anchorCell: { sheetId: tabId, rowIndex: 20, columnIndex: anchorCol } } },
      },
    },
  };
  return [stacked, pie];
}

/** A COLUMN chart of daily Inflows vs Outflows for the Cash Flow tab. */
function cashFlowChartRequest(tabId: number): unknown {
  const colRange = (col: number) => ({
    sourceRange: { sources: [{ sheetId: tabId, startRowIndex: 0, startColumnIndex: col, endColumnIndex: col + 1 }] },
  });
  return {
    addChart: {
      chart: {
        spec: {
          title: 'Monthly Inflows vs Outflows',
          basicChart: {
            chartType: 'COLUMN',
            legendPosition: 'BOTTOM_LEGEND',
            headerCount: 1,
            axis: [
              { position: 'BOTTOM_AXIS', title: 'Date' },
              { position: 'LEFT_AXIS', title: 'USD' },
            ],
            domains: [{ domain: colRange(0) }],
            series: [
              { series: colRange(1), targetAxis: 'LEFT_AXIS' }, // Inflows
              { series: colRange(2), targetAxis: 'LEFT_AXIS' }, // Outflows
            ],
          },
        },
        position: { overlayPosition: { anchorCell: { sheetId: tabId, rowIndex: 1, columnIndex: 5 } } },
      },
    },
  };
}
