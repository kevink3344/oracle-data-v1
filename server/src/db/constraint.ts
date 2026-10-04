/**
 * Whether a driver error is a unique-constraint violation.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AND WHY IT IS NOT IN THE ROUTE
 * ---------------------------------------------------------------------------
 * A register keyed on a *human* name accepts a rename that collides. The database
 * is the authority on that — a `UNIQUE` constraint is the only thing that can
 * actually hold the rule, because a pre-check and the insert are two statements
 * and the gap between them is a race. But the database answers with a *code*, and
 * a code is a dialect fact with four spellings:
 *
 *   libSQL / SQLite   `SQLITE_CONSTRAINT_UNIQUE` (`SQLITE_CONSTRAINT_PRIMARYKEY` for a PK)
 *   MySQL             `ER_DUP_ENTRY` / errno 1062
 *   SQL Server        2601 (unique index) / 2627 (unique constraint or PK)
 *
 * A route that knew those strings would be a route holding four databases' worth of
 * trivia, and the next dialect would edit every register. So the classification
 * lives here, in `db/`, beside `read-cap.ts` and `query-guard.ts` — the same place
 * the rest of this repo keeps the questions whose answers differ by engine — and a
 * register reads as `if (isUniqueViolation(e)) throw AppError.conflict(...)`.
 *
 * ---------------------------------------------------------------------------
 * ★ THE PROPERTIES DO NOT LINE UP, SO NEITHER DOES THIS FUNCTION
 * ---------------------------------------------------------------------------
 * The obvious implementation reads `err.code` and compares it against a set. It is
 * wrong for two of the four arms, and both were measured rather than guessed:
 *
 *   - **MySQL reports the number separately.** `mysql2` sets `code` to the *symbol*
 *     (`ER_DUP_ENTRY`) and `errno` to `1062`. Reading only `code` works by luck;
 *     reading only `errno` does not work at all.
 *
 *   - **SQL Server reports NEITHER in `code`.** `mssql` puts `'EREQUEST'` in `code`
 *     — the same value every failed request carries — and the number that matters
 *     in `err.number`, with a second copy at `err.originalError.info.number`. A
 *     `code`-only check therefore answers "not unique" for every SQL Server
 *     duplicate, and the register returns a 500 for a conflict the database had
 *     already named.
 *
 *   - **And the adapters here do not unwrap.** `db/mysql.ts` and `db/sqlserver.ts`
 *     deliberately let the driver's own error propagate (only `http/middleware.ts`
 *     *classifies* one, and it claims only the SQLite codes). So this function has
 *     to be the one that knows about the nesting.
 *
 * The message is matched as a **backstop**, not as the rule. It is what saves the
 * SQL Server arm if a future `mssql` upgrade renames a field, and it is the only
 * thing that would catch an engine whose error arrives from a wrapper this file has
 * never seen — but every pattern below is a sentence a database actually produces,
 * and each is annotated with the engine that produces it. A test on a bare word
 * like `'unique'` was deliberately not used: it would match a *success* message
 * from a driver that described what it did, and a false positive here turns a real
 * 500 into a confident, wrong "that name already exists".
 */

/**
 * Codes, errnos and error numbers that can *only* mean "this value already
 * exists". The numeric strings are included because a driver that sets a number
 * may set it as a string, and the two are compared by text below.
 *
 * ★ `SQLITE_CONSTRAINT` AND FRIENDS ARE DELIBERATELY ABSENT. libSQL reports the
 *   bare code for a constraint it cannot name, and `http/middleware.ts` already
 *   claims that as a generic 409. Claiming it here would be worse than leaving it:
 *   this function's whole purpose is to let a register say *which* name collided,
 *   and a generic constraint failure is not evidence that it was the name. It
 *   falls through to the middleware, which answers a truthful 409 without
 *   pretending to know the column.
 */
const UNIQUE_CODES = new Set<string>([
  // libSQL / SQLite.
  'SQLITE_CONSTRAINT_UNIQUE',
  'SQLITE_CONSTRAINT_PRIMARYKEY',
  // MySQL. `ER_DUP_KEY` is the MyISAM-era sibling and costs nothing to accept.
  'ER_DUP_ENTRY',
  'ER_DUP_KEY',
  '1062',
  // SQL Server: 2601 is a duplicate in a unique *index*, 2627 in a unique
  // constraint or primary key. Both are conflicts, and a register cannot tell
  // which spelling the DDL chose — nor should it have to.
  '2601',
  '2627',
]);

/**
 * The sentences the drivers actually emit, per engine.
 *
 * ★ SQL SERVER'S TWO ARE THE TWO CODES ABOVE, SPELLED OUT. `Violation of UNIQUE
 *   KEY constraint 'uq_integration_title'. Cannot insert duplicate key in object
 *   'dbo.integration'. The duplicate key value is (Payroll webhook).` — the code
 *   and the message are redundant on purpose, so losing either one does not lose
 *   the classification.
 */
const UNIQUE_MESSAGES: readonly RegExp[] = [
  /UNIQUE constraint failed/i, // SQLite
  /Duplicate entry .+ for key/i, // MySQL 1062
  /Violation of (?:UNIQUE KEY|PRIMARY KEY) constraint/i, // SQL Server 2627
  /Cannot insert duplicate key/i, // SQL Server 2627
  /duplicate key row in object/i, // SQL Server 2601
];

/** The shape this file reads, as loosely as the four drivers really provide it. */
interface DriverErrorShape {
  code?: unknown;
  errno?: unknown;
  number?: unknown;
  message?: unknown;
  sqlMessage?: unknown;
  info?: { number?: unknown } | undefined;
  originalError?: unknown;
  cause?: unknown;
}

/** A value the drivers use for a code, when it is one. Numbers are stringified. */
function asCode(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * The error, plus whatever wrappers sit under it.
 *
 * `originalError` is `mssql`'s; `cause` is what an `Error` carries when something
 * in the stack re-threw with `{ cause }`. Both are followed because a driver
 * upgrade that starts wrapping would otherwise turn a named conflict back into a
 * 500 — the failure this file exists to prevent, arriving a second time.
 *
 * The depth bound is not decoration: a self-referential `cause` is legal, and an
 * unbounded walk over one would hang the request rather than raise it.
 */
function chain(err: unknown, depth = 0): DriverErrorShape[] {
  if (depth > 4 || err === null || typeof err !== 'object') return [];
  const node = err as DriverErrorShape;
  return [
    node,
    ...chain(node.originalError, depth + 1),
    ...chain(node.cause, depth + 1),
  ];
}

/**
 * True when this error says a `UNIQUE` constraint was violated.
 *
 * Answers `false` for everything it does not recognise, including a plain
 * `Error`, a `null`, and a constraint failure the drivers leave unnamed. That is
 * the safe direction: the caller's alternative branch is a 500 (or the
 * middleware's generic 409), which is honest, where a false `true` would be a
 * confident sentence about the wrong column.
 */
export function isUniqueViolation(err: unknown): boolean {
  for (const node of chain(err)) {
    for (const candidate of [node.code, node.errno, node.number, node.info?.number]) {
      const code = asCode(candidate);
      if (code !== undefined && UNIQUE_CODES.has(code)) return true;
    }

    // MySQL puts the human text in `sqlMessage`; `mssql` uses `message`. Both are
    // tried because a wrapper may keep the outer `message` and the inner detail.
    const text = [node.message, node.sqlMessage].filter((v): v is string => typeof v === 'string');
    if (UNIQUE_MESSAGES.some((pattern) => text.some((t) => pattern.test(t)))) return true;
  }
  return false;
}
