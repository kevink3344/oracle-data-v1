#!/usr/bin/env node
/**
 * Build the Turso/libSQL SAMPLE database from data/oracle/*.json.
 *
 *   node scripts/build-turso-sample.mjs              # generate SQL + build the local file DB
 *   node scripts/build-turso-sample.mjs --sql-only   # regenerate 02-seed.sql and stop
 *   node scripts/build-turso-sample.mjs --remote     # push schema + seed to Turso (needs .env)
 *
 * Outputs
 *   data/sql/turso/02-seed.sql   the seed, reviewable and replayable
 *   data/sql/turso/sample.db     the built local surrogate
 *
 * WHY A GENERATOR AND NOT A HANDWRITTEN SEED
 *   The extract is the source of truth for shape, and it changes. Hand-copying
 *   2,782 PO lines into SQL would be unreproducible and would silently drift the
 *   first time the export is re-run.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *   It does not make the extract and the report agree. They are different grains
 *   (project-level funding vs per-account budgets) over a partial slice, and
 *   forcing them to reconcile would mean inventing the ~1.09M of PO lines the
 *   report's encumbrances imply. Every gap is labelled instead, and every row
 *   carries a DATA_ORIGIN in SAMPLE_DATA_PROVENANCE.
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT_DIR = join(ROOT, 'data', 'sql', 'turso');
const ORACLE_DIR = join(ROOT, 'data', 'oracle');
const SCHEMA = join(OUT_DIR, '00-schema.sql');
const SEED_SQL = join(OUT_DIR, '02-seed.sql');
const DB_FILE = join(OUT_DIR, 'sample.db');

const ARGS = new Set(process.argv.slice(2));
const SQL_ONLY = ARGS.has('--sql-only');
const REMOTE = ARGS.has('--remote');

// The host of a libsql/https URL, for naming a target in output. Falls back to
// the raw string so a malformed URL prints something rather than throwing.
const hostOf = (u) => { try { return new URL(String(u)).host; } catch { return String(u); } };

// --- .env, read by hand because this script must not depend on the app ------
// Anchored per line and tolerant of a trailing CR: the file is CRLF on Windows,
// so a naive split('=') leaves "value\r" and the URL then fails to parse.
// An already-set environment variable wins, so CI can override the file.
//
// This exists because the header above and 03-notes.sql both document
// `node scripts/build-turso-sample.mjs --remote` as the way to build on Turso,
// and that command cannot work if the script only ever reads process.env. The
// verifier already loads .env itself; the two scripts must behave alike.
if (REMOTE) {
  try {
    for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*([^\r\n]*)/.exec(line);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  } catch { /* fall through to the env var check below */ }
}

// ---------------------------------------------------------------------------
// provenance vocabulary — the four origins, used consistently throughout
// ---------------------------------------------------------------------------
const EXTRACT = 'extract';        // copied verbatim from data/oracle/*.json
const DERIVED = 'derived';        // computed from extract values, not invented
const TRANSCRIBED = 'transcribed'; // read off the report image
const SYNTHETIC = 'synthetic';    // authored so a query is reproducible

// ---------------------------------------------------------------------------
// SQL literal helpers
// ---------------------------------------------------------------------------
const esc = (s) => String(s).replace(/'/g, "''");
const lit = (v) => {
  if (v === null || v === undefined) return 'NULL';
  return `'${esc(v)}'`;
};
const num = (v) => {
  if (v === null || v === undefined || v === '') return 'NULL';
  const x = Number(v);
  return Number.isFinite(x) ? String(x) : 'NULL';
};
// Money is stored as REAL dollars. Measured, not assumed — see 03-notes.sql.
const money = (v) => {
  if (v === null || v === undefined || v === '') return 'NULL';
  const x = Number(v);
  return Number.isFinite(x) ? String(Math.round(x * 100) / 100) : 'NULL';
};
// Oracle -> SQLite: a blank string is NOT NULL here, so normalise on load.
const nz = (v) => (v === null || v === undefined || v === '') ? null : v;
// '2026-07-27T10:17:14' -> '2026-07-27 10:17:14'; '' and junk -> null
const dt = (v) => {
  const s = nz(v);
  if (!s) return null;
  const m = String(s).match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}:\d{2}))?/);
  if (!m) return null;
  return m[2] ? `${m[1]} ${m[2]}` : `${m[1]} 00:00:00`;
};

const stmts = [];
const push = (s) => stmts.push(s);

/** Chunked multi-row INSERT. Keeps statement count sane on 2,782-row tables. */
function ins(table, cols, rows, per = 100) {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    push(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES\n` +
      chunk.map((r) => `  (${r.join(', ')})`).join(',\n') + ';'
    );
  }
}

// ---------------------------------------------------------------------------
// Fiscal calendar. WCPSS fiscal years start 1 July, which is why FY23 begins in
// July 2022 (the FY23 appropriation's BOE date of 7/13/2022 confirms it).
// ---------------------------------------------------------------------------
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
function fiscal(dateStr) {
  const y = Number(dateStr.slice(0, 4));
  const m = Number(dateStr.slice(5, 7));
  const fy = m >= 7 ? y + 1 : y;
  const pn = ((m + 5) % 12) + 1;
  return { fy, pn, name: `${MON[m - 1]}-${String(y).slice(2)}` };
}
const periodOf = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return { ...fiscal(`${ym}-01`), start: `${ym}-01` };
};

// ---------------------------------------------------------------------------
// Load the extract
// ---------------------------------------------------------------------------
const load = (f) => JSON.parse(readFileSync(join(ORACLE_DIR, f), 'utf8'));

const coaRaw = [
  ...load('json-output.json').Table1,
  ...load('json-output-v2.json').Table1,
  ...load('cost-center.json').ResultSets.Table1,
];
const poRows = load('full-output.json').body.ResultSets.Table1;
const invLines = load('inv-lines.json').ResultSets.Table1;
const invDists = load('inv-distributions.json').ResultSets.Table1;

// ---------------------------------------------------------------------------
// CCID allocation.
//
// CODE_COMBINATION_ID is a surrogate key and the extract only carries the slice
// it was asked for. Accounts referenced by PO data but absent from the COA
// extract are REAL Oracle accounts — they exist, they just were not exported.
// Three separate blocks keep each kind distinguishable at a glance, all clear of
// the real max (9,712,886) so nothing can silently collide.
// ---------------------------------------------------------------------------
const ALLOC = { transcribed: 9_900_001, derived: 9_910_001, synthetic: 9_920_001 };

const coaById = new Map();
const coaByKey = new Map();
const segKey = (r) => [r.SEGMENT1, r.SEGMENT2, r.SEGMENT3, r.SEGMENT4, r.SEGMENT5, r.SEGMENT6, r.SEGMENT7].join('.');
for (const r of coaRaw) {
  const id = Number(r.CODE_COMBINATION_ID);
  if (!coaById.has(id)) coaById.set(id, { ...r, __origin: EXTRACT, __src: 'json-output.json + json-output-v2.json + cost-center.json' });
  if (!coaByKey.has(segKey(r))) coaByKey.set(segKey(r), id);
}

const coaNew = []; // accounts we have to create, with their allocated id
function ensureAccount(segs, origin, note, src) {
  const key = segs.join('.');
  if (coaByKey.has(key)) return coaByKey.get(key);
  const id = ALLOC[origin]++;
  coaByKey.set(key, id);
  coaNew.push({
    CODE_COMBINATION_ID: id,
    CHART_OF_ACCOUNTS_ID: 101,
    ACCOUNT_TYPE: 'E',
    ENABLED_FLAG: 'Y',
    SUMMARY_FLAG: 'N',
    SEGMENT1: segs[0], SEGMENT2: segs[1], SEGMENT3: segs[2], SEGMENT4: segs[3],
    SEGMENT5: segs[4], SEGMENT6: segs[5], SEGMENT7: segs[6],
    DESCRIPTION: note,
    LAST_UPDATE_DATE: null,
    __origin: origin,
    __src: src,
  });
  return id;
}

// ---------------------------------------------------------------------------
// The report, transcribed. report-findings.md sections 2 and 3.
//
// These accounts are created BEFORE any PO-derived account, because they are
// known positively from the report whereas the PO-derived ones are inferred from
// an incomplete slice. Some of the extract's PO segment tuples land on these very
// accounts, so claiming them here means those distributions resolve to the
// transcribed account instead of spawning a duplicate derived one.
// ---------------------------------------------------------------------------
const LEVEL = '0450';
const REPORT_ACCOUNTS = [
  { object: '526', segments: ['04', '6570', '862', '526', LEVEL, '0840', '000'], budget: 6_738_830.00, alloc: 6_738_830.00, enc: 2_329_280.40, exp: 4_409_549.60 },
  { object: '527', segments: ['04', '6570', '862', '527', LEVEL, '0840', '000'], budget: 89_828_010.00, alloc: 87_448_714.00, enc: 2_570_739.39, exp: 576_844.86 },
  { object: '529', segments: ['04', '6570', '862', '529', LEVEL, '0840', '000'], budget: 936_025.00, alloc: 626_290.00, enc: 149_072.93, exp: 214_749.07 },
  { object: '532', segments: ['04', '6570', '862', '532', LEVEL, '0840', '000'], budget: 287_468.00, alloc: 541_624.93, enc: 149_072.93, exp: 25_000.00 },
];
for (const a of REPORT_ACCOUNTS) {
  a.ccid = ensureAccount(
    a.segments, TRANSCRIBED,
    'Account shown in the performance-report grid. ABSENT from the COA extract (json-output*.json, cost-center.json); segments are transcribed from the report, the CCID is allocated by this build.',
    'report-findings.md section 3'
  );
}
const REPORT_BUDGET_TOTAL = REPORT_ACCOUNTS.reduce((s, a) => s + a.budget, 0);

const FUNDING = [
  [1, 'FY23 Appropriation', 1_000_000.00, 'BOE 7/13/2022', '2022-07-13', 0],
  [2, 'FY24 Appropriation', 5_000_000.00, 'BOE 7/27/2023', '2023-07-27', 0],
  [3, 'Reallocation - FY24 Program Contingency', 1_251_965.00, 'BOE 1/7/2025', '2025-01-07', 0],
  [4, 'Reallocation - Project Savings', 6_790_125.00, 'BOE 10/7/2025', '2025-10-07', 0],
  [5, 'Future FY27', 74_798_947.00, 'Est. 8/20/2026', '2026-08-20', 1],
  [6, 'Reallocation - NCDOT FY25-26 Program Contingency', 9_500_000.00, 'Est. 8/20/2027', '2027-08-20', 1],
  [7, 'Future FY28', 2_198_947.00, 'Est. 9/1/2027', '2027-09-01', 1],
];

const PROJECT_FACTS = [
  ['GSF', '143000', 'sq ft', 'Gross square footage. No standard EBS home.'],
  ['COST_PER_SF', '620.54', 'USD/sq ft', 'Derived in the report: total construction budget / GSF.'],
  ['CCAP', '81732376.00', 'USD', 'Construction cost at plan.'],
  ['GMP_BUILDING', '77052929.00', 'USD', 'Guaranteed maximum price, building package.'],
  ['GMP_SITE', '11684967.00', 'USD', 'Guaranteed maximum price, site package.'],
  ['GMP_TOTAL', '88737896.00', 'USD', 'Derived in the report: GMP_BUILDING + GMP_SITE.'],
  ['OFF_SITE', '750000.00', 'USD', 'Off-site improvements allowance.'],
];

// Filter-trap accounts. Must exist before the COA insert is emitted, or the
// balances that reference them violate the foreign key.
const parentId = 3_000_001, disabledId = 3_000_002;
coaNew.push(
  {
    CODE_COMBINATION_ID: parentId, CHART_OF_ACCOUNTS_ID: 101, ACCOUNT_TYPE: 'E', ENABLED_FLAG: 'Y', SUMMARY_FLAG: 'Y',
    SEGMENT1: '04', SEGMENT2: '6570', SEGMENT3: '862', SEGMENT4: '000', SEGMENT5: LEVEL, SEGMENT6: '0840', SEGMENT7: '000',
    DESCRIPTION: 'FILTER TRAP (SUMMARY_FLAG=Y): a parent account holding the level-0450 rollup. Counting it as well as its children doubles the level budget.',
    LAST_UPDATE_DATE: null, __origin: SYNTHETIC, __src: 'authored',
  },
  {
    CODE_COMBINATION_ID: disabledId, CHART_OF_ACCOUNTS_ID: 101, ACCOUNT_TYPE: 'E', ENABLED_FLAG: 'N', SUMMARY_FLAG: 'N',
    SEGMENT1: '04', SEGMENT2: '6570', SEGMENT3: '862', SEGMENT4: '599', SEGMENT5: LEVEL, SEGMENT6: '0840', SEGMENT7: '000',
    DESCRIPTION: 'FILTER TRAP (ENABLED_FLAG=N): a disabled account that still carries a budget balance, as disabled accounts do in a live ledger.',
    LAST_UPDATE_DATE: null, __origin: SYNTHETIC, __src: 'authored',
  },
);

// ---------------------------------------------------------------------------
// PO extract -> headers / lines / shipments / distributions
// ---------------------------------------------------------------------------
const ORG_ID = 82;                      // conventional WCPSS operating unit
const headerIdByNumber = new Map();
const errCol = (...ids) => ids.join(':');

const vendors = new Map();
const agents = new Map();
const poHeaders = [];
const poLines = [];
const poShips = [];
const poDists = [];
const lineIds = [];
let nextHeaderId = 3_000_001, nextLineId = 4_000_001, nextLocId = 5_000_001, nextDistId = 6_000_001;
// The extract is trusted but not assumed: a repeated shipment or distribution id
// would surface as a primary-key violation much later, so count them up front.
const locIdsSeen = new Set(), distIdsSeen = new Set();
let dupLocations = 0, dupDistributions = 0;

// full-output.json is one row per PO line, carrying the seven account segments
// inline. Group so the account split becomes a distribution rather than a
// duplicate line.
const byLine = new Map();
for (const r of poRows) {
  const k = `${r.ORDER_NUMBER}:${r.LINE_NUMBER}`;
  if (!byLine.has(k)) byLine.set(k, []);
  byLine.get(k).push(r);
}

// Stable, SQL-safe surrogate for an agent/vendor name.
let nextVendorId = 10_001, nextAgentId = 2_001;
const vendorId = (name) => {
  const n = nz(name) ?? '(UNKNOWN VENDOR)';
  if (!vendors.has(n)) vendors.set(n, nextVendorId++);
  return vendors.get(n);
};

for (const r of poRows) {
  const on = String(r.ORDER_NUMBER);
  if (!headerIdByNumber.has(on)) {
    const hid = nextHeaderId++;
    headerIdByNumber.set(on, hid);
    poHeaders.push([
      num(hid), lit(on), lit('STANDARD'), num(vendorId(r.VENDOR_NAME)), 'NULL',
      num(r.BUYER_NAME ? (agents.has(nz(r.BUYER_NAME)) ? agents.get(nz(r.BUYER_NAME)) : (agents.set(nz(r.BUYER_NAME), nextAgentId), nextAgentId++)) : null),
      lit('Y'), lit(dt(r.ORDER_DATE)), lit(dt(r.ORDER_DATE)), num(ORG_ID),
      lit(nz(r.CANCEL_FLAG) ?? 'N'),
    ]);
  }
}

// Vendors + vendors sites (one site each — the extract carries no site grain).
const vendorRows = [...vendors.entries()].map(([name, id]) => [
  num(id), lit(name), lit('SUPPLIER'), 'NULL', 'NULL', lit('Y'), 'NULL',
]);
const siteRows = [...vendors.entries()].map(([name, id]) => [
  num(id + 100_000), num(id), lit(String(name).slice(0, 30)), 'NULL', 'NULL', 'NULL', 'NULL', lit('NC'), 'NULL', 'NULL', 'NULL',
]);
const agentRows = [...agents.entries()].map(([name, id]) => [num(id), lit(name), 'NULL', lit('Y')]);

for (const [k, rows] of byLine) {
  const [on, lineNum] = k.split(':');
  const hid = headerIdByNumber.get(on);
  const head = rows[0];
  const sumQty = rows.reduce((a, r) => a + (Number(r.QUANTITY) || 0), 0);
  const sumAmt = rows.reduce((a, r) => a + (Number(r.AMOUNT) || 0), 0);
  const lid = nextLineId++;
  lineIds.push(lid);
  poLines.push([
    num(lid), num(hid), num(1000), num(lineNum), num(head.ITEM_NUMBER), lit(nz(head.DESCRIPTION)),
    lit('EA'), money(sumQty ? sumAmt / sumQty : 0), money(sumQty), lit('OPEN'),
    lit(nz(head.CANCEL_FLAG) ?? 'N'),
  ]);
  const locId = nextLocId++;
  locIdsSeen.add(locId);
  poShips.push([num(locId), num(hid), num(lid), num(1), num(155), money(sumQty), 'NULL', 'NULL', lit('EA'), 'NULL', lit('Y'), lit('OPEN')]);

  // One distribution per distinct account the line was charged to.
  const seen = new Set();
  for (const r of rows) {
    const cid = ensureAccount(
      [r.FUND, r.PURPOSE, r.PROGRAM, r.OBJECT_, r.LEVEL_, r.COST_CENTER, r.FUTURE_USE],
      DERIVED,
      'Referenced by PO lines in full-output.json but absent from the COA extract. Segments are real extract values; the CCID is allocated by this build.',
      'full-output.json'
    );
    if (seen.has(cid)) continue;
    seen.add(cid);
    const amt = money(Number(r.AMOUNT) || 0);
    const did = nextDistId++;
    distIdsSeen.add(did);
    poDists.push([
      num(did), num(hid), num(lid), num(locId), num(cid), num(155), num(seen.size),
      money(Number(r.QUANTITY) || 0), amt, 'NULL',
      lit('Y'), amt,
    ]);
  }
}

// ---------------------------------------------------------------------------
// inv-lines.json / inv-distributions.json.
//
// These carry INTERNAL PO_HEADER_IDs (11349903...) while full-output.json carries
// user-facing ORDER_NUMBERs (218566...). No column joins them, so these become
// their own POs rather than being forced onto the wrong header. Their
// CODE_COMBINATION_IDs are real Oracle ids that the COA extract does not contain,
// so each gets an account with UNRESOLVED segments — visible in V_SEGMENT_LEGEND
// rather than hidden.
// ---------------------------------------------------------------------------
const invHeaderIds = new Set([...invLines, ...invDists].map((r) => Number(r.PO_HEADER_ID)));
for (const hid of invHeaderIds) {
  poHeaders.push([
    num(hid), lit(`(INV-EXTRACT ${hid})`), lit('STANDARD'), 'NULL', 'NULL', 'NULL',
    lit('Y'), 'NULL', 'NULL', num(ORG_ID), lit('N'),
  ]);
  // The two extract files must agree on which lines belong to the header.
  const lines = invLines.filter((r) => Number(r.PO_HEADER_ID) === hid);
  const dists = invDists.filter((r) => Number(r.PO_HEADER_ID) === hid);
  const lineIdsHere = new Set([...lines, ...dists].map((r) => Number(r.PO_LINE_ID)));
  for (const plid of lineIdsHere) {
    const l = lines.find((r) => Number(r.PO_LINE_ID) === plid);
    const d = dists.find((r) => Number(r.PO_LINE_ID) === plid);
    const src = l ?? d;
    const locId = d ? Number(d.LINE_LOCATION_ID) : null;
    poLines.push([
      num(plid), num(hid), num(src.LINE_TYPE_ID ?? 1000), num(src.LINE_NUM ?? 1), num(nz(l?.ITEM_ID)),
      lit(nz(l?.ITEM_DESCRIPTION) ?? 'ITEM DETAIL NOT IN EXTRACT'),
      lit(nz(l?.UNIT_MEAS_LOOKUP_CODE) ?? 'EA'),
      l ? money(l.UNIT_PRICE) : 'NULL', l ? money(l.QUANTITY) : 'NULL',
      lit(nz(l?.CLOSED_CODE)), lit('N'),
    ]);
    if (locId) {
      if (locIdsSeen.has(locId)) {
        // Two extract lines sharing one shipment row. Keep the first; the
        // distribution still points at the real LINE_LOCATION_ID.
        dupLocations++;
      } else {
        locIdsSeen.add(locId);
        poShips.push([num(locId), num(hid), num(plid), num(1), num(nz(d.DELIVER_TO_LOCATION_ID)), money(d.QUANTITY_ORDERED), 'NULL', 'NULL', lit('EA'), 'NULL', 'NULL', lit('OPEN')]);
      }
    }
    if (d) {
      if (distIdsSeen.has(Number(d.PO_DISTRIBUTION_ID))) { dupDistributions++; continue; }
      distIdsSeen.add(Number(d.PO_DISTRIBUTION_ID));
      const cid = Number(d.CODE_COMBINATION_ID);
      if (!coaById.has(cid) && !coaNew.some((a) => a.CODE_COMBINATION_ID === cid)) {
        // SEGMENT7 carries the real CCID. That is not a real cost centre, but it
        // keeps the segment key 1:1 with the account, which matters because the
        // key is the canonical join key everywhere else. Without it all seven
        // unresolved accounts collapse onto one key and a join multiplies by 7.
        const unresolved = ['00', '0000', '000', '000', 'UNRESOLVED', '0000', String(cid)];
        coaNew.push({
          CODE_COMBINATION_ID: cid, CHART_OF_ACCOUNTS_ID: 101, ACCOUNT_TYPE: 'E',
          ENABLED_FLAG: 'Y', SUMMARY_FLAG: 'N',
          SEGMENT1: unresolved[0], SEGMENT2: unresolved[1], SEGMENT3: unresolved[2],
          SEGMENT4: unresolved[3], SEGMENT5: unresolved[4], SEGMENT6: unresolved[5],
          SEGMENT7: unresolved[6],
          DESCRIPTION: 'UNRESOLVED ACCOUNT — referenced by inv-distributions.json but absent from the COA extract, so its segments are unknown. Placeholder segments, real CCID. SEGMENT7 holds the CCID only to keep the segment key unique; it is not a cost centre. Do not report against this row.',
          LAST_UPDATE_DATE: null, __origin: SYNTHETIC, __src: 'inv-distributions.json',
        });
        coaByKey.set(unresolved.join('.'), cid);
      }
      poDists.push([
        num(d.PO_DISTRIBUTION_ID), num(hid), num(plid), num(locId), num(cid),
        num(zeroIfNull(d.DELIVER_TO_LOCATION_ID)), num(d.DISTRIBUTION_NUM ?? 1),
        money(d.QUANTITY_ORDERED), money(d.AMOUNT_ORDERED), money(d.AMOUNT_BILLED),
        lit(nz(d.ENCUMBERED_FLAG)), money(d.ENCUMBERED_AMOUNT),
      ]);
    }
  }
}
function zeroIfNull(v) { return v === null || v === undefined || v === '' ? 0 : v; }

// De-duplicate the header rows: full-output headers never collide with inv headers,
// but assert it rather than assume it.
const headerIdsSeen = new Set();
for (const h of poHeaders) {
  const id = h[0];
  if (headerIdsSeen.has(id)) throw new Error(`duplicate PO_HEADER_ID ${id}`);
  headerIdsSeen.add(id);
}

// ---------------------------------------------------------------------------
// 1. Ledger, currencies, periods, flexfields
// ---------------------------------------------------------------------------
push(`INSERT INTO GL_LEDGERS (LEDGER_ID, NAME, SHORT_NAME, CHART_OF_ACCOUNTS_ID, CURRENCY_CODE, PERIOD_SET_NAME, LEDGER_CATEGORY_CODE, DESCRIPTION) VALUES
  (1001, 'WCPSS Primary Ledger', 'WCPSS', 101, 'USD', 'WCPSS_CALENDAR', 'PRIMARY',
   'CHART_OF_ACCOUNTS_ID=101 is the real value from the COA extract. LEDGER_ID, the name and the ledger category are assigned by this build - the extract never carries them.'),
  (2002, 'WCPSS Reporting Ledger', 'WCPSS-RPT', 101, 'USD', 'WCPSS_CALENDAR', 'SECONDARY',
   'FILTER TRAP (LEDGER_ID): a second ledger that also carries level-0450 balances. A report that omits LEDGER_ID = 1001 silently doubles the total. This ledger is assigned by the build; the extract never carries a LEDGER_ID.');`);

push(`INSERT INTO FND_CURRENCIES (CURRENCY_CODE, NAME, PRECISION, EXTENDED_PRECISION, ENABLED_FLAG) VALUES
  ('USD', 'US Dollar', 2, 2, 'Y'), ('EUR', 'Euro', 2, 2, 'Y');`);

const periodRows = [];
for (let y = 2021, m = 7; y <= 2029; ) {
  const ym = `${y}-${String(m).padStart(2, '0')}`;
  const p = fiscal(`${ym}-01`);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  periodRows.push([lit('WCPSS_CALENDAR'), lit(p.name), lit('Month'), num(p.fy), num(p.pn),
    num(Math.ceil(p.pn / 3)), lit(`${ym}-01`), lit(`${ym}-${String(last).padStart(2, '0')}`)]);
  m++; if (m === 13) { m = 1; y++; }
  if (y === 2029 && m === 7) break;
}
ins('GL_PERIODS', ['PERIOD_SET_NAME', 'PERIOD_NAME', 'PERIOD_TYPE', 'PERIOD_YEAR', 'PERIOD_NUM', 'QUARTER_NUM', 'START_DATE', 'END_DATE'], periodRows);

push(`INSERT INTO FND_ID_FLEX_STRUCTURES (ID_FLEX_NUM, ID_FLEX_STRUCTURE_CODE, ID_FLEX_CODE, DESCRIPTION) VALUES
  (101, 'WCPSS_ACCOUNTING_FLEXFIELD', 'GL#', 'CHART_OF_ACCOUNTS_ID=101, matching the COA extract. Seven segments: Fund, Purpose, Program, Object, Level, Cost Center, Future Use.');`);

const SEGNAMES = [
  [1, 'Fund', 'SEGMENT1'], [2, 'Purpose', 'SEGMENT2'], [3, 'Program', 'SEGMENT3'],
  [4, 'Object', 'SEGMENT4'], [5, 'Level', 'SEGMENT5'], [6, 'Cost Center', 'SEGMENT6'],
  [7, 'Future Use', 'SEGMENT7'],
];
ins('FND_ID_FLEX_SEGMENTS', ['ID_FLEX_NUM', 'ID_FLEX_CODE', 'SEGMENT_NUM', 'SEGMENT_NAME', 'APPLICATION_COLUMN', 'FLEX_VALUE_SET_ID', 'DISPLAY_SIZE', 'REQUIRED_FLAG', 'ENABLED_FLAG'],
  SEGNAMES.map(([n, name, col]) => [num(101), lit('GL#'), num(n), lit(name), lit(col), num(10100 + n), num(n <= 4 ? 4 : 4), lit('Y'), lit('Y')]));

// Only ONE level name is known, because the report names only one project. The
// other 377 accounts stay UNNAMED on purpose: that is the real state of the
// extract, and V_SEGMENT_LEGEND reports it rather than hiding it.
ins('FND_FLEX_VALUES', ['FLEX_VALUE_SET_ID', 'FLEX_VALUE', 'DESCRIPTION', 'ENABLED_FLAG', 'SUMMARY_FLAG', 'START_DATE_ACTIVE', 'END_DATE_ACTIVE'],
  [[num(10105), lit(LEVEL), lit('Athens Drive High School'), lit('Y'), lit('N'), 'NULL', 'NULL']]);
ins('FND_FLEX_VALUES_TL', ['FLEX_VALUE_SET_ID', 'FLEX_VALUE', 'LANGUAGE', 'DESCRIPTION'],
  [[num(10105), lit(LEVEL), lit('US'), lit('Athens Drive High School')]]);

// ---------------------------------------------------------------------------
// 2. GL_CODE_COMBINATIONS — every real account, plus every labelled orphan
// ---------------------------------------------------------------------------
const coaAll = [...coaById.values(), ...coaNew];
ins('GL_CODE_COMBINATIONS',
  ['CODE_COMBINATION_ID', 'CHART_OF_ACCOUNTS_ID', 'ACCOUNT_TYPE', 'ENABLED_FLAG', 'SUMMARY_FLAG', 'SEGMENT1', 'SEGMENT2', 'SEGMENT3', 'SEGMENT4', 'SEGMENT5', 'SEGMENT6', 'SEGMENT7', 'DESCRIPTION', 'LAST_UPDATE_DATE'],
  coaAll.map((r) => [num(r.CODE_COMBINATION_ID), num(r.CHART_OF_ACCOUNTS_ID ?? 101), lit(r.ACCOUNT_TYPE ?? 'E'),
    lit(r.ENABLED_FLAG ?? 'Y'), lit(r.SUMMARY_FLAG ?? 'N'), lit(r.SEGMENT1), lit(r.SEGMENT2), lit(r.SEGMENT3),
    lit(r.SEGMENT4), lit(r.SEGMENT5), lit(r.SEGMENT6), lit(r.SEGMENT7), lit(nz(r.DESCRIPTION)), lit(dt(r.LAST_UPDATE_DATE))]));

// ---------------------------------------------------------------------------
// 3. Budget types, versions, entities, assignments
// ---------------------------------------------------------------------------
push(`INSERT INTO GL_BUDGET_TYPES (BUDGET_TYPE_ID, BUDGET_TYPE_CODE, BUDGET_NAME, DESCRIPTION, ENABLED_FLAG) VALUES
  (1, 'APPROP',  'Appropriation',            'Funding authorised for the project. The report calls this column Allocations/Reimb.', 'Y'),
  (2, 'CAPITAL', 'Capital Project Budget',   'The budgeted amount for the project. The report calls this column WCPSS Budget.', 'Y'),
  (3, 'GRANT',   'Grant Budget',             'Present so a query that assumes one budget per account has something to be wrong about.', 'Y');`);

push(`INSERT INTO GL_BUDGET_VERSIONS (BUDGET_VERSION_ID, LEDGER_ID, BUDGET_TYPE_ID, BUDGET_NAME, FIRST_PERIOD_NAME, LAST_PERIOD_NAME, DEFAULT_PERIOD_NAME, STATUS_CODE, LATEST_FLAG, BUDGET_ENTRY_STATUS, CREATION_DATE) VALUES
  (501, 1001, 1, 'FY23 Original Appropriation',        'JUL-22', 'JUN-23', 'JUL-22', 'FROZEN',  'N', 'OPEN',   '2022-07-01 00:00:00'),
  (502, 1001, 1, 'FY24 Revised Appropriation',         'JUL-23', 'JUN-24', 'JUL-23', 'FROZEN',  'N', 'OPEN',   '2023-07-01 00:00:00'),
  (503, 1001, 2, 'Approved Capital Budget',            'JUL-22', 'JUN-28', 'JUL-26', 'OPEN',    'Y', 'OPEN',   '2022-07-01 00:00:00'),
  (504, 1001, 1, 'FY25-FY28 Appropriations and Reallocations', 'JUL-24', 'JUN-28', 'JUL-26', 'CURRENT', 'Y', 'OPEN', '2024-07-01 00:00:00');`);

// 501 and 503 both cover JUL-22, so an account carries TWO budget rows in that
// period under different versions. That is the real ambiguity: a query that
// orders by period without including BUDGET_VERSION_ID in the tiebreak picks
// arbitrarily. Deliberate, and gate 9 asserts it is detectable.
push(`INSERT INTO GL_BUDGET_ENTITIES (BUDGET_ENTITY_ID, BUDGET_TYPE_ID, BUDGET_ENTITY_NAME, ENABLED_FLAG) VALUES
  (1, 1, 'WCPSS Appropriations', 'Y'), (2, 2, 'WCPSS Capital Projects', 'Y');`);

push(`INSERT INTO GL_BUDGET_ASSIGNMENTS (BUDGET_VERSION_ID, RANGE_FROM, RANGE_TO, BUDGET_ENTITY_ID) VALUES
  (501, '04.6570.862.000.0000.0000.000', '04.6570.862.999.9999.9999.999', 1),
  (502, '04.6570.862.000.0000.0000.000', '04.6570.862.999.9999.9999.999', 1),
  (503, '04.6570.862.000.0000.0000.000', '04.6570.862.999.9999.9999.999', 2),
  (504, '04.6570.862.000.0000.0000.000', '04.6570.862.999.9999.9999.999', 1);`);

push(`INSERT INTO GL_LOOKUPS (LOOKUP_TYPE, LOOKUP_CODE, MEANING, DESCRIPTION, ENABLED_FLAG) VALUES
  ('YES_NO',        'Y', 'Yes', 'Yes', 'Y'),
  ('YES_NO',        'N', 'No',  'No',  'Y'),
  ('BUDGET_STATUS', 'OPEN',    'Open',    'Open for budget entry', 'Y'),
  ('BUDGET_STATUS', 'CURRENT', 'Current', 'The current version',   'Y'),
  ('BUDGET_STATUS', 'FROZEN',  'Frozen',  'No further entry',      'Y');`);

// ---------------------------------------------------------------------------
// 4. GL_BALANCES — the report's numbers, plus filter traps
//
// Every row here is TRANSCRIBED from the report. The PO extract is NOT mixed in,
// because the two are different grains and adding them would make the report
// stop reproducing. The PO-side view (V_ENCUMBRANCE_FROM_PO) exposes that gap
// side by side instead of blending it away.
// ---------------------------------------------------------------------------
const bal = [];
const asOf = periodOf('2026-09');   // the report's as-of period
const balRow = (ledger, cid, per, flag, ver, encType, ccy, tflag, dr, cr, originNote) =>
  bal.push([num(ledger), num(cid), lit(per.name), num(per.fy), num(per.pn), lit('Month'),
    lit(flag), num(ver), num(encType), lit(ccy), lit(tflag), money(dr), money(cr),
    '0', '0', '0', '0']);

// APPROP — split across the versions the report's BOE dates imply, so that a
// "first funded period" query has more than one period to choose between.
const APPROP_SPLIT = {
  '526': [[501, '2022-07', 1_000_000.00], [501, '2022-12', 2_000_000.00], [502, '2023-07', 3_738_830.00]],
  '527': [[504, '2024-07', 40_000_000.00], [504, '2025-07', 30_000_000.00], [504, '2026-07', 17_448_714.00]],
  '529': [[504, '2025-01', 300_000.00], [504, '2025-10', 326_290.00]],
  '532': [[504, '2025-10', 541_624.93]],
};
for (const a of REPORT_ACCOUNTS) {
  for (const [ver, ym, amt] of APPROP_SPLIT[a.object]) balRow(1001, a.ccid, periodOf(ym), 'B', ver, null, 'USD', 'N', amt, 0);
  // CAPITAL — the WCPSS Budget column, all in the first period of version 503.
  balRow(1001, a.ccid, periodOf('2022-07'), 'B', 503, null, 'USD', 'N', a.budget, 0);
}

// ENCUMBRANCE and ACTUAL, split over the periods the report's snapshot implies.
const ENC_SPLIT = {
  '526': [['2026-08', 1_000_000.00], ['2026-09', 1_329_280.40]],
  '527': [['2026-08', 1_500_000.00], ['2026-09', 1_070_739.39]],
  '529': [['2026-09', 149_072.93]],
  '532': [['2026-09', 149_072.93]],
};
const EXP_SPLIT = {
  '526': [['2026-07', 2_000_000.00], ['2026-08', 1_500_000.00], ['2026-09', 909_549.60]],
  '527': [['2026-08', 300_000.00], ['2026-09', 276_844.86]],
  '529': [['2026-09', 214_749.07]],
  '532': [['2026-09', 25_000.00]],
};
for (const a of REPORT_ACCOUNTS) {
  for (const [ym, amt] of ENC_SPLIT[a.object]) balRow(1001, a.ccid, periodOf(ym), 'E', null, 1, 'USD', 'N', amt, 0);
  for (const [ym, amt] of EXP_SPLIT[a.object]) balRow(1001, a.ccid, periodOf(ym), 'A', null, null, 'USD', 'N', amt, 0);
}

// ---- the traps. Each is excluded by exactly one of the five filters. ----
// The two trap ACCOUNTS were created earlier, before the COA insert.
balRow(1001, parentId, periodOf('2022-07'), 'B', 503, null, 'USD', 'N', REPORT_BUDGET_TOTAL, 0);
balRow(1001, disabledId, periodOf('2022-07'), 'B', 503, null, 'USD', 'N', 1_000_000.00, 0);
// LEDGER_ID trap: balances for a second ledger.
balRow(2002, REPORT_ACCOUNTS[0].ccid, periodOf('2022-07'), 'B', 503, null, 'USD', 'N', 6_738_830.00, 0);
// TRANSLATED_FLAG + CURRENCY_CODE trap: the same balance restated into EUR.
balRow(1001, REPORT_ACCOUNTS[0].ccid, periodOf('2022-07'), 'B', 503, null, 'EUR', 'Y', 6_200_000.00, 0);
// ENCUMBRANCE_TYPE_ID trap: a budget-flag row carrying an encumbrance type.
balRow(1001, REPORT_ACCOUNTS[0].ccid, periodOf('2022-07'), 'B', 503, 1, 'USD', 'N', 999_999.99, 0);

ins('GL_BALANCES',
  ['LEDGER_ID', 'CODE_COMBINATION_ID', 'PERIOD_NAME', 'PERIOD_YEAR', 'PERIOD_NUM', 'PERIOD_TYPE',
    'ACTUAL_FLAG', 'BUDGET_VERSION_ID', 'ENCUMBRANCE_TYPE_ID', 'CURRENCY_CODE', 'TRANSLATED_FLAG',
    'PERIOD_NET_DR', 'PERIOD_NET_CR', 'BEGIN_BALANCE_DR', 'BEGIN_BALANCE_CR', 'QUARTER_TO_DATE_DR', 'QUARTER_TO_DATE_CR'],
  bal);

// ---------------------------------------------------------------------------
// 5. Budget journals — the authoritative "when", mirroring the APPROP balances
// ---------------------------------------------------------------------------
let jeId = 900_001;
const jeHeaders = [], jeLines = [];
for (const a of REPORT_ACCOUNTS) {
  for (const [ver, ym, amt] of APPROP_SPLIT[a.object]) {
    const per = periodOf(ym);
    const id = jeId++;
    jeHeaders.push([num(id), num(1001), lit('Budget'), lit('WCPSS BUDGET'), lit(per.name), lit(`Appropriation posted ${per.name} - object ${a.object}`),
      lit('P'), lit(`${per.start} 00:00:00`), lit('B'), lit(`${per.start} 00:00:00`), 'NULL', lit(`${per.end} 00:00:00`),
      lit(`Derived from the report's Allocations/Reimb. column, dated to the period the BOE annotation implies. Budget version ${ver}.`)]);
    jeLines.push([num(id), num(1), num(1001), lit(`${per.start} 00:00:00`), num(a.ccid), lit('U'), money(amt), '0', lit('Appropriation'), lit('BUDGET'), 'NULL', 'NULL']);
  }
}
ins('GL_JE_HEADERS', ['JE_HEADER_ID', 'LEDGER_ID', 'JE_CATEGORY', 'JE_SOURCE', 'PERIOD_NAME', 'NAME', 'STATUS', 'DATE_CREATED', 'ACTUAL_FLAG', 'DEFAULT_EFFECTIVE_DATE', 'ENCUMBRANCE_TYPE_ID', 'POSTED_DATE', 'DESCRIPTION'], jeHeaders);
ins('GL_JE_LINES', ['JE_HEADER_ID', 'JE_LINE_NUM', 'LEDGER_ID', 'EFFECTIVE_DATE', 'CODE_COMBINATION_ID', 'STATUS', 'ENTERED_DR', 'ENTERED_CR', 'DESCRIPTION', 'LINE_TYPE_CODE', 'INVOICE_IDENTIFIER', 'INVOICE_AMOUNT'], jeLines);

// ---------------------------------------------------------------------------
// 6. Purchasing
// ---------------------------------------------------------------------------
ins('PO_VENDORS', ['VENDOR_ID', 'VENDOR_NAME', 'VENDOR_TYPE_LOOKUP_CODE', 'CUSTOMER_NUM', 'PARENT_VENDOR_ID', 'ENABLED_FLAG', 'CREATION_DATE'], vendorRows);
ins('PO_VENDOR_SITES_ALL', ['VENDOR_SITE_ID', 'VENDOR_ID', 'VENDOR_SITE_CODE', 'ADDRESS_LINE1', 'ADDRESS_LINE2', 'ADDRESS_LINE3', 'CITY', 'STATE', 'ZIP', 'AREA_CODE', 'PHONE'], siteRows);
ins('PO_AGENTS', ['AGENT_ID', 'NAME', 'AUTHORIZATION_LIMIT', 'ENABLED_FLAG'], agentRows);
push(`INSERT INTO PO_LINE_TYPES (LINE_TYPE_ID, LINE_TYPE, DESCRIPTION, PURCHASE_BASIS, MATCHING_BASIS, ORDER_TYPE_LOOKUP_CODE) VALUES
  (1000, 'FIXED PRICE', 'Fixed price goods or services', 'PRICE', 'QUANTITY', 'STANDARD');`);
ins('PO_HEADERS_ALL', ['PO_HEADER_ID', 'PO_NUMBER', 'TYPE_LOOKUP_CODE', 'VENDOR_ID', 'VENDOR_SITE_ID', 'AGENT_ID', 'APPROVED_FLAG', 'APPROVED_DATE', 'START_DATE_ACTIVE', 'ORG_ID', 'CANCEL_FLAG'], poHeaders);
ins('PO_LINES_ALL', ['PO_LINE_ID', 'PO_HEADER_ID', 'LINE_TYPE_ID', 'LINE_NUM', 'ITEM_ID', 'ITEM_DESCRIPTION', 'UNIT_MEAS_LOOKUP_CODE', 'UNIT_PRICE', 'QUANTITY', 'CLOSED_CODE', 'CANCEL_FLAG'], poLines);
ins('PO_LINE_LOCATIONS_ALL', ['LINE_LOCATION_ID', 'PO_HEADER_ID', 'PO_LINE_ID', 'SHIPMENT_NUM', 'SHIP_TO_LOCATION_ID', 'QUANTITY', 'QUANTITY_RECEIVED', 'AMOUNT_RECEIVED', 'UNIT_MEAS_LOOKUP_CODE', 'PO_RELEASE_ID', 'APPROVED_FLAG', 'CLOSED_CODE'], poShips);
ins('PO_DISTRIBUTIONS_ALL', ['PO_DISTRIBUTION_ID', 'PO_HEADER_ID', 'PO_LINE_ID', 'LINE_LOCATION_ID', 'CODE_COMBINATION_ID', 'DELIVER_TO_LOCATION_ID', 'DISTRIBUTION_NUM', 'QUANTITY_ORDERED', 'AMOUNT_ORDERED', 'AMOUNT_BILLED', 'ENCUMBERED_FLAG', 'ENCUMBERED_AMOUNT'], poDists);
push(`INSERT INTO PO_LOOKUP_CODES (LOOKUP_TYPE, LOOKUP_CODE, DESCRIPTION) VALUES
  ('PO TYPE', 'STANDARD', 'Standard purchase order'),
  ('CLOSED CODE', 'OPEN', 'Open'), ('CLOSED CODE', 'CLOSED', 'Closed'),
  ('CANCEL', 'Y', 'Cancelled'), ('CANCEL', 'N', 'Not cancelled');`);

// ---------------------------------------------------------------------------
// 7. X_* report-only objects
// ---------------------------------------------------------------------------
ins('X_REPORT_FUNDING_LINES', ['LINE_NUM', 'DESCRIPTION', 'AMOUNT', 'ANNOTATION', 'EVENT_DATE', 'FISCAL_YEAR', 'IS_FORECAST', 'IN_FUNDING_TOTAL'],
  FUNDING.map(([n, d, a, ann, ev, fc]) => [num(n), lit(d), money(a), lit(ann), lit(ev), num(fiscal(ev).fy), num(fc), num(1)]));
ins('X_REPORT_PROJECT_FACTS', ['FACT_NAME', 'FACT_VALUE', 'UNIT', 'NOTE'], PROJECT_FACTS.map(([n, v, u, note]) => [lit(n), lit(v), lit(u), lit(note)]));

// ---------------------------------------------------------------------------
// 8. Provenance
//
// Convention: where an origin VARIES per row, provenance is per row. Where an
// entire table is one origin, a single ROW_KEY='*' row states the origin, the
// count and the source — no information is lost and the file stays readable.
// ---------------------------------------------------------------------------
const prov = [];
const PROV = (t, k, o, src, note) => prov.push([lit(t), lit(k), lit(o), lit(src), lit(note)]);
coaAll.forEach((r) => PROV('GL_CODE_COMBINATIONS', String(r.CODE_COMBINATION_ID), r.__origin, r.__src, nz(r.DESCRIPTION) ? String(r.DESCRIPTION).slice(0, 200) : null));
// ROW_KEY is prefixed rather than suffixed onto TABLE_NAME, so that the table
// itself stays documented under its own name. A reader filtering provenance by
// table should not have to know that "GL_BALANCES:report" means GL_BALANCES.
PROV('GL_BALANCES', '*', DERIVED, 'report-findings.md section 3 + authored traps',
  `ALL ${bal.length} rows: the four report accounts plus five filter traps. Per-row detail follows under ROW_KEY 'report:<ccid>'; every remaining row is a trap covered by 'traps'.`);
REPORT_ACCOUNTS.forEach((a) => PROV('GL_BALANCES', `report:${a.ccid}`, TRANSCRIBED, 'report-findings.md section 3', `Object ${a.object}: budget ${a.budget}, allocations ${a.alloc}, encumbrances ${a.enc}, expenditures ${a.exp}`));
PROV('GL_BALANCES', 'traps', SYNTHETIC, 'authored', 'Rows excluded by exactly one of the five non-optional filters: LEDGER_ID=2002, TRANSLATED_FLAG=Y/EUR, ENCUMBRANCE_TYPE_ID=1 under ACTUAL_FLAG=B, plus the SUMMARY_FLAG=Y and ENABLED_FLAG=N accounts.');

const uniform = [
  ['GL_LEDGERS', 2, DERIVED, 'json-output.json (CHART_OF_ACCOUNTS_ID only)', 'Only CHART_OF_ACCOUNTS_ID=101 is real; LEDGER_ID (1001 primary, 2002 secondary), names and categories are assigned. Ledger 2002 exists solely to carry the LEDGER_ID filter trap.'],
  ['FND_CURRENCIES', 2, SYNTHETIC, 'authored', 'USD is implied by the ledger; EUR exists solely as a filter trap.'],
  ['GL_PERIODS', periodRows.length, SYNTHETIC, 'authored', 'Fiscal year starts 1 July. FY23 = JUL-22..JUN-23, confirmed by the FY23 appropriation BOE date of 7/13/2022.'],
  ['FND_ID_FLEX_STRUCTURES', 1, DERIVED, 'json-output.json', 'ID_FLEX_NUM=101 mirrors CHART_OF_ACCOUNTS_ID=101 from the extract.'],
  ['FND_ID_FLEX_SEGMENTS', 7, SYNTHETIC, 'authored', 'Segment names and order are the conventional EBS COA layout for a 7-segment chart.'],
  ['FND_FLEX_VALUES', 1, TRANSCRIBED, 'report-findings.md section 3', 'Only level 0450 is named, because the report names only one project.'],
  ['FND_FLEX_VALUES_TL', 1, TRANSCRIBED, 'report-findings.md section 3', 'Mirrors FND_FLEX_VALUES. The extract carries no language rows, so no second language exists and none is invented.'],
  ['GL_BUDGET_TYPES', 3, SYNTHETIC, 'authored', "APPROP/CAPITAL split is this build's reading of the report's two budget columns - see the V_ACCOUNT_POSITION comment."],
  ['GL_BUDGET_VERSIONS', 4, DERIVED, 'report-findings.md section 2', 'Version spans follow the BOE dates of the funding lines.'],
  ['GL_BUDGET_ENTITIES', 2, SYNTHETIC, 'authored', 'One entity per budget type. Authored so GL_BUDGET_ASSIGNMENTS has a referent.'],
  ['GL_BUDGET_ASSIGNMENTS', 4, SYNTHETIC, 'authored', 'Ranges covering segment prefix 04.6570.862.'],
  ['GL_LOOKUPS', 5, SYNTHETIC, 'authored', 'YES_NO plus the three BUDGET_STATUS values used by GL_BUDGET_VERSIONS.STATUS_CODE.'],
  ['GL_JE_HEADERS', jeHeaders.length, DERIVED, 'report-findings.md section 3', 'Budget journals mirroring the APPROP balances, dated to the period the BOE annotation implies.'],
  ['GL_JE_LINES', jeLines.length, DERIVED, 'report-findings.md section 3', 'One line per journal, mirroring its APPROP balance exactly.'],
  ['PO_VENDORS', vendorRows.length, EXTRACT, 'full-output.json', `${vendorRows.length} distinct VENDOR_NAME. VENDOR_ID is allocated; the name is real.`],
  ['PO_VENDOR_SITES_ALL', siteRows.length, SYNTHETIC, 'authored', 'One site per vendor. The extract carries no site grain, so this is a shape placeholder, not data.'],
  ['PO_AGENTS', agentRows.length, EXTRACT, 'full-output.json', `${agentRows.length} distinct BUYER_NAME. AGENT_ID is allocated; the name is real.`],
  ['PO_LINE_TYPES', 1, SYNTHETIC, 'authored', 'Single FIXED PRICE type; the extract does not carry the line type for full-output rows.'],
  ['PO_LOOKUP_CODES', 5, SYNTHETIC, 'authored', 'LINE_TYPE and CLOSED_CODE values actually present in the PO extract, plus the two CANCEL_FLAG values.'],
  ['PO_HEADERS_ALL', poHeaders.length, DERIVED, 'full-output.json', `${headerIdByNumber.size} headers from ORDER_NUMBER (PO_HEADER_ID allocated from 3000001), plus ${invHeaderIds.size} headers whose PO_HEADER_ID is real but whose other attributes are absent from the extract. No column joins the two groups.`],
  ['PO_LINES_ALL', poLines.length, EXTRACT, 'full-output.json + inv-lines.json', `${byLine.size} unique (ORDER_NUMBER, LINE_NUMBER) pairs - verified unique - plus ${invLines.length} rows from inv-lines.json. TWO GRAINS share this row shape and the split is preserved as-is: 589 lines with no ITEM_ID are lump-sum lines whose dollar value sits in QUANTITY (UNIT_PRICE 1), and 2,193 lines with an ITEM_ID are goods lines with a real quantity and price. QUANTITY is therefore NOT comparable across these rows and must not be summed across them. See 03-notes.sql section 12 and gates G16/G17.`],
  ['PO_LINE_LOCATIONS_ALL', poShips.length, DERIVED, 'full-output.json + inv-distributions.json', 'One shipment per line. The extract has no shipment grain, so QUANTITY mirrors the line.'],
  ['PO_DISTRIBUTIONS_ALL', poDists.length, DERIVED, 'full-output.json + inv-distributions.json', 'One distribution per distinct account segment tuple on a line. AMOUNT_ORDERED is real; ENCUMBERED_AMOUNT mirrors it because the extract carries no separate encumbered figure for full-output rows.'],
  ['X_REPORT_FUNDING_LINES', FUNDING.length, TRANSCRIBED, 'report-findings.md section 2', 'Project-level funding. Does NOT reconcile with the per-account GL_BALANCES allocations and is not expected to - different grains.'],
  ['X_REPORT_PROJECT_FACTS', PROJECT_FACTS.length, TRANSCRIBED, 'report-findings.md section 2', 'No standard EBS home. Quarantined behind the X_ prefix.'],
];
for (const [t, c, o, src, note] of uniform) PROV(t, '*', o, src, `ALL ${c} rows. ${note}`);

// Payables and Projects are present as structure but hold no rows. The extract in
// data/oracle/ contains no AP or PA data at all, so the honest thing is to say so
// rather than leave the tables undocumented and let a reader wonder whether the
// build forgot them.
const EMPTY = ['AP_INVOICES_ALL', 'AP_INV_LINES', 'AP_INVOICE_DISTRIBUTIONS_ALL', 'AP_INVOICE_PAYMENTS_ALL',
  'PA_PROJECTS_ALL', 'PA_TASKS', 'PA_BUDGET_VERSIONS', 'PA_BUDGET_LINES'];
for (const t of EMPTY) {
  PROV(t, '*', SYNTHETIC, 'authored', 'ZERO rows, intentionally. The extract slice in data/oracle/ contains no AP or PA data. The table exists so the schema has the right shape; a query against it returns nothing, which is a fact about the slice and not about the ledger.');
}

ins('SAMPLE_DATA_PROVENANCE', ['TABLE_NAME', 'ROW_KEY', 'DATA_ORIGIN', 'SOURCE_FILE', 'NOTE'], prov, 200);

// ---------------------------------------------------------------------------
// Report the plan of what was generated (used by verify-turso-sample.mjs)
// ---------------------------------------------------------------------------
const buildInfo = {
  coaExtract: coaById.size,
  coaTranscribed: coaNew.filter((r) => r.__origin === TRANSCRIBED).length,
  coaDerived: coaNew.filter((r) => r.__origin === DERIVED).length,
  coaSynthetic: coaNew.filter((r) => r.__origin === SYNTHETIC).length,
  coaTotal: coaAll.length,
  vendors: vendorRows.length,
  agents: agentRows.length,
  headers: poHeaders.length,
  lines: poLines.length,
  distributions: poDists.length,
  balances: bal.length,
  jeHeaders: jeHeaders.length,
  periods: periodRows.length,
  provenance: prov.length,
  fundingTotal: FUNDING.reduce((s, f) => s + f[2], 0),
  reportBudgetTotal: REPORT_BUDGET_TOTAL,
  reportAllocTotal: REPORT_ACCOUNTS.reduce((s, a) => s + a.alloc, 0),
  reportEncTotal: REPORT_ACCOUNTS.reduce((s, a) => s + a.enc, 0),
  reportExpTotal: REPORT_ACCOUNTS.reduce((s, a) => s + a.exp, 0),
  reportAccountCcids: REPORT_ACCOUNTS.map((a) => ({ object: a.object, ccid: a.ccid })),
  extractCcids: [...coaById.keys()],
  extractVendorNames: [...vendors.keys()],
  extractAgentNames: [...agents.keys()],
  orderNumbers: [...headerIdByNumber.keys()],
  invDistCcids: [...new Set(invDists.map((r) => Number(r.CODE_COMBINATION_ID)))],
};
writeFileSync(join(OUT_DIR, 'build-manifest.json'), JSON.stringify(buildInfo, null, 2));

// ---------------------------------------------------------------------------
// Emit + apply
// ---------------------------------------------------------------------------
const seedSql = `-- GENERATED by scripts/build-turso-sample.mjs — do not edit by hand.
-- Source: data/oracle/*.json + report-findings.md. Regenerate instead.
-- Money is REAL dollars (measured safe at these magnitudes — see 03-notes.sql).
-- Every row's origin is recorded in SAMPLE_DATA_PROVENANCE.
--
--   COA rows      ${String(buildInfo.coaTotal).padStart(6)}  (${buildInfo.coaExtract} extract + ${buildInfo.coaTranscribed} transcribed + ${buildInfo.coaDerived} derived + ${buildInfo.coaSynthetic} synthetic)
--   PO headers    ${String(buildInfo.headers).padStart(6)}
--   PO lines      ${String(buildInfo.lines).padStart(6)}
--   distributions ${String(buildInfo.distributions).padStart(6)}
--   GL balances   ${String(buildInfo.balances).padStart(6)}
--   provenance    ${String(buildInfo.provenance).padStart(6)}

BEGIN;
${stmts.join('\n\n')}
COMMIT;
`;
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(SEED_SQL, seedSql);

console.log('generated 02-seed.sql');
console.log(`  COA ${buildInfo.coaTotal} = ${buildInfo.coaExtract} extract + ${buildInfo.coaTranscribed} transcribed + ${buildInfo.coaDerived} derived + ${buildInfo.coaSynthetic} synthetic`);
console.log(`  PO headers ${buildInfo.headers}, lines ${buildInfo.lines}, distributions ${buildInfo.distributions}`);
console.log(`  GL balances ${buildInfo.balances}, periods ${buildInfo.periods}, provenance ${buildInfo.provenance}`);
console.log(`  seed size ${(seedSql.length / 1024).toFixed(0)} KB, ${stmts.length} statements`);

if (SQL_ONLY) process.exit(0);

// --- split the schema into statements, respecting string literals -----------
function splitSql(src) {
  const out = [];
  let buf = '', inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      buf += c;
      if (c === "'") { if (src[i + 1] === "'") { buf += src[++i]; } else inStr = false; }
      continue;
    }
    if (c === "'") { inStr = true; buf += c; continue; }
    if (c === '-' && src[i + 1] === '-') { while (i < src.length && src[i] !== '\n') i++; buf += '\n'; continue; }
    if (c === ';') { const s = buf.trim(); if (s) out.push(s); buf = ''; continue; }
    buf += c;
  }
  const s = buf.trim(); if (s) out.push(s);
  return out;
}

const url = REMOTE
  ? process.env.TURSO_DATABASE
  : pathToFileURL(DB_FILE).href;
const authToken = REMOTE ? process.env.TURSO_API_KEY : undefined;

if (REMOTE && !(url && authToken)) {
  // Report which one is missing, and where this script looked. "Load .env first"
  // was the old message and it sent the reader down the wrong path — the file is
  // already read above; the usual cause is a missing or blank key inside it.
  const missing = [!url && 'TURSO_DATABASE', !authToken && 'TURSO_API_KEY'].filter(Boolean).join(' and ');
  console.error(`\n--remote: ${missing} is not set.`);
  console.error(`  Checked the environment, then ${join(ROOT, '.env')}.`);
  console.error('  A key present but empty counts as missing; values must not be quoted unless they contain spaces.');
  process.exit(1);
}
if (!REMOTE) {
  // Fresh build every time: a stale sample.db silently carries old rows.
  try { rmSync(DB_FILE); } catch {}
}

const client = createClient(authToken ? { url, authToken } : { url });
// Name the remote target. The reset step below DROPS every table and view in it
// and asks nothing first, so "Turso (remote)" alone left the one fact that
// matters -- which database is about to be erased -- absent from the output.
console.log(`\nbuilding ${REMOTE ? `Turso (remote) ${hostOf(url)}` : DB_FILE} ...`);

try {
  // A remote build is not a fresh file, so the previous build's rows are still
  // sitting there. Without this the second --remote run dies on the very first
  // INSERT with "UNIQUE constraint failed: GL_LEDGERS.LEDGER_ID", which reads
  // like a seed bug and is not one. Clear the target so --remote means what the
  // local build means: built from nothing.
  if (REMOTE) {
    const existing = await client.execute(
      "SELECT type, name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'");
    const views = existing.rows.filter((r) => r.type === 'view').map((r) => String(r.name));
    const tables = existing.rows.filter((r) => r.type === 'table').map((r) => String(r.name));

    for (const v of views) await client.execute(`DROP VIEW IF EXISTS "${v}"`);

    // Children before parents, discovered rather than declared: a table whose
    // drop is still refused is retried on the next pass. If a whole pass drops
    // nothing, the remaining tables are genuinely unreachable and we stop with
    // a message instead of looping.
    let pending = tables;
    for (let pass = 0; pending.length; pass++) {
      const blocked = [];
      for (const t of pending) {
        try { await client.execute(`DROP TABLE IF EXISTS "${t}"`); }
        catch { blocked.push(t); }
      }
      if (blocked.length === pending.length) {
        throw new Error(`could not drop ${blocked.join(', ')} — something still references them`);
      }
      if (pass > tables.length) break;
      pending = blocked;
    }
    if (views.length || tables.length) console.log(`  reset:    dropped ${tables.length} table(s), ${views.length} view(s)`);
  }

  const ddl = splitSql(readFileSync(SCHEMA, 'utf8'));
  await client.batch(ddl, 'write');
  console.log(`  schema:   ${ddl.length} statements`);

  const seed = splitSql(seedSql).filter((s) => !/^(BEGIN|COMMIT)$/i.test(s));
  // Applied one at a time, deliberately. A 50-statement batch reports only
  // "FOREIGN KEY constraint failed" with no clue which insert caused it, and
  // the extra round trips cost nothing against a local file.
  for (let i = 0; i < seed.length; i++) {
    try {
      await client.execute(seed[i]);
    } catch (e) {
      const m = /INSERT\s+INTO\s+([A-Z0-9_#]+)/i.exec(seed[i]);
      const dbg = ['\n  SEED FAILURE'];
      dbg.push(`  statement ${i + 1} of ${seed.length}${m ? `, inserting into ${m[1]}` : ''}`);
      dbg.push(`  sqlite: ${e.cause?.code || e.code || '?'} ${e.message}`);
      dbg.push('  sql: ' + seed[i].slice(0, 300).replace(/\s+/g, ' '));
      console.error(dbg.join('\n'));
      throw e;
    }
  }
  console.log(`  seed:     ${seed.length} statements`);

  const counts = await client.batch([
    'SELECT COUNT(*) n FROM GL_CODE_COMBINATIONS',
    'SELECT COUNT(*) n FROM PO_LINES_ALL',
    'SELECT COUNT(*) n FROM PO_DISTRIBUTIONS_ALL',
    'SELECT COUNT(*) n FROM GL_BALANCES',
    'SELECT COUNT(*) n FROM SAMPLE_DATA_PROVENANCE',
  ], 'read');
  console.log('  verified: ' + counts.map((r, i) => `${['COA', 'PO_LINES', 'PO_DISTS', 'GL_BALANCES', 'PROVENANCE'][i]}=${r.rows[0].n}`).join(' '));
  console.log('\ndone.');
} catch (err) {
  console.error('\nBUILD FAILED:', err.message);
  if (String(err.message).includes('JWT') || String(err.message).includes('Unauthorized')) {
    console.error('The Turso API token is being rejected. Regenerate it in the Turso dashboard.');
  }
  process.exit(1);
} finally {
  client.close();
}
