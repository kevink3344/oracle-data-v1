import { OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import type { ResponseConfig, RouteConfig } from '@asteasolutions/zod-to-openapi';
import type { OpenAPIObject } from 'openapi3-ts/oas30';
import { z } from './z.js';
import { ErrorBodySchema, PageMetaSchema } from '../schemas/common.js';
import { dbStatus } from '../db/client.js';

/**
 * The OpenAPI registry.
 *
 * Code-first, as chosen: every path is registered by the same call that mounts
 * the Express handler (`defineRoute` in `api.ts`), so a documented endpoint that
 * does not exist — or an endpoint that is not documented — is not a thing this
 * server can express. The alternative, a hand-written `openapi.yaml`, is only
 * ever as current as the last person to remember it.
 */

export const registry = new OpenAPIRegistry();

/** One source for the version, used by the spec and by `/api/health`. */
export const API_VERSION = '0.1.0';

registry.register('Error', ErrorBodySchema);
registry.register('PageMeta', PageMetaSchema);

/**
 * Shared error response.
 *
 * Built as a `$ref` to the `Error` **schema** rather than registered through
 * `registry.registerComponent('responses', …)`. The library's component
 * signatures are a union over OpenAPI 3.0 and 3.1, and a `ResponseConfig`
 * satisfies neither branch cleanly, so registering it needs a cast. Pointing at
 * the schema ref expresses the same thing with no cast at all — and the spec is
 * identical either way.
 */
export function errorResponse(): ResponseConfig {
  return {
    description:
      'Error envelope. `code` is stable and safe to branch on; `message` is for humans and may change.',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  };
}

/**
 * Tags are declared with a description so the Swagger UI groups endpoints the
 * same way the menu plan groups the application — by question, not by table.
 *
 * ★ ORDER IS THE GROUPING ORDER — `docs.ts` sets `tagsSorter: undefined` so this
 *   array is used as written rather than alphabetised. `Meta` therefore stays
 *   first because it is genuinely the thing to read first, and `Auth` sits beside
 *   it because "who am I" is the second question a reader of an API with sessions
 *   asks. Appending a tag that reads first would be silently reordered into
 *   second-to-last without this array being touched.
 */
export const TAGS = [
  { name: 'Meta', description: 'Health, provenance, and the data dictionary. Where to look first.' },
  { name: 'Auth', description: 'Signing in, and who the caller is.' },
  { name: 'Extract', description: 'The Oracle extract of record, and the database’s reading of it.' },
  { name: 'Projects', description: 'Projects, portfolios, and the unclaimed-combination queue.' },
  { name: 'Funding', description: 'Budgets, adjustments, changes, journals, and available funds.' },
  { name: 'Spend', description: 'Encumbrances, invoices, payments, and commitments against actuals.' },
  /*
   * ★ `Invoices` AND `Checks` ARE THEIR OWN SECTIONS, AND THEY SIT DIRECTLY AFTER
   *   `Spend` BECAUSE THAT IS WHERE THEY CAME FROM.
   *
   *   Both endpoints were originally tagged `Spend`, which grouped them with
   *   encumbrances and commitments against actuals. That is a defensible grouping by
   *   *question* — all four are about money leaving — but it buries the two live AP
   *   reads under four other endpoints, and they are the two a payables reader opens
   *   the document for.
   *
   *   ★ THE ORDER IS NOT COSMETIC: `docs.ts` sets `tagsSorter: undefined`, so this
   *     array IS the rendering order. Putting them here rather than at the end keeps
   *     the money questions together — Spend, then the two registers that answer the
   *     narrower version of it — instead of appending them after `AI`.
   *
   *   ★ AND THE DESCRIPTIONS SAY WHAT MAKES THEM DIFFERENT FROM THE REST OF THE
   *     DOCUMENT: both read the **live ledger**, not the frozen extract, and both
   *     re-emit the extract's own envelope. A reader who has used the other
   *     registers needs to know the response shape differs.
   */
  {
    name: 'Invoices',
    description:
      'The invoice register, live from the ledger. Answers with the extract’s own ' +
      '`body.ResultSets` envelope rather than this API’s `{ data }` shape, so a client that ' +
      'already reads `invoices.json` can point at it unchanged.',
  },
  {
    name: 'Checks',
    description:
      'The payments register, live from the ledger — one row per payment document, with the ' +
      'invoices each one settled. Same extract-shaped envelope as `Invoices`.',
  },
  { name: 'Procurement', description: 'Purchase orders, lines, shipments, distributions, and reference codes.' },
  { name: 'Vendors', description: 'Vendor companies, sites, and spend.' },
  { name: 'Chart of Accounts', description: 'Account combinations, the seven segments, periods, and balances.' },
  { name: 'Analysis', description: 'The five analysis questions, runnable against the live database.' },
  {
    name: 'Organizations',
    description:
      'The tenants this application serves — which fund, which programs, and from which fiscal year. ' +
      'Read after signing in, written only by a super admin.',
  },
  { name: 'Admin', description: 'App-owned tables: projects, overrides, portfolios, extract runs, users, and saved views.' },
  {
    name: 'AI',
    description:
      'Plain-English questions about the checks register. The model chooses *what* to measure; this ' +
      'server performs the measurement, so the figures are computed rather than generated.',
  },
] as const;

export type TagName = (typeof TAGS)[number]['name'];

/** `{ data: T }` — the shape of every single-object success response. */
export function dataEnvelope<T extends z.ZodTypeAny>(schema: T, name?: string): z.ZodTypeAny {
  const obj = z.object({ data: schema });
  return name ? obj.openapi(name) : obj;
}

/** `{ data: T[], page }` — the shape of every list response. */
export function listEnvelope<T extends z.ZodTypeAny>(schema: T, name?: string): z.ZodTypeAny {
  const obj = z.object({ data: z.array(schema), page: PageMetaSchema });
  return name ? obj.openapi(name) : obj;
}

/** A JSON response body wrapping a schema. */
export function jsonResponse(schema: z.ZodTypeAny, description: string): ResponseConfig {
  return { description, content: { 'application/json': { schema } } };
}

/** The standard error set. Declared once so no route forgets the 404 or the 500. */
export function errorResponses(...statuses: number[]): Record<string, ResponseConfig> {
  const out: Record<string, ResponseConfig> = {};
  for (const status of statuses) {
    out[String(status)] = errorResponse();
  }
  return out;
}

/** The whole document. Memoised — route registration happens once, at import. */
let cached: OpenAPIObject | null = null;

/**
 * ★ THE DOCUMENT HAS TO SAY WHERE EACH TABLE FAMILY LIVES.
 *
 * It used to state one target and one write policy, and a reader took that as the
 * scope of every endpoint in the document. With `APP_DB_URL` set, the EBS mirror
 * and the app-owned tables (`saved_view*`, `project`, `table_count_snapshot`) are
 * different databases with independent write policies — so one sentence would be
 * wrong about half the routes, and wrong in the direction that costs a reader a
 * confused half-hour (`POST /api/views` answers 201 while the banner says writes
 * are disabled).
 *
 * The single-store case keeps the original two sentences exactly, because that is
 * still the default and the common case, and a document that hedges when there is
 * nothing to hedge about is worse than one that does not.
 */
function documentStores(): string[] {
  const stores = dbStatus().stores;
  if (stores.length === 1) {
    const one = stores[0];
    if (one === undefined) return [];
    return [
      '',
      one.writable
        ? '**Writes are enabled** for this target.'
        : '**Writes are disabled** for this target — non-GET calls return 409 `WRITES_DISABLED`.',
    ];
  }
  return [
    '',
    '**Two stores are connected.** Which one an endpoint reads is decided by the table it ' +
      'names, not by the endpoint, so `writable` is a property of each store:',
    '',
    ...stores.map(
      (s) =>
        `- \`${s.id}\` — \`${s.target}\` (${s.dialect}), ` +
        `${s.writable ? 'writable' : 'read-only'}` +
        `${s.id === 'ledger' ? ', the EBS mirror and the derived views' : ', the app-owned tables'}`,
    ),
    '',
    'Routes that would write to a read-only store are **not registered at all** — a `POST` to a ' +
      'resource on the ledger is a 404, exactly as it is for any other absent path. That is why ' +
      'some resources in this document serve `GET` only; each one says so in its own description. ' +
      'A non-GET call when *neither* store is writable is refused earlier, with 409 ' +
      '`WRITES_DISABLED`.',
  ];
}

/**
 * ★ TWO ERROR CODES WERE MISSING FROM THIS DOCUMENT, SO THE DOCUMENT WAS WRONG.
 *
 * `WRITES_DISABLED` was described and `UNAUTHORIZED` and `FORBIDDEN` were not, which
 * was true while nothing could refuse a caller and became false the moment
 * `auth/guard.ts` existed. A reader who had only this page would have concluded that
 * a `401` was a bug in their client — the section above says the only refusal the API
 * makes is about *where* data lives, never about *who* is asking.
 *
 * The paragraph is deliberately blunt about the split, because the surprising half is
 * not that some routes need a session — it is that most do not. Saying "most endpoints
 * are open" without qualification would read as an admission rather than a scope, so it
 * names the two domains that are closed and the reason they are the ones that had to be.
 */
function documentIdentity(): string[] {
  return [
    '### Who is allowed to ask',
    '**Most endpoints here require no session at all** — the extract is read-only, public ' +
      'data and the whole point of the document is that it can be read. Two domains do ' +
      'require one, and they are the two whose subject *is* identity:',
    '- `POST /api/auth/sign-in` is open (it is how you get a session), and ' +
      '`GET /api/auth/session` answers **401** `UNAUTHORIZED` without a valid one.',
    '- Every route under `/api/organizations` requires a session **and** the `super_admin` ' +
      'role: **401** `UNAUTHORIZED` if nobody is signed in, **403** `FORBIDDEN` if somebody ' +
      'is and is only a member. The 403 names the role it saw in `details.role`.',
    '',
    'A session is carried in the `x-app-session` request header, **not** a cookie, so a ' +
      '*signed-out visitor still browses everything else in this document unchanged* — signing ' +
      'in changes which organizations you may edit, never what the ledger says.',
    '',
    '**`401` never says which of its causes applied** — no header, an unknown token, an expired ' +
      'token, and an account deleted since signing in are one indistinguishable answer, on ' +
      'purpose. `403` is the opposite: it is only ever raised after the identity was resolved, ' +
      'so it can afford to be specific.',
  ];
}

export function buildOpenApiDocument(): OpenAPIObject {
  if (cached) return cached;

  const generator = new OpenApiGeneratorV3(registry.definitions);
  cached = generator.generateDocument({
    openapi: '3.0.0',
    info: {
      title: 'Oracle Projects API',
      version: API_VERSION,
      description: [
        'Read/write API over the daily Oracle extract and the Turso/libSQL sample built from it.',
        '',
        `**Connected target:** \`${dbStatus().target}\` (mode \`${dbStatus().mode}\`).`,
        ...documentStores(),
        ...documentIdentity(),
        '### Envelopes',
        'Every endpoint answers in one of three shapes and never anything else:',
        '- single — `{ "data": { … } }`',
        '- list — `{ "data": [ … ], "page": { "limit", "offset", "total", "returned" } }`',
        '- error — `{ "error": { "code", "message", "details"? } }`',
        '',
        '### A note on what this data does *not* say',
        'The sample database is a surrogate built from seven partial extracts of different grains. ' +
        'Two consequences are visible in this API and are deliberate, not defects: the payables chain ' +
        '(`AP_*`) is empty, and reporting measures that Oracle computes — allocations, available funds — ' +
        'are supplied by views and are **derived**, not extracted. Endpoints that return a derived measure ' +
        'say so in their description.',
      ].join('\n'),
    },
    // Relative, so "Try it out" works whatever host and port the docs are served from.
    servers: [{ url: '/', description: 'This server' }],
    tags: [...TAGS],
  });

  return cached;
}

/** Only used by tests and `npm run openapi`; the cache is intentional in the server. */
export function resetOpenApiCache(): void {
  cached = null;
}

export type { RouteConfig };
