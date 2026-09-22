/**
 * Encumbrances — the one screen where two populations are shown side by side
 * without being netted into each other.
 *
 * ── WHAT AN ENCUMBRANCE IS HERE, AND WHY THE PAGE HAS FOUR BLOCKS ───────────
 *
 * An encumbrance is a **commitment**: money promised to somebody that has not
 * been spent yet. It is not a cost and it is not a payment, and the whole reason
 * this page is separate from the purchase-order register is that summing a
 * commitment into an expenditure is the single most common way a project finance
 * screen becomes wrong while looking healthy.
 *
 * Two independent sources answer "what is encumbered", and they do not agree:
 *
 *   the purchasing side   `PO_DISTRIBUTIONS_ALL` by way of `V_ENCUMBRANCE_FROM_PO`
 *                         335 account combinations, $430,580,538.04
 *   the GL side           `GL_BALANCES` under `ACTUAL_FLAG = 'E'`, which is the
 *                         column the custom report publishes
 *                         4 accounts, $5,198,165.65
 *
 * ★ THE 335 AND THE 4 ARE NOT A TYPO AND NOT A TRUNCATION, AND NO AMOUNT OF
 *   ARITHMETIC TURNS ONE INTO THE OTHER. The purchasing extract is a **slice** —
 *   it holds one fiscal year of one system — so it cannot contain every
 *   transaction behind a report built from the ledger. The schema says so in
 *   `00-schema.sql` above the view, in words written before this screen existed:
 *
 *     *"the two WILL NOT AGREE, and the disagreement is a fact about the data
 *     rather than a bug … Keep BOTH numbers side by side. Where they differ is
 *     exactly where the slice is incomplete, and that is information rather than
 *     noise."*
 *
 *   So this module hands the caller both, plus a `DELTA` computed **only over the
 *   four accounts both sides hold**, and the screen refuses to print a single
 *   combined total. A page that showed one number here would have to pick which of
 *   two true populations to be wrong about.
 *
 * ── ★ THE FACT THIS PAGE COULD EASILY HIDE, AND DOES NOT ────────────────────
 *
 * Measured over all 2,802 rows of `PO_DISTRIBUTIONS_ALL`:
 *
 *     ENCUMBERED_FLAG = 'Y'                            2,802 of 2,802
 *     ENCUMBERED_AMOUNT = AMOUNT_ORDERED               2,802 of 2,802
 *     sum of |difference|                                     0.00
 *     AMOUNT_BILLED <> 0                                      0 rows
 *
 * The flag discriminates nothing and the "encumbered" figure is a **mirror of the
 * ordered amount** — the sample's own provenance row says why ("the extract
 * carries no separate encumbered figure for full-output rows"). Two consequences
 * this page states in prose rather than leaving a reader to discover:
 *
 *   * the purchasing total is the same $430,580,538.04 the purchase-order
 *     register already shows as *ordered*, and
 *   * *committed minus billed* is not computable here, because nothing is billed.
 *
 * `po.encumbranceMirrorsOrdered` arrives from the server so this is reported from
 * the data rather than hard-coded — the day the extract carries a real encumbered
 * figure the sentence disappears on its own.
 *
 * ── ★ BLANK IS NOT ZERO ─────────────────────────────────────────────────────
 *
 * 331 of the 335 combinations have **no GL row at all**. That is an absence from a
 * four-account extract, not a measured zero, so the server sends `null` and this
 * module keeps `number | null` all the way to the cell. It is the type that does
 * the work: `GL_ENCUMBRANCE: number` would compile perfectly and print `$0.00` on
 * a page whose whole point is that the reader must not read it that way.
 *
 * ── THE UNRESOLVED BUCKET ───────────────────────────────────────────────────
 *
 * Seven combinations carry a zero placeholder in every segment but the last and a
 * level reading `UNRESOLVED`: an order charged to an account that names no
 * project. They total **$11,511.12**, which is exactly the difference between this
 * table ($430,580,538.04) and the line-level extract ($430,569,026.92) — the
 * extract resolves accounts through the level, so it cannot carry a row whose
 * level is `UNRESOLVED`. They arrive in their own block, excluded from the
 * roll-up, because a bucket called `UNRESOLVED` at the bottom of a level list is
 * the thing every reader skips.
 */

import { inScope, type Scope } from './scope';

/** The envelope the API wraps a single object in. */
interface Single<T> {
  data: T;
}

/**
 * One account combination, with whatever each side knows about it.
 *
 * The three `IN_*`/`DELTA` members are the ones that carry the page's argument:
 * `IN_PO` is true on all 335, `IN_GL` on 4, and `DELTA` is non-null only where
 * both are true — see `overlap()`.
 */
export interface EncumbranceAccount {
  CODE_COMBINATION_ID: number;
  /** The dotted seven-segment key. Segments 1–7, `UNRESOLVED` where it is one. */
  ACCOUNT: string;
  OBJECT_CODE: string;
  LEVEL_CODE: string;
  PURPOSE_CODE: string;
  PROGRAM_CODE: string;
  FUND_CODE: string;
  /** `SUM(ENCUMBERED_AMOUNT)` for the account. Mirrors `PO_ORDERED` — see the header. */
  PO_ENCUMBERED: number;
  /** `SUM(AMOUNT_ORDERED)`. The figure the PO register already reports. */
  PO_ORDERED: number;
  /** Distribution rows behind the account. */
  PO_DISTRIBUTIONS: number;
  /** Distinct purchase orders behind the account. */
  PO_ORDERS: number;
  /** Distributions carrying a non-zero `AMOUNT_BILLED`. Zero, everywhere, here. */
  PO_BILLED_ROWS: number;
  /** ★ `null` on the 331 with no GL row. Never `0`. */
  GL_ENCUMBRANCE: number | null;
  GL_BUDGET: number | null;
  GL_ALLOCATIONS: number | null;
  GL_EXPENDITURES: number | null;
  GL_AVAILABLE_FUNDS: number | null;
  /** `GL_ENCUMBRANCE − PO_ENCUMBERED`, only where both sides hold the account. */
  DELTA: number | null;
  IN_PO: boolean;
  IN_GL: boolean;
}

/**
 * One project level, rolled up.
 *
 * `PO_ORDERS` is counted **distinctly at the level** by the server, not summed
 * from the accounts above: an order charged to two accounts under one project
 * would otherwise be counted twice, and a roll-up whose job is to be the number
 * you can trust over the rows it replaces must not double-count them. In this
 * sample it costs 7 orders → 6 on the unresolved bucket, which is how the rule was
 * found rather than assumed.
 */
export interface EncumbranceLevel {
  LEVEL_CODE: string;
  /** The object codes present under this level, sorted. */
  OBJECT_CODES: string[];
  ACCOUNTS: number;
  PO_ENCUMBERED: number;
  PO_ORDERS: number;
  /** Set only when some account under the level has a GL row — `0450`, once. */
  GL_ENCUMBRANCE: number | null;
  /** True when the level carries both sides. Exactly one level does. */
  HAS_BOTH: boolean;
}

/** The seven combinations whose account resolves to no project. */
export interface EncumbranceUnresolved {
  ACCOUNTS: number;
  AMOUNT: number;
  ORDERS: number;
  NOTE: string;
}

/** What the purchasing table says about itself, measured rather than asserted. */
export interface EncumbrancePoSide {
  ROWS: number;
  FLAGGED: number;
  UNFLAGGED: number;
  /** Rows where `ENCUMBERED_AMOUNT = AMOUNT_ORDERED`. All of them, here. */
  MIRRORED: number;
  AMOUNT_NULL: number;
  BILLED_ROWS: number;
  ENCUMBRANCE_TOTAL: number;
  ORDERED_TOTAL: number;
  BILLED_TOTAL: number;
  /**
   * ★ The disclosure switch. Derived from the counts above, so a later extract
   *   carrying a real encumbered figure flips it false without anyone editing a
   *   sentence — which is the only way a caveat like this stays true.
   */
  encumbranceMirrorsOrdered: boolean;
}

export interface EncumbranceTotals {
  PO_ENCUMBERED: number;
  PO_ORDERED: number;
  GL_ENCUMBRANCE: number;
  OVERLAP_ACCOUNTS: number;
  OVERLAP_PO: number;
  OVERLAP_GL: number;
  /** ★ The only difference on this page taken over a shared population. */
  OVERLAP_DELTA: number;
}

export interface EncumbranceCounts {
  ACCOUNTS: number;
  IN_BOTH: number;
  PO_ONLY: number;
  GL_ONLY: number;
  LEVELS: number;
  GL_ACCOUNTS: number;
}

export interface EncumbranceNotes {
  PO_SIDE: string;
  GL_SIDE: string;
  DISAGREEMENT: string;
  UNRESOLVED: string;
}

/** Everything the screen reads, in one pass. */
export interface EncumbrancesData {
  accounts: EncumbranceAccount[];
  levels: EncumbranceLevel[];
  unresolved: EncumbranceUnresolved;
  po: EncumbrancePoSide;
  totals: EncumbranceTotals;
  counts: EncumbranceCounts;
  notes: EncumbranceNotes;
  /**
   * Always empty today, and kept for the same reason `budgets.ts` keeps its own:
   * the API can page this route, and a page of a population printed as the
   * population is a wrong total that looks like a small one.
   */
  truncated: string[];
}

/**
 * One request, unwrapped, with a refusal that names its own status.
 *
 * Deliberately not `budgets.ts`'s `getList`: this route answers with **one
 * object** — four blocks that have to agree with each other — not a list, so
 * there is no `page` to check. What is checked instead is the shape the screen
 * depends on, because an endpoint that answers `200` with `{}` would otherwise
 * render as 0 rows and read as an empty ledger.
 */
async function getOne<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal });
  if (!res.ok) {
    let detail = `HTTP ${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body?.error?.message) detail = body.error.message;
    } catch {
      /* The status line stands. */
    }
    throw new Error(detail);
  }
  const body = (await res.json()) as Single<T> & { data?: T };
  const data = body?.data;
  if (!data || !Array.isArray((data as { accounts?: unknown }).accounts)) {
    throw new Error(`The response from ${path} did not contain the encumbrance blocks.`);
  }
  return data;
}

/**
 * The whole page, from one endpoint.
 *
 * One request rather than four on purpose: the four blocks are the *same*
 * question answered from two directions, and they only mean anything if they were
 * read at the same instant. Four list requests could straddle a write and produce
 * a page whose own totals disagree with its own rows.
 *
 * The limit is not a parameter here — the route is not paginated, and its size is
 * bounded by the purchasing extract (335 combinations, ~163 KB), not by a request
 * carrying a page size. `counts` still travels so the page can say what population
 * its rows are.
 */
export async function loadEncumbrances(signal?: AbortSignal): Promise<EncumbrancesData> {
  const data = await getOne<Omit<EncumbrancesData, 'truncated'>>('/api/spend/encumbrances', signal);

  const truncated: string[] = [];
  const checks: [string, number, number][] = [
    ['account combinations', data.counts.ACCOUNTS, data.accounts.length],
    ['project levels', data.counts.LEVELS, data.levels.length + 1],
  ];
  for (const [label, total, returned] of checks) {
    if (total > returned) {
      truncated.push(`${label}: ${total} exist, ${returned} were read`);
    }
  }

  return { ...data, truncated };
}

/* -------------------------------------------------------------------------- */
/* Ordering and selection                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Largest commitment first.
 *
 * Not alphabetical. The top row is $97,681,625 and the 13 smallest are under
 * $5,000 — an account-ordered list of 335 rows buries the one figure that
 * explains the total, and a reader who has to sort by hand to find it will not.
 * Ties fall back to the account key so the order is stable across reads rather
 * than depending on what the query happened to return.
 */
export function byCommitment(a: EncumbranceAccount, b: EncumbranceAccount): number {
  return b.PO_ENCUMBERED - a.PO_ENCUMBERED || a.ACCOUNT.localeCompare(b.ACCOUNT);
}

/** The same rule for the roll-up, which is what a reader compares levels on. */
export function byLevelCommitment(a: EncumbranceLevel, b: EncumbranceLevel): number {
  return b.PO_ENCUMBERED - a.PO_ENCUMBERED || a.LEVEL_CODE.localeCompare(b.LEVEL_CODE);
}

/**
 * The accounts both sides hold — the four `DELTA` is defined over.
 *
 * ★ THIS IS THE ONLY SET ON THE PAGE WHERE A DIFFERENCE MEANS ANYTHING. Taking
 *   `GL total − PO total` over the full populations subtracts 4 accounts from 335
 *   and yields a number with no referent: it is not an error, it is the size of
 *   two different populations expressed as a subtraction. `totals.OVERLAP_DELTA`
 *   is the same figure the server computes over the same four rows, and this
 *   helper exists so the screen can show the rows rather than only the total.
 */
export function overlap(accounts: EncumbranceAccount[]): EncumbranceAccount[] {
  return accounts.filter((a) => a.IN_PO && a.IN_GL);
}

/**
 * The report's own duplicate, and what the purchasing data says about it.
 *
 * `data/reports/report-findings.md` publishes encumbrances of **$149,072.93 on
 * both object 529 and object 532**, and asks whether one purchase order genuinely
 * spans both or the report has a copy bug. The purchasing side answers it: on the
 * two identical account keys the distributions give **529 → $354,782.00 over 9
 * distributions** and **532 → $15,000.00 over 1** — different figures, so the
 * report's pair is not two views of one commitment.
 *
 * Written as a lookup rather than a hard-coded pair so the panel disappears if a
 * future extract stops disagreeing, instead of ageing into a claim about data that
 * moved. Returns `null` when the two accounts no longer carry the same GL figure.
 */
export interface DuplicateFinding {
  /** The figure the report prints twice. */
  reportFigure: number;
  /** The two accounts carrying it, cheapest first. */
  rows: EncumbranceAccount[];
}

export function duplicateFinding(accounts: EncumbranceAccount[]): DuplicateFinding | null {
  const gl = accounts.filter((a) => a.IN_GL && a.GL_ENCUMBRANCE !== null);
  const byFigure = new Map<number, EncumbranceAccount[]>();
  for (const a of gl) {
    const key = Math.round((a.GL_ENCUMBRANCE as number) * 100);
    byFigure.set(key, [...(byFigure.get(key) ?? []), a]);
  }
  for (const [cents, group] of byFigure) {
    if (group.length < 2) continue;
    // Only interesting when the purchasing side disagrees about them.
    if (new Set(group.map((a) => a.PO_ENCUMBERED)).size > 1) {
      return {
        reportFigure: cents / 100,
        rows: [...group].sort((a, b) => a.PO_ENCUMBERED - b.PO_ENCUMBERED),
      };
    }
  }
  return null;
}

/**
 * ★ Why the account scope is deliberately **not** applied on this page.
 *
 * Measured on this population: fund `00` / program `000` on exactly 7 of the 335
 * combinations — and those 7 are the `UNRESOLVED` bucket, the $11,511.12 the page
 * exists to account for. Running the app's scope over these rows would delete the
 * page's own footnote and leave a total that no longer reconciles with the
 * extract, silently, on a screen whose entire argument is about which population a
 * figure came from.
 *
 * Returned as a number rather than a sentence so the note prints the count it is
 * describing, and so the decision re-tests itself if a fuller extract changes it.
 *
 * ★ THE SCOPE IS A PARAMETER AND THE PREDICATE IS `inScope`, BECAUSE BOTH HALVES OF
 *   THIS WERE WRONG. It used to take nothing and spell the organization's vocabulary as
 *   literals — `'04'`, `['861','862','863']` — so it went on measuring the **shipped**
 *   scope after the organization row became editable, while the note beside it printed
 *   the **reader's** selection. A reader who narrowed the scope to one program read a
 *   label naming that program above a count for all three. That is one defect twice: the
 *   sentence and the number must be about one scope, and the scope must come from the
 *   tenant rather than from a constant. `inScope` is documented in `scope.ts` as **the
 *   one implementation** exactly so that no two screens can disagree about the rule;
 *   this is the second caller to obey it.
 *
 * ★ `null` MEANS NO SCOPE IS CONFIGURED, AND IT IS NOT A DEFAULT ARGUMENT. `inScope`
 *   rejects every row when the fund is empty, so a missing organization would make this
 *   return all 335 and the note would announce that the app's scope removes the entire
 *   page — the same lie `store.tsx` guards against with its own `active` test, for the
 *   same reason. `null` is the caller saying "there is no tenant", and the count is 0
 *   because an app with no scope configured removes nothing anywhere.
 *
 * The measured facts above are for the tenant's full selection on this population and are
 * unchanged by the parameter: the default selection still removes 7 of the 335.
 */
export function scopeWouldRemove(accounts: EncumbranceAccount[], scope: Scope | null): number {
  if (scope === null) return 0;
  return accounts.filter((a) => !inScope(scope, a.FUND_CODE, a.PROGRAM_CODE)).length;
}

/**
 * Does `q` appear anywhere in an account the reader might search by?
 *
 * Searches the dotted key, the object, the level, and the purpose, because all
 * four are things a reader arrives holding: "the account from that invoice",
 * "object 527", "the 0450 project", "purpose 6570". Matching only `ACCOUNT` would
 * make three of those four searches return nothing while looking like a filter.
 *
 * ★ `filter` BEFORE any `slice`, never after — the discipline `debugging.md`
 *   records. There is no slice today; the rule is kept anyway because that is the
 *   change that gets made carelessly.
 */
export function matches(a: EncumbranceAccount, q: string): boolean {
  const term = q.trim().toLowerCase();
  if (!term) return true;
  return (
    a.ACCOUNT.toLowerCase().includes(term) ||
    a.OBJECT_CODE.toLowerCase().includes(term) ||
    a.LEVEL_CODE.toLowerCase().includes(term) ||
    a.PURPOSE_CODE.toLowerCase().includes(term)
  );
}

/**
 * `$0.00` for a measured zero, `—` for an absence.
 *
 * ★ THE ONE RULE THIS MODULE OWNS THAT THE FORMATTERS CANNOT. Every formatter in
 *   `format.ts` takes a `number` and `Number(null)` is `0`, so passing the 331
 *   blanks through `money()` prints `$0.00` — a claim that the ledger was read, it
 *   contained the account, and the answer was nothing. It was not read at all.
 *   Callers get the distinction from the type; this is the single place it is
 *   turned into a glyph.
 */
export const moneyOrDash = (n: number | null, format: (v: number) => string): string =>
  n === null || n === undefined ? '—' : format(n);
