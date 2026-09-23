/**
 * Read caps — how many rows the app reads from a ledger object, and in what order.
 *
 * ── WHAT THIS IS FOR ─────────────────────────────────────────────────────────
 *
 * The EBS instance holds tables in the hundreds of millions of rows
 * (`GL_BALANCES` is 157 M; the AP surface is 1.2 M checks). A register that reads
 * one of those whole is not slow — it is a request that never returns. This module
 * is the client half of the per-object bound: it lists the caps, saves one, and
 * runs a **preview** so an administrator can see what a cap does before storing it.
 *
 * ── ★ THE PREVIEW IS WHY THE SCREEN EXISTS ───────────────────────────────────
 *
 * A cap is a number in a box, and a number in a box is not checkable. `previewCap`
 * runs the draft statement against the ledger and returns the first rows — which
 * columns, which dates, whether the ordering puts what you expect at the top — so
 * "100,000 rows ordered by `CHECK_DATE DESC`" becomes a thing that was looked at
 * rather than a claim. The response carries the exact SQL that ran, in the dialect
 * the deployment used, so a cap that misbehaves is diagnosable from the response.
 *
 * ── ★ A LIMIT WITH NO ORDERING IS REFUSED, AND THE REFUSAL IS THE FEATURE ────
 *
 * `WHERE ROWNUM <= 100000` returns whichever rows the database reached first. A
 * count of 100,000 then means "at least 100,000", a sum is the sum of an unknown
 * subset, and every percentage has the wrong denominator — none of it visible in
 * the payload. With an ordering the same cap is a reproducible window that can be
 * labelled. The server refuses the un-ordered combination with a 400, and this
 * module surfaces that refusal rather than working around it.
 *
 * ── ★ TWO DIALECTS, AND THE SERVER OWNS THE DIFFERENCE ───────────────────────
 *
 * Oracle has no `LIMIT`: it spells the bound `FETCH FIRST n ROWS ONLY` (12c+) or
 * the nested `ROWNUM` form (11g+); SQLite spells it `LIMIT n`. The stored SQL
 * carries no bound — it is appended per dialect at read time — so one stored row
 * serves both backends and nothing here has to know which one is running. What
 * this module *does* carry is the `dialect` the server reported, so the panel can
 * show which form was used and a reader is not left guessing.
 */

const BASE = '/api';

/** One object's cap, as the server stores it. */
export interface ReadCap {
  tableName: string;
  /** The statement the app runs for this object, or null to use the route's own. */
  sql: string | null;
  /** The row bound, or null when the object is uncapped. */
  maxRows: number | null;
  /** The window the cap is taken in. Required whenever `maxRows` is set. */
  orderBy: string | null;
  note: string | null;
  setBy: string | null;
  setAt: string | null;
  /** Derived by the server so a reader does not re-derive it. */
  capped: boolean;
  /**
   * The statement the app reads when no cap row stores one.
   *
   * ★ IT IS NOT A CAP AND IT IS NOT STORED. It comes from the server's registry
   *   (`db/ledger-defaults.ts`), so a fresh deployment reads every object with a
   *   sensible statement and the panel has something real to offer on first open —
   *   a cap with no statement to run is a number in a box, which is the thing the
   *   preview was built to avoid. Null means nobody has decided what this object
   *   should read, which the panel says in words rather than papering over.
   */
  defaultSql: string | null;
  /** The ordering the default is taken in, offered as the `orderBy` starting value. */
  defaultOrderBy: string | null;
  /** Why the default reads what it reads, shown beside the field. */
  defaultNote: string | null;
}

export interface ReadCapList {
  items: ReadCap[];
  /** The dialect a cap will be applied in on this deployment. */
  dialect: 'sqlite' | 'oracle';
  /** Every ledger object the registry knows, whether or not it has a cap row. */
  knownTables: string[];
  counts: { total: number; capped: number };
}

export interface ReadCapPreview {
  tableName: string;
  /** The statement that was executed, cap and ordering included. */
  statement: string;
  dialect: 'sqlite' | 'oracle';
  maxRows: number | null;
  orderBy: string | null;
  /** How many rows the preview shows — a panel-sized bound, not the cap. */
  previewRows: number;
  columns: string[];
  rows: Record<string, unknown>[];
  /** How many rows came back before the preview bound was applied. */
  returned: number;
  /** True when the statement produced more rows than the preview shows. */
  truncated: boolean;
  /** How long the statement took, so a slow cap is visible before it is saved. */
  ms: number;
}

/**
 * A refusal from the server, with the fields it names.
 *
 * ★ `accepts` AND `details` ARE CARRIED BECAUSE THE MESSAGES USE THEM. A 400 from
 *   this surface names the token it rejected (`details.token`) or the field list it
 *   wanted (`accepts`), and dropping them would leave the panel with a sentence it
 *   cannot act on — the same reason the organization panel keeps `acceptedValues`.
 */
export class ReadCapError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: Record<string, unknown> | null;

  constructor(message: string, status: number, code: string | null, details: Record<string, unknown> | null) {
    super(message);
    this.name = 'ReadCapError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** The session token, read the way every other module here reads it. */
function token(): string | null {
  try {
    return localStorage.getItem('projects-session-token');
  } catch {
    return null;
  }
}

/**
 * One request, with the error shape unwrapped.
 *
 * ★ THE ERROR BODY IS READ ONCE AND KEPT. The house note on this server records a
 *   check that drained a response body inside an assertion message and then failed
 *   with "Body has already been used" on a request that had in fact succeeded — so
 *   the body is read here, in one place, and the fields are carried on the error.
 *
 * ★ AN EMPTY BODY IS NOT AN ERROR, AND `null` IS RETURNED FOR ONE. A successful
 *   response with no content is a normal HTTP outcome (204, or a 200 with an empty
 *   body), and reading `.data` off it throws `Cannot read properties of null` — a
 *   message naming nothing about the request. This cost a round trip: the DELETE
 *   route answered 204, the panel reported that TypeError as if the server had
 *   failed, and nothing in the sentence said which call it came from. Callers that
 *   expect a payload still get one; the ones that do not are not forced to invent
 *   a shape for an answer that has none.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const t = token();
  if (t) headers['x-app-session'] = t;

  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });

  let payload: unknown = null;
  let text = '';
  try {
    text = await res.text();
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!res.ok) {
    const err = (payload as { error?: { message?: string; code?: string; details?: Record<string, unknown> } } | null)?.error;
    throw new ReadCapError(
      err?.message ?? (text || `The request failed with ${res.status}.`),
      res.status,
      err?.code ?? null,
      err?.details ?? null,
    );
  }

  return payload as T;
}

/** The list, with every object a cap could be written for. */
export async function loadReadCaps(): Promise<ReadCapList> {
  const body = await request<{ data: ReadCapList }>('/read-caps');
  return body.data;
}

/** One object's cap. An object with no row comes back as `capped: false`, not a 404. */
export async function loadReadCap(table: string): Promise<ReadCap> {
  const body = await request<{ data: ReadCap }>(`/read-caps/${encodeURIComponent(table)}`);
  return body.data;
}

/** The whole row is sent, so a limit cannot be left without its ordering. */
export interface ReadCapDraft {
  sql: string | null;
  maxRows: number | null;
  orderBy: string | null;
  note: string | null;
}

export async function saveReadCap(table: string, draft: ReadCapDraft): Promise<ReadCap> {
  const body = await request<{ data: ReadCap }>(`/read-caps/${encodeURIComponent(table)}`, {
    method: 'PUT',
    body: JSON.stringify(draft),
  });
  return body.data;
}

export async function removeReadCap(table: string): Promise<{ tableName: string; removed: boolean }> {
  const body = await request<{ data: { tableName: string; removed: boolean } } | null>(
    `/read-caps/${encodeURIComponent(table)}`,
    { method: 'DELETE' },
  );
  // The route declares 200 and returns a result, so this is the normal path. The
  // fallback is for a deployment still answering 204: the deletion happened, and
  // `removed: true` is the honest reading of "the server accepted the delete".
  return body?.data ?? { tableName: table, removed: true };
}

/**
 * Run a draft and return the first rows it produces.
 *
 * ★ THE DRAFT IS SENT, NOT THE STORED ROW. The preview answers "what would this
 *   form do", so it must not consult what is already saved — otherwise a stored cap
 *   leaks into the draft that is about to replace it and the panel shows the old
 *   window while the new one is being edited.
 */
export async function previewCap(table: string, draft: ReadCapDraft): Promise<ReadCapPreview> {
  const body = await request<{ data: ReadCapPreview }>(
    `/read-caps/${encodeURIComponent(table)}/preview`,
    { method: 'POST', body: JSON.stringify(draft) },
  );
  return body.data;
}

/**
 * What a cap means, in one sentence a reader can check.
 *
 * ★ THE UN-ORDERED CASE IS A SENTENCE ABOUT ARBITRARINESS, NOT A BLANK. A cap with
 *   no ordering is the form the server refuses, so this branch should be
 *   unreachable from a saved row — but a row could predate the rule, and rendering
 *   it as "at most 100,000 rows" would describe the dangerous form as though it
 *   were the safe one. Saying what it actually does is the point.
 */
export function describeCap(cap: Pick<ReadCap, 'maxRows' | 'orderBy'>): string {
  if (cap.maxRows === null) return 'Read unbounded — every matching row.';
  const n = cap.maxRows.toLocaleString('en-US');
  if (!cap.orderBy) {
    return `At most ${n} rows, in no particular order — whichever the database reaches first.`;
  }
  return `The first ${n} rows by ${cap.orderBy}.`;
}

/**
 * Which dialect form the cap will take, named for the panel.
 *
 * The two are not interchangeable and a reader who has written SQL against one
 * backend should be able to see which one their deployment uses.
 *
 * ★ THE SENTENCE DOES NOT REPEAT THE DIALECT NAME. The register already prints
 *   "Caps are applied in <dialect>", so this returns the *mechanism* — what the cap
 *   becomes — rather than naming the backend a second time. The first version
 *   began "Oracle — …" and rendered as "applied in oracle — Oracle — …".
 */
export function dialectForm(dialect: 'sqlite' | 'oracle'): string {
  return dialect === 'oracle'
    ? 'the cap is a nested ROWNUM bound wrapped around the ordered query'
    : 'the cap is a LIMIT on the ordered query';
}

/**
 * The cap totals, for a screen that wants to say how much the app will read.
 *
 * ★ IT IS DERIVED FROM THE SAME LIST THE PANEL READS, NOT A SECOND ENDPOINT. The list
 *   already carries every object with its cap, so a caller that wants a total does the
 *   arithmetic here rather than asking the server for a number the server would compute
 *   from the same rows. One request, one source, and the two screens cannot disagree.
 *
 * ★ `capped` IS THE COUNT OF OBJECTS WITH A CAP, NOT THE COUNT OF OBJECTS. Every
 *   registered object has a row in the list (see the endpoint), so `items.length` is the
 *   registry's size and says nothing about how much is bounded.
 */
export interface ReadCapTotals {
  /** How many ledger objects have a cap in force. */
  capped: number;
  /** How many ledger objects the registry knows. */
  total: number;
  /**
   * The sum of the caps, or **null when nothing is capped**.
   *
   * ★ NULL RATHER THAN 0, AND THE DIFFERENCE IS THE WHOLE POINT. An unbounded object is
   *   not bounded at zero — it reads every matching row. So a total of `0` would be a
   *   claim that the app reads nothing, which is the opposite of the truth, while `null`
   *   says "no bound is in force" and lets the caller phrase it honestly. Summing only
   *   the capped objects and reporting that sum as though it were the whole is the same
   *   error in a smaller size, so the caller is told which it has.
   */
  capTotal: number | null;
}

/** The totals a screen can state, from a list it has already loaded. */
export function capTotals(list: ReadCapList): ReadCapTotals {
  const cappedItems = list.items.filter((i) => i.capped && i.maxRows !== null);
  return {
    capped: cappedItems.length,
    total: list.items.length,
    capTotal:
      cappedItems.length === 0
        ? null
        : cappedItems.reduce((sum, i) => sum + (i.maxRows ?? 0), 0),
  };
}

/**
 * How much the app will read, in one sentence — or null when nothing is bounded.
 *
 * ★ THE SENTENCE NAMES THE BOUND AS A CEILING, NOT AS A COUNT. "5,000,000 rows
 *   available" reads as a measurement of what is there; the caps are a *limit on what
 *   will be read*, and on an object whose table holds fewer rows than its cap the two
 *   coincide only by luck. So the wording is "up to N rows across M capped objects",
 *   which is true in both directions.
 *
 * ★ AND IT SAYS NOTHING WHEN NOTHING IS CAPPED. An uncapped deployment reads every
 *   matching row, which is not a number this function can produce — and "0 rows
 *   available" would be the most alarming possible way to describe an unbounded read.
 *   Returning null lets the caller fall back to the table count alone, which is what
 *   the card said before this feature existed.
 */
export function describeCapTotal(totals: ReadCapTotals): string | null {
  if (totals.capTotal === null) return null;
  const n = totals.capTotal.toLocaleString('en-US');
  const objects = totals.capped === 1 ? '1 capped object' : `${totals.capped} capped objects`;
  return `up to ${n} rows across ${objects}`;
}
