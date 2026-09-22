/**
 * copy-oracle-to-turso.ts — copy the LEDGER half of the data from Oracle into the
 * v2 Turso database, at a 100,000-row cap per table.
 *
 * Read → normalise → (delete) → insert → verify. Nothing in this file writes to
 * Oracle; every Oracle statement it issues is a SELECT.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ WHY A `.ts` UNDER `tsx` AND NOT A PLAIN `.mjs` (a deliberate deviation from
 *   §8 of docs/plans/turso-copy-plan.md, which prescribes `.mjs` beside
 *   `pull-ap-extract.mjs`)
 *
 * The copy's projection is "the destination's declared columns, minus the ones
 * this deployment cannot read" (§4.1) — and `ledgerPlan()` in
 * `src/db/ledger-shape.ts` already computes exactly that, including WHICH object
 * actually holds each declared column (a declared divergence, the customer's
 * `WCSEXP_*` view, or the base table with the genuinely absent columns served as
 * `NULL`).
 *
 * A `.mjs` cannot import that module — it is TypeScript behind `.js` specifiers —
 * so it would have to restate the projection by hand. That would be a FOURTH
 * hand-copy of a machine-readable set, and this project has been bitten by that
 * three times already:
 *   • `APP_OWNED_TABLES` drifted 4 → 7 → 11 with nothing checking it (§the G13a
 *     failure), because a comment saying "keep this in step" is not a gate;
 *   • `ROUTING_APP_TABLES` was missing a table, so `SELECT … FROM <new table>`
 *     fell through to the ledger and died with `ORA-00942` — about a table the
 *     app itself creates and stores;
 *   • §5.2's `plan.pk` cast, which compiled, evaluated to `undefined` on every
 *     table, and silently answered a different question (ROWID) than the one
 *     asked.
 * So: one source of truth, imported. `tsx` runs it; the npm scripts point at it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ THE CAP KEY COMES FROM THE DESTINATION'S IDENTITY, NOT FROM ANY DESCRIPTOR
 *
 * `ledgerPlan()` returns `{ ok, from, unavailable }` and has no `pk`. The key is
 * therefore read from the destination — `pragma_table_info`'s `pk` ordinals,
 * else a unique index — and **printed per table**, because a key that silently
 * fell back to ROWID would not fail, it would answer a different question.
 *
 * ★ AND WHEN THE SOURCE IS AN INLINE VIEW, ROWID IS NOT AVAILABLE AT ALL.
 *   Oracle raises `ORA-01445: cannot select ROWID from, or sample, a view with
 *   joins` — which is the error §3.1 already recorded for `FND_FLEX_VALUES`. So
 *   the ROWID fallback is attempted only when the plan returned a plain quoted
 *   object, and even then it is wrapped: if Oracle refuses ROWID, the read falls
 *   back to ordering by the whole projected column list, deterministically.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ THE DECISIONS THIS FILE ENCODES (all taken explicitly, none inferred)
 *
 *  1. SCOPE IS DERIVED, NEVER LISTED (§2.1). `registeredResources()` filtered by
 *     `storeForTable() === 'ledger'` and `classOfTable() === 'EBS'` — the same
 *     gate `ledgerPlan()` uses.
 *  2. `GL_BUDGET_ASSIGNMENTS` IS **EXCLUDED** FROM THE LOAD, and the exclusion is
 *     named with its reason. Its destination primary key IS the three columns
 *     this deployment cannot read; SQLite treats NULLs as DISTINCT in a unique
 *     index, so loading it would write ~100,000 indistinguishable rows **with no
 *     error at all** — a silent corruption. It is still DELETED by `--refresh`,
 *     because leaving the seed's rows there would block the FK-safe delete of its
 *     parent `GL_BUDGET_VERSIONS`.
 *  3. THE SIX SEED-OWNED TABLES ARE LOADED FROM ORACLE TOO, with each unreadable
 *     NOT NULL value DERIVED and DECLARED by name. The curated sample is
 *     discarded, so there is no fallback for those 9 NOT NULL columns; and per
 *     §3.10 an unfilled NOT NULL column cascades through every FK that depends on
 *     it. Every derived value is printed with its rule and its reason, so a
 *     derived value can never be mistaken for a read one.
 *
 *     ★ NINE, NOT EIGHT. `PA_BUDGET_LINES.LINE_NUM` is the ninth, and it has neither
 *     a derivation nor a default — which is survivable ONLY because that table holds
 *     0 rows in this deployment, so no INSERT is attempted. That is a fact about the
 *     SOURCE, not a guarantee: the insert half refuses loudly if rows ever appear.
 *  4. THE FOUR `AP_*` TABLES ARE OUT OF SCOPE AND THAT IS STATED (§2.3). They are
 *     declared in `00-schema.sql` and carry 5 of the 28 FKs, but they have no
 *     resource descriptor and no route, so a scope derived from the descriptors
 *     omits them. Silence there is the failure mode, so it is named in the
 *     report: they are neither loaded nor deleted.
 *  5. THE CHILD SLICE IS NARROWED TO THE PARENT'S OWN LOADED SLICE (§3.9 option 1),
 *     because the DECISION'S LITERAL FORM WAS MEASURED IMPOSSIBLE. It said "take
 *     the 100,000 CODE_COMBINATION_IDs the children actually reference". Measured
 *     on the live source:
 *
 *         GL_CODE_COMBINATIONS rows available      1,300,594
 *         GL_CODE_COMBINATIONS distinct ids        1,300,594  (it is the PK —
 *                                                   DISTINCT cannot shrink it)
 *         the cap                                    100,000  (92.3 % removed)
 *         GL_BALANCES distinct CODE_COMBINATION_IDs  616,235  ← 6.2× the cap
 *         GL_JE_LINES distinct CODE_COMBINATION_IDs  615,889
 *         PO_DISTRIBUTIONS_ALL distinct …             23,183
 *
 *     616,235 referenced keys cannot be covered by 100,000 parent rows. No
 *     ordering of the parent fixes arithmetic. What IS implementable is the other
 *     direction — §3.9's "narrowing its slice to the parent's keys": read only the
 *     child rows whose FK value lies inside the parent's OWN loaded slice, so the
 *     cap applies to SURVIVING rows and the FK holds BY CONSTRUCTION rather than by
 *     luck. (It held by luck before: `GL_JE_LINES` passed the overlap check only
 *     because its key order happened to land inside the parent's low-id band.)
 *
 *     ★ IT COSTS NOTHING, MEASURED BEFORE IT WAS WRITTEN. With the parent's
 *     100,000-row slice in place, every affected child was still AT the cap:
 *     GL_BALANCES 100,000, GL_JE_LINES 100,000, PO_DISTRIBUTIONS_ALL 100,000. The
 *     cap was already choosing WHICH rows; the parent now chooses them instead.
 *     The only change is that what remains is FK-legal.
 *
 *     ★ THE PREDICATE WRAPS THE PARENT'S FINAL read SQL, not a re-derived one. A
 *     parent's slice is decided at read time (including a ROWID fallback chosen only
 *     after ORA-01445), so re-deriving it here would point a grandchild at rows the
 *     parent had dropped. Every narrowed edge is PRINTED, and every edge that could
 *     NOT be narrowed is printed with its reason — an unstated skip is how this goes
 *     quiet.
 *  6. AN IDENTITY COLLISION IS DECIDED BEFORE THE WRITE, NOT DISCOVERED BY IT (§G18).
 *     The destination's declared PRIMARY KEY can be STRICTER than the source's data:
 *     Oracle's `FND_FLEX_VALUES` holds 41,877 rows but only 41,727 distinct
 *     `(FLEX_VALUE_SET_ID, FLEX_VALUE)` pairs, and that pair IS the destination's PK.
 *     G15 measures every such collision in a DRY RUN, for free.
 *
 *     ★ THE FIRST REAL WRITE PROVED THAT MEASURING IS NOT ENOUGH. G15 reported the
 *     collision; nothing acted on the verdict; the DELETE half committed (10,182 rows
 *     removed) and the INSERT died on it, leaving the destination emptied and only
 *     `FND_CURRENCIES`' 266 rows restored. So the verdict is now a DECISION the write
 *     path honours: `IDENTITY_POLICY` declares, per table, either DEDUPE (fold the
 *     duplicates, keep the first, and print how many) or nothing at all — in which
 *     case the run still stops BEFORE any write, which is the safe default.
 *
 *     ★ THE FOLD HAPPENS BEFORE THE DELETE HALF (G18), and it is applied to the rows
 *     the INSERT actually uses, so the DELETE and the INSERT can no longer disagree
 *     about what is being loaded. Folded rows are named in the report AND in the JSON
 *     artifact: a copy that folded must never read as a copy that took everything.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ WHAT THIS FILE DELIBERATELY DOES NOT DO
 *
 *  • It does not convert money to INTEGER cents (§7's first row). The set of
 *    money columns is not machine-readable from anything on disk, and guessing it
 *    would silently rescale values. Numeric values pass through unchanged, and
 *    the destination's `REAL` columns that received numeric data are PRINTED, so
 *    the precision risk surface from §7 is named rather than assumed away.
 *  • It does not raise `fetchArraySize` inside `src/db/oracle.ts` (§10.9). That
 *    is a production read-path change and a separate decision; this script sets
 *    its own 2,000 and says so.
 *  • It does not run `scripts/build-turso-sample.mjs --remote`. That script DROPS
 *    EVERY TABLE AND VIEW in `TURSO_DATABASE` (its `--remote` path, :798–818) and
 *    it would erase the 1,607 app rows v2 already holds.
 *
 * Usage:
 *   tsx scripts/copy-oracle-to-turso.ts                 # --refresh (the default)
 *   tsx scripts/copy-oracle-to-turso.ts --dry-run       # read + plan, write nothing
 *   tsx scripts/copy-oracle-to-turso.ts --table=GL_LEDGERS
 *   tsx scripts/copy-oracle-to-turso.ts --fresh         # insert-only, asserts empty
 */

import oracledb from 'oracledb';
import { createClient, type Client, type InValue } from '@libsql/client';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { REPO_ROOT } from '../src/config/env.js';
import { ledgerPlan } from '../src/db/ledger-shape.js';
import { classOfTable, storeForTable } from '../src/db/store.js';
import { apiRouter } from '../src/routes/index.js';
import { registeredResources } from '../src/routes/resource.js';

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);

function rawFlag(name: string): string | undefined {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (hit === undefined) return undefined;
  const eq = hit.indexOf('=');
  return eq === -1 ? '1' : hit.slice(eq + 1);
}
const flag = (name: string): boolean => rawFlag(name) !== undefined;
const opt = (name: string, fallback: string): string => rawFlag(name) ?? fallback;

const FRESH = flag('fresh');
const REFRESH = !FRESH; // --refresh is the default; --fresh is explicit (§8)
const DRY = flag('dry-run');
const VERIFY = !flag('no-verify');
const ONLY = rawFlag('table');
const CAP = Number(opt('cap', '100000'));
const ALLOW_V1 = flag('allow-v1');

if (flag('help')) {
  process.stdout.write(
    'copy-oracle-to-turso.ts [--refresh|--fresh] [--dry-run] [--table=<T>]\n' +
      '                       [--cap=<n>] [--no-verify] [--allow-v1]\n',
  );
  process.exit(0);
}
if (!Number.isFinite(CAP) || CAP < 1) throw new Error(`--cap must be a positive number, got "${opt('cap', '')}"`);

// ─────────────────────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────────────────────

const report: string[] = [];

/**
 * ★ Values that arrived as an OBJECT and had to be serialised.
 *
 * A LOB handle, or a driver-mapped type outside `fetchTypeHandler` /
 * `fetchAsString` coverage, arrives as an object — and `JSON.stringify` of one
 * produces a perfectly plausible string that is NOT the data. Counting them per
 * column is what lets the report say so, instead of the copy looking clean.
 */
const jsonFallbacks = new Map<string, number>();
const say = (s = ''): void => {
  report.push(s);
  process.stdout.write(s + '\n');
};

let failed = 0;
let passed = 0;
const ok = (label: string, detail = ''): void => {
  passed++;
  say(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
};
const bad = (label: string, detail = ''): void => {
  failed++;
  say(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
};
const info = (label: string, detail = ''): void => {
  say(`  ·     ${label}${detail ? ` — ${detail}` : ''}`);
};

const ms = (n: number): string => `${n.toLocaleString('en-US')} ms`;
const num = (n: number): string => n.toLocaleString('en-US');

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Unquoted, folded identifier for case-insensitive comparison. */
const norm = (name: string): string => name.replace(/"/g, '').toUpperCase();

type Dict = Record<string, unknown>;

/** A row's values as the destination will hold them. */
type Value = InValue;

const isRealNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Oracle `DATE`/`TIMESTAMP` → text.
 *
 * §7 asks for `TEXT 'YYYY-MM-DD'`. That is what a midnight value gets. A value
 * that genuinely carries a time keeps it, because discarding it would be a
 * silent loss rather than a mapping — and the rule is printed either way.
 */
function dateText(d: Date): string | null {
  const y = d.getUTCFullYear();
  if (!Number.isFinite(y) || y < 1000) return null; // zero-date sentinel → NULL (§7)
  const date = d.toISOString().slice(0, 10);
  const hh = d.getUTCHours();
  const mm = d.getUTCMinutes();
  const ss = d.getUTCSeconds();
  if (hh === 0 && mm === 0 && ss === 0) return date;
  return `${date} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Destination helpers
// ─────────────────────────────────────────────────────────────────────────────

const hostOf = (url: string | undefined): string => {
  if (!url) return '(unset)';
  const m = /^(?:libsql|https?|wss?):\/\/([^/?#]+)/i.exec(url);
  // `m[1]` is `string | undefined` under `noUncheckedIndexedAccess` — the capture
  // group is guaranteed by the pattern, but the compiler cannot know that.
  return m?.[1] ?? url;
};

/** `pragma_table_info` — ★ the table name is INTERPOLATED, never bound.
 *  Binding a table name into a pragma function PANICS libSQL (Rust
 *  `Option::unwrap()` on None at `src/statement.rs:360`) and surfaces as a
 *  NativeCommandError with no SQL message at all. */
async function tableInfo(dst: Client, table: string): Promise<Dict[]> {
  const rs = await dst.execute(`SELECT * FROM pragma_table_info('${table.replace(/'/g, "''")}')`);
  return rs.rows as unknown as Dict[];
}

/** `pragma_index_list` / `pragma_index_info`, both interpolated for the same reason. */
async function indexList(dst: Client, table: string): Promise<Dict[]> {
  const rs = await dst.execute(`SELECT * FROM pragma_index_list('${table.replace(/'/g, "''")}')`);
  return rs.rows as unknown as Dict[];
}
async function indexInfo(dst: Client, index: string): Promise<Dict[]> {
  const rs = await dst.execute(`SELECT * FROM pragma_index_info('${index.replace(/'/g, "''")}')`);
  return rs.rows as unknown as Dict[];
}
async function foreignKeyList(dst: Client, table: string): Promise<Dict[]> {
  const rs = await dst.execute(`SELECT * FROM pragma_foreign_key_list('${table.replace(/'/g, "''")}')`);
  return rs.rows as unknown as Dict[];
}

interface DestinationIdentity {
  /** The declared primary key, in declaration order. Empty when there is none. */
  pk: string[];
  /** The first usable unique index, if any. */
  unique: string[];
  notNull: Map<string, { notNull: boolean; dflt: string | null }>;
  declared: string[];
}

async function destinationIdentity(dst: Client, table: string): Promise<DestinationIdentity> {
  const cols = await tableInfo(dst, table);
  const declared = cols.map((c) => String(c.name));
  const notNull = new Map<string, { notNull: boolean; dflt: string | null }>();
  for (const c of cols) {
    notNull.set(norm(String(c.name)), {
      notNull: Number(c.notnull) === 1,
      dflt: c.dflt_value === null || c.dflt_value === undefined ? null : String(c.dflt_value),
    });
  }

  const pk = cols
    .filter((c) => Number(c.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((c) => String(c.name));

  let unique: string[] = [];
  for (const ix of await indexList(dst, table)) {
    if (Number(ix.unique) !== 1) continue;
    if (String(ix.origin) === 'pk') continue; // already represented by `pk`
    const members = (await indexInfo(dst, String(ix.name)))
      .sort((a, b) => Number(a.seqno) - Number(b.seqno))
      .map((c) => String(c.name));
    if (members.length > 0) {
      unique = members;
      break;
    }
  }
  return { pk, unique, notNull, declared };
}

// ─────────────────────────────────────────────────────────────────────────────
// The load plan, per table
// ─────────────────────────────────────────────────────────────────────────────

interface TableLoad {
  table: string;
  /** The descriptor's declared columns, in first-seen order. */
  columns: string[];
  /** The resolved `FROM` expression — a quoted object, or an inline view. */
  from: string;
  /** Declared columns with no readable source; served as NULL by the view. */
  unavailable: string[];
  /**
   * Destination columns the descriptor's own list never names. §4.1 measured this
   * at 0 — the user's "confirm the schemas match" check is exactly this number.
   * Reported separately from `unavailable` because ONE WORD HAD BEEN HIDING TWO
   * MEASUREMENTS (see `unfilled`).
   */
  noHome: string[];
  /**
   * Destination columns that reach an INSERT with no real value — the union of
   * `noHome` and the columns this deployment cannot read. THIS is §4.1's "27
   * unfilled across 10 tables", and it is what the gates and the derivations use.
   */
  unfilled: string[];
  /** Of those, the ones that are NOT NULL — these break the INSERT (G4). */
  notNullUnfilled: string[];
  /** The ORDER BY the cap used. */
  keyColumns: string[];
  keySource: string;
  /**
   * The UNCAPPED select — projection, FROM, the narrowing WHERE, the ORDER BY.
   * ★ Carried separately from `readSql` because it is what a CHILD's narrowing
   *   predicate must wrap: the child has to be constrained to the parent's own
   *   loaded slice, and the slice is `readBody` capped at CAP (not at CAP+1, or
   *   a child could bind to a row the parent did not load).
   */
  readBody: string;
  /** SQL needed to fetch this table's capped slice. */
  readSql: string;
  /**
   * The FK slices this table's read was narrowed to (decision 5). Empty means the
   * read was not narrowed — either it has no in-scope parent, or every edge was
   * skipped for a reason named in `narrowSkipped`.
   */
  narrowed: Array<{ parent: string; column: string; parentColumn: string; sliceSql: string }>;
  /** In-scope FK edges that could NOT be narrowed. Named, never silently dropped. */
  narrowSkipped: Array<{ parent: string; column: string; why: string }>;
  /** Rows read, after the cap — then FOLDED by the declared identity policy, if any. */
  rows: Value[][];
  /** Column names of `rows`, from Oracle's own metadata. */
  names: string[];
  truncated: boolean;
  /**
   * Rows folded away by `IDENTITY_POLICY` (G18), BEFORE the delete half. 0 unless a
   * collision policy was declared for this table AND applied — so a 0 here is a
   * fact about the run, not an absence of the question being asked.
   */
  folded: number;
  readMs: number;
  /** NOT NULL unfilled columns filled by a declared derivation. */
  derived: Array<{ column: string; value: Value; rule: string; reason: string }>;
}

/** Derive a NOT NULL value the source cannot supply, or explain why it cannot be. */
interface DeriveRule {
  rule: string;
  reason: string;
}

const DERIVATIONS: Record<string, DeriveRule> = {
  'PO_AGENTS.NAME': {
    rule: `'Agent ' || AGENT_ID`,
    reason:
      'PO_AGENTS.NAME is not granted (ORA-00942 on that one column while AGENT_ID and ' +
      'AUTHORIZATION_LIMIT resolve from the same table in the same statement — a column-level ' +
      'privilege; an absent column would be ORA-00904). It cannot be recovered from a real ' +
      'BUYER_NAME either: AGENT_ID occurs 0 times anywhere in data/oracle/, because ' +
      'WCSEXP_PO_HEADERS never selects it, so no id→name mapping exists on disk.',
  },
  'GL_BUDGET_TYPES.BUDGET_TYPE_CODE': {
    rule: `'BT' || BUDGET_TYPE_ID`,
    reason: 'declared NOT NULL in 00-schema.sql; the source column is unreadable on this deployment',
  },
  'GL_BUDGET_TYPES.BUDGET_NAME': {
    rule: `'Budget type ' || BUDGET_TYPE_ID`,
    reason: 'declared NOT NULL in 00-schema.sql; the source column is unreadable on this deployment',
  },
  'GL_BUDGET_VERSIONS.LEDGER_ID': {
    rule: 'the single readable GL_LEDGERS.LEDGER_ID (a measurement, not an invention)',
    reason:
      'the column is unreadable on GL_BUDGET_VERSIONS, and it is an FK to GL_LEDGERS — which the ' +
      'copy loads, so a value that is NOT in GL_LEDGERS would make the FK fail rather than be absent',
  },
  'GL_BUDGET_VERSIONS.BUDGET_TYPE_ID': {
    rule: 'the single readable GL_BUDGET_TYPES.BUDGET_TYPE_ID (a measurement)',
    reason: 'unreadable here, and an FK to GL_BUDGET_TYPES which the copy loads',
  },
  'GL_BUDGET_ENTITIES.BUDGET_TYPE_ID': {
    rule: 'the single readable GL_BUDGET_TYPES.BUDGET_TYPE_ID (a measurement)',
    reason: 'unreadable here, and an FK to GL_BUDGET_TYPES which the copy loads',
  },
  'GL_BUDGET_ENTITIES.BUDGET_ENTITY_NAME': {
    rule: `'Entity ' || BUDGET_ENTITY_ID`,
    reason: 'declared NOT NULL in 00-schema.sql; the source column is unreadable on this deployment',
  },
  'FND_CURRENCIES.NAME': {
    rule: 'the row\'s own CURRENCY_CODE (the readable identity of the same row)',
    reason: 'declared NOT NULL in 00-schema.sql; the source column is unreadable on this deployment',
  },
};

// ★ THERE IS NO `PA_BUDGET_LINES.LINE_NUM` RULE, AND THAT IS DELIBERATE.
//
// It is the NINTH NOT NULL column with no readable source, and §4.1's "8 NOT NULL"
// did not count it. §4.4 named it and then left it open: *"`LINE_NUM` on
// `PA_BUDGET_LINES` is the worse case, because the destination has it in a composite
// primary key while the source cannot supply it."*
//
// A rule is not invented here, because every available one would fabricate the KEY:
// `ROW_NUMBER() OVER (PARTITION BY BUDGET_VERSION_ID ORDER BY ROWID)` produces
// numbers that depend on Oracle's row order, so two runs could key the same logical
// row differently — a worse failure than GL_BUDGET_ASSIGNMENTS' table of nulls, and
// for the same reason decision 2 excluded that table.
//
// It is not needed: ★ MEASURED — `PA_BUDGET_LINES` holds **0 rows** in this
// deployment (as do `PA_BUDGET_VERSIONS`, `PA_PROJECTS_ALL` and `PA_TASKS`), so no
// INSERT is attempted and no value is needed. G4 states this rather than passing
// silently over it, and the insert half throws if rows ever appear.

// ─────────────────────────────────────────────────────────────────────────────
// ★ THE IDENTITY-COLLISION POLICY — G15's VERDICT TURNED INTO A DECISION
//
// G15 measures whether the source slice can satisfy the DESTINATION's declared
// PRIMARY KEY (else UNIQUE index). When it cannot, the collision is a fact about
// the SCHEMA, not a bad row, and there are exactly two deliberate answers:
//
//   • DEDUPE  — the destination declares a key the source does not honour, so two
//               source rows can share it. Keep the first in read order and DECLARE
//               how many rows were folded.
//   • EXCLUDE — the table cannot be copied faithfully at all. Say so, and why.
//
// ★ AND "DEDUPE" DOES NOT MEAN THE COLLIDING ROWS ARE THE SAME ROW. This comment
//   said exactly that — *"two source rows sharing a key are the SAME row read
//   twice"* — and the measurement in `tmp-dup-probe.txt` says otherwise. Taking
//   `FND_FLEX_VALUES`' first colliding group (FLEX_VALUE_SET_ID 105210,
//   FLEX_VALUE 'INVOICE_NUM'), the three rows differ in FLEX_VALUE_ID
//   (30569 / 30571 / 30567), ENABLED_FLAG (Y / N / Y), START_DATE_ACTIVE
//   (01-JAN-50 / null / 01-JAN-50) and PARENT_FLEX_VALUE_LOW
//   ('Invoice Number' / 'Vendr Tax Inv#' / null). Three distinct records, one key.
//
//   So the honest description of what this policy does is LOSSY, not corrective: it
//   keeps one of the three and discards the other two permanently. The reasons below
//   say "explicit loss policy" for that reason, and they may not be softened back to
//   "the same row read twice" — that phrasing would make the fold look like a no-op
//   and is the kind of sentence that survives in a codebase long after the run it
//   justified.
//
// ★ THIS MAP IS THE DIFFERENCE BETWEEN A REPORT AND A COPY. Measured on the first
//   real write: G15 named the collision, NOTHING ACTED ON THE VERDICT, the DELETE
//   half committed, and the INSERT died —
//
//       SQLITE_CONSTRAINT: UNIQUE constraint failed:
//         FND_FLEX_VALUES.FLEX_VALUE_SET_ID, FND_FLEX_VALUES.FLEX_VALUE
//
//   — leaving the destination emptied with 266 rows restored out of 100,000+. A
//   gate that only prints is a gate that let that happen. Every table listed here
//   is a decision someone took; every table NOT listed here still stops the run
//   BEFORE any write, which is the safe default.
//
// ★ AND THE FOLD IS APPLIED BEFORE THE DELETE HALF (G18), not discovered by the
//   insert half. G15 already knows the collision from the READ, in a dry run, for
//   free — so `--refresh` can no longer be interrupted by something already known.
//   Nothing is dropped quietly: each table's folded count is printed.
//
// ★ `EXCLUDE` IS NOT IMPLEMENTED HERE, DELIBERATELY. An excluded table is still a
//   table in the destination's FK graph, so deleting-without-reloading it is its
//   own named decision that needs its own named handling — exactly what
//   `GL_BUDGET_ASSIGNMENTS` got (decision 2, and the delete half's first step).
//   A half-implemented `exclude` that quietly left stale rows behind would be the
//   silent-corruption failure mode this project keeps paying for.
interface CollisionPolicy {
  mode: 'dedupe';
  /** Which of the colliding rows survives. Always the first in READ order. */
  keep: 'first';
  reason: string;
}

const IDENTITY_POLICY: Record<string, CollisionPolicy> = {
  FND_FLEX_VALUES: {
    mode: 'dedupe',
    keep: 'first',
    reason:
      'Oracle holds 41,877 rows but only 41,727 distinct (FLEX_VALUE_SET_ID, FLEX_VALUE) ' +
      'pairs — 150 collide — and that pair is the destination\'s PRIMARY KEY. The source ' +
      'rows can differ in non-key columns, so this is an explicit loss policy: keep the ' +
      'first row in Oracle read order, preserve the destination key, and record the fold.',
  },
  FND_FLEX_VALUES_TL: {
    mode: 'dedupe',
    keep: 'first',
    reason:
      'Oracle returns 150 collisions on the destination PRIMARY KEY ' +
      '(FLEX_VALUE_SET_ID, FLEX_VALUE, LANGUAGE). The source rows can differ in ' +
      'non-key columns, so keep the first row in Oracle read order and record the ' +
      'explicit loss rather than letting the INSERT choose the outcome.',
  },
  FND_ID_FLEX_SEGMENTS: {
    mode: 'dedupe',
    keep: 'first',
    reason:
      'Oracle returns 141 collisions on the destination PRIMARY KEY ' +
      '(ID_FLEX_NUM, SEGMENT_NUM). The source rows can differ in non-key columns, ' +
      'so keep the first row in Oracle read order and record the explicit loss rather ' +
      'than letting the INSERT choose the outcome.',
  },
  FND_ID_FLEX_STRUCTURES: {
    mode: 'dedupe',
    keep: 'first',
    reason:
      'Oracle returns 69 collisions on the destination PRIMARY KEY (ID_FLEX_NUM). ' +
      'The source rows can differ in non-key columns, so keep the first row in Oracle ' +
      'read order and record the explicit loss rather than letting the INSERT choose ' +
      'the outcome.',
  },
};

/**
 * The derivation function, injected rather than reached for.
 *
 * ★ WHY A PARAMETER AND NOT A CALL. `deriveValue` is declared inside `main()`,
 *   because it closes over the two keys that function measures from the source
 *   (`measured.ledgerId`, `measured.budgetTypeId`) — a GL_BUDGET_VERSIONS row cannot
 *   be given a LEDGER_ID until the single readable GL_LEDGERS.LEDGER_ID is known,
 *   and that is a fact about the run, not about the row. `identityKeyer` sits at
 *   module scope, above `main()`, so it cannot see it.
 *
 *   Passing it in keeps exactly ONE derivation in this file: the key G15 counts
 *   with and the fold G18 applies are built by the same rules the INSERT uses. A
 *   copy of the rules here could only ever imitate them, and the whole point of
 *   factoring this out was that the gate and the write must not drift.
 */
type Deriver = (table: string, column: string, row: Dict) => Value;

/**
 * The destination's declared identity, as a ROW KEY — the exact key the INSERT is
 * held to, built by the very rules G15 counts with.
 *
 * Factored out so the gate and the write cannot drift apart: the collision G15
 * reports and the fold G18 applies must be the same question asked of the same
 * component values. A component readable from the row is taken from the row; one
 * the destination declares but this deployment cannot read is taken from its
 * declared `DERIVATIONS` rule — the same `deriveValue` the INSERT calls.
 *
 * `null` means the key is NOT MEASURABLE (a component that is neither readable nor
 * derived), and a null must never be read as "no collision" — G18 refuses to write
 * rather than fold on a key it cannot build.
 */
function identityKeyer(
  l: TableLoad,
  identity: string[],
  derive: Deriver,
): {
  parts: Array<{ label: string; get: (raw: Value[]) => Value }>;
  keyOf: (raw: Value[]) => string;
} | null {
  const parts: Array<{ label: string; get: (raw: Value[]) => Value }> = [];
  for (const col of identity) {
    const c = norm(col);
    const ix = l.names.findIndex((n) => norm(n) === c);
    const served =
      l.unavailable.some((x) => norm(x) === c) || l.noHome.some((x) => norm(x) === c);
    if (ix >= 0 && !served) {
      parts.push({ label: col, get: (raw) => raw[ix] ?? null });
    } else if (DERIVATIONS[`${norm(l.table)}.${c}`]) {
      parts.push({
        label: `${col} (derived)`,
        get: (raw) => {
          const asDict: Dict = {};
          l.names.forEach((n, i) => {
            asDict[n] = raw[i];
          });
          return derive(l.table, col, asDict);
        },
      });
    } else {
      return null;
    }
  }
  return {
    parts,
    keyOf: (raw) => parts.map((p) => JSON.stringify(p.get(raw) ?? null)).join('\u0001'),
  };
}

/** A value the copy measured from the source for a derivation to use. */
interface Measured {
  ledgerId: Value;
  budgetTypeId: Value;
  notes: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const started = Date.now();
  const env = process.env as Record<string, string | undefined>;

  say('══════════════════════════════════════════════════════════════════════');
  say('  COPY  Oracle (ledger)  →  Turso (v2)');
  say('══════════════════════════════════════════════════════════════════════');
  say(`  mode        ${FRESH ? '--fresh (insert-only)' : '--refresh (delete-then-insert)'}${DRY ? ' + --dry-run' : ''}`);
  say(`  cap         ${num(CAP)} row(s) per table`);
  say(`  scope       ${ONLY ? `one table: ${ONLY}` : 'every ledger/EBS object the descriptors name'}`);
  say('');

  // ── Destination ────────────────────────────────────────────────────────────
  //
  // ★ TURSO_* rather than APP_DB_URL, and that is not interchangeable here.
  //   Under DB_MODE=oracle nothing in the app reads TURSO_*, so the app keeps
  //   serving exactly what it served before: TURSO_DATABASE names where a build
  //   LANDS, which is the thing to get right. APP_DB_URL names the app's own
  //   store and deliberately still points at v1.

  const dstUrl = env.TURSO_DATABASE;
  const dstToken = env.TURSO_API_KEY;
  const appStoreUrl = env.APP_DB_URL;

  if (!dstUrl) throw new Error('TURSO_DATABASE is not set — there is no destination to copy into.');
  if (!dstToken) throw new Error('TURSO_API_KEY is not set — the destination needs a token to write.');

  const dstHost = hostOf(dstUrl);
  const appHost = hostOf(appStoreUrl);

  say('—— TARGETS ——');
  say(`  ledger (source)     ${env.ORACLE_USER}@${env.ORACLE_CONNECT_STRING}  schema ${env.ORACLE_SCHEMA ?? '(login default)'}`);
  say(`  destination         ${dstHost}   [TURSO_DATABASE]`);
  say(`  the app's own store ${appHost}   [APP_DB_URL — NOT touched by this script]`);
  say(`  DB_MODE             ${env.DB_MODE ?? '(unset)'}   (stays "oracle" until the flip)`);
  say('');

  // Guards, with the negative controls the app-copy script established.
  if (norm(dstHost) === norm(appHost)) {
    throw new Error(
      `the destination and the app's own store are the SAME host (${dstHost}). This script deletes ` +
        'rows in every table it loads; pointing it at the live app store is not a copy.',
    );
  }
  if (/-v1-/i.test(dstHost) && !ALLOW_V1) {
    throw new Error(
      `TURSO_DATABASE names v1 (${dstHost}). v1 is the live app store holding the only copy of the ` +
        'geocoded vendor sites, and it is the rollback. Pass --allow-v1 only if you truly mean it.',
    );
  }

  const dst = createClient({ url: dstUrl, authToken: dstToken });

  // ── Oracle ─────────────────────────────────────────────────────────────────
  if (env.ORACLE_THICK === '1') oracledb.initOracleClient({ libDir: env.ORACLE_THICK_LIB_DIR });

  // ★ THE DATE MECHANISM, taken from src/db/oracle.ts rather than guessed.
  //
  // A ladder of `fetchAsString` type-lists is the obvious-looking way to get
  // dates out as text, and it DOES NOT WORK — the project's own declaration of
  // this module records why, in two measured facts:
  //   • `fetchAsString` REJECTS `DB_TYPE_DATE` (2011) outright with NJS-021. So a
  //     `[DB_TYPE_DATE, DB_TYPE_TIMESTAMP]` list throws, the catch swallows it,
  //     and the next tier down throws too — every DATE silently arrives as a JS
  //     Date re-interpreted through this machine's time zone, while the run
  //     reports the fallback as if it were a design choice.
  //   • There is no `DATE` alias (`DB_TYPE_DATE` is 2011, `DB_TYPE_TIMESTAMP` is
  //     2012, and they are not interchangeable), and no `DB_TYPE_TIMESTAMP_TZ`.
  // `fetchTypeHandler` is the mechanism that can stringify a DATE, because it is
  // consulted per column instead of being restricted to the `fetchAsString`
  // subset. Both lines are process-wide, so they are set once, here, before any
  // statement that fetches a row.
  oracledb.fetchTypeHandler = (meta) =>
    meta.dbType === oracledb.DB_TYPE_DATE ? { type: oracledb.STRING } : undefined;
  oracledb.fetchAsString = [oracledb.DB_TYPE_TIMESTAMP];
  const dateMode = 'string (fetchTypeHandler → DATE, fetchAsString → TIMESTAMP, as in src/db/oracle.ts)';

  const oraUser = env.ORACLE_USER ?? '';
  const oraPassword = env.ORACLE_PASSWORD ?? '';
  const oraConnectString = env.ORACLE_CONNECT_STRING ?? '';
  if (oraUser === '' || oraConnectString === '') {
    throw new Error('ORACLE_USER and ORACLE_CONNECT_STRING must both be set — there is nothing to read from.');
  }
  const conn = await oracledb.getConnection({
    user: oraUser,
    password: oraPassword,
    connectString: oraConnectString,
  });

  try {
    // ★ The pin is a PLAIN STATEMENT, never a sessionCallback: node-oracledb
    //   invokes a sessionCallback as the third argument of `new Promise` and
    //   never awaits it, so an async callback orphans `done()` and the pool dies
    //   at queueTimeout with NJS-040. DDL takes no binds, so the schema name is
    //   interpolated — and therefore validated first.
    const schema = env.ORACLE_SCHEMA ?? 'APPS';
    if (!/^[A-Z][A-Z0-9_$#]{0,29}$/.test(schema)) throw new Error(`bad schema name: ${schema}`);
    for (const stmt of [
      `ALTER SESSION SET CURRENT_SCHEMA = ${schema}`,
      "ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD'",
      "ALTER SESSION SET NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SS'",
      "ALTER SESSION SET NLS_TIMESTAMP_TZ_FORMAT = 'YYYY-MM-DD HH24:MI:SS TZH:TZM'",
      "ALTER SESSION SET NLS_NUMERIC_CHARACTERS = '.,'",
      'ALTER SESSION SET NLS_SORT = BINARY',
    ]) {
      await conn.execute(stmt);
    }

    // ★ DATE and TIMESTAMP as text. Both switches were set before the connection
    //   was opened (see the Oracle block above); nothing is set here, because a
    //   process-wide setting changed mid-run is exactly how "some tables came
    //   back with dates and some with JS Dates" happens.

    type OraRow = unknown[];
    /** The real module honours `fetchArraySize`; the ambient declaration omits it. */
    interface OraExecOptions {
      outFormat: number;
      maxRows: number;
      fetchArraySize: number;
    }
    const oraRows = async (sql: string, fetchSize = 2_000): Promise<{ rows: OraRow[]; names: string[] }> => {
      const options: OraExecOptions = {
        outFormat: oracledb.OUT_FORMAT_ARRAY,
        // ★ Matches §3.2's baseline. `src/db/oracle.ts:671` never sets this, which
        //   is the whole of the ~4–5x read gap (3,009 rows/s at 100 vs ~15,974 at
        //   1,000–2,000). This script sets its own; it does not change the app.
        fetchArraySize: fetchSize,
        maxRows: 0,
      };
      const r = await conn.execute<OraRow>(sql, [], options);
      const names = (r.metaData ?? []).map((m: { name: string }) => m.name);
      return { rows: (r.rows ?? []) as OraRow[], names };
    };
    /** A single value, read through an alias that is QUOTED. */
    const oraScalar = async (sql: string): Promise<unknown> => {
      const { rows } = await oraRows(sql, 2);
      const first = rows[0];
      return Array.isArray(first) ? first[0] : undefined;
    };

    // ── CONTROLS FIRST (G1 + G2) ─────────────────────────────────────────────
    //
    // ★ A run of only PASSes from an unproven harness is unverified, not clean.
    // ★ And the Oracle positive must use the SAME ADDRESSING as every real read
    //   below: UNQUALIFIED. A control written as `APPS.GL_LEDGERS` qualifies its
    //   own object name, so it passes on a session where all 29 real reads fail
    //   with ORA-00942 — which is exactly what happened once (§3.6).
    // ★ The Turso positive is the destination's own object count, not §9's
    //   historical `104`. A hard-coded baseline becomes a FAILING control on a
    //   database that is merely new, which is worse than no control at all.

    say('—— CONTROLS (a run of only passes is unverified, not clean) ——');
    const dstObjectsNow = await dst.execute(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type IN ('table','view')",
    );
    const dstObjects = Number((dstObjectsNow.rows[0] as Dict).n ?? -1);

    const controls: Array<[string, () => Promise<unknown>, 'must-pass' | 'must-fail']> = [
      ['ledger  positive  unqualified GL_LEDGERS', () => oraScalar('SELECT COUNT(*) AS "n" FROM GL_LEDGERS'), 'must-pass'],
      ['ledger  negative  deliberate syntax error', () => oraScalar('SELECT FROM WHERE (('), 'must-fail'],
      ['ledger  negative  unknown object', () => oraScalar('SELECT 1 AS "n" FROM ZZ_NO_SUCH_OBJECT_XYZ'), 'must-fail'],
      ['app     positive  sqlite_master object count', () => dst.execute('SELECT COUNT(*) AS n FROM sqlite_master'), 'must-pass'],
      ['app     negative  deliberate syntax error', () => dst.execute('SELEC 1 AS n'), 'must-fail'],
      ['app     negative  unknown table', () => dst.execute('SELECT COUNT(*) AS n FROM zz_no_such_table_xyz'), 'must-fail'],
    ];

    let controlsClean = true;
    for (const [label, run, expectation] of controls) {
      let threw: string | null = null;
      try {
        await run();
      } catch (err) {
        threw = (err as Error).message.split('\n')[0] ?? 'unknown error';
      }
      if (expectation === 'must-pass') {
        if (threw === null) ok(label);
        else {
          bad(label, `expected success, got: ${threw}`);
          controlsClean = false;
        }
      } else {
        if (threw !== null) ok(label, threw.slice(0, 72));
        else {
          bad(label, 'expected a refusal and the statement succeeded — the harness is swallowing errors');
          controlsClean = false;
        }
      }
    }
    if (!controlsClean) {
      throw new Error(
        'a control did not behave. Nothing has been written. Fix the harness before trusting any ' +
          'pass below — a control that cannot fail makes every later PASS meaningless.',
      );
    }
    say(`  ·     destination object count (baseline for this run): ${num(dstObjects)}`);
    say(`  ·     Oracle DATE/TIMESTAMP mode: ${dateMode}`);
    say('');

    // ── Work out which tables are in scope, and fill NOT NULL holes ───────────
    //
    // ★ THE DESCRIPTORS EXIST ONLY ONCE THE ROUTER FACTORY HAS RUN.
    //
    // `registeredResources()` returns the very array that `registerResource()`
    // pushes into, and every one of those calls lives inside `registerVendors(api)`,
    // `registerFunding(api)`, `registerChartOfAccounts(api)`, … — all invoked by
    // `apiRouter()`, which is a FACTORY and not a constant. Importing the module
    // therefore registers nothing at all.
    //
    // ★ MEASURED, not imagined: with the import present and no call, this dry run
    //   printed `descriptors registered 0` / `ledger/EBS objects derived 0`. From
    //   an empty descriptor list follows an empty scope, and from an empty scope
    //   follows a copy that reads nothing, writes nothing and reports success — the
    //   worst failure this file can have, because there is no error to notice. The
    //   empty-scope guard below is what caught it. `src/scripts/ledger-scale.ts`
    //   "touches the router the way the server does" for the same reason.
    //
    // The guard is not decoration: the array ACCUMULATES, and `createApi()` treats a
    // path claimed twice as a startup error — so a second call is either a doubled
    // list or a throw, never a harmless no-op.
    if (registeredResources().length === 0) apiRouter();

    const descriptors = registeredResources();
    const columnsOf = new Map<string, string[]>();
    for (const d of descriptors) {
      const t = d.table;
      const seen = columnsOf.get(norm(t)) ?? [];
      for (const c of d.columns) if (!seen.some((s) => norm(s) === norm(c))) seen.push(c);
      columnsOf.set(norm(t), seen);
    }

    // ★ ASKED OF THE CODEBASE, NEVER RESTATED (§2.1). A hand-kept list would be a
    //   second opinion about routing, and this project has been bitten twice by
    //   one drifting from the other.
    const derivedScope = [
      ...new Set(
        descriptors
          .map((d) => d.table)
          .filter((t) => {
            try {
              return storeForTable(t) === 'ledger' && classOfTable(t) === 'EBS';
            } catch {
              return false;
            }
          }),
      ),
    ].sort();

    const inScope = ONLY
      ? derivedScope.filter((t) => norm(t) === norm(ONLY))
      : derivedScope;

    say('—— SCOPE (derived, not listed) ——');
    say(`  descriptors registered        ${num(descriptors.length)}`);
    say(`  ledger/EBS objects derived    ${num(derivedScope.length)}   (§2.1's arithmetic expects 29)`);

    // The objects deliberately left out, named rather than implied.
    const ledgerViews = [
      ...new Set(descriptors.map((d) => d.table).filter((t) => classOfTable(t) === 'DERIVED')),
    ].sort();
    const appObjects = [
      ...new Set(
        descriptors.map((d) => d.table).filter((t) => {
          try {
            return storeForTable(t) === 'app';
          } catch {
            return false;
          }
        }),
      ),
    ].sort();
    say('');
    say('  NOT IN SCOPE, on purpose:');
    say(`    composed reporting views   ${ledgerViews.join(', ') || '(none)'}`);
    say('      → they are VIEWs in the destination, composed by src/db/derived.ts from the base');
    say('        tables this copy loads; copying them would double-write the same facts.');
    say(`    this app\'s own tables      ${appObjects.join(', ') || '(none)'}`);
    say('      → they live in the app store (APP_DB_URL), not the ledger. Untouched here.');
    say('    the four AP_* tables       AP_INVOICES_ALL, AP_INV_LINES,');
    say('        AP_INVOICE_DISTRIBUTIONS_ALL, AP_INVOICE_PAYMENTS_ALL');
    say('      → declared in 00-schema.sql and carrying 5 of the 28 FKs, but they have NO resource');
    say('        descriptor and NO route, so a scope derived from the descriptors omits them. They are');
    say('        neither loaded nor deleted by this run. §2.3 asks for this to be stated; it is.');
    say('');

    if (derivedScope.length === 0) {
      throw new Error(
        'the derived scope is EMPTY — the descriptors named no ledger/EBS object. A copy over an ' +
          'empty scope reads nothing, writes nothing and reports success, so it stops here instead. ' +
          "The usual cause is the router module not being loaded for its side effect (that is what " +
          'calls registerResource for every descriptor) — check the side-effect import at the top ' +
          'of this file.',
      );
    }

    if (inScope.length === 0) {
      throw new Error(
        ONLY === undefined
          ? 'nothing is left in scope after the per-table filters'
          : `no table matched --table=${ONLY}. The in-scope names are: ${derivedScope.join(', ')}`,
      );
    }

    // ★ Measured once, for the two derivations that must reference a real key.
    const measured: Measured = { ledgerId: null, budgetTypeId: null, notes: [] };
    try {
      measured.ledgerId = (await oraScalar('SELECT LEDGER_ID AS "v" FROM GL_LEDGERS WHERE ROWNUM <= 1')) as Value;
    } catch (err) {
      measured.notes.push(`GL_LEDGERS.LEDGER_ID unreadable: ${(err as Error).message.split('\n')[0]}`);
    }
    try {
      measured.budgetTypeId = (await oraScalar(
        'SELECT BUDGET_TYPE_ID AS "v" FROM GL_BUDGET_TYPES WHERE ROWNUM <= 1',
      )) as Value;
    } catch (err) {
      measured.notes.push(`GL_BUDGET_TYPES.BUDGET_TYPE_ID unreadable: ${(err as Error).message.split('\n')[0]}`);
    }

    /** The value a derivation produces for one row, or a sentinel meaning "cannot". */
    function deriveValue(table: string, column: string, row: Dict): Value {
      const key = `${norm(table)}.${norm(column)}`;
      if (key === 'PO_AGENTS.NAME') return row.AGENT_ID === undefined || row.AGENT_ID === null ? null : `Agent ${row.AGENT_ID}`;
      if (key === 'GL_BUDGET_TYPES.BUDGET_TYPE_CODE') return `BT${row.BUDGET_TYPE_ID ?? ''}`;
      if (key === 'GL_BUDGET_TYPES.BUDGET_NAME') return `Budget type ${row.BUDGET_TYPE_ID ?? ''}`;
      if (key === 'GL_BUDGET_VERSIONS.LEDGER_ID') return measured.ledgerId;
      // The live Oracle shape has one GL_BUDGET_TYPES row but no readable ID column.
      // SQLite assigns that single INTEGER PRIMARY KEY row the measured key 1; reuse
      // that key for its children instead of sending NULL into their NOT NULL FK.
      const budgetTypeId = measured.budgetTypeId ?? 1;
      if (key === 'GL_BUDGET_VERSIONS.BUDGET_TYPE_ID') return budgetTypeId;
      if (key === 'GL_BUDGET_ENTITIES.BUDGET_TYPE_ID') return budgetTypeId;
      if (key === 'GL_BUDGET_ENTITIES.BUDGET_ENTITY_NAME') return `Entity ${row.BUDGET_ENTITY_ID ?? ''}`;
      if (key === 'FND_CURRENCIES.NAME') return (row.CURRENCY_CODE as Value) ?? null;
      return null;
    }

    // ── The destination's FK graph, and the READ ORDER it induces ────────────
    //
    // ★ THIS MUST PRECEDE THE READS, AND UNTIL NOW IT DID NOT.
    //
    //   A child's narrowing predicate is an EXISTS against the PARENT'S OWN LOADED
    //   SLICE, so a parent must be read before its children can even be composed.
    //   The FK map used to be built AFTER the read loop (it was only needed by the
    //   G12 gate), which made decision 5 unimplementable in the one place it could
    //   have been implemented. The graph is therefore built once, here, and the
    //   order it induces is reused by the reads, the prints, the inserts and the
    //   deletes — one source of truth, not two that can drift.
    const fks = new Map<string, Array<{ from: string; parent: string; to: string }>>();
    for (const t of inScope) {
      const list = await foreignKeyList(dst, t);
      fks.set(
        norm(t),
        list.map((r) => ({ from: String(r.from), parent: String(r.table), to: String(r.to ?? '') })),
      );
    }
    {
      // Decision 2: GL_BUDGET_ASSIGNMENTS is not LOADED, but --refresh has to
      // delete it before its parent GL_BUDGET_VERSIONS, so its edges are needed.
      const list = await foreignKeyList(dst, 'GL_BUDGET_ASSIGNMENTS');
      fks.set(
        norm('GL_BUDGET_ASSIGNMENTS'),
        list.map((r) => ({ from: String(r.from), parent: String(r.table), to: String(r.to ?? '') })),
      );
    }

    const inScopeSet = new Set(inScope.map(norm));
    const edges = new Map<string, Set<string>>();
    for (const t of inScopeSet) edges.set(t, new Set());
    const edgeList: Array<{ child: string; parent: string; column: string; to: string }> = [];
    for (const [child, list] of fks) {
      if (!inScopeSet.has(child)) continue;
      for (const fk of list) {
        const parent = norm(fk.parent);
        if (!inScopeSet.has(parent)) continue;
        edges.get(child)!.add(parent);
        // `to` is carried because G14 (and the overlap probe) must name the PARENT
        // column, not just the parent table: an FK whose parent column is not
        // projected is "not measurable", which is a different fact from "clean".
        edgeList.push({ child, parent, column: fk.from, to: fk.to });
      }
    }

    // ── The order: a topological sort of the in-scope FK graph ───────────────
    const readOrder: string[] = [];
    {
      const indeg = new Map<string, number>();
      for (const [t, parents] of edges) indeg.set(t, parents.size);
      const queue = [...indeg.entries()].filter(([, n]) => n === 0).map(([t]) => t).sort();
      // ★ DEEP COPY, AND THE SHALLOW ONE WAS A REAL BUG.
      //
      //   `new Map(edges)` copies the MAP, not the SETS — so `parents.delete(t)`
      //   below edited the very sets `edges` holds. By the time the LOAD ORDER
      //   section printed, every set had been drained and all 28 tables reported
      //   "(no in-scope parent)" while the line immediately beneath it said
      //   "21 in-scope FK edge(s) constrain this order". Two adjacent lines
      //   contradicting each other is the tell; the mutation was the cause.
      //
      //   The ORDER itself was always right (the sort only ever *removes* edges),
      //   so this was a report defect and not a correctness one. But the report is
      //   the only evidence a reader has that the order came from the destination's
      //   own DDL, so a report that says "no parents" for everything is worse than
      //   no report: it is a plausible-looking list that refutes its own caption.
      const remaining = new Map<string, Set<string>>();
      for (const [t, parents] of edges) remaining.set(t, new Set(parents));
      while (queue.length > 0) {
        const t = queue.shift()!;
        readOrder.push(t);
        for (const [child, parents] of remaining) {
          if (parents.has(t)) {
            parents.delete(t);
            const n = indeg.get(child)! - 1;
            indeg.set(child, n);
            if (n === 0) queue.push(child);
          }
        }
        remaining.delete(t);
        queue.sort();
      }
      if (readOrder.length !== inScopeSet.size) {
        const stuck = [...inScopeSet].filter((t) => !readOrder.includes(t));
        bad("the destination's FK graph has a cycle among in-scope tables", `unplaced: ${stuck.join(', ')}`);
        throw new Error('cannot order the load; a cycle means no order is FK-safe.');
      }
    }
    const scopeName = new Map(inScope.map((t) => [norm(t), t]));

    // ── Per table: resolve → narrow → key → read ─────────────────────────────
    const loads: TableLoad[] = [];
    const loaded = new Map<string, TableLoad>();
    const notReadable: Array<{ table: string; reason: string }> = [];
    const skipped: Array<{ table: string; reason: string }> = [];

    say('—— PER TABLE: resolve → narrow → key → read ——');

    for (const tnorm of readOrder) {
      const table = scopeName.get(tnorm)!;
      // Decision 2: excluded, with the reason stated.
      if (norm(table) === 'GL_BUDGET_ASSIGNMENTS') {
        skipped.push({
          table,
          reason:
            'its destination PRIMARY KEY is exactly the three columns this deployment cannot read ' +
            '(BUDGET_VERSION_ID, RANGE_FROM, RANGE_TO). SQLite treats NULLs as DISTINCT in a unique ' +
            'index, so it would load ~100,000 indistinguishable rows with NO error — corruption that ' +
            'looks like data. Excluded by decision; still deleted by --refresh so the seed rows there ' +
            "do not block the FK-safe delete of its parent GL_BUDGET_VERSIONS.",
        });
        continue;
      }

      const columns = columnsOf.get(norm(table)) ?? [];
      if (columns.length === 0) {
        skipped.push({ table, reason: 'no descriptor names a column for it' });
        continue;
      }

      const plan = await ledgerPlan({ table, columns });
      if (!plan.ok) {
        notReadable.push({ table, reason: plan.reason });
        continue;
      }

      const dest = await destinationIdentity(dst, table);

      // ★ TWO DIFFERENT MEASUREMENTS, AND ONE WORD HAD BEEN HIDING THEM.
      //
      //   (a) NO HOME — a column the destination declares that the descriptor's own
      //       list never names. §4.1 measured this at 0, and the user's "confirm the
      //       schemas match columns with no home: 0" check is exactly this number.
      //   (b) NO READABLE SOURCE — a column the descriptor DOES name, which this
      //       deployment cannot read. `ledger-shape.resolve()` emits it INSIDE the
      //       projection as `NULL AS "COL"` (:290), so it sits in the descriptor's
      //       list and is therefore INVISIBLE to (a). §4.1 measured this at 27 across
      //       10 tables.
      //
      // The old code computed (a), called it `unfilled`, and drove BOTH the G7
      // disclosure and the G4 NOT NULL derivations from it. Because (a) is 0 by
      // construction, G7 printed "0 declared column(s) across 0 table(s)" — never
      // disclosing the 24 real holes — and G4's loop body examined an empty set, so
      // `fillIdx` stayed empty and `deriveValue()` was NEVER CALLED for any of the
      // NOT NULL columns. A dry run could not reveal that: `deriveValue()` returning
      // the wrong thing and never being called look identical from outside. The write
      // would have died on the NOT NULL constraint, starting with FND_CURRENCIES.
      //
      // ★ MEASURED before the fix, with tmp-copy-holes.ts: no-home 0,
      //   served-as-null 24 across 9 tables, of which 9 are NOT NULL with no
      //   destination default. §4.1's "8 NOT NULL" is short by one — the tenth is
      //   PA_BUDGET_LINES.LINE_NUM, which §4.4 had already called "the worse case"
      //   and never resolved. It is handled below, by the fact that its table is empty.
      const projected = new Set(columns.map(norm));
      const noSource = new Set(plan.unavailable.map(norm));
      const noHome = dest.declared.filter((c) => !projected.has(norm(c)));
      const servedNull = dest.declared.filter((c) => noSource.has(norm(c)));
      const unfilled = [...new Set([...noHome, ...servedNull])];
      const notNullUnfilled = unfilled.filter((c) => dest.notNull.get(norm(c))?.notNull === true);

      // ── The cap key: the destination's identity, in projection order ───────
      //
      // ★ A column served as NULL is NOT an identity component. `projected` alone
      //   would let a partly-unreadable PRIMARY KEY be announced as the slice key
      //   and then used as `ORDER BY "ID", NULL` — a key that orders nothing while
      //   the report claims it ordered the slice. Require a readable source too.
      const have = (c: string): boolean => projected.has(norm(c)) && !noSource.has(norm(c));
      let keyColumns: string[] = [];
      let keySource = '';
      if (dest.pk.length > 0 && dest.pk.every(have)) {
        keyColumns = dest.pk;
        keySource = 'destination PRIMARY KEY';
      } else if (dest.unique.length > 0 && dest.unique.every(have)) {
        keyColumns = dest.unique;
        keySource = 'destination UNIQUE index';
      } else if (dest.pk.length > 0 || dest.unique.length > 0) {
        keySource = 'identity exists but is not fully projected → ROWID';
      } else {
        keySource = 'destination declares no identity → ROWID';
      }

      const projection = columns.map(quote).join(', ');
      const plainObject = !plan.from.includes('(') && plan.unavailable.length === 0;

      // ── DECISION 5, IN THE ONLY FORM THAT IS IMPLEMENTABLE ────────────────
      //
      // ★ THE LITERAL FORM OF THE DECISION WAS MEASURED IMPOSSIBLE, and the
      //   measurement is why the first real run refused to write anything. It said
      //   "take the 100,000 CODE_COMBINATION_IDs the children actually reference".
      //   Measured on the live source:
      //
      //     GL_CODE_COMBINATIONS rows available            1,300,594
      //     GL_CODE_COMBINATIONS distinct ids              1,300,594  (it is the PK,
      //                                                     so DISTINCT cannot shrink it)
      //     the cap                                          100,000  (92.3 % removed)
      //     GL_BALANCES distinct CODE_COMBINATION_IDs       616,235  ← 6.2× the cap
      //
      //   616,235 referenced keys cannot be covered by 100,000 parent rows. No
      //   ordering of the parent fixes that: it is arithmetic, not a strategy.
      //
      // WHAT §3.9 ACTUALLY MEANS — "narrowing its slice to the parent's keys" — is
      // the other direction: narrow the CHILD. Only child rows whose FK value lies
      // in the parent's OWN loaded slice are read, so the cap applies to SURVIVING
      // rows and the FK holds by construction instead of by luck.
      //
      // ★ AND IT COSTS NOTHING, MEASURED BEFORE IT WAS WRITTEN. With the parent's
      //   100,000-row slice in place (tmp-cc-narrow.ts):
      //     GL_BALANCES            157,150,828 rows / 616,235 ids → kept 100,000
      //     GL_JE_LINES             33,155,055 rows / 615,889 ids → kept 100,000
      //     PO_DISTRIBUTIONS_ALL     1,159,988 rows /  23,183 ids → kept 100,000
      //   Every one is still AT the cap. The cap was already choosing WHICH rows;
      //   the parent now chooses them instead. Nothing is lost that was not already
      //   being discarded — the only change is that what remains is FK-legal.
      //
      // ★ THE PREDICATE WRAPS THE PARENT'S FINAL `readBody` — the parent's own
      //   narrowing AND the ORDER BY the parent ACTUALLY used, including a ROWID
      //   fallback that is only decided at read time. Re-deriving the parent's slice
      //   here would silently point a grandchild at rows the parent had dropped.
      //   Reads run in `readOrder`, so a parent is always already in `loaded`.
      //
      // ★ A NULL FK IS KEPT. G12 counts a null FK as legal (it is — the constraint
      //   permits NULL), so the predicate must not drop those rows or narrowing
      //   would be *stricter* than the constraint it exists to satisfy.
      //
      // ★ WHETHER THE FROM EXPRESSION ALREADY CARRIES THE `src` ALIAS. `inlineView()`
      //   in ledger-shape.ts aliases its subquery `src`; a plain quoted table has no
      //   alias. Appending a second one unconditionally would emit `(…) src src`, and
      //   wrapping a plain table in parens to force one is not Oracle grammar. So the
      //   alias is appended only when absent — and the qualifier is `src.` either way.
      const alreadyAliased = plan.from.trimEnd().endsWith(') src');
      const narrowTerms: string[] = [];
      const narrowed: TableLoad['narrowed'] = [];
      const narrowSkipped: TableLoad['narrowSkipped'] = [];
      {
        const groups = new Map<string, Array<{ to: string; from: string }>>();
        for (const e of edgeList) {
          if (e.child !== tnorm) continue;
          const p = loaded.get(e.parent);
          if (p === undefined) {
            narrowSkipped.push({
              parent: e.parent,
              column: e.column,
              why: 'the parent was not loaded, so its slice is not a constraint this run can meet',
            });
            continue;
          }
          if (!columns.some((c) => norm(c) === norm(e.column))) {
            narrowSkipped.push({
              parent: p.table,
              column: e.column,
              why: "this table's projection does not name the FK column",
            });
            continue;
          }
          if (e.to.length === 0 || !p.names.some((n) => norm(n) === norm(e.to))) {
            narrowSkipped.push({
              parent: p.table,
              column: e.column,
              why: `the destination FK names "${e.to}" as the parent key, which the parent's read does not return`,
            });
            continue;
          }
          const g = groups.get(e.parent) ?? [];
          g.push({ to: e.to, from: e.column });
          groups.set(e.parent, g);
        }
        // ★ THE OUTER SIDE MUST BE QUALIFIED, AND THAT IS NOT COSMETIC.
        //
        //   Name resolution inside a subquery runs INWARD first. So in
        //       WHERE EXISTS (SELECT 1 FROM (…) p0 WHERE p0."CCID" = "CCID")
        //   the bare `"CCID"` binds to *p0*'s column, not the outer table's — the
        //   predicate collapses to `p0."CCID" = p0."CCID"`, always true, and every
        //   child row survives: a narrowing that silently narrows nothing, which is
        //   exactly the failure this whole edit exists to prevent.
        //
        // ★ `inlineView()` in ledger-shape.ts ALREADY aliases its subquery `src`, so
        //   a plain table has no alias and an inline view has one. Appending a second
        //   alias unconditionally would emit `(…) src src`; and wrapping a plain
        //   quoted table in parens to force one is not Oracle grammar. So the alias
        //   is added only when absent, and the qualifier is `src.` either way.
        let aliasN = 0;
        for (const [pn, pairs] of groups) {
          const p = loaded.get(pn)!;
          // ★ `p0`, `p1`… and NOT `src`: when the outer FROM is an inline view, an
          //   inner alias named `src` would shadow the very qualifier the predicate
          //   is correlating to.
          const alias = `p${aliasN++}`;
          // ★ CAP, not CAP + 1: the parent's read asks for one row more than it
          //   keeps (that is how `truncated` is detected), so a slice built from
          //   the read SQL would expose a row the parent did NOT load.
          const sliceSql = `SELECT * FROM (${p.readBody}) WHERE ROWNUM <= ${CAP}`;
          const join = pairs.map((pr) => `${alias}.${quote(pr.to)} = src.${quote(pr.from)}`).join(' AND ');
          const nulls = pairs.map((pr) => `src.${quote(pr.from)} IS NULL`).join(' OR ');
          narrowTerms.push(`((${nulls}) OR EXISTS (SELECT 1 FROM (${sliceSql}) ${alias} WHERE ${join}))`);
          narrowed.push({
            parent: p.table,
            column: pairs.map((pr) => pr.from).join(' + '),
            parentColumn: pairs.map((pr) => pr.to).join(' + '),
            sliceSql,
          });
        }
      }
      const narrowWhere = narrowTerms.length === 0 ? '' : ` WHERE ${narrowTerms.join(' AND ')}`;
      // The outer relation is named `src` whenever a predicate needs to reach it.
      const fromExpr = narrowWhere === '' || alreadyAliased ? plan.from : `${plan.from} src`;

      // ★ The ROWNUM wrap is REQUIRED: `WHERE ROWNUM <= n` applies BEFORE the sort,
      //   so the flat form returns an arbitrary n rows and then orders them. The
      //   wrap also keeps the statement portable where FETCH FIRST would not.
      const body = (orderBy: string): string =>
        `SELECT ${projection} FROM ${fromExpr}${narrowWhere} ORDER BY ${orderBy}`;
      const capped = (orderBy: string): string =>
        `SELECT * FROM (${body(orderBy)}) WHERE ROWNUM <= ${CAP + 1}`;

      let readSql: string;
      let readBody: string;
      let read: { rows: OraRowLocal[]; names: string[] };
      type OraRowLocal = unknown[];

      if (keyColumns.length > 0) {
        readBody = body(keyColumns.map(quote).join(', '));
        readSql = capped(keyColumns.map(quote).join(', '));
        read = await oraRows(readSql);
      } else if (plainObject) {
        readBody = body('ROWID');
        readSql = capped('ROWID');
        try {
          read = await oraRows(readSql);
        } catch (err) {
          // ORA-01445 — ROWID cannot be selected from a view with joins. Fall back
          // to a deterministic full-column order rather than answering a different
          // question.
          const fallbackOrder = columns.map(quote).join(', ');
          readBody = body(fallbackOrder);
          const fallback = capped(fallbackOrder);
          const why = ((err as Error).message.split('\n')[0] ?? '').slice(0, 60);
          info(`${table}: ROWID refused (${why}) → ordering by all projected columns`);
          readSql = fallback;
          keySource += ' → ROWID refused, all columns used';
          read = await oraRows(fallback);
        }
      } else {
        // An inline view: ROWID is not available, so order by every projected
        // column. Deterministic, if not meaningful.
        readBody = body(columns.map(quote).join(', '));
        readSql = capped(columns.map(quote).join(', '));
        keySource += ' → inline view has no ROWID, all columns used';
        read = await oraRows(readSql);
      }

      const truncated = read.rows.length > CAP;
      const rows = truncated ? read.rows.slice(0, CAP) : read.rows;

      const entry: TableLoad = {
        table,
        columns,
        from: plan.from,
        unavailable: [...plan.unavailable],
        noHome,
        unfilled,
        notNullUnfilled,
        keyColumns,
        keySource,
        readBody,
        readSql,
        narrowed,
        narrowSkipped,
        rows: rows as Value[][],
        names: read.names,
        truncated,
        folded: 0,
        readMs: 0,
        derived: [],
      };
      loads.push(entry);
      // ★ Registered BEFORE the next table is composed: the next table's narrowing
      //   predicate wraps this one's `readBody`, so this map is the mechanism, not
      //   a lookup convenience.
      loaded.set(tnorm, entry);
    }

    say(`  read ${num(loads.length)} of ${num(inScope.length)} in-scope table(s)`);

    // ── Decision 5, reported: what each narrowed read was constrained to ─────
    const narrowedLoads = loads.filter((l) => l.narrowed.length > 0);
    if (narrowedLoads.length > 0) {
      say('');
      say('—— NARROWING (decision 5: the child slice is intersected with the parent\'s) ——');
      for (const l of narrowedLoads) {
        for (const n of l.narrowed) {
          say(`  ${l.table.padEnd(26)}${n.column} ⊆ ${n.parent}.${n.parentColumn}`);
        }
      }
      const skippedEdges = loads.flatMap((l) => l.narrowSkipped.map((s) => ({ table: l.table, ...s })));
      if (skippedEdges.length > 0) {
        say('  not narrowed, and why (an unstated skip is how this would go quiet):');
        for (const s of skippedEdges) say(`    ${s.table}.${s.column} → ${s.parent} — ${s.why}`);
      }
    }
    if (notReadable.length > 0) {
      say('');
      say('  could not be resolved (not copied, and NOT silently):');
      for (const t of notReadable) say(`    ${t.table} — ${t.reason}`);
    }
    if (skipped.length > 0) {
      say('');
      say('  deliberately left out of the LOAD:');
      for (const t of skipped) say(`    ${t.table} — ${t.reason}`);
    }
    say('');

    // ── G9: the slice key, per table (the §5.2 trap) ─────────────────────────
    say('—— ★ THE SLICE KEY, PER TABLE (what the cap actually ordered by) ——');
    {
      const grouped = new Map<string, string[]>();
      for (const l of loads) {
        const label = l.keyColumns.length > 0 ? `ORDER BY ${l.keyColumns.map(quote).join(', ')}` : l.keySource;
        const bucket = grouped.get(label) ?? [];
        bucket.push(l.table);
        grouped.set(label, bucket);
      }
      for (const [label, tables] of grouped) {
        say(`  ${label}`);
        say(`      ${tables.length} table(s): ${tables.join(', ')}`);
      }
    }
    say('');

    // ── G7 + G4: declare every hole; refuse a NOT NULL hole with no derivation ─
    say('—— ★ DECLARED HOLES (a NULL nobody declared reads like absent data) ——');
    {
      let nullCount = 0;
      let noHomeCount = 0;
      for (const l of loads) {
        if (l.unfilled.length === 0) continue;
        nullCount += l.unfilled.length;
        noHomeCount += l.noHome.length;
        say(`  ${l.table}: ${l.unfilled.length} column(s) reach an INSERT with no real value`);
        say(`      ${l.unfilled.join(', ')}`);
        // ★ The two measurements, kept apart and named, because collapsed into one
        //   number they read as 0 for two consecutive runs.
        if (l.noHome.length > 0) {
          say(`      (no home in the destination's column list: ${l.noHome.join(', ')})`);
        }
        if (l.unavailable.length > 0) {
          say(`      (no readable source on this deployment: ${l.unavailable.join(', ')})`);
        }
      }
      say(`  ── ${num(nullCount)} column(s) across ${num(loads.filter((l) => l.unfilled.length > 0).length)} table(s)`);
      say(`     of which ${num(noHomeCount)} have no home in the destination's column list, and`);
      say(`     ${num(nullCount - noHomeCount)} have a name but no readable source (§4.1's "27 unfilled")`);
    }
    say('');

    // ── G4: NOT NULL columns the source cannot supply ────────────────────────
    say('—— ★ NOT NULL COLUMNS WITH NO READABLE SOURCE (these break the INSERT) ——');
    {
      const breaks = loads.filter((l) => l.notNullUnfilled.length > 0);
      if (breaks.length === 0) {
        ok('G4 no unfilled NOT NULL column reaches an INSERT');
      } else {
        for (const l of breaks) {
          for (const col of l.notNullUnfilled) {
            const key = `${norm(l.table)}.${norm(col)}`;
            const rule = DERIVATIONS[key];
            const dflt = (await destinationIdentity(dst, l.table)).notNull.get(norm(col))?.dflt ?? null;
            if (rule) {
              info(`${l.table}.${col}`, `DERIVED as ${rule.rule}`);
              say(`        why: ${rule.reason}`);
            } else if (dflt !== null) {
              info(`${l.table}.${col}`, `DERIVED from the destination's own declared default ${dflt}`);
            } else if (l.rows.length === 0) {
              // ★ A table with no rows is never INSERTed, so an unfillable NOT NULL
              //   column in it is a fact to state, not a failure to raise.
              //
              // MEASURED: PA_BUDGET_LINES.LINE_NUM is NOT NULL, unreadable, and has
              // neither a derivation nor a default — and PA_BUDGET_LINES holds 0 rows
              // in this deployment (as do PA_BUDGET_VERSIONS, PA_PROJECTS_ALL and
              // PA_TASKS). Failing the run over a row that does not exist would be a
              // false alarm; staying silent would hide a real breakage the day the
              // source starts populating the table. So it is stated, and the insert
              // half refuses loudly if rows ever appear.
              info(
                `${l.table}.${col}`,
                'NOT NULL and unreadable — but this table has 0 rows, so no INSERT is attempted',
              );
              say('        why: nothing is written, so no value is needed. Should the source ever');
              say('             return rows here, this becomes a hard failure on purpose.');
            } else {
              bad(
                `G4 ${l.table}.${col} is NOT NULL, unreadable, and has neither a derivation nor a default`,
                'the load of this table cannot succeed — add a rule to DERIVATIONS naming why, or exclude the table',
              );
            }
          }
        }
      }
    }
    say('');

    // ── G15: THE DESTINATION'S DECLARED IDENTITY IS UNIQUE IN THE SOURCE SLICE ──
    //
    // ★ THE FAILURE THIS EXISTS TO CATCH, MEASURED ON THE FIRST REAL WRITE:
    //
    //     SQLITE_CONSTRAINT: UNIQUE constraint failed:
    //       FND_FLEX_VALUES.FLEX_VALUE_SET_ID, FND_FLEX_VALUES.FLEX_VALUE
    //
    //   Oracle's FND_FLEX_VALUES holds 41,877 rows but only 41,727 distinct
    //   (FLEX_VALUE_SET_ID, FLEX_VALUE) pairs — 150 collide — and that pair is the
    //   destination's PRIMARY KEY. So the destination's model of IDENTITY is
    //   STRICTER THAN THE SOURCE'S DATA, and no manner of copying can satisfy it.
    //
    //   Nothing upstream said so. G12 checks FOREIGN KEYS; the cap key is chosen
    //   for ORDERING, not uniqueness; and the UNIQUE index the INSERT is actually
    //   held to was never once compared against the source. The only instrument
    //   that could report this was the INSERT itself — which is to say, after the
    //   DELETE half had already committed and the destination had been emptied.
    //
    // ★ THE SECOND JOB IS TO ENUMERATE ALL OF THEM AT ONCE. A real run aborts at
    //   the FIRST collision, so learning them one paid run apiece is precisely how
    //   a copy becomes a sequence of half-written attempts. This gate runs in a
    //   DRY RUN, where the whole list costs nothing but the read.
    //
    // A component that is readable is taken from the row. One the destination
    // declares but this deployment cannot read is taken from its declared
    // derivation — the SAME `deriveValue` the INSERT calls, so the gate and the
    // write cannot drift apart. A component that is neither is reported `n/a`,
    // the honest verdict G12 also uses, rather than being passed over in silence.
    say('—— G15: THE DESTINATION\'S DECLARED IDENTITY IS UNIQUE IN THE SOURCE SLICE ——');
    {
      let g15Checked = 0;
      let g15Excess = 0;
      let g15Unmeasurable = 0;
      const g15Offenders: string[] = [];

      // The counting routine, factored so the CONTROL below exercises the very code
      // that produces every PASS — not a lookalike.
      const countCollisions = (
        rows: Value[][],
        keyOf: (raw: Value[]) => string,
      ): { distinct: number; excess: number; worst: string } => {
        const seen = new Map<string, number>();
        for (const raw of rows) {
          const k = keyOf(raw);
          seen.set(k, (seen.get(k) ?? 0) + 1);
        }
        let excess = 0;
        for (const n of seen.values()) if (n > 1) excess += n - 1;
        const worst = [...seen.entries()]
          .filter(([, n]) => n > 1)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3)
          .map(([k, n]) => `${k.replace(/\u0001/g, ' | ')} x${n}`)
          .join(';  ');
        return { distinct: seen.size, excess, worst };
      };

      // ★ THE CONTROL, RUN FIRST. A gate that reports 0 collisions is worthless
      //   unless it is demonstrably able to report a non-zero one. Collapse the key
      //   to a CONSTANT and the identical routine must count every row but one as a
      //   collision. If it does not, the detector is blind and every PASS below it
      //   means nothing.
      {
        const probe = loads.find((l) => l.rows.length > 1);
        if (!probe) {
          info('G15 control', 'no table has more than 1 row — no detection control is possible this run');
        } else {
          const ctl = countCollisions(probe.rows, () => 'CONST');
          const want = probe.rows.length - 1;
          if (ctl.excess === want) {
            ok('G15 control: the counter detects a collision', `constant key on ${probe.table} → ${num(ctl.excess)} excess row(s), as expected`);
          } else {
            bad('G15 control: the counter detects a collision', `expected ${num(want)} excess, got ${num(ctl.excess)} — every 0 below is unverified`);
          }
        }
      }

      for (const l of loads) {
        if (l.rows.length === 0) continue;
        const gDest = await destinationIdentity(dst, l.table);
        // The identity the INSERT will actually be held to: the PRIMARY KEY, else a UNIQUE index.
        const identity = gDest.pk.length > 0 ? gDest.pk : gDest.unique;
        if (identity.length === 0) {
          g15Unmeasurable += 1;
          say(`  n/a   ${l.table.padEnd(26)}the destination declares no PK or UNIQUE index`);
          continue;
        }

        // ★ THE KEY IS BUILT BY `identityKeyer` — the SAME function G18 folds with.
        //   Inlining this loop is what let "a collision was reported" and "a fold was
        //   applied" become two separately-written answers to one question.
        const keyer = identityKeyer(l, identity, deriveValue);
        if (!keyer) {
          g15Unmeasurable += 1;
          say(`  n/a   ${l.table.padEnd(26)}identity ${identity.join(' + ')} — a component is neither readable nor derived`);
          continue;
        }

        const res = countCollisions(l.rows, keyer.keyOf);
        g15Checked += 1;
        const label = keyer.parts.map((p) => p.label).join(' + ');
        // ★ READ ONCE, BEFORE THE BRANCH — `noUncheckedIndexedAccess` types a second
        //   lookup as `CollisionPolicy | undefined` however recently the first one was
        //   guarded, and a `!` there would be asserting a fact about a lookup the
        //   branch no longer uses. One read, one value, one test.
        const pol = IDENTITY_POLICY[norm(l.table)];
        if (res.excess === 0) {
          ok(`G15 ${l.table}`, `${label} is unique — ${num(l.rows.length)} row(s), ${num(res.distinct)} distinct`);
        } else if (pol) {
          // ★ THE POLICY IS THE DECISION, and it is reported as a NUMBER so a fold can
          //   never be mistaken for a clean table. G18 then has to actually APPLY it in
          //   the write path — that application is the part that was missing when this
          //   run died mid-INSERT after the DELETE half had committed.
          ok(
            `G15 ${l.table}`,
            `${num(res.excess)} row(s) collide on ${label} — POLICY ${pol.mode} (keep ${pol.keep}): ` +
              `${num(res.distinct)} row(s) survive, ${num(res.excess)} will be folded. Worst: ${res.worst}`,
          );
        } else {
          g15Excess += res.excess;
          g15Offenders.push(`${l.table} (${num(res.excess)})`);
          bad(
            `G15 ${l.table}`,
            `${num(res.excess)} row(s) collide on ${label} — ${num(l.rows.length)} rows, only ${num(res.distinct)} distinct. Worst: ${res.worst}`,
          );
        }
      }
      say(`  ── ${num(g15Checked)} table(s) measurable — ${num(g15Excess)} undeclared colliding row(s) across ${num(g15Offenders.length)} table(s); ${num(g15Unmeasurable)} not measurable`);
      const policiedTables = loads.filter((l) => IDENTITY_POLICY[norm(l.table)]).map((l) => l.table);
      if (policiedTables.length > 0) {
        say(`  ── POLICY declared for ${num(policiedTables.length)} table(s): ${policiedTables.join(', ')}`);
        say('     G18 below applies it to the rows the INSERT uses, BEFORE the delete half.');
      }
      if (g15Offenders.length > 0) {
        say('     ★ These rows CANNOT be inserted: the destination\'s PRIMARY KEY is stricter than');
        say('       the source data, so the collision is a fact about the SCHEMA, not a bad row.');
        say('       The policy is per table and must be deliberate — DEDUPE and declare how many');
        say('       rows were folded, or EXCLUDE the table and declare why — never left to be');
        say('       discovered by a failed INSERT after the DELETE half has committed.');
        say('       ★ A table with NO entry in IDENTITY_POLICY still stops the run before any write.');
      }
    }
    say('');

    // ── G8: FND_FLEX_VALUES must either load or be reported ──────────────────
    {
      const ffv = loads.find((l) => norm(l.table) === 'FND_FLEX_VALUES');
      const missed = notReadable.find((t) => norm(t.table) === 'FND_FLEX_VALUES');
      if (ffv) ok('G8 FND_FLEX_VALUES resolved and will load', `${num(ffv.rows.length)} row(s)`);
      else if (missed) info('G8 FND_FLEX_VALUES is NOT copied', missed.reason);
      else info('G8 FND_FLEX_VALUES is not in scope');
    }

    if (failed > 0 && !DRY) {
      throw new Error(`${failed} gate(s) failed before any write. The destination is untouched.`);
    }

    // ── G18: THE DECLARED IDENTITY POLICY IS APPLIED — BEFORE ANY WRITE ───────
    //
    // ★ WHY HERE AND NOT IN THE INSERT. The delete half is one committed
    //   transaction; the insert half is not. So a collision the INSERT discovers
    //   leaves the destination EMPTIED and only partly refilled — MEASURED on the
    //   first real write: 10,182 rows removed, `FND_CURRENCIES` 266 rows restored,
    //   and everything after it never ran.
    //
    //   G15 already knows that collision from the READ, in a dry run, for free. So
    //   the fold happens HERE: after every gate, before the DELETE. `--refresh` can
    //   no longer be interrupted by something the run already knew.
    //
    // ★ IT REFUSES RATHER THAN GUESSES. If a declared policy's key cannot be built
    //   (a component neither readable nor derivable), this THROWS — still before the
    //   delete half. Folding on an unmeasurable key would silently keep the wrong
    //   row, which is the failure mode the whole gate set exists to prevent.
    say('—— G18: THE DECLARED IDENTITY POLICY IS APPLIED (dedupe, before the DELETE) ——');
    {
      const applied = new Set<string>();
      let foldedTotal = 0;
      for (const l of loads) {
        const pol = IDENTITY_POLICY[norm(l.table)];
        if (!pol) continue;
        applied.add(norm(l.table));

        const gDest = await destinationIdentity(dst, l.table);
        const identity = gDest.pk.length > 0 ? gDest.pk : gDest.unique;
        const keyer = identity.length > 0 ? identityKeyer(l, identity, deriveValue) : null;
        if (!keyer) {
          throw new Error(
            `G18 ${l.table}: the identity policy is declared but the destination's identity ` +
              `(${identity.join(' + ') || 'none declared'}) is not measurable on the source slice, so the ` +
              'fold cannot be applied. Refusing to write — the destination is untouched.',
          );
        }

        const before = l.rows.length;
        const seen = new Set<string>();
        const kept: Value[][] = [];
        for (const raw of l.rows) {
          const k = keyer.keyOf(raw);
          if (seen.has(k)) continue;
          seen.add(k);
          kept.push(raw);
        }
        l.rows = kept;
        l.folded = before - kept.length;
        foldedTotal += l.folded;

        const on = keyer.parts.map((p) => p.label).join(' + ');
        ok(
          `G18 ${l.table} ${pol.mode} applied`,
          `${num(before)} read row(s) → ${num(kept.length)} distinct on ${on} — ${num(l.folded)} row(s) folded, keep ${pol.keep}`,
        );
        say(`        policy: ${pol.reason}`);
      }
      for (const key of Object.keys(IDENTITY_POLICY)) {
        if (!applied.has(norm(key))) {
          info(
            `IDENTITY_POLICY names ${key}`,
            'not in scope this run — the entry did not apply (a rename would show up here, not silently)',
          );
        }
      }
      if (applied.size === 0) info('G18 no identity policy applied', 'no in-scope table declares one');
      else say(`  ── ${num(applied.size)} table(s) policied — ${num(foldedTotal)} row(s) folded in total`);
    }
    say('');

    // ── THE LOAD ORDER, PRINTED — AND IT IS THE ORDER THE READS ALREADY USED ──
    //
    // ★ This used to be computed HERE, after the reads, from the set of tables that
    //   had been read. It is computed BEFORE the reads now, because a child's
    //   narrowing predicate has to wrap its parent's read SQL. So this prints the
    //   order that was actually used rather than recomputing a second one that
    //   merely ought to agree with it — which is how two sources of truth start.
    const scopeSet = new Set(loads.map((l) => norm(l.table)));
    const loadOrder = readOrder.filter((t) => scopeSet.has(t));
    const byNorm = new Map(loads.map((l) => [norm(l.table), l]));
    // The subset of edges whose BOTH ends were loaded — the only ones G12 can
    // measure, and the only ones the insert and delete order are constrained by.
    const loadEdges = edgeList.filter((e) => scopeSet.has(e.child) && scopeSet.has(e.parent));

    say('—— LOAD ORDER (from the destination\'s own DDL) ——');
    for (const t of loadOrder) {
      const parents = [...(edges.get(t) ?? [])].filter((p) => scopeSet.has(p));
      const rel = parents.length > 0 ? `  →  ${parents.join(', ')}` : '  (no in-scope parent)';
      say(`  ${byNorm.get(t)!.table.padEnd(26)}${rel}`);
    }
    say(`  ── ${num(loadEdges.length)} in-scope FK edge(s) constrain this order`);
    say('');

    // ── G12: FK overlap against the DESTINATION's parent, with a detector ────
    //
    // ★ THE GRAPH IS READ FROM THE DDL ACTUALLY APPLIED, NOT FROM THE FILE THAT WAS
    //   ASKED FOR. The two can differ — a table in the file may not be in the
    //   database — and the destination is the only authority on its constraints.
    //   It is BUILT above, before the reads, because the narrowing predicate needs
    //   it; this is where it is CHECKED.
    const keySetOf = (l: TableLoad, i: number): Set<string> => {
      const out = new Set<string>();
      for (const row of l.rows) {
        const v = row[i];
        out.add(v === null || v === undefined ? '\u0000NULL' : String(v));
      }
      return out;
    };
    const indexOf = (l: TableLoad, column: string): number =>
      l.names.findIndex((n) => norm(n) === norm(column));

    const fkProblems: string[] = [];
    let fkMeasured = 0;
    let fkVerified = 0;
    say('—— G12: FK OVERLAP, child slice → THE DESTINATION\'S parent ——');
    say('   (measured against the NARROWED child slice, so a 0 here is structural)');
    for (const e of loadEdges) {
      const child = byNorm.get(e.child)!;
      const parent = byNorm.get(e.parent)!;
      const ci = indexOf(child, e.column);
      const pi = indexOf(parent, e.to.length > 0 ? e.to : '');
      if (ci < 0 || pi < 0) {
        info(`${child.table}.${e.column} → ${parent.table}`, 'column not projected on both sides — not measurable here');
        continue;
      }
      fkMeasured += 1;
      const have = keySetOf(parent, pi);
      const used = keySetOf(child, ci);
      let orphans = 0;
      for (const v of used) if (v !== '\u0000NULL' && !have.has(v)) orphans++;

      // ★ The detector control: the SAME check against a parent truncated to one
      //   value. If the child's keys are all inside a one-value parent, the check
      //   cannot discriminate and a zero would mean nothing.
      const control = new Set<string>([parent.rows[0]?.[pi] === undefined ? '\u0000NULL' : String(parent.rows[0][pi])]);
      let controlOrphans = 0;
      for (const v of used) if (v !== '\u0000NULL' && !control.has(v)) controlOrphans++;
      const discriminates = controlOrphans > 0;
      if (discriminates) fkVerified += 1;

      if (orphans === 0) {
        ok(
          `G12 ${child.table}.${e.column} → ${parent.table} — 0 orphan(s)`,
          discriminates
            ? `detector fired (truncated parent → ${num(controlOrphans)}) so the 0 means something`
            : '★ detector did NOT fire — the 0 is unverified',
        );
      } else {
        const sample = [...used].filter((v) => v !== '\u0000NULL' && !have.has(v)).slice(0, 3);
        bad(
          `G12 ${child.table}.${e.column} → ${parent.table} — ${num(orphans)} orphan(s)`,
          `e.g. ${sample.join(', ')} — the FK will REJECT these rows`,
        );
        fkProblems.push(`${child.table}.${e.column} → ${parent.table}: ${num(orphans)} orphan(s)`);
      }
    }
    // ★ The control's own control: a run in which NO detector fired is a run whose
    //   zeros are all unverified, and reporting "19 passed" for that would be the
    //   exact false-green this project keeps finding. State the split.
    say(
      `  ── ${num(fkMeasured)} edge(s) measurable — of those, ${num(fkVerified)} proved the check ` +
        `discriminates and ${num(fkMeasured - fkVerified)} did NOT (their 0 is unverified)`,
    );
    say('');

    if (fkProblems.length > 0) {
      // ★ IN A DRY RUN THIS IS THE WHOLE POINT OF THE DRY RUN. Until now it could
      //   not reach here at all: the FK graph was built after the DRY return, so
      //   G12 never ran in a rehearsal. Repeated green dry runs therefore said
      //   NOTHING about the one fence the real write then tripped over — the fence
      //   that refused it. Moved above the DRY return so a rehearsal exercises it.
      if (DRY) {
        throw new Error(
          `${fkProblems.length} FK overlap(s) would reject rows on a real run. This is a DRY RUN, so ` +
            'nothing was written. Per §3.9 these are fixed by changing the CHILD\'s cap key or ' +
            'narrowing its slice to the parent\'s keys — not by disabling foreign_keys, which buys ' +
            'the row count and spends the correctness.',
        );
      }
      throw new Error(
        `${fkProblems.length} FK overlap(s) would reject rows. Nothing has been written. ` +
          'Per §3.9 these are fixed by changing the CHILD\'s cap key or narrowing its slice to the ' +
          'parent\'s keys — not by disabling foreign_keys, which buys the row count and spends the ' +
          'correctness.',
      );
    }

    if (DRY) {
      say('');
      say('—— DRY RUN: nothing was written ——');
      say(`  would load ${num(loads.reduce((s, l) => s + l.rows.length, 0))} row(s) into ${num(loads.length)} table(s)`);
      say(`  would ${REFRESH ? 'DELETE every in-scope table first' : 'assert every in-scope table is empty'}`);
      return;
    }

    // ── G13: --fresh asserts an empty destination ────────────────────────────
    if (FRESH) {
      const nonEmpty: string[] = [];
      for (const l of loads) {
        const rs = await dst.execute(`SELECT COUNT(*) AS n FROM ${quote(l.table)}`);
        const n = Number((rs.rows[0] as Dict).n ?? 0);
        if (n > 0) nonEmpty.push(`${l.table} (${num(n)})`);
      }
      if (nonEmpty.length > 0) {
        throw new Error(
          `--fresh was asked for but the destination already holds rows in: ${nonEmpty.join(', ')}. ` +
            'A --fresh run against a populated database is a duplicate-key failure partway through — ' +
            'use --refresh, which deletes first.',
        );
      }
      ok('G13 destination is empty, as --fresh claims');
    }

    // ── The delete half (G: refresh) ─────────────────────────────────────────
    if (REFRESH) {
      const targets = [...loadOrder].reverse();
      say('—— DELETE (the exact reverse of the load order) ——');
      const tx = await dst.transaction('write');
      let deleted = 0;
      try {
        // Decision 2: GL_BUDGET_ASSIGNMENTS is not loaded, but its seed rows must
        // go — and they must go FIRST.
        //
        // ★ IT USED TO GO LAST, AND THAT ORDER CANNOT WORK. Its FK to
        //   GL_BUDGET_VERSIONS is declared WITHOUT an ON DELETE clause, so it is
        //   NO ACTION — SQLite refuses to delete a parent while a child row
        //   references it. The reverse-order loop below deletes GL_BUDGET_VERSIONS,
        //   so a delete of ASSIGNMENTS placed AFTER it is not a tidy-up; it is a
        //   `FOREIGN KEY constraint failed` on the parent, mid-transaction.
        //   MEASURED: 02-seed.sql plants ASSIGNMENTS rows for versions 501…504 and
        //   GL_BUDGET_VERSIONS holds exactly those ids, so the collision is certain.
        //
        // ★ THE GENERAL FORM: a table the copy deliberately does not LOAD is still
        //   a table the destination's FK graph contains, so it belongs in the
        //   delete set — at its own position in the order, not bolted on.
        if (!scopeSet.has(norm('GL_BUDGET_ASSIGNMENTS'))) {
          const r = await tx.execute(`DELETE FROM ${quote('GL_BUDGET_ASSIGNMENTS')}`);
          deleted += Number(r.rowsAffected ?? 0);
          say(`  GL_BUDGET_ASSIGNMENTS — ${num(Number(r.rowsAffected ?? 0))} seed row(s) removed FIRST (not reloaded — see the exclusion above)`);
          say('      (it is a child of GL_BUDGET_VERSIONS with a NO ACTION FK, so it has to');
          say('       go before the parent that the reverse-order loop deletes)');
        }
        for (const t of targets) {
          const l = byNorm.get(t)!;
          const r = await tx.execute(`DELETE FROM ${quote(l.table)}`);
          deleted += Number(r.rowsAffected ?? 0);
        }
        await tx.commit();
        ok('refresh: every in-scope table emptied in one transaction', `${num(deleted)} row(s) removed`);
      } catch (err) {
        await tx.rollback();
        // ★ The delete is one unit on purpose. §6: "a delete that runs before a
        //   load which then refuses 100,000 rows leaves the destination emptier
        //   than it started." Rolling the whole delete back keeps it reversible.
        throw new Error(`the delete half failed and was rolled back, so the destination is intact: ${(err as Error).message}`);
      }
      say('');
    }

    // ── The insert half ──────────────────────────────────────────────────────
    say('—— INSERT (batched, ~1,000 rows per statement — §3.4\'s knee) ——');
    const stats: Array<{ table: string; rows: number; mode: string; ms: number }> = [];
    const derivedLog: string[] = [];

    for (const t of loadOrder) {
      const l = byNorm.get(t)!;
      // ★ A table that read 0 rows is not INSERTed, and G4 above already stated any
      //   NOT NULL hole in it as a fact rather than a failure. Skipping here is what
      //   makes that statement true instead of merely reassuring.
      if (l.rows.length === 0) {
        info(`${l.table}: 0 rows`, 'nothing to insert');
        continue;
      }

      const t0 = Date.now();

      // Column order the INSERT will use: the projection, then any NOT NULL hole
      // filled by a derivation.
      const dest = await destinationIdentity(dst, l.table);
      const destNames = new Set(dest.declared.map(norm));

      // ★ A table with no rows never reaches this loop (skipped above), so a hole in
      //   it cannot want a value. That is what makes G4's "0 rows, so no INSERT is
      //   attempted" a fact rather than an assurance.
      const fillIdx: Array<{ column: string; value: (row: Dict) => Value }> = [];
      for (const col of l.notNullUnfilled) {
        const key = `${norm(l.table)}.${norm(col)}`;
        const rule = DERIVATIONS[key];
        const dflt = dest.notNull.get(norm(col))?.dflt ?? null;
        if (rule) {
          fillIdx.push({ column: col, value: (row) => deriveValue(l.table, col, row) });
          derivedLog.push(`${l.table}.${col} = ${rule.rule}  [${rule.reason}]`);
        } else if (dflt !== null) {
          const literal = dflt.startsWith("'") ? dflt.slice(1, -1).replace(/''/g, "'") : Number(dflt);
          fillIdx.push({ column: col, value: () => (Number.isNaN(literal as number) ? (literal as Value) : (literal as Value)) });
          derivedLog.push(`${l.table}.${col} = the destination's declared default ${dflt}`);
        } else {
          throw new Error(`${l.table}.${col} is NOT NULL and unfillable — refusing to attempt the INSERT.`);
        }
      }

      // ★ A column a derivation fills must NOT also be in `insertCols`: `allCols`
      //   concatenates the two lists, so a name in both is emitted twice —
      //   `INSERT INTO t ("NAME", …, "NAME")`, which SQLite rejects with "duplicate
      //   column name". Before the hole-set fix `fillIdx` was always empty and this
      //   could not happen; arming the derivations is what makes it matter.
      const fillCols = new Set(fillIdx.map((f) => norm(f.column)));
      const insertCols: string[] = l.names.filter(
        (n) => destNames.has(norm(n)) && !fillCols.has(norm(n)),
      );
      const dropped = l.names.filter((n) => !destNames.has(norm(n)));
      if (dropped.length > 0) {
        bad(`${l.table}: ${dropped.length} projected column(s) have no home in the destination`, dropped.join(', '));
      }

      const allCols = [...insertCols, ...fillIdx.map((f) => f.column)];
      const perRowBinds = allCols.length;
      // ★ Binds per statement are bounded: §3.4 measured 32,765 accepted, and
      //   SQLite's ceiling is 32,766. Stay under it by construction.
      const rowsPerStmt = Math.max(1, Math.min(1_000, Math.floor(30_000 / Math.max(1, perRowBinds))));

      const stmtFor = (chunk: Value[][]): { sql: string; args: Value[] } => ({
        sql: `INSERT INTO ${quote(l.table)} (${allCols.map(quote).join(', ')}) VALUES ${chunk
          .map(() => `(${allCols.map(() => '?').join(', ')})`)
          .join(', ')}`,
        args: chunk.flat(),
      });

      let written = 0;
      for (let i = 0; i < l.rows.length; i += rowsPerStmt) {
        const chunk: Value[][] = [];
        for (const raw of l.rows.slice(i, i + rowsPerStmt)) {
          const asDict: Dict = {};
          l.names.forEach((n, ix) => {
            asDict[n] = raw[ix];
          });
          const values: Value[] = [];
          for (const n of insertCols) {
            const ix = l.names.findIndex((x) => norm(x) === norm(n));
            values.push(mapped(raw[ix], l.table, n, true));
          }
          for (const f of fillIdx) values.push(f.value(asDict));
          chunk.push(values);
        }
        await dst.batch([stmtFor(chunk)], 'write');
        written += chunk.length;
      }

      stats.push({ table: l.table, rows: written, mode: l.truncated ? 'TRUNCATE' : 'FULL', ms: Date.now() - t0 });
      say(`  ${l.table.padEnd(26)} ${num(written).padStart(8)}  ${(l.truncated ? 'TRUNCATE' : 'FULL').padEnd(8)} ${ms(Date.now() - t0)}`);
    }
    say('');

    // ★ The value mapping, stated once and applied to every table.
    //
    // `record` is false on the verification pass: it re-maps the SAME rows to build
    // the expected digest, so recording there would double every count and make a
    // "1 value was serialised" report read as 2.
    function mapped(v: unknown, table: string, column: string, record = false): Value {
      if (v === null || v === undefined) return null;
      if (typeof v === 'boolean') return v ? 1 : 0;
      if (typeof v === 'number') return isRealNumber(v) ? v : null;
      if (typeof v === 'string') {
        // ★ §7's highest-risk row: Oracle treats '' as NULL; SQLite treats it as a
        //   distinct empty string. Normalise it, or every blank column gains a
        //   value it never had. (Oracle returns NULL rather than '' for a VARCHAR,
        //   so this is the guard rather than the common path.)
        return v === '' ? null : v;
      }
      if (typeof v === 'bigint') return Number(v);
      if (v instanceof Date) return dateText(v);
      // BLOBs pass through as bytes — `InValue` takes a Uint8Array, and a Buffer is
      // one. Converting them to a string would corrupt them.
      if (v instanceof Uint8Array) return v;
      if (record) {
        const key = `${table}.${column}`;
        jsonFallbacks.set(key, (jsonFallbacks.get(key) ?? 0) + 1);
      }
      try {
        return JSON.stringify(v);
      } catch {
        return null;
      }
    }

    // ── G5 + content digest: read each table back and compare ────────────────
    say('—— G5 + CONTENT: read back and compare ——');
    const sigOf = (rows: Value[][]): string => {
      const lines = rows.map((r) => r.map((v) => (v === null ? '\u0000' : String(v))).join('\u0001')).sort();
      return createHash('sha256').update(lines.join('\u0002')).digest('hex').slice(0, 16);
    };

    const finalCounts: Array<{ table: string; rows: number; mode: string; ms: number; count: number; digestOk: boolean }> = [];
    for (const s of stats) {
      const l = byNorm.get(norm(s.table))!;
      const dest = await destinationIdentity(dst, l.table);
      const destNames = new Set(dest.declared.map(norm));
      const insertCols = l.names.filter((n) => destNames.has(norm(n)));
      const back = await dst.execute(`SELECT ${insertCols.map(quote).join(', ')} FROM ${quote(l.table)}`);
      const rowsBack = (back.rows as unknown as Dict[]).map((r) =>
        insertCols.map((c) => {
          const v = r[c] ?? r[c.toLowerCase()] ?? r[c.toUpperCase()];
          return (v === undefined ? null : v) as Value;
        }),
      );

      // The expected set: exactly what we wrote (the delete half removed anything
      // else). Compared as a digest over sorted canonical rows, because counts
      // agreeing is not contents agreeing — the lesson the app-copy script learned
      // the hard way.
      const written = await dst.execute(`SELECT COUNT(*) AS n FROM ${quote(l.table)}`);
      const count = Number((written.rows[0] as Dict).n ?? -1);
      const countOk = count === l.rows.length;

      let digestOk = true;
      if (VERIFY) {
        const expected = l.rows.map((raw) =>
          insertCols.map((n) => mapped(raw[l.names.findIndex((x) => norm(x) === norm(n))], l.table, n)),
        );
        digestOk = sigOf(expected) === sigOf(rowsBack);
      }

      if (countOk && digestOk) ok(`G5 ${l.table}`, `${num(count)} row(s), contents match`);
      else if (!countOk) bad(`G5 ${l.table}`, `wrote ${num(l.rows.length)} but the destination holds ${num(count)}`);
      else bad(`G5 ${l.table}`, `${num(count)} row(s) but the content digest DIFFERS — counts agreeing is not contents agreeing`);

      finalCounts.push({ table: s.table, rows: l.rows.length, mode: s.mode, ms: s.ms, count, digestOk });
    }
    say('');

    // ── G6: the FK check ─────────────────────────────────────────────────────
    {
      const rs = await dst.execute('PRAGMA foreign_key_check');
      const violations = rs.rows as unknown as Dict[];
      if (violations.length === 0) {
        ok('G6 PRAGMA foreign_key_check is clean', '0 violation(s)');
        say('        ★ If this ever starts PASSING for a mechanical reason (e.g. the pragma not running),');
        say('          it becomes a no-op. The G12 overlap checks above are the discriminating pair.');
      } else {
        bad('G6 PRAGMA foreign_key_check', `${num(violations.length)} violation(s)`);
        for (const v of violations.slice(0, 10)) say(`        ${JSON.stringify(v)}`);
      }
    }

    // ── G14: the FKs the overlap probe could not measure ─────────────────────
    say('');
    say('—— G14: FKs whose overlap was NOT measurable (n/a means not measurable, NOT safe) ——');
    {
      let n = 0;
      for (const [child, list] of fks) {
        const cl = byNorm.get(child);
        if (!cl) continue;
        for (const fk of list) {
          const pl = byNorm.get(norm(fk.parent));
          if (!pl) continue;
          const ci = indexOf(cl, fk.from);
          const pi = indexOf(pl, fk.to.length > 0 ? fk.to : '');
          if (ci < 0 || pi < 0) {
            n++;
            say(`  ${cl.table}.${fk.from} → ${pl.table}: ${ci < 0 ? `${fk.from} not projected on ${cl.table}` : `${fk.to || '(parent pk)'} not projected on ${pl.table}`}`);
          }
        }
      }
      if (n === 0) info('none — every in-scope FK was measurable');
      else say(`  ── ${num(n)} FK(s) measured as a count instead of an overlap. A NULL here SATISFIES an FK,`);
      say('     which is the one harmless outcome — but a zero beside an n/a row means nothing.');
    }

    // ── The derived-value ledger ─────────────────────────────────────────────
    say('');
    say('—— ★ DERIVED VALUES (a derived value must never be mistaken for a read one) ——');
    if (derivedLog.length === 0) info('none');
    else for (const d of derivedLog) say(`  ${d}`);
    if (measured.notes.length > 0) {
      say('  measurements that failed:');
      for (const n of measured.notes) say(`    ${n}`);
    }
    say(`  the two measured keys used by ML rules: LEDGER_ID=${String(measured.ledgerId)} BUDGET_TYPE_ID=${String(measured.budgetTypeId)}`);

    // ── Values that could only be serialised ────────────────────────────────
    if (jsonFallbacks.size > 0) {
      say('');
      say('—— ★ VALUES THAT ARRIVED AS OBJECTS (serialised — a lossy guess, so it is NAMED) ——');
      for (const [k, n] of jsonFallbacks) say(`  ${k}: ${num(n)} value(s)`);
      say('  A JSON string is not the value. A column here needs a type handler of its own before its');
      say('  copy can be called faithful; until then it is a NAMED approximation, not a silent one.');
    }

    // ── The report-pinned gates this run breaks ──────────────────────────────
    say('');
    say('—— ★ REPORT-PINNED GATES THE "REPLACE" DECISION AFFECTS ——');
    say('  These assert specific figures that came from the CURATED SAMPLE. That data is now gone,');
    say('  so each one is deliberately re-based or retired — never allowed to fail silently:');
    say('    G1  row counts match data/sql/turso/build-manifest.json (COA 520, PO_LINES 2,805,');
    say('        GL_BALANCES 31, PROVENANCE 559, …)          → re-base onto the copied counts');
    say('    G3  the level-0450 grid reproduces report-findings.md §3   → re-measure or retire');
    say('    G8  funding lines total 100,539,984 over 7 rows            → re-measure or retire');
    say('    G14 provenance notes match actual counts (34 claims)       → re-measure or retire');
    say('    G16 data/oracle/full-output.json two grains (589/2,193)    → unaffected (reads the file)');
    say('    G17 level 0450 extract $4,356,078.25 vs report enc        → re-measure or retire');
    say('');

    // ── The JSON artifact (§10.11: the snapshot baseline, recorded) ──────────
    const artifact = {
      ranAt: new Date().toISOString(),
      mode: FRESH ? 'fresh' : 'refresh',
      cap: CAP,
      destination: dstHost,
      source: `${env.ORACLE_USER}@${env.ORACLE_CONNECT_STRING}`,
      oracleDateMode: dateMode,
      destinationObjectsBefore: dstObjects,
      tables: finalCounts,
      derived: derivedLog,
      jsonFallbacks: Object.fromEntries(jsonFallbacks),
      notReadable,
      excluded: skipped,
      // ★ Rows the declared identity policy folded away (G18), named per table so a
      //   fold can never be read as a clean, complete copy of that table.
      folded: loads
        .filter((l) => l.folded > 0)
        .map((l) => ({ table: l.table, read: l.rows.length + l.folded, kept: l.rows.length, folded: l.folded, policy: IDENTITY_POLICY[norm(l.table)]?.mode ?? null })),
      rowsWritten: finalCounts.reduce((s, t) => s + t.rows, 0),
      gatesFailed: failed,
      gatesPassed: passed,
      elapsedMs: Date.now() - started,
    };
    const outPath = join(REPO_ROOT, 'data', 'reports', 'copy-oracle-to-turso.json');
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, JSON.stringify(artifact, null, 2) + '\n', 'utf8');
    say(`—— baseline recorded: ${outPath} ——`);
    say('');

    say('══════════════════════════════════════════════════════════════════════');
    say(`  ${failed === 0 ? 'ALL GATES PASSED' : `${failed} GATE(S) FAILED`} — ${passed} passed, ${failed} failed`);
    say(`  rows written: ${num(artifact.rowsWritten)} into ${num(finalCounts.length)} table(s)`);
    say(`  truncation:   ${num(finalCounts.filter((t) => t.mode === 'TRUNCATE').length)} table(s) capped at ${num(CAP)}, the rest FULL`);
    // ★ The folds are stated here as well as in G18, because this is the block a
    //   reader quotes from: a copy that folded rows must not read as a copy that
    //   took everything the source had.
    if (artifact.folded.length === 0) {
      say('  folded:       0 rows — no table needed the declared identity policy');
    } else {
      const n = artifact.folded.reduce((s, f) => s + f.folded, 0);
      say(`  folded:       ${num(n)} row(s) across ${num(artifact.folded.length)} table(s), by the declared policy`);
      for (const f of artifact.folded) say(`                  ${f.table}: ${num(f.read)} read → ${num(f.kept)} kept (${num(f.folded)} folded)`);
    }
    say(`  elapsed:      ${ms(Date.now() - started)}`);
    say('══════════════════════════════════════════════════════════════════════');
  } finally {
    await conn.close();
    await dst.close();
  }

  if (failed > 0) process.exitCode = 1;
}

/**
 * ★ The handler deliberately does NOT re-print the report.
 *
 * The report has already been written to stdout line by line as it was built, so
 * echoing it here would double every line — and the useful part of a crash is the
 * LAST few lines (which table, which gate), not the whole transcript again.
 */
main().catch((err: unknown) => {
  say('');
  say(`✖ ${(err as Error).message}`);
  say(`  (the report above is complete up to this point; nothing after it ran)`);
  process.exitCode = 1;
});
