// Applies the supporting indexes the ledger statements want to the local MySQL mirror
// and reports the cost. Idempotent: a name that is already present is reported, not
// recreated. `--apply` creates what is missing, `--drop` removes the listed ones.
//
// ★★ THE TWO `PO_*` ENTRIES AT THE END ARE NOT AP-LATENCY INDEXES — THEY ARE WHAT KEEPS
//    `/api/extract/current` FROM TAKING A MINUTE. They were added after the plan for that
//    statement was read with EXPLAIN and found to lead with a full scan of
//    `po_line_locations_all` (1,146,800 rows):
//
//      no index                51.0 s   plan starts pll/ALL
//      + idx_pll_header_line    7.0 s
//      + idx_po_dist_ccid       6.6 s
//
//    The join reaches `po_line_locations_all` on `(PO_HEADER_ID, PO_LINE_ID)`, and the
//    table as replicated had that same pair as `(PO_LINE_ID, PO_HEADER_ID)` — the two
//    columns in the order that an `ON` clause cannot use as a prefix. MySQL's answer was
//    to lead with the largest table in the statement. With both indexes the plan starts
//    from `IX_GCC_SCOPE` (the fund and the programs) instead, and the rest of the join is
//    `eq_ref` primary-key lookups.
//
//    ★ DO NOT RENAME THESE TO MATCH THE `IX_` STYLE ABOVE. The names are not cosmetic —
//      they are the keys the existence check above uses, and the two indexes already exist
//      in the mirror under these exact lowercase names. Renaming an entry does not rename
//      the index; it makes the check report the index missing and create a second, duplicate
//      one beside it.
//
//    ★ VERIFY WITH EXPLAIN, NOT WITH A CLOCK. The good plan lists `gl_code_combinations`
//      first with `type=range`. If `po_line_locations_all` or `po_headers_all` appears as
//      `type=ALL`, one of these has been dropped — a mirror re-sync is the way that happens,
//      since the ETL that fills these tables does not know this file exists.
//
// ★★ THE LAST TWO ENTRIES ARE THE SAVED VIEW `first-fundings` (`saved_view` id 8), WHICH
//    TIMED OUT AT 5 s IN THE VIEW BUILDER. They are one half of that fix; the other half is
//    a predicate in the view body itself, and neither half works alone. Measured, statement
//    wrapped for the row cap exactly as `wrapForRowCap` wraps it:
//
//      baseline                                   13.3 s   full scan of gl_balances (1,448,776 rows)
//      + IX_GB_CCID                               13.0 s   no plan change — dropped again
//      + IX_GB_BUDGET_CCID                        23–26 s  ★ WORSE: 490,889 random row fetches
//                                                         beat a 5.9 s sequential scan
//      + column histograms                        24.9 s   cannot fix a correlated-column estimate
//      + IX_GJL_CCID_DATE and IX_GB_FIRST_FUNDING  9.1 s   correct index, still the wrong join order
//      + the implied scope predicate in the body    2.6 s   ★ index-only, no scan of gl_balances
//
//    ROOT CAUSE, so nobody re-derives it: `ACTUAL_FLAG`, `TRANSLATED_FLAG`,
//    `ENCUMBRANCE_TYPE_ID` and `LEDGER_ID` are each single-valued *within*
//    `BUDGET_VERSION_ID = 1001`, but MySQL multiplies their global selectivities and
//    estimates 145 rows where the truth is 490,889 — so it never starts from the 1,630-row
//    fund-04/program-862 scope. `IX_GB_FIRST_FUNDING` is ordered by
//    `(CODE_COMBINATION_ID, BUDGET_VERSION_ID, …)` because the winning plan looks the rows
//    up *by combination*; it is a covering index, so the lookup never touches the table.
//
//    ★ A RE-SYNC SILENTLY UNDOES THIS. The ETL that fills these tables does not know this
//      file exists, so the two indexes vanish and the view goes back to timing out. Read the
//      plan for `first-fundings` after any rebuild — if `gl_balances` is `type=ALL`, re-run
//      `node _perf-index.mjs --apply`.
import { readFileSync } from 'node:fs';
import mysql from 'mysql2/promise';

const env = {};
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
}

const conn = await mysql.createConnection({
  host: env.MYSQL_HOST,
  port: Number(env.MYSQL_PORT),
  user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD,
  database: env.MYSQL_DATABASE,
});

const WANT = [
  ['WCSEXP_AP_INVOICES', 'IX_WAI_DATE', '(INVOICE_DATE)'],
  ['WCSEXP_AP_CHECKS', 'IX_WAC_DATE', '(CHECK_DATE)'],
  ['WCSEXP_AP_INVOICE_PAYMENTS', 'IX_WAIP_INVOICE', '(INVOICE_ID)'],
  ['WCSEXP_AP_INVOICE_PAYMENTS', 'IX_WAIP_CHECK', '(CHECK_ID)'],
  ['AP_INVOICE_DISTRIBUTIONS_ALL', 'IX_AIDA_INVOICE', '(INVOICE_ID, DIST_CODE_COMBINATION_ID)'],
  ['AP_INVOICE_DISTRIBUTIONS_ALL', 'IX_AIDA_CCID', '(DIST_CODE_COMBINATION_ID)'],
  ['AP_INVOICE_LINES_ALL', 'IX_AILA_INVOICE', '(INVOICE_ID, PO_HEADER_ID)'],
  ['GL_CODE_COMBINATIONS', 'IX_GCC_SCOPE', '(SEGMENT1, SEGMENT3)'],
  // ★★ The `first-fundings` view's two — see the header.
  ['GL_BALANCES', 'IX_GB_FIRST_FUNDING',
    '(CODE_COMBINATION_ID, BUDGET_VERSION_ID, CURRENCY_CODE, LEDGER_ID, ACTUAL_FLAG, ' +
    'TRANSLATED_FLAG, ENCUMBRANCE_TYPE_ID, PERIOD_YEAR, PERIOD_NUM, PERIOD_NAME, ' +
    'PERIOD_NET_DR, PERIOD_NET_CR)'],
  ['GL_JE_LINES', 'IX_GJL_CCID_DATE', '(CODE_COMBINATION_ID, CREATION_DATE)'],
  // ★★ The extract's two — see the header. `idx_pll_header_line` is the pair the join is
  //    written in; `idx_po_dist_ccid` keeps the join from starting on the wrong side.
  ['PO_LINE_LOCATIONS_ALL', 'idx_pll_header_line', '(PO_HEADER_ID, PO_LINE_ID)'],
  ['PO_DISTRIBUTIONS_ALL', 'idx_po_dist_ccid', '(CODE_COMBINATION_ID)'],
];

const apply = process.argv.includes('--apply');
const drop = process.argv.includes('--drop');

for (const [table, name, cols] of WANT) {
  const [rows] = await conn.query(
    'SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
    [table, name],
  );
  const exists = rows.length > 0;
  if (drop) {
    if (exists) {
      await conn.query(`DROP INDEX ${name} ON ${table}`);
      console.log(`dropped  ${name} on ${table}`);
    }
    continue;
  }
  if (exists) {
    console.log(`present  ${name} on ${table} ${cols}`);
    continue;
  }
  if (!apply) {
    console.log(`missing  ${name} on ${table} ${cols}`);
    continue;
  }
  const t0 = Date.now();
  await conn.query(`CREATE INDEX ${name} ON ${table} ${cols}`);
  console.log(`created  ${name} on ${table} ${cols} in ${Date.now() - t0} ms`);
}

const [idx] = await conn.query(
  `SELECT TABLE_NAME, INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS COLS
     FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME IN (${WANT.map(() => '?').join(',')})
    GROUP BY TABLE_NAME, INDEX_NAME
    ORDER BY TABLE_NAME, INDEX_NAME`,
  WANT.map(([t]) => t),
);
console.log('\n--- indexes now on the ledger tables ---');
for (const r of idx) console.log(`${r.TABLE_NAME.padEnd(32)} ${String(r.INDEX_NAME).padEnd(24)} ${r.COLS}`);

await conn.end();
