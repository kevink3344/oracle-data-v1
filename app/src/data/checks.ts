/**
 * The AP checks register — read live from the ledger at `/api/ap/checks`.
 *
 * One fiscal year of `AP_CHECKS`: 4,218 checks carrying 9,451 invoice links. The window is DERIVED
 * from `GL_PERIODS` by the server, so the response carries the dates it covers and this module
 * reports them rather than the page assuming a range.
 *
 * ★ THE WINDOW IS A DEFAULT THE PAGE PICKS, NOT A CONSTANT THE LEDGER IMPOSES, and that is the fix
 *   for *"we are only showing Checks for the current fiscal year"*. With no parameters the route
 *   answers the **newest** year it carries, so a tenant whose organization starts in FY2022 was
 *   searching a register that had been cut to FY2027 — and the only hint was the phrase "in this
 *   window" inside the no-match message. `loadChecks` now takes a range and both registers open on
 *   the organization's `Start FY`; see `data/fiscalWindow.ts` for how that floor is chosen.
 *
 * ★ IT USED TO READ `data/oracle/checks.json`, AND IT NO LONGER DOES. The frozen file was a
 *   point-in-time snapshot — its window ends `2026-08-11` — so a page built on it described a
 *   register the ledger had already moved past. The live route returns a byte-identical shape
 *   (verified field by field), which is what made the swap a URL change rather than a rewrite.
 *
 * ── WHY IT IS FETCHED HERE AND NOT IN THE STORE ──────────────────────────────
 *
 * The purchase-order extract loads at start-up because every screen reads it.
 * Only this screen reads checks, and the payload is ~2 MB, so it is fetched when * the page opens and lives in that page's own state. A reader who never opens
 * Checks never pays for it.
 *
 * ── WHY THE TWO RESULT SETS ARE JOINED ONCE, AT LOAD ─────────────────────────
 *
 * Checks and their invoices arrive flat, both keyed on `CHECK_ID`. The join is
 * done here rather than at render because the panel opens per row, and scanning
 * 9,451 links for each is work a table does not need to repeat.
 *
 * ── AND WHY A CHECK IS NOT AN INVOICE ────────────────────────────────────────
 *
 * The relation is many-to-many and nothing here may pretend otherwise. 3,172 of
 * the 4,218 checks carry exactly one invoice, but the largest carries 269. A
 * screen that assumed one-to-one would silently drop the invoices of every check
 * in the tail — the rows where a reader most needs the itemisation.
 *
 * ── WHAT IS *NOT* ASSERTED ───────────────────────────────────────────────────
 *
 * That a check's invoices sum to its amount. It is true on 4,140 of 4,218
 * (98.2%), and the 78 that disagree are real — a credit note, a discount, a
 * withholding. Every one of the 78 falls SHORT; none is over. That direction is
 * worth keeping in view, because a check can pay invoices that another check
 * part-paid first, but no check can pay out more than it issued. So the panel
 * PRINTS both figures and their difference instead of quietly showing one of
 * them as if it were the other.
 */

import { readTrace, sqlUrl } from './sqlTrace';
import type { SqlTrace } from '../components/SqlNote';

/** A row as it lands in the checks response → `.body.ResultSets.Table1`. */
interface RawCheck {
  CHECK_ID: number;
  CHECK_NUMBER: number | string;
  CHECK_DATE: string;
  AMOUNT: number | string;
  VENDOR_NAME: string | null;
}

/** A row as it lands in `.body.ResultSets.Table2`. */
interface RawInvoiceLink {
  CHECK_ID: number;
  INVOICE_NUM: string;
  INVOICE_AMOUNT: number | string;
  INVOICE_DATE: string;
  PAYMENT_STATUS_FLAG: string | null;
  /**
   * The order this invoice was raised against, or `null` where none was.
   *
   * ★ OPTIONAL BECAUSE AN EXTRACT WRITTEN BEFORE THIS COLUMN EXISTED HAS NO
   *   `PO_NUMBER` ON ANY LINK — and that is not the same fact as every invoice
   *   naming no order. `undefined` means *the file cannot answer*; `null` means
   *   *the ledger answered, and the answer is "no order"*. Reading the first as
   *   the second would print "no order was raised" on 9,451 rows of an extract
   *   that was never asked. `ordersMeasured` below carries the distinction, and
   *   the panel renders "not measured" rather than a blank in that case.
   *
   * The column is a base-table join the WCSEXP views do not carry —
   * `AP_INVOICE_LINES_ALL.PO_HEADER_ID → PO_HEADERS_ALL.SEGMENT1`, because the
   * invoice header's own PO_HEADER_ID is NULL on every row. See the header of
   * `server/scripts/pull-ap-extract.mjs`.
   */
  PO_NUMBER?: string | null;
}

export interface ChecksEnvelope {
  body: { ResultSets: { Table1: RawCheck[]; Table2: RawInvoiceLink[] } };
  /**
   * The window the server applied, as a sibling of `body`.
   *
   * ★ OPTIONAL BECAUSE IT IS OPTIONAL ON THE WIRE, not because it may be ignored. The route did not
   *   send this block at all until the fiscal-year default was added — it is the same defect the
   *   invoices route had already fixed — so the field is declared optional and the reader below
   *   falls back to the dates the rows themselves span. Same shape as `loadInvoices`. `0` on either
   *   year means the server declared none, which is rendered as "no year to name", never as year
   *   zero.
   */
  window?: { from?: string; to?: string; fiscalYear?: number; fiscalYearEnd?: number };
}

/**
 * One invoice a check paid.
 *
 * `amount` may be NEGATIVE. 274 of the 9,451 links are: a credit note is still
 * an invoice and still appears on the payment, so the sign is carried through
 * rather than folded into an absolute value that would make the totals wrong.
 */
export interface CheckInvoice {
  number: string;
  amount: number;
  date: string;
  /** `Y` accounted, `N` not — the only status the view carries. */
  accounted: boolean;
  /**
   * The order this invoice was raised against, or `null` where none was.
   *
   * ★ The empty state is the DOMINANT state: measured over this extract, 1,426
   *   of 9,451 links (15.1%) name an order and 8,025 do not. That is a real
   *   answer and not a gap, and it was measured rather than assumed — the 8,025
   *   span 2,408 vendors and their invoice numbers label themselves
   *   (`TRAV/063026`, `PARENT STIPEND 06.24.26`, `LOCAL/ March 2026ADJ`):
   *   reimbursements, stipends and journal adjustments are not purchases and have
   *   no order to name, and the largest of the rest are utilities and standing
   *   service contracts billed to an account. So the panel names the case rather
   *   than leaving a blank a reader would read as missing data.
   *
   * ★ `null` is "the ledger says no order", never "the file could not say".
   *   When the extract predates the column every value is `null`, so the panel
   *   checks `ordersMeasured` on the extract before trusting any of them.
   */
  po: string | null;
}

export interface Check {
  /** `CHECK_ID`. The row key: `CHECK_NUMBER` is not unique across the ledger. */
  id: number;
  number: string;
  date: string;
  amount: number;
  vendor: string;
  invoices: CheckInvoice[];
  /** The invoices' own total, signed. Compared against `amount`, never merged with it. */
  invoiced: number;
}

export interface ChecksExtract {
  /** Newest first. */
  checks: Check[];
  /** Checks whose invoices sum to the check exactly — what the page prints. */
  reconciled: number;
  /**
   * The fiscal years this register was **asked** for, carried on the response itself.
   *
   * ★ IT IS THE DECLARED WINDOW, NOT THE SPAN THE ROWS HAPPEN TO COVER, and the difference is the
   *   whole point. A reader hunting a 2023 check needs to know which years this register was given,
   *   not the earliest date it happened to return — the second is narrower than the first whenever
   *   a year holds no checks, and reporting it as the window would turn "we asked for FY2022–2027"
   *   into the false claim "this register starts in 2023".
   *
   * `0` on either year means the server declared none, which the page renders as "no year to name"
   * rather than as year zero. Field for field the same as `InvoicesExtract.window`.
   */
  window: { from: string; to: string; fiscalYear: number; fiscalYearEnd: number };
  /**
   * The dates actually present in the rows, which are narrower than the bound.
   *
   * ★ IT WAS CALLED `window` UNTIL THE WINDOW BECAME A CHOICE, AND THE RENAME IS THE HONESTY. It
   *   was the measured span of the newest year's rows reporting itself as *the* window, because
   *   there was only ever one window and nobody had asked for a different one.
   */
  observed: { from: string; to: string };
  links: number;
  /**
   * Whether this extract carries the order column at all.
   *
   * ★ The guard for the stale-extract case, and the reason it is a flag rather
   *   than a count: an extract written before the column existed answers `null`
   *   for every link, which is indistinguishable from "not one of these 9,451
   *   invoices named an order". One of those two statements is a measurement and
   *   the other is a fabrication, and only this flag tells them apart. Derived
   *   from the rows — so re-pointing the page at a fresh extract cannot leave it
   *   claiming a measurement the file does not carry.
   */
  ordersMeasured: boolean;
  /**
   * Links that name an order, and how many there are — **derived from the rows
   * loaded**, never restated from the file's own `po` block.
   *
   * The panel uses it to say, of a check whose invoices name nothing, that the
   * rest of the extract is in the same position — which is the difference
   * between an empty column that looks broken and one that is explained. It is
   * the extract's population, a different basis from the panel's per-check
   * count, and the two are labelled as such where they appear.
   */
  orders: { named: number; links: number };
  /**
   * Whether this register is the live ledger. Always `true` now — the file arm is gone.
   *
   * ★ IT IS KEPT AS A FIELD RATHER THAN DELETED SO A PAGE THAT ASKS "is this live?" DOES NOT HAVE
   *   TO BE EDITED IN THE SAME BREATH. Nothing reads it today; it is the one field that would let a
   *   future page distinguish a live read from a snapshot without re-deriving that from the URL.
   */
  live: true;
  /**
   * The statements the server ran, when the reader has the SQL trace switched on.
   *
   * ★ IT IS THE REAL TRACE, NOT A DESCRIPTION OF ONE. Now that this page reads a route rather than
   *   a file there is a statement behind every figure, and it is the same text the database
   *   received — the `GL_PERIODS` read that derives the window, then the checks-and-links query.
   *   `null` with the toggle off, which is the ordinary case.
   */
  traces: SqlTrace | null;
}

/**
 * The live ledger route. There is no file fallback — see the note on `loadChecks`.
 *
 * ★ THE RESPONSE SHAPE IS BYTE-IDENTICAL TO THE FROZEN FILE IT REPLACES, which is what made this
 *   repoint a URL change rather than a rewrite. Verified field by field against
 *   `app/public/oracle/checks.json`: same `body.ResultSets.Table1` / `Table2`, same 12 keys in the
 *   same order, same 4,218 checks and 9,451 links. The route was built as a drop-in for exactly
 *   this swap.
 */
const URL = '/api/ap/checks';

/**
 * A figure, or 0 — never `NaN`.
 *
 * The generator asserts every amount is present, so this floor should never
 * fire. It exists because one malformed row would otherwise turn a whole column
 * of figures into `NaN`, which reads as a broken screen rather than as one bad
 * link. A row that trips it shows up as a check that does not reconcile, and the
 * panel says so.
 */
const figure = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * The register URL for a fiscal-year range.
 *
 * ★ THE RANGE IS A QUERY PARAM, NOT A SECOND ENDPOINT, so the SQL trace flag and the window
 *   compose in one URL. `sqlUrl` owns the trace flag; this adds the years and leaves it alone.
 *   The same helper shape exists in `data/invoices.ts` for the same reason.
 *
 * ★ AN ABSENT RANGE SENDS NO PARAMS AT ALL, AND THAT IS NOT THE SAME AS "NO WINDOW". It asks the
 *   server for its own default — the newest year it carries — which is what this page did before
 *   the window became a choice, and therefore the correct degradation for a ledger whose year list
 *   could not be read. Sending `fyStart=<newest>` explicitly would work and would freeze the
 *   default in the client, so a ledger that gained a year would keep opening on the old one.
 */
function registerUrl(fy?: { start: number; end: number }): string {
  const base = sqlUrl(URL);
  if (!fy) return base;
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}fyStart=${fy.start}&fyEnd=${fy.end}`;
}

export async function loadChecks(
  signal?: AbortSignal,
  fy?: { start: number; end: number },
): Promise<ChecksExtract> {
  const res = await fetch(registerUrl(fy), { signal });
  if (!res.ok) {
    /**
     * ★ THE REFUSAL NAMES THE LEDGER, BECAUSE THAT IS NOW THE ONLY SOURCE.
     *
     *   This used to fall back to `checks.json`. That file is a snapshot: its window ends
     *   2026-08-11 and the table has moved on, so a fallback would have shown a reader a
     *   *different* register under a heading describing the live one. The user's instruction is
     *   explicit — every entity reads Oracle, none reads a json file — and a failure that says so
     *   is better than a page that quietly answers from a stale copy.
     */
    let detail = `HTTP ${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = body.error.message;
    } catch {
      /* The status line stands. */
    }
    throw new Error(
      `The checks register could not be read from the ledger (${detail}). This page reads Oracle ` +
        `directly and has no snapshot to fall back to.`,
    );
  }

  const envelope = (await res.json()) as ChecksEnvelope;
  const table1 = envelope?.body?.ResultSets?.Table1;
  const table2 = envelope?.body?.ResultSets?.Table2;
  if (!Array.isArray(table1)) {
    throw new Error(`${URL} has no body.ResultSets.Table1 array.`);
  }
  const links = Array.isArray(table2) ? table2 : [];

  const byCheck = new Map<number, CheckInvoice[]>();
  // ★ Measured off the rows, not read off the file's `po` block. A file whose
  //   block disagreed with its own rows would then show the disagreement in the
  //   columns rather than hiding it behind a summary nobody can check.
  const ordersMeasured = links.some((l) => l.PO_NUMBER !== undefined);
  let named = 0;
  for (const l of links) {
    const list = byCheck.get(l.CHECK_ID);
    const po = l.PO_NUMBER == null ? '' : String(l.PO_NUMBER).trim();
    const invoice: CheckInvoice = {
      number: String(l.INVOICE_NUM ?? '').trim(),
      amount: figure(l.INVOICE_AMOUNT),
      date: String(l.INVOICE_DATE ?? '').slice(0, 10),
      accounted: l.PAYMENT_STATUS_FLAG === 'Y',
      // A blank is not an order number. Oracle returns the empty string for a
      // NULL CHAR column, so both spellings arrive and both mean "none".
      po: ordersMeasured && po ? po : null,
    };
    if (invoice.po) named += 1;
    if (list) list.push(invoice);
    else byCheck.set(l.CHECK_ID, [invoice]);
  }

  let reconciled = 0;
  const checks: Check[] = table1.map((r) => {
    const invoices = byCheck.get(r.CHECK_ID) ?? [];
    const amount = figure(r.AMOUNT);
    const invoiced = invoices.reduce((s, i) => s + i.amount, 0);
    // A cent of tolerance: the two sides are stored at different scales, and a
    // 0.001 disagreement rounds to the same money on screen.
    if (Math.abs(invoiced - amount) < 0.005) reconciled += 1;
    return {
      id: r.CHECK_ID,
      number: String(r.CHECK_NUMBER ?? '').trim(),
      date: String(r.CHECK_DATE ?? '').slice(0, 10),
      amount,
      vendor: String(r.VENDOR_NAME ?? '').trim(),
      invoices,
      invoiced,
    };
  });

  // The file is written newest first, but the page's order is the page's
  // business: sorted here so a re-run of the pull cannot silently reverse it.
  checks.sort((a, b) => (a.date === b.date ? b.number.localeCompare(a.number) : b.date.localeCompare(a.date)));

  const dates = checks.map((c) => c.date).filter(Boolean).sort();

  /**
   * ★ THE WINDOW COMES OFF THE RESPONSE, AND FALLS BACK TO THE ROWS THEMSELVES.
   *
   *   `envelope.window` is what the server was **asked** for; `dates` is what it found. The two are
   *   different facts and the page needs the first one to say which years it is looking at — the
   *   measured span cannot: a window of FY2022–2027 whose oldest check is dated 2023-01-04 would
   *   report itself as starting in 2023, which is the same false conclusion in the other
   *   direction.
   *
   *   The row-derived fallback stays for a deployment whose server predates the block, and it is
   *   the safe direction there: an absent window names no years, which reads as "this is what the
   *   rows cover" rather than as a claim the page cannot support.
   */
  const rawWindow = envelope.window ?? null;
  const window = {
    from: rawWindow?.from || dates[0] || '',
    to: rawWindow?.to || dates[dates.length - 1] || '',
    fiscalYear: figure(rawWindow?.fiscalYear),
    fiscalYearEnd: figure(rawWindow?.fiscalYearEnd) || figure(rawWindow?.fiscalYear),
  };

  return {
    checks,
    reconciled,
    window,
    observed: { from: dates[0] ?? '', to: dates[dates.length - 1] ?? '' },
    links: links.length,
    ordersMeasured,
    orders: { named, links: links.length },
    live: true,
    traces: readTrace(envelope),
  };
}
