/**
 * Add `PO_NUMBER` to the frozen AP checks extract — `data/oracle/checks.json`.
 *
 * ── WHY THIS IS AN ENRICHMENT AND NOT A RE-PULL ──────────────────────────────
 *
 * `pull-ap-extract.mjs` is the generator, and re-running it would produce the
 * column — but it would also **move the window**: the ledger has kept moving
 * since the file was frozen, so a fresh pull brings in checks that were not in
 * it, and every count the app prints (4,218 checks, 9,451 links, the 4,140 that
 * reconcile) would change. `server/src/scripts/smoke.ts` asserts
 * `population.read === 4218`, and a dozen comments across `app/` and `server/`
 * quote the same two figures.
 *
 * That is not a reason to re-freeze; it is a reason to treat the frozen file as
 * frozen and **add one column to it**. The row set is preserved exactly, and the
 * only thing that changes is that each link now carries the order its invoice
 * was raised against.
 *
 * ⇒ `pull-ap-extract.mjs` is updated in the same change so that a future
 *   deliberate re-pull produces this column itself. Without that, the next
 *   re-pull would silently drop it and this script would be the only thing that
 *   knew the column existed.
 *
 * ── WHERE THE NUMBER COMES FROM ──────────────────────────────────────────────
 *
 * Not from the invoice's own `PO_HEADER_ID` — that is NULL on every row, the
 * standing finding for `AP_INVOICES`. It is on the invoice **LINE**:
 *
 *     AP_INVOICE_LINES_ALL.PO_HEADER_ID → PO_HEADERS_ALL.PO_HEADER_ID
 *     PO_HEADERS_ALL.SEGMENT1            =  the number a person reads
 *
 * `WCSEXP_AP_INVOICE_LINES` does not exist (ORA-00942), so a base table is the
 * only route. Same reasoning and the same two objects as
 * `pull-invoices-extract.mjs`; see its header for the full argument.
 *
 * ── THE MERGE KEY, AND WHY IT IS FOUR FIELDS ────────────────────────────────
 *
 * The file's `Table2` carries **no `INVOICE_ID`** — a check does not need one,
 * so the pull never selected it — and `INVOICE_NUM` is **not an identity**
 * (3,075 numbers drawn across 3,743 invoices in this window; `PAYAPP4` names
 * four different documents). Keying the merge on the number alone would attach
 * the wrong order to every colliding link and look certain while doing it.
 *
 * So the merge uses the same tuple `pull-ap-extract.mjs` treats as the link's
 * identity when it counts repeats — `(CHECK_ID, INVOICE_NUM, INVOICE_DATE,
 * INVOICE_AMOUNT)` — and the ambiguity that tuple cannot resolve is **counted
 * and reported** rather than absorbed:
 *
 *   1. Oracle rows vs the file's links — must agree exactly (9,451).
 *   2. Links whose four fields match nothing in the file.
 *   3. Four-tuples that map to two invoices naming **different** orders — the
 *      one case a `MAX()` would silently choose. Reported by name.
 *
 * The invariants are printed rather than assumed, and the script refuses to
 * write when the row set does not line up.
 *
 * Usage:  node scripts/enrich-checks-po.mjs [--file=path] [--dry]
 */
import dotenv from 'dotenv';
import oracledb from 'oracledb';
import { readFileSync, writeFileSync, statSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

dotenv.config({ path: '../.env' });

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const DRY = process.argv.includes('--dry');
const FILE = resolve(arg('file', '../data/oracle/checks.json'));

/**
 * A figure as a stable string, for comparing a JSON number against an Oracle
 * number. `1225` and `1225.00` are the same amount and must key the same.
 */
const amtKey = (v) => Number(v ?? 0).toFixed(4);

/** The link identity, as `pull-ap-extract.mjs` already defines it. */
const linkKey = (checkId, num, date, amount) =>
  `${Number(checkId)}|${String(num)}|${String(date)}|${amtKey(amount)}`;

const N = (n) => Number(n).toLocaleString('en-US');
const say = (s = '') => process.stdout.write(s + '\n');

/* ── controls: the harness must be shown to run statements ─────────────────── */

oracledb.initOracleClient({ libDir: process.env.ORACLE_THICK_LIB_DIR });
oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

const pool = await oracledb.createPool({
  user: process.env.ORACLE_USER,
  password: process.env.ORACLE_PASSWORD,
  connectString: process.env.ORACLE_CONNECT_STRING,
  poolMin: 0,
  poolMax: 2,
});

const q = async (sql, args = []) => {
  const c = await pool.getConnection();
  c.callTimeout = 900000;
  try {
    return await c.execute(sql, args);
  } finally {
    await c.close().catch(() => {});
  }
};

const fatal = [];
say('controls (each must FAIL):');
for (const [name, sql] of [
  ['syntax error  ', 'SELECT FROM WHERE (('],
  ['unknown object', 'SELECT 1 FROM APPS.NO_SUCH_TABLE_WCS'],
]) {
  try {
    await q(sql);
    say(`  ${name}  ** PASSED — statements are not being run **`);
    fatal.push('the harness did not report a broken statement');
  } catch (e) {
    say(`  ${name}  failed as expected: ${String(e.message).split('\n')[0].slice(0, 60)}`);
  }
}

/* ── the file, and the window it was frozen over ───────────────────────────── */

const envelope = JSON.parse(readFileSync(FILE, 'utf8'));
const table1 = envelope?.body?.ResultSets?.Table1;
const table2 = envelope?.body?.ResultSets?.Table2;
if (!Array.isArray(table1) || !Array.isArray(table2)) {
  throw new Error(`${FILE} has no body.ResultSets.Table1/Table2 arrays.`);
}

const dates = table1.map((r) => r.CHECK_DATE).filter(Boolean).sort();
const from = dates[0];
say();
say(`file      ${FILE}`);
say(`  ${(statSync(FILE).size / 1024 / 1024).toFixed(2)} MB  ·  ${N(table1.length)} checks  ·  ${N(table2.length)} links`);
say(`  check dates in file   ${from} .. ${dates[dates.length - 1]}`);

const already = table2.filter((r) => r.PO_NUMBER !== undefined).length;
if (already === table2.length) {
  say('  every link already carries PO_NUMBER — nothing to do');
  await pool.close();
  process.exit(0);
}
if (already > 0) {
  say(`  ** ${N(already)} links already carry PO_NUMBER — the file is from an interrupted run **`);
  fatal.push('the extract is in a half-enriched state; re-pull it before enriching');
}

/**
 * The window is the file's own, never today's.
 *
 * ★ Deriving it from `GL_PERIODS` here would be wrong: the point of this script
 *   is to stay inside the window the file was frozen over, so a row added to the
 *   ledger since then cannot enter through the query.
 */
say();
say('reading the orders, over the file\'s own window …');
const t0 = Date.now();

const links = await q(
  /*
   * `DISTINCT` and not `GROUP BY`: `i.INVOICE_ID` is carried out so the JS side
   * can see when one four-tuple resolves to *two different invoices*, which is
   * the only case `MAX()` would choose silently. Grouping here would fold that
   * evidence away before it could be counted — and grouping by a correlated
   * scalar subquery is not worth finding out about.
   *
   * So this returns ≥ the file's link count, by design. The roll-up to the
   * file's key happens in `byKey` below.
   */
  `SELECT DISTINCT p.CHECK_ID,
          i.INVOICE_NUM,
          TO_CHAR(i.INVOICE_DATE,'YYYY-MM-DD') AS INVOICE_DATE,
          i.INVOICE_AMOUNT,
          i.INVOICE_ID,
          -- Correlated and scalar, so it cannot multiply the payment rows the
          -- join fans out. Same shape as the invoices pull.
          (SELECT MAX(h.SEGMENT1)
             FROM APPS.AP_INVOICE_LINES_ALL l
             JOIN APPS.PO_HEADERS_ALL h ON h.PO_HEADER_ID = l.PO_HEADER_ID
            WHERE l.INVOICE_ID = i.INVOICE_ID) AS PO_NUMBER
     FROM APPS.WCSEXP_AP_CHECKS c
     JOIN APPS.WCSEXP_AP_INVOICE_PAYMENTS p ON p.CHECK_ID = c.CHECK_ID
     JOIN APPS.WCSEXP_AP_INVOICES i ON i.INVOICE_ID = p.INVOICE_ID
    WHERE c.CHECK_DATE >= TO_DATE(:d1,'YYYY-MM-DD')
      AND c.CHECK_DATE <= TO_DATE(:d2,'YYYY-MM-DD')`,
  {
    d1: { val: from, dir: oracledb.BIND_IN, type: oracledb.STRING },
    d2: { val: dates[dates.length - 1], dir: oracledb.BIND_IN, type: oracledb.STRING },
  },
);
say(`  took ${N(Date.now() - t0)} ms  ·  ${N(links.rows.length)} link rows`);

/**
 * Roll the Oracle rows onto the four-field identity the file uses.
 *
 * Grouping in JS rather than SQL is deliberate: the question being asked is
 * "does this four-tuple resolve to ONE order", and that is a question about the
 * file's key, which SQL does not know about. `variants` is the ambiguity.
 */
const byKey = new Map();
for (const r of links.rows) {
  const k = linkKey(r.CHECK_ID, r.INVOICE_NUM, r.INVOICE_DATE, r.INVOICE_AMOUNT);
  const seen = byKey.get(k);
  const po = r.PO_NUMBER == null || String(r.PO_NUMBER).trim() === '' ? null : String(r.PO_NUMBER).trim();
  if (!seen) byKey.set(k, { po, variants: new Set(po ? [po] : []) });
  else if (po) seen.variants.add(po);
}

/* ── the invariants ────────────────────────────────────────────────────────── */

say();
say('invariants:');

const ambiguous = [...byKey.entries()].filter(([, v]) => v.variants.size > 1);
say(`  1 four-tuples whose invoices name DIFFERENT orders   ${N(ambiguous.length)}${ambiguous.length ? '  ** a MAX() would choose silently **' : '  ok'}`);
for (const [k, v] of ambiguous.slice(0, 8)) {
  say(`      ${k}  →  ${[...v.variants].join(' / ')}`);
}
if (ambiguous.length > 8) say(`      … and ${N(ambiguous.length - 8)} more`);

// The merge, and how much of it lands.
let matched = 0;
let named = 0;
const missed = [];
for (const row of table2) {
  const k = linkKey(row.CHECK_ID, row.INVOICE_NUM, row.INVOICE_DATE, row.INVOICE_AMOUNT);
  const hit = byKey.get(k);
  if (hit) matched += 1;
  else missed.push(k);
  row.PO_NUMBER = hit ? hit.po : null;
  if (hit && hit.po) named += 1;
}

const rate = (matched / table2.length) * 100;
say(`  2 links in the file found in Oracle                    ${N(matched)} of ${N(table2.length)}  (${rate.toFixed(2)}%)`);
for (const m of missed.slice(0, 8)) say(`      missing  ${m}`);
if (missed.length > 8) say(`      … and ${N(missed.length - 8)} more`);
if (matched !== table2.length) {
  fatal.push(
    `${N(table2.length - matched)} of the file's links are not in Oracle over the file's own window — ` +
      'the ledger has moved, so this merge would invent blanks. Re-pull instead of enriching.',
  );
}

say(`  3 links that name a purchase order                     ${N(named)} of ${N(table2.length)}  (${((named / table2.length) * 100).toFixed(1)}%)`);
const numbers = new Set(table2.map((r) => r.PO_NUMBER).filter(Boolean));
say(`  4 distinct order numbers                               ${N(numbers.size)}`);
say(`  5 links that name none                                 ${N(table2.length - named)}  — measured: 2,408 distinct vendors, and invoice numbers like TRAV/063026, PARENT STIPEND, LOCAL/ March 2026ADJ — reimbursements, stipends and adjustments, which are not purchases`);

if (fatal.length) {
  say();
  say('REFUSING TO WRITE:');
  for (const f of fatal) say(`  · ${f}`);
  await pool.close();
  process.exit(1);
}

/* ── write ─────────────────────────────────────────────────────────────────── */

/**
 * `.po` — the file's own coverage stamp, the counterpart of `invoices.json`'s.
 *
 * At the LINK grain, because that is what `Table2` is. It is a fingerprint of
 * this file and **not** the figure the panel prints: the panel counts its own
 * check's invoices, which is a different population. Both are labelled where
 * they appear.
 */
envelope.po = {
  grain: 'link',
  window: { from, to: dates[dates.length - 1] },
  links: table2.length,
  named,
  notNamed: table2.length - named,
  distinctNumbers: numbers.size,
  /** 0 on this extract. Non-zero would mean the four-tuple key cannot resolve one order. */
  ambiguousLinks: ambiguous.length,
  pulledAt: new Date().toISOString().slice(0, 10),
};

if (DRY) {
  say();
  say('--dry: nothing written. The checks above are the result.');
  await pool.close();
  process.exit(0);
}

copyFileSync(FILE, `${FILE}.bak`);
writeFileSync(FILE, JSON.stringify(envelope));
say();
say(`wrote ${FILE}`);
say(`  ${(statSync(FILE).size / 1024 / 1024).toFixed(2)} MB  ·  backup at ${FILE}.bak`);
say();
say('now copy it over the served copy:');
say('  Copy-Item data/oracle/checks.json app/public/oracle/checks.json -Force');

await pool.close();
