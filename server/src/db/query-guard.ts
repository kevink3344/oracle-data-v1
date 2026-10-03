/**
 * The View Builder's query guard.
 *
 * WHY THIS IS A SEPARATE FILE WITH NO IMPORTS
 *   The View Builder runs SQL a person typed. That is the whole feature and the
 *   whole risk, so the part that decides whether a statement may run is kept
 *   apart from the part that runs it: nothing here touches the driver, Express,
 *   or config, and every export is a pure string function. That is what makes
 *   the refusals (V3, V5, V6, V7 in the plan) testable without a database, and
 *   what lets the same functions answer "may this run?" and "what is wrong with
 *   it?" without a second implementation drifting out of step.
 *
 * ★ THE GUARD IS NOT THE SECURITY BOUNDARY. The read-only scoped Turso token is
 *   — it is the only layer that cannot be bypassed from inside the query text.
 *   Everything below is defence in depth and error reporting: it stops the
 *   mistakes a person makes at a keyboard and explains them, so the token never
 *   has to be the thing that says no. Anything that treats an allowlist as the
 *   wall rather than the alarm is one clever string away from a surprise.
 *
 * THE LAYERS, IN THE ORDER THE PLAN MEASURED THEM
 *   1. read-only scoped credential        (config, not here)
 *   2. `prepare()`, never `exec()`        (the driver seam — see db/sql.ts)
 *   3. *this file* — statement allowlist  (single statement; SELECT/WITH only)
 *   4. `PRAGMA query_only = ON`           (the route, local mode only)
 *   5. reject `;` outright                (this file — a UX guard, see below)
 *
 *   Layer 5 is not a security control and must not be described as one. `exec()`
 *   silently discards everything after the first statement, so `SELECT 1; DROP
 *   TABLE PO_LINE_TYPES` does not drop anything through the driver — it returns
 *   1 and the author believes their second statement ran. The `;` refusal exists
 *   because a *silent* truncation is worse than an error, not because the
 *   second statement would have executed.
 */

/**
 * Something the author should know about their SQL, with the port already
 * written out.
 *
 * `severity: 'error'` is a refusal (the statement does not run); `'warning'` is
 * a caveat the caller shows next to a result that did run. The plan's dialect
 * table uses exactly these two levels, and `TRUNC(SYSDATE)` is the reason the
 * distinction has to exist at all: it is wrong silently rather than loudly.
 */
export interface GuardFinding {
  /** Stable machine code, e.g. `FETCH_FIRST`. Used as a React key and by tests. */
  code: string;
  severity: 'error' | 'warning';
  /** The construct as it appears, for the message: `FETCH FIRST`. */
  construct: string;
  /** What is wrong, in one sentence, naming the construct. */
  message: string;
  /** The SQLite spelling to use instead. Null when there is no direct swap. */
  fix: string | null;
  /** Offset into the statement where it was found, so a UI can point at it. */
  index: number;
}

/** Why a statement will not be run. The route turns this into a 400. */
export interface SqlRejection {
  code:
    | 'EMPTY'
    | 'MULTIPLE_STATEMENTS'
    | 'NOT_A_SELECT'
    | 'DENIED_KEYWORD'
    // ★ ONE CODE PER ARM THE LINT READ AGAINST, because "you wrote Oracle at
    //   SQLite" and "you wrote SQLite at SQL Server" are different mistakes with
    //   different fixes. A single `DIALECT_DIALECT` code could not say which.
    | 'ORACLE_DIALECT'
    | 'SQLSERVER_DIALECT';
  message: string;
  /** Extra machine-readable context for the response body's `details`. */
  details: Record<string, unknown>;
}

export interface SqlAnalysis {
  /** Non-null when the statement must not run. */
  rejection: SqlRejection | null;
  /** The statement with one trailing `;` and its surrounding whitespace removed. */
  statement: string;
  /** Everything worth telling the author, refusals included. */
  findings: GuardFinding[];
  /** `:name` tokens, in first-seen order, deduplicated. */
  params: string[];
}

/* ------------------------------------------------------------------------- *
 * Layer 5 and the scanner
 * ------------------------------------------------------------------------- */

/**
 * Replace every string literal, quoted identifier and comment with spaces,
 * keeping the string the same length and shape.
 *
 * ★ THIS IS THE LOAD-BEARING FUNCTION. Every keyword scan below runs over this
 *   masked text, because the naive version — `/\bDROP\b/i.test(sql)` — refuses
 *   `SELECT 'DROP' AS note`, and a guard that rejects correct SQL is a guard
 *   people learn to work around. Masking rather than deleting keeps offsets
 *   valid, so a finding can still point at the right column.
 *
 * The state machine **always** tracks literals, so that a `--` inside `'a--b'`
 * is not mistaken for a comment; the flags only decide whether a matched span is
 * blanked. That is what keeps the two masking modes consistent with each other:
 *
 *   - `maskLiterals` — literals *and* comments blanked. For keyword/param scans.
 *   - `maskComments` — comments blanked, literals **kept**. For trimming the
 *     trailing `;`, where a literal `';'` must survive but a `;` in a trailing
 *     comment must not count.
 *
 * Handles `'…'`, `"…"`, `` `…` `` (with doubled-quote escapes), `[…]`
 * identifiers, `--` to end of line, and slash-star block comments.
 *
 * ★ THE THIRD FLAG EXISTS FOR TABLE-NAME SCANNING, AND IT IS NOT A REFINEMENT.
 *   Everything in this codebase quotes identifiers with `"` (`quoteIdent` in
 *   `db/sql.ts`), so a scan that blanks double-quoted spans blanks the very names
 *   it is looking for: `FROM "GL_LEDGERS"` would mask to `FROM           `, and
 *   every statement would appear to name no table at all. The two consumers
 *   genuinely want opposite things from the same span — a keyword scan must not
 *   see a word inside quotes, a name scan must see nothing else — so the span is
 *   classified as a literal or an identifier and only the caller decides.
 */
function mask(
  sql: string,
  blankLiterals: boolean,
  blankComments: boolean,
  blankQuotedIdentifiers = true,
): string {
  const out = sql.split('');
  const n = sql.length;
  let i = 0;

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < n; k += 1) {
      // Newlines survive, so offsets still line up with the original.
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    }
  };

  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];

    if (c === '-' && next === '-') {
      const eol = sql.indexOf('\n', i);
      const end = eol === -1 ? n : eol;
      if (blankComments) blank(i, end);
      i = end;
      continue;
    }

    if (c === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      if (blankComments) blank(i, end);
      i = end;
      continue;
    }

    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) {
            j += 2; // Doubled quote: '' inside a literal, "" inside an identifier.
            continue;
          }
          break;
        }
        j += 1;
      }
      const end = Math.min(j + 1, n);
      // A single quote opens a string; a double quote or a backtick opens an
      // identifier.
      if (blankLiterals && (c === "'" || blankQuotedIdentifiers)) blank(i, end);
      i = end;
      continue;
    }

    if (c === '[') {
      const close = sql.indexOf(']', i + 1);
      const end = close === -1 ? n : close + 1;
      if (blankLiterals && blankQuotedIdentifiers) blank(i, end);
      i = end;
      continue;
    }

    i += 1;
  }

  return out.join('');
}

/** Literals and comments blanked. For keyword and parameter scanning. */
export function maskLiterals(sql: string): string {
  return mask(sql, true, true);
}

/** Comments blanked, literals kept. For locating the end of the statement. */
export function maskComments(sql: string): string {
  return mask(sql, false, true);
}

/**
 * String literals and comments blanked, **quoted identifiers kept**.
 *
 * For finding table names, where `"GL_LEDGERS"` is the thing being looked for
 * rather than something to hide. See the `mask` doc block for why the other two
 * modes cannot serve this.
 *
 * The one thing it cannot tell apart is SQLite's legacy double-quoted *string*
 * (`WHERE x = "abc"`), which stays visible and could in principle be mistaken for
 * a name. It is not worth a branch: every value in this codebase is bound rather
 * than inlined, and the registered names are all identifiers, so a quoted string
 * equal to one would have to be deliberate.
 */
export function maskKeepingIdentifiers(sql: string): string {
  return mask(sql, true, true, false);
}

interface Word {
  text: string;
  upper: string;
  index: number;
}

/** Word tokens (identifiers and keywords) from masked text. */
function words(masked: string): Word[] {
  const found: Word[] = [];
  const re = /[A-Za-z_][A-Za-z0-9_$]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    found.push({ text: m[0], upper: m[0].toUpperCase(), index: m.index });
  }
  return found;
}

/** Every `;` outside a literal or comment, as offsets into the masked text. */
function semicolons(masked: string): number[] {
  const at: number[] = [];
  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] === ';') at.push(i);
  }
  return at;
}

/**
 * `:name` parameters, outside literals and comments.
 *
 * Only `:` — libSQL also accepts `@x` and `$x`, but the View Builder's declared
 * parameter list and the queries ported into `data/sql/turso/queries/` both use
 * `:name`, and accepting three spellings would mean the "undeclared token" error
 * has three cases to explain for no gain.
 */
export function extractParams(masked: string): string[] {
  const seen = new Set<string>();
  const re = /:([A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked)) !== null) {
    seen.add(m[1]!);
  }
  return [...seen];
}

/**
 * Drop a trailing `;`, plus any trailing comment or whitespace after it.
 *
 * ★ A LITERAL IS NOT A SEMICOLON. This is why the trim runs on comment-masked
 *   text rather than on `maskLiterals`: `SELECT ';'` legitimately ends with a
 *   semicolon *inside a string*, and a trim that could not tell the difference
 *   would cut it in half and hand an invalid statement to the database. The
 *   comment mask keeps the literal visible, so the trailing character is `'` and
 *   the loop stops where it should.
 *
 * One trailing `;` is punctuation; two would still leave one for the refusal in
 * `analyzeSql` to name, which is the intended split between "tolerate" and
 * "refuse".
 */
export function trimStatement(raw: string): string {
  const code = maskComments(raw);
  let end = code.length;
  for (;;) {
    while (end > 0 && /\s/.test(code[end - 1]!)) end -= 1;
    if (end > 0 && code[end - 1] === ';') {
      end -= 1;
      continue;
    }
    break;
  }
  return raw.slice(0, end).replace(/\s+$/, '');
}

/* ------------------------------------------------------------------------- *
 * Layer 3 — the statement allowlist
 * ------------------------------------------------------------------------- */

/**
 * Keywords that are refused wherever they appear, not just first.
 *
 * A first-token check alone is not enough because SQLite's `WITH` can carry a
 * write: `WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x`. Scanning every
 * masked word closes that, at the cost of a false positive on any identifier
 * that happens to be spelled like a write verb — which is why the list is
 * deliberately short. `REPLACE` is handled separately: it is both a write
 * (`REPLACE INTO`) and a string function (`replace(a,b,c)`), and refusing the
 * function would make several of the ported queries unrunnable.
 */
const DENIED_KEYWORDS: ReadonlyMap<string, string> = new Map([
  ['ATTACH', 'ATTACH'],
  ['DETACH', 'DETACH'],
  ['PRAGMA', 'PRAGMA'],
  ['VACUUM', 'VACUUM'],
  ['REINDEX', 'REINDEX'],
  ['INSERT', 'INSERT'],
  ['UPDATE', 'UPDATE'],
  ['DELETE', 'DELETE'],
  ['DROP', 'DROP'],
  ['ALTER', 'ALTER'],
  ['CREATE', 'CREATE'],
  ['TRUNCATE', 'TRUNCATE'],
  ['GRANT', 'GRANT'],
  ['REVOKE', 'REVOKE'],
  ['LOAD_EXTENSION', 'LOAD_EXTENSION'],
]);

/** Why each denied word is denied, and what to do instead. */
const DENIED_REASON: ReadonlyMap<string, { why: string; fix: string | null }> = new Map([
  ['ATTACH', { why: 'It opens a second database file on the connection.', fix: null }],
  ['DETACH', { why: 'It closes a database file on the connection.', fix: null }],
  [
    'PRAGMA',
    {
      why: 'It changes connection state, and it is the one route that survives query_only.',
      fix:
        'For the schema, read `sqlite_master` (e.g. SELECT name, sql FROM sqlite_master ' +
        "WHERE type = 'table'), or use GET /api/meta/dictionary.",
    },
  ],
  ['VACUUM', { why: 'It rewrites the database file.', fix: null }],
  ['REINDEX', { why: 'It rewrites indexes.', fix: null }],
  ['INSERT', { why: 'The View Builder runs reads.', fix: null }],
  ['UPDATE', { why: 'The View Builder runs reads.', fix: null }],
  ['DELETE', { why: 'The View Builder runs reads.', fix: null }],
  ['DROP', { why: 'The View Builder runs reads.', fix: null }],
  ['ALTER', { why: 'The View Builder runs reads.', fix: null }],
  ['CREATE', { why: 'The View Builder runs reads.', fix: null }],
  ['TRUNCATE', { why: 'The View Builder runs reads.', fix: null }],
  ['GRANT', { why: 'The View Builder runs reads.', fix: null }],
  ['REVOKE', { why: 'The View Builder runs reads.', fix: null }],
  [
    'LOAD_EXTENSION',
    { why: 'It loads native code into the process.', fix: null },
  ],
]);

/**
 * The engines this guard knows how to refuse for.
 *
 * ★ DECLARED HERE RATHER THAN IMPORTED FROM `driver.ts`, AND THAT IS THE FILE'S
 *   OWN RULE. The header above says this module has no imports and every export is
 *   a pure string function — that is what makes the refusals testable without a
 *   database. Importing the shared `Dialect` would be a type-only import and
 *   therefore erased at runtime, so it would not actually break the property…
 *   but it would break the *statement* of the property, and the next reader would
 *   have to check whether this one import is erased too.
 *
 *   The duplication is two lines and the compiler keeps the two in step: a member
 *   added to `Dialect` in `driver.ts` and not here surfaces as a type error at
 *   every call site that passes one, which is the same protection an import would
 *   give.
 */
type Dialect = 'sqlite' | 'oracle' | 'sqlserver' | 'mysql';

/**
 * Read a statement and decide whether it may run.
 *
 * Order matters, because the first refusal is the one the author reads:
 *
 *   1. empty
 *   2. strip ONE trailing `;`   — so `SELECT 1;` (V9) runs
 *   3. any `;` still present    — so `SELECT 1; DROP …` (V5) is named, not truncated
 *   4. denied keyword anywhere  — so `ATTACH …` (V6) and `INSERT …` (V7) are named
 *   5. first token SELECT/WITH  — so `EXPLAIN SELECT 1` is explained
 *   6. Oracle-only constructs   — so `FETCH FIRST` (V3) names `LIMIT n`
 */
export function analyzeSql(sql: string, dialect: Dialect = 'sqlite'): SqlAnalysis {
  const raw = typeof sql === 'string' ? sql : '';

  // Step 2. One trailing `;` is punctuation, not a second statement. Anything
  // after it survives step 3 and is reported by name.
  const statement = trimStatement(raw);
  const masked = maskLiterals(statement);
  const params = extractParams(masked);

  if (statement === '') {
    return {
      rejection: {
        code: 'EMPTY',
        message: 'There is no SQL to run. Type a SELECT statement, or open a saved view.',
        details: {},
      },
      statement,
      findings: [],
      params,
    };
  }

  // Step 3.
  const semis = semicolons(masked);
  if (semis.length > 0) {
    return {
      rejection: {
        code: 'MULTIPLE_STATEMENTS',
        message:
          'This looks like more than one statement. The View Builder runs a single statement, ' +
          'and the driver silently discards everything after the first `;` — so a second ' +
          'statement would appear to be ignored rather than refused. Remove the `;` (or split ' +
          'the work into a view and a query over it).',
        details: { semicolonsOutsideLiterals: semis.length },
      },
      statement,
      findings: [],
      params,
    };
  }

  const tokens = words(masked);

  // Step 4.
  for (const w of tokens) {
    if (w.upper === 'REPLACE') {
      const after = tokens.find((t) => t.index > w.index);
      if (after?.upper === 'INTO') {
        return denied('REPLACE', w.index, statement, params);
      }
      continue; // `replace(str, a, b)` is a function. Leave it alone.
    }
    if (DENIED_KEYWORDS.has(w.upper)) {
      return denied(w.upper, w.index, statement, params);
    }
  }

  // Step 5.
  const first = tokens[0];
  if (first === undefined || (first.upper !== 'SELECT' && first.upper !== 'WITH')) {
    return {
      rejection: {
        code: 'NOT_A_SELECT',
        message:
          first === undefined
            ? 'This does not look like a SQL statement.'
            : `This statement starts with \`${first.text}\`. The View Builder runs \`SELECT\` and ` +
              '`WITH` statements only.',
        details: { firstToken: first?.text ?? null },
      },
      statement,
      findings: [],
      params,
    };
  }

  // Step 6. The dialect lint.
  //
  // ★ SKIPPED ENTIRELY ON ORACLE. Every rule in the SQLite table says "this is
  //   Oracle-only, and the backend is SQLite". Pointed at Oracle for real, all of
  //   them are false: `FETCH FIRST` is correct there and `LIMIT` would be the
  //   mistake. A lint that fires on correct SQL is worse than no lint, because
  //   the author's only options are to believe it or to learn to ignore it — and
  //   learning to ignore it is what makes the next real warning invisible.
  //
  //   The reverse direction (a `LIMIT` sent to Oracle) is not linted. It is worth
  //   doing and is not done: there is no rule table for it yet, and inventing one
  //   in the same change as the first table is how a lint grows past what anyone
  //   reads.
  if (dialect === 'oracle') {
    return { rejection: null, statement, findings: [], params };
  }

  // ★★ AND `sqlserver` GETS ITS OWN TABLE, NOT THIS ONE. Until this split, the
  //    `sqlserver` arm fell through to the Oracle→SQLite rules — so the guard both
  //    missed every SQLite-only spelling *and* refused valid T-SQL (measured:
  //    `OFFSET … FETCH n ROWS ONLY` was rejected as Oracle-only). The rule tables
  //    are "wrong for this engine" tables, not universal ones, so the engine picks
  //    the table.
  const findings = dialectFindings(masked, dialect, statement);
  const blocking = findings.find((f) => f.severity === 'error');
  if (blocking) {
    return {
      rejection: {
        // The code names the arm the statement was read against, so a caller can
        // tell "you wrote Oracle at SQLite" from "you wrote SQLite at SQL Server".
        code: dialect === 'sqlserver' ? 'SQLSERVER_DIALECT' : 'ORACLE_DIALECT',
        message: `${blocking.message}${blocking.fix ? ` Use ${blocking.fix} instead.` : ''}`,
        details: { construct: blocking.construct, code: blocking.code, fix: blocking.fix },
      },
      statement,
      findings,
      params,
    };
  }

  return { rejection: null, statement, findings, params };
}

function denied(keyword: string, index: number, statement: string, params: string[]): SqlAnalysis {
  const reason = DENIED_REASON.get(keyword);
  const why = reason?.why ?? 'It is not a read.';
  const fix = reason?.fix ?? null;
  return {
    rejection: {
      code: 'DENIED_KEYWORD',
      message:
        `\`${keyword}\` is not allowed. ${why}` + (fix ? ` ${fix}` : ''),
      details: { keyword, fix },
    },
    statement,
    findings: [
      { code: 'DENIED_KEYWORD', severity: 'error', construct: keyword, message: why, fix, index },
    ],
    params,
  };
}

/* ------------------------------------------------------------------------- *
 * Step 6 — the dialect table
 * ------------------------------------------------------------------------- */

interface DialectRule {
  code: string;
  severity: 'error' | 'warning';
  test: RegExp;
  message: string;
  fix: string | null;
}

/**
 * Oracle spellings that do not work against libSQL, and the port for each.
 *
 * Two levels, and the distinction is the point:
 *
 *   - `error` — the statement cannot run here. `FETCH FIRST 1 ROW ONLY` is a
 *     parse error, and `(+)` is the reason a join silently returns wrong rows if
 *     it is ever half-translated. Refusing is cheaper than debugging.
 *
 *   - `warning` — the statement runs. `TRUNC(SYSDATE)` is the cautionary case:
 *     through `scripts/turso-run.mjs` the shims make it return **NULL rather
 *     than fail**, so a report built on it is empty and looks like a data
 *     problem. Through this API there is no shim at all and it fails as "no such
 *     function", which is better but not the same thing as being told.
 *
 * ★ The shims live in `scripts/turso-run.mjs` — they are registered in *client*
 *   code, so the compatibility mode is a property of that script and not of the
 *   database. This guard therefore does NOT advertise a compatibility mode: the
 *   same SQL that works there fails here, and pretending otherwise would make
 *   the builder's preview disagree with its run.
 */
/**
 * ★ THIS TABLE IS THE **SQLITE** ARM ONLY, AND SAYING SO IS NOT BOOKKEEPING.
 *
 *   It answers "you wrote Oracle, but the backend is SQLite" — which is why
 *   every `fix` in it names `LIMIT`, `date('now')`, `printf` and `strftime`.
 *   Those are *correct advice for this arm* and **wrong for SQL Server**, where
 *   `date('now')`, `printf` and `strftime` are themselves errors. Before the
 *   split, `analyzeSql` ran this table on the `sqlserver` arm too, so the guard
 *   told authors to write SQL that cannot run.
 *
 *   The SQL Server arm has its own table — `SQLSERVER_RULES`, below.
 */
const DIALECT_RULES: readonly DialectRule[] = [
  {
    code: 'FETCH_FIRST',
    severity: 'error',
    test: /\bFETCH\s+(FIRST|NEXT)\b/i,
    message: '`FETCH FIRST n ROWS ONLY` is Oracle-only syntax and does not parse here.',
    fix: '`LIMIT n`, at the end of the statement',
  },
  {
    code: 'ROWNUM',
    severity: 'error',
    test: /\bROWNUM\b/i,
    message:
      '`ROWNUM` does not exist here, and its Oracle semantics — assigned before `ORDER BY` — ' +
      'are not the same as a row limit anyway.',
    fix: '`LIMIT n`; to limit after sorting, sort in a subquery',
  },
  {
    code: 'CONNECT_BY',
    severity: 'error',
    test: /\bCONNECT\s+BY\b/i,
    message: 'Hierarchical `CONNECT BY` queries have no direct equivalent here.',
    fix: 'a recursive CTE — WITH RECURSIVE t AS (SELECT … UNION ALL SELECT … FROM t …)',
  },
  {
    code: 'ORACLE_OUTER_JOIN',
    severity: 'error',
    test: /\(\s*\+\s*\)/,
    message:
      "Oracle's `(+)` outer-join marker is not valid syntax here, and left in place it changes " +
      'which rows come back rather than failing loudly.',
    fix: 'an explicit `LEFT JOIN`',
  },
  {
    code: 'MERGE',
    severity: 'error',
    test: /\bMERGE\s+INTO\b/i,
    message: '`MERGE INTO` is both Oracle-only and a write.',
    fix: null,
  },
  {
    code: 'SYS_CONTEXT',
    severity: 'error',
    test: /\bSYS_CONTEXT\s*\(/i,
    message: '`SYS_CONTEXT` reads Oracle session state, which does not exist here.',
    fix: 'a literal, or a declared `:parameter` the caller supplies',
  },
  {
    code: 'TRUNC_SYSDATE',
    severity: 'warning',
    test: /\bTRUNC\s*\(\s*SYSDATE\b/i,
    message:
      '`TRUNC(SYSDATE)` is the one silent trap: where a `TRUNC` shim exists it returns **NULL** ' +
      'instead of failing, so a query filtered on it looks like "no rows" rather than an error. ' +
      'There is no shim on this server, so it does fail here — do not rely on that.',
    fix: "`date('now')` for the day",
  },
  {
    code: 'SYSDATE',
    severity: 'warning',
    test: /\bSYSDATE\b/i,
    message:
      '`SYSDATE` does not exist here. The sampler script shims it; this server does not.',
    fix: "`date('now')` or `datetime('now')`",
  },
  {
    code: 'SHIMMED_ONLY',
    severity: 'warning',
    test: /\b(NVL|DECODE|TO_CHAR|TO_DATE|TO_NUMBER|LPAD|RPAD|INITCAP|ADD_MONTHS|MONTHS_BETWEEN|SUBSTR)\s*\(/i,
    message:
      'This function is spelled the Oracle way. Several of these are shimmed inside ' +
      '`scripts/turso-run.mjs`, which registers them in *client* code — so the same query works ' +
      'there and fails here.',
    fix: 'the SQLite spelling — `COALESCE`, `CASE … WHEN`, `printf`, `strftime`, `substr`',
  },
  {
    code: 'DUAL',
    severity: 'warning',
    test: /\bFROM\s+DUAL\b/i,
    message: '`DUAL` is a real view in this schema, so this runs — but it is no longer needed.',
    fix: 'drop the FROM clause; SQLite allows `SELECT 1`',
  },
];

/* ------------------------------------------------------------------------- *
 * The SQL Server arm
 * ------------------------------------------------------------------------- */

/**
 * Constructs that are valid SQLite — and invalid on SQL Server.
 *
 * ★ EVERY RULE HERE CITES A MESSAGE MEASURED AGAINST THE LIVE INSTANCE, WITH THE
 *   PAIRED CONTROL THAT PROVES THE MESSAGE MEANS WHAT IT APPEARS TO MEAN. The
 *   controls are the whole point: `length('abc')` fails while `len('abc')`
 *   succeeds, so the failure is the *name*, not the shape of the call.
 *
 *     construct                  control          what SQL Server says
 *     -------------------------  ---------------  ---------------------------------------
 *     datetime('now')            GETUTCDATE()     'datetime' is not a recognized built-in…
 *     strftime(…)                FORMAT(…)        'strftime' is not a recognized built-in…
 *     length(x)                  len(x)           'length' is not a recognized built-in…
 *     substr(x,1,2)              substring(…)     'substr' is not a recognized built-in…
 *     instr(x,'b')               charindex(…)     'instr' is not a recognized built-in…
 *     printf('%d',1)             FORMAT(…)        'printf' is not a recognized built-in…
 *     group_concat(x)            string_agg(…)    Incorrect syntax near the keyword 'AS'
 *     x COLLATE NOCASE           —                Invalid collation 'NOCASE'
 *     ORDER BY x NULLS LAST      —                Incorrect syntax near 'NULLS'
 *     WHERE true                 WHERE 1 = 1      An expression of non-boolean type…
 *     "abc" (meaning a string)   'abc'            **parses** — read as an *identifier*
 *     (SELECT …) with no alias   alias it         Incorrect syntax near ')'
 *     sqlite_master, pragma_x    sys.tables       Invalid object name 'sqlite_master'
 *
 * ★ `group_concat` IS WORTH READING TWICE. It fails with a *syntax* error rather
 *   than an unknown-function error, because T-SQL parses `GROUP_CONCAT` as an
 *   alias on a column called `CONCAT` — so the message blames `AS`, which is
 *   correct and unhelpful in equal measure. That is the same trap that makes an
 *   unaliased derived table report `near the keyword 'WHERE'`:
 *   **a syntax error naming a token that is itself valid usually means a token is
 *   missing before it.**
 *
 * ★ WHAT IS DELIBERATELY ABSENT is as important as what is here. `TOP`,
 *   `OFFSET … FETCH`, `SUBSTRING`, `LEN`, `CHARINDEX`, `COALESCE`, `ISNULL`,
 *   `STRING_AGG`, `CONVERT` and `||` were all measured to work. `LIMIT`,
 *   `TO_CHAR` and `TO_DATE` were measured to work too, because the driver
 *   rewrites them — so linting them would fire on SQL that runs.
 *
 *   `FETCH FIRST` is the cautionary case: the SQLite table's rule matches
 *   `FETCH NEXT n ROWS ONLY` as well, which is *exactly correct T-SQL*. Carrying
 *   that rule over rejected valid SQL. It is absent here on purpose.
 */
const SQLSERVER_RULES: readonly DialectRule[] = [
  {
    code: 'SQLITE_DATE_FUNC',
    severity: 'error',
    test: /\b(DATETIME|DATE|STRFTIME|JULIANDAY|SQLITE_VERSION)\s*\(/i,
    message:
      'This is a SQLite date/time function. SQL Server has never heard of it, so the statement ' +
      'fails with "… is not a recognized built-in function name".',
    fix:
      '`GETUTCDATE()` for a timestamp, `CONVERT(varchar(19), GETUTCDATE(), 120)` for the ' +
      '`YYYY-MM-DD HH:MM:SS` **string** this schema stores, and `CONVERT(date, …)` for a day',
  },
  {
    code: 'SQLITE_AGG_FUNC',
    severity: 'error',
    test: /\bGROUP_CONCAT\s*\(/i,
    message:
      '`group_concat` does not exist on SQL Server. It fails as a *syntax* error rather than an ' +
      'unknown function, because T-SQL reads it as an alias on a column called `CONCAT`.',
    fix: "`STRING_AGG(x, ',')`",
  },
  {
    code: 'SQLITE_FUNC',
    severity: 'error',
    test: /\b(PRINTF|LENGTH|INSTR|SUBSTR|HEX|TOTAL)\s*\(/i,
    message:
      'This is a SQLite function and SQL Server does not have it — measured, each of these ' +
      'returns "not a recognized built-in function name".',
    fix:
      'the T-SQL spelling — `LEN`, `CHARINDEX`, `SUBSTRING(x, 1, 2)`, `CONCAT`/`FORMAT` ' +
      '(note `CONCAT` takes two or more arguments and is null-safe, unlike `+`)',
  },
  {
    code: 'ORACLE_FUNC',
    severity: 'error',
    test: /\b(NVL|DECODE|TRUNC|TO_NUMBER|LPAD|RPAD|INITCAP|ADD_MONTHS|MONTHS_BETWEEN)\s*\(/i,
    message:
      'This is an Oracle function and SQL Server does not have it. (`TO_CHAR` and `TO_DATE` are ' +
      'exempt: the driver rewrites those for you.)',
    fix: '`ISNULL` or `COALESCE` for `NVL`, and a `CASE` expression for `DECODE`',
  },
  {
    code: 'SYSDATE',
    severity: 'error',
    test: /\bSYSDATE\b/i,
    message:
      '`SYSDATE` does not exist on SQL Server. Unlike the SQLite arm there is no shim here, so ' +
      'this fails outright rather than returning NULL.',
    fix: '`GETUTCDATE()`',
  },
  {
    code: 'ROWNUM',
    severity: 'error',
    test: /\bROWNUM\b/i,
    message: 'SQL Server has no `ROWNUM`, and its Oracle semantics — assigned before `ORDER BY` — ' + 'are not the same as a row limit anyway.',
    fix: '`TOP (n)` on the `SELECT`, or `OFFSET 0 ROWS FETCH NEXT n ROWS ONLY` with an `ORDER BY`, or `ROW_NUMBER() OVER (…)`',
  },
  {
    code: 'CONNECT_BY',
    severity: 'error',
    test: /\bCONNECT\s+BY\b/i,
    message: 'Hierarchical `CONNECT BY` has no equivalent on SQL Server.',
    fix: 'a recursive CTE — WITH t AS (SELECT … UNION ALL SELECT … FROM t …), i.e. no `RECURSIVE` keyword',
  },
  {
    code: 'ORACLE_OUTER_JOIN',
    severity: 'error',
    test: /\(\s*\+\s*\)/,
    message: "Oracle's `(+)` outer-join marker is not valid syntax on SQL Server, and left in place " + 'it changes which rows come back rather than failing loudly.',
    fix: 'an explicit `LEFT JOIN`',
  },
  {
    code: 'SYS_CONTEXT',
    severity: 'error',
    test: /\bSYS_CONTEXT\s*\(/i,
    message: '`SYS_CONTEXT` reads Oracle session state, which does not exist on SQL Server.',
    fix: 'a literal, or a declared `:parameter` the caller supplies',
  },
  {
    code: 'SQLITE_CATALOGUE',
    severity: 'error',
    test: /\b(SQLITE_MASTER|SQLITE_SCHEMA|SQLITE_TEMP_MASTER|SQLITE_TEMP_SCHEMA|PRAGMA_[A-Z_]+)\b/i,
    message:
      'This is SQLite introspection. SQL Server has no `sqlite_master`/`sqlite_schema` and no ' +
      '`pragma_*` table-valued functions — the statement parses and then reports ' +
      '"Invalid object name".',
    fix: '`INFORMATION_SCHEMA.TABLES` and `INFORMATION_SCHEMA.COLUMNS`, or `sys.tables`, `sys.views`, `sys.columns`',
  },
  {
    code: 'NULLS_LAST',
    severity: 'error',
    test: /\bNULLS\s+(FIRST|LAST)\b/i,
    message:
      'SQL Server has no `NULLS FIRST`/`NULLS LAST`. It sorts nulls first when ascending and last ' +
      'when descending, and there is no clause to change that.',
    fix: 'an explicit sort key — `ORDER BY CASE WHEN x IS NULL THEN 1 ELSE 0 END, x` (this is what `sql.ts` already does)',
  },
  {
    code: 'COLLATE_NOCASE',
    severity: 'error',
    test: /\bCOLLATE\s+NOCASE\b/i,
    message:
      "SQL Server does not know the `NOCASE` collation — it fails with `Invalid collation 'NOCASE'`. " +
      'Case-insensitive comparison is normally already the default.',
    fix: 'nothing, if the column is an ordinary `varchar`/`nvarchar` (their default collation is case-insensitive); otherwise an explicit one such as `Latin1_General_CI_AS`',
  },
  {
    code: 'BOOLEAN_LITERAL',
    severity: 'error',
    test: /\b(WHERE|AND|OR|HAVING|ON|WHEN)\s+(TRUE|FALSE)\b/i,
    message:
      'SQL Server has no boolean literal. `WHERE true` fails with "An expression of non-boolean ' +
      'type specified in a context where a condition is expected".',
    fix: '`1 = 1` (or `1 = 0` for `false`)',
  },
];

// ★ THE DOUBLE-QUOTE CHECK CANNOT LIVE IN THE TABLE ABOVE, AND THE REASON IS THE
//   MASK. Every rule in `SQLSERVER_RULES` is matched against `masked` — the
//   statement with literals *and quoted identifiers* blanked to spaces — which is
//   right for keyword rules and fatal for this one: blanking removes the very `"`
//   it is looking for. Measured: the rule as written in the table matched
//   **nothing**, including `SELECT "abc" AS x`.
//
//   So it runs against `maskKeepingIdentifiers(statement)` instead, which blanks
//   `'…'` and comments while leaving `"…"`, `` `…` `` and `[…]` visible. That is
//   the exact discrimination the check needs: a `"` inside a string literal is
//   blanked and cannot produce a false positive, while a quoted identifier or a
//   legacy double-quoted string stays and is reported.

/**
 * Positions of the `(` in `FROM (` / `JOIN (` where the derived table has no alias.
 *
 * ★ THIS IS THE RULE THAT PAYS FOR ITSELF, because it is the bug that was already
 *   found once in anger: `GET /api/views/subscriptions` returned 500 with
 *   `Msg 156` on a `FROM ( SELECT … )` that had no alias. SQLite accepts an
 *   unaliased derived table; T-SQL requires one. The engine blames the *next*
 *   keyword, so the author reads `Incorrect syntax near the keyword 'WHERE'` and
 *   goes looking for a problem with `WHERE` — which is correct.
 *
 * A regex cannot do this: the alias sits after a *balanced* closing paren, so the
 * scanner walks parens from each `FROM (`/`JOIN (`. Comments and literals are
 * already gone — `masked` is passed in.
 */
function unaliasedDerivedTables(code: string): number[] {
  // Words that can legitimately follow a derived table and are therefore *not*
  // aliases. Without this list `GROUP`, `WHERE`, `ORDER` and friends would each
  // read as a usable alias and every one of them would be missed.
  const NOT_AN_ALIAS = new Set([
    'WHERE', 'GROUP', 'ORDER', 'HAVING', 'UNION', 'EXCEPT', 'INTERSECT', 'ON',
    'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER', 'LIMIT',
    'OFFSET', 'FETCH', 'FOR', 'WINDOW', 'AND', 'OR', 'SET', 'VALUES', 'SELECT', 'WITH',
  ]);

  const out: number[] = [];
  const opener = /\b(FROM|JOIN)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = opener.exec(code)) !== null) {
    const start = m.index + m[0].length - 1; // the `(` itself
    let depth = 0;
    let close = -1;
    for (let i = start; i < code.length; i += 1) {
      const ch = code[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) continue; // unbalanced: the engine's problem, not the guard's

    // Only a derived table needs the alias. `FROM (a, b)` and `JOIN (…)` over a
    // function call are not derived tables.
    if (!/^\s*(SELECT|WITH)\b/i.test(code.slice(start + 1, close))) continue;

    const after = code.slice(close + 1);
    const asAlias = /^\s*AS\s+[A-Za-z_][A-Za-z0-9_]*/.test(after);
    if (asAlias) continue;
    const bare = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(after);
    const word = bare?.[1];
    if (word !== undefined && !NOT_AN_ALIAS.has(word.toUpperCase())) continue; // a bare alias

    out.push(start);
  }
  return out;
}

/**
 * The dialect rules that match, against masked text so a literal `'ROWNUM'`
 * does not trip them.
 *
 * ★ THE DIALECT SELECTS THE TABLE, AND THAT IS THE FIX, NOT A REFACTOR. The
 *   rules are not "bad SQL" in the abstract — each one is "bad SQL *for this
 *   engine*", and the two engines are wrong about opposite things:
 *
 *     sqlite     Oracle spellings are the mistake; `LIMIT` is the answer
 *     sqlserver  SQLite spellings are the mistake; `OFFSET … FETCH` is the answer
 *
 *   Pointed at the wrong engine, a rule fires on correct SQL *and* recommends
 *   correct-for-the-other-engine SQL. Both halves were measured on the live
 *   instance before this split existed: on the `sqlserver` arm the guard rejected
 *   `OFFSET … FETCH` and accepted `datetime('now')`, `NULLS LAST`, `COLLATE
 *   NOCASE`, `WHERE true` and an **unaliased derived table**.
 *
 * ★ `oracle` HAS NO TABLE AND THAT IS DELIBERATE — see the note in `analyzeSql`.
 *   Callers on that arm must not reach here; the signature keeps it honest by
 *   refusing the value at the type level.
 *
 * Exported because the run path re-checks findings after a driver error: an
 * error the driver reports ("no such function: TRUNC") is much more useful when
 * the named port travels with it.
 */
export function dialectFindings(
  masked: string,
  dialect: 'sqlite' | 'sqlserver' | 'mysql' = 'sqlite',
  /** The statement *unmasked*, needed only by the double-quote check. */
  statement?: string,
): GuardFinding[] {
  // ★ MYSQL TAKES THE SQLITE RULE TABLE, AND THAT IS A MEASURED CHOICE RATHER THAN A
  //   DEFAULT. The tables below are "wrong for this engine" tables — they name the
  //   constructs an author would reach for out of habit and that this engine rejects.
  //   MySQL natively accepts `LIMIT`, `IFNULL` and `?`, which is exactly the set the
  //   SQLite table does NOT flag — so falling through to it is right, and adding a
  //   fourth table with nothing in it would be inventing rules to have a table.
  const rules = dialect === 'sqlserver' ? SQLSERVER_RULES : DIALECT_RULES;

  const out: GuardFinding[] = [];
  for (const rule of rules) {
    const m = rule.test.exec(masked);
    if (m === null) continue;
    out.push({
      code: rule.code,
      severity: rule.severity,
      construct: m[0].trim().replace(/\s+/g, ' '),
      message: rule.message,
      fix: rule.fix,
      index: m.index,
    });
  }

  // ★ THE TWO CHECKS BELOW ARE NOT REGEXES OVER `masked`, for one reason each.
  if (dialect === 'sqlserver') {
    // 1. The offending text is after a *balanced* paren rather than at a fixed
    //    shape, so a regex cannot find it.
    const positions = unaliasedDerivedTables(masked);
    const first = positions[0];
    if (first !== undefined) {
      out.push({
        code: 'DERIVED_TABLE_ALIAS',
        severity: 'error',
        construct: 'FROM ( SELECT … )',
        message:
          'This derived table has no alias, which SQLite allows and T-SQL does not (Msg 156). ' +
          'T-SQL blames the token *after* the closing paren, so the error names a keyword that is ' +
          'itself correct — `Incorrect syntax near the keyword \'WHERE\'` is this bug.',
        fix: 'an alias after the closing paren — `FROM ( SELECT … ) AS sub`, or in older T-SQL just `) sub`',
        index: first,
      });
    }

    // 2. The character being looked for is blanked by `maskLiterals`, so this one
    //    needs the statement with quoted identifiers intact. See the note above
    //    `SQLSERVER_RULES`.
    if (statement !== undefined) {
      const identifiersKept = maskKeepingIdentifiers(statement);
      const quote = identifiersKept.indexOf('"');
      if (quote !== -1) {
        const closeQuote = identifiersKept.indexOf('"', quote + 1);
        out.push({
          code: 'DOUBLE_QUOTED_STRING',
          severity: 'warning',
          construct:
            closeQuote === -1 ? '"' : identifiersKept.slice(quote, closeQuote + 1).replace(/\s+/g, ' '),
          message:
            'SQL Server reads `"…"` as a **quoted identifier**, not as a string. So `SELECT "abc"` ' +
            'becomes a reference to a column called `abc` — which fails with `Invalid column name`, ' +
            'or, worse, silently returns a *different column* than you meant. It behaves as a string ' +
            'only where `QUOTED_IDENTIFIER` happens to be OFF, which is not the default.',
          fix: "`'…'` for a string literal; for an identifier that genuinely needs quoting, use `[Order Date]`",
          index: quote,
        });
      }
    }
  }

  // `TRUNC(SYSDATE)` matches two rules on the SQLite arm. One finding — the more
  // specific one — is more useful than two that disagree about the headline.
  const specific = out.find((f) => f.code === 'TRUNC_SYSDATE');
  return specific ? out.filter((f) => f.code !== 'SYSDATE') : out;
}

/* ------------------------------------------------------------------------- *
 * Layer 3, second half — the row cap
 * ------------------------------------------------------------------------- */

/**
 * Wrap a statement so the database, not the process, stops the rows.
 *
 * ★ THE TRAILING NEWLINE IS MANDATORY, and it is the least obvious line in this
 *   file. A statement may legitimately end with a line comment:
 *
 *       SELECT * FROM PO_LINES_ALL  -- everything, unfiltered
 *
 *   Concatenating `) LIMIT 201` on the same line puts the wrapper *inside the
 *   comment*, producing `SELECT * FROM (…-- everything, unfiltered) LIMIT 201`,
 *   which is an unterminated subquery. The `\n` before `)` closes the comment so
 *   the wrapper is real. V8 in the plan exists for exactly this.
 *
 * ★ THE ROW CAP IS NOT A PERFORMANCE CAP. `SELECT * FROM (big query) LIMIT 201`
 *   still materialises the inner result — SQLite has to run the whole thing
 *   before the limit applies. It bounds what crosses the wire and what the
 *   process holds, and the statement timeout is what bounds the work.
 *
 * `maxRows + 1` is fetched on purpose: getting back `maxRows + 1` rows is how
 * the caller knows the result was cut, and can say "showing 200 of more" instead
 * of quietly pretending 200 was all of it.
 *
 * ★ TWO DIALECTS, BECAUSE THE WRAPPER IS THE ONE THING THE SERVER APPENDS.
 *   `LIMIT` is SQLite; `ROWNUM` is Oracle and works from 11g onwards without
 *   caring which release the EBS instance sits on. This is the only place in the
 *   feature that writes SQL on the user's behalf, so it is the only place that
 *   has to know the backend — and it is why the cap is applied here rather than
 *   by rewriting the author's statement, which is never done.
 *
 *   A `TOP n` / `FETCH FIRST n` form would be wrong for the other backend, and
 *   guessing which one the driver tolerates is exactly the kind of silent
 *   rewrite the feature exists to avoid.
 */
export function wrapForRowCap(
  statement: string,
  maxRows: number,
  dialect: Dialect = 'sqlite',
): string {
  const n = Math.max(1, Math.trunc(maxRows));
  // The inner statement has already had its trailing `;` stripped by
  // `analyzeSql`; `trimStatement` is belt-and-braces for a caller that did not.
  const inner = trimStatement(statement);
  if (dialect === 'oracle') {
    return `SELECT * FROM (\n${inner}\n) WHERE ROWNUM <= ${n + 1}`;
  }
  if (dialect === 'sqlserver') {
    // ★★ THE INNER `ORDER BY` IS REMOVED, AND THAT IS THE WHOLE FIX.
    //
    //    T-SQL forbids an `ORDER BY` in a derived table *outright* — the message
    //    is Msg 1033, "The ORDER BY clause is invalid in views, inline functions,
    //    derived tables, subqueries, and common table expressions, unless TOP,
    //    OFFSET or FOR XML is also specified". Measured on the live instance,
    //    **all three** obvious shapes fail:
    //
    //      SELECT * FROM ( … ORDER BY x ) OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY  → Msg 10744
    //      SELECT * FROM ( … ORDER BY x ) ORDER BY (SELECT NULL) OFFSET 0 …     → Msg 10744
    //      SELECT TOP (5) * FROM ( … ORDER BY x ) AS capped                      → Msg 1033
    //
    //    ★ THE FIRST TWO ARE WORTH READING TWICE, because they are the shapes a
    //      reasonable person writes. Adding an outer `ORDER BY` does NOT rescue
    //      the inner one — the derived table is still illegal, and the error just
    //      changes number. There is no arrangement of the wrapper that keeps the
    //      author's `ORDER BY` where they wrote it.
    //
    //    ★ AND DROPPING IT LOSES NOTHING, WHICH IS WHY THIS IS A FIX RATHER THAN
    //      A COMPROMISE. A derived table's ordering has never been guaranteed to
    //      survive into the outer query — SQLite does not promise it either, and
    //      the row cap is applied to "the first n+1 rows the engine produces",
    //      which is exactly what the cap's own documentation says it means. The
    //      ordering that *matters* is the one on the statement the caller actually
    //      reads, and `applyReadCap` (which orders before wrapping) is the path
    //      that provides it.
    const { body: ordered, orderBy } = splitTrailingOrderBy(inner);
    // ★★ A `WITH` CLAUSE CANNOT GO INSIDE A DERIVED TABLE, SO IT IS HOISTED OUT.
    //
    //    T-SQL rejects `SELECT … FROM (WITH x AS (…) SELECT …) AS capped`, and the
    //    message is **`Incorrect syntax near ')'`** — naming the closing paren
    //    rather than the `WITH` that caused it, so it reads like an unbalanced
    //    bracket. Measured on the live instance, all three shapes:
    //
    //      SELECT TOP (3) * FROM (WITH t AS (…) SELECT …) AS capped   → Incorrect syntax near ')'
    //      WITH t AS (…) SELECT TOP (3) * FROM (SELECT …) AS capped   → ok, 3 rows
    //      WITH t AS (…) SELECT TOP (3) … FROM t                      → ok, 3 rows
    //
    //    ★ THIS IS THE SHAPE EVERY VIEW-BUILDER VIEW HITS. The View Builder is
    //      built on CTEs — `WITH code_period AS (…), ranked AS (…) SELECT …` is the
    //      idiom its own seeded view uses — so without this hoist the row cap
    //      breaks the majority of saved views on SQL Server, and it breaks them
    //      with a message that points at a parenthesis.
    //
    //    ★ THE HOIST IS A SPLIT, NOT A REWRITE. Everything up to and including the
    //      CTE preamble stays outside; only the final `SELECT` is wrapped. The
    //      preamble is found by scanning for the first top-level `SELECT` — the one
    //      that is NOT inside the `WITH` list — which is the same depth-tracking
    //      the `ORDER BY` strip already does.
    //
    //    ★ AND LEADING COMMENTS GO OUTSIDE TOO. A saved view opens with its own
    //      documentation block, and a comment between `FROM (` and the `WITH` puts
    //      the `WITH` off the front of the statement — which is the same failure
    //      with the same misleading message. `splitCte` skips them to find the
    //      `WITH`, and they land in `cte`, so they are emitted before the wrapper.
    const { cte, body } = splitCte(ordered);
    // ★★ THE AUTHOR'S `ORDER BY` IS RE-APPLIED OUTSIDE — WITH ITS REFERENCES
    //    MAPPED TO THE OUTPUT COLUMNS, WHICH IS THE WHOLE DIFFICULTY.
    //
    //    Stripping the clause is required (T-SQL forbids it inside a derived
    //    table), but stripping it and stopping there leaves the result UNORDERED
    //    and the engine returns rows in whatever order it produced them. MEASURED
    //    on `first-fundings`: 2022/p1, 2022/p2, 2023/p10, 2022/p1 … while the
    //    statement asked for period descending.
    //
    //    ★ AND RE-EMITTING IT VERBATIM DOES NOT WORK EITHER. The clause names the
    //      INNER aliases — `ORDER BY r.period_year DESC, k.combination_key` — and
    //      those are not in scope outside the derived table. Measured, the server
    //      says exactly that: `The multi-part identifier "k.combination_key" could
    //      not be bound.` A derived table exposes its SELECT-list aliases and
    //      nothing else.
    //
    //    ★ SO EACH REFERENCE IS MAPPED THROUGH THE INNER SELECT LIST. That list is
    //      the only thing the wrapper can see, so a reference is resolvable exactly
    //      when the inner query projects it: `r.period_year` (unaliased) exposes
    //      `period_year`, and `k.combination_key AS fund_code` exposes `fund_code`.
    //      When a reference cannot be mapped the clause is DROPPED rather than
    //      emitted broken — an unordered result is a lesser fault than a statement
    //      that will not parse, and guessing a name is how a wrong order becomes
    //      invisible.
    const outerOrder = remapOrderBy(orderBy, body);
    const capped = `SELECT TOP (${n + 1}) * FROM (\n${body}\n) AS capped${outerOrder === '' ? '' : `\n${outerOrder}`}`;
    return cte === '' ? capped : `${cte}\n${capped}`;
  }
  return `SELECT * FROM (\n${inner}\n) LIMIT ${n + 1}`;
}

/**
 * Remove a trailing `ORDER BY …` from a statement, for use inside a derived table.
 *
 * ★ THIS IS NOT A GENERAL SQL REWRITER AND MUST NOT BECOME ONE. It removes the
 *   LAST top-level `ORDER BY` clause and everything after it, which is exact for
 *   the statements this codebase wraps (a single `SELECT … ORDER BY x`, possibly
 *   with `LIMIT` already stripped). A statement whose `ORDER BY` is followed by
 *   another top-level clause would be mangled — but T-SQL has no clause that may
 *   follow `ORDER BY` except `OFFSET`/`FETCH`, and those are the paging the
 *   caller's own dialect rewrite already removed.
 *
 * ★ A `LIMIT` IS STRIPPED TOO. The wrapper supplies its own cap, and a nested
 *   `LIMIT` would be a second, contradictory one — and in T-SQL it would not
 *   parse at all, since `LIMIT` is not T-SQL.
 *
 * Depth-aware, so an `ORDER BY` inside a subquery is left alone: only the clause
 * belonging to the statement being wrapped is removed.
 *
 * Exported because `read-cap.ts` wraps statements the same way and needs the same
 * removal — a second copy of this scan is a second place for it to drift.
 */
export function stripTrailingOrderBy(statement: string): string {
  return splitTrailingOrderBy(statement).body;
}

/**
 * The trailing `ORDER BY …` clause, separated from the statement that carries it.
 *
 * ★★ THE CLAUSE MUST BE RE-APPLIED OUTSIDE THE WRAPPER, NOT JUST REMOVED.
 *
 *   `stripTrailingOrderBy` exists because T-SQL forbids an `ORDER BY` in a derived
 *   table. But removing it and emitting `SELECT TOP (n+1) * FROM (…) AS capped`
 *   leaves the result with NO ORDERING AT ALL — the engine returns rows in
 *   whatever order it happens to produce them, and the author's `ORDER BY` is
 *   silently discarded.
 *
 *   MEASURED, on the `first-fundings` view: the endpoint returned
 *   2022/p1, 2022/p2, 2023/p10, 2022/p1, 2023/p9 … — not period order, not
 *   combination order, just the engine's own. Re-applying the clause on the outer
 *   query returned 2027/p1 first, which is what the statement asked for.
 *
 *   ★ THE CLAUSE IS LEGAL THERE. T-SQL permits `ORDER BY` on the outermost query
 *     of a statement, which is exactly where the wrapper's own `SELECT` sits — so
 *     the ordering moves rather than being lost. That is the whole fix.
 *
 * ★ A `LIMIT` IS DROPPED RATHER THAN RETURNED. The wrapper supplies its own cap,
 *   and a nested `LIMIT` would be a second, contradictory one — and in T-SQL it
 *   would not parse at all, since `LIMIT` is not T-SQL.
 *
 * Depth-aware, so an `ORDER BY` inside a subquery is left alone: only the clause
 * belonging to the statement being wrapped is separated.
 */
export function splitTrailingOrderBy(statement: string): { body: string; orderBy: string } {
  // ★ `maskKeepingIdentifiers` RATHER THAN A NEW SCANNER. This file is deliberately
  //   import-free (see the header), and it already owns a masker that blanks
  //   string literals and comments while leaving identifiers and punctuation in
  //   place — which is exactly the view this scan needs. Blanking the literals is
  //   what stops `WHERE note = 'order by date'` from being read as a clause.
  const masked = maskKeepingIdentifiers(statement);
  let depth = 0;
  let cut = -1;

  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === 'O' || ch === 'o')) {
      if (/^order\b/i.test(masked.slice(i)) && /^\s+by\b/i.test(masked.slice(i + 5))) {
        // The LAST one wins: only a trailing clause is removable.
        cut = i;
      }
    }
  }

  if (cut === -1) return { body: statement, orderBy: '' };
  // ★ THE CLAUSE IS TAKEN FROM THE ORIGINAL TEXT, NOT THE MASKED ONE. The mask
  //   blanks literals, so slicing the masked string would return a clause with its
  //   string literals replaced by spaces — a subtly different ORDER BY.
  const tail = statement.slice(cut).trimEnd().replace(/;\s*$/, '');
  // A `LIMIT`/`OFFSET … FETCH` after the ordering is paging, not ordering, and the
  // wrapper replaces it. Cut the clause at the paging keyword so only the ordering
  // is carried out.
  const paging = tail.search(/\b(LIMIT|OFFSET|FETCH)\b/i);
  return {
    body: statement.slice(0, cut).trimEnd(),
    orderBy: paging === -1 ? tail : tail.slice(0, paging).trimEnd(),
  };
}

/**
 * Rewrite an `ORDER BY` clause's references so they name the derived table's
 * OUTPUT columns instead of the inner query's aliases.
 *
 * ★ WHY THE REFERENCES CANNOT BE USED AS WRITTEN. `ORDER BY r.period_year DESC,
 *   k.combination_key` is written against the inner query, where `r` and `k` are
 *   in scope. Once that query becomes `FROM ( … ) AS capped`, only its SELECT-list
 *   names are visible, and the server refuses the clause outright:
 *
 *     `The multi-part identifier "k.combination_key" could not be bound.`
 *
 * ★ THE MAPPING IS READ OFF THE SELECT LIST, NOT GUESSED. Each select item is
 *   reduced to `(expression, outputName)`:
 *
 *       `r.period_year`                 → expression `r.period_year`,  name `period_year`
 *       `k.combination_key AS fund_code`→ expression `k.combination_key`, name `fund_code`
 *       `r.net_amount AS first_allocation_amount` → name `first_allocation_amount`
 *
 *   An `ORDER BY` reference matches an item when it equals the item's expression,
 *   or equals its last dotted component (`period_year` matching `r.period_year`).
 *   The first match wins, which is the leftmost projection of that expression —
 *   and a select list that projects the same expression twice under different
 *   names is ambiguous by construction, so no rule can be right for both.
 *
 * ★ AN UNMAPPABLE REFERENCE DROPS THE WHOLE CLAUSE. Emitting a clause with one
 *   unresolvable name is a statement that will not parse, and dropping just that
 *   term would silently change the ordering. Returning nothing leaves the result
 *   unordered, which is the honest lesser fault and is what the wrapper did before
 *   this function existed.
 *
 * ★ `ASC`/`DESC` AND THE COMMA STRUCTURE ARE PRESERVED. Only the reference text is
 *   replaced, so `DESC` survives and a multi-term clause keeps its order of terms.
 */
function remapOrderBy(orderBy: string, inner: string): string {
  if (orderBy === '') return '';

  const items = selectItems(inner);
  if (items.length === 0) return '';

  const terms = orderBy.replace(/^\s*order\s+by\b/i, '').split(',');
  const mapped: string[] = [];

  for (const term of terms) {
    const trimmed = term.trim();
    if (trimmed === '') continue;
    // Split the reference from its direction, keeping the direction verbatim.
    const m = /^([A-Za-z_][\w$.]*|"[^"]+")(\s+(?:asc|desc))?$/i.exec(trimmed);
    if (m === null) return '';
    const ref = m[1]!;
    const dir = m[2] ?? '';
    const bare = ref.replace(/"/g, '').split('.').pop()!.toLowerCase();

    const hit = items.find(
      (it) =>
        it.expression.toLowerCase() === ref.replace(/"/g, '').toLowerCase() ||
        it.expression.replace(/"/g, '').split('.').pop()!.toLowerCase() === bare,
    );
    if (hit === undefined) return '';
    mapped.push(`${hit.name}${dir}`);
  }

  return mapped.length === 0 ? '' : `ORDER BY ${mapped.join(', ')}`;
}

/**
 * The `(expression, outputName)` pairs of a statement's outermost select list.
 *
 * ★ DEPTH-AWARE, because a select list can contain a subquery — `(SELECT MAX(x)
 *   FROM t) AS m` is one item, not three. Splitting on commas without tracking
 *   parentheses would cut it in half and produce two nonsense names.
 *
 * ★ THE OUTERMOST `SELECT` IS THE BODY'S, NOT THE CTE'S. `splitCte` has already
 *   separated the `WITH` preamble, so the first top-level `SELECT` in `inner` is
 *   the one whose list this is.
 */
function selectItems(inner: string): { expression: string; name: string }[] {
  const masked = maskKeepingIdentifiers(inner);
  const selectIdx = masked.search(/\bselect\b/i);
  if (selectIdx === -1) return [];

  // Walk to the matching `FROM` at depth 0 — that is where the list ends.
  let depth = 0;
  let fromIdx = -1;
  for (let i = selectIdx + 'select'.length; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === 'F' || ch === 'f') && /^from\b/i.test(masked.slice(i))) {
      fromIdx = i;
      break;
    }
  }
  if (fromIdx === -1) return [];

  const list = inner.slice(selectIdx + 'select'.length, fromIdx);
  const items: { expression: string; name: string }[] = [];
  let d = 0;
  let start = 0;
  const parts: string[] = [];

  for (let i = 0; i < list.length; i += 1) {
    const ch = list[i];
    if (ch === '(') d += 1;
    else if (ch === ')') d = Math.max(0, d - 1);
    else if (ch === ',' && d === 0) {
      parts.push(list.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(list.slice(start));

  for (const raw of parts) {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (text === '') continue;
    // `expr AS name` — the alias is the last identifier after a top-level `AS`.
    const asMatch = /^(.*?)\s+as\s+("?[A-Za-z_][\w$]*"?)$/i.exec(text);
    if (asMatch !== null) {
      items.push({ expression: asMatch[1]!.trim(), name: asMatch[2]!.replace(/"/g, '') });
      continue;
    }
    // No alias: the output name is the expression's own last component.
    const bare = text.replace(/"/g, '').split('.').pop()!.trim();
    if (/^[A-Za-z_][\w$]*$/.test(bare)) items.push({ expression: text, name: bare });
  }

  return items;
}

/**
 * Split a statement into its `WITH` preamble and the `SELECT` that follows it.
 *
 * ★ WHY THIS EXISTS. T-SQL refuses a `WITH` clause inside a derived table, so a
 *   statement that uses CTEs cannot simply be wrapped in `SELECT … FROM ( … )`.
 *   The preamble has to stay outside the wrapper. Measured on the live instance:
 *
 *     `SELECT TOP (3) * FROM (WITH t AS (…) SELECT …) AS capped`
 *        → `Incorrect syntax near ')'`   ← names the paren, not the `WITH`
 *     `WITH t AS (…) SELECT TOP (3) * FROM (SELECT …) AS capped`
 *        → ok, and still caps (3 rows of a 5-row CTE)
 *
 * ★ IT FINDS THE FIRST TOP-LEVEL `SELECT`, WHICH IS THE ONE AFTER THE CTE LIST.
 *   `WITH a AS (SELECT …), b AS (SELECT …) SELECT …` has three `SELECT`s and only
 *   the last is the body; the first two are inside parentheses and are skipped by
 *   the depth counter. A statement with no `WITH` returns an empty preamble and is
 *   wrapped exactly as before — so this is a no-op for every non-CTE statement.
 *
 * ★ THE `WITH` MUST BE THE FIRST TOKEN. `WITH` is also a table hint (`FROM t WITH
 *   (NOLOCK)`) and the start of `WITH RECURSIVE`-style constructs, so matching the
 *   word anywhere would split a statement that merely mentions it. Requiring it at
 *   the very start of the trimmed text is what keeps this exact.
 *
 * ★ RECURSIVE CTEs ARE HANDLED BY THE SAME SCAN. `WITH RECURSIVE t AS (…)` — or
 *   T-SQL's plain `WITH t AS (…)` that references itself — puts the inner
 *   `SELECT`s inside parentheses just the same, so the depth rule finds the right
 *   boundary without knowing anything about recursion.
 */
function splitCte(statement: string): { cte: string; body: string } {
  // ★★ LEADING COMMENTS ARE SKIPPED, AND THAT IS NOT COSMETIC.
  //
  //    A CTE is legal only at the START of a statement, and a `--` comment before
  //    it does not count as "before it" to the parser — but it does to a naive
  //    `startsWith('with')` test. The View Builder's saved views open with a
  //    documentation block (the seeded `first-fundings` body has 40 lines of it),
  //    so without this skip the hoist never fires and the wrap fails with
  //    `Incorrect syntax near ')'`. Measured, live instance:
  //
  //      SELECT TOP (3) * FROM ( -- comment\n WITH t AS (…) SELECT … ) AS capped  → Incorrect syntax near ')'
  //      SELECT TOP (3) * FROM ( WITH t AS (…) SELECT … ) AS capped               → Incorrect syntax near ')'
  //      -- comment\n WITH t AS (…) SELECT TOP (3) * FROM (SELECT …) AS capped    → ok, 3 rows
  //
  //    ★ THE COMMENTS STAY IN THE PREAMBLE, NOT IN THE BODY. Keeping them attached
  //      to the hoisted `WITH` is what makes the output readable — the alternative
  //      (dropping them) would strip the author's own documentation from the
  //      statement the server runs, and the trace shows that text.
  const masked = maskKeepingIdentifiers(statement);
  let start = 0;
  // Skip whitespace and `--` line comments only. A block comment is left in place
  // because `maskKeepingIdentifiers` blanks it, so the `WITH` test below would see
  // through it anyway.
  for (;;) {
    while (start < masked.length && /\s/.test(masked[start]!)) start += 1;
    if (masked.startsWith('--', start)) {
      const nl = masked.indexOf('\n', start);
      if (nl === -1) return { cte: '', body: statement };
      start = nl + 1;
      continue;
    }
    break;
  }

  if (!/^with\b/i.test(masked.slice(start))) return { cte: '', body: statement };

  // Track depth from the beginning so the `WITH` list's own parentheses are
  // counted; `start` only moves where the keyword test begins.
  let depth = 0;
  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && i >= start && (ch === 'S' || ch === 's')) {
      // Anchored so `SELECT` must start a word, and followed by a word boundary so
      // `SELECTED_COUNT` cannot match.
      if (/^select\b/i.test(masked.slice(i))) {
        return { cte: statement.slice(0, i).trimEnd(), body: statement.slice(i) };
      }
    }
  }

  // A `WITH` with no top-level `SELECT` is not a shape this codebase produces;
  // returning it whole lets the caller wrap it and the server report the real
  // fault rather than this helper inventing a split.
  return { cte: '', body: statement };
}

/**
 * How many rows a capped result actually held, and whether it was cut.
 *
 * Split out so the "showing 200 of 4,812" line and the truncation flag come from
 * one decision rather than two expressions that can disagree.
 */
export function capResult<T>(rows: T[], maxRows: number): { rows: T[]; truncated: boolean } {
  const n = Math.max(1, Math.trunc(maxRows));
  if (rows.length <= n) return { rows, truncated: false };
  return { rows: rows.slice(0, n), truncated: true };
}

/* ------------------------------------------------------------------------- *
 * Layer 4 — the timeout
 * ------------------------------------------------------------------------- */

/** Raised when a statement outlives its budget. Distinct so the route can map it. */
export class QueryTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryTimeoutError';
  }
}

/**
 * Race work against a clock, and *abandon* it cleanly if the clock wins.
 *
 * ★ The abandoned promise must have a handler attached **immediately**, which is
 *   why `work.catch(() => {})` is the first statement rather than something added
 *   later. A `Promise.race` hands the loser's rejection to nobody: the race has
 *   already settled, so a rejection that arrives 400ms later is unhandled, and
 *   Node's default is to abort the process. V11 in the plan checks that a
 *   pathological join times out *and the server is still alive* — this line is
 *   what makes the second half of that true.
 *
 * ★ The work is not cancelled. Neither libSQL nor SQLite offers a cancel, so a
 *   statement that blows its budget keeps running on the database until it
 *   finishes. That is the honest description of this helper: it stops the
 *   *request* waiting, not the *query*. The read-only token and the statement
 *   allowlist are what keep that from being dangerous.
 *
 * ★ MEASURED, AND THE LIMIT OF THIS HELPER. The `local` file driver runs the
 *   statement inside a synchronous native call, so it holds Node's event loop for
 *   its whole duration and `setTimeout` cannot fire until it returns. Probed
 *   directly: a 250ms timer raced against the 3-way cross join below resolved
 *   `'ran'`, and the timer's callback had still not run when the query resolved at
 *   2686ms — the clock was never consulted. So on a *local file* target this
 *   helper does not bound anything; what bounds a local statement is that SQLite
 *   terminates it. It does bound a driver that yields while it waits — a remote
 *   libSQL/Turso connection, or Oracle through `oracledb`, both of which are real
 *   configurations of this server.
 *
 *   The consequence has to be stated rather than hidden: a statement on a local
 *   target that never terminates will hold the process, and no timer can help.
 *   That is why §5.4 of the plan keeps this server on loopback and behind
 *   `VIEW_BUILDER_ENABLED=1`, and why the row cap is set by the server rather than
 *   by the author.
 */
export async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  work.catch(() => {});

  let timer: ReturnType<typeof setTimeout> | undefined;
  const clock = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new QueryTimeoutError(message)), ms);
  });

  try {
    return await Promise.race([work, clock]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
