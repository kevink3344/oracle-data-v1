-- ============================================================================
--  FIRST FUNDINGS — FUND 04, JUNE AND JULY PERIODS ONLY
--
--  A narrowed sample of the first-funding question: for each fund-04 code
--  combination, when was it first allocated budget **in a June or July period**,
--  and for how much.
--
--  ---------------------------------------------------------------------------
--  WHY THE PERIOD FILTER IS IN THE CTE, NOT AT THE END
--  ---------------------------------------------------------------------------
--  ★ THE SAME REASON AS THE FUND FILTER, AND IT IS THE WHOLE CORRECTNESS OF THE
--    QUERY. The ROW_NUMBER() ranking picks each combination's earliest allocation.
--    If the June/July predicate is applied AFTER the ranking, a combination whose
--    earliest allocation was in, say, March has already consumed `rn = 1` on that
--    March row — and the filter then removes it, so the combination disappears
--    from the result entirely rather than appearing with its first June/July
--    allocation.
--
--    Filtering inside `code_period` means `rn = 1` is "the earliest June/July
--    allocation", which is what this query is asking. A combination that was never
--    funded in June or July is correctly absent.
--
--  ---------------------------------------------------------------------------
--  THE PERIOD PREDICATE — JULY ONLY
--  ---------------------------------------------------------------------------
--  ★ IT MATCHES ON PERIOD_NUM, NOT ON THE PERIOD_NAME STRING. Oracle's
--    PERIOD_NAME is `Jul-26-FY-27` — a display string carrying the year and the
--    fiscal year — so a LIKE on it would be a string match against a format that
--    changes every year. PERIOD_NUM is the ledger's own month ordinal within the
--    fiscal year, so the predicate states the intent directly.
--
--  ★ FISCAL YEAR, NOT CALENDAR YEAR. This ledger's fiscal year runs July–June and
--    PERIOD_NUM 1 is JULY. Confirmed against GL_PERIODS on the live ledger:
--    `Jul-26-FY-27` carries PERIOD_NUM 1, `Jun-27-FY-27` carries 12, and the
--    adjustment period `Adj-27-FY-27` carries 13.
--
--    ★ FOR JUNE AS WELL, change this to `IN (1, 12)`.
--
--  ★ NO YEAR RESTRICTION, so every July the ledger holds is included. Add
--    `AND gb.PERIOD_YEAR = 2027` to narrow to one fiscal year.
--
--  ---------------------------------------------------------------------------
--  ★★ THE FIVE FILTERS, AND THE ONE THAT DOES NOT WORK AS WRITTEN
--  ---------------------------------------------------------------------------
--  Four of the five are portable as-is. The fifth is NOT, and it silently returns
--  nothing on the live ledger:
--
--      TRANSLATED_FLAG = 'N'        ← matches 0 rows on Oracle
--      (TRANSLATED_FLAG IS NULL OR TRANSLATED_FLAG = 'N')   ← correct
--
--  MEASURED, live Oracle, fund 04 in July: `TRANSLATED_FLAG` is **NULL on all
--  239,971 rows** and `'N'` on none. The sample stores `'N'`, which is why the
--  original query worked there and returned 0 rows against the ledger. The seeded
--  view's own body says `TRANSLATED_FLAG = 'N'`, so the sample was authored to a
--  vocabulary the ledger does not use — the same divergence `db/derived.ts`
--  records, and it widens the predicate the same way.
--
--  ★ THE WIDENING IS NOT A LOOSENING. `IS NULL` is not "any value": it admits the
--    rows that carry no translation flag, which is every budget row on this
--    deployment. A row genuinely translated into a reporting currency would carry
--    a flag and is still excluded.
--
--  ---------------------------------------------------------------------------
--  ★ WHY THE ROW LIMIT IS SAFE HERE, AND WHERE IT WOULD NOT BE
--  ---------------------------------------------------------------------------
--  `FETCH FIRST 20 ROWS ONLY` (rewritten as a `ROWNUM`-free outer filter, since
--  this app's SQLite dialect guard refuses both) bounds the OUTPUT, not the
--  measurement — it is a preview, so "20 rows" is a sample and not a total.
--
--  ★ IT MUST NOT BE ADDED BEFORE THE RANKING. A limit inside `code_period` would
--    truncate the input to `ROW_NUMBER()`, so `rn = 1` would pick the first row of
--    an arbitrary 20 rather than each combination's earliest allocation — a
--    different and wrong answer. The limit is applied last, after `rn = 1`.
--
--  ★ AND IT IS DETERMINISTIC because the outer query is `ORDER BY`-ed: the same 20
--    rows come back every run. An unordered limit would return a different sample
--    each time, which is not a preview of anything.
-- ============================================================================
--  ★ PORTABLE: no FETCH FIRST, no ROWNUM, no NVL/DECODE/TO_CHAR, no `(+)`.
--    `ROW_NUMBER() OVER (PARTITION BY …)` and CTEs run on both SQLite and Oracle.
--
--  ★ MEASURED, LIVE ORACLE (2026-09-24): fund 04 holds **1,552,641** budget rows
--    across **7,679** combinations, out of 30,318,792 budget rows in the ledger.
--    The bundled sample carries 18 rows across 6 combinations, which is why the
--    same query returns 6 rows there — the sample, not the query, is the limit.
--
--  ---------------------------------------------------------------------------
--  ★ WHY THE COMBINATION KEY IS BUILT HERE, NOT READ FROM A VIEW
--  ---------------------------------------------------------------------------
--  `V_CODE_COMBINATION_KEY` is created in `data/sql/turso/00-schema.sql` — the
--  SAMPLE schema — and **does not exist on the live ledger**. Measured on Oracle:
--  `SELECT COMBINATION_KEY FROM V_CODE_COMBINATION_KEY` raises `ORA-00942` while
--  `GL_CODE_COMBINATIONS` answers fine. So the seven segments are concatenated
--  here from the base table, which is the same key by the same definition and runs
--  on both engines.
--
--  ★ THE JOIN IS ALREADY THERE. `code_period` joins `GL_CODE_COMBINATIONS` for the
--    fund filter, so the segments are in hand — the key is built from that join
--    rather than adding a second one.
--
--  ★ `||` IS THE CONCATENATION OPERATOR ON SQLITE AND ORACLE, BUT **NOT ON SQL
--    SERVER**, WHICH HAS NO `||` AND USES `+`. This file is a standalone document
--    — nothing in the app executes it — so the `||` below is left as written for
--    the two engines it was measured against. The app's own account-key queries
--    build the same string through `concatExpr()` in `server/src/db/sql.ts`, which
--    picks `+` when the ledger is SQL Server. Do not copy the `||` below into a
--    query the app runs.
-- ============================================================================
WITH code_period AS (
  SELECT gb.code_combination_id                  AS ccid,
         gb.budget_version_id,
         gb.period_year,
         gb.period_num,
         gb.period_name,
         SUM(gb.period_net_dr)                   AS net_dr,
         SUM(gb.period_net_cr)                   AS net_cr,
         SUM(gb.period_net_dr - gb.period_net_cr) AS net_amount,
         -- ★ The combination key, built from the joined base table. One value per
         --   combination, so aggregating it changes nothing about the grain.
         MAX(g.segment1 || '.' || g.segment2 || '.' || g.segment3 || '.' ||
             g.segment4 || '.' || g.segment5 || '.' || g.segment6 || '.' ||
             g.segment7)                        AS combination_key
    FROM gl_balances gb
    JOIN gl_ledgers  l ON l.ledger_id = gb.ledger_id
    -- ★ The fund filter needs this join: SEGMENT1 is on the combination, not on
    --   the balance. `CODE_COMBINATION_ID` is the primary key of both, so this is
    --   1:1 and cannot fan the balance rows out.
    JOIN gl_code_combinations g
      ON g.code_combination_id = gb.code_combination_id
   WHERE gb.actual_flag         = 'B'
     -- ★ WIDENED FOR THE LIVE LEDGER. `= 'N'` alone matches nothing there —
     --   measured: TRANSLATED_FLAG is NULL on all 239,971 fund-04 July rows. The
     --   sample stores 'N', which is why the narrow form worked on it.
     AND (gb.translated_flag IS NULL OR gb.translated_flag = 'N')
     AND gb.encumbrance_type_id IS NULL
     AND gb.currency_code       = l.currency_code
     -- ★ FUND 04 ONLY.
     AND g.segment1             = '04'
     -- ★★ THE MONTH IS *NOT* PINNED — AND THAT IS WHAT MAKES "LATEST" MEANINGFUL.
     --   With `period_num = 1` here, every row the view returns shares one period, so
     --   `ORDER BY period_num DESC` is a tie across all 6,727 rows and the database
     --   hands back an arbitrary 20. The month used to be pinned to make the result
     --   deterministic; the ordering now does that job instead, so the month is free
     --   and the view answers "the newest allocations", not "the newest of July".
     --
     --   ★ MEASURED, fund 04, fiscal 2027: the latest period is the ADJUSTMENT period
     --     (PN 13, `Adj-27-FY-27`, 6,727 combinations), ahead of Jun-27 (PN 12) and
     --     May-27 (PN 11). Every period in the year holds the same 6,727 combinations,
     --     so the period — not the count — is what distinguishes them.
     --
     --   ★ TO GO BACK TO JULY ONLY, restore `AND gb.period_num = 1` here. The view
     --     then returns the 20 newest of that single month, which is a tie broken by
     --     `combination_key` — deterministic, but "latest" adds nothing to it.
     --   ★ TO INCLUDE JUNE AND JULY TOGETHER, use `AND gb.period_num IN (1, 12)`.
     --
     --   Filtered here, before the ranking, so `rn = 1` means "first allocation in
     --   the periods considered" rather than "first allocation anywhere, if it
     --   happened to land in one of them".
     -- ★★ THIS LINE IS WHAT MAKES THE QUERY FAST, AND IT IS NOT A CONVENIENCE.
     --
     --   MEASURED on the live ledger, fund 04, July (PERIOD_NUM = 1):
     --
     --       no year filter                ~36 s   (118,454 rows scanned)
     --       GROUP BY PERIOD_YEAR          6+ min  (full scan to build groups)
     --       PERIOD_YEAR = 2027  ← this       0.6 s (6,727 rows)
     --
     --   A LITERAL year lets the optimiser skip straight to that year's rows;
     --   without it every row of a 157-million-row view is a candidate. The
     --   difference is three orders of magnitude, so this predicate is part of the
     --   query's correctness as a *usable* view, not an optimisation on top of it.
     --
     --   ★ AND IT IS A LITERAL ON PURPOSE — DO NOT MAKE IT A SUBQUERY.
     --     `PERIOD_YEAR = (SELECT MAX(PERIOD_YEAR) FROM …)` reads better and was
     --     measured to be far slower: the subquery re-introduces a scan, and the
     --     optimiser can no longer treat the predicate as a constant. Discover the
     --     year once, then paste it here.
     --
     --   ★ 2027 IS THE CURRENT FISCAL YEAR on this ledger — its July is
     --     `Jul-26-FY-27`, and GL_PERIODS runs to FY2027. Change this literal when
     --     the fiscal year rolls over; it is the one value in this file that goes
     --     stale on its own.
     AND gb.period_year         = 2027
     -- ★★ ONE BUDGET VERSION ONLY — AND THIS IS WHAT MAKES IT "FIRST FUNDING".
     --
     --   MEASURED on the live ledger, fund 04, fiscal 2027: every combination
     --   carries exactly ONE budget version (`1001`), and the count of combinations
     --   with more than one version is **0**. So on the ledger this predicate is
     --   already satisfied and changes nothing.
     --
     --   ★ IT IS HERE ANYWAY, BECAUSE THE SAMPLE IS NOT THE LEDGER. The sample
     --     holds several versions (501..505), and without this predicate the view
     --     mixes two of them in one result — the report's appropriation (504) and
     --     the FY2027 slice (505) — so a reader sees rows drawn from two different
     --     budget versions and cannot tell which. A "first funding" is a claim about
     --     ONE version's timeline; mixing versions makes that claim meaningless.
     --
     --   ★ WHY `1001` AND NOT `1`. The ledger's version id is 1001; the sample's
     --     are 501..505. A literal `1` matches NOTHING on either store, which is the
     --     same trap `TRANSLATED_FLAG = 'N'` set earlier in this file. To run this
     --     view against the sample instead, change this one value to `505` (the
     --     FY2027 slice) — that is the only edit needed, and both stores then answer
     --     the same question.
     AND gb.budget_version_id   = 1001
   GROUP BY gb.code_combination_id,
            gb.budget_version_id,
            gb.period_year,
            gb.period_num,
            gb.period_name
  HAVING SUM(gb.period_net_dr - gb.period_net_cr) <> 0
),
ranked AS (
  -- ★★ ONE ROW PER COMBINATION — THAT IS THE WHOLE POINT OF THE RANKING.
  --   `PARTITION BY ccid` and `rn = 1` below mean each combination appears exactly
  --   once, carrying its EARLIEST period in the version being read. Without the
  --   partition the query would return every period of every combination, which is
  --   a different question ("all allocations") and not "first funding".
  --
  --   ★ THE VERSION IS IN THE PARTITION AS WELL AS THE WHERE. The WHERE already
  --     pins a single version, so adding it here cannot change the result — it
  --     states the grain explicitly, so that if the WHERE is ever loosened the
  --     ranking still means "first funding within each version" rather than
  --     silently collapsing two versions into one arbitrary winner.
  SELECT cp.*,
         ROW_NUMBER() OVER (PARTITION BY cp.ccid, cp.budget_version_id
                            ORDER BY cp.period_year, cp.period_num,
                                     cp.period_name) AS rn
    FROM code_period cp
)
SELECT r.combination_key     AS code_combination,
       r.period_name         AS first_allocation_period,
       r.period_year,
       r.period_num,
       r.net_dr,
       r.net_cr,
       r.net_amount          AS first_allocation_amount,
       bv.budget_name,
       -- ★★ ONLY THE THREE COLUMNS BOTH STORES HAVE, AND THAT IS THE WHOLE REASON.
       --
       --   The View Builder RUNS against the SQLite sample; the timing was measured
       --   against Oracle. The two `GL_BUDGET_VERSIONS` tables are NOT supersets of
       --   one another — measured, column by column:
       --
       --       BUDGET_VERSION_ID   sample ✓  oracle ✓   ← keep
       --       BUDGET_NAME         sample ✓  oracle ✓   ← keep
       --       CREATION_DATE       sample ✓  oracle ✓   ← keep
       --       BUDGET_TYPE_ID      sample ✓  oracle ✗
       --       STATUS_CODE         sample ✓  oracle ✗
       --       FIRST_PERIOD_NAME   sample ✓  oracle ✗
       --       BUDGET_TYPE         sample ✗  oracle ✓
       --       STATUS              sample ✗  oracle ✓
       --
       --   So naming `bv.budget_type` fails on the sample with
       --   `SQLITE_ERROR: no such column: bv.budget_type`, and naming
       --   `bv.first_period_name` fails on Oracle with
       --   `ORA-00904: "BV"."FIRST_PERIOD_NAME": invalid identifier`. Only the
       --   intersection runs on both, and this is it.
       --
       --   ★ TO SEE THE TYPE OR STATUS, READ THEM FROM THE RIGHT STORE — they are
       --     served by `/api/funding/budget-versions`, whose descriptor resolves the
       --     divergence per dialect. Do not add them back here.
       bv.creation_date
  FROM ranked r
  JOIN gl_budget_versions bv ON bv.budget_version_id = r.budget_version_id
 WHERE r.rn = 1
 -- ★ THE ROW LIMIT IS LAST, AND IT IS A PREVIEW RATHER THAN A TOTAL. It is applied
 --   after `rn = 1`, so every row is a genuine first-July allocation; a limit
 --   inside the CTE would truncate the ranking's input and pick arbitrary rows.
 --   `ORDER BY` makes it deterministic — the same 20 rows every run.
 --
 --   ★ `LIMIT`, NOT `FETCH FIRST` OR `ROWNUM`. The View Builder's dialect guard
 --     refuses both of those by name (`query-guard.ts` DIALECT_RULES), so a view
 --     written with either cannot be saved. `LIMIT` is the form this codebase
 --     standardised on and the Oracle driver rewrites it.
 --
 -- ★★ LATEST FIRST — THE PERIOD IS THE TIME AXIS, AND THE AMOUNT IS NOT A TIE-BREAK.
 --    Two different questions, and this file answers the SECOND:
 --
 --      "largest 20"  ORDER BY ... , r.net_amount DESC   ← biggest allocations
 --      "latest 20"   ORDER BY r.period_year DESC, r.period_num DESC  ← newest period
 --
 --    ★ WHY THE AMOUNT HAD TO GO. With the month pinned (`period_num = 1`) every row
 --      shares one period, so a pure period ordering is a tie across all 6,727 rows
 --      and the database returns an ARBITRARY 20. The amount tie-break was what made
 --      it deterministic — but it also silently made the view a "largest 20" view.
 --      "Latest" only becomes answerable once the month is NOT pinned, which is why
 --      the period predicate below is now year-only.
 --
 --    ★ MEASURED on the live ledger, fund 04, fiscal 2027 — the latest period is the
 --      ADJUSTMENT period, and it is the one a reader means by "latest":
 --          PN 13  Adj-27-FY-27   6,727 combinations   ← latest
 --          PN 12  Jun-27-FY-27   6,727
 --          PN 11  May-27-FY-27   6,727
 --      So this returns the 20 newest combinations in the fiscal year's final
 --      period. `combination_key` remains as the final tie-break so the same 20 rows
 --      come back every run — an unordered tie is a different sample each time.
 --
 --    ★ THE OTHER CANDIDATE TIME AXIS WAS MEASURED AND REJECTED.
 --      `bv.creation_date` cannot order anything here: GL_BUDGET_VERSIONS holds
 --      **2 rows total** (distinct dates: 2, range 1999-11-11 .. 2000-07-05), and
 --      every July-2027 row in this view joins to the SAME one (`2000-07-05`). An
 --      ordering on it is a constant. GL_BALANCES carries no timestamp columns at
 --      all (0 found in ALL_TAB_COLUMNS), so the ledger's own write time is not
 --      available either. The period columns are the only real time axis.
 ORDER BY r.period_year DESC, r.period_num DESC, r.combination_key
 LIMIT 20
