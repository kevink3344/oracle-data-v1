/**
 * The **Oracle source** ledger's shape, as last measured — the corpus, not this
 * deployment.
 *
 * ── ★ THIS NO LONGER DRAWS THE SIGN-IN SCREEN, AND THAT IS WHY IT STILL EXISTS
 *
 * It used to. The sign-in block printed `34 tables · over 197 million records`
 * straight out of `LEDGER_SCALE` below, on the argument that the first screen of
 * the application is drawn before a session exists and must not wait on the
 * network. That argument is about *Oracle*, where the count the block would need —
 * `GET /api/meta/ledger-summary` — is measured at **51 s to 204 s**: 34 sequential
 * counts against a ledger whose `GL_BALANCES` holds 157,150,828 rows and
 * `GL_JE_LINES` another 33,155,055, plus the three composed views `db/derived.ts`
 * builds for this app, two of which cost ~13 s each.
 *
 * ★ THE SPREAD IS IN THE MEASUREMENTS, NOT IN THE SCOPE, SO QUOTE A RANGE — AND THE
 *   RANGE IS WIDE. Three consecutive takes of the same endpoint under the same
 *   `FUND_CODE=04` returned **67.5 s**, **95.5 s** and **204.3 s**; the wider scope
 *   returned **51 s**. A single figure here reads as a budget and would be wrong most
 *   of the time — badly wrong in the direction that matters, because a screen waiting
 *   on this can wait **over three minutes**, not half a minute.
 *
 *   ★ ONE CAVEAT ON THE 204.3 s TAKE, because it is worth more than the number. That
 *   run also logged `The underlying connection was closed: An unexpected error occurred
 *   on a receive` and its request then **succeeded** — the signature of a **stale pooled
 *   keep-alive connection** reused after the server closed an idle one, which .NET
 *   re-establishes and retries transparently. So 204.3 s is "one take took 204.3 s",
 *   possibly including that retry, and is **not** a clean per-request cost. Do not read
 *   the error as the endpoint failing: nothing failed. (The practical consequence for
 *   anyone re-taking this figure: make each request from a **fresh** connection — a new
 *   `Invoke-WebRequest` per sample with a gap as long as the query itself is what
 *   creates the staleness.)
 *
 * ★ AND THE ORDERING DEFEATS THE OBVIOUS EXPLANATION. The *narrower* scope was the
 *   slower set — 204.3 s for fund 04 against 51 s for funds 02/04 — so the fund list
 *   is not what moves this number. Nor is the count: `ledgerRecords=197019139` and
 *   `uncounted=0` were identical on every take. And **nor is a degraded source**: the
 *   same deployment's health probe, which is one trivial statement, answered in
 *   **0.25 s, 2.2 s and 2.9 s** on three consecutive pings. So the cost is in these 34
 *   count statements — two of them full scans of a 157,150,828-row and a 33,155,055-row
 *   table — and not in the link being down.
 *
 *   What is **not** established is why the takes got *slower* as they repeated
 *   (67.5 → 95.5 → 204.3). **Do not write a cause for that**: it is one observation of
 *   three samples of one endpoint, and the shapes it resembles (a filling buffer cache
 *   would make takes *faster*; a cold pool would cost the *first* take) both predict the
 *   opposite of what was seen. It is worth a handful more takes before anyone acts on it.
 *
 *   ★ And quote the *warm* pings, not the first. The probe taken immediately after a
 *   restart read **20.4 s** once, because the pool was cold; 20 s is therefore not the
 *   source's normal cost and must not be used to argue anything. (See the 204.3 s caveat
 *   above — the same warm-up reasoning is why a single take is not a figure.)
 *
 * ★ THE ~13 s QUOTED HERE BEFORE WAS ONE TABLE'S COUNT, AND IT UNDERSTATED THE
 *   ENDPOINT MORE THAN FIFTEEN TIMES OVER AT THE SLOW END (204.3 ÷ 13 ≈ 15.7). The
 *   number was ~21.8 s until the endpoint stopped skipping the two expensive composed
 *   views — which it skipped **because it could not resolve them**, so the speed and the
 *   wrong total were the same defect. The count is right now and the price is the
 *   difference. Cite the endpoint, not the table, when the claim is about what a screen
 *   would wait for.
 *
 * It quietly stopped applying the moment the registers were pointed at a **Turso**
 * ledger — the `DB_MODE=turso` configuration — which answers the same count in a
 * fraction of a second. In `DB_MODE=oracle`, the mode running today, the live count
 * returns the same `197,019,139` this record holds, so the reason to prefer the live
 * read here is not accuracy but the fact that it stays right when the mode changes.
 *
 * What made it more than stale is that it was wrong in the direction that matters.
 * A deployment reading a per-table-capped copy and a seeded store was printing
 * "over 197 million records" over about ten thousand rows — the source's figure,
 * in the position where a reader takes the number to be the one they are about to
 * open. The screen now reads `GET /api/meta/ledger-summary` instead; see
 * `data/ledgerSummary.ts`.
 *
 * ★ SO WHAT IS THIS FILE FOR NOW? IT IS THE ONE PLACE THAT ANSWERS *THE OTHER*
 *   QUESTION, AND IT GIVES THE FAILURE PATH SOMETHING TRUE TO SAY. When the live
 *   count cannot be taken, the screen still owes the reader a sense of scale — and
 *   the only scale it can quote without a query is the source's. That quote is
 *   only honest if it arrives with its database and its date attached, which is
 *   exactly what this record carries and what `SignIn.tsx` prints. A figure with
 *   its provenance is a fact about the Oracle ledger; the same figure without it
 *   was a false claim about Turso.
 *
 * ── ★ WHAT THE FIGURES ARE, EXACTLY, BECAUSE "RECORDS" IS DOING SOME WORK
 *
 * Measured against `POWERAPPS@europa.wcpss.net:1541/ebs_FA2DB` — the **live
 * ledger**, which is the point: the extract is a cache of it and is not what a
 * count should describe.
 *
 *   • **34** objects are described by the API's descriptors.
 *   • **32** of those are ledger objects and they hold the rows counted below. They
 *     include the three reporting views — `V_SEGMENT_LEGEND`, `V_ACCOUNT_POSITION`,
 *     `V_BUDGET_BY_ACCOUNT_PERIOD` — which are counted, not declined: they resolve
 *     through `db/derived.ts`, which composes SQL over the base tables rather than
 *     reading the view, so a count of them is a count of a real composition. A
 *     re-take on 2026-09-22 reported `not granted: 0 (none)` and `counted: 32 of 32`.
 *   • The remaining two are this app's own report tables
 *     (`X_REPORT_PROJECT_FACTS`, `X_REPORT_FUNDING_LINES`), which live in the app
 *     store and are deliberately **not** part of a ledger total.
 *
 * ── ★ THE FIGURE IS SCOPE-DEPENDENT, WHICH IS WHY `scope` IS A FIELD ON THE RECORD
 *
 * Two objects move when the account scope changes and thirty do not. The 29 base
 * tables are counted as `COUNT(*)` on the source object itself, so a narrower fund
 * leaves them untouched; the two *scoped* reporting views are counted through the
 * composed fragment, so they follow the scope. Measured by changing
 * `FUND_CODE=02,04` to `FUND_CODE=04` and re-taking:
 *
 *     V_ACCOUNT_POSITION              1,272  →  1,262
 *     V_BUDGET_BY_ACCOUNT_PERIOD     74,955  → 74,045
 *     V_SEGMENT_LEGEND                1,308  →  1,308   (deliberately unscoped)
 *     total                     197,020,059  → 197,019,139
 *
 * So a re-take under a different scope yields a different number **without
 * anything having changed in the ledger** — 920 rows here, every one of them
 * accounted for by the two views. A recorded figure with no scope beside it cannot
 * be told apart from growth, and the next person to re-take it would "correct" a
 * number that was never wrong. That is the whole reason this field exists; it is
 * not decoration, and it is printed on the sign-in screen with the figure.
 *
 * ── ★ THE TWO COUNT PATHS DISAGREED FOR A WHILE, AND THIS FILE WAS THE ONE THAT
 *    WAS RIGHT
 *
 * `npm run ledger:scale` resolved every object through `ledgerPlan()` and counted 32
 * of 32. `GET /api/meta/ledger-summary` — the endpoint the sign-in screen actually
 * reads — counted `FROM "<table>"` for each descriptor instead, so on Oracle the
 * three views above could not resolve, came back `null`, and were reported by the
 * screen as **"3 could not be counted and are left out of it"** against a total
 * 77,535 rows short. So the *ready* state understated the ledger while the *failed*
 * state quoted this file's figure, which had always included them: one card, two
 * answers to one question. The endpoint now resolves through `ledgerPlan()` too, and
 * both paths answer `197,020,059` / `uncounted: 0`. The lesson is worth keeping
 * beside these constants: **two callers over one ledger must share the resolution,
 * not just the table list** — a helper that takes bare names cannot route a composed
 * object, and it fails silently, as a smaller number.
 *
 * ★ THE PREVIOUS TAKE SAID `31 tables / 196,942,524`, on the strength of three
 *   views answering `503 DB_UNAVAILABLE`. That is no longer what a run reports, and
 *   the difference is not growth — it is the routing. Do not restore the old figure
 *   from memory: re-take it, and if `ledger:scale` ever prints a non-zero
 *   `not granted`, the bullet above is the one that has to change back.
 *
 *   ★ And the take before *this* one said `197,020,059`, under `FUND_CODE=02,04`.
 *     Both figures are correct measurements of two configurations; only the one
 *     whose scope matches the running deployment describes the running deployment.
 *     Re-takes are only comparable within a scope, which is what `scope` below is for.
 *
 * ── ★ HOW TO RE-TAKE IT, BECAUSE A STATED NUMBER NEEDS A SOURCE
 *
 *     Push-Location server; npm run ledger:scale; Pop-Location
 *
 * That script measures the same things this file states and prints the constants
 * ready to paste. If the ledger grows past a threshold worth moving, run it and
 * update the numbers — never edit the sentence to match a figure somebody
 * remembers. A number in user-facing copy with no way to re-derive it is an
 * assertion nobody can check.
 */

import { num } from './format';

/**
 * The live ledger's shape, as last measured.
 *
 * `records` is kept **exact** here rather than pre-rounded, and the copy floors it
 * at render time. The reason is that a floor computed from the precise figure
 * stays true as the ledger grows, while a rounded constant would have to be
 * re-taken to stay honest — and a rounded constant that says "197.0 million" when
 * the real number is 197,020,059 invites a reader to think it is made up.
 */
export interface LedgerScale {
  /** Objects the API can serve: the descriptors minus any the deployment declines. */
  readonly tables: number;
  /** Rows across the 32 ledger objects that could be counted. */
  readonly records: number;
  /** The day this was measured, so the claim carries its own date. */
  readonly measuredOn: string;
  /** What it was measured against, named so that a reader can check it. */
  readonly target: string;
  /**
   * The account scope the count was taken under — fund, programs, fiscal floor.
   *
   * ★ REQUIRED, NOT OPTIONAL, AND THE COMPILER ENFORCES THE REASON. Two of the 32
   *   objects are counted through the scope and thirty are not, so the figure is a
   *   function of the configuration as well as of the ledger. An optional field
   *   would let the next re-take omit it and leave a number nobody can interpret —
   *   which is the state this record was in until the scope changed to fund 04 and
   *   the total moved by 920 rows for no reason a reader could see.
   */
  readonly scope: string;
}

export const LEDGER_SCALE: LedgerScale = {
  tables: 34,
  records: 197_019_139,
  measuredOn: '2026-09-22',
  target: 'POWERAPPS@europa.wcpss.net:1541/ebs_FA2DB',
  scope: 'Fund 04 · Programs 861/862/863 · FY2021 onward',
};

/**
 * The record count as a **floor** in words — `over 197 million`.
 *
 * ★ A FLOOR, NOT A ROUNDING, AND THE DIFFERENCE MATTERS. `num()` would print the
 *   exact `197,019,139`; a reader takes an exact figure as a promise, and it stops
 *   being true the moment a row is inserted. "over 197 million" is true before the
 *   next row and after it — which is what makes it the right form for the one place
 *   this file is still quoted, the sign-in screen's failed-read path. That path
 *   cannot re-take the figure, so it must state one that does not go stale.
 *
 *   ★ IT SURVIVES A SCOPE CHANGE TOO, WHICH THE EXACT FIGURE WOULD NOT. Fund 04 alone
 *     reads 197,019,139 and funds 02/04 read 197,020,059 — both floor to the same
 *     "over 197 million", so the fallback sentence stays true across the change while
 *     the comment above it has to name which one it was taken under.
 */
export function recordsFloor(scale: LedgerScale = LEDGER_SCALE): string {
  return `over ${num(Math.floor(scale.records / 1_000_000))} million`;
}
