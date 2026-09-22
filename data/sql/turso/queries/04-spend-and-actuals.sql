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
--------------------------------------------------------------------------------

-- ============================================================================
-- PORT NOTES - SQLite / libSQL dialect.
--
-- Added by the port. The Oracle comments above and below are kept VERBATIM,
-- including every section label (S0..S7.2) and every "Expect" assertion,
-- because other documents cross-reference them.
--
--   1. `apps.` object prefix DROPPED - this surrogate is a single schema, so
--      every name resolves unprefixed. The base-table names carried here are
--      the same ones the Oracle original uses.
--   2. NVL(a,b) -> COALESCE(a,b).
--   3. DECODE(x, k1,v1, k2,v2, k3,v3, default) -> CASE x WHEN ... END. S5
--      carries the only one, on ACTUAL_FLAG.
--   4. TO_CHAR(<num>, 'FM999,999,999,999,990.00') -> printf('%.2f', ROUND(<num>,2)).
--      THE THOUSANDS SEPARATOR CANNOT BE REPRODUCED: SQLite's printf has no
--      grouping flag. This is the single place the port is visibly not 1:1 in
--      its OUTPUT - amounts print ungrouped ("4356078.25", not "4,356,078.25").
--      The two-decimal rounding is preserved exactly.
--   5. TO_CHAR(<date>, 'YYYY-MM') -> strftime('%Y-%m', <date>), in S2.3 and S4.2.
--      Both the SELECT list and the GROUP BY must change together or the two
--      would group on a different expression than the one they print; both are
--      converted. 'YYYY-MM' is the whole format here, so no part of the Oracle
--      mask is lost. NULL dates group into a NULL bucket in both dialects.
--   6. No ROWNUM anywhere in this file - nothing to cap, so nothing needed a
--      LIMIT. The two UNION ALL statements (S0, S7.2) also carry over unchanged;
--      neither has an ORDER BY, which SQLite would have required to be applied
--      to the compound SELECT as a whole rather than to one branch.
--   7. S7's EXISTS-correlated subquery and S3.2/S3.3/S7.2's COUNT(...) over a
--      LEFT JOIN need NO change.
-- ============================================================================


-- ============================================================================
-- S0. Size check - run first, it is cheap and bounds everything else.
-- ============================================================================

SELECT 'PO_DISTRIBUTIONS'    AS object_name, COUNT(*) AS row_count FROM po_distributions_all
UNION ALL
SELECT 'AP_INVOICES',        COUNT(*) FROM ap_invoices_all
UNION ALL
SELECT 'AP_INV_LINES',       COUNT(*) FROM ap_inv_lines
UNION ALL
SELECT 'AP_INV_DISTRIBUTIONS', COUNT(*) FROM ap_invoice_distributions_all
UNION ALL
SELECT 'AP_CHECKS',          COUNT(*) FROM ap_invoice_payments_all
UNION ALL
SELECT 'GL_JE_HEADERS',      COUNT(*) FROM gl_je_headers
UNION ALL
SELECT 'GL_JE_LINES',        COUNT(*) FROM gl_je_lines;

-- The 'AP_CHECKS' label above resolves to AP_INVOICE_PAYMENTS_ALL: there is no
-- AP_CHECKS_ALL table in this schema. A payment and its check are one row, so
-- INVOICE_PAYMENT_ID doubles as the check id and PAYMENT_DATE is the check
-- date. The label is kept so the output rows are unchanged.


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
       SUM(CASE WHEN COALESCE(p.encumbered_amount, 0) <> 0 THEN 1 ELSE 0 END) AS rows_with_encumbrance,
       SUM(CASE WHEN COALESCE(p.amount_billed, 0)     <> 0 THEN 1 ELSE 0 END) AS rows_with_billing,
       SUM(CASE WHEN COALESCE(p.encumbered_amount, 0) <> 0
                 AND COALESCE(p.amount_billed, 0)     <> 0 THEN 1 ELSE 0 END) AS rows_with_both,
       printf('%.2f', ROUND(SUM(COALESCE(p.encumbered_amount, 0)), 2))
                                                                   AS encumbered_total,
       printf('%.2f', ROUND(SUM(COALESCE(p.amount_billed, 0)), 2))
                                                                   AS billed_total
FROM   po_distributions_all p;

-- S1.2 ENCUMBERED_FLAG distribution - 'Y' means an open commitment.
SELECT p.encumbered_flag,
       COUNT(*)                                                    AS row_count,
       printf('%.2f', ROUND(SUM(COALESCE(p.encumbered_amount, 0)), 2))
                                                                   AS encumbered_total,
       printf('%.2f', ROUND(SUM(COALESCE(p.amount_billed, 0)), 2))
                                                                   AS billed_total
FROM   po_distributions_all p
GROUP  BY p.encumbered_flag
ORDER  BY 2 DESC;


-- ============================================================================
-- S2. AP invoices - is anything actually invoiced?
-- ============================================================================

SELECT COUNT(*)                                                    AS invoice_count,
       COUNT(DISTINCT i.vendor_id)                                 AS vendor_count,
       MIN(i.invoice_date)                                         AS first_invoice,
       MAX(i.invoice_date)                                         AS last_invoice,
       printf('%.2f', ROUND(SUM(COALESCE(i.invoice_amount, 0)), 2))
                                                                   AS invoiced_total,
       printf('%.2f', ROUND(SUM(COALESCE(i.amount_paid, 0)), 2))
                                                                   AS paid_total,
       printf('%.2f', ROUND(SUM(COALESCE(i.tax_amount, 0)), 2))
                                                                   AS tax_total
FROM   ap_invoices_all i;

-- S2.2 By payment status - 'Y' paid, 'N' unpaid, 'P' partial.
SELECT i.payment_status_flag,
       COUNT(*)                                                    AS invoice_count,
       printf('%.2f', ROUND(SUM(COALESCE(i.invoice_amount, 0)), 2))
                                                                   AS invoiced_amount,
       printf('%.2f', ROUND(SUM(COALESCE(i.amount_paid, 0)), 2))
                                                                   AS paid_amount
FROM   ap_invoices_all i
GROUP  BY i.payment_status_flag
ORDER  BY SUM(COALESCE(i.invoice_amount, 0)) DESC;

-- S2.3 Invoices by period - when the spending happened.
SELECT strftime('%Y-%m', i.invoice_date)                           AS invoice_month,
       COUNT(*)                                                    AS invoice_count,
       printf('%.2f', ROUND(SUM(COALESCE(i.invoice_amount, 0)), 2))
                                                                   AS invoiced_amount
FROM   ap_invoices_all i
GROUP  BY strftime('%Y-%m', i.invoice_date)
ORDER  BY 1;


-- ============================================================================
-- S3. Invoices by project.
--
-- AP_INVOICE_DISTRIBUTIONS_ALL carries CODE_COMBINATION_ID, so this is the
-- bridge from an invoice to a project (SEGMENT5) - AP never references a
-- journal, so the combination is the only path.
-- ============================================================================

SELECT c.segment5                                                  AS project_level,
       c.segment2                                                  AS purpose_code,
       COUNT(DISTINCT d.invoice_id)                                AS invoice_count,
       COUNT(*)                                                    AS distribution_count,
       printf('%.2f', ROUND(SUM(COALESCE(d.amount, 0)), 2))
                                                                   AS invoiced_amount
FROM   ap_invoice_distributions_all d
JOIN   gl_code_combinations c ON c.code_combination_id = d.code_combination_id
GROUP  BY c.segment5, c.segment2
ORDER  BY SUM(COALESCE(d.amount, 0)) DESC;

-- S3.2 How much of the AP data can be attributed to a project at all?
-- Same trap as the PO extract, where 80% of the money sat on combinations with
-- no GL_CODE_COMBINATIONS row. If AP has the same gap, an inner join above
-- silently drops most of it.
SELECT COUNT(*)                                                    AS distribution_rows,
       COUNT(c.code_combination_id)                                AS with_segment_row,
       COUNT(*) - COUNT(c.code_combination_id)                     AS without_segment_row,
       printf('%.2f', ROUND(SUM(CASE WHEN c.code_combination_id IS NOT NULL
                                     THEN COALESCE(d.amount, 0) ELSE 0 END), 2))
                                                                   AS attributed_amount,
       printf('%.2f', ROUND(SUM(CASE WHEN c.code_combination_id IS NULL
                                     THEN COALESCE(d.amount, 0) ELSE 0 END), 2))
                                                                   AS unattributed_amount
FROM   ap_invoice_distributions_all d
LEFT   JOIN gl_code_combinations c ON c.code_combination_id = d.code_combination_id;

-- S3.3 Did the distribution reach the GL?
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
SELECT CASE WHEN d.accounting_date IS NULL
                THEN 'not accounted'
                ELSE 'accounted (reached GL)' END                  AS gl_status,
       COUNT(*)                                                    AS row_count,
       printf('%.2f', ROUND(SUM(COALESCE(d.amount, 0)), 2))
                                                                   AS amount
FROM   ap_invoice_distributions_all d
GROUP  BY CASE WHEN d.accounting_date IS NULL
                   THEN 'not accounted'
                   ELSE 'accounted (reached GL)' END
ORDER  BY 2 DESC;


-- ============================================================================
-- S4. Payments actually made.
--
-- This schema models a payment and its check as one row, so AP_CHECKS is
-- AP_INVOICE_PAYMENTS_ALL and the real date column is PAYMENT_DATE - the
-- WCSEXP view renamed it CHECK_DATE. The output aliases below keep the old
-- names so the result columns are unchanged.
-- ============================================================================

SELECT COUNT(*)                                                    AS check_count,
       MIN(k.payment_date)                                         AS first_check,
       MAX(k.payment_date)                                         AS last_check,
       printf('%.2f', ROUND(SUM(COALESCE(k.amount, 0)), 2))
                                                                   AS checks_total
FROM   ap_invoice_payments_all k;

-- S4.2 Payments by month.
SELECT strftime('%Y-%m', k.payment_date)                           AS payment_month,
       COUNT(*)                                                    AS check_count,
       printf('%.2f', ROUND(SUM(COALESCE(k.amount, 0)), 2))
                                                                   AS paid_amount
FROM   ap_invoice_payments_all k
GROUP  BY strftime('%Y-%m', k.payment_date)
ORDER  BY 1;


-- ============================================================================
-- S5. GL actuals and encumbrances, by balance type.
--
-- GL_BALANCES holds all three flags, so this is the one query that shows budget,
-- commitment and spend as three columns of the same money.
-- ============================================================================

SELECT b.actual_flag,
       CASE b.actual_flag
         WHEN 'A' THEN 'Actual (spent)'
         WHEN 'B' THEN 'Budget'
         WHEN 'E' THEN 'Encumbrance (committed)'
         ELSE '(other)'
       END                                                         AS balance_type,
       COUNT(DISTINCT b.code_combination_id)                       AS combo_count,
       COUNT(DISTINCT b.period_name)                               AS period_count,
       printf('%.2f', ROUND(SUM(COALESCE(b.period_net_dr, 0) - COALESCE(b.period_net_cr, 0)), 2))
                                                                   AS net_dr_less_cr
FROM   gl_balances b
GROUP  BY b.actual_flag
ORDER  BY b.actual_flag;


-- ============================================================================
-- S6. THE THREE-WAY VIEW: budget vs committed vs spent, per project.
--
-- Only meaningful if S5 shows 'A' and/or 'E' rows. If it does, this replaces
-- the app's derived 10%-headroom placeholder with an actual position - and it
-- is the strongest argument for revisiting the extract scope.
-- ============================================================================

SELECT c.segment5                                                  AS project_level,
       c.segment2                                                  AS purpose_code,
       printf('%.2f', ROUND(SUM(CASE WHEN x.actual_flag = 'B' THEN x.net ELSE 0 END), 2))
                                                                   AS budget,
       printf('%.2f', ROUND(SUM(CASE WHEN x.actual_flag = 'E' THEN x.net ELSE 0 END), 2))
                                                                   AS committed_encumbrance,
       printf('%.2f', ROUND(SUM(CASE WHEN x.actual_flag = 'A' THEN x.net ELSE 0 END), 2))
                                                                   AS spent_actual,
       printf('%.2f', ROUND(SUM(CASE WHEN x.actual_flag = 'B' THEN x.net ELSE 0 END)
                          - SUM(CASE WHEN x.actual_flag = 'A' THEN x.net ELSE 0 END), 2))
                                                                   AS budget_less_spent
FROM   (SELECT b.actual_flag,
               b.code_combination_id,
               COALESCE(b.period_net_dr, 0) - COALESCE(b.period_net_cr, 0) AS net
        FROM   gl_balances b
        WHERE  b.actual_flag IN ('A', 'B', 'E')) x
JOIN   gl_code_combinations c ON c.code_combination_id = x.code_combination_id
WHERE  c.summary_flag = 'N'
GROUP  BY c.segment5, c.segment2
ORDER  BY SUM(CASE WHEN x.actual_flag = 'B' THEN x.net ELSE 0 END) DESC NULLS LAST;


-- ============================================================================
-- S7. Commitments that have no invoice against them.
--
-- The three-way match the plan lists as a phase-5 exit criterion. PO has no
-- document number in common with AP - the PO sample ships ORDER_NUMBER while
-- the AP samples ship PO_HEADER_ID, with zero intersection - so the bridge is
-- the distribution, not the document.
--
-- WCSEXP_AP_INV_LINES exposed a PO_DISTRIBUTION_ID it did not actually have
-- (the view synthesised NULL), so the EXISTS below could never match. The
-- column is real, but it lives on AP_INVOICE_DISTRIBUTIONS_ALL - which is
-- where the PO link is recorded - so the match now goes through the
-- distribution table the sentence above already names.
--
-- Report only; a large number here is a finding, not necessarily an error.
-- ============================================================================

SELECT COUNT(*)                                                    AS matched_distributions,
       printf('%.2f', ROUND(SUM(COALESCE(p.encumbered_amount, 0)), 2))
                                                                   AS committed_matched
FROM   po_distributions_all p
WHERE  EXISTS (SELECT 1
               FROM   ap_invoice_distributions_all l
               WHERE  l.po_distribution_id = p.po_distribution_id);

-- S7.2 Budget or commitments with no matching segment row - the coverage gap.
SELECT 'PO_DISTRIBUTIONS' AS source,
       COUNT(DISTINCT p.code_combination_id)                       AS combos,
       COUNT(DISTINCT CASE WHEN c.code_combination_id IS NULL
                           THEN p.code_combination_id END)         AS combos_without_segment_row
FROM   po_distributions_all p
LEFT   JOIN gl_code_combinations c ON c.code_combination_id = p.code_combination_id
UNION ALL
SELECT 'GL_BALANCES',
       COUNT(DISTINCT b.code_combination_id),
       COUNT(DISTINCT CASE WHEN c.code_combination_id IS NULL
                           THEN b.code_combination_id END)
FROM   gl_balances b
LEFT   JOIN gl_code_combinations c ON c.code_combination_id = b.code_combination_id
UNION ALL
SELECT 'AP_INV_DISTRIBUTIONS',
       COUNT(DISTINCT d.code_combination_id),
       COUNT(DISTINCT CASE WHEN c.code_combination_id IS NULL
                           THEN d.code_combination_id END)
FROM   ap_invoice_distributions_all d
LEFT   JOIN gl_code_combinations c ON c.code_combination_id = d.code_combination_id;
