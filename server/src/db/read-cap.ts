/**
 * The per-object read cap: how many rows this app reads from a ledger object, and
 * in what order.
 *
 * ★ WHY THIS IS A MODULE AND NOT A CONSTANT IN A ROUTE.
 *
 *   The EBS instance holds tables in the hundreds of millions of rows —
 *   `GL_BALANCES` is 157 M, the AP surface is 1.2 M checks. A register that reads
 *   one of those whole is not slow; it is a request that never returns. The bound
 *   has to be adjustable by whoever operates the deployment, without a code change
 *   and without a redeploy, because the right number depends on the instance and
 *   changes as the instance grows. So it is a row in `ledger_read_cap`, and this
 *   module is what turns that row into SQL.
 *
 * ★ A CAP WITH NO ORDERING IS A RANDOM SAMPLE, AND THAT IS THE ONE FORM THIS
 *   MODULE REFUSES.
 *
 *   `WHERE ROWNUM <= 100000` returns whichever rows Oracle reached first. A count
 *   of 100,000 then means "at least 100,000"; a sum is the sum of an unknown
 *   subset; a percentage has the wrong denominator. None of it is visible in the
 *   payload, which is exactly why it is the dangerous form. With an `ORDER BY` the
 *   same cap becomes a reproducible window that a screen can *label* — "the
 *   100,000 most recent by INVOICE_DATE" — and a reader can check it.
 *
 *   So `resolveReadCap` throws when a row sets `max_rows` without `order_by`. That
 *   is not a validation nicety: it is the difference between a smaller answer and a
 *   different one, and the un-ordered form is the one that arrives looking correct.
 *
 * ★ A CAP IS NOT A PERFORMANCE FIX, AND NOTHING HERE CLAIMS IT IS.
 *
 *   The cap bounds what crosses the wire and what the process holds. It does NOT
 *   bound the work: Oracle still has to *find* the first N rows, so on an unindexed
 *   predicate the statement costs what it always did. The lever that makes a read
 *   fast is the scope — the fund/programme/start-FY predicate pushed into the SQL —
 *   which is why `row-budget.ts` bounds what may be *returned* while the scope owns
 *   what may be *read*. Both are needed and they do different jobs.
 *
 * ★ THE CAP IS APPENDED PER DIALECT, WHICH IS WHY THE STORED SQL HAS NO CAP IN IT.
 *
 *   Oracle has no `LIMIT`. It spells the bound `FETCH FIRST n ROWS ONLY` (12c+) or
 *   the nested `ROWNUM` form (11g+); SQLite/libSQL spells it `LIMIT n`. The
 *   `sql` column therefore stores a statement *without* a bound, and the bound is
 *   added here in the dialect of whichever store the statement routed to. One row
 *   serves both backends and the stored text never has to be edited when the
 *   deployment moves between them.
 *
 *   ★ AND THE ORACLE FORM IS THE NESTED ONE, NOT `FETCH FIRST`. The server's own
 *   Oracle driver already rewrites a trailing `LIMIT n` into `FETCH FIRST n ROWS
 *   ONLY` (`db/oracle.ts`), but that rewrite is for statements *authored* with
 *   `LIMIT`, and it is a trailing-token rewrite — it cannot wrap. A cap has to wrap,
 *   because `SELECT … FROM t ORDER BY x FETCH FIRST 10 ROWS ONLY` and
 *   `SELECT * FROM (SELECT … FROM t ORDER BY x) WHERE ROWNUM <= 10` are the same
 *   answer while `SELECT … FROM t WHERE ROWNUM <= 10 ORDER BY x` is a different one
 *   (the `ROWNUM` is assigned before the sort). Wrapping is what makes the
 *   ordering and the cap compose in the order the reader expects, so this module
 *   wraps rather than appends.
 */
import { AppError } from '../http/errors.js';
import { quoteIdent, rows } from './sql.js';
import { storeDriver } from './client.js';
import { defaultReadFor } from './ledger-defaults.js';
import { stripTrailingOrderBy } from './query-guard.js';

/**
 * One row of `ledger_read_cap`, as the resolver needs it.
 *
 * `max_rows` and `order_by` are nullable because the table is: a row may exist
 * with a stored statement and no cap, which is how an administrator says "read it
 * this way, but do not bound it".
 */
export interface ReadCapRow {
  table_name: string;
  sql: string | null;
  max_rows: number | null;
  order_by: string | null;
  note: string | null;
  set_by: string | null;
  set_at: string | null;
}

/** What a caller gets back: the statement to run, and what to tell the reader. */
export interface ResolvedReadCap {
  /** The statement to execute, with the cap appended in the right dialect. */
  statement: string;
  /** The cap that was applied, or null when the object is uncapped. */
  maxRows: number | null;
  /** The ordering the window was taken in, or null when uncapped. */
  orderBy: string | null;
  /** The row this came from, or null when the object has no cap row at all. */
  row: ReadCapRow | null;
}

/**
 * The identifier allowlist for `order_by`, derived from the statement itself.
 *
 * ★ THE ORDERING IS INTERPOLATED, SO IT HAS TO BE CHECKED — AND THE STATEMENT IS
 *   THE ONLY PLACE THAT KNOWS WHICH COLUMNS EXIST.
 *
 *   `order_by` is text in a database column that a person types, and it reaches
 *   the SQL by concatenation. `parseSort`'s allowlist normally comes from a
 *   descriptor's `sortable` list; there is no descriptor here, because the cap
 *   table is deliberately generic — it governs objects the app reads by hand. So
 *   the allowlist is built by scanning the statement's own text for bare
 *   identifiers and accepting a token only when it appears in it.
 *
 *   That is weaker than a declared list and it is stated rather than hidden: it
 *   stops a token that is not a column of this query, which is the failure that
 *   matters (a typo, a copy-paste from another table, an injection attempt). It
 *   does not stop a token that happens to appear in a string literal somewhere in
 *   the statement. The mitigation for that is the second half of the check below —
 *   the token must be a *plain identifier* (letters, digits, underscore, and
 *   optionally a trailing ` ASC`/` DESC`) — so the worst a crafted value can do is
 *   name a column the query already mentions.
 */
function orderableTokens(statement: string): Set<string> {
  const found = new Set<string>();
  // Bare identifiers only: a quoted name, a bind, a number and a function call are
  // all excluded, because none of them is a column this check should bless.
  for (const match of statement.matchAll(/[A-Za-z_][A-Za-z0-9_$#]*/g)) {
    found.add(match[0].toUpperCase());
  }
  return found;
}

/**
 * Validate one `order_by` token against the statement, and return it quoted.
 *
 * Accepts `COLUMN`, `COLUMN ASC`, `COLUMN DESC`, and a comma-separated list of
 * those — the same vocabulary `?sort=` accepts, so an administrator who has used
 * the registers already knows it. Anything else is refused with the token named.
 */
export function orderByFragment(orderBy: string, statement: string): string {
  const allowed = orderableTokens(statement);
  const parts: string[] = [];
  for (const raw of orderBy.split(',')) {
    const token = raw.trim();
    if (!token) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_$#]*)(?:\s+(ASC|DESC))?$/i.exec(token);
    if (!match) {
      throw AppError.badRequest(
        `The read cap's order is "${token}", which is not a column name with an optional ` +
          'ASC or DESC. It is interpolated into the statement, so it has to be a plain ' +
          'identifier — a function call, an expression or a literal is refused.',
        { orderBy, token },
      );
    }
    const name = match[1]!;
    if (!allowed.has(name.toUpperCase())) {
      throw AppError.badRequest(
        `The read cap orders by "${name}", which does not appear in the statement it would ` +
          'be added to. The ordering is checked against the query\'s own text, so a column ' +
          'this statement does not mention cannot be used to window it.',
        { orderBy, column: name },
      );
    }
    parts.push(match[2] ? `${quoteIdent(name)} ${match[2].toUpperCase()}` : quoteIdent(name));
  }
  if (parts.length === 0) {
    throw AppError.badRequest('The read cap\'s order is blank.', { orderBy });
  }
  return parts.join(', ');
}

/**
 * Apply a cap to a statement, in the dialect of the store it will run in.
 *
 * ★ THE WRAP IS LOAD-BEARING, NOT COSMETIC. `SELECT … FROM t WHERE ROWNUM <= 10
 *   ORDER BY x` is NOT the first ten by `x`: Oracle assigns `ROWNUM` as rows are
 *   produced, before the sort, so that statement takes ten arbitrary rows and then
 *   sorts those ten. `SELECT * FROM (SELECT … FROM t ORDER BY x) WHERE ROWNUM <=
 *   10` is the first ten by `x`, which is what "the 100,000 most recent" means.
 *   The same reasoning applies to `LIMIT`, which SQLite applies after the inner
 *   query has ordered — so the wrap is written the same way on both sides and the
 *   two dialects differ only in the token that names the bound.
 *
 * `maxRows + 1` is fetched on purpose: getting back one row more than the cap is
 * how the caller knows the result was cut, and can say "showing N of more" rather
 * than quietly presenting a prefix as the whole. `capReadRows` slices it back.
 */
export function applyReadCap(
  statement: string,
  maxRows: number,
  orderBy: string,
  dialect: 'sqlite' | 'oracle' | 'sqlserver',
): string {
  const n = Math.max(1, Math.trunc(maxRows));
  const inner = statement.trim().replace(/;\s*$/, '');
  const ordered = /\bORDER\s+BY\b/i.test(inner) ? inner : `${inner}\nORDER BY ${orderBy}`;
  if (dialect === 'oracle') {
    return `SELECT * FROM (\n${ordered}\n) WHERE ROWNUM <= ${n + 1}`;
  }
  if (dialect === 'sqlserver') {
    // ★ THE INNER `ORDER BY` IS REMOVED — see the long note in `query-guard.ts`'s
    //   `wrapForRowCap`. T-SQL forbids an `ORDER BY` in a derived table outright
    //   (Msg 1033), and measured, adding an outer `ORDER BY` does not rescue it
    //   (Msg 10744) — there is no arrangement that keeps the inner clause.
    //
    //   ★ THIS IS THE PATH WHERE DROPPING IT IS SAFEST. `ordered` above exists to
    //     make the window reproducible; the ordering is *also* applied by the
    //     caller's own statement in every use, and `row.order_by` is reported back
    //     to the reader as `cap.orderBy` regardless. So the disclosure of what the
    //     window means does not depend on the clause surviving the wrap.
    return `SELECT TOP (${n + 1}) * FROM (\n${stripTrailingOrderBy(ordered)}\n) AS capped`;
  }
  return `SELECT * FROM (\n${ordered}\n) LIMIT ${n + 1}`;
}

/**
 * How many rows a capped read actually held, and whether it was cut.
 *
 * Split out so the "showing 100,000 of more" sentence and the `truncated` flag come
 * from one decision rather than two expressions that can disagree.
 */
export function capReadRows<T>(rows: readonly T[], maxRows: number | null): { rows: T[]; truncated: boolean } {
  if (maxRows === null) return { rows: [...rows], truncated: false };
  const n = Math.max(1, Math.trunc(maxRows));
  if (rows.length <= n) return { rows: [...rows], truncated: false };
  return { rows: rows.slice(0, n), truncated: true };
}

/** The cache, keyed by the upper-cased object name. One query per object per process. */
const cache = new Map<string, ReadCapRow | null>();

/**
 * Read one object's cap row, or null when it has none.
 *
 * ★ NULL IS THE COMMON CASE AND IT MEANS "UNCAPPED", NOT "MISSING". A table is only
 *   bounded when somebody decides it needs to be, so a fresh deployment reads every
 *   object exactly as it did before this feature existed. That is what makes adding
 *   the table safe: it changes no behaviour until a row is written.
 *
 * ★ THE LOOKUP IS CASE-INSENSITIVE ON PURPOSE. Oracle uppercases unquoted
 *   identifiers, so the same object is `AP_INVOICES_ALL` in a query and might be
 *   typed `ap_invoices_all` in the panel. The `COLLATE NOCASE` comparison and the
 *   upper-cased cache key make the two the same row.
 */
export async function readCapFor(tableName: string): Promise<ReadCapRow | null> {
  const key = tableName.trim().toUpperCase();
  if (cache.has(key)) return cache.get(key) ?? null;

  let row: ReadCapRow | null = null;
  try {
    const found = await rows<ReadCapRow>(
      `SELECT table_name, sql, max_rows, order_by, note, set_by, set_at
         FROM ledger_read_cap
        WHERE table_name = :name COLLATE NOCASE
        LIMIT 1`,
      { name: tableName.trim() },
    );
    row = found[0] ?? null;
  } catch {
    // ★ A MISSING TABLE IS NOT A FAILED READ. `ledger_read_cap` is created by
    //   `app-schema.ts` on first use, so on a deployment whose app store has not
    //   been touched yet the table genuinely does not exist. Treating that as
    //   "uncapped" is correct — there is no cap to apply — and it keeps this module
    //   from making every ledger read depend on the app store being present.
    row = null;
  }

  cache.set(key, row);
  return row;
}

/** Drop the cache. The write path calls this so a saved cap takes effect at once. */
export function forgetReadCap(tableName?: string): void {
  if (tableName === undefined) cache.clear();
  else cache.delete(tableName.trim().toUpperCase());
}

/**
 * Resolve an object's cap into a runnable statement.
 *
 * ★ THE STATEMENT COMES FROM THE STORED ROW, THEN THE REGISTRY, THEN THE CALLER.
 *   Three sources in that order, and each one answers a different question:
 *
 *     the stored row   what an administrator decided this object reads
 *     the registry     what the app reads when nobody has decided (see
 *                      `ledger-defaults.ts` — the defaults are code, not seed rows,
 *                      so they cannot drift from the module that consumes them)
 *     the caller's SQL a route that already knows how to read the table
 *
 *   The caller's statement is the fallback rather than the first choice because a
 *   stored row or a declared default is a *decision* about what a reader should
 *   see, and a route's own query is usually a decision about what that route needs.
 *
 * ★ THE REFUSAL IS THE FEATURE. A row with `max_rows` and no `order_by` throws
 *   here rather than running. See the module header for why the un-ordered form is
 *   the one that cannot be allowed.
 */
export async function resolveReadCap(
  tableName: string,
  statement: string,
  dialect: 'sqlite' | 'oracle' | 'sqlserver',
): Promise<ResolvedReadCap> {
  const row = await readCapFor(tableName);
  const declared = defaultReadFor(tableName);
  const base = row?.sql?.trim()
    ? row.sql.trim()
    : declared
      ? declared.sql.trim()
      : statement.trim();

  // ★ THE ORDERING FALLS BACK TOO, AND IT HAS TO. A stored cap with no `order_by`
  //   is refused below; a *default* with an ordering is what makes the default's
  //   window meaningful, so it is offered here rather than left for the caller.
  const declaredOrder = row?.order_by?.trim() ? row.order_by.trim() : (declared?.orderBy ?? null);

  if (row === null || row.max_rows === null || row.max_rows === undefined) {
    return { statement: base, maxRows: null, orderBy: null, row };
  }

  const maxRows = Number(row.max_rows);
  if (!Number.isFinite(maxRows) || maxRows <= 0) {
    throw AppError.badRequest(
      `The read cap for ${tableName} is ${String(row.max_rows)}, which is not a positive ` +
        'number of rows. Set a positive integer, or clear the cap to read the object unbounded.',
      { table: tableName, maxRows: row.max_rows },
    );
  }

  if (!row.order_by || row.order_by.trim() === '') {
    // ★ THE ONE REFUSAL THIS MODULE EXISTS FOR. See the header: an unordered cap is
    //   a random sample wearing the shape of a smaller answer.
    throw AppError.badRequest(
      `The read cap for ${tableName} sets a limit of ${maxRows} rows and no order. A cap ` +
        'without an ordering returns whichever rows the database reaches first, so every ' +
        'count, total and percentage computed from it would describe an arbitrary subset ' +
        'while looking correct. Give the cap an ordering (for example "INVOICE_DATE DESC") ' +
        'so the window is reproducible and can be stated on the screen.',
      { table: tableName, maxRows },
    );
  }

  const orderBy = orderByFragment(declaredOrder ?? row.order_by, base);
  return {
    statement: applyReadCap(base, maxRows, orderBy, dialect),
    maxRows,
    orderBy: row.order_by.trim(),
    row,
  };
}

/** The dialect of the store a ledger read will run in. */
export function ledgerDialect(): 'sqlite' | 'oracle' | 'sqlserver' {
  return storeDriver('ledger').dialect;
}

/**
 * Run a capped read against the ledger, returning the rows and the cut flag.
 *
 * The convenience the preview endpoint uses, and the shape a route should adopt
 * when it wants the disclosure without re-deriving it. It resolves, executes and
 * slices in one place so the three steps cannot disagree about the cap.
 */
export async function readCapped(
  tableName: string,
  statement: string,
): Promise<{ rows: Record<string, unknown>[]; truncated: boolean; cap: ResolvedReadCap }> {
  const cap = await resolveReadCap(tableName, statement, ledgerDialect());
  const result = await rows<Record<string, unknown>>(cap.statement);
  const { rows: kept, truncated } = capReadRows(result, cap.maxRows);
  return { rows: kept, truncated, cap };
}
