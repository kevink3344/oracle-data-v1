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
    | 'ORACLE_DIALECT';
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
export function analyzeSql(sql: string, dialect: 'sqlite' | 'oracle' = 'sqlite'): SqlAnalysis {
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

  // Step 6.
  //
  // ★ SKIPPED ENTIRELY ON ORACLE. Every rule in `DIALECT_RULES` says "this is
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

  const findings = dialectFindings(masked);
  const blocking = findings.find((f) => f.severity === 'error');
  if (blocking) {
    return {
      rejection: {
        code: 'ORACLE_DIALECT',
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

/**
 * The dialect rules that match, against masked text so a literal `'ROWNUM'`
 * does not trip them.
 *
 * Exported because the run path re-checks findings after a driver error: an
 * error the driver reports ("no such function: TRUNC") is much more useful when
 * the named port travels with it.
 */
export function dialectFindings(masked: string): GuardFinding[] {
  const out: GuardFinding[] = [];
  for (const rule of DIALECT_RULES) {
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

  // `TRUNC(SYSDATE)` matches two rules. One finding — the more specific one — is
  // more useful than two that disagree about which is the headline.
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
  dialect: 'sqlite' | 'oracle' = 'sqlite',
): string {
  const n = Math.max(1, Math.trunc(maxRows));
  // The inner statement has already had its trailing `;` stripped by
  // `analyzeSql`; `trimStatement` is belt-and-braces for a caller that did not.
  const inner = trimStatement(statement);
  return dialect === 'oracle'
    ? `SELECT * FROM (\n${inner}\n) WHERE ROWNUM <= ${n + 1}`
    : `SELECT * FROM (\n${inner}\n) LIMIT ${n + 1}`;
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
