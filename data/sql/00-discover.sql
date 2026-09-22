--------------------------------------------------------------------------------
-- 00-discover.sql  |  Oracle EBS - budget discovery
--------------------------------------------------------------------------------
-- READ-ONLY. Every statement is a SELECT. No INSERT/UPDATE/DELETE, no DDL.
-- Objects: the EBS base tables owned by APPS - the schema they resolve under.
--          No WCSEXP_* view is referenced anywhere in data/sql; see README.
--
-- RUN THIS FIRST. It answers the one question everything else depends on:
--   does this ledger hold budget data at all?
--
-- All sections are independent - run them one at a time if you prefer.
-- If a statement fails with ORA-00942 (table or view does not exist) that is
-- itself a finding: note which section failed and continue to the next.
-- If ORA-00942 appears, retry with a different owner prefix, e.g.
-- APPS.GL_BALANCES or WCS.GL_BALANCES.
--
-- ----------------------------------------------------------------------------
-- REPORTING WINDOW: FY2025 - FY2027, the newest three fiscal years.
--
-- 01-budgets.sql .. 04-spend-and-actuals.sql restrict every MEASURE to this
-- window with the predicate:
--
--     period_year >= (SELECT MAX (period_year) - 2 FROM apps.gl_periods)
--
-- DERIVED, NEVER A LITERAL - see the full note in 01-budgets.sql. Today that
-- evaluates to FY2025, FY2026, FY2027 = 2024-07-01 .. 2027-06-30, 39 periods.
--
-- *** THIS FILE IS THE ONE EXCEPTION. *** Nothing in 00-discover.sql is
-- windowed, on purpose, and the reason is that this file's job is the opposite
-- one. "Does this ledger hold budget data at all?" is answered by the EXTENT of
-- the data - which years, how many rows, which balance flags. A windowed
-- version of section B reports the window rather than the ledger, so it would
-- answer "no budget" for a ledger whose budget is simply older than the window,
-- and everything downstream is gated on section B. Section C and the windowed
-- companion to B below are the only windowed statements here, and they are
-- marked so.
-- ----------------------------------------------------------------------------
--------------------------------------------------------------------------------


-- ============================================================================
-- A. Do budget parent tables exist?
--
-- db-schema.md lists BUDGET_VERSION_ID on GL_BALANCES but no table to name it.
-- Stock EBS keeps that in GL_BUDGET_VERSIONS / GL_BUDGET_ASSIGNMENTS. Rather
-- than guess the columns, ask the data dictionary what is actually there.
--
-- *** READ THIS BEFORE BELIEVING A ZERO-ROW RESULT. ***
-- On the EBS instance these statements were measured against, ALL THREE return
-- ZERO ROWS - and every one of the objects below DOES exist and IS reachable.
-- The reason is vocabulary: `APPS.GL_BUDGET_VERSIONS` is a SYNONYM pointing at
-- `GL.GL_BUDGET_VERSIONS#`. ALL_TABLES / ALL_VIEWS / ALL_TAB_COLUMNS describe
-- the object a synonym points AT, under the REAL owner and the REAL (trailing-#)
-- name - they do not list the synonym itself. So a query filtered by
-- TABLE_NAME = 'GL_BUDGET_VERSIONS' cannot match, and an empty result here
-- proves NO ACCESS rather than NO OBJECT.
--
-- The reliable dictionary sources on this instance are:
--     SELECT * FROM user_tab_privs;      -- 51 rows, every grant this schema has
--     SELECT * FROM all_synonyms WHERE synonym_name LIKE 'GL_%';
-- USER_TAB_PRIVS names the real objects (`GL.GL_BUDGET_VERSIONS#`). Match the
-- left-hand side of that name, not the synonym.
--
-- The control query below is kept because it is the one that catches this: if
-- it returns nothing, the dictionary queries have no access and their emptiness
-- means nothing at all. On the measured instance it returns nothing too.
-- ============================================================================

SELECT owner, table_name
FROM   all_tables
WHERE  table_name LIKE '%BUDGET%'
ORDER  BY owner, table_name;

-- Control for the query above. This MUST return GL_BALANCES and
-- GL_CODE_COMBINATIONS. If it returns nothing then the dictionary query has no
-- access and its empty result proves nothing at all - it does NOT mean
-- "no budget tables exist".
SELECT owner, table_name
FROM   all_tables
WHERE  table_name IN ('GL_BALANCES', 'GL_CODE_COMBINATIONS')
ORDER  BY table_name;

-- The control that DOES work here. Run this next to the two above and the
-- difference is the whole point of the note: same intent, real answers.
SELECT privilege, owner, table_name
FROM   user_tab_privs
WHERE  table_name LIKE '%BUDGET%'
ORDER  BY owner, table_name;

-- Same question across views: a budget object may be a view, not a table.
SELECT owner, view_name
FROM   all_views
WHERE  view_name LIKE '%BUDGET%'
ORDER  BY owner, view_name;

-- Shape of the budget-version table. Run only if GL_BUDGET_VERSIONS appeared
-- above - and note that it will NOT appear, for the reason in the header. The
-- working form uses the real owner and the trailing-# name:
SELECT column_name, data_type, data_length, nullable
FROM   all_tab_columns
WHERE  table_name IN ('GL_BUDGET_VERSIONS', 'GL_BUDGET_VERSIONS#')
ORDER  BY table_name, column_id;


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
       DECODE(b.actual_flag,
              'A', 'Actual',
              'B', 'BUDGET',
              'E', 'Encumbrance',
                   '(other)')                       AS balance_type,
       COUNT(*)                                     AS row_count,
       COUNT(DISTINCT b.code_combination_id)        AS combo_count,
       COUNT(DISTINCT b.period_name)                AS period_count,
       COUNT(DISTINCT b.budget_version_id)          AS version_count,
       MIN(b.period_year)                           AS year_min,
       MAX(b.period_year)                           AS year_max,
       TO_CHAR(ROUND(SUM(NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0)), 2),
               'FM999,999,999,999,990.00')          AS period_net_dr_less_cr
FROM   apps.gl_balances b
GROUP  BY b.actual_flag
ORDER  BY b.actual_flag;

-- B.windowed - WINDOWED. The same breakdown, restricted to FY2025-FY2027.
--
-- This is a COMPANION to the query above, not a correction of it. The query
-- above sizes the ledger; this one sizes the window inside it, and the pair is
-- what tells you whether the window is a filter or a truncation: if 'B' appears
-- above and not here, there IS a budget but it ends before FY2025, and every
-- measure in 01-budgets.sql would report it as zero.
SELECT b.actual_flag,
       DECODE(b.actual_flag,
              'A', 'Actual',
              'B', 'BUDGET',
              'E', 'Encumbrance',
                   '(other)')                       AS balance_type,
       COUNT(*)                                     AS row_count,
       COUNT(DISTINCT b.code_combination_id)        AS combo_count,
       COUNT(DISTINCT b.period_name)                AS period_count,
       MIN(b.period_year)                           AS year_min,
       MAX(b.period_year)                           AS year_max,
       TO_CHAR(ROUND(SUM(NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0)), 2),
               'FM999,999,999,999,990.00')          AS period_net_dr_less_cr
FROM   apps.gl_balances b
WHERE  b.period_year >= (SELECT MAX (period_year) - 2 FROM apps.gl_periods)
GROUP  BY b.actual_flag
ORDER  BY b.actual_flag;


-- ============================================================================
-- C. Which budget versions and encumbrance types are present?
--    WINDOWED.
--
-- Decides whether a budget needs a version picker (several versions) or is a
-- single fixed number. BUDGET_VERSION_ID is part of GL_BALANCES' primary key,
-- so a non-null value on 'B' rows identifies which version each amount is for.
--
-- This section IS windowed, unlike B, because it is not sizing the ledger - it
-- is describing the versions the application will actually offer in its picker,
-- and a version with no rows inside the window is not a version the picker
-- should show. The versions that exist outside the window are visible in B.
-- ============================================================================

SELECT b.actual_flag,
       b.budget_version_id,
       b.encumbrance_type_id,
       b.ledger_id,
       COUNT(*)                                     AS row_count,
       COUNT(DISTINCT b.code_combination_id)        AS combo_count,
       COUNT(DISTINCT b.period_name)                AS period_count,
       MIN(b.period_year)                           AS year_min,
       MAX(b.period_year)                           AS year_max,
       TO_CHAR(ROUND(SUM(NVL(b.period_net_dr, 0) - NVL(b.period_net_cr, 0)), 2),
               'FM999,999,999,999,990.00')          AS period_net_dr_less_cr
FROM   apps.gl_balances b
WHERE  b.period_year >= (SELECT MAX (period_year) - 2 FROM apps.gl_periods)
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
       DECODE(h.actual_flag,
              'A', 'Actual',
              'B', 'BUDGET',
              'E', 'Encumbrance',
                   '(other)')                       AS balance_type,
       h.je_category,
       h.je_source,
       h.status,
       COUNT(*)                                     AS header_count,
       MIN(h.period_name)                           AS period_min,
       MAX(h.period_name)                           AS period_max,
       MIN(h.date_created)                          AS created_min,
       MAX(h.date_created)                          AS created_max
FROM   apps.gl_je_headers h
GROUP  BY h.actual_flag, h.je_category, h.je_source, h.status
ORDER  BY h.actual_flag, h.je_category, h.je_source, h.status;

-- Do budget journal headers have lines? Without lines an adjustment is only
-- visible as period movement, not as an individual entry with an amount.
SELECT h.actual_flag,
       COUNT(DISTINCT h.je_header_id)               AS headers,
       COUNT(l.je_header_id)                        AS header_line_matches
FROM   apps.gl_je_headers h
LEFT   JOIN apps.gl_je_lines l ON l.je_header_id = h.je_header_id
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
FROM   apps.gl_lookups l
WHERE  UPPER(l.lookup_type) LIKE '%BUDGET%'
   OR  UPPER(l.lookup_type) LIKE '%CATEGORY%'
   OR  UPPER(l.lookup_type) LIKE '%ENCUMBRANCE%'
ORDER  BY l.lookup_type, l.lookup_code;

-- E.2 Every GL lookup type that exists - in case budget categories sit under a
-- name that E.1's filter missed.
SELECT l.lookup_type,
       COUNT(*)                                     AS code_count
FROM   apps.gl_lookups l
GROUP  BY l.lookup_type
ORDER  BY l.lookup_type;


-- ============================================================================
-- F. Budget version names.
--
-- *** THIS SECTION WAS WRONG AND IS NOW REPAIRED. ***
--
-- What it used to do: select v.date_created, v.ledger_id, v.start_period_name
-- and v.end_period_name from apps.gl_budget_versions, with a note saying to
-- adjust the list once section A printed the real columns. It failed with
-- ORA-00904: "V"."DATE_CREATED" - a column that does not exist on that table.
--
-- Two things were wrong, and they compounded:
--
--   1. THE COLUMNS. GL_BUDGET_VERSIONS has no DATE_CREATED, no LEDGER_ID, and
--      no START_PERIOD_NAME / END_PERIOD_NAME. Its 25 columns are:
--          BUDGET_VERSION_ID  LAST_UPDATE_DATE      LAST_UPDATED_BY
--          BUDGET_TYPE        BUDGET_NAME           VERSION_NUM
--          STATUS             DATE_OPENED           CREATION_DATE
--          CREATED_BY         LAST_UPDATE_LOGIN     DESCRIPTION
--          DATE_ACTIVE        DATE_ARCHIVED         ATTRIBUTE1..8
--          CONTEXT            CONTROL_BUDGET_VERSION_ID   IGI_BUD_NYC_FLAG
--      So DATE_CREATED becomes CREATION_DATE and the three others are dropped.
--      The ledger link is NOT in GL_BUDGET_ASSIGNMENTS either - see the note
--      under the second query below, which is where that assumption was
--      finally measured instead of assumed.
--
--   2. THE INSTRUCTION TO WAIT FOR SECTION A. Section A cannot supply this.
--      Its dictionary queries filter by the SYNONYM's name, and on this
--      instance they match nothing - the objects are reached as GL.GL_...#
--      through synonyms under APPS. The advice "adjust once A prints the names"
--      was therefore advice to wait for something that never arrives, and it is
--      why the bad column list survived into a file whose whole purpose is to
--      check assumptions. The names above come from USER_TAB_PRIVS plus
--      ALL_TAB_COLUMNS queried on the real object, not from section A.
-- ============================================================================

SELECT v.budget_version_id,
       v.budget_name,
       v.budget_type,
       v.version_num,
       v.status,
       v.description,
       v.date_opened,
       v.date_active,
       v.date_archived,
       v.creation_date
FROM   apps.gl_budget_versions v
ORDER  BY v.budget_version_id;

-- MEASURED on the EBS instance: 2 rows, and both are old.
--   1000  WCPSS           status F  opened 1999-11-11
--   1001  WCPSS BUDGET    status C  opened 2000-07-05
-- So this ledger has exactly two budget versions, neither of them recent.
-- BUDGET_TYPE ('standard') is a LOOKUP CODE, not a name - GL_BUDGET_TYPES
-- resolves it. STATUS ('F', 'C') is likewise a code, resolved in GL_LOOKUPS.
-- Neither is a label to print as-is.

-- *** THE SECOND QUERY HERE USED TO JOIN A COLUMN THAT DOES NOT EXIST. ***
--
-- It was written as a LEFT JOIN of GL_BUDGET_ASSIGNMENTS on
-- a.budget_version_id = v.budget_version_id, and it fails with
-- ORA-00904: "A"."BUDGET_VERSION_ID". That column is not on the table. The
-- measured 30 columns of GL.GL_BUDGET_ASSIGNMENTS# are:
--   LEDGER_ID  BUDGET_ENTITY_ID  CURRENCY_CODE  CODE_COMBINATION_ID  RANGE_ID
--   ENTRY_CODE  LAST_UPDATE_DATE  LAST_UPDATED_BY  AUTOMATIC_ENCUMBRANCE_FLAG
--   FUNDS_CHECK_LEVEL_CODE  ORDERING_VALUE  CREATION_DATE  CREATED_BY
--   LAST_UPDATE_LOGIN  ATTRIBUTE1..8  CONTEXT  AMOUNT_TYPE  BOUNDARY_CODE
--   FUNDING_BUDGET_VERSION_ID  PROGRAM_APPLICATION_ID  PROGRAM_ID
--   PROGRAM_UPDATE_DATE  REQUEST_ID
--
-- The one version-bearing column there is FUNDING_BUDGET_VERSION_ID, and the
-- obvious repair is to join on that instead. It does not work either: that
-- column is NULL on all 234,074 rows. GL_BUDGET_ENTITIES is the other
-- candidate, and it has no version column at all - its 60 columns are the
-- entity name and ledger plus SEGMENT1..30_TYPE. Both tables were measured
-- before this comment was written, because writing a second unverified join
-- into the one file whose job is to check assumptions is the exact mistake
-- above.
--
-- WHAT THE TABLES ACTUALLY ARE, then. GL_BUDGET_ASSIGNMENTS is a funds-check
-- table here: 234,074 rows, one per CODE_COMBINATION_ID, spread over 7 budget
-- entities, all on one ledger, with FUNDING_BUDGET_VERSION_ID empty throughout.
-- GL_BUDGET_ENTITIES holds 8 rows with names like 'Fund 1'. Neither of them
-- connects a row to a budget version, so on this instance there is no
-- version-to-ledger link to fetch.
--
-- AND THE QUESTION DISSOLVES ANYWAY. There is exactly ONE ledger:
--
--   LEDGER_ID 1   Wake County Public Schools   USD   chart_of_accounts_id 101
--   period_set_name 'Accounting'
--
-- One row. Every budget version in this database belongs to it, so there is no
-- version-to-ledger question to answer and no join worth writing. That is the
-- useful finding - not a repaired query, but the reason the query is
-- unnecessary. If a second ledger is ever added, this section will need the
-- link, and the note above says where it is not.
SELECT l.ledger_id,
       l.name,
       l.currency_code,
       l.chart_of_accounts_id,
       l.period_set_name
FROM   apps.gl_ledgers l
ORDER  BY l.ledger_id;


-- ============================================================================
-- G. Segment meanings.
--
-- *** THIS SECTION WAS ALSO WRONG AND IS NOW REPAIRED. ***
--
-- What it used to do: select s.description from apps.fnd_id_flex_structures.
-- It failed with ORA-00904: "S"."DESCRIPTION" - and that table genuinely has no
-- DESCRIPTION column, so this was not a naming variant. FND_ID_FLEX_STRUCTURES
-- describes a STRUCTURE; the segment names live in FND_ID_FLEX_SEGMENTS, one
-- row per segment of the structure. The fix is the join, not a renamed column.
--
-- FND_ID_FLEX_STRUCTURES has 20 columns and the useful ones here are
-- ID_FLEX_CODE ('GL#' for the accounting flexfield), ID_FLEX_NUM,
-- ID_FLEX_STRUCTURE_CODE, CONCATENATED_SEGMENT_DELIMITER, ENABLED_FLAG.
--
-- FND_ID_FLEX_SEGMENTS has 29 columns; SEGMENT_NAME (the word for the segment),
-- SEGMENT_NUM (its position), APPLICATION_COLUMN_NAME (the column it is stored
-- in - SEGMENT1..SEGMENT7 here) and FLEX_VALUE_SET_ID (which value set it reads
-- from) are the four that matter. Note the value set: a legend that joins the
-- wrong FLEX_VALUE_SET_ID silently names the wrong values, which is exactly the
-- defect recorded against V_SEGMENT_LEGEND.
--
-- MEASURED, AND THIS IS THE ANSWER THIS FILE EXISTED TO FIND. The filter is
-- 'GL#' because that is the accounting flexfield, and it returns exactly 7 rows
-- - the seven segments, in order, for STRUCTURE ACCOUNTING_FLEXFIELD
-- (ID_FLEX_NUM 101), delimiter '.':
--
--   1  Fund           SEGMENT1   1002645
--   2  Purpose        SEGMENT2   1002646
--   3  Program        SEGMENT3   1002647
--   4  Object         SEGMENT4   1002648
--   5  Level          SEGMENT5   1002649      <-- *** see below ***
--   6  Cost Center    SEGMENT6   1002650
--   7  Future Use     SEGMENT7   1002651
--
-- ★ SEGMENT5 IS 'Level'. The application treats segment 5 as the project
-- identifier - 'Level 0454', one per construction project - and until now that
-- was an inference from the data shape. The data dictionary states it directly,
-- and names the value set it reads from (1002649), so a legend can be built
-- from FLEX_VALUE / FLEX_VALUE_SET_ID = 1002649 rather than guessed at. The
-- delimiter '.' also matches the concatenated code_combination strings seen
-- elsewhere in these files (e.g. 05.7200.035.451.0140.0880.000), which is a
-- second, independent confirmation that the segment order above is the real one.
--
-- Unfiltered, this join returns 1248 rows - every segment of every flexfield
-- defined on the instance. That is the query to run if you want to see which
-- other flexfields exist; it is not the one to run for the seven names.
-- ============================================================================

SELECT s.id_flex_num,
       s.id_flex_code,
       s.id_flex_structure_code,
       s.enabled_flag,
       s.concatenated_segment_delimiter,
       g.segment_num,
       g.segment_name,
       g.application_column_name,
       g.flex_value_set_id
FROM   apps.fnd_id_flex_structures s
JOIN   apps.fnd_id_flex_segments g
       ON  g.id_flex_code = s.id_flex_code
       AND g.id_flex_num  = s.id_flex_num
WHERE  s.id_flex_code = 'GL#'
ORDER  BY s.id_flex_num, g.segment_num;

-- The values behind segment 5, now that the value set is known by name rather
-- than by assumption. This is what makes 'Level' a label instead of a number.
--
-- NOTICE THE JOIN, because the obvious version of this query does not work.
-- The shape everyone reaches for is FND_FLEX_VALUES_VL, and on this instance
-- that returns ORA-00942: table or view does not exist - it is not in the
-- grant list. FND_FLEX_VALUES alone has 71 columns and DESCRIPTION is not one
-- of them; the name lives in FND_FLEX_VALUES_TL, keyed by FLEX_VALUE_ID. The
-- join below is that route, and it returns 2390 rows for this value set.
--
-- That is the same lesson as section A, in a smaller place: on this instance
-- the convenient object is the un-granted one, and the two-table route is the
-- one that works.
SELECT v.flex_value, t.description
FROM   apps.fnd_flex_values v
JOIN   apps.fnd_flex_values_tl t
       ON t.flex_value_id = v.flex_value_id
WHERE  v.flex_value_set_id = 1002649
ORDER  BY v.flex_value;


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
FROM   apps.gl_code_combinations c;

-- H.2 Sample the combinations with their descriptions attached.
-- This is the query that proves SEGMENT5 is the project: read the names.
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
  FROM   apps.gl_code_combinations c
  ORDER  BY c.code_combination_id
) WHERE ROWNUM <= 25;

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
FROM   apps.gl_code_combinations c
GROUP  BY c.chart_of_accounts_id
ORDER  BY c.chart_of_accounts_id;

-- H.4 Is SUMMARY_FLAG doing anything? Only 'N' rows are real posting accounts;
-- the 01-04 files filter on this, so it matters that the filter is selective
-- rather than excluding everything.
SELECT c.summary_flag,
       COUNT(*)                                      AS combination_count
FROM   apps.gl_code_combinations c
GROUP  BY c.summary_flag
ORDER  BY c.summary_flag;
