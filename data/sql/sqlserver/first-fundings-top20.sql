-- ============================================================================
--  FIRST FUNDINGS — TOP 20 BY DATE, ONE ROW PER FUND CODE
--  Target: SQL Server (Azure SQL, database `wcpss-oracle-sync`)
--
--  For each fund-04 code combination, when was it FIRST allocated budget, and
--  for how much. The 20 newest such first-allocations are returned, newest first,
--  and every row carries a DIFFERENT fund code.
--
--  MEASURED: 20 rows in ~790 ms against the live instance.
--
--  ---------------------------------------------------------------------------
--  ★★ WHAT "FUND CODE" MEANS HERE — THE ONE DECISION THIS FILE IS BUILT ON
--  ---------------------------------------------------------------------------
--  "Each fund code should be unique and not repeated" cannot be satisfied by
--  SEGMENT1, and the reason is a measurement rather than a preference:
--
--      SELECT segment1, COUNT(*) FROM GL_CODE_COMBINATIONS GROUP BY segment1
--        → '04' 16,141   '02' 8,276   '01' 2,819   '06' 1,983   …
--
--  SEGMENT1 is the FUND, and there are only 14 distinct values in the whole
--  chart of accounts. A list of 20 rows deduplicated on SEGMENT1 is therefore
--  IMPOSSIBLE — the third row would have to repeat a fund. So the "fund code"
--  this query deduplicates on is the FULL CODE COMBINATION, which is the
--  `COMBINATION_KEY` already in the data: `04.6570.862.526.0513.0840.000`.
--  That is the only per-row identity that exists, and it is what the View
--  Builder's `first-fundings` view has always used as its row grain.
--
--  ★ IF YOU MEANT SEGMENT1, the answer is not a TOP 20 — it is 14 rows, one per
--    fund, and the query is a GROUP BY rather than a ranking. Say so and it is a
--    two-line change; do not read this file as having guessed.
--
--  ---------------------------------------------------------------------------
--  ★★ THE FILTER THAT RETURNS NOTHING, AND WHY THE SAVED VIEW IS EMPTY
--  ---------------------------------------------------------------------------
--  The saved view in `saved_view` (id 8, `first-fundings`) filters
--
--      AND gb.translated_flag = 'N'
--
--  MEASURED on this SQL Server instance:
--
--      SELECT translated_flag, COUNT(*) FROM GL_BALANCES GROUP BY translated_flag
--        → NULL  1,448,776        ← every row
--
--  `'N'` matches ZERO rows, so the view returns no data. It is not a rendering
--  fault and not a routing fault: the predicate is simply false everywhere.
--  The same divergence was measured on the live Oracle ledger, where
--  TRANSLATED_FLAG is NULL on every fund-04 row — the sample store wrote `'N'`,
--  which is the only place the narrow form ever worked.
--
--  ★ THE FIX IS TO ADMIT THE NULLS, NOT TO DELETE THE FILTER.
--      (gb.translated_flag IS NULL OR gb.translated_flag = 'N')
--    `IS NULL` is not "any value": it admits rows carrying no translation flag,
--    which is every budget row on this deployment. A row genuinely translated
--    into a reporting currency carries a flag and is still excluded.
--
--  ---------------------------------------------------------------------------
--  ★★ THERE IS NO `period_year` FILTER, AND ADDING ONE BACK WOULD BE WRONG
--  ---------------------------------------------------------------------------
--  This is the least obvious decision in the file and the one that took a
--  measurement to settle.
--
--  An earlier revision pinned `gb.period_year = 2027`, justified by a real
--  timing: without a year predicate the scan is far wider. That justification is
--  sound as *performance* and wrong as *semantics*, and the two are easy to
--  conflate because the predicate looks like a filter rather than a definition.
--
--  MEASURED — the full period history of one fund-04 combination,
--  `04.3400.120.000.0000.0000.000`, spans SIX fiscal years:
--
--      Jul-21-FY-22 … Jul-26-FY-27, with PERIOD_NUM 1 present in every one
--
--  and across the whole fund-04 population:
--
--      6,727 combinations in FY2027
--      6,217 of them have NO non-zero period inside FY2027 at all
--      1,125 of them differ between "first period of the year" and
--            "first non-zero period of the year"
--
--  So `period_year = 2027` does not merely narrow the scan — it REDEFINES the
--  question from "when was this combination first funded" to "when was it first
--  funded *within FY2027*", and for 92% of the population the second question has
--  no answer. The 20 rows it produced were mostly combinations whose FY2027
--  periods are all zero, ranked on a period that carries no money.
--
--  ★ AND DROPPING IT IS FASTER, NOT SLOWER — the opposite of the intuition the
--    earlier comment recorded. MEASURED, fund 04, version 1001:
--
--        with `period_year = 2027`    1,138 ms   (and 6,217 of 6,727 rows ranked
--                                                 on a zero period)
--        without it                    786 ms   (and every row a real allocation)
--
--    The year predicate was not buying speed here; it was buying a smaller
--    answer set at the cost of a wrong one. The `HAVING` below is what bounds the
--    ranking, and it bounds it honestly.
--
--  ---------------------------------------------------------------------------
--  ★★ THE HAVING CLAUSE IS WHAT MAKES `rn = 1` MEAN "FIRST FUNDED"
--  ---------------------------------------------------------------------------
--  `HAVING SUM(period_net_dr - period_net_cr) <> 0` keeps only periods that
--  actually moved money. That is the definition of an allocation, and it is what
--  makes the ranking pick a funded period rather than the combination's merely
--  earliest appearance in the ledger.
--
--  ★ IT MUST BE INSIDE THE CTE, BEFORE THE RANKING. Applying it afterwards would
--    let a zero period consume `rn = 1` and then be filtered out, so a
--    combination would vanish from the result rather than appear with its first
--    real allocation — the same ordering trap the period predicate would have set.
--
--  ---------------------------------------------------------------------------
--  ★★ THE COLUMN NAMES THAT DIFFER FROM ORACLE — CHECKED, NOT ASSUMED
--  ---------------------------------------------------------------------------
--  This instance's `GL_BUDGET_VERSIONS` has SEVEN columns:
--
--      BUDGET_VERSION_ID, BUDGET_TYPE, BUDGET_NAME, VERSION_NUM,
--      STATUS, DESCRIPTION, DATE_OPENED
--
--  The saved view selects `bv.budget_type_id` and `bv.first_period_name`, and
--  NEITHER EXISTS HERE — it would fail with `Invalid column name`. The Oracle
--  copy carries those two and lacks `BUDGET_TYPE`/`STATUS`; the two tables are
--  not supersets of one another, which is the same divergence this repo has
--  already recorded for the sample store. This file names only columns that
--  exist on THIS instance, verified against INFORMATION_SCHEMA.
--
--  ---------------------------------------------------------------------------
--  ★★ WHY THE ROW LIMIT IS LAST
--  ---------------------------------------------------------------------------
--  The limit must be applied AFTER the ranking. A `TOP` inside `code_period`
--  would truncate the input to `ROW_NUMBER()`, so `rn = 1` would pick the first
--  row of an arbitrary 20 rather than each combination's earliest allocation —
--  a different and wrong answer.
--
--  ★ AND IT IS DETERMINISTIC because the outer query is `ORDER BY`-ed on the
--    period and then the combination key. An unordered `TOP 20` returns a
--    different sample each run, which is a preview of nothing.
--
--  ★ `OFFSET 0 ROWS FETCH NEXT 20 ROWS ONLY` RATHER THAN `TOP 20`, because the
--    statement already has an `ORDER BY` and the two spell the same thing here —
--    `FETCH` keeps the ordering clause and the limit visibly together, so the
--    "the limit is last" property is readable rather than implied.
-- ============================================================================

WITH code_period AS (
  -- --------------------------------------------------------------------------
  --  ONE ROW PER (COMBINATION, PERIOD) — the grain the ranking needs.
  --  The `HAVING` below is what restricts this to periods that moved money.
  -- --------------------------------------------------------------------------
  SELECT gb.code_combination_id                    AS ccid,
         gb.budget_version_id,
         gb.period_year,
         gb.period_num,
         gb.period_name,
         SUM(gb.period_net_dr)                     AS net_dr,
         SUM(gb.period_net_cr)                     AS net_cr,
         SUM(gb.period_net_dr - gb.period_net_cr)  AS net_amount
    FROM dbo.GL_BALANCES gb
    JOIN dbo.GL_LEDGERS  l ON l.ledger_id = gb.ledger_id
    -- The fund filter needs this join: SEGMENT1 lives on the combination, not on
    -- the balance. CODE_COMBINATION_ID is the primary key of both, so this is 1:1
    -- and cannot fan the balance rows out.
    JOIN dbo.GL_CODE_COMBINATIONS g ON g.code_combination_id = gb.code_combination_id
   WHERE gb.actual_flag            = 'B'
     -- ★★ WIDENED. `= 'N'` alone matches nothing here — measured, the flag is NULL
     --    on all 1,448,776 rows. This single predicate is why the saved view is
     --    empty, and it is the first thing to check if it ever goes empty again.
     AND (gb.translated_flag IS NULL OR gb.translated_flag = 'N')
     AND gb.encumbrance_type_id IS NULL
     AND gb.currency_code       = l.currency_code
     -- ★ FUND 04 ONLY.
     AND g.segment1             = '04'
     -- ★★ THE APPLICATION'S SCOPE: PROGRAM 861 / 862 / 863.
     --
     --    ★ THE PROGRAM IS SEGMENT3, NOT SEGMENT2 — AND THAT IS A MEASUREMENT,
     --      NOT A READING OF THE BANNER. The scope banner says "program 861, 862
     --      or 863", and the obvious mapping is SEGMENT2. Measured on this
     --      instance, searching every segment for those values:
     --
     --          segment1 → 0      segment2 → 0      segment3 → 2,228  ← the program
     --          segment4 → 0      segment5 → 0      segment6 → 0      segment7 → 0
     --
     --      SEGMENT2 is the DEPARTMENT (`6570`, `9100`, `6550`, `5810` …) and holds
     --      no 861/862/863 at all. Filtering it would have returned ZERO rows while
     --      looking like a correct, narrow scope.
     --
     --    ★ WHAT THIS REMOVES. Without it, fund-04 combinations whose program is
     --      `801`, `854`, `000`, `640` … appear — real rows, real money, and
     --      outside the scope the rest of the application declares. Measured:
     --      2,228 of 16,141 fund-04 combinations are in scope.
     AND g.segment3             IN ('861', '862', '863')
     -- ★★ ONE BUDGET VERSION, AND THIS IS WHAT MAKES IT "FIRST FUNDING".
     --    A "first funding" is a claim about ONE version's timeline. This
     --    instance holds exactly two versions (1000 'WCPSS', 1001 'WCPSS
     --    BUDGET'), and mixing them would put rows from two timelines in one
     --    result with no way for a reader to tell which.
     --
     --    ★ THE LEDGER'S VERSION ID IS 1001. A literal `1` matches nothing on
     --      either store — the same trap `translated_flag = 'N'` sets above.
     AND gb.budget_version_id   = 1001
     -- ★★ NO `period_year` PREDICATE — DELIBERATE. See the header block: pinning
     --    the year redefines "first funding" as "first funding of that year", and
     --    6,217 of 6,727 fund-04 combinations have no funded period in FY2027.
     --    The ranking below spans every year the ledger holds, which is what
     --    "first" means.
   GROUP BY gb.code_combination_id,
            gb.budget_version_id,
            gb.period_year,
            gb.period_num,
            gb.period_name
  -- ★★ A PERIOD THAT MOVED NO MONEY IS NOT AN ALLOCATION. This is the predicate
  --    that makes `rn = 1` mean "first funded" rather than "first seen".
  HAVING SUM(gb.period_net_dr - gb.period_net_cr) <> 0
),
ranked AS (
  -- --------------------------------------------------------------------------
  --  ★★ ONE ROW PER COMBINATION — THE WHOLE POINT OF THE RANKING.
  --  `PARTITION BY ccid` with `rn = 1` below means each combination appears
  --  exactly once, carrying its EARLIEST FUNDED period in the version being read.
  --  Without the partition the query returns every period of every combination,
  --  which is a different question ("all allocations") and not "first funding".
  --
  --  ★ THE VERSION IS IN THE PARTITION AS WELL AS THE WHERE. The WHERE already
  --    pins one version, so adding it here cannot change the result — it states
  --    the grain explicitly, so that if the WHERE is ever loosened the ranking
  --    still means "first funding within each version" rather than silently
  --    collapsing two versions into one arbitrary winner.
  -- --------------------------------------------------------------------------
  SELECT cp.*,
         ROW_NUMBER() OVER (PARTITION BY cp.ccid, cp.budget_version_id
                            ORDER BY cp.period_year, cp.period_num, cp.period_name) AS rn
    FROM code_period cp
)
SELECT k.combination_key     AS fund_code,
       r.period_name         AS first_allocation_period,
       r.period_year,
       r.period_num,
       r.net_dr,
       r.net_cr,
       r.net_amount          AS first_allocation_amount,
       bv.budget_name,
       bv.budget_type,
       bv.status             AS version_status,
       bv.date_opened        AS version_opened
  FROM ranked r
  JOIN dbo.GL_BUDGET_VERSIONS     bv ON bv.budget_version_id = r.budget_version_id
  -- ★ THE KEY IS READ FROM THE VIEW, NOT REBUILT WITH `||`. T-SQL has no `||`
  --   (it uses `+`, which is also numeric addition), and `V_CODE_COMBINATION_KEY`
  --   already exists on this instance with the key materialised — verified,
  --   34,894 rows. Reading it is both correct and cheaper than concatenating
  --   seven segments in the select list.
  JOIN dbo.V_CODE_COMBINATION_KEY k  ON k.code_combination_id = r.ccid
 WHERE r.rn = 1
 -- ★★ NEWEST FIRST, AND THE PERIOD IS THE TIME AXIS.
 --    MEASURED, the first-funding years the fund-04 population spans, newest
 --    first — 24 combinations are first funded in the newest period:
 --        FY2027  Jul-26-FY-27   24 combinations   ← the 20 rows come from here
 --        FY2026  Nov-25-FY-26   84
 --        FY2026  Sept-25-FY-26  29
 --        FY2025  Feb-25-FY-25  132
 --
 --    ★ THE AMOUNT IS NOT THE TIME AXIS. `ORDER BY net_amount DESC` would answer
 --      a different question — "the largest 20 allocations" — and it is the
 --      order an earlier revision used when the month was pinned and the period
 --      ordering was a tie. With the period free, the period orders honestly.
 --
 --    ★ `combination_key` IS THE FINAL TIE-BREAK so the same 20 rows come back
 --      every run. An unordered tie is a different sample each time.
 --
 --    ★ `DATE_OPENED` WAS MEASURED AND REJECTED AS A TIME AXIS.
 --      GL_BUDGET_VERSIONS holds 2 rows total (1999-11-11 and 2000-07-05), and
 --      every row here joins to the SAME one — an ordering on it is a constant.
 --      GL_BALANCES carries no timestamp column at all. The period columns are
 --      the only real time axis in this data.
 ORDER BY r.period_year DESC, r.period_num DESC, k.combination_key
 -- ★ THE LIMIT IS LAST, AFTER `rn = 1`, SO EVERY ROW IS A GENUINE FIRST FUNDING.
 OFFSET 0 ROWS FETCH NEXT 20 ROWS ONLY;
