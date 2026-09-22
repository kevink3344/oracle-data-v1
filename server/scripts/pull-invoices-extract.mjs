/**
 * Pull the AP invoices extract out of Oracle and into `data/oracle/invoices.json`.
 *
 * The mirror of `pull-ap-extract.mjs`. That one reads the payments register and
 * hangs the invoices it settled off each check; this one reads the invoices and
 * hangs the checks that settled each one. Same window rule, same two result sets,
 * same four-ish assertions, and — deliberately — the same refusals.
 *
 * ── WHY A SECOND EXTRACT RATHER THAN RE-USING `checks.json` ──────────────────
 *
 * The checks extract already carries 9,451 invoice links, so the tempting move is
 * to invert them. It does not work, and the measurement is in the header of probe
 * one: **`INVOICE_NUM` is not a key.** In this window 3,075 numbers are drawn
 * across 3,743 invoices, and 78 of the repeated numbers span more than one vendor
 * — `30JUN-2026SES` alone is drawn 142 times by 142 different vendors. The checks
 * extract carries no `INVOICE_ID`, because a check does not need one. So inverting
 * it would key 3,736 rows on a string that collides 668 times. `INVOICE_ID` is the
 * key, and only this view has it.
 *
 * ── WHY THE WINDOW HAS TWO ENDS ──────────────────────────────────────────────
 *
 * The checks extract bounds one end: `CHECK_DATE >= FY start`, because no check
 * exists beyond the latest one. Invoices do not behave that way. This window
 * contains seven invoices dated **2028, 2029, 2032, 2107, 2121, 3021 and 4602** —
 * all of them $0.00, all of them a date typed wrong at data entry, and one of them
 * dated the year 4602. Bounding only the start would put `9161000006/SEP20 …
 * 4602-09-26` at the TOP of a newest-first list and make the page look broken.
 *
 * So the window is the whole fiscal year, both ends derived from `GL_PERIODS`:
 *
 *     2026-07-01 → 2027-06-30      (PERIOD_YEAR 2027, 13 periods)
 *
 * The seven absurd dates fall outside it and are **excluded by that rule rather
 * than by a filter for absurdity** — which is the difference between a bound a
 * reader can check and a rule that quietly drops rows it does not like. Their
 * count and total are printed below, and the page states the window it covers.
 *
 * ── WHAT THIS EXTRACT CANNOT SAY, AND SAYS SO ───────────────────────────────
 *
 * 1. **It cannot split a check between invoices.** `WCSEXP_AP_INVOICE_PAYMENTS`
 *    has four columns — `INVOICE_PAYMENT_ID, INVOICE_ID, PAYMENT_NUM, CHECK_ID` —
 *    and none of them is money. So the link is a statement of *fact* (this check
 *    paid this invoice) with no magnitude, and when one invoice is settled by two
 *    checks the amount that went to each is not in these views at all. The only
 *    money figure at this grain is the invoice's own `AMOUNT_PAID`, which belongs
 *    to the invoice and not to any one check. Assertion 5 enforces that no link
 *    carries an amount, so the page cannot accidentally imply one.
 *
 * 2. **There is no invoice type.** `INVOICE_TYPE_LOOKUP_CODE` and `SOURCE` do not
 *    exist on this view (11 columns in total, probed). That matters because
 *    `docs/plans/menu-groups.md` §12-Q1 puts the credit-memo / non-item filter on
 *    this page — and it cannot be built from this data. The SIGN of the amount is
 *    the only signal available: 179 rows are negative, totalling −$162,922.21.
 *
 * 3. **`PO_HEADER_ID` is NULL on every row of the invoice** — 0 of 3,743
 *    populated in this window, and 0 of 2,569,410 across the whole view, which
 *    repeats the standing finding for `AP_INVOICES`. That column is therefore not
 *    the route to the order — but the order IS reachable, one grain down, and the
 *    extract reads it now. See “WHERE THE PURCHASE ORDER COMES FROM” below.
 *
 *    This paragraph used to end “so no invoice here can name its purchase order,
 *    and the page must not pretend otherwise”. The second half of that was true
 *    of *this column* and false of the account, which is the distinction that
 *    kept the feature unbuilt for two revisions: a column being empty is not the
 *    same fact as a relation being unexpressible.
 *
 * ── WHERE THE PURCHASE ORDER COMES FROM (added 2026-09-26) ──────────────────
 *
 * The obvious route — `WCSEXP_AP_INVOICES.PO_HEADER_ID → WCSEXP_PO_HEADERS`, the
 * same `PO_HEADER_ID` on both sides — returns nothing, for the reason §3 gives.
 * The order is not on the invoice **HEADER**. It is on the invoice **LINE**:
 *
 *     AP_INVOICE_LINES_ALL.PO_HEADER_ID
 *         → PO_HEADERS_ALL.PO_HEADER_ID
 *     PO_HEADERS_ALL.SEGMENT1   =   the purchase-order number
 *
 * ★ THIS IS THE ONE PLACE A PULL SCRIPT LEAVES THE `WCSEXP_*` VIEWS, AND IT IS
 *   NOT A PREFERENCE — IT IS THE ONLY ROUTE THAT EXISTS. `WCSEXP_AP_INVOICE_LINES`
 *   and `WCSEXP_AP_INVOICE_DISTRIBUTIONS` **do not exist**; both answer
 *   ORA-00942. That is not a typo being guessed at: the same family's
 *   `WCSEXP_PO_LINES` and `WCSEXP_PO_DISTRIBUTIONS` *do* exist, so it is
 *   specifically the invoice-line view that was never built. With no view at the
 *   line grain, a base table is the only way in, and it is used here for that
 *   reason and not because a base table was more convenient.
 *
 * Two columns ride in `Table1`, both as scalar subqueries in the invoice query:
 *
 *     PO_NUMBER   the order's number, NULL when the invoice names none
 *     PO_COUNT    how many DISTINCT orders the invoice names (0, and today 1)
 *
 * ★ `PO_COUNT` IS NOT DECORATION. `MAX()` over several rows is a **silent
 *   collapse**: the day an invoice carries two orders, `MAX` picks one and
 *   nothing anywhere reports that a choice was made. `PO_COUNT` is what turns
 *   “never two orders” from something `MAX` assumed into something this script
 *   proves — assertion 16 refuses to write the file when it is above 1.
 *
 * ★ AND THEY ARE SCALAR SUBQUERIES, NEVER A `LEFT JOIN`. The invoice query
 *   already `LEFT JOIN`s `WCSEXP_AP_INVOICE_PAYMENTS`, which is one-to-many; a
 *   second one-to-many join — to the invoice LINES — multiplies the two together
 *   (2 lines × 1 check = 2 payment rows), inflates `links`, and reports nothing.
 *   A scalar subquery cannot multiply rows, so the question is not raised.
 *
 * Measured before it was built, FY2027, in scope:
 *
 *     110 of the 126 invoices name an order    $4,921,015.73
 *      16 name none                            $  729,316.93
 *                                              -------------
 *                                              $5,650,332.66   = the scope's own total
 *
 *     and NO invoice names two: 110 × 1, 16 × 0, 0 × 2+      ·  88 distinct numbers
 *
 * The 16 that name none are a real answer and not missing data — prepaid cards,
 * travel reimbursements, use tax and standing charges, none of which is raised
 * against an order. They range from $0.00 and $23.00 to $2,488.42, and one of
 * them — `REIMB PRC JULY26` — is **$693,915.13**, so “no order” is emphatically
 * not the same statement as “no money”.
 *
 * Two things were checked that would have made the design wrong:
 *
 *   · `AP_INVOICE_DISTRIBUTIONS_ALL.PO_DISTRIBUTION_ID →
 *     PO_DISTRIBUTIONS_ALL.PO_HEADER_ID` resolves the SAME 110 invoices with the
 *     same zero multi-order cases — so the line route is not an artefact of one
 *     join path.
 *   · `PO_HEADERS_ALL.ATTRIBUTE4` is NULL throughout, which kills the obvious
 *     wrong guess about where the typed number might otherwise live.
 *
 * ★ WHAT THE NUMBER DOES NOT BUY: A LINK THAT ALWAYS WORKS. `full-output.json` —
 *   the purchase-order register this app serves — is **one school's orders**, not
 *   the ledger's: fund `04`, program `862`, cost centre `0840` (measured, and it
 *   is the register's cost centre on every one of its lines). Of the 88 order
 *   numbers these invoices name it holds **49**; of the 110 invoices that name an
 *   order it can open **62**. The 39 numbers it lacks mostly sit on a cost centre
 *   it does not carry (`0434`, `0830`, `0333`, `0810`, `0940`, `0825`, and three
 *   other funds — 35 of the 39) — and **4 of them have the register's own account
 *   pattern and are absent anyway**: `230558`, `248612`, `258188`, `265008`. No
 *   cause for those four was found, so none is published here; they are simply
 *   not in the file.
 *
 * So the extract carries the coverage and the absent numbers, and the page links
 * the orders the register holds and states the reason for the ones it does not.
 * That is the rule the account link below already follows: **a link that always
 * lands empty is a worse failure than a link that says why.**
 *
 * ── WHERE THE GL ACCOUNT COMES FROM (added 2026-09-19) ──────────────────────
 *
 * Neither `WCSEXP_AP_INVOICES` (11 columns) nor `invoices.json` (8 columns) has a
 * code combination on it. A reader asking "what account is this invoice booked
 * to?" cannot be answered from the register at all — and answering it from the
 * free text of `INVOICE_NUM` would be a text match, not a code match, which is
 * the one thing this app refuses to do.
 *
 * The account lives one join away, on the invoice's **distributions**:
 *
 *     WCSEXP_AP_INV_DISTRIBUTIONS.DIST_CODE_COMBINATION_ID
 *         → WCSEXP_GL_CODE_COMBINATIONS.CODE_COMBINATION_ID
 *
 * (The join key on the distribution is `DIST_CODE_COMBINATION_ID`; the view has
 * no `CODE_COMBINATION_ID` of its own. And there is no `CONCATENATED_SEGMENTS`
 * on the combinations view either — the seven segments are assembled with `.`
 * here and in the app, which is why `SEGMENT1..7` travel separately.)
 *
 * Measured before it was built, FY2027:
 *
 *     8,134 distributions   across 3,710 of the 3,736 invoices
 *     1,504 distinct combinations   →  5,347 distinct (invoice, combination) pairs
 *     904 invoices span MORE THAN ONE combination; the worst spans 251
 *      26 invoices have no distribution anywhere — 24 of them $0.00, and two
 *         that are real money ($23,356.76 and $5,208.50). Assertion 11 counts
 *         them by value, because "no account" on a $0 invoice and "no account" on
 *         a $23k invoice are not the same problem.
 *
 * **The distribution is folded up to one row per (invoice, combination).** The
 * grain is the pair, not the line: the question is which accounts an invoice is
 * booked to and for how much, and 8,134 lines carrying 5,347 answers is detail
 * nobody asked for. `DIST_ROWS` and `DIST_AMOUNT` are kept so the panel can say
 * "3 lines, $12,000" without the line list travelling.
 *
 * Assertion 10 is the one that matters: **the amounts of an invoice's accounts
 * must sum to the invoice.** 3,708 of the 3,710 invoices that have any
 * distribution tie exactly; the 2 that do not are reported rather than hidden.
 *
 * ── THE SCOPE, AND WHAT IT COSTS (added 2026-09-18) ─────────────────────────
 *
 * This extract is **deliberately not the whole register.** The pages it feeds are
 * fund 04, programs 861/862/863, and every other invoice is out of scope by
 * decision rather than by accident:
 *
 *     SEGMENT1 = '04'  AND  SEGMENT3 IN ('861','862','863')
 *
 * The predicate is tested against the invoice's **distributions** and joined back
 * to the invoice, so an invoice is kept when it is booked to at least one account
 * in scope — the invoice is the unit, the account is the evidence. A kept invoice
 * brings **all** of its distributions with it, including the ones outside the
 * scope, because a filtered account list would no longer sum to the invoice and
 * assertion 12 would start reporting faults that are not faults. Each account row
 * carries `IN_SCOPE` so the page can mark the outsiders rather than hide them.
 *
 * ★ THE SCOPE MUST BE ABLE TO SAY WHAT IT COST, so every invoice in the fiscal
 *   window is classified into one of three buckets and all three are measured:
 *
 *     IN_SCOPE       booked to at least one 04 / 861-863 account
 *     OUT_OF_SCOPE   has distributions, none of them in scope
 *     UNANSWERABLE   **no distribution at all** — there is no Fund and no
 *                    Program to test, so it is neither in nor out. 26 invoices
 *                    in FY2027, 24 of them $0.00, and two that are real money
 *                    ($23,356.76 and $5,208.50).
 *
 *   Those two real-money invoices are why the third bucket exists. Filing them
 *   under "excluded by scope" would put a $23,000 hole in the register behind a
 *   scoping rule, which is the one place nobody would look for it. The page
 *   states all three buckets.
 *
 * Nothing about the window itself changed: both ends still come from
 * `GL_PERIODS`, and assertion 8 still reports the sentinel dates it removes.
 *
 * Usage:  node scripts/pull-invoices-extract.mjs [--out=path] [--register=path]
 */
import dotenv from 'dotenv';
import oracledb from 'oracledb';
import { writeFileSync, mkdirSync, statSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// The .env is at the repo root; this runs from server/.
dotenv.config({ path: '../.env' });

const arg = (name, fallback = null) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

/**
 * Named binds go in as an OBJECT.
 *
 * Passed as an array, `:d1` silently becomes NULL, every comparison against it
 * matches nothing, and the query returns zero rows with no error — which reads
 * exactly like "the fiscal year is empty". This is a repeat of a mistake this
 * repo has already made once, so it is spelled out here as well as in the checks
 * script.
 *
 * ── AND WHY THE BINDS ARE CALLED `d1`/`d2` AND NOT `from`/`to` ────────────────
 *
 * `:from` raises **ORA-01745, invalid host/bind variable name**. `FROM` and `TO`
 * are SQL keywords, and a bind name is parsed as an identifier — so the two names
 * that read best are the two that cannot be used. Positional-ish names are the
 * cost of that, and the comment is here so nobody renames them back.
 */
const day = (v) => ({ val: v, dir: oracledb.BIND_IN, type: oracledb.STRING });

const OUT = resolve(arg('out', '../data/oracle/invoices.json'));

/**
 * The purchase-order register, read as a **sibling of the file being written**
 * rather than from a fixed path.
 *
 * The default is `data/oracle/full-output.json` — the file the pull in the repo
 * root writes and `app/scripts/sync-extract.mjs` renames to
 * `app/public/oracle/output.json` for the browser. Deriving it from `OUT` rather
 * than hard-coding it means a `--out` pointed at a build folder compares against
 * the register *beside it*, which is the only register whose numbers mean
 * anything for that file.
 *
 * ★ IT IS NOT READ FROM ORACLE, AND IT IS NOT FATAL WHEN IT IS MISSING. Two
 *   reasons: the coverage question is “what does **this app's** register hold”,
 *   which is a question about a file, not about a table; and an unreadable
 *   register must not stop an otherwise valid invoices extract being written —
 *   the page then offers no order link, which is the truthful thing to do with a
 *   coverage number it does not have. Assertion 17 reports the outcome either way.
 */
const REGISTER = resolve(arg('register', resolve(dirname(OUT), 'full-output.json')));

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
const N = (n) => Number(n ?? 0).toLocaleString('en-US');
/** Two decimals, always — a delta of `-0.005` rendered as `0` is a lie. */
const cash = (n) => Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/* ── the scope ─────────────────────────────────────────────────────────────── */

/**
 * Fund and program, in one place. Every query below derives its predicate from
 * this object, so widening the scope is one edit and cannot leave the invoice
 * query and the account query disagreeing about what "in scope" means.
 */
const SCOPE = {
  fund: '04',
  programs: ['861', '862', '863'],
};

/**
 * The predicate, against a named `WCSEXP_GL_CODE_COMBINATIONS` alias.
 *
 * Interpolated rather than bound. These are two literals in a generated script
 * with no user input anywhere near them, and a bound version would need five
 * binds (`:fund`, `:p1`, `:p2`, `:p3`) repeated in four queries — which is
 * exactly the kind of duplication that drifts. Binds stay what this file already
 * uses them for: the two window dates, where the value genuinely varies.
 */
const scopeOf = (a) =>
  `${a}.SEGMENT1 = '${SCOPE.fund}' AND ${a}.SEGMENT3 IN (${SCOPE.programs.map((p) => `'${p}'`).join(', ')})`;

/**
 * "This invoice is booked to at least one account in scope", as an EXISTS.
 *
 * A correlated subquery and never a list of ids: an `IN (…)` list is capped at
 * 1,000 expressions, and past that Oracle names an unrelated column as invalid
 * instead of complaining about the count. `sd`/`sg` are deliberately not `d`/`g`
 * — the accounts query already has distributions and combinations joined under
 * those names, and shadowing them inside its own WHERE would be a trap.
 */
const scopeExistsFor = (invoiceAlias) =>
  `EXISTS (SELECT 1
                                 FROM APPS.WCSEXP_AP_INV_DISTRIBUTIONS sd
                                 JOIN APPS.WCSEXP_GL_CODE_COMBINATIONS sg
                                   ON sg.CODE_COMBINATION_ID = sd.DIST_CODE_COMBINATION_ID
                                WHERE sd.INVOICE_ID = ${invoiceAlias}.INVOICE_ID
                                  AND ${scopeOf('sg')})`;

/** Failures here mean the file would be quietly wrong, so they stop the write. */
const fatal = [];

/* ── the window ────────────────────────────────────────────────────────────── */

// Both ends from the period table, never literals: a fiscal year that rolls over
// must move this file with it.
const fy = await q(
  `SELECT MIN(TO_CHAR(START_DATE,'YYYY-MM-DD')) AS FY_START,
          MAX(TO_CHAR(END_DATE,'YYYY-MM-DD'))   AS FY_END,
          MAX(PERIOD_YEAR)                      AS FY
     FROM APPS.GL_PERIODS
    WHERE PERIOD_YEAR = (SELECT MAX(PERIOD_YEAR) FROM APPS.GL_PERIODS)`,
);
const { FY_START: from, FY_END: to, FY: year } = fy.rows[0];
say(`window: FY${year}  ${from} → ${to}   (both ends derived from GL_PERIODS)`);

/* ── invoices ──────────────────────────────────────────────────────────────── */

say('reading invoices …');
const invoices = await q(
  `SELECT i.INVOICE_ID,
          i.INVOICE_NUM,
          TO_CHAR(i.INVOICE_DATE,'YYYY-MM-DD') AS INVOICE_DATE,
          i.INVOICE_AMOUNT,
          i.AMOUNT_PAID,
          i.PAYMENT_STATUS_FLAG,
          i.DESCRIPTION,
          v.VENDOR_NAME,
          -- The order, if this invoice was raised against one. See the header:
          -- the invoice's own PO_HEADER_ID is NULL on every row, the view for
          -- the invoice LINE does not exist, and these are scalar subqueries
          -- rather than joins because the payment join above is already
          -- one-to-many and a second one would multiply against it.
          (SELECT MAX(h.SEGMENT1)
             FROM APPS.AP_INVOICE_LINES_ALL l
             JOIN APPS.PO_HEADERS_ALL h ON h.PO_HEADER_ID = l.PO_HEADER_ID
            WHERE l.INVOICE_ID = i.INVOICE_ID) AS PO_NUMBER,
          -- The proof that the MAX() above picked rather than chose. 0 or 1 on
          -- every invoice measured; assertion 16 stops the write above 1.
          (SELECT COUNT(DISTINCT l.PO_HEADER_ID)
             FROM APPS.AP_INVOICE_LINES_ALL l
            WHERE l.INVOICE_ID = i.INVOICE_ID
              AND l.PO_HEADER_ID IS NOT NULL) AS PO_COUNT
     FROM APPS.WCSEXP_AP_INVOICES i
     LEFT JOIN APPS.WCSEXP_PO_VENDORS v ON v.VENDOR_ID = i.VENDOR_ID
    WHERE i.INVOICE_DATE >= TO_DATE(:d1,'YYYY-MM-DD')
      AND i.INVOICE_DATE <= TO_DATE(:d2,'YYYY-MM-DD')
      AND ${scopeExistsFor('i')}
    ORDER BY i.INVOICE_DATE DESC, i.INVOICE_ID DESC`,
  { d1: day(from), d2: day(to) },
);
say(`  ${N(invoices.rows.length)} invoices  (scoped to ${SCOPE.fund} / ${SCOPE.programs.join('-')})`);

/* ── the checks that paid them ─────────────────────────────────────────────── */

say('reading payment links …');
// DISTINCT, for the reason the checks extract documents at length: the payments
// view is NOT unique on (CHECK_ID, INVOICE_ID, PAYMENT_NUM) — its only unique
// column is the surrogate INVOICE_PAYMENT_ID, and it repeats 87,768 pairs
// ledger-wide. Joining it raw doubles the link list. Every selected column here is
// either a key or an attribute of the check, so DISTINCT collapses exactly the
// duplicate payment rows and nothing else.
const links = await q(
  `SELECT DISTINCT p.INVOICE_ID,
                   c.CHECK_ID,
                   c.CHECK_NUMBER,
                   TO_CHAR(c.CHECK_DATE,'YYYY-MM-DD') AS CHECK_DATE,
                   c.AMOUNT AS CHECK_AMOUNT
     FROM APPS.WCSEXP_AP_INVOICES i
     JOIN APPS.WCSEXP_AP_INVOICE_PAYMENTS p ON p.INVOICE_ID = i.INVOICE_ID
     JOIN APPS.WCSEXP_AP_CHECKS c ON c.CHECK_ID = p.CHECK_ID
    WHERE i.INVOICE_DATE >= TO_DATE(:d1,'YYYY-MM-DD')
      AND i.INVOICE_DATE <= TO_DATE(:d2,'YYYY-MM-DD')
      -- The same scope as the invoice query, spelled the same way. A link whose
      -- invoice is not in the file would be assertion 4's dangling link, and
      -- assertion 4 exists precisely because that failure looks like nothing.
      AND ${scopeExistsFor('i')}
    -- Positional: with SELECT DISTINCT, naming an expression the select list does
    -- not carry raises ORA-01791. 1 = INVOICE_ID, 4 = CHECK_DATE, 3 = CHECK_NUMBER.
    ORDER BY 1, 4, 3`,
  { d1: day(from), d2: day(to) },
);
say(`  ${N(links.rows.length)} payment links`);

/* ── the GL account each invoice is booked to ──────────────────────────────── */

say('reading account distributions …');
// ONE ROW PER (invoice, code combination) — see the header for why the grain is
// the pair and not the distribution line. The seven segments are selected whole
// rather than assembled, because the segment boundaries are the fact and the
// concatenation is a presentation of it; the view has no CONCATENATED_SEGMENTS.
//
// The join is re-applied to the invoice inside the query rather than fed a list
// of ids from the previous one. An `IN (…)` list is capped at 1,000 expressions
// and, past that, Oracle reports a **different, innocent-looking column** as
// invalid instead of complaining about the count. Nothing here enumerates ids.
//
// ★ The scope narrows WHICH INVOICES, never which of their accounts. The WHERE
//   keeps an invoice that has at least one in-scope account; the rows returned
//   for it are then ALL of its distributions. `IN_SCOPE` marks the ones that are
//   outside the scope so the page can say so. Filtering the accounts themselves
//   would break assertion 12 — the accounts would no longer sum to the invoice,
//   and the page would report a fault on every mixed invoice.
const accounts = await q(
  `SELECT d.INVOICE_ID,
          g.CODE_COMBINATION_ID,
          g.SEGMENT1, g.SEGMENT2, g.SEGMENT3, g.SEGMENT4,
          g.SEGMENT5, g.SEGMENT6, g.SEGMENT7,
          g.ACCOUNT_TYPE,
          CASE WHEN ${scopeOf('g')} THEN 'Y' ELSE 'N' END AS IN_SCOPE,
          COUNT(*) AS DIST_ROWS,
          SUM(d.AMOUNT) AS DIST_AMOUNT
     FROM APPS.WCSEXP_AP_INV_DISTRIBUTIONS d
     JOIN APPS.WCSEXP_AP_INVOICES i ON i.INVOICE_ID = d.INVOICE_ID
     JOIN APPS.WCSEXP_GL_CODE_COMBINATIONS g
       ON g.CODE_COMBINATION_ID = d.DIST_CODE_COMBINATION_ID
    WHERE i.INVOICE_DATE >= TO_DATE(:d1,'YYYY-MM-DD')
      AND i.INVOICE_DATE <= TO_DATE(:d2,'YYYY-MM-DD')
      AND ${scopeExistsFor('i')}
    GROUP BY d.INVOICE_ID, g.CODE_COMBINATION_ID,
             g.SEGMENT1, g.SEGMENT2, g.SEGMENT3, g.SEGMENT4,
             g.SEGMENT5, g.SEGMENT6, g.SEGMENT7, g.ACCOUNT_TYPE
    ORDER BY 1, 2`,
  { d1: day(from), d2: day(to) },
);
say(`  ${N(accounts.rows.length)} invoice→account rows`);

/* ── what the scope kept, and what it cost ─────────────────────────────────── */

say('measuring the scope …');
// ★ Three buckets, and the third one is the point. An invoice with no
// distribution has no Fund and no Program to test, so it is not "out of scope"
// — it is a question the register cannot answer, and it is where the only two
// real-money cases in the window live. Subtracting the scoped count from the
// window count would have merged those 26 into the 4,000-odd the scope genuinely
// removed.
//
// The CASE sits in an inner view and the outer query groups on its alias, because
// grouping directly over a WCSEXP_* view raises ORA-00979.
const scopeReport = await q(
  `SELECT BUCKET, COUNT(*) AS N, SUM(AMT) AS AMT
     FROM (SELECT CASE
                    WHEN NOT EXISTS (SELECT 1
                                       FROM APPS.WCSEXP_AP_INV_DISTRIBUTIONS d
                                      WHERE d.INVOICE_ID = x.INVOICE_ID) THEN 'UNANSWERABLE'
                    WHEN ${scopeExistsFor('x')} THEN 'IN_SCOPE'
                    ELSE 'OUT_OF_SCOPE'
                  END AS BUCKET,
                  x.INVOICE_AMOUNT AS AMT
             FROM (SELECT INVOICE_ID, INVOICE_AMOUNT
                     FROM APPS.WCSEXP_AP_INVOICES
                    WHERE INVOICE_DATE >= TO_DATE(:d1,'YYYY-MM-DD')
                      AND INVOICE_DATE <= TO_DATE(:d2,'YYYY-MM-DD')) x) b
    GROUP BY BUCKET
    ORDER BY 1`,
  { d1: day(from), d2: day(to) },
);

const bucketOf = (name) => {
  const hit = scopeReport.rows.find((r) => r.BUCKET === name);
  return { n: Number(hit?.N ?? 0), amt: Number(hit?.AMT ?? 0) };
};
const bucketIn = bucketOf('IN_SCOPE');
const bucketOut = bucketOf('OUT_OF_SCOPE');
const bucketNone = bucketOf('UNANSWERABLE');
const windowInvoices = bucketIn.n + bucketOut.n + bucketNone.n;
for (const r of scopeReport.rows) say(`  ${String(r.BUCKET).padEnd(14)} ${N(r.N).padStart(8)}  ·  ${cash(r.AMT).padStart(16)}`);
say(`  ${N(windowInvoices)} invoices in the window altogether`);

/* ── assertions ────────────────────────────────────────────────────────────── */

const rows = invoices.rows.map((r) => ({
  INVOICE_ID: r.INVOICE_ID,
  INVOICE_NUM: r.INVOICE_NUM,
  INVOICE_DATE: r.INVOICE_DATE,
  INVOICE_AMOUNT: r.INVOICE_AMOUNT,
  AMOUNT_PAID: r.AMOUNT_PAID,
  PAYMENT_STATUS_FLAG: r.PAYMENT_STATUS_FLAG,
  DESCRIPTION: r.DESCRIPTION,
  VENDOR_NAME: r.VENDOR_NAME,
  // NULL, never "" — absent is not blank, and the page tells the two apart. A
  // blank-or-whitespace number is normalised to NULL for the same reason: it is
  // not an order, and it must not render as one.
  PO_NUMBER: r.PO_NUMBER == null || String(r.PO_NUMBER).trim() === '' ? null : String(r.PO_NUMBER).trim(),
  PO_COUNT: Number(r.PO_COUNT ?? 0),
}));
const pay = links.rows.map((r) => ({
  INVOICE_ID: r.INVOICE_ID,
  CHECK_ID: r.CHECK_ID,
  CHECK_NUMBER: r.CHECK_NUMBER,
  CHECK_DATE: r.CHECK_DATE,
  CHECK_AMOUNT: r.CHECK_AMOUNT,
}));
const accts = accounts.rows.map((r) => ({
  INVOICE_ID: r.INVOICE_ID,
  CODE_COMBINATION_ID: r.CODE_COMBINATION_ID,
  SEGMENT1: r.SEGMENT1,
  SEGMENT2: r.SEGMENT2,
  SEGMENT3: r.SEGMENT3,
  SEGMENT4: r.SEGMENT4,
  SEGMENT5: r.SEGMENT5,
  SEGMENT6: r.SEGMENT6,
  SEGMENT7: r.SEGMENT7,
  ACCOUNT_TYPE: r.ACCOUNT_TYPE,
  IN_SCOPE: r.IN_SCOPE,
  DIST_ROWS: r.DIST_ROWS,
  DIST_AMOUNT: r.DIST_AMOUNT,
}));

say();
say('invoices:');

// 1. INVOICE_ID is the key. INVOICE_NUM is not, and the number of collisions is
//    reported rather than assumed away — it is the reason this file exists.
const ids = new Set(rows.map((r) => r.INVOICE_ID));
say(`  INVOICE_ID distinct     ${N(ids.size)} of ${N(rows.length)}${ids.size === rows.length ? '  ok' : '  ** NOT UNIQUE — the key is wrong **'}`);
if (ids.size !== rows.length) fatal.push('INVOICE_ID is not unique');

const nums = new Set(rows.map((r) => r.INVOICE_NUM));
say(`  INVOICE_NUM distinct    ${N(nums.size)} of ${N(rows.length)}  (${N(rows.length - nums.size)} collisions — the number is NOT a key)`);

const seenNum = new Map();
for (const r of rows) {
  const e = seenNum.get(r.INVOICE_NUM) ?? { n: 0, vendors: new Set() };
  e.n += 1;
  e.vendors.add(r.VENDOR_NAME);
  seenNum.set(r.INVOICE_NUM, e);
}
const repeated = [...seenNum.entries()].filter(([, e]) => e.n > 1);
const crossVendor = repeated.filter(([, e]) => e.vendors.size > 1);
say(`  numbers drawn twice+    ${N(repeated.length)}, of which ${N(crossVendor.length)} span MORE THAN ONE vendor`);
for (const [n, e] of repeated.sort((a, b) => b[1].n - a[1].n).slice(0, 5)) {
  say(`     ${String(n).padEnd(26)} x${e.n} across ${e.vendors.size} vendor(s)`);
}

// 2. The vendor join must not fan out. This is the assertion that catches the
//    class of bug this repo has already paid for once: a LEFT JOIN onto a view
//    that is not unique on its key multiplies the rows and nothing complains.
// ★ Counted through the SAME scope. The un-scoped window count would make this
//   differ by thousands and the assertion would report a fan-out that is really
//   just the scope doing its job — a false alarm loud enough to hide a real one.
const unjoined = await q(
  `SELECT COUNT(*) AS N
     FROM APPS.WCSEXP_AP_INVOICES i
    WHERE i.INVOICE_DATE >= TO_DATE(:d1,'YYYY-MM-DD')
      AND i.INVOICE_DATE <= TO_DATE(:d2,'YYYY-MM-DD')
      AND ${scopeExistsFor('i')}`,
  { d1: day(from), d2: day(to) },
);
const bare = Number(unjoined.rows[0].N);
const fanned = rows.length - bare;
say(`  vendor join fan-out     ${fanned}${fanned ? '  ** the join is fanning out **' : '  ok'}`);
if (fanned) fatal.push('the vendor join fans out — WCSEXP_PO_VENDORS is not unique on VENDOR_ID');

say();
say('payment links:');

// 3. No link repeated. The same self-check the checks extract now runs, and the
//    one that would have caught the payments-view fan-out on its first run.
const linkKeys = new Set(pay.map((l) => `${l.INVOICE_ID}/${l.CHECK_ID}`));
const repeats = pay.length - linkKeys.size;
say(`  link rows repeated      ${N(repeats)}${repeats ? '  ** the join is fanning out **' : '  ok'}`);
if (repeats) fatal.push('the payment link join fans out');

// 4. Node: the links must describe only invoices in the file, or the page will
//    render a check against a row the table does not hold.
const danglingLinks = pay.filter((l) => !ids.has(l.INVOICE_ID)).length;
say(`  links with no invoice   ${N(danglingLinks)}${danglingLinks ? '  ** dangling **' : '  ok'}`);
if (danglingLinks) fatal.push('links point at invoices not in the extract');

// 5. Structural: a link has no amount, because the view has none. If a future
//    edit adds one it is inventing a figure the database cannot supply, so this
//    counts as a failure rather than a warning.
const money = /AMOUNT|PAID|VALUE|TOTAL/i;
const withMoney = pay.filter((l) => Object.keys(l).some((k) => money.test(k) && k !== 'CHECK_AMOUNT'));
say(`  links carrying an amount ${N(withMoney.length)}${withMoney.length ? '  ** a link must not carry money **' : '  ok — a link says WHICH check, never HOW MUCH'}`);
if (withMoney.length) fatal.push('a payment link carries an amount');

// 6. What the money looks like at the invoice grain. `AMOUNT_PAID` is a real
//    column on the invoice, so unlike the link it CAN be compared — and if it
//    ever exceeded the invoice, the sum would be going the wrong way.
const buckets = { equal: 0, nullPaid: 0, zeroPaid: 0, partPaid: 0, exceeds: 0 };
let paidTotal = 0;
for (const r of rows) {
  const amount = Number(r.INVOICE_AMOUNT || 0);
  if (r.AMOUNT_PAID == null) buckets.nullPaid += 1;
  else {
    const p = Number(r.AMOUNT_PAID);
    paidTotal += p;
    if (Math.abs(p - amount) < 0.005) buckets.equal += 1;
    else if (p === 0) buckets.zeroPaid += 1;
    else if (p < amount) buckets.partPaid += 1;
    else buckets.exceeds += 1;
  }
}
const amountTotal = rows.reduce((s, r) => s + Number(r.INVOICE_AMOUNT || 0), 0);
say(`  amount paid = amount     ${N(buckets.equal)}`);
say(`  amount paid is NULL      ${N(buckets.nullPaid)}   <- "not recorded", which is not zero`);
say(`  amount paid is zero      ${N(buckets.zeroPaid)}`);
say(`  part paid                ${N(buckets.partPaid)}`);
say(`  paid EXCEEDS the invoice ${N(buckets.exceeds)}${buckets.exceeds ? '  ** impossible — check the join **' : '  ok'}`);
if (buckets.exceeds) fatal.push('an invoice is paid more than its own amount');
say(`  totals: ${amountTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })} invoiced`);

// 7. Invoices nobody paid. Counted, because a list that silently shows only paid
//    invoices answers a different question from the one the page asks.
const paidIds = new Set(pay.map((l) => l.INVOICE_ID));
const unpaid = rows.filter((r) => !paidIds.has(r.INVOICE_ID));
say(`  invoices with no check   ${N(unpaid.length)}  (listed, not hidden — the page shows them and says so)`);

// 8. What the fiscal-year bound actually removed, by count and by money. Excluded
//    by a stated rule, and the exclusion is printed rather than assumed.
const outside = await q(
  `SELECT COUNT(*) AS N, SUM(INVOICE_AMOUNT) AS AMT
     FROM APPS.WCSEXP_AP_INVOICES
    WHERE INVOICE_DATE > TO_DATE(:d2,'YYYY-MM-DD')`,
  { d2: day(to) },
);
say();
say('excluded by the year end:');
say(`  ${N(outside.rows[0].N)} invoices totalling ${Number(outside.rows[0].AMT ?? 0).toFixed(2)} — sentinel dates (2028 … 4602), all $0.00`);

// the histogram the page needs, since it renders the count as a column
const hist = new Map();
for (const l of pay) hist.set(l.INVOICE_ID, (hist.get(l.INVOICE_ID) ?? 0) + 1);
const counts = [...hist.values()];
const maxChecks = counts.length ? Math.max(...counts) : 0;
const multiCheck = counts.filter((n) => n > 1).length;
say();
say('invoices:');
say(`  checks per invoice      max ${maxChecks}  ·  ${N(multiCheck)} paid by more than one`);
say(`  credit rows             ${N(rows.filter((r) => Number(r.INVOICE_AMOUNT) < 0).length)}  ·  ${N(rows.filter((r) => !r.VENDOR_NAME).length)} with no vendor name`);

/* ── the account assertions ────────────────────────────────────────────────── */

say();
say('invoice → account:');

// 9. The grain. One row per (invoice, combination) is what the GROUP BY promises,
//    so a repeat means the grouping lost a column.
const pairKeys = new Set(accts.map((a) => `${a.INVOICE_ID}/${a.CODE_COMBINATION_ID}`));
const pairRepeats = accts.length - pairKeys.size;
say(`  (invoice, combination) repeated  ${N(pairRepeats)}${pairRepeats ? '  ** the grouping lost a column **' : '  ok'}`);
if (pairRepeats) fatal.push('an (invoice, code combination) pair appears more than once');

// 10. Every account row must already be an invoice in the file — and every
//     segment must be present, because the app assembles the key from them and a
//     NULL segment would silently drop the whole concatenation in Oracle's `||`.
const danglingAccounts = accts.filter((a) => !ids.has(a.INVOICE_ID)).length;
say(`  account rows with no invoice     ${N(danglingAccounts)}${danglingAccounts ? '  ** dangling **' : '  ok'}`);
if (danglingAccounts) fatal.push('an account row points at an invoice not in the extract');

const missingSegment = accts.filter(
  (a) => [a.SEGMENT1, a.SEGMENT2, a.SEGMENT3, a.SEGMENT4, a.SEGMENT5, a.SEGMENT6, a.SEGMENT7].some((s) => s === null || s === undefined),
).length;
say(`  rows with a NULL segment         ${N(missingSegment)}${missingSegment ? '  ** the key cannot be assembled **' : '  ok'}`);
if (missingSegment) fatal.push('an account row has a NULL segment');

// 11. The invoices the register cannot answer for. Printed by value, because a
//     $0 invoice with no distribution is unremarkable and a $23,000 one is a real
//     hole in the data — the count alone cannot tell them apart.
const withAccount = new Set(accts.map((a) => a.INVOICE_ID));
const noAccount = rows.filter((r) => !withAccount.has(r.INVOICE_ID));
const noAccountValue = noAccount.reduce((s, r) => s + Number(r.INVOICE_AMOUNT || 0), 0);
const noAccountReal = noAccount.filter((r) => Math.abs(Number(r.INVOICE_AMOUNT || 0)) >= 0.005);
say(`  invoices with NO account         ${N(noAccount.length)} of ${N(rows.length)}  ·  ${cash(noAccountValue)} between them`);
say(`     of which a non-zero amount    ${N(noAccountReal.length)}  ·  ${cash(noAccountReal.reduce((s, r) => s + Number(r.INVOICE_AMOUNT || 0), 0))}`);
for (const r of noAccountReal.slice(0, 4)) {
  say(`        ${String(r.INVOICE_NUM).slice(0, 28).padEnd(28)} ${cash(Number(r.INVOICE_AMOUNT))}`);
}

// 12. ★ THE RECONCILIATION. The accounts of an invoice must sum to the invoice.
//     If this ever drifts, the fold is dropping or double-counting distributions
//     and every figure downstream of it is decoration.
const sumByInvoice = new Map();
for (const a of accts) sumByInvoice.set(a.INVOICE_ID, (sumByInvoice.get(a.INVOICE_ID) ?? 0) + Number(a.DIST_AMOUNT || 0));
const tied = [...sumByInvoice.entries()].filter(([id, sum]) => {
  const inv = rows.find((r) => r.INVOICE_ID === id);
  return inv && Math.abs(sum - Number(inv.INVOICE_AMOUNT || 0)) < 0.005;
}).length;
const untied = sumByInvoice.size - tied;
say(`  accounts sum to the invoice      ${N(tied)} of ${N(sumByInvoice.size)}${untied ? `  ·  ${N(untied)} do not` : '  ok'}`);
const worstAcct = [...sumByInvoice.entries()]
  .map(([id, sum]) => {
    const inv = rows.find((r) => r.INVOICE_ID === id);
    return { id, num: inv?.INVOICE_NUM ?? '?', inv: Number(inv?.INVOICE_AMOUNT || 0), sum, delta: sum - Number(inv?.INVOICE_AMOUNT || 0) };
  })
  .filter((x) => Math.abs(x.delta) >= 0.005)
  .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
for (const x of worstAcct.slice(0, 5)) {
  say(`        ${String(x.num).slice(0, 26).padEnd(26)} invoice ${cash(x.inv).padStart(14)}  accounts ${cash(x.sum).padStart(14)}  delta ${cash(x.delta).padStart(13)}`);
}
if (worstAcct.length) say('     (reported, not fatal — the register and the distributions are two views of one document)');

// 13. How many invoices span more than one account, and what the account types
//     are. `ACCOUNT_TYPE` is NOT uniform: most combinations are expense, but the
//     single most-drawn combination in the window is an ASSET account, so a page
//     that assumed "expense" would mislabel the busiest row on it.
const combosPerInvoice = new Map();
for (const a of accts) combosPerInvoice.set(a.INVOICE_ID, (combosPerInvoice.get(a.INVOICE_ID) ?? 0) + 1);
const multiAccount = [...combosPerInvoice.values()].filter((n) => n > 1).length;
const maxAccounts = Math.max(0, ...combosPerInvoice.values());
say(`  invoices spanning >1 account     ${N(multiAccount)}  ·  worst spans ${N(maxAccounts)}`);
say(`  distinct combinations            ${N(new Set(accts.map((a) => a.CODE_COMBINATION_ID)).size)}`);
const byType = new Map();
for (const a of accts) byType.set(a.ACCOUNT_TYPE, (byType.get(a.ACCOUNT_TYPE) ?? 0) + 1);
for (const [t, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
  say(`     account_type ${t}  ${N(n)} row(s)`);
}

/* ── the scope assertions ──────────────────────────────────────────────────── */

say();
say(`scope  (fund ${SCOPE.fund} · programs ${SCOPE.programs.join('/')}):`);

// 14. ★ The scope holds in both directions. Every invoice in the file must have at
//     least one in-scope account, because that predicate is the only thing that put
//     it there; and the count the report measured must equal the count the file
//     holds. A violation means the invoice query and the account rows disagree —
//     and the page would then render an invoice whose stated reason for being on
//     it is missing from its own panel.
const inScopeAccounts = new Map();
for (const a of accts) {
  if (a.IN_SCOPE === 'Y') inScopeAccounts.set(a.INVOICE_ID, (inScopeAccounts.get(a.INVOICE_ID) ?? 0) + 1);
}
const scopedIn = rows.filter((r) => inScopeAccounts.has(r.INVOICE_ID)).length;
say(`  invoices with an account in scope ${N(scopedIn)} of ${N(rows.length)}${scopedIn === rows.length ? '  ok' : '  ** an invoice is in the file with nothing in scope **'}`);
if (scopedIn !== rows.length) fatal.push('an invoice in the extract has no in-scope account');

const reportAgrees = bucketIn.n === rows.length;
say(`  report agrees with the file       ${N(bucketIn.n)} vs ${N(rows.length)}${reportAgrees ? '  ok' : '  ** the scope report and the invoice query disagree **'}`);
if (!reportAgrees) fatal.push('the scope report and the invoice query disagree about the in-scope count');

// 15. What the scope cost, by count AND by money. The two real exclusions are
//     printed together; the unanswerable bucket is printed separately and
//     labelled, because "we removed it" and "we cannot decide it" are different
//     sentences and only the second one has real money behind it.
const offScopeAccts = accts.filter((a) => a.IN_SCOPE !== 'Y');
const offScopeValue = offScopeAccts.reduce((s, a) => s + Number(a.DIST_AMOUNT || 0), 0);
const offScopeInvoices = new Set(offScopeAccts.map((a) => a.INVOICE_ID)).size;
say(`  excluded, other fund/program     ${N(bucketOut.n).padStart(7)}  ·  ${cash(bucketOut.amt).padStart(16)}  (has distributions, none of them in scope)`);
say(`  excluded, nothing to test        ${N(bucketNone.n).padStart(7)}  ·  ${cash(bucketNone.amt).padStart(16)}  <- no distribution: neither in nor out`);
say(`  window total                     ${N(windowInvoices).padStart(7)}`);
say(`  kept invoices also drawing an out-of-scope account`);
say(`     ${N(offScopeInvoices)} invoice(s)  ·  ${N(offScopeAccts.length)} account row(s)  ·  ${cash(offScopeValue)}`);
say('     (kept deliberately: the invoice is in scope, and dropping its other accounts would break assertion 12)');

/* ── the purchase order ────────────────────────────────────────────────────── */

say();
say('purchase orders:');

// 16. ★ NO INVOICE NAMES TWO ORDERS — AND THAT IS ASSERTED, NOT ASSUMED BY A
//     MAX(). `PO_NUMBER` is `MAX(SEGMENT1)` over the invoice's lines, which is a
//     silent collapse the moment an invoice carries two orders: one number comes
//     back, a different one goes unmentioned, and every count downstream of it
//     is quietly about a subset. So a non-zero count here is **fatal** rather
//     than reported — the column has to move to the account row before this file
//     is written again.
//
//     The two coverage figures are asserted against the scope's own total as
//     well, and that is the assertion with teeth: if a later scope change ever
//     stopped the pull covering what the register is made of, the two buckets
//     would stop summing to `inScopeValue` while every other number in this
//     script went on looking perfectly healthy.
const poPerInvoice = new Map();
for (const r of rows) poPerInvoice.set(r.INVOICE_ID, r.PO_COUNT);
const maxPerInvoice = Math.max(0, ...poPerInvoice.values());
const invoicesWithMore = [...poPerInvoice.values()].filter((n) => n > 1).length;
const named = rows.filter((r) => r.PO_NUMBER !== null);
const notNamed = rows.filter((r) => r.PO_NUMBER === null);
const namedValue = named.reduce((s, r) => s + Number(r.INVOICE_AMOUNT || 0), 0);
const notNamedValue = notNamed.reduce((s, r) => s + Number(r.INVOICE_AMOUNT || 0), 0);
const scopeValueNow = rows.reduce((s, r) => s + Number(r.INVOICE_AMOUNT || 0), 0);
const distinctNumbers = new Set(named.map((r) => r.PO_NUMBER));

say(`  orders per invoice       max ${N(maxPerInvoice)}  ·  ${N(invoicesWithMore)} invoice(s) naming more than one${invoicesWithMore ? '  ** MAX() is now a choice, not a fact **' : '  ok — the number is the order'}`);
if (invoicesWithMore) fatal.push('an invoice names more than one purchase order — PO_NUMBER is a MAX() collapse');

say(`  naming an order          ${N(named.length).padStart(7)}  ·  ${cash(namedValue).padStart(16)}`);
say(`  naming none              ${N(notNamed.length).padStart(7)}  ·  ${cash(notNamedValue).padStart(16)}  <- a real answer: prepaid cards, travel, use tax, standing charges`);
say(`  distinct order numbers   ${N(distinctNumbers.size)}`);

const poCovered = Math.abs(namedValue + notNamedValue - scopeValueNow) < 0.005;
say(`  the two cover the scope  ${cash(namedValue + notNamedValue)} vs ${cash(scopeValueNow)}${poCovered ? '  ok' : '  ** the purchase-order coverage no longer adds up to the file **'}`);
if (!poCovered) fatal.push("the purchase-order coverage does not sum to the extract's own in-scope value");

// The largest invoice that names no order, read off the rows rather than recalled:
// "16 invoices name no order" reads like small change until one of them is
// $693,915.13, and a figure typed in from memory is the kind that goes stale
// without anyone noticing which pull it came from.
const biggestUnnamed = notNamed.reduce(
  (best, r) => (best === null || Math.abs(Number(r.INVOICE_AMOUNT || 0)) > Math.abs(Number(best.INVOICE_AMOUNT || 0)) ? r : best),
  null,
);
if (biggestUnnamed) {
  say(`     the largest of them is ${String(biggestUnnamed.INVOICE_NUM).slice(0, 26)} at ${cash(Number(biggestUnnamed.INVOICE_AMOUNT))} — "no order" is not "no money"`);
}

// 17. What the register BESIDE this file holds, and what it does not.
//
//     ★ A CROSS-FILE NUMBER, AND IT CANNOT BE ANYTHING ELSE. The register this
//     app serves is one school's orders — fund 04, program 862, cost centre 0840
//     — and it is produced by a different pull (and served live by the API), so
//     this compares against the register **file on disk** and stamps that file's
//     own fingerprint (line count, newest date, its scope) beside the counts. A
//     re-pull of one without the other is the hazard, and the fingerprint is what
//     makes the drift visible instead of silent.
//
//     Reported, never fatal: the register is a different file. If it cannot be
//     read the invoices extract is still valid — the page then offers no order
//     link, because a link is a claim about a register the file does not have.
const register = (() => {
  try {
    const doc = JSON.parse(readFileSync(REGISTER, 'utf8'));
    const lineRows = doc?.body?.ResultSets?.Table1;
    if (!Array.isArray(lineRows) || lineRows.length === 0) {
      return { error: 'it carries no body.ResultSets.Table1' };
    }
    const key = (v) => String(v ?? '').trim();
    const dates = lineRows.map((r) => key(r.ORDER_DATE)).filter(Boolean).sort();
    const uniq = (k) => [...new Set(lineRows.map((r) => key(r[k])).filter(Boolean))].sort();
    return {
      lineRows,
      uniq,
      numbers: new Set(lineRows.map((r) => key(r.ORDER_NUMBER)).filter(Boolean)),
      maxDate: (dates[dates.length - 1] ?? '').slice(0, 10),
    };
  } catch (err) {
    return { error: err.message };
  }
})();

let invoicesInRegister = null;
let invoicesNotInRegister = null;
let invoicesInRegisterValue = null;
let invoicesNotInRegisterValue = null;
let numbersInRegister = null;
let numbersNotInRegister = null;
let absentFromRegister = [];
let registerBlock = null;

if (register.error) {
  say(`  the register beside this file  ** unreadable **  ${REGISTER}`);
  say(`     ${register.error}`);
  say('     (reported, not fatal — the extract is still valid; the page will link no order rather than link a claim it cannot keep)');
} else {
  const absent = [...distinctNumbers].filter((n) => !register.numbers.has(n)).sort();
  absentFromRegister = absent;
  numbersInRegister = distinctNumbers.size - absent.length;
  numbersNotInRegister = absent.length;
  invoicesInRegister = named.filter((r) => register.numbers.has(r.PO_NUMBER)).length;
  invoicesNotInRegister = named.length - invoicesInRegister;

  // The two halves by VALUE, not only by count — because the sentence the panel
  // has to write is "$X of it is on the register", and a count of invoices cannot
  // be turned into that. Summed from the rows just partitioned, so the pair always
  // equals `namedValue`.
  const registerHeld = named.filter((r) => register.numbers.has(r.PO_NUMBER));
  const registerLacked = named.filter((r) => !register.numbers.has(r.PO_NUMBER));
  invoicesInRegisterValue = registerHeld.reduce((s, r) => s + Number(r.INVOICE_AMOUNT || 0), 0);
  invoicesNotInRegisterValue = registerLacked.reduce((s, r) => s + Number(r.INVOICE_AMOUNT || 0), 0);

  registerBlock = {
    lines: register.lineRows.length,
    orders: register.numbers.size,
    maxDate: register.maxDate,
    fund: register.uniq('FUND'),
    program: register.uniq('PROGRAM'),
    costCenters: register.uniq('COST_CENTER'),
  };

  say(`  the register holds       ${N(invoicesInRegister).padStart(7)} of the ${N(named.length)} invoice(s) that name one  ·  ${N(numbersInRegister)} of ${N(distinctNumbers.size)} number(s)`);
  say(`  the register does not    ${N(invoicesNotInRegister).padStart(7)} invoice(s)  ·  ${N(numbersNotInRegister)} number(s)  <- stated on the page, never linked`);
  say(`     by value: ${cash(invoicesInRegisterValue)} openable  ·  ${cash(invoicesNotInRegisterValue)} not  ·  ${cash(invoicesInRegisterValue + invoicesNotInRegisterValue)} = every invoice that names an order`);
  say(`  register, as read        ${N(registerBlock.orders)} order(s) over ${N(registerBlock.lines)} line(s), newest ${registerBlock.maxDate || '?'}`);
  say(`     its scope: fund ${registerBlock.fund.join('/')} · program ${registerBlock.program.join('/')} · cost centre ${registerBlock.costCenters.join('/')}`);
  for (const n of absent.slice(0, 6)) say(`        not in the register: ${n}`);
  if (absent.length > 6) say(`        … and ${N(absent.length - 6)} more`);
  if (!register.maxDate) say('     ** the register carries no ORDER_DATE — the fingerprint cannot date itself **');
}

/**
 * What the page needs in order to link an order or explain why it cannot.
 *
 * Every count is named for what it counts — invoices or order numbers — because
 * those two are 110 and 88 here and a bare `count` would be read as whichever one
 * the reader had in mind.
 */
const poBlock = {
  named: named.length,
  notNamed: notNamed.length,
  namedValue,
  notNamedValue,
  maxPerInvoice,
  invoicesWithMore,
  distinctNumbers: distinctNumbers.size,
  invoicesInRegister,
  invoicesNotInRegister,
  /** Named invoices whose order the register holds, and their value. */
  invoicesInRegisterValue,
  /** Named invoices whose order it does not, and their value. */
  invoicesNotInRegisterValue,
  numbersInRegister,
  numbersNotInRegister,
  /** The numbers the register lacks. This is what lets the page state a miss. */
  absentFromRegister,
  /**
   * The largest invoice naming no order, with its own identity on it.
   *
   * Carried as DATA rather than written into the panel's prose, because
   * "16 invoices name no order" reads like small change until one of them is
   * $693,915.13 — and a figure typed into a sentence is the kind that goes stale
   * the moment the window moves, silently and with no pull to blame.
   */
  largestNotNamed: biggestUnnamed
    ? {
        number: String(biggestUnnamed.INVOICE_NUM ?? '').trim() || null,
        value: Number(biggestUnnamed.INVOICE_AMOUNT || 0),
        invoiceId: biggestUnnamed.INVOICE_ID,
      }
    : null,
  /** The register as it was when this file was written. `null` when unreadable. */
  register: registerBlock,
};

/* ── write ─────────────────────────────────────────────────────────────────── */

if (fatal.length) {
  say();
  say('** REFUSING TO WRITE **');
  for (const f of fatal) say(`   ${f}`);
  await pool.close();
  process.exit(1);
}

const envelope = {
  body: {
    ResultSets: {
      Table1: rows,
      Table2: pay,
      // One row per (invoice, code combination). Small — 5,347 rows against the
      // invoices' 3,736 — and the reason the page can answer "what account is
      // this booked to?" at all.
      Table3: accts,
    },
  },
  // The window travels with the file so the page reports its own bounds rather
  // than restating a literal that a later run would make a lie.
  window: { from, to, fiscalYear: year },
  // ★ And so does the SCOPE. A page cannot honestly say what it is showing if the
  //   rule that shaped the file lives only in this script's source — and the three
  //   buckets below are the whole difference between "the fund-04 program
  //   861-863 register" and "the register, minus some rows nobody mentioned".
  scope: {
    fund: SCOPE.fund,
    programs: [...SCOPE.programs],
    label: `Fund ${SCOPE.fund} · program ${SCOPE.programs.join('/')}`,
    /** Every invoice in the fiscal window, before the scope was applied. */
    windowInvoices,
    /** Invoices the file holds. `rows.length` and never the report's count. */
    inScope: rows.length,
    inScopeValue: rows.reduce((s, r) => s + Number(r.INVOICE_AMOUNT || 0), 0),
    /** Has distributions; none of them in scope. A real exclusion. */
    excluded: bucketOut.n,
    excludedValue: bucketOut.amt,
    /**
     * No distribution at all, so there is no Fund and no Program to test. Not
     * an exclusion — a question the register cannot answer — and where the only
     * two real-money invoices in the window live.
     */
    unanswerable: bucketNone.n,
    unanswerableValue: bucketNone.amt,
    /**
     * Accounts on KEPT invoices that are themselves outside the scope. Carried so
     * the page can mark them rather than silently presenting an out-of-scope code
     * as part of the fund-04 picture.
     */
    accountsOffScope: offScopeAccts.length,
    accountsOffScopeValue: offScopeValue,
    accountsOffScopeInvoices: offScopeInvoices,
  },
  // ★ AND SO DOES THE ORDER. A reader looking at an invoice needs to know whether
  //   the order number they can see is one this app can open, and that is not a
  //   question about Oracle — it is a question about the register file beside
  //   this one. Stamping the answer here is what keeps the page from fetching
  //   2 MB of register to decide, and `absentFromRegister` is what lets it state a
  //   miss instead of rendering a link that lands on nothing.
  //
  //   `register` is the fingerprint of the file that was read, so a re-pull of one
  //   file without the other shows up as a dated mismatch rather than as numbers
  //   that are quietly about a register nobody is looking at any more.
  po: poBlock,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(envelope));
say();
say(`wrote ${OUT}`);
say(`  ${(statSync(OUT).size / 1024 / 1024).toFixed(2)} MB  ·  ${N(rows.length)} of ${N(windowInvoices)} window invoices (${SCOPE.fund} / ${SCOPE.programs.join('-')}) + ${N(pay.length)} links + ${N(accts.length)} account rows`);

await pool.close();
