/**
 * Load the app-owned tables into SQL Server, from the verified backup.
 *
 * ★ WHY IT READS `data/backup/*.json` RATHER THAN THE LIVE REMOTE.
 *   The backup is already verified against the source (see its `_manifest.json`),
 *   so this works offline, cannot be affected by the remote changing mid-copy,
 *   and is idempotent against a fixed snapshot. It also means the backup is
 *   EXERCISED as the migration's input rather than sitting untested until
 *   somebody needs it in an emergency.
 *
 * ★★ EVERY BCP TYPE HERE IS BACKED BY A MEASUREMENT, NOT BY THE COLUMN'S NAME.
 *   The ledger copy failed four times on type mismatches -- BigInt vs Int, a
 *   string where a number was expected, a fractional value in an INT column --
 *   and each was found by re-running a long copy. This script's types come from
 *   `tmp-backup-types.mjs`, which read every value in every backup file and
 *   reported the observed JS type, the null count and the numeric range.
 *
 *   What that measurement found, and what it rules out:
 *     - NO column exceeds 32-bit range, so `Int` is correct everywhere and
 *       `BigInt` would be a claim about a scale this data does not have.
 *     - NO column mixes types, so SQLite's loose typing produced no surprises.
 *     - The FRACTIONAL columns (`route_miles`, `latitude`, `drive_minutes`, ...)
 *       are genuinely fractional and are `Float`, matching the DDL.
 *
 * ★ THE DDL IS APPLIED FIRST, because the tables do not exist yet. It comes from
 *   `data/sql/sqlserver/01-app.sql`, which is the T-SQL translation of the SQLite
 *   source -- and the applier splits on `GO` because that is a batch separator the
 *   driver does not understand.
 *
 * ★ IDENTITY COLUMNS ARE COPIED WITH THEIR VALUES, WHICH NEEDS `SET IDENTITY_INSERT`.
 *   The backup holds explicit ids (`saved_view.id = 8`, `project.id` up to 1527)
 *   and `saved_view_run.view_id` references `saved_view.id`. Letting the identity
 *   column assign new values would break that reference silently -- the rows would
 *   all be present and the foreign key would point at nothing.
 *
 * Usage:  npx tsx scripts/copy-app-to-sqlserver.ts [--only TABLE]
 */
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

const env = {};
for (const line of readFileSync(path.join(REPO, '.env'), 'utf8').split('\n')) {
  const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}

const OUT = path.join(REPO, 'copy-app.out.txt');
writeFileSync(OUT, '');
const say = (s) => {
  console.log(s);
  appendFileSync(OUT, s + '\n');
};

const onlyIdx = process.argv.indexOf('--only');
const ONLY = onlyIdx >= 0 ? process.argv[onlyIdx + 1] : null;

const BACKUP_DIR = path.join(REPO, 'data', 'backup');
const DDL_FILE = path.join(REPO, 'data', 'sql', 'sqlserver', '01-app.sql');

const mssql = (await import('mssql')).default;
const pool = await mssql.connect({
  server: env.AZURE_SQL_SERVER,
  database: env.AZURE_SQL_DATABASE,
  user: env.AZURE_SQL_USER,
  password: env.AZURE_SQL_PASSWORD,
  options: { encrypt: true, trustServerCertificate: false, connectTimeout: 60_000, requestTimeout: 300_000 },
});

// ---------------------------------------------------------------------------
// 1. Apply the DDL
// ---------------------------------------------------------------------------
say('=== 1. APPLY THE DDL ===');
const ddl = readFileSync(DDL_FILE, 'utf8');

// ★★ THE APP TABLES ARE DROPPED FIRST, AND THAT IS NOT CARELESSNESS.
//
//   `01-app.sql` guards every table with `IF OBJECT_ID(...) IS NULL`, which is
//   right for a migration and WRONG for a re-run after the DDL was edited: an
//   existing table is left alone and keeps its old shape. That is exactly what
//   happened here -- `mapbox_id` was widened from NVARCHAR(200) to 600, the DDL
//   was re-applied, and the bulk load still failed with a truncation error
//   because the table on the server was still 200 wide.
//
//   ★ THE FAILURE WAS SILENT, WHICH IS THE POINT. The DDL step reported "21 of 21
//     batches applied" and created nothing. A guard that reports success while
//     doing nothing is worse than no guard.
//
//   ★ THE TABLES ARE EMPTY OR ABOUT TO BE REPLACED. This script's whole job is to
//     load them from the backup, and it DELETEs each table's rows before loading.
//     Dropping first means the schema is always the DDL's current shape, and the
//     script stays idempotent -- re-running after a DDL edit does what a reader
//     expects.
//
//   ★ CHILD TABLES BEFORE PARENTS, because `saved_view_run` and
//     `saved_view_subscription` reference `saved_view`. SQL Server refuses to drop
//     a referenced table.
const DROP_ORDER = [
  'saved_view_run',
  'saved_view_subscription',
  'saved_view',
  'vendor_site_route',
  'vendor_site_geo',
  'user_pin',
  'field_override',
  'table_count_snapshot',
  'project',
  'app_user',
  'organization',
  'geo_origin',
  'ledger_read_cap',
];

for (const t of DROP_ORDER) {
  await pool.request().query(`IF OBJECT_ID('dbo.${t}', 'U') IS NOT NULL DROP TABLE dbo.${t}`);
}
say(`   dropped ${DROP_ORDER.length} table(s) so the DDL can recreate them`);

// ★ `GO` IS A BATCH SEPARATOR THE DRIVER DOES NOT UNDERSTAND. It is an SSMS/sqlcmd
//   directive, not T-SQL, so sending it to the server is a syntax error. Splitting
//   on it and running each batch separately is the standard workaround -- and it
//   is REQUIRED here because `CREATE INDEX` cannot share a batch with the
//   `IF OBJECT_ID` guard that precedes it in some forms.
const batches = ddl
  .split(/^\s*GO\s*$/im)
  .map((b) => b.trim())
  .filter((b) => b.length > 0 && !/^--/.test(b.replace(/^\s*--.*$/gm, '').trim()));

let applied = 0;
for (const batch of batches) {
  try {
    await pool.request().batch(batch);
    applied++;
  } catch (e) {
    say(`   ★ BATCH FAILED: ${e.message.split('\n')[0]}`);
    say(`      ${batch.split('\n').find((l) => l.trim() && !l.trim().startsWith('--'))?.slice(0, 100) ?? ''}`);
  }
}
say(`   ${applied} of ${batches.length} batch(es) applied`);

// ---------------------------------------------------------------------------
// 2. Load each table from its backup file
// ---------------------------------------------------------------------------
const manifest = JSON.parse(readFileSync(path.join(BACKUP_DIR, '_manifest.json'), 'utf8'));

/**
 * The BCP type for each column, per table.
 *
 * ★ MEASURED, NOT INFERRED. Every entry below was chosen from the observed type
 *   and range in `tmp-backup-types.mjs`, and the comments say which measurement
 *   drove it. A type inferred from a column's NAME is what produced four failed
 *   runs on the ledger copy.
 *
 * ★ `NVarChar(MAX)` FOR THE JSON AND GEOMETRY COLUMNS. `steps` reaches 14,317
 *   characters and `geometry` 2,126 -- both past NVARCHAR(4000)'s limit, so a
 *   fixed width would truncate them silently.
 */
const TYPES = {
  vendor_site_route: {
    vendor_site_id: mssql.Int, // range 7650..1467938, inside 32-bit
    route_status: mssql.NVarChar(30), // maxlen 2
    route_reason: mssql.NVarChar(mssql.MAX),
    route_miles: mssql.Float, // ★ fractional: 0.73..2875.27
    route_minutes: mssql.Float, // ★ fractional: 3.3..2664.9
    route_origin_slug: mssql.NVarChar(100), // maxlen 7
    pin_hash: mssql.NVarChar(100), // maxlen 64
    geometry: mssql.NVarChar(mssql.MAX), // maxlen 2126
    steps: mssql.NVarChar(mssql.MAX), // maxlen 14317
    step_count: mssql.Int, // range 4..69
    route_at: mssql.NVarChar(30), // maxlen 19
  },
  vendor_site_geo: {
    vendor_site_id: mssql.Int,
    latitude: mssql.Float, // ★ fractional
    longitude: mssql.Float, // ★ fractional
    geocode_status: mssql.NVarChar(30),
    geocode_reason: mssql.NVarChar(mssql.MAX),
    match_confidence: mssql.NVarChar(20),
    accuracy: mssql.NVarChar(30),
    feature_type: mssql.NVarChar(50),
    mapbox_id: mssql.NVarChar(600), // maxlen 503
    query_address: mssql.NVarChar(mssql.MAX),
    address_hash: mssql.NVarChar(100),
    permanent: mssql.Bit, // range 0..1
    geocoded_at: mssql.NVarChar(30),
    drive_miles: mssql.Float, // ★ fractional
    drive_minutes: mssql.Float, // ★ fractional
    drive_status: mssql.NVarChar(30),
    drive_origin_slug: mssql.NVarChar(100),
    drive_at: mssql.NVarChar(30),
  },
  saved_view_subscription: {
    id: mssql.Int,
    view_id: mssql.Int,
    subscriber: mssql.NVarChar(320),
    channel: mssql.NVarChar(20),
    target: mssql.NVarChar(mssql.MAX),
    created_at: mssql.NVarChar(30),
  },
  field_override: {
    subject_kind: mssql.NVarChar(50),
    subject_key: mssql.NVarChar(400),
    subject_written: mssql.NVarChar(400),
    field: mssql.NVarChar(100),
    value: mssql.NVarChar(mssql.MAX),
    set_by: mssql.NVarChar(200),
    set_at: mssql.NVarChar(30),
  },
  user_pin: {
    id: mssql.Int,
    owner_email: mssql.NVarChar(320),
    category: mssql.NVarChar(20),
    entity_key: mssql.NVarChar(400),
    title: mssql.NVarChar(400),
    subtitle: mssql.NVarChar(400),
    href: mssql.NVarChar(1000),
    created_at: mssql.NVarChar(30),
  },
  project: {
    id: mssql.Int,
    slug: mssql.NVarChar(200),
    name: mssql.NVarChar(400),
    description: mssql.NVarChar(mssql.MAX),
    level_code: mssql.NVarChar(20),
    code: mssql.NVarChar(50),
    site: mssql.NVarChar(200),
    owner: mssql.NVarChar(200),
    created_at: mssql.NVarChar(30),
    updated_at: mssql.NVarChar(30),
  },
  saved_view: {
    id: mssql.Int,
    slug: mssql.NVarChar(200),
    title: mssql.NVarChar(400),
    description: mssql.NVarChar(mssql.MAX),
    sql: mssql.NVarChar(mssql.MAX),
    params_json: mssql.NVarChar(mssql.MAX),
    display_json: mssql.NVarChar(mssql.MAX),
    created_by: mssql.NVarChar(200),
    status: mssql.NVarChar(20),
    created_at: mssql.NVarChar(30),
    updated_at: mssql.NVarChar(30),
  },
  saved_view_run: {
    id: mssql.Int,
    view_id: mssql.Int,
    ran_at: mssql.NVarChar(30),
    duration_ms: mssql.Int,
    row_count: mssql.Int,
    truncated: mssql.Bit,
    fingerprint: mssql.NVarChar(200),
    error: mssql.NVarChar(mssql.MAX),
  },
  organization: {
    id: mssql.Int,
    slug: mssql.NVarChar(200),
    name: mssql.NVarChar(400),
    fund: mssql.NVarChar(10),
    programs_json: mssql.NVarChar(mssql.MAX),
    start_fy: mssql.Int,
    is_default: mssql.Bit,
    created_at: mssql.NVarChar(30),
    updated_at: mssql.NVarChar(30),
  },
  geo_origin: {
    slug: mssql.NVarChar(100),
    name: mssql.NVarChar(400),
    latitude: mssql.Float, // ★ fractional
    longitude: mssql.Float, // ★ fractional
    is_default: mssql.Bit,
    created_at: mssql.NVarChar(30),
  },
  table_count_snapshot: {
    id: mssql.Int,
    object_name: mssql.NVarChar(200),
    snapshot_date: mssql.NVarChar(10),
    row_count: mssql.Int, // range 0..6928672, inside 32-bit
    counted_in: mssql.NVarChar(20),
    captured_at: mssql.NVarChar(30),
  },
};

/** Tables whose id column is IDENTITY and must be copied with explicit values. */
const IDENTITY_TABLES = new Set([
  'saved_view',
  'saved_view_run',
  'saved_view_subscription',
  'project',
  'organization',
  'user_pin',
  'table_count_snapshot',
]);

/**
 * ★★ NULLABILITY MUST MATCH THE DDL, AND GETTING IT WRONG IS THIS ERROR.
 *
 *   "Invalid column type from bcp client for colid 1" is what BCP reports when the
 *   bulk column definition disagrees with the EXISTING table -- and the commonest
 *   disagreement is nullability, not type. It names the column INDEX rather than
 *   the mismatch, so it reads as a type fault.
 *
 *   ★ colid 1 IS ALWAYS THE PRIMARY KEY, which is why this error always names
 *     column 1 and never anything else: the first NOT NULL column in every table
 *     is the first column in every table.
 *
 *   ★ THIS SCRIPT HIT IT ON THE LEDGER COPY AND AGAIN HERE, because the first
 *     version declared every column `{ nullable: true }` while the DDL declares
 *     the primary keys `NOT NULL`. The fix is not another hand-written list -- it
 *     is to READ THE DDL, so the two cannot drift.
 *
 * ★ SO NOT-NULL AND PRIMARY-KEY ARE PARSED SEPARATELY, because they are different
 *   facts and conflating them is a real bug: `permanent BIT NOT NULL DEFAULT 0`
 *   and `geocoded_at NVARCHAR(30) NOT NULL DEFAULT ...` are NOT NULL but are not
 *   keys. Marking a non-key column `primary: true` tells BCP the column is part
 *   of the key, which it is not.
 *
 *   `primary: true` is set only where the DDL says `PRIMARY KEY`; `nullable:
 *   false` is set wherever it says `NOT NULL`.
 */
function parseColumnConstraints(ddlText) {
  const notNull = new Map(); // table -> Set(column)
  const primary = new Map(); // table -> Set(column)
  let current = null;

  for (const raw of ddlText.split('\n')) {
    const line = raw.trim();
    const create = /^CREATE TABLE dbo\.(\w+)\s*\(/i.exec(line);
    if (create) {
      current = create[1];
      notNull.set(current, new Set());
      primary.set(current, new Set());
      continue;
    }
    if (current === null) continue;
    if (line.startsWith(');') || line === ')') {
      current = null;
      continue;
    }
    // A column line: NAME TYPE ... [NOT NULL] [PRIMARY KEY] ...
    const col = /^(\w+)\s+[A-Za-z]/.exec(line);
    if (!col) continue;
    if (/\bNOT NULL\b/i.test(line)) notNull.get(current).add(col[1]);
    if (/\bPRIMARY KEY\b/i.test(line)) primary.get(current).add(col[1]);
  }
  return { notNull, primary };
}

const CONSTRAINTS = parseColumnConstraints(ddl);

/** The bulk column options for one column of one table, read from the DDL. */
const colOptions = (table, column) => {
  const isPrimary = CONSTRAINTS.primary.get(table)?.has(column) ?? false;
  const isNotNull = CONSTRAINTS.notNull.get(table)?.has(column) ?? false;
  return isPrimary ? { nullable: false, primary: true } : { nullable: !isNotNull };
};

/**
 * Coerce a value to match its declared BCP type.
 *
 * ★ SQLITE IS LOOSELY TYPED, so a value's runtime type is not guaranteed by the
 *   column's declaration. The measurement found no mixed types in this data, but
 *   the coercion stays because the failure mode is a bulk-load error naming a
 *   column index rather than the mismatch.
 */
const coerce = (v, type) => {
  if (v === null || v === undefined) return null;
  switch (type) {
    case mssql.Int:
      return typeof v === 'number' ? Math.trunc(v) : Number.parseInt(String(v), 10);
    case mssql.Float:
      return typeof v === 'number' ? v : Number.parseFloat(String(v));
    case mssql.Bit:
      // SQLite stores 0/1; the driver's Bit column wants a boolean.
      return Boolean(typeof v === 'number' ? v : Number(v));
    default:
      return typeof v === 'string' ? v : String(v);
  }
};

say('\n=== 2. LOAD THE APP TABLES ===');
const results = [];

for (const entry of manifest.tables) {
  const { table, rows: sourceCount, file } = entry;
  if (!file || sourceCount === 0) {
    say(`\n=== ${table} ===\n   0 rows in the backup — nothing to load`);
    results.push({ table, status: 'empty', source: 0, dest: 0, ok: true });
    continue;
  }
  if (ONLY && ONLY !== table) continue;

  say(`\n=== ${table} ===`);
  const rows = JSON.parse(readFileSync(path.join(BACKUP_DIR, file), 'utf8'));
  const cols = Object.keys(rows[0]);
  const types = TYPES[table];

  if (!types) {
    say(`   ★ NO TYPE MAP FOR ${table} — refusing to guess`);
    results.push({ table, status: 'failed', source: rows.length, dest: -1, ok: false });
    continue;
  }
  const missing = cols.filter((c) => !types[c]);
  if (missing.length) {
    say(`   ★ NO TYPE DECLARED FOR: ${missing.join(', ')} — refusing to guess`);
    results.push({ table, status: 'failed', source: rows.length, dest: -1, ok: false });
    continue;
  }

  // ★ DELETE, NOT TRUNCATE. `TRUNCATE` is refused on a table referenced by a
  //   foreign key, and `saved_view_run.view_id` references `saved_view.id`. A
  //   DELETE works and keeps the script re-runnable.
  await pool.request().query(`DELETE FROM dbo.${table}`);
  say(`   cleared dbo.${table}`);

  const identity = IDENTITY_TABLES.has(table) && cols.includes('id');
  if (identity) {
    // ★ WITHOUT THIS THE IDS ARE REASSIGNED AND THE FOREIGN KEYS POINT AT NOTHING.
    //   The rows would all be present and `saved_view_run.view_id = 8` would
    //   reference a `saved_view` row that is no longer id 8.
    await pool.request().query(`SET IDENTITY_INSERT dbo.${table} ON`);
  }

  const tCopy = Date.now();
  let inserted = 0;
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const t = new mssql.Table(`dbo.${table}`);
    t.create = false;
    for (const c of cols) t.columns.add(c, types[c], colOptions(table, c));
    for (const r of slice) t.rows.add(...cols.map((c) => coerce(r[c], types[c])));
    const res = await pool.request().bulk(t);
    inserted += res.rowsAffected;
  }
  const copyMs = Date.now() - tCopy;

  if (identity) await pool.request().query(`SET IDENTITY_INSERT dbo.${table} OFF`);

  const back = Number((await pool.request().query(`SELECT COUNT(*) AS n FROM dbo.${table}`)).recordset[0].n);
  const ok = back === sourceCount;
  say(
    `   copied: ${inserted}  read back: ${back}  backup: ${sourceCount}  ` +
      `${ok ? 'MATCH' : '★ MISMATCH'}  (${copyMs} ms)`,
  );
  results.push({ table, status: 'copied', source: sourceCount, dest: back, ok });
}

// ---------------------------------------------------------------------------
// 3. Summary
// ---------------------------------------------------------------------------
say('\n=== SUMMARY ===');
for (const r of results) {
  const mark =
    r.status === 'copied' ? (r.ok ? 'MATCH' : '★ MISMATCH')
    : r.status === 'empty' ? 'empty (nothing to load)'
    : '★ FAILED';
  const s = r.status === 'copied' ? String(r.source).padStart(7) : '      -';
  const d = r.status === 'copied' ? String(r.dest).padStart(7) : '      -';
  say(`   ${r.table.padEnd(26)} backup ${s}  dest ${d}  ${mark}`);
}

const mismatched = results.filter((r) => r.status === 'copied' && !r.ok);
const failed = results.filter((r) => r.status === 'failed');
const loaded = results.filter((r) => r.status === 'copied');
const total = loaded.reduce((s, r) => s + r.dest, 0);

const verdict =
  mismatched.length > 0
    ? `★ ${mismatched.length} TABLE(S) DID NOT MATCH: ${mismatched.map((r) => r.table).join(', ')}`
    : failed.length > 0
      ? `★ ${failed.length} TABLE(S) FAILED: ${failed.map((r) => r.table).join(', ')}`
      : `${loaded.length} TABLE(S) LOADED AND VERIFIED (${total} rows)`;
say(`\n   ${verdict}`);

await pool.close();
process.exit(mismatched.length === 0 && failed.length === 0 ? 0 : 1);
