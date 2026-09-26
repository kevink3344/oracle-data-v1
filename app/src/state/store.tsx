import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useSearchParams } from 'react-router-dom';
import { loadExtract, type ExtractSource } from '../data/extract';
import { loadProjectRegistry, metaByLevel, unassociated, type RegistryRow } from '../data/projectMeta';
import { loadActivityToday, type ActivityToday } from '../data/activity';
import { deriveMonths, deriveProjects, deriveSummary, constantSegments, type MonthPoint } from '../data/derive';
import { buildCombos, type Combo } from '../data/combos';
import { clampToHoldings, inScope, isFullScope, parseScope, scopeParams, type Scope } from '../data/scope';
import { useSession } from '../data/session';
import { sortRows, type SortColumn, type SortState } from '../data/sort';
import type { ExtractLine, ExtractSummary, Project } from '../data/types';

/**
 * A facet is a single-checkbox filter over the project list. `named` is the
 * default because only ten of the extract's 139 levels carry a project record —
 * the other 129 are levels nobody has claimed, which the plan treats as the
 * normal starting state rather than missing data. The remaining levels are not
 * nameless, though: see `namesByLevel` in `derive.ts`.
 *
 * **The seven members are all in `FACETS` below, and that is a change.** `capital`
 * and `relocation` used to exist in this type — and in `FACET_LABEL`, in
 * `facetCounts` and in the `visible` switch — while being absent from the array
 * the table iterates. The only things that could apply them were two buttons in
 * the rail's Funding group, which is precisely the oddity §7 of
 * `docs/plans/menu-groups.md` removed: a control whose handler called `setFacet`
 * and then navigated to `/projects` is a filter *on* `/projects`, not a
 * destination. Moving the control here without adding these two members would
 * have deleted two working filters with no error anywhere, which is the failure
 * this comment exists to prevent from coming back.
 */
export type Facet = 'named' | 'all' | 'active' | 'dormant' | 'capital' | 'operating' | 'relocation';

/**
 * The order the chips appear in: how a level is recorded, then how it is doing,
 * then what it is for. `all` sits second rather than last because clearing the
 * filter is the second thing anyone reaches for.
 */
export const FACETS: Facet[] = [
  'named',
  'all',
  'active',
  'dormant',
  'capital',
  'operating',
  'relocation',
];

export const FACET_LABEL: Record<Facet, string> = {
  named: 'Named',
  all: 'All levels',
  active: 'Active',
  dormant: 'Dormant',
  capital: 'Capital',
  operating: 'Has operating',
  relocation: 'Relocation',
};

/**
 * The five columns of the levels table, in the order they are shown.
 *
 * One list drives the headings, their alignment and the sort — the arrangement
 * `COLUMNS` already has on the invoices, checks and purchase orders registers, so
 * a column cannot appear in a table without a heading or gain a heading with no
 * order behind it.
 *
 * ★ IT LIVES BESIDE `FACETS` RATHER THAN INSIDE `ProjectTable` BECAUSE THE ORDER IS
 *   PART OF WHAT `visible` IS. `visible` is documented as what the table renders,
 *   and it is now that list *in the order it renders it*, so the store — which
 *   builds the array — is where the comparator has to be able to find it. Keeping
 *   a second copy in the component would leave the page with two lists to hold in
 *   step, which is the exact failure one `COLUMNS` array per table prevents.
 *
 * ★ TWO COLUMNS ARE ORDERED BY A VALUE THE CELL DOES NOT PRINT, and both are rule 1
 *   of `data/sort.ts`:
 *
 *   - **Level / project orders on the name, not on `CC-0450`.** The code is a level
 *     number wearing a prefix, so its text order is the account order — which is
 *     what `deriveProjects` already uses to break ties, and not what a reader
 *     scanning a list of projects means by "A to Z". A level whose own lines name
 *     nothing has an empty name, which rule 2 places last in both directions: it
 *     has no name to sort by, which is a different fact from a name that starts
 *     with `A`.
 *   - **Status orders on `active` / `dormant`, not on the chip's label.** The chip
 *     is presentation; if it were ever reworded the order would silently change.
 */
export const PROJECT_COLUMNS: SortColumn<Project>[] = [
  {
    key: 'level',
    label: 'Level / project',
    value: (p) => p.name,
    // Named rather than generated: `orderPhrase` lowercases the label, and
    // "sorted by level / project, A to Z" is a heading read out as a sentence.
    order: { asc: 'sorted by project, A to Z', desc: 'sorted by project, Z to A' },
  },
  {
    key: 'status',
    label: 'Status',
    value: (p) => p.status,
    order: { asc: 'sorted by status, active first', desc: 'sorted by status, dormant first' },
  },
  { key: 'capital', label: 'Capital', numeric: true, value: (p) => p.capital },
  { key: 'operating', label: 'Operating', numeric: true, value: (p) => p.operating },
  { key: 'committed', label: 'Committed', numeric: true, value: (p) => p.committed },
];

/**
 * The order the levels table opens in: the largest commitment first.
 *
 * ★ THIS IS THE REGISTER'S OWN ORDER, AND THAT IS THE WHOLE REASON IT IS WRITTEN AS A
 *   SORT. `deriveProjects` ends on `committed DESC, level ASC`, so `sortRows` applied
 *   to `visible` with this state returns the array it was handed — in the order the
 *   page has always shown. Rule 3 of `data/sort.ts` therefore holds on the first
 *   render: the view the page opens with is an expressible sort rather than a
 *   nameless "no order yet" state, and two clicks on Committed come back to it.
 */
export const LARGEST_COMMITMENT_FIRST: SortState = { key: 'committed', dir: 'desc' };

/**
 * The search terms, ANDed. Every word has to appear somewhere on the project —
 * in its own fields or on one of its purchase-order lines — which is what a
 * reader expects of a single search box and needs no syntax to explain. The
 * object page's table filter reads its input the same way, so the app has one
 * search behaviour rather than two.
 */
function termsOf(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * The lines behind a search hit, and how much they actually prove.
 *
 * `exact` means one of these lines carries every search term, so the block can
 * assert the match. When it is false the terms are only spread across the lines
 * — two words, two different lines — and the block can do no more than point at
 * where they are.
 */
export interface LineMatch {
  lines: ExtractLine[];
  exact: boolean;
}

type Status = 'loading' | 'ready' | 'error';

interface StoreValue {
  status: Status;
  error: string | null;
  reload: () => void;

  lines: ExtractLine[];
  projects: Project[];
  months: MonthPoint[];
  summary: ExtractSummary | null;

  /**
   * The project master, as the server sent it. Empty when it could not be read,
   * which is survivable rather than fatal — see `registryError`.
   */
  registry: RegistryRow[];
  /**
   * Projects that are recorded but carry no account level — "the codes come
   * later". A third state beside claimed and unclaimed: an unclaimed *level* is one
   * nobody has named, whereas one of these is a project nobody has *placed*, so it
   * has no level to appear under and is absent from `projects` by construction.
   */
  uncoded: RegistryRow[];
  /**
   * The subset of `uncoded` the search box keeps — all of it when the box is empty.
   * Rendered as its own list beside the level table rather than as extra rows in
   * it; see the note on the memo that builds it.
   */
  uncodedShown: RegistryRow[];
  /**
   * Why the registry is empty, or null when it loaded. The app is fully usable with
   * this set: the extract still names every level from its own purchase-order lines.
   * What is missing is only the human annotation — site, owner, note.
   */
  registryError: string | null;
  /**
   * Re-reads the project master after a write.
   *
   * Distinct from `reload`, which retries the extract as well and would blank the
   * table while it does. A save changes one row in an app-owned table; this is the
   * request that goes and gets it.
   */
  reloadRegistry: () => void;

  /**
   * How much changed in the database on the server's own today, for the rail badge.
   *
   * ★ `null` IS THE LOADING STATE AND ALSO THE FAILURE STATE, DELIBERATELY. The rail
   *   renders `—` for both, which is the state it already uses for "not loaded".
   *   `0` is a real answer — a database where nothing happened today — and a badge
   *   that showed it while the request was still in flight would be the
   *   always-zero trap this app has already been bitten by once. A caller that
   *   needs to tell "not yet" from "failed" reads `activityError`.
   */
  activity: ActivityToday | null;
  /** Why the count is unreadable, or null. A note, never a full-page error. */
  activityError: string | null;
  /** Re-reads the count. Called after a write, so the badge keeps up. */
  reloadActivity: () => void;
  /**
   * Every account combination the extract carries, with the projects read off
   * its own purchase-order lines.
   *
   * In the store rather than in each component because building it is a walk
   * over all 2,782 lines, and two components now need the same answer: the
   * cost-centre picker, and the set of levels that are already spoken for.
   * Computing it twice would be both slower and two chances to disagree.
   */
  combos: Combo[];
  /**
   * The account levels a recorded project already holds.
   *
   * ★ THIS IS THE EXCLUSION LIST, AND IT IS KEYED BY LEVEL, NOT BY COMBINATION.
   *   One level funds one project at a time, so the *whole* level is spoken for —
   *   not merely the single combination its `code` names. `Combo.claimed` marks
   *   that one combination and `Combo.levelClaimed` marks the level; neither is
   *   the same as "another project holds this level", which is a fact about the
   *   registry. Derived from the registry so it is right the moment a bind lands,
   *   without waiting for a page reload.
   */
  takenLevels: Set<string>;

  /** Projects after the search box, before the facet. */
  searched: Project[];
  /**
   * Projects after the search box, the facet **and the sort** — what the table renders,
   * in the order it renders it.
   */
  visible: Project[];
  facet: Facet;
  setFacet: (f: Facet) => void;
  facetCounts: Record<Facet, number>;
  /**
   * The order the levels table is in — the third thing `visible` is made of.
   *
   * ★ IT IS IN THE STORE RATHER THAN IN `ProjectTable` BECAUSE THE ORDER BELONGS TO THE
   *   LIST, NOT TO THE TABLE. `facet` is the precedent: a control on `/projects` that
   *   reads a different array from the one the table renders is how a page comes to
   *   disagree with itself. There is exactly one sorted array, `visible`, and every
   *   reader of it — the rows, the footer totals, the panel count — sees the order the
   *   reader chose.
   */
  projectSort: SortState;
  setProjectSort: (next: SortState) => void;

  query: string;
  setQuery: (q: string) => void;
  /**
   * The purchase-order lines that explain why a level survived the search. Only
   * levels whose own name, code, site and owner fall short of the terms get an
   * entry: a row that matches on its face needs no footnote.
   */
  matchReasons: Map<string, LineMatch>;

  /**
   * Which fund and which programs every page is showing.
   *
   * ★ THE SCOPE IS PART OF THE STORE BECAUSE IT IS PART OF THE DATA, NOT PART OF A PAGE. `lines` is
   *   already the scoped set by the time anything reads it, so a screen that renders the scope is
   *   describing what it was handed rather than choosing a filter. The rule itself is written once,
   *   in `data/scope.ts`.
   */
  scope: Scope;
  setScope: (next: Scope) => void;
  toggleProgram: (program: string) => void;
  resetScope: () => void;
  /**
   * ★ THE TENANT THE SCOPE COMES FROM — the `organization` row, read off the session.
   *
   * The register, the chips and the popover are all describing *this* configuration rather than a
   * literal in the bundle, which is the difference between a Settings page that means something and
   * one that only records an intention. `null` only while no session has landed, which the login gate
   * makes unreachable for a rendered page.
   */
  scopeTenant: ScopeTenant | null;
  /**
   * Which source answered, and why it was not the live ledger.
   *
   * ★ THE ONLY REASON A PAGE THAT NAMES THE SCOPE NEEDS THIS. `scopeStats.programsPresent` measures
   *   what the served document actually holds; this says whether that document is the ledger or the
   *   bundled snapshot, which is the difference between "the scope holds 861 lines and this read found
   *   none" and "this snapshot has never held any". Without it the shortfall has no explanation, and a
   *   sentence that reports one without the other reads as missing data rather than as a fallback.
   */
  extractSource: ExtractSource | null;
  /** Is the selection every program the organization holds? What makes Reset idle. */
  scopeIsFull: boolean;
  /** What the scope kept, what it removed and what was in the extract — never a silent subtraction. */
  scopeStats: ScopeStats;
  /**
   * The segments that hold a single value across the *scoped* lines, measured.
   *
   * Replaces the `CONSTANT_SEGMENTS` literal that `taxonomy.ts` exported: a static map describing the
   * data one control could not change. Anything that says "fixed" now says it about the rows actually
   * on screen, and stops saying it the moment they change.
   */
  constants: Record<string, string>;
}

/**
 * The organization the scope is configured by, as the components that *describe* the scope need it.
 *
 * ★ `name` IS HERE FOR ONE SENTENCE AND THAT IS NOT A REASON TO LEAVE IT OUT. The popover's foot used
 *   to say *"Fund is a stated constant, not a choice, because the extract carries exactly one"* — true
 *   of a bundle built with `04` baked in, and a non-answer the moment the fund is an editable field.
 *   Naming the organization is what turns that sentence back into information: it says *whose*
 *   configuration is being applied, which is the only thing that makes an unexpected fund explainable.
 *
 * ★ IT IS NOT `SessionOrganization` RE-EXPORTED. That type is the wire's, it arrives as a whole user
 *   and it changes identity on every session notification; this is the four primitives the scope
 *   actually reads, which is what lets `scope` and `programTotals` memoise on values instead of on an
 *   object.
 */
export interface ScopeTenant {
  /** `organization.name`, for the panel to say which configuration this is. */
  name: string;
  /** Segment 1 — the fund this tenant is scoped to. */
  fund: string;
  /** Segment 3 values this tenant holds, in the order it offers them. */
  programs: string[];
  /** The fiscal year this tenant's window opens on. */
  startFy: number;
}

/**
 * What the account scope kept and what it cost.
 *
 * ★ WHY THE EXTRACT'S OWN TOTALS ARE CARRIED RATHER THAN RECOMPUTED FROM `lines`. `all` and
 *   `excluded` can only be answered from the unfiltered rows, which the store deliberately keeps
 *   private. A screen that wanted to say "0 of 2,782 rows removed" by subtracting what it could see
 *   would need the raw set to do it — and the only reason it would want the raw set is to describe
 *   the filter, which is what this object is for.
 */
export interface ScopeStats {
  /** Rows in the served extract, before the scope. */
  all: number;
  /** Rows the scope kept — the length of `lines`. */
  shown: number;
  /** Rows the scope removed. **Zero on the served extract.** */
  excluded: number;
  /** The committed value of those rows. */
  excludedValue: number;
  /** Funds present in the extract, so a heading never has to name one. */
  fundsPresent: string[];
  /** Programs present in the extract — what the empty state reports when a selection removes everything. */
  programsPresent: string[];
  /**
   * Every program the extract holds, with its own line count and committed value.
   *
   * ★ MEASURED OVER THE *UNFILTERED* ROWS, NOT THE SCOPED ONES, AND THE DIFFERENCE IS THE WHOLE
   *   POINT. A chip for a program the reader has switched *off* would otherwise report zero, which
   *   reads as "this program has no data" rather than "you are currently hiding it" — and those
   *   are the two things a scope control exists to tell apart. Ordered by the **organization's own
   *   program list** first, in its stored order, then anything else the extract holds, so an
   *   unrecognised program is reported rather than dropped. The order is the tenant's rather than
   *   this module's, which is why the list cannot be built until the session has arrived.
   */
  programTotals: { program: string; lines: number; value: number }[];
}

const StoreContext = createContext<StoreValue | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  /**
   * The extract exactly as served — every row, unfiltered.
   *
   * ★ NAMED `rawLines` DELIBERATELY, AND ONLY THE FETCH MAY TOUCH IT. `lines` below is the same
   *   array put through the account scope, and `lines` is what every consumer in the app reads.
   *   The rename exists to make one specific mistake impossible: a screen that reaches for the raw
   *   set to "get all the data" and quietly steps outside the scope the reader set. The only two
   *   legitimate uses are measuring what the scope removed and reading which segments the extract
   *   actually contains, and both of those are done here.
   */
  const [rawLines, setRawLines] = useState<ExtractLine[]>([]);
  /**
   * ★ WHERE THE SERVED DOCUMENT CAME FROM — and it is in the store for a scope reason, not a
   *   diagnostics one.
   *
   *   The bundled snapshot this app falls back to holds **program `862` only** (2,782 rows,
   *   $430,569,026.92) while the account scope asks for programs `861` and `862` (23,224 rows,
   *   $2,697,813,470.53). A page that names its scope therefore cannot be honest without this: it has
   *   to be able to say that the document it was handed is *narrower* than the scope it is describing.
   *   `scopeStats.programsPresent` measures the shortfall; this field explains it.
   *
   *   `null` only while loading or when the server answered without a provenance block.
   */
  const [extractSource, setExtractSource] = useState<ExtractSource | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [registryAttempt, setRegistryAttempt] = useState(0);
  const [registry, setRegistry] = useState<RegistryRow[]>([]);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const [activityAttempt, setActivityAttempt] = useState(0);
  const [activity, setActivity] = useState<ActivityToday | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [query, setQueryRaw] = useState('');
  const [facet, setFacet] = useState<Facet>('named');
  const [projectSort, setProjectSort] = useState<SortState>(LARGEST_COMMITMENT_FIRST);

  /**
   * Typing a search clears the facet.
   *
   * `named` is the default because only ten levels carry a project record, but that
   * default must never be allowed to answer a search: pressing `Named` and then typing
   * "garner" leaves one row on the page while five levels mention Garner, and the page
   * reads as though the search had failed. The facet chips stay where they are, so a
   * reader who wants to narrow the answer presses one *after* asking.
   */
  const setQuery = useCallback((next: string) => {
    if (next.trim() !== '') setFacet('all');
    setQueryRaw(next);
  }, []);

  const [params, setParams] = useSearchParams();

  /**
   * ★ THE OPEN PROJECT IS NO LONGER STORE STATE, AND THAT IS THE POINT OF THE CHANGE.
   *
   *   `selected` / `selectedLevel` / `selectLevel` existed to drive the sliding detail panel: the
   *   panel was rendered once by the shell and the store held *which* project it described. The
   *   detail is a page now (`/projects/:level`), so the URL carries the selection and the route
   *   reads it — there is nothing for the store to hold, and a second copy of it here would be a
   *   state that could disagree with the address bar.
   *
   *   `params` stays: the account scope is still URL-driven, and it is a refinement of the page a
   *   reader is standing on rather than a navigation away from it.
   */

  /**
   * ★ THE TENANT THE SCOPE IS READ FROM, AND WHY IT IS READ HERE RATHER THAN ON A PAGE.
   *
   * The configuration is a row in `organization`. Every session the server issues carries one —
   * `SessionUser.organization`, beside `organizationName` — so the store takes it from the session it
   * is already subscribed to and no screen has to fetch it. **Settings is where the row is edited; this
   * is where it is obeyed**, and they are the same row, which is the whole point of the change.
   *
   * ★ IT IS TAKEN APART INTO PRIMITIVES BEFORE IT IS USED AS A MEMO DEPENDENCY. `useSession` hands back
   *   a fresh user object on every store notification, so depending on the object would rebuild `scope`
   *   on every render and re-filter 2,782 lines each time — the same trap the two parameter strings
   *   below are chosen to avoid. The joined `programs` string is the identity of the list.
   *
   * ★ `authenticated` IS THE TEST, NOT `organization !== null`. The signed-out placeholder in
   *   `data/session.ts` is a whole user with a name and initials; reading the tenant off it because it
   *   happens to be non-null would give a reader who is not logged in a scope they never configured.
   */
  const session = useSession();
  const tenantName = session?.authenticated ? session.organizationName : '';
  const tenantFund = session?.authenticated ? session.organization?.fund ?? '' : '';
  const tenantPrograms = session?.authenticated
    ? (session.organization?.programs ?? []).join(',')
    : '';
  const tenantStartFy = session?.authenticated ? session.organization?.startFy ?? 0 : 0;

  const scopeTenant = useMemo<ScopeTenant | null>(
    () =>
      tenantName
        ? {
            name: tenantName,
            fund: tenantFund,
            programs: tenantPrograms ? tenantPrograms.split(',') : [],
            startFy: Number(tenantStartFy) || 0,
          }
        : null,
    [tenantName, tenantFund, tenantPrograms, tenantStartFy],
  );

  /**
   * The programs the organization holds, as the `Scope` this module filters with.
   *
   * Identity-stable on purpose: `scope` and `programTotals` are both rebuilt from it, so a fresh
   * object here would re-filter the whole extract on every render.
   */
  const holdings: Scope = useMemo(
    () => ({ fund: tenantFund, programs: tenantPrograms ? tenantPrograms.split(',') : [] }),
    [tenantFund, tenantPrograms],
  );

  /**
   * The account scope, carried in the URL so a narrowed view is a link.
   *
   * ★ WHY THE URL AND NOT `useState`. The request asked for shareable and deep-linkable, and the
   *   store already has the precedent: `?project=` above is how the detail drawer is addressed, and
   *   `selectLevel` was written to preserve every param it did not own. Putting the scope beside it
   *   means a link to "program 861 only, this project" is one string, and means the back button
   *   moves through scope changes the way a reader expects a filter to behave.
   *
   *   The two param *strings* are memo dependencies rather than `params` itself: `useSearchParams`
   *   hands back a fresh object on every navigation, so depending on it would rebuild `scope` on
   *   every render and re-filter all 2,782 lines on every keystroke that changed a different param.
   */
  const fundParam = params.get('fund');
  const programsParam = params.get('programs');
  const scope = useMemo(
    () => parseScope(fundParam, programsParam, holdings),
    [fundParam, programsParam, holdings],
  );

  /**
   * The scoped lines, and the three figures that say what the scope cost.
   *
   * ★ THE COUNTS ARE NOT DECORATION. Measured against the served extract, the default scope removes
   *   **0 of 2,782 rows** — every combination key in it is `04-…-862-…`. So on this data the filter
   *   is invisible, and the one thing a reader must never have to guess is whether that is because
   *   the filter works and caught nothing, or because the filter does not work. `all` and `excluded`
   *   travel with the selection and the TopBar prints them, so "0 removed" is a stated result rather
   *   than an absence of evidence.
   *
   * `programsPresent` is read off the *raw* rows so the empty state can say which program the
   * extract actually holds without anyone writing `862` into a sentence. Selecting `861` alone
   * removes all 2,782 lines; the page says why.
   */
  const scoped = useMemo(() => {
    /**
     * ★ NO TENANT ⇒ NOTHING IS FILTERED, AND THAT IS A DEFENSIVE BRANCH RATHER THAN A MODE.
     *
     * Behind the login gate the store is mounted inside `Shell`, inside `Gate`, so a session always
     * exists by the time this runs, and the server puts an organization on every sign-in payload. The
     * branch earns its place because the alternative failure is silent and severe: with an empty fund
     * `inScope` rejects **every** row, so a missing organization would render the whole app as
     * *"0 of 2,782 PO lines — 2,782 removed by scope"* — a lie dressed as a filter result, and one
     * that a reader would reasonably act on. Showing the extract unfiltered and saying so is the honest
     * failure; inventing a configuration is the thing this change exists to remove.
     */
    const active = scopeTenant !== null;
    const kept: ExtractLine[] = [];
    const dropped: ExtractLine[] = [];
    for (const l of rawLines) {
      if (!active || inScope(scope, l.fund, l.program)) kept.push(l);
      else dropped.push(l);
    }

    return {
      lines: kept,
      all: rawLines.length,
      excluded: dropped.length,
      excludedValue: dropped.reduce((a, l) => a + l.amount, 0),
      fundsPresent: [...new Set(rawLines.map((l) => l.fund).filter(Boolean))].sort(),
      programsPresent: [...new Set(rawLines.map((l) => l.program).filter(Boolean))].sort(),
    };
  }, [rawLines, scope, scopeTenant]);

  /**
   * ★ THE ONE ASSIGNMENT THAT MAKES THE SCOPE APPLY TO THE WHOLE APP.
   *
   * Every consumer downstream — `projects`, `combos`, `months`, `summary`, `lineText`, `searched`,
   * `visible`, `facetCounts`, `takenLevels`, `useColumnTotals`, the combination search, the dashboard
   * — reads `lines`, so scoping it once here scopes all of them, including screens that do not exist
   * yet. The alternative, a per-screen filter, is how an app ends up with one page that honours a
   * control and five that pretend not to see it.
   */
  const lines = scoped.lines;

  /**
   * ★ EVERY SELECTABLE PROGRAM, NOT ONLY THE ONES WITH ROWS.
   *
   * This list feeds the popover, which is the page's selection surface. The first version filtered it
   * to the programs that appear in the extract — and on this extract that is only `862`, so the
   * popover listed one row while the control beside the search box showed three chips. A reader who
   * wanted to turn `863` on had a chip for it and no row for it, which reads as the popover being
   * broken rather than the extract being narrow.
   *
   * So every program **the organization holds** is listed whether or not it carries data, each with a
   * real `0`, and the control labels those `no lines in the extract`. Selecting one is allowed and
   * honest: it is a program the tenant's own configuration names. Only programs found in the data
   * but *not* configured are appended after, so a widening extract shows up as an extra row rather
   * than silently disappearing.
   */
  const scopeStats: ScopeStats = useMemo(() => {
    const totals = new Map<string, { lines: number; value: number }>();
    for (const l of rawLines) {
      const entry = totals.get(l.program);
      if (entry) {
        entry.lines += 1;
        entry.value += l.amount;
      } else {
        totals.set(l.program, { lines: 1, value: l.amount });
      }
    }

    const extra = [...totals.keys()].filter((p) => !holdings.programs.includes(p)).sort();

    return {
      all: scoped.all,
      shown: scoped.lines.length,
      excluded: scoped.excluded,
      excludedValue: scoped.excludedValue,
      fundsPresent: scoped.fundsPresent,
      programsPresent: scoped.programsPresent,
      programTotals: [...holdings.programs, ...extra].map((program) => ({
        program,
        ...(totals.get(program) ?? { lines: 0, value: 0 }),
      })),
    };
  }, [scoped, rawLines, holdings]);

  /**
   * Which segments hold a single value **within the current scope** — measured, not stated.
   *
   * Replaces the `CONSTANT_SEGMENTS` literal that `taxonomy.ts` used to export and four screens
   * rendered. Under the served data and the default scope it returns the same four segments the
   * literal named, so no screen moves today; under a scope that admitted program 861 it would stop
   * claiming fund and program are fixed, which is the entire point.
   */
  const constants = useMemo(() => constantSegments(lines), [lines]);

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;

    setStatus('loading');
    setError(null);

    loadExtract(controller.signal)
      .then(({ lines: rows, source }) => {
        if (!alive) return;
        setRawLines(rows);
        setExtractSource(source);
        setStatus('ready');
      })
      .catch((err: unknown) => {
        if (!alive || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
      });

    return () => {
      alive = false;
      controller.abort();
    };
  }, [attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  /**
   * The project master, fetched separately from the extract and **never fatally**.
   *
   * ★ WHY THIS ONE DOES NOT SET AN ERROR STATE THE WAY THE EXTRACT DOES. The extract
   *   is the app: without its 2,782 lines there is nothing to show, so a failure has
   *   to stop the page. The registry is an annotation layer over data that already
   *   exists — every project still appears, still named, still costed, if the request
   *   fails. Turning that into a full-page error would take a working screen and hide
   *   it because a label was unavailable.
   *
   * ★ IT IS EXPECTED TO FAIL ON ORACLE. `project` is an app-owned table and app-owned
   *   tables are SQLite-only, so a server pointed at Oracle answers `503
   *   DB_UNAVAILABLE` here by design. That is not a bug to be worked around; it is the
   *   same rule the View Builder follows, and it is why `registryError` is rendered as
   *   a note rather than as a failure.
   *
   * ★ TWO SIGNALS RE-RUN THIS, AND THAT IS THE POINT. `attempt` is the page-wide
   *   reload and retries both loads. `registryAttempt` retries only this one, and it
   *   is what a *write* uses: recording a project or binding a level changes nothing
   *   in the extract, so re-reading 2,782 lines to see one new row would be work for
   *   nothing — and it would drop the page back to `loading`, blanking the table a
   *   reader was looking at to confirm what they had just saved.
   */
  useEffect(() => {
    const controller = new AbortController();
    let alive = true;

    loadProjectRegistry(controller.signal)
      .then((payload) => {
        if (!alive) return;
        setRegistry(payload.items);
        setRegistryError(null);
      })
      .catch((err: unknown) => {
        if (!alive || controller.signal.aborted) return;
        setRegistry([]);
        setRegistryError(err instanceof Error ? err.message : String(err));
      });

    return () => {
      alive = false;
      controller.abort();
    };
  }, [attempt, registryAttempt]);

  /**
   * Re-reads the project master, and only the project master.
   *
   * Called after a write rather than reloading the page, so the reader stays where
   * they were. The row that was just written comes back from the server, not from a
   * local guess, which is why this refetches instead of patching `registry` in place.
   */
  const reloadRegistry = useCallback(() => setRegistryAttempt((n) => n + 1), []);

  /**
   * How many object counts moved, for the rail badge.
   *
   * ★ IT LOADS ONCE PER ATTEMPT, NOT PER ROUTE, AND THAT IS THE POINT. The badge is
   *   on every page; re-fetching it on navigation would be a request per click to
   *   print a number that changes only when somebody writes. It is re-read on
   *   `reload` (the page-wide retry) and on `activityAttempt`, which a write bumps —
   *   so recording a project makes the badge count it without a page reload.
   *
   * ★ IT NEVER SETS A PAGE ERROR, FOR THE SAME REASON `registryError` DOES NOT.
   *   A 503 here means "nobody can tell you how much changed", a sentence about the
   *   badge. Blanking the Dashboard because the badge could not be read would take a
   *   working screen and hide it over a decoration.
   */
  useEffect(() => {
    const controller = new AbortController();
    let alive = true;

    loadActivityToday(controller.signal).then((payload) => {
      if (!alive) return;
      setActivity(payload);
      setActivityError(
        payload ? null : 'The activity count could not be read, so the rail shows no number.',
      );
    });

    return () => {
      alive = false;
      controller.abort();
    };
  }, [attempt, activityAttempt]);

  const reloadActivity = useCallback(() => setActivityAttempt((n) => n + 1), []);

  const meta = useMemo(() => metaByLevel(registry), [registry]);
  const uncoded = useMemo(() => unassociated(registry), [registry]);

  /**
   * The levels the registry says are held.
   *
   * Blank counts as unheld, matching `metaByLevel` and `unassociated` — all three
   * read `levelCode` the same way, because a supplied table is written by hand and
   * `''` is what a hand-written blank looks like. Reading it differently here
   * would let a project that `metaByLevel` treats as uncoded still block a level.
   */
  const takenLevels = useMemo(() => {
    const taken = new Set<string>();
    for (const row of registry) {
      const level = (row.levelCode ?? '').trim();
      if (level !== '') taken.add(level);
    }
    return taken;
  }, [registry]);


  const projects = useMemo(
    () => (lines.length ? deriveProjects(lines, meta) : []),
    [lines, meta],
  );

  /** Declared after `projects` because it is built from them — a `const` read
   * before its declaration is a thrown error, not `undefined`. */
  const combos = useMemo(
    () => (lines.length ? buildCombos(lines, projects) : []),
    [lines, projects],
  );
  const months = useMemo(() => (lines.length ? deriveMonths(lines) : []), [lines]);
  const summary = useMemo(() => (lines.length ? deriveSummary(lines) : null), [lines]);

  const terms = useMemo(() => termsOf(query), [query]);

  /**
   * The uncoded projects the search box keeps.
   *
   * ★ WHY THESE NEED THEIR OWN MATCH AND THEIR OWN LIST. Nothing above can reach
   *   them. `metaByLevel` drops a row with no account level, deliberately, so it
   *   never enters `projects`, so it never enters `searched` — and a reader who was
   *   told the project exists types its name and the page answers "Nothing
   *   matches". That is a true statement about the extract and a false one about the
   *   app: the project is recorded, the API serves it, and it is invisible only
   *   because every other view here is keyed on a level it does not have yet.
   *
   *   Search is the case that has to work, because the search box is where someone
   *   goes to check whether a thing exists. The terms are matched against the fields
   *   these rows actually carry — name, code, site, owner and the note — plus the
   *   slug, which is their stable identifier. They are NOT matched against
   *   `GL_CODE_COMBINATIONS` codes or purchase-order lines, because an uncoded
   *   project has no level and therefore no lines underneath it; searching a text
   *   that does not exist would be inventing the association the row is waiting for.
   *
   *   An empty box returns all of them rather than none, so the page always accounts
   *   for every row in the project master.
   */
  const uncodedShown = useMemo(() => {
    if (terms.length === 0) return uncoded;
    return uncoded.filter((r) => {
      const text = [r.name, r.code, r.site, r.owner, r.description, r.slug]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return terms.every((t) => text.includes(t));
    });
  }, [uncoded, terms]);

  /**
   * What each level's own row contributes: the four fields the table shows.
   * Held apart from the lines because a row that matches on its face has to be
   * told from one that only matches because of what is underneath it.
   */
  const ownText = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projects) {
      map.set(p.level, [p.name, p.code, p.site, p.owner, p.level].join(' ').toLowerCase());
    }
    return map;
  }, [projects]);

  /**
   * Vendor, buyer, description and order number are line fields — 139 levels
   * share 2,781 lines — so searching them means reading every line and
   * reporting the hit upward to the level that carries it. One lower-cased
   * string per line is built once here and reused by the two passes below
   * rather than being rebuilt inside a filter that runs on every keystroke.
   */
  const lineText = useMemo(() => {
    const map = new Map<ExtractLine, string>();
    for (const l of lines) {
      map.set(l, `${l.vendor} ${l.buyer} ${l.description} ${l.orderNumber}`.toLowerCase());
    }
    return map;
  }, [lines]);

  /** The same text for a whole level, so one project test stays a few `includes`. */
  const byLevelText = useMemo(() => {
    const parts = new Map<string, string[]>();
    for (const l of lines) {
      const text = lineText.get(l) ?? '';
      const list = parts.get(l.level);
      if (list) list.push(text);
      else parts.set(l.level, [text]);
    }
    const joined = new Map<string, string>();
    for (const [level, list] of parts) joined.set(level, list.join(' '));
    return joined;
  }, [lines, lineText]);

  const searched = useMemo(() => {
    if (terms.length === 0) return projects;
    return projects.filter((p) => {
      const own = ownText.get(p.level) ?? '';
      const onLines = byLevelText.get(p.level) ?? '';
      // A term may be satisfied by the level or by any line beneath it, so each
      // term is tested against both and the results are ANDed.
      return terms.every((t) => own.includes(t) || onLines.includes(t));
    });
  }, [projects, terms, ownText, byLevelText]);

  /**
   * Why a row survived, for the rows that cannot say so themselves.
   *
   * Vendor, buyer, description and order number live on the *line*, not on the
   * level, so searching "274310" returns a project whose name, code, site and
   * owner are unrelated to it. Unfootnoted, that row reads as a bug rather than
   * a match. The lines are collected for exactly those levels — a level that
   * matched on its own fields would only be cluttered by them.
   */
  const matchReasons = useMemo(() => {
    const map = new Map<string, LineMatch>();
    if (terms.length === 0) return map;

    // A line can carry every term, which proves the match. It can also carry
    // only some of them — "bordeaux matrix" where one line names the vendor and
    // another names the other — and then no single line proves anything, yet
    // staying silent would leave the row unexplained, which is the one thing
    // this map exists to prevent. Both are collected and the label says which
    // of the two the reader is looking at.
    const exact = new Map<string, ExtractLine[]>();
    const partial = new Map<string, ExtractLine[]>();
    const add = (into: Map<string, ExtractLine[]>, level: string, line: ExtractLine) => {
      const list = into.get(level);
      if (list) list.push(line);
      else into.set(level, [line]);
    };

    for (const l of lines) {
      const text = lineText.get(l) ?? '';
      if (terms.some((t) => text.includes(t))) add(partial, l.level, l);
      if (terms.every((t) => text.includes(t))) add(exact, l.level, l);
    }

    for (const [level, anyLine] of partial) {
      const own = ownText.get(level) ?? '';
      if (terms.every((t) => own.includes(t))) continue;
      const proven = exact.get(level);
      map.set(level, proven ? { lines: proven, exact: true } : { lines: anyLine, exact: false });
    }
    return map;
  }, [lines, terms, ownText, lineText]);

  // Counts describe the search result, not the whole extract, so a chip never
  // promises rows the search has already removed.
  const facetCounts = useMemo<Record<Facet, number>>(
    () => ({
      named: searched.filter((p) => !p.unclaimed).length,
      all: searched.length,
      active: searched.filter((p) => p.status === 'active').length,
      dormant: searched.filter((p) => p.status === 'dormant').length,
      capital: searched.filter((p) => p.capital > 0).length,
      operating: searched.filter((p) => p.operating > 0).length,
      relocation: searched.filter((p) => p.relocation > 0).length,
    }),
    [searched],
  );

  /** Projects after the search box and the facet, before the order. */
  const faceted = useMemo(() => {
    switch (facet) {
      case 'named':
        return searched.filter((p) => !p.unclaimed);
      case 'active':
        return searched.filter((p) => p.status === 'active');
      case 'dormant':
        return searched.filter((p) => p.status === 'dormant');
      case 'capital':
        return searched.filter((p) => p.capital > 0);
      case 'operating':
        return searched.filter((p) => p.operating > 0);
      case 'relocation':
        return searched.filter((p) => p.relocation > 0);
      case 'all':
      default:
        return searched;
    }
  }, [searched, facet]);

  /**
   * The rows the levels table renders, in the order it renders them.
   *
   * ★ THE ORDER IS THE LAST STEP APPLIED AND THE ONLY ONE THAT REMOVES NOTHING. `sortRows`
   *   takes a copy and sorts stably, so the order `deriveProjects` produced is still
   *   underneath as the tiebreak (rule 3 of `data/sort.ts`): every level with no money
   *   ties with every other, and `committed DESC, level ASC` comes back out of a sort on
   *   Committed descending exactly as it went in.
   *
   * ★ IT IS SORTED FROM `faceted`, NEVER FROM THE PREVIOUS RESULT. `faceted` is rebuilt
   *   from `searched` and the facet on every run, so a second click on the same heading
   *   cannot inherit the first click's tie order — the failure rule 3a names.
   */
  const visible = useMemo(
    () => sortRows(faceted, PROJECT_COLUMNS, projectSort),
    [faceted, projectSort],
  );

  /**
   * Write a scope into the URL, keeping every other param.
   *
   * Built from `prev` for the same reason the project link is: the scope and the open project are
   * independent, and a reader who narrows the programs while looking at a project must not lose
   * the project.
   *
   * **`replace: true`, where `selectLevel` uses `replace: false`, and the difference is deliberate.**
   * Opening a project is a navigation — a reader will want to come back out of it. Toggling a chip is
   * a refinement of the page they are standing on, and every click of it being its own history entry
   * would mean six presses of Back to leave a screen nobody moved away from.
   *
   * **A selection equal to the organization's full scope deletes the params instead of writing them.**
   * The comment on `resetScope` gives the reason — one view should have one URL — and this is the same
   * rule reached the other way: switching `863` off and then on again must land back on the bare path,
   * not on `?fund=04&programs=861,862,863`. Without this the two paths to the default state disagree,
   * and the one a reader arrives at by clicking round-trips through a URL nobody wrote.
   *
   * ★ THE SELECTION IS CLAMPED TO THE TENANT *BEFORE* IT IS COMPARED, so the URL and the state can
   *   never describe different things. Comparing first would let a selection naming a program the
   *   organization does not hold look non-default here — writing `?programs=862` — and then be clamped
   *   to the tenant's own list on the way back in. The app would be rendering its full scope under a
   *   URL that asks for one program, which is exactly the drift the URL is supposed to make
   *   impossible.
   */
  const setScope = useCallback(
    (next: Scope) => {
      const chosen = clampToHoldings(next, holdings);
      const full = isFullScope(chosen, holdings);
      const { fund, programs } = scopeParams(chosen);
      setParams(
        (prev) => {
          const out = new URLSearchParams(prev);
          if (full) {
            out.delete('fund');
            out.delete('programs');
          } else {
            out.set('fund', fund);
            out.set('programs', programs);
          }
          return out;
        },
        { replace: true },
      );
    },
    [setParams, holdings],
  );

  /**
   * One chip. Adding keeps the reader's own order until `normalise` sorts the URL.
   *
   * The last program can be switched off — an app that will not let you clear a filter is an app
   * that will not tell you what its data looks like without it. `inScope` reads an empty program
   * list as "the fund alone is the rule", and the TopBar prints the count that follows, so the
   * consequence of clearing them is visible rather than silent.
   */
  const toggleProgram = useCallback(
    (program: string) => {
      const has = scope.programs.includes(program);
      const programs = has
        ? scope.programs.filter((p) => p !== program)
        : [...scope.programs, program];
      setScope({ fund: scope.fund, programs });
    },
    [scope, setScope],
  );

  /**
   * Back to the organization's **full** scope — and back to a clean URL.
   *
   * Deleting the params rather than writing the defaults is what makes the default state addressable
   * by the bare path. `/?fund=04&programs=861,862,863` and `/` would otherwise be two URLs for one
   * view, and only one of them would be the link anyone shares.
   *
   * ★ "FULL" IS THE TENANT'S FULL SELECTION, NOT THIS APP'S. A reader whose organization holds one
   *   program resets to that one; the button is idle when they are already on it, which is what
   *   `scopeIsFull` is for.
   */
  const resetScope = useCallback(() => {
    setParams(
      (prev) => {
        const out = new URLSearchParams(prev);
        out.delete('fund');
        out.delete('programs');
        return out;
      },
      { replace: true },
    );
  }, [setParams]);

  const scopeIsFull = useMemo(() => isFullScope(scope, holdings), [scope, holdings]);

  const value: StoreValue = {
    status,
    error,
    reload,
    lines,
    projects,
    months,
    summary,
    registry,
    uncoded,
    uncodedShown,
    registryError,
    reloadRegistry,
    activity,
    activityError,
    reloadActivity,
    combos,
    takenLevels,
    searched,
    visible,
    facet,
    setFacet,
    facetCounts,
    projectSort,
    setProjectSort,
    query,
    setQuery,
    matchReasons,
    scope,
    setScope,
    toggleProgram,
    resetScope,
    scopeTenant,
    extractSource,
    scopeIsFull,
    scopeStats,
    constants,
  };

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): StoreValue {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('useStore must be used inside <StoreProvider>.');
  return ctx;
}

/** Distinct values of a column, with their totals. Used by the dashboard panels. */
export function useColumnTotals(pick: (l: ExtractLine) => string): {
  key: string;
  amount: number;
  lines: number;
}[] {
  const { lines } = useStore();
  return useMemo(() => {
    const map = new Map<string, { amount: number; lines: number }>();
    for (const l of lines) {
      const k = pick(l);
      const entry = map.get(k);
      if (entry) {
        entry.amount += l.amount;
        entry.lines += 1;
      } else {
        map.set(k, { amount: l.amount, lines: 1 });
      }
    }
    return [...map.entries()]
      .map(([key, v]) => ({ key, ...v }))
      .sort((a, b) => b.amount - a.amount);
  }, [lines, pick]);
}
