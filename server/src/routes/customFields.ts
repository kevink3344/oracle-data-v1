/**
 * Custom field values — a name of our own for a value the ledger already holds.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, IN ONE PARAGRAPH
 * ---------------------------------------------------------------------------
 * The ledger is an extract of record: this application must not write to it, and
 * does not. But a reader looking at a 123-character vendor name on the vendor
 * register is looking at a *label*, not at data — and the register is the only
 * place that label exists. So a reader may type their own name for a company, it
 * is stored here, and the page shows the reader's name marked as theirs with the
 * ledger's name still on screen beside it. Nothing in Oracle changes, no figure
 * moves, and deleting the row restores the ledger's name because the ledger's name
 * was never replaced — it was only ever covered.
 *
 * ---------------------------------------------------------------------------
 * ★ THE SUBSTITUTION IS A LABEL AND THE LEDGER'S VALUE IS STILL THE KEY
 * ---------------------------------------------------------------------------
 * This is the fact that shaped the feature, and it is the one a reader who has
 * just renamed a company is most likely to be wrong about. On the vendor register
 * `name` is *both* a label and a key: `loadMaster(name, …)` resolves the vendor's
 * master record by an exact match on it, `invoiceHref(i, vendor.name)` puts it in
 * a link as a query parameter, and `groupVendors` groups on `keyOf(name)`. So a
 * custom name reaches the *heading* and never reaches a lookup — the client
 * carries `name` and `displayName` side by side for exactly that reason, and the
 * tooltip repeats the sentence to the reader.
 *
 * What follows from it here: **this endpoint stores a value and has no opinion
 * about what it is used for.** It does not validate against the register, cannot
 * (the register is not in this database), and does not try. The registry entry
 * carries the sentence the UI shows instead.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PAIR IS CHECKED AGAINST A REGISTRY AND NOT ACCEPTED AS WRITTEN
 * ---------------------------------------------------------------------------
 * See `../custom-fields/registry.ts`, which is the only place the (subject, field)
 * pairs are declared. An unlisted pair would store a row that no component reads —
 * a write that succeeds and changes nothing visible, which is worse than a
 * refusal, so it is refused here with a message naming what *is* overridable.
 *
 * ---------------------------------------------------------------------------
 * WHO MAY WRITE, AND WHY IT IS NOT A SUPER ADMIN
 * ---------------------------------------------------------------------------
 * `requireActor`, not `requireSuperAdmin`: any signed-in user may name a company
 * for themselves on this screen. An override is not a change to the data — a
 * company's name in Oracle is untouched and every figure on every page is
 * computed from the ledger — so the permission it needs is the permission to read
 * the page. Attribution is what makes that safe, and it is not optional: `set_by`
 * comes from the session and `set_at` from the database clock, and the tooltip
 * shows both, so a name that looks wrong has an author to ask.
 *
 * ---------------------------------------------------------------------------
 * ★ WHY `PUT` AND NOT `POST` + `PATCH`
 * ---------------------------------------------------------------------------
 * A deliberate departure from the `POST`/`PATCH`/`DELETE` trio in
 * `projectRegistry.ts`, and written down here so the next reader does not "fix" it.
 * The client cannot know whether Save is a create or a replace: that is a fact
 * about the *store*, not about the request, and the browser would have to guess —
 * producing a 409 on the second save of the same field. One idempotent `PUT` keyed
 * on the row's natural key says the true thing: *this field of this subject now
 * reads this*, whether or not it read anything before.
 *
 * ---------------------------------------------------------------------------
 * THE TWO 400s, AND WHICH LAYER SPEAKS
 * ---------------------------------------------------------------------------
 * Following the house convention: the Zod schema rejecting a malformed body — no
 * `value` at all, a `key` longer than anything a register could hold — is
 * `VALIDATION_FAILED`, because it is a fact about the shape of the request. The
 * handler refusing a pair that is not in the registry, a value longer than *that
 * field's* limit, or a blank value is `BAD_REQUEST`, because the answer to each of
 * those is a lookup (the registry) rather than a fact about the request. `404` is
 * reserved for the one thing that can be absent: a DELETE naming an override that
 * is not there.
 */

import { z } from '../http/z.js';
import type { Api } from '../http/api.js';
import { AppError } from '../http/errors.js';
import { requireActor } from '../auth/guard.js';
import { requireAppSchema } from '../db/app-schema.js';
import { text, textReq } from '../schemas/columns.js';
import { execute, one, rows } from '../db/sql.js';
import {
  OVERRIDABLE,
  overridable,
  overridableIn,
  overridableSubject,
  overridableSubjects,
  type OverridableField,
} from '../custom-fields/registry.js';

interface OverrideDbRow {
  subject_kind: string;
  subject_key: string;
  subject_written: string | null;
  field: string;
  value: string;
  set_by: string;
  set_at: string;
}

/** Ordered by the composite key, so a diff of two reads of one subject reads cleanly. */
const ROW_SQL =
  'SELECT subject_kind, subject_key, subject_written, field, value, set_by, set_at ' +
  'FROM field_override';

/**
 * The longest value the *shape* will accept, and it is deliberately much looser
 * than anything the registry allows.
 *
 * ★ AN ABUSE GUARD, NOT THE PER-FIELD LIMIT — AND IT USED TO BE THE LATTER.
 *   This was `Math.max(...OVERRIDABLE.map((f) => f.maxLength))`, i.e. 120, the
 *   widest limit any field declares. Both entries happen to declare 120, so the
 *   schema's bound was *identical* to every field's — which made the handler's
 *   per-field branch UNREACHABLE. A value of 121 characters is over its own
 *   field's limit AND over the blanket cap, so Zod answered first with
 *   `VALIDATION_FAILED` and the sentence that names *this* field's limit
 *   ("A custom vendor name may be at most 120 characters, and this one is 121")
 *   could never be produced. The client prints that number; the dead branch was
 *   the whole reason it existed. Measured, not theorised: the smoke control
 *   expecting `BAD_REQUEST` received `VALIDATION_FAILED`.
 *
 *   The rule the two bounds have to obey: a blanket schema bound must be LOOSER
 *   than the tightest business rule it can shadow, or the business rule can never
 *   speak. So this is a generous absolute ceiling — 1000, against a longest real
 *   value of 120 — and every per-field limit is enforced in the handler, one
 *   layer down, where the message can name the field. Nothing in the registry may
 *   ever approach this number; if one ever does, raise this rather than deriving
 *   it, because deriving it is exactly the defect described above.
 */
const MAX_VALUE = 1000;

/**
 * The longest key accepted, and it is a bound on the *shape*.
 *
 * The real key is a name copied from a register, so it is bounded by whatever that
 * register can hold. The longest name this ledger carries is 123 characters
 * (measured, `VENDOR_ID` 10049). 400 is a comfortable ceiling that still refuses a
 * body that is obviously not a name — and anything under it is folded to a key
 * whose own emptiness is checked in the handler, so a sender cannot smuggle a
 * subject in through a field that is nominally a name.
 */
const MAX_KEY = 400;

const OverrideSchema = z
  .object({
    subject: textReq('The kind of subject this override hangs off — `vendor` today.'),
    field: textReq('The field of the subject it overrides — `name` today.'),
    key: textReq(
      'The subject’s identity, folded (`keyOf(name)`: uppercased with every non-alphanumeric ' +
        'removed). **This is what the client matches on** — a vendor row carries the same fold as ' +
        'its `key` already, for grouping and for React keys, so the page joins the two without a ' +
        'lookup. Stored folded rather than as written, so two spellings of one company are one row.',
    ),
    written: text(
      'The same key as it was submitted, trimmed. Kept for one reason: this endpoint serves the ' +
        'whole subject, so an override whose company has left the register is still **served rather ' +
        'than dropped** — and the folded form is not a thing to show a reader. Null on a row written ' +
        'before the column existed, where the client falls back to the fold.',
    ),
    value: textReq('The reader’s value. Never blank — see the delete endpoint.'),
    setBy: textReq(
      'Who set it, as the session named them. **Never taken from the request body** — an override ' +
        'that could name its own author would carry no attribution worth having.',
    ),
    setAt: textReq('When, from the database clock. Not a timestamp this route computed.'),
  })
  .openapi('FieldOverrideRow');

/** The registry entry, as a reader of the API sees it — no functions on the wire. */
const OverridableSchema = z
  .object({
    subject: textReq('The subject kind.'),
    field: textReq('The overridable field.'),
    subjectWord: textReq(
      'A noun phrase for one record of this subject — “this vendor site”. The UI uses it when it ' +
        'has no ledger value to name the record with.',
    ),
    label: textReq('What to call it in the UI — a noun phrase: “vendor name”, not “name”.'),
    maxLength: z.number().int().openapi({ description: 'The longest value this field accepts.' }),
    fromLedger: z.boolean().openapi({
      description:
        'Whether the ledger holds a value for this field. `false` means the register carries no ' +
        'such column, so nothing is superseded and the empty state is a blank value rather than ' +
        'the ledger’s.',
    }),
    effect: textReq(
      'One sentence saying what the override does **not** change. Every one of these is about a ' +
        'lookup, a link or a grouping that keeps using the ledger’s value — the fact a reader who ' +
        'has just renamed something is most likely to be wrong about.',
    ),
  })
  .openapi('OverridableField');

const toWire = (r: OverrideDbRow) => ({
  subject: r.subject_kind,
  field: r.field,
  key: r.subject_key,
  written: r.subject_written,
  value: r.value,
  setBy: r.set_by,
  setAt: r.set_at,
});

const fieldWire = (f: OverridableField) => ({
  subject: f.subject,
  field: f.field,
  subjectWord: f.subjectWord,
  label: f.label,
  maxLength: f.maxLength,
  fromLedger: f.fromLedger,
  effect: f.effect,
});

/** The row for one field of one subject, or null. */
async function findByKey(
  entry: OverridableField,
  key: string,
): Promise<OverrideDbRow | null> {
  return one<OverrideDbRow>(
    `${ROW_SQL} WHERE subject_kind = :subject AND subject_key = :key AND field = :field`,
    { subject: entry.subject, key, field: entry.field },
  );
}

/**
 * Re-read after a write, or fail loudly.
 *
 * A write that cannot be read back is not a success. Returning the values the
 * caller sent would hide exactly that, and it would also hide the one thing this
 * response is for: `setAt` and `setBy` are computed here and nowhere else, so a
 * response built from the request would have to invent them.
 */
async function readBack(entry: OverridableField, key: string): Promise<ReturnType<typeof toWire>> {
  const stored = await findByKey(entry, key);
  if (!stored) {
    throw new AppError(
      500,
      'INTERNAL',
      `Wrote the custom ${entry.label} for key "${key}" but could not read it back.`,
    );
  }
  return toWire(stored);
}

export function registerCustomFields(api: Api): void {
  api.route({
    method: 'get',
    path: '/api/custom-fields',
    operationId: 'custom_fields_list',
    summary: 'The values this application holds in place of the ledger’s',
    description:
      'Every override stored for one subject, or for every subject when none is named.\n\n' +
      '**This returns the WHOLE subject, not the keys the caller asked about, and that is the ' +
      'design.** Overrides are a handful of rows a person bothered to write — hundreds, not ' +
      'millions — so filtering them by a list of keys would put 55 names in a query string to ' +
      'fetch three rows. More importantly it is the only shape that lets a caller see an override ' +
      'that **no longer matches anything**: a register is re-read from the ledger on every pull, a ' +
      'name can change under a row that was overridden, and no constraint in this database could ' +
      'notice. A key-filtered read would drop that row from the answer by construction, which is ' +
      'how a stale override becomes invisible rather than reported.\n\n' +
      '**A subject with nothing stored is an empty list, not a 404.** “Nobody has renamed ' +
      'anything” is a normal state of the register and not an error — a 404 would make the client ' +
      'distinguish *this build does not know custom fields* from *nothing has been saved*, and it ' +
      'cannot. A subject that carries **no overridable field at all** is a different question and ' +
      'is refused 400, because that is a typo as often as it is a stale client, and answering it ' +
      'with an empty list would be a silent no-op — the failure this feature exists to avoid.\n\n' +
      '`fields` reports what *can* be overridden, so a client does not have to hard-code the ' +
      'registry and a reader of this document can see what the answer would have been. It is the ' +
      'only part of this response that comes from this server’s own source rather than from the ' +
      'database.',
    tags: ['Admin'],
    query: z
      .object({
        subject: z
          .string()
          .trim()
          .min(1)
          .optional()
          .openapi({
            example: 'vendor',
            description:
              'The subject kind to read. Omitted means every subject. Case-insensitive; an unknown ' +
              'subject is refused rather than answered with an empty list.',
          }),
      })
      .openapi('CustomFieldsQuery'),
    response: z
      .object({
        overrides: z
          .array(OverrideSchema)
          .openapi({
            description:
              'Every stored override for the subject, in key order — including any whose key no ' +
              'longer matches a row in the register.',
          }),
        fields: z
          .array(OverridableSchema)
          .openapi({ description: 'What may be overridden, for this subject or for all of them.' }),
        subjects: z
          .array(textReq('A subject kind that carries at least one overridable field.'))
          .openapi({ description: 'The subject kinds that exist, so a refusal can name them.' }),
      })
      .openapi('CustomFieldsResponse'),
    errors: [400, 401, 500, 503],
    handler: async (ctx) => {
      // ★ THE GUARD FIRST, AND THE ORDER MATTERS. Zod has already run by the time
      //   this handler is reached, so a malformed anonymous body answers
      //   `VALIDATION_FAILED` before any admission is considered — the test suite
      //   pins that with its own assertion, because it is a property of the
      //   framework rather than of this file. Within the handler, admission is
      //   asked first on purpose: a signed-out caller should be told they are
      //   signed out, not told what state this server's app store is in.
      await requireActor(ctx.req);
      await requireAppSchema('Custom fields');

      const wanted = overridableSubject(ctx.query.subject ?? '');
      if (ctx.query.subject !== undefined && wanted === undefined) {
        // Not a 404: nothing named here is missing. It is a rule whose answer is
        // the registry — the same shape as an unlisted field on the write path —
        // and the message names the subjects that do exist rather than leaving the
        // caller to guess again.
        throw AppError.badRequest(
          `"${ctx.query.subject}" is not a subject this server holds custom values for, so there ` +
            'is nothing it could return.',
          { subjects: overridableSubjects() },
        );
      }

      // One read of the whole table when no subject is named, otherwise one
      // subject's rows. Either way the predicate is on a leading column of the
      // primary key, which is why no index beyond it exists. The bound subject is
      // the registry's spelling and never the caller's — see `overridableSubject`.
      const stored =
        wanted === undefined
          ? await rows<OverrideDbRow>(`${ROW_SQL} ORDER BY subject_kind, subject_key, field`)
          : await rows<OverrideDbRow>(
              `${ROW_SQL} WHERE subject_kind = :subject ORDER BY subject_key, field`,
              { subject: wanted },
            );

      return {
        overrides: stored.map(toWire),
        fields: (wanted === undefined ? [...OVERRIDABLE] : overridableIn(wanted)).map(fieldWire),
        subjects: overridableSubjects(),
      };
    },
  });

  api.route({
    method: 'put',
    path: '/api/custom-fields/{subject}/{field}',
    operationId: 'custom_fields_set',
    summary: 'Give a field a value of your own',
    description:
      'Stores a reader’s value for one field of one subject, creating it or replacing it.\n\n' +
      '**This is a `PUT` and it is deliberately not a `POST` + `PATCH` pair.** The client cannot ' +
      'know whether Save is a create or a replace — that is a fact about the store, not about the ' +
      'request — so guessing would produce a conflict on the second save of the same field. The ' +
      'row’s identity is the natural key `(subject, field, key)`, one request sets it, and saving ' +
      'the same value twice is the same request twice and changes nothing but the attribution.\n\n' +
      '**The ledger is not written to and no figure moves.** What is stored is a value to *show* ' +
      'in place of the ledger’s; the ledger’s value is what every lookup, link and grouping on the ' +
      'page still uses, and the response’s `fields[].effect` is the sentence the UI shows to say ' +
      'so.\n\n' +
      '**The key in the body is the subject’s identity, and the registry’s own fold is what is ' +
      'applied before it is stored** — for a vendor, uppercased with every non-alphanumeric ' +
      'removed, the same fold the client computes to identify the row; for a vendor site, the ' +
      'ledger’s numeric id, trimmed, because there is nothing to fold. Two spellings of one ' +
      'company are therefore one override rather than two. The vendor fold is a **measurement and ' +
      'not a guarantee**: it is injective on the data this page reads (0 of 157 names on the ' +
      'sample database and 0 of 55 on the FY27 extract fold alike), and two companies that folded ' +
      'together would share one value.\n\n' +
      '**A blank value is refused, and the refusal names the trash.** Clearing an override is ' +
      '`DELETE`; storing an empty string would be a third state that renders as a missing value, ' +
      'which is neither of the two things a reader can act on. The value is trimmed first, so a ' +
      'value of spaces is blank too.\n\n' +
      '**An unknown field is refused 400, listing what is overridable.** The pair is checked ' +
      'against a registry this server declares — see `../custom-fields/registry.ts` — because a ' +
      'row for a field no component reads is a save that appears to work and changes nothing on ' +
      'screen.',
    tags: ['Admin'],
    params: z
      .object({
        subject: z.string().min(1).openapi({ example: 'vendor', description: 'The subject kind.' }),
        field: z.string().min(1).openapi({ example: 'name', description: 'The field to override.' }),
      })
      .openapi('CustomFieldParams'),
    body: z
      .object({
        key: z
          .string()
          .trim()
          .min(1)
          .max(MAX_KEY)
          .openapi({
            example: 'ARENA PLACE CONDOMINIUM ASSOCIATION, INC',
            description:
              'The subject’s identity as the register carries it. Folded server-side before it is ' +
              'stored, so the value sent here and the value read back may differ in case and ' +
              'punctuation while being the same override.',
          }),
        value: z
          .string()
          .trim()
          .max(MAX_VALUE)
          .openapi({
            example: 'Arey Jones Educational Solutions',
            description:
              'The reader’s value. Trimmed before it is stored. Blank is refused by the handler ' +
              'with a message naming the trash — it is a value question, not a shape question, ' +
              'which is why the schema accepts it and the handler does not. The schema bound here ' +
              'is an abuse guard only, looser than every field’s own limit, so that an over-long ' +
              'value is refused by the handler with the field’s limit in the message rather than ' +
              'by the schema with none.',
          }),
      })
      .openapi('CustomFieldSet'),
    response: OverrideSchema,
    errors: [400, 401, 500, 503],
    handler: async (ctx) => {
      // Resolved once and kept: this handler needs the caller's identity twice —
      // once to admit them and once to attribute the row — and asking twice would
      // be two session reads for one question.
      const actor = await requireActor(ctx.req);
      await requireAppSchema('Custom fields');

      const { subject, field } = ctx.params as { subject: string; field: string };

      const entry = overridable(subject, field);
      if (!entry) {
        throw AppError.badRequest(
          `"${subject}.${field}" is not a field this server holds custom values for, so saving ` +
            'it would store a value nothing reads.',
          {
            subjects: overridableSubjects(),
            overridable: OVERRIDABLE.map(fieldWire),
          },
        );
      }

      const body = ctx.body as { key: string; value: string };

      if (body.value === '') {
        throw AppError.badRequest(
          `A blank custom ${entry.label} is not a delete. Use the trash to ` +
            // ★ WHAT THE TRASH LEAVES BEHIND IS THE FIELD'S OWN FACT, NOT A
            //   PREFERENCE: for a field the ledger holds, giving the value back
            //   means showing the ledger's; for one it does not hold, it means an
            //   empty field. The refusal is the sentence a reader is most likely
            //   to act on, so it names what actually happens.
            (entry.fromLedger
              ? 'show the value the ledger holds again.'
              : 'leave the field empty again.'),
          {
            subject: entry.subject,
            field: entry.field,
            howToDelete: 'DELETE /api/custom-fields/{subject}/{field}?key=…',
          },
        );
      }
      if (body.value.length > entry.maxLength) {
        throw AppError.badRequest(
          `A custom ${entry.label} may be at most ${entry.maxLength} characters, and this one is ` +
            `${body.value.length}.`,
          { maxLength: entry.maxLength, length: body.value.length },
        );
      }

      // ★ THE FOLD IS THE SUBJECT'S OWN, TAKEN FROM THE REGISTRY RATHER THAN
      //   ASSUMED HERE. A second subject whose identity is already a key needs no
      //   fold at all, and applying the vendor fold to it would store a key the
      //   page would never match — a save that appears to work. See the property's
      //   doc block in the registry. (It is now the second sentence of this
      //   category and not a hypothetical: `vendor_site` folds by trimming only.)
      const key = entry.keyOf(body.key);
      if (key === '') {
        // The schema accepted it (it is a non-empty string) and the fold removed
        // all of it — punctuation only. Storing this would be an override that
        // matches no row and that nothing on screen could explain. The sentence is
        // subject-neutral on purpose: it was written about vendors, and the second
        // subject's fold makes it unreachable, which is not a reason to leave a
        // message naming the wrong thing in a route two subjects share.
        throw AppError.badRequest(
          `"${body.key}" folds to nothing — every character in it is punctuation — so it would ` +
            'store a value that no row could ever match.',
          { key: body.key },
        );
      }

      // Upsert on the natural key. `set_at` is the database's clock and never a
      // timestamp computed here — the attribution should carry one clock, and this
      // file is not it. `subject_kind` and `field` are written from the REGISTRY's
      // spelling rather than the caller's, so the table cannot end up with two rows
      // differing only in case.
      await execute(
        `INSERT INTO field_override (subject_kind, subject_key, subject_written, field, value, set_by)
         VALUES (:subject, :key, :written, :field, :value, :setBy)
         ON CONFLICT (subject_kind, subject_key, field) DO UPDATE SET
           value = excluded.value,
           set_by = excluded.set_by,
           set_at = datetime('now'),
           subject_written = excluded.subject_written`,
        {
          subject: entry.subject,
          key,
          written: body.key,
          field: entry.field,
          value: body.value,
          // From the session, and the actor is resolved ONCE: a body field
          // claiming an author is not read, because an override that could name
          // its own author would carry no attribution worth having.
          setBy: actor.email,
        },
      );

      return readBack(entry, key);
    },
  });

  api.route({
    method: 'delete',
    path: '/api/custom-fields/{subject}/{field}',
    operationId: 'custom_fields_clear',
    summary: 'Stop substituting — show the ledger’s value again',
    description:
      'Removes a stored value, so the field renders exactly what the ledger holds.\n\n' +
      '**This is the trash, and it is the whole of what the trash does.** Nothing is written back ' +
      'to the ledger and nothing needs to be: the ledger’s value was never replaced, only covered, ' +
      'and there was deliberately **no copy of it kept in our table** — a cached copy would be a ' +
      'second source for a figure this application does not own, stale the moment the ledger was ' +
      're-extracted, and worse, it would make a delete mean *restore from our copy* rather than ' +
      '*stop substituting*. Which is why this is a `DELETE` and not a `PUT` with a null value: the ' +
      'row going away is the operation.\n\n' +
      'The key is a query parameter rather than a body, because a `DELETE` with a body is a shape ' +
      'some clients drop and some proxies discard.\n\n' +
      '**A key that was never overridden is 404, exactly as an already-deleted one is.** The row is ' +
      'read first so the two are answered identically — a second press of the trash, or a delete ' +
      'from a stale panel, says so rather than appearing to work. Answers 204 with no body.',
    tags: ['Admin'],
    params: z
      .object({
        subject: z.string().min(1).openapi({ example: 'vendor', description: 'The subject kind.' }),
        field: z.string().min(1).openapi({ example: 'name', description: 'The field to clear.' }),
      })
      .openapi('CustomFieldParams'),
    query: z
      .object({
        key: z
          .string()
          .trim()
          .min(1)
          .max(MAX_KEY)
          .openapi({
            example: 'ARENA PLACE CONDOMINIUM ASSOCIATION, INC',
            description:
              'The subject’s identity, folded server-side exactly as it is on the write path — so ' +
              'the key a client reads back from a save removes the row that save created.',
          }),
      })
      .openapi('CustomFieldClearQuery'),
    response: z.undefined(),
    status: 204,
    errors: [400, 401, 404, 500, 503],
    handler: async (ctx) => {
      await requireActor(ctx.req);
      await requireAppSchema('Custom fields');

      const { subject, field } = ctx.params as { subject: string; field: string };
      const { key: written } = ctx.query as { key: string };

      const entry = overridable(subject, field);
      if (!entry) {
        throw AppError.badRequest(
          `"${subject}.${field}" is not a field this server holds custom values for.`,
          { subjects: overridableSubjects(), overridable: OVERRIDABLE.map(fieldWire) },
        );
      }

      const key = entry.keyOf(written);

      // Read first, so a key that was never overridden is answered the same way an
      // already-cleared one is — 404 naming the key — rather than reporting a
      // delete that removed nothing as a success. The row itself is not needed;
      // this is about the answer, not the data.
      const existing = await findByKey(entry, key);
      if (!existing) throw AppError.notFound(`A custom ${entry.label} for "${written}"`);

      const result = await execute(
        'DELETE FROM field_override WHERE subject_kind = :subject AND subject_key = :key AND field = :field',
        { subject: entry.subject, key, field: entry.field },
      );

      // The row was read a moment ago, so zero rows here means somebody else
      // cleared it in between. Reporting the delete as done would be a lie the
      // reader could not check.
      if (result.rowsAffected === 0) {
        throw AppError.notFound(`A custom ${entry.label} for "${written}"`);
      }

      return undefined;
    },
  });
}
