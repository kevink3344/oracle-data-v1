import { z } from '../http/z.js';
import type { Api } from '../http/api.js';
import { AppError } from '../http/errors.js';
import { bindable, execute, one, quoteIdentFor, rows, stampNow } from '../db/sql.js';
import { requireAppSchema } from '../db/app-schema.js';
import { isUniqueViolation } from '../db/constraint.js';
import { requireActor, requireSuperAdmin } from '../auth/guard.js';
import { IdParamsSchema } from '../schemas/common.js';

/**
 * Integrations: the external endpoints this deployment is wired to.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS — A REGISTER OF INTENT, AND THE COPY SAYS SO
 * ---------------------------------------------------------------------------
 * One row per outbound endpoint: a title, what it is for, the URL, and whether it
 * is meant to be live. Nothing in this application calls any of them. The table is
 * a *record*, the screen is an index over the record, and the two are useful on
 * their own: the question this feature answers is "what is this deployment wired
 * to, and who turned it off?", which is a question about intentions and has an
 * answer that does not require an HTTP client.
 *
 * ★ THE ONE THING THIS FILE MUST NOT DO IS IMPLY IT KNOWS MORE THAN IT DOES. There
 *   is no `status` field and no reachability check, because a real one would need
 *   an outbound call — timeouts, retries, credentials, SSRF — which is a different
 *   feature with a different threat model. A placeholder that reads "Not verified"
 *   would be worse than the absence: it reads as "unknown but probably fine",
 *   which is a softer version of a claim this app cannot support. So the response
 *   carries two *string* facts and one *field* fact, and none of them is a claim
 *   about the world:
 *
 *     - `urlWellFormed` — the stored string parses as an absolute http/https URL.
 *     - `active`        — the flag on the row. `Active` is what somebody decided.
 *
 *   The screen's URL hint carries the same sentence the reader needs: *"Stored and
 *   shown. This app does not call it — Active records an intention, not a working
 *   connection."*
 *
 * ---------------------------------------------------------------------------
 * ★ `title` IS UNIQUE, AND THE RULE IS ENFORCED TWICE ON PURPOSE
 * ---------------------------------------------------------------------------
 * Titles identify a row here — nothing links to an integration by URL and there is
 * no slug — so two rows may not share one. That rule is held in two places, and
 * neither is redundant:
 *
 *   1. **A `LOWER(title)` comparison in the handler**, which is what makes the
 *      three dialects agree. MySQL and SQL Server compare text case-insensitively
 *      by default and SQLite compares it case-*sensitively*, so leaning on the
 *      index alone would make "Payroll" and "payroll" the same row in two engines
 *      and two rows in the third — the same input, three behaviours. Comparing
 *      `LOWER()` explicitly fixes that in the query. (A per-dialect `COLLATE`
 *      clause would also work and is rejected: it puts dialect knowledge in a
 *      route, which is the layering this repo keeps out of `routes/`.)
 *
 *   2. **The `UNIQUE` constraint as the backstop.** The pre-check and the insert
 *      are two statements, and the gap between them is a race two administrators
 *      can lose. This is the only mechanism that can actually hold the rule, and
 *      `isUniqueViolation` is what turns its refusal into a named 409 instead of a
 *      500.
 *
 * ---------------------------------------------------------------------------
 * ★★ THE URL IS VALIDATED AND THEN NEVER FOLLOWED — AND THE VALIDATION IS THE
 *    SECURITY CONTROL
 * ---------------------------------------------------------------------------
 * `checkUrl` allows exactly two schemes and requires a host. That allowlist is
 * what keeps a `javascript:` or `data:` string out of the table, and it is
 * therefore what keeps the row from becoming a stored-XSS payload the moment
 * anything renders it as a link. Today nothing does — the screen shows the URL as
 * text in a `<code>` element — and the point of checking now is that a later
 * consumer must not be the first thing to notice. Same reasoning as `ident()` for
 * identifiers: validate at the boundary.
 *
 * `https` is *preferred* and `http` is *allowed*, because an internal webhook on a
 * private network is a real and common case; refusing it would push people to
 * store a broken `https` URL instead, which is worse than an honest `http` one.
 */

// ---------------------------------------------------------------------------
// The row, and the wire shape
// ---------------------------------------------------------------------------

interface IntegrationDbRow {
  id: number;
  title: string;
  description: string;
  url: string;
  /** 0/1 in every dialect — `TINYINT(1)`, `INT`, and SQLite's `INTEGER`. */
  active: number;
  set_by: string;
  created_at: string;
  updated_at: string;
}

/**
 * The column list, quoted for the dialect of the store the table is in.
 *
 * ★ A FUNCTION RATHER THAN A MODULE CONSTANT, AND `quoteIdentFor` RATHER THAN
 *   `quoteIdent`. The constant would read the dialect while modules are still
 *   initialising, and the single-argument form quotes for the *ledger's* dialect —
 *   correct only while `APP_DB_URL` is unset and the two stores happen to be the
 *   same engine, which is the shipped configuration rather than a property worth
 *   relying on. `saved_view` is the other app table that had to learn this: its
 *   `sql` column is a MySQL reserved word.
 */
function integrationColumns(): string {
  return ['id', 'title', 'description', 'url', 'active', 'set_by', 'created_at', 'updated_at']
    .map((column) => quoteIdentFor('app', column))
    .join(', ');
}

/** `SELECT … FROM integration`, in this deployment's dialect. */
function integrationSelect(): string {
  return `SELECT ${integrationColumns()} FROM ${quoteIdentFor('app', 'integration')}`;
}

/**
 * The columns an `INSERT` writes, which is deliberately *not* `integrationColumns()`.
 *
 * ★ `id`, `created_at` AND `updated_at` ARE ABSENT AND THAT IS THE POINT. The
 *   identity is assigned by the database (`AUTOINCREMENT` / `AUTO_INCREMENT` /
 *   `IDENTITY`), and the two timestamps are stamped by the column `DEFAULT`s, which
 *   are spelled per dialect in `data/sql/turso|sqlserver|mysql/01-app.sql` precisely
 *   so the database's clock does it. Listing all eight columns and binding seven
 *   values is the bug this function exists to make impossible: it is a compile
 *   error here and a "column count doesn't match value count" from MySQL at
 *   runtime.
 */
function integrationInsertColumns(): string {
  return ['title', 'description', 'url', 'active', 'set_by', 'created_at', 'updated_at']
    .map((column) => quoteIdentFor('app', column))
    .join(', ');
}

/**
 * Row → wire. The one place an `integration` row becomes a response.
 *
 * ★ `urlWellFormed` IS RECOMPUTED FROM THE STORED STRING ON EVERY READ, NOT
 *   STORED. A row can outlive the rule it was written under — a URL accepted
 *   before the scheme allowlist existed, or written by hand — and a stored
 *   boolean would then report the old rule to the reader forever. Recomputing
 *   means the badge always describes the string in front of it, and that the badge
 *   and the save path can never disagree, since both call the same function.
 *
 * ★ THE `active` CONVERSION IS `=== 1`, MATCHING `organizations.ts`. The three
 *   dialects return this column as a number — MySQL's `TINYINT(1)` is not
 *   `typeCast`-ed to a boolean in this driver — so a truthiness test would be
 *   fine today and wrong the day a driver starts answering `'0'`, which is a
 *   non-empty string and therefore true.
 */
function toWire(row: IntegrationDbRow) {
  return {
    id: Number(row.id),
    title: row.title,
    description: row.description,
    url: row.url,
    urlWellFormed: checkUrl(row.url).ok,
    active: Number(row.active) === 1,
    setBy: row.set_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// The URL check
// ---------------------------------------------------------------------------

/**
 * Whether a string is a URL this app will store, and what to say if it is not.
 *
 * ★ THE MESSAGE NAMES THE PROBLEM, NOT THE FIELD. A validation refusal is read by
 *   whoever is filling in the form, and "invalid URL" tells them nothing they did
 *   not already suspect. Each branch says which rule was broken — no scheme, the
 *   wrong scheme, no host — and the parse branch echoes the string, because the
 *   usual cause is a missing scheme (`payroll.example.com/hook` parses as a
 *   *relative path*, not as a URL).
 *
 * ★ THE EMPTY HOST CHECK IS REACHABLE AND NOT DEAD CODE. `new URL('http://')`
 *   parses — the `URL` constructor accepts it and reports an empty
 *   `host` — so without this branch an unclickable, unroutable row would be
 *   stored as well-formed.
 */
function checkUrl(raw: string): { ok: true; value: string } | { ok: false; problem: string } {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, problem: 'The URL is required.' };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      problem: `"${trimmed}" is not a URL. Include the scheme, e.g. https://host/path.`,
    };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      ok: false,
      problem: `"${parsed.protocol}" is not a scheme this app stores. Use https (preferred) or http.`,
    };
  }
  if (parsed.host === '') return { ok: false, problem: 'The URL has no host.' };
  return { ok: true, value: trimmed };
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

/**
 * The row with this title, by the *uniqueness* rule — case-insensitively.
 *
 * ★ THE LOWER-CASED VALUE IS BOUND RATHER THAN WRAPPING THE COLUMN IN A FUNCTION
 *   IN THE BIND, but the column is still wrapped: `LOWER(title) = :title` with
 *   `title` already lowered. The alternative is a database-side `LOWER(:title)`,
 *   which is a second function call evaluated per candidate row and which MySQL
 *   and SQLite spell identically only by luck.
 *
 * ★ THE FUNCTION ON THE LEFT MEANS THE UNIQUE INDEX CANNOT BE USED, AND THAT IS
 *   ACCEPTED. This is a pre-check whose purpose is a good sentence, not a
 *   performance path, and the table holds tens of rows. The index is not made
 *   useless by this — the *constraint* is what actually holds the rule, and it is
 *   enforced on the column itself.
 *
 * ★ THE RULE IS TOTAL ON ASCII ONLY, IN SQLITE. `LOWER()` in SQLite lowercases
 *   ASCII and leaves other characters alone, while `String.toLowerCase()` here
 *   does not — so a title differing only in a non-ASCII case is caught in MySQL
 *   and SQL Server and may slip through the SQLite pre-check. It cannot become a
 *   duplicate: SQLite's index is `BINARY`, so it sees the two as different too,
 *   which is exactly the same answer this pre-check gives. The two agree, which is
 *   what matters; making them disagree would need a `COLLATE NOCASE` index, and
 *   `NOCASE` is ASCII-only as well.
 */
async function findByTitle(title: string): Promise<IntegrationDbRow | null> {
  return one<IntegrationDbRow>(
    `${integrationSelect()} WHERE LOWER(${quoteIdentFor('app', 'title')}) = :title LIMIT 1`,
    { title: title.toLowerCase() },
  );
}

/** The row with this id, or null. */
async function findById(id: number): Promise<IntegrationDbRow | null> {
  return one<IntegrationDbRow>(`${integrationSelect()} WHERE ${quoteIdentFor('app', 'id')} = :id`, {
    id,
  });
}

/**
 * Re-read after a write, or fail loudly.
 *
 * ★ CREATES RE-READ **BY TITLE, NOT BY `lastInsertRowid`**, AND THAT IS NOT A
 *   STYLE CHOICE. `lastInsertRowid` is `null` on SQL Server — `db/sqlserver.ts`
 *   says so at the point it returns it — so the identity of a row just inserted
 *   cannot be read off the write. `routes/users.ts` reached the same conclusion
 *   and re-reads by the unique address for the same reason. Here the title is the
 *   unique text key, and it is matched *exactly*: the handler has just inserted
 *   that string, so an exact comparison names the row it wrote, where the
 *   case-insensitive form would be answering a different question.
 *
 * A write that cannot be read back is not a success. Returning the values the
 * caller sent would hide that, and would also hide the server-computed
 * `urlWellFormed`.
 */
async function readBackById(id: number) {
  const stored = await findById(id);
  if (!stored) {
    throw new AppError(500, 'INTERNAL', `Wrote integration ${id} but could not read it back.`);
  }
  return toWire(stored);
}

async function readBackByTitle(title: string) {
  const stored = await one<IntegrationDbRow>(
    `${integrationSelect()} WHERE ${quoteIdentFor('app', 'title')} = :title LIMIT 1`,
    { title },
  );
  if (!stored) {
    throw new AppError(
      500,
      'INTERNAL',
      `Created integration "${title}" but could not read it back. The title is unique, so this ` +
        'means the row is not there rather than that it is ambiguous.',
    );
  }
  return toWire(stored);
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const IntegrationSchema = z
  .object({
    id: z.number().int().openapi({ example: 1, description: 'The row identity.' }),
    title: z
      .string()
      .openapi({ example: 'Payroll webhook', description: 'What a person calls it by. Unique.' }),
    description: z
      .string()
      .openapi({ description: 'What it is for. Required — see the endpoint description.' }),
    url: z
      .string()
      .openapi({ example: 'https://payroll.example.com/hook', description: 'The endpoint.' }),
    /**
     * ★ THE STRING IS VALID AND WELL-FORMED — NOT THAT THE ENDPOINT ANSWERS.
     *
     * Computed by `checkUrl()` on every read, from the stored string. Same
     * function the write path validates with, so the badge and the save cannot
     * disagree.
     */
    urlWellFormed: z.boolean().openapi({
      description:
        'Whether the stored string parses as an absolute `http`/`https` URL with a host. ' +
        '**Not** a statement that the endpoint is reachable — this app never calls it.',
    }),
    active: z.boolean().openapi({
      description:
        'The stored flag. `Active` records an intention, not a working connection; a row ' +
        'created without this field is inactive.',
    }),
    setBy: z.string().openapi({
      description:
        'The email of the super admin who last wrote the row. Answers "who turned this off?", ' +
        'which is the first question asked when an integration is unexpectedly inactive.',
    }),
    createdAt: z.string().openapi({ description: 'When the row was created (UTC, no zone marker).' }),
    updatedAt: z.string().openapi({ description: 'When the row was last changed.' }),
  })
  .openapi('Integration');

const IntegrationListSchema = z
  .object({
    items: z.array(IntegrationSchema),
    counts: z.object({
      total: z.number().int().openapi({ description: 'Every row in the register.' }),
      active: z.number().int().openapi({ description: 'The rows whose flag is on.' }),
    }),
  })
  .openapi('IntegrationList');

/**
 * The fields a caller may write, and the *limits the columns actually have*.
 *
 * ★ THE WIDTHS ARE ENFORCED HERE, AND THE REASON IS THAT MYSQL WOULD NOT. Every
 *   string column in `data/sql/<dialect>/01-app.sql` is bounded — `VARCHAR(200)`,
 *   `NVARCHAR(1000)` — and a value over the bound is an error on SQL Server and
 *   *a silent truncation* on a MySQL server not running in strict mode. Accepting
 *   the value and storing a shortened version of it would be the worst of the
 *   three answers: no error, no record, and a URL that no longer parses. So the
 *   bound is a validation rule, and the caller is told which field is too long.
 */
const IntegrationBodySchema = z.object({
  title: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .openapi({
      example: 'Payroll webhook',
      description:
        'What a person calls it by. Required, unique case-insensitively, and at most 200 ' +
        'characters.',
    }),
  description: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .openapi({
      example: 'Posts approved timesheets to the payroll provider every night.',
      description:
        'What it is for, at most 1000 characters. Required: an endpoint with no stated purpose ' +
        'is a URL nobody can safely remove.',
    }),
  url: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .openapi({
      example: 'https://payroll.example.com/hook',
      description:
        'The endpoint, at most 2000 characters. Must be an absolute URL with an `http` or ' +
        '`https` scheme and a host — see `POST` for why the scheme is allowlisted.',
    }),
});

const IntegrationCreateSchema = IntegrationBodySchema.extend({
  active: z.boolean().optional().openapi({
    description: 'Omit for `false`. **A row is created inactive unless this says otherwise.**',
  }),
}).openapi('IntegrationCreate');

const IntegrationUpdateSchema = IntegrationBodySchema.extend({
  /**
   * ★ REQUIRED ON `PUT` AND OPTIONAL ON `POST`, WHICH IS NOT AN INCONSISTENCY.
   *
   * On create, omitting it means "use the column's default", and the default is
   * off — a safe direction that also answers the common case, since a row is
   * usually written before it is switched on.
   *
   * On a replace there is no default to fall back on that would not discard the
   * value already stored, and `active` is the one field where a silent change is
   * worst: it is the answer to "is our payroll webhook on?". A `PUT` body is the
   * row's new state, and a state that omits a field is not a state.
   */
  active: z.boolean().openapi({
    description: 'The row\'s new flag. Required — a `PUT` body is the row\'s whole state.',
  }),
}).openapi('IntegrationUpdate');

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerIntegrations(api: Api): void {
  api.route({
    method: 'get',
    path: '/api/integrations',
    operationId: 'integrationsList',
    summary: 'Every integration, newest first',
    description:
      'The whole register. Any signed-in account may read it: an integration is not a secret, ' +
      'and a member who cannot see the list cannot answer "is our payroll webhook on?" — which ' +
      'is the question this page exists to answer. Writes are super-admin only.\n\n' +
      '★ **`urlWellFormed` IS A FACT ABOUT A STRING, NOT ABOUT THE WORLD.** It says the stored ' +
      'URL parses as an absolute `http`/`https` URL with a host. Nothing here has contacted ' +
      'the endpoint, and nothing in this application will: there is no outbound HTTP client in ' +
      'this feature, on purpose. `active` is likewise the stored flag — the intention somebody ' +
      'recorded, not a measure of health.',
    tags: ['Admin'],
    response: IntegrationListSchema,
    errors: [401, 500, 503],
    handler: async ({ req }) => {
      await requireActor(req);
      await requireAppSchema('The integrations register');

      /**
       * ★ `ORDER BY id DESC` IS "NEWEST FIRST", AND IT IS THE HONEST SPELLING.
       *   `created_at` is stamped as `YYYY-MM-DD HH:MM:SS` — whole seconds, and
       *   the formats differ slightly between the dialect arms — so an ordering on
       *   it would tie for any two rows added in the same second and would then
       *   fall back to whatever order the engine produced. The identity column is
       *   monotonic per insert, which is the order the rows were actually added.
       */
      const stored = await rows<IntegrationDbRow>(
        `${integrationSelect()} ORDER BY ${quoteIdentFor('app', 'id')} DESC`,
      );
      const items = stored.map(toWire);

      return {
        items,
        // ★ THE COUNTS COME FROM THE SAME ARRAY THE LIST DOES, NOT FROM A SECOND
        //   QUERY. Two statements could report three rows and a count of four —
        //   the head line would contradict the table under it — and the register
        //   is read whole anyway.
        counts: {
          total: items.length,
          active: items.filter((item) => item.active).length,
        },
      };
    },
  });

  api.route({
    method: 'get',
    path: '/api/integrations/{id}',
    operationId: 'integrationGet',
    summary: 'One integration',
    description:
      'A single row by identity. Any signed-in account may read it, for the reason given on the ' +
      'list endpoint. `urlWellFormed` and `active` mean what they mean there.',
    tags: ['Admin'],
    params: IdParamsSchema,
    response: IntegrationSchema,
    errors: [400, 401, 404, 500, 503],
    handler: async ({ req, params }) => {
      await requireActor(req);
      await requireAppSchema('The integrations register');

      const found = await findById(params.id);
      // `AppError.notFound` appends " was not found.", so the sentence reads
      // `Integration 7 was not found.` rather than repeating the word.
      if (!found) throw AppError.notFound(`Integration ${params.id}`);
      return toWire(found);
    },
  });

  api.route({
    method: 'post',
    path: '/api/integrations',
    operationId: 'integrationCreate',
    summary: 'Add an integration',
    description:
      'Super admin only, matching every other admin register: a member may see what the ' +
      'deployment talks to, but only a super admin may change it.\n\n' +
      '★ **THE URL IS CHECKED AND THEN NEVER FOLLOWED, AND THE CHECK IS THE SECURITY ' +
      'CONTROL.** Only `https` and `http` are accepted, and the host must be non-empty. A ' +
      'stored `javascript:` or `data:` URL is a stored-XSS payload the moment anything renders ' +
      'it as a link; nothing renders it as a link today — the screen shows it as text — and the ' +
      'allowlist is what keeps that from being the only thing standing in the way. `https` is ' +
      'preferred but `http` is allowed, because an internal webhook on a private network is a ' +
      'real case and refusing it would only produce a broken `https` row instead.\n\n' +
      '★ **A DUPLICATE TITLE IS A NAMED `409`, NOT A `500`.** Titles identify a row, so two may ' +
      'not share one. The check is case-insensitive on purpose — MySQL and SQL Server compare ' +
      'text case-insensitively by default and SQLite does not, so leaning on the index alone ' +
      'would give the same input three different answers. A `UNIQUE` constraint backs the ' +
      'check, because the check and the insert are two statements and two administrators can ' +
      'race between them.\n\n' +
      '★ **`active` DEFAULTS TO `false`.** A gate that opens by default is not a gate, and an ' +
      'unreviewed row should not be live.',
    tags: ['Admin'],
    body: IntegrationCreateSchema,
    response: IntegrationSchema,
    errors: [400, 401, 403, 409, 500, 503],
    handler: async ({ req, body }) => {
      const actor = await requireSuperAdmin(req, 'the integrations register');
      await requireAppSchema('The integrations register');

      // The body schema has already trimmed and bounded these; `checkUrl` is the
      // rule it cannot express, because it is about the value's *shape*.
      const title = body.title;
      const checked = checkUrl(body.url);
      if (!checked.ok) {
        throw AppError.validation(checked.problem, { field: 'url', value: body.url });
      }

      const clash = await findByTitle(title);
      if (clash) {
        throw AppError.conflict(
          `An integration called "${clash.title}" already exists. Titles identify a row here, ` +
            'so two integrations cannot share one — rename this one, or edit the existing row.',
          { title: clash.title, existingId: clash.id },
        );
      }

      const binds = {
        title,
        description: body.description,
        url: checked.value,
        // ★ `bindable` TURNS THE BOOLEAN INTO 0/1, BECAUSE libSQL REFUSES A BOOLEAN
        //   BIND OUTRIGHT — it takes `string | number | bigint | ArrayBuffer | null`
        //   and throws at the driver rather than answering with a validation
        //   message. The other two arms would accept a boolean, so passing one is
        //   the kind of bug that only appears on one deployment.
        active: bindable(body.active ?? false),
        // ★ THE EMAIL, NOT THE NAME. This field answers "who turned this off?" — a
        //   question asked about an account, and two people can share a display
        //   name where two people cannot share an address.
        setBy: actor.email,
        // The `created_at`/`updated_at` DEFAULTS in the DDL stamp the insert, the
        // same division of labour `organizations.ts` uses: only the *update* path
        // has to restamp, because no default fires on an `UPDATE`.
      };

      try {
        await execute(
          `INSERT INTO ${quoteIdentFor('app', 'integration')} ` +
            `(${integrationInsertColumns()}) VALUES (:title, :description, :url, :active, :setBy, ` +
            `${stampNow()}, ${stampNow()})`,
          binds,
        );
      } catch (e) {
        // The backstop for the race the pre-check cannot close. Without this the
        // race is a 500, and the administrator is told the database refused the
        // write rather than which title collided.
        if (isUniqueViolation(e)) {
          throw AppError.conflict(
            `An integration called "${title}" already exists. Titles identify a row here, so two ` +
              'integrations cannot share one — rename this one, or edit the existing row.',
            { title },
          );
        }
        throw e;
      }

      return readBackByTitle(title);
    },
  });

  api.route({
    method: 'put',
    path: '/api/integrations/{id}',
    operationId: 'integrationUpdate',
    summary: 'Replace an integration',
    description:
      'Super admin only. This is a `PUT`, so the body is the row\'s new state and every field is ' +
      'required — including `active`, which is optional on `POST`. See the request schema for ' +
      'why: on create, omitting the flag means the column default, which is off; on a replace ' +
      'there is no default that would not silently discard what is stored, and `active` is the ' +
      'one field where a silent change is worst.\n\n' +
      'The URL is revalidated on every write, so a row cannot be edited around the scheme ' +
      'allowlist. A title change is checked for a collision with **another** row, ' +
      'case-insensitively; renaming a row to its own title in different case is allowed, since ' +
      'that is still one row and refusing it would make a typo fix impossible.',
    tags: ['Admin'],
    params: IdParamsSchema,
    body: IntegrationUpdateSchema,
    response: IntegrationSchema,
    errors: [400, 401, 403, 404, 409, 500, 503],
    handler: async ({ req, params, body }) => {
      const actor = await requireSuperAdmin(req, 'the integrations register');
      await requireAppSchema('The integrations register');

      const existing = await findById(params.id);
      if (!existing) throw AppError.notFound(`Integration ${params.id}`);

      const checked = checkUrl(body.url);
      if (!checked.ok) {
        throw AppError.validation(checked.problem, { field: 'url', value: body.url });
      }

      /**
       * ★ THE COLLISION CHECK EXCLUDES THIS ROW, AND THAT IS THE WHOLE POINT OF IT
       *   BEING A QUERY RATHER THAN `findByTitle`. The row being edited matches its
       *   own title on every save that does not rename it, so a check that did not
       *   exclude it would refuse every edit — including the one that only flips
       *   `active`, which is the most common edit there is.
       */
      const clash = await one<IntegrationDbRow>(
        `${integrationSelect()} WHERE LOWER(${quoteIdentFor('app', 'title')}) = :title ` +
          `AND ${quoteIdentFor('app', 'id')} <> :id LIMIT 1`,
        { title: body.title.toLowerCase(), id: params.id },
      );
      if (clash) {
        throw AppError.conflict(
          `An integration called "${clash.title}" already exists. Titles identify a row here, ` +
            'so two integrations cannot share one — rename this one, or edit the existing row ' +
            `(#${clash.id}) instead of adding a second name for the same endpoint.`,
          { title: clash.title, existingId: clash.id },
        );
      }

      const binds = {
        title: body.title,
        description: body.description,
        url: checked.value,
        active: bindable(body.active),
        setBy: actor.email,
        id: params.id,
      };

      try {
        await execute(
          `UPDATE ${quoteIdentFor('app', 'integration')} SET ` +
            `${quoteIdentFor('app', 'title')} = :title, ` +
            `${quoteIdentFor('app', 'description')} = :description, ` +
            `${quoteIdentFor('app', 'url')} = :url, ` +
            `${quoteIdentFor('app', 'active')} = :active, ` +
            `${quoteIdentFor('app', 'set_by')} = :setBy, ` +
            // ★ RESTAMPED BY THE DATABASE, NOT BY THIS PROCESS. `stampNow()` is the
            //   dialect's own "now" — `UTC_TIMESTAMP()`, `CONVERT(…GETUTCDATE()…120)`
            //   and `datetime('now')` — so a row written here compares and sorts
            //   beside one written by any other arm. A JS-supplied timestamp would be
            //   the app server's clock and its own format.
            `${quoteIdentFor('app', 'updated_at')} = ${stampNow()} ` +
            `WHERE ${quoteIdentFor('app', 'id')} = :id`,
          binds,
        );
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw AppError.conflict(
            `An integration called "${body.title}" already exists. Titles identify a row here, ` +
              'so two integrations cannot share one — rename this one, or edit the existing ' +
              'row instead.',
            { title: body.title },
          );
        }
        throw e;
      }

      return readBackById(params.id);
    },
  });

  api.route({
    method: 'delete',
    path: '/api/integrations/{id}',
    operationId: 'integrationDelete',
    summary: 'Remove an integration',
    description:
      'Super admin only. A hard delete, matching every other admin register — nothing references ' +
      'an integration, so there is no history a soft delete would be preserving.\n\n' +
      '★ **A MISS IS `removed: false`, NOT A `404`.** Deleting a row that is already gone is not ' +
      'an error, and answering `404` would force the caller to treat "somebody else deleted it a ' +
      'moment ago" as a failure to report. The response says what happened either way.\n\n' +
      '★ **`200` WITH A BODY, NOT THE `204` A DELETE DEFAULTS TO.** A `204` carries no payload ' +
      'at all, so `removed` would have nowhere to live and the distinction above would be ' +
      'unreportable. `routes/readCaps.ts` made the same choice for the same reason.',
    tags: ['Admin'],
    params: IdParamsSchema,
    response: z
      .object({
        id: z.number().int().openapi({ description: 'The identity that was asked for.' }),
        removed: z.boolean().openapi({
          description: 'Whether a row was actually deleted. `false` means there was nothing there.',
        }),
      })
      .openapi('IntegrationRemoved'),
    status: 200,
    errors: [400, 401, 403, 500, 503],
    handler: async ({ req, params }) => {
      await requireSuperAdmin(req, 'the integrations register');
      await requireAppSchema('The integrations register');

      const result = await execute(
        `DELETE FROM ${quoteIdentFor('app', 'integration')} WHERE ${quoteIdentFor('app', 'id')} = :id`,
        { id: params.id },
      );

      return { id: params.id, removed: result.rowsAffected > 0 };
    },
  });
}
