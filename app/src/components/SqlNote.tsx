import type { ReactNode } from 'react';
import { useShowSql } from '../data/showSql';

/**
 * The SQL behind a figure, shown when the reader has asked for it.
 *
 * ── WHAT THIS IS FOR
 *
 * Staff asked to see how a number is arrived at, so they can be satisfied it is right. That is a
 * different question from "what does this number mean", and it needs a different answer: the
 * statement the database actually ran, not a description of it.
 *
 * ── ★ WHY IT IS RED, AND WHY THAT IS NOT DECORATION
 *
 * The request was explicit — "in red font". Red also does the right job here: this text is not part
 * of the page's argument, it is *evidence attached to* the argument, and it must be impossible to
 * mistake for a figure or a caption. It is set in the mono face for the same reason: a reader
 * checking a query is scanning for a column name, and proportional text makes that slow.
 *
 * ★ RED IS NOT `--danger` OR `--warn`. Those tokens mean "something is wrong", and a query is not
 *   wrong — using them would tell a reader the page had a problem. This uses a dedicated
 *   `--sql-fg` token defined in both themes, so it reads as *annotation* rather than as *alarm*.
 *
 * ── ★ WHY THE COMPONENTS RENDER NOTHING WHEN THE TOGGLE IS OFF
 *
 * Not an optimisation: with the toggle off the server never sends the trace (the flag is on the
 * request), so there is nothing to render. The guard here is what makes the components safe to drop
 * into a page unconditionally — a page does not have to know whether the feature is on, and adding
 * one later cannot forget to check.
 */

/** One statement, as returned by the API. Mirrors `server/src/http/sql-trace.ts`. */
export interface SqlStatement {
  readonly sql: string;
  readonly ms: number;
  readonly rows: number | null;
}

/** The trace envelope the API attaches as a sibling of `data`. */
export interface SqlTrace {
  readonly statements: readonly SqlStatement[];
  readonly total: number;
  readonly truncated: boolean;
}

/**
 * Collapse a statement to one line for a compact display.
 *
 * ★ WHITESPACE IS COLLAPSED, NOT THE STATEMENT REWRITTEN. The server's own SQL is built with
 *   newlines and indentation, which is right for the ReadCaps editor and wrong for a caption under
 *   a stat card — it would be fifteen lines tall. Collapsing runs of whitespace keeps every token
 *   and every clause in order, so the text is still the statement; only its layout is lost. Nothing
 *   is removed, which matters because the whole point is that a reader can check it.
 */
function compact(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

/**
 * The statements behind a set of figures, for a reader who asked to see them.
 *
 * Renders nothing when the toggle is off or the response carried no trace.
 */
export function SqlNote({ trace, label }: { trace: SqlTrace | null | undefined; label?: string }) {
  const [on] = useShowSql();
  if (!on || !trace || trace.statements.length === 0) return null;

  return (
    <div className="sqlnote" role="note">
      <div className="sqlnote__head">
        <span className="sqlnote__flag">SQL</span>
        {label ? <span className="sqlnote__label">{label}</span> : null}
        <span className="sqlnote__meta">
          {trace.statements.length === 1 ? '1 statement' : `${trace.statements.length} statements`}
          {trace.truncated ? ` of ${trace.total} (truncated)` : ''}
        </span>
      </div>
      <ol className="sqlnote__list">
        {trace.statements.map((s, i) => (
          <li className="sqlnote__item" key={i}>
            <code className="sqlnote__sql">{compact(s.sql)}</code>
            <span className="sqlnote__cost">
              {s.rows === null ? `${s.ms} ms` : `${s.ms} ms · ${s.rows} ${s.rows === 1 ? 'row' : 'rows'}`}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * The SQL behind one stat card, in small lettering under the figure.
 *
 * ★ THE SMALLER VARIANT EXISTS BECAUSE THE REQUEST NAMED TWO PLACES. Beside the scope line the SQL
 *   is the subject and gets the full treatment; under a stat card it is a footnote to a figure that
 *   is already the subject, so it is set smaller and collapsed to one line. Same evidence, two
 *   weights — a card that grew to fifteen lines would push the figures it is explaining off screen.
 */
export function StatSql({ trace, label }: { trace: SqlTrace | null | undefined; label?: string }) {
  const [on] = useShowSql();
  if (!on || !trace || trace.statements.length === 0) return null;

  return (
    <div className="statsql" role="note">
      <span className="statsql__flag">SQL</span>
      {label ? <span className="statsql__label">{label}</span> : null}
      {trace.statements.map((s, i) => (
        <code className="statsql__sql" key={i}>
          {compact(s.sql)}
        </code>
      ))}
      {trace.truncated ? (
        <span className="statsql__meta">showing {trace.statements.length} of {trace.total}</span>
      ) : null}
    </div>
  );
}

/**
 * A page-level disclosure holding every statement the page's requests ran.
 *
 * ★ IT IS THE FALLBACK FOR PAGES THAT CANNOT ATTRIBUTE A STATEMENT TO A FIGURE. A register page
 *   runs a count and a page query for one table, so the trace belongs to the page rather than to
 *   any single card; showing it once at the foot is honest and readable, whereas duplicating the
 *   same two statements under five cards would be noise that trains a reader to skip it.
 */
export function PageSql({ traces, children }: { traces: Array<SqlTrace | null | undefined>; children?: ReactNode }) {
  const [on] = useShowSql();
  if (!on) return null;

  const all = traces.filter((t): t is SqlTrace => !!t && t.statements.length > 0);
  if (all.length === 0) return null;

  const statements = all.flatMap((t) => t.statements);
  const total = all.reduce((sum, t) => sum + t.total, 0);
  const truncated = all.some((t) => t.truncated);

  return (
    <section className="panel sqlpanel">
      <div className="panel__head">
        <h2 className="panel__title">The SQL behind this page</h2>
        <span className="panel__count">
          {statements.length === total ? `${total} statements` : `${statements.length} of ${total}`}
        </span>
      </div>
      <div className="panel__body">
        <p className="chart-note">
          Every statement the server ran to answer this page, in the order it ran them, with the time
          and row count each returned. This is what the figures above were computed from — the same
          text the database received, not a description of it.
          {truncated ? ' The list is truncated; the count above says how many ran in total.' : ''}
        </p>
        <ol className="sqlpanel__list">
          {statements.map((s, i) => (
            <li className="sqlpanel__item" key={i}>
              <code className="sqlpanel__sql">{compact(s.sql)}</code>
              <span className="sqlpanel__cost">
                {s.rows === null ? `${s.ms} ms` : `${s.ms} ms · ${s.rows} ${s.rows === 1 ? 'row' : 'rows'}`}
              </span>
            </li>
          ))}
        </ol>
        {children}
      </div>
    </section>
  );
}
