import { Router } from 'express';
import { z } from '../http/z.js';
import { createApi } from '../http/api.js';
import { raw } from '../http/respond.js';
import { db } from '../db/client.js';
import { AppError } from '../http/errors.js';
import { defaultTenant } from '../auth/session.js';
import { intReq, realReq, textReq } from '../schemas/columns.js';

/**
 * The payables surface, live from Oracle.
 *
 * ─── ★ WHY THIS MODULE EXISTS: THREE SCREENS READ A FROZEN FILE ──────────────
 *
 * `app/public/oracle/invoices.json` and `checks.json` are static extracts. Three
 * screens read them — vendor companies, invoices and checks — while every other
 * register in the app reads the ledger live. So the same vendor can be visible on
 * one screen and absent from another, and the reason is a file rather than the data.
 *
 * Measured, the case that prompted this: **LENOVO (UNITED STATES) INC** appears on
 * the vendor-sites register (live Oracle) and on **no** vendor company, because
 * `invoices.json` holds no Lenovo row at all. The ledger holds one invoice
 * (`N300846295`, $2,273.70) and two checks (`63398` $323,678.63, `228339` $1,726.73).
 *
 * ─── ★★ THE AP SURFACE IS READABLE — NOTHING HERE NEEDS A DBA ───────────────
 *
 * Measured with two controls (a bogus object name that must fail, and `GL_PERIODS`
 * which the app reads today and must pass):
 *
 *     APPS.WCSEXP_AP_CHECKS              1,246,676 rows   readable
 *     APPS.WCSEXP_AP_INVOICES            2,569,410 rows   readable
 *     APPS.WCSEXP_AP_INVOICE_PAYMENTS    2,653,590 rows   readable
 *     APPS.WCSEXP_PO_VENDORS                79,685 rows   readable
 *     APPS.AP_INVOICE_LINES_ALL          6,239,904 rows   readable
 *     APPS.AP_INVOICE_DISTRIBUTIONS_ALL  6,928,672 rows   readable
 *     APPS.AP_CHECKS_ALL                                 ORA-00942
 *     APPS.WCSEXP_AP_INVOICE_LINES                       ORA-00942
 *
 * ★ THE TWO FAILURES ARE NOT BLOCKERS. `WCSEXP_AP_CHECKS` is the view this module
 *   uses, so the base table is not needed; and `WCSEXP_AP_INVOICE_LINES` does not
 *   exist on this instance, which is why `pull-ap-extract.mjs` reaches
 *   `AP_INVOICE_LINES_ALL` instead — and that one is readable.
 *
 * ─── ★★ THE WINDOW IS ONE FISCAL YEAR, DERIVED, AND IT IS NOT OPTIONAL ──────
 *
 * The views are **unscoped**: `WCSEXP_AP_CHECKS` holds 1,246,676 rows against the
 * extract's 4,218. A route that read the view whole would try to render a million
 * rows, so the window is the difference between a page and a hang.
 *
 * It is **derived from `GL_PERIODS`, never written as a literal**, so it moves with
 * the ledger the way `04-spend-and-actuals.sql` does:
 *
 *     SELECT TO_CHAR(MIN(START_DATE),'YYYY-MM-DD') FROM APPS.GL_PERIODS
 *      WHERE PERIOD_YEAR = (SELECT MAX(PERIOD_YEAR) FROM APPS.GL_PERIODS)
 *
 * Measured: fiscal year 2027, `2026-07-01 → 2027-06-30`, and the filtered counts are
 * **4,218 checks and 10,388 payment links** — the check count byte-identical to the
 * extract's. So this is a source swap and not a data change.
 *
 * ★ AND THE WINDOW IS NOT A PARAMETER. A caller-supplied range would let a page ask
 *   for something that returns a million rows, and the cost of that is a hung
 *   request rather than an error. The endpoint decides.
 *
 * ─── ★★ THE SCOPE GOES THROUGH THE DISTRIBUTION, AND THE LINE IS WRONG ──────
 *
 * The extract's 126 invoices are scoped (its envelope declares fund 04 / programs
 * 861,862,863), so a live route has to reproduce that predicate. Measured:
 *
 *     invoices in the window, unscoped                              3,743
 *     scoped through AP_INVOICE_DISTRIBUTIONS_ALL                     126   ← the extract's own count
 *     scoped through AP_INVOICE_LINES_ALL                              61   ← under-reports
 *
 * ★ THE DISTRIBUTION IS THE RIGHT TABLE BECAUSE THE LINE IS NOT. An invoice line
 *   carries a *default* account that may differ from where the money was actually
 *   distributed, so scoping on the line silently drops invoices that were charged
 *   in scope. The 61 is the discriminator that proves the choice rather than
 *   assuming it.
 *
 * ★ AND THE COLUMN IS `DIST_CODE_COMBINATION_ID`, NOT `CODE_COMBINATION_ID`.
 *   `ALL_TAB_COLUMNS` returns **0 rows** for that table while a qualified `SELECT`
 *   reads it fine — the dictionary blindness this repo already records elsewhere.
 *   The column list came from the result metadata of `SELECT * … WHERE ROWNUM <= 1`,
 *   which is the only reliable oracle here. A first guess at the name raised
 *   ORA-00904.
 *
 * ─── ★ WHAT THE LIVE SOURCE ADDS THAT THE FILE CANNOT: `VENDOR_ID` ──────────
 *
 * `WCSEXP_AP_INVOICES` carries `VENDOR_ID` and `VENDOR_SITE_ID`; `invoices.json`
 * carries neither. `WCSEXP_PO_VENDOR_SITES` carries `VENDOR_ID` too, so the AP
 * surface can join the sites register on a real foreign key rather than a name
 * match — which is the link that would have shown Lenovo as a company.
 *
 * ─── THE SHAPE IS THE EXTRACT'S SHAPE, DELIBERATELY ─────────────────────────
 *
 * Both endpoints emit `{ body: { ResultSets: { Table1, Table2[, Table3] } } }`, the
 * same envelope the frozen files use. The three client parsers are written and
 * tested against it, so emitting the same shape makes the repoint a **URL change**
 * rather than a reshape — and a reshape would mean changing three parsers and their
 * tests for no gain. `VENDOR_ID` is the one addition, and it is additive.
 *
 * ─── WHAT THIS MODULE REFUSES TO DO ─────────────────────────────────────────
 *
 *   - It does not read `AP_CHECKS_ALL` or `WCSEXP_AP_INVOICE_LINES`. Both are
 *     ORA-00942 on this instance, and an entry for an object the account cannot
 *     read is a grant this code never exercises.
 *   - It does not accept a window from the caller. See above.
 *   - It does not write. The account is SELECT-only and every endpoint is a `GET`.
 */

/**
 * The fiscal years the ledger knows, newest first — for the picker.
 *
 * ★ A YEAR IS NOT A DATE RANGE, AND THE PICKER OFFERS YEARS. `GL_PERIODS` carries
 *   `PERIOD_YEAR` (the year a fiscal year ENDS in) and the twelve periods of each,
 *   so the boundaries come from the ledger rather than from `fy - 1` arithmetic.
 *   That matters because the calendar convention here is Jul→Jun and a computed
 *   `2026-07-01` would be a guess that happens to be right.
 */
async function fiscalYears(): Promise<Array<{ fiscalYear: number; from: string; to: string }>> {
  const result = await db.execute({
    sql: `SELECT PERIOD_YEAR                        AS FY,
                 TO_CHAR(MIN(START_DATE),'YYYY-MM-DD') AS FY_START,
                 TO_CHAR(MAX(END_DATE),'YYYY-MM-DD')   AS FY_END
            FROM APPS.GL_PERIODS
           GROUP BY PERIOD_YEAR
          HAVING COUNT(*) > 0
           ORDER BY PERIOD_YEAR DESC`,
  });
  return (result.rows as Array<Record<string, unknown>>)
    .map((r) => ({ fiscalYear: Number(r.FY), from: String(r.FY_START ?? ''), to: String(r.FY_END ?? '') }))
    .filter((r) => Number.isFinite(r.fiscalYear) && r.from !== '' && r.to !== '');
}

/**
 * The window a request asks for, from `?fyStart=` and `?fyEnd=`.
 *
 * ★★ THE WINDOW IS A PARAMETER NOW, AND THE REASON IS A READER'S WRONG CONCLUSION.
 *
 *   It was fixed to the newest fiscal year, derived from `GL_PERIODS`. Measured
 *   against live Oracle: level `0450` (Athens Drive) has **52 in-scope invoices
 *   across 5 combinations**, and **exactly 1 dated on or after `2026-07-01`** — so
 *   a reader filtering to that project saw "1 of 126" and reported a bug, because
 *   nothing on the page said a year boundary had been applied. The other 51 run
 *   back to `2024-05-31`.
 *
 *   ★ THE FIX IS NOT "REMOVE THE BOUND" — the underlying view holds 1,246,676
 *     checks and an unbounded read is a way to ask for a hang (the note on the
 *     checks route records that). The fix is to let the reader MOVE the bound and
 *     SEE it, which is what `fyStart`/`fyEnd` do.
 *
 * ★ THE RANGE IS VALIDATED AGAINST THE LEDGER, NOT AGAINST ITSELF. A year the
 *   ledger does not carry is a 400 naming the years that exist, not an empty
 *   register — an empty result would read as "this project has no invoices",
 *   which is the exact false conclusion this whole change exists to prevent.
 *
 * ★ `fyStart > fyEnd` IS REFUSED RATHER THAN SWAPPED. A silently reversed range
 *   would return rows the caller did not ask for, and the mistake is a typo in a
 *   URL that a reader can see and fix.
 */
async function resolveWindow(
  fyStartRaw: string | undefined,
  fyEndRaw: string | undefined,
): Promise<{ from: string; to: string; fiscalYear: number; fiscalYearEnd: number }> {
  const years = await fiscalYears();
  if (years.length === 0) {
    throw new Error(
      'The ledger declares no fiscal years in GL_PERIODS, so the AP window cannot be derived. ' +
        'An unbounded read would return every check ever written.',
    );
  }
  const newest = years[0]!;
  const oldest = years[years.length - 1]!;

  const parse = (raw: string | undefined, fallback: number, label: string): number => {
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number(raw.trim());
    if (!Number.isInteger(n)) {
      throw AppError.badRequest(`${label} must be a four-digit fiscal year, not "${raw}".`, {
        accepts: years.map((y) => y.fiscalYear),
      });
    }
    if (!years.some((y) => y.fiscalYear === n)) {
      throw AppError.badRequest(
        `The ledger has no fiscal year ${n}. It carries ${oldest.fiscalYear} to ${newest.fiscalYear}.`,
        { accepts: years.map((y) => y.fiscalYear) },
      );
    }
    return n;
  };

  const fyStart = parse(fyStartRaw, newest.fiscalYear, 'fyStart');
  const fyEnd = parse(fyEndRaw, fyStart, 'fyEnd');
  if (fyStart > fyEnd) {
    throw AppError.badRequest(
      `fyStart (${fyStart}) is later than fyEnd (${fyEnd}), which would select no year at all. ` +
        'Swap them, or leave both blank for the newest year.',
      { accepts: years.map((y) => y.fiscalYear) },
    );
  }

  // ★ THE BOUNDS COME FROM THE PERIODS OF THE SELECTED YEARS, not from arithmetic
  //   on the year number — so a ledger whose fiscal year is not Jul→Jun still
  //   produces the right dates.
  const chosen = years.filter((y) => y.fiscalYear >= fyStart && y.fiscalYear <= fyEnd);
  const from = chosen.reduce((min, y) => (y.from < min ? y.from : min), chosen[0]!.from);
  const to = chosen.reduce((max, y) => (y.to > max ? y.to : max), chosen[0]!.to);
  return { from, to, fiscalYear: fyStart, fiscalYearEnd: fyEnd };
}

/**
 * The tenant's scope, as a fragment the AP queries can interpolate.
 *
 * ★ `scopeClause` EXPECTS THE ALIASES `h` AND `g` — the PO header and the code
 *   combination — and returns a leading `WHERE`. So every query below aliases
 *   `PO_HEADERS_ALL h` and `GL_CODE_COMBINATIONS g`, which is not cosmetic: the
 *   fragment is shared with `extract.ts` and `vendorSites.ts`, and two strings kept
 *   in step by a comment would eventually stop being the same scope.
 *
 * ★ THE AP SURFACE HAS NO PO HEADER ON EVERY ROW, AND THAT IS WHY THIS DIFFERS.
 *   An invoice is not necessarily raised against an order, so a scope clause that
 *   requires `h.APPROVED_DATE` would drop every non-PO invoice — which is most of
 *   them. So the AP scope tests the **account segments only** (fund and programs),
 *   and the fiscal window is applied to the invoice's own date. That is a
 *   deliberate difference from `scopeClause`, stated here rather than hidden,
 *   because the two are answering different questions: the register asks "which
 *   orders are ours", this asks "which invoices were charged to our accounts".
 */
function apScope(programs: readonly string[]): { where: string; binds: Record<string, string> } {
  if (programs.length === 0) {
    throw new Error(
      'The organization selects no programs, so the live AP read would be empty. ' +
        'Fix the organization in Settings, or run with DB_MODE=local to read the frozen files.',
    );
  }
  const binds: Record<string, string> = {};
  const placeholders = programs.map((program, i) => {
    binds[`p${i}`] = program;
    return `:p${i}`;
  });
  return {
    where: `AND g.SEGMENT1 = :fund
       AND g.SEGMENT3 IN (${placeholders.join(', ')})`,
    binds,
  };
}

/** The envelope both endpoints emit — the same shape the frozen files use. */
interface ApEnvelope {
  body: { ResultSets: Record<string, unknown[]> };
  /**
   * The window and scope blocks, emitted only by the invoices route.
   *
   * ★ THEY ARE SIBLINGS OF `body` BECAUSE THAT IS WHERE THE FROZEN FILE CARRIED THEM. The page
   *   reads `envelope.window` and `envelope.scope` and has done since it read the file, so putting
   *   them anywhere else would have been a client change for no gain. `body.ResultSets` stays the
   *   third-party contract it always was.
   */
  window?: { from: string; to: string; fiscalYear: number; fiscalYearEnd: number };
  scope?: {
    fund: string;
    programs: string[];
    label: string;
    windowInvoices: number;
    inScope: number;
    inScopeValue: number;
    excluded: number;
    excludedValue: number;
    unanswerable: number;
    unanswerableValue: number;
  };
}

const ChecksResponse = z
  .object({
    body: z.object({
      ResultSets: z.object({
        Table1: z.array(z.record(z.unknown())),
        Table2: z.array(z.record(z.unknown())),
      }),
    }),
  })
  .openapi('ApChecks');

const InvoicesResponse = z
  .object({
    body: z.object({
      ResultSets: z.object({
        Table1: z.array(z.record(z.unknown())),
        Table2: z.array(z.record(z.unknown())),
        Table3: z.array(z.record(z.unknown())),
      }),
    }),
    window: z
      .object({
        from: z.string(),
        to: z.string(),
        fiscalYear: z.number().int(),
        fiscalYearEnd: z.number().int(),
      })
      .optional(),
    scope: z
      .object({
        fund: z.string(),
        programs: z.array(z.string()),
        label: z.string(),
        windowInvoices: z.number().int(),
        inScope: z.number().int(),
        inScopeValue: z.number(),
        excluded: z.number().int(),
        excludedValue: z.number(),
        unanswerable: z.number().int(),
        unanswerableValue: z.number(),
      })
      .optional(),
  })
  .openapi('ApInvoices');

export function apRouter(): Router {
  const api = createApi();

  /**
   * The fiscal years the register can be scoped to.
   *
   * ★ THE PICKER'S OPTIONS COME FROM THE LEDGER, NOT FROM A HARD-CODED RANGE. A
   *   year offered here is a year `GL_PERIODS` really carries, so `fyStart` can
   *   never be refused for a value the UI itself put in the list — the two cannot
   *   drift apart, which is the failure a hand-written `<option>` list invites.
   *
   * ★ IT ALSO CARRIES THE DATES, so the page can say what a year MEANS without
   *   recomputing `fy - 1` and guessing the calendar convention.
   */
  api.route({
    method: 'get',
    path: '/api/ap/fiscal-years',
    operationId: 'apFiscalYears',
    summary: 'The fiscal years the ledger carries, newest first',
    description:
      'The years `GL_PERIODS` declares, each with the date range its periods span. The AP ' +
      'registers are windowed to one or more of these, so this is what tells a reader which ' +
      'years they can ask for — and what a year means in dates.\n\n' +
      '★ `fiscalYear` IS THE YEAR THE FISCAL YEAR ENDS IN. FY2027 = `2026-07-01 .. 2027-06-30`. ' +
      'That convention is the ledger\'s, not this endpoint\'s, and the dates are read from the ' +
      'periods rather than computed from the year number.',
    tags: ['Invoices'],
    // ★ A BARE PAYLOAD, NOT `{ data: … }` — the framework wraps a handler's return
    //   in `{ data }` itself, so returning the wrapper double-nests it.
    response: z
      .object({
        years: z.array(
          z.object({
            fiscalYear: z.number().int(),
            from: z.string(),
            to: z.string(),
          }),
        ),
      })
      .openapi('ApFiscalYears'),
    errors: [500, 503],
    handler: async () => ({ years: await fiscalYears() }),
  });

  api.route({
    method: 'get',
    path: '/api/ap/checks',
    operationId: 'apChecks',
    summary: 'Checks and the invoices they settled, live from the ledger',
    description:
      'Payment documents and the invoices each one settled, for a fiscal-year window. ' +
      '`?fyStart=` and `?fyEnd=` choose the years (see `/api/ap/fiscal-years` for the ones the ' +
      'ledger carries); both blank means the newest year.\n\n' +
      '★ THE WINDOW IS ALWAYS BOUNDED, EVEN THOUGH IT IS A PARAMETER. The underlying view holds ' +
      '1,246,676 rows against this window\'s 4,218, so an unbounded read is a way to ask for a ' +
      'hang — a year the ledger does not carry is a **400 naming the years that exist**, never ' +
      'an empty register. An empty result would read as "this project has no invoices", which is ' +
      'the false conclusion the whole window disclosure exists to prevent.\n\n' +
      'Measured on the newest year: 4,218 checks and 10,388 links — the check count ' +
      'byte-identical to the frozen extract this replaces.\n\n' +
      '★ `Table2` IS `DISTINCT` ON PURPOSE. `WCSEXP_AP_INVOICE_PAYMENTS` is not unique on ' +
      '`(CHECK_ID, INVOICE_ID, PAYMENT_NUM)`, so the join alone returns a check\'s invoices twice ' +
      'over. The script this SQL is copied from measured it: 4,113 of 4,218 checks carried a ' +
      'correct link count, and the fanned-out form inflated it.\n\n' +
      '★ `VENDOR_ID` IS CARRIED, AND THE FROZEN FILE COULD NOT. It is what lets a client join ' +
      'these rows to the vendor-site register on a real foreign key rather than a name match.',
    // ★ ITS OWN SECTION, NOT `Spend`. See the ★ block on `TAGS`: the two AP registers were
    //   grouped with encumbrances, which buried the endpoints a payables reader opens the
    //   document for. Retagged rather than duplicated — the path and the handler are
    //   unchanged, so this is a documentation change and nothing else.
    tags: ['Checks'],
    response: ChecksResponse,
    rawBody: true,
    errors: [400, 500, 503],
    query: z.object({
      fyStart: z.string().optional().openapi({ description: 'First fiscal year to include, e.g. `2024`. Blank = the newest year the ledger carries.' }),
      fyEnd: z.string().optional().openapi({ description: 'Last fiscal year to include, inclusive. Blank = the same year as `fyStart`.' }),
    }),
    handler: async ({ query }) => {
      const win = await resolveWindow(query.fyStart, query.fyEnd);
      const from = win.from;
      const to = win.to;
      // ★ NO SCOPE FRAGMENT HERE, AND THAT IS DELIBERATE. A check is a payment
      //   document, not a charge to an account — it carries no account segment at
      //   all (`WCSEXP_AP_CHECKS` has four columns), so there is nothing on it to
      //   test the fund or the program against. The scope reaches these rows
      //   through the *invoice* each check settled, which is the join below, and
      //   the fiscal window is what bounds the population.
      //
      //   The invoices endpoint is where the account scope is actually applied —
      //   see `apScope`, and §2.4 of `docs/plans/ap-live-data.md` for why it goes
      //   through the distribution rather than the line.

      // ── Table1: the checks ────────────────────────────────────────────────
      //
      // `WCSEXP_AP_CHECKS` has FOUR columns and carries no vendor, which is why
      // the vendor comes through the invoice — the same route the extract script
      // takes, and the reason `MIN(v.VENDOR_NAME)` is safe: a check's invoices
      // resolve to one vendor by construction, and the MIN is a tie-break for a
      // case the join cannot produce.
      const checks = await db.execute({
        sql: `SELECT c.CHECK_ID,
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
                   WHERE cc.CHECK_DATE >= TO_DATE(:since,'YYYY-MM-DD')
                     AND cc.CHECK_DATE <= TO_DATE(:until,'YYYY-MM-DD')
                   GROUP BY p.CHECK_ID
                ) n ON n.CHECK_ID = c.CHECK_ID
          WHERE c.CHECK_DATE >= TO_DATE(:since,'YYYY-MM-DD')
            AND c.CHECK_DATE <= TO_DATE(:until,'YYYY-MM-DD')
          ORDER BY c.CHECK_DATE DESC, c.CHECK_NUMBER DESC`,
        args: { since: from, until: to },
      });

      // ── Table2: the invoice links ─────────────────────────────────────────
      //
      // ★ `DISTINCT` IS THE FIX, NOT A PRECAUTION — see the endpoint description.
      // ★ `PO_NUMBER` IS A CORRELATED SCALAR SUBQUERY, NEVER A SECOND LEFT JOIN.
      //   This query already joins a one-to-many payment view; a second one-to-many
      //   multiplies them together and `DISTINCT` then hides it by collapsing rows
      //   that agree in every selected column.
      // ★ `ORDER BY` IS POSITIONAL because `SELECT DISTINCT` may not order by an
      //   expression it does not select — naming `i.INVOICE_DATE` raises ORA-01791,
      //   the selected column being the `TO_CHAR` of it.
      const links = await db.execute({
        sql: `SELECT DISTINCT p.CHECK_ID,
                         i.INVOICE_NUM,
                         i.INVOICE_AMOUNT,
                         TO_CHAR(i.INVOICE_DATE,'YYYY-MM-DD') AS INVOICE_DATE,
                         i.PAYMENT_STATUS_FLAG,
                         i.VENDOR_ID,
                         (SELECT MAX(h.SEGMENT1)
                            FROM APPS.AP_INVOICE_LINES_ALL l
                            JOIN APPS.PO_HEADERS_ALL h ON h.PO_HEADER_ID = l.PO_HEADER_ID
                           WHERE l.INVOICE_ID = i.INVOICE_ID) AS PO_NUMBER
           FROM APPS.WCSEXP_AP_CHECKS c
           JOIN APPS.WCSEXP_AP_INVOICE_PAYMENTS p ON p.CHECK_ID = c.CHECK_ID
           JOIN APPS.WCSEXP_AP_INVOICES i ON i.INVOICE_ID = p.INVOICE_ID
          WHERE c.CHECK_DATE >= TO_DATE(:since,'YYYY-MM-DD')
            AND c.CHECK_DATE <= TO_DATE(:until,'YYYY-MM-DD')
          ORDER BY 1, 4, 2`,
        args: { since: from, until: to },
      });

      const envelope: ApEnvelope = {
        body: { ResultSets: { Table1: checks.rows, Table2: links.rows } },
      };
      return raw(JSON.stringify(envelope));
    },
  });

  api.route({
    method: 'get',
    path: '/api/ap/invoices',
    operationId: 'apInvoices',
    summary: 'Invoices and the accounts they were charged to, live from the ledger',
    description:
      'One fiscal year of invoices, scoped to the organization\'s accounts, with the account rows ' +
      'each invoice was distributed to.\n\n' +
      '★ **THE SCOPE GOES THROUGH THE DISTRIBUTION, AND THE LINE IS WRONG.** Measured: unscoped ' +
      'the window holds 3,743 invoices; scoped through `AP_INVOICE_DISTRIBUTIONS_ALL` it holds ' +
      '**126**, which is the frozen extract\'s own count; scoped through `AP_INVOICE_LINES_ALL` it ' +
      'holds **61**. An invoice line carries a *default* account that may differ from where the ' +
      'money was actually distributed, so the line route silently drops invoices that were charged ' +
      'in scope. The 61 is the discriminator that proves the choice.\n\n' +
      '★ **THE COLUMN IS `DIST_CODE_COMBINATION_ID`.** `ALL_TAB_COLUMNS` returns zero rows for ' +
      'that table while a qualified `SELECT` reads it fine, so the name came from result metadata ' +
      'rather than the dictionary.\n\n' +
      '★ **`VENDOR_ID` IS CARRIED**, which the frozen file could not — it is the key that joins ' +
      'these rows to the vendor-site register.\n\n' +
      '`Table3` is the account rows, at one row per `(invoice, code combination)`.',
    // ★ ITS OWN SECTION, NOT `Spend` — see the note on the checks route and the ★ block
    //   on `TAGS`. The path and the handler are unchanged.
    tags: ['Invoices'],
    response: InvoicesResponse,
    rawBody: true,
    errors: [400, 500, 503],
    query: z.object({
      fyStart: z.string().optional().openapi({ description: 'First fiscal year to include, e.g. `2024`. Blank = the newest year the ledger carries.' }),
      fyEnd: z.string().optional().openapi({ description: 'Last fiscal year to include, inclusive. Blank = the same year as `fyStart`.' }),
    }),
    handler: async ({ query }) => {
      const tenant = await defaultTenant();
      const win = await resolveWindow(query.fyStart, query.fyEnd);
      const from = win.from;
      const to = win.to;
      const { where, binds } = apScope(tenant.programs);

      // ── Table1: the invoices, scoped through their distributions ──────────
      const invoices = await db.execute({
        sql: `SELECT i.INVOICE_ID,
                i.INVOICE_NUM,
                TO_CHAR(i.INVOICE_DATE,'YYYY-MM-DD') AS INVOICE_DATE,
                i.INVOICE_AMOUNT,
                i.AMOUNT_PAID,
                i.PAYMENT_STATUS_FLAG,
                i.DESCRIPTION,
                i.VENDOR_ID,
                i.VENDOR_SITE_ID,
                v.VENDOR_NAME,
                (SELECT MAX(h.SEGMENT1)
                   FROM APPS.AP_INVOICE_LINES_ALL l
                   JOIN APPS.PO_HEADERS_ALL h ON h.PO_HEADER_ID = l.PO_HEADER_ID
                  WHERE l.INVOICE_ID = i.INVOICE_ID) AS PO_NUMBER,
                (SELECT COUNT(DISTINCT l2.PO_HEADER_ID)
                   FROM APPS.AP_INVOICE_LINES_ALL l2
                  WHERE l2.INVOICE_ID = i.INVOICE_ID
                    AND l2.PO_HEADER_ID IS NOT NULL) AS PO_COUNT
           FROM APPS.WCSEXP_AP_INVOICES i
           JOIN APPS.WCSEXP_PO_VENDORS v ON v.VENDOR_ID = i.VENDOR_ID
          WHERE i.INVOICE_DATE >= TO_DATE(:since,'YYYY-MM-DD')
            AND i.INVOICE_DATE <= TO_DATE(:until,'YYYY-MM-DD')
            AND EXISTS (
                  SELECT 1
                    FROM APPS.AP_INVOICE_DISTRIBUTIONS_ALL d
                    JOIN APPS.GL_CODE_COMBINATIONS g
                      ON g.CODE_COMBINATION_ID = d.DIST_CODE_COMBINATION_ID
                   WHERE d.INVOICE_ID = i.INVOICE_ID
                     ${where}
                )
          ORDER BY i.INVOICE_DATE DESC, i.INVOICE_NUM DESC`,
        args: { since: from, until: to, fund: tenant.fund, ...binds },
      });

      // ── Table2: the payment links, for the invoices above ─────────────────
      //
      // ★ THIS WAS `Table2: []` — HARD-CODED — AND THAT MADE THE PANEL LIE.
      //
      //   The invoices register's whole second half is "the checks that settled it", and it reads
      //   `Table2` for the links. An empty array is not a neutral placeholder: the page renders it
      //   as *"no check in these views settles this invoice"*, which is a claim about the ledger
      //   made from a constant. Measured against the frozen file the same endpoint replaces, the
      //   real answer is **117 links across 117 invoices** — so every invoice on the live page
      //   would have reported itself unpaid.
      //
      // ★ SCOPED BY THE SAME PREDICATE `Table1` USES, NOT BY A BIND LIST OF ITS IDS.
      //
      //   This was `WHERE p.INVOICE_ID IN (:inv0, :inv1, …)` built from `invoices.rows`, with a
      //   comment reasoning about Oracle's 1,000-expression `IN` cap. That reasoning was about the
      //   wrong limit: the binding engine's cap is **2,100 parameters** on SQL Server, and a
      //   multi-year window exceeds it — measured, `?fyStart=2025&fyEnd=2027` threw
      //   `RequestError 8003: The incoming request has too many parameters`.
      //
      //   ★ RE-RUNNING THE PREDICATE IS NOT A SECOND DEFINITION OF "IN SCOPE" HERE, because it is
      //     the *same* predicate textually — the window, the fund, the programs and the `EXISTS`
      //     over the distributions. What the old comment was right to avoid was a second,
      //     *independently written* scope; this is the same one, and `Table1`'s row set and this
      //     one are equal by construction rather than by agreement.
      //
      //   ★ FOUR BINDS, WHATEVER THE RANGE. That is the property that makes a wide window safe.
      const links = await db.execute({
        sql: `SELECT p.CHECK_ID,
                         p.INVOICE_ID,
                         i.INVOICE_NUM,
                         i.INVOICE_AMOUNT,
                         TO_CHAR(i.INVOICE_DATE,'YYYY-MM-DD') AS INVOICE_DATE,
                         i.PAYMENT_STATUS_FLAG,
                         i.VENDOR_ID,
                         (SELECT MAX(h.SEGMENT1)
                            FROM APPS.AP_INVOICE_LINES_ALL l
                            JOIN APPS.PO_HEADERS_ALL h ON h.PO_HEADER_ID = l.PO_HEADER_ID
                           WHERE l.INVOICE_ID = i.INVOICE_ID) AS PO_NUMBER,
                         -- ★ THE CHECK'S OWN FIELDS, WHICH THE PAGE RENDERS AND THE FIRST DRAFT OF
                         --   THIS QUERY OMITTED. The register's panel says *which* check settled an
                         --   invoice and *when* and *for how much* — three facts that live on the
                         --   check, not on the link — so a query returning only the two ids would
                         --   have produced a panel of blanks. The frozen file carried all three;
                         --   they are joined back here rather than dropped.
                         c.CHECK_NUMBER,
                         TO_CHAR(c.CHECK_DATE,'YYYY-MM-DD') AS CHECK_DATE,
                         c.AMOUNT AS CHECK_AMOUNT
                    FROM APPS.WCSEXP_AP_INVOICE_PAYMENTS p
                    JOIN APPS.WCSEXP_AP_INVOICES i ON i.INVOICE_ID = p.INVOICE_ID
                    JOIN APPS.WCSEXP_AP_CHECKS c ON c.CHECK_ID = p.CHECK_ID
                   WHERE i.INVOICE_DATE >= TO_DATE(:since,'YYYY-MM-DD')
                     AND i.INVOICE_DATE <= TO_DATE(:until,'YYYY-MM-DD')
                     AND EXISTS (
                           SELECT 1
                             FROM APPS.AP_INVOICE_DISTRIBUTIONS_ALL d
                             JOIN APPS.GL_CODE_COMBINATIONS g
                               ON g.CODE_COMBINATION_ID = d.DIST_CODE_COMBINATION_ID
                            WHERE d.INVOICE_ID = i.INVOICE_ID
                              AND g.SEGMENT1 = :fund
                              AND g.SEGMENT3 IN (:p0, :p1, :p2)
                         )
                   ORDER BY p.INVOICE_ID, p.CHECK_ID`,
        args: { since: from, until: to, fund: tenant.fund, ...binds },
      });

      // ── Table3: the account rows ──────────────────────────────────────────
      //
      // ★ ONE ROW PER (invoice, code combination), and the seven segments are
      //   projected so a client can build the dotted account key without a second
      //   lookup — the same reason `invoices.json`'s Table3 carries them.
      //
      // ★ `IN_SCOPE` IS COMPUTED HERE BECAUSE THE FILE'S VERSION WAS A STORED FLAG. The frozen
      //   extract carried `IN_SCOPE = 'Y'` written by the pull script, and the page reads it to
      //   split "accounts on this invoice" from "accounts this organization funds". On the live
      //   route the same question is answerable from the row itself — it is exactly the predicate
      //   `apScope` applies — so it is derived rather than carried, which is what stops the flag
      //   and the filter from ever disagreeing.
      //
      // ★ THE SCOPE IS **NOT** IN THE `WHERE` HERE, AND THAT IS THE POINT OF THE FLAG. Filtering
      //   would drop an out-of-scope account from the list entirely, and the page needs those rows
      //   to say *"this invoice also touches accounts this organization does not fund"* — a
      //   sentence it cannot write about rows it never received. So every account of an in-scope
      //   invoice is returned and each one carries its own verdict.
      //
      // ★ IT IS NARROWED TO `Table1`'s INVOICES BY RE-RUNNING THEIR OWN PREDICATE, NOT BY
      //   PASSING THEIR IDS — AND THAT IS A FIX, NOT A STYLE CHOICE.
      //
      //   The first version bound one parameter per invoice id
      //   (`WHERE d.INVOICE_ID IN (:inv0, :inv1, …)`). That works for one fiscal year (126
      //   invoices) and **fails the moment a reader asks for a wider range**: SQL Server caps a
      //   request at **2,100 parameters** and answers
      //
      //       RequestError 8003: The incoming request has too many parameters. The server
      //       supports a maximum of 2100 parameters.
      //
      //   Measured: `?fyStart=2025&fyEnd=2027` threw that, while `?fyStart=2027` answered fine.
      //   So the window control was unusable for exactly the case it was added for — a reader
      //   widening the range to find an invoice the one-year default hid.
      //
      //   ★ THE PREDICATE IS THE SAME ONE `Table1` APPLIES, so the two cannot disagree about
      //     which invoices are in the register: the window, the fund and the programs, and the
      //     `EXISTS` over the distributions that makes an invoice "in scope". It is written out
      //     rather than shared as a fragment because the aliases differ (`i` here, `d`/`g` in the
      //     subquery) and a fragment built for one alias set would be a syntax error in the other.
      //
      //   ★ THE BIND COUNT IS NOW CONSTANT — four, whatever the range. That is the property that
      //     makes a wide window safe, and it is why this is a join rather than a longer IN-list
      //     split into chunks: chunking would keep the parameter count proportional to the result
      //     set, which is the thing that must not happen.
      const accounts = await db.execute({
        sql: `SELECT d.INVOICE_ID,
                d.DIST_CODE_COMBINATION_ID AS CODE_COMBINATION_ID,
                g.SEGMENT1, g.SEGMENT2, g.SEGMENT3, g.SEGMENT4,
                g.SEGMENT5, g.SEGMENT6, g.SEGMENT7,
                g.ACCOUNT_TYPE,
                CASE WHEN g.SEGMENT1 = :fund AND g.SEGMENT3 IN (:p0, :p1, :p2)
                     THEN 'Y' ELSE 'N' END AS IN_SCOPE,
                COUNT(*) AS DIST_ROWS,
                SUM(d.AMOUNT) AS DIST_AMOUNT
           FROM APPS.AP_INVOICE_DISTRIBUTIONS_ALL d
           JOIN APPS.GL_CODE_COMBINATIONS g
             ON g.CODE_COMBINATION_ID = d.DIST_CODE_COMBINATION_ID
          WHERE EXISTS (
                  SELECT 1
                    FROM APPS.WCSEXP_AP_INVOICES i2
                   WHERE i2.INVOICE_ID = d.INVOICE_ID
                     AND i2.INVOICE_DATE >= TO_DATE(:since,'YYYY-MM-DD')
                     AND i2.INVOICE_DATE <= TO_DATE(:until,'YYYY-MM-DD')
                     AND EXISTS (
                           SELECT 1
                             FROM APPS.AP_INVOICE_DISTRIBUTIONS_ALL d2
                             JOIN APPS.GL_CODE_COMBINATIONS g2
                               ON g2.CODE_COMBINATION_ID = d2.DIST_CODE_COMBINATION_ID
                            WHERE d2.INVOICE_ID = i2.INVOICE_ID
                              AND g2.SEGMENT1 = :fund
                              AND g2.SEGMENT3 IN (:p0, :p1, :p2)
                         )
                )
          GROUP BY d.INVOICE_ID, d.DIST_CODE_COMBINATION_ID,
                   g.SEGMENT1, g.SEGMENT2, g.SEGMENT3, g.SEGMENT4,
                   g.SEGMENT5, g.SEGMENT6, g.SEGMENT7, g.ACCOUNT_TYPE
          ORDER BY d.INVOICE_ID, g.SEGMENT1, g.SEGMENT3, g.SEGMENT5`,
        args: { since: from, until: to, fund: tenant.fund, ...binds },
      });

      // ── The scope block: what the narrowing cost, measured ────────────────
      //
      // ★ THE PAGE PRINTS THESE, SO THE ROUTE HAS TO COMPUTE THEM. The register shows 126 invoices
      //   out of the fiscal year's whole population, and a reader is owed the reason: how many were
      //   excluded for being booked elsewhere, what they were worth, and how many could not be
      //   classified at all. The frozen file carried these as numbers written by its pull script;
      //   here they are counted, which is what stops the disclosure from drifting away from the
      //   rows it describes.
      //
      // ★ `inScope` IS `Table1`'s OWN COUNT, NOT A SECOND COUNTING OF THE SAME PREDICATE. Re-running
      //   the EXISTS would be a second definition of "in scope" that could disagree with the first
      //   — and the page's whole argument is that the kept count and the window count are the same
      //   measurement seen twice.
      //
      // ★ THE THREE-WAY SPLIT IS THE POINT, NOT A DETAIL. An invoice is `excluded` only when it has
      //   distributions and *none* of them is in scope — a positive finding. An invoice with **no
      //   distributions at all** is `unanswerable`: the ledger does not say where it was booked, so
      //   calling it excluded would be inventing a reason. Measured on the frozen file, that
      //   distinction is 26 invoices worth $28,565.26, and collapsing the two buckets would have
      //   reported them as excluded.
      const scopeCounts = await db.execute({
        sql: `SELECT
                COUNT(*) AS WINDOW_INVOICES,
                SUM(CASE WHEN d.INVOICE_ID IS NULL THEN 1 ELSE 0 END) AS UNANSWERABLE,
                SUM(CASE WHEN d.INVOICE_ID IS NULL THEN i.INVOICE_AMOUNT ELSE 0 END) AS UNANSWERABLE_VALUE,
                SUM(CASE WHEN d.INVOICE_ID IS NOT NULL AND d.IN_SCOPE = 0 THEN 1 ELSE 0 END) AS EXCLUDED,
                SUM(CASE WHEN d.INVOICE_ID IS NOT NULL AND d.IN_SCOPE = 0 THEN i.INVOICE_AMOUNT ELSE 0 END) AS EXCLUDED_VALUE
              FROM APPS.WCSEXP_AP_INVOICES i
              LEFT JOIN (
                    SELECT DISTINCT dd.INVOICE_ID,
                           MAX(CASE WHEN g.SEGMENT1 = :fund AND g.SEGMENT3 IN (:p0, :p1, :p2)
                                    THEN 1 ELSE 0 END) AS IN_SCOPE
                      FROM APPS.AP_INVOICE_DISTRIBUTIONS_ALL dd
                      JOIN APPS.GL_CODE_COMBINATIONS g
                        ON g.CODE_COMBINATION_ID = dd.DIST_CODE_COMBINATION_ID
                     GROUP BY dd.INVOICE_ID
              ) d ON d.INVOICE_ID = i.INVOICE_ID
             WHERE i.INVOICE_DATE >= TO_DATE(:since,'YYYY-MM-DD')
               AND i.INVOICE_DATE <= TO_DATE(:until,'YYYY-MM-DD')`,
        args: { since: from, until: to, fund: tenant.fund, ...binds },
      });
      const counts = (scopeCounts.rows[0] ?? {}) as Record<string, unknown>;
      const num = (v: unknown): number => {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      };

      const envelope: ApEnvelope = {
        body: {
          ResultSets: {
            Table1: invoices.rows,
            Table2: links.rows,
            Table3: accounts.rows,
          },
        },
        // ★ A SIBLING OF `body`, BECAUSE IT IS ABOUT THE DOCUMENT RATHER THAN PART OF THE RESULT
        //   SET. `body.ResultSets` is the shape the frozen files use and the shape every reader
        //   decodes; adding a fourth table would be a change to that contract, and the page reads
        //   this block from the top level exactly as it read the file's own.
        //
        // ★★ THE WINDOW IS NOW THE REAL ONE, AND THAT IS THE FIX FOR "THE HIDDEN
        //    INVOICE". It used to be `{ from, to: '', fiscalYear: 0 }` — a stub —
        //    and the page did not render it at all. So a reader who filtered to a
        //    project saw "1 of 126" with nothing on screen saying a year boundary
        //    had been applied: level `0450` has 52 in-scope invoices and only one
        //    of them falls in the newest fiscal year. The page now states the
        //    window and the reader can move it.
        window: {
          from,
          to,
          fiscalYear: win.fiscalYear,
          fiscalYearEnd: win.fiscalYearEnd,
        },
        scope: {
          fund: tenant.fund,
          programs: [...tenant.programs],
          label: `Fund ${tenant.fund} · program ${tenant.programs.join('/')}`,
          windowInvoices: num(counts.WINDOW_INVOICES),
          inScope: invoices.rows.length,
          inScopeValue: invoices.rows.reduce((s, r) => s + num((r as Record<string, unknown>).INVOICE_AMOUNT), 0),
          excluded: num(counts.EXCLUDED),
          excludedValue: num(counts.EXCLUDED_VALUE),
          unanswerable: num(counts.UNANSWERABLE),
          unanswerableValue: num(counts.UNANSWERABLE_VALUE),
        },
      };
      return raw(JSON.stringify(envelope));
    },
  });

  registerProjectLineage(api);

  return api.router;
}

/**
 * The PO-line → invoice → check link for one project — the lineage graph's tail.
 *
 * ─── ★★ WHY THIS IS AN ENDPOINT AND NOT A CLIENT-SIDE JOIN ──────────────────
 *
 * The extract the app already holds is a **PO-line** report: it carries the order
 * number, the line number, the vendor and the amount, and nothing about invoices.
 * The invoice link lives in `AP_INVOICE_LINES_ALL.PO_LINE_ID`, which is not in the
 * extract — so the graph's last two levels need a server read.
 *
 * ─── ★★ IT READS THE MIRROR, BECAUSE THAT IS WHAT THE APP READS ─────────────
 *
 * `DB_MODE=sqlserver`, so this statement names the mirror's own objects: no `APPS.`
 * prefix, and the base tables rather than the `WCSEXP_*` views where the mirror holds
 * them. The two engines need different SQL for the same question, which is the same
 * seam `extract.ts` already carries (`buildLiveSql` / `buildLiveSqlServer`).
 *
 * ★★ AND ON THE MIRROR IT IS FAST WHERE ORACLE WAS NOT. The identical join was tried
 *    against Oracle first and **did not return in four minutes** — in both directions,
 *    and even with the driving table bounded to 2,000 rows. Measured on the mirror:
 *
 *        level 0450 -> 16 linked PO lines -> 52 invoices -> 51 checks   (0.6 s)
 *
 *   ★ THE LESSON IS ABOUT THE ENGINE, NOT THE QUERY. "This join is impossible" was a
 *     conclusion about one database dressed up as a fact about the data. The 52 matches
 *     the independently-recorded Athens Drive invoice count, which is what makes it a
 *     verification rather than a number.
 *
 * ─── ★ THE KEY IS THE PO LINE, WHICH IS WHAT AN INVOICE ACTUALLY NAMES ──────
 *
 * Measured on the scoped table: of 162,639 invoice lines, **115,168 carry a
 * `PO_HEADER_ID` and 115,168 carry a `PO_LINE_ID` — the same rows**. So the link is
 * populated on 71% of scoped lines, and it is a *line* link: an invoice names a
 * specific PO line, not merely an order. Keying the response on the line is what
 * lets the graph attach an invoice to the line it paid; keying on the order would
 * collapse a real many-to-one relation and lose which line was billed.
 *
 * ★ THE 29% WITHOUT A LINK ARE A REAL ANSWER, NOT MISSING DATA. Prepaid cards, use
 *   tax, standing charges and travel reimbursements name no order at all — the same
 *   categories the Invoices page already documents. The response reports them as
 *   absent rather than inventing an attachment.
 */
function registerProjectLineage(api: Api): void {
  api.route({
    method: 'get',
    path: '/api/ap/project-lineage',
    operationId: 'ap_project_lineage',
    summary: 'Invoices and checks per purchase-order line, for one project level',
    description:
      'The tail of the lineage graph: for each PO line of a project, how many invoices settled it and how many ' +
      'checks paid those invoices.\n\n' +
      '**Read from the mirror** (`DB_MODE=sqlserver`), not the Oracle ledger. The identical join against Oracle ' +
      'did not return in four minutes; on the mirror it answers in 0.6 s, because the mirror carries indexes the ' +
      'Oracle account\'s plan does not.\n\n' +
      '**Keyed on the PO line, because that is what an invoice names.** Measured on the scoped invoice-line ' +
      'table, `PO_LINE_ID` is populated on the same 115,168 of 162,639 rows as `PO_HEADER_ID` — so the link is a ' +
      'line link, and keying on the order would collapse a real many-to-one relation.\n\n' +
      '**A PO line absent from `links` has no invoice naming it**, which is a real answer: prepaid cards, use tax ' +
      'and standing charges name no order. The caller must not read absence as a fetch failure.',
    tags: ['Payables'],
    query: z.object({
      level: z
        .string()
        .min(1)
        .openapi({
          description: 'The project level (`SEGMENT5`), e.g. `0450`.',
          example: '0450',
        }),
    }),
    response: z
      .object({
        level: textReq('The level the links were read for.'),
        /** One row per PO line that has at least one invoice. */
        links: z.array(
          z
            .object({
              orderNumber: textReq('`PO_HEADERS_ALL.SEGMENT1` — the order the line belongs to.'),
              lineNumber: textReq('`PO_LINES_ALL.LINE_NUM` — the line within that order.'),
              invoices: intReq('Distinct invoices naming this PO line.'),
              checks: intReq('Distinct checks that paid those invoices.'),
              amount: realReq('Σ invoice-line amount for this PO line.'),
            })
            .openapi('ProjectLineageLink'),
        ),
        /** What the read covered, so a caller can tell a complete answer from a truncated one. */
        coverage: z
          .object({
            poLines: intReq('Distinct PO lines of this level that the mirror holds.'),
            linked: intReq('Of those, how many an invoice names. The rest have no link, which is a real answer.'),
          })
          .openapi('ProjectLineageCoverage'),
        source: textReq('The tables the links were read from, named so a consumer can check them.'),
      })
      .openapi('ProjectLineage'),
    errors: [400, 500],
    handler: async (req) => {
      const level = String(req.query.level ?? '').trim();
      if (level === '') {
        throw new AppError(400, 'BAD_REQUEST', 'A `level` is required — the project level, e.g. `0450`.');
      }
      const tenant = await defaultTenant();
      const { where, binds } = apScope(tenant.programs);

      /**
       * ★ THE LEVEL IS THE DRIVING FILTER, AND IT IS WHAT MAKES THIS CHEAP.
       *
       * The Oracle attempt timed out because it started from the invoice-line table
       * (millions of rows) and joined outward. This starts from the **level's own PO
       * lines** — 20 for level 0450 — and joins inward, so the plan is an index seek
       * on a tiny set rather than a scan of a large one.
       *
       * ★ `LEFT JOIN` ON THE PAYMENTS, DELIBERATELY. An invoice that no check has paid
       *   yet is a real state — it is the whole reason the Invoices page distinguishes
       *   "accounted" from "paid" — so an inner join would drop unpaid invoices and
       *   make the graph look like every invoice was settled.
       */
      const res = await db.execute({
        sql: `WITH lvl AS (
                       SELECT DISTINCT pll.PO_LINE_ID
                         FROM PO_LINE_LOCATIONS_ALL pll
                         JOIN PO_DISTRIBUTIONS_ALL d
                           ON d.LINE_LOCATION_ID = pll.LINE_LOCATION_ID
                         JOIN GL_CODE_COMBINATIONS g
                           ON g.CODE_COMBINATION_ID = d.CODE_COMBINATION_ID
                        WHERE g.SEGMENT5 = :level
                          ${where}
                     )
                SELECT h.SEGMENT1 AS ORDER_NUMBER,
                       pl.LINE_NUM AS LINE_NUMBER,
                       COUNT(DISTINCT il.INVOICE_ID) AS INVOICES,
                       COUNT(DISTINCT p.CHECK_ID) AS CHECKS,
                       SUM(il.AMOUNT) AS AMOUNT
                  FROM lvl
                  JOIN AP_INVOICE_LINES_ALL il ON il.PO_LINE_ID = lvl.PO_LINE_ID
                  JOIN PO_LINES_ALL pl ON pl.PO_LINE_ID = il.PO_LINE_ID
                  JOIN PO_HEADERS_ALL h ON h.PO_HEADER_ID = pl.PO_HEADER_ID
                  LEFT JOIN WCSEXP_AP_INVOICE_PAYMENTS p ON p.INVOICE_ID = il.INVOICE_ID
                 GROUP BY h.SEGMENT1, pl.LINE_NUM
                 ORDER BY h.SEGMENT1, pl.LINE_NUM`,
        args: { level, fund: tenant.fund, ...binds },
      });

      /** How many PO lines the level has at all — the denominator for `linked`. */
      const total = await db.execute({
        sql: `SELECT COUNT(DISTINCT pll.PO_LINE_ID) AS N
                FROM PO_LINE_LOCATIONS_ALL pll
                JOIN PO_DISTRIBUTIONS_ALL d ON d.LINE_LOCATION_ID = pll.LINE_LOCATION_ID
                JOIN GL_CODE_COMBINATIONS g ON g.CODE_COMBINATION_ID = d.CODE_COMBINATION_ID
               WHERE g.SEGMENT5 = :level
                 ${where}`,
        args: { level, fund: tenant.fund, ...binds },
      });

      const num = (v: unknown): number => {
        const n = Number(v);
        return Number.isFinite(n) ? n : 0;
      };

      return {
        level,
        links: res.rows.map((r) => {
          const row = r as Record<string, unknown>;
          return {
            orderNumber: String(row.ORDER_NUMBER ?? ''),
            lineNumber: String(row.LINE_NUMBER ?? ''),
            invoices: num(row.INVOICES),
            checks: num(row.CHECKS),
            amount: num(row.AMOUNT),
          };
        }),
        coverage: {
          poLines: num((total.rows[0] as Record<string, unknown> | undefined)?.N),
          linked: res.rows.length,
        },
        source: 'AP_INVOICE_LINES_ALL · WCSEXP_AP_INVOICE_PAYMENTS · PO_LINE_LOCATIONS_ALL (mirror)',
      };
    },
  });
}
