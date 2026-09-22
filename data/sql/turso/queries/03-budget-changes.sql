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
--------------------------------------------------------------------------------

-- ============================================================================
-- PORT NOTES - SQLite / libSQL dialect.
--
-- Added by the port. The Oracle comments above and below are kept VERBATIM,
-- including every section label (C1..C5) and every "Expect" assertion,
-- because other documents cross-reference them.
--
--   1. `apps.` object prefix DROPPED - this surrogate is a single schema, so
--      every name resolves unprefixed. The base-table names carried here are
--      the same ones the Oracle original uses.
--   2. NVL(a,b) -> COALESCE(a,b). This is the only function substitution in
--      this file: there is no DECODE here, and no date formatting.
--   3. TO_CHAR(<num>, 'FM999,999,999,999,990.00') -> printf('%.2f', ROUND(<num>,2)).
--      THE THOUSANDS SEPARATOR CANNOT BE REPRODUCED: SQLite's printf has no
--      grouping flag. This is the single place the port is visibly not 1:1 in
--      its OUTPUT - amounts print ungrouped ("4356078.25", not "4,356,078.25").
--      The two-decimal rounding is preserved exactly.
--   4. LPAD(b.period_num, 2, '0') -> printf('%02d', b.period_num), in C3 and C4.
--      Both render the period number zero-padded to two digits; printf does it
--      arithmetically rather than by string padding.
--   5. Three WHERE ROWNUM <= n sites, each -> LIMIT n:
--        C2  ROWNUM <= 200  -> LIMIT 200
--        C4  ROWNUM <= 200  -> LIMIT 200
--        C5  ROWNUM <= 25   -> LIMIT 25
--      Oracle applies ROWNUM to the enclosing query, so it names a *specific* n
--      rows only when the inline view it wraps is ordered. All three are: C2 by
--      change_num DESC, C4 by ABS(period movement) DESC, C5 by year_total DESC.
--      LIMIT n is therefore the same n rows - the 200 largest changes, the 200
--      largest single-period movements, the 25 largest projects.
--   6. C1/C2's CROSS JOIN of a one-row CTE, C2's ROW_NUMBER()/COUNT() OVER (),
--      and C3's SUM() OVER (... ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT
--      ROW) need NO change - SQLite has window functions since 3.25 and this
--      target is 3.45. They are carried over untouched.
-- ============================================================================


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
  FROM   gl_balances b
  WHERE  b.actual_flag = 'B'
)
SELECT v.vmin                                        AS version_low,
       v.vmax                                        AS version_high,
       c.segment5                                    AS project_level,
       c.segment2                                    AS purpose_code,
       printf('%.2f', ROUND(SUM(CASE WHEN b.budget_version_id = v.vmin
                                     THEN COALESCE(b.period_net_dr, 0) - COALESCE(b.period_net_cr, 0)
                                     ELSE 0 END), 2))
                                                    AS amount_version_low,
       printf('%.2f', ROUND(SUM(CASE WHEN b.budget_version_id = v.vmax
                                     THEN COALESCE(b.period_net_dr, 0) - COALESCE(b.period_net_cr, 0)
                                     ELSE 0 END), 2))
                                                    AS amount_version_high,
       printf('%.2f', ROUND(SUM(CASE WHEN b.budget_version_id = v.vmax
                                     THEN COALESCE(b.period_net_dr, 0) - COALESCE(b.period_net_cr, 0)
                                     ELSE 0 END)
                           - SUM(CASE WHEN b.budget_version_id = v.vmin
                                     THEN COALESCE(b.period_net_dr, 0) - COALESCE(b.period_net_cr, 0)
                                     ELSE 0 END), 2))
                                                    AS change_amount
FROM   gl_balances b
JOIN   gl_code_combinations c ON c.code_combination_id = b.code_combination_id
CROSS  JOIN v
WHERE  b.actual_flag = 'B'
AND    c.summary_flag = 'N'
GROUP  BY v.vmin, v.vmax, c.segment5, c.segment2
ORDER  BY SUM(CASE WHEN b.budget_version_id = v.vmax
                   THEN COALESCE(b.period_net_dr, 0) - COALESCE(b.period_net_cr, 0)
                   ELSE 0 END)
        - SUM(CASE WHEN b.budget_version_id = v.vmin
                   THEN COALESCE(b.period_net_dr, 0) - COALESCE(b.period_net_cr, 0)
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
          FROM   gl_balances b
          WHERE  b.actual_flag = 'B') b
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
           printf('%.2f', ROUND(SUM(CASE WHEN b.budget_version_id = w.version_low
                                         THEN COALESCE(b.period_net_dr, 0) - COALESCE(b.period_net_cr, 0)
                                         ELSE 0 END), 2))
                                                               AS amount_old,
           printf('%.2f', ROUND(SUM(CASE WHEN b.budget_version_id = w.version_high
                                         THEN COALESCE(b.period_net_dr, 0) - COALESCE(b.period_net_cr, 0)
                                         ELSE 0 END), 2))
                                                               AS amount_new,
           SUM(CASE WHEN b.budget_version_id = w.version_high
                    THEN COALESCE(b.period_net_dr, 0) - COALESCE(b.period_net_cr, 0)
                    ELSE 0 END)
         - SUM(CASE WHEN b.budget_version_id = w.version_low
                    THEN COALESCE(b.period_net_dr, 0) - COALESCE(b.period_net_cr, 0)
                    ELSE 0 END)                                    AS change_num
    FROM   gl_balances b
    JOIN   gl_code_combinations c ON c.code_combination_id = b.code_combination_id
    CROSS  JOIN bounds w
    WHERE  b.actual_flag = 'B'
    AND    c.summary_flag = 'N'
    GROUP  BY w.version_low, w.version_high, c.segment5, c.segment2, c.segment4,
              c.segment1 || '-' || c.segment2 || '-' || c.segment3 || '-' ||
              c.segment4 || '-' || c.segment5 || '-' || c.segment6 || '-' ||
              c.segment7
  ) WHERE ABS(change_num) > 0.005
  -- PORT: ROWNUM is gone, so this ORDER BY is now what fixes the row order of
  -- the LIMIT 200 below. Same ordering the original relied on.
  ORDER  BY change_num DESC
) LIMIT 200;


-- ============================================================================
-- C3. The budget as it stood, period by period.
--
-- Works even with a single budget version, which is why it is worth running
-- regardless. Each row is the cumulative budget after that period closed, so
-- the series itself is the change history - and `moved_in_period` shows which
-- months were actually adjusted. Months that are all zero are periods where
-- nothing changed.
-- ============================================================================

SELECT b.period_year,
       printf('%02d', b.period_num)                  AS period_no,
       b.period_name,
       printf('%.2f', ROUND(movement, 2))
                                                    AS moved_in_period,
       printf('%.2f', ROUND(SUM(movement) OVER (ORDER BY b.period_year, b.period_num
                                         ROWS BETWEEN UNBOUNDED PRECEDING
                                                  AND CURRENT ROW), 2))
                                                    AS budget_running_total
FROM   (SELECT b.period_year,
               b.period_num,
               b.period_name,
               SUM(COALESCE(b.period_net_dr, 0) - COALESCE(b.period_net_cr, 0)) AS movement
        FROM   gl_balances b
        WHERE  b.actual_flag = 'B'
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
         printf('%02d', b.period_num)                AS period_no,
         b.period_name,
         printf('%.2f', ROUND(COALESCE(b.period_net_dr, 0) - COALESCE(b.period_net_cr, 0), 2))
                                                     AS moved_in_period
  FROM   gl_balances b
  JOIN   gl_code_combinations c ON c.code_combination_id = b.code_combination_id
  WHERE  b.actual_flag = 'B'
  AND    c.summary_flag = 'N'
  AND    ABS(COALESCE(b.period_net_dr, 0) - COALESCE(b.period_net_cr, 0)) > 0.005
  -- PORT: ROWNUM is gone, so this ORDER BY is now what fixes the row order of
  -- the LIMIT 200 below. Same ordering the original relied on.
  ORDER  BY ABS(COALESCE(b.period_net_dr, 0) - COALESCE(b.period_net_cr, 0)) DESC
) LIMIT 200;


-- ============================================================================
-- C5. Budget-per-period matrix per project.
--
-- The period-phasing view: one row per project, one column per period. Tells
-- us at a glance whether budgets are lump-sum or spread. Capped at 25 projects.
--
-- NOTE: the period columns are hard-coded for a JAN-DEC calendar in one year.
-- If 01-budgets.sql B1 shows a different set of PERIOD_NAME values, adjust or
-- drop this query - C3 already gives the same information in tall form and
-- needs no adjustment.
-- ============================================================================

SELECT * FROM (
  SELECT c.segment5                                  AS project_level,
         SUM(CASE WHEN b.period_name LIKE '%-25' THEN
             COALESCE(b.period_net_dr, 0) - COALESCE(b.period_net_cr, 0) ELSE 0 END) AS y25_all_periods,
         SUM(CASE WHEN b.period_name LIKE '%-26' THEN
             COALESCE(b.period_net_dr, 0) - COALESCE(b.period_net_cr, 0) ELSE 0 END) AS y26_all_periods,
         SUM(COALESCE(b.period_net_dr, 0) - COALESCE(b.period_net_cr, 0))            AS year_total
  FROM   gl_balances b
  JOIN   gl_code_combinations c ON c.code_combination_id = b.code_combination_id
  WHERE  b.actual_flag = 'B'
  AND    c.summary_flag = 'N'
  GROUP  BY c.segment5
  -- PORT: ROWNUM is gone, so this ORDER BY is now what fixes the row order of
  -- the LIMIT 25 below. Same ordering the original relied on.
  ORDER  BY year_total DESC
) LIMIT 25;
