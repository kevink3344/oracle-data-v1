/**
 * Sign in — the only screen in the application that is reachable signed out.
 *
 * ── WHY IT IS A FULL PAGE AND NO LONGER A PANEL IN THE SHELL
 *
 * It used to sit inside the rail and the top bar like every other page, which was
 * consistent with an app where every register was readable without signing in: the
 * screen was one page among many and a reader could leave it. It is now the *gate* —
 * `App.tsx` renders it as a sibling of the gate rather than inside it — so the rail
 * and the top bar are not drawn around it. There is nothing behind the card to
 * navigate to yet, and a rail beside a login form would offer a dozen links that all
 * lead back to the login form.
 *
 * ── ★ WHAT THE GATE IS AND IS NOT, BECAUSE THIS PAGE MUST NOT OVERSTATE IT
 *
 * It is a *client* control. It decides what this bundle fetches; it does not protect
 * the extract. `/oracle/*.json` is a static file in the app's public folder, so a
 * direct request for it is answered whether or not anybody signed in — a login screen
 * that implied otherwise would be claiming a security property it does not have. The
 * server is where access is actually decided: the writes in the organization register
 * are guarded per request, and that guard holds no matter what this page does.
 *
 * So the copy below says what signing in *changes* — which organization the registers
 * are scoped to — and does not say that it keeps anybody out of anything.
 *
 * ── WHAT ELSE IT IS HONEST ABOUT
 *
 * Three things a reader would otherwise have to discover by reading the server:
 *
 *   1. **There is no password for an `app_user` row.** The endpoint treats the
 *      password as optional and ignores it for an address it knows, so this form
 *      says so rather than implying a credential that is being checked.
 *   2. **A wrong password and an unknown address answer with the same sentence.**
 *      That is deliberate on the server, and this page must not undo it by
 *      counting the failures or wording them differently.
 *   3. **Signing out is local.** There is no revoke endpoint — sessions are a
 *      process-local map with a twelve-hour TTL — so the button says what it did:
 *      it dropped this browser's copy of the token.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import AppBrand from '../components/AppBrand';
import { num, pluralise } from '../data/format';
import { LEDGER_SCALE, recordsFloor } from '../data/ledgerScale';
import { useLedgerSummary, type LedgerObject } from '../data/ledgerSummary';
import { capTotals, describeCapTotal, loadReadCaps, type ReadCapList } from '../data/readCaps';
import { isSuperAdmin, signIn, signOut, useSession } from '../data/session';

/**
 * Where the gate sent this reader from, or `null` if it did not send them.
 *
 * ★ IT IS PARSED RATHER THAN TRUSTED. Router state survives a reload inside
 *   `history.state`, which means it is a value that has been through the browser and
 *   can be written by anything on the origin, and `useLocation().state` is typed `any`.
 *   A cast here would be a promise about a shape nothing enforces — the same mistake
 *   that left every real session carrying an `undefined` `authenticated` flag. So the
 *   fields are narrowed one at a time, and anything unexpected reads as "there was no
 *   destination". That is the safe direction: the reader lands on the app's own default
 *   rather than on a URL a stranger chose for them.
 *
 * ★ `/sign-in` IS REFUSED AS A DESTINATION. Without that line a reader who arrives on
 *   the login screen *from* the login screen would be sent straight back to it — a loop
 *   that presents as a Sign in button that does nothing.
 */
function readFrom(state: unknown): string | null {
  if (!state || typeof state !== 'object') return null;
  const from = (state as { from?: unknown }).from;
  if (!from || typeof from !== 'object') return null;
  const { pathname, search } = from as { pathname?: unknown; search?: unknown };
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return null;
  if (pathname === '/sign-in') return null;
  return typeof search === 'string' ? `${pathname}${search}` : pathname;
}

/**
 * What this deployment's ledger holds — the tables, and the rows in each.
 *
 * ★ EVERY STATE THE READ CAN REACH IS DRAWN, INCLUDING THE ONE THAT FAILS.
 *   `useLedgerSummary` returns a four-case union rather than a nullable summary
 *   plus flags, so there is no path here that can fall through to an empty list and
 *   print "0 tables · 0 records" over a store that was never read. The failure case
 *   names the error and says what it is *not*: signing in does not depend on this,
 *   and the Oracle source figure is quoted only with its database and its date
 *   attached, so it cannot be taken for this store's.
 *
 *   ★ THE FOURTH CASE IS THE ONE THIS CARD WAS REPORTED FOR. `loading` and `slow` are
 *   the same request at different ages; only the second says how long it has been
 *   running. Rendering both as one unmoving sentence — which is what happened before —
 *   made a four-minute count and a wedged endpoint indistinguishable to the person
 *   looking at the screen, and the reported symptom was exactly that: *the sign-in
 *   screen is stuck on "Counting the ledger…"*.
 *
 * ★ THE APP-OWNED TABLES ARE LISTED SEPARATELY RATHER THAN MIXED IN OR DROPPED.
 *   `X_REPORT_PROJECT_FACTS` and `X_REPORT_FUNDING_LINES` live in the app store,
 *   which is a different database whenever `APP_DB_URL` separates them. Adding them
 *   to the ledger figure would describe two databases with one number; omitting them
 *   would hide two of the objects the API serves. They go below a rule, excluded
 *   from the total, with the store they came from named.
 *
 * ★ THE FIGURE IS THE TOGGLE AND THE LISTS ARE FOLDED BEHIND IT. The two numbers are
 *   the answer a reader came for; the thirty-four rows are the proof and the
 *   provenance note is the caveat. Folding them means the sign-in card opens with
 *   the fact showing and the evidence one click away, instead of thirty-four rows
 *   setting the card's height on every visit.
 *
 *   `<details>`/`<summary>` RATHER THAN A BUTTON AND A `useState`. The disclosure is
 *   the browser's, so it is keyboard-operable and announced as expanded or collapsed
 *   without a handler, and there is no second source of truth for "is this open" to
 *   drift from the DOM. The chevron is drawn in CSS from the `open` attribute and not
 *   from React state, for the same reason.
 *
 *   A `<span>` AND NOT A `<p>` FOR THE FIGURE: `summary` takes phrasing content, and
 *   a `<p>` inside it is invalid markup that every browser renders anyway — the kind
 *   of thing that survives until a validator or a screen reader reads it. The class
 *   is unchanged, so the figure looks the same here as in the two states below.
 *
 * ★ ONLY THE `ready` CASE IS FOLDED, AND THE ASYMMETRY IS DELIBERATE. `loading`,
 *   `slow` and `failed` carry one sentence each, so there is nothing bulky to hide —
 *   and in the `failed` case that sentence IS the message. Folding it would hide the
 *   one thing the reader needs and would present a ledger that could not be counted as
 *   a successful read with an empty list. A disclosure is offered where there is bulk
 *   to fold, not uniformly across states.
 *
 *   THE FIGURE STAYS OUTSIDE THE FOLD IN ALL FOUR STATES, so the block keeps one
 *   shape as it loads: a headline, and a chevron only when there is something behind
 *   it.
 */
/**
 * The caps this deployment has set, or `null` when they could not be read.
 *
 * ★ EVERY FAILURE COLLAPSES TO NULL, DELIBERATELY. See the call site: this figure is
 *   supplementary to a pre-auth card, so a reader must never be blocked by it. The
 *   alternative — a `failed` state the card has to render — would put an explanation
 *   of a read nobody asked for on the first screen of the application.
 *
 * ★ AND IT DOES NOT RETRY. The card is drawn once, before a session exists; a retry
 *   loop here would be a request per second against an endpoint that is already
 *   answering, for a figure that changes only when an administrator edits a cap.
 *
 * ★ IT RETURNS THE WHOLE LIST, NOT JUST THE TOTALS, BECAUSE THE ROWS NEED IT. Each
 *   ledger row shows its own object's cap, so the map has to be available per object —
 *   and deriving both the per-row figure and the headline total from one payload is
 *   what stops them disagreeing. A second request for the totals would be a second
 *   answer to the same question.
 */
function useReadCaps(): ReadCapList | null {
  const [list, setList] = useState<ReadCapList | null>(null);

  useEffect(() => {
    let live = true;
    loadReadCaps()
      .then((next) => {
        if (live) setList(next);
      })
      .catch(() => {
        // Left as null — every row falls back to the words it printed before this
        // feature existed, and the headline falls back to the table count alone.
      });
    return () => {
      live = false;
    };
  }, []);

  return list;
}

function LedgerSnapshot() {
  const state = useLedgerSummary();
  /*
   * ★ THE CAP TOTAL IS A SECOND, INDEPENDENT READ, AND ITS FAILURE IS NOT THE CARD'S.
   *
   *   The caps are a deployment fact (how much the app will read), not part of the
   *   ledger summary (what the ledger holds), so they come from their own endpoint —
   *   and that endpoint needs no session, which is what makes it usable here.
   *
   *   ★ A FAILED CAP READ MUST NOT BREAK THE CARD. This is the first screen of the
   *   application; a reader who cannot sign in because a *supplementary* figure did not
   *   load would be paying for the wrong thing. So the hook collapses every failure to
   *   `null` and the headline falls back to the table count alone — the sentence it
   *   printed before this feature existed. The distinction the card keeps elsewhere
   *   (a failed read is stated, never rendered as zero) is kept here by *omission*
   *   rather than by a sentence, because a pre-auth screen is the wrong place to
   *   explain a read the reader did not ask for.
   */
  const caps = useReadCaps();
  const capSummary = caps === null ? null : capTotals(caps);
  /**
   * Each object's cap, keyed by name, for the rows.
   *
   * ★ BUILT ONCE PER PAYLOAD RATHER THAN SEARCHED PER ROW. Thirty-four rows each doing
   *   a linear scan of fifty items is the kind of thing that never matters until it
   *   does; a map is the same code and has no such edge. The key is upper-cased because
   *   the registry spells the names in upper case and the descriptor list does too —
   *   but the two are separate sources, so the fold is what makes the join safe rather
   *   than lucky.
   */
  const capByName = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const item of caps?.items ?? []) map.set(item.tableName.toUpperCase(), item.maxRows);
    return map;
  }, [caps]);

  if (state.status === 'loading') {
    return (
      <div className="signin__scale">
        <p className="signin__scale-figure">Reading the ledger…</p>
        <div className="signin__scale-body">
          <p className="signin__scale-note">
            The list of tables this deployment serves, read from its descriptor list rather than
            counted. It is a schema fact, so it is quick — and the form above does not wait for it in
            any case.
          </p>
        </div>
      </div>
    );
  }

  /*
   * ★ THE STATE THAT ANSWERS "STUCK ON Counting the ledger…".
   *
   *   Nothing about the read is different here — it is the same request, still in
   *   flight. What changes is that the wait is STATED, in seconds, and keeps counting,
   *   where before this screen and the four-second case rendered the same unmoving
   *   sentence. A reader who can see the number climbing can decide to sign in and
   *   come back; a reader shown a sentence that never changes has only one available
   *   conclusion, and it is the wrong one.
   *
   *   THE FIGURE IS STILL NOT TAKEN FROM AN EARLIER RUN HERE. The rule this card keeps
   *   is that a number is either current or accompanied by its date; the recorded
   *   figure below is quoted as *recorded*, with its date and its different scope.
   */
  if (state.status === 'slow') {
    const seconds = Math.round(state.waitedMs / 1000);
    return (
      <div className="signin__scale">
        <p className="signin__scale-figure">Reading the ledger… ({seconds}s)</p>
        <div className="signin__scale-body">
          <RecordedScale
            lead={
              `Still waiting after ${seconds} seconds for a list of table names, which should be ` +
              `immediate. That points at the server rather than at this screen — the API may be ` +
              `unreachable or restarting. Signing in does not depend on it, and the read continues ` +
              `while you do.`
            }
          />
        </div>
      </div>
    );
  }

  if (state.status === 'failed') {
    return (
      <div className="signin__scale">
        <p className="signin__scale-figure">The ledger could not be read</p>
        <div className="signin__scale-body">
          <RecordedScale
            lead={
              `${state.message}. Signing in does not depend on it, and no table list is shown, ` +
              `because one from an earlier run would be a claim about a different deployment.`
            }
          />
        </div>
      </div>
    );
  }

  const { summary } = state;
  const ledger = summary.objects.filter((object) => object.store === 'ledger');
  const app = summary.objects.filter((object) => object.store === 'app');
  /*
   * ★ THE TOTAL IS A SUM OF WHAT IS SERVED, NOT A COUNT OF DISTINCT ROWS, AND THE
   *   READER HAS TO BE TOLD.
   *
   *   `V_SEGMENT_LEGEND`, `V_ACCOUNT_POSITION` and `V_BUDGET_BY_ACCOUNT_PERIOD` have
   *   no table on Oracle: they are composed over the base tables, so their rows are
   *   already present in the total as base rows — 76,615 of them on the fund-04 take
   *   of 2026-09-22, out of 197,019,139 across the 32 objects. Presented without
   *   that, `197,019,139 records` reads as a row count of the ledger and overstates
   *   it by the size of the three views.
   *
   *   ★ AND THE SCOPE, WHICH IS THE PART THIS COMMENT USED TO HAVE TO EXPLAIN AWAY.
   *     It said these three views were "the only figures that follow the account
   *     scope" and that the base tables were "counted whole, so a statement no fund
   *     appears in" — both true of the endpoint as it was, and both the complaint
   *     this change answers. They are counted through the scope now (see
   *     `server/src/routes/meta.ts`, `countObjects`), so switching `FUND_CODE=02,04`
   *     to `FUND_CODE=04` moves far more than the 920 rows it used to:
   *
   *         V_ACCOUNT_POSITION             1,272 →  1,262   (−10)
   *         V_BUDGET_BY_ACCOUNT_PERIOD    74,955 → 74,045   (−910)
   *         V_SEGMENT_LEGEND               1,308 →  1,308   (unscoped on purpose)
   *         total                    197,020,059 → 197,019,139  (−920)
   *
   *     That table is kept because it is still the right shape for the views —
   *     `−920 = −10 + −910`, and the third view is unmoved deliberately, since
   *     `/api/coa/*` browses the whole chart of accounts and a legend scoped to one
   *     fund would name a different set of levels than the pages it describes. What
   *     it no longer means is that the total ignores the setting.
   *
   *   ★ THE ROWS THAT *CANNOT* FOLLOW THE SCOPE ARE STILL COUNTED WHOLE, AND THAT IS
   *     NO LONGER A DISCLAIMER BUT A FIGURE. `PO_VENDORS` carries no account column:
   *     a vendor is not in a fund, and asking which fund it belongs to has no answer.
   *     The endpoint now reports `scopeMode: null` for every such object and totals
   *     it in `unscopedObjects`, so the note below can say *how much of this total
   *     the scope reaches* instead of conceding that none of it does.
   *
   *   DERIVED FROM THE DATA, NOT FROM A LIST OF THREE NAMES. Every object this
   *   ledger serves as a view is prefixed `V_` and no base table is; a hard-coded
   *   triple would be a second source of truth for a fact the payload already
   *   carries. The sentence appears only if such an object is actually counted.
   */
  const composed = ledger.filter((object) => object.name.startsWith('V_'));

  /**
   * What the counts were narrowed to, in words — or `null` when the server declares none.
   *
   * ★ READ FROM THE PAYLOAD, NOT WRITTEN HERE. The scope is server configuration, and a
   *   literal `Fund 04` in this component would keep saying so after the setting changed
   *   — on the one screen whose job is to show what the setting did. `programs === null`
   *   is the case worth wording carefully: the server's file is silent, so the program
   *   list belongs to an organization row that does not exist until somebody signs in,
   *   and the figure shown is therefore taken **by fund alone** — wider than what the
   *   app will read a moment from now. Saying "fund 04" and stopping would overstate it.
   */
  const scopeLine = (() => {
    const scope = summary.scope;
    if (scope === null) return null;
    const funds = scope.funds.map((f) => `fund ${f}`).join(', ');
    const parts = [funds];
    if (scope.programs === null) parts.push('every programme, until an organization is chosen');
    else if (scope.programs.length > 0) parts.push(`programmes ${scope.programs.join('/')}`);
    if (scope.startYear !== null) parts.push(`fiscal year ${scope.startYear} onward`);
    return parts.join(' · ');
  })();

  /**
   * What the note says about when this was read.
   *
   * ★ "AS THIS SCREEN LOADED" WAS TRUE AND IS NOW MISLEADING, WHICH IS A DIFFERENT
   *   THING FROM BEING WRONG. It described a count — and there is no count here any
   *   more. The card reads the descriptor list, which is a fact about the schema and
   *   does not go stale the way a row total does, so dating it would attach a
   *   timestamp to the one part of this payload that has no age.
   *
   *   The history, because it explains why the line is shaped this way: the claim was
   *   about *this request* and was true while every request took its own count pass.
   *   The server then memoised that pass per scope — so reloading could not start a
   *   second 34-query pass over 197 M rows and starve the pool, which is what left this
   *   card on "Counting the ledger…" — and a claim about the request stopped being a
   *   claim about the figure. So the age was printed instead. Now the figures are gone
   *   from this screen altogether (`?counts=false`), so there is nothing left to date.
   *
   *   `countedAt` is still honoured for a payload that carries one, because a caller
   *   that asked for figures deserves the age of them. This screen simply never does.
   */
  const countedWhen = (() => {
    if (summary.countedAt === null) return '— the descriptor list the API serves';
    const at = new Date(summary.countedAt);
    if (Number.isNaN(at.getTime())) return '— the descriptor list the API serves';
    const seconds = Math.round((Date.now() - at.getTime()) / 1000);
    if (seconds < 90) return 'less than a minute ago';
    return `${Math.round(seconds / 60)} minutes ago, reused rather than counted again`;
  })();

  /*
   * ★ THE CARD LEADS WITH THE TABLE COUNT, THE RECORDED SCALE, AND THE LIVE CAP TOTAL.
   *
   *   This block used to read `32 tables · 197,019,139 records`, and the second half of
   *   that was the most expensive read in the app: a `COUNT(*)` over `GL_BALANCES` at
   *   157 M rows plus two composed views at ~13 s each, taken on every load of a page
   *   nobody had signed in to yet. Measured across takes: 51 s, 67.5 s, 95.5 s, 204.3 s,
   *   397.3 s and 307.7 s — the last of which lost its connection before answering. The
   *   reported symptom was the screen sitting on "Counting the ledger…".
   *
   *   Parallelising the count loop did not fix it (397.3 s sequential, 307.7 s with four
   *   workers), so the LIVE figure was removed from this screen instead of made faster.
   *   The request now asks for `counts=false` and the server answers from the descriptor
   *   list, which is exact and free.
   *
   *   ★ ★ AND THE SCALE FIGURE COMES BACK — AS A *RECORDED* ONE, WHICH IS THE WHOLE
   *     POINT OF THIS CHANGE. Management want a glimpse before they sign in, and a card
   *     that says only "34 tables" gives them no sense of the data at all. So the three
   *     figures are composed from what is *free*:
   *
   *       34 tables            the descriptor list — exact, and a schema fact
   *       over 197 million     `LEDGER_SCALE`, measured off-line, WITH ITS DATE
   *       up to N rows         the live cap total — a stored row, not a scan
   *
   *     ★ THE MIDDLE ONE IS THE ONE THAT NEEDS CARE, AND IT IS HANDLED BY SAYING SO.
   *       It is not this second's count and it does not pretend to be: the sentence
   *       below names the day it was measured, the database it was measured against and
   *       the scope it was taken under. That is the same rule the card applies in the
   *       other direction when the server hands it a memoised figure — a number is
   *       either current or accompanied by its date. A recorded figure *with* its
   *       provenance is honest; the same figure presented as live is not.
   *
   *     ★ AND IT IS A FLOOR (`over 197 million`), NOT THE EXACT `197,019,139`. An exact
   *       figure is a promise that stops being true the moment a row is inserted;
   *       `recordsFloor` is true before the next row and after it. See its own note —
   *       it also survives a scope change, which the exact number would not.
   *
   *   ★ WHAT IS STILL *NOT* HERE: THE LIVE COUNT, AND THE SCOPE EVIDENCE IT CARRIED. The
   *     sentence that compared `scopedRecords` against `ledgerRecords` — the one that
   *     showed fund 04 was actually narrowing the reads — cannot be made without a live
   *     pass, so it stays gone from this card. It belongs on the Activity page, which
   *     counts these same objects inside a session where a wait is expected. The
   *     recorded figure below is *not* a substitute for it: it is a scale reference,
   *     and it says so.
   */
  return (
    <details className="signin__scale">
      <summary className="signin__scale-head">
        <span className="signin__scale-figure">
          {/* `pluralise` prints the number itself — `32 tables` — so the count is not
              rendered separately here. It was, and the figure read
              `32 tables · 10,378 10,378 records`. */}
          {pluralise(summary.objectCount, 'table')} the API serves
          {/* ★ THE RECORDED SCALE, IN THE HEADLINE, BECAUSE IT IS THE FIGURE MANAGEMENT
              ARE LOOKING FOR. It is a floor with its date attached in the body below —
              the headline carries the magnitude, the body carries the provenance, and
              neither claims to be a live count. */}
          {' · '}
          {recordsFloor()}
          {/*
            ★ THE CAP TOTAL IS APPENDED ONLY WHEN A CAP IS IN FORCE, AND THE CONDITION
              IS THE HONESTY OF THE SENTENCE RATHER THAN A LAYOUT CHOICE.

              An uncapped deployment reads every matching row, so there is no number to
              print — and `0 rows` would be the most alarming way to describe an
              unbounded read. `describeCapTotal` returns null in that case, so the
              headline falls back to exactly what it said before this feature existed.

              ★ AND IT IS `up to N rows`, NOT `N rows available`. The caps are a limit
                on what will be *read*; they are not a measurement of what is *there*.
                On an object whose table holds fewer rows than its cap the two coincide
                only by luck, so the wording has to be true in both directions.

              ★ THE FIGURE IS NOT DATED, BECAUSE IT CANNOT GO STALE THE WAY A COUNT
                DOES. A cap is a stored row an administrator edits; it does not move
                on its own, so there is no age to disclose. That is the same reason the
                table list beside it is not dated. */}
          {capSummary !== null && describeCapTotal(capSummary) !== null ? (
            <> · {describeCapTotal(capSummary)}</>
          ) : null}
        </span>
        {/* No chevron element: the marker is `.signin__scale-head::after` in the
            sheet, turned by the `open` attribute. A glyph swapped in here would be a
            second thing to keep in step with the element's state. */}
      </summary>

      <div className="signin__scale-body">
        <p className="signin__scale-note">
          Read from <code>{summary.target}</code> {countedWhen}
          {scopeLine === null ? (
            <>, over every account &mdash; this server's configuration names no fund to narrow by.</>
          ) : (
            <>, restricted to {scopeLine}.</>
          )}{' '}
          The {pluralise(app.length, 'app-owned table')} the API also serves
          {summary.appTarget === summary.target ? (
            <> live in the same store and are listed below.</>
          ) : (
            <>
              {' '}
              live in <code>{summary.appTarget}</code> and are listed separately below.
            </>
          )}
          {composed.length > 0 ? (
            <>
              {' '}
              The {pluralise(composed.length, 'reporting view')} here
              {' '}
              {composed.length === 1 ? 'is' : 'are'} composed over the base tables rather than
              stored, so they are listed alongside the tables they are built from.
            </>
          ) : null}
          {/*
            ★ THE ABSENCE OF ROW COUNTS IS STATED, NOT LEFT TO BE NOTICED.
              A reader who saw `32 tables` alone and remembered `197,019,139 records`
              would reasonably conclude the figures had broken. Saying that the counts
              are not taken here — and where they are — is the difference between a
              card that is deliberately quiet and one that looks broken.

              ★ AND THE CAP SENTENCE ANSWERS THE QUESTION THAT REPLACES IT. A reader
                who wants a scale figure now has one: not how many rows the ledger
                holds (which costs a scan) but how many the app will read (which is a
                stored row). The two are different claims and the card says which it
                is making — see `describeCapTotal` for why the wording is `up to`. */}
          {' '}This card lists what the ledger holds rather than how much of it there is:
          counting the rows means a scan of every table, and the largest is 157 million
          rows, which is not a wait to put in front of a sign-in form.
          {/*
            ★ THE RECORDED FIGURE'S PROVENANCE, STATED WHERE THE FIGURE IS QUOTED.

              The headline says `over 197 million`. That is a figure taken off-line, and
              the rule this card keeps is that a number is either current or accompanied
              by its date — so it is accompanied by its date, its database and its scope,
              here, immediately below it.

              ★ IT IS THE SAME SENTENCE THE FAILED-READ PATH USES, VIA `RecordedScale`, AND
                THAT IS DELIBERATE RATHER THAN A SHORTCUT. Two copies of a provenance
                sentence is how one of them silently stops being true — and this is now
                the *second* place the recorded figure is quoted, which is exactly the
                condition that made `RecordedScale` a component in the first place.
          */}
          {' '}
          <strong>{recordsFloor()}</strong> records is a figure {recordedProvenance()} — stated
          with its date rather than presented as this second&rsquo;s, because counting this ledger
          live is a scan of 157 million rows and more. The live figures are on the Activity page
          once you are signed in.
          {capSummary !== null && capSummary.capped > 0 ? (
            <>
              {' '}
              How much the app will <em>read</em> is bounded separately, and that is a stored
              setting rather than a measurement: {describeCapTotal(capSummary)} out of{' '}
              {pluralise(capSummary.total, 'ledger object')}, set in Administration › Read caps. The
              objects with no cap are read whole.
              {/*
                ★ THE TWO LISTS ARE NOT THE SAME LIST, AND THE CARD SAYS SO.
                  This card lists the 34 descriptors the API serves; the cap registry governs
                  50 ledger objects, because it also covers the `WCSEXP_*` views and the two AP
                  base tables that the live payables routes read but no descriptor describes.
                  So a cap can exist on an object with no row above — and the headline total
                  would include it while nothing on the card showed it.

                  The sentence is emitted ONLY when the two sets actually differ, and it names
                  the count rather than the objects: a reader who wants the list has the Read
                  caps page, and enumerating 21 view names on a sign-in card would be the
                  opposite of what this card is for.
              */}
              {capSummary.total > summary.objectCount ? (
                <>
                  {' '}
                  That register covers {capSummary.total - summary.objectCount} more objects than the
                  list above — the extract views and the AP base tables the payables routes read,
                  which no descriptor here describes.
                </>
              ) : null}
            </>
          ) : null}
        </p>

        <ul className="signin__ledger">
          {ledger.map((object) => (
            <LedgerRow key={object.name} object={object} cap={capByName.get(object.name.toUpperCase()) ?? null} />
          ))}
          {app.map((object) => (
            <LedgerRow
              key={object.name}
              object={object}
              cap={capByName.get(object.name.toUpperCase()) ?? null}
              appOwned
            />
          ))}
        </ul>
      </div>
    </details>
  );
}

/**
 * The provenance of the recorded figure, as one sentence.
 *
 * ★ IT IS A FUNCTION NOW BECAUSE TWO PLACES QUOTE THE FIGURE, AND ONE COPY IS THE POINT.
 *   The `ready` state prints it beside the headline; the failed and slow states print it
 *   through `RecordedScale`. Two copies of a provenance sentence is how one of them
 *   silently stops being true — and the figure is now quoted in *both* branches of the
 *   same card, which is exactly the condition that made this a component in the first
 *   place. Making the sentence a function is the same move one level down.
 *
 * ★ AND THE TWO CALLERS NEED DIFFERENT LEAD-INS, WHICH IS WHY THIS RETURNS THE CLAIM
 *   RATHER THAN THE WHOLE PARAGRAPH. The `ready` state is describing a figure it just
 *   showed, so it leads with the number; the failed state is offering a scale reference
 *   in place of one it could not take, so it leads with "for scale only". The shared
 *   part is the provenance, and that is what is shared.
 */
function recordedProvenance(): string {
  return (
    `recorded on ${LEDGER_SCALE.measuredOn} against ${LEDGER_SCALE.target}, ` +
    `under ${LEDGER_SCALE.scope}`
  );
}

/**
 * The recorded figure, quoted wherever this deployment's own count is not available.
 *
 * ★ IT IS LABELLED AS RECORDED — WITH ITS DATE, ITS DATABASE AND ITS SCOPE. This is the
 *   same rule the rest of the card keeps in the opposite direction: the `ready` state
 *   prints the age of a figure the server reused, and this states the provenance of a
 *   figure taken somewhere else. The fault the card exists to prevent is a number a
 *   reader cannot date, not a number that is old.
 *
 *   ONE COPY, BECAUSE TWO STATES QUOTE IT. Two copies of a provenance sentence is how
 *   one of them silently stops being true.
 */
function RecordedScale({ lead }: { lead: string }) {
  return (
    <p className="signin__scale-note">
      {lead} For scale only: the Oracle source this copy came from measured{' '}
      {pluralise(LEDGER_SCALE.tables, 'table')} and {recordsFloor()} records{' '}
      {recordedProvenance()} — a different database, and an account scope stated rather than
      left to be assumed, so the figure is named as what it is instead of being presented as
      this one&rsquo;s.
    </p>
  );
}

/**
 * One table and its figure.
 *
 * ★ THE FIGURE IS THE CAP WHEN THERE IS ONE, AND THE WORDS WHEN THERE IS NOT. The
 *   column used to read `rows not counted` on every row, because the card asks for
 *   `counts=false` and a `COUNT(*)` over these tables is the six-minute read this
 *   screen deliberately gave up. The cap is a *stored setting* rather than a
 *   measurement, so it costs nothing to show — and it is the figure that actually
 *   answers the reader's question, which is not "how many rows are there" but "how
 *   much of this will the app read".
 *
 * ★ THE TWO ARE NOT THE SAME CLAIM AND THE ROW DOES NOT PRETEND THEY ARE. A cap is a
 *   ceiling on what will be read; a row count is a measurement of what is there. So a
 *   capped row reads `up to N rows` and never a bare number, which would be read as a
 *   count. An uncapped row keeps `rows not counted`, which is still true — the card
 *   did not count it — and the note above the list says the uncapped objects are read
 *   whole.
 *
 * ★ `null` RENDERS AS WORDS, NOT AS `0`. A count that could not be taken and a
 *   table with no rows are opposite facts, and the endpoint reports them
 *   differently — so the column says `not counted` rather than a figure the reader
 *   would compare against the others.
 *
 * ★ AND A SCOPED TABLE SHOWS BOTH NUMBERS, BECAUSE ONE OF THEM ALONE IS MISLEADING.
 *   `GL_BALANCES` holds 157,150,828 rows and fund 04 reaches a sliver of them; a
 *   single figure on the row would be either a whole-ledger total presented under a
 *   restricted heading, or a narrowed figure with nothing to compare it to. The row
 *   is therefore `N of M` where it is scoped, with `M` in a quieter weight than the
 *   narrowed count, which is the one the heading's claim is about.
 */
function LedgerRow({
  object,
  cap,
  appOwned = false,
}: {
  object: LedgerObject;
  /** This object's row cap, or null when it has none. */
  cap: number | null;
  appOwned?: boolean;
}) {
  // ★ NARROWED INTO LOCALS, SO THE `as number` CAST DOES NOT HAVE TO APPEAR AT THE
  //   POINT OF RENDERING. The three conditions are the same ones `scoped` encodes; a
  //   cast at the call site would assert the invariant forty lines from where the
  //   endpoint guarantees it, and would silently survive its loss.
  const whole = object.rowCount;
  const narrowed = object.scoped ? object.scopedRowCount : null;

  /*
   * ★ THE CAP WINS OVER THE COUNT, AND THAT ORDER IS DELIBERATE.
   *
   *   A `counts=true` caller can get both, and when it does the cap is still the
   *   figure this column is about: the card's subject is how much the app reads, and a
   *   row count beside it would be a second, differently-meaning number in a column
   *   that holds one. The count is not lost — it is on the Activity page, which is
   *   where the card says the figures are.
   *
   *   `cap !== null` alone, with no `> 0` guard: a cap of zero is refused by the write
   *   path (it must be positive), so a stored zero would be a hand-edited row — and
   *   rendering it as `up to 0 rows` is the honest reading of what it says.
   */
  if (cap !== null) {
    return (
      <li className={rowClass(appOwned)}>
        <span className="signin__ledger-name" title={object.label}>
          {object.name}
        </span>
        <span className="signin__ledger-count signin__ledger-count--cap">
          {/* `up to` rather than a bare number: the cap is a ceiling on what will be
              read, not a measurement of what is there. See the doc block. */}
          {`up to ${num(cap)} rows`}
        </span>
      </li>
    );
  }

  if (whole === null) {
    /*
     * ★ `rowCount: null` NOW MEANS "NOT ASKED FOR" RATHER THAN "COULD NOT BE COUNTED",
     *   AND THE ROW SAYS WHICH.
     *
     *   This branch used to print `not counted`, which was right when the endpoint
     *   always tried and an object could genuinely fail to answer. The card now asks
     *   for `counts=false`, so every row is `null` for the same benign reason, and
     *   `not counted` on all 34 rows would read as 34 failures — the exact
     *   misreading this project has been bitten by before, where a count that could
     *   not be taken was compared against a table total.
     *
     *   So the row states the absence without implying a fault. The distinction is
     *   preserved for a caller that does ask: a `counts=true` payload whose object
     *   failed still arrives as `null`, and the two are told apart by `countedAt` —
     *   a stamp means the pass ran, `null` means it did not.
     *
     *   ★ AND `rows not counted` IS STILL THE RIGHT WORDS FOR AN UNCAPPED ROW. The cap
     *     branch above returns first, so reaching here means no cap is in force and no
     *     count was taken — both true, and the note above the list says the uncapped
     *     objects are read whole.
     */
    return (
      <li className={rowClass(appOwned)}>
        <span className="signin__ledger-name" title={object.label}>
          {object.name}
        </span>
        <span className="signin__ledger-count signin__ledger-count--none">rows not counted</span>
      </li>
    );
  }
  return (
    <li className={rowClass(appOwned)}>
      {/* The descriptor's human label — `Account combination` — which nothing else
          on this card has room for. In the title rather than in the row, because
          the row is a name and a number and a third column would make it a table. */}
      <span className="signin__ledger-name" title={object.label}>
        {object.name}
      </span>
      <span className={narrowed === null ? 'signin__ledger-count' : 'signin__ledger-count signin__ledger-count--scoped'}>
        {narrowed === null ? (
          num(whole)
        ) : (
          <>
            {num(narrowed)}
            {/* ` of N` rather than a second column: the narrower figure is the one the
                heading's claim is about, so it leads and the whole object follows it.
                See `.signin__ledger-count--scoped` for why the pair is not one number. */}
            <span className="signin__ledger-count-total">{` of ${num(whole)}`}</span>
          </>
        )}
      </span>
    </li>
  );
}

function rowClass(appOwned: boolean): string {
  return appOwned ? 'signin__ledger-row signin__ledger-row--app' : 'signin__ledger-row';
}

export default function SignIn() {
  const user = useSession();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const signedIn = user?.authenticated === true;
  const from = readFrom(location.state);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setProblem(null);
    try {
      const who = await signIn(email.trim(), password || undefined);
      /*
       * ★ THE PAGE THEY WERE TRYING TO REACH OUTRANKS THE ROLE DEFAULT.
       *
       *   Gating turns every deep link into a two-step journey, so the second step has
       *   to remember the first. A session that ignored `from` would drop a reader who
       *   followed a link to `/coa/combinations` onto the dashboard and leave them to
       *   find it again — having already learned that links in this app do not go where
       *   they say.
       *
       *   The role rule below is still the answer for somebody who opened `/sign-in`
       *   directly: the gear is the only reason an address and a password are worth
       *   typing, so a super admin lands on the screen the gear would have opened, and
       *   anybody else lands on the dashboard, which is where a member's day starts.
       */
      navigate(from ?? (isSuperAdmin(who) ? '/settings' : '/'), { replace: true });
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'The sign-in did not go through.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="signin">
      <div className="signin__card">
        {/* The name of the app is the title of this screen, so the brand block carries
            the page's `<h1>` and everything below it is a level down. */}
        <AppBrand heading />

        {signedIn && user ? (
          <div className="signin__body">
            <div className="signin__head">
              <h2 className="signin__title">Signed in</h2>
              <span className="signin__tag">{isSuperAdmin(user) ? 'super admin' : 'member'}</span>
            </div>

            <dl className="idcard">
              <div>
                <dt>Name</dt>
                <dd>{user.name}</dd>
              </div>
              <div>
                {/*
                  ★ `Email`, NOT `Email Address`, AND NOT BECAUSE THE FORM SAYS SOMETHING
                    ELSE. The form's label is read once, before typing, by somebody who
                    has to know which credential is wanted; this one is read in a grid of
                    four facts about an account that is *already* signed in. `.idcard` is
                    a narrow column, and "Email Address" wraps where "Email" does not.

                  ★ IT WAS `Address`, WHICH IS THE POINT. The same value under two
                    different words on one screen is how a reader concludes they are two
                    different things — and the form label was changed to "Email Address"
                    without this one, so the drift had already started.
                */}
                <dt>Email</dt>
                <dd>{user.email}</dd>
              </div>
              <div>
                <dt>Organization</dt>
                <dd>{user.organizationName}</dd>
              </div>
              <div>
                <dt>Scope</dt>
                <dd>
                  {user.organization
                    ? `Fund ${user.organization.fund} · from FY ${user.organization.startFy}`
                    : '—'}
                </dd>
              </div>
            </dl>

            <p className="chart-note">
              {isSuperAdmin(user)
                ? 'Administration › Settings opens the organization register, and the gear in the rail goes to the same page.'
                : 'This account is a member, so the organization register is not offered. That is the whole difference between the two roles: a super admin may create and edit organizations, and a member may read.'}
            </p>

            <div className="idcard__actions">
              {/*
                ★ THE ESCAPE HATCH IS IN THE SIGNED-IN CARD ONLY, AND THAT IS THE
                  WHOLE REASON THE OLD "Dashboard" BUTTON IS NOT AT THE TOP OF THE
                  PAGE ANY MORE. Signed out, a link to `/` is a link to this screen:
                  the gate would bounce the reader straight back, which reads as a
                  broken button rather than as a rule. Signed in, it is the right
                  thing to offer beside "Signed in".
              */}
              <Link className="btn btn--primary" to={from ?? '/'}>
                {from ? 'Continue where you were' : 'Open the dashboard'}
              </Link>
              <button
                type="button"
                className="btn btn--system"
                onClick={() => {
                  signOut();
                  setProblem(null);
                  setPassword('');
                }}
              >
                Sign out
              </button>
            </div>

            <p className="field__hint">
              Signing out drops this browser&rsquo;s copy of the token. There is no revoke endpoint, so
              any other browser holding the same token stays signed in until it expires — after twelve
              hours — and this button is not allowed to claim otherwise.
            </p>
          </div>
        ) : (
          <form className="signin__body" onSubmit={onSubmit} noValidate>
            <div className="signin__head">
              <h2 className="signin__title">Sign in</h2>
              <span className="signin__tag">{from ? 'to continue' : 'required'}</span>
            </div>

            {/*
              ★ THE LEDE PARAGRAPH THAT SAT HERE IS GONE — the one paragraph between
                this heading and the first field.

                It said two things: that the application needs a session before it
                will open anything, and that a session carries the organization whose
                scope the registers filter by. Neither is a fact a person signing in
                can act on. The heading above already says `Sign in` and the tag
                beside it already says `required`, so the first sentence restated the
                form's own furniture; the second explained the ledger rather than the
                login, in the one place a reader has no way to check a claim about a
                fund or a fiscal year.

                ★ IT WAS ALSO THE LARGEST BLOCK OF PROSE ON THE SCREEN, SITTING
                  ABOVE THE FIELDS. A login form asks for two things. Sending the
                  reader through a paragraph to reach them is what the removal is
                  for.

              ★ AND NOTHING CHECKED IT. Removing it breaks no assertion and no test —
                the sentence existed only in this file. If the destination warning is
                ever thought to be missing: it is not. The `signin__tag` reads
                `to continue` when `from` is set, and the signed-in state's button
                reads `Continue where you were`, so `from` stays defined and used.
            */}

            {problem ? (
              /* ★ ONE sentence for a wrong password and for an address that does not exist,
                 because that is what the endpoint does on purpose. The wording here must not
                 add an implication the server took trouble to avoid. */
              <div className="notice notice--err" role="alert">
                <p>
                  <strong>That did not sign in.</strong>
                </p>
                <p>{problem}</p>
              </div>
            ) : null}

            <div className="field">
              <label className="field__label" htmlFor="signin-email">
                Email Address <span className="field__req">required</span>
              </label>
              {/*
                ★ THE HINT THAT USED TO SIT UNDER THIS INPUT IS GONE, AND SO IS THE
                  `aria-describedby` THAT POINTED AT IT.

                It explained which column the server looks an address up in — true, and
                addressed to the wrong reader. This is the *first* field of the first
                screen of the application, and its subject was `SUPER_ADMIN_EMAIL` and
                `app_user`, which is a note for whoever maintains the login rather than
                for whoever has to use it. The one fact a person signing in needs is
                already in the input: the placeholder shows the address.

                ★ LEAVING `aria-describedby="signin-email-hint"` IN PLACE WOULD HAVE
                  BEEN WORSE THAN LEAVING THE PARAGRAPH. A description pointing at an id
                  that does not exist resolves to nothing, so it reads as "this field
                  has no hint" while being indistinguishable in the source from one that
                  has — the kind of dangling reference that is invisible until an
                  accessibility audit reports it. If the hint ever comes back, the
                  attribute comes back with it.
              */}
              <input
                id="signin-email"
                className="input"
                type="email"
                value={email}
                autoComplete="username"
                spellCheck={false}
                autoFocus
                onChange={(e) => setEmail(e.target.value)}
                placeholder="admin@oracleinsights.local"
              />
            </div>

            <div className="field">
              <label className="field__label" htmlFor="signin-password">
                Password
              </label>
              {/*
                ★ THE HINT UNDER THIS INPUT IS GONE TOO, FOR THE SAME REASON AS THE ONE
                  UNDER THE EMAIL FIELD — and the sentence it carried is worth keeping
                  somewhere, because it is the one fact here that is *not* about how the
                  form is built.

                It said that an unknown address and a wrong password answer with one
                sentence on purpose, so the form cannot be used to discover which
                addresses exist. That is a real property of the endpoint, and its
                consequence is the `notice--err` above: whatever goes wrong, the same
                sentence comes back, and a reader has to be told not to read it as a
                partial answer. The notice already states it in the place it matters —
                at the moment it happens, rather than pre-emptively under a field.

                So the removal is a relocation, not a deletion. If the error notice is
                ever reworded, this is the claim it has to keep.

                ★ AND THE `aria-describedby` GOES WITH THE PARAGRAPH. `Password` now has
                  no description at all, which is correct — a described-by pointing at an
                  id that does not exist fails silently and reads as a field that has
                  none, so the two have to move together in both directions.
              */}
              <input
                id="signin-password"
                className="input"
                type="password"
                value={password}
                autoComplete="current-password"
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            <div className="idcard__actions">
              <button
                type="submit"
                className="btn btn--primary"
                disabled={busy || email.trim() === ''}
                aria-describedby={email.trim() === '' ? 'signin-blocked' : undefined}
              >
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
              {email.trim() === '' ? (
                <p className="field__hint" id="signin-blocked">
                  An email address is required. The password is not, for an address the server
                  already knows.
                </p>
              ) : null}
            </div>

            {/*
              ★ WHAT IS BEHIND THE DOOR, SAID ONCE THE DOOR IS IN FRONT OF YOU.

                A reader who has not signed in has been told nothing about the data
                yet, and "this application needs a session" is a rule without a
                subject. One line of scale gives the rule something to be about.

              ★ THE FIGURES WERE STATED AND ARE NOW READ, AND THE CHANGE IS THE POINT
                OF THE BLOCK RATHER THAN AN IMPROVEMENT TO IT.

                The old version printed a recorded measurement of the **Oracle source**
                — 34 tables, over 197 million rows. That was accurate about a database
                this deployment no longer reads. Pointed at a copied and seeded Turso
                ledger it was wrong by four orders of magnitude, in the one place a
                reader is deciding whether the thing they are opening is the real one.
                `data/ledgerSummary.ts` carries the full argument; the short version is
                that a figure which cannot change cannot be right about a store that
                does, so the screen asks `GET /api/meta/ledger-summary` instead.

              ★ WHICH MEANS THERE IS NOW A LOADING STATE AND A FAILURE PATH TO WORD,
                AND BOTH ARE SHOWN. The request is not on the path of the form — the
                button below works whether or not it has answered — so the worst case
                is that this block reports that it could not count and says so. What it
                must never do is print a remembered number in the present tense.

              ★ IT SITS BELOW THE SIGN IN BUTTON, NOT ABOVE THE FORM, AND THAT IS A
                MEASUREMENT RATHER THAN A PREFERENCE. Placed above the lede it was
                the third thing on the card, and at the panel size this app is
                actually read at (642×515, measured) it pushed the button — the one
                action the screen exists to offer — below the fold. Below the button
                the same block costs nothing: the action is the first thing reached
                with a thumb, and the scale reads as what the button opens rather
                than as a delay in front of it. A reader who never reads it has lost
                nothing, because it is context and not an instruction.

                ★ AND LIKE A GROWING LIST RATHER THAN A SENTENCE, A BLOCK IN THE
                WRONG PLACE WOULD MOVE THE BUTTON. This one can now be thirty-odd
                rows tall depending on the store, which is a second reason it belongs
                after the action and not before it — see the scroll cap in
                `styles/signin.css`.

              ★ AND IT IS STILL NOT A FOOTNOTE. `.signin__foot` below the card is
                about the screen (what it does not protect); this is about the data
                (what is behind it). Same reason it does not belong under the lede:
                the subject is the ledger, not the form.
            */}
            <LedgerSnapshot />
          </form>
        )}
      </div>

      {/*
        ★ THE FOOT NOTE SAYS WHAT THE SCREEN IS NOT. A login screen invites a reader to
          assume it is what keeps the data in, and in this app that assumption would be
          wrong.

        ★ THIS SENTENCE USED TO LEAD WITH \"THE EXTRACT ITSELF IS SERVED AS A STATIC
          FILE\", AND THAT STOPPED BEING THE POINT WHEN THE REGISTERS WERE POINTED AT
          THE LIVE LEDGER. The extract is still a static file answered whether or not
          anybody signs in — but nothing the reader is about to use reads it any more,
          so naming it first warned about a bypass of a thing the application no
          longer goes through, and read as an aside about a file rather than about the
          data. The fact that survives the change is the one level down: the API is
          what refuses, and this screen is a convenience in front of it.

        ★ IT NAMES THE MECHANISM (\"re-checks the session on each request\") RATHER THAN
          THE PROMISE (\"is secure\"). A promise is not checkable and every application
          makes it; the mechanism is what a reader can go and look at, and it is also
          the reason the two sentences above it are safe to say at all.
      */}
      <p className="signin__foot">
        This screen is for the reader, not for the data. Every register is answered by the server,
        which re-checks the session on each request, and the guarded writes are refused outright for
        anybody without one.
      </p>
    </div>
  );
}
