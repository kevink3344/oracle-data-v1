import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import {
  addressLines,
  applyCustomNames,
  cityLine,
  loadVendorSites,
  missingFields,
  phoneLine,
  RETIRED,
  SIGNAL_ORDER,
  signalOf,
  UnavailableError,
  type VendorSite,
  type VendorSiteGeoBlock,
  type VendorSiteOrder,
  type VendorSiteRegister,
  type VendorSiteSignal,
} from '../data/vendorSites';
import ErrorNotice from '../components/ErrorNotice';
import { CustomNamesNote, EditableField } from '../components/EditableField';
import { customLabels, useOverrides, type OverrideState } from '../data/customFields';
import ResizeGrip, { clampWidth, readStoredWidth, storeWidth } from '../components/ResizeGrip';
import VendorSiteMap from '../components/VendorSiteMap';
import { SortableHead } from '../components/SortHeader';
import { ident, money, money0, num, pluralise } from '../data/format';
import { CHRONO_ORDER, describeOrder, sortRows, type SortColumn, type SortState } from '../data/sort';
import { sameScope, scopeLabel, type Scope } from '../data/scope';
import { useStore } from '../state/store';
// The vendor fold, imported from the vendor data module rather than re-derived: an
// override is stored under the fold of the ledger's name, and both pages must fold it
// the same way or one of them silently fails to find a name the other saved.
import { vendorKeyOf } from '../data/vendors';

/**
 * Vendor sites — the address level under a vendor company, as the places this
 * tenant's money was actually committed.
 *
 * ── THE THINGS THIS SCREEN MUST NOT GET WRONG ───────────────────────────────
 *
 * 1. **THE TABS ARE A VIEW, NOT A FILTER THAT HIDES MONEY.** `Active` and
 *    `Deprecated` partition the register — 761 sites and 39 — and the deprecated
 *    side is not a list of nothing: those 39 sites carry **243 in-scope orders and
 *    $38,567,580.12**, they reach back to **2021-07-06** and forward to **2026-07-02**,
 *    and they are included in every total the endpoint returns. Both tab totals are
 *    printed on the page and they add up to the register's own figure, so the split
 *    can be checked rather than believed.
 *
 * 2. **"DO NOT USE" MATCHES ZERO OF THESE ROWS, AND THE PAGE SAYS SO.** The rule a
 *    reader will expect — Oracle's `DO NOT USE` token in `VENDOR_SITE_CODE` — matches
 *    **0 of the 800**, because the codes that carry it (669 of them, across 567
 *    vendors) are not named by any in-scope order. So deprecated is defined by three
 *    *other* signals, and the note under the tabs states the whole ladder —
 *    669 / 567 / 342 / **0** — so an empty expectation is explained rather than
 *    answered with a shrug.
 *
 * 3. **EVERY DEPRECATED ROW NAMES WHAT DEPRECATED IT.** The predicate is a union of
 *    `PURCHASING_SITE_FLAG = 'N'`, a non-null `INACTIVE_DATE` and a vendor literally
 *    named `DO NOT USE`, and the signals overlap — 37 rows carry one reason, one
 *    carries two (`651458`) and one carries all three (`12364`). The reasons come off
 *    the payload and are **rendered, never re-derived**: a second implementation of
 *    "is this site deprecated" is how a marker and its tab come to disagree.
 *
 * 4. **`DO NOT USE - PERFECTION EQUIPMENT` IS THE POINT OF THE DEPRECATED TAB, AND IT
 *    HAS 81 ORDERS.** Site `12364` is the only row whose vendor is *named* DO NOT USE
 *    and the only row where all three signals fire, and it holds
 *    **$4,433,380.94**. A tab that read as "these are dead" would be wrong about it.
 *    The row is not marked specially — the reasons are its marker, and they are the
 *    loudest thing in the table — but the note says which row to look for.
 *
 * 5. **A `$0.00` SITE WITH ORDERS IS TRUE.** A site's `amount` sums its orders'
 *    **in-scope** lines, and **26 of the 800** sites have every line charged elsewhere.
 *    They carry orders, they are on the page, and the cell says why instead of
 *    rendering a bare zero that reads as a failed join.
 *
 * 6. **THE ADDRESS IS WHY THIS LEAF EXISTS, AND IT IS OFTEN INCOMPLETE.** 624 of 800
 *    sites have no second address line, 794 no third, 373 no phone, 372 no area code,
 *    2 no state (one of which reads `CANADA`). Every row states what the record is
 *    missing rather than printing blank space a reader will read as a bug.
 *
 * 7. **THE SCOPE IS THE SERVER'S, NOT THE PICKER'S.** The fund/program/floor rule is
 *    applied in SQL against the organization's *stored* configuration, so narrowing
 *    the scope picker at the top of the app does not narrow this page. When the two
 *    differ the page says so, names both, and does not pretend to have applied the
 *    second one.
 *
 * 8. **A "DO NOT USE" SITE IS FLAGGED, NOT HIDDEN — AND THE SAME DISCIPLINE APPLIES
 *    TO EVERY OTHER INCOMPLETENESS.** Nothing on this register is dropped for looking
 *    wrong: not the zero-amount sites, not the two sites without a state, not the
 *    39 deprecated ones. The tabs reorder the register into two readable lists; they
 *    remove nothing from it.
 */

/** The panel remembers its width under its own key. */
const WIDTH_KEY = 'vendor-sites-panel-w';

/**
 * Sites per page. The shipped register is 800 rows, so paging is load-bearing here
 * — and the count follows the scope, so it stays a bound rather than a fact.
 */
const PER_PAGE = 50;

/**
 * How many of a site's orders the panel lists.
 *
 * ★ THE WIDEST SITE ON THIS REGISTER HAS **271** ORDERS, so nothing here is capped
 *   today — but the number is a bound and the page must not imply otherwise. The
 *   panel says how many it is showing, the CSV carries all of them, and the site's
 *   own row carries the total either way.
 */
const ORDER_CAP = 40;

/** The panel's focus trap reads the same set the other two drawers use. */
const FOCUSABLE =
  'a[href], button:not([disabled]), summary, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Which view of the register the page is showing. */
type Tab = 'active' | 'deprecated';

/** The two tabs, in the order they are drawn, with the wording used everywhere. */
const TABS: { id: Tab; label: string; blurb: string }[] = [
  { id: 'active', label: 'Active', blurb: 'sites with none of the three signals' },
  { id: 'deprecated', label: 'Deprecated', blurb: 'sites carrying at least one' },
];

const termsOf = (q: string): string[] =>
  q
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

/** The squashed form, so a site code pasted without its spaces still matches. */
const squash = (v: string): string => v.toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * A site row plus what its own order rows say, folded once at load.
 *
 * ★ THE ORDER ROWS ARE ON THE PAYLOAD, SO THE TABLE CAN SHOW A DATE IT WOULD
 *   OTHERWISE HAVE TO GO AND ASK FOR. `Latest` is "the newest in-scope order that
 *   named this site", which exists nowhere in the site row and is a fold of the order
 *   rows the endpoint already returned for the same population. Deriving it here
 *   rather than fetching it is what lets one request serve the whole page.
 */
interface SiteRow extends VendorSite {
  /** Newest in-scope order date naming this site. `''` when there is none. */
  latest: string;
  /** Oldest. Printed in the panel so a one-order site is visibly one order. */
  first: string;
  /** Orders on record for this site — the fold of the order rows, not the row's. */
  ordersOnRecord: number;
  /** Of those, the ones whose committed amount is zero. */
  zeroOrders: number;
}

/**
 * Everything a site can be found by, flattened once.
 *
 * ★ THE CODE IS IN HERE TWICE — AS THE LEDGER STORES IT AND SQUASHED. Oracle's site
 *   codes carry a trailing purpose suffix behind a space (`4733OLDUSHWY OP`), and a
 *   reader matching one against a spreadsheet or an export will paste it either with
 *   the spaces or without them. Searching only the literal form makes the second
 *   paste look like a site this register does not hold.
 *
 * The vendor id is in here as well: it is the one handle a reader reconciling against
 * Oracle has that does not depend on how anybody spelled a name.
 *
 * ★ BOTH VENDOR NAMES ARE IN HERE. The vendor id is the reconciliation handle, but a
 *   reader searching by name is holding whichever name they were shown — the custom one
 *   on this page, the ledger's one in Oracle — and an index carrying a single spelling
 *   would make the other search report "this register does not hold that company".
 */
function haystack(s: SiteRow): string {
  return [
    s.siteCode,
    squash(s.siteCode),
    s.displayName,
    s.vendorName,
    s.city ?? '',
    s.state ?? '',
    s.zip ?? '',
    s.addressLine1 ?? '',
    s.addressLine2 ?? '',
    s.addressLine3 ?? '',
    s.phone ?? '',
    s.areaCode ?? '',
    ident(s.vendorId),
    ident(s.vendorSiteId),
    s.deprecatedReasons.join(' '),
  ]
    .join(' ')
    .toLowerCase();
}

/**
 * The five columns, in the order they are shown.
 *
 * `value` is what the column is *ordered by*, not what the cell says — the code
 * column renders `EP-2851VANH OPE` and orders on that text, and `Latest` orders on the
 * ISO date rather than on the string the cell prints.
 *
 * ★ THE ORDER OF THIS ARRAY **IS** THE ORDER OF THE ROW, AND THE OTHER TWO COPIES ARE
 *   BELOW. `SortableHead` renders the `<thead>` from this list and `describeOrder`
 *   writes the caption and the live sort note from it, so the header text and the order
 *   a screen reader walks cannot drift from the visible columns — but the `<colgroup>`
 *   and each row's `<td>`s are hand-written in the same sequence and must be changed
 *   with it. A column moved here alone would put the header over another cell's data,
 *   which `table-layout: fixed` renders as a plausible table with the wrong numbers.
 *
 * ★ THE VENDOR LEADS AND THE SITE FOLLOWS. The first column is the row's name and the
 *   thing that opens the panel; the site code is the ledger's own key beside it, kept
 *   second because it is what the register is searched and cross-linked by. This is the
 *   same shape the companies register already has (`VendorCompanies.tsx`), so the two
 *   vendor tables are read the same way.
 *
 * ★ THERE IS NO "WHY DEPRECATED" COLUMN. The reasons sit under the site code inside
 *   the site cell — the **second** column, now that the vendor name leads the row —
 *   because a sixth column that is empty on the Active tab would be a column of nothing
 *   on 761 of the 800 rows, and because the reason belongs beside the site it explains
 *   rather than at the far edge of a wide table.
 *
 * ★ THE VENDOR COLUMN ORDERS ON WHAT IT SHOWS. Clicking the header is a request to sort
 *   the vendor names the reader can see; ordering on the ledger's names instead would
 *   leave one renamed company sitting somewhere the header does not explain. (The export
 *   keeps both names, so nothing here is a substitution — see `exportSites`.)
 */
const COLUMNS: SortColumn<SiteRow>[] = [
  { key: 'vendor', label: 'Vendor', value: (s) => s.displayName },
  { key: 'site', label: 'Site', value: (s) => s.siteCode },
  { key: 'orders', label: 'Orders', numeric: true, value: (s) => s.orders },
  { key: 'amount', label: 'Committed', numeric: true, value: (s) => s.amount },
  { key: 'latest', label: 'Latest', value: (s) => s.latest, order: CHRONO_ORDER },
];

/**
 * The order the page opens on, on both tabs: the biggest commitment first.
 *
 * ★ THE SAME DEFAULT ON BOTH TABS IS DELIBERATE. The deprecated tab's first row is
 *   then $14.6M rather than whatever crawls to the top by date, which is what makes
 *   the tab read as "the deprecated sites that matter" instead of "the tail of the
 *   register" — the misreading the page's notes exist to prevent.
 */
const BY_VALUE: SortState = { key: 'amount', dir: 'desc' };

/** A page list with gaps, so 16 pages does not read as a machine output. */
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
 * The rows currently on screen, as a CSV, built in the browser.
 *
 * ★ IT EXPORTS THE **FILTERED SET**, NOT THE PAGE. The table shows 50 rows of 761 and
 *   the file is the only way a reader gets the rest; exporting the window would
 *   silently deny that the other 711 exist, which is the same failure as filtering a
 *   capped list. The tab, the search and the order all apply before the slice, and the
 *   file follows all three.
 *
 * ★ THE TOTAL ROW IS WRITTEN INTO THE FILE. A reader who opens this in a spreadsheet
 *   should not have to trust their own sum, and the two figures the page quotes —
 *   orders and committed dollars — are the two the register totals over the same rows.
 */
function exportSites(rows: SiteRow[], tab: Tab, query: string) {
  const header = [
    'Vendor Site ID',
    'Site Code',
    'Vendor',
    'Vendor ID',
    'Address Line 1',
    'Address Line 2',
    'Address Line 3',
    'City',
    'State',
    'ZIP',
    'Area Code',
    'Phone',
    'Purchasing Site',
    'Inactive Date',
    'Orders',
    'Committed',
    'Status',
    'Why deprecated',
    // ★ APPENDED, NOT INSERTED AFTER 'Vendor'. A reader may have renamed the company, so
    //   the column they know is the useful label — but a file that goes out with a custom
    //   name and no ledger name cannot be reconciled by whoever receives it, and this
    //   export's whole audience is people reconciling against Oracle. Putting it last
    //   keeps the eighteen columns a spreadsheet template already assumes in place.
    'Vendor (Oracle)',
  ];
  const body = rows.map((s) => [
    ident(s.vendorSiteId),
    s.siteCode,
    s.displayName,
    ident(s.vendorId),
    s.addressLine1 ?? '',
    s.addressLine2 ?? '',
    s.addressLine3 ?? '',
    s.city ?? '',
    s.state ?? '',
    s.zip ?? '',
    s.areaCode ?? '',
    s.phone ?? '',
    s.purchasingSiteFlag ?? '',
    s.inactiveDate ?? '',
    String(s.orders),
    s.amount.toFixed(2),
    s.status,
    s.deprecatedReasons.join('; '),
    s.vendorName,
  ]);
  const orders = rows.reduce((n, s) => n + s.orders, 0);
  const amount = rows.reduce((n, s) => n + s.amount, 0);
  const csv = [
    header,
    ...body,
    [
      '', '', '', '', '', '', '', '', '', '', '', '', '', '', String(orders), amount.toFixed(2),
      'Total', '', '',
    ],
  ]
    .map((r) => r.map(csvCell).join(','))
    .join('\r\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const stamp = query.trim() ? `-search` : '';
  a.download = `vendor-sites-${tab}${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** One deprecation reason, as a chip. `retired` carries its date; the rest are phrases. */
function reasonChip(reason: string) {
  const signal = signalOf(reason);
  const date = signal === RETIRED ? reason.slice(RETIRED.length).trim() : '';
  return (
    <span className={`vs-reason vs-reason--${signal === RETIRED ? 'retired' : 'flag'}`} key={reason}>
      <span className="vs-reason__k">{signal}</span>
      {date ? <span className="vs-reason__d">{date}</span> : null}
    </span>
  );
}

export default function VendorSites() {
  /**
   * ★ THE REGISTER AND WHAT THE PAGE PRINTS ARE TWO DIFFERENT VALUES.
   *
   * `raw` is what the endpoint sent; `data` below is that with any custom vendor names
   * folded in. Kept apart because the two reads are independent requests — the override
   * read can fail while the register is perfectly loaded — and because saving one name
   * must not re-download 800 sites to change a label.
   *
   * ★ NOTHING BELOW COUNTS A NAME. `counts.*`, `directory.*`, `observed.*` and the geo
   *   block are the server's own folds over status, orders and amounts, and this
   *   decorator touches `sites[].vendorName` alone — so no figure on the page can move
   *   because a reader renamed a company. If a count ever starts folding a name, this
   *   becomes wrong in a way nothing reports.
   */
  const [raw, setRaw] = useState<VendorSiteRegister | null>(null);
  const [error, setError] = useState('');
  const [unavailable, setUnavailable] = useState<UnavailableError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [params, setParams] = useSearchParams();

  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState>(BY_VALUE);
  const [sortNote, setSortNote] = useState('');

  const [selected, setSelected] = useState<SiteRow | null>(null);
  const [open, setOpen] = useState(false);

  const location = useLocation();
  const { scope: liveScope, scopeTenant } = useStore();

  /**
   * The tab is URL state, like the panel — so a view can be linked, bookmarked and
   * reloaded, and so `?status=deprecated` is a thing a reader can be sent.
   */
  const tab: Tab = (params.get('status') ?? '').toLowerCase() === 'deprecated'
    ? 'deprecated'
    : 'active';

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    setUnavailable(null);
    setRaw(null);
    loadVendorSites(controller.signal)
      .then((next) => setRaw(next))
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        // ★ A 503 IS NOT AN ERROR. It says the register cannot be served, which is its own
        //   state with its own explanation rather than the red failure notice. The two
        //   reasons behind it are not the same news, though — a non-Oracle ledger will not
        //   change on reload, while an unreachable one will, so whether to offer a retry is
        //   the box's decision (see `UnavailableError.kind`), not this branch's.
        if (e instanceof UnavailableError) setUnavailable(e);
        else setError(e instanceof Error ? e.message : String(e));
      });
    return () => controller.abort();
  }, [attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  /**
   * ★ ONE OVERRIDE READ FOR THE PAGE, AND ONE PASS OVER THE REGISTER.
   *
   * This screen shows the same companies the vendor register does, keyed by the fold of
   * the ledger's `VENDOR_NAME`, so it must read the same overrides or a reader would be
   * shown two different names for one company across two pages. `customLabels` gives
   * nothing for a read that FAILED, so every site falls back to the ledger's own name —
   * correct, because a name that could not be read must not be invented — and the note
   * above the table says so, which is what makes the fallback honest rather than silent.
   */
  const overrides = useOverrides('vendor');
  const labels = useMemo(() => customLabels(overrides, 'name'), [overrides]);
  const data = useMemo(() => (raw ? applyCustomNames(raw, labels) : null), [raw, labels]);
  const reloadOverrides = overrides.reload;

  /**
   * ★ A SECOND READ, BECAUSE THIS IS A SECOND SUBJECT — AND THAT IS NOT A PREFERENCE.
   *
   * A site's email belongs to the SITE (`VENDOR_SITE_ID`) while the name above belongs
   * to the company, and the registry declares them as two subjects for that reason: one
   * email covering every site a vendor has is not what a reader looking at one address
   * means by it. Two subjects are two reads — `GET /api/custom-fields?subject=…` answers
   * one at a time — and each read fails on its own, which is why the panel renders its
   * own unread note rather than leaning on the register's.
   *
   * ★ ONE READ FOR THE PAGE, NOT ONE PER PANEL OPEN. An override is a row a person
   *   saved, so the whole subject's set is small however large the register is, and it
   *   is already in hand before any panel opens. A read per open would put a request
   *   behind every row click and show the pencil a beat late.
   */
  const siteOverrides = useOverrides('vendor_site');
  const reloadSiteOverrides = siteOverrides.reload;

  /**
   * The order rows, by site, and the site rows they enrich — both folded once.
   *
   * ★ THE ORDER ROWS ARE THE SAME POPULATION AS THE SITE ROWS, SO THE COUNTS MUST
   *   AGREE, AND THEY ARE COMPUTED FROM OPPOSITE DIRECTIONS ON PURPOSE. `orders` on a
   *   site row is the server's fold of the pair set; `ordersOnRecord` here is the count
   *   of order rows the payload actually carries for that site. The panel prints both,
   *   because two readings of one fact that can never be seen together cannot be
   *   checked by a reader — and a site whose own figure disagreed with its listed orders
   *   would be the one thing on this page that looks like an arithmetic error.
   */
  const rows = useMemo<SiteRow[]>(() => {
    if (!data) return [];
    const bySite = new Map<number, VendorSiteOrder[]>();
    for (const o of data.orders) {
      const list = bySite.get(o.vendorSiteId);
      if (list) list.push(o);
      else bySite.set(o.vendorSiteId, [o]);
    }
    return data.sites.map((s) => {
      const orders = bySite.get(s.vendorSiteId) ?? [];
      let latest = '';
      let first = '';
      let zero = 0;
      for (const o of orders) {
        if (o.amount === 0) zero += 1;
        if (!latest || o.approvedDate > latest) latest = o.approvedDate;
        if (!first || o.approvedDate < first) first = o.approvedDate;
      }
      return { ...s, latest, first, ordersOnRecord: orders.length, zeroOrders: zero };
    });
  }, [data]);

  /** The orders behind the selected site, newest first. Read off the payload. */
  const ordersBySite = useMemo(() => {
    const m = new Map<number, VendorSiteOrder[]>();
    for (const o of data?.orders ?? []) {
      const list = m.get(o.vendorSiteId);
      if (list) list.push(o);
      else m.set(o.vendorSiteId, [o]);
    }
    for (const list of m.values()) list.sort((a, b) => (a.approvedDate < b.approvedDate ? 1 : -1));
    return m;
  }, [data]);

  // ★ THE TAB IS APPLIED BEFORE THE SEARCH AND BEFORE THE PAGE, in that order and for
  //   a reason: the tab is the population, the search is a narrowing of it, and the
  //   page is a window on the result. Applying the tab after the search would let a
  //   search that matches deprecated rows report them as absent from a table that
  //   cannot show them — the same class of lie as filtering a capped list.
  const inTab = useMemo(() => rows.filter((s) => s.status === tab), [rows, tab]);

  const matches = useMemo(() => {
    const terms = termsOf(query);
    if (!terms.length) return inTab;
    return inTab.filter((s) => {
      const hay = haystack(s);
      return terms.every((t) => hay.includes(t));
    });
  }, [inTab, query]);

  const sorted = useMemo(() => sortRows(matches, COLUMNS, sort), [matches, sort]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PER_PAGE));
  const current = Math.min(page, totalPages);
  const shown = sorted.slice((current - 1) * PER_PAGE, current * PER_PAGE);

  const applySort = (next: SortState) => {
    setSort(next);
    setPage(1);
    setSortNote(`Ordered by ${describeOrder(COLUMNS, next)}.`);
  };

  /** The URL for one tab, keeping nothing that belongs to the other one. */
  const tabHref = (id: Tab): string => {
    const next = new URLSearchParams(params);
    if (id === 'active') next.delete('status');
    else next.set('status', id);
    // ★ THE OPEN PANEL GOES WITH THE TAB. A site is on one tab or the other, so
    //   carrying `?site=` across a switch would leave the URL naming a row the new
    //   table cannot show — and the arrival effect would then open a panel for a site
    //   that is not in the list behind it.
    next.delete('site');
    const qs = next.toString();
    return `${location.pathname}${qs ? `?${qs}` : ''}`;
  };

  const openSite = (s: SiteRow) => {
    setSelected(s);
    setOpen(true);
    const next = new URLSearchParams(params);
    next.set('site', String(s.vendorSiteId));
    setParams(next, { replace: true });
  };

  const closePanel = () => {
    setOpen(false);
    const next = new URLSearchParams(params);
    next.delete('site');
    setParams(next, { replace: true });
  };

  /**
   * ★ A LINK ARRIVED WITH A SITE, AND THE NOTE SAYS WHAT HAPPENED.
   *
   * The value is read **once at mount** into a ref. Clicking a row also writes
   * `?site=`, and reading the param on every render would treat a click as an arrival
   * — which on this page means a site the reader opened being reported back to them as
   * "the link asked for…", or worse, a tab switch reported as a failed lookup.
   * Nothing else in the app links here with `?site=`, so mount is exactly the arrival.
   */
  const arrived = useRef(false);
  const arrivalParam = useRef<string | null>(null);
  if (arrivalParam.current === null) {
    arrivalParam.current = (params.get('site') ?? '').trim();
  }
  const [missing, setMissing] = useState('');

  useEffect(() => {
    const wanted = arrivalParam.current ?? '';
    if (!wanted || arrived.current || !rows.length) return;
    arrived.current = true;
    const found = rows.find((s) => String(s.vendorSiteId) === wanted);
    if (found) {
      // The arrival respects the tab it did not choose: opening a deprecated site
      // while the Active tab is showing would put a panel over a table that does not
      // contain its row.
      if (found.status !== tab) {
        const next = new URLSearchParams(params);
        if (found.status === 'active') next.delete('status');
        else next.set('status', found.status);
        setParams(next, { replace: true });
      }
      setQuery('');
      // ★ AND THE TABLE FOLLOWS THE PANEL TO THE ROW. Resetting to page 1 put the
      //   panel over a table that did not contain its own row: a site whose figure
      //   sorts it late — every one of the 26 sites reading $0, since the default sort
      //   is amount descending — opened a panel with the row's `is-open` marker on a
      //   page nobody was looking at, and closing the panel left the reader on page 1
      //   with no sign of the site the link named. The page that holds the row is the
      //   page the arrival shows; a site not on any page keeps the old behaviour.
      const at = sorted.findIndex((s) => s.vendorSiteId === found.vendorSiteId);
      setPage(at >= 0 ? Math.floor(at / PER_PAGE) + 1 : 1);
      setSelected(found);
      setOpen(true);
    } else {
      setMissing(wanted);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  const scope = data?.scope;

  /**
   * ★ THE ENDPOINT'S SCOPE IS THE ORGANIZATION'S STORED ONE, NOT THE PICKER'S.
   *
   * `defaultTenant()` reads `organization.fund/programs/start_fy` on the server and
   * `scopeClause()` builds the predicate from it, so this page is *always* the stored
   * scope. The picker above the search box narrows the extract-backed pages; it does
   * not and cannot narrow this one. Comparing the two and saying so is the difference
   * between a reader trusting a heading they did not check and a reader knowing which
   * configuration they are looking at.
   */
  const registerScope: Scope | null = scope ? { fund: scope.fund, programs: scope.programs } : null;
  const scopeMoved = registerScope ? !sameScope(registerScope, liveScope) : false;

  const tabCount = tab === 'active' ? data?.counts.activeSites ?? 0 : data?.counts.deprecatedSites ?? 0;
  const tabOrders = tab === 'active' ? data?.counts.activeOrders ?? 0 : data?.counts.deprecatedOrders ?? 0;
  const tabAmount = tab === 'active' ? data?.totals.activeAmount ?? 0 : data?.totals.deprecatedAmount ?? 0;

  /** What the rows on screen come to, so a filtered view is not read as the tab. */
  const filteredOrders = matches.reduce((n, s) => n + s.orders, 0);
  const filteredAmount = matches.reduce((n, s) => n + s.amount, 0);

  const searched = termsOf(query).length > 0;

  /** The deprecated tab's widest row, for the note that reads it out. */
  const worst = useMemo(() => {
    const list = rows.filter((s) => s.status === 'deprecated');
    if (!list.length) return null;
    return list.reduce((a, b) => (b.amount > a.amount ? b : a));
  }, [rows]);

  /** The row carrying every signal at once — the one the copy names. */
  const allThree = useMemo(
    () => rows.filter((s) => s.status === 'deprecated' && s.deprecatedReasons.length === 3)[0] ?? null,
    [rows],
  );

  /**
   * The three signals by name, so the legend reads the payload rather than an index.
   *
   * ★ THE LEGEND IS KEYED ON THE BARE SIGNAL, NOT ON THE ARRAY POSITION. The endpoint
   *   promises three entries in a fixed order, but `deprecatedSignals[1]` breaks the
   *   moment a fourth signal is added or the order changes, and it would break silently
   *   — the page would print the retired count under the wrong heading and every number
   *   in the sentence would still be a number the server sent.
   */
  const signals = useMemo(() => {
    const m = new Map<string, VendorSiteSignal>();
    for (const s of data?.deprecatedSignals ?? []) m.set(signalOf(s.signal), s);
    return m;
  }, [data]);

  /**
   * How many deprecated rows carry one, two or three of the signals — counted here.
   *
   * ★ THE THREE SIGNALS DO NOT SUM TO THE TAB, AND ONLY THE ROWS CAN SAY BY HOW MUCH.
   *   A reader who adds the legend up gets 42 against a tab of 39 and a wrong total is
   *   the thing they will report. This histogram is the explanation, and it is taken off
   *   the same `deprecatedReasons` the row markers render rather than restated in prose.
   */
  const overlap = useMemo(() => {
    const h = [0, 0, 0, 0];
    for (const s of rows) {
      if (s.status !== 'deprecated') continue;
      h[Math.min(s.deprecatedReasons.length, 3)] += 1;
    }
    return h;
  }, [rows]);

  /**
   * ★ THE HEAD LINE IS THE FOURTH STATE, AND IT WAS THE FIRST THREE ONLY.
   *
   * This used to be `data ? <figures> : 'Reading the vendor site register…'`, which has
   * two states — read and reading — and the page has four. So an unavailable or failed
   * render printed "Reading the vendor site register…" in the largest, most-read
   * sentence on the screen, directly above a box that had already finished saying the
   * register could not be served. A reader takes that one line and stops; it was telling
   * them the page was still working on a question it had settled.
   *
   * ★ THE TWO UNAVAILABLE KINDS NOW SHARE ONE SENTENCE, BECAUSE THE BOX BELOW THEM DOES.
   *   They used to be split here — "the ledger is not answering" against "this
   *   configuration's ledger has none" — and that split is gone by decision: the box shows
   *   the reader one plain message whatever the cause, so a head line that still
   *   distinguished them would be the only place on the page drawing the distinction. See
   *   the note on the box for what that costs.
   */
  /*
   * ★ THE HEAD'S SENTENCE IS GONE, ON STAFF'S INSTRUCTION, AND SO IS `subtitle`.
   *
   * It carried the register's eight figures — sites, vendors, orders, lines, committed, and the
   * deprecated count and value — all of which the tabs, the table and the pager below already
   * state. The unavailable/error/loading branches went with it: those states are drawn by the box
   * below, which is where a reader looks when the page has nothing to show.
   */

  return (
    <div className="stack">
      <div>
        <div className="accent-rule" />
        <div className="page-head">
          <div>
            <h1>Vendor sites</h1>
          </div>
        </div>
      </div>

      {/*
        ★ THE SCOPE NOTE CARRIES THE 669 / 567 / 342 / 0 LADDER, WHICH IS THE ONLY
          PLACE THE "DO NOT USE" QUESTION IS ANSWERED. A reader who knows Oracle's
          convention will look for those codes; the register holds none, and a page
          that simply did not mention it would look like it had not looked.
      */}
      {scope && data ? (
        <p className="scopenote" role="note">
          <span className="scopenote__flag">Scoped</span>
          <span className="scopenote__text">
            <strong>
              {scope.name} — fund {scope.fund}, programs {scope.programs.join('/')}, from {scope.from}.
            </strong>{' '}
            These rows are the sites named by a purchase order inside that scope, which is what the
            order query in <code>routes/vendorSites.ts</code> builds from the organization&rsquo;s own
            settings. <strong>{num(data.counts.vendors)} vendors</strong> drew from it, so a vendor
            that sold to this tenant outside these programs is not here. The rule is applied in SQL
            against the stored configuration, so it does not follow the scope picker above the search
            box — and the directory holds{' '}
            <strong>{num(data.directory.sites)} sites</strong> whose code carries the literal token{' '}
            <code>DO NOT USE</code>, across {num(data.directory.vendors)} vendors, of which{' '}
            <strong>{num(data.directory.withAnyOrder)}</strong> are named by any purchase order at
            all and <strong>{num(data.directory.namedByAnInScopeOrder)}</strong> by an in-scope one.
            That last figure is why the Deprecated tab is not built on the code.
          </span>
        </p>
      ) : null}

      {data && scopeMoved && registerScope ? (
        <p className="scopenote" role="note">
          <span className="scopenote__flag">Scope difference</span>
          <span className="scopenote__text">
            This register reads <strong>{scopeLabel(registerScope, scope?.programs ?? [])}</strong>,
            the organization&rsquo;s stored configuration. The scope picker is now{' '}
            <strong>{scopeLabel(liveScope, scopeTenant?.programs ?? [])}</strong>, which{' '}
            <em>this page cannot apply</em>: on this register the rule is a predicate in the server&rsquo;s
            SQL, not a filter in the browser. Change the organization&rsquo;s settings to move it —
            narrowing the picker will not.
          </span>
        </p>
      ) : null}

      {/*
        ★ THE DATABASE-DOWN BOX: ONE MESSAGE, IN PLAIN WORDS, FOR EVERY 503.

          WHAT THIS REPLACED, AND WHY IT WENT. The previous box was written for someone
          auditing the server, not for someone reading a screen: it printed the server's own
          sentence (`ORA-12541: Cannot connect. No listener at …`), the name of the store it
          had looked in, a paragraph on why the frozen extract cannot stand in for the ledger
          (it carries no `VENDOR_SITE_ID`), and a remedy that changed with the cause — point
          the server at Oracle for one, wait for the other. Every clause of it was true and
          the whole of it read as a fault report. A reader who arrives at a broken page needs
          three things and none of them is a stack trace: something is down, it is not their
          query, and here is the one action available to them.

        ★ IT NO LONGER BRANCHES ON `unavailable.kind` — AND THE COST IS REAL (user's call,
          2026-09-21). The two 503s are not the same news: one is an outage, the other is a
          server correctly refusing a ledger it was pointed at that is not Oracle (see the
          `UnavailableError` note in `data/vendorSites.ts`). This box now calls both "currently
          unavailable due to an unforeseen issue", which overstates the second — nothing is
          unforeseen there. It is also shown a retry button that cannot help either, since a
          reload cannot repoint the server. Both were accepted knowingly, in exchange for a
          message that never reads as a puzzle and that a non-technical reader can act on.

        ★ `role="alert"` BECAUSE THE PAGE CAN SETTLE INTO THIS STATE WITHOUT A CLICK.
          `{error}` below keeps its own `role="alert"` through `ErrorNotice`; this box is the
          same kind of news — the load finished and the answer is "no" — so it announces too.
      */}
      {unavailable ? (
        <div className="chkempty vsunavailable" role="alert">
          <p className="vsunavailable__flag">Database unavailable</p>
          <p className="vsunavailable__lead">
            <strong>The database is currently unavailable due to an unforeseen issue.</strong>
          </p>
          <p className="chkempty__hint">
            Every row on this page is read from the database as the page loads, so there is
            nothing to show until it answers. Nothing is wrong with the page, and nothing here
            needs changing.
          </p>
          <p>
            <button type="button" className="btn btn--system btn--sm" onClick={reload}>
              Try again
            </button>
          </p>
        </div>
      ) : null}

      {error ? (
        <ErrorNotice
          error={error}
          reload={reload}
          heading="The vendor site register could not be read."
          hint={
            <p>
              This page reads <code>/api/vendor-site-register</code>, which folds the in-scope
              purchase orders by site straight from the ledger. Reloading re-asks the question.
            </p>
          }
        />
      ) : null}

      {data ? (
        <>
          <p className="sr" role="status">
            {searched
              ? `${num(matches.length)} of ${num(tabCount)} ${tab} sites match "${query}".`
              : `${num(tabCount)} ${tab} sites.`}
          </p>

          {/*
            ★ THE FIVE STAT CARDS ARE GONE, ON STAFF'S INSTRUCTION. They read: sites, committed,
            deprecated, orders-with-no-in-scope-money and codes-reused — all counts and totals over
            the table below, which carries the per-site rows they summed.

            The `Stat` component they used is deleted with them further down this file; nothing else
            called it.
          */}

          <section className="panel">
            <div className="panel__head">
              <div>
                <h2 className="panel__title">Sites</h2>
                <p className="panel__sub">
                  One site per row, {describeOrder(COLUMNS, sort)}. Orders counts the in-scope orders
                  that named this site and Committed is what their in-scope lines come to, so a site
                  can have orders and no committed money — those rows say so rather than showing a
                  bare zero. Click a site for its address, its flags and its orders.
                </p>
              </div>
              <span className="panel__count">
                {num(shown.length)} of {num(sorted.length)}
              </span>
            </div>

            {/*
              ★ THE TABS ARE LINKS, NOT A TABS WIDGET. The view is URL state, and a real
                `<button role="tab">` would have to bring a roving tabindex, arrow keys
                and a `tabpanel` role with it to be honest — while an `<a href="?status=…">`
                is keyboard-operable, linkable and bookmarkable for nothing. `aria-current`
                says which one is showing; the counts are on the labels so the two figures
                the split is about are never off screen.
            */}
            <div className="vstabs" role="group" aria-label="Which sites to show">
              {TABS.map((t) => {
                const count = t.id === 'active' ? data.counts.activeSites : data.counts.deprecatedSites;
                return (
                  <Link
                    key={t.id}
                    to={tabHref(t.id)}
                    className={`vstab${tab === t.id ? ' is-on' : ''}`}
                    aria-current={tab === t.id ? 'true' : undefined}
                  >
                    <span className="vstab__label">{t.label}</span>
                    <span className="vstab__n">{num(count)}</span>
                    <span className="vstab__blurb">{t.blurb}</span>
                  </Link>
                );
              })}
            </div>

            {/*
              ★ THE TAB'S OWN ARITHMETIC, BECAUSE A SPLIT NOBODY CAN CHECK IS A CLAIM.
                Active and Deprecated are the whole register, and the three figures on
                each side add up to the register's own. Both halves are printed here
                whichever tab is showing, so a reader on Active can still see that the
                deprecated rows they are not looking at hold real money.
            */}
            <p className="vs-split">
              <strong>{TABS[0].label}</strong> {pluralise(data.counts.activeSites, 'site')} ·{' '}
              {pluralise(data.counts.activeOrders, 'order')} ·{' '}
              {money0(data.totals.activeAmount)}
              <span className="vs-split__sep" aria-hidden="true">
                +
              </span>
              <strong>{TABS[1].label}</strong> {pluralise(data.counts.deprecatedSites, 'site')} ·{' '}
              {pluralise(data.counts.deprecatedOrders, 'order')} ·{' '}
              {money0(data.totals.deprecatedAmount)}
              <span className="vs-split__sep" aria-hidden="true">
                =
              </span>
              <strong>whole register</strong> {pluralise(data.counts.sites, 'site')} ·{' '}
              {pluralise(data.counts.orders, 'order')} · {money0(data.totals.amount)}
            </p>

            {/*
              ★ THE DEPRECATED TAB EXPLAINS ITSELF ON THE TAB. What "deprecated" means
                here, why the obvious rule is not it, and the fact that these rows carry
                money — three sentences a reader needs before reading the table, and none
                of them reachable from a row.
            */}
            {tab === 'deprecated' ? (
              <div className="vs-note" role="note">
                <p>
                  <strong>Deprecated is a description here, not an exclusion.</strong>{' '}
                  {pluralise(data.counts.deprecatedSites, 'site')} carry at least one of three
                  signals. They are not sites with no activity: they hold{' '}
                  {pluralise(data.counts.deprecatedOrders, 'order')} worth{' '}
                  {money(data.totals.deprecatedAmount)}, from {data.observed.deprecatedFirstOrderDate}{' '}
                  to {data.observed.deprecatedLastOrderDate}, and they are counted in every total this
                  register reports.
                </p>

                {/*
                  ★ THE LEGEND IS THE EXPLANATION OF THE OVERLAP, WHICH IS WHY THE OVERLAP IS
                    PRINTED UNDER IT. Three counts that sum to more than the tab are the first
                    thing a careful reader notices, and "why do these add up to 42" has a real
                    answer — the signals are not exclusive.
                */}
                <ul className="vs-signals">
                  {SIGNAL_ORDER.map((name) => {
                    const s = signals.get(name);
                    return (
                      <li key={name} className="vs-signal">
                        <span className={`vs-signal__k vs-signal__k--${name === RETIRED ? 'retired' : 'flag'}`}>
                          {name}
                        </span>
                        <span className="vs-signal__v">
                          {pluralise(s?.sites ?? 0, 'site')} · {pluralise(s?.orders ?? 0, 'order')} ·{' '}
                          {money(s?.amount ?? 0)}
                        </span>
                      </li>
                    );
                  })}
                </ul>

                <p>
                  Those three counts sum to{' '}
                  {num(SIGNAL_ORDER.reduce((n, name) => n + (signals.get(name)?.sites ?? 0), 0))}{' '}
                  signals against {num(data.counts.deprecatedSites)} rows, because they are not
                  exclusive: {num(overlap[1])} rows carry one of them, {num(overlap[2])} carries two
                  and {num(overlap[3])} carries all three
                  {overlap[0] > 0
                    ? `, and ${num(overlap[0])} is on this tab without a reason — which would be a defect in the endpoint rather than a reading of it`
                    : ''}
                  . Every row below names its own, in the server&rsquo;s own words.
                </p>

                <p>
                  <strong>Why not the site code.</strong> Oracle shops park the literal token{' '}
                  <code>DO NOT USE</code> in <code>VENDOR_SITE_CODE</code>, and it matches{' '}
                  <strong>none of these {num(data.counts.sites)} sites</strong> — before or after
                  stripping spaces. The directory holds {num(data.directory.sites)} such codes across{' '}
                  {num(data.directory.vendors)} vendors and {num(data.directory.withAnyOrder)} of them
                  are named by some purchase order, but{' '}
                  <strong>not one is named by an in-scope order</strong>. The three signals above are
                  what is left: evidence carried by the row rather than a convention{' '}
                  {num(data.counts.sites)} rows away.
                </p>

                {allThree ? (
                  <p>
                    {/*
                      ★ THESE TWO NAMES ARE THE LEDGER'S, AND THAT IS THE ARGUMENT RATHER
                        THAN AN OVERSIGHT. `allThree` is the row whose vendor is *literally*
                        named `DO NOT USE`, and `worst` is the largest row on the tab; both
                        are named here to be recognised. Substituting a custom name would
                        break the sentence for `allThree` — "the only site whose vendor is
                        *named* DO NOT USE" cannot be said about a company called something
                        else — and a reader who has renamed one of these two will find them
                        on the tab by the vendor id the row also prints.
                    */}
                    <strong>
                      {allThree.vendorName} ({allThree.siteCode}) is the row to look at.
                    </strong>{' '}
                    It is the only site whose vendor is <em>named</em> DO NOT USE, the only one where
                    all three signals fire, and it holds {pluralise(allThree.orders, 'order')} worth{' '}
                    {money(allThree.amount)}
                    {worst && worst.vendorSiteId !== allThree.vendorSiteId ? (
                      <>
                        . The largest row on this tab is{' '}
                        <strong>
                          {worst.vendorName} ({worst.siteCode})
                        </strong>{' '}
                        at {money(worst.amount)} across {pluralise(worst.orders, 'order')} — a
                        different site, deprecating for a different reason
                      </>
                    ) : null}
                    . Neither is an accident of the query.
                  </p>
                ) : null}
              </div>
            ) : null}

            {tab === 'active' ? (
              <div className="vs-note" role="note">
                <p>
                  <strong>Nothing on this tab carries a deprecation signal.</strong> These{' '}
                  {num(data.counts.activeSites)} sites are purchasing sites (
                  <code>PURCHASING_SITE_FLAG = Y</code>), carry no <code>INACTIVE_DATE</code> and
                  belong to vendors whose names do not read <code>DO NOT USE</code>. The{' '}
                  {num(data.counts.deprecatedSites)} sites that do carry one are on the other tab —
                  they are not removed from the register, and their{' '}
                  {money0(data.totals.deprecatedAmount)} is inside the total above. This tab holds{' '}
                  {num(data.observed.activeVendors)} of the register&rsquo;s{' '}
                  {pluralise(data.counts.vendors, 'vendor')}, so{' '}
                  {pluralise(data.counts.vendors - data.observed.activeVendors, 'vendor')} appear
                  only under {TABS[1].label.toLowerCase()}.
                </p>
              </div>
            ) : null}

            <div className="filterbar vcfilter" role="group" aria-label="Filter sites">
              <div className="vcfilter__box">
                <label className="sr" htmlFor="vs-q">
                  Search sites
                </label>
                <input
                  id="vs-q"
                  type="search"
                  className="vcfilter__input"
                  placeholder="Site code, vendor, city, ZIP or phone…"
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
                    aria-label="Clear the site filter"
                  >
                    Clear
                  </button>
                ) : null}
              </div>
              <button
                type="button"
                className="btn btn--system btn--sm vsexport"
                onClick={() => exportSites(sorted, tab, query)}
                disabled={sorted.length === 0}
              >
                Download {num(sorted.length)} {sorted.length === 1 ? 'site' : 'sites'} (CSV)
              </button>
            </div>

            {/*
              ★ THE SEARCH IS SEARCHING THIS TAB, AND THE EMPTY STATE SAYS WHICH. A
                reader who searched for a vendor they know is deprecated, while the
                Active tab is showing, gets no rows — and that is not the same answer as
                "no such vendor". The hint names the other tab and the count on it.
            */}
            {missing ? (
              <div className="chkempty vcfilter__miss">
                <p>
                  The link asked for site <strong>{missing}</strong>, and this register has no site
                  with that id.
                </p>
                <p className="chkempty__hint">
                  The register holds the {num(data.counts.sites)} sites an in-scope order named — a
                  site that exists in <code>PO_VENDOR_SITES_ALL</code> and took no order from these
                  programs is not here. The list below is the whole register, unfiltered.
                </p>
              </div>
            ) : null}

            {/*
              ★ RENDERED UNCONDITIONALLY. The two states worth naming are a stored custom
                vendor name that could not be read — so the table is showing the ledger's
                name while an override exists — and nobody signed in, which leaves the
                pencils off the panel and makes the feature look absent rather than
                refused. A note gated on "is anything wrong" cannot report either.

                ★ THE NAMES HERE COME FROM THE VENDOR REGISTER'S OVERRIDES, NOT FROM
                SOMETHING THIS PAGE OWNS — and that is still only true of the names. This
                screen owns one field now, the site's email, which is a different subject
                (a property of a site rather than of the company) and therefore a
                different read with its own note rendered in the panel beside the field.
                Keeping them apart is what stops this note from claiming the emails below
                a register that does not carry them.
            */}
            <CustomNamesNote read={overrides} />

            {shown.length === 0 ? (
              <div className="chkempty">
                {inTab.length === 0 ? (
                  <>
                    <p>
                      No site on this register carries a {tab === 'deprecated' ? 'deprecation' : ''}{' '}
                      {tab === 'deprecated' ? 'signal' : 'clean record'}.
                    </p>
                    <p className="chkempty__hint">
                      That is a real possibility here rather than a bug: the predicate is applied to
                      the rows the endpoint returned, and a scope that names no such site would
                      produce exactly this table. The register holds {num(data.counts.sites)} sites
                      in all.
                    </p>
                  </>
                ) : (
                  <>
                    <p>
                      No {tab} site matches “{query}”.
                    </p>
                    <p className="chkempty__hint">
                      The filter searches the site code with and without its spaces, the vendor name
                      and id, the street address, city, state, ZIP and phone. It searches{' '}
                      <strong>this tab only</strong> —{' '}
                      {tab === 'active'
                        ? `the ${num(data.counts.deprecatedSites)} deprecated sites are on the other tab`
                        : `the ${num(data.counts.activeSites)} active sites are on the other tab`}
                      .
                    </p>
                  </>
                )}
              </div>
            ) : (
              <div className="table-wrap">
                <table className="data vstable">
                  <caption className="sr">
                    {tab === 'active' ? 'Active' : 'Deprecated'} vendor sites named by an in-scope
                    purchase order, {describeOrder(COLUMNS, sort)}.
                  </caption>
                  {/*
                    ★ VENDOR FIRST, SITE SECOND — the same order as `COLUMNS` and as the
                      `<td>`s below, and `c-vendor` is deliberately the one column with
                      no width. Under `table-layout: fixed` an unsized column takes what
                      is left, and the vendor column is the one that holds the names:
                      giving it a number here would take the leftover space from the
                      site column's chips instead. See the arithmetic in `vendors.css`.
                  */}
                  <colgroup>
                    <col className="c-vendor" />
                    <col className="c-site" />
                    <col className="c-count" />
                    <col className="c-paid" />
                    <col className="c-latest" />
                  </colgroup>
                  <SortableHead columns={COLUMNS} sort={sort} onSort={applySort} />
                  <tbody>
                    {shown.map((s) => (
                      <tr
                        key={s.vendorSiteId}
                        className={`vstable__row${
                          s.vendorSiteId === selected?.vendorSiteId && open ? ' is-open' : ''
                        }`}
                        onClick={() => openSite(s)}
                      >
                        <td>
                          {/*
                            ★ THE NAME IS THE ROW'S OPENER, AND IT IS THE ONLY THING IN
                              THE ROW IN THE TAB ORDER. The `<tr onClick>` above is a
                              mouse convenience; a row a keyboard cannot open is a row
                              that does not exist for a keyboard, so the opener lives on
                              the value the row is *named* by — which, now that the vendor
                              leads, is this one. It moved here from the site code, which
                              carried it while it was the first column.

                            ★ THE `aria-label` CARRIES THE SITE CODE TOO, AND THAT IS NOT
                              DECORATION. One vendor holds many sites (55 companies,
                              800 sites), so the visible name alone would give a screen
                              reader the same button hundreds of times over with nothing
                              to tell the rows apart. The label spells out what the second
                              column says, and it keeps the visible name as its first
                              words, which is what WCAG 2.5.3 asks for.

                            ★ THE VALUE AND THE MARK ONLY. The pencil, the trash and the
                              tooltip are in the panel head: this table sits in
                              `.table-wrap` (`overflow-x: auto`, which computes the
                              vertical axis to `auto` too, so a tooltip anchored to a cell
                              is clipped for the last rows) and `position: fixed` is
                              measured against the viewport inside a `transform`ed
                              ancestor. Nothing here is editable — the row opens the
                              panel, which is one click and has room to explain itself.

                            `display: block` on `.vs-link` is what puts the mark on the
                            line below the name rather than beside it.
                          */}
                          <EditableField
                            read={overrides}
                            subject="vendor"
                            field="name"
                            subjectKey={vendorKeyOf(s.vendorName)}
                            keyWritten={s.vendorName}
                            oracleValue={s.vendorName}
                            onChanged={reloadOverrides}
                            variant="register"
                          >
                            <button
                              type="button"
                              className="vs-link"
                              aria-label={`${s.displayName} — ${s.siteCode}`}
                              aria-expanded={s.vendorSiteId === selected?.vendorSiteId && open}
                              aria-controls="vendor-site-detail"
                              onClick={(e) => {
                                e.stopPropagation();
                                openSite(s);
                              }}
                            >
                              <span className="vs-vendor">{s.displayName}</span>
                            </button>
                          </EditableField>
                          <span className="vs-where">{cityLine(s) || '—'}</span>
                        </td>
                        <td>
                          {/*
                            ★ THE LEDGER'S OWN KEY, AND NO LONGER A CONTROL. The site code
                              opens nothing now: the name in the next cell along does. So
                              it is plain text and not a link-coloured button — colouring
                              words that do nothing on click invites a click that the row
                              would quietly answer instead. This is the same reasoning
                              `.vc-acct` records on the companies register.

                            ★ THE DEPRECATION MARKER STAYS WITH IT, BECAUSE THESE ARE THE
                              SERVER'S OWN STRINGS — `retired 2024-11-05`, `not a
                              purchasing site`, `the vendor is named DO NOT USE` — rendered
                              as written, so the marker cannot disagree with the tab the
                              row is on.
                          */}
                          <span className="vs-code">{s.siteCode}</span>
                          {s.deprecatedReasons.length > 0 ? (
                            <span className="vs-reasons">
                              {s.deprecatedReasons.map((r) => reasonChip(r))}
                            </span>
                          ) : null}
                        </td>
                        <td className="n">{num(s.orders)}</td>
                        <td className="n vc-num">
                          {money(s.amount)}
                          {/*
                            ★ A ZERO BESIDE REAL ORDERS IS A FACT ABOUT WHERE THE LINES
                              WERE BOOKED, NOT A MISSING VALUE — and the register-wide
                              count is under the stats above, so a reader meeting one row
                              here can see it is one of a known 26 rather than a gap.
                          */}
                          {s.amount === 0 && s.orders > 0 ? (
                            <span
                              className="vs-nomoney"
                              /*
                                ★ "EVERY … ORDER **WAS** CHARGED" RATHER THAN "ALL 5 … ORDERS
                                  WERE CHARGED". Agreement on "every" is singular at any count,
                                  so the sentence needs no plural branch — and that matters
                                  here because 11 of the 26 zero-money sites carry exactly one
                                  order and read "All 1 … orders were charged" before this.
                              */
                              title={`Every in-scope order on this site (${pluralise(
                                s.orders,
                                'order',
                              )} in all) was charged entirely outside the scope, so no in-scope line is left to total. The orders themselves are in the panel.`}
                            >
                              no in-scope money
                            </span>
                          ) : null}
                        </td>
                        <td className="vc-num">{s.latest || '—'}</td>
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

            {/*
              ★ THE FILTERED SUM IS PRINTED BESIDE THE TAB'S OWN, BECAUSE THEY ARE
                DIFFERENT NUMBERS AND BOTH ARE TRUE. Without this line a reader who
                filtered to twelve rows would add them up and find a figure that does not
                match the tab — and the mismatch would look like the register being wrong
                rather than the search having worked.
            */}
            <p className="chart-note vs-foot">
              {searched ? (
                <>
                  The {pluralise(matches.length, 'site')} matching <strong>“{query}”</strong>{' '}
                  {matches.length === 1 ? 'comes' : 'come'} to {money(filteredAmount)} across{' '}
                  {pluralise(filteredOrders, 'order')} — a subset of this tab, not the tab. The whole{' '}
                  {tab} list is {num(tabCount)} sites,{' '}
                  {pluralise(tabOrders, 'order')} and {money(tabAmount)}.
                </>
              ) : (
                <>
                  These {pluralise(tabCount, 'row')} are the whole {tab} list:{' '}
                  {pluralise(tabOrders, 'order')}, {money(tabAmount)} — the register&rsquo;s own
                  figures for this tab, not a sum of what happens to be on page {current}.
                </>
              )}{' '}
              A site&rsquo;s Committed figure is the sum of its orders&rsquo; <em>in-scope</em> lines,
              so {num(data.observed.ordersWithZeroAmount)} orders on{' '}
              {pluralise(data.observed.sitesWithZeroAmount, 'site')} come to nothing here because
              every line on them was charged outside the scope — including the{' '}
              {pluralise(data.counts.deprecatedSites, 'deprecated site')} above, whose money is real
              and counted. ★ THE ORDER-GRAIN TOTAL IS PRINTED BESIDE THE PER-SITE ONE BECAUSE THEY
              ARE SUMMED SEPARATELY, not because they disagree — the same line amounts added up per
              order instead of per site come to {money0(data.totals.orderRowAmountTotal)}, so they
              agree here and are not a check on each other.
            </p>
          </section>
        </>
      ) : null}

      {/*
        ★ THE PANEL WAITS FOR THE PAYLOAD, AND THAT IS NOT THE SAME AS WAITING FOR A
          SELECTION. `selected` and `open` are only ever set by the arrival effect or by a
          row click, and both of those need `data` — but the load effect sets `data` back
          to `null` on a Retry, and a dev Fast Refresh preserves those two state values
          while nulling `data`. In that window the panel rendered against a null payload
          and printed two FALSE statements: "Across the register 0 of the 0 sites carry no
          second address line…", and — worse — the Orders section's verdict, "The register
          carries no order row for this site, though its own row counts 5. That is a
          disagreement worth reporting rather than smoothing over." A sentence whose whole
          purpose is to flag a conflict with the register must not be printed by a race:
          an empty panel is honest, a conflict report about data that has not arrived is
          not. Every other data block on this page is gated on `data`; so is the panel.
      */}
      {data && selected ? (
        <SitePanel
          site={selected}
          orders={ordersBySite.get(selected.vendorSiteId) ?? []}
          open={open}
          onClose={closePanel}
          scopeText={scope ? `fund ${scope.fund}, programs ${scope.programs.join('/')}` : ''}
          observed={data.observed}
          dataSites={data.counts.sites}
          geo={data.geo}
          overrides={overrides}
          onOverridesChanged={reloadOverrides}
          siteOverrides={siteOverrides}
          onSiteOverridesChanged={reloadSiteOverrides}
        />
      ) : null}
    </div>
  );
}

/**
 * One site, in a panel that slides in from the right.
 *
 * It keeps the shared `.drawer` primitive's geometry and close button, and its own
 * body, because what goes in it — the address as the ledger holds it, the flags, the
 * orders that named the site, and the arithmetic that ties the row to them — exists
 * nowhere else on the page.
 */
function SitePanel({
  site,
  orders,
  open,
  onClose,
  scopeText,
  observed,
  dataSites,
  geo,
  overrides,
  onOverridesChanged,
  siteOverrides,
  onSiteOverridesChanged,
}: {
  site: SiteRow | null;
  orders: VendorSiteOrder[];
  open: boolean;
  onClose: () => void;
  /** The register's own scope, named in words, so the panel does not paraphrase it. */
  scopeText: string;
  /** The page's vendor-name read, handed down rather than read again here. */
  overrides: OverrideState;
  /** Called after a save or a delete so the page's labels and this panel agree. */
  onOverridesChanged: () => void;
  /**
   * The page's read of the OTHER subject — the site's email.
   *
   * ★ A SEPARATE PROP RATHER THAN A SECOND FIELD ON ONE OBJECT, because the two are
   *   separate reads with separate failure states and one of them can be broken while
   *   the other is fine. Merging them would make a failed email read look like a
   *   failed name read, and the note in the panel would have to guess which values it
   *   was speaking for.
   */
  siteOverrides: OverrideState;
  /** Called after the email is saved or cleared, so the panel re-reads it. */
  onSiteOverridesChanged: () => void;
  observed: VendorSiteRegister['observed'] | null;
  /**
   * The geocoding and road-distance block — the register's whole geo payload, not just
   * this site's row.
   *
   * ★ THE PANEL IS GIVEN THE WHOLE BLOCK BECAUSE MOST OF WHAT THE MAP SECTION SAYS IS
   *   ABOUT THE JOB RATHER THAN THE SITE. `counts` is what lets a site the geocoder never
   *   reached be told apart from one it reached and rejected; `available` and `note` are
   *   what let the panel report that the store did not answer rather than showing a pin at
   *   (0, 0). Passing one site's record alone would leave all three unanswerable.
   */
  geo: VendorSiteGeoBlock;
  /**
   * How many sites the register holds — the denominator for every "N of the …" in here.
   * ★ PASSED IN RATHER THAN READ OFF THE ROWS THE PANEL IS GIVEN. The panel holds one
   *   site; a register-wide share must come from the register, or "624 of the 800" turns
   *   into "624 of the 1" the moment this component is reused.
   */
  dataSites: number;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // The same three-state width contract as the other panels: null lets the
  // stylesheet own the width until the reader resizes it.
  const [width, setWidth] = useState<number | null>(() => readStoredWidth(WIDTH_KEY));
  const [resizing, setResizing] = useState(false);
  const [rendered, setRendered] = useState(0);

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
    if (open && site) closeRef.current?.focus();
  }, [open, site]);

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

  const style = width === null ? undefined : ({ '--drawer-w': `${width}px` } as CSSProperties);
  const listed = orders.slice(0, ORDER_CAP);
  const listedAmount = listed.reduce((n, o) => n + o.amount, 0);
  const gaps = site ? missingFields(site) : [];

  return (
    <aside
      ref={panelRef}
      id="vendor-site-detail"
      className={`drawer vspanel${open ? ' is-open' : ''}${resizing ? ' is-resizing' : ''}`}
      style={style}
      role="dialog"
      aria-modal="true"
      /* ★ THE NAME THE PANEL IS ANNOUNCED BY FOLLOWS THE ORDER OF THE HEAD, not the
         register's: the visible title is the vendor's name, so the accessible name
         leads with it. `VendorCompanies.tsx` names its own panel `displayName — …`
         the same way. The site code still appears, so nothing is lost to a reader
         who arrives by an id. */
      aria-label={site ? `${site.displayName} — ${site.siteCode}` : 'Site details'}
      aria-hidden={!open}
      tabIndex={-1}
    >
      <ResizeGrip
        value={width ?? rendered}
        onChange={setUserWidth}
        onReset={resetWidth}
        onDraggingChange={setResizing}
        controls="vendor-site-detail"
        label="Resize the site details panel"
      />

      <div className="drawer__head">
        <div className="drawer__eyebrow">
          Site · {site ? ident(site.vendorSiteId) : ''} · vendor {site ? ident(site.vendorId) : ''}
        </div>
        {/*
          ★ THE ONE CONTROL ON THIS PANEL SITS IN THE HEADING, AND THE HEADING IS THE
            FIELD THE CONTROL BELONGS TO. Two things could name this panel — the SITE
            CODE the register is searched by, and the VENDOR's name — and only one of
            them is a field a reader may give a value of their own. So the overridable
            one takes `.drawer__name` and the site code drops to the meta line under it,
            where nothing is editable and nothing competes with the title for the eye.
            `variant="heading"` is the same pencil, trash and tooltip the `meta` variant
            renders, at heading scale. `VendorCompanies.tsx` names its own panel head
            this way, so the two vendor panels read alike.
        */}
        <h2 className="drawer__name">
          {site ? (
            <EditableField
              read={overrides}
              subject="vendor"
              field="name"
              subjectKey={vendorKeyOf(site.vendorName)}
              keyWritten={site.vendorName}
              oracleValue={site.vendorName}
              onChanged={onOverridesChanged}
              variant="heading"
            />
          ) : null}
        </h2>
        <div className="drawer__meta">
          {site ? (
            <>
              {/*
                ★ THE SITE CODE IS THE LEDGER'S, WHICH IS WHY IT IS DOWN HERE AND NOT
                  IN THE HEADING. Every order row names it, the register is searched
                  and sorted by it, and no reader may change it — so it belongs where
                  the panel states facts about its subject. The money follows on a
                  line of its own.
              */}
              {site.siteCode}
              <br />
              <b>{money(site.amount)}</b> committed across {pluralise(site.orders, 'order')}
              {site.amount === 0 && site.orders > 0 ? ' — every line charged outside the scope' : ''}
            </>
          ) : null}
        </div>
        <button
          ref={closeRef}
          type="button"
          className="drawer__close"
          onClick={onClose}
          aria-label="Close the site details panel"
        >
          <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="drawer__body">
        {/*
          ★ THE PANEL RENDERS ITS OWN UNREAD NOTE, AND IT IS NOT THE REGISTER'S. The email
            read is a different subject and can fail while the register's read succeeded;
            this note is the only thing that separates "no email is recorded for this
            site" from "an email was recorded and is not being shown", and the field it is
            about is only ever visible in here. The register's note — rendered above the
            table — speaks for the vendor names and for nothing below this line.
        */}
        <CustomNamesNote read={siteOverrides} what="emails" />

        <section className="dsec">
          <div className="dsec__head">
            <h3 className="dsec__title">Address</h3>
            {/*
              ★ THE HINT IS SCOPED TO THE ADDRESS NOW THAT THE CARD HOLDS A ROW THE LEDGER
                DOES NOT. "as the ledger holds it" over a card containing an email this
                application stores is a false claim about that row — the sort of sentence
                that was merely vague until a precise neighbour made it wrong. Naming the
                exception keeps the claim true and tells a reader why the email row looks
                unlike the rest.
            */}
            <span className="dsec__hint">as the ledger holds it — email excepted</span>
          </div>

          {site ? (
            <div className="chkrows">
              {addressLines(site).map((line, i) => (
                <div className="chkrow" key={`${i}-${line}`}>
                  <span className="chkrow__k vs-break">{line}</span>
                </div>
              ))}
              <div className="chkrow">
                <span className="chkrow__k vc-num">{cityLine(site) || '—'}</span>
                <span className="chkrow__v vc-num">{site.zip || ''}</span>
              </div>
              <div className="chkrow">
                <span className="chkrow__k">Phone</span>
                <span className="chkrow__v vc-num">{phoneLine(site) || '—'}</span>
              </div>
              {/*
                ★ THE ONLY ROW IN THIS CARD THAT IS NOT THE LEDGER'S, AND IT IS BLANK
                  UNTIL SOMEBODY SETS IT. Oracle carries no email column for a vendor site,
                  so there is nothing underneath: the empty value is the whole of the
                  "no override" state rather than a ledger value standing in. That is what
                  the empty `oracleValue` says, and the registry entry's own
                  `fromLedger: false` is what makes the control word its tooltip, its two
                  aria-labels and its blank-draft hint for a field with nothing underneath.
                  It is NOT passed as a flag from here: a render site that had to remember
                  it would eventually forget, and the fact is the field's.

                ★ THE CONTROL GOES IN THE VALUE CELL — where the value would be — so the
                  row reads like the phone row above it. It is the one row in the card that
                  needs the wrapping and the narrower input the `.chkrow--cf` rules add.
              */}
              <div className="chkrow chkrow--cf">
                <span className="chkrow__k">Email</span>
                <span className="chkrow__v">
                  <EditableField
                    read={siteOverrides}
                    subject="vendor_site"
                    field="email"
                    subjectKey={String(site.vendorSiteId)}
                    keyWritten={String(site.vendorSiteId)}
                    oracleValue=""
                    onChanged={onSiteOverridesChanged}
                    variant="meta"
                  />
                </span>
              </div>
            </div>
          ) : null}

          {/*
            ★ THE GAPS ARE NAMED HERE RATHER THAN LEFT AS BLANK LINES. `ADDRESS_LINE2` is
              null on 624 of the 800 rows and `ADDRESS_LINE3` on 794, so a panel that just
              omitted them would look the same on a complete record and a two-line one.
              ★ AND THE REGISTER-WIDE FIGURES ARE PRINTED BESIDE THE ROW'S OWN, SO "THIS
              RECORD IS THIN" AND "THIS REGISTER IS THIN" ARE NOT CONFUSED. Both are on
              the payload's `observed` block, and the one for line two is not derived by
              adding this row back — a figure that is recomputed from the page's opinion of
              itself is not a measurement of the register.
          */}
          {gaps.length > 0 && site ? (
            <p className="vcnote">
              <strong>Not recorded on this row:</strong> {gaps.join(', ')}. Across the register{' '}
              {num(observed?.sitesWithoutAddressLine2 ?? 0)} of the{' '}
              {num(dataSites)} sites carry no second address line and{' '}
              {num(observed?.sitesWithoutAddressLine3 ?? 0)} no third,{' '}
              {num(observed?.sitesWithoutPhone ?? 0)} no phone and{' '}
              {num(observed?.sitesWithoutAreaCode ?? 0)} no area code, and{' '}
              {num(observed?.sitesWithoutState ?? 0)} no state at all —{' '}
              {num(observed?.sitesWithNonCodeState ?? 0)} of those reads <code>CANADA</code> where a
              two-letter code belongs. A blank line here is an unrecorded field, not a rendering
              fault.
            </p>
          ) : (
            <p className="vcnote">
              Every address field this register carries is present on this row. The register as a
              whole is sparser: {num(observed?.sitesWithoutAddressLine2 ?? 0)} of {num(dataSites)}{' '}
              sites have no second address line and {num(observed?.sitesWithoutAddressLine3 ?? 0)} no
              third, so a thin record elsewhere on this page is the common case rather than the
              exception.
            </p>
          )}
        </section>

        {/*
          The map sits between the address it is drawn from and the status it does not
          affect: the reader has just read the street the pin should land on, and the road
          distance above is a property of that pair rather than of the purchasing record.
          ★ THE SECTION RENDERS ITS OWN HEADING AND ITS OWN EMPTY STATES. There is no
            outer "is there geo data?" gate here, because the honest answers include "the
            store did not answer", "this site is a PO box" and "the geocoder has not
            reached it yet" — three different sentences about three different subjects, and
            a single gate would collapse them into one blank.
        */}
        {site ? <VendorSiteMap site={site} geo={geo} /> : null}

        <section className="dsec">
          <div className="dsec__head">
            <h3 className="dsec__title">Status</h3>
            <span className="dsec__hint">
              {site?.status === 'deprecated' ? 'deprecated' : 'active'}
            </span>
          </div>

          <div className="chkrows">
            <div className="chkrow">
              <span className="chkrow__k">Purchasing site</span>
              <span className="chkrow__v">
                {site?.purchasingSiteFlag === 'Y'
                  ? 'Yes'
                  : site?.purchasingSiteFlag === 'N'
                    ? 'No'
                    : '—'}
              </span>
            </div>
            <div className="chkrow">
              <span className="chkrow__k">Inactive date</span>
              <span className="chkrow__v vc-num">{site?.inactiveDate || '—'}</span>
            </div>
            <div className="chkrow">
              <span className="chkrow__k">First order</span>
              <span className="chkrow__v vc-num">{site?.first || '—'}</span>
            </div>
            <div className="chkrow">
              <span className="chkrow__k">Latest order</span>
              <span className="chkrow__v vc-num">{site?.latest || '—'}</span>
            </div>
          </div>

          {site && site.deprecatedReasons.length > 0 ? (
            <>
              <p className="vcnote">
                <strong>Why this site is on the Deprecated tab:</strong>
              </p>
              <div className="vs-reasons vs-reasons--panel">
                {site.deprecatedReasons.map((r) => reasonChip(r))}
              </div>
              <p className="vcnote">
                {site.deprecatedReasons.length === 1
                  ? 'One of the three signals fires on this row, and this is it.'
                  : `${num(
                      site.deprecatedReasons.length,
                    )} of the three signals fire on this row, so it is counted under each of them — which is why the three signals sum to more sites than the deprecated list holds.`}{' '}
                Nothing is asserted beyond what the row carries: this is a label the register places
                on a record, not a verdict on whether the site was used. The orders below are real,
                in-scope and counted.
              </p>
            </>
          ) : (
            <p className="vcnote">
              None of the three deprecation signals fires here — the site is a purchasing site, has
              no inactive date, and its vendor is not named <code>DO NOT USE</code>. The token{' '}
              <code>DO NOT USE</code> in a <em>site code</em> is a separate convention that matches no
              site code on this register at this scope, so it is not what puts a row on the other tab
              either way.
            </p>
          )}
        </section>

        <section className="dsec">
          <div className="dsec__head">
            <h3 className="dsec__title">Orders at this site</h3>
            <span className="dsec__hint">
              {orders.length > listed.length
                ? `newest ${num(listed.length)} of ${num(orders.length)}`
                : pluralise(orders.length, 'order')}
            </span>
          </div>

          {/*
            ★ THE ROW'S OWN COUNT AND THE LIST'S LENGTH ARE PRINTED TOGETHER, ON PURPOSE.
              `Orders` on the table row is the server's fold of the (site, order) pair set;
              this is the number of order rows the payload carries for the same site. They
              are computed from opposite directions and must agree — so they are shown side
              by side, where a reader meets both, rather than in two places that cannot be
              read at once.
          */}
          {site ? (
            <div className="chkrows">
              <div className="chkrow">
                <span className="chkrow__k">Orders, per the site row</span>
                <span className="chkrow__v vc-num">{num(site.orders)}</span>
              </div>
              <div className="chkrow">
                <span className="chkrow__k">Order rows listed here</span>
                <span className="chkrow__v vc-num">{num(site.ordersOnRecord)}</span>
              </div>
              {site.zeroOrders > 0 ? (
                <div className="chkrow">
                  <span className="chkrow__k">Of those, no in-scope line</span>
                  <span className="chkrow__v vc-num">{num(site.zeroOrders)}</span>
                </div>
              ) : null}
            </div>
          ) : null}

          {orders.length > 0 ? (
            <div className="vchk__list">
              <table className="vinvtable">
                <caption className="sr">In-scope purchase orders that named this site.</caption>
                <thead>
                  <tr>
                    <th scope="col">Order</th>
                    <th scope="col">Approved</th>
                    <th scope="col" className="n">
                      Lines
                    </th>
                    <th scope="col" className="n">
                      Committed
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {listed.map((o) => (
                    <tr key={`${o.orderNumber}-${o.approvedDate}`}>
                      <td className="vc-num">{o.orderNumber}</td>
                      <td className="vc-num">{o.approvedDate}</td>
                      <td className="n">{num(o.lineCount)}</td>
                      <td className={`n vc-num${o.amount === 0 ? ' vs-zero' : ''}`}>
                        {money(o.amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="vcnote">
              The register carries no order row for this site, though its own row counts{' '}
              {num(site?.orders ?? 0)}. That is a disagreement worth reporting rather than
              smoothing over — the two figures are folds of the same pair set.
            </p>
          )}

          {orders.length > listed.length ? (
            <p className="vcnote">
              Showing the newest {num(listed.length)} of {pluralise(orders.length, 'order')}. The CSV
              behind this page carries every site with its totals but not the individual orders —
              nothing here should be read as the site having {num(listed.length)} orders.
            </p>
          ) : null}

          {listed.length > 0 ? (
            <p className="vcnote">
              These {pluralise(listed.length, 'order')}{' '}
              {listed.length === 1 ? 'comes' : 'come'} to {money(listedAmount)} across{' '}
              {pluralise(
                listed.reduce((n, o) => n + o.lineCount, 0),
                'in-scope line',
              )}
              {orders.length > listed.length ? ', being the newest of them' : ''}. A site&rsquo;s
              Committed figure on the table is the sum of these orders&rsquo; in-scope lines, and an
              order showing {money(0)} was charged entirely outside {scopeText || 'the scope'} — it
              is on this list because the <em>order</em> is in scope, not every line on it.
            </p>
          ) : null}
        </section>

        <section className="dsec">
          <div className="dsec__head">
            <h3 className="dsec__title">The site code</h3>
            <span className="dsec__hint">as stored</span>
          </div>
          <div className="chkrows">
            <div className="chkrow chkrow--sum">
              <span className="chkrow__k vs-break">{site?.siteCode}</span>
            </div>
          </div>
          <p className="vcnote">
            Printed exactly as <code>VENDOR_SITE_CODE</code> holds it, spaces and all: the trailing
            fragment after the space is Oracle&rsquo;s site-purpose convention (<code>OP</code> and{' '}
            <code>OPE</code> for an ordering site, <code>OR</code>, <code>PY</code> for a pay site) and
            it is part of the code rather than padding — which is why the search box matches it both
            with the space and without. A site code is <em>not</em> an identity on this register:{' '}
            {num(observed?.sitesWithReusedCode ?? 0)} sites share a code with a site belonging to a
            different vendor, so the row key is the vendor site id in the eyebrow above.
          </p>
        </section>
      </div>
    </aside>
  );
}
