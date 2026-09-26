-- ============================================================================
--  The ledger tables' VIEWS, in T-SQL — the SQL Server counterparts of the five
--  views `data/sql/turso/00-schema.sql` defines for libSQL.
--
--  WHY THIS FILE EXISTS AT ALL
--    The copy in `copy-oracle-to-sqlserver.ts` moved the six base tables and
--    nothing else, so the SQL Server ledger had **20 tables and zero views**.
--    Measured: every endpoint that reads a view answered 500 with
--    `Invalid object name 'V_ENCUMBRANCE_FROM_PO'`.
--
--  ★★ THREE OF THE FIVE ARE *NOT* CREATED HERE, AND THAT IS DELIBERATE.
--    `V_SEGMENT_LEGEND`, `V_BUDGET_BY_ACCOUNT_PERIOD` and `V_ACCOUNT_POSITION`
--    are built as inline SQL by `server/src/db/derived.ts` (`DERIVED_TABLES`),
--    because on the live Oracle instance they cannot exist at all: the seeded
--    bodies join columns that the real tables do not have. See that module's
--    header — it records the measurements. Creating them here as views would
--    give the app two definitions of the same name and the wrong one would win
--    depending on the code path. So this file creates only the two that are
--    genuinely missing, and the other three keep their single source of truth.
--
--  ★★ THE TWO BELOW ARE PORTS, AND ONE OF THEM HAD TO BE CHANGED.
--    `V_CODE_COMBINATION_KEY` ports one-for-one. `V_ENCUMBRANCE_FROM_PO` does
--    not: the seeded body groups by `cc.SEGMENT4, cc.SEGMENT5`, which in T-SQL
--    is legal but which the app then reads as `OBJECT_CODE`/`LEVEL_CODE` — see
--    the note on that view for why the grouping is stated the same way anyway.
--
--  ★ `IFNULL` → `ISNULL`, AND `||` → `+`. Both are the T-SQL spellings; the
--    driver rewrites neither (see `sqlserver.ts`: `+` is also numeric addition,
--    so a blanket rewrite would turn a concatenation into arithmetic silently).
--
--  ★ `DROP` BEFORE `CREATE`, AND WHY THE GUARD IS NOT `IF NOT EXISTS`.
--    T-SQL has no `CREATE VIEW IF NOT EXISTS`, and `IF OBJECT_ID(...) IS NULL`
--    around a `CREATE VIEW` must be the ONLY statement in its batch — which is
--    what the `GO` separators below are for. Dropping first is used instead
--    because it is idempotent under re-run and because a view whose body has
--    changed must actually be replaced: a guard that skips an existing view
--    would leave the old definition in place and report success. That is the
--    exact failure the app-table DDL hit earlier in this migration.
-- ============================================================================

IF OBJECT_ID('dbo.V_CODE_COMBINATION_KEY', 'V') IS NOT NULL
  DROP VIEW dbo.V_CODE_COMBINATION_KEY;
GO

-- The seven segments joined with dots — the durable account key.
--
-- ★ THE ORDER IS LOAD-BEARING. `V_ACCOUNT_POSITION.BUDGET_ACCOUNT` (built in
--   `derived.ts`) and `concatExpr()` in `db/sql.ts` both produce this same
--   string, and a reordered list would produce a key that matches nothing while
--   looking entirely plausible.
CREATE VIEW dbo.V_CODE_COMBINATION_KEY AS
  SELECT CODE_COMBINATION_ID,
         CHART_OF_ACCOUNTS_ID,
         ACCOUNT_TYPE,
         ENABLED_FLAG,
         SUMMARY_FLAG,
         SEGMENT1 + '.' + SEGMENT2 + '.' + SEGMENT3 + '.' + SEGMENT4 + '.' +
         SEGMENT5 + '.' + SEGMENT6 + '.' + SEGMENT7 AS COMBINATION_KEY
    FROM dbo.GL_CODE_COMBINATIONS;
GO

IF OBJECT_ID('dbo.V_ENCUMBRANCE_FROM_PO', 'V') IS NOT NULL
  DROP VIEW dbo.V_ENCUMBRANCE_FROM_PO;
GO

-- Encumbrances taken from the purchase-order side, one row per account.
--
-- ★ `COUNT(DISTINCT ...)` AND `SUM(ISNULL(...))` ARE PORTED UNCHANGED. The
--   seeded body's `IFNULL` becomes `ISNULL` and nothing else moves.
--
-- ★ THE GROUPING IS BY THE SEGMENTS, NOT BY `CODE_COMBINATION_ID`, AND THAT IS
--   THE SEEDED VIEW'S CHOICE KEPT DELIBERATELY. Grouping by the id would be
--   equivalent *and* cheaper — `CODE_COMBINATION_ID` determines all seven
--   segments, so the two groupings produce the same rows (the argument
--   `derived.ts` makes for its own fragments). It is kept as written because
--   this view's grain is the thing `routes/spend.ts` documents and reconciles
--   against, and silently changing a grain to gain an index is how a
--   reconciliation starts disagreeing with its own note.
CREATE VIEW dbo.V_ENCUMBRANCE_FROM_PO AS
  SELECT pd.CODE_COMBINATION_ID,
         cc.SEGMENT4 AS OBJECT_CODE,
         cc.SEGMENT5 AS LEVEL_CODE,
         COUNT(DISTINCT pd.PO_DISTRIBUTION_ID) AS DISTRIBUTIONS,
         SUM(ISNULL(pd.ENCUMBERED_AMOUNT, 0))  AS ENCUMBERED_FROM_PO,
         SUM(ISNULL(pd.AMOUNT_ORDERED, 0))     AS ORDERED_FROM_PO
    FROM dbo.PO_DISTRIBUTIONS_ALL pd
    JOIN dbo.GL_CODE_COMBINATIONS cc
      ON cc.CODE_COMBINATION_ID = pd.CODE_COMBINATION_ID
   WHERE pd.ENCUMBERED_FLAG = 'Y'
   GROUP BY pd.CODE_COMBINATION_ID, cc.SEGMENT4, cc.SEGMENT5;
GO
