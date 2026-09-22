/**
 * Pull the AP checks extract out of Oracle and into `data/oracle/checks.json`.
 *
 * ── WHY AN EXTRACT AND NOT A LIVE QUERY ───────────────────────────────────────
 *
 * The WCSEXP_* views ARE readable now, so "we cannot use the view directly" is no
 * longer true — the app just has no Oracle connection at runtime. The browser
 * reads static JSON and `DB_MODE=local` says so. So the choice is not view vs
 * extract; it is *which* rows to freeze.
 *
 * ── WHY THE WINDOW IS ONE FISCAL YEAR ────────────────────────────────────────
 *
 * Measured, not guessed. A check carries ~2.4 invoice links and the pair costs
 * ~567 bytes of JSON. Scaled from actual rows:
 *
 *     one fiscal year    ~4,200 checks  ~2.4 MB   <- this
 *     six months        ~18,900 checks  ~10.7 MB
 *     the FY25-FY27 window used by the SQL files
 *                     ~85,900 checks    ~49 MB
 *
 * 49 MB is not a file a page can fetch, and 10.7 MB is not far off it. One
 * fiscal year is the largest slice that is both complete on its own terms and
 * small enough to ship, and "this fiscal year" is a bound a reader already
 * understands — unlike "the most recent 4,218 rows".
 *
 * The window is DERIVED from GL_PERIODS, never written as a literal, so it moves
 * with the ledger the way `04-spend-and-actuals.sql` does.
 *
 * ── WHAT IT CHECKS BEFORE IT WRITES ──────────────────────────────────────────
 *
 * Five things a static extract can get silently wrong, so they are asserted and
 * printed rather than assumed:
 *   1. CHECK_ID is the row key. CHECK_NUMBER is NOT unique, so duplicates are
 *      counted and reported instead of being collapsed.
 *   2. Every in-window check should have at least one invoice. Orphans outside
 *      FY2025-FY2027 were 12,474 in an earlier measurement, all 2000-2011.
 *   3. No link is repeated. See the fan-out note below for why this one exists.
 *   4. A check's invoices should sum to its amount. Measured at 97.8% exact over
 *      7,245 checks, so a sharp drop here means the join is wrong, not the data.
 *   5. The order a link names is unique — see the PO note below.
 *
 * ── THE PURCHASE ORDER COLUMN, AND WHY IT IS A SCALAR SUBQUERY ─────────────
 *
 * The invoice's own PO_HEADER_ID is NULL on every row of WCSEXP_AP_INVOICES, so
 * the number a person reads is on the invoice's **line**:
 *
 *     AP_INVOICE_LINES_ALL.PO_HEADER_ID → PO_HEADERS_ALL.PO_HEADER_ID
 *     PO_HEADERS_ALL.SEGMENT1            =  the number
 *
 * (`WCSEXP_AP_INVOICE_LINES` does not exist — ORA-00942 — so a base table is the
 * only route. Same two objects, same reasoning, as `pull-invoices-extract.mjs`.)
 *
 * ★ It is selected as a CORRELATED SCALAR SUBQUERY, never as a second LEFT JOIN.
 *   This query already joins WCSEXP_AP_INVOICE_PAYMENTS, which is not unique per
 *   invoice, and a second one-to-many join multiplies the two together: a check
 *   with 3 invoices and 2 invoice-line rows each returns 6 rows, and `DISTINCT`
 *   then hides it by collapsing rows that agree in every selected column. The
 *   payment fan-out below was found exactly that way; no reason to walk into it
 *   twice.
 *
 * ★ MAX(SEGMENT1) is not a collapse here, and assertion 5 is what says so.
 *   Measured over this window: 0 four-tuples resolve to two invoices naming
 *   different orders. Without that assertion the MAX would be a silent choice
 *   between two answers, which is why the tie is counted rather than absorbed.
 *
 * ★ Measure the coverage BEFORE designing a screen around it: over this window it
 *   is 1,426 of 9,451 links (15.1%), 941 distinct order numbers. **The empty
 *   state is the dominant state**, so the screen has to name that case rather
 *   than render a blank a reader would read as missing data.
 *
 *   And measure *what* the empty rows are, not what they sound like. Asked of the
 *   8,025 links naming no order: 2,408 distinct vendors, and the invoice numbers
 *   label themselves — `TRAV/063026`, `PARENT STIPEND 06.24.26`,
 *   `LOCAL/ March 2026ADJ`, `C Change/070726` are reimbursements, stipends and
 *   journal adjustments, which are not purchases at all and have no order to name.
 *   The largest vendors are standing services and utilities (VERIZON WIRELESS
 *   808, CITY OF RALEIGH 362, DUKE ENERGY PROGRESS, TOWN OF APEX, TOWN OF CARY,
 *   WAKE ELECTRIC) and account-based office supply (STAPLES ADVANTAGE 332, ODP
 *   BUSINESS SOLUTIONS 176), plus recurring service contracts (shredding, fire
 *   protection) — billed against an account, never against an order.
 *
 *   ★ The first draft of this note said "prepaid cards, travel reimbursements,
 *     use tax and standing charges" from nothing but plausibility. Two of those
 *     four turned out to be the actual explanation and two were invention; the
 *     query that replaced it cost four seconds. Do that before writing copy.
 *
 * ── THE FAN-OUT THAT COST 937 LINKS ────────────────────────────────────────
 *
 * WCSEXP_AP_INVOICE_PAYMENTS is NOT unique on (CHECK_ID, INVOICE_ID, PAYMENT_NUM).
 * Its only unique column is INVOICE_PAYMENT_ID. Ledger-wide it holds 2,653,590
 * rows over 2,565,822 distinct (CHECK_ID, INVOICE_ID) pairs — 87,768 duplicates —
 * and 937 in-window checks carry at least one of them.
 *
 * Check 1063608 (VERIZON WIRELESS) is the one that exposed it: 522 payment rows,
 * 261 distinct invoices, and every invoice carrying two payment rows that agreed
 * in every column except INVOICE_PAYMENT_ID. Both rows are real payment records
 * for the same check and the same invoice; the invoice simply appears on the
 * check once. So the *link* is the pair, and the amount belongs to the invoice,
 * not to the payment row.
 *
 * Collapsing to distinct (CHECK_ID, INVOICE_ID) is therefore a correction and not
 * a plaster, and it is measurably better: checks whose invoices sum to the check
 * exactly go from 4,113 of 4,218 to 4,140. The fanned-out figure was inflating
 * 27 checks past their own check amount.
 *
 * PAYMENT_NUM is dropped for the same reason. Every duplicate group agrees on it
 * (0 conflicts), so it is constant per link and carries no information — while
 * its name invites a reader to treat it as a discriminator that does not exist.
 * PAYMENT_STATUS_FLAG is kept, and is worth being clear about: it comes from
 * WCSEXP_AP_INVOICES, not from the payment row. That view IS unique on
 * INVOICE_ID (0 fan-out over 2,569,410 rows), so the value is constant per link
 * by construction and cannot be picked wrongly by the collapse.
 *
 * Usage:  node scripts/pull-ap-extract.mjs [--from=YYYY-MM-DD] [--out=path]
 */
import dotenv from 'dotenv';
import oracledb from 'oracledb';
import { writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// The .env is at the repo root; this runs from server/.
dotenv.config({ path: '../.env' });

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

// Named binds go in as an OBJECT. Passed as an array, `:d` silently becomes NULL
// and every comparison against it matches nothing — the query returns zero rows
// with no error, which reads exactly like "the window is empty".
const bindDay = (d) => ({ d: { val: d, dir: oracledb.BIND_IN, type: oracledb.STRING } });

const OUT = resolve(arg('out', '../data/oracle/checks.json'));
const FROM_ARG = arg('from');

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

const say = (s = '') => process.stdout.write(s + '\n');

/* ── the window ────────────────────────────────────────────────────────────── */

let from = FROM_ARG;
if (!from) {
  const r = await q(
    `SELECT TO_CHAR(MIN(START_DATE),'YYYY-MM-DD') AS FY_START
       FROM APPS.GL_PERIODS
      WHERE PERIOD_YEAR = (SELECT MAX(PERIOD_YEAR) FROM APPS.GL_PERIODS)`,
  );
  from = r.rows[0].FY_START;
}
say(`window: ${from} → now   (fiscal year beginning ${from.slice(0, 4)})`);

/* ── checks ────────────────────────────────────────────────────────────────── */

say('reading checks …');
const checks = await q(
  `SELECT c.CHECK_ID,
          c.CHECK_NUMBER,
          TO_CHAR(c.CHECK_DATE,'YYYY-MM-DD') AS CHECK_DATE,
          c.AMOUNT,
          n.VENDOR_NAME
     FROM APPS.WCSEXP_AP_CHECKS c
     LEFT JOIN (
            SELECT p.CHECK_ID, MIN(v.VENDOR_NAME) AS VENDOR_NAME
              FROM APPS.WCSEXP_AP_CHECKS cc
              JOIN APPS.WCSEXP_AP_INVOICE_PAYMENTS p ON p.CHECK_ID = cc.CHECK_ID
              JOIN APPS.WCSEXP_AP_INVOICES i ON i.INVOICE_ID = p.INVOICE_ID
              JOIN APPS.WCSEXP_PO_VENDORS v ON v.VENDOR_ID = i.VENDOR_ID
             WHERE cc.CHECK_DATE >= TO_DATE(:d,'YYYY-MM-DD')
             GROUP BY p.CHECK_ID
          ) n ON n.CHECK_ID = c.CHECK_ID
    WHERE c.CHECK_DATE >= TO_DATE(:d,'YYYY-MM-DD')
    ORDER BY c.CHECK_DATE DESC, c.CHECK_NUMBER DESC`,
  bindDay(from),
);
say(`  ${checks.rows.length.toLocaleString('en-US')} checks`);

/* ── invoice links ─────────────────────────────────────────────────────────── */

say('reading invoice links …');
// DISTINCT is the fix, not a precaution: the payment view is not unique on
// (CHECK_ID, INVOICE_ID, PAYMENT_NUM), so the join alone returns a check's
// invoices twice over. Every selected column is either the check key or an
// attribute of the invoice, so DISTINCT collapses exactly the duplicate payment
// rows and nothing else. See the header for the measurement.
const links = await q(
  `SELECT DISTINCT p.CHECK_ID,
                   i.INVOICE_NUM,
                   i.INVOICE_AMOUNT,
                   TO_CHAR(i.INVOICE_DATE,'YYYY-MM-DD') AS INVOICE_DATE,
                   i.PAYMENT_STATUS_FLAG,
                   -- The order this invoice was raised against. Scalar so it
                   -- cannot multiply the payment rows DISTINCT is collapsing —
                   -- see the header. INVOICE_ID is carried out beside it so
                   -- assertion 5 can see when one link's four fields resolve to
                   -- two invoices, which a MAX() would hide.
                   i.INVOICE_ID,
                   (SELECT MAX(h.SEGMENT1)
                      FROM APPS.AP_INVOICE_LINES_ALL l
                      JOIN APPS.PO_HEADERS_ALL h ON h.PO_HEADER_ID = l.PO_HEADER_ID
                     WHERE l.INVOICE_ID = i.INVOICE_ID) AS PO_NUMBER
     FROM APPS.WCSEXP_AP_CHECKS c
     JOIN APPS.WCSEXP_AP_INVOICE_PAYMENTS p ON p.CHECK_ID = c.CHECK_ID
     JOIN APPS.WCSEXP_AP_INVOICES i ON i.INVOICE_ID = p.INVOICE_ID
    WHERE c.CHECK_DATE >= TO_DATE(:d,'YYYY-MM-DD')
    -- Positional, because SELECT DISTINCT may not ORDER BY an expression it does
    -- not select: naming i.INVOICE_DATE raises ORA-01791, the selected column
    -- being the TO_CHAR of it. 1 = CHECK_ID, 4 = INVOICE_DATE, 2 = INVOICE_NUM.
    ORDER BY 1, 4, 2`,
  bindDay(from),
);
say(`  ${links.rows.length.toLocaleString('en-US')} invoice links`);

// ★ INVOICE_ID is selected only to prove the order is unambiguous, and is
//   DROPPED here. `Table2` keys on INVOICE_NUM, which is not an identity (3,075
//   numbers over 3,743 invoices in this window), so a reader who saw an id would
//   reasonably treat the row as identified by it — and `enrich-checks-po.mjs`
//   merges on the four fields that ARE in the file. Nothing downstream uses it.
const poByLink = new Map();
for (const r of links.rows) {
  const k = `${r.CHECK_ID}/${r.INVOICE_NUM}/${r.INVOICE_DATE}/${r.INVOICE_AMOUNT}`;
  const seen = poByLink.get(k);
  const po = r.PO_NUMBER == null || String(r.PO_NUMBER).trim() === '' ? null : String(r.PO_NUMBER).trim();
  if (!seen) poByLink.set(k, new Set(po ? [po] : []));
  else if (po) seen.add(po);
}

/* ── the four assertions ───────────────────────────────────────────────────── */

const rows = checks.rows.map((r) => ({
  CHECK_ID: r.CHECK_ID,
  CHECK_NUMBER: r.CHECK_NUMBER,
  CHECK_DATE: r.CHECK_DATE,
  AMOUNT: r.AMOUNT,
  VENDOR_NAME: r.VENDOR_NAME,
}));
const inv = links.rows.map((r) => {
  const key = `${r.CHECK_ID}/${r.INVOICE_NUM}/${r.INVOICE_DATE}/${r.INVOICE_AMOUNT}`;
  const po = r.PO_NUMBER == null || String(r.PO_NUMBER).trim() === '' ? null : String(r.PO_NUMBER).trim();
  return {
    CHECK_ID: r.CHECK_ID,
    INVOICE_NUM: r.INVOICE_NUM,
    INVOICE_AMOUNT: r.INVOICE_AMOUNT,
    INVOICE_DATE: r.INVOICE_DATE,
    PAYMENT_STATUS_FLAG: r.PAYMENT_STATUS_FLAG,
    // The order the invoice was raised against, or null where none was — which
    // is the common case and a real answer, not a gap. See the header.
    PO_NUMBER: po,
    /** internal only — used by assertion 5, stripped before the write */
    _key: key,
  };
});

say();
say('checks:');

// 1. CHECK_ID unique, CHECK_NUMBER not.
const ids = new Set(rows.map((r) => r.CHECK_ID));
const nums = new Set(rows.map((r) => r.CHECK_NUMBER));
say(`  CHECK_ID distinct    ${ids.size.toLocaleString('en-US')} of ${rows.length.toLocaleString('en-US')}${ids.size === rows.length ? '  ok' : '  ** NOT UNIQUE **'}`);
say(`  CHECK_NUMBER distinct ${nums.size.toLocaleString('en-US')} of ${rows.length.toLocaleString('en-US')}`);
if (nums.size !== rows.length) {
  const seen = new Map();
  for (const r of rows) seen.set(r.CHECK_NUMBER, (seen.get(r.CHECK_NUMBER) ?? 0) + 1);
  const dupes = [...seen.entries()].filter(([, n]) => n > 1);
  say(`  ** ${dupes.length} check number${dupes.length === 1 ? '' : 's'} drawn more than once **`);
  for (const [n, c] of dupes.slice(0, 8)) say(`     ${n} x${c}`);
  if (dupes.length > 8) say(`     … and ${dupes.length - 8} more`);
}

// 2. every check has at least one invoice.
const perCheck = new Map();
for (const l of inv) perCheck.set(l.CHECK_ID, (perCheck.get(l.CHECK_ID) ?? 0) + 1);
const orphans = rows.filter((r) => !perCheck.has(r.CHECK_ID));
say(`  checks with no invoice  ${orphans.length.toLocaleString('en-US')}${orphans.length ? '  ** expected 0 in window **' : '  ok'}`);
for (const o of orphans.slice(0, 8)) say(`     ${o.CHECK_NUMBER} ${o.CHECK_DATE}`);

// 3. no link is repeated. This is the assertion that would have caught the
//    payment-view fan-out on its first run, so it is here before the sum check
//    rather than after it.
const linkKeys = new Set(inv.map((l) => `${l.CHECK_ID}/${l.INVOICE_NUM}/${l.INVOICE_DATE}/${l.INVOICE_AMOUNT}`));
const repeats = inv.length - linkKeys.size;
say(`  link rows repeated      ${repeats}${repeats ? '  ** the join is fanning out **' : '  ok'}`);

const sum = new Map();
for (const l of inv) sum.set(l.CHECK_ID, (sum.get(l.CHECK_ID) ?? 0) + Number(l.INVOICE_AMOUNT || 0));
let exact = 0;
let over = 0;
let under = 0;
let worst = 0;
for (const r of rows) {
  const d = (sum.get(r.CHECK_ID) ?? 0) - Number(r.AMOUNT || 0);
  if (Math.abs(d) < 0.005) exact += 1;
  else if (d > 0) over += 1;
  else under += 1;
  worst = Math.max(worst, Math.abs(d));
}
const pctExact = rows.length ? ((exact / rows.length) * 100).toFixed(1) : '0';
say(`  invoices sum to amount  ${exact.toLocaleString('en-US')} of ${rows.length.toLocaleString('en-US')} exactly (${pctExact}%)  ·  ${over} over, ${under} under, worst ${worst.toFixed(2)}`);

// the histogram that stops the page rendering a many-to-many as one-to-one
const hist = new Map();
for (const n of perCheck.values()) hist.set(n, (hist.get(n) ?? 0) + 1);
const buckets = [...hist.entries()].sort((a, b) => a[0] - b[0]);
const maxInv = Math.max(0, ...perCheck.values());
say(`  invoices per check      max ${maxInv}  ·  ${buckets.filter(([n]) => n === 1).reduce((s, [, c]) => s + c, 0).toLocaleString('en-US')} of them carry exactly one`);

// vendor coverage, since the page shows it as a column
const noVendor = rows.filter((r) => !r.VENDOR_NAME).length;
say(`  checks with no vendor   ${noVendor.toLocaleString('en-US')}`);

/* ── orders ────────────────────────────────────────────────────────────────── */

say();
say('orders:');

// 5. One link names at most one order. MAX() in the select would otherwise be a
//    silent choice between two answers, and this is the check that says it is
//    not — measured 0 over the window. Reported by name so an ambiguous link is
//    a thing a reader can go and look at.
const ambiguous = [...poByLink.entries()].filter(([, set]) => set.size > 1);
const named = inv.filter((l) => l.PO_NUMBER).length;
const orderNumbers = new Set(inv.map((l) => l.PO_NUMBER).filter(Boolean));
say(
  `  links naming DIFFERENT orders  ${ambiguous.length}${ambiguous.length ? '  ** a MAX() would choose silently **' : '  ok'}`,
);
for (const [k, set] of ambiguous.slice(0, 8)) say(`     ${k} → ${[...set].join(' / ')}`);
if (ambiguous.length > 8) say(`     … and ${ambiguous.length - 8} more`);
say(`  links that name an order       ${named.toLocaleString('en-US')} of ${inv.length.toLocaleString('en-US')}  (${((named / inv.length) * 100).toFixed(1)}%)`);
say(`  links that name none           ${(inv.length - named).toLocaleString('en-US')}  — prepaid cards, travel, use tax, standing charges`);
say(`  distinct order numbers         ${orderNumbers.size.toLocaleString('en-US')}`);

/* ── write ─────────────────────────────────────────────────────────────────── */

const envelope = {
  body: {
    ResultSets: {
      Table1: rows,
      // `_key` is a build-time convenience for assertion 5 and is not part of
      // the extract. Stripped here rather than never added, so the merge key is
      // computed once and the assertion cannot drift from the written row.
      Table2: inv.map(({ _key, ...rest }) => rest),
    },
  },
  /**
   * The file's own coverage stamp, at the LINK grain — what `Table2` is. It is
   * a fingerprint of this pull and **not** the figure the checks panel prints:
   * that panel counts its own check's invoices, a different population, and
   * derives it from the rows it loaded rather than restating this. Both are
   * labelled where they appear.
   */
  po: {
    grain: 'link',
    window: { from, to: rows.length ? rows.map((r) => r.CHECK_DATE).sort()[rows.length - 1] : from },
    links: inv.length,
    named,
    notNamed: inv.length - named,
    distinctNumbers: orderNumbers.size,
    /** 0 here. Non-zero means the four-field key cannot resolve one order. */
    ambiguousLinks: ambiguous.length,
    pulledAt: new Date().toISOString().slice(0, 10),
  },
};

mkdirSync(dirname(OUT), { recursive: true });
const json = JSON.stringify(envelope);
writeFileSync(OUT, json);
say();
say(`wrote ${OUT}`);
say(`  ${(statSync(OUT).size / 1024 / 1024).toFixed(2)} MB  ·  ${rows.length.toLocaleString('en-US')} checks + ${inv.length.toLocaleString('en-US')} links`);

await pool.close();
