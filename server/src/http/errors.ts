/**
 * One error type, and one place that decides what a client is told.
 *
 * Every handler throws; one final middleware renders. That is what makes the
 * error envelope uniform without each route remembering to build it, and it is
 * what stops an unexpected exception from serialising a stack trace to the
 * browser.
 */

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  /**
   * 401 — nobody is signed in, or the credentials offered were not recognised.
   *
   * Both of those collapse into one code deliberately. "This email exists but
   * the password is wrong" and "this email is unknown" are the same fact to an
   * anonymous caller, and answering them differently turns the sign-in endpoint
   * into an account-enumeration oracle.
   */
  | 'UNAUTHORIZED'
  /**
   * 403 — somebody *is* signed in, and their role does not reach this endpoint.
   *
   * Kept distinct from 401 so the client can tell "sign in" apart from "this is
   * not yours": the first offers a fix, the second does not.
   */
  | 'FORBIDDEN'
  | 'WRITES_DISABLED'
  | 'READ_ONLY_RESOURCE'
  | 'DB_UNAVAILABLE'
  /**
   * 503 — the natural-language feature exists but cannot answer right now.
   *
   * ★ DISTINCT FROM `DB_UNAVAILABLE` EVEN THOUGH BOTH ARE 503, because they name
   *   different broken things and the client acts on them differently. `DB_UNAVAILABLE`
   *   means "the ledger is unreachable, try again in a moment"; this means "the
   *   assistant is switched off or the model did not answer, and no amount of
   *   retrying will change the switch". Collapsing them into one code would make
   *   the UI unable to say which of the two it is looking at.
   *
   * Three situations share it, all of them "configured to answer, cannot":
   *   - `AI_ENABLED` is off, or a required setting is missing
   *   - the endpoint refused, timed out, or returned an unusable body
   *   - the model spent its whole token budget on reasoning and returned no content
   *     (measured: DeepSeek's reasoning models do this at a small `max_tokens`, at
   *     HTTP 200 — see the note on `maxTokens` in `ai/model.ts`)
   *
   * A 503 rather than a 500 because nothing is broken and a retry is reasonable;
   * a 503 rather than a 404 because the route is mounted and documented, and a 404
   * would read as a typo in the client.
   */
  | 'AI_UNAVAILABLE'
  | 'INTERNAL';

export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    /** Field-level detail. For `VALIDATION_FAILED` this is a Zod issue list. */
    details?: unknown;
  };
}

export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details: unknown;

  constructor(status: number, code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toBody(): ErrorBody {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError(400, 'BAD_REQUEST', message, details);
  }

  static validation(message: string, details?: unknown): AppError {
    return new AppError(400, 'VALIDATION_FAILED', message, details);
  }

  static notFound(what: string): AppError {
    return new AppError(404, 'NOT_FOUND', `${what} was not found.`);
  }

  static conflict(message: string, details?: unknown): AppError {
    return new AppError(409, 'CONFLICT', message, details);
  }

  /**
   * 401 — the request carries no usable session.
   *
   * The message is deliberately the same one sign-in gives for bad credentials:
   * "you are not signed in" and "that was not you" are the same instruction to
   * the client, which is to show the sign-in form. A route that wanted to say
   * which of the two it was would be saying something the caller cannot act on
   * differently, and would leak whether a token was ever valid.
   */
  static unauthorized(
    message = 'Sign in to continue. Your session has ended or was never started.',
  ): AppError {
    return new AppError(401, 'UNAUTHORIZED', message);
  }

  /** 403 — signed in, and this is not something this account may do. */
  static forbidden(message: string, details?: unknown): AppError {
    return new AppError(403, 'FORBIDDEN', message, details);
  }

  /**
   * 409 rather than 403: the request is well-formed and the caller is allowed —
   * the *server's configuration* is what refuses it. A 403 would imply a
   * permission the caller could be granted, which is not the situation.
   */
  static writesDisabled(message: string): AppError {
    return new AppError(409, 'WRITES_DISABLED', message);
  }

  static readOnly(resource: string, reason: string): AppError {
    return new AppError(405, 'READ_ONLY_RESOURCE', `${resource} is read-only: ${reason}`);
  }

  /**
   * 503 — this deployment cannot read the object the resource is built on.
   *
   * A third answer, needed because the two available ones are both wrong. Not a
   * 404: the route exists and is documented, so "no such thing" would be false.
   * Not a 500: nothing is broken, and a 500 is the answer a client retries
   * forever. The object is missing from the account's *grants*, which is a fact
   * about the deployment — three of the ledger descriptors here name EBS views
   * (`V_SEGMENT_LEGEND`, `V_ACCOUNT_POSITION`, `V_BUDGET_BY_ACCOUNT_PERIOD`) that
   * this account may not read.
   *
   * `DB_UNAVAILABLE` has been in the code union with no constructor because this
   * is the first endpoint that needed to say it.
   */
  static dbUnavailable(message: string, details?: unknown): AppError {
    return new AppError(503, 'DB_UNAVAILABLE', message, details);
  }

  /**
   * 503 — the assistant cannot answer, and the *reason* is the useful part.
   *
   * Every call site is expected to pass a message that names what to do about it
   * ("set AI_API_KEY", "the model did not answer within 8000 ms"), because the one
   * thing worse than a disabled feature is a disabled feature that will not say
   * why. `details` carries the upstream body when there is one — it is the only
   * place a provider's own error text survives to the operator.
   */
  static aiUnavailable(message: string, details?: unknown): AppError {
    return new AppError(503, 'AI_UNAVAILABLE', message, details);
  }
}

/**
 * ★ `instanceof` ALONE SILENTLY DISCARDS THE ONE ERROR THE DATABASE LAYER THROWS.
 *
 *   `db/app-schema.ts` cannot import this class — `db/` is used by scripts that
 *   never build a request, and the dependency would be circular the day an error
 *   handler wants to read `dbStatus()`. So it declares a stand-in, `AppErrorLike`,
 *   which carries `status` and `code` and sets `name = 'AppError'` precisely so
 *   that this guard recognises it.
 *
 *   It did not. `instanceof` tests the prototype chain, `AppErrorLike` extends
 *   `Error`, and the guard was false — so `errorHandler` skipped the branch that
 *   would have rendered it, matched nothing else, and fell through to its final
 *   `res.status(500)`. Measured: `requireAppSchema` threw `status: 503, code:
 *   'DB_UNAVAILABLE'` with a message naming the missing DDL file, and the browser
 *   received a bare 500 with `INTERNAL`. A 503 that says "set this" arrived as a
 *   500 that says nothing, which is the worst of both — an operator cannot act on
 *   either the status or the body.
 *
 * ★ THE SHAPE IS CHECKED, NOT JUST THE NAME. `name` is a plain writable property
 *   that any `Error` can carry, so matching on it alone would let an unrelated
 *   throw that happened to set it be rendered as a typed error body — and the
 *   `toBody()` call below would then fail *inside the error handler*, turning a
 *   recoverable failure into an unhandled one. Requiring a numeric `status`, a
 *   string `code` and a callable `toBody` means a match is always safely
 *   serialisable. `instanceof` stays first: for a real `AppError` it is strictly
 *   stronger and costs nothing to prefer.
 *
 * The predicate still says `AppError` rather than a structural type so every caller
 * keeps the full member set (`details`, the static factories). The stand-in is
 * documented as exactly that — a local substitute — and the fields this handler
 * touches are the ones the shape check guarantees.
 */
export function isAppError(e: unknown): e is AppError {
  if (e instanceof AppError) return true;
  if (typeof e !== 'object' || e === null) return false;

  const candidate = e as { name?: unknown; status?: unknown; code?: unknown; toBody?: unknown };
  return (
    candidate.name === 'AppError' &&
    typeof candidate.status === 'number' &&
    typeof candidate.code === 'string' &&
    typeof candidate.toBody === 'function'
  );
}
