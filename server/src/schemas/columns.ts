import { z } from '../http/z.js';

/**
 * Column schemas.
 *
 * These describe what a row *looks like*, and they are never used to parse a
 * response — validation happens on the way in, and the database is authoritative
 * on the way out. Their whole job is to make the OpenAPI document show real field
 * names, real types, and an explanation of each column, so a consumer reading
 * Swagger does not have to open the DDL.
 *
 * WHY EVERYTHING IS NULLABLE BY DEFAULT
 *   This sample is sparse on purpose. `PO_LINE_LOCATIONS_ALL.SHIP_TO_LOCATION_ID`
 *   is null on every row, `PO_DISTRIBUTIONS_ALL.ENCUMBERED_AMOUNT` is null unless
 *   the line was encumbered, and `GL_BALANCES` carries nulls in the reporting
 *   columns it does not aggregate. A schema that promised a string where the data
 *   holds null would be a schema that lies in exactly the places a consumer is
 *   most likely to trust it. So a column is nullable unless the DDL says NOT NULL,
 *   and the `Req` variants exist for those.
 *
 * The dates are `TEXT`, not `STRING`+`format: date`, on purpose: the source holds
 * `'YYYY-MM-DD'` strings and a few Oracle zero-dates were converted to null on
 * import. Claiming `format: date` would make a generated client reject the values
 * the server actually returns.
 */

export function text(description: string): z.ZodTypeAny {
  return z.string().nullable().openapi({ description });
}

export function textReq(description: string): z.ZodTypeAny {
  return z.string().min(1).openapi({ description });
}

export function int(description: string): z.ZodTypeAny {
  return z.number().int().nullable().openapi({ description });
}

export function intReq(description: string): z.ZodTypeAny {
  return z.number().int().openapi({ description });
}

export function real(description: string): z.ZodTypeAny {
  return z.number().nullable().openapi({ description });
}

export function realReq(description: string): z.ZodTypeAny {
  return z.number().openapi({ description });
}

/**
 * A stored Oracle date, as `YYYY-MM-DD`.
 *
 * Deliberately not `z.string().date()`: the importer preserved the source text
 * verbatim and there are values in the sample that a strict date format would
 * reject, so accepting any string is the honest contract.
 */
export function date(description: string): z.ZodTypeAny {
  return text(`${description} Stored as \`YYYY-MM-DD\` text.`);
}

export function flag(description: string): z.ZodTypeAny {
  return z
    .enum(['Y', 'N'])
    .nullable()
    .openapi({ description: `${description} \`Y\` or \`N\`.` });
}

/**
 * Build the Zod object for a set of columns.
 *
 * The single `.strict()` here is what makes a typo in a request body a 400
 * instead of a silent no-op: without it Zod strips unknown keys, and a client
 * sending `vendor_nmae` would get a 201 and a row with no name.
 */
export function rowObject(shape: Record<string, z.ZodTypeAny>, description: string): z.AnyZodObject {
  return z.object(shape).strict().openapi({ description }) as unknown as z.AnyZodObject;
}

/** Does this field accept an explicit `null`? */
function acceptsNull(field: z.ZodTypeAny): boolean {
  return field.safeParse(null).success;
}

/**
 * Derive the **write** schema for a resource from its row schema.
 *
 * A row schema and a create body are not the same contract, and using one for
 * both is a real bug rather than a matter of taste — it was one here. Every
 * `SELECT` returns all of a table's columns, so a row schema marks each one
 * required-but-nullable: the field is always present and its value may be null.
 * A create body has no such guarantee. The caller supplies what they know, and
 * omitting a column is the normal case. Demanding `CREATION_DATE: null` from
 * every caller means nobody can create anything unless they first read the DDL.
 *
 * The optionality is *derived*, never declared a second time. It does not need to
 * be: the `Req` helpers in this file exist precisely for the NOT NULL columns, so
 * "rejects null" and "must be supplied" are already the same set — an optional
 * column accepts null, a required one does not. Reading that back off the schema
 * means the two contracts cannot drift, which is what a hand-maintained second
 * shape would eventually do.
 *
 * For an update schema, call `.partial()` on the result: a patch may touch any
 * single field, so even a required-by-create column becomes optional there.
 */
export function writeObject(row: z.ZodTypeAny, description: string): z.AnyZodObject {
  const shape = (row as unknown as { shape?: Record<string, z.ZodTypeAny> }).shape;
  if (!shape) {
    throw new Error('writeObject() needs a row built by rowObject(); it had no shape to derive from.');
  }
  const out: Record<string, z.ZodTypeAny> = {};
  for (const [key, field] of Object.entries(shape)) {
    out[key] = acceptsNull(field) ? field.optional() : field;
  }
  return z.object(out).strict().openapi({ description }) as unknown as z.AnyZodObject;
}
