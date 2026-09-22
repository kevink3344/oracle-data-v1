import type { ExtractEnvelope, ExtractLine, RawExtractRow } from './types';
import { isoDay } from './format';

/**
 * Fetches the purchase-order extract.
 *
 * ★ ★ THE DATABASE IS THE SOURCE OF TRUTH. THE FILE IS A CACHE OF IT.
 *   This function used to read `/oracle/output.json` — a 2 MB snapshot exported
 *   from Oracle at some point and then frozen. It now reads
 *   `GET /api/extract/current`, which reads the ledger and re-emits the *same
 *   document shape*. The static file survives only as the offline fallback, so
 *   `vite dev` with no API and the smoke suite still work.
 *
 *   THIS REVERSES AN EARLIER RECOMMENDATION, AND THE EARLIER ONE WAS WRONG ON TWO
 *   MEASURED POINTS. It said the extract's 2,781 rows were a subset of Oracle's
 *   3,039 for the same 742 documents and that the selection rule had gone with a
 *   "retired" view. Both are false:
 *
 *   1. THE `APPS.WCSEXP_*` VIEW FAMILY IS NOT RETIRED. All nineteen views are in
 *      the account's grant list. ★ A CLAIM ABOUT ORACLE, AND ONLY ORACLE: the Turso
 *      sample retired its own 18 hand-written ports of these names, so
 *      `WCSEXP_PO_DISTRIBUTIONS` does not exist there at all and this is not in
 *      conflict with `00-schema.sql` §5, which is a claim about the sample. The two
 *      are different objects sharing a name — docs/implementation/wcsexp-view-names.md.
 *      `WCSEXP_PO_DISTRIBUTIONS.AMOUNT_ORDERED` is a
 *      *computed* column — `ROUND(DECODE(PLL.QUANTITY, NULL, PLL.AMOUNT - NVL(PLL.AMOUNT_CANCELLED,0),
 *      (PLL.QUANTITY - NVL(PLL.QUANTITY_CANCELLED,0)) * NVL(PLL.PRICE_OVERRIDE,0)), 2)` —
 *      reading the price from `PO_LINE_LOCATIONS_ALL`, and it reproduces this
 *      file's `AMOUNT` on every row probed, including the one that discriminates:
 *      order `275678` line `3` has `AMOUNT` **73.83** against a `QUANTITY` of
 *      **3**. Plain `PO_DISTRIBUTIONS_ALL.AMOUNT_ORDERED` is NULL, which is what
 *      made the old note generalise "UNIT_PRICE is 1.00 so AMOUNT IS QUANTITY" —
 *      **that generalisation is retracted.** `WCSEXP_MTL_SYSTEM_ITEMS.SEGMENT1`
 *      likewise reproduces `ITEM_NUMBER` exactly.
 *
 *   2. 2,781 IS A STALE COUNT, NOT A DIFFERENT ROW SET. It is what one export saw.
 *      The ledger's own numbers for fund `04` are **38,158 distinct lines** under
 *      program `861` and **43,483** under `862`. Program `863` exists nowhere in
 *      Oracle — that one really is empty, so a "no lines" chip for it is honest.
 *
 *   WHAT REPLACED THE ROW-SELECTION RULE: the organization's own configuration,
 *   which is where a scope belongs anyway. `GET /api/extract/current` reads the
 *   default tenant (`organization.fund`, `organization.programs_json`,
 *   `organization.start_fy`) and selects
 *   `GL_CODE_COMBINATIONS.SEGMENT1 = fund AND SEGMENT3 IN (programs…) AND
 *   PO_HEADERS_ALL.APPROVED_DATE >= fiscalYearStart(start_fy)`. For the default
 *   tenant that is fund 04, programs 861/862, floored at `2021-07-01` — **~31,656
 *   rows and ~$2.85 B**, which is the honest figure and is ~11× what this file
 *   used to show.
 *
 *   TWO CONSEQUENCES WORTH KNOWING BEFORE READING A NUMBER OFF THE SCREEN:
 *
 *   • `BUYER_NAME` ARRIVES NULL. The account's 51 grants contain no person or HR
 *     table at all — `PER_PERSON_NAMES_F` and `PER_ALL_PEOPLE_F` are ORA-00942 and
 *     `PO_AGENTS#` exposes only generic `ATTRIBUTE1..15`. The frozen file has the
 *     name because the export view joined something this account cannot reach.
 *     The server emits `null` rather than inventing a value; the app already
 *     renders an empty buyer as `—`.
 *
 *   • THE PAYLOAD IS ~11 MiB, NOT 2 MB. Re-serialising that per request would be
 *     wasteful, so the server caches the built document for ten minutes and
 *     reports that in `source.cached`. `normalise()` below is unchanged, which is
 *     the point: the shape is identical, so nothing downstream moved.
 */
export async function loadExtract(signal?: AbortSignal): Promise<ExtractLoad> {
  const { envelope, source } = await readEnvelope(signal);
  const rows = envelope?.body?.ResultSets?.Table1;
  if (!Array.isArray(rows)) {
    throw new Error('The extract did not contain body.ResultSets.Table1.');
  }

  const lines = rows.map(normalise).filter((l) => l.cancelFlag !== 'Y');
  if (lines.length === 0) throw new Error('The extract contained no usable rows.');
  return { lines, source };
}

/**
 * The rows, and where they came from.
 *
 * ★★ THE PROVENANCE IS RETURNED, NOT MERELY LOGGED, BECAUSE A SCOPE WITHOUT ITS SOURCE IS A CLAIM.
 *
 *   The account scope is **Fund `04`, programs `861` and `862`** — that is the tenant's configuration
 *   and the rule `GET /api/extract/current` narrows the SQL by. A reader is entitled to see that a
 *   figure is that slice. What they cannot see, today, is the one state in which it is *not*:
 *
 *   | Source | Rows | Fund | Programs | Committed |
 *   |---|---|---|---|---|
 *   | live ledger (`/api/extract/current`) | 23,224 | `04` | **`861`, `862`** | $2,697,813,470.53 |
 *   | bundled snapshot (`/oracle/output.json`) | 2,782 | `04` | **`862` only** | $430,569,026.92 |
 *
 *   **The bundled snapshot is not a stale copy of the same dataset — it is a different, narrower
 *   one.** Measured, it holds 550 fewer rows of program `861` than the live read and no row of `861`
 *   at all, and its window opens in January 2025 rather than July 2022. So a fallback does not merely
 *   *reduce* the numbers: it changes which programs are in them. Rendering that under a heading that
 *   says `Fund 04 · program 861/862` is the app asserting a scope it is not serving, which is the
 *   exact failure the account scope exists to prevent — and it was invisible, because the only notice
 *   was on the console.
 *
 *   `loadExtract` used to throw the server's `source` block away and return a bare array, so no
 *   component *could* say any of this. It now hands the block to the store, which hands it to the
 *   pages. Both fallbacks report through it: the server's own (which stamps `kind: 'file'` and the
 *   reason the live read failed) and this module's, which stamps `BUNDLED_SOURCE` below.
 *
 *   `kind === 'oracle'` means the live ledger answered. Every page that names the scope should ask.
 */
export interface ExtractLoad {
  lines: ExtractLine[];
  /** `null` only when the server answered without a provenance block. */
  source: ExtractSource | null;
}

/**
 * What this module reports when *it* fell back, not the server.
 *
 * `fallbackReason` is filled in with the fetch error, so the page can say which way the read failed —
 * `Failed to fetch` when the API is not running, `HTTP 503` when it answered but refused.
 */
const BUNDLED_SOURCE: ExtractSource = {
  kind: 'file',
  dialect: 'static',
  label: '/oracle/output.json',
  generatedAt: '',
  cached: false,
  forced: true,
  fallbackReason: null,
};

/**
 * Read the document from the API, falling back to the frozen file.
 *
 * ★ THE FALLBACK IS NOT A SILENT ONE. If the live read fails the app still works
 *   — which is what keeps a Vite-only dev session and the smoke suite usable —
 *   but a count that quietly reverts to 2,781 would be indistinguishable from
 *   REQ-J never having shipped. So every fallback says so on the console, with
 *   the server's own `source.fallbackReason` when there is one.
 *
 *   The 11 MiB payload is deliberately NOT cached in `localStorage` or in a
 *   module variable here: the server already caches it, and a second cache with a
 *   different lifetime is how a reader ends up looking at two different totals.
 */
async function readEnvelope(
  signal?: AbortSignal,
): Promise<{ envelope: ExtractEnvelope; source: ExtractSource | null }> {
  try {
    const res = await fetch('/api/extract/current', { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const envelope = (await res.json()) as ExtractEnvelope & { source?: ExtractSource };
    warnIfDegraded(envelope.source);
    return { envelope, source: envelope.source ?? null };
  } catch (err) {
    if (signal?.aborted) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      '[extract] the live ledger read failed, falling back to the frozen file:',
      reason,
    );
    const res = await fetch('/oracle/output.json', { signal });
    if (!res.ok) {
      throw new Error(`Could not read the extract (HTTP ${res.status} ${res.statusText}).`);
    }
    const envelope = (await res.json()) as ExtractEnvelope;
    return { envelope, source: { ...BUNDLED_SOURCE, fallbackReason: reason } };
  }
}

let degradedNotice: string | null = null;

/**
 * Say once — not on every reload — when the server served a fallback or a file.
 *
 * ★ THE CONSOLE IS NOT A SURFACE A READER IS LOOKING AT. This notice used to be the *only* place a
 *   fallback was announced, which made a 862-only snapshot indistinguishable from the live scope on
 *   screen. It stays — it is one line and it names the server's own reason — but the fact now also
 *   travels to the store through `ExtractLoad.source`, and the Dashboard says it in the page head.
 */
function warnIfDegraded(source: ExtractSource | undefined): void {
  if (!source) return;
  const note =
    source.kind === 'file'
      ? `the server is serving the frozen file (${source.fallbackReason ?? 'no reason given'})`
      : source.fallbackReason
        ? `the live read failed: ${source.fallbackReason}`
        : null;
  if (note && note !== degradedNotice) {
    degradedNotice = note;
    console.warn(`[extract] ${note}`);
  }
}

/**
 * The provenance block the server stamps on the document.
 *
 * Exported because the store carries it and the pages read it: `kind` is the only field that says
 * whether the live ledger answered, and it is what lets a page that names the account scope also say
 * when the document it was handed is narrower than that scope.
 *
 * ★ THIS IS A HAND-COPIED MIRROR OF A SERVER SHAPE, SO IT IS THE ONE PLACE THE TWO CAN DRIFT.
 *   The server's version is a Zod schema (`ExtractSourceSchema` in `server/src/routes/extract.ts`),
 *   nothing generates this one, and a field absent here is invisible to the compiler — every read of
 *   the payload goes through a cast. So the two server fields below are declared even though **this
 *   app does not read either of them**, because leaving them out is how the mirror silently stops
 *   being a mirror.
 *
 * ★ WHY THE APP DOES NOT READ THEM, and why that is the right call rather than an oversight.
 *   They report the gap between what the request asked for (`scope`) and what the served rows contain
 *   (`observed`). `Dashboard.tsx` needs the same fact and measures it from `scopeStats.programsPresent`,
 *   i.e. from the rows it already has — and that is strictly the better source *here*, because it also
 *   covers the fallback this module performs itself (`BUNDLED_SOURCE`), where there is no server
 *   payload at all and therefore no `scope`/`observed`/`scopeMismatch` to read. Taking them from the
 *   server would make the sentence correct on one path and absent on the other.
 *
 *   They are declared, rather than ignored, for the benefit of every consumer that is *not* this app:
 *   `GET /api/extract/current` is documented as a drop-in for the static file, so a script or a person
 *   reading the JSON needs to be able to tell a scope-correct answer from a narrower one.
 *
 * ★ `observed` AND `scopeMismatch` ARE OPTIONAL; `scope` IS NOT DECLARED AT ALL. Optional because a
 *   `BUNDLED_SOURCE` (the client-side fallback) genuinely has neither — the server never built that
 *   payload. `scope` is left off because nothing in this app reads it and the tenant's own `programs`
 *   is what a page should compare against; declaring it would invite exactly the server-trusting
 *   dependency the paragraph above argues against.
 */
export interface ExtractSource {
  kind: 'oracle' | 'file';
  dialect: string;
  label: string;
  generatedAt: string;
  cached: boolean;
  forced: boolean;
  fallbackReason: string | null;
  /** What the served rows contain — funds, programs and the order-date window. Server payloads only. */
  observed?: {
    funds: string[];
    programs: string[];
    earliestOrderDate: string | null;
    latestOrderDate: string | null;
  } | null;
  /** The gap between the requested scope and `observed`, in words; null when they agree. */
  scopeMismatch?: string | null;
}

interface NormalisedLine extends ExtractLine {
  cancelFlag: string;
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const asNumber = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};

function normalise(r: RawExtractRow): NormalisedLine {
  const fund = str(r.FUND);
  const purpose = str(r.PURPOSE);
  const program = str(r.PROGRAM);
  const object = str(r.OBJECT_);
  const level = str(r.LEVEL_);
  const costCenter = str(r.COST_CENTER);
  const futureUse = str(r.FUTURE_USE);

  return {
    orderDate: isoDay(str(r.ORDER_DATE)),
    orderNumber: str(r.ORDER_NUMBER),
    buyer: str(r.BUYER_NAME),
    vendor: str(r.VENDOR_NAME),
    lineNumber: str(r.LINE_NUMBER),
    itemNumber: str(r.ITEM_NUMBER),
    description: str(r.DESCRIPTION),
    quantity: asNumber(r.QUANTITY),
    amount: asNumber(r.AMOUNT),
    status: str(r.STATUS),
    fund,
    purpose,
    program,
    object,
    level,
    costCenter,
    futureUse,
    combinationKey: [fund, purpose, program, object, level, costCenter, futureUse].join('-'),
    cancelFlag: str(r.CANCEL_FLAG).toUpperCase(),
  };
}
