import type {
  Bucket,
  CostCode,
  ExtractLine,
  ExtractSummary,
  Project,
  ProjectAccount,
  PurposeCode,
} from './types';
import { PURPOSE_META, PURPOSE_ORDER, SEGMENT_ORDER, objectLabel, objectTitle } from './taxonomy';
import type { ProjectMeta } from './projectMeta';
import { deriveLineProjects } from './lineProjects';
import { daysBetween, share } from './format';

/** A level with no order in this many days is Dormant, measured from the extract cut-off. */
export const ACTIVE_WINDOW_DAYS = 90;

/**
 * The approved budget is **invented**. Oracle has no budget table, and the plan's
 * §9.8 makes this an admin-maintained figure per account combination. The mockup
 * derived it as committed × 1.10 rounded up to the next $10,000 so the usage bar
 * had something to fill; that derivation is kept here so the numbers match the
 * approved design, and disclosed everywhere it surfaces.
 */
export const allocate = (committed: number): number =>
  Math.ceil((committed * 1.1) / 10_000) * 10_000;

export const ALLOC_RULE =
  'Approved budget is committed × 1.10 rounded up to the next $10,000. It is a ' +
  'placeholder, not Oracle data — Oracle has no budget table, and in the finished ' +
  'app staff enter this figure against each cost code.';

// ---------------------------------------------------------------- helpers

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

const sum = (ns: number[]): number => ns.reduce((a, b) => a + b, 0);

const distinct = <T,>(items: T[]): number => new Set(items).size;

/**
 * The segments that hold **one value across a given set of lines** — measured, never stated.
 *
 * ★ THIS REPLACES A HARDCODED MAP, AND THE REASON MATTERS. `taxonomy.ts` used to export
 *   `CONSTANT_SEGMENTS = { FUND: '04', PROGRAM: '862', COST_CENTER: '0840', FUTURE_USE: '000' }`,
 *   which was a description of the one extract the app happened to be reading. That was harmless
 *   while nothing could change which fund or program was shown, and became a trap the moment a
 *   scope selector could: three screens and a Dashboard note render this, and every one of them
 *   would have gone on saying "single-valued" about a set it was no longer describing.
 *
 * So it is measured per call instead. Confirmed against the 2,782-line served extract, where it
 * returns exactly the four segments the old literal named — but the four segments are now a
 * *finding* about the scope, and a scope that admitted program 861 could not produce them by
 * accident.
 *
 * The values are read in `SEGMENT_ORDER` order, so a caller can render the map in the same order it
 * renders the key and the two cannot disagree.
 */
export function constantSegments(lines: ExtractLine[]): Record<string, string> {
  if (!lines.length) return {};

  const pick: Record<string, (l: ExtractLine) => string> = {
    FUND: (l) => l.fund,
    PURPOSE: (l) => l.purpose,
    PROGRAM: (l) => l.program,
    OBJECT_: (l) => l.object,
    LEVEL_: (l) => l.level,
    COST_CENTER: (l) => l.costCenter,
    FUTURE_USE: (l) => l.futureUse,
  };

  const out: Record<string, string> = {};
  for (const segment of SEGMENT_ORDER) {
    const read = pick[segment];
    const values = new Set(lines.map(read));
    if (values.size === 1) out[segment] = [...values][0];
  }
  return out;
}

/**
 * `04-6570-862-` — the three segments that precede the object, read off a key that exists.
 *
 * The alternative is the template this replaced (`` `04-${purpose}-862-` ``), which printed a
 * prefix that was only ever right by coincidence and would have gone on being printed after the
 * scope changed. A prefix taken from a real key cannot describe a segment the data does not have.
 *
 * Returns `''` for a key with fewer than three segments, which is not a reachable input and is
 * still handled rather than assumed away.
 */
export const accountPrefix = (combination: string): string => {
  const segments = String(combination ?? '').split('-');
  return segments.length >= 3 ? `${segments[0]}-${segments[1]}-${segments[2]}-` : '';
};

/**
 * What each level's own purchase-order lines call the jobs booked to it, largest
 * first.
 *
 * A level with no row in the project registry is not nameless — it is merely
 * unclaimed. Oracle holds no project field anywhere in the extract, so the only
 * place a job is named is the prose of the lines that book to it: level 2436 has no
 * registry row, and Oracle calls it `GARNER HS-TRACK REPLACEMENT` and
 * `GARNER HS-FIRE PUMP VENTILATION`. Reading those names back is what lets a search
 * for Garner find the level, and what stops the list saying `Unclaimed level 2436`
 * beside two jobs it can name.
 *
 * Only the two largest names are kept, for the same reason `comboTitle` caps at two
 * on the search page: this is a list row, not a manifest.
 */
function namesByLevel(lines: ExtractLine[]): Map<string, string> {
  const byLevel = new Map<string, Map<string, number>>();

  for (const project of deriveLineProjects(lines)) {
    for (const [key, part] of Object.entries(project.byCombo)) {
      // `04-6570-862-522-2436-0840-000` → `2436`.
      const level = key.split('-')[4] ?? '';
      const shares = byLevel.get(level) ?? new Map<string, number>();
      shares.set(project.name, (shares.get(project.name) ?? 0) + part.amount);
      byLevel.set(level, shares);
    }
  }

  const out = new Map<string, string>();
  for (const [level, shares] of byLevel) {
    const names = [...shares.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 2)
      .map(([name]) => name);
    out.set(level, names.join(' · '));
  }
  return out;
}

// ---------------------------------------------------------------- derivation

export function deriveSummary(lines: ExtractLine[]): ExtractSummary {
  return {
    cutoff: lines.reduce((m, l) => (l.orderDate > m ? l.orderDate : m), lines[0].orderDate),
    rows: lines.length,
    projects: distinct(lines.map((l) => l.level)),
    orders: distinct(lines.map((l) => l.orderNumber)),
    vendors: distinct(lines.map((l) => l.vendor)),
    committed: sum(lines.map((l) => l.amount)),
  };
}

/**
 * The combination key that most of these rows actually carry, restricted to the level being built.
 *
 * A cost code is one object inside one (level, purpose), so its key is normally uniform and this
 * returns it unchanged. It exists because the alternative was a template — the old code built
 * `` `04-${purpose}-862-${object}-${level}-0840-000` `` by hand — and a template cannot be wrong in a
 * way anything notices: it prints a plausible key whether or not a single row has it. Taking the key
 * off the rows means the code printed beside a figure is always a code that figure came from.
 *
 * `level` is the level the caller is grouping by, and it is used rather than assumed: the key's fifth
 * segment must be that level, or the code would carry a key belonging to a different project's row.
 * The filter is a plain string compare on segment 5 rather than a rebuilt combination, because a key
 * with fewer than five segments must not match anything by accident.
 *
 * Ties break on the key itself so the answer is stable across renders rather than following
 * insertion order.
 */
function dominantCombination(rows: ExtractLine[], level: string): string {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.combinationKey, (counts.get(r.combinationKey) ?? 0) + 1);

  const belongs = (key: string) => key.split('-')[4] === level;
  const pool = [...counts.keys()].some(belongs) ? [...counts].filter(([k]) => belongs(k)) : [...counts];

  let best = '';
  let bestCount = -1;
  for (const [key, n] of pool) {
    if (n > bestCount || (n === bestCount && key < best)) {
      best = key;
      bestCount = n;
    }
  }
  return best;
}

function buildCostCodes(level: string, purpose: PurposeCode, rows: ExtractLine[]): CostCode[] {
  const byObject = new Map<string, ExtractLine[]>();
  for (const r of rows) push(byObject, r.object, r);

  const codes = [...byObject.entries()].map(([object, objectRows]): CostCode => {
    const vendorTotals = new Map<string, number>();
    for (const r of objectRows) {
      vendorTotals.set(r.vendor, (vendorTotals.get(r.vendor) ?? 0) + r.amount);
    }
    let topVendor = '';
    let topVendorAmount = 0;
    for (const [vendor, amount] of vendorTotals) {
      if (amount > topVendorAmount) {
        topVendor = vendor;
        topVendorAmount = amount;
      }
    }

    return {
      object,
      purpose,
      label: objectLabel(object),
      combination: dominantCombination(objectRows, level),
      amount: sum(objectRows.map((r) => r.amount)),
      lines: objectRows.length,
      orders: distinct(objectRows.map((r) => r.orderNumber)),
      vendors: distinct(objectRows.map((r) => r.vendor)),
      topVendor,
      topVendorAmount,
      // Newest first, then largest — the order a reader wants when checking detail.
      rows: [...objectRows].sort(
        (a, b) => b.orderDate.localeCompare(a.orderDate) || b.amount - a.amount,
      ),
    };
  });

  // Amount descending is what produces the 0001-based line numbers in the panel.
  codes.sort((a, b) => b.amount - a.amount);
  return codes;
}

function buildBucket(level: string, purpose: PurposeCode, rows: ExtractLine[]): Bucket {
  const costCodes = buildCostCodes(level, purpose, rows);
  const committed = sum(costCodes.map((c) => c.amount));
  const approved = allocate(committed);

  return {
    purpose,
    meta: PURPOSE_META[purpose],
    costCodes,
    committed,
    approved,
    remaining: approved - committed,
    used: share(committed, approved),
    // Counted inside each cost code and then added, so these can exceed the
    // project's distinct counts. The panel labels the summed ones "links".
    lines: sum(costCodes.map((c) => c.lines)),
    orders: sum(costCodes.map((c) => c.orders)),
    vendors: sum(costCodes.map((c) => c.vendors)),
  };
}

function buildProject(
  level: string,
  rows: ExtractLine[],
  cutoff: string,
  fromLines: string,
  meta: ProjectMeta | undefined,
): Project {
  const first = rows.reduce((m, r) => (r.orderDate < m ? r.orderDate : m), rows[0].orderDate);
  const last = rows.reduce((m, r) => (r.orderDate > m ? r.orderDate : m), rows[0].orderDate);
  const committed = sum(rows.map((r) => r.amount));
  const quietDays = daysBetween(last, cutoff);

  const byPurpose = new Map<string, ExtractLine[]>();
  for (const r of rows) push(byPurpose, r.purpose, r);

  const buckets = PURPOSE_ORDER.filter((p) => byPurpose.has(p)).map((p) =>
    buildBucket(level, p, byPurpose.get(p) ?? []),
  );

  const bucketTotal = (purpose: PurposeCode): number =>
    buckets.find((b) => b.purpose === purpose)?.committed ?? 0;

  const approved = sum(buckets.map((b) => b.approved));
  const largest = [...buckets].sort((a, b) => b.committed - a.committed)[0];

  /**
   * ★ THE LEVEL'S ACCOUNTS, AND A BINDING GATHERS ALL OF THEM.
   *
   *   A project is a named account level, and a level is not one account: `0450` is
   *   four — 526, 527, 529 and 532 — and 88 of the extract's 139 levels carry more
   *   than one. The display code used to name whichever of them held the most money
   *   (`CC-0450-527`), which reads as "this project is account 527" and leaves the
   *   other three looking like somebody else's. They are not: the 4-digit level is
   *   what the ledger keys a project on, so the level is what brings them in.
   *
   *   Built from the buckets' cost codes rather than from the raw lines, because a
   *   cost code already carries the combination, its own sums, and the purpose it
   *   sits in — and because `529` genuinely appears in two of them.
   *
   *   Largest first, so the account the level is anchored on leads the list. That is
   *   the same fact the old code encoded, stated by the order of a list instead of by
   *   a name that pointed at one account and hid the rest.
   */
  const byObject = new Map<string, CostCode[]>();
  for (const b of buckets) {
    for (const c of b.costCodes) push(byObject, c.object, c);
  }

  const accounts: ProjectAccount[] = [...byObject.entries()]
    .map(([object, codes]) => {
      const amount = sum(codes.map((c) => c.amount));
      return {
        object,
        label: objectTitle(object),
        combinations: codes.map((c) => c.combination).sort(),
        lines: sum(codes.map((c) => c.lines)),
        orders: sum(codes.map((c) => c.orders)),
        vendors: sum(codes.map((c) => c.vendors)),
        committed: amount,
        share: share(amount, committed),
      };
    })
    .sort((a, b) => b.committed - a.committed || a.object.localeCompare(b.object));

  return {
    level,
    // ★ THE CODE NAMES THE LEVEL AND NOTHING ELSE. `0450` is Athens Drive HS whether
    //   its money lands on 527, 526, 529 or 532, so the code is `0450` — and it is
    //   `0450` for a claimed level and for an unclaimed one alike, because there is
    //   only one rule now. Nothing parses this string any more: the anchor it used to
    //   carry is the head of `accounts` above, and `combos.ts` reads the level.
    //
    //   Derived, not taken from the registry — `meta.code` is deliberately ignored —
    //   so a row written under the old rule cannot put an object back into a code on
    //   every screen that shows one.
    code: `CC-${level}`,
    // Unclaimed, and the lines name nothing either? Then there is genuinely nothing
    // to call it beyond its own number, and saying so is the honest answer. The name
    // is the one field that cannot fall back on an empty string: a project always has
    // a name, so a blank one is a broken row rather than a project nobody has named.
    name: meta?.name || fromLines || `Unclaimed level ${level}`,
    site: meta?.site || largest?.costCodes[0]?.label || 'Not yet described',
    owner: meta?.owner || '',
    status: quietDays <= ACTIVE_WINDOW_DAYS ? 'active' : 'dormant',
    quietDays,
    note: meta?.note || '',
    unclaimed: !meta,
    // ★ THERE WAS A `hint` HERE — the largest object code, as a sentence for a
    //   level nobody had named. It went when the display code stopped naming an
    //   object: every account a level owns is now in `accounts` below, with its
    //   own label and its own money, so a one-account hint about a four-account
    //   level had nothing left to say.
    first,
    last,
    lines: rows.length,
    orders: distinct(rows.map((r) => r.orderNumber)),
    vendors: distinct(rows.map((r) => r.vendor)),
    committed,
    approved,
    remaining: approved - committed,
    used: share(committed, approved),
    capital: bucketTotal('6570'),
    operating: bucketTotal('9000'),
    relocation: bucketTotal('6560'),
    buckets,
    accounts,
  };
}

/**
 * Every level in the extract, largest commitment first.
 *
 * `meta` is the project registry keyed by account level — see `metaByLevel` in
 * `projectMeta.ts`. It is a parameter rather than an import because it arrives over
 * the network and can fail: when it does, the levels still arrive, still largest
 * first, still named from their own line descriptions, and every one of them now
 * reads `unclaimed`. An empty object is a valid value here and means exactly that.
 */
export function deriveProjects(
  lines: ExtractLine[],
  meta: Record<string, ProjectMeta> = {},
): Project[] {
  const cutoff = lines.reduce((m, l) => (l.orderDate > m ? l.orderDate : m), lines[0].orderDate);
  const names = namesByLevel(lines);

  const byLevel = new Map<string, ExtractLine[]>();
  for (const l of lines) push(byLevel, l.level, l);

  return [...byLevel.entries()]
    .map(([level, rows]) => buildProject(level, rows, cutoff, names.get(level) ?? '', meta[level]))
    .sort((a, b) => b.committed - a.committed || a.level.localeCompare(b.level));
}

// ---------------------------------------------------------------- time series

export interface MonthPoint {
  ym: string;
  amount: number;
  lines: number;
  orders: number;
  vendors: number;
}

/**
 * Committed value per calendar month, with **empty months retained and plotted at
 * zero** rather than trimmed — a gap in activity is information, and trimming it
 * would make the line edge-to-edge and hide it.
 */
export function deriveMonths(lines: ExtractLine[]): MonthPoint[] {
  const byMonth = new Map<string, ExtractLine[]>();
  for (const l of lines) push(byMonth, l.orderDate.slice(0, 7), l);

  const months = [...byMonth.keys()].sort();
  if (months.length === 0) return [];

  const out: MonthPoint[] = [];
  let [y, m] = months[0].split('-').map(Number);
  const [endY, endM] = months[months.length - 1].split('-').map(Number);

  while (y < endY || (y === endY && m <= endM)) {
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    const rows = byMonth.get(ym) ?? [];
    out.push({
      ym,
      amount: sum(rows.map((r) => r.amount)),
      lines: rows.length,
      orders: distinct(rows.map((r) => r.orderNumber)),
      vendors: distinct(rows.map((r) => r.vendor)),
    });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}
