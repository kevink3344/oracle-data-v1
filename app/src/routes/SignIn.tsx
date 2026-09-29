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
 *   1. **A password is checked for every account, members included.** It used to not
 *      be: a row in `app_user` was signed in on the strength of its address, and this
 *      header said exactly that. `app_user.password_hash` closes it, so the form now
 *      asks for the credential the server actually verifies.
 *   2. **A wrong password, an unknown address, and an account with no password set
 *      answer with the same sentence.** That is deliberate on the server, and this
 *      page must not undo it by counting the failures or wording them differently.
 *   3. **Signing out is local.** There is no revoke endpoint — sessions are a
 *      process-local map with a twelve-hour TTL — so the button says what it did:
 *      it dropped this browser's copy of the token.
 *
 * ── ★ WHY THE FORM IS TWO STAGES RATHER THAN TWO FIELDS
 *
 * A login form with both fields on it asks for a secret before it knows whose secret
 * it is, which is how a password manager ends up offering to save a credential
 * against an address that was typed wrong. Splitting it makes the address something
 * the second screen *states* rather than a field it re-asks, so the reader confirms
 * the account before choosing the password.
 *
 * ★ STAGE ONE ASKS THE SERVER NOTHING, AND THAT IS A DECISION RATHER THAN AN
 *   OVERSIGHT. The obvious design is an endpoint that answers "does this address have
 *   an account?", so stage one can refuse a stranger before they type anything. That
 *   endpoint would be a directory lookup open to anybody: it would answer the exact
 *   question the server's identical 401 exists to refuse, and it would answer it
 *   faster and with a `200`. So the address is taken on trust here and the server
 *   decides once, at the end. A typo therefore costs one password entry, and the
 *   `Change` action on stage two is what makes that recoverable.
 *
 * ★ THE PASSWORD INPUT IS UNMOUNTED ON STAGE ONE, NOT HIDDEN ON IT. A hidden
 *   `type="password"` is still in the document: a password manager will fill it, and
 *   a reader tabbing through stage one lands in a field that stage has not reached.
 *   Not rendering it is the only form of "not asked for yet" the browser believes too.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import AppBrand from '../components/AppBrand';
import { num, pluralise } from '../data/format';
import { LEDGER_SCALE, recordsFloor, STORE_SCALE } from '../data/ledgerScale';
import { useLedgerSummary, type LedgerObject } from '../data/ledgerSummary';
import { capTotals, describeCapTotal, loadReadCaps, type ReadCapList } from '../data/readCaps';
import { isSuperAdmin, roleLabel, signIn, signOut, useSession } from '../data/session';

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
 * ★ ★ THE HEADLINE IS ABOUT **THIS STORE**, AND THE ORACLE SOURCE IS A SEPARATE, LABELLED
 *   REFERENCE ONE PARAGRAPH DOWN. That distinction is the whole of the most recent change
 *   here: the headline used to quote `LEDGER_SCALE` (Oracle, 197 M rows, dated 2026-09-22)
 *   while the deployment it was drawn on holds 8,059,638 rows. Both figures still appear;
 *   they are simply no longer allowed to swap labels — see `STORE_SCALE` in
 *   `data/ledgerScale.ts` for the argument and `store:scale` for how it was taken.
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
 * ★ THE FIGURE IS THE TOGGLE AND THE LISTS ARE FOLDED BEHIND IT. The headline numbers are
 *   the answer a reader came for; the one-row-per-object list is the proof and the
 *   provenance note is the caveat. Folding them means the sign-in card opens with the
 *   fact showing and the evidence one click away, instead of a fifty-odd row list
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
   * ★ THE THREE DERIVATIONS THAT FED THE CARD'S DESCRIPTION ARE GONE — DELETED, NOT LEFT
   *   UNUSED, AND WHAT THEY CARRIED IS RECORDED HERE.
   *
   *   This component used to print a paragraph under the figure, and the paragraph was
   *   fed from three values derived at this exact point:
   *
   *     `scopeLine`   the account scope in words, built from `summary.scope`
   *     `countedWhen` the age of the read, built from `summary.countedAt`
   *     `composed`    the `V_`-prefixed objects, which are composed over base tables
   *
   *   ★ THEY ARE NOT KEPT `just in case`, WHICH IS THE WHOLE POINT OF REMOVING THEM.
   *     Each one existed to render inside that paragraph and nowhere else, so with the
   *     paragraph gone they have nowhere left to render — and `noUnusedLocals` would
   *     refuse them anyway. A derivation with no reader is not a spare part; it is a
   *     claim about the payload that can drift out of step with the payload unnoticed.
   *
   *   ★ WHAT THEY SAID THAT IS STILL TRUE, AND WHERE IT IS NOW ANSWERED INSTEAD:
   *
   *     The account scope is still read from this payload and still applied — by the
   *     ledger routes that serve the pages behind sign-in, and on the Activity page,
   *     which is where a reader is inside a session and has asked for figures. That is
   *     the same reason the row counts moved there: the scope belongs where the reads
   *     it narrows actually happen, not on a form nobody has signed in to yet.
   *
   *     The three composed `V_*` objects are still listed below, and this is the one
   *     fact that was stated *only* in the deleted paragraph: their rows are already
   *     present in the base tables beside them, so a reader adding the list up would
   *     count them twice. The `V_` prefix is the visible half of the claim and
   *     `server/src/routes/meta.ts` carries the derivation, so it stays recoverable —
   *     it is simply no longer narrated on the sign-in card.
   *
   *     The Oracle source's own figure is still quoted, by `RecordedScale`, on the
   *     states where this deployment's figure cannot be read — which is the same
   *     sentence the deleted paragraph used, through `recordedProvenance()`.
   */

  /*
   * ★ THE CARD LEADS WITH THIS STORE'S OWN SHAPE, THEN THE BOUND ON WHAT WILL BE READ.
   *
   *   This block once read `32 tables · 197,019,139 records`, and the second half of that
   *   was the most expensive read in the app: a `COUNT(*)` over `GL_BALANCES` at 157 M rows
   *   plus two composed views at ~13 s each, taken on every load of a page nobody had
   *   signed in to yet. Measured across takes: 51 s, 67.5 s, 95.5 s, 204.3 s, 397.3 s and
   *   307.7 s — the last of which lost its connection before answering. The reported
   *   symptom was the screen sitting on "Counting the ledger…".
   *
   *   Parallelising the count loop did not fix it (397.3 s sequential, 307.7 s with four
   *   workers), so the LIVE figure was removed from this screen instead of made faster.
   *   The request now asks for `counts=false` and the server answers from the descriptor
   *   list, which is exact and free.
   *
   *   ★ ★ THEN IT WENT WRONG IN THE OTHER DIRECTION, AND THAT IS WHAT THIS CHANGE FIXES.
   *     The scale figure came back as `LEDGER_SCALE` — the **Oracle** source, dated
   *     2026-09-22 — and the headline read `55 tables the API serves · over 197 million`
   *     over a store holding **8,059,638** rows. So the card had gone from a figure that
   *     cost four minutes to a figure that was about the wrong database, in the one place
   *     a reader is deciding whether the app they are opening is the real one.
   *
   *     ★ AND THE TWO HALVES DESCRIBED DIFFERENT SETS. `55` was the endpoint's
   *       `objectCount` — descriptors unioned with the cap registry — and `197 million` was
   *       34 descriptors counted on Oracle. A live count of one set beside a recorded total
   *       of another, joined by a `·`. Two figures from two sources reading as one claim is
   *       the shape of error the card exists to prevent, so the fix is not a new number: it
   *       is making both halves facts about the same database.
   *
   *   ★ THE THREE FIGURES ARE NOW COMPOSED FROM WHAT IS *FREE*, AND ALL THREE ARE ABOUT
   *     THIS DEPLOYMENT:
   *
   *       50 tables            `STORE_SCALE.tables` — every user table in the store
   *       over 8 million       `STORE_SCALE.records`, floored, measured by `store:scale`
   *       up to N rows         the live cap total — a stored row, not a scan
   *
   *     ★ THE ROW FIGURE IS A *MEASURED SNAPSHOT*, AND IT IS FLOORED. It is a real
   *       `COUNT(*)` over every table, so it is cheap enough to take on demand but not
   *       cheap enough to take on every page load — hence a recorded constant rather than
   *       a request, with its date and its store attached in the body below. `recordsFloor`
   *       makes it `over 8 million` rather than `8,059,638` because a sync writes to this
   *       store while the screen is up: a floor stays true as rows arrive, an exact figure
   *       is a promise with an expiry.
   *
   *     ★ AND THE ORACLE FIGURE HAS NOT BEEN DELETED, ONLY DEMOTED AND LABELLED. It is
   *       still the only thing that answers "how big was the ledger this came from", which
   *       is a question management ask — so it stays in the body, quotes `LEDGER_SCALE`,
   *       and names its database and its date. A number is either current or accompanied
   *       by where it came from; what it must not do is sit behind this one's label, which
   *       is what it was doing.
   *
   *   ★ WHAT IS STILL *NOT* HERE: THE LIVE COUNT, AND THE SCOPE EVIDENCE IT CARRIED. The
   *     sentence that compared `scopedRecords` against `ledgerRecords` — the one that
   *     showed fund 04 was actually narrowing the reads — cannot be made without a live
   *     pass, so it stays gone from this card. It belongs on the Activity page, which
   *     counts these same objects inside a session where a wait is expected.
   */
  return (
    <details className="signin__scale">
      <summary className="signin__scale-head">
        <span className="signin__scale-figure">
          {/*
            ★ ★ THIS SENTENCE DESCRIBES THIS DEPLOYMENT'S STORE, AND IT DID NOT BEFORE.

              It read `55 tables the API serves · over 197 million`, and the two halves
              were not measurements of the same thing. `55` is `GET
              /api/meta/ledger-summary`'s `objectCount` — the registered descriptors
              unioned with the cap registry, deduplicated by table — i.e. what the *API is
              configured to serve*. `over 197 million` was `LEDGER_SCALE`, a count of 34
              descriptors taken against **Oracle** on 2026-09-22. On the deployment this
              card is the front door of, the store holds **8,059,638** rows. So the
              headline overstated the database by two orders of magnitude, in the one
              place a reader is deciding whether what they are opening is the real one.

            ★ AND IT PUT A LIVE COUNT BESIDE A RECORDED TOTAL OF A DIFFERENT SET, joined by
              a `·` so the two read as one claim. That is the failure mode this card has
              already been fixed for once — a figure presented in the present tense about a
              store it did not measure — and the fix this time is to make both halves
              facts about the same database.

            ★ THE FIGURES NOW COME FROM `STORE_SCALE`, WHICH IS THIS STORE. `tables` is
              every user table in the database (`sys.tables` / `sqlite_master`, shipped
              tables excluded) and `records` is the sum of real `COUNT(*)`s over all of
              them, cross-checked against `sys.partitions` — no object list and no account
              scope, because the question is "how many rows are in this database" and any
              restriction would make the answer to *that* question wrong. It is floored to
              `over 8 million` by `recordsFloor` because a sync writes to this store while
              the screen is up, so an exact figure would be a promise with an expiry.

            ★ NEITHER FIGURE IS THE API'S OWN. `summary.objectCount` is 55 because it
              counts the cap registry too, and 18 of those 55 cannot be counted at all —
              so it is the right number for "what will this app read" (which the cap
              sentence below answers) and the wrong one for "what is in this database".
              The two sets are named separately for that reason rather than reconciled.
          */}
          {pluralise(STORE_SCALE.tables, 'table')}, {recordsFloor(STORE_SCALE)} rows
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
        {/*
          ★ ★ THERE WAS A PARAGRAPH HERE AND IT IS DELETED — THE FIGURE ABOVE IS THE CARD.

            It ran to four sentences and it covered: the store the list was read from and
            how many objects were in it, the account scope those reads were narrowed to,
            the count of app-owned tables, the three composed `V_*` views, an explanation
            of why no row counts are taken on this screen, and the Oracle provenance of the
            figure for scale. Everything in it was accurate and every sentence had been
            argued for on its own — and that is exactly what it had become: a paragraph
            defending a headline to a reader who had not asked for the defence.

            ★ THE REASON IT WENT IS THE REASON IT WAS WRITTEN. The figure above it is
              "50 tables, over 8 million rows", and the point of putting a figure on a
              sign-in card is that it can be read in passing. A reader who wants how the
              number was taken can have it — the table list below is the same population
              the paragraph was describing, and the pages behind sign-in do the explaining
              where the reads actually happen.

            ★ WHAT WAS IN IT THAT LIVES NOWHERE ELSE, NAMED SO IT IS NOT LOST: that the
              three `V_*` objects below are composed over the base tables rather than
              stored, so their rows are already present in the base tables listed beside
              them. A reader adding the list up will count them twice. The `V_` prefix is
              the visible half of that claim, and `server/src/routes/meta.ts` carries the
              derivation — so it is recoverable, it is just no longer narrated here.

            ★ AND THE THREE DERIVATIONS THAT FED IT ARE DELETED WITH IT, at the top of this
              component, with a comment recording where each of their facts is answered
              now. Rebuilding this paragraph means rebuilding them; that is the intended
              cost rather than an oversight.
        */}

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
  /**
   * Which of the two questions is on screen. `'email'` first, always — the split and
   * its reasons are in the module header.
   */
  const [stage, setStage] = useState<'email' | 'password'>('email');

  const signedIn = user?.authenticated === true;
  const from = readFrom(location.state);
  const address = email.trim();

  /**
   * Stage one: take the address, ask nothing, move on.
   *
   * ★ THE EMPTY-ADDRESS GUARD IS HERE AS WELL AS ON THE BUTTON. The button is disabled
   *   while the field is empty, but implicit submission — Enter inside a text input —
   *   does not consult the button's state in every browser, and advancing on an empty
   *   address would put a blank value on a screen whose whole job is to state it.
   */
  function onAdvance(event: React.FormEvent) {
    event.preventDefault();
    if (address === '') return;
    setProblem(null);
    setStage('password');
  }

  /**
   * Back to the address, which is how a mistyped one gets corrected.
   *
   * ★ IT CLEARS THE PASSWORD, AND THAT IS NOT TIDINESS. The password was typed for the
   *   address being abandoned; carrying it forward would submit one account's secret
   *   against another account's address. There is no case where keeping it is right.
   */
  function onBack() {
    setProblem(null);
    setPassword('');
    setStage('email');
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    // ★ GUARDED HERE, NOT ONLY ON THE BUTTON — see the note on `onAdvance`. A request
    //   with an empty password is refused 400 by the server's body schema, and that
    //   would surface as a validation failure rather than as the half-filled form it
    //   actually is.
    if (busy || password === '') return;
    setBusy(true);
    setProblem(null);
    try {
      const who = await signIn(address, password);
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
       *   anybody else lands on the dashboard, which is where a staff account's day
       *   starts.
       */
      navigate(from ?? (isSuperAdmin(who) ? '/settings' : '/'), { replace: true });
    } catch (err) {
      setProblem(err instanceof Error ? err.message : 'The sign-in did not go through.');
      // ★ CLEARED ON FAILURE, INCLUDING ON A NETWORK FAILURE WHERE RETYPING THE SAME
      //   PASSWORD WOULD HAVE WORKED. A wrong password left in the box is the one
      //   thing a reader is most likely to resubmit unchanged, and an empty field
      //   says plainly that the next attempt starts from nothing.
      setPassword('');
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
              <span className="signin__tag">{roleLabel(user.role)}</span>
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
                ? 'Administration › Settings opens the organization and user registers, and the gear in the rail goes to the same page.'
                : `This account holds the ${roleLabel(user.role).toLowerCase()} role, so neither register is offered. A super admin may create and edit organizations and accounts; ${user.role === 'administrator' ? 'an administrator reaches nothing a staff account does not' : 'staff may read what everyone reads and nothing further'}.`}
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
          /*
           * ★ ONE <form>, TWO SUBMIT HANDLERS, CHOSEN BY STAGE.
           *
           *   Stage one's handler never leaves the browser — it validates the address is
           *   present and moves on. Stage two's is the one that talks to the server. Both
           *   are wired to `onSubmit` on the same element, so Enter works on both stages
           *   and the browser's own submit machinery — which is what a password manager
           *   watches — sees a single form throughout rather than two.
           *
           *   ★ A SECOND <form> WOULD HAVE BEEN THE EASY VERSION AND THE WORSE ONE. The
           *     save-credential heuristic keys on a form that was submitted, and two
           *     forms is two submissions it has to reconcile.
           */
          <form
            className="signin__body"
            onSubmit={stage === 'email' ? onAdvance : onSubmit}
            noValidate
          >
            <div className="signin__head">
              <h2 className="signin__title">Sign in</h2>
              <span className="signin__tag">{from ? 'to continue' : 'required'}</span>
            </div>

            {/*
              ★ THE NOTICE IS GATED TO STAGE TWO, AND NOT ONLY BECAUSE `onBack` CLEARS IT.

                `problem` can only be set by a submission, and only stage two submits —
                so in practice it is already null by the time stage one renders. The gate
                is here because that is a property of two other functions rather than of
                this one: a notice reading "That did not sign in" above a form that asks
                for one address and no credential describes something the reader cannot
                see. Gating it makes the invariant local instead of relying on the fact
                that leaving stage two happens to tidy up. Two guards, one of which is
                load-bearing.

              ★ THERE IS NO "FORGOT PASSWORD" LINK HERE, AND ITS ABSENCE IS STILL A
                DECISION RATHER THAN AN OVERSIGHT — BUT THE REASONING BEHIND IT CHANGED.

                ★ WHAT THIS PARAGRAPH USED TO SAY, AND WHY IT IS WRONG NOW. It said
                  there was no self-service reset because `/admin/users` was declared
                  `built: false` and `npm run set:password` was the only way a password
                  was ever set. Both of those are now false: the Users & roles panel
                  under Settings sets an account's password, and `POST
                  /api/users/{id}/password` is what it calls. Writing the old sentence
                  next to a screen that does exactly what it denies is worse than
                  writing nothing.

                ★ AND IT IS STILL NOT A LINK, FOR A NARROWER AND STRONGER REASON. A
                  reset link here would be clicked by somebody who cannot sign in, and
                  every path that sets a password requires a session that is already
                  established as a super admin. There is no mail path out of this
                  application — no reset token, no outbound address, nothing to put in
                  an email — so a link would either do nothing or would have to be a
                  route that sets a password for an unauthenticated caller. The second
                  is a way in, not a way back. So the honest control is the sentence
                  below and a runbook in `docs/`, and the two people who need it are
                  named there rather than here.

                ★ THE PLACE THIS IS ACTUALLY A PROBLEM, NAMED AND NOW HALVED: a
                  super admin who forgets their password still has no path on screen,
                  because unlocking the panel that sets passwords needs the password.
                  That one case has exactly one answer left — an operator with the
                  connection string running `npm run set:password -- --email <address>`
                  — and it is why that script survives a feature that otherwise
                  replaced it. Everybody else is covered: any super admin can set any
                  other account's password from Settings.

                  The refusal on a failed sign-in stays generic on purpose, so the
                  server cannot be asked which addresses exist. That means nobody can
                  tell a locked-out account apart from a stranger by trying — which is
                  the point, and is also why the recovery path has to be a person
                  rather than a form.
            */}
            {problem !== null && stage === 'password' ? (
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
              {stage === 'email' ? (
                <>
                  <label className="field__label" htmlFor="signin-email">
                    Email Address <span className="field__req">required</span>
                  </label>
                  {/*
                    ★ THE HINT THAT USED TO SIT UNDER THIS INPUT IS GONE, AND SO IS THE
                      `aria-describedby` THAT POINTED AT IT.

                    It explained which column the server looks an address up in — true,
                    and addressed to the wrong reader. This is the *first* field of the
                    first screen of the application, and its subject was
                    `SUPER_ADMIN_EMAIL` and `app_user`: a note for whoever maintains the
                    login rather than for whoever has to use it.

                    ★ LEAVING `aria-describedby="signin-email-hint"` IN PLACE WOULD HAVE
                      BEEN WORSE THAN LEAVING THE PARAGRAPH. A description pointing at an
                      id that does not exist resolves to nothing, so it reads as "this
                      field has no hint" while being indistinguishable in the source from
                      one that has — the kind of dangling reference that is invisible
                      until an accessibility audit reports it. If the hint ever comes
                      back, the attribute comes back with it.

                    ★ AND THE PLACEHOLDER THAT STOOD IN FOR IT IS GONE TOO. It read
                      `admin@oracleinsights.local`, which is the *bootstrap* address —
                      the one account that is not in `app_user` and that the deployment
                      may not even have configured. As a grey example in the application's
                      first input it is indistinguishable from a suggestion, and the
                      reader it misleads is the one account that could have signed in
                      anyway. A placeholder that names a real address is a worse hint
                      than no placeholder; the label above already says what to type.
                  */}
                  <input
                    id="signin-email"
                    name="email"
                    className="input"
                    type="email"
                    value={email}
                    autoComplete="username"
                    spellCheck={false}
                    autoFocus
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </>
              ) : (
                <>
                  {/*
                    ★ THE ADDRESS IS STATED, NOT RE-ASKED, AND IT IS TEXT RATHER THAN A
                      DISABLED OR READ-ONLY INPUT.

                    A disabled input is not focusable, not submitted, and announced by a
                      screen reader as a form control — one that cannot be used. A
                      read-only input is a control the reader is invited to try. Neither
                      is what this is: the address has been answered, the question is
                      over, and what belongs on screen is the *fact*. So it is a
                      `<span>`, and the only control beside it is the one that undoes it.

                    ★ THE COST, NAMED: with no username input in the DOM at submit time,
                      a password manager may not offer to save the credential. That is a
                      real loss and it is the accepted half of the trade, because the
                      alternative — a control on screen pretending to be editable — is a
                      worse one on every other axis. The address is one line and the
                      reader has just typed it.
                  */}
                  <span className="field__label" id="signin-address-label">
                    Email Address
                  </span>
                  <div className="signin__address" aria-labelledby="signin-address-label">
                    <span className="signin__address-value">{address}</span>
                    <button type="button" className="signin__address-change" onClick={onBack}>
                      Change
                    </button>
                  </div>
                </>
              )}
            </div>

            {/*
              ★ THE PASSWORD FIELD EXISTS ONLY ON STAGE TWO, AND THAT IS LITERAL. It is
                not hidden, not `disabled`, and not rendered at all while the address is
                being asked for — see the module header for why that distinction is the
                whole reason the split is worth making.
            */}
            {stage === 'password' ? (
              <div className="field">
                <label className="field__label" htmlFor="signin-password">
                  Password <span className="field__req">required</span>
                </label>
                {/*
                  ★ THE HINT UNDER THIS INPUT IS GONE, AND THE SENTENCE IT CARRIED IS
                    KEPT SOMEWHERE THAT MATTERS MORE.

                  It said that an unknown address and a wrong password answer with one
                  sentence on purpose, so the form cannot be used to discover which
                  addresses exist. That is a real property of the endpoint, and its
                  consequence is the `notice--err` above: whatever goes wrong, the same
                  sentence comes back, and a reader has to be told not to read it as a
                  partial answer. The notice says that at the moment it happens rather
                  than pre-emptively under a field.

                  So the removal is a relocation, not a deletion. If the error notice is
                  ever reworded, this is the claim it has to keep.

                  ★ AND THE `aria-describedby` GOES WITH THE PARAGRAPH. `Password` has no
                    description at all, which is correct — a described-by pointing at an
                    id that does not exist fails silently and reads as a field that has
                    none, so the two have to move together in both directions.

                  ★ `required` IS SHOWN BUT NOT SET. The form carries `noValidate` and the
                    submit handler is the guard, so an attribute would add a second,
                    browser-drawn refusal that fires before the server is asked and
                    describes the field rather than the request. The badge is there for
                    the same reason it is on the address: it is what makes a disabled
                    `Sign in` button self-explanatory instead of broken.
                */}
                <input
                  id="signin-password"
                  name="password"
                  className="input"
                  type="password"
                  value={password}
                  autoComplete="current-password"
                  autoFocus
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            ) : null}

            <div className="idcard__actions">
              {stage === 'email' ? (
                /*
                 * ★ IT IS A SUBMIT BUTTON AND NOT A `type="button"` WITH AN `onClick`,
                 *   WHICH IS THE ONE THING THAT MAKES ENTER WORK FOR FREE. A reader who
                 *   types an address and presses Enter is the commonest way through this
                 *   screen; a plain button would leave that key doing nothing at all.
                 *
                 * ★ DISABLED WHILE THE FIELD IS EMPTY, AND THE `required` BADGE ABOVE IS
                 *   THE WHOLE EXPLANATION. The sentence that used to sit here said an
                 *   email was required and that the password was not, "for an address the
                 *   server already knows" — which was true when it was written and is
                 *   now false twice over: the password is required for every account, and
                 *   there is nothing on this stage that could ask for it. Rather than
                 *   reword a hint into the space between a label and a button, it is
                 *   gone: `Email Address … required` names the field, `Next` names the
                 *   action, and a disabled button beside a field marked required needs no
                 *   sentence to explain itself.
                 */
                <button type="submit" className="btn btn--primary" disabled={address === ''}>
                  Next
                </button>
              ) : (
                <button
                  type="submit"
                  className="btn btn--primary"
                  disabled={busy || password === ''}
                >
                  {busy ? 'Signing in…' : 'Sign in'}
                </button>
              )}
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

              ★ AND IT IS NOT A FOOTNOTE. The card has nothing left below it: the
                paragraph that used to sit there is gone, and with it the distinction
                this comment drew between the screen (what it does not protect) and the
                data (what is behind it). What survives is one place, not two — the
                scale belongs to the ledger, so it sits beside the button that opens
                the ledger, and the card ends there.
            */}
            <LedgerSnapshot />
          </form>
        )}
      </div>

      {/*
        ★ THE FOOT NOTE IS GONE, AND THE ARGUMENT FOR IT IS WORTH RECORDING PRECISELY
          BECAUSE IT WAS A GOOD ONE THAT LOST.

        It read: "This screen is for the reader, not for the data. Every register is
        answered by the server, which re-checks the session on each request, and the
        guarded writes are refused outright for anybody without one." Every word of that
        is true, and it named the mechanism — re-checking the session — rather than the
        promise, which is the harder and better half of the craft.

        ★ AND IT WAS STILL THE WRONG SENTENCE FOR THIS SCREEN.

          It answered a question the reader has not asked yet. Nobody arriving at a login
          form is weighing whether the application's authorization is enforced somewhere
          other than here; they are deciding whether to type an email. The paragraph's
          subject was the security architecture, and its position was the one place on
          the screen a reader looks last.

          ★ THE CLAIM DID NOT NEED THE SENTENCE. Anyone who signs in is told the same
            thing at the moment it matters: `.idcard`'s hint on the signed-in card says
            signing out only drops this browser's copy of the token, and that there is no
            revoke endpoint. That is the architecture note in the one place it is
            actionable — beside the button whose limits it describes.

          ★ AND THE LIVE PROOF OF IT IS IN THE OTHER DIRECTION FROM THE PROSE. Asking the
            server without a session answers 401; asking a guarded route with somebody
            else's organization answers 403. Both were confirmed by request, not by
            reading the middleware — so the property the footnote asserted is verified,
            and it is verified in `server/src/scripts/smoke.ts` where it belongs.
      */}
    </div>
  );
}
