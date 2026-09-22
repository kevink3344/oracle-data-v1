/**
 * Builds the data file the monthly-trend mockup reads for its detail drawer.
 *
 * The mockup is a static page opened from disk (`file://`), and a browser blocks
 * `fetch()` of a local file from that origin — so the page cannot read
 * `data/oracle/full-output.json` at run time. It reads this instead: the same
 * extract, indexed by the seven-segment key, written as a script that assigns a
 * global the page can use directly.
 *
 * Nothing is filtered or summarised. Every one of the extract's rows is emitted,
 * including the cancelled one, so the drawer reports what the file actually holds
 * rather than what this script decided was interesting.
 *
 *   node scripts/build-mockup-data.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = resolve(root, 'data/oracle/full-output.json');
const TARGET = resolve(root, 'docs/screenshots/oracle-po-lines.js');

/** The key flexfield, in the order Oracle stores it. */
const SEGMENTS = ['FUND', 'PURPOSE', 'PROGRAM', 'OBJECT_', 'LEVEL_', 'COST_CENTER', 'FUTURE_USE'];

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const amount = (v) => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

const envelope = JSON.parse(readFileSync(SOURCE, 'utf8'));
const rows = envelope?.body?.ResultSets?.Table1;
if (!Array.isArray(rows)) {
  console.error(`${SOURCE} did not contain body.ResultSets.Table1.`);
  process.exit(1);
}

const keyOf = (r) => SEGMENTS.map((s) => str(r[s])).join('-');

/** Interning pools. 157 vendors and 7 buyers repeat across 2,782 rows. */
const vendorPool = [];
const vendorIx = new Map();
const buyerPool = [];
const buyerIx = new Map();
const intern = (pool, index, value) => {
  const seen = index.get(value);
  if (seen !== undefined) return seen;
  const next = pool.push(value) - 1;
  index.set(value, next);
  return next;
};

/** `2025-05-20T00:00:00` -> `2025-05-20`. Any real time of day is reported, never dropped silently. */
let withTime = 0;
const dayOf = (v) => {
  const s = str(v);
  if (s.length > 10 && !/T00:00:00(\.0+)?$/.test(s)) withTime++;
  return s.slice(0, 10);
};

const byKey = new Map();
for (const r of rows) {
  const key = keyOf(r);
  const tuple = [
    dayOf(r.ORDER_DATE),
    Number(str(r.ORDER_NUMBER)) || 0,
    Number(str(r.LINE_NUMBER)) || 0,
    intern(vendorPool, vendorIx, str(r.VENDOR_NAME)),
    intern(buyerPool, buyerIx, str(r.BUYER_NAME)),
    str(r.DESCRIPTION),
    amount(r.AMOUNT),
    str(r.STATUS),
    str(r.CANCEL_FLAG).toUpperCase() === 'Y' ? 1 : 0,
  ];
  const list = byKey.get(key);
  if (list) list.push(tuple);
  else byKey.set(key, [tuple]);
}

/** Oldest first, with the ordering fixed so a re-run produces an identical file. */
const sorted = {};
for (const key of [...byKey.keys()].sort()) {
  const list = byKey.get(key);
  list.sort(
    (a, b) => a[0].localeCompare(b[0]) || a[1] - b[1] || a[2] - b[2] || a[5].localeCompare(b[5]),
  );
  sorted[key] = list;
}

const dates = rows.map((r) => dayOf(r.ORDER_DATE)).filter(Boolean).sort();
const cancelled = rows.filter((r) => str(r.CANCEL_FLAG).toUpperCase() === 'Y').length;

const header = `/* GENERATED FILE - do not edit by hand.
 *
 * The purchase-order lines from data/oracle/full-output.json, indexed by the
 * seven-segment key ${SEGMENTS.join('-')}.
 *
 *   ${rows.length} rows, ${byKey.size} distinct combinations, ${vendorPool.length} vendors,
 *   ${cancelled} cancelled, order dates ${dates[0]} to ${dates[dates.length - 1]}.
 *
 * Regenerate with:
 *   node scripts/build-mockup-data.mjs
 *
 * A script rather than a .json file on purpose: the mockup is opened straight
 * from disk, where a browser blocks fetch() of a local file, so the data has to
 * arrive as something the page can execute.
 *
 * byKey[key] is an array of
 *   [date, order, line, vendorIx, buyerIx, description, amount, status, cancelled]
 * where vendorIx indexes "vendors" and buyerIx indexes "buyers", both of which
 * are interned because 2,782 rows share only ${vendorPool.length} vendors and ${buyerPool.length} buyers.
 * "date" is the ORDER_DATE trimmed to its day - every row in the extract is
 * stamped midnight, so the time of day carries no information.
 */
`;

// Written by hand rather than by JSON.stringify(…, null, 2): the top level should
// be readable at a glance, but 2,782 rows must not be indented into six times
// their own length. One combination per line keeps the diff readable too.
const out = [header, 'window.ORACLE_PO_LINES = {'];
const scalar = (k, v) => out.push(`  ${k}: ${JSON.stringify(v)},`);
scalar('source', 'data/oracle/full-output.json');
scalar('key', SEGMENTS.join('-'));
scalar('rows', rows.length);
scalar('combinations', byKey.size);
scalar('cancelled', cancelled);
scalar('first', dates[0] ?? '');
scalar('last', dates[dates.length - 1] ?? '');
scalar('vendors', vendorPool);
scalar('buyers', buyerPool);
out.push('  byKey: {');
for (const [key, list] of Object.entries(sorted)) out.push(`    ${JSON.stringify(key)}: ${JSON.stringify(list)},`);
out.push('  }');
out.push('};', '');

writeFileSync(TARGET, out.join('\n'), 'utf8');

const kb = (readFileSync(TARGET).length / 1024).toFixed(0);
console.log(`wrote ${TARGET}`);
console.log(`  rows ${rows.length} · combinations ${byKey.size} · cancelled ${cancelled}`);
console.log(`  vendors ${vendorPool.length} · buyers ${buyerPool.length}`);
console.log(`  dates ${dates[0]} .. ${dates[dates.length - 1]}`);
console.log(`  ${kb} KB`);
if (withTime) console.log(`  NOTE: ${withTime} rows carry a non-midnight ORDER_DATE; the time was dropped.`);
