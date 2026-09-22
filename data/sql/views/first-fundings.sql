-- ============================================================================
--  FIRST FUNDINGS ONLY
--  Library query for the View Builder (docs/ideas/view-builder.md,
--  "Sample query"). It answers: for each code combination, WHEN was it first
--  funded, and for HOW MUCH.
--
--  Shape of the result — this is the table the idea file illustrates:
--
--      CODE_COMBINATION              | FUNDING_AMOUNT | FIRST_FUNDING_DATE
--      ------------------------------+----------------+-------------------
--      04.6570.862.526.0450.0840.000 |   1000000.0    | 2022-07-01
--      04.6570.862.527.0450.0840.000 |  40000000.0    | 2024-07-01
--      04.6570.862.529.0450.0840.000 |    300000.0    | 2025-01-01
--      04.6570.862.532.0450.0840.000 |    541624.93   | 2025-10-01
--
--  ---------------------------------------------------------------------------
--  THE DATE MUST COME FROM THE JOURNAL, NOT FROM THE PERIOD.
--  ---------------------------------------------------------------------------
--  00-schema.sql says it plainly on GL_JE_HEADERS.DEFAULT_EFFECTIVE_DATE:
--  "when was this funded?" — GL_BALANCES is a per-period rollup and loses the
--  action date; the journal keeps it.
--
--  A tempting rewrite is "the earliest PERIOD_NAME in GL_BALANCES where the net
--  is non-zero", and it is WRONG in two ways at once. Measured on the sample:
--
--      combination                   | funding_amount | period | period_start
--      04.6570.862.526.0450.0840.000 |        7738830 | JUL-22 |   2022-07-01
--      04.6570.862.527.0450.0840.000 |       89828010 | JUL-22 |   2022-07-01
--      04.6570.862.529.0450.0840.000 |         936025 | JUL-22 |   2022-07-01
--      04.6570.862.532.0450.0840.000 |         287468 | JUL-22 |   2022-07-01
--
--    * Every date collapses to JUL-22, so the view reports nothing that varies.
--    * 526's amount is 7,738,830 = 1,000,000 + 6,738,830 — the same period
--      carries rows in TWO budget versions (501, the FY23 appropriation, and
--      503, the approved capital budget) and the naive GROUP BY sums them.
--
--  Both errors trace to the grain inversion documented on GL_BUDGET_VERSIONS:
--  a version spans a budget TYPE, funding is per code COMBINATION, so the
--  version's first period is not the code's first funded period. Budget version
--  503 parks the whole approved capital budget in JUL-22 for every account; it
--  is a total, not a first funding, and it is precisely the kind of
--  plausible-looking wrong number this build exists to avoid.
--
--  ---------------------------------------------------------------------------
--  FILTERS, AND WHY EACH ONE IS HERE
--  ---------------------------------------------------------------------------
--    h.ACTUAL_FLAG = 'B'          Budget journals. 'A' and 'E' journals are
--                                 spend and encumbrance — activity on an
--                                 account, not funding of it.
--    h.LEDGER_ID IN (PRIMARY)     The primary ledger only. Ledger 2002
--                                 (SECONDARY) carries a 6,738,830.00 copy of
--                                 526's capital budget; including it double
--                                 counts the same money.
--    cc.SUMMARY_FLAG = 'N'        'Y' marks a rollup parent whose children are
--                                 already in the set.
--    cc.ENABLED_FLAG = 'Y'        A disabled account's historical balances
--                                 persist and would otherwise appear funded.
--
--  ---------------------------------------------------------------------------
--  DIALECT
--  ---------------------------------------------------------------------------
--  SQLite / libSQL. Dates are stored as TEXT 'YYYY-MM-DD HH:MM:SS', so
--  SUBSTR(...,1,10) is how the day is taken and a lexicographic ORDER BY on
--  that text is already chronological. On Oracle replace it with
--  TO_CHAR(h.DEFAULT_EFFECTIVE_DATE,'YYYY-MM-DD').
--  No FETCH FIRST: the dialect port cannot support it (see
--  docs/plans/turso-sample-db-plan.md §3). ROW_NUMBER() does the job and works
--  in both dialects.
-- ============================================================================

WITH funded AS (
  -- One row per (combination, action date): the money moved that day.
  SELECT l.CODE_COMBINATION_ID       AS ccid,
         h.DEFAULT_EFFECTIVE_DATE    AS funded_on,
         SUM(l.ENTERED_DR - l.ENTERED_CR) AS amount
    FROM GL_JE_LINES   l
    JOIN GL_JE_HEADERS h ON h.JE_HEADER_ID = l.JE_HEADER_ID
   WHERE h.ACTUAL_FLAG       = 'B'
     AND h.DEFAULT_EFFECTIVE_DATE IS NOT NULL
     AND h.LEDGER_ID IN (SELECT LEDGER_ID FROM GL_LEDGERS
                          WHERE LEDGER_CATEGORY_CODE = 'PRIMARY')
   GROUP BY l.CODE_COMBINATION_ID, h.DEFAULT_EFFECTIVE_DATE
),
first_funding AS (
  -- Grouping above makes (ccid, funded_on) unique, so rn = 1 is exactly one
  -- row per combination and needs no tie-break beyond a deterministic order.
  SELECT ccid, funded_on, amount,
         ROW_NUMBER() OVER (PARTITION BY ccid ORDER BY funded_on) AS rn
    FROM funded
)
SELECT k.COMBINATION_KEY              AS CODE_COMBINATION,
       ff.amount                      AS FUNDING_AMOUNT,
       SUBSTR(ff.funded_on, 1, 10)    AS FIRST_FUNDING_DATE
  FROM first_funding          ff
  JOIN V_CODE_COMBINATION_KEY k  ON k.CODE_COMBINATION_ID  = ff.ccid
  JOIN GL_CODE_COMBINATIONS   cc ON cc.CODE_COMBINATION_ID = ff.ccid
 WHERE ff.rn = 1
   AND cc.SUMMARY_FLAG = 'N'
   AND cc.ENABLED_FLAG = 'Y'
 ORDER BY k.COMBINATION_KEY;
