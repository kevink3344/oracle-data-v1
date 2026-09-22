--------------------------------------------------------------------------------
-- 01-budgets.sql  |  Budgets from GL_BALANCES (ACTUAL_FLAG = 'B')
--------------------------------------------------------------------------------
-- READ-ONLY. Every statement is a SELECT. No INSERT/UPDATE/DELETE, no DDL.
--
-- PRECONDITION: 00-discover.sql section B returned rows with ACTUAL_FLAG='B'.
-- If it did not, there is no budget to query and this file has no purpose.
--
-- ----------------------------------------------------------------------------
-- REPORTING WINDOW: FY2025 - FY2027, the newest three fiscal years.
--
-- Every MEASURE in this file is restricted to this window. The predicate is:
--
--     period_year >= (SELECT MAX (period_year) - 2 FROM apps.gl_periods)
--
-- DERIVED, NEVER A LITERAL. MAX(PERIOD_YEAR) is the newest fiscal year the
-- ledger holds, so the floor moves with the ledger. A literal was tried before
-- ('period_year >= 2023', written when the newest year was FY2025) and by
-- FY2027 it had silently become a FIVE-year window over 46,013,161 rows. The
-- expression above cannot drift that way. Confirm it at any time with:
--
--     SELECT MAX (period_year) - 2 AS window_floor FROM apps.gl_periods;
--
-- Today:  MAX(PERIOD_YEAR) = 2027 -> floor 2025 -> FY2025, FY2026, FY2027
--         = 2024-07-01 .. 2027-06-30, 39 periods.
-- Cost:   GL_BALANCES holds 157,150,828 rows spanning FY1999-FY2027. The
--         window keeps 26,214,388 of them - 16.7%, the newest 3 of 29 fiscal
--         years. FY2027 is in progress, so its periods are partial.
--
-- FY = fiscal year, Jul-Jun, 13 periods (12 months + an Adjust period).
-- PERIOD_YEAR is the FISCAL year: FY2027 runs Jul-26 .. Jun-27.
--
-- Queries marked NOT WINDOWED measure the EXTENT of the data - row counts,
-- MIN/MAX period, coverage gaps. A windowed extent query reports the window
-- rather than the truth, and would make this folder's first question ("is
-- there a budget here at all?") answer no.
-- ----------------------------------------------------------------------------
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
-- B1. Budget by accounting period - the timeline.
--
-- One row per posting period. `budget_in_period` is the movement entered in
-- that period; `budget_running` is the cumulative position, which is the budget
-- as it stood after that period closed. If `budget_in_period` is non-zero in
-- only one row, the budget was entered as a single lump. If it is spread
-- across rows, the budget is period-phased - which matters, because the app's
-- project screen has no column for a phased budget yet.
--
-- WINDOWED, and this is the one query where the window does NOT lose the
-- earlier money: BEGIN_BALANCE_DR/CR is carried forward, so
-- `budget_as_of_period_end` on the last row is the cumulative budget position
-- at the end of FY2027 INCLUDING everything posted before FY2025. The
-- per-period columns are windowed; the running position is not.
-- ============================================================================

SELECT b.period_year,
       LPAD(b.period_num, 2, '0')                    AS period_no,
       b.period_name,
       b.period_type,
       COUNT(DISTINCT b.code_combination_id)         AS combo_count,
       TO_CHAR(ROUND(SUM(NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0)), 2),
               'FM999,999,999,999,990.00')           AS budget_in_period,
       TO_CHAR(ROUND(SUM(NVL(b.begin_balance_dr, 0) - NVL(b.begin_balance_cr, 0)), 2),
               'FM999,999,999,999,990.00')           AS begin_balance,
       TO_CHAR(ROUND(SUM(NVL(b.begin_balance_dr, 0) - NVL(b.begin_balance_cr, 0)
                       + NVL(b.period_net_dr, 0)   - NVL(b.period_net_cr, 0)), 2),
               'FM999,999,999,999,990.00')           AS budget_as_of_period_end
FROM   apps.gl_balances b
WHERE  b.actual_flag = 'B'
AND    b.period_year >= (SELECT MAX (period_year) - 2 FROM apps.gl_periods)
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
       TO_CHAR(ROUND(SUM(NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0)), 2),
               'FM999,999,999,999,990.00')           AS sum_of_period_movement,
       TO_CHAR(ROUND(SUM(NVL(b.begin_balance_dr, 0) - NVL(b.begin_balance_cr, 0)), 2),
               'FM999,999,999,999,990.00')           AS sum_of_begin_balances
FROM   apps.gl_balances b
WHERE  b.actual_flag = 'B'
AND    b.period_year >= (SELECT MAX (period_year) - 2 FROM apps.gl_periods)
GROUP  BY b.budget_version_id
ORDER  BY b.budget_version_id;


-- ============================================================================
-- B3. Budget by purpose - the Capital / Operating / Relocation split.
--
-- Small (expect 3-5 rows) and directly comparable with the extract's own
-- split, where PURPOSE 6570 = Capital, 9000 = Operating, 6560 = Relocation.
-- ============================================================================

SELECT c.segment2                                   AS purpose_code,
       DECODE(c.segment2,
              '6570', 'Capital',
              '9000', 'Operating',
              '6560', 'Relocation',
                     '(other)')                     AS purpose_label,
       COUNT(DISTINCT b.code_combination_id)        AS combo_count,
       TO_CHAR(ROUND(SUM(NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0)), 2),
               'FM999,999,999,999,990.00')          AS budget_total
FROM   apps.gl_balances b
JOIN   apps.gl_code_combinations c
       ON c.code_combination_id = b.code_combination_id
WHERE  b.actual_flag = 'B'
AND    b.period_year >= (SELECT MAX (period_year) - 2 FROM apps.gl_periods)
AND    c.summary_flag = 'N'
GROUP  BY c.segment2
ORDER  BY SUM(NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0)) DESC;


-- ============================================================================
-- B4. Budget per project - the deliverable.
--
-- SEGMENT5 is the project. One row per project x purpose, largest first,
-- capped at 60 rows. Remove the ROWNUM cap to see every project.
-- ============================================================================

SELECT * FROM (
  SELECT c.segment5                                 AS project_level,
         c.segment2                                 AS purpose_code,
         DECODE(c.segment2,
                '6570', 'Capital',
                '9000', 'Operating',
                '6560', 'Relocation',
                       '(other)')                   AS purpose_label,
         COUNT(DISTINCT b.code_combination_id)      AS combo_count,
         COUNT(DISTINCT c.segment4)                 AS object_code_count,
         MIN(b.period_name)                         AS first_period,
         MAX(b.period_name)                         AS last_period,
         SUM(NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0)) AS budget_total_num,
         TO_CHAR(ROUND(SUM(NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0)), 2),
                 'FM999,999,999,999,990.00')        AS budget_total
  FROM   apps.gl_balances b
  JOIN   apps.gl_code_combinations c
         ON c.code_combination_id = b.code_combination_id
  WHERE  b.actual_flag = 'B'
  AND    b.period_year >= (SELECT MAX (period_year) - 2 FROM apps.gl_periods)
  AND    c.summary_flag = 'N'
  GROUP  BY c.segment5, c.segment2
  ORDER  BY budget_total_num DESC
) WHERE ROWNUM <= 60;


-- ============================================================================
-- B5. Grand total and coverage.
--
-- B5.1 is WINDOWED - it is budget entered in FY2025-FY2027, not a lifetime
-- total. B5.2 and B5.3 are NOT WINDOWED: they count how much of the budget
-- cannot be named, which is a property of the data, not of a date range.
--
-- Two things at once: the overall budget figure, and whether every budget
-- combination can be named. The PO sample already shows only 196 of 328
-- combinations had a GL_CODE_COMBINATIONS row, and the unmatched ones carried
-- 80% of the money. If the budget has the same gap, per-project budgets will
-- be understated - and that shortfall must be shown, not silently dropped.
-- ============================================================================

-- B5.1 Budget entered INSIDE the window.
--
-- This is movement, not position: it is what was posted to the budget in
-- FY2025-FY2027. A capital appropriation made in FY2023 does not appear here.
-- For the position - the budget as it stands, carrying the earlier years - use
-- B1's `budget_as_of_period_end` on its last row.
SELECT TO_CHAR(ROUND(SUM(NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0)), 2),
               'FM999,999,999,999,990.00')          AS budget_entered_in_window,
       COUNT(DISTINCT b.budget_version_id)          AS version_count,
       COUNT(DISTINCT b.code_combination_id)        AS combo_count,
       COUNT(DISTINCT b.period_name)                AS period_count
FROM   apps.gl_balances b
WHERE  b.actual_flag = 'B'
AND    b.period_year >= (SELECT MAX (period_year) - 2 FROM apps.gl_periods);

-- B5.2 How many budget combinations have no segment row?
SELECT COUNT(DISTINCT b.code_combination_id)                            AS budget_combos,
       COUNT(DISTINCT CASE WHEN c.code_combination_id IS NULL
                           THEN b.code_combination_id END)              AS combos_without_segments
FROM   apps.gl_balances b
LEFT   JOIN apps.gl_code_combinations c
       ON c.code_combination_id = b.code_combination_id
WHERE  b.actual_flag = 'B';

-- B5.3 The same gap measured in money.
SELECT TO_CHAR(ROUND(SUM(CASE WHEN c.code_combination_id IS NOT NULL
                              THEN x.net ELSE 0 END), 2),
               'FM999,999,999,999,990.00')          AS resolved_amount,
       TO_CHAR(ROUND(SUM(CASE WHEN c.code_combination_id IS NULL
                              THEN x.net ELSE 0 END), 2),
               'FM999,999,999,999,990.00')          AS unresolved_amount
FROM   (SELECT b.code_combination_id,
               NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0) AS net
        FROM   apps.gl_balances b
        WHERE  b.actual_flag = 'B') x
LEFT   JOIN apps.gl_code_combinations c
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
-- NOT WINDOWED, deliberately. Both sides of this comparison carry the same
-- filter or neither does. The budget side is a GL period measure and would
-- window cleanly, but the committed side is not: PO money accrues long after a
-- PO is created, so a CREATION_DATE cut drops POs that are still being billed.
-- Measured, the newest three fiscal years by creation date hold 548,258,765 of
-- 8,870,249,782 billed dollars - 6.2%. Windowing the budget side alone would
-- make every project read as overspent, and windowing both would read as
-- almost nothing spent. B1-B5 carry the window; this cross-check does not.
--
-- PO_DISTRIBUTIONS can be a large table. Run B6.0 first.
-- ============================================================================

-- B6.0 Size check before running the join.
SELECT COUNT(*)                                      AS distribution_rows,
       COUNT(DISTINCT p.code_combination_id)         AS distinct_combos,
       TO_CHAR(ROUND(SUM(NVL(p.encumbered_amount, 0)), 2),
               'FM999,999,999,999,990.00')           AS encumbered_total,
       TO_CHAR(ROUND(SUM(NVL(p.amount_billed, 0)), 2),
               'FM999,999,999,999,990.00')           AS billed_total
FROM   apps.po_distributions_all p;

-- B6.1 Budget vs committed per project.
-- NOTE: this assumes CODE_COMBINATION_ID is unique in GL_CODE_COMBINATIONS.
-- The sample extract showed 0 duplicates; if this one has duplicates the
-- dimension join below will fan out and the totals will be too high.
-- B6.2 checks it.
WITH budget AS (
  SELECT b.code_combination_id                       AS ccid,
         SUM(NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0)) AS budget_amt
  FROM   apps.gl_balances b
  WHERE  b.actual_flag = 'B'
  GROUP  BY b.code_combination_id
),
committed AS (
  SELECT p.code_combination_id                       AS ccid,
         SUM(NVL(p.encumbered_amount, 0))            AS encumbered_amt,
         SUM(NVL(p.amount_billed, 0))                AS billed_amt
  FROM   apps.po_distributions_all p
  GROUP  BY p.code_combination_id
)
SELECT NVL(d.segment5, '(no segment row)')                         AS project_level,
       NVL(d.segment2, '--')                                       AS purpose_code,
       COUNT(DISTINCT NVL(bd.ccid, cm.ccid))                       AS combo_count,
       TO_CHAR(ROUND(NVL(SUM(bd.budget_amt), 0), 2),
               'FM999,999,999,999,990.00')                         AS budget_total,
       TO_CHAR(ROUND(NVL(SUM(cm.encumbered_amt), 0), 2),
               'FM999,999,999,999,990.00')                         AS committed_total,
       TO_CHAR(ROUND(NVL(SUM(cm.billed_amt), 0), 2),
               'FM999,999,999,999,990.00')                         AS billed_total,
       TO_CHAR(ROUND(NVL(SUM(bd.budget_amt), 0)
                     - NVL(SUM(cm.encumbered_amt), 0), 2),
               'FM999,999,999,999,990.00')                         AS headroom
FROM   budget bd
FULL   OUTER JOIN committed cm
       ON cm.ccid = bd.ccid
/* One dimension join keyed on whichever side of the outer join exists.
   Joining the COA twice and coalescing the two segment columns would let a
   budget on an unmapped combination inherit the OTHER side's project - 
   attributing money to the wrong project rather than to none. */
LEFT   JOIN apps.gl_code_combinations d
       ON d.code_combination_id = NVL(bd.ccid, cm.ccid)
GROUP  BY NVL(d.segment5, '(no segment row)'), NVL(d.segment2, '--')
ORDER  BY NVL(SUM(bd.budget_amt), 0) DESC NULLS LAST;

-- B6.2 Guard for the assumption B6.1 makes.
-- Expect 0. Any row returned means CODE_COMBINATION_ID repeats, and B6.1's
-- totals must be read with that in mind.
SELECT c.code_combination_id, COUNT(*) AS row_count
FROM   apps.gl_code_combinations c
GROUP  BY c.code_combination_id
HAVING COUNT(*) > 1
ORDER  BY 2 DESC;
