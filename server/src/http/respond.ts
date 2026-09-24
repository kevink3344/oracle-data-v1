import type { Response } from 'express';
import type { PageMeta } from '../db/sql.js';
import { currentSqlTrace, wantsSqlTrace } from './sql-trace.js';

/**
 * The response envelope, applied in one place.
 *
 * Handlers return a value; this decides the wire shape. That split is what lets
 * a handler be tested by asserting on its return value rather than on a
 * serialised body, and it is what stops one route from quietly returning
 * `{ items }` while its neighbours return `{ data }`.
 */

export interface Page<T> {
  readonly items: T[];
  readonly meta: PageMeta;
}

export function page<T>(items: T[], meta: PageMeta): Page<T> {
  return { items, meta };
}

export function isPage(v: unknown): v is Page<unknown> {
  return typeof v === 'object' && v !== null && Array.isArray((v as Page<unknown>).items) && 'meta' in v;
}

/**
 * Escape hatch for endpoints whose body is *not* this API's envelope.
 *
 * `GET /api/extract/current` reproduces the raw Oracle document byte for byte,
 * because its whole purpose is to be a drop-in replacement for the static
 * `/oracle/output.json` the frontend already fetches. Wrapping it in `{ data }`
 * would change the contract the one endpoint exists to preserve.
 */
const RAW = Symbol('raw-body');

export interface RawBody {
  readonly [RAW]: true;
  readonly body: unknown;
  readonly contentType: string;
}

export function raw(body: unknown, contentType = 'application/json; charset=utf-8'): RawBody {
  return { [RAW]: true, body, contentType };
}

export function isRaw(v: unknown): v is RawBody {
  return typeof v === 'object' && v !== null && RAW in v;
}

/**
 * Write a handler's return value.
 *
 * `status` is the route's declared success status, and it has to be applied here
 * rather than left to Express's default 200. `api.ts` derives the status once and
 * uses it for the OpenAPI document; if the response does not use the same value
 * the document is describing an endpoint that does not exist. That was a live bug
 * — every `POST` answered 200 while the spec promised 201, so a client branching
 * on "created" never took that branch and Swagger's own description was wrong.
 *
 * `undefined` is still always 204: a handler that returns nothing is saying there
 * is no representation to send, which is a stronger statement than the route's
 * default.
 */
export function sendResult(res: Response, value: unknown, status = 200): void {
  if (value === undefined) {
    res.status(204).end();
    return;
  }

  /**
   * ★ THE SQL TRACE IS ATTACHED HERE, IN ONE PLACE, AND ONLY WHEN ASKED FOR.
   *
   *   `?sql=1` is sent by the frontend only while the Settings toggle is on, so a request that does
   *   not ask for the trace produces a byte-identical body to before this existed — which is what
   *   keeps it out of every logged payload, smoke assertion and screenshot by default.
   *
   *   It rides as a sibling of `data`/`page` rather than inside `data`, because it is *about* the
   *   response rather than part of the payload: a client decoding `data` never has to know it might
   *   be there, and the row schema stays exactly as declared in the OpenAPI document.
   */
  const trace = wantsSqlTrace(res.req?.query) ? currentSqlTrace() : null;

  if (isRaw(value)) {
    /**
     * ★ A RAW BODY IS NOT AN EXEMPTION FROM THE TRACE, AND IT WAS ONE UNTIL NOW.
     *
     *   `raw()` exists so an endpoint can reproduce a foreign document byte for byte — the AP
     *   registers re-emit Oracle's own `{ body: { ResultSets } }`, and `GET /api/extract/current`
     *   reproduces the extract. Returning early here meant those endpoints answered `hasSql: false`
     *   while every enveloped endpoint carried a trace, so the two payables registers — the two
     *   pages whose figures a reader most wants to check against the ledger — were the only ones
     *   that could not show their SQL.
     *
     *   The trace is added as a **sibling of `body`**, not inside it: `body.ResultSets` is the
     *   third-party contract this shape exists to preserve, and nesting an extra key inside it
     *   would be a change to that contract rather than an addition beside it.
     *
     *   The body is re-serialised only when there is a trace to add, so the byte-for-byte guarantee
     *   holds exactly where it matters — for a caller that did not ask.
     */
    if (trace && value.contentType.startsWith('application/json')) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value.body as string);
      } catch {
        // Not JSON after all, despite the content type. Send it untouched rather than
        // corrupt it: a trace is not worth mangling a payload over.
        res.status(status).type(value.contentType).send(value.body as string);
        return;
      }
      const withTrace =
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? { ...(parsed as Record<string, unknown>), sql: trace }
          : { body: parsed, sql: trace };
      res.status(status).type(value.contentType).send(JSON.stringify(withTrace));
      return;
    }
    res.status(status).type(value.contentType).send(value.body as string);
    return;
  }

  if (isPage(value)) {
    res.status(status).json(trace ? { data: value.items, page: value.meta, sql: trace } : { data: value.items, page: value.meta });
    return;
  }
  res.status(status).json(trace ? { data: value, sql: trace } : { data: value });
}
