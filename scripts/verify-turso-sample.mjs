#!/usr/bin/env node
// ---------------------------------------------------------------------------
// verify-turso-sample.mjs — prove the sample database says what it claims.
//
// Two kinds of check, run in this order and never interchangeably:
//
//   CONTROLS  A statement that MUST fail and an object that MUST NOT exist.
//             If either control passes, the harness itself is broken and every
//             later PASS is meaningless. This is not ceremony: the whole point
//             of a probe is to distinguish "the thing is true" from "my harness
//             silently reports success".
//
//   GATES     Real assertions about the built database, each tied to a specific
//             claim in the plan or in report-findings.md.
//
// Usage:
//   node scripts/verify-turso-sample.mjs            # local sample.db
//   node scripts/verify-turso-sample.mjs --remote   # against Turso
//
// Exit code 0 only if both controls fail AND every gate passes.
// ---------------------------------------------------------------------------
import { createClient } from '@libsql/client';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DB_FILE = path.join(ROOT, 'data', 'sql', 'turso', 'sample.db');
const MANIFEST = path.join(ROOT, 'data', 'sql', 'turso', 'build-manifest.json');

const REMOTE = process.argv.includes('--remote');
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));

// --- .env, read by hand because this script must not depend on the app ------
// Anchored per line and tolerant of a trailing CR: the file is CRLF on Windows
// and a naive split('=') leaves "value\r" which fails to parse as a URL.
if (REMOTE) {
  const envPath = path.join(ROOT, '.env');
  try {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*([^\r\n]*)/.exec(line);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  } catch { /* fall through to the env var check below */ }
}

const url = REMOTE ? process.env.TURSO_DATABASE : pathToFileURL(DB_FILE).href;
const authToken = REMOTE ? process.env.TURSO_API_KEY : undefined;
if (!url) { console.error('--remote needs TURSO_DATABASE (check .env)'); process.exit(2); }

const db = createClient(authToken ? { url, authToken } : { url });

// --- result bookkeeping ----------------------------------------------------
const results = [];
let failed = 0;
const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const num = (v) => (v === null || v === undefined ? 0 : Number(v));
const close = (a, b, eps = 0.005) => Math.abs(num(a) - num(b)) <= eps;
const fmt = (n) => num(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// One row, one column, or null if the query returns nothing.
async function one(sql, ...args) {
  const r = await db.execute({ sql, args });
  if (!r.rows.length) return null;
  const keys = Object.keys(r.rows[0]);
  return keys.length === 1 ? r.rows[0][keys[0]] : r.rows[0];
}

// Every row, as plain objects. Used where the gate has to look at a set of
// names rather than a count.
async function all(sql, ...args) {
  const r = await db.execute({ sql, args });
  return r.rows.map((row) => ({ ...row }));
}

// ---------------------------------------------------------------------------
console.log('\n=== CONTROLS (each MUST fail) ===');
// ---------------------------------------------------------------------------
// A guaranteed syntax error. If this reports success the harness is not
// executing statements at all.
try {
  await db.execute('SELECT FROM WHERE ((');
  record('control: syntax error is rejected', false, 'a malformed statement was accepted');
} catch (e) {
  record('control: syntax error is rejected', true, String(e.message).slice(0, 60));
}
// A guaranteed missing object. Catches a harness that only ever matches on
// nothing (e.g. a connection pointed at an empty database).
try {
  await db.execute('SELECT 1 FROM NO_SUCH_TABLE_XYZ');
  record('control: unknown object is rejected', false, 'a missing table was accepted');
} catch (e) {
  record('control: unknown object is rejected', true, String(e.message).slice(0, 60));
}

if (failed > 0) {
  console.error('\nCONTROLS FAILED — the harness cannot be trusted. Stopping before any gate.');
  console.error('Nothing below this point would have meant anything.\n');
  db.close();
  process.exit(2);
}

// ---------------------------------------------------------------------------
console.log('\n=== GATES ===');
// ---------------------------------------------------------------------------

// G1 — the tables hold the row counts the build reported. A seed that silently
// inserted fewer rows than it generated would otherwise pass every other gate.
{
  const expected = {
    GL_CODE_COMBINATIONS: manifest.coaTotal,
    PO_VENDORS: manifest.vendors,
    PO_AGENTS: manifest.agents,
    PO_HEADERS_ALL: manifest.headers,
    PO_LINES_ALL: manifest.lines,
    PO_DISTRIBUTIONS_ALL: manifest.distributions,
    GL_BALANCES: manifest.balances,
    GL_PERIODS: manifest.periods,
    GL_JE_HEADERS: manifest.jeHeaders,
    SAMPLE_DATA_PROVENANCE: manifest.provenance,
  };
  const bad = [];
  for (const [t, want] of Object.entries(expected)) {
    const got = num(await one(`SELECT COUNT(*) n FROM ${t}`));
    if (got !== want) bad.push(`${t} ${got}≠${want}`);
  }
  record('G1  row counts match build-manifest.json', bad.length === 0, bad.join(', ') || `${Object.keys(expected).length} tables`);
}

// G2 — account identity is clean. 520 accounts, every CCID distinct.
{
  const total = num(await one('SELECT COUNT(*) n FROM GL_CODE_COMBINATIONS'));
  const distinct = num(await one('SELECT COUNT(DISTINCT CODE_COMBINATION_ID) n FROM GL_CODE_COMBINATIONS'));
  const keys = num(await one("SELECT COUNT(DISTINCT SEGMENT1||'.'||SEGMENT2||'.'||SEGMENT3||'.'||SEGMENT4||'.'||SEGMENT5||'.'||SEGMENT6||'.'||SEGMENT7) n FROM GL_CODE_COMBINATIONS"));
  record('G2  COA: 520 accounts, CCID and segment key both 1:1',
    total === 520 && distinct === total && keys === total,
    `${total} rows, ${distinct} distinct CCID, ${keys} distinct segment key`);
}

// G3 — the report grid reproduces exactly. This is the single most important
// gate: it is the reason the database exists.
{
  const want = [
    ['526', 6_738_830.00, 6_738_830.00, 2_329_280.40, 4_409_549.60, 0.00],
    ['527', 89_828_010.00, 87_448_714.00, 2_570_739.39, 576_844.86, 84_301_129.75],
    ['529', 936_025.00, 626_290.00, 149_072.93, 214_749.07, 262_468.00],
    ['532', 287_468.00, 541_624.93, 149_072.93, 25_000.00, 367_552.00],
  ];
  const r = await db.execute(
    "SELECT OBJECT_CODE, WCPSS_BUDGET, ALLOCATIONS_REIMB, ENCUMBRANCES, EXPENDITURES, AVAILABLE_FUNDS FROM V_ACCOUNT_POSITION WHERE LEVEL_CODE = '0450' ORDER BY OBJECT_CODE"
  );
  const bad = [];
  if (r.rows.length !== want.length) bad.push(`view returned ${r.rows.length} rows, expected ${want.length}`);
  for (const [obj, budget, alloc, enc, exp, avail] of want) {
    const row = r.rows.find((x) => String(x.OBJECT_CODE) === obj);
    if (!row) { bad.push(`object ${obj} missing`); continue; }
    if (!close(row.WCPSS_BUDGET, budget)) bad.push(`${obj} budget ${fmt(row.WCPSS_BUDGET)}≠${fmt(budget)}`);
    if (!close(row.ALLOCATIONS_REIMB, alloc)) bad.push(`${obj} alloc ${fmt(row.ALLOCATIONS_REIMB)}≠${fmt(alloc)}`);
    if (!close(row.ENCUMBRANCES, enc)) bad.push(`${obj} enc ${fmt(row.ENCUMBRANCES)}≠${fmt(enc)}`);
    if (!close(row.EXPENDITURES, exp)) bad.push(`${obj} exp ${fmt(row.EXPENDITURES)}≠${fmt(exp)}`);
    if (!close(row.AVAILABLE_FUNDS, avail)) bad.push(`${obj} avail ${fmt(row.AVAILABLE_FUNDS)}≠${fmt(avail)}`);
  }
  record('G3  level-0450 grid reproduces report-findings.md section 3 exactly', bad.length === 0, bad.join('; ') || '4 accounts × 5 figures');
}

// G4 — each of the report's four accounts is labelled transcribed, not derived.
// They are absent from the COA extract, so a build that merely inferred them
// would look identical in the grid but would be misreporting its own provenance.
{
  // The DATA_ORIGIN vocabulary is lowercase and CHECK-constrained by the schema.
  const r = await db.execute(
    "SELECT ROW_KEY, DATA_ORIGIN FROM SAMPLE_DATA_PROVENANCE WHERE TABLE_NAME='GL_CODE_COMBINATIONS' AND DATA_ORIGIN='transcribed'"
  );
  const ccids = manifest.reportAccountCcids.map((x) => String(x.ccid));
  const got = r.rows.map((x) => String(x.ROW_KEY));
  const missing = ccids.filter((c) => !got.includes(c));
  record('G4  the four report accounts are provenance=TRANSCRIBED', missing.length === 0,
    `${got.length} transcribed account(s)${missing.length ? `, missing ${missing.join(', ')}` : ''}`);
}

// G5 — every one of the five non-optional GL_BALANCES filters is load-bearing.
// Each sub-check disables exactly ONE filter and asserts the total moves by
// exactly the trap amount. A filter that is present in the SQL but matches
// nothing would still "work"; this proves each one actually excludes a row.
{
  const BASE = `
    FROM GL_BALANCES gb JOIN GL_CODE_COMBINATIONS cc ON cc.CODE_COMBINATION_ID = gb.CODE_COMBINATION_ID
    WHERE gb.ACTUAL_FLAG='B' AND cc.SEGMENT5='0450'`;
  const sum = async (extra) => num(await one(`SELECT SUM(gb.PERIOD_NET_DR - gb.PERIOD_NET_CR) n ${BASE} ${extra}`));
  const filtered = await sum(`
    AND gb.TRANSLATED_FLAG='N' AND gb.CURRENCY_CODE='USD' AND gb.ENCUMBRANCE_TYPE_ID IS NULL
    AND gb.LEDGER_ID IN (SELECT LEDGER_ID FROM GL_LEDGERS WHERE LEDGER_CATEGORY_CODE='PRIMARY')
    AND cc.SUMMARY_FLAG='N' AND cc.ENABLED_FLAG='Y'`);
  // These five filters do NOT include BUDGET_TYPE, so the surviving rows are the
  // CAPITAL rows plus the APPROP rows: the report's two budget columns at once.
  const EXPECTED_FILTERED = manifest.reportBudgetTotal + manifest.reportAllocTotal;
  const traps = [
    ['LEDGER_ID', "AND gb.TRANSLATED_FLAG='N' AND gb.ENCUMBRANCE_TYPE_ID IS NULL AND cc.SUMMARY_FLAG='N' AND cc.ENABLED_FLAG='Y'", 6_738_830.00],
    ['TRANSLATED_FLAG/CURRENCY_CODE', "AND gb.ENCUMBRANCE_TYPE_ID IS NULL AND gb.LEDGER_ID IN (SELECT LEDGER_ID FROM GL_LEDGERS WHERE LEDGER_CATEGORY_CODE='PRIMARY') AND cc.SUMMARY_FLAG='N' AND cc.ENABLED_FLAG='Y'", 6_200_000.00],
    ['ENCUMBRANCE_TYPE_ID IS NULL', "AND gb.TRANSLATED_FLAG='N' AND gb.CURRENCY_CODE='USD' AND gb.LEDGER_ID IN (SELECT LEDGER_ID FROM GL_LEDGERS WHERE LEDGER_CATEGORY_CODE='PRIMARY') AND cc.SUMMARY_FLAG='N' AND cc.ENABLED_FLAG='Y'", 999_999.99],
    ['SUMMARY_FLAG', "AND gb.TRANSLATED_FLAG='N' AND gb.CURRENCY_CODE='USD' AND gb.ENCUMBRANCE_TYPE_ID IS NULL AND gb.LEDGER_ID IN (SELECT LEDGER_ID FROM GL_LEDGERS WHERE LEDGER_CATEGORY_CODE='PRIMARY') AND cc.ENABLED_FLAG='Y'", 97_790_333.00],
    ['ENABLED_FLAG', "AND gb.TRANSLATED_FLAG='N' AND gb.CURRENCY_CODE='USD' AND gb.ENCUMBRANCE_TYPE_ID IS NULL AND gb.LEDGER_ID IN (SELECT LEDGER_ID FROM GL_LEDGERS WHERE LEDGER_CATEGORY_CODE='PRIMARY') AND cc.SUMMARY_FLAG='N'", 1_000_000.00],
  ];
  const bad = [];
  if (!close(filtered, EXPECTED_FILTERED)) bad.push(`filtered total ${fmt(filtered)} ≠ ${fmt(EXPECTED_FILTERED)} (budget ${fmt(manifest.reportBudgetTotal)} + allocations ${fmt(manifest.reportAllocTotal)})`);
  for (const [label, extra, expected] of traps) {
    const delta = (await sum(extra)) - filtered;
    if (!close(delta, expected)) bad.push(`${label} trap ${fmt(delta)} ≠ ${fmt(expected)}`);
  }
  record('G5  all five GL_BALANCES filters each exclude their trap', bad.length === 0,
    bad.join('; ') || `filtered ${fmt(filtered)}; 5 traps confirmed`);
}

// G6 — no distribution points at a nonexistent account. This is the exact class
// of defect that broke the first build, so it is asserted rather than assumed.
{
  const n = num(await one(`
    SELECT COUNT(*) n FROM PO_DISTRIBUTIONS_ALL pd
    LEFT JOIN GL_CODE_COMBINATIONS cc ON cc.CODE_COMBINATION_ID = pd.CODE_COMBINATION_ID
    WHERE cc.CODE_COMBINATION_ID IS NULL`));
  const total = num(await one('SELECT COUNT(*) n FROM PO_DISTRIBUTIONS_ALL'));
  record('G6  every PO distribution resolves to a real account', n === 0, `${n} orphaned of ${total}`);
}

// G7 — referential integrity across the whole file, not just the paths we
// remembered. PRAGMA foreign_key_check reports every violated constraint.
{
  let violations = 0;
  let err = null;
  try {
    const r = await db.execute('PRAGMA foreign_key_check');
    violations = r.rows.length;
  } catch (e) { err = e.message; }
  record('G7  PRAGMA foreign_key_check is clean', err === null && violations === 0,
    err ? `pragma unavailable: ${err}` : `${violations} violation(s)`);
}

// G8 — funding lines sum to the report's total.
{
  const s = num(await one('SELECT SUM(AMOUNT) n FROM X_REPORT_FUNDING_LINES'));
  const rows = num(await one('SELECT COUNT(*) n FROM X_REPORT_FUNDING_LINES'));
  record('G8  funding lines total 100,539,984', close(s, manifest.fundingTotal) && rows === 7,
    `${rows} rows, ${fmt(s)}`);
}

// G9 — the budget-version ambiguity is present and detectable. Objects 526 and
// 527 both carry two budget rows in one period under different versions; a query
// that orders by period alone cannot choose between them.
{
  const n = num(await one(`
    SELECT COUNT(*) n FROM (
      SELECT CODE_COMBINATION_ID, PERIOD_NAME, COUNT(DISTINCT BUDGET_VERSION_ID) v
        FROM GL_BALANCES WHERE ACTUAL_FLAG='B' AND BUDGET_VERSION_ID IS NOT NULL
       GROUP BY CODE_COMBINATION_ID, PERIOD_NAME HAVING v > 1)`));
  record('G9  competing budget versions overlap in a period', n > 0, `${n} (account, period) pair(s) with 2+ versions`);
}

// G10 — cardinality of the real extract survives into the database.
{
  const v = num(await one('SELECT COUNT(*) n FROM PO_VENDORS'));
  const a = num(await one('SELECT COUNT(*) n FROM PO_AGENTS'));
  const o = num(await one("SELECT COUNT(DISTINCT PO_NUMBER) n FROM PO_HEADERS_ALL WHERE PO_NUMBER NOT LIKE '(%'"));
  const inv = num(await one("SELECT COUNT(*) n FROM PO_HEADERS_ALL WHERE PO_NUMBER LIKE '(INV-EXTRACT%'"));
  record('G10 extract cardinality preserved (157 vendors / 7 buyers / 742 orders)',
    v === 157 && a === 7 && o === 742, `${v} vendors, ${a} agents, ${o} ORDER_NUMBER (plus ${inv} inv-only headers, which carry no ORDER_NUMBER)`);
}

// G11 — the compat objects exist and return something, so a Mode A consumer
// (local node:sqlite, where shims can be registered) has a surface to work with.
{
  const dual = await one('SELECT COUNT(*) n FROM DUAL');
  const cck = num(await one('SELECT COUNT(*) n FROM V_CODE_COMBINATION_KEY'));
  record('G11 DUAL and V_CODE_COMBINATION_KEY are usable', num(dual) === 1 && cck === 520,
    `DUAL ${num(dual)} row, key view ${cck} rows`);
}

// G12 — nothing is stored as a blank or zero-date string. SQLite treats '' as a
// real value, so a blank that should be NULL sorts as a real (earliest) date.
{
  const bad = [];
  const cols = [
    ['GL_CODE_COMBINATIONS', 'LAST_UPDATE_DATE'],
    ['PO_HEADERS_ALL', 'APPROVED_DATE'],
    ['GL_JE_HEADERS', 'DEFAULT_EFFECTIVE_DATE'],
  ];
  let checked = 0;
  for (const [t, c] of cols) {
    const present = num(await one(
      "SELECT COUNT(*) n FROM pragma_table_info(?) WHERE name = ?", t, c));
    if (!present) { bad.push(`${t}.${c} does not exist`); continue; }
    checked++;
    const n = num(await one(`SELECT COUNT(*) n FROM ${t} WHERE ${c} = '' OR ${c} LIKE '0000-00-00%'`));
    if (n > 0) bad.push(`${t}.${c}: ${n}`);
  }
  record('G12 no blank or zero-date strings in date columns', bad.length === 0, bad.join(', ') || `${checked} columns clean`);
}

// G13 — every table that holds rows is described in the provenance table, so
// no reader has to guess where a number came from.
//
// ★ THE APP-OWNED TABLES ARE EXCLUDED, AND THE REASON IS THAT PROVENANCE
//   DESCRIBES A DIFFERENT POPULATION. `SAMPLE_DATA_PROVENANCE` answers one
//   question: where did this row of the *Oracle surrogate* come from — a
//   `<product>.<table>#` on the EBS instance, a derivation over one, or an
//   authored synthesis standing in for one. The app's own tables have no such
//   answer. Their rows come from the application, and every one of them is
//   declared in `data/sql/turso/01-app.sql` with a written reason each. A
//   provenance row for `saved_view` would have to read `authored / 01-app.sql`,
//   which is true and useless: it describes the app, not the sample.
//
// ★ AND THE COUPLING THIS HIDES, STATED PLAINLY. These tables are created lazily
//   by the *server* the first time an app-owned endpoint is touched, in whatever
//   database the server is pointed at — and in `DB_MODE=local` that database IS
//   this file. So on any machine where the dev server has run, `sample.db` holds
//   the app's tables, which the sample build never creates. That is why this gate failed the
//   first time the View Builder was exercised locally, and why the exclusion is
//   written as a named list rather than a `LIKE 'saved_%'`: the list is the
//   claim, and a new app table should have to be added to it deliberately. (That
//   sentence used to name a count — "a twelfth" — which is the same defect this
//   whole note is about, one level down: a stated number in a comment drifts the
//   moment the line it describes changes.)
//
// ★ AND IT DID NOT STAY IN STEP, WHICH IS THE POINT OF WRITING IT AS A LIST.
//   The list read four names for two features — `table_count_snapshot` was added
//   by the row-count register and `organization` + `app_user` by the tenancy
//   register, and neither feature's author was reminded that this constant
//   existed, because a gate that names its members still fails silently in the
//   direction that matters: it is only checked when somebody runs the verifier.
//   The named list is still better than a `LIKE` for the reason given above, but
//   the lesson is that the reminder has to be *in the feature's own plan*, not
//   only in the gate's comment. The honest count is now asserted rather than
//   assumed, below.
//
// ★ AND IT DRIFTED A SECOND TIME, WHICH IS THE ARGUMENT FOR THE GATE RATHER THAN
//   FOR CARE. Four more tables arrived with the vendor-site map — `geo_origin`,
//   `vendor_site_geo`, `vendor_site_route`, `field_override` — and this list
//   still named seven. The count assertion below is what named all four, in one
//   line, the first time the verifier ran against a store that held them. Two
//   features had already drifted this list in silence; the third time nothing was
//   silent. A list that is a hand-copy of a machine-readable set is a *claim*
//   until a gate diffs it against that set, and then it is a check.
const APP_OWNED_TABLES = [
  'saved_view', 'saved_view_run', 'saved_view_subscription', 'project',
  'table_count_snapshot', 'organization', 'app_user',
  // Added by the vendor-site map: the origin the routes run from, the geocoded
  // sites, the cached road routes, and the per-field display overrides. Listed
  // in the order `01-app.sql` declares them.
  'geo_origin', 'vendor_site_geo', 'vendor_site_route', 'field_override',
  // Added by the pins feature: a reader's private shortcuts to ledger records.
  //
  // ★ THE FOURTH DRIFT, AND THE FIRST ONE THAT WAS NOT SILENT — WHICH IS THE
  //   ARGUMENT FOR THE GATE AND NOT FOR BETTER CARE. The pins work touched
  //   `01-app.sql`, `db/app-schema.ts`, `db/store.ts` and
  //   `scripts/move-app-store.mjs`, and every one of those was updated. Nobody
  //   was reminded that *this* copy existed, exactly as the three notes above
  //   describe. It was caught the first time the verifier ran, in one line,
  //   because by then the hand-copy was diffed against the DDL instead of being
  //   trusted. A list is a claim until a gate compares it to its source.
  'user_pin',
];

// ★ THE LIST ABOVE AND THE DDL MUST AGREE, AND THAT IS CHECKED RATHER THAN
//   TRUSTED. `01-app.sql` is the schema of record for app-owned tables; this
//   gate's exclusion list is a hand-copy of it, and a hand-copy is exactly the
//   kind of thing that drifts one feature at a time. So the file is read and the
//   two sets are compared, which turns "somebody forgot" into a failing gate
//   naming the table.
{
  const ddl = readFileSync(path.join(ROOT, 'data', 'sql', 'turso', '01-app.sql'), 'utf8');
  const declared = [...ddl.matchAll(/^\s*CREATE TABLE IF NOT EXISTS\s+([A-Za-z0-9_]+)/gim)]
    .map((m) => m[1])
    .sort();
  const listed = [...APP_OWNED_TABLES].sort();
  const missing = declared.filter((t) => !listed.includes(t));
  const extra = listed.filter((t) => !declared.includes(t));
  const bad = [];
  if (missing.length) bad.push(`01-app.sql declares ${missing.join(', ')} — add them to APP_OWNED_TABLES`);
  if (extra.length) bad.push(`APP_OWNED_TABLES names ${extra.join(', ')} — 01-app.sql does not create them`);
  record(
    'G13a APP_OWNED_TABLES matches the tables 01-app.sql declares',
    bad.length === 0,
    bad.join('; ') || `${declared.length} app-owned tables, listed and declared alike`,
  );
}
const isAppOwned = (name) => APP_OWNED_TABLES.includes(String(name));

{
  const tables = await db.execute(`
    SELECT name FROM sqlite_master WHERE type='table'
      AND name NOT LIKE 'sqlite_%' AND name <> 'SAMPLE_DATA_PROVENANCE' ORDER BY name`);
  const bad = [];
  let checked = 0;
  for (const { name } of tables.rows) {
    if (isAppOwned(name)) continue;
    checked++;
    const n = num(await one('SELECT COUNT(*) n FROM SAMPLE_DATA_PROVENANCE WHERE TABLE_NAME = ?', String(name)));
    if (n === 0) bad.push(name);
  }
  const skipped = tables.rows.length - checked;
  record(
    'G13 every table is covered by SAMPLE_DATA_PROVENANCE',
    bad.length === 0,
    bad.length
      ? `undocumented: ${bad.join(', ')}`
      : `${checked} tables${skipped ? ` (+${skipped} app-owned, excluded)` : ''}`,
  );
}

// G14 — the provenance notes are true. A note that claims "ALL 520 rows" or
// "ZERO rows" is an assertion about the data, so it is checked like one.
{
  const r = await db.execute(`
    SELECT TABLE_NAME, NOTE FROM SAMPLE_DATA_PROVENANCE
     WHERE ROW_KEY = '*' AND (NOTE LIKE 'ALL %' OR NOTE LIKE 'ZERO rows%')`);
  const bad = [];
  let checked = 0;
  for (const { TABLE_NAME, NOTE } of r.rows) {
    const exists = num(await one("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name = ?", String(TABLE_NAME)));
    if (!exists) { bad.push(`${TABLE_NAME} is documented but does not exist`); continue; }
    const actual = num(await one(`SELECT COUNT(*) n FROM "${TABLE_NAME}"`));
    checked++;
    if (String(NOTE).startsWith('ZERO rows')) {
      if (actual !== 0) bad.push(`${TABLE_NAME}: note says ZERO, table has ${actual}`);
    } else {
      const m = /^ALL (\d+) rows/.exec(String(NOTE));
      if (!m) { bad.push(`${TABLE_NAME}: unparseable note`); }
      else if (Number(m[1]) !== actual) bad.push(`${TABLE_NAME}: note says ${m[1]}, table has ${actual}`);
    }
  }
  record('G14 provenance notes match the actual row counts', bad.length === 0,
    bad.join('; ') || `${checked} count claims verified`);
}

// G15 — the two inv extract files do not fully agree, and 03-notes.sql section 6
// says so with specific numbers. That is a finding about the source data, so it is
// pinned here: if a future extract fixes the mismatch, this gate fails and the
// note gets updated, rather than the note quietly becoming false.
{
  const bad = [];
  const nodetail = await db.execute(
    "SELECT PO_LINE_ID FROM PO_LINES_ALL WHERE ITEM_DESCRIPTION = 'ITEM DETAIL NOT IN EXTRACT' ORDER BY PO_LINE_ID");
  const ids = nodetail.rows.map((r) => Number(r.PO_LINE_ID));
  const expected = [11753981, 11753985, 11753986];
  if (ids.join(',') !== expected.join(',')) bad.push(`lines with no detail are ${ids.join(',')}, note says ${expected.join(',')}`);
  const inv = num(await one("SELECT COUNT(*) n FROM PO_HEADERS_ALL WHERE PO_NUMBER LIKE '(INV-EXTRACT%'"));
  if (inv !== 7) bad.push(`${inv} inv-only headers, note says 7`);
  record('G15 inv-extract mismatch matches 03-notes.sql section 6', bad.length === 0,
    bad.join('; ') || `3 detail-less lines ${expected.join(',')}; 7 inv-only headers vs 6 in each file alone`);
}

// G16 — full-output.json is ONE result set carrying TWO grains.
//
// The DBA supplied the file, so the question "is this one query or a union of
// several?" is a real one. It is one: a single column signature over all 2,782
// rows, and a single uninterrupted ORDER BY ORDER_NUMBER (741 ascending
// transitions, 0 descending, over 742 distinct orders). So per-row arithmetic
// over it is safe.
//
// But the rows are not all the same kind of thing. 589 lines carry no
// ITEM_NUMBER and a unit price of exactly 1, with the dollar value sitting in
// QUANTITY — the lump-sum convention for construction contracts such as
// "CMAR-GMP #1 CONSTRUCTION" at $97,681,625 in a single line. The other 2,193
// are ordinary goods lines with a real item code, an integer quantity and 933
// distinct unit prices. Those 589 rows are 21% of the lines and 97% of the
// money, so any average, bar or "top cost codes" view is dominated by them.
//
// Pinned because it is a property of the source that a future extract could
// change, and because the note makes specific numeric claims about it.
{
  const bad = [];
  const rows = await db.execute(`
    SELECT CASE WHEN l.ITEM_ID IS NULL THEN 'lump' ELSE 'goods' END AS grain,
           COUNT(*) n,
           SUM(d.AMOUNT_ORDERED) amt,
           SUM(CASE WHEN l.ITEM_ID IS NULL AND l.QUANTITY > 0 AND l.UNIT_PRICE = 1 THEN 1 ELSE 0 END) as price1
    FROM PO_LINES_ALL l
    JOIN PO_HEADERS_ALL h ON h.PO_HEADER_ID = l.PO_HEADER_ID
    JOIN PO_DISTRIBUTIONS_ALL d ON d.PO_LINE_ID = l.PO_LINE_ID
    WHERE h.PO_NUMBER NOT LIKE '(%'
    GROUP BY 1`);
  const lump = rows.rows.find((r) => r.grain === 'lump') ?? { n: 0, amt: 0, price1: 0 };
  const goods = rows.rows.find((r) => r.grain === 'goods') ?? { n: 0, amt: 0, price1: 0 };

  if (Number(lump.n) !== 589) bad.push(`${lump.n} lump-sum lines, note says 589`);
  if (Number(goods.n) !== 2193) bad.push(`${goods.n} goods lines, note says 2193`);
  if (Number(lump.price1) !== 577) bad.push(`${lump.price1} lump-sum lines at unit price 1, note says 577`);
  if (!close(Number(lump.amt), 418016353.66)) bad.push(`lump-sum value ${fmt(lump.amt)}, note says 418,016,353.66`);
  if (!close(Number(goods.amt), 12552673.26)) bad.push(`goods value ${fmt(goods.amt)}, note says 12,552,673.26`);

  // The concentration itself: if a future extract normalises these rows the
  // share collapses and every note about the spike becomes wrong.
  const share = (100 * Number(lump.amt)) / (Number(lump.amt) + Number(goods.amt));
  if (share < 97) bad.push(`lump-sum grain is only ${share.toFixed(1)}% of the value, note says 97%`);

  record('G16 full-output.json carries two grains (589 lump-sum / 2,193 goods)', bad.length === 0,
    bad.join('; ') || `589 lump-sum = $${fmt(lump.amt)} (${share.toFixed(1)}% of value); 2,193 goods = $${fmt(goods.amt)}`);
}

// G17 — the one place the extract and the report overlap.
//
// The report's grid is level 0450; the extract's money sits overwhelmingly on
// other levels (0454, 0453, 0451, 0526, 1420 ...). Level 0450 is the only
// account level both sources describe, so it is the only honest cross-check:
// 14 distributions totalling $4,356,078.25 against the report's $5,198,165.65
// of encumbrances. Same order of magnitude, not reconcilable — which is the
// claim 03-notes.sql makes, and the reason it does not claim they match.
{
  const bad = [];
  const r = await one(`
    SELECT COUNT(*) n, SUM(d.AMOUNT_ORDERED) amt
    FROM PO_DISTRIBUTIONS_ALL d
    JOIN GL_CODE_COMBINATIONS c ON c.CODE_COMBINATION_ID = d.CODE_COMBINATION_ID
    JOIN PO_HEADERS_ALL h ON h.PO_HEADER_ID = d.PO_HEADER_ID
    WHERE c.SEGMENT5 = '0450' AND h.PO_NUMBER NOT LIKE '(%'`);
  const reportEnc = manifest.reportEncTotal;
  if (Number(r.n) !== 14) bad.push(`${r.n} distributions at level 0450, note says 14`);
  if (!close(Number(r.amt), 4356078.25)) bad.push(`level-0450 extract value ${fmt(r.amt)}, note says 4,356,078.25`);
  const ratio = Number(r.amt) / reportEnc;
  if (!(ratio > 0.5 && ratio < 2)) bad.push(`extract/report ratio ${ratio.toFixed(2)} is not "same order of magnitude"`);
  record('G17 level 0450 is the only overlap with the report, same magnitude', bad.length === 0,
    bad.join('; ') || `extract $${fmt(r.amt)} (14 dists) vs report enc $${fmt(reportEnc)} = ${ratio.toFixed(2)}x`);
}

// G18 — every object the analysis SQL reaches for exists in this build.
//
// data/sql/00..04-*.sql were written against Oracle and name their objects as
// apps.gl_balances, apps.po_distributions_all and so on. The surrogate answers
// to exactly those names: 00-schema.sql defines the base tables under their real
// EBS names, and the contract in data/sql/README.md is that the ported copies
// run unchanged apart from dialect rewrites. This gate is what makes that
// contract checkable rather than aspirational: it scrapes the object names out
// of the SQL and asserts each one resolves.
//
// It covers two folders. data/sql is the Oracle originals — what was handed
// over. data/sql/turso/queries is the ported copy, same filenames, and it is
// held to a stricter standard: the Oracle data-dictionary views (all_tables and
// friends) are allowed to appear in the originals because that is what Oracle
// offers, but they do NOT exist here, so the ported copy has to reach the
// catalogue through sqlite_master instead. Allowing them in one folder and not
// the other is what keeps that requirement enforced.
//
// HISTORY, because it is the reason this gate is strict. This schema used to
// carry 18 WCSEXP_* compatibility views so that the extract's own vocabulary
// resolved without renaming anything. 04-spend-and-actuals.sql referenced
// WCSEXP_AP_INV_DISTRIBUTIONS and WCSEXP_AP_CHECKS, and nothing noticed when the
// first of those had no view behind it until the dialect port was attempted by
// hand and the very first SELECT came back "no such table". The views have since
// been retired — the SQL now reads the base tables directly, which is what the
// real extract grants expose — so every name scraped below must be a BASE TABLE
// (or one of this schema's own reporting views). "It would resolve through a
// compatibility view" is no longer an acceptable answer, which is the point.
{
  const bad = [];
  const ORACLE_ONLY = new Set([
    'ALL_TABLES', 'ALL_VIEWS', 'ALL_TAB_COLUMNS', 'ALL_CONSTRAINTS', 'ALL_CONS_COLUMNS',
    'USER_TABLES', 'USER_VIEWS', 'USER_TAB_COLUMNS', 'USER_TAB_PRIVS',
    'DBA_TABLES', 'DBA_VIEWS',
  ]);
  const sources = [
    { dir: path.join(ROOT, 'data', 'sql'), label: 'oracle' },
    { dir: path.join(ROOT, 'data', 'sql', 'turso', 'queries'), label: 'turso' },
  ];

  const wanted = new Map();   // OBJECT -> "label/file:line" of the first mention
  let filesScanned = 0;
  let namesSeen = 0;

  for (const { dir, label } of sources) {
    let files;
    try {
      files = readdirSync(dir).filter((f) => /^\d\d-.*\.sql$/.test(f));
    } catch { continue; }   // the ported copy may not exist yet

    for (const f of files) {
      // Blank out the comments first. Block comments matter as much as line
      // comments here and are the subtler of the two: these files explain their
      // joins in prose, so a sentence like "One dimension join keyed on
      // whichever side of the outer join exists" reads as two table references
      // to a naive scraper. Replacing each comment's non-newline characters
      // with spaces keeps every line number exactly where it was, so a failure
      // still cites the right line.
      const stripped = readFileSync(path.join(dir, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
        .split(/\r?\n/).map((l) => l.replace(/--.*$/, ''));

      // A name a WITH clause declares is not an object — it resolves inside the
      // statement — so it must be subtracted or every CTE reads as missing.
      const cte = new Set();
      for (const m of stripped.join('\n').matchAll(/(?:\bWITH|,)\s+([A-Za-z0-9_$]+)\s+AS\s*\(/gi)) {
        cte.add(m[1].toUpperCase());
      }

      stripped.forEach((line, i) => {
        // The trailing (?!\s*\() is what keeps a table-valued function out of
        // the scrape. `FROM pragma_table_info('X')` is a call, not an object,
        // and PRAGMA_TABLE_INFO resolves to nothing in sqlite_master, so without
        // it the catalogue query in 00-discover.sql reads as a missing table.
        for (const m of line.matchAll(/\b(?:FROM|JOIN)\s+(?:apps\.)?([A-Za-z0-9_$#]+)\b(?!\s*\()/gi)) {
          const obj = m[1].toUpperCase();
          namesSeen++;
          if (cte.has(obj)) continue;
          if (label === 'oracle' && ORACLE_ONLY.has(obj)) continue;
          if (!wanted.has(obj)) wanted.set(obj, `${label}/${f}:${i + 1}`);
        }
      });
      filesScanned++;
    }
  }

  // A gate that matches nothing would pass forever while checking nothing, so
  // the anchor is the object every one of those files opens with. If the SQL
  // moves or the extractor breaks, this is what says so out loud.
  //
  // GL_BALANCES, not WCSEXP_GL_BALANCES: the compatibility views are retired,
  // so the base name is what the SQL must be naming. (And WCSEXP_GL_BALANCES
  // must now resolve to NOTHING — G19 below asserts the views stayed retired.)
  if (!wanted.has('GL_BALANCES')) {
    bad.push(`scraped ${wanted.size} object(s) from ${filesScanned} file(s) but not GL_BALANCES — the extractor is not reading the SQL`);
  }

  for (const [obj, where] of wanted) {
    const found = num(await one('SELECT COUNT(*) n FROM sqlite_master WHERE UPPER(name) = ?', obj));
    if (!found) bad.push(`${obj} (${where}) resolves to nothing`);
  }

  record('G18 every object the analysis SQL references exists', bad.length === 0,
    bad.join('; ') || `${wanted.size} distinct objects over ${namesSeen} references in ${filesScanned} file(s), all resolve`);
}

// G19 — the WCSEXP_* compatibility views stayed retired.
//
// Section 5 of 00-schema.sql used to define 18 views aliasing the real tables
// back to the extract's vocabulary. They were removed so the SQL reads base
// tables only, and so the three places the vocabulary differed (SET_OF_BOOKS_ID,
// DIST_CODE_COMBINATION_ID, CHECK_DATE) surface in the queries instead of being
// papered over.
//
// This gate exists because a retired view is silent when it comes back. Adding
// one back would not break a single query — it would only mean someone had two
// names for one object again, which is exactly the drift the retirement was
// meant to end. G18 cannot catch that: it asserts every referenced object
// RESOLVES, and a reintroduced view satisfies that more easily, not less.
//
// The counts are deliberately fixed rather than "no WCSEXP rows": 6 views are
// expected here (DUAL, V_CODE_COMBINATION_KEY, V_BUDGET_BY_ACCOUNT_PERIOD,
// V_ACCOUNT_POSITION, V_SEGMENT_LEGEND, V_ENCUMBRANCE_FROM_PO), so a view added
// under some other name is caught too.
//
// ★ THE TABLE COUNT EXCLUDES THE APP-OWNED TABLES, for the same reason G13 does —
//   see the note there. This gate is an assertion about the *shape of the Oracle
//   surrogate*: which objects stand in for the EBS instance. The app's own
//   tables are not part of that shape. They belong to the application, they are
//   created by the server rather than by the sample build, and in `DB_MODE=local`
//   the file they are created in happens to be this one. Counting them here would
//   mean the gate reported "a table was added or removed" every time somebody
//   opened the app.
{
  const bad = [];
  const wcsexp = await all(`
    SELECT name FROM sqlite_master
    WHERE type = 'view' AND UPPER(name) LIKE 'WCSEXP%'
    ORDER BY name`);
  const viewCount = num(await one(`SELECT COUNT(*) n FROM sqlite_master WHERE type = 'view'`));
  const allTables = await all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`);
  const surrogateTables = allTables.filter((r) => !isAppOwned(r.name));
  const tableCount = surrogateTables.length;

  if (wcsexp.length) {
    bad.push(`WCSEXP_* views are back: ${wcsexp.map((r) => r.name).join(', ')}`);
  }
  if (viewCount !== 6) bad.push(`${viewCount} views, expected 6 — a view was added or removed`);
  if (tableCount !== 36) bad.push(`${tableCount} tables, expected 36 — a table was added or removed`);

  record('G19 the WCSEXP_* compatibility views stayed retired', bad.length === 0,
    bad.join('; ') || `0 WCSEXP_* views; ${tableCount} tables + ${viewCount} views`);
}

// ---------------------------------------------------------------------------
const passed = results.length - failed;
console.log(`\n${failed === 0 ? 'ALL GATES PASSED' : 'FAILURES PRESENT'} — ${passed}/${results.length} passed`);
if (failed) {
  console.log('\nFailing gates:');
  for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}: ${r.detail}`);
}
db.close();
process.exit(failed ? 1 : 0);
