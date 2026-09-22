/**
 * The account scope — which fund and which programs this app shows.
 *
 * ★ THIS MODULE NO LONGER WRITES THE RULE DOWN. IT IMPLEMENTS IT.
 *
 * The configuration — which fund, which programs, in what order — is a row in the `organization`
 * table, reached through the session (`SessionUser.organization`) and editable on the Settings page.
 * What is left here is a library of pure functions over a `Scope` it no longer owns: `inScope` decides
 * membership, `parseScope` reconciles a URL against the tenant, `scopeLabel` formats. Nothing in this
 * file knows what the current fund is, so a second tenant needs no second build.
 *
 * ★ WHY IT MOVED, AND WHAT THE MOVE FIXED. The configuration used to be
 *   `export const SCOPE: Scope = { fund: '04', programs: ['861','862','863'] }` — a compile-time
 *   literal. Settings could save a fund and a program list, but no screen ever read that row, so the
 *   register and the popover went on offering `861/862/863` because that was what the bundle had been
 *   built with. The defect was invisible on the seeded data and only observable by editing the
 *   organization: **the chips did not follow the edit, because they were never the row's.**
 *
 * ★ AND THE OTHER HALF OF THE SAME RULE. Everything that reads the scope from a session, the store or
 *   an extract's own envelope still must not write `04` or `862` as a literal. That restriction was
 *   never tidiness: those values were once written as literals in `taxonomy.ts`, `derive.ts`,
 *   `HowBlock.tsx`, `DetailDrawer.tsx` and `Dashboard.tsx`, which was survivable only while nothing
 *   could change them. The moment a row can, five literals become five chances for the app to disagree
 *   with itself — a page showing 861 rows under a heading that says 862.
 *
 * ── WHAT THE SCOPE IS AND IS NOT
 *
 * It narrows **which rows are shown**. It never rewrites a row.
 *
 *   - On the PO register it is a real predicate over the row's own `fund` and `program` fields.
 *   - On the invoices register the same rule was applied **in the extract SQL**, and the file carries
 *     its own `.scope` block saying what it cost — see `invoices.ts`. That block is the authority on
 *     what was applied; this module is the authority on what is *being asked for*. The register page
 *     reconciles the two rather than assuming they agree.
 *   - On registers with no account column — the Activity register — there is nothing to apply it to.
 *     That page says so in prose instead of showing an unfiltered table under a control that appears
 *     to be filtering it. The checks register joins its rows through invoice accounts instead.
 *
 * ── WHAT IS STILL TRUE OF THE SERVED EXTRACT
 *
 * These are measurements of the *data* rather than of the configuration, which is why they outlive the
 * move: they are the numbers that make a narrowed selection's effect legible.
 *
 * Measured against `app/public/oracle/output.json`, the extract the whole app reads. The file holds
 * **2,782 rows**; `extract.ts` drops rows carrying `CANCEL_FLAG = 'Y'` and exactly one does (order
 * 276551, a $0 encumbering-funds placeholder that was recombined), so every count in the app — every
 * `N of M` on every page — is over **2,781 live lines**. Both numbers are stated here because
 * "2,782" appears in this module's history and in the plan doc, and a reader comparing them should not
 * have to work out which of the two the app is on.
 *
 *     FUND         1 distinct   04
 *     PROGRAM      1 distinct   862
 *     COST_CENTER  1 distinct   0840
 *     FUTURE_USE   1 distinct   000
 *     rows failing FUND='04' AND PROGRAM IN ('861','862','863')   →   0 of 2782
 *       … of which live lines (not cancelled)                     →   0 of 2781
 *
 * So the default organization's scope removes **nothing** from the PO register, and selecting `861` on
 * its own would remove **everything** — every combination key in the extract is `04-…-862-…`. That is
 * precisely why the counts travel alongside the selection and why the empty state names its reason. A
 * control that can empty the app silently is worse than no control at all.
 *
 * ★ THE FUND IS STILL A LABEL RATHER THAN A DROPDOWN, AND THAT IS NOW A STATEMENT ABOUT THE TENANT
 *   RATHER THAN ABOUT THE EXTRACT. `ScopeSelect` offers the programs *inside* the tenant and reports
 *   the fund as the boundary the session arrived with. Widening a tenant is a Settings edit, which is
 *   where a change to a tenant belongs; a dropdown beside the search box offering one option would look
 *   like a control and behave like a lie.
 */

/** One selection of the scope. `programs` is unordered; `parseScope` and `normalise` sort it. */
export interface Scope {
  /** Segment 1. Every in-scope account starts with this. */
  fund: string;
  /** Segment 3 values kept. A row is in scope if its program is *any* of these. */
  programs: string[];
}

/**
 * ★ `SCOPE`, `ALL_PROGRAMS` AND `ALL_IN_SCOPE` USED TO BE HERE, AND THEIR ABSENCE IS THE POINT.
 *
 *   `SCOPE` was the configuration — fund `04`, programs `861/862/863` — as a literal, and
 *   `ALL_PROGRAMS` was the universe the chips were drawn from. Both are now the `organization` row. A
 *   grep for `export const SCOPE` under `app/src` must keep returning **nothing**: a constant
 *   reappearing here means the organization has stopped being the authority for the scope.
 *
 *   The program *order* that `SCOPE.programs` carried survives as a parameter. It is stored on the
 *   row instead, and `scopeLabel` is told it rather than reading it — see the note on that function.
 */

/** Sorted and de-duplicated. Used for comparison and for the URL, never for display. */
export const normalise = (scope: Scope): Scope => ({
  fund: scope.fund.trim(),
  programs: [...new Set(scope.programs.map((p) => p.trim()).filter(Boolean))].sort(),
});

/** Two selections are the same scope when they name the same fund and the same program *set*. */
export const sameScope = (a: Scope, b: Scope): boolean => {
  const x = normalise(a);
  const y = normalise(b);
  return x.fund === y.fund && x.programs.join(',') === y.programs.join(',');
};

/**
 * Is this selection every program the organization holds, none switched off?
 *
 * ★ THE QUESTION CHANGED, AND SO DID THE COMPARISON. Signed `isAuthoredScope(scope)` it compared
 *   against the `SCOPE` constant: *"the scope the app was authored with, and the only one that removes
 *   nothing."* The state a reader arrives in is now **their tenant's** full selection, so the function
 *   needs the tenant — there is no answer to "is this the default?" without one.
 *
 * ★ IT IS NOT THE SAME QUESTION AS "removes nothing", AND THE TWO ARE USED IN DIFFERENT PLACES.
 *   "Removes nothing" is a *measurement* — `scopeStats.excluded === 0` — and it is true both for a
 *   tenant whose programs hold every row and for a narrowed selection that happens to exclude no
 *   row. This function is a statement about *configuration*: it is what makes **Reset** idle, because
 *   a button that resets to the selection you are already on is a button that does nothing.
 */
export const isFullScope = (scope: Scope, holdings: Scope): boolean => sameScope(scope, holdings);

/**
 * Narrow a selection to what the organization holds.
 *
 * ★ A HAND-EDITED URL MUST NOT BE ABLE TO ESCAPE THE TENANT EITHER. `parseScope`'s original rule was
 *   that a truncated URL must not be able to empty the app; a tenant adds the mirror of it.
 *   `?programs=999` is not an error and it is not honoured — `999` is simply dropped, exactly as an
 *   unknown program was always dropped from the label, and if that leaves nothing the selection
 *   becomes the tenant's own. A reader asking for a program their organization does not hold has
 *   asked for nothing this app can give them.
 *
 * ★ AND AN EMPTY LIST IS NOT THE SAME AS "NOTHING WAS ASKED FOR". `inScope` reads an empty list as
 *   "the fund alone is the rule", and that is a selection a reader can reach on purpose — the
 *   popover's **Clear programs** button writes exactly it. So an empty list is preserved here rather
 *   than being filled back in. It has to be: `?programs=` used to be re-expanded to the tenant's
 *   programs on the way back in, which made that button appear to work and change nothing. See
 *   `parseScope`, which is where the absent-versus-empty distinction is actually made.
 *
 * The fund is clamped rather than dropped, because it is the tenant's boundary — a URL cannot take the
 * app out of its own fund. When there are no holdings (no tenant is loaded) the fund and the ask are
 * passed through untouched.
 */
export function clampToHoldings(scope: Scope, holdings: Scope): Scope {
  const asked = normalise(scope);
  const fund = holdings.fund.trim() || asked.fund;
  const held = new Set(holdings.programs.map((p) => p.trim()).filter(Boolean));

  if (!asked.programs.length) return normalise({ fund, programs: [] });

  const kept = asked.programs.filter((p) => held.has(p));
  return normalise({ fund, programs: kept.length ? kept : [...held] });
}

/**
 * `Fund 04 · program 861/862/863`.
 *
 * ★ THE PROGRAM ORDER IS PASSED IN, AND IT COMES FROM THE ORGANIZATION ROW. It used to be read off
 *   `ALL_PROGRAMS`, a literal in this module. The order is a property of the *tenant* — it is the order
 *   the organization's own list is stored in, preserved on write precisely so it can be offered and
 *   read in the same sequence — so the caller supplies it and this function holds no opinion about
 *   what the programs are.
 *
 *   The reason the order matters is the one the old comment gave: a heading that reshuffles itself as
 *   a reader toggles chips is a heading nobody can scan. Programs outside the order are appended in
 *   sorted order, which cannot happen against the served extract but keeps the function total.
 *
 * ★ AND THE SEPARATOR IS THE OTHER THING THE ORDER BUYS. `/` means "every program this organization
 *   holds" — the default state, read as a range. A comma means a subset: `Fund 04 · program 861, 862`.
 *   With the order supplied the test is a length comparison; with no order at all the label falls back
 *   to the comma form rather than claiming the selection is everything.
 */
export function scopeLabel(scope: Scope, programOrder: readonly string[] = []): string {
  const chosen = new Set(normalise(scope).programs);
  const order = programOrder.map((p) => p.trim()).filter(Boolean);
  const ordered = order.filter((p) => chosen.has(p));
  for (const p of [...chosen].sort()) if (!ordered.includes(p)) ordered.push(p);

  const fund = normalise(scope).fund || '—';
  if (!ordered.length) return `Fund ${fund} · no program selected`;
  if (order.length > 0 && ordered.length === order.length) {
    return `Fund ${fund} · program ${ordered.join('/')}`;
  }
  return `Fund ${fund} · program ${ordered.join(', ')}`;
}

/** The same label, spoken. `861/862/863` reads as a fraction to a screen reader. */
export function scopeSpoken(scope: Scope): string {
  const chosen = normalise(scope).programs;
  const fund = normalise(scope).fund || 'unknown';
  if (!chosen.length) return `Fund ${fund}, no program selected`;
  if (chosen.length === 1) return `Fund ${fund}, program ${chosen[0]}`;
  return `Fund ${fund}, program ${chosen.slice(0, -1).join(', ')} or ${chosen[chosen.length - 1]}`;
}

/**
 * The predicate. **The one implementation**, so the register and a PO row cannot disagree about the
 * rule they are both being tested against.
 *
 * `fund` and `program` are the two segments as strings. An empty value fails: a row that cannot say
 * what fund it is in is not a row this scope has any business claiming, which is the same choice the
 * invoices register makes when it counts such rows as `unanswerable` rather than as exclusions.
 */
export const inScope = (scope: Scope, fund: string, program: string): boolean => {
  const s = normalise(scope);
  if (!s.fund || String(fund).trim() !== s.fund) return false;
  if (!s.programs.length) return true; // no program chosen ⇒ the fund alone is the rule
  return s.programs.includes(String(program).trim());
};

/**
 * The two URL params, or the organization's scope when they are absent.
 *
 * ★ A HAND-EDITED URL MUST NOT BE ABLE TO EMPTY THE APP BY ACCIDENT. A fund param that is absent or
 *   blank falls back to the organization's fund, and the whole selection is then clamped to what the
 *   organization holds — so the worst a truncated URL can do is show the tenant's own scope.
 *
 * ★ AN ABSENT PARAM AND AN EMPTY ONE ARE DIFFERENT, AND CONFLATING THEM WAS A CONTROL THAT DID
 *   NOTHING. `useSearchParams().get()` returns `null` when the parameter is not in the URL, and `''`
 *   when it is there with nothing after the `=`. The popover's **Clear programs** button writes the
 *   empty form on purpose; treating it as "nothing was asked for" expanded it straight back to the
 *   tenant's programs, so the button appeared to work and changed nothing at all. `null` means the
 *   reader never touched the programs; `''` means the reader cleared them — and `inScope` already
 *   documents what a cleared list means ("the fund alone is the rule"), so honouring it needs no new
 *   rule, only the distinction.
 *
 * The tenant is a required parameter rather than an optional one, because a fallback has to come from
 * somewhere and the only thing worse than a hardcoded fallback is an *implicit* one.
 */
export function parseScope(fund: string | null, programs: string | null, holdings: Scope): Scope {
  const f = (fund ?? '').trim();
  const asked =
    programs === null
      ? null
      : programs
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);

  if (!f && asked === null) return normalise(holdings);

  return clampToHoldings(
    { fund: f || holdings.fund, programs: asked === null ? holdings.programs : asked },
    holdings,
  );
}

/** The `?fund=…&programs=…` pair. Sorted, so one selection has exactly one URL. */
export function scopeParams(scope: Scope): { fund: string; programs: string } {
  const s = normalise(scope);
  return { fund: s.fund, programs: s.programs.join(',') };
}

/**
 * ★ `knownProgram` USED TO LIVE HERE AND HAS BEEN REMOVED RATHER THAN REPOINTED. It asked
 *   `ALL_PROGRAMS.includes(program)` — "is this a program the app offers at all?" — and with the
 *   universe moved onto the organization row the honest answer is `clampToHoldings`, which does not
 *   merely *report* that a program is outside the tenant: it drops it, and it reports the same fact
 *   by its effect. The function had no caller left; a second way to ask the question would be a second
 *   answer waiting to disagree.
 */

/**
 * The first day of a fiscal year, as `YYYY-MM-DD`.
 *
 * ★ JULY, AND THAT IS A FACT ABOUT THIS LEDGER RATHER THAN A CHOICE MADE HERE. Fiscal years run
 *   July–June, so FY 2022 opens on 2021-07-01. The same sentence appears on the sign-in payload the
 *   server sends, in `SessionOrganizationSchema.startFy`, so the two halves of the app agree about
 *   what a start year means by saying the same thing in words rather than by sharing a constant
 *   across a workspace boundary.
 *
 * The year is padded because the comparison it feeds is a string comparison against `orderDate`,
 * which is plain `YYYY-MM-DD` throughout the extract. `2022 - 1` is `2021`, but a four-digit year
 * written without padding would sort wrongly for any year under 1000 — cheap to prevent, and it keeps
 * this function total rather than merely correct for the values in front of it today.
 */
export function fiscalYearStart(startFy: number): string {
  return `${String(startFy - 1).padStart(4, '0')}-07-01`;
}

/**
 * The rows a scope selects, in the order they arrived.
 *
 * The filter is `inScope` and nothing else, so a count taken from this array and a count taken on any
 * register cannot disagree — which is the whole reason `inScope` is exported as *the one
 * implementation* rather than as a helper.
 *
 * Typed over the two segments it reads rather than over `ExtractLine`, so an organization's row on the
 * Settings page is countable from the same function the PO register is filtered by.
 */
export function rowsInScope<T extends { fund: string; program: string }>(
  scope: Scope,
  rows: readonly T[],
): T[] {
  return rows.filter((row) => inScope(scope, row.fund, row.program));
}
