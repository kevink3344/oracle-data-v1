import type { Transaction } from '@libsql/client';
import { db, storeDriver } from './client.js';
import type { Args, Bind, Row } from './driver.js';
import type { StoreId } from './store.js';
import { AppError } from '../http/errors.js';

export type { Args, Bind, Binds, Row } from './driver.js';

/**
 * Query helpers.
 *
 * The rule this file exists to enforce: **values are always bound, identifiers
 * are always allowlisted.** A table or column name can never be interpolated
 * from a request, because SQLite cannot bind an identifier — so every place that
 * needs a dynamic name routes it through `ident()` against a list the resource
 * descriptor declares. `quoteIdent` is then belt-and-braces on top.
 *
 * ★ This file is backend-agnostic on purpose. It talks to `db` (the driver seam
 *   in `driver.ts`) and never to a specific database, which is what makes
 *   `DB_MODE=oracle` a change in one factory rather than in every route. The two
 *   dialect leaks that remain are deliberate and marked: the SQLite-flavoured
 *   `?` binds, which the Oracle driver rewrites, and `withTransaction`, which
 *   Oracle refuses because the account holds no write privilege.
 */

export async function rows<T = Row>(sql: string, args: Args = []): Promise<T[]> {
  const res = await db.execute({ sql, args });
  return res.rows as unknown as T[];
}

export async function one<T = Row>(sql: string, args: Args = []): Promise<T | null> {
  const res = await db.execute({ sql, args });
  return (res.rows[0] as unknown as T | undefined) ?? null;
}

/**
 * `COUNT(*)`, `SUM(...)`, and friends.
 *
 * A missing row yields 0, which is what an aggregate over no rows actually
 * means — this is deliberately different from "the query failed", which throws.
 * The two must stay distinguishable: a swallowed error that also returned 0 once
 * produced a fake −100% delta in this project's history, and the whole reason a
 * failed query is allowed to throw here is so that cannot recur.
 */
export async function scalar(sql: string, args: Args = []): Promise<number> {
  const row = await one<Record<string, unknown>>(sql, args);
  if (!row) return 0;
  return toNumber(Object.values(row)[0]);
}

/** Sum that keeps `null` distinct from `0` — for "no rows" vs "rows summing to zero". */
export async function scalarOrNull(sql: string, args: Args = []): Promise<number | null> {
  const row = await one<Record<string, unknown>>(sql, args);
  if (!row) return null;
  const v = Object.values(row)[0];
  if (v === null || v === undefined) return null;
  return toNumber(v);
}

/**
 * Read one *named* number out of a row that holds several aggregates.
 *
 * `row?.total ?? 0` is the idiom that has already produced a false "the table is
 * empty" in this project, and the reason is that a missing row and a true zero
 * are different answers where only one of them is right. `scalar()` cannot help
 * here because it reads the first column only; a summary shaped as
 * `SELECT (SELECT COUNT(*) …) AS a, (SELECT SUM(…) …) AS b, …` needs a named read,
 * and this is the one that refuses to invent a value.
 *
 * Deliberately stricter than `toNumber`: an aggregate that came back as a string,
 * a blob or nothing at all is an internal fault, not a zero, and it raises as one
 * rather than being quietly rounded into a number a caller would believe.
 */
export function columnNumber(row: Record<string, unknown> | null | undefined, key: string): number {
  const value = row?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new AppError(
    500,
    'INTERNAL',
    `The database returned ${JSON.stringify(value ?? null)} for "${key}", which is not a finite number.`,
  );
}

/** Narrow an unknown column value to a finite number, treating anything else as 0. */
function toNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export interface WriteResult {
  rowsAffected: number;
  lastInsertRowid: number | null;
}

export async function execute(sql: string, args: Args = []): Promise<WriteResult> {
  const res = await db.execute({ sql, args });
  return {
    rowsAffected: res.rowsAffected,
    lastInsertRowid: res.lastInsertRowid,
  };
}

/**
 * Run several statements atomically.
 *
 * ★ The callback MUST throw to roll back. If it returns normally the transaction
 *   commits — a `throw` placed *after* the call returns does not undo anything,
 *   because by then the commit has already happened. Every caller here is
 *   written to validate inside `fn`, never after it.
 *
 * ★ There are currently NO callers. It is kept because deleting it would remove
 *   the one place that documents the throw-inside-`fn` rule that already cost
 *   this project a probe writing to a live row. Under Oracle it throws on
 *   principle: every grant on the account is SELECT, so there is no write
 *   transaction to open.
 */
export async function withTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  const tx = await db.transaction();
  try {
    const result = await fn(tx);
    await tx.commit();
    return result;
  } catch (e) {
    try {
      await tx.rollback();
    } catch {
      /* A failed rollback must not mask the original error. */
    }
    throw e;
  }
}

/**
 * Convert a request value into something the driver will accept as a bind.
 *
 * libSQL takes `string | number | bigint | ArrayBuffer | null` and nothing else.
 * A boolean or a `Date` reaching `args` produces a runtime throw from the driver
 * rather than a validation message, so the conversion happens here where it can
 * be deliberate: a boolean becomes 0/1, and a Date becomes an ISO string (the
 * sample stores dates as text, and a `Date` serialised by the driver would
 * arrive as a UTC instant that compares wrong against `YYYY-MM-DD`).
 *
 * ★ The boolean→0/1 rule is a **SQLite-shaped answer** and is the one place a
 *   caller can quietly do the wrong thing on Oracle: EBS flag columns hold
 *   `'Y'`/`'N'`, so `ENABLED_FLAG = 0` matches nothing and returns an empty
 *   result that looks like "no data". Under `DB_MODE=oracle`, compare flags to
 *   the character in the SQL rather than binding a boolean here.
 */
export function bindable(value: unknown): Bind {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return value;
  throw AppError.badRequest(
    `Cannot store a value of type ${Array.isArray(value) ? 'array' : typeof value}.`,
    { valueType: Array.isArray(value) ? 'array' : typeof value },
  );
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

/**
 * Quote an identifier in the ledger's dialect.
 *
 * ★★ MYSQL USES BACKTICKS, AND THIS IS NOT COSMETIC — IT IS A SYNTAX ERROR.
 *    SQLite, Oracle and SQL Server all accept `"name"` as an identifier quote.
 *    **MySQL does not**: with the stock `sql_mode` (no `ANSI_QUOTES`), `"name"`
 *    is a STRING LITERAL. So
 *
 *        SELECT * FROM "FND_FLEX_VALUES_TL" LIMIT 1
 *
 *    reads as "select from the string literal `FND_FLEX_VALUES_TL`", which is
 *    not valid SQL — MySQL answers
 *    `You have an error in your SQL syntax … near '"FND_FLEX_VALUES_TL" LIMIT 1'`.
 *
 *    Measured on 8.0.46 through the app's own seam: every object in the row-count
 *    pass failed this way, so `/api/meta/ledger-summary` returned 200 with
 *    `rowCount: null` on all 55 objects and the sign-in screen read
 *    `55 objects, 0 rows`. **The failure was silent at the API level** — one
 *    `console.warn` per object and a null count, which the client renders as
 *    "not counted" rather than as an error.
 *
 * ★ THE DRIVER CANNOT FIX THIS, WHICH IS WHY IT LIVES HERE. A rewrite would have
 *   to tell an identifier from a string literal, and `"FND_FLEX_VALUES_TL"` is
 *   exactly the same token sequence in both roles. This is the same reasoning
 *   `concatOp()` below records for `||` vs `+`: the dialect is chosen where the
 *   intent is known, not guessed at in a scanner.
 *
 * ★ `ANSI_QUOTES` IS THE TEMPTING FIX AND IT IS NOT USED. Appending it to the
 *   session `sql_mode` would make `"name"` an identifier — and would break every
 *   query that legitimately uses a double-quoted string literal, turning a
 *   correct value into a column reference. The driver already refuses to loosen
 *   server modes for this class of reason; see `applySessionMode()` in `mysql.ts`.
 *
 * The escaping doubles the quote character, which is `""` for the standard arms
 * and ` `` ` for MySQL.
 *
 * ★ THE STORE IS A SECOND ENTRY POINT, NOT A PARAMETER — AND `.map()` IS WHY. Which
 *   quote character is correct is a property of the DIALECT OF THE STORE THE TABLE IS
 *   IN, and `saved_view`, `ledger_read_cap` and `field_override` are app tables.
 *   Quoting an app table for the ledger's dialect is right only while the two stores
 *   happen to be the same engine, which is the shipped configuration (`APP_DB_URL`
 *   unset) and not a property worth relying on. It is a second FUNCTION rather than an
 *   optional second argument because five call sites pass this straight to `Array.map`,
 *   where a second parameter silently receives the INDEX — `storeDriver(3)` — and only
 *   `tsc` would have caught it. The single-argument form is unchanged for them.
 */
export function quoteIdent(name: string): string {
  return quoteAs(storeDriver('ledger').dialect, name);
}

/**
 * The same quoting, for a table that lives in the named store.
 *
 * `saved_view` is the caller that needed it: the column is called `sql`, which is a
 * MySQL reserved word, and the table is in the app store.
 */
export function quoteIdentFor(store: StoreId, name: string): string {
  return quoteAs(storeDriver(store).dialect, name);
}

/** The escaping doubles the quote character: a backtick for MySQL, a double quote for the rest. */
function quoteAs(dialect: string, name: string): string {
  if (dialect === 'mysql') return `\`${name.replace(/`/g, '``')}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * ★★ THE ONE CONCATENATION OPERATOR, SPELLED PER DIALECT — AND WHY IT IS NOT IN
 *    THE DRIVER.
 *
 * The seven Oracle segments are joined into one dotted account key in three
 * queries (`coa.ts`, `spend.ts` and the funding SQL file). SQLite and Oracle
 * both spell that `||`; **T-SQL spells it `+`** and has no `||` at all.
 *
 * ★ THE DRIVER CANNOT REWRITE THIS, AND THAT IS THE POINT OF IT LIVING HERE.
 *   `sqlserver.ts` rewrites `LIMIT`, `IFNULL` and `?`, and it deliberately does
 *   NOT touch `||` — because `+` is *also* numeric addition, and `'a' || 'b'`
 *   and `1 + 2` are the same three tokens to any scanner. A blanket rewrite
 *   would have to guess the operand types, and guessing wrong turns a
 *   concatenation into arithmetic **silently**: `SEGMENT1 + SEGMENT2` on two
 *   numeric segment values returns their sum, not their concatenation, and the
 *   account key is then a plausible-looking wrong number rather than an error.
 *
 *   So the operator is chosen where the intent is visible — at the query — and
 *   this helper is what makes that a one-word change per site instead of a
 *   dialect branch in each of them.
 *
 * ★ `CONCAT` IS THE TEMPTING PORTABLE ANSWER AND IT IS NOT USED. SQL Server's
 *   `CONCAT` exists and Oracle's does too, but SQLite's does not (it is a
 *   compile-time option), so it would move the problem rather than solve it —
 *   and `CONCAT` in SQL Server treats `NULL` as an empty string where `||`
 *   propagates it, so the three dialects would disagree about a null segment.
 *   `||` and `+` at least agree: both propagate `NULL`, which is the correct
 *   answer for an account key with a missing segment.
 */
export function concatOp(): '||' | '+' {
  return storeDriver('ledger').dialect === 'sqlserver' ? '+' : '||';
}

/**
 * Join expressions into one string, in the dialect of the ledger.
 *
 * `separator` is the literal placed between them — `'.'` for the account key —
 * and it is quoted here rather than at the call site so the escaping lives in
 * one place.
 */
export function concatExpr(parts: readonly string[], separator?: string): string {
  const op = concatOp();
  const pieces = separator === undefined ? [...parts] : parts.flatMap((p, i) => (i === 0 ? [p] : [`'${separator.replace(/'/g, "''")}'`, p]));
  return pieces.join(` ${op} `);
}

/**
 * Resolve a request-supplied identifier against an allowlist.
 *
 * Returns a quoted, safe fragment or throws. The allowlist is the security
 * control; the quoting means that even a mistake in an allowlist cannot break
 * out of the identifier position.
 */
export function ident(name: string, allowed: readonly string[], what = 'field'): string {
  const found = allowed.find((a) => a.toLowerCase() === name.trim().toLowerCase());
  if (!found) {
    throw AppError.badRequest(
      `Unknown ${what} "${name}". Allowed: ${allowed.join(', ')}.`,
      { allowed },
    );
  }
  return quoteIdent(found);
}

// ---------------------------------------------------------------------------
// Search, sort, paginate
// ---------------------------------------------------------------------------

/**
 * Build a `LIKE` pattern with the user's own wildcards neutralised.
 *
 * Without this, a search for "50%" silently matches everything, and a search for
 * "_" matches any single character — the term stops meaning what the user typed.
 */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function likeClause(columns: readonly string[], term: string, bindPrefix = 'q'): { sql: string; args: Record<string, unknown> } {
  const args: Record<string, unknown> = {};
  const clauses = columns.map((col, i) => {
    const key = `${bindPrefix}${i}`;
    args[key] = likePattern(term);
    return `${quoteIdent(col)} LIKE :${key} ESCAPE '\\'`;
  });
  return { sql: `(${clauses.join(' OR ')})`, args };
}

export type SortDirection = 'asc' | 'desc';

export interface Sort {
  column: string;
  direction: SortDirection;
}

/**
 * Parse `?sort=column,-other` into an ordered list, rejecting anything not
 * allowlisted. `-` prefixes descending, matching the convention the frontend
 * already uses for its table headers.
 */
export function parseSort(raw: string | undefined, sortable: readonly string[]): Sort[] {
  if (!raw) return [];
  const out: Sort[] = [];
  for (const part of raw.split(',')) {
    const token = part.trim();
    if (!token) continue;
    const descending = token.startsWith('-');
    const name = descending ? token.slice(1) : token;
    const found = sortable.find((s) => s.toLowerCase() === name.toLowerCase());
    if (!found) {
      throw AppError.badRequest(`Cannot sort by "${name}".`, { sortable });
    }
    out.push({ column: found, direction: descending ? 'desc' : 'asc' });
  }
  return out;
}

export function orderByClause(sorts: readonly Sort[], fallback: string): string {
  if (sorts.length === 0) return `ORDER BY ${fallback}`;
  const parts = sorts.map((s) => `${quoteIdent(s.column)} ${s.direction === 'desc' ? 'DESC' : 'ASC'}`);
  return `ORDER BY ${parts.join(', ')}`;
}

/** `NULLS LAST` has no portable form in SQLite, so it is done with a CASE. */
export function nullsLast(column: string): string {
  return `CASE WHEN ${quoteIdent(column)} IS NULL THEN 1 ELSE 0 END`;
}

export interface Pagination {
  limit: number;
  offset: number;
}

export interface PageMeta extends Pagination {
  total: number;
  returned: number;
}

export function pageMeta(p: Pagination, total: number, returned: number): PageMeta {
  return { ...p, total, returned };
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * The SQL expression that stamps a `TEXT`/`NVARCHAR` timestamp column, per dialect.
 *
 * ★★ THIS EXISTS BECAUSE `datetime('now')` IS NOT SQL, IT IS SQLITE — and it was
 *    reaching SQL Server for as long as this application has had a second arm.
 *    Measured on the live database, twice and independently (once through the raw
 *    `mssql` driver, once through this server's own `storeDriver('app')`):
 *
 *      SELECT datetime('now') AS t
 *      → 'datetime' is not a recognized built-in function name.
 *
 *    The string is written in five route files (`activity.ts`, `customFields.ts`,
 *    `organizations.ts`, `projectRegistry.ts`, `views.ts`), and the SQL Server
 *    rewriter in `sqlserver.ts` does **not** translate it: that walker rewrites
 *    `TO_CHAR`/`TO_DATE` and the placeholder style, and nothing else. So a write
 *    carrying it fails on the `sqlserver` arm, and the failure is a 500 naming a
 *    function rather than a column.
 *
 * ★ THE TWO FORMS ARE NOT THE SAME STRING, AND THAT IS THE ONE THING TO GET RIGHT.
 *    SQLite's `datetime('now')` produces `2026-09-26 10:55:07` — space-separated,
 *    UTC, no fraction. The style-126 spelling that most of this schema's DDL
 *    declares produces `2026-09-26T10:55:07` — **T**-separated. Both parse as dates
 *    and neither is wrong, but they are different *strings*, and everything that
 *    compares these columns compares text: a `T` sorts after a space at position
 *    11, so a mixed table orders by an accident of which arm wrote each row.
 *
 *    Style **120** is therefore the spelling used here, because it is the one the
 *    stored rows actually carry. Measured over the live `dbo.project`: all fifteen
 *    rows answer `2026-09-19 13:05:47`-shaped, none contains a `T` — even though the
 *    table's own `DEFAULT` is style 126. The defaults of the existing rows were
 *    never exercised because those rows were written by the SQLite arm before the
 *    portfolio moved to SQL Server, so **the divergence is latent and this
 *    function's job is not to make it worse.** See the note in
 *    `data/sql/sqlserver/01-app.sql` beside the new `background_updated_at`.
 *
 * ★ NOT A PARAMETER, A FRAGMENT. This returns SQL text to be interpolated into a
 *    statement, so it takes no arguments and binds nothing. It reads the **app**
 *    store's dialect, because every caller updates a table the app owns; the Oracle
 *    arm keeps the SQLite spelling on purpose, since the oracle driver's own date
 *    handling is a separate question and changing it here would be an unmeasured
 *    claim about a database this function has never been pointed at.
 *
 * ★★ MYSQL WAS ADDED AFTER A LIVE 500, AND THE SYMPTOM IS WORTH RECORDING. A MySQL
 *    deployment saving a custom field value answered
 *    `You have an error in your SQL syntax … near 'now')` — because this function had
 *    no `mysql` arm and fell through to the SQLite spelling, which reached the server.
 *    The MySQL spelling is `UTC_TIMESTAMP()`, chosen for the same two reasons the
 *    T-SQL arm is style 120: it is UTC, and it is space-separated, so a row it writes
 *    sorts and compares beside a row SQLite wrote.
 */
export function stampNow(): string {
  const dialect = storeDriver('app').dialect;
  if (dialect === 'sqlserver') return 'CONVERT(varchar(19), GETUTCDATE(), 120)';
  // ★ MYSQL IS THE THIRD ARM, AND IT IS NOT A FALLTHROUGH. MySQL has no
  //   `datetime('now')` at all and answers it with a parse error naming the
  //   function — the same class of 500 the T-SQL arm produced above, and the one
  //   that reached a user. `UTC_TIMESTAMP()` is the native spelling, and it is BOTH
  //   UTC and space-separated (`2026-10-03 14:33:07`), which is exactly what
  //   `data/sql/mysql/01-app.sql` declares as these columns' DEFAULT. `NOW()` is the
  //   session's timezone and is deliberately not used.
  if (dialect === 'mysql') return 'UTC_TIMESTAMP()';
  return "datetime('now')";
}
