/**
 * ★★ ONE SCANNER, THREE DIALECTS — EXTRACTED FROM `oracle.ts`, NOT COPIED.
 *
 * `oracle.ts` grew this scanner to answer one question: *is this `?` a
 * placeholder, or is it inside a string literal / quoted identifier / comment?*
 * A regex cannot tell those apart, and getting it wrong shifts every subsequent
 * bind by one — matching the wrong column with no error at all. The `LIKE` case
 * is the one that bites: `'60%?done'` is a perfectly ordinary pattern.
 *
 * The SQL Server driver needs the identical answer for the identical reason, and
 * a second copy would be a second place for the escaping rules to drift. So the
 * scanner lives here and both drivers import it.
 *
 * ★ WHAT IS DELIBERATELY *NOT* SCANNED FOR: Oracle's alternative quoting
 *   (`q'[ … ]'`) and T-SQL's bracket identifiers (`[ … ]`). Neither appears in
 *   this repo's SQL. The hole is not silent, though — both drivers' bind-arity
 *   guards count the placeholders in the rewritten text and refuse a mismatch
 *   rather than binding the wrong value to the wrong column, so a future use of
 *   either form fails loudly at the boundary instead of returning wrong rows.
 */
export interface SqlSegment {
  readonly text: string;
  /** False for a literal, a quoted identifier or a comment. */
  readonly code: boolean;
}

/**
 * Split a statement into code and non-code runs.
 *
 * `--` line comments, block comments (`/* … *&#47;`), `'…'` string literals and `"…"`
 * quoted identifiers are all recognised, and a doubled quote inside a run is
 * treated as an escaped quote rather than the end of it — which is what makes
 * `'it''s ?'` scan correctly.
 */
export function segmentSql(sql: string): SqlSegment[] {
  const segments: SqlSegment[] = [];
  let code = '';
  let i = 0;
  const len = sql.length;

  const flush = (): void => {
    if (code.length > 0) {
      segments.push({ text: code, code: true });
      code = '';
    }
  };

  while (i < len) {
    const ch = sql.charAt(i);

    if (ch === "'" || ch === '"') {
      flush();
      let quoted = ch;
      i += 1;
      while (i < len) {
        const c = sql.charAt(i);
        quoted += c;
        i += 1;
        if (c === ch) {
          // A doubled quote is an escaped quote, not the end of the run.
          if (sql.charAt(i) === ch) {
            quoted += ch;
            i += 1;
            continue;
          }
          break;
        }
      }
      segments.push({ text: quoted, code: false });
      continue;
    }

    if (ch === '-' && sql.charAt(i + 1) === '-') {
      flush();
      let comment = '';
      while (i < len && sql.charAt(i) !== '\n') {
        comment += sql.charAt(i);
        i += 1;
      }
      segments.push({ text: comment, code: false });
      continue;
    }

    if (ch === '/' && sql.charAt(i + 1) === '*') {
      flush();
      let comment = '/*';
      i += 2;
      while (i < len && !(sql.charAt(i) === '*' && sql.charAt(i + 1) === '/')) {
        comment += sql.charAt(i);
        i += 1;
      }
      comment += '*/';
      i += 2;
      segments.push({ text: comment, code: false });
      continue;
    }

    code += ch;
    i += 1;
  }

  flush();
  return segments;
}
