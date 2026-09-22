/**
 * The Saved Views page's data: the views this person watches, and the views they
 * could watch.
 *
 * ── ★ WHAT THIS MODULE EXISTS TO KEEP STRAIGHT, IN ONE PLACE
 *
 * Every count on the page comes out of `saved_view_run`, and a row count there is
 * **capped** — `wrapForRowCap` appends `LIMIT n+1` and `capResult` slices to the
 * cap — so a figure that reached the cap is a floor rather than a total. A run that
 * never happened stores nulls, and `Number(null)` is `0`, so the single most likely
 * way for this screen to lie is a never-run view rendered as "0 rows". Every
 * function below is written to keep those apart, and the two are kept apart by
 * *typing* (`number | null`) rather than by remembering to check.
 *
 * ── ★ WHY THERE IS NO MODULE-LEVEL STORE HERE, WHEN `pins.ts` HAS ONE
 *
 * `pins.ts` caches its list in module scope because the same module owns every
 * write to it — `savePin` and `deletePin` are two lines away and can update what
 * they just changed. This module does not own the writes. A view's title, status
 * and declared parameters are edited in `/admin/views` (`ViewBuilder.tsx`) and its
 * runs are recorded by the server, and neither is visible from here. A cache of a
 * value somebody else writes is a cache that goes stale silently, and the one thing
 * a subscribe dropdown has to be right about is which views it may offer. So both
 * hooks read on mount, and a write is followed by an explicit `refresh()` — which
 * has the further virtue of *proving* the write landed rather than assuming it.
 *
 * ── ★ THE THREE ENVELOPES, BECAUSE THEY ARE NOT THE SAME SHAPE
 *
 *   GET  /api/views/subscriptions  → a **bare array**: `{ data: ViewWatch[] }`, no
 *                                    `page`. It answers "my watches", and a list
 *                                    that belongs to one person is short by
 *                                    construction.
 *   GET  /api/views                → **paginated**: `{ data: View[], page: { …,
 *                                    total } }`. The count is under `page`, not
 *                                    `meta`.
 *   POST /api/views/{id}/subscriptions and its DELETE → `{ data: subscription }`
 *                                    and 204-with-no-body respectively.
 *
 * ── ★ THE THREE WAYS THIS ONE MODULE FAILS, ALL OF WHICH THE PAGE REPEATS
 *
 * A `VIEW_BUILDER_ENABLED=0` server refuses the *write* while still serving every
 * read, so the page has to be able to render a full table and a named refusal
 * side by side. That refusal arrives as a 409 `WRITES_DISABLED` whose **message
 * names the variable**, so the message is carried up unedited and the code is
 * carried up alongside it — see {@link ApiError}.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ViewResult } from '../components/ViewResultGrid';
import { isoDay } from './format';
import { ApiError } from './organizations';
import { sessionHeaders } from './session';

/**
 * `ApiError` is imported from `./organizations` rather than declared here.
 *
 * The class carries `code` and `details` next to the message, and none of the other
 * three error shapes in this app do — `pins.ts` throws a bare `Error`, and
 * `ViewBuilder.tsx` has its own `ApiFailure`. A fourth would be a fourth thing for a
 * reader to learn for no gain, and the only thing this page needs beyond a string is
 * the code, because "the server has the View Builder switched off" is a state the
 * page renders as an explanation rather than as a failure.
 */

const API = '/api/views';

/* ------------------------------------------------------------------------- *
 * Shapes, as the API returns them
 * ------------------------------------------------------------------------- */

export type ViewStatus = 'draft' | 'active' | 'disabled';

/** One declared parameter. `default` is what decides whether a view can run unattended. */
export interface ViewParam {
  name: string;
  label?: string;
  type?: 'text' | 'number' | 'date';
  /**
   * Absent means the view cannot run without being asked for a value — that is the
   * one distinction {@link watchRefusal} tests, so it is `undefined` rather than
   * `null` that matters. A `null` default is a *default* (the server's
   * `compileParams` only refuses when the value is `undefined`), which is why the
   * two are not collapsed here.
   */
  default?: string | number | null;
  from?: string;
}

/**
 * The parts of a saved view this page reads. Deliberately not the whole `View`
 * row: `sql` is not fetched, because reading a view is not running one and this
 * screen never needs the statement.
 */
export interface SavedViewRow {
  id: number;
  slug: string;
  title: string;
  description: string | null;
  params: ViewParam[];
  display: { fingerprint?: { key: string } | null } | null;
  status: ViewStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The subset of a view that decides whether it can be watched at all.
 *
 * ★ THIS EXISTS SO THE RULE HAS ONE HOME. The View Builder answers the question
 *   "will this appear in Views?" while the person is authoring, and this page
 *   answers it again when it builds the dropdown — and those two answers must be
 *   the same answer. Written twice, they drift, and the way they drift is that the
 *   builder says a view is ready and the dropdown does not list it. The builder's
 *   own `SavedView` and this file's {@link SavedViewRow} both satisfy this shape
 *   structurally, so neither has to import the other's types.
 */
export interface WatchableShape {
  id: number;
  status: string;
  params: readonly { name: string; default?: string | number | null }[];
  display: { fingerprint?: { key: string } | null } | null;
}

/**
 * One watch, as `GET /api/views/subscriptions` returns it — a subscription joined
 * to its view and to the two runs that make the page's comparison possible.
 *
 * ★ EVERY `*_count` IS `number | null` AND THE NULL IS THE POINT. `null` means
 *   there is no such run: `current_count` null is "never run", `subscribed_count`
 *   null is "had never produced a result when you subscribed". Neither is zero, and
 *   the type is what stops `format.ts`'s `num()` from printing one as zero — every
 *   helper there ends in `Number(n) || 0`, so a null handed to one becomes `0`, a
 *   number the reader believes.
 */
export interface SubscribedView {
  subscription_id: number;
  subscriber: string;
  channel: 'in_app' | 'webhook';
  /** Also the instant `subscribed_*` is measured from. */
  subscribed_at: string;
  view_id: number;
  slug: string;
  title: string;
  description: string | null;
  status: ViewStatus;
  /** `display.fingerprint.key`, or null when the view declares none. */
  fingerprint_key: string | null;
  /**
   * The newest run **that produced a result** — the last time this view worked.
   *
   * ★ NOT "THE LAST TIME ANYTHING HAPPENED". A failed attempt is newer, has no
   *   count, and does not replace this one; it is reported by `last_error` instead.
   *   See the note on the server's `toWatch`.
   */
  current_ran_at: string | null;
  current_count: number | null;
  /** `true` means `current_count` is a floor. `null` means the run predates this being recorded. */
  current_truncated: boolean | null;
  /**
   * Null when the last run failed — **and also null when it succeeded but the
   * query no longer returns `fingerprint_key`**. That second null is the only
   * evidence of drift, so {@link watchStatus} reads it rather than the count.
   */
  current_fingerprint: string | null;
  /** When the newest attempt ran, succeeded or not. */
  last_ran_at: string | null;
  /** Non-null means the last attempt failed, and that `current_*` is older than `last_ran_at`. */
  last_error: string | null;
  /** The newest result at or before `subscribed_at`. Null means there was no baseline. */
  subscribed_ran_at: string | null;
  subscribed_count: number | null;
  /**
   * Whether that baseline run was cut short by the row cap.
   *
   * ★ THIS IS THE OTHER HALF OF THE COMPARISON AND IT IS NOT DECORATION. The two
   *   counts are read side by side, so a baseline that hit the cap has to be marked
   *   as a floor exactly as {@link current_truncated} marks the current one: two runs
   *   that both stopped at the cap hold the same number, and labelling only one of
   *   them prints `200` beside `200+`, which reads as *nothing has changed*.
   */
  subscribed_truncated: boolean | null;
  /** The most recent run whose fingerprint differed from the one before it. */
  last_change_at: string | null;
}

/** The row `POST …/subscriptions` answers with. */
export interface Subscription {
  id: number;
  view_id: number;
  subscriber: string;
  channel: 'in_app' | 'webhook';
  target: string | null;
  created_at: string;
}

/* ------------------------------------------------------------------------- *
 * Reads
 * ------------------------------------------------------------------------- */

/**
 * Read a successful response's body, naming the one failure whose default message
 * misdescribes it.
 *
 * ★ A 200 THAT IS NOT JSON IS ALMOST ALWAYS THE DEV SERVER RATHER THAN THE API.
 *   Vite serves the app on 5180 and proxies `/api` to the API on 5181
 *   (`app/vite.config.ts`). With the API not running, the proxy fails and Vite
 *   answers with `index.html` **and a 200**, so `res.json()` throws
 *   `Unexpected token '<'` — a message about a parser, for a problem that is a
 *   missing process. `pins.ts` lets that string reach the screen; here it would
 *   land in a page whose whole job is to say what went wrong, so it is translated.
 */
async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    throw new ApiError(
      `The server answered ${res.status} with something that is not JSON. In development this is ` +
        'usually the Vite dev server answering `/api` itself because the API is not running: start ' +
        'it with `npm run dev` in `server/`, then reload.',
      'NOT_JSON',
    );
  }
}

/**
 * The `data` field of an envelope, or a refusal naming what was missing.
 *
 * A response that arrived with a 200 and no `data` is a shape disagreement between
 * this client and the server, which is worth saying out loud rather than showing as
 * an empty table — an empty table is what "you watch nothing" looks like.
 */
function unwrap<T>(body: unknown, what: string): T {
  const data = (body as { data?: T } | null)?.data;
  if (data === undefined) {
    throw new ApiError(
      `The server answered without a \`data\` field, so there is no ${what} to show.`,
      'MALFORMED_RESPONSE',
    );
  }
  return data;
}

/** The server's refusal, with its code — or the status line when the body is not the envelope. */
async function readError(res: Response): Promise<ApiError> {
  let message = `HTTP ${res.status} ${res.statusText}`;
  let code = `HTTP_${res.status}`;
  let details: unknown;
  try {
    const body = (await res.json()) as {
      error?: { code?: string; message?: string; details?: unknown };
    };
    if (body?.error?.message) message = body.error.message;
    if (body?.error?.code) code = body.error.code;
    details = body?.error?.details;
  } catch {
    /* The status line stands. A body that is not JSON has already been explained once. */
  }
  return new ApiError(message, code, details);
}

function asError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  return new ApiError(err instanceof Error ? err.message : String(err), 'UNKNOWN');
}

/**
 * One person's watches.
 *
 * ★ `who` IS A REQUIRED ARGUMENT AND IS NOT READ FROM THE SESSION HERE. The route
 *   takes `subscriber` as a query parameter because no route under `/api/views`
 *   authenticates — the server cannot know who is asking. Taking the name as an
 *   argument and handing it back to the caller means the name in the request and the
 *   name on the screen are the same string, which is the only way the page can show
 *   it honestly.
 *
 * ★ A NULL `who` FETCHES NOTHING AND REPORTS READY. `/views` sits inside the
 *   session gate (`App.tsx`), so a signed-out visitor is redirected before this
 *   renders; a null owner means an *authenticated session whose user has no name*,
 *   and there is no request to make for them. `ready: true` with no error and no
 *   rows is the honest answer — the page renders its own explanation for the state,
 *   because only it knows how to say so.
 */
export function useSubscribedViews(who: string | null): {
  views: SubscribedView[];
  ready: boolean;
  error: ApiError | null;
  refresh: () => void;
} {
  const [views, setViews] = useState<SubscribedView[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (who === null) {
      setViews([]);
      setError(null);
      setReady(true);
      return;
    }

    // A response that arrives after the subscriber changed, or after the component
    // left, belongs to a question nobody is asking any more — and rendering it
    // would put another person's watches under this person's name.
    let cancelled = false;
    setReady(false);
    setError(null);

    void (async () => {
      try {
        const res = await fetch(`${API}/subscriptions?subscriber=${encodeURIComponent(who)}`, {
          headers: sessionHeaders(),
        });
        if (!res.ok) throw await readError(res);
        const rows = unwrap<SubscribedView[]>(await readJson(res), 'watch list');
        if (cancelled) return;
        setViews(Array.isArray(rows) ? rows : []);
        setReady(true);
      } catch (err) {
        if (cancelled) return;
        setError(asError(err));
        setReady(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [who, round]);

  const refresh = useCallback(() => setRound((n) => n + 1), []);
  return { views, ready, error, refresh };
}

/** How many views one request may ask for. The list route caps `limit` at 500. */
const VIEW_PAGE = 500;

/**
 * The views that exist, and how many of them the server has that this read did not
 * return.
 *
 * ★ `total` IS RETURNED BECAUSE THE DROPDOWN'S HONESTY DEPENDS ON IT. A view that
 *   was not read cannot be classified as offerable or withheld, and a page that
 *   silently offered a truncated list would be saying "these are your options" about
 *   an arbitrary prefix of them. The caller states the remainder instead of losing it.
 */
export function useAllViews(): {
  views: SavedViewRow[];
  total: number;
  ready: boolean;
  error: ApiError | null;
  refresh: () => void;
} {
  const [views, setViews] = useState<SavedViewRow[]>([]);
  const [total, setTotal] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setError(null);

    void (async () => {
      try {
        const res = await fetch(`${API}?limit=${VIEW_PAGE}`, { headers: sessionHeaders() });
        if (!res.ok) throw await readError(res);
        const body = await readJson(res);
        const rows = unwrap<SavedViewRow[]>(body, 'list of views');
        if (cancelled) return;
        setViews(Array.isArray(rows) ? rows : []);
        // The count is under `page`. Reading `meta` here yields undefined, which
        // would read as "nothing was left unread" and quietly hide the remainder.
        const page = (body as { page?: { total?: number } }).page;
        setTotal(typeof page?.total === 'number' ? page.total : rows.length);
        setReady(true);
      } catch (err) {
        if (cancelled) return;
        setError(asError(err));
        setReady(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [round]);

  const refresh = useCallback(() => setRound((n) => n + 1), []);
  return { views, total, ready, error, refresh };
}

/* ------------------------------------------------------------------------- *
 * Which views can be offered
 * ------------------------------------------------------------------------- */

/**
 * Why a view is not offered in the subscribe dropdown.
 *
 * The first three are properties of the view; `already-watched` is the one the
 * plan did not list and the one this screen adds.
 */
export type WatchRefusal = 'no-key' | 'not-active' | 'already-watched' | 'needs-value';

/**
 * The reasons a view cannot be watched at all, independent of who is looking.
 *
 * ★ SEPARATE FROM {@link WatchRefusal} BECAUSE THE VIEW BUILDER NEEDS THIS ONE.
 *   `already-watched` is not a fault in the view — it is the answer to "is this
 *   already done?" — so a screen asking "is this view fit to publish?" must not be
 *   told a view is unfit merely because somebody already watches it.
 */
export type ViewBlocker = 'no-key' | 'not-active' | 'needs-value';

/** Used when the caller has no watch list to hand, so the membership test is free. */
const NOTHING_WATCHED: ReadonlySet<number> = new Set();

/**
 * Whether a view can be watched from this panel, and if not, what stops it.
 *
 * ★ THE RULE IS ABOUT WHAT THIS PANEL CAN DO, NOT ABOUT WHAT THE VIEW IS. The
 *   subscription endpoint runs the view to fingerprint it, and the panel supplies
 *   nothing: it runs a view with the defaults the view declares. So a view that
 *   declares a parameter with no default is one this panel cannot run — the server
 *   answers `MISSING_PARAM_VALUE` and names the parameter — even though the View
 *   Builder can run it perfectly well by asking. That is a limitation of the panel
 *   and the copy says so, rather than describing the view as broken.
 *
 * ★ ORDER MATTERS AND IS DELIBERATE. A view can be in several of these states at
 *   once and is attributed to the first that stops it, so the counts add up to the
 *   number of views not offered rather than overlapping. `no-key` comes first
 *   because it is not a matter of state or of the panel at all: without a key
 *   column there is nothing to compare between runs, and the endpoint refuses the
 *   subscription itself (`NO_FINGERPRINT_KEY`) no matter who asks or how active the
 *   view is.
 *
 * ★ `already-watched` IS THE FOURTH REASON AND THE ONLY ONE THE PLAN DID NOT LIST.
 *   The endpoint answers a repeat subscription with the row that already exists —
 *   deliberately, because two requests to watch the same thing are one request — so
 *   a view already in the table would be offered, accepted, and change nothing
 *   visible. That reads as a button that did not work. A view that is already
 *   watched is therefore not offered either, and the sentence above the dropdown
 *   says how many were held back and why.
 */
export function watchRefusal(
  view: SavedViewRow,
  watching: ReadonlySet<number> = NOTHING_WATCHED,
): WatchRefusal | null {
  const blockers = viewBlockers(view);
  // The two hard refusals are attributed before the soft one, so a view that is
  // already watched *and* unlisted for a real reason is counted under the real
  // reason. That is the order the withheld counts are explained in.
  const hard = blockers.find((b) => b === 'no-key' || b === 'not-active');
  if (hard !== undefined) return hard;
  if (watching.has(view.id)) return 'already-watched';
  return blockers[0] ?? null;
}

/**
 * Why this view cannot be watched **by anybody** — every reason that is a property
 * of the view rather than of who is asking, in the order they should be read.
 *
 * ★ THE VIEW BUILDER USES THIS TO ANSWER "WILL IT APPEAR IN VIEWS?", WHICH IS NOT
 *   THE SAME QUESTION AS "IS IT PUBLISHED?" AND IS THE ONE THAT MATTERS. Publishing
 *   sets `status` to `active`, and `active` is necessary but not sufficient: a
 *   published view that declares no fingerprint key is held back from the dropdown
 *   just as firmly as an unpublished one, because change detection compares one
 *   column across runs and without a key there is nothing to compare. So the
 *   builder reports this rather than reporting the status alone — a control that
 *   said "published, you're done" over a view the dropdown still refuses would be
 *   the exact kind of confident wrong answer this feature keeps producing.
 *
 * ★ PLURAL, AND THAT IS THE POINT OF IT BEING PLURAL. A view can be in two of
 *   these states at once — published, with no key *and* with an unfilled parameter
 *   — and the first draft of this function returned only the first one, which made
 *   the builder's readiness line name one problem, wait for the author to fix it,
 *   and only then name the second. Both were knowable from the start. Anything that
 *   asks *"what stops this view?"* must therefore get the whole list; only
 *   {@link watchRefusal} needs it collapsed, because the dropdown counts one reason
 *   per row and overlapping counts would not add up to the number withheld.
 */
export function viewBlockers(view: WatchableShape): ViewBlocker[] {
  const blockers: ViewBlocker[] = [];
  // Not a matter of state or of the panel at all: the endpoint refuses the
  // subscription itself (`NO_FINGERPRINT_KEY`, 400) no matter who asks.
  if (!view.display?.fingerprint?.key) blockers.push('no-key');
  if (view.status !== 'active') blockers.push('not-active');
  if (view.params.some((param) => param.default === undefined)) blockers.push('needs-value');
  return blockers;
}

const REFUSAL_WORDS: Record<WatchRefusal, (n: number) => string> = {
  'no-key': (n) =>
    `${n} declare${n === 1 ? 's' : ''} no fingerprint key, so there is nothing to compare between runs`,
  'not-active': (n) =>
    `${n} ${n === 1 ? 'is' : 'are'} not active, and a view an author has not settled on is not one to watch`,
  'already-watched': (n) => `${n} ${n === 1 ? 'is' : 'are'} already being watched`,
  'needs-value': (n) =>
    `${n} declare${n === 1 ? 's' : ''} a parameter with no default, and this panel has nowhere to type one`,
};

/** The sentence to show above the dropdown, or null when nothing was held back. */
export function withheldSentence(
  withheld: Partial<Record<WatchRefusal, number>>,
  notRead: number,
): string | null {
  const parts: string[] = [];
  for (const reason of ['no-key', 'not-active', 'already-watched', 'needs-value'] as const) {
    const n = withheld[reason];
    if (n) parts.push(REFUSAL_WORDS[reason](n));
  }
  if (notRead > 0) parts.push(`${notRead} more exist than this request read`);
  if (parts.length === 0) return null;
  return `Not offered here: ${parts.join('; ')}.`;
}

/* ------------------------------------------------------------------------- *
 * Writes
 * ------------------------------------------------------------------------- */

/**
 * Start watching a view.
 *
 * ★ RE-SUBSCRIBING IS NOT AN ERROR. The endpoint returns the existing row rather
 *   than answering 409, so this resolves to the same subscription it returned the
 *   first time and the table still shows one row for one view. That is why the
 *   caller follows this with `refresh()` instead of pushing the returned row onto a
 *   list: pushing would show two.
 */
export async function subscribe(viewId: number, subscriber: string): Promise<Subscription> {
  const res = await fetch(`${API}/${viewId}/subscriptions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...sessionHeaders() },
    body: JSON.stringify({ subscriber, channel: 'in_app' }),
  });
  if (!res.ok) throw await readError(res);
  return unwrap<Subscription>(await readJson(res), 'subscription');
}

/** Stop watching. The row is deleted, not flagged, so the counts go down by one. */
export async function unsubscribe(viewId: number, subscriptionId: number): Promise<void> {
  const res = await fetch(`${API}/${viewId}/subscriptions/${subscriptionId}`, {
    method: 'DELETE',
    headers: sessionHeaders(),
  });
  if (!res.ok) throw await readError(res);
}

/* ------------------------------------------------------------------------- *
 * The panel — one view, previewed
 * ------------------------------------------------------------------------- */

/**
 * One view in full, including its statement — what `GET /api/views/{id}` returns.
 *
 * ★ THIS IS THE ONE READ ON THIS PAGE THAT FETCHES THE SQL, AND THE REASON IS A
 *   CORRECTNESS ONE RATHER THAN CURIOSITY. The panel {@link previewSavedView}s a
 *   view instead of running it, because `POST /api/views/{id}/run` records a
 *   history row **unconditionally** and the fingerprint in that row is the value
 *   the table's date is derived from. So if opening the panel recorded a run, the
 *   act of looking would advance the baseline and swallow the very change the
 *   reader opened the panel to see — and the `Current` column would chase its own
 *   reader. `POST /api/views/preview` takes the SQL **in the body** rather than by
 *   id, which is why the panel makes two requests: this one for the statement, and
 *   the second carrying SQL that came from the server, run under the same guards.
 *
 * It extends {@link SavedViewRow} rather than restating it: `SavedViewRow`'s own
 * note says `sql` is not fetched *because reading a view is not running one*, and
 * this type is the exception that proves it — the panel does run one, so it needs
 * the statement.
 */
export interface ViewDetail extends SavedViewRow {
  sql: string;
}

/**
 * One execution's answer, as both `…/preview` and `…/{id}/run` return it.
 *
 * The two routes share one response schema on the server, which is why this is one
 * type: the panel gets the `preview` flavour (`runId` null, nothing recorded) and
 * the View Builder gets both.
 */
export interface ViewRun {
  result: ViewResult;
  durationMs: number;
  /** Null for a preview — nothing was recorded, so there is no history row to name. */
  runId: number | null;
  viewId: number | null;
  fingerprint: string | null;
  appliedValues: Record<string, string | number | null>;
}

/** Load one view by id, statement and all. */
export async function fetchView(id: number): Promise<ViewDetail> {
  const res = await fetch(`${API}/${id}`, { headers: sessionHeaders() });
  if (!res.ok) throw await readError(res);
  return unwrap<ViewDetail>(await readJson(res), 'view');
}

/**
 * Run a view's statement as a preview: the result, and no history row.
 *
 * ★ THE SQL IN THE REQUEST BODY CAME FROM `GET /api/views/{id}`, NOT FROM THIS
 *   CLIENT. That is not a formality — it is what makes "the panel does not run a
 *   view" and "the panel shows the view's result" both true. A client that
 *   supplied its own SQL would be asking the server to preview whatever the client
 *   felt like, and the result on screen would no longer be evidence about the view
 *   in the table beside it.
 *
 * `values` is deliberately not sent: a view with a parameter that has no default is
 * never listed, so there is nothing to supply, and the server's own
 * `MISSING_PARAM_VALUE` refusal is the honest answer if that ever stops being so.
 */
export async function previewSavedView(view: ViewDetail): Promise<ViewRun> {
  const res = await fetch(`${API}/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...sessionHeaders() },
    body: JSON.stringify({
      sql: view.sql,
      params: view.params,
      display: view.display ?? undefined,
      viewId: view.id,
    }),
  });
  if (!res.ok) throw await readError(res);
  return unwrap<ViewRun>(await readJson(res), 'result');
}

/**
 * Whether a statement has an `ORDER BY`, for the one caveat that depends on it.
 *
 * ★ THIS IS A TEXT TEST AND IT IS DELIBERATELY THE CONSERVATIVE ONE. A watch hashes
 *   the values of its key column **in the statement's own row order**, because the
 *   server applies `display.sort` only after the fingerprint is computed. So a
 *   statement with no `ORDER BY` can return its rows in a different order on two
 *   runs with no data changing, and the subscription reports a change that never
 *   happened — the one failure mode here that can fire when nothing moved.
 *
 * The test is a regex over the statement rather than a parse of it, which means a
 * false *positive* is possible: `ORDER BY` inside a string literal or a comment, or
 * in a subquery whose order the outer projection does not inherit. A false positive
 * makes the caveat quieter than the truth, so it is worth stating what it costs —
 * and a false *negative* is the one that would be dangerous, because it would
 * suppress a warning about an unordered statement. That cannot happen: the words
 * have to be absent for this to answer `false`, and an absent `ORDER BY` is the
 * thing being warned about.
 */
export function hasOrderBy(sql: string): boolean {
  return /\border\s+by\b/i.test(sql);
}

/* ------------------------------------------------------------------------- *
 * Reading a watch
 * ------------------------------------------------------------------------- */

/**
 * The state of one watch, as the page shows it in a single cell.
 *
 * ★ SEVEN STATES AND NOT SIX, AND THE SEVENTH IS THE ONE THAT WOULD HAVE BEEN A
 *   LIE. The plan's vocabulary for this column is: not run yet, unchanged, changed,
 *   failed, capped, cannot watch. A view that had never produced a result when it
 *   was subscribed has **no baseline** — `subscribed_count` is null — and its first
 *   run afterwards is therefore neither a change nor an absence of one, because the
 *   server compares a run only with the run before it and the first-ever run has no
 *   predecessor. Reporting that as "unchanged" would be asserting a comparison that
 *   was never made, so it gets its own state and says so.
 *
 * ★ ORDER IS PRECEDENCE, NOT PROBABILITY. A capped first-ever run is reported as
 *   "no comparison yet" rather than "capped" because the count it capped had no
 *   baseline to be compared against, and the cap is already stated next to the
 *   number itself as `200+`. See `WATCH_STATUS_LABELS`.
 *
 * ★ `failed` IS TESTED FIRST, AGAINST `last_error`, AND THAT ORDER IS THE WHOLE
 *   REASON THE TWO RUNS ARE KEPT APART. The newest attempt can be a failure while
 *   the newest *result* is older and perfectly good — so a page that tested
 *   `current_ran_at` first would either miss the failure or, if it tested the
 *   failure first without the split, blank the count. Testing `last_error` first
 *   puts the failure on the row and leaves the figure the view last produced where
 *   a reader can still see it.
 */
export type WatchStatus =
  | 'not-run'
  | 'failed'
  | 'drifted'
  | 'capped'
  | 'no-baseline'
  | 'changed'
  | 'unchanged';

/**
 * Whether this view changed **since it was subscribed to**.
 *
 * ★ `last_change_at` IS A FACT ABOUT THE VIEW'S WHOLE HISTORY, WHICH IS NOT THE
 *   QUESTION THE COLUMN ASKS. The server computes the newest run whose fingerprint
 *   differed from the one before it, over every run the view has; a change that
 *   happened last year is a change, and this page must not present it as news. So
 *   the comparison is made here, against `subscribed_at`.
 *
 * The comparison is a string compare on `datetime('now')`-formatted TEXT, which is
 * the format's own property: it sorts and compares as time. Parsing both sides with
 * `Date` would mean two locale-dependent parsings of the same string to answer a
 * question the strings can answer directly.
 */
export function changedSinceSubscribed(watch: SubscribedView): boolean {
  return watch.last_change_at !== null && watch.last_change_at > watch.subscribed_at;
}

export function watchStatus(watch: SubscribedView): WatchStatus {
  // The newest attempt failed. Tested before anything else, because the figures
  // below are from an older run when this is set — and saying so is the point.
  if (watch.last_error !== null) return 'failed';
  if (watch.current_ran_at === null) return 'not-run';
  // A declared key that is no longer selected by the statement: the run succeeded,
  // so there is no error to show, and the fingerprint is null all the same.
  if (watch.current_fingerprint === null) return 'drifted';
  // No baseline means the view had no result when the watch began, so "changed" and
  // "unchanged" are both claims the server never made.
  if (watch.subscribed_ran_at === null) return 'no-baseline';
  if (watch.current_truncated === true) return 'capped';
  if (changedSinceSubscribed(watch)) return 'changed';
  return 'unchanged';
}

/**
 * The words for each state, exported so the vocabulary lives beside the rule that
 * chose it.
 *
 * ★ NONE OF THESE SAY "NOTIFY", "NOTIFICATION" OR "ALERT", AND THAT IS A RULE
 *   RATHER THAN A STYLE. A subscription is a row. Nothing in this deployment reads
 *   it: there is no scheduler to run a view and no sender to deliver anything. A
 *   column reading "Watching" with a tooltip promising a notification would be the
 *   one false statement on a page built to avoid exactly that, so the page says what
 *   the row does — records the change the next run finds — and says plainly that
 *   nothing is sent.
 */
export const WATCH_STATUS_LABELS: Record<WatchStatus, string> = {
  'not-run': 'Not run yet',
  failed: 'Last run failed',
  drifted: 'Cannot watch',
  capped: 'Capped',
  'no-baseline': 'No comparison yet',
  changed: 'Changed',
  unchanged: 'Unchanged',
};

/**
 * The line under a status, or null when the cell needs none.
 *
 * The drift case is the one worth spelling out: it is the only state where the page
 * has to explain that the feature has stopped working, and "Cannot watch" on its own
 * reads as a refusal by the app rather than as a fact about the query.
 *
 * The failure case names the **attempt's** date, which is the one state where the
 * date on the row is not the one the counts came from — so leaving it out would put
 * a stale figure under a fresh failure with nothing saying which was which.
 */
export function watchStatusDetail(watch: SubscribedView): string | null {
  switch (watchStatus(watch)) {
    case 'drifted':
      return watch.fingerprint_key === null
        ? 'This view no longer declares a fingerprint key, so runs can no longer be compared.'
        : `The last run did not return \`${watch.fingerprint_key}\`, so runs can no longer be compared.`;
    case 'no-baseline':
      return 'It had produced no result when you subscribed, so there is nothing to compare the runs since against.';
    case 'capped':
      return 'The last run hit the row cap, so its count is a floor.';
    case 'failed':
      return watch.last_ran_at === null
        ? watch.last_error
        : `${isoDay(watch.last_ran_at)}: ${watch.last_error}`;
    default:
      return null;
  }
}
