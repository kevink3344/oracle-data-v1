import { z } from '../http/z.js';
import { AppError } from '../http/errors.js';
import { IntParam, StrParam, isTrue } from '../http/z.js';
import { ListQuerySchema } from '../schemas/common.js';
import { page, type Page } from '../http/respond.js';
import type { Api } from '../http/api.js';
import type { TagName } from '../http/openapi.js';
import {
  bindable,
  execute,
  ident,
  likeClause,
  one,
  orderByClause,
  pageMeta,
  parseSort,
  quoteIdent,
  rows,
  scalar,
  type Binds,
} from '../db/sql.js';
import { writableForTable } from '../db/client.js';
import { assertNoDependents, assertParentsExist } from '../db/relations.js';
import { ledgerPlan } from '../db/ledger-shape.js';
import { pageLimitWithinCeiling, refuseIfOverCeiling } from '../db/row-budget.js';

/**
 * The read source for a descriptor's rows.
 *
 * On every dialect except Oracle this is the descriptor's own table, quoted, and
 * the mapping is the identity — one `Promise.resolve`, no metadata query, no
 * behaviour change. On Oracle it is resolved against the live database (which
 * granted object actually holds each declared column) and may be an inline view
 * that re-exposes the descriptor's column names under their own names. See
 * `db/ledger-shape.ts`.
 *
 * ★ IT IS ASYNC AND THAT IS THE WHOLE COST OF THE FIX. The alternative — a
 *   hand-written, synchronous map of "which column is missing where" — was
 *   written first and then falsified by its own control, which found nine more
 *   drifted tables it had never been told about. `await` is what honesty costs.
 *   The resolution is cached per table, so exactly one request per table pays it.
 *
 * ★ AN UNREADABLE OBJECT IS A 503, NOT A 404 AND NOT A SKIP. A 404 would be a
 *   lie — the route exists and the OpenAPI document describes it. A 500 would say
 *   the server is broken, which invites a retry loop. 503 with
 *   `DB_UNAVAILABLE` says the only true thing: this deployment cannot read that
 *   object. (The first version of this file instead *unmounted* the route. That
 *   silently removed paths from the API the spec advertises, which the smoke
 *   test's conformance pass then flagged — correctly.)
 */
async function readSource(d: ResourceDescriptor, query: Record<string, unknown> = {}): Promise<string> {
  const filter = d.pushdown?.(query);
  const plan = await ledgerPlan({
    table: d.table,
    columns: d.columns,
    ...(filter !== undefined && (filter.level || filter.object) ? { filter } : {}),
  });
  if (!plan.ok) {
    throw AppError.dbUnavailable(
      `${d.label} cannot be read on this deployment: ${plan.reason}`,
      { table: d.table },
    );
  }
  return plan.from;
}

/**
 * The projection, in descriptor order.
 *
 * Plain quoted names again, now that the nulling lives in the inline view the
 * read source builds: the view presents exactly these names, so every other SQL
 * builder here (order, filter, `?q=`) keeps quoting descriptor names and keeps
 * working with no dialect knowledge of its own.
 */
function selectList(d: ResourceDescriptor): string {
  return d.columns.map((c) => quoteIdent(c)).join(', ');
}

/**
 * The generic resource.
 *
 * Twenty-odd endpoints in this API are "list or fetch rows from one table, with a
 * search box, a sort, and pagination". Writing each one out by hand would be
 * twenty chances to forget the allowlist on a sort, the count on a page, or the
 * 404 on a missing id — and the failure mode of all three is silent.
 *
 * So a resource is declared as data: a table, the columns it may expose, the key,
 * what is searchable and sortable, and a Zod shape for a row. Everything the
 * guards depend on (`ident`, `parseSort`, `likeClause`) is then used in exactly
 * one place instead of twenty.
 *
 * TWO RULES THE FRAMEWORK ENFORCES RATHER THAN DOCUMENTS
 *
 *   - `columns` is the SELECT allowlist AND the sort allowlist AND the filter
 *     allowlist. A column that is not in it cannot be read, ordered by, or
 *     compared against, so a descriptor cannot leak a column it did not name.
 *
 *   - A resource without a primary key gets no detail route and no writes. It is
 *     a report, not a record: `GL_BALANCES` is keyed by five columns and no user
 *     opens one row of it. Refusing to invent a synthetic id keeps the URL space
 *     honest, and the OpenAPI document reflects that refusal automatically.
 */

export interface ResourceFilter {
  /** Column compared against. Must appear in `columns`. */
  column: string;
  /** Query parameter name; defaults to the lowercased column name. */
  param?: string;
  kind?: 'text' | 'integer';
  description?: string;
}

/**
 * A key-space narrowing handed to a derived view's composer.
 *
 * Re-exported from `db/derived.ts` so a descriptor can declare one without
 * importing the ledger module directly; the shape is identical.
 */
import type { SegmentFilter } from '../db/derived.js';
export type { SegmentFilter };

export interface ResourceDescriptor {
  /** Plural URL segment and operation-id stem: `vendors`. */
  name: string;
  /** Singular label for messages: `Vendor`. */
  label: string;
  /** Full path, including the `/api` prefix that the routers are mounted without. */
  basePath: string;
  /** Physical table or view. */
  table: string;
  /** Every column a response may contain. The only source of column names. */
  columns: readonly string[];
  /** Single-column key. Omit for a table with a composite key — see the note above. */
  pk?: string;
  /** How to parse the `{id}` path parameter. Defaults to `integer`. */
  pkKind?: 'integer' | 'text';
  /** Columns `?q=` searches. Omit to disable search on this resource. */
  searchable?: readonly string[];
  /** Columns `?sort=` may name. Omit to allow sorting only by `defaultSort`. */
  sortable?: readonly string[];
  /** Exact-match query filters. */
  filters?: readonly ResourceFilter[];
  /**
   * A key-space narrowing for a **derived** table's composed `WHERE`.
   *
   * ★ SET THIS ONLY WHEN `table` IS ONE OF THE THREE COMPOSED VIEWS, AND ONLY FOR
   *   PARAMETERS ALREADY IN `filters`. It is not a second filter mechanism: it
   *   restates a filter the descriptor already applies, in the place the database
   *   can act on it. `listRows` still emits `LEVEL_CODE = :f_level` in the outer
   *   `WHERE`, so the answer is the same object either way and this can only ever
   *   make it arrive sooner.
   *
   *   The reason it is needed at all is that these fragments publish their segments
   *   as aggregates (`MAX(cc.SEGMENT5)`) over `GROUP BY CODE_COMBINATION_ID`, so an
   *   outer predicate cannot narrow the read — it can only discard rows the
   *   database has already built. Measured live: **10,755 ms → 58 ms**.
   *
   *   A table that is not one of the three ignores this, so a descriptor on a
   *   physical table cannot be made to behave differently by declaring one.
   */
  pushdown?: (query: Record<string, unknown>) => SegmentFilter;
  /** Raw SQL fragment, trusted, author-supplied. Always gets the key appended. */
  defaultSort: string;
  tags: readonly TagName[];
  /** A row as the API returns it. `null`s are real here: most of these tables are sparse. */
  row: z.ZodTypeAny;
  /** Present only when the table may be written. Requires `pk`. */
  writes?: {
    create: z.ZodTypeAny;
    update: z.ZodTypeAny;
  };
  /** Set when GETs are allowed but nothing else is, to explain why in the spec. */
  readOnlyReason?: string;
}

function filterParam(f: ResourceFilter): string {
  return f.param ?? f.column.toLowerCase();
}

/**
 * Empty string means "not supplied" for a filter.
 *
 * Without this, `?vendor_id=` reaches `z.coerce.number()` as `Number('')` → `0`,
 * which is a valid integer, so the filter silently becomes `vendor_id = 0` and
 * the caller gets an empty page with a 200 and no hint that their parameter was
 * meaningless.
 */
const emptyToUndefined = (v: unknown): unknown =>
  typeof v === 'string' && v.trim() === '' ? undefined : v;

/**
 * The query-string schema for a resource: the shared `limit`/`offset`/`q`/`sort`
 * shape plus one optional parameter per declared filter.
 *
 * Exported so a bespoke collection route (a sub-resource, or a list of something
 * that is not a table) validates its query the same way the flat route does,
 * rather than accepting a `limit` as a string.
 */
export function queryFor(d: ResourceDescriptor): z.AnyZodObject {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of d.filters ?? []) {
    const param = filterParam(f);
    shape[param] =
      f.kind === 'integer'
        ? z.preprocess(emptyToUndefined, z.coerce.number().int().optional())
        : z.preprocess(emptyToUndefined, z.string().trim().max(200).optional());
  }
  return ListQuerySchema.extend(shape) as unknown as z.AnyZodObject;
}

/**
 * A stable tiebreaker for pagination.
 *
 * `ORDER BY VENDOR_NAME` alone is not a total order: two vendors sharing a name
 * can be returned in either order per query, so page 2 can repeat a row from page
 * 1 and drop another entirely. Appending the key makes the order total, and the
 * client's pages then tile the result set exactly once.
 */
function orderSql(d: ResourceDescriptor, sorts: ReturnType<typeof parseSort>): string {
  const base = orderByClause(sorts, d.defaultSort);
  if (!d.pk || sorts.some((s) => s.column === d.pk)) return base;
  return `${base}, ${quoteIdent(d.pk)} ASC`;
}

export interface ListOptions {
  /** Extra `AND`-ed predicates, appended after the standard ones. Trusted. */
  extraWhere?: readonly string[];
  /** Binds for `extraWhere`. */
  extraArgs?: Binds;
  /** Overrides the descriptor's search columns, e.g. to search a joined column. */
  searchColumns?: readonly string[];
}

/**
 * The list query behind every GET collection.
 *
 * Exported because a few endpoints are collections of something that is not a
 * table — the projects list is derived — and they should still get the same
 * search, sort, count and pagination behaviour rather than a second
 * implementation that drifts.
 */
export async function listRows<T = Record<string, unknown>>(
  d: ResourceDescriptor,
  query: Record<string, unknown>,
  options: ListOptions = {},
): Promise<Page<T>> {
  const where: string[] = [];
  const args: Binds = {};

  const term = typeof query.q === 'string' ? query.q : undefined;
  const searchColumns = options.searchColumns ?? d.searchable;
  if (term && searchColumns && searchColumns.length > 0) {
    const clause = likeClause(searchColumns, term);
    where.push(clause.sql);
    Object.assign(args, clause.args);
  }

  for (const f of d.filters ?? []) {
    const param = filterParam(f);
    const value = query[param];
    if (value === undefined || value === null || value === '') continue;
    const column = ident(f.column, d.columns, 'filter column');
    args[`f_${param}`] = bindable(value);
    where.push(`${column} = :f_${param}`);
  }

  for (const clause of options.extraWhere ?? []) where.push(clause);
  Object.assign(args, options.extraArgs ?? {});

  const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
  const table = await readSource(d, query);

  const limit = pageLimitWithinCeiling(Number(query.limit ?? 50), d.table);
  const offset = Number(query.offset ?? 0);
  const sorts = parseSort(typeof query.sort === 'string' ? query.sort : undefined, d.sortable ?? []);

  const total = await scalar(`SELECT COUNT(*) AS n FROM ${table}${whereSql}`, args);

  // ★ THE COUNT IS AN AGGREGATE, SO IT REFUSES RATHER THAN TRUNCATES. See
  //   `db/row-budget.ts` — "keep the first N" applied to a total produces a number
  //   that is wrong while looking right, which is worse than an error.
  //
  //   ★ Note what this guard does NOT do: it does not make the count cheaper. A
  //   scoped `COUNT(*)` is ~486,675 rows (measured under funds 02/04 + programs
  //   861/862/863 from fiscal 2021 — see `db/row-budget.ts`; `FUND_CODE=04` alone
  //   reads less, and a narrower scope cannot invalidate the wider figure as a
  //   bound) and answers in a couple of seconds; an unscoped one over 157 M rows is
  //   the cost this refuses, and it is refused only after paying it. The lever for
  //   the cost remains the scope, not the ceiling.
  refuseIfOverCeiling(total, d.table);

  const items = await rows<T>(
    `SELECT ${selectList(d)} FROM ${table}${whereSql} ${orderSql(d, sorts)} LIMIT :limit OFFSET :offset`,
    { ...args, limit, offset },
  );

  return page(items, pageMeta({ limit, offset }, total, items.length));
}

/** Fetch one row by key, or 404 naming the resource. */
export async function findRow<T = Record<string, unknown>>(d: ResourceDescriptor, id: unknown): Promise<T> {
  const pk = requirePk(d);
  const row = await one<T>(
    `SELECT ${selectList(d)} FROM ${await readSource(d)} WHERE ${quoteIdent(pk)} = :id`,
    { id: bindable(id) },
  );
  if (!row) throw AppError.notFound(`${d.label} ${String(id)}`);
  return row;
}

function requirePk(d: ResourceDescriptor): string {
  if (!d.pk) {
    throw new Error(
      `Resource ${d.name} has no primary key, so it has no detail route. ` +
        `Either add a key to the descriptor or do not register the detail route.`,
    );
  }
  return d.pk;
}

/**
 * Column names accepted by a write schema, in declaration order.
 *
 * Read back off the Zod shape rather than declared twice: the shape is what
 * validation actually enforced, so a column that survives `.strict()` parsing is
 * necessarily one the author meant to accept.
 */
function writableColumns(schema: z.ZodTypeAny): string[] {
  const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
  return shape ? Object.keys(shape) : [];
}

export interface ResourceRegistration {
  /** True when the resource was registered with write routes. */
  writable: boolean;
  /** Paths that were mounted, for the smoke test's conformance pass. */
  paths: string[];
}

/**
 * Mount a descriptor: list, and — if it has a key — detail, create, patch, delete.
 */
const descriptors: ResourceDescriptor[] = [];

/**
 * Every resource registered so far.
 *
 * Exported so a test can assert each descriptor's `columns`, `pk`, `searchable`,
 * `sortable` and filter columns really exist in the table. A typo in one of those
 * constants is otherwise invisible until the endpoint is called, where it
 * surfaces as `no such column` from SQLite — a runtime error on a route the
 * framework promised would work.
 */
export function registeredResources(): readonly ResourceDescriptor[] {
  return descriptors;
}

export function registerResource(api: Api, d: ResourceDescriptor): ResourceRegistration {
  descriptors.push(d);
  const query = queryFor(d);
  const paths: string[] = [];
  const readOnly = d.readOnlyReason !== undefined;

  /**
   * ★ WHETHER THIS RESOURCE CAN BE WRITTEN IS A QUESTION ABOUT ITS STORE, NOT
   *   ABOUT THE SERVER. `registerResource` is the only place a write route is
   *   created, and until now the test was the descriptor's own shape — it declares
   *   `writes` and a `pk`, so it is writable. That was true while there was one
   *   store: the whole process was either writable or it was not, and a descriptor
   *   with write schemas on a read-only deployment simply lost its routes.
   *
   *   With two stores the two halves disagree. Every one of the thirty-four
   *   descriptors names an EBS table, so all thirty-four belong to the ledger — and
   *   twenty of them declare `writes`, meaning the OpenAPI document promises POST
   *   and PATCH against Oracle tables that no account in this system can update.
   *   Under `DB_MODE=oracle` those twenty routes must not exist, and the two
   *   app-authored extract tables (`X_REPORT_PROJECT_FACTS`,
   *   `X_REPORT_FUNDING_LINES`) must keep theirs at the same time. One flag cannot
   *   express that, which is why the answer is looked up per table.
   *
   *   `writableForTable` throws for a table the registry does not know, and that is
   *   the intent: it is a defect in this codebase, not a bad request, and the smoke
   *   suite asserts it cannot happen for any registered descriptor.
   */
  const storeWrite = writableForTable(d.table);
  const writable = !readOnly && d.writes !== undefined && d.pk !== undefined && storeWrite.writable;

  /**
   * Why there are no write routes, when the descriptor itself did not say.
   *
   * The alternative is silence: a resource that declares `writes` and serves GET
   * only looks like a bug in the document. The reason is carried in words for the
   * same purpose as `readOnlyReason` — so the absence reads as a decision.
   */
  const noWriteReason =
    d.readOnlyReason ??
    (d.writes !== undefined && d.pk !== undefined && !storeWrite.writable
      ? `This resource is read-only: ${storeWrite.reason ?? 'its store does not accept writes'}`
      : undefined);

  api.route({
    method: 'get',
    path: d.basePath,
    operationId: `${d.name}_list`,
    summary: `List ${d.label.toLowerCase()} rows`,
    description: [
      `Rows from \`${d.table}\`.`,
      d.searchable?.length ? `\`?q=\` searches ${d.searchable.map((c) => `\`${c}\``).join(', ')}.` : undefined,
      d.sortable?.length ? `\`?sort=\` accepts ${d.sortable.map((c) => `\`${c}\``).join(', ')}.` : undefined,
      d.filters?.length
        ? `Exact-match filters: ${(d.filters ?? [])
            .map((f) => `\`${filterParam(f)}\` → \`${f.column}\``)
            .join(', ')}.`
        : undefined,
      // A read-only resource declares no write routes at all, so the only place to
      // say why is here. Without this the absence of POST/PATCH/DELETE in the
      // document reads as an omission rather than a decision. It now also carries
      // the *store's* refusal, which is a different fact from the descriptor's.
      noWriteReason,
      'An empty `data` array is a real answer, not an error — several tables in this sample are legitimately empty.',
    ]
      .filter((s): s is string => s !== undefined)
      .join(' '),
    tags: [...d.tags],
    query,
    response: d.row,
    paginated: true,
    handler: async (ctx) => listRows(d, ctx.query as Record<string, unknown>),
  });
  paths.push(`GET ${d.basePath}`);

  if (d.pk) {
    const idKind = d.pkKind === 'integer' ? IntParam : StrParam;
    const params = z.object({ id: idKind });

    api.route({
      method: 'get',
      path: `${d.basePath}/{id}`,
      operationId: `${d.name}_get`,
      summary: `Get one ${d.label.toLowerCase()}`,
      description: `The ${d.label.toLowerCase()} whose \`${d.pk}\` is \`{id}\`.`,
      tags: [...d.tags],
      params,
      response: d.row,
      errors: [400, 404, 500],
      handler: async (ctx) => findRow(d, ctx.params.id),
    });
    paths.push(`GET ${d.basePath}/{id}`);
  }

  if (writable) {
    const schema = d.writes!;
    const createColumns = writableColumns(schema.create);
    const updateColumns = writableColumns(schema.update);
    const params = z.object({ id: d.pkKind === 'text' ? StrParam : IntParam });

    api.route({
      method: 'post',
      path: d.basePath,
      operationId: `${d.name}_create`,
      summary: `Create a ${d.label.toLowerCase()}`,
      description:
        `Inserts into \`${d.table}\` and returns the stored row. ` +
        'Foreign keys are checked before the insert, so a reference to a row that does not exist ' +
        'is a 409 naming the column rather than an orphan row.',
      tags: [...d.tags],
      body: schema.create,
      response: d.row,
      errors: [400, 409, 500],
      handler: async (ctx) => {
        const body = ctx.body as Record<string, unknown>;
        const supplied = createColumns.filter((c) => body[c] !== undefined);
        if (supplied.length === 0) {
          throw AppError.badRequest('No fields were supplied.', { accepts: createColumns });
        }
        for (const c of supplied) ident(c, d.columns, 'field');
        await assertParentsExist(d.table, body);

        const args: Binds = {};
        const binds = supplied.map((c, i) => {
          args[`v${i}`] = bindable(body[c]);
          return `:v${i}`;
        });

        const result = await execute(
          `INSERT INTO ${quoteIdent(d.table)} (${supplied.map(quoteIdent).join(', ')}) VALUES (${binds.join(', ')})`,
          args,
        );

        const key = body[d.pk!] !== undefined ? body[d.pk!] : result.lastInsertRowid;
        if (key === null || key === undefined) {
          throw new AppError(
            500,
            'INTERNAL',
            `Inserted into ${d.table} but could not determine the new ${d.pk}.`,
          );
        }
        return findRow(d, key);
      },
    });
    paths.push(`POST ${d.basePath}`);

    api.route({
      method: 'patch',
      path: `${d.basePath}/{id}`,
      operationId: `${d.name}_update`,
      summary: `Update a ${d.label.toLowerCase()}`,
      description:
        'Partial update: only the supplied fields change. `null` clears a column, and omitting a ' +
        'field leaves it alone — the two are different requests and produce different rows.',
      tags: [...d.tags],
      params,
      body: schema.update,
      response: d.row,
      errors: [400, 404, 409, 500],
      handler: async (ctx) => {
        const body = ctx.body as Record<string, unknown>;
        const id = ctx.params.id;
        const supplied = updateColumns.filter((c) => body[c] !== undefined);
        if (supplied.length === 0) {
          throw AppError.badRequest('No fields were supplied.', { accepts: updateColumns });
        }
        for (const c of supplied) ident(c, d.columns, 'field');
        await assertParentsExist(d.table, body);

        const args: Binds = { id: bindable(id) };
        const sets = supplied.map((c, i) => {
          args[`v${i}`] = bindable(body[c]);
          return `${quoteIdent(c)} = :v${i}`;
        });

        const result = await execute(
          `UPDATE ${quoteIdent(d.table)} SET ${sets.join(', ')} WHERE ${quoteIdent(d.pk!)} = :id`,
          args,
        );

        // SQLite counts every row the UPDATE processed, whether or not the values
        // differed, so 0 here means "no such row" and not "nothing changed".
        if (result.rowsAffected === 0) throw AppError.notFound(`${d.label} ${String(id)}`);
        return findRow(d, id);
      },
    });
    paths.push(`PATCH ${d.basePath}/{id}`);

    api.route({
      method: 'delete',
      path: `${d.basePath}/{id}`,
      operationId: `${d.name}_delete`,
      summary: `Delete a ${d.label.toLowerCase()}`,
      description:
        'Refuses with 409 if anything still references the row, naming the referencing tables. ' +
        'See `GET /api/meta/relations` for the graph this is based on.',
      tags: [...d.tags],
      params,
      response: z.unknown(),
      status: 204,
      errors: [400, 404, 409, 500],
      handler: async (ctx) => {
        const pk = requirePk(d);
        const id = ctx.params.id;
        const existing = await one(
          `SELECT 1 AS ok FROM ${quoteIdent(d.table)} WHERE ${quoteIdent(pk)} = :id`,
          { id: bindable(id) },
        );
        if (!existing) throw AppError.notFound(`${d.label} ${String(id)}`);

        // Blocked here rather than left to the database, because the pragma that
        // would enforce it cannot be relied on — see `db/relations.ts`.
        await assertNoDependents(d.table, id);
        await execute(`DELETE FROM ${quoteIdent(d.table)} WHERE ${quoteIdent(pk)} = :id`, {
          id: bindable(id),
        });
        return undefined;
      },
    });
    paths.push(`DELETE ${d.basePath}/{id}`);
  }

  return { writable, paths };
}

/** True when `?flag=` was one of the truthy spellings. Re-exported for descriptors that need it. */
export { isTrue };
