import type { Response } from 'express';
import type { PageMeta } from '../db/sql.js';

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
  if (isRaw(value)) {
    res.status(status).type(value.contentType).send(value.body as string);
    return;
  }
  if (isPage(value)) {
    res.status(status).json({ data: value.items, page: value.meta });
    return;
  }
  res.status(status).json({ data: value });
}
