import {
  createClient,
  type InArgs,
  type Client,
  type Row,
  type Transaction,
} from '@libsql/client';
import { config, type DbTarget } from '../config/env.js';

/**
 * The database seam.
 *
 * WHY THIS FILE EXISTS
 *   `sql.ts` is the only module that reads or writes rows, and every route goes
 *   through it. Its whole surface is `execute({ sql, args })`. That is the
 *   narrowest thing a database backend has to provide, so that is what the
 *   interface below fixes — and it means switching the backend is a change to
 *   one factory call rather than to six route modules.
 *
 * ★ `execute` takes an OPTIONAL `args`, and libSQL's own signatures make it
 *   required. Every call site in this repo passes `[]` explicitly, so accepting
 *   `| undefined` here is strictly more permissive and cannot break a caller.
 *
 * ★ `Args` is re-declared rather than imported under its libSQL name so that the
 *   rest of the codebase names a *bind argument list*, not a libSQL concept. Its
 *   members are libSQL's `InValue` set because that is already what 14 files
 *   pass and what `bindable()` produces; the Oracle driver validates each value
 *   at its own boundary, where the error can name the offending position.
 */

export type Args = InArgs;

/** A single value either backend can bind. */
export type Bind = string | number | bigint | Uint8Array | null;

/** A named-bind map — keys are the `:name` tokens in the SQL. */
export type Binds = Record<string, Bind>;

/**
 * Re-exported so route modules keep importing their query types from the
 * database layer rather than from `@libsql/client` directly.
 *
 * Retyping these to a hand-rolled union would be a large, breakage-prone edit
 * across 14 files for no behavioural gain, so the libSQL types stay the shared
 * vocabulary — and the Oracle driver converts each bind at its own boundary,
 * which is where the error message can name the offending value and position.
 */
export type { Row };

export interface ExecResult {
  rows: Row[];
  rowsAffected: number;
  /** libSQL-only. Oracle has no equivalent and always reports `null`. */
  lastInsertRowid: number | null;
  /**
   * Column names in select order, when the backend reports them.
   *
   * ★ Added for the View Builder, and it is not a convenience. A result with zero
   *   rows still *has* columns, and the whole point of running `SELECT …` with no
   *   rows is to learn what it returns. Deriving the column list from
   *   `Object.keys(rows[0])` reports "no columns" for an empty result, which the
   *   builder would then render as a successful query of nothing — indistinguishable
   *   from a typo, and the exact confusion the plan's §10.5 warns about.
   *
   * Optional because a backend may not provide it. A caller that needs columns
   * falls back to the first row when this is absent, which is only wrong for the
   * empty case.
   */
  columns?: string[];
}

export interface SqlDriver {
  /**
   * Which engine is underneath. Read by the guards that must spell a construct
   * differently per dialect (row caps, the query guard, the ledger shape check).
   *
   * ★ `'sqlserver'` IS A THIRD MEMBER, NOT A SYNONYM FOR `'oracle'`. Both are
   *   "not SQLite" to the routes, but they disagree on the things the guards ask
   *   about: T-SQL pages with `OFFSET/FETCH` and has no `DUAL`, Oracle pages with
   *   `FETCH FIRST` and requires one. Collapsing them would make every
   *   dialect-aware branch a coin flip.
   */
  readonly dialect: 'sqlite' | 'oracle' | 'sqlserver';
  /**
   * A one-row, one-column statement that proves the connection works.
   *
   * It is a property rather than a constant because Oracle requires a `FROM`
   * clause on a version that predates 23c, so `SELECT 1` is a syntax error
   * (ORA-00923) where SQLite is happy with it.
   */
  readonly ping: string;
  execute(req: { sql: string; args?: Args }): Promise<ExecResult>;
  /** A write transaction. Only libSQL implements this — see `withTransaction`. */
  transaction(): Promise<Transaction>;
  close(): Promise<void>;
  /** Dialect-specific per-connection setup. Best-effort; must never throw. */
  prepare(): Promise<void>;
}

/**
 * The libSQL backend: the local sample file and the remote Turso database.
 *
 * ★ THE TARGET IS A PARAMETER, WITH `config.db` AS THE DEFAULT.
 *   Until the app-owned store could be a *different* database, "which config does
 *   this driver read" had one answer and the driver could reach into the config
 *   itself. There are now two libSQL stores — the ledger and the app's own tables —
 *   and passing the target in is what lets one factory serve both without the
 *   second one quietly opening the first one's URL.
 */
export function createLibsqlDriver(
  target: Pick<DbTarget, 'url' | 'authToken'> = config.db,
): SqlDriver {
  const client: Client = createClient({
    url: target.url,
    ...(target.authToken === undefined ? {} : { authToken: target.authToken }),
  });

  return {
    dialect: 'sqlite',
    ping: 'SELECT 1 AS ok',

    async execute(req) {
      const res = await client.execute({ sql: req.sql, args: req.args ?? [] });
      const id = res.lastInsertRowid;
      return {
        rows: res.rows as unknown as Row[],
        rowsAffected: res.rowsAffected,
        lastInsertRowid: id === undefined || id === null ? null : Number(id),
        columns: Array.isArray(res.columns) ? [...res.columns] : undefined,
      };
    },

    transaction: () => client.transaction('write'),

    async close() {
      // Synchronous in libSQL, but awaited here so the caller's `await` is
      // correct for both backends and adding one later cannot silently skip it.
      client.close();
    },

    async prepare() {
      try {
        await client.execute('PRAGMA foreign_keys = ON');
      } catch {
        /* Remote libSQL does not accept all pragmas; not fatal. */
      }
    },
  };
}
