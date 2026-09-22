/**
 * Minimal ambient typings for `oracledb`.
 *
 * WHY THIS FILE EXISTS
 *   node-oracledb 7.0.1 ships no `.d.ts` and there is no `@types/oracledb`, so a
 *   plain `import oracledb from 'oracledb'` fails to compile under `strict` with
 *   TS7016. The alternative — `skipLibCheck` plus `any` — would switch off type
 *   checking for the one module whose API is least forgiving.
 *
 *   So this declares exactly the surface `src/db/oracle.ts` uses, and nothing
 *   more. It is deliberately small: every member here is one the driver actually
 *   calls, which keeps the risk of a *wrong* declaration low. If a wider API is
 *   needed later, add the specific member rather than reaching for `any`.
 *
 * ★ WHY BOTH NAMED EXPORTS AND A DEFAULT
 *   The real module is CommonJS (`module.exports = oracledb`), and node's named
 *   export detection cannot see the names on an object assembled at runtime — so
 *   `import oracledb from 'oracledb'` is the only *runtime-safe* import, because
 *   a default import resolves to `module.exports` whatever it contains. But a
 *   default import is a value, not a namespace, so `oracledb.Connection` in type
 *   position would not resolve. Hence: the interfaces are named exports and the
 *   default export is the object. `import type { Connection }` is erased at
 *   compile time, so it carries no runtime risk even though node cannot see it.
 */
declare module 'oracledb' {
  /** One column of a result set. `name` is Oracle's, i.e. usually UPPERCASE. */
  export interface Metadata {
    name: string;
    dbType?: number;
    nullable?: boolean;
  }

  export interface ExecuteResult<T> {
    rows?: T[];
    rowsAffected?: number;
    metaData?: Metadata[];
  }

  export interface ExecuteOptions {
    outFormat?: number;
    autoCommit?: boolean;
    maxRows?: number;
  }

  export interface Connection {
    execute<T = Record<string, unknown>>(
      sql: string,
      binds?: unknown,
      options?: ExecuteOptions,
    ): Promise<ExecuteResult<T>>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    close(): Promise<void>;
    break(): Promise<void>;
    ping(): Promise<void>;
  }

  export interface Pool {
    getConnection(): Promise<Connection>;
    close(drainTimeSeconds?: number): Promise<void>;
    readonly connectionsOpen: number;
    readonly connectionsInUse: number;
  }

  export interface PoolAttributes {
    user: string;
    password: string;
    connectString: string;
    /** `SYSDBA` or `SYSOPER`. */
    privilege?: number;
    poolMin?: number;
    poolMax?: number;
    poolIncrement?: number;
    poolTimeout?: number;
    queueTimeout?: number;
    connectTimeout?: number;
    walletLocation?: string;
    walletPassword?: string;
    /**
     * ★ CALLBACK-STYLE, not promise-style, and this signature is load-bearing.
     *
     * The real module invokes this as the third argument of a `new Promise` and
     * NEVER awaits its return value (`lib/pool.js:548`). An `async (conn) => …`
     * therefore returns an orphaned promise, `done()` is never called, and the
     * request dies at `queueTimeout` with "NJS-040: connection request timeout"
     * — an error that names the timeout and not the cause. Measured: callback
     * style 532 ms, promise style FAIL 8,334 ms NJS-040.
     *
     * An earlier revision of this file declared it as returning
     * `Promise<void>`, which type-checked the *broken* form and failed the
     * working one. The `done` error argument is `unknown`-safe at the call site
     * only because the driver casts; see `oracle.ts`.
     */
    sessionCallback?: (
      connection: Connection,
      requestedTag: string,
      done: (error?: Error) => void,
    ) => void;
  }

  export interface InitOptions {
    libDir?: string;
    configDir?: string;
    driverName?: string;
  }

  /**
   * The hook consulted for every column as it is fetched.
   *
   * Returning `{ type: oracledb.STRING }` asks the driver to hand that column
   * back as a string instead of a JS `Date`; returning `undefined` leaves the
   * default alone. The real API also accepts a converter function, which this
   * driver does not use.
   */
  export type FetchTypeHandler = (metaData: Metadata) => { type: number } | undefined;

  /** The shape of the default export, i.e. of `module.exports`. */
  export interface Oracledb {
    // --- selection constants used by the driver -------------------------
    readonly OUT_FORMAT_OBJECT: number;
    readonly OUT_FORMAT_ARRAY: number;

    // --- column type constants ------------------------------------------
    /**
     * `DB_TYPE_*` values, for `fetchAsString`, `fetchTypeHandler` and
     * `fetchAsString`-style options.
     *
     * ★ The numbers are real and they matter. `DB_TYPE_DATE` is 2011 and
     * `DB_TYPE_TIMESTAMP` is 2012; they are NOT interchangeable, and
     * `fetchAsString` accepts only part of the 2xxx range — it rejects
     * `DB_TYPE_DATE` outright with NJS-021.
     *
     * There is deliberately no `DATE` member. The real module has no such
     * alias, and an earlier revision of this file invented one pointing at
     * 2012, so `fetchAsString = [oracledb.DATE]` looked like "stringify the
     * dates" while actually meaning "stringify the timestamps" and did nothing
     * for the DATE columns it was written for.
     */
    readonly DB_TYPE_VARCHAR: number;
    readonly DB_TYPE_NUMBER: number;
    readonly DB_TYPE_DATE: number;
    readonly DB_TYPE_TIMESTAMP: number;
    /** Aliases of `DB_TYPE_VARCHAR` / `DB_TYPE_NUMBER`, as the real module exposes them. */
    readonly STRING: number;
    readonly NUMBER: number;

    // --- connection privilege constants ---------------------------------
    /** Pass as `PoolAttributes.privilege`. */
    readonly SYSDBA: number;
    readonly SYSOPER: number;

    // --- process-wide settings ------------------------------------------
    /**
     * Mutable and process-wide — which is why `execute` must never rely on a
     * caller-set value. Set once inside the pool factory instead.
     */
    outFormat: number;
    /** Column types that should arrive as strings, e.g. `[oracledb.DB_TYPE_TIMESTAMP]`. */
    fetchAsString: number[];
    /**
     * The mechanism that can actually stringify a DATE, because it is consulted
     * for every column rather than being restricted to the `fetchAsString`
     * subset. Set once, in the pool factory — it is process-wide.
     */
    fetchTypeHandler?: FetchTypeHandler;
    autoCommit: boolean;

    createPool(attrs: PoolAttributes): Promise<Pool>;
    getConnection(attrs: PoolAttributes): Promise<Connection>;
    /** Throws if called a second time in the same process. Guard the call. */
    initOracleClient(opts?: InitOptions): void;
    /**
     * ★ Not reliably present. Measured absent on the 7.0.1 CommonJS export, so
     * the driver guards with `typeof … === 'function'`. Declared optional here
     * so that guard reads as the honest representation rather than dead code —
     * a required declaration would make the broken call type-check.
     */
    getClientVersion?(): string;
    /**
     * ★ NOT a thin/thick signal, despite the name. Measured `true` even after
     * `initOracleClient()` succeeds, so it cannot be used to detect whether the
     * Instant Client loaded. Use `getClientVersion()`, or simply the absence of
     * a throw from `initOracleClient`.
     */
    readonly thin: boolean;
  }

  const oracledb: Oracledb;

  export default oracledb;
}
