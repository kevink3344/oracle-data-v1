-- ============================================================================
--  WHEN EACH COMBINATION WAS FIRST ALLOCATED BUDGET — FUND 04 ONLY
--
--  A port of the single-account example (GL_BALANCES x GL_BUDGET_VERSIONS), with
--  the :s1..:s7 binds and the acct CTE dropped, the combination as the row grain,
--  and FETCH FIRST 1 ROW ONLY rewritten as ROW_NUMBER() over the combination
--  partition (also the form that runs on both SQLite and Oracle).
--
--  ---------------------------------------------------------------------------
--  WHAT THIS VERSION ADDS: THE FUND FILTER
--  ---------------------------------------------------------------------------
--  The original reads every fund the ledger holds. This one keeps **Fund 04
--  only** — SEGMENT1 on GL_CODE_COMBINATIONS, which is the fund segment (see
--  00-schema.sql: SEGMENT1 Fund · SEGMENT2 Purpose · SEGMENT3 Program ·
--  SEGMENT4 Object · SEGMENT5 Level · SEGMENT6 Cost Center · SEGMENT7 Future use).
--
--  ★ THE FILTER IS APPLIED IN `code_period`, NOT AT THE END. That is the whole
--    point of putting it there rather than in the final SELECT: the budget rows
--    for other funds are dropped *before* the ROW_NUMBER() ranking, so a
--    combination's "first" allocation is its first allocation **in fund 04**.
--    Filtering at the end would rank across every fund first and then discard
--    rows, which can leave a combination with NO row at all — its earliest
--    allocation was in another fund, so `rn = 1` was consumed by a row the filter
--    then removed.
--
--  ★ THE JOIN TO GL_CODE_COMBINATIONS IS WHAT MAKES THE FILTER POSSIBLE. The fund
--    lives on the combination, not on GL_BALANCES, so `gb` alone cannot be
--    filtered by it. The join is on the primary key of both and therefore 1:1 —
--    it does not multiply the balance rows.
--
--  ---------------------------------------------------------------------------
--  WHAT IS DELIBERATELY NOT FILTERED
--  ---------------------------------------------------------------------------
--  ★ NO SUMMARY_FLAG / ENABLED_FLAG FILTER, KEPT FROM THE ORIGINAL. A rollup
--    parent combination (SUMMARY_FLAG = 'Y') and a disabled combination
--    (ENABLED_FLAG = 'N') therefore still appear as rows of their own. That is a
--    documented property of this query, not an oversight — it is what lets a
--    reader see the rollup parent beside its children. Add
--    `AND g.SUMMARY_FLAG = 'N' AND g.ENABLED_FLAG = 'Y'` if the rollup rows are
--    not wanted; measured on the sample that removes the 97,790,333 parent row.
--
--  ★ NO PROGRAM FILTER. The register's own scope is fund 04 AND programs
--    861/862/863, but this query is about the fund alone, so a fund-04 row under
--    any program is kept. Add `AND g.SEGMENT3 IN ('861','862','863')` for the
--    full register scope.
--
--  ---------------------------------------------------------------------------
--  PORTABILITY
--  ---------------------------------------------------------------------------
--  Runs unchanged on SQLite (the sample) and Oracle: no FETCH FIRST, no ROWNUM,
--  no NVL/DECODE/TO_CHAR, no `(+)`. `ROW_NUMBER() OVER (PARTITION BY …)` and the
--  CTE are supported by both.
-- ============================================================================
WITH code_period AS (
  SELECT gb.code_combination_id                  AS ccid,
         gb.budget_version_id,
         gb.period_year,
         gb.period_num,
         gb.period_name,
         SUM(gb.period_net_dr)                   AS net_dr,
         SUM(gb.period_net_cr)                   AS net_cr,
         SUM(gb.period_net_dr - gb.period_net_cr) AS net_amount
    FROM gl_balances gb
    JOIN gl_ledgers  l ON l.ledger_id = gb.ledger_id
    -- ★ The fund filter needs this join: SEGMENT1 is on the combination, not on
    --   the balance. `CODE_COMBINATION_ID` is the primary key of both, so this is
    --   1:1 and cannot fan the balance rows out.
    JOIN gl_code_combinations g
      ON g.code_combination_id = gb.code_combination_id
   WHERE gb.actual_flag         = 'B'
     AND gb.translated_flag     = 'N'
     AND gb.encumbrance_type_id IS NULL
     AND gb.currency_code       = l.currency_code
     -- ★ FUND 04 ONLY. Filtered here, before the ranking, so `rn = 1` means
     --   "first allocation in fund 04" rather than "first allocation anywhere,
     --   if it happened to be fund 04".
     AND g.segment1             = '04'
   GROUP BY gb.code_combination_id,
            gb.budget_version_id,
            gb.period_year,
            gb.period_num,
            gb.period_name
  HAVING SUM(gb.period_net_dr - gb.period_net_cr) <> 0
),
ranked AS (
  SELECT cp.*,
         ROW_NUMBER() OVER (PARTITION BY cp.ccid
                            ORDER BY cp.period_year, cp.period_num,
                                     cp.period_name, cp.budget_version_id) AS rn
    FROM code_period cp
)
SELECT k.combination_key     AS code_combination,
       r.period_name         AS first_allocation_period,
       r.period_year,
       r.period_num,
       r.net_dr,
       r.net_cr,
       r.net_amount          AS first_allocation_amount,
       bv.budget_name,
       bv.budget_type_id,
       bv.first_period_name  AS version_first_period
  FROM ranked r
  JOIN gl_budget_versions     bv ON bv.budget_version_id = r.budget_version_id
  JOIN v_code_combination_key k  ON k.code_combination_id = r.ccid
 WHERE r.rn = 1
 ORDER BY k.combination_key
