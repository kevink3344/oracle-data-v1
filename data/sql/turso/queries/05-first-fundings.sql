--------------------------------------------------------------------------------
-- 05-first-fundings.sql  |  When was each code combination first funded?
--
-- READ-ONLY. Every statement is a SELECT. No INSERT/UPDATE/DELETE, no DDL.
--
-- This is the query behind the View Builder's first view
-- (docs/ideas/view-builder.md, "FIRST FUNDINGS ONLY"). It answers, per code
-- combination: WHEN was it first funded, and for HOW MUCH.
--
--      CODE_COMBINATION              | FUNDING_AMOUNT | FIRST_FUNDING_DATE
--      ------------------------------+----------------+-------------------
--      04.6570.862.526.0450.0840.000 |        1000000 | 2022-07-01
--      04.6570.862.527.0450.0840.000 |       40000000 | 2024-07-01
--      04.6570.862.529.0450.0840.000 |         300000 | 2025-01-01
--      04.6570.862.532.0450.0840.000 |       541624.93 | 2025-10-01
--
-- FF1 is the view. FF2 is the query FF1 is NOT, kept because the difference is
-- the whole point of the feature and the wrong answer is plausible on sight.
--------------------------------------------------------------------------------

-- ============================================================================
-- ORIGIN - read this before assuming it is a port.
--
-- Unlike 00..04, this file is NOT a translation of an Oracle original in
-- ../. The idea file's own "Sample query" is written for Oracle against
-- :s1..:s7 bind variables and returns ONE account; this generalises it to
-- every account at once, which is what a *view* needs. There is therefore no
-- ../05-*.sql artefact of record and no PORT NOTES section below, because
-- there is no mechanical translation to document. The Oracle form of each
-- non-portable construct is named at its site instead.
-- ============================================================================


-- ============================================================================
-- FF1. First funding per code combination.   Expect 4 rows on the sample.
--
-- THE DATE MUST COME FROM THE JOURNAL, NOT FROM THE PERIOD.
--
-- 00-schema.sql says it on GL_JE_HEADERS.DEFAULT_EFFECTIVE_DATE: "when was
-- this funded?" - GL_BALANCES is a per-period rollup and loses the action
-- date; the journal keeps it. A funding that lands mid-period has no period
-- start to stand in for it, so the period can only ever approximate the date.
--
-- FILTERS, AND WHY EACH ONE IS HERE. Four of the five GL_BALANCES filters in
-- 03-notes.sql section 4 do not apply: this reads the journal, not balances.
-- What survives, and what replaces the rest:
--
--   h.ACTUAL_FLAG = 'B'        Budget journals only. 'A' and 'E' journals are
--                              spend and encumbrance - activity ON an account,
--                              not funding OF it. The sample journals are all
--                              'B'; on production they will not be.
--   h.LEDGER_ID IN (PRIMARY)   The primary ledger only. Ledger 2002
--                              (SECONDARY) carries a second 6,738,830.00 copy
--                              of 526's capital budget; without this filter
--                              526's first funding doubles. Same trap as
--                              GL_BALANCES filter 4, reached by a different
--                              route - GL_LEDGERS is a base table with no
--                              view in front of it, so it is the one table
--                              here that was always read unprefixed.
--   cc.SUMMARY_FLAG = 'N'      'Y' marks a rollup parent whose children are
--                              already in the set.
--   cc.ENABLED_FLAG = 'Y'      A disabled account's history persists and would
--                              otherwise report as funded.
--
-- GRAIN. Grouping to (combination, action date) first makes the window's
-- ORDER BY decisive: several journal lines can post to one account on one day
-- (the 526 appropriation and a later reallocation share JUL-22), and summing
-- them before the ROW_NUMBER is what makes "the amount funded that day" a
-- single number rather than an arbitrary one of several. rn = 1 is then
-- exactly one row per combination, so no tie-break is needed.
--
-- WHY NOT ROWNUM. ../04-spend-and-actuals.sql and friends cap with
-- `WHERE ROWNUM <= n` because Oracle 11g has no FETCH FIRST; the port turns
-- those into LIMIT n. Neither works here: the cap is per PARTITION, not per
-- result - it is "the earliest date within each account", which is
-- ROW_NUMBER() OVER (PARTITION BY ...). That is native on both SQLite 3.45.1
-- and every Oracle since 8i, so it needs no translation in either direction.
--
-- WHY THE KEY IS DOTTED. `V_CODE_COMBINATION_KEY` concatenates the seven
-- segments with '.', which is the form the report grid and the idea file both
-- print ('04.6570.862.526.0450.0840.000'). The keys built inline in 02..04 are
-- hyphen-joined because they are ad-hoc labels for a human reading a terminal;
-- this one is data, so it keeps the canonical separator. On Oracle, build it
-- the same way from APPS.GL_CODE_COMBINATIONS rather than relying on a view
-- that may not exist there.
--
-- SUBSTR(ff.funded_on, 1, 10) takes the day off a TEXT 'YYYY-MM-DD HH:MM:SS'.
-- Lexicographic ORDER BY on that text is already chronological, which is why
-- the ORDER BY is inside the window and not on a parsed date. Oracle stores a
-- real DATE, so the two substitutions are SUBSTR -> TO_CHAR(<date>,'YYYY-MM-DD')
-- and the TEXT comparison -> a date comparison.
-- ============================================================================
WITH funded AS (
  -- One row per (combination, action date): what moved that day.
  SELECT l.CODE_COMBINATION_ID            AS ccid,
         h.DEFAULT_EFFECTIVE_DATE         AS funded_on,
         SUM(l.ENTERED_DR - l.ENTERED_CR) AS amount
    FROM GL_JE_LINES   l
    JOIN GL_JE_HEADERS h ON h.JE_HEADER_ID = l.JE_HEADER_ID
   WHERE h.ACTUAL_FLAG = 'B'
     AND h.DEFAULT_EFFECTIVE_DATE IS NOT NULL
     AND h.LEDGER_ID IN (SELECT LEDGER_ID FROM GL_LEDGERS
                          WHERE LEDGER_CATEGORY_CODE = 'PRIMARY')
   GROUP BY l.CODE_COMBINATION_ID, h.DEFAULT_EFFECTIVE_DATE
),
first_funding AS (
  SELECT ccid, funded_on, amount,
         ROW_NUMBER() OVER (PARTITION BY ccid ORDER BY funded_on) AS rn
    FROM funded
)
SELECT k.combination_key         AS code_combination,
       ff.amount                 AS funding_amount,
       SUBSTR(ff.funded_on, 1, 10) AS first_funding_date
  FROM first_funding             ff
  JOIN V_CODE_COMBINATION_KEY     k ON k.code_combination_id  = ff.ccid
  JOIN GL_CODE_COMBINATIONS c ON c.code_combination_id = ff.ccid
 WHERE ff.rn = 1
   AND c.summary_flag = 'N'
   AND c.enabled_flag = 'Y'
 ORDER BY k.combination_key;


-- ============================================================================
-- FF2. The query FF1 is NOT, kept as evidence.   Expect 6 rows on the sample.
--
-- "The earliest period in GL_BALANCES whose net is non-zero" is the obvious
-- way to answer the same question. It is wrong FOUR ways at once, and every
-- one of them is silent: the query returns, the numbers are plausible, and
-- nothing indicates a problem. It returns 6 rows where FF1 returns 4.
--
--      combination                    | amount    | period | yr   | pnum
--      -------------------------------+-----------+--------+------+-----
--      04.6570.862.000.0450.0840.000  |  97790333 | JUL-22 | 2023 |    1
--      04.6570.862.526.0450.0840.000  |   7738830 | JUL-22 | 2023 |    1
--      04.6570.862.527.0450.0840.000  |  89828010 | JUL-22 | 2023 |    1
--      04.6570.862.529.0450.0840.000  |    936025 | JUL-22 | 2023 |    1
--      04.6570.862.532.0450.0840.000  |    287468 | JUL-22 | 2023 |    1
--      04.6570.862.599.0450.0840.000  |   1000000 | JUL-22 | 2023 |    1
--
--   1. EVERY DATE COLLAPSES TO JUL-22. The date column is constant, so the
--      view would report nothing that varies while looking perfectly
--      well-formed. Budget version 503 parks each account's whole approved
--      capital budget in JUL-22; it is a TOTAL, not a first funding.
--   2. 526 REPORTS 7,738,830 INSTEAD OF 1,000,000. That is
--      1,000,000 + 6,738,830: the same period carries rows in TWO budget
--      versions - 501 (the FY23 appropriation) and 503 - and the GROUP BY
--      sums them. FF1 gives 1,000,000, the FY23 appropriation, because that
--      is the earlier of the two ACTION DATES.
--   3. TWO ACCOUNTS APPEAR THAT SHOULD NOT, and there are TWO rows too many
--      because of it. FF2 keeps the balance-side filters but drops the two
--      that live on the code combination, so the rollup parent
--      04.6570.862.000.0450.0840.000 reports 97,790,333 - its CHILDREN'S
--      money, already inside the four rows below it - and the disabled
--      account 04.6570.862.599.0450.0840.000 reports 1,000,000 of history
--      that is no longer open. These are exactly the two traps 03-notes.sql
--      section 4 engineers for GL_BALANCES filters 5; they are reachable from
--      the journal side as well, which is why FF1 applies cc.SUMMARY_FLAG and
--      cc.ENABLED_FLAG on top of its journal filters.
--
-- 1 and 2 trail back to the grain inversion documented on GL_BUDGET_VERSIONS:
-- a version spans a budget TYPE, funding is per code COMBINATION, so the
-- version's first period is not the code's first funded period. 3 is a
-- different lesson - the guards live on TWO tables, and a query that joins
-- both has to carry both sets. Taking one set is enough to look curated.
--
-- Ordered by PERIOD_YEAR and PERIOD_NUM, never by PERIOD_NAME: 'JUL-22' is a
-- string and sorts wrong as text. `earliest` is the per-account minimum of
-- year*1000+num, so this prints the earliest non-zero period per combination -
-- the same one-row-per-account shape as FF1, which is what makes the two
-- side by side comparable rather than merely different.
-- ============================================================================
WITH budget AS (
  SELECT b.code_combination_id            AS ccid,
         b.period_name                    AS period,
         b.period_year                    AS period_year,
         b.period_num                     AS period_num,
         SUM(b.period_net_dr - b.period_net_cr) AS amount
    FROM GL_BALANCES b
    JOIN GL_BUDGET_VERSIONS bv ON bv.budget_version_id = b.budget_version_id
   WHERE b.actual_flag          = 'B'
     AND b.translated_flag      = 'N'
     AND b.currency_code        = 'USD'
     AND b.encumbrance_type_id IS NULL
     AND b.ledger_id IN (SELECT ledger_id FROM GL_LEDGERS
                                WHERE ledger_category_code = 'PRIMARY')
   GROUP BY b.code_combination_id, b.period_name, b.period_year, b.period_num
  HAVING SUM(b.period_net_dr - b.period_net_cr) <> 0
),
earliest AS (
  SELECT ccid, MIN(period_year * 1000 + period_num) AS k
    FROM budget GROUP BY ccid
)
SELECT k.combination_key  AS code_combination,
       b.amount           AS amount,
       b.period           AS wrong_period,
       b.period_year      AS period_year,
       b.period_num       AS period_num
  FROM budget b
  JOIN earliest e ON e.ccid = b.ccid
                 AND e.k    = b.period_year * 1000 + b.period_num
  JOIN V_CODE_COMBINATION_KEY k ON k.code_combination_id = b.ccid
 ORDER BY k.combination_key;
