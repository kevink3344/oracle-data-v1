/**
 * Move the app store's rows from one libSQL database to another.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT `build-turso-sample.mjs`
 *   `build-turso-sample.mjs --remote` DROPS every table and view in the database
 *   `TURSO_DATABASE` names before it writes a thing. That is right for a sample
 *   rebuild and catastrophic for this job: the app store holds rows no build can
 *   recreate — the geocoded `vendor_site_geo` / `vendor_site_route` geometry, the
 *   `saved_view_subscription` rows, the run history. So the boundary is stated
 *   once, here: this script only ever *reads* the source and *inserts* into the
 *   target, and it never drops the target database.
 *
 * WHAT IT DOES, IN ORDER
 *   1. Reads the source and target from `--from` / `--to`, else the process
 *      environment, else `.env` — in that order. Once the app store is
 *      consolidated there is no `APP_DB_URL` to default to, so a move names its
 *      source explicitly; the message printed when it cannot is written for that.
 *   2. Refuses if both resolve to the same host — "copy onto itself" is always a
 *      mistake and the only way it can look successful is by doing nothing twice.
 *   3. Applies `data/sql/turso/01-app.sql` to the target. The DDL is
 *      `CREATE TABLE IF NOT EXISTS` throughout, so this is safe to re-run, and it
 *      is the same file `ensureAppSchema()` applies — so the target ends up with
 *      the schema the server expects rather than a copy of it.
 *   4. For each app table, in the DDL's own order: clears the target table, then
 *      inserts the source's rows.
 *      ★ THE INSERT ORDER IS THE DDL'S ORDER AND THAT IS LOAD-BEARING. The file
 *        declares parents before children (`saved_view` before `saved_view_run`),
 *        so inserting in file order satisfies every foreign key without turning
 *        them off. Clearing runs in reverse.
 *   5. Re-reads every table on both sides and reports the counts side by side.
 *      A copy that is not verified is a copy you are guessing about.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *   It does not touch `X_REPORT_PROJECT_FACTS`, `X_REPORT_FUNDING_LINES` or
 *   `SAMPLE_DATA_PROVENANCE`. Those are app-authored by classification but they
 *   are defined by `00-schema.sql` and exist in both databases with identical
 *   rows — they are part of the ledger build, and copying them here would give
 *   two scripts an opinion about the same table.
 *
 * USAGE
 *   node scripts/move-app-store.mjs                       # dry run: report only
 *   node scripts/move-app-store.mjs --apply               # do it
 *   node scripts/move-app-store.mjs --apply --to <url> --to-token <token>
 */

import { createClient } from '@libsql/client';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const APP_DDL = path.join(ROOT, 'data', 'sql', 'turso', '01-app.sql');
/** The ledger's own schema, used to tell an unclassified table from a ledger table. */
const LEDGER_DDL = path.join(ROOT, 'data', 'sql', 'turso', '00-schema.sql');

/**
 * The app-owned tables, in dependency order.
 *
 * ★ THIS IS A FOURTH COPY OF THESE NAMES and it is a deliberate one, kept honest
 *   by the same assertion every other copy is: step 5 below fails loudly if the
 *   source and target disagree, so a name added to `db/app-schema.ts` and not to
 *   this list shows up as a table present on the source and absent here — visible
 *   in the report rather than silently uncopied. The other three copies are
 *   `db/app-schema.ts` (APP_TABLES), `data/sql/turso/01-app.sql` (the DDL) and
 *   `db/store.ts` (APP_TABLES, for routing).
 */
const APP_TABLES = [
  'saved_view',
  'saved_view_run',
  'saved_view_subscription',
  'project',
  'table_count_snapshot',
  'organization',
  'app_user',
  'user_pin',
  'geo_origin',
  'vendor_site_geo',
  'vendor_site_route',
  'field_override',
];

/** How many INSERT statements to send in one batch. The driver has a limit; this is well under it. */
const BATCH = 100;

// ─── arguments ────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const flag = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

// ─── .env ─────────────────────────────────────────────────────────────────────

function readEnv() {
  const out = {};
  try {
    for (const line of readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*([^\r\n]*)/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  } catch {
    // A missing .env is only fatal if the overrides are missing too, which is
    // checked below with a message that names both places this looked.
  }
  return out;
}

const file = readEnv();

/**
 * Resolve one setting: flag, then process environment, then `.env`.
 *
 * ★ THE MIDDLE STEP WAS MISSING AND THE MESSAGE BELOW CLAIMED IT ANYWAY. The
 *   code read `.env` directly, so `APP_DB_URL=... node scripts/move-app-store.mjs`
 *   silently ignored the prefix and used the file — which only shows up when the
 *   two disagree, i.e. exactly when someone is overriding something in a hurry.
 *   The flag still wins, so every documented invocation behaves as before.
 */
const pick = (flagName, name) =>
  flag(flagName) ?? (process.env[name] || undefined) ?? file[name];

const fromUrl = pick('--from', 'APP_DB_URL');
const fromToken = pick('--from-token', 'APP_DB_AUTH_TOKEN');
const toUrl = pick('--to', 'TURSO_DATABASE');
const toToken = pick('--to-token', 'TURSO_API_KEY');

const missing = [
  !fromUrl && 'source APP_DB_URL (or --from)',
  !toUrl && 'target TURSO_DATABASE (or --to)',
].filter(Boolean);

if (missing.length) {
  console.error(`\nmissing: ${missing.join(', ')}`);
  console.error('  Checked --from/--to on the command line, then the environment, then .env.');
  if (!fromUrl && !flag('--from')) {
    // ★ REACHED BY DESIGN ON A CONSOLIDATED CHECKOUT, WHICH IS THE NORMAL STATE NOW.
    //   `APP_DB_URL` is commented out once the two stores are one, so the documented
    //   default source is gone — and that is the script working, not failing. It is
    //   spelled out because the alternative is a reader concluding the script broke.
    console.error(
      '\n  ★ THIS IS EXPECTED ONCE THE APP STORE IS CONSOLIDATED. `APP_DB_URL` is\n' +
        '    commented out in .env because the app store and the ledger are the same\n' +
        '    database, so there is no longer a default source to read from. Name one:\n' +
        '\n' +
        '      node scripts/move-app-store.mjs --from <url> --from-token <token>\n' +
        '\n' +
        '    The target still defaults to TURSO_DATABASE / TURSO_API_KEY, so a move\n' +
        '    onto the live database needs only the two --from flags.',
    );
    console.error(
      '\n  ★ CHECK THE DIRECTION FIRST. Unset APP_DB_URL means both sides default to the\n' +
        '    SAME database, and a copy onto itself is the one failure that looks like\n' +
        '    success: it clears and rewrites the same rows and reports a perfect count\n' +
        '    match. The guard below refuses it, but only once both sides resolve.',
    );
  }
  process.exit(1);
}

/**
 * The bare host of a libSQL URL, for the identity check and the report.
 *
 * The screen out of a URL is the same reasoning `hostOf` in `db/env.ts` uses: it
 * is what lets the output name the database that is about to be written without
 * ever printing a token.
 */
function hostOf(url) {
  try {
    const u = new URL(url);
    // ★ `new URL('file:./x.db').host` IS THE EMPTY STRING, AND A BLANK NAME IN A
    //   BANNER ANNOUNCING A DESTRUCTIVE COPY IS WORSE THAN A LONG ONE. A `file:`
    //   target printed as "to:   " with nothing after it. Remote URLs still screen
    //   to their host, which is what keeps a token out of the output; this only
    //   changes what is shown when there is no host to show.
    return u.host || u.pathname || url;
  } catch {
    // `|| url`, not `?? url`: `split('/')[0]` yields the empty string, which `??`
    // passes straight through.
    return url.replace(/^\w+:\/\//, '').split('/')[0] || url;
  }
}

const fromHost = hostOf(fromUrl);
const toHost = hostOf(toUrl);

if (fromHost === toHost) {
  console.error(`\nrefusing: source and target are the same database (${fromHost}).`);
  console.error('  This is the one failure that would look like success — it would clear and');
  console.error('  rewrite the same rows and report a perfect count match.');
  process.exit(1);
}

console.log(APPLY ? '\nMOVE APP STORE (writing)' : '\nMOVE APP STORE (dry run — pass --apply to write)');
console.log(`  from: ${fromHost}`);
console.log(`  to:   ${toHost}\n`);

// ─── SQL splitting, the same rules build-turso-sample.mjs uses ───────────────

/**
 * Split a file of statements on `;`, ignoring semicolons inside string literals
 * and inside `--` line comments.
 *
 * Copied rather than shared because `build-turso-sample.mjs` is a script that
 * runs its build on import, so it cannot be imported for one function. If a
 * third caller ever needs this, that is the moment to extract it.
 */
function splitSql(src) {
  const out = [];
  let buf = '';
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      buf += c;
      if (c === "'") {
        if (src[i + 1] === "'") buf += src[++i];
        else inStr = false;
      }
      continue;
    }
    if (c === "'") {
      inStr = true;
      buf += c;
      continue;
    }
    if (c === '-' && src[i + 1] === '-') {
      while (i < src.length && src[i] !== '\n') i++;
      buf += '\n';
      continue;
    }
    if (c === ';') {
      const s = buf.trim();
      if (s) out.push(s);
      buf = '';
      continue;
    }
    buf += c;
  }
  const s = buf.trim();
  if (s) out.push(s);
  return out;
}

// ─── connection ───────────────────────────────────────────────────────────────

const source = createClient({ url: fromUrl, authToken: fromToken || undefined });
const target = createClient(toUrl ? { url: toUrl, authToken: toToken || undefined } : { url: toUrl });

/** Every table and view the database holds, uppercased -> kind. */
async function inventory(db) {
  const r = await db.execute(
    "SELECT type, name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'",
  );
  return new Map(r.rows.map((x) => [String(x.name).toUpperCase(), String(x.type)]));
}

const sourceObjects = await inventory(source);
const targetObjects = await inventory(target);

/**
 * Every `CREATE TABLE` / `CREATE VIEW` name a DDL file declares.
 *
 * ★ THIS IS THE DISCRIMINATOR, NOT "ABSENT FROM THE TARGET". The earlier rule was
 *   "on the source and not on the target", which is silent in the intended case —
 *   two full ledgers, where every ledger table is on both sides — and degenerates
 *   into noise the moment the target is empty: pointed at a fresh database it
 *   listed all 36 ledger tables as possible app tables, which is precisely the
 *   warning-always-fires failure it was written to avoid. The question that
 *   actually matters is "is this name known to anybody?", and `00-schema.sql`
 *   answers it without consulting the target at all. A regex rather than the
 *   `splitSql` above because the DDL is generated and every name is quoted.
 */
function declaredNames(src) {
  const out = new Set();
  const re = /CREATE\s+(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z0-9_]+)["'`]?/gi;
  for (const m of src.matchAll(re)) out.add(m[1].toUpperCase());
  return out;
}

const ledgerNames = declaredNames(readFileSync(LEDGER_DDL, 'utf8'));
const knownNames = new Set([...APP_TABLES.map((t) => t.toUpperCase()), ...ledgerNames]);

async function count(db, table) {
  const r = await db.execute(`SELECT COUNT(*) AS n FROM "${table}"`);
  return Number(r.rows[0].n);
}

/**
 * The target's current count for a table, or null when it does not hold it yet.
 *
 * ★ A DRY RUN HAS TO READ THE TARGET TOO, OR IT ANSWERS THE WRONG QUESTION.
 *   The target column used to print `—` unless `--apply` was passed, which made
 *   the dry run report what the source holds and nothing at all about what the
 *   write would replace. "What am I about to overwrite" is the only reason to
 *   dry-run a destructive copy, so the number is read either way. The existence
 *   check is a separate query rather than a try/catch around `count`, because
 *   swallowing the error would also swallow a connection failure and report it
 *   as "this table is absent".
 */
async function targetCount(table) {
  const r = await target.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND lower(name) = lower(?)",
    [table],
  );
  return r.rows.length ? await count(target, table) : null;
}

/** How many of the app tables the target holds right now. */
async function appTablesOnTarget(db) {
  const now = await inventory(db);
  return APP_TABLES.filter((t) => now.get(t.toUpperCase()) === 'table').length;
}

// ─── 3. the DDL ──────────────────────────────────────────────────────────────

const ddl = splitSql(readFileSync(APP_DDL, 'utf8'));
console.log(`  ddl: ${ddl.length} statement(s) from data/sql/turso/01-app.sql`);
if (APPLY) await target.batch(ddl, 'write');

// ─── 3b. what is on the source that this list does not name ──────────────────

const sourceAppTables = [...sourceObjects.keys()].filter((n) => APP_TABLES.includes(n.toLowerCase()));

/**
 * Objects on the source that no schema this script can read declares — the ones
 * genuinely worth a reader's attention.
 *
 * ★ `WCSEXP_*` IS CARVED OUT BECAUSE IT IS A KNOWN FAMILY WITH A KNOWN STATUS, and
 *   folding it into "unclassified" would be a half-truth. Those views exist on the
 *   databases built before the sample retired them and not on the databases built
 *   after, so whether they appear depends entirely on which two databases you
 *   point this at — they are neither app-owned (so they do not belong in
 *   `APP_TABLES`) nor a sign that somebody forgot something. They are named
 *   separately, with their actual consequence attached: they are why the two
 *   databases report different object counts to the activity register.
 */
// ★ THE FILTER MUST NOT REQUIRE `kind === 'table'`, AND REQUIRING IT MADE THE
//   `retiredViews` NOTE BELOW UNREACHABLE. All eighteen `WCSEXP_*` names are
//   views, so a tables-only filter could never surface them — a branch written to
//   explain a real, measured difference between two databases that could not fire
//   on either. `unclassified` still means tables, because that note is about app
//   tables this list forgot; a stray view is a different claim.
const strays = [...sourceObjects.entries()].filter(([name]) => !knownNames.has(name));
const retiredViews = strays.filter(([n]) => n.startsWith('WCSEXP_')).map(([n]) => n);
const unclassified = strays
  .filter(([n, kind]) => kind === 'table' && !n.startsWith('WCSEXP_'))
  .map(([n]) => n);

/** Ledger objects the ledger's own schema declares that the target does not hold. */
const missingOnTarget = [...ledgerNames].filter((n) => targetObjects.get(n) === undefined);

// ─── 4 + 5. copy and verify ──────────────────────────────────────────────────

console.log('');
const rows = [];
/** Dry run only: tables that already hold rows on the target, and how they compare. */
const replaced = [];
let failures = 0;

for (const table of APP_TABLES) {
  if (sourceObjects.get(table.toUpperCase()) !== 'table') {
    rows.push([table, 'absent on source', '', '', 'SKIP']);
    continue;
  }

  const before = await count(source, table);
  const existing = await targetCount(table);
  let moved = 0;

  if (APPLY && before > 0) {
    const all = await source.execute(`SELECT * FROM "${table}"`);
    const cols = all.columns;
    const colList = cols.map((c) => `"${c}"`).join(', ');
    const placeholders = cols.map(() => '?').join(', ');

    // Children first on the way out, so a parent is never cleared while a child
    // still points at it. `APP_TABLES` is parent-first, so the reverse is the
    // child-first order.
    await target.execute(`DELETE FROM "${table}"`);

    const statements = all.rows.map((row) => ({
      sql: `INSERT INTO "${table}" (${colList}) VALUES (${placeholders})`,
      args: cols.map((c) => {
        const v = row[c];
        // libSQL hands integers back as numbers and blobs as ArrayBuffer; both are
        // accepted as binds. `undefined` is not, and it means the source row had no
        // such column — a schema mismatch, which should fail rather than be written
        // as NULL.
        if (v === undefined) throw new Error(`${table}.${c} is undefined on the source row`);
        return v;
      }),
    }));

    for (let i = 0; i < statements.length; i += BATCH) {
      await target.batch(statements.slice(i, i + BATCH), 'write');
    }
    moved = statements.length;
  }

  const after = APPLY ? await count(target, table) : existing;
  const ok = APPLY ? after === before : true;
  if (!ok) failures++;
  if (!APPLY && existing !== null && existing !== before) {
    replaced.push([table, existing, before]);
  }
  rows.push([
    table,
    String(before),
    after === null ? 'absent' : String(after),
    String(moved),
    ok ? 'ok' : 'MISMATCH',
  ]);
}

// ─── report ──────────────────────────────────────────────────────────────────

const w = Math.max(...rows.map((r) => r[0].length), 'table'.length);
console.log(`  ${'table'.padEnd(w)}  ${'source'.padStart(8)}  ${'target'.padStart(8)}  ${'moved'.padStart(8)}  result`);
console.log(`  ${'-'.repeat(w)}  ${'-'.repeat(8)}  ${'-'.repeat(8)}  ${'-'.repeat(8)}  ------`);
for (const [table, before, after, moved, result] of rows) {
  console.log(`  ${table.padEnd(w)}  ${before.padStart(8)}  ${after.padStart(8)}  ${moved.padStart(8)}  ${result}`);
}

if (replaced.length) {
  console.log(`\n  ★ ${replaced.length} table(s) would CHANGE COUNT on the target, and the copy REPLACES`);
  console.log('    rather than merges — it clears the target table before inserting into it:');
  for (const [table, onTarget, onSource] of replaced) {
    console.log(`      ${table.padEnd(w)}  target ${String(onTarget).padStart(6)}  ->  source ${String(onSource).padStart(6)}`);
  }
  console.log('    Rows on the target that the source does not have are LOST, and nothing here can');
  console.log('    say which those are.');
}

// ★ THIS NOTE IS THE MEASURABLE SIGNAL, NOT A CLEAN BILL OF HEALTH, AND IT IS NOT
//   SILENT BECAUSE NOTHING DIFFERS. Two tables can hold the same COUNT and
//   completely different rows, and this script cannot see that — it compares
//   counts, which is exactly what the copy is verified with. A note that fired on
//   every run would stop being read, so it is scoped to count differences; the
//   two-column table above is the thing to actually read before passing --apply.

if (unclassified.length) {
  console.log(`\n  ★ ${unclassified.length} table(s) are on the source and declared by NEITHER schema this`);
  console.log('    script reads — not `01-app.sql`, not `00-schema.sql` — so this script does not copy');
  console.log('    them:');
  console.log(`    ${unclassified.join(', ')}`);
  console.log('    That is the shape of an app table added to `db/app-schema.ts` and not to');
  console.log('    APP_TABLES above. Its rows were left behind.');
}

if (retiredViews.length) {
  console.log(`\n  ★ ${retiredViews.length} WCSEXP_* view(s) are on the source and on no schema (informational).`);
  console.log('    These predate the sample retiring that name family, so they are absent from');
  console.log('    databases built since — including this script\'s `--to` target when it is one.');
  console.log('    They are NOT app-owned and do not belong in APP_TABLES. They do inflate the');
  console.log('    activity register\'s object count on the databases that still carry them, so');
  console.log('    two databases of different vintages will not report the same number.');
}

if (missingOnTarget.length) {
  console.log(`\n  ★ the target is missing ${missingOnTarget.length} object(s) that \`00-schema.sql\` declares:`);
  const shown = missingOnTarget.slice(0, 12).join(', ');
  console.log(`    ${shown}${missingOnTarget.length > 12 ? `, ...and ${missingOnTarget.length - 12} more` : ''}`);
  console.log('    Nothing here creates them — `build-turso-sample.mjs` does, from that file.');
  console.log('    A target like this is a different shape from the source, not a copy of it.');
}

console.log(
  `\n  app tables on the source: ${sourceAppTables.length}/${APP_TABLES.length}` +
    // ★ RE-READ, NOT REUSED. `targetObjects` is a snapshot taken before the DDL ran,
    //   so using it here reported "0/12" on a run that had just created and filled
    //   all twelve. A summary line that contradicts the table above it is worse than
    //   no summary line, because it is the one a reader screenshots. It is equally
    //   correct in a dry run, for the opposite reason: nothing was created, so the
    //   count it returns is the count that is genuinely there now.
    `   on the target: ${await appTablesOnTarget(target)}/${APP_TABLES.length}`,
);

source.close();
target.close();

if (failures) {
  console.error(`\n${failures} table(s) did not match. Nothing was rolled back — re-run to try again.`);
  process.exit(1);
}

console.log(APPLY ? '\ndone.' : '\ndry run complete. Nothing was written.');
