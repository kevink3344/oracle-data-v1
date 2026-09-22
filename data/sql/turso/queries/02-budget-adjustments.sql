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
--------------------------------------------------------------------------------

-- ============================================================================
-- PORT NOTES - SQLite / libSQL dialect.
--
-- Added by the port. The Oracle comments above and below are kept VERBATIM,
-- including every section label (A0..A6) and every "Expect" assertion,
-- because other documents cross-reference them.
--
--   1. `apps.` object prefix DROPPED - this surrogate is a single schema, so
--      every name resolves unprefixed. The base-table names carried here are
--      the same ones the Oracle original uses.
--   2. NVL(a,b) -> COALESCE(a,b).
--   3. DECODE(x, k1,v1, k2,v2, k3,v3, default) -> CASE x WHEN ... END.
--      A0 carries one, on ACTUAL_FLAG.
--   4. TO_CHAR(<num>, 'FM999,999,999,999,990.00') -> printf('%.2f', ROUND(<num>,2)).
--      THE THOUSANDS SEPARATOR CANNOT BE REPRODUCED: SQLite's printf has no
--      grouping flag. This is the single place the port is visibly not 1:1 in
--      its OUTPUT - amounts print ungrouped ("4356078.25", not "4,356,078.25").
--      The two-decimal rounding is preserved exactly.
--   5. WHERE ROWNUM <= 100 (A2) -> LIMIT 100. Oracle applies ROWNUM to the
--      enclosing query, so it names a specific 100 rows only because the inline
--      view it wraps is ordered - here by date_created DESC, then je_header_id,
--      then je_line_num. LIMIT 100 is therefore the same 100 rows: the 100 most
--      recent budget journal lines.
--   6. A4's outer query groups by a CASE expression and orders by SUM(net). The
--      alias `net` is a real column of the derived table `j` in both dialects,
--      so nothing about the shape had to change. The original's comment about
--      ordering on the numeric sum rather than the formatted alias still holds
--      and is retained.
-- ============================================================================


-- ============================================================================
-- A0. Size check before pulling detail.
-- ============================================================================

SELECT h.actual_flag,
       CASE h.actual_flag
         WHEN 'A' THEN 'Actual'
         WHEN 'B' THEN 'BUDGET'
         WHEN 'E' THEN 'Encumbrance'
         ELSE '(other)'
       END                                          AS balance_type,
       COUNT(DISTINCT h.je_header_id)               AS header_count,
       COUNT(l.je_header_id)                        AS line_count,
       MIN(h.period_name)                           AS period_min,
       MAX(h.period_name)                           AS period_max,
       MIN(h.date_created)                          AS created_min,
       MAX(h.date_created)                          AS created_max
FROM   gl_je_headers h
LEFT   JOIN gl_je_lines l ON l.je_header_id = h.je_header_id
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
       printf('%.2f', ROUND(SUM(COALESCE(l.entered_dr, 0) - COALESCE(l.entered_cr, 0)), 2))
                                                    AS net_amount
FROM   gl_je_headers h
JOIN   gl_je_lines l ON l.je_header_id = h.je_header_id
WHERE  h.actual_flag = 'B'
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
         printf('%.2f', ROUND(COALESCE(l.entered_dr, 0), 2))
                                                       AS dr,
         printf('%.2f', ROUND(COALESCE(l.entered_cr, 0), 2))
                                                       AS cr,
         l.description                                 AS line_description
  FROM   gl_je_headers h
  JOIN   gl_je_lines l ON l.je_header_id = h.je_header_id
  LEFT   JOIN gl_code_combinations c ON c.code_combination_id = l.code_combination_id
  WHERE  h.actual_flag = 'B'
  -- PORT: ROWNUM is gone, so this ORDER BY is now what fixes the row order of
  -- the LIMIT 100 below. Same ordering the original relied on.
  ORDER  BY h.date_created DESC, h.je_header_id, l.je_line_num
) LIMIT 100;


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
       printf('%.2f', ROUND(SUM(COALESCE(l.entered_dr, 0) - COALESCE(l.entered_cr, 0)), 2))
                                                    AS net_amount
FROM   gl_je_headers h
JOIN   gl_je_lines l ON l.je_header_id = h.je_header_id
LEFT   JOIN gl_code_combinations c ON c.code_combination_id = l.code_combination_id
WHERE  h.actual_flag = 'B'
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
       printf('%.2f', ROUND(SUM(net), 2))
                                                    AS total_amount,
       MIN(period_name)                             AS period_min,
       MAX(period_name)                             AS period_max
FROM   (SELECT h.je_header_id,
               h.period_name,
               SUM(COALESCE(l.entered_dr, 0) - COALESCE(l.entered_cr, 0)) AS net
        FROM   gl_je_headers h
        JOIN   gl_je_lines l ON l.je_header_id = h.je_header_id
        WHERE  h.actual_flag = 'B'
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
       printf('%.2f', ROUND(SUM(COALESCE(l.entered_dr, 0)), 2))
                                                    AS total_dr,
       printf('%.2f', ROUND(SUM(COALESCE(l.entered_cr, 0)), 2))
                                                    AS total_cr
FROM   gl_je_lines l
JOIN   gl_je_headers h ON h.je_header_id = l.je_header_id
WHERE  h.actual_flag = 'B'
GROUP  BY l.line_type_code, l.status
ORDER  BY 3 DESC;

-- A5.2 Do the budget journals balance? Dr minus Cr should be 0 per document.
-- Expect no rows. Any row returned is a document that does not balance, which
-- would mean the export is partial.
SELECT h.je_header_id,
       h.period_name,
       h.status,
       printf('%.2f', ROUND(SUM(COALESCE(l.entered_dr, 0) - COALESCE(l.entered_cr, 0)), 2))
                                                    AS imbalance
FROM   gl_je_headers h
JOIN   gl_je_lines l ON l.je_header_id = h.je_header_id
WHERE  h.actual_flag = 'B'
GROUP  BY h.je_header_id, h.period_name, h.status
HAVING ABS(SUM(COALESCE(l.entered_dr, 0) - COALESCE(l.entered_cr, 0))) > 0.005
ORDER  BY ABS(SUM(COALESCE(l.entered_dr, 0) - COALESCE(l.entered_cr, 0))) DESC;


-- ============================================================================
-- A6. Reconcile journals against the balance table.
--
-- The sum of budget journals should equal the sum of budget period movement:
-- both are the same money seen two ways. If they disagree, one of them is
-- incomplete - and knowing which is the whole point of running both files.
-- ============================================================================

SELECT 'GL_BALANCES  (ACTUAL_FLAG=B, period movement)' AS source,
       printf('%.2f', ROUND(SUM(COALESCE(b.period_net_dr, 0) - COALESCE(b.period_net_cr, 0)), 2))
                                                    AS amount
FROM   gl_balances b
WHERE  b.actual_flag = 'B'
UNION ALL
SELECT 'GL_JE_LINES   (ACTUAL_FLAG=B journals)      ' AS source,
       printf('%.2f', ROUND(SUM(COALESCE(l.entered_dr, 0) - COALESCE(l.entered_cr, 0)), 2))
                                                    AS amount
FROM   gl_je_lines l
JOIN   gl_je_headers h ON h.je_header_id = l.je_header_id
WHERE  h.actual_flag = 'B';
