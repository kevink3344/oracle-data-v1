import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { loadFiscalYears, loadInvoices, type FiscalYear, type Invoice, type InvoiceAccount, type InvoiceCheck, type InvoicesExtract, type PoCoverage } from '../data/invoices';
import ErrorNotice from '../components/ErrorNotice';
import FilterCombo, { type ComboOption } from '../components/FilterCombo';
import PinButton from '../components/PinButton';
import { SqlNote } from '../components/SqlNote';
import ResizeGrip, { clampWidth, readStoredWidth, storeWidth } from '../components/ResizeGrip';
import { SortableHead } from '../components/SortHeader';
import { money, num, pluralise } from '../data/format';
import { SEGMENT_ORDER, SEGMENT_ROLE, accountTypeLabel } from '../data/taxonomy';
import { useStore } from '../state/store';
import { sameScope, scopeLabel, type Scope } from '../data/scope';
import { orderHref, ordersForAccountHref } from '../data/purchaseOrders';
import {
  CHRONO_ORDER,
  NEWEST_FIRST,
  describeOrder,
  sortRows,
  type SortColumn,
  type SortState,
} from '../data/sort';

/**
 * Invoices — one invoice per row, with the checks that paid it.
 *
 * The mirror of Checks, deliberately, down to the column order: that page is
 * `Check · Date · Amount · Invoices · Vendor`, this one is
 * `Invoice · Date · Amount · Checks · Vendor`. A reader who moves between the two
 * sees the same shape with the axes swapped, which is the whole point — the two
 * pages are the same relation read from either end.
 *
 * ── THE FOUR THINGS IT MUST NOT GET WRONG ────────────────────────────────────
 *
 * 1. **An invoice number is not an identity.** 3,068 numbers are drawn across
 *    3,736 invoices and 78 of the 79 repeats span more than one vendor, so
 *    `30JUN-2026SES` names 142 different documents. Rows are keyed on
 *    `INVOICE_ID`; the table prints the number because that is what a reader
 *    holds, and the vendor sits next to it because that is what disambiguates it.
 *
 * 2. **The status flag is not the payment.** `PAYMENT_STATUS_FLAG` never says
 *    `Y` without a check behind it (0 rows), but it says `N` about 14 invoices
 *    that a check did settle. So the Checks column is driven by the LINKS — the
 *    evidence — and the panel prints the flag beside it rather than instead of
 *    it. A page that rendered the flag as status would be wrong on 14 rows.
 *
 * 3. **"No check" is not "no money".** 151 invoices have no check at all, and
 *    `AMOUNT_PAID` is NULL on 29 — which is not `0`. Both are shown as what they
 *    are: a count, and the words "not recorded".
 *
 * 4. **The link has no amount.** `WCSEXP_AP_INVOICE_PAYMENTS` has four columns
 *    and none is money, so when two checks paid one invoice the split between
 *    them is not in the database. The panel prints each check's own amount and
 *    says so; it never divides, apportions or infers.
 *
 * ── AND WHERE IT IS BOOKED (added 2026-09-19) ────────────────────────────────
 *
 * The register carries no GL account — the account is on the invoice's
 * **distributions** — so the extract grew a third result set and the page grew an
 * Account column and an Account filter. Two things about it drive the layout:
 *
 * 5. **The account is a LIST, not a column.** 53 of the 126 invoices in scope
 *    are booked to more than one account and the worst is booked to 7. The table
 *    therefore shows the largest and says how many follow it; the panel shows all
 *    of them. A single code in a single cell would be a correct-looking lie on
 *    two fifths of the table.
 *
 * 6. **★ The register is SCOPED, and this page must never read as if it were the
 *    whole ledger.** This is the **Fund `04`, program `861`/`862`/`863`** slice
 *    of the fiscal year: **126 of its 3,736 invoices, and $5,650,333 of its
 *    $99,868,027.** Saying "126 invoices" without the 3,736 is the most
 *    misleading thing this page could print, so the denominator is stated in the
 *    page head, on the Invoices stat, and again in full at the foot of the table —
 *    with the two kinds of removal told apart, because they are not the same
 *    fact:
 *
 *      excluded      3,584 invoices ($94,189,129). Distributions exist and none
 *                    is in scope. A real exclusion, and the scope's doing.
 *      unanswerable  26 invoices ($28,565). **No distribution at all**, so there
 *                    is no fund and no program to test. The register cannot say
 *                    whether they belong — and `IN-048722` ($23,356.76) and
 *                    `S2998931.001` ($5,208.50), the only two real-money invoices
 *                    in the whole window, are both in this bucket. Calling them
 *                    "excluded by the scope" would invent a rule that removed
 *                    them and would bury their money.
 *
 *    They are therefore **dropped from the table and counted rather than
 *    silently absent**, and the note says how many and how much. Nothing here
 *    hardcodes `04` or `861-863`: the rule is read off the extract's own envelope,
 *    so a re-run under a different scope cannot leave the copy describing the
 *    previous one.
 *
 * 7. **★ The scope narrows which invoices, never which accounts.** Two kept
 *    invoices also draw an account outside it (2 rows, $243.15). Those rows stay
 *    in the panel, marked rather than hidden — filtering them would stop the
 *    accounts summing to the invoice and make the reconciliation note below report
 *    a fault that does not exist.
 *
 * 8. **"No account" is not "an account of zero".** The old unscoped window had
 *    26 invoices with no distribution anywhere, 24 of them $0.00 and two carrying
 *    real money. The scope now removes that state entirely — an invoice with no
 *    distribution has no fund to test — so the third state is unreachable from
 *    the current extract and is kept only so that a stale file cannot render a
 *    blank Account cell that reads like a missing value.
 *
 * The free-text box matches the account **as text**, which is what lets a reader
 * search a segment (`1110`, `0840`) that no whole-combination filter can express.
 * The Account filter is the exact-match control and is a different question: the
 * whole combination, or the specific state of having none.
 */

const WIDTH_KEY = 'invoices-panel-w';

/** Rows per page. The window is ~3,700 invoices, so the table is always paged. */
const PER_PAGE = 50;

/** The panel's focus trap reads the same set the other three drawers use. */
const FOCUSABLE =
  'a[href], button:not([disabled]), summary, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * The six columns, in the order they are shown.
 *
 * One list drives the headings, their alignment and the sort, so a column cannot
 * appear in the table without a heading or gain a heading with no order behind
 * it. `value` is what the column is *ordered by* and not what the cell says — the
 * amount cell renders `$1,020.00` and the amount column orders on 1020, because a
 * `$` sorts before every digit and a comma falls between them.
 *
 * ★ **The Account column sorts on one code out of a list.** 53 of the 126
 *   invoices in scope carry more than one account and the worst carries seven, so
 *   `accounts[0].code` is the LARGEST account an invoice was booked to and not
 *   "the" account, because there is no such thing. The array is ordered by amount
 *   at load (`data/invoices.ts`), which is what makes the first entry the largest.
 *   Sorting on it answers a real question — which invoices did the biggest part
 *   of this money land on — but it is not the same question as "sort by account",
 *   and the heading has no room to say which of the two it is. The panel is where
 *   all of an invoice's accounts are visible.
 *
 * ★ **An invoice with no account has no code, and sorts last either way.** The
 *   three states a row can be in — one account, several, none — all need a
 *   position, and `sort.ts` puts the absent one after the present ones in both
 *   directions rather than treating "none" as a low code. The dash the cell
 *   renders and last-in-the-column are then the same statement. `accounts` is
 *   empty rather than holding a placeholder, so `[0]` is `undefined` and the
 *   nullish operator is what turns that into "absent" instead of a crash.
 */
const COLUMNS: SortColumn<Invoice>[] = [
  { key: 'invoice', label: 'Invoice', value: (i) => i.number },
  { key: 'date', label: 'Date', value: (i) => i.date, order: CHRONO_ORDER },
  { key: 'amount', label: 'Amount', numeric: true, value: (i) => i.amount },
  { key: 'checks', label: 'Checks', numeric: true, value: (i) => i.checks.length },
  { key: 'vendor', label: 'Vendor', value: (i) => i.vendor },
  { key: 'account', label: 'Account', value: (i) => i.accounts[0]?.code ?? null },
];

const termsOf = (q: string): string[] =>
  q
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

/**
 * Everything one invoice can be found by, flattened once at load.
 *
 * The check numbers are in here for the same reason the invoice numbers are in
 * the checks page's haystack: a reader holding a check knows its number long
 * before they know which invoices it settled. The vendor is in here because the
 * number is not unique — searching `30JUN-2026SES` alone returns 142 rows, and
 * the vendor is the only term that narrows it to one.
 *
 * The account codes are in here as TEXT, which is deliberate and is not the same
 * question the Account filter asks. Every invoice whose key contains `1110`
 * matches here, so a reader can search one segment of the account — something a
 * whole-combination filter cannot express. The filter is the exact match; this is
 * the substring search.
 */
function haystack(i: Invoice): string {
  return [
    i.number,
    i.vendor,
    i.date,
    i.amount.toFixed(2),
    i.description,
    ...i.checks.map((c) => `${c.number} ${c.date}`),
    ...i.accounts.map((a) => a.code),
  ]
    .join(' ')
    .toLowerCase();
}

/**
 * The held-back value for "this invoice has no account at all".
 *
 * A string, not `null` and not `0`: the filter's three states have to be told
 * apart, and `''` is already the "no filter" state a select starts in. It cannot
 * collide with a real combination because every combination is digits and
 * hyphens.
 */
const NO_ACCOUNT = 'none';

/**
 * Where a check on the panel goes.
 *
 * `CHECK_ID` and not the number, and the asymmetry with the other direction is
 * the point: the check is the PARENT of the relation — a check pays many
 * invoices, so `checks.json` keys its link table on `CHECK_ID` — while
 * `invoices.json`'s link rows carry a `CHECK_ID` too, which is why this
 * direction needs no narrowing at all. All 117 links pointing at an invoice in
 * this register resolve to a check that is in the window, so a click here opens
 * exactly one check, always.
 */
function checkHref(c: InvoiceCheck): string {
  return `/spend/payments?check=${c.id}`;
}

/**
 * What happened when a check's invoice link arrived, when it is anything other
 * than "it landed on one invoice".
 *
 * The three states are not decoration. A link that resolves to one row needs no
 * explanation — the reader is looking at the invoice. The other three all look
 * identical from the table: either nothing was filtered, or several rows share
 * the number. Each says which it is.
 */
type Arrival =
  /** No invoice in this register carries that number. The usual case by far. */
  | { kind: 'missed'; number: string }
  /** Several do, and the vendor/date/amount could not tell them apart. */
  | { kind: 'several'; number: string; count: number };

/** One option in the Account filter: a combination, and how many invoices carry it. */
interface AccountOption {
  code: string;
  invoices: number;
  value: number;
  /**
   * Whether this combination is inside the register's scope.
   *
   * A property of the COMBINATION and not of any one invoice: fund and program
   * are segments of the key itself, so every row carrying this code agrees. Two
   * combinations reached through kept invoices are outside it, and they stay in
   * the list — a reader who spots one on a panel must be able to filter to it.
   */
  inScope: boolean;
}

/** A page list with gaps, so 75 pages does not become 75 buttons. */
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

/**
 * One CSV cell, quoted only when it has to be.
 *
 * Takes `string | number` because the export interleaves both: the money columns
 * are already formatted to two decimals by `money()`, while the segment and line
 * counts arrive as raw numbers and must not go through a locale formatter — a
 * thousands separator in a CSV field turns one value into two columns.
 */
const csvCell = (v: string | number): string => {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * A filename that will survive being an invoice number.
 *
 * The checks page can use `check.number` raw because a check number is digits.
 * An invoice number is free text — `USE TAX/01JUN2618:07/F02/7.25` is a real one
 * in this window — and a `/` in a download name is a directory separator, so
 * passing it through would either fail or silently drop the rest of the name.
 * Everything outside `[A-Za-z0-9._-]` collapses to a single dash.
 */
function safeName(raw: string, fallback: number): string {
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned || `id-${fallback}`;
}

/**
 * The invoice, the accounts it is booked to, and the checks that settled it, as
 * a file.
 *
 * `amount_paid` is left EMPTY when it is NULL, never `0.00` — the two states are
 * different and a CSV that flattened them would lose the distinction at the one
 * point where it leaves the screen.
 *
 * ★ The file is a CROSS PRODUCT of the two relations, not a merge, and that is
 *   deliberate: an invoice booked to three accounts and settled by two checks has
 *   six rows, because each account amount belongs to each check. Merging them
 *   into one line per invoice would have to invent an allocation — the
 *   distributions do not say which check paid which account. Summing any money
 *   column in this file therefore multiplies it, and the last row says so.
 */
function exportChecks(invoice: Invoice) {
  const header = [
    'invoice_number',
    'invoice_date',
    'invoice_amount',
    'vendor',
    'amount_paid',
    'invoice_status_flag',
    'description',
    'account_code',
    'account_type',
    'account_amount',
    'account_dist_rows',
    'segment1_fund',
    'segment2_purpose',
    'segment3_program',
    'segment4_object',
    'segment5_level',
    'segment6_cost_center',
    'segment7_future_use',
    'check_number',
    'check_date',
    'check_amount',
    'note',
  ];
  const base: (string | number)[] = [
    invoice.number,
    invoice.date,
    invoice.amount.toFixed(2),
    invoice.vendor,
    invoice.paid === null ? '' : invoice.paid.toFixed(2),
    invoice.accounted ? 'Y' : 'N',
    invoice.description,
  ];
  // An absent side still exports, as one blank row per relation, so the file
  // always describes the invoice the button was pressed on. 26 invoices in this
  // window have no distribution and some have no check; collapsing both sides
  // into a single blank row would have made "no account" and "no check" look the
  // same, which is the one thing the two columns exist to keep apart.
  const accountRows: (string | number)[][] = invoice.accounts.length
    ? invoice.accounts.map((a) => [
        a.code,
        accountTypeLabel(a.type),
        a.amount.toFixed(2),
        a.lines,
        ...[0, 1, 2, 3, 4, 5, 6].map((i) => a.segments[i] ?? ''),
      ])
    : [['', '', '', '', '', '', '', '', '', '', '']];
  const checkRows: (string | number)[][] = invoice.checks.length
    ? invoice.checks.map((c) => [c.number, c.date, c.amount.toFixed(2)])
    : [['', '', '']];
  const rows = accountRows.flatMap((a) =>
    checkRows.map((c) => [
      ...base,
      ...a,
      ...c,
      `${invoice.accounts.length} account(s) x ${invoice.checks.length} check(s)` +
        (invoice.accounts.length === 0 ? ' — no distribution, so no account can be named' : '') +
        (invoice.checks.length === 0 ? ' — no check settles this invoice' : '') +
        '; account_amount repeats across checks',
    ]),
  );
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `invoice-${safeName(invoice.number, invoice.id)}-accounts-checks.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Whole days between two `YYYY-MM-DD` dates, UTC so no timezone can shift it. */
const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export default function Invoices() {
  /**
   * ★ THE LIVE SCOPE, WHICH THIS PAGE MUST NOT CONFUSE WITH ITS OWN.
   *
   * Every other register in the app is filtered by the store's `lines`, so the control in the TopBar
   * *is* the filter and the two cannot disagree. This page is the exception: its rule was applied in
   * the extract SQL (`server/scripts/pull-invoices-extract.mjs`), and the JSON it renders carries its
   * own `.scope` block recording what was applied when it was written. Two authorities on one
   * question.
   *
   * The envelope is the authority on what the file contains, and nothing here may contradict it — the
   * rows are what they are. But the envelope cannot follow the reader, so if the scope above the
   * search box has moved, the page has to say so. Otherwise a reader who selects program 861 sees a
   * register still headed 861/862/863 with no explanation, which is the app asserting something it
   * has no way to know.
   */
  const { scope: liveScope, scopeTenant, projects } = useStore();
  const [data, setData] = useState<InvoicesExtract | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  /**
   * The fiscal years the ledger carries, and the range the reader has chosen.
   *
   * ★★ THIS IS THE FIX FOR "THE HIDDEN INVOICE", AND IT IS A DISCLOSURE PROBLEM RATHER THAN A
   *    FILTER PROBLEM. The register was always bounded to one fiscal year and the page never said
   *    so, so a reader who filtered to Athens Drive saw "1 of 126" and reported a bug — because
   *    that project's level `0450` has **52 in-scope invoices** and exactly **1** of them falls in
   *    the newest year. The other 51 run back to 2024-05-31.
   *
   * ★ `null` MEANS "THE SERVER'S DEFAULT", NOT "NO FILTER". Sending no params lets the server pick
   *   the newest year it carries, so a ledger that gains a year moves the default with it. A
   *   hard-coded newest year in the client would freeze it.
   */
  const [years, setYears] = useState<FiscalYear[]>([]);
  const [fyRange, setFyRange] = useState<{ start: number; end: number } | null>(null);

  const [query, setQueryRaw] = useState('');
  const [account, setAccountRaw] = useState('');
  const [project, setProjectRaw] = useState('');
  const [page, setPage] = useState(1);

  // The order the table is in. Always a real column rather than a "no sort"
  // state: the register is always in some order, and the one it opens in is Date
  // descending — the order the file is written in. See `data/sort.ts`.
  const [sort, setSort] = useState<SortState>(NEWEST_FIRST);

  /**
   * The sort, said out loud, and this is not belt-and-braces.
   *
   * The heading's button is labelled with the NEXT action, so the moment it is
   * pressed its label describes the opposite of what just happened, and
   * `aria-sort` lives on the cell — which is not announced while the focus is on
   * the button inside it. Without this, the only feedback a screen reader gets
   * from sorting is a button that looks like it has relabelled itself. It is held
   * in state rather than derived from `sort` so that typing in the search box
   * does not re-announce the order on every keystroke.
   */
  const [sortNote, setSortNote] = useState('');

  // Content and visibility are separate: the selected invoice is kept while the
  // panel slides out, so it reads as a panel closing rather than emptying first.
  const [selected, setSelected] = useState<Invoice | null>(null);
  const [open, setOpen] = useState(false);

  /**
   * ★ HOW A CHECK FINDS ITS INVOICE HERE — AND WHAT HAPPENS WHEN IT CANNOT.
   *
   * The checks screen links every invoice a check paid to this page, carrying
   * the four things the link row knows: the number, the vendor the check paid,
   * the date and the amount. It has to carry all four, because `checks.json`
   * holds no `INVOICE_ID` — the link table is keyed on the CHECK — so the number
   * is the only join key the two extracts share, and the number on its own is
   * not an identity here either: `PAYAPP4` names four invoices in this register.
   * The narrowing order below is vendor, then date, then amount, measured to
   * land on exactly one row for 136 of the 141 links whose number is in scope.
   *
   * ★ THE USUAL OUTCOME IS A MISS, and the page has to own it. This register is
   *   scoped and holds 126 invoices; the checks window is the whole fiscal year
   *   and carries 9,451 links, of which 9,310 name an invoice that is not here.
   *   So the common case is "this invoice is not in the register" — said in
   *   words, naming the number — rather than a page that opens unfiltered and
   *   looks as though the click did nothing.
   *
   * `vendor` is the check's payee, not necessarily the invoice's vendor: a check
   * can settle invoices from more than one vendor, and when it does this key
   * cannot tell them apart. That is what the ambiguous case says out loud.
   */
  const [params] = useSearchParams();
  const wantedNumber = (params.get('invoice') ?? '').trim();
  const wantedVendor = (params.get('vendor') ?? '').trim();
  const wantedDate = (params.get('date') ?? '').trim();
  const wantedAmount = params.get('amount');
  const [arrival, setArrival] = useState<Arrival | null>(null);

  // The year list, once. A failure here is survivable and silent: the picker renders without it
  // and the register still loads on the server's default, which is the state the page was in
  // before this control existed. A missing year list must not block the register.
  useEffect(() => {
    const controller = new AbortController();
    loadFiscalYears(controller.signal)
      .then(setYears)
      .catch(() => {
        if (!controller.signal.aborted) setYears([]);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    loadInvoices(controller.signal, fyRange ?? undefined)
      .then(setData)
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => controller.abort();
  }, [attempt, fyRange]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  // One flattened haystack per invoice, built once, not once per keystroke.
  const index = useMemo(
    () => (data ? data.invoices.map((invoice) => ({ invoice, hay: haystack(invoice) })) : []),
    [data],
  );

  const terms = useMemo(() => termsOf(query), [query]);

  /**
   * Every combination the register draws, busiest first.
   *
   * The order is the whole reason this is a usable control: a list of combinations
   * is exactly the list nobody reads, but a reader who came *from* an account
   * knows its code and can jump to it by typing, and a reader who did not is best
   * served by the combinations that actually carry money sitting at the top. Ties
   * break on the code so the order is stable between renders.
   */
  const accountOptions = useMemo<AccountOption[]>(() => {
    if (!data) return [];
    const map = new Map<string, AccountOption>();
    for (const inv of data.invoices) {
      // One invoice counts once per combination even if it drew it twice; the ids
      // are the extract's own grouping key, so they cannot in fact repeat.
      const seen = new Set<string>();
      for (const a of inv.accounts) {
        if (seen.has(a.code)) continue;
        seen.add(a.code);
        const hit = map.get(a.code);
        if (hit) {
          hit.invoices += 1;
          hit.value += a.amount;
        } else {
          map.set(a.code, { code: a.code, invoices: 1, value: a.amount, inScope: a.inScope });
        }
      }
    }
    return [...map.values()].sort(
      (a, b) => b.invoices - a.invoices || a.code.localeCompare(b.code),
    );
  }, [data]);

  /**
   * The Project filter's options — **only projects that have invoices here.**
   *
   * ★ WHY THIS IS NOT JUST `projects` FROM THE STORE. The store's list is every
   *   level the *purchase-order* extract carries, which is 139 levels. This
   *   register holds 126 invoices, and only some of their accounts land on a
   *   level a project is named after. Offering all 139 would put ~120 options in
   *   the list that provably cannot match a row — a list plus an argument, which
   *   is the failure mode `LevelPicker` already refuses for held levels.
   *
   * ★ THE JOIN IS THE LEVEL SEGMENT, AND THAT IS THE ONLY LINK THERE IS. An
   *   invoice carries GL accounts and nothing else; a project is bound to
   *   `SEGMENT5` of the accounts it owns (`SEGMENT_ROLE.LEVEL_` — "the level,
   *   the thing a project is named after"). So an invoice matches a project when
   *   any of its accounts carries that project's level. There is no project
   *   column on the invoice to read instead.
   *
   * ★ A LEVEL WITH NO REGISTRY ROW IS NOT OFFERED, per the reader's decision.
   *   Ten of the levels here have names; the rest are unclaimed, and an option
   *   labelled `0453` with no name is a code, not a project. The count of
   *   invoices is what makes the option useful — it is the number the reader is
   *   about to filter to.
   */
  const projectOptions = useMemo<ComboOption[]>(() => {
    if (!data) return [];
    // Level → how many invoices carry it, counted once per invoice.
    const byLevel = new Map<string, number>();
    for (const inv of data.invoices) {
      const levels = new Set<string>();
      for (const a of inv.accounts) {
        const level = a.segments[4];
        if (level) levels.add(level);
      }
      for (const level of levels) byLevel.set(level, (byLevel.get(level) ?? 0) + 1);
    }
    const out: ComboOption[] = [];
    for (const p of projects) {
      const invoices = byLevel.get(p.level);
      // No invoices on this project's level means the option could never match.
      if (invoices === undefined) continue;
      out.push({
        value: p.level,
        label: p.name,
        detail: `${p.code} · ${num(invoices)}`,
        // The level is searchable as well as the name, because a reader arriving
        // from a report has the four digits and not the school's name.
        keywords: `${p.level} ${p.code}`,
        count: invoices,
      });
    }
    return out.sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.label.localeCompare(b.label));
  }, [data, projects]);

  const matches = useMemo(() => {
    const byTerm = terms.length === 0 ? index : index.filter((r) => terms.every((t) => r.hay.includes(t)));
    let rows = byTerm;
    if (account) {
      rows =
        account === NO_ACCOUNT
          ? rows.filter((r) => r.invoice.accounts.length === 0)
          : rows.filter((r) => r.invoice.accounts.some((a) => a.code === account));
    }
    if (project) {
      rows = rows.filter((r) => r.invoice.accounts.some((a) => a.segments[4] === project));
    }
    return rows;
  }, [index, terms, account, project]);

  const setQuery = (next: string) => {
    setQueryRaw(next);
    setPage(1);
  };

  const setAccount = (next: string) => {
    setAccountRaw(next);
    setPage(1);
  };

  const setProject = (next: string) => {
    setProjectRaw(next);
    setPage(1);
  };

  const clear = () => {
    setQueryRaw('');
    setAccountRaw('');
    setProjectRaw('');
    setPage(1);
  };

  const totalPages = Math.max(1, Math.ceil(matches.length / PER_PAGE));
  // Clamped rather than reset: a filter that shrinks the list while the reader is
  // on page 40 should land them on the last page, not on an empty one.
  const current = Math.min(page, totalPages);

  // ★ Sorted from `matches`, never from the previous sort's result: `sortRows`
  // reads the tie order off the array it is given, so a sort applied to an
  // already-sorted array would break ties by the previous column and a row could
  // move between pages for no reason the reader can see. `matches` is in the
  // register's own order on every render, which is what makes ties stable — and
  // what makes sorting by date descending return the page's opening order
  // exactly, since that IS the register's own order.
  const sorted = useMemo(
    () => sortRows(matches.map((r) => r.invoice), COLUMNS, sort),
    [matches, sort],
  );
  const shown = sorted.slice((current - 1) * PER_PAGE, current * PER_PAGE);

  /** What a click on a heading means, for the sort, the page and the announcement. */
  const applySort = (next: SortState) => {
    setSort(next);
    // Back to the first page. A filter clamps the page instead, deliberately — it
    // narrows the list without reordering it, so page 40 is still the
    // neighbourhood the reader was in. Sorting moves every row they were looking
    // at somewhere else, and they clicked something at the top of the table.
    setPage(1);
    // Sorting does not change how many rows match, so this count is the same
    // before and after and is safe to read from the state being replaced.
    setSortNote(`${pluralise(sorted.length, 'invoice')}, ${describeOrder(COLUMNS, next)}.`);
  };

  // The words for the order the table is in, used by the sentence above it and by
  // its caption, so neither can describe an order the table is not in.
  const order = describeOrder(COLUMNS, sort);

  const totals = useMemo(() => {
    // Empty as well as absent: the two `reduce` seeds below are `invoices[0]`,
    // and on an empty list that is `undefined` rather than a row.
    if (!data || data.invoices.length === 0) return null;
    const value = data.invoices.reduce((s, i) => s + i.amount, 0);
    const multi = data.invoices.filter((i) => i.checks.length > 1).length;
    const biggest = data.invoices.reduce((m, i) => (i.amount > m.amount ? i : m), data.invoices[0]);
    const widest = data.invoices.reduce((m, i) => (i.checks.length > m.checks.length ? i : m), data.invoices[0]);
    return { value, multi, biggest, widest };
  }, [data]);

  const openInvoice = useCallback((i: Invoice) => {
    setSelected(i);
    setOpen(true);
  }, []);

  // Filtering to a code from inside the panel also closes it: the panel is modal
  // and the answer is the table behind it, so leaving the drawer standing would
  // make the click look like it did nothing.
  const openAccount = useCallback((code: string) => {
    setAccountRaw(code);
    setProjectRaw('');
    setQueryRaw('');
    setPage(1);
    setOpen(false);
  }, []);

  /**
   * Resolve the arrival from the checks screen, once, after the extract is in.
   *
   * One-shot, keyed on the whole query, and deliberately so: the panel's Close
   * must not be undone by an effect that re-reads the params on the next render.
   * The key includes vendor, date and amount, so two links to the same invoice
   * number from two different checks are still two arrivals.
   *
   * The narrowing is in four steps and each one is a fact about these extracts:
   *
   *   1. exact number, case-insensitively trimmed — the only key the two share;
   *   2. the check's vendor, which is the payee it printed. It is what separates
   *      four `PAYAPP4`s, and it is why a link carrying the number alone would
   *      open the wrong invoice and look certain while doing it;
   *   3. the date the link recorded;
   *   4. the amount, to the same half-cent tolerance the reconciliation uses.
   *
   * A step that matches nothing is skipped rather than treated as a failure: the
   * extracts disagree about some dates and amounts for invoices that are the same
   * document, and refusing to open one because its copy of the amount is older
   * would be the wrong call. Whatever survives, one row is opened and the filter
   * is set to the number, so the reader can see the register's own figures beside
   * the check's.
   */
  const arrived = useRef<string | null>(null);
  useEffect(() => {
    if (!data || !wantedNumber) return;
    const key = `${wantedNumber}|${wantedVendor}|${wantedDate}|${wantedAmount ?? ''}`;
    if (arrived.current === key) return;
    arrived.current = key;

    const number = wantedNumber.toLowerCase();
    const same = data.invoices.filter((i) => i.number.trim().toLowerCase() === number);

    if (same.length === 0) {
      setArrival({ kind: 'missed', number: wantedNumber });
      return;
    }

    const narrow = (rows: Invoice[], pred: (i: Invoice) => boolean): Invoice[] => {
      const kept = rows.filter(pred);
      return kept.length > 0 ? kept : rows;
    };
    const amount = wantedAmount === null || wantedAmount.trim() === '' ? null : Number(wantedAmount);
    let found = same;
    if (found.length > 1 && wantedVendor) {
      found = narrow(found, (i) => i.vendor.trim() === wantedVendor);
    }
    if (found.length > 1 && wantedDate) {
      found = narrow(found, (i) => i.date === wantedDate);
    }
    if (found.length > 1 && amount !== null && Number.isFinite(amount)) {
      found = narrow(found, (i) => Math.abs(i.amount - amount) < 0.005);
    }

    // Filter the register to the number as well as opening the invoice: the panel
    // is modal and the table behind it is what the reader compares it against,
    // and a panel describing a row that is on page 3 is a reader wondering which
    // invoice they are looking at.
    setQueryRaw(wantedNumber);
    setAccountRaw('');
    setProjectRaw('');
    setPage(1);
    setArrival(found.length > 1 ? { kind: 'several', number: wantedNumber, count: found.length } : null);
    openInvoice(found[0]);
  }, [data, wantedNumber, wantedVendor, wantedDate, wantedAmount, openInvoice]);

  /**
   * The arrival note is about the filter the arrival set, so it goes when that
   * filter does — otherwise a reader who clears the search is still being told
   * about a link they have moved on from. A miss set no filter, so any search at
   * all is the reader moving on.
   */
  useEffect(() => {
    if (!arrival) return;
    const mine = arrival.kind === 'missed' ? '' : arrival.number;
    if (query !== mine) setArrival(null);
  }, [arrival, query]);

  // The fiscal year's whole value, reconstructed from the three buckets the
  // extract publishes. Computed rather than carried as a fourth field, because
  // three parts that must add up to a total are a better check on each other than
  // a fourth number that can quietly disagree with all of them. The scope label
  // is `''` when no scope was applied, which is what gates every sentence below.
  const scope = data?.scope;
  /**
   * The file's scope as a `Scope`, for comparison against the live one.
   *
   * A file with no scope block produces `null` and no reconciliation: "nothing was applied" is not a
   * disagreement with the selection, it is a missing fact, and inventing `04`/`861-863` for it would
   * be exactly the hardcoding this whole change set exists to remove.
   */
  const fileScope: Scope | null =
    scope?.applied && (scope.fund || scope.programs.length)
      ? { fund: scope.fund, programs: scope.programs }
      : null;
  const scopeMoved = fileScope ? !sameScope(fileScope, liveScope) : false;

  return (
    <div className="stack">
      <div>
        <div className="accent-rule" />
        <div className="page-head">
          <div>
            <h1>Invoices</h1>
          </div>
        </div>
      </div>

      {error ? (
        <ErrorNotice
          error={error}
          reload={reload}
          heading="The invoice extract could not be read."          hint={
            <>
              <p>
                The app fetches <code>oracle/invoices.json</code> from the dev server. Run{' '}
                <code>npm run sync:extract</code> to copy it out of <code>data/oracle/</code>.
              </p>
              <p className="invstat__n">
                That file is generated from Oracle, not transcribed —{' '}
                <code>node server/scripts/pull-invoices-extract.mjs</code> rebuilds it for the
                current fiscal year.
              </p>
            </>
          }
        />
      ) : null}

      {/*
        ★ THE STAT CARDS AND THE SCOPE DISCLOSURE ARE GONE, ON STAFF'S INSTRUCTION.

          The six cards read: invoices, value, credit notes, GL accounts, no-check-at-all and the
          largest single invoice — all totals or extremes over the table below.

          The paragraph that followed them was the most load-bearing sentence on the page: it named
          the denominator (126 of 3,743 invoices in the fiscal year), the money, and — separately —
          the 26 invoices with no distribution at all, which the register cannot judge. Its own
          comment said it existed "purely to stop a reader drawing the wrong conclusion from a small
          number". That protection is knowingly given up here; the SQL trace below prints the
          statement, and therefore the scope predicate, for a reader who wants to check.
      */}
      <SqlNote trace={data?.traces ?? null} label="the invoice register, as the ledger received it" />

      {/* ★ What the register is a slice OF, and what the slice cost — REMOVED with the stat cards
          above, on staff's instruction. It named the denominator, the money and the invoices the
          scope could not judge at all. */}

      {/*
        ★ THE TWO SCOPES DISAGREE, AND THIS IS THE ONLY PLACE THAT CAN BE SAID.

        Deliberately NOT a `ScopeNotApplied`: the scope does apply to this register, it was just
        applied a different way. So the note names both selections, says which one the rows below
        actually obey, and names the command that changes the other one — because the alternative is
        a reader concluding the scope control is broken when it is the extract that is out of date.

        The register is left exactly as the file has it. Re-applying the live scope here in JS would
        filter the invoices the file kept but could not bring back the ones it dropped, so the page
        would show a subset that matches neither scope — the worst of the three possible states.
      */}
      {data && scopeMoved && fileScope ? (
        <p className="scopenote" role="note">
          <span className="scopenote__flag">Scope difference</span> The register below was built with{' '}
          <strong>{scope?.label ?? scopeLabel(fileScope, fileScope.programs)}</strong> applied in the extract query, but
          the scope above the search box is now{' '}
          <strong>{scopeLabel(liveScope, scopeTenant?.programs ?? [])}</strong>. The invoices
          shown are the ones the file holds — the app cannot re-apply a different fund and program
          to them, because on this register the rule lives in the SQL, not in the browser. Re-run{' '}
          <code>node server/scripts/pull-invoices-extract.mjs</code> with the new scope to rebuild it.
        </p>
      ) : null}

      {/*
        ★ A LINK FROM A CHECK LANDED HERE, AND THE NOTE SAYS WHAT IT FOUND.

        Two states, and neither is an error. A miss is the usual outcome — this register holds 126
        invoices and the checks window carries 9,451 links, so nine in ten links name an invoice
        this window does not contain — and a miss that said nothing would look like a click that did
        nothing at all. The other state is several invoices sharing one number, where the page has
        to admit that it cannot tell which one the check settled rather than opening the first
        silently. The note is not a `ScopeNotApplied`-style caveat about the page: it is the answer
        to the click, which is why it names the number it was handed.
      */}
      {data && arrival ? (
        <p className="scopenote" role="note">
          {arrival.kind === 'missed' ? (
            <>
              <span className="scopenote__flag">Not in this register</span>
              No invoice in this register carries the number <strong>{arrival.number}</strong>
              {wantedVendor ? (
                <>
                  {' '}
                  against <strong>{wantedVendor}</strong>
                </>
              ) : null}
              . The check you came from covers the whole fiscal year; this register is the{' '}
              {scope?.label ?? 'scoped'} slice of it — {num(data.invoices.length)} invoices — and it
              drops any invoice with no distribution for the scope to test. So the invoice is real
              and it is not in this window. Nothing has been filtered: the whole register is below.
            </>
          ) : (
            <>
              <span className="scopenote__flag">
                {num(arrival.count)} share the number
              </span>
              {num(arrival.count)} invoices in this register carry the number{' '}
              <strong>{arrival.number}</strong>, and the vendor the check paid does not single one
              out. The register is filtered to those {num(arrival.count)} and the panel shows the
              first of them — compare the vendor and the amount with the check before reading it as
              the invoice that was settled. An invoice number is not an identity on these extracts.
            </>
          )}
        </p>
      ) : null}

      <section className="panel">
        <div className="panel__head">
          <div>
            <h2 className="panel__title">All invoices</h2>
            <p className="panel__sub">
              {terms.length > 0 || account
                ? `${num(matches.length)} of ${num(index.length)} invoices match ${
                    [
                      terms.length > 0 ? `“${query.trim()}”` : '',
                      project ? `project ${project}` : '',
                      account === NO_ACCOUNT
                        ? 'having no account'
                        : account
                          ? `account ${account}`
                          : '',
                    ]
                      .filter(Boolean)
                      .join(' and ')
                  }, searched across invoice number, vendor, description, amount, date, account code and every check that paid it.`
                : 'Searchable by invoice number, vendor, description, amount, date, account code, or the number of any check that settled it.'}
            </p>
          </div>
          <span className="panel__count">
            {matches.length === 0 ? '—' : `${num((current - 1) * PER_PAGE + 1)}–${num((current - 1) * PER_PAGE + shown.length)} of ${num(matches.length)}`}
          </span>
        </div>

        <div className="filterbar invfilter" role="group" aria-label="Filter invoices">
          <div className="invfilter__box">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.6" />
              <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <label className="sr" htmlFor="invoice-filter">
              Search invoices
            </label>
            <input
              id="invoice-filter"
              type="search"
              autoComplete="off"
              placeholder="Search invoices — number, vendor, check number or account"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) {
                  e.preventDefault();
                  setQuery('');
                }
              }}
            />
          </div>

          {/* ★ THE PROJECT FILTER, AND WHY IT SITS BEFORE THE ACCOUNT ONE.
              A reader arrives with a project in mind far more often than with a
              seven-segment combination: "what did we spend on Athens Drive" is a
              question, and `04-6570-862-526-0450-0840-000` is its answer. The
              account filter is the precision tool for the reader who already has
              the code, so it follows.

              It matches on the LEVEL segment of the invoice's accounts — the only
              link there is between an invoice and a project — and it offers only
              projects that actually have invoices here, so every option leads
              somewhere. See `projectOptions`. */}
          <FilterCombo
            label="Filter by project"
            anyLabel="Any project"
            placeholder="Any project — type a name or level"
            options={projectOptions}
            value={project}
            onChange={setProject}
          />

          {/* The exact-match control, and a different question from the box above:
              the box finds one SEGMENT of an account (`1110`), this finds the whole
              combination. The list is ordered busiest-first rather than
              alphabetically — a reader who knows the code types its prefix and
              jumps, and a reader who does not meets the accounts that carry money
              before the ones that carry $0.00.

              ★ IT IS NOW A FILTER-AS-YOU-TYPE COMBO RATHER THAN A `<select>`. With
                71 combinations the native control was a list nobody reads: typing
                into a `<select>` jumps to the first option starting with that
                character, which is a different feature wearing the same gesture.
                The combo searches the code, the row count and the account's own
                label, so `862` and `construction` both reach the right rows.

              A combination outside the register's scope still appears here: two of
              them are reached through invoices that are in scope, and a reader who
              sees such a code on a panel has to be able to filter to it. It is
              labelled rather than hidden, which is the same rule the panel follows. */}
          <FilterCombo
            label="Filter by GL account"
            anyLabel="Any account"
            placeholder="Any account — type a code"
            options={accountOptions.map((o) => ({
              value: o.code,
              label: o.code,
              detail: `${num(o.invoices)}${o.inScope ? '' : ' · outside the scope'}`,
              count: o.invoices,
            }))}
            value={account}
            onChange={setAccount}
            /* Offered only when such an invoice can exist. The scope removes them
               upstream — no distribution means no fund to test — so on the current
               extract this option is absent, and a control that offers a filter
               matching nothing is worse than one that does not offer it. */
            special={
              (data?.noAccount ?? 0) > 0
                ? {
                    value: NO_ACCOUNT,
                    label: `No account recorded (${num(data?.noAccount ?? 0)})`,
                  }
                : null
            }
          />

          {/* ★★ THE FISCAL-YEAR RANGE, WHICH IS THE FIX FOR "THE HIDDEN INVOICE".
              The register is bounded to a fiscal year, and it always was — but the
              page never said so. A reader who filtered to Athens Drive saw "1 of
              126" and reported a bug, because that project's level `0450` has 52
              in-scope invoices and exactly 1 of them falls in the newest year. The
              other 51 run back to 2024-05-31.

              ★ THE FIX IS TO LET THE READER MOVE THE BOUND AND SEE IT, not to remove
                it: the underlying view holds 1,246,676 checks, so an unbounded read
                is a way to ask for a hang. Two selects rather than a free-text range
                because the years come from the ledger, so a value the control offers
                is a value the server accepts — the two cannot drift.

              ★ IT SITS LAST BECAUSE IT IS THE COARSEST QUESTION. Project and account
                narrow *within* a year; this decides which years exist to narrow. */}
          {years.length > 0 ? (
            <div className="fyrange" role="group" aria-label="Fiscal year range">
              <label className="sr" htmlFor="invoice-fy-start">
                First fiscal year
              </label>
              <select
                id="invoice-fy-start"
                className="fselect fselect--fy"
                value={fyRange ? String(fyRange.start) : ''}
                onChange={(e) => {
                  const start = Number(e.target.value);
                  // ★ THE END FOLLOWS THE START UNLESS THE READER HAS WIDENED IT PAST IT.
                  //   Picking a start later than the current end would otherwise send a
                  //   reversed range, which the server refuses — a 400 for a gesture the
                  //   control itself invited.
                  setFyRange((prev) => {
                    const end = prev && prev.end >= start ? prev.end : start;
                    return { start, end };
                  });
                  setPage(1);
                }}
                title="The first fiscal year to include"
              >
                {years.map((y) => (
                  <option key={y.fiscalYear} value={y.fiscalYear}>
                    FY{y.fiscalYear}
                  </option>
                ))}
              </select>
              <span className="fyrange__dash" aria-hidden="true">
                –
              </span>
              <label className="sr" htmlFor="invoice-fy-end">
                Last fiscal year
              </label>
              <select
                id="invoice-fy-end"
                className="fselect fselect--fy"
                value={fyRange ? String(fyRange.end) : ''}
                onChange={(e) => {
                  const end = Number(e.target.value);
                  setFyRange((prev) => {
                    const start = prev && prev.start <= end ? prev.start : end;
                    return { start, end };
                  });
                  setPage(1);
                }}
                title="The last fiscal year to include"
              >
                {years.map((y) => (
                  <option key={y.fiscalYear} value={y.fiscalYear}>
                    FY{y.fiscalYear}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {query || account || project ? (
            <button
              type="button"
              className="fchip"
              onClick={clear}
              title="Clear the search, the project and the account filter"
            >
              {/* The account and the project are deliberately NOT repeated here:
                  the two combos beside this chip already show what is chosen, and
                  a 29-character mono code in a chip stretches it to half the bar. */}
              Clear{query ? ` “${query.trim()}”` : ''}
              {query && (account || project) ? ' and' : ''}
              {project ? ' the project filter' : ''}
              {project && account ? ' and' : ''}
              {account ? ' the account filter' : ''}
            </button>
          ) : null}
        </div>

        {/* ★★ THE WINDOW, STATED — AND THIS LINE IS THE ACTUAL FIX FOR THE REPORTED BUG.
            The register is bounded to a fiscal year and always was. The page never said
            so, so a reader who filtered to Athens Drive saw "1 of 126" and reported a
            bug: that project's level `0450` has 52 in-scope invoices and exactly 1 of
            them falls in the newest year. The filter was right; the page was silent
            about the one fact that made it look wrong.

            ★ IT IS UNCONDITIONAL, NOT GATED ON "DID IT COST ANYTHING". A note shown
              only when rows were removed would be absent on the default view — which is
              exactly the view the reader was on when they concluded the data was
              missing. The window is always a fact about the register, so it is always
              stated.

            ★ IT NAMES THE DATES, NOT JUST THE YEARS. "FY2027" is a label; "2026-07-01 –
              2027-06-30" is the thing a reader can check an invoice date against. */}
        {data ? (
          <p className="invwindow">
            <span className="invwindow__flag">Window</span>
            <span className="invwindow__text">
              {data.window.fiscalYear > 0 ? (
                <>
                  <strong>
                    {data.window.fiscalYearEnd > data.window.fiscalYear
                      ? `FY${data.window.fiscalYear}–${data.window.fiscalYearEnd}`
                      : `FY${data.window.fiscalYear}`}
                  </strong>{' '}
                  — invoices dated{' '}
                  <strong>{data.window.from}</strong> to <strong>{data.window.to}</strong>.{' '}
                </>
              ) : (
                <>
                  Invoices dated <strong>{data.window.from}</strong> to{' '}
                  <strong>{data.window.to}</strong>.{' '}
                </>
              )}
              {/* ★ THE SENTENCE THAT PREVENTS THE FALSE CONCLUSION, AND IT NAMES THE
                  CONTROL. A reader who has not noticed the year selects needs to be told
                  where the rest of the data is, not merely that a bound exists. */}
              {data.window.fiscalYearEnd > data.window.fiscalYear
                ? 'Widen the year range above to include more.'
                : `Invoices dated before ${data.window.from} are outside this window — widen the year range above to include them.`}
            </span>
          </p>
        ) : null}

        {/* A filter changes the row count silently; the same sentence in a live
            region is how a screen reader learns it did anything. */}
        <p className="sr" role="status">
          {terms.length > 0 || account || project
            ? `${num(matches.length)} of ${num(index.length)} invoices shown.`
            : ''}
        </p>

        {/* The sort, spoken. A second live region rather than a longer first one:
            the filter sentence is rebuilt on every keystroke, and an order
            announcement stapled to it would be re-read in full each time. */}
        <p className="sr" role="status">
          {sortNote}
        </p>

        {!data ? (
          <div className="panel__body">
            <p className="invempty">Reading the invoice extract…</p>
          </div>
        ) : shown.length === 0 ? (
          <div className="invempty">
            <p>
              {query.trim() ? (
                <>
                  No invoice of the {num(index.length)} in this window matches{' '}
                  <strong>{query.trim()}</strong>
                  {project || account ? ' with those filters.' : '.'}
                </>
              ) : project ? (
                <>
                  No invoice of the {num(index.length)} in this window is booked to an account on
                  project <strong>{projectOptions.find((o) => o.value === project)?.label ?? project}</strong>.
                </>
              ) : (
                <>No invoice of the {num(index.length)} in this window is booked to {account === NO_ACCOUNT ? 'no account at all' : account}.</>
              )}
            </p>
            <p className="invempty__hint">
              Every word has to appear somewhere in the invoice, so a two-word search is an
              &ldquo;and&rdquo;, not a phrase. A check number finds the invoices it settled. Add the
              vendor as well when the number is a common one — 142 invoices share the number
              &ldquo;30JUN-2026SES&rdquo;. The Account filter is exact: it matches a whole
              seven-segment combination, while the search box matches any part of one.
            </p>
            <button type="button" className="btn btn--system btn--sm" onClick={clear}>
              Clear the filters
            </button>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data invtable">
              <caption className="sr">
                Invoices in this fiscal year, {order}, with the number of checks that settled
                each one and the GL account it is booked to. Click a column heading to reorder
                the table.
              </caption>
              <colgroup>
                <col className="c-invno" />
                <col className="c-date" />
                <col className="c-amount" />
                <col className="c-checks" />
                <col className="c-vendor" />
                <col className="c-account" />
              </colgroup>
              <SortableHead columns={COLUMNS} sort={sort} onSort={applySort} />
              <tbody>
                {shown.map((invoice) => (
                  <tr
                    key={invoice.id}
                    className={`invtable__row${invoice.id === selected?.id && open ? ' is-open' : ''}`}
                    onClick={() => openInvoice(invoice)}
                  >
                    <td className="inv-no">
                      {/* The row is clickable for the mouse; this button is what
                          makes it reachable by keyboard and what gives the row a
                          name. Both do the same thing. */}
                      <button
                        type="button"
                        className="inv-link"
                        aria-expanded={invoice.id === selected?.id && open}
                        aria-controls="invoice-detail"
                        title={invoice.number}
                        onClick={(e) => {
                          e.stopPropagation();
                          openInvoice(invoice);
                        }}
                      >
                        {invoice.number}
                      </button>
                    </td>
                    <td className="inv-no">{invoice.date}</td>
                    <td className={`n inv-no${invoice.credited ? ' invtable__credit' : ''}`}>
                      {money(invoice.amount)}
                    </td>
                    <td className="n">
                      {/* Driven by the LINKS, never by the status flag. Zero is
                          drawn as a dash rather than "0", because "no check" is a
                          different statement from "a check for nothing". */}
                      {invoice.checks.length === 0 ? (
                        <span className="invchk invchk--none" title="No check settled this invoice">
                          <span aria-hidden="true">—</span>
                          <span className="sr">no check</span>
                        </span>
                      ) : (
                        <span className={`invchk${invoice.checks.length > 1 ? ' invchk--many' : ''}`}>
                          {num(invoice.checks.length)}
                        </span>
                      )}
                    </td>
                    {/* `inv-vendor` exists only to let this one column wrap. It is
                        the sole column whose content is unbounded free text with no
                        length cap, and it is measured in `invoices.css`: one vendor
                        name in the extract is 513px wide on one line, which on its
                        own made the table 134px wider than the panel and pushed the
                        Account column off the right edge. */ }
                    <td className="inv-vendor">{invoice.vendor}</td>
                    {/* The account, in the same three states as the Checks column:
                        a code, a code plus how many more, or the honest absence.
                        The largest account leads because an invoice booked 90/10
                        should read the way it is booked; the row's `title` carries
                        the rest, and the panel shows every one of them. */}
                    <td className="inv-acct">
                      {invoice.accounts.length === 0 ? (
                        <span
                          className="invacct__none"
                          title="No distribution is recorded for this invoice, so no account can be named"
                        >
                          <span aria-hidden="true">—</span>
                          <span className="sr">no account recorded</span>
                        </span>
                      ) : (
                        <>
                          <span
                            className="invacct__code"
                            title={invoice.accounts
                              .map(
                                (a) =>
                                  `${a.code}  ${money(a.amount)}${a.inScope ? '' : '  (outside the scope)'}`,
                              )
                              .join('\n')}
                          >
                            {invoice.accounts[0].code}
                          </span>
                          {invoice.accounts.length > 1 ? (
                            <span
                              className="invacct__more"
                              title={`${num(invoice.accounts.length - 1)} further account${
                                invoice.accounts.length === 2 ? '' : 's'
                              } — open the invoice to see them all`}
                            >
                              +{num(invoice.accounts.length - 1)}
                            </span>
                          ) : null}
                          {invoice.accountsDisagree ? (
                            <span
                              className="invacct__off"
                              title={`The accounts sum to ${money(invoice.accountsTotal)}, which is not the invoice amount of ${money(invoice.amount)}`}
                            >
                              <span aria-hidden="true">≠</span>
                              <span className="sr">
                                the accounts do not sum to the invoice amount
                              </span>
                            </span>
                          ) : null}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {shown.length > 0 ? (
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

        {data && totals && shown.length > 0 ? (
          <p className="chart-note" style={{ padding: '0 16px 12px' }}>
            This page is not the check register read backwards, and the two will never agree on a
            total: the {num(data.links)} links here are <em>invoices in this window → the checks
            that settled them</em>, while the register counts <em>checks in the window → their
            invoices</em>, wherever those were dated. {num(data.unpaid)} invoices here have no check
            at all. {num(data.understated)} carry a status of &ldquo;not accounted&rdquo; and a
            check anyway — the flag is the view&rsquo;s opinion, the link is the evidence, and the
            panel prints both rather than choosing. A further {num(data.priorYearLinks)} links point
            at checks issued before this fiscal year began, because an invoice posted on the first
            day of the year can be settled by a payment that ran in the last. The{' '}
            <strong>Account</strong> column is a third party to all of this and comes from a
            different relation again — the invoice&rsquo;s <em>distributions</em>, which is where
            Oracle keeps the GL code. {num(data.combinations)} combinations are in use across{' '}
            {num(data.accountRows)} distribution rows, {num(data.combinationsInScope)} of them
            inside the {scope?.applied ? scope.label.toLowerCase() : 'window'} scope — and{' '}
            {num(scope?.accountsOffScope ?? 0)} of those rows belong to invoices that{' '}
            <em>are</em> in scope while sitting outside it themselves.{' '}
            {scope?.accountsOffScopeInvoices === 1 ? 'That invoice keeps' : 'Those invoices keep'}{' '}
            every one of their accounts, because an account list trimmed to the scope would stop
            summing to its own invoice and would make the reconciliation note above report a fault
            that does not exist.
          </p>
        ) : null}
      </section>

      <InvoicePanel
        invoice={selected}
        open={open}
        onClose={() => setOpen(false)}
        onFilter={openAccount}
        scopeLabel={scope?.applied ? scope.label : ''}
        po={data?.po ?? null}
      />
    </div>
  );
}

/**
 * Where the invoice is booked — the GL account, which lives on the invoice's
 * distributions and not on the invoice itself.
 *
 * Three states, and the panel says which one it is rather than showing a
 * plausible-looking code:
 *
 *   none      no distribution exists, so no account can be named. Unreachable on
 *             the current extract — the scope removes an invoice with no
 *             distribution before the page ever sees it — and kept only so that a
 *             cached or unscoped file cannot render a blank cell where a reader
 *             would assume the value was simply missing.
 *   one       the ordinary case.
 *   several   53 of the 126 invoices in scope; the worst spans 7.
 *
 * ★ An account OUTSIDE the register's scope is marked, never hidden. Two kept
 *   invoices draw one apiece. Removing it would leave the account list not summing
 *   to the invoice and would make the reconciliation note below report a fault
 *   that is not there — which is exactly the kind of \"error\" a reader would then
 *   chase.
 *
 * ★ The seven-segment decomposition is given for the LARGEST account only, and is
 *   captioned as such. An invoice spanning several accounts would otherwise render
 *   a decoder ring per account. Every code in the list above carries its own
 *   mapping as a tooltip, so the information is one hover away without the list
 *   being unreadable.
 *
 * Clicking a code filters the table to that account. It closes the panel as it
 * does, because the panel is modal and the answer is behind it — leaving a drawer
 * standing over the list it just filtered would make the click look like nothing
 * happened.
 *
 * ★ TWO ACTIONS, NOT ONE, AND THEY USED TO BE ONE CELL.
 *
 * The code was a single unlabelled button that did the filter, so the only sign a
 * reader had clicked anything was a filter chip appearing behind a closed panel —
 * and the one question the row actually raises, *where else is this account used*,
 * had no answer anywhere on the page. The code is now an anchor to the account's
 * own page and the filter is a second control with a name, so neither action has to
 * be inferred.
 *
 * ★ THE DESTINATION IS THE BUDGET PAGE, AND IT WAS FIRST BUILT AS THE COMBINATION
 *   PAGE. That was the wrong answer to the right question. A row in a spend register
 *   is asking what the money *was*, and the combination page answers what a
 *   purchase order *did* — it reads one PO per combination, so it cannot speak for
 *   a distribution that arrived some other way. Worse, its own coverage gap (below)
 *   meant the link landed on an empty list for a quarter of the accounts, which is
 *   indistinguishable from a broken link. `/funding/budgets` answers the budget
 *   question directly, and the combination page is one click on from it.
 *
 * The link can still name an account with no budget, and *that* is expected. The
 * two sides are built from different extracts — and here they are not merely
 * different files but different **sources**: this page reads AP distributions from
 * an extract, the budget page reads two database views. Measured over the served
 * data, this register books to **71** distinct accounts and only **1** of them
 * (`04-6570-862-526-0450-0840-000`, $85,120.80 of the register's $5,650,333) has a
 * budget row; the other **70** carry $5,565,211.86 and no budget at all. The
 * budgeted set is four accounts, all at level `0450` — a narrow seed, against a
 * broad register. So the destination names the absence in words and says how to get
 * where the account does have an answer; see the `budabsent` panel in `Budgets.tsx`.
 * A link that always lands empty is a worse failure than a link that says why.
 *
 * For completeness, the combination page's own coverage, since the budget page
 * links on to it: 71 combinations carry an invoice distribution here and 46 of them
 * appear among that page's 328 — so the other 25, holding $1,539,881, have no
 * purchase order against them. `UnopenedCombination` in `FundingSearch.tsx` states
 * that, rather than rendering an empty list.
 *
 * Both halves have to survive the same edge: an account outside the register's scope
 * stays reachable and stays labelled, because the invoice is in scope and its
 * accounts still have to add up to it.
 */
function AccountSection({
  invoice,
  onFilter,
  scopeLabel,
}: {
  invoice: Invoice | null;
  onFilter: (code: string) => void;
  /** `Fund 04 · program 861/862/863`, or `''` when no scope was applied. */
  scopeLabel: string;
}) {
  if (!invoice) return null;

  const accounts = invoice.accounts;
  const lead = accounts[0];
  const offScope = accounts.filter((a) => !a.inScope);

  /** `04-6530-802-323-0203-0930-000  FUND 04 · Budget bucket 6530 · …` as a tooltip. */
  const decode = (a: InvoiceAccount): string =>
    a.segments.map((s, i) => `${SEGMENT_ORDER[i] ?? `SEGMENT${i + 1}`} ${s}`).join(' · ');

  return (
    <section className="dsec">
      <div className="dsec__head">
        <h3 className="dsec__title">Where it is booked</h3>
        <span className="dsec__hint">
          {accounts.length === 0
            ? 'no account'
            : pluralise(accounts.length, 'account')}
        </span>
      </div>

      {accounts.length === 0 ? (
        <div className={invoice.amount === 0 ? 'invnone' : 'invnone invnone--flag'}>
          <p>
            No distribution is recorded for this invoice, so <strong>no GL account can be named</strong>{' '}
            for it.
          </p>
          <p className="invnote">
            There is nothing here to read: the register keeps the GL code on the invoice&rsquo;s
            distributions, and this invoice has none.{' '}
            {invoice.amount === 0
              ? 'It is for nothing either way, so nothing is being withheld.'
              : `It is not for nothing, though — the invoice is ${money(invoice.amount)} with no account behind it.`}{' '}
            An invoice with no distribution has no fund and no program, so a register restricted
            to {scopeLabel || 'a fund and a program'} cannot tell whether it belongs; those
            invoices are left off this page and counted, with their value, in the note above the
            table.
          </p>
        </div>
      ) : (
        <>
          <div className="invaccounts">
            <table className="invcheckstable invaccttable">
              <caption className="sr">
                GL account combinations this invoice is booked to, largest amount first.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">Type</th>
                  <th scope="col" className="n">
                    Amount
                  </th>
                  <th scope="col" className="n">
                    Lines
                  </th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id} className={a.inScope ? undefined : 'invacctrow--off'}>
                    <td>
                      <Link
                        className="invacct__link"
                        to={`/funding/budgets?account=${encodeURIComponent(a.code)}`}
                        title={`${a.code}\n${decode(a)}${a.inScope ? '' : '\n\n★ outside the register\u2019s scope'}\n\nWhat this account has been budgeted, and what it has left`}
                      >
                        {a.code}
                        <span className="invacct__go">Budget detail ›</span>
                      </Link>
                      {/*
                        ★ THE OTHER QUESTION THIS ROW RAISES, AND IT HAS ITS OWN DESTINATION.

                        The link above answers what the money *was* budgeted against. This one
                        answers whether an order was raised for it — a different question with a
                        different source, which is the whole reason the purchase-order register
                        exists. A second anchor rather than a second destination hung on the first,
                        because they do not both land with anything like the same frequency:
                        measured over the served data, 46 of the 71 combinations this register
                        books to are charged to an order line and only 1 carries a budget row.

                        So it can arrive on an empty list, and that is a real state the destination
                        names in words — 69 of the 126 invoices in scope are coded to a combination
                        no order covers, and they are recognisably the ones that would be (purchase
                        cards, use tax, standing charges). The rule the link above already follows
                        applies here too: a link that always lands empty is a worse failure than a
                        link that says why.
                      */}
                      <Link
                        className="invacct__link invacct__link--orders"
                        to={ordersForAccountHref(a.code)}
                        title={`${a.code}\n${decode(a)}${a.inScope ? '' : '\n\n★ outside the register\u2019s scope'}\n\nPurchase orders charged to this account, if any — an account no order was raised against is a real state here, not a broken link`}
                      >
                        <span className="invacct__go">Orders ›</span>
                      </Link>
                      {a.inScope ? null : (
                        <span
                          className="invacct__offscope"
                          title={
                            scopeLabel
                              ? `Not ${scopeLabel}. Shown because the invoice is in scope and its accounts must still add up to it.`
                              : 'Outside the register\u2019s scope. Shown because the invoice is in scope and its accounts must still add up to it.'
                          }
                        >
                          outside scope
                        </span>
                      )}
                      {/* The in-register question, named. It sets the page's own search,
                          which is why it is separate from the link: one asks *where else
                          is this account used*, the other *what in this register touches
                          it*, and only the second one is answerable for all 71 codes. */}
                      <button
                        type="button"
                        className="invacct__only"
                        onClick={() => onFilter(a.code)}
                        title={`Show only the invoices in this register booked to ${a.code}`}
                      >
                        Only this account
                      </button>
                    </td>
                    <td title={`ACCOUNT_TYPE ${a.type || 'not recorded'}`}>
                      {accountTypeLabel(a.type)}
                    </td>
                    <td className="n">{money(a.amount)}</td>
                    <td className="n" title="Distribution lines folded into this row">
                      {num(a.lines)}
                    </td>
                  </tr>
                ))}
                {accounts.length > 1 ? (
                  <tr className="invaccttable__sum">
                    <td>All {num(accounts.length)}</td>
                    <td />
                    <td className="n">{money(invoice.accountsTotal)}</td>
                    <td className="n">
                      {num(accounts.reduce((s, a) => s + a.lines, 0))}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>

          {/* The decoder ring, once. The key is seven segments in a fixed order and
              nothing on the code itself says which is which; repeating this for
              every account would be unreadable at 251 of them. */}
          <div className="invrows invacct__key">
            <div className="invrow invrow--sum">
              <span className="invrow__k">
                The segments of {accounts.length === 1 ? 'the account' : 'the largest account'}
              </span>
              <span className="invrow__v invacct__code">{lead.code}</span>
            </div>
            {lead.segments.map((s, i) => (
              <div className="invrow" key={SEGMENT_ORDER[i] ?? i}>
                <span className="invrow__k">
                  {SEGMENT_ORDER[i] ?? `Segment ${i + 1}`}
                  <span className="invacct__role">{SEGMENT_ROLE[SEGMENT_ORDER[i]] ?? ''}</span>
                </span>
                <span className="invrow__v invacct__code">{s}</span>
              </div>
            ))}
            <div className="invrow">
              <span className="invrow__k">Account type</span>
              <span className="invrow__v">{accountTypeLabel(lead.type)}</span>
            </div>
          </div>

          {invoice.accountsDisagree ? (
            <p className="invnote invnote--flag">
              The accounts and the invoice do not agree. The invoice says{' '}
              <strong>{money(invoice.amount)}</strong> and its accounts come to{' '}
              <strong>{money(invoice.accountsTotal)}</strong> — a difference of{' '}
              <strong>{money(invoice.accountsTotal - invoice.amount)}</strong>. Both figures are
              printed and neither is treated as the right one: the invoice and its distributions are
              two views of one document, and which of the two is behind the register is not
              something this extract records.
            </p>
          ) : (
            <p className="invnote">
              The {pluralise(accounts.length, 'account')} here come to{' '}
              <strong>{money(invoice.accountsTotal)}</strong>, which is exactly the invoice amount.
              That agreement is the reason this section can be trusted: the account is read from the
              distribution and reconciled back to the invoice before it is shown. It is also why the
              account list is never trimmed to the scope — a partial list would not add up, and the
              reconciliation would look like a fault in the data instead of what it was.
            </p>
          )}

          {offScope.length > 0 ? (
            <p className="invnote invnote--flag">
              {num(offScope.length)} of these {pluralise(accounts.length, 'account')}{' '}
              {offScope.length === 1 ? 'sits' : 'sit'} outside{' '}
              {scopeLabel || 'the register\u2019s scope'} —{' '}
              <strong>{money(offScope.reduce((s, a) => s + a.amount, 0))}</strong> of this invoice.
              {offScope.length === 1 ? ' It is' : ' They are'} shown and marked rather than dropped:
              the invoice itself is in scope, and removing its other accounts would leave the list
              above not summing to the invoice, which reads as a data fault and is not one.
            </p>
          ) : null}

          <p className="invnote">
            These come from the invoice&rsquo;s <em>distributions</em>. The register itself carries
            no account code, and neither does any other view on this page, so the code is joined on
            from <code>WCSEXP_AP_INV_DISTRIBUTIONS</code> →{' '}
            <code>WCSEXP_GL_CODE_COMBINATIONS</code> — which is also why an invoice can have more
            than one. &ldquo;Lines&rdquo; is how many distribution rows were folded into a figure.
            The account type is Oracle&rsquo;s own: most accounts here are expense, but asset and
            liability accounts are both real and are named rather than filtered out.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * The order this invoice names — in the four states it can be in, each of which
 * needs a different thing on screen.
 *
 * ★ THIS BLOCK USED TO READ "none on this row — see each account below". That was
 *   a true statement about the *report* and a false one about the *invoice*, which
 *   is the worst combination available: `PO_HEADER_ID` is null on every row of
 *   `WCSEXP_AP_INVOICES`, so the note was right that this view carries no order —
 *   and a reader took it to mean the invoice has none, which is false for 110 of
 *   the 126. The number was never missing; it was one table away, on the invoice
 *   LINES: `AP_INVOICE_LINES_ALL.PO_HEADER_ID → PO_HEADERS_ALL.PO_HEADER_ID`,
 *   where `SEGMENT1` is the number a person reads. It is read now, so this row
 *   answers the question rather than deflecting it to seven account rows.
 *
 * The states, and why none of them can be merged into another:
 *
 *   openable       the register this page links to holds this order — every one of
 *                  the 110 invoices that name one, $4,921,015.73 of the money. A
 *                  link, and it lands.
 *
 *   not openable   the register does NOT hold it — 0 invoices on the live ledger.
 *                  The number is printed in full and marked rather than linked,
 *                  because a bare number would read as an unlinked link. The state
 *                  is kept because a ledger that keeps moving can stop holding an
 *                  order, and because when it happens the reason is structural: the
 *                  register is bounded to fund 04 · programs 861/862, so an order
 *                  raised outside that scope is real and simply not in it.
 *
 *   not measured   the register could not be read, so nothing has been compared
 *                  and nothing may be claimed. `poInRegister` is `null` here and NOT
 *                  `false`, and that distinction is the whole reason the field has
 *                  three values: style this state as a miss and a register that is
 *                  briefly unreachable would libel every order on the page at once.
 *
 *   names none     16 invoices, $729,316.93 between them, and not small change —
 *                  the largest is a single $693,915.13. Prepaid cards, travel
 *                  reimbursements, use tax and standing charges never raise an
 *                  order, so this is an answer and the page says which one it is.
 *
 *   names several  cannot happen: `PO_COUNT` is 0 or 1 on all 126 rows and the
 *                  pull refuses to write the file if that ever changes, because
 *                  `PO_NUMBER` is a `MAX()` over the invoice's lines and above one
 *                  it has silently chosen. Handled anyway, so that the day it does
 *                  change the page shows a plural instead of one order pretending
 *                  to be the only one.
 *
 * ★ THE FIRST TWO STATES USED TO READ 62 AND 48, AND BOTH NUMBERS ANSWERED A QUESTION
 *   ABOUT A DOCUMENT THE READER CANNOT OPEN. The comparison ran against the register
 *   **file on disk** — 2,782 rows, one school's orders, narrow enough that 35 of the
 *   39 numbers it lacked sat on a cost centre it did not cover — while the link in the
 *   *openable* state opens the **live ledger**, 31,670 rows. Every one of those 48
 *   invoices names an order the served register holds, so the page was marking
 *   numbers unopenable that a click would have opened. The count is now made in
 *   `invoices.ts` when the page loads, against the register the link opens; see
 *   `loadOrderRegister` there for why it is a fetch rather than a field.
 */
function PurchaseOrder({ invoice, po }: { invoice: Invoice; po: PoCoverage | null }) {
  const { poNumber, poCount, poInRegister } = invoice;

  if (poCount > 1) {
    return (
      <span
        className="invrow__ponum"
        title={`This invoice names ${num(poCount)} orders. The extract records one number per invoice, and above one it is the highest of them rather than the only one — so none is shown here.`}
      >
        {num(poCount)} orders
        <span className="invrow__why"> — no single number is this invoice&rsquo;s</span>
      </span>
    );
  }

  if (poNumber === null) {
    return (
      <span
        className="invrow__none"
        title={
          po
            ? `No purchase order is named on any line of this invoice — ${num(po.notNamed)} of the ${num(po.named + po.notNamed)} invoices in scope are in the same position, and they are not small change.`
            : 'No purchase order is named on any line of this invoice.'
        }
      >
        none — no order was raised against it
      </span>
    );
  }

  if (poInRegister === true) {
    return (
      <Link
        className="invrow__po"
        to={orderHref(poNumber)}
        title={`Open order ${poNumber} on the purchase-order register`}
      >
        {poNumber}
      </Link>
    );
  }

  // `false` and `null` look alike and mean opposite things, so they are written
  // apart: one names a register that was read and does not hold the order, the
  // other names a question that was never asked.
  if (poInRegister === false) {
    return (
      <span
        className="invrow__ponum"
        title={
          `${poNumber} is not on the order register this page links to.` +
          (po
            ? `\n\nThat register is the ${po.register.kind === 'oracle' ? 'live ledger' : 'frozen extract this build serves'} — fund ${po.register.fund.join('/') || 'unstated'}${po.register.program.length ? ` · program ${po.register.program.join('/')}` : ''}, ${num(po.register.orders)} orders — and this invoice was compared against it when the page loaded, so an order raised outside that scope is real and simply not in it.`
            : '') +
          `\n\nThe number is real: it is recorded on this invoice's lines in Oracle.`
        }
      >
        {poNumber}
        <span className="invrow__why"> — not in this app&rsquo;s order register</span>
      </span>
    );
  }

  return (
    <span
      className="invrow__ponum"
      title={`Order ${poNumber} is recorded on this invoice's lines. The order register could not be read when this page loaded, so nothing here has been compared against it — reload to try again, and the register itself is on the Purchase orders page.`}
    >
      {poNumber}
      <span className="invrow__why"> — not yet compared with the order register</span>
    </span>
  );
}

/**
 * The invoice's own details and the checks that paid it, in a panel that slides
 * in from the right.
 *
 * It keeps the shared `.drawer` primitive's geometry and close button, and its
 * own body, because what goes in it — one invoice's figures, the accounts it is
 * booked to, the checks behind it, and the statement of which of the two is
 * evidence — exists nowhere else.
 */
function InvoicePanel({
  invoice,
  open,
  onClose,
  onFilter,
  scopeLabel,
  po,
}: {
  invoice: Invoice | null;
  open: boolean;
  onClose: () => void;
  onFilter: (code: string) => void;
  scopeLabel: string;
  /** The order's coverage, or `null` on a file written before it was read. */
  po: PoCoverage | null;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // The same three-state width contract as the other three panels: null lets the
  // stylesheet own it until the reader resizes.
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
    if (open && invoice) closeRef.current?.focus();
  }, [open, invoice]);

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

  const checks = invoice?.checks ?? [];
  const settled = checks.length > 0;
  // The 14 rows this page exists to get right: the view says not accounted and a
  // check exists anyway. Measured 0 the other way round.
  const flagUnderstates = !!invoice && !invoice.accounted && settled;
  const flagOverstates = !!invoice && invoice.accounted && !settled;
  const early = checks.filter((c) => c.date < (invoice?.date ?? ''));
  // The check that ran furthest ahead of the invoice. Pass the EARLIER date first:
  // `daysBetween(a, b)` measures a → b, so the reversed order returns a negative
  // number, which is how "before the invoice by -230 days" first got rendered.
  const earliest = early.reduce((m, c) => (c.date < m.date ? c : m), early[0]);
  const outside = checks.filter((c) => !c.inWindow);
  const style = width === null ? undefined : ({ '--drawer-w': `${width}px` } as CSSProperties);

  return (
    <aside
      ref={panelRef}
      id="invoice-detail"
      className={`drawer invpanel${open ? ' is-open' : ''}${resizing ? ' is-resizing' : ''}`}
      style={style}
      role="dialog"
      aria-modal="true"
      aria-label={invoice ? `Invoice ${invoice.number} — where it is booked and the checks that paid it` : 'Invoice details'}
      aria-hidden={!open}
      tabIndex={-1}
    >
      <ResizeGrip
        value={width ?? rendered}
        onChange={setUserWidth}
        onReset={resetWidth}
        onDraggingChange={setResizing}
        controls="invoice-detail"
        label="Resize the invoice details panel"
      />

      <div className="drawer__head">
        <div className="drawer__eyebrow">
          Invoice ·{' '}
          {settled ? `settled by ${pluralise(checks.length, 'check')}` : 'no check recorded'}
        </div>
        <h2 className="drawer__name">{invoice?.number ?? ''}</h2>
        <div className="drawer__meta">
          <b>{invoice?.date ?? ''}</b> · <b>{money(invoice?.amount ?? 0)}</b>
          <br />
          {invoice?.vendor || 'No vendor named'}
        </div>
        {invoice ? (
          <PinButton
            category="invoice"
            entityKey={String(invoice.id)}
            title={invoice.number || `Invoice ${invoice.id}`}
            subtitle={`${invoice.vendor} · ${invoice.date}`}
            href={`/spend/invoices?invoice=${encodeURIComponent(invoice.number)}&vendor=${encodeURIComponent(invoice.vendor)}&date=${encodeURIComponent(invoice.date)}&amount=${encodeURIComponent(String(invoice.amount))}`}
          />
        ) : null}
        <button
          ref={closeRef}
          type="button"
          className="drawer__close"
          onClick={onClose}
          aria-label="Close the invoice details panel"
        >
          <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="drawer__body">
        <section className="dsec">
          <div className="dsec__head">
            <h3 className="dsec__title">What the invoice says</h3>
            <span className="dsec__hint">{invoice?.credited ? 'credit note' : 'invoice'}</span>
          </div>

          <div className="invrows">
            <div className="invrow">
              <span className="invrow__k">Amount</span>
              <span className={`invrow__v${invoice?.credited ? ' invrow__v--credit' : ''}`}>
                {money(invoice?.amount ?? 0)}
              </span>
            </div>
            <div className="invrow">
              <span className="invrow__k">Amount paid</span>
              <span className="invrow__v">
                {/* NULL is "not recorded", which is a different statement from
                    "recorded as nothing" — so it is never rendered as $0.00. */}
                {invoice === null || invoice.paid === null ? (
                  <span className="invrow__none">not recorded</span>
                ) : (
                  money(invoice.paid)
                )}
              </span>
            </div>
            <div className="invrow">
              <span className="invrow__k">Payment status on the invoice</span>
              <span className="invrow__v">
                {invoice?.accounted ? 'Y — accounted' : 'N — not accounted'}
              </span>
            </div>
            <div className="invrow invrow--sum">
              <span className="invrow__k">Checks that settled it</span>
              {/*
                ★ THE LIST, NOT A COUNT OF IT.

                This row used to read "1 check" and stop, which is the one shape a reader cannot
                act on: it names a relation without naming the thing at the other end, on a screen
                whose whole subject is that relation. It names the checks now, and each name opens
                the check's own panel — the same relation walked in the other direction, and the
                direction that needs no guesswork, because the invoice side already holds the
                check's identity. The table further down repeats these with dates and amounts; this
                is the short answer for a reader who wants the check, and "none" is spelled out
                rather than left as an empty value, because a settled-looking invoice with no
                payment behind it is a real state this register contains.
              */}
              <span className="invrow__v">
                {invoice && invoice.checks.length > 0 ? (
                  invoice.checks.map((c, n) => (
                    <span key={c.id}>
                      {n > 0 ? <span className="invrow__sep">, </span> : null}
                      <Link
                        className="invrow__chk"
                        to={checkHref(c)}
                        title={`Open check ${c.number} on the payments register`}
                      >
                        {c.number}
                      </Link>
                    </span>
                  ))
                ) : (
                  <span className="invrow__none">none</span>
                )}
              </span>
            </div>
            <div className="invrow">
              <span className="invrow__k">Purchase order</span>
              {/*
                This row used to read "none on this row — see each account below", which was
                true of the report and false about the invoice; see `PurchaseOrder` below for
                what replaced it and why the old wording was the worst of the available
                combinations rather than a harmless simplification.
              */}
              <span className="invrow__v">{invoice ? <PurchaseOrder invoice={invoice} po={po} /> : null}</span>
            </div>
          </div>

          <p className="invnote">
            {invoice?.description
              ? `Description: ${invoice.description}`
              : 'No description is recorded on this invoice.'}
          </p>
          {/*
            ★ THIS NOTE USED TO SAY THE OPPOSITE OF THE TRUTH, so it is worth marking what was
            wrong rather than only replacing it. It read: "The purchase-order column on this view
            is null on every row, so no invoice here names its order directly — an order is raised
            against an account combination, and that is the only side of the relation this extract
            carries."

            The first clause is a fact about the *report* and it is still true. The conclusion — that
            the relation is only reachable per account — was FALSE, and the way it was false is the
            lesson: the extract carries every account's seven segments, so two vectors meeting on a
            combination looks like the only route available, and it is a coincidence of what was
            read rather than a property of the data. The order is on the invoice's own LINES, one
            table from the header this view reads. `PO_HEADER_ID` being null on the header said
            *the header does not carry it*, and it was read as *nothing does*.

            So the note now states the coverage instead of the absence, and the account-row links
            stay where they are: they answer a different question — which orders are charged to
            this account — and both are real.

            ★ NOTE WHAT WAS *NOT* WRONG. That removed sentence went on to cite "46 of the 71
            combinations", "57 of the 126 invoices in scope" and "$4,273,387.04" — and every one of
            those figures re-measures correctly against the served files. Its arithmetic was sound
            and its conclusion was not, which is precisely why it read as authoritative. Do not
            "fix" the account-side numbers to match the line-side ones below: they are two
            relations. The line side asks whether the invoice names an order (110 of 126, every one
            of which the served register holds); the account side asks whether the invoice's
            combination is charged to a register line (57 of 126). An invoice can name an order whose
            lines are booked to another account, so the second number is legitimately the smaller
            one.

            ★ AND ONE MORE IN THE SAME FAMILY, FOUND LATER AND FIXED THE SAME WAY. The line side was
            compared against the register **file on disk** — 2,782 rows, one school's orders — while
            the links beside it open the **live ledger**, 31,670 rows. So "it holds 62 of those 110"
            was a true statement about a document the reader cannot open, and 48 invoices were shown
            as naming an order nothing could open when every one of them was in the register the app
            serves. The figures below are now counted in this page, at load, against the same
            register the links open. The defect's shape is worth keeping in view: not one number was
            mis-summed, and the page still lied.
          */}
          {po ? (
            <p className="invnote">
              An invoice names its order on its <em>lines</em>, not on its header — the column this
              view labels &ldquo;purchase order&rdquo; is null on all {num(po.named + po.notNamed)}{' '}
              rows of it, and that is why the row above is the first place this page has ever been
              able to answer the question. <strong>{num(po.named)} of them name an order</strong> —{' '}
              {money(po.namedValue)} of the {money(po.namedValue + po.notNamedValue)} in scope — and{' '}
              <strong>{num(po.notNamed)} name none</strong>, which is an answer rather than a gap: a
              prepaid card, a travel reimbursement, use tax and a standing charge all spend money
              without raising an order, and they carry {money(po.notNamedValue)} between them
              {po.largestNotNamed ? `, ${money(po.largestNotNamed.value)} of it on a single invoice` : ''}.{' '}
              The register these links open is the{' '}
              {po.register.kind === 'oracle' ? 'live ledger' : 'frozen extract this build serves'} —{' '}
              {po.register.fund.length ? `fund ${po.register.fund.join('/')}` : 'one fund'}
              {po.register.program.length ? ` · program ${po.register.program.join('/')}` : ''}
              {po.register.minDate && po.register.maxDate
                ? `, orders dated ${po.register.minDate} to ${po.register.maxDate}`
                : po.register.maxDate
                  ? `, newest order ${po.register.maxDate}`
                  : ''}
              , {num(po.register.orders)} orders over {num(po.register.lines)} lines — and it holds{' '}
              {po.inRegister === po.named ? (
                <>
                  <strong>every one of those {num(po.named)}</strong> invoices, and{' '}
                  {po.numbersInRegister === po.distinctNumbers
                    ? `all ${num(po.distinctNumbers)} of their order numbers`
                    : `${num(po.numbersInRegister)} of their ${num(po.distinctNumbers)} order numbers`}
                </>
              ) : (
                <>
                  <strong>{num(po.inRegister)} of those {num(po.named)}</strong> invoices and{' '}
                  {num(po.numbersInRegister)} of their {num(po.distinctNumbers)} order numbers
                </>
              )}
              .{' '}
              {po.notInRegister > 0 ? (
                <>
                  The other {num(po.notInRegister)} — {money(po.notInRegisterValue)} — are printed
                  with their number and without a link, because the order is real and the register
                  has no row for it.{' '}
                </>
              ) : null}
              That comparison is made when the page loads, against the same register these links open,
              so a number is never reported missing from a register the reader can open in the next
              tab. The account rows below answer a narrower version of the same question — which
              orders are charged to <em>this</em> account — so one of those links can legitimately
              come back empty while this row&rsquo;s number is a live order.
            </p>
          ) : null}
        </section>

<AccountSection invoice={invoice} onFilter={onFilter} scopeLabel={scopeLabel} />

        <section className="dsec">
          <div className="dsec__head">
            <h3 className="dsec__title">The checks that paid it</h3>
          </div>

          {!settled ? (
            <div className="invnone">
              <p>
                No check in these views settles {invoice?.number ? <strong>{invoice.number}</strong> : 'this invoice'}.
              </p>
              <p className="invnote">
                {invoice?.accounted
                  ? 'The invoice is marked accounted, which a check should accompany — no invoice in this window is in that state.'
                  : 'The invoice is marked not accounted, so the register and the status agree. 151 of the 3,736 invoices in this window are in the same position.'}
              </p>
            </div>
          ) : (
            <>
              <div className="invchecks">
                <table className="invcheckstable">
                  <caption className="sr">Checks that settled this invoice.</caption>
                  <thead>
                    <tr>
                      <th scope="col">Check</th>
                      <th scope="col">Date</th>
                      <th scope="col" className="n">
                        Amount issued
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {checks.map((c) => (
                      <tr key={c.id}>
                        <td className="inv-no">
                          <Link
                            className="inv-no__chk"
                            to={checkHref(c)}
                            title={`Open check ${c.number} on the payments register`}
                          >
                            {c.number}
                          </Link>
                          {!c.inWindow ? <span className="invprioryear">prior year</span> : null}
                        </td>
                        <td className="inv-no">{c.date}</td>
                        <td className="n inv-no">{money(c.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="invnote">
                {checks.length === 1
                  ? 'One check settled this invoice.'
                  : `${num(checks.length)} checks settled this invoice, so the relation runs both ways and neither end is a key.`}{' '}
                Each amount above is what the check was issued for <em>in total</em> —{' '}
                <strong>not</strong> this invoice&rsquo;s share of it. The payments view
                (<code>WCSEXP_AP_INVOICE_PAYMENTS</code>) is a four-column link table with no amount
                on it, so how much of any one check reached this invoice is not recorded anywhere,
                and nothing here has estimated it.
              </p>

              {early.length > 0 && invoice ? (
                <p className="invnote invnote--flag">
                  {early.length === 1 ? (
                    <>
                      Check <strong>{earliest.number}</strong>, which settled this invoice, was
                      issued <strong>{num(daysBetween(earliest.date, invoice.date))} days</strong>{' '}
                      before the invoice was raised — on {earliest.date}. A payment that ran first
                      is a real thing to find, not a date to correct.
                    </>
                  ) : (
                    <>
                      {num(early.length)} of the checks here were issued before the invoice was
                      raised. The earliest is <strong>{earliest.date}</strong> —{' '}
                      {num(daysBetween(earliest.date, invoice.date))} days before it, on check{' '}
                      {earliest.number}. A payment that ran first is a real thing to find, not a
                      date to correct.
                    </>
                  )}
                </p>
              ) : null}

              {outside.length > 0 ? (
                <p className="invnote">
                  {pluralise(outside.length, 'check')} {outside.length === 1 ? 'falls' : 'fall'}{' '}
                  outside the fiscal year this page covers, because an invoice posted on the first
                  day of the year can be settled by a payment that ran in the last month of the one
                  before.
                </p>
              ) : null}
            </>
          )}
        </section>

        <section className="dsec">
          <div className="dsec__head">
            <h3 className="dsec__title">The flag and the link</h3>
            <span className="dsec__hint">
              {flagUnderstates || flagOverstates ? 'they disagree' : 'they agree'}
            </span>
          </div>

          <div className="invrows">
            <div className="invrow">
              <span className="invrow__k">Status on the invoice</span>
              <span className="invrow__v">{invoice?.accounted ? 'accounted (Y)' : 'not accounted (N)'}</span>
            </div>
            <div className="invrow">
              <span className="invrow__k">Evidence — checks in the register</span>
              <span className="invrow__v">{settled ? pluralise(checks.length, 'check') : 'none'}</span>
            </div>
            <div className={`invrow invrow--sum${flagUnderstates || flagOverstates ? ' invrow--off' : ''}`}>
              <span className="invrow__k">
                {flagUnderstates || flagOverstates ? 'Which one this page follows' : 'Result'}
              </span>
              <span className="invrow__v">
                {flagUnderstates ? 'the link' : flagOverstates ? 'the link' : 'both agree'}
              </span>
            </div>
          </div>

          <p className="invnote">
            {flagUnderstates ? (
              <>
                The invoice says it is not accounted, and a check has settled it anyway. This page
                follows the <strong>link</strong>, because a document that exists beats a flag that
                says it does not — and it says here that the two disagree rather than quietly
                picking the tidier one. 14 of the 3,736 invoices in this window are in this state.
              </>
            ) : flagOverstates ? (
              <>
                The invoice is marked accounted and no check in the register settles it. No invoice
                in this window is in this state, so it is reported rather than explained.
              </>
            ) : (
              <>
                The status and the register agree on this invoice, which is true of all but 14 of
                the 3,736 in the window. The status is the view&rsquo;s opinion about the invoice;
                the link is the payment. Where they part, this page shows both and names the
                difference — it does not treat one as a proxy for the other.
              </>
            )}
          </p>
        </section>
      </div>

      <div className="drawer__foot">
        <button
          type="button"
          className="btn btn--system btn--sm"
          onClick={() => invoice && exportChecks(invoice)}
          disabled={!invoice}
          title="This invoice, the accounts it is booked to, and every check that settled it — one row per account-per-check, with a blank row for whichever side is absent"
        >
          Download (CSV)
        </button>
        <button type="button" className="btn btn--system btn--sm" onClick={onClose}>
          Close
        </button>
      </div>
    </aside>
  );
}
