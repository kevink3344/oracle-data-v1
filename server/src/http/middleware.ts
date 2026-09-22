import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, isAppError, type ErrorCode } from './errors.js';
import { dbStatus, isDbReady } from '../db/client.js';

/**
 * The three cross-cutting middlewares: writes guard, 404, and the single error
 * renderer. All three are here rather than per-router because a rule that has to
 * be remembered per-router is a rule that will be forgotten per-router.
 */

/**
 * Refuse mutations when the target is not writable.
 *
 * Placed before the routers, not inside them, so that the refusal costs no
 * database round trip and cannot be bypassed by a route that forgets to check.
 * GET/HEAD/OPTIONS pass — the point is to protect the data, not to lock the API.
 *
 * ★ THE ONE EXEMPTION, AND WHY IT IS A LIST OF EXACT PATHS.
 *   `POST /api/views/preview` runs a statement and stores nothing. It is a POST
 *   because the SQL must not travel in a query string (it would land in every
 *   access log in the path), not because it mutates anything — so the guard's
 *   approximation "not GET therefore a write" is wrong for it, and without an
 *   exemption the builder's Run button would be refused with a message about
 *   `ALLOW_REMOTE_WRITES`, which has nothing to do with it.
 *
 *   The exemption is an exact-method-exact-path match and not a prefix, so it
 *   cannot widen by accident: `POST /api/views` (create) and
 *   `POST /api/views/{id}/run` (records history) stay refused. The preview route
 *   is safe to exempt because it is guarded by something stronger and more
 *   specific than this middleware — the statement allowlist in
 *   `db/query-guard.ts`, which refuses anything that is not a single `SELECT` or
 *   `WITH` and then runs it under `PRAGMA query_only`.
 *
 *   Anything read-only added here later must be named here. That is the point:
 *   the list is short enough to read, and adding to it is a deliberate act.
 *
 * ★ EXPORTED SO A TEST CAN ASSERT A NEGATIVE. Whether a route is *absent* from
 *   this list is invisible from outside the process in local mode, where every
 *   write is allowed anyway — so a route could be wrongly exempted and no
 *   request would ever differ. The smoke suite imports the set and asserts
 *   membership, which is the only way to make "not read-only" a testable claim.
 *
 * ★ THIS GUARD IS DELIBERATELY COARSE, AND NO LONGER THE LAST WORD.
 *   It refuses when *no* store accepts writes. It cannot do better than that: it
 *   runs before routing, so it knows a method and a path and nothing about which
 *   table the request will touch — and the answer to "may this be written" is now
 *   a property of the table's store (`writableForTable` in `db/client.ts`).
 *
 *   Two consequences, both intended:
 *
 *     - Under `DB_MODE=oracle` with a writable app store, this guard passes and
 *       `POST /api/views` works, while `POST /api/coa/ledgers` does not exist at
 *       all — `registerResource` omits the write routes for a table in a
 *       read-only store. The precise decision is made where the table is known;
 *       this stays as the blunt backstop that a forgotten check cannot bypass.
 *     - The message below is now about the whole server rather than about the
 *       remote target, because "writes are disabled" can only be true of every
 *       store at once. A single store's refusal is reported by its own route.
 */
export const READ_ONLY_POSTS = new Set(['POST /api/views/preview']);

export const writesGuard: RequestHandler = (req, _res, next) => {
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    next();
    return;
  }
  if (READ_ONLY_POSTS.has(`${method} ${req.path}`)) {
    next();
    return;
  }
  const status = dbStatus();
  if (status.stores.some((s) => s.writable)) {
    next();
    return;
  }
  next(
    AppError.writesDisabled(
      `Writes are disabled. Every store this server is pointed at is read-only ` +
        `(${status.stores.map((s) => `${s.id}: ${s.target}`).join(', ')}). ` +
        'Set ALLOW_REMOTE_WRITES (or APP_DB_URL to a writable store) in .env and restart, ' +
        'or switch DB_MODE to local.',
    ),
  );
};

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', `No route for ${req.method} ${req.path}.`));
};

interface BodyParseError extends SyntaxError {
  type?: string;
  body?: unknown;
  status?: number;
}

const INTERNAL_MESSAGE =
  'The server hit an unexpected error. The full detail has been logged server-side.';

/**
 * Database constraint codes, split by what the caller should do about it.
 *
 * `resource.ts` inserts whatever the caller supplied and lets the database be the
 * last word on NOT NULL, UNIQUE, CHECK and foreign keys. That is the right design
 * — the schema is the authority — but it only pays off if the resulting error is
 * translated. Left alone it reaches this handler as an unrecognised throw and
 * becomes a 500 INTERNAL, which says "the server is broken" when the truth is
 * "your request was invalid". The distinction decides whether the reader checks
 * their payload or the logs.
 *
 * The rule: **400 means fix the body, 409 means it conflicts with stored state.**
 * Whether the framework or the database rejected the value is not the caller's
 * problem, so both NOT NULL and CHECK land on 400 rather than being split across
 * `VALIDATION_FAILED` and `BAD_REQUEST` for no benefit to whoever is debugging.
 *
 * The codes were measured, not guessed — see the notes on `classifyDriverError`.
 */
const CONSTRAINT_INVALID = new Set(['SQLITE_CONSTRAINT_NOTNULL', 'SQLITE_CONSTRAINT_CHECK']);

const CONSTRAINT_CONFLICT = new Set([
  'SQLITE_CONSTRAINT_UNIQUE',
  'SQLITE_CONSTRAINT_PRIMARYKEY',
  // Reached when a foreign key exists that `assertParentsExist` could not check —
  // typically a self-reference, or a parent deleted between the check and the
  // insert. The pre-check is an optimisation for a good message, not a guarantee,
  // so this is the backstop that keeps integrity true.
  'SQLITE_CONSTRAINT_FOREIGNKEY',
  // The unfiled remainder: `SQLITE_CONSTRAINT` is what libSQL reports for a
  // constraint it does not name. A conflict is the safer guess than a 500 —
  // a unique or FK violation is by far the likeliest cause.
  'SQLITE_CONSTRAINT',
]);

interface DriverError {
  code?: unknown;
  message?: unknown;
}

/**
 * `NOT NULL constraint failed: parent.name` → `parent.name`.
 *
 * Returned so the response can name the column. A 400 that says only "a
 * constraint failed" leaves the caller diffing their payload against a schema
 * they cannot see; naming the column ends it in one round trip.
 */
function constraintTarget(message: string): string | undefined {
  const match = /constraint failed:\s*(.+)$/.exec(message);
  return match?.[1]?.trim();
}

/**
 * Translate a driver error into a client-facing one, or `undefined` to let it
 * continue to the generic path.
 *
 * Only constraint and read-only codes are claimed. Everything else libSQL reports
 * — `URL_INVALID`, `SERVER_ERROR`, `HTTP_STATUS_NOT_OK`, the `SQLITE_ERROR` that
 * a descriptor naming a column that does not exist produces — is a fault in this
 * server or in its configuration, and those must stay 500 so they surface in the
 * logs rather than being dressed up as the caller's mistake. Claiming too much
 * here would hide real bugs behind a tidy 400.
 */
function classifyDriverError(err: unknown): AppError | undefined {
  const driver = err as DriverError | null | undefined;
  const code = typeof driver?.code === 'string' ? driver.code : undefined;
  if (code === undefined) return undefined;

  const message = typeof driver?.message === 'string' ? driver.message : code;
  const detail = message.replace(new RegExp(`^${code}:\\s*`), '');
  const target = constraintTarget(detail);

  if (CONSTRAINT_INVALID.has(code)) {
    return AppError.validation(
      code === 'SQLITE_CONSTRAINT_NOTNULL'
        ? `A required column was missing or null${target ? `: ${target}` : ''}.`
        : `A value was rejected by a column constraint${target ? `: ${target}` : ''}.`,
      { constraint: code, ...(target ? { column: target } : {}) },
    );
  }

  if (CONSTRAINT_CONFLICT.has(code)) {
    return AppError.conflict(`The row conflicts with an existing constraint${target ? `: ${target}` : ''}.`, {
      constraint: code,
      ...(target ? { column: target } : {}),
    });
  }

  // A write reached a connection that will not accept one. On the remote target
  // this is the `canWrite` flag the token carries, so it means the same thing the
  // `writesGuard` says — same code, so a client handles both identically.
  if (code === 'SQLITE_READONLY' || code === 'SQLITE_PERM') {
    return AppError.writesDisabled(detail);
  }

  return undefined;
}

/**
 * The only place a client-facing error body is produced.
 *
 * Two conversions happen here that are worth naming:
 *
 *  1. A malformed JSON body arrives as a `SyntaxError` from `express.json()`.
 *     Rendered as-is it would become a 500 and read as an application bug. It is
 *     a client bug, and the message now says so — this exact confusion cost real
 *     time on this project once, because a shell that strips quotes produces the
 *     same symptom as a broken handler.
 *
 *  2. A thrown database error while the connection is known to be down becomes
 *     503 `DB_UNAVAILABLE` rather than 500. "The database is unreachable" and
 *     "the code is wrong" call for completely different responses from whoever
 *     is reading the screen.
 *
 *  3. A database constraint violation becomes 400 or 409 rather than 500 — see
 *     `classifyDriverError`. The database is treated as the authority on what a
 *     valid row is, so its rejections have to be legible to the caller.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  if (isAppError(err)) {
    res.status(err.status).json(err.toBody());
    return;
  }

  const parseError = err as BodyParseError;
  if (parseError instanceof SyntaxError && parseError.type === 'entity.parse.failed') {
    console.warn(`[http] malformed JSON body on ${req.method} ${req.path}`);
    res
      .status(400)
      .json(
        AppError.badRequest(
          'The request body was not valid JSON.',
          { hint: 'Check quoting and encoding — a body of `{a:1}` is not JSON.' },
        ).toBody(),
      );
    return;
  }

  if (parseError.type === 'entity.too.large') {
    res.status(413).json(new AppError(413, 'BAD_REQUEST', 'The request body was too large.').toBody());
    return;
  }

  // Before the readiness check: a constraint violation is a deterministic property
  // of the request, so it must not be masked by a transient health flag.
  const classified = classifyDriverError(err);
  if (classified) {
    res.status(classified.status).json(classified.toBody());
    return;
  }

  if (!isDbReady()) {
    console.error(`[http] ${req.method} ${req.path} failed while the database was unreachable:`, err);
    /**
     * ★ NAME THE STORE THAT FAILED, NOT THE PRIMARY ONE.
     *
     * This message used to print the one target there was. With two stores it can
     * print the ledger's address while the app store is the one that is down — and
     * the operator goes to check a database that is answering fine. The failing
     * stores are the ones worth naming; a healthy store's absence from this line
     * is itself the information.
     */
    const failed = dbStatus().stores.filter((s) => !s.ok);
    const named =
      failed.length > 0
        ? failed.map((s) => `${s.id} (${s.target})`).join(' and ')
        : dbStatus().target;
    res
      .status(503)
      .json(
        new AppError(
          503,
          'DB_UNAVAILABLE',
          `The database is not reachable (${named}). See /api/health for the current state.`,
        ).toBody(),
      );
    return;
  }

  console.error(`[http] ${req.method} ${req.path} threw:`, err);
  res.status(500).json(new AppError(500, 'INTERNAL' satisfies ErrorCode, INTERNAL_MESSAGE).toBody());
};
