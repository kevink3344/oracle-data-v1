#!/usr/bin/env node
// ---------------------------------------------------------------------------
// turso-run.mjs — run the ported analysis SQL against the sample database.
//
// The five files in data/sql/turso/queries are data/sql/00..04-*.sql translated
// into SQLite dialect. This script runs them, which covers two needs at once:
//
//   READING    the answers, while testing against the sample data.
//   PROVING    the port is executable. Every statement in every file is parsed
//              and run. Failures are collected and all reported at the end
//              rather than aborting on the first, so one bad statement does not
//              hide the twelve behind it — and the exit code is non-zero, so
//              this doubles as the port's acceptance test.
//
// Statements are never skipped or guessed at. If a statement cannot run, that
// is a failure to fix, not a statement to work around: the whole claim being
// tested is that these queries survive the dialect change.
//
// Usage:
//   node scripts/turso-run.mjs                     # every file, local sample.db
//   node scripts/turso-run.mjs 01-budgets.sql      # one file, local
//   node scripts/turso-run.mjs --remote             # every file, against Turso
//   node scripts/turso-run.mjs --quiet 04-spend-and-actuals.sql
//
// Reads TURSO_* out of .env for --remote, same as build/verify-turso-sample.mjs.
// ---------------------------------------------------------------------------
import { createClient } from '@libsql/client';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const QUERIES = path.join(ROOT, 'data', 'sql', 'turso', 'queries');
const DB_FILE = path.join(ROOT, 'data', 'sql', 'turso', 'sample.db');

const argv = process.argv.slice(2);
const REMOTE = argv.includes('--remote');
const QUIET = argv.includes('--quiet');
const wanted = argv.filter((a) => !a.startsWith('--'));

if (REMOTE) {
  const envPath = path.join(ROOT, '.env');
  try {
    for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z0-9_]+)\s*=\s*([^\r\n]*)/.exec(line);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
    }
  } catch { /* fall through to the env var check below */ }
}

const url = REMOTE ? process.env.TURSO_DATABASE : pathToFileURL(DB_FILE).href;
if (!url) { console.error('--remote needs TURSO_DATABASE (check .env)'); process.exit(2); }
if (!REMOTE && !existsSync(DB_FILE)) {
  console.error(`${DB_FILE} does not exist — run: node scripts/build-turso-sample.mjs`);
  process.exit(2);
}
if (!existsSync(QUERIES)) {
  console.error(`${QUERIES} does not exist — the dialect port has not been written yet.`);
  process.exit(2);
}

const db = createClient(REMOTE ? { url, authToken: process.env.TURSO_API_KEY } : { url });

// ---------------------------------------------------------------------------
// Splitting the files into statements.
//
// Not a split on ';'. Semicolons occur inside string literals ('a;b'), inside
// comments, and in the analytic SQL these files are full of. The scanner below
// tracks which of the four states it is in — code, line comment, block comment,
// string — and only a semicolon in code terminates a statement. It also records
// the line the statement started on, because "statement 7 failed" is useless
// without a line to open.
// ---------------------------------------------------------------------------
function splitStatements(text) {
  const out = [];
  let buf = '';
  let line = 1;
  let startLine = 1;
  let started = false;
  let i = 0;

  const flush = () => {
    const sql = buf.trim();
    if (sql) out.push({ sql, line: startLine });
    buf = '';
    started = false;
  };

  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '\n') { line++; buf += c; i++; continue; }

    if (c === '-' && next === '-') {                       // line comment
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }

    if (c === '/' && next === '*') {                       // block comment
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') line++;
        i++;
      }
      i += 2;
      continue;
    }

    if (c === "'") {                                       // string literal
      if (!started) { startLine = line; started = true; }
      buf += c; i++;
      while (i < text.length) {
        if (text[i] === '\n') line++;
        if (text[i] === "'") {
          if (text[i + 1] === "'") { buf += "''"; i += 2; continue; }
          buf += "'"; i++; break;
        }
        buf += text[i]; i++;
      }
      continue;
    }

    if (c === ';') { flush(); i++; continue; }

    if (!started && !/\s/.test(c)) { startLine = line; started = true; }
    buf += c; i++;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Rendering. The point is to be able to read the answer in a terminal, so a
// wide result is truncated per column rather than wrapped into noise, and a
// long result is summarised rather than dumped in full.
// ---------------------------------------------------------------------------
const WIDTH = 30;
const MAX_ROWS = 25;

const cell = (v) => {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(6)));
  const s = typeof v === 'string' ? v : String(v);
  return s.length > WIDTH ? `${s.slice(0, WIDTH - 3)}...` : s;
};

function render(rs) {
  if (!rs.rows.length) return '  0 rows';
  const cols = rs.columns;
  const body = rs.rows.map((r) => cols.map((c) => cell(r[c])));
  const widths = cols.map((c, j) =>
    Math.min(WIDTH, Math.max(String(c).length, ...body.map((r) => r[j].length))));
  const pad = (s, w) => s + ' '.repeat(Math.max(0, w - s.length));
  const out = [];
  out.push(`  ${cols.map((c, j) => pad(String(c).slice(0, WIDTH), widths[j])).join('  ')}`);
  out.push(`  ${widths.map((w) => '-'.repeat(w)).join('  ')}`);
  for (const r of body.slice(0, MAX_ROWS)) {
    out.push(`  ${r.map((s, j) => pad(s, widths[j])).join('  ')}`);
  }
  if (body.length > MAX_ROWS) out.push(`  ... ${body.length - MAX_ROWS} more row(s)`);
  out.push(`  ${body.length} row(s)`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
const files = wanted.length
  ? wanted
  : readdirSync(QUERIES).filter((f) => f.endsWith('.sql')).sort();

console.log(`turso-run — ${REMOTE ? 'Turso (remote)' : 'local sample.db'} — ${files.length} file(s)`);
let totalStmts = 0;
const failures = [];

for (const f of files) {
  const full = path.join(QUERIES, f);
  if (!existsSync(full)) { failures.push({ file: f, line: 0, sql: '', err: 'file not found' }); continue; }

  const stmts = splitStatements(readFileSync(full, 'utf8'));
  console.log(`\n${'='.repeat(74)}\n${f} — ${stmts.length} statement(s)\n${'='.repeat(74)}`);

  for (const [n, { sql, line }] of stmts.entries()) {
    totalStmts++;
    const head = sql.replace(/\s+/g, ' ').trim();
    if (!QUIET) console.log(`\n[${n + 1}] line ${line}: ${head.slice(0, 96)}${head.length > 96 ? '...' : ''}`);
    try {
      const rs = await db.execute(sql);
      if (!QUIET) console.log(render(rs));
    } catch (e) {
      failures.push({ file: f, line, sql: head, err: e.message });
      console.log(`\n[${n + 1}] line ${line}: FAILED\n      ${e.message}`);
      console.log(`      ${head.slice(0, 150)}${head.length > 150 ? '...' : ''}`);
    }
  }
}

console.log(`\n${'='.repeat(74)}`);
if (failures.length) {
  console.log(`FAILURES — ${totalStmts - failures.length}/${totalStmts} statements ran\n`);
  for (const x of failures) console.log(`  ${x.file}:${x.line}  ${x.err}\n      ${x.sql.slice(0, 120)}`);
} else {
  const v = await db.execute('SELECT sqlite_version() AS v').catch(() => null);
  console.log(`ALL RAN — ${totalStmts}/${totalStmts} statements executed, 0 failed`);
  if (v) console.log(`sqlite_version: ${v.rows[0].v}`);
}
db.close();
// Do NOT call process.exit() here. @libsql/client's native module still has a
// worker thread signalling when process.exit() tears the runtime down, and on
// Windows that fires `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`
// (uv_async.c:76) -> abort, exit code 0xC0000409. It is not caused by any SQL:
// two `SELECT 1` statements against Turso reproduce it, ten of them do not.
// So the run would report every statement executed and still exit non-zero,
// which reads as a failure. Letting the loop drain exits 0 reliably.
process.exitCode = failures.length ? 1 : 0;
