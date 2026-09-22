--------------------------------------------------------------------------------
-- 04-spend-and-actuals.sql  |  Does "committed" actually mean "spent"?
--------------------------------------------------------------------------------
-- READ-ONLY. Every statement is a SELECT. No INSERT/UPDATE/DELETE, no DDL.
--
-- INDEPENDENT OF THE OTHER FILES - run it any time, whether or not budgets exist.
--
-- WHY THIS MATTERS. The app currently shows users this warning:
--
--   "Committed is not spent. This extract carries purchase-order commitments
--    only. Oracle supplies no invoice or payment figure, so no spend
--    percentage is shown on this screen."
--
-- The first half is sound. The second half is a claim about Oracle, and the
-- base tables contradict it. AP_INVOICES_ALL carries INVOICE_AMOUNT,
-- AMOUNT_PAID and PAYMENT_STATUS_FLAG; PO_DISTRIBUTIONS_ALL carries
-- AMOUNT_BILLED alongside ENCUMBERED_AMOUNT; AP_INVOICE_PAYMENTS_ALL carries
-- PAYMENT_DATE and AMOUNT. This file finds out whether those tables hold
-- anything.
--
-- If they do, that notice has to be rewritten - and a real spend figure becomes
-- available, which is a larger feature than the budget question.
--
-- ----------------------------------------------------------------------------
-- REPORTING WINDOW: FY2025 - FY2027 - APPLIED TO THE GL QUERIES ONLY.
--
-- S5, S6 and the budget leg of S7.2 read GL_BALANCES and carry the window:
--
--     period_year >= (SELECT MAX (period_year) - 2 FROM apps.gl_periods)
--
-- It is DERIVED from the ledger, never a literal, so it cannot go stale the way
-- 'period_year >= 2023' did. Today the floor is 2025: FY2025, FY2026, FY2027,
-- 2024-07-01 .. 2027-06-30.
--
-- THE PO AND AP QUERIES DO NOT CARRY IT. S0, S1-S4 and S7 are deliberately
-- all-time, and the reason is measured rather than a preference:
--
--   * A GL balance has a PERIOD_YEAR, so a window there narrows a time series.
--   * A PO has no period. Money accrues against it long after it is created.
--     Of the 8,870,249,782 billed dollars in PO_DISTRIBUTIONS_ALL, only
--     548,258,765 - 6.2% - sit on POs created inside the window. Of the same
--     table by CREATION_DATE the newest three fiscal years hold 4.3% of rows.
--     A CREATION_DATE cut would report that almost nothing has been spent.
--   * AP_INVOICE_PAYMENTS_ALL is the same: payment date is not the period the
--     money belongs to.
--
-- So this file answers "does committed mean spent?" over the whole ledger, and
-- answers "where does the budget stand?" over the window. S0 is NOT WINDOWED
-- for the same reason: it is the size check, and a windowed size check reports
-- the window rather than the size.
-- ----------------------------------------------------------------------------
--
-- ----------------------------------------------------------------------------
-- *** THE AP HALF OF THIS FILE IS PARKED. EIGHT STATEMENTS DO NOT COMPILE. ***
--
-- Every statement here was parsed against the live instance with
-- DBMS_SQL.PARSE - which resolves every table, column and function against the
-- data dictionary without executing a row and without writing anything. The GL
-- and PO statements all resolve. The AP statements do not, and the reason is
-- not a typo in most cases: PAYABLES has not been opened up.
--
-- The measured grant surface is 51 SELECT grants in USER_TAB_PRIVS. TWO TABLES
-- THIS FILE READS ARE SIMPLY NOT ON IT:
--
--     AP.AP_INVOICE_LINES_ALL#              NOT GRANTED
--     AP.AP_INVOICE_DISTRIBUTIONS_ALL#      NOT GRANTED
--
-- and neither is AP.AP_INVOICE_LINES_ALL under any other name. So this is not
-- the synonym problem section A of 00-discover.sql describes - these objects
-- are absent from the grant list, not merely named differently. The remaining
-- failures are columns on those ungranted tables, which cannot be confirmed or
-- corrected without a grant.
--
-- WHAT DOES WORK. Four APSS-owned views ARE granted and they carry the same
-- data with friendlier columns:
--
--     APPS.WCSEXP_AP_INVOICES              2,569,410 rows
--     APPS.WCSEXP_AP_INV_LINES             6,239,904 rows
--     APPS.WCSEXP_AP_INV_DISTRIBUTIONS     6,928,672 rows
--     APPS.WCSEXP_AP_INVOICE_PAYMENTS      2,653,590 rows
--     APPS.WCSEXP_AP_CHECKS                1,246,676 rows
--
-- ★ WCSEXP_AP_INV_DISTRIBUTIONS IS THE ONE THAT MATTERS HERE: it exposes
--   DIST_CODE_COMBINATION_ID, which is the project bridge S3 needs. The
--   un-granted base table's column is named CODE_COMBINATION_ID in S3 below,
--   and that reference is what fails with ORA-00904. The view's name is strong
--   evidence that DIST_CODE_COMBINATION_ID is the real name - it is what the
--   compatibility view renamed it to, presumably for a reason - but the base
--   table cannot be confirmed without the grant, so S3 is left as it stands
--   rather than rewritten on an inference.
--
-- THE EIGHT FAILURES, AND WHAT EACH ONE IS:
--
--   S0   #1   ORA-00942  AP_INV_LINES / AP_INV_DISTRIBUTIONS legs. Ungranted.
--   S3   #7   ORA-00904  D.CODE_COMBINATION_ID. Likely DIST_CODE_COMBINATION_ID,
--   S3   #8   ORA-00904  but on an ungranted table, so unconfirmable.
--   S3.3 #9   ORA-00942  AP_INVOICE_DISTRIBUTIONS_ALL. Ungranted.
--   S4   #10  ORA-00904  K.PAYMENT_DATE. *** A REAL DEFECT ON A GRANTED TABLE.
--   S4.2 #11  ORA-00904  See the note above S4 - the column does not exist and
--                        the replacement is a decision, not a rename.
--   S7.2 #14  ORA-00942  AP_INVOICE_DISTRIBUTIONS_ALL. Ungranted.
--   S7.2 #15  ORA-00904  D.CODE_COMBINATION_ID on the same ungranted table.
--
-- ★ S4 AND S4.2 ARE THE INTERESTING ONES, because AP_INVOICE_PAYMENTS_ALL IS
-- granted - 2,653,590 rows of it. Its failures are not a permission problem.
-- They reference K.PAYMENT_DATE, and that column does not exist: the table's
-- 101 columns hold ACCOUNTING_DATE and CREATION_DATE instead. The obvious
-- repair is ACCOUNTING_DATE, and it is deliberately NOT applied here. A
-- payment's accounting date is when Payables accounted for it, not when the
-- check was cut, and the check date lives on WCSEXP_AP_CHECKS.CHECK_DATE. Which
-- of those "payments actually made" means is a question about what the report
-- is for, so it is left open rather than answered by a substitution that looks
-- mechanical and is not.
--
-- THE ASK, WHEN IT IS WANTED: SELECT on AP.AP_INVOICE_LINES_ALL# and
-- AP.AP_INVOICE_DISTRIBUTIONS_ALL#. That is the whole of it. The AP views above
-- already work, so the grant is needed only to stop inferring and start
-- confirming.
-- ----------------------------------------------------------------------------


-- ============================================================================
-- S0. Size check - run first, it is cheap and bounds everything else.
-- ============================================================================

SELECT 'PO_DISTRIBUTIONS'    AS object_name, COUNT(*) AS row_count FROM apps.po_distributions_all
UNION ALL
SELECT 'AP_INVOICES',        COUNT(*) FROM apps.ap_invoices_all
UNION ALL
SELECT 'AP_INV_LINES',       COUNT(*) FROM apps.ap_inv_lines
UNION ALL
SELECT 'AP_INV_DISTRIBUTIONS', COUNT(*) FROM apps.ap_invoice_distributions_all
UNION ALL
SELECT 'AP_CHECKS',          COUNT(*) FROM apps.ap_invoice_payments_all
UNION ALL
SELECT 'GL_JE_HEADERS',      COUNT(*) FROM apps.gl_je_headers
UNION ALL
SELECT 'GL_JE_LINES',        COUNT(*) FROM apps.gl_je_lines;

-- *** THIS STATEMENT FAILS - SEE THE PARKED NOTE ABOVE. *** Its second and fourth
-- legs read AP_INV_LINES and AP_INVOICE_DISTRIBUTIONS_ALL, neither of which is
-- granted. The other five legs resolve. Kept intact so the failure stays
-- visible; the working substitute is WCSEXP_AP_INV_LINES (6,239,904 rows) and
-- WCSEXP_AP_INV_DISTRIBUTIONS (6,928,672 rows).
--
-- The 'AP_CHECKS' label above resolves to AP_INVOICE_PAYMENTS_ALL: there is no
-- AP_CHECKS_ALL table in this schema, and apps.ap_checks does not exist either.
-- A payment and its check ARE one row - INVOICE_PAYMENT_ID doubles as the check
-- id - but the date is not PAYMENT_DATE, which does not exist on the table. The
-- check date is WCSEXP_AP_CHECKS.CHECK_DATE, and the base table's nearest
-- columns are ACCOUNTING_DATE and CREATION_DATE. The label is kept so the
-- output rows are unchanged.


-- ============================================================================
-- S1. Commitment vs billing on the purchase-order distribution.
--
-- PO_DISTRIBUTIONS holds both sides: ENCUMBERED_AMOUNT is what was committed,
-- AMOUNT_BILLED is what has actually been invoiced against it. If the second
-- column carries real money, then committed and spent are separable and the
-- app's warning is wrong.
--
-- The sample extract of this table had AMOUNT_BILLED = 0 on all 20 rows with
-- ENCUMBERED_FLAG = 'Y' on all 20 - i.e. purely-encumbered examples. Whether
-- that holds across the whole table is exactly what this query settles.
--
-- NOTE: the sample also carries an AMOUNT_ORDERED column that db-schema.md does
-- not list. If it exists here, swap it in - but the two documented columns
-- below are the ones to trust.
-- ============================================================================

SELECT COUNT(*)                                                    AS distribution_rows,
       COUNT(DISTINCT p.code_combination_id)                       AS distinct_combos,
       SUM(CASE WHEN NVL(p.encumbered_amount, 0) <> 0 THEN 1 ELSE 0 END) AS rows_with_encumbrance,
       SUM(CASE WHEN NVL(p.amount_billed, 0)     <> 0 THEN 1 ELSE 0 END) AS rows_with_billing,
       SUM(CASE WHEN NVL(p.encumbered_amount, 0) <> 0
                 AND NVL(p.amount_billed, 0)     <> 0 THEN 1 ELSE 0 END) AS rows_with_both,
       TO_CHAR(ROUND(SUM(NVL(p.encumbered_amount, 0)), 2),
               'FM999,999,999,999,990.00')                         AS encumbered_total,
       TO_CHAR(ROUND(SUM(NVL(p.amount_billed, 0)), 2),
               'FM999,999,999,999,990.00')                         AS billed_total
FROM   apps.po_distributions_all p;

-- S1.2 ENCUMBERED_FLAG distribution - 'Y' means an open commitment.
SELECT p.encumbered_flag,
       COUNT(*)                                                    AS row_count,
       TO_CHAR(ROUND(SUM(NVL(p.encumbered_amount, 0)), 2),
               'FM999,999,999,999,990.00')                         AS encumbered_total,
       TO_CHAR(ROUND(SUM(NVL(p.amount_billed, 0)), 2),
               'FM999,999,999,999,990.00')                         AS billed_total
FROM   apps.po_distributions_all p
GROUP  BY p.encumbered_flag
ORDER  BY 2 DESC;


-- ============================================================================
-- S2. AP invoices - is anything actually invoiced?
-- ============================================================================

SELECT COUNT(*)                                                    AS invoice_count,
       COUNT(DISTINCT i.vendor_id)                                 AS vendor_count,
       MIN(i.invoice_date)                                         AS first_invoice,
       MAX(i.invoice_date)                                         AS last_invoice,
       TO_CHAR(ROUND(SUM(NVL(i.invoice_amount, 0)), 2),
               'FM999,999,999,999,990.00')                         AS invoiced_total,
       TO_CHAR(ROUND(SUM(NVL(i.amount_paid, 0)), 2),
               'FM999,999,999,999,990.00')                         AS paid_total,
       TO_CHAR(ROUND(SUM(NVL(i.tax_amount, 0)), 2),
               'FM999,999,999,999,990.00')                         AS tax_total
FROM   apps.ap_invoices_all i;

-- S2.2 By payment status - 'Y' paid, 'N' unpaid, 'P' partial.
SELECT i.payment_status_flag,
       COUNT(*)                                                    AS invoice_count,
       TO_CHAR(ROUND(SUM(NVL(i.invoice_amount, 0)), 2),
               'FM999,999,999,999,990.00')                         AS invoiced_amount,
       TO_CHAR(ROUND(SUM(NVL(i.amount_paid, 0)), 2),
               'FM999,999,999,999,990.00')                         AS paid_amount
FROM   apps.ap_invoices_all i
GROUP  BY i.payment_status_flag
ORDER  BY SUM(NVL(i.invoice_amount, 0)) DESC;

-- S2.3 Invoices by period - when the spending happened.
SELECT TO_CHAR(i.invoice_date, 'YYYY-MM')                          AS invoice_month,
       COUNT(*)                                                    AS invoice_count,
       TO_CHAR(ROUND(SUM(NVL(i.invoice_amount, 0)), 2),
               'FM999,999,999,999,990.00')                         AS invoiced_amount
FROM   apps.ap_invoices_all i
GROUP  BY TO_CHAR(i.invoice_date, 'YYYY-MM')
ORDER  BY 1;


-- ============================================================================
-- S3. Invoices by project.
--
-- *** THE COMBINATION COLUMN BELOW IS AN INFERENCE, AND THE TABLE IS NOT
-- GRANTED. SEE THE PARKED NOTE AT THE TOP OF THIS FILE. ***
--
-- AP_INVOICE_DISTRIBUTIONS_ALL is the bridge from an invoice to a project
-- (SEGMENT5) - AP never references a journal, so the combination is the only
-- path - but the table is absent from the 51-row grant list and its columns
-- therefore cannot be read. This statement names CODE_COMBINATION_ID and fails
-- with ORA-00904. The granted view over the same data,
-- WCSEXP_AP_INV_DISTRIBUTIONS, calls it DIST_CODE_COMBINATION_ID, which is good
-- evidence for the real name and not proof of it. Left as written so the
-- failure stays visible.
-- ============================================================================

SELECT c.segment5                                                  AS project_level,
       c.segment2                                                  AS purpose_code,
       COUNT(DISTINCT d.invoice_id)                                AS invoice_count,
       COUNT(*)                                                    AS distribution_count,
       TO_CHAR(ROUND(SUM(NVL(d.amount, 0)), 2),
               'FM999,999,999,999,990.00')                         AS invoiced_amount
FROM   apps.ap_invoice_distributions_all d
JOIN   apps.gl_code_combinations c ON c.code_combination_id = d.code_combination_id
GROUP  BY c.segment5, c.segment2
ORDER  BY SUM(NVL(d.amount, 0)) DESC;

-- S3.2 How much of the AP data can be attributed to a project at all?
-- Same trap as the PO extract, where 80% of the money sat on combinations with
-- no GL_CODE_COMBINATIONS row. If AP has the same gap, an inner join above
-- silently drops most of it.
SELECT COUNT(*)                                                    AS distribution_rows,
       COUNT(c.code_combination_id)                                AS with_segment_row,
       COUNT(*) - COUNT(c.code_combination_id)                     AS without_segment_row,
       TO_CHAR(ROUND(SUM(CASE WHEN c.code_combination_id IS NOT NULL
                              THEN NVL(d.amount, 0) ELSE 0 END), 2),
               'FM999,999,999,999,990.00')                         AS attributed_amount,
       TO_CHAR(ROUND(SUM(CASE WHEN c.code_combination_id IS NULL
                              THEN NVL(d.amount, 0) ELSE 0 END), 2),
               'FM999,999,999,999,990.00')                         AS unattributed_amount
FROM   apps.ap_invoice_distributions_all d
LEFT   JOIN apps.gl_code_combinations c ON c.code_combination_id = d.code_combination_id;

-- S3.3 Did the distribution reach the GL?
--
-- *** FAILS - SEE THE PARKED NOTE AT THE TOP OF THIS FILE. #9 ORA-00942. ***
--
-- The reasoning below is sound but currently unreachable: the statement reads
-- AP_INVOICE_DISTRIBUTIONS_ALL, which is not granted, so it never gets as far
-- as evaluating D.ACCOUNTING_DATE. It is kept because the column question will
-- still be the right question the day the grant arrives.
--
-- POSTED_FLAG was a WCSEXP_AP_INV_DISTRIBUTIONS column the view synthesised as
-- NULL. AP_INVOICE_DISTRIBUTIONS_ALL has no such column, so it cannot be
-- selected from the base table. Oracle stamps ACCOUNTING_DATE on a
-- distribution only when the Payables Accounting Process has created its
-- accounting entries, so a non-null ACCOUNTING_DATE is the base table's own
-- evidence that the row was accounted.
--
-- DEFINE-OR-DROP: ACCOUNTING_DATE proves synthesis happened, not that the
-- resulting journal was posted. If the DBA grants an AP posting-status object
-- (AP_ACCOUNTING_EVENTS_ALL, GL_IMPORT_REFERENCES or XLA_AE_LINES), replace
-- this proxy with the real posting flag.
--SELECT CASE WHEN d.accounting_date IS NULL
                THEN 'not accounted'
                ELSE 'accounted (reached GL)' END                    AS gl_status,
       COUNT(*)                                                    AS row_count,
       TO_CHAR(ROUND(SUM(NVL(d.amount, 0)), 2),
               'FM999,999,999,999,990.00')                         AS amount
FROM   apps.ap_invoice_distributions_all d
GROUP  BY CASE WHEN d.accounting_date IS NULL
                   THEN 'not accounted'
                   ELSE 'accounted (reached GL)' END
ORDER  BY 2 DESC;


-- ============================================================================
-- S4. Payments actually made.
--
-- *** THIS STATEMENT AND S4.2 DO NOT COMPILE, AND THE CAUSE IS NOT PERMISSIONS.
-- SEE THE PARKED NOTE AT THE TOP OF THIS FILE. ***
--
-- What it says below used to be: "the real date column is PAYMENT_DATE - the
-- WCSEXP view renamed it CHECK_DATE". Both halves are wrong. The base table
-- AP_INVOICE_PAYMENTS_ALL has NO PAYMENT_DATE column - measured, 101 columns,
-- and it is not one of them - and the WCSEXP compatibility view did not rename
-- an existing column to CHECK_DATE. The check date lives on
-- WCSEXP_AP_CHECKS, a different object.
-- The table is granted (2,653,590 rows), which is why these
-- two statements parse-check as ORA-00904 rather than ORA-00942: the table is
-- reachable, the column is not real.
--
-- The two columns that DO exist and are candidates:
--     ACCOUNTING_DATE   when Payables accounted for the payment
--     CREATION_DATE     when the payment row was created
-- and the check date itself, WCSEXP_AP_CHECKS.CHECK_DATE, which is a granted
-- view and therefore usable today.
--
-- ★ NOT REPAIRED ON PURPOSE. Substituting ACCOUNTING_DATE for PAYMENT_DATE looks
-- mechanical and is not: it changes what the report MEASURES, from "when the
-- check was cut" to "when the payment hit the ledger". That is a question about
-- what this report is for, and it is the kind of decision that should not be
-- made silently inside a file whose job is to check assumptions. The fix is one
-- word either way - the point is that somebody has to choose the word.
-- ============================================================================

SELECT COUNT(*)                                                    AS check_count,
       MIN(k.payment_date)                                         AS first_check,
       MAX(k.payment_date)                                         AS last_check,
       TO_CHAR(ROUND(SUM(NVL(k.amount, 0)), 2),
               'FM999,999,999,999,990.00')                         AS checks_total
FROM   apps.ap_invoice_payments_all k;

-- S4.2 Payments by month. Also fails on k.payment_date. Note that a
-- TO_CHAR(...) in both the SELECT and the GROUP BY means the replacement column
-- has to be changed in two places, not one - which is a second reason to make
-- the choice deliberately rather than by find-and-replace.
SELECT TO_CHAR(k.payment_date, 'YYYY-MM')                          AS payment_month,
       COUNT(*)                                                    AS check_count,
       TO_CHAR(ROUND(SUM(NVL(k.amount, 0)), 2),
               'FM999,999,999,999,990.00')                         AS paid_amount
FROM   apps.ap_invoice_payments_all k
GROUP  BY TO_CHAR(k.payment_date, 'YYYY-MM')
ORDER  BY 1;


-- ============================================================================
-- S5. GL actuals and encumbrances, by balance type.
--
-- GL_BALANCES holds all three flags, so this is the one query that shows budget,
-- commitment and spend as three columns of the same money.
--
-- WINDOWED. All three flags are filtered to the same range, so the columns are
-- comparable; an unfiltered 'B' against a windowed 'A' would show a headroom
-- that does not exist.
-- ============================================================================

SELECT b.actual_flag,
       DECODE(b.actual_flag,
              'A', 'Actual (spent)',
              'B', 'Budget',
              'E', 'Encumbrance (committed)',
                   '(other)')                                      AS balance_type,
       COUNT(DISTINCT b.code_combination_id)                       AS combo_count,
       COUNT(DISTINCT b.period_name)                               AS period_count,
       TO_CHAR(ROUND(SUM(NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0)), 2),
               'FM999,999,999,999,990.00')                         AS net_dr_less_cr
FROM   apps.gl_balances b
WHERE  b.period_year >= (SELECT MAX (period_year) - 2 FROM apps.gl_periods)
GROUP  BY b.actual_flag
ORDER  BY b.actual_flag;


-- ============================================================================
-- S6. THE THREE-WAY VIEW: budget vs committed vs spent, per project.
--
-- Only meaningful if S5 shows 'A' and/or 'E' rows. If it does, this replaces
-- the app's derived 10%-headroom placeholder with an actual position - and it
-- is the strongest argument for revisiting the extract scope.
--
-- WINDOWED, all three flags together. The result is a position as it MOVED
-- inside FY2025-FY2027, not a lifetime one - and unlike 03-budget-changes.sql
-- C3, that is the right reading here, because budgets, commitments and spend
-- are all drawn from the same periods. `budget_less_spent` on a project whose
-- appropriation predates the window will read as negative. That is the window
-- showing through, not arithmetic failure; 01-budgets.sql B1 gives the carried
-- forward position for comparison.
-- ============================================================================

SELECT c.segment5                                                  AS project_level,
       c.segment2                                                  AS purpose_code,
       TO_CHAR(ROUND(SUM(CASE WHEN x.actual_flag = 'B' THEN x.net ELSE 0 END), 2),
               'FM999,999,999,999,990.00')                         AS budget,
       TO_CHAR(ROUND(SUM(CASE WHEN x.actual_flag = 'E' THEN x.net ELSE 0 END), 2),
               'FM999,999,999,999,990.00')                         AS committed_encumbrance,
       TO_CHAR(ROUND(SUM(CASE WHEN x.actual_flag = 'A' THEN x.net ELSE 0 END), 2),
               'FM999,999,999,999,990.00')                         AS spent_actual,
       TO_CHAR(ROUND(SUM(CASE WHEN x.actual_flag = 'B' THEN x.net ELSE 0 END)
                   - SUM(CASE WHEN x.actual_flag = 'A' THEN x.net ELSE 0 END), 2),
               'FM999,999,999,999,990.00')                         AS budget_less_spent
FROM   (SELECT b.actual_flag,
               b.code_combination_id,
               NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0) AS net
        FROM   apps.gl_balances b
        WHERE  b.actual_flag IN ('A', 'B', 'E')
        AND    b.period_year >=
               (SELECT MAX (period_year) - 2 FROM apps.gl_periods)) x
JOIN   apps.gl_code_combinations c ON c.code_combination_id = x.code_combination_id
WHERE  c.summary_flag = 'N'
GROUP  BY c.segment5, c.segment2
ORDER  BY SUM(CASE WHEN x.actual_flag = 'B' THEN x.net ELSE 0 END) DESC NULLS LAST;


-- ============================================================================
-- S7. Commitments that have no invoice against them.
--
-- *** FAILS - SEE THE PARKED NOTE AT THE TOP OF THIS FILE. #14 ORA-00942. ***
--
-- The three-way match the plan lists as a phase-5 exit criterion. PO has no
-- document number in common with AP - the PO sample ships ORDER_NUMBER while
-- the AP samples ship PO_HEADER_ID, with zero intersection - so the bridge is
-- the distribution, not the document.
--
-- THE BRIDGE IS ALSO THE PROBLEM. The AP side of this query is
-- AP_INVOICE_DISTRIBUTIONS_ALL, which is not granted. That is worth stating
-- plainly because the bridge has now been blamed twice for something that was
-- not its fault: first WCSEXP_AP_INV_LINES was said to expose a
-- PO_DISTRIBUTION_ID it synthesised as NULL, and the correction was to move to
-- the base table - which turned a query that returned wrong-but-plausible
-- numbers into one that returns no numbers at all. The base table is the right
-- target; the grant is simply not there yet.
--
-- Report only; a large number here is a finding, not necessarily an error.
-- ============================================================================

SELECT COUNT(*)                                                    AS matched_distributions,
       TO_CHAR(ROUND(SUM(NVL(p.encumbered_amount, 0)), 2),
               'FM999,999,999,999,990.00')                         AS committed_matched
FROM   apps.po_distributions_all p
WHERE  EXISTS (SELECT 1
               FROM   apps.ap_invoice_distributions_all l
               WHERE  l.po_distribution_id = p.po_distribution_id);

-- S7.2 Budget or commitments with no matching segment row - the coverage gap.
--
-- NOT WINDOWED. This counts how many combinations cannot be NAMED, which is a
-- property of the chart of accounts rather than of a date range. Windowing it
-- would hide every combination whose only activity predates FY2025 but whose
-- GL_CODE_COMBINATIONS row is still missing - exactly the gap it exists to
-- find. GL_BALANCES is unfiltered here for the same reason it is filtered in
-- S5: the question is different.
SELECT 'PO_DISTRIBUTIONS' AS source,
       COUNT(DISTINCT p.code_combination_id)                       AS combos,
       COUNT(DISTINCT CASE WHEN c.code_combination_id IS NULL
                           THEN p.code_combination_id END)         AS combos_without_segment_row
FROM   apps.po_distributions_all p
LEFT   JOIN apps.gl_code_combinations c ON c.code_combination_id = p.code_combination_id
UNION ALL
SELECT 'GL_BALANCES',
       COUNT(DISTINCT b.code_combination_id),
       COUNT(DISTINCT CASE WHEN c.code_combination_id IS NULL
                           THEN b.code_combination_id END)
FROM   apps.gl_balances b
LEFT   JOIN apps.gl_code_combinations c ON c.code_combination_id = b.code_combination_id
UNION ALL
-- *** THE THIRD LEG FAILS - #15 ORA-00942. AP_INVOICE_DISTRIBUTIONS_ALL is not
-- granted, so the two legs above are the whole answer this statement can give
-- today. That is a real loss of coverage in exactly the query whose job is to
-- measure coverage, which is why it is marked rather than quietly dropped. ***
SELECT 'AP_INV_DISTRIBUTIONS',
       COUNT(DISTINCT d.code_combination_id),
       COUNT(DISTINCT CASE WHEN c.code_combination_id IS NULL
                           THEN d.code_combination_id END)
FROM   apps.ap_invoice_distributions_all d
LEFT   JOIN apps.gl_code_combinations c ON c.code_combination_id = d.code_combination_id;
