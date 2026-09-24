import { withSqlFlag } from './showSql';
import type { SqlTrace } from '../components/SqlNote';

/**
 * Reading the SQL trace off a response.
 *
 * ── WHY THIS IS A SEPARATE MODULE FROM THE FETCHERS
 *
 * Every data module in this app builds its own `fetch` and unwraps its own envelope — that is
 * deliberate (each one has a different refusal message and a different shape), and it is not worth
 * rewriting twenty of them to share a client. What they *do* need to share is the two lines that
 * make the trace work: ask for it on the way out, and pick it up on the way back.
 *
 * ── ★ THE TRACE IS NEVER ALLOWED TO BREAK A PAGE
 *
 * `readTrace` returns `null` for anything it does not recognise rather than throwing. A response
 * without a trace is the *normal* case when the toggle is off, and a malformed one must degrade to
 * "no SQL shown" rather than to a failed request — the figures are the page, and the annotation is
 * a reading aid that must never be able to take the page down.
 */

/** The shape the server attaches as a sibling of `data` / `page`. */
interface Traced {
  sql?: unknown;
}

/**
 * Pull the trace out of an already-parsed response body.
 *
 * Validates the parts it will render, because a `statements` array holding something that is not a
 * statement would reach `compact()` and throw there instead — where the stack would name the
 * component rather than the response.
 */
export function readTrace(body: unknown): SqlTrace | null {
  const raw = (body as Traced | null | undefined)?.sql;
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as { statements?: unknown; total?: unknown; truncated?: unknown };
  if (!Array.isArray(candidate.statements)) return null;

  const statements = candidate.statements.filter(
    (s): s is { sql: string; ms: number; rows: number | null } =>
      typeof s === 'object' &&
      s !== null &&
      typeof (s as { sql?: unknown }).sql === 'string' &&
      typeof (s as { ms?: unknown }).ms === 'number',
  );
  if (statements.length === 0) return null;

  return {
    statements,
    total: typeof candidate.total === 'number' ? candidate.total : statements.length,
    truncated: candidate.truncated === true,
  };
}

/**
 * The URL to fetch, with the trace flag applied when the reader asked for it.
 *
 * A one-line alias so a data module reads `fetch(sqlUrl(path))` rather than importing the
 * preference module and knowing its rule. The rule lives in `showSql.ts`; this is the call site's
 * spelling of it.
 */
export function sqlUrl(path: string): string {
  return withSqlFlag(path);
}
