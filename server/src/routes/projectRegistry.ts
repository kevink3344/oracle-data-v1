import { z } from '../http/z.js';
import type { Api } from '../http/api.js';
import { AppError } from '../http/errors.js';
import { bindable, execute, one, quoteIdent, rows, type Binds } from '../db/sql.js';
import { requireAppSchema } from '../db/app-schema.js';
import { intReq, text, textReq } from '../schemas/columns.js';
import { slugFor } from '../lib/slug.js';

/**
 * The project registry — the app-owned project master.
 *
 * ---------------------------------------------------------------------------
 * HOW THIS DIFFERS FROM `projects.ts`, WHICH IS THE NEXT FILE ALPHABETICALLY
 * ---------------------------------------------------------------------------
 * `projects.ts` serves the *EBS* project tables and the report's transcription.
 * Those tables are empty and nothing points into them, so it can describe the
 * shape of a project dimension but cannot name one. This module serves the
 * dimension the application owns instead: a name, a site, an owner, a note, and
 * the account level the project claims.
 *
 * The two are deliberately not merged. `projects.ts` answers "what does the
 * database hold?", and the honest answer is "nothing". This answers "what has the
 * app been told?", and the answer is fourteen rows — twelve with a level code and
 * two waiting for one. (This comment said "twelve" until the seed was counted:
 * `SELECT COUNT(*) FROM project` returns 14, and the two without a `level_code`
 * are the ones `counts.unassociated` exists to report. A figure in prose that is
 * not read back from the database is a figure that drifts.) Folding them together
 * would make one endpoint whose emptiness depends on which half you meant.
 *
 * ---------------------------------------------------------------------------
 * ★ THE `level_code` COLUMN IS THE WHOLE DESIGN
 * ---------------------------------------------------------------------------
 * A project is not a row in Oracle — Oracle has no project field anywhere in the
 * extract. A project in this app is a **named account level**: the 4-digit
 * `SEGMENT5` value, which is the only project identity the ledger actually
 * carries. So `level_code` is the join key between this table and the ledger, and
 * it is NULLABLE because a project can be recorded before it is coded. The two
 * rows that have no level are the point of that: "Buffalo Bills Stadium" exists
 * as a name, and somebody will decide which level funds it later.
 *
 * That is why `counts.unassociated` is returned rather than left for the caller
 * to compute. It is not an error count — it is the queue of recorded-but-uncoded
 * projects, and it is expected to be non-zero.
 *
 * ---------------------------------------------------------------------------
 * ★ WHY THIS TABLE HAS NO `organization_id`, SINCE EVERY OTHER APP TABLE NOW DOES
 * ---------------------------------------------------------------------------
 * The registry is **global across organizations**, deliberately, and the plan
 * says so in its own words (`docs/plans/organizations.md`, non-goals) rather than
 * leaving it to be inferred from a missing column:
 *
 *   "It does not invent multi-tenant data isolation. There is one extract;
 *    therefore one tenant's worth of rows at a time. An organization's scope
 *    *selects from* the extract, it does not partition a shared one. Two
 *    organizations that need different rows need two extracts."
 *
 * A tenant is a (fund, programs, start FY) tuple applied to the ledger, and
 * that tuple is what decides which PO lines a tenant sees. The levels those lines
 * are coded to are the same levels for everybody, because there is one extract
 * and it *is* one tenant's. Adding a tenant column here would not isolate
 * anything the scope does not already isolate, and it would take a project away
 * from a tenant whose own orders are booked to it — which is the failure the
 * scope exists to avoid.
 *
 * ★ So if a later change wants this table scoped, the change is probably a second
 *   extract, not a column. The same note is beside the table in
 *   `data/sql/turso/01-app.sql`, where somebody about to add a column will be
 *   looking.
 *
 * ---------------------------------------------------------------------------
 * ★ RECORDING AND CODING ARE TWO WRITES, AND THAT IS THE POINT
 * ---------------------------------------------------------------------------
 * `POST /api/projects` records a project: a name, a note and an owner, all of
 * which come from the person doing it. It does **not** touch `level_code`, so the
 * row it creates is uncoded by construction and lands in the queue above.
 *
 * `PATCH /api/projects/{slug}` edits a project, and `level_code` is one of the
 * columns it can edit. Associating a level is therefore an ordinary update rather
 * than a second kind of endpoint — but it is the only column here checked against
 * anything outside this table, and those three checks are why the write endpoint
 * took as long to arrive as it did:
 *
 *   1. **The level has to exist.** `GL_CODE_COMBINATIONS.SEGMENT5` is the ledger's
 *      own vocabulary; binding a level no account combination carries would
 *      produce a project that can never match a row, which is worse than no
 *      project at all. The same value set `/api/coa/levels` reports is consulted.
 *   2. **A level belongs to one project.** `level_code` carries a `UNIQUE` in the
 *      DDL, so the database would refuse a second claim anyway — but the database
 *      refusing it produces `constraint failed: project.level_code`, while the
 *      useful sentence names the project that already holds it. So the conflict is
 *      detected first, named, and answered 409.
 *   3. **The display code follows the level, and names nothing inside it.** `code`
 *      is `CC-<level>` — a function of `level_code` alone, derived on write rather
 *      than trusted from the request. It used to be the anchor object's
 *      `CC-<level>-<object>`, which wrote one of the level's accounts into the
 *      field every screen reads as the level's own name: `0450` then looked like a
 *      claim on `527` while 526, 529 and 532 were just as much its own. An account
 *      without a level is still a contradiction, so clearing `level_code` clears
 *      `code` with it rather than leaving a code pointing at nothing.
 *
 *      See the code example on `PATCH /api/projects/{slug}`.
 *
 *      ⚠ **The seed predates this rule.** Measured, not recalled
 *      (`SELECT code, COUNT(*) FROM project WHERE code IS NOT NULL GROUP BY 1`):
 *      ten of the twelve coded rows seeded by `data/sql/turso/01-app.sql` carry
 *      the superseded `CC-<level>-<object>` form — `CC-0450-527` is not among
 *      them, but `CC-0454-527`, `CC-1420-541`, `CC-2594-523` and seven more are.
 *      Nothing breaks: `code` is display-only, and it is overwritten the first
 *      time a row's level is re-associated. But a reader comparing the table to
 *      this comment would find the table wanting, so: **if the seed is re-cut, it
 *      should store `CC-<level>`.**
 *
 *      ⚠⚠ And the shipped `sample.db` holds **two rows the seed does not create**:
 *      `athens-drive-hs` (created 2026-09-19 13:05:47) and `garner-hs-track`
 *      (13:50:07), both owned by "Dana Whitfield", the first describing itself as
 *      "also a test for linking / unlinking projects in the app". They are
 *      residue from a browser session that POSTed against the sample file, which
 *      is why `SELECT COUNT(*) FROM project` answers **14** while
 *      `01-app.sql` inserts **12**. `garner-hs-track` is also the single row
 *      carrying the modern `CC-2436` form — it was written by this server, not by
 *      the seed, which is exactly what you would expect and is why the count of
 *      old-form rows is ten and not eleven. Anything that asserts a project count
 *      against the sample should either tolerate these two or the sample should be
 *      rebuilt from the seed.
 *
 * Writes require the app schema and are refused whenever the connection is not
 * writable — the same `writesGuard` every other write in this server passes
 * through, so under `DB_MODE=oracle` these answer 503 like the rest.
 */

/** One row of the registry, as the table stores it. */
interface RegistryDbRow {
  slug: string;
  name: string;
  description: string | null;
  level_code: string | null;
  code: string | null;
  site: string | null;
  owner: string | null;
  created_at: string | null;
  updated_at: string | null;
}

const ROW_SQL =
  'SELECT slug, name, description, level_code, code, site, owner, created_at, updated_at';

/**
 * The row as the wire carries it, defined once because three endpoints return it
 * and a second definition would be a second thing to keep in step.
 *
 * ★ The `slug` description changed when the write endpoint arrived. It used to
 *   read "Never changes; the name might", which was true while the only writer was
 *   a seed file — and it is still true, because a PATCH renames the project and
 *   leaves the key alone. But now that keys are minted from names at runtime, the
 *   sentence has to say *why*: the key is what survives a rename, so it is derived
 *   once and never recomputed.
 */
const RowSchema = z
  .object({
    slug: textReq(
      'Stable key, derived from the name when the project is recorded and never recomputed. A rename ' +
        'changes `name` and leaves this alone, because this is what other records would point at.',
    ),
    name: textReq('What the project is called.'),
    description: text(
      'The note transcribed from the design mockup, or null. Null is not "no note" — for an uncoded ' +
        'project it means nobody has written one yet.',
    ),
    levelCode: text(
      'The 4-digit `SEGMENT5` value this project claims, or null when not yet associated. **The join ' +
        'key to the ledger** — see the endpoint description.',
    ),
    code: text(
      'The display code (`CC-0454`). Derived from `levelCode` and nothing else, so it is null exactly ' +
        'when `levelCode` is null. The level names the project; the accounts inside it are the ' +
        'ledger\'s, and are read per level rather than encoded into this string.',
    ),
    site: text('The campus or campuses. Null when not yet described.'),
    owner: text('The named owner, or null.'),
    createdAt: text('When the row was created.'),
    updatedAt: text('When the row was last changed.'),
  })
  .openapi('ProjectRegistryRow');

const toWire = (r: RegistryDbRow) => ({
  slug: r.slug,
  name: r.name,
  description: r.description,
  levelCode: r.level_code,
  code: r.code,
  site: r.site,
  owner: r.owner,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/**
 * `North Garner MS – Renovation` → `north-garner-ms-renovation`.
 *
 * The rule now lives in `../lib/slug.js` because the organization register needs
 * the same one: a tenant key is derived from a tenant name in exactly the way a
 * project key is derived from a project name. It is imported rather than copied
 * because **a key that is nearly the same rule is still a different key** — two
 * copies free to drift would eventually produce `morrisville-hs-h-14` from one
 * endpoint and `morrisville-hs-h14` from the other for the same name, and the
 * failure would be a 404 on a row the list had just shown.
 */

/** The row with this slug, or null. */
async function findBySlug(slug: string): Promise<RegistryDbRow | null> {
  return one<RegistryDbRow>(`${ROW_SQL} FROM project WHERE slug = :slug`, { slug });
}

/**
 * Re-read after a write, or fail loudly. A write that cannot be read back is not
 * a success, and returning the values the caller sent would hide that.
 */
async function readBack(slug: string): Promise<ReturnType<typeof toWire>> {
  const stored = await findBySlug(slug);
  if (!stored) {
    throw new AppError(500, 'INTERNAL', `Wrote project "${slug}" but could not read it back.`);
  }
  return toWire(stored);
}

export function registerProjectRegistry(api: Api): void {
  api.route({
    method: 'get',
    path: '/api/projects/registry',
    operationId: 'projects_registry',
    summary: 'The project master the application owns',
    description:
      'Every project the app has been told about, name-ordered.\n\n' +
      '**This is the only source of project names in the system.** Oracle has none: four EBS tables model a ' +
      'project dimension and all four are empty, and `PROJECT_ID`/`TASK_ID` are NULL on all 1,141,913 ' +
      '`PO_LINES_ALL` rows and all 1,159,988 `PO_DISTRIBUTIONS_ALL` rows, so there is no link to recover either. ' +
      'The project master is supplied as a separate SQLite table instead — the decision of record in ' +
      '`00-schema.sql` section 4.\n\n' +
      '**`level_code` is the join to the ledger and it is nullable.** A project is a *named account level*: ' +
      '`level_code` is the 4-digit `SEGMENT5` value through which the project is visible in `GL_BALANCES` and in ' +
      'the PO extract. It is null when the project has been recorded but not yet associated with a level, which ' +
      'is a first-class state rather than missing data — the name arrives before the coding does. ' +
      '`counts.unassociated` reports how many are in that state, and it is expected to be non-zero.\n\n' +
      '**A project with no `level_code` cannot appear in the Projects table**, because that table is built from ' +
      'the levels the PO extract carries and a project with no level has no level to appear under. It is shown ' +
      'on the Projects screen in a list of its own, "Recorded, not yet coded", which reads this response — that ' +
      'list, not this endpoint, is where the state is visible to a user.\n\n' +
      '**Nothing numeric is stored here.** Lines, orders, vendors, amounts, dates and active/dormant status are ' +
      'all derived from the PO extract at read time; a stored total would go stale the next time the extract is ' +
      'refreshed.\n\n' +
      'These rows are not read-only — a project is recorded with `POST /api/projects`, edited, including the ' +
      'association of an account level, with `PATCH /api/projects/{slug}`, and removed with ' +
      '`DELETE /api/projects/{slug}`. The last two are the pair that is easy to confuse, so: a **release** ' +
      '(`PATCH` with `"levelCode": null`) keeps the row and gives the level back, and a **delete** (`DELETE`) ' +
      'removes the row as well. Neither one writes to Oracle.',
    tags: ['Projects'],
    response: z
      .object({
        items: z
          .array(RowSchema)
          .openapi({ description: 'Every project, ordered by name.' }),
        counts: z
          .object({
            total: intReq('Rows in the registry.'),
            associated: intReq('Rows with a non-null `levelCode` — projects that appear in the Projects list.'),
            unassociated: intReq(
              'Rows with a null `levelCode` — recorded but not yet coded. Not an error count; it is the work queue.',
            ),
          })
          .openapi('ProjectRegistryCounts'),
      })
      .openapi('ProjectRegistryResponse'),
    errors: [500, 503],
    handler: async () => {
      await requireAppSchema('The project registry');

      const items = await rows<RegistryDbRow>(`${ROW_SQL} FROM project ORDER BY name`);

      const total = items.length;
      const associated = items.filter((r) => r.level_code !== null).length;

      return {
        items: items.map(toWire),
        counts: { total, associated, unassociated: total - associated },
      };
    },
  });

  api.route({
    method: 'post',
    path: '/api/projects',
    operationId: 'projects_create',
    summary: 'Record a project',
    description:
      'Inserts a project into the app-owned master and returns the stored row.\n\n' +
      '**This records; it does not code.** `level_code` and `code` are left NULL, so the project it creates ' +
      'cannot appear in the Projects table until a level is associated through `PATCH /api/projects/{slug}`. ' +
      'That is deliberate, and it is the order the work happens in: the name is known before the funding ' +
      'account is. The created row appears immediately in the "Recorded, not yet coded" list on the Projects ' +
      'screen.\n\n' +
      '**`slug` is derived from the name, never supplied.** `North Garner MS – Renovation` becomes ' +
      '`north-garner-ms-renovation` by the same rule the seeded rows follow. A name whose key is already taken ' +
      'is refused 409 naming the clash — **the key is the natural key and the name is not**, because an ' +
      'operator will edit a name and nothing should break when they do.\n\n' +
      '**`owner` is whatever the caller sends, and that is now a known gap rather than a design.** This ' +
      'route still requires no session — none of the project endpoints do — so the server cannot derive the ' +
      'owner from the caller and stores what it is told. The paragraph that used to stand here said "there is ' +
      'no authentication in this slice"; there is now (`POST /api/auth/sign-in`, the `x-app-session` header, ' +
      '`requireActor` in `auth/guard.ts`), so the sentence is false even though this route behaves the same. ' +
      'The honest statement is: **the identity exists and this endpoint does not use it.** Closing that gap ' +
      'means defaulting `owner` to the signed-in user and dropping the field from the body, which changes the ' +
      'contract, so it is left for the pass that adds sessions to the project screens rather than smuggled in ' +
      'here.',
    tags: ['Projects'],
    body: z
      .object({
        name: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .openapi({
            example: 'Buffalo Bills Stadium',
            description: 'What the project is called. Required, and the source of the key.',
          }),
        description: z
          .string()
          .trim()
          .max(4000)
          .nullable()
          .optional()
          .openapi({
            description:
              'The staff-maintained note. Optional — a project can be recorded before anyone writes one, and ' +
              'the form sends null rather than an empty string so "no note yet" stays distinguishable.',
          }),
        owner: z
          .string()
          .trim()
          .max(120)
          .nullable()
          .optional()
          .openapi({
            description:
              'Who holds the project. **Supplied by the client, not derived from the session** — this route ' +
              'requires no session yet; see the endpoint description.',
          }),
      })
      .openapi('ProjectCreate'),
    response: RowSchema,
    errors: [400, 409, 500, 503],
    handler: async (ctx) => {
      await requireAppSchema('The project registry');

      const body = ctx.body as { name: string; description?: string | null; owner?: string | null };
      const name = body.name.trim();
      const slug = slugFor(name);

      if (slug === '') {
        throw AppError.badRequest(
          'That name has no letters or digits in it, so it has no stable key. Give the project a name that ' +
            'can be turned into one.',
          { name },
        );
      }

      const clash = await findBySlug(slug);
      if (clash) {
        throw AppError.conflict(
          `A project already exists with the key "${slug}" — "${clash.name}". Keys are derived from names, so ` +
            'two projects cannot share one. Give this project a name that distinguishes it; if the two really ' +
            'are the same project, edit the existing row instead of adding a second.',
          { slug, existing: clash.name },
        );
      }

      await execute(
        'INSERT INTO project (slug, name, description, owner) VALUES (:slug, :name, :description, :owner)',
        {
          slug,
          name,
          description: bindable(body.description ?? null),
          owner: bindable(body.owner ?? null),
        },
      );

      return readBack(slug);
    },
  });

  api.route({
    method: 'patch',
    path: '/api/projects/{slug}',
    operationId: 'projects_update',
    summary: 'Edit a project, including associating an account level',
    description:
      'Partial update: only the supplied fields change. `null` clears a column and omitting a field leaves it ' +
      'alone, so "released the level" and "did not mention the level" are different requests producing ' +
      'different rows.\n\n' +
      '**`levelCode` is the field this endpoint exists for**, and it is the only one checked against anything ' +
      'outside this table. Three rules apply, and each answers with a sentence rather than a constraint name:\n\n' +
      '1. **The level must exist in the ledger.** It is checked against the `SEGMENT5` values actually present ' +
      'in `GL_CODE_COMBINATIONS` — the same vocabulary `GET /api/coa/levels` reports. A level no account ' +
      'combination carries is refused 409, because binding it would create a project that can never match a row.\n' +
      '2. **A level belongs to one project.** If another project already holds it the request is refused 409 ' +
      'naming that project. This is the `UNIQUE` on `level_code` said out loud: the database would refuse it ' +
      'too, but it would say `constraint failed: project.level_code` and leave the reader to find out who holds it.\n' +
      '3. **`code` follows `levelCode`, and is derived from it.** Clearing the level clears the display ' +
      'code with it; setting one stores `CC-<level>`, computed here rather than taken from the request, so ' +
      'a row can never carry a `CC-` string belonging to a level it no longer claims.\n\n' +
      '**Releasing is `{"levelCode": null}` and it is not a delete.** The row keeps its name, its note and its ' +
      'owner and goes back into the uncoded queue; the ledger is untouched either way. Removing the row itself ' +
      'is `DELETE /api/projects/{slug}`, and the two are different requests with different consequences — ' +
      'releasing keeps everything the reader typed, and deleting keeps nothing. Neither one touches Oracle.',
    tags: ['Projects'],
    params: z
      .object({ slug: z.string().min(1).openapi({ description: 'The project key.' }) })
      .openapi('ProjectSlugParams'),
    body: z
      .object({
        name: z.string().trim().min(1).max(200).optional().openapi({ description: 'A new display name.' }),
        description: z
          .string()
          .trim()
          .max(4000)
          .nullable()
          .optional()
          .openapi({ description: 'Replace the note, or clear it with `null`.' }),
        site: z
          .string()
          .trim()
          .max(200)
          .nullable()
          .optional()
          .openapi({ description: 'The campus or campuses. Not collected when the project is first recorded.' }),
        owner: z.string().trim().max(120).nullable().optional().openapi({ description: 'Who holds it.' }),
        levelCode: z
          .string()
          .trim()
          .regex(/^[0-9]{4}$/)
          .nullable()
          .optional()
          .openapi({
            example: '0454',
            description:
              'The 4-digit `SEGMENT5` value to bind, or `null` to release the level this project holds.',
          }),
        code: z
          .string()
          .trim()
          .max(80)
          .nullable()
          .optional()
          .openapi({
            example: 'CC-0454',
            description:
              'The display code. **Derived server-side from `levelCode` on write, so a value sent here is ' +
              'ignored** — the row is stored with `CC-<level>`, which means a client still sending the old ' +
              '`CC-<level>-<object>` form cannot put one account back on the row.',
          }),
      })
      .openapi('ProjectUpdate'),
    response: RowSchema,
    errors: [400, 404, 409, 500, 503],
    handler: async (ctx) => {
      await requireAppSchema('The project registry');

      const { slug } = ctx.params as { slug: string };
      const body = ctx.body as {
        name?: string;
        description?: string | null;
        site?: string | null;
        owner?: string | null;
        levelCode?: string | null;
        code?: string | null;
      };

      const existing = await findBySlug(slug);
      if (!existing) throw AppError.notFound(`Project ${slug}`);

      const sets: string[] = [];
      const args: Binds = { slug };

      if (body.name !== undefined) {
        sets.push('name = :name');
        args.name = body.name.trim();
      }
      if (body.description !== undefined) {
        sets.push('description = :description');
        args.description = bindable(body.description);
      }
      if (body.site !== undefined) {
        sets.push('site = :site');
        args.site = bindable(body.site);
      }
      if (body.owner !== undefined) {
        sets.push('owner = :owner');
        args.owner = bindable(body.owner);
      }

      if (body.levelCode !== undefined) {
        const level = body.levelCode === null ? null : body.levelCode.trim();

        if (level === null) {
          // Releasing. The code has to go with the level it was derived from.
          sets.push('level_code = NULL', 'code = NULL');
        } else {
          const claim = await one<{ slug: string; name: string }>(
            'SELECT slug, name FROM project WHERE level_code = :level',
            { level },
          );
          if (claim && claim.slug !== slug) {
            throw AppError.conflict(
              `Level ${level} is already held by "${claim.name}". A level funds one project at a time, so that ` +
                'project has to release it before it can be bound here.',
              { levelCode: level, heldBy: claim.slug },
            );
          }

          // ★ The ledger is the authority on what a level code is, not this
          //   table. A code no account combination carries would produce a
          //   project that can never match a row — rule 1 above.
          const inLedger = await one(
            `SELECT 1 AS ok FROM ${quoteIdent('GL_CODE_COMBINATIONS')} ` +
              `WHERE ${quoteIdent('SEGMENT5')} = :level LIMIT 1`,
            { level },
          );
          if (!inLedger) {
            throw AppError.conflict(
              `Level ${level} is not a Level code any account combination carries, so a project bound to it ` +
                'would never match a row in the ledger. Check the code against `GET /api/coa/levels`.',
              { levelCode: level },
            );
          }

          sets.push('level_code = :level');
          args.level = level;

          // ★ DERIVED HERE, NOT TAKEN FROM THE REQUEST. `code` is a function of
          //   `level_code` and of nothing else, so storing it this way holds the
          //   invariant whatever the client sends — and it is also what clears the
          //   `-<object>` suffix an earlier save wrote under the old rule, because
          //   `level_code` is the only input. A level is four digits and `CC-` is the
          //   prefix every screen already shows, so there is nothing to look up and
          //   nothing to keep in step.
          sets.push('code = :code');
          args.code = `CC-${level}`;
        }
      } else if (body.code !== undefined) {
        // A bare code is only meaningful when the project already holds a level;
        // otherwise it would anchor to nothing, which is the state rule 3 exists
        // to prevent.
        if (body.code !== null && existing.level_code === null) {
          throw AppError.badRequest(
            'A display code was supplied without a level. `code` is derived from `levelCode`, so setting one ' +
              'on a project that holds no level would leave a code pointing at nothing.',
            { code: body.code },
          );
        }
        sets.push('code = :code');
        args.code = bindable(body.code);
      }

      if (sets.length === 0) {
        throw AppError.badRequest('No fields were supplied.', {
          accepts: ['name', 'description', 'site', 'owner', 'levelCode', 'code'],
        });
      }

      sets.push("updated_at = datetime('now')");

      await execute(`UPDATE project SET ${sets.join(', ')} WHERE slug = :slug`, args);
      return readBack(slug);
    },
  });

  api.route({
    method: 'delete',
    path: '/api/projects/{slug}',
    operationId: 'projects_delete',
    summary: 'Delete a project',
    description:
      '**This removes the app’s own row and nothing else.** A project is a name this application puts on an ' +
      'account level: there is no ledger row that refers to it, no table anywhere in the schema holds a foreign ' +
      'key to it, and Oracle has no project dimension for it to be a copy of — `PROJECT_ID` is NULL on every PO ' +
      'line and every distribution, which is the reason this table exists at all. So the whole of a delete is one ' +
      '`DELETE FROM project`, and **deleting a project changes no figure in the ledger**: every order, line, ' +
      'budget and amount on the level it was associated with stays exactly where it was. What disappears is the ' +
      'app’s claim on a level, not the level’s money.\n\n' +
      '**Deleting releases the account level.** `level_code` is `UNIQUE`, so removing the row that held `0454` ' +
      'makes `0454` claimable again in the same transaction. On the Projects screen the level goes back to being ' +
      'an unclaimed level read from its purchase-order lines, and any project may now be associated with it ' +
      'through `PATCH /api/projects/{slug}`. A project that held no level is simply gone from the ' +
      '“Recorded, not yet coded” list.\n\n' +
      '**This is not `{"levelCode": null}`, and the difference is the whole of what is kept.** A release ' +
      '(`PATCH`) holds on to the name, the note and the owner and puts the row back in the uncoded queue, so ' +
      'rebinding the level restores exactly what was there. A delete removes those as well, and there is no ' +
      'archive behind it: the name, the note and the owner are gone, and re-recording the project through ' +
      '`POST /api/projects` starts from nothing. Use the release when the association is wrong and the delete ' +
      'when the project itself is.\n\n' +
      '**A seeded project comes back if the database is rebuilt.** `01-app.sql` seeds twelve projects with ' +
      '`INSERT OR IGNORE`, so deleting one of those removes it from *this* database and not from the seed. ' +
      'That is the intended behaviour of a default, not a durability promise: the registry is the running ' +
      'app’s data, and applying the sample DDL to a fresh file is a different act from deleting a row.\n\n' +
      'Answers 204 with no body. Deleting a key that does not exist is 404 rather than a silent success, so a ' +
      'second delete of the same project, or a delete from a stale list, says so instead of appearing to work.',
    tags: ['Projects'],
    params: z
      .object({ slug: z.string().min(1).openapi({ description: 'The project key.' }) })
      .openapi('ProjectSlugParams'),
    response: z.undefined(),
    status: 204,
    errors: [404, 500, 503],
    handler: async ({ params: path }) => {
      await requireAppSchema('The project registry');

      // Read first, so a key that was never a project is answered the same way a
      // key that was already deleted is — 404, naming the key — rather than
      // reporting a write that removed nothing as a success.
      const existing = await findBySlug(path.slug);
      if (!existing) throw AppError.notFound(`Project ${path.slug}`);

      // ★ NO CHILD ROWS ARE CLEANED UP, AND THIS IS A MEASURED FACT RATHER THAN AN
      //   ASSUMPTION. Nothing in `01-app.sql` declares a foreign key to `project`:
      //   the table is addressed by `slug` from links and from saved views, never
      //   by a constraint, so there is no orphan to leave behind and none of the
      //   explicit child deletes `DELETE /api/views/{id}` needs. If a later
      //   migration gives a project children, this handler is where the promise
      //   "deleting a project leaves nothing of it" gets kept.
      const result = await execute('DELETE FROM project WHERE slug = :slug', { slug: path.slug });

      // The row was read a moment ago, so zero rows here means somebody else
      // deleted it in between. Reporting the delete as done would be a lie the
      // reader could not check.
      if (result.rowsAffected === 0) throw AppError.notFound(`Project ${path.slug}`);

      return undefined;
    },
  });
}
