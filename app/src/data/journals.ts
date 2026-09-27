/**
 * The journal register, read from the API.
 *
 * ── WHY THIS MODULE EXISTS, AND WHAT IT IS NOT ───────────────────────────────
 *
 * Every other data module under `app/src/data/` parses a file in
 * `app/public/oracle/`. This one cannot: `GL_JE_HEADERS` and `GL_JE_LINES` are not
 * in the client extract at all. They are served at `/api/funding/journals` by the
 * `JE_HEADER` / `JE_LINE` descriptors in `server/src/routes/funding.ts`, so the
 * Journal entries screen is one of the screens whose figures arrive over HTTP.
 *
 * ── ★ THE ONE MEASUREMENT THAT SHAPES THIS WHOLE SCREEN ─────────────────────
 *
 * `GET /api/funding/journals` with **no filter is refused**, and the refusal is
 * not a defect. Measured against the live ledger:
 *
 *     unfiltered                        → 503, refuses to count
 *     ?actual_flag=B   Budget           → 200,  143,587 journals
 *     ?actual_flag=E   Encumbrance      → 200,  564,101 journals
 *     ?actual_flag=A   Actual           → 200,  303,771 journals
 *     ?period_name=Aug-26-FY-27         → 200,      911 journals
 *     ?period_name=Jun-27-FY-27         → 200,        0 journals
 *
 * Those three flags sum to 1,011,459, which is over the ceiling on its own, and
 * that is the whole story: `server/src/db/row-budget.ts` sets `ALL_MAX_RECORDS` to
 * 1,000,000 and `refuseIfOverCeiling` turns an aggregate that would read more than
 * that into `503 DB_UNAVAILABLE` carrying `{ table, rows, ceiling, variable }`.
 *
 * ★ SO `ACTUAL_FLAG` IS NOT ONE FACET AMONG SEVERAL — IT IS THE PARTITION THAT
 *   MAKES THE REGISTER READABLE AT ALL. Every value the ledger uses (`A`, `B`, `E`)
 *   is individually under the ceiling and the union is over it. That is why the
 *   screen's primary control is the flag, why it lands on `B`, and why "all flags"
 *   is offered as a state the screen *expects to be refused* rather than as the
 *   default that happens to fail.
 *
 * ── THE SECOND MEASUREMENT: THE IRREGULAR PARAMETER NAMES ───────────────────
 *
 * `filterParam(f) = f.param ?? f.column.toLowerCase()`, so a filter's query string
 * key is the **lowercased column name** — `period_name`, `je_category`,
 * `je_source`, `actual_flag`, `status`, `ledger_id`. These are case-sensitive on
 * the way in and the server does not warn: `?STATUS=P` is silently ignored, which
 * leaves the read unfiltered, which is then refused with a message about the row
 * ceiling and gives no hint that the parameter was dropped. Every key this module
 * writes is therefore built here, in one place, from the lowercase literals, and
 * nothing else in the app is allowed to spell them.
 *
 * ── THE THIRD: INTEGER COLUMNS COME BACK AS STRINGS ─────────────────────────
 *
 * `JE_HEADER_ID`, `LEDGER_ID`, `JE_LINE_NUM`, `CODE_COMBINATION_ID` and
 * `ENCUMBRANCE_TYPE_ID` are declared `bigint` on the ledger and are served by the
 * T-SQL store as **strings** (`"12891592"`). The interfaces below say `string`
 * because that is what arrives. Declaring them `number` would be a lie the
 * compiler could not see through, and `JE_HEADER_ID` is used as a URL segment and
 * as a React key, where a silent `NaN` from a `Number()` coercion is worse than
 * the string it came from.
 *
 * ★ A COROLLARY THAT MATTERS FOR THE DRILL-IN: the line register's
 *   `je_header_id` filter is typed `kind: 'integer'` while the column is
 *   `nvarchar`. The drill-in therefore does **not** use
 *   `/api/funding/journal-lines?je_header_id=…`. It uses
 *   `/api/funding/journals/{id}/detail`, which resolves the header server-side and
 *   returns the lines, the count and the totals with it — one request instead of
 *   two, and no comparison between a number and a string anywhere in the path.
 */

import { readTrace, sqlUrl } from './sqlTrace';
import { sessionHeaders } from './session';
import type { SqlTrace } from '../components/SqlNote';
import { money as fmtMoney } from './format';

/** The page envelope the API wraps every list in. */
interface Envelope<T> {
  data: T[];
  page: Page;
  /** Present only while the reader has the SQL trace switched on. */
  sql?: SqlTrace | null;
}

/** The counts a list response carries beside its rows. */
export interface Page {
  limit: number;
  offset: number;
  total: number;
  returned: number;
}

/** The envelope a single-object route wraps its object in. */
interface Single<T> {
  data: T;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Errors — and the specific one this screen is built to show
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The `details` object on a refused read.
 *
 * `refuseIfOverCeiling` always sends all four of these together; other
 * `DB_UNAVAILABLE` refusals send a different set, so every field is optional and
 * the screen has to ask whether the refusal it has *is* a ceiling refusal rather
 * than assuming a 503 means one.
 */
export interface RefusalDetails {
  table?: string;
  rows?: number;
  ceiling?: number;
  variable?: string;
  store?: string;
  [key: string]: unknown;
}

/** A read that did not produce rows, carrying enough to say *why* in prose. */
export class JournalReadError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: RefusalDetails | null;

  constructor(message: string, options: { code: string; status: number; details: RefusalDetails | null }) {
    super(message);
    this.name = 'JournalReadError';
    this.code = options.code;
    this.status = options.status;
    this.details = options.details;
  }

  /**
   * Is this refusal the row ceiling?
   *
   * ★ TWO TESTS, AND THE SECOND ONE IS NOT BELT-AND-BRACES FOR ITS OWN SAKE. The
   *   structured `{ ceiling, variable }` pair is the contract and is what is used
   *   when it is present. But `RefusalDetails` is `unknown`-shaped on purpose —
   *   it is the server's error payload, not a type this module owns — and a
   *   refusal that named the ceiling in its sentence while sending no details
   *   would otherwise be rendered as a generic "database unavailable", which is a
   *   *wrong instruction*: it sends the reader to check the connection when the
   *   fix is to narrow the request. False positives cost a differently-worded
   *   heading on a message that is still shown verbatim underneath.
   */
  get overCeiling(): boolean {
    if (this.details?.ceiling !== undefined && this.details?.variable !== undefined) return true;
    return this.code === 'DB_UNAVAILABLE' && /\bceiling\b/i.test(this.message);
  }
}

/** An abort is not a failure — it is the reader leaving, and callers re-throw it. */
export function isAbort(err: unknown): boolean {
  return err instanceof DOMException ? err.name === 'AbortError' : (err as { name?: string })?.name === 'AbortError';
}

/**
 * One request, unwrapped.
 *
 * The error path reads `body.error.message` and puts it in the thrown message
 * **unchanged**, because the server's refusal sentences are the best explanation
 * of their own refusals that exists — `refuseIfOverCeiling` writes one that names
 * the table, the row count, the ceiling *and* the environment variable that sets
 * it. Rewriting that here would be a summary of a summary.
 */
async function getJson<T>(path: string, signal: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(sqlUrl(path), { headers: sessionHeaders(), signal });
  } catch (err) {
    if (isAbort(err)) throw err;
    throw new JournalReadError(
      `The request to ${path} did not complete. The API at :5181 may not be running.`,
      { code: 'NETWORK', status: 0, details: null },
    );
  }

  const body: unknown = await res.json().catch(() => null);

  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    throw new JournalReadError(
      err?.message ?? `The server answered ${res.status} and gave no message.`,
      {
        code: err?.code ?? `HTTP_${res.status}`,
        status: res.status,
        details: (err?.details as RefusalDetails | undefined) ?? null,
      },
    );
  }

  if (!body || typeof body !== 'object') {
    throw new JournalReadError('The server answered with something that is not JSON.', {
      code: 'MALFORMED',
      status: res.status,
      details: null,
    });
  }

  return body as T;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The rows
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * One journal header — the 13 columns `JE_HEADER_COLUMNS` declares, in its order.
 *
 * `ENCUMBRANCE_TYPE_ID` is `null` on a budget or actual journal and a **string**
 * on an encumbrance one (measured: `"1020"`), so it is `string | null` rather
 * than the number the ledger's `bigint` would suggest.
 */
export interface JournalHeader {
  JE_HEADER_ID: string;
  LEDGER_ID: string | null;
  JE_CATEGORY: string | null;
  JE_SOURCE: string | null;
  PERIOD_NAME: string | null;
  NAME: string | null;
  STATUS: string | null;
  DATE_CREATED: string | null;
  ACTUAL_FLAG: string | null;
  /** The authoritative "when was this funded?" — the module docblock says so. */
  DEFAULT_EFFECTIVE_DATE: string | null;
  ENCUMBRANCE_TYPE_ID: string | null;
  POSTED_DATE: string | null;
  /** Free text, and it contains embedded newlines. Normal whitespace in the cell. */
  DESCRIPTION: string | null;
}

/** One journal line — the 12 columns `JE_LINE_COLUMNS` declares. */
export interface JournalLine {
  JE_HEADER_ID: string | null;
  JE_LINE_NUM: string | null;
  LEDGER_ID: string | null;
  EFFECTIVE_DATE: string | null;
  /** The account. Resolved nowhere on this screen — see the note in the route. */
  CODE_COMBINATION_ID: string | null;
  STATUS: string | null;
  ENTERED_DR: number | null;
  ENTERED_CR: number | null;
  DESCRIPTION: string | null;
  LINE_TYPE_CODE: string | null;
  INVOICE_IDENTIFIER: string | null;
  INVOICE_AMOUNT: number | null;
}

/** What `/{id}/detail` computes over a journal's lines. */
export interface JournalTotals {
  debits: number | null;
  credits: number | null;
  /** `debits − credits`, computed by the server. Never recomputed here. */
  difference: number | null;
}

/** The drill-in payload, exactly as `registerJournalDetail` builds it. */
export interface JournalDetail {
  journal: JournalHeader;
  lines: JournalLine[];
  lineCount: number;
  totals: JournalTotals;
}

/** One row of the accounting calendar, from `/api/coa/periods`. */
export interface PeriodRow {
  PERIOD_SET_NAME: string;
  PERIOD_NAME: string;
  PERIOD_TYPE: string | null;
  PERIOD_YEAR: number;
  PERIOD_NUM: number;
  QUARTER_NUM: number | null;
  START_DATE: string | null;
  END_DATE: string | null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * The ledger's own flags
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * `ACTUAL_FLAG` — the three values the ledger uses, and the only classification of
 * a journal that the table actually carries.
 *
 * ★ WHY THIS AND NOT "ADJUSTMENT VS ORDINARY". `nav/menu.ts` records, on the
 *   sibling leaf `/funding/adjustments`, that *"the split between an adjustment
 *   and an ordinary journal is a classification the screen has to make, not one
 *   the table carries"*. Having read the table, the honest answer is that this
 *   screen does not make that split either: `GL_JE_HEADERS` has no adjustment
 *   column, and the candidates that could be mistaken for one are worse than
 *   nothing — `JE_CATEGORY` holds `"1"`, `"2"`, `"4"`, `"Budget"`, `"Payroll"` and
 *   `"Purchase Invoices"` in the same column, and `NAME` holds free text. Calling
 *   a row an adjustment because its category reads `"2"` would be inventing a
 *   column and then trusting it.
 *
 *   `ACTUAL_FLAG` is real, it is documented in the descriptor (`A`, `B`, or `E`),
 *   and — per the measurement at the top of this file — it is the partition the
 *   row ceiling forces the screen to use anyway. So it is offered as what it is,
 *   and *adjustment* is left to the leaf that owns it.
 */
export const ACTUAL_FLAGS = [
  {
    value: 'A',
    label: 'Actual',
    blurb: 'Posted activity — payroll, payables, the thing that has happened.',
  },
  {
    value: 'B',
    label: 'Budget',
    blurb: 'The budget as it was entered. This is what the Funding section means by a journal.',
  },
  {
    value: 'E',
    label: 'Encumbrance',
    blurb: 'Commitments — a purchase order before the invoice arrives.',
  },
] as const;

/** The flag the screen lands on. See the measurement at the top of this file. */
export const DEFAULT_FLAG = 'B';

/** The ledger's letter, spelled out. An unrecognised value prints itself. */
export function flagLabel(flag: string | null): string {
  if (!flag) return '—';
  return ACTUAL_FLAGS.find((f) => f.value === flag)?.label ?? `Flag ${flag}`;
}

/**
 * `STATUS`, spelled out — but only for the two letters the schema documents.
 *
 * `funding.ts` documents `U` unposted and `P` posted, and those are the only two
 * measured. Anything else prints the raw code rather than being folded into
 * "Unposted", because a third state hidden behind one of two labels is exactly
 * the kind of confident wrong answer this file exists to avoid.
 */
export function statusLabel(status: string | null): string {
  if (status === 'P') return 'Posted';
  if (status === 'U') return 'Unposted';
  return status ?? '—';
}

/* ────────────────────────────────────────────────────────────────────────────
 * Reading
 * ──────────────────────────────────────────────────────────────────────────── */

/** What the register asks the server for. Every field optional; absent means "not narrowed". */
export interface JournalFilters {
  period?: string | null;
  /** Free text. The server searches NAME, DESCRIPTION, PERIOD_NAME, JE_CATEGORY, JE_SOURCE. */
  q?: string | null;
  category?: string | null;
  source?: string | null;
  flag?: string | null;
  status?: string | null;
  /** A column name, `-` prefixed for descending. Names outside the descriptor's list are a 400. */
  sort?: string | null;
  limit?: number;
  offset?: number;
}

/** The register's page size. 200 fits a period comfortably and is well under the server's 500. */
export const JOURNALS_LIMIT = 200;

/** Only the parts that were asked for, in a stable order. */
function encodeQuery(params: Record<string, string | number | null | undefined>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join('&');
}

/**
 * The URL for a register read.
 *
 * ★ EXPORTED SO THE SCREEN'S EMPTY AND REFUSED STATES CAN PRINT THE EXACT REQUEST
 *   THEY CAME FROM. A reader looking at 1,011,459 rows and a ceiling has to be
 *   able to see which filter was *not* applied, and the honest answer is the URL.
 */
export function journalsUrl(f: JournalFilters): string {
  return `/api/funding/journals?${encodeQuery({
    limit: f.limit ?? JOURNALS_LIMIT,
    offset: f.offset ?? 0,
    // ★ THE KEYS ARE THE LOWERCASED COLUMN NAMES. They are case-sensitive and an
    //   uppercase one is dropped silently — see the module docblock.
    period_name: f.period,
    q: f.q,
    je_category: f.category,
    je_source: f.source,
    actual_flag: f.flag,
    status: f.status,
    sort: f.sort,
  })}`;
}

/** A register page: the rows, the counts beside them, and the statements that produced them. */
export interface JournalPage extends Page {
  rows: JournalHeader[];
  sql: SqlTrace | null;
}

export async function loadJournals(f: JournalFilters, signal: AbortSignal): Promise<JournalPage> {
  const body = await getJson<Envelope<JournalHeader>>(journalsUrl(f), signal);
  const rows = Array.isArray(body.data) ? body.data : [];
  const page = body.page ?? { limit: 0, offset: 0, total: rows.length, returned: rows.length };
  return { ...page, rows, sql: readTrace(body) };
}

/**
 * How many journals one `ACTUAL_FLAG` value holds.
 *
 * ★ THE REFUSAL IS SWALLOWED HERE, ON PURPOSE, AND THE RESULT IS `null`.
 *
 *   This count is a courtesy printed on a control — it labels the flag with how
 *   much is behind it, so a reader can see that `E` is four times the size of `B`
 *   before choosing one. It is *not* the page. A flag whose count cannot be read
 *   (over the ceiling if the ledger grows, or a store that is briefly down) must
 *   still be selectable and must still be able to produce a page, so the failure
 *   path returns "no count" rather than an error the screen would have to render
 *   somewhere. The one thing an abort is not is a failure, so that is re-thrown.
 */
export async function loadFlagCount(flag: string, signal: AbortSignal): Promise<number | null> {
  try {
    const page = await loadJournals({ flag, limit: 1 }, signal);
    return page.total;
  } catch (err) {
    if (isAbort(err)) throw err;
    return null;
  }
}

/** All three flag counts at once. Never rejects — see `loadFlagCount`. */
export async function loadFlagCounts(signal: AbortSignal): Promise<Record<string, number | null>> {
  const counts = await Promise.all(ACTUAL_FLAGS.map((f) => loadFlagCount(f.value, signal)));
  const out: Record<string, number | null> = {};
  ACTUAL_FLAGS.forEach((f, i) => {
    out[f.value] = counts[i] ?? null;
  });
  return out;
}

/**
 * The accounting calendar, newest first.
 *
 * The descriptor's `defaultSort` is `PERIOD_YEAR DESC, PERIOD_NUM DESC,
 * PERIOD_SET_NAME ASC, PERIOD_NAME ASC`, which is the order the picker wants, so
 * no `sort` is passed. `GL_PERIODS` is small (one row per period, forty-odd per
 * decade) and nowhere near the ceiling.
 *
 * ★ MEASURED, AND IT IS WHY THE PERIOD IS NOT THE DEFAULT CONTROL: the newest
 *   periods on this calendar are *ahead of the journals*. `Adj-27-FY-27` and
 *   `Jun-27-FY-27` both hold zero journals — the calendar is provisioned into
 *   FY2027 and posting has reached Aug-26. A picker that defaulted to "the newest
 *   period" would land on an empty table and offer no clue that the emptiness is
 *   a fact about the calendar rather than about the ledger.
 */
export async function loadPeriods(signal: AbortSignal): Promise<PeriodRow[]> {
  const body = await getJson<Envelope<PeriodRow>>('/api/coa/periods?limit=200', signal);
  return Array.isArray(body.data) ? body.data : [];
}

/**
 * One period's own reading of itself.
 *
 * `PERIOD_NUM` 13 is the adjustment period — measured: `Adj-98-FY-98` carries
 * `PERIOD_NUM: 13`, `PERIOD_TYPE: "1"`. The number is used rather than the
 * `Adj-` prefix in the name, because the name is the display string and the
 * number is the structural fact; a calendar named `Period 13` would defeat a
 * prefix test.
 */
export function isAdjustmentPeriod(period: PeriodRow): boolean {
  return period.PERIOD_NUM > 12;
}

/** Periods grouped by fiscal year, newest year first — what an `<optgroup>` per year needs. */
export function groupPeriods(periods: PeriodRow[]): { year: number; periods: PeriodRow[] }[] {
  const byYear = new Map<number, PeriodRow[]>();
  for (const p of periods) {
    const list = byYear.get(p.PERIOD_YEAR);
    if (list) list.push(p);
    else byYear.set(p.PERIOD_YEAR, [p]);
  }
  return [...byYear.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, list]) => ({ year, periods: list }));
}

/** One journal, its lines and its totals. One request, server-side, with no id comparison. */
export async function loadJournalDetail(id: string, signal: AbortSignal): Promise<JournalDetail> {
  const body = await getJson<Single<JournalDetail>>(
    `/api/funding/journals/${encodeURIComponent(id)}/detail`,
    signal,
  );
  return body.data;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Reading what came back
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * A dash for an absent figure.
 *
 * ★ `Number(null)` IS `0`, so a blank money cell needs this rather than a
 *   fallback inside the formatter: `money(null)` would render `0.00` and turn
 *   "the ledger does not answer this" into "the answer is zero".
 */
export function moneyOrDash(value: number | null | undefined, format: (n: number) => string = fmtMoney): string {
  return value === null || value === undefined ? '—' : format(value);
}

/** What the server's two totals say about each other. */
export interface Balance {
  debits: number | null;
  credits: number | null;
  difference: number | null;
  /** True only when a difference was actually reported and it is zero. */
  balanced: boolean;
}

/**
 * The verdict on a journal, such that it *reports* rather than *asserts*.
 *
 * ★ THREE STATES, NOT TWO. A journal whose totals could not be read is neither
 *   balanced nor out by an amount, and folding it into either would be a claim
 *   about the ledger made from a missing number. `difference === null` therefore
 *   leaves `balanced` false and the screen says "not reported" — which is a third
 *   sentence, not a synonym for "unbalanced".
 */
export function balanceOf(totals: JournalTotals | null | undefined): Balance {
  const debits = totals?.debits ?? null;
  const credits = totals?.credits ?? null;
  const difference = totals?.difference ?? null;
  return {
    debits,
    credits,
    difference,
    balanced: difference !== null && Math.abs(difference) < 0.005,
  };
}

/** Is the page showing fewer rows than the register holds? Drives the disclosure note. */
export function truncationOf(page: Page, what: string): string | null {
  if (page.total <= page.returned) return null;
  return (
    `${what} holds ${page.total.toLocaleString('en-US')} journals and this page is showing ` +
    `${page.returned.toLocaleString('en-US')} of them. Every figure below describes the rows shown.`
  );
}

/** A stable date, or a dash. The ledger's dates arrive as ISO strings or not at all. */
export function dayOrDash(value: string | null | undefined): string {
  if (!value) return '—';
  const day = value.slice(0, 10);
  return day || '—';
}

/* ────────────────────────────────────────────────────────────────────────────
 * CSV
 * ──────────────────────────────────────────────────────────────────────────── */

/** One CSV cell, quoted only when it has to be. The idiom every export here uses. */
export function csvCell(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * The rows on screen, as a CSV, built in the browser.
 *
 * ★ THE DESCRIPTION IS THE REASON THIS IS NOT A ONE-LINER. It carries embedded
 *   newlines, so a row that is flattened without quoting becomes two rows in every
 *   spreadsheet that opens it — the file looks fine and the column count is wrong
 *   from that line onward. `csvCell` quotes on `\r\n` as well as on a comma for
 *   exactly this reason, and the rows are joined with `\r\n` (RFC 4180) so a
 *   quoted newline is the only kind of newline inside a record.
 */
export function journalsCsv(rows: JournalHeader[]): string {
  const header = [
    'Journal',
    'Period',
    'Effective',
    'Flag',
    'Category',
    'Source',
    'Status',
    'Name',
    'Description',
    'Created',
    'Posted',
    'Encumbrance type',
  ];
  const body = rows.map((r) => [
    r.JE_HEADER_ID,
    r.PERIOD_NAME,
    dayOrDash(r.DEFAULT_EFFECTIVE_DATE),
    flagLabel(r.ACTUAL_FLAG),
    r.JE_CATEGORY,
    r.JE_SOURCE,
    statusLabel(r.STATUS),
    r.NAME,
    r.DESCRIPTION,
    dayOrDash(r.DATE_CREATED),
    dayOrDash(r.POSTED_DATE),
    r.ENCUMBRANCE_TYPE_ID,
  ]);
  return [header, ...body].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/** A journal's name on one line, for a title attribute, a pin and a heading. */
export function journalTitle(row: JournalHeader): string {
  const name = (row.NAME ?? '').replace(/\s+/g, ' ').trim();
  return name || `Journal ${row.JE_HEADER_ID}`;
}

/**
 * A set of distinct values, in the order they were first seen, with counts.
 *
 * Used for the category and source facets. ★ IT IS BUILT FROM THE ROWS ON SCREEN,
 * NOT FROM A VOCABULARY WRITTEN HERE, because there is no vocabulary to write:
 * `JE_CATEGORY` holds `"1"`, `"2"`, `"4"`, `"Budget"`, `"Payroll"` and
 * `"Purchase Invoices"` in the same column, on the same ledger. The options are
 * labelled for what they are — the values seen on this page — and choosing one
 * sends it back to the server as an exact match, so the value is never a guess
 * this app made.
 */
export function observed(values: (string | null)[], limit = 40): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const v of values) {
    if (v === null || v === '') continue;
    if (!counts.has(v)) order.push(v);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return order
    .slice(0, limit)
    .map((value) => ({ value, count: counts.get(value) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}

/* ────────────────────────────────────────────────────────────────────────────
 * The other direction — one account, and the journals that hit it
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * One posting to one account: a `GL_JE_LINES` row joined to the header it belongs to.
 *
 * ★ THIS IS NOT `JournalLine` WITH MORE FIELDS ON IT, AND THE TWO ARE NOT
 *   INTERCHANGEABLE. `JournalLine` is the line as the *journal* sees it: it carries
 *   a header id and a `CODE_COMBINATION_ID` and nothing about the journal, because
 *   on that screen every line already belongs to the journal above it. This is the
 *   line as the *account* sees it — Oracle's Account Inquiry → Journals — where a
 *   dozen different journals share one list and every row therefore has to carry
 *   its own journal's name, source, period and balance type. The server
 *   denormalises those onto each row for exactly that reason, and
 *   `CODE_COMBINATION_ID` is the constant the whole list is about rather than a
 *   field anyone reads.
 */
export interface AccountJournalRow {
  JE_HEADER_ID: string;
  JE_LINE_NUM: string;
  LEDGER_ID: string;
  CODE_COMBINATION_ID: string;
  EFFECTIVE_DATE: string | null;
  ENTERED_DR: number | null;
  ENTERED_CR: number | null;
  /** The journal's free-text name — Oracle's *Journal Entry* column. */
  HEADER_NAME: string | null;
  JE_SOURCE: string | null;
  JE_CATEGORY: string | null;
  PERIOD_NAME: string | null;
  ACTUAL_FLAG: string | null;
  DEFAULT_EFFECTIVE_DATE: string | null;
  POSTED_DATE: string | null;
  ENCUMBRANCE_TYPE_ID: string | null;
  HEADER_STATUS: string | null;
  LINE_STATUS: string | null;
  LINE_DESCRIPTION: string | null;
  LINE_PERIOD_NAME: string | null;
  LINE_TYPE_CODE: string | null;
  INVOICE_IDENTIFIER: string | null;
  INVOICE_AMOUNT: number | null;
}

/**
 * One balance type's share of an account: how many lines, and what they moved.
 *
 * The server returns all three of these whether or not the read is filtered to
 * one, so the control that chooses between them is built from the same numbers as
 * the rows — the count on a button is never a separately-fetched figure that could
 * disagree with what the button then shows.
 */
export interface AccountJournalSplit {
  value: string;
  lines: number;
  debits: number;
  credits: number;
}

/** The chart-of-accounts row for the account being read, when the extract has one. */
export interface AccountJournalAccount {
  CODE_COMBINATION_ID: string;
  SEGMENT1: string | null;
  SEGMENT2: string | null;
  SEGMENT3: string | null;
  SEGMENT4: string | null;
  SEGMENT5: string | null;
  SEGMENT6: string | null;
  SEGMENT7: string | null;
  ACCOUNT_TYPE: string | null;
  ENABLED_FLAG: string | null;
  SUMMARY_FLAG: string | null;
}

/** One account's postings, with the balance-type split and the filtered totals. */
export interface AccountJournals {
  account: AccountJournalAccount | null;
  rows: AccountJournalRow[];
  /** Length of `rows` — the window, not the account. */
  lineCount: number;
  /** Lines this account has under the current filter, counted live. */
  total: number;
  limit: number;
  offset: number;
  /** Over every filtered line, not just the page. */
  totals: JournalTotals;
  flags: AccountJournalSplit[];
}

/**
 * The `CODE_COMBINATION_ID` behind a seven-segment combination key.
 *
 * ★ THE DRAWER'S COMBINATIONS COME FROM THE PURCHASE-ORDER EXTRACT, WHICH CARRIES
 *   THE SEVEN SEGMENTS AND NOT THE SURROGATE KEY. Journal lines are keyed by
 *   `CODE_COMBINATION_ID`, so crossing from one to the other takes one lookup — and
 *   that lookup is worth doing anyway, because it also answers a question the panel
 *   should be able to state: whether the chart of accounts knows this combination
 *   at all.
 *
 * ★ `null` MEANS TWO DIFFERENT THINGS AND THE CALLER MUST SAY WHICH IT SAW: no chart
 *   row for these seven segments, or more than one. The second would mean the
 *   segments are not a key, and returning the first of several would be a guess
 *   dressed as a fact — so the answer is withheld and the panel says so.
 */
export async function loadCombinationId(key: string, signal: AbortSignal): Promise<string | null> {
  const segments = key.split('-');
  if (segments.length !== 7) return null;
  const body = await getJson<Envelope<{ CODE_COMBINATION_ID: string | number | null }>>(
    `/api/coa/combinations?${encodeQuery({
      // ★ THE KEYS ARE THE PARAMETER NAMES THE ROUTE DECLARES — `fund`, `cost_center`,
      //   `future` — not the column names. They are lowercased column names only
      //   where the two happen to agree.
      fund: segments[0],
      purpose: segments[1],
      program: segments[2],
      object: segments[3],
      level: segments[4],
      cost_center: segments[5],
      future: segments[6],
      limit: 2,
    })}`,
    signal,
  );
  const found = Array.isArray(body.data) ? body.data : [];
  if (found.length !== 1) return null;
  const id = found[0]?.CODE_COMBINATION_ID;
  return id === undefined || id === null || id === '' ? null : String(id).trim();
}

/**
 * The journals that hit one account, newest action date first.
 *
 * ★ THE BALANCE TYPE IS FILTERED SERVER-SIDE, WHICH IS THE WHOLE REASON THIS IS ONE
 *   REQUEST AND NOT TWO. The account lives on `GL_JE_LINES` and `ACTUAL_FLAG` on
 *   `GL_JE_HEADERS`, so a client that had the lines and the journals separately
 *   could not answer *this account, budget journals only* without pulling both
 *   halves in full. The join is the filter.
 */
export async function loadAccountJournals(
  ccid: string,
  options: { flag?: string | null; limit?: number; offset?: number },
  signal: AbortSignal,
): Promise<AccountJournals> {
  const limit = options.limit ?? JOURNALS_LIMIT;
  const offset = options.offset ?? 0;
  const body = await getJson<Single<AccountJournals>>(
    `/api/funding/accounts/${encodeURIComponent(ccid)}/journals?${encodeQuery({
      actual_flag: options.flag ?? null,
      limit,
      offset,
    })}`,
    signal,
  );
  const data = body.data;
  return {
    account: data?.account ?? null,
    rows: Array.isArray(data?.rows) ? data.rows : [],
    lineCount: data?.lineCount ?? 0,
    total: data?.total ?? 0,
    limit: data?.limit ?? limit,
    offset: data?.offset ?? offset,
    totals: data?.totals ?? { debits: 0, credits: 0, difference: 0 },
    flags: Array.isArray(data?.flags) ? data.flags : [],
  };
}
