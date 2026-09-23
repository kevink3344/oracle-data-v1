import { Router } from 'express';
import { createApi } from '../http/api.js';
import { z, FlagQuery, isTrue } from '../http/z.js';
import { dbStatus, probeDb } from '../db/client.js';
import { quoteIdent, rows } from '../db/sql.js';
import { API_VERSION } from '../http/openapi.js';
import { config, DB_MODES, REPO_ROOT } from '../config/env.js';
import { storeForTable, tablesOfClass, type StoreId } from '../db/store.js';
import { ledgerPlan } from '../db/ledger-shape.js';
import { isDerivedTable } from '../db/derived.js';
import { scopeModeFor } from './activity.js';
import { registeredResources } from './resource.js';

/**
 * Meta: the endpoints that describe the server and the database, rather than
 * reading data out of it. Kept deliberately free of any dependence on a *working*
 * database, because they are what you reach for when it is not working.
 */

/**
 * Every ledger object a read cap can be written for.
 *
 * ★ IT IS THE SAME SET THE READ-CAP REGISTER OFFERS, DERIVED FROM THE SAME PLACE.
 *   `routes/readCaps.ts` builds its list from `tablesOfClass('EBS')`, which is the store
 *   registry's own classification — so this is not a second copy of that list, it is the
 *   same query. A hand-written list here would be the fifth copy of a registry this
 *   project has already had to reconcile four times (see the ★ block on
 *   `ROUTING_APP_TABLES`), and the drift would show up as exactly the symptom that
 *   prompted this: a cappable object with no row on the sign-in card.
 *
 * ★ `DUAL` IS EXCLUDED BECAUSE IT IS NOT A LEDGER OBJECT. It is Oracle's one-row dummy
 *   table, it is in the registry so that `SELECT 1 FROM DUAL` routes correctly, and
 *   offering a read cap for it would be offering a cap on the constant 1. The read-cap
 *   register filters it for the same reason.
 */
function ledgerCapTables(): string[] {
  return tablesOfClass('EBS').filter((t) => t !== 'DUAL');
}

const HealthSchema = z
  .object({
    ok: z.boolean().openapi({
      description: 'True whenever this endpoint answers at all — it being false is a shape you never receive.',
      example: true,
    }),
    dbReady: z.boolean().openapi({
      description:
        'Whether the database answered the probe. `ok:true, dbReady:false` means the API is up and ' +
        'the database is not — a distinction that matters, because the remedies are different.',
    }),
    latencyMs: z.number().int().nullable().openapi({ description: 'Round trip of the probe just performed.' }),
    db: z.object({
      // Derived, not written out. See `DB_MODES` — a hand-written copy of this
      // list is how `oracle` came to be missing from the published document.
      mode: z.enum(DB_MODES),
      /** Host for a remote target, path for a local one. Never a credential. */
      target: z.string(),
      writable: z.boolean().openapi({
        description:
          'Whether non-GET requests are accepted somewhere. Per-store policy is in `stores`; this is ' +
          'true when any store accepts writes.',
      }),
      lastProbeMs: z.number().int().nullable(),
      error: z.string().nullable(),
      /**
       * ★ ONE ENTRY PER STORE. The ledger and the app-owned tables can be different
       *   databases, and they can hold opposite write policies — Oracle outside, a
       *   writable local file inside. A single `target`/`writable` pair cannot
       *   describe that, and it described the wrong half: a health check reading
       *   only those two fields reported "up and read-only" while saved views were
       *   either unreachable or perfectly writable. A client that reads only the
       *   old fields still sees the ledger, which is what they always meant.
       */
      stores: z.array(
        z.object({
          id: z.enum(['ledger', 'app']),
          target: z.string(),
          dialect: z.enum(['sqlite', 'oracle']),
          writable: z.boolean(),
          /** True when this entry and the other are the same database. */
          shared: z.boolean(),
          ok: z.boolean(),
          lastProbeMs: z.number().int().nullable(),
          error: z.string().nullable(),
        }),
      ),
    }),
    version: z.string(),
    uptimeSeconds: z.number().int(),
  })
  .openapi('Health');

const DictionaryObjectSchema = z
  .object({
    name: z.string(),
    type: z.enum(['table', 'view']),
    /** Only populated when `counts=true` was asked for. */
    rowCount: z.number().int().nullable(),
    columns: z.array(
      z.object({
        ordinal: z.number().int(),
        name: z.string(),
        declaredType: z.string().nullable(),
        notNull: z.boolean(),
        defaultValue: z.string().nullable(),
        primaryKey: z.boolean(),
      }),
    ),
  })
  .openapi('DictionaryObject');

const DictionaryQuerySchema = z.object({
  counts: FlagQuery.optional().openapi({
    description:
      'Include a `COUNT(*)` per object. Off by default: against the remote target that is one round ' +
      'trip per object, which is slow enough to matter and rarely needed.',
  }),
  type: z.enum(['all', 'table', 'view']).default('all'),
});

const LedgerSummaryQuerySchema = z.object({
  counts: FlagQuery.optional().openapi({
    description:
      'Take a `COUNT(*)` per object. **Off by default**, and the default is what the sign-in ' +
      'screen uses: that card is answered before anyone has signed in, and counting 34 objects ' +
      'over a ledger of 197 M rows (157 M of them in `GL_BALANCES`) is the slowest read in the ' +
      'app — measured at 51–397 s. The card only needs to say how many tables the ledger has, ' +
      'which is a fact about the descriptor list rather than about the rows. Pass `counts=true` ' +
      'to get the figures; the Activity page does, because a register with a wait behind a ' +
      'signed-in session is a different proposition from a sign-in card.',
  }),
});

const LedgerSummarySchema = z
  .object({
    /** The store the ledger objects are counted in. A host for a remote target, never a credential. */
    target: z.string(),
    /** Where the app-owned objects live. Equal to `target` when nothing separates the two stores. */
    appTarget: z.string(),
    /**
     * When the counts below were taken, ISO 8601 — or `null` when no counts were taken.
     *
     * ★ `null` IS THE HONEST ANSWER FOR A NAMES-ONLY PAYLOAD, AND IT IS NOT `now`.
     *   The sign-in card asks for `counts=false`, so there is no instant to report and
     *   no figure for a date to qualify. Stamping the request time here would put a
     *   date on a number that does not exist — the same mistake, in the same shape, as
     *   reading an uncountable table as an empty one.
     *
     * ★ AND WHEN THERE ARE COUNTS, THE CLIENT HAS TO BE ABLE TO SAY WHICH FIGURE IT IS
     *   SHOWING. This endpoint answers the sign-in screen's ledger block, so it is
     *   requested before anyone has signed in and again on every reload of that screen.
     *   Each request used to take its own pass of 34 counts over a ledger holding 197 M
     *   rows (`GL_BALANCES` alone is 157 M), one statement at a time, measured at
     *   51–204 s — so a few reloads were a few long identical passes running at once,
     *   against a pool of 8. That is what left the screen on "Counting the ledger…".
     *   The pass is now taken once per scope and served for `LEDGER_COUNT_TTL_MS`.
     *   The price is staleness, and this field is what keeps the price visible
     *   rather than turning a remembered number into a presented-as-measured one.
     */
    countedAt: z.string().nullable(),
    /**
     * What the counts were narrowed to, read from configuration. `null` when
     * configuration declares no fund, because this endpoint is answered before any
     * organization has been chosen and there is therefore no tenant row to ask.
     *
     * ★ `programs: null` IS NOT `programs: []`, AND THE DIFFERENCE IS THE POINT.
     *   `[]` means *no program filter was wanted* (`PROGRAM_CODE=none`), so the count
     *   is every program under the funds and is complete. `null` means the file said
     *   nothing, so the program list belongs to the organization row — which is not
     *   readable before sign-in. The count is then by fund alone, a **superset** of
     *   what the app will read once a scope is resolved, and the payload says so
     *   rather than presenting the wider figure as the narrower one.
     */
    scope: z
      .object({
        funds: z.array(z.string()),
        programs: z.array(z.string()).nullable(),
        /** Compared against the fiscal year a period *ends* in. `null` = no floor applied. */
        startYear: z.number().int().nullable(),
      })
      .nullable(),
    objects: z.array(
      z.object({
        /** The physical name, as the descriptor declares it. */
        name: z.string(),
        /**
         * The descriptor's human label, so a reader is not shown `GL_CODE_COMBINATIONS`.
         */
        label: z.string(),
        /** Which of the two stores the `COUNT(*)` was taken in. */
        store: z.enum(['ledger', 'app']),
        /**
         * `null` means *not countable*, which is not the same as `0` — and with
         * `counts=false` it is also `null` on every object, because no count was asked
         * for. Those are different reasons for the same absence, and the payload keeps
         * them apart with `countedAt`: a stamp means the pass ran and this object
         * answered nothing, while `countedAt: null` means no pass ran at all.
         */
        rowCount: z.number().int().nullable(),
        /**
         * How the count was narrowed to the account scope — or `null` where the object
         * carries no account, in which case `rowCount` is the whole object and nothing
         * about it follows `FUND_CODE`.
         *
         *   `derived`  — a composed view; the scope is inside the fragment (`db/derived.ts`),
         *                so `rowCount` is already the narrowed figure
         *   `segments` — the object carries `SEGMENT1`/`SEGMENT3` and is filtered directly
         *   `lookup`   — narrowed through `GL_CODE_COMBINATIONS` by `CODE_COMBINATION_ID`
         */
        scopeMode: z.enum(['derived', 'segments', 'lookup']).nullable(),
        /** `true` only where a fund predicate actually ran, so a claim of scope is checkable. */
        scoped: z.boolean(),
        /**
         * Rows this object contributed *inside* the scope, or `null` where no predicate
         * applied. For `derived` it equals `rowCount` (the fragment is the scope); for
         * the other modes it is the narrower of the two; for `scopeMode: null` it is
         * `null`, which is *not applicable* rather than *zero*.
         */
        scopedRowCount: z.number().int().nullable(),
      }),
    ),
    /**
     * Rows across the ledger objects that could be counted — `null` when no counts were
     * taken. Excludes the app store.
     */
    ledgerRecords: z.number().int().nullable(),
    /**
     * Rows across the app-owned objects. Reported separately, never added to the figure
     * above. `null` when no counts were taken.
     */
    appRecords: z.number().int().nullable(),
    /**
     * Rows across the objects the scope actually narrowed. Excludes every object with
     * no account to narrow by, so a reader can see how much of `ledgerRecords` the
     * `FUND_CODE` setting can reach at all. `null` when no counts were taken.
     */
    scopedRecords: z.number().int().nullable(),
    /**
     * How many objects carry no account, so their rows are outside `scopedRecords`.
     * `null` when no counts were taken.
     */
    unscopedObjects: z.number().int().nullable(),
    /**
     * How many objects answered no count at all, so a short total is visibly short.
     * `null` when no counts were taken — which is not the same as `0` uncounted, and is
     * why this is not defaulted to zero for the names-only payload.
     */
    uncounted: z.number().int().nullable(),
    /**
     * How many objects the summary lists, so a caller that asked for no counts still has
     * the figure the card is built on. Derived from the descriptor list, not from a
     * `COUNT(*)`, so it costs nothing and is exact.
     */
    objectCount: z.number().int(),
  })
  .openapi('LedgerSummary');

interface ObjectRow {
  name: string;
  type: string;
}

interface ColumnRow {
  object_name: string;
  ordinal: number;
  column_name: string;
  declared_type: string | null;
  is_not_null: number;
  default_value: string | null;
  is_pk: number;
}

export function metaRouter(): Router {
  const api = createApi();

  api.route({
    method: 'get',
    path: '/api/health',
    operationId: 'getHealth',
    summary: 'Liveness and database readiness',
    description:
      'Always answers, even when the database is unreachable — that is the whole point. ' +
      'Poll this rather than assuming a failed request means the API is down.',
    tags: ['Meta'],
    response: HealthSchema,
    handler: async () => {
      const probe = await probeDb();
      const status = dbStatus();
      return {
        ok: true,
        dbReady: probe.ok,
        latencyMs: probe.ms,
        db: {
          mode: status.mode,
          target: status.target,
          writable: status.writable,
          lastProbeMs: status.lastProbeMs,
          error: status.error,
          stores: status.stores,
        },
        version: API_VERSION,
        uptimeSeconds: Math.floor(process.uptime()),
      };
    },
  });

  api.route({
    method: 'get',
    path: '/api/meta/dictionary',
    operationId: 'getDataDictionary',
    summary: 'Every table and view with its columns',
    description:
      'The live schema, read from `sqlite_master` rather than from the DDL files. Use it to check what a ' +
      'resource actually exposes before writing a query — the sample is assembled from seven extracts of ' +
      'different grains, so the tables that exist are not always the ones a name would suggest. ' +
      '★ **It describes the app-owned store**, because `sqlite_master` is a SQLite catalogue and the only ' +
      'store that is guaranteed to be one. When `APP_DB_URL` separates the stores, this endpoint lists the ' +
      'app tables — `saved_view*`, `project`, `table_count_snapshot` — and not the EBS mirror; with ' +
      '`counts=true` each listed object is counted in the store that owns it. The two-store case is named ' +
      'in `/api/meta/config` as `appDbTarget` and `appDbShared`.',
    tags: ['Meta'],
    query: DictionaryQuerySchema,
    response: DictionaryObjectSchema,
    paginated: true,
    handler: async ({ query }) => {
      const typeFilter = query.type === 'all' ? null : query.type;

      const objects = await rows<ObjectRow>(
        `SELECT name, type
           FROM sqlite_master
          WHERE type IN ('table', 'view')
            AND name NOT LIKE 'sqlite_%'
            AND (:type IS NULL OR type = :type)
          ORDER BY type DESC, name ASC`,
        { type: typeFilter },
      );

      const columns = await rows<ColumnRow>(
        `SELECT m.name            AS object_name,
                p.cid             AS ordinal,
                p.name            AS column_name,
                p.type            AS declared_type,
                p."notnull"       AS is_not_null,
                p.dflt_value      AS default_value,
                p.pk              AS is_pk
           FROM sqlite_master m
           JOIN pragma_table_info(m.name) p
          WHERE m.type IN ('table', 'view')
            AND m.name NOT LIKE 'sqlite_%'
          ORDER BY m.name ASC, p.cid ASC`,
      );

      const byObject = new Map<string, ColumnRow[]>();
      for (const c of columns) {
        const list = byObject.get(c.object_name);
        if (list) list.push(c);
        else byObject.set(c.object_name, [c]);
      }

      let counts = new Map<string, ObjectCount>();
      if (isTrue(query.counts)) {
        // No descriptor describes these names — they come from `sqlite_master` — so
        // there are no declared columns to resolve against. See `countObjects`.
        //
        // ★ AND SO THEY ARE ALSO NEVER NARROWED, which is right for this route: a
        //   dictionary is a description of the schema, and a schema is not fund 04.
        //   `columns: []` cannot classify an object, so every count here is whole.
        counts = await countObjects(objects.map((o) => ({ name: o.name, columns: [] })));
      }

      const items = objects.map((o) => ({
        name: o.name,
        type: o.type === 'view' ? ('view' as const) : ('table' as const),
        rowCount: counts.get(o.name)?.rowCount ?? null,
        columns: (byObject.get(o.name) ?? []).map((c) => ({
          ordinal: c.ordinal,
          name: c.column_name,
          declaredType: c.declared_type,
          notNull: c.is_not_null === 1,
          defaultValue: c.default_value,
          primaryKey: c.is_pk > 0,
        })),
      }));

      return {
        items,
        meta: {
          limit: items.length,
          offset: 0,
          total: items.length,
          returned: items.length,
        },
      };
    },
  });

  api.route({
    method: 'get',
    path: '/api/meta/config',
    operationId: 'getServerConfig',
    summary: 'How this server is configured',
    description:
      'The resolved configuration, with anything sensitive omitted. Exists so that "which database am I ' +
      'actually talking to?" is a question with an answer, rather than a guess from behaviour.',
    tags: ['Meta'],
    response: z
      .object({
        dbMode: z.enum(DB_MODES),
        dbTarget: z.string(),
        allowRemoteWrites: z.boolean(),
        /** Where the app-owned tables live. Equal to `dbTarget` when nothing separates them. */
        appDbTarget: z.string(),
        /** True when the app store *is* the ledger — the default, and every pre-`APP_DB_URL` config. */
        appDbShared: z.boolean(),
        /** Whether the app store accepts writes. A different question from `allowRemoteWrites`. */
        appDbWritable: z.boolean(),
        cors: z.union([z.literal('*'), z.array(z.string())]),
        port: z.number().int(),
        host: z.string(),
        nodeEnv: z.string(),
        repoRoot: z.string(),
        viewBuilder: z
          .object({
            enabled: z.boolean(),
            maxRows: z.number().int(),
            timeoutMs: z.number().int(),
          })
          .openapi('ViewBuilderConfig'),
        /**
         * The ledger-scope *overrides* this deployment declares in `.env`.
         *
         * ★ NAMED "OVERRIDE" ON PURPOSE. These are not the scope in effect — the
         *   `organization` row supplies whatever is absent here, and the effective
         *   scope is the two combined per field. Publishing the declaration under a
         *   name like `fund` would invite exactly the misreading this endpoint
         *   exists to prevent, and would contradict the Organization screen, which
         *   truthfully shows the row. The startup log prints the resolved scope and
         *   any disagreement between the two.
         */
        ledgerScope: z
          .object({
            /** `null` = this file is silent, so the organization row's fund applies. */
            fundOverride: z.union([z.array(z.string()), z.null()]),
            /** `null` = silent (row's programs apply). `[]` = no program filter at all. */
            programOverride: z.union([z.array(z.string()), z.null()]),
            /** `null` = silent. Otherwise a *fiscal* year: 2021 admits from 2020-07-01. */
            startYearOverride: z.union([z.number().int(), z.null()]),
            /** The row ceilings, which are not overridable by the row. */
            glBalancesMaxRecords: z.number().int(),
            allMaxRecords: z.number().int(),
          })
          .openapi('LedgerScopeConfig'),
      })
      .openapi('ServerConfig'),
    handler: async () => ({
      dbMode: config.db.mode,
      dbTarget: config.db.label,
      allowRemoteWrites: config.db.allowWrites,
      // ★ THE OLD PAYLOAD ANSWERED "WHICH DATABASE AM I TALKING TO?" WITH ONE PATH.
      //   That question now has two answers, and which one a given endpoint uses
      //   depends on the table it reads. Publishing only the ledger's made the
      //   app-store answer invisible exactly when it is worth seeing — the moment
      //   `APP_DB_URL` stops being the default. `appDbShared` exists so a reader can
      //   tell "one database, reported twice" from "two databases that happen to
      //   share a label".
      appDbTarget: config.appDb.label,
      appDbShared: config.appDb.shared,
      appDbWritable: config.appDb.allowWrites,
      cors: config.corsOrigins === true ? ('*' as const) : config.corsOrigins,
      port: config.port,
      host: config.host,
      nodeEnv: config.nodeEnv,
      repoRoot: REPO_ROOT,
      // Read from the server rather than duplicated in the client, so the
      // builder's "showing 200 of …" and the cap that actually applied cannot
      // disagree. A disabled builder is reported as such rather than as a
      // missing screen — those are different problems.
      viewBuilder: {
        enabled: config.viewBuilder.enabled,
        maxRows: config.viewBuilder.maxRows,
        timeoutMs: config.viewBuilder.timeoutMs,
      },
      // ★ THE CEILINGS ARE REPORTED FROM THE SERVER, NOT DUPLICATED IN THE CLIENT,
      //   for the same reason as `viewBuilder.maxRows` above: a screen that says
      //   "truncated at 20,000,000" must be reading the ceiling that actually
      //   applied. A ceiling an operator can see is one they can argue with; one
      //   they can only infer from a missing row is not.
      ledgerScope: {
        fundOverride: config.ledgerScope.funds ?? null,
        programOverride: config.ledgerScope.programs ?? null,
        startYearOverride: config.ledgerScope.startYear ?? null,
        glBalancesMaxRecords: config.ledgerScope.glBalancesMaxRecords,
        allMaxRecords: config.ledgerScope.allMaxRecords,
      },
    }),
  });

  api.route({
    method: 'get',
    path: '/api/meta/ledger-summary',
    operationId: 'getLedgerSummary',
    summary: 'Every registered object, with its row count only when asked for',
    description:
      'The descriptor list the app serves, and — with `counts=true` — a `COUNT(*)` per object, ' +
      'each taken in the store that owns it. The store is the point of the endpoint rather than ' +
      'an implementation detail: `table_count_snapshot` and `/api/meta/dictionary` both *describe* ' +
      'the app store, because `sqlite_master` is a SQLite catalogue; neither can say how much the ' +
      'ledger holds. This one reports the ledger, and keeps the app-owned objects in the payload ' +
      'with `store` set to `app` rather than dropping them — a total that silently excluded two ' +
      'of the objects it named would be the same class of error as a total that silently included ' +
      'them.\n\n' +
      '★ **`counts` IS OFF BY DEFAULT, AND THE DEFAULT IS THE SIGN-IN CARD\'S ANSWER.** Counting ' +
      'all 34 objects means a `COUNT(*)` over `GL_BALANCES` at 157 M rows plus two composed views ' +
      'at ~13 s each, and the measured cost of one pass is 51 s / 67.5 s / 95.5 s / 204.3 s / ' +
      '397.3 s / 307.7 s — the last of which lost its connection before answering. That was being ' +
      'paid, on every load, by a page nobody had signed in to yet. Parallelising the count loop ' +
      'did not rescue it, so the card now asks for the shape of the ledger (`objectCount`, ' +
      '`scope`, `target`) and leaves the figures to a caller inside a session. Every row-count ' +
      'field is still present and is `null` when no pass ran, so one response shape serves both ' +
      'callers and an absent figure cannot be read as a zero.\n\n' +
      '★ EACH COUNT IS TAKEN FROM THE SOURCE THE OBJECT IS *SERVED* FROM, resolved by ' +
      '`ledgerPlan()` exactly as a list resource resolves it. That matters for the three reporting ' +
      'views, which have no table on Oracle and are composed from predicates in `db/derived.ts`: ' +
      'counting the bare name failed for all three, so this endpoint reported `uncounted: 3` and a ' +
      'total 72,370 rows short of what `npm run ledger:scale` measures for the same 32 objects. ' +
      '`rowCount: null` therefore means genuinely *unreadable on this deployment* — the ledger:scale ' +
      'script reports that case by name as `not granted`.\n\n' +
      '★ AND EACH COUNT FOLLOWS THE ACCOUNT SCOPE **WHERE THE OBJECT HAS AN ACCOUNT TO NARROW BY**, ' +
      'which is the difference between a figure that follows `FUND_CODE` and one that merely ' +
      'acknowledges it. Each object reports `scopeMode` and `scopedRowCount` beside its `rowCount`:\n\n' +
      '- `segments` — the object carries `SEGMENT1`/`SEGMENT3` and is filtered on them directly;\n' +
      '- `lookup` — it carries `CODE_COMBINATION_ID`, and is narrowed through the combinations that ' +
      'hold those segments;\n' +
      '- `derived` — a composed view; the scope is inside its fragment, so `rowCount` is already narrowed;\n' +
      '- `null` — **it carries no account at all**, so its count is the whole object and **nothing ' +
      'about it follows `FUND_CODE`**. A vendor is not in a fund. These rows are excluded from ' +
      '`scopedRecords` and counted in `unscopedObjects` rather than being quietly folded into a total ' +
      'that claims to be scoped.\n\n' +
      '`scope` states what was applied, read from configuration. It is `null` when no fund is ' +
      'configured, because this endpoint is answered **before any organization is chosen** and there ' +
      'is no tenant row to ask. Within it, `programs: null` means the file was silent so the program ' +
      'list belongs to that tenant row — the count is then by fund alone, a **superset** of what the ' +
      'app will read once a scope is resolved — while `programs: []` means *no program filter was ' +
      'wanted*, which is a complete answer.\n\n' +
      '★ WHAT IS *NOT* NARROWED HERE, SO THE ABSENCE IS NOT MISTAKEN FOR AN OVERSIGHT: the ' +
      'fiscal-year floor. `PERIOD_YEAR` lives on `GL_BALANCES` and the period tables, not on the ' +
      'hundreds of others, so applying it as a blanket predicate would name a column most of these ' +
      'objects do not have. The three composed views do carry it, because they are composed with it.',
    tags: ['Meta'],
    query: LedgerSummaryQuerySchema,
    response: LedgerSummarySchema,
    handler: async ({ query }) => {
      // ★ DEDUPED BY TABLE AND SORTED HERE, NOT IN THE DATABASE, BECAUSE THE LIST IS THE
      //   DESCRIPTORS. Several resources can point at one table, and counting it once per
      //   descriptor would inflate the total by the number of screens that show it.
      const described = [...new Map(registeredResources().map((r) => [r.table, r])).values()].map(
        (r) => ({
          name: r.table,
          label: r.label,
          store: storeForTable(r.table),
          /*
           * ★ CARRIED SO THE COUNT CAN RESOLVE THE OBJECT THE WAY A RESOURCE DOES.
           *   See `countObjects`. Dropped again when the payload is built, because
           *   the response is a name, a label, a store and a number — the columns
           *   are here to resolve a read source, not to be served.
           */
          columns: r.columns,
        }),
      );

      /*
       * ★ ★ THE LIST IS THE DESCRIPTORS *UNIONED WITH* THE CAP REGISTRY, AND THE UNION
       *   IS THE FIX FOR A REAL GAP.
       *
       *   This handler used to list `registeredResources()` alone — 32 objects. But the
       *   read-cap registry governs **50**, because it also covers the objects the live
       *   routes read by hand: every `WCSEXP_*` view, plus `AP_INVOICE_LINES_ALL` and
       *   `AP_INVOICE_DISTRIBUTIONS_ALL`. Those have no descriptor, so a cap could be
       *   set on one and the card would never show it — the cap would count toward the
       *   headline total while no row carried it. Reported exactly that way: *"I do not
       *   see all of the tables listed, for example AP_INVOICE_LINES_ALL has a row limit
       *   but does not show up in the list. Same for the WCSEXP views."*
       *
       *   ★ THE UNION IS TAKEN HERE RATHER THAN IN THE CLIENT, BECAUSE THE CLIENT CANNOT
       *     DO IT. The cap registry knows the object's *name*; only the store registry
       *     knows which store it lives in, and only the descriptor list knows a human
       *     label. A client-side merge would have to invent both.
       *
       *   ★ AND THE EXTRA OBJECTS ARE LABELLED BY THEIR OWN NAME, WHICH IS HONEST RATHER
       *     THAN LAZY. A descriptor carries a label like `Purchase-order line`; a view
       *     the payables routes read has no such label because no screen names it. Using
       *     the table name as the label says "this is a ledger object, and here is what
       *     it is called" — which is true — instead of inventing a description nobody
       *     wrote.
       *
       *   ★ `storeForTable` IS CALLED FOR THE EXTRAS TOO, AND IT THROWS ON AN UNKNOWN
       *     NAME. That is the behaviour we want: every name in the cap registry is
       *     registered by construction (the registry is what `storeForTable` reads), so a
       *     throw here would mean the two lists had genuinely diverged — a loud failure
       *     at the point of the mistake rather than a silently missing row.
       */
      const byName = new Map(described.map((o) => [o.name.toUpperCase(), o]));
      for (const name of ledgerCapTables()) {
        if (byName.has(name.toUpperCase())) continue;
        byName.set(name.toUpperCase(), {
          name,
          label: name,
          store: storeForTable(name),
          // No descriptor, so no declared columns: the count resolves the object by its
          // own name rather than through a read source. See `countObjects`.
          columns: [],
        });
      }
      const objects = [...byName.values()].sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      );

      const scope = declaredScope();

      /*
       * ★ THE COUNTS ARE OPT-IN, AND THE DEFAULT IS THE SIGN-IN CARD'S ANSWER.
       *
       *   This endpoint was built to say how much the ledger holds, and the sign-in
       *   screen asked for that on every load of a page nobody has signed in to yet.
       *   The cost is 34 `COUNT(*)` statements, one of them over `GL_BALANCES` at
       *   157 M rows, and it was measured at 51 s, 67.5 s, 95.5 s, 204.3 s, 397.3 s
       *   and 307.7 s across takes — the last of which did not even return, the
       *   connection dropping mid-pass. Parallelising the loop (see `countObjects`)
       *   did not rescue it, which is the measurement that settled this: the figure
       *   is not worth the wait on a pre-auth screen.
       *
       *   So the card asks for the shape of the ledger — how many tables, which store,
       *   what scope — and `counts=true` is for a caller inside a session that has
       *   asked for figures. The row-count fields stay in the payload as `null` rather
       *   than being dropped, so one response shape serves both callers and a reader
       *   cannot mistake an absent field for a zero.
       */
      const wantCounts = isTrue(query.counts);
      const pass = wantCounts ? await countedObjects(objects) : null;
      const counts = pass?.counts ?? new Map<string, ObjectCount>();
      const counted = objects.map(({ name, label, store }) => {
        const c = counts.get(name);
        return {
          name,
          label,
          store,
          rowCount: c?.rowCount ?? null,
          scopeMode: c?.scopeMode ?? null,
          // ★ AN OBJECT THAT WAS NEVER COUNTED REPORTS `scoped: false`, NOT *SCOPED*.
          //   "We could not count it" and "we counted it whole" are different facts
          //   and the payload keeps them apart: the first is `rowCount: null` with
          //   no mode, the second is a number with `scopeMode: null`.
          scoped: c?.scoped ?? false,
          scopedRowCount: c?.scopedRowCount ?? null,
        };
      });
      const totalIn = (store: StoreId) =>
        counted.reduce((sum, o) => (o.store === store ? sum + (o.rowCount ?? 0) : sum), 0);

      return {
        target: config.db.label,
        appTarget: config.appDb.label,
        countedAt: pass ? new Date(pass.at).toISOString() : null,
        scope,
        objects: counted,
        /*
         * ★ THE TOTALS ARE `null` WHEN NO PASS RAN, AND THAT IS NOT A DEFAULTED ZERO.
         *   `counts=false` means these questions were not asked, so the answer is
         *   "not measured" — and a `0` here would be read as "the ledger is empty",
         *   which is exactly the confusion `rowCount: null` exists to prevent one
         *   level down. The `ledgerRecords` figure is also the one that would be
         *   80% wrong if it silently omitted `GL_BALANCES`, so it is better absent
         *   than partial.
         */
        ledgerRecords: pass ? totalIn('ledger') : null,
        appRecords: pass ? totalIn('app') : null,
        /*
         * ★ THE TWO TOTALS ARE DELIBERATELY NOT THE SAME QUESTION, AND BOTH ARE
         *   SERVED. `ledgerRecords` is what the objects hold; `scopedRecords` is how
         *   much of that the `FUND_CODE` setting can even reach. A single figure
         *   would have to pick one and let the reader assume the other — and the
         *   reader who is asking whether the page honours the restriction is asking
         *   the second question.
         */
        scopedRecords: pass ? counted.reduce((sum, o) => sum + (o.scopedRowCount ?? 0), 0) : null,
        unscopedObjects: pass
          ? counted.filter((o) => o.rowCount !== null && o.scopeMode === null).length
          : null,
        uncounted: pass ? counted.filter((o) => o.rowCount === null).length : null,
        /*
         * ★ THE ONE FIGURE THE NAMES-ONLY PAYLOAD CAN STILL GIVE EXACTLY.
         *   It is a count of the descriptor list, not a `COUNT(*)`, so it is free and
         *   it is the number the sign-in card is built on. Deriving it from the rows
         *   would make the card's headline depend on the very read that was removed.
         */
        objectCount: counted.length,
      };
    },
  });

  return api.router;
}

/** One object to count: the name a reader sees, and the columns its descriptor declares. */
interface CountTarget {
  readonly name: string;
  /** `[]` for an object no descriptor describes. */
  readonly columns: readonly string[];
  /**
   * The store the object is served from, when the caller knows it. Absent means
   * *unknown*, and an unknown store is never narrowed: the rules below are the
   * **ledger's** rules, and applying them to a table that is not the ledger's would
   * be inventing a filter over rows that never had a fund.
   */
  readonly store?: StoreId;
}

/** How one object's rows divide between the whole object and the account scope. */
interface ObjectCount {
  /** The whole object, or `null` where it could not be counted at all. */
  rowCount: number | null;
  /** Rows the scope kept, or `null` where no predicate applied — *not applicable*, not zero. */
  scopedRowCount: number | null;
  scopeMode: 'derived' | 'segments' | 'lookup' | null;
  scoped: boolean;
}

/**
 * ★ THE COUNTS ARE NARROWED TO THE ACCOUNT SCOPE, WHICH THEY WERE NOT BEFORE.
 *
 *   This endpoint is the sign-in screen's figure, and it used to count every object
 *   whole: `SELECT COUNT(*) FROM <object>`, a statement **no fund appears in**. So
 *   `GL_BALANCES` was reported at its full 157,150,828 rows while `FUND_CODE=04`
 *   narrows the register to a fraction of that, and the screen had to *disclaim* the
 *   difference in prose ("the account scope narrows what the registers read rather
 *   than what these figures say") because the number itself did not follow the
 *   setting. A figure that has to be explained away is the wrong figure.
 *
 *   Three cases, and only the first two can follow the setting:
 *
 *     `segments` — the object carries `SEGMENT1`/`SEGMENT3` itself
 *     `lookup`   — it carries `CODE_COMBINATION_ID`, so it is narrowed through
 *                  `GL_CODE_COMBINATIONS`, the only object that holds the segments
 *                  for a combination
 *     `null`     — it carries neither, and **cannot be narrowed at all**. A vendor
 *                  is not in a fund; asking which fund `PO_VENDORS` belongs to has no
 *                  answer. Counting it whole is the only true answer, so it is
 *                  counted whole and *labelled* as whole rather than silently
 *                  included in a total that claims to be scoped.
 *
 *   ★ WITHOUT THE THIRD CASE THE FIX WOULD BE A LIE. A single "scoped" total would
 *     have to either narrow objects that have no account (impossible) or drop them
 *     from the figure (a silent understatement). `scopeMode`/`scopedRowCount` exist
 *     so the payload can say *which* number each object contributed and the screen
 *     can print both totals instead of choosing which truth to tell.
 *
 * ★ THE WHOLE-OBJECT COUNT IS TAKEN IN THE SAME PASS, AS `COUNT(CASE WHEN … THEN 1
 *   END)`. Counting each object twice would double a request that already takes
 *   51–204 s against this ledger, to answer a question the one scan can answer. Both
 *   numbers therefore come off **one read of one table**, which is also why they are
 *   guaranteed to describe the same instant.
 *
 * ★ AND THE SCOPE COMES FROM CONFIGURATION, NOT FROM A TENANT ROW, FOR THE SAME
 *   REASON `routes/activity.ts` writes its scope down: this endpoint is answered
 *   **before an organization has been chosen**, so there is no row to ask. When the
 *   file declares no fund the counts stay whole and `scope: null` says so — a
 *   pre-auth screen cannot claim a scope it has not been told.
 *
 * ★ ONE THING THIS DOES *NOT* DO, DELIBERATELY: it does not apply the fiscal-year
 *   floor to the base tables. `PERIOD_YEAR` lives on `GL_BALANCES` and the
 *   period tables, not on the hundreds of others, so a floor here would be a
 *   predicate over a column that is absent from most of the objects it named. The
 *   three composed views do carry it, because `db/derived.ts` composes them with it,
 *   and `scopeMode: 'derived'` marks exactly those.
 *
 * `COUNT(*)` per object, **taken from the source the resource would read**.
 *
 * Identifiers cannot be bound, so a name has to be interpolated — but *which* name
 * is a question this function used to answer by itself, and answering it here was
 * wrong. It counted `FROM "<table>"` for every descriptor. That is the right source
 * for a ledger table and the wrong one for the three composed views
 * (`V_SEGMENT_LEGEND`, `V_ACCOUNT_POSITION`, `V_BUDGET_BY_ACCOUNT_PERIOD`): those
 * objects do not exist on Oracle at all — their Oracle equivalents are *composed*
 * from predicates in `db/derived.ts` — so the raw name failed and all three came
 * back uncounted.
 *
 * ★ THAT MADE THE SIGN-IN FIGURE UNDERSTATE THE LEDGER *AND* SAY SOMETHING UNTRUE.
 *   Measured: this endpoint answered `32 tables · 196,942,683 records` with
 *   `uncounted: 3`, while `npm run ledger:scale` — which resolves each object
 *   through `ledgerPlan()`, exactly as `resource.ts` does — counted those same
 *   three views for 72,370 rows and totalled 197,015,053. So the sign-in screen
 *   printed two different totals for one quantity in its two states, and the
 *   footnote's "3 could not be counted" was false: the application serves all three,
 *   and the recorded figure the *failed* state quotes already included them.
 *
 *   `ledgerPlan()` is the resolution a resource serves *through*, so asking it is
 *   the only way this count can be a count of what a reader would actually get. The
 *   two routes now agree by construction rather than by a second opinion.
 *
 * ★ A FAILED RESOLUTION IS STILL LEFT UNCERTAIN, NOT ZEROED. `!plan.ok` means the
 *   object cannot be read on this deployment (or the connection is down), and that
 *   is "unknown", not "empty".
 *
 * ★ AND ONLY A *DESCRIBED* OBJECT IS RESOLVED. `ledgerPlan` composes a read from the
 *   column list it is handed and then caches that plan **per table, for every other
 *   caller to share** — so a caller that names no columns must not be the one to
 *   decide it. The dictionary's names come from `sqlite_master` and describe no
 *   descriptor, so they are counted through the route that serves them (`rows()`
 *   sends the statement to the store `storeForTable` names), which is what this
 *   endpoint did before the fix above and what its own check asserts.
 *
 *   Measured, because the first attempt at the fix got this wrong: asked for
 *   `PO_HEADERS_ALL` with no columns, `ledgerPlan` composed
 *   `SELECT\n  \n  FROM (…) src` — an empty projection, which Oracle rejects — and
 *   then **cached the failure**, so every later read of that table in the process
 *   inherited it. The count came back `null` and the resource routes were one
 *   request away from a 500. An empty column list is not "fewer columns"; it is no
 *   request at all.
 */
async function countObjects(targets: readonly CountTarget[]): Promise<Map<string, ObjectCount>> {
  const scope = declaredScope();
  const out = new Map<string, ObjectCount>();

  /*
   * ★ THE LOOP WAS SEQUENTIAL, AND THAT — NOT THE SIZE OF THE LEDGER — IS WHERE THE
   *   SIX MINUTES WENT.
   *
   *   Measured on 2026-09-22, one scope, one pass: **397.3 s** for 34 objects. This
   *   endpoint had earlier been recorded at 51 s, 67.5 s, 95.5 s and 204.3 s, and that
   *   spread was written down as "the cost belongs to Oracle and the link, not to the
   *   query". It is not the link. A `for` loop with an `await` in it runs every
   *   statement *one at a time*, so the pass costs the **sum** of 34 statement
   *   latencies while the pool it draws from is `poolMax: 8` — seven connections sat
   *   idle for the whole six minutes, and the one in use was waiting on the network
   *   rather than on the database. The spread is explained by the same fact: it is
   *   that sum over a varying per-statement latency, which is why three consecutive
   *   takes of one scope disagreed by 3×.
   *
   *   So the counts are taken through a small window instead. The ceiling is 4, not
   *   the pool's 8, because this pass is not the only reader in the process: the
   *   sign-in screen fires its own requests, `probeDb()` polls, and a pass that took
   *   every connection would reproduce the `NJS-040` starvation it exists to relieve.
   *   Four leaves half the pool for everything else while cutting the wall time to
   *   roughly a quarter of the sum.
   *
   * ★ ORDER IS PRESERVED THROUGH THE WINDOW, AND SO IS THE FAILURE CONTRACT. Results
   *   are written into `out` by name, so the payload's ordering does not depend on
   *   which count finishes first; and each object still folds its own failure into
   *   `rowCount: null` rather than rejecting the pass, which is what `uncounted`
   *   reports and what the smoke check asserts against the sum. That second point is
   *   the one a naive rewrite gets wrong: a bare `Promise.all` over the targets would
   *   let the first rejection discard the whole payload, turning one unreadable view
   *   into a failed screen — the opposite of what `uncounted` is for.
   */
  const CONCURRENCY = 4;
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= targets.length) return;
      const { name, columns, store } = targets[index]!;
      try {
        const plan = columns.length > 0 ? await ledgerPlan({ table: name, columns }) : null;
        if (plan && !plan.ok) continue;
        // No descriptor describes this name, so route it as the statement it is: the
        // names a reader sees here are the ones `sqlite_master` holds, and a composed
        // view is not among them.
        const from = plan ? plan.from : quoteIdent(name);

        const mode = countMode(name, columns, store, scope);

        /**
         * A COMPOSED VIEW IS ALREADY SCOPED, SO IT IS COUNTED ONCE.
         *
         * `plan.from` for these three is the fragment from `db/derived.ts`, which
         * carries the fund, the programs and the period floor inside it. Wrapping it in
         * a fund predicate as well would be redundant arithmetic over an already
         * narrowed set, and — worse — it would make the *unscoped* number for these
         * views unobtainable, since there is no unscoped source to count. So they
         * report the one figure they have, and `scoped: true` says what it is.
         */
        if (mode === 'derived') {
          const result = await rows<{ n: unknown }>(`SELECT COUNT(*) AS n FROM ${from}`);
          const value = countOf(result[0]?.n);
          if (value !== null) {
            out.set(name, { rowCount: value, scopedRowCount: value, scopeMode: 'derived', scoped: true });
          }
          continue;
        }

        if (mode === 'segments' || mode === 'lookup') {
          const predicate = mode === 'segments' ? segmentPredicate(scope!) : lookupPredicate(scope!);
          const result = await rows<{ n: unknown; scoped: unknown }>(
            `SELECT COUNT(*) AS n, COUNT(CASE WHEN ${predicate.sql} THEN 1 END) AS scoped FROM ${from}`,
            predicate.args,
          );
          const whole = countOf(result[0]?.n);
          const narrowed = countOf(result[0]?.scoped);
          if (whole !== null) {
            out.set(name, {
              rowCount: whole,
              scopedRowCount: narrowed,
              scopeMode: mode,
              scoped: narrowed !== null,
            });
          }
          continue;
        }

        const result = await rows<{ n: unknown }>(`SELECT COUNT(*) AS n FROM ${from}`);
        const value = countOf(result[0]?.n);
        // A count that cannot be read stays *absent*, so the response reports
        // `rowCount: null` ("unknown") rather than 0 ("empty"). Those two mean
        // different things, and confusing them once produced a fictitious −100%
        // delta in this project's history.
        if (value !== null) {
          out.set(name, { rowCount: value, scopedRowCount: null, scopeMode: null, scoped: false });
        }
      } catch {
        /* A view can depend on an object that is absent; leave it uncounted. */
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, targets.length) }, worker));

  return out;
}

/**
 * A count off one aggregate column, or `null` when the column is not a finite number.
 *
 * ★ `Number(null)` IS `0`, SO THE GUARD HAS TO BE `isFinite` RATHER THAN A NULL
 *   CHECK. A statement that returned no row at all — the shape a routing mistake
 *   takes — would otherwise be recorded as a real count of zero, indistinguishable
 *   from a genuinely empty table. `routes/activity.ts` keeps the same guard on the
 *   same two numbers for the same reason.
 */
function countOf(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/* ────────────────────────────────────────────────────────────────────────────
 * ★★ THE COUNT PASS IS MEMOISED, AND THE REASON IS A MEASURED OUTAGE RATHER
 *    THAN A PREFERENCE.
 *
 * This endpoint is the sign-in screen's ledger block, so it is requested by
 * someone who has not signed in yet — and, because the block sits under the
 * form, by every reload that person makes. Each request used to take its own
 * pass of 34 counts over a ledger holding 197 M rows, `GL_BALANCES` alone
 * 157 M, one statement at a time. Measured on this deployment: 51 s under
 * funds 02/04, and three consecutive takes of ONE identical scope at 67.5 s,
 * 95.5 s and 204.3 s — and then **397.3 s** once the endpoint was measured again on
 * 2026-09-22. Three reloads were therefore three long, identical passes running at
 * once, and the pool is `poolMax: 8` — so a handful of them starved every other
 * route in the process.
 *
 * ★ AND THE PASS ITSELF WAS SEQUENTIAL, WHICH IS THE LARGER HALF OF THE COST. That
 *   is fixed where it happened (`countObjects` now counts through a window of 4),
 *   so the figures above are the *sequential* timings and should not be quoted as
 *   the current cost. The memo below is still needed and still correct: it is what
 *   stops three reloads from being three passes. The two fixes are independent —
 *   one makes a pass cheaper, the other makes repeats free — and neither substitutes
 *   for the other.
 *
 * The observed failure, from this very loop: `NJS-040: connection request
 * timeout. Request exceeded "queueTimeout" of 45000` on two named tables, with
 * `/api/health` — a request that touches no table — timing out behind them.
 * A refusal after 45 s, twice, is the pool saying it had nothing to hand out;
 * the screen said "Counting the ledger…" and stayed there because the client
 * has no deadline either (see `app/src/data/ledgerSummary.ts`).
 *
 * So the pass is taken once per scope and served for `LEDGER_COUNT_TTL_MS`, and
 * concurrent requests for one scope share that one pass instead of queueing
 * passes of their own. `countedAt` states when it was taken.
 *
 * ★ WHAT THIS GIVES UP, AND WHY IT IS STILL THE HONEST CHOICE: the figure can be
 *   up to the TTL old, where before every payload was measured to the second.
 *   The client's module note says a cached figure is "the thing this module was
 *   written to stop showing". That objection is answered by *stating the age*
 *   rather than by refusing to cache: the fault it was guarding against is a
 *   **remembered** number presented as a live one. A bounded, disclosed,
 *   scope-keyed figure is a measurement with a date on it — and it is still a
 *   measurement, which the previous behaviour could not deliver at all, because
 *   a request that never returns shows no figure and discloses nothing.
 *
 * ★ THE KEY IS THE SCOPE, NOT THE CLOCK. Two requests with the same fund,
 *   programs and floor describe the same rows; a payload computed under a
 *   different `FUND_CODE` must never answer for a scope that did not ask for it.
 *   The target list is part of the key too, because the dictionary route counts
 *   a different set of names with no declared columns and must not collide with
 *   the summary's — those names take the whole-object mode, and a payload built
 *   for one must not be served to the other.
 *
 * ★ A FAILED PASS IS NOT CACHED. `countObjects` folds per-object failures into
 *   `uncounted` and only rejects if the whole pass dies; caching a rejection
 *   would turn one bad moment into a TTL of `rowCount: null`.
 * ──────────────────────────────────────────────────────────────────────────── */
const LEDGER_COUNT_TTL_MS = 10 * 60_000;

interface CountedPass {
  /** `Date.now()` when the pass finished. Served to the client as `countedAt`. */
  at: number;
  counts: Map<string, ObjectCount>;
}

const countCache = new Map<string, CountedPass>();
const countPasses = new Map<string, Promise<CountedPass>>();

function countPassKey(targets: readonly CountTarget[]): string {
  const scope = declaredScope();
  // `null` programs (the file was silent) and `[]` (no filter wanted) are different
  // answers about the same scope, so they must not share a cache entry.
  const programs = scope === null ? '' : scope.programs === null ? '*' : scope.programs.join(',');
  const scopeKey =
    scope === null
      ? 'no-scope'
      : `${scope.funds.join(',')}/${programs}/${scope.startYear ?? '-'}`;
  // The declared columns are part of the identity because they decide which read
  // source and which count mode each object takes — not merely which rows come back.
  return `${scopeKey}::${targets.map((t) => `${t.name}(${t.columns.join('+')})`).join('|')}`;
}

async function countedObjects(targets: readonly CountTarget[]): Promise<CountedPass> {
  const key = countPassKey(targets);

  const cached = countCache.get(key);
  if (cached !== undefined && Date.now() - cached.at < LEDGER_COUNT_TTL_MS) return cached;

  // ★ ONE PASS PER SCOPE, NOT ONE PASS PER REQUEST. A request that arrives while
  //   the first is still counting awaits the same promise rather than starting a
  //   second pass over the same 197 M rows — which is the whole of why the pool is
  //   no longer saturated by someone reloading the sign-in screen.
  const running = countPasses.get(key);
  if (running !== undefined) return running;

  const pass = countObjects(targets)
    .then((counts) => {
      const done: CountedPass = { at: Date.now(), counts };
      countCache.set(key, done);
      return done;
    })
    .finally(() => {
      countPasses.delete(key);
    });

  countPasses.set(key, pass);
  return pass;
}

/** The account scope as configuration declares it, or `null` when it declares no fund. */
interface DeclaredScope {
  funds: string[];
  /** `null` = the file is silent, so the list belongs to an organization row we cannot read yet. */
  programs: string[] | null;
  startYear: number | null;
}

function declaredScope(): DeclaredScope | null {
  const funds = config.ledgerScope.funds;
  if (funds === undefined || funds.length === 0) return null;
  return {
    funds: [...funds],
    // ★ `undefined` AND `[]` ARE DIFFERENT ANSWERS AND ARE KEPT DIFFERENT HERE.
    //   `PROGRAM_CODE=none` (`[]`) means *read every program under the funds* — a
    //   complete answer, reached by applying no program filter. A file that says
    //   nothing (`undefined`) means the programs come from the organization row,
    //   which is unreadable before sign-in. Both produce no predicate; only the
    //   first may be described as the declared scope.
    programs: config.ledgerScope.programs === undefined ? null : [...config.ledgerScope.programs],
    startYear: config.ledgerScope.startYear ?? null,
  };
}

/**
 * Which of the three ways — if any — this object's count can follow the scope.
 *
 * The classification itself is `routes/activity.ts`'s, imported rather than copied:
 * the register and this endpoint are asking the same question about the same columns,
 * and two hand-written copies of "does this object carry an account?" would drift.
 * What differs is where the *values* come from — the register writes fund `04` down
 * because it too runs before a tenant exists, while this reads configuration, so
 * changing `FUND_CODE` moves this figure and not that one.
 */
function countMode(
  name: string,
  columns: readonly string[],
  store: StoreId | undefined,
  scope: DeclaredScope | null,
): 'derived' | 'segments' | 'lookup' | null {
  // The scope is the *ledger's*, so it is not applied to the app's own rows.
  if (store !== 'ledger') return null;
  if (isDerivedTable(name)) return 'derived';
  if (scope === null) return null;
  return scopeModeFor(columns);
}

/** `"SEGMENT1" = ? AND "SEGMENT3" IN (?, ?)` — the single-fund and multi-fund forms. */
function segmentPredicate(scope: DeclaredScope): { sql: string; args: string[] } {
  const fund = scope.funds.length === 1 ? `${quoteIdent('SEGMENT1')} = ?` : `${quoteIdent('SEGMENT1')} IN (${scope.funds.map(() => '?').join(', ')})`;
  const args = [...scope.funds];
  if (scope.programs === null || scope.programs.length === 0) return { sql: fund, args };
  return {
    sql: `${fund} AND ${quoteIdent('SEGMENT3')} IN (${scope.programs.map(() => '?').join(', ')})`,
    args: [...args, ...scope.programs],
  };
}

/**
 * The same predicate, reached through the combination table.
 *
 * ★ `GL_CODE_COMBINATIONS` IS READ IN THE OBJECT'S OWN STORE, AND THAT IS NOT A
 *   DETAIL (the same warning `routes/activity.ts` carries). The two stores keep
 *   their own combination ids, and a subquery written against one and run in the
 *   other compares two unrelated sets of keys. Here the object is known to be a
 *   ledger table (see `countMode`), so the lookup is the ledger's table too.
 */
function lookupPredicate(scope: DeclaredScope): { sql: string; args: string[] } {
  const inner = segmentPredicate(scope);
  return {
    sql:
      `${quoteIdent('CODE_COMBINATION_ID')} IN (SELECT ${quoteIdent('CODE_COMBINATION_ID')} ` +
      `FROM ${quoteIdent('GL_CODE_COMBINATIONS')} WHERE ${inner.sql})`,
    args: inner.args,
  };
}
