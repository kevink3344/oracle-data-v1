-- ============================================================================
--  02-views.sql — THE LEDGER VIEWS, IN MYSQL
--
--  The MySQL translation of the two app-relevant views that exist on the SQL
--  Server mirror. A third view, `database_firewall_rules`, is a `sys.` SYSTEM
--  view — it is not app data and is deliberately not translated.
--
--  ★★ WHY THESE EXIST AT ALL, GIVEN `db/derived.ts` COMPOSES THREE OTHER VIEWS.
--
--  There are TWO different kinds of view in this app, and conflating them is the
--  mistake this header exists to prevent:
--
--    1. THE THREE COMPOSED VIEWS — `V_ACCOUNT_POSITION`,
--       `V_BUDGET_BY_ACCOUNT_PERIOD`, `V_SEGMENT_LEGEND`. These are NOT created
--       anywhere on a non-libSQL backend: `db/derived.ts` inlines their bodies as
--       SQL fragments, because the seeded definitions join columns the real
--       instance does not have (`GL_BUDGET_TYPES.BUDGET_TYPE_ID`, …). Composing
--       them is what makes the names readable at all, and `derivedPlan()` is the
--       only legitimate way to reach them. **They must NOT be created here** — a
--       real view would shadow the composition and reintroduce the missing-column
--       failure the composition exists to avoid.
--
--    2. THE TWO VIEWS BELOW. These are read BY NAME from a route
--       (`routes/spend.ts` reads `V_ENCUMBRANCE_FROM_PO`; `routes/coa.ts` and
--       `routes/funding.ts` build the key via `V_CODE_COMBINATION_KEY`), and
--       `db/derived.ts` has no entry for either — so the name falls through to the
--       ledger and must EXIST there.
--
--  ★ SO THE TEST IS NOT "is it a view?" BUT "does `derived.ts` compose it?".
--    A view that is composed must not be created; a view that is read by name must
--    be. Getting that backwards produces a failure that names the wrong thing.
--
--  ★★ `ISNULL` BECOMES `COALESCE` — AND MYSQL HAS `IFNULL` TOO, WHICH IS WHY THIS
--     IS WORTH A NOTE. The source uses T-SQL's `ISNULL(x, 0)`. MySQL accepts
--     `IFNULL(x, 0)` as the direct equivalent, and `COALESCE` as the portable one.
--     `COALESCE` is used here because it is the standard spelling and matches what
--     `db/sql.ts` already emits elsewhere — one function name across the codebase
--     rather than two that mean the same thing.
--
--  ★★ `+` FOR STRING CONCATENATION BECOMES `||` — AND THAT IS ONLY SAFE BECAUSE OF
--     THE DRIVER'S SESSION MODE. T-SQL concatenates with `+`; MySQL uses `||`
--     ONLY when `PIPES_AS_CONCAT` is set in `sql_mode`, and otherwise reads it as
--     LOGICAL OR — silently returning `1` instead of the joined key. The MySQL
--     driver sets that flag on every connection (`db/mysql.ts` `ensureMode`), so
--     `||` is correct here. **A view created by hand, outside the app, would get
--     `1` for every key.** If this file is ever applied by another tool, that tool
--     must set the same mode.
-- ============================================================================


-- ----------------------------------------------------------------------------
--  V_CODE_COMBINATION_KEY — the seven segments joined with dots.
--
--  The durable account key: `04.6570.862.527.0450.0840.000`. Every route that
--  needs to name an account combination readably builds it this way, and
--  `routes/coa.ts` documents that the ORDER is load-bearing — the segments are
--  joined in segment order, so the key is stable and comparable as a string.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW V_CODE_COMBINATION_KEY AS
  SELECT CODE_COMBINATION_ID,
         CHART_OF_ACCOUNTS_ID,
         ACCOUNT_TYPE,
         ENABLED_FLAG,
         SUMMARY_FLAG,
         CONCAT_WS('.', SEGMENT1, SEGMENT2, SEGMENT3, SEGMENT4,
                        SEGMENT5, SEGMENT6, SEGMENT7) AS COMBINATION_KEY
    FROM GL_CODE_COMBINATIONS;

--  ★ `CONCAT_WS` RATHER THAN `||`, AND IT IS THE STRICTLY BETTER CHOICE HERE.
--    Both produce `04.6570.…` for a complete account. They differ on a NULL
--    segment: `||` propagates NULL and the whole key becomes NULL, while
--    `CONCAT_WS` SKIPS the null and joins what remains — so a combination missing
--    segment 4 yields `04.6570.862.0450.0840.000` rather than NULL.
--
--    Neither is obviously right, and the choice is recorded rather than assumed:
--    the SQL Server arm uses `+`, which propagates NULL like `||`. `CONCAT_WS` is
--    used here because a partially-populated key is more useful on screen than a
--    blank one, and because it removes the dependency on `PIPES_AS_CONCAT` for
--    THIS view. The two arms can therefore disagree on a null segment — check
--    whether any exist before relying on the difference:
--
--        SELECT COUNT(*) FROM GL_CODE_COMBINATIONS
--         WHERE SEGMENT1 IS NULL OR SEGMENT2 IS NULL OR SEGMENT3 IS NULL
--            OR SEGMENT4 IS NULL OR SEGMENT5 IS NULL OR SEGMENT6 IS NULL
--            OR SEGMENT7 IS NULL;


-- ----------------------------------------------------------------------------
--  V_ENCUMBRANCE_FROM_PO — one row per account combination charged by an
--  encumbered purchase-order distribution.
--
--  ★ THIS IS NOT `V_ACCOUNT_POSITION` AND THE TWO MUST NOT BE CONFUSED. The
--    encumbrances screen reads BOTH and deliberately does not add them up: this
--    view is the PO side (335 combinations, $430,580,538.04 on the sample), while
--    the GL side comes from the composed position view (4 accounts,
--    $5,198,165.65). They overlap on exactly four accounts. See the long note in
--    `routes/spend.ts` for why no total is ever formed from the two.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE VIEW V_ENCUMBRANCE_FROM_PO AS
  SELECT pd.CODE_COMBINATION_ID,
         cc.SEGMENT4 AS OBJECT_CODE,
         cc.SEGMENT5 AS LEVEL_CODE,
         COUNT(DISTINCT pd.PO_DISTRIBUTION_ID) AS DISTRIBUTIONS,
         SUM(COALESCE(pd.ENCUMBERED_AMOUNT, 0)) AS ENCUMBERED_FROM_PO,
         SUM(COALESCE(pd.AMOUNT_ORDERED, 0))    AS ORDERED_FROM_PO
    FROM PO_DISTRIBUTIONS_ALL pd
    JOIN GL_CODE_COMBINATIONS cc
      ON cc.CODE_COMBINATION_ID = pd.CODE_COMBINATION_ID
   WHERE pd.ENCUMBERED_FLAG = 'Y'
   GROUP BY pd.CODE_COMBINATION_ID, cc.SEGMENT4, cc.SEGMENT5;
