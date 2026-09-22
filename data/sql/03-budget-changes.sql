--------------------------------------------------------------------------------
-- 03-budget-changes.sql  |  How the budget moved
--------------------------------------------------------------------------------
-- READ-ONLY. Every statement is a SELECT. No INSERT/UPDATE/DELETE, no DDL.
--
-- "Budget change" has three possible meanings in Oracle, and all three are
-- reachable from this schema. Each gets its own section below:
--
--   C1/C2  version-to-version   - what differs between the adopted budget and
--                                 a later revision (needs >1 BUDGET_VERSION_ID)
--   C3     period-to-period     - the budget as it stood after each period
--   C4     combination-level    - which specific accounts moved, not just the
--                                 project total
--
-- Prefer C1 when 00-discover.sql C showed several versions. Prefer C3 when it
-- showed one - a single-version budget has no version diff, but it still has a
-- timeline.
--
-- ----------------------------------------------------------------------------
-- REPORTING WINDOW: FY2025 - FY2027, the newest three fiscal years.
--
-- Every change below is measured INSIDE this window. The predicate is:
--
--     period_year >= (SELECT MAX (period_year) - 2 FROM apps.gl_periods)
--
-- DERIVED, NEVER A LITERAL. MAX(PERIOD_YEAR) is the newest fiscal year the
-- ledger holds, so the floor moves with the ledger. A literal was tried before
-- ('period_year >= 2023', written when the newest year was FY2025) and by
-- FY2027 it had silently become a FIVE-year window over 46,013,161 rows.
--
-- This file had a SECOND hard-coded year, in C5: `period_name LIKE '%-25'`.
-- On this instance PERIOD_NAME is 'Jul-26-FY-27', so that LIKE matched nothing
-- and C5 returned zero in every year column. C5 now derives its columns from
-- the window instead.
--
-- Today:  floor 2025 -> FY2025, FY2026, FY2027 = 2024-07-01 .. 2027-06-30.
--
-- WHAT THE WINDOW COSTS THIS FILE. C1/C2 compare two BUDGET_VERSION_IDs. Those
-- are version-to-version snapshots, so both sides are drawn from the same
-- window and the comparison stays valid - but a budget carried over from a
-- version that only posted before FY2025 will balance to zero on both sides
-- and drop out of the diff. A project listed in 01-budgets.sql B4 but absent
-- from C2 is that case, not an error.
--
-- FY = fiscal year, Jul-Jun, 13 periods (12 months + an Adjust period).
-- ----------------------------------------------------------------------------


-- ============================================================================
-- C1. Version-to-version change, automatic lowest-vs-highest.
--
-- Self-contained: it picks the smallest and largest BUDGET_VERSION_ID itself,
-- so nothing needs to be filled in. Prints the two ids it used so you can see
-- which versions were compared - and so you can re-run C2 for a specific pair.
--
-- LIMITATION: if there are three or more versions, only the extremes are shown
-- and the middle ones are invisible. Check 00-discover.sql C; if it listed more
-- than two versions, use C2 as well.
-- ============================================================================

WITH v AS (
  SELECT MIN(b.budget_version_id) AS vmin,
         MAX(b.budget_version_id) AS vmax
  FROM   apps.gl_balances b
  WHERE  b.actual_flag = 'B'
  AND    b.period_year >= (SELECT MAX (period_year) - 2 FROM apps.gl_periods)
)
SELECT v.vmin                                        AS version_low,
       v.vmax                                        AS version_high,
       c.segment5                                    AS project_level,
       c.segment2                                    AS purpose_code,
       TO_CHAR(ROUND(SUM(CASE WHEN b.budget_version_id = v.vmin
                              THEN NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0)
                              ELSE 0 END), 2),
               'FM999,999,999,999,990.00')           AS amount_version_low,
       TO_CHAR(ROUND(SUM(CASE WHEN b.budget_version_id = v.vmax
                              THEN NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0)
                              ELSE 0 END), 2),
               'FM999,999,999,999,990.00')           AS amount_version_high,
       TO_CHAR(ROUND(SUM(CASE WHEN b.budget_version_id = v.vmax
                              THEN NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0)
                              ELSE 0 END)
                   - SUM(CASE WHEN b.budget_version_id = v.vmin
                              THEN NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0)
                              ELSE 0 END), 2),
               'FM999,999,999,999,990.00')           AS change_amount
FROM   apps.gl_balances b
JOIN   apps.gl_code_combinations c ON c.code_combination_id = b.code_combination_id
CROSS  JOIN v
WHERE  b.actual_flag = 'B'
AND    b.period_year >= (SELECT MAX (period_year) - 2 FROM apps.gl_periods)
AND    c.summary_flag = 'N'
GROUP  BY v.vmin, v.vmax, c.segment5, c.segment2
ORDER  BY SUM(CASE WHEN b.budget_version_id = v.vmax
                   THEN NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0)
                   ELSE 0 END)
        - SUM(CASE WHEN b.budget_version_id = v.vmin
                   THEN NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0)
                   ELSE 0 END) DESC;


-- ============================================================================
-- C2. Version-to-version change at ACCOUNT level.
--
-- The same comparison as C1 but drilled to the individual account rather than
-- the project total - this is the version an export or a change report needs,
-- because a project total can be unchanged while accounts inside it moved.
--
-- Self-contained: it picks the lowest and highest version itself, so there is
-- nothing to type in and no client-specific substitution syntax.
--
-- With only one version every difference is zero and this returns no rows -
-- a correct result, not a failure. Use C3 in that case.
-- Capped at the 200 largest changes.
-- ============================================================================

WITH versions AS (
  SELECT b.budget_version_id,
         ROW_NUMBER() OVER (ORDER BY b.budget_version_id)      AS ver_rank,
         COUNT(*)     OVER ()                                  AS ver_count
  FROM   (SELECT DISTINCT b.budget_version_id
          FROM   apps.gl_balances b
          WHERE  b.actual_flag = 'B'
          AND    b.period_year >=
                 (SELECT MAX (period_year) - 2 FROM apps.gl_periods)) b
),
bounds AS (
  SELECT MAX(CASE WHEN ver_rank = 1         THEN budget_version_id END) AS version_low,
         MAX(CASE WHEN ver_rank = ver_count THEN budget_version_id END) AS version_high
  FROM   versions
)
SELECT * FROM (
  SELECT * FROM (
    SELECT w.version_low,
           w.version_high,
           c.segment5                                          AS project_level,
           c.segment2                                          AS purpose_code,
           c.segment4                                          AS object_code,
           c.segment1 || '-' || c.segment2 || '-' || c.segment3 || '-' ||
           c.segment4 || '-' || c.segment5 || '-' || c.segment6 || '-' ||
           c.segment7                                          AS account,
           TO_CHAR(ROUND(SUM(CASE WHEN b.budget_version_id = w.version_low
                                  THEN NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0)
                                  ELSE 0 END), 2),
                   'FM999,999,999,999,990.00')                 AS amount_old,
           TO_CHAR(ROUND(SUM(CASE WHEN b.budget_version_id = w.version_high
                                  THEN NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0)
                                  ELSE 0 END), 2),
                   'FM999,999,999,999,990.00')                 AS amount_new,
           SUM(CASE WHEN b.budget_version_id = w.version_high
                    THEN NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0)
                    ELSE 0 END)
         - SUM(CASE WHEN b.budget_version_id = w.version_low
                    THEN NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0)
                    ELSE 0 END)                                    AS change_num
    FROM   apps.gl_balances b
    JOIN   apps.gl_code_combinations c ON c.code_combination_id = b.code_combination_id
    CROSS  JOIN bounds w
    WHERE  b.actual_flag = 'B'
    AND    b.period_year >= (SELECT MAX (period_year) - 2 FROM apps.gl_periods)
    AND    c.summary_flag = 'N'
    GROUP  BY w.version_low, w.version_high, c.segment5, c.segment2, c.segment4,
              c.segment1 || '-' || c.segment2 || '-' || c.segment3 || '-' ||
              c.segment4 || '-' || c.segment5 || '-' || c.segment6 || '-' ||
              c.segment7
  ) WHERE ABS(change_num) > 0.005
  ORDER  BY change_num DESC
) WHERE ROWNUM <= 200;


-- ============================================================================
-- C3. The budget as it stood, period by period.
--
-- Works even with a single budget version, which is why it is worth running
-- regardless. Each row is the cumulative budget after that period closed, so
-- the series itself is the change history - and `moved_in_period` shows which
-- months were actually adjusted. Months that are all zero are periods where
-- nothing changed.
--
-- WINDOWED, so `budget_running_total` is cumulative WITHIN the window: it
-- starts at zero in the first period of FY2025 and ignores everything before
-- it. For the true position, including the years the window drops, use
-- 01-budgets.sql B1's `budget_as_of_period_end` - BEGIN_BALANCE_DR/CR carries
-- the earlier years forward, which is why that query can do it and this one
-- cannot.
-- ============================================================================

SELECT b.period_year,
       LPAD(b.period_num, 2, '0')                    AS period_no,
       b.period_name,
       TO_CHAR(ROUND(movement, 2),
               'FM999,999,999,999,990.00')           AS moved_in_period,
       TO_CHAR(ROUND(SUM(movement) OVER (ORDER BY b.period_year, b.period_num
                                         ROWS BETWEEN UNBOUNDED PRECEDING
                                                  AND CURRENT ROW), 2),
               'FM999,999,999,999,990.00')           AS budget_running_total
FROM   (SELECT b.period_year,
               b.period_num,
               b.period_name,
               SUM(NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0)) AS movement
        FROM   apps.gl_balances b
        WHERE  b.actual_flag = 'B'
        AND    b.period_year >= (SELECT MAX (period_year) - 2 FROM apps.gl_periods)
        GROUP  BY b.period_year, b.period_num, b.period_name) b
ORDER  BY b.period_year, b.period_num;


-- ============================================================================
-- C4. Which combinations moved, between consecutive periods.
--
-- The account-level change feed. C3 answers "when did the budget change",
-- this answers "and on what". Uses LAG over the running balance per
-- combination, so each row is one account's movement in one period.
-- Capped at 200 rows, largest movement first - remove the cap for everything.
-- ============================================================================

SELECT * FROM (
  SELECT c.segment5                                  AS project_level,
         c.segment2                                  AS purpose_code,
         c.segment4                                  AS object_code,
         c.segment1 || '-' || c.segment2 || '-' || c.segment3 || '-' ||
         c.segment4 || '-' || c.segment5 || '-' || c.segment6 || '-' ||
         c.segment7                                  AS account,
         b.period_year,
         LPAD(b.period_num, 2, '0')                  AS period_no,
         b.period_name,
         TO_CHAR(ROUND(NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0), 2),
                 'FM999,999,999,999,990.00')         AS moved_in_period
  FROM   apps.gl_balances b
  JOIN   apps.gl_code_combinations c ON c.code_combination_id = b.code_combination_id
  WHERE  b.actual_flag = 'B'
  AND    b.period_year >= (SELECT MAX (period_year) - 2 FROM apps.gl_periods)
  AND    c.summary_flag = 'N'
  AND    ABS(NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0)) > 0.005
  ORDER  BY ABS(NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0)) DESC
) WHERE ROWNUM <= 200;


-- ============================================================================
-- C5. Budget per project per FISCAL YEAR inside the window.
--
-- The same information as C3 in wide form: one row per project, one column per
-- fiscal year of the reporting window, so a project's year-to-year shape is
-- visible at a glance. Capped at 25 projects.
--
-- The year columns are DERIVED from the window, not hard-coded. The previous
-- version used `period_name LIKE '%-25'`, which was wrong twice over: it named
-- two fixed calendar years, and on this instance PERIOD_NAME is
-- 'Jul-26-FY-27' rather than 'JUN-26', so the LIKE matched nothing and every
-- column came back zero. If a column here is all zero now, that means the
-- fiscal year genuinely holds no budget - run 01-budgets.sql B1 to confirm.
--
-- Today: fy_oldest = FY2025, fy_middle = FY2026, fy_newest = FY2027.
-- ============================================================================

SELECT * FROM (
  SELECT c.segment5                                  AS project_level,
         SUM(CASE WHEN b.period_year = w.fy_oldest THEN
             NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0) ELSE 0 END)
                                                     AS fy_oldest_budget,
         SUM(CASE WHEN b.period_year = w.fy_middle THEN
             NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0) ELSE 0 END)
                                                     AS fy_middle_budget,
         SUM(CASE WHEN b.period_year = w.fy_newest THEN
             NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0) ELSE 0 END)
                                                     AS fy_newest_budget,
         SUM(NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0))
                                                     AS window_total
  FROM   apps.gl_balances b
  JOIN   apps.gl_code_combinations c ON c.code_combination_id = b.code_combination_id
  CROSS  JOIN (SELECT MAX (period_year) - 2 AS fy_oldest,
                      MAX (period_year) - 1 AS fy_middle,
                      MAX (period_year)     AS fy_newest
               FROM   apps.gl_periods) w
  WHERE  b.actual_flag = 'B'
  AND    b.period_year >= (SELECT MAX (period_year) - 2 FROM apps.gl_periods)
  AND    c.summary_flag = 'N'
  GROUP  BY c.segment5
  ORDER  BY window_total DESC
) WHERE ROWNUM <= 25;
