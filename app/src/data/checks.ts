/**
 * The AP checks extract — `data/oracle/checks.json`.
 *
 * One fiscal year of `AP_CHECKS`: 4,218 checks carrying 9,451 invoice links,
 * frozen to JSON by `server/scripts/pull-ap-extract.mjs`. The window is DERIVED
 * from `GL_PERIODS` on the way out, so the file carries the dates it covers and
 * this module reports them rather than the page assuming a range.
 *
 * ── WHY IT IS FETCHED HERE AND NOT IN THE STORE ──────────────────────────────
 *
 * The purchase-order extract loads at start-up because every screen reads it.
 * Only this screen reads checks, and the file is ~2 MB, so it is fetched when
 * the page opens and lives in that page's own state. A reader who never opens
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

/** A row as it lands in `checks.json` → `.body.ResultSets.Table1`. */
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
  /** The dates actually present in the file, so the page can state its own scope. */
  window: { from: string; to: string };
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
}

const URL = '/oracle/checks.json';

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

export async function loadChecks(signal?: AbortSignal): Promise<ChecksExtract> {
  const res = await fetch(URL, { signal });
  if (!res.ok) throw new Error(`${URL} answered ${res.status} ${res.statusText}.`);

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

  return {
    checks,
    reconciled,
    window: { from: dates[0] ?? '', to: dates[dates.length - 1] ?? '' },
    links: links.length,
    ordersMeasured,
    orders: { named, links: links.length },
  };
}
