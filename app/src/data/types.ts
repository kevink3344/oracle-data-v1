/**
 * Domain types for the Oracle Projects slice.
 *
 * The extract is a denormalised PO-line report — one row per purchase-order line,
 * carrying both the line detail and its account combination's seven segments.
 * Everything the app displays is derived from these rows; nothing is transcribed.
 */

/** A row exactly as it arrives in `data/oracle/output.json` → `.body.ResultSets.Table1`. */
export interface RawExtractRow {
  ORDER_DATE: string;
  ORDER_NUMBER: string | number;
  BUYER_NAME: string;
  VENDOR_NAME: string;
  LINE_NUMBER: string | number;
  CANCEL_FLAG: string | null;
  ITEM_NUMBER: string | null;
  DESCRIPTION: string;
  QUANTITY: string | number | null;
  AMOUNT: string | number;
  FUND: string;
  PURPOSE: string;
  PROGRAM: string;
  OBJECT_: string;
  LEVEL_: string;
  COST_CENTER: string;
  FUTURE_USE: string;
  STATUS: string;
}

export interface ExtractEnvelope {
  body: { ResultSets: { Table1: RawExtractRow[] } };
}

/** One purchase-order line, normalised. Dates are plain `YYYY-MM-DD`. */
export interface Line {
  orderDate: string;
  orderNumber: string;
  buyer: string;
  vendor: string;
  lineNumber: string;
  itemNumber: string;
  description: string;
  quantity: number;
  amount: number;
  status: string;
}

/** A line plus the account combination it is booked to. */
export interface ExtractLine extends Line {
  fund: string;
  purpose: string;
  program: string;
  object: string;
  level: string;
  costCenter: string;
  futureUse: string;
  /** `FUND-PURPOSE-PROGRAM-OBJECT-LEVEL-COST_CENTER-FUTURE_USE`. The join key. */
  combinationKey: string;
}

export type PurposeCode = '6570' | '9000' | '6560';

export interface PurposeMeta {
  code: PurposeCode;
  label: string;
  short: string;
  /** Marker colour class for the bucket square and the mix bar segment. */
  mark: string;
  /** Chip variant suffix — `cap` / `ope` / `oth`, not the full class name. */
  chip: string;
  /** Series token used for the usage-bar segment. */
  series: string;
}

/** One OBJECT_ code used under one PURPOSE_ — the finest grain the app models. */
export interface CostCode {
  object: string;
  purpose: PurposeCode;
  /** Human label from `taxonomy.ts`, or null when the code has no known label. */
  label: string | null;
  combination: string;
  amount: number;
  lines: number;
  orders: number;
  vendors: number;
  topVendor: string;
  topVendorAmount: number;
  /** The underlying PO lines, newest first. Drives the fourth drill-down level. */
  rows: ExtractLine[];
}

/** One PURPOSE_ within a project — the "Related budgets" group. */
export interface Bucket {
  purpose: PurposeCode;
  meta: PurposeMeta;
  costCodes: CostCode[];
  committed: number;
  /** Derived placeholder, not Oracle data. See `derive.ts → allocate`. */
  approved: number;
  remaining: number;
  used: number;
  lines: number;
  orders: number;
  vendors: number;
}

/**
 * One account on a level, grouped by `OBJECT_`.
 *
 * ★ GROUPED BY OBJECT, NOT BY COMBINATION, AND THE LEVEL IS THE REASON. Level `0450`
 *   is four accounts — 526, 527, 529 and 532 — across five combinations: 529 is
 *   booked in two purposes (`6570` and `6560`), so one account has two seven-segment
 *   rows. Presenting the combination grain would show five rows for four things and
 *   split one account's money in two.
 *
 * ★ `OBJECT` IS NOT THE GRAIN ORACLE HOLDS A BUDGET AT, AND THIS COMMENT USED TO SAY IT WAS.
 *   It claimed `V_ACCOUNT_POSITION` "holds one row per level+object", which is what justified
 *   the drawer joining the ledger's budget onto this list with a single lookup. Measured on
 *   the live ledger the view is **one row per `CODE_COMBINATION_ID`** — exactly the five rows
 *   for four things described above, spanning both of 529's purposes — so a single lookup
 *   quietly dropped one and understated level 0450's WCPSS budget by **$877,819.93**.
 *   Consumers must **sum every row for an object**, the same way `lines`/`orders`/`vendors`
 *   below are summed over `combinations`. The wrong premise in this comment is what made the
 *   undercount look like a property of the data rather than a bug in the join.
 */
export interface ProjectAccount {
  /** The `OBJECT_` segment — `527`. */
  object: string;
  /** `527 · Construction, CMAR / GMP`, from `taxonomy.ts`. */
  label: string;
  /**
   * Every seven-segment combination this account's lines are booked to, sorted.
   * More than one means the account spans purposes; the length is the account count
   * a reader would see in `GL_CODE_COMBINATIONS`.
   */
  combinations: string[];
  /**
   * Lines, orders and vendors **summed over this account's combinations**, so a
   * vendor working under two purposes is counted once per combination. The app
   * labels sums like this the same way everywhere — see `BucketBlock`'s per-cost-code
   * line — because the account is a roll-up of those rows and there is no distinct
   * count of a thing that was never counted as one.
   */
  lines: number;
  orders: number;
  vendors: number;
  /** Σ PO-line amount on this account — the same measure `Project.committed` sums. */
  committed: number;
  /** `committed / Project.committed`.
   *
   *  ★ THE DENOMINATOR IS THE LEVEL, NOT THE BUDGET. Every share on this screen is a
   *    share of the project's own commitment, so the four accounts' shares add to
   *    100%. A share of Oracle's budget side would be a different number on a
   *    different denominator and is deliberately not computed here. */
  share: number;
}

export interface Project {
  level: string;
  /**
   * The display code: `CC-0450`.
   *
   * ★ IT NAMES THE LEVEL AND NOTHING ELSE. It used to be `CC-0450-527` — the level
   *   plus whichever of its accounts held the most money — and that account was then
   *   read back out of the string (`combos.ts`) to decide which combination the
   *   project had claimed. So a project bound to a level was presented, in its own
   *   code, as bound to one account of it. The level is the whole binding; the
   *   accounts are in `accounts` below.
   */
  code: string;
  name: string;
  site: string;
  owner: string;
  status: 'active' | 'dormant';
  /** Days between the last order and the extract cut-off. */
  quietDays: number;
  note: string;
  /** True while the project has no app-native name — i.e. nobody has claimed it. */
  unclaimed: boolean;
  first: string;
  last: string;
  lines: number;
  orders: number;
  vendors: number;
  committed: number;
  approved: number;
  remaining: number;
  used: number;
  capital: number;
  operating: number;
  relocation: number;
  buckets: Bucket[];
  /**
   * The level's accounts, largest committed first — see `ProjectAccount`.
   *
   * ★ THIS IS WHAT REPLACES THE ANCHOR OBJECT. Ordered by money, so the account the
   *   level is really anchored on leads the list: the fact is stated by the order,
   *   and no account has to be singled out in the project's name to state it.
   */
  accounts: ProjectAccount[];
}

export interface ExtractSummary {
  /** Latest ORDER_DATE in the extract — the reference point for activeness. */
  cutoff: string;
  rows: number;
  projects: number;
  orders: number;
  vendors: number;
  committed: number;
}
