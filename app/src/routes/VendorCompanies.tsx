import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  applyCustomNames,
  loadMaster,
  loadVendors,
  vendorKeyOf,
  type Vendor,
  type VendorCheck,
  type VendorInvoice,
  type VendorMaster,
  type VendorsExtract,
} from '../data/vendors';
import ErrorNotice from '../components/ErrorNotice';
import { CustomNamesNote, EditableField } from '../components/EditableField';
import { customLabels, useOverrides, type OverrideState } from '../data/customFields';
import ResizeGrip, { clampWidth, readStoredWidth, storeWidth } from '../components/ResizeGrip';
import { SortableHead } from '../components/SortHeader';
import { ident, money, money0, num, pluralise } from '../data/format';
import {
  CHRONO_ORDER,
  describeOrder,
  sortRows,
  type SortColumn,
  type SortState,
} from '../data/sort';
import { sameScope, scopeLabel, type Scope } from '../data/scope';
import { useStore } from '../state/store';

/**
 * Vendor companies — every payee this tenant's AP register has paid, with the
 * checks that paid it and the invoices those checks settled.
 *
 * ── THE FIVE THINGS THIS SCREEN MUST NOT GET WRONG ──────────────────────────
 *
 * 1. **IT IS SCOPED TO FUND 04 · PROGRAM 861/862, AND THAT IS NOT A BANNER HERE.**
 *    The register behind this page was narrowed in the extract's SQL by testing each
 *    invoice's *distributions*, so every row carries the account combination that
 *    put it in scope — `04-…-862-…`. The page prints that combination **on every
 *    invoice**, and derives the fund/program pairs actually present from the rows
 *    rather than restating what was asked for. Measured: 182 account rows at
 *    `04/862` and 2 at `04/000`, and **no `861` row at all on the payments side** —
 *    so the scope is something a reader can check against a line, not take on trust.
 *
 * 2. **A CHECK IS NOT FULLY THIS VENDOR'S MONEY.** One check can settle invoices on
 *    several vendors and the database records *which* invoices it paid and never
 *    *how much* of it went to each — `WCSEXP_AP_INVOICE_PAYMENTS` has four columns
 *    and none of them is money. So the panel prints the check's own amount and the
 *    sum of this vendor's invoices the check paid, and never divides one by the
 *    other. When the two differ the reader is told which is which.
 *
 * 3. **THE TOTAL IS THE INVOICES, AND IT RECONCILES WITH WHAT IS ON SCREEN.**
 *    "Sum of the invoice amounts listed" is the stated basis, so the footer adds the
 *    rows in the panel — including the group of invoices **no check reaches** (9 on
 *    the register), which is why that group is rendered rather than dropped. A total
 *    over a list that is missing rows is the one arithmetic error a reader cannot
 *    detect from the page.
 *
 * 4. **AN INVOICE NUMBER IS NOT AN IDENTITY.** It mostly is: 126 invoices sit under
 *    125 distinct numbers, and only `PAYAPP4` is drawn twice — by two different
 *    vendors. That is enough. The link carries the number, the vendor, the date and
 *    the amount, and the register narrows on all four, because a link keyed on the
 *    number alone would be right 124 times out of 126 and wrong the rest.
 *
 * 5. **"NO PURCHASE ORDER" IS AN ANSWER.** 16 of the 126 in-scope invoices name no
 *    order — prepaid cards, travel reimbursements, use tax — and one of them is
 *    $693,915.13. **5 of the 55 vendors** name no order on any of their invoices,
 *    and 4 more name one on some. They are shown with that fact stated, not filtered
 *    out for looking incomplete.
 *
 * 6. **A VENDOR THAT HAS BEEN PAID CAN STILL HAVE INVOICES THAT HAVE NOT BEEN.**
 *    All 55 vendors on this register have payments against them, so "which vendors
 *    are unpaid" is the empty set and a company-level verdict would say nothing. The
 *    rows that are unpaid are the *invoices*: **9 of the 126, worth $23,020.84, on 2
 *    companies** — 8 of them `WAKE COUNTY PUBLIC SCHOOLS`, which is nevertheless the
 *    largest payee on the page. Each of those rows carries the count and the money
 *    under its Paid figure, so the fact is visible **without opening the panel**,
 *    which is the only place it used to appear.
 *
 * 7. **THE PANEL'S "Difference" IS NOT THE UNPAID AMOUNT, AND SAYING IT WAS A BUG.**
 *    `issued − settled` nets two effects: the part of this vendor's checks that paid
 *    somebody else, and this vendor's invoices that no check reached. For WAKE COUNTY
 *    it is **$21,474.93** while the unpaid group is **$23,020.84** — the $1,545.91 gap
 *    is a check of theirs that settled another vendor. Both figures are now on one
 *    screen, so a label that fused them would have made one look like an arithmetic
 *    error. The row claims the **direction** only; the note names each quantity and
 *    points at the accurate figure. (It read "Difference — invoices no check reached"
 *    until the row marker made the contradiction visible.)
 */

const WIDTH_KEY = 'vendors-panel-w';

/** Vendors per page. The register reaches 55, so this is two pages — the paging is
 *  honest rather than necessary, and it stays because the count follows the scope. */
const PER_PAGE = 50;

/**
 * How many invoices the panel lists under one check.
 *
 * 100 covers every check in the register: the widest reaches **15** invoices across
 * the whole vendor (measured, `WAKE COUNTY PUBLIC SCHOOLS`), so nothing a reader can
 * reach today is capped. The number is a bound rather than a discovery, and the CSV
 * behind the button holds the full list either way.
 */
const INVOICE_CAP = 100;

/** The panel's focus trap reads the same set the other two drawers use. */
const FOCUSABLE =
  'a[href], button:not([disabled]), summary, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * How many rows `PO_VENDORS` holds on this tenant, measured 2026-09-19.
 *
 * ★ NAMED AND MEASURED RATHER THAN WRITTEN INTO A SENTENCE. The master lookup is a
 *   `?q=` search precisely because this number makes reading the table whole 160
 *   paged requests — so the page has to be able to say the number, and a figure that
 *   appears in the interface without a name is one nobody can find again when it
 *   changes. (The Turso sample this screen was first built against held **157**, and
 *   a note claiming "the country's 749 vendors" was describing neither.)
 */
const LIVE_VENDOR_ROWS = 79685;

/** The master lookup reads one company at a time because of `LIVE_VENDOR_ROWS`. */
const MASTER_PAGE = 20;

const termsOf = (q: string): string[] =>
  q
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

/**
 * Everything one vendor can be found by, flattened once at load.
 *
 * The invoice and check numbers are in here on purpose: a reader holding a cheque
 * stub or an invoice knows one of *those* long before they know which company it was
 * made out to, and this page exists to answer that lookup.
 *
 * ★ BOTH NAMES ARE IN HERE, AND THAT IS NOT A DUPLICATE. `displayName` is what the
 *   reader sees on the row, so it is the name they will re-type in the filter; `name`
 *   is what the ledger calls the company, so it is the name they will paste out of
 *   Oracle. Indexing one of the two would make the search silently refuse the other.
 */
function haystack(v: Vendor): string {
  return [
    v.displayName,
    v.name,
    v.accounts.join(' '),
    v.invoices.map((i) => `${i.number} ${i.date} ${i.account} ${i.poNumber ?? ''}`).join(' '),
    v.checks.map((c) => `${c.number} ${c.date}`).join(' '),
  ]
    .join(' ')
    .toLowerCase();
}

/**
 * The five columns, in the order they are shown.
 *
 * `value` is what the column is *ordered by*, not what the cell says: the money
 * column renders `$1,848,956.16` and orders on 1848956.16, because `$` sorts before
 * every digit and a comma does not.
 *
 * ★ **CHECK NUMBERS ARE COMPARED NUMERICALLY.** A cheque number is text in the
 *   ledger (`001234`) and holds leading zeroes, but it is a number to everyone who
 *   reads it — so the column uses `numeric: true` and 9999 stays before 10000 rather
 *   than being filed after every five-digit check.
 *
 * ★ **THE VENDOR COLUMN ORDERS ON WHAT IT SHOWS.** Clicking a column header is a
 *   request to sort *that thing*, and the thing on screen is the custom name. Ordering
 *   on the ledger's name instead would leave one renamed company sitting in a
 *   position the header does not explain. (`key` — the fold of the ledger's name —
 *   stays the row identity and the React key; only the ordering moves.)
 */
const COLUMNS: SortColumn<Vendor>[] = [
  { key: 'vendor', label: 'Vendor', value: (v) => v.displayName },
  { key: 'invoices', label: 'Invoices', numeric: true, value: (v) => v.invoices.length },
  { key: 'checks', label: 'Checks', numeric: true, value: (v) => v.checks.length },
  { key: 'paid', label: 'Paid', numeric: true, value: (v) => v.settled },
  { key: 'latest', label: 'Latest', value: (v) => v.to, order: CHRONO_ORDER },
];

/** The order the page opens on: biggest payee first, which is what it is for. */
const BY_VALUE: SortState = { key: 'paid', dir: 'desc' };

/** A page list with gaps, so two pages does not read as a machine output. */
function pageWindow(current: number, total: number): (number | null)[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out: (number | null)[] = [];
  const push = (n: number | null) => {
    if (out[out.length - 1] !== n) out.push(n);
  };
  push(1);
  if (current - 2 > 2) push(null);
  for (let n = Math.max(2, current - 2); n <= Math.min(total - 1, current + 2); n += 1) push(n);
  if (current + 2 < total - 1) push(null);
  push(total);
  return out;
}

const csvCell = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * Where an invoice in the panel goes.
 *
 * ★ THE NUMBER ALONE IS NOT AN IDENTITY. `PAYAPP4` is drawn twice in this window, by
 *   two different vendors, so a link carrying only the number would open a different
 *   document and look certain while doing it. The link hands over everything this
 *   panel knows — the number, the vendor the payment was made to, the date and the
 *   amount — and `/spend/invoices` narrows on them in that order. (The register that
 *   link lands on is far worse than this one: 737 of its 6,270 numbers repeat, the
 *   worst of them 157 times, so the disambiguation is load-bearing there even where
 *   it looks like belt-and-braces here.)
 */
function invoiceHref(i: VendorInvoice, vendor: string): string {
  const q = new URLSearchParams({
    invoice: i.number,
    vendor,
    date: i.date,
  });
  // A zero amount is left off deliberately: the register treats an absent amount as
  // "says nothing" and a present `0` as "says zero", and a missing amount must not
  // be sent as a claim about the value.
  if (i.amount !== 0) q.set('amount', i.amount.toFixed(2));
  return `/spend/invoices?${q.toString()}`;
}

/**
 * The vendor's payments as a CSV, built in the browser.
 *
 * ★ THE TOTAL ROW IS THE POINT OF HAVING THIS AT ALL. The panel's list is bounded
 *   and the page's vendor table shows four numbers per company; the file is the only
 *   place a reader gets every invoice of one vendor *and* the figure they add up to,
 *   together, so the total is written into the file rather than left to be recomputed
 *   from a spreadsheet that may not round the same way.
 *
 * ★ THE FILE CARRIES BOTH NAMES, AND THE FILENAME CARRIES ONLY ONE. A reader may have
 *   renamed this company, so the filename uses the name they know — but a file named
 *   `vendor-<custom>-invoices.csv` whose rows mention no Oracle name is unattributable
 *   once it leaves this screen, and reconciling it against the ledger is exactly what
 *   a payments extract is for. So the ledger's name is written into every row, as the
 *   LAST column: appended rather than prepended so the eight columns a reader already
 *   has a spreadsheet template for do not shift. It is one value repeated, which is
 *   what makes it survive a sort or a filter in that spreadsheet.
 */
function exportVendor(vendor: Vendor) {
  const header = [
    'Check No',
    'Check Date',
    'Check Amount',
    'Invoice No',
    'Invoice Date',
    'Invoice Amount',
    'Account',
    'PO Number',
    'Vendor (Oracle)',
  ];
  const lines: string[][] = [];
  const linked = new Set<number>();
  for (const c of vendor.checks) {
    for (const i of c.invoices) {
      linked.add(i.id);
      lines.push([
        c.number,
        c.date,
        c.amount.toFixed(2),
        i.number,
        i.date,
        i.amount.toFixed(2),
        i.account,
        i.poNumber ?? '',
        vendor.name,
      ]);
    }
  }
  // The invoices no check reaches still belong in the file: they are part of what the
  // vendor's row says was settled, and leaving them out would make the file disagree
  // with the screen it was downloaded from.
  for (const i of vendor.invoices) {
    if (linked.has(i.id)) continue;
    lines.push([
      '',
      '',
      '',
      i.number,
      i.date,
      i.amount.toFixed(2),
      i.account,
      i.poNumber ?? '',
      vendor.name,
    ]);
  }

  const rows = [
    header,
    ...lines,
    ['', '', '', '', '', vendor.settled.toFixed(2), 'Total settled', '', vendor.name],
  ];
  const csv = rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `vendor-${vendor.displayName.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}-invoices.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function VendorCompanies() {
  /**
   * ★ THE EXTRACT AND WHAT THE PAGE PRINTS ARE TWO DIFFERENT VALUES.
   *
   * `raw` is what the endpoint sent; `data` below is that with any custom vendor names
   * folded in. They are kept apart because the two reads are independent requests with
   * independent fates — the override read can fail while the register is perfectly
   * loaded — and because saving one name must not re-download 55 vendors' worth of
   * invoices to change one label.
   */
  const [raw, setRaw] = useState<VendorsExtract | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [params, setParams] = useSearchParams();

  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState>(BY_VALUE);
  const [sortNote, setSortNote] = useState('');

  const [selected, setSelected] = useState<Vendor | null>(null);
  const [open, setOpen] = useState(false);

  const { scope: liveScope, scopeTenant } = useStore();

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    setRaw(null);
    loadVendors(controller.signal)
      .then((next) => setRaw(next))
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => controller.abort();
  }, [attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  /**
   * ★ ONE OVERRIDE READ FOR THE PAGE, AND ONE PASS OVER THE EXTRACT.
   *
   * The subject is `vendor` and the field is `name`, which is the whole registry as
   * this screen knows it. A read that FAILS is not an empty read: `customLabels`
   * returns nothing for a failed read, so every vendor falls back to the ledger's own
   * name — correct, because a name that could not be read must not be invented — and
   * the note under the filter bar says so, which is the only reason that fallback is
   * honest rather than silent.
   */
  const overrides = useOverrides('vendor');
  const labels = useMemo(() => customLabels(overrides, 'name'), [overrides]);
  const data = useMemo(() => (raw ? applyCustomNames(raw, labels) : null), [raw, labels]);
  const reloadOverrides = overrides.reload;

  /**
   * ★ A LINK ARRIVED WITH A VENDOR, AND THE NOTE SAYS WHAT IT FOUND.
   *
   * The `arrived` ref makes this fire once per URL rather than on every render, and
   * the note is cleared against **the value the arrival set** rather than against
   * `query === ''` — the arrival writes its own query on a hit, so "empty" would
   * clear the note while the reader was still looking at the vendor it opened, and
   * "non-empty" would leave a miss's note standing long after they had moved on.
   */
  const arrived = useRef(false);
  const arrivalQuery = useRef<string | null>(null);
  /**
   * ★ THE VENDOR THE URL CARRIED WHEN THE PAGE FIRST RENDERED — and nothing after.
   *
   * The arrival branch below is for a LINK: a pasted URL, a bookmark, a reload.
   * Clicking a row also writes `?vendor=`, and it used to be read as an arrival, so
   * opening a vendor narrowed the 55-row register to that one company and put its
   * name in the search box — a reader who then closed the panel found the table
   * still filtered by a name they never typed, with nothing on screen saying why.
   * Measured before the fix: 50 rows → 1 row on the first click, and 1 row again
   * after a reload.
   *
   * Reading the param once into a ref separates the two cases: a link is whatever
   * was in the URL at mount, a click is any value that appears afterwards. Nothing
   * else in the app links here with `?vendor=`, so mount is exactly the arrival.
   */
  const arrivalParam = useRef<string | null>(null);
  if (arrivalParam.current === null) {
    arrivalParam.current = (params.get('vendor') ?? '').trim();
  }
  const [missing, setMissing] = useState('');

  useEffect(() => {
    const wanted = arrivalParam.current ?? '';
    if (!wanted || arrived.current || !data) return;
    arrived.current = true;
    // The same fold the client uses everywhere else — a fourth hand-written copy here
    // would resolve the URL against one rule and the stored override against another.
    const found = data.vendors.find((v) => v.key === vendorKeyOf(wanted));
    if (found) {
      arrivalQuery.current = found.name;
      setQuery(found.name);
      setPage(1);
      setSelected(found);
      setOpen(true);
    } else {
      arrivalQuery.current = query;
      setMissing(wanted);
    }
  }, [data, query]);

  useEffect(() => {
    if (!missing) return;
    if (query !== arrivalQuery.current) setMissing('');
  }, [query, missing]);

  const matches = useMemo(() => {
    const terms = termsOf(query);
    if (!terms.length) return data?.vendors ?? [];
    // ★ FILTER, THEN SLICE — never the other way round. Slicing first and filtering
    //   the window silently denies that matches exist outside it, so a search for a
    //   vendor that is provably on page 2 reports nothing.
    return (data?.vendors ?? []).filter((v) => {
      const hay = haystack(v);
      return terms.every((t) => hay.includes(t));
    });
  }, [data, query]);

  const sorted = useMemo(() => sortRows(matches, COLUMNS, sort), [matches, sort]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PER_PAGE));
  const current = Math.min(page, totalPages);
  const shown = sorted.slice((current - 1) * PER_PAGE, current * PER_PAGE);

  const applySort = (next: SortState) => {
    setSort(next);
    // Back to the first page. A filter clamps the page instead, deliberately — it
    // narrows the list without reordering it, so page 2 is still the neighbourhood
    // the reader was in. Sorting moves every row they were looking at somewhere
    // else, and they clicked something at the top of the table.
    setPage(1);
    // The whole next state is passed rather than a key, because flipping is
    // `sort.ts`'s rule and this page must not have a second one.
    setSortNote(`Ordered by ${describeOrder(COLUMNS, next)}.`);
  };

  const openVendor = (v: Vendor) => {
    setSelected(v);
    setOpen(true);
    // The URL carries the vendor so the panel can be linked and reloaded, and so a
    // page refresh does not lose the reader's place.
    //
    // ★ IT CARRIES THE LEDGER'S NAME, NOT THE CUSTOM ONE. This value is folded back
    //   into a key on arrival, and the override is stored under the fold of the name
    //   Oracle holds — so a URL carrying a custom name would be a link that stops
    //   resolving the moment the override is deleted. The Oracle name is the stable
    //   one; what the reader sees on the page never depends on it.
    const next = new URLSearchParams(params);
    next.set('vendor', v.name);
    setParams(next, { replace: true });
  };

  const closePanel = () => {
    setOpen(false);
    const next = new URLSearchParams(params);
    next.delete('vendor');
    setParams(next, { replace: true });
  };

  const scope = data?.scope;

  /**
   * The file's scope as a `Scope`, for comparison against the live one.
   *
   * `null` when the file carried no scope block at all — "nothing was applied" is not
   * a scope, and comparing against an invented one would report a difference that is
   * not there.
   */
  const fileScope: Scope | null =
    scope?.applied && (scope.fund || scope.programs.length)
      ? { fund: scope.fund, programs: scope.programs }
      : null;
  const scopeMoved = fileScope ? !sameScope(fileScope, liveScope) : false;

  const widest = useMemo(() => {
    const rows = data?.vendors ?? [];
    if (!rows.length) return null;
    return rows.reduce((a, b) => (b.invoices.length > a.invoices.length ? b : a));
  }, [data]);

  /**
   * The companies holding at least one invoice no check reaches.
   *
   * ★ DERIVED ONCE, READ BY ALL THREE PLACES THAT NAME THEM — the row marker, the
   *   stat and the note under the table. Three independent `filter` calls would be
   *   three chances to disagree about which companies the page is pointing at, and
   *   the one that disagreed would be the one nobody re-read. Measured: 2 of the 55,
   *   `WAKE COUNTY PUBLIC SCHOOLS` (8) and `ALL AMERICAN RELOCATION INC` (1).
   */
  const unpaidVendors = useMemo(() => (data?.vendors ?? []).filter((v) => v.unpaid > 0), [data]);

  return (
    // `.stack` and `.page-head`, not a page class of this screen's own: both the
    // checks register and the invoices register are children of the shell's
    // `.stack`, and a third heading convention would be a third set of margins.
    <div className="stack">
      <div>
        <div className="accent-rule" />
        <div className="page-head">
          <div>
            <h1>Vendor companies</h1>
          </div>
        </div>
      </div>

      {/*
        ★ THE SUBTITLE, THE SCOPE NOTE AND THE STAT CARDS ARE GONE, ON STAFF'S INSTRUCTION.

          The scope note named the denominator (126 of 3,743 invoices) and split the exclusions into
          "booked elsewhere" and "no distribution to test" — the distinction the page's own comment
          called out as load-bearing, because subtracting one from the other would file 26 invoices
          under the wrong heading. That is knowingly given up here.
      */}

      {data && scopeMoved && fileScope ? (
        <p className="scopenote" role="note">
          <span className="scopenote__flag">Scope difference</span>
          <span className="scopenote__text">
            The register was built with <strong>{scope?.label ?? scopeLabel(fileScope, fileScope.programs)}</strong>{' '}
            applied in the extract query, but the scope above the search box is now{' '}
            <strong>{scopeLabel(liveScope, scopeTenant?.programs ?? [])}</strong>. The vendors shown
            are the ones the file holds. The app cannot re-apply a different fund and program to
            them, because on this register the rule lives in the SQL, not in the browser — re-run{' '}
            <code>node server/scripts/pull-invoices-extract.mjs</code> to rebuild it.
          </span>
        </p>
      ) : null}

      {error ? (
        <ErrorNotice
          error={error}
          reload={reload}
          heading="The payment register could not be read."
          hint={
            <p>
              This page reads <code>app/public/oracle/invoices.json</code>, written by{' '}
              <code>node server/scripts/pull-invoices-extract.mjs</code> against the live Oracle
              ledger.
            </p>
          }
        />
      ) : null}

      {data ? (
        <>
          <p className="sr" role="status">
            {termsOf(query).length
              ? `${num(matches.length)} of ${num(data.vendors.length)} vendors match "${query}".`
              : ''}
          </p>
          {/*
            ★ THE FIVE STAT CARDS ARE GONE, ON STAFF'S INSTRUCTION. They read: vendors paid,
            settled, checks issued, largest payee, and no-check-recorded — all totals over the
            table below, which carries the per-vendor rows they summed.

            The `Stat` component they used is deleted with them: nothing else on this page called
            it, so leaving it would have been dead code.
          */}

          <section className="panel">
            <div className="panel__head">
              <div>
                <h2 className="panel__title">Vendors</h2>
                <p className="panel__sub">
                  One company per row, {describeOrder(COLUMNS, sort)}. Paid is the sum of the
                  invoices this register holds for them — so it includes any that no check
                  reached, and those rows say how many and how much. Click a vendor to open
                  their checks.
                </p>
              </div>
              <span className="panel__count">
                {num(shown.length)} of {num(sorted.length)}
              </span>
            </div>

            <div className="filterbar vcfilter" role="group" aria-label="Filter vendors">
              <div className="vcfilter__box">
                <label className="sr" htmlFor="vc-q">
                  Search vendors
                </label>
                <input
                  id="vc-q"
                  type="search"
                  className="vcfilter__input"
                  placeholder="Company, invoice or check number…"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setPage(1);
                  }}
                />
                {query ? (
                  <button
                    type="button"
                    className="vcfilter__clear"
                    onClick={() => {
                      setQuery('');
                      setPage(1);
                    }}
                    aria-label="Clear the vendor filter"
                  >
                    Clear
                  </button>
                ) : null}
              </div>
            </div>

            {/*
              ★ A LINK CAN NAME A VENDOR THIS REGISTER DOES NOT HOLD, AND SAYING SO IS
                THE WHOLE JOB OF THE NOTE. `missing` was tracked from the start and
                rendered nowhere, so a pasted `?vendor=` link that matched nothing
                showed the full 55-vendor register with no indication that anything
                had been asked for — which reads as "the link worked and this is the
                answer" rather than "that company is not here". The note names the
                value that was asked for, so the reader can see it was a lookup by
                name rather than a filter they typed.
            */}
            {missing ? (
              <div className="chkempty vcfilter__miss">
                <p>
                  The link asked for <strong>“{missing}”</strong>, and no vendor on this register
                  has that name.
                </p>
                <p className="chkempty__hint">
                  Only the {num(data?.vendors.length ?? 0)} companies paid out of this register are
                  listed — a company in the wider <code>PO_VENDORS</code> table that drew nothing
                  from this fund and these programs is not here. The list below is the whole
                  register, unfiltered.
                </p>
              </div>
            ) : null}

            {/*
              ★ RENDERED UNCONDITIONALLY, WHICH IS THE POINT.

              ★ A disclosure gated on “is anything wrong” is invisible in exactly the
                case it exists for. The dangerous states here are (a) a stored custom
                name that could not be read, so the page is showing the ledger's name
                while an override exists, and (b) nobody signed in, so the pencils are
                absent and the page looks like it simply has no such feature. Both are
                stated in words; when there is nothing to report the component says so
                in one line rather than disappearing.
            */}
            <CustomNamesNote read={overrides} />

            {shown.length === 0 ? (
              <div className="chkempty">
                <p>No vendor matches “{query}”.</p>
                <p className="chkempty__hint">
                  The filter searches company names, invoice numbers, check numbers and the account
                  codes — so an account combination in scope will find its vendors.
                </p>
              </div>
            ) : (
              <div className="table-wrap">
                <table className="data vctable">
                  <caption className="sr">
                    Vendors paid out of the {scope?.label ?? 'scoped'} register,{" "}
                    {describeOrder(COLUMNS, sort)}.
                  </caption>
                  <colgroup>
                    <col className="c-vendor" />
                    <col className="c-count" />
                    <col className="c-count" />
                    <col className="c-paid" />
                    <col className="c-latest" />
                  </colgroup>
                  <SortableHead columns={COLUMNS} sort={sort} onSort={applySort} />
                  <tbody>
                    {shown.map((v) => (
                      <tr
                        key={v.key}
                        className={`vctable__row${v.key === selected?.key && open ? ' is-open' : ''}`}
                        onClick={() => openVendor(v)}
                      >
                        <td>
                          {/* The row is clickable for the mouse; this button is what
                              makes it reachable by keyboard and what gives the row a
                              name. Both do the same thing. */}
                          <EditableField
                            read={overrides}
                            subject="vendor"
                            field="name"
                            subjectKey={v.key}
                            keyWritten={v.name}
                            oracleValue={v.name}
                            onChanged={reloadOverrides}
                            variant="register"
                          >
                            {/*
                              ★ THE BUTTON IS THE VALUE HERE, AND IT STAYS THE SUCCESSOR
                                ELEMENT. This cell is where the pencil used to be, and
                                the pencil could not live in it: the register sits in
                                `.table-wrap`, whose `overflow-x: auto` computes the
                                vertical axis to `auto` as well, so a tooltip anchored
                                inside a cell is cut off for the last rows of the
                                table; and `position: fixed` is unavailable because the
                                panel is a `transform`ed ancestor. So the cell keeps the
                                name and the mark, and the controls live in the panel
                                head — one row up, where there is room to explain them.
                                `display: block` on `.vc-link` is what puts the mark on
                                the line below the name rather than beside it.
                            */}
                            <button
                              type="button"
                              className="vc-link"
                              aria-expanded={v.key === selected?.key && open}
                              aria-controls="vendor-detail"
                              onClick={(e) => {
                                e.stopPropagation();
                                openVendor(v);
                              }}
                            >
                              {v.displayName}
                            </button>
                          </EditableField>
                          {v.accounts[0] ? <span className="vc-acct">{v.accounts[0]}</span> : null}
                        </td>
                        <td className="n">{num(v.invoices.length)}</td>
                        <td className="n">
                          {v.checks.length === 0 ? (
                            <span className="vc-none">none</span>
                          ) : (
                            num(v.checks.length)
                          )}
                        </td>
                        <td className="n vc-num">
                          {money(v.settled)}
                          {/*
                            ★ THE ONE PLACE A ROW ADMITS AN INVOICE WENT UNPAID. Every
                              company on this register has been paid *something*, so a
                              company-level verdict would mark nothing — the unpaid rows
                              are invoices, and this is the figure they qualify. Before
                              this existed the fact was reachable only by opening the
                              panel and reading a group inside it, which is not where a
                              reader comparing 55 companies will look.
                          */}
                          {v.unpaid > 0 ? (
                            <span
                              className="vc-unpaid"
                              title={`${num(v.unpaid)} of this company's ${num(
                                v.invoices.length,
                              )} invoices are reached by no check in this register — ${money(
                                v.unpaidValue,
                              )}. They are listed in the panel under “No check recorded”.`}
                            >
                              {num(v.unpaid)} unpaid · {money0(v.unpaidValue)}
                            </span>
                          ) : null}
                        </td>
                        <td className="vc-num">{v.to}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {totalPages > 1 ? (
              <div className="pager">
                <button
                  type="button"
                  className="btn btn--system btn--sm"
                  disabled={current === 1}
                  onClick={() => setPage(current - 1)}
                >
                  Previous
                </button>

                <span className="pager__pages">
                  {pageWindow(current, totalPages).map((n, i) =>
                    n === null ? (
                      <span key={`gap-${i}`} className="pager__gap">
                        …
                      </span>
                    ) : (
                      <button
                        key={n}
                        type="button"
                        className="pager__n"
                        aria-current={n === current ? 'page' : undefined}
                        aria-label={`Page ${n} of ${totalPages}`}
                        onClick={() => setPage(n)}
                      >
                        {n}
                      </button>
                    ),
                  )}
                </span>

                <button
                  type="button"
                  className="btn btn--system btn--sm"
                  disabled={current === totalPages}
                  onClick={() => setPage(current + 1)}
                >
                  Next
                </button>
              </div>
            ) : null}

            <p className="sr" role="status">
              {sortNote}
            </p>

            {widest ? (
              <p className="chart-note" style={{ padding: '0 16px 12px' }}>
                A vendor is not a document. “Paid” totals invoices rather than describing one
                payment.{' '}
                {data.vendors[0]?.key === widest.key ? (
                  <>
                    The largest payee here is also the one on the most invoices —{' '}
                    <strong>{money0(widest.settled)}</strong> across{' '}
                    {pluralise(widest.invoices.length, 'invoice')} and{' '}
                    {pluralise(widest.checks.length, 'check')}.
                  </>
                ) : (
                  <>
                    The largest payee, <strong>{data.vendors[0]?.name}</strong>, is{' '}
                    {money0(data.vendors[0]?.settled ?? 0)} across{' '}
                    {pluralise(data.vendors[0]?.invoices.length ?? 0, 'invoice')} — while the vendor
                    on the most invoices, <strong>{widest.name}</strong>, is{' '}
                    {money0(widest.settled)} across {pluralise(widest.checks.length, 'check')}.
                  </>
                )}{' '}
                {data.invoices > data.linked ? (
                  <>
                    {num(data.linked)} of the {num(data.invoices)} invoices here are reached by a
                    check and {num(data.invoices - data.linked)} are not — so “Settled” (the
                    invoices' amounts) and “Checks issued” (the checks' amounts, each counted once)
                    are answers to two different questions, not one figure that failed to reconcile.
                    The unpaid ones are{' '}
                    {unpaidVendors.map((v) => `${num(v.unpaid)} on ${v.name}`).join(', ')},{' '}
                    {money(data.unpaidValue)} in all
                    {unpaidVendors.some((v) => v.unpaidValue === 0)
                      ? ', one of them a zero-amount row'
                      : ''}
                    . Each is marked under its company's Paid figure and listed in full in that
                    company's panel, and the ledger agrees with the link table about all{' '}
                    {num(data.invoices - data.linked)} of them — <code>PAYMENT_STATUS_FLAG</code> is{' '}
                    <code>N</code> and <code>AMOUNT_PAID</code> is zero — so this is a state of the
                    register rather than a link that went missing.
                  </>
                ) : null}
              </p>
            ) : null}
          </section>
        </>
      ) : null}

      <VendorPanel
        vendor={selected}
        open={open}
        onClose={closePanel}
        scopeText={scope?.label ?? ''}
        overrides={overrides}
        onOverridesChanged={reloadOverrides}
      />
    </div>
  );
}

/**
 * The vendor's payments, in a panel that slides in from the right.
 *
 * It keeps the shared `.drawer` primitive's geometry and close button, and its own
 * body, because what goes in it — the master record, the checks, the invoices under
 * each check, and the arithmetic that ties the three together — exists nowhere else.
 */
function VendorPanel({
  vendor,
  open,
  onClose,
  scopeText,
  overrides,
  onOverridesChanged,
}: {
  vendor: Vendor | null;
  open: boolean;
  onClose: () => void;
  /** The register's own scope label, so the accounts section can name it. */
  scopeText: string;
  /** The page's one override read, handed down rather than read again here. */
  overrides: OverrideState;
  /** Called after a save or a delete so the page's labels and this panel agree. */
  onOverridesChanged: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // The same three-state width contract as the other panels: null lets the
  // stylesheet own it until the reader resizes.
  const [width, setWidth] = useState<number | null>(() => readStoredWidth(WIDTH_KEY));
  const [resizing, setResizing] = useState(false);
  const [rendered, setRendered] = useState(0);

  /** Which checks are expanded. A Set rather than one id: several can be open at once,
   *  and a reader comparing two payments should not have to close one to see the other. */
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());

  const [master, setMaster] = useState<VendorMaster | null>(null);
  const [masterState, setMasterState] = useState<'idle' | 'loading' | 'ready' | 'missing' | 'failed'>(
    'idle',
  );

  const name = vendor?.name ?? '';

  /**
   * ★ THIS IS THE ONE CONTROL ON THE PAGE, AND IT IS HERE FOR A LAYOUT REASON.
   *
   * The pencil, the trash and the tooltip cannot live on the register row: the table
   * sits in `.table-wrap` (`overflow-x: auto`, which computes the vertical axis to
   * `auto` too, so an anchored tooltip is clipped for the last rows) and `position:
   * fixed` is measured against the viewport inside a `transform`ed ancestor. The panel
   * head is outside both constraints, it is where a reader is looking when they care
   * about one vendor, and it is large enough to carry the refusal message when the
   * server rejects a value. The register row shows the name and the `custom` mark.
   */
  const editableName = vendor ? (
    <EditableField
      read={overrides}
      subject="vendor"
      field="name"
      subjectKey={vendor.key}
      /* The ledger's name as written — the same value the override is keyed under, kept
         on the record so the panel shows which spelling it was matched against. */
      keyWritten={vendor.name}
      oracleValue={vendor.name}
      onChanged={onOverridesChanged}
      variant="heading"
    />
  ) : null;

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement as HTMLElement | null;
    document.body.classList.add('is-locked');
    return () => {
      document.body.classList.remove('is-locked');
      openerRef.current?.focus?.();
    };
  }, [open]);

  // Focus has to wait for the content: on the first open the close button is not
  // rendered yet, so focusing in the same commit silently does nothing.
  useEffect(() => {
    if (open && vendor) closeRef.current?.focus();
  }, [open, vendor]);

  // Open on the newest check, so the panel is not a stack of closed headers a reader
  // has to guess at. Only when the vendor changes — re-opening one they collapsed by
  // hand on the next render would be the panel arguing with them.
  useEffect(() => {
    setExpanded(vendor?.checks[0] ? new Set([vendor.checks[0].id]) : new Set());
  }, [vendor]);

  // The master record, read live from `PO_VENDORS` for this one vendor.
  useEffect(() => {
    if (!open || !name) {
      setMaster(null);
      setMasterState('idle');
      return;
    }
    const controller = new AbortController();
    setMaster(null);
    setMasterState('loading');
    loadMaster(name, controller.signal)
      .then((row) => {
        if (controller.signal.aborted) return;
        setMaster(row);
        setMasterState(row ? 'ready' : 'missing');
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setMaster(null);
        setMasterState('failed');
      });
    return () => controller.abort();
  }, [open, name]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const el = panelRef.current;
      if (el) setRendered(Math.round(el.getBoundingClientRect().width));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

  useEffect(() => {
    document.body.classList.toggle('is-resizing', resizing);
    return () => {
      if (!resizing) return;
      document.body.classList.remove('is-resizing');
    };
  }, [resizing]);

  const setUserWidth = (w: number) => {
    const next = clampWidth(w);
    setWidth(next);
    storeWidth(WIDTH_KEY, next);
  };
  const resetWidth = () => {
    setWidth(null);
    storeWidth(WIDTH_KEY, null);
  };

  /**
   * ★ THE INVOICES NO CHECK REACHES, COMPUTED RATHER THAN COUNTED.
   *
   * `vendor.unpaid` is the count; this is the list, and the panel needs the list
   * because the total at the bottom has to add up to the rows above it. Rendering
   * only the check groups would leave 9 invoices on the register invisible while
   * their money was still in the total — the one arithmetic error a reader cannot
   * catch by looking.
   *
   * ★ AND THE COUNT IS NOW ON THE TABLE ROW, SO THE TWO READINGS OF ONE FACT ARE IN
   *   DIFFERENT PLACES AND CANNOT BE SEEN TOGETHER. `vendor.unpaid` is built by
   *   `groupVendors` from `inv.checks` being empty; this builds the same set from the
   *   panel's own check groups. They must agree — same register, same rule — but note
   *   that the row prints the first and this group prints the second, so if the
   *   grouping ever changed only one of them would move, and the panel's own total
   *   below is what would catch it.
   */
  const orphans = useMemo(() => {
    if (!vendor) return [] as VendorInvoice[];
    const linked = new Set<number>();
    for (const c of vendor.checks) for (const i of c.invoices) linked.add(i.id);
    return vendor.invoices.filter((i) => !linked.has(i.id));
  }, [vendor]);

  const toggle = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const style = width === null ? undefined : ({ '--drawer-w': `${width}px` } as CSSProperties);
  const difference = vendor ? vendor.issued - vendor.settled : 0;

  /** One invoice row, shared by the check groups and the no-check group so the two
   *  cannot drift apart in what they show or how a credit is signed. */
  const invoiceRow = (i: VendorInvoice, key: string) => (
    <tr key={key}>
      <td className="vc-num">
        <Link
          className="vc-invlink"
          to={invoiceHref(i, vendor?.name ?? '')}
          title="Open this invoice in the invoices register"
        >
          {i.number}
        </Link>
      </td>
      <td className="vc-num">{i.date}</td>
      <td className="vc-num vc-acct--cell">{i.account}</td>
      <td className={`n vc-num${i.amount < 0 ? ' vcinvoices__credit' : ''}`}>{money(i.amount)}</td>
    </tr>
  );

  return (
    <aside
      ref={panelRef}
      id="vendor-detail"
      className={`drawer vcpanel${open ? ' is-open' : ''}${resizing ? ' is-resizing' : ''}`}
      style={style}
      role="dialog"
      aria-modal="true"
      aria-label={vendor ? `${vendor.displayName} — payments` : 'Vendor details'}
      aria-hidden={!open}
      tabIndex={-1}
    >
      <ResizeGrip
        value={width ?? rendered}
        onChange={setUserWidth}
        onReset={resetWidth}
        onDraggingChange={setResizing}
        controls="vendor-detail"
        label="Resize the vendor details panel"
      />

      <div className="drawer__head">
        <div className="drawer__eyebrow">
          Vendor · {pluralise(vendor?.invoices.length ?? 0, 'invoice')} ·{' '}
          {pluralise(vendor?.checks.length ?? 0, 'check')}
        </div>
        <h2 className="drawer__name">{editableName}</h2>
        <div className="drawer__meta">
          <b>{money(vendor?.settled ?? 0)}</b> settled
          {vendor?.from ? (
            <>
              <br />
              invoices {vendor.from} → {vendor.to}
            </>
          ) : null}
        </div>
        <button
          ref={closeRef}
          type="button"
          className="drawer__close"
          onClick={onClose}
          aria-label="Close the vendor details panel"
        >
          <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="drawer__body">
        <section className="dsec">
          <div className="dsec__head">
            <h3 className="dsec__title">Checks and the invoices they settled</h3>
            {vendor ? (
              <span className="dsec__hint">{pluralise(vendor.checks.length, 'check')}</span>
            ) : null}
          </div>

          <div className="vcchecks">
            {vendor?.checks.map((c) => (
              <CheckGroup
                key={c.id}
                check={c}
                open={expanded.has(c.id)}
                onToggle={() => toggle(c.id)}
                renderRow={invoiceRow}
              />
            ))}

            {/* The invoices no check reaches. Rendered as a group of its own rather
                than omitted, so the panel's contents are the total it prints. */}
            {orphans.length > 0 ? (
              <div className="vchk">
                <div className="vchk__head vchk__head--plain">
                  <span className="vchk__title">No check recorded</span>
                  <span className="vchk__meta">
                    {pluralise(orphans.length, 'invoice')} ·{' '}
                    {money(orphans.reduce((s, i) => s + i.amount, 0))}
                  </span>
                </div>
                <div className="vchk__list">
                  <table className="vinvtable">
                    <caption className="sr">Invoices with no check recorded against them.</caption>
                    <thead>
                      <tr>
                        <th scope="col">Invoice No</th>
                        <th scope="col">Date</th>
                        <th scope="col">Account</th>
                        <th scope="col" className="n">
                          Amount
                        </th>
                      </tr>
                    </thead>
                    <tbody>{orphans.map((i, n) => invoiceRow(i, `orphan-${i.id}-${n}`))}</tbody>
                  </table>
                </div>
                <p className="vcnote">
                  These invoices are in the register and no payment document in it points at them.
                  That is a known state of this register rather than a missing value, and the ledger
                  says the same thing about them: <code>PAYMENT_STATUS_FLAG</code> is{' '}
                  <code>N</code> and <code>AMOUNT_PAID</code> is zero on every one. They are counted
                  in the total below, because they are money the register holds — and this
                  company&rsquo;s row on the page behind this panel carries the same count and sum,
                  so the two need not be reconciled by hand.
                </p>
              </div>
            ) : null}
          </div>

          {vendor?.credits ? (
            <p className="vcnote">
              {vendor.credits === 1 ? 'One invoice is a credit' : `${num(vendor.credits)} invoices are credits`}{' '}
              — a negative amount, which is why the total is smaller than the sum of the positive
              rows and why the figures below can be signed.
            </p>
          ) : null}
        </section>

        <section className="dsec">
          <div className="dsec__head">
            <h3 className="dsec__title">Total</h3>
            <span className="dsec__hint">
              {pluralise(vendor?.invoices.length ?? 0, 'invoice')} listed
            </span>
          </div>

          <div className="chkrows">
            <div className="chkrow chkrow--sum">
              <span className="chkrow__k">
                Settled{vendor && vendor.invoices.length > 1 ? ` (${num(vendor.invoices.length)})` : ''}
              </span>
              <span className="chkrow__v">{money(vendor?.settled ?? 0)}</span>
            </div>
            <div className="chkrow">
              <span className="chkrow__k">
                Checks issued{vendor && vendor.checks.length > 1 ? ` (${num(vendor.checks.length)})` : ''}
              </span>
              <span className="chkrow__v">{money(vendor?.issued ?? 0)}</span>
            </div>
            <div className="chkrow">
              {/* The label carries the direction, because the figure can legitimately
                  be negative and a bare "Difference" leaves the reader to work out
                  which of the two numbers is the larger. Naming the direction is
                  also more honest than painting the row as a warning: the page
                  argues in the note below that this gap is not an error, and a
                  warning colour would say the opposite of the sentence.

                  ★ AND IT MUST NOT SAY "invoices no check reached", WHICH IS WHAT IT
                    SAID UNTIL THE ROW MARKER WAS ADDED. That phrase describes the
                    unpaid set, and this figure is not that set — see the note below.
                    The two now sit on the same screen, $21,474.93 against $23,020.84
                    for WAKE COUNTY, and a label that conflated them would make one
                    of them look wrong. The direction is all this row claims. */}
              <span className="chkrow__k">
                {difference > 0
                  ? 'Difference — the checks also paid others'
                  : difference < 0
                    ? 'Difference — invoices exceed the checks'
                    : 'Difference'}
              </span>
              <span className="chkrow__v">{money(difference)}</span>
            </div>
          </div>

          <p className="vcnote">
            <strong>The total is the invoices, not the checks.</strong> Every invoice above, added
            — {money(vendor?.settled ?? 0)} across{' '}
            {pluralise(vendor?.invoices.length ?? 0, 'invoice')}. The checks are listed beside it
            because a check is written once for a whole payment and can settle invoices on more
            than one vendor, and because the ledger records <em>which</em> invoices a check paid and
            never how much of it went to each.{' '}
            {difference > 0 ? (
              <>
                So the difference is not an error to be reconciled: it is the part of those checks
                that paid somebody other than this vendor, less any invoice here that no check
                reached — two effects, netted, and the row above only claims their direction.
              </>
            ) : difference < 0 ? (
              <>
                So the difference is not an error either, and here it runs the other way: the
                invoices this register holds for the vendor come to more than the checks written to
                it. Two things put that figure there — invoices no check reaches, and checks that
                paid another vendor as well — and the two partly cancel.{' '}
                <strong>So it is not the amount that went unpaid.</strong> The money no check
                reaches is{' '}
                {money(vendor?.unpaidValue ?? 0)} across{' '}
                {pluralise(vendor?.unpaid ?? 0, 'invoice')}, and that pair is the figure marked
                under this company's Paid figure on the page behind this panel, and the group above
                — not this row.
              </>
            ) : (
              <>So the two figures agree here, which on this register is a coincidence rather than a rule.</>
            )}
          </p>

          <p className="vcnote">
            Download the file for every row above, with the total written into it.
          </p>

          <button
            type="button"
            className="btn btn--system btn--sm"
            onClick={() => vendor && exportVendor(vendor)}
            disabled={!vendor}
          >
            Download these invoices (CSV)
          </button>
        </section>

        <section className="dsec">
          <div className="dsec__head">
            <h3 className="dsec__title">Master record</h3>
            <span className="dsec__hint">
              {masterState === 'loading'
                ? 'reading…'
                : masterState === 'ready'
                  ? 'live from PO_VENDORS'
                  : masterState === 'missing'
                    ? 'no row found'
                    : masterState === 'failed'
                      ? 'could not be read'
                      : ''}
            </span>
          </div>

          {masterState === 'ready' && master ? (
            <div className="chkrows">
              {/*
                ★ THE LEDGER'S NAME IS PRINTED HERE, ALWAYS — not only when it differs.

                This section exists to describe the row `PO_VENDORS` holds, and its name
                is the field that found that row, so leaving it out made the section
                incomplete even before anyone could rename anything. Now that a custom
                name can be shown one heading up, this is also the answer to “what does
                Oracle actually call it?” without hovering anything — a tooltip is a
                poor place for the one fact a reconciliation depends on.
              */}
              <div className="chkrow">
                <span className="chkrow__k">Name (Oracle)</span>
                <span className="chkrow__v">{vendor?.name ?? ''}</span>
              </div>
              <div className="chkrow">
                <span className="chkrow__k">Vendor ID</span>
                {/* `ident`, not `num`: an id is a label, and grouping it as
                    "3,667,648" reads as a quantity nobody has. */}
                <span className="chkrow__v vc-num">{ident(master.id)}</span>
              </div>
              <div className="chkrow">
                <span className="chkrow__k">Type</span>
                <span className="chkrow__v">{master.type || '—'}</span>
              </div>
              <div className="chkrow">
                <span className="chkrow__k">Enabled</span>
                <span className="chkrow__v">{master.enabled ? 'Yes' : 'No'}</span>
              </div>
              <div className="chkrow">
                <span className="chkrow__k">Created</span>
                <span className="chkrow__v vc-num">{master.created || '—'}</span>
              </div>
            </div>
          ) : (
            <p className="vcnote">
              {masterState === 'loading'
                ? 'Reading the vendor master row from the live ledger…'
                : masterState === 'missing'
                  ? 'No row in PO_VENDORS carries this exact name. The payments above are unaffected — they come from the invoice register, which resolves the vendor by name on each invoice rather than through the master.'
                  : masterState === 'failed'
                    ? 'The vendor master could not be read just now. The payments above are complete without it; reopen the panel to try again.'
                    : ''}
            </p>
          )}

          {masterState === 'ready' && master && master.matches > 1 ? (
            <p className="vcnote">
              <strong>{num(master.matches)} master rows share this name.</strong> The first is shown.
              A vendor name is not a key on this ledger — the amounts here are unaffected, because
              they are keyed on the invoice, but a reader reconciling against Oracle should expect
              more than one row.
            </p>
          ) : null}

          <p className="vcnote">
            Read live from <code>PO_VENDORS</code>, which holds {num(LIVE_VENDOR_ROWS)} rows for this
            tenant — so it is looked up one company at a time rather than downloaded. (The lookup is
            a {num(MASTER_PAGE)}-row search filtered to an exact name, because <code>?q=</code> is a
            substring match: searching <code>DEWBERRY</code> returns{' '}
            <em>DEWBERRY DESIGN-BUILDERS INC</em> first, and the first row would be the wrong
            company.) <code>PARENT_VENDOR_ID</code> and <code>CUSTOMER_NUM</code> exist on the table
            but are null on every row this app has seen, which is why they are not shown.
          </p>
        </section>

        <section className="dsec">
          <div className="dsec__head">
            <h3 className="dsec__title">Accounts</h3>
            <span className="dsec__hint">
              {pluralise(vendor?.accounts.length ?? 0, 'combination')}
            </span>
          </div>

          {vendor && vendor.accounts.length > 0 ? (
            <div className="chkrows">
              {vendor.accounts.map((code) => (
                <div className="chkrow" key={code}>
                  <span className="chkrow__k vc-num vc-break">{code}</span>
                </div>
              ))}
            </div>
          ) : null}

          <p className="vcnote">
            These are the combinations the invoices above are booked to, and the reason they are on
            this page at all: the register is the {scopeText || 'scoped'} slice, and the fund and
            program that put each invoice in scope are segments of these codes. Each invoice row
            prints its own, so the scope can be checked against the data rather than taken from the
            heading.
          </p>
        </section>
      </div>
    </aside>
  );
}

/**
 * One check, and this vendor's invoices it settled, behind a disclosure.
 *
 * ★ A REAL `<button>`, NOT A CLICKABLE ROW AND NOT A BARE `<summary>`. The row
 *   handler this page uses for opening the panel is a mouse convenience; a
 *   disclosure has to be reachable and operable by keyboard, has to announce its
 *   state, and has to say what it controls — which is exactly what `aria-expanded`
 *   and `aria-controls` on a button give and a `<tr onClick>` cannot.
 */
function CheckGroup({
  check,
  open,
  onToggle,
  renderRow,
}: {
  check: VendorCheck;
  open: boolean;
  onToggle: () => void;
  renderRow: (i: VendorInvoice, key: string) => ReactNode;
}) {
  const listed = check.invoices.slice(0, INVOICE_CAP);
  const bodyId = `vchk-${check.id}`;

  return (
    <div className={`vchk${open ? ' is-open' : ''}`}>
      <div className="vchk__head">
        <button
          type="button"
          className="vchk__toggle"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <span className="vchk__chev" aria-hidden="true">
            <svg viewBox="0 0 12 12" fill="none">
              <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </span>
          <span className="vchk__num vc-num">{check.number}</span>
          <span className="vchk__date vc-num">{check.date}</span>
          <span className="vchk__amount vc-num">{money(check.amount)}</span>
          <span className="vchk__inv">
            {pluralise(check.invoices.length, 'invoice')} · {money(check.invoiced)}
          </span>
        </button>
      </div>

      {open ? (
        <div className="vchk__list" id={bodyId}>
          <table className="vinvtable">
            <caption className="sr">
              Invoices this check settled for this vendor.
            </caption>
            <thead>
              <tr>
                <th scope="col">Invoice No</th>
                <th scope="col">Date</th>
                <th scope="col">Account</th>
                <th scope="col" className="n">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>{listed.map((i, n) => renderRow(i, `${check.id}-${i.id}-${n}`))}</tbody>
            <tfoot>
              <tr>
                <th scope="row" colSpan={3}>
                  This vendor, this check
                </th>
                <td className="n vc-num">{money(check.invoiced)}</td>
              </tr>
            </tfoot>
          </table>

          {check.invoices.length > INVOICE_CAP ? (
            <p className="vcnote">
              Capped at {num(INVOICE_CAP)} rows so the panel opens quickly; the total above is over
              all {num(check.invoices.length)}. Download the list for the rest.
            </p>
          ) : null}

          <p className="vcnote">
            <strong>The check&rsquo;s own amount is {money(check.amount)}</strong> — the whole
            payment, which may cover other vendors as well. The ledger does not record how much of it
            went to these invoices, so the two figures are shown side by side and neither is derived
            from the other.
          </p>
        </div>
      ) : null}
    </div>
  );
}
