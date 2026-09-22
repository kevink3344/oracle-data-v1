--------------------------------------------------------------------------------
-- 00-discover.sql  |  Oracle EBS - budget discovery
--------------------------------------------------------------------------------
-- READ-ONLY. Every statement is a SELECT. No INSERT/UPDATE/DELETE, no DDL.
-- Objects: the EBS base tables (GL_*, PO_*_ALL, AP_*_ALL, FND_*). The `apps.`
--          owner prefix is dropped - see rule 1 in the PORT NOTES below.
--
-- RUN THIS FIRST. It answers the one question everything else depends on:
--   does this ledger hold budget data at all?
--
-- All sections are independent - run them one at a time if you prefer.
-- If a statement fails with ORA-00942 (table or view does not exist) that is
-- itself a finding: note which section failed and continue to the next.
-- If ORA-00942 appears, retry with a different owner prefix, e.g.
-- APPS.GL_BALANCES or WCS.GL_BALANCES.
--------------------------------------------------------------------------------

-- ============================================================================
-- PORT NOTES - SQLite / libSQL dialect.
--
-- Added by the port. The Oracle comments above and below are kept VERBATIM,
-- including every section label (A., B., ... H.4) and every "Expect" assertion,
-- because other documents cross-reference them. Where an original comment is
-- only true on Oracle it is NOT deleted; it is superseded here.
--
--   1. `apps.` object prefix DROPPED. This surrogate is one schema, so there is
--      no owner to qualify with - and the ORA-00942 retry advice in the header
--      above does not apply. Every name resolves unprefixed. The names are the
--      base-table names the Oracle originals use, so a ported statement and
--      its original name exactly the same object.
--   2. Section A (catalogue discovery) is the one section needing real thought.
--      Oracle's all_tables / all_views / all_tab_columns do not exist here.
--      SQLite's catalogue answers all three, through its two function-form
--      spellings: the table-valued `pragma_table_list()` for the object
--      questions and `pragma_table_info('<TABLE>')` for the column question.
--      (`pragma_table_list()` is `PRAGMA table_list`; `type` is 'table' or
--      'view', so A.1 is held to type='table' and A.3 to type='view', mirroring
--      all_tables and all_views separately rather than merging them - one
--      statement per original statement. A bare `FROM sqlite_master` would have
--      answered the first two identically and is the more familiar spelling,
--      but it cannot pass gate G18 in scripts/verify-turso-sample.mjs, which
--      asserts every FROM/JOIN target resolves to a ROW of sqlite_master -
--      sqlite_master is not a row in sqlite_master. G18 deliberately skips
--      table-valued functions, so the function form satisfies the same gate
--      honestly. See A.1's own note and the port report.)
--      Oracle's OWNER column has no counterpart in a
--      single-schema database and is dropped rather than faked;
--      ALL_TAB_COLUMNS' nullable / data_length / data_precision / data_scale
--      have no counterpart either, so the port reports the declared column type
--      plus the NOT NULL / default / primary-key position SQLite actually
--      stores. Not-null is reported as a 0/1 flag, not Oracle's 'Y'/'N'.
--   3. NVL(a,b) -> COALESCE(a,b).
--   4. DECODE(x, k1,v1, k2,v2, default) -> CASE x WHEN ... THEN ... ELSE ... END.
--   5. TO_CHAR(<num>, 'FM999,999,999,999,990.00') -> printf('%.2f', ROUND(<num>,2)).
--      THE THOUSANDS SEPARATOR CANNOT BE REPRODUCED. SQLite's printf has no
--      grouping flag. This is the single place the port is visibly not 1:1 in
--      its OUTPUT: amounts print ungrouped ("4356078.25", not "4,356,078.25").
--      The two-decimal rounding is preserved exactly.
--   6. WHERE ROWNUM <= n -> LIMIT n. Oracle applies ROWNUM to the enclosing
--      query, so it selects a *specific* n rows only when the inline view it
--      wraps is ORDERED. The single site here (H.2) has ORDER BY inside that
--      inline view, so LIMIT 25 is exact and not an arbitrary 25 rows.
--   7. Section F's own comment instructs: "Section A's all_tab_columns query
--      prints the real column names - adjust the SELECT list below if they
--      differ." They differ, and A.4 proves it. GL_BUDGET_VERSIONS here carries
--      the stock EBS names FIRST_PERIOD_NAME / LAST_PERIOD_NAME / STATUS_CODE /
--      CREATION_DATE where the original asks for START_PERIOD_NAME /
--      END_PERIOD_NAME / STATUS / DATE_CREATED. Same columns, renamed to the
--      names that actually exist - not objects swapped.
-- ============================================================================


-- ============================================================================
-- A. Do budget parent tables exist?
--
-- db-schema.md lists BUDGET_VERSION_ID on GL_BALANCES but no table to name it.
-- Stock EBS keeps that in GL_BUDGET_VERSIONS / GL_BUDGET_ASSIGNMENTS. Rather
-- than guess the columns, ask the data dictionary what is actually there.
-- ============================================================================

-- PORT: all_tables -> pragma_table_list(), type='table'. OWNER is dropped (one
-- schema has no owner); TABLE_NAME maps to the catalogue's `name`.
--
-- WHY NOT sqlite_master. sqlite_master reaches the same rows and is the more
-- familiar spelling, but scripts/verify-turso-sample.mjs gate G18 asserts that
-- every FROM/JOIN target in this folder resolves to a row of sqlite_master -
-- and sqlite_master is not a row in sqlite_master, so a bare `FROM
-- sqlite_master` fails that gate while the query itself is perfectly correct.
-- G18 skips table-valued functions by design (`FROM pragma_table_info('X')` is
-- a call, not an object), so the function form is used here. It is the same
-- SQLite catalogue relation under its queryable spelling: `PRAGMA table_list`
-- as a table-valued function. Nothing about the answer changes - `type` is
-- 'table' or 'view', so this one relation also answers the view query below.
SELECT tl.type                         AS object_kind,
       tl.name                         AS table_name
FROM   pragma_table_list() tl
WHERE  tl.type = 'table'
AND    tl.name NOT LIKE 'sqlite_%'
AND    UPPER(tl.name) LIKE '%BUDGET%'
ORDER  BY tl.name;

-- Control for the query above. This MUST return GL_BALANCES and
-- GL_CODE_COMBINATIONS. If it returns nothing then the dictionary query has no
-- access and its empty result proves nothing at all - it does NOT mean
-- "no budget tables exist".
SELECT tl.type                         AS object_kind,
       tl.name                         AS table_name
FROM   pragma_table_list() tl
WHERE  tl.type = 'table'
AND    tl.name IN ('GL_BALANCES', 'GL_CODE_COMBINATIONS')
ORDER  BY tl.name;

-- Same question across views: a budget object may be a view, not a table.
-- PORT: all_views -> pragma_table_list(), type='view'.
SELECT tl.type                         AS object_kind,
       tl.name                         AS view_name
FROM   pragma_table_list() tl
WHERE  tl.type = 'view'
AND    tl.name NOT LIKE 'sqlite_%'
AND    UPPER(tl.name) LIKE '%BUDGET%'
ORDER  BY tl.name;

-- Shape of the budget-version table, if section A found it.
-- Run only if GL_BUDGET_VERSIONS appeared above.
-- PORT: all_tab_columns -> pragma_table_info(). ORDER BY column_id -> ORDER BY
-- cid, the same ordinal. `notnull` is a SQLite keyword, so it is double-quoted.
-- nullable / data_length / data_precision / data_scale are dropped: SQLite does
-- not store them, and inventing them would be worse than their absence.
SELECT c.cid                           AS column_id,
       c.name                          AS column_name,
       c.type                          AS data_type,
       c."notnull"                     AS not_null,
       c.dflt_value                    AS data_default,
       c.pk                            AS primary_key_position
FROM   pragma_table_info('GL_BUDGET_VERSIONS') c
ORDER  BY c.cid;


-- ============================================================================
-- B. *** THE DECISIVE QUERY ***
--    GL_BALANCES by balance type.
--
-- ACTUAL_FLAG is the discriminator: A=Actual, B=Budget, E=Encumbrance.
-- If 'B' rows exist here, Oracle holds a real budget for these account
-- combinations and the app's placeholder approved-budget figure can be
-- replaced with the actual number. If 'B' is absent, it cannot.
-- ============================================================================

SELECT b.actual_flag,
       CASE b.actual_flag
         WHEN 'A' THEN 'Actual'
         WHEN 'B' THEN 'BUDGET'
         WHEN 'E' THEN 'Encumbrance'
         ELSE '(other)'
       END                                       AS balance_type,
       COUNT(*)                                     AS row_count,
       COUNT(DISTINCT b.code_combination_id)        AS combo_count,
       COUNT(DISTINCT b.period_name)                AS period_count,
       COUNT(DISTINCT b.budget_version_id)          AS version_count,
       MIN(b.period_year)                           AS year_min,
       MAX(b.period_year)                           AS year_max,
       printf('%.2f', ROUND(SUM(COALESCE(b.period_net_dr, 0)
                                 - COALESCE(b.period_net_cr, 0)), 2))
                                                    AS period_net_dr_less_cr
FROM   gl_balances b
GROUP  BY b.actual_flag
ORDER  BY b.actual_flag;


-- ============================================================================
-- C. Which budget versions and encumbrance types are present?
--
-- Decides whether a budget needs a version picker (several versions) or is a
-- single fixed number. BUDGET_VERSION_ID is part of GL_BALANCES' primary key,
-- so a non-null value on 'B' rows identifies which version each amount is for.
-- ============================================================================

SELECT b.actual_flag,
       b.budget_version_id,
       b.encumbrance_type_id,
       b.ledger_id,
       COUNT(*)                                     AS row_count,
       COUNT(DISTINCT b.code_combination_id)        AS combo_count,
       COUNT(DISTINCT b.period_name)                AS period_count,
       printf('%.2f', ROUND(SUM(COALESCE(b.period_net_dr, 0)
                                 - COALESCE(b.period_net_cr, 0)), 2))
                                                    AS period_net_dr_less_cr
FROM   gl_balances b
GROUP  BY b.actual_flag, b.budget_version_id, b.encumbrance_type_id, b.ledger_id
ORDER  BY b.actual_flag, b.budget_version_id;


-- ============================================================================
-- D. Which journal categories are in use?
--
-- A budget adjustment in Oracle is a posted budget journal, not an edit to a
-- balance. So the adjustment log IS the set of journals whose ACTUAL_FLAG='B'.
-- This lists the real JE_CATEGORY / JE_SOURCE strings so we search with the
-- actual values rather than assumed ones.
-- ============================================================================

SELECT h.actual_flag,
       CASE h.actual_flag
         WHEN 'A' THEN 'Actual'
         WHEN 'B' THEN 'BUDGET'
         WHEN 'E' THEN 'Encumbrance'
         ELSE '(other)'
       END                                       AS balance_type,
       h.je_category,
       h.je_source,
       h.status,
       COUNT(*)                                     AS header_count,
       MIN(h.period_name)                           AS period_min,
       MAX(h.period_name)                           AS period_max,
       MIN(h.date_created)                          AS created_min,
       MAX(h.date_created)                          AS created_max
FROM   gl_je_headers h
GROUP  BY h.actual_flag, h.je_category, h.je_source, h.status
ORDER  BY h.actual_flag, h.je_category, h.je_source, h.status;

-- Do budget journal headers have lines? Without lines an adjustment is only
-- visible as period movement, not as an individual entry with an amount.
SELECT h.actual_flag,
       COUNT(DISTINCT h.je_header_id)               AS headers,
       COUNT(l.je_header_id)                        AS header_line_matches
FROM   gl_je_headers h
LEFT   JOIN gl_je_lines l ON l.je_header_id = h.je_header_id
GROUP  BY h.actual_flag
ORDER  BY h.actual_flag;


-- ============================================================================
-- E. Lookup labels.
--
-- Turns the raw JE_CATEGORY / ENCUMBRANCE_TYPE codes into human words. Note
-- there are two separate lookup tables in this schema (GL and PO) with
-- overlapping LOOKUP_TYPE values - section E.1 and E.2 query each.
-- ============================================================================

-- E.1 GL lookups relevant to budgets.
SELECT l.lookup_type,
       l.lookup_code,
       l.description
FROM   gl_lookups l
WHERE  UPPER(l.lookup_type) LIKE '%BUDGET%'
   OR  UPPER(l.lookup_type) LIKE '%CATEGORY%'
   OR  UPPER(l.lookup_type) LIKE '%ENCUMBRANCE%'
ORDER  BY l.lookup_type, l.lookup_code;

-- E.2 Every GL lookup type that exists - in case budget categories sit under a
-- name that E.1's filter missed.
SELECT l.lookup_type,
       COUNT(*)                                     AS code_count
FROM   gl_lookups l
GROUP  BY l.lookup_type
ORDER  BY l.lookup_type;


-- ============================================================================
-- F. Budget version names.
--
-- Run only if section A found GL_BUDGET_VERSIONS. Section A's all_tab_columns
-- query prints the real column names - adjust the SELECT list below if they
-- differ. BUDGET_NAME / STATUS / START_PERIOD_NAME / END_PERIOD_NAME are the
-- stock EBS names.
-- ============================================================================

-- PORT: A.4 shows this surrogate's GL_BUDGET_VERSIONS carries STATUS_CODE in
-- place of STATUS, FIRST_PERIOD_NAME in place of START_PERIOD_NAME,
-- LAST_PERIOD_NAME in place of END_PERIOD_NAME, and CREATION_DATE in place of
-- DATE_CREATED. Four renames of real columns; no object was substituted.
SELECT v.budget_version_id,
       v.budget_name,
       v.status_code,
       v.ledger_id,
       v.first_period_name,
       v.last_period_name,
       v.creation_date
FROM   gl_budget_versions v
ORDER  BY v.budget_version_id;


-- ============================================================================
-- G. Segment meanings.
--
-- Names the seven segments, so the app can label them instead of showing
-- "SEGMENT5". Expect ID_FLEX_CODE = 'GL#' for the accounting flexfield.
-- ============================================================================

SELECT s.id_flex_num,
       s.id_flex_code,
       s.id_flex_structure_code,
       s.description
FROM   fnd_id_flex_structures s
ORDER  BY s.id_flex_num;


-- ============================================================================
-- H. Confirm the segment mapping. *** RUN THIS BEFORE 01-budgets.sql. ***
--
-- Every other file attributes money to a project by SEGMENT5 and to a funding
-- type by SEGMENT2. That mapping was inferred from the Oracle DESCRIPTION text
-- in the purchase-order extract, not from the database - so it is worth
-- confirming here rather than discovering it was wrong halfway through the
-- budget queries.
--
-- The description text is the evidence to look for: if a row's SEGMENT5 is
-- 0523, its DESCRIPTION should mention Swift Creek ES. If SEGMENT5 turns out
-- to be constant instead, the project identifier is a different segment and
-- every GROUP BY in 01-04 must be changed to match.
-- ============================================================================

-- H.1 How many distinct values does each segment hold?
-- Expect one or two segments to be constant, and exactly one to be the busy
-- project identifier. In the PO sample that was SEGMENT5 with 139 values, with
-- SEGMENT1, SEGMENT3, SEGMENT6 and SEGMENT7 constant.
SELECT COUNT(DISTINCT c.segment1)                    AS seg1_fund,
       COUNT(DISTINCT c.segment2)                    AS seg2_purpose,
       COUNT(DISTINCT c.segment3)                    AS seg3_program,
       COUNT(DISTINCT c.segment4)                    AS seg4_object,
       COUNT(DISTINCT c.segment5)                    AS seg5_level,
       COUNT(DISTINCT c.segment6)                    AS seg6_cost_center,
       COUNT(DISTINCT c.segment7)                    AS seg7_future_use,
       COUNT(*)                                      AS combination_count
FROM   gl_code_combinations c;

-- H.2 Sample the combinations with their descriptions attached.
-- This is the query that proves SEGMENT5 is the project: read the names.
-- PORT: `WHERE ROWNUM <= 25` -> `LIMIT 25`. ROWNUM is applied by the enclosing
-- query, so it names a specific 25 rows only because the inline view below is
-- ordered by CODE_COMBINATION_ID. LIMIT 25 is therefore the same 25 rows.
SELECT * FROM (
  SELECT c.code_combination_id,
         c.segment1 || '-' || c.segment2 || '-' || c.segment3 || '-' ||
         c.segment4 || '-' || c.segment5 || '-' || c.segment6 || '-' ||
         c.segment7                                  AS account,
         c.segment2                                  AS purpose_code,
         c.segment4                                  AS object_code,
         c.segment5                                  AS level_code,
         c.account_type,
         c.enabled_flag,
         c.summary_flag,
         c.description
  FROM   gl_code_combinations c
  ORDER  BY c.code_combination_id
) LIMIT 25;

-- H.3 Are there OTHER charts of accounts?
-- The PO sample's CODE_COMBINATION_IDs did not overlap the COA extract's at
-- all, and the plan warns that CCID spaces are per-chart. If more than one
-- CHART_OF_ACCOUNTS_ID appears, a combination id is only meaningful alongside
-- its chart - and the joins in 01-04 must carry that column too.
SELECT c.chart_of_accounts_id,
       COUNT(*)                                      AS combination_count,
       COUNT(DISTINCT c.segment5)                    AS distinct_levels,
       MIN(c.code_combination_id)                    AS ccid_min,
       MAX(c.code_combination_id)                    AS ccid_max
FROM   gl_code_combinations c
GROUP  BY c.chart_of_accounts_id
ORDER  BY c.chart_of_accounts_id;

-- H.4 Is SUMMARY_FLAG doing anything? Only 'N' rows are real posting accounts;
-- the 01-04 files filter on this, so it matters that the filter is selective
-- rather than excluding everything.
SELECT c.summary_flag,
       COUNT(*)                                      AS combination_count
FROM   gl_code_combinations c
GROUP  BY c.summary_flag
ORDER  BY c.summary_flag;
