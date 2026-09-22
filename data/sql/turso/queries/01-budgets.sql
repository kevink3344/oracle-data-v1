--------------------------------------------------------------------------------
-- 01-budgets.sql  |  Budgets from GL_BALANCES (ACTUAL_FLAG = 'B')
--------------------------------------------------------------------------------
-- READ-ONLY. Every statement is a SELECT. No INSERT/UPDATE/DELETE, no DDL.
--
-- PRECONDITION: 00-discover.sql section B returned rows with ACTUAL_FLAG='B'.
-- If it did not, there is no budget to query and this file has no purpose.
--
-- SEGMENT MAP (from the sample extract - verify against 00-discover.sql H):
--   SEGMENT1 FUND   SEGMENT2 PURPOSE  SEGMENT3 PROGRAM   SEGMENT4 OBJECT
--   SEGMENT5 LEVEL  SEGMENT6 COST_CENTER              SEGMENT7 FUTURE_USE
-- SEGMENT5 is the project identifier. SEGMENT2 is the Capital/Operating axis
-- (6570 Capital, 9000 Operating, 6560 Relocation).
--
-- ON THE BUDGET MEASURE. GL_BALANCES stores, per combination/month, both a
-- brought-forward balance (BEGIN_BALANCE_DR/CR) and that period's movement
-- (PERIOD_NET_DR/CR). Two different totals are therefore possible:
--   * SUM(PERIOD_NET_DR - PERIOD_NET_CR)          = total budget entered
--   * SUM(BEGIN_BALANCE_DR - BEGIN_BALANCE_CR)    = over-counts, because the
--     balance is carried forward into every period.
-- The first is used as "budget total" throughout. B2 prints both side by side
-- so the difference is visible rather than assumed.
--------------------------------------------------------------------------------

-- ============================================================================
-- PORT NOTES - SQLite / libSQL dialect.
--
-- Added by the port. The Oracle comments above and below are kept VERBATIM,
-- including every section label (B1..B6.2) and every "Expect" assertion,
-- because other documents cross-reference them.
--
--   1. `apps.` object prefix DROPPED - this surrogate is a single schema, so
--      every name resolves unprefixed. The base-table names carried here are
--      the same ones the Oracle original uses.
--   2. NVL(a,b) -> COALESCE(a,b).
--   3. DECODE(x, k1,v1, k2,v2, default) -> CASE x WHEN ... THEN ... ELSE ... END.
--      B3 and B4 each carry one, and both are the SEGMENT2 purpose label.
--   4. TO_CHAR(<num>, 'FM999,999,999,999,990.00') -> printf('%.2f', ROUND(<num>,2)).
--      THE THOUSANDS SEPARATOR CANNOT BE REPRODUCED: SQLite's printf has no
--      grouping flag. This is the single place the port is visibly not 1:1 in
--      its OUTPUT - amounts print ungrouped ("4356078.25", not "4,356,078.25").
--      The two-decimal rounding is preserved exactly.
--   5. LPAD(b.period_num, 2, '0') -> printf('%02d', b.period_num). Both render
--      the period number zero-padded to two digits; printf does it arithmetically
--      rather than by string padding, so it also handles period_num >= 100.
--   6. WHERE ROWNUM <= 60 (B4) -> LIMIT 60. Oracle applies ROWNUM to the
--      enclosing query, so it names a specific 60 rows only because the inline
--      view it wraps is ordered - here by budget_total_num DESC. LIMIT 60 is
--      therefore the same 60 rows, largest budget first.
--   7. FULL OUTER JOIN (B6.1), NULLS LAST (B6.1) and CASE-in-aggregate (B5.2,
--      B5.3) need NO change: SQLite has supported all three since 3.39, and this
--      target is 3.45. They are carried over untouched.
-- ============================================================================


-- ============================================================================
-- B1. Budget by accounting period - the timeline.
--
-- One row per posting period. `budget_in_period` is the movement entered in
-- that period; `budget_running` is the cumulative position, which is the budget
-- as it stood after that period closed. If `budget_in_period` is non-zero in
-- only one row, the budget was entered as a single lump. If it is spread
-- across rows, the budget is period-phased - which matters, because the app's
-- project screen has no column for a phased budget yet.
-- ============================================================================

SELECT b.period_year,
       printf('%02d', b.period_num)                 AS period_no,
       b.period_name,
       b.period_type,
       COUNT(DISTINCT b.code_combination_id)         AS combo_count,
       printf('%.2f', ROUND(SUM(COALESCE(b.period_net_dr, 0) - COALESCE(b.period_net_cr, 0)), 2))
                                                    AS budget_in_period,
       printf('%.2f', ROUND(SUM(COALESCE(b.begin_balance_dr, 0) - COALESCE(b.begin_balance_cr, 0)), 2))
                                                    AS begin_balance,
       printf('%.2f', ROUND(SUM(COALESCE(b.begin_balance_dr, 0) - COALESCE(b.begin_balance_cr, 0)
                              + COALESCE(b.period_net_dr, 0)   - COALESCE(b.period_net_cr, 0)), 2))
                                                    AS budget_as_of_period_end
FROM   gl_balances b
WHERE  b.actual_flag = 'B'
GROUP  BY b.period_year, b.period_num, b.period_name, b.period_type
ORDER  BY b.period_year, b.period_num;


-- ============================================================================
-- B2. Budget by version, with both measures side by side.
--
-- One row per BUDGET_VERSION_ID. If the two amount columns differ, the budget
-- is period-phased and `sum_of_period_movement` is the figure to use.
-- If there is only one row here, the budget has no versioning and needs no
-- picker in the UI.
-- ============================================================================

SELECT b.budget_version_id,
       COUNT(DISTINCT b.code_combination_id)         AS combo_count,
       COUNT(DISTINCT b.period_name)                 AS period_count,
       printf('%.2f', ROUND(SUM(COALESCE(b.period_net_dr, 0) - COALESCE(b.period_net_cr, 0)), 2))
                                                    AS sum_of_period_movement,
       printf('%.2f', ROUND(SUM(COALESCE(b.begin_balance_dr, 0) - COALESCE(b.begin_balance_cr, 0)), 2))
                                                    AS sum_of_begin_balances
FROM   gl_balances b
WHERE  b.actual_flag = 'B'
GROUP  BY b.budget_version_id
ORDER  BY b.budget_version_id;


-- ============================================================================
-- B3. Budget by purpose - the Capital / Operating / Relocation split.
--
-- Small (expect 3-5 rows) and directly comparable with the extract's own
-- split, where PURPOSE 6570 = Capital, 9000 = Operating, 6560 = Relocation.
-- ============================================================================

SELECT c.segment2                                   AS purpose_code,
       CASE c.segment2
         WHEN '6570' THEN 'Capital'
         WHEN '9000' THEN 'Operating'
         WHEN '6560' THEN 'Relocation'
         ELSE '(other)'
       END                                          AS purpose_label,
       COUNT(DISTINCT b.code_combination_id)        AS combo_count,
       printf('%.2f', ROUND(SUM(COALESCE(b.period_net_dr, 0) - COALESCE(b.period_net_cr, 0)), 2))
                                                    AS budget_total
FROM   gl_balances b
JOIN   gl_code_combinations c
       ON c.code_combination_id = b.code_combination_id
WHERE  b.actual_flag = 'B'
AND    c.summary_flag = 'N'
GROUP  BY c.segment2
ORDER  BY SUM(COALESCE(b.period_net_dr, 0) - COALESCE(b.period_net_cr, 0)) DESC;


-- ============================================================================
-- B4. Budget per project - the deliverable.
--
-- SEGMENT5 is the project. One row per project x purpose, largest first,
-- capped at 60 rows. Remove the ROWNUM cap to see every project.
-- ============================================================================

SELECT * FROM (
  SELECT c.segment5                                 AS project_level,
         c.segment2                                 AS purpose_code,
         CASE c.segment2
           WHEN '6570' THEN 'Capital'
           WHEN '9000' THEN 'Operating'
           WHEN '6560' THEN 'Relocation'
           ELSE '(other)'
         END                                        AS purpose_label,
         COUNT(DISTINCT b.code_combination_id)      AS combo_count,
         COUNT(DISTINCT c.segment4)                 AS object_code_count,
         MIN(b.period_name)                         AS first_period,
         MAX(b.period_name)                         AS last_period,
         SUM(COALESCE(b.period_net_dr, 0) - COALESCE(b.period_net_cr, 0)) AS budget_total_num,
         printf('%.2f', ROUND(SUM(COALESCE(b.period_net_dr, 0) - COALESCE(b.period_net_cr, 0)), 2))
                                                    AS budget_total
  FROM   gl_balances b
  JOIN   gl_code_combinations c
         ON c.code_combination_id = b.code_combination_id
  WHERE  b.actual_flag = 'B'
  AND    c.summary_flag = 'N'
  GROUP  BY c.segment5, c.segment2
  -- PORT: ROWNUM is gone, so this ORDER BY is now what fixes the row order of
  -- the LIMIT 60 below. Same ordering the original relied on.
  ORDER  BY budget_total_num DESC
) LIMIT 60;


-- ============================================================================
-- B5. Grand total and coverage.
--
-- Two things at once: the overall budget figure, and whether every budget
-- combination can be named. The PO sample already shows only 196 of 328
-- combinations had a GL_CODE_COMBINATIONS row, and the unmatched ones carried
-- 80% of the money. If the budget has the same gap, per-project budgets will
-- be understated - and that shortfall must be shown, not silently dropped.
-- ============================================================================

-- B5.1 The total.
SELECT printf('%.2f', ROUND(SUM(COALESCE(b.period_net_dr, 0) - COALESCE(b.period_net_cr, 0)), 2))
                                                    AS budget_total_all_versions,
       COUNT(DISTINCT b.budget_version_id)          AS version_count,
       COUNT(DISTINCT b.code_combination_id)        AS combo_count,
       COUNT(DISTINCT b.period_name)                AS period_count
FROM   gl_balances b
WHERE  b.actual_flag = 'B';

-- B5.2 How many budget combinations have no segment row?
SELECT COUNT(DISTINCT b.code_combination_id)                            AS budget_combos,
       COUNT(DISTINCT CASE WHEN c.code_combination_id IS NULL
                           THEN b.code_combination_id END)              AS combos_without_segments
FROM   gl_balances b
LEFT   JOIN gl_code_combinations c
       ON c.code_combination_id = b.code_combination_id
WHERE  b.actual_flag = 'B';

-- B5.3 The same gap measured in money.
SELECT printf('%.2f', ROUND(SUM(CASE WHEN c.code_combination_id IS NOT NULL
                                     THEN x.net ELSE 0 END), 2))
                                                    AS resolved_amount,
       printf('%.2f', ROUND(SUM(CASE WHEN c.code_combination_id IS NULL
                                     THEN x.net ELSE 0 END), 2))
                                                    AS unresolved_amount
FROM   (SELECT b.code_combination_id,
               COALESCE(b.period_net_dr, 0) - COALESCE(b.period_net_cr, 0) AS net
        FROM   gl_balances b
        WHERE  b.actual_flag = 'B') x
LEFT   JOIN gl_code_combinations c
       ON c.code_combination_id = x.code_combination_id;


-- ============================================================================
-- B6. BUDGET vs COMMITTED, per project.
--
-- The comparison the app currently cannot draw, because the budget side was
-- believed unavailable. Budget comes from GL_BALANCES (flag 'B'); committed
-- comes from PO_DISTRIBUTIONS' encumbrance.
--
-- A FULL OUTER JOIN is deliberate: a project with a budget but no spend, or
-- spend but no budget, must still appear. An inner join would hide exactly the
-- anomalies worth seeing.
--
-- PO_DISTRIBUTIONS can be a large table. Run B6.0 first.
-- ============================================================================

-- B6.0 Size check before running the join.
SELECT COUNT(*)                                      AS distribution_rows,
       COUNT(DISTINCT p.code_combination_id)         AS distinct_combos,
       printf('%.2f', ROUND(SUM(COALESCE(p.encumbered_amount, 0)), 2))
                                                    AS encumbered_total,
       printf('%.2f', ROUND(SUM(COALESCE(p.amount_billed, 0)), 2))
                                                    AS billed_total
FROM   po_distributions_all p;

-- B6.1 Budget vs committed per project.
-- NOTE: this assumes CODE_COMBINATION_ID is unique in GL_CODE_COMBINATIONS.
-- The sample extract showed 0 duplicates; if this one has duplicates the
-- dimension join below will fan out and the totals will be too high.
-- B6.2 checks it.
WITH budget AS (
  SELECT b.code_combination_id                       AS ccid,
         SUM(COALESCE(b.period_net_dr, 0) - COALESCE(b.period_net_cr, 0)) AS budget_amt
  FROM   gl_balances b
  WHERE  b.actual_flag = 'B'
  GROUP  BY b.code_combination_id
),
committed AS (
  SELECT p.code_combination_id                       AS ccid,
         SUM(COALESCE(p.encumbered_amount, 0))       AS encumbered_amt,
         SUM(COALESCE(p.amount_billed, 0))           AS billed_amt
  FROM   po_distributions_all p
  GROUP  BY p.code_combination_id
)
SELECT COALESCE(d.segment5, '(no segment row)')                    AS project_level,
       COALESCE(d.segment2, '--')                                  AS purpose_code,
       COUNT(DISTINCT COALESCE(bd.ccid, cm.ccid))                  AS combo_count,
       printf('%.2f', ROUND(COALESCE(SUM(bd.budget_amt), 0), 2))   AS budget_total,
       printf('%.2f', ROUND(COALESCE(SUM(cm.encumbered_amt), 0), 2)) AS committed_total,
       printf('%.2f', ROUND(COALESCE(SUM(cm.billed_amt), 0), 2))   AS billed_total,
       printf('%.2f', ROUND(COALESCE(SUM(bd.budget_amt), 0)
                            - COALESCE(SUM(cm.encumbered_amt), 0), 2)) AS headroom
FROM   budget bd
FULL   OUTER JOIN committed cm
       ON cm.ccid = bd.ccid
/* One dimension join keyed on whichever side of the outer join exists.
   Joining the COA twice and coalescing the two segment columns would let a
   budget on an unmapped combination inherit the OTHER side's project - 
   attributing money to the wrong project rather than to none. */
LEFT   JOIN gl_code_combinations d
       ON d.code_combination_id = COALESCE(bd.ccid, cm.ccid)
GROUP  BY COALESCE(d.segment5, '(no segment row)'), COALESCE(d.segment2, '--')
ORDER  BY COALESCE(SUM(bd.budget_amt), 0) DESC NULLS LAST;

-- B6.2 Guard for the assumption B6.1 makes.
-- Expect 0. Any row returned means CODE_COMBINATION_ID repeats, and B6.1's
-- totals must be read with that in mind.
SELECT c.code_combination_id, COUNT(*) AS row_count
FROM   gl_code_combinations c
GROUP  BY c.code_combination_id
HAVING COUNT(*) > 1
ORDER  BY 2 DESC;
