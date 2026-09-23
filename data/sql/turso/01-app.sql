-- ============================================================================
--  App-owned tables.
--
--  Dialect: SQLite / libSQL (Turso).  NOT runnable on Oracle.
--
--  ---------------------------------------------------------------------------
--  WHAT BELONGS IN THIS FILE
--  ---------------------------------------------------------------------------
--  Tables this application owns. Nothing here is a surrogate for an Oracle
--  object, and nothing here should ever be written back to the EBS instance —
--  these are the app's own bookkeeping, and the EBS tables are read-only.
--
--     saved_view              one row per saved View Builder view
--     saved_view_run          one row per execution, for history and change detection
--     saved_view_subscription one row per subscriber to a view
--     project                 the project master — names against account levels
--     table_count_snapshot    one row per table per day — how many rows it held
--     organization            one row per tenant — its fund, programmes and start FY
--     app_user                one row per person who may sign in, and their tenant
--     geo_origin              one row per named place a driving distance is measured FROM
--     vendor_site_geo         one row per vendor site — where it is, and how far it is from an origin
--     ledger_read_cap         one row per ledger object — how many rows to read, and in what order
--
--  ---------------------------------------------------------------------------
--  WHY IT IS SEPARATE FROM 00-schema.sql
--  ---------------------------------------------------------------------------
--  00-schema.sql describes the Oracle surrogate and is treated as read-only: it
--  is the artefact the ports in queries/ were verified against, and a change to
--  it invalidates that verification. App tables are a different kind of thing —
--  they change whenever the app does — so they live in their own file and
--  00-schema.sql is not touched.
--
--  ---------------------------------------------------------------------------
--  WHY IT IS A FILE AND NOT A MIGRATION FRAMEWORK
--  ---------------------------------------------------------------------------
--  Every statement is idempotent (IF NOT EXISTS), so applying this file is safe
--  to repeat and safe to skip. server/src/db/app-schema.ts reads it and applies
--  it lazily on first use, which means the source of truth is this file rather
--  than a TypeScript string that has to be kept in step with it.
--
--  A real migration tool is the right answer once there is a column to drop.
--  There is not one yet, and a framework installed before it is needed is a
--  framework whose rules get worked around.
-- ============================================================================


-- ============================================================================
--  saved_view — the definition.
--
--  Three columns carry the whole feature, and they are three because they have
--  three different lifecycles:
--
--    sql           trusted, curated, run VERBATIM. The builder never rewrites a
--                  statement — a rewrite that changes the answer is worse than
--                  an error that stops it. (See the plan's §4 and §16.)
--    params_json   the DECLARED parameters. The SQL is scanned for `:tokens` and
--                  every one must be declared here; compilation to binds happens
--                  server-side on every run, never by string substitution.
--    display_json  presentation only — labels, order, formats, hidden columns,
--                  the fingerprint key. It can be wrong (a column renamed in the
--                  SQL) without the query being wrong, which is why it is a
--                  separate column and why drift is a notice, not a failure.
--
--  Storing them apart is what lets each be validated against its own rules, and
--  what lets the display config be edited without re-validating the SQL.
-- ============================================================================

CREATE TABLE IF NOT EXISTS saved_view (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT    NOT NULL UNIQUE,

  title         TEXT    NOT NULL,
  description   TEXT,

  sql           TEXT    NOT NULL,

  -- JSON text, not a JSON column type: SQLite has no JSON type, and libSQL's
  -- JSON functions operate on TEXT anyway. `'[]'` / `'{}'` rather than NULL so
  -- every reader can parse unconditionally without a null check.
  params_json   TEXT    NOT NULL DEFAULT '[]',
  display_json  TEXT    NOT NULL DEFAULT '{}',

  -- ★ STILL NOT A FK, AND NOW FOR A DIFFERENT REASON. This used to say "there is no
  -- users table and no authentication yet, so this records an intent, not a
  -- relationship" — true then, false since `app_user` landed at the bottom of this
  -- file. It stays TEXT on purpose: the value is the *display name* a person is
  -- known by, which is also what the audit trail wants if the account is later
  -- renamed or removed, and a FK would rewrite a historical attribution when a
  -- `display_name` changed. `app_user` owns identities; this column owns the
  -- sentence "who made this", frozen at the moment it was made.
  created_by    TEXT,

  status        TEXT    NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','active','disabled')),

  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- The list screen filters by status and sorts by title. The slug's UNIQUE
-- constraint already indexes itself, so it is not repeated here.
CREATE INDEX IF NOT EXISTS IDX_SAVED_VIEW_STATUS ON saved_view (status, title);


-- ============================================================================
--  saved_view_run — what happened each time it ran.
--
--  Serves two purposes that want the same row: "when did this last run and did
--  it work" for the screen, and the previous fingerprint for change detection.
--
--  `fingerprint` is a hash of the row count plus the first N values of the
--  DECLARED key column, in order. It is deliberately not a hash of the whole
--  result: that would fire on any cell edit anywhere, and a hash of the count
--  alone would miss every in-place change. The honest limitation is recorded in
--  the UI — a change that preserves both the count and the key order is
--  invisible to it, and no hash of a sample can fix that.
--
--  `error` is stored unstripped, because the whole point of the error pane is
--  to show the driver's own words rather than a paraphrase.
--
--  ★ `row_count` IS A CAPPED COUNT, NOT A TOTAL, AND `truncated` IS WHAT SAYS SO.
--  Every statement this server runs is wrapped so that it fetches at most
--  `VIEW_BUILDER_MAX_ROWS + 1` rows (`wrapForRowCap`), and `capResult` then slices
--  back to the cap. So a query over 900,000 rows records `row_count = 200`, which
--  is the same number a query over exactly 200 rows records. Without this column
--  the history would present "200" for both and the reader would have no way to
--  tell a total from a floor — the error this project has already made once, in
--  the other direction, when a nullable count was written as 0 and produced a
--  fictitious -100% delta. `truncated = 1` means "there were more rows than the
--  cap"; it is null on a run that never produced a result, which is why it is not
--  defaulted.
-- ============================================================================

CREATE TABLE IF NOT EXISTS saved_view_run (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  view_id      INTEGER NOT NULL REFERENCES saved_view (id) ON DELETE CASCADE,

  ran_at       TEXT    NOT NULL DEFAULT (datetime('now')),

  -- Nullable rather than defaulted to 0. A run that was refused before it
  -- reached the database has no duration and no row count, and writing 0 for
  -- either would make "did not run" indistinguishable from "ran and found
  -- nothing" — the same confusion that once produced a fictitious -100% delta in
  -- this project's history.
  duration_ms  INTEGER,
  row_count    INTEGER,
  truncated    INTEGER,

  fingerprint  TEXT,
  error        TEXT
);

-- History is read newest-first for one view.
CREATE INDEX IF NOT EXISTS IDX_SAVED_VIEW_RUN_VIEW ON saved_view_run (view_id, ran_at DESC);


-- ============================================================================
--  saved_view_subscription — who wants to know when a view's result changes.
--
--  There is no delivery mechanism in this phase (the plan's §12 defers it to
--  phase 4), so nothing here is scheduled and nothing fires. The table exists
--  because the shape is cheap and the alternative — inventing it later, on top
--  of rows that were stored a different way — is not.
--
--  `target` is deliberately a plain string rather than a URL: the app has no
--  webhook sender, so describing it as a URL would promise a delivery that
--  cannot happen.
-- ============================================================================

CREATE TABLE IF NOT EXISTS saved_view_subscription (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  view_id     INTEGER NOT NULL REFERENCES saved_view (id) ON DELETE CASCADE,

  subscriber  TEXT    NOT NULL,
  channel     TEXT    NOT NULL CHECK (channel IN ('in_app','webhook')),
  target      TEXT,

  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),

  -- One subscription per person per channel per view. Re-subscribing is not an
  -- error; it is the same request twice.
  UNIQUE (view_id, subscriber, channel)
);

CREATE INDEX IF NOT EXISTS IDX_SAVED_VIEW_SUB_VIEW ON saved_view_subscription (view_id);


-- ============================================================================
--  project — the project master.
--
--  ---------------------------------------------------------------------------
--  WHY THIS IS AN APP TABLE AND NOT AN ORACLE ONE
--  ---------------------------------------------------------------------------
--  Oracle has no project dimension we can read. Four EBS tables model one
--  (PA_PROJECTS_ALL, PA_TASKS, PA_BUDGET_VERSIONS, PA_BUDGET_LINES) and all four
--  are empty on the instance — measured, not assumed — and nothing points into
--  them either: PROJECT_ID and TASK_ID are NULL on all 1,141,913 PO_LINES_ALL
--  rows and on all 1,159,988 PO_DISTRIBUTIONS_ALL rows. So there is no project
--  master to read back and no link to recover.
--
--  The decision of record (00-schema.sql section 4, 2026-09-18) is that the
--  project master is SUPPLIED AS A SEPARATE SQLITE TABLE rather than read out of
--  EBS. This is that table. It is app-owned in the strict sense this file means:
--  it is never written back to the instance, because the instance has nowhere to
--  put it.
--
--  ---------------------------------------------------------------------------
--  WHY level_code IS NULLABLE, AND WHY THAT IS NOT MISSING DATA
--  ---------------------------------------------------------------------------
--  A project exists as a NAME before anybody has decided which account level
--  funds it. "Buffalo Bills Stadium" is a real row with no level yet; the two
--  rows at the foot of this file are exactly that case. Modelling the unassigned
--  state as an absent row instead would mean the project could not be recorded
--  until it was coded, which is the wrong order — the name arrives first.
--
--  level_code is UNIQUE, and SQLite permits many NULLs in a UNIQUE column. That
--  is what makes "not yet associated" storable more than once, while still
--  catching the error that matters: two projects claiming the same level.
--
--  level_code is the 4-digit SEGMENT5 value, which is the only project identity
--  the ledger actually carries — see data/sql/README.md. It is NOT the
--  description text on a PO line: that text is prose, it is misspelled in
--  places ("MECAHNICAL"), and two different levels name the same school.
-- ============================================================================

CREATE TABLE IF NOT EXISTS project (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,

  -- The stable natural key, and the reason the seed below is safe to re-apply.
  -- A project's NAME is display text and an operator will edit it; a slug is
  -- not, so the slug is what INSERT OR IGNORE matches on.
  slug        TEXT    NOT NULL UNIQUE,

  name        TEXT    NOT NULL,
  description TEXT,

  -- The SEGMENT5 value this project claims, or NULL when nobody has said yet.
  level_code  TEXT    UNIQUE,

  -- The display code (`CC-0454-527`). Stored rather than always derived, because
  -- the anchor object the app would derive it from is a property of the PO
  -- extract and this row has to survive a rebuild of that extract.
  code        TEXT,

  site        TEXT,
  owner       TEXT,

  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- The list reads in name order. The two UNIQUE constraints already index
-- themselves, so neither is repeated here.
CREATE INDEX IF NOT EXISTS IDX_PROJECT_NAME ON project (name);


-- ---------------------------------------------------------------------------
--  The seed.
--
--  INSERT OR IGNORE, so re-applying this file never overwrites an edit: the
--  slug's UNIQUE constraint turns a repeat into a no-op. That is also why the
--  twelve rows are the *initial* state and not a synchronised one.
--
--  The first ten are the names the approved design mockup carries, one per
--  account level, and they are TRANSCRIBED from it — not read out of Oracle,
--  which has none of them. The last two are the projects with no level yet.
--
--  Everything NUMERIC about a project (lines, orders, vendors, amounts, dates,
--  status) is derived from the PO extract at read time and is deliberately not
--  stored here. A stored total is a total that goes stale the next time the
--  extract is refreshed.
-- ---------------------------------------------------------------------------

INSERT OR IGNORE INTO project (slug, name, level_code, code, site, owner, description) VALUES
  ('north-garner-ms-renovation', 'North Garner MS – Renovation', '0454', 'CC-0454-527',
   'North Garner Middle School', 'Sam Okafor',
   '98.9% of the commitment sits in one CMAR contract. No order in this level after 2026-04-06, 122 days before the extract cut-off.'),

  ('lockhart-es-renovation', 'Lockhart ES – Renovation', '0453', 'CC-0453-527',
   'Lockhart Elementary School', 'Priya Raman',
   'Two lines of a single CMAR order carry 98.6% of the level. The remaining eleven lines are the project’s whole soft-cost tail.'),

  ('morrisville-hs-h14-davis-drive', 'Morrisville HS (H-14) – Davis Dr. / Little Dr. site', '0526', 'CC-0526-527',
   'Morrisville High School', 'Marcus Bell',
   '153 of the 168 lines are operating and account for 1.2% of the level. Purchase-order count and dollar value point in opposite directions here.'),

  ('fuquay-varina-es-renovation-pr-22-030', 'Fuquay-Varina ES – Renovation (PR-22-030)', '1420', 'CC-1420-541',
   'Fuquay-Varina Elementary School', 'Lena Ortiz',
   'The widest line-to-value gap on this screen: 213 of 225 lines are operating, worth 3.2%. The two construction lines are worth 94.5%.'),

  ('safety-and-security-phase-1a', 'Safety & Security Implementations – Phase 1A', '0700', 'CC-0700-529',
   'District-wide', 'Ray Chen',
   'Not one site. Descriptions in this level reference 69, 67 and 61 schools, so the level behaves as a programme rather than a project.'),

  ('wakefield-ms-hvac-renovation', 'Wakefield MS – HVAC renovation', '2594', 'CC-2594-523',
   'Wakefield Middle School', 'Angela Fitzpatrick',
   'Four lines carry 88.0% of the level. Oracle’s own description text misspells “mechanical” as “MECAHNICAL” on the $7,057,500 order.'),

  ('willow-springs-es-hvac-and-roof', 'Willow Springs ES – HVAC renovation + roof replacement', '2624', 'CC-2624-523',
   'Willow Springs Elementary School', 'Devon Marsh',
   'Last order 2026-05-05 — 93 days before the cut-off, three days outside the Active window. Two separate capital scopes, no operating.'),

  ('wakelon-es-modular-installation', 'Wakelon ES – modular unit installation', '0832', 'CC-0832-522',
   'Wakelon ES, Carver ES, Durant Road MS', 'Priya Raman',
   'One level code, three campuses: descriptions name Wakelon ES, Carver ES and Durant Road MS. The largest order is a non-CMAR modular install.'),

  ('ligon-ms-renovation', 'Ligon MS – Renovation', '0458', 'CC-0458-526',
   'Ligon Middle School', 'Sam Okafor',
   'Three orders only, all design fees. 98.8% of the level is the architect’s contract, so construction value is not yet committed anywhere.'),

  ('swift-creek-es-renovation', 'Swift Creek ES – Renovation', '0523', 'CC-0523-527',
   'Swift Creek Elementary School', 'Dana Whitfield',
   'The only level here where operating spend is material, at 21.2%. None of the 320 operating lines names the project — identity comes from the level code, not the text.'),

  -- -------------------------------------------------------------------------
  --  The two with no level yet.
  --
  --  level_code NULL, code NULL. They are named and nothing else: no site, no
  --  owner, no note, because inventing any of those would put a guess into a row
  --  a reader has no way to tell apart from a fact. The app renders a null site
  --  as "Not yet described" and a null owner as blank.
  --
  --  They will not appear in the Projects list, which is built from the account
  --  levels the PO extract carries — a project with no level has no level to
  --  appear under. They are returned by /api/projects/registry and listed on the
  --  Unclaimed screen's counterpart, which is where "recorded but not yet
  --  associated" belongs. Associating one is a single UPDATE of level_code.
  -- -------------------------------------------------------------------------

  ('buffalo-bills-stadium', 'Buffalo Bills Stadium', NULL, NULL,
   NULL, NULL, NULL),

  ('lenovo-center-improvements', 'Lenovo Center Improvements', NULL, NULL,
   NULL, NULL, NULL);


-- ============================================================================
--  ★ THE PROJECT REGISTRY IS NOT TENANT-SCOPED, AND THAT IS A DECISION.
--
--  Every other app-owned table here is either per-user or per-tenant: saved
--  views carry `created_by`, an organization is the tenant, and `app_user` is
--  the join between the two. `project` carries **no `organization_id` and is not
--  going to gain one**, so read this before adding a column.
--
--  The reason is the extract's shape, and it is stated in the plan rather than
--  inferred here (`docs/plans/organizations.md`, non-goals):
--
--    "It does not invent multi-tenant data isolation. There is one extract;
--     therefore one tenant's worth of rows at a time. An organization's scope
--     *selects from* the extract, it does not partition a shared one. Two
--     organizations that need different rows need two extracts."
--
--  A tenant is a (fund, programmes, start FY) tuple applied to the ledger — see
--  the `organization` table below. That tuple is what decides which PO lines a
--  tenant sees. The projects those lines are coded to are the same rows for
--  everybody, because there is one extract and it is one tenant's. Scoping this
--  table would not isolate anything the scope does not already isolate; it would
--  only make a project disappear from a tenant that can legitimately see the
--  orders booked to it.
--
--  What the registry does need from an organization is *nothing*: `level_code`
--  is a SEGMENT5 value, not a tenant's label. Two organizations reading the same
--  extract therefore share this table's rows on purpose.
--
--  So the answer to "which organization do the twelve seeded rows belong to?" is
--  "all of them, which is to say none of them" — and the seeded rows are names
--  transcribed from the design mockup (see above), not extract rows, so they are
--  not even tenant data.
-- ============================================================================


-- ============================================================================
--  table_count_snapshot — how many rows each object held, per day.
--
--  ---------------------------------------------------------------------------
--  WHAT THIS IS FOR
--  ---------------------------------------------------------------------------
--  The Activity register is an inventory: every object the app knows about, and
--  how many rows it holds. But counting the live ledger is a full scan of
--  whichever table is asked — the register's own first two entries are
--  AP_INVOICES_ALL at 2.5 million rows and AP_INVOICE_PAYMENTS_ALL at 2.7 million
--  — so a page load must not do it. It is done when somebody presses "Record
--  counts now", and this table is where the answer is kept.
--
--  It is intentionally dumb: one object, one day, one number. Everything clever —
--  pairing readings, subtracting them, deciding what to say about a table with
--  only one — happens at read time in server/src/routes/activity.ts, because a
--  stored delta would be a stored interpretation, and the interpretation is the
--  part most likely to be wrong and most expensive to correct in place.
--
--  Having two readings, the difference between them is a real if weaker signal:
--  not "four rows were created", but "there are four more rows than at the last
--  reading". That is a secondary use of this table, not its purpose. The purpose
--  is that the count survives the page load.
--
--  ---------------------------------------------------------------------------
--  ★ A ROW HERE IS A COUNT, AND A COUNT IS ONLY MEANINGFUL WITH ITS STORE
--  ---------------------------------------------------------------------------
--  `counted_in` says which database produced it, and a reading without it is one
--  the register refuses to serve. See the column's own note; the short version is
--  that the store that answers is not always the store that lists, and a figure
--  separated from its provenance is a claim rather than a measurement.
--
--  ---------------------------------------------------------------------------
--  ★ IT IS NOT A CHANGE LOG, AND THE DIFFERENCE IS THE WHOLE DISCLAIMER
--  ---------------------------------------------------------------------------
--  A difference of counts is a NET figure. "+4" can be six rows inserted and two
--  deleted, and this table cannot tell those apart — it never sees a delete, only
--  the arithmetic that survives one. A stored count means "this object held N
--  rows"; a difference of counts means "four more than last time". They are
--  different claims, which is why the register reports them through different
--  fields (`rowCount` versus `snapshot.delta`) and the screen labels them
--  differently, and why neither is ever added to the other.
--
--  ---------------------------------------------------------------------------
--  ★ THE COMPARISON IS AGAINST THE PREVIOUS READING, NOT AGAINST YESTERDAY
--  ---------------------------------------------------------------------------
--  There is no scheduler in this app and no promise that a reading is taken every
--  day. A table read on Monday and again on Thursday is compared Monday-to-
--  Thursday, and the screen prints both dates rather than calling the four-day
--  difference a daily one. `captured_at` is the wall-clock instant the count was
--  read, which is a second, weaker honesty: two readings taken at 09:00 and 17:00
--  differ by the day's change plus eight hours of it, and a reader who can see
--  both timestamps can at least tell that is what happened.
--
--  A comparison also requires both readings to come from the same store. A sample
--  count subtracted from a ledger count is arithmetic between two different
--  databases — 0 → 2,569,410 would read as two and a half million new rows — so
--  the register reports no difference when the store changed, which is weak but
--  is not false.
--
--  ---------------------------------------------------------------------------
--  WHY THE UNIQUE CONSTRAINT CARRIES THE FEATURE
--  ---------------------------------------------------------------------------
--  A reading is a reading *of a day*. Pressing the button five times must not
--  write five readings, and the day's delta must not be measured against a reading
--  taken ninety seconds earlier — so a repeat write for the same (object, day)
--  updates in place rather than appending. The capture path relies on this.
--
--  ---------------------------------------------------------------------------
--  WHY row_count IS NOT NULL, AND WHY THERE IS NO EXTRA INDEX
--  ---------------------------------------------------------------------------
--  A row here says "on this day this object held N rows". When a count cannot be
--  read there is no such sentence to write, so nothing is written — absence is
--  the record of the attempt, the same way `rowCount: null` is the register's
--  record of a count it could not take. A NULL column would have to be filtered
--  out by every reader for ever to stop it becoming a phantom "0 rows".
--
--  No index is declared. The UNIQUE constraint already builds one on
--  (object_name, snapshot_date), and the only query this table serves scans it
--  backwards — newest first, per object — which SQLite does without help.
--
--  Growth is one row per object per day: about fifty rows a day, roughly eighteen
--  thousand a year. Nothing prunes it, because nothing needs to yet, and a
--  retention rule added before the data is large is a rule with no evidence
--  behind it.
-- ============================================================================

CREATE TABLE IF NOT EXISTS table_count_snapshot (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,

  -- The object being counted. Not a foreign key: this column names things in the
  -- Oracle surrogate (and in the live EBS database, when the app is pointed
  -- there), and the app does not own either.
  object_name   TEXT    NOT NULL,

  -- The day the reading belongs to, `YYYY-MM-DD`, in the app's own local clock —
  -- the same rule `datetime('now')` defaults and `date('now','localtime')` use
  -- elsewhere, so a reading taken at 20:00 is filed under the day the person who
  -- took it would call today.
  snapshot_date TEXT    NOT NULL,

  -- How many rows the object held at that moment. Never NULL: see above.
  row_count     INTEGER NOT NULL,

  -- ★ WHICH DATABASE PRODUCED THIS COUNT: 'app' or 'ledger'.
  --
  -- This column is the difference between a figure and a claim. The register's
  -- object list comes from the app store, but the counts come from whichever
  -- store actually holds the object — the local sample file for this app's own
  -- seven tables, the live Oracle database for everything else — and the two are
  -- different databases with different numbers in them.
  --
  -- Without it, a reading is a bare integer that the page has to *assume* came
  -- from the store the current configuration happens to name. That assumption was
  -- already false once: the readings this table held before the register became a
  -- row-count inventory were taken from the app store, and a page reading them
  -- under a heading naming the ledger would have shown the sample's numbers as
  -- the live database's. NULL is therefore meaningful and is *not* "unknown, assume
  -- current" — a reading with no `counted_in` is one this register will not serve,
  -- because it cannot say what it counted. The register treats it as no reading at
  -- all, and one press of "Record counts now" replaces it with a number that
  -- carries its own provenance.
  --
  -- Adding a column to a table that already exists is the one thing
  -- `CREATE TABLE IF NOT EXISTS` cannot do, so `db/app-schema.ts` applies it as a
  -- guarded `ALTER TABLE` for stores created before this column existed.
  counted_in    TEXT,

  -- When the count was actually read, as opposed to which day it is filed under.
  captured_at   TEXT    NOT NULL DEFAULT (datetime('now')),

  -- One reading per object per day. See the header note.
  UNIQUE (object_name, snapshot_date)
);


-- ============================================================================
--  organization — the tenant.
--
--  One row per organization a person can belong to. It carries three things and
--  they are the three things that decide what any screen in the app is allowed
--  to show:
--
--    fund          which Fund segment value the organization's money sits in.
--    programs_json which programmes inside that fund. A JSON array, not a child
--                  table — see below.
--    start_fy      the earliest fiscal year the organization wants to see.
--
--  ---------------------------------------------------------------------------
--  WHY programs_json IS A JSON ARRAY AND NOT A CHILD TABLE
--  ---------------------------------------------------------------------------
--  Because the ORDER IS DATA. `['861','862','863']` and `['862','861','863']`
--  select exactly the same rows and are displayed differently, and the app has
--  an explicit rule about which it shows: the scope label keeps the authored
--  order, because "861, 862, 863" reads as a range and "862, 861, 863" does not.
--  A child table with a sort column would model it, and would also mean every
--  read of a four-value array is a join. This is the same trade saved_view made
--  for `params_json`, and for the same reason: the array is read and written
--  whole, never queried into.
--
--  ★ THEREFORE NOTHING SORTS THIS COLUMN ON WRITE. A writer that sorted the
--    programmes before storing them would lose a distinction the app is careful
--    to preserve on screen, and the loss would be invisible — the same rows,
--    the same count, a label that reads wrong.
--
--  ---------------------------------------------------------------------------
--  WHY start_fy IS AN INTEGER AND WHY THE NAME SAYS FY
--  ---------------------------------------------------------------------------
--  Oracle's `GL_PERIODS.PERIOD_YEAR` is the fiscal year a period ENDS in, so
--  FY2022 is 2021-07-01 .. 2022-06-30. Storing a year means the boundary is
--  derived one way, in one place; storing a date would invite a calendar-year
--  comparison, which is off by one for every July-to-December row. The window
--  it opens is `>= `${start_fy - 1}-07-01``.
--
--  ---------------------------------------------------------------------------
--  WHY is_default HAS A PARTIAL UNIQUE INDEX
--  ---------------------------------------------------------------------------
--  Exactly one organization may be the default, and "exactly one" is not a
--  convention to be held by a code review. The default answers three questions
--  that must all get the same answer:
--
--    1. which tenant an anonymous visitor browses (the request settled that a
--       signed-out person still sees data, rather than a login wall);
--    2. which tenant the super admin belongs to — the bootstrap account has no
--       row in `app_user` to hang an organization off;
--    3. which tenant the pull scripts mean when invoked without `--org`.
--
--  `WHERE is_default = 1` makes the index cover only the rows that claim the
--  flag, so any number of organizations may be non-default and at most one may
--  be the default. Without the predicate a UNIQUE index on the column would
--  permit exactly one row with 0 and one with 1 — which is not the rule.
-- ============================================================================

CREATE TABLE IF NOT EXISTS organization (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,

  -- The stable natural key, for URLs. Derived from the name on write, the way
  -- `project.slug` is, so a rename cannot orphan a bookmark.
  slug           TEXT    NOT NULL UNIQUE,

  -- Display text. Free to change; nothing references it.
  name           TEXT    NOT NULL,

  -- The Fund segment value, as the chart of accounts spells it — '04', not 4.
  -- Leading zeros are significant in every segment of this account structure,
  -- which is why it is TEXT and not INTEGER.
  fund           TEXT    NOT NULL,

  -- JSON text — see the header note. `'[]'` rather than NULL so every reader
  -- parses unconditionally, matching params_json and display_json above.
  -- Empty is a legitimate, savable configuration: it selects no rows, and the
  -- screens then show their ordinary "No rows found" rather than an error.
  programs_json  TEXT    NOT NULL DEFAULT '[]',

  -- The fiscal year the organization's window OPENS in, by Oracle's convention.
  start_fy       INTEGER NOT NULL,

  -- See the header note. INTEGER 0/1 with a CHECK, not a boolean type SQLite
  -- does not have — the same shape `project` uses for its own flags.
  is_default     INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),

  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- The rule, not a convention: at most one row may claim is_default. See the
-- header note for the three questions this one row answers.
CREATE UNIQUE INDEX IF NOT EXISTS organization_one_default
  ON organization(is_default) WHERE is_default = 1;

-- The default organization, seeded once.
--
-- Its configuration is deliberately the scope the extract was already pulled
-- with — Fund 04, programmes 861/862/863, and a Start FY early enough to remove
-- nothing — so the first run of the tenanted app shows exactly what the
-- untenanted app showed, and any later difference is attributable to a change
-- somebody made rather than to the feature landing.
--
-- `INSERT OR IGNORE` keyed on the UNIQUE slug, so re-applying this file is a
-- no-op and an edited default is never silently reset.
INSERT OR IGNORE INTO organization (slug, name, fund, programs_json, start_fy, is_default) VALUES
  ('wake-county', 'Wake County Public Schools', '04', '["861","862","863"]', 2022, 1);


-- ============================================================================
--  app_user — who may sign in, and which tenant they see.
--
--  ---------------------------------------------------------------------------
--  WHY THERE IS NO PASSWORD COLUMN
--  ---------------------------------------------------------------------------
--  Because there is no password store yet, and a column named `password_hash`
--  holding nothing (or holding a plaintext value) would be worse than its
--  absence: a reader would reasonably assume it was the real thing. The one
--  account that can sign in today is the bootstrap pair in `.env`
--  (`SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD`), which is a deployment
--  convenience and not an account — it is gitignored, it is six digits, and it
--  has no lockout. Hashed credentials and a password reset are stated
--  follow-ups, and they belong in this table when they arrive.
--
--  ---------------------------------------------------------------------------
--  WHY organization_id IS NULLABLE EVEN THOUGH EVERY USER BELONGS TO ONE
--  ---------------------------------------------------------------------------
--  The request is that *every* user is associated with one organization, and
--  the session enforces it: `SessionUser.organizationId` is not optional and
--  no request is served a tenantless scope. The column is nullable because
--  "belongs to an organization" and "has been given one here yet" are different
--  states, and collapsing them would make an unassigned user silently inherit
--  whatever the default happens to be. A NULL here means "not assigned", and
--  the sign-in path is what decides to refuse rather than guess.
--
--  ON DELETE is left at the default (NO ACTION) on purpose: deleting an
--  organization that people belong to must fail rather than detach them.
-- ============================================================================

CREATE TABLE IF NOT EXISTS app_user (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,

  -- The sign-in identity. Lower-cased on write; the lookup lower-cases what it
  -- was given, so `Dana@x.gov` and `dana@x.gov` are one account and not two.
  email           TEXT    NOT NULL UNIQUE,

  -- What the avatar and the audit trail show. Never typed by the user.
  display_name    TEXT    NOT NULL,

  -- `super_admin` may create and edit organizations; `member` may not, and the
  -- check is server-side. TEXT with a CHECK rather than a lookup table: there
  -- are two roles and a third would be a decision, not a migration.
  role            TEXT    NOT NULL DEFAULT 'member'
                          CHECK (role IN ('super_admin','member')),

  organization_id INTEGER REFERENCES organization(id),

  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),

  -- Stamped on each successful sign-in. NULL means the account has never been
  -- used, which is a different fact from "used a long time ago".
  last_seen_at    TEXT
);

-- ============================================================================
--  user_pin — a reader's private shortcuts to records in the ledger.
--
--  The ledger identity is kept separately from the label and URL so a renamed
--  project, vendor or invoice does not create a second pin. `owner_email` is
--  the session identity because the bootstrap account can be authenticated
--  without an app_user row; it is still private to one signed-in account.
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_pin (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_email  TEXT    NOT NULL,
  category     TEXT    NOT NULL CHECK (category IN ('project', 'invoice', 'check', 'purchase-order')),
  entity_key   TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  subtitle     TEXT    NOT NULL DEFAULT '',
  href         TEXT    NOT NULL,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (owner_email, category, entity_key)
);

CREATE INDEX IF NOT EXISTS IDX_USER_PIN_OWNER_CATEGORY ON user_pin (owner_email, category, created_at DESC);


-- ============================================================================
--  geo_origin — the place a driving distance is measured FROM.
--
--  ---------------------------------------------------------------------------
--  WHY THIS IS A TABLE AND NOT TWO CONSTANTS IN A COMPONENT
--  ---------------------------------------------------------------------------
--  Every distance the map shows is relative to one point, and the request named
--  it — "the driving distance from Raleigh". Writing those coordinates into the
--  React component would have worked, and would have made three things
--  impossible that cost nothing to allow for here:
--
--    1. The origin is STATED ONCE, in data, where the page can name it. A number
--       that is "34 miles away" is unreadable; "34 miles by road from Raleigh"
--       is an answer, and the name has to come from somewhere.
--    2. A second origin becomes an INSERT rather than a code change. A different
--       warehouse, a school, a second depot — the shape that would require one
--       is obvious, and the distance columns already carry the origin's slug.
--    3. ★ The distances can go STALE DETECTABLY. Move the origin and every
--       measured distance is now answering a question nobody asked, while the
--       pins stay perfectly correct. `vendor_site_geo.drive_origin_slug` records
--       which origin each distance was measured from, so a comparison of the two
--       tells a reader that rather than leaving two rows to disagree silently.
--
--  ---------------------------------------------------------------------------
--  `is_default` IS THE SAME SHAPE `organization.is_default` USES, ON PURPOSE
--  ---------------------------------------------------------------------------
--  A partial unique index over the rows that claim the flag, so any number of
--  origins may be non-default and at most one may be the default. The reader
--  that needs "the origin" asks for `is_default = 1` and gets one row or none,
--  which is a question the schema can answer rather than a convention the code
--  has to remember.
--
--  ---------------------------------------------------------------------------
--  THE SEEDED ROW, AND WHERE ITS COORDINATE CAME FROM
--  ---------------------------------------------------------------------------
--  `raleigh` is seeded with the Raleigh coordinate written into `.env` as
--  MAPBOX_START_LATITUDE / MAPBOX_START_LONGITUDE. That file is the provenance
--  of this value and this row is now its source of truth — the app reads the
--  origin from HERE, not from the environment, so that the number the distances
--  were computed from is the number the page shows.
--
--  It is the city centre, NOT a street address, and that is worth stating: a
--  distance from a centroid is an approximation of a distance from a building.
--  It is the right level of precision for "how far away is this vendor", and the
--  wrong one for planning a route.
--
--  `INSERT OR IGNORE` keyed on the PRIMARY KEY, so re-applying this file is a
--  no-op and an origin somebody has since corrected is never silently reset —
--  the same rule the `organization` seed above follows.
-- ============================================================================

CREATE TABLE IF NOT EXISTS geo_origin (
  -- The stable natural key, and the value stored in `vendor_site_geo`. A slug
  -- rather than a surrogate id because it is the thing a distance row needs to
  -- be able to name without a join, and because it reads in a query.
  slug       TEXT PRIMARY KEY,

  -- Display text, for "34 miles by road from <name>". Free to change; nothing
  -- references it.
  name       TEXT NOT NULL,

  -- Degrees, WGS84. Real numbers, not text: nothing here is an Oracle segment
  -- value, and a coordinate is arithmetic rather than a code.
  latitude   REAL NOT NULL,
  longitude  REAL NOT NULL,

  -- INTEGER 0/1 with a CHECK, not a boolean type SQLite does not have — the same
  -- shape the rest of this file uses for its flags.
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),

  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The rule, not a convention: at most one origin may claim is_default.
CREATE UNIQUE INDEX IF NOT EXISTS geo_origin_one_default
  ON geo_origin(is_default) WHERE is_default = 1;

INSERT OR IGNORE INTO geo_origin (slug, name, latitude, longitude, is_default) VALUES
  ('raleigh', 'Raleigh, North Carolina', 35.7796, -78.7811, 1);


-- ============================================================================
--  vendor_site_geo — where a vendor site is, and how far it is from an origin.
--
--  One row per vendor site, keyed on the identity Oracle already assigns it:
--  `PO_VENDOR_SITES_ALL.VENDOR_SITE_ID`, the primary key of the vendor-address
--  table that the Vendor sites register reads.
--
--  ---------------------------------------------------------------------------
--  WHY vendor_site_id IS NOT A FOREIGN KEY
--  ---------------------------------------------------------------------------
--  Its subject does not live in this database. This is an app-owned table, and
--  the site it describes comes from the LEDGER — Oracle under `DB_MODE=oracle`,
--  the surrogate copy under `local`, either one under `turso`. There is no table
--  here to point at, and there never will be: the app does not own the site row
--  and must not claim to. So the column is a plain key, and the register is
--  joined to this table in the route's TypeScript rather than in SQL — the same
--  arrangement `table_count_snapshot` documents for the objects it counts.
--
--  ---------------------------------------------------------------------------
--  WHY ONE ROW PER SITE AND NOT ONE ROW PER DISTINCT ADDRESS
--  ---------------------------------------------------------------------------
--  Measured on the live register: 800 in-scope sites carry 789 distinct
--  addresses, so 11 sites share a coordinate with another site. That is correct
--  rather than duplicated, and it is why the JOB geocodes 653 distinct addresses
--  while this table stores 800 rows.
--
--    * `VENDOR_SITE_ID` is the identity the register, the page and this table all
--      key on. An address-keyed table would need the route to join across two
--      databases on a STRING.
--    * An address edit keeps the right history: the row becomes stale-but-present
--      with `address_hash` proving it is stale, rather than vanishing and taking
--      the fact that it once had a pin with it.
--    * The driving distance is a function of the pin, and a site has one pin. A
--      second table would make every read a join for no gain.
-- ============================================================================

CREATE TABLE IF NOT EXISTS vendor_site_geo (
  vendor_site_id INTEGER PRIMARY KEY,

  -- The pin. NULL unless `geocode_status = 'matched'`.
  latitude       REAL,
  longitude      REAL,

  -- ---------------------------------------------------------------------------
  -- WHY A STATUS COLUMN EXISTS AT ALL: ABSENCE IS NOT A RECORD, IT IS A SILENCE
  -- ---------------------------------------------------------------------------
  -- Three different things produce "no pin", and they want three different
  -- responses:
  --
  --   'matched'   a pin. Latitude and longitude are set, and so are the quality
  --               fields below.
  --   'no_match'  the geocoder answered and the guard refused the answer — a
  --               garbage address, or a shape that is not a street address. This
  --               is an ANSWER, and re-asking gets the same answer.
  --   'po_box'    recognised before it was sent, and never sent. Also an answer:
  --               a PO box has no rooftop, and the endpoint was measured
  --               returning a STREET for one (see geocode_reason).
  --   'error'     transport, timeout, or a non-200. **This one is retryable**, and
  --               it must never be confused with 'no_match' — the repo has
  --               already been bitten once by a failed query being reported as a
  --               confident zero.
  --
  -- A MISSING ROW means "never attempted". A row here with no pin means
  -- "attempted, and this is what happened". Collapsing those into a NULL
  -- latitude would throw away the only thing the page can say about a site that
  -- is not on the map.
  --
  -- No CHECK on this column, deliberately: SQLite cannot relax a CHECK without
  -- rebuilding the table, and a fifth status is a likelier future edit than a
  -- wrong `permanent` flag. The invariant that CANNOT change is checked instead.
  geocode_status  TEXT    NOT NULL,

  -- The sentence the page shows beside an unmapped site, in words, decided when
  -- the row was written rather than reconstructed in the browser. NULL when the
  -- status is 'matched'.
  geocode_reason  TEXT,

  -- ---------------------------------------------------------------------------
  -- THE QUALITY FIELDS ARE NOT DECORATION
  -- ---------------------------------------------------------------------------
  -- Both of these were measured doing real work on real register addresses:
  -- a site whose STATE reads "CANADA" geocodes to the CORRECT coordinate at
  -- `medium` instead of `exact`, and a 6-digit ZIP is silently corrected to the
  -- right one at `parcel`/`high`. Without these two columns both are invisible,
  -- and both are worth showing — `rooftop` is the building, `interpolated` is a
  -- guess along a street, `approximate` is a hint. A map that draws all three
  -- the same way asserts more than the data says.
  match_confidence TEXT,                       -- exact | high | medium | low
  accuracy         TEXT,                       -- rooftop | parcel | point | interpolated | approximate | intersection

  -- What the geocoder said the match WAS. Asserted equal to 'address' before any
  -- coordinate is written. A request-side `types=address` filter is verified to
  -- refuse the bad shapes, but that is the API's promise and not this app's
  -- check — and a guard that lives only on the request is one a later reader can
  -- remove without noticing.
  feature_type     TEXT,

  -- The geocoder's own stable identifier for the matched feature, so a later
  -- question about this pin can be asked of the API without re-geocoding it.
  mapbox_id        TEXT,

  -- What was sent. Kept because it is the only way to reproduce a pin, and
  -- because the address in Oracle can change afterwards.
  query_address    TEXT,

  -- ---------------------------------------------------------------------------
  -- THE ADDRESS-DRIFT DETECTOR
  -- ---------------------------------------------------------------------------
  -- A hash of the fields that were geocoded (line1|city|state|zip). Without it
  -- the job cannot tell "this address has not changed, skip it" from "this
  -- address is different today than when we pinned it", so it either re-geocodes
  -- every row on every run or it never notices that a site has moved. It is what
  -- makes `no_match` a final answer while leaving `error` retryable and an
  -- edited address re-geocodable — three behaviours from one column.
  address_hash     TEXT,

  -- ---------------------------------------------------------------------------
  -- THE LICENCE, ON THE ROW
  -- ---------------------------------------------------------------------------
  -- The geocoder permits STORING a result only when the request carried
  -- `permanent=true`; without it the result is temporary and "not allowed to be
  -- cached". A row written without it is not allowed to be in this table. That
  -- permission is granted per REQUEST rather than per account, so it is recorded
  -- per row: the licence becomes a fact in the data instead of a property of
  -- code somebody might edit later. Verified working on this key.
  --
  -- This is the CHECK that stays, because 0/1 never becomes 2.
  permanent       INTEGER NOT NULL DEFAULT 0 CHECK (permanent IN (0,1)),

  geocoded_at     TEXT    NOT NULL DEFAULT (datetime('now')),

  -- ---------------------------------------------------------------------------
  -- THE DRIVING DISTANCE — same row, separate provenance
  -- ---------------------------------------------------------------------------
  -- Carried here rather than in a table of its own because it is derived FROM
  -- the pin and a site has exactly one pin. What it must not share is the pin's
  -- timestamp: this is a different measurement, from a different API, taken at a
  -- different moment. If the origin is ever moved these columns go stale while
  -- the pin stays correct, and `drive_origin_slug` is what lets a reader see
  -- that instead of comparing two numbers that answer different questions.
  --
  -- ★ `NULL` IS NOT ZERO. An unroutable pair returns no distance, and writing
  --   `0` would assert that the site sits at the origin — a real and meaningful
  --   value, and one that would then be indistinguishable from "no route". Hence
  --   a status column beside the numbers, exactly as above.
  --     'ok'        a routed pair; miles and minutes are set.
  --     'no_route'  asked, and no road route exists. An answer.
  --     NULL        never computed.
  drive_miles       REAL,
  drive_minutes     REAL,
  drive_status      TEXT,

  -- Which `geo_origin` this distance was measured from. Deliberately NOT a
  -- foreign key: this is the PROVENANCE of a measurement, and provenance has to
  -- outlive the thing it names — deleting an origin must not delete or detach
  -- the record of what was measured from it.
  drive_origin_slug TEXT,
  drive_at          TEXT
);

-- No index beyond the primary key, deliberately. Every read is "these in-scope
-- site ids, one row each", which is a primary-key lookup, and the table holds
-- one row per vendor site — hundreds, not millions. An index here would be
-- machinery for a problem this table does not have.

-- ============================================================================
--  vendor_site_route — the road between the origin and a pin, and its turns
-- ============================================================================
--
--  `vendor_site_geo.drive_miles` says HOW FAR. This table says WHICH WAY, so the
--  panel can draw the road instead of a straight line and list the turns.
--
--  ── ★ WHY THIS IS NOT FOUR MORE COLUMNS ON `vendor_site_geo` ───────────────
--
--  The two tables are read by two different questions, and putting this data on
--  the geo table would break the cheaper of them.
--
--  `readSiteGeo` reads **every covered row in one query** and folds all 800 into
--  the register payload. Measured on three sites across the distance range, one
--  row of this table is 1.2 KB (0.3 KB of geometry + 0.9 KB of steps), 4.0 KB and
--  6.3 KB — a mean near 3.8 KB. On `vendor_site_geo` that is ~3 MB added to
--  **every register load**, for data only one open panel will ever read. Here it
--  is fetched for the one site whose panel is open, and the register payload is
--  unchanged. The grain is the same (one row per site, keyed the same way); the
--  access pattern is not, which is why this is a second table.
--
--  ── ★ `route_miles` IS NOT `drive_miles`, AND THE TWO DO NOT AGREE ────────
--
--  They are measured by two different Mapbox services and they genuinely
--  disagree. Measured on 24 sites spread across the whole range, comparing a
--  fresh Directions answer against the stored `drive_miles`:
--
--      agree within 1 mile : 11 of 24
--      worst gap           : 34.48 mi  (1,232 stored vs 1,198 routed)
--      and it is not rounding: a 4.57 mi site routes at 6.18 mi
--
--  Within the same 24 rows a FRESH Matrix request reproduced the stored value to
--  within 0.0049 mi — i.e. the store's own two-decimal rounding — on every row.
--  So the stored figure is correct and current; it is simply a **different
--  measurement** from the route's. Both are kept, both are named where they are
--  shown, and neither is allowed to stand in for the other. The register's
--  distances, its distance bands and its sort order are all built on
--  `drive_miles` and must stay that way; `route_miles` describes the line drawn
--  on the map and nothing else.
--
--  ── ★ THE LICENCE QUESTION IS ALREADY SETTLED FOR THIS DATA ───────────────
--
--  The geocoder's `permanent=true` rule (see `vendor_site_geo`) is a property of
--  the *geocoding* result. Geometry and steps from the Directions API carry the
--  same Mapbox terms as the tiles the app already draws, and Mapbox documents
--  that Directions results may be stored. There is therefore no `permanent`
--  column here: the flag exists on the other table because that endpoint makes
--  it a per-request licence, and this one does not.
--
--  ── ★ WHY THE GEOMETRY IS SIMPLIFIED AND WHY THAT IS STORED AS A CHOICE ───
--
--  The request asks for `overview=simplified`, and the sampled byte counts are
--  the reason:
--
--      overview=full       130 / 6,289 / 15,136 coordinates  =  2.9 / 139.9 / 336.7 KB
--      overview=simplified  14 /    33 /     49 coordinates  =  0.3 /   0.7 /   1.1 KB
--
--  `full` is un-simplified road geometry at roughly one coordinate every few
--  metres; across 622 routed sites it is about 100 MB, and at that resolution
--  the extra points are invisible at the only zoom levels this panel offers.
--  `simplified` is the same road, simplified to display resolution, and 50x
--  smaller. **The line a reader sees is identical at 220 pixels tall.** The
--  coordinates are additionally rounded to 5 decimal places, which is ~1.1 m —
--  far below one pixel at any zoom this map uses — and which removes the float
--  noise that would otherwise make two rows differ in their last digit.
--
-- ── ★ A MISSING ROW IS NOT THE SAME AS A ROW WITH NO ROUTE ────────────────
  --
  --  Exactly as on `vendor_site_geo`: no row means the job never asked, and a row
  --  means the question was put and this is the answer.
  --
  --  ── ★ WHY THERE IS NO `outside_us` ROW HERE, WHEN `drive_status` HAS ONE ══
  --
  --  `vendor_site_geo.drive_status` stamps `outside_us` and `unclassified` rather
  --  than leaving NULL, because on that row a NULL genuinely means something
  --  different ("never computed") and the page must be able to tell a reader why
  --  a distance is missing.
  --
  --  It is deliberately NOT copied here. This table's candidates are exactly the
  --  pairs `drive_status = 'ok'` — the ones the distance step already established
  --  have a road — so a site outside the United States produces no row, for the
  --  reason it produces no line: there is nothing to draw. Stamping it again
  --  would be a second copy of one fact, written by the same job at a different
  --  moment, with no reader that needs it: the route is fetched *by the panel*,
  --  and the panel already holds the geo block, which says why. Two copies of a
  --  fact are how one of them comes to be wrong unnoticed.
  --
  --  So a reader of this table asks "did we draw a route, and if not, what
  --  happened?" and the geo row answers "why was none drawn".
  -- ============================================================================

CREATE TABLE IF NOT EXISTS vendor_site_route (
  vendor_site_id INTEGER PRIMARY KEY,

  -- ---------------------------------------------------------------------------
  -- `ok` IS THE ONLY STATUS THAT CARRIES A GEOMETRY
  -- ---------------------------------------------------------------------------
  --   'ok'        a route exists. Geometry, steps, miles and minutes are set.
  --   'no_route'  asked, and the service returned no route for the pair. Measured
  --               on a mid-Atlantic coordinate: `NoSegment`, with an empty
  --               `routes` array at HTTP 200. That is an ANSWER — re-asking gets
  --               the same one.
  --   'error'     transport, timeout, a 429 that outlasted its retries, or any
  --               other non-200. **Retryable**, and it must never be confused
  --               with `no_route` — this repository has already been bitten once
  --               by a failed call being stored as a confident zero.
  --
  -- NOT NULL, because the only way to have no answer is to have no row. A NULL
  -- here would be a fourth state meaning the same thing as absence — and it is
  -- precisely because this column is always written that the writer below can be
  -- an upsert. `drive_status` had to be UPDATE-only for the opposite reason: its
  -- INSERT branch could not legally satisfy its own NOT NULL.
  route_status    TEXT    NOT NULL,

  -- The sentence the panel shows when there is no line to draw, decided when the
  -- row was written rather than reconstructed in the browser. NULL when 'ok'.
  route_reason    TEXT,

  -- ---------------------------------------------------------------------------
  -- THE ROUTE'S OWN FIGURES — see the header on why they differ
  -- ---------------------------------------------------------------------------
  -- Both NULL for every non-'ok' status, for the same reason `drive_miles` is:
  -- `0` is a real and meaningful value (a site at the origin) and writing it
  -- where the answer is "no route" would make the two indistinguishable.
  route_miles     REAL,
  route_minutes   REAL,

  -- Which `geo_origin` the route runs from. Not a foreign key, for the reason
  -- given on `vendor_site_geo`: provenance must outlive the thing it names.
  route_origin_slug TEXT,

  -- ---------------------------------------------------------------------------
  -- THE STALENESS DETECTOR
  -- ---------------------------------------------------------------------------
  -- A hash of the pin AND the origin this route was drawn from. Its job is the
  -- same as `address_hash` on the other table and it exists for the same
  -- reason: without it the job cannot tell "this route is current, skip it" from
  -- "this site was re-geocoded to a different coordinate and this line now
  -- starts somewhere else". A re-run that cannot tell those apart re-fetches all
  -- 622 routes and spends 622 metered calls to learn nothing. With it, a run
  -- touches only what moved.
  --
  -- It covers the ORIGIN as well as the pin because the route is a function of
  -- both: moving the origin invalidates every row in this table and must not
  -- require every pin to have changed.
  --
  -- ★ IT ALSO COVERS THE DERIVATION, NOT ONLY THE INPUTS. A third ingredient —
  -- `ROUTE_EXTRACT_VERSION` in the job — is folded in, so bumping that constant
  -- treats every row as stale. The reason is measured rather than theoretical:
  -- the first live run of that step stored `route_miles` in METRES (a 748-mile
  -- drive recorded as 1203677.50) and wrote a perfectly correct `pin_hash` while
  -- doing it, so the next run would have SKIPPED those rows and preserved the
  -- wrong figure for as long as the pins stayed put. A hash over the inputs alone
  -- cannot distinguish "current" from "written by a version of the script that
  -- was wrong", and a stale-value bug is exactly the kind that never announces
  -- itself. See that constant for what does and does not warrant a bump.
  pin_hash        TEXT,

  -- ---------------------------------------------------------------------------
  -- THE ROUTE ITSELF
  -- ---------------------------------------------------------------------------
  -- A JSON array of [longitude, latitude] pairs at 5 decimal places — the plain
  -- LineString coordinate list, not a GeoJSON document. Storing the wrapped
  -- Feature would repeat `{"type":"Feature","properties":{},"geometry":...}` on
  -- every row to satisfy a shape the reader can build in one line, and it would
  -- make "how many points is this line" a parse rather than a `json_array_length`.
  --
  -- NULL for every non-'ok' status. A row that is 'ok' always has at least two
  -- points; the reader treats a shorter list as a defect rather than drawing a
  -- degenerate line.
  geometry        TEXT,

  -- A JSON array of the turns, in order. Each entry carries the fields the panel
  -- renders and no others:
  --
  --   instruction      the service's own sentence, e.g. "Turn left to take the
  --                    I 40 West ramp." — used VERBATIM. Rephrasing it would
  --                    mean inventing text about real roads.
  --   name             the road's name as the service gives it, or null.
  --   distance_miles   the length of THIS step.
  --   duration_minutes how long this step takes.
  --   type, modifier   the manoeuvre's kind and direction, kept as values rather
  --                    than only as prose so the reader can mark a turn apart
  --                    from a straight continuation without parsing a sentence.
  --   longitude/latitude  where the manoeuvre happens, at 5 decimal places. Kept
  --                    for the reason `mapbox_id` is kept on the other table:
  --                    it is the identifying fact, and a later question about
  --                    this turn should not cost another metered call.
  --
  -- ★ THE STEPS SUM TO `route_miles` EXACTLY — verified on six routes, Δ 0.000
  --   mi on all six. That identity is what makes it legitimate to print both a
  --   step's own length and a route total: a reader who adds the column up gets
  --   the number at the top of it.
  steps           TEXT,

  -- The number of entries in `steps`, written rather than derived so a reader can
  -- state "38 turns" without parsing the array — and so a cap in the UI can be
  -- explained ("showing the first 12 of 38") while the full list stays stored.
  step_count      INTEGER,

  route_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- No index beyond the primary key, for the reason given above: the only read is
-- one site's route, by primary key.


-- ============================================================================
--  field_override — a name of our own for a value the ledger already holds.
--
--  One row per (subject, key, field) the app has a custom value for. The table
--  is deliberately NARROW: it stores a custom value and the attribution for it
--  and nothing else, because every field it can name already exists in the
--  ledger, and Oracle is never written to by this app.
--
--  ---------------------------------------------------------------------------
--  WHY THERE IS NO FOREIGN KEY HERE
--  ---------------------------------------------------------------------------
--  Neither half of the key lives in this database. `subject_key` names a row in
--  the LEDGER — Oracle under `DB_MODE=oracle`, the surrogate copy under `local`,
--  either one under `turso` — and the ledger is the extract of record, which this
--  app must not write to and cannot point a constraint at. There is no table here
--  to point at and there never will be. So both key columns are plain values and
--  the page joins them to the register in the route's TypeScript rather than in
--  SQL, the same arrangement `vendor_site_geo` documents for `vendor_site_id`.
--
--  ★ AND THE JOIN IS WHAT KEEPS AN ORPHAN VISIBLE RATHER THAN FATAL. A ledger name
--    can change under a row that was overridden — the register is re-read from
--    Oracle on every pull — and no constraint here would notice. So the read
--    endpoint returns the WHOLE subject rather than only the keys the page asked
--    about, and an override whose subject no longer resolves is still served and
--    can be seen, instead of being silently dropped by the join that was supposed
--    to carry it.
--
--  ---------------------------------------------------------------------------
--  WHY subject_key IS A NAME AND NOT AN ID
--  ---------------------------------------------------------------------------
--  Measured, not assumed: the invoice extract this page reads
--  (`WCSEXP_AP_INVOICE_PAYMENTS`) carries `VENDOR_NAME` and has **no `VENDOR_ID`**
--  — see its envelope, `body.ResultSets.Table1`. So the identity the PAGE holds,
--  and therefore the only key it could send, is the name. The route folds it the
--  way `keyOf` in the client does (uppercase, every non-alphanumeric removed)
--  before storing it, so one company arriving with a stray double space is one
--  row here.
--
--  ★ THE COLLISION THIS ACCEPTS. A vendor name is not a key on the ledger.
--    Measured: 0 of 157 names on the sample database and 0 of 55 on the FY27
--    extract fold to the same key, so on today's data the fold is injective. That
--    is a measurement and not a guarantee, and the endpoint says so in words: two
--    companies would share one override. The alternative — an id — does not exist
--    on the source. The panel already prints the same caveat for its master-record
--    lookup, which resolves on an exact name for exactly this reason.
--
--  ---------------------------------------------------------------------------
--  WHY set_by IS NOT A FOREIGN KEY TO app_user
--  ---------------------------------------------------------------------------
--  Attribution has to outlive the thing it names, exactly as
--  `saved_view.created_by` documents. A user who is removed, or whose account is
--  renamed, must not take the record of who set a name with them — that a person
--  overrode a ledger value is the reason `set_by` is stored at all. So it is plain
--  TEXT holding the name the session carried, not an id pointing at a row that can
--  go.
--
--  ---------------------------------------------------------------------------
--  WHY ONLY THE CUSTOM VALUE IS STORED, AND NOT A COPY OF THE ORACLE VALUE
--  ---------------------------------------------------------------------------
--  The trash icon restores "the field from Oracle", and it does that by deleting
--  this row and letting the register render whatever the ledger says. A cached
--  copy of the Oracle value would be a second source for a figure this app does
--  not own: stale the moment Oracle was re-extracted, and worse, a delete would
--  then mean "restore from our copy" rather than "stop substituting" — a
--  different promise than the one the UI makes.
--
--  ---------------------------------------------------------------------------
--  WHY THERE IS NO organization_id
--  ---------------------------------------------------------------------------
--  The other global app tables have none: `saved_view`, `project`, `geo_origin`,
--  `vendor_site_geo` and `vendor_site_route` are all keyed on their subject, and
--  the tenant is a property of the request rather than of the row. Adding one here
--  would make one vendor under two tenants two rows whose values could disagree,
--  with nothing requiring that they differ.
--
--  ---------------------------------------------------------------------------
--  WHY set_at IS A DEFAULT AND NOT A COLUMN THE ROUTE FILLS IN
--  ---------------------------------------------------------------------------
--  `datetime('now')` is what the rest of this file uses, and it is the only clock
--  in the write path: the route never sends a timestamp it computed itself,
--  because a server clock and a database clock are two clocks and the attribution
--  should carry one of them.
--
--  A save is an UPSERT. Writing the same value twice updates `set_by` and `set_at`
--  and touches no other row. That is why the primary key is the natural
--  (subject, key, field) triple rather than a surrogate id: the uniqueness the app
--  needs is "one value per field of one subject", and a surrogate id would permit
--  two.
-- ============================================================================

CREATE TABLE IF NOT EXISTS field_override (
  -- 'vendor' today. Validated against a registry entry rather than against an
  -- enum or a CHECK — see `server/src/custom-fields/registry.ts`, which is the
  -- only place the (subject, field) pairs are declared. An unlisted pair is
  -- refused by the ROUTE, deliberately not by a constraint here: SQLite cannot
  -- relax a CHECK without rebuilding the table, and the set of overridable fields
  -- is meant to grow a few at a time.
  subject_kind TEXT NOT NULL,

  -- The subject's identity, folded — for a vendor, `keyOf(name)`: the name
  -- uppercased with every non-alphanumeric removed. Stored folded rather than as
  -- written, so two spellings of one company are one row.
  subject_key  TEXT NOT NULL,

  -- The same key as the caller wrote it, kept for exactly one reason: the read
  -- endpoint serves the WHOLE subject, so an override whose company has left the
  -- register is still served rather than dropped — and the folded form above is
  -- not a thing to show a reader (it is
  -- `ARENAPLACECONDOMINIUMASSOCIATIONINCC/OLUNDYMANAGEMENTGROUPDBALEEASSOCIATES...`).
  -- Null means the row was written before this column existed; the route falls
  -- back to the fold, which loses the spelling and nothing else.
  subject_written TEXT,

  -- The field's name as the registry declares it. 'name' today.
  field        TEXT NOT NULL,

  -- The reader's value. Never blank: the route refuses a blank and the message
  -- names the trash, because "clear this override" is spelled the same way as
  -- "name it the empty string" and only one of those is what was meant.
  value        TEXT NOT NULL,

  -- Who set it, as the session named them. Not an id — see the note above.
  set_by       TEXT NOT NULL,

  set_at       TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (subject_kind, subject_key, field)
);

-- No index beyond the primary key, deliberately. The only read is one subject's
-- overrides, which the primary key's leading column already serves, and the write
-- is a point lookup on the whole triple. Hundreds of rows, not millions.


-- ============================================================================
--  ledger_read_cap — how many rows this app reads from a ledger object, and in
--  what order.
--
--  ---------------------------------------------------------------------------
--  WHY THIS TABLE EXISTS
--  ---------------------------------------------------------------------------
--  The EBS instance holds tables in the hundreds of millions of rows
--  (`GL_BALANCES` is 157 M; the AP surface is 1.2 M checks). A register that
--  reads one of those whole is not slow — it is a request that never returns.
--  This table is where an administrator says, per object, "read at most N rows,
--  and read them *this* way", so the bound is data that can be changed without a
--  deploy rather than a constant in a route.
--
--  ---------------------------------------------------------------------------
--  ★ `order_by` IS REQUIRED WHENEVER `max_rows` IS SET, AND THAT IS THE WHOLE
--    POINT OF THE TABLE
--  ---------------------------------------------------------------------------
--  A cap with no ordering is not a smaller answer — it is a DIFFERENT, ARBITRARY
--  one. `SELECT * FROM AP_INVOICES_ALL WHERE ROWNUM <= 100000` returns whichever
--  rows Oracle reached first: a count of 100,000 then means "at least 100,000",
--  a sum is the sum of an unknown subset, and every percentage on the page has
--  the wrong denominator. None of that is visible in the payload.
--
--  With an ordering it becomes a reproducible window that can be *labelled*:
--  "the 100,000 most recent by INVOICE_DATE". That is a claim a reader can check
--  and a screen can state. The route refuses a row with `max_rows` and no
--  `order_by` rather than running it, because the un-ordered form is the one that
--  arrives looking correct.
--
--  ---------------------------------------------------------------------------
--  ★ A CAP IS NOT A PERFORMANCE FIX, AND THIS TABLE DOES NOT PRETEND TO BE ONE
--  ---------------------------------------------------------------------------
--  The cap bounds what crosses the wire and what the process holds. It does NOT
--  bound the work: Oracle still has to *find* the first N rows, so on an
--  unindexed predicate the statement is as expensive as before. The lever that
--  makes a read fast is the scope — the fund/programme/start-FY predicate pushed
--  into the SQL — which is why `db/row-budget.ts` bounds what may be *returned*
--  while the scope owns what may be *read*. Both are needed and they do different
--  jobs; a comment here claiming otherwise would be the kind of thing this
--  project has already had to retract once.
--
--  ---------------------------------------------------------------------------
--  ★ THE SQL IS PER-DIALECT, AND THE ROUTE OWNS THE DIFFERENCE
--  ---------------------------------------------------------------------------
--  Oracle has no `LIMIT`: it spells the cap `FETCH FIRST n ROWS ONLY` (12c+) or
--  the nested `ROWNUM` form (11g+). SQLite/libSQL spells it `LIMIT n`. The
--  `sql` column therefore stores a statement WITHOUT a cap — the cap is appended
--  by `db/read-cap.ts` in the dialect of whichever store the statement routed to,
--  so one row serves both backends and the stored text never has to be edited
--  when the deployment moves from one to the other.
-- ============================================================================

CREATE TABLE IF NOT EXISTS ledger_read_cap (
  -- The ledger object this row governs, as the registry spells it —
  -- 'AP_INVOICES_ALL', 'GL_BALANCES'. Matched case-insensitively by the resolver,
  -- because Oracle uppercases unquoted identifiers and a person typing a table
  -- name will not reliably do so.
  table_name  TEXT NOT NULL PRIMARY KEY,

  -- The statement the app runs for this object. Stored WITHOUT a row cap: the cap
  -- is appended per dialect at read time (see the header). NULL means "no stored
  -- statement" — the object is capped but still read by whatever route owns it,
  -- which is the common case for a table the app already knows how to query.
  sql         TEXT,

  -- The cap. NULL means uncapped, which is the default: a table is only bounded
  -- when somebody decides it needs to be, so adding this table changes no
  -- behaviour until a row is written.
  max_rows    INTEGER,

  -- ★ REQUIRED WHEN `max_rows` IS SET. The column(s) the window is taken in, as
  -- the ledger names them — 'INVOICE_DATE DESC', 'CHECK_ID'. Text rather than
  -- structured, because the app does not parse it: it is interpolated into the
  -- statement's ORDER BY by `db/read-cap.ts` after passing the same identifier
  -- allowlist every other ORDER BY in this server passes (`parseSort`), so a
  -- value that is not a plain column name with an optional direction is refused
  -- rather than concatenated.
  order_by    TEXT,

  -- Why this number, in the administrator's own words. Shown in the panel beside
  -- the field, because "100,000" with no reason is a number the next reader will
  -- change. Nothing parses it.
  note        TEXT,

  -- Who set it and when, as the session named them — the same convention as
  -- `saved_view.created_by` and `field_override.set_by`: a display name frozen at
  -- the moment of the write, not a foreign key, so a later rename does not rewrite
  -- a historical attribution.
  set_by      TEXT,
  set_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- No index beyond the primary key. The table has one row per ledger object the
-- app reads (tens, not thousands), and every read is a point lookup by name or a
-- full scan of the whole table for the admin list. An index would be decoration.

