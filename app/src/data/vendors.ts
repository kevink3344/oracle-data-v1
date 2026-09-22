/**
 * The vendor companies register — every payee this tenant's AP register has paid,
 * with the checks that paid it and the invoices those checks settled.
 *
 * ── ★ WHERE THE CONTENT COMES FROM, AND WHY THAT IS THE WHOLE MODULE ────────
 *
 * **Oracle. Both halves.** Not the Turso sample, and not a hand-made fixture.
 *
 * The **payments** side is `invoices.json`, written by
 * `server/scripts/pull-invoices-extract.mjs` out of `APPS.WCSEXP_AP_INVOICES` /
 * `APPS.WCSEXP_AP_INVOICE_PAYMENTS` / `APPS.WCSEXP_AP_INV_DISTRIBUTIONS` on the live
 * ledger (`POWERAPPS@europa.wcpss.net:1541/ebs_FA2DB`). The **master** side is
 * `PO_VENDORS`, read live through `/api/vendors`.
 *
 * ── ★ AND WHY THE SCOPED INVOICE REGISTER IS THE RIGHT SOURCE FOR A SCOPED PAGE ──
 *
 * The obvious source for "what did we pay this vendor" is `checks.json` — 4,218
 * checks and 9,451 invoice links. **It cannot be scoped**, and that is not an
 * oversight in this module: `WCSEXP_AP_CHECKS` and `WCSEXP_AP_INVOICE_PAYMENTS`
 * carry no account columns at all. A check is paid out of a bank account, not out of
 * Fund 04 / program 862, so there is no `FUND` and no `PROGRAM` on it to test. Used
 * here it would put 2,611 payees on a page the reader asked to be scoped to one fund
 * and two programs — 2,386 of whom appear on no in-scope purchase-order line and
 * whose invoices may be booked anywhere in the chart of accounts.
 *
 * `invoices.json` **is** scoped, and says so in its own envelope: Fund `04`,
 * programs `861`/`862`/`863`, applied in the extract's SQL by testing each invoice's
 * **distributions** rather than the invoice header. Measured, that leaves **126 of
 * the window's 3,736 invoices** — $5,650,332.66 of $99.87M. Every invoice on this
 * page therefore carries the account combination that put it in scope, and
 * `fund`/`program` below are read off those accounts rather than asserted.
 *
 * ── THE PAGE'S POPULATION, MEASURED (2026-09-19) ───────────────────────────
 *
 *     126 invoices · 117 of them linked to a check · 65 distinct checks
 *     **55 distinct vendors** · max 15 invoices on one vendor · max 5 checks
 *     invoice value $5,650,332.66 · check value $6,403,331.75
 *     9 invoices reached by no check · $23,020.84 · on 2 of the 55 vendors
 *
 * ★ THE LAST LINE IS THE ONE A VENDOR-LEVEL PAGE HIDES, AND IT IS WHY IT IS HERE.
 *   Every one of the 55 vendors has *some* payment against it, so "which vendors are
 *   unpaid" is the empty set — while "which invoices are unpaid" is 9 rows across 2
 *   companies. Aggregating to the company erased the only distinction a reader could
 *   see in the data, so the table row prints the invoice-level fact (`Vendor.unpaid`
 *   and `Vendor.unpaidValue`) rather than a company-level verdict.
 *
 * 53 of the 55 also appear on an in-scope purchase-order line. The other two are
 * individual reimbursement payees — `Wayne, Mrs. Sandra Allen (Sandy)` and
 * `Perez, Ms. Cynthia S` — worth $2,592.41 between them. **They are kept**, because
 * a vendor this tenant paid is a vendor this page is about, and dropping two real
 * payments to satisfy a purchase-order condition would hide money for a reason the
 * reader could not see. The panel says which vendors name no order.
 *
 * ── WHY THE TWO MONEY FIGURES ARE BOTH PRINTED ─────────────────────────────
 *
 * `settled` sums the **invoices** listed; `issued` sums the **checks**. They are not
 * the same number and neither is the other's error:
 *
 *   - a check is written once and can settle several invoices, so `issued` counts
 *     a check that paid three vendors' invoices once;
 *   - a check's amount covers **the whole payment**, and the database does not
 *     record how much of it went to which invoice — `WCSEXP_AP_INVOICE_PAYMENTS`
 *     has four columns and none of them is money;
 *   - the windows differ: 2026-07-01 → 2027-06-30 for invoices, and a check may sit
 *     outside it.
 *
 * `settled` is the page's total because that is what the reader asked for — *"sum of
 * the invoice amounts listed"* — and `issued` is printed beside it so the gap is a
 * stated fact rather than a discrepancy someone finds later.
 *
 * ── `INVOICE_NUM` IS NOT AN IDENTITY, AND EVERY LINK CARRIES THE PROOF ─────
 *
 * ★ MEASURED, AND THE FIRST DRAFT OF THIS SENTENCE WAS WRONG: the register holds 126
 *   invoices under **125 distinct numbers**, and exactly one of them — `PAYAPP4` —
 *   is drawn **twice, by two different vendors**. (An earlier note claimed
 *   `30JUN-2026SES` was drawn 142 times here by 142 vendors. It is not in this file
 *   at all: that number belongs to the *line* register behind `/spend/invoices`,
 *   where it is drawn 127 times — by one vendor, which is the opposite of the point.)
 *
 * So a `VendorInvoice` carries its `INVOICE_ID`, its date and its amount beside the
 * number, and the link to `/spend/invoices` hands all four over. A link keyed on the
 * number alone would land on the wrong invoice and look correct doing it — and it
 * would do so *sometimes*, which is the worst kind of wrong: the line register has
 * 737 of its 6,270 numbers drawn more than once, the worst of them 157 times.
 */

import {
  loadInvoices,
  type Invoice,
  type InvoiceAccount,
  type InvoiceCheck,
  type InvoiceScope,
} from './invoices';

/**
 * One invoice as it appears under a check in the panel.
 *
 * Deliberately not `Invoice`: the register's row carries a description, a payment
 * flag, a PO register verdict and a per-account breakdown, and the panel shows a
 * number, a date, an amount and the account that put the row in scope. Carrying the
 * rest would be carrying fields nothing reads, and every one of them is a field that
 * could drift out of step with the register.
 */
export interface VendorInvoice {
  /** `INVOICE_ID`. The row key — the NUMBER is not one. */
  id: number;
  number: string;
  date: string;
  amount: number;
  /** `AMOUNT_PAID`, or `null` for "not recorded". Never coerced to 0. */
  paid: number | null;
  /** `amount < 0`. */
  credited: boolean;
  /**
   * The GL combination that put this invoice in scope, or `''` when it draws none.
   *
   * ★ THE EVIDENCE FOR THE SCOPE, PER ROW. The register was narrowed by fund and
   *   program in the extract's SQL, and this is the account that did it —
   *   `04-…-862-…`. The page prints it under every invoice, so "this page is scoped
   *   to 04 and 861/862" is something a reader can check against a row rather than
   *   take on trust from a banner.
   */
  account: string;
  /** Every combination the invoice draws. One row can carry seven. */
  accounts: number;
  /** The order the invoice names, or `null` — a real answer, not a gap. */
  poNumber: string | null;
}

/** One check, with the invoices of *this vendor* that it settled. */
export interface VendorCheck {
  /** `CHECK_ID` — the key, because `CHECK_NUMBER` is not unique. */
  id: number;
  number: string;
  date: string;
  /**
   * The check's own amount for the whole payment, NOT this vendor's share.
   *
   * ★ THERE IS NO PER-INVOICE SHARE TO SHOW. `WCSEXP_AP_INVOICE_PAYMENTS` records
   *   *which* check paid an invoice and never *how much* went there, so when one
   *   check settles invoices on two vendors the split is not in the database. The
   *   panel prints the check's amount and says so rather than dividing it.
   */
  amount: number;
  /** This vendor's invoices the check paid, newest first. */
  invoices: VendorInvoice[];
  /** Sum of those invoices. The figure the running total adds. */
  invoiced: number;
}

export interface Vendor {
  /** The name as the register carries it, trimmed. */
  name: string;
  /** `name` uppercased with the non-alphanumerics removed — a stable React key. */
  key: string;
  /**
   * What the page shows: `name`, unless a reader has saved a custom one.
   *
   * ★ THERE ARE TWO NAMES ON THIS RECORD AND THEY ARE NOT INTERCHANGEABLE. `name`
   *   is the ledger's, and on this page it is a **key** rather than a label: the
   *   panel's master-record lookup matches on it exactly
   *   (`loadMaster` — `text(r.VENDOR_NAME) === wanted`), the invoice link carries it
   *   to disambiguate two companies whose invoices would otherwise look alike, and
   *   the CSV export puts it in its own column. `displayName` is what a reader sees.
   *   Anything that **finds** or **addresses** a vendor uses `name`; anything that
   *   **prints** it uses `displayName`. {@link applyCustomNames} is the only writer of
   *   `displayName`, and nothing here ever derives one from the other.
   */
  displayName: string;
  /**
   * Whether `displayName` is a stored custom value — the fact the changed-value gear
   * mark means.
   *
   * ★ IT IS NOT `displayName !== name`. A reader may save the ledger's own spelling
   *   as their custom value (fixing a stray space, say), and that is still a custom
   *   value with an author and a date behind it. Deriving this by comparing the two
   *   strings would silently un-mark exactly that case, and the mark is the only
   *   thing telling a reader the name on screen is somebody's choice.
   */
  custom: boolean;
  invoices: VendorInvoice[];
  /** Newest check first. */
  checks: VendorCheck[];
  /**
   * Sum of `invoices[].amount` — **what these payments settled**, and the page's
   * total. A credit is negative here, which is the point: a vendor who was refunded
   * should not read as having been paid that money.
   */
  settled: number;
  /**
   * Sum of the distinct checks' own amounts. Usually greater than `settled`, because
   * a check settles invoices on more than one vendor.
   *
   * ★ NOT "greater by design" — it is greater only while most of a vendor's invoices
   *   carry a check. Measured: WAKE COUNTY PUBLIC SCHOOLS holds 15 invoices worth
   *   $762,506.43 against 5 checks worth $741,031.50, so here `issued < settled`,
   *   because 8 of its invoices (purchase-card rows and a standing charge) are
   *   reached by no check in this window. The ordering is a fact about the data and
   *   the panel must not assume a sign.
   */
  issued: number;
  /** Invoices with no check linking them. 9 on the register; carried per vendor. */
  unpaid: number;
  /**
   * What those invoices add up to, so the table row can say it without the panel.
   *
   * ★ A COUNT WITHOUT A SUM IS HALF AN ANSWER HERE, AND THE TWO DISAGREE ON THIS
   *   REGISTER IN A WAY A READER WOULD NOT GUESS. All 9 unpaid invoices sit on 2
   *   companies: 8 on WAKE COUNTY PUBLIC SCHOOLS worth **$23,020.84** and 1 on ALL
   *   AMERICAN RELOCATION INC worth **$0.00**. So the busiest exception is not the
   *   expensive one, and a row carrying only "1 unpaid" beside a row carrying "8"
   *   would overstate the second company's problem relative to the first.
   */
  unpaidValue: number;
  /** Invoices with a negative amount. */
  credits: number;
  /** Distinct combinations touched, in the order first seen. */
  accounts: string[];
  /** Earliest and latest invoice date. `''` when the vendor has no invoice. */
  from: string;
  to: string;
}

/** The vendors, and the register facts a reader needs to size them. */
export interface VendorsExtract {
  /** Biggest `settled` first. */
  vendors: Vendor[];
  /** What the register is a slice of, read from the file. Never assumed. */
  scope: InvoiceScope;
  /** The fiscal year the pull was bounded to. */
  window: { from: string; to: string; fiscalYear: number };
  /** The dates actually present, which are narrower than the bound. */
  observed: { from: string; to: string };
  /** Invoices behind the vendor list. 126. */
  invoices: number;
  /** Of those, the ones a check links. 117. */
  linked: number;
  /** Distinct checks reaching them. 65. */
  checks: number;
  /** Sum of every invoice amount. Equals the sum of `vendors[].settled`. */
  settled: number;
  /** Sum of every distinct check amount — the same checks counted once. */
  issued: number;
  /**
   * Sum of the amounts of the invoices no check reaches. $23,020.84 over 9 rows.
   *
   * ★ NOT `settled − issued`, AND THE TWO ARE NOT EVEN COMMENSURABLE. `issued` adds
   *   up *checks*, which settle invoices belonging to several vendors at once, so
   *   subtracting it from a sum of *invoices* compares two different things. This is
   *   the one figure that measures the gap directly.
   */
  unpaidValue: number;
  /**
   * The distinct fund/program pairs the invoices' own accounts carry, measured.
   *
   * ★ THIS IS A MEASUREMENT, NOT A RESTATEMENT OF THE SCOPE. `scope.fund` and
   *   `scope.programs` are what the *pull asked for*; this is what the rows
   *   *contain*. On the current register they are `04/862` on 182 of 184 account
   *   rows with two rows at `04/000` — **there is no program 861 on the payments
   *   side at all**, and 863 holds no rows anywhere in this ledger. A page that
   *   printed only the request would be describing an intention.
   */
  observedScope: string[];
  /** Account rows across the register, and how many are inside the scope. */
  accountRows: number;
  accountRowsInScope: number;
}

/** Trimmed text, or `''`. */
const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

/** A figure, or 0 — never `NaN`. One bad row must not poison a whole column. */
const figure = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * A vendor's identity for grouping and for a React key.
 *
 * ★ THE TRIM IS NOT COSMETICS HERE. `PO_VENDORS` stores names with **leading
 *   spaces** — the first live row is `"  chickfila"` — so a grouping that did not
 *   trim would put the same company on the page twice under two spellings. The
 *   AP side happens to arrive clean (0 of 4,218 checks carry an untrimmed name),
 *   which is exactly why the trim has to live on the *derivation* rather than on
 *   the assumption that both sides are tidy.
 *
 * The uppercase-and-strip fold is the second chance, and it is deliberately only
 * that: it collapses punctuation differences between two spellings of one company
 * while never being used to *display* anything.
 *
 * ★ EXPORTED, AND THIS IS THE CLIENT'S ONE COPY. A custom field names its subject by
 *   this fold, so the page that **writes** an override and the page that **reads**
 *   one back must agree to the character — and the vendor site register shows the
 *   same vendors, so it needs the same fold. Three hand-copies of a
 *   `toUpperCase().replace(...)` would drift silently in the direction that matters:
 *   a lookup that stops matching produces no error, only a custom name that never
 *   appears. (The server keeps its own copy in `custom-fields/registry.ts`; that is
 *   the one boundary a shared constant cannot cross.)
 */
export const vendorKeyOf = (name: string): string =>
  text(name).toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * The account combination that puts an invoice in scope, for display.
 *
 * Prefers an in-scope account; falls back to the largest by magnitude so a row that
 * somehow carries none still prints the account it is booked to instead of a blank.
 */
function scopeAccount(accounts: readonly InvoiceAccount[]): { code: string; program: string } {
  if (!accounts.length) return { code: '', program: '' };
  const chosen =
    accounts.find((a) => a.inScope) ??
    accounts.slice().sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))[0];
  return { code: chosen.code, program: text(chosen.segments[2]) };
}

/**
 * Group the scoped register's invoices into vendors.
 *
 * ★ PURE, AND SEPARATE FROM THE FETCH ON PURPOSE. The whole page's arithmetic —
 *   which invoices a check settled, what a vendor was paid, how many checks there
 *   are — is this function and nothing else, so it can be exercised against a
 *   fixture without a network, a browser or a ledger.
 */
export function groupVendors(extract: {
  invoices: readonly Invoice[];
  scope: InvoiceScope;
  window: { from: string; to: string; fiscalYear: number };
  observed: { from: string; to: string };
}): VendorsExtract {
  // One pass. The register arrives ordered by invoice id, so the per-vendor lists
  // are re-sorted at the end rather than being assumed into order here.
  const byVendor = new Map<string, Vendor>();
  const checkIdsAll = new Set<number>();
  const checkAmounts = new Map<number, number>();
  const observedAccounts = new Map<string, number>();
  let accountRows = 0;
  let accountRowsInScope = 0;
  let settledAll = 0;
  let unpaidAll = 0;
  let linked = 0;

  for (const inv of extract.invoices) {
    const name = text(inv.vendor);
    // A row with no vendor cannot be placed on a page of vendors, and inventing an
    // "unknown" company would put real money under a heading that is not a company.
    // Measured: zero rows. Counted anyway so a change is visible rather than silent.
    if (!name) continue;

    for (const a of inv.accounts) {
      accountRows += 1;
      if (a.inScope) accountRowsInScope += 1;
      const pair = `${text(a.segments[0])}/${text(a.segments[2])}`;
      observedAccounts.set(pair, (observedAccounts.get(pair) ?? 0) + 1);
    }

    const account = scopeAccount(inv.accounts);
    const row: VendorInvoice = {
      id: inv.id,
      number: text(inv.number),
      date: text(inv.date),
      amount: figure(inv.amount),
      paid: inv.paid,
      credited: inv.credited,
      account: account.code,
      accounts: inv.accounts.length,
      poNumber: inv.poNumber ? text(inv.poNumber) : null,
    };

    const key = vendorKeyOf(name);
    let vendor = byVendor.get(key);
    if (vendor === undefined) {
      vendor = {
        name,
        key,
        displayName: name,
        custom: false,
        invoices: [],
        checks: [],
        settled: 0,
        issued: 0,
        unpaid: 0,
        unpaidValue: 0,
        credits: 0,
        accounts: [],
        from: '',
        to: '',
      };
      byVendor.set(key, vendor);
    }

    vendor.invoices.push(row);
    vendor.settled += row.amount;
    settledAll += row.amount;
    if (row.credited) vendor.credits += 1;
    if (row.account && !vendor.accounts.includes(row.account)) vendor.accounts.push(row.account);
    if (row.date) {
      if (!vendor.from || row.date < vendor.from) vendor.from = row.date;
      if (!vendor.to || row.date > vendor.to) vendor.to = row.date;
    }

    // Group the links per check, remembering which invoice each one belongs to so
    // the panel can put the invoice rows *under* the check that paid them.
    //
    // ★ THE ABSENT LINK IS THE DEFINITION, NOT `row.paid` — THOUGH THE TWO AGREE.
    //   What decides whether an invoice can be shown *under a check* is whether some
    //   check links it, and that is a fact about the link table. It happens to
    //   coincide exactly with the ledger's own reading here: `PAYMENT_STATUS_FLAG` is
    //   'N' on all 9, and `AMOUNT_PAID` is 0 on all 9. Three independent readings of
    //   one set, so a count off any of them is checkable against the other two.
    const checks: InvoiceCheck[] = inv.checks;
    if (checks.length === 0) {
      vendor.unpaid += 1;
      vendor.unpaidValue += row.amount;
      unpaidAll += row.amount;
    } else linked += 1;
    for (const c of checks) {
      checkIdsAll.add(c.id);
      // The check's own amount is a property of the check, not of this vendor: two
      // vendors paid by one check must not each add its full value to a register
      // total. Kept in a map keyed on the id so `issued` counts it once.
      checkAmounts.set(c.id, figure(c.amount));
      let bucket = vendor.checks.find((x) => x.id === c.id);
      if (bucket === undefined) {
        bucket = {
          id: c.id,
          number: text(c.number),
          date: text(c.date),
          amount: figure(c.amount),
          invoices: [],
          invoiced: 0,
        };
        vendor.checks.push(bucket);
      }
      bucket.invoices.push(row);
      bucket.invoiced += row.amount;
    }
  }

  const vendors = [...byVendor.values()];
  for (const v of vendors) {
    // Newest first, then by number so two checks on one day have a stable order —
    // `sort` is not stable enough across engines to leave the tie to chance.
    v.checks.sort((a, b) => (a.date === b.date ? a.number.localeCompare(b.number) : a.date < b.date ? 1 : -1));
    v.invoices.sort((a, b) => (a.date === b.date ? b.amount - a.amount : a.date < b.date ? 1 : -1));
    // A vendor's `issued` is the sum of ITS OWN checks. Two vendors sharing a check
    // each report it, because each was paid by it; the register-wide `issued` below
    // counts it once, and the two figures are printed under different labels.
    v.issued = v.checks.reduce((s, c) => s + c.amount, 0);
  }
  vendors.sort((a, b) => {
    if (a.settled !== b.settled) return b.settled - a.settled;
    return a.name.localeCompare(b.name);
  });

  return {
    vendors,
    scope: extract.scope,
    window: extract.window,
    observed: extract.observed,
    invoices: extract.invoices.length,
    linked,
    checks: checkIdsAll.size,
    settled: settledAll,
    issued: [...checkAmounts.values()].reduce((s, n) => s + n, 0),
    unpaidValue: unpaidAll,
    observedScope: [...observedAccounts.entries()].sort().map(([pair, n]) => `${pair} (${n})`),
    accountRows,
    accountRowsInScope,
  };
}

const INVOICES_URL = '/oracle/invoices.json';

/**
 * The register, grouped into vendors.
 *
 * ★ IT DELEGATES THE READ RATHER THAN FETCHING THE FILE ITSELF, AND THAT IS THE
 *   POINT: `/spend/invoices` reads the same document through the same loader, so
 *   the two pages cannot end up disagreeing about how many invoices are in scope,
 *   what a check paid, or whether an invoice's accounts sum to its amount. A second
 *   parser here would be a second set of answers waiting to differ by one row.
 */
export async function loadVendors(signal?: AbortSignal): Promise<VendorsExtract> {
  const register = await loadInvoices(signal);
  return groupVendors({
    invoices: register.invoices,
    scope: register.scope,
    window: register.window,
    observed: register.observed,
  });
}

/**
 * Put the custom names on the register.
 *
 * A pure decorator applied **after** the load, deliberately: `groupVendors` is
 * exercised against fixtures without a network, and a custom name is a fact about
 * this application's own table rather than about the extract. Keeping them apart
 * means the grouping can be reasoned about without knowing this feature exists.
 *
 * `labels` is keyed by the folded vendor key — `vendorKeyOf(name)`, the same fold the
 * server applies before it stores a row, and the same one on `Vendor.key`. The fold
 * exists in three places on purpose: the server must fold what it is given, this
 * side must fold to look it up, and `Vendor.key` is already folded as a React key.
 * A second, different fold anywhere would silently stop matching.
 *
 * Returns a new extract and a new array of rows; the rows themselves are copied, so
 * a caller holding the loaded register cannot be surprised by an in-place edit.
 */
export function applyCustomNames(
  extract: VendorsExtract,
  labels: ReadonlyMap<string, string>,
): VendorsExtract {
  if (labels.size === 0) return extract;

  const vendors = extract.vendors.map((v) => {
    const custom = labels.get(v.key);
    if (custom === undefined) return v;
    return { ...v, displayName: custom, custom: true };
  });

  return { ...extract, vendors };
}

/** Unused today, kept so `INVOICES_URL` documents where the rows come from. */
export const VENDORS_SOURCE = INVOICES_URL;

// ---------------------------------------------------------------------------
// The master record, read live from Oracle.
// ---------------------------------------------------------------------------

/** A `PO_VENDORS` row as `/api/vendors` serves it. */
export interface VendorMaster {
  id: number;
  name: string;
  /** `VENDOR_TYPE_LOOKUP_CODE` — `VENDOR`, `eProcurement`, `Government Agency`, or `''`. */
  type: string;
  /** `ENABLED_FLAG === 'Y'`. */
  enabled: boolean;
  /** `CREATION_DATE`, `YYYY-MM-DD`. `''` when the ledger holds none. */
  created: string;
  /**
   * How many `PO_VENDORS` rows carry this exact name.
   *
   * ★ NOT ALWAYS ONE, AND THE PAGE SAYS SO. `WAKE COUNTY PUBLIC SCHOOLS` resolves to
   *   two master rows on the live ledger. The first is taken and the count is shown,
   *   because picking silently would make a duplicate look like a single record —
   *   and a reader reconciling this page against Oracle needs to know the key is
   *   ambiguous rather than to be told it is not.
   */
  matches: number;
}

interface MasterRow {
  VENDOR_ID?: unknown;
  VENDOR_NAME?: unknown;
  VENDOR_TYPE_LOOKUP_CODE?: unknown;
  ENABLED_FLAG?: unknown;
  CREATION_DATE?: unknown;
}

/**
 * The live master row for one vendor name, or `null`.
 *
 * ★ THIS IS THE HALF THAT CANNOT COME FROM AN EXTRACT. `PO_VENDORS` holds **79,685
 *   rows** (measured; the Turso sample held 157, which is what "the country's 749
 *   vendors" in the menu note was really describing). Reading it whole is 160
 *   paged requests, so the page asks about **one** vendor when its panel opens —
 *   `?q=` is a 180–250 ms indexed search and resolves an exact name exactly (6 of 6
 *   sampled). `null` is returned rather than thrown for: the panel then says the
 *   master record could not be read and shows the register's own figures, which are
 *   complete without it.
 */
export async function loadMaster(name: string, signal?: AbortSignal): Promise<VendorMaster | null> {
  const wanted = text(name);
  if (!wanted) return null;

  const url = `/api/vendors?q=${encodeURIComponent(wanted)}&limit=20`;
  try {
    const res = await fetch(url, { signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: MasterRow[] };
    const rows = Array.isArray(body?.data) ? body.data : [];
    // ★ EXACT, TRIMMED, ON THE MASTER'S OWN NAME. `?q=` is a substring search, so
    //   `DEWBERRY` returns `DEWBERRY DESIGN-BUILDERS INC` first — taking row zero
    //   would put the wrong company's type and creation date on the panel. The
    //   filter is what makes this a lookup rather than a guess.
    const exact = rows.filter((r) => text(r.VENDOR_NAME) === wanted);
    const row = exact[0];
    if (row === undefined) return null;
    return {
      id: figure(row.VENDOR_ID),
      name: text(row.VENDOR_NAME),
      type: text(row.VENDOR_TYPE_LOOKUP_CODE),
      enabled: text(row.ENABLED_FLAG) === 'Y',
      created: text(row.CREATION_DATE).slice(0, 10),
      matches: exact.length,
    };
  } catch (e) {
    // An abort is the caller's own cancellation and must not be swallowed:
    // resolving `null` would let a panel show "no master record" for a request the
    // reader abandoned.
    if (signal?.aborted) throw e;
    return null;
  }
}
