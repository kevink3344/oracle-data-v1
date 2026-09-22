--------------------------------------------------------------------------------
-- 02-budget-adjustments.sql  |  Budget journals = the adjustment log
--------------------------------------------------------------------------------
-- READ-ONLY. Every statement is a SELECT. No INSERT/UPDATE/DELETE, no DDL.
--
-- PRECONDITION: 00-discover.sql section D returned rows with ACTUAL_FLAG='B'.
-- If budget journals do not exist, adjustments are only visible as period
-- movement on GL_BALANCES - use 03-budget-changes.sql C3 instead.
--
-- WHY JOURNALS ARE THE ADJUSTMENTS. Oracle does not edit a budget balance.
-- An adjustment is a posted budget journal: a document with a date, an amount,
-- a category and a description. So the set of journals with ACTUAL_FLAG='B'
-- IS the adjustment history. This is the one place the schema gives adjustment
-- data *with a document behind it*, rather than as an unexplained delta.
--
-- WHAT THIS CANNOT GIVE YOU. There is no approval trail, no reason code and no
-- explicit reversal linkage in this schema. You get the fact of an adjustment,
-- its date and its amount - not who approved it or why. That belongs in an
-- app-side audit table.
--
-- ----------------------------------------------------------------------------
-- REPORTING WINDOW: FY2025 - FY2027, the newest three fiscal years.
--
-- Every adjustment below is restricted to this window. Journals carry a
-- PERIOD_NAME, not a PERIOD_YEAR, so the window is applied through GL_PERIODS:
--
--     h.period_name IN (SELECT p.period_name
--                       FROM   apps.gl_periods p
--                       WHERE  p.period_year >= (SELECT MAX (period_year) - 2
--                                                FROM   apps.gl_periods))
--
-- Going through the numeric PERIOD_YEAR rather than matching on the string is
-- deliberate: PERIOD_NAME is text ('Jul-26-FY-27' on this instance) and sorts
-- wrongly as text, which is exactly how a string-based window goes wrong.
--
-- DERIVED, NEVER A LITERAL. MAX(PERIOD_YEAR) is the newest fiscal year the
-- ledger holds, so the floor moves with the ledger. A literal was tried before
-- ('period_year >= 2023', written when the newest year was FY2025) and by
-- FY2027 it had silently become a FIVE-year window. Confirm the floor with:
--
--     SELECT MAX (period_year) - 2 AS window_floor FROM apps.gl_periods;
--
-- Today:  floor 2025 -> FY2025, FY2026, FY2027 = 2024-07-01 .. 2027-06-30.
--
-- FY = fiscal year, Jul-Jun, 13 periods (12 months + an Adjust period).
--
-- A0 is NOT WINDOWED - it is the size check. A windowed size check reports the
-- window rather than the size, which defeats its only purpose.
-- ----------------------------------------------------------------------------


-- ============================================================================
-- A0. Size check before pulling detail.
--
-- NOT WINDOWED. period_min/period_max and created_min/created_max below report
-- the real span of the journal table, so you can see how much history the
-- window is excluding before you accept the exclusion. Expect period_min well
-- before FY2025 and period_max at or after it. Every query after this one is
-- windowed.
-- ============================================================================

SELECT h.actual_flag,
       DECODE(h.actual_flag,
              'A', 'Actual', 'B', 'BUDGET', 'E', 'Encumbrance', '(other)') AS balance_type,
       COUNT(DISTINCT h.je_header_id)               AS header_count,
       COUNT(l.je_header_id)                        AS line_count,
       MIN(h.period_name)                           AS period_min,
       MAX(h.period_name)                           AS period_max,
       MIN(h.date_created)                          AS created_min,
       MAX(h.date_created)                          AS created_max
FROM   apps.gl_je_headers h
LEFT   JOIN apps.gl_je_lines l ON l.je_header_id = h.je_header_id
GROUP  BY h.actual_flag
ORDER  BY h.actual_flag;


-- ============================================================================
-- A1. Adjustments by period and category - the shape of the history.
--
-- Tells us how many adjustment documents exist, when they were created, and
-- what they were categorised as. If `status` shows anything other than
-- 'P'/'POSTED' the budget includes unposted entries, which changes what the
-- approved figure means.
-- ============================================================================

SELECT h.period_name,
       h.je_category,
       h.je_source,
       h.status,
       COUNT(DISTINCT h.je_header_id)               AS journal_count,
       COUNT(l.je_header_id)                        AS line_count,
       MIN(h.date_created)                          AS first_created,
       MAX(h.date_created)                          AS last_created,
       TO_CHAR(ROUND(SUM(NVL(l.entered_dr, 0) - NVL(l.entered_cr, 0)), 2),
               'FM999,999,999,999,990.00')          AS net_amount
FROM   apps.gl_je_headers h
JOIN   apps.gl_je_lines l ON l.je_header_id = h.je_header_id
WHERE  h.actual_flag = 'B'
AND    h.period_name IN (SELECT p.period_name
                         FROM   apps.gl_periods p
                         WHERE  p.period_year >= (SELECT MAX (period_year) - 2
                                                  FROM   apps.gl_periods))
GROUP  BY h.period_name, h.je_category, h.je_source, h.status
ORDER  BY h.period_name, h.je_category;


-- ============================================================================
-- A2. The individual adjustments.
--
-- One row per journal line, most recent first, capped at 100. `account` is the
-- seven segments joined for readability - this is the same combination key the
-- rest of the app uses.
--
-- Rows with a blank or null `account` are combinations with no
-- GL_CODE_COMBINATIONS row. That is the coverage gap measured by
-- 01-budgets.sql B5.2; count them rather than ignoring them.
-- ============================================================================

SELECT * FROM (
  SELECT h.je_header_id,
         h.period_name,
         h.je_category,
         h.je_source,
         h.status,
         h.name                                        AS journal_name,
         h.description                                 AS journal_description,
         h.date_created,
         h.posted_date,
         h.encumbrance_type_id,
         l.je_line_num,
         l.effective_date,
         c.segment1 || '-' || c.segment2 || '-' || c.segment3 || '-' ||
         c.segment4 || '-' || c.segment5 || '-' || c.segment6 || '-' ||
         c.segment7                                    AS account,
         TO_CHAR(ROUND(NVL(l.entered_dr, 0), 2),
                 'FM999,999,999,999,990.00')           AS dr,
         TO_CHAR(ROUND(NVL(l.entered_cr, 0), 2),
                 'FM999,999,999,999,990.00')           AS cr,
         l.description                                 AS line_description
  FROM   apps.gl_je_headers h
  JOIN   apps.gl_je_lines l ON l.je_header_id = h.je_header_id
  LEFT   JOIN apps.gl_code_combinations c ON c.code_combination_id = l.code_combination_id
  WHERE  h.actual_flag = 'B'
  AND    h.period_name IN (SELECT p.period_name
                           FROM   apps.gl_periods p
                           WHERE  p.period_year >= (SELECT MAX (period_year) - 2
                                                    FROM   apps.gl_periods))
  ORDER  BY h.date_created DESC, h.je_header_id, l.je_line_num
) WHERE ROWNUM <= 100;


-- ============================================================================
-- A3. Adjustments per project and period.
--
-- The version of A2 the UI would actually consume: how much was added to or
-- removed from each project's budget, and in which period.
-- SEGMENT5 is the project, SEGMENT2 the Capital/Operating axis.
-- ============================================================================

SELECT c.segment5                                   AS project_level,
       c.segment2                                   AS purpose_code,
       h.period_name,
       h.je_category,
       COUNT(DISTINCT h.je_header_id)               AS journal_count,
       COUNT(*)                                     AS line_count,
       TO_CHAR(ROUND(SUM(NVL(l.entered_dr, 0) - NVL(l.entered_cr, 0)), 2),
               'FM999,999,999,999,990.00')          AS net_amount
FROM   apps.gl_je_headers h
JOIN   apps.gl_je_lines l ON l.je_header_id = h.je_header_id
LEFT   JOIN apps.gl_code_combinations c ON c.code_combination_id = l.code_combination_id
WHERE  h.actual_flag = 'B'
AND    h.period_name IN (SELECT p.period_name
                         FROM   apps.gl_periods p
                         WHERE  p.period_year >= (SELECT MAX (period_year) - 2
                                                  FROM   apps.gl_periods))
GROUP  BY c.segment5, c.segment2, h.period_name, h.je_category
ORDER  BY c.segment5, h.period_name;


-- ============================================================================
-- A4. Do adjustments increase budgets, decrease them, or both?
--
-- Net per journal, then classified. If there are no decreases, the budget is
-- append-only and the app only needs to show additions. If both appear, the
-- UI needs a signed amount and a direction, not just a running total.
-- ============================================================================

SELECT CASE WHEN net >  0 THEN 'increase (budget added)'
            WHEN net <  0 THEN 'decrease (budget removed)'
                          ELSE 'no movement' END    AS adjustment_direction,
       COUNT(*)                                     AS journal_count,
       TO_CHAR(ROUND(SUM(net), 2),
               'FM999,999,999,999,990.00')          AS total_amount,
       MIN(period_name)                             AS period_min,
       MAX(period_name)                             AS period_max
FROM   (SELECT h.je_header_id,
               h.period_name,
               SUM(NVL(l.entered_dr, 0) - NVL(l.entered_cr, 0)) AS net
        FROM   apps.gl_je_headers h
        JOIN   apps.gl_je_lines l ON l.je_header_id = h.je_header_id
        WHERE  h.actual_flag = 'B'
        AND    h.period_name IN (SELECT p.period_name
                                 FROM   apps.gl_periods p
                                 WHERE  p.period_year >=
                                        (SELECT MAX (period_year) - 2
                                         FROM   apps.gl_periods))
        GROUP  BY h.je_header_id, h.period_name) j
-- Ordered on the numeric sum, not the formatted alias: 'FM999,...' strings
-- sort lexically, so "1,000" would come before "900".
GROUP  BY CASE WHEN net >  0 THEN 'increase (budget added)'
               WHEN net <  0 THEN 'decrease (budget removed)'
                             ELSE 'no movement' END
ORDER  BY SUM(net) DESC;


-- ============================================================================
-- A5. Line attributes on budget journals.
--
-- LINE_TYPE_CODE separates the journal's balancing leg from its substance, and
-- INVOICE_IDENTIFIER should be null on a budget (a budget is not an invoice).
-- A non-null value here would mean the export mixes budget and invoice lines.
-- ============================================================================

SELECT l.line_type_code,
       l.status,
       COUNT(*)                                     AS line_count,
       COUNT(l.invoice_identifier)                  AS with_invoice_identifier,
       TO_CHAR(ROUND(SUM(NVL(l.entered_dr, 0)), 2),
               'FM999,999,999,999,990.00')          AS total_dr,
       TO_CHAR(ROUND(SUM(NVL(l.entered_cr, 0)), 2),
               'FM999,999,999,999,990.00')          AS total_cr
FROM   apps.gl_je_lines l
JOIN   apps.gl_je_headers h ON h.je_header_id = l.je_header_id
WHERE  h.actual_flag = 'B'
AND    h.period_name IN (SELECT p.period_name
                         FROM   apps.gl_periods p
                         WHERE  p.period_year >= (SELECT MAX (period_year) - 2
                                                  FROM   apps.gl_periods))
GROUP  BY l.line_type_code, l.status
ORDER  BY 3 DESC;

-- A5.2 Do the budget journals balance? Dr minus Cr should be 0 per document.
-- Expect no rows. Any row returned is a document that does not balance, which
-- would mean the export is partial.
SELECT h.je_header_id,
       h.period_name,
       h.status,
       TO_CHAR(ROUND(SUM(NVL(l.entered_dr, 0) - NVL(l.entered_cr, 0)), 2),
               'FM999,999,999,999,990.00')          AS imbalance
FROM   apps.gl_je_headers h
JOIN   apps.gl_je_lines l ON l.je_header_id = h.je_header_id
WHERE  h.actual_flag = 'B'
AND    h.period_name IN (SELECT p.period_name
                         FROM   apps.gl_periods p
                         WHERE  p.period_year >= (SELECT MAX (period_year) - 2
                                                  FROM   apps.gl_periods))
GROUP  BY h.je_header_id, h.period_name, h.status
HAVING ABS(SUM(NVL(l.entered_dr, 0) - NVL(l.entered_cr, 0))) > 0.005
ORDER  BY ABS(SUM(NVL(l.entered_dr, 0) - NVL(l.entered_cr, 0))) DESC;


-- ============================================================================
-- A6. Reconcile journals against the balance table.
--
-- The sum of budget journals should equal the sum of budget period movement:
-- both are the same money seen two ways. If they disagree, one of them is
-- incomplete - and knowing which is the whole point of running both files.
--
-- BOTH legs are windowed to the same range, which is what keeps the comparison
-- meaningful: an all-time journal total against a windowed balance total would
-- disagree by exactly the excluded history and tell you nothing.
-- ============================================================================

SELECT 'GL_BALANCES  (ACTUAL_FLAG=B, period movement)' AS source,
       TO_CHAR(ROUND(SUM(NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0)), 2),
               'FM999,999,999,999,990.00')          AS amount
FROM   apps.gl_balances b
WHERE  b.actual_flag = 'B'
AND    b.period_year >= (SELECT MAX (period_year) - 2 FROM apps.gl_periods)
UNION ALL
SELECT 'GL_JE_LINES   (ACTUAL_FLAG=B journals)      ' AS source,
       TO_CHAR(ROUND(SUM(NVL(l.entered_dr, 0) - NVL(l.entered_cr, 0)), 2),
               'FM999,999,999,999,990.00')          AS amount
FROM   apps.gl_je_lines l
JOIN   apps.gl_je_headers h ON h.je_header_id = l.je_header_id
WHERE  h.actual_flag = 'B'
AND    h.period_name IN (SELECT p.period_name
                         FROM   apps.gl_periods p
                         WHERE  p.period_year >= (SELECT MAX (period_year) - 2
                                                  FROM   apps.gl_periods));
