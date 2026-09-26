import { z } from '../http/z.js';
import type { Api } from '../http/api.js';
import { concatExpr, one, quoteIdent, rows } from '../db/sql.js';
import { intReq, real, realReq, text, textReq } from '../schemas/columns.js';

/**
 * ★ THE SEVEN SEGMENTS OF THE ACCOUNT KEY, IN ORDER, AS THEIR OWN LIST.
 *
 * The key is exactly these seven, joined with dots, in this order — the order
 * is load-bearing, because `V_CODE_COMBINATION_KEY.COMBINATION_KEY` is built the
 * same way and a reordered list would produce a key that matches nothing while
 * looking entirely plausible.
 *
 * ★ `concatExpr` SPELLS THE JOIN OPERATOR PER DIALECT. SQLite and Oracle use
 *   `||`; T-SQL uses `+` and has no `||` at all. The operator is chosen at the
 *   query rather than rewritten in the driver, because `+` is also numeric
 *   addition and the driver cannot tell the two apart — see `concatOp` in
 *   `db/sql.ts` for why guessing there would fail *silently*.
 */
const ACCOUNT_SEGMENT_COLUMNS = [
  'SEGMENT1',
  'SEGMENT2',
  'SEGMENT3',
  'SEGMENT4',
  'SEGMENT5',
  'SEGMENT6',
  'SEGMENT7',
] as const;

/**
 * Commitments & Spend — the encumbrance screen's one endpoint.
 *
 * ─── WHAT AN ENCUMBRANCE IS HERE, AND WHY THIS ENDPOINT IS SHAPED LIKE THIS ──
 *
 * ★★ THIS ENDPOINT CANNOT RUN IN `DB_MODE=oracle`, AND EVERY FIGURE BELOW IS A
 *    SAMPLE-STORE FIGURE. The PO side reads `V_ENCUMBRANCE_FROM_PO`, which is a
 *    view **this app creates in its own store** — `data/sql/turso/00-schema.sql` line
 *    748, `CREATE VIEW IF NOT EXISTS V_ENCUMBRANCE_FROM_PO AS …`. The Oracle ledger has
 *    no object of that name at all, so the first statement in the handler below throws
 *    `ORA-00942: table or view does not exist` out of `db/oracle.ts` and the route
 *    answers 500. Measured twice, independently:
 *
 *      1. The smoke suite, which logs
 *         `[http] GET /api/spend/encumbrances threw: Error: ORA-00942 … at Object.handler
 *         (server/src/routes/spend.ts:287:22)` — the `:287` is where the statement sat
 *         before this comment was extended, and the stack frame names the failing
 *         statement unambiguously.
 *      2. `db/derived.ts` composes **exactly three** views — `V_SEGMENT_LEGEND`,
 *         `V_BUDGET_BY_ACCOUNT_PERIOD` and `V_ACCOUNT_POSITION`, the same three names in
 *         `store.ts`'s `DERIVED_TABLES`. `V_ENCUMBRANCE_FROM_PO` is **not** among them, so
 *         the resolver has no entry to route to and the name falls through to the ledger.
 *
 *    **This is the `vendor_site_route` failure in a different costume** — a name the app
 *    itself provisions, read from a store that does not have it — and it is a **mode
 *    parity** defect, not a broken query: the endpoint works under `DB_MODE=turso` and
 *    500s under `DB_MODE=oracle`, and nothing about the error says which. It is also
 *    **unrelated to `FUND_CODE`**; it predates that change and the fund list does not
 *    reach it.
 *
 *    The fix is a decision rather than a typo, and the decision is not a small one.
 *    Either (a) the PO side is recomposed in `db/derived.ts` over the tables Oracle *does*
 *    have — `PO_DISTRIBUTIONS_ALL` joined to `GL_CODE_COMBINATIONS`, the same two the
 *    third statement in this handler already reads — or (b) the route declares a
 *    documented 503 through `AppError.dbUnavailable` naming the mode it needs. What it
 *    must not keep doing is 500 with a raw Oracle error, because that reads as a bug in
 *    the query rather than a statement about the deployment. **Option (a) needs a scope
 *    decision this file cannot make on its own**: whether the composed PO figure honours
 *    `FUND_CODE` / `PROGRAM_CODE` / `START_YEAR` like the three existing fragments, or
 *    reports the whole ledger's purchase orders. Choosing silently would put this one
 *    screen at a different scope from every other screen.
 *
 *    ★ The figures in this comment are therefore **not** claims about the ledger.
 *    335 combinations and $430,580,538.04 come from the capped sample copy, so they
 *    will not be reproduced by any composition over the live tables — the live
 *    `PO_DISTRIBUTIONS_ALL` is far larger. Re-measure before quoting any of them
 *    against Oracle, and label whichever set a screen is showing.
 *
 *   PO SIDE — `V_ENCUMBRANCE_FROM_PO`, one row per account combination that some
 *     purchase-order distribution with `ENCUMBERED_FLAG = 'Y'` was charged to.
 *     Measured on this sample: **335 combinations, $430,580,538.04**.
 *
 *   GL SIDE — `V_ACCOUNT_POSITION.ENCUMBRANCES`, which sums `GL_BALANCES` under
 *     `ACTUAL_FLAG = 'E'`. This is the report's own encumbrance column and the
 *     same figure `GET /api/funding/positions` and the Budgets screen already
 *     serve. Measured here: **4 combinations, $5,198,165.65**.
 *
 * ★ THE FINDING THE ENDPOINT EXISTS TO CARRY. On this sample the two sides cover
 *   the same four accounts and disagree on every one of them, by −$845,367.40 in
 *   total. `data/sql/turso/00-schema.sql` says why, at the definition of the
 *   view, and it is the design rather than a bug:
 *
 *     "This exists because the two WILL NOT AGREE, and the disagreement is a fact
 *      about the data rather than a bug: the extract in data/oracle/ is a partial
 *      slice, so it never contains every transaction behind the report. […]
 *      Keep BOTH numbers side by side. Where they differ is exactly where the
 *      slice is incomplete, and that is information rather than noise."
 *
 *   So both are returned on every account, `DELTA` is returned where both exist,
 *   and nothing is netted off against anything.
 *
 * ─── 2. THE PO SIDE'S ENCUMBRANCE IS THE ORDERED AMOUNT, AND THAT IS DISCLOSED ─
 *
 * On this sample `PO_DISTRIBUTIONS_ALL.ENCUMBERED_AMOUNT` equals `AMOUNT_ORDERED`
 * on **every** one of its 2,802 rows, and `ENCUMBERED_FLAG` is `'Y'` on all 2,802 —
 * so the flag excludes nothing and the encumbered figure carries no information
 * beyond the ordered one. The table's own provenance row says so: *"AMOUNT_ORDERED
 * is real; ENCUMBERED_AMOUNT mirrors it because the extract carries no separate
 * encumbered figure for full-output rows."*
 *
 * This is **measured here rather than assumed**: the `po` block reports the row
 * counts behind each claim, and `po.encumbranceMirrorsOrdered` is a derived flag
 * the screen switches its disclosure on. If a later extract ever carries a real
 * encumbered figure, the flag goes false on its own and the screen stops saying it.
 *
 * ─── 3. `AMOUNT_BILLED` IS ZERO, SO "COMMITTED MINUS BILLED" IS NOT COMPUTABLE ─
 *
 * A commitment is only interesting net of what has been billed against it.
 * `po.billedRows` is therefore returned beside `po.rows`: on this sample it is 0
 * of 2,802, which is the reason the screen cannot show a burn-down and says so
 * instead of showing a chart of zeroes.
 *
 * ─── 4. AN EMPTY GL CELL MEANS "NOT IN THE EXTRACT", NOT "NO ENCUMBRANCE" ────
 *
 * `GL_BALANCES` here holds the report's four accounts, transcribed, plus authored
 * filter traps — it is not a ledger. So 331 of the 335 accounts have no GL row,
 * and `GL_ENCUMBRANCE` is `null` on those 331 rather than `0`. **A zero would be a
 * claim; `null` is the absence of one.** `counts.glAccounts` is returned so the
 * screen can say how small the GL side is rather than leaving a reader to infer it
 * from a column of blanks.
 *
 * ─── 5. THE UNRESOLVED BUCKET IS SEPARATED, NOT ROLLED UP ────────────────────
 *
 * Seven combinations in the distribution table carry `SEGMENT4 = '000'`,
 * `SEGMENT5 = 'UNRESOLVED'` and a zero placeholder in every other segment but the
 * last: an order charged to an account that resolves to no project. They sum to
 * $11,511.12, which is the whole of the difference between the purchasing
 * distribution table ($430,580,538.04) and the line-level extract
 * ($430,569,026.92) — the extract resolves accounts through the level, so it
 * cannot carry a row whose level is UNRESOLVED. They are returned in their own
 * `unresolved` block and are **excluded from `levels`**, because a bucket called
 * `UNRESOLVED` sitting at the bottom of a 139-row level list is exactly the thing
 * a reader skips.
 *
 * ─── 6. NOT PAGINATED ────────────────────────────────────────────────────────
 *
 * Same justification as `GET /api/coa/levels`: the grain is one row per account
 * combination and 335 rows *is* the whole answer. Returning a page of it would let
 * the screen print a page as a population, and the two totals this endpoint exists
 * to compare are population figures. `limit` is deliberately absent rather than
 * defaulted, so no caller can believe they are reading all of it when they are not.
 */

/** Money from a SQL aggregate: rounded to cents, and never a silent NaN. */
function money(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

/** The same, but `null` survives — for anything that can genuinely be absent. */
function moneyOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** A count from a SQL aggregate. */
function count(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** One account combination, with both sides of the encumbrance on it. */
const encumbranceAccount = z
  .object({
    CODE_COMBINATION_ID: intReq('The surrogate account id. Not durable — use `ACCOUNT` to refer to this row.'),
    ACCOUNT: textReq(
      'The seven segments joined with dots — the durable key, identical to `V_CODE_COMBINATION_KEY.COMBINATION_KEY` ' +
        'and `V_ACCOUNT_POSITION.BUDGET_ACCOUNT` for the same account.',
    ),
    OBJECT_CODE: text('`SEGMENT4` — what the money was spent on. `000` on the unresolved combinations.'),
    LEVEL_CODE: text('`SEGMENT5` — the project. `UNRESOLVED` when the account does not resolve to one.'),
    PURPOSE_CODE: text('`SEGMENT2`.'),
    PROGRAM_CODE: text('`SEGMENT3`.'),
    FUND_CODE: text('`SEGMENT1`.'),
    PO_ENCUMBERED: realReq(
      '**From the PO extract:** `SUM(ENCUMBERED_AMOUNT)` over this account\'s flagged distributions. On this ' +
        'sample this is the ordered amount — see the `po` block, which measures that rather than asserting it.',
    ),
    PO_ORDERED: realReq('**From the PO extract:** `SUM(AMOUNT_ORDERED)` over the same distributions.'),
    PO_DISTRIBUTIONS: intReq('How many distribution rows carry the figure. `V_ENCUMBRANCE_FROM_PO.DISTRIBUTIONS`.'),
    PO_ORDERS: intReq('How many distinct purchase orders stand behind those distributions.'),
    PO_BILLED_ROWS: intReq(
      'Distributions with a non-zero `AMOUNT_BILLED`. Zero on every row of this sample, which is why no ' +
        'burn-down of a commitment is computable here.',
    ),
    GL_ENCUMBRANCE: real(
      '**From the report, via `V_ACCOUNT_POSITION`:** `GL_BALANCES` under `ACTUAL_FLAG = \'E\'`. **`null` means ' +
        'the account is not in the GL side at all** — which on this sample is 331 of 335, because that side is a ' +
        'four-account extract and not a ledger. `null` is not zero and must not be rendered as one.',
    ),
    GL_BUDGET: real('`V_ACCOUNT_POSITION.WCPSS_BUDGET`. Null on the same 331 rows, for the same reason.'),
    GL_ALLOCATIONS: real('`V_ACCOUNT_POSITION.ALLOCATIONS_REIMB`.'),
    GL_EXPENDITURES: real('`V_ACCOUNT_POSITION.EXPENDITURES`, from `ACTUAL_FLAG = \'A\'`.'),
    GL_AVAILABLE_FUNDS: real(
      '`V_ACCOUNT_POSITION.AVAILABLE_FUNDS` — **derived:** `ALLOCATIONS_REIMB − ENCUMBRANCES − EXPENDITURES`.',
    ),
    DELTA: real(
      '`GL_ENCUMBRANCE − PO_ENCUMBERED`, and only where **both** sides carry the account. Null where either is ' +
        'absent: a difference against a side that does not hold the account is not a difference.',
    ),
    IN_PO: z.boolean().openapi({ description: 'Whether the PO extract carries this account. True on all 335.' }),
    IN_GL: z.boolean().openapi({
      description: 'Whether the GL side carries this account. True on 4, and every one of those is also `IN_PO`.',
    }),
  })
  .openapi('EncumbranceAccount');

/** One project level, rolled up from the account rows. */
const levelRollup = z
  .object({
    LEVEL_CODE: textReq('`SEGMENT5`. The project.'),
    OBJECT_CODES: z.array(z.string()).openapi({
      description:
        'Every `SEGMENT4` object code used against this level, sorted. A level normally carries more than one: ' +
          'one project is charged for several kinds of thing.',
    }),
    ACCOUNTS: intReq('Account combinations at this level.'),
    PO_ENCUMBERED: realReq('The level\'s total from the PO extract.'),
    PO_ORDERS: intReq(
      'Purchase orders standing behind it, counted **distinctly at this level** — not the sum of the accounts\' own ' +
        'counts, which double-counts an order charged to two accounts under one project.',
    ),
    GL_ENCUMBRANCE: real(
      'The level\'s total from the GL side, or `null` when no account at this level is in it. On this sample only ' +
        'level `0450` is non-null.',
    ),
    HAS_BOTH: z.boolean().openapi({
      description: 'Whether any account at this level appears on both sides. Only true where a difference exists.',
    }),
  })
  .openapi('EncumbranceLevel');

export function registerSpend(api: Api): void {
  api.route({
    method: 'get',
    path: '/api/spend/encumbrances',
    operationId: 'spend_encumbrances',
    summary: 'Encumbrances from both sources — the purchase-order extract and the GL report — kept side by side',
    description:
      'Every account combination carrying an encumbrance, with the purchase-order figure and the general-ledger ' +
      'figure on the same row, and the difference between them where both exist.\n\n' +
      '**The two sides do not agree, and are not meant to.** `V_ENCUMBRANCE_FROM_PO` is a partial slice of the ' +
      'purchasing extract; `V_ACCOUNT_POSITION.ENCUMBRANCES` is the report\'s own column, summed from ' +
      '`GL_BALANCES` under `ACTUAL_FLAG = \'E\'`. The schema says to keep both, because *where they differ is ' +
      'exactly where the slice is incomplete*.\n\n' +
      '**The two sides also do not cover the same population.** Measured on this sample: 335 accounts on the PO ' +
      'side over $430,580,538.04, against 4 accounts on the GL side over $5,198,165.65. Comparing the totals is ' +
      'meaningless; comparing an account is not. `counts` and `totals` are returned so that is visible rather ' +
      'than inferred.\n\n' +
      '**On this sample the PO figure is the ordered amount.** `PO_DISTRIBUTIONS_ALL.ENCUMBERED_AMOUNT` equals ' +
      '`AMOUNT_ORDERED` on all 2,802 of its rows, and `ENCUMBERED_FLAG = \'Y\'` on all 2,802 as well, so the flag ' +
      'excludes nothing. The `po` block reports both counts, and `po.encumbranceMirrorsOrdered` is derived from ' +
      'them, so the disclosure follows the data rather than a hard-coded belief about it.\n\n' +
      '**An empty `GL_ENCUMBRANCE` means "not in the GL extract", not "no encumbrance"** — the GL side is four ' +
      'transcribed report accounts, so `null` is returned instead of a zero that would be a claim.\n\n' +
      'The seven combinations whose account resolves to nothing (`LEVEL_CODE = \'UNRESOLVED\'`, $11,511.12 ' +
      'between them) are separated into `unresolved` and **excluded from `levels`**, so a roll-up cannot bury ' +
      'them.\n\n' +
      'Not paginated: the grain is one row per account and 335 rows is the whole answer.',
    tags: ['Spend'],
    response: z
      .object({
        accounts: z.array(encumbranceAccount).openapi({
          description: 'One row per account combination, on either side. Union of both, so 335 here.',
        }),
        levels: z.array(levelRollup).openapi({
          description: 'The same rows rolled up to the project level. Excludes the unresolved bucket.',
        }),
        unresolved: z
          .object({
            ACCOUNTS: intReq('Combinations whose account resolves to no object and no level.'),
            AMOUNT: realReq('What they total on the PO side.'),
            ORDERS: intReq('Purchase orders behind them, counted distinctly.'),
            NOTE: textReq('What they are and why they are not in `levels`.'),
          })
          .openapi('EncumbranceUnresolved'),
        po: z
          .object({
            ROWS: intReq('Every row of `PO_DISTRIBUTIONS_ALL`.'),
            FLAGGED: intReq('Rows with `ENCUMBERED_FLAG = \'Y\'`. The view\'s own filter.'),
            UNFLAGGED: intReq('Rows the flag excludes. **Zero on this sample** — the filter is a no-op here.'),
            MIRRORED: intReq('Rows where `ENCUMBERED_AMOUNT = AMOUNT_ORDERED` exactly.'),
            AMOUNT_NULL: intReq('Rows with a null `ENCUMBERED_AMOUNT`.'),
            BILLED_ROWS: intReq('Rows with a non-zero `AMOUNT_BILLED`. Zero here, so nothing is netted off.'),
            ENCUMBRANCE_TOTAL: realReq('`SUM(ENCUMBERED_AMOUNT)` over every row.'),
            ORDERED_TOTAL: realReq('`SUM(AMOUNT_ORDERED)` over every row.'),
            BILLED_TOTAL: realReq('`SUM(AMOUNT_BILLED)` over every row.'),
            encumbranceMirrorsOrdered: z.boolean().openapi({
              description:
                'Derived: every row mirrors the ordered amount, none is null, and the two totals are equal. When ' +
                  'true the screen must disclose that its PO-side figure is the ordered amount, because that is ' +
                  'all the data supports.',
            }),
          })
          .openapi('EncumbrancePoSide'),
        totals: z
          .object({
            PO_ENCUMBERED: realReq('The PO side, all accounts.'),
            PO_ORDERED: realReq('The PO side, ordered. Equal to the above on this sample.'),
            GL_ENCUMBRANCE: realReq('The GL side, all accounts.'),
            OVERLAP_ACCOUNTS: intReq('Accounts on both sides. The only place a difference is meaningful.'),
            OVERLAP_PO: realReq('The PO figure restricted to those accounts.'),
            OVERLAP_GL: realReq('The GL figure over the same accounts.'),
            OVERLAP_DELTA: realReq(
              '`OVERLAP_GL − OVERLAP_PO`. **The only total-of-a-difference this endpoint offers**, because it is ' +
                'the only one taken over a shared population.',
            ),
          })
          .openapi('EncumbranceTotals'),
        counts: z
          .object({
            ACCOUNTS: intReq('Rows in `accounts`.'),
            IN_BOTH: intReq('On both sides.'),
            PO_ONLY: intReq('On the PO side only — **not** a zero encumbrance, an absent GL row.'),
            GL_ONLY: intReq('On the GL side only. Zero on this sample.'),
            LEVELS: intReq('Rows in `levels`, excluding the unresolved bucket.'),
            GL_ACCOUNTS: intReq(
              'How many accounts the GL side holds in total, so a reader can weigh a column of `null`s against it.',
            ),
          })
          .openapi('EncumbranceCounts'),
        notes: z
          .object({
            PO_SIDE: textReq('What the PO side is, and what it is not on this sample.'),
            GL_SIDE: textReq('What the GL side is, and why it is small.'),
            DISAGREEMENT: textReq('Why the two are kept apart rather than reconciled.'),
            UNRESOLVED: textReq('What the unresolved bucket is.'),
          })
          .openapi('EncumbranceNotes'),
      })
      .openapi('Encumbrances'),
    errors: [500],
    handler: async () => {
      // ── Both sides. The PO side reads the view the menu names as this
      //    screen's source, joined only to fetch the segments the view does not
      //    project; the GL side reads the same view the Budgets screen reads, so
      //    the two screens cannot disagree about an encumbrance figure.
      const poRows = await rows<Record<string, unknown>>(
        [
          `SELECT v.${quoteIdent('CODE_COMBINATION_ID')}  AS ccid,`,
          `       v.${quoteIdent('OBJECT_CODE')}          AS object_code,`,
          `       v.${quoteIdent('LEVEL_CODE')}           AS level_code,`,
          `       v.${quoteIdent('DISTRIBUTIONS')}        AS distributions,`,
          `       v.${quoteIdent('ENCUMBERED_FROM_PO')}   AS po_encumbered,`,
          `       v.${quoteIdent('ORDERED_FROM_PO')}      AS po_ordered,`,
          `       ${concatExpr(ACCOUNT_SEGMENT_COLUMNS.map((c) => `cc.${quoteIdent(c)}`), '.')} AS account,`,
          `       cc.${quoteIdent('SEGMENT1')}            AS fund_code,`,
          `       cc.${quoteIdent('SEGMENT2')}            AS purpose_code,`,
          `       cc.${quoteIdent('SEGMENT3')}            AS program_code`,
          `  FROM ${quoteIdent('V_ENCUMBRANCE_FROM_PO')} v`,
          `  JOIN ${quoteIdent('GL_CODE_COMBINATIONS')} cc`,
          `    ON cc.${quoteIdent('CODE_COMBINATION_ID')} = v.${quoteIdent('CODE_COMBINATION_ID')}`,
        ].join('\n'),
      );

      // All four rows, with no `ENCUMBRANCES <> 0` filter on purpose: an account
      // in the GL side with a zero encumbrance is a FOUND account, and filtering
      // it out would make it indistinguishable from one the extract lacks.
      const glRows = await rows<Record<string, unknown>>(
        [
          `SELECT ${quoteIdent('CODE_COMBINATION_ID')} AS ccid,`,
          `       ${quoteIdent('BUDGET_ACCOUNT')}       AS account,`,
          `       ${quoteIdent('WCPSS_BUDGET')}         AS gl_budget,`,
          `       ${quoteIdent('ALLOCATIONS_REIMB')}    AS gl_allocations,`,
          `       ${quoteIdent('ENCUMBRANCES')}         AS gl_encumbrance,`,
          `       ${quoteIdent('EXPENDITURES')}         AS gl_expenditures,`,
          `       ${quoteIdent('AVAILABLE_FUNDS')}      AS gl_available`,
          `  FROM ${quoteIdent('V_ACCOUNT_POSITION')}`,
        ].join('\n'),
      );

      const orderRows = await rows<Record<string, unknown>>(
        [
          `SELECT ${quoteIdent('CODE_COMBINATION_ID')} AS ccid,`,
          `       COUNT(DISTINCT ${quoteIdent('PO_HEADER_ID')}) AS orders,`,
          `       SUM(CASE WHEN IFNULL(${quoteIdent('AMOUNT_BILLED')}, 0) <> 0 THEN 1 ELSE 0 END) AS billed_rows`,
          `  FROM ${quoteIdent('PO_DISTRIBUTIONS_ALL')}`,
          ` WHERE ${quoteIdent('ENCUMBERED_FLAG')} = 'Y'`,
          ` GROUP BY ${quoteIdent('CODE_COMBINATION_ID')}`,
        ].join('\n'),
      );

      // Orders counted per LEVEL, not summed from the per-account counts above: an
      // order charged to two accounts under one project would otherwise be counted
      // twice, and the roll-up's whole job is to be the number you can trust over
      // the rows it replaces. Includes `UNRESOLVED`, so the bucket beside it is
      // counted the same way rather than a second time by a different rule.
      const ordersByLevelRows = await rows<Record<string, unknown>>(
        [
          `SELECT cc.${quoteIdent('SEGMENT5')}                AS level_code,`,
          `       COUNT(DISTINCT pd.${quoteIdent('PO_HEADER_ID')}) AS orders`,
          `  FROM ${quoteIdent('PO_DISTRIBUTIONS_ALL')} pd`,
          `  JOIN ${quoteIdent('GL_CODE_COMBINATIONS')} cc`,
          `    ON cc.${quoteIdent('CODE_COMBINATION_ID')} = pd.${quoteIdent('CODE_COMBINATION_ID')}`,
          ` WHERE pd.${quoteIdent('ENCUMBERED_FLAG')} = 'Y'`,
          ` GROUP BY cc.${quoteIdent('SEGMENT5')}`,
        ].join('\n'),
      );
      const ordersByLevel = new Map(ordersByLevelRows.map((r) => [String(r.level_code ?? ''), count(r.orders)]));

      // ── The measurement behind the disclosure. Counted, not assumed: if a
      //    later extract carries a real encumbered figure, `MIRRORED` drops and
      //    `encumbranceMirrorsOrdered` goes false without anyone editing a string.
      const poStats = await one<Record<string, unknown>>(
        [
          `SELECT COUNT(*)                                                            AS rows_all,`,
          `       SUM(CASE WHEN ${quoteIdent('ENCUMBERED_FLAG')} = 'Y' THEN 1 ELSE 0 END)  AS flagged,`,
          `       SUM(CASE WHEN ${quoteIdent('ENCUMBERED_FLAG')} = 'Y' THEN 0 ELSE 1 END)  AS unflagged,`,
          `       SUM(CASE WHEN ${quoteIdent('ENCUMBERED_AMOUNT')} = ${quoteIdent('AMOUNT_ORDERED')} THEN 1 ELSE 0 END) AS mirrored,`,
          `       SUM(CASE WHEN ${quoteIdent('ENCUMBERED_AMOUNT')} IS NULL THEN 1 ELSE 0 END) AS amount_null,`,
          `       SUM(CASE WHEN IFNULL(${quoteIdent('AMOUNT_BILLED')}, 0) <> 0 THEN 1 ELSE 0 END) AS billed_rows,`,
          `       SUM(IFNULL(${quoteIdent('ENCUMBERED_AMOUNT')}, 0))                    AS encumbrance_total,`,
          `       SUM(IFNULL(${quoteIdent('AMOUNT_ORDERED')}, 0))                       AS ordered_total,`,
          `       SUM(IFNULL(${quoteIdent('AMOUNT_BILLED')}, 0))                        AS billed_total`,
          `  FROM ${quoteIdent('PO_DISTRIBUTIONS_ALL')}`,
        ].join('\n'),
      );

      const ordersByCcid = new Map(orderRows.map((r) => [count(r.ccid), r]));
      const glByCcid = new Map(glRows.map((r) => [count(r.ccid), r]));

      // ── Assemble the union. Driven by the PO side, then the GL side's accounts
      //    that it does not already hold — so no account can be lost if the two
      //    ever stop overlapping, which is the state the schema warns about.
      const accounts: Array<Record<string, unknown>> = [];

      const build = (ccid: number, po: Record<string, unknown> | undefined, gl: Record<string, unknown> | undefined) => {
        const poEncumbered = po ? money(po.po_encumbered) : 0;
        const glEncumbrance = gl ? moneyOrNull(gl.gl_encumbrance) : null;
        const extra = ordersByCcid.get(ccid);
        const account = po ? String(po.account) : String(gl?.account ?? '');

        return {
          CODE_COMBINATION_ID: ccid,
          ACCOUNT: account,
          OBJECT_CODE: (po ? (po.object_code ?? null) : null) as string | null,
          LEVEL_CODE: (po ? (po.level_code ?? null) : null) as string | null,
          PURPOSE_CODE: (po ? (po.purpose_code ?? null) : null) as string | null,
          PROGRAM_CODE: (po ? (po.program_code ?? null) : null) as string | null,
          FUND_CODE: (po ? (po.fund_code ?? null) : null) as string | null,
          PO_ENCUMBERED: poEncumbered,
          PO_ORDERED: po ? money(po.po_ordered) : 0,
          PO_DISTRIBUTIONS: po ? count(po.distributions) : 0,
          PO_ORDERS: extra ? count(extra.orders) : 0,
          PO_BILLED_ROWS: extra ? count(extra.billed_rows) : 0,
          GL_ENCUMBRANCE: glEncumbrance,
          GL_BUDGET: gl ? moneyOrNull(gl.gl_budget) : null,
          GL_ALLOCATIONS: gl ? moneyOrNull(gl.gl_allocations) : null,
          GL_EXPENDITURES: gl ? moneyOrNull(gl.gl_expenditures) : null,
          GL_AVAILABLE_FUNDS: gl ? moneyOrNull(gl.gl_available) : null,
          // Only where both sides hold the account. `0 − null` is not a difference.
          DELTA: gl && po ? money(glEncumbrance! - poEncumbered) : null,
          IN_PO: Boolean(po),
          IN_GL: Boolean(gl),
        };
      };

      for (const po of poRows) accounts.push(build(count(po.ccid), po, glByCcid.get(count(po.ccid))));
      for (const gl of glRows) {
        const ccid = count(gl.ccid);
        if (!accounts.some((a) => a.CODE_COMBINATION_ID === ccid)) accounts.push(build(ccid, undefined, gl));
      }

      // ── The roll-up. The unresolved bucket is pulled out rather than grouped
      //    with the rest, so a level named `UNRESOLVED` cannot hide in a list.
      const UNRESOLVED = 'UNRESOLVED';
      const unresolvedRows = accounts.filter((a) => a.LEVEL_CODE === UNRESOLVED);

      const byLevel = new Map<string, Record<string, unknown>[]>();
      for (const a of accounts) {
        const level = a.LEVEL_CODE === null || a.LEVEL_CODE === UNRESOLVED ? null : String(a.LEVEL_CODE);
        if (level === null) continue;
        const bucket = byLevel.get(level);
        if (bucket) bucket.push(a);
        else byLevel.set(level, [a]);
      }

      const levels = [...byLevel.entries()]
        .map(([level, bucket]) => ({
          LEVEL_CODE: level,
          OBJECT_CODES: [...new Set(bucket.map((a) => String(a.OBJECT_CODE ?? '')))].sort(),
          ACCOUNTS: bucket.length,
          PO_ENCUMBERED: money(bucket.reduce((s, a) => s + Number(a.PO_ENCUMBERED ?? 0), 0)),
          PO_ORDERS: ordersByLevel.get(level) ?? 0,
          GL_ENCUMBRANCE: bucket.some((a) => a.GL_ENCUMBRANCE !== null)
            ? money(bucket.reduce((s, a) => s + Number(a.GL_ENCUMBRANCE ?? 0), 0))
            : null,
          HAS_BOTH: bucket.some((a) => a.IN_GL),
        }))
        // Largest commitment first: the level list is read to find where the money is.
        .sort((a, b) => b.PO_ENCUMBERED - a.PO_ENCUMBERED || a.LEVEL_CODE.localeCompare(b.LEVEL_CODE));

      // ── Totals. The overlap ones are the only ones taken over a shared
      //    population, so `OVERLAP_DELTA` is the only difference worth reporting.
      const overlap = accounts.filter((a) => a.IN_PO && a.IN_GL);
      const sum = (list: Array<Record<string, unknown>>, key: string) =>
        money(list.reduce((s, a) => s + Number(a[key] ?? 0), 0));

      const flagged = count(poStats?.flagged);
      const mirrored = count(poStats?.mirrored);
      const amountNull = count(poStats?.amount_null);
      const encumbranceTotal = money(poStats?.encumbrance_total);
      const orderedTotal = money(poStats?.ordered_total);
      const billedRows = count(poStats?.billed_rows);

      return {
        accounts,
        levels,
        unresolved: {
          ACCOUNTS: unresolvedRows.length,
          AMOUNT: sum(unresolvedRows, 'PO_ENCUMBERED'),
          ORDERS: ordersByLevel.get(UNRESOLVED) ?? 0,
          NOTE:
            'An order charged to an account that resolves to nothing: a zero placeholder in every segment but the ' +
            'last, and a level reading UNRESOLVED. The order is real and so is the money; the project the account ' +
            'was meant to name does not exist. These are held out of the level roll-up rather than grouped at the ' +
            'bottom of it.',
        },
        po: {
          ROWS: count(poStats?.rows_all),
          FLAGGED: flagged,
          UNFLAGGED: count(poStats?.unflagged),
          MIRRORED: mirrored,
          AMOUNT_NULL: amountNull,
          BILLED_ROWS: billedRows,
          ENCUMBRANCE_TOTAL: encumbranceTotal,
          ORDERED_TOTAL: orderedTotal,
          BILLED_TOTAL: money(poStats?.billed_total),
          encumbranceMirrorsOrdered:
            count(poStats?.rows_all) > 0 &&
            mirrored === count(poStats?.rows_all) &&
            amountNull === 0 &&
            encumbranceTotal === orderedTotal,
        },
        totals: {
          PO_ENCUMBERED: sum(accounts, 'PO_ENCUMBERED'),
          PO_ORDERED: sum(accounts, 'PO_ORDERED'),
          GL_ENCUMBRANCE: money(glRows.reduce((s, r) => s + money(r.gl_encumbrance), 0)),
          OVERLAP_ACCOUNTS: overlap.length,
          OVERLAP_PO: sum(overlap, 'PO_ENCUMBERED'),
          OVERLAP_GL: money(overlap.reduce((s, a) => s + Number(a.GL_ENCUMBRANCE ?? 0), 0)),
          OVERLAP_DELTA: money(
            overlap.reduce((s, a) => s + Number(a.GL_ENCUMBRANCE ?? 0), 0) -
              overlap.reduce((s, a) => s + Number(a.PO_ENCUMBERED ?? 0), 0),
          ),
        },
        counts: {
          ACCOUNTS: accounts.length,
          IN_BOTH: overlap.length,
          PO_ONLY: accounts.filter((a) => a.IN_PO && !a.IN_GL).length,
          GL_ONLY: accounts.filter((a) => !a.IN_PO && a.IN_GL).length,
          LEVELS: levels.length,
          GL_ACCOUNTS: glRows.length,
        },
        notes: {
          PO_SIDE:
            'From PO_DISTRIBUTIONS_ALL by way of V_ENCUMBRANCE_FROM_PO: every distribution carrying an ' +
            'encumbrance, grouped by the account it was charged to. It is the purchasing extract and nothing else — ' +
            'a slice, not the ledger.',
          GL_SIDE:
            'The report\u2019s own encumbrance column, from GL_BALANCES under ACTUAL_FLAG = \'E\'. It holds only the ' +
            'accounts the report publishes, which is why it is four rows against the purchasing side\u2019s hundreds. ' +
            'An account absent from it has no entry here — it does not have a zero.',
          DISAGREEMENT:
            'The two sides are kept apart deliberately. The purchasing extract is partial, so it cannot contain ' +
            'every transaction behind the report, and where the two differ is exactly where it is partial. Netting ' +
            'them would destroy the only thing the comparison can tell you.',
          UNRESOLVED:
            'Seven combinations in the purchasing table resolve to no object and no level, which is also why the ' +
            'line-level extract cannot carry them: it resolves accounts through the level. They are separated out ' +
            'because a roll-up cannot honestly place money under a project that does not exist.',
        },
      };
    },
  });

}
