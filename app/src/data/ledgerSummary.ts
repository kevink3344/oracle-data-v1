/**
 * What the ledger actually holds, **read** rather than stated.
 *
 * ── ★ THIS REPLACES A RECORDED FIGURE, AND THE REASON IS THAT THE RECORDED ONE
 *      DESCRIBED A DIFFERENT DATABASE.
 *
 * `data/ledgerScale.ts` holds a measurement of the **Oracle source** — 34 tables,
 * over 197 million rows — taken off-line. That was the right trade while counting it
 * live was the expensive path it used to be. It is the wrong *source of truth* in
 * any deployment whose active store is not the one the figure was taken in: under
 * `DB_MODE=turso` the ledger this app reads is a capped, seeded copy, and the two
 * figures differ by four orders of magnitude. A sign-in screen that printed "over
 * 197 million records" over a store holding ten thousand was not describing this
 * deployment at all — it was describing the one the data came from, in the position
 * where a reader would take it for the one they are about to open.
 *
 *   ★ SO THE TWO AGREE IN ORACLE MODE, AND THE ARGUMENT ABOVE IS WHAT SURVIVES THE
 *     FACT THAT THEY DO. Under `DB_MODE=oracle` the live read returns `197,019,139`
 *     — the same figure `ledgerScale.ts` records — so the live read is not *more
 *     accurate* there, it is merely self-maintaining. The reason to keep it is the
 *     `DB_MODE=turso` case, where the recorded figure is not about this store at
 *     all. Removing the request because the numbers currently match would reinstate
 *     the bug it was written to fix, in the mode that is not running today.
 *
 * ── ★ SO THE SIGN-IN SCREEN NOW MAKES A REQUEST, WHICH IT DELIBERATELY DID NOT BEFORE
 *
 * The old comment here argued that the first screen of the application must not
 * wait on the network: it is drawn before a session exists, and a count that took
 * thirteen seconds to print one sentence would be paying the wrong price. That
 * argument still holds against a count that takes a *minute*. It does not hold
 * against `GET /api/meta/ledger-summary`, which answers with the active store's own
 * figures whatever the mode, and it is outweighed by the thing the old design got
 * wrong: a figure that is stated cannot be right about a store that changes.
 *
 *   ★ THE PRICE IS NOT SMALL, IT IS NOT A SECOND, AND IT IS NOT A CONSTANT. Measured
 *     on `DB_MODE=oracle`: **51 s** under funds 02/04, and under fund 04 alone three
 *     consecutive takes of the same endpoint returned **67.5 s**, **95.5 s** and
 *     **204.3 s** — 34 sequential counts against a ledger whose `GL_BALANCES` holds
 *     157,150,828 rows and `GL_JE_LINES` another 33,155,055, two of the composed views
 *     costing ~13 s each. Identical payloads every time (`197019139`, `uncounted: 0`),
 *     identical scope, **3× the elapsed time** — so the spread belongs to Oracle and
 *     the link, not to the query, and any single figure here would be read as a budget
 *     and be wrong most of the time. Note the direction: the *narrower* scope was the
 *     slower set, and the takes got slower as they repeated — and the source itself is
 *     **not** the explanation, because this deployment's health probe (one trivial
 *     statement) answered in **0.25 s, 2.2 s and 2.9 s** on three consecutive pings. So
 *     the cost lives in these 34 counts, not in a broken link. **Why consecutive takes
 *     got slower is NOT established** — do not write a cause; both the warm-up shapes one
 *     would reach for (a filling cache, a cold pool) predict the opposite of what was
 *     seen, and this is three samples of one endpoint. (One
 *     caveat on the 204.3 s take: that run also logged `The underlying connection was
 *     closed: An unexpected error occurred on a receive` and the request still
 *     succeeded — a stale pooled keep-alive connection that .NET retried transparently
 *     — so that figure is one take's elapsed time and may include the retry, and the
 *     error must not be read as the endpoint failing.)
 *     The number quoted here before was `~13 s`, and that is *one table's* count, so it
 *     understated the endpoint **fifteen times over at the slow end**. It was worse than
 *     optimistic: `~13 s` was the cost of the version that **skipped** the two expensive
 *     composed views, and it skipped them because it could not resolve them — the speed
 *     and the wrong total were the same defect. On `DB_MODE=turso` the same request is a
 *     fraction of a second, because the copy is capped. So the wait is an Oracle-mode
 *     cost, and the "Counting the ledger…" sentence is on screen for minutes there.
 *
 *     ★ A WAIT THIS LONG IS A REASON TO FOLD IT, NOT TO DELETE IT — AND THE 204 s TAKE
 *       MAKES THAT AN URGENT POINT RATHER THAN A CAVEAT. The block is a disclosure
 *       behind a summary, drawn after the form, and the form does not wait for it —
 *       which is the only reason a request of this length is acceptable on the first
 *       screen. Anything that moved this read *in front of* the form would be trading a
 *       correct figure for an unusable one. But a disclosure nobody scrolls to after
 *       three minutes is also not disclosure, so the honest fix is to bound or fold the
 *       *work* (batch the counts, or cache the total per scope) rather than to shorten
 *       the sentence that admits it.
 *
 *     ★ THE FOLD WAS THEN DONE, ON THE SERVER, AND THE WAIT IS NOW STATED IN SECONDS.
 *       `server/src/routes/meta.ts` memoises the pass per scope and shares the promise of
 *       a pass already running, so a reload of this screen joins the count in flight
 *       instead of starting a second 34-query pass over 197 M rows — which is what
 *       saturated the Oracle connection pool (`NJS-040 … exceeded "queueTimeout" of
 *       45000`, on two objects, while `/api/health` timed out behind them). Two client
 *       consequences, both deliberate: the payload carries `countedAt`, so a figure that
 *       came from the memo publishes its age instead of being described as fresh; and
 *       the pending state counts the seconds it has been waiting, because the earlier
 *       version rendered one unmoving sentence at four seconds and at four minutes alike
 *       — and four minutes of an unmoving sentence is the "stuck" this was reported as.
 *
 * ★ WHAT THE PRICE BUYS IS A VISIBLE STATE INSTEAD OF AN INVISIBLE ONE.
 *   The request has four outcomes and the caller is given all four: pending, pending
 *   *and slow* (its own state, which deliberately does not claim the read failed), the
 *   figure, and the failure — because the failure is the interesting one. A screen that
 *   showed a remembered number when the read failed would be reporting the ledger as it
 *   was, in the present tense, with nothing on screen saying so. Note the shape: the
 *   freshness rule outlives the cache, because a reused figure is served **with the time
 *   it was taken** rather than passed off as this second's.
 *
 * ── ★ AND `rowCount: null` IS NOT `0`, ALL THE WAY OUT TO THE SCREEN
 *
 * A `COUNT(*)` that fails is reported as `null` — *not countable* — rather than as
 * zero. The two mean opposite things about a table, and `server/src/db/sql.ts` is
 * explicit that a swallowed error returning 0 once produced a fictitious −100%
 * delta in this project. That distinction is preserved here: `rowCount` is
 * `number | null` and the renderer prints something for each case.
 */

import { useEffect, useState } from 'react';

/** Which of the two databases an object was counted in. */
export type LedgerStore = 'ledger' | 'app';

/**
 * How an object's count was narrowed to the account scope.
 *
 * `derived` — a composed view; the scope is inside its fragment, so `rowCount` is already
 *             the narrowed figure and there is no wider one to report.
 * `segments` — the object carries `SEGMENT1`/`SEGMENT3` and is filtered on them.
 * `lookup`  — it carries only `CODE_COMBINATION_ID`, so it is narrowed through the
 *             combinations that hold those segments.
 * `null`    — **it carries no account at all.** A vendor is not in a fund. Its `rowCount`
 *             is the whole object and nothing about it follows `FUND_CODE`.
 */
export type LedgerScopeMode = 'derived' | 'segments' | 'lookup';

export interface LedgerObject {
  /** The physical name — `GL_CODE_COMBINATIONS`. */
  name: string;
  /** The descriptor's label — `Account combination`. */
  label: string;
  /** Where the count came from. The app store can be a different database. */
  store: LedgerStore;
  /** `null` means the count could not be taken, which is not the same as empty. */
  rowCount: number | null;
  /** How this object's count follows the account scope, or `null` if it cannot. */
  scopeMode: LedgerScopeMode | null;
  /** `true` only where a fund predicate actually ran — the claim is checkable per object. */
  scoped: boolean;
  /**
   * Rows this object contributed *inside* the scope, or `null` where no predicate applied.
   *
   * ★ `null` HERE MEANS *NOT APPLICABLE*, NOT *ZERO*, and the two must render differently:
   *   a table that cannot be narrowed contributes nothing to the scoped total, while a table
   *   that *can* be narrowed and matched no rows contributes a real zero.
   */
  scopedRowCount: number | null;
}

/** What the counts were narrowed to, as the server's own configuration declares it. */
export interface LedgerScope {
  funds: string[];
  /**
   * `null` = the server's configuration names no programs, so the list belongs to an
   * organization row that cannot be read before sign-in. **The count is then by fund
   * alone, a superset of what the app will read once a scope is resolved** — where `[]`
   * would mean *no program filter was wanted*, which is a complete answer.
   */
  programs: string[] | null;
  /** Compared against the fiscal year a period *ends* in. `null` = no floor was applied. */
  startYear: number | null;
}

/**
 * ★ THIS PAYLOAD NOW CARRIES THE ACCOUNT SCOPE, AND THE FIGURES FOLLOW IT.
 *
 *   It did not, and the gap was recorded here rather than left to be discovered: the
 *   response reported a total and the screen printed it, and neither said which funds
 *   it was taken under. Two of the three composed views were counted through the
 *   configured scope and **every base table was counted as `COUNT(*)` on the source
 *   object — a statement no fund appears in**. So narrowing `FUND_CODE` from `02,04`
 *   to `04` moved the total by 920 rows out of 197,019,139: real, and under 0.001 %,
 *   which at the rendered precision changed nothing on screen. The sign-in card's
 *   own footnote then had to *disclaim* the difference — "the account scope narrows
 *   what the registers read rather than what these figures say" — which is an
 *   admission that the figure did not honour the setting, printed where the figure is.
 *
 *   A figure that has to be explained away is the wrong figure, so the counts were
 *   changed to follow the scope (see `server/src/routes/meta.ts`, `countObjects`),
 *   and this type now carries what they were taken under:
 *
 *     - `scope` states the funds, programs and fiscal-year floor actually applied, as
 *       the server's configuration declares them, and is `null` when the server
 *       declares no fund — this endpoint answers before any organization is chosen,
 *       so there is no tenant row to ask.
 *     - each object carries `scopeMode` and `scopedRowCount`, so the claim is
 *       *checkable per row of the list* rather than believed as a whole.
 *     - `scopedRecords` and `unscopedObjects` separate *what the scope can reach* from
 *       *what the objects hold*, because for objects with no account column — a vendor
 *       is not in a fund — there is no narrowed figure to give, and inventing one
 *       would be worse than saying so.
 */
export interface LedgerSummary {
  /** The store the ledger objects were counted in. A host, never a credential. */
  target: string;
  /** Where the app-owned objects live. Equal to `target` when nothing separates them. */
  appTarget: string;
  /**
   * When the server took these counts, ISO 8601 — or `null` when the payload came
   * from a server that counts per request.
   *
   * ★ THE ONE SENTENCE THIS FIELD EXISTS TO KEEP TRUE. The note under the figure used
   *   to say "as this screen loaded", which was a claim about the request. The server
   *   now memoises its count pass per scope (so that reloading this screen cannot
   *   start a second 34-query pass over 197 M rows and starve the connection pool),
   *   and a claim about *this request* stops being a claim about *this figure* the
   *   moment that happens. The age is printed instead, so a reused figure is disclosed
   *   rather than asserted to be fresh.
   */
  countedAt: string | null;
  /** What the counts were narrowed to, or `null` when configuration declares no fund. */
  scope: LedgerScope | null;
  objects: LedgerObject[];
  /**
   * How many objects the descriptor list holds — the figure this card is built on.
   *
   * ★ THIS IS THE ONE NUMBER THAT COSTS NOTHING, AND IT IS WHY THE CARD CAN LOAD FAST.
   *   It is a count of the descriptors the server serves, not a `COUNT(*)` of rows, so
   *   it is exact and free. The card used to lead with a row total instead, which meant
   *   a `COUNT(*)` over `GL_BALANCES` at 157 M rows plus two composed views at ~13 s
   *   each, on every load of a page nobody had signed in to yet — measured at 51 s,
   *   67.5 s, 95.5 s, 204.3 s, 397.3 s and 307.7 s, the last of which lost its
   *   connection before answering at all. The row figures are still available to a
   *   caller that asks for them (`?counts=true`); this screen no longer does.
   */
  objectCount: number;
  /**
   * Rows across the ledger objects — `null` when no counts were taken, which is the
   * case for this screen.
   *
   * ★ `null` AND NOT `0`, FOR THE SAME REASON `rowCount` IS NULLABLE ONE LEVEL DOWN.
   *   "Not measured" and "measured as nothing" are opposite facts about the ledger, and
   *   a zero here would be read as an empty database.
   */
  ledgerRecords: number | null;
  /** Rows across the app-owned objects. Never added to `ledgerRecords`. */
  appRecords: number | null;
  /**
   * Rows across the objects the scope actually narrowed — `null` when not counted.
   *
   * ★ THIS IS NOT A SUBSET OF `ledgerRecords` IN THE SENSE A READER ASSUMES: it excludes
   *   every object that carries no account, so it is *how much of the ledger `FUND_CODE`
   *   can reach*, not *what is left after filtering*. Both figures are served because a
   *   single one would have to pick a question and let the reader assume the other.
   */
  scopedRecords: number | null;
  /** How many objects carry no account, so their rows never follow the scope. */
  unscopedObjects: number | null;
  /** How many objects answered no count, so a short total is visibly short. */
  uncounted: number | null;
}

/**
 * The four states, as a union rather than as `data | null` plus two booleans.
 *
 * ★ A `loading` FLAG BESIDE A NULLABLE SUMMARY IS THE SHAPE THAT LETS A FAILED READ
 *   RENDER AS AN EMPTY ONE. Here there is no combination of the union that reads as
 *   "finished, with nothing" — the renderer has to handle each case, and the
 *   failure case has no summary to print by accident.
 *
 * ★ AND `slow` IS NOT A FAILURE, WHICH IS WHY IT IS NOT SPELLED AS ONE. It was added
 *   when this screen asked for 34 `COUNT(*)` statements over a ledger of 197 M rows and
 *   the wait was measured at 51 s / 67.5 s / 95.5 s / 204.3 s / 397.3 s / 307.7 s.
 *   Collapsing that into `failed` would have told the reader the read died when it was
 *   still running, and a timed-out read is a different fact from a refused one.
 *
 *   ★ THE STATE IS KEPT EVEN THOUGH THE WAIT IT DESCRIBED IS GONE. The screen no longer
 *   asks for counts (`?counts=false`), so this is now reached only by a genuinely
 *   degraded server — which is precisely when a reader most needs to be told that the
 *   request is still in flight rather than that it failed. Removing it would put the
 *   original bug back for the next slow path.
 */
export type LedgerSummaryState =
  | { status: 'loading' }
  /** Still in flight, past `SLOW_AFTER_MS`. Carries how long it has been running. */
  | { status: 'slow'; waitedMs: number }
  | { status: 'ready'; summary: LedgerSummary }
  | { status: 'failed'; message: string };

/*
 * ★ `counts=false` IS THE WHOLE FIX, AND IT IS ONE QUERY PARAMETER.
 *
 *   The default on the server is now *no counts*, and this screen is the reason: it is
 *   answered before anyone has signed in, and it was paying for a `COUNT(*)` over
 *   `GL_BALANCES` at 157 M rows plus two composed views at ~13 s each, on every load.
 *   Parallelising the count loop did not make it acceptable (397.3 s sequential, 307.7 s
 *   with four workers, and the second run lost its connection before answering), so the
 *   figure was removed from this screen rather than made faster.
 *
 *   ★ WRITTEN EXPLICITLY RATHER THAN RELYING ON THE SERVER'S DEFAULT. A screen that
 *   needs a figure to be absent should say so in its request; otherwise a future change
 *   to the default silently reintroduces a six-minute sign-in page, and the screen that
 *   caused the change looks like it is still asking for the figures.
 */
const API = '/api/meta/ledger-summary?counts=false';

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A whole number, or `null` for anything else — including a missing field. */
function asInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/**
 * Narrow one object, or `null` if it is not the shape the endpoint documents.
 *
 * ★ THE PAYLOAD IS NARROWED RATHER THAN CAST. A cast here would be a promise about
 *   a shape nothing enforces, and this is a response that crosses the network — the
 *   same reasoning `SignIn.tsx` applies to `location.state`.
 *
 * ★ `rowCount` IS CHECKED AGAINST `null` FIRST, because *not countable* is a
 *   documented outcome and not a missing field. A `rowCount` that is absent,
 *   a string, or a fraction fails the object, so a malformed count surfaces as a
 *   failed read rather than as an empty table.
 */
/**
 * A whole number, or `null` when the field is absent OR explicitly null.
 *
 * Two optional fields here (`scope`, `scopedRowCount`) are legitimately `null` rather than
 * missing, so "absent" and "null" collapse to the same answer on purpose — and the union
 * with the explicit `null` case is what tells a *malformed* value (a string, a fraction)
 * apart from a legitimate absence.
 */
function asNullableInteger(value: unknown): { ok: true; value: number | null } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, value: null };
  const parsed = asInteger(value);
  return parsed === null ? { ok: false } : { ok: true, value: parsed };
}

/** `['04']`, `[]` or `null` — or `undefined` when the field is not a string array at all. */
function asStringArray(value: unknown): string[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value)) return undefined;
  return value.every((v) => typeof v === 'string') ? (value as string[]) : undefined;
}

function asScope(value: unknown): LedgerScope | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const funds = asStringArray(raw.funds);
  const programs = asStringArray(raw.programs);
  if (funds === undefined || funds === null) return undefined;
  if (programs === undefined) return undefined;
  if (raw.startYear === undefined) return undefined;
  const startYear = asNullableInteger(raw.startYear);
  if (!startYear.ok) return undefined;
  return { funds, programs, startYear: startYear.value };
}

function asObject(value: unknown): LedgerObject | null {
  if (!value || typeof value !== 'object') return null;
  const { name, label, store, rowCount, scopeMode, scoped, scopedRowCount } = value as Record<
    string,
    unknown
  >;
  if (typeof name !== 'string' || name === '') return null;
  if (typeof label !== 'string') return null;
  if (store !== 'ledger' && store !== 'app') return null;

  // ★ THE SCOPE FIELDS ARE REQUIRED, NOT OPTIONAL, AND THAT IS THE POINT OF THIS
  //   CHANGE. A payload that omitted them would let the screen print a total with no
  //   statement of which funds it was taken under — which is exactly the gap that made
  //   the old figure impossible to check. Absent means *this endpoint is older than the
  //   screen*, and a failed read is the honest rendering of that.
  if (scopeMode !== null && scopeMode !== 'derived' && scopeMode !== 'segments' && scopeMode !== 'lookup') {
    return null;
  }
  if (typeof scoped !== 'boolean') return null;
  const narrow = asNullableInteger(scopedRowCount);
  if (!narrow.ok) return null;

  // ★ THE TWO ACCEPTED FORMS OF `rowCount` ARE CHECKED ONE AT A TIME RATHER THAN IN
  //   ONE CONDITION, so that the narrowed type reaches the return. A single
  //   `if (rowCount !== null && asInteger(rowCount) === null) return null` proves the
  //   same thing to a reader and nothing at all to the compiler, which then hands
  //   `unknown` to a `number | null` field.
  let count: number | null;
  if (rowCount === null) {
    count = null;
  } else {
    const parsed = asInteger(rowCount);
    if (parsed === null) return null;
    count = parsed;
  }

  return { name, label, store, rowCount: count, scopeMode, scoped, scopedRowCount: narrow.value };
}

/** The response body, or `null` when any field is missing or the wrong type. */
function parse(body: unknown): LedgerSummary | null {
  if (!body || typeof body !== 'object') return null;
  const { data } = body as { data?: unknown };
  if (!data || typeof data !== 'object') return null;
  const raw = data as Record<string, unknown>;

  if (!Array.isArray(raw.objects)) return null;
  const objects: LedgerObject[] = [];
  for (const item of raw.objects) {
    const object = asObject(item);
    if (object === null) return null;
    objects.push(object);
  }

  const target = asText(raw.target);
  const appTarget = asText(raw.appTarget);
  /*
   * ★ NOT REQUIRED, AND THAT IS DELIBERATE. A body without it comes from a server that
   *   takes its own pass per request, where "as this screen loaded" is exactly true.
   *   Rejecting the whole payload over an absent advisory field would turn a working
   *   endpoint into `failed` — the same mistake, in the same shape, as reading a count
   *   that could not be taken as a count of zero.
   */
  const countedAt = asText(raw.countedAt);
  /*
   * ★ THE TOTALS ARE NULLABLE NOW, BECAUSE THE CARD ASKS FOR NO COUNTS.
   *   `asInteger` returns `null` for both "absent" and "not a number", and that is
   *   exactly the right collapse here: this screen never asks for the figures, so a
   *   body that carries them is the exception rather than the rule. What must NOT
   *   happen is the old behaviour — treating a missing total as a rejection, which
   *   would make the names-only payload fail to parse and put the card back on
   *   "The ledger could not be counted" for a request that succeeded.
   */
  const ledgerRecords = asInteger(raw.ledgerRecords);
  const appRecords = asInteger(raw.appRecords);
  const uncounted = asInteger(raw.uncounted);
  const scopedRecords = asInteger(raw.scopedRecords);
  const unscopedObjects = asInteger(raw.unscopedObjects);
  const scope = asScope(raw.scope);
  /*
   * ★ `objectCount` IS REQUIRED, UNLIKE THE TOTALS ABOVE, AND THE ASYMMETRY IS THE
   *   POINT. It is the figure this card is built on, and it is free — a count of the
   *   descriptor list rather than a `COUNT(*)`. A payload without it is not a payload
   *   this screen can render, so rejecting it is honest; whereas rejecting a payload
   *   for lacking a figure the screen deliberately did not ask for would be a bug.
   */
  const objectCount = asInteger(raw.objectCount);
  if (target === null || appTarget === null) return null;
  if (objectCount === null) return null;
  if (scope === undefined) return null;

  return {
    target,
    appTarget,
    countedAt,
    scope,
    objects,
    objectCount,
    ledgerRecords,
    appRecords,
    scopedRecords,
    unscopedObjects,
    uncounted,
  };
}

/**
 * How long the read may run before the screen stops pretending it is quick.
 *
 * ★ THIS WAS SET BELOW THE MEASURED FLOOR OF THE COUNT PASS (51 s) SO THAT A REAL PASS
 *   WOULD ALWAYS REACH IT. The screen no longer asks for counts, so the read it guards
 *   is now a descriptor list — a few milliseconds in practice. It is kept at 20 s
 *   because the state it produces is the honest rendering of a *degraded* server, and
 *   a threshold tight enough to fire on a healthy request would put "still counting"
 *   on a screen that had already finished.
 */
const SLOW_AFTER_MS = 20_000;

/**
 * Read the ledger summary once, on mount, and say how long it is taking.
 *
 * ★ THERE IS STILL NO CLIENT CACHE, AND THE REASON SURVIVED THE CHANGE. The figures are
 *   no longer requested from this screen at all, so there is nothing here to go stale;
 *   for a caller that does ask (`?counts=true`) the server memoises its pass and the
 *   payload states the age of what it served, so freshness is disclosed rather than
 *   assumed. Keeping a summary in browser memory as well would add a second,
 *   differently-aged copy of the same figure with no date of its own.
 *
 * ★ THE REQUEST IS NOT ABANDONED ON A DEADLINE, AND THAT IS THE FIX FOR THE REPORTED
 *   HANG. This hook previously rendered one pending sentence for a wait of any length,
 *   so four seconds and four minutes looked identical and "stuck" was the only
 *   available reading of the screen. Aborting would have been worse than the silence:
 *   the count behind it runs for minutes and the client throwing its answer away does
 *   not shorten it. So the wait is reported in seconds while the fetch continues, and
 *   the figure swaps in if and when it lands.
 */
export function useLedgerSummary(): LedgerSummaryState {
  const [state, setState] = useState<LedgerSummaryState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    const started = Date.now();
    let live = true;

    /*
     * The elapsed figure is what distinguishes a count in progress from a wedged
     * screen, so it ticks rather than being computed once: a number that grows is
     * evidence, and a number frozen at 20 s is not.
     */
    const ticks = window.setInterval(() => {
      if (!live) return;
      const waitedMs = Date.now() - started;
      if (waitedMs >= SLOW_AFTER_MS) setState({ status: 'slow', waitedMs });
    }, 1000);

    fetch(API, { signal: controller.signal, headers: { accept: 'application/json' } })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
        return (await res.json()) as unknown;
      })
      .then((body) => {
        const summary = parse(body);
        // ★ A BODY THAT DOES NOT MATCH IS A FAILURE, NOT AN EMPTY LEDGER. Falling
        //   through to `objects: []` would print "0 tables · 0 records" over a
        //   store that was never read, which is the most confident lie available.
        if (summary === null) throw new Error('the response was not a ledger summary');
        if (live) setState({ status: 'ready', summary });
      })
      .catch((err: unknown) => {
        if (!live) return;
        // ★ AN UNMOUNT IS NOT A FAILURE. The abort above fires on cleanup, and someone
        //   who navigated away must not be told the ledger could not be counted.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setState({ status: 'failed', message: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => {
        window.clearInterval(ticks);
      });

    return () => {
      live = false;
      window.clearInterval(ticks);
      controller.abort();
    };
  }, []);

  return state;
}
