/**
 * Measure the live ledger, and print the two figures the sign-in screen states.
 *
 * ── ★ WHY THIS IS A SCRIPT AND NOT AN ENDPOINT
 *
 * Counting the readable ledger is one `SELECT COUNT(*)` per table and costs about
 * **13 s** against Oracle — `GL_BALANCES` alone is 157,150,828 rows and
 * `GL_JE_LINES` another 33,155,055. That is far too much to spend on the first
 * paint of the first screen, and the answer barely moves. So the count is taken
 * *here*, on demand, and recorded in `app/src/data/ledgerScale.ts`, which states
 * it. This file is what makes that stated number reproducible instead of an
 * assertion nobody can check.
 *
 * ── ★ WHAT IT COUNTS, AND WHAT IT REFUSES TO COUNT
 *
 * The API's descriptors name **34** objects. They are not all countable from one
 * place, and the split is the whole reason this script is not three lines:
 *
 *   • `X_REPORT_PROJECT_FACTS` and `X_REPORT_FUNDING_LINES` are **app-owned**
 *     (see `APP_TABLES` in `db/store.ts`) even though descriptors describe them.
 *     Probing those against Oracle answers `ORA-00942`, and counting them would
 *     put app rows into a ledger total. So they are filtered out by asking
 *     `storeForTable()`, which is the same gate `ledgerPlan()` uses — ★ a script
 *     that re-implemented that rule would be a second opinion about routing, and
 *     the two would drift.
 *   • Views this account is **not granted** (`V_SEGMENT_LEGEND`,
 *     `V_ACCOUNT_POSITION`, `V_BUDGET_BY_ACCOUNT_PERIOD`) resolve to `ok: false`
 *     and are reported by name rather than skipped. A total that quietly omits
 *     them reads exactly like a total that covers everything.
 *
 * ── ★ IT FAILS LOUDLY RATHER THAN PRINTING A PLAUSIBLE NUMBER
 *
 * Three guards, because every one of them is a way this could lie:
 *
 *   1. A count that never arrives — an exception, or a row with no usable `n` —
 *      is recorded as a **failure**, not as `0`. `Number(rows[0]?.n ?? 0)` would
 *      turn "no row came back" into a real zero and shrink the total silently.
 *   2. `counted === 0` exits non-zero. Nothing counted is not a small ledger.
 *   3. Any failed count exits non-zero too, so a table that has stopped being
 *      readable cannot make the headline look merely smaller.
 *
 * Run:
 *
 *     Push-Location server; npm run ledger:scale; Pop-Location
 */

import { apiRouter } from '../routes/index.js';
import { registeredResources } from '../routes/resource.js';
import { ledgerPlan } from '../db/ledger-shape.js';
import { storeDriver } from '../db/client.js';
import { storeForTable } from '../db/store.js';
import { config } from '../config/env.js';

interface Target {
  readonly table: string;
  readonly columns: readonly string[];
}

/** Touch the router the way the server does, so the descriptors are registered. */
apiRouter();

const descriptors = registeredResources();

/** One entry per table — several descriptors can describe the same one. */
const byTable = new Map<string, readonly string[]>();
for (const d of descriptors) {
  if (!byTable.has(d.table)) byTable.set(d.table, d.columns);
}

const ledger: Target[] = [];
const elsewhere: Target[] = [];
for (const [table, columns] of byTable) {
  /*
   * ★ A THROW HERE IS ROUTING'S TO REPORT, NOT THIS SCRIPT'S. `storeForTable`
   *   throws for a table no list knows, and the right thing for a measurement
   *   script to do is keep the name visible in the report rather than abort —
   *   an unregistered table is a routing defect, and this run is not the place
   *   to discover it. It is counted as "not this script's to count" and named.
   */
  let store = 'unknown';
  try {
    store = storeForTable(table);
  } catch {
    /* left as 'unknown', reported below */
  }
  (store === 'ledger' ? ledger : elsewhere).push({ table, columns });
}

const driver = storeDriver('ledger');
const readable: Target[] = [];
const notGranted: { table: string; reason: string }[] = [];

const planStart = Date.now();
for (const t of ledger) {
  const plan = await ledgerPlan({ table: t.table, columns: t.columns });
  if (plan.ok) readable.push(t);
  else notGranted.push({ table: t.table, reason: plan.reason });
}
const planMs = Date.now() - planStart;

let total = 0;
let counted = 0;
const failed: string[] = [];
const timings: { table: string; ms: number; n: number }[] = [];

const countStart = Date.now();
for (const t of readable) {
  /* Re-ask, which is a cache hit: the plan pass above already resolved this. */
  const plan = await ledgerPlan({ table: t.table, columns: t.columns });
  if (!plan.ok) continue;

  const started = Date.now();
  try {
    const res = await driver.execute({
      sql: `SELECT COUNT(*) AS n FROM ${plan.from}`,
      args: {},
    });
    const row = (res.rows[0] ?? {}) as Record<string, unknown>;
    const n = Number(row.n ?? row.N ?? Object.values(row)[0]);
    if (!Number.isFinite(n)) {
      failed.push(`${t.table} (no usable count returned)`);
      continue;
    }
    timings.push({ table: t.table, ms: Date.now() - started, n });
    total += n;
    counted += 1;
  } catch (err) {
    failed.push(`${t.table} (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`);
  }
}
const countMs = Date.now() - countStart;

/** Objects the API can actually serve: the granted ledger tables plus the app's own. */
const serving = readable.length + elsewhere.length;

const say = (line = ''): void => console.log(line);

say();
say('── ★ LEDGER SCALE ─────────────────────────────────────────────────────────');
say(`target            : ${config.db.mode} → ${config.db.label}`);
say(`descriptors       : ${descriptors.length}`);
say(`distinct objects  : ${byTable.size}`);
say(`  ledger          : ${ledger.length}`);
say(`  app store       : ${elsewhere.length}  (${elsewhere.map((t) => t.table).join(', ') || 'none'})`);
say(`not granted       : ${notGranted.length}  (${notGranted.map((t) => t.table).join(', ') || 'none'})`);
say(`counted           : ${counted} of ${readable.length} readable ledger tables`);
say(`resolution pass   : ${(planMs / 1000).toFixed(1)} s`);
say(`counting pass     : ${(countMs / 1000).toFixed(1)} s`);
say();
say(`TOTAL RECORDS     : ${total.toLocaleString('en-US')}`);

const slowest = [...timings].sort((a, b) => b.ms - a.ms).slice(0, 5);
if (slowest.length) {
  say();
  say('── the slowest five ──');
  for (const t of slowest) {
    say(`  ${String(t.ms).padStart(6)} ms  ${t.table}  ${t.n.toLocaleString('en-US')} rows`);
  }
}

say();
say('── paste into app/src/data/ledgerScale.ts ──');
say(`  tables: ${serving},`);
say(`  records: ${total},`);

if (failed.length) {
  say();
  console.error(`FAILED to count ${failed.length} table(s):`);
  for (const f of failed) console.error(`  ${f}`);
}
if (notGranted.length) {
  say();
  say(`(not granted — expected on this account: ${notGranted.map((t) => t.table).join(', ')})`);
}

/* ── ★ THE TWO GATES. A run that counted nothing, or that lost a table, is not a
      smaller answer — it is a wrong one, and it must not exit 0. ── */
if (counted === 0) {
  console.error('\n✗ Nothing was counted. That is a failed measurement, not an empty ledger.');
  process.exit(1);
}
if (failed.length) {
  console.error(`\n✗ ${failed.length} table(s) could not be counted — the total above is incomplete.`);
  process.exit(1);
}

say('\n✓ measured');
process.exit(0);
