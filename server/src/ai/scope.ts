import { readFileSync } from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../config/env.js';

/**
 * The population an answer is computed over, and the reason it has to be stated.
 *
 * ── ★★ THE SAME QUESTION HAS ANSWERS 23× APART HERE, AND NOTHING IS WRONG
 *
 *   Measured on this extract, for "what was the highest check paid in July":
 *
 *     | population                                    | July checks | highest      |
 *     |-----------------------------------------------|-------------|--------------|
 *     | every check in the file                       | 3,261       | $18,043,056.47 |
 *     | **the checks this register shows (Fund 04,     | **22**      | **$778,481.55** |
 *     | program 861/862/863)**                         |             |              |
 *
 *   Both are correct answers to what the reader typed. The difference is the one
 *   thing a text box cannot carry: which rows were being asked about. A model
 *   handed rows would answer confidently and be right about the wrong population —
 *   and the reader would have no way to tell, because both figures look like money.
 *
 *   So the scope is applied **server-side, from the caller's own organization**,
 *   and the answer states its basis. That is the whole reason this file exists
 *   rather than the route summing whatever it finds.
 *
 * ── WHY THE SERVER READS THE EXTRACTS THE FRONTEND ALREADY HAS
 *
 *   The checks register is a static JSON file the browser fetches, so the register's
 *   rows were never the server's to count. Answering a question about them
 *   server-side therefore means re-deriving the same population from the same file.
 *   The alternative — posting the rows to the server, or to the model — would put the
 *   data and the arithmetic in different places from the scope, and would mean the
 *   answer depends on what happened to be on screen rather than on what the caller is
 *   entitled to see.
 *
 * —————————————————————————————————————————————————————————————————————————————
 * ★★ THE SECOND COPY OF THE SCOPE RULE, AND WHAT IS DONE ABOUT IT
 *
 * `inScope` below is a **second implementation** of the predicate in
 * `app/src/data/scope.ts`. It is not a re-export and the server cannot import the
 * app's module: one is an ESM server bundle, the other is a Vite client bundle.
 *
 * This codebase has already been bitten twice by hand-copied lists drifting, and
 * **the fix is not a comment asking the two to agree** — it is a check that reads
 * both and fails when they do not. That check is in `scripts/smoke.ts`
 * ("the assistant's scope rule agrees with the register's"), it asserts the two
 * predicates return the same answer over a table of cases including the empty
 * program list, and it exists because a comment would have done nothing.
 *
 * If you change the rule in one file, that check fails and names the other file.
 */

/** Which fund and which programs — the caller's tenant scope, not a literal. */
export interface AiScope {
  fund: string;
  programs: string[];
}

/**
 * The predicate, mirroring `app/src/data/scope.ts`'s `inScope` exactly.
 *
 * The three clauses are the app's three clauses, including the one that surprises:
 * **an empty program list means "the fund alone is the rule"**, not "no programs".
 * That is a selection a reader can reach on purpose (the popover's *Clear programs*
 * button writes it), so treating it as an empty result would answer "there is
 * nothing" to a reader who had narrowed to a fund and no further.
 *
 * An empty fund fails closed: a row that cannot say what fund it is in is not a row
 * this scope has any business claiming.
 */
export function inScope(scope: AiScope, fund: string, program: string): boolean {
  const f = String(scope.fund ?? '').trim();
  if (f === '') return false;
  if (String(fund ?? '').trim() !== f) return false;
  const wanted = (scope.programs ?? []).map((p) => String(p).trim()).filter(Boolean);
  if (wanted.length === 0) return true;
  return wanted.includes(String(program ?? '').trim());
}

/** One check, as the register's own loader builds it. */
export interface AiCheck {
  id: number;
  number: string;
  date: string;
  amount: number;
  vendor: string;
}

/** The extract, loaded once. */
interface Extract {
  checks: AiCheck[];
  /** `CHECK_ID` → the segments of every account its invoices are booked to. */
  accountsByCheck: Map<number, string[][]>;
  /** The dates actually present, so the assistant states its own window. */
  window: { from: string; to: string };
  /** What `invoices.json` says was applied when the slice was cut. */
  applied: {
    fund: string;
    programs: string[];
    label: string;
    windowInvoices: number;
    inScope: number;
  } | null;
}

const figure = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const readJson = (file: string): unknown =>
  JSON.parse(readFileSync(path.join(REPO_ROOT, 'data', 'oracle', file), 'utf8'));

let cached: Extract | null = null;

/**
 * Read both extracts and join them.
 *
 * ★ THE JOIN GOES THROUGH THE INVOICE, NOT THE CHECK, AND THAT IS THE ONLY JOIN
 *   THAT EXISTS. `checks.json` carries 9,451 check→invoice links but no account
 *   code at all; the account is on the *invoice's distributions*, which only
 *   `invoices.json` has. So "which accounts is this check booked to" is
 *   check → its invoices → those invoices' accounts, and every segment test is made
 *   on the result.
 *
 *   (The join is many-to-many in both directions — a check carries up to 269
 *   invoices and an invoice up to 7 accounts — so the map holds a *list of segment
 *   lists* rather than one code. Flattening it to a single account would be a lie
 *   for most of the table.)
 *
 * The cost is one synchronous read of a ~1.8 MB file, memoised. It is deliberately
 * not loaded at start-up: most requests never ask a question, and the register's own
 * page already pays for the file once in the browser.
 */
export function loadExtract(): Extract {
  if (cached) return cached;

  const checksRaw = readJson('checks.json') as {
    body?: { ResultSets?: { Table1?: unknown[]; Table2?: unknown[] } };
  };
  const invoicesRaw = readJson('invoices.json') as {
    body?: { ResultSets?: { Table1?: unknown[]; Table2?: unknown[]; Table3?: unknown[] } };
    scope?: Record<string, unknown>;
  };

  const table1 = checksRaw?.body?.ResultSets?.Table1;
  if (!Array.isArray(table1)) {
    throw new Error('data/oracle/checks.json has no body.ResultSets.Table1 array.');
  }
  const invLinks = invoicesRaw?.body?.ResultSets?.Table2;
  const invAccounts = invoicesRaw?.body?.ResultSets?.Table3;

  // The seven segments, in order, as strings — the same assembly `invoices.ts`
  // does client-side. `SEGMENT1` is the fund and `SEGMENT3` the program.
  const SEGMENT_KEYS = ['SEGMENT1', 'SEGMENT2', 'SEGMENT3', 'SEGMENT4', 'SEGMENT5', 'SEGMENT6', 'SEGMENT7'];

  const accountsByInvoice = new Map<number, string[][]>();
  for (const row of Array.isArray(invAccounts) ? (invAccounts as Record<string, unknown>[]) : []) {
    const key = Number(row.INVOICE_ID);
    if (!Number.isFinite(key)) continue;
    const segments = SEGMENT_KEYS.map((k) => String(row[k] ?? '').trim());
    const list = accountsByInvoice.get(key);
    if (list) list.push(segments);
    else accountsByInvoice.set(key, [segments]);
  }

  const accountsByCheck = new Map<number, string[][]>();
  for (const row of Array.isArray(invLinks) ? (invLinks as Record<string, unknown>[]) : []) {
    const checkId = Number(row.CHECK_ID);
    if (!Number.isFinite(checkId)) continue;
    const accounts = accountsByInvoice.get(Number(row.INVOICE_ID)) ?? [];
    if (accounts.length === 0) continue;
    const list = accountsByCheck.get(checkId);
    if (list) list.push(...accounts);
    else accountsByCheck.set(checkId, [...accounts]);
  }

  const checks: AiCheck[] = (table1 as Record<string, unknown>[]).map((r) => ({
    id: Number(r.CHECK_ID),
    number: String(r.CHECK_NUMBER ?? '').trim(),
    date: String(r.CHECK_DATE ?? '').slice(0, 10),
    amount: figure(r.AMOUNT),
    vendor: String(r.VENDOR_NAME ?? '').trim(),
  }));

  const dates = checks.map((c) => c.date).filter(Boolean).sort();

  const scopeRaw = invoicesRaw?.scope;
  cached = {
    checks,
    accountsByCheck,
    window: { from: dates[0] ?? '', to: dates[dates.length - 1] ?? '' },
    applied:
      scopeRaw && typeof scopeRaw.fund === 'string'
        ? {
            fund: String(scopeRaw.fund),
            programs: Array.isArray(scopeRaw.programs) ? scopeRaw.programs.map(String) : [],
            label: String(scopeRaw.label ?? ''),
            windowInvoices: Number(scopeRaw.windowInvoices ?? 0),
            inScope: Number(scopeRaw.inScope ?? 0),
          }
        : null,
  };

  return cached;
}

/** The population, with everything a disclosure needs to say what it is. */
export interface Population {
  /** The rows the answer is computed over. */
  rows: AiCheck[];
  /** The scope the rows were narrowed by. */
  scope: AiScope;
  /** How many rows the extract holds before narrowing. */
  read: number;
  /** The dates present in the file. */
  window: { from: string; to: string };
  /**
   * ★ HOW MANY ROWS CARRY NO ACCOUNT AT ALL — and why this is not `read - rows.length`.
   *
   *   A check with no invoice, or whose invoices have no distributions, has no Fund
   *   and no Program to test. It is not *excluded by the scope*; the scope is a
   *   question the register cannot answer about it. The invoices extract already
   *   makes this distinction in its own `.scope` block (`unanswerable` beside
   *   `excluded`, with the reason that the only two real-money invoices in the
   *   window live in the unanswerable bucket), and collapsing the two here would
   *   invent a rule that removed rows the scope never saw.
   *
   *   Measured on this extract: 4,218 checks read, **65** carry an account row,
   *   and every one of those 65 is in scope — so `excluded` is 0 here and the
   *   subtraction happens to be exact. That is a coincidence of this slice, not a
   *   property of the rule, and the two numbers are kept apart for that reason.
   */
  withoutAccounts: number;
  /** Rows that *had* an account to test and failed the scope. */
  excluded: number;
}

/**
 * Narrow the extract to the caller's scope.
 *
 * A check is in scope when **any one** of its invoice accounts is. That is the same
 * `.some()` the register's page performs, and it is the right choice for the same
 * reason: a check booked across seven accounts is one check, and a reader looking at
 * a Fund 04 register expects to see it because part of it is theirs.
 */
export function narrow(scope: AiScope): Population {
  const extract = loadExtract();

  const rows: AiCheck[] = [];
  let withoutAccounts = 0;
  let excluded = 0;

  for (const check of extract.checks) {
    const accounts = extract.accountsByCheck.get(check.id) ?? [];
    if (accounts.length === 0) {
      withoutAccounts += 1;
      continue;
    }
    // ★ A CHECK WITH NO ACCOUNT IS COUNTED BEFORE THE SCOPE IS EVER TESTED. `segs[0]`
    //   and `segs[2]` are the fund and the program; an absent one becomes `''`, which
    //   `inScope` refuses — so a malformed account fails closed rather than matching
    //   a scope whose fund happens to be blank.
    if (accounts.some((segs) => inScope(scope, segs[0] ?? '', segs[2] ?? ''))) rows.push(check);
    else excluded += 1;
  }

  return {
    rows,
    scope,
    read: extract.checks.length,
    window: extract.window,
    withoutAccounts,
    excluded,
  };
}

/** What the slice's own envelope claims was applied, for a disclosure to compare against. */
export function appliedScope(): Extract['applied'] {
  return loadExtract().applied;
}
