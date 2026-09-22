/**
 * `ViewResultGrid` — one view's result, rendered.
 *
 * ── ★ WHY THIS IS A COMPONENT OF ITS OWN RATHER THAN PART OF THE VIEW BUILDER
 *
 * It used to live inside `routes/ViewBuilder.tsx`, unexported, because the View
 * Builder was the only screen that drew a view's result. It is now the second.
 * `Views` (`routes/SavedViews.tsx`) opens a view in a panel, and a panel that drew
 * its own table would be a second implementation of the same four rules below —
 * and the way a second implementation fails is that the first one gets a fix.
 *
 * The split is along what each screen is *for*. This file knows how to render a
 * result and nothing else: given `result` and a column list, it draws them. The
 * View Builder keeps the editor, the column picker and the display config, and
 * injects the picker row into this table's head through `picker`; `Views` has no
 * picker at all, because a reader does not reorganise somebody else's view.
 *
 * ── ★ THE FOUR RULES THAT BREAK SILENTLY, WHICH IS WHY THEY MOVED TOGETHER
 *
 *   1. **A null renders `—`, never `$0.00` and never an empty cell.** Every helper
 *      in `data/format.ts` ends in `Number(n) || 0`, which is right for a chart and
 *      wrong for a funding column: a null amount means "no funding row" and `$0.00`
 *      means "funded zero dollars". Those are the two answers the first-funding
 *      question is actually about. So {@link renderCell} tests for null *before*
 *      consulting the format.
 *   2. **A truncated result says the preview is capped and invents no denominator.**
 *      `view-builder.md` §5.3 forbids a `COUNT(*)` before the `SELECT`, so the total
 *      is genuinely not available. The server fetches one row past the cap to
 *      *detect* truncation; this footer says the cap stopped there rather than
 *      printing "showing 200 of 4,812" from a number nobody asked for.
 *   3. **"Not run yet" is never `0 rows`.** That state is not here — it belongs to
 *      the caller, because only the caller knows whether the view has been run —
 *      but the same principle governs the footer: a count is only printed when
 *      there is a result behind it.
 *   4. **Drift is a named notice, not a refusal and not an empty table.** A column
 *      the query no longer returns is §7.3's "degraded, not broken": the config is
 *      kept, the message names the column, and the table still draws.
 *
 * Nothing here formats a number itself. `renderCell` dispatches to `data/format.ts`
 * by name, and {@link NUMERIC_FORMATS} is the same set the stylesheet's
 * `table.data th.n/td.n` right-aligns, so a column's alignment and its format can
 * not disagree.
 */

import type { ReactNode } from 'react';
import {
  isoDay,
  money,
  money0,
  moneyShort,
  monthLabel,
  monthLong,
  num,
  pct,
  pctSlim,
  pluralise,
} from '../data/format';

/* ------------------------------------------------------------------------- *
 * The API's shapes, as far as rendering them is concerned.
 * ------------------------------------------------------------------------- */

/**
 * The formats a column may be declared as.
 *
 * ★ THIS LIST IS THE CONTRACT WITH THE SERVER'S `ViewFormatSchema`, AND IT IS
 *   WRITTEN OUT RATHER THAN INFERRED. The app has no generated client and no shared
 *   types package — `server/` is a separate tsconfig and a separate runtime — so a
 *   format added on the server arrives here as a string this build does not know.
 *   {@link renderCell} handles that on purpose (see its default branch) rather than
 *   rendering the cell blank.
 */
export const VIEW_FORMATS = [
  'text',
  'money',
  'money0',
  'moneyShort',
  'num',
  'pct',
  'pctSlim',
  'day',
  'month',
  'monthLong',
] as const;

export type ViewFormat = (typeof VIEW_FORMATS)[number];

/** A cell. `null` is a real null the driver returned, not an empty string. */
export type Cell = string | number | null;

export interface Finding {
  code: string;
  severity: 'error' | 'warning';
  construct: string;
  message: string;
  fix: string | null;
  index: number;
}

export interface ResultColumn {
  key: string;
  label: string;
  format: ViewFormat;
  hidden: boolean;
}

/** A declared column the statement no longer returns. §7.3 — a notice, not a refusal. */
export interface Drift {
  key: string;
  message: string;
}

export interface ViewResult {
  columns: ResultColumn[];
  rows: Cell[][];
  rowCount: number;
  limit: number;
  truncated: boolean;
  findings: Finding[];
  drift: Drift[];
}

/* ------------------------------------------------------------------------- *
 * Cells
 * ------------------------------------------------------------------------- */

/** Formats that are read best right-aligned, matching `table.data th.n/td.n`. */
export const NUMERIC_FORMATS: ReadonlySet<ViewFormat> = new Set<ViewFormat>([
  'money',
  'money0',
  'moneyShort',
  'num',
  'pct',
  'pctSlim',
]);

export interface RenderedCell {
  text: string;
  null: boolean;
}

export function renderCell(value: Cell, format: ViewFormat): RenderedCell {
  // ★ NULL FIRST, BEFORE THE FORMAT IS CONSULTED. Every numeric helper in
  //   `format.ts` coerces through `Number(n) || 0`, so a null under `money` would
  //   print `$0.00` — an assertion that the amount is zero where the truth is
  //   that there is no amount. `—` is the app's own word for "not known".
  if (value === null || value === undefined) return { text: '—', null: true };

  const text = String(value);
  switch (format) {
    case 'money':
      return { text: money(Number(value)), null: false };
    case 'money0':
      return { text: money0(Number(value)), null: false };
    case 'moneyShort':
      return { text: moneyShort(Number(value)), null: false };
    case 'num':
      return { text: num(Number(value)), null: false };
    case 'pct':
      return { text: pct(Number(value)), null: false };
    case 'pctSlim':
      return { text: pctSlim(Number(value)), null: false };
    case 'day':
      return { text: isoDay(text), null: false };
    case 'month':
      return { text: monthLabel(text), null: false };
    case 'monthLong':
      return { text: monthLong(text), null: false };
    case 'text':
      return { text, null: false };
    default:
      // Exhaustive over `ViewFormat`; the default keeps a server that adds a
      // format unknown to this build rendering the raw value rather than blank.
      return { text, null: false };
  }
}

/* ------------------------------------------------------------------------- *
 * The grid
 * ------------------------------------------------------------------------- */

export interface ViewResultGridProps {
  result: ViewResult;
  /**
   * Which columns to draw, in this order.
   *
   * Defaults to `result.columns` filtered to the visible ones, which is what a
   * reader wants. The View Builder passes its own list because it draws hidden
   * columns too, under a picker row that can turn them back on.
   */
  columns?: ResultColumn[];
  /**
   * The View Builder's column picker, drawn inside `<thead>` above the labels.
   *
   * ★ AN ARBITRARY NODE RATHER THAN A FLAG, because the picker is the builder's
   *   editing surface and this file must not learn what a label input is. Passing
   *   the row through keeps the table's structure in one place — the picker has to
   *   be the first `<tr>` of the same `<thead>` the labels are in, since its cells
   *   align to the same columns — while keeping the *controls* with the screen that
   *   owns them.
   */
  picker?: ReactNode;
  /**
   * Extra notes for the count line — the builder's duration, fingerprint and
   * recorded-or-previewed state.
   *
   * ★ THE GRID OWNS THE COUNT SENTENCE AND THE CALLER OWNS THE META. The sentence
   *   about rows and the cap is a fact about the grid; "203 ms · recorded in run
   *   history" is a fact about the *request* that produced it, which a reader in
   *   `Views` never made. Splitting them is what lets `Views` print an honest
   *   footer instead of one that claims a run history it did not write.
   */
  meta?: ReactNode;
  /** What to say when `columns` is empty — the builder and the panel differ here. */
  emptyHint?: ReactNode;
  /**
   * Something the *screen* wants to say under this result.
   *
   * The View Builder uses it for the compiled parameter bindings. It is a slot
   * rather than a prop per sentence because the grid's job is to keep one stack — a
   * `<div class="vb-result">` is a grid with a gap, so a paragraph appended *outside*
   * it would get the panel's padding a second time and read as a separate block.
   */
  footnote?: ReactNode;
}

/**
 * The result, drawn.
 *
 * The order is deliberate and is the reader's order: what is wrong with the result
 * first (drift, then warnings), then the result, then what it does not contain.
 */
export default function ViewResultGrid({
  result,
  columns,
  picker,
  meta,
  emptyHint,
  footnote,
}: ViewResultGridProps) {
  const shown = columns ?? result.columns.filter((column) => !column.hidden);
  const hasNull = result.rows.some((row) => row.some((cell) => cell === null));

  return (
    <div className="panel__body vb-result">
      {
        // §7.3: a column the query no longer returns is a named notice, not a
        // refusal and not an empty table.
      }
      {result.drift.length > 0 && (
        <div className="notice notice--warn">
          <div>
            {result.drift.map((entry) => (
              <p key={entry.key}>{entry.message}</p>
            ))}
            <p>
              The display config was kept. Edit the query back, or clear the column under Display — a view
              that degrades is one you can still read.
            </p>
          </div>
        </div>
      )}

      {/* Warnings from a run that *did* work — an unused declaration, most
          often. Shown next to the result rather than blocking it. */}
      {result.findings.length > 0 && (
        <div className="notice notice--info">
          <div>
            {result.findings.map((finding, index) => (
              <p key={index}>
                <strong>{finding.construct || finding.code}</strong> {finding.message}
                {finding.fix !== null && (
                  <>
                    {' '}
                    <code>{finding.fix}</code>
                  </>
                )}
              </p>
            ))}
          </div>
        </div>
      )}

      {shown.length === 0 ? (
        <p className="vb-empty vb-empty--quiet">
          {emptyHint ?? 'Every column is hidden, so there is nothing to draw. Unhide one and the grid comes back.'}
        </p>
      ) : (
        <div className="table-wrap">
          <table className="data vb-table">
            <thead>
              {picker}
              <tr>
                {shown.map((column) => (
                  <th key={column.key} className={NUMERIC_FORMATS.has(column.format) ? 'n' : undefined}>
                    {column.label}
                    {column.label !== column.key && <span className="vb-table__key">{column.key}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {shown.map((column, columnIndex) => {
                    const sourceIndex = result.columns.findIndex((c) => c.key === column.key);
                    const cell = row[sourceIndex === -1 ? columnIndex : sourceIndex] ?? null;
                    const rendered = renderCell(cell, column.format);
                    return (
                      <td
                        key={column.key}
                        className={NUMERIC_FORMATS.has(column.format) ? 'n' : undefined}
                        title={rendered.null ? 'NULL — no value, which is not the same as zero' : undefined}
                      >
                        {rendered.null ? <span className="vb-null">—</span> : rendered.text}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="vb-footer">
        {result.truncated ? (
          <>
            Showing <strong>{num(result.rowCount)}</strong> — the preview stopped at the row cap of{' '}
            {num(result.limit)}. <strong>The preview is capped; the view is not.</strong> The total is not
            shown because learning it would mean a second full query, which is the cost this feature
            exists to bound.
          </>
        ) : (
          <>
            {pluralise(result.rowCount, 'row')}
            {result.rowCount < result.limit
              ? ' — the whole result.'
              : ' — the query returned exactly the cap; it may hold more.'}
          </>
        )}{' '}
        <span className="vb-footer__meta">
          {meta}
          {hasNull && (
            <>
              {' '}
              · <span className="vb-null">—</span> is NULL
            </>
          )}
        </span>
      </p>

      {footnote}
    </div>
  );
}
