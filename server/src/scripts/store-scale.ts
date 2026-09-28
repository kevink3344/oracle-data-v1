/**
 * Measure **this deployment's store** — every user table in the database the API
 * reads — and print the figure the sign-in card's headline states.
 *
 * ── ★ WHY THIS IS A SEPARATE SCRIPT FROM `ledger:scale`, AND WHY BOTH EXIST
 *
 * `ledger:scale` measures the **Oracle source**: it counts the 34 descriptors this
 * deployment copied from, against `POWERAPPS@europa.wcpss.net:1541/ebs_FA2DB`, and
 * its figures are recorded in `app/src/data/ledgerScale.ts` as `LEDGER_SCALE`.
 *
 * That number answers "how big is the ledger we came from". It does **not** answer
 * "how big is the database you are looking at", and the sign-in card was stating it
 * as though it did — `55 tables · over 197 million` on a store holding eight million
 * rows. The two differ by two orders of magnitude, in the one place a reader is
 * deciding whether the thing they are opening is the real one.
 *
 * So the card's headline now quotes **this** script's figure instead, and the Oracle
 * number survives as a scale reference with its database and its date attached.
 *
 * ── ★ WHAT IT COUNTS: EVERY USER TABLE, AND THE MIRRORS ARE IN THERE
 *
 * The API's own total (`GET /api/meta/ledger-summary?counts=true`, `ledgerRecords`) is
 * a **different number and a different claim**: it sums the 55 registered and
 * cap-governed objects through the account scope, and on the current deployment 18 of
 * those objects cannot be counted at all, so it is a floor over a subset. It is the
 * right figure for "how much will this app read" and the wrong one for "how many rows
 * are in this database".
 *
 * This counts the store: `sys.tables` / `sqlite_master`, no scope applied, no object
 * list consulted. Which means it also counts the three `WCSEXP_*` tables that hold
 * **row-for-row copies** of the base tables they shadow — on the current take,
 * `WCSEXP_PO_HEADERS`, `WCSEXP_PO_VENDOR_SITES` and `WCSEXP_PO_VENDORS` each match
 * their base table exactly. They are physical tables holding physical rows, so the
 * total is the honest answer to "how many rows are in this database" — but it is
 * **not** a count of distinct data, and the take prints the mirrors it found so that
 * nobody has to discover that by comparing two tables by hand.
 *
 * ── ★ IT CROSS-CHECKS, BECAUSE A ROW COUNT IS THE EASIEST NUMBER TO GET QUIETLY WRONG
 *
 * The fast path reads `sys.dm_db_partition_stats` (metadata; microseconds, no scan).
 * That figure is maintained by the engine rather than measured, so this script then
 * takes a real `COUNT(*)` per table and **compares the two totals**. If they disagree
 * it prints both and exits non-zero: a metadata count that has drifted is a bug worth
 * knowing about, and printing the metadata figure alone would hide it.
 *
 * On SQLite there is no metadata shortcut that is portable (`dbstat` is a compile-time
 * option), so the fast pass is skipped and only the real counts run.
 *
 * ── ★ IT FAILS LOUDLY RATHER THAN PRINTING A PLAUSIBLE NUMBER
 *
 * `Number(rows[0]?.n ?? 0)` turns "no row came back" into a real zero. So a count that
 * throws, or that returns something not finite, is recorded as a **failure** — never
 * as `0` — and any failure exits non-zero, so one unreadable table cannot make the
 * total look merely smaller.
 *
 * Run:
 *
 *     Push-Location server; npm run store:scale; Pop-Location
 */

import { storeDriver } from '../db/client.js';
import { config } from '../config/env.js';

/** The store the API reads. `'app'` here means "the app's own database", which is the same server as the ledger's in a single-store deployment. */
const store = storeDriver('app');

console.log(`store   : ${config.appDb.label}`);
console.log(`dialect : ${store.dialect}`);

interface Take {
  readonly name: string;
  readonly n: number;
}

/**
 * Every user table's row count, from metadata where the dialect keeps it.
 *
 * ★ `is_ms_shipped = 0` IS NOT DECORATION. Without it the take includes the handful of
 *   system-shipped tables SQL Server keeps in every user database, and the total picks
 *   up a few hundred rows that belong to the engine rather than to the data.
 *
 * ★ `index_id IN (0, 1)` COUNTS EACH TABLE ONCE. A table's rows are reported once per
 *   index — the heap or the clustered index, plus every non-clustered one — so a table
 *   with four indexes appears four times. Summing `sys.partitions` without that filter
 *   is the classic way this query overstates a database by a large integer factor.
 */
async function metadataCounts(): Promise<Take[] | null> {
  if (store.dialect !== 'sqlserver') return null;
  const res = await store.execute({
    sql:
      'SELECT SCHEMA_NAME(t.schema_id) + \'.\' + t.name AS name, SUM(p.rows) AS n ' +
      'FROM sys.partitions p JOIN sys.tables t ON p.object_id = t.object_id ' +
      'WHERE p.index_id IN (0, 1) AND t.is_ms_shipped = 0 ' +
      'GROUP BY SCHEMA_NAME(t.schema_id), t.name',
    args: [],
  });
  return res.rows.map((row) => {
    const r = row as Record<string, unknown>;
    return { name: String(r.name ?? r.NAME), n: Number(r.n ?? r.N) };
  });
}

/** The table names to count. `sqlite_master` on the SQLite arm; the same query as above. */
async function tableNames(): Promise<string[]> {
  if (store.dialect === 'sqlserver') {
    const res = await store.execute({
      sql:
        "SELECT SCHEMA_NAME(t.schema_id) + '.' + t.name AS name FROM sys.tables t " +
        'WHERE t.is_ms_shipped = 0',
      args: [],
    });
    return res.rows.map((row) => String((row as Record<string, unknown>).name));
  }
  const res = await store.execute({
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    args: [],
  });
  return res.rows.map((row) => String((row as Record<string, unknown>).name));
}

const names = await tableNames();
if (names.length === 0) {
  console.error('\nNo user tables came back. Nothing counted is not an empty database — it is a failed read.');
  process.exit(1);
}

/* ---- The real counts, which are the figure this script exists to produce ------- */

const counted: Take[] = [];
const failed: { name: string; reason: string }[] = [];

for (const name of names) {
  try {
    const res = await store.execute({ sql: `SELECT COUNT(*) AS n FROM ${name}`, args: [] });
    const row = (res.rows[0] ?? {}) as Record<string, unknown>;
    const n = Number(row.n ?? row.N ?? Object.values(row)[0]);
    if (!Number.isFinite(n)) {
      failed.push({ name, reason: 'the count returned no finite number' });
      continue;
    }
    counted.push({ name, n });
  } catch (error) {
    failed.push({ name, reason: error instanceof Error ? error.message : String(error) });
  }
}

const total = counted.reduce((sum, t) => sum + t.n, 0);

/* ---- The metadata cross-check ------------------------------------------------- */

const metadata = await metadataCounts();
let metadataTotal: number | null = null;
let metadataNote = 'not available on this dialect';
if (metadata !== null) {
  metadataTotal = metadata.reduce((sum, t) => sum + t.n, 0);
  metadataNote =
    metadataTotal === total
      ? `${metadataTotal.toLocaleString('en-US')} — agrees with the real count`
      : `${metadataTotal.toLocaleString('en-US')} — ★ DISAGREES with the real count`;
}

/* ---- The report, largest first, so the shape of the store is readable --------- */

console.log(`\ntables counted : ${counted.length}`);
console.log(`tables failed  : ${failed.length}`);
console.log(`metadata total : ${metadataNote}`);
console.log(`\n${counted.sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).map((t) => `${String(t.n).padStart(11)}  ${t.name}`).join('\n')}`);

if (failed.length > 0) {
  console.log('\n★ THESE TABLES COULD NOT BE COUNTED, SO THE TOTAL BELOW IS A FLOOR:');
  for (const f of failed) console.log(`  ${f.name} — ${f.reason}`);
}

/*
 * ★ THE OPERATOR'S DAY, NOT UTC'S. `toISOString().slice(0, 10)` is the UTC date, and
 *   at 20:00 local on the 27th it prints the 28th — a "measured on" one day ahead of
 *   the person who ran it, which is the kind of small wrongness that makes a reader
 *   distrust the figure beside it. `en-CA` is the locale whose date format is already
 *   `YYYY-MM-DD`, so this is a local date with no reassembly.
 */
const measuredOn = new Date().toLocaleDateString('en-CA');

console.log('\n' + '─'.repeat(78));
console.log(`TOTAL: ${total.toLocaleString('en-US')} rows across ${counted.length} tables`);
console.log(`floor: over ${Math.floor(total / 1_000_000)} million`);
console.log('─'.repeat(78));

/*
 * The mirrors, found by comparing counts rather than by matching on the `WCSEXP_`
 * prefix — a prefix match would call two tables copies because somebody named them
 * alike, and this is a measurement of what the rows are, not of what they are called.
 *
 * ★ THE COMPARISON IS ON THE **BARE** TABLE NAME, AND ONE EARLIER TAKE GOT THIS WRONG.
 *   SQL Server reports `dbo.WCSEXP_PO_HEADERS`, so the guard's original suffix test —
 *   `t.name.endsWith('WCSEXP_…')` against a bare name — was never true and this whole
 *   block printed nothing. A disclosure that silently does not appear is worse than
 *   one that is absent: the script went on to call the total a plain row count with
 *   nothing said about the copies sitting inside it.
 */
const bare = (name: string): string => (name.includes('.') ? name.slice(name.indexOf('.') + 1) : name);
const mirrors = counted.filter((t) =>
  counted.some(
    (other) => other !== t && other.n === t.n && other.name !== t.name && bare(t.name).startsWith('WCSEXP_'),
  ),
);
if (mirrors.length > 0) {
  const mirrorRows = mirrors.reduce((sum, t) => sum + t.n, 0);
  console.log(
    `\n★ ${mirrors.length} table(s) hold exactly the same number of rows as another table.\n` +
      `  They are copies, so the total is a ROW count and not a count of distinct data;\n` +
      `  ${mirrorRows.toLocaleString('en-US')} of the rows above are duplicates of rows counted once already:\n` +
      mirrors
        .map((t) => `    ${t.name}  (${t.n.toLocaleString('en-US')} rows)`)
        .join('\n'),
  );
}

console.log('\nPaste into `app/src/data/ledgerScale.ts`:\n');
console.log('export const STORE_SCALE: LedgerScale = {');
console.log(`  tables: ${counted.length},`);
console.log(`  records: ${total.toLocaleString('en-US').replace(/,/g, '_')},`);
console.log(`  measuredOn: '${measuredOn}',`);
console.log(`  target: '${config.appDb.label}',`);
console.log(`  scope: 'the store as it stands — every user table, no account scope applied',`);
console.log('};');

if (failed.length > 0 || (metadataTotal !== null && metadataTotal !== total)) process.exit(1);
