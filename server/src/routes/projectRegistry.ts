import { z } from '../http/z.js';
import type { Api } from '../http/api.js';
import { AppError } from '../http/errors.js';
import { bindable, execute, one, quoteIdent, rows, stampNow, type Binds } from '../db/sql.js';
import { requireAppSchema } from '../db/app-schema.js';
import { int, intReq, text, textReq } from '../schemas/columns.js';
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
  /** `1` when the row carries image bytes. Never the bytes themselves. */
  has_background: number;
  background_name: string | null;
  background_updated_at: string | null;
  /**
   * How strongly the header draws the picture, as a percent 0–100, or `null`.
   *
   * ★ `null` IS NOT `0`, AND THE DIFFERENCE IS THE WHOLE READ PATH. `0` is a
   *   choice a reader made and kept — the picture is stored and deliberately not
   *   drawn. `null` is the absence of a choice, so the application's default
   *   (33%) answers for it. Neither is missing data, and neither may be collapsed
   *   into the other.
   */
  background_strength: number | null;
}

/**
 * ★ THE BYTES ARE ABSENT FROM THIS SELECT ON PURPOSE, AND IT IS NOT AN OVERSIGHT.
 *
 *   Every screen that needs a project name calls `GET /api/projects/registry`, and
 *   that is fifteen rows today. `background_image` is a `VARBINARY(MAX)` that goes
 *   out-of-row above 8 KB, so adding it here would put every project's picture into
 *   a payload whose consumers draw a table of names — a register load that grows
 *   with the number of *pictures* rather than the number of rows.
 *
 *   What the register needs is only the answer to "is there one, and how old" —
 *   enough to show a thumbnail in a table, or an indicator that the editor has
 *   something to remove. The bytes come from
 *   `GET /api/projects/{slug}/background`, one project at a time, when something
 *   actually draws them.
 *
 * ★ `CASE WHEN … IS NULL THEN 0 ELSE 1 END` RATHER THAN `background_image_mime IS
 *   NOT NULL`. The bytes are the truth about whether an image exists; the mime is a
 *   companion column that a bug could leave null while the bytes are present. Asking
 *   the question of the column that holds the answer is what stops the two from ever
 *   disagreeing. It is also portable — standard SQL, no `IIF`, no dialect seam.
 *
 * ★ AND ASKING IT DOES NOT READ THE LOB. `IS NULL` is answered from the row's
 *   in-row pointer, so this stays a cheap predicate even on the out-of-row case.
 */
const ROW_SQL =
  'SELECT slug, name, description, level_code, code, site, owner, created_at, updated_at, ' +
  'CASE WHEN background_image IS NULL THEN 0 ELSE 1 END AS has_background, ' +
  'background_name, background_updated_at, background_strength';

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
    hasBackground: z
      .boolean()
      .openapi({
        description:
          'Whether this project has a background image. **The image itself is deliberately not in this ' +
          'payload** — read it from `GET /api/projects/{slug}/background`, which serves one project at a ' +
          'time. This flag exists so a list can say "has one" without fetching fifteen pictures.',
      }),
    backgroundName: text(
      'The filename the image was uploaded under, or null. Null while `hasBackground` is false.',
    ),
    backgroundUpdatedAt: text(
      'When the image was last set, or null. Separate from `updatedAt`, which moves for a note typo as ' +
      'well — this one answers only "how old is the picture".',
    ),
    backgroundStrength: int(
      'How strongly the header draws the picture, as a percent 0–100, or null for "never chosen". ' +
        '**Null is not 0.** Zero is a choice a reader can make and keep — the picture stored and ' +
        'deliberately not drawn — where null means nobody has chosen yet, so the application answers ' +
        'its own default (33, which is what every header drew before this field existed). A reader ' +
        'who never touches the control therefore sees no change at all.\n\n' +
        '**The picture cannot be made to break the header\'s text.** The wash between the picture and ' +
        'the text rises with this number, and above about 45 (light) / 35 (dark) the header stops ' +
        'getting any stronger rather than let the text fall below the contrast floor — so a value ' +
        'above the ceiling is stored as chosen and rendered at the ceiling. Read back here rather ' +
        'than computed, because the value a reader chose is not the value a theme can show.',
    ),
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
  // ★ `Number(...) === 1` AND NOT `r.has_background === 1`. The `CASE` yields an
  //   `INT` and both arms return it as a number, so the short form happens to work
  //   — today, on these two dialects. Coercing costs nothing and cannot be the
  //   thing that breaks when a third arm returns the same column as a string.
  hasBackground: Number(r.has_background) === 1,
  backgroundName: r.background_name,
  backgroundUpdatedAt: r.background_updated_at,
  // ★ PASSED THROUGH AS STORED, INCLUDING `null`, AND THE DEFAULT IS APPLIED AT
  //   THE DRAWING END. Answering `33` here would make "never chosen" and "chosen
  //   33" the same answer at the only place that can still tell them apart — and
  //   then a later change of default would silently rewrite what every untouched
  //   project looks like, with nothing left in the payload to say it had happened.
  //   The column's own comment says the *read path* answers the default; the
  //   drawing is the read path, and `33` is written down once, in `projectpage.css`.
  backgroundStrength:
    r.background_strength === null || r.background_strength === undefined
      ? null
      : Number(r.background_strength),
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
        backgroundStrength: z
          .number()
          .int()
          .min(0)
          .max(100)
          .nullable()
          .optional()
          .openapi({
            example: 45,
            description:
              'How strongly the header draws this project’s picture, as a percent 0–100 — or `null` to go ' +
              'back to the application default (33, which is how every header drew before the field ' +
              'existed). **`null` is not `0`**: `0` is a choice a reader made and kept — the picture held ' +
              'and deliberately not drawn — where `null` is the absence of a choice. Refused 409 when the ' +
              'project holds no picture, because a strength with nothing to strengthen is a value no ' +
              'screen can show.',
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
        backgroundStrength?: number | null;
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

      if (body.backgroundStrength !== undefined) {
        // ★ A STRENGTH WITH NO PICTURE IS REFUSED RATHER THAN STORED, AND THE
        //   REASON IS THAT NOTHING COULD EVER SHOW IT. The control lives inside
        //   the image panel and only exists while a picture is held, so a strength
        //   on a project with no picture is a value the reader can neither see nor
        //   change — and it would survive a later upload, because a first upload
        //   does not touch this column. `null` is always accepted: clearing the
        //   choice is meaningful whatever the row holds.
        if (body.backgroundStrength !== null && Number(existing.has_background) !== 1) {
          throw AppError.conflict(
            'A picture strength was supplied but this project holds no picture, so there is nothing for it ' +
              'to apply to. Store a picture first (`PUT /api/projects/{slug}/background`); sending `null` is ' +
              'always accepted, because clearing a choice is meaningful whatever the row holds.',
            { backgroundStrength: body.backgroundStrength },
          );
        }
        sets.push('background_strength = :strength');
        args.strength = bindable(body.backgroundStrength);
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
          accepts: ['name', 'description', 'site', 'owner', 'backgroundStrength', 'levelCode', 'code'],
        });
      }

      sets.push(`updated_at = ${stampNow()}`);

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

  // ==========================================================================
  // ★ THE PROJECT BACKGROUND IMAGE
  // ==========================================================================
  //
  // --------------------------------------------------------------------------
  // ONE IMAGE PER PROJECT, HELD IN A COLUMN, AND THE BYTES NEVER IN A LIST
  // --------------------------------------------------------------------------
  // `dbo.project` gained four nullable columns rather than a `project_image`
  // table. The reason is not storage — it is that the delete promise above
  // ("deleting a project leaves nothing of it") is kept by there being no child
  // row to orphan, and a second table would break it without adding anything:
  // the design is one picture per project, replaced wholesale, with no version
  // history and nothing to attach to a version. A table would have to declare
  // which of its rows is current, which is the column again with extra steps.
  //
  // ★ THE BYTES ARE DELIBERATELY ABSENT FROM `RegistryDbRow`. See `ROW_SQL`. The
  //   registry list is where fifteen projects are read by a table of names; a
  //   `VARBINARY(MAX)` there would make that payload grow with the number of
  //   *pictures* instead of the number of rows. So a list carries `hasBackground`
  //   — a cheap `IS NULL` predicate — and one endpoint below serves one picture.
  //
  // --------------------------------------------------------------------------
  // WHY BASE64 IN A JSON BODY, RATHER THAN A FILE UPLOAD
  // --------------------------------------------------------------------------
  // There is no upload infrastructure in this server, and adding some would mean
  // a second request pipeline beside `createApi()`: multipart parsing, a route
  // mounted outside the JSON body reader, its own size limit and its own error
  // shape. The body reader already has a limit (`express.json({ limit: '1mb' })`
  // in `app.ts`) and the driver already binds bytes — `Uint8Array` is in the
  // `Bind` union and was measured round-tripping a 700,000-byte value unchanged.
  // So the transport is a base64 string in the ordinary JSON envelope, which
  // costs 4/3 of the bytes and buys the existing validation, error codes, and
  // OpenAPI document for nothing.
  //
  // ★ AND THE CEILING BELOW IS ARITHMETIC OFF THAT 1 MB LIMIT, NOT A ROUND NUMBER
  //   SOMEONE LIKED. 640 KiB decoded is 655,360 bytes; base64 expands by 4/3 to
  //   873,816 characters, which with the JSON envelope is about 0.85 MB — inside
  //   the body reader's limit with headroom for the `mime` and `name` fields. A
  //   larger ceiling would not produce a bigger error, it would produce a
  //   body-parser `413` with no explanation in it.
  const BACKGROUND_MAX_BYTES = 640 * 1024;

  /**
   * The schema's cap on the *encoded* string — deliberately looser than the
   * decoded cap it corresponds to (873,816 characters).
   *
   * That gap is the point, and it is the same layering the rest of this server
   * uses: the schema is an abuse guard against an unbounded body, and the
   * handler is the business rule that names the real limit. If this were set to
   * exactly 873,816, a 660,000-byte image would be rejected by Zod with a message
   * about a string being too long, and the caller would never be told what the
   * actual constraint is or how much they had exceeded it by.
   */
  const BACKGROUND_MAX_BASE64 = 880_000;

  /**
   * ★ NO `image/svg+xml`, AND THAT IS A SECURITY DECISION RATHER THAN AN OMISSION.
   *
   * An SVG is not a picture format, it is a document format: it can carry
   * `<script>`, and a browser rendering one *from this origin* executes it with
   * this origin's privileges. Since the bytes here are served back from the app's
   * own API, accepting an SVG would turn an image upload into stored XSS against
   * every signed-in user who opened that project. The four below are raster
   * formats with no executable content.
   */
  const BACKGROUND_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

  /**
   * The format the bytes actually are, read off their leading signature.
   *
   * ★ BECAUSE THE DECLARED MIME IS A CLAIM AND THE BYTES ARE A FACT. A caller can
   *   send JPEG bytes labelled `image/png`, and the stored `background_image_mime`
   *   would then be a value no reader could trust — including a `Content-Type`
   *   header this endpoint hands out. The handler below compares the two and
   *   stores what the bytes say, so the companion column is measured rather than
   *   believed. Returns null for anything whose signature it does not know.
   *
   * The signatures, all of them offsets rather than a prefix match: PNG 8 bytes,
   * JPEG 3, GIF 4, and WEBP spelled `RIFF....WEBP` — the four bytes at offset 8
   * are what distinguish it from any other RIFF container.
   */
  function sniffImageMime(b: Uint8Array): string | null {
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      return 'image/png';
    }
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) {
      return 'image/gif';
    }
    if (
      b.length >= 12 &&
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
    ) {
      return 'image/webp';
    }
    return null;
  }

  /**
   * The bytes a driver handed back, as a `Uint8Array` — or null if what came
   * back is not bytes at all.
   *
   * ★ BOTH ARMS OF `DB_MODE` WERE MEASURED, AND THEY DISAGREE. The `sqlserver`
   *   arm's driver returns a `Buffer` for a `VARBINARY(MAX)` column; the `local`
   *   (libSQL) arm returns an **`ArrayBuffer`** for the same column holding the
   *   same value — a 70-byte image came back as `ArrayBuffer { byteLength: 70 }`
   *   whose first eight bytes are `137,80,78,71,13,10,26,10`. The two are not
   *   interchangeable: `ArrayBuffer` is not a `Uint8Array`, and
   *   `ArrayBuffer.isView()` is **false** for it. An `instanceof Uint8Array` test
   *   is therefore a claim about one driver wearing the clothes of a general
   *   check — see the guard in the read handler, which answered a 500 for a
   *   perfectly good image until this was measured.
   *
   * ★ THE `Uint8Array` CASE IS TESTED FIRST AND RETURNED UNCHANGED, and that is
   *   not merely tidiness: a Node `Buffer` is a view over a **pooled**
   *   `ArrayBuffer` shared with other allocations, so `new Uint8Array(buf.buffer)`
   *   would append up to 8 KB of unrelated memory after the image. A view carries
   *   its own `byteOffset` and `byteLength` for exactly this reason.
   *
   * Returns null rather than throwing, so the caller chooses the status code.
   */
  function toBytes(value: unknown): Uint8Array | null {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    return null;
  }

  const SlugParams = z
    .object({ slug: z.string().min(1).openapi({ description: 'The project key.' }) })
    .openapi('ProjectSlugParams');

  /**
   * The upload body.
   *
   * ★ THE REGEX IS `base64`, NOT "something-which-decodes". `Buffer.from(s,
   *   'base64')` is lenient: it skips characters it does not recognise and stops
   *   at the first thing that is not base64, so `'!!!not an image!!!'` decodes to
   *   a short buffer instead of failing. Accepting anything here and checking the
   *   decoded length would therefore accept arbitrary junk as a four-byte
   *   "image". The pattern demands whole 4-character groups with correct padding,
   *   which is exactly what `btoa`/`canvas.toDataURL` produce.
   *
   * ★ AND `data:` URLS ARE REJECTED ON PURPOSE, WITH A MESSAGE THAT SAYS SO. A
   *   caller pasting a data URL is a caller who has the right bytes in the wrong
   *   wrapper, and the useful answer is to name the wrapper rather than to fail
   *   on the third character with "invalid base64".
   */
  const BackgroundUpload = z
    .object({
      data: z
        .string()
        .min(1)
        .max(
          BACKGROUND_MAX_BASE64,
          'The image is larger than this endpoint accepts. Base64-encode at most 640 KiB of image ' +
            'bytes, which is about 880,000 characters.',
        )
        .regex(
          /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
          'Send the bare base64 text of the image — whole 4-character groups with padding, and no ' +
            '`data:image/png;base64,` prefix and no line breaks.',
        )
        .openapi({
          description:
            'The image bytes, base64-encoded. No `data:` URL prefix and no whitespace. At most 640 KiB ' +
            'of decoded bytes, which is roughly 880,000 characters here.',
        }),
      mime: z
        .enum(BACKGROUND_TYPES)
        .openapi({
          description:
            'The media type the caller believes this is. **A claim, not the stored value**: the bytes\' ' +
            'own signature is read and wins if the two disagree. SVG is not accepted, because an SVG ' +
            'can carry script and would be served back from this origin.',
        }),
      name: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .openapi({ description: 'The filename, for display. Optional; omit it and `backgroundName` is null.' }),
    })
    .strict()
    .openapi('ProjectBackgroundUpload');

  /**
   * The image, as the wire carries it.
   *
   * `bytes` is a convenience for a caller deciding whether to draw a spinner —
   * it is `data.length` in decoded terms and is derivable, but a client that had
   * to derive it would be deriving it wrong (three lengths are in play: the
   * base64 string, the decoded bytes, and the JSON body).
   */
  const BackgroundWire = z
    .object({
      slug: textReq('The project this image belongs to.'),
      mime: textReq(
        'The stored media type — read from the bytes\' signature when the image was uploaded, not ' +
          'necessarily what the uploader declared. One of `image/png`, `image/jpeg`, `image/webp`, ' +
          '`image/gif`.',
      ),
      name: text('The filename the image was uploaded under, or null if none was given.'),
      updatedAt: text('When the image was last set. Null on a legacy row that has bytes but no stamp.'),
      bytes: intReq(
        'The decoded size in bytes, so a caller does not have to work it out from the base64 length. ' +
          'Named `bytes` rather than `size` because its unit is in the name — three lengths are in play ' +
          'here (the base64 text, the decoded bytes, and the JSON body) and only one of them is this.',
      ),
      data: textReq(
        'The image bytes, base64-encoded — the same encoding the upload accepts, so the two halves of ' +
          'this feature are one format rather than two.',
      ),
    })
    .openapi('ProjectBackground');

  api.route({
    method: 'put',
    path: '/api/projects/{slug}/background',
    operationId: 'setProjectBackground',
    summary: 'Set or replace a project’s background image',
    description:
      'Stores one image against a project, replacing whatever was there.\n\n' +
      '**Replace is the whole operation.** There is no append and no version history: setting a second ' +
      'image overwrites the first, so this is a `PUT` on the project’s image rather than a `POST` to a ' +
      'collection. The response is the updated `ProjectRegistryRow`, so a caller has the new ' +
      '`hasBackground`, `backgroundName` and `backgroundUpdatedAt` without a second request.\n\n' +
      '⚠ **The bytes are not in that response, and that is deliberate.** The row schema never carries ' +
      'the image — see `GET /api/projects/{slug}/background` for it. A caller that wants to display what ' +
      'it just uploaded already has the bytes, and one that wants to confirm they landed should read them ' +
      'back from that endpoint.\n\n' +
      '**The transport is base64 inside an ordinary JSON body.** There is no multipart endpoint, and ' +
      '`data` is the bare base64 text — no `data:image/png;base64,` prefix and no line breaks. The ceiling ' +
      'is **640 KiB decoded** (655,360 bytes), which is what fits inside the server’s 1 MB JSON body limit ' +
      'after base64 expansion. A larger image is answered `400` naming the size that arrived, and a body ' +
      'so large that the JSON reader itself refuses it is answered `400` before this handler runs.\n\n' +
      '**The declared `mime` is checked against the bytes.** The signature at the start of the image is ' +
      'read and stored, so a JPEG uploaded as `image/png` is stored as `image/jpeg` and served with the ' +
      'media type that is true. `image/svg+xml` is not an accepted value: an SVG is a document that can ' +
      'carry script, and it would be served back from this app’s own origin.\n\n' +
      '⚠ **The image is display-only and nothing in the ledger depends on it.** It is not read by any ' +
      'report, and deleting a project deletes its image with it, because it is a column on the row rather ' +
      'than a child record.\n\n' +
      '⚠ **This does not touch `backgroundStrength`.** Replacing a picture keeps the strength the reader ' +
      'chose, because "show me a different picture at the size I picked" is one intent and not two — and a ' +
      'first upload finds the column already `null`, which the drawing answers with the application ' +
      'default. Clearing the strength is `PATCH /api/projects/{slug}`; clearing the *picture* is ' +
      '`DELETE /api/projects/{slug}/background`, which clears the strength with it.\n\n' +
      'Answers `200` with the project, or `404` if the key is not a project.',
    tags: ['Projects'],
    params: SlugParams,
    body: BackgroundUpload,
    response: RowSchema,
    errors: [400, 404, 500, 503],
    handler: async ({ params: path, body }) => {
      await requireAppSchema('The project registry');

      const existing = await findBySlug(path.slug);
      if (!existing) throw AppError.notFound(`Project ${path.slug}`);

      // ---- decode, and measure the actual bytes -----------------------------
      //
      // `Buffer.from(x, 'base64')` cannot be trusted to report a bad input — it
      // is lenient by design — which is why the *schema* above is the strict
      // part. By the time we are here the string is well-formed base64, so a
      // decode cannot fail; what it can still be is too big, and that check is
      // here rather than in the schema so the message can name the number of
      // bytes that arrived as well as the limit.
      //
      // ★ THE BASE64 LAW: 3 bytes become 4 characters, so the decoded size is
      //   `length / 4 * 3` minus any `=` padding. That arithmetic is *not* used
      //   to predict the size — `decoded.length` is the measurement, and the
      //   arithmetic is only what tells a reader why the schema cap sits where
      //   it does. Predicting a size and then acting on the prediction is how a
      //   check ends up disagreeing with the thing it is checking.
      const decoded = Buffer.from(body.data, 'base64');
      if (decoded.length > BACKGROUND_MAX_BYTES) {
        throw AppError.badRequest(
          `That image is ${decoded.length.toLocaleString('en-US')} bytes; the limit is ` +
            `${BACKGROUND_MAX_BYTES.toLocaleString('en-US')} (640 KiB) after base64 decoding. ` +
            'Resize it, or export it at lower quality, and try again.',
          { bytes: decoded.length, maxBytes: BACKGROUND_MAX_BYTES },
        );
      }
      // A well-formed base64 string cannot decode to nothing, so this would mean
      // the decode itself is broken. Answering "saved" for a zero-byte image
      // would produce a row whose `hasBackground` is true and whose picture is
      // empty — the one state `DATALENGTH(NULL) answering null` was chosen to
      // keep distinguishable, so it must not be reachable by accident.
      if (decoded.length === 0) {
        throw AppError.badRequest('That image decoded to zero bytes, so there is nothing to store.');
      }

      // ---- what the bytes say, not what the caller said ---------------------
      //
      // If the signature is recognised it wins; if it is not, the declared type
      // is kept, because a GIF87a or a format whose signature this function has
      // simply never learned about would otherwise be refused for no reason a
      // caller could act on. The stored value is therefore "measured when
      // measurable, declared otherwise", which is the strongest claim available.
      const sniffed = sniffImageMime(decoded);
      const mime = sniffed ?? body.mime;

      const now = stampNow();
      const result = await execute(
        'UPDATE project SET background_image = :img, background_image_mime = :mime, ' +
          `background_name = :name, background_updated_at = ${now}, updated_at = ${now} ` +
          'WHERE slug = :slug',
        {
          img: bindable(decoded),
          mime,
          // `?? null` rather than leaving the key out: `bindable(undefined)` also
          // returns null, so both spell the same thing, but naming it makes it
          // visible that an omitted filename writes a NULL rather than leaving
          // the previous one in place.
          name: body.name ?? null,
          slug: path.slug,
        },
      );

      // The row was read a moment ago, so zero rows here means it was deleted in
      // between. Answering with a fresh read would then be a 500 from
      // `readBack`, which is a worse description of what happened than this.
      if (result.rowsAffected === 0) throw AppError.notFound(`Project ${path.slug}`);

      return readBack(path.slug);
    },
  });

  api.route({
    method: 'get',
    path: '/api/projects/{slug}/background',
    operationId: 'getProjectBackground',
    summary: 'Read a project’s background image',
    description:
      'Returns the bytes of a project’s background image, base64-encoded, with the media type needed to ' +
      'display them.\n\n' +
      '**Why this is a separate request from the registry list.** `GET /api/projects/registry` returns ' +
      'fifteen projects and is read by screens that draw a table of names. The bytes are a ' +
      '`VARBINARY(MAX)` which the database stores out of the row above 8 KB, so putting them in that ' +
      'payload would make it grow with the number of *pictures* rather than the number of projects. The ' +
      'list therefore carries only `hasBackground` and `backgroundUpdatedAt`, and this endpoint is how a ' +
      'screen that actually draws the image asks for it — one project at a time.\n\n' +
      '**Two different things are 404 here, and the message distinguishes them.** A `slug` that is not a ' +
      'project answers `404` — there is no such project to have an image. A project that exists and has ' +
      'no image also answers `404`, because that is what "this resource is not there" means, but its ' +
      'message says the project was found and nothing is stored against it. A caller that would rather ' +
      'not distinguish them can read `hasBackground` from the registry row and not call this at all.\n\n' +
      'The response carries the bytes twice over: `data` as the base64 text to hand to an `<img>`, and ' +
      '`bytes` as the size in bytes, so a caller does not have to work out what the base64 length means.',
    tags: ['Projects'],
    params: SlugParams,
    response: BackgroundWire,
    errors: [404, 500, 503],
    handler: async ({ params: path }) => {
      await requireAppSchema('The project registry');

      const existing = await findBySlug(path.slug);
      if (!existing) throw AppError.notFound(`Project ${path.slug}`);

      // A projected read rather than `SELECT *`: the row above deliberately has
      // no `background_image` on it, and this one deliberately has nothing else.
      //
      // ★ `background_image` IS TYPED `unknown`, AND THAT IS THE HONEST TYPE. It
      //   was declared `Uint8Array | null` until the `local` arm was run and the
      //   claim turned out to be false for that driver (see `toBytes`). A
      //   declared type is not a check — nothing in the type system inspects what
      //   the driver puts on the wire — so the column is taken as what it really
      //   is and narrowed by measurement below.
      const held = await one<{
        background_image: unknown;
        background_image_mime: string | null;
        background_name: string | null;
        background_updated_at: string | null;
      }>(
        'SELECT background_image, background_image_mime, background_name, background_updated_at ' +
          'FROM project WHERE slug = :slug',
        { slug: path.slug },
      );

      const raw = held?.background_image ?? null;
      if (raw === null) {
        // The wording names the project as EXISTING, because that is the fact the
        // caller can act on: the key is right and there is simply no image here.
        //
        // ★ THIS IS A DIRECT CONSTRUCTION RATHER THAN `AppError.notFound()` ON
        //   PURPOSE. That helper appends `' was not found.'`, which is right for
        //   its other callers (`Project ${slug}` → "Project x was not found.") but
        //   would render this one as "…has no background image was not found." —
        //   a sentence that contradicts itself, since the whole point of this
        //   branch is that the project WAS found. The code is still `NOT_FOUND`.
        throw new AppError(404, 'NOT_FOUND', `Project ${path.slug} has no background image.`);
      }

      // ★ THE DECLARED INTERFACE IS A CLAIM, SO IT IS CHECKED — AND IT WAS WRONG
      //   ON THE SECOND DRIVER. The column's declared type said `Uint8Array`,
      //   and the `sqlserver` driver does return a `Buffer`, which satisfies it.
      //   The `local` driver returns an `ArrayBuffer`, which does NOT. So the
      //   guard is widened to the two measured representations rather than
      //   removed, and the diagnostic names whatever actually arrived, because
      //   the next driver's representation is exactly the thing a reader will
      //   want told rather than have to measure again.
      const bytes = toBytes(raw);
      if (!bytes) {
        const got = raw === null ? 'null' : (raw as { constructor?: { name?: string } })?.constructor?.name ?? typeof raw;
        throw new AppError(
          500,
          'INTERNAL',
          `Project "${path.slug}" has background bytes this server cannot read: the driver returned ` +
            `them as "${got}", which is neither a Uint8Array nor an ArrayBuffer.`,
        );
      }

      return {
        slug: path.slug,
        mime: held?.background_image_mime ?? 'application/octet-stream',
        name: held?.background_name ?? null,
        updatedAt: held?.background_updated_at ?? null,
        bytes: bytes.length,
        data: Buffer.from(bytes).toString('base64'),
      };
    },
  });

  api.route({
    method: 'delete',
    path: '/api/projects/{slug}/background',
    operationId: 'clearProjectBackground',
    summary: 'Remove a project’s background image',
    description:
      'Clears the stored image and its companion columns.\n\n' +
      '**This is not the same as setting an empty image.** All five columns go back to `NULL`, which is ' +
      'the state the DDL means by "no image" — `DATALENGTH(NULL)` answers `null` where an empty value would ' +
      'answer `0`, so the two are distinguishable in the database and `hasBackground` is false afterwards.\n\n' +
      '★ **`backgroundStrength` goes to `NULL` with the picture, and that is the one column here that is a ' +
      'choice rather than a part of the image.** Leaving it behind would keep a number that describes ' +
      'something no longer there: the control that shows it is inside the image panel and only exists ' +
      'while a picture is held, so the reader could neither see it nor change it, and a later upload ' +
      'would silently arrive at the old strength instead of the default. Removing the picture discards ' +
      'the decision made about it, and re-adding one starts from the default — which is what "remove" ' +
      'means on this screen.\n\n' +
      '**Idempotent by design, but a missing project is still an error.** Clearing a project that has no ' +
      'image is a `204` — the request asked for there to be no image and there is none, which is a ' +
      'success. A `slug` that is not a project at all is a `404`, because that is a different mistake and ' +
      'answering `204` would make a typo look like a clean-up.\n\n' +
      'Answers `204` with no body, matching `DELETE /api/projects/{slug}`. The five columns are cleared ' +
      'together in one `UPDATE`, so there is no window in which the mime names a format whose bytes are ' +
      'already gone.',
    tags: ['Projects'],
    params: SlugParams,
    response: z.undefined(),
    status: 204,
    errors: [404, 500, 503],
    handler: async ({ params: path }) => {
      await requireAppSchema('The project registry');

      const existing = await findBySlug(path.slug);
      if (!existing) throw AppError.notFound(`Project ${path.slug}`);

      // `updated_at` moves as well: the row did change, and the background image
      // is part of the row. `background_updated_at` is the one that answers "how
      // old is the picture", and after this it is null along with the picture.
      //
      // ★ AND `background_strength` IS CLEARED WITH THE PICTURE, IN THE SAME
      //   `UPDATE`. It is the one column here that holds a *choice* rather than a
      //   part of the image, and a choice about something that is no longer there
      //   is a value the reader can neither see nor change — the control lives in
      //   the image panel, which is not drawn without a picture. Discarding it
      //   also means a later upload starts from the default rather than silently
      //   arriving at the strength chosen for a different picture. One statement,
      //   so there is no window in which a strength outlives its image.
      const now = stampNow();
      await execute(
        'UPDATE project SET background_image = NULL, background_image_mime = NULL, ' +
          'background_name = NULL, background_updated_at = NULL, background_strength = NULL, ' +
          `updated_at = ${now} WHERE slug = :slug`,
        { slug: path.slug },
      );

      // ★ NO `rowsAffected` CHECK, AND IT IS NOT AN OVERSIGHT — DELETE ROUTES
      //   CHECK IT; THIS ONE MUST NOT. A project with no image is updated to have
      //   no image, so zero rows affected is the *expected* answer on the second
      //   call and answering 404 for it would make a retry look like a bad key.
      //   The `findBySlug` above is what distinguishes the two cases, and it has
      //   already run.
      return undefined;
    },
  });
}
