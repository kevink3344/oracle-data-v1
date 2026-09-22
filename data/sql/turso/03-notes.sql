-- ============================================================================
--  Turso sample database — the notes that make the numbers interpretable.
--
--  Companion to 00-schema.sql (which references this file by name) and
--  02-seed.sql.  This is documentation first.  It contains no DDL and no writes,
--  so running it is always safe — but nothing here needs to run for the database
--  to work.  The query blocks are evidence: each one demonstrates the claim above
--  it against the seeded data.
-- ============================================================================


-- ============================================================================
--  1. This is a SURROGATE, not a replica.
-- ============================================================================
--  Say it plainly, because everything downstream depends on getting this right.
--
--  A REPLICA reproduces the source.  You can diff the two and expect agreement,
--  and any disagreement is a bug.
--
--  This is a SURROGATE.  It reproduces the SHAPE and the SEMANTICS of Oracle EBS
--  12.2 — the object names, the column names, the ACTUAL_FLAG budget/encumbrance/
--  actual discriminator, the seven COA segments, the join keys that hold the
--  model together.  It does NOT reproduce the source's contents, because the
--  extract in data/oracle/ is a partial slice and the business data behind those
--  four accounts was never in it.
--
--  Practical consequence, and the reason this section exists:
--
--      A query that gives the RIGHT ANSWER here may give a DIFFERENT answer on
--      the real database.  A query that gives the WRONG ANSWER here is wrong
--      there too.
--
--  So this database is good for: developing and debugging the SQL, the joins,
--  the filter logic, the aggregation, the null handling, the rendering of the
--  result set.  It is not good for: asserting what the ledger contains.
--
--  Do not "fix" a query until it agrees with production figures.  Fix it until
--  it is correct, then run it against production to find out what production
--  actually says.


-- ============================================================================
--  2. What is real in here, and what is not.
-- ============================================================================
--  Every seeded row declares its origin in SAMPLE_DATA_PROVENANCE.DATA_ORIGIN.
--  The vocabulary is lowercase and CHECK-constrained:
--
--    'extract'      copied verbatim from data/oracle/*.json
--    'derived'      computed FROM extract values; not invented, but not verbatim
--    'transcribed'  read off the report image (docs/report-findings.md section 2)
--    'synthetic'    authored so a query has something to reproduce
--
--  One query answers "what in here is real?":
--
--      SELECT DATA_ORIGIN, COUNT(*) FROM SAMPLE_DATA_PROVENANCE GROUP BY 1;
--
--  HEADLINE COUNTS (data/sql/turso/build-manifest.json holds the machine-readable form)
--
--      GL_CODE_COMBINATIONS   520  =  380 extract + 4 transcribed + 127 derived + 9 synthetic
--      PO_VENDORS             157      distinct VENDOR_NAME, real
--      PO_AGENTS                7      distinct BUYER_NAME, real
--      PO_HEADERS_ALL         749  =  742 carrying a real ORDER_NUMBER + 7 inv-only headers
--      PO_LINES_ALL         2,805  =  2,782 from full-output.json + 23 inv lines
--      PO_LINE_LOCATIONS_ALL 2,802      one shipment per resolvable line
--      PO_DISTRIBUTIONS_ALL 2,802
--      GL_BALANCES             31      over 6 accounts, 4 budget versions, 10 periods
--      GL_PERIODS              96      APR-2022 .. SEP-2028
--      SAMPLE_DATA_PROVENANCE 559      one row per documented account and per documented table
--
--  GL_BALANCES, because "31 rows" is not self-explanatory: 29 sit on the four
--  report accounts (labelled 'transcribed', since the accounts came from the
--  report) and 2 sit on the two authored trap accounts (labelled 'synthetic').
--  The five filter traps in section 4 therefore live on the report accounts' own
--  rows, not in a separate table of decoys — which is the harder and more useful
--  arrangement, because the rows that fool a careless query are the rows that
--  feed a correct one.
--
--  The 131 accounts NOT in the extract deserve a note, because it is a large
--  number that looks alarming and is fully explained:
--
--      380 extract accounts
--    + 131 accounts implied by PO segment tuples that the COA extract does not
--          contain (127 'derived' + 4 'transcribed' — the same tuples, but four of
--          them were positively identified from the report and are therefore
--          labelled more strongly)
--    +   9 authored accounts (rollup parent, disabled account, and the seven
--          placeholder accounts for unresolvable segment tuples)
--    = 520
--
--      380 + 131 + 9 = 520   ✓
--
--  In other words: of the 328 distinct PO segment tuples in full-output.json,
--  131 are absent from the COA extract.  That is a fact about the extract's
--  completeness, not about the seed.  The seed had a choice — drop those PO rows
--  or invent accounts for them — and it invented accounts, because dropping them
--  would silently shrink every PO-derived total.


-- ============================================================================
--  3. Why REAL is safe enough for money.
-- ============================================================================
--  00-schema.sql stores money as REAL (double) where Oracle would use NUMBER.
--  The concern is obvious: 0.1 + 0.2 ≠ 0.3 in binary floating point.  The
--  question is whether it bites at THESE magnitudes, and the answer was measured
--  rather than assumed.
--
--  The largest single figure in play is the funding total, 100,539,984.  The
--  check that matters is not "is REAL exact" (it is not) but "does the arithmetic
--  the application actually performs land on the exact expected value".
--
--  Measured in Node and re-measured in SQLite at these magnitudes:
--
--      6738830.00 - 2329280.40 - 4409549.60         ===  0        (and  =0 is true)
--      sum of the 7 funding lines                   ===  100539984
--      1000 × 67388.30                              ===  67388300
--
--  All exact.  A double carries ~15-16 significant decimal digits; every value
--  here is under 10 significant digits, and the sums stay under 10.  There is
--  headroom of roughly five digits.
--
--  WHERE THIS WOULD BREAK, so you know the boundary:
--
--    * Aggregating hundreds of millions of rows and then comparing to the cent.
--      Errors are ~1e-16 relative per operation; ten million additions can
--      accumulate to a cent.
--    * Any figure above ~1e15 stored to the cent.
--    * Chained percentage calculations, where an error is re-multiplied.
--
--  Nothing in the current application does any of those.  If one appears, this
--  decision must be revisited — and the fix is to store minor units as INTEGER,
--  not to add rounding at the call sites.
--
--  A deliberate consequence of choosing REAL: comparisons are made with a
--  tolerance.  scripts/verify-turso-sample.mjs uses `close(a, b, eps = 0.005)`,
--  half a cent, everywhere.  An exact `=` would fail on values that are
--  arithmetically correct.

--  EVIDENCE — the report grid must reproduce to the cent.
--  V_ACCOUNT_POSITION carries BUDGET_ACCOUNT (the full dotted key) and OBJECT_CODE
--  (the object segment); there is no column called ACCOUNT.
SELECT '3: object 526 must net to exactly 0.00' AS check_name,
       OBJECT_CODE,
       CAST(WCPSS_BUDGET AS TEXT) AS budget,
       CAST(EXPENDITURES AS TEXT) AS expenditures,
       CAST(ENCUMBRANCES AS TEXT) AS encumbrances,
       CAST(AVAILABLE_FUNDS AS TEXT) AS available_funds
  FROM V_ACCOUNT_POSITION
 WHERE BUDGET_ACCOUNT = '04.6570.862.526.0450.0840.000';


-- ============================================================================
--  4. The five GL_BALANCES filters — and why each one is non-optional.
-- ============================================================================
--  This is the single highest-value thing in this build, because it is the part
--  most likely to be got wrong on the real database, and wrong IN SILENTLY.
--
--  GL_BALANCES in EBS is one table that holds FOUR unrelated kinds of row,
--  discriminated by ACTUAL_FLAG, plus translated copies, plus encumbrance-type
--  splits.  A query that omits any of the filters below does not error.  It
--  returns a number, the number is wrong, and nothing tells you.
--
--  The five, as applied in V_ACCOUNT_POSITION and V_BUDGET_BY_ACCOUNT_PERIOD:
--
--    1. gb.TRANSLATED_FLAG = 'N'
--       Stops translated copies of the same balance being added to the original.
--       Trap: a EUR row at 6,200,000.00.
--
--    2. gb.CURRENCY_CODE = 'USD'
--       The reporting currency.  Overlaps with (1) in practice; kept separate
--       because a translated row and a foreign-currency row are different bugs.
--       Trap: the same EUR row carries both.
--
--    3. gb.ENCUMBRANCE_TYPE_ID IS NULL
--       Budget and actual rows leave it null; encumbrance rows populate it.  It
--       partitions the same balance several ways, so a filter on ACTUAL_FLAG
--       alone is not enough.
--       Trap: a row under ACTUAL_FLAG = 'B' with ENCUMBRANCE_TYPE_ID = 1 for
--       999,999.99 — it looks like budget, sits under ACTUAL_FLAG='B', and is not.
--
--    4. gb.LEDGER_ID IN (SELECT LEDGER_ID FROM GL_LEDGERS WHERE LEDGER_CATEGORY_CODE = 'PRIMARY')
--       Balances are per ledger.  A second ledger that also carries level-0450
--       balances doubles every figure.
--       Trap: ledger 2002, category SECONDARY, carrying 6,738,830.00.
--
--    5. cc.SUMMARY_FLAG = 'N'  AND  cc.ENABLED_FLAG = 'Y'
--       SUMMARY_FLAG = 'Y' marks a rollup parent, so its children's balances are
--       already in the set — including it double-counts.
--       ENABLED_FLAG = 'N' is a closed account whose historical balances persist.
--       Traps: a rollup parent whose children sum to 97,790,333.00, and a disabled
--       account at 1,000,000.00.
--
--  THE SET IS VERIFIED, NOT ASSERTED.  Each trap is engineered to be excluded by
--  exactly ONE of the five, so dropping any single filter changes the total by a
--  known amount.  Gate G5 in the verifier does precisely that: it runs the
--  filtered sum, then re-runs it once per filter with that filter removed, and
--  requires the delta to equal the trap's known value.

--  EVIDENCE — filtering must yield the report's two budget columns at once.
--  Note what is NOT in this list: BUDGET_TYPE.  The surviving rows are the CAPITAL
--  rows AND the APPROP rows, so the expected total is 97,790,333.00 +
--  95,355,458.93 = 193,145,791.93.  An earlier version of the gate compared this
--  to 97,790,333.00 alone and reported a failure that was really a bad baseline.
SELECT 'G5-equivalent: filtered sum = budget + allocations' AS check_name,
       CAST(SUM(gb.PERIOD_NET_DR - gb.PERIOD_NET_CR) AS TEXT) AS filtered
  FROM GL_BALANCES gb
  JOIN GL_CODE_COMBINATIONS cc ON cc.CODE_COMBINATION_ID = gb.CODE_COMBINATION_ID
 WHERE gb.TRANSLATED_FLAG = 'N'
   AND gb.CURRENCY_CODE = 'USD'
   AND gb.ENCUMBRANCE_TYPE_ID IS NULL
   AND gb.LEDGER_ID IN (SELECT LEDGER_ID FROM GL_LEDGERS WHERE LEDGER_CATEGORY_CODE = 'PRIMARY')
   AND cc.SUMMARY_FLAG = 'N'
   AND cc.ENABLED_FLAG = 'Y';


-- ============================================================================
--  5. The segment-key uniqueness rule.
-- ============================================================================
--  The canonical account key is the seven segments joined with dots:
--
--      SEGMENT1.SEGMENT2.SEGMENT3.SEGMENT4.SEGMENT5.SEGMENT6.SEGMENT7
--
--  In the 380-account extract this key is 1:1 with CODE_COMBINATION_ID — 380
--  distinct keys, 380 distinct ids, verified.  So the natural thing is to join
--  on it, and the natural thing WORKS, which is exactly what makes the trap
--  dangerous.
--
--  The seed has to represent PO segment tuples that no extract account matches.
--  Its first attempt gave all of them the same placeholder:
--
--      '00.0000.000.000.UNRESOLVED.0000.0000'
--
--  Seven accounts, one key.  Every join on the key then MULTIPLIED BY SEVEN.
--  Not an error — a plausible, wrong, larger number.
--
--  THE RULE: every account's segment key must be unique, including the
--  synthetic ones.  The placeholder therefore carries the CODE_COMBINATION_ID in
--  SEGMENT7:
--
--      '00.0000.000.000.UNRESOLVED.0000.<ccid>'
--
--  Two consequences worth knowing:
--
--    a) A synthetic key is deliberately NOT parseable as a real account.  It
--       cannot be mistaken for one, and it sorts away from real accounts.
--    b) The id in SEGMENT7 is meaningless as a value.  It exists purely to make
--       the key unique.  Do not read it as a cost centre.
--
--  Gate G2 asserts 520 rows / 520 distinct ids / 520 distinct keys.  If a future
--  seed adds placeholder accounts and does not follow this rule, G2 fails before
--  any query has a chance to return a silently multiplied result.

--  EVIDENCE — no key may be held by two accounts.
SELECT 'G2: duplicate segment keys (must be empty)' AS check_name,
       SEGMENT1 || '.' || SEGMENT2 || '.' || SEGMENT3 || '.' || SEGMENT4 || '.' ||
       SEGMENT5 || '.' || SEGMENT6 || '.' || SEGMENT7 AS k,
       COUNT(*) AS n
  FROM GL_CODE_COMBINATIONS
 GROUP BY k HAVING COUNT(*) > 1;


-- ============================================================================
--  6. The two PO datasets do not join.  This is a limitation, not a bug.
-- ============================================================================
--  data/oracle/ contains two purchase-order extracts with different grains and
--  — this is the point — no column that relates them:
--
--    full-output.json        .body.ResultSets.Table1   2,782 rows
--      ORDER_NUMBER, LINE_NUMBER, VENDOR_NAME, BUYER_NAME, QUANTITY, AMOUNT,
--      FUND, PURPOSE, PROGRAM, OBJECT_, LEVEL_, COST_CENTER, STATUS, ...
--      (ORDER_NUMBER, LINE_NUMBER) is UNIQUE across all 2,782 rows — zero
--      duplicates, so this grain is a real line grain.
--      742 distinct ORDER_NUMBER, 157 distinct VENDOR_NAME, 7 distinct BUYER_NAME.
--
--    inv-lines.json / inv-distributions.json   .ResultSets.Table1   20 rows each
--      PO_HEADER_ID, PO_LINE_ID, PO_DISTRIBUTION_ID, CODE_COMBINATION_ID,
--      QUANTITY_ORDERED, AMOUNT_ORDERED, AMOUNT_BILLED, ...
--
--  The tempting assumption is that ORDER_NUMBER in the first is a PO number and
--  PO_HEADER_ID in the second identifies the same purchase orders.  IT DOES NOT:
--
--    * 742 distinct ORDER_NUMBERs in full-output.json
--    * 7 distinct PO_HEADER_IDs across the two inv files
--    * intersection: ZERO
--
--  They are disjoint sets.  There is no shared key, no name match, no date
--  overlap that could stand in for one.  Nothing joins them.
--
--  AND THE TWO INV FILES DO NOT FULLY AGREE WITH EACH OTHER.  This was found by
--  querying the seeded database rather than by reading the JSON, and it is worth
--  knowing because it silently changes three row counts:
--
--      inv-lines.json            inv-distributions.json
--      ------------------        -----------------------
--      20 rows, 6 headers        20 rows, 6 headers
--
--  The header sets are NOT the same six.  11348924 appears only in
--  inv-distributions.json; 11348925 appears only in inv-lines.json.  Union: 7.
--
--  The line sets are not the same twenty either.  The distributions file mentions
--  three lines the lines file does not (11753986, 11753985, 11753981), and the
--  lines file mentions three the distributions file does not (11753980, 11753979,
--  11753978).  Union: 23.
--
--  Adjacent ids, off by one at the boundary — the signature of two extract queries
--  that were issued separately and landed on slightly different slices, not of any
--  corruption in the data itself.
--
--  So PO_HEADERS_ALL holds 7 inv-only headers where the lines file alone implies 6,
--  and PO_LINES_ALL holds 23 inv lines where either file alone implies 20.  That is
--  why the counts in section 2 say 749 and 2,805 rather than 748 and 2,802.
--
--  HOW THE SEED HANDLES IT — and this is the honest part:
--
--    It takes the UNION of the two files, per header.  A line that exists only as
--    a distribution still gets a PO_LINES_ALL row, so no distribution is orphaned
--    — but its ITEM_DESCRIPTION is set to the literal string 'ITEM DETAIL NOT IN
--    EXTRACT' rather than invented, and UNIT_PRICE and QUANTITY stay NULL.  A line
--    that exists only in the lines file gets its row and no distribution.
--
--    The 7 inv headers keep their REAL PO_HEADER_ID values, and their PO_NUMBER is
--    set to a synthetic label '(INV-EXTRACT <id>)'.  The parentheses are
--    deliberate: a label that obviously is not a PO number cannot later be
--    mistaken for one, and it is filterable — `PO_NUMBER NOT LIKE '(%'` selects
--    the 742 real orders.  Gate G10 does exactly that, and reports the 7 inv-only
--    headers separately rather than counting them as ORDER_NUMBERs.
--
--  WHAT NOT TO DO: do not "fix" this by inventing a mapping from PO_HEADER_ID to
--  ORDER_NUMBER, and do not "fix" it by dropping the 4 mismatched rows.  Any
--  invented mapping is fiction and would make a join-dependent query return a
--  confident wrong answer instead of an honest empty one; dropping the rows would
--  silently shrink every PO-derived total.  An empty result here is the CORRECT
--  result.

--  EVIDENCE — the two sets are disjoint.
SELECT 'G10-equivalent: real orders vs inv-only headers' AS check_name,
       (SELECT COUNT(DISTINCT PO_NUMBER) FROM PO_HEADERS_ALL WHERE PO_NUMBER NOT LIKE '(%') AS real_orders,
       (SELECT COUNT(*)               FROM PO_HEADERS_ALL WHERE PO_NUMBER LIKE '(INV-EXTRACT%') AS inv_only_headers,
       (SELECT COUNT(DISTINCT PO_NUMBER) FROM PO_HEADERS_ALL WHERE PO_NUMBER LIKE '(INV-EXTRACT%'
          AND PO_NUMBER IN (SELECT PO_NUMBER FROM PO_HEADERS_ALL WHERE PO_NUMBER NOT LIKE '(%')) AS intersection_should_be_zero;

--  EVIDENCE — the inv lines with no line-detail row, which are the ones the two
--  extract files disagree about.  This is the mismatch itself, visible in the data.
SELECT 'inv lines with no detail row (the extract disagreement)' AS check_name,
       PO_LINE_ID, ITEM_DESCRIPTION
  FROM PO_LINES_ALL
 WHERE ITEM_DESCRIPTION = 'ITEM DETAIL NOT IN EXTRACT'
 ORDER BY PO_LINE_ID;


-- ============================================================================
--  7. The unresolved-account convention.
-- ============================================================================
--  Seven CODE_COMBINATION_IDs are referenced by inv-distributions.json but appear
--  in NONE of the three COA extract files:
--
--      776351, 1750527, 8974072, 9168314, 9315567, 9626366, 9692973
--
--  Between them they carry 20 of the 2,802 distributions:
--      9315567 x6, 776351 x3, 9626366 x3, 9692973 x3, 8974072 x2, 9168314 x2, 1750527 x1
--
--  They are referenced-but-undefined. The seed cannot leave the FK dangling
--  (G7 requires a clean PRAGMA foreign_key_check) and cannot silently substitute a
--  real account (that would attribute spend to the wrong place).
--
--  So it creates one placeholder account per id, using the segment key from
--  section 5, and marks each 'synthetic' in SAMPLE_DATA_PROVENANCE with a note
--  naming the unresolvable id.
--
--  CONSEQUENCE FOR ANY TOTAL YOU COMPUTE: these accounts have no budget, no
--  allocation, no period activity, no name, and no level.  A report that groups by
--  account and expects every account to have a WCPSS_BUDGET will find rows here
--  with NULL budget.  Nullable is correct — the truthful answer is "unknown", not
--  zero.  Treating NULL as 0 would report a real underspend that does not exist.
--  Filter them out with `WHERE SEGMENT5 <> 'UNRESOLVED'` if a total is meant to
--  cover only known accounts, and say so in the report footnote.


-- ============================================================================
--  8. The report accounts are transcribed, and that is a real distinction.
-- ============================================================================
--  The four accounts the report's grid displays are ABSENT from the COA extract:
--
--      04.6570.862.526.0450.0840.000
--      04.6570.862.527.0450.0840.000
--      04.6570.862.529.0450.0840.000
--      04.6570.862.532.0450.0840.000
--
--  Only ONE level-0450 account exists anywhere in the extract,
--  '04.6560.862.529.0450.0840.000' (CCID 9680025) — and its SEGMENT2 is 6560, not
--  the report's 6570.  So none of the four can be recovered from the extract;
--  all four come from the report image and are labelled 'transcribed'.
--
--  ORDER OF ACCOUNT CREATION IS LOAD-BEARING, and this is where a subtle bug
--  lived.  Account creation is first-writer-wins on the segment key: whichever
--  code path claims a tuple first fixes that account's DATA_ORIGIN.  The
--  transcribed accounts were originally created inside the GL_BALANCES section,
--  which runs AFTER the PO-derived loop — so the PO loop claimed their tuples
--  first, and the four report accounts were labelled 'derived' rather than
--  'transcribed'.  A count reported 0 transcribed accounts while the data looked
--  perfectly fine, because the labels were quietly wrong.
--
--  THE RULE: accounts known POSITIVELY (from the report) must be created before
--  accounts INFERRED (from a PO slice).  The generator now creates the report
--  accounts, the funding lines, the project facts and the two trap accounts
--  immediately after ensureAccount is defined — before the PO loop and before the
--  GL_CODE_COMBINATIONS insert.  Gate G4 asserts all four are 'transcribed'.

--  EVIDENCE — the four report accounts carry the strongest label available.
SELECT 'G4-equivalent: the four report accounts' AS check_name,
       cc.CODE_COMBINATION_ID AS ccid, p.DATA_ORIGIN
  FROM GL_CODE_COMBINATIONS cc
  JOIN SAMPLE_DATA_PROVENANCE p
    ON p.TABLE_NAME = 'GL_CODE_COMBINATIONS' AND p.ROW_KEY = CAST(cc.CODE_COMBINATION_ID AS TEXT)
 WHERE cc.SEGMENT1 || '.' || cc.SEGMENT2 || '.' || cc.SEGMENT3 || '.' || cc.SEGMENT4 || '.' ||
       cc.SEGMENT5 || '.' || cc.SEGMENT6 || '.' || cc.SEGMENT7
       IN ('04.6570.862.526.0450.0840.000','04.6570.862.527.0450.0840.000',
           '04.6570.862.529.0450.0840.000','04.6570.862.532.0450.0840.000')
 ORDER BY cc.CODE_COMBINATION_ID;


-- ============================================================================
--  9. Empty tables are empty ON PURPOSE.
-- ============================================================================
--  AP_INVOICES_ALL, AP_INV_LINES, AP_INVOICE_DISTRIBUTIONS_ALL,
--  AP_INVOICE_PAYMENTS_ALL, PA_PROJECTS_ALL, PA_TASKS, PA_BUDGET_VERSIONS and
--  PA_BUDGET_LINES all hold zero rows.
--
--  The extract contains no Payables or Projects data at all.  The tables exist
--  because the schema needs the right shape (and because the SQL in data/sql/
--  refers to them), and they are documented in SAMPLE_DATA_PROVENANCE with
--  ROW_KEY = '*' and a note saying ZERO rows, so that:
--
--    * a reader can tell "not seeded" from "seeded and genuinely empty", and
--    * the claim is machine-checked, not merely written down.  Gate G14 parses
--      the "ZERO rows" and "ALL n rows" notes and verifies each against a real
--      COUNT(*).  A note that drifts out of step with the data fails the build.
--
--  A query against these tables returns nothing.  That is a fact about the
--  extract slice.  It says nothing about the ledger.


-- ============================================================================
-- 10. What this database cannot tell you.
-- ============================================================================
--  Collecting the limits in one place, so nobody has to rediscover them:
--
--    * It cannot tell you what the real ledger contains.  See section 1.
--    * It cannot reconcile the report's project-level funding (100,539,984) to
--      the per-account allocations (95,355,458.93).  Different grains; the
--      difference is real and is not a seed error.
--    * It cannot satisfy a join between the two PO datasets.  See section 6.
--    * It cannot answer anything about AP or PA.  See section 9.
--    * It cannot reproduce Oracle's `'' IS NULL`.  In SQLite '' and NULL differ,
--      so text is normalized on load.  A NULL-safe comparison written for Oracle
--      may behave differently here.
--    * It cannot reproduce Oracle NUMBER precision, NLS sort order, CHAR
--      blank-padding, the optimizer, or index behaviour.  A query that is
--      correct here is NOT thereby fast there.
--    * It cannot use ROWNUM, CONNECT BY, the (+) outer-join operator,
--      SYS_CONTEXT, FETCH FIRST, or MERGE — they do not exist in SQLite and are
--      not shimmed.  SUBSTR, INSTR, ROUND, ABS, MOD, TRUNC, ||, CTEs and window
--      functions are native and work.
--    * `TRUNC` IS A TRAP.  SQLite's TRUNC is arithmetic-only.  `date(TRUNC(SYSDATE))`
--      returns NULL SILENTLY.  Use `date('now')`.
--    * Compatibility shims (NVL, DECODE, TO_CHAR, LPAD, a DUAL view, a SYSDATE
--      column) can only be registered on a LOCAL node:sqlite connection.
--      @libsql/client has no custom-function API at all, so they are unavailable
--      against remote Turso.  A local build and a remote build therefore do not
--      accept quite the same SQL.
--    * It cannot give you a meaningful mean QUANTITY, mean unit price or mean
--      order value.  The extract mixes two kinds of line in one shape, one of
--      which stores dollars in the quantity column.  See section 12.


-- ============================================================================
-- 11. Reproducing this database.
-- ============================================================================
--      node scripts/build-turso-sample.mjs              # rebuild sample.db locally
--      node scripts/build-turso-sample.mjs --sql-only   # emit SQL, build nothing
--      node scripts/build-turso-sample.mjs --remote     # build on Turso (reads TURSO_* from .env)
--      node scripts/verify-turso-sample.mjs             # 19 gates against the local build
--      node scripts/verify-turso-sample.mjs --remote    # the same gates against Turso
--
--  The verifier is CONTROLS-FIRST, deliberately.  Before any gate runs, it
--  executes a statement that MUST fail (a deliberate syntax error) and a query
--  against an object that MUST NOT exist.  If either control passes, the harness
--  itself is broken and every later PASS is meaningless — so it aborts.  Without
--  that, a PASS cannot be distinguished from a harness that silently swallowed
--  the error, ran nothing, or matched on nothing.
--
--  Run the verifier after ANY seed change.  It is cheap, and every gate in it
--  exists because something specific went wrong at least once.


-- ============================================================================
-- 12. full-output.json is ONE query carrying TWO grains of line.
-- ============================================================================
--  This file was supplied by the DBA, so "is it one result set, or several
--  queries UNIONed into one view?" is a fair question to ask of it.  It is one:
--
--    * exactly ONE column signature across all 2,782 rows (18 columns), and
--    * ONE uninterrupted sort — ORDER_NUMBER ascending, 741 ascending
--      transitions against 0 descending over 742 distinct orders.
--
--  A UNION of separately-issued queries normally restarts its sort or shifts its
--  column list at the seam.  Neither happens here, so per-row arithmetic over
--  this file is safe, and the row counts derived from it are real row counts.
--
--  The rows are NOT all the same kind of thing, though.  Two grains share the one
--  shape, and ITEM_NUMBER is what tells them apart:
--
--    grain                        lines      value           unit price
--    lump-sum  (ITEM_ID IS NULL)    589   418,016,353.66     exactly 1 for 577
--    goods     (ITEM_ID NOT NULL) 2,193    12,552,673.26     933 distinct values
--
--  On a lump-sum line the DOLLAR VALUE SITS IN THE QUANTITY COLUMN and the unit
--  price is 1:
--
--    order 260860 line 2  'CMAR-GMP #1 CONSTRUCTION'  qty 97,681,625.00  price 1
--
--  That is not corruption and it was not invented here — it is how a construction
--  contract gets keyed, with the contract sum entered as the quantity.  Twelve
--  further lump-sum lines carry AMOUNT 0 and QUANTITY 0 (the 'ENCUMBERING FUNDS
--  FOR ...' memo lines), which is why the count above is 577 rather than 589.
--
--  The seed reproduces this faithfully rather than normalising it: QUANTITY and
--  UNIT_PRICE are copied through, so `QUANTITY * UNIT_PRICE = AMOUNT_ORDERED`
--  holds for all 2,782 distributions on these lines.  Normalising would make the
--  sample agree with our idea of tidy and disagree with the source.
--
--  TWO CONSEQUENCES, both easy to trip over:
--
--   1. QUANTITY IS NOT COMPARABLE ACROSS THE TWO GRAINS, and must not be added
--      across them.  Summed over everything on this database it comes to
--      418,129,628.54 — a number with no unit, because 418M of it is dollars and
--      113,274.88 of it is staff tables and gym mats.  Use AMOUNT.
--
--   2. 589 lines (21% of them) hold 97.1% of the money.  The top five levels
--      carry 64% of the total and the single largest line is 97,681,625 against
--      a 430,569,026.92 extract.  So any "spend by level" bar, any top-N list and
--      any average order value is a spike with a long flat tail.  That is what a
--      capital-project PO book looks like, not a defect — but a chart drawn from
--      it needs a log scale or a rank axis, and "average order value" is
--      meaningless.  Gates G16 and G17 pin these facts so the note cannot drift.
--
--  EVIDENCE
--    The two grains, and the fact that the lump-sum grain is internally uniform:

SELECT CASE WHEN l.ITEM_ID IS NULL THEN 'lump-sum (ITEM_ID NULL)' ELSE 'goods (ITEM_ID set)' END AS grain,
       COUNT(*)                                          AS lines,
       ROUND(SUM(d.AMOUNT_ORDERED), 2)                   AS amount,
       MIN(l.UNIT_PRICE)                                 AS min_unit_price,
       MAX(l.UNIT_PRICE)                                 AS max_unit_price,
       SUM(CASE WHEN l.UNIT_PRICE = 1 THEN 1 ELSE 0 END) AS lines_at_unit_price_1
  FROM PO_LINES_ALL l
  JOIN PO_HEADERS_ALL h        ON h.PO_HEADER_ID = l.PO_HEADER_ID
  JOIN PO_DISTRIBUTIONS_ALL d  ON d.PO_LINE_ID   = l.PO_LINE_ID
 WHERE h.PO_NUMBER NOT LIKE '(%'
 GROUP BY 1
 ORDER BY 3 DESC;

--    The concentration, as a single number.  Expect 97.1.

SELECT ROUND(100.0 * (
         SELECT SUM(d.AMOUNT_ORDERED)
           FROM PO_DISTRIBUTIONS_ALL d
           JOIN PO_LINES_ALL l  ON l.PO_LINE_ID   = d.PO_LINE_ID
           JOIN PO_HEADERS_ALL h ON h.PO_HEADER_ID = l.PO_HEADER_ID
          WHERE l.ITEM_ID IS NULL AND h.PO_NUMBER NOT LIKE '(%'
       ) / (
         SELECT SUM(d.AMOUNT_ORDERED)
           FROM PO_DISTRIBUTIONS_ALL d
           JOIN PO_HEADERS_ALL h ON h.PO_HEADER_ID = d.PO_HEADER_ID
          WHERE h.PO_NUMBER NOT LIKE '(%'
       ), 1) AS lump_sum_share_pct;

--    Why QUANTITY must not be summed across the grains.  Expect 418,129,628.54,
--    which is dollars plus a handful of chairs.

SELECT ROUND(SUM(l.QUANTITY), 2) AS quantity_summed_across_grains
  FROM PO_LINES_ALL l
  JOIN PO_HEADERS_ALL h ON h.PO_HEADER_ID = l.PO_HEADER_ID
 WHERE h.PO_NUMBER NOT LIKE '(%';
