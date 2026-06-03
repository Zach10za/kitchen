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
import { loadRules, applyRules, upsertRule, type Enrichment } from './rules';
import {
  loadAccountMeta,
  setAccountType,
  setNickname,
  setBotNickname,
  currentBalances,
  summarizeNetWorth,
  coerceType,
  localDate,
  spendingFilter,
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

const TX_RANGE = a1(TX_TAB, 'A2:I');
const TX_HEADER = ['Date', 'Account', 'Amount', 'Raw Description', 'Merchant', 'Category', 'Notes', 'tx_id', 'account_id'];
const TX_COL = { date: 0, account: 1, amount: 2, desc: 3, merchant: 4, category: 5, notes: 6, txId: 7, acctId: 8 } as const;

const ACCT_RANGE = a1(ACCT_TAB, 'A2:H');
const ACCT_HEADER = ['Account', 'Institution', 'Type', 'Balance', 'Currency', 'Last Synced', 'account_id', 'Nickname'];
const ACCT_COL = { name: 0, org: 1, type: 2, balance: 3, currency: 4, synced: 5, id: 6, nickname: 7 } as const;

const BAL_RANGE = a1(BAL_TAB, 'A2:E');
const BAL_HEADER = ['Date', 'Account', 'Type', 'Balance', 'account_id'];
const BAL_COL = { date: 0, account: 1, type: 2, balance: 3, id: 4 } as const;
const NW_HEADER = ['Date', 'Assets', 'Liabilities', 'Net Worth'];

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

interface MirrorRow {
  tx_id: string;
  bot_merchant: string;
  bot_category: string;
  locked_merchant: number;
  locked_category: number;
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

  for (const section of [reconcileTransactions, reconcileAccountsTab, reconcileHistory]) {
    try {
      await section(client, sheetId, env, sql, result);
    } catch (err) {
      result.errors.push(`${section.name}: ${(err as Error).message}`);
    }
  }
  // Clean up leftover empty tabs (e.g. Google's default "Sheet1") once ours exist.
  await pruneEmptyTabs(client, sheetId, result);
  return result;
}

/** The tabs the bot owns. Everything else is the user's. */
const MANAGED_TABS = new Set<string>([TX_TAB, ACCT_TAB, BAL_TAB, NW_TAB]);

/**
 * Delete non-managed tabs that contain no data — primarily the default "Sheet1"
 * Google leaves in the first slot when the spreadsheet is created. Only ever
 * removes EMPTY tabs (nothing to lose) and never the last remaining sheet, so a
 * tab the user fills with content is always preserved. Best-effort: a failure
 * is recorded, never thrown.
 */
async function pruneEmptyTabs(client: SheetsClient, sheetId: string, result: ReconcileResult): Promise<void> {
  try {
    const tabs = await client.listTabs(sheetId);
    const candidates = tabs.filter((t) => !MANAGED_TABS.has(t.title));
    if (candidates.length === 0 || tabs.length - candidates.length < 1) return; // keep ≥1 sheet
    for (const t of candidates) {
      const values = await client.getValues(sheetId, a1(t.title, 'A1:Z1000'));
      const isEmpty = values.every((row) => row.every((cell) => (cell ?? '') === ''));
      if (isEmpty) await client.deleteTab(sheetId, t.sheetId);
    }
  } catch (err) {
    result.errors.push(`prune-tabs: ${(err as Error).message}`);
  }
}

// ─── Transactions tab ──────────────────────────────────────────────────────

async function reconcileTransactions(
  client: SheetsClient,
  sheetId: string,
  _env: Env,
  sql: SqlStorage,
  result: ReconcileResult,
): Promise<void> {
  const { tabId, created } = await ensureTab(client, sheetId, TX_TAB, TX_HEADER, [TX_COL.txId, TX_COL.acctId]);
  if (created) {
    // A basic filter gives instant per-column sort/filter UI — the main lever
    // for diagnosing spend (filter to a category, sort by amount).
    await client.batchUpdate(sheetId, [
      { setBasicFilter: { filter: { range: { sheetId: tabId, startRowIndex: 0, startColumnIndex: 0, endColumnIndex: TX_HEADER.length } } } },
    ]);
  }
  // Repair the header/hidden columns on tabs created before account_id existed.
  await ensureLayout(client, sheetId, tabId, TX_TAB, TX_HEADER, [TX_COL.txId, TX_COL.acctId], result);

  const sheetRows = await client.getValues(sheetId, TX_RANGE);
  const sheetByTx = new Map<string, { rowIndex: number; merchant: string; category: string; notes: string; acctId: string }>();
  sheetRows.forEach((r, i) => {
    const txId = r[TX_COL.txId];
    if (txId) {
      sheetByTx.set(txId, {
        rowIndex: i + 2,
        merchant: r[TX_COL.merchant] ?? '',
        category: r[TX_COL.category] ?? '',
        notes: r[TX_COL.notes] ?? '',
        acctId: r[TX_COL.acctId] ?? '',
      });
    }
  });

  // Spending accounts only. Investment/loan transactions never enter the sheet.
  const txs = sql
    .exec<TxForSheet>(
      `SELECT t.id, t.posted, t.amount, t.description, t.normalized_payee, t.account_id
         FROM transactions t
        WHERE ${spendingFilter('t')}
        ORDER BY t.posted ASC`,
    )
    .toArray();
  const spendingIds = new Set(txs.map((t) => t.id));

  const mirror = new Map<string, MirrorRow>();
  for (const m of sql.exec<MirrorRow>('SELECT * FROM sheet_rows').toArray()) mirror.set(m.tx_id, m);
  const rules = loadRules(sql);

  const cellUpdates: ValueRange[] = [];      // RAW: E:F merges (gates the mirror advance)
  const formulaWrites: ValueRange[] = [];    // USER_ENTERED: Account formula (col B)
  const idWrites: ValueRange[] = [];         // RAW: account_id (col I) — written LAST (commit marker)
  const updateMirror: MirrorWrite[] = [];    // applied only if the cell-update write lands
  const appendValues: (string | number | null)[][] = [];
  const appendTxIds: string[] = [];
  const appendTxAccountIds: string[] = [];
  const appendMirror: MirrorWrite[] = [];    // applied only if the append lands
  const harvestMerchant = new Map<string, string>();
  const harvestCategory = new Map<string, string>();

  for (const tx of txs) {
    const proposed: Enrichment = applyRules(rules, tx);
    const existing = sheetByTx.get(tx.id);

    if (!existing) {
      // Account (col B) and account_id (col I) are filled after append (need the
      // row #). account_id is written LAST as a commit marker, so a failed
      // formula write leaves account_id blank and the next reconcile retries —
      // rather than stranding a row with an id but no name formula.
      appendValues.push([
        isoDate(tx.posted), '', tx.amount, tx.description,
        proposed.merchant, proposed.category, '', tx.id, '',
      ]);
      appendTxIds.push(tx.id);
      appendTxAccountIds.push(tx.account_id);
      appendMirror.push({
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
        range: a1(TX_TAB, `E${existing.rowIndex}:F${existing.rowIndex}`),
        values: [[mMerge.value, cMerge.value]],
      });
    }

    // Backfill the Account formula + account_id key on rows that predate the
    // id-reference layout (empty/mismatched account_id). Formula first, id last
    // (commit marker) so a partial failure self-heals next run.
    if (existing.acctId !== tx.account_id) {
      formulaWrites.push({ range: a1(TX_TAB, `B${existing.rowIndex}:B${existing.rowIndex}`), values: [[accountNameRef(`$I${existing.rowIndex}`)]] });
      idWrites.push({ range: a1(TX_TAB, `I${existing.rowIndex}:I${existing.rowIndex}`), values: [[tx.account_id]] });
    }

    updateMirror.push({
      tx_id: tx.id, merchant: mMerge.value, category: cMerge.value,
      bot_merchant: mMerge.botWrote ? mMerge.value : baseMerchant,
      bot_category: cMerge.botWrote ? cMerge.value : baseCategory,
      locked_merchant: mMerge.locked ? 1 : 0, locked_category: cMerge.locked ? 1 : 0,
      notes: existing.notes,
    });
  }

  // Rows whose account is no longer spending (reclassified) or whose tx is gone.
  const orphanRows: number[] = [];
  const orphanTxIds: string[] = [];
  for (const [txId, row] of sheetByTx) {
    if (!spendingIds.has(txId)) { orphanRows.push(row.rowIndex); orphanTxIds.push(txId); }
  }

  // Harvest edits into rules. Harvesting reflects what's ALREADY in the sheet
  // (a read), so it's safe regardless of whether the writes below succeed.
  for (const [payee, merchant] of harvestMerchant) {
    upsertRule(sql, { match_type: 'merchant', pattern: payee, merchant, source: 'manual' });
    result.rulesHarvested++;
  }
  for (const [payee, category] of harvestCategory) {
    upsertRule(sql, { match_type: 'merchant', pattern: payee, category, source: 'manual' });
    if (!harvestMerchant.has(payee)) result.rulesHarvested++;
  }

  // Writes: sheet first, mirror second. Each write is independent so one failure
  // doesn't strand the others, and the mirror advances only for writes that land.
  let updatesLanded = true;
  if (cellUpdates.length > 0) {
    try {
      await client.batchUpdateValues(sheetId, cellUpdates);
      result.updated += cellUpdates.length;
    } catch (err) {
      result.errors.push(`tx-updates: ${(err as Error).message}`);
      updatesLanded = false;
    }
  }
  if (updatesLanded) for (const m of updateMirror) upsertMirror(sql, m);

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
      for (const m of appendMirror) upsertMirror(sql, m);
      if (firstRow != null) {
        appendTxIds.forEach((txId, i) => {
          const row = firstRow + i;
          recordRowIndex(sql, txId, row);
          // Account (col B) formula references the row's hidden account_id (col I).
          formulaWrites.push({ range: a1(TX_TAB, `B${row}:B${row}`), values: [[accountNameRef(`$I${row}`)]] });
          idWrites.push({ range: a1(TX_TAB, `I${row}:I${row}`), values: [[appendTxAccountIds[i]!]] });
        });
      }
    } catch (err) {
      result.errors.push(`tx-appends: ${(err as Error).message}`);
    }
  }

  // Account-name formulas (col B) first, THEN account_id (col I) as the commit
  // marker — both USER_ENTERED/RAW respectively. Live links to the Accounts tab,
  // so a nickname/rename shows here automatically.
  if (formulaWrites.length > 0) {
    try {
      await client.batchUpdateValues(sheetId, formulaWrites, 'USER_ENTERED');
      if (idWrites.length > 0) await client.batchUpdateValues(sheetId, idWrites); // RAW, after formulas
    } catch (err) {
      result.errors.push(`tx-account-formulas: ${(err as Error).message}`);
    }
  }

  // Apply column formats + the Category dropdown to the data rows AFTER the
  // writes. Appended rows inherit format/validation from the row above (the
  // header, on a fresh tab), so applying these only on creation never reaches
  // the data — re-applying here, once rows exist, is what makes them stick.
  await applyFormatting(result, 'tx-format', () =>
    client.setColumnFormats(sheetId, tabId, [
      { col: TX_COL.date, kind: 'date' },
      { col: TX_COL.amount, kind: 'currency' },
    ]),
  );
  const categories = sql
    .exec<{ category: string }>(
      "SELECT DISTINCT TRIM(category) AS category FROM sheet_rows WHERE TRIM(category) <> '' ORDER BY category",
    )
    .toArray()
    .map((r) => r.category);
  if (categories.length > 0) {
    await applyFormatting(result, 'tx-category-dropdown', () =>
      client.setListValidation(sheetId, tabId, TX_COL.category, categories, false),
    );
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
