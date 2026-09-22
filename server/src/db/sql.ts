import type { Transaction } from '@libsql/client';
import { db } from './client.js';
import type { Args, Bind, Row } from './driver.js';
import { AppError } from '../http/errors.js';

export type { Args, Bind, Binds, Row } from './driver.js';

/**
 * Query helpers.
 *
 * The rule this file exists to enforce: **values are always bound, identifiers
 * are always allowlisted.** A table or column name can never be interpolated
 * from a request, because SQLite cannot bind an identifier — so every place that
 * needs a dynamic name routes it through `ident()` against a list the resource
 * descriptor declares. `quoteIdent` is then belt-and-braces on top.
 *
 * ★ This file is backend-agnostic on purpose. It talks to `db` (the driver seam
 *   in `driver.ts`) and never to a specific database, which is what makes
 *   `DB_MODE=oracle` a change in one factory rather than in every route. The two
 *   dialect leaks that remain are deliberate and marked: the SQLite-flavoured
 *   `?` binds, which the Oracle driver rewrites, and `withTransaction`, which
 *   Oracle refuses because the account holds no write privilege.
 */

export async function rows<T = Row>(sql: string, args: Args = []): Promise<T[]> {
  const res = await db.execute({ sql, args });
  return res.rows as unknown as T[];
}

export async function one<T = Row>(sql: string, args: Args = []): Promise<T | null> {
  const res = await db.execute({ sql, args });
  return (res.rows[0] as unknown as T | undefined) ?? null;
}

/**
 * `COUNT(*)`, `SUM(...)`, and friends.
 *
 * A missing row yields 0, which is what an aggregate over no rows actually
 * means — this is deliberately different from "the query failed", which throws.
 * The two must stay distinguishable: a swallowed error that also returned 0 once
 * produced a fake −100% delta in this project's history, and the whole reason a
 * failed query is allowed to throw here is so that cannot recur.
 */
export async function scalar(sql: string, args: Args = []): Promise<number> {
  const row = await one<Record<string, unknown>>(sql, args);
  if (!row) return 0;
  return toNumber(Object.values(row)[0]);
}

/** Sum that keeps `null` distinct from `0` — for "no rows" vs "rows summing to zero". */
export async function scalarOrNull(sql: string, args: Args = []): Promise<number | null> {
  const row = await one<Record<string, unknown>>(sql, args);
  if (!row) return null;
  const v = Object.values(row)[0];
  if (v === null || v === undefined) return null;
  return toNumber(v);
}

/**
 * Read one *named* number out of a row that holds several aggregates.
 *
 * `row?.total ?? 0` is the idiom that has already produced a false "the table is
 * empty" in this project, and the reason is that a missing row and a true zero
 * are different answers where only one of them is right. `scalar()` cannot help
 * here because it reads the first column only; a summary shaped as
 * `SELECT (SELECT COUNT(*) …) AS a, (SELECT SUM(…) …) AS b, …` needs a named read,
 * and this is the one that refuses to invent a value.
 *
 * Deliberately stricter than `toNumber`: an aggregate that came back as a string,
 * a blob or nothing at all is an internal fault, not a zero, and it raises as one
 * rather than being quietly rounded into a number a caller would believe.
 */
export function columnNumber(row: Record<string, unknown> | null | undefined, key: string): number {
  const value = row?.[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new AppError(
    500,
    'INTERNAL',
    `The database returned ${JSON.stringify(value ?? null)} for "${key}", which is not a finite number.`,
  );
}

/** Narrow an unknown column value to a finite number, treating anything else as 0. */
function toNumber(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export interface WriteResult {
  rowsAffected: number;
  lastInsertRowid: number | null;
}

export async function execute(sql: string, args: Args = []): Promise<WriteResult> {
  const res = await db.execute({ sql, args });
  return {
    rowsAffected: res.rowsAffected,
    lastInsertRowid: res.lastInsertRowid,
  };
}

/**
 * Run several statements atomically.
 *
 * ★ The callback MUST throw to roll back. If it returns normally the transaction
 *   commits — a `throw` placed *after* the call returns does not undo anything,
 *   because by then the commit has already happened. Every caller here is
 *   written to validate inside `fn`, never after it.
 *
 * ★ There are currently NO callers. It is kept because deleting it would remove
 *   the one place that documents the throw-inside-`fn` rule that already cost
 *   this project a probe writing to a live row. Under Oracle it throws on
 *   principle: every grant on the account is SELECT, so there is no write
 *   transaction to open.
 */
export async function withTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  const tx = await db.transaction();
  try {
    const result = await fn(tx);
    await tx.commit();
    return result;
  } catch (e) {
    try {
      await tx.rollback();
    } catch {
      /* A failed rollback must not mask the original error. */
    }
    throw e;
  }
}

/**
 * Convert a request value into something the driver will accept as a bind.
 *
 * libSQL takes `string | number | bigint | ArrayBuffer | null` and nothing else.
 * A boolean or a `Date` reaching `args` produces a runtime throw from the driver
 * rather than a validation message, so the conversion happens here where it can
 * be deliberate: a boolean becomes 0/1, and a Date becomes an ISO string (the
 * sample stores dates as text, and a `Date` serialised by the driver would
 * arrive as a UTC instant that compares wrong against `YYYY-MM-DD`).
 *
 * ★ The boolean→0/1 rule is a **SQLite-shaped answer** and is the one place a
 *   caller can quietly do the wrong thing on Oracle: EBS flag columns hold
 *   `'Y'`/`'N'`, so `ENABLED_FLAG = 0` matches nothing and returns an empty
 *   result that looks like "no data". Under `DB_MODE=oracle`, compare flags to
 *   the character in the SQL rather than binding a boolean here.
 */
export function bindable(value: unknown): Bind {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return value;
  throw AppError.badRequest(
    `Cannot store a value of type ${Array.isArray(value) ? 'array' : typeof value}.`,
    { valueType: Array.isArray(value) ? 'array' : typeof value },
  );
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Resolve a request-supplied identifier against an allowlist.
 *
 * Returns a quoted, safe fragment or throws. The allowlist is the security
 * control; the quoting means that even a mistake in an allowlist cannot break
 * out of the identifier position.
 */
export function ident(name: string, allowed: readonly string[], what = 'field'): string {
  const found = allowed.find((a) => a.toLowerCase() === name.trim().toLowerCase());
  if (!found) {
    throw AppError.badRequest(
      `Unknown ${what} "${name}". Allowed: ${allowed.join(', ')}.`,
      { allowed },
    );
  }
  return quoteIdent(found);
}

// ---------------------------------------------------------------------------
// Search, sort, paginate
// ---------------------------------------------------------------------------

/**
 * Build a `LIKE` pattern with the user's own wildcards neutralised.
 *
 * Without this, a search for "50%" silently matches everything, and a search for
 * "_" matches any single character — the term stops meaning what the user typed.
 */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function likeClause(columns: readonly string[], term: string, bindPrefix = 'q'): { sql: string; args: Record<string, unknown> } {
  const args: Record<string, unknown> = {};
  const clauses = columns.map((col, i) => {
    const key = `${bindPrefix}${i}`;
    args[key] = likePattern(term);
    return `${quoteIdent(col)} LIKE :${key} ESCAPE '\\'`;
  });
  return { sql: `(${clauses.join(' OR ')})`, args };
}

export type SortDirection = 'asc' | 'desc';

export interface Sort {
  column: string;
  direction: SortDirection;
}

/**
 * Parse `?sort=column,-other` into an ordered list, rejecting anything not
 * allowlisted. `-` prefixes descending, matching the convention the frontend
 * already uses for its table headers.
 */
export function parseSort(raw: string | undefined, sortable: readonly string[]): Sort[] {
  if (!raw) return [];
  const out: Sort[] = [];
  for (const part of raw.split(',')) {
    const token = part.trim();
    if (!token) continue;
    const descending = token.startsWith('-');
    const name = descending ? token.slice(1) : token;
    const found = sortable.find((s) => s.toLowerCase() === name.toLowerCase());
    if (!found) {
      throw AppError.badRequest(`Cannot sort by "${name}".`, { sortable });
    }
    out.push({ column: found, direction: descending ? 'desc' : 'asc' });
  }
  return out;
}

export function orderByClause(sorts: readonly Sort[], fallback: string): string {
  if (sorts.length === 0) return `ORDER BY ${fallback}`;
  const parts = sorts.map((s) => `${quoteIdent(s.column)} ${s.direction === 'desc' ? 'DESC' : 'ASC'}`);
  return `ORDER BY ${parts.join(', ')}`;
}

/** `NULLS LAST` has no portable form in SQLite, so it is done with a CASE. */
export function nullsLast(column: string): string {
  return `CASE WHEN ${quoteIdent(column)} IS NULL THEN 1 ELSE 0 END`;
}

export interface Pagination {
  limit: number;
  offset: number;
}

export interface PageMeta extends Pagination {
  total: number;
  returned: number;
}

export function pageMeta(p: Pagination, total: number, returned: number): PageMeta {
  return { ...p, total, returned };
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}
