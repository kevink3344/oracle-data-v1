/**
 * The claimable cost centres, flattened out of the derived projects.
 *
 * Oracle keys every PO line on the **seven-segment account combination**, not on the
 * level and not on the object code on its own, so the combination is the join key —
 * and it joins in both directions. One project's lines land on several combinations
 * (a track replacement is bought as construction, as testing and as a contingency),
 * and one combination carries several projects (Garner High's track replacement and
 * its fire-pump ventilation both book to `04-6570-862-522-2436-0840-000`).
 *
 * `holders` is that second direction. It is read off the PO-line text by
 * `lineProjects.ts`, and a level named in `projectMeta.ts` is folded in as a holder
 * for whatever of its money the line text does not name. Where the two registers
 * agree — `LOCKHART ES-RENO` over `Lockhart ES – Renovation` — they are one holder,
 * because both canonicalise to the same key.
 */

import type { CostCode, ExtractLine, Project, PurposeCode } from './types';
import { PURPOSE_META, objectTitle } from './taxonomy';
import { canonName, deriveLineProjects } from './lineProjects';

const sum = (ns: number[]): number => ns.reduce((a, b) => a + b, 0);

/** A project with money on one combination. */
export interface ComboHolder {
  /** Merge key. Two names are the same project when these match. */
  canon: string;
  /** What to print: the least cluttered spelling seen. */
  name: string;
  /** `CC-<level>-<object>`, suffixed `-2` when two projects share the combination. */
  code: string;
  /** Whether the name came off the PO lines, off the level, or both. */
  source: 'lines' | 'level' | 'both';
  /** Committed on *this* combination only — the project's share, not its total. */
  amount: number;
  lines: number;
  orders: number;
  /** Work packages seen on these lines: `0001` design, `0004` construction. */
  packages: string[];
  /** The project's committed across every combination it touches. */
  total: number;
  /** How many combinations it touches. More than one is the normal case. */
  spread: number;
}

export interface Combo {
  /** The seven segments joined: `04-6570-862-527-0523-0840-000`. */
  key: string;
  purpose: PurposeCode;
  purposeLabel: string;
  object: string;
  /** `527 · Construction, CMAR / GMP`, or the bare code when Oracle's code is unlabelled. */
  objectName: string;
  level: string;
  levelName: string;
  levelCode: string;
  /**
   * True when the level carries an app-native name — i.e. somebody has claimed it.
   *
   * ★ AND THE LEVEL IS THE WHOLE OF A CLAIM. This used to sit beside a `claimed`
   *   flag on the one combination the level's display code named, because the code
   *   was `CC-0450-527` and that one account was read back out of it. A binding is to
   *   the level, so every combination a held level owns is inside it — `0450`'s 526,
   *   529 and 532 were only ever unclaimed in appearance. See `buildCombos`.
   */
  levelClaimed: boolean;
  /**
   * Every project with money on this combination, largest share first.
   *
   * Informational, and deliberately separate from `claimed`: reading a name out of
   * the PO text is not the same as an app record binding the combination, and
   * treating the two as one would make 252 of the extract's 328 combinations
   * unclaimable on the strength of a text match.
   */
  holders: ComboHolder[];
  /** The holder names, ` + `-joined, or empty. Convenience for one-line summaries. */
  holder: string;
  amount: number;
  lines: number;
  orders: number;
  vendors: number;
  topVendor: string;
  topVendorAmount: number;
  first: string;
  last: string;
  /** The underlying PO lines, so a search can reach the description text. */
  rows: ExtractLine[];
  /** Key, names and every description, lower-cased, for one pass per keystroke. */
  haystack: string;
}

/** `CC-0453-527`, then `-2` for the second project on the same combination. */
function codeFor(level: string, object: string, index: number): string {
  const base = `CC-${level}-${object}`;
  return index === 0 ? base : `${base}-${index + 1}`;
}

/**
 * Who has money on each combination.
 *
 * The line-derived projects are placed first because they are the specific answer;
 * a named level then takes whatever of its money is left unnamed on that
 * combination. Without that residual pass the `CMAR-GMP #1 CONSTRUCTION` line —
 * $97.7M, the largest row in the extract — would belong to nobody.
 */
function buildHolderIndex(lines: ExtractLine[], projects: Project[]): Map<string, ComboHolder[]> {
  const byCombo = new Map<string, ComboHolder[]>();
  const push = (key: string, holder: ComboHolder): void => {
    const list = byCombo.get(key);
    if (list) list.push(holder);
    else byCombo.set(key, [holder]);
  };

  // ① What the PO-line text names. This is the only place a project identity exists.
  const lineProjects = deriveLineProjects(lines);
  for (const project of lineProjects) {
    for (const [key, share] of Object.entries(project.byCombo)) {
      push(key, {
        canon: project.canon,
        name: project.name,
        code: '',
        source: 'lines',
        amount: share.amount,
        lines: share.lines,
        orders: share.orders,
        packages: share.packages,
        total: project.amount,
        spread: project.combos.length,
      });
    }
  }

  // ② What the named levels cover. A level's name is app-native, so it can hold
  //    money the line text never names — but only the money no derived project
  //    already accounts for, or the total would be counted twice.
  for (const project of projects) {
    if (project.unclaimed) continue;
    for (const bucket of project.buckets) {
      for (const costCode of bucket.costCodes) {
        const list = byCombo.get(costCode.combination) ?? [];
        const mine = canonName(project.name);
        const named = list.filter((h) => h.canon === mine);
        const elsewhere = sum(list.filter((h) => h.canon !== mine).map((h) => h.amount));
        const residual = costCode.amount - elsewhere;
        const namedAmount = sum(named.map((h) => h.amount));
        const gap = residual - namedAmount;

        if (named.length > 0) {
          // The two registers agree on this project: one holder, both sources.
          for (const holder of named) holder.source = 'both';
          if (gap > 1) {
            named[0].amount += gap;
            named[0].lines += costCode.lines - sum(named.map((h) => h.lines));
            named[0].total += gap;
          }
          continue;
        }
        if (residual <= 1) continue;

        push(costCode.combination, {
          canon: mine,
          name: project.name,
          code: '',
          source: 'level',
          amount: residual,
          lines: costCode.lines,
          orders: costCode.orders,
          packages: [],
          total: residual,
          spread: 1,
        });
      }
    }
  }

  // Codes last, because a code depends on how many projects share the combination.
  //
  // ★ AND A NAMED LEVEL CARRIES THE LEVEL'S OWN CODE. `CC-0453-527` names a pair —
  //   level and object — which is the right name for a holder read off the PO-line
  //   text, because such a line really does point at one combination. It is the
  //   wrong name for a level named in the registry: that claim is on the level, and
  //   printing `CC-0450-527` beside it says the project is bound to one object when
  //   526, 529 and 532 are just as much its own.
  for (const [key, list] of byCombo) {
    list.sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
    list.forEach((holder, index) => {
      const named = holder.source === 'level' || holder.source === 'both';
      holder.code = named
        ? `CC-${levelOf(key)}`
        : codeFor(levelOf(key), objectOf(key), index);
    });
  }

  return byCombo;
}

/** `04-6570-862-527-0453-0840-000` → `0453`. */
const levelOf = (key: string): string => key.split('-')[4] ?? '';
/** `04-6570-862-527-0453-0840-000` → `527`. */
const objectOf = (key: string): string => key.split('-')[3] ?? '';

function flatten(project: Project, costCode: CostCode, holders: ComboHolder[]): Combo {
  const rows = costCode.rows;
  const first = rows.reduce((m, r) => (r.orderDate < m ? r.orderDate : m), rows[0].orderDate);
  const last = rows.reduce((m, r) => (r.orderDate > m ? r.orderDate : m), rows[0].orderDate);
  const purposeLabel = PURPOSE_META[costCode.purpose].label;
  const objectName = objectTitle(costCode.object);

  return {
    key: costCode.combination,
    purpose: costCode.purpose,
    purposeLabel,
    object: costCode.object,
    objectName,
    level: project.level,
    levelName: project.name,
    levelCode: project.code,
    levelClaimed: !project.unclaimed,
    holders,
    holder: holders.map((h) => h.name).join(' + '),
    amount: costCode.amount,
    lines: costCode.lines,
    orders: costCode.orders,
    vendors: costCode.vendors,
    topVendor: costCode.topVendor,
    topVendorAmount: costCode.topVendorAmount,
    first,
    last,
    rows,
    haystack: [
      costCode.combination,
      purposeLabel,
      objectName,
      project.level,
      project.code,
      project.name,
      ...holders.map((h) => h.name),
      ...rows.map((r) => r.description),
    ]
      .join(' ')
      .toLowerCase(),
  };
}

/** Every distinct seven-segment combination in the extract, largest commitment first. */
export function buildCombos(lines: ExtractLine[], projects: Project[]): Combo[] {
  const holders = buildHolderIndex(lines, projects);

  // ★ WHAT A CLAIM BINDS IS THE LEVEL, AND THE CODE NO LONGER SAYS OTHERWISE.
  //
  //   This used to parse `project.code` back into an object (`CC-0454-527` → `527`)
  //   and mark that one combination as claimed. So the app's statement that a level
  //   was held was expressed as a statement about a single account of it — and the
  //   account was whichever carried most of the level's money, so `0450` read as held
  //   on 527 while its 526, 529 and 532 read as unheld. A level is the whole binding,
  //   which is what `Combo.levelClaimed` now says on every combination it owns.
  //
  //   The line-derived holders are a reading of the extract and still do not bind —
  //   if they did, the 252 combinations whose text names a project would stop being
  //   claimable.
  const out: Combo[] = [];
  for (const project of projects) {
    for (const bucket of project.buckets) {
      for (const costCode of bucket.costCodes) {
        out.push(flatten(project, costCode, holders.get(costCode.combination) ?? []));
      }
    }
  }
  return out.sort((a, b) => b.amount - a.amount || a.key.localeCompare(b.key));
}

/**
 * The code a **holder** carries on one combination: level, then the object.
 *
 * ★ NOT THE PROJECT'S OWN CODE. A project is a level and its display code is
 *   `CC-0450` with no object in it, so this string belongs to the combination and not
 *   to the project — it is what that project's code *would* be if it named this
 *   combination, which is the useful thing to say about a holder on a combination
 *   page. Nothing stores it: not the registry, not `Project.code`.
 *
 * A combination can now carry several projects, so `CC-<level>-<object>` on its own is
 * not unique — Garner High's track replacement and its fire-pump ventilation both sit
 * on `CC-2436-522`. The suffix is decided in `buildHolderIndex`, where the whole
 * combination is in view; this helper only names the *rule*, and the second argument
 * is the position of the project within the combination.
 */
export const projectCodeFor = (combo: Combo, index = 0): string =>
  index === 0 ? `CC-${combo.level}-${combo.object}` : `CC-${combo.level}-${combo.object}-${index + 1}`;

/**
 * `0451` while the level is unnamed, `0454 · North Garner MS – Renovation` once it is.
 * Concatenating the two unconditionally reads "0451 · Unclaimed level 0451".
 */
export const levelLabel = (combo: Combo): string =>
  combo.levelClaimed ? `${combo.level} · ${combo.levelName}` : combo.level;

/**
 * What to call the combination in a list.
 *
 * The projects win, because they are what the reader is looking for and because an
 * unnamed level has nothing else to say for itself. `Unclaimed level 2436` is true —
 * no app record has claimed it — but it is not useful when the lines name Garner
 * High's track replacement and its fire-pump ventilation. Capped at two names so a
 * combination carrying five projects does not push the rest of the card off.
 */
export const comboTitle = (combo: Combo): string => {
  const { holders } = combo;
  if (holders.length === 0) return combo.levelName;
  const names = holders.slice(0, 2).map((h) => h.name);
  if (holders.length > 2) names.push(`+${holders.length - 2} more`);
  return names.join(' · ');
};

/**
 * `objectName` carries its own code — "527 · Construction, CMAR / GMP" — but the code
 * is already the fourth segment of the key, so a name line only needs the words.
 */
export const objectWords = (combo: Combo): string => {
  const prefix = `${combo.object} · `;
  return combo.objectName.startsWith(prefix) ? combo.objectName.slice(prefix.length) : combo.objectName;
};
// ---------------------------------------------------------------- identity check

export interface ComboFlag {
  /** Words taken from the level's name that were searched for in its own lines. */
  tokens: string[];
  /** Lines scanned. */
  scanned: number;
  /** A description that never mentions the level — shown so the reader can judge. */
  sample: string;
}

/** Words that are true of too many projects to prove anything. */
const GENERIC = new Set([
  'the',
  'and',
  'for',
  'of',
  'project',
  'renovation',
  'renovations',
  'phase',
  'site',
]);

const tokensOf = (name: string): string[] =>
  name
    .split(/[–—·(]/)[0]
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !GENERIC.has(w));

const flagCache = new Map<string, ComboFlag | null>();

/**
 * The level's name is app-native — it was not read off the combination. So for a
 * combination sitting on a named level but not itself bound, it is worth asking
 * whether the level's own order descriptions back the name up. When not one of them
 * mentions any distinctive word of the name, the binding decision rests on the level
 * code alone and deserves a second look.
 *
 * Returns null when there is nothing to question: the level is unnamed, the name is
 * already attested, the name has no usable words, or at least one line does mention
 * the level.
 *
 * `holders` answers the question outright when the two registers agree: a holder with
 * `source: 'both'` merged the level's written name with a name read out of the prose,
 * so the name *is* in the lines by construction and there is nothing to flag. Only
 * when no such holder exists does the token scan earn its keep.
 */
export function comboFlag(combo: Combo): ComboFlag | null {
  const cached = flagCache.get(combo.key);
  if (cached !== undefined) return cached;

  const attested = combo.holders.some((h) => h.source === 'both');

  let flag: ComboFlag | null = null;
  if (combo.levelClaimed && !attested) {
    const tokens = tokensOf(combo.levelName);
    if (tokens.length > 0) {
      const hit = combo.rows.some((r) => {
        const text = r.description.toLowerCase();
        return tokens.some((t) => text.includes(t));
      });
      if (!hit) {
        flag = {
          tokens,
          scanned: combo.rows.length,
          sample: combo.rows[0]?.description ?? '',
        };
      }
    }
  }

  flagCache.set(combo.key, flag);
  return flag;
}
