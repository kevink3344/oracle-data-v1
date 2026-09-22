import { Router } from 'express';
import { IntParam, z } from '../http/z.js';
import { createApi } from '../http/api.js';
import { AppError } from '../http/errors.js';
import { db, storeDriver } from '../db/client.js';
import { defaultTenant } from '../auth/session.js';
import { fiscalFloor, scopeClause } from './extract.js';
import { date, flag, intReq, real, realReq, text, textReq } from '../schemas/columns.js';

/**
 * Vendor sites — the address level under a company, as a *register* and not a directory.
 *
 * ─── WHAT THIS ENDPOINT IS, AND WHY IT IS NOT THE SITES TABLE ────────────────
 *
 * `PO_VENDOR_SITES_ALL` holds **99,316 rows across 79,590 vendors** on this
 * instance: every address any vendor has ever registered. List that and a screen
 * becomes unusable, because the interesting question at this level is not "what
 * addresses exist" but **"where was this organization's money actually sent"**.
 *
 * So this endpoint answers the second question. It returns the sites **named by an
 * in-scope purchase order** — one row per site, with the site's address, its vendor,
 * how many in-scope orders named it, and the committed dollars on those orders.
 *
 * ★ THE SCOPE IS THE EXTRACT'S SCOPE, NOT A SECOND ONE, AND THAT IS ENFORCED IN CODE
 *   RATHER THAN BY A COMMENT. `scopeClause()` is imported from `routes/extract.ts`
 *   and interpolated here, so the fund / program / fiscal-floor predicate has one
 *   definition in the repository. The two readers sit at different grains — the
 *   extract reads distributions, this reads (site, order) pairs — and two strings
 *   kept in step by a comment would eventually stop being the same scope, at which
 *   point every figure on this screen would silently describe a different population
 *   from the one the Dashboard reports.
 *
 *   Measured through `scopeClause` on the shipped organization (fund `04`, programs
 *   `861`/`862`/`863`, fiscal floor `2021-07-01`, i.e. `start_fy = 2022`):
 *
 *     this endpoint, (site, order) grain     5,692 orders · 800 sites · 715 vendors · $2,797,825,956.73
 *     the extract, distribution grain       31,670 rows   · 5,692 orders · 31,401 lines · same amount
 *
 *   The two totals agree to the cent and the order count is identical, because an
 *   order's in-scope lines are the same money seen at two grains — that identity is
 *   the property that licenses this endpoint to state an order count at all. The
 *   extract reads 31,670 distribution rows to this endpoint's 31,401 distinct lines,
 *   because a line can carry more than one distribution.
 *
 * ★ THE ROW COUNT IS A FUNCTION OF THE TENANT, NOT A CONSTANT — the same warning
 *   `fiscalFloor()` carries, and the reason this file quotes its scope in words rather
 *   than as a bare number. The identical pair query, same fund and same programs, at
 *   the *previous* fiscal floor:
 *
 *     floor 2021-07-01 (`start_fy = 2022`)   5,692 orders · 800 sites · $2,797,825,956.73
 *     floor 2022-07-01 (`start_fy = 2023`)   4,206 orders · 704 sites · $2,697,813,470.53
 *
 *   ★ THAT SECOND LINE IS A WARNING ABOUT PROBES, NOT ABOUT THE PRODUCT. An earlier
 *   draft of this file — and every figure in its first description — was measured with
 *   the predicate hard-coded to programs `861`/`862` at floor `2022-07-01`, which is a
 *   scope this organization has never had. Those numbers looked authoritative
 *   precisely because they had been written down. Nothing failed; they described a
 *   different population. A probe must derive its predicate from `scopeClause()` and
 *   `defaultTenant()`, or it measures a screen that does not ship.
 *
 * ─── ★ THE 'DEPRECATED' TAB AND THE FINDING THAT SHAPED IT ──────────────────
 *
 * The screen splits these sites into an **Active** and a **Deprecated** tab. The
 * natural rule for "deprecated" is the site code: Oracle shops park the literal
 * text `DO NOT USE` in `VENDOR_SITE_CODE` for a site nobody should pick again.
 *
 * ★ MEASURED: THAT RULE MATCHES **ZERO** OF THE 800 REGISTER SITES. Not one code in
 *   this scope contains `DONOTUSE` — not before normalising, and not after stripping
 *   spaces, dashes and underscores and upper-casing. A `DO NOT USE` tab built on the
 *   code would render empty, on a page whose entire premise is that the money went
 *   *there*. The reason is a property of the data rather than a bug:
 *
 *     directory sites whose code is DO-NOT-USE-shaped        669
 *     …of those, across how many vendors                    567
 *     …of those, named by any purchase order                342
 *     …of those, named by an IN-SCOPE order                   0
 *
 *   Every one of the 669 is excluded before the register is built. **A scope that is
 *   narrow enough to be useful is also narrow enough to exclude a whole class of
 *   row**, and this endpoint's `directory` block reports that class so a client can
 *   say *why* the tab is not the size a reader might expect.
 *
 * Three other signals were measured against the register and are what actually
 * deprecate a site here. A site is deprecated when **any** of them fires, and each
 * row names the ones that did — returned, never inferred, because the same site can
 * carry more than one (`VENDOR_SITE_ID 12364` carries all three):
 *
 *   not a purchasing site   PURCHASING_SITE_FLAG = 'N'            6 sites ·  108 orders · $4,829,603.18
 *   retired                 INACTIVE_DATE IS NOT NULL           35 sites ·  219 orders · $38,199,948.83
 *   do-not-use vendor name  the vendor is named DO NOT USE       1 site  ·   81 orders · $4,433,380.94
 *
 *   union of the three                                          39 sites ·  243 orders · $38,567,580.12
 *   active                                                     761 sites · 5,449 orders · $2,759,258,376.61
 *                                                              ─────────────────────────────────────────
 *                                                              800 sites · 5,692 orders · $2,797,825,956.73
 *
 *   The signal counts sum to 42 sites and 408 orders against a union of 39 and 243,
 *   because the signals are not disjoint — the overlaps are real and are the reason
 *   a row carries a *list* of reasons instead of one. Three sites carry more than one:
 *   37 carry exactly one reason, one carries two, and one carries all three.
 *
 * ★ DEPRECATED IS A DESCRIPTION, NOT AN EXCLUSION, AND THE FIGURES ABOVE ARE WHY.
 *   The 39 sites carry **243 real orders and $38.6M of committed money**. Site 12364
 *   alone — the one row in the register whose *vendor* is literally named
 *   `DO NOT USE - PERFECTION EQUIPMENT CO INC`, and the only row where all three
 *   signals coincide — carries 81 orders worth $4,433,380.94. A tab named
 *   "Deprecated" that dropped these rows from the page's totals would delete money
 *   from a screen about money. They are separated for readability and summed into
 *   every total the endpoint returns.
 *
 * ─── WHAT THIS ENDPOINT REFUSES TO DO ────────────────────────────────────────
 *
 *   - It does not read `PO_DISTRIBUTIONS_ALL`. `AMOUNT_ORDERED` is NULL on these
 *     rows; the amount comes from `APPS.WCSEXP_PO_DISTRIBUTIONS`, which computes it
 *     from `PO_LINE_LOCATIONS_ALL`. Same choice, same reason, as the extract.
 *     ★ THAT IS AN ORACLE FACT, AND THE TWO NAMES ARE NOT INTERCHANGEABLE. On the
 *     Turso sample the view is a plain pass-through over a column that *is*
 *     populated, so repointing this join at the base table would be a no-op there
 *     and a silent NULL here — correct on the database it is not tested on. The
 *     formula that would replace the view needs four `PO_LINE_LOCATIONS_ALL`
 *     columns the sample does not have, so it cannot be validated offline. And the
 *     view's own text, read from the live database, shows it **never reads
 *     `PD.AMOUNT_ORDERED` at all** — the base column is defined out of its select
 *     list — so this is not a populated-vs-NULL choice but a column the view
 *     deliberately replaced. Measured on the live database: `AMOUNT_ORDERED` is NULL
 *     on **2,000 of 2,000** sampled rows of `PO_DISTRIBUTIONS_ALL`, while the view
 *     supplies a value for every one of them, and the reimplemented formula agrees
 *     with the view on **2,030 of 2,030** rows. ★ It joins `PO_LINE_LOCATIONS_ALL` on
 *     `(PO_HEADER_ID, PO_LINE_ID)` — **and that is the key that fans out**, the
 *     opposite way round from how it first reads. Over a 2,000-row sample the view
 *     returns **2,011** rows on that key but **2,000** on `LINE_LOCATION_ID`, so
 *     **`PO_DISTRIBUTION_ID` is not unique in the view** (7 of 2,000 distributions
 *     have more than one row, up to 4) and a correlated `WHERE
 *     wd.PO_DISTRIBUTION_ID = d.PO_DISTRIBUTION_ID` fails with `ORA-01427`.
 *     See docs/implementation/wcsexp-view-names.md §4.
 *   - It does not join `PO_VENDORS` for anything but the name. A site's vendor is
 *     its own `VENDOR_ID`, and the register cross-checks that against the vendors
 *     its orders actually name (`counts.sitesWhoseOrderVendorDiffers`) rather than
 *     trusting either side.
 *   - It does not run the directory query per row. The 669/567/342 figures are one
 *     extra aggregate, not a correlated subquery per site.
 *   - It cannot fall back to the frozen extract, and refuses to pretend otherwise.
 *     `data/oracle/full-output.json` carries **no `VENDOR_ID` and no
 *     `VENDOR_SITE_ID`** — there is no site in it to group by — so a non-Oracle
 *     ledger answers `503`, which is what "this screen cannot be served here" means.
 *     A frozen fallback for this endpoint is impossible rather than unimplemented.
 */

// ─── 1. The deprecation predicate ─────────────────────────────────────────────

/**
 * `DO NOT USE` written however the person doing the data entry felt that day.
 *
 * ★ THE NORMALISATION IS NOT COSMETIC. The directory holds at least fifteen
 *   spellings — `DONOTUSE`, `DO NOT USE`, `DONOT USE`, `DO  NOT USE` (two spaces),
 *   `DONOTUSE1`, `DONOTUSE2`, and a dozen variants with the address segment still
 *   attached (`DONOTUSE OR`, `DONOTUSE     OR`, `DONOTUSE OP`, `DONOTUSE     OP`,
 *   `DONOTUSE PY`). A `LIKE '%DO NOT USE%'` misses over 90% of them. Squashing
 *   whitespace, dashes and underscores first is what makes the test a test.
 */
function squash(value: string): string {
  return value.toUpperCase().replace(/[\s\-_]/g, '');
}

const DO_NOT_USE_RE = /DONOTUSE/;

/** The three signals, in the order a reader should read them. */
const SIGNAL_NOT_PURCHASING = 'not a purchasing site';
const SIGNAL_RETIRED = 'retired';
const SIGNAL_VENDOR_NAME = 'the vendor is named DO NOT USE';

/**
 * Why this site is deprecated, in words a row can print, or `[]` for an active site.
 *
 * ★ RETURNED AS LABELS, INCLUDING THE EVIDENCE, RATHER THAN AS KEYS THE CLIENT
 *   EXPANDS. The reason "retired" is only meaningful *with its date* — a reader who
 *   sees "retired" and no date has to open the row to find out whether that was last
 *   month or last decade — so the label carries the date and the client prints what
 *   it is given. It also puts the wording in one place rather than in a map on each
 *   side of the wire.
 */
function deprecationReasons(site: {
  purchasingSiteFlag: 'Y' | 'N' | null;
  inactiveDate: string | null;
  vendorName: string | null;
}): string[] {
  const reasons: string[] = [];

  if (site.purchasingSiteFlag === 'N') reasons.push(SIGNAL_NOT_PURCHASING);
  if (site.inactiveDate !== null) reasons.push(`${SIGNAL_RETIRED} ${site.inactiveDate}`);
  if (site.vendorName !== null && DO_NOT_USE_RE.test(squash(site.vendorName))) {
    reasons.push(SIGNAL_VENDOR_NAME);
  }

  return reasons;
}

/** The bare signal inside a reason label, so the summary can group by it. */
function signalOf(reason: string): string {
  return reason.startsWith(SIGNAL_RETIRED) ? SIGNAL_RETIRED : reason;
}

// ─── 2. Shapes ────────────────────────────────────────────────────────────────

/**
 * One row of the register read: an in-scope order, and the site it named.
 *
 * The site's columns repeat on every order pair rather than arriving in a second
 * map, because the fold needs them at most once and a second query would be a
 * second query that could disagree.
 */
interface Pair {
  vendorSiteId: number;
  siteCode: string;
  /** The vendor the *site* belongs to. The register names the vendor from this. */
  vendorId: number;
  /** The vendor on the order header. Counted against `vendorId`, never used to name. */
  headerVendorId: number;
  vendorName: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  addressLine3: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  areaCode: string | null;
  phone: string | null;
  purchasingSiteFlag: 'Y' | 'N' | null;
  inactiveDate: string | null;
  deprecatedReasons: string[];
  orderNumber: string;
  approvedDate: string | null;
  lineCount: number;
  amount: number;
}

/** One site, folded from its pairs. */
interface Site {
  vendorSiteId: number;
  siteCode: string;
  vendorId: number;
  vendorName: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  addressLine3: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  areaCode: string | null;
  phone: string | null;
  purchasingSiteFlag: 'Y' | 'N' | null;
  inactiveDate: string | null;
  orders: number;
  /** Raw, unrounded. Rounded once, at the end, after every order is folded in. */
  amountRaw: number;
  amount: number;
  status: 'active' | 'deprecated';
  deprecatedReasons: string[];
}

function textOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * A number, or null when there is not one — which is a different answer from 0.
 *
 * ★ `num()` COLLAPSES "ABSENT" ONTO 0, AND ON THE MAP THAT IS THE ONE ERROR THAT
 *   CANNOT BE SEEN. Every `VENDOR_SITE_ID` here is present, so `num()` is right for
 *   it. But a null `DRIVE_MILES` means "no distance was established" and 0 would mean
 *   "this site sits at the origin" — and `libSQL` hands a REAL column back as a
 *   `number`, an Oracle one as a string, and a missing value as `null`, so the three
 *   arrive in one type. Anything a map draws from must go through here instead.
 */
function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Round once, at the boundary, so a displayed figure is a figure and not a fraction. */
function money(value: number): number {
  return Math.round(value * 100) / 100;
}

// ─── 3. The statements ────────────────────────────────────────────────────────

/**
 * One row per (site, in-scope order).
 *
 * ★ THE GRAIN IS (SITE, ORDER) AND NOT (SITE), AND THE REASON IS THE REST OF THE PAGE.
 *   Aggregating straight to one row per site would give the tab totals in SQL and
 *   nothing else — a client could not list a site's orders without a second query per
 *   row. Folding in TypeScript instead means one statement serves the register, the tab
 *   counts, the per-signal summary, the order list and the address-completeness notes,
 *   and it means the *same rows* produce every figure on the screen. A summary from one
 *   query and a table from another is a page where the two can disagree.
 *
 * ★ THE INNER SELECT IS AGGREGATED BEFORE THE JOIN TO THE SITE, WHICH IS WHAT KEEPS THE
 *   ROW COUNT HONEST. Joining the header straight to `PO_VENDOR_SITES_ALL` and then
 *   aggregating would be just as correct here — measured, an order never carries two
 *   sites and a site never carries two vendors — but the aggregate-then-join shape does
 *   not *depend* on that measurement staying true, and it reduces before it joins.
 *
 * ★ `SUM(wd.AMOUNT_ORDERED)` IS THE IN-SCOPE LINES ONLY, SO A SITE'S TOTAL IS NOT ITS
 *   ORDERS' TOTAL. Measured: **139 of the 5,692** in-scope orders also carry lines
 *   charged outside the scope, so those orders contribute less here than they do on a
 *   page that sums them whole. The register total is strictly less than "the sum of
 *   these orders", and the client is told so rather than left to find the gap.
 */
function orderPairSql(programs: readonly string[]): { sql: string; binds: Record<string, string> } {
  const { where, binds } = scopeClause(programs);

  const sql = `
    SELECT s.VENDOR_SITE_ID,
           s.VENDOR_SITE_CODE,
           s.VENDOR_ID,
           s.ADDRESS_LINE1,
           s.ADDRESS_LINE2,
           s.ADDRESS_LINE3,
           s.CITY,
           s.STATE,
           s.ZIP,
           s.AREA_CODE,
           s.PHONE,
           s.PURCHASING_SITE_FLAG,
           TO_CHAR(s.INACTIVE_DATE, 'YYYY-MM-DD') AS INACTIVE_DATE,
           v.VENDOR_NAME,
           o.HEADER_VENDOR_ID,
           o.ORDER_NUMBER,
           o.APPROVED_DATE,
           o.LINE_COUNT,
           o.AMOUNT
      FROM (
        SELECT h.VENDOR_SITE_ID,
               h.VENDOR_ID AS HEADER_VENDOR_ID,
               h.PO_HEADER_ID,
               h.SEGMENT1 AS ORDER_NUMBER,
               TO_CHAR(h.APPROVED_DATE, 'YYYY-MM-DD') AS APPROVED_DATE,
               COUNT(DISTINCT l.PO_LINE_ID) AS LINE_COUNT,
               SUM(wd.AMOUNT_ORDERED) AS AMOUNT
          FROM PO_HEADERS_ALL h
          JOIN PO_LINES_ALL l ON l.PO_HEADER_ID = h.PO_HEADER_ID
          JOIN APPS.WCSEXP_PO_DISTRIBUTIONS wd ON wd.PO_LINE_ID = l.PO_LINE_ID
          JOIN GL_CODE_COMBINATIONS g ON g.CODE_COMBINATION_ID = wd.CODE_COMBINATION_ID
          ${where}
         GROUP BY h.VENDOR_SITE_ID, h.VENDOR_ID, h.PO_HEADER_ID, h.SEGMENT1,
                  TO_CHAR(h.APPROVED_DATE, 'YYYY-MM-DD')
      ) o
      JOIN PO_VENDOR_SITES_ALL s ON s.VENDOR_SITE_ID = o.VENDOR_SITE_ID
 LEFT JOIN APPS.PO_VENDORS v ON v.VENDOR_ID = s.VENDOR_ID
     ORDER BY s.VENDOR_SITE_ID, o.APPROVED_DATE DESC, o.ORDER_NUMBER DESC`;

  return { sql, binds };
}

/**
 * The `DO NOT USE` population of the *whole directory*, so a client can say why its own
 * tab is not the size a reader expects.
 *
 * ★ THIS IS THE ONE PLACE THE SQUASHED CODE TEST IS WRITTEN IN SQL, AND IT IS DELIBERATE
 *   that it is not the test the register uses. This statement answers "how many rows are
 *   out there that the scope excluded", which is a directory-wide question the register
 *   rows cannot answer; the register's own classification happens in TypeScript over rows
 *   already in hand, so the predicate that decides a *tab* has exactly one implementation.
 *
 * ★ `WITH_ANY_ORDER` IS A LEFT JOIN TO THE DISTINCT SITE IDS ON ORDERS, NOT A CORRELATED
 *   `EXISTS`. A correlated subquery against 288,054 headers, evaluated once per matching
 *   site, is the shape that turns a footnote into a timeout.
 */
const DIRECTORY_SQL = `
  SELECT COUNT(DISTINCT s.VENDOR_SITE_ID) AS SITES,
         COUNT(DISTINCT s.VENDOR_ID) AS VENDORS,
         COUNT(DISTINCT o.VENDOR_SITE_ID) AS WITH_ANY_ORDER
    FROM PO_VENDOR_SITES_ALL s
 LEFT JOIN (SELECT DISTINCT VENDOR_SITE_ID FROM PO_HEADERS_ALL) o
         ON o.VENDOR_SITE_ID = s.VENDOR_SITE_ID
   WHERE REPLACE(REPLACE(REPLACE(UPPER(TRIM(s.VENDOR_SITE_CODE)), ' ', ''), '-', ''), '_', '')
         LIKE '%DONOTUSE%'`;

// ─── 4. Schemas ───────────────────────────────────────────────────────────────

const SiteSchema = z
  .object({
    vendorSiteId: intReq('`PO_VENDOR_SITES_ALL.VENDOR_SITE_ID`.'),
    siteCode: textReq(
      '`VENDOR_SITE_CODE`. Measured 9–15 characters and never padded, 503 of the 800 ending ' +
        '` OP`, 83 ` OPE`, 188 ` OR` and 9 ` PY`; 94 start `EP-` and 550 begin with a digit. ' +
        'Not unique on its own — see `counts`.',
    ),
    vendorId: intReq('`VENDOR_ID` as the site itself records it.'),
    vendorName: text('`PO_VENDORS.VENDOR_NAME`. Measured null on 0 of the 800 register rows.'),
    addressLine1: text('Street address. Measured null on 0 of the 800.'),
    addressLine2: text('Second address line. Measured null on 624 of the 800 — absence is the norm.'),
    addressLine3: text('Third address line. Measured null on 794 of the 800.'),
    city: text('Measured null on 0 of the 800, but not spelled consistently — see `observed`.'),
    state: text(
      'Two-letter state code. Measured null on 2 of the 800 (`8553MAINST OR`, `980HOWEST OR`), ' +
        'and 1 further row carries the literal string `CANADA` where a code belongs.',
    ),
    zip: text('Measured null on 0 of the 800.'),
    areaCode: text('Phone area code. Measured null on 372 of the 800.'),
    phone: text('Measured null on 373 of the 800 — those sites carry no phone at all.'),
    purchasingSiteFlag: flag('`PURCHASING_SITE_FLAG`. `N` is one of the three deprecation signals.'),
    inactiveDate: date('`INACTIVE_DATE`. Non-null is one of the three deprecation signals.'),
    orders: intReq(
      'In-scope orders that named this site. Measured max 271, on site 34088 ' +
        '(`EP-2851VANH OPE`, Institutional Interiors Inc, $7,122,958.22).',
    ),
    amount: realReq(
      'Committed dollars on this site’s in-scope distribution lines. **In-scope lines only** — ' +
        '139 of the 5,692 orders also carry lines outside the scope, so this is less than those ' +
        'orders’ own totals. Measured 0 on 26 of the 800 sites, each of which does carry orders, ' +
        'so the zero is a real figure and not a gap.',
    ),
    status: z.enum(['active', 'deprecated']).openapi({
      description:
        'Which tab this row belongs to. Deprecated is not an exclusion — see the endpoint description.',
    }),
    deprecatedReasons: z.array(z.string()).openapi({
      description:
        'Which signals deprecated this row, in words, each carrying its own evidence where it has any ' +
        '(`retired 2026-09-19`). Empty for an active site. Measured: 761 rows carry none, 37 carry one, ' +
        '1 carries two (site 651458), 1 carries all three (site 12364).',
    }),
  })
  .openapi('VendorSiteRegisterSite');

const OrderSchema = z
  .object({
    vendorSiteId: intReq('The site this order named.'),
    orderNumber: textReq('`PO_HEADERS_ALL.SEGMENT1` — the number a person reads.'),
    approvedDate: date('`APPROVED_DATE`. Measured span of the register: 2021-07-01 → 2026-08-07.'),
    lineCount: intReq(
      'Distinct lines on this order, within scope. Measured 31,401 across the register against the ' +
        'extract’s 31,670 distribution rows — a line can carry more than one distribution.',
    ),
    amount: realReq('Committed dollars on this order’s in-scope lines. Measured 0 on 215 of the 5,692.'),
  })
  .openapi('VendorSiteRegisterOrder');

const SignalSchema = z
  .object({
    signal: textReq('The signal on its own, with any date stripped — `retired`, not `retired 2026-09-19`.'),
    sites: intReq('Register sites carrying it. These do not sum to the deprecated count — they overlap.'),
    orders: intReq('In-scope orders on those sites.'),
    amount: realReq('Committed dollars on those sites.'),
  })
  .openapi('VendorSiteRegisterSignal');

const DirectorySchema = z
  .object({
    rule: textReq('The rule these figures were measured with, in words.'),
    sites: intReq('DO-NOT-USE-coded sites in the whole 99,316-row directory. Measured 669.'),
    vendors: intReq('Vendors those belong to. Measured 567.'),
    withAnyOrder: intReq(
      'Of those, sites named by any purchase order at all — in scope or not. Measured 342.',
    ),
    namedByAnInScopeOrder: intReq(
      'Of those, sites that appear in this register. **Measured 0**, and it is the finding this endpoint ' +
        'exists to carry: the fiscal floor and the program filter exclude every one, so a tab built on ' +
        'the site code would render empty.',
    ),
  })
  .openapi('VendorSiteRegisterDirectory');

const CountsSchema = z
  .object({
    sites: intReq('Register sites. Measured 800 at `start_fy = 2022`.'),
    activeSites: intReq('Sites on the Active tab. Measured 761.'),
    deprecatedSites: intReq('Sites on the Deprecated tab. Measured 39.'),
    orders: intReq('In-scope orders naming any register site. Measured 5,692.'),
    activeOrders: intReq('Of those, on an active site. Measured 5,449.'),
    deprecatedOrders: intReq('Of those, on a deprecated site. Measured 243 — **not zero**.'),
    lines: intReq('Distinct in-scope lines, summed over the register. Measured 31,401.'),
    vendors: intReq('Distinct vendors owning a register site. Measured 715.'),
    sitesWhoseOrderVendorDiffers: intReq(
      'Sites whose orders name a different `VENDOR_ID` from the one the site records. Measured 0 — ' +
        'returned anyway, because a page that prints a company name taken from the site while counting ' +
        'orders taken from the header is asserting the two are the same company.',
    ),
    sitesSharingACodeWithAnotherVendor: intReq(
      'Sites whose `VENDOR_SITE_CODE` a different vendor in the register also uses — a SITE count, not ' +
        'a code count. Measured 10 sites across 5 codes, each code drawn by exactly 2 vendors, which is ' +
        'why the row key is the (vendor, code) pair and not the code.',
    ),
  })
  .openapi('VendorSiteRegisterCounts');

const TotalsSchema = z
  .object({
    amount: realReq(
      'Committed dollars on the register’s in-scope lines. Measured $2,797,825,956.73 at `start_fy = 2022`. ' +
        'This is the sum of the per-site figures, so it is exactly what a client that adds up the amount ' +
        'column will get — see `orderRowAmountTotal` for the other rounding order.',
    ),
    activeAmount: realReq('Of that, the Active tab. Measured $2,759,258,376.61.'),
    deprecatedAmount: realReq(
      'Of that, the Deprecated tab. Measured $38,567,580.12 — 1.38% of the register, and the reason the ' +
        'tab is a view rather than a filter.',
    ),
    orderRowAmountTotal: realReq(
      'The same money summed at the (site, order) grain before per-site rounding. Printed beside `amount` ' +
        'so that a difference of cents is visible rather than mysterious.',
    ),
  })
  .openapi('VendorSiteRegisterTotals');

const ScopeSchema = z
  .object({
    slug: z.string(),
    name: z.string(),
    fund: z.string(),
    programs: z.array(z.string()),
    startFy: z.number(),
    from: z.string().openapi({ description: 'The fiscal floor, `YYYY-MM-DD`, derived from `startFy`.' }),
  })
  .openapi('VendorSiteRegisterScope');

const ObservedSchema = z
  .object({
    firstOrderDate: date(
      'Earliest in-scope `APPROVED_DATE` naming a register site. Measured 2021-07-01 — the floor itself.',
    ),
    lastOrderDate: date('Latest one. Measured 2026-08-07.'),
    activeFirstOrderDate: date('Earliest on the Active tab. Measured 2021-07-01.'),
    activeLastOrderDate: date('Latest on the Active tab. Measured 2026-08-07.'),
    deprecatedFirstOrderDate: date('Earliest on the Deprecated tab. Measured 2021-07-06.'),
    deprecatedLastOrderDate: date(
      'Latest on the Deprecated tab. Measured 2026-07-02 — the deprecated rows are *recent* as well as ' +
        'old, which is the second reason the tab is a view and not a filter.',
    ),
    activeVendors: intReq('Distinct vendors on the Active tab. Measured 695.'),
    maxOrdersOnOneSite: intReq('Measured 271, on site 34088 (`EP-2851VANH OPE`).'),
    sitesWithoutPhone: intReq('Measured 373 of 800.'),
    sitesWithoutAreaCode: intReq('Measured 372 of 800.'),
    sitesWithoutAddressLine2: intReq('Measured 624 of 800.'),
    sitesWithoutAddressLine3: intReq('Measured 794 of 800.'),
    sitesWithoutState: intReq('Measured 2 of 800.'),
    sitesWithNonCodeState: intReq(
      'Sites whose `STATE` is not a two-letter code. Measured 1, reading `CANADA`. Of the 46 distinct ' +
        'non-null values, 45 are real codes.',
    ),
    sitesWithZeroAmount: intReq(
      'Sites carrying orders but no in-scope committed money. Measured 26 — every line on those orders ' +
        'sits outside the scope, which is a true statement about where the lines were charged.',
    ),
    ordersWithZeroAmount: intReq('Order rows carrying `0`. Measured 215 of 5,692.'),
    sitesWithReusedCode: intReq(
      'Sites whose code another vendor in the register also uses. Measured 10, across 5 codes — the ' +
        'same count `counts.sitesSharingACodeWithAnotherVendor` reports, from the payload rather than ' +
        'from a second query.',
    ),
    distinctCities: intReq(
      'Distinct `city`/`state` pairs among the register sites. Measured 351. Keyed on the pair and not ' +
        'the city alone, because a city name in two states is two cities.',
    ),
    distinctCitiesUpperCased: intReq(
      'The same count after upper-casing — measured 342, so 9 groups differ only by case ' +
        '(`Hanover Park` against `HANOVER PARK`, `Raleigh` against `RALEIGH`). A city filter that reads ' +
        'as complete and misses a spelling is worse than one that admits it is approximate.',
    ),
    distinctStates: intReq('Distinct non-null `STATE` values. Measured 46, of which 1 is not a code.'),
  })
  .openapi('VendorSiteRegisterObserved');

/**
 * Where a site is, and how far it is from the origin.
 *
 * ★ EVERY FIELD HERE COMES FROM A DIFFERENT STORE FROM EVERY OTHER FIELD ON THIS
 *   ROUTE. The register is read from the **ledger** (Oracle); this is read from the
 *   **app** store (`vendor_site_geo`). The join is made in TypeScript on
 *   `siteId === vendorSiteId` and not in SQL, because no statement can span two
 *   databases — so if this array is empty while `sites` is not, the cause is a
 *   missing app store or a run that has not happened, never a bad join.
 *
 * ★★ TWO AXES, DELIBERATELY NOT ONE STATUS. `geocode*` says whether there is a
 *    coordinate; `drive*` says whether there is a distance. They are measured by
 *    different APIs at different times, and four states are visible at once:
 *
 *      `matched` + `driveStatus='ok'`          a pin and a distance
 *      `matched` + `driveStatus='outside_us'`  a pin, NO distance — correct, not missing
 *      `matched` + `driveStatus='unclassified'` a pin, NO distance — see `unclassified`
 *      `matched` + `driveStatus=null`          a pin, distance not computed yet
 *      `po_box` / `no_match`                   no pin, and `geocodeReason` says why
 *
 *    A client that renders "no distance" and "no pin" as the same thing has lost the
 *    distinction the table exists to keep, which is why neither axis is folded away.
 *    `outside_us` and `unclassified` are both real answers; `null` is "not run yet".
 */
const SiteGeoSchema = z
  .object({
    siteId: intReq('`VENDOR_SITE_ID` from the register — the same integer as `sites[].vendorSiteId`.'),
    latitude: real('Null unless `geocodeStatus` is `matched`. Written from the new answer on every run, null included.'),
    longitude: real('The pair to `latitude`. Never written without it.'),
    geocodeStatus: z
      .enum(['matched', 'no_match', 'po_box'])
      .openapi({ description: '`matched` has a feature; `po_box` was refused before any request was sent; `no_match` spent a request and the feature set was empty.' }),
    geocodeReason: text('Why, in words. Splits `no_match` into the four causes that a single status cannot carry.'),
    matchConfidence: text('Mapbox `match_confidences`. The flag that separates a rooftop from a locality.'),
    accuracy: text('Mapbox `accuracy` — `rooftop`/`parcel`/`point`/`interpolated`/`approximate`.'),
    featureType: text('The returned feature\u2019s type, e.g. `address`. Kept because a `types=address` request that answers with a *street* is the one silent failure worth auditing.'),
    queryAddress: text('The exact string sent, so a pin can be argued with rather than only believed.'),
    geocodedAt: text('When this row was last written.'),
    driveMiles: real('Driving distance from the origin in statute miles, rounded at the point of storage. Null for every non-`ok` `driveStatus`.'),
    driveMinutes: real('The paired duration. Null with `driveMiles`.'),
    driveStatus: text('`ok` · `outside_us` · `unclassified` · `no_route`, or **null for "not computed yet"** — which is not the same as any of those.'),
    driveOriginSlug: text('Which `geo_origin` row measured it, so a change of origin is visible in the data rather than inferred.'),
  })
  .openapi('VendorSiteGeo');

/**
 * One turn of the road route.
 *
 * ★ THE JOB'S STORED KEYS, SPELLED AS THE JOB WROTE THEM. `vendor_site_route.steps`
 *   holds one JSON array, projected by `scripts/geocode-vendor-sites.ts` from the
 *   routing service's own step objects — and *only* these eight fields, because the
 *   raw step carries per-step `geometry`, `voiceInstructions` and
 *   `bannerInstructions` and is roughly ten times the size for nothing this panel
 *   draws. `instruction` is the service's sentence **verbatim**; rephrasing it would
 *   mean inventing text about real roads.
 *
 * ★ THE LAST STEP CARRIES ZERO DISTANCE AND IS KEPT. That is the arrival —
 *   `Your destination will be on the right [0 mi]` — and dropping the zero-distance
 *   steps, which looks like tidying, removes the only sentence that tells the reader
 *   they have arrived, so the list appears to end mid-journey. Measured, the steps sum
 *   to the route's own stored distance to within 0.001 mi, which is what makes it
 *   honest to print a step's own length beside the route total.
 */
const RouteStepSchema = z
  .object({
    instruction: text('The routing service\u2019s own sentence, verbatim — e.g. `Turn right onto Kildaire Farm Road`. The step always writes one; declared nullable because a stored blob is read defensively, never trusted.'),
    name: text('The road this step runs along. Null where the service names none: a slip road, a roundabout exit, the arrival itself.'),
    distanceMiles: real('This step\u2019s own length in statute miles, converted from metres at the point of storage.'),
    durationMinutes: real('This step\u2019s own duration in minutes.'),
    type: text('The maneuver class — `turn`, `depart`, `arrive`, `merge`, `on ramp`, `off ramp`, `new name`, `roundabout`, `end of road`.'),
    modifier: text('Which way the maneuver goes — `left`, `slight right`, `uturn`, … Null where the class has no side, as `arrive` does.'),
    longitude: real('The maneuver point. **Longitude first**, which is the order the service reports a coordinate in.'),
    latitude: real('The maneuver point\u2019s latitude.'),
  })
  .openapi('VendorSiteRouteStep');

/**
 * The road route from the origin to one site — **one row, one site, on request**.
 *
 * ★ THE PER-SITE SHAPE IS THE WHOLE POINT OF THIS ENDPOINT, AND IT IS WHY THE ROUTE
 *   LIVES IN ITS OWN TABLE. A stored route is 12.6 KB, and **90% of it is the turns**
 *   (11,291 B of steps against 1,319 B of geometry) — so publishing geometry and steps
 *   on `geo.sites[]`, which `GET /api/vendor-site-register` sends for all 800 sites on
 *   every page load, would add roughly 10 MB to the first paint of a register that has
 *   nothing to do with the road until a panel is open. The register carries the
 *   *distance*; this endpoint carries the *line and its turns*, asked for once, for the
 *   one site whose panel the reader opened.
 *
 * ★ `status: null` IS NOT `no_route`, AND CONFLATING THEM CONVERTS A REAL ANSWER INTO A
 *   FALSE ONE. `no_route` is something the routing service said; `null` is a question
 *   nothing has asked yet — there is no row. The first is permanent, the second is
 *   expected to shrink when the step is rerun, and a client that renders them the same
 *   way tells the reader *there is no road to this place* when all that happened is
 *   that nobody looked.
 *
 * ★ AND `miles` HERE IS A THIRD MILEAGE, NOT A REPLACEMENT FOR EITHER OF THE OTHER TWO.
 *   The panel already prints `driveMiles` (the Matrix API's figure, stored on
 *   `vendor_site_geo`) and a straight-line haversine computed in the browser. This one
 *   comes from the Directions API. Measured on the sites that carry all three, Matrix
 *   and Directions **agree within one mile on only 11 of 24**, and differ by as much as
 *   **34.48 mi** — so a reader shown one number has been told something the other API
 *   would dispute. Print this one beside the line it measures and name the method.
 */
const SiteRouteSchema = z
  .object({
    siteId: intReq('`VENDOR_SITE_ID` — the same integer as `sites[].vendorSiteId`.'),
    status: z
      .enum(['ok', 'no_route', 'error', 'unpinned'])
      .nullable()
      .openapi({
        description:
          '`ok` carries a line and its turns. `no_route` is the routing service\u2019s own answer for this pair. `error` means the attempt failed and is worth retrying. `unpinned` means a row is stored but the site\u2019s coordinate has been withdrawn since, so the line is withheld rather than drawn from a point this payload does not have — **the one status a rerun moves, in the other direction.** **Null means no row is stored — not asked yet — which is a different fact from every one of those.**',
      }),
    reason: text('Why, in words, for any status that is not `ok` — the service\u2019s own message where it gave one.'),
    miles: real('The route\u2019s length in **statute miles**. The service reports metres and the step converts at the point of storage, so this is comparable with `driveMiles`. It is the figure to print beside the drawn line.'),
    minutes: real('The route\u2019s duration in minutes.'),
    originSlug: text('Which `geo_origin` row this was routed from, so a change of origin is visible in the data rather than inferred.'),
    geometry: z.array(z.array(z.number())).nullable().openapi({
      description:
        'The line to draw, as `[longitude, latitude]` pairs in driving order. From `overview=simplified` — the same road at display resolution, about 50x smaller than `overview=full`, and indistinguishable at a 220-pixel-tall map. **Both endpoints are included**, so this is the whole line and not a fragment. Null on every row whose status is not `ok`.',
    }),
    steps: z.array(RouteStepSchema).nullable().openapi({
      description: 'The turns in driving order, ending with the zero-distance arrival step. Null unless `status` is `ok`.',
    }),
    stepCount: z.number().int().nullable().openapi({
      description: 'Length of `steps` as stored, carried separately so a client can state the count without holding the list.',
    }),
    routeAt: text('When this row was written. A route is a snapshot of the road as the service knew it that day, not a live measurement.'),
    note: text('Set when the stored row could not be served as it stands and something had to be suppressed — the client prints this under the map rather than dropping the caveat.'),
  })
  .openapi('VendorSiteRoute');

const GeoOriginSchema = z
  .object({
    slug: textReq('The origin key, e.g. `raleigh`.'),
    name: textReq('A display name, e.g. `Raleigh, North Carolina`.'),
    latitude: realReq('Origin latitude, from `geo_origin` — not from a request parameter.'),
    longitude: realReq('Origin longitude.'),
  })
  .openapi('VendorSiteGeoOrigin');

const GeoCountsSchema = z
  .object({
    inScope: intReq('Sites in the register — the denominator every other count is read against.'),
    covered: intReq('Sites with a `vendor_site_geo` row. `covered + notCovered = inScope`.'),
    notCovered: intReq('Sites the job has not reached. A site in this pile has no answer at all, which is why it is counted apart from `noMatch`.'),
    matched: intReq('Sites with a coordinate.'),
    poBox: intReq('Sites refused before any request was sent, because they name a box and no street.'),
    noMatch: intReq('Sites a request was spent on and Mapbox had no address for. **Not the same as `notCovered`.**'),
    withDistance: intReq('Sites carrying a driving distance.'),
    outsideUs: intReq('Pinned sites deliberately not routed. A blank distance here is the answer, not a gap.'),
    unclassified: intReq('Pinned sites whose country could not be established from `STATE`. Also deliberately unrouted.'),
    noRoute: intReq('Routed sites Mapbox returned `null` for. Stored as null rather than 0, because 0 would assert the site sits at the origin.'),
    awaitingDistance: intReq('`matched` sites with no `drive_status` at all — the only pile that a rerun is expected to shrink.'),
  })
  .openapi('VendorSiteGeoCounts');

const GeoSchema = z
  .object({
    available: z.boolean().openapi({
      description:
        'Whether the app store answered. **When false, `counts` is null and every count in it is unknown rather than zero** — the distinction this field exists to force. The register itself is still served, because it is read from the ledger and does not depend on this.',
    }),
    note: text('Null when available; otherwise the reason, in words, so a client can print it instead of an empty legend.'),
    origin: GeoOriginSchema.nullable().openapi({
      description: 'The `geo_origin` row distances are measured from, or **null when no origin is seeded** — in which case every `drive*` field is absent for a reason the client can state.',
    }),
    sites: z.array(SiteGeoSchema).openapi({ description: 'One entry per covered site, keyed by `siteId`. A site absent from this array has no row; it is not a site with a null answer.' }),
    counts: GeoCountsSchema.nullable(),
  })
  .openapi('VendorSiteGeoBlock');

const RegisterSchema = z
  .object({
    sites: z.array(SiteSchema),
    orders: z.array(OrderSchema),
    counts: CountsSchema,
    totals: TotalsSchema,
    deprecatedSignals: z.array(SignalSchema),
    directory: DirectorySchema,
    scope: ScopeSchema,
    observed: ObservedSchema,
    geo: GeoSchema,
  })
  .openapi('VendorSiteRegister');

// ─── 5. The fold ──────────────────────────────────────────────────────────────

/**
 * Fold (site, order) pairs into sites, and every count and total with them.
 *
 * ★ EVERY FIGURE ON THE SCREEN COMES OUT OF THIS ONE LOOP. The tab counts, the
 *   per-signal summary and the totals are consequences of the same array, so they
 *   cannot describe different populations — which is the failure mode a "count query
 *   plus list query" design has and this one does not.
 */
function fold(pairs: Pair[]): {
  sites: Site[];
  orders: z.infer<typeof OrderSchema>[];
  counts: z.infer<typeof CountsSchema>;
  totals: z.infer<typeof TotalsSchema>;
  signals: z.infer<typeof SignalSchema>[];
} {
  const byId = new Map<number, Site>();
  const orders: z.infer<typeof OrderSchema>[] = [];
  let orderRowAmountTotal = 0;
  let lines = 0;
  let orderVendorMismatches = 0;

  for (const pair of pairs) {
    let site = byId.get(pair.vendorSiteId);
    if (site === undefined) {
      site = {
        vendorSiteId: pair.vendorSiteId,
        siteCode: pair.siteCode,
        vendorId: pair.vendorId,
        vendorName: pair.vendorName,
        addressLine1: pair.addressLine1,
        addressLine2: pair.addressLine2,
        addressLine3: pair.addressLine3,
        city: pair.city,
        state: pair.state,
        zip: pair.zip,
        areaCode: pair.areaCode,
        phone: pair.phone,
        purchasingSiteFlag: pair.purchasingSiteFlag,
        inactiveDate: pair.inactiveDate,
        orders: 0,
        amountRaw: 0,
        amount: 0,
        // Replaced below, once every pair has been folded in. Seeded so the type is
        // total rather than optional.
        status: 'active',
        deprecatedReasons: [...pair.deprecatedReasons],
      };
      byId.set(pair.vendorSiteId, site);
    }

    site.orders += 1;
    site.amountRaw += pair.amount;
    lines += pair.lineCount;
    orderRowAmountTotal += pair.amount;

    // ★ COUNTED, NOT TRUSTED. The join takes the vendor from the *site*; this is the
    //   only place the header's own answer is looked at, and it is reported rather
    //   than used.
    if (pair.headerVendorId !== pair.vendorId) orderVendorMismatches += 1;

    orders.push({
      vendorSiteId: pair.vendorSiteId,
      orderNumber: pair.orderNumber,
      approvedDate: pair.approvedDate,
      lineCount: pair.lineCount,
      amount: money(pair.amount),
    });
  }

  // ★ ROUND EACH SITE, THEN SUM THE ROUNDED VALUES. The other order — sum raw, round
  //   once — produces a register total that can differ by cents from the column the
  //   reader is looking at, and a reader who adds up a column and gets a different
  //   footer has found a defect no matter how small it is. `orderRowAmountTotal`
  //   carries the unrounded grain figure beside it so nothing is hidden.
  for (const site of byId.values()) {
    site.amount = money(site.amountRaw);
    site.status = site.deprecatedReasons.length > 0 ? 'deprecated' : 'active';
  }

  const sites = [...byId.values()].sort(
    (a, b) => b.orders - a.orders || b.amount - a.amount || a.siteCode.localeCompare(b.siteCode),
  );

  const activeSites = sites.filter((s) => s.status === 'active');
  const deprecatedSites = sites.filter((s) => s.status === 'deprecated');

  const sum = (list: Site[]): number => money(list.reduce((total, s) => total + s.amount, 0));
  const countOrders = (list: Site[]): number => list.reduce((total, s) => total + s.orders, 0);

  // A code is "reused" when two *different vendors* in the register draw it.
  const codeOwners = new Map<string, Set<number>>();
  for (const site of sites) {
    const owners = codeOwners.get(site.siteCode) ?? new Set<number>();
    owners.add(site.vendorId);
    codeOwners.set(site.siteCode, owners);
  }
  const sitesWithReusedCode = sites.filter((s) => (codeOwners.get(s.siteCode)?.size ?? 0) > 1).length;

  // The per-signal summary, grouped by the bare signal so a row retired yesterday and
  // one retired in 2024 land together — the *date* is evidence, not a category.
  const signals = [SIGNAL_NOT_PURCHASING, SIGNAL_RETIRED, SIGNAL_VENDOR_NAME].map((signal) => {
    const carrying = sites.filter((s) => s.deprecatedReasons.some((r) => signalOf(r) === signal));
    return { signal, sites: carrying.length, orders: countOrders(carrying), amount: sum(carrying) };
  });

  return {
    sites,
    orders,
    counts: {
      sites: sites.length,
      activeSites: activeSites.length,
      deprecatedSites: deprecatedSites.length,
      orders: orders.length,
      activeOrders: countOrders(activeSites),
      deprecatedOrders: countOrders(deprecatedSites),
      lines,
      vendors: new Set(sites.map((s) => s.vendorId)).size,
      sitesWhoseOrderVendorDiffers: orderVendorMismatches,
      sitesSharingACodeWithAnotherVendor: sitesWithReusedCode,
    },
    totals: {
      amount: sum(sites),
      activeAmount: sum(activeSites),
      deprecatedAmount: sum(deprecatedSites),
      orderRowAmountTotal: money(orderRowAmountTotal),
    },
    signals,
  };
}

function observe(
  pairs: Pair[],
  sites: Site[],
  sitesWithReusedCode: number,
): z.infer<typeof ObservedSchema> {
  const datesOf = (subset: Site[]): string[] => {
    const ids = new Set(subset.map((s) => s.vendorSiteId));
    return pairs
      .filter((p) => ids.has(p.vendorSiteId) && p.approvedDate !== null)
      .map((p) => p.approvedDate as string)
      .sort();
  };

  const all = datesOf(sites);
  const active = datesOf(sites.filter((s) => s.status === 'active'));
  const deprecated = datesOf(sites.filter((s) => s.status === 'deprecated'));

  // ★ KEYED ON `city|state`, NOT ON `city`. A city name in two states is two cities,
  //   and collapsing it would understate the count this pair of fields exists to
  //   disclose.
  const cityKeys = new Set<string>();
  const cityUpperKeys = new Set<string>();
  for (const site of sites) {
    if (site.city === null) continue;
    cityKeys.add(`${site.city}|${site.state ?? ''}`);
    cityUpperKeys.add(`${site.city.toUpperCase()}|${site.state ?? ''}`);
  }

  // ★ `?? null` IS REQUIRED BY `noUncheckedIndexedAccess`, NOT DEFENSIVENESS. The
  //   length guard above already proves the element exists, but TypeScript types
  //   `list[i]` as `string | undefined` and will not accept it as `string | null`.
  //   The two spellings differ in a way that matters: without the `?? null` this
  //   file does not typecheck at all.
  const first = (list: string[]): string | null => (list.length === 0 ? null : list[0] ?? null);
  const last = (list: string[]): string | null =>
    list.length === 0 ? null : list[list.length - 1] ?? null;

  return {
    firstOrderDate: first(all),
    lastOrderDate: last(all),
    activeFirstOrderDate: first(active),
    activeLastOrderDate: last(active),
    deprecatedFirstOrderDate: first(deprecated),
    deprecatedLastOrderDate: last(deprecated),
    activeVendors: new Set(sites.filter((s) => s.status === 'active').map((s) => s.vendorId)).size,
    maxOrdersOnOneSite: sites.reduce((max, s) => Math.max(max, s.orders), 0),
    sitesWithoutPhone: sites.filter((s) => s.phone === null).length,
    sitesWithoutAreaCode: sites.filter((s) => s.areaCode === null).length,
    sitesWithoutAddressLine2: sites.filter((s) => s.addressLine2 === null).length,
    sitesWithoutAddressLine3: sites.filter((s) => s.addressLine3 === null).length,
    sitesWithoutState: sites.filter((s) => s.state === null).length,
    sitesWithNonCodeState: sites.filter((s) => s.state !== null && !/^[A-Z]{2}$/.test(s.state)).length,
    sitesWithZeroAmount: sites.filter((s) => s.amount === 0).length,
    ordersWithZeroAmount: pairs.filter((p) => money(p.amount) === 0).length,
    sitesWithReusedCode,
    distinctCities: cityKeys.size,
    distinctCitiesUpperCased: cityUpperKeys.size,
    distinctStates: new Set(sites.map((s) => s.state).filter((v): v is string => v !== null)).size,
  };
}

/**
 * A `vendor_site_geo` row as the app store holds it.
 *
 * ★★ LOWER CASE, AND THAT IS LOAD-BEARING RATHER THAN COSMETIC. The ledger is Oracle
 *    and answers with `VENDOR_SITE_ID`; the app store is SQLite/libSQL and answers with
 *    `vendor_site_id`. Every other app-store reader in this repository is lower case for
 *    the same reason. Getting it wrong does not throw — `row.VENDOR_SITE_ID` is simply
 *    `undefined`, `num()` turns that into `0`, and the join matches nothing, so the
 *    symptom is "0 of 800 sites covered" beside a table that holds 800 rows. **The
 *    `as unknown as` cast needed to satisfy the compiler is what hides it: a cast through
 *    `unknown` asserts the shape and therefore stops the compiler from noticing that the
 *    declared keys cannot be right.** Mirror the store's own spelling, and treat a
 *    suspiciously empty result as a naming bug before a data bug.
 */
interface GeoRow {
  vendor_site_id: unknown;
  latitude: unknown;
  longitude: unknown;
  geocode_status: unknown;
  geocode_reason: unknown;
  match_confidence: unknown;
  accuracy: unknown;
  feature_type: unknown;
  query_address: unknown;
  geocoded_at: unknown;
  drive_miles: unknown;
  drive_minutes: unknown;
  drive_status: unknown;
  drive_origin_slug: unknown;
}

/**
 * What the map is allowed to state, assembled from the app store.
 *
 * ★★ WHY THIS RETURNS `counts: null` RATHER THAN ZEROS WHEN THE STORE DOES NOT ANSWER.
 *    The register has 800 sites whether or not Turso is reachable, so a `covered: 0`
 *    here would be a *claim about the data* made out of a *failure of the read* — and it
 *    is the worst kind of wrong, because it is silently consistent: 0 covered, 0 matched,
 *    0 with a distance all agree with each other while being false. `available: false`
 *    plus a null `counts` cannot be rendered as a number, so the client has to say
 *    something rather than print one.
 *
 * ★ AND WHY THIS DOES NOT REFUSE THE REQUEST. The register is a ledger read; this is a
 *    supplementary read from a second database. Throwing here would take a working page
 *    down because of the map, which is the inverse of the tradeoff `activity.ts` makes —
 *    there the catalogue *is* the page, so it refuses with a 503. The test is "does the
 *    page have another question it can answer?", and here it does.
 *
 * ★ MEASURED IN TYPESCRIPT, NOT SQL, AND THAT IS NOT A SHORTCUT. The register is in
 *    Oracle and this is in SQLite/SQLite-compatible libSQL; no statement can join them,
 *    so the key is the whole interface. `siteId` is `VENDOR_SITE_ID` on both sides.
 */
async function readSiteGeo(
  siteIds: number[],
): Promise<{
  available: boolean;
  note: string | null;
  origin: { slug: string; name: string; latitude: number; longitude: number } | null;
  sites: Record<string, unknown>[];
  counts: Record<string, number> | null;
}> {
  const empty = {
    available: false,
    note: null as string | null,
    origin: null,
    sites: [] as Record<string, unknown>[],
    counts: null as Record<string, number> | null,
  };

  let rows: GeoRow[];
  let originRow: Record<string, unknown> | undefined;
  try {
    const res = await storeDriver('app').execute({
      sql:
        'SELECT VENDOR_SITE_ID, LATITUDE, LONGITUDE, GEOCODE_STATUS, GEOCODE_REASON,' +
        ' MATCH_CONFIDENCE, ACCURACY, FEATURE_TYPE, QUERY_ADDRESS, GEOCODED_AT,' +
        ' DRIVE_MILES, DRIVE_MINUTES, DRIVE_STATUS, DRIVE_ORIGIN_SLUG' +
        ' FROM vendor_site_geo ORDER BY VENDOR_SITE_ID',
      args: {},
    });
    rows = res.rows as unknown as GeoRow[];

    const originRes = await storeDriver('app').execute({
      sql: 'SELECT slug, name, latitude, longitude FROM geo_origin ORDER BY slug LIMIT 1',
      args: {},
    });
    originRow = originRes.rows[0];
  } catch (err) {
    const app = storeDriver('app');
    return {
      ...empty,
      note:
        `The app store (${app.dialect}) did not answer the geocoding tables, so no site can be ` +
        'placed on the map. The register below is unaffected — it is read from the ledger. ' +
        `Cause: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let origin: { slug: string; name: string; latitude: number; longitude: number } | null = null;
  const olat = originRow === undefined ? null : Number(originRow.latitude);
  const olng = originRow === undefined ? null : Number(originRow.longitude);
  if (
    originRow !== undefined &&
    Number.isFinite(olat) &&
    Number.isFinite(olng)
  ) {
    origin = {
      slug: String(originRow.slug ?? ''),
      name: String(originRow.name ?? ''),
      latitude: olat as number,
      longitude: olng as number,
    };
  }

  const inScope = new Set(siteIds);
  const strandedDriveIds: number[] = [];
  const pinnedWithoutPairIds: number[] = [];
  const sites = rows
    .filter((r) => inScope.has(num(r.vendor_site_id)))
    .map((r) => {
      const status = textOf(r.geocode_status) ?? '';
      // ★ A COORDINATE IS REPORTED ONLY WHEN THE STATUS SAYS IT IS ONE. `latitude` is
      //   written on every run, null included, so a stale pair can survive beside a
      //   newer `no_match`. Publishing the pair without checking the status would put a
      //   pin on the map for a site the same payload says was not matched.
      const matched = status === 'matched';
      const lat = matched ? numOrNull(r.latitude) : null;
      const lng = matched ? numOrNull(r.longitude) : null;
      const hasPair = lat !== null && lng !== null;
      // ★ AND THE SAME GATE APPLIES TO THE DISTANCE, FOR THE SAME REASON — WITH ONE
      //   EXTRA STEP. A distance is a property of a pin: if this payload does not have
      //   a pin, it cannot have a distance measured from one. The store made this
      //   reachable (three `po_box` rows kept a `drive_*` stamp from when they were
      //   `matched`), and the writer is now fixed so new rows cannot arrive in that
      //   state — but a store that already holds one must not be able to publish it,
      //   and the guard that enforces that has to live on the read path, because the
      //   read path is the only place that sees every row a client will see.
      //
      //   ⇒ TWO LAYERS, TWO JOBS: the writer stops the contradiction being CREATED, the
      //     reader stops it being SERVED. Removing either one leaves the other doing
      //     work it cannot do.
      const hasPin = matched && hasPair;
      const drive = hasPin
        ? {
            driveMiles: numOrNull(r.drive_miles),
            driveMinutes: numOrNull(r.drive_minutes),
            driveStatus: textOf(r.drive_status),
            driveOriginSlug: textOf(r.drive_origin_slug),
          }
        : { driveMiles: null, driveMinutes: null, driveStatus: null, driveOriginSlug: null };
      // Counted from the RAW row, never from `drive` above — a disclosure derived from
      // a value this function has just suppressed can never fire, which is how a note
      // explaining a defect ends up permanently silent.
      if (!hasPin && (r.drive_miles !== null || r.drive_status !== null)) {
        strandedDriveIds.push(num(r.vendor_site_id));
      }
      if (matched && !hasPair) pinnedWithoutPairIds.push(num(r.vendor_site_id));

      return {
        siteId: num(r.vendor_site_id),
        latitude: hasPair ? lat : null,
        longitude: hasPair ? lng : null,
        geocodeStatus: status,
        geocodeReason: textOf(r.geocode_reason),
        matchConfidence: textOf(r.match_confidence),
        accuracy: textOf(r.accuracy),
        featureType: textOf(r.feature_type),
        queryAddress: textOf(r.query_address),
        geocodedAt: textOf(r.geocoded_at),
        ...drive,
      };
    });

  const byStatus = new Map<string, number>();
  const byDrive = new Map<string, number>();
  let matched = 0;
  let withDistance = 0;
  for (const s of sites) {
    byStatus.set(s.geocodeStatus, (byStatus.get(s.geocodeStatus) ?? 0) + 1);
    // ★ `driveStatus` HAS ALREADY BEEN GATED, SO THIS MAP COUNTS PINNED SITES ONLY — and
    //   that is what makes the counts below add up. Counting the raw column here would
    //   let a `po_box` row contribute to `outsideUs` while contributing nothing to the
    //   response, which is how a reader gets a count they cannot reconcile with the rows.
    const drive = s.driveStatus ?? '';
    byDrive.set(drive, (byDrive.get(drive) ?? 0) + 1);
    if (s.geocodeStatus === 'matched') matched += 1;
    if (s.driveMiles !== null) withDistance += 1;
  }

  const outsideUs = byDrive.get('outside_us') ?? 0;
  const unclassified = byDrive.get('unclassified') ?? 0;
  const noRoute = byDrive.get('no_route') ?? 0;

  // ★ A NOTE THAT NAMES WHAT WAS SUPPRESSED, BUILT FROM THE RAW COUNTS. `available` says
  //   the store answered; these sentences say the answer contained something that could
  //   not be served as-is, which is a different fact and the one that tells a reader
  //   whether to act. Both are `null`-able independently.
  const notes: string[] = [];
  if (strandedDriveIds.length > 0) {
    const ids = strandedDriveIds.slice(0, 5).join(', ');
    notes.push(
      `${strandedDriveIds.length} site(s) hold a driving distance with no pin (${ids}` +
        `${strandedDriveIds.length > 5 ? ', …' : ''}). Their distance is reported as null, ` +
        'because a distance is measured from a pin and these have none — the value stored is ' +
        'left over from before their address was reclassified. Running the geocode step again ' +
        'clears it.',
    );
  }
  if (pinnedWithoutPairIds.length > 0) {
    const ids = pinnedWithoutPairIds.slice(0, 5).join(', ');
    notes.push(
      `${pinnedWithoutPairIds.length} site(s) are stored as \`matched\` with no coordinate pair ` +
        `(${ids}${pinnedWithoutPairIds.length > 5 ? ', …' : ''}). They are reported with null ` +
        'latitude and longitude rather than dropped, so the gap stays visible.',
    );
  }

  return {
    available: true,
    note: notes.length > 0 ? notes.join(' ') : null,
    origin,
    sites,
    counts: {
      inScope: inScope.size,
      covered: sites.length,
      notCovered: inScope.size - sites.length,
      matched,
      poBox: byStatus.get('po_box') ?? 0,
      noMatch: byStatus.get('no_match') ?? 0,
      withDistance,
      outsideUs,
      unclassified,
      noRoute,
      // ★ AN EQUALITY, NOT A PARAGRAPH, AND IT IS ALSO THE INSTRUMENT THAT FOUND A BUG.
      //   `matched` sites whose `drive_status` is null are the only ones a rerun is
      //   expected to move; stating it as a derived count means a client can add the
      //   four drive piles plus this one and get `matched` back. It read **−3** the
      //   first time it was computed, which no amount of reading the response could
      //   explain and one `GROUP BY geocode_status, drive_status` did — three rows were
      //   in two piles at once. **A count derived from a definition is a check on the
      //   data, not a restatement of it, and the impossible value was the only signal
      //   that anything was wrong.**
      awaitingDistance: matched - withDistance - outsideUs - unclassified - noRoute,
    },
  };
}

/**
 * A `vendor_site_route` row — plus the pin it was measured from.
 *
 * ★ THE PIN IS IN THIS ROW LIST ON PURPOSE, AND IT IS NOT DECORATION. A route is
 *   measured **from a pin**, so a route row whose site no longer has one is the exact
 *   contradiction `readSiteGeo` refuses to serve a distance for — and the same shape
 *   has already occurred in the store for distances (three `po_box` rows kept a
 *   `drive_*` stamp from when they were `matched`). One statement reads both, so the
 *   gate below costs nothing rather than a second round trip.
 *
 * ★ LOWER CASE, FOR THE SAME REASON `GeoRow` IS. The app store is SQLite/libSQL and
 *   the ledger is Oracle; reading `row.VENDOR_SITE_ID` here would be `undefined`, and
 *   an `undefined` id with no row is indistinguishable from "this site was never
 *   routed". Mirror the store's own spelling.
 */
interface RouteRow {
  vendor_site_id: unknown;
  route_status: unknown;
  route_reason: unknown;
  route_miles: unknown;
  route_minutes: unknown;
  route_origin_slug: unknown;
  geometry: unknown;
  steps: unknown;
  step_count: unknown;
  route_at: unknown;
  geocode_status: unknown;
  latitude: unknown;
  longitude: unknown;
}

/**
 * Read one site's stored road route, with its turns.
 *
 * ★ WHY THIS IS A SEPARATE READ FROM `readSiteGeo` AND NOT A FIELD ON IT. The register
 *   endpoint publishes `geo.sites[]` for **all 800 sites on every page load**; a stored
 *   route is 12.6 KB, so putting the line and its turns there would add ~10 MB to the
 *   first paint of a page whose map is closed. The distance belongs on the register —
 *   it is one number and the panel's caption needs it — and the geometry belongs here,
 *   where it is fetched once for the one site a reader opened.
 *
 * ★ FOUR ANSWERS, AND THREE OF THEM ARE NOT FAILURES. `ok` has a line. `no_route` is
 *   the routing service's answer for this pair and is permanent. `error` is an attempt
 *   that failed and is retryable. **Null is "no row is stored"** — the step has not
 *   reached this site. `readStoredPins` means the step resumes rather than restarting,
 *   so null is expected to shrink and a client that prints it as "there is no road"
 *   has turned "nobody has looked" into a fact about the world.
 *
 * ★ AND A FIFTH: `unpinned`. A stored row whose site has since lost its coordinate is
 *   reported under its own status rather than as null, because *the row exists and is
 *   being withheld* is a different fact from *there is no row* — and folding the two
 *   together is how the stranded-distance note ended up permanently silent. It is
 *   also the one pile a rerun is expected to move in the other direction: the step
 *   skips sites without a pin, so this row waits for the geocode step to re-pin the
 *   site.
 */
async function readSiteRoute(siteId: number): Promise<Record<string, unknown>> {
  const shell = (
    status: string | null,
    reason: string | null,
    note: string | null,
  ): Record<string, unknown> => ({
    siteId,
    status,
    reason,
    miles: null,
    minutes: null,
    originSlug: null,
    geometry: null,
    steps: null,
    stepCount: null,
    routeAt: null,
    note,
  });

  let rows: RouteRow[];
  try {
    const res = await storeDriver('app').execute({
      sql:
        'SELECT r.VENDOR_SITE_ID, r.ROUTE_STATUS, r.ROUTE_REASON, r.ROUTE_MILES, r.ROUTE_MINUTES,' +
        ' r.ROUTE_ORIGIN_SLUG, r.GEOMETRY, r.STEPS, r.STEP_COUNT, r.ROUTE_AT,' +
        ' g.GEOCODE_STATUS, g.LATITUDE, g.LONGITUDE' +
        ' FROM vendor_site_route r' +
        ' LEFT JOIN vendor_site_geo g ON g.VENDOR_SITE_ID = r.VENDOR_SITE_ID' +
        ' WHERE r.VENDOR_SITE_ID = :id',
      args: { id: siteId },
    });
    rows = res.rows as unknown as RouteRow[];
  } catch (err) {
    const app = storeDriver('app');
    throw AppError.dbUnavailable(
      `The app store (${app.dialect}) did not answer the routing table, so the road route for ` +
        `site ${siteId} cannot be shown. Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const row = rows[0];
  if (row === undefined) {
    return shell(
      null,
      null,
      'No road route is stored for this site. The routing step fills these in a few hundred at a ' +
        'time, so an absent row means it has not reached this site yet. The `By road` figure above ' +
        'comes from a different API and is unaffected.',
    );
  }

  // ★ THE SAME GATE `readSiteGeo` APPLIES TO A DISTANCE, APPLIED TO THE LINE THE
  //   DISTANCE BELONGS TO. A route is measured from a pin; if this payload has no pin,
  //   it cannot serve a line that starts at one. The writer already refuses to create
  //   the contradiction, and this is the layer that stops an existing one being served
  //   — two layers, two jobs, neither able to do the other's.
  const pinStatus = textOf(row.geocode_status) ?? '';
  const pinned =
    pinStatus === 'matched' &&
    numOrNull(row.latitude) !== null &&
    numOrNull(row.longitude) !== null;
  const stored = textOf(row.route_status) ?? '';

  if (!pinned) {
    return shell(
      'unpinned',
      null,
      `A route is stored for this site (status \`${stored}\`) but its coordinate has been ` +
        `withdrawn since — the geocoding row now reads \`${pinStatus || 'no row'}\`. A route is ` +
        'measured from a pin, so the line is withheld rather than drawn from a point this payload ' +
        'does not have. Re-running the geocode step will either restore the pin or leave the route ' +
        'waiting.',
    );
  }

  if (stored !== 'ok') {
    return shell(
      stored === 'no_route' || stored === 'error' ? stored : 'error',
      textOf(row.route_reason) ??
        `the stored status is \`${stored || 'empty'}\`, which is not a route`,
      null,
    );
  }

  /**
   * ★ THE TWO JSON COLUMNS ARE PARSED HERE, NOT IN THE BROWSER. A malformed blob is a
   *   defect in this store, and the place to find out is the endpoint that reads it —
   *   `JSON.parse` in a React component throws inside a render, which in this app means
   *   a blank page and a console error nobody is looking at. Parsed defensively, and a
   *   bad blob is reported as `error` with the reason, because that is exactly what it
   *   is: this route cannot be served.
   */
  let geometry: number[][] | null = null;
  let steps: Record<string, unknown>[] | null = null;
  try {
    const parsedGeometry: unknown = typeof row.geometry === 'string' ? JSON.parse(row.geometry) : null;
    if (!Array.isArray(parsedGeometry)) {
      throw new Error('the `geometry` column is not a JSON array');
    }
    // ★ EVERY PAIR IS CHECKED, AND A LINE NEEDS TWO OF THEM. A one-point `LineString`
    //   draws nothing while the panel claims a route exists — a blank map under a
    //   confident caption, which is the worst of both. Checked on the read path as well
    //   as at the point of the write, because the store can already hold a row the
    //   write guard was not present for.
    const pairs: number[][] = [];
    for (const pair of parsedGeometry) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const lng = numOrNull(pair[0]);
      const lat = numOrNull(pair[1]);
      if (lng === null || lat === null) continue;
      if (lng < -180 || lng > 180 || lat < -90 || lat > 90) continue;
      pairs.push([lng, lat]);
    }
    if (pairs.length < 2) {
      throw new Error(`the geometry holds ${pairs.length} usable coordinate pair(s), fewer than the 2 a line needs`);
    }
    geometry = pairs;

    const parsedSteps: unknown = typeof row.steps === 'string' ? JSON.parse(row.steps) : null;
    if (parsedSteps !== null && !Array.isArray(parsedSteps)) {
      throw new Error('the `steps` column is not a JSON array');
    }
    if (Array.isArray(parsedSteps)) {
      // ★ THE PROJECTION IS REBUILT FIELD BY FIELD RATHER THAN PASSED THROUGH, AND THAT
      //   IS WHAT STOPS A STORED BLOB FROM DECIDING THE API'S SHAPE. `z.object` strips
      //   keys it does not declare — silently — so a blob that acquired a ninth field
      //   would lose it here with no error, and one that *renamed* a field would arrive
      //   as `undefined` on a client that then printed a blank. Reading each field by
      //   name from the parsed object makes an unexpected blob visible as nulls instead
      //   of as a shape the schema does not describe.
      steps = parsedSteps.map((raw) => {
        const s = (raw ?? {}) as Record<string, unknown>;
        return {
          instruction: textOf(s.instruction) ?? 'Continue',
          name: textOf(s.name),
          distanceMiles: numOrNull(s.distance_miles),
          durationMinutes: numOrNull(s.duration_minutes),
          type: textOf(s.type),
          modifier: textOf(s.modifier),
          longitude: numOrNull(s.longitude),
          latitude: numOrNull(s.latitude),
        };
      });
    }
  } catch (err) {
    return shell(
      'error',
      `the stored route for this site cannot be read: ${err instanceof Error ? err.message : String(err)}`,
      'This is a defect in the stored row, not in the road. Re-running the routing step for this ' +
        'site rewrites it.',
    );
  }

  return {
    siteId,
    status: 'ok',
    reason: textOf(row.route_reason),
    miles: numOrNull(row.route_miles),
    minutes: numOrNull(row.route_minutes),
    originSlug: textOf(row.route_origin_slug),
    geometry,
    steps,
    stepCount: numOrNull(row.step_count),
    routeAt: textOf(row.route_at),
    note:
      steps !== null && numOrNull(row.step_count) !== null && steps.length !== numOrNull(row.step_count)
        ? `The stored step count (${numOrNull(row.step_count)}) disagrees with the number of steps in ` +
          'this row, so the count column is stale rather than the list being short.'
        : null,
  };
}

// ─── 6. The router ────────────────────────────────────────────────────────────

/**
 * The register's own endpoint.
 *
 * ★ THE PATH IS `/api/vendor-site-register` AND NOT `/api/vendor-sites/register`, WHICH
 *   IS THE OBVIOUS NAME AND IS A COLLISION. `registerResource()` in `routes/vendors.ts`
 *   already mounts the generic site domain at `/api/vendor-sites` with
 *   `GET {basePath}/{id}` — so `/api/vendor-sites/register` would be answered by the
 *   resource's **id** route and would fail with a `400` ("`register` is not an integer
 *   id") rather than a 404. Registering this one first would win the match, but that
 *   makes correctness depend on the order of two lines in `routes/index.ts`, and the
 *   comment on that file says registration order does not affect routing. A literal
 *   sibling path keeps that true.
 */
export function vendorSitesRouter(): Router {
  const api = createApi();

  api.route({
    method: 'get',
    path: '/api/vendor-site-register',
    operationId: 'getVendorSiteRegister',
    summary: 'Vendor sites named by an in-scope purchase order, with order counts and committed dollars',
    tags: ['Vendors'],
    // ★ 503 AND NOT 404: this route exists in every mode, but it can only be served from
    //   the live ledger — the frozen extract carries no site id at all, so there is
    //   nothing to fall back to and nothing partial to serve. `errors: [500, 503]` is
    //   the house pair for that, matching the three EBS-view descriptors.
    errors: [500, 503],
    response: RegisterSchema,
    description: [
      'The address level under a vendor company, as a **register** rather than a directory.',
      '',
      '`PO_VENDOR_SITES_ALL` holds 99,316 rows across 79,590 vendors on this instance — every address any',
      'vendor has ever registered. Listing that is not useful, because the question at this level is not',
      '*what addresses exist* but *where this organization’s money was actually sent*. So this endpoint',
      'returns the sites **named by an in-scope purchase order**: one row per site with its address, its',
      'vendor, how many in-scope orders named it, and the committed dollars on those orders.',
      '',
      '★ **THE SCOPE IS THE EXTRACT’S SCOPE, IMPORTED RATHER THAN RE-STATED.** The fund / program /',
      'fiscal-floor predicate comes from `scopeClause()`, which `routes/extract.ts` builds for its own',
      'query — so the two readers cannot drift into describing different populations. The extract reads',
      'distributions; this reads (site, order) pairs. Measured through that one predicate on the shipped',
      'organization — **fund `04`, programs `861`/`862`/`863`, fiscal floor `2021-07-01`**',
      '(`start_fy = 2022`) — the two agree to the cent:',
      '',
      '| grain | sites | orders | lines | committed |',
      '| --- | --- | --- | --- | --- |',
      '| this endpoint, (site, order) | 800 · 715 vendors | 5,692 | 31,401 | $2,797,825,956.73 |',
      '| the extract, distribution | — | 5,692 | 31,401 | $2,797,825,956.73 |',
      '',
      'The 31,670 distribution rows behind those 31,401 lines are the same money once more: a line can carry',
      'more than one distribution.',
      '',
      '★ **THOSE FIGURES ARE A FUNCTION OF THE TENANT, NOT CONSTANTS.** Move `start_fy` in Settings and the',
      'population moves with it — the identical query, same fund and same programs, at the previous floor:',
      '',
      '| fiscal floor | sites | orders | committed |',
      '| --- | --- | --- | --- |',
      '| `2021-07-01` (`start_fy = 2022`) | 800 | 5,692 | $2,797,825,956.73 |',
      '| `2022-07-01` (`start_fy = 2023`) | 704 | 4,206 | $2,697,813,470.53 |',
      '',
      'Quote a count with its settings or not at all. (Program `863` holds no rows in this scope — the',
      'extract reports it as a `scopeMismatch` — so the floor is the whole of the difference between the two',
      'lines above.)',
      '',
      '── `status`, and why the obvious rule for “deprecated” is empty ──',
      '',
      '★ **A `DO NOT USE` SITE CODE MATCHES ZERO OF THESE 800 ROWS.** The natural reading of “deprecated”',
      'is the site code — Oracle shops park the literal text `DO NOT USE` there — and measured against',
      'this scope it matches **nothing**, before or after stripping spaces, dashes and underscores. That is',
      'a property of the data: the directory holds **669** such codes across **567** vendors, **342** of',
      'them are named by *some* purchase order, and **not one** is named by an in-scope order. The fiscal',
      'floor and the program filter between them exclude the entire class. **A scope narrow enough to be',
      'useful is also narrow enough to exclude a whole kind of row.** The `directory` block reports those',
      'figures so a client can explain the tab rather than show it empty.',
      '',
      'Three other signals were measured, and a site is deprecated when **any** of them fires. Every row',
      'names the ones that did, in words, with the evidence attached (`retired 2026-09-19`) — a row can',
      'carry more than one, and one row carries all three:',
      '',
      '| signal | sites | orders | committed |',
      '| --- | --- | --- | --- |',
      "| `PURCHASING_SITE_FLAG = 'N'` | 6 | 108 | $4,829,603.18 |",
      '| `INACTIVE_DATE IS NOT NULL` | 35 | 219 | $38,199,948.83 |',
      '| the vendor is named `DO NOT USE` | 1 | 81 | $4,433,380.94 |',
      '| **union — a site counted once** | **39** | **243** | **$38,567,580.12** |',
      '| **active** | **761** | **5,449** | **$2,759,258,376.61** |',
      '',
      'The signals sum to 42 sites and 408 orders against a union of 39 and 243, because they overlap: 37',
      'deprecated rows carry exactly one reason, one carries two (site 651458) and one carries all three',
      '(site 12364).',
      '',
      '★ **`deprecated` IS A DESCRIPTION, NOT AN EXCLUSION.** Those 39 sites carry 243 real orders and',
      '$38.6M of committed money — 1.38% of everything this endpoint returns. Site 12364 alone — the only',
      'row whose *vendor* is literally named `DO NOT USE - PERFECTION EQUIPMENT CO INC`, and the only row',
      'where all three signals coincide — carries 81 orders worth $4,433,380.94. They are separated for',
      'readability and are included in every total the endpoint returns. The deprecated rows also span',
      '2021-07-06 → 2026-07-02, so the tab is not a list of old activity either.',
      '',
      '── What is returned, and what it declines to claim ──',
      '',
      '`sites` is one row per site; `orders` is one row per (site, order) pair **for the same rows**. Both',
      'are returned because the site-level figures *are* the fold of the order-level ones, and a client',
      'that wants to show a site’s orders should not have to issue a second query that could then',
      'disagree with the totals above it.',
      '',
      '★ **A SITE’S `amount` IS THE SUM OF ITS ORDERS’ *IN-SCOPE* LINES, NOT THE SUM OF THEIR WHOLE',
      'TOTALS.** Measured: 139 of the 5,692 in-scope orders also carry lines charged outside the scope, so',
      'those orders contribute less here than they would to a page that summed them whole. The register',
      'total is therefore strictly less than “the sum of these orders” — that is the scope working, not a',
      'reconciliation failure.',
      '',
      '★ **26 OF THE 800 SITES CARRY ORDERS AND NO IN-SCOPE MONEY** (215 of the 5,692 order rows are `0`).',
      'A `$0.00` beside a real order count is a true statement about where those lines were charged, and a',
      'client should say so rather than render it as a blank.',
      '',
      '★ **ADDRESSES ARE SPARSE AND THE SPARSENESS IS REPORTED.** 624 of 800 sites have no `ADDRESS_LINE2`',
      'and 794 have no `ADDRESS_LINE3`; 373 have no phone and 372 no area code; 2 have no state and 1 more',
      'carries the literal string `CANADA` where a two-letter code belongs. Cities measure 351 distinct',
      'values and 342 after upper-casing — 9 groups split by case alone, which is why a city filter has to',
      'be described as approximate.',
      '',
      '★ **THE ROW KEY IS (vendor, site code), NOT THE CODE.** 5 codes in this register are drawn by two',
      'different vendors each, which is 10 sites, so a lookup keyed on the code alone would silently merge',
      'two sites. `counts.sitesSharingACodeWithAnotherVendor` reports the SITE count, not the code count.',
      '',
      '★ **`counts.sitesWhoseOrderVendorDiffers` IS CHECKED, NOT ASSUMED.** A site records its own',
      '`VENDOR_ID`, and its orders record theirs on the header. This endpoint takes the *site’s* vendor for',
      'the join and counts the rows where the two disagree — measured 0 — rather than trusting that they',
      'match: a page printing a company name from the site while counting orders from the header is',
      'asserting the two are the same company.',
      '',
      '★ **`/api/vendor-sites` IS A DIFFERENT ENDPOINT AND STILL SERVES THE DIRECTORY.** This path is a',
      'literal sibling rather than `/api/vendor-sites/register`, because the generic resource already owns',
      '`/api/vendor-sites/{id}` and would answer that path with a 400 about integer ids. Use the resource',
      'for a site by id or a site search; use this for the register.',
      '',
      '★ **NO FROZEN FALLBACK EXISTS FOR THIS ENDPOINT, AND THE 503 IS THE HONEST ANSWER.**',
      '`data/oracle/full-output.json` carries no `VENDOR_ID` and no `VENDOR_SITE_ID`, so it holds no site',
      'to group by and no vendor to name. Under a non-Oracle ledger — `DB_MODE=local`, the configuration',
      'every test runs under — this answers **503 `DB_UNAVAILABLE`** rather than 404 (the route does exist)',
      'or 500 (nothing is broken). It is impossible, not unimplemented.',
    ].join('\n'),
    handler: async () => {
      const ledger = db.stores().find((s) => s.id === 'ledger');
      if (ledger === undefined) {
        throw new AppError(500, 'INTERNAL', 'No ledger store is configured, so there is nothing to read.');
      }
      if (ledger.dialect !== 'oracle') {
        throw AppError.dbUnavailable(
          'The vendor site register is built from the ledger’s purchase orders, and the ledger is ' +
            `${ledger.dialect} (DB_MODE=${ledger.dialect === 'sqlite' ? 'local' : ledger.dialect}) — so ` +
            'there is no purchase order to read. Point the server at Oracle (`DB_MODE=oracle`, ' +
            '`ORACLE_THICK=1`) to serve this screen.',
          { dialect: ledger.dialect, store: ledger.label },
        );
      }

      const tenant = await defaultTenant();
      const since = fiscalFloor(tenant.startFy);
      const { sql, binds } = orderPairSql(tenant.programs);

      const pairResult = await storeDriver('ledger').execute({
        sql,
        args: { ...binds, fund: tenant.fund, since },
      });

      const pairs: Pair[] = pairResult.rows.map((row) => {
        const vendorName = textOf(row.VENDOR_NAME);
        const inactiveDate = textOf(row.INACTIVE_DATE);
        const rawFlag = textOf(row.PURCHASING_SITE_FLAG);
        const purchasingSiteFlag: 'Y' | 'N' | null =
          rawFlag === 'Y' || rawFlag === 'N' ? rawFlag : null;

        return {
          vendorSiteId: num(row.VENDOR_SITE_ID),
          siteCode: String(row.VENDOR_SITE_CODE ?? ''),
          vendorId: num(row.VENDOR_ID),
          headerVendorId: num(row.HEADER_VENDOR_ID),
          vendorName,
          addressLine1: textOf(row.ADDRESS_LINE1),
          addressLine2: textOf(row.ADDRESS_LINE2),
          addressLine3: textOf(row.ADDRESS_LINE3),
          city: textOf(row.CITY),
          state: textOf(row.STATE),
          zip: textOf(row.ZIP),
          areaCode: textOf(row.AREA_CODE),
          phone: textOf(row.PHONE),
          purchasingSiteFlag,
          inactiveDate,
          deprecatedReasons: deprecationReasons({ purchasingSiteFlag, inactiveDate, vendorName }),
          orderNumber: String(row.ORDER_NUMBER ?? ''),
          approvedDate: textOf(row.APPROVED_DATE),
          lineCount: num(row.LINE_COUNT),
          amount: num(row.AMOUNT),
        };
      });

      const folded = fold(pairs);
      const observed = observe(pairs, folded.sites, folded.counts.sitesSharingACodeWithAnotherVendor);

      const directoryResult = await storeDriver('ledger').execute({ sql: DIRECTORY_SQL });
      const dir = directoryResult.rows[0];
      if (dir === undefined) {
        // A bare `COUNT` over a `SELECT` always returns exactly one row, so this is a
        // wiring failure rather than an empty table — and defaulting to zeros would
        // print "0 DO-NOT-USE sites" beside a register that provably has 669, which is
        // the one wrong answer a scope note must never give.
        throw new AppError(
          500,
          'INTERNAL',
          'The directory cross-check returned no row, so its counts cannot be reported.',
        );
      }

      const directory = {
        rule:
          'VENDOR_SITE_CODE, upper-cased and stripped of spaces, dashes and underscores, containing DONOTUSE',
        sites: num(dir.SITES),
        vendors: num(dir.VENDORS),
        withAnyOrder: num(dir.WITH_ANY_ORDER),
        // ★ MEASURED FROM THE REGISTER ROWS ALREADY IN HAND, NOT ASKED OF THE DATABASE A
        //   SECOND TIME. "How many of the directory's DO-NOT-USE sites reached this
        //   register" is a fact about the rows in this response, so deriving it here
        //   removes the possibility of the two answers disagreeing.
        namedByAnInScopeOrder: folded.sites.filter((s) => DO_NOT_USE_RE.test(squash(s.siteCode)))
          .length,
      };

      // ★ THE JOIN HAPPENS HERE, IN TYPESCRIPT, AND NOWHERE ELSE. The register is in
      //   Oracle and the pins are in the app store; there is no statement that can span
      //   the two, so `VENDOR_SITE_ID` is the entire interface. Reading it *after* the
      //   fold means the key set is the register's own 800 sites and not a second
      //   opinion about what is in scope.
      const geo = await readSiteGeo(folded.sites.map((s) => s.vendorSiteId));

      return {
        sites: folded.sites.map((site) => ({
          vendorSiteId: site.vendorSiteId,
          siteCode: site.siteCode,
          vendorId: site.vendorId,
          vendorName: site.vendorName,
          addressLine1: site.addressLine1,
          addressLine2: site.addressLine2,
          addressLine3: site.addressLine3,
          city: site.city,
          state: site.state,
          zip: site.zip,
          areaCode: site.areaCode,
          phone: site.phone,
          purchasingSiteFlag: site.purchasingSiteFlag,
          inactiveDate: site.inactiveDate,
          orders: site.orders,
          amount: site.amount,
          status: site.status,
          deprecatedReasons: site.deprecatedReasons,
        })),
        orders: folded.orders,
        counts: folded.counts,
        totals: folded.totals,
        deprecatedSignals: folded.signals,
        directory,
        geo,
        scope: {
          slug: tenant.slug,
          name: tenant.name,
          fund: tenant.fund,
          programs: tenant.programs,
          startFy: tenant.startFy,
          from: since,
        },
        observed,
      };
    },
  });

  /**
   * ★ A LITERAL SIBLING OF `/api/vendor-site-register`, FOR THE REASON THAT PATH IS NOT
   *   `/api/vendor-sites/register`. `registerResource()` mounts `GET
   *   /api/vendor-sites/{id}` with an integer-id schema, so `/api/vendor-sites/route/…`
   *   would be answered by the resource's **id** route as a 400 about integer ids
   *   rather than by this endpoint. A sibling path keeps correctness independent of the
   *   order two lines happen to be registered in.
   */
  api.route({
    method: 'get',
    path: '/api/vendor-site-route/{id}',
    operationId: 'getVendorSiteRoute',
    summary: "One site's stored road route from the origin, as a line and its turns",
    tags: ['Vendors'],
    params: z.object({ id: IntParam }),
    response: SiteRouteSchema,
    // ★ NO 404, DELIBERATELY, AND IT IS STATED RATHER THAN LEFT TO BE DISCOVERED. The
    //   id is a `VENDOR_SITE_ID` off the register, and the routing table holds only
    //   sites that register named — so the two states a caller might want told apart,
    //   *no such site* and *this site has not been routed yet*, cannot be separated
    //   from this table, because the register's own scope predicate lives in the
    //   **ledger** and this read is from the **app store**. An unknown integer is
    //   therefore answered the same way an unrouted one is. The alternative — a ledger
    //   round trip per map panel — would make a working panel fail whenever the ledger
    //   did, to answer a question the client never asks.
    errors: [400, 500, 503],
    description: [
      'The road between the origin and **one** site: the polyline to draw, and the turns to read.',
      '',
      '★ **WHY THIS IS NOT FOLDED INTO THE REGISTER PAYLOAD.** A stored route is **12.6 KB**, and',
      '**90% of it is the turns** — 11,291 bytes of steps against 1,319 bytes of geometry, measured',
      'on the rows in this store. `GET /api/vendor-site-register` publishes `geo.sites[]` for all',
      '**800** sites on every page load, so moving this here would add roughly **10 MB** to the first',
      'paint of a register whose map is closed almost every time it is opened. The *distance* stays on',
      'the register, because it is one number the panel’s caption needs; the *line* is fetched once,',
      'for the one site whose panel a reader opened.',
      '',
      '── `status`, and the five answers it carries ──',
      '',
      '| `status` | `geometry` | means |',
      '| --- | --- | --- |',
      '| `ok` | the line | a route was measured and is stored |',
      '| `no_route` | null | the routing service answered `NoSegment` for this pair — **permanent, and not a failure** |',
      '| `error` | null | the attempt failed; retryable |',
      '| `unpinned` | null | a row is stored but the site’s coordinate was withdrawn since, so the line is withheld |',
      '| **null** | null | **no row is stored — the step has not reached this site** |',
      '',
      '★ **`null` AND `no_route` ARE THE TWO A READER MOST NEEDS KEPT APART, AND FOLDING THEM IS A',
      'LIE ABOUT A ROAD.** `no_route` is something the service said about this pair; `null` is a',
      'question nothing has asked. The routing step resumes — it reads the pins already stored and',
      'skips them — so a second pile is expected to shrink to nothing and the first never will. A',
      'client that renders both as *no road to this site* has turned *nobody has looked* into a fact',
      'about the world.',
      '',
      '★ **AND `unpinned` EXISTS BECAUSE THE STORE CAN ALREADY HOLD THAT ROW.** A route is measured',
      '*from a pin*; the same contradiction has already occurred here for distances, where three',
      '`po_box` rows kept a `drive_*` stamp from when they were `matched`. The routing step refuses to',
      'create it and this endpoint refuses to serve it — two layers, two jobs, neither able to do the',
      'other’s. The pin is read in the **same statement** as the route, so the gate costs no extra',
      'round trip.',
      '',
      '── ★ THE THIRD MILEAGE, AND WHY IT MUST BE NAMED ──',
      '',
      'The panel already prints two distances and this endpoint introduces a third. None of them is',
      'wrong; they are three different questions, and the figures say so:',
      '',
      '| field | source | answers |',
      '| --- | --- | --- |',
      '| `miles` here | **Directions** v5, `route.distance` | *how long is the line I am drawing* |',
      '| `geo.sites[].driveMiles` | **Matrix** v1 | *how far is it by road* |',
      '| (computed in the browser) | haversine over two points | *as the crow flies* |',
      '',
      'Measured on the sites carrying both API figures, Matrix and Directions **agree within one mile',
      'on only 11 of 24** and differ by as much as **34.48 mi**; on the five farthest sites Directions',
      'runs **2–20 mi below** Matrix (2,841.53 against 2,860.58; 2,859.18 against 2,877.50). A Matrix',
      'figure reproduced fresh from the API matched the stored value to **0.0049 mi**, so that gap is',
      '**not staleness** — the two endpoints measure different routes between the same two points and',
      'report different maxima. Print each figure beside the thing it measures, and never average',
      'them.',
      '',
      '── ★ WHAT THE LINE IS, AND WHAT IT IS NOT ──',
      '',
      '`geometry` is a `[longitude, latitude]` list from `overview=simplified`, which is the same road',
      'at display resolution: measured at 14 / 33 / 49 coordinates for routes that `overview=full`',
      'answers with 130 / 6,289 / 15,136 — 0.3 / 0.7 / 1.1 KB against 2.9 / 139.9 / 336.7 KB. At a',
      '220-pixel-tall map the two are indistinguishable, and the difference across 622 sites is about',
      '100 MB of detail nobody can see. **Both endpoints are in the list**, so the line reaches the',
      'pin and the origin and needs no second source.',
      '',
      '`steps` is the turn list in driving order, ending with the **zero-distance arrival step**. That',
      'last step is kept on purpose: it is the only sentence that says the reader has arrived, and',
      'dropping zero-distance steps — which looks like tidying — makes a complete list look like one',
      'that stopped mid-journey. Measured, the steps sum to the route’s own `miles` to within',
      '**0.001 mi**, which is what makes it honest to print a step’s own length beside the total.',
    ].join('\n'),
    handler: async (ctx) => readSiteRoute(ctx.params.id),
  });

  return api.router;
}
