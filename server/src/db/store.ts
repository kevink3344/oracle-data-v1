/**
 * Which store owns which table.
 *
 * WHY THIS FILE EXISTS
 *   There are two databases behind this server, and until now nothing had to know
 *   it. The ledger — the EBS tables, `GL_BALANCES`, `PO_HEADERS_ALL` and the rest
 *   — lives in the sample file, in Turso, or in Oracle, depending on `DB_MODE`.
 *   The tables *this application authors* — `saved_view`, `project`,
 *   `table_count_snapshot`, the `X_REPORT_*` extract tables — lived in the same
 *   database, so "which one" had one answer and the question never came up.
 *
 *   `APP_DB_URL` separates them: the ledger can be Oracle while the app's own rows
 *   stay in a local SQLite file. The moment that is possible, every statement has
 *   a store it must be sent to, and getting it wrong does not produce an error —
 *   it produces a *different database's* answer to the same question.
 *
 * ★ THE REGISTRY IS AN EXPLICIT ALLOWLIST, AND THE CLASSES ARE THE RECORD.
 *   Nothing here is inferred from the statement. A table name is looked up, and
 *   the lookup decides. The one failure this design must not have is a
 *   **mis-routed read that succeeds**, and the only defence against it is that the
 *   mapping is written down and gated — see `checkRegistry` and the smoke
 *   assertions, which fail the build rather than the request.
 *
 *   Concretely, the two ways a guess goes wrong:
 *
 *     - an app-owned table routed to Oracle → `ORA-00942: table or view does not
 *       exist`. Loud, and the operator fixes it.
 *     - a **ledger** table routed to the app store → the app store is a *mirror*
 *       of the EBS schema, so the table often **exists and returns rows**. Under
 *       `DB_MODE=oracle` with a local app store, `SELECT COUNT(*) FROM GL_BALANCES`
 *       sent to the wrong side answers from a stale sample: a real number, from
 *       the wrong data, with no error. That is the one to design against.
 *
 * WHY THE STATEMENT IS SCANNED FOR *REGISTERED* NAMES RATHER THAN PARSED
 *   The alternative is to walk the SQL for `FROM`/`JOIN`/`INTO` and read the
 *   identifier after each. It detects an unregistered table, which this does not —
 *   and it produces false positives on every construct nobody thought of (a CTE
 *   named like a table, `FROM (SELECT …)`, a table-valued function, an
 *   `INSERT … SELECT` with a schema prefix). A false positive here is not a
 *   warning: with the stores divergent it is thrown, so a valid request would
 *   start failing.
 *
 *   Scanning for the ~35 names that are registered cannot mis-route a table it
 *   knows about, because there is nothing to mis-read: the name is either present
 *   or absent, outside comments and string literals. The gap it leaves — a table
 *   in neither list — is closed statically instead, by asserting that every
 *   descriptor's `table` is registered (`scripts/smoke.ts`). A static check on the
 *   code that names tables is strictly better than a runtime check on the text
 *   that mentions them: it fails at build time, on a list a person can read.
 */

import { maskKeepingIdentifiers } from './query-guard.js';

/** The two databases a statement can be sent to. */
export type StoreId = 'ledger' | 'app';

/** What a name *is*, which is why it lives where it does. */
export type TableClass = 'EBS' | 'DERIVED' | 'APP' | 'INTROSPECTION';

/**
 * EBS tables — Oracle, read-only.
 *
 * Every one of these is in the DBA's grant list. The list is exactly the set of
 * tables the API reads, gathered from the resource descriptors
 * (`routes/coa.ts`, `funding.ts`, `procurement.ts`, `projects.ts`, `vendors.ts`)
 * rather than from the EBS data dictionary, because a grant this code never
 * exercises is a grant that should not be here.
 *
 * `DUAL` is included and is not a joke: Oracle requires a `FROM` clause on some
 * versions, so `SELECT … FROM DUAL` is a real statement this code issues, and
 * without the entry it would be treated as naming no table at all.
 */
const EBS_TABLES = [
  // General ledger
  'GL_LEDGERS',
  'GL_PERIODS',
  'GL_BALANCES',
  'GL_CODE_COMBINATIONS',
  'GL_LOOKUPS',
  'GL_BUDGET_TYPES',
  'GL_BUDGET_VERSIONS',
  'GL_BUDGET_ENTITIES',
  'GL_BUDGET_ASSIGNMENTS',
  'GL_JE_HEADERS',
  'GL_JE_LINES',
  // Flexfields and currencies
  'FND_CURRENCIES',
  'FND_ID_FLEX_STRUCTURES',
  'FND_ID_FLEX_SEGMENTS',
  'FND_FLEX_VALUES',
  'FND_FLEX_VALUES_TL',
  // Purchasing
  'PO_VENDORS',
  'PO_VENDOR_SITES_ALL',
  'PO_AGENTS',
  'PO_LINE_TYPES',
  'PO_HEADERS_ALL',
  'PO_LINES_ALL',
  'PO_LINE_LOCATIONS_ALL',
  'PO_DISTRIBUTIONS_ALL',
  'PO_LOOKUP_CODES',
  // Projects
  'PA_PROJECTS_ALL',
  'PA_TASKS',
  'PA_BUDGET_VERSIONS',
  'PA_BUDGET_LINES',
  // ★ THE CUSTOMER'S EXTRACT VIEWS. These are the *only* place the extract-shaped
  //   columns exist on the live database — `WCSEXP_PO_HEADERS` carries
  //   `PO_NUMBER` / `EXP_PROJECT_NAME` / `EXP_PO_NUMBER`, which `PO_HEADERS_ALL`
  //   (213 columns) does not have at all. They belong to the ledger store for the
  //   same reason `GL_BALANCES` does, and they have to be *named here* because
  //   routing decides a statement's store from the tables it mentions: an
  //   unregistered name makes `routeStatement` throw, so a read that joins one of
  //   these to a base table would be refused before it reached Oracle. The list is
  //   the granted set from the account's own grant catalogue, not a guess.
  'WCSEXP_PO_HEADERS',
  'WCSEXP_PO_LINES',
  'WCSEXP_PO_LINE_LOCATIONS',
  'WCSEXP_PO_DISTRIBUTIONS',
  'WCSEXP_PO_LINE_TYPES',
  'WCSEXP_PO_LOOKUP_CODES',
  'WCSEXP_PO_VENDORS',
  'WCSEXP_PO_VENDOR_SITES',
  'WCSEXP_PO_VENDOR_CONTACTS',
  'WCSEXP_PO_RELEASES',
  'WCSEXP_FND_ID_FLEX_STRUCTURES',
  'WCSEXP_GL_CODE_COMBINATIONS',
  'WCSEXP_MTL_SYSTEM_ITEMS',
  'WCSEXP_HR_LOCATIONS',
  'WCSEXP_AP_INVOICES',
  'WCSEXP_AP_INV_LINES',
  'WCSEXP_AP_INV_DISTRIBUTIONS',
  'WCSEXP_AP_CHECKS',
  'WCSEXP_AP_INVOICE_PAYMENTS',
  // The one table that is not a table
  'DUAL',
] as const;

/**
 * Views this server composes, and which therefore do not exist in EBS at all.
 *
 * They belong to the ledger store because they *read* the ledger: `V_ACCOUNT_POSITION`
 * joins `GL_BALANCES` to `GL_CODE_COMBINATIONS`. In a SQLite store the view bodies
 * are in the file; against Oracle they are inlined into the query that uses them
 * (`hybrid-mode-plan.md` §4) — which is not built, and is why a read of one of
 * these under `DB_MODE=oracle` fails with "table or view does not exist" rather
 * than returning a wrong answer. Failing loudly is acceptable; answering from the
 * wrong place would not be.
 */
const DERIVED_TABLES = ['V_SEGMENT_LEGEND', 'V_BUDGET_BY_ACCOUNT_PERIOD', 'V_ACCOUNT_POSITION'] as const;

/**
 * The extract tables, which are app-authored even though their names look like EBS.
 *
 * ★ THESE ARE THE TRAP IN THE WHOLE FILE. `X_REPORT_PROJECT_FACTS` reads like a
 *   custom EBS report table and is in fact written by this application from the
 *   extract pipeline. Classified as EBS they would be sent to Oracle, and under
 *   `DB_MODE=oracle` a project's facts — the identity figures `/api/projects/summary`
 *   depends on — would come back empty from a table Oracle has never heard of.
 *   The `X_` prefix means "custom", which in EBS means "the customer owns it",
 *   which for these two means "we do". They are the only two EBS-shaped names in
 *   the app store.
 */
const APP_EXTRACT_TABLES = [
  'X_REPORT_PROJECT_FACTS',
  'X_REPORT_FUNDING_LINES',
  'SAMPLE_DATA_PROVENANCE',
] as const;

/**
 * The tables this application creates, and which live in the app store wherever
 * that is.
 *
 * ★ THIS IS DELIBERATELY THE THIRD COPY OF THE SAME NAMES. The other two are
 *   `data/sql/turso/01-app.sql` (the DDL) and `APP_TABLES` in `db/app-schema.ts`
 *   (the applier's list). The copy exists because importing `APP_TABLES` here
 *   would make this module depend on `app-schema.ts`, which imports `client.ts`,
 *   which imports the driver that imports this file — a cycle whose failure mode
 *   is a `const` read before it is initialised, which surfaces as a `TypeError`
 *   at import time and a dead server.
 *
 *   Three copies is two too many, and that is exactly why the smoke suite asserts
 *   all three sets equal rather than trusting them (`scripts/smoke.ts`). The
 *   duplication is safe because it is checked, and the check fails the build
 *   before the divergence can reach a request.
 *
 *   ★ THAT SENTENCE WAS FALSE UNTIL `vendor_site_route` DRIFTED. The smoke check
 *   compared `APP_TABLES` against the DDL and never against **this** list, so the
 *   one copy that decides routing was the one copy nothing read — and the list
 *   below sat one table short. The consequence is not a missing table: an
 *   unregistered name is not an error here, it falls through to the ledger, so
 *   `SELECT … FROM vendor_site_route` over the routed `db` was sent to Oracle and
 *   died with `ORA-00942` — a message saying the table does not exist, about a
 *   table this app creates and stores. The suite now compares this list too; the
 *   array is exported for exactly that reason, and renaming it to say *routing*
 *   keeps it from being mistaken for the schema applier's list.
 *
 * ★ `organization` AND `app_user` ARE THE TWO THAT PROVE THE POINT. They arrived
 *   for the tenancy feature, and leaving either out of this list would not be a
 *   loud failure at the point of the mistake: `storeForTable` throws on an
 *   unregistered name, so the symptom would be every settings request failing
 *   with a message about a registry the author never edited — one layer away from
 *   the omission. Registered here, the statement goes to the app store, which is
 *   where the DDL created them.
 */
export const ROUTING_APP_TABLES = [
  'saved_view',
  'saved_view_run',
  'saved_view_subscription',
  'project',
  'table_count_snapshot',
  'organization',
  'app_user',
  'user_pin',
  // Vendor-site geography (vendor-site-map.md). `geo_origin` is the place a
  // driving distance is measured from; `vendor_site_geo` holds one site's pin and
  // its distance from that origin. Both are referenced by the Vendor sites
  // register, which reads sites from the ledger and their coordinates from here.
  'geo_origin',
  'vendor_site_geo',
  // The road between the origin and a pin, and its turns. Added to the DDL and to
  // `app-schema.ts` when the road route landed, and missed here — the omission this
  // list's own comment now cites as the reason the third comparison exists.
  'vendor_site_route',
  // Custom field values (custom-table-fields.md): one row per (subject, key,
  // field) a reader has decided to name themselves. Listed here in the same change
  // that added it to the DDL and to `app-schema.ts`, having just cited the drift
  // that made the third comparison necessary.
  'field_override',
] as const;

/**
 * The schema catalogue, which is a read of the app store by definition.
 *
 * ★ THESE ARE ROUTED BY WHERE THEY CAN RUN, AND THE CHOICE COSTS SOMETHING.
 *
 * `/api/meta/dictionary` asks `sqlite_master`; the relationship map and the activity
 * register ask `pragma_*`. Both are SQLite-only introspection — there is no Oracle
 * catalogue behind them. So under `DB_MODE=oracle` the choice is not "which store
 * has the right answer" but "describe the app store, or fail". Describing the app
 * store is the only one of the two that returns anything.
 *
 * The cost is real and is not papered over here: under `oracle` the dictionary
 * describes the **app store**, which is five tables, and not Oracle's schema. The
 * published description says which store it read, and Phase 4's ledger work is what
 * closes the gap by reading `ALL_TABLES`/`ALL_TAB_COLUMNS` for the Oracle side. Until
 * then a reader who wants the EBS columns must read them from the descriptors or the
 * DDL, and a dictionary that quietly answered from the wrong catalogue would be worse
 * than one that answers from a named one.
 *
 * ★ THE `counts=true` PATH IS ALREADY CORRECT AND STAYS CORRECT. It issues one
 * `SELECT COUNT(*) FROM <name>` per listed object, and each of those statements names
 * a table, so each routes to the store that owns it. Listing is a property of the
 * catalogue, but counting is a property of the data — and it is right that those two
 * can come from different stores.
 *
 * The four `sqlite_*` names are listed and the `pragma_*` family is matched by
 * prefix: the pragma surface is open-ended (`table_info`, `foreign_key_list`,
 * `index_list`, `index_info`, `table_xinfo`, …) and enumerating it would mean an
 * unregistered-name failure the first time someone asks a new question. A prefix
 * rule is safe here because no ordinary table can be called `pragma_something`
 * without quoting, and the names are matched as whole words.
 */
const INTROSPECTION_TABLES = ['sqlite_master', 'sqlite_schema', 'sqlite_temp_master', 'sqlite_temp_schema'] as const;

const PRAGMA_PREFIX = 'pragma_';

/** Which store each class belongs to. The whole routing rule, in one place. */
const STORE_OF_CLASS: Readonly<Record<TableClass, StoreId>> = {
  EBS: 'ledger',
  DERIVED: 'ledger',
  APP: 'app',
  INTROSPECTION: 'app',
};

/** Case-insensitive, because Oracle folds unquoted identifiers up and SQLite does not. */
const REGISTERED: ReadonlyMap<string, TableClass> = (() => {
  const m = new Map<string, TableClass>();
  for (const n of EBS_TABLES) m.set(n.toLowerCase(), 'EBS');
  for (const n of DERIVED_TABLES) m.set(n.toLowerCase(), 'DERIVED');
  for (const n of APP_EXTRACT_TABLES) m.set(n.toLowerCase(), 'APP');
  for (const n of ROUTING_APP_TABLES) m.set(n.toLowerCase(), 'APP');
  for (const n of INTROSPECTION_TABLES) m.set(n.toLowerCase(), 'INTROSPECTION');
  return m;
})();

/** The class a name belongs to, or `null` when it is not registered. */
export function classOfTable(name: string): TableClass | null {
  if (name.toLowerCase().startsWith(PRAGMA_PREFIX)) return 'INTROSPECTION';
  return REGISTERED.get(name.toLowerCase()) ?? null;
}

/** The store a class belongs to. */
export function storeOfClass(cls: TableClass): StoreId {
  return STORE_OF_CLASS[cls];
}

/**
 * The store a table belongs to.
 *
 * ★ THROWS ON AN UNREGISTERED NAME, RATHER THAN GUESSING.
 *   A guess here is the failure the file is written to prevent. The default would
 *   have to be one of the two, and each choice is wrong half the time: default to
 *   the ledger and a new app table is read from Oracle, default to the app store
 *   and a ledger table is answered from a stale mirror. Neither is a failure the
 *   caller can see, so neither is a default worth having.
 */
export function storeForTable(name: string): StoreId {
  const cls = classOfTable(name);
  if (cls === null) {
    throw new Error(
      `"${name}" is not in the store registry (server/src/db/store.ts), so there is no way to know ` +
        'which database it lives in. Add it to the EBS, DERIVED, APP or INTROSPECTION list there — ' +
        'guessing is the one thing this lookup must not do.',
    );
  }
  return STORE_OF_CLASS[cls];
}

/** A registered name found in a statement. */
export interface FoundTable {
  /**
   * Always uppercase — `gl_ledgers`, `"GL_LEDGERS"`, `saved_view` and `SAVED_VIEW`
   * all report `GL_LEDGERS`/`SAVED_VIEW`. The registry is case-insensitive and a
   * statement may be written in any of them, so one canonical spelling is what
   * `describeRoute` and every error message use. It is *not* necessarily the
   * spelling used in the DDL, where app tables are lowercase and EBS ones are not.
   */
  name: string;
  cls: TableClass;
  store: StoreId;
}

/** Where a statement should be sent, and what it told us. */
export interface StatementRoute {
  /** The store to use. For a statement naming nothing registered, the ledger. */
  store: StoreId;
  /** Registered names the statement mentions, in first-seen order. */
  tables: FoundTable[];
  /** The distinct stores those names imply, in first-seen order. */
  stores: StoreId[];
  /**
   * True when the statement names tables from more than one store.
   *
   * Not an error by itself — see `hybrid.ts`. When the two stores are the same
   * database a mixed statement is harmless and the distinction is academic; when
   * they are different it cannot be executed correctly at all.
   */
  mixed: boolean;
}

/**
 * Every registered table a statement mentions, outside string literals and comments.
 *
 * ★ THE MASKER IS SHARED WITH THE QUERY GUARD, WITH IDENTIFIERS KEPT.
 *   `maskLiterals` blanks `"…"` as well as `'…'`, which is right for a keyword scan
 *   and fatal here: this codebase quotes every identifier (`quoteIdent` in
 *   `db/sql.ts`), so `FROM "GL_LEDGERS"` masks to `FROM           ` and the
 *   statement appears to name no table. `maskKeepingIdentifiers` is the same state
 *   machine with that one decision reversed — see its doc block.
 *
 * Whole words only: `REGISTERED` matching is done against the token stream rather
 * than by substring, so a column called `project_id` cannot fire the `project`
 * entry, and `X_REPORT_PROJECT_FACTS_SUMMARY` is not mistaken for its prefix.
 */
export function tablesIn(statement: string): FoundTable[] {
  const masked = maskKeepingIdentifiers(statement);
  const found = new Map<string, FoundTable>();
  const word = /[A-Za-z_][A-Za-z0-9_$]*/g;
  let m: RegExpExecArray | null;
  while ((m = word.exec(masked)) !== null) {
    const cls = classOfTable(m[0]);
    if (cls === null) continue;
    // Registered names are canonical uppercase; the word may be any case, and may
    // be the `pragma_x` prefix rule rather than a map hit.
    const name = m[0].toLowerCase().startsWith(PRAGMA_PREFIX) ? m[0].toLowerCase() : m[0].toUpperCase();
    if (!found.has(name)) found.set(name, { name, cls, store: STORE_OF_CLASS[cls] });
  }
  return [...found.values()];
}

/**
 * Where a statement goes.
 *
 * ★ A STATEMENT THAT NAMES NOTHING REGISTERED GOES TO THE LEDGER.
 *   It has to go somewhere, and the ledger is the primary store: the statements
 *   with no table in them are DDL, pragmas and connection checks, all of which are
 *   the ledger's business. The case that would be wrong — a statement against an
 *   unregistered *app* table — cannot arise, because the smoke suite asserts that
 *   every table the code names is registered.
 */
export function routeStatement(statement: string): StatementRoute {
  const tables = tablesIn(statement);
  const stores: StoreId[] = [];
  for (const t of tables) {
    if (!stores.includes(t.store)) stores.push(t.store);
  }
  return {
    store: stores.length > 1 ? 'ledger' : (stores[0] ?? 'ledger'),
    tables,
    stores,
    mixed: stores.length > 1,
  };
}

/** A rendered sentence describing where a statement was headed, for an error. */
export function describeRoute(route: StatementRoute): string {
  return route.tables.map((t) => `${t.name} (${t.cls} → ${t.store})`).join(', ') || 'no registered table';
}

/**
 * The registry's own consistency, as a value rather than an assertion at import.
 *
 * Returns the problems rather than throwing, so the smoke suite can report them
 * alongside every other failure instead of the process dying at import — and so a
 * suspicious registry can be *looked at* rather than only obeyed. `hybrid.ts` does
 * throw, at the first statement, because a routing decision taken from a broken
 * registry is exactly the silent wrong answer this file exists to prevent.
 */
export function checkRegistry(): string[] {
  const problems: string[] = [];
  for (const [name, cls] of REGISTERED) {
    if (name !== name.toLowerCase()) problems.push(`${name} is registered with mixed case`);
    if (cls === 'EBS' && name.startsWith('x_')) {
      problems.push(`${name} is classified EBS but has the X_ custom-table prefix`);
    }
  }
  return problems;
}

/** The registered names of a class. Used by the smoke suite's set equality checks. */
export function tablesOfClass(cls: TableClass): string[] {
  const names: string[] = [];
  for (const [name, c] of REGISTERED) if (c === cls) names.push(name.toUpperCase());
  return names.sort();
}
