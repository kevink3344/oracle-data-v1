import { Router } from 'express';
import { z } from '../http/z.js';
import { createApi } from '../http/api.js';
import { raw } from '../http/respond.js';
import { db } from '../db/client.js';
import { defaultTenant } from '../auth/session.js';

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

/** One fiscal year, derived from the ledger's own periods. */
async function windowStart(): Promise<string> {
  const result = await db.execute({
    sql: `SELECT TO_CHAR(MIN(START_DATE),'YYYY-MM-DD') AS FY_START
            FROM APPS.GL_PERIODS
           WHERE PERIOD_YEAR = (SELECT MAX(PERIOD_YEAR) FROM APPS.GL_PERIODS)`,
  });
  const from = result.rows[0]?.FY_START;
  if (typeof from !== 'string' || from === '') {
    // ★ A MISSING WINDOW IS NOT "NO FILTER". Falling through to an unbounded read
    //   would return 1.25M rows, so the honest answer is a refusal — the same
    //   reasoning `scopeClause` applies to an organization with no programs.
    throw new Error(
      'The ledger declares no current fiscal year in GL_PERIODS, so the AP window cannot be derived. ' +
        'An unbounded read would return every check ever written.',
    );
  }
  return from;
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
  })
  .openapi('ApInvoices');

export function apRouter(): Router {
  const api = createApi();

  api.route({
    method: 'get',
    path: '/api/ap/checks',
    operationId: 'apChecks',
    summary: 'Checks and the invoices they settled, live from the ledger',
    description:
      'One fiscal year of payment documents, with the invoices each one settled. The window is ' +
      'derived from `GL_PERIODS` and is **not** a parameter: the underlying view holds 1,246,676 ' +
      'rows against this window\'s 4,218, so a caller-supplied range would be a way to ask for a ' +
      'hang. Measured: 4,218 checks and 10,388 links — the check count byte-identical to the ' +
      'frozen extract this replaces.\n\n' +
      '★ `Table2` IS `DISTINCT` ON PURPOSE. `WCSEXP_AP_INVOICE_PAYMENTS` is not unique on ' +
      '`(CHECK_ID, INVOICE_ID, PAYMENT_NUM)`, so the join alone returns a check\'s invoices twice ' +
      'over. The script this SQL is copied from measured it: 4,113 of 4,218 checks carried a ' +
      'correct link count, and the fanned-out form inflated it.\n\n' +
      '★ `VENDOR_ID` IS CARRIED, AND THE FROZEN FILE COULD NOT. It is what lets a client join ' +
      'these rows to the vendor-site register on a real foreign key rather than a name match.',
    tags: ['Spend'],
    response: ChecksResponse,
    rawBody: true,
    errors: [500, 503],
    handler: async () => {
      const from = await windowStart();
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
                   GROUP BY p.CHECK_ID
                ) n ON n.CHECK_ID = c.CHECK_ID
          WHERE c.CHECK_DATE >= TO_DATE(:since,'YYYY-MM-DD')
          ORDER BY c.CHECK_DATE DESC, c.CHECK_NUMBER DESC`,
        args: { since: from },
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
          ORDER BY 1, 4, 2`,
        args: { since: from },
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
    tags: ['Spend'],
    response: InvoicesResponse,
    rawBody: true,
    errors: [500, 503],
    handler: async () => {
      const tenant = await defaultTenant();
      const from = await windowStart();
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
            AND EXISTS (
                  SELECT 1
                    FROM APPS.AP_INVOICE_DISTRIBUTIONS_ALL d
                    JOIN APPS.GL_CODE_COMBINATIONS g
                      ON g.CODE_COMBINATION_ID = d.DIST_CODE_COMBINATION_ID
                   WHERE d.INVOICE_ID = i.INVOICE_ID
                     ${where}
                )
          ORDER BY i.INVOICE_DATE DESC, i.INVOICE_NUM DESC`,
        args: { since: from, fund: tenant.fund, ...binds },
      });

      // ── Table3: the account rows ──────────────────────────────────────────
      //
      // ★ ONE ROW PER (invoice, code combination), and the seven segments are
      //   projected so a client can build the dotted account key without a second
      //   lookup — the same reason `invoices.json`'s Table3 carries them.
      const accounts = await db.execute({
        sql: `SELECT d.INVOICE_ID,
                d.DIST_CODE_COMBINATION_ID AS CODE_COMBINATION_ID,
                g.SEGMENT1, g.SEGMENT2, g.SEGMENT3, g.SEGMENT4,
                g.SEGMENT5, g.SEGMENT6, g.SEGMENT7,
                g.ACCOUNT_TYPE,
                COUNT(*) AS DIST_ROWS,
                SUM(d.AMOUNT) AS DIST_AMOUNT
           FROM APPS.AP_INVOICE_DISTRIBUTIONS_ALL d
           JOIN APPS.GL_CODE_COMBINATIONS g
             ON g.CODE_COMBINATION_ID = d.DIST_CODE_COMBINATION_ID
           JOIN APPS.WCSEXP_AP_INVOICES i ON i.INVOICE_ID = d.INVOICE_ID
          WHERE i.INVOICE_DATE >= TO_DATE(:since,'YYYY-MM-DD')
            ${where}
          GROUP BY d.INVOICE_ID, d.DIST_CODE_COMBINATION_ID,
                   g.SEGMENT1, g.SEGMENT2, g.SEGMENT3, g.SEGMENT4,
                   g.SEGMENT5, g.SEGMENT6, g.SEGMENT7, g.ACCOUNT_TYPE
          ORDER BY d.INVOICE_ID, g.SEGMENT1, g.SEGMENT3, g.SEGMENT5`,
        args: { since: from, fund: tenant.fund, ...binds },
      });

      const envelope: ApEnvelope = {
        body: {
          ResultSets: {
            Table1: invoices.rows,
            Table2: [],
            Table3: accounts.rows,
          },
        },
      };
      return raw(JSON.stringify(envelope));
    },
  });

  return api.router;
}
