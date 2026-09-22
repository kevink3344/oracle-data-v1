import { extendZodWithOpenApi } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

/**
 * Every schema in this server imports `z` from here, never from 'zod' directly.
 *
 * The extension adds `.openapi()` to the Zod prototype process-wide, and it must
 * run exactly once before any schema is constructed. Funnelling all of them
 * through one module is what guarantees that — importing 'zod' anywhere else
 * would silently produce a schema without the method.
 */
extendZodWithOpenApi(z);

export { z };

/**
 * Path parameters are always strings on the wire — `/projects/:id` matches
 * "42", never 42 — so every numeric param coerces. Using plain `z.number()`
 * here would reject every real request.
 */
export const IntParam = z.coerce
  .number()
  .int()
  .openapi({ example: 1, description: 'Integer identifier.' });

export const StrParam = z
  .string()
  .min(1)
  .openapi({ example: '000000000000000000000000000000', description: 'String identifier.' });

/**
 * A yes/no query flag.
 *
 * Deliberately a string enum rather than a boolean. Two reasons, and the second
 * is the one that bites:
 *
 *  1. OpenAPI can only describe a query parameter as a string, so `type: boolean`
 *     is a lie the UI then acts on.
 *  2. `z.coerce.boolean()` is `Boolean(value)` — so the string `"false"` coerces
 *     to **true**, and `?counts=false` would switch the feature *on*. Any flag
 *     using it is inverted for every caller who spells out the negative.
 */
export const FlagQuery = z.enum(['true', 'false', '1', '0']).openapi({
  example: 'true',
  description: 'Boolean flag: `true`/`1` or `false`/`0`.',
});

export function isTrue(flag: string | undefined): boolean {
  return flag === 'true' || flag === '1';
}
