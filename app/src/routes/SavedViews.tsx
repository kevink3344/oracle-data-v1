/**
 * Saved Views — the reader's half of the View Builder.
 *
 * ── ★ WHAT THIS PAGE IS, AND WHAT IT IS NOT
 *
 * `/admin/views` is where a view is **authored**: write the SQL, declare the
 * parameters, run it, look at the result, iterate. This page is where a view is
 * **watched**: pick one, and see the count when you started watching beside the
 * count now, with the date it last actually changed. The two read the same tables
 * and only one of them runs SQL, which is why they are two pages and not two
 * tabs — every control on this one either reads a row or writes a subscription
 * row, and nothing on it can change a view or spend a query on a whim.
 *
 * ── ★ THE ONE SENTENCE THAT KEEPS THIS SCREEN HONEST
 *
 * A subscription is **a row**. Nothing in this deployment reads it: there is no
 * scheduler to run a view on a timer and no sender to deliver anything. So no
 * string on this page says *notify*, *notification* or *alert*, and the subscribe
 * confirmation says what actually happens — a change is recorded the next time the
 * view runs, and nothing is sent. A page that says "we'll email you" is a page that
 * lies once and is distrusted forever, and this one has six columns of numbers it
 * wants to be believed about.
 *
 * ── ★ THE FOUR WAYS A COUNT HERE COULD LIE, AND WHAT STOPS EACH
 *
 *   1. A count that reached the row cap is a **floor**, not a total. It is
 *      rendered `200+` rather than `200`, from `current_truncated`.
 *   2. A view that has never produced a result has **no count**, and `Number(null)`
 *      is `0`. Every cell here is a branch on `null` before any number reaches
 *      `format.ts`, whose helpers all end in `Number(n) || 0` — so a null handed to
 *      `num()` becomes "0 rows", which is a figure a reader believes.
 *   3. A view that *ran* and found nothing is `0`, and that is a different fact
 *      from (2). They are printed differently on purpose.
 *   4. A view whose statement stopped returning the column it fingerprints on is
 *      **not** comparable any more, and its runs are not evidence of "no change".
 *      That row reads `Cannot watch`, not `Unchanged`.
 *
 * ── ★ THE THREE STATES THAT MUST NOT BE FAKED
 *
 * *Reading subscriptions…* / *Nothing is being watched yet* / *this server has the
 * View Builder switched off* are three different sentences, and the third is the
 * one that matters: a refusal and an empty list look identical in a table, so the
 * refusal names the variable that causes it (`VIEW_BUILDER_ENABLED=1`) and says to
 * restart. The reads on this page are deliberately **not** behind that flag — the
 * flag guards what executes SQL or writes a row — so a switched-off server still
 * draws the whole table and refuses only at the moment of subscribing.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import ErrorNotice from '../components/ErrorNotice';
import ResizeGrip, { clampWidth, readStoredWidth, storeWidth } from '../components/ResizeGrip';
import ViewResultGrid from '../components/ViewResultGrid';
import { isoDay, num, pluralise } from '../data/format';
import { ApiError } from '../data/organizations';
import {
  changedSinceSubscribed,
  fetchView,
  hasOrderBy,
  previewSavedView,
  subscribe,
  unsubscribe,
  useAllViews,
  useSubscribedViews,
  watchRefusal,
  watchStatus,
  watchStatusDetail,
  WATCH_STATUS_LABELS,
  withheldSentence,
} from '../data/savedViews';
import type { SubscribedView, ViewDetail, ViewRun, SavedViewRow, WatchRefusal } from '../data/savedViews';
import { currentOwner, useSession } from '../data/session';

/* ------------------------------------------------------------------------- *
 * Small pieces
 * ------------------------------------------------------------------------- */

/** The trash, the same path `EditableField.tsx` draws with its own copy. */
function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M6.4 1.3h3.2l.4.9h3v1.5H3V2.2h3l.4-.9ZM3.9 5.1h8.2l-.6 9.1a.8.8 0 0 1-.8.8H5.3a.8.8 0 0 1-.8-.8L3.9 5.1Zm2.2 1.4.3 7h.9l-.3-7h-.9Zm2.5 0-.2 7h.9l.3-7h-1Z"
        fill="currentColor"
      />
    </svg>
  );
}

/**
 * One figure, from a run that may not exist and a cap that may have cut it short.
 *
 * ★ `null` IS RENDERED BEFORE `num()` IS ALLOWED NEAR IT. That is the whole reason
 *   this is a component rather than an inline expression: the null case is not an
 *   edge, it is the state of every view that has never run, and it has to be a dash
 *   with a reason attached rather than a zero.
 */
function CountCell({
  value,
  truncated,
  none,
}: {
  value: number | null;
  truncated: boolean | null;
  /** Why there is no number — shown on hover, so the dash is not simply blank. */
  none: string;
}) {
  if (value === null) {
    return (
      <span className="vb-null" title={none}>
        —
      </span>
    );
  }
  if (truncated === true) {
    return (
      <span
        title={
          `The run stopped at the row cap of ${num(value)}, so this is a floor: ` +
          'the view holds at least this many rows, and how many more it holds has not been asked.'
        }
      >
        {num(value)}+
      </span>
    );
  }
  return <>{num(value)}</>;
}

/** A refusal, with the server's own sentence under a heading that names its kind. */
interface Refusal {
  tone: 'warn' | 'err';
  heading: string;
  body: string;
}

/**
 * Turn a thrown error into something a reader can act on.
 *
 * ★ THE SERVER'S MESSAGE IS CARRIED UP UNEDITED AND THE HEADING IS OURS. Every
 *   refusal this page can provoke already explains itself better than a client
 *   could — the `WRITES_DISABLED` message *names the environment variable* and says
 *   to restart, and `NO_FINGERPRINT_KEY` says which field to add and why a column
 *   is needed at all. Rewriting those would lose the fix; printing them bare would
 *   lose which refusal it is. So: heading, then their sentence, word for word.
 *
 * The domain codes live in `details.code` and the envelope's `code` is the HTTP
 * class, so both are read — `WRITES_DISABLED` is an envelope code and the two
 * fingerprint/parameter refusals are `BAD_REQUEST` with their own code in the
 * details.
 *
 * ★ `form` EXISTS BECAUSE TWO HEADINGS WERE ONLY TRUE OF ONE OF THE TWO THINGS THIS
 *   PAGE ASKS THE SERVER TO DO. It both *records a subscription* and *runs a
 *   preview*, and the same `WRITES_DISABLED` refusal means different things to each:
 *   "this server will not record a subscription" is right for the subscribe button
 *   and wrong for the panel, which is not asking to record anything and is being
 *   refused on the grounds that its statement is executable. One code, two true
 *   headings. The fallback headings stay shared, which is why this is a parameter
 *   rather than a second function — the code extraction above is the part that must
 *   not be written twice.
 */
function refusalOf(err: unknown, form: 'subscription' | 'preview' = 'subscription'): Refusal {
  const code = err instanceof ApiError ? err.code : '';
  const details = err instanceof ApiError ? (err.details as { code?: unknown } | null) : null;
  const detail = typeof details?.code === 'string' ? details.code : '';
  const message = err instanceof Error ? err.message : String(err);

  if (code === 'WRITES_DISABLED') {
    return form === 'preview'
      ? { tone: 'warn', heading: 'This server does not run SQL.', body: message }
      : { tone: 'warn', heading: 'This server will not record a subscription.', body: message };
  }
  if (detail === 'NO_FINGERPRINT_KEY') {
    return { tone: 'warn', heading: 'This view cannot be watched for changes.', body: message };
  }
  if (detail === 'MISSING_PARAM_VALUE') {
    return form === 'preview'
      ? { tone: 'warn', heading: 'This view needs a value the panel cannot supply.', body: message }
      : { tone: 'warn', heading: 'This view needs a value first.', body: message };
  }
  if (detail === 'CHANNEL_NOT_IMPLEMENTED') {
    return { tone: 'warn', heading: 'That channel is not implemented.', body: message };
  }
  if (code === 'NOT_FOUND') {
    return { tone: 'err', heading: 'That view is no longer there.', body: message };
  }
  return {
    tone: 'err',
    heading: form === 'preview' ? 'That view could not be shown.' : 'That was not recorded.',
    body: message,
  };
}

function Notice({ refusal }: { refusal: Refusal }) {
  return (
    <div className={`notice notice--${refusal.tone === 'warn' ? 'warn' : 'err'}`}>
      <div>
        <p>
          <strong>{refusal.heading}</strong> {refusal.body}
        </p>
      </div>
    </div>
  );
}

/** `200+` needs a legend, and the legend belongs on the page rather than in a title. */
const CAP_NOTE =
  'Every figure here is a row_count from a run, and every run stops at the server’s row cap — so a ' +
  'count that reached it is printed with a + because it is a floor, not a total. A dash means no run ' +
  'has produced a result, which is not the same as a run that found nothing.';

/* ------------------------------------------------------------------------- *
 * The panel
 * ------------------------------------------------------------------------- */

/** Each panel in this app owns its own remembered width, and this is this one's. */
const PANEL_W_KEY = 'views-panel-w';

const FOCUSABLE =
  'a[href], button:not([disabled]), summary, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * The result of one watched view, in a drawer.
 *
 * ── ★ WHY THIS PREVIEWS RATHER THAN RUNS, WHICH IS THE WHOLE DESIGN OF IT
 *
 * The obvious implementation is `POST /api/views/{id}/run`: one request instead of
 * two, and it returns exactly the result this panel wants to draw. It is also
 * wrong, and the way it is wrong is invisible on the first look.
 *
 * A run records a history row **unconditionally**, and the fingerprint in that row
 * is what the table behind this panel compares a subscription against. So a reader
 * who opened the panel to look at a view that had changed would, by looking,
 * advance the recorded fingerprint to the new value — and the row they came to
 * investigate would then read *unchanged*. Their own scroll would become the
 * baseline. Worse, `Current` and `Last Change` are computed from those runs, so the
 * table would be reporting movements the page itself caused, and on a read-only
 * target the whole panel would fail because a run is refused as a write.
 *
 * So the panel asks for the statement instead — `GET /api/views/{id}` — and then
 * asks for it to be run with the recorder off. Two requests, the second carrying
 * SQL that came **from the server**, run under the same guards as a run. That is
 * the price of looking at a view without changing it, and it is a price worth
 * paying: this panel exists so a reader can decide whether a change is real, and a
 * panel that changes what it is measuring cannot answer that.
 *
 * ── ★ WHY IT IS OPENED BY SLUG AND RESOLVED TO A ROW
 *
 * The table links here with `?view=<slug>`, not an id: a slug is what a reader can
 * read in the URL and what the row already shows underneath the name. The slug is
 * resolved against the watches this page holds, which is also what keeps the panel
 * honest about the second half of its own subject — the caveat below describes what
 * *the watch* can see, so a panel opened for a view nobody watches has no business
 * printing it.
 */
function ViewPanel({
  slug,
  watch,
  ready,
  catalogueId,
  onClose,
}: {
  /** Non-null means the panel is open. The slug from `?view=`. */
  slug: string | null;
  /** The watch for that slug, once the list has been read. Null means nobody here watches it. */
  watch: SubscribedView | null;
  /** Whether the subscription list has been read — the slug can only be resolved after it has. */
  ready: boolean;
  /** The view's id from the catalogue, only so the dead-end state can offer a way onward. */
  catalogueId: number | null;
  onClose: () => void;
}) {
  const open = slug !== null;

  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const [width, setWidth] = useState<number | null>(() => readStoredWidth(PANEL_W_KEY));
  const [resizing, setResizing] = useState(false);
  const [rendered, setRendered] = useState(0);

  const [detail, setDetail] = useState<ViewDetail | null>(null);
  const [run, setRun] = useState<ViewRun | null>(null);
  const [failure, setFailure] = useState<Refusal | null>(null);

  const viewId = watch?.view_id ?? null;

  /* --- the body scroll lock, and giving focus back --------------------- */

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement as HTMLElement | null;
    document.body.classList.add('is-locked');
    return () => {
      document.body.classList.remove('is-locked');
      openerRef.current?.focus?.();
    };
  }, [open]);

  // Focus waits for content: moving focus to the close button on the frame the
  // drawer opens is what stops a screen reader reading an empty panel.
  useEffect(() => {
    if (open && watch !== null) closeRef.current?.focus();
  }, [open, watch]);

  /* --- Escape, and Tab kept inside ------------------------------------- */

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (first === undefined || last === undefined) return;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || active === panel)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  /* --- the width the grip starts from ---------------------------------- */

  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const el = panelRef.current;
      if (el) setRendered(Math.round(el.getBoundingClientRect().width));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

  /* --- the two requests ------------------------------------------------ */

  /**
   * ★ `viewId` IS THE DEPENDENCY AND `watch` IS NOT. The rows come back from a new
   * array on every refresh of the subscriptions, so an effect keyed on the row
   * object would re-run — and re-preview — every time the table re-read itself,
   * which is once per subscribe and once per unsubscribe. Keyed on the id, opening
   * the panel previews once and a re-read of the list alongside it changes nothing
   * on screen.
   */
  useEffect(() => {
    if (slug === null || viewId === null) {
      setDetail(null);
      setRun(null);
      setFailure(null);
      return;
    }
    let cancelled = false;
    setDetail(null);
    setRun(null);
    setFailure(null);

    void (async () => {
      try {
        const view = await fetchView(viewId);
        if (cancelled) return;
        setDetail(view);
        const preview = await previewSavedView(view);
        if (cancelled) return;
        setRun(preview);
      } catch (err) {
        if (cancelled) return;
        // ★ THE PREVIEW FORM, SO THE HEADING MATCHES WHAT WAS ACTUALLY REFUSED. A
        //   switched-off server refuses the *statement*, not the subscription, and
        //   the two want different headings over the same message.
        setFailure(refusalOf(err, 'preview'));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [slug, viewId]);

  const setUserWidth = useCallback((next: number) => {
    const clamped = clampWidth(next);
    setWidth(clamped);
    storeWidth(PANEL_W_KEY, clamped);
  }, []);

  const resetWidth = useCallback(() => {
    setWidth(null);
    storeWidth(PANEL_W_KEY, null);
  }, []);

  const style = width === null ? undefined : ({ '--drawer-w': `${width}px` } as CSSProperties);

  const status = watch === null ? null : watchStatus(watch);

  /* --- the body -------------------------------------------------------- */

  let body: ReactNode;

  if (!ready) {
    body = (
      <div className="sv-look">
        <p className="vb-empty vb-empty--quiet">Reading subscriptions…</p>
      </div>
    );
  } else if (watch === null) {
    body = (
      <div className="sv-look">
        <p className="vb-empty">
          Nothing on this page watches <code>{slug}</code>.
        </p>
        <p className="field__hint">
          This panel shows what a row in the table holds, so it opens from that row’s name. With no
          watch there is no subscription to read a result against, and drawing the grid anyway would
          put a result on screen beside a table that claims to watch it and does not.
          {catalogueId !== null ? (
            <>
              {' '}
              Open it in the <Link to={`/admin/views?view=${catalogueId}`}>View Builder</Link> to author
              it, or pick it from the dropdown above to start watching it.
            </>
          ) : null}
        </p>
      </div>
    );
  } else if (failure !== null) {
    body = (
      <div className="sv-look">
        <Notice refusal={failure} />
      </div>
    );
  } else if (detail === null) {
    body = (
      <div className="sv-look">
        <p className="vb-empty vb-empty--quiet">Reading the view…</p>
      </div>
    );
  } else if (run === null) {
    body = (
      <div className="sv-look">
        <p className="vb-empty vb-empty--quiet">Running a preview — nothing is recorded.</p>
      </div>
    );
  } else {
    const cap = run.result.limit;
    body = (
      <div className="sv-look">
        {/*
          ★ THE BLIND SPOT IS STATED BEFORE THE RESULT, NOT UNDER IT, AND THE NUMBER
            IS THE SERVER'S RATHER THAN THE WORD "200". A watch hashes the values of
            its key column across the rows the query returned, and a query stops at
            the cap — so this grid is not a window onto the view, it is a window onto
            exactly what is being compared. Reading it first is the difference
            between a reader who knows the limits of the figure above them and one
            who does not.
        */}
        <p className="field__hint">
          Watches the first {num(cap)} rows of this view. A change that keeps those rows and their
          values the same is not seen, and neither is anything past row {num(cap)}.
          {hasOrderBy(detail.sql) ? null : (
            <>
              {' '}
              This view has no <code>ORDER BY</code>, so its row order is not guaranteed and a
              reordering can read as a change.
            </>
          )}
        </p>

        <ViewResultGrid
          result={run.result}
          meta={
            <>
              {num(run.durationMs)} ms · a preview, so nothing was recorded
              {run.fingerprint !== null ? <> · fingerprint {run.fingerprint}</> : null}
            </>
          }
          footnote={
            <p className="field__hint">
              Asked for as a preview rather than a run, so opening this panel added no row to the run
              history. That matters here and not only in principle: a run records a fingerprint, the
              recorded fingerprint is what the row behind this panel is compared against, and a panel
              that advanced it would erase the change you opened it to look at.
            </p>
          }
        />
      </div>
    );
  }

  return (
    <aside
      ref={panelRef}
      id="view-panel"
      className={`drawer svpanel${open ? ' is-open' : ''}${resizing ? ' is-resizing' : ''}`}
      style={style}
      role="dialog"
      aria-modal="true"
      aria-label={watch === null ? 'A saved view' : `The result of ${watch.title}`}
      aria-hidden={!open}
      tabIndex={-1}
    >
      <ResizeGrip
        value={width ?? rendered}
        onChange={setUserWidth}
        onReset={resetWidth}
        onDraggingChange={setResizing}
        controls="view-panel"
        label="Resize the view panel"
      />
      <div className="drawer__head">
        <div className="drawer__eyebrow">Watched view</div>
        <h2 className="drawer__name">{watch?.title ?? slug}</h2>
        <div className="drawer__meta">
          <code>{slug}</code>
          {watch !== null && status !== null ? <> · {WATCH_STATUS_LABELS[status]}</> : null}
          {watch?.fingerprint_key != null ? (
            <>
              {' '}
              · compared on <b>{watch.fingerprint_key}</b>
            </>
          ) : null}
        </div>
        <button
          ref={closeRef}
          type="button"
          className="drawer__close"
          onClick={onClose}
          aria-label="Close the view panel"
        >
          <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="drawer__body">{body}</div>
    </aside>
  );
}

/* ------------------------------------------------------------------------- *
 * The page
 * ------------------------------------------------------------------------- */

export default function SavedViews() {
  const user = useSession();
  // One call, used for the request and for the sentence above it. The page must
  // not name one subscriber and query another.
  const owner = currentOwner(user);

  const { views, ready, error, refresh } = useSubscribedViews(owner);
  const catalogue = useAllViews();

  /**
   * The open panel is URL state, as it is on every other screen with a drawer in
   * this app — so a view's result can be linked to, bookmarked and reloaded, and
   * the row's own link is a plain `<Link>` rather than a click handler.
   *
   * ★ THE VALUE IS A SLUG RATHER THAN AN ID, AND THAT WAS A CHOICE. An id would
   *   resolve without the list, but the panel's caveat is a statement about the
   *   *watch* and not about the view, so the panel has to know which subscription it
   *   is showing either way. A slug is also what a reader can read, and it is the
   *   same string the row prints under its name — so the URL and the table agree.
   */
  const [params, setParams] = useSearchParams();
  const openSlug = (params.get('view') ?? '').trim();
  const openWatch = openSlug === '' || !ready
    ? null
    : (views.find((candidate) => candidate.slug === openSlug) ?? null);

  const closePanel = useCallback(() => {
    const next = new URLSearchParams(params);
    next.delete('view');
    setParams(next, { replace: true });
  }, [params, setParams]);

  /**
   * The catalogue's id for a slug the watch list does not hold, so the dead-end
   * state can offer a way onward. `ViewBuilder` reads `?view=` as an **id**
   * (`/^\d+$/`), which is why this is a lookup rather than the slug handed across.
   */
  const catalogueId =
    openSlug !== '' && openWatch === null
      ? (catalogue.views.find((candidate) => candidate.slug === openSlug)?.id ?? null)
      : null;

  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState(false);
  const [pickNote, setPickNote] = useState<string | null>(null);
  const [pickRefusal, setPickRefusal] = useState<Refusal | null>(null);
  const [stopRefusal, setStopRefusal] = useState<Refusal | null>(null);
  const [stopping, setStopping] = useState<number | null>(null);

  /* --- what may be offered -------------------------------------------- */

  // Already-watched views are held back too: the endpoint answers a repeat with the
  // row that exists, so offering one would put a control on the page that succeeds
  // and changes nothing.
  const watching = useMemo(() => new Set(views.map((view) => view.view_id)), [views]);

  const { offers, withheld } = useMemo(() => {
    const counts: Partial<Record<WatchRefusal, number>> = {};
    const list: SavedViewRow[] = [];
    for (const view of catalogue.views) {
      const refusal = watchRefusal(view, watching);
      if (refusal === null) list.push(view);
      else counts[refusal] = (counts[refusal] ?? 0) + 1;
    }
    return { offers: list, withheld: counts };
  }, [catalogue.views, watching]);

  const withheldNote = withheldSentence(withheld, Math.max(0, catalogue.total - catalogue.views.length));

  /* --- writes ---------------------------------------------------------- */

  const start = useCallback(async () => {
    const view = offers.find((candidate) => String(candidate.id) === chosen);
    if (!view || owner === null) return;
    setBusy(true);
    setPickRefusal(null);
    setPickNote(null);
    try {
      await subscribe(view.id, owner);
      // Refresh rather than pushing the returned row: re-subscribing is not an
      // error and answers with the row that already exists, so pushing would be
      // how a second copy gets into a table that has one row per view.
      refresh();
      setChosen('');
      setPickNote(
        `Watching “${view.title}”. A change is recorded the next time this view runs — nothing is sent ` +
          'yet, because this server has no scheduler and no sender.',
      );
    } catch (err) {
      setPickRefusal(refusalOf(err));
    } finally {
      setBusy(false);
    }
  }, [chosen, offers, owner, refresh]);

  const stop = useCallback(
    async (watch: SubscribedView) => {
      setStopping(watch.subscription_id);
      setStopRefusal(null);
      try {
        await unsubscribe(watch.view_id, watch.subscription_id);
        refresh();
      } catch (err) {
        setStopRefusal(refusalOf(err));
      } finally {
        setStopping(null);
      }
    },
    [refresh],
  );

  /*
   * ★ THE HEAD'S SENTENCE IS GONE, ON STAFF'S INSTRUCTION, AND SO IS `changedCount`.
   *
   * It read *"Saved queries you watch. N views watched · M changed since you subscribed."* — a
   * restatement of what the table below already shows per row. `changedSinceSubscribed` is kept:
   * the table's own per-row "changed" marker calls it, so only the count and the sentence go.
   */

  return (
    <div className="stack saved-views-page">
      <div>
        <div className="accent-rule" />
        <div className="page-head">
          <div>
            <h1>Views</h1>
          </div>
        </div>
      </div>

      {/* --- watch a view ------------------------------------------------ */}
      <section className="panel">
        <div className="panel__head">
          <div>
            <h2 className="panel__title">Watch a view</h2>
            <p className="panel__sub">
              {owner === null ? (
                <>
                  A subscription is recorded under a name, and this session has none — so there is
                  nothing to record a watch as.
                </>
              ) : (
                <>
                  You watch as <strong>{owner}</strong>. Subscriptions are labelled by name, not owned
                  by an account: nothing under <code>/api/views</code> requires a session yet, so two
                  people using the same name share one row, quietly.
                </>
              )}
            </p>
          </div>
        </div>

        <div className="panel__body">
          {owner === null ? (
            <p className="vb-empty">
              <Link to="/sign-in">Sign in</Link> to record a watch — or, if you are already signed in,
              this session has no name on it and the server has nothing to file a subscription under.
            </p>
          ) : (
            <>
              <div className="vb-inline">
                <label className="sr" htmlFor="sv-pick">
                  View to watch
                </label>
                <select
                  id="sv-pick"
                  className="input vb-pick"
                  value={chosen}
                  disabled={!catalogue.ready || offers.length === 0 || busy}
                  onChange={(event) => {
                    setChosen(event.target.value);
                    setPickRefusal(null);
                    setPickNote(null);
                  }}
                >
                  <option value="">
                    {!catalogue.ready
                      ? 'Reading the view list…'
                      : offers.length === 0
                        ? 'No view here can be watched'
                        : 'Choose a view…'}
                  </option>
                  {offers.map((view) => (
                    <option key={view.id} value={String(view.id)}>
                      {view.title}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn btn--system btn--sm"
                  disabled={chosen === '' || busy}
                  onClick={() => void start()}
                >
                  {busy ? 'Recording…' : 'Watch this view'}
                </button>
              </div>

              {/* The list itself failed, which is a different problem from the
                  dropdown being short — and it is why the count of what was
                  withheld is only claimed when the read worked. */}
              {catalogue.error !== null ? (
                <p className="field__hint">
                  The list of views could not be read, so what is offered here is nothing rather than
                  everything. {catalogue.error.message}
                </p>
              ) : withheldNote !== null ? (
                <p className="field__hint">{withheldNote}</p>
              ) : null}

              {pickNote !== null ? <p className="vb-note">{pickNote}</p> : null}
              {pickRefusal !== null ? <Notice refusal={pickRefusal} /> : null}
            </>
          )}
        </div>
      </section>

      {/* --- the table ---------------------------------------------------- */}
      <section className="panel">
        <div className="panel__head">
          <div>
            <h2 className="panel__title">Subscribed Views</h2>
            <p className="panel__sub">
              {!ready
                ? 'Reading subscriptions…'
                : views.length === 0
                  ? `Nothing is being watched as ${owner ?? 'nobody'}.`
                  : `${pluralise(views.length, 'view')} watched as ${owner}.`}
            </p>
          </div>
        </div>

        {error !== null ? (
          <div className="panel__body">
            <ErrorNotice
              error={error.message}
              reload={refresh}
              heading="The watch list could not be read."
              hint={
                <p>
                  This page reads <code>/api/views/subscriptions</code> from the API on port 5181, through
                  the dev server&rsquo;s <code>/api</code> proxy. If the API is not running, start it with{' '}
                  <code>npm run dev</code> in <code>server/</code> — and note that this is not the
                  purchase-order extract, which is a different file entirely.
                </p>
              }
            />
          </div>
        ) : !ready ? (
          <div className="panel__body">
            <p className="vb-empty vb-empty--quiet">Reading subscriptions…</p>
          </div>
        ) : views.length === 0 ? (
          <div className="panel__body">
            <p className="vb-empty">
              Pick a view above and watch it — this table then shows the count when you started beside
              the count now, and the date the result last actually changed. The line above names the
              subscriber this list is read for, because the endpoint answers for one name at a time:
              a row filed under a different one is not shown here and is not counted in that &ldquo;nothing&rdquo;.
            </p>
          </div>
        ) : (
          <>
            <div className="table-wrap">
              <table className="data sv-table">
                <caption className="sr">The saved views you watch.</caption>
                <thead>
                  <tr>
                    <th scope="col">View Name</th>
                    <th scope="col" className="n" title="From the newest run that produced a result.">
                      Current
                    </th>
                    <th
                      scope="col"
                      className="n"
                      title="From the newest run at or before the moment you subscribed."
                    >
                      Rows when subscribed
                    </th>
                    <th scope="col">Last Change</th>
                    <th scope="col">Status</th>
                    <th scope="col" className="sv-actions">
                      <span className="sr">Stop watching</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {views.map((watch) => {
                    const status = watchStatus(watch);
                    const detail = watchStatusDetail(watch);
                    const changed = changedSinceSubscribed(watch);
                    return (
                      <tr key={watch.subscription_id}>
                        <td>
                          <Link
                            className="sv-name"
                            to={`/views?view=${encodeURIComponent(watch.slug)}`}
                            title="Open this view’s result in the panel"
                          >
                            {watch.title}
                          </Link>
                          <span className="vb-table__key">{watch.slug}</span>
                        </td>
                        <td className="n">
                          <CountCell
                            value={watch.current_count}
                            truncated={watch.current_truncated}
                            none={
                              watch.current_ran_at === null
                                ? 'This view has never produced a result, so there is no count to show.'
                                : 'The newest run produced no count.'
                            }
                          />
                        </td>
                        <td className="n">
                          <CountCell
                            value={watch.subscribed_count}
                            truncated={watch.subscribed_truncated}
                            none="It had produced no result when you subscribed, so there is nothing to compare the runs since against."
                          />
                        </td>
                        <td>
                          {changed && watch.last_change_at !== null ? (
                            isoDay(watch.last_change_at)
                          ) : (
                            <>
                              {isoDay(watch.subscribed_at)}
                              <span className="vb-table__key">unchanged since you subscribed</span>
                            </>
                          )}
                        </td>
                        <td>
                          <span className={`sv-status sv-status--${status}`}>
                            {WATCH_STATUS_LABELS[status]}
                          </span>
                          {detail !== null ? <span className="vb-table__key">{detail}</span> : null}
                        </td>
                        <td className="sv-actions">
                          <button
                            type="button"
                            className="btn btn--system btn--sm sv-trash"
                            aria-label={`Stop watching ${watch.title}`}
                            title={`Stop watching ${watch.title}`}
                            disabled={stopping !== null}
                            onClick={() => void stop(watch)}
                          >
                            <TrashIcon />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="panel__body">
              {stopRefusal !== null ? <Notice refusal={stopRefusal} /> : null}
              <p className="field__hint">{CAP_NOTE}</p>
            </div>
          </>
        )}
      </section>

      <ViewPanel
        slug={openSlug === '' ? null : openSlug}
        watch={openWatch}
        ready={ready}
        catalogueId={catalogueId}
        onClose={closePanel}
      />
    </div>
  );
}
