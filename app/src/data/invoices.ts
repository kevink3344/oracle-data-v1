/**
 * The AP invoices extract — `data/oracle/invoices.json`.
 *
 * One fiscal year of `AP_INVOICES`: 3,736 invoices carrying 3,678 links to the
 * checks that paid them, frozen to JSON by `server/scripts/pull-invoices-extract.mjs`.
 *
 * ── WHY A SECOND EXTRACT, RATHER THAN THE CHECKS FILE REVERSED ───────────────
 *
 * `checks.json` already holds 9,451 invoice links, so the cheap move is to invert
 * them. It does not work, and the reason is the single most important fact about
 * this data: **`INVOICE_NUM` is not a key.** In this window 3,068 numbers are
 * drawn across 3,736 invoices, and 78 of the 79 repeated numbers appear under
 * more than one vendor — `30JUN-2026SES` alone is drawn 142 times by 142
 * different vendors. The checks file carries no `INVOICE_ID`, because a check
 * does not need one. Inverting it would key 3,736 rows on a string that collides
 * 668 times. `INVOICE_ID` is the key, and only this view has it.
 *
 * ── WHY THE LINK COUNT IS NOT THE SAME NUMBER AS THE CHECKS PAGE ─────────────
 *
 * Checks says 9,451 links. This page says 3,678. **Both are right, and they
 * measure different things:**
 *
 *   Checks  — 9,451 pairs of *checks in the window* → their invoices, wherever
 *             those invoices are dated.
 *   Invoices— 3,678 pairs of *invoices in the window* → their checks, wherever
 *             those checks were issued.
 *
 * Neither is the other's total. This page must state its own denominator and not
 * quietly imply the register agrees with it. (It also counts 1,603 distinct checks
 * against the register's 4,218: an invoice list ending 2026-12-17 only reaches
 * the checks that paid invoices up to then.)
 *
 * ── WHY A LINK HAS NO AMOUNT ────────────────────────────────────────────────
 *
 * `WCSEXP_AP_INVOICE_PAYMENTS` has four columns — `INVOICE_PAYMENT_ID,
 * INVOICE_ID, PAYMENT_NUM, CHECK_ID` — and none of them is money. A link states
 * *which* check paid an invoice and never *how much* of it went there, so when one
 * invoice is settled by two checks the split is not in the database at all. The
 * panel prints each check's own amount and says plainly that the division between
 * them is not recorded. Anything else would be an invented figure.
 *
 * ── WHY THE FLAG IS NOT A PROXY FOR PAYMENT ─────────────────────────────────
 *
 * The obvious short-cut is to render `PAYMENT_STATUS_FLAG` as the status and skip
 * the links. Measured, it is wrong on 14 rows:
 *
 *     Y and a check      3,571
 *     Y and NO check         0     the flag never over-claims
 *     N and no check       151     genuinely unpaid
 *     N and A check         14     ** the flag under-claims **
 *
 * So the flag is conservative — it says "not accounted" about fourteen invoices
 * that a check settled. `accounted` and `checks.length > 0` are therefore two
 * separate facts here, both exposed, and the panel says which one it is reporting.
 * Neither is folded into the other.
 *
 * ── AND WHY `paid` IS `number | null` ───────────────────────────────────────
 *
 * `AMOUNT_PAID` is NULL on 29 rows and `0` on 64. Those are not the same state —
 * NULL is "not recorded", zero is "recorded as nothing" — and collapsing them to
 * a boolean would destroy the only signal that tells them apart. `null` is
 * therefore carried through as "cannot be asked", per this app's standing rule,
 * and the panel prints "not recorded" rather than `$0.00`.
 *
 * ── WHERE THE GL ACCOUNT COMES FROM (`Table3`) ──────────────────────────────
 *
 * The register has no account code on it, and neither does `checks.json`. The
 * account is on the invoice's **distributions**, one join away:
 *
 *     WCSEXP_AP_INV_DISTRIBUTIONS.DIST_CODE_COMBINATION_ID
 *         → WCSEXP_GL_CODE_COMBINATIONS.CODE_COMBINATION_ID
 *
 * so the extract carries a third result set — one row per **(invoice, code
 * combination)**. The grain is the pair, not the invoice: **53 of the 126
 * invoices in scope are booked to more than one account and the worst is booked
 * to 7.** A single `account: string` on `Invoice` would therefore be a lie for
 * two fifths of the table, which is why `accounts` is an array and every figure
 * derived from it is stated per account.
 *
 * ── THE SCOPE (`invoices.json` → `.scope`) ─────────────────────────────────
 *
 * ★ **This register is not all invoices. It is the Fund `04`, Program
 * 861/862/863 slice of them, and the extract says so in its own envelope.**
 * Measured on the FY2027 window:
 *
 * | bucket | invoices | value |
 * |---|---|---|
 * | **in scope — the file itself** | **126** | **$5,650,332.66** |
 * | excluded: has distributions, none in scope | 3,584 | $94,189,128.88 |
 * | unanswerable: no distribution to test | 26 | $28,565.26 |
 * | window total | 3,736 | |
 *
 * The third bucket is the reason the counts are carried rather than subtracted.
 * Those 26 invoices have **no distribution at all**, so there is no Fund and no
 * Program to test — they are not "excluded by the scope", they are a question
 * the register cannot answer, and **the only two real-money invoices in the whole
 * window live in it** (`IN-048722`, $23,356.76; `S2998931.001`, $5,208.50).
 * Subtracting the kept count from the window count would file both under
 * "excluded by scope" and quietly invent a rule that removed them.
 *
 * **The scope narrows which invoices, never which accounts.** Two kept invoices
 * also draw an account outside it (2 rows, $243.15). Those rows stay in the file
 * and are marked `inScope: false`, because filtering them out would stop the
 * accounts summing to the invoice and make the reconciliation check report a
 * fault that is not one.
 *
 * ★ Nothing below hardcodes `'04'` or the three programs. They come from the
 * envelope so that a re-run under a different rule cannot leave the page
 * describing the previous one.
 *
 * `ACCOUNT_TYPE` is not uniform either. Expense dominates in this slice, but
 * asset accounts are real and the second-largest group by rows. Nothing may
 * filter to `E`; the type travels on each account and is shown.
 *
 * The seven segments are assembled into `code` here rather than being read from
 * a `CONCATENATED_SEGMENTS` column, because **that column does not exist on
 * `WCSEXP_GL_CODE_COMBINATIONS`.** `||` over the segments is also how Oracle
 * builds the key, and a NULL segment would silently collapse the whole
 * concatenation to `''` — the extract asserts no segment is NULL so this cannot
 * happen quietly.
 */

/** A row as it lands in `invoices.json` → `.body.ResultSets.Table1`. */
interface RawInvoice {
  INVOICE_ID: number;
  INVOICE_NUM: string | null;
  INVOICE_DATE: string;
  INVOICE_AMOUNT: number | string;
  AMOUNT_PAID: number | string | null;
  PAYMENT_STATUS_FLAG: string | null;
  DESCRIPTION: string | null;
  VENDOR_NAME: string | null;
  /**
   * The purchase order's number, or NULL when the invoice names none.
   *
   * ★ ABSENT FROM AN EXTRACT WRITTEN BEFORE THIS COLUMN EXISTED, which is why it
   *   is optional and why "absent" must never be read as "names no order". The
   *   distinction between an invoice with no order and an extract with no column
   *   is the whole reason this field is not simply a `string`.
   */
  PO_NUMBER?: string | null;
  /**
   * How many DISTINCT orders the invoice names.
   *
   * It exists to guard `PO_NUMBER`, which the pull computes as `MAX(SEGMENT1)`
   * over the invoice's lines — a **silent collapse** if an invoice ever carries
   * two orders. Carried to the page even though it is 0 or 1 everywhere today, so
   * a change in the data is visible rather than absorbed.
   */
  PO_COUNT?: number | string | null;
}

/**
 * A row as it lands in `.body.ResultSets.Table2`.
 *
 * ★ THE CHECK'S OWN FIELDS ARE CARRIED, AND THEY ARE NOT REDUNDANT WITH `Table1`. A link states
 *   *which* check settled an invoice; the panel then has to say *when* and *for how much*, and
 *   those live on the check. The first draft of the live route returned only the two ids, which
 *   would have rendered a panel of blanks — so the three fields are joined back from
 *   `WCSEXP_AP_CHECKS` rather than dropped.
 */
interface RawInvoiceCheckLink {
  INVOICE_ID: number;
  CHECK_ID: number;
  CHECK_NUMBER: number | string;
  CHECK_DATE: string;
  CHECK_AMOUNT: number | string;
}

/**
 * A row as it lands in `.body.ResultSets.Table3`.
 *
 * One row per (invoice, code combination) — `DIST_ROWS` and `DIST_AMOUNT` are
 * the fold of every distribution line that drew that combination, so the panel
 * can say "3 lines" without the lines themselves travelling.
 */
interface RawInvoiceAccount {
  INVOICE_ID: number;
  CODE_COMBINATION_ID: number;
  SEGMENT1: string | null;
  SEGMENT2: string | null;
  SEGMENT3: string | null;
  SEGMENT4: string | null;
  SEGMENT5: string | null;
  SEGMENT6: string | null;
  SEGMENT7: string | null;
  ACCOUNT_TYPE: string | null;
  /** `'Y'` / `'N'` — whether this account is inside the extract's scope. */
  IN_SCOPE?: string | null;
  DIST_ROWS: number | string;
  DIST_AMOUNT: number | string;
}

/**
 * `.scope` — the rule the file was narrowed by, in the file's own words.
 *
 * Optional so that a pre-scope extract still loads; when it is absent the page
 * says nothing about a scope rather than inventing one.
 */
export interface RawInvoiceScope {
  fund?: string | null;
  programs?: string[] | null;
  label?: string | null;
  windowInvoices?: number | string | null;
  inScope?: number | string | null;
  inScopeValue?: number | string | null;
  excluded?: number | string | null;
  excludedValue?: number | string | null;
  unanswerable?: number | string | null;
  unanswerableValue?: number | string | null;
  accountsOffScope?: number | string | null;
  accountsOffScopeValue?: number | string | null;
  accountsOffScopeInvoices?: number | string | null;
}

import { readTrace, sqlUrl } from './sqlTrace';
import type { SqlTrace } from '../components/SqlNote';

export interface InvoicesEnvelope {
  body: {
    ResultSets: {
      Table1: RawInvoice[];
      Table2: RawInvoiceCheckLink[];
      /** Absent on an extract written before the account grain was added. */
      Table3?: RawInvoiceAccount[];
    };
  };
  /**
   * The window the register covers.
   *
   * ★ OPTIONAL NOW THAT THE ROUTE SERVES IT, BECAUSE THE ROUTE'S `to` IS EMPTY BY DESIGN. The live
   *   read runs from the fiscal year's July start to the present, so there is no end date to state
   *   — the loader takes `to` from the newest invoice it actually received. See the note at the
   *   read site.
   */
  window?: { from: string; to: string; fiscalYear: number };
  /** Absent on an extract written before the register was narrowed. */
  scope?: RawInvoiceScope;
  /** Absent on an extract written before the purchase order was read. */
  po?: RawPoCoverage;
}

/**
 * `.po.register` — the purchase-order register **file** this extract was measured
 * against, as it stood when the extract was written.
 *
 * ★ THE PAGE NO LONGER READS THIS, AND THAT IS THE FIX RATHER THAN AN OVERSIGHT.
 *   It describes the register the *pull* compared against — the frozen 2,782-line
 *   file — while every order link on the page opens the **live ledger**, which holds
 *   31,670 rows. Dating a claim does not make it a claim about the right document:
 *   the stamp below was accurate and the comparison was still against the wrong
 *   register, which is why 48 invoices were reported as naming an order nothing could
 *   open. `PoRegister` is the replacement — the same kind of description, read from
 *   the document the links actually open. This one is kept so the file's own
 *   fingerprint is typed rather than understood, and so a reader can see exactly
 *   which register each number came from.
 */
export interface RawPoRegister {
  /** Lines in the register file. 2,782. */
  lines?: number | string | null;
  /** Distinct `ORDER_NUMBER` values. 742. */
  orders?: number | string | null;
  /** Newest `ORDER_DATE` in the register. `2026-08-06`. */
  maxDate?: string | null;
  /** The register's own scope — the file's, not the app's. See the note above. */
  fund?: string[] | null;
  program?: string[] | null;
  costCenters?: string[] | null;
}

/**
 * `.po` — what `Table1`'s `PO_NUMBER` covers, and what the register beside the
 * file can actually open.
 *
 * Optional so a pre-order extract still loads; the page then shows the number
 * without offering a link and without making a claim, rather than asserting that
 * an unmeasured order is missing.
 */
export interface RawPoCoverage {
  /** Invoices that name an order, and what they are worth. */
  named?: number | string | null;
  namedValue?: number | string | null;
  /** Invoices that name none — a real answer: prepaid cards, travel, use tax. */
  notNamed?: number | string | null;
  notNamedValue?: number | string | null;
  /** The most orders any one invoice names. 1 on this extract. */
  maxPerInvoice?: number | string | null;
  /** Invoices naming more than one. 0 — and a non-zero would void `PO_NUMBER`. */
  invoicesWithMore?: number | string | null;
  distinctNumbers?: number | string | null;
  /**
   * ★ NONE OF THE REGISTER-SIDE FIELDS BELOW IS READ ANY MORE, AND THEY ARE KEPT
   *   HERE ON PURPOSE TO SAY SO.
   *
   *   They are the pull's answer to "how much of the register holds these orders",
   *   measured against the **frozen file on disk** — 2,782 rows, one school's orders.
   *   The page's links open the **live ledger**, 31,670 rows. So the block was true
   *   about the file and false about the app: it marked 48 named invoices as
   *   unopenable when every one of their orders is in the register the reader can
   *   open. Deleting these from the interface would delete the evidence that the file
   *   still carries them; the page compares against the served register at load time
   *   instead (`loadOrderRegister`), and the block below decides nothing.
   */
  invoicesInRegister?: number | string | null;
  invoicesInRegisterValue?: number | string | null;
  invoicesNotInRegister?: number | string | null;
  invoicesNotInRegisterValue?: number | string | null;
  numbersInRegister?: number | string | null;
  numbersNotInRegister?: number | string | null;
  absentFromRegister?: string[] | null;
  /** The largest invoice naming no order — recounted from `Table1`, not read. */
  largestNotNamed?: { number?: string | null; value?: number | string | null; invoiceId?: number | null } | null;
  register?: RawPoRegister | null;
}

/** One check that paid an invoice. */
export interface InvoiceCheck {
  /** `CHECK_ID` — the key, because `CHECK_NUMBER` is not unique. */
  id: number;
  number: string;
  date: string;
  /** The check's own amount for the whole payment, NOT this invoice's share. */
  amount: number;
  /**
   * Whether the check falls inside the invoice window.
   *
   * 31 links do not: invoices posted 2026-07-01 were settled by checks issued in
   * June 2026. Hiding those checks would make 30 paid invoices look unpaid, which
   * is a worse lie than showing a check from the year before — so they are kept
   * and labelled.
   */
  inWindow: boolean;
}

/** One GL account an invoice is booked to, and how much of it went there. */
export interface InvoiceAccount {
  /** `CODE_COMBINATION_ID`. Stable across invoices — this is what a filter matches. */
  id: number;
  /** The assembled key: `SEGMENT1-SEGMENT2-…-SEGMENT7`. 21–29 characters. */
  code: string;
  /** The seven segments in order, so the panel can label each one. */
  segments: string[];
  /**
   * `ACCOUNT_TYPE` — `E` expense, `A` asset, `L` liability, or `''` if the view
   * had none. Carried rather than assumed: 1,003 of these rows are asset accounts
   * and 1,150 are liability, so "expense" is not a safe default.
   */
  type: string;
  /**
   * Whether this account is inside the register's scope.
   *
   * Two kept invoices also draw an account outside Fund 04 / program 861-863.
   * Those rows are `false` and stay in `accounts` regardless — the invoice is in
   * scope and its accounts must still sum to its amount, or the reconciliation
   * check reports a fault that is not one. The page marks them; it never hides
   * them.
   */
  inScope: boolean;
  /** Sum of every distribution line that drew this combination. */
  amount: number;
  /** How many distribution lines that was. */
  lines: number;
}

export interface Invoice {
  /** `INVOICE_ID`. The row key — the NUMBER is not one. */
  id: number;
  number: string;
  vendor: string;
  date: string;
  amount: number;
  description: string;
  /** `PAYMENT_STATUS_FLAG === 'Y'`. The view's opinion, which is not the link. */
  accounted: boolean;
  /** `AMOUNT_PAID`, or `null` for "not recorded". Never coerced to 0. */
  paid: number | null;
  /** The checks that settled it. Empty is a real answer, not missing data. */
  checks: InvoiceCheck[];
  /** `amount < 0`. The ONLY credit signal this view carries — see below. */
  credited: boolean;
  /** A check dated before the invoice. True on 30 rows and worth saying out loud. */
  paidEarly: boolean;
  /**
   * The GL accounts this invoice is booked to, biggest first, in-scope first.
   * Empty is a real answer — but not one the register can hold any more: an
   * invoice with no distribution has no Fund or Program to test, so the
   * extract's scope excludes it before it is ever written. The loader still
   * drops and counts such a row, because "no account" is a state and not a
   * missing value, and silently rendering one with a blank Account column would
   * be exactly the lie the drop is meant to avoid.
   */
  accounts: InvoiceAccount[];
  /** Sum of `accounts[].amount`. On the current extract this equals `amount` on all 126 rows. */
  accountsTotal: number;
  /**
   * `accounts` is non-empty and does NOT sum to `amount`. Zero rows in the
   * Fund 04 slice, measured — but it was two rows in the unscoped window, so the
   * check stays and the page still shows both figures rather than picking one.
   */
  accountsDisagree: boolean;
  /**
   * The purchase order's number, or `null` when the invoice names none.
   *
   * ★ `null` IS AN ANSWER HERE, NOT A GAP. 16 of the 126 in-scope invoices name
   *   no order — prepaid cards, travel reimbursements, use tax, standing charges
   *   — and they are not small change: one of them is $693,915.13. The order is
   *   on the invoice LINE, not the header (the header's `PO_HEADER_ID` is NULL on
   *   every row of the view), so what this field holds is the number the lines
   *   agree on.
   */
  poNumber: string | null;
  /**
   * How many distinct orders the invoice names. 0 or 1 on this extract, and
   * asserted upstream: above 1, `poNumber` is a `MAX()` that chose.
   */
  poCount: number;
  /**
   * Whether the register this page links to holds this order — **`null` when that
   * cannot be said**.
   *
   * ★ THREE STATES, NOT TWO. `false` means the register was read and does not hold
   *   the order, so the page can state a real miss. `null` means the register could
   *   not be read at all, so the page knows an order number and nothing else — and
   *   must therefore offer no link and claim nothing. Collapsing `null` into `false`
   *   would libel the register: it would report orders as absent without having
   *   looked.
   *
   * ★ THE ANSWER IS COMPUTED WHEN THE PAGE LOADS, AGAINST THE LIVE LEDGER. It used
   *   to be read out of a list of misses shipped inside `invoices.json`, and that list
   *   had been measured against the frozen 2,782-line register file rather than the
   *   31,670-row ledger the links open — so every one of the 39 numbers it called
   *   absent was in fact present, and 48 invoices were denied a link that would have
   *   worked. The number is now looked up in the register the row's own link opens,
   *   which is the only property that makes `false` mean what the page says it means.
   */
  poInRegister: boolean | null;
}

/**
 * The rule `invoices.json` was narrowed by, read from the file rather than
 * assumed here.
 *
 * ★ Without this the page could only say "invoices" about a register that is in
 * fact a **fifth of a percent of the window's count but 5.7% of its value** —
 * 126 invoices against 3,736, and $5.65M against $99.87M. A number with no
 * denominator is the most misleading thing a dashboard can print.
 */
export interface InvoiceScope {
  /** e.g. `Fund 04 · program 861/862/863`. `''` when nothing was applied. */
  label: string;
  /** Segment 1. `''` when nothing was applied. */
  fund: string;
  /** Segment 3 values kept. Empty when nothing was applied. */
  programs: string[];
  /** Every invoice in the fiscal window, before the scope. 3,736. */
  windowInvoices: number;
  /** What the file holds. Equals `invoices.length`, and is asserted so upstream. */
  kept: number;
  keptValue: number;
  /**
   * Has distributions, none of them in scope. A genuine exclusion — 3,584
   * invoices and $94,189,128.88, measured.
   */
  excluded: number;
  excludedValue: number;
  /**
   * No distribution at all, so there is no Fund and no Program to test.
   * 26 invoices, $28,565.26 — and **the only two real-money invoices in the
   * window are in this bucket**. Deliberately NOT counted as an exclusion: the
   * register cannot answer the question, which is a different sentence from the
   * scope having removed them.
   */
  unanswerable: number;
  unanswerableValue: number;
  /**
   * Accounts on invoices the file KEPT that are themselves out of scope. 2 rows
   * across 2 invoices, $243.15 — kept on purpose, so the accounts still sum.
   */
  accountsOffScope: number;
  accountsOffScopeValue: number;
  accountsOffScopeInvoices: number;
  /**
   * Whether a scope was actually declared by the file. `false` means an extract
   * written before the register was narrowed, and the page then says nothing
   * about a scope instead of inventing one.
   */
  applied: boolean;
}

/**
 * The order register the invoices were compared against.
 *
 * ★ IT DESCRIBED THE FILE AND NOW DESCRIBES THE REGISTER THE PAGE SERVES, BECAUSE
 *   THE COMPARISON MOVED. Every field is read from the same `source` block
 *   `/api/extract/current` returns, so the sentence the panel prints about the
 *   register — fund, program, order count, newest date — describes the document the
 *   links beside it actually open. A page that links into one register while
 *   describing another is the defect, written down as a data shape.
 *
 * ★ NO COST CENTRE, DELIBERATELY. The old shape carried one because the file it
 *   described was narrowed to `0840`. The served register is not: it is fund 04
 *   across programs 861/862 with no cost-centre slice, so carrying the file's cost
 *   centre here would put a narrowing into a sentence about a register that has none.
 */
export interface PoRegister {
  /** `oracle` = the live ledger. `file` = the frozen extract, served in local mode. */
  kind: 'oracle' | 'file';
  /** The store that answered, as the API labels it. `''` if it did not say. */
  label: string;
  /** ISO instant the register was read. Up to one ten-minute cache window old. */
  generatedAt: string;
  /** True when the number list came from the server's in-process cache. */
  cached: boolean;
  /** Distinct orders it holds. 5,692 on the live ledger. */
  orders: number;
  /** Rows it holds. 31,670 on the live ledger — more than lines, see `/current`. */
  rows: number;
  /** Distinct order/line pairs it implies. 31,401 on the live ledger. */
  lines: number;
  /** Earliest order date, `YYYY-MM-DD`. `''` when no row carried one. */
  minDate: string;
  /** Its newest order date, `YYYY-MM-DD`. `''` when no row carried one. */
  maxDate: string;
  /** The distinct funds its rows carry. `['04']`. */
  fund: string[];
  /** The distinct programs its rows carry. `['861','862']` — 863 holds no rows. */
  program: string[];
}

/**
 * What the extract's `PO_NUMBER` covers, measured against the register the app
 * serves *now*.
 *
 * ★ THE SECOND HALF IS A LOAD-TIME COMPARISON, AND IT USED TO BE A NUMBER SHIPPED
 *   INSIDE THE FILE — WHICH IS THE DEFECT THIS BLOCK FIXES. The extract carried a
 *   list of the order numbers its own frozen register did not hold, and the page
 *   turned that list into "not in this app's order register". The links open the
 *   live ledger: 31,670 rows against the file's 2,782. Every one of the 39 numbers
 *   that list called absent is in the register the app serves, so all 48 invoices it
 *   marked unopenable could have been opened. The comparison now runs against the
 *   register as served, which is what makes printing its two halves side by side —
 *   "this invoice names an order" and "this app can open that order" — honest.
 */
export interface PoCoverage {
  /** Invoices naming an order, and their value. 110 · $4,921,015.73. */
  named: number;
  namedValue: number;
  /** Invoices naming none, and their value. 16 · $729,316.93 — a real answer. */
  notNamed: number;
  notNamedValue: number;
  /** The most orders any one invoice names. 1. */
  maxPerInvoice: number;
  /** Invoices naming more than one. 0, and above 0 `poNumber` is a `MAX()`. */
  invoicesWithMore: number;
  /** Distinct order numbers the named invoices reference. 88. */
  distinctNumbers: number;
  /**
   * Named invoices the served register holds, and their value.
   *
   * ★ 110 · $4,921,015.73 — EVERY ONE, counted against the live ledger. Read this
   *   beside `named`: `inRegister + notInRegister === named` by construction, so if
   *   that identity ever fails, the comparison is broken rather than the register.
   */
  inRegister: number;
  inRegisterValue: number;
  /** Named invoices it does not, and their value. 0 · $0.00 on the live ledger. */
  notInRegister: number;
  notInRegisterValue: number;
  /**
   * ORDER NUMBERS, not invoices: how many of the 88 the served register holds, and
   * how many it does not. Named separately because 110 and 88 are both true and a
   * bare "count" would be read as whichever one the reader had in mind.
   */
  numbersInRegister: number;
  numbersNotInRegister: number;
  /**
   * The order numbers the served register does not hold — the evidence behind
   * `poInRegister === false` on the rows, in one place.
   *
   * ★ THE PAGE DOES NOT READ IT, AND IT IS KEPT ANYWAY. Each row already carries its
   *   own answer, so the render path never looks here; the set is the whole miss list
   *   in one object, which is what a future "all of them" view or an export would want
   *   and what a check can assert against. Empty on the live ledger — see `PoCoverage`
   *   on why it is empty when the file's equivalent list held 39.
   */
  absent: ReadonlySet<string>;
  /**
   * The largest invoice naming no order, or `null` when every one names one.
   *
   * ★ RECOUNTED FROM THE ROWS, NOT CARRIED FROM THE FILE. "16 invoices name no
   *   order" reads like small change until one of them is $693,915.13 — the figure
   *   is real and belongs to a row in this extract, so the panel names it exactly
   *   rather than typing it into prose where it would go stale unannounced. The
   *   recount follows the rule `scope.accountsOffScope` already follows: a file whose
   *   block disagreed with its own rows should show the rows.
   */
  largestNotNamed: { number: string; value: number; invoiceId: number } | null;
  /**
   * The register the comparison ran against, described. Non-null whenever `po` is —
   * a register that could not be read produces no coverage block at all, which is how
   * the page knows to make no claim rather than to make a pessimistic one.
   */
  register: PoRegister;
  /** Always `true`. `po` itself is `null` when the register could not be read. */
  applied: boolean;
}

export interface InvoicesExtract {
  /** Newest first. */
  invoices: Invoice[];
  /** The fiscal year the pull was bounded to, carried on the file itself. */
  window: { from: string; to: string; fiscalYear: number };
  /** The dates actually present, which are narrower than the bound. */
  observed: { from: string; to: string };
  links: number;
  /** Invoices with a negative amount. */
  credits: number;
  creditTotal: number;
  /** No check at all. */
  unpaid: number;
  /** Flag says `N`, a check exists. The flag under-claims on these. */
  understated: number;
  /** Flag says `Y`, no check exists. Measured 0, kept so a change would show. */
  overstated: number;
  /** `AMOUNT_PAID` is NULL — distinct from `AMOUNT_PAID = 0`. */
  notRecorded: number;
  /** Links pointing at a check issued before the window. */
  priorYearLinks: number;
  /** Total (invoice, account) rows in `Table3`. */
  accountRows: number;
  /** Distinct `CODE_COMBINATION_ID` across the file — 71 measured in scope. */
  combinations: number;
  /** Of those, the ones inside the scope. The rest belong to kept invoices. */
  combinationsInScope: number;
  /** Invoices the file held that had no distribution, and were therefore dropped. */
  noAccount: number;
  /** The value of those invoices, so a $0 gap and a $23k gap are distinguishable. */
  noAccountValue: number;
  /** Invoices whose accounts do not sum to the invoice amount. 0 measured in scope. */
  accountsDiffer: number;
  /** What the register is a slice of, and what the slice cost. Never assumed. */
  scope: InvoiceScope;
  /**
   * The order's coverage, measured against the register this page links to.
   *
   * `null` is a real state — the register could not be read, or an extract written
   * before orders were pulled — and the page must then say nothing about a register
   * rather than assume the worst of every order number it can see.
   */
  po: PoCoverage | null;
  /**
   * The statements the server ran, when the reader has the SQL trace switched on.
   *
   * ★ THE REGISTER IS READ LIVE, SO THERE IS A STATEMENT BEHIND EVERY FIGURE. Four of them: the
   *   `GL_PERIODS` read that derives the window, the invoices query, the payment links, and the
   *   account rows. `null` with the toggle off, which is the ordinary case.
   */
  traces: SqlTrace | null;
}

/**
 * The live ledger route. There is no file fallback.
 *
 * ★ IT USED TO READ `/oracle/invoices.json`, and the swap needed a server change rather than a URL
 *   change: the live route returned `Table2: []` **hard-coded**, and on this page `Table2` is the
 *   payment links that the "checks that settled it" panel is built from. An empty array there is
 *   not a neutral placeholder — the panel renders it as *"no check settles this invoice"*, which is
 *   a claim about the ledger made from a constant. The route now runs the link query, scoped to the
 *   invoice ids `Table1` returned, so the two result sets cannot describe different populations.
 *
 * ★ `IN_SCOPE` IS NOW DERIVED BY THE SERVER RATHER THAN STORED IN THE FILE. The frozen extract
 *   carried it as a flag written by the pull script; the live route computes it from the same
 *   predicate it filters by, which is what stops the flag and the filter from disagreeing.
 */
const URL = '/api/ap/invoices';

/**
 * The register's order numbers, from the route that serves them.
 *
 * ★ NOT READ OUT OF THIS EXTRACT FILE, WHICH IS THE POINT OF THE ROUTE EXISTING.
 *   The file's own list of misses was measured against a firmer copy of the register
 *   than the one the links open; asking the same route the register page asks is what
 *   makes the two agree by construction rather than by review.
 */
const REGISTER_URL = '/api/extract/order-numbers';

/** A figure, or 0 — never `NaN`. One bad row must not poison a whole column. */
const figure = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** A figure, or `null` for absent. Absent is not zero. */
const optional = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Trimmed text, or `''`. */
const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

/**
 * `/api/extract/order-numbers` as it arrives.
 *
 * ★ IT ARRIVES UNDER `data`, BECAUSE THIS ROUTE DOES NOT SET `rawBody`.
 *   `/api/extract/current` opts out of the framework's `{ data }` envelope because it
 *   has to reproduce the frozen export's own `body.ResultSets` shape byte for byte;
 *   every other route in this API — including this one — is wrapped. Reading the
 *   unwrapped shape is not a cosmetic mistake: every field resolves to `undefined`,
 *   `readRegister` returns `null`, and the page quietly reports **every** order as
 *   "not yet compared" while answering HTTP 200. That is a silent total loss of the
 *   feature behind a green status, which is exactly the failure this page has now been
 *   through twice, so the envelope is a named type rather than an inline cast.
 *
 * Deliberately loose — every field optional — because this is a network payload and
 * the loader's job is to decide what it can use rather than to trust a shape. Only the
 * fields this page reads are declared; `source` is the same block
 * `/api/extract/current` returns, which is what lets the panel describe the register
 * it compared against instead of merely naming it.
 */
interface RawOrderNumbers {
  source?: {
    kind?: string;
    label?: string;
    generatedAt?: string;
    cached?: boolean;
    rows?: number;
    orders?: number;
    lines?: number;
    observed?: {
      funds?: unknown;
      programs?: unknown;
      earliestOrderDate?: unknown;
      latestOrderDate?: unknown;
    } | null;
  } | null;
  count?: number;
  numbers?: unknown;
}

/** The framework's envelope, named so the unwrapping below is not a bare `.data`. */
interface OrderNumbersEnvelope {
  data?: RawOrderNumbers | null;
}

/** The register's numbers, and the register they came from. */
interface OrderRegisterLookup {
  /** Every order number the register holds, trimmed; blanks dropped. */
  numbers: ReadonlySet<string>;
  /** What the register says about itself. */
  register: PoRegister;
}

/**
 * The register's own description, out of the endpoint's `source` block.
 *
 * `null` when the payload carries no `source`, which is the signal that this is not
 * the document the page thinks it fetched. The numbers alone would be enough to
 * *compare* with, but not enough to *describe* the comparison — and a page that cannot
 * name the register it compared against is back to making an unattributable claim,
 * which is the defect this whole path exists to close.
 */
function readRegister(raw: RawOrderNumbers | null): PoRegister | null {
  const s = raw?.source;
  if (s === null || s === undefined) return null;
  const observed = s.observed;
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(text).filter(Boolean) : []);
  return {
    // Anything that is not the ledger is reported as the frozen file, because
    // describing a file as a live database is the more damaging of the two mistakes.
    kind: s.kind === 'oracle' ? 'oracle' : 'file',
    label: text(s.label),
    generatedAt: text(s.generatedAt),
    cached: s.cached === true,
    orders: figure(s.orders),
    rows: figure(s.rows),
    lines: figure(s.lines),
    minDate: text(observed?.earliestOrderDate).slice(0, 10),
    maxDate: text(observed?.latestOrderDate).slice(0, 10),
    fund: list(observed?.funds),
    program: list(observed?.programs),
  };
}

/**
 * The order numbers the app's own purchase-order register serves, or `null`.
 *
 * ★ THIS REPLACES A LIST OF *MISSES* THAT SHIPPED INSIDE THE EXTRACT, AND THE
 *   REPLACEMENT IS THE POINT. The extract carried `absentFromRegister` — the numbers
 *   its own frozen register did not hold — and the page turned that into "not in this
 *   app's order register" while the link beside it opened the live ledger. The file's
 *   register is 2,782 lines of one school's orders; the ledger's is 31,670 rows across
 *   fund 04 and programs 861/862. Not one of the 39 numbers that list called absent is
 *   missing from the register the app serves, so the page was denying 48 invoices an
 *   order it could have opened in the next tab.
 *
 * ★ FETCHED RATHER THAN DERIVED FROM THE EXTRACT, BECAUSE THE REGISTER IS LIVE.
 *   Rebuilding the list from `invoices.json` would repeat the mistake in a different
 *   place: that file is a cache of the ledger, and a cached answer to "what is in the
 *   register" stops being true the moment the ledger moves.
 *
 * ★ A FAILURE HERE IS NOT A FAILURE OF THE PAGE. `null` propagates to
 *   `poInRegister = null` on every row — the field's third state — so the page prints
 *   each order number with no link and no claim about the register, rather than
 *   reporting every order as missing. That is the difference the three-valued field
 *   exists for, and this is the path that exercises it.
 */
async function loadOrderRegister(signal?: AbortSignal): Promise<OrderRegisterLookup | null> {
  try {
    const res = await fetch(REGISTER_URL, { signal });
    if (!res.ok) return null;
    // ★ `.data` IS NOT DECORATION — see the note on `RawOrderNumbers`. This route is
    //   enveloped, so a reader that looks at the top level sees a body with no
    //   `numbers` and no `source` and answers `null` with a 200 in hand.
    const raw = ((await res.json()) as OrderNumbersEnvelope).data ?? null;
    const register = readRegister(raw);
    if (register === null || !Array.isArray(raw?.numbers)) return null;
    // A blank is not an order — dropped, so `has('')` can never be true. That makes
    // this set's size a floor on the endpoint's `count`, which counts every distinct
    // `ORDER_NUMBER` including a blank if the ledger holds one.
    return { numbers: new Set(raw.numbers.map(text).filter(Boolean)), register };
  } catch (e) {
    // An abort is the caller's own cancellation and must not be swallowed: returning
    // `null` would let the loader resolve a half-built extract after the component
    // unmounted, which React would then warn about rather than the abort being seen.
    if (signal?.aborted) throw e;
    return null;
  }
}

export async function loadInvoices(signal?: AbortSignal): Promise<InvoicesExtract> {
  // ★ BOTH REQUESTS START TOGETHER, AND THE REGISTER'S FAILURE IS NOT THE PAGE'S.
  //   The register list is ~60 KB against the ledger payload's ~11 MB, so it is not a request
  //   worth serialising behind the other — and `loadOrderRegister` answers `null`
  //   instead of throwing, so a register that is down still renders the invoices.
  const [res, lookup] = await Promise.all([fetch(sqlUrl(URL), { signal }), loadOrderRegister(signal)]);
  if (!res.ok) {
    /**
     * ★ THE REFUSAL NAMES THE LEDGER, BECAUSE THAT IS NOW THE ONLY SOURCE.
     *
     *   This used to fall back to `invoices.json`. That file is a snapshot, so a fallback would
     *   have shown a reader a *different* register under a heading describing the live one — and
     *   on this page the difference is not cosmetic: the file's `Table2` carried 117 payment links
     *   and the live route's now carries its own, so the two would disagree about which invoices
     *   were ever paid. A failure that says so beats a page that quietly answers from a stale copy.
     */
    let detail = `HTTP ${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = body.error.message;
    } catch {
      /* The status line stands. */
    }
    throw new Error(
      `The invoice register could not be read from the ledger (${detail}). This page reads Oracle ` +
        `directly and has no snapshot to fall back to.`,
    );
  }

  const envelope = (await res.json()) as InvoicesEnvelope;
  const table1 = envelope?.body?.ResultSets?.Table1;
  const table2 = envelope?.body?.ResultSets?.Table2;
  if (!Array.isArray(table1)) {
    throw new Error(`${URL} has no body.ResultSets.Table1 array.`);
  }
  const links = Array.isArray(table2) ? table2 : [];
  const table3 = Array.isArray(envelope?.body?.ResultSets?.Table3) ? envelope.body.ResultSets.Table3 : [];

  // ★ WHETHER THE FILE CARRIED A COVERAGE BLOCK, WHICH NOW ONLY DECIDES WHETHER AN
  //   OLD EXTRACT GETS AN ORDER COLUMN AT ALL. It used to decide the register side of
  //   every row; that decision is `lookup` below, and it is made against the register
  //   the row's own link opens. See `RawPoCoverage` on why the file's `po` block is
  //   still read at all when it no longer decides anything.
  const poRaw = envelope?.po;
  const poApplied = !!poRaw;

  // ★ THE WINDOW COMES FROM THE SERVER'S BLOCK, AND FALLS BACK TO THE ROWS THEMSELVES.
  //
  //   The frozen file declared its window; the live route declares `from` (the fiscal year's own
  //   July start, derived from `GL_PERIODS`) and leaves `to` empty, because the window has no end
  //   — it runs to the present. So `to` is taken from the newest invoice actually returned, which
  //   is the same thing the page means by it and cannot disagree with the rows on screen.
  //
  //   An absent window marks nothing as out of window, which is the existing behaviour and the
  //   safe direction: a badge that says "before the window" must never fire on a guess.
  const rawWindow = envelope?.window ?? null;
  const observedDates = table1.map((r) => text(r.INVOICE_DATE).slice(0, 10)).filter(Boolean).sort();
  const window = {
    from: rawWindow?.from || observedDates[0] || '',
    to: rawWindow?.to || observedDates[observedDates.length - 1] || '',
    fiscalYear: rawWindow?.fiscalYear ?? 0,
  };
  const inside = (d: string) => !!window.from && d >= window.from && d <= window.to;

  // One pass to group the links, mirroring `checks.ts`: the panel opens per row,
  // and re-scanning 3,678 links for each of 3,736 rows is work the table would
  // otherwise repeat on every keystroke in the filter box.
  const byInvoice = new Map<number, InvoiceCheck[]>();
  let priorYearLinks = 0;
  for (const l of links) {
    const check: InvoiceCheck = {
      id: l.CHECK_ID,
      number: text(l.CHECK_NUMBER),
      date: text(l.CHECK_DATE).slice(0, 10),
      amount: figure(l.CHECK_AMOUNT),
      inWindow: inside(text(l.CHECK_DATE).slice(0, 10)),
    };
    if (!check.inWindow) priorYearLinks += 1;
    const list = byInvoice.get(l.INVOICE_ID);
    if (list) list.push(check);
    else byInvoice.set(l.INVOICE_ID, [check]);
  }

  // The same single pass for the accounts, keyed on the pair. The extract already
  // grouped the distribution lines, so a repeated (invoice, combination) here
  // would mean the envelope was hand-edited; the amounts are summed anyway, which
  // either way leaves the row's figure correct.
  const accountsByInvoice = new Map<number, InvoiceAccount[]>();
  const combinations = new Set<number>();
  const combinationsInScope = new Set<number>();
  let accountsOffScope = 0;
  let accountsOffScopeValue = 0;
  const offScopeInvoices = new Set<number>();
  for (const a of table3) {
    const segments = [a.SEGMENT1, a.SEGMENT2, a.SEGMENT3, a.SEGMENT4, a.SEGMENT5, a.SEGMENT6, a.SEGMENT7].map(text);
    // Only an explicit 'N' is out of scope. An absent flag means an extract that
    // predates the scope, where nothing was marked and nothing should be struck
    // out — defaulting the other way would paint every account on the page as
    // out of scope the moment an older file is served.
    const inScope = a.IN_SCOPE !== 'N';
    const account: InvoiceAccount = {
      id: a.CODE_COMBINATION_ID,
      code: segments.join('-'),
      segments,
      type: text(a.ACCOUNT_TYPE),
      inScope,
      amount: figure(a.DIST_AMOUNT),
      lines: figure(a.DIST_ROWS),
    };
    combinations.add(a.CODE_COMBINATION_ID);
    if (inScope) combinationsInScope.add(a.CODE_COMBINATION_ID);
    else {
      accountsOffScope += 1;
      accountsOffScopeValue += account.amount;
      offScopeInvoices.add(a.INVOICE_ID);
    }
    const existing = accountsByInvoice.get(a.INVOICE_ID);
    if (existing) existing.push(account);
    else accountsByInvoice.set(a.INVOICE_ID, [account]);
  }

  let credits = 0;
  let creditTotal = 0;
  let unpaid = 0;
  let understated = 0;
  let overstated = 0;
  let notRecorded = 0;
  let noAccount = 0;
  let noAccountValue = 0;
  let accountsDiffer = 0;

  const invoices: Invoice[] = table1.map((r) => {
    const checks = byInvoice.get(r.INVOICE_ID) ?? [];
    // Biggest account first: an invoice booked 90% to one account and 10% to
    // another should read that way, and the file arrives ordered by id.
    const accounts = (accountsByInvoice.get(r.INVOICE_ID) ?? []).slice().sort((a, b) => {
      // In-scope first, so the fund-04 accounts of a mixed invoice are the ones
      // the eye lands on and the out-of-scope remainder reads as the tail it is.
      if (a.inScope !== b.inScope) return a.inScope ? -1 : 1;
      if (a.amount !== b.amount) return Math.abs(b.amount) - Math.abs(a.amount);
      return a.id - b.id;
    });
    const accountTotal = accounts.reduce((s, a) => s + a.amount, 0);
    const amount = figure(r.INVOICE_AMOUNT);
    const accounted = r.PAYMENT_STATUS_FLAG === 'Y';
    const paid = optional(r.AMOUNT_PAID);
    const date = text(r.INVOICE_DATE).slice(0, 10);
    // `''` → `null`: a blank number is not an order, and it must not render as
    // one. `text()` already trims, so a padded " 283929 " matches the register.
    const poNumber = text(r.PO_NUMBER) || null;

    if (amount < 0) {
      credits += 1;
      creditTotal += amount;
    }
    if (paid === null) notRecorded += 1;
    if (checks.length === 0) unpaid += 1;
    // The two disagreements, counted separately: the flag saying no when a check
    // exists is not the same fault as it saying yes when none does.
    if (!accounted && checks.length > 0) understated += 1;
    if (accounted && checks.length === 0) overstated += 1;
    if (accounts.length === 0) {
      noAccount += 1;
      noAccountValue += amount;
    }
    // Half a cent, because these are floats summed from a decimal column.
    const disagrees = accounts.length > 0 && Math.abs(accountTotal - amount) >= 0.005;
    if (disagrees) accountsDiffer += 1;

    return {
      id: r.INVOICE_ID,
      number: text(r.INVOICE_NUM),
      vendor: text(r.VENDOR_NAME),
      date,
      amount,
      description: text(r.DESCRIPTION),
      accounted,
      paid,
      checks,
      credited: amount < 0,
      paidEarly: checks.some((c) => c.date < date),
      accounts,
      accountsTotal: accountTotal,
      accountsDisagree: disagrees,
      poNumber,
      poCount: figure(r.PO_COUNT),
      // ★ `null` UNTIL THE REGISTER HAS BEEN READ, AND `false` ONLY EVER FROM A
      //   REGISTER THAT WAS READ. `lookup` is the served register's number list, so
      //   membership in it is the only thing that can justify claiming a miss. Both
      //   sides are trimmed — `text()` here, `text()` on the way into the set — so a
      //   padded value on either side cannot manufacture one that does not exist.
      poInRegister: lookup !== null && poNumber !== null ? lookup.numbers.has(poNumber) : null,
    };
  });

  // ★ An invoice with no account is DROPPED, and the drop is counted rather than
  // silent. It has no Fund and no Program, which means the register literally
  // cannot say whether it belongs — so it is not "outside the scope", it is
  // unanswerable, and the page says so in those words while this number carries
  // the weight. `noAccount`/`noAccountValue` above are counted before the drop so
  // the note can state what left rather than merely that something did.
  //
  // On the current extract this removes nothing: the scope is applied in SQL and
  // every invoice it keeps has a distribution. It is here so that an unscoped
  // file — or a scope that changes — cannot put a blank Account column in front
  // of a reader and leave them to assume the account is merely missing.
  const kept = invoices.filter((i) => i.accounts.length > 0);

  // Newest first, and then by amount — because 2,990 of the unscoped window's
  // invoices shared the single date 2026-07-01, so a date-only sort leaves the
  // tail of the table in whatever order the file happened to hold. Amount puts
  // the ones a reader is looking for at the top of the run.
  kept.sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    if (a.amount !== b.amount) return b.amount - a.amount;
    return b.id - a.id;
  });

  const dates = kept.map((i) => i.date).filter(Boolean).sort();

  // The scope as the file declares it. Every field falls back rather than
  // throwing, because a missing scope is a real state (an older extract) and the
  // page must degrade to saying nothing rather than to saying something false.
  const raw = envelope?.scope;
  const programs = Array.isArray(raw?.programs) ? raw!.programs!.map(text).filter(Boolean) : [];
  const fund = text(raw?.fund);
  const scoped = !!raw && (!!fund || programs.length > 0);
  const scope: InvoiceScope = {
    fund,
    programs,
    label: scoped
      ? text(raw?.label) || `Fund ${fund}${programs.length ? ` · program ${programs.join('/')}` : ''}`
      : '',
    windowInvoices: figure(raw?.windowInvoices),
    // The file's own count would be the wrong number to print if the drop above
    // ever removed a row — so the kept count is stated, and the report's count is
    // what the difference is measured against.
    kept: kept.length,
    keptValue: kept.reduce((s, i) => s + i.amount, 0),
    excluded: figure(raw?.excluded),
    excludedValue: figure(raw?.excludedValue),
    unanswerable: figure(raw?.unanswerable),
    unanswerableValue: figure(raw?.unanswerableValue),
    // Recounted here from the rows actually held, so that a file whose scope
    // block disagrees with its own Table3 shows the truth rather than the claim.
    accountsOffScope,
    accountsOffScopeValue,
    accountsOffScopeInvoices: offScopeInvoices.size,
    applied: scoped,
  };

  // ★ THE ORDER'S COVERAGE, RECOUNTED FROM THE ROWS ACTUALLY HELD AND COMPARED
  //   AGAINST THE REGISTER THIS APP SERVES. The first half follows the rule the
  //   scope's `accountsOffScope` follows: a file whose coverage block disagreed with
  //   its own `Table1` should show the truth rather than the claim, and the only way
  //   to be sure of that is to count rather than copy.
  //
  //   ★ THE SECOND HALF IS THE FIX. `poInRegister` per invoice comes from the
  //   order-number list fetched above, so it is decided against the same register the
  //   row's own link opens; the aggregates below are counted from the invoices rather
  //   than copied out of the extract's `po` block. The block used to supply the
  //   register side of every one of these numbers, and it had been measured against a
  //   2,782-line file while the links open a 31,670-row ledger — see `PoCoverage`.
  let po: PoCoverage | null = null;
  const named = kept.filter((i) => i.poNumber !== null);
  // An extract written before orders were read has no `PO_NUMBER` values to speak of,
  // so every row would read "names no order" — a claim about the file made from a
  // column that is not there. `poApplied` and a non-zero `named` are the two signals
  // that there is something to compare; either one is enough, which is what lets this
  // block work for a file that predates the coverage block but whose rows do carry
  // numbers.
  if (lookup !== null && (poApplied || named.length > 0)) {
    const notNamed = kept.filter((i) => i.poNumber === null);
    const sum = (list: Invoice[]) => list.reduce((s, i) => s + i.amount, 0);
    const inRegister = named.filter((i) => i.poInRegister === true);
    const missing = named.filter((i) => i.poInRegister === false);
    // The absence list, narrowed to the numbers this file still holds. A number the
    // register lacks but no invoice names any more is not a fact about anything on the
    // page, and carrying it would inflate the stated count.
    const absent = new Set(missing.map((i) => i.poNumber as string));
    // Counted off `named`, so the two number counts cannot disagree with the invoice
    // count they sit beside: every named invoice contributes exactly one distinct
    // number to these two, one way or the other.
    const distinct = [...new Set(named.map((i) => i.poNumber as string))];
    const numbersInRegister = distinct.filter((n) => lookup.numbers.has(n)).length;
    const largest = notNamed.reduce<Invoice | null>(
      (best, i) => (best === null || i.amount > best.amount ? i : best),
      null,
    );

    po = {
      named: named.length,
      namedValue: sum(named),
      notNamed: notNamed.length,
      notNamedValue: sum(notNamed),
      maxPerInvoice: kept.reduce((m, i) => Math.max(m, i.poCount), 0),
      invoicesWithMore: kept.filter((i) => i.poCount > 1).length,
      distinctNumbers: distinct.length,
      inRegister: inRegister.length,
      inRegisterValue: sum(inRegister),
      notInRegister: missing.length,
      notInRegisterValue: sum(missing),
      numbersInRegister,
      numbersNotInRegister: distinct.length - numbersInRegister,
      absent,
      // `number` is the INVOICE's number, not the order's — the panel uses it to name
      // the one invoice that keeps the unnamed total from reading as small change.
      largestNotNamed: largest ? { number: largest.number, value: largest.amount, invoiceId: largest.id } : null,
      register: lookup.register,
      applied: true,
    };
  }

  return {
    invoices: kept,
    window,
    observed: { from: dates[0] ?? '', to: dates[dates.length - 1] ?? '' },
    links: links.length,
    credits,
    creditTotal,
    unpaid,
    understated,
    overstated,
    notRecorded,
    priorYearLinks,
    accountRows: table3.length,
    combinations: combinations.size,
    combinationsInScope: combinationsInScope.size,
    noAccount,
    noAccountValue,
    accountsDiffer,
    scope,
    po,
    traces: readTrace(envelope),
  };
}
