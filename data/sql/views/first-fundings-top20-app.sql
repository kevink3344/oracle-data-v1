-- FIRST FUNDINGS — the TOP 20 newest first-fundings, one row per fund code.
--
-- ★ THIS IS THE VIEW BUILDER'S COPY, AND IT IS NOT THE SAME FILE AS
--   `data/sql/sqlserver/first-fundings-top20.sql`. That one is a standalone T-SQL
--   document for a human to paste into a client — it carries `dbo.` prefixes and
--   `OFFSET/FETCH`. THIS one is executed by the app, so it is written in the
--   app's own dialect and the SQL Server driver rewrites it on the way out:
--
--       `LIMIT 20`  →  `OFFSET 0 ROWS FETCH NEXT 20 ROWS ONLY`
--
--   Storing the T-SQL form here would leave the driver nothing to rewrite, and
--   would break the moment the same view is run against the SQLite sample. The
--   two files answer the same question in the two dialects the app spans; keep
--   them in step by hand, and change this one when the query changes.
--
-- ★ WHY THE SAVED VIEW WAS EMPTY. The previous body filtered
--   `gb.translated_flag = 'N'`, and on this instance TRANSLATED_FLAG is NULL on
--   all 1,448,776 rows of GL_BALANCES — so the predicate was false everywhere and
--   the view returned nothing. Widened below to admit the NULLs.
--
-- ★ WHY THERE IS NO `period_year` FILTER. Pinning the year redefines "first
--   funding" as "first funding of that year": measured, 6,217 of the 6,727
--   fund-04 combinations have no funded period inside FY2027 at all. The ranking
--   spans every year the ledger holds, which is what "first" means.
--
-- ★ `budget_type_id` AND `first_period_name` ARE GONE. Neither column exists on
--   this instance's GL_BUDGET_VERSIONS (it has BUDGET_TYPE, STATUS, DATE_OPENED
--   instead), so the previous body would have failed with `Invalid column name`.
WITH code_period AS (
  SELECT gb.code_combination_id                   AS ccid,
         gb.budget_version_id,
         gb.period_year,
         gb.period_num,
         gb.period_name,
         SUM(gb.period_net_dr)                    AS net_dr,
         SUM(gb.period_net_cr)                    AS net_cr,
         SUM(gb.period_net_dr - gb.period_net_cr) AS net_amount
    FROM gl_balances gb
    JOIN gl_ledgers  l ON l.ledger_id = gb.ledger_id
    JOIN gl_code_combinations g ON g.code_combination_id = gb.code_combination_id
   WHERE gb.actual_flag            = 'B'
     AND (gb.translated_flag IS NULL OR gb.translated_flag = 'N')
     AND gb.encumbrance_type_id IS NULL
     AND gb.currency_code       = l.currency_code
     -- ★★ THE APPLICATION'S SCOPE: FUND 04, PROGRAM 861 / 862 / 863.
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
     --    ★ WHAT THIS REMOVES. Without it the view returned fund-04 combinations
     --      whose program is `801`, `854`, `000`, `640` … — real rows, real money,
     --      and outside the scope the rest of the application declares. Measured:
     --      2,228 of 16,141 fund-04 combinations are in scope.
     --
     -- ★★ THE SCOPE IS THE PROGRAM, NOT ONE ACCOUNT — AND THAT IS A MEASUREMENT.
     --
     --        segment1 = '04'   fund
     --        segment3 = '862'  program
     --
     --    MEASURED: **1,630** combinations match. The narrower
     --    `04 / 862 / 527 / 0450` scope holds **1** — a single account — and a
     --    one-account scope cannot answer "which items were first funded this
     --    month", because it can only ever return that one account or nothing.
     --
     --    ★ THE COST-CENTRE AND OBJECT FILTERS WERE REMOVED FOR THAT REASON. With
     --      them, August FY2026 returned **0 rows**; without them it returns **6** —
     --      the six combinations in program 862 whose first-ever funding landed in
     --      that month. The scope was what made the window empty, not the window.
     --
     --    ★ `segment2` (department), `segment6` and `segment7` remain unfiltered
     --      deliberately: pinning them would turn a program report back into an
     --      account lookup.
     AND g.segment1             = '04'
     AND g.segment3             = '862'
     AND gb.budget_version_id   = 1001
   GROUP BY gb.code_combination_id,
            gb.budget_version_id,
            gb.period_year,
            gb.period_num,
            gb.period_name
  HAVING SUM(gb.period_net_dr - gb.period_net_cr) <> 0
),
ranked AS (
  SELECT cp.*,
         ROW_NUMBER() OVER (PARTITION BY cp.ccid, cp.budget_version_id
                            ORDER BY cp.period_year, cp.period_num, cp.period_name) AS rn
    FROM code_period cp
),
-- ---------------------------------------------------------------------------
-- ★★ THE DATE THE ALLOCATION WAS RECORDED — AND WHY IT NEEDS ITS OWN CTE.
--
--    `GL_BALANCES` carries NO date column at all (verified: 13 columns, none a
--    timestamp), so the period was the only time axis it could offer. The date
--    lives on the JOURNAL LINE that moved the money:
--
--        GL_JE_LINES.CREATION_DATE   the day the line was written
--
--    ★ ONE ROW PER COMBINATION, NOT ONE PER LINE. A combination has many journal
--      lines (the busiest has 6,553), so joining them directly would multiply the
--      result by the line count. This CTE collapses to the EARLIEST date per
--      combination, which is the same "first" the ranking above means.
--
--    ★ `MIN(CREATION_DATE)` RATHER THAN THE FIRST LINE'S DATE. "When was this
--      combination first funded" is the earliest journal line that touched it, and
--      `MIN` is that question exactly. Taking the date from the ranked period's own
--      line would answer "when was the period's line written", which is a different
--      and much later date.
--
--    ★ THE JOIN IS ON `CODE_COMBINATION_ID`, WHICH IS THE ONLY KEY THE TWO SHARE.
--      `GL_JE_LINES` has no fund column — the fund lives on `GL_CODE_COMBINATIONS`
--      — so the copy was scoped by joining that table, and this CTE joins on the
--      same id.
--
--    ★ IT IS A LEFT JOIN AT THE END, NOT AN INNER ONE. A combination funded
--      entirely by an opening balance or a conversion journal may have no line in
--      the copied scope, and dropping such a row would silently shorten the result.
--      A null date is visible; a missing row is not.
journal_first AS (
  SELECT jl.code_combination_id AS ccid,
         MIN(jl.creation_date)   AS first_journal_date,
         COUNT(*)                AS journal_lines
    FROM gl_je_lines jl
   GROUP BY jl.code_combination_id
)
SELECT k.combination_key AS fund_code,
       r.period_name     AS first_allocation_period,
       r.period_year,
       r.period_num,
       r.net_dr,
       r.net_cr,
       r.net_amount      AS first_allocation_amount,
       bv.budget_name,
       bv.budget_type,
       bv.status         AS version_status,
       bv.date_opened    AS version_opened,
       -- ★ THE LAST COLUMN, AS ASKED. `journal_lines` rides along so a reader can
       --   tell "one line on this date" from "the earliest of 6,553" — the date
       --   alone cannot distinguish a first funding from a first touch.
       jf.first_journal_date AS first_journal_date,
       jf.journal_lines      AS journal_lines
  FROM ranked r
  JOIN gl_budget_versions     bv ON bv.budget_version_id = r.budget_version_id
  JOIN v_code_combination_key k  ON k.code_combination_id = r.ccid
  LEFT JOIN journal_first     jf ON jf.ccid = r.ccid
 WHERE r.rn = 1
   -- ★★ THE DATE RANGE, APPLIED TO THE OUTPUT — AND THE PLACEMENT IS THE DESIGN.
   --
   --    "Aug FY 26" is AUGUST OF FISCAL YEAR 2026, which is `Aug-25-FY-26` —
   --    `period_year = 2026`, `period_num = 2`. Verified against GL_PERIODS rather
   --    than assumed: this ledger's fiscal year runs July–June, so FY2026 is
   --    `Jul-25-FY-26` (PN 1) … `Jun-26-FY-26` (PN 12), and August is PN 2.
   --
   --    ★ THE NAME IS AMBIGUOUS AND THE OTHER READING IS EMPTY. "Aug 26" could mean
   --      the CALENDAR August 2026, which is `Aug-26-FY-27` (FY2027, PN 2). Measured
   --      for this scope: the fiscal reading returns 0 rows and the calendar reading
   --      also returns 0 — but for different reasons, and the two are NOT
   --      interchangeable. The fiscal reading is the one the phrase names.
   --
   --    ★★ IT FILTERS THE OUTPUT, NOT THE RANKING, AND THE TWO ARE NOT THE SAME
   --       QUESTION. Measured on this scope, the two placements disagree:
   --
   --         ranking filter (range first, then rank)  → picks a period's first row,
   --                                                    which can be a reversal
   --         output filter  (rank first, then range)  → "what was NEWLY funded in
   --                                                    this window"
   --
   --       The output filter answers the question the report asks: a combination is
   --       shown only if its FIRST-EVER funding falls inside the window. That is
   --       what makes the amount the "$315,000 first funding for each item" rather
   --       than "the first thing that happened to post that month".
   --
   --    ★ IT MUST COME AFTER `r.rn = 1`. A period predicate inside `code_period`
   --      would let a later period consume `rn = 1` and then be filtered out, so a
   --      combination funded before the window would vanish rather than simply not
   --      qualify — the ordering trap this file's own header warns about.
   --
   --    ★ AND THE ANSWER HERE IS SIX ROWS. MEASURED for `04 + 862` in
   --      `Aug-25-FY-26`: **6** combinations have their first-ever funding in that
   --      month. (Under the previous, one-account scope the same window returned 0 —
   --      the scope was what made it empty, not the window.)
   --
   --    ★ TO WIDEN TO JULY–JUNE OF THE YEAR, use `AND r.period_num BETWEEN 1 AND 12`.
   --      To go back to one account, restore the `segment4`/`segment5` predicates
   --      above — but note a one-account scope can only ever return that account or
   --      nothing, which is why this report is scoped by program.
   AND r.period_year = 2026
   AND r.period_num = 2
 ORDER BY r.period_year DESC, r.period_num DESC, k.combination_key
 LIMIT 20
