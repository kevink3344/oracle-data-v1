/**
 * `ViewResultWindow` — one saved view's result, in its own browser window.
 *
 * ── ★ WHY THIS EXISTS
 *
 * The View Builder draws its result in the right-hand panel of a two-column
 * layout, which is the right shape while you are *editing* — the SQL is beside the
 * rows it produced. It is the wrong shape when you want to READ the result: the
 * panel is narrow, the page has its own scroll, and the editor's own scrollbars
 * compete with the table's. So the result gets an address of its own and opens in
 * a new window, where it is the only thing on the page.
 *
 * ── ★ IT RE-RUNS THE VIEW, AND THAT IS THE HONEST CHOICE
 *
 * The alternative is to hand the already-computed rows to the new window — through
 * `window.opener`, or `postMessage`, or `localStorage`. All three are worse:
 *
 *   - They only work if the window was opened *from* the builder, so the URL would
 *     be useless as a bookmark, in a shared link, or after a reload.
 *   - A result handed over that way is a **snapshot with no timestamp**, and the
 *     page would have to claim a freshness it cannot verify.
 *
 * So this page runs the view itself, states the duration it measured, and the URL
 * works from anywhere. The cost is one extra query — the same one the builder just
 * ran.
 *
 * ── ★ IT RUNS THE **SAVED** STATEMENT, NOT AN UNSAVED EDITOR BUFFER
 *
 * `POST /api/views/{id}/run` reads `saved_view` and executes what is stored there.
 * An unsaved edit in the builder's editor is deliberately NOT reflected here — the
 * URL names a *view*, and a view is a row. The builder's link says "Open in a new
 * window", not "Open this draft", because those are different promises and only
 * the first is one this page can keep.
 *
 * ── ★ THE STATES, KEPT APART
 *
 *   - **loading** — the view's title is being fetched.
 *   - **running** — the statement is in flight.
 *   - **failed** — with the driver's own message, unedited. A SQL error names the
 *     construct; replacing it with "something went wrong" would throw away the only
 *     useful sentence on the page.
 *   - **result** — including a result of **zero rows**, which is a real answer and
 *     is drawn as a table with no body rather than as an error.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import ViewResultGrid from '../components/ViewResultGrid';
import { pluralise } from '../data/format';
import { fetchView, type ViewDetail, type ViewRun } from '../data/savedViews';

/**
 * A refusal, in the same shape the View Builder's pane reads.
 *
 * ★ DUPLICATED FROM `routes/ViewBuilder.tsx` RATHER THAN IMPORTED, AND THAT IS A
 *   SMELL WORTH NAMING. `ApiFailure` and `failureCode` are not exported there, so
 *   importing them would mean widening that file's surface for this one's benefit.
 *   The two shapes are four fields and a one-line helper; when a third screen needs
 *   them the right move is a shared module, not a third copy.
 */
interface ApiFailure {
  status: number;
  code: string;
  message: string;
  hint?: string;
  details: Record<string, unknown>;
}

function failureCode(failure: ApiFailure): string {
  const inner = failure.details['code'];
  return typeof inner === 'string' ? inner : failure.code;
}

type Outcome =
  | { kind: 'loading' }
  | { kind: 'running' }
  | { kind: 'result'; run: ViewRun }
  | { kind: 'failed'; failure: ApiFailure };

export default function ViewResultWindow() {
  const { id } = useParams<{ id: string }>();
  const viewId = id === undefined ? Number.NaN : Number(id);

  const [view, setView] = useState<ViewDetail | null>(null);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'loading' });

  /**
   * Run the view.
   *
   * ★ `POST …/run` RATHER THAN `…/preview`, AND THE DIFFERENCE IS A WRITE. `run`
   *   records a history row and a fingerprint, which is what a subscription
   *   compares against; `preview` records nothing. A reader who opens a result in
   *   its own window has *run* the view — that is what the button said — so the
   *   history should hold it.
   */
  const run = useCallback(async (idToRun: number) => {
    setOutcome({ kind: 'running' });
    try {
      const res = await fetch(`/api/views/${idToRun}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values: {} }),
      });
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text === '' ? null : JSON.parse(text);
      } catch {
        setOutcome({
          kind: 'failed',
          failure: {
            status: res.status,
            code: 'NOT_JSON',
            message:
              `The run answered HTTP ${res.status} with ` +
              `${res.headers.get('content-type') ?? 'no content type'}, not JSON. If the status is 200, ` +
              'the request reached the Vite dev server instead of the API — check the `/api` proxy in ' +
              '`app/vite.config.ts` and that the API is listening on 127.0.0.1:5181.',
            details: {},
          },
        });
        return;
      }

      const envelope = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;

      if (!res.ok) {
        const error = (typeof envelope['error'] === 'object' && envelope['error'] !== null
          ? envelope['error']
          : {}) as Record<string, unknown>;
        const details = (typeof error['details'] === 'object' && error['details'] !== null
          ? error['details']
          : {}) as Record<string, unknown>;
        setOutcome({
          kind: 'failed',
          failure: {
            status: res.status,
            code: typeof error['code'] === 'string' ? error['code'] : `HTTP_${res.status}`,
            message:
              typeof error['message'] === 'string'
                ? error['message']
                : `The run answered HTTP ${res.status} with no error message.`,
            ...(typeof details['hint'] === 'string' ? { hint: details['hint'] } : {}),
            details,
          },
        });
        return;
      }

      setOutcome({ kind: 'result', run: (envelope['data'] ?? parsed) as ViewRun });
    } catch (e) {
      setOutcome({
        kind: 'failed',
        failure: {
          status: 0,
          code: 'UNREACHABLE',
          message: e instanceof Error ? e.message : String(e),
          details: {},
        },
      });
    }
  }, []);

  useEffect(() => {
    if (!Number.isFinite(viewId)) {
      setOutcome({
        kind: 'failed',
        failure: {
          status: 400,
          code: 'BAD_REQUEST',
          message: `"${id ?? ''}" is not a view id.`,
          details: {},
        },
      });
      return;
    }
    let cancelled = false;
    void (async () => {
      // The title is fetched so the window's heading names the view rather than a
      // number. Its failure is not fatal — the run below reports its own.
      try {
        const detail = await fetchView(viewId);
        if (!cancelled) setView(detail);
      } catch {
        /* the run below is the authoritative call */
      }
      if (!cancelled) await run(viewId);
    })();
    return () => {
      cancelled = true;
    };
  }, [viewId, id, run]);

  const result = outcome.kind === 'result' ? outcome.run.result : null;

  return (
    <div className="vb-window">
      <header className="vb-window__head">
        <div className="vb-window__id">
          <h1 className="vb-window__title">{view === null ? 'View result' : view.title}</h1>
          <p className="vb-window__sub">
            {view !== null && (
              <>
                <code>{view.slug}</code>
                {' · '}
              </>
            )}
            {outcome.kind === 'loading' && 'Loading the view…'}
            {outcome.kind === 'running' && 'Running…'}
            {outcome.kind === 'result' && (
              <>
                {pluralise(outcome.run.result.rowCount, 'row')} · {outcome.run.durationMs} ms
                {outcome.run.runId !== null ? ' · recorded in run history' : ''}
              </>
            )}
            {outcome.kind === 'failed' && 'The statement did not run.'}
          </p>
        </div>
        <div className="vb-window__actions">
          <button
            type="button"
            className="btn btn--system btn--sm"
            onClick={() => void run(viewId)}
            disabled={outcome.kind === 'running' || !Number.isFinite(viewId)}
          >
            {outcome.kind === 'running' ? 'Running…' : 'Run again'}
          </button>
          {/*
            ★ A PLAIN `<Link>`, NOT `window.close()`. A window the reader opened
            themselves can be closed by script only if script opened it — and this
            page may equally have been reached by pasting the URL. A link back to
            the builder always works; a close button that silently does nothing is
            worse than no button.
          */}
          {view !== null && (
            <Link className="btn btn--system btn--sm" to={`/admin/views?view=${view.id}`}>
              Open in the builder
            </Link>
          )}
        </div>
      </header>

      {outcome.kind === 'failed' && <FailurePane failure={outcome.failure} />}

      {result !== null && (
        <div className="panel">
          <ViewResultGrid
            result={result}
            emptyHint="The statement ran and returned no rows. That is a result, not a failure — the filter matched nothing."
          />
        </div>
      )}
    </div>
  );
}

/**
 * The driver's message, verbatim.
 *
 * ★ THE MESSAGE IS NOT SUMMARISED. `Incorrect syntax near ')'` and
 *   `The multi-part identifier "k.combination_key" could not be bound` are the two
 *   sentences that actually locate a fault, and a page that replaced them with
 *   "the query failed" would be a page you cannot debug from. The statement that
 *   was sent is shown alongside, because the error names a position in a string
 *   the reader cannot otherwise see.
 */
function FailurePane({ failure }: { failure: ApiFailure }) {
  const statement = typeof failure.details['statement'] === 'string' ? failure.details['statement'] : null;

  return (
    <div className="notice notice--err vb-error" role="alert">
      <div>
        <p className="vb-error__code">
          <strong>{failure.status === 0 ? 'No answer' : `HTTP ${failure.status}`}</strong>{' '}
          <code>{failureCode(failure)}</code>
        </p>
        <pre className="vb-error__message">{failure.message}</pre>
        {failure.hint !== undefined && <p className="vb-error__hint">{failure.hint}</p>}
        {statement !== null && statement.trim() !== '' && (
          <details className="vb-error__statement">
            <summary>The statement that was sent</summary>
            <pre>{statement}</pre>
          </details>
        )}
      </div>
    </div>
  );
}
