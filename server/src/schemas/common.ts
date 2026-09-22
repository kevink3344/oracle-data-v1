import { z } from '../http/z.js';
import type { ErrorCode } from '../http/errors.js';

/**
 * The shapes every endpoint shares.
 *
 * Three envelopes, and no exceptions:
 *
 *   single   { data: T }
 *   list     { data: T[], page: { limit, offset, total, returned } }
 *   error    { error: { code, message, details? } }
 *
 * A wrapper rather than a bare payload even though the payload is often enough,
 * because a bare array has nowhere to carry `total` — and `total` is the
 * difference between "there are 12 vendors" and "the first 12 of 157 vendors".
 * A screen that cannot tell those apart cannot say what it is showing.
 */

export const ERROR_CODES = [
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'CONFLICT',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'WRITES_DISABLED',
  'READ_ONLY_RESOURCE',
  'DB_UNAVAILABLE',
  'INTERNAL',
] as const satisfies readonly ErrorCode[];

export const ErrorBodySchema = z
  .object({
    error: z.object({
      code: z.enum(ERROR_CODES).openapi({ example: 'NOT_FOUND' }),
      message: z.string().openapi({ example: 'Vendor 99123 was not found.' }),
      /** Zod issue list for `VALIDATION_FAILED`; free-form otherwise. */
      details: z.unknown().optional(),
    }),
  })
  .openapi('Error');

export const PageMetaSchema = z
  .object({
    limit: z.number().int().openapi({ example: 50 }),
    offset: z.number().int().openapi({ example: 0 }),
    /** Rows matching the filters, ignoring the window. */
    total: z.number().int().openapi({ example: 157 }),
    /** Rows actually in `data` — so a client never has to infer it. */
    returned: z.number().int().openapi({ example: 50 }),
  })
  .openapi('PageMeta');

/**
 * The query parameters every list endpoint accepts.
 *
 * `limit` is capped rather than unbounded. An uncapped list over
 * `PO_LINES_ALL` is 2,805 rows on the sample and would be millions in
 * production, and the cap is what makes `total` meaningful: it forces callers to
 * page rather than to hope.
 */
export const ListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(500).default(50).openapi({
      description: 'Page size. Capped at 500.',
      example: 50,
    }),
    offset: z.coerce.number().int().min(0).default(0).openapi({
      description: 'Rows to skip.',
      example: 0,
    }),
    q: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .openapi({ description: 'Case-insensitive substring match across the resource’s searchable columns.' }),
    sort: z
      .string()
      .max(300)
      .optional()
      .openapi({
        description:
          'Comma-separated sort keys. Prefix with `-` for descending, e.g. `vendor_name,-vendor_id`. ' +
          'Names outside the resource’s sortable set are rejected rather than ignored.',
        example: 'vendor_name',
      }),
  })
  .openapi('ListQuery');

export type ListQuery = z.infer<typeof ListQuerySchema>;

/** A `{ id }` path segment, for the resources keyed on a single integer. */
export const IdParamsSchema = z.object({ id: z.coerce.number().int() }).openapi('IdParams');

/** Free-text search helper used by several hand-written routes. */
export const SearchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(200).openapi({ description: 'Search term.' }),
  })
  .openapi('SearchQuery');

/**
 * Marks a write endpoint as unavailable unless the target allows writing.
 * Documented in the spec so the constraint is visible before a 409 is hit.
 */
export const WriteDisabledNote =
  'Returns **409 `WRITES_DISABLED`** when the server is pointed at a remote database ' +
  'and `ALLOW_REMOTE_WRITES` is not set.';
