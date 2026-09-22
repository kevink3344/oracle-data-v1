/**
 * Settings — the organization register.
 *
 * ── WHAT THIS PAGE IS
 *
 * One accordion, holding the list of tenants and the form that makes another. It is
 * the whole of Phase 1's screen: the tables, the sign-in, the gear and this page. A
 * tenant is a **fund, a set of programs and a start fiscal year** applied to the
 * ledger, and this is the only place the tuple is written down.
 *
 * ── ★ THE ROW CARRIES A MEASUREMENT, NOT JUST A CONFIGURATION
 *
 * A list of three tuples would let a person configure something that selects nothing
 * and still look satisfied. So every row says how many rows of the extract it
 * actually selects, and a tenant that selects none says **`No rows found`** rather
 * than `0`. That sentence is the difference between "this is empty today" and "this
 * is wrong", and only one of them is worth acting on.
 *
 * ── ★ THE COUNT IS TAKEN HERE, ON THE CLIENT, AND THAT WAS THE SERVER'S DECISION
 *
 * `routes/organizations.ts` deliberately does **not** send a per-row line count, and
 * its header says why: the count that matters is "rows of the extract this scope
 * selects", and the tables that carry the fund and the program are not the tables a
 * per-organization query would naturally reach. A second implementation of the scope
 * rule inside the API would be a second answer to a question this app already answers
 * in exactly one place. So the count comes from `rowsInScope`, the same function the
 * PO register is filtered by, over the lines the store already fetched. One rule,
 * one answer, no round trip.
 *
 * ── ★ THE SENTENCE THE FORM PRINTS IS ABOUT THE SELECTION, NOT ABOUT THE WHOLE FILE
 *
 * "removes 0 of 2,781 rows" means 0 of the rows *this fund and these programs
 * select*. For the seeded tenant that is all of them, so the two readings agree
 * today — which is exactly why the wording says "here" and the denominator is
 * printed. The plan quotes 2,782; the app counts 2,781, because it counts live lines
 * and one extract row carries `CANCEL_FLAG = 'Y'`. That difference is stated in
 * `data/scope.ts` at length and is not a bug in this page.
 *
 * ── ★ A ROW IS EDITED IN THE DRAWER, AND THE DRAWER SENDS A DIFF
 *
 * `Edit` on a row slides `OrgPanel` in from the right — the same `.drawer` primitive
 * the check details, the PO detail and the funding combination panels use, with the
 * same Escape-to-close, Tab trap, focus hand-back and drag-to-resize. It reuses
 * `ScopeFields`, so the four controls in the panel are literally the controls in the
 * create form rather than a second implementation of them, and the sentence under the
 * start year is the same `startFyEffect`.
 *
 * The panel does **not** post the four fields. It posts only the ones that differ,
 * because `PATCH /api/organizations/{slug}` refuses a body that names no fields with
 * `400 BAD_REQUEST` — deliberately, so an empty update cannot answer `200` and let a
 * caller believe it edited something. "Nothing has changed" is therefore a state this
 * page has to work out for itself, which is what `diffOf` returning `null` is for.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Chip } from '../components/Chip';
import ResizeGrip, { clampWidth, readStoredWidth, storeWidth } from '../components/ResizeGrip';
import {
  acceptedValues,
  createOrganization,
  loadOrganizationOptions,
  loadOrganizations,
  scopeOf,
  updateOrganization,
  type Organization,
  type OrganizationList,
  type OrganizationOptions,
  type OrganizationUpdate,
  type ProgramOption,
} from '../data/organizations';
import { fiscalYearStart, rowsInScope, scopeSpoken, type Scope } from '../data/scope';
import { isSuperAdmin, refreshSession, useSession } from '../data/session';
import { useStore } from '../state/store';

/** The program pairs the chart of accounts offers under one fund. */
function programsFor(options: OrganizationOptions | null, fund: string): ProgramOption[] {
  if (!options) return [];
  return options.programs.filter((pair) => pair.fund === fund);
}

/**
 * The start-FY sentence, and the arithmetic behind it.
 *
 * ★ IT IS ONE FUNCTION AND NOT TWO. The sentence and the number it prints have to be
 *   the same number, so the count is returned alongside the words rather than
 *   recomputed by the caller — a page that says "removes 1,544" beside a preview that
 *   says "1,543 rows" is the kind of disagreement this app keeps finding in itself.
 */
function startFyEffect(
  startFy: number,
  scope: Scope,
  lines: readonly { orderDate: string; fund: string; program: string }[],
): { sentence: string; removed: number; matched: number } {
  const mine = rowsInScope(scope, lines);
  if (mine.length === 0) {
    return {
      sentence: `Start FY ${startFy} has nothing to remove: this fund and these programs match no rows in the extract.`,
      removed: 0,
      matched: 0,
    };
  }

  const opens = fiscalYearStart(startFy);
  const removed = mine.filter((line) => line.orderDate < opens).length;
  const earliest = mine.reduce(
    (min, line) => (line.orderDate < min ? line.orderDate : min),
    mine[0]!.orderDate,
  );

  return {
    sentence: `Start FY ${startFy} removes ${removed.toLocaleString()} of ${mine.length.toLocaleString()} rows — the earliest order date here is ${earliest}.`,
    removed,
    matched: mine.length,
  };
}

// ---------------------------------------------------------------------------
// The four values, as a form holds them.
// ---------------------------------------------------------------------------

/**
 * One organization's four fields, all as **strings**.
 *
 * ★ THE FORM'S FLAT COPY, AND EVERYTHING THAT READS IT GOES THROUGH HERE. Both the
 *   create form and the edit panel work on this, and so does `diffOf` — which is what
 *   makes "the panel posts only what changed" checkable rather than a claim. Typing
 *   the four values twice (once per caller) is how a create form and an edit form
 *   drift apart, and the start year is the field where that shows: it is a number on
 *   the wire and a string in an `<input>`, so a second implementation would be a
 *   second place to get the conversion wrong.
 */
interface Draft {
  name: string;
  fund: string;
  programs: string[];
  startFy: string;
}

const BLANK: Draft = { name: '', fund: '', programs: [], startFy: '' };

/**
 * How the start-year box reads, in one place.
 *
 * ★ `shaped` AND `outside` ARE KEPT APART BECAUSE THE TWO MISTAKES HAVE DIFFERENT
 *   FIXES. `20x4` is not a year and the answer is "type four digits"; `2019` is a
 *   year the ledger holds no period for and the answer is "pick one between FY2022
 *   and FY2028". Collapsing them into one `valid` flag produced a message that told a
 *   person their typo was outside a range it was never inside.
 *
 * ★ AND `ok` IS TRUE WHEN THERE ARE NO BOUNDS, WHICH IS NOT A LICENCE. `fiscalYears`
 *   is `null` when the ledger states no periods at all — the server is explicit that
 *   this is "the ledger has no opinion" rather than "no year is allowed", and its own
 *   `assertStartFy` returns early in that case. A client that refused every year here
 *   would block a write the server would accept.
 */
function fyState(
  startFy: string,
  options: OrganizationOptions | null,
): { ok: boolean; year: number; shaped: boolean; outside: boolean } {
  const text = startFy.trim();
  const year = Number(text);
  const shaped = /^[0-9]{4}$/.test(text) && Number.isFinite(year);
  const years = options?.fiscalYears ?? null;
  const outside = shaped && years !== null && (year < years.earliest || year > years.latest);
  return { ok: shaped && !outside, year, shaped, outside };
}

/** Whether a draft carries everything the server requires. Used by both forms. */
function draftComplete(draft: Draft, options: OrganizationOptions | null): boolean {
  if (draft.name.trim() === '') return false;
  if (draft.fund === '') return false;
  return fyState(draft.startFy, options).ok;
}

/** Two program selections compared as sets. See `diffOf`. */
function samePrograms(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((code, i) => code === right[i]);
}

/**
 * The fields that actually differ, or `null` when none do.
 *
 * ★ `null` AND NOT `{}`. The server refuses a patch that names no fields with
 *   `400 BAD_REQUEST — No fields were supplied.`, and its note says why: an empty
 *   update would otherwise answer `200` with a row the caller believes it edited.
 *   So "nothing has changed" has to be a state the panel recognises **before**
 *   sending, which is what `null` is for — it disables Save and says why, instead of
 *   posting `{}` and then having to explain a 400 nobody asked for.
 *
 * ★ `programs` IS COMPARED AS A SET, AND THE SERVER IS RIGHT NOT TO SORT IT. The
 *   `ProgramsSchema` note is explicit that the order is preserved on write and never
 *   sorted there, because it is the order the programs are offered to a reader. But
 *   this panel's picker is a list of checkboxes, so the order it can produce is only
 *   ever `.sort()`ed — **a re-ordered selection is not a change a person can make in
 *   this panel**, and comparing the arrays positionally would invent one, send a patch
 *   that alters nothing, and leave Save enabled forever after a save.
 */
function diffOf(row: Organization, draft: Draft): OrganizationUpdate | null {
  const patch: OrganizationUpdate = {};

  const name = draft.name.trim();
  if (name !== row.name) patch.name = name;
  if (draft.fund !== row.fund) patch.fund = draft.fund;
  if (!samePrograms(draft.programs, row.programs)) patch.programs = [...draft.programs];

  const year = Number(draft.startFy);
  if (Number.isFinite(year) && year !== row.startFy) patch.startFy = year;

  return Object.keys(patch).length > 0 ? patch : null;
}

/** `a` · `a and b` · `a, b and c`. */
function sentenceList(parts: string[]): string {
  if (parts.length === 0) return 'nothing';
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** What a patch touched, as words, for the panel's success notice. */
function describePatch(patch: OrganizationUpdate): string {
  const parts: string[] = [];
  if (patch.name !== undefined) parts.push('the name');
  if (patch.fund !== undefined) parts.push('the fund');
  if (patch.programs !== undefined) {
    parts.push(patch.programs.length === 0 ? 'the programs, now none' : 'the programs');
  }
  if (patch.startFy !== undefined) parts.push('the start fiscal year');
  return sentenceList(parts);
}

// ---------------------------------------------------------------------------
// The four controls, written once for both the create form and the edit panel.
// ---------------------------------------------------------------------------

/**
 * Name, fund, programs and start fiscal year — the whole record.
 *
 * ★ IT RENDERS A FRAGMENT, NOT A `<form>`, AND THAT IS WHAT LETS IT BE SHARED. The
 *   create form posts and the edit panel patches; the fields are identical and the
 *   submit is not. So the caller owns the `<form>`, the ids are built from an
 *   `idPrefix` the caller supplies, and `nameHint` is the one sentence that genuinely
 *   differs — the create form previews a slug that does not exist yet, the panel says
 *   the slug will not move.
 */
function ScopeFields({
  idPrefix,
  draft,
  onChange,
  options,
  lines,
  nameHint,
}: {
  idPrefix: string;
  draft: Draft;
  onChange: (patch: Partial<Draft>) => void;
  options: OrganizationOptions | null;
  lines: readonly { orderDate: string; fund: string; program: string }[];
  nameHint: ReactNode;
}) {
  const offered = programsFor(options, draft.fund);
  const offeredCodes = offered.map((pair) => pair.program);
  // ★ SHOWN, NOT DROPPED. A program the current fund does not pair with is kept in
  //   the selection and labelled "not paired", because dropping it would silently
  //   narrow the record: a person switching funds to look at one would lose the codes
  //   they never touched, and the save that followed would be a save they did not ask
  //   for. The list says what is inconsistent; it does not tidy it away.
  const unpaired = draft.programs.filter((code) => !offeredCodes.includes(code));
  const scope: Scope = { fund: draft.fund, programs: draft.programs };

  const fy = fyState(draft.startFy, options);
  const effect = fy.ok
    ? startFyEffect(fy.year, scope, lines)
    : { sentence: 'A start year makes the difference exact.', removed: 0, matched: 0 };
  const reached = rowsInScope(scope, lines).length;
  const years = options?.fiscalYears ?? null;

  const toggle = (code: string) =>
    onChange({
      programs: draft.programs.includes(code)
        ? draft.programs.filter((other) => other !== code)
        : [...draft.programs, code].sort(),
    });

  return (
    <>
      <div className="field">
        <label className="field__label" htmlFor={`${idPrefix}-name`}>
          Name <span className="field__req">required</span>
        </label>
        <input
          id={`${idPrefix}-name`}
          className="input"
          type="text"
          autoComplete="off"
          value={draft.name}
          placeholder="e.g. Athens Drive High School"
          onChange={(event) => onChange({ name: event.target.value })}
        />
        <p className="field__hint">{nameHint}</p>
      </div>

      <div className="field">
        <label className="field__label" htmlFor={`${idPrefix}-fund`}>
          Fund <span className="field__req">required</span>
        </label>
        <select
          id={`${idPrefix}-fund`}
          className="input"
          value={draft.fund}
          onChange={(event) => onChange({ fund: event.target.value })}
        >
          <option value="">Choose a fund…</option>
          {(options?.funds ?? []).map((option) => (
            <option key={option.fund} value={option.fund}>
              {option.fund} · {option.combinations.toLocaleString()} account combinations
            </option>
          ))}
        </select>
        <p className="field__hint">
          Read from the chart of accounts. Fund <code>00</code> is not offered — it is the unresolved
          placeholder, and a tenant scoped to it would select nothing while looking configured.
        </p>
      </div>

      <div className="field">
        <span className="field__label" id={`${idPrefix}-programs-label`}>
          Programs
        </span>
        <div className="picklist" role="group" aria-labelledby={`${idPrefix}-programs-label`}>
          {draft.fund === '' ? (
            <p className="field__hint">Choose a fund first — programs belong to one.</p>
          ) : offered.length === 0 && unpaired.length === 0 ? (
            <p className="field__hint">
              The chart of accounts pairs no program with Fund {draft.fund}. Leaving the selection
              empty makes the fund alone the rule.
            </p>
          ) : (
            <>
              {offered.map((pair) => (
                <label className="opt" key={pair.program}>
                  <input
                    type="checkbox"
                    checked={draft.programs.includes(pair.program)}
                    onChange={() => toggle(pair.program)}
                  />
                  <span className="opt__code">{pair.program}</span>
                  <span className="opt__meta">
                    {pair.combinations.toLocaleString()}{' '}
                    {pair.combinations === 1 ? 'combination' : 'combinations'}
                  </span>
                </label>
              ))}
              {unpaired.map((code) => (
                <label className="opt opt--loose" key={code}>
                  <input type="checkbox" checked onChange={() => toggle(code)} />
                  <span className="opt__code">{code}</span>
                  <span className="opt__meta">not paired with Fund {draft.fund} in the chart</span>
                </label>
              ))}
            </>
          )}
        </div>
        <p className="field__hint">
          More than one may be chosen. The server checks a program for shape and not for membership of
          this list, so a code the chart does not pair with the fund is a legitimate configuration
          rather than an error — which is why one kept above says so instead of vanishing.
        </p>
      </div>

      <div className={`field${draft.startFy.trim() !== '' && !fy.ok ? ' field--bad' : ''}`}>
        <label className="field__label" htmlFor={`${idPrefix}-fy`}>
          Start FY <span className="field__req">required</span>
        </label>
        <input
          id={`${idPrefix}-fy`}
          className="input input--short"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={draft.startFy}
          placeholder="2022"
          onChange={(event) => onChange({ startFy: event.target.value })}
          aria-describedby={`${idPrefix}-fy-effect`}
        />
        <p className="field__hint" id={`${idPrefix}-fy-effect`}>
          {effect.sentence}
          {years && fy.outside ? (
            <>
              {' '}
              This ledger&rsquo;s periods run FY {years.earliest} to FY {years.latest}, so{' '}
              {draft.startFy.trim()} is outside them.
            </>
          ) : null}
        </p>
      </div>

      <div className="preview" aria-live="polite">
        <span className="preview__label">Reads as</span>
        <p className="preview__scope">
          {draft.fund === '' ? 'Nothing chosen yet' : scopeSpoken(scope)} · from FY{' '}
          {fy.ok ? fy.year : '…'}
        </p>
        <p className="preview__rows">
          {draft.fund === ''
            ? 'A fund and its programs decide which rows this organization sees.'
            : reached === 0
              ? 'No rows of the extract match this selection.'
              : `${reached.toLocaleString()} of ${lines.length.toLocaleString()} rows in the extract, less ${effect.removed.toLocaleString()} before the fiscal year opens.`}
        </p>
      </div>
    </>
  );
}

export default function Settings() {
  const user = useSession();
  const { lines } = useStore();
  const may = isSuperAdmin(user);

  const [open, setOpen] = useState(true);
  const [list, setList] = useState<OrganizationList | null>(null);
  const [options, setOptions] = useState<OrganizationOptions | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // The create form. Its four fields are a `Draft` — the same shape the edit panel
  // works on, so `draftComplete` and `diffOf` are the only implementation of "is this
  // finished" and "what changed" in the file.
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Organization | null>(null);
  const [formProblem, setFormProblem] = useState<string | null>(null);
  const [formAccepts, setFormAccepts] = useState<string[]>([]);

  /**
   * The row whose panel is open, or `null` when none is.
   *
   * ★ `null` RATHER THAN A BOOLEAN, AND THE PANEL IS WHAT NEEDS THAT. Every other
   *   drawer in the app is shaped this way (`DetailDrawer`'s `selected !== null`, the
   *   check panel's `check`). Holding the row itself means the panel has the values it
   *   is editing without looking them up again, and it means "the row was deleted
   *   underneath us" is impossible to represent — a panel cannot be open on nothing.
   */
  const [editing, setEditing] = useState<Organization | null>(null);

  // The register is a super-admin screen, so a session that may not read it never
  // sends the request. The server would answer 403 anyway — this is the polite half,
  // not the control.
  useEffect(() => {
    if (!may) return;
    const controller = new AbortController();
    let live = true;
    setLoading(true);

    Promise.all([loadOrganizations(controller.signal), loadOrganizationOptions(controller.signal)])
      .then(([orgs, opts]) => {
        if (!live) return;
        setList(orgs);
        setOptions(opts);
        setProblem(null);
      })
      .catch((err: unknown) => {
        if (!live || controller.signal.aborted) return;
        setProblem(err instanceof Error ? err.message : 'The register could not be read.');
      })
      .finally(() => {
        if (live) setLoading(false);
      });

    return () => {
      live = false;
      controller.abort();
    };
  }, [may, reloadKey]);

  /**
   * Seed the form from the tenant this session is *in*, once.
   *
   * ★ ONCE, AND NOT ON EVERY RENDER. The session arrives asynchronously, so this
   *   cannot be initial state — and re-seeding it whenever the session object
   *   changes would wipe a half-typed name the moment anything re-rendered. The ref
   *   makes it a first-fill rather than a binding.
   */
  const seeded = useRef(false);
  useEffect(() => {
    const org = user?.organization;
    if (seeded.current || !org) return;
    seeded.current = true;
    setDraft((current) => ({
      ...current,
      fund: org.fund,
      programs: [...org.programs],
      startFy: String(org.startFy),
    }));
  }, [user]);

  const ready = draftComplete(draft, options);

  /**
   * A keystroke in the create form.
   *
   * ★ IT CLEARS A PREVIOUS REFUSAL, INCLUDING FOR THE NAME. The old handlers cleared
   *   the error for the fund and the programs but not for the name, because the
   *   name's handler was written first and separately. An error notice that stays put
   *   while the field it is about is being corrected reads as "still broken", and the
   *   `unpaired` rule below means a fund change does *not* necessarily mean the
   *   selection changed — so clearing on any edit is both simpler and more truthful.
   */
  function editDraft(patch: Partial<Draft>) {
    setFormProblem(null);
    setDraft((current) => ({ ...current, ...patch }));
  }

  async function onCreate(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setFormProblem(null);
    setFormAccepts([]);
    try {
      const row = await createOrganization({
        name: draft.name.trim(),
        fund: draft.fund,
        programs: draft.programs,
        startFy: Number(draft.startFy),
      });
      setCreated(row);
      setFormOpen(false);
      // ★ ONLY THE NAME IS CLEARED. The fund, the programs and the year describe the
      //   tenant this session is in, so they are the most likely starting point for the
      //   next one; emptying them would make a person re-choose what the app already
      //   knows. `seeded` is what stops the session from filling them back in.
      setDraft((current) => ({ ...current, name: '' }));
      setFormProblem(null);
      setReloadKey((k) => k + 1);
    } catch (err: unknown) {
      setFormProblem(err instanceof Error ? err.message : 'The organization was not recorded.');
      setFormAccepts(acceptedValues(err));
    } finally {
      setBusy(false);
    }
  }

  /* ── The head, which is the same whether or not there is a list to show ────── */

  const head = (
    <div className="stack">
      <div>
        <div className="accent-rule" />
        <div className="page-head">
          <div>
            <h1>Settings</h1>
            <p className="page-head__sub">
              Which organization this deployment reads, and what each one selects from the extract.
            </p>
          </div>
          <div className="page-head__actions">
            <Link className="btn btn--ghost" to="/">
              Dashboard
            </Link>
          </div>
        </div>
      </div>
    </div>
  );

  if (!may) {
    return (
      <div className="stack">
        {head}
        <section className="panel">
          <div className="panel__head">
            <h2 className="panel__title">Not this session</h2>
            <span className="panel__count">
              {user?.authenticated ? 'member' : 'session not read yet'}
            </span>
          </div>
          <div className="panel__body">
            <p className="chart-note">
              The organization register is a super-admin screen. A member may read every register in
              the app; the four endpoints behind this page call <code>requireSuperAdmin</code> and
              answer <strong>403</strong> whatever the rail happens to be showing — so this panel is
              the polite half of the refusal, and not the refusal itself.
            </p>
            <p className="chart-note">
              {user?.authenticated
                ? `${user.name} is a member, so this stays closed until the role on the account changes. The role is re-read from the database on every session request, so a change shows up on the next page load rather than needing a new sign-in.`
                : /*
                   * ★ UNREACHABLE, AND THE SENTENCE THAT USED TO BE HERE WAS WORSE THAN DEAD CODE.
                   *
                   *   It read "Signing in is the only way to reach this page" — advice to a visitor
                   *   who cannot be here. `App.tsx` refuses to draw this route without a session, so
                   *   the only way to see this panel at all is to be signed in already. A stale string
                   *   in an unreachable branch does not fail anything, which is why it is worth
                   *   removing by hand: nothing will ever tell you it is wrong.
                   *
                   *   The branch itself stays, because `useSession()` can be `null` for one frame
                   *   (a token is held and the boot request is in flight), and this says what is
                   *   true of that frame and asserts nothing about the app.
                   */
                  'The session has not been read yet, so the role on it is not known.'}
            </p>
            <div className="idcard__actions">
              <Link className="btn btn--primary" to="/sign-in">
                {user?.authenticated ? 'Sign in as somebody else' : 'Sign in'}
              </Link>
            </div>
          </div>
        </section>
      </div>
    );
  }

  /* ── The register ──────────────────────────────────────────────────────────── */

  return (
    <div className="stack">
      {head}

      {created ? (
        <div className="notice notice--ok" role="status">
          <p>
            <strong>{created.name} was recorded.</strong>
          </p>
          <p>
            <code>{created.slug}</code> — {created.scopeLabel}, from FY {created.startFy}.
          </p>
        </div>
      ) : null}

      {problem ? (
        <div className="notice notice--err" role="alert">
          <p>
            <strong>The register could not be read.</strong>
          </p>
          <p>{problem}</p>
          <p>
            If the session has expired this is a <strong>401</strong> rather than a 403 — sessions
            last twelve hours and the server keeps them in memory, so a restart or an expiry is
            enough. <Link to="/sign-in">Sign in again</Link>.
          </p>
        </div>
      ) : null}

      <section className="panel acc">
        <div className="panel__head">
          <button
            type="button"
            className="acc__toggle"
            aria-expanded={open}
            aria-controls="org-body"
            onClick={() => setOpen((v) => !v)}
          >
            <span className="acc__caret" aria-hidden="true">
              {open ? '▾' : '▸'}
            </span>
            Organizations
          </button>
          <div className="acc__actions">
            {list ? (
              <span className="panel__count">
                {list.counts.total} {list.counts.total === 1 ? 'organization' : 'organizations'}
              </span>
            ) : null}
            <button
              type="button"
              className="btn btn--primary btn--sm"
              aria-expanded={formOpen}
              aria-controls="org-new"
              onClick={() => {
                setFormOpen((v) => !v);
                setCreated(null);
                setFormProblem(null);
                // ★ THE TWO ARE NOT ALLOWED BOTH OPEN. One is a form for a record that
                //   does not exist and the other is a panel for a record that does, and
                //   having them on screen together invites a person to type into the
                //   wrong one. The panel is the one that closes, because the inline form
                //   is where a new tenant starts and the panel is over the top of it.
                setEditing(null);
              }}
            >
              + New
            </button>
          </div>
        </div>

        <div className="panel__body" id="org-body" hidden={!open}>
          {loading && !list ? <p className="chart-note">Reading the register…</p> : null}

          {list && list.counts.programs > 0 ? (
            <p className="chart-note acc__warn">
              {list.counts.programs} of {list.counts.total}{' '}
              {list.counts.programs === 1 ? 'organization names' : 'organizations name'} no program
              at all, which means the fund alone is the rule and the tenant selects every program
              in it. That is legal, and it is worth seeing rather than being refused.
            </p>
          ) : null}

          {list && list.items.length === 0 ? (
            <p className="chart-note">
              No organizations are recorded. The one this session is in came from the bootstrap
              account, so this list being empty would mean the bootstrap row has gone.
            </p>
          ) : null}

          {list && list.items.length > 0 ? (
            <ul className="orglist">
              {list.items.map((org) => {
                const mine = rowsInScope(scopeOf(org), lines);
                return (
                  <li key={org.slug} className={`orgrow${org.isDefault ? ' orgrow--default' : ''}`}>
                    <div className="orgrow__name">
                      <span className="orgrow__title">{org.name}</span>
                      {org.isDefault ? <Chip variant="info">default</Chip> : null}
                    </div>
                    <div className="orgrow__scope">{org.scopeLabel}</div>
                    <div className="orgrow__count">
                      FY {org.startFy} ·{' '}
                      {mine.length === 0 ? (
                        <strong className="orgrow__none">No rows found</strong>
                      ) : (
                        `${mine.length.toLocaleString()} ${mine.length === 1 ? 'line' : 'lines'}`
                      )}
                    </div>
                    <div className="orgrow__slug">
                      <code>{org.slug}</code>
                    </div>
                    {/*
                     * ★ A REAL `<button>`, NOT A CLICKABLE ROW. A row-level `onClick`
                     *   is never reachable from the keyboard, and the rule this project
                     *   has settled on is to put the control in the row and let the row
                     *   itself stay inert. `aria-label` names the organization because
                     *   six buttons reading "Edit" in a list is six identical entries to
                     *   a screen reader, and `aria-haspopup="dialog"` says what the
                     *   press will do before it is pressed.
                     */}
                    <div className="orgrow__act">
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm orgrow__edit"
                        aria-haspopup="dialog"
                        aria-label={`Edit ${org.name}`}
                        onClick={() => {
                          setCreated(null);
                          setEditing(org);
                        }}
                      >
                        Edit
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {formOpen ? (
            <form className="orgform" id="org-new" onSubmit={onCreate} noValidate>
              <h3 className="orgform__title">New organization</h3>
              <p className="chart-note">
                The key in the URL is derived from the name, so it is never typed — the same rule the
                projects register uses. A name that already exists is refused rather than merged.
              </p>

              {formProblem ? (
                <div className="notice notice--err" role="alert">
                  <p>
                    <strong>That was refused.</strong>
                  </p>
                  <p>{formProblem}</p>
                  {formAccepts.length ? (
                    <p>
                      This ledger accepts {formAccepts.map((v) => `“${v}”`).join(', ')} here.
                    </p>
                  ) : null}
                </div>
              ) : null}

              <ScopeFields
                idPrefix="org-new"
                draft={draft}
                onChange={editDraft}
                options={options}
                lines={lines}
                nameHint={
                  <>
                    The slug is <code>{draft.name.trim() ? slugPreview(draft.name) : '…'}</code>. Two
                    organizations cannot share one.
                  </>
                }
              />

              <div className="idcard__actions">
                <button type="submit" className="btn btn--primary" disabled={!ready || busy}>
                  {busy ? 'Recording…' : 'Create organization'}
                </button>
                <p className="field__hint">
                  {ready
                    ? 'The name, the fund, the programs and the start year are the whole record. Nothing is written to Oracle.'
                    : 'A name, a fund and a start year inside the ledger’s periods are required. The programs are optional.'}
                </p>
              </div>
            </form>
          ) : null}
        </div>
      </section>

      <OrgPanel
        row={editing}
        options={options}
        lines={lines}
        onClose={() => setEditing(null)}
        onSaved={(next) => {
          // ★ THE ROW IS REPLACED BY SLUG, NOT RE-FETCHED. Two reasons, and either
          //   alone would be enough: the server already answered with the **stored**
          //   row (`readBack`), so a second GET would re-read a row this page is
          //   holding; and `slug` never moves — the route's own note says a rename
          //   leaves the key alone — so it is the stable identity to match on.
          //
          //   `setEditing(next)` IS NOT OPTIONAL. Without it the panel keeps the row it
          //   opened on, `diffOf` keeps finding a difference against a row that is no
          //   longer stored, and Save stays enabled after a save so a second press
          //   re-sends a patch that changes nothing.
          setEditing(next);
          setList((current) =>
            current
              ? { ...current, items: current.items.map((org) => (org.slug === next.slug ? next : org)) }
              : current,
          );
        }}
      />
    </div>
  );
}

/**
 * The slug the server will derive, for the hint under the name field.
 *
 * ★ IT IS A PREVIEW AND IT SAYS SO. The server's `slugFor()` is the authority; this
 *   repeats its rule only to put a value in front of the person typing, and a
 *   mismatch costs a hint that was wrong rather than a record that is. The rules the
 *   server applies are the same three — lower-case, non-alphanumerics to hyphens,
 *   collapse runs and trim the ends — and the read-back after a create is what
 *   actually proves the result.
 */
function slugPreview(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The panel's focus trap reads the same set the other four drawers use. */
const FOCUSABLE =
  'a[href], button:not([disabled]), summary, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Where the dragged width is remembered. Per panel, like `checks-panel-w`. */
const ORG_PANEL_WIDTH_KEY = 'settings-org-panel-w';

/**
 * One organization, edited in a panel that slides in from the right.
 *
 * ── ★ IT PATCHES A DIFF, AND SAVE IS DISABLED WHEN THE DIFF IS EMPTY
 *
 * `PATCH /api/organizations/{slug}` refuses a body naming no fields with `400
 * BAD_REQUEST`. That refusal is a design decision, not a sharp edge — the note on the
 * route says an empty update would otherwise answer `200` with a row the caller
 * believes it edited. So the panel works out what changed locally (`diffOf`) and
 * disables Save when nothing has, rather than posting `{}` and translating a 400 into
 * a success message. The footer says which fields would be sent, before they are.
 *
 * ── ★ IT REUSES `ScopeFields`, SO THERE IS NO SECOND SET OF CONTROLS
 *
 * The four inputs in this panel are the four inputs in the create form — the same
 * component, the same `startFyEffect` sentence, the same `unpaired` rule, the same
 * `"Reads as"` preview. A hand-written second copy is how an edit form and a create
 * form come to disagree about what a valid start year is, and the field they would
 * disagree about is the one with two representations (a number on the wire, a string
 * in the box).
 *
 * ── ★ THE HEAD SHOWS THE STORED ROW; THE PREVIEW SHOWS THE DRAFT
 *
 * The head reads "currently reads … — 2,781 lines" and does **not** move while the
 * form is edited, because it is a statement about the row as stored. The preview
 * inside `ScopeFields` moves on every keystroke, because it is a statement about what
 * is about to be saved. Two readings, two labels, and neither pretends to be the
 * other — which is the same distinction the funding screens make between the approved
 * and the committed total.
 */
function OrgPanel({
  row,
  options,
  lines,
  onClose,
  onSaved,
}: {
  row: Organization | null;
  options: OrganizationOptions | null;
  lines: readonly { orderDate: string; fund: string; program: string }[];
  onClose: () => void;
  onSaved: (row: Organization) => void;
}) {
  const open = row !== null;

  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const [width, setWidth] = useState<number | null>(() => readStoredWidth(ORG_PANEL_WIDTH_KEY));
  const [resizing, setResizing] = useState(false);
  const [rendered, setRendered] = useState(0);

  const [draft, setDraft] = useState<Draft>(BLANK);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [patchProblem, setPatchProblem] = useState<string | null>(null);
  const [patchAccepts, setPatchAccepts] = useState<string[]>([]);

  // Who opened the panel, and the scroll lock. Restoring focus to the Edit button is
  // the half of "it is a dialog" that is easy to skip and obvious when missing.
  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement as HTMLElement | null;
    document.body.classList.add('is-locked');
    return () => {
      document.body.classList.remove('is-locked');
      openerRef.current?.focus?.();
    };
  }, [open]);

  /**
   * Fill the form from the row.
   *
   * ★ KEYED ON THE ROW, AND RE-RUN ON PURPOSE AFTER A SAVE. `onSaved` hands back the
   *   **stored** row, so re-seeding here is what makes the diff empty and Save
   *   disabled again the moment a save succeeds. Keying on the row object rather than
   *   on its slug is deliberate: the parent replaces the object, which is exactly the
   *   event this effect exists to notice.
   */
  useEffect(() => {
    if (!row) return;
    setDraft({
      name: row.name,
      fund: row.fund,
      programs: [...row.programs],
      startFy: String(row.startFy),
    });
    setSaved(null);
    setPatchProblem(null);
    setPatchAccepts([]);
  }, [row]);

  // ★ FOCUS HAS TO WAIT FOR THE CONTENT. On the first open the close button is not
  //   rendered yet, so focusing in the same commit silently does nothing — the panel
  //   opens with focus still on the Edit button behind it and the Tab trap is the only
  //   thing keeping a keyboard user in the drawer.
  useEffect(() => {
    if (open && row) closeRef.current?.focus();
  }, [open, row]);

  // Escape closes; Tab is trapped inside. Both only while open, so a closed panel
  // cannot swallow a keystroke meant for the register behind it.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // What the panel is actually drawn at, so the grip has a sensible value before the
  // first drag (the width may come from storage, or from `--drawer-w`).
  useEffect(() => {
    if (!open) return;
    const measure = () => setRendered(panelRef.current?.getBoundingClientRect().width ?? 0);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

  useEffect(() => {
    document.body.classList.toggle('is-resizing', resizing);
    return () => document.body.classList.remove('is-resizing');
  }, [resizing]);

  // ★ ★ THIS COUNT IS OVER THE LIVE LEDGER. It reads `lines` from the store, which
  //   now comes from `GET /api/extract/current` → Oracle (`DB_MODE=oracle`), and
  //   only falls back to the frozen file when the ledger is unreachable.
  //
  //   The number moves as a result, and it should: the file holds 2,782 rows
  //   (2,781 after the cancel-flag filter), while the live tenant scope returns
  //   **31,670 rows / 31,401 distinct lines / 5,692 orders / $2,797,825,956.73**.
  //   Program 861 alone goes from "no lines in the extract" to 1,472 rows /
  //   $213,059,950.60 — it was never empty, the file simply predates it.
  //
  //   Program 863 remains genuinely empty: it is absent from the ledger too, so the
  //   "no lines" copy is still correct for that one case and must be kept.
  //
  //   See the ★★ block on `loadExtract` for the row-level evidence.
  const storedCount = row ? rowsInScope(scopeOf(row), lines).length : 0;
  const patch = row ? diffOf(row, draft) : null;
  const complete = draftComplete(draft, options);

  function edit(patchFields: Partial<Draft>) {
    setPatchProblem(null);
    setDraft((current) => ({ ...current, ...patchFields }));
  }

  async function onSave(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !row || !patch || !complete) return;
    setBusy(true);
    setPatchProblem(null);
    setPatchAccepts([]);
    try {
      const next = await updateOrganization(row.slug, patch);

      // ★ ★ THE ONE THING THAT MAKES "the chips above follow it" TRUE. Every
      //   request the server answers re-resolves the organization, so the
      //   registers would be filtered by the new scope on their very next call
      //   — but the tenant the *store* filters by is read out of the session in
      //   this browser, and that copy is only rewritten by a sign-in or by the
      //   boot check. Without this line a saved fund leaves the top bar, the
      //   drawer and every count describing the organization as it was, until
      //   somebody reloads the page: the app contradicting the screen that just
      //   wrote the change. Verified the hard way — setting the fund to 01 here
      //   left the chip reading `Fund 04` and the extract at 2,781 lines, and
      //   only a reload moved it.
      //
      //   Not gated on "did it change my own organization". The session carries
      //   the tenant's name and not its slug, so recognising "mine" would mean
      //   guessing from a label, and the call is one GET that the server answers
      //   from data it has already loaded.
      await refreshSession();

      setSaved(describePatch(patch));
      onSaved(next);
    } catch (err: unknown) {
      setPatchProblem(err instanceof Error ? err.message : 'The organization was not saved.');
      setPatchAccepts(acceptedValues(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside
      ref={panelRef}
      id="org-edit-panel"
      className={`drawer orgpanel${open ? ' is-open' : ''}${resizing ? ' is-resizing' : ''}`}
      style={width === null ? undefined : ({ '--drawer-w': `${width}px` } as CSSProperties)}
      role="dialog"
      aria-modal="true"
      aria-label={row ? `${row.name} — organization settings` : 'Organization settings'}
      aria-hidden={!open}
      tabIndex={-1}
    >
      <ResizeGrip
        value={width ?? rendered}
        onChange={(next) => {
          const clamped = clampWidth(next);
          setWidth(clamped);
          storeWidth(ORG_PANEL_WIDTH_KEY, clamped);
        }}
        onReset={() => {
          setWidth(null);
          storeWidth(ORG_PANEL_WIDTH_KEY, null);
        }}
        onDraggingChange={setResizing}
        controls="org-edit-panel"
        label="Resize the organization panel"
      />

      <div className="drawer__head">
        <div className="drawer__eyebrow">
          Organization · <code>{row?.slug ?? ''}</code>
        </div>
        <h2 className="drawer__name">{row?.name ?? ''}</h2>
        <div className="drawer__meta">
          {/*
           * ★ THE ZERO CASE IS A SENTENCE, NOT A NUMBER AND A NOUN SLOT. It used
           *   to render the count and the unit in two conditional slots, which is
           *   fine for "2,781 lines" and produced "— **No rows found** of the
           *   extract, as stored." for a scope that selects nothing. A
           *   configuration that matches no rows is an ordinary, legal state here
           *   — the drawer even recomputes it live as the fund changes value — so
           *   it says what it means instead of leaving a dangling preposition.
           *
           *   ★ "IN THE LEDGER", NOT "OF THE EXTRACT, AS STORED". The count is now
           *   taken over the rows the API read from Oracle, so naming an extract
           *   would name a file this number no longer comes from. When the ledger
           *   is unreachable the seam silently falls back to the frozen file and
           *   logs a warning, so this sentence stays true either way — it describes
           *   the data the app is holding, not where the bytes came from.
           */}
          {storedCount === 0 ? (
            <>
              Reads <b>{row?.scopeLabel ?? ''}</b> from FY <b>{row?.startFy ?? ''}</b> —{' '}
              <strong className="orgrow__none">no matching lines in the ledger</strong>.
            </>
          ) : (
            <>
              Reads <b>{row?.scopeLabel ?? ''}</b> from FY <b>{row?.startFy ?? ''}</b> —{' '}
              <b>{storedCount.toLocaleString()}</b> {storedCount === 1 ? 'line' : 'lines'} in the
              ledger.
            </>
          )}
        </div>
        <div className="drawer__chips">
          {row?.isDefault ? <Chip variant="info">default</Chip> : null}
          <Chip variant="neu">updated {row?.updatedAt ?? ''}</Chip>
        </div>
        <button
          ref={closeRef}
          type="button"
          className="drawer__close"
          onClick={onClose}
          aria-label="Close the organization panel"
        >
          <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M1 1l10 10M11 1L1 11"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <div className="drawer__body">
        <form id="org-edit" onSubmit={onSave} noValidate>
          {row?.isDefault ? (
            <p className="chart-note acc__warn">
              <strong>This is the default organization.</strong> A visitor with no session reads it, so
              changing its fund, its programs or its start year changes what an anonymous reader sees
              — immediately, and for everyone. There is no confirmation step and no undo.
            </p>
          ) : null}

          {saved ? (
            <div className="notice notice--ok" role="status">
              <p>
                <strong>Saved.</strong> {saved.charAt(0).toUpperCase() + saved.slice(1)} changed in the
                register.
              </p>
            </div>
          ) : null}

          {patchProblem ? (
            <div className="notice notice--err" role="alert">
              <p>
                <strong>That was refused.</strong>
              </p>
              <p>{patchProblem}</p>
              {patchAccepts.length ? (
                <p>This ledger accepts {patchAccepts.map((v) => `“${v}”`).join(', ')} here.</p>
              ) : null}
            </div>
          ) : null}

          <ScopeFields
            idPrefix="org-edit"
            draft={draft}
            onChange={edit}
            options={options}
            lines={lines}
            nameHint={
              <>
                The key stays <code>{row?.slug ?? ''}</code>. A slug is derived once, when the
                organization is created, and a rename leaves it alone — so a stored link keeps working
                and this cannot be used to change it.
              </>
            }
          />
        </form>
      </div>

      <div className="drawer__foot">
        <button
          type="submit"
          className="btn btn--primary"
          form="org-edit"
          disabled={!complete || patch === null || busy}
        >
          {busy ? 'Saving…' : saved && patch === null ? 'Saved' : 'Save changes'}
        </button>
        <button type="button" className="btn btn--system" onClick={onClose}>
          Close
        </button>
        <p className="orgpanel__note">
          {!complete
            ? 'A name, a fund and a start year inside the ledger’s periods are required. The programs are optional.'
            : patch === null
              ? 'Nothing has changed yet, so there is nothing to send. An update that names no fields is refused rather than treated as a no-op.'
              : `Sends only what differs — ${describePatch(patch)}. Nothing is written to Oracle.`}
        </p>
      </div>
    </aside>
  );
}
