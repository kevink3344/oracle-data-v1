import { z } from '../http/z.js';
import type { Api } from '../http/api.js';
import { AppError } from '../http/errors.js';
import { columnNumber, execute, one, quoteIdent, rows, type Binds } from '../db/sql.js';
import { requireAppSchema } from '../db/app-schema.js';
import { intReq, textReq } from '../schemas/columns.js';
import { requireSuperAdmin } from '../auth/guard.js';
import { TENANT_COLUMNS, tenantFromRow, type OrganizationRow, type Tenant } from '../auth/session.js';
import { slugFor } from '../lib/slug.js';

/**
 * Organizations: the tenants this application serves.
 *
 * ---------------------------------------------------------------------------
 * WHAT AN ORGANIZATION IS
 * ---------------------------------------------------------------------------
 * One row says which slice of the ledger a school system is: a **fund**, the
 * **programs** within it, and the **fiscal year** its data starts at. It is the
 * configuration that used to be the `SCOPE` constant in `app/src/data/scope.ts`,
 * promoted from a compile-time literal to a stored row so that a second tenant
 * needs no second build.
 *
 * ---------------------------------------------------------------------------
 * ★ WHY THIS FILE DOES NOT RETURN A ROW COUNT, WHICH THE DESIGN CALLS FOR
 * ---------------------------------------------------------------------------
 * The list row in the design reads `Fund 04 · 861 862 · FY 2025 · 2,782 lines`,
 * and the count is the number of extract lines that organization's configuration
 * selects. It is deliberately **not computed here**, and the reason is not
 * laziness:
 *
 *   The rule that decides whether a line is in scope is `inScope()` in
 *   `app/src/data/scope.ts`, and the organization feature's whole point is that
 *   there is exactly **one** implementation of it. The server holding its own
 *   copy — as SQL, over tables that do not even carry the fund and program the
 *   rule needs, since `PO_LINES_ALL` has neither column — would be a second
 *   implementation, and the two would be free to disagree about which lines are
 *   in scope. That is the same failure the `initials` duplication produced, one
 *   layer up and with money attached.
 *
 *   So the count is produced by the client, from the extract it already loads,
 *   through the one predicate. A row that selects nothing shows `0 lines` for
 *   the same reason an empty screen shows "No rows found" — one rule, one
 *   answer. `scopeLabel` *is* stored-per-read here, because a label is a
 *   formatting decision about *configuration*, not a statement about data.
 *
 * ---------------------------------------------------------------------------
 * WHO MAY CHANGE ONE
 * ---------------------------------------------------------------------------
 * Reading the register needs a session; changing it needs `super_admin`. The
 * split is enforced by `requireSuperAdmin` rather than by a middleware, so the
 * refusal is answered where the question is asked and a route that forgot to ask
 * has no actor rather than a stale one.
 */

type OrgDbRow = OrganizationRow & {
  is_default: number;
  created_at: string;
  updated_at: string;
};

const ORG_SQL = `SELECT ${TENANT_COLUMNS}, is_default, created_at, updated_at FROM organization`;

/**
 * The row, as the client stores it.
 *
 * `fund`, `programs` and `startFy` are the configuration; the rest is identity
 * and provenance. `id` and `slug` are both carried because they have different
 * jobs: `id` is what `app_user.organization_id` points at, and `slug` is the
 * stable key a URL and a `PATCH` address use.
 */
const OrgSchema = z
  .object({
    id: intReq('The organization id. `app_user.organization_id` references this.'),
    slug: textReq(
      'The stable key, derived from the name by the same rule `project.slug` uses. Never changes ' +
        'when the name is edited, which is why the write endpoints address a row by this and not by name.',
    ),
    name: textReq('What the organization is called.'),
    fund: textReq('The two-digit `SEGMENT1` value this organization reads. Never `00`.'),
    programs: z
      .array(z.string())
      .openapi({
        description:
          'The `SEGMENT3` values this organization reads, in the order they were authored. ' +
          '**Order is meaningful and is preserved on write** — it is the order the programs are ' +
          'offered to a reader. An empty list is legal and selects nothing.',
      }),
    startFy: intReq('The first fiscal year this organization reads. The extract is floored at it.'),
    isDefault: z.boolean().openapi({
      description:
        'Whether this is the organization a visitor with no session browses. Exactly one row is ' +
        'the default, held to one by a partial unique index; it cannot be set through this API.',
    }),
    scopeLabel: textReq(
      '`Fund 04 · program 861/862/863`, in the words the scope picker uses. Rendered here so ' +
        'the register and the picker cannot describe the same configuration differently.',
    ),
    createdAt: textReq('When the row was created.'),
    updatedAt: textReq('When the row was last changed.'),
  })
  .openapi('Organization');

/**
 * `Fund 04 · program 861/862/863`.
 *
 * ★ THE PROGRAMS ARE JOINED WITH `/` BECAUSE AN ORGANIZATION'S LIST IS ALWAYS
 *   "ALL OF THEM". The picker has a second form — `861, 862` with commas — for
 *   the case where a reader has switched some of its own programs off, and
 *   that form belongs to the picker. An organization holds one complete
 *   selection, so the slash form is the only correct one here, and the empty
 *   case says so rather than rendering `program `.
 */
function scopeLabelFor(tenant: Tenant): string {
  if (tenant.programs.length === 0) return `Fund ${tenant.fund} · no program selected`;
  return `Fund ${tenant.fund} · program ${tenant.programs.join('/')}`;
}

/** Row → wire. The one place an `organization` row becomes a response. */
function toWire(row: OrgDbRow) {
  const tenant = tenantFromRow(row);
  return {
    id: tenant.id,
    slug: tenant.slug,
    name: tenant.name,
    fund: tenant.fund,
    programs: tenant.programs,
    startFy: tenant.startFy,
    isDefault: row.is_default === 1,
    scopeLabel: scopeLabelFor(tenant),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The row with this slug, or null. */
async function findBySlug(slug: string): Promise<OrgDbRow | null> {
  return one<OrgDbRow>(`${ORG_SQL} WHERE slug = :slug`, { slug });
}

/**
 * Re-read after a write, or fail loudly.
 *
 * A write that cannot be read back is not a success, and returning the values the
 * caller sent would hide that — it would also hide the derived `slug`, which is
 * the whole reason this returns a stored row rather than an echo.
 */
async function readBack(slug: string): Promise<ReturnType<typeof toWire>> {
  const stored = await findBySlug(slug);
  if (!stored) {
    throw new AppError(500, 'INTERNAL', `Wrote organization "${slug}" but could not read it back.`);
  }
  return toWire(stored);
}

// ---------------------------------------------------------------------------
// The chart of accounts, as the vocabulary a fund and a program come from.
// ---------------------------------------------------------------------------

/**
 * The fund codes the ledger actually carries, `00` excluded.
 *
 * ★ `00` IS A REAL VALUE IN THE CHART OF ACCOUNTS AND IS DELIBERATELY NOT OFFERED.
 *   Its seven account combinations all pair with program `000`, and both are
 *   the unresolved placeholder — the account nobody finished coding. Offering it
 *   would let a tenant be configured onto rows that mean "we do not know yet",
 *   and every screen downstream would then present incomplete data as a school
 *   system's ledger. The design settled this; this function is where it is
 *   enforced.
 *
 * `DISTINCT` rather than `GROUP BY` because the counts are not wanted here — the
 * picker's counts come from `GET /api/organizations/options`, which reads the
 * same table once and hands the client every number it needs.
 */
async function fundCodes(): Promise<string[]> {
  const list = await rows<{ fund: string }>(
    `SELECT DISTINCT ${quoteIdent('SEGMENT1')} AS fund FROM ${quoteIdent('GL_CODE_COMBINATIONS')} ` +
      `WHERE ${quoteIdent('SEGMENT1')} IS NOT NULL AND ${quoteIdent('SEGMENT1')} <> '00' ` +
      `ORDER BY ${quoteIdent('SEGMENT1')}`,
  );
  return list.map((r) => r.fund);
}

/** A finite number, or null. Never `0` for a missing value — see the note below. */
function finiteOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The fiscal years the ledger holds periods for, or null if it holds none.
 *
 * ★ THE NULL IS NOT A FAILURE. `null` means "the ledger has no opinion", and the
 *   write path then accepts any year rather than inventing a bound — an absent
 *   constraint and a permissive one are different things, and only claiming the
 *   former is honest. It is emphatically **not** `0`: this project has already
 *   been bitten once by `Number(rows[0]?.n ?? 0)`, which turned "that query
 *   returned nothing" into a real zero and produced a fake −100 % delta.
 */
async function fiscalYearBounds(): Promise<{ earliest: number; latest: number } | null> {
  const row = await one<{ earliest: unknown; latest: unknown }>(
    `SELECT MIN(${quoteIdent('PERIOD_YEAR')}) AS earliest, MAX(${quoteIdent('PERIOD_YEAR')}) AS latest ` +
      `FROM ${quoteIdent('GL_PERIODS')}`,
  );
  const earliest = finiteOrNull(row?.earliest);
  const latest = finiteOrNull(row?.latest);
  if (earliest === null || latest === null) return null;
  return { earliest, latest };
}

/**
 * Refuse a fund the chart of accounts does not carry, naming the ones it does.
 *
 * ★ A BAD FUND IS 400, NOT 409. Nothing is in conflict — the value is simply not
 *   in the vocabulary. 409 says "this clashes with what is already stored", which
 *   would tell the caller to change the *other* thing.
 */
async function assertFund(fund: string): Promise<void> {
  const known = await fundCodes();
  if (!known.includes(fund)) {
    throw AppError.badRequest(
      `"${fund}" is not a fund the chart of accounts carries. An organization has to read a fund ` +
        `that exists in \`GL_CODE_COMBINATIONS\` with accounts coded to it, and \`00\` is left out on ` +
        'purpose because it is the value for accounts nobody has finished coding.',
      { fund, accepts: known },
    );
  }
}

/**
 * Refuse a start year the ledger holds no period for.
 *
 * Validated against `GL_PERIODS`, which is the only thing that can say whether a
 * fiscal year means anything: a year with no period in it can never be matched by
 * a balance, so a tenant configured onto one would read as empty for a reason
 * nobody could see. The bounds are the ledger's own, deliberately wider than the
 * years the extract currently carries — the design allows a *future* year, which
 * a picker bounded to the shipped data would forbid.
 */
async function assertStartFy(startFy: number): Promise<void> {
  const bounds = await fiscalYearBounds();
  if (bounds === null) return;
  if (startFy < bounds.earliest || startFy > bounds.latest) {
    throw AppError.badRequest(
      `Fiscal year ${startFy} has no period in the ledger, so nothing can ever fall in it. The ` +
        `periods on record run FY${bounds.earliest} to FY${bounds.latest}.`,
      { startFy, accepts: bounds },
    );
  }
}

// ---------------------------------------------------------------------------
// Shared body fragments.
// ---------------------------------------------------------------------------

/**
 * ★ A PROGRAM IS THREE DIGITS BECAUSE `SEGMENT3` IS THREE CHARACTERS WIDE, AND
 *   THAT WAS MEASURED. Every distinct value the chart of accounts carries is
 *   exactly three digits (`000`, `220`, `861`, `862`). The narrow shape is the
 *   point: `86` for `861` is the typo this will catch, and it is a typo the
 *   account-combination membership check cannot catch either, because programs
 *   are not checked against the ledger — see the note in `POST`'s description.
 */
const ProgramSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{3}$/, 'A program is three digits, e.g. 861.')
  .openapi({ example: '861', description: 'One three-digit `SEGMENT3` value.' });

const ProgramsSchema = z
  .array(ProgramSchema)
  .max(12, 'An organization holds at most twelve programs.')
  .refine((list) => new Set(list).size === list.length, {
    message:
      'The same program is listed twice, so the selection is ambiguous. Send each program once, ' +
      'in the order it should be offered.',
  })
  .openapi({
    example: ['861', '862'],
    description:
      'The programs to read, in the order they should be offered. Order is preserved on write and ' +
      'is never sorted here, because it is a presentation decision the author makes. An empty list is ' +
      'legal: it selects nothing, and every screen then shows its ordinary "No rows found".',
  });

const FundSchema = z
  .string()
  .trim()
  .regex(/^[0-9]{2}$/, 'A fund is two digits from the chart of accounts, e.g. 04.')
  .openapi({ example: '04', description: 'The two-digit `SEGMENT1` value.' });

const StartFySchema = z
  .coerce.number()
  .int('A fiscal year is a whole number, e.g. 2025.')
  .openapi({
    example: 2025,
    description:
      'The first fiscal year to read. Accepted as a number or a numeric string so a form can post ' +
      'what the user typed without converting it first.',
  });

export function registerOrganizations(api: Api): void {
  // -------------------------------------------------------------------------
  // The vocabulary the form is built from.
  // -------------------------------------------------------------------------
  api.route({
    method: 'get',
    path: '/api/organizations/options',
    operationId: 'organizations_options',
    summary: 'The funds, programs and fiscal years an organization may be configured with',
    description:
      'Everything the organization form needs to render itself, read from the ledger rather than ' +
      'hard-coded:\n\n' +
      '- **Funds** — the distinct `SEGMENT1` values in `GL_CODE_COMBINATIONS`, with how many account ' +
      'combinations each one holds. `00` is excluded: it is the value for accounts nobody has finished ' +
      'coding, and its accounts all sit under program `000`.\n' +
      '- **Programs** — every pair the chart of accounts actually uses, as `(fund, program)` with its ' +
      'combination count. A pair is a **suggestion, not a restriction** — see the note on `POST`, which ' +
      'explains why a program is validated for shape but not for membership.\n' +
      '- **Fiscal years** — the range `GL_PERIODS` carries. `null` when the ledger holds no periods at ' +
      'all, which means the ledger has no opinion rather than that the range is zero.\n\n' +
      'This is a separate endpoint from the list because it is the only response here that touches the ' +
      'ledger tables, and the list should stay answerable when they are absent.',
    tags: ['Organizations'],
    response: z
      .object({
        funds: z
          .array(
            z
              .object({
                fund: textReq('A two-digit `SEGMENT1` value.'),
                combinations: intReq('How many account combinations carry this fund.'),
              })
              .openapi('OrganizationFundOption'),
          )
          .openapi({ description: 'Funds, code-ordered. `00` is not among them.' }),
        programs: z
          .array(
            z
              .object({
                fund: textReq('The fund this pair belongs to.'),
                program: textReq('The three-digit `SEGMENT3` value.'),
                combinations: intReq('How many account combinations carry this pair.'),
              })
              .openapi('OrganizationProgramOption'),
          )
          .openapi({
            description:
              'Fund/program pairs, ordered by fund then program. A program may appear under more ' +
              'than one fund; the form filters this list by the fund that is selected.',
          }),
        fiscalYears: z
          .object({
            earliest: intReq('The earliest `PERIOD_YEAR` in `GL_PERIODS`.'),
            latest: intReq('The latest `PERIOD_YEAR` in `GL_PERIODS`.'),
          })
          .nullable()
          .openapi({
            description:
              'The years the ledger holds periods for, or `null` when it holds none — in which case a ' +
              'start year is not checked at all, because there is no bound to check it against.',
          }),
      })
      .openapi('OrganizationOptionsResponse'),
    errors: [401, 403, 500, 503],
    handler: async (ctx) => {
      await requireSuperAdmin(ctx.req);
      await requireAppSchema('The organization register');

      const fundRows = await rows<{ fund: string; combinations: number }>(
        `SELECT ${quoteIdent('SEGMENT1')} AS fund, COUNT(*) AS combinations ` +
          `FROM ${quoteIdent('GL_CODE_COMBINATIONS')} ` +
          `WHERE ${quoteIdent('SEGMENT1')} IS NOT NULL AND ${quoteIdent('SEGMENT1')} <> '00' ` +
          `GROUP BY ${quoteIdent('SEGMENT1')} ORDER BY ${quoteIdent('SEGMENT1')}`,
      );

      const programRows = await rows<{ fund: string; program: string; combinations: number }>(
        `SELECT ${quoteIdent('SEGMENT1')} AS fund, ${quoteIdent('SEGMENT3')} AS program, ` +
          `COUNT(*) AS combinations FROM ${quoteIdent('GL_CODE_COMBINATIONS')} ` +
          `WHERE ${quoteIdent('SEGMENT1')} IS NOT NULL AND ${quoteIdent('SEGMENT1')} <> '00' ` +
          `AND ${quoteIdent('SEGMENT3')} IS NOT NULL ` +
          `GROUP BY ${quoteIdent('SEGMENT1')}, ${quoteIdent('SEGMENT3')} ` +
          `ORDER BY ${quoteIdent('SEGMENT1')}, ${quoteIdent('SEGMENT3')}`,
      );

      return {
        funds: fundRows.map((r) => ({ fund: r.fund, combinations: columnNumber(r, 'combinations') })),
        programs: programRows.map((r) => ({
          fund: r.fund,
          program: r.program,
          combinations: columnNumber(r, 'combinations'),
        })),
        fiscalYears: await fiscalYearBounds(),
      };
    },
  });

  // -------------------------------------------------------------------------
  // The register.
  // -------------------------------------------------------------------------
  api.route({
    method: 'get',
    path: '/api/organizations',
    operationId: 'organizations_list',
    summary: 'Every organization this application serves',
    description:
      'The register: one row per tenant, name-ordered, the default last so the row a reader is looking ' +
      'for is at the top.\n\n' +
      '**The row does not carry a line count, and that is deliberate.** The design shows one — ' +
      '`FY 2025 · 2,782 lines` — but the rule that decides whether a line is in scope is `inScope()` in ' +
      '`app/src/data/scope.ts`, and this feature exists to leave exactly one implementation of it. A ' +
      'count computed server-side would be a second one, over tables that do not carry the fund and ' +
      'program it needs (`PO_LINES_ALL` has neither column). The client computes it from the extract ' +
      'it already loads, through the one predicate, so a row that selects nothing reads `0 lines` for ' +
      'the same reason an empty screen reads "No rows found".\n\n' +
      '**A tenant with an empty program list is expected and legal.** It selects nothing, it can be ' +
      'saved, and `scopeLabel` says `no program selected` rather than showing a bare separator.',
    tags: ['Organizations'],
    response: z
      .object({
        items: z.array(OrgSchema).openapi({ description: 'Every organization, default last.' }),
        counts: z
          .object({
            total: intReq('Rows in the register.'),
            programs: intReq(
              'Rows selecting no program. Not an error count — a tenant that reads a whole fund ' +
                'has no reason to name programs, and a tenant can be created before its programs ' +
                'are decided.',
            ),
          })
          .openapi('OrganizationListCounts'),
      })
      .openapi('OrganizationListResponse'),
    errors: [401, 403, 500, 503],
    handler: async (ctx) => {
      await requireSuperAdmin(ctx.req);
      await requireAppSchema('The organization register');

      // `is_default` last so the tenant a reader is looking for sorts to the top
      // without a second query. `DESC` puts 1 before 0; there is exactly one 1.
      const items = await rows<OrgDbRow>(`${ORG_SQL} ORDER BY is_default DESC, name`);

      return {
        items: items.map(toWire),
        counts: {
          total: items.length,
          programs: items.filter((r) => r.programs_json === '[]').length,
        },
      };
    },
  });

  api.route({
    method: 'post',
    path: '/api/organizations',
    operationId: 'organizations_create',
    summary: 'Configure an organization',
    description:
      'Creates one tenant and returns the stored row. **Super admin only**: configuring which slice of ' +
      'the ledger exists is not something a member account does, and a member is refused 403 rather than ' +
      '401 so they are not sent round a sign-in loop that cannot help them.\n\n' +
      '**`fund` is validated against the ledger and `programs` are not, and the difference is the point.** ' +
      'A fund is a slice of the chart of accounts, so a fund with no accounts coded to it selects ' +
      'nothing ever, and the fund is therefore checked against the `SEGMENT1` values in ' +
      '`GL_CODE_COMBINATIONS` (with `00` excluded). A program is checked only for **shape** — three ' +
      'digits — even though the server could compare it against the fund/program pairs the chart of ' +
      'accounts uses. It deliberately does not: the pairs in this sample are `04/861`, `04/862` and ' +
      '`01/220`, no purchase-order line anywhere carries program `861` or `863`, and a membership ' +
      'check would therefore forbid configuring a tenant onto a program that exists in the account ' +
      'structure and is simply not represented in the current extract. A configuration is a statement ' +
      'about what a tenant reads, not about what happens to be in the data today. Use ' +
      '`GET /api/organizations/options` to offer the pairs as suggestions.\n\n' +
      '**`slug` is derived from the name, never supplied.** `Wake County Public Schools` becomes ' +
      '`wake-county-public-schools` by the same rule `POST /api/projects` uses. A name whose key is ' +
      'already taken is refused 409 naming the clash, because the key is the natural key and the name ' +
      'is not — an operator will rename a tenant and nothing should break when they do.\n\n' +
      '**The created row is not the default.** Exactly one row carries `is_default`, held to one by a ' +
      'partial unique index, and it is the one the seed installs. Moving that flag means un-defaulting ' +
      'one row and defaulting another in a single transaction, which is not exposed here because the ' +
      'design has no control for it.',
    tags: ['Organizations'],
    body: z
      .object({
        name: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .openapi({
            example: 'Athens Drive High School',
            description: 'What the organization is called. Required, and the source of the key.',
          }),
        fund: FundSchema,
        programs: ProgramsSchema.optional(),
        startFy: StartFySchema,
      })
      .openapi('OrganizationCreate'),
    response: OrgSchema,
    errors: [400, 401, 403, 409, 500, 503],
    handler: async (ctx) => {
      await requireSuperAdmin(ctx.req);
      await requireAppSchema('The organization register');

      const body = ctx.body as {
        name: string;
        fund: string;
        programs?: string[];
        startFy: number;
      };

      const name = body.name.trim();
      const slug = slugFor(name);
      const programs = body.programs ?? [];

      if (slug === '') {
        throw AppError.badRequest(
          'That name has no letters or digits in it, so it has no stable key. Give the organization a ' +
            'name that can be turned into one.',
          { name },
        );
      }

      const clash = await findBySlug(slug);
      if (clash) {
        throw AppError.conflict(
          `An organization already exists with the key "${slug}" — "${clash.name}". Keys are derived ` +
            'from names, so two cannot share one. Give this one a name that distinguishes it; if the ' +
            'two really are the same organization, edit the existing row instead of adding a second.',
          { slug, existing: clash.name },
        );
      }

      await assertFund(body.fund);
      await assertStartFy(body.startFy);

      // ★ `programs_json` is written in the order it arrived. Sorting here would
      //   be a presentation decision made by a storage layer, and the order is
      //   how the programs are offered to a reader.
      await execute(
        'INSERT INTO organization (slug, name, fund, programs_json, start_fy) ' +
          'VALUES (:slug, :name, :fund, :programs, :startFy)',
        {
          slug,
          name,
          fund: body.fund,
          programs: JSON.stringify(programs),
          startFy: body.startFy,
        },
      );

      return readBack(slug);
    },
  });

  api.route({
    method: 'patch',
    path: '/api/organizations/{slug}',
    operationId: 'organizations_update',
    summary: 'Reconfigure an organization',
    description:
      'Partial update: only the supplied fields change. Super admin only, for the same reason as `POST`.\n\n' +
      '**Nothing here can be cleared, and that is the difference from `PATCH /api/projects/{slug}`.** A ' +
      'project can release its account level back to null; an organization cannot release its fund or ' +
      'its start year, because a tenant with no fund reads no rows at all and would be ' +
      'indistinguishable from a broken one. The nearest honest way to say "read nothing" is an empty ' +
      'program list, and that is what `{"programs": []}` is for — it selects nothing, it is legal, and ' +
      'every screen shows its ordinary "No rows found".\n\n' +
      '**Editing the default organization is allowed and is the way the whole application is rescoped.** ' +
      'A visitor with no session browses the default tenant, so changing its fund or its programs ' +
      'changes what an anonymous reader sees, immediately and for everyone. There is no confirmation ' +
      'step here to forget: the request either names the rows it changes or it changes none.\n\n' +
      '**`name` does not move the key.** The slug is derived once, at creation, and a rename leaves it ' +
      'alone — a stored key that followed the name would break every link to it the moment somebody ' +
      'fixed a typo.',
    tags: ['Organizations'],
    params: z
      .object({ slug: z.string().min(1).openapi({ description: 'The organization key.' }) })
      .openapi('OrganizationSlugParams'),
    body: z
      .object({
        name: z.string().trim().min(1).max(200).optional().openapi({ description: 'A new display name.' }),
        fund: FundSchema.optional(),
        programs: ProgramsSchema.optional(),
        startFy: StartFySchema.optional(),
      })
      .openapi('OrganizationUpdate'),
    response: OrgSchema,
    errors: [400, 401, 403, 404, 409, 500, 503],
    handler: async (ctx) => {
      await requireSuperAdmin(ctx.req);
      await requireAppSchema('The organization register');

      const { slug } = ctx.params as { slug: string };
      const body = ctx.body as {
        name?: string;
        fund?: string;
        programs?: string[];
        startFy?: number;
      };

      const existing = await findBySlug(slug);
      if (existing === null) throw AppError.notFound(`Organization ${slug}`);

      const sets: string[] = [];
      const args: Binds = { slug };

      if (body.name !== undefined) {
        sets.push('name = :name');
        args.name = body.name.trim();
      }

      if (body.fund !== undefined) {
        await assertFund(body.fund);
        sets.push('fund = :fund');
        args.fund = body.fund;
      }

      if (body.programs !== undefined) {
        sets.push('programs_json = :programs');
        args.programs = JSON.stringify(body.programs);
      }

      if (body.startFy !== undefined) {
        await assertStartFy(body.startFy);
        sets.push('start_fy = :startFy');
        args.startFy = body.startFy;
      }

      // Nothing to change is a mistake in the request, not a no-op to swallow —
      // it reaches here as an empty PATCH, which would otherwise return 200 and a
      // row the caller believes it edited.
      if (sets.length === 0) {
        throw AppError.badRequest('No fields were supplied.', {
          accepts: ['name', 'fund', 'programs', 'startFy'],
        });
      }

      sets.push("updated_at = datetime('now')");

      await execute(`UPDATE organization SET ${sets.join(', ')} WHERE slug = :slug`, args);
      return readBack(slug);
    },
  });
}
