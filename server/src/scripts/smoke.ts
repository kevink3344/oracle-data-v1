import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { createApp } from '../app.js';
import { config, DB_MODES } from '../config/env.js';
import { applyPragmas, closeDb, dbStatus, probeDb, storeDriver } from '../db/client.js';
import * as queryGuard from '../db/query-guard.js';
import { execute, quoteIdent, rows } from '../db/sql.js';
import { defaultTenant } from '../auth/session.js';
import { derivedPlan } from '../db/derived.js';
import { registeredRoutes } from '../http/api.js';
import { READ_ONLY_POSTS as readOnlyPosts } from '../http/middleware.js';
import { registeredResources } from '../routes/resource.js';
import { __guard as viewGuard } from '../routes/views.js';
import { APP_TABLES, ensureAppSchema } from '../db/app-schema.js';
import { ROUTING_APP_TABLES } from '../db/store.js';
import { scopeModeFor, storeFor } from '../routes/activity.js';
import { OVERRIDABLE, foldVendorKey, overridableSubjects } from '../custom-fields/registry.js';
import type { SqlDriver } from '../db/driver.js';
import { createRoutedDriver } from '../db/hybrid.js';
import {
  checkRegistry,
  classOfTable,
  routeStatement,
  storeForTable,
  tablesIn,
  tablesOfClass,
} from '../db/store.js';
import { inScope as assistantInScope, narrow as assistantNarrow } from '../ai/scope.js';
import { run as assistantRun } from '../ai/run.js';
import { buildSystemPrompt, parseIntent } from '../ai/intent.js';
import { aiStatus } from '../ai/model.js';

/**
 * End-to-end smoke test over a real HTTP server, in process.
 *
 * Two deliberate properties:
 *
 *  1. It talks HTTP rather than calling handlers directly, so routing, the
 *     validation middleware, the response envelope, and the error renderer are
 *     all in the path. A test that calls `handler(ctx)` skips every one of them.
 *
 *  2. It contains **controls that must fail**. A suite that only asserts success
 *     cannot tell a working server from a harness that swallows every error, so
 *     an unknown path, a bad enum, and a malformed body are all asserted to
 *     produce specific failures. Without them a green run means very little.
 *
 * Run:  npm run smoke
 */

interface Spec {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, {
    tags?: string[];
    operationId?: string;
    parameters?: { name: string; in: string; required?: boolean; schema?: { enum?: unknown[] } }[];
  }>>;
  components?: { schemas?: Record<string, unknown> };
  // The declared tag list, which `docs.ts` renders in declaration order
  // (`tagsSorter: undefined`) — so this array IS the Swagger grouping order.
  tags?: { name: string; description?: string }[];
}

/**
 * A file under `<repo>/data/sql/turso/`, from this module's own location.
 *
 * Resolved relative to `import.meta.url` rather than `process.cwd()` so it lands
 * in the same place run from `src/` (via tsx) and from `dist/`. `src/scripts/…`
 * and `dist/scripts/…` are both three levels below the repo root, which is what
 * makes one expression work for both.
 */
function sampleSql(file: string): URL {
  return new URL(`../../../data/sql/turso/${file}`, import.meta.url);
}

/** `CREATE TABLE` / `CREATE VIEW` statements in a DDL file, ignoring commented-out ones. */
function ddlCount(source: string, kind: 'TABLE' | 'VIEW'): number {
  return [...source.matchAll(new RegExp(`^\\s*CREATE\\s+${kind}\\b`, 'gim'))].length;
}

let passCount = 0;
let failCount = 0;
let skipCount = 0;

function label(name: string): void {
  process.stdout.write(`  ${name} … `);
}

function ok(): void {
  passCount += 1;
  process.stdout.write('ok\n');
}

/**
 * A check that could not be run, with the reason printed in full.
 *
 * ★ A SILENT SKIP AND A PASS LOOK IDENTICAL, AND THAT IS THE FAILURE THIS EXISTS TO
 *   AVOID. The assistant's end-to-end checks need a configured provider; with no key
 *   they cannot run. Reporting them green would be claiming a result the suite did
 *   not obtain, and failing them would blame the caller for an optional setting — so
 *   they are counted separately and the reason is on screen beside the name.
 *
 *   The *derivation* checks take no skip: the scope agreement, the population gate
 *   and the arithmetic need no provider, which is exactly why the design keeps them
 *   in their own modules.
 */
function skip(name: string, reason: string): void {
  skipCount += 1;
  label(name);
  process.stdout.write(`skip — ${reason}\n`);
}

function bad(error: unknown): void {
  failCount += 1;
  const message = error instanceof Error ? error.message : String(error);
  // Print enough of the assertion detail to diagnose without a re-run. An
  // `assert.equal` message's first line is just "Expected values to be strictly
  // equal:" — the useful part is on the lines after it.
  const lines = message
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0)
    .slice(0, 5);
  process.stdout.write(`FAIL\n${lines.map((l) => `      ${l}`).join('\n')}\n`);
}

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  label(name);
  try {
    await fn();
    ok();
  } catch (e) {
    bad(e);
  }
}

async function main(): Promise<void> {
  await applyPragmas();
  await probeDb();

  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;

  const status = dbStatus();
  console.log(`\nSmoke test — ${base}`);
  console.log(`  database: ${status.mode} → ${status.target} (writes ${
    status.writable ? 'enabled' : 'disabled'
  })\n`);

  const get = (path: string): Promise<Response> => fetch(`${base}${path}`);

  const post = (path: string, body: unknown): Promise<Response> =>
    send('POST', path, body);

  const patch = (path: string, body: unknown): Promise<Response> =>
    send('PATCH', path, body);

  const del = (path: string): Promise<Response> => fetch(`${base}${path}`, { method: 'DELETE' });

  function send(method: string, path: string, body: unknown): Promise<Response> {
    return fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  // ---- Meta ---------------------------------------------------------------

  await check('GET /api/health returns ok with the database ready', async () => {
    const res = await get('/api/health');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: { ok: boolean; dbReady: boolean; version: string } };
    assert.equal(body.data.ok, true);
    assert.equal(body.data.dbReady, true, 'dbReady was false — is the database reachable?');
    assert.ok(body.data.version.length > 0);
  });

  await check('GET /api/meta/config reports the resolved target', async () => {
    const res = await get('/api/meta/config');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: { dbMode: string; dbTarget: string } };
    // Against `DB_MODES`, not a second copy of it. This previously asserted
    // `['local', 'turso']`, which is the same shortened list the schema carried —
    // so under `DB_MODE=oracle` it would have reported the server's correct answer
    // as a failure, and it could never have caught the schema's error, because a
    // test and the thing it tests agreed on being wrong.
    assert.ok((DB_MODES as readonly string[]).includes(body.data.dbMode));
    assert.ok(body.data.dbTarget.length > 0);
    assert.ok(!JSON.stringify(body).includes('token'), 'config response must not carry a credential');
  });

  // The dictionary reads `sqlite_master`, so how many objects it lists is a
  // property of the built sample rather than of the API — and the two halves come
  // from two different files. Counting them here instead of writing the totals
  // down is not fussiness: this check previously asserted 60 objects, labelled
  // "36 tables + 24 views", against a sample that defines 36 tables and 6 views.
  // It had been failing for a while, and the message named the wrong culprit.
  const schemaSql = await readFile(sampleSql('00-schema.sql'), 'utf8');
  const appSql = await readFile(sampleSql('01-app.sql'), 'utf8');
  // `01-app.sql` is applied to the sample at runtime by `db/app-schema.ts`, so its
  // tables are present in the dictionary as soon as any saved-view route is called.
  //
  // ★ "AS SOON AS A SAVED-VIEW ROUTE IS CALLED" IS NOT SOON ENOUGH. This check runs
  //   in the Meta block, before any saved-view, project-registry or activity route
  //   has been touched — so on a database where the DDL has never been applied the
  //   applier has not run yet, and the counts below are short by exactly the app's
  //   own tables. That is not hypothetical: adding the two tenancy tables made this
  //   check fail on the first run and pass on the second, because the run in between
  //   had applied the DDL and left it behind. A gate whose result depends on whether
  //   a *previous* process happened to call a route is not a gate.
  //
  //   Applying it here is the honest fix, and it calls the same entry point the
  //   routes call — so this asserts the applier's real behaviour rather than a
  //   second opinion about it.
  await ensureAppSchema();
  //
  // ★ "AS SOON AS A SAVED-VIEW ROUTE IS CALLED" IS NOT SOON ENOUGH. This check runs
  //   in the Meta block, before any saved-view, project-registry or activity route
  //   has been touched — so on a database where the DDL has never been applied the
  //   applier has not run yet, and the count below is short by exactly the app's own
  //   tables. That is not hypothetical: adding the two tenancy tables made this
  //   check fail on the first run and pass on the second, because the run in between
  //   had applied the DDL and left it behind. A gate whose result depends on
  //   whether a *previous* process happened to call a route is not a gate.
  //
  //   Applying it here is the honest fix, and it is the same entry point the routes
  //   use, so this asks the applier the question the app asks it rather than a
  //   parallel question of its own.
  await ensureAppSchema();
  const appTables = ddlCount(appSql, 'TABLE');
  const expectedTables = ddlCount(schemaSql, 'TABLE') + appTables;
  const expectedViews = ddlCount(schemaSql, 'VIEW');

  await check('GET /api/meta/dictionary lists every table and view with columns', async () => {
    const res = await get('/api/meta/dictionary');
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      data: { name: string; type: string; rowCount: number | null; columns: { name: string }[] }[];
      page: { total: number; returned: number };
    };
    assert.equal(
      body.page.total,
      expectedTables + expectedViews,
      `expected ${expectedTables} tables + ${expectedViews} views = ${expectedTables + expectedViews} objects, ` +
        `got ${body.page.total}. Tables are 00-schema.sql plus the ${appTables} in 01-app.sql; views are 00-schema.sql.`,
    );
    assert.equal(body.page.returned, body.data.length);
    const tables = body.data.filter((o) => o.type === 'table').length;
    assert.equal(tables, expectedTables, `expected ${expectedTables} tables, got ${tables}`);
    const views = body.data.filter((o) => o.type === 'view').length;
    assert.equal(views, expectedViews, `expected ${expectedViews} views, got ${views}`);
    const combos = body.data.find((o) => o.name === 'GL_CODE_COMBINATIONS');
    assert.ok(combos, 'GL_CODE_COMBINATIONS missing from the dictionary');
    // 5 identifiers + SEGMENT1..7 + 3 audit columns.
    assert.equal(combos.columns.length, 15);
    // rowCount is null unless counts were asked for — null must not be smuggled in as 0.
    assert.equal(combos.rowCount, null);

    const position = body.data.find((o) => o.name === 'V_ACCOUNT_POSITION');
    assert.ok(position, 'V_ACCOUNT_POSITION missing from the dictionary');
    assert.equal(position.type, 'view');
    assert.equal(position.columns.length, 9);
  });

  await check('GET /api/meta/dictionary?counts=true counts each object in its own store', async () => {
    // ★ THE EXPECTED NUMBER CANNOT BE A LITERAL, BECAUSE WHICH STORE ANSWERS IS NOT
    //   FIXED. These assertions used to read `GL_CODE_COMBINATIONS = 520`,
    //   `PO_HEADERS_ALL = 749` and `SAMPLE_DATA_PROVENANCE = 559` — the sample
    //   file's own counts, written when the ledger *was* the sample file. Under
    //   `DB_MODE=oracle` the identical route answers 1,300,594 and 288,054, because
    //   routing sends those reads to the ledger; the check then failed with a number
    //   that was not wrong, and the failure read as a regression in the route.
    //
    //   The claim worth gating is not "this table holds N rows" — data is allowed to
    //   change, and the sample's numbers were never a contract. It is "the route
    //   counts each object in the store that owns it, and reports that store's number
    //   exactly". So every expectation is *measured* here, from the same store, and
    //   the assertion compares two reads of one database rather than one read against
    //   a memory of a different one.
    const res = await get('/api/meta/dictionary?counts=true&type=table');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: { name: string; rowCount: number | null }[] };
    const byName = new Map(body.data.map((o) => [o.name, o.rowCount]));

    for (const name of [
      'GL_CODE_COMBINATIONS',
      'PO_HEADERS_ALL',
      'SAMPLE_DATA_PROVENANCE',
      'PA_PROJECTS_ALL',
    ]) {
      const store = storeForTable(name);
      const direct = await storeDriver(store).execute({
        sql: `SELECT COUNT(*) AS n FROM ${quoteIdent(name)}`,
      });
      const expected = Number((direct.rows[0] as { n: unknown } | undefined)?.n);
      assert.ok(
        Number.isFinite(expected),
        `${name} must be countable in the ${store} store, or this check compares two unknowns`,
      );
      assert.equal(
        byName.get(name),
        expected,
        `${name} is counted in the ${store} store, so the dictionary must report that store's own count`,
      );
    }

    // ★ `0` AND `null` MUST NOT BE CONFUSED — and this loop is where that is proved
    //   rather than asserted in the abstract. `PA_PROJECTS_ALL` is genuinely empty on
    //   both targets, so a `0` here is a fact about the data; an object the store
    //   could not read has its key left *absent*, so `byName.get` returns `undefined`,
    //   which equals no number and fails the comparison above. "Empty" and "not
    //   counted" therefore take different paths through the same assertion.
    assert.ok(
      byName.has('PA_PROJECTS_ALL'),
      'PA_PROJECTS_ALL is empty and must still be reported as 0, not omitted as unreadable',
    );
  });

  await check('GET /api/meta/ledger-summary counts every object it serves', async () => {
    // ★ THE ARITHMETIC IS THE CLAIM, AND UNTIL THIS CHECK IT HAD NO DETRACTOR.
    //
    //   `countObjects` issued `SELECT COUNT(*) FROM "<name>"` for every descriptor.
    //   That is right for a table and wrong for the three composed reporting views,
    //   which have no table on Oracle at all — the object is *composed* from
    //   predicates. Their count came back `null`, and the endpoint answered a total
    //   **77,535 rows short** while carrying `uncounted: 3`. The sign-in screen said
    //   so out loud ("3 could not be counted and are left out of it") and thereby
    //   disagreed, on one card, with the figure the same card quoted from
    //   `LEDGER_SCALE` — a figure taken through the resolver, which had always
    //   counted all 32.
    //
    //   Nothing read this endpoint; the two paths over one ledger were each other's
    //   only witness. Comparing the parts to the whole is what would have caught it,
    //   because a `null` leaves the sum low by exactly the rows it could not route.
    //   That is what is asserted here.
    //
    //   COST: this is the slowest endpoint in the app (~51 s on Oracle, because it
    //   counts 157 M rows of GL_BALANCES and composes two views that take ~13 s
    //   each). A slow smoke run past this point is the endpoint, not a hang. In
    //   app-store mode it is a few seconds, and the claim is the same one.
    const res = await get('/api/meta/ledger-summary');
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      data: {
        ledgerRecords: number;
        appRecords: number;
        uncounted: number;
        objects: { name: string; label: string; store: string; rowCount: number | null }[];
      };
    };

    // One row per descriptor, deduped by table — the shape every assertion below
    // depends on. A duplicate would double-count in a sum and read as a bigger number.
    const described = new Set(registeredResources().map((r) => r.table));
    const names = body.data.objects.map((o) => o.name);
    assert.equal(
      names.length,
      described.size,
      `the summary lists ${names.length} objects for ${described.size} registered tables`,
    );
    assert.equal(new Set(names).size, names.length, 'an object is listed twice');

    // `rowCount: null` means "the resolver could not route this object" — which is a
    // hole in the total, not an empty table. Name every hole, because the number in
    // the failure is the only clue to which object needs an Oracle source.
    const holes = body.data.objects.filter((o) => o.rowCount === null).map((o) => o.name);
    assert.equal(
      holes.length,
      0,
      `these descriptors resolved to no source, so the total is short by their rows: ` +
        `${holes.join(', ')}. A ledger table needs Oracle to hold it; a composed one needs a ` +
        `fragment in db/derived.ts; an app-owned one must be classified as app by storeForTable.`,
    );
    assert.equal(body.data.uncounted, holes.length);

    const sumOf = (store: string): number =>
      body.data.objects
        .filter((o) => o.store === store)
        .reduce((total, o) => total + (o.rowCount ?? 0), 0);

    // The whole reason the endpoint reports its parts: the total must be the sum of
    // them. If a count is ever taken somewhere the payload does not name, this fails
    // while `uncounted` is still 0 — the one shape the hole check above cannot see.
    assert.equal(
      sumOf('ledger'),
      body.data.ledgerRecords,
      `the ledger objects sum to ${sumOf('ledger')} but the endpoint reports ${body.data.ledgerRecords}`,
    );
    assert.equal(
      sumOf('app'),
      body.data.appRecords,
      `the app objects sum to ${sumOf('app')} but the endpoint reports ${body.data.appRecords}`,
    );
  });

  // ---- OpenAPI / Swagger UI ----------------------------------------------

  await check('GET /api/docs.json serves an OpenAPI 3.0 document', async () => {
    const res = await get('/api/docs.json');
    assert.equal(res.status, 200);
    const spec = (await res.json()) as Spec;
    assert.equal(spec.openapi, '3.0.0');
    assert.equal(spec.info.title, 'Oracle Projects API');
    assert.ok(
      Object.keys(spec.paths).length >= 5,
      `the spec has only ${Object.keys(spec.paths).length} paths — the document was built before the routers registered`,
    );
    assert.ok(spec.paths['/api/health'], '/api/health is not in the spec');
    assert.ok(spec.paths['/api/docs'], '/api/docs is not in the spec');
    assert.ok(spec.components?.schemas?.Error, 'the Error schema is not registered');
    assert.ok(spec.components?.schemas?.PageMeta, 'the PageMeta schema is not registered');
  });

  await check('the spec describes the flag query as a real enum', async () => {
    const res = await get('/api/docs.json');
    const spec = (await res.json()) as Spec;
    const params = spec.paths['/api/meta/dictionary']?.get?.parameters ?? [];
    const counts = params.find((p) => p.name === 'counts');
    assert.ok(counts, 'the counts parameter is missing from the spec');
    assert.equal(counts.in, 'query');
    assert.deepEqual(counts.schema?.enum, ['true', 'false', '1', '0']);
  });

  await check('the spec and the router describe the same paths', async () => {
    const res = await get('/api/docs.json');
    const spec = (await res.json()) as Spec;

    const specKeys = new Set<string>();
    for (const [path, ops] of Object.entries(spec.paths)) {
      for (const method of Object.keys(ops)) specKeys.add(`${method.toUpperCase()} ${path}`);
    }
    // `/api/docs` is mounted by express-free middleware rather than through
    // `api.route`, and `/api/docs.json` is a plain `app.get`. Both are real; they
    // just never pass through the registry's duplicate check.
    specKeys.delete('GET /api/docs');
    specKeys.delete('GET /api/docs.json');

    const routed = new Set(registeredRoutes());

    const undocumented = [...routed].filter((k) => !specKeys.has(k));
    const unrouted = [...specKeys].filter((k) => !routed.has(k));
    assert.deepEqual(undocumented, [], `served but absent from the spec: ${undocumented.join(', ')}`);
    assert.deepEqual(unrouted, [], `documented but not routed: ${unrouted.join(', ')}`);
    // Derived from the registry rather than guessed at: every descriptor registers a
    // list route, so the route count can never fall below the resource count. A
    // domain that silently fails to register drops both, so the per-domain sections
    // below assert their own base paths by name.
    const resources = registeredResources().length;
    assert.ok(
      routed.size >= resources,
      `only ${routed.size} routes for ${resources} resources — a domain failed to register`,
    );
  });

  await check('every parameterless spec path is served (a 404 here means the spec lies)', async () => {
    const res = await get('/api/docs.json');
    const spec = (await res.json()) as Spec;
    const missing: string[] = [];
    for (const [path, ops] of Object.entries(spec.paths)) {
      if (!('get' in ops)) continue;
      if (path === '/api/docs') continue;
      // Only paths with no `{param}`. Probing `/api/vendors/1` proves nothing:
      // the row does not exist, so the 404 is the correct answer and is
      // indistinguishable from the path not being mounted at all.
      if (path.includes('{')) continue;
      const probe = await get(path);
      if (probe.status === 404) missing.push(path);
    }
    assert.deepEqual(missing, [], `documented but not routed: ${missing.join(', ')}`);
  });

  await check('GET /api/docs serves the Swagger UI page', async () => {
    const res = await get('/api/docs');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const html = await res.text();
    assert.match(html, /swagger/i);
  });

  // ---- Resource descriptors ----------------------------------------------

  await check('every resource descriptor names columns its table actually has', async () => {
    const resources = registeredResources();
    assert.ok(resources.length > 0, 'no resources are registered');

    const problems: string[] = [];
    for (const d of resources) {
      const live = new Set(
        (await rows<{ name: string }>(`SELECT name FROM pragma_table_info(?)`, [d.table])).map(
          (r) => r.name,
        ),
      );
      if (live.size === 0) {
        problems.push(`${d.basePath}: table ${d.table} does not exist`);
        continue;
      }
      const wanted = [
        ...d.columns,
        ...(d.pk === undefined ? [] : [d.pk]),
        ...(d.searchable ?? []),
        ...(d.sortable ?? []),
        ...(d.filters ?? []).map((f) => f.column),
      ];
      const absent = [...new Set(wanted)].filter((c) => !live.has(c)).sort();
      if (absent.length > 0) problems.push(`${d.basePath}: ${absent.join(', ')} not in ${d.table}`);
    }
    assert.deepEqual(problems, [], problems.join(' | '));
  });

  // ---- Vendors ------------------------------------------------------------

  await check('GET /api/vendors pages the whole vendor table', async () => {
    const res = await get('/api/vendors?limit=5');
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      data: { VENDOR_ID: number; VENDOR_NAME: string }[];
      page: { limit: number; offset: number; total: number; returned: number };
    };
    // 157 is the sample's real count; `total` proves the count query and the page
    // query are reading the same table, which a row count alone does not.
    assert.equal(body.page.total, 157);
    assert.equal(body.data.length, 5);
    assert.equal(body.page.returned, 5);
    // defaultSort is VENDOR_NAME ASC, so the names must arrive in order.
    const names = body.data.map((v) => v.VENDOR_NAME);
    assert.deepEqual(names, [...names].sort());
  });

  await check('GET /api/vendors honours a filter and a search together', async () => {
    const res = await get('/api/vendors?enabled_flag=Y&limit=200');
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: { ENABLED_FLAG: string | null }[] };
    assert.ok(body.data.length > 0, 'no enabled vendors');
    assert.ok(body.data.every((v) => v.ENABLED_FLAG === 'Y'), 'the filter leaked a non-Y row');

    const searched = await get('/api/vendors?q=' + encodeURIComponent('a') + '&limit=3');
    assert.equal(searched.status, 200);
    const sbody = (await searched.json()) as { page: { total: number } };
    assert.ok(sbody.page.total > 0, 'searching for "a" matched nothing across 157 vendors');
    assert.ok(sbody.page.total <= 157, 'a search cannot match more rows than exist');
  });

  await check('GET /api/vendors/{id}/detail returns sites and both counts', async () => {
    const list = await get('/api/vendors?limit=1');
    const first = ((await list.json()) as { data: { VENDOR_ID: number }[] }).data[0];
    assert.ok(first, 'the vendor list is empty, so there is nothing to drill into');

    const res = await get(`/api/vendors/${first.VENDOR_ID}/detail`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      data: { vendor: { VENDOR_ID: number }; sites: unknown[]; siteCount: number; poCount: number };
    };
    assert.equal(body.data.vendor.VENDOR_ID, first.VENDOR_ID);
    // siteCount is deliberately `sites.length`, so the two can never disagree.
    assert.equal(body.data.siteCount, body.data.sites.length);
    assert.equal(body.data.siteCount, 1, 'every vendor in this sample has exactly one site');
    assert.ok(body.data.poCount >= 0, 'poCount should be a real count, not absent');
  });

  await check('the vendor sub-resources agree with the flat routes', async () => {
    const list = await get('/api/vendors?limit=1');
    const first = ((await list.json()) as { data: { VENDOR_ID: number }[] }).data[0];
    assert.ok(first, 'the vendor list is empty');

    const sub = await get(`/api/vendors/${first.VENDOR_ID}/sites`);
    assert.equal(sub.status, 200);
    const subBody = (await sub.json()) as { data: { VENDOR_ID: number }[]; page: { total: number } };
    assert.ok(subBody.data.every((s) => s.VENDOR_ID === first.VENDOR_ID));

    const flat = await get(`/api/vendor-sites?vendor_id=${first.VENDOR_ID}`);
    assert.equal(flat.status, 200);
    const flatBody = (await flat.json()) as { page: { total: number } };
    // Two routes, one query — if these diverge, one of them is lying.
    assert.equal(
      subBody.page.total,
      flatBody.page.total,
      'the sub-resource and the filter disagree about how many sites this vendor has',
    );

    // The whole site table, so the flat route is not silently scoped to one vendor.
    const all = await get('/api/vendor-sites?limit=1');
    const allBody = (await all.json()) as { page: { total: number } };
    assert.equal(allBody.page.total, 157);
  });

  await check('a missing row is 404, from the row lookup and not from routing', async () => {
    const res = await get('/api/vendors/999999');
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'NOT_FOUND');

    const detail = await get('/api/vendors/999999/detail');
    assert.equal(detail.status, 404, 'a non-existent vendor must not report an empty detail page');
  });

  await check(
    `a descriptor write is ${dbStatus().writable ? 'permitted' : 'refused with 409'} on this target`,
    async () => {
      // The list route must answer either way; only the writes are gated. If this
      // failure came from the whole vendor router being absent, the test would
      // pass for the wrong reason — so assert the read works immediately next to
      // it.
      const read = await get('/api/vendors?limit=1');
      assert.equal(read.status, 200, 'the vendor list should be readable regardless of the write policy');

      const res = await post('/api/vendors', { VENDOR_NAME: 'smoke test vendor', ENABLED_FLAG: 'Y' });

      // The expected answer is a property of the target, not a constant. Hard-coding
      // 409 here made the suite pass only while `DB_MODE=turso` with writes locked,
      // which is the one configuration where the write path is never exercised.
      if (dbStatus().writable) {
        const created = (await res.json().catch(() => undefined)) as { data?: { VENDOR_ID?: number } } | undefined;
        const id = created?.data?.VENDOR_ID;
        // Cleanup runs in a `finally`, and the status assert runs after it. An
        // assert that throws first strands the row, and the *next* check then
        // measures the litter: the delete test failed with an off-by-one that had
        // nothing to do with the delete it was testing.
        try {
          assert.equal(res.status, 201, 'the guard should not fire on a writable target');
          assert.ok(typeof id === 'number', 'a create must return the new row, including its key');
        } finally {
          if (typeof id === 'number') {
            const cleanup = await del(`/api/vendors/${id}`);
            assert.ok([204, 200].includes(cleanup.status), `cleanup DELETE returned ${cleanup.status}`);
          }
        }
      } else {
        assert.equal(res.status, 409);
        const body = (await res.json()) as { error: { code: string } };
        assert.equal(body.error.code, 'WRITES_DISABLED');
      }
    },
  );

  // ---- Procurement --------------------------------------------------------

  await check('GET /api/procurement/summary counts the whole chain, not a page', async () => {
    const res = await get('/api/procurement/summary');
    assert.equal(res.status, 200);
    const { data } = (await res.json()) as {
      data: {
        counts: {
          orders: number;
          lines: number;
          shipments: number;
          distributions: number;
          agents: number;
          vendors: number;
        };
        committed: { ordered: number; encumbered: number; billed: number; distinctAccounts: number };
        byType: { typeLookupCode: string | null; orders: number; amountOrdered: number }[];
        topAccounts: { codeCombinationId: number; distributions: number; amountOrdered: number }[];
      };
    };

    // Named fields rather than `Record<string, number>` on purpose: with an index
    // signature every read is `number | undefined`, so a field the server did not
    // actually send is silently `undefined` and the comparison quietly fails. Naming
    // them turns that into a compile error.
    assert.ok(data.counts.orders > 0, 'procurement should not be empty');
    assert.ok(data.counts.lines >= data.counts.orders, 'every order has at least one line');
    assert.ok(data.committed.ordered > 0, 'committed value should be positive');

    // Do NOT assert `distributions >= lines`. It is the relation you would guess,
    // and the sample contradicts it: 2,805 lines against 2,802 distributions, so
    // three lines are ordered and charged to nobody. Neither `>=` nor `<=` holds in
    // general — a line may have several distributions or none.
    const orphanDistributions = await rows<{ n: number }>(
      `SELECT COUNT(*) AS n FROM PO_DISTRIBUTIONS_ALL d ` +
        `LEFT JOIN PO_LINES_ALL l ON l.PO_LINE_ID = d.PO_LINE_ID WHERE l.PO_LINE_ID IS NULL`,
    );
    assert.equal(orphanDistributions[0]?.n, 0, 'a distribution points at a line that does not exist');

    // The reason the money is read off the distributions rather than off the line
    // prices. The two are close and they are not equal — measured, they differ by
    // 32,566.75, because 52 lump-sum lines carry QUANTITY 0 and a real amount. The
    // endpoint promises the distribution figure, so the check is that the two
    // *differ*: that is what makes the choice a decision rather than a coincidence,
    // and it is what would go red if someone "simplified" the summary to use
    // UNIT_PRICE * QUANTITY.
    const both = await rows<{ from_lines: number; from_distributions: number }>(
      `SELECT (SELECT COALESCE(SUM(UNIT_PRICE * QUANTITY), 0) FROM PO_LINES_ALL) AS from_lines, ` +
        `(SELECT COALESCE(SUM(AMOUNT_ORDERED), 0) FROM PO_DISTRIBUTIONS_ALL) AS from_distributions`,
    );
    const fromLines = both[0]?.from_lines ?? 0;
    const fromDistributions = both[0]?.from_distributions ?? 0;
    assert.ok(
      Math.abs(fromLines - fromDistributions) > 0.01,
      'line prices and distribution amounts agree here, so the choice of grain is untested',
    );
    assert.ok(
      Math.abs(data.committed.ordered - fromDistributions) < 0.01,
      `the summary reports ${data.committed.ordered}, not the distribution total ${fromDistributions}`,
    );

    // Descending order is a promise the endpoint makes; a client takes the first
    // row as "the biggest". If the sort were dropped the payload would still look
    // plausible.
    const amounts = data.byType.map((t) => t.amountOrdered);
    assert.deepEqual(amounts, [...amounts].sort((a, b) => b - a), 'byType must be largest-first');
    const top = data.topAccounts.map((t) => t.amountOrdered);
    assert.deepEqual(top, [...top].sort((a, b) => b - a), 'topAccounts must be largest-first');
    assert.ok(data.topAccounts.length <= 8, 'topAccounts is capped at eight');

    // The summary claims to be over the whole table. Verify the headline against
    // the database directly, the way a reader would.
    const live = await rows<{ n: number; total: number }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM("AMOUNT_ORDERED"), 0) AS total FROM PO_DISTRIBUTIONS_ALL`,
    );
    assert.equal(data.counts.distributions, live[0]?.n, 'the summary disagrees with a direct COUNT');
    assert.ok(
      Math.abs(data.committed.ordered - (live[0]?.total ?? 0)) < 0.01,
      `the summary total ${data.committed.ordered} disagrees with the SUM ${live[0]?.total}`,
    );
  });

  await check('a purchase order\u2019s detail totals equal its distributions', async () => {
    // Descending is a `-` prefix, not a ` COLLATE`-style suffix: `parseSort`
    // allowlists the bare column name and rejects `PO_HEADER_ID DESC` with a 400.
    // The default sort already puts the newest order first, so no sort is needed.
    const list = await get('/api/purchase-orders?limit=1');
    assert.equal(list.status, 200);
    const page = (await list.json()) as { data: { PO_HEADER_ID: number }[] };
    const id = page.data[0]?.PO_HEADER_ID;
    assert.ok(typeof id === 'number', 'the sample should contain at least one purchase order');

    const detail = await get(`/api/purchase-orders/${id}/detail`);
    assert.equal(detail.status, 200);
    const { data } = (await detail.json()) as {
      data: {
        order: { PO_HEADER_ID: number };
        lines: unknown[];
        counts: { lines: number; shipments: number; distributions: number };
        totals: { ordered: number; billed: number; encumbered: number; distinctAccounts: number };
      };
    };
    assert.equal(data.order.PO_HEADER_ID, id, 'the detail must be for the order that was asked for');
    // `counts.lines` is defined as the length of the array, so a mismatch means the
    // handler went back to the database for a number that could drift from it.
    assert.equal(data.counts.lines, data.lines.length, 'counts.lines must equal the lines returned');

    // The point of the whole module: the totals come from the distributions. If
    // they were summed from line prices instead, they would not agree with the
    // distribution rows the API itself serves.
    const dists = await get(`/api/purchase-orders/${id}/distributions?limit=500`);
    assert.equal(dists.status, 200);
    const dpage = (await dists.json()) as {
      data: { AMOUNT_ORDERED: number; AMOUNT_BILLED: number; ENCUMBERED_AMOUNT: number }[];
      page: { total: number };
    };
    assert.equal(data.counts.distributions, dpage.page.total, 'counts.distributions must equal the distribution page total');
    const sum = (pick: (r: (typeof dpage.data)[number]) => number): number =>
      dpage.data.reduce((acc, r) => acc + (pick(r) ?? 0), 0);
    assert.ok(
      Math.abs(data.totals.ordered - sum((r) => r.AMOUNT_ORDERED)) < 0.01,
      `totals.ordered ${data.totals.ordered} ≠ the sum of its own distributions ${sum((r) => r.AMOUNT_ORDERED)}`,
    );
    assert.ok(
      Math.abs(data.totals.encumbered - sum((r) => r.ENCUMBERED_AMOUNT)) < 0.01,
      'totals.encumbered disagrees with the sum of its own distributions',
    );
  });

  await check('the procurement sub-resources agree with the flat routes', async () => {
    const list = await get('/api/purchase-orders?limit=1');
    const page = (await list.json()) as { data: { PO_HEADER_ID: number }[] };
    const id = page.data[0]?.PO_HEADER_ID;
    assert.ok(typeof id === 'number');

    for (const [sub, flat] of [
      ['lines', '/api/purchase-order-lines'],
      ['shipments', '/api/purchase-order-shipments'],
      ['distributions', '/api/purchase-order-distributions'],
    ] as const) {
      const viaSub = await get(`/api/purchase-orders/${id}/${sub}?limit=1`);
      const viaFlat = await get(`${flat}?po_header_id=${id}&limit=1`);
      assert.equal(viaSub.status, 200, `${sub}: sub-resource returned ${viaSub.status}`);
      assert.equal(viaFlat.status, 200, `${sub}: flat route returned ${viaFlat.status}`);
      const a = (await viaSub.json()) as { page: { total: number } };
      const b = (await viaFlat.json()) as { page: { total: number } };
      assert.equal(a.page.total, b.page.total, `${sub}: the two routes disagree about the row count`);
    }
  });

  await check('a composite-keyed reference table is readable and refuses writes', async () => {
    const res = await get('/api/lookup-codes');
    assert.equal(res.status, 200);
    const page = (await res.json()) as { data: unknown[]; page: { total: number } };
    assert.ok(page.page.total > 0, 'the reference table should not be empty');

    // Filtering by a column that is not the first half of the key, to prove the
    // filter works on the column it names rather than on the key's leading part.
    const filtered = await get('/api/lookup-codes?type=PO%20TYPE');
    const fp = (await filtered.json()) as { page: { total: number } };
    assert.ok(fp.page.total > 0, 'no codes came back for PO TYPE');

    // The descriptor declares no `writes` for this table because its key is two
    // columns, and `registerResource` therefore mounts no write route at all. On a
    // writable target that must be a 404 — a route that does not exist — and not a
    // 409 from the guard, which would mean a write route *is* mounted and is only
    // being stopped by policy.
    const write = await post('/api/lookup-codes', { LOOKUP_TYPE: 'PO TYPE', LOOKUP_CODE: 'ZZ' });
    if (dbStatus().writable) {
      assert.equal(write.status, 404, `expected no write route, got ${write.status}`);
    } else {
      assert.equal(write.status, 409, 'the writes guard should refuse before routing is reached');
    }
  });

  await check('a missing purchase order is 404, from the row lookup and not from routing', async () => {
    // The spec/route comparison above already proved this path is mounted, which
    // is the only way to tell this 404 from an unrouted path.
    const res = await get('/api/purchase-orders/2147483000/detail');
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'NOT_FOUND');
  });

  // ---- Writes (skipped by design when the target refuses them) -----------
  //
  // Everything above proves the API reads correctly. None of it proves the write
  // path works, because against the locked remote the guard rejects every mutation
  // before a handler, a transaction or a constraint is reached. That is a whole
  // mode of the server left untested, so when the target does accept writes this
  // section runs a full create → read → patch → duplicate-key → delete lifecycle.
  //
  // It uses a sentinel key far outside the sample's range and removes what it
  // created, so it is safe to point at the real local sample file — the net effect
  // is nil, and the delete is asserted rather than assumed.

  const PROBE_ID = 900000001;
  const PROBE_NAME = 'zz smoke probe vendor (safe to delete)';

  if (!dbStatus().writable) {
    console.log('  (writes section skipped: this target refuses mutations)\n');
  } else {
    await check('POST /api/vendors creates a row and returns the stored values', async () => {
      const res = await post('/api/vendors', {
        VENDOR_ID: PROBE_ID,
        VENDOR_NAME: PROBE_NAME,
        ENABLED_FLAG: 'Y',
        VENDOR_TYPE_LOOKUP_CODE: 'SUPPLIER',
      });
      // `await res.text()` must NOT sit in the assert message: a template literal
      // is evaluated before the call, so the body is consumed by a message that is
      // only wanted when the assert *fails*. That produced "Body has already been
      // read" on a passing check.
      if (res.status !== 201) {
        throw new Error(`expected 201, got ${res.status}: ${await res.text()}`);
      }
      const body = (await res.json()) as { data: Record<string, unknown> };
      // A create that answers 201 and then returns a different row is worse than
      // one that fails, so the echo is checked field by field.
      assert.equal(body.data.VENDOR_ID, PROBE_ID);
      assert.equal(body.data.VENDOR_NAME, PROBE_NAME);
      assert.equal(body.data.ENABLED_FLAG, 'Y');
      assert.equal(body.data.VENDOR_TYPE_LOOKUP_CODE, 'SUPPLIER');
    });

    await check('the created row is immediately readable and searchable', async () => {
      const one = await get(`/api/vendors/${PROBE_ID}`);
      assert.equal(one.status, 200);
      const found = await get(`/api/vendors?q=${encodeURIComponent('smoke probe vendor')}`);
      const body = (await found.json()) as { data: { VENDOR_ID: number }[]; page: { total: number } };
      assert.ok(body.page.total >= 1, 'the created row must appear in a search for its own name');
      assert.ok(
        body.data.some((r) => r.VENDOR_ID === PROBE_ID),
        'the created row must be in the page returned for that search',
      );
    });

    await check('PATCH changes only the supplied column', async () => {
      const res = await patch(`/api/vendors/${PROBE_ID}`, { ENABLED_FLAG: 'N' });
      assert.equal(res.status, 200, `expected 200, got ${res.status}`);
      const body = (await res.json()) as { data: Record<string, unknown> };
      assert.equal(body.data.ENABLED_FLAG, 'N', 'the patched column should hold its new value');
      // The distinction a partial update exists to make: an omitted field is left
      // alone, and is not the same request as sending null.
      assert.equal(body.data.VENDOR_NAME, PROBE_NAME, 'an omitted field must survive the patch untouched');
    });

    await check('a duplicate primary key is a 409, not a 500', async () => {
      const res = await post('/api/vendors', { VENDOR_ID: PROBE_ID, VENDOR_NAME: 'duplicate probe' });
      // This is the constraint classifier in the error handler. Without it the
      // driver error is unrecognised and surfaces as 500 INTERNAL, which tells the
      // caller their request was fine and the server is broken. The opposite is true.
      assert.equal(res.status, 409, `a duplicate key must be a conflict, got ${res.status}`);
      const body = (await res.json()) as { error: { code: string; details?: { constraint?: string } } };
      assert.equal(body.error.code, 'CONFLICT');
      assert.ok(body.error.details?.constraint, 'the conflict should name which constraint was hit');
    });

    await check('a write naming an absent parent is a 409 naming the column', async () => {
      const res = await post('/api/vendor-sites', { VENDOR_ID: 999999999, VENDOR_SITE_CODE: 'PROBE' });
      assert.equal(res.status, 409, `expected 409 for a missing parent, got ${res.status}`);
      const body = (await res.json()) as {
        error: { code: string; details?: { reason?: string; column?: string } };
      };
      assert.equal(body.error.code, 'CONFLICT');
      assert.equal(body.error.details?.reason, 'MISSING_PARENT');
      assert.equal(body.error.details?.column, 'VENDOR_ID');
    });

    await check('DELETE removes the row and the table returns to its original count', async () => {
      const before = await get('/api/vendors?limit=1');
      const beforeTotal = ((await before.json()) as { page: { total: number } }).page.total;

      const res = await del(`/api/vendors/${PROBE_ID}`);
      assert.ok([200, 204].includes(res.status), `expected 204, got ${res.status}`);

      const gone = await get(`/api/vendors/${PROBE_ID}`);
      assert.equal(gone.status, 404, 'the deleted row must be gone, not merely hidden from the list');

      const after = await get('/api/vendors?limit=1');
      const afterTotal = ((await after.json()) as { page: { total: number } }).page.total;
      // `before` was read while the probe row existed, so the correct invariant is
      // `before - 1` — the probe is one row and it is gone. Comparing against
      // `before` itself asserted that the delete had not worked.
      assert.equal(afterTotal, beforeTotal - 1, 'the probe row must not leave the table larger than it started');
    });

    await check('deleting a row that still has children is a 409 naming the dependents', async () => {
      // Pick a vendor the sample really gives sites to, rather than assuming one.
      const parents = await rows<{ VENDOR_ID: number }>(
        `SELECT VENDOR_ID FROM PO_VENDOR_SITES_ALL WHERE VENDOR_ID IS NOT NULL LIMIT 1`,
      );
      if (parents.length === 0) {
        // Nothing to prove: assert the precondition rather than pass vacuously.
        throw new Error('the sample has no vendor with a site, so this check cannot be evaluated');
      }
      const id = parents[0]!.VENDOR_ID;

      const res = await del(`/api/vendors/${id}`);
      assert.equal(res.status, 409, `deleting a vendor with sites must be refused, got ${res.status}`);
      const body = (await res.json()) as {
        error: { code: string; details?: { reason?: string; dependents?: unknown[] } };
      };
      assert.equal(body.error.details?.reason, 'HAS_DEPENDENTS');
      assert.ok((body.error.details?.dependents?.length ?? 0) > 0, 'the refusal must name what depends on it');

      // The refusal must not have deleted anything on its way out.
      const still = await get(`/api/vendors/${id}`);
      assert.equal(still.status, 200, 'a refused delete must leave the row exactly where it was');
    });
  }

  // ---- Funding ------------------------------------------------------------
  //
  // The entire reason `/api/funding` exists is the gap between a naive sum over
  // `GL_BALANCES` and the same sum with the five predicates the reporting views
  // apply. So none of the checks below compare against a constant. They compare the
  // endpoint against a direct aggregate over the same view, and then assert that the
  // naive aggregates *disagree* — which is what shows the predicates are load-bearing
  // rather than decorative. If the naive number ever happened to match, that check
  // would prove nothing and its message says so.

  await check('every Funding and Chart of Accounts resource is mounted, listed and documented', async () => {
    const spec = (await (await get('/api/docs.json')).json()) as Spec;
    const routed = new Set(registeredRoutes());
    const targets = registeredResources().filter(
      (r) => r.tags.includes('Funding') || r.tags.includes('Chart of Accounts'),
    );
    assert.ok(
      targets.length >= 21,
      `expected 10 funding + 11 chart-of-accounts resources, found ${targets.length}`,
    );
    for (const r of targets) {
      assert.ok(spec.paths[r.basePath]?.get, `${r.basePath} is registered but absent from the spec`);
      assert.ok(routed.has(`GET ${r.basePath}`), `${r.basePath} is documented but not routed`);
      // A descriptor whose `row` schema has no fields would satisfy every other
      // check here and still render an empty table, so the shape is asserted too.
      // `row` is typed as `ZodTypeAny` in the descriptor, hence the narrow cast.
      const shape = (r.row as unknown as { shape?: Record<string, unknown> }).shape;
      assert.ok(
        shape !== undefined && Object.keys(shape).length > 0,
        `${r.name} declares a row schema with no fields — nothing would be returned`,
      );
    }
  });

  /**
   * ★★ THE TWO CHECKS THAT FOLLOW MUST READ THE RELATION THE ENDPOINT READS, NOT A NAME.
   *
   *   `V_ACCOUNT_POSITION` and `V_BUDGET_BY_ACCOUNT_PERIOD` are the **bundled sample's**
   *   views. The live instance has **neither** — measured, with controls, on the same
   *   connection that serves the endpoint: `SELECT COUNT(*) FROM "V_ACCOUNT_POSITION"`
   *   answers `ORA-00942: table or view does not exist`, while `GET /api/funding/summary`
   *   answers 200. Those two facts are not in tension; they are the reason `db/derived.ts`
   *   exists. The route composes the relation inline from `GL_CODE_COMBINATIONS` and
   *   `GL_BALANCES` precisely because the view is not installed on the live ledger.
   *
   *   So a check that writes the view's name by hand is green on `local` and red on the live
   *   arm, and **the redness belongs to the check and not to the endpoint.** It sat red there
   *   for two segments and read as a funding defect, because `ORA-00942` names no object and
   *   the message therefore pointed at the route. The status assert is what gives it away:
   *   it runs FIRST, so by the time the view query throws, the endpoint has already answered
   *   200 and the only failing statement in the check is our own.
   *
   *   ★ THE RESOLUTION IS THE ENDPOINT'S OWN, WHICH IS THE POINT — NOT A SECOND OPINION AND
   *     NOT A RUNTIME FALLBACK. `derivedPlan` returning `null` means "not Oracle, and the real
   *     view is present", so this helper reads the view locally and the exact fragment the
   *     route interpolates on the live arm. The check then means one sentence on both arms:
   *     *the endpoint's total equals a direct aggregate over the relation the endpoint read.*
   *     Probed-then-fallen-back would instead make the relation a function of ambient state
   *     rather than of the code — the one thing this suite refuses to do.
   *
   *   ★ IT ASSERTS RATHER THAN THROWS, unlike the route's `composedFrom`, because an
   *     un-composable relation here is a *result* this suite must report, not a 503 to serve.
   */
  async function reportingRelation(
    table: 'V_ACCOUNT_POSITION' | 'V_BUDGET_BY_ACCOUNT_PERIOD',
  ): Promise<string> {
    const plan = derivedPlan(table, await defaultTenant());
    if (plan === null) return quoteIdent(table);
    const resolved = await plan;
    if (!resolved.ok) {
      assert.fail(
        `the ${table} relation cannot be composed on this arm (${resolved.reason}), so no check ` +
          'below can compare the endpoint against it — reporting the endpoint correct here would ' +
          'be reporting it against a relation nothing read',
      );
    }
    return resolved.from;
  }

  await check('the funding summary budget total is the view’s own total, not a sum of GL_BALANCES', async () => {
    const res = await get('/api/funding/summary');
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const body = (await res.json()) as {
      data: {
        budget: { netAmount: number; byType: { netAmount: number }[]; source: string };
        counts: Record<string, number>;
      };
    };

    const live = await rows<{ total: number }>(
      `SELECT COALESCE(SUM("NET_AMOUNT"), 0) AS total FROM ${await reportingRelation('V_BUDGET_BY_ACCOUNT_PERIOD')}`,
    );
    const viewTotal = live[0]?.total;
    assert.equal(typeof viewTotal, 'number', 'the aggregate over the view must return one row');
    assert.ok(
      Math.abs(body.data.budget.netAmount - viewTotal!) < 0.01,
      `the summary says ${body.data.budget.netAmount}, the view sums to ${viewTotal}`,
    );

    // The type breakdown is the same view through versions → types. The equality
    // holds only while every `BUDGET_VERSION_ID` in the view resolves to a version
    // row; if this ever fails, decide whether an orphan version row or the SQL is at
    // fault before touching the check.
    const byTypeSum = body.data.budget.byType.reduce((t, b) => t + b.netAmount, 0);
    assert.ok(
      Math.abs(byTypeSum - body.data.budget.netAmount) < 0.01,
      `the type breakdown sums to ${byTypeSum} but the total is ${body.data.budget.netAmount}`,
    );
  });

  await check('the budget total is not what any of the four naive GL_BALANCES sums produce', async () => {
    const res = await get('/api/funding/summary');
    const body = (await res.json()) as { data: { budget: { netAmount: number } } };

    const naive = await rows<Record<string, number>>(
      `SELECT
         (SELECT COALESCE(SUM("PERIOD_NET_DR" - "PERIOD_NET_CR"), 0) FROM GL_BALANCES)
           AS every_row,
         (SELECT COALESCE(SUM("PERIOD_NET_DR" - "PERIOD_NET_CR"), 0) FROM GL_BALANCES
           WHERE "ACTUAL_FLAG" = 'B')
           AS budget_flag,
         (SELECT COALESCE(SUM("PERIOD_NET_DR" - "PERIOD_NET_CR"), 0) FROM GL_BALANCES
           WHERE "ACTUAL_FLAG" = 'B' AND "TRANSLATED_FLAG" = 'N')
           AS untranslated,
         (SELECT COALESCE(SUM("PERIOD_NET_DR" - "PERIOD_NET_CR"), 0) FROM GL_BALANCES
           WHERE "ACTUAL_FLAG" = 'B' AND "TRANSLATED_FLAG" = 'N' AND "ENCUMBRANCE_TYPE_ID" IS NULL)
           AS no_encumbrance_type`,
    );
    const row = naive[0];
    assert.ok(row !== undefined, 'the naive aggregate query must return exactly one row');

    for (const [name, value] of Object.entries(row)) {
      assert.ok(
        Math.abs(body.data.budget.netAmount - value) > 0.01,
        `\`${name}\` (${value}) happens to equal the summary total, so the endpoint could be skipping the ` +
          'view and this check would not notice — narrower the predicate or drop the check',
      );
    }
  });

  await check('available funds is allocations minus encumbrances minus expenditures, in total and on every row', async () => {
    const res = await get('/api/funding/summary');
    const body = (await res.json()) as {
      data: {
        position: {
          accounts: number;
          wcpssBudget: number;
          allocations: number;
          encumbrances: number;
          expenditures: number;
          availableFunds: number;
        };
      };
    };
    const p = body.data.position;

    const live = await rows<Record<string, number>>(
      `SELECT COUNT(*)                              AS accounts,
              COALESCE(SUM("WCPSS_BUDGET"), 0)      AS budget,
              COALESCE(SUM("ALLOCATIONS_REIMB"), 0) AS allocations,
              COALESCE(SUM("ENCUMBRANCES"), 0)      AS encumbrances,
              COALESCE(SUM("EXPENDITURES"), 0)      AS expenditures,
              COALESCE(SUM("AVAILABLE_FUNDS"), 0)   AS available_funds,
              SUM(CASE WHEN ABS("ALLOCATIONS_REIMB" - "ENCUMBRANCES" - "EXPENDITURES" - "AVAILABLE_FUNDS") > 0.001
                       THEN 1 ELSE 0 END)           AS identity_breaks
         FROM ${await reportingRelation('V_ACCOUNT_POSITION')}`,
    );
    const r = live[0];
    assert.ok(r !== undefined, 'the position aggregate must return exactly one row');

    // The view's own arithmetic has to hold row by row before its totals mean
    // anything — a total that balances while the rows do not is a coincidence.
    assert.equal(r.identity_breaks, 0, 'V_ACCOUNT_POSITION is internally inconsistent on at least one row');

    assert.equal(p.accounts, r.accounts);
    for (const [reported, name, direct] of [
      [p.wcpssBudget, 'wcpssBudget', r.budget],
      [p.allocations, 'allocations', r.allocations],
      [p.encumbrances, 'encumbrances', r.encumbrances],
      [p.expenditures, 'expenditures', r.expenditures],
      [p.availableFunds, 'availableFunds', r.available_funds],
    ] as [number, string, number][]) {
      assert.ok(Math.abs(reported - direct) < 0.01, `${name}: the summary says ${reported}, the view sums to ${direct}`);
    }

    assert.ok(
      Math.abs(p.availableFunds - (p.allocations - p.encumbrances - p.expenditures)) < 0.01,
      `${p.availableFunds} is not ${p.allocations} − ${p.encumbrances} − ${p.expenditures}`,
    );
  });

  await check('a journal’s subtotals are its own lines, and both line routes agree with them', async () => {
    const list = await get('/api/funding/journals?limit=1');
    assert.equal(list.status, 200);
    const page = (await list.json()) as { data: { JE_HEADER_ID: number }[]; page: { total: number } };
    assert.ok(page.page.total > 0, 'the sample must hold at least one budget journal for this check to run');
    const id = page.data[0]?.JE_HEADER_ID;
    assert.ok(typeof id === 'number', 'the journal list must return a numeric JE_HEADER_ID');

    const detail = await get(`/api/funding/journals/${id}/detail`);
    assert.equal(detail.status, 200, `expected 200, got ${detail.status}`);
    const body = (await detail.json()) as {
      data: {
        journal: { JE_HEADER_ID: number };
        lineCount: number;
        totals: { debits: number; credits: number; difference: number };
      };
    };
    assert.equal(body.data.journal.JE_HEADER_ID, id);
    assert.ok(
      Math.abs(body.data.totals.difference - (body.data.totals.debits - body.data.totals.credits)) < 0.01,
      'difference must be the subtraction it claims to be, not a separately computed number',
    );

    // Read the lines from the table, so a bug in the totals SQL cannot agree with
    // itself. `?? -1` is deliberate: a missing aggregate row must read as a
    // disagreement rather than as a matching zero.
    const live = await rows<{ n: number; dr: number; cr: number }>(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM("ENTERED_DR"), 0) AS dr,
              COALESCE(SUM("ENTERED_CR"), 0) AS cr
         FROM GL_JE_LINES WHERE "JE_HEADER_ID" = ?`,
      [id],
    );
    assert.equal(body.data.lineCount, live[0]?.n, 'the detail line count disagrees with GL_JE_LINES');
    assert.ok(Math.abs(body.data.totals.debits - (live[0]?.dr ?? -1)) < 0.01);
    assert.ok(Math.abs(body.data.totals.credits - (live[0]?.cr ?? -1)) < 0.01);

    const viaSub = await get(`/api/funding/journals/${id}/lines`);
    const viaFlat = await get(`/api/funding/journal-lines?je_header_id=${id}`);
    const a = (await viaSub.json()) as { page: { total: number } };
    const b = (await viaFlat.json()) as { page: { total: number } };
    assert.equal(a.page.total, b.page.total, 'the sub-resource and the filtered flat route disagree');
    assert.equal(a.page.total, body.data.lineCount, 'the line routes and the journal detail disagree');
  });

  await check('the derived funding and accounts resources expose no detail route and no writes', async () => {
    const spec = (await (await get('/api/docs.json')).json()) as Spec;
    const routed = new Set(registeredRoutes());

    // Every one of these is keyed by a composite, or is an aggregate with no key at
    // all, so there is no single value a `/{id}` could carry. The absence is a
    // decision and is asserted rather than assumed.
    const listOnly = [
      '/api/funding/budget-assignments',
      '/api/funding/journal-lines',
      '/api/funding/project-budget-lines',
      '/api/funding/budgets',
      '/api/funding/positions',
      '/api/coa/periods',
      '/api/coa/flex-segments',
      '/api/coa/flex-values',
      '/api/coa/flex-value-translations',
      '/api/coa/balances',
      '/api/coa/lookups',
    ];
    for (const base of listOnly) {
      assert.ok(spec.paths[base]?.get, `${base} should exist`);
      assert.equal(spec.paths[`${base}/{id}`], undefined, `${base} has no primary key and must not expose /{id}`);
      assert.equal(spec.paths[base]?.post, undefined, `${base} must not offer a create`);
      assert.equal(routed.has(`POST ${base}`), false, `${base} documents no create but the router has one`);
    }

    // The complement, so this is not a check that passes because nothing is mounted:
    // the resources that *do* have a key must still expose their detail route. Note
    // that `/api/coa/legend` is in this group — `V_SEGMENT_LEGEND` groups by
    // `SEGMENT5`, so a level code identifies exactly one row.
    for (const path of ['/api/coa/legend/{id}', '/api/funding/journals/{id}', '/api/coa/combinations/{id}']) {
      assert.ok(spec.paths[path]?.get, `${path} should exist — this resource does have a key`);
      assert.ok(routed.has(`GET ${path}`), `${path} is documented but not routed`);
    }
  });

  // ---- Chart of Accounts --------------------------------------------------
  //
  // Two things here are worth more than the rest: `valuesUsedInAccounts` counts
  // distinct values in `GL_CODE_COMBINATIONS` rather than in the legend, so the gap
  // between them is "codes in use and unnamed"; and `V_SEGMENT_LEGEND` joins the
  // legend on the wrong value set, so it reports that gap as zero. Both are asserted
  // against the tables, not against a remembered number.

  await check('the segment definition names the same seven columns the accounts use', async () => {
    const res = await get('/api/coa/segments');
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const body = (await res.json()) as {
      data: {
        structure: { ID_FLEX_STRUCTURE_CODE: string } | null;
        segments: {
          SEGMENT_NUM: number;
          SEGMENT_NAME: string;
          APPLICATION_COLUMN: string;
          legendValues: number;
          namedValues: number;
          valuesUsedInAccounts: number;
        }[];
      };
    };

    assert.equal(body.data.segments.length, 7, 'the key flexfield has seven segments');
    assert.deepEqual(
      body.data.segments.map((s) => s.SEGMENT_NUM),
      [1, 2, 3, 4, 5, 6, 7],
    );
    assert.deepEqual(
      body.data.segments.map((s) => s.APPLICATION_COLUMN),
      ['SEGMENT1', 'SEGMENT2', 'SEGMENT3', 'SEGMENT4', 'SEGMENT5', 'SEGMENT6', 'SEGMENT7'],
    );

    // Each count against the table it claims to come from, so a copy-paste slip
    // between the seven subqueries cannot survive: `used2` and `used3` are one
    // character apart and both would be plausible numbers.
    const live = await rows<Record<string, number>>(
      `SELECT ${Array.from({ length: 7 }, (_, i) => `COUNT(DISTINCT "SEGMENT${i + 1}") AS used${i + 1}`).join(', ')}
         FROM GL_CODE_COMBINATIONS`,
    );
    for (const s of body.data.segments) {
      assert.equal(
        s.valuesUsedInAccounts,
        live[0]?.[`used${s.SEGMENT_NUM}`],
        `segment ${s.SEGMENT_NUM} (${s.APPLICATION_COLUMN}) value count disagrees with GL_CODE_COMBINATIONS`,
      );
    }
  });

  await check('codes in use outnumber codes the legend names, and the API reports the gap', async () => {
    const res = await get('/api/coa/segments');
    const body = (await res.json()) as {
      data: {
        segments: { SEGMENT_NUM: number; legendValues: number; namedValues: number; valuesUsedInAccounts: number }[];
      };
    };
    const level = body.data.segments.find((s) => s.SEGMENT_NUM === 5);
    assert.ok(level, 'segment 5 must exist');

    const live = await rows<{ n: number }>(
      `SELECT COUNT(DISTINCT "SEGMENT5") AS n FROM GL_CODE_COMBINATIONS
         WHERE "SEGMENT5" IS NOT NULL AND "SEGMENT5" <> ''`,
    );
    assert.equal(level.valuesUsedInAccounts, live[0]?.n, 'the level segment count disagrees with the table');

    assert.ok(
      level.valuesUsedInAccounts > level.legendValues,
      `level codes in use (${level.valuesUsedInAccounts}) do not exceed the codes the legend holds ` +
        `(${level.legendValues}); if they are equal, the "in use but unnamed" state does not occur in this data ` +
        'and this check should be replaced rather than left passing for the wrong reason',
    );
    assert.equal(
      level.valuesUsedInAccounts - level.legendValues,
      level.valuesUsedInAccounts - level.namedValues,
      'namedValues can never exceed legendValues, so the two gaps should agree — the counts are inconsistent',
    );
  });

  await check('GET /api/coa/legend and GET /api/coa/levels agree on the level codes and their names', async () => {
    const res = await get('/api/coa/legend?limit=500');
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      data: { LEVEL_CODE: string; LEVEL_NAME: string | null; ACCOUNT_COUNT: number }[];
      page: { total: number };
    };
    assert.ok(body.page.total > 0, 'the view must return rows for this comparison to mean anything');

    const fixed = await get('/api/coa/levels');
    assert.equal(fixed.status, 200, `expected 200 from /api/coa/levels, got ${fixed.status}`);
    const fbody = (await fixed.json()) as {
      data: {
        valueSetId: number | null;
        codes: number;
        namedCount: number;
        unnamedCount: number;
        levels: { LEVEL_CODE: string; LEVEL_NAME: string | null }[];
      };
    };

    assert.equal(fbody.data.namedCount + fbody.data.unnamedCount, fbody.data.codes, 'the counts must partition the codes');
    assert.equal(fbody.data.codes, body.page.total, 'the two endpoints should agree about how many level codes exist');

    // ★ THE VALUE SET IS ASSERTED BY NAME, AND THIS CHECK USED TO RESOLVE IT THE
    //   ENDPOINT'S OWN WRONG WAY. It ran `ORDER BY "ID_FLEX_NUM" ASC LIMIT 1` with no
    //   `ID_FLEX_CODE` predicate — the endpoint's bug, copied into the assertion — so
    //   it ratified whatever the endpoint picked rather than checking the pin. Measured
    //   on the live ledger, **91** rows declare `SEGMENT5` across several flexfields
    //   (`PEA`, `SCL`, `BANK`, …), so an unpinned lookup returns the `PEA`/`FACULTY`
    //   value set **1009904** instead of the GL chart of accounts' **1002649**: every
    //   name then comes back null while `codes` and the two counts stay internally
    //   consistent, which is exactly the shape that reads as a data fact.
    assert.ok(
      fbody.data.valueSetId !== null,
      'the endpoint resolved no value set, so every name is null for want of a legend rather than for want of a name',
    );
    assert.ok(
      fbody.data.namedCount > 0,
      `the legend join named no level code (valueSetId ${fbody.data.valueSetId}); a null or mis-pinned value ` +
        'set produces exactly this, so the check cannot otherwise show that names resolve',
    );

    // ★ LIKE WITH LIKE. `body` is a **page** of 500 rows out of `page.total`, so a
    //   `viewNames < namedCount` comparison measures the page limit, not the view: on a
    //   1,308-row view with 500 fetched it passes while every name resolves, which is
    //   how this check stayed green after `db/derived.ts` repaired the view body. Read
    //   the whole population and compare the two endpoints on it.
    const whole = await get(`/api/coa/legend?limit=${body.page.total}`);
    assert.equal(whole.status, 200);
    const wbody = (await whole.json()) as { data: { LEVEL_NAME: string | null }[] };
    assert.equal(
      wbody.data.length,
      body.page.total,
      'the page must span the whole view, or the comparison below is about paging rather than about names',
    );
    const viewNames = wbody.data.filter((r) => r.LEVEL_NAME !== null).length;
    assert.equal(
      viewNames,
      fbody.data.namedCount,
      `V_SEGMENT_LEGEND named ${viewNames} of ${body.page.total} level codes and /api/coa/levels named ` +
        `${fbody.data.namedCount} of ${fbody.data.codes}. Both now read the corrected grouping in ` +
        '`db/derived.ts`, so a difference means one of them has stopped reading it — the disagreement this ' +
        'check used to *require* is the defect, not the finding',
    );

    // Named codes first, so the short list is the one a caller sees without paging.
    if (fbody.data.levels.length > 1) {
      const lastNamed = fbody.data.levels.filter((l) => l.LEVEL_NAME !== null).length;
      assert.ok(
        fbody.data.levels.slice(0, lastNamed).every((l) => l.LEVEL_NAME !== null),
        'named level codes should be returned before unnamed ones',
      );
    }
  });

  await check('a combination key built from the account list resolves to the same row', async () => {
    const list = await get('/api/coa/combinations?limit=1');
    assert.equal(list.status, 200);
    const page = (await list.json()) as { data: Record<string, unknown>[]; page: { total: number } };
    assert.ok(page.page.total > 0, 'the sample must hold account combinations for this check to run');
    const row = page.data[0];
    assert.ok(row !== undefined);

    const key = ['SEGMENT1', 'SEGMENT2', 'SEGMENT3', 'SEGMENT4', 'SEGMENT5', 'SEGMENT6', 'SEGMENT7']
      .map((c) => String(row[c]))
      .join('.');

    const res = await get(`/api/coa/combination-key/${key}`);
    assert.equal(res.status, 200, `expected 200 for a key taken from the resource itself, got ${res.status}`);
    const body = (await res.json()) as {
      data: {
        combination: Record<string, unknown>;
        key: string;
        keyMatchCount: number;
        position: {
          ALLOCATIONS_REIMB: number;
          ENCUMBRANCES: number;
          EXPENDITURES: number;
          AVAILABLE_FUNDS: number;
        } | null;
      };
    };
    assert.equal(body.data.key, key);
    assert.equal(
      body.data.combination.CODE_COMBINATION_ID,
      row.CODE_COMBINATION_ID,
      'the key resolved to a different row than the one it was built from',
    );
    assert.equal(
      body.data.keyMatchCount,
      1,
      'the sample has no duplicate combination keys, so more than one here is a data fault worth investigating',
    );

    // Null and zero are different answers — "not in the position view at all" is not
    // "in it, with nothing" — so the identity is only asserted when a row came back.
    if (body.data.position) {
      const p = body.data.position;
      assert.ok(
        Math.abs(p.AVAILABLE_FUNDS - (p.ALLOCATIONS_REIMB - p.ENCUMBRANCES - p.EXPENDITURES)) < 0.01,
        'the per-account position must satisfy the same identity as the totals',
      );
    }
  });

  await check('a combination key that matches nothing is a 404, not an empty row', async () => {
    // The path is proven mounted by the spec/router comparison and by the successful
    // lookup above, which is the only way to tell this 404 from an unrouted path.
    const res = await get('/api/coa/combination-key/9999.9999.9999.9999.9999.9999.9999');
    assert.equal(res.status, 404, `expected 404, got ${res.status}`);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'NOT_FOUND');
  });

  await check('a segment filter narrows the account list to exactly that segment value', async () => {
    const first = await get('/api/coa/combinations?limit=1');
    const seed = (await first.json()) as { data: { SEGMENT5: string }[] };
    const level = seed.data[0]?.SEGMENT5;
    assert.ok(typeof level === 'string', 'the account list must return a SEGMENT5 string');

    const res = await get(`/api/coa/combinations?level=${encodeURIComponent(level)}&limit=200`);
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const body = (await res.json()) as { data: { SEGMENT5: string }[]; page: { total: number } };

    const live = await rows<{ n: number }>(
      `SELECT COUNT(*) AS n FROM GL_CODE_COMBINATIONS WHERE "SEGMENT5" = ?`,
      [level],
    );
    assert.equal(body.page.total, live[0]?.n, `the filtered total for level ${level} disagrees with the table`);
    assert.ok(body.data.length > 0, 'a filter built from a real row returned nothing');
    assert.ok(
      body.data.every((r) => r.SEGMENT5 === level),
      'a page returned for one level contained a row from another',
    );
  });

  await check('periods come back newest first by fiscal year and number, which is not the name order', async () => {
    const res = await get('/api/coa/periods?limit=500');
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      data: { PERIOD_NAME: string; PERIOD_YEAR: number; PERIOD_NUM: number }[];
      page: { total: number };
    };
    assert.ok(body.data.length > 1, 'the calendar must hold more than one period');

    for (let i = 1; i < body.data.length; i += 1) {
      const a = body.data[i - 1]!;
      const b = body.data[i]!;
      assert.ok(
        a.PERIOD_YEAR > b.PERIOD_YEAR || (a.PERIOD_YEAR === b.PERIOD_YEAR && a.PERIOD_NUM >= b.PERIOD_NUM),
        `row ${i} breaks the (PERIOD_YEAR, PERIOD_NUM) descending order: ${JSON.stringify(a)} then ${JSON.stringify(b)}`,
      );
    }

    // The reason `PERIOD_YEAR` and `PERIOD_NUM` exist at all: the period names are
    // not in date order, so the newest period is not the greatest name. If those two
    // ever coincide this check has stopped testing anything.
    const newest = body.data[0]!.PERIOD_NAME;
    const greatestName = [...body.data.map((r) => r.PERIOD_NAME)].sort().reverse()[0];
    assert.notEqual(
      greatestName,
      newest,
      `the newest period (${newest}) is also the greatest period name, so ordering by name would look correct ` +
        'here — replace this check with one that still separates the two orderings',
    );
  });

  // ---- Projects -----------------------------------------------------------
  //
  // This domain's whole claim is that the database holds **no** project
  // dimension. That claim is only worth anything if it is measured, so the
  // checks below read the tables directly rather than trusting the endpoints,
  // and the check that asserts the emptiness also asserts that the report's own
  // facts are *populated* — otherwise it would pass because everything is empty.

  /** A `COUNT(*)` read back as a real number, with the "no row" case rejected. */
  const countOf = async (sql: string): Promise<number> => {
    const r = await rows<{ n: number }>(sql);
    assert.ok(r[0], `a COUNT(*) query returned no row at all: ${sql}`);
    const n = r[0].n;
    assert.ok(Number.isFinite(n), `a COUNT(*) query returned a non-number: ${JSON.stringify(r[0])}`);
    return n;
  };

  interface ProjectFactRow {
    FACT_NAME: string;
    FACT_VALUE: string | null;
    UNIT: string | null;
    NOTE: string | null;
  }

  interface ProjectSummaryBody {
    storage: {
      projectMaster: number;
      tasks: number;
      budgetVersions: number;
      budgetLines: number;
      poHeaders: number;
      poHeadersWithProjectName: number;
      distinctProjectNames: number;
    };
    report: {
      facts: number;
      factsByUnit: { unit: string | null; facts: number }[];
      fundingLines: number;
      fundingInTotal: number;
      fundingForecast: number;
      fundingEveryLine: number;
      fundingFirstYear: number | null;
      fundingLastYear: number | null;
    };
    identities: {
      name: string;
      expression: string;
      computed: number | null;
      stated: number | null;
      holds: boolean;
      unit: string | null;
    }[];
    source: string;
    note: string;
  }

  await check('every Projects resource is mounted, routed, and documented', async () => {
    const spec = (await (await get('/api/docs.json')).json()) as Spec;
    const routed = new Set(registeredRoutes());
    const targets = registeredResources().filter((r) => r.tags.includes('Projects'));
    assert.equal(
      targets.length,
      4,
      `expected 4 Projects resources, found ${targets.length}: ${targets.map((t) => t.name).join(', ')}`,
    );
    for (const r of targets) {
      assert.ok(spec.paths[r.basePath]?.get, `${r.basePath} is registered but absent from the spec`);
      assert.ok(routed.has(`GET ${r.basePath}`), `${r.basePath} is documented but not routed`);
      const shape = (r.row as unknown as { shape?: Record<string, unknown> }).shape;
      assert.ok(
        shape !== undefined && Object.keys(shape).length > 0,
        `${r.name} declares a row schema with no fields — nothing would be returned`,
      );
    }
  });

  // ---- The project registry ----------------------------------------------
  //
  // ★ THIS IS A DIFFERENT QUESTION FROM `/api/projects/summary`, AND THE TWO ARE
  //   DELIBERATELY NOT MERGED. `summary` asks the *database* what it holds and
  //   answers "no project dimension" — four empty `PA_*` tables and a NULL
  //   `PROJECT_ID` on every PO line. This asks what the *application* has been
  //   told, and answers with rows out of the app-owned `project` table. The two
  //   answers disagreeing is the correct state of the world, not a bug, so the
  //   "two zeros" assertion below and this one must both keep passing.
  interface RegistryRowBody {
    slug: string;
    name: string;
    description: string | null;
    levelCode: string | null;
    code: string | null;
    site: string | null;
    owner: string | null;
    createdAt: string | null;
    updatedAt: string | null;
  }

  await check('the project registry returns the app’s own rows, and its counts are its own arithmetic', async () => {
    const res = await get('/api/projects/registry');
    assert.equal(res.status, 200, `expected 200, got ${res.status} — the app schema must have applied`);
    const { data } = (await res.json()) as {
      data: { items: RegistryRowBody[]; counts: { total: number; associated: number; unassociated: number } };
    };

    assert.ok(Array.isArray(data.items), 'items must be an array');
    assert.ok(
      data.items.length > 0,
      'the registry is empty — 01-app.sql seeds twelve rows, so this means the seed did not run',
    );

    // The counts are asserted against the array rather than against remembered
    // numbers, so adding a project does not mean editing this check. Only adding
    // one without a level code would move a number, and that is the point.
    const associated = data.items.filter((r) => (r.levelCode ?? '').trim() !== '').length;
    assert.equal(data.counts.total, data.items.length, 'counts.total is not the number of items returned');
    assert.equal(
      data.counts.associated,
      associated,
      'counts.associated is not the number of rows carrying a level code',
    );
    assert.equal(
      data.counts.unassociated,
      data.items.length - associated,
      'counts.unassociated is not total minus associated',
    );

    // A level code is either a 4-digit account level or absent. A blank string
    // would be stored, counted as unassociated (the filter trims), and then read
    // back by `derive.ts` as a name — so the shape is worth pinning.
    for (const r of data.items) {
      assert.ok(r.slug && r.slug.trim() !== '', `a registry row has no slug: ${JSON.stringify(r)}`);
      assert.ok(r.name && r.name.trim() !== '', `row "${r.slug}" has no name`);
      if (r.levelCode !== null) {
        assert.match(
          r.levelCode,
          /^[0-9]{4}$/,
          `row "${r.slug}" carries level_code "${r.levelCode}", which is not a 4-digit level`,
        );
      }
    }

    // `slug` is the natural key the seed's `INSERT OR IGNORE` leans on, so a
    // duplicate would mean the idempotency claim is false rather than untested.
    const slugs = data.items.map((r) => r.slug);
    assert.equal(new Set(slugs).size, slugs.length, `duplicate slugs: ${slugs.join(', ')}`);

    // The two projects added by hand, asserted by name because the name is the
    // requirement. They are expected to have no level code yet: the levels are
    // associated later, and "a project nobody has placed" is the third state the
    // response is shaped to carry. When a level is assigned this assertion should
    // be changed to assert the level, not deleted.
    for (const name of ['Buffalo Bills Stadium', 'Lenovo Center Improvements']) {
      const row = data.items.find((r) => r.name === name);
      assert.ok(row, `"${name}" is missing from the registry, so a supplied project has been lost`);
      assert.equal(
        row?.levelCode,
        null,
        `"${name}" now has level_code ${row?.levelCode} — a level was associated, which is fine, but this check ` +
          'still asserts the unassociated state and should be updated to assert the level instead',
      );
    }
  });

  // ---- Writing to the project registry ------------------------------------
  //
  // ★ THESE THREE CHECKS WRITE, AND THEY PUT BACK WHAT THEY TAKE. Everything else
  //   in this suite reads the sample. A test that leaves a row behind would make
  //   the *next* run fail at the create — a 409 on a key the previous run made —
  //   and the failure would point at the wrong line. So each slug is deleted
  //   before the create as well as after it: the pre-delete is what makes a run
  //   after a crashed run still work.
  //
  // ★ AND THEY ASSERT THE REFUSALS, NOT ONLY THE SUCCESSES. The rules that make
  //   this table meaningful — one project per level, a level that must exist in
  //   the ledger, a code that cannot outlive its level — live in the handler and
  //   nowhere else. A suite that only proved the happy path would pass with every
  //   one of them deleted.
  const NAME_A = 'Smoke Check Project A (temporary)';
  const SLUG_A = 'smoke-check-project-a-temporary';
  const NAME_B = 'Smoke Check Project B (temporary)';
  const SLUG_B = 'smoke-check-project-b-temporary';

  const clearTemporary = async (): Promise<void> => {
    await execute('DELETE FROM project WHERE slug = :slug', { slug: SLUG_A });
    await execute('DELETE FROM project WHERE slug = :slug', { slug: SLUG_B });
  };

  /**
   * ★ A LEDGER READ THIS TARGET MAY NOT SERVE, AND WHY THAT IS A SKIP RATHER THAN
   *   A FAILURE.
   *
   * Both checks below need a *real* level code — four digits `SEGMENT5` actually
   * carries — because binding a made-up one is refused 409 by design, so an
   * invented code cannot stand in for it. The only honest source is
   * `GET /api/coa/levels`, which asks the ledger.
   *
   * On the live configuration that endpoint answers **500**, for a reason that has
   * nothing to do with the project registry: its SQL is hand-written, so it names
   * two columns the way *this app's SQLite sample* names them —
   * `"APPLICATION_COLUMN"` on `FND_ID_FLEX_SEGMENTS` (the live object calls it
   * `APPLICATION_COLUMN_NAME`) and `"DESCRIPTION"` on `FND_FLEX_VALUES` (it lives
   * on `FND_FLEX_VALUES_TL`). `db/ledger-shape.ts` declares both divergences, but a
   * route that builds its own statement bypasses that seam and gets `ORA-00904`.
   * The same gap fails `GET /api/coa/segments`, and the checks that own those two
   * endpoints still report it — this guard does not hide the defect, it stops it
   * being reported against the wrong table.
   *
   * ★ THE SKIP IS TAKEN ON ORACLE ONLY, AND IT IS PRINTED. On any other target a
   *   non-200 here still fails, because there it would be a regression rather than
   *   a known gap in the live chart of accounts. An unprinted skip and a pass are
   *   indistinguishable, so the reason goes to the console.
   */
  type LedgerLevel = { LEVEL_CODE: string; ACCOUNT_COUNT: number; LEVEL_NAME: string | null };

  const ledgerLevels = async (): Promise<LedgerLevel[] | null> => {
    const res = await get('/api/coa/levels');
    if (res.status === 200) {
      return ((await res.json()) as { data: { levels: LedgerLevel[] } }).data.levels;
    }
    if (dbStatus().mode === 'oracle') {
      // ★ `process.stdout.write`, NOT `console.log` — `label` has already written
      //   `"<name> … "` and `ok` is written when this returns, so the reason has to
      //   be written *without* a trailing newline to share that line. `console.log`
      //   appends one unconditionally and orphans the `ok`.
      process.stdout.write(
        ` (skipped: /api/coa/levels answers ${res.status} — a chart-of-accounts gap on this target, not a registry one) `,
      );
      return null;
    }
    assert.equal(res.status, 200, `GET /api/coa/levels returned ${res.status}`);
    return null;
  };

  await check('POST /api/projects records a project with no cost centre, and refuses what it must', async () => {
    await clearTemporary();

    // The create. `owner` is what the client sends from the session; nothing on
    // this endpoint requires a level, which is the whole point of the change.
    const res = await post('/api/projects', {
      name: NAME_A,
      description: 'Recorded by `npm run smoke`. Safe to delete.',
      owner: 'Smoke Test',
    });
    assert.equal(res.status, 201, `expected 201, got ${res.status}`);
    const { data } = (await res.json()) as { data: RegistryRowBody };

    // The slug is derived, never sent — asserted because every later request in
    // this suite addresses the row by it, and because a client that started
    // sending one would otherwise go unnoticed.
    assert.equal(data.slug, SLUG_A, 'the slug is no longer derived from the name');
    assert.equal(data.name, NAME_A);
    assert.equal(data.owner, 'Smoke Test');
    assert.equal(data.description, 'Recorded by `npm run smoke`. Safe to delete.');
    assert.equal(data.levelCode, null, 'a project created without a cost centre came back with a level');
    assert.equal(data.code, null, 'a project with no level came back with a derived code');
    assert.ok(data.createdAt, 'createdAt is empty — the row was echoed rather than read back');

    // Read back through the list, which is the view the user compares against.
    const listRes = await get('/api/projects/registry');
    const list = (await listRes.json()) as { data: { items: RegistryRowBody[] } };
    const listed = list.data.items.find((r) => r.slug === SLUG_A);
    assert.ok(listed, 'the project was created but does not appear in the registry');

    // A second project cannot take the same key. The message is asserted because
    // it is the only thing the user sees, and it has to name the key that clashed.
    const dup = await post('/api/projects', { name: NAME_A });
    assert.equal(dup.status, 409, `expected 409 for a duplicate name, got ${dup.status}`);
    const dupBody = (await dup.json()) as { error: { message: string; details?: { slug?: string } } };
    assert.ok(
      dupBody.error.message.includes('already exists'),
      `the duplicate refusal does not say a project already exists: ${dupBody.error.message}`,
    );
    assert.equal(dupBody.error.details?.slug, SLUG_A, 'the duplicate refusal does not name the existing key');

    // No name is a bad request, not a constraint violation — the column is NOT
    // NULL, so without the schema check this would be a 500 or a 400 depending on
    // which layer caught it first.
    const nameless = await post('/api/projects', { description: 'no name' });
    assert.equal(nameless.status, 400, `expected 400 for a missing name, got ${nameless.status}`);
  });

  await check('PATCH /api/projects/{slug} binds and releases a level, and holds every line', async () => {
    // ★ A FREE LEVEL IS FOUND, NOT HARD-CODED. The seed already holds ten levels,
    //   and which ten is a seeded fact the next window may change. Deriving the
    //   free one from the two endpoints the app itself uses keeps this check
    //   honest without pinning a level nobody promised.
    const levels = await ledgerLevels();
    if (levels === null) return;

    await clearTemporary();

    for (const [name, slug] of [
      [NAME_A, SLUG_A],
      [NAME_B, SLUG_B],
    ] as const) {
      const res = await post('/api/projects', { name, owner: 'Smoke Test' });
      assert.equal(res.status, 201, `setup: creating "${name}" returned ${res.status}`);
      assert.equal(((await res.json()) as { data: RegistryRowBody }).data.slug, slug);
    }

    const heldRes = await get('/api/projects/registry');
    const held = new Set(
      ((await heldRes.json()) as { data: { items: RegistryRowBody[] } }).data.items
        .map((r) => (r.levelCode ?? '').trim())
        .filter((l) => l !== ''),
    );

    const free = levels.find((l) => !held.has(l.LEVEL_CODE));
    assert.ok(
      free,
      `every one of the ${levels.length} ledger levels is held by a project — that is not the seeded state, ` +
        'and this check cannot run without a free level',
    );

    // The bind.
    const bind = await patch(`/api/projects/${SLUG_B}`, {
      levelCode: free.LEVEL_CODE,
      code: `CC-${free.LEVEL_CODE}-527`,
    });
    assert.equal(bind.status, 200, `expected 200 binding level ${free.LEVEL_CODE}, got ${bind.status}`);
    const bound = ((await bind.json()) as { data: RegistryRowBody }).data;
    assert.equal(bound.levelCode, free.LEVEL_CODE, 'the level was not stored');
    assert.ok(bound.code, 'binding a level did not produce a code');

    // One level funds one project. The second attempt is refused, and the refusal
    // names the holder — which is the row the reader has to go and release.
    const clash = await patch(`/api/projects/${SLUG_A}`, { levelCode: free.LEVEL_CODE });
    assert.equal(clash.status, 409, `expected 409 for a level already held, got ${clash.status}`);
    const clashBody = (await clash.json()) as { error: { message: string; details?: { heldBy?: string } } };
    assert.equal(clashBody.error.details?.heldBy, SLUG_B, 'the clash does not name the project holding the level');

    // A level that no account combination carries would bind a project to money
    // that cannot exist, so it is refused rather than stored and never matched.
    const ghost = await patch(`/api/projects/${SLUG_A}`, { levelCode: '9999' });
    assert.equal(ghost.status, 409, `expected 409 for a level not in the ledger, got ${ghost.status}`);

    // A code without a level on a project that holds none: the code could only
    // point at nothing, so this is a bad request rather than a silent no-op.
    const orphan = await patch(`/api/projects/${SLUG_A}`, { code: 'CC-9999-527' });
    assert.equal(orphan.status, 400, `expected 400 for a code with no level, got ${orphan.status}`);

    // The release. The row stays and both derived fields go back to null — a
    // release is the inverse of a bind, not a delete.
    const release = await patch(`/api/projects/${SLUG_B}`, { levelCode: null });
    assert.equal(release.status, 200, `expected 200 releasing, got ${release.status}`);
    const released = ((await release.json()) as { data: RegistryRowBody }).data;
    assert.equal(released.levelCode, null, 'the level was not cleared');
    assert.equal(released.code, null, 'the code survived the release of the level it was derived from');

    // Put the table back the way it was found.
    await clearTemporary();
    const after = (await (await get('/api/projects/registry')).json()) as { data: { items: RegistryRowBody[] } };
    assert.equal(
      after.data.items.some((r) => r.slug === SLUG_A || r.slug === SLUG_B),
      false,
      'the temporary rows could not be removed, so this suite is no longer idempotent',
    );
  });

  await check('DELETE /api/projects/{slug} removes the row, frees the level, and refuses a second ask', async () => {
    // A free level, derived rather than written in — the same way the PATCH check
    // finds one, and for the same reason: which levels the seed holds is a seeded
    // fact rather than a promise.
    const levels = await ledgerLevels();
    if (levels === null) return;

    await clearTemporary();

    const heldRes = await get('/api/projects/registry');
    const held = new Set(
      ((await heldRes.json()) as { data: { items: RegistryRowBody[] } }).data.items
        .map((r) => (r.levelCode ?? '').trim())
        .filter((l) => l !== ''),
    );

    const level = levels.find((l) => !held.has(l.LEVEL_CODE));
    assert.ok(level, `all ${levels.length} ledger levels are held by a project, so this check cannot run`);

    // ★ TWO ROWS, NOT ONE. B holds the level and is the row that gets deleted; A
    //   is created empty and only used afterwards. It has to exist up front, and
    //   the first run of this check proved why: "the level is free again" can only
    //   be shown by *another project taking it*, so without a second row to do the
    //   taking the assertion rebinds to a slug that was never created and reports
    //   404 — a fixture fault that reads exactly like a failure of the delete.
    for (const [name, slug] of [
      [NAME_A, SLUG_A],
      [NAME_B, SLUG_B],
    ] as const) {
      const createRes = await post('/api/projects', { name, owner: 'Smoke Test' });
      assert.equal(createRes.status, 201, `setup: creating "${name}" returned ${createRes.status}`);
      assert.equal(((await createRes.json()) as { data: RegistryRowBody }).data.slug, slug);
    }

    // B is the project that holds a level, so the delete has a claim to release.
    const bind = await patch(`/api/projects/${SLUG_B}`, { levelCode: level.LEVEL_CODE });
    assert.equal(bind.status, 200, `setup: binding level ${level.LEVEL_CODE} returned ${bind.status}`);

    const res = await del(`/api/projects/${SLUG_B}`);
    assert.equal(res.status, 204, `expected 204 from a delete, got ${res.status}`);

    // ★ 204 MEANS NO BODY, AND THE CLIENT IS WRITTEN AGAINST THAT. `deleteProject`
    //   in the app checks `res.ok` and parses nothing, because `res.json()` on a
    //   204 rejects — *after* a successful delete, so the row would be gone and
    //   the screen would report a failure. This assertion is what keeps the two
    //   halves agreeing: a body here is not a harmless extra, it is exactly the
    //   shape the client is told not to expect.
    const body = await res.text();
    assert.equal(
      body,
      '',
      `the delete answered 204 with a body (${JSON.stringify(body.slice(0, 60))}) — a 204 has none`,
    );

    // Gone from the view the user compares against.
    const listRes = await get('/api/projects/registry');
    const list = (await listRes.json()) as { data: { items: RegistryRowBody[] } };
    assert.equal(
      list.data.items.some((r) => r.slug === SLUG_B),
      false,
      'the project was deleted but is still listed in the registry',
    );

    // ★ THE LEVEL IS FREE AGAIN, AND THAT IS THE WHOLE OF WHAT A DELETE DOES HERE.
    //   The row's claim is gone, so another project can take the level exactly as
    //   it could before the row existed. This is the assertion that fails against
    //   the plausible wrong implementation — one that removes the row but leaves
    //   the level spoken for, which would make the level unclaimable by anybody and
    //   invisible to the reader.
    const rebind = await patch(`/api/projects/${SLUG_A}`, { levelCode: level.LEVEL_CODE });
    assert.equal(
      rebind.status,
      200,
      `level ${level.LEVEL_CODE} was not freed by the delete — binding it to another project ` +
        `answered ${rebind.status}, not 200`,
    );

    // ★ AND THE LEDGER DID NOT MOVE. `/api/coa/levels` is read live from Oracle,
    //   so the level's own entry — how many account combinations carry it, and
    //   its name — has to be identical after the delete. The delete removed a name
    //   this app put on the level; it did not remove one row of what the level
    //   owns, and this is the line that says so rather than asserting it in prose.
    const afterRes = await get('/api/coa/levels');
    assert.equal(
      afterRes.status,
      200,
      `the level re-read answered ${afterRes.status}; the delete must not be what broke it`,
    );
    const after = (await afterRes.json()) as { data: { levels: LedgerLevel[] } };
    assert.deepEqual(
      after.data.levels.find((l) => l.LEVEL_CODE === level.LEVEL_CODE),
      level,
      'the level changed across a project delete — a delete must not touch Oracle',
    );

    // A second ask. 404 rather than a cheerful 204: reporting success for a row
    // that is already gone tells the reader their action worked when nothing
    // happened, and a stale page — two tabs on the same project — is exactly when
    // that would be believed.
    const again = await del(`/api/projects/${SLUG_B}`);
    assert.equal(again.status, 404, `expected 404 deleting an already-deleted project, got ${again.status}`);
    const againBody = (await again.json()) as { error: { message: string } };
    assert.ok(
      againBody.error.message.includes(SLUG_B),
      `the refusal does not name the key it could not find: ${againBody.error.message}`,
    );

    // ★ A CONTROL, WITHOUT WHICH THE LINE ABOVE PROVES NOTHING. A key that never
    //   existed must be refused the same way; otherwise "404 on the second delete"
    //   would also be satisfied by a handler that 404s on everything. The 204
    //   earlier rules that out, and this line rules out the milder version — a
    //   route that can only ever answer 404 and has never deleted anything.
    const never = await del('/api/projects/smoke-check-never-created');
    assert.equal(never.status, 404, `expected 404 for a key that never existed, got ${never.status}`);

    // Put the table back the way it was found.
    await clearTemporary();
    const clean = (await (await get('/api/projects/registry')).json()) as {
      data: { items: RegistryRowBody[] };
    };
    assert.equal(
      clean.data.items.some((r) => r.slug === SLUG_A || r.slug === SLUG_B),
      false,
      'the temporary rows could not be removed, so this suite is no longer idempotent',
    );
  });

  await check('the project summary’s counts are the tables’ own, including the two zeros', async () => {
    const res = await get('/api/projects/summary');
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
    const { data } = (await res.json()) as { data: ProjectSummaryBody };

    const pairs: [string, number, number][] = [
      ['projectMaster', data.storage.projectMaster, await countOf('SELECT COUNT(*) AS n FROM "PA_PROJECTS_ALL"')],
      ['tasks', data.storage.tasks, await countOf('SELECT COUNT(*) AS n FROM "PA_TASKS"')],
      ['budgetVersions', data.storage.budgetVersions, await countOf('SELECT COUNT(*) AS n FROM "PA_BUDGET_VERSIONS"')],
      ['budgetLines', data.storage.budgetLines, await countOf('SELECT COUNT(*) AS n FROM "PA_BUDGET_LINES"')],
      ['poHeaders', data.storage.poHeaders, await countOf('SELECT COUNT(*) AS n FROM "PO_HEADERS_ALL"')],
      [
        'poHeadersWithProjectName',
        data.storage.poHeadersWithProjectName,
        await countOf(
          `SELECT COUNT(*) AS n FROM "PO_HEADERS_ALL" WHERE TRIM(IFNULL("EXP_PROJECT_NAME", '')) <> ''`,
        ),
      ],
      ['report.facts', data.report.facts, await countOf('SELECT COUNT(*) AS n FROM "X_REPORT_PROJECT_FACTS"')],
      [
        'report.fundingLines',
        data.report.fundingLines,
        await countOf('SELECT COUNT(*) AS n FROM "X_REPORT_FUNDING_LINES"'),
      ],
    ];
    for (const [name, reported, direct] of pairs) {
      assert.equal(reported, direct, `the summary reports ${name} = ${reported}, the tables hold ${direct}`);
    }

    // The two zeros are the endpoint's reason to exist: the project dimension is
    // *absent*, not merely unfetched. If either stops being zero then a project
    // source has been confirmed — revisit this module's premise and this check,
    // rather than relaxing the assertion.
    assert.equal(
      data.storage.poHeadersWithProjectName,
      0,
      'a purchase-order header now carries a project name, so the "no project dimension" premise is out of date',
    );
    assert.equal(
      data.storage.distinctProjectNames,
      0,
      'project names now exist on the PO headers, so the "no project dimension" premise is out of date',
    );

    // The unit breakdown must account for every fact, or a fact has been dropped
    // from the response rather than from the table.
    const byUnit = data.report.factsByUnit.reduce((t, u) => t + u.facts, 0);
    assert.equal(byUnit, data.report.facts, `the unit breakdown covers ${byUnit} of ${data.report.facts} facts`);
  });

  await check('the report’s funding totals are the lines’ own sums, and the filter agrees with them', async () => {
    const { data } = (await (await get('/api/projects/summary')).json()) as { data: ProjectSummaryBody };

    const live = await rows<Record<string, unknown>>(
      [
        'SELECT',
        `  COALESCE(SUM(CASE WHEN "IN_FUNDING_TOTAL" = 1 THEN "AMOUNT" ELSE 0 END), 0) AS in_total,`,
        `  COALESCE(SUM(CASE WHEN "IS_FORECAST" = 1 THEN "AMOUNT" ELSE 0 END), 0) AS forecast,`,
        `  COALESCE(SUM("AMOUNT"), 0) AS every_line,`,
        `  MIN("FISCAL_YEAR") AS first_year,`,
        `  MAX("FISCAL_YEAR") AS last_year`,
        `  FROM "X_REPORT_FUNDING_LINES"`,
      ].join('\n'),
    );
    const row = live[0];
    assert.ok(row, 'the funding aggregate returned no row at all');

    for (const key of ['in_total', 'forecast', 'every_line'] as const) {
      const direct: unknown = row[key];
      assert.equal(typeof direct, 'number', `${key} did not come back as a number: ${JSON.stringify(direct)}`);
      const reported =
        key === 'in_total' ? data.report.fundingInTotal : key === 'forecast' ? data.report.fundingForecast : data.report.fundingEveryLine;
      assert.ok(
        Math.abs(reported - (direct as number)) < 0.01,
        `the summary reports ${key} = ${reported}, the table sums to ${direct}`,
      );
    }

    // The years survive as null when absent, which is the one place in this module
    // a missing value must NOT become 0 — a fiscal year of 0 is not a year.
    assert.equal(data.report.fundingFirstYear, row.first_year, 'the first fiscal year disagrees with MIN()');
    assert.equal(data.report.fundingLastYear, row.last_year, 'the last fiscal year disagrees with MAX()');

    // The filter and the summary must be the same number reached two ways. A
    // filter cannot return more rows than the table, which is the only ordering
    // asserted here — the forecast is a *label* on a line, not a smaller table.
    const filtered = (await (await get('/api/projects/funding-lines?is_forecast=1&limit=100')).json()) as {
      data: { AMOUNT: number; IS_FORECAST: number }[];
      page: { total: number };
    };
    assert.ok(
      filtered.page.total <= data.report.fundingLines,
      `the forecast filter returned ${filtered.page.total} of ${data.report.fundingLines} lines`,
    );
    assert.ok(
      filtered.data.every((l) => l.IS_FORECAST === 1),
      'the forecast filter returned a line that is not flagged as a forecast',
    );
    const filteredSum = filtered.data.reduce((t, l) => t + l.AMOUNT, 0);
    assert.ok(
      Math.abs(filteredSum - data.report.fundingForecast) < 0.01,
      `the forecast lines sum to ${filteredSum} but the summary reports ${data.report.fundingForecast}`,
    );
  });

  await check('the report’s arithmetic is recomputed from the facts, and the checker can say no', async () => {
    const factsRes = await get('/api/projects/facts?limit=100');
    assert.equal(factsRes.status, 200, `expected 200 from the facts route, got ${factsRes.status}`);
    const factsBody = (await factsRes.json()) as { data: ProjectFactRow[] };
    const byName = new Map(factsBody.data.map((f) => [f.FACT_NAME, f]));

    const num = (name: string): number => {
      const fact = byName.get(name);
      assert.ok(
        fact,
        `the table no longer holds ${name}, which /api/projects/summary derives its identities from`,
      );
      const value = Number(fact.FACT_VALUE);
      assert.ok(Number.isFinite(value), `${name} is not numeric: ${JSON.stringify(fact.FACT_VALUE)}`);
      return value;
    };

    const building = num('GMP_BUILDING');
    const site = num('GMP_SITE');
    const total = num('GMP_TOTAL');
    const gsf = num('GSF');
    const perSf = num('COST_PER_SF');

    assert.equal(
      building + site,
      total,
      `GMP_BUILDING + GMP_SITE is ${building + site}, but GMP_TOTAL is ${total} — the transcription has stopped adding up`,
    );
    const derivedPerSf = Math.round((total / gsf) * 100) / 100;
    assert.ok(
      Math.abs(derivedPerSf - perSf) < 0.005,
      `GMP_TOTAL / GSF is ${derivedPerSf}, but COST_PER_SF is stated as ${perSf}`,
    );

    // And the endpoint's own verdict agrees with the recomputation above.
    const { data } = (await (await get('/api/projects/summary')).json()) as { data: ProjectSummaryBody };
    assert.equal(data.identities.length, 2, `expected 2 identities, got ${data.identities.length}`);
    for (const id of data.identities) {
      assert.notEqual(id.computed, null, `${id.name}: computed is null, so an operand is missing from the table`);
      assert.ok(
        id.holds,
        `${id.name} (${id.expression}) does not hold: computed ${id.computed}, stated ${id.stated}`,
      );
    }

    // The units are what the identities claim, and the ones a consumer will
    // divide by — reading `$/SF` against `USD` would be a silent factor error.
    assert.equal(byName.get('GSF')?.UNIT, 'sq ft', 'GSF is no longer measured in square feet');
    assert.equal(byName.get('COST_PER_SF')?.UNIT, 'USD/sq ft', 'COST_PER_SF is no longer a currency-per-area figure');
    assert.equal(byName.get('GMP_TOTAL')?.UNIT, 'USD', 'GMP_TOTAL is no longer a currency figure');

    // DISCRIMINATING CONTROL. If every combination of facts summed to the total,
    // `holds: true` would carry no information and a wrong transcription would
    // pass just as easily as a right one. Two other facts must NOT make the total.
    const ccap = num('CCAP');
    const offSite = num('OFF_SITE');
    assert.notEqual(
      ccap + offSite,
      total,
      'every pair of facts now sums to the GMP total, so the identity check cannot distinguish a correct ' +
        'transcription from an incorrect one — replace it with a check that still separates the two',
    );
  });

  await check('the funding lines keep the report’s own order, and a sort overrides it', async () => {
    const list = (await (await get('/api/projects/funding-lines?limit=100')).json()) as {
      data: { LINE_NUM: number; AMOUNT: number }[];
      page: { total: number };
    };
    assert.ok(list.data.length > 1, 'the report must hold more than one funding line to have an order at all');

    for (let i = 1; i < list.data.length; i += 1) {
      assert.ok(
        list.data[i - 1]!.LINE_NUM < list.data[i]!.LINE_NUM,
        `line ${i} breaks the LINE_NUM ascending default: ${list.data[i - 1]!.LINE_NUM} then ${list.data[i]!.LINE_NUM}`,
      );
    }

    // The default order is the report's order, not the biggest number first. Prove
    // the sort parameter actually changes the answer, or the default would look
    // correct for the wrong reason.
    const largest = (await (await get('/api/projects/funding-lines?sort=-AMOUNT&limit=1')).json()) as {
      data: { LINE_NUM: number; AMOUNT: number }[];
    };
    const maxAmount = Math.max(...list.data.map((l) => l.AMOUNT));
    assert.equal(
      largest.data[0]?.AMOUNT,
      maxAmount,
      'sorting by descending amount did not put the largest line first',
    );
    assert.notEqual(
      largest.data[0]?.LINE_NUM,
      list.data[0]!.LINE_NUM,
      'the largest line is also the first line, so this check cannot tell the two orderings apart',
    );
  });

  await check('a report fact resolves by its text key, and an absent fact is a 404', async () => {
    const res = await get('/api/projects/facts/GSF');
    assert.equal(res.status, 200, `expected 200 for a fact that exists, got ${res.status}`);
    const { data } = (await res.json()) as { data: ProjectFactRow };
    assert.equal(data.FACT_NAME, 'GSF');

    // Against the table, not against a literal: the value is a transcription of a
    // report and may legitimately change; the agreement is what matters.
    const live = await rows<{ FACT_VALUE: string }>(
      `SELECT "FACT_VALUE" FROM "X_REPORT_PROJECT_FACTS" WHERE "FACT_NAME" = ?`,
      ['GSF'],
    );
    assert.ok(live[0], 'GSF exists over HTTP but not in the table');
    assert.equal(data.FACT_VALUE, live[0].FACT_VALUE, 'the detail route disagrees with the table it reads');

    // A text primary key is the rarer shape here, so the 404 is worth proving
    // rather than assuming: a key that matches nothing must not come back as an
    // empty 200.
    const missing = await get('/api/projects/facts/NOT_A_FACT');
    assert.equal(missing.status, 404, `expected 404 for an absent fact, got ${missing.status}`);
    const err = (await missing.json()) as { error: { code: string } };
    assert.equal(err.error.code, 'NOT_FOUND');
  });

  await check('the EBS project tables are still empty while the report’s own figures are not', async () => {
    const empty = ['PA_PROJECTS_ALL', 'PA_TASKS', 'PA_BUDGET_VERSIONS', 'PA_BUDGET_LINES'];
    for (const table of empty) {
      assert.equal(
        await countOf(`SELECT COUNT(*) AS n FROM "${table}"`),
        0,
        `${table} now holds rows. A project source has been confirmed, so this module's premise, its ` +
          'descriptions, and this assertion all need revisiting — do not simply delete the check.',
      );
    }

    // The complement. Without it this check would pass on a database where every
    // project-related table is empty, which is not the claim being made.
    assert.ok(
      (await countOf('SELECT COUNT(*) AS n FROM "X_REPORT_PROJECT_FACTS"')) > 0,
      'the report fact table is empty too, so nothing about projects is stored anywhere — this check proves nothing',
    );

    // The five facts `/summary` derives from. If one vanishes, the endpoint
    // silently starts reporting an identity as "does not hold"; this is where
    // that is caught, with the cause named.
    for (const name of ['GSF', 'GMP_BUILDING', 'GMP_SITE', 'GMP_TOTAL', 'COST_PER_SF']) {
      const found = await rows<{ n: number }>(
        `SELECT COUNT(*) AS n FROM "X_REPORT_PROJECT_FACTS" WHERE "FACT_NAME" = ?`,
        [name],
      );
      assert.equal(
        found[0]?.n,
        1,
        `${name} is missing from X_REPORT_PROJECT_FACTS, so /api/projects/summary will report an identity as not holding`,
      );
    }
  });

  await check('an empty project list is a 200 with no rows, not a 404', async () => {
    const res = await get('/api/projects/master');
    assert.equal(res.status, 200, `expected 200 for an empty table, got ${res.status}`);
    const body = (await res.json()) as { data: unknown[]; page: { total: number; returned: number } };
    assert.deepEqual(body.data, [], 'the project master is empty, so data must be an empty array');
    assert.equal(body.page.total, 0, 'an empty table must report a zero total rather than omitting the page');
    assert.equal(body.page.returned, 0);

    // A filter that matches nothing is the other half of the same distinction: a
    // 200 with a zero total, and not an error about the filter being unknown.
    const filtered = await get('/api/projects/funding-lines?fiscal_year=1900');
    assert.equal(filtered.status, 200, `expected 200 for a filter matching nothing, got ${filtered.status}`);
    const filteredBody = (await filtered.json()) as { data: unknown[]; page: { total: number } };
    assert.deepEqual(filteredBody.data, []);
    assert.equal(filteredBody.page.total, 0);
  });

  // ---- The activity register (plan docs/plans/activity-page.md) -----------
  //
  // The register is an inventory: every object the app knows about, and how many
  // rows it holds. Its whole claim is that it distinguishes *a count that was
  // taken* from *a count that could not be*, and that every count says which
  // database produced it. So the assertions below are as much about `null` and
  // about `store` as about the numbers: a version of this feature that reported
  // `0` for an object nobody counted would pass every count assertion here and be
  // the exact defect the page exists to prevent, and one that reported the
  // sample's figures under the ledger's name would pass too.

  type StoreWire = 'app' | 'ledger';
  interface ReadingWire {
    date: string;
    rowCount: number;
    store: StoreWire;
    capturedAt: string;
    previousDate: string | null;
    previousCount: number | null;
    delta: number | null;
  }
  interface TableWire {
    name: string;
    kind: 'table' | 'view';
    owner: 'app' | 'extract';
    rowCount: number | null;
    scoped: boolean;
    scopeMode: 'segments' | 'lookup' | null;
    store: StoreWire;
    reading: { date: string; capturedAt: string } | null;
    snapshot: ReadingWire | null;
    reason: string | null;
  }
  interface DayWire {
    date: string;
    isToday: boolean;
    tables: TableWire[];
    summary: {
      tables: number;
      system: number;
      application: number;
      scoped: number;
      unscoped: number;
      counted: number;
      skipped: { name: string; reason: string }[];
      readings: {
        latest: string | null;
        capturedAt: string | null;
        read: number;
        comparable: number;
        moved: number;
        recorded: number;
        failed: { name: string; error: string }[];
      };
    };
    note: string | null;
    // ★ THE SCOPE THE COUNTS OBEY IS PART OF THE ANSWER. It is fixed on the server
    //   rather than taken from the reader's selection, so the page has to be told
    //   which rule its figures follow — and a page that typed `04` itself would be
    //   publishing a number nothing on the response had agreed to.
    scope: { fund: string; programs: string[] };
    source: {
      store: StoreWire;
      label: string;
      dialect: 'sqlite' | 'oracle';
      ledgerLabel: string;
      sharedWithLedger: boolean;
      countStore: StoreWire;
      countLabel: string;
    };
  }

  const activityDay = async (date: string): Promise<DayWire> => {
    const res = await get(`/api/activity?date=${date}`);
    assert.equal(res.status, 200, `expected 200 for ${date}, got ${res.status}`);
    const body = (await res.json()) as { data: DayWire };
    return body.data;
  };
  const byName = (day: DayWire, name: string): TableWire | undefined =>
    day.tables.find((t) => t.name === name);
  /**
   * The server's own today, asked for rather than assumed.
   *
   * ★ THE ROW-COUNT CHECKS HAVE TO USE THE DAY THE SERVER WOULD, because a reading
   *   is only taken for the current date — so asking about the 6th of August and
   *   then looking for a reading would find none, for the right reason, and the
   *   check would be testing the wall clock rather than the feature.
   */
  const todayFromServer = async (): Promise<string> => {
    const res = await get('/api/activity/today');
    assert.equal(res.status, 200, `expected 200 from /api/activity/today, got ${res.status}`);
    return ((await res.json()) as { data: { date: string } }).data.date;
  };

  /**
   * ★ THE COUNTS CROSS A DATABASE BOUNDARY ON THE LIVE TARGET, AND THAT MAKES A
   *   CAPTURE CHECK THERE A DIFFERENT EXPERIMENT RATHER THAN A FAILING ONE.
   *
   * Everything else the register does is local: the object list comes from
   * `sqlite_master`, the readings from `table_count_snapshot`, both in the app
   * store. The counts are the exception — each is read from the store that holds
   * the object — and under `DB_MODE=oracle` taking them means `COUNT(*)` over the
   * live ledger, two of which are measured at 2.5 and 2.7 million rows. That cost
   * was **measured, not estimated**, and the estimate was wrong: a full capture
   * against the live ledger takes **13.4 s for 41 objects, of which it wrote 39 and
   * Oracle refused 9** — not the "minutes" a first draft of this comment claimed.
   *
   * So the section runs against every target, including the live one, and only two
   * things are conditioned on which ledger is in use:
   *
   *   * **whether a count may fail.** The object list is a declared inventory taken
   *     from the sample's schema, not from Oracle's dictionary, so on the live
   *     ledger several objects are expected to be unreadable by this account and
   *     `failed` is legitimately non-empty. Off the ledger the same list is entirely
   *     readable and a failure is a bug. Both directions are asserted, on the
   *     target that applies.
   *   * **who writes the readings.** No route will create a reading for a past
   *     date, so the check that has to compare two readings plants the earlier one
   *     itself — and it clears before it plants as well as after, because a fixture
   *     that only cleans up after itself is isolated on a virgin database and
   *     nowhere else.
   *
   * The suite therefore exercises the capture route in the shipped configuration
   * rather than skipping it. A gate that skips the thing it exists to gate proves
   * the mounting and nothing about the handler.
   */
  const ledgerIsLocal = dbStatus().mode !== 'oracle';

  await check('the activity register lists every object, and each row agrees with itself', async () => {
    const day = await activityDay('2026-08-06');
    const dictionary = (await (await get('/api/meta/dictionary')).json()) as {
      data: { name: string }[];
    };

    // The register reads the same catalogue the dictionary does, so the two
    // listings have to be the same listing. A skip list that quietly dropped an
    // object would show up here as a missing name, not as a silent subtraction.
    const skipped = new Set(day.summary.skipped.map((s) => s.name));
    const listed = new Set(day.tables.map((t) => t.name));
    for (const obj of dictionary.data) {
      assert.ok(
        listed.has(obj.name) || skipped.has(obj.name),
        `${obj.name} is in the catalogue but appears in neither the register nor the skip list`,
      );
    }
    assert.equal(
      day.tables.length + skipped.size,
      dictionary.data.length,
      'the register and its skip list together must account for every object, with nothing counted twice',
    );

    for (const t of day.tables) {
      // ★ A COUNT AND A READING ARE THE SAME FACT IN TWO PLACES, so they can only
      //   be present or absent together. A count with no reading would be a number
      //   with nothing behind it — the shape any accidental live read on the GET
      //   path would produce, since it would answer with a figure it never stored.
      assert.equal(
        t.rowCount === null,
        t.reading === null,
        `${t.name} has ${t.rowCount === null ? 'no count' : 'a count'} but the opposite for its reading`,
      );
      // ★ AND THE READING IS THE COUNT'S OWN PROVENANCE, so the two must agree.
      if (t.reading && t.snapshot) {
        assert.equal(t.reading.date, t.snapshot.date, `${t.name}'s reading and snapshot disagree about the day`);
        assert.equal(t.reading.capturedAt, t.snapshot.capturedAt);
        assert.equal(t.snapshot.rowCount, t.rowCount, `${t.name}'s snapshot and its count disagree`);
      }
      // ★ WHERE THERE IS NO COUNT THERE MUST BE A REASON. The screen has nothing
      //   else to print for the row, so an absent reason renders as a blank cell
      //   that looks like a missing feature rather than an unread object.
      if (t.rowCount === null) {
        assert.ok(t.reason, `${t.name} has no count and no reason, which leaves the screen with nothing to say`);
      } else {
        assert.equal(t.reason, null, `${t.name} has a count and a reason; only one of them can be true`);
      }
      // ★ `scoped` IS DERIVED FROM `scopeMode` AND MUST NOT DRIFT FROM IT. The page
      //   prints "narrowed to fund 04 …" off `scoped` and its tooltip off
      //   `scopeMode`, so a row claiming to be scoped with no mechanism to scope by
      //   would advertise a filter that never ran.
      assert.equal(
        t.scoped,
        t.scopeMode !== null,
        `${t.name} says scoped=${t.scoped} with scopeMode=${String(t.scopeMode)}`,
      );
      // ★ AND THE OWNER IS THE APP'S OWN LIST, NOT A SECOND OPINION. `storeFor` and
      //   the split into two tabs both key off `isAppTable`, so a row disagreeing
      //   with `APP_TABLES` would appear under the wrong tab and be counted in the
      //   wrong database.
      const owned = (APP_TABLES as readonly string[]).some((a) => a.toLowerCase() === t.name.toLowerCase());
      assert.equal(
        t.owner,
        owned ? 'app' : 'extract',
        `${t.name} is reported as ${t.owner} but APP_TABLES says otherwise`,
      );
    }

    // The census and the rows are two views of one list, so a screen sentence built
    // from the summary cannot describe a different set from the table beneath it.
    assert.equal(day.summary.system + day.summary.application, day.summary.tables);
    assert.equal(day.summary.scoped + day.summary.unscoped, day.summary.tables);
    assert.equal(day.summary.application, day.tables.filter((t) => t.owner === 'app').length);
    assert.equal(day.summary.scoped, day.tables.filter((t) => t.scoped).length);
  });

  await check('the published scope is the one the route actually narrows by', async () => {
    const day = await activityDay(await todayFromServer());

    // ★ READ FROM THE ROUTE'S OWN SOURCE, NOT FROM A COPY OF THE NUMBERS. The
    //   response now publishes the fund and programs its counts obey so the page can
    //   name them instead of typing literals. That makes the response a claim about
    //   the server's behaviour, and a claim is only worth anything while something
    //   checks it against the behaviour — so this reads the constants out of
    //   `routes/activity.ts` and compares them to what was published. A fund changed
    //   in the route without a rebuild of the sentence would leave every count in the
    //   register narrowed to one set of accounts while the page named another, and
    //   nothing else in this suite reads either.
    const source = await readFile(new URL('../routes/activity.ts', import.meta.url), 'utf8');
    const fund = /SCOPE_FUND\s*=\s*'([^']+)'/.exec(source)?.[1];
    const programsRaw = /SCOPE_PROGRAMS\s*=\s*\[([^\]]*)\]/.exec(source)?.[1] ?? '';
    const programs = [...programsRaw.matchAll(/'([^']+)'/g)].map((m) => m[1]);

    // Without this the regexes could both match nothing and the comparison below
    // would be between two empty readings — a check that cannot fail.
    assert.ok(fund, 'SCOPE_FUND was not found in routes/activity.ts — the register no longer declares a fund');
    assert.ok(
      programs.length > 0,
      'SCOPE_PROGRAMS was not found in routes/activity.ts — the register no longer declares a program set',
    );

    assert.equal(
      day.scope.fund,
      fund,
      `the response publishes fund ${day.scope.fund} while the route narrows by ${fund}`,
    );
    assert.deepEqual(
      day.scope.programs,
      programs,
      `the response publishes programs [${day.scope.programs.join(', ')}] while the route narrows by [${programs.join(', ')}]`,
    );

    // ★ AND THE SCOPE HAS TO BE THE ONE THE FIGURES WERE ACTUALLY BUILT WITH, or the
    //   sentence is decoration. Nine of the sample's objects carry an account, so a
    //   scope published over a register where nothing was narrowed at all would be a
    //   claim about zero rows — this pins the pair together.
    assert.ok(
      day.summary.scoped > 0,
      'the register publishes a scope while narrowing nothing by it, so the published scope describes no figure on the page',
    );
  });

  await check('the scope is decided from each object’s own columns, not from a hand-written list', async () => {
    const day = await activityDay(await todayFromServer());

    // ★ THE REGISTER IS ASKED THE SAME QUESTION IT ASKS THE CATALOGUE, so the two
    //   answers have to agree. `scopeModeFor` is what the route calls; reading the
    //   columns here separately is what makes this a check rather than a
    //   restatement — a rename in the sample (`SEGMENT3` becoming `SEGMENT_3`) would
    //   leave the route counting a table in full while still reporting it as
    //   narrowed, and nothing else in the suite would notice.
    const mismatches: string[] = [];
    for (const t of day.tables) {
      const cols = (await rows<{ name: string }>('SELECT name FROM pragma_table_info(?)', [t.name])).map(
        (r) => r.name,
      );
      const expected = scopeModeFor(cols);
      if (t.scopeMode !== expected) {
        mismatches.push(`${t.name}: register says ${String(t.scopeMode)}, its columns say ${String(expected)}`);
      }
      // ★ AND THE STORE IS DECIDED THE SAME WAY, for the same reason: an object
      //   counted in the wrong database gets a figure describing something else.
      //   Only asserted where there is no reading, because a reading's store is a
      //   fact about when it was taken and may legitimately differ from what the
      //   current configuration would choose.
      if (t.reading === null && t.store !== storeFor(t.name)) {
        mismatches.push(`${t.name}: register says ${t.store}, storeFor says ${storeFor(t.name)}`);
      }
    }
    assert.deepEqual(mismatches, [], mismatches.join('; '));

    // ★ THE CHECK IS ONLY WORTH ANYTHING WHILE BOTH ANSWERS EXIST IN THE SAMPLE. A
    //   table list where every object is narrowable would pass the loop above and
    //   never test the "no account column" branch at all.
    assert.ok(day.summary.scoped > 0, 'no object in the sample carries an account, so the scoping above is untested');
    assert.ok(day.summary.unscoped > 0, 'every object carries an account, so "no account to narrow by" is untested');

    // ★ AND THE NAMED CASE, because it is the one the page has to be honest about:
    //   these carry neither their own segments nor a combination id, so their count
    //   is the whole object and the screen must not imply fund 04 was applied.
    for (const name of ['AP_INVOICES_ALL', 'PO_HEADERS_ALL', 'FND_CURRENCIES', 'DUAL']) {
      const t = byName(day, name);
      if (!t) continue; // not every extract ships every object
      assert.equal(t.scopeMode, null, `${name} has no account column, so there is no way to narrow it`);
      assert.equal(t.scoped, false, `${name} cannot be narrowed, so it must not claim to be`);
    }

    // The other direction: an object carrying only `CODE_COMBINATION_ID` must be
    // narrowed through the lookup rather than counted whole.
    const lookups = day.tables.filter((t) => t.scopeMode === 'lookup');
    for (const t of lookups) {
      const cols = (await rows<{ name: string }>('SELECT name FROM pragma_table_info(?)', [t.name])).map(
        (r) => r.name,
      );
      assert.ok(
        cols.some((c) => c.toUpperCase() === 'CODE_COMBINATION_ID'),
        `${t.name} is narrowed through the combination table but carries no CODE_COMBINATION_ID`,
      );
    }
  });

  await check('the app’s own tables are counted in the app store, not asked of the ledger', async () => {
    // ★ NOT A PREFERENCE, A FACT ABOUT WHERE THE DATA IS. The ledger has no copy of
    //   these tables, so asking it would report the application's own bookkeeping as
    //   an object the database is withholding — a page about provenance getting the
    //   provenance of its own register wrong.
    const day = await activityDay(await todayFromServer());
    const appTables = day.tables.filter((t) => t.owner === 'app');
    assert.deepEqual(
      appTables.map((t) => t.name).sort(),
      [...APP_TABLES].sort(),
      'the Application tab is not the app’s own table list',
    );
    for (const t of appTables) {
      assert.equal(storeFor(t.name), 'app', `${t.name} belongs to this app and must be counted in the app store`);
      // These carry neither their own segments nor a combination id, so their count
      // is the whole table and the screen must not imply otherwise.
      assert.equal(t.scopeMode, null, `${t.name} is an app table and has no account to narrow by`);
      assert.equal(t.scoped, false, `${t.name} cannot be narrowed, so it must not claim to be`);
    }

    // The two tabs are a partition of the register, with the app's own tables in
    // exactly one of them — so a row that moved between them cannot also appear in
    // the other, and the census sentence cannot describe a different set.
    assert.equal(day.summary.application, APP_TABLES.length);
    assert.equal(day.summary.system, day.tables.length - APP_TABLES.length);
    assert.ok(day.summary.system > 0, 'the System tab holds the ledger objects and must not be empty');
  });

  await check('a count says which database took it, and the page says which database that was', async () => {
    // ★ THE COUNTS NOW CROSS A DATABASE BOUNDARY, so "which database" is a fact each
    //   reading carries rather than something the page can infer from a setting. The
    //   old register read everything from the app store and the distinction could
    //   not be wrong; here a reading taken from the sample and served under the
    //   ledger's name is a silently false claim about production data — the one
    //   failure this page exists to make impossible.
    const day = await activityDay(await todayFromServer());

    // The labels the page prints are the server's own configuration, so the check
    // compares them with that configuration rather than with literals.
    assert.equal(
      day.source.countLabel,
      day.source.sharedWithLedger ? day.source.label : day.source.ledgerLabel,
      'the label a count is attributed to is not the store the count comes from',
    );
    assert.equal(day.source.countStore, day.source.sharedWithLedger ? 'app' : 'ledger');
    assert.ok(day.source.ledgerLabel, 'the page must be able to name the ledger even when it is not the source');

    const today = await todayFromServer();
    for (const t of day.tables) {
      if (t.reading === null) continue; // no figure, so nothing to attribute
      assert.ok(t.snapshot, `${t.name} carries a reading and no snapshot, which the route cannot produce`);
      assert.ok(
        t.snapshot.store === 'app' || t.snapshot.store === 'ledger',
        `${t.name}'s reading says it was taken in ${String(t.snapshot.store)}, which is not a store`,
      );
      if (t.owner === 'app') {
        // Structural and never varies: this app's tables exist only here.
        assert.equal(t.snapshot.store, 'app', `${t.name} is one of this app's tables, so its count is local`);
      } else if (t.snapshot.date === today) {
        // ★ A READING TAKEN TODAY WAS TAKEN UNDER THE CONFIGURATION IN FORCE NOW, so
        //   it must match the store the page names. An older reading is exempt on
        //   purpose: if `DB_MODE` was flipped since, that reading's attribution is
        //   history — a true statement about then — and asserting it against today's
        //   setting would fail for a legitimate reason. That is also why flipping
        //   the mode is a reason to take a fresh reading rather than to trust one.
        assert.equal(
          t.snapshot.store,
          day.source.countStore,
          `${t.name} carries a count from ${t.snapshot.store} while the page names ${day.source.countStore}`,
        );
      }
    }

    // ★ AND A LOAD IS NOT A CAPTURE. The GET answers from readings already stored; if
    //   it counted, this very request would have written today's rows and the figures
    //   asserted above would be the ones it had just taken — so the check would pass
    //   while the read path had quietly acquired the power to scan the ledger.
    assert.equal(day.summary.readings.recorded, 0, 'a page load recorded readings; the count belongs on the button');
  });

  await check('the app’s table list and the DDL agree, so neither can drift', async () => {
    // ★ TWO HAND-MAINTAINED LISTS OF THE SAME THING. `APP_TABLES` decides which
    //   tables the register attributes to this app, and `01-app.sql` decides which
    //   tables exist. A table added to the DDL and not to the list would be
    //   reported as an extract table — a wrong provenance, silently.
    const source = await readFile(sampleSql('01-app.sql'), 'utf8');
    const declared = [...source.matchAll(/^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gim)]
      .map((m) => (m[1] ?? '').toLowerCase())
      .sort();
    assert.deepEqual(
      [...APP_TABLES].sort(),
      declared,
      'APP_TABLES and the CREATE TABLE statements in 01-app.sql are different sets',
    );
  });

  await check('the routing table list names every table the app owns', async () => {
    // ★ THE THIRD COPY, AND THE ONE THAT WAS NEVER COMPARED. `store.ts` keeps its
    //   own list of app tables because importing `APP_TABLES` there would close an
    //   import cycle — and that list, not `APP_TABLES`, is what decides whether a
    //   statement goes to the app store or to the ledger. The check above compared
    //   the applier's list against the DDL and stopped, so the list that actually
    //   routes was the one list nothing read.
    //
    //   Its own comment promised the suite asserted all three; it asserted two. A
    //   promise in a comment is not a check, and this is the check: `vendor_site_route`
    //   was added to the DDL and to `APP_TABLES` and missed here, so a statement naming
    //   it over the routed `db` was sent to the ledger and failed with `ORA-00942` —
    //   the table "does not exist" in the one store that never had it. Asserting the
    //   sets equal, and reporting BOTH directions, is what makes the drift loud at the
    //   point of the omission rather than at the point of the request.
    const routing = [...ROUTING_APP_TABLES].sort();
    const owned = [...APP_TABLES].sort();
    assert.deepEqual(
      routing,
      owned,
      'the routing list in db/store.ts and APP_TABLES in db/app-schema.ts are different sets: ' +
        `in APP_TABLES but not routed to the app store [${owned.filter((t) => !routing.includes(t)).join(', ') || '—'}]; ` +
        `routed but not declared an app table [${routing.filter((t) => !owned.includes(t)).join(', ') || '—'}]`,
    );
  });

  await check('the server’s own today and the register agree, which is what the rail badge reads', async () => {
    const res = await get('/api/activity/today');
    assert.equal(res.status, 200);
    const badge = ((await res.json()) as { data: { date: string; counted: number; moved: number } }).data;

    const day = await activityDay(badge.date);
    assert.equal(day.isToday, true, 'the badge’s date must be the register’s own today');
    assert.equal(
      badge.counted,
      day.summary.counted,
      'the rail badge and the page would show different numbers for the same day',
    );
    assert.equal(
      badge.moved,
      day.summary.readings.moved,
      'the badge’s "moved" and the page’s are two answers to the same question',
    );
    // ★ THE TWO FIGURES COVER THE SAME SET OF OBJECTS, so the smaller cannot exceed
    //   the larger — `moved` counts readings whose difference is non-zero and
    //   `counted` counts readings. A badge reporting more movement than counts is
    //   arithmetic between two different populations.
    assert.ok(
      badge.moved <= badge.counted,
      `the badge reports ${badge.moved} moved out of ${badge.counted} counted, which cannot both be true`,
    );
  });

  await check('a day before any reading has none to report, while a later day still has the newest', async () => {
    // ★ THE TWO DIRECTIONS OF `snapshot_date <= :day`, WHICH ARE NOT SYMMETRIC — and
    //   the asymmetry is the design. Asked about a day before the earliest reading,
    //   the register must find nothing and say "not counted"; a `0` there would be a
    //   claim about a table nobody measured. Asked about a day *after* it, the
    //   register must still find it: a count taken on the 6th is the last thing known
    //   about the object on the 20th, and reporting nothing would throw away the only
    //   fact available.
    const early = await activityDay('1990-01-01');
    assert.ok(early.tables.length > 0, 'the register still lists every object on a day with no readings');
    assert.equal(early.summary.counted, 0, 'nothing was recorded in 1990, so nothing can be reported for it');
    for (const t of early.tables) {
      assert.equal(t.rowCount, null, `${t.name} reported a count for 1990, which cannot exist`);
      assert.ok(t.reason, `${t.name} has no count for 1990 and must say so in words`);
    }

    const today = await todayFromServer();
    const later = await activityDay('2099-01-01');
    const same = await activityDay(today);
    assert.equal(
      later.summary.counted,
      same.summary.counted,
      'a later day must report the newest readings, not a different number of them',
    );
    assert.equal(later.summary.readings.latest, same.summary.readings.latest);
    assert.ok(
      later.summary.readings.latest !== null,
      'the reading taken today must be visible from a later day, or the newest reading is being discarded',
    );
  });

  await check('CONTROL: a date that does not exist is refused rather than quietly moved', async () => {
    // ★ SQLite answers `date('2026-02-31')` with `'2026-03-03'` — it normalises
    //   rather than refusing, so a naive implementation reports the third of March
    //   under a heading that says February, and nothing anywhere says so. The
    //   round trip catches it; this is the control that proves the round trip runs.
    const res = await get('/api/activity?date=2026-02-31');
    assert.equal(res.status, 400, 'an impossible date must be a 400');
    const body = (await res.json()) as { error: { code: string; message: string; details?: unknown } };
    assert.equal(body.error.code, 'BAD_REQUEST');
    assert.match(body.error.message, /not a real date/i);
    assert.match(body.error.message, /2026-03-03/, 'the refusal must name the date SQLite would have used');

    // The controls on the other side of it: a shape the schema rejects, and a
    // month that is out of range in a way the regex cannot see.
    assert.equal((await get('/api/activity?date=nonsense')).status, 400);
    assert.equal((await get('/api/activity?date=2026-13-01')).status, 400);
    assert.equal((await get('/api/activity?date=2027-02-29')).status, 400);
    assert.equal((await get('/api/activity?date=2026-02-28')).status, 200, 'a real date must still pass');
  });

  // ---- The readings: what a count is, and what a difference between two is ----
  //
  // The register's figures are readings, and the assertions below are about the
  // states being *kept apart*: no reading yet, a first reading, two readings that
  // agree, and two that do not. Collapsing any two of those into the same
  // rendering is the defect this feature exists to avoid — `±0` is a measurement
  // and "not counted yet" is the absence of one, and a screen that showed `0` for
  // both would be claiming a measurement it never took.

  await check('every object with a count has the reading behind it, and one without has none', async () => {
    let date = await todayFromServer();
    let day = await activityDay(date);

    // ★ THE SECTION'S FIXTURE IS THE BUTTON'S OWN PATH, AND IT IS ESTABLISHED HERE
    //   RATHER THAN ASSUMED. A reading only exists once somebody has taken one, and
    //   on a database where nobody has opened the page today there are none — so a
    //   check that merely *hoped* for readings would fail on the first run of a day
    //   and pass on every run after it, which is the shape of a fixture that cleans
    //   up after itself but not before. Taking the capture when it is absent makes
    //   the state below the check's own doing.
    if ((await activityDay(date)).summary.counted === 0) {
      const res = await post('/api/activity/snapshot', {});
      assert.equal(res.status, 201, `the capture had to run to give this check its fixture and got ${res.status}`);
      date = await todayFromServer();
      day = await activityDay(date);
    }

    const counted = day.tables.filter((t) => t.rowCount !== null);
    const uncounted = day.tables.filter((t) => t.rowCount === null);
    assert.ok(counted.length > 0, 'no object has a count, so the two directions below cannot both be tested');

    for (const t of counted) {
      assert.ok(t.snapshot, `${t.name} carries a count, so a reading must exist for it`);
      assert.equal(
        t.snapshot.rowCount,
        t.rowCount,
        `${t.name}'s reading and its count disagree, so one of them is not the other's source`,
      );
      assert.equal(t.snapshot.date, date, `${t.name}'s reading is filed under the wrong day`);
      assert.ok(t.snapshot.capturedAt, `${t.name}'s reading must be stamped with when it was taken`);
      assert.ok(
        t.snapshot.date <= date,
        `${t.name}'s reading is dated after the day being asked about, which the query cannot produce`,
      );
    }
    // ★ THE OTHER DIRECTION, AND THE ONE A `?? 0` WOULD BREAK. A reading for an object
    //   whose count could not be taken would be a fabricated number — precisely what
    //   any `?? 0` in the capture path leaves behind, and the reason `row_count` is
    //   NOT NULL in the table. Asserted for the app's own tables as well, because
    //   they are counted by a different branch of the same function.
    for (const t of uncounted) {
      assert.equal(t.snapshot, null, `${t.name} has no count, so it must have no reading rather than a zero`);
    }
    if (ledgerIsLocal) {
      // ★ OFF THE LIVE LEDGER, NOTHING MAY FAIL. Every object in the list exists in
      //   the local sample and the local sample answers every `COUNT(*)`, so a gap
      //   there is a bug in the capture rather than a fact about a database. On the
      //   live ledger the opposite is the documented expectation — the object list is
      //   the *sample's* declared inventory, so this account's inability to read part
      //   of it is what the page exists to report — and the capture check below
      //   asserts that a failure is reported by name rather than swallowed.
      assert.deepEqual(
        uncounted.map((t) => t.name),
        [],
        'an object failed to count against the local sample, where nothing should fail',
      );
    }

    assert.equal(
      day.summary.readings.read,
      counted.length,
      'the census counts a different number of readings than the rows carry',
    );
    assert.ok(
      day.summary.readings.capturedAt,
      'the census must say when the reading was taken, not only which day it belongs to',
    );
  });

  await check('a difference is the arithmetic on two readings, and one reading is not a zero', async () => {
    const day = await activityDay(await todayFromServer());
    const withReading = day.tables.filter((t) => t.snapshot !== null);
    assert.ok(withReading.length > 0, 'there must be readings to check');

    let compared = 0;
    for (const t of withReading) {
      const s = t.snapshot!;
      if (s.previousDate === null) {
        // ★ THE STATE THE FEATURE IS MOST LIKELY TO GET WRONG. One reading is not
        //   "nothing changed" — there is nothing to have changed *from* — so all
        //   three of the comparison's parts are absent together, and a `delta` of
        //   `0` here would be a claim about a comparison never made.
        assert.equal(s.previousCount, null, `${t.name} has no earlier reading, so no earlier count`);
        assert.equal(s.delta, null, `${t.name} must report \`null\`, not 0, for a first reading`);
        continue;
      }
      compared += 1;
      assert.ok(s.previousDate < s.date, `${t.name}'s earlier reading must actually be earlier`);
      assert.equal(typeof s.previousCount, 'number');
      assert.equal(
        s.delta,
        s.rowCount - (s.previousCount ?? 0),
        `${t.name}'s difference is not the difference between the two readings it sends`,
      );
    }

    // And the census agrees with the rows, so the screen's "N of M compared"
    // sentence cannot describe a different set from the column above it.
    assert.equal(day.summary.readings.comparable, compared);
    assert.equal(
      day.summary.readings.moved,
      withReading.filter((t) => t.snapshot!.delta !== null && t.snapshot!.delta !== 0).length,
      'a count that did not move must not be reported as moved',
    );
  });

  await check('the difference is against the reading before, not against yesterday', async () => {
    // ★ THERE IS NO SCHEDULER, AND THAT IS THE WHOLE FEATURE. The pairing query is
    //   `ROW_NUMBER() OVER (PARTITION BY object_name ORDER BY snapshot_date DESC)`,
    //   so a table read on the 2nd and again on the 6th is compared 2nd-to-6th and
    //   the three days between contribute nothing. The obviously wrong
    //   alternative — "compare with yesterday, and treat a missing yesterday as
    //   zero" — looks nearly identical on a sample where every object has exactly
    //   one reading, so this check builds both shapes by hand.
    //
    //   It is the only check in the suite that writes to the app tables directly,
    //   because no route will create a reading for a past date — rightly, since a
    //   count has to be taken on the day it describes. It takes ownership of its two
    //   objects' history for the duration: cleared before, planted, cleared again
    //   afterwards, and today's original rows put back, which is what makes the run
    //   independent of whatever ran yesterday. It then re-reads the register to
    //   confirm the planted rows are what moved the comparison and nothing else did.
    //
    //   ★ IT PLANTS TODAY'S ROWS TOO, AND THAT IS A CORRECTION. The first version read
    //   the day's existing readings and planted only the earlier ones — which made it
    //   depend on a capture having already run, and then made it *silently* wrong the
    //   moment readings acquired a provenance: `readReadings` skips a row whose
    //   `counted_in` is NULL, because a figure taken before provenance existed cannot
    //   be attributed to a database, so a planted row without it is invisible and the
    //   check would have failed with a message blaming the comparison arithmetic.
    //   Planting the whole history fixes both: the fixture is its own, and it is a
    //   fixture the read path can actually see.
    const date = await todayFromServer();
    const day0 = await activityDay(date);
    const pool = day0.tables.filter((t) => t.owner !== 'app');
    const withCounts = pool.filter((t) => t.rowCount !== null);
    const picks = (withCounts.length >= 2 ? withCounts : pool).slice(0, 2);
    const [skip, nearest] = picks as [TableWire, TableWire];
    assert.ok(skip && nearest, 'need two objects to plant readings for');

    // What today's readings for these two were, so the cleanup can put the sample
    // back as it found it rather than merely removing its own marks.
    const saved = await rows<{
      object_name: string;
      row_count: number;
      counted_in: string | null;
      captured_at: string;
    }>(
      `SELECT object_name, row_count, counted_in, captured_at
         FROM table_count_snapshot
        WHERE snapshot_date = ? AND object_name IN (?, ?)`,
      [date, skip.name, nearest.name],
    );

    /**
     * ★ `date(x, '−N day')` IS SQLITE'S, SO THE STATEMENT IS SENT TO THE APP STORE
     *   BY NAME. It names no registered table, and `routeStatement`'s documented
     *   fallback sends a table-less statement to the **ledger** — where `DATE` is a
     *   datatype keyword, not a function, so the whole select became `ORA-00936:
     *   missing expression`. That fallback is right for the DDL, pragmas and
     *   connection checks it was written for and wrong for this: the arithmetic is
     *   about `snapshot_date`, which lives in the app store. The routing was never
     *   asked and the assertion below never ran under a single-store target, which
     *   is why this passed while the ledger was SQLite and failed the moment it
     *   became Oracle.
     */
    const shift = async (days: number): Promise<string> => {
      const res = await storeDriver('app').execute({
        sql: `SELECT date(?, ?) AS d`,
        args: [date, `${days} day`],
      });
      const found = res.rows as unknown as { d: string }[];
      assert.ok(found[0], 'the app store must be able to subtract days from a date');
      return found[0].d;
    };
    // Four days back, not one: the object below must have to cross three days that
    // hold no reading at all, which is the only way to distinguish "the reading
    // before" from "yesterday".
    const farDay = await shift(-4);
    const nearDay = await shift(-1);
    assert.ok(farDay < nearDay && nearDay < date, 'the planted dates must run backwards from today');

    const plant = async (objectName: string, onDay: string, count: number): Promise<void> => {
      await execute(
        `INSERT INTO table_count_snapshot (object_name, snapshot_date, row_count, counted_in, captured_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (object_name, snapshot_date) DO UPDATE SET
           row_count   = excluded.row_count,
           counted_in  = excluded.counted_in,
           captured_at = excluded.captured_at`,
        [objectName, onDay, count, storeFor(objectName), `${onDay} 04:00:00`],
      );
    };
    // ★ BOTH ENDS. Deleting before the plant as well as after it is what makes the
    //   check independent of yesterday: without the pre-clear, a leftover reading
    //   from an earlier run was the object's "reading before" and the assertions
    //   below failed against a state the check had not created. It removes nothing
    //   the cleanup would not have removed anyway — the whole of these two objects'
    //   history, on every date.
    const clearAll = async (): Promise<void> => {
      await execute(`DELETE FROM table_count_snapshot WHERE object_name IN (?, ?)`, [
        skip.name,
        nearest.name,
      ]);
    };
    await clearAll();

    const skipToday = (typeof skip.rowCount === 'number' ? skip.rowCount : 0) + 1;
    const nearToday = (typeof nearest.rowCount === 'number' ? nearest.rowCount : 0) + 1;

    try {
      // ★ WITH NO READING AT ALL THE ROW MUST GO BACK TO `null`, NOT TO ZERO — the
      //   same rule the whole page rests on, checked here on its own fixture rather
      //   than on whatever state the target happened to be in.
      const clearedDay = await activityDay(date);
      for (const name of [skip.name, nearest.name]) {
        const row = byName(clearedDay, name);
        assert.equal(row?.rowCount ?? null, null, `${name} still reports a count after its only reading was removed`);
        assert.ok(row?.reason, `${name} has no reading and must say so in words rather than show nothing`);
      }

      // `skip` gets one earlier reading, four days back. `nearest` gets that same
      // reading and then a second one yesterday, so its comparison must use the
      // closer of the two rather than the oldest.
      await plant(skip.name, farDay, skipToday + 5);
      await plant(nearest.name, farDay, nearToday + 9);
      await plant(nearest.name, nearDay, nearToday + 2);
      await plant(skip.name, date, skipToday);
      await plant(nearest.name, date, nearToday);

      const after = await activityDay(date);
      const skipRow = byName(after, skip.name);
      const nearestRow = byName(after, nearest.name);
      assert.ok(skipRow?.snapshot && nearestRow?.snapshot, 'both planted objects must be in the register');

      // The served figure is today's planted reading — not the earlier one, and not
      // a number recomputed from the object itself.
      assert.equal(skipRow.rowCount, skipToday, `${skip.name} is not reporting today's planted reading`);
      assert.equal(skipRow.snapshot.date, date, `${skip.name}'s reading is filed under the wrong day`);

      assert.equal(
        skipRow.snapshot.previousDate,
        farDay,
        `${skip.name} was not compared with its actual earlier reading`,
      );
      assert.equal(
        skipRow.snapshot.previousCount,
        skipToday + 5,
        `${skip.name}'s earlier count is not the one stored for ${farDay}`,
      );
      assert.equal(
        skipRow.snapshot.delta,
        -5,
        'the difference must be signed, so a fall is a negative number and not an absence',
      );

      // ★ THE NEAREST EARLIER READING WINS, NOT THE OLDEST. Comparing with the
      //   first reading ever taken would be a different number that looks equally
      //   plausible, and nothing else in the suite would notice.
      assert.equal(
        nearestRow.snapshot.previousDate,
        nearDay,
        `${nearest.name} must be compared with the closest earlier reading, not the furthest`,
      );
      assert.equal(nearestRow.snapshot.previousCount, nearToday + 2);
      assert.equal(nearestRow.snapshot.delta, -2);

      // ★ AND THE COMPARISON IS ONLY MADE WITHIN ONE STORE. Two counts taken from two
      //   databases are two measurements of two different things, so their difference
      //   is not a change in either — the reading says which store it came from and
      //   the pair is only comparable when they agree.
      assert.equal(
        skipRow.snapshot.store,
        storeFor(skip.name),
        `${skip.name}'s reading is attributed to a store the register would not have used`,
      );
    } finally {
      await clearAll();
      for (const r of saved) {
        await execute(
          `INSERT INTO table_count_snapshot (object_name, snapshot_date, row_count, counted_in, captured_at)
           VALUES (?, ?, ?, ?, ?)`,
          [r.object_name, date, r.row_count, r.counted_in, r.captured_at],
        );
      }
    }

    // And the fixture is gone: one reading each — the one the target had — so nothing
    // is comparable again. Without this the check could pass while leaving the sample
    // altered for every run that follows.
    const restored = await activityDay(date);
    for (const name of [skip.name, nearest.name]) {
      const row = byName(restored, name);
      assert.equal(
        row?.snapshot?.previousDate ?? null,
        null,
        `${name} still has a planted earlier reading`,
      );
      assert.equal(row?.snapshot?.delta ?? null, null, `${name} still reports a difference`);
    }
    const restoredRows = await rows<{ n: number }>(
      `SELECT COUNT(*) AS n FROM table_count_snapshot WHERE object_name IN (?, ?) AND snapshot_date <> ?`,
      [skip.name, nearest.name, date],
    );
    assert.equal(
      restoredRows[0]?.n ?? -1,
      0,
      'the check left earlier readings behind for its two objects',
    );
  });

  await check('taking a reading twice on one day replaces it, it does not add a second', async () => {
    // ★ THE COMPOSITE UNIQUE IS WHAT CARRIES THIS. The register is refreshed by
    //   pressing a button, and a button gets pressed twice — so the day must hold one
    //   reading per object however many times it is pressed, and the day's difference
    //   must not end up measured against a reading taken ninety seconds earlier.
    //
    //   ★ HOW LONG THIS TAKES IS A PROPERTY OF THE TARGET, AND IT WAS MEASURED RATHER
    //   THAN ASSUMED. Against the local sample the capture is instant. Against the
    //   live ledger it is a set of `COUNT(*)` scans over multi-million-row tables:
    //   measured at 13.4 s for 41 objects, of which the account could read 39 and
    //   Oracle refused 9. So it is slow but affordable once, and this check is the
    //   only place in the suite that pays it — the checks around it read the stored
    //   reading, which is the whole point of the design.
    const date = await todayFromServer();
    const before = await rows<{ n: number }>(
      `SELECT COUNT(*) AS n FROM table_count_snapshot WHERE snapshot_date = ?`,
      [date],
    );

    const res = await post('/api/activity/snapshot', {});
    assert.equal(res.status, 201, `expected 201 from the capture, got ${res.status}`);
    const body = (
      (await res.json()) as {
        data: {
          date: string;
          capturedAt: string;
          written: number;
          failed: { name: string; error: string }[];
        };
      }
    ).data;

    assert.equal(body.date, date, 'the capture filed its readings under a different day than it was asked for');
    assert.ok(body.capturedAt, 'a reading must be stamped with when it was taken');
    assert.ok(body.written > 0, 'a capture that wrote nothing is not a capture');

    // ★ A FAILURE MUST BE ATTRIBUTED, NOT COUNTED. On the live ledger some objects
    //   cannot be read by this account at all — nine of them, every one `ORA-00942` —
    //   so `failed` is legitimately non-empty there and asserting it empty would
    //   assert something false about the shipped configuration. What must hold on
    //   every target is weaker and more useful: a failure names the object it belongs
    //   to and carries the reason, so the page can say *which* table it could not
    //   count instead of quietly leaving a blank.
    for (const f of body.failed) {
      assert.ok(f.name, 'a failed count must name the object it could not count');
      assert.ok(f.error && f.error.trim().length > 0, `${f.name} failed without a reason to show`);
    }
    // ★ AND NOTHING IS DROPPED. Every object the register lists is either written or
    //   reported — never neither, which is what a swallowed exception in the counting
    //   loop would produce. This is the assertion that makes `failed` non-optional.
    const listed = await activityDay(date);
    assert.equal(
      body.written + body.failed.length,
      listed.tables.length,
      'the capture neither wrote nor reported an object, so something failed silently',
    );

    // The number of rows for the day is unchanged by the second write, which is the
    // only way to tell an upsert from an append from outside the database.
    const after = await rows<{ n: number }>(
      `SELECT COUNT(*) AS n FROM table_count_snapshot WHERE snapshot_date = ?`,
      [date],
    );
    assert.ok(
      (after[0]?.n ?? -1) > 0,
      'the capture wrote nothing at all to the readings table',
    );
    assert.equal(
      after[0]?.n,
      before[0]?.n,
      'a repeat capture added rows for objects that already had a reading, so it appended instead of replacing',
    );
    assert.equal(
      (await activityDay(date)).summary.readings.read,
      body.written,
      'the register reads a different number of readings than the capture wrote',
    );
  });

  await check('the capture route is a write, so a read-only target must refuse it', async () => {
    // ★ THE ROUTE MUST NOT BE IN `READ_ONLY_POSTS`. It writes rows, so it belongs
    //   behind `writesGuard` and must be refused with `WRITES_DISABLED` when the
    //   target will not take writes. Registered as read-only instead, the refusal
    //   would be about `ALLOW_REMOTE_WRITES` — a setting that has nothing to do
    //   with it — and the request would reach a write path the guard never saw.
    const spec = await get('/api/docs.json');
    assert.equal(spec.status, 200);
    const doc = (await spec.json()) as {
      paths: Record<string, Record<string, { operationId: string; tags: string[]; responses: object }>>;
    };
    const route = doc.paths['/api/activity/snapshot']?.post;
    assert.ok(route, 'the capture route is missing from the OpenAPI document');
    assert.equal(route.operationId, 'activity_snapshot');
    assert.deepEqual(route.tags, ['Meta']);
    assert.ok('201' in route.responses, 'a POST that creates a reading must document its 201');
    assert.ok('409' in route.responses, 'a write must document the refusal it gets on a read-only target');
    assert.ok('503' in route.responses);

    // ★ The documentation alone would not catch the real mistake, which is the
    //   route being *added to the exemption list*. In local mode every write is
    //   permitted, so an extra entry there changes no response and would go
    //   unnoticed for as long as nobody ran against a read-only target.
    assert.ok(
      !readOnlyPosts.has('POST /api/activity/snapshot'),
      'the capture route was exempted from the write guard; it writes rows and must not be',
    );
    // The one entry that is there must stay there, so a future tidy-up does not
    // "simplify" the list away and refuse the builder's Run button.
    assert.ok(readOnlyPosts.has('POST /api/views/preview'), 'the preview exemption went missing');

    // And the read-only half of the register is still a GET, which is the
    // distinction the guard keys on.
    assert.equal((await get('/api/activity/snapshot')).status, 404, 'the capture must not answer a GET');
  });

  // ---- View builder (plan docs/plans/view-builder.md §13, V1–V14) ---------
  //
  // "The query guard is the feature" (§18), so the gates that matter are the ones
  // where a bad statement is refused *for the stated reason*. A statement that
  // fails for an unexplained reason is not a guard, it is an outage.
  //
  // Three things about how this section is arranged:
  //
  //   * The domain is opt-in and off by default (§5.4). `views.ts` reads
  //     `config.viewBuilder` on every call rather than capturing it at import, so
  //     one process can exercise both positions. Both are asserted: off must
  //     refuse before routing or SQL is reached, on must run.
  //
  //   * `analyzeSql` skips the SQLite dialect lint when the target is Oracle,
  //     because every rule in that table says "this is Oracle-only and the backend
  //     is SQLite" — all false when the backend really is Oracle. So V3 and V4
  //     assert the dialect in play rather than a fixed answer. A gate demanding
  //     that a correct server produce a wrong lint is worse than the lint.
  //
  //   * The gates that name sample tables are skipped on Oracle rather than
  //     failing, and the skip is printed. A silent skip and a pass look identical
  //     in the output, and that is the failure mode a gate exists to prevent.

  const vb = config.viewBuilder;
  const vbSaved = { enabled: vb.enabled, maxRows: vb.maxRows, timeoutMs: vb.timeoutMs };
  const vbOracle = config.db.mode === 'oracle';

  // ★ THE SUITE TURNS THE FEATURE ON FOR ITSELF rather than requiring
  //   `VIEW_BUILDER_ENABLED=1` on the command line. A gate that only runs when
  //   someone remembers an environment variable is a gate that is off by default,
  //   and "off by default" and "passing" print the same word. `views.ts` reads the
  //   value per call instead of capturing it at import, so this is the same switch
  //   the env var throws.
  //
  //   V0 then flips it back off to check the refusal, which is the position that
  //   actually ships. Both are asserted; neither is assumed.
  vb.enabled = true;

  /** `POST /api/views/preview` takes the SQL in the body, so a statement can be tried before it is saved. */
  const preview = (body: unknown): Promise<Response> => post('/api/views/preview', body);
  const previewSql = (sql: string): Promise<Response> => preview({ sql });

  /** The part of a preview response these gates read. Named for the payload, not the envelope. */
  interface PreviewData {
    result: {
      columns: { key: string; label: string; format: string; hidden: boolean }[];
      rows: (string | number | null)[][];
      rowCount: number;
      limit: number;
      truncated: boolean;
      findings: { code: string; severity: string; message: string; fix: string | null }[];
      drift: { key: string; message: string }[];
    };
    durationMs: number;
    appliedValues: Record<string, string | number | null>;
  }

  const previewData = async (res: Response): Promise<PreviewData> => {
    if (res.status !== 200) {
      // The body has to be read *now*: it is a stream, and putting `await res.text()`
      // in an assert message consumes it eagerly for a message that is only wanted
      // on failure.
      assert.fail(`expected 200, got ${res.status}: ${await res.text()}`);
    }
    return ((await res.json()) as { data: PreviewData }).data;
  };

  const refusal = async (
    res: Response,
  ): Promise<{ status: number; code: string; message: string; details: Record<string, unknown> }> => {
    // ── ★ A REFUSAL MUST CARRY AN ERROR ENVELOPE, AND SAYING SO IS THE WHOLE POINT.
    //      This read `body.error.code` unguarded, so a request that ANSWERED
    //      (200, `{ data }`) reported `Cannot read properties of undefined (reading
    //      'code')` — a message naming nothing about what was being tested. The test
    //      that found it was asserting a *documented* 200 as a 409 (see V0 below),
    //      and the guard now says outright that the envelope is missing rather than
    //      blaming a property. Same family as `previewData` above: read the body, then
    //      say what shape it was not.
    const raw = await res.text();
    let body: { error?: { code: string; message: string; details?: Record<string, unknown> } };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      assert.fail(`a refusal must be JSON, got ${res.status} with ${raw.slice(0, 200)}`);
    }
    if (!body.error) {
      assert.fail(
        `expected an error envelope from a refusal, got ${res.status} with ${raw.slice(0, 200)}`,
      );
    }
    return {
      status: res.status,
      code: body.error.code,
      message: body.error.message,
      details: body.error.details ?? {},
    };
  };

  /** The sample tables the gates below name, and whether this target has them. */
  const vbSample = !vbOracle;

  try {
    // ---- The switch (V0, and the premise of every gate below it) ----------

    await check('V0: with the builder off the whole domain refuses, and names the switch', async () => {
      vb.enabled = false;
      try {
        const cases: [string, Response][] = [
          ['POST /api/views/preview', await previewSql('SELECT 1 AS one')],
          [
            'POST /api/views',
            await post('/api/views', { slug: 'off-switch', title: 'Off', sql: 'SELECT 1 AS one' }),
          ],
        ];
        // An execution and a write. Both would otherwise be served, so a 409 from
        // either can only be the switch and nothing else.
        for (const [what, res] of cases) {
          const err = await refusal(res);
          assert.equal(err.status, 409, `${what} should be 409 while the builder is off, got ${err.status}`);
          assert.equal(err.code, 'WRITES_DISABLED', `${what} should refuse with WRITES_DISABLED, got ${err.code}`);
          assert.match(err.message, /VIEW_BUILDER_ENABLED/, `${what}'s refusal must name the switch to set`);
        }

        // ── ★ AND THE CONTROL ON THE OTHER SIDE OF THE BOUNDARY: A READ.
        //      `GET /api/views` is deliberately NOT gated, and the route says so in
        //      its own description — "A READ, SO IT ANSWERS WITH THE GATE OFF"
        //      (`server/src/routes/views.ts`) — because what is already stored is
        //      readable either way, and a surface that died with an authoring flag
        //      would read as broken rather than as switched off.
        //
        //      This was written as a THIRD 409 case and failed with `Cannot read
        //      properties of undefined (reading 'code')`: the 200 body carries no
        //      `error` envelope for `refusal()` to read a code out of. That is how a
        //      documented behaviour gets mistaken for a defect — the assertion was
        //      wrong, not the route. Pinning the 200 here is what stops somebody
        //      "fixing" the read into a 409 later, which would be a real regression.
        const list = await get('/api/views');
        assert.equal(list.status, 200, `the read must still be served with the gate off, got ${list.status}`);
        const listed = (await list.json()) as { data: unknown[] };
        assert.ok(Array.isArray(listed.data), 'the read must still answer with its rows');
      } finally {
        vb.enabled = true;
      }
    });

    // ---- The guard, exercised directly (no database involved) -------------

    await check('V3: FETCH FIRST is refused, and the refusal names the port', async () => {
      const sql = 'SELECT 1 AS one FROM GL_CODE_COMBINATIONS FETCH FIRST 1 ROW ONLY';
      const analysis = viewGuard.analyzeSql(sql);
      assert.ok(analysis.rejection, 'FETCH FIRST must be refused before the database sees it');
      assert.equal(analysis.rejection.code, 'ORACLE_DIALECT');
      assert.match(analysis.rejection.message, /FETCH FIRST/);
      assert.match(String(analysis.rejection.details.fix), /LIMIT/, 'the refusal must name `LIMIT n`, not just the problem');

      // The same statement on a real Oracle target is *correct SQL*, so the lint
      // must not fire — a warning on correct SQL is how a lint teaches people to
      // ignore it.
      const onOracle = viewGuard.analyzeSql(sql, 'oracle');
      assert.equal(onOracle.rejection, null, 'the SQLite dialect lint must not fire against an Oracle target');
      assert.deepEqual(onOracle.findings, [], 'and it must not warn either');
    });

    await check('V4: TRUNC(SYSDATE) is warned about rather than silently trusted', async () => {
      const analysis = viewGuard.analyzeSql('SELECT TRUNC(SYSDATE) AS today FROM DUAL');
      assert.equal(analysis.rejection, null, 'it is a warning: the statement is still allowed to run');
      const finding = analysis.findings.find((f) => f.code === 'TRUNC_SYSDATE');
      assert.ok(finding, 'TRUNC(SYSDATE) must produce the TRUNC_SYSDATE finding');
      assert.equal(finding.severity, 'warning');
      assert.match(finding.message, /NULL/, 'the finding has to say why it is a trap, not just that it is one');
      assert.match(String(finding.fix), /date\('now'\)/);
      assert.ok(
        !analysis.findings.some((f) => f.code === 'SYSDATE'),
        'TRUNC(SYSDATE) matches two rules; the generic SYSDATE one must collapse into the specific one',
      );
    });

    await check('V5: a smuggled second statement is refused, and the schema is untouched', async () => {
      const objectCount = async (): Promise<number> =>
        Number(
          (
            await rows<{ n: number }>(
              "SELECT COUNT(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
            )
          )[0]?.n ?? 0,
        );
      const before = await objectCount();

      const err = await refusal(await previewSql('SELECT 1 AS one; DROP TABLE PO_LINE_TYPES'));
      assert.equal(err.status, 400, `a second statement must be refused, got ${err.status}`);
      assert.equal(err.details.code, 'MULTIPLE_STATEMENTS');
      assert.equal(err.details.semicolonsOutsideLiterals, 1);
      assert.match(err.message, /`;`/, 'the refusal must name the character that caused it');

      // The refusal is the gate; this is the proof that the gate is not merely
      // cosmetic. libSQL would silently discard everything after the first `;`,
      // so without the refusal a smuggled statement reads as "ignored" — and
      // "ignored" is indistinguishable from "worked" to the person who wrote it.
      assert.equal(await objectCount(), before, 'the schema changed, so the second statement ran');
    });

    await check('V6: ATTACH is refused by the allowlist', async () => {
      const err = await refusal(await previewSql("ATTACH DATABASE ':memory:' AS x"));
      assert.equal(err.status, 400);
      assert.equal(err.details.code, 'DENIED_KEYWORD');
      assert.equal(err.details.keyword, 'ATTACH');
      assert.match(err.message, /ATTACH/);
    });

    await check('V7: INSERT is refused, and no row was written', async () => {
      const err = await refusal(
        await previewSql("INSERT INTO saved_view (slug, title, sql) VALUES ('x', 'x', 'SELECT 1')"),
      );
      assert.equal(err.status, 400);
      assert.equal(err.details.code, 'DENIED_KEYWORD');
      assert.equal(err.details.keyword, 'INSERT');

      if (vbSample) {
        const written = await countOf("SELECT COUNT(*) AS n FROM saved_view WHERE slug = 'x'");
        assert.equal(written, 0, 'the refused INSERT wrote a row');
      }
    });

    await check('V14: an undeclared :token is refused by name', async () => {
      const err = await refusal(await previewSql('SELECT 1 AS one WHERE 1 = :period'));
      assert.equal(err.status, 400);
      assert.equal(err.details.code, 'UNDECLARED_PARAM');
      assert.equal(err.details.token, 'period');
      assert.match(err.message, /:period/, 'the message must name the token, not a placeholder index');
    });

    await check('V14b: a parameter with no value and no default is refused before the query runs', async () => {
      const err = await refusal(
        await preview({ sql: 'SELECT :period AS p', params: [{ name: 'period', type: 'text' }] }),
      );
      assert.equal(err.status, 400);
      assert.equal(err.details.code, 'MISSING_PARAM_VALUE');
      assert.match(err.message, /:period/);
    });

    // ---- The gates that need a database to run a statement against --------

    if (!vbSample) {
      console.log('  (V1, V2, V8–V13 name sample tables; skipped on this target)\n');
    } else {
      await check('V1: SELECT 1 returns one row, one column, and says it was not cut', async () => {
        const data = await previewData(await previewSql('SELECT 1 AS one'));
        assert.deepEqual(data.result.columns.map((c) => c.key), ['one']);
        assert.deepEqual(data.result.rows, [[1]]);
        assert.equal(data.result.rowCount, 1);
        assert.equal(data.result.limit, vbSaved.maxRows);
        assert.equal(data.result.truncated, false);
        assert.deepEqual(data.result.drift, []);
      });

      await check('V2: a syntax error is a 400 quoting the driver, never a 500', async () => {
        const res = await previewSql('SELECT FROM WHERE ((');
        const err = await refusal(res);
        assert.equal(err.status, 400, `the caller's syntax is the caller's problem, got ${err.status}`);
        assert.equal(err.code, 'BAD_REQUEST');
        // ★ The driver's own text, not a paraphrase. `near "FROM": syntax error` is
        //   the whole diagnostic, and a tidied message is one the author has to map
        //   back onto their own SQL.
        assert.match(String(err.message), /syntax error/i, `the driver's message must pass through verbatim`);
        assert.equal(err.details.statement, 'SELECT FROM WHERE ((');
        assert.ok(
          'hint' in err.details,
          "the message is the driver's; the server's own commentary has to go alongside it rather than instead",
        );
      });

      await check('V8/V9: a trailing comment and a trailing semicolon both still run', async () => {
        // V8 — `wrapForRowCap` appends `\n) LIMIT n`, and the trailing newline is
        // what stops the wrapper landing inside a line comment.
        const comment = await previewData(
          await previewSql('SELECT 1 AS one  -- unfiltered, deliberately'),
        );
        assert.equal(comment.result.rowCount, 1, 'the row-cap wrapper was swallowed by the trailing comment');

        // V9 — one trailing `;` is punctuation.
        const semi = await previewData(await previewSql('SELECT 1 AS one;'));
        assert.deepEqual(semi.result.rows, [[1]]);

        // …and a `;` inside a literal is not a statement separator. Getting this
        // wrong cuts the string in half and hands the driver an invalid statement,
        // which is the failure `trimStatement` exists to avoid.
        const literal = await previewData(await previewSql("SELECT ';' AS semi"));
        assert.deepEqual(literal.result.rows, [[';']]);
        const both = await previewData(await previewSql("SELECT ';' AS semi;"));
        assert.deepEqual(both.result.rows, [[';']]);
      });

      await check('V10: an unbounded SELECT * is capped, and the response admits it', async () => {
        vb.maxRows = 5;
        try {
          const data = await previewData(await previewSql('SELECT * FROM GL_BALANCES'));
          assert.equal(data.result.limit, 5);
          assert.equal(data.result.rows.length, 5, 'the cap is 5, so exactly 5 rows come back');
          assert.equal(data.result.rowCount, 5);
          assert.equal(
            data.result.truncated,
            true,
            'GL_BALANCES holds 31 rows, so the cap cut the result and the response has to say so',
          );
          assert.ok(data.result.columns.length > 0, 'a capped result still has columns');
        } finally {
          vb.maxRows = vbSaved.maxRows;
        }
      });

      await check('V13: a declared column the query no longer returns is a notice, not an empty table', async () => {
        const data = await previewData(
          await preview({
            sql: 'SELECT 1 AS one',
            display: {
              columns: [
                { key: 'one', label: 'One', format: 'num' },
                { key: 'net_amount', label: 'Net', format: 'money' },
              ],
            },
          }),
        );
        assert.deepEqual(data.result.columns.map((c) => c.key), ['one'], 'the column that exists must still render');
        assert.equal(data.result.drift.length, 1, 'the column that is gone must be reported');
        assert.equal(data.result.drift[0]?.key, 'net_amount');
        assert.equal(
          data.result.drift[0]?.message,
          '`net_amount` is hidden because the query no longer returns it.',
          'the plan’s exact sentence: what happened, to which column, and the consequence',
        );
        assert.equal(data.result.rowCount, 1, 'drift must not stop the result rendering');
      });

      await check('V13b: a column with no declared format defaults to text, not money', async () => {
        // §7: the default for a nullable money column is `text`, because a null that
        // renders as `$0` is a wrong number rather than a missing one.
        const data = await previewData(await previewSql('SELECT 1 AS net_amount'));
        assert.equal(data.result.columns[0]?.format, 'text');
        assert.equal(data.result.columns[0]?.hidden, false);
      });

      await check('V14c: a value is bound, never substituted', async () => {
        const hostile = "2026-01' OR '1'='1";
        const data = await previewData(
          await preview({
            sql: 'SELECT :period AS p',
            params: [{ name: 'period', type: 'text' }],
            values: { period: hostile },
          }),
        );
        assert.deepEqual(
          data.result.rows,
          [[hostile]],
          'the value came back as data — so it was bound. Had it been substituted, this is the assertion that would change shape.',
        );
        assert.deepEqual(data.appliedValues, { period: hostile }, 'the value actually used is reported');
      });

      await check('V14d: a declared parameter the SQL does not use is a warning, not an error', async () => {
        const data = await previewData(
          await preview({
            sql: 'SELECT 1 AS one',
            params: [{ name: 'unused', type: 'text', default: 'x' }],
          }),
        );
        assert.equal(data.result.findings.filter((f) => f.code === 'UNUSED_PARAM').length, 1);
        assert.equal(data.result.rowCount, 1, 'a stale declaration must not stop the query from running');
      });

      // ★ THE MECHANISM V12 ASSERTS IS A PRAGMA, AND A PRAGMA IS A STATEMENT THE
      //   SERVER MAY REFUSE. `PRAGMA query_only` narrows the virtual machine that
      //   executes a statement, which is a thing the *local file driver* has and a
      //   remote libSQL endpoint does not: the server owns the connection and answers
      //   `SQL_PARSE_ERROR: SQL not allowed statement: PRAGMA query_only = ON`.
      //   Nothing about layer 4 changes over that transport — the property is simply
      //   not expressible there — so the check is skipped **by name, with the driver's
      //   own words**, rather than left to fail as though the application were wrong.
      //
      //   The capability is *probed* rather than inferred from the mode's name: a
      //   future transport that does accept the pragma runs the check in full, and one
      //   that stops accepting it says so on the line instead of counting as a pass.
      const queryOnlyRefusal = await (async (): Promise<string | null> => {
        try {
          await execute('PRAGMA query_only = ON', []);
        } catch (e: unknown) {
          return e instanceof Error ? e.message : String(e);
        }
        // Lifting it is not optional: a target that took the pragma and would not
        // clear it would poison every write after this line, so this is left to throw.
        await execute('PRAGMA query_only = OFF', []);
        return null;
      })();

      const v12 = 'V12: query_only refuses a write even where writes are enabled';

      if (!dbStatus().writable) {
        skip(v12, 'this target is not writable, so there is no write for query_only to refuse');
      } else if (queryOnlyRefusal !== null) {
        skip(v12, `this target does not accept the pragma: ${queryOnlyRefusal}`);
      } else {
        await check(v12, async () => {
          await execute('PRAGMA query_only = ON', []);
          try {
            await assert.rejects(
              () =>
                execute(
                  "INSERT INTO saved_view (slug, title, sql) VALUES ('query-only-probe', 'probe', 'SELECT 1')",
                  [],
                ),
              /attempt to write a readonly database/,
              'query_only must refuse a write on a database where writes are otherwise allowed, or layer 4 is not a layer',
            );
          } finally {
            await execute('PRAGMA query_only = OFF', []);
          }

          // It was not a trick of the pragma having stuck: the same insert works
          // once it is off, and the row is removed again.
          const probe = await execute(
            "INSERT INTO saved_view (slug, title, sql) VALUES ('query-only-probe', 'probe', 'SELECT 1')",
            [],
          );
          assert.equal(probe.rowsAffected, 1, 'writes must work again after the pragma is cleared');
          await execute("DELETE FROM saved_view WHERE slug = 'query-only-probe'", []);

          // ★ THE HOLE IN LAYER 4, KEPT AS A MEASUREMENT RATHER THAN A CLAIM. A
          //   comment in `views.ts` says `query_only` does not block `ATTACH`; this
          //   is where that stays true. If a future release closes the hole, this
          //   check fails and the comment gets corrected — which is the point.
          let attached = false;
          await execute('PRAGMA query_only = ON', []);
          try {
            try {
              await execute("ATTACH DATABASE ':memory:' AS vb_probe", []);
              attached = true;
            } catch {
              /* the behaviour the comment describes has changed */
            }
            assert.equal(
              attached,
              true,
              'query_only now blocks ATTACH — good news, and the layer-4 comment in routes/views.ts is now understated',
            );
          } finally {
            if (attached) await execute('DETACH DATABASE vb_probe', []);
            await execute('PRAGMA query_only = OFF', []);
          }
        });
      }

      // ★ V11 DOES NOT PASS THE WAY THE PLAN WRITES IT, AND THIS SECTION SAYS SO
      //   RATHER THAN MEASURING SOMETHING ELSE AND CALLING IT A PASS.
      //
      //   §13 V11 asks that a pathological join "times out clearly and the process
      //   is still alive". The mechanism the plan prescribes for the timeout is
      //   `Promise.race` against a `setTimeout` (§5.3). That is implemented
      //   (`withTimeout`), and it works — for a driver that yields while it waits.
      //
      //   The `local` file driver does not. It runs the statement inside a
      //   synchronous native call, so it holds the event loop for the statement's
      //   whole duration and the timer's callback cannot run until the statement
      //   has already returned. Measured directly against `@libsql/client` on this
      //   sample: a 250ms timer raced against the 3-way cross join below resolved
      //   `'ran'`, with the timer callback still unrun at 2686ms. The clock was
      //   never consulted, so no budget can preempt it.
      //
      //   What is left to assert is the part that was always the point: the
      //   server does not die, and the same query does not take the process down
      //   with it. The bound itself is proven separately, below, against a clock
      //   the guard can actually see.

      await check('V11a: the timeout mechanism abandons work and reports the budget', async () => {
        // A fixture, and labelled as one: no database is involved, so this asserts
        // the *mechanism* — that the budget produces a `QueryTimeoutError` carrying
        // the duration and the remedy — not a property of any particular driver.
        const never = new Promise<never>(() => {});
        const started = Date.now();
        await assert.rejects(
          () => queryGuard.withTimeout(never, 60, 'The statement did not finish within 60ms. Narrow it.'),
          (e: unknown) => {
            assert.ok(
              e instanceof queryGuard.QueryTimeoutError,
              `expected a QueryTimeoutError, got ${String(e)}`,
            );
            assert.match(e.message, /60ms/, 'the message must carry the budget it blew');
            assert.match(e.message, /Narrow it/, 'and what to do about it');
            return true;
          },
        );
        const wall = Date.now() - started;
        assert.ok(wall >= 55 && wall < 1000, `the budget must be what ended it; it took ${wall}ms`);
      });

      await check('V11b: an abandoned statement cannot take the process down', async () => {
        // ★ The rejection that arrives after the race has already settled. This is
        //   the check for `work.catch(() => {})` in `withTimeout`: with it, the late
        //   rejection is absorbed; without it, Node treats it as unhandled and
        //   aborts — which would fail this suite by killing it, mid-run, rather
        //   than by asserting.
        let rejectLate: ((e: Error) => void) | undefined;
        const slowFailure = new Promise<never>((_resolve, reject) => {
          rejectLate = reject;
        });
        await assert.rejects(() => queryGuard.withTimeout(slowFailure, 40, 'budget'));
        rejectLate?.(new Error('the statement failed long after the request gave up'));
        // Two macrotasks, so the unhandled-rejection detection has had its chance.
        await new Promise((r) => setTimeout(r, 20));
        const alive = await fetch(`${base}/api/docs.json`);
        assert.equal(alive.status, 200, 'a late rejection from an abandoned statement reached the process');
        await alive.text();
      });

      await check(
        'V11c: a pathological join ends the way its transport allows, and the server serves either way',
        async () => {
          // ★ THE ENDING IS A PROPERTY OF THE TRANSPORT, SO THE EXPECTATION IS KEYED ON
          //   THE TRANSPORT. 520³ rows aggregated — this is the statement the plan's
          //   V11 has in mind. Measured against the *file* driver it returns whole (a
          //   synchronous native call cannot be preempted, so no budget can bound it);
          //   measured against the *remote* libSQL endpoint the 250ms budget stops it
          //   and the route refuses with TIMEOUT. Both are correct for their transport,
          //   so a check that demanded only the first failed on the second *for a reason
          //   that is not a defect* — and a check that accepted either would have
          //   stopped being able to notice that the budget had stopped working at all.
          //   Keying on `config.db.filePath` keeps both halves able to fail: the file
          //   driver must still run it whole, and a networked driver must still be cut
          //   short.
          const ledgerIsFile = config.db.filePath !== undefined;
          vb.timeoutMs = 250;
          const started = Date.now();
          let ending: string;
          try {
            const res = await previewSql(
              'SELECT COUNT(1) AS n FROM GL_CODE_COMBINATIONS a, GL_CODE_COMBINATIONS b, GL_CODE_COMBINATIONS c',
            );
            const wall = Date.now() - started;

            if (ledgerIsFile) {
              const data = await previewData(res);
              assert.deepEqual(data.result.columns.map((c) => c.key), ['n']);
              assert.equal(data.result.rows.length, 1);
              assert.ok(
                wall > 250,
                `the 250ms budget DID bound a file-driver statement (it took ${wall}ms) — if that driver has ` +
                  'started yielding and the timeout is bounding after all, update this gate and the note in withTimeout',
              );
              ending = `ran to completion in ${wall}ms — the file driver cannot be preempted`;
            } else {
              const err = await refusal(res);
              assert.equal(
                err.details.code,
                'TIMEOUT',
                `a networked driver must be cut short by the 250ms budget, not answered with ${err.status}: ${err.message}`,
              );
              assert.match(err.message, /250ms/, 'the refusal must name the budget it blew');
              ending = `stopped by the 250ms budget after ${wall}ms — a networked driver yields while it waits`;
            }
          } finally {
            vb.timeoutMs = vbSaved.timeoutMs;
          }

          // Which of the two endings happened is printed: "V11c passed" on its own no
          // longer says whether the budget bit, and a reader needs to know which claim
          // this target made.
          process.stdout.write(`\n      ending: ${ending}\n`);

          // The half of V11 that was always the point: still alive, still answering —
          // including on the remote target, where the abandoned statement may still be
          // running server-side.
          const after = await previewData(await previewSql('SELECT 1 AS one'));
          assert.equal(after.result.rowCount, 1, 'the server did not survive the pathological statement');
        },
      );
    }
  } finally {
    vb.enabled = vbSaved.enabled;
    vb.maxRows = vbSaved.maxRows;
    vb.timeoutMs = vbSaved.timeoutMs;
  }

  // ---- The store registry (plan docs/plans/organizations.md §7, Phase 0) ---
  //
  // Phase 0 separates the app-owned tables from the EBS mirror, and every statement
  // is routed by the allowlist in `db/store.ts`. A wrong registry is the one defect
  // this design cannot see on its own, and it fails in the direction that looks like
  // success: a ledger table sent to the app store returns rows — from a different
  // database — and an app table sent to Oracle raises ORA-00942, which is at least
  // loud. The checks below are the ones the routing cannot make for itself.

  await check('the store registry is internally consistent', async () => {
    assert.deepEqual(checkRegistry(), []);
  });

  await check('every descriptor names a table the registry knows', async () => {
    // ★ THIS IS WHAT MAKES THE FALLBACK IN `routeStatement` SAFE. A statement naming
    //   nothing registered goes to the ledger, and that is only defensible because
    //   no table this codebase names is unregistered. `storeForTable` throws on an
    //   unknown name — so this check is the evidence behind that promise, and it is
    //   also what stops a descriptor from naming a derived view or
    //   `SAMPLE_DATA_PROVENANCE` and quietly being treated as an EBS table.
    const unknown: string[] = [];
    for (const d of registeredResources()) {
      try {
        storeForTable(d.table);
      } catch (e) {
        unknown.push(`${d.name} names ${d.table}: ${e instanceof Error ? e.message.split('.')[0] : String(e)}`);
      }
    }
    assert.deepEqual(unknown, [], unknown.join('; '));
    assert.ok(
      registeredResources().length >= 30,
      `only ${registeredResources().length} resources registered — did a route module stop mounting?`,
    );
  });

  await check('the registry and the app-authored tables agree in both directions', async () => {
    // ★ A THIRD HAND-MAINTAINED LIST OF THE SAME THING, and each is load-bearing in a
    //   different way: `01-app.sql` says which tables exist in the app store,
    //   `APP_TABLES` says which the activity register attributes to this app, and the
    //   registry says where a statement about them is sent. A name added to one and
    //   not the others is silent in every direction — a provenance reported as
    //   "extracted", a table created but never routed to, a route promised and absent.
    //
    //   The APP class holds more than `APP_TABLES`: the three app-authored extract
    //   tables live in `00-schema.sql` because they are shaped like the EBS tables
    //   they report on, and they *look* extracted. They are not, so they are named
    //   here explicitly rather than being left to fall out of a count.
    const schemaDdl = await readFile(sampleSql('00-schema.sql'), 'utf8');
    const authored = [
      ...schemaDdl.matchAll(/^\s*CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:X_REPORT_|SAMPLE_DATA_)[A-Za-z0-9_]*)/gim),
    ].map((m) => (m[1] ?? '').toLowerCase());
    assert.ok(
      authored.length >= 3,
      `expected the app-authored extract tables in 00-schema.sql, found ${authored.join(', ') || 'none'}`,
    );

    const expected = [...new Set([...APP_TABLES, ...authored])].map((n) => n.toUpperCase()).sort();
    assert.deepEqual(
      tablesOfClass('APP'),
      expected,
      'the APP class in db/store.ts and the app-authored DDL are different sets',
    );
    for (const name of expected) {
      assert.equal(storeForTable(name), 'app', `${name} is app-authored and must never be read from Oracle`);
    }

    // And the other direction: nothing that *is* EBS may be classed APP, or the
    // mirror would shadow the ledger for a real EBS table.
    for (const name of tablesOfClass('EBS')) {
      assert.equal(
        classOfTable(name),
        'EBS',
        `${name} is both EBS and something else — a class can only be one`,
      );
      assert.equal(storeForTable(name), 'ledger', `${name} is an EBS name and must route to the ledger`);
    }
  });

  await check('no column name collides with a registered table name', async () => {
    // ★ THE COST OF ROUTING LEXICALLY. `tablesIn` scans a masked statement for whole
    //   words, so a *column* named exactly like a registered table would route the
    //   statement to that table's store — `SELECT project FROM GL_JE_LINES` would be
    //   read as "names the app's `project` table" and a mixed statement would then be
    //   refused for no reason, or answered from the wrong database. Nothing in the
    //   sample collides today; this is the check that keeps it that way, and it is
    //   cheap because it only has to run when a schema changes.
    const columns = await rows<{ tbl: string; col: string }>(
      `SELECT m.name AS tbl, p.name AS col
         FROM sqlite_master m
         JOIN pragma_table_info(m.name) p
        WHERE m.type IN ('table', 'view')`,
    );
    assert.ok(columns.length > 100, `only ${columns.length} columns read — is the schema reachable?`);
    const collisions = columns
      .filter((c) => classOfTable(c.col) !== null)
      .map((c) => `${c.tbl}.${c.col}`);
    assert.deepEqual(
      collisions,
      [],
      `these columns are named after a registered table, so a statement selecting one would be routed by it: ${collisions.join(', ')}`,
    );
  });

  await check('a statement is routed by the tables it names', async () => {
    const at = (sql: string) => routeStatement(sql);

    assert.deepEqual(at('SELECT * FROM GL_BALANCES').stores, ['ledger']);
    assert.deepEqual(at('SELECT COUNT(*) FROM saved_view').stores, ['app']);
    const mixed = at('SELECT * FROM GL_BALANCES b JOIN saved_view v ON v.name = b.CURRENCY_CODE');
    assert.deepEqual(mixed.stores, ['ledger', 'app']);
    assert.equal(mixed.mixed, true, 'a statement naming both stores must report itself as mixed');
    // A statement with no table in it — a pragma, a `SELECT 1`, DDL — still has to go
    // somewhere, and the ledger is the primary store.
    assert.equal(at('SELECT 1').store, 'ledger');
    assert.equal(at('SELECT 1').mixed, false);
  });

  await check('the masking keeps quoted identifiers and drops literals and comments', async () => {
    // ★ THE QUOTED-IDENTIFIER REGRESSION. `quoteIdent` quotes every identifier, so
    //   most SQL in this codebase reads `FROM "GL_LEDGERS"`. The masker shared with
    //   the query guard blanks quoted text, which would make each of those statements
    //   appear to name no table at all — and every one of them would then take the
    //   "names nothing registered" route to the ledger. That is the *right* answer
    //   while there is one store, which is exactly why the bug would have survived
    //   Phase 0 unremarked and only shown up the day the stores were separated.
    const names = (sql: string) => tablesIn(sql).map((t) => t.name);
    assert.deepEqual(names('SELECT * FROM "GL_LEDGERS"'), ['GL_LEDGERS']);
    assert.deepEqual(names('SELECT * FROM "saved_view"'), ['SAVED_VIEW']);
    // Lowercase, because Oracle folds unquoted identifiers up and SQLite does not.
    assert.deepEqual(names('select current_date as d from dual'), ['DUAL']);
    // Whole words: `project_id` must not fire the `project` entry.
    assert.deepEqual(names('SELECT project_id FROM GL_JE_LINES'), ['GL_JE_LINES']);

    // ★ THE NEGATIVE CONTROLS. Without these, a PASS cannot be told from a scan that
    //   matches everything it sees, which is the failure mode of a lexical router.
    assert.deepEqual(names("SELECT 'GL_BALANCES' AS literal"), [], 'a string literal is not a table reference');
    assert.deepEqual(names('-- GL_BALANCES\nSELECT 1'), [], 'a comment is not a table reference');
    assert.deepEqual(names('SELECT * FROM TOTALLY_MADE_UP_TABLE'), [], 'an unregistered name is not a table reference');
    assert.equal(
      routeStatement('SELECT FROM WHERE ((').store,
      'ledger',
      'routing is lexical, so an unparseable statement still routes rather than throwing',
    );
    assert.equal(classOfTable('TOTALLY_MADE_UP_TABLE'), null);
    assert.throws(
      () => storeForTable('TOTALLY_MADE_UP_TABLE'),
      /not in the store registry/,
      'an unregistered table must throw rather than guess a store',
    );
  });

  await check('two divergent stores refuse a statement that names both', async () => {
    // ★ THE FAILURE THIS PREVENTS HAS NO ERROR TO CATCH. With one store a mixed
    //   statement is harmless — every routing answer is the same answer. With two it
    //   has no correct answer: sent to the ledger it reads a stale mirror's
    //   `saved_view`, sent to the app store it reads a five-table file's
    //   `GL_BALANCES`. Both return rows. So the driver throws, and this is the check
    //   that the throw exists and is specific.
    const stub = (dialect: 'sqlite' | 'oracle'): SqlDriver =>
      ({
        dialect,
        ping: 'SELECT 1',
        execute: async () => ({ rows: [], rowsAffected: 0, lastInsertRowid: null }),
        close: async () => {},
        prepare: async () => {},
        transaction: async () => {
          throw new Error('unused in this check');
        },
      }) as unknown as SqlDriver;

    const divergent = createRoutedDriver({
      ledger: stub('oracle'),
      app: stub('sqlite'),
      shared: false,
      labels: { ledger: 'the ledger', app: 'the app store' },
      writable: { ledger: false, app: true },
    });

    // The single-store statement goes through, so the refusal below is about this
    // statement rather than about a driver that refuses everything.
    await divergent.execute({ sql: 'SELECT 1 FROM GL_BALANCES', args: [] });
    await divergent.execute({ sql: 'SELECT 1 FROM saved_view', args: [] });

    await assert.rejects(
      () => divergent.execute({ sql: 'SELECT * FROM GL_BALANCES b JOIN saved_view v ON 1=1', args: [] }),
      /cannot be run against two stores/,
    );

    // ★ THE CONTROL ON THE OTHER SIDE: the SAME statement against the SAME two
    //   drivers, with `shared: true`, must be allowed. Without it, a driver that
    //   threw on everything would pass the assertion above.
    const sharedDriver = createRoutedDriver({
      ledger: stub('sqlite'),
      app: stub('sqlite'),
      shared: true,
      labels: { ledger: 'one store', app: 'one store' },
      writable: { ledger: true, app: true },
    });
    await sharedDriver.execute({ sql: 'SELECT * FROM GL_BALANCES b JOIN saved_view v ON 1=1', args: [] });
  });

  await check('a write route exists exactly when the store behind it accepts writes', async () => {
    // ★ THE POINT OF PHASE 0, STATED AS AN EQUIVALENCE. Twenty descriptors declare
    //   `writes`, and every one of them names an EBS table — so under a read-only
    //   ledger those twenty must lose their POST and PATCH routes while the two
    //   app-authored extract tables keep theirs. One process-wide flag cannot express
    //   that, and this is the assertion that catches a regression to one.
    //
    //   Written as ⟺ rather than ⟹ so it is not vacuous in the default configuration:
    //   with one writable store every writable descriptor must HAVE its routes, which
    //   is a real assertion about all twenty.
    const routes = new Set(registeredRoutes());
    const storeWritable = new Map(dbStatus().stores.map((s) => [s.id, s.writable]));
    const wrong: string[] = [];
    let promised = 0;
    let withheld = 0;

    for (const d of registeredResources()) {
      if (d.readOnlyReason !== undefined || d.writes === undefined || d.pk === undefined) continue;
      const store = storeForTable(d.table);
      const expected = storeWritable.get(store) === true;
      const hasCreate = routes.has(`POST ${d.basePath}`);
      const hasUpdate = routes.has(`PATCH ${d.basePath}/{id}`);
      if (expected) {
        promised += 1;
        if (!hasCreate || !hasUpdate) {
          wrong.push(`${d.name} on ${d.table} should be writable (its store is) but has no write route`);
        }
      } else {
        withheld += 1;
        if (hasCreate || hasUpdate) {
          wrong.push(`${d.name} on ${d.table} offers a write route while its ${store} store is read-only`);
        }
      }
    }

    assert.deepEqual(wrong, [], wrong.join('; '));
    assert.ok(
      promised > 0,
      'no descriptor kept its write routes — this check is asserting nothing about the writable direction',
    );
    // Both counts are reported so a run where everything fell to one side is visible
    // rather than inferred from a green tick.
    assert.equal(
      promised + withheld,
      registeredResources().filter((d) => d.writes !== undefined && d.pk !== undefined && d.readOnlyReason === undefined)
        .length,
      'every descriptor that declares writes must be classified',
    );
  });

  // ---- Organizations and sessions (plan docs/plans/organizations.md) ------
  //
  // ★ THIS SECTION IS THE PORT OF A THROWAWAY PROBE, WHICH IS NOW GONE. The four
  //   organization routes and the two auth routes spent a whole session being
  //   exercised by `server/tmp-org-probe.ts`, against a COPY of the sample and
  //   with 44 assertions green. A green run in a file scheduled for deletion
  //   proves nothing about tomorrow, so everything that mattered was moved here,
  //   against the real sample, and only then was the probe deleted — and comparing
  //   the two lists first was worth doing, because the port had lost two claims the
  //   probe made: that the tag array's ORDER is the declared order, and that each
  //   OPERATION carries the tag a reader would look under. Both are asserted below
  //   now. `Spec.paths[path][method].tags` is what makes the second one possible.
  //
  // ★ THIS IS THE FIRST DOMAIN IN THE SUITE THAT NEEDS A SESSION, and the first
  //   in which every route is refused to a caller without one. `send()` hard-codes
  //   its content type and takes no headers, so `authorized()` below exists rather
  //   than a fifth argument being threaded through a helper four other sections
  //   share.
  //
  // ★ AND IT PUTS BACK WHAT IT TAKES. A leftover `smoke-check-…` tenant would be
  //   visible in the Settings screen and, worse, would make the NEXT run fail at
  //   a 409 that the previous run caused — a failure pointing at the wrong line.
  //   Every temporary key is deleted before and after, and the member account with
  //   it. (This suite already writes in the project-registry section for the same
  //   reason and under the same rule; the two rows in `sample.db` that the schema
  //   file does not create came from a *browser* session, not from here.)
  //
  // ★ THE NEGATIVE HALF IS THE POINT. This domain's entire content is who may ask
  //   and what a value may be, and every one of those rules lives in a handler
  //   that a happy-path check cannot see. Fund `00`, a duplicated program, a
  //   fiscal year with no period behind it, a member holding a perfectly valid
  //   session: all four are asserted to be REFUSED, in the refusal's own words.

  const SESSION_HEADER = 'x-app-session';

  /** A request that can carry a session. `send()` cannot — it takes no headers. */
  const authorized = async (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    options: { token?: string; body?: unknown } = {},
  ): Promise<Response> => {
    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.token !== undefined) headers[SESSION_HEADER] = options.token;
    return fetch(`${base}${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
  };

  interface OrgWire {
    id: number;
    slug: string;
    name: string;
    fund: string;
    programs: string[];
    startFy: number;
    isDefault: boolean;
    scopeLabel: string;
    createdAt: string;
    updatedAt: string;
  }

  interface SignedIn {
    token: string;
    user: {
      name: string;
      email: string;
      role: string;
      organizationId: number;
      organizationName: string;
      organization: { fund: string; programs: string[]; startFy: number };
    };
  }

  const ORG_SLUG = 'smoke-check-organization-temporary';
  const ORG_NAME = 'Smoke Check Organization (temporary)';
  const MEMBER_EMAIL = 'smoke-check-member@example.test';

  const clearOrganization = async (): Promise<void> => {
    await execute('DELETE FROM organization WHERE slug = :slug', { slug: ORG_SLUG });
  };

  const clearMember = async (): Promise<void> => {
    await execute('DELETE FROM app_user WHERE email = :email', { email: MEMBER_EMAIL });
  };

  const defaultOrgId = async (): Promise<number> => {
    const found = await rows<{ id: number }>('SELECT id FROM organization WHERE slug = :slug', {
      slug: 'wake-county',
    });
    const first = found[0];
    assert.ok(
      first !== undefined,
      'the seeded default organization "wake-county" is not in the app store — re-apply data/sql/turso/01-app.sql',
    );
    return first.id;
  };

  const signIn = (email: string, password?: string): Promise<Response> =>
    fetch(`${base}/api/auth/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(password === undefined ? { email } : { email, password }),
    });

  let superToken = '';

  await check('the bootstrap super-admin credential is configured', async () => {
    // ★ A FAILURE, NOT A SKIP, AND THE DISTINCTION IS THE WHOLE POINT OF THIS
    //   FILE. `app_user` ships empty, so the bootstrap pair is the only way to
    //   sign in against the sample; without it every check below would have to be
    //   waived, and a waived check is not a passing one. A suite that reports
    //   green because it tested nothing is the exact failure this harness exists
    //   to make impossible.
    const { email, password } = config.superAdmin;
    assert.ok(
      email !== undefined && password !== undefined,
      'SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must both be set in .env — see server/README.md §3',
    );
  });

  await check('CONTROL: every session-guarded route refuses a caller with no session', async () => {
    // ★ 401, NEVER 403. "I do not know you" and "I know you and the answer is no"
    //   are different instructions, and a caller who is merely signed out must be
    //   sent to sign in rather than told the register is closed to them.
    //
    // ★ THE BODIES BELOW ARE VALID ON PURPOSE, AND THAT IS A FINDING RATHER THAN A
    //   STYLE CHOICE. `api.ts` validates a request's shape *before* the handler
    //   runs, and the handler is where `requireSuperAdmin` lives — so an anonymous
    //   caller sending a malformed body to a guarded route is refused 400 by the
    //   schema, and the guard that was supposed to answer first never runs. This is
    //   a property of the framework rather than of this domain (it holds for
    //   `POST /api/meta/dictionary` too), and it is asserted below rather than
    //   described, so that closing it is a deliberate act: today a guarded route
    //   can still be *probed* for its existence and its schema by anybody.
    for (const [method, path, body] of [
      ['GET', '/api/auth/session', undefined],
      ['GET', '/api/organizations', undefined],
      ['GET', '/api/organizations/options', undefined],
      ['POST', '/api/organizations', { name: ORG_NAME, fund: '04', startFy: 2022 }],
    ] as const) {
      const res = await authorized(method, path, body === undefined ? {} : { body });
      assert.equal(res.status, 401, `${method} ${path} answered ${res.status} without a session`);
      const err = (await res.json()) as { error: { code: string; message: string } };
      assert.equal(err.error.code, 'UNAUTHORIZED', `${method} ${path} refused as ${err.error.code}`);
      assert.ok(err.error.message.trim().length > 0, `${method} ${path} refused without saying anything`);
    }

    // ★ AND THE ORDERING, PINNED. Admission is checked after the request's shape
    //   is, so a malformed anonymous POST is a 400 and not a 401. If this ever
    //   becomes 401 the vulnerability is closed and this check should be inverted
    //   — not deleted.
    const malformed = await authorized('POST', '/api/organizations', { body: {} });
    assert.equal(
      malformed.status,
      400,
      'a malformed anonymous POST is no longer refused by the schema first — if the guard now runs before ' +
        'validation, this assertion is the one to invert (and the anonymous-probe hole to close)',
    );
    const malformedErr = (await malformed.json()) as { error: { code: string } };
    assert.equal(malformedErr.error.code, 'VALIDATION_FAILED');
  });

  await check('a bad password and an unknown address are refused identically', async () => {
    // ★ THE TWO ARE DELIBERATELY INDISTINGUISHABLE. A message that differed would
    //   tell a caller which half of the credential they got right, and the whole
    //   sign-in surface is two fields wide. Asserting the *equality* rather than
    //   each message separately is what protects the property: two individually
    //   sensible messages would pass a check of the other shape.
    const { email, password } = config.superAdmin;
    assert.ok(email !== undefined && password !== undefined, 'no bootstrap account — see the check above');

    const wrongPassword = await signIn(email, `${password}!wrong`);
    const unknownAddress = await signIn('nobody-at-all@example.test');

    assert.equal(wrongPassword.status, 401, `a wrong bootstrap password answered ${wrongPassword.status}`);
    assert.equal(unknownAddress.status, 401, `an unknown address answered ${unknownAddress.status}`);
    const a = (await wrongPassword.json()) as { error: { code: string; message: string } };
    const b = (await unknownAddress.json()) as { error: { code: string; message: string } };
    assert.equal(a.error.code, 'UNAUTHORIZED');
    assert.equal(
      a.error.message,
      b.error.message,
      'the two refusals differ, so a caller can tell which half of the credential was right',
    );
  });

  await check('the bootstrap account signs in as a super admin carrying its tenant', async () => {
    const { email, password } = config.superAdmin;
    assert.ok(email !== undefined && password !== undefined, 'no bootstrap account — see the check above');

    const res = await signIn(email, password);
    assert.equal(res.status, 200, `sign-in returned ${res.status}`);
    const { data } = (await res.json()) as { data: SignedIn };

    superToken = data.token;
    assert.ok(data.token.length > 0, 'the token is empty — there is nothing to send back');
    assert.equal(data.user.role, 'super_admin');
    assert.equal(data.user.email, email.toLowerCase());

    // ★ THE TENANT TRAVELS WITH THE IDENTITY, AND THAT IS A CONFIGURATION RATHER
    //   THAN A PERMISSION. Everything downstream filters the ledger by these three
    //   fields, so a session that resolved an identity but no scope would render
    //   the whole extract and look completely healthy doing it.
    //
    // ★ ★ TWO ASSERTIONS, NOT ONE, BECAUSE A FAILURE HERE HAS TWO CAUSES AND A
    //   BARE DIFF CANNOT TELL THEM APART. The literal seed values are asserted
    //   against the ROW first, with a message that names the sample as the
    //   suspect; only then is the session compared to the row. Written the other
    //   way round — session vs literal, as this check originally was — an edited
    //   sample produces `Expected 'Facilities' to equal 'Wake County Public
    //   Schools'`, which reads like a broken tenant resolver and sends the reader
    //   into `session.ts` after a bug that is not there. It cost exactly that
    //   detour once already.
    //
    //   The sample being pristine is a PRECONDITION THIS SUITE CANNOT ENFORCE.
    //   The default organization is editable on purpose — editing it is how a
    //   reader rescopes the whole application — and `01-app.sql` seeds it with
    //   `INSERT OR IGNORE`, so re-applying the file never resets an edited
    //   default. Hence the message rather than a silent repair.
    //
    // ★ ★ AND EVERY OPERAND CARRIES A MESSAGE, NOT JUST THE FIRST. The paragraph above is
    //   the reason: a bare diff sends the reader into `session.ts` after a bug that is not
    //   there. It did it a second time through `start_fy` — the one field here with no
    //   message — where `Expected values to be strictly equal: 2021 !== 2022` named no
    //   file, no table and no cause, and read as a broken tenant resolver. `start_fy` is
    //   also the field most likely to differ, because it is the one a reader changes on
    //   purpose (editing it is how the whole extract window is rescoped, and the Settings
    //   page writes it through `PATCH /api/organizations/{slug}`). One constant for all
    //   four, so the sites cannot drift apart.
    const SAMPLE_EDITED =
      '— the SAMPLE has been edited, which is permitted and is not a code fault, so this is ' +
      'a statement about the database and not about the code. Restore the row before ' +
      'reading anything else this suite reports about tenants: ' +
      'PATCH /api/organizations/wake-county as a super_admin sending all four fields — ' +
      'name "Wake County Public Schools", fund "04", programs ["861","862","863"], ' +
      'startFy 2022. The route applies each field it is given, so a partial body can ' +
      'leave one behind; `01-app.sql` cannot do this for you, because it seeds the row ' +
      'with INSERT OR IGNORE and is therefore a no-op against an edited default.';
    const shipped = await defaultTenant();
    assert.equal(
      shipped.name,
      'Wake County Public Schools',
      `the default organization in the app store is named "${shipped.name}", not the shipped ` +
        `"Wake County Public Schools" ${SAMPLE_EDITED}`,
    );
    assert.equal(
      shipped.fund,
      '04',
      `the default organization's fund is "${shipped.fund}", not the shipped "04" ` +
        `${SAMPLE_EDITED}`,
    );
    assert.deepEqual(
      shipped.programs,
      ['861', '862', '863'],
      `the default organization's programs are ${JSON.stringify(shipped.programs)}, not the ` +
        `shipped ["861","862","863"] ${SAMPLE_EDITED}`,
    );
    assert.equal(
      shipped.startFy,
      2022,
      `the default organization's start FY is ${shipped.startFy}, not the shipped 2022 — ` +
        `FY${shipped.startFy} opens the extract floor at ${shipped.startFy - 1}-07-01, so ` +
        `every row count and money total this suite reads afterwards is a different window ` +
        `${SAMPLE_EDITED}`,
    );

    assert.equal(
      data.user.organizationName,
      shipped.name,
      'the session did not carry the default organization\u2019s name',
    );
    assert.equal(data.user.organizationId, await defaultOrgId());
    assert.equal(
      data.user.organization.fund,
      shipped.fund,
      'the session did not carry the default organization\u2019s fund',
    );
    assert.deepEqual(
      data.user.organization.programs,
      shipped.programs,
      'the session did not carry the default organization\u2019s programs',
    );
    assert.equal(
      data.user.organization.startFy,
      shipped.startFy,
      'the session did not carry the default organization\u2019s start FY',
    );
  });

  await check('GET /api/auth/session validates a token without minting another', async () => {
    assert.ok(superToken !== '', 'no session — see the bootstrap check above');
    const res = await authorized('GET', '/api/auth/session', { token: superToken });
    assert.equal(res.status, 200, `the session endpoint returned ${res.status}`);
    const { data } = (await res.json()) as { data: { user: SignedIn['user'] } };
    assert.equal(data.user.email, config.superAdmin.email);
    // ★ A VALIDATOR, NOT A REFRESHER. The response omitting the token is the
    //   documented contract (see `SessionPayloadSchema`) and the reason the client
    //   cannot extend a session by asking about it.
    assert.ok(
      !('token' in data),
      'the session endpoint returned a token — it is supposed to be able to validate one, not issue one',
    );
  });

  await check('CONTROL: an unknown session token is refused as not-signed-in', async () => {
    const res = await authorized('GET', '/api/organizations', { token: 'not-a-real-token' });
    assert.equal(res.status, 401, `an invented token answered ${res.status}`);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'UNAUTHORIZED');
  });

  await check('GET /api/organizations lists the register, default last, with no line count', async () => {
    assert.ok(superToken !== '', 'no session — see the bootstrap check above');
    const res = await authorized('GET', '/api/organizations', { token: superToken });
    assert.equal(res.status, 200, `the register returned ${res.status}`);
    // ★ THE COUNTS ARE TYPED OUT, NOT `Record<string, number>`. An index
    //   signature makes every read `number | undefined`, so a field the server
    //   never sent compares as `undefined` and the check fails with a message
    //   about the DATA rather than about the NAME — `counts.totals >= 1` would
    //   report "counts.total is undefined with the seed in place" and send the
    //   reader to the database. Naming the two members turns that typo into a
    //   compile error.
    const { data } = (await res.json()) as {
      data: { items: OrgWire[]; counts: { total: number; programs: number } };
    };

    const seeded = data.items.find((o) => o.slug === 'wake-county');
    assert.ok(seeded, 'the seeded default organization is missing from the register');
    // The seed literals again, and again with the sample named as the suspect —
    // see the ★ ★ note on the bootstrap check above.
    assert.equal(
      seeded.name,
      'Wake County Public Schools',
      `the default organization in the register is named "${seeded.name}" — the SAMPLE has ` +
        'been edited, not the register check broken',
    );
    assert.equal(seeded.fund, '04', 'the default organization\u2019s fund has been changed in the sample');
    assert.deepEqual(
      seeded.programs,
      ['861', '862', '863'],
      'the default organization\u2019s programs have been changed in the sample',
    );
    assert.equal(seeded.isDefault, true, 'the seeded organization is not flagged as the default');
    assert.equal(
      seeded.scopeLabel,
      'Fund 04 · program 861/862/863',
      'scopeLabel is not the slash form the picker uses — the register and the picker would ' +
        'describe the same configuration two different ways',
    );
    assert.ok(seeded.createdAt && seeded.updatedAt, 'a register row came back without provenance');

    // The default sorts last in SQL and is asserted to be last on the wire, since
    // the whole reason for that ordering is that a reader finds it at the top.
    assert.equal(
      data.items[data.items.length - 1]?.slug,
      'wake-county',
      'the default organization is not the last row — OR BY is_default DESC, name no longer holds',
    );

    // ★ ★ THE ROW MUST NOT CARRY A LINE COUNT, AND THIS IS THE CHECK THAT SAYS SO.
    //   The design renders `FY 2025 · 2,782 lines`, but the rule that decides
    //   whether a line is in scope is `inScope()` in `app/src/data/scope.ts`, and
    //   this feature exists to leave exactly ONE implementation of it. A count
    //   computed here would be a second one, over tables that do not even carry
    //   the fund and the program it would need (`PO_LINES_ALL` has neither
    //   column). So the key set is asserted exactly: a `lines` field appearing
    //   here is a regression, not a feature, and it would be a regression that
    //   looked like one.
    assert.deepEqual(
      Object.keys(seeded).sort(),
      ['createdAt', 'fund', 'id', 'isDefault', 'name', 'programs', 'scopeLabel', 'slug', 'startFy', 'updatedAt'],
      'the register row grew a field — see the note in routes/organizations.ts about why a server-side ' +
        'line count would be a second implementation of the scope rule',
    );

    assert.ok(data.counts.total >= 1, `counts.total is ${data.counts.total} with the seed in place`);
    assert.equal(
      typeof data.counts.programs,
      'number',
      'counts.programs is missing — the "selects nothing" tally is part of the contract',
    );
    assert.ok(
      !data.items.some((o) => o.slug === ORG_SLUG),
      `a previous run left "${ORG_SLUG}" behind — the cleanup below did not run`,
    );
  });

  // ★ ★ THE SCOPE CONSTANT MUST STAY DELETED, AND THIS IS THE CHECK THAT SAYS SO.
  //
  //   `SCOPE` (fund `04`, programs `861/862/863`) and `ALL_PROGRAMS` used to be literals in
  //   `app/src/data/scope.ts`, and the control beside the search box drew its chips from them. The
  //   organization row is the authority for the scope now — it is what the Settings page edits — so a
  //   constant reappearing here is not a style regression: it is a second answer to "what is in
  //   scope", and the app would go on rendering the bundle's configuration while the reader was
  //   editing their own.
  //
  //   The source is read as TEXT and comments are stripped first, because the file deliberately
  //   *describes* what it no longer contains — a tombstone comment naming `SCOPE` is documentation,
  //   not a reintroduction, and the tombstone is the point.
  //
  //   ★ TWO CONTROLS, because a check that only asserts absence cannot be told from a check that
  //     matched nothing: the stripped text is asserted to still contain `export function inScope`
  //     (so the strip did not eat the file), and the strip itself is asserted to have removed the
  //     block comment that mentions `export const SCOPE` (so the strip actually ran).
  await check('app/src/data/scope.ts holds no scope constant — the organization row owns the rule', async () => {
    const source = await readFile(new URL('../../../app/src/data/scope.ts', import.meta.url), 'utf8');

    const decls = [...source.matchAll(/^\s*export\s+(?:const|function|interface|type|let)\s+(\w+)/gim)].map(
      (m) => m[1],
    );
    assert.ok(
      decls.includes('inScope'),
      `app/src/data/scope.ts exports [${decls.join(', ')}] — it no longer exports \`inScope\`, so ` +
        'this check is reading the wrong file or the rule has moved, and the assertions below would ' +
        'be about nothing',
    );

    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');

    assert.ok(
      !code.includes('export const SCOPE') && !code.includes('ALL_IN_SCOPE'),
      'a scope CONSTANT has been reintroduced into app/src/data/scope.ts. If this check starts ' +
        'passing again it means the organization has stopped being the authority for the scope: the ' +
        'module is meant to be a library of pure functions over a `Scope` it does not own, and the ' +
        'panel beside the search box is meant to render the tenant. Delete the constant and read the ' +
        'row — session.organization, or GET /api/organizations.',
    );

    assert.ok(
      !/ALL_PROGRAMS\s*(?::|=)/.test(code) && !code.includes('knownProgram'),
      '`ALL_PROGRAMS` or `knownProgram` is back in app/src/data/scope.ts. The universe a chip is ' +
        'drawn from is the organization\'s own `programs` list and `clampToHoldings` answers "is this ' +
        'program ours?" by its effect; a second way to ask either question is a second answer ' +
        'waiting to disagree with the first.',
    );

    assert.ok(
      !code.includes('isAuthoredScope') && !code.includes('scopeIsAuthored'),
      '`isAuthoredScope` / `scopeIsAuthored` is back. "Authored" was a comparison against a literal; ' +
        'the two questions it stood in for are now separate and both are named — `isFullScope(scope, ' +
        'holdings)` for configuration ("is this everything the tenant holds?", which is what makes ' +
        'Reset idle) and `scopeStats.excluded === 0` for the measurement ("is it removing anything?").',
    );
  });

  // ═════════════════════════════════════════════════════════════════════════════
  //  The checks register's assistant
  // ═════════════════════════════════════════════════════════════════════════════
  //
  //  The design deliberately splits the work: the model chooses *which* reduction to
  //  perform and the **server** performs it, over the caller's own tenant scope.
  //  Nearly everything that can therefore go wrong is either scope or arithmetic, and
  //  neither needs a provider to test — which is why `ai/scope.ts`, `ai/run.ts` and
  //  `ai/intent.ts` take no I/O, and why the first four checks below cannot be
  //  skipped. Only the last three reach a model, and they say so when they cannot run.
  //
  //  ★ THE TWO POPULATIONS ARE 23× APART AND BOTH ARE CORRECT ANSWERS. "What was the
  //    highest check paid in July?" is $778,481.55 over the Fund 04 / program
  //    861-863 register and $18,043,056.47 over every row of the same file. A text box
  //    cannot carry which one the reader meant, so the scope is applied server-side
  //    from the session — and the gate below asserts the two figures *differ* rather
  //    than merely checking that something came back. A figure is real money either
  //    way, which is what makes the wrong-population failure so quiet.

  /** One row of the assistant's `rows.sample`. */
  interface AssistantSample {
    id: number;
    number: string;
    date: string;
    amount: number;
    vendor: string;
  }

  /**
   * The basis, given a **real member list** rather than an index signature.
   *
   * ★ `Record<string, number>` would make every read `number | undefined`, so a field
   *   the server never sent would compare as `undefined` — and `undefined > 0` is
   *   `false`, so the check would fail with a message about the data instead of a
   *   compile error about the name.
   */
  interface AssistantBasis {
    considered: number;
    inScope: number;
    total: number;
    withoutAccounts: number;
    excluded: number;
    scope: { fund: string; programs: string[] };
    window: { from: string; to: string };
    source: string;
    filters: string[];
    message: string;
  }

  interface AssistantAnswer {
    kind: 'answer' | 'refused';
    question: string;
    refused: { reason: string; answerable: string[] } | null;
    intent: {
      subject: string;
      aggregate: string;
      dateFrom: string | null;
      dateTo: string | null;
      vendor: string | null;
      checkNumber: string | null;
      amountMin: number | null;
      amountMax: number | null;
      limit: number;
    } | null;
    unit: 'money' | 'count' | null;
    value: number | null;
    rows: { matched: number; sample: AssistantSample[] };
    basis: AssistantBasis | null;
    model: { name: string; ms: number; attempts: number; maxTokens: number; note: string | null } | null;
  }

  // The register's scope, read from the same place the session reads it — the row
  // with `is_default = 1`, held to exactly one row by the partial unique index.
  const tenant = await defaultTenant();
  const registerScope = { fund: tenant.fund, programs: [...tenant.programs] };

  const JULY_FROM = '2026-07-01';
  const JULY_TO = '2026-07-31';

  await check("the assistant's scope rule agrees with the register's", async () => {
    // ★ `server/src/ai/scope.ts` CARRIES A SECOND COPY OF THIS PREDICATE, and the
    //   file's own header names this check as the thing that keeps the two honest —
    //   because a comment asking two implementations to agree does nothing at all.
    //
    //   One module is an ESM server bundle and the other a Vite client bundle, so
    //   neither imports the other at build time. The smoke process, however, runs
    //   under `tsx`, which *can* load the app's TypeScript — so the comparison is made
    //   against the real module rather than against a regex over its source. A regex
    //   would agree with any rule that merely looked like the right one.
    //
    //   The URL is computed rather than written as a literal so `tsc -b` does not try
    //   to pull `app/` into the server build (`rootDir: src`).
    const clientUrl = new URL('../../../app/src/data/scope.ts', import.meta.url).href;
    const client = (await import(clientUrl)) as {
      inScope?: (scope: { fund: string; programs: string[] }, fund: string, program: string) => boolean;
    };

    // ★ THE FIRST CONTROL: without it, twelve comparisons of `undefined` with
    //   `undefined` would read as twelve agreements.
    assert.equal(
      typeof client.inScope,
      'function',
      `importing app/src/data/scope.ts yielded no \`inScope\` (got ${typeof client.inScope}). Either the rule ` +
        'has moved, or this check is reading a different module — and every comparison below would then be ' +
        'between nothing and nothing, which agrees.',
    );

    const cases: { why: string; scope: { fund: string; programs: string[] }; fund: string; program: string }[] = [
      { why: 'a listed program', scope: { fund: '04', programs: ['861', '862', '863'] }, fund: '04', program: '862' },
      { why: 'an unlisted program', scope: { fund: '04', programs: ['861', '862', '863'] }, fund: '04', program: '999' },
      { why: 'a row carrying no program at all', scope: { fund: '04', programs: ['861'] }, fund: '04', program: '' },
      { why: 'the wrong fund', scope: { fund: '04', programs: ['861', '862', '863'] }, fund: '05', program: '862' },
      { why: 'a prefix is not a member', scope: { fund: '04', programs: ['861'] }, fund: '04', program: '8612' },
      // ★ THE EMPTY PROGRAM LIST — the case the two are most likely to disagree about.
      //   The popover can write it ("Clear programs") and it means *the fund alone is
      //   the rule*, not "no programs", which would tell a reader who had narrowed to
      //   a fund and stopped that there is nothing to show.
      { why: 'EMPTY PROGRAMS — the fund alone is the rule', scope: { fund: '04', programs: [] }, fund: '04', program: '999' },
      { why: 'empty programs, wrong fund', scope: { fund: '04', programs: [] }, fund: '05', program: '862' },
      { why: 'a list of blanks is an empty list', scope: { fund: '04', programs: [''] }, fund: '04', program: '999' },
      // A blank fund fails closed on both sides: a row that does not say what fund it
      // is in is not a row this scope has any business claiming.
      { why: 'a blank fund fails closed', scope: { fund: '', programs: ['861'] }, fund: '', program: '861' },
      { why: 'a whitespace-only fund fails closed', scope: { fund: '   ', programs: ['861'] }, fund: '861', program: '861' },
      { why: 'the scope is trimmed', scope: { fund: ' 04 ', programs: [' 861 '] }, fund: '04', program: '861' },
      { why: 'the arguments are trimmed', scope: { fund: '04', programs: ['861'] }, fund: ' 04 ', program: ' 861 ' },
    ];

    const disagreements = cases
      .map((c) => {
        const appSays = client.inScope?.(c.scope, c.fund, c.program);
        const serverSays = assistantInScope(c.scope, c.fund, c.program);
        return appSays === serverSays
          ? null
          : `${c.why}: app/src/data/scope.ts says ${String(appSays)}, server/src/ai/scope.ts says ${String(serverSays)}`;
      })
      .filter((line): line is string => line !== null);

    assert.deepEqual(
      disagreements,
      [],
      'the assistant and the register disagree about what is in scope. They are two implementations of one ' +
        'rule — `inScope` in app/src/data/scope.ts and in server/src/ai/scope.ts — and an answer computed ' +
        'over a population the register would never show is wrong in the way that is hardest to notice, ' +
        'because the figure is real money either way. Fix the file that has drifted, not this check.',
    );

    // ★ THE SECOND CONTROL: A COMPARISON THAT CANNOT SEE A DIFFERENCE IS NOT A
    //   COMPARISON. This is the same rule with its empty-program clause deleted — a
    //   genuinely different rule — so it must disagree with the register at least
    //   once. If the case table above ever stopped containing the empty list, it
    //   would not, and this notices.
    const withoutTheEmptyClause = (scope: { fund: string; programs: string[] }, fund: string, program: string): boolean => {
      const wantedFund = String(scope.fund ?? '').trim();
      if (wantedFund === '') return false;
      if (String(fund ?? '').trim() !== wantedFund) return false;
      const wanted = (scope.programs ?? []).map((p) => String(p).trim()).filter(Boolean);
      return wanted.includes(String(program ?? '').trim());
    };

    const missed = cases.filter(
      (c) => withoutTheEmptyClause(c.scope, c.fund, c.program) !== client.inScope?.(c.scope, c.fund, c.program),
    );
    assert.ok(
      missed.length > 0,
      'a copy of the rule with its empty-program clause removed agrees with the register on every case in ' +
        'this table, so the table has stopped exercising the one clause that is easy to get wrong and this ' +
        'check would pass straight over a real divergence.',
    );
  });

  await check("the assistant answers over the register's population, not the file's", async () => {
    const population = assistantNarrow(registerScope);

    assert.deepEqual(
      { fund: population.scope.fund, programs: [...population.scope.programs] },
      registerScope,
      'the narrowed population did not keep the scope it was narrowed by, so an answer could not state its ' +
        'own basis — and a reader with no basis cannot tell which population a figure came from.',
    );

    // The counts a disclosure is built from. Each is read off the extract here rather
    // than restated from a control, because the control cannot make a value absent
    // from the source — only from the screen.
    assert.equal(population.read, 4218, `the extract holds ${population.read} checks, not 4,218`);
    assert.equal(
      population.rows.length,
      65,
      `the register's scope selects ${population.rows.length} of ${population.read} checks, not 65`,
    );
    assert.equal(
      population.withoutAccounts,
      4153,
      `${population.withoutAccounts} checks carry no account row, not 4,153. This is the count that explains ` +
        'why a scope join can drop most of a file: a check with no account segments cannot be placed in any ' +
        'fund or program, so it is outside every scope rather than inside this one.',
    );
    assert.equal(
      population.excluded,
      0,
      `${population.excluded} in-scope checks carry an account outside the scope. On this slice that is 0 ` +
        'by coincidence — all 65 account-carrying checks happen to be Fund 04 — so a non-zero value is not ' +
        'a bug on its own; it means the slice has changed and the two counts above should be re-read.',
    );
    assert.equal(population.window.from, JULY_FROM, `the extract's window starts ${population.window.from}`);
    assert.ok(
      population.window.from <= JULY_FROM && population.window.to >= JULY_TO,
      `the extract's window is ${population.window.from} .. ${population.window.to}, which does not cover July ` +
        '2026. Every July figure below would then be a maximum over an empty set — and `Math.max()` of nothing ' +
        'is `-Infinity`, which compares as "different" and would pass for the worst possible reason.',
    );

    // ---- The whole window, in scope, and the raw file, unscoped ------------------
    const wholeWindow = assistantRun(population, 'max', {}, 1);
    assert.equal(
      wholeWindow.value,
      2068881.16,
      `the highest check in the register's scope is ${String(wholeWindow.value)}, not 2,068,881.16`,
    );
    assert.equal(wholeWindow.rows[0]?.number, '44407395', `the highest check in scope is ${wholeWindow.rows[0]?.number}`);

    // ★ THE OTHER POPULATION, MEASURED FROM THE FILE RATHER THAN FROM THE MODULE UNDER
    //   TEST. Comparing the assistant's July maximum with the raw file's is the only
    //   way to prove the scope is narrowing anything at all — and the message says
    //   what it means if the two ever agree, because a negative assertion that starts
    //   passing is silent otherwise.
    const raw = JSON.parse(await readFile(new URL('../../../data/oracle/checks.json', import.meta.url), 'utf8')) as {
      body?: { ResultSets?: { Table1?: Record<string, unknown>[] } };
    };
    const all = (raw.body?.ResultSets?.Table1 ?? []).map((r) => ({
      number: String(r.CHECK_NUMBER ?? '').trim(),
      date: String(r.CHECK_DATE ?? '').slice(0, 10),
      amount: Number(r.AMOUNT),
    }));
    assert.equal(
      all.length,
      population.read,
      `reading checks.json directly found ${all.length} rows while ai/scope.ts read ${population.read}. The ` +
        'two must agree, or one of them is reading a different file and the comparison below is between ' +
        'two unrelated sets.',
    );
    assert.ok(
      all.every((c) => Number.isFinite(c.amount)),
      'a row in checks.json has an amount that is not a finite number, so a maximum over these rows would ' +
        'be NaN and every comparison against it would be false.',
    );

    const unscopedJuly = all.filter((c) => c.date >= JULY_FROM && c.date <= JULY_TO);
    const unscopedMax = Math.max(...unscopedJuly.map((c) => c.amount));

    const july = assistantRun(population, 'max', { dateFrom: JULY_FROM, dateTo: JULY_TO }, 1);
    assert.equal(
      july.matched,
      22,
      `${july.matched} checks in scope fall in July 2026, not 22. This is the number the disclosure says ` +
        'out loud ("22 of 4,218"), so it is also the number a reader would use to sanity-check the answer.',
    );
    assert.equal(july.value, 778481.55, `the highest July check in scope is ${String(july.value)}, not 778,481.55`);
    assert.equal(july.rows[0]?.number, '63409', `the highest July check in scope is ${july.rows[0]?.number}`);
    assert.equal(
      july.rows[0]?.vendor,
      'PERFECTION EQUIPMENT CO.',
      `the highest July check in scope is paid to "${july.rows[0]?.vendor}"`,
    );

    assert.notEqual(
      unscopedMax,
      july.value,
      "the assistant's July maximum and the raw file's July maximum are the same figure — if these two agree, " +
        'the scope join has stopped narrowing and every answer is being computed over the wrong register.',
    );
    assert.ok(
      unscopedJuly.length > july.matched,
      `the unscoped file holds ${unscopedJuly.length} July checks and the scope selects ${july.matched}; the ` +
        'scope is supposed to narrow, so this comparison is no longer doing anything.',
    );

    // A blank fund must select nothing at all. Fail-closed is the whole reason an
    // empty fund is treated as "no scope" rather than "every fund".
    const nothing = assistantNarrow({ fund: '', programs: [] });
    assert.equal(
      nothing.rows.length,
      0,
      `a blank fund selected ${nothing.rows.length} checks. A scope that cannot say which fund it means must ` +
        'select nothing — the alternative is that an unanswered question reads as "everything".',
    );
  });

  await check('the intent schema accepts a choice of reduction and refuses everything else', async () => {
    const population = assistantNarrow(registerScope);
    const prompt = buildSystemPrompt(population.window);

    // ★ THE PROMPT MUST NOT CARRY A FIGURE IT COULD ECHO. The whole design rests on
    //   the model choosing *what to measure* while the server does the measuring: the
    //   moment a total, a row or a sample reaches the prompt, a plausible-looking
    //   answer can be a copy of a number rather than a computation over the rows.
    //   Nothing in this prompt is money — it names the reductions and the extract's
    //   date window — so a `$` in it means a figure has been put in front of the model.
    assert.ok(
      !prompt.includes('$'),
      'the intent prompt now contains a `$`. Nothing in it is money, so a figure has been put in front of ' +
        'the model — and a model shown the answer can return the answer.',
    );
    const biggest = [...population.rows].sort((a, b) => b.amount - a.amount).slice(0, 5);
    for (const row of biggest) {
      const forms = [row.amount.toFixed(2), row.amount.toLocaleString('en-US')];
      // A bare `String(amount)` for a short integer is indistinguishable from a date
      // fragment or a schema constant, so only the unambiguous renderings are used —
      // and every amount in the top five has enough digits for the raw form to be
      // unambiguous too.
      if (String(row.amount).length >= 5) forms.push(String(row.amount));
      for (const form of forms) {
        assert.ok(
          !prompt.includes(form),
          `the intent prompt contains ${form}, which is the amount of check ${row.number}. The model is to be ` +
            'told what to measure, never what the answer is.',
        );
      }
      assert.ok(!prompt.includes(row.number), `the intent prompt names check ${row.number}`);
    }
    assert.ok(
      prompt.includes(population.window.from) && prompt.includes(population.window.to),
      "the intent prompt no longer states the extract's window, so \"July\" has no year to be resolved against",
    );

    // ---- Accepted shapes ---------------------------------------------------------
    const accepted: { why: string; reply: string; aggregate: string }[] = [
      {
        why: 'a plain intent',
        reply: '{"supported":true,"subject":"check","aggregate":"max","dateFrom":"2026-07-01","dateTo":"2026-07-31"}',
        aggregate: 'max',
      },
      {
        why: 'an intent wrapped in a json fence',
        reply: '```json\n{"supported":true,"subject":"check","aggregate":"sum","checkNumber":"63409"}\n```',
        aggregate: 'sum',
      },
      {
        why: 'an intent with prose around it',
        reply: 'Sure — here it is: {"supported":true,"subject":"check","aggregate":"avg"} hope that helps!',
        aggregate: 'avg',
      },
    ];
    for (const c of accepted) {
      const parsed = parseIntent(c.reply);
      if (!parsed.ok) {
        throw new Error(`${c.why} was rejected: ${parsed.problem}`);
      }
      // `Intent` is a discriminated union, so the reduction is only reachable once the
      // model has said the question is answerable at all — which is the point of the
      // shape: a refusal that also named a reduction would be ambiguous about which
      // one applied.
      if (!parsed.intent.supported) {
        throw new Error(`${c.why} came back as a refusal, so no reduction was chosen`);
      }
      assert.equal(parsed.intent.aggregate, c.aggregate, `${c.why} came back as ${parsed.intent.aggregate}`);
    }

    const refusal = parseIntent('{"supported":false,"reason":"That is a question about invoices."}');
    if (!refusal.ok) {
      throw new Error(`an explicit refusal was rejected as a malformed intent: ${refusal.problem}`);
    }
    assert.equal(refusal.intent.supported, false, 'an explicit refusal was accepted as something answerable');

    // ---- Refused shapes ----------------------------------------------------------
    //
    // ★ EVERY ONE OF THESE HAS A PROMISE BEHIND IT. `.strict()` exists so the model
    //   cannot widen the vocabulary by inventing a field (the `sql` case); the
    //   `limit` bound exists so one question cannot ask the server to materialise the
    //   register; the date pattern exists so `"last July"` cannot reach a comparison
    //   that would silently be false for every row.
    const refused: { why: string; reply: string; expect?: string }[] = [
      { why: 'an empty answer', reply: '' },
      { why: 'prose with no JSON in it', reply: 'I am not able to help with that.', expect: 'did not return a JSON object' },
      { why: 'braces that are not JSON', reply: '{"aggregate": max, }', expect: 'not valid JSON' },
      {
        why: 'an invented field',
        reply: '{"supported":true,"subject":"check","aggregate":"max","sql":"SELECT * FROM checks"}',
        expect: 'sql',
      },
      {
        why: 'a reduction this register does not perform',
        reply: '{"supported":true,"subject":"check","aggregate":"median"}',
      },
      { why: 'a limit past the bound', reply: '{"supported":true,"subject":"check","aggregate":"max","limit":500}' },
      {
        why: 'a date that is not a date',
        reply: '{"supported":true,"subject":"check","aggregate":"max","dateFrom":"last July"}',
      },
      { why: 'a missing subject', reply: '{"supported":true,"aggregate":"max"}' },
    ];
    for (const c of refused) {
      const parsed = parseIntent(c.reply);
      assert.equal(parsed.ok, false, `${c.why} was accepted. The intent vocabulary is closed on purpose: anything ` +
        'the server does not recognise must be refused rather than partially honoured.');
      if (parsed.ok) continue;
      assert.ok(parsed.problem.length > 0, `${c.why} was refused with an empty explanation`);
      if (c.expect) {
        assert.ok(
          parsed.problem.includes(c.expect),
          `${c.why} was refused, but the message ("${parsed.problem}") does not name "${c.expect}" — and the ` +
            'message is what tells a reader whether to widen the vocabulary or fix the prompt.',
        );
      }
    }
  });

  await check('the reduction filters the whole population and only then caps the rows', async () => {
    const population = assistantNarrow(registerScope);
    const julyRows = population.rows.filter((r) => r.date >= JULY_FROM && r.date <= JULY_TO);
    assert.ok(julyRows.length > 0, 'no July rows in scope — the checks below would be measuring an empty set');

    const july = assistantRun(population, 'sum', { dateFrom: JULY_FROM, dateTo: JULY_TO }, 20);

    // ★ AN INDEPENDENT ORACLE FOR `matched`. Teaching the number back from the same
    //   predicate it was computed with would test nothing, so it is recounted here
    //   over the raw rows.
    assert.equal(
      july.matched,
      julyRows.length,
      `the reduction matched ${july.matched} rows while an independent count of the same predicate found ` +
        `${julyRows.length}`,
    );
    assert.equal(
      july.rows.length,
      Math.min(july.matched, 20),
      `${july.matched} rows matched and ${july.rows.length} came back against a cap of 20. The order of ` +
        'operations is filter-then-slice: slicing first and filtering afterwards silently denies that ' +
        'matches exist outside the window, which reads in the UI as "there is nothing" for a filter whose ' +
        'matches are provably in the data.',
    );
    assert.equal(july.applied.length, 2, `the run reported ${july.applied.length} applied filters, expected 2`);

    // The sharp version of the same test: filter to the OLDEST July day, whose rows sit
    // at the END of the display order (`sum` orders by date DESC, id DESC). A
    // slice-then-filter implementation would keep the newest rows instead and return
    // rows that are not on that day at all.
    const oldest = julyRows.reduce((acc, r) => (r.date < acc ? r.date : acc), julyRows[0]!.date);
    const tail = assistantRun(population, 'sum', { dateFrom: oldest, dateTo: oldest }, 3);
    assert.equal(
      tail.matched,
      julyRows.filter((r) => r.date === oldest).length,
      `filtering to ${oldest} matched ${tail.matched} rows against an independent count of ` +
        `${julyRows.filter((r) => r.date === oldest).length}`,
    );
    assert.ok(
      tail.rows.every((r) => r.date === oldest),
      `a filter for ${oldest} returned rows dated [${tail.rows.map((r) => r.date).join(', ')}]. The rows were ` +
        'capped before the filter ran, so the cap chose the display order rather than the question.',
    );

    // ---- The empty-set semantics, which are not all the same ---------------------
    const empty = assistantNarrow({ fund: '', programs: [] });
    assert.equal(assistantRun(empty, 'max', {}, 5).value, null, 'a maximum over nothing must be null, not 0');
    assert.equal(assistantRun(empty, 'sum', {}, 5).value, 0, 'a sum over nothing is 0');
    assert.equal(assistantRun(empty, 'count', {}, 5).value, 0, 'a count of nothing is 0');
    assert.equal(
      assistantRun(empty, 'max', {}, 5).matched,
      0,
      'the row count over an empty set must be 0 — it is what tells a reader the answer is "nothing matched" ' +
        'rather than "the highest was null".',
    );
  });

  // ---- The provider-facing checks ------------------------------------------------
  //
  // ★ THESE ARE THE ONLY CHECKS HERE THAT NEED THE NETWORK, AND WITHOUT A KEY THEY
  //   SAY SO IN FULL. Reporting them green would be claiming a result the suite did
  //   not obtain; failing them would blame the caller for an optional setting. The
  //   derivation checks above take no skip precisely because the design keeps the
  //   scope, the arithmetic and the intent vocabulary in modules with no I/O — so the
  //   parts that can be tested always are.
  const assistant = aiStatus();
  const noProvider = `no provider is configured on this server (${assistant.reason ?? 'no reason given'})`;

  /**
   * Run a provider-facing check, or name it as skipped with the reason.
   *
   * ★ `skip` IS CALLED BESIDE `check`, NEVER INSIDE IT. `check` prints the name, runs
   *   the body and prints `ok` — so a body that decided to skip would print the name
   *   twice and then print `ok` anyway, which is the exact silent-green this whole
   *   arrangement exists to prevent.
   */
  const withProvider = async (name: string, fn: () => Promise<void>): Promise<void> => {
    if (!assistant.enabled) {
      skip(name, noProvider);
      return;
    }
    await check(name, fn);
  };

  if (!assistant.enabled) {
    // ★ THE ONE PROVIDER-FACING PROMISE THAT CAN BE KEPT WITHOUT A PROVIDER, and
    //   therefore asserted rather than skipped: a server with no key must refuse in
    //   words — naming the setting to add — rather than answering 500 or hanging.
    await check('CONTROL: with no provider configured the endpoint refuses in words', async () => {
      const res = await authorized('POST', '/api/ai/ask', {
        token: superToken,
        body: { question: 'What was the highest check paid in July?' },
      });
      assert.equal(res.status, 503, `an unconfigured assistant returned ${res.status}, not 503`);
      const { error } = (await res.json()) as { error: { code: string; message: string } };
      assert.equal(error.code, 'AI_UNAVAILABLE');
      assert.ok(
        /AI_ENDPOINT|AI_API_KEY|AI_MODEL|configured/.test(error.message),
        `the refusal reads "${error.message}", which does not name the setting that is missing. A 503 that ` +
          'does not say what to set is a dead end for whoever has to set it.',
      );
    });
  }

  await withProvider('the assistant answers a question about the checks register', async () => {
      const res = await authorized('POST', '/api/ai/ask', {
        token: superToken,
        body: { question: 'What was the highest check paid in July?' },
      });
      if (res.status !== 200) {
        throw new Error(`the assistant returned ${res.status} for a question it is supposed to answer: ${await res.text()}`);
      }
      const { data } = (await res.json()) as { data: AssistantAnswer };

      assert.equal(data.kind, 'answer', `the answer came back as "${data.kind}"`);
      assert.equal(data.refused, null);

      // ★ THE AGGREGATE IS ASSERTED BESIDE THE FIGURE BECAUSE IT IS THE ONE THING A
      //   READER CANNOT CHECK. 778,481.55 is a maximum here and would be a perfectly
      //   plausible sum there, so a bare number cannot tell the two apart — and
      //   `temperature: 0` was measured *not* to pin the choice (three runs of one
      //   question returned `count` once and the amount twice). That is why the route
      //   normalises the known case and the answer block names the reduction.
      assert.equal(
        data.intent?.aggregate,
        'max',
        `the question was answered with a ${data.intent?.aggregate} — and a sum, an average or a count of the ` +
          'July rows is a real figure that reads exactly as authoritative as the maximum.',
      );
      assert.equal(data.unit, 'money', `money was reported as "${data.unit}"`);
      assert.equal(data.value, 778481.55, `the answer was ${String(data.value)}, not 778,481.55`);
      assert.equal(data.rows.matched, 22, `${data.rows.matched} rows matched, not 22`);
      assert.equal(data.rows.sample[0]?.number, '63409', `the top row is check ${data.rows.sample[0]?.number}`);
      assert.equal(
        data.rows.sample[0]?.vendor,
        'PERFECTION EQUIPMENT CO.',
        `the top row is paid to "${data.rows.sample[0]?.vendor}"`,
      );

      // ★ THE SCOPE JOIN, PROVEN BY THE FIGURE RATHER THAN BY THE MESSAGE. If the
      //   narrowing ever stopped, the same question would answer with the raw file's
      //   maximum over July instead — a real number, 23× larger, and indistinguishable
      //   from a correct one without knowing the register.
      assert.notEqual(
        data.value,
        18043056.47,
        "the assistant answered with the raw file's July maximum — if these two agree, the scope join has " +
          'stopped narrowing and every answer is being computed over the wrong register.',
      );

      // The basis is the disclosure, and every number in it is measured.
      assert.ok(data.basis !== null, 'the answer carried no basis, so a reader cannot tell which population it came from');
      assert.equal(data.basis?.considered, 22);
      assert.equal(data.basis?.inScope, 65, `the basis reports ${data.basis?.inScope} checks in scope, not 65`);
      assert.equal(data.basis?.total, 4218, `the basis reports ${data.basis?.total} checks read, not 4,218`);
      assert.equal(data.basis?.withoutAccounts, 4153);
      assert.equal(data.basis?.source, 'checks.json');
      assert.equal(data.basis?.scope.fund, registerScope.fund);
      assert.deepEqual(
        [...(data.basis?.scope.programs ?? [])].sort(),
        [...registerScope.programs].sort(),
        'the basis named a different program list than the register holds',
      );
      assert.ok(
        data.basis?.filters.some((f) => f.includes('2026-07')),
        `the basis reports filters [${(data.basis?.filters ?? []).join('; ')}], which do not mention a July ` +
          'bound — so the answer is being described as the whole window’s maximum.',
      );

      // The provider's own usage, surfaced so a silent retry is not silent.
      assert.equal(data.model?.name, config.ai.model);
      assert.ok(
        (data.model?.attempts ?? 0) >= 1 && (data.model?.attempts ?? 0) <= 2,
        `the model was asked ${String(data.model?.attempts)} times; the design allows exactly one retry`,
      );
      assert.ok((data.model?.ms ?? 0) > 0, 'the model usage reports no elapsed time');

      const key = config.ai.apiKey;
      assert.ok(
        key !== undefined && key !== '' && !JSON.stringify(data).includes(key),
        'the provider API key appears in the response body. It is a server-side secret and must never reach ' +
          'the browser — check `redact()` in ai/model.ts before believing this is a false positive.',
      );
  });

  await withProvider('CONTROL: an unanswerable question is refused rather than guessed at', async () => {
      const res = await authorized('POST', '/api/ai/ask', {
        token: superToken,
        body: { question: 'What is the weather in Raleigh tomorrow?' },
      });
      if (res.status !== 200) {
        throw new Error(`an unanswerable question returned ${res.status} instead of a refusal: ${await res.text()}`);
      }
      const { data } = (await res.json()) as { data: AssistantAnswer };
      assert.equal(
        data.kind,
        'refused',
        'the assistant answered a question this register cannot answer. A confident figure computed from ' +
          'something adjacent is worse than a refusal, because nothing on screen marks it as off-target.',
      );
      assert.equal(data.value, null, 'a refusal carried a value');
      assert.equal(data.rows.matched, 0, 'a refusal carried matched rows');
      assert.ok(
        (data.refused?.answerable ?? []).length > 0,
        'the refusal does not say what the assistant can answer, which leaves the reader with a dead end ' +
          'rather than a next question.',
      );
  });

  await withProvider('CONTROL: an unreachable provider is a 503 within the timeout, not a hang', async () => {
    const savedEndpoint = config.ai.endpoint;
    const savedTimeout = config.ai.timeoutMs;
    // ★ 192.0.2.0/24 IS RESERVED FOR DOCUMENTATION AND IS NOT ROUTED, so the TCP
    //   connect hangs rather than being refused — which is what exercises
    //   `AbortSignal.timeout` instead of the connection-refused branch. Only the upper
    //   bound is asserted: a fast refusal is a legitimate way for this to finish, so a
    //   lower bound would fail on a machine with no network at all.
    config.ai.endpoint = 'http://192.0.2.1:8080/v1';
    config.ai.timeoutMs = 1500;
    const started = Date.now();
    try {
      const res = await authorized('POST', '/api/ai/ask', {
        token: superToken,
        body: { question: 'What was the highest check paid in July?' },
      });
      const elapsed = Date.now() - started;
      assert.equal(res.status, 503, `an unreachable provider returned ${res.status}, not 503`);
      const { error } = (await res.json()) as { error: { code: string; message: string; details?: unknown } };
      assert.equal(error.code, 'AI_UNAVAILABLE');
      assert.ok(
        error.message.length > 0 && !/\bundefined\b/.test(error.message),
        `the failure reads "${error.message}", which does not describe what went wrong upstream`,
      );
      assert.ok(
        elapsed < 8000,
        `the request took ${elapsed}ms against a 1,500ms timeout. A provider that never answers must be ` +
          'bounded by AI_TIMEOUT_MS, or one question holds a connection and a request slot indefinitely — ' +
          'the register is a text box, so anything can be typed into it.',
      );
    } finally {
      config.ai.endpoint = savedEndpoint;
      config.ai.timeoutMs = savedTimeout;
    }
  });

  await check('CONTROL: a question that breaks the schema is refused before any model call', async () => {
    // Two layers, two codes: `VALIDATION_FAILED` is the schema rejecting the *shape*
    // of the request, `BAD_REQUEST` is the handler rejecting a value it looked up.
    // Asserting only the status would collapse them and hide which layer spoke.
    const empty = await authorized('POST', '/api/ai/ask', { token: superToken, body: { question: '' } });
    assert.equal(empty.status, 400, `an empty question returned ${empty.status}`);
    const emptyBody = (await empty.json()) as { error: { code: string } };
    assert.equal(
      emptyBody.error.code,
      'VALIDATION_FAILED',
      `an empty question was answered with ${emptyBody.error.code}. It is a shape failure — the schema says ` +
        'a question is at least one character — so it must be the validator that speaks, before the handler ' +
        'and before any provider call.',
    );

    // ★ THE TWO BOUNDS ARE DELIBERATELY DIFFERENT NUMBERS, AND THE BODY HERE HAS TO
    //   LAND BETWEEN THEM. The schema caps a question at 2,000 characters as a pure
    //   abuse guard; the handler caps it at `AI_MAX_QUESTION_CHARS` (400) as a business
    //   rule whose message names *that* figure. A body over 2,000 is stopped by Zod and
    //   answers VALIDATION_FAILED, so it would test the schema while claiming to test
    //   the rule. Derive the length from the config so this cannot drift out of range.
    const overLimit = 'why '.repeat(Math.ceil((config.ai.maxQuestionChars + 40) / 4));
    const long = await authorized('POST', '/api/ai/ask', {
      token: superToken,
      body: { question: overLimit },
    });
    assert.equal(long.status, 400, `a ${overLimit.length}-character question returned ${long.status}`);
    const longBody = (await long.json()) as { error: { code: string; message: string } };
    assert.equal(
      longBody.error.code,
      'BAD_REQUEST',
      `an over-long question was answered with ${longBody.error.code}. The length ceiling is a business rule ` +
        'with its own message naming the limit, not a schema bound — if this becomes VALIDATION_FAILED the ' +
        'handler branch that names the limit has been shadowed and is now dead code.',
    );
    assert.ok(
      longBody.error.message.includes(String(config.ai.maxQuestionChars)),
      `the refusal reads "${longBody.error.message}", which does not name the limit it enforced. That figure is ` +
        'the whole reason this is a handler branch rather than a schema bound.',
    );

    // The other side of the same pair: past the schema's absolute bound the shape is
    // rejected first, and the code says so. The ordering is intentional and is the
    // reason the handler's tighter rule can speak at all.
    const absurd = await authorized('POST', '/api/ai/ask', {
      token: superToken,
      body: { question: 'why '.repeat(600) },
    });
    assert.equal(absurd.status, 400, `a 2,400-character question returned ${absurd.status}`);
    const absurdBody = (await absurd.json()) as { error: { code: string } };
    assert.equal(
      absurdBody.error.code,
      'VALIDATION_FAILED',
      `a 2,400-character question was answered with ${absurdBody.error.code}. Past the schema's absolute bound ` +
        'the validator is expected to speak first — if the two codes have swapped, the layering documented ' +
        'above is gone and the handler is now the only bound on request size.',
    );

    // ★ AND THE GUARD ITSELF, ON A WELL-FORMED BODY. A guarded route's schema is
    //   publicly probeable: validation runs *before* the handler, so a malformed
    //   anonymous request answers 400 from the validator and the 401 asserted here
    //   never gets a chance to speak. Send a valid body, or this tests the validator.
    const anonymous = await authorized('POST', '/api/ai/ask', {
      body: { question: 'What was the highest check paid in July?' },
    });
    assert.equal(
      anonymous.status,
      401,
      `an anonymous question returned ${anonymous.status} instead of 401. The question is well-formed, so a ` +
        '400 here would mean the validator ran before the guard and this assertion is testing the wrong layer.',
    );
  });

  await check('GET /api/organizations/options reads its vocabulary from the ledger', async () => {
    assert.ok(superToken !== '', 'no session — see the bootstrap check above');
    const res = await authorized('GET', '/api/organizations/options', { token: superToken });
    assert.equal(res.status, 200, `the options endpoint returned ${res.status}`);
    const { data } = (await res.json()) as {
      data: {
        funds: { fund: string; combinations: number }[];
        programs: { fund: string; program: string; combinations: number }[];
        fiscalYears: { earliest: number; latest: number } | null;
      };
    };

    const funds = data.funds.map((f) => f.fund);
    assert.ok(funds.length > 0, 'the ledger offered no funds at all');
    // ★ `00` IS A REAL LEDGER VALUE AND IS DELIBERATELY NOT OFFERED. Its seven
    //   account combinations all pair with program `000`, and both are the
    //   unresolved placeholder — the account nobody finished coding. Offering it
    //   would let a tenant be configured onto rows that mean "we do not know yet".
    assert.ok(
      !funds.includes('00'),
      'the fund picker now offers `00` — that is the placeholder for uncoded accounts, and offering it ' +
        'lets a tenant be configured onto rows that mean "nobody has decided this yet"',
    );
    assert.ok(
      !data.programs.some((p) => p.program === '000'),
      'the program picker now offers `000`, which is the same placeholder by another name',
    );

    // The pairing is what makes the fund filter in the form satisfiable rather
    // than merely suggestive, so it is asserted as a cross-consistency property
    // and not as the sample's exact contents — a refreshed extract may carry a
    // different set of pairs, and that must not read as a server defect.
    for (const p of data.programs) {
      assert.ok(funds.includes(p.fund), `program ${p.program} is offered under fund ${p.fund}, which is not`);
    }
    for (const f of data.funds) assert.ok(f.combinations > 0, `fund ${f.fund} is offered with 0 accounts behind it`);

    if (data.fiscalYears !== null) {
      assert.ok(
        data.fiscalYears.earliest <= data.fiscalYears.latest,
        `the fiscal-year range is inverted: ${data.fiscalYears.earliest}–${data.fiscalYears.latest}`,
      );
    }
  });

  await check('CONTROL: a fund, a program list and a name that are not valid are all refused', async () => {
    assert.ok(superToken !== '', 'no session — see the bootstrap check above');
    await clearOrganization();

    const valid = { name: ORG_NAME, fund: '04', startFy: 2022 };

    const badFund = await authorized('POST', '/api/organizations', {
      token: superToken,
      body: { ...valid, fund: '00' },
    });
    assert.equal(badFund.status, 400, `fund 00 was accepted (${badFund.status}) — it must not be`);
    const fundBody = (await badFund.json()) as { error: { code: string; details?: { accepts?: string[] } } };
    // ★ `BAD_REQUEST`, NOT `VALIDATION_FAILED`, AND THE DIFFERENCE IS WHERE THE
    //   RULE LIVES. `00` passes the schema — it is two digits — and is refused by
    //   `assertFund`, which is a lookup against `GL_CODE_COMBINATIONS`. A rule
    //   whose answer is a query is a business rule; only the shape is the schema's.
    assert.equal(
      fundBody.error.code,
      'BAD_REQUEST',
      'fund 00 is being refused by the schema rather than by the chart-of-accounts lookup',
    );
    // ★ AND IT IS NOT 409. Nothing is in conflict — the value is simply not in
    //   the vocabulary, and a 409 would tell the caller to change the OTHER thing.
    //   The refusal names what the ledger does accept, so the form can say so
    //   without a second request.
    assert.ok(
      Array.isArray(fundBody.error.details?.accepts) && !fundBody.error.details.accepts.includes('00'),
      'the fund refusal does not list the funds that are acceptable',
    );

    const dupProgram = await authorized('POST', '/api/organizations', {
      token: superToken,
      body: { ...valid, programs: ['861', '861'] },
    });
    assert.equal(dupProgram.status, 400, `a duplicated program was accepted (${dupProgram.status})`);
    // This one IS the schema's — a `.refine()` on the array — so the code differs
    // from the fund refusal above for a reason, not by accident.
    assert.equal(
      ((await dupProgram.json()) as { error: { code: string } }).error.code,
      'VALIDATION_FAILED',
      'a duplicated program is no longer caught by the schema',
    );

    const badFy = await authorized('POST', '/api/organizations', {
      token: superToken,
      body: { ...valid, startFy: 1900 },
    });
    // The bounds come from `GL_PERIODS`, so this control depends on the ledger
    // holding periods — which it does, and which the options check asserts.
    assert.equal(badFy.status, 400, `FY1900 was accepted (${badFy.status}) — no period is in it, ever`);
    const fyBody = (await badFy.json()) as { error: { code: string; details?: { accepts?: unknown } } };
    assert.equal(fyBody.error.code, 'BAD_REQUEST', 'the fiscal-year rule is a ledger lookup, not a shape check');
    assert.ok(fyBody.error.details?.accepts, 'the fiscal-year refusal does not say which years are acceptable');

    const noName = await authorized('POST', '/api/organizations', {
      token: superToken,
      body: { ...valid, name: '   ' },
    });
    assert.equal(noName.status, 400, `a blank name was accepted (${noName.status})`);
    assert.equal(
      ((await noName.json()) as { error: { code: string } }).error.code,
      'VALIDATION_FAILED',
      'a whitespace-only name is no longer caught by the schema — it would reach `slugFor` and come back ' +
        'as an empty key',
    );

    // None of the four reached the table.
    const left = await rows<{ n: number }>('SELECT COUNT(*) AS n FROM organization WHERE slug = :slug', {
      slug: ORG_SLUG,
    });
    assert.equal(left[0]?.n, 0, 'a refused create still wrote a row — a validation that runs after the INSERT');
  });

  await check('CONTROL: a program the chart of accounts does not pair is still accepted', async () => {
    assert.ok(superToken !== '', 'no session — see the bootstrap check above');
    await clearOrganization();

    // ★ THIS IS A DESIGN DECISION ASSERTED, NOT A GAP. `fund` is checked against
    //   `GL_CODE_COMBINATIONS`; `programs` are checked for SHAPE ONLY — three
    //   digits — even though the server could compare them against the pairs the
    //   chart of accounts uses. It deliberately does not: the pairs in this sample
    //   are `04/861`, `04/862` and `01/220`, no purchase-order line anywhere
    //   carries program `861` or `863`, and a membership check would therefore
    //   forbid configuring a tenant onto a program that exists in the account
    //   structure and is simply absent from the current extract. If this ever
    //   starts refusing, that is the decision being reversed, not a bug fixed.
    const res = await authorized('POST', '/api/organizations', {
      token: superToken,
      body: { name: ORG_NAME, fund: '04', programs: ['999'], startFy: 2022 },
    });
    assert.equal(
      res.status,
      201,
      `a shape-valid program with no account combination behind it was refused (${res.status}) — the ` +
        'design validates programs for shape only, see the note in routes/organizations.ts',
    );
    const { data } = (await res.json()) as { data: OrgWire };
    assert.equal(data.slug, ORG_SLUG, 'the slug is no longer derived from the name');
    assert.equal(data.name, ORG_NAME);
    assert.equal(data.isDefault, false, 'a new tenant claimed the default flag — at most one row may hold it');
    assert.equal(data.scopeLabel, 'Fund 04 · program 999');
    assert.deepEqual(data.programs, ['999'], 'the program order was not preserved on write');

    // ★ DERIVED AND ENFORCED. Two tenants cannot share a key, because the key is
    //   derived from a name and the register addresses rows by it.
    const dup = await authorized('POST', '/api/organizations', {
      token: superToken,
      body: { name: ORG_NAME, fund: '04', startFy: 2022 },
    });
    assert.equal(dup.status, 409, `a duplicate name answered ${dup.status}, expected 409`);
    const dupBody = (await dup.json()) as { error: { details?: { slug?: string } } };
    assert.equal(dupBody.error.details?.slug, ORG_SLUG, 'the conflict does not name the key that clashed');
  });

  await check('an empty program list is legal and says so in words', async () => {
    assert.ok(superToken !== '', 'no session — see the bootstrap check above');

    // ★ THE NEAREST HONEST WAY TO SAY "READ NOTHING". A tenant with no fund would
    //   read no rows because it is broken and be indistinguishable from one that
    //   is fine; an empty program list reads no rows on purpose and is saved,
    //   listed and labelled as such. The label is asserted because a bare
    //   separator after "program" is the failure this wording exists to avoid.
    const res = await authorized('PATCH', `/api/organizations/${ORG_SLUG}`, {
      token: superToken,
      body: { programs: [] },
    });
    assert.equal(res.status, 200, `an empty program list returned ${res.status}`);
    const { data } = (await res.json()) as { data: OrgWire };
    assert.deepEqual(data.programs, []);
    assert.equal(
      data.scopeLabel,
      'Fund 04 · no program selected',
      'the empty selection is not described in words',
    );
  });

  await check('PATCH /api/organizations/{slug} edits in place and never moves the key', async () => {
    assert.ok(superToken !== '', 'no session — see the bootstrap check above');

    const res = await authorized('PATCH', `/api/organizations/${ORG_SLUG}`, {
      token: superToken,
      body: { name: `${ORG_NAME} renamed`, programs: ['861'] },
    });
    assert.equal(res.status, 200, `the rename returned ${res.status}`);
    const { data } = (await res.json()) as { data: OrgWire };
    assert.equal(data.name, `${ORG_NAME} renamed`);
    assert.equal(data.programs?.join(','), '861', 'the program change did not take');
    // ★ A STORED KEY THAT FOLLOWED THE NAME would break every link to it the
    //   moment somebody fixed a typo, which is the whole reason the write
    //   endpoints address a row by slug and not by name.
    assert.equal(data.slug, ORG_SLUG, 'a rename moved the key');

    // ★ THE DEFAULT IS EDITABLE LIKE ANY OTHER ROW, and that is how the whole
    //   application is rescoped: a visitor with no session browses the default
    //   tenant, so this one PATCH changes what an anonymous reader sees. It is
    //   asserted rather than assumed because a well-meaning "protect the default"
    //   guard would silently remove the only way to reconfigure the app.
    const before = await authorized('GET', '/api/organizations', { token: superToken });
    const beforeRow = ((await before.json()) as { data: { items: OrgWire[] } }).data.items.find(
      (o) => o.slug === 'wake-county',
    );
    assert.ok(beforeRow, 'the default organization vanished mid-suite');

    // PATCHed with the value it already has, so the write is real and the sample
    // is not changed: a check that edited the default and put it back would be
    // one crashed run away from leaving the shipped sample reconfigured.
    const same = await authorized('PATCH', '/api/organizations/wake-county', {
      token: superToken,
      body: { name: beforeRow.name },
    });
    assert.equal(same.status, 200, `editing the default organization returned ${same.status}`);
    const after = (await same.json()) as { data: OrgWire };
    assert.equal(after.data.isDefault, true, 'editing the default cleared the flag');
    assert.deepEqual(after.data.programs, beforeRow.programs, 'editing the name changed the scope');
  });

  await check('CONTROL: an empty PATCH and an unknown key are both refused', async () => {
    assert.ok(superToken !== '', 'no session — see the bootstrap check above');

    // Nothing to change is a mistake in the request, not a no-op to swallow: a
    // 200 here hands back a row the caller believes it edited.
    const empty = await authorized('PATCH', `/api/organizations/${ORG_SLUG}`, { token: superToken, body: {} });
    assert.equal(empty.status, 400, `an empty PATCH answered ${empty.status}, expected 400`);
    const emptyBody = (await empty.json()) as { error: { details?: { accepts?: string[] } } };
    assert.deepEqual(
      emptyBody.error.details?.accepts,
      ['name', 'fund', 'programs', 'startFy'],
      'the empty-PATCH refusal does not list what it would have accepted',
    );

    const unknown = await authorized('PATCH', '/api/organizations/there-is-no-such-tenant', {
      token: superToken,
      body: { name: 'Whatever' },
    });
    assert.equal(unknown.status, 404, `an unknown key answered ${unknown.status}, expected 404`);
    const unknownBody = (await unknown.json()) as { error: { code: string } };
    assert.equal(unknownBody.error.code, 'NOT_FOUND');
  });

  await check('★ a member with a valid session is refused FORBIDDEN, not UNAUTHORIZED', async () => {
    assert.ok(superToken !== '', 'no session — see the bootstrap check above');

    // ★ THE ACCOUNT IS MADE HERE AND REMOVED AT THE END OF THE SUITE. `app_user`
    //   ships with no rows, so there is no member to sign in as and the 403 path
    //   — the entire reason `requireSuperAdmin` distinguishes the two failures —
    //   would otherwise be untested. Deleting in a `finally` is not enough on its
    //   own: the pre-delete above is what makes a run after a crashed run work.
    await clearMember();
    await execute(
      'INSERT INTO app_user (email, display_name, role, organization_id) VALUES (:email, :name, :role, :org)',
      { email: MEMBER_EMAIL, name: 'Smoke Check Member', role: 'member', org: await defaultOrgId() },
    );

    const signedIn = await signIn(MEMBER_EMAIL);
    assert.equal(signedIn.status, 200, `the member account could not sign in (${signedIn.status})`);
    const { data } = (await signedIn.json()) as { data: SignedIn };
    assert.equal(data.user.role, 'member', 'a row with role=member signed in as something else');
    assert.equal(data.user.organizationId, await defaultOrgId(), 'the member did not resolve a tenant');

    // All four register routes, read and write alike: the capability is the
    // register, not the verb.
    for (const [method, path, body] of [
      ['GET', '/api/organizations', undefined],
      ['GET', '/api/organizations/options', undefined],
      ['POST', '/api/organizations', { name: 'Nope', fund: '04', startFy: 2022 }],
      ['PATCH', `/api/organizations/${ORG_SLUG}`, { name: 'Nope' }],
    ] as const) {
      const res = await authorized(method, path, {
        token: data.token,
        ...(body === undefined ? {} : { body }),
      });
      // ★ 403 AND NOT 401. A member who was told "sign in" would go round a loop
      //   they cannot win, because the reason they are refused is not something
      //   signing in again can change.
      assert.equal(res.status, 403, `${method} ${path} answered a member ${res.status}, expected 403`);
      const err = (await res.json()) as { error: { code: string; message: string; details?: { role?: string } } };
      assert.equal(err.error.code, 'FORBIDDEN', `${method} ${path} refused a member as ${err.error.code}`);
      assert.equal(err.error.details?.role, 'member', 'the refusal does not carry the role it judged');
      assert.ok(
        err.error.message.includes(MEMBER_EMAIL),
        `the refusal does not name the account: ${err.error.message}`,
      );
      // ★ THE MESSAGE NAMES THE REGISTER, NOT THE VERB. It used to say "only a
      //   super admin can CHANGE an organization", which is the right sentence
      //   for POST and the wrong one for a member who was only reading the list —
      //   it sent them to ask for permission they were not after.
      assert.ok(
        err.error.message.includes('organization register'),
        `the refusal names the wrong thing: ${err.error.message}`,
      );
      assert.ok(
        !err.error.message.includes('can change an organization'),
        'the refusal still says "change an organization" on a read route',
      );
    }

    // The member's own tenant is readable — they are scoped, not locked out.
    const session = await authorized('GET', '/api/auth/session', { token: data.token });
    assert.equal(session.status, 200, 'a valid member session could not read its own identity');
  });

  await check('the organization domain is documented, and grouped where the router put it', async () => {
    const spec = (await (await get('/api/docs.json')).json()) as Spec;

    for (const path of ['/api/organizations', '/api/organizations/options', '/api/organizations/{slug}']) {
      assert.ok(spec.paths[path], `${path} is registered but absent from the spec`);
    }
    assert.ok(spec.paths['/api/organizations']?.get, 'the register has no GET in the spec');
    assert.ok(spec.paths['/api/organizations']?.post, 'the register has no POST in the spec');
    assert.ok(spec.paths['/api/organizations/{slug}']?.patch, 'the register has no PATCH in the spec');
    assert.ok(spec.paths['/api/auth/sign-in']?.post, 'sign-in is not in the spec');
    assert.ok(spec.paths['/api/auth/session']?.get, 'the session endpoint is not in the spec');

    // The two domains this section exercises are declared as tags, in the array
    // that is also the display order (`docs.ts` sets `tagsSorter: undefined`, so
    // the declaration order IS the Swagger grouping order).
    const names = (spec.tags ?? []).map((t) => t.name);
    assert.ok(names.includes('Auth'), 'the Auth tag is not declared');
    assert.ok(names.includes('Organizations'), 'the Organizations tag is not declared');
    assert.ok(
      names.length >= 12,
      `only ${names.length} tags are declared — a domain's routes lost their grouping`,
    );

    // ★ AND THE GROUPING, PER OPERATION, WHICH PRESENCE ALONE DOES NOT PROVE. A
    //   path being in the document says the route was registered; it does NOT say
    //   the router filed it under the tag whose section a reader would look in.
    //   Every `api.route` call names its own tag, so this is the assertion that the
    //   four organization operations really carry `Organizations` and the two auth
    //   operations really carry `Auth` — mis-tag the register as `Admin` and
    //   nothing else in this suite would notice, because the path, the operationIds
    //   and the schemas would all still be exactly right.
    const tagged = (path: string, method: string): string[] =>
      spec.paths[path]?.[method]?.tags ?? [];
    for (const [path, method] of [
      ['/api/organizations', 'get'],
      ['/api/organizations', 'post'],
      ['/api/organizations/options', 'get'],
      ['/api/organizations/{slug}', 'patch'],
    ] as const) {
      assert.deepEqual(
        tagged(path, method),
        ['Organizations'],
        `${method.toUpperCase()} ${path} is grouped under ${JSON.stringify(tagged(path, method))}, ` +
          'not Organizations',
      );
    }
    for (const [path, method] of [
      ['/api/auth/sign-in', 'post'],
      ['/api/auth/session', 'get'],
    ] as const) {
      assert.deepEqual(
        tagged(path, method),
        ['Auth'],
        `${method.toUpperCase()} ${path} is grouped under ${JSON.stringify(tagged(path, method))}, not Auth`,
      );
    }

    // ★ AND THE ORDER IS THE DECLARED ORDER, NOT ALPHABETICAL. `docs.ts` sets
    //   `tagsSorter: undefined`, so the array above IS the Swagger grouping order
    //   — which makes its order a decision somebody made, and `Meta` then `Auth` is
    //   it. Sorting by name would put `Admin` first and the only symptom would be a
    //   Swagger page whose sections had silently rearranged themselves.
    assert.equal(names[0], 'Meta', `the first tag is ${names[0]}, not Meta — the declared order changed`);
    assert.equal(names[1], 'Auth', `the second tag is ${names[1]}, not Auth — the declared order changed`);

    // ★ AND THE DOCUMENT DECLARES NO SECURITY SCHEME, WHICH IS WHY THESE ROUTES
    //   HAVE NO TRY-IT-OUT FIELD. This is asserted so that adding one is a
    //   deliberate act: the session is the custom `x-app-session` header, and
    //   `RouteSpec` in http/api.ts binds only `params`/`query`/`body` into a
    //   route's request, so there is no way to declare a header parameter either.
    //   Today the header is documented in the frontmatter by `documentIdentity()`
    //   and the reader is told its name there. When a scheme is registered, this
    //   assertion fails and routes the author to `swaggerOptions.persistAuthorization`
    //   in http/docs.ts, which starts working that same day.
    const doc = spec as {
      components?: { schemas?: Record<string, unknown>; securitySchemes?: Record<string, unknown> };
    };
    assert.equal(
      doc.components?.securitySchemes,
      undefined,
      'a security scheme has appeared — the note in http/docs.ts about `persistAuthorization` and the ' +
        'frontmatter in `documentIdentity()` both need revisiting, and Swagger UI now has a Try-it-out field',
    );
  });

  // ★ THE SUITE PUTS THE SAMPLE BACK, WHATEVER PASSED. Deliberately *outside*
  //   every `check()`, so a failing assertion above cannot skip it: the
  //   pre-deletes make a run after a CRASHED run work, and this makes a run that
  //   passed leave nothing behind either. Asserted rather than assumed, because a
  //   cleanup nobody checks is a cleanup that stops working quietly — and
  //   `sample.db` already carries two `project` rows the schema file does not
  //   create, which is exactly how that happens.
  await clearOrganization();
  await clearMember();
  await check('the suite left no organization and no member account behind', async () => {
    const orgs = await rows<{ n: number }>('SELECT COUNT(*) AS n FROM organization WHERE slug = :slug', {
      slug: ORG_SLUG,
    });
    const users = await rows<{ n: number }>('SELECT COUNT(*) AS n FROM app_user WHERE email = :email', {
      email: MEMBER_EMAIL,
    });
    assert.equal(orgs[0]?.n, 0, `"${ORG_SLUG}" survived the run`);
    assert.equal(users[0]?.n, 0, `"${MEMBER_EMAIL}" survived the run`);
  });

  // ---- Custom field values (plan docs/plans/custom-table-fields.md) -------
  //
  // The feature is "a reader may give a field a value of their own". Three things
  // are worth asserting and no more, because everything else is a restatement:
  //
  //   1. The wire contract for what may be overridden equals the REGISTRY, in both
  //      directions. The client renders its pencil from `fields`, so a wire list
  //      that had drifted from `OVERRIDABLE` would offer an edit the server then
  //      refuses — and a hand-copied list drifts silently in exactly that way.
  //   2. The write path folds the key, attributes the row to the session, and can
  //      be read back and removed. A save that cannot be read back is not a save.
  //   3. Every refusal, in the layer that owns it. Blank is BAD_REQUEST naming the
  //      trash; an unlisted pair is BAD_REQUEST naming the registry; a body with no
  //      `value` is VALIDATION_FAILED, because that is a fact about the shape and
  //      the schema is what speaks to it.
  //
  // ★ THE PROBE KEY IS UNREACHABLE BY FOLD. Nothing in the ledger folds to
  //   `ZZZCUSTOMFIELDPROBESAFETODELETE`, so this block cannot overwrite a real
  //   reader's name even if it fails halfway — and it is cleared at BOTH ends,
  //   because a pre-clear removes nothing the final cleanup would not have removed
  //   anyway and a leftover row would make the second run of the day behave
  //   differently from the first.

  const PROBE_KEY_WRITTEN = 'ZZZ-CUSTOM-FIELD-PROBE (safe to delete)';
  const PROBE_KEY_FOLD = 'ZZZCUSTOMFIELDPROBESAFETODELETE';
  const CUSTOM_PATH = '/api/custom-fields/vendor/name';

  const clearProbeOverride = (): Promise<{ rowsAffected: number }> =>
    execute(
      "DELETE FROM field_override WHERE subject_kind = 'vendor' AND subject_key = :key",
      { key: PROBE_KEY_FOLD },
    );

  await clearProbeOverride();

  await check('GET /api/custom-fields serves the registry, not a copy of it', async () => {
    const res = await authorized('GET', '/api/custom-fields', { token: superToken });
    assert.equal(res.status, 200, `the list endpoint returned ${res.status}`);
    const body = (await res.json()) as {
      data: {
        overrides: { key: string }[];
        fields: {
          subject: string;
          field: string;
          subjectWord: string;
          label: string;
          maxLength: number;
          fromLedger: boolean;
          effect: string;
        }[];
        subjects: string[];
      };
    };
    // ★ SET EQUALITY IN BOTH DIRECTIONS, and the messages name the direction. A
    //   `deepEqual` would say "differs", which does not tell the reader whether to
    //   add a registry entry or delete one.
    const onWire = body.data.fields.map((f) => `${f.subject}.${f.field}`).sort();
    const declared = OVERRIDABLE.map((f) => `${f.subject}.${f.field}`).sort();
    assert.deepEqual(
      onWire.filter((p) => !declared.includes(p)),
      [],
      'the API offers an overridable pair the registry does not declare',
    );
    assert.deepEqual(
      declared.filter((p) => !onWire.includes(p)),
      [],
      'the registry declares an overridable pair the API does not offer — the pencil for it can never appear',
    );
    // The subject list is what a refusal names, so it must not be able to be empty
    // while a field exists: `subjects` is how the client tells "nobody renamed
    // anything" from "this build does not know custom fields".
    assert.deepEqual([...body.data.subjects].sort(), overridableSubjects().slice().sort());
    assert.ok(body.data.subjects.includes('vendor'), 'the subject list does not name `vendor`');
    // A real field, read out of a real payload: this is the reachability this
    // block depends on — a 200 whose payload had no `fields` would satisfy every
    // status check and leave the client with nothing to render.
    const name = body.data.fields.find((f) => f.field === 'name');
    assert.ok(name, 'the payload has no `vendor.name` entry');
    assert.equal(name.label, 'vendor name');
    assert.ok(name.maxLength > 0 && name.effect.trim().length > 0, 'a field with no limit or no note');
    // ★ THE SENTENCE THE UI SHOWS, PINNED ON ITS CONTENT AND NOT ITS WORDING. A
    //   reader who has just renamed a company is most likely to be wrong about
    //   what was NOT changed, so the note has to say so (see registry.ts).
    assert.match(
      name.effect,
      /(Oracle|ledger|master record)/i,
      'the effect note does not name what still uses the ledger\u2019s value',
    );
    // ★ THE TWO DECLARATION FIELDS THE UI BRANCHES ON TRAVEL, AND BOTH OF THEIR VALUES
    //   ARE EXERCISED. `fromLedger` is what decides between `Oracle holds “…”` and
    //   `Oracle holds no value for this field`; if it did not reach the client every
    //   field would fall back to inferring the answer from an empty value, and the
    //   email's tooltip would say a value came from a column that does not exist.
    //   Both entries are asserted, so an absent property cannot pass by defaulting to
    //   `undefined` — which is falsy and would make every field claim no ledger value.
    const email = body.data.fields.find((f) => f.subject === 'vendor_site' && f.field === 'email');
    assert.ok(email, 'the payload has no `vendor_site.email` entry');
    assert.equal(name.fromLedger, true, 'the vendor name is a ledger field and must be declared one');
    assert.equal(email.fromLedger, false, 'the email has no ledger column and must say so');
    // The anchor for the pencil's two labels, which name the record instead of quoting
    // the ledger's value — there is no value to quote on this field.
    assert.ok(
      email.subjectWord.trim().length > 0,
      'a field with no ledger value needs a word for the record its labels can name',
    );
  });

  await check('a subject with nothing stored is an empty list, not a 404', async () => {
    const res = await authorized('GET', '/api/custom-fields?subject=vendor', { token: superToken });
    assert.equal(res.status, 200, `the subject-filtered read returned ${res.status}`);
    const body = (await res.json()) as {
      data: { overrides: { key: string }[]; fields: { field: string }[]; subjects: string[] };
    };
    // ★ 404 WOULD MAKE THE CLIENT DISTINGUISH TWO THINGS IT CANNOT DISTINGUISH.
    //   "This build has never heard of custom fields" and "nobody has renamed
    //   anything" are indistinguishable to a browser, so the empty case is 200.
    assert.ok(Array.isArray(body.data.overrides), 'overrides is not an array');
    assert.ok(
      !body.data.overrides.some((o) => o.key === PROBE_KEY_FOLD),
      'the probe override survived from a previous run',
    );
    // The narrowed read still reports what may be overridden, and only that subject.
    assert.ok(body.data.fields.length > 0, 'a subject-filtered read carried no field list');
    assert.ok(body.data.subjects.includes('vendor'), 'the subject list went missing when filtered');
  });

  await check('CONTROL: an unknown subject is 400 BAD_REQUEST naming the ones that exist', async () => {
    const res = await authorized('GET', '/api/custom-fields?subject=pumpkin', { token: superToken });
    // ★ BAD_REQUEST AND NOT VALIDATION_FAILED. The subject is a well-formed string,
    //   so the schema has no complaint; the answer comes from a lookup (the
    //   registry). Asserting only the status collapses the two layers and hides a
    //   regression in either.
    assert.equal(res.status, 400, `an unknown subject returned ${res.status}`);
    const body = (await res.json()) as { error: { code: string; details?: { subjects?: string[] } } };
    assert.equal(body.error.code, 'BAD_REQUEST');
    assert.ok(
      body.error.details?.subjects?.includes('vendor'),
      'the refusal must name the subjects that do exist',
    );
  });

  await check('PUT /api/custom-fields stores a value, folded, attributed and read back', async () => {
    const res = await authorized('PUT', CUSTOM_PATH, {
      token: superToken,
      body: { key: PROBE_KEY_WRITTEN, value: 'Smoke Check Vendor (temporary)' },
    });
    if (res.status !== 200) {
      throw new Error(`expected 200, got ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as {
      data: {
        subject: string; field: string; key: string; written: string | null;
        value: string; setBy: string; setAt: string;
      };
    };
    // ★ THE FOLD IS THE SERVER'S, AND THIS IS WHERE IT IS VISIBLE. The body carried
    //   punctuation and spaces; the row must carry the fold, because that is what
    //   the client matches on. A store that kept the key as written would leave two
    //   spellings of one company as two overrides.
    assert.equal(body.data.key, PROBE_KEY_FOLD, 'the stored key is not the folded form');
    assert.equal(body.data.written, PROBE_KEY_WRITTEN, 'the key as written was not kept');
    assert.equal(body.data.value, 'Smoke Check Vendor (temporary)');
    assert.equal(body.data.subject, 'vendor');
    assert.equal(body.data.field, 'name');
    // ★ ATTRIBUTION COMES FROM THE SESSION AND NOWHERE ELSE. A body field claiming
    //   an author is not read by the handler, so a value here that is not the
    //   signed-in identity would mean the row was not attributed at all.
    assert.ok(
      body.data.setBy.includes('@'),
      `the row\u2019s author is not an address: ${body.data.setBy}`,
    );
    // `set_at` is the database clock, so it must look like one rather than being
    // whatever a route computed. SQLite's `datetime('now')` is `YYYY-MM-DD HH:MM:SS`.
    assert.match(body.data.setAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, `setAt is ${body.data.setAt}`);
  });

  await check('the saved value is served by the next read of the subject', async () => {
    const res = await authorized('GET', '/api/custom-fields?subject=vendor', { token: superToken });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      data: { overrides: { key: string; field: string; value: string; written: string | null }[] };
    };
    const stored = body.data.overrides.find((o) => o.key === PROBE_KEY_FOLD);
    assert.ok(stored, 'the override just written is not in the next read \u2014 a save that cannot be read back');
    assert.equal(stored.value, 'Smoke Check Vendor (temporary)');
    assert.equal(stored.field, 'name');
  });

  await check('CONTROL: a blank value is 400 BAD_REQUEST naming the trash, and writes nothing', async () => {
    // Spaces rather than an empty string: the schema trims, so this is the case a
    // schema alone cannot refuse, which is the whole reason the handler does.
    const res = await authorized('PUT', CUSTOM_PATH, {
      token: superToken,
      body: { key: PROBE_KEY_WRITTEN, value: '   ' },
    });
    assert.equal(res.status, 400, `a blank value returned ${res.status}`);
    const body = (await res.json()) as {
      error: { code: string; details?: { howToDelete?: string } };
    };
    assert.equal(body.error.code, 'BAD_REQUEST');
    assert.ok(
      body.error.details?.howToDelete,
      'the refusal must say how to remove a value \u2014 a blank is a value question, not a delete',
    );
    // ★ AND NOTHING WAS WRITTEN. A refused request that stored the blank anyway
    //   would render as a missing name, which is the third state this feature exists
    //   to avoid.
    const after = await authorized('GET', '/api/custom-fields?subject=vendor', { token: superToken });
    const shown = (await after.json()) as { data: { overrides: { key: string; value: string }[] } };
    const row = shown.data.overrides.find((o) => o.key === PROBE_KEY_FOLD);
    assert.equal(row?.value, 'Smoke Check Vendor (temporary)', 'the blank overwrote the stored value');
  });

  await check('CONTROL: an unlisted field is refused, naming what is overridable', async () => {
    const res = await authorized('PUT', '/api/custom-fields/vendor/no_such_field', {
      token: superToken,
      body: { key: PROBE_KEY_WRITTEN, value: 'anything' },
    });
    // ★ THIS IS THE REFUSAL THAT KEEPS A SAVE FROM BEING A SILENT NO-OP. A row for a
    //   field no component reads saves successfully and changes nothing on screen.
    assert.equal(res.status, 400, `an unlisted field returned ${res.status}`);
    const body = (await res.json()) as {
      error: { code: string; details?: { overridable?: { field: string }[] } };
    };
    assert.equal(body.error.code, 'BAD_REQUEST');
    assert.ok(
      body.error.details?.overridable?.some((f) => f.field === 'name'),
      'the refusal must list the fields that CAN be overridden',
    );
  });

  await check('CONTROL: a value over the field\u2019s own limit is refused with the limit in the message', async () => {
    const limit = OVERRIDABLE.find((f) => f.subject === 'vendor' && f.field === 'name')?.maxLength;
    assert.ok(limit !== undefined, 'the registry has no `vendor.name` limit to test against');
    const res = await authorized('PUT', CUSTOM_PATH, {
      token: superToken,
      body: { key: PROBE_KEY_WRITTEN, value: 'x'.repeat(limit + 1) },
    });
    assert.equal(res.status, 400, `an over-long value returned ${res.status}`);
    const body = (await res.json()) as { error: { code: string; details?: { maxLength?: number } } };
    assert.equal(body.error.code, 'BAD_REQUEST');
    assert.equal(
      body.error.details?.maxLength,
      limit,
      'the refusal does not report the limit it applied \u2014 the client prints this number',
    );
  });

  await check('CONTROL: a key that folds to nothing is refused rather than stored', async () => {
    const res = await authorized('PUT', CUSTOM_PATH, {
      token: superToken,
      body: { key: '---', value: 'punctuation only' },
    });
    // The schema accepts `---`: it is a non-empty string within the bound. Only the
    // fold knows it identifies nothing, which is why this is the handler\u2019s answer.
    assert.equal(res.status, 400, `a punctuation-only key returned ${res.status}`);
    const body = (await res.json()) as { error: { code: string; details?: { key?: string } } };
    assert.equal(body.error.code, 'BAD_REQUEST');
    assert.equal(body.error.details?.key, '---');
  });

  await check('CONTROL: a body with no value at all is VALIDATION_FAILED, not BAD_REQUEST', async () => {
    // ★ THE TWO 400 CODES ARE THE POINT OF THIS CHECK. VALIDATION_FAILED means the
    //   schema spoke \u2014 the request has no shape it can read. BAD_REQUEST means the
    //   handler did, and its answer came from a lookup. Sending a body with no
    //   `value` is the first; sending a blank one is the second. Asserting only
    //   `status === 400` would pass on either and hide a regression in the boundary.
    const res = await authorized('PUT', CUSTOM_PATH, { token: superToken, body: { key: PROBE_KEY_WRITTEN } });
    assert.equal(res.status, 400, `a shapeless body returned ${res.status}`);
    const body = (await res.json()) as { error: { code: string; details?: { issues?: unknown[] } } };
    assert.equal(body.error.code, 'VALIDATION_FAILED');
    assert.ok(Array.isArray(body.error.details?.issues), 'a validation failure must carry its issues');
  });

  await check('CONTROL: an anonymous caller is refused 401, and the body is valid so it is the guard that speaks', async () => {
    // ★ THE BODY IS VALID ON PURPOSE. `api.ts` validates a request\u2019s shape before
    //   the handler runs and `requireActor` lives inside the handler, so a malformed
    //   anonymous body would answer VALIDATION_FAILED and the guard would never run. Sending
    //   a good body is what makes this a test of the guard.
    const res = await authorized('PUT', CUSTOM_PATH, {
      body: { key: PROBE_KEY_WRITTEN, value: 'anonymous attempt' },
    });
    assert.equal(res.status, 401, `an anonymous write returned ${res.status}`);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'UNAUTHORIZED');
    // And the read of a subject is guarded the same way.
    const read = await authorized('GET', '/api/custom-fields?subject=vendor', {});
    assert.equal(read.status, 401, `an anonymous read returned ${read.status}`);
  });

  await check('CONTROL: deleting a key that was never overridden is 404', async () => {
    const res = await authorized(
      'DELETE',
      `/api/custom-fields/vendor/name?key=${encodeURIComponent('ZZZ-NEVER-SET-AT-ALL')}`,
      { token: superToken },
    );
    // The row is read before it is removed, so a second press of the trash and a
    // delete from a stale panel are answered identically rather than appearing to work.
    assert.equal(res.status, 404, `a delete of an unset key returned ${res.status}`);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'NOT_FOUND');
  });

  await check('DELETE /api/custom-fields clears the value and the ledger\u2019s name is what remains', async () => {
    const res = await authorized(
      'DELETE',
      `/api/custom-fields/vendor/name?key=${encodeURIComponent(PROBE_KEY_WRITTEN)}`,
      { token: superToken },
    );
    // ★ THE BODY IS READ AFTER THE STATUS IS CHECKED, NEVER INSIDE THE ASSERTION'S
    //   MESSAGE. An `assert.equal` message is an ordinary template literal: it is
    //   built *before* the assertion is evaluated, so a body read in it drains the
    //   response on the passing path too, and the next `res.json()`/`res.text()`
    //   throws `Body is unusable: Body has already been read` on a request that
    //   succeeded. Same defect and same fix as the write check above.
    if (res.status !== 204) {
      throw new Error(`the delete returned ${res.status}: ${await res.text()}`);
    }
    // ★ THE KEY IN THE QUERY IS THE ONE AS WRITTEN, NOT THE FOLD \u2014 and the fold is
    //   applied on this path too. Sending the written spelling is what proves that:
    //   a client reads its key back from a save, but a delete that only worked on an
    //   exact stored key would fail for anyone whose key reached us through a link.
    const after = await authorized('GET', '/api/custom-fields?subject=vendor', { token: superToken });
    const shown = (await after.json()) as { data: { overrides: { key: string }[] } };
    assert.ok(
      !shown.data.overrides.some((o) => o.key === PROBE_KEY_FOLD),
      'the override is still served after a 204 delete',
    );
    // And a second delete of the same key answers identically to the first refusal.
    const again = await authorized(
      'DELETE',
      `/api/custom-fields/vendor/name?key=${encodeURIComponent(PROBE_KEY_WRITTEN)}`,
      { token: superToken },
    );
    assert.equal(again.status, 404, `the second delete returned ${again.status}, not 404`);
  });

  await check('the vendor fold is injective on the spellings the ledger holds', async () => {
    // ★ THE FOLD EXISTS IN TWO PLACES, AND THIS PINS THE SERVER\u2019S COPY. The client
    //   computes the same fold to find a row\u2019s override, so a change here that is
    //   not made there does not fail \u2014 it silently stops matching, and the only
    //   symptom is a custom name that does not appear. Pinned on named strings the
    //   ledger actually carries rather than on an expression, so the test cannot be
    //   satisfied by re-deriving the expression it is testing.
    const entry = OVERRIDABLE.find((f) => f.subject === 'vendor' && f.field === 'name');
    assert.ok(entry, 'the registry has no vendor name entry');
    assert.equal(entry.keyOf('Arena Place Condominium Association, Inc'), 'ARENAPLACECONDOMINIUMASSOCIATIONINC');
    // ★ THE TRIM IS LOAD-BEARING. `PO_VENDORS` stores this one with a LEADING SPACE,
    //   so a fold without a trim would key it as ` CHICKFILA` and a reader who typed
    //   the name without the space would never find the override they saved.
    assert.equal(entry.keyOf('  chickfila'), 'CHICKFILA');
    assert.equal(entry.keyOf('Chick-Fil-A'), 'CHICKFILA', 'two spellings of one company must fold alike');
    assert.equal(entry.keyOf('---'), '', 'punctuation must fold to nothing, which the handler refuses');
  });

  // ---- The second subject: a field the ledger has no column for -------------
  //
  // ★ THIS IS A DIFFERENT SHAPE OF OVERRIDE AND NOT A SECOND COPY OF THE FIRST. Its
  //   identity is a number rather than a name, so its fold trims and does nothing else;
  //   its field is one the ledger does not hold at all; and the sentence a blank value
  //   is refused with has to say what the trash leaves behind, which for this field is
  //   an empty field rather than the ledger's value. All three are claims about the
  //   registry and the route, so all three are checked rather than inherited from the
  //   vendor entry's block above.

  const SITE_CUSTOM_PATH = '/api/custom-fields/vendor_site/email';
  /** Deliberately padded: the fold is a trim, and this is what proves it. */
  const SITE_PROBE_KEY_WRITTEN = '  999999001  ';
  const SITE_PROBE_KEY_FOLD = '999999001';

  const clearSiteProbeOverride = (): Promise<{ rowsAffected: number }> =>
    execute("DELETE FROM field_override WHERE subject_kind = 'vendor_site' AND subject_key = :key", {
      key: SITE_PROBE_KEY_FOLD,
    });

  await clearSiteProbeOverride();

  await check('the site fold trims and folds nothing else, and the registry says which', async () => {
    const entry = OVERRIDABLE.find((f) => f.subject === 'vendor_site' && f.field === 'email');
    assert.ok(entry, 'the registry has no vendor_site.email entry');
    // ★ A SITE ID IS ALREADY A KEY, SO THERE IS NOTHING TO FOLD — and the assertion is
    //   written so that reusing the vendor's fold here would fail rather than pass by
    //   coincidence. Ids are digits, so `foldVendorKey` would agree on every id the
    //   table holds today; what it would NOT do is accept the padded spelling, which is
    //   the only case a trim-only fold is for.
    assert.equal(entry.keyOf(SITE_PROBE_KEY_WRITTEN), SITE_PROBE_KEY_FOLD);
    assert.equal(entry.keyOf(SITE_PROBE_KEY_FOLD), SITE_PROBE_KEY_FOLD);
    // ★ THE FIXTURE THAT TELLS THE TWO FOLDS APART, AND WHY IT HAS TO BE SYNTHETIC. Site
    //   ids are digits, so on every id this table holds the vendor fold would return the
    //   same string as this one — a check written against a real id cannot distinguish
    //   them, which is precisely how a wrong fold survives a green suite. One
    //   hyphenated input does distinguish them: this fold trims and keeps the hyphen,
    //   the vendor fold strips it. The input is not a site id and does not need to be;
    //   the claim under test is about the function, not about the table. And the second
    //   line is the control: if the entry ever pointed at the vendor fold, exactly one
    //   of these two assertions would fail.
    assert.equal(entry.keyOf('  861598-a  '), '861598-a', 'this fold must not do the vendor fold\u2019s work');
    assert.equal(foldVendorKey('  861598-a  '), '861598A', 'the vendor fold is different on this input');
    assert.equal(entry.fromLedger, false, 'the email entry must declare that the ledger holds no value');
  });

  await check('PUT stores a site\u2019s email under the id, trimmed, and reads it back', async () => {
    const res = await authorized('PUT', SITE_CUSTOM_PATH, {
      token: superToken,
      body: { key: SITE_PROBE_KEY_WRITTEN, value: 'probe@example.invalid' },
    });
    // ── ★ THE STATUS IS CHECKED BY A BRANCH, NOT INSIDE AN `assert.equal` MESSAGE.
    //      The message argument is an ordinary template literal: it is evaluated
    //      BEFORE `assert.equal` is called, so a body read inside it happens on the
    //      PASSING path too — and it drains the response, so the `res.json()` below
    //      then threw `Body is unusable: Body has already been read` on a write that
    //      had in fact succeeded. The failure named nothing that was being tested.
    //      Same family as the notes at lines 773 and 3160: the body has to be read
    //      when the status is wrong, and only then.
    if (res.status !== 200) {
      throw new Error(`the write returned ${res.status}: ${await res.text()}`);
    }
    const body = (await res.json()) as {
      data: {
        subject: string;
        field: string;
        key: string;
        written: string;
        value: string;
        setBy: string;
        setAt: string;
      };
    };
    assert.equal(body.data.subject, 'vendor_site');
    assert.equal(body.data.field, 'email');
    // ★ THE KEY COMES BACK FOLDED AND THE SPELLING COMES BACK AS WRITTEN. Both are
    //   asserted because they are two different facts: the fold is what a later read
    //   matches on, and `written` is what a reader recognises in the Admin list.
    assert.equal(body.data.key, SITE_PROBE_KEY_FOLD, 'the key was not folded to the site id alone');
    assert.equal(body.data.written, SITE_PROBE_KEY_WRITTEN.trim());
    assert.equal(body.data.value, 'probe@example.invalid');
    assert.ok(body.data.setBy.trim().length > 0, 'the override names nobody');
    assert.match(body.data.setAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'setAt is not a database timestamp');
  });

  await check('CONTROL: the site\u2019s email is served under its own subject and no other', async () => {
    const mine = await authorized('GET', '/api/custom-fields?subject=vendor_site', { token: superToken });
    assert.equal(mine.status, 200, `the subject read returned ${mine.status}`);
    const found = (await mine.json()) as { data: { overrides: { key: string; value: string }[] } };
    assert.ok(
      found.data.overrides.some((o) => o.key === SITE_PROBE_KEY_FOLD),
      'the stored email is not served by the read the panel performs',
    );
    // ★ AND IT IS NOT CARRIED BY THE VENDOR READ, WHICH IS THE CONTROL THAT MATTERS.
    //   The page performs both reads; a route that answered every subject with every
    //   row would leave the page looking correct while the two subjects had quietly
    //   become one — and the email would then appear under whichever site happened to
    //   share the company's id, which no id ever does.
    const other = await authorized('GET', '/api/custom-fields?subject=vendor', { token: superToken });
    const wrong = (await other.json()) as { data: { overrides: { key: string }[] } };
    assert.ok(
      !wrong.data.overrides.some((o) => o.key === SITE_PROBE_KEY_FOLD),
      'a vendor_site override is being served by the vendor read',
    );
  });

  await check('CONTROL: a field on the new subject that the registry does not declare is 400', async () => {
    const res = await authorized('PUT', '/api/custom-fields/vendor_site/phone', {
      token: superToken,
      body: { key: SITE_PROBE_KEY_WRITTEN, value: '(404) 569-6130' },
    });
    assert.equal(res.status, 400, `an unlisted pair returned ${res.status}`);
    const body = (await res.json()) as {
      error: { code: string; details?: { overridable?: { subject: string; field: string }[] } };
    };
    assert.equal(body.error.code, 'BAD_REQUEST');
    // The refusal lists what IS overridable, so the check reads the registry back out
    // of the response rather than trusting the sentence.
    const listed = body.error.details?.overridable ?? [];
    assert.ok(
      listed.some((p) => p.subject === 'vendor_site' && p.field === 'email'),
      'the refusal does not name the field that can be overridden on this subject',
    );
    assert.ok(
      !listed.some((p) => p.field === 'phone'),
      'the refusal offers a pair the registry does not declare',
    );
  });

  await check('a blank value is refused, and each field is told what its OWN trash leaves', async () => {
    // ★ ONE REFUSAL, TWO TRUTHS. The route's sentence names the trash and says what
    //   pressing it gives back: the ledger's value on a field the ledger holds, an
    //   empty field on one it does not. Pinning BOTH is the point — a single message
    //   shared by the two subjects would be a well-formed lie for one of them, and it
    //   is the sentence a reader acts on.
    const held = await authorized('PUT', '/api/custom-fields/vendor/name', {
      token: superToken,
      body: { key: PROBE_KEY_WRITTEN, value: '   ' },
    });
    assert.equal(held.status, 400, `a blank vendor name returned ${held.status}`);
    const heldBody = (await held.json()) as { error: { code: string; message: string } };
    assert.equal(heldBody.error.code, 'BAD_REQUEST');
    assert.match(
      heldBody.error.message,
      /value the ledger holds/i,
      'the vendor refusal no longer says what the trash gives back',
    );

    const unheld = await authorized('PUT', SITE_CUSTOM_PATH, {
      token: superToken,
      body: { key: SITE_PROBE_KEY_WRITTEN, value: '   ' },
    });
    assert.equal(unheld.status, 400, `a blank email returned ${unheld.status}`);
    const unheldBody = (await unheld.json()) as {
      error: { code: string; message: string; details?: { howToDelete?: string } };
    };
    assert.equal(unheldBody.error.code, 'BAD_REQUEST');
    assert.match(
      unheldBody.error.message,
      /leave the field empty/i,
      'the email refusal must say the trash leaves an empty field — there is no Oracle value to return to',
    );
    assert.doesNotMatch(
      unheldBody.error.message,
      /value the ledger holds/i,
      'the email refusal is pointing at a ledger value that does not exist',
    );
    assert.ok(unheldBody.error.details?.howToDelete, 'the refusal must say how to delete');
  });

  await check('DELETE clears the email and leaves the field empty again', async () => {
    const res = await authorized(
      'DELETE',
      `${SITE_CUSTOM_PATH}?key=${encodeURIComponent(SITE_PROBE_KEY_WRITTEN)}`,
      { token: superToken },
    );
    // ★ THE BODY IS READ AFTER THE STATUS IS CHECKED, NEVER INSIDE THE ASSERTION'S
    //   MESSAGE — the message is built before the assertion runs, so a read in it
    //   drains the response on the passing path too and the call after it throws
    //   `Body is unusable` against a delete that worked. Same fix as its sibling.
    if (res.status !== 204) {
      throw new Error(`the delete returned ${res.status}: ${await res.text()}`);
    }
    const after = await authorized('GET', '/api/custom-fields?subject=vendor_site', {
      token: superToken,
    });
    const shown = (await after.json()) as { data: { overrides: { key: string }[] } };
    assert.ok(
      !shown.data.overrides.some((o) => o.key === SITE_PROBE_KEY_FOLD),
      'the email is still served after a 204 delete',
    );
  });

  await check('the custom-field probe left nothing behind', async () => {
    const rowsLeft = await rows<{ n: number }>(
      'SELECT COUNT(*) AS n FROM field_override WHERE subject_key = :key',
      { key: PROBE_KEY_FOLD },
    );
    assert.equal(rowsLeft[0]?.n, 0, 'the probe override survived the run');
    // ★ THE SECOND SUBJECT'S ROW IS LOOKED FOR TOO, and by its own folded key — the
    //   pre-clear at the top of the block removes it either way, so a leftover here
    //   means the run wrote a row the cleanup could not name.
    const siteRowsLeft = await rows<{ n: number }>(
      'SELECT COUNT(*) AS n FROM field_override WHERE subject_key = :key',
      { key: SITE_PROBE_KEY_FOLD },
    );
    assert.equal(siteRowsLeft[0]?.n, 0, 'the site probe override survived the run');
  });

  // ---- Controls: these MUST fail -----------------------------------------

  await check('CONTROL: an unknown path returns 404 NOT_FOUND', async () => {
    const res = await get('/api/there-is-no-such-endpoint');
    assert.equal(res.status, 404);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'NOT_FOUND');
  });

  await check('CONTROL: an invalid enum returns 400 VALIDATION_FAILED with issues', async () => {
    const res = await get('/api/meta/dictionary?type=pumpkin');
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: string; details?: { issues?: unknown[] } } };
    assert.equal(body.error.code, 'VALIDATION_FAILED');
    assert.ok(Array.isArray(body.error.details?.issues), 'validation failures must carry the issue list');
  });

  await check('CONTROL: a malformed JSON body is a 400, not a 500', async () => {
    const res = await fetch(`${base}/api/meta/dictionary`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json}',
    });
    // Locally writes are enabled, so the parse error surfaces; against a locked
    // remote the guard answers first with 409. Both are correct, neither is 500.
    assert.ok([400, 409].includes(res.status), `expected 400 or 409, got ${res.status}`);
    if (res.status === 400) {
      const body = (await res.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'BAD_REQUEST');
    }
  });

  await check(`CONTROL: a write is ${dbStatus().writable ? 'accepted as routable' : 'refused with 409'}`, async () => {
    const res = await fetch(`${base}/api/meta/config`, { method: 'POST' });
    if (dbStatus().writable) {
      // Writes are permitted, so the guard lets it through and routing rejects
      // it: there is no POST handler on this path.
      assert.equal(res.status, 404);
    } else {
      assert.equal(res.status, 409);
      const body = (await res.json()) as { error: { code: string } };
      assert.equal(body.error.code, 'WRITES_DISABLED');
    }
  });

  await check('CONTROL: the error envelope is uniform', async () => {
    const res = await get('/api/nope');
    const body = (await res.json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body), ['error']);
    const err = body.error as Record<string, unknown>;
    assert.ok('code' in err && 'message' in err);
  });

  // ---- Report -------------------------------------------------------------

  server.close();
  await closeDb();

  const total = passCount + failCount;
  const skipped = skipCount === 0 ? '' : `, ${skipCount} skipped`;
  console.log(`\n${failCount === 0 ? 'ALL CHECKS PASSED' : 'FAILURES'} — ${passCount}/${total} passed${skipped}\n`);
  process.exit(failCount === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\nSmoke harness threw before it could report:', e);
  process.exit(1);
});
