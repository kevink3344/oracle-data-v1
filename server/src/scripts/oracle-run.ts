/**
 * Run every analysis file in `data/sql` against the database the app reads.
 *
 * ── ★ WHY THIS EXISTS
 *
 * `data/sql/00…04` are five files of hand-written Oracle SQL. Their SQLite
 * translations (`data/sql/turso/queries`) already run under
 * `scripts/turso-run.mjs`, so the **port** was executable and the **original**
 * was not — and the original is the one a person pastes into SQL Developer
 * against `europa`, and the one `data/sql/README.md` makes its claims about.
 * A file nobody can run is a claim, not a check.
 *
 * ── ★ THE FILES STATE THEIR OWN OUTCOME, AND THIS SCRIPT HOLDS THEM TO IT
 *
 * `04-spend-and-actuals.sql` opens with a table of its known failures, keyed by
 * statement ordinal:
 *
 *     S0   #1   ORA-00942  AP_INV_LINES / AP_INV_DISTRIBUTIONS legs. Ungranted.
 *     S4   #10  ORA-00904  K.PAYMENT_DATE. *** A REAL DEFECT ON A GRANTED TABLE.
 *
 * Those numbers are a claim about a run, and a claim about a run is worth
 * something only if something runs it. The table is **parsed out of the file** —
 * it is the source of truth, and a second copy here would drift from it — and the
 * run is held to it in both directions:
 *
 *   • a documented failure that *succeeds* is reported, because a note saying a
 *     statement fails is wrong the moment a grant lands;
 *   • an **undocumented** failure fails the run. A statement this repo believed
 *     works, and which no longer does, is the thing worth being told about.
 *
 * A file with no documented-failure table is held to the stricter claim: every
 * one of its statements must run. `00-discover.sql`'s notes about ORA-00904 are
 * *history* — statements that used to fail and were rewritten to work — so they
 * are deliberately not treated as expectations.
 *
 * ── ★ CONTROLS, BECAUSE A RUN OF ONLY PASSES PROVES NOTHING
 *
 * Four statements run first: an unknown column, an unknown object and a syntax
 * error — all three **must** fail — plus one `SELECT … FROM dual`, which must
 * succeed. A harness that swallows exceptions, or that never sends anything at
 * all, reports a clean run. The controls are what tells the two apart, and the
 * run exits non-zero if any of them misbehaves.
 *
 * ── ★ THE SESSION IS PINNED THE WAY THE APP PINS IT
 *
 * The driver is the app's own (`storeDriver('ledger')` on `DB_MODE=oracle`), not
 * a second connection built here. That matters for more than convenience:
 * `db/oracle.ts#pinSession` sets `CURRENT_SCHEMA = APPS`, without which every
 * table in these files answers `ORA-00942` (EBS exposes them through APPS
 * synonyms), and it pins the NLS formats, without which `2025-07-01` is a
 * literal in whatever format the client locale happens to be. A runner with its
 * own connection would be a second opinion about the session, and the two would
 * drift.
 *
 * ── ★ WHAT IT REFUSES TO DO
 *
 *   • It will not run in another dialect. `data/sql` is Oracle SQL; executing it
 *     through the libSQL driver would produce dialect errors reported as findings.
 *   • It will not run a statement that is not a `SELECT`. `data/sql/README.md`
 *     promises the folder cannot change anything, and that promise is checked
 *     here, on the code with comments and literals stripped, before anything is
 *     sent. The account holds SELECT only, so this is the second lock, not the
 *     first — but it is the one that fails loudly.
 *   • It will not abandon a statement silently. Each one is capped
 *     (`ORACLE_RUN_TIMEOUT_MS`, default 10 min) and a capped statement is reported
 *     as `TIMEOUT`, never as a pass. ★ The cap does not cancel the Oracle call —
 *     nothing in this driver can — so the connection stays busy until Oracle
 *     answers, and four of them would exhaust the pool. That is why the cap is
 *     generous: it is a bound on a hang, not a race against slow-but-working SQL.
 *
 * Run:
 *
 *     Push-Location server; npm run oracle:run; Pop-Location
 *
 * Options (env): `ORACLE_RUN_TIMEOUT_MS`, `ORACLE_RUN_ONLY=<substring of filename>`.
 */

import { readdir, readFile } from 'node:fs/promises';
import { storeDriver } from '../db/client.js';
import { config } from '../config/env.js';
import type { SqlDriver } from '../db/driver.js';

/* ── ★ THE ANALYSIS FOLDER IS READ, NOT LISTED HERE ──────────────────────────
 *
 * A hard-coded array of five filenames would be a second copy of what `ls` says,
 * and it would go stale the first time a `05-*.sql` is added — silently, because
 * nothing would be checking it. Reading the directory means a new analysis file
 * is run the day it lands.
 */
const SQL_DIR = new URL('../../../data/sql/', import.meta.url);

const TIMEOUT_MS = Number(process.env.ORACLE_RUN_TIMEOUT_MS ?? 600_000);
const ONLY = process.env.ORACLE_RUN_ONLY ?? '';

const say = (line = ''): void => console.log(line);
const fail = (line = ''): void => console.error(line);

/* ──────────────────────────────────────────────────────────────────────────────
 * SPLITTING A FILE INTO STATEMENTS
 *
 * The files are plain SQL — no `/` terminators, no PL/SQL blocks, no
 * `DEFINE`/substitution variables, and (measured) no `:name` binds, so there is
 * nothing to supply. The only terminator is `;`, and the only thing that makes
 * splitting non-trivial is that a `;` is a terminator only in *code*: this folder
 * has 21 semicolons that live inside `--` comments, and a literal or a comment
 * containing one would otherwise cut a statement in half.
 *
 * `db/oracle.ts` already solves this shape of problem for its own rewrites
 * (`segmentSql`, private there). This is a second implementation, and the honest
 * reason is that the scanner's output here is different — it needs *statement
 * boundaries* plus three views of the text, not code/non-code runs. What it must
 * not do is disagree about what a comment or a literal is, so it copies that
 * logic exactly, including the doubled-quote escape:
 *
 *   ★ Oracle's alternative quoting (`q'[…]'`) is not scanned for — the same hole
 *     `segmentSql` documents, and no file here uses it. A `;` inside a `q'[…]'`
 *     would split a statement and surface as a syntax error in the statement
 *     after it, which is loud rather than silent.
 *
 * The three views:
 *   • `sql`  — the statement as the file holds it: comments kept, so what runs is
 *              what a reader sees, and a failure can be pasted back into the file.
 *   • `code` — code plus string literals. Used for the first-keyword check.
 *   • `bare` — code only. Used for the write-word scan, where a literal
 *              containing the word `DELETE` must not count as a write.
 * ────────────────────────────────────────────────────────────────────────────── */

interface Statement {
  /** 1-based within its file — the number the file's own failure table cites. */
  readonly ordinal: number;
  /** 1-based line of the statement's first code character. */
  readonly line: number;
  /** Nearest `-- B1. …`-style heading above it, else the nearest comment line. */
  readonly title: string;
  readonly sql: string;
  readonly code: string;
  readonly bare: string;
}

interface SplitResult {
  readonly statements: Statement[];
  /** Semicolons in code — each one terminates a statement. */
  readonly semisInCode: number;
  /** Semicolons inside a comment or a literal. Reported so the gap is visible. */
  readonly semisInOther: number;
}

const HEADING = /^--\s*[A-Z][\d.]*\s+\S/;
const RULE = /^--[\s=*_-]*$/;

function splitStatements(text: string): SplitResult {
  const statements: Statement[] = [];

  let sql = '';
  let code = '';
  let bare = '';
  let startLine: number | null = null;
  let line = 1;
  let lastComment = '';
  let lastHeading = '';
  let semisInCode = 0;
  let semisInOther = 0;

  const note = (comment: string): void => {
    lastComment = comment;
    if (HEADING.test(comment)) lastHeading = comment;
  };

  const flush = (): void => {
    /* ★ A statement exists iff it holds code. A file's trailing comment block, or
     *   the blank space after the last `;`, is not a statement — sending it would
     *   be a syntax error invented by the splitter. */
    if (code.trim().length > 0) {
      const label = lastHeading || lastComment;
      const clean = label.trim().replace(/^--\s*/, '').trim();
      statements.push({
        ordinal: statements.length + 1,
        line: startLine ?? line,
        title: clean.length === 0 || RULE.test(label.trim()) ? firstCodeLine(code) : clean,
        sql: sql.trim(),
        code: code.trim(),
        bare: bare.trim(),
      });
    }
    sql = '';
    code = '';
    bare = '';
    startLine = null;
    lastComment = '';
    lastHeading = '';
  };

  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);

    if (ch === '\n') {
      line += 1;
      sql += ch;
      code += ch;
      bare += ch;
      i += 1;
      continue;
    }

    /* Quoted run — a literal or an identifier. The quote itself is code; the
     * contents are not scanned for `;`, `-` or `/`. */
    if (ch === "'" || ch === '"') {
      let quoted = ch;
      i += 1;
      while (i < text.length) {
        const c = text.charAt(i);
        quoted += c;
        if (c === '\n') line += 1;
        i += 1;
        if (c === ch) {
          // A doubled quote is an escaped quote, not the end of the run.
          if (text.charAt(i) === ch) {
            quoted += ch;
            i += 1;
            continue;
          }
          break;
        }
      }
      sql += quoted;
      code += quoted;
      if (startLine === null) startLine = line;
      continue;
    }

    /* Line comment — kept in `sql`, dropped from both code views. */
    if (ch === '-' && text.charAt(i + 1) === '-') {
      let comment = '';
      while (i < text.length && text.charAt(i) !== '\n') {
        comment += text.charAt(i);
        i += 1;
      }
      /* ★ Counted once, after the comment is complete. Counting inside the loop
       *   above multiplies by the number of remaining characters in the comment,
       *   which reads as a plausible total and is a nonsense one. */
      for (const c of comment) if (c === ';') semisInOther += 1;
      sql += comment;
      note(comment.trim());
      continue;
    }

    /* Block comment — same, and a semicolon inside one is counted so the
     * statement count can be reconciled against the file's raw `;` count. */
    if (ch === '/' && text.charAt(i + 1) === '*') {
      let comment = '/*';
      i += 2;
      while (i < text.length && !(text.charAt(i) === '*' && text.charAt(i + 1) === '/')) {
        if (text.charAt(i) === '\n') line += 1;
        comment += text.charAt(i);
        i += 1;
      }
      comment += '*/';
      i += 2;
      for (const c of comment) if (c === ';') semisInOther += 1;
      sql += comment;
      continue;
    }

    if (ch === ';') {
      semisInCode += 1;
      i += 1;
      flush();
      continue;
    }

    if (startLine === null && !/\s/.test(ch)) startLine = line;
    sql += ch;
    code += ch;
    bare += ch;
    i += 1;
  }

  flush();
  return { statements, semisInCode, semisInOther };
}

/** The first line of a statement that is not a comment — the fallback label. */
function firstCodeLine(code: string): string {
  for (const raw of code.split('\n')) {
    const t = raw.trim();
    if (t.length > 0) return t;
  }
  return '(statement)';
}

/* ──────────────────────────────────────────────────────────────────────────────
 * THE FILE'S OWN FAILURE TABLE
 *
 * `--   S0   #1   ORA-00942  …`, one line per known failure. Parsed, never
 * copied: the file is where a reader looks, so the file is what is checked.
 * ────────────────────────────────────────────────────────────────────────────── */

const DOCUMENTED = /^\s*--\s+([A-Z][\d.]*)\s+#(\d+)\s+(ORA-\d{5})/;

interface Expected {
  readonly section: string;
  /** Ordinal *within the file*, which is what the table's `#N` means. */
  readonly ordinal: number;
  readonly ora: string;
}

function readExpectations(text: string): Expected[] {
  const found: Expected[] = [];
  for (const line of text.split('\n')) {
    const m = DOCUMENTED.exec(line);
    if (m && m[1] && m[2] && m[3]) {
      found.push({ section: m[1], ordinal: Number(m[2]), ora: m[3] });
    }
  }
  return found;
}

/* ──────────────────────────────────────────────────────────────────────────────
 * THE READ-ONLY GATE
 * ────────────────────────────────────────────────────────────────────────────── */

const WRITE_WORD =
  /\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|RENAME|LOCK|COMMIT|ROLLBACK|SAVEPOINT|EXECUTE|BEGIN|DECLARE|CALL)\b/;

interface Verdict {
  readonly ok: boolean;
  readonly why: string;
}

/** `data/sql/README.md`: "Every statement in every file here is a SELECT." */
function checkReadOnly(s: Statement): Verdict {
  const first = /^[A-Za-z]+/.exec(s.bare)?.[0]?.toUpperCase() ?? '';
  if (first !== 'SELECT' && first !== 'WITH') {
    return { ok: false, why: `starts with "${first || '?'}" — the folder is SELECT-only` };
  }
  const hit = WRITE_WORD.exec(s.bare);
  if (hit) {
    return { ok: false, why: `contains the keyword ${hit[1]} outside comments and literals` };
  }
  return { ok: true, why: 'select' };
}

/* ──────────────────────────────────────────────────────────────────────────────
 * RUNNING ONE STATEMENT
 * ────────────────────────────────────────────────────────────────────────────── */

type Outcome =
  | { readonly kind: 'ok'; readonly ms: number; readonly rows: number; readonly peek: string | null }
  | { readonly kind: 'failed'; readonly ms: number; readonly ora: string | null; readonly message: string }
  | { readonly kind: 'timeout'; readonly ms: number };

function brief(value: unknown): string {
  if (value === null || value === undefined) return '∅';
  if (value instanceof Date) return value.toISOString();
  const s = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return s.length > 44 ? `${s.slice(0, 41)}…` : s;
}

async function run(driver: SqlDriver, sql: string): Promise<Outcome> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;

  const capped = new Promise<Outcome>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'timeout', ms: Date.now() - started }), TIMEOUT_MS);
  });

  const attempt = (async (): Promise<Outcome> => {
    const res = await driver.execute({ sql });
    const ms = Date.now() - started;

    /* ★ The peek is read through `columns`, not `Object.keys(row)`. The Oracle
     *   driver returns a proxy that answers case-insensitively; enumerating it
     *   is a different question from reading it, and the app's own routes read
     *   it by column name. */
    const cols = res.columns ?? [];
    const row = (res.rows[0] ?? null) as Record<string, unknown> | null;
    let peek: string | null = null;
    if (row && cols.length > 0) {
      peek = cols
        .slice(0, 6)
        .map((c) => `${c}=${brief(row[c] ?? row[c.toUpperCase()])}`)
        .join('  ');
      if (peek.length > 150) peek = `${peek.slice(0, 147)}…`;
    }
    return { kind: 'ok', ms, rows: res.rows.length, peek };
  })();

  /* ★ A capped statement is not cancelled — nothing in this driver can cancel it —
   *   so its rejection can still arrive after this function has moved on. Without
   *   a handler attached *now*, that late rejection is an unhandled exception that
   *   can take the process down mid-run. */
  attempt.catch(() => {});

  const settled = await Promise.race([attempt, capped]);
  if (timer) clearTimeout(timer);
  return settled;
}

function outcomeOf(err: unknown, ms: number): Outcome {
  const message = err instanceof Error ? err.message.split('\n')[0] ?? String(err) : String(err);
  return { kind: 'failed', ms, ora: /ORA-\d{5}/.exec(message)?.[0] ?? null, message };
}

/* ──────────────────────────────────────────────────────────────────────────────
 * MAIN
 * ────────────────────────────────────────────────────────────────────────────── */

interface Tally {
  statements: number;
  ok: number;
  failed: number;
  timeouts: number;
  documentedAgreed: number;
  documentedStale: string[];
  undocumented: string[];
  refused: string[];
  slowest: { label: string; ms: number }[];
}

const tally: Tally = {
  statements: 0,
  ok: 0,
  failed: 0,
  timeouts: 0,
  documentedAgreed: 0,
  documentedStale: [],
  undocumented: [],
  refused: [],
  slowest: [],
};

async function main(): Promise<number> {
  /* ★ Dialect first. `storeDriver('ledger')` answers with whatever `DB_MODE`
   *   names, and running this folder through the libSQL driver would report a
   *   page of dialect errors as findings about the SQL. */
  if (config.db.mode !== 'oracle') {
    fail(`✗ DB_MODE is "${config.db.mode}", not "oracle". These files are Oracle SQL — set DB_MODE=oracle and run again.`);
    return 1;
  }

  const driver = storeDriver('ledger');
  if (driver.dialect !== 'oracle') {
    fail(`✗ The ledger driver reports dialect "${driver.dialect}", not "oracle". Refusing to run.`);
    return 1;
  }

  const entries = await readdir(SQL_DIR, { withFileTypes: true });
  const names = entries
    .filter((e) => e.isFile() && e.name.endsWith('.sql'))
    .map((e) => e.name)
    .filter((n) => (ONLY ? n.includes(ONLY) : true))
    .sort();

  say();
  say('── ★ ORACLE ANALYSIS RUN ───────────────────────────────────────────────────');
  say(`target            : ${config.db.mode} → ${config.db.label}`);
  say(`driver dialect    : ${driver.dialect}`);
  say(`files             : ${names.length} in data/sql${ONLY ? ` (filtered by ORACLE_RUN_ONLY=${ONLY})` : ''}`);
  for (const n of names) say(`  · ${n}`);
  say(`per-statement cap : ${(TIMEOUT_MS / 1000).toFixed(0)} s`);
  say();

  /* ── Controls. Three that must fail, one that must pass. ── */
  const controls: { label: string; sql: string; want: 'fail' | 'ok' }[] = [
    { label: 'control: SELECT … FROM dual (must succeed)', sql: 'SELECT 1 AS n FROM dual', want: 'ok' },
    { label: 'control: unknown column (must fail)', sql: 'SELECT no_such_column_zzz FROM dual', want: 'fail' },
    { label: 'control: unknown object (must fail)', sql: 'SELECT 1 FROM apps.no_such_table_zzz', want: 'fail' },
    { label: 'control: syntax error (must fail)', sql: 'SELECT FROM WHERE ((', want: 'fail' },
  ];

  let controlsBad = 0;
  say('── controls ──');
  for (const c of controls) {
    let outcome: Outcome;
    try {
      outcome = await run(driver, c.sql);
    } catch (err) {
      outcome = outcomeOf(err, 0);
    }
    const met = c.want === 'ok' ? outcome.kind === 'ok' : outcome.kind === 'failed';
    if (!met) controlsBad += 1;
    const detail = outcome.kind === 'failed' ? ` ${outcome.ora ?? '(no ORA code)'} — ${outcome.message}` : '';
    say(`  ${met ? '✓' : '✗✗'} ${c.label.padEnd(44)} ${outcome.kind}${detail}`);
  }
  say();
  if (controlsBad > 0) {
    /* ★ Without this the whole report below is unreadable: a run of passes from a
     *   harness that cannot report a failure is indistinguishable from success. */
    fail(`✗ ${controlsBad} of ${controls.length} controls did not behave. The report below is not evidence — stopping.`);
    return 1;
  }
  say(`✓ all ${controls.length} controls behaved (3 failures reported as failures, 1 pass as a pass)`);
  say();

  /* ── The files. ── */
  for (const name of names) {
    const text = await readFile(new URL(name, SQL_DIR), 'utf8');
    const { statements, semisInCode, semisInOther } = splitStatements(text);
    const expected = readExpectations(text);
    const expectedByOrdinal = new Map(expected.map((e) => [e.ordinal, e]));

    /* ★ The splitter's own check. Every `;` in code terminates exactly one
     *   statement, so the two counts must agree — bar the file whose last
     *   statement carries no terminator. A `;` inside a comment or a literal is
     *   counted separately and must NOT be in `semisInCode`; if it leaked in, the
     *   statement count would be too high and a statement would be cut in half. */
    const rawSemis = text.split(';').length - 1;
    const reconciled = semisInCode === statements.length || semisInCode + 1 === statements.length;

    say(`── ${name} ──`);
    say(
      `   ${statements.length} statement(s) · ${semisInCode} terminator(s) in code · ` +
        `${semisInOther} in comments/literals · ${rawSemis} raw ';'` +
        (reconciled ? '' : '   ✗ SPLITTER DISAGREES WITH ITSELF'),
    );
    if (expected.length > 0) {
      say(`   the file documents ${expected.length} of them as failing, by ordinal`);
    }

    if (!reconciled) {
      tally.refused.push(`${name}: splitter found ${statements.length} statement(s) for ${semisInCode} code terminator(s)`);
    }

    for (const s of statements) {
      const label = `${String(s.ordinal).padStart(2)} ${name}:${s.line}`;
      const gate = checkReadOnly(s);
      const want = expectedByOrdinal.get(s.ordinal);

      if (!gate.ok) {
        /* Never sent. The folder's promise is checked before the statement runs,
         * so a write cannot be reported as a failure — it is refused. */
        tally.refused.push(`${label} REFUSED — ${gate.why}`);
        say(`  ${label.padEnd(26)} REFUSED  ${gate.why}`);
        continue;
      }

      tally.statements += 1;
      let outcome: Outcome;
      try {
        outcome = await run(driver, s.sql);
      } catch (err) {
        outcome = outcomeOf(err, 0);
      }
      tally.slowest.push({ label, ms: outcome.ms });

      const title = s.title.length > 58 ? `${s.title.slice(0, 55)}…` : s.title;

      if (outcome.kind === 'ok') {
        tally.ok += 1;
        if (want) {
          /* ★ A negative expectation that has started passing. The note in the
           *   file is now wrong — most likely because a grant was added — and
           *   saying so is the whole point of reading the table. */
          tally.documentedStale.push(`${label} — documented as failing with ${want.ora}, but it succeeded`);
          say(`  ${label.padEnd(26)} ✗✗ OK  (documented ${want.ora}, section ${want.section}) — the note is now wrong  ${title}`);
        } else {
          say(
            `  ${label.padEnd(26)} ok  ${String(outcome.rows).padStart(7)} row(s) ${String(outcome.ms).padStart(7)} ms  ${title}` +
              (outcome.peek ? `\n${' '.repeat(30)}${outcome.peek}` : ''),
          );
        }
        continue;
      }

      if (outcome.kind === 'timeout') {
        tally.timeouts += 1;
        tally.undocumented.push(`${label} TIMEOUT after ${(outcome.ms / 1000).toFixed(0)} s`);
        say(`  ${label.padEnd(26)} ✗✗ TIMEOUT after ${(outcome.ms / 1000).toFixed(0)} s  ${title}`);
        continue;
      }

      tally.failed += 1;
      const got = outcome.ora ?? '(no ORA code)';
      if (want && want.ora === outcome.ora) {
        tally.documentedAgreed += 1;
        say(`  ${label.padEnd(26)} fail ${got}  = documented (${want.section})  ${title}`);
      } else if (want) {
        tally.documentedStale.push(`${label} — documented ${want.ora}, observed ${got}`);
        say(`  ${label.padEnd(26)} ✗✗ fail ${got}, documented ${want.ora}  ${title}`);
      } else {
        tally.undocumented.push(`${label} — ${got}: ${outcome.message}`);
        say(`  ${label.padEnd(26)} ✗✗ UNDOCUMENTED FAILURE ${got}  ${title}\n${' '.repeat(30)}${outcome.message}`);
      }
    }
    say();
  }

  /* ── Summary. ── */
  say('── summary ──');
  say(`statements run        : ${tally.statements}`);
  say(`  succeeded           : ${tally.ok}`);
  say(`  failed              : ${tally.failed}`);
  say(`  timed out           : ${tally.timeouts}`);
  say(`documented + agreed   : ${tally.documentedAgreed}`);
  say(`documented but stale  : ${tally.documentedStale.length}`);
  say(`undocumented failures : ${tally.undocumented.length}`);
  say(`refused by the gate   : ${tally.refused.length}`);

  const slowest = [...tally.slowest].sort((a, b) => b.ms - a.ms).slice(0, 5);
  if (slowest.length > 0) {
    say();
    say('the slowest five');
    for (const s of slowest) say(`  ${String(s.ms).padStart(8)} ms  ${s.label}`);
  }

  if (tally.documentedStale.length > 0) {
    say();
    fail('★ DOCUMENTED FAILURES THAT DID NOT HAPPEN — the file\'s note is now wrong:');
    for (const m of tally.documentedStale) fail(`  ${m}`);
  }
  if (tally.undocumented.length > 0) {
    say();
    fail('★ FAILURES THE FILES DO NOT ACCOUNT FOR:');
    for (const m of tally.undocumented) fail(`  ${m}`);
  }
  if (tally.refused.length > 0) {
    say();
    fail('★ NOT RUN:');
    for (const m of tally.refused) fail(`  ${m}`);
  }

  const clean =
    tally.statements > 0 &&
    tally.undocumented.length === 0 &&
    tally.documentedStale.length === 0 &&
    tally.refused.length === 0;

  say();
  if (clean) {
    say(`✓ every statement in data/sql was run, and data/sql agrees with itself: ${tally.statements} statement(s), ${tally.ok} succeeded, ${tally.documentedAgreed} failed exactly as documented.`);
    return 0;
  }
  fail('✗ the run is not clean — see the starred section(s) above.');
  return 1;
}

let code = 1;
try {
  code = await main();
} catch (err) {
  fail(`✗ the run itself failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  code = 1;
} finally {
  /* ★ `close(0)` does not wait for an in-flight statement, and a capped statement
   *   may still be in flight. Best effort: the process is ending either way, and a
   *   throw here would mask the real exit code. */
  try {
    await storeDriver('ledger').close();
  } catch {
    /* left to the exit code below */
  }
}

process.exit(code);
