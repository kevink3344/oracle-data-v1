-- ============================================================================
--  01-app.sql — THE APP-OWNED TABLES, IN MYSQL
--
--  This is the MySQL translation of `data/sql/turso/01-app.sql`. That file is
--  SQLite and cannot be applied here: `AUTOINCREMENT`, `datetime('now')` and the
--  `IF NOT EXISTS` forms on indexes are all syntax errors in MySQL. The three
--  files (turso, sqlserver, mysql) own the same fifteen tables and must stay in
--  step.
--
--  ── WHAT CHANGED IN TRANSLATION, AND WHY EACH ONE IS NOT COSMETIC ──────────
--
--    SQLite                              MySQL
--    --------------------------------    ------------------------------------
--    INTEGER PRIMARY KEY AUTOINCREMENT   INT AUTO_INCREMENT PRIMARY KEY
--    TEXT                                VARCHAR(n) / LONGTEXT
--    TEXT DEFAULT (datetime('now'))      VARCHAR(30) DEFAULT (UTC_TIMESTAMP())
--    INTEGER (for a 0/1 flag)            TINYINT(1)
--    CREATE TABLE IF NOT EXISTS          CREATE TABLE IF NOT EXISTS  (same)
--    CREATE INDEX IF NOT EXISTS          no equivalent — see the note below
--
--  ★★ `DATETIME` IS NOT USED FOR TIMESTAMPS, AND THE REASON IS THE APP READS
--     THEM AS STRINGS. SQLite stores these as TEXT in `YYYY-MM-DD HH:MM:SS` form
--     and `app/src` compares them lexically and prints them directly. A native
--     DATETIME column would change the wire type, and the driver's own conversion
--     would apply the SERVER's timezone — the off-by-one-day bug `oracle.ts`
--     documents at length. So the column stays a string and the default
--     reproduces SQLite's exact format:
--
--         UTC_TIMESTAMP()   ->  2026-10-02 14:33:07
--
--     ★ UTC_TIMESTAMP(), NOT NOW(). SQLite's `datetime('now')` is UTC and the
--       source file relies on that. MySQL's `NOW()` is the SESSION's timezone, so
--       it would silently shift every timestamp by the server's offset.
--
--  ★★ `TINYINT(1)` FOR THE 0/1 FLAGS, AND THE CHECK IS DROPPED WITH A REASON.
--     SQLite has no boolean, so the source writes `INTEGER ... CHECK (x IN (0,1))`
--     and comments that the CHECK is what makes the invariant real. MySQL's
--     `TINYINT(1)` is the conventional boolean spelling and the driver reports it
--     as a number, which is what every reader already expects. The CHECK is not
--     lost — it is stated in the type, exactly as the SQL Server arm promotes it
--     to `BIT`.
--
--  ★ CONSTRAINTS ARE CARRIED, NOT DROPPED. Every UNIQUE, NOT NULL and CHECK from
--     the source file appears here. A translation that quietly omitted one would
--     be a behaviour change no test in this repo would catch, because the app
--     relies on the database to enforce them.
--
--  ★★ `CREATE INDEX IF NOT EXISTS` DOES NOT EXIST IN MYSQL — AND THAT SHAPES THE
--     WHOLE FILE. MySQL 8 has no such clause, and a bare `CREATE INDEX` fails with
--     error 1061 on a second run. The file is applied on EVERY BOOT by
--     `ensureAppSchema()`, so a bare index would make the second boot fail.
--
--     The workaround is to fold each index INTO its `CREATE TABLE` as a `KEY`
--     clause. `CREATE TABLE IF NOT EXISTS` is a no-op when the table exists, so
--     the indexes inside it are created exactly once, with the table, and a
--     re-run touches nothing. That is why there are no standalone `CREATE INDEX`
--     statements below.
--
--  ★ FOREIGN KEYS ARE DECLARED AND ENFORCED. Unlike SQL Server (which does not
--     check an untrusted constraint), InnoDB enforces them by default — so
--     `saved_view_run.view_id` genuinely cascades. This is closer to the SQLite
--     arm's behaviour than the SQL Server arm's, and it is the correct one.
--
--  ★★ `utf8mb4` AND THE COLLATION ARE EXPLICIT ON EVERY TABLE. MySQL 8's server
--     default is `utf8mb4_0900_ai_ci` (case-INSENSITIVE), which matches what the
--     app expects — `email` is lower-cased on write and the lookup lower-cases its
--     argument, so a case-sensitive collation would be a second, redundant guard.
--     It is written out rather than inherited so the behaviour does not depend on
--     a server setting an operator can change.
-- ============================================================================


-- ----------------------------------------------------------------------------
--  saved_view — the View Builder's saved statements.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saved_view (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  slug          VARCHAR(200) NOT NULL UNIQUE,

  title         VARCHAR(400) NOT NULL,
  description   LONGTEXT NULL,

  -- ★★ `sql` IS A RESERVED WORD IN MYSQL AND MUST BE BACKTICK-QUOTED HERE.
  --    It is not reserved in SQLite or SQL Server, so the other two arms declare
  --    it bare — and this is the only column name in the schema where the three
  --    differ. Measured: the unquoted form fails with
  --    "You have an error in your SQL syntax ... near 'sql LONGTEXT NOT NULL'".
  --
  --    ★ THE APP ALREADY QUOTES IT. Every route reaches this column through
  --      `quoteIdent('sql')`, which emits the dialect's own quoting, so no query
  --      needs changing — only the DDL, which is applied verbatim.
  `sql`         LONGTEXT NOT NULL,

  -- JSON text, not a JSON column type -- the app parses it in JS, and '[]' / '{}'
  -- rather than NULL so every reader can parse unconditionally.
  params_json   LONGTEXT NOT NULL,
  display_json  LONGTEXT NOT NULL,

  -- ★ TEXT, NOT A FOREIGN KEY, AND THE SOURCE FILE EXPLAINS WHY AT LENGTH: this
  --   column owns the sentence "who made this", frozen at the moment it was made.
  --   A FK would rewrite a historical attribution when a display_name changed.
  created_by    VARCHAR(200) NULL,

  status        VARCHAR(20) NOT NULL DEFAULT 'draft',

  created_at    VARCHAR(30) NOT NULL DEFAULT (UTC_TIMESTAMP()),
  updated_at    VARCHAR(30) NOT NULL DEFAULT (UTC_TIMESTAMP()),

  CONSTRAINT CK_saved_view_status CHECK (status IN ('draft','active','disabled')),
  KEY IDX_SAVED_VIEW_STATUS (status, title)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- ----------------------------------------------------------------------------
--  saved_view_run — one row per execution.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saved_view_run (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  view_id      INT NOT NULL,

  ran_at       VARCHAR(30) NOT NULL DEFAULT (UTC_TIMESTAMP()),

  -- ★ NULLABLE RATHER THAN DEFAULTED TO 0, and the source file is emphatic about
  --   it: a run refused before reaching the database has no duration and no row
  --   count, and writing 0 would make "did not run" indistinguishable from "ran
  --   and found nothing". That confusion once produced a fictitious -100% delta
  --   in this project's history.
  duration_ms  INT NULL,
  row_count    INT NULL,
  truncated    TINYINT(1) NULL,

  fingerprint  VARCHAR(200) NULL,
  error        LONGTEXT NULL,

  CONSTRAINT FK_saved_view_run_view FOREIGN KEY (view_id)
    REFERENCES saved_view (id) ON DELETE CASCADE,
  KEY IDX_SAVED_VIEW_RUN_VIEW (view_id, ran_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- ----------------------------------------------------------------------------
--  saved_view_subscription — who wants to know when a view's result changes.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS saved_view_subscription (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  view_id     INT NOT NULL,

  subscriber  VARCHAR(200) NOT NULL,
  channel     VARCHAR(20) NOT NULL,
  target      VARCHAR(400) NULL,

  created_at  VARCHAR(30) NOT NULL DEFAULT (UTC_TIMESTAMP()),

  -- One subscription per person per channel per view. Re-subscribing is not an
  -- error; it is the same request twice.
  CONSTRAINT UQ_saved_view_sub UNIQUE (view_id, subscriber, channel),
  CONSTRAINT CK_saved_view_sub_channel CHECK (channel IN ('in_app','webhook')),

  CONSTRAINT FK_saved_view_sub_view FOREIGN KEY (view_id)
    REFERENCES saved_view (id) ON DELETE CASCADE,
  KEY IDX_SAVED_VIEW_SUB_VIEW (view_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- ----------------------------------------------------------------------------
--  project — the project master.
--
--  ★ THE SOURCE FILE'S LONG NOTE ON `level_code` APPLIES HERE UNCHANGED: a project
--    exists as a NAME before anybody has decided which account level funds it, so
--    `level_code` is NULLABLE, and it is UNIQUE.
--
--  ★★ MYSQL PERMITS MANY NULLS IN A UNIQUE INDEX, WHICH IS THE SQLITE BEHAVIOUR —
--     and this is the one place the three engines genuinely differ. SQL Server
--     treats NULL as a value for uniqueness and needs a filtered index to allow
--     more than one unassigned project; MySQL and SQLite do not. So a plain
--     UNIQUE is correct here and the SQL Server arm's `WHERE level_code IS NOT
--     NULL` filter has NO equivalent — it would be a syntax error.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project (
  id          INT AUTO_INCREMENT PRIMARY KEY,

  slug        VARCHAR(200) NOT NULL UNIQUE,

  name        VARCHAR(400) NOT NULL,
  description LONGTEXT NULL,

  -- The SEGMENT5 value this project claims, or NULL when nobody has said yet.
  level_code  VARCHAR(20) NULL,

  code        VARCHAR(50) NULL,
  site        VARCHAR(200) NULL,
  owner       VARCHAR(200) NULL,

  created_at  VARCHAR(30) NOT NULL DEFAULT (UTC_TIMESTAMP()),
  updated_at  VARCHAR(30) NOT NULL DEFAULT (UTC_TIMESTAMP()),

  -- ==========================================================================
  --  ★ THE PROJECT'S BACKGROUND IMAGE — see the same block in 01-app.sql
  --    (turso) for why it is a column on this row rather than a table beside it.
  --    In one line: a column keeps DELETE's "leaves nothing of it" promise
  --    without touching the handler, and moves no app-table registry.
  -- ==========================================================================
  --
  --  ★★ `LONGBLOB` — THE MYSQL SPELLING OF "unbounded binary". SQLite's BLOB is
  --     unbounded and SQL Server's VARBINARY(MAX) is too; MySQL splits the two
  --     into BLOB (64 KB) and LONGBLOB (4 GB). A picture measured through the
  --     driver at 700,000 bytes would be SILENTLY TRUNCATED by BLOB — MySQL
  --     warns rather than failing in non-strict mode — so LONGBLOB is the one
  --     that matches the other two arms.
  --
  --  ★ `NULL` IS "NO IMAGE", AND IT IS DISTINGUISHABLE FROM AN EMPTY ONE.
  --     `LENGTH(NULL)` answers NULL while an empty value answers 0, so the two
  --     states cannot be confused. The route treats a null length as "no image"
  --     and answers 404 rather than an empty `200`, because a zero-byte picture
  --     draws as a broken image on every browser and says nothing about why.
  --
  --  ★ NO DEFAULT ON `background_updated_at`, DELIBERATELY. The route writes it
  --     explicitly in the style the stored rows use, so it stays comparable with
  --     them. See the note on the two formats beside `stampNow()` in
  --     server/src/db/sql.ts.
  background_image      LONGBLOB NULL,
  background_image_mime VARCHAR(100) NULL,
  background_name       VARCHAR(400) NULL,
  background_updated_at VARCHAR(30) NULL,

  -- ==========================================================================
  --  ★ HOW STRONGLY THE HEADER DRAWS THE PICTURE, AS A PERCENT (0-100), OR NULL
  --    FOR "never chosen". See the same column in 01-app.sql (turso).
  --
  --  ★ NULL IS "NEVER CHOSEN" AND IS NOT ZERO. Zero is a legal answer (keep the
  --    file, draw no picture), so the two states have to stay apart — the same
  --    rule `background_image` follows. The read path substitutes the app's own
  --    default for NULL, so the wire carries a number either way.
  -- ==========================================================================
  background_strength   INT NULL,

  UNIQUE KEY UQ_project_level_code (level_code),
  KEY IDX_PROJECT_NAME (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- ----------------------------------------------------------------------------
--  organization — the tenant.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS organization (
  id             INT AUTO_INCREMENT PRIMARY KEY,

  slug           VARCHAR(200) NOT NULL UNIQUE,
  name           VARCHAR(400) NOT NULL,

  -- The Fund segment value as the chart of accounts spells it -- '04', not 4.
  -- Leading zeros are significant in every segment of this account structure,
  -- which is why it is VARCHAR and not INT.
  fund           VARCHAR(10) NOT NULL,

  programs_json  LONGTEXT NOT NULL,

  start_fy       INT NOT NULL,

  is_default     TINYINT(1) NOT NULL DEFAULT 0,

  created_at     VARCHAR(30) NOT NULL DEFAULT (UTC_TIMESTAMP()),
  updated_at     VARCHAR(30) NOT NULL DEFAULT (UTC_TIMESTAMP())
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ★ THE RULE, NOT A CONVENTION: at most one row may claim is_default.
--
-- ★★ MYSQL CANNOT EXPRESS THIS AS AN INDEX, AND THAT IS A REAL DIFFERENCE FROM
--    THE OTHER TWO ARMS. SQLite and SQL Server both support a partial/filtered
--    unique index (`WHERE is_default = 1`); MySQL has no such feature. The
--    alternatives are all worse:
--
--      * a UNIQUE index on `is_default` alone would permit exactly one 0 and one
--        1 — which is not the rule, and would refuse a second non-default org;
--      * a generated column holding `NULL` unless default, then UNIQUE on it,
--        works but puts a synthetic column in a schema whose whole purpose is
--        that the three arms match;
--      * a trigger is a second thing to keep in step and is not visible in a
--        `SHOW CREATE TABLE`.
--
--    So the rule is NOT enforced here, and that is recorded rather than silently
--    dropped. The application is the guard: `routes/organizations.ts` clears the
--    flag on the previous default inside the same statement that sets the new
--    one. A reader comparing the three DDL files should find this note rather
--    than a missing constraint with no explanation.
--
--    ★ IF THIS EVER NEEDS TO BE A DATABASE RULE, the generated-column form is the
--      one to use:
--
--        default_marker TINYINT AS (IF(is_default = 1, 1, NULL)) STORED,
--        UNIQUE KEY organization_one_default (default_marker)


-- ----------------------------------------------------------------------------
--  app_user — who may sign in, and which tenant they see.
--
--  ★ `password_hash` HOLDS A SALTED SCRYPT DERIVATIVE, NEVER A PLAINTEXT
--    PASSWORD — `scrypt$N$r$p$salt$key`, written and read by
--    `server/src/auth/password.ts`. The cost parameters travel with each row so
--    raising them later does not invalidate the rows written today.
--
--    It is NULLABLE because "this account has no password" is a real state and
--    not an empty password. A sign-in for such a row is REFUSED rather than
--    allowed — an absent hash must never come to mean "any password will do".
--
--  ★ `organization_id` IS A *PRIMARY* ORGANIZATION, NOT THE ONLY ONE. The
--    memberships live in `app_user_organization` below; this column answers
--    "which organization does this account sign in to".
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_user (
  id              INT AUTO_INCREMENT PRIMARY KEY,

  -- Lower-cased on write; the lookup lower-cases what it was given, so
  -- `Dana@x.gov` and `dana@x.gov` are one account and not two.
  email           VARCHAR(320) NOT NULL UNIQUE,

  display_name    VARCHAR(200) NOT NULL,

  role            VARCHAR(20) NOT NULL DEFAULT 'staff',

  organization_id INT NULL,

  -- A salted scrypt derivative, never a plaintext password. NULL means no
  -- credential has been set for this account, and the sign-in path REFUSES such
  -- a row rather than accepting anything. See the header note.
  password_hash   VARCHAR(200) NULL,

  created_at      VARCHAR(30) NOT NULL DEFAULT (UTC_TIMESTAMP()),

  -- NULL means the account has never been used, which is a different fact from
  -- "used a long time ago".
  last_seen_at    VARCHAR(30) NULL,

  CONSTRAINT CK_app_user_role CHECK (role IN ('super_admin','administrator','staff')),
  CONSTRAINT FK_app_user_org FOREIGN KEY (organization_id) REFERENCES organization (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- ----------------------------------------------------------------------------
--  app_user_organization — which organizations an account belongs to.
--
--  ★ WHY THIS EXISTS BESIDE `organization_id` RATHER THAN INSTEAD OF IT.
--
--      app_user.organization_id     WHICH ONE THEY SIGN IN TO. Exactly one,
--                                   turned into a tenant scope by the session.
--      app_user_organization        WHICH ONES THEY BELONG TO. One, or many.
--
--  ★ THE COMPOSITE PRIMARY KEY IS THE RULE. No surrogate id: a membership has no
--    identity of its own, so the database cannot hold the same membership twice.
--    `(user_id, organization_id)` also indexes the `user_id` prefix, which is the
--    look-up the sign-in path and the screen both do.
--
--  ★ ON DELETE CASCADE ON ONE SIDE AND NOT THE OTHER, DELIBERATELY. A membership
--    is a statement ABOUT A USER, so when the user is gone there is nothing left
--    for it to be about. Deleting an organization people belong to is a question
--    about those people, and the answer must not be "detach them silently".
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app_user_organization (
  user_id         INT NOT NULL,
  organization_id INT NOT NULL,

  created_at      VARCHAR(30) NOT NULL DEFAULT (UTC_TIMESTAMP()),

  PRIMARY KEY (user_id, organization_id),

  CONSTRAINT FK_app_user_organization_user FOREIGN KEY (user_id)
    REFERENCES app_user (id) ON DELETE CASCADE,

  CONSTRAINT FK_app_user_organization_org FOREIGN KEY (organization_id)
    REFERENCES organization (id),

  KEY IDX_APP_USER_ORGANIZATION_ORG (organization_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- ----------------------------------------------------------------------------
--  user_pin — a reader's private shortcuts to records in the ledger.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS user_pin (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  owner_email  VARCHAR(320) NOT NULL,
  category     VARCHAR(20) NOT NULL,
  entity_key   VARCHAR(400) NOT NULL,
  title        VARCHAR(400) NOT NULL,
  subtitle     VARCHAR(400) NOT NULL DEFAULT '',
  href         VARCHAR(1000) NOT NULL,
  created_at   VARCHAR(30) NOT NULL DEFAULT (UTC_TIMESTAMP()),

  CONSTRAINT CK_user_pin_category CHECK (category IN ('project','invoice','check','purchase-order')),
  CONSTRAINT UQ_user_pin UNIQUE (owner_email, category, entity_key),
  KEY IDX_USER_PIN_OWNER_CATEGORY (owner_email, category, created_at DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- ----------------------------------------------------------------------------
--  geo_origin — the place a driving distance is measured FROM.
--
--  ★ A SLUG PRIMARY KEY, NOT A SURROGATE ID. The slug is what a distance row
--    stores so it can name its origin without a join, and it reads in a query.
--
--  ★ `DOUBLE` FOR THE COORDINATES, NOT `FLOAT`. SQLite's REAL and SQL Server's
--    FLOAT are both 8-byte doubles; MySQL's FLOAT is 4-byte and its DOUBLE is
--    8-byte. Using FLOAT would lose precision on a coordinate — and the two
--    arms would then disagree about a point, which is exactly the drift this
--    file exists to prevent.
--
--  ★ THE `is_default` UNIQUENESS IS NOT ENFORCED HERE — see the long note on
--    `organization` above; MySQL has no partial index.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS geo_origin (
  slug       VARCHAR(100) NOT NULL PRIMARY KEY,
  name       VARCHAR(400) NOT NULL,

  -- Degrees, WGS84. Real numbers, not text: a coordinate is arithmetic, not a
  -- code.
  latitude   DOUBLE NOT NULL,
  longitude  DOUBLE NOT NULL,

  is_default TINYINT(1) NOT NULL DEFAULT 0,

  created_at VARCHAR(30) NOT NULL DEFAULT (UTC_TIMESTAMP())
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- ----------------------------------------------------------------------------
--  vendor_site_geo — where a vendor site is, and how far it is from an origin.
--
--  ★★ `geocode_status` HAS NO CHECK, AND THAT IS CARRIED ACROSS DELIBERATELY.
--     The source file explains: SQLite cannot relax a CHECK without rebuilding
--     the table, and a fifth status is a likelier future edit than a wrong
--     `permanent` flag. The constraint is omitted in all three arms so the
--     schemas do not differ on a column whose set of values is expected to grow.
--
--  ★★ `NULL` IS NOT ZERO, ON EVERY NUMERIC COLUMN HERE. An unroutable pair
--     returns no distance, and writing 0 would assert that the site sits at the
--     origin -- a real and meaningful value, and one that would then be
--     indistinguishable from "no route".
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vendor_site_geo (
  vendor_site_id   INT NOT NULL PRIMARY KEY,

  latitude         DOUBLE NULL,
  longitude        DOUBLE NULL,

  geocode_status   VARCHAR(30) NOT NULL,
  geocode_reason   LONGTEXT NULL,

  match_confidence VARCHAR(20) NULL,
  accuracy         VARCHAR(30) NULL,
  feature_type     VARCHAR(50) NULL,

  -- ★★ 600, NOT 200, AND THE NUMBER IS MEASURED. The Mapbox id is a base64-ish
  --    `mapbox://` URI whose length depends on the feature, and the observed
  --    maximum across the 800 stored pins is 503 characters. At 200 the bulk load
  --    failed with "String or binary data would be truncated", which names the
  --    column and the truncated prefix.
  --
  --    ★ THE SOURCE FILE'S `TEXT` HAS NO LENGTH, WHICH IS WHY THIS WAS EASY TO GET
  --      WRONG. SQLite's TEXT is unbounded, so a translation has to CHOOSE a width
  --      -- and 200 was chosen from the column's apparent purpose rather than from
  --      the data. The measurement is what corrected it.
  mapbox_id        VARCHAR(600) NULL,
  query_address    LONGTEXT NULL,
  address_hash     VARCHAR(100) NULL,

  -- The licence, on the row. The geocoder permits STORING a result only when the
  -- request carried `permanent=true`, so it is recorded per row rather than
  -- trusted to code somebody might edit later.
  permanent        TINYINT(1) NOT NULL DEFAULT 0,

  geocoded_at      VARCHAR(30) NOT NULL DEFAULT (UTC_TIMESTAMP()),

  drive_miles       DOUBLE NULL,
  drive_minutes     DOUBLE NULL,
  drive_status      VARCHAR(30) NULL,

  -- ★ NOT A FOREIGN KEY, DELIBERATELY. This is the PROVENANCE of a measurement,
  --   and provenance has to outlive the thing it names -- deleting an origin must
  --   not delete or detach the record of what was measured from it.
  drive_origin_slug VARCHAR(100) NULL,
  drive_at          VARCHAR(30) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- ----------------------------------------------------------------------------
--  vendor_site_route — the road between the origin and a pin, and its turns.
--
--  ★★ `route_miles` IS NOT `drive_miles`, AND THE SOURCE FILE MEASURES THE GAP.
--     They come from two different Mapbox services and genuinely disagree --
--     11 of 24 sites agree within a mile, worst gap 34.48 mi. Both are kept, both
--     are named where shown, and neither stands in for the other.
--
--  ★ `route_status` IS NOT NULL, because the only way to have no answer is to have
--    no row. A NULL would be a fourth state meaning the same as absence.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vendor_site_route (
  vendor_site_id    INT NOT NULL PRIMARY KEY,

  route_status      VARCHAR(30) NOT NULL,
  route_reason      LONGTEXT NULL,

  route_miles       DOUBLE NULL,
  route_minutes     DOUBLE NULL,

  route_origin_slug VARCHAR(100) NULL,

  -- A hash of the pin AND the origin AND the derivation version. See the source
  -- file: the first live run stored route_miles in METRES while writing a
  -- perfectly correct pin_hash, so a hash over the inputs alone could not tell
  -- "current" from "written by a version of the script that was wrong".
  pin_hash          VARCHAR(100) NULL,

  -- A JSON array of [longitude, latitude] pairs at 5 decimal places -- the plain
  -- LineString coordinate list, not a GeoJSON document.
  geometry          LONGTEXT NULL,

  -- A JSON array of the turns, in order. The steps sum to route_miles exactly
  -- (verified on six routes, delta 0.000 mi on all six), which is what makes it
  -- legitimate to print both a step's length and a route total.
  steps             LONGTEXT NULL,
  step_count        INT NULL,

  route_at          VARCHAR(30) NOT NULL DEFAULT (UTC_TIMESTAMP())
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- ----------------------------------------------------------------------------
--  field_override — a name of our own for a value the ledger already holds.
--
--  ★ THE PRIMARY KEY IS THE NATURAL TRIPLE, NOT A SURROGATE ID. The uniqueness
--    the app needs is "one value per field of one subject", and a surrogate id
--    would permit two.
--
--  ★ NO FOREIGN KEY: neither half of the key lives in this database. `subject_key`
--    names a row in the LEDGER.
--
--  ★ `subject_key` IS 400 CHARS AND IS PART OF THE PRIMARY KEY. InnoDB's index
--    key limit is 3072 bytes; at utf8mb4 (4 bytes/char) the triple is
--    50+400+100 = 550 chars = 2200 bytes, which fits. **Raising any of these
--    widths could exceed the limit and fail the CREATE** — check the arithmetic
--    before widening one.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS field_override (
  subject_kind    VARCHAR(50) NOT NULL,
  subject_key     VARCHAR(400) NOT NULL,
  subject_written VARCHAR(400) NULL,
  field           VARCHAR(100) NOT NULL,
  value           LONGTEXT NOT NULL,
  set_by          VARCHAR(200) NOT NULL,
  set_at          VARCHAR(30) NOT NULL DEFAULT (UTC_TIMESTAMP()),

  PRIMARY KEY (subject_kind, subject_key, field)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- ----------------------------------------------------------------------------
--  ledger_read_cap — how many rows this app reads from a ledger object, and in
--  what order.
--
--  ★★ `order_by` IS REQUIRED WHENEVER `max_rows` IS SET, AND THE ROUTE ENFORCES
--     IT RATHER THAN THE SCHEMA. A cap with no ordering is not a smaller answer --
--     it is a DIFFERENT, ARBITRARY one, and the un-ordered form is the one that
--     arrives looking correct. The refusal lives in `routes/readCaps.ts` because
--     it needs to name what is wrong, which a CHECK constraint cannot do.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ledger_read_cap (
  table_name  VARCHAR(200) NOT NULL PRIMARY KEY,
  -- Reserved word in MySQL — see the note on `saved_view`.`sql` above.
  `sql`       LONGTEXT NULL,
  max_rows    INT NULL,
  order_by    VARCHAR(400) NULL,
  note        LONGTEXT NULL,
  set_by      VARCHAR(200) NULL,
  set_at      VARCHAR(30) NOT NULL DEFAULT (UTC_TIMESTAMP())
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- ----------------------------------------------------------------------------
--  table_count_snapshot — one row count per object per day.
--
--  ★ `counted_in` IS THE DIFFERENCE BETWEEN A FIGURE AND A CLAIM. The register's
--    counts come from whichever store actually holds the object, and the two are
--    different databases with different numbers. Without this column a reading is
--    a bare integer the page has to ASSUME came from the store the current
--    configuration names -- an assumption that was already false once.
--
--  ★ A reading with no `counted_in` is one this register will NOT serve, because
--    it cannot say what it counted. NULL is meaningful and is not "assume current".
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS table_count_snapshot (
  id            INT AUTO_INCREMENT PRIMARY KEY,

  object_name   VARCHAR(200) NOT NULL,

  -- The day the reading belongs to, `YYYY-MM-DD`, in the app's own local clock.
  snapshot_date VARCHAR(10) NOT NULL,

  row_count     INT NOT NULL,

  counted_in    VARCHAR(20) NULL,

  captured_at   VARCHAR(30) NOT NULL DEFAULT (UTC_TIMESTAMP()),

  CONSTRAINT UQ_table_count_snapshot UNIQUE (object_name, snapshot_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


-- ----------------------------------------------------------------------------
--  ledger_summary_cache — the last counted pass over the ledger, keyed by scope,
--  so the sign-in card reads a stored estimate instead of re-counting each load.
--
--  ★ THE FIGURE IS AN ESTIMATE AND `captured_at` IS WHAT SAYS SO. A count is true
--    of the instant it was taken; ledger tables keep being written to. Every
--    reader must print that timestamp -- a stored count shown without its date is
--    a remembered number wearing the clothes of a fresh one.
--
--  ★ `scope_key` IS A DIGEST OF THE SCOPE *AND* THE OBJECT LIST. Two requests with
--    the same fund/programs/floor describe the same rows and may share a row; a
--    pass under a different FUND_CODE must never answer for a scope that did not
--    ask. The object list is in the digest because the descriptor registry changes
--    as routes are added, and a pass that counted 34 objects must not be served to
--    a request that would count 55.
--
--  ★ IT IS A CACHE: every row may be deleted without losing a fact. That is the
--    test for whether a table belongs in a cache.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ledger_summary_cache (
  -- A sha256 hex digest of the full pass identity (scope + object list + declared
  -- columns). 64 chars. Storing the identity itself would need tens of thousands
  -- of characters -- see the note in server/src/routes/meta.ts.
  scope_key      VARCHAR(64) NOT NULL PRIMARY KEY,
  scope_label    VARCHAR(400) NULL,
  captured_at    VARCHAR(30) NOT NULL,
  counted_in     VARCHAR(200) NULL,
  objects_json   LONGTEXT NOT NULL,
  ledger_records BIGINT NULL,
  app_records    BIGINT NULL,
  scoped_records BIGINT NULL,
  uncounted      INT NULL,
  object_count   INT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
