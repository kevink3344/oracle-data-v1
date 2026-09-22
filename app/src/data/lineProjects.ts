/**
 * Projects read off the purchase-order lines themselves.
 *
 * Oracle has no project table. The only place a project identity appears in the
 * extract is the free-text `DESCRIPTION` of a PO line, and it appears in prose:
 *
 *   "GARNER HS TRACK REPLACEMENT - 0004 - CONSTRUCTION CONTRACT FOR REMOVAL & …"
 *   "LOCKHART ES-RENO - CMAR-GMP #2"
 *   "FUQUAY VARINA ES-RENO (PR-22-030) - GMP#2 FOR PHASE ONE OF THE …"
 *   "CMAR-GMP #1 CONSTRUCTION"
 *
 * This module turns that text into a project name where it can, and returns null
 * where it cannot, so the caller can fall back to the level's own identity. The
 * fallback is not failure — it is the honest answer for the accounting boilerplate
 * that names a contract rather than a site.
 *
 * Measured against the 2,781 live lines of `data/oracle/full-output.json`:
 *
 *   395 lines (14%)  name a project  — $181.4M of $430.6M
 *   2,386 lines      fall through   — $249.2M, dominated by `CMAR-GMP` text on the
 *                                     very levels `projectMeta.ts` already names
 *
 * The 14% is not a shortfall. A line that says `CMAR-GMP #1 CONSTRUCTION` is naming a
 * contract, not a site, and the level it books to already carries the site's name.
 *
 * Those 395 lines resolve to 245 projects over 252 of the extract's 328
 * combinations; 39 projects are stitched together from more than one spelling and
 * 52 combinations carry more than one project. Both of those are the point: a
 * combination is *not* a project boundary, and a project is *not* one combination.
 */

import type { ExtractLine } from './types';

export interface LineProject {
  /**
   * The merge key. Punctuation-free and abbreviation-folded, so
   * `LOCKHART ES-RENO` and `Lockhart ES – Renovation` are one project — which is
   * also what lets a derived project collapse onto a name from `projectMeta.ts`.
   */
  canon: string;
  /** The shortest spelling seen, which is the least cluttered one. */
  name: string;
  /** Every spelling that merged into this project, for the "drawn from" note. */
  spellings: string[];
  lines: number;
  orders: number;
  vendors: number;
  amount: number;
  /** Work-package numbers seen on its lines: `0001` design, `0004` construction. */
  packages: string[];
  /** The seven-segment keys its lines land on. More than one is normal. */
  combos: string[];
  levels: string[];
  first: string;
  last: string;
  /**
   * How much of the project sits on each combination. A project's committed total
   * is spread across every combination it touches, so a combination panel has to
   * read the share and not the whole — otherwise two combinations both claim the
   * same $55M.
   */
  byCombo: Record<string, { amount: number; lines: number; orders: number; packages: string[] }>;
}

// ------------------------------------------------------------------ the text

/** The first non-blank line of a description — the part that usually names the job. */
const head = (description: string): string =>
  (description ?? '')
    .split('\n')
    .map((s) => s.trim())
    .find(Boolean) ?? '';

/** Upper-cased, single-spaced, and stripped of the extract's dangling separators. */
const tidy = (s: string): string =>
  s
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–:]+|[\s\-–:]+$/g, '')
    .trim();

/**
 * The merge key. `RENO`/`RENOS`/`RENOVATIONS` all fold to `RENOVATION` because the
 * extract uses all three for the same work; every other difference is punctuation.
 */
export const canonName = (name: string): string =>
  tidy(name)
    .replace(/\bRENOVATIONS\b/g, 'RENOVATION')
    .replace(/\bRENOS?\b/g, 'RENOVATION')
    .replace(/[^A-Z0-9]/g, '');

// ------------------------------------------------------------ what is a name

/**
 * A campus, not a thing. Deliberately short: `HIGH`, `PARK`, `DR`, `CT`, `LN` and
 * `ST` were all tried and all produced furniture — "COLUMBIA OMNIA 17.5\" HIGH",
 * "DR-36-50 - RACK-IT". `ROAD` and `DRIVE` are kept because "MARSHBURN ROAD ED
 * (E-57)" and "DAVIS DRIVE ES" have no other site token.
 */
const SITE =
  /\b(ES|MS|HS|ELEMENTARY|MIDDLE|SCHOOL|ACADEMY|CAMPUS|COLLEGE|CENTRE|CENTER|ROAD|STREET|DRIVE|PARKWAY|PKWY|AVENUE|BOULEVARD|BLVD|PRE-K)\b/;

/** Headings that describe *work* or a *contract*, never a place. */
const NOT_A_PROJECT =
  /^(GMP|CMAR|DPCO|DESIGN|MISC|OFFSITE|ONSITE|BOILER|CHILLER|FURNITURE|MOVING|FREIGHT|TAX|INTEREST|CONTINGENCY|PROGRAM|FACILITY|CAPITAL|AIPHONE|ALPHONE|SAFETY|PURCHASE|INVINCIBLE|MODEL|RECONCILIATION|CONSTRUCTION|DEMO|ABATEMENT|TESTING|INSPECTION|FINAL|GENERAL|PARTIAL|RACK|SHELF|SHELVES|REPAVE)/i;

/** What follows a `GMP #1 -` prefix when the prefix names a phase rather than a site. */
const GENERIC_TAIL =
  /^(FOR|OF|PHASE|CONSTRUCTION|DEMO|RECONCILIATION|BID|PACKAGES|MISC|COSTS|SPECIAL|INSPECTIONS|FINAL|GENERAL|PARTIAL|SITE|WORK|SERVICES|ADDITIONAL)\b/i;

/** `CMAR-GMP #1 - <name>`, `GMP-02 - <name>`, `GMP #1 - <name>`. */
const GMP_PREFIX = /^(?:CMAR\s*[-–]?\s*)?GMP\s*(?:#|NO\.?)?\s*\d*\s*(?:[-–]\s*)?(.+)$/i;

/**
 * `<name> - DESIGN SERVICES…`, `<name> - CMAR-GMP #2`, `<name> - MISC COSTS…`.
 * The separator needs whitespace on **both** sides: without that, the hyphen in
 * `NON-CMAR GENERAL CONTRACT` splits a perfectly good name into `… - NON`.
 */
const SCOPE_TAIL = /^(.*?)\s+[-–]\s+(?:DESIGN|GMP|CMAR|MISC|DPCO|OFFSITE|ONSITE)\b/i;

/**
 * `<name>-0004 - scope` and `<name> 0004 - scope`. Anchored at the end with `\s*$`
 * so that `FUQUAY VARINA ES-RENO (PR-22-030)` does not split at the `-22` of the
 * reference code and leave the name as `FUQUAY VARINA ES-RENO (PR`.
 */
const PACKAGED = [
  /^(.*?)\s*[-–]\s*0*(\d{1,4})(?:\s+[-–]\s*(.*))?\s*$/,
  /^(.*?)\s+0*(\d{1,4})(?:\s+[-–]\s*(.*))?\s*$/,
];

const balanced = (name: string): boolean =>
  (name.match(/\(/g) ?? []).length === (name.match(/\)/g) ?? []).length;

/**
 * Three things separate a name from a part number: it does not start with a digit
 * (`2877 - COLUMBIA OMNIA`, `55 SCHOOL REASSESS`), it does not end on a lone
 * capital (`… - PARKSIDE MS M-19` cuts to `… PARKSIDE MS M`), and it has at least
 * two words with six letters between them (`3826`, `MODEL`, `E-57-NEW`).
 */
const looksLikeName = (name: string): boolean =>
  /\D/.test(name[0] ?? '1') &&
  !/\s[A-Z]$/.test(name) &&
  balanced(name) &&
  name.split(' ').filter((w) => /[A-Z]/.test(w)).length >= 2 &&
  name.replace(/[^A-Z]/g, '').length >= 6;

const acceptable = (name: string): boolean =>
  looksLikeName(name) && SITE.test(name) && !NOT_A_PROJECT.test(name);

// ------------------------------------------------------------------- parser

/**
 * The project a PO line names, or null when the line names only a contract.
 *
 * The order matters. The `GMP #1 - <site>` prefix is tried first because it is the
 * one shape where the name follows the accounting token; the scope tail is tried
 * second because `FUQUAY VARINA ES-RENO (PR-22-030) - GMP#2 …` has to be cut before
 * the `-22` of the reference code is mistaken for a package number.
 */
export function parseProjectName(description: string): { name: string; pkg: string | null } | null {
  const text = tidy(head(description));
  if (!text) return null;

  const gmp = text.match(GMP_PREFIX);
  if (gmp) {
    const tail = tidy(gmp[1]);
    // A `GMP` head either carries a site or it does not. Nothing follows it, so
    // there is no second chance and no point widening the test.
    return acceptable(tail) && !GENERIC_TAIL.test(tail) ? { name: tail, pkg: null } : null;
  }

  const scope = text.match(SCOPE_TAIL);
  if (scope) {
    const name = tidy(scope[1]);
    if (acceptable(name)) return { name, pkg: null };
  }

  for (const rule of PACKAGED) {
    const match = text.match(rule);
    if (!match) continue;
    const name = tidy(match[1]);
    if (!acceptable(name)) continue;
    return { name, pkg: (match[2] ?? '').padStart(4, '0') };
  }

  // A bare name with no package number and no reference code: `LIGON MS-RENO`,
  // `FUQUAY VARINA ES-RENO`. Any digit at all disqualifies it, which is what keeps
  // this rule from swallowing the part numbers the earlier rules exist to reject.
  if (!/\d/.test(text) && acceptable(text)) return { name: text, pkg: null };

  return null;
}

// ------------------------------------------------------------------ grouping

/** Every project the extract's line text can name, largest commitment first. */
interface ComboShare {
  amount: number;
  lines: number;
  orders: Set<string>;
  packages: Set<string>;
}

interface Acc {
  canon: string;
  name: string;
  spellings: Set<string>;
  packages: Set<string>;
  levels: Set<string>;
  orders: Set<string>;
  vendors: Set<string>;
  byCombo: Map<string, ComboShare>;
  lines: number;
  amount: number;
  first: string;
  last: string;
}

/** Every project the extract's line text can name, largest commitment first. */
export function deriveLineProjects(lines: ExtractLine[]): LineProject[] {
  const acc = new Map<string, Acc>();

  for (const line of lines) {
    const parsed = parseProjectName(line.description);
    if (!parsed) continue;

    const canon = canonName(parsed.name);
    let project = acc.get(canon);
    if (!project) {
      project = {
        canon,
        name: parsed.name,
        spellings: new Set(),
        packages: new Set(),
        levels: new Set(),
        orders: new Set(),
        vendors: new Set(),
        byCombo: new Map(),
        lines: 0,
        amount: 0,
        first: line.orderDate,
        last: line.orderDate,
      };
      acc.set(canon, project);
    }

    // The shortest spelling is the least cluttered one, and ties keep the first seen.
    if (parsed.name.length < project.name.length) project.name = parsed.name;
    if (parsed.pkg) project.packages.add(parsed.pkg);
    project.spellings.add(parsed.name);
    project.levels.add(line.level);
    project.orders.add(line.orderNumber);
    project.vendors.add(line.vendor);
    project.lines += 1;
    project.amount += line.amount;
    if (line.orderDate < project.first) project.first = line.orderDate;
    if (line.orderDate > project.last) project.last = line.orderDate;

    let share = project.byCombo.get(line.combinationKey);
    if (!share) {
      share = { amount: 0, lines: 0, orders: new Set(), packages: new Set() };
      project.byCombo.set(line.combinationKey, share);
    }
    share.amount += line.amount;
    share.lines += 1;
    share.orders.add(line.orderNumber);
    if (parsed.pkg) share.packages.add(parsed.pkg);
  }

  return [...acc.values()]
    .map(({ spellings, packages, levels, orders, vendors, byCombo, ...project }) => ({
      ...project,
      spellings: [...spellings].sort(),
      packages: [...packages].sort(),
      levels: [...levels].sort(),
      orders: orders.size,
      vendors: vendors.size,
      combos: [...byCombo.keys()].sort(),
      byCombo: Object.fromEntries(
        [...byCombo.entries()].map(([key, share]) => [
          key,
          {
            amount: share.amount,
            lines: share.lines,
            orders: share.orders.size,
            packages: [...share.packages].sort(),
          },
        ]),
      ),
    }))
    .sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
}
