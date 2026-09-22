/**
 * The Activity register — the client half of `GET /api/activity`.
 *
 * ★ WHAT THE PAGE IS NOW: AN INVENTORY, NOT A REGISTER OF CHANGES. It answers one
 *   question per table — how many rows are in it — and the answer was taken by
 *   pressing a button, not read out of a timestamp column. The earlier version of
 *   this file described tables that *changed* on a day, which required a per-table
 *   date column, which only some of the objects have. An inventory needs no date
 *   column at all, so the same list now covers every object in the sample.
 *
 * ★ WHY THIS FILE EXISTS AT ALL, GIVEN THE SERVER ALREADY ANSWERS THE QUESTION.
 *   Because the server's answer contains distinctions the screen must not lose,
 *   and the only place to lose them is a parse. Three of them:
 *
 *     `rowCount: null`  → no reading has been taken. This is NOT `0`, which is a
 *                         measurement saying the table is empty. A `?? 0` anywhere
 *                         on the way in would fabricate a reading.
 *     `scoped`          → whether the count was narrowed to the register's scope,
 *                         because the object carries no account to narrow by.
 *     `store`           → which database the number came from. Nothing in the
 *                         number itself says, and in the shipped configuration the
 *                         two stores really are two different databases.
 *
 * ★ EVERY SHAPE BELOW MIRRORS THE SERVER SCHEMA FIELD FOR FIELD, and the names are
 *   the server's own. Renaming `rowCount` to `rows` on the way in would read
 *   better and would also mean the two documents disagree, which is how a type
 *   here survives a rename on the server while the field it reads goes missing.
 *   `server/src/routes/activity.ts` is the source of truth; this is its reader.
 */

/**
 * Which database a count was taken from.
 *
 * ★ A NUMBER DOES NOT CARRY ITS OWN PROVENANCE, WHICH IS WHY THIS FIELD EXISTS. The
 *   counts are read from whichever store holds the object — the application's own
 *   tables from the app store, everything else from the ledger — so a single
 *   response mixes two databases, and a difference between two readings is only a
 *   change if both came from the same one. The server refuses to compute a
 *   difference across stores, and carries this so the screen can say which.
 */
export type ActivityStore = 'app' | 'ledger';

/**
 * How an object's count is narrowed to the register's scope.
 *
 * `segments` — the object carries the ledger's account segments itself, so the
 * predicate can be applied directly. `lookup` — it carries only a
 * `CODE_COMBINATION_ID`, so the scope is resolved through `GL_CODE_COMBINATIONS`.
 * `null` — it carries neither, so no narrowing is possible and the count is a
 * whole-table count. The server decides this from the object's own columns rather
 * than from a list kept by hand, and this type is that decision's three answers.
 */
export type ActivityScopeMode = 'segments' | 'lookup' | null;

/**
 * The row count as it was recorded, and what it moved by.
 *
 * ★ THE DIFFERENCE IS A DERIVED FIGURE AND IS SHAPED SO IT CANNOT STAND IN FOR THE
 *   COUNT. `rowCount` is a measurement someone took; `delta` subtracts two of them
 *   taken on two days, and the two are never added together — on either side of the
 *   wire. Four more rows can be six inserted and two deleted, so `delta` is a net
 *   figure over an interval, not a count of anything that happened.
 *
 * ★ `delta: null` MEANS "THIS IS THE FIRST READING", NOT "NOTHING CHANGED". The
 *   difference between the two is the difference between "we have not looked
 *   twice" and "between the two times we looked, nothing moved", and only one of
 *   them is a fact about the database. A `0` here is that second fact.
 *
 * ★ `previousDate` TRAVELS WITH `delta` BECAUSE THE GAP IS PART OF THE CLAIM. There
 *   is no scheduler and no promise of a reading every day, so a table read on
 *   Monday and again on Thursday produces a three-day difference — and a number
 *   without its other date cannot be told apart from a one-day one.
 *
 * ★ AND `store` TRAVELS WITH BOTH, BECAUSE A DIFFERENCE NEEDS ONE DATABASE. In the
 *   shipped configuration the counts come from Oracle and the application's own
 *   tables are counted in SQLite, so two readings of the same object really can
 *   come from two systems. The server computes `delta` only when the two agree and
 *   this field is how the screen can say which database the pair came from.
 */
export interface ActivityReading {
  /** The day this reading belongs to — the newest reading on or before the day asked about. */
  date: string;
  /** The count as it was read. */
  rowCount: number;
  /** Which database took the count. Two readings are only comparable within one store. */
  store: ActivityStore;
  /** The wall-clock instant it was read, as distinct from the day it is filed under. */
  capturedAt: string;
  /** The reading before this one, or null when this is the first. */
  previousDate: string | null;
  previousCount: number | null;
  /** `rowCount - previousCount`, or null when there is no earlier reading. */
  delta: number | null;
}

/**
 * One table's row in the register.
 *
 * ★ `rowCount` IS `number | null`, AND THE NULL IS THE FEATURE. Two states are
 *   representable and both occur:
 *
 *     a number → a reading has been taken, and `0` means the table is empty.
 *     null     → no reading has been taken yet. `reason` is written prose
 *                explaining that, and the screen must render the reason rather
 *                than a figure. The count is not `0` and cannot be turned into
 *                one.
 *
 *   A component that does `rowCount ?? 0` has reintroduced the exact confusion
 *   this whole feature exists to avoid, which is why the field is typed as
 *   nullable rather than pre-defaulted.
 *
 * ★ `snapshot` AND `reading` ARE NOT THE SAME FIELD, WHICH IS WHY BOTH ARE HERE.
 *   `reading` is where and when the figure came from — present whenever a count
 *   exists, and the only thing needed to label a number. `snapshot` is the count
 *   *and its difference from the reading before it*, present only when there are
 *   two readings to compare. A row with a count and no difference is ordinary, and
 *   it is the row a screen that read `snapshot` for its figure would render blank.
 *
 * ★ `scoped` AND `scopeMode` ARE DIFFERENT QUESTIONS. `scopeMode` is how the
 *   narrowing was done — `null` when it could not be done at all. `scoped` is the
 *   yes/no the screen actually needs. Both are carried because a bare boolean
 *   cannot distinguish "narrowed by its own account segments" from "narrowed
 *   through a code-combination lookup", and the page says which.
 */
export interface ActivityTable {
  name: string;
  kind: 'table' | 'view';
  owner: 'app' | 'extract';
  /** Rows in the table as last recorded; null when no reading has been taken. */
  rowCount: number | null;
  /** True when the count was narrowed to the register's scope. */
  scoped: boolean;
  /** How it was narrowed, or null when the object carries no account to narrow by. */
  scopeMode: ActivityScopeMode;
  /** The store the count came from, or would come from. */
  store: ActivityStore;
  /** Where the figure came from — present with any count, and only then. */
  reading: { date: string; capturedAt: string } | null;
  /** The count and its difference from the reading before it. */
  snapshot: ActivityReading | null;
  /** Why no count is available. Null when there is one. */
  reason: string | null;
}

/**
 * How the recorded row counts stand on the day asked about.
 *
 * ★ REPORTED BECAUSE THE FEATURE'S OWN LIMIT IS OTHERWISE INVISIBLE. Every row with
 *   one reading looks identical to every row with two; only `comparable` says which
 *   of the two a reader is looking at. There is no scheduler, so "N of M compared"
 *   is a fact about how often somebody pressed the button, not about the tables.
 */
export interface ActivityReadings {
  /** The newest reading on or before the day asked about, or null if there are none. */
  latest: string | null;
  /** When that reading was taken. */
  capturedAt: string | null;
  /** Objects with a reading on or before the day asked about. */
  read: number;
  /** Objects with two such readings, so a difference can be computed. */
  comparable: number;
  /** Objects whose two newest readings differ. */
  moved: number;
  /** Readings this request wrote, rather than read. Zero on an ordinary load. */
  recorded: number;
  /**
   * Objects this request could not count, named with the reason each gave.
   *
   * ★ AN EMPTY ARRAY HERE IS A COMPLETE CAPTURE AND NOT NOTHING TO SAY, and on the
   *   live ledger it is not the expected result: the object list is the sample's
   *   declared inventory, so some of it is expected to be unreadable by this
   *   account. A page that rendered only the count and dropped these would present
   *   a partial capture as a complete one.
   */
  failed: { name: string; error: string }[];
}

export interface ActivitySummary {
  tables: number;
  /** Objects the extract owns — the two tabs are exactly this split. */
  system: number;
  /** Objects this application owns. */
  application: number;
  /** Objects whose count could be narrowed to the register's scope. */
  scoped: number;
  /** Objects it could not be, because they carry no account. */
  unscoped: number;
  /** Objects with a recorded reading. */
  counted: number;
  /** Objects deliberately left out of the register, and why. */
  skipped: { name: string; reason: string }[];
  readings: ActivityReadings;
}

/**
 * Which database the register actually read.
 *
 * ★ THE PAGE CANNOT BE HONEST ABOUT ITS FIGURES WITHOUT THIS, AND THE SERVER IS THE
 *   ONLY ONE THAT KNOWS. Every number on the screen is a fact about one store, and
 *   which store that is depends on the server's `APP_DB_URL`. Two servers over the
 *   same `data/` directory answer this endpoint differently, so a page that printed
 *   neither label would present both answers with the same confidence.
 *
 * ★ AND THE CATALOGUE AND THE COUNTS REALLY CAN COME FROM TWO DIFFERENT DATABASES.
 *   `resolveAppDb` puts the app's own tables in a local SQLite file *whenever the
 *   ledger is Oracle* — Oracle has nowhere to keep them — so `sharedWithLedger` is
 *   false in the mode this server runs in. The object list is read from the app
 *   store's own catalogue while the counts for everything the app does not own are
 *   read from the ledger. That is why all of this is on the response rather than a
 *   paragraph typed into the JSX: a client that wrote the name itself would be
 *   printing a database name it had no way to check, and the page's whole Source
 *   line depends on naming the one the *figures* came from rather than the one the
 *   file list did.
 */
export interface ActivitySource {
  /** The store the catalogue came from. Only ever the app store, by construction. */
  store: 'app';
  /** Its label — a file path or a host and service. Never a credential. */
  label: string;
  /** Its dialect, so a reader can see what kind of catalogue this was. */
  dialect: 'sqlite' | 'oracle';
  /** The ledger's label, so the sentence can name what the register did *not* read. */
  ledgerLabel: string;
  /** True when the app store and the ledger are the same database. */
  sharedWithLedger: boolean;
  /**
   * The store the *counts* were taken from, which is not always the catalogue's.
   *
   * ★ THE COUNTS AND THE CATALOGUE ARE READ FROM DIFFERENT PLACES WHEN THE LEDGER IS
   *   ORACLE, and this pair is the only way the page can say so. The object list and
   *   the readings live in the app store; the numbers live in whichever store holds
   *   the object, which in the shipped configuration means Oracle for everything the
   *   application does not own. A page that printed `label` for both would be naming
   *   the catalogue as the source of counts it never took.
   */
  countStore: ActivityStore;
  /** The count store's label — the database the figures below came from. */
  countLabel: string;
}

/** Everything the register knows about one day. */
export interface ActivityDay {
  date: string;
  isToday: boolean;
  tables: ActivityTable[];
  summary: ActivitySummary;
  /** A sentence written from the counts, or null when there is nothing to warn about. */
  note: string | null;
  /** The database these figures describe. */
  source: ActivitySource;
  /**
   * The account scope the counts are narrowed to.
   *
   * ★ IT IS THE SERVER'S RULE, NOT THE READER'S SELECTION, AND THE PAGE SAYS SO. The
   *   register narrows to a fixed fund and program set of its own rather than to whatever
   *   the top bar is on, so a reader who has selected something else must be told that the
   *   numbers below obey a different rule — otherwise the page looks like it is ignoring
   *   their selection. `summary.scoped` is how many objects the rule reached; this is the
   *   rule itself, and the two are different facts.
   */
  scope: { fund: string; programs: string[] };
}

/**
 * What the rail badge reads. Small on purpose — it is fetched on every page.
 *
 * ★ IT NO LONGER COUNTS CHANGES, BECAUSE NOTHING HERE MEASURES A DIFFERENCE BY DAY.
 *   It reports what an inventory can: how many objects carry a count, and how many of
 *   those counts differ from the reading before them. The second is the only sense in
 *   which anything on this page "changed", and the two travel together so the badge
 *   cannot show a numerator without the number it is out of.
 */
export interface ActivityToday {
  date: string;
  /** Objects with a recorded reading. */
  counted: number;
  /** Objects whose count differs from the reading before it. */
  moved: number;
}

/**
 * A request the server refused, with the status that refused it.
 *
 * ★ THE STATUS IS CARRIED AS A FIELD, NOT SMUGGLED INTO THE MESSAGE. The page has
 *   to tell "you typed a date that does not exist" — a 400, whose prose belongs in
 *   the date input's own hint — from "the server is not answering", which replaces
 *   the table. Testing `message.startsWith('HTTP 400')` cannot make that call:
 *   when the body *is* JSON the message is the server's own prose and begins with
 *   no status at all, so a refused date would have been rendered as a whole-page
 *   failure. Reading the field is the only test that holds for both bodies.
 */
export class RequestRefused extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'RequestRefused';
    this.status = status;
  }
}

/**
 * The reason a request was refused, in the words the server chose.
 *
 * A bad date comes back as prose that names the day it *would* have shown
 * (`"2026-02-31" is not a real date — the closest one is 2026-03-03.`), and that
 * sentence is the whole value of the refusal. Replacing it with `HTTP 400` would
 * make an impossible date indistinguishable from a server that is down.
 */
async function readError(res: Response): Promise<Error> {
  let detail = `HTTP ${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (body?.error?.message) detail = body.error.message;
  } catch {
    /* The status line stands. A body that is not JSON is not worth failing twice over. */
  }
  return new RequestRefused(res.status, detail);
}

/**
 * A `Date` as `YYYY-MM-DD`, in local time.
 *
 * `toLocaleDateString('en-CA')` is the same trick the server uses, and for the
 * same reason: `toISOString().slice(0, 10)` is the UTC day, which is a different
 * day for anyone west of Greenwich after 20:00 — and the register's own "today"
 * comes from the server's local clock.
 */
export function dayOf(dt: Date): string {
  return dt.toLocaleDateString('en-CA');
}

/** Today, as the register understands it. */
export function today(): string {
  return dayOf(new Date());
}

/**
 * The inventory, as recorded on one day.
 *
 * Returns the whole envelope rather than just `tables`, because `summary` is what
 * the caption and the tab counts are written from, `source` is the only place the
 * page can learn which database the figures came from, and `note` is the sentence
 * that explains what the counts do and do not cover. Recomputing any of them from
 * `tables` would be a second definition of the same thing, free to disagree with
 * the first.
 *
 * ★ THIS READS A READING; IT DOES NOT TAKE ONE. The server answers this from
 *   `table_count_snapshot` and counts nothing, which is what makes a page load
 *   cheap against a ledger holding millions of rows per table and what makes the
 *   figures stable between two visits. Taking a count is `captureReadings`, and it
 *   is behind a button because it costs a full scan of every object in the list.
 */
export async function loadActivity(day?: string, signal?: AbortSignal): Promise<ActivityDay> {
  // ★ NO DATE MEANS THE SERVER'S OWN TODAY, AND THAT IS THE ONLY DAY THIS PAGE ASKS
  //   ABOUT. Omitting the parameter rather than computing a date here is what keeps
  //   the page's day and the server's day from being two different things: the
  //   response says which day it answered for, and the screen uses that.
  const query = day ? `?date=${encodeURIComponent(day)}` : '';
  const res = await fetch(`/api/activity${query}`, { signal });
  if (!res.ok) throw await readError(res);

  const body = (await res.json()) as { data?: ActivityDay };
  const payload = body?.data;
  if (!payload || !Array.isArray(payload.tables)) {
    throw new Error('The activity response did not contain a list of tables.');
  }
  return payload;
}

/**
 * How the recorded counts stand, for the rail badge.
 *
 * A separate endpoint from `loadActivity` even though it answers a subset of the
 * same question, and deliberately so: the badge is on every page, and fetching
 * forty-eight objects' worth of readings to print one number would make a rail
 * badge the most expensive request in the app.
 *
 * ★ IT FAILS SOFT. A badge is decoration; a 503 from this call must not blank a
 *   screen that has nothing to do with it. `loadActivityToday` therefore resolves
 *   to `null` on any failure and the caller renders `—`, which is the state the
 *   rail already uses for "not loaded" — visibly not a number, so it can never be
 *   mistaken for a count of zero.
 */
export async function loadActivityToday(signal?: AbortSignal): Promise<ActivityToday | null> {
  try {
    const res = await fetch('/api/activity/today', { signal });
    if (!res.ok) return null;
    // ★ `ActivityToday`, NOT `CaptureResult`. The two endpoints answer different
    //   questions — the capture reports what it recorded, this one reports how the
    //   recorded counts now stand — and annotating this body with the capture's
    //   shape made `payload.counted` a read of a field that type says cannot exist.
    //   It happened to compile only because the read sat behind an optional chain.
    const body = (await res.json()) as { data?: ActivityToday };
    const payload = body?.data;
    if (!payload || typeof payload.counted !== 'number') return null;
    return payload;
  } catch {
    // An abort is a failure here too, and the right answer for an aborted badge is
    // the same as for a failed one: no number.
    return null;
  }
}

/**
 * What the capture endpoint reports.
 *
 * `written` is the number of readings that landed and `failed` names the objects
 * that could not be counted — kept separate rather than folded into one number,
 * because "forty readings, forty objects" and "forty readings, thirty-eight
 * objects and two unreadable views" are different facts, and the second one means
 * the table of counts on screen has holes in it.
 *
 * ★ `failed` CARRIES THE REASON, NOT JUST THE NAME, AND ON THE LIVE LEDGER IT IS NOT
 *   EMPTY. The object list is the sample's declared inventory rather than Oracle's
 *   dictionary, so some of it is expected to be unreadable by this account. A UI
 *   that showed only `written` would present a partial capture as a complete one,
 *   which is why the failure is a pair and not a count.
 */
export interface CaptureResult {
  date: string;
  capturedAt: string;
  written: number;
  failed: { name: string; error: string }[];
}

/**
 * Take a reading of every table, deliberately.
 *
 * ★ THIS IS NOW THE ONLY WAY A READING IS EVER TAKEN. The earlier design took one
 *   automatically on the first load of the current day, which made the figures a
 *   side effect of somebody opening the page and made every load a candidate for a
 *   set of full table scans. The button is the whole mechanism: a load reads what a
 *   previous press recorded and counts nothing, which is what makes the page cheap
 *   to open and the numbers stable between visits.
 *
 * ★ IT THROWS, UNLIKE `loadActivityToday`. This is something a person asked for,
 *   and a person asking for a reading and being told nothing happened is worse
 *   than an error message. The 409 that a read-only target produces is the honest
 *   answer and is surfaced as such — note that 409, not 500: nothing is broken,
 *   the target simply will not accept writes.
 *
 * ★ AND IT IS SLOW ON PURPOSE. A capture against the live ledger means a `COUNT(*)`
 *   over tables holding millions of rows; it measured at 13.4 seconds for the whole
 *   object list. That is why the caller keeps a button in its pending state rather
 *   than firing this on render, and why nothing else in the application calls it.
 */
export async function captureReadings(signal?: AbortSignal): Promise<CaptureResult> {
  const res = await fetch('/api/activity/snapshot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    signal,
  });
  if (!res.ok) throw await readError(res);

  const body = (await res.json()) as { data?: CaptureResult };
  const payload = body?.data;
  if (!payload || typeof payload.written !== 'number') {
    throw new Error('The capture response did not contain a count of readings.');
  }
  return payload;
}
