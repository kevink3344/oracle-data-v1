import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createApi } from '../http/api.js';
import { raw } from '../http/respond.js';
import { AppError } from '../http/errors.js';
import { z, FlagQuery, isTrue } from '../http/z.js';
import { db, storeDriver } from '../db/client.js';
import type { Row } from '../db/driver.js';
import { defaultTenant } from '../auth/session.js';
import { REPO_ROOT } from '../config/env.js';

/**
 * `GET /api/extract/current` — the extract the whole app is built on.
 *
 * ★ ★ ★ WHAT THIS FILE IS FOR, AND WHY IT REPLACES A STATIC FILE.
 *
 *   Until now `app/src/data/extract.ts` fetched `/oracle/output.json`: a 2 MB
 *   frozen document of 2,782 rows pulled from Oracle at some point in 2026. Every
 *   number in the app — every KPI, every chart segment, every scope count — is a
 *   sum over that document, so the app has been reporting a *snapshot* while
 *   presenting itself as a view of the ledger.
 *
 *   The decision taken here is that **the database is the source of truth and the
 *   extract is a cache of it**, not the other way round. This handler reads the
 *   live ledger and re-emits the *same document shape*, so `loadExtract()` and
 *   every one of its call sites are unchanged — the swap is one URL.
 *
 * ★ WHY THE SHAPE IS REPRODUCED RATHER THAN IMPROVED.
 *   The envelope `{ body: { ResultSets: { Table1: [...] } } }` is deliberately
 *   ugly: it is the literal output of the export that produced `output.json`, and
 *   reproducing it is what makes this endpoint a *drop-in replacement* rather than
 *   a migration. `respond.ts` documents `raw()` as existing for exactly this, and
 *   the route declares `rawBody: true` so the OpenAPI document describes the body
 *   the server actually sends instead of wrapping it in `{ data }`.
 *
 * ★ THE 18 COLUMNS ARE A CONTRACT, AND ONE OF THEM HAS NO LIVE SOURCE.
 *   `normalise()` in the frontend reads these names by hand. All of them map to a
 *   live column except `BUYER_NAME` — see `LIVE_COLUMNS` below.
 *
 * ★ WHY THE PAYLOAD IS CACHED.
 *   The tenant's live scope is 23,224 rows / 9.4 MiB of JSON (measured — and see
 *   the ★ on `fiscalFloor`, because that count is a function of the tenant's
 *   `start_fy` rather than a constant). That is 8.3× the frozen file, and it is a
 *   *read-only* ledger, so rebuilding it for every request would spend seconds of
 *   Oracle time per page load to produce a byte-identical answer. It is built once,
 *   held in memory, and served from there until the TTL expires. `?refresh=1`
 *   forces a rebuild.
 *
 * ★ WHY THE TWO STORES ARE READ IN TWO STATEMENTS.
 *   `hybrid.ts` refuses a statement that names tables from both stores when they
 *   are separate databases, and under `DB_MODE=oracle` with an `APP_DB_URL` file
 *   they *are* separate. The tenant lives in the app store; the ledger rows live
 *   in Oracle. So: `defaultTenant()` (app) then the join (ledger), never one query.
 */

// ---------------------------------------------------------------------------
// The document contract, published.
// ---------------------------------------------------------------------------

/**
 * One row of `body.ResultSets.Table1`.
 *
 * ★ THE UNIONS ARE NOT LAZINESS. The live path returns Oracle native types
 *   (`LINE_NUM` and `QUANTITY` are NUMBERs, so JSON numbers); the frozen fallback
 *   below returns the strings its export produced (`"1"`, `"3"`). The frontend's
 *   `RawExtractRow` declares `string | number` for both, and `str()`/`asNumber()`
 *   normalise either. Declaring only `number` here would make the document a lie
 *   on the fallback path, which is the path `npm run smoke` runs on.
 */
const ExtractRowSchema = z
  .object({
    ORDER_DATE: z.string().openapi({ example: '2025-05-20' }),
    ORDER_NUMBER: z.union([z.string(), z.number()]),
    /**
     * ★ ALWAYS NULL FROM THE LIVE LEDGER. The account's grant surface is 51 objects
     *   and contains **no person or HR table** — `PER_PERSON_NAMES_F` and
     *   `PER_ALL_PEOPLE_F` both answer ORA-00942, and `PO_AGENTS#` carries only
     *   `ATTRIBUTE1..15`. So there is no way to resolve a buyer's name, and this
     *   endpoint emits an empty value rather than inventing one. The frozen
     *   fallback still carries the export's real values. The frontend prints "—"
     *   for a blank buyer (`str(null)` → `''`).
     */
    BUYER_NAME: z.string().nullable(),
    VENDOR_NAME: z.string().nullable(),
    LINE_NUMBER: z.union([z.string(), z.number()]),
    CANCEL_FLAG: z.string().nullable(),
    ITEM_NUMBER: z.string().nullable(),
    DESCRIPTION: z.string().nullable(),
    QUANTITY: z.union([z.string(), z.number()]).nullable(),
    AMOUNT: z.union([z.string(), z.number()]),
    FUND: z.string(),
    PURPOSE: z.string(),
    PROGRAM: z.string(),
    OBJECT_: z.string(),
    LEVEL_: z.string(),
    COST_CENTER: z.string(),
    FUTURE_USE: z.string(),
    STATUS: z.string(),
  })
  .openapi('ExtractRow');

/**
 * What the rows in `body.ResultSets.Table1` actually contain.
 *
 * ★ THIS EXISTS BECAUSE `scope` ALONE WAS MISLEADING, AND MOST MISLEADING ON THE
 *   PATH THAT MATTERS MOST. `scope` reports what was ASKED FOR. On the live path
 *   that is also a description of the answer, because the SQL binds the fund and the
 *   programs — but the fallback serves a *file*, extracted under some other scope
 *   entirely, and there was no field in which that difference could appear. The
 *   frozen file is 2,782 rows of program 862 with not one row of 861, while the
 *   tenant asks for `["861","862"]`; the envelope reported `programs:
 *   ["861","862"]` and a row count, and a reader had no way to see that half the
 *   ask was missing. That is the wrong-data-presented-as-a-legitimate-answer shape,
 *   reached by omission rather than by a bad query.
 */
const ExtractObservedSchema = z
  .object({
    /** Distinct `FUND` values, sorted. `[""]` means the column is blank throughout. */
    funds: z.array(z.string()),
    /** Distinct `PROGRAM` values, sorted. */
    programs: z.array(z.string()),
    /** Earliest `ORDER_DATE` as `YYYY-MM-DD`, or null when no row carries a date. */
    earliestOrderDate: z.string().nullable(),
    /** Latest `ORDER_DATE` as `YYYY-MM-DD`, or null when no row carries a date. */
    latestOrderDate: z.string().nullable(),
  })
  .openapi('ExtractObserved');

/**
 * Which ledger answered, and over what.
 *
 * ★ THIS BLOCK IS NOT DECORATION. The frontend reads only `body`, so adding it
 *   cannot break the drop-in contract — but without it, a reader has no way to
 *   tell an 11 MiB live answer from a 2 MB frozen one, and "the totals changed and
 *   nobody knows why" is the exact failure REQ-J was filed to fix.
 */
const ExtractSourceSchema = z
  .object({
    /** `oracle` = live ledger. `file` = the frozen document on disk. */
    kind: z.enum(['oracle', 'file']),
    dialect: z.enum(['sqlite', 'oracle']),
    /** The store's human label, as `/api/health` reports it. */
    label: z.string(),
    /** ISO instant the document was read. On a cache hit this is the build time. */
    generatedAt: z.string(),
    /** True when this response came from the in-process cache. */
    cached: z.boolean(),
    /** True when `?refresh=1` asked for a rebuild. */
    forced: z.boolean(),
    /** Set when the live read was attempted and failed, so the fallback is explained. */
    fallbackReason: z.string().nullable(),
    /**
     * The scope that was ASKED FOR. Null when none was consulted — the
     * `DB_MODE=local` arm never reads the tenant, so it has no ask to report.
     * Compare against `observed` rather than reading this alone: it is a request,
     * not a description of the rows.
     */
    scope: z
      .object({
        slug: z.string(),
        name: z.string(),
        fund: z.string(),
        programs: z.array(z.string()),
        startFy: z.number(),
        /** `YYYY-MM-DD`, derived from `startFy` — see `fiscalFloor`. */
        from: z.string(),
      })
      .nullable(),
    /** What the rows contain, as opposed to what `scope` asked for. */
    observed: ExtractObservedSchema,
    /**
     * The gap between `scope` and `observed` in words, or null when they agree.
     *
     * ★ A FIELD OF ITS OWN, NOT APPENDED TO `fallbackReason`, AND THE FIRST ATTEMPT AT
     *   THIS GOT IT WRONG. The reasoning for merging them was "anyone reading
     *   `fallbackReason` should learn the shortfall in the same breath" — which is true
     *   of a *reader* and false of the code that consumes the field. The Dashboard
     *   interpolates `fallbackReason` into a parenthetical ("the live ledger could not
     *   be read (<reason>)"), so a merged sentence produced a long clause inside
     *   brackets that then repeated, in different words, the sentence the page had
     *   already written two lines above it from the rows themselves.
     *
     *   `fallbackReason` answers "why is this not the live ledger"; this answers "and
     *   does what it served cover what you asked for". Two questions, two fields, and a
     *   caller can now choose to say neither, one, or both.
     */
    scopeMismatch: z.string().nullable(),
    /** Row count, and the distinct counts the document implies. */
    rows: z.number().int(),
    orders: z.number().int(),
    lines: z.number().int(),
    amount: z.number(),
  })
  .openapi('ExtractSource');

const ExtractDocumentSchema = z
  .object({
    source: ExtractSourceSchema,
    body: z.object({
      ResultSets: z.object({
        Table1: z.array(ExtractRowSchema),
      }),
    }),
  })
  .openapi('ExtractDocument');

/** The provenance block, as a TypeScript type. `buildExtract` hands this back. */
type ExtractSource = z.infer<typeof ExtractSourceSchema>;

/**
 * The register's order numbers, and the same provenance block `/current` carries.
 *
 * ★ `source` IS THE IDENTICAL SCHEMA, NOT A SUMMARY OF IT. Two routes that are two
 *   projections of one read must not be able to describe different ledgers, and the
 *   cheapest way to guarantee that is to make the field the same object rather than
 *   a field that happens to hold similar words.
 */
const OrderNumbersSchema = z
  .object({
    source: ExtractSourceSchema,
    /** The length of `numbers`. Sent because a count is what a reader checks first. */
    count: z.number().int(),
    /** Every distinct non-empty `ORDER_NUMBER`, sorted ascending as strings. */
    numbers: z.array(z.string()),
  })
  .openapi('ExtractOrderNumbers');

// ---------------------------------------------------------------------------
// The live read.
// ---------------------------------------------------------------------------

/**
 * The ledger columns behind the extract's 18, in the extract's own names.
 *
 * ★ THE JOIN IS SIX TABLES AND EVERY ONE OF THEM IS LOAD-BEARING:
 *
 *   PO_HEADERS_ALL        the document — `SEGMENT1` is the order number,
 *                         `APPROVED_DATE` the date, `AUTHORIZATION_STATUS` the status.
 *   PO_LINES_ALL          the line — number, quantity, description, item, cancel flag.
 *   WCSEXP_PO_DISTRIBUTIONS
 *                         ★ THE NON-OBVIOUS ONE. `AMOUNT` does **not** come from
 *                         `PO_DISTRIBUTIONS_ALL.AMOUNT_ORDERED`, which is NULL on
 *                         these rows. The `WCSEXP_*` view *computes* it —
 *                         `ROUND(DECODE(PLL.QUANTITY, NULL, PLL.AMOUNT - cancelled,
 *                         (PLL.QUANTITY - cancelled) * PLL.PRICE_OVERRIDE), 2)` —
 *                         reading quantity from `PO_LINE_LOCATIONS_ALL`. Where
 *                         `PRICE_OVERRIDE` is 1 the result equals the quantity,
 *                         which is why the frozen file appears to have
 *                         `AMOUNT == QUANTITY` everywhere. Verified against the
 *                         frozen rows: it reproduces `AMOUNT` on every one,
 *                         including a line whose amount is 73.83 against a
 *                         quantity of 3, where a coincidence is impossible.
 *   GL_CODE_COMBINATIONS  the seven segments, in `SEGMENT1..7` → `FUND..FUTURE_USE`.
 *   WCSEXP_MTL_SYSTEM_ITEMS
 *                         inventory item → `SEGMENT1` is the item number. The base
 *                         table `MTL_SYSTEM_ITEMS_B` is NOT granted (ORA-00942),
 *                         and neither is any `_VL`/`_KFV`/`EGP_*` variant.
 *   PO_VENDORS            the vendor name. It hangs off the HEADER (`VENDOR_ID`),
 *                         not the line — `PO_LINE_LOCATIONS_ALL` has no vendor.
 *
 * ★ `BUYER_NAME` IS `NULL` ON PURPOSE, AND MUST NOT BE "FIXED" BY GUESSING.
 *   See the schema note above. There is no granted source. A plausible-looking
 *   substitute would be a silently fabricated attribution, which is worse than a
 *   blank — the reader cannot tell a guess from a fact.
 *
 * ★ WHY `TO_CHAR` ON THE DATE ONLY.
 *   `ORDER_DATE` must be `YYYY-MM-DD` because `isoDay()` in the frontend is a
 *   `slice(0, 10)`. Formatting it in SQL pins the wire format to the query rather
 *   than to a session `NLS_DATE_FORMAT` that `pinSession()` could change. The
 *   numeric columns are deliberately left native so they arrive as JSON numbers.
 */
const LIVE_COLUMNS = `
         TO_CHAR(h.APPROVED_DATE, 'YYYY-MM-DD') AS ORDER_DATE,
         h.SEGMENT1                             AS ORDER_NUMBER,
         NULL                                   AS BUYER_NAME,
         v.VENDOR_NAME                          AS VENDOR_NAME,
         l.LINE_NUM                             AS LINE_NUMBER,
         l.CANCEL_FLAG                          AS CANCEL_FLAG,
         msi.SEGMENT1                           AS ITEM_NUMBER,
         l.ITEM_DESCRIPTION                     AS DESCRIPTION,
         l.QUANTITY                             AS QUANTITY,
         wd.AMOUNT_ORDERED                      AS AMOUNT,
         g.SEGMENT1                             AS FUND,
         g.SEGMENT2                             AS PURPOSE,
         g.SEGMENT3                             AS PROGRAM,
         g.SEGMENT4                             AS OBJECT_,
         g.SEGMENT5                             AS LEVEL_,
         g.SEGMENT6                             AS COST_CENTER,
         g.SEGMENT7                             AS FUTURE_USE,
         h.AUTHORIZATION_STATUS                 AS STATUS`;

/**
 * Build the live statement for a tenant scope.
 *
 * ★ ONE PLACEHOLDER PER PROGRAM, BUILT FROM A VALIDATED LIST. The `WCSEXP_*` view
 *   names are fixed, the program values are bound, and the program *count* is the
 *   only thing interpolated — a string built from `PROGRAM_RE`-checked values
 *   cannot carry a quote. Binding them as one array is not an option: the driver
 *   sends an array bind as a single Oracle collection, not as an `IN` list.
 *
 * ★ THE FISCAL FLOOR BIND IS CALLED `since`, NOT `from`, AND THAT IS NOT STYLE.
 *   `FROM` is an Oracle reserved word, and Oracle rejects a bind variable named
 *   after one with **ORA-01745: invalid host/bind variable name** — the statement
 *   never parses, so it reads like a connection or privilege fault and sends you
 *   looking in the wrong place. It cost one debugging round on this endpoint: the
 *   fallback path worked, `source.fallbackReason` carried the ORA number, and the
 *   scope block beside it was already correct, which is how the trap was spotted.
 *   Every other bind here happens to be safe already (`fund`, `p0`, `p1`, …).
 *   Rule for this file: **a bind name is an identifier, so it obeys the
 *   reserved-word list too.**
 */
const PROGRAM_RE = /^[A-Za-z0-9]{1,10}$/;

/**
 * ★ THE SCOPE CONTRACT, IN ONE PLACE, READ BY TWO STATEMENTS.
 *
 *   `buildLiveSql` reads the register at distribution grain for the extract
 *   document; the vendor-site register reads the SAME register at (site, order)
 *   grain to answer a different question about the same rows. Both must
 *   therefore select the same rows, and the only way to guarantee that is for
 *   there to be one definition of "in scope" rather than two strings kept in step
 *   by a comment. This function is that definition.
 *
 *   It returns a WHERE fragment rather than a whole statement because that is the
 *   most both readers share: the extract needs the full distribution projection
 *   and the site register needs a per-site aggregate, but neither can express
 *   "in scope" differently without the two endpoints disagreeing about the fund,
 *   the programs or the floor — which is exactly the disagreement that would be
 *   invisible, because both would still return plausible rows.
 */
export function scopeClause(programs: readonly string[]): {
  /** A leading `WHERE`, to be interpolated into a statement that aliases `h` and `g`. */
  where: string;
  /** The program binds, `p0`, `p1`, … The caller adds `fund` and `since`. */
  binds: Record<string, string>;
} {
  if (programs.length === 0) {
    throw new AppError(
      500,
      'INTERNAL',
      'The organization selects no programs, so the live extract would be empty. ' +
        'That is a legal configuration for the scope picker and NOT one for the source of truth — ' +
        'fix the organization in Settings, or run with DB_MODE=local to read the frozen file.',
    );
  }

  const binds: Record<string, string> = {};
  const placeholders = programs.map((program, i) => {
    if (!PROGRAM_RE.test(program)) {
      throw new AppError(500, 'INTERNAL', `Program "${program}" is not a segment value this query can bind.`);
    }
    binds[`p${i}`] = program;
    return `:p${i}`;
  });

  return {
    // ★ `h.SEGMENT1` IS QUALIFIED AND `g.SEGMENT1` IS NOT AN OPTION. `SEGMENT1`
    //   exists on both `PO_HEADERS_ALL` and `GL_CODE_COMBINATIONS`, so the
    //   unqualified form is **ORA-00918: column ambiguously defined** — and the
    //   error arrives from a join that looks fine, naming a column rather than a
    //   clause. The fund segment is the code combination's segment 1 and the
    //   order number is the header's segment 1; they are unrelated quantities
    //   that happen to share a column name.
    where: `WHERE g.SEGMENT1 = :fund
       AND g.SEGMENT3 IN (${placeholders.join(', ')})
       AND h.APPROVED_DATE >= TO_DATE(:since, 'YYYY-MM-DD')`,
    binds,
  };
}

/**
 * Build the live statement for a tenant scope, at distribution grain.
 */
export function buildLiveSql(programs: readonly string[]): { sql: string; binds: Record<string, string> } {
  const { where, binds } = scopeClause(programs);

  const sql = `
    SELECT ${LIVE_COLUMNS}
      FROM PO_HEADERS_ALL h
      JOIN PO_LINES_ALL l
        ON l.PO_HEADER_ID = h.PO_HEADER_ID
      JOIN APPS.WCSEXP_PO_DISTRIBUTIONS wd
        ON wd.PO_LINE_ID = l.PO_LINE_ID
      JOIN GL_CODE_COMBINATIONS g
        ON g.CODE_COMBINATION_ID = wd.CODE_COMBINATION_ID
 LEFT JOIN APPS.WCSEXP_MTL_SYSTEM_ITEMS msi
        ON msi.INVENTORY_ITEM_ID = l.ITEM_ID
 LEFT JOIN APPS.PO_VENDORS v
        ON v.VENDOR_ID = h.VENDOR_ID
     ${where}
     ORDER BY h.SEGMENT1, l.LINE_NUM, wd.PO_DISTRIBUTION_ID`;

  return { sql, binds };
}

/**
 * The fiscal floor for a tenant, as `YYYY-MM-DD`.
 *
 * ★ THE SAME ARITHMETIC AS THE FRONTEND'S `fiscalYearStart`, DELIBERATELY.
 *   `app/src/data/scope.ts` says a scope answers *which rows* and the start year
 *   answers *from when*, and that the two are "reconciled in Phase 2". This is
 *   Phase 2, and the reconciliation only holds if both sides compute the same
 *   date: FY2022 starts `2021-07-01`. The floor is what holds the live read to the
 *   tenant's own stated reading window rather than a rule invented here, and the
 *   window is worth a great deal — measured against the live ledger, for fund `04`
 *   and programs 861/862:
 *
 *     no floor       82,036 rows   861 from 2014-05-14, 862 from 2017-04-04
 *     FY2022 floor   31,670 rows   both from 2021-07-01
 *     FY2023 floor   23,224 rows   both from 2022-07-01   ← the tenant today
 *
 * ★ ★ AND THAT TABLE IS THE POINT: THE ROW COUNT IS A FUNCTION OF `start_fy`, NOT A
 *   CONSTANT. This comment used to end "keeps the live read at ~31,656 rows instead
 *   of 82,007", quoting the FY2022 quantity as though it were a property of the
 *   endpoint. It is a property of the *tenant's configuration* — `start_fy` moved
 *   from 2022 to 2023, which is why the endpoint serves 23,224 today, and the
 *   31,656 was that same FY2022 quantity measured before a later load (it sits 14
 *   rows under 31,670, so it is one measurement of one thing and not a fourth
 *   number). The general lesson is in the table: whenever a figure here is a
 *   function of something a user can edit in Settings, the figure has to be
 *   quoted *with* the setting it belongs to, or it silently becomes wrong the day
 *   somebody changes it.
 */
export function fiscalFloor(startFy: number): string {
  return `${String(startFy - 1).padStart(4, '0')}-07-01`;
}

/** The frozen document, used whenever the ledger is not Oracle. */
const FROZEN_FILE = path.join(REPO_ROOT, 'data', 'oracle', 'full-output.json');

interface FrozenDocument {
  body?: { ResultSets?: { Table1?: Row[] } };
}

async function readFrozen(): Promise<Row[]> {
  const text = await readFile(FROZEN_FILE, 'utf8');
  const parsed = JSON.parse(text) as FrozenDocument;
  const table = parsed?.body?.ResultSets?.Table1;
  if (!Array.isArray(table)) {
    throw new AppError(
      500,
      'INTERNAL',
      `The frozen extract at ${FROZEN_FILE} does not contain body.ResultSets.Table1.`,
    );
  }
  return table;
}

// ---------------------------------------------------------------------------
// The cache.
// ---------------------------------------------------------------------------

/**
 * ★ TEN MINUTES, AND THE NUMBER IS A JUDGEMENT RATHER THAN A MEASUREMENT.
 *   The ledger is read-only, so any TTL is "correct"; what a TTL trades is request
 *   latency against how stale a page can be. Ten minutes is short enough that a
 *   reader who reloads after a nightly load sees the new data within one coffee,
 *   and long enough that a dozen page loads share one Oracle round trip. Override
 *   with `EXTRACT_CACHE_MS` — set it to `0` to disable caching entirely.
 *
 *   The scope is part of the key: two organizations with different scopes must not
 *   share a snapshot. Today there is one tenant, so the key is trivially stable,
 *   but a cache keyed on nothing would be a bug the moment a second one exists.
 *
 * ★ ★ THE UNSET CASE IS SPELLED OUT BECAUSE `Number('')` IS `0`, NOT `NaN`.
 *   The first draft was `Number(process.env.EXTRACT_CACHE_MS ?? '')`, guarded by
 *   `Number.isFinite(raw) && raw >= 0`. With the variable unset that reads `''`,
 *   which coerces to a **finite `0`** — so the guard *passed* and returned 0, i.e.
 *   "caching disabled", silently. The endpoint still answered correctly, so the
 *   only symptom was that every request took ~15 s against the live ledger and
 *   carried a fresh `generatedAt`; there was no error to follow. A default that is
 *   expressed as a fallback in the same expression as the parse is the trap — the
 *   blank string has to be tested BEFORE it is coerced.
 */
function cacheMs(): number {
  const text = process.env.EXTRACT_CACHE_MS?.trim();
  if (text === undefined || text === '') return 600_000;
  const raw = Number(text);
  return Number.isFinite(raw) && raw >= 0 ? raw : 600_000;
}

/**
 * The live document as an object, before serialisation.
 *
 * ★ `kind` IS NARROWED TO `'oracle'` BECAUSE ONLY A LIVE BUILD IS EVER CACHED.
 *   The frozen-fallback path assembles its document per request and is cheap to do
 *   so (it parses a 1.4 MB file the OS has already cached), so it does not need a
 *   snapshot — and giving it one would mean a fallback could outlive the condition
 *   that caused it.
 */
interface LiveDocument {
  source: {
    kind: 'oracle';
    // ★ NARROWER THAN `string`, AND IT WAS `string` UNTIL THE CACHE DOCUMENT HAD TO
    //   BE ASSIGNED TO THE RESPONSE SCHEMA. Nothing writes a third dialect, and
    //   `SqlDriver['dialect']` is already this union, so widening it in one interface
    //   was the only thing standing between the cached document and the type the
    //   route promises. Same reasoning as `kind` above, one field over.
    dialect: 'oracle' | 'sqlite';
    label: string;
    generatedAt: string;
    cached: boolean;
    forced: boolean;
    fallbackReason: null;
    scope: ExtractScope;
    observed: Observed;
    scopeMismatch: string | null;
    rows: number;
    orders: number;
    lines: number;
    amount: number;
  };
  body: { ResultSets: { Table1: Row[] } };
}

/**
 * The snapshot, held as the **document object** rather than as a string.
 *
 * ★ THE OBJECT, NOT THE SERIALISED STRING, AND THAT IS WHAT MAKES `cached` HONEST.
 *   Serialising once and replaying the string is cheaper — but the saved text
 *   carries `cached: false` from the moment it was built, so a cache HIT would keep
 *   reporting `cached: false` forever and `source.cached` would be a field that can
 *   only ever say one thing. Re-stringifying 13 MB costs tens of milliseconds
 *   against a cold read of ~15 s, so the honest version is also the cheap one.
 *
 *   `generatedAt` deliberately remains the moment the ledger was READ and is not
 *   refreshed on a hit, so a reader can see that the numbers are up to one TTL old.
 *   That is the same information a short-lived cache should convey.
 */
let cache: { key: string; at: number; doc: LiveDocument } | null = null;

/** Distinct counts and the amount total, computed in one pass over the rows. */
function summarise(table: Row[]): { rows: number; orders: number; lines: number; amount: number } {
  const orders = new Set<string>();
  const lines = new Set<string>();
  let amount = 0;
  for (const r of table) {
    const order = String(r.ORDER_NUMBER ?? '');
    orders.add(order);
    lines.add(`${order}#${String(r.LINE_NUMBER ?? '')}`);
    const n = typeof r.AMOUNT === 'number' ? r.AMOUNT : Number(r.AMOUNT ?? 0);
    if (Number.isFinite(n)) amount += n;
  }
  // Rounded to cents: a float sum of 31k values carries ~1e-9 of noise, and a
  // provenance figure printed as 2853948938.1800003 invites a bug report.
  return { rows: table.length, orders: orders.size, lines: lines.size, amount: Math.round(amount * 100) / 100 };
}

/**
 * The scope a request asked for.
 *
 * ★ NAMED, RATHER THAN SPELLED OUT AT EACH SITE, BECAUSE IT IS NOW COMPARED AGAINST
 *   SOMETHING. It used to be an anonymous literal written twice — once into the live
 *   document and once into the frozen one — and two copies of a scope that are never
 *   read together cannot disagree. The moment `observe()` exists to be compared with
 *   it, the ask becomes a value in its own right and gets a name.
 */
interface ExtractScope {
  slug: string;
  name: string;
  fund: string;
  programs: string[];
  startFy: number;
  from: string;
}

/** What the rows in a document actually contain. See `ExtractObservedSchema`. */
interface Observed {
  funds: string[];
  programs: string[];
  earliestOrderDate: string | null;
  latestOrderDate: string | null;
}

/**
 * A segment value as a reader should see it.
 *
 * ★ A BLANK SEGMENT IS A REAL VALUE AND IS PRINTED AS `(blank)`. An empty string
 *   joined into a sentence disappears, so a file whose `FUND` column is empty
 *   throughout would read as though the field had simply not been reported — which
 *   is the one reading that is definitely wrong.
 */
const show = (values: readonly string[]): string =>
  values.map((v) => (v === '' ? '(blank)' : v)).join('/');

/**
 * What is in these rows: the segments they are stamped with, and the window they span.
 *
 * ★ A SECOND PASS OVER THE ROWS, AND NOT FOLDED INTO `summarise`, BECAUSE IT ANSWERS
 *   A DIFFERENT QUESTION. `summarise` says *how much* is here — four numbers a reader
 *   uses as totals. This says *what* is here — which values the rows carry. Two
 *   questions with two audiences, and on 23,224 rows the extra pass is single-digit
 *   milliseconds against a ~2 s live read, so sharing the loop would buy nothing and
 *   cost the ability to read either function on its own.
 *
 * ★ TEN CHARACTERS OF DATE, BECAUSE THE TWO SOURCES SPELL IT DIFFERENTLY. The live
 *   statement emits `TO_CHAR(h.APPROVED_DATE, 'YYYY-MM-DD')`; the frozen export wrote
 *   `2025-05-20T00:00:00`. Compared as strings those order correctly *within* either
 *   source and wrongly between them — `-` sorts before `T`, so every live date beats
 *   every frozen date for no reason. Truncating to the date's own ten characters
 *   makes both spellings comparable, which is also what makes the `<`/`>` against
 *   `scope.from` valid: `YYYY-MM-DD` orders chronologically as text.
 */
function observe(table: Row[]): Observed {
  const funds = new Set<string>();
  const programs = new Set<string>();
  let earliest: string | null = null;
  let latest: string | null = null;
  for (const r of table) {
    funds.add(String(r.FUND ?? ''));
    programs.add(String(r.PROGRAM ?? ''));
    const date = String(r.ORDER_DATE ?? '').slice(0, 10);
    if (date === '') continue;
    if (earliest === null || date < earliest) earliest = date;
    if (latest === null || date > latest) latest = date;
  }
  // Sorted, so two responses over the same rows are byte-identical and a diff of two
  // envelopes is a diff of facts rather than of the order a Set happened to build.
  return {
    funds: [...funds].sort(),
    programs: [...programs].sort(),
    earliestOrderDate: earliest,
    latestOrderDate: latest,
  };
}

/**
 * The gap between the ask and the rows, as a sentence — or `null` when they agree.
 *
 * ★ IT REPORTS BOTH DIRECTIONS. Rows *missing* from the ask are the failure REQ-J was
 *   filed about (the frozen file's 861), but rows *outside* the ask are the same bug
 *   wearing the other coat — a wider extraction than the tenant asked for — and a
 *   function that only looks for shortfalls would call that agreement. Both are
 *   clauses here; only the first is the one that actually fires today.
 */
function scopeShortfall(ask: ExtractScope, observed: Observed): string | null {
  const parts: string[] = [];

  const missing = ask.programs.filter((p) => !observed.programs.includes(p));
  if (missing.length > 0) {
    parts.push(
      `it holds no rows at all for program ${show(missing)} of the requested ${show(ask.programs)}`,
    );
  }
  const extra = observed.programs.filter((p) => !ask.programs.includes(p));
  if (extra.length > 0) {
    parts.push(`it holds rows for program ${show(extra)}, which the scope does not ask for`);
  }
  const otherFunds = observed.funds.filter((f) => f !== ask.fund);
  if (otherFunds.length > 0) {
    parts.push(`it holds rows for fund ${show(otherFunds)} outside the requested fund ${ask.fund}`);
  }
  if (observed.earliestOrderDate !== null && observed.earliestOrderDate > ask.from) {
    parts.push(
      `its earliest order date is ${observed.earliestOrderDate}, after the requested floor of ${ask.from}`,
    );
  }

  if (parts.length === 0) return null;
  return `The rows do not match the requested scope: ${parts.join('; ')}.`;
}

// ---------------------------------------------------------------------------
// The route.
// ---------------------------------------------------------------------------

export function extractRouter(): Router {
  const api = createApi();

  api.route({
    method: 'get',
    path: '/api/extract/current',
    operationId: 'getCurrentExtract',
    summary: 'The current extract, read from the live ledger',
    description:
      'The document the whole application is computed from: one row per purchase-order line, carrying ' +
      'both the line detail and its account combination’s seven segments.\n\n' +
      '★ **This is a drop-in replacement for the static `/oracle/output.json`**, and the body is ' +
      'deliberately *not* this API’s `{ data }` envelope — it reproduces the export’s own ' +
      '`{ body: { ResultSets: { Table1: [ … ] } } }` so the frontend can swap the URL and change ' +
      'nothing else. A `source` block sits alongside it saying which ledger answered and over what.\n\n' +
      '★ **The database is the source of truth; the frozen file is the fallback.** When the ledger is ' +
      'Oracle this reads the tenant’s live scope — fund, programs and a fiscal floor derived from ' +
      '`start_fy` — through `PO_HEADERS_ALL` / `PO_LINES_ALL` / `APPS.WCSEXP_PO_DISTRIBUTIONS` / ' +
      '`GL_CODE_COMBINATIONS` / `APPS.WCSEXP_MTL_SYSTEM_ITEMS` / `PO_VENDORS`. When the ledger is ' +
      'SQLite (the default `DB_MODE=local`) there is no live ledger to read, so it serves the frozen ' +
      'document instead and says so in `source.kind`.\n\n' +
      '★ **`BUYER_NAME` is always empty from the live path.** The account holds 51 grants and not one ' +
      'is a person or HR table, so a buyer’s name cannot be resolved. It is emitted blank rather than ' +
      'guessed.\n\n' +
      '★ **Expect the numbers to change.** The frozen file holds 2,782 rows over 742 orders, all of them ' +
      'fund `04` and program `862`, **with not one row of 861**, over order dates 2025-01-02 to ' +
      '2026-08-06. The live tenant scope holds **31,670 rows / 31,401 distinct lines / 5,692 orders / ' +
      '$2,797,825,956.73** over 2021-07-01 to 2026-08-07, so the ledger is an order of magnitude larger ' +
      'than the file. Every total in the app is a sum over these rows, so every one of them moves. That ' +
      'is the point of the change, not a regression. Note the tenant asks for programs 861/862/863 while ' +
      'the rows carry only 861 and 862 — **program 863 holds no rows at all in this ledger**, which ' +
      '`source.scopeMismatch` states in words rather than leaving a reader to infer it from the counts.\n\n' +
      '★ **`source.observed` reports what the rows contain; `source.scope` reports what was asked for.** ' +
      'Read them together and a mismatch is visible instead of inferred: on a healthy live read the two ' +
      'agree (the SQL binds the fund and the programs), while the frozen file answers ' +
      '`programs: ["862"]` against a `scope` of `["861","862","863"]`. `source.scopeMismatch` states that gap ' +
      'in words (null when there is none, and null with no `scope` at all) and `source.fallbackReason` ' +
      'says *why* the ledger was not read — two fields, because "why is this not the ledger" and "does ' +
      'this cover the ask" are different questions. The app’s own Dashboard measures the same gap off ' +
      'the rows client-side, so the page can say it without trusting either field; these exist so a ' +
      'consumer that is not that page can see it in the payload. Note also that the row counts above ' +
      'are a function of the organization’s `start_fy` and not constants: the same query returns ' +
      '31,670 rows at the FY2022 floor and 82,036 with no floor at all. Change `start_fy` in Settings ' +
      'and these move.\n\n' +
      '★ Note the row total exceeds the line total: a line with more than one distribution contributes a ' +
      'row each, which is why the count of rows is not the count of lines.\n\n' +
      '★ Rows are cached in-process for ten minutes (`EXTRACT_CACHE_MS`; `0` disables). `?refresh=1` ' +
      'forces a rebuild — use it when you have just loaded the ledger and cannot wait.',
    tags: ['Meta'],
    query: z.object({
      refresh: FlagQuery.optional().openapi({
        description: 'Rebuild from the ledger even if a cached document is still fresh.',
      }),
    }),
    response: ExtractDocumentSchema,
    rawBody: true,
    handler: async ({ query: q }) => {
      const { source, table } = await buildExtract(isTrue(q.refresh));
      return raw(JSON.stringify({ source, body: { ResultSets: { Table1: table } } }));
    },
  });

  api.route({
    method: 'get',
    path: '/api/extract/order-numbers',
    operationId: 'getExtractOrderNumbers',
    summary: 'The order numbers the current extract holds',
    description:
      'Every distinct `ORDER_NUMBER` in the document `GET /api/extract/current` serves, and nothing ' +
      'else — 5,692 strings where that document is 31,670 rows and about 11 MB.\n\n' +
      '★ **THIS EXISTS SO A CLIENT CAN ASK A QUESTION ABOUT THE REGISTER WITHOUT HOLDING IT.** ' +
      'The invoice register records which order an invoice names; whether the application can ' +
      '*open* that order is a different question about a different document. `/spend/invoices` ' +
      'fetches this list and decides each row against it, so an order is never reported absent ' +
      'from a register the reader can open in the next tab.\n\n' +
      '★ **IT IS A PROJECTION OF THE SAME READ, NOT A SECOND ONE.** `buildExtract` is the single ' +
      'place the document is built, cached and fallen back from, and both routes call it — so the ' +
      'two cannot describe different ledgers over different scopes, and a cache hit serves both. ' +
      '`source` is the same block `/current` returns, field for field.\n\n' +
      '★ **WHY NOT A FIELD ON `/current`.** Adding the numbers there would mean every client that ' +
      'wants them must first receive 11 MB of rows it will not read. The list is ~60 KB.',
    tags: ['Meta'],
    response: OrderNumbersSchema,
    handler: async () => {
      const { source, table } = await buildExtract(false);
      const numbers = distinctOrderNumbers(table);
      return { source, count: numbers.length, numbers };
    },
  });

  return api.router;
}

/**
 * ★ ONE READ, TWO PROJECTIONS — AND THE SPLIT IS WHAT KEEPS THEM HONEST.
 *
 * `/api/extract/current` needs the rows; `/api/extract/order-numbers` needs one column
 * of them. Both must describe the **same** ledger over the **same** scope, and two
 * independent reads could not promise that: a scope changed in Settings between the two
 * would leave the invoice page comparing invoices against a register the order page does
 * not show. So this function is the single place the document is built, the cache is read
 * and written, and the frozen fallback is decided — and each route is a projection of its
 * result.
 *
 * ★ IT HANDS BACK THE ROWS AND THE PROVENANCE SEPARATELY, RATHER THAN AN ENVELOPE. The two
 *   callers want different bodies and the identical `source`, so building the envelope here
 *   would mean one route unwrapping what the other wants. Hoisting it also means the
 *   fallback's `fallbackReason` and the live arm's absence of one are decided once, which is
 *   the property a reader depends on when they compare the two endpoints.
 */
async function buildExtract(forced: boolean): Promise<{ source: ExtractSource; table: Row[] }> {
  const ledger = db.stores().find((s) => s.id === 'ledger');
  if (ledger === undefined) {
    throw new AppError(500, 'INTERNAL', 'No ledger store is configured, so there is nothing to read.');
  }

  // ★ A NON-ORACLE LEDGER IS NOT AN ERROR — IT IS `DB_MODE=local`, the default
  //   and the configuration every test runs under. The frontend's own
  //   `loadExtract()` falls back to the static file for exactly this case, and
  //   this arm makes the endpoint answer rather than 500 so that a client which
  //   *does* point at the API in local mode still gets a working document.
  if (ledger.dialect !== 'oracle') {
    const table = await readFrozen();
    const s = summarise(table);
    return {
      source: {
        kind: 'file',
        dialect: ledger.dialect,
        label: ledger.label,
        generatedAt: new Date().toISOString(),
        cached: false,
        forced,
        fallbackReason:
          `The ledger is ${ledger.dialect} (DB_MODE=${ledger.dialect === 'sqlite' ? 'local' : ledger.dialect}), ` +
          'so there is no live ledger to read. Serving the frozen extract.',
        // ★ `scope` IS NULL HERE AND `observed` IS NOT, WHICH IS THE WHOLE
        //   DISTINCTION IN ONE RESPONSE. This arm returns before the tenant is
        //   read, so there is no ask to report and inventing one — filling in
        //   the default organization's scope as though it had been applied —
        //   would claim the file was filtered when nothing filtered it.
        //   `observed` is filled in regardless, because what is in the rows is
        //   a property of the bytes being served and not of any tenant.
        scope: null,
        ...s,
        observed: observe(table),
        // ★ NULL, AND NOT BECAUSE THE FILE AGREES WITH ANYTHING. With no ask there
        //   is nothing to measure a shortfall *against*, so `null` here means
        //   "not asked", which is a different statement from "asked and matched".
        //   `observed` beside it carries the facts either way.
        scopeMismatch: null,
      },
      table,
    };
  }

  const tenant = await defaultTenant();
  const since = fiscalFloor(tenant.startFy);
  const key = `${tenant.slug}|${tenant.fund}|${tenant.programs.join(',')}|${since}`;
  // ★ THE ASK, BUILT ONCE. Both the live document and the frozen one carry it,
  //   and the frozen path also measures the file *against* it — so a second copy
  //   would be a copy that could disagree with the thing it is compared to.
  const ask: ExtractScope = {
    slug: tenant.slug,
    name: tenant.name,
    fund: tenant.fund,
    programs: tenant.programs,
    startFy: tenant.startFy,
    from: since,
  };

  const ttl = cacheMs();
  if (!forced && cache !== null && cache.key === key && Date.now() - cache.at < ttl) {
    // ★ A HIT IS REPORTED AS A HIT, AND `generatedAt` STAYS PUT. It says when
    //   the ledger was read, which is the fact a reader needs in order to judge
    //   whether a number is stale — not when this particular response was minted.
    const hit: LiveDocument = { ...cache.doc, source: { ...cache.doc.source, cached: true } };
    return { source: hit.source, table: hit.body.ResultSets.Table1 };
  }

  // ★ THE LIVE READ IS ALLOWED TO FAIL WITHOUT FAILING THE REQUEST, AND THE
  //   REASON IS THAT THE OLD SOURCE IS STILL CORRECT — just older. A reader who
  //   gets the frozen document plus `fallbackReason` is better served than one
  //   who gets a 500 on a screen that worked ten minutes ago. What must NOT
  //   happen is a silent fallback: hence the field, which the frontend surfaces.
  let fallbackReason: string | null = null;
  try {
    const { sql, binds } = buildLiveSql(tenant.programs);
    // ★ `storeDriver('ledger')` RATHER THAN `rows(...)`, AND THE CHOICE IS
    //   DELIBERATE. `rows()` routes the statement by the tables it names, and
    //   this one names `APPS.WCSEXP_*` views that the registry has never heard
    //   of — so it would be routed to the ledger by the *default* arm rather
    //   than by a decision. That default is right today and would be silently
    //   wrong the day a name collides. This statement is ledger SQL by nature,
    //   so it asks for the ledger store by name, exactly as `routes/views.ts`
    //   asks for the app store by name for the opposite reason.
    const res = await storeDriver('ledger').execute({
      sql,
      args: { ...binds, fund: tenant.fund, since },
    });
    const table = res.rows;
    if (table.length === 0) {
      // ★ ZERO ROWS IS TREATED AS A FAILURE, NOT AS AN ANSWER. A live scope that
      //   returns nothing means the query and the tenant disagree about how a
      //   segment is spelled, and reporting that as "this organization has no
      //   activity" is the wrong-data-presented-as-a-legitimate-zero failure
      //   this codebase has been bitten by before.
      throw new Error(
        `the live scope (fund ${tenant.fund}, programs ${tenant.programs.join('/')}, from ${since}) matched no rows`,
      );
    }
    const observed = observe(table);
    const doc: LiveDocument = {
      source: {
        kind: 'oracle',
        dialect: ledger.dialect,
        label: ledger.label,
        generatedAt: new Date().toISOString(),
        cached: false,
        forced,
        fallbackReason: null,
        scope: ask,
        ...summarise(table),
        observed,
        // ★ COMPUTED ON THE LIVE PATH TOO, AND IT IS NOT REDUNDANT. The SQL binds
        //   the fund and the programs, so on a healthy read `observed` must equal
        //   `scope` and this is `null` — which makes it the one place a bind that
        //   silently failed to filter would show up, since a widened read is
        //   otherwise a perfectly plausible answer the totals would hide. It is
        //   also the reason the field is on the *schema* rather than only on the
        //   fallback: a field that appears solely when something went wrong cannot
        //   be asserted absent, so no caller could tell agreement from omission.
        scopeMismatch: scopeShortfall(ask, observed),
      },
      body: { ResultSets: { Table1: table } },
    };
    cache = { key, at: Date.now(), doc };
    return { source: doc.source, table };
  } catch (e) {
    fallbackReason = e instanceof Error ? e.message : String(e);
  }

  const table = await readFrozen();
  const s = summarise(table);
  const observed = observe(table);
  return {
    source: {
      kind: 'file',
      dialect: ledger.dialect,
      label: ledger.label,
      generatedAt: new Date().toISOString(),
      cached: false,
      forced,
      // ★ THE CAUSE, AND ONLY THE CAUSE. See `scopeMismatch` in the schema for why
      //   the shortfall is not appended here.
      fallbackReason,
      scope: ask,
      ...s,
      observed,
      scopeMismatch: scopeShortfall(ask, observed),
    },
    table,
  };
}

/**
 * Every distinct `ORDER_NUMBER` in the rows, sorted.
 *
 * ★ THE KEY IS DERIVED EXACTLY AS `summarise` DERIVES IT — `String(row.ORDER_NUMBER ??
 *   '')`, with no trimming and no case folding — so `count` on this endpoint always
 *   equals `source.orders` on `/current`. Two spellings of "the same" set would be two
 *   numbers a reader could compare and find disagreeing, and the disagreement would be
 *   in the comparison rather than in the data.
 *
 * ★ SORTED, BECAUSE THE ARRAY IS INSPECTED BY PEOPLE. The rows arrive in query order,
 *   so an unsorted projection of them would look shuffled in the payload for no reason
 *   a reader could name. With ~5.7k strings the sort costs nothing.
 */
function distinctOrderNumbers(table: Row[]): string[] {
  const numbers = new Set<string>();
  for (const r of table) numbers.add(String(r.ORDER_NUMBER ?? ''));
  return [...numbers].sort();
}
