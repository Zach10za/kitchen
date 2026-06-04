/**
 * Scratch harness for validating Cash Flow sheet formulas against a real Google
 * Sheet, before baking them into src/finance/sheet.ts.
 *
 * Reads GOOGLE_SERVICE_ACCOUNT_JSON from .dev.vars and writes/reads a throwaway
 * spreadsheet. Run: `bun run scripts/sheets-test.ts <spreadsheetId>`
 *
 * It mirrors the production Transactions layout (Date=A, Amount=C, Category=F)
 * and tests the daily inflow/outflow SUMIFS — crucially whether SUMIFS matches
 * dates when they're stored as TEXT (how the bot writes them) vs NATIVE dates.
 */

import { readFileSync } from 'node:fs';
import { SheetsClient } from '../src/runtime/sheets';

function loadServiceAccountJson(): string {
  const env = readFileSync('.dev.vars', 'utf8');
  for (const line of env.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && line.slice(0, i).trim() === 'GOOGLE_SERVICE_ACCOUNT_JSON') {
      return line.slice(i + 1).trim();
    }
  }
  throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON not found in .dev.vars');
}

const SHEET_ID = process.argv[2] as string;
if (!SHEET_ID) throw new Error('Usage: bun run scripts/sheets-test.ts <spreadsheetId> [only]');
/** Optional 2nd arg restricts which test runs (avoids the 60 writes/min quota):
 *  dates | account-refs | monthly | column-exclude. Default: all. */
const ONLY = process.argv[3] ?? '';
const wants = (name: string) => !ONLY || ONLY === name;

const client = SheetsClient.fromEnv(loadServiceAccountJson());
if (!client) throw new Error('Could not build SheetsClient from .dev.vars');

async function ensureTab(title: string): Promise<void> {
  const tabs = await client!.listTabs(SHEET_ID);
  if (!tabs.some((t) => t.title === title)) {
    await client!.batchUpdate(SHEET_ID, [{ addSheet: { properties: { title } } }]);
  }
}

const q = (tab: string, range: string) => `'${tab}'!${range}`;

// Sample transactions. Expected (transfers excluded via Category):
//   2026-06-01: inflow 100, outflow 40   (the -1000 Transfer is dropped)
//   2026-06-02: inflow 0,   outflow 25   (the +1000 Transfer is dropped)
const TX_ROWS: (string | number)[][] = [
  ['2026-06-01', 'Checking', 100, 'paycheck', 'employer', ''],
  ['2026-06-01', 'Checking', -40, 'dinner', 'restaurant', 'Dining'],
  ['2026-06-01', 'Checking', -1000, 'to savings', 'transfer', 'Transfer'],
  ['2026-06-02', 'Checking', -25, 'coffee', 'cafe', ''],
  ['2026-06-02', 'Savings', 1000, 'from checking', 'transfer', 'Transfer'],
];

const inflowFormula = (dateCell: string) =>
  `=SUMIFS(Transactions!$C:$C, Transactions!$A:$A, ${dateCell}, Transactions!$C:$C, ">0", Transactions!$F:$F, "<>Transfer")`;
const outflowFormula = (dateCell: string) =>
  `=-SUMIFS(Transactions!$C:$C, Transactions!$A:$A, ${dateCell}, Transactions!$C:$C, "<0", Transactions!$F:$F, "<>Transfer")`;

async function run(label: string, dateInput: 'RAW' | 'USER_ENTERED'): Promise<void> {
  await ensureTab('Transactions');
  await ensureTab('CF');
  await client!.clearValues(SHEET_ID, q('Transactions', 'A1:F1000'));
  await client!.clearValues(SHEET_ID, q('CF', 'A1:D1000'));

  // Header + rows. Dates written per `dateInput`; amounts as numbers.
  await client!.batchUpdateValues(
    SHEET_ID,
    [{ range: q('Transactions', 'A1:F1'), values: [['Date', 'Account', 'Amount', 'Desc', 'Merchant', 'Category']] }],
  );
  // Write dates (col A) with the chosen input option, rest RAW.
  await client!.batchUpdateValues(SHEET_ID, [{ range: q('Transactions', `A2:A${TX_ROWS.length + 1}`), values: TX_ROWS.map((r) => [r[0] as string]) }], dateInput);
  await client!.batchUpdateValues(SHEET_ID, [{ range: q('Transactions', `B2:F${TX_ROWS.length + 1}`), values: TX_ROWS.map((r) => r.slice(1) as (string | number)[]) }]);

  // CF: two date rows (same input option) + formulas.
  await client!.batchUpdateValues(SHEET_ID, [{ range: q('CF', 'A2:A3'), values: [['2026-06-01'], ['2026-06-02']] }], dateInput);
  await client!.batchUpdateValues(
    SHEET_ID,
    [{ range: q('CF', 'B2:C3'), values: [[inflowFormula('$A2'), outflowFormula('$A2')], [inflowFormula('$A3'), outflowFormula('$A3')]] }],
    'USER_ENTERED',
  );

  const got = await client!.getValuesRendered(SHEET_ID, q('CF', 'B2:C3'), 'UNFORMATTED_VALUE');
  const n = (v: unknown) => Number(v ?? 0);
  const results = {
    d1_in: n(got[0]?.[0]), d1_out: n(got[0]?.[1]),
    d2_in: n(got[1]?.[0]), d2_out: n(got[1]?.[1]),
  };
  const ok = results.d1_in === 100 && results.d1_out === 40 && results.d2_in === 0 && results.d2_out === 25;
  console.log(`[${label}] dates=${dateInput} →`, results, ok ? '✅ PASS' : '❌ FAIL (expected d1 in100/out40, d2 in0/out25)');
}

if (wants('dates')) {
  await run('text-dates', 'RAW');
  await run('native-dates', 'USER_ENTERED');
}

// ─── Account reference formulas (id-keyed nickname/name + type) ───────────────
// Verbatim from src/finance/sheet.ts — keep in sync.
const accountNameRef = (idCell: string) =>
  `=IFERROR(LET(n,XLOOKUP(${idCell},Accounts!$G:$G,Accounts!$H:$H),IF(n="",XLOOKUP(${idCell},Accounts!$G:$G,Accounts!$A:$A),n)),"")`;
const accountTypeRef = (idCell: string) =>
  `=IFERROR(XLOOKUP(${idCell},Accounts!$G:$G,Accounts!$C:$C),"")`;

async function runAccountRefs(): Promise<void> {
  await ensureTab('Accounts');
  await ensureTab('Ref');
  await client!.clearValues(SHEET_ID, q('Accounts', 'A1:H1000'));
  await client!.clearValues(SHEET_ID, q('Ref', 'A1:C1000'));

  // A name | B inst | C type | D bal | E cur | F synced | G account_id | H nickname
  await client!.batchUpdateValues(SHEET_ID, [
    { range: q('Accounts', 'A1:H3'), values: [
      ['Account', 'Institution', 'Type', 'Balance', 'Currency', 'Last Synced', 'account_id', 'Nickname'],
      ['Chase Checking', 'Chase', 'checking', 0, 'USD', '', 'ACT-123', ''],          // no nickname → name
      ['CRYPTIC NAME LLC', 'Amex', 'credit', 0, 'USD', '', '999888', 'My Amex'],     // numeric-looking id + nickname
    ] },
  ]);
  // Ref tab: account_id cells (RAW text, as the bot writes them) + the formulas.
  await client!.batchUpdateValues(SHEET_ID, [{ range: q('Ref', 'A2:A3'), values: [['ACT-123'], ['999888']] }]);
  await client!.batchUpdateValues(
    SHEET_ID,
    [{ range: q('Ref', 'B2:C3'), values: [
      [accountNameRef('$A2'), accountTypeRef('$A2')],
      [accountNameRef('$A3'), accountTypeRef('$A3')],
    ] }],
    'USER_ENTERED',
  );

  const got = await client!.getValuesRendered(SHEET_ID, q('Ref', 'B2:C3'), 'UNFORMATTED_VALUE');
  const results = {
    r1_name: String(got[0]?.[0] ?? ''), r1_type: String(got[0]?.[1] ?? ''),
    r2_name: String(got[1]?.[0] ?? ''), r2_type: String(got[1]?.[1] ?? ''),
  };
  const ok =
    results.r1_name === 'Chase Checking' && results.r1_type === 'checking' &&
    results.r2_name === 'My Amex' && results.r2_type === 'credit';
  console.log('[account-refs] →', results, ok ? '✅ PASS' : '❌ FAIL (expected name/checking, then My Amex/credit)');
}

if (wants('account-refs')) await runAccountRefs();

// ─── Monthly cash flow: which formula correctly buckets text dates by month? ──
async function runMonthly(): Promise<void> {
  await ensureTab('Transactions');
  await ensureTab('M');
  await client!.clearValues(SHEET_ID, q('Transactions', 'A1:F1000'));
  await client!.clearValues(SHEET_ID, q('M', 'A1:E1000'));

  // Two months; transfers excluded. Expected:
  //   2026-05: in 2000, out 500   (the -3000 Transfer dropped)
  //   2026-06: in 100,  out 40    (the -1000 Transfer dropped)
  const rows: (string | number)[][] = [
    ['2026-05-15', 'Checking', 2000, 'paycheck', 'employer', ''],
    ['2026-05-20', 'Checking', -500, 'dinner', 'rest', 'Dining'],
    ['2026-05-25', 'Checking', -3000, 'to savings', 'xfer', 'Transfer'],
    ['2026-06-03', 'Checking', 100, 'refund', 'store', ''],
    ['2026-06-05', 'Checking', -40, 'coffee', 'cafe', ''],
    ['2026-06-10', 'Checking', -1000, 'to savings', 'xfer', 'Transfer'],
    ['2026-06-15', 'Checking', 5000, 'annual bonus', 'employer', 'Exclude'], // dropped from cash flow
  ];
  await client!.batchUpdateValues(SHEET_ID, [{ range: q('Transactions', 'A1:F1'), values: [['Date', 'Account', 'Amount', 'Desc', 'Merchant', 'Category']] }]);
  await client!.batchUpdateValues(SHEET_ID, [{ range: q('Transactions', `A2:A${rows.length + 1}`), values: rows.map((r) => [r[0] as string]) }]); // RAW text dates
  await client!.batchUpdateValues(SHEET_ID, [{ range: q('Transactions', `B2:F${rows.length + 1}`), values: rows.map((r) => r.slice(1) as (string | number)[]) }]);

  // Approach A — SUMIFS with text date-range (>= month start, <= month end).
  const sumifsIn = (start: string, end: string) =>
    `=SUMIFS(Transactions!$C:$C, Transactions!$A:$A, ">=${start}", Transactions!$A:$A, "<=${end}", Transactions!$C:$C, ">0", Transactions!$F:$F, "<>Transfer")`;
  const sumifsOut = (start: string, end: string) =>
    `=-SUMIFS(Transactions!$C:$C, Transactions!$A:$A, ">=${start}", Transactions!$A:$A, "<=${end}", Transactions!$C:$C, "<0", Transactions!$F:$F, "<>Transfer")`;
  // Approach B — SUMPRODUCT with LEFT(date,7) month-prefix match.
  // Production shape: full-column refs (no row cap) keyed on the month CELL
  // (LEFT(date,7)=$A<row>), with N() coercing the header/blank text cells to 0.
  const spIn = (cell: string) =>
    `=SUMPRODUCT((LEFT(Transactions!$A:$A,7)=${cell})*(N(Transactions!$C:$C)>0)*(Transactions!$F:$F<>"Transfer")*(Transactions!$F:$F<>"Exclude")*N(Transactions!$C:$C))`;
  const spOut = (cell: string) =>
    `=-SUMPRODUCT((LEFT(Transactions!$A:$A,7)=${cell})*(N(Transactions!$C:$C)<0)*(Transactions!$F:$F<>"Transfer")*(Transactions!$F:$F<>"Exclude")*N(Transactions!$C:$C))`;

  // Month labels as RAW text (production shape) — USER_ENTERED would parse
  // "2026-05" into a date and break the LEFT(date,7)=$A2 match.
  await client!.batchUpdateValues(SHEET_ID, [{ range: q('M', 'A2:A3'), values: [['2026-05'], ['2026-06']] }]);
  await client!.batchUpdateValues(
    SHEET_ID,
    [{ range: q('M', 'B2:E3'), values: [
      [sumifsIn('2026-05-01', '2026-05-31'), sumifsOut('2026-05-01', '2026-05-31'), spIn('$A2'), spOut('$A2')],
      [sumifsIn('2026-06-01', '2026-06-30'), sumifsOut('2026-06-01', '2026-06-30'), spIn('$A3'), spOut('$A3')],
    ] }],
    'USER_ENTERED',
  );

  const got = await client!.getValuesRendered(SHEET_ID, q('M', 'B2:E3'), 'UNFORMATTED_VALUE');
  const n = (v: unknown) => Number(v ?? 0);
  const sumifs = { m5_in: n(got[0]?.[0]), m5_out: n(got[0]?.[1]), m6_in: n(got[1]?.[0]), m6_out: n(got[1]?.[1]) };
  const sumproduct = { m5_in: n(got[0]?.[2]), m5_out: n(got[0]?.[3]), m6_in: n(got[1]?.[2]), m6_out: n(got[1]?.[3]) };
  const expect = (o: { m5_in: number; m5_out: number; m6_in: number; m6_out: number }) =>
    o.m5_in === 2000 && o.m5_out === 500 && o.m6_in === 100 && o.m6_out === 40;
  console.log('[monthly SUMIFS range]', sumifs, expect(sumifs) ? '✅ PASS' : '❌ FAIL');
  console.log('[monthly SUMPRODUCT  ]', sumproduct, expect(sumproduct) ? '✅ PASS' : '❌ FAIL');
}

if (wants('monthly')) await runMonthly();

// ─── Cash flow with a separate "Exclude" checkbox column (col J, boolean) ─────
async function runColumnExclude(): Promise<void> {
  await ensureTab('Transactions');
  await ensureTab('MX');
  await client!.clearValues(SHEET_ID, q('Transactions', 'A1:J1000'));
  await client!.clearValues(SHEET_ID, q('MX', 'A1:C1000'));

  // Layout: A date | C amount | F category | J exclude(boolean). Expected for
  // 2026-06: in 100 (the +5000 bonus is checked-excluded, category kept "Income"),
  // out 40 (the -1000 Transfer dropped by category).
  await client!.batchUpdateValues(SHEET_ID, [{ range: q('Transactions', 'A1:J1'), values: [['Date', 'Account', 'Amount', 'Desc', 'Merchant', 'Category', 'Notes', 'tx_id', 'account_id', 'Exclude']] }]);
  await client!.batchUpdateValues(SHEET_ID, [{ range: q('Transactions', 'A2:A5'), values: [['2026-06-03'], ['2026-06-15'], ['2026-06-10'], ['2026-06-05']] }]); // RAW text dates
  await client!.batchUpdateValues(SHEET_ID, [{ range: q('Transactions', 'C2:C5'), values: [[100], [5000], [-1000], [-40]] }]);
  await client!.batchUpdateValues(SHEET_ID, [{ range: q('Transactions', 'F2:F5'), values: [[''], ['Income'], ['Transfer'], ['']] }]);
  await client!.batchUpdateValues(SHEET_ID, [{ range: q('Transactions', 'J2:J5'), values: [['FALSE'], ['TRUE'], ['FALSE'], ['FALSE']] }], 'USER_ENTERED'); // → booleans

  const inflow = `=SUMPRODUCT((LEFT(Transactions!$A:$A,7)=$A2)*(N(Transactions!$C:$C)>0)*(Transactions!$F:$F<>"Transfer")*(Transactions!$J:$J<>TRUE)*N(Transactions!$C:$C))`;
  const outflow = `=-SUMPRODUCT((LEFT(Transactions!$A:$A,7)=$A2)*(N(Transactions!$C:$C)<0)*(Transactions!$F:$F<>"Transfer")*(Transactions!$J:$J<>TRUE)*N(Transactions!$C:$C))`;
  await client!.batchUpdateValues(SHEET_ID, [{ range: q('MX', 'A2:A2'), values: [['2026-06']] }]);
  await client!.batchUpdateValues(SHEET_ID, [{ range: q('MX', 'B2:C2'), values: [[inflow, outflow]] }], 'USER_ENTERED');

  const got = await client!.getValuesRendered(SHEET_ID, q('MX', 'B2:C2'), 'UNFORMATTED_VALUE');
  const n = (v: unknown) => Number(v ?? 0);
  const res = { in: n(got[0]?.[0]), out: n(got[0]?.[1]) };
  console.log('[column-exclude]', res, res.in === 100 && res.out === 40 ? '✅ PASS' : '❌ FAIL (expected in100/out40)');
}

if (wants('column-exclude')) await runColumnExclude();

// ─── Spend-by-category-by-month matrix (month rows × category cols) ───────────
async function runSpendMatrix(): Promise<void> {
  await ensureTab('Transactions');
  await ensureTab('SX');
  await client!.clearValues(SHEET_ID, q('Transactions', 'A1:J1000'));
  await client!.clearValues(SHEET_ID, q('SX', 'A1:Z1000'));

  // A date | C amount | F category | J exclude. Expected (spend = outflow magnitude):
  //   May: Dining 100, Groceries 50 ; Jun: Dining 40 (the -200 Dining is Exclude-checked), Groceries 0
  await client!.batchUpdateValues(SHEET_ID, [{ range: q('Transactions', 'A1:J1'), values: [['Date', 'Account', 'Amount', 'Desc', 'Merchant', 'Category', 'Notes', 'tx_id', 'account_id', 'Exclude']] }]);
  await client!.batchUpdateValues(SHEET_ID, [{ range: q('Transactions', 'A2:A6'), values: [['2026-05-10'], ['2026-05-12'], ['2026-06-05'], ['2026-06-06'], ['2026-06-07']] }]);
  await client!.batchUpdateValues(SHEET_ID, [{ range: q('Transactions', 'C2:C6'), values: [[-100], [-50], [-40], [-1000], [-200]] }]);
  await client!.batchUpdateValues(SHEET_ID, [{ range: q('Transactions', 'F2:F6'), values: [['Dining'], ['Groceries'], ['Dining'], ['Transfer'], ['Dining']] }]);
  await client!.batchUpdateValues(SHEET_ID, [{ range: q('Transactions', 'J2:J6'), values: [['FALSE'], ['FALSE'], ['FALSE'], ['FALSE'], ['TRUE']] }], 'USER_ENTERED');

  // Matrix tab SX: A1 "Month", B1 Dining, C1 Groceries; rows = months.
  const cell = (monthCell: string, catCell: string) =>
    `=-SUMPRODUCT((LEFT(Transactions!$A:$A,7)=${monthCell})*(Transactions!$F:$F=${catCell})*(N(Transactions!$C:$C)<0)*(Transactions!$J:$J<>TRUE)*N(Transactions!$C:$C))`;
  await client!.batchUpdateValues(SHEET_ID, [{ range: q('SX', 'A1:C1'), values: [['Month', 'Dining', 'Groceries']] }]);
  await client!.batchUpdateValues(SHEET_ID, [{ range: q('SX', 'A2:A3'), values: [['2026-05'], ['2026-06']] }]); // RAW text months
  await client!.batchUpdateValues(SHEET_ID, [{ range: q('SX', 'B2:C3'), values: [[cell('$A2', 'B$1'), cell('$A2', 'C$1')], [cell('$A3', 'B$1'), cell('$A3', 'C$1')]] }], 'USER_ENTERED');

  const got = await client!.getValuesRendered(SHEET_ID, q('SX', 'B2:C3'), 'UNFORMATTED_VALUE');
  const n = (v: unknown) => Number(v ?? 0);
  const res = { may_dining: n(got[0]?.[0]), may_groc: n(got[0]?.[1]), jun_dining: n(got[1]?.[0]), jun_groc: n(got[1]?.[1]) };
  const ok = res.may_dining === 100 && res.may_groc === 50 && res.jun_dining === 40 && res.jun_groc === 0;
  console.log('[spend-matrix]', res, ok ? '✅ PASS' : '❌ FAIL (expected may 100/50, jun 40/0)');
}

if (wants('spend-matrix')) await runSpendMatrix();

// ─── Mappings-tab model: Merchant/Category are XLOOKUP formulas; analysis reads
// the formula-driven category column. Validates the whole raw→clean→category→
// analysis chain. ───────────────────────────────────────────────────────────
async function runMappings(): Promise<void> {
  await ensureTab('Transactions');
  await ensureTab('Mappings');
  await ensureTab('MAP');
  await client!.clearValues(SHEET_ID, q('Transactions', 'A1:J1000'));
  await client!.clearValues(SHEET_ID, q('Mappings', 'A1:E1000'));
  await client!.clearValues(SHEET_ID, q('MAP', 'A1:F1000'));

  // Mappings: A=Raw, B=Clean (merchant map) ; D=Merchant, E=Category (cat map).
  await client!.batchUpdateValues(SHEET_ID, [
    { range: q('Mappings', 'A1:B4'), values: [['Raw Merchant', 'Clean Name'], ['SQ *BLUE BOTTLE', 'Blue Bottle'], ['AMZN MKTP', 'Amazon'], ['ONLINE XFER', 'Transfer Out']] },
    { range: q('Mappings', 'D1:E4'), values: [['Merchant', 'Category'], ['Blue Bottle', 'Dining'], ['Amazon', 'Shopping'], ['Transfer Out', 'Transfer']] },
  ]);

  // Transactions: A date, C amount, D raw, E Merchant(formula), F Category(formula), J exclude.
  await client!.batchUpdateValues(SHEET_ID, [{ range: q('Transactions', 'A1:J1'), values: [['Date', 'Account', 'Amount', 'Raw Description', 'Merchant', 'Category', 'Notes', 'tx_id', 'account_id', 'Exclude']] }]);
  await client!.batchUpdateValues(SHEET_ID, [{ range: q('Transactions', 'A2:A4'), values: [['2026-06-01'], ['2026-06-02'], ['2026-06-03']] }]);
  await client!.batchUpdateValues(SHEET_ID, [{ range: q('Transactions', 'C2:C4'), values: [[-10], [-50], [-1000]] }]);
  await client!.batchUpdateValues(SHEET_ID, [{ range: q('Transactions', 'D2:D4'), values: [['SQ *BLUE BOTTLE'], ['AMZN MKTP'], ['ONLINE XFER']] }]);
  const merchF = (r: number) => `=IFERROR(XLOOKUP($D${r},Mappings!$A:$A,Mappings!$B:$B),$D${r})`;
  const catF = (r: number) => `=IFERROR(XLOOKUP($E${r},Mappings!$D:$D,Mappings!$E:$E),"")`;
  await client!.batchUpdateValues(SHEET_ID, [{ range: q('Transactions', 'E2:F4'), values: [[merchF(2), catF(2)], [merchF(3), catF(3)], [merchF(4), catF(4)]] }], 'USER_ENTERED');
  await client!.batchUpdateValues(SHEET_ID, [{ range: q('Transactions', 'J2:J4'), values: [['FALSE'], ['FALSE'], ['FALSE']] }], 'USER_ENTERED');

  // Read back the computed Merchant/Category, then run analysis off column F.
  const me = await client!.getValuesRendered(SHEET_ID, q('Transactions', 'E2:F4'), 'UNFORMATTED_VALUE');
  const cfOut = `=-SUMPRODUCT((LEFT(Transactions!$A:$A,7)="2026-06")*(N(Transactions!$C:$C)<0)*(Transactions!$F:$F<>"Transfer")*(Transactions!$J:$J<>TRUE)*N(Transactions!$C:$C))`;
  const dining = `=-SUMPRODUCT((LEFT(Transactions!$A:$A,7)="2026-06")*(Transactions!$F:$F="Dining")*(N(Transactions!$C:$C)<0)*(Transactions!$J:$J<>TRUE)*N(Transactions!$C:$C))`;
  await client!.batchUpdateValues(SHEET_ID, [{ range: q('MAP', 'A1:B1'), values: [[cfOut, dining]] }], 'USER_ENTERED');
  const got = await client!.getValuesRendered(SHEET_ID, q('MAP', 'A1:B1'), 'UNFORMATTED_VALUE');

  const merchantsOk = me[0]?.[0] === 'Blue Bottle' && me[1]?.[0] === 'Amazon' && me[2]?.[0] === 'Transfer Out';
  const catsOk = me[0]?.[1] === 'Dining' && me[1]?.[1] === 'Shopping' && me[2]?.[1] === 'Transfer';
  const analysisOk = Number(got[0]?.[0] ?? 0) === 60 && Number(got[0]?.[1] ?? 0) === 10; // cash-flow out 60 (transfer excluded), Dining 10
  console.log('[mappings] merchants', merchantsOk ? '✅' : '❌', '| categories', catsOk ? '✅' : '❌', '| analysis-off-formula-column', analysisOk ? '✅' : '❌',
    { merchants: me, cfOut: got[0]?.[0], dining: got[0]?.[1] });
}

if (wants('mappings')) await runMappings();
console.log('\nDone.');
