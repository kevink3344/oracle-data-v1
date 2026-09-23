import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import ResizeGrip from '../components/ResizeGrip';
import {
  describeCap,
  dialectForm,
  loadReadCaps,
  previewCap,
  removeReadCap,
  saveReadCap,
  type ReadCap,
  type ReadCapDraft,
  type ReadCapList,
  type ReadCapPreview,
} from '../data/readCaps';
import '../styles/readcaps.css';

/**
 * Read caps — how many rows the app reads from each ledger object.
 *
 * ── ★ THE SUBJECT OF THIS PAGE IS HOW MUCH THE APP READS, NOT WHAT IS IN THE DATA
 *
 * Every other register in this app shows rows. This one shows the *bounds* on
 * reading them, because the EBS instance holds tables in the hundreds of millions
 * of rows (`GL_BALANCES` is 157 M; the AP surface 1.2 M checks) and a register that
 * reads one of those whole is not slow — it is a request that never returns. An
 * administrator sets the bound here, per object, without a redeploy, as the
 * instance grows.
 *
 * ── ★ THE PREVIEW IS THE SCREEN'S WHOLE ARGUMENT
 *
 * A cap is a number in a box, and a number in a box is not checkable. So the panel
 * that edits one **runs the statement it is about to save** and shows the first
 * rows back: which columns, which dates, whether the ordering puts what you expect
 * at the top. "The first 100,000 by `CHECK_DATE DESC`" is a claim until somebody
 * looks at the window it produces; after that it is a thing that was checked.
 *
 * The preview is bounded twice and says so: it runs through the draft cap (so the
 * number being typed has a visible effect) and shows at most 50 rows (because a
 * panel cannot render 100,000). Both bounds are printed.
 *
 * ── ★ A LIMIT WITH NO ORDERING IS REFUSED, AND THE PANEL SHOWS WHY
 *
 * `WHERE ROWNUM <= 100000` returns whichever rows the database reached first, so a
 * count of 100,000 means "at least 100,000" and every total describes an arbitrary
 * subset — invisibly. The server refuses that combination with a 400. The panel
 * does not hide the refusal behind a disabled button: it states the rule, and when
 * the server refuses it prints the server's own sentence, which names the fix.
 *
 * ── ★ THE DIALECT IS SHOWN, NOT ASSUMED
 *
 * Oracle spells a row bound `FETCH FIRST n ROWS ONLY` / the nested `ROWNUM` form;
 * SQLite spells it `LIMIT n`. The stored SQL carries no bound, so one row serves
 * both — and the panel prints which form this deployment used, plus the exact SQL
 * that ran, so a cap that misbehaves is diagnosable from the screen.
 */

/** The panel's focus trap reads the same set the other drawers use. */
const FOCUSABLE =
  'a[href], button:not([disabled]), summary, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Where the dragged width is remembered. Per panel, like the other drawers. */
const CAP_PANEL_WIDTH_KEY = 'readcaps-panel-w';

const MIN_WIDTH = 420;
const MAX_WIDTH = 1100;

function clampWidth(next: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(next)));
}

function readStoredWidth(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? clampWidth(n) : null;
  } catch {
    return null;
  }
}

function storeWidth(key: string, value: number | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, String(value));
  } catch {
    /* private mode — the width simply does not persist */
  }
}

/** The draft, as the form holds it. Strings, because an empty box is not a number. */
interface Draft {
  sql: string;
  maxRows: string;
  orderBy: string;
  note: string;
}

const BLANK: Draft = { sql: '', maxRows: '', orderBy: '', note: '' };

function draftOf(cap: ReadCap): Draft {
  return {
    // ★ THE STORED STATEMENT WINS, THEN THE DECLARED DEFAULT. A row with no `sql`
    //   means "keep the app's own query and only bound it", so the default is what
    //   the box shows — otherwise an administrator opening an object for the first
    //   time meets an empty statement and has to know the query before they can
    //   preview anything. The default is the app's own answer to that question.
    sql: cap.sql ?? cap.defaultSql ?? '',
    maxRows: cap.maxRows === null ? '' : String(cap.maxRows),
    // The same fallback for the ordering: the default's ordering is what makes the
    // default's window meaningful, so it is the field's starting value.
    orderBy: cap.orderBy ?? cap.defaultOrderBy ?? '',
    note: cap.note ?? '',
  };
}

/** The wire shape, or a refusal naming the field that is wrong. */
function toDraft(draft: Draft): { ok: true; value: ReadCapDraft } | { ok: false; problem: string } {
  const trimmed = draft.maxRows.trim();
  let maxRows: number | null = null;
  if (trimmed !== '') {
    const n = Number(trimmed);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      return { ok: false, problem: `The row limit must be a positive whole number, or blank for no limit. "${draft.maxRows}" is not.` };
    }
    maxRows = n;
  }
  return {
    ok: true,
    value: {
      sql: draft.sql.trim() === '' ? null : draft.sql.trim(),
      maxRows,
      orderBy: draft.orderBy.trim() === '' ? null : draft.orderBy.trim(),
      note: draft.note.trim() === '' ? null : draft.note.trim(),
    },
  };
}

/**
 * True when the draft differs from what the panel was **seeded** with.
 *
 * ★ IT COMPARES AGAINST THE SEEDED DRAFT, NOT AGAINST THE STORED ROW. The panel
 *   pre-fills from the declared default when no row is stored, so comparing to the
 *   stored row would report "changed" the moment the panel opened — Save enabled on
 *   a form nobody had touched, and a save that wrote a statement identical to the
 *   default. Seeding and comparing through the same function is what keeps those two
 *   in step; the alternative is two expressions that can disagree about what "the
 *   starting point" was.
 */
function differs(cap: ReadCap, draft: Draft): boolean {
  const seed = draftOf(cap);
  return (
    seed.sql !== draft.sql.trim() ||
    seed.maxRows !== draft.maxRows.trim() ||
    seed.orderBy !== draft.orderBy.trim() ||
    seed.note !== draft.note.trim()
  );
}

export default function ReadCaps() {
  const [list, setList] = useState<ReadCapList | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);
  const [filter, setFilter] = useState('');

  /** The object whose panel is open. Held by NAME, so a list reload cannot orphan it. */
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setProblem(null);
    loadReadCaps()
      .then((next) => {
        if (!alive) return;
        setList(next);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setProblem(err instanceof Error ? err.message : 'The read caps could not be read.');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  /**
   * Every object the server knows, with its cap when there is one.
   *
   * ★ THE SERVER SENDS A ROW FOR EVERY KNOWN OBJECT, CAPPED OR NOT, AND THAT IS
   *   LOAD-BEARING. An earlier version returned stored rows only and a bare list of
   *   names, so this memo had to synthesise a row for an uncapped object — and a
   *   synthesised row cannot carry the declared default statement, because the
   *   registry lives on the server. The panel then opened empty for every object
   *   nobody had capped yet. The defaults come from the server, so the row does too.
   */
  const rows = useMemo(() => {
    if (!list) return [];
    return [...list.items].sort((a, b) => a.tableName.localeCompare(b.tableName));
  }, [list]);

  const shown = useMemo(() => {
    const term = filter.trim().toLowerCase();
    // ★ FILTER BEFORE ANY CAP, NEVER AFTER. A capped list that is then filtered
    //   silently denies that matches exist outside the window — the bug this
    //   project has already recorded once. There is no cap here, but the order is
    //   written the safe way so adding one later cannot introduce it.
    const matched = term === '' ? rows : rows.filter((r) => r.tableName.toLowerCase().includes(term));
    return matched;
  }, [rows, filter]);

  const cappedCount = useMemo(() => rows.filter((r) => r.capped).length, [rows]);

  const open = editing !== null;
  const editingCap = useMemo(
    () =>
      editing === null
        ? null
        : (rows.find((r) => r.tableName.toUpperCase() === editing.toUpperCase()) ?? uncapped(editing)),
    [editing, rows],
  );

  const onSaved = useCallback((saved: ReadCap) => {
    // Re-read rather than splice: the counts and the dialect come from the server,
    // and a local patch would be a second implementation of the same arithmetic.
    setList((current) => {
      if (!current) return current;
      // ★ THE SAVED ROW REPLACES ITS OWN, AND EVERY OTHER ROW IS KEPT AS IT IS. The
      //   server sends a row per known object, so filtering the saved one out would
      //   silently drop the object from the register until the next reload.
      const items = current.items.map((i) =>
        i.tableName.toUpperCase() === saved.tableName.toUpperCase() ? saved : i,
      );
      return {
        ...current,
        items,
        counts: { total: items.filter((i) => i.capped).length, capped: items.filter((i) => i.capped).length },
      };
    });
  }, []);

  const onRemoved = useCallback((table: string) => {
    setList((current) => {
      if (!current) return current;
      // ★ REMOVAL CLEARS THE CAP, IT DOES NOT REMOVE THE OBJECT. The row stays — it
      //   is a known ledger object — and goes back to reporting itself uncapped with
      //   its declared default, which is what a reload would show.
      const items = current.items.map((i) =>
        i.tableName.toUpperCase() === table.toUpperCase()
          ? { ...i, sql: null, maxRows: null, orderBy: null, note: null, setBy: null, setAt: null, capped: false }
          : i,
      );
      return {
        ...current,
        items,
        counts: { total: items.filter((i) => i.capped).length, capped: items.filter((i) => i.capped).length },
      };
    });
  }, []);

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-head__title">Read caps</h1>
          <p className="page-head__sub">
            {list === null
              ? loading
                ? 'Reading the caps…'
                : 'The read caps could not be read.'
              : `${cappedCount} of ${rows.length} ledger objects are bounded. ` +
                'An object with no cap is read whole — which is only safe while the table is small.'}
          </p>
        </div>
      </div>

      {problem && (
        <div className="notice notice--err" role="alert">
          <strong>The read caps could not be read.</strong>
          <p>{problem}</p>
          <button type="button" className="btn" onClick={() => setReloadKey((k) => k + 1)}>
            Try again
          </button>
        </div>
      )}

      {list && (
        <section className="panel">
          <div className="panel__head">
            <h2 className="panel__title">Ledger objects</h2>
            <span className="panel__count">
              {shown.length === rows.length
                ? `${rows.length} objects`
                : `${shown.length} of ${rows.length}`}
            </span>
          </div>

          <div className="rcfilter">
            <input
              className="input rcfilter__input"
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by table name"
              aria-label="Filter ledger objects by table name"
            />
            {filter !== '' && (
              <button type="button" className="btn btn--system" onClick={() => setFilter('')}>
                Clear
              </button>
            )}
          </div>

          <p className="rcnote">
            Caps are applied in <strong>{list.dialect}</strong> — {dialectForm(list.dialect)}.
          </p>

          <div className="table-wrap">
            <table className="data rctable">
              <thead>
                <tr>
                  <th scope="col">Ledger object</th>
                  <th scope="col">Limit</th>
                  <th scope="col">Ordered by</th>
                  <th scope="col">Set by</th>
                  <th scope="col">
                    <span className="sr">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((cap) => (
                  <tr
                    key={cap.tableName}
                    className={cap.capped ? 'rcrow rcrow--capped' : 'rcrow'}
                    onClick={() => setEditing(cap.tableName)}
                  >
                    <th scope="row" className="rcrow__name">
                      <code>{cap.tableName}</code>
                    </th>
                    <td className="rcrow__limit">
                      {cap.maxRows === null ? (
                        <span className="rcrow__none">unbounded</span>
                      ) : (
                        cap.maxRows.toLocaleString('en-US')
                      )}
                    </td>
                    <td className="rcrow__order">
                      {cap.orderBy ? (
                        <code>{cap.orderBy}</code>
                      ) : (
                        <span className="rcrow__none">—</span>
                      )}
                    </td>
                    <td className="rcrow__by">{cap.setBy ?? <span className="rcrow__none">—</span>}</td>
                    <td className="rcrow__act">
                      <button
                        type="button"
                        className="btn rcrow__open"
                        aria-haspopup="dialog"
                        aria-expanded={open && editing?.toUpperCase() === cap.tableName.toUpperCase()}
                        aria-controls="readcap-panel"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditing(cap.tableName);
                        }}
                      >
                        {cap.capped ? 'Edit cap ›' : 'Set a cap ›'}
                      </button>
                    </td>
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={5} className="rcrow__empty">
                      No ledger object matches “{filter}”.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <ReadCapPanel
        cap={editingCap}
        onClose={() => setEditing(null)}
        onSaved={onSaved}
        onRemoved={(table) => {
          onRemoved(table);
          setEditing(null);
        }}
      />
    </div>
  );
}

/** An object with no stored row: uncapped, and not a missing record. */
function uncapped(tableName: string): ReadCap {
  return {
    tableName,
    sql: null,
    maxRows: null,
    orderBy: null,
    note: null,
    setBy: null,
    setAt: null,
    capped: false,
    defaultSql: null,
    defaultOrderBy: null,
    defaultNote: null,
  };
}

/**
 * One object's cap, edited in a panel that slides in from the right.
 *
 * ★ THE PREVIEW RUNS THE DRAFT, AND IT IS EXPLICIT ABOUT WHEN IT LAST DID. The
 *   result is stamped with the draft it came from, so a reader can tell whether
 *   what they are looking at matches what is in the form — the same discipline the
 *   organization panel applies by showing the stored row in its head and the draft
 *   in its fields.
 *
 * ★ SAVE IS DISABLED WHEN NOTHING CHANGED, rather than posting an identical row and
 *   reporting a success that changed nothing. The footer names what would be sent.
 */
function ReadCapPanel({
  cap,
  onClose,
  onSaved,
  onRemoved,
}: {
  cap: ReadCap | null;
  onClose: () => void;
  onSaved: (cap: ReadCap) => void;
  onRemoved: (table: string) => void;
}) {
  const open = cap !== null;

  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const [width, setWidth] = useState<number | null>(() => readStoredWidth(CAP_PANEL_WIDTH_KEY));
  const [resizing, setResizing] = useState(false);
  const [rendered, setRendered] = useState(0);

  const [draft, setDraft] = useState<Draft>(BLANK);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [patchProblem, setPatchProblem] = useState<string | null>(null);

  const [preview, setPreview] = useState<ReadCapPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewProblem, setPreviewProblem] = useState<string | null>(null);
  /** The draft the current preview came from, so a stale result is recognisable. */
  const [previewOf, setPreviewOf] = useState<string | null>(null);

  // Who opened the panel, and the scroll lock. Restoring focus to the opener is the
  // half of "it is a dialog" that is easy to skip and obvious when missing.
  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement as HTMLElement | null;
    document.body.classList.add('is-locked');
    return () => {
      document.body.classList.remove('is-locked');
      openerRef.current?.focus?.();
    };
  }, [open]);

  // Re-seed the form whenever the panel's subject changes. Keyed on the object's
  // name so a list reload that replaces the object does not clear a draft.
  useEffect(() => {
    if (!cap) return;
    setDraft(draftOf(cap));
    setSaved(null);
    setPatchProblem(null);
    setPreview(null);
    setPreviewOf(null);
    setPreviewProblem(null);
  }, [cap]);

  // ★ FOCUS HAS TO WAIT FOR THE CONTENT. On the first open the close button is not
  //   rendered yet, so focusing in the same commit silently does nothing.
  useEffect(() => {
    if (open && cap) closeRef.current?.focus();
  }, [open, cap]);

  // Escape closes; Tab is trapped inside. Both only while open.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const measure = () => setRendered(panelRef.current?.getBoundingClientRect().width ?? 0);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

  useEffect(() => {
    document.body.classList.toggle('is-resizing', resizing);
    return () => document.body.classList.remove('is-resizing');
  }, [resizing]);

  const parsed = toDraft(draft);
  const changed = cap !== null && differs(cap, draft);

  /**
   * The rule the panel enforces before the server does.
   *
   * ★ IT IS STATED, NOT JUST ENFORCED. A disabled Save with no explanation reads as
   *   a broken form; the sentence below the field says which rule is not met and
   *   what the fix is, and it is the same rule the server applies — so the two
   *   cannot disagree about what is allowed.
   */
  const needsOrder = parsed.ok && parsed.value.maxRows !== null && parsed.value.orderBy === null;

  async function runPreview() {
    if (busy || previewing || !cap || !parsed.ok || needsOrder) return;
    setPreviewing(true);
    setPreviewProblem(null);
    try {
      const result = await previewCap(cap.tableName, parsed.value);
      setPreview(result);
      setPreviewOf(JSON.stringify(draft));
    } catch (err: unknown) {
      setPreview(null);
      setPreviewOf(null);
      setPreviewProblem(err instanceof Error ? err.message : 'The preview did not run.');
    } finally {
      setPreviewing(false);
    }
  }

  async function onSave(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !cap || !parsed.ok || needsOrder || !changed) return;
    setBusy(true);
    setPatchProblem(null);
    try {
      const next = await saveReadCap(cap.tableName, parsed.value);
      setSaved(describeCap(next));
      onSaved(next);
    } catch (err: unknown) {
      setPatchProblem(err instanceof Error ? err.message : 'The cap was not saved.');
    } finally {
      setBusy(false);
    }
  }

  async function onClear() {
    if (busy || !cap) return;
    setBusy(true);
    setPatchProblem(null);
    try {
      await removeReadCap(cap.tableName);
      onRemoved(cap.tableName);
    } catch (err: unknown) {
      setPatchProblem(err instanceof Error ? err.message : 'The cap was not removed.');
    } finally {
      setBusy(false);
    }
  }

  const stale = preview !== null && previewOf !== JSON.stringify(draft);

  return (
    <aside
      ref={panelRef}
      id="readcap-panel"
      className={`drawer rcpanel${open ? ' is-open' : ''}${resizing ? ' is-resizing' : ''}`}
      style={width === null ? undefined : ({ '--drawer-w': `${width}px` } as CSSProperties)}
      role="dialog"
      aria-modal="true"
      aria-label={cap ? `${cap.tableName} — read cap` : 'Read cap'}
      aria-hidden={!open}
      tabIndex={-1}
    >
      <ResizeGrip
        value={width ?? rendered}
        onChange={(next) => {
          const clamped = clampWidth(next);
          setWidth(clamped);
          storeWidth(CAP_PANEL_WIDTH_KEY, clamped);
        }}
        onReset={() => {
          setWidth(null);
          storeWidth(CAP_PANEL_WIDTH_KEY, null);
        }}
        onDraggingChange={setResizing}
        controls="readcap-panel"
        label="Resize the read cap panel"
      />

      <div className="drawer__head">
        <div className="drawer__eyebrow">Read cap · ledger object</div>
        <h2 className="drawer__name">
          <code>{cap?.tableName ?? ''}</code>
        </h2>
        <div className="drawer__meta">
          {cap?.capped ? (
            <>
              Currently <strong>{describeCap(cap)}</strong>
              {cap.setBy && <> · set by {cap.setBy}</>}
            </>
          ) : (
            <>No cap stored — this object is read whole.</>
          )}
        </div>
        <button
          ref={closeRef}
          type="button"
          className="drawer__close"
          onClick={onClose}
          aria-label="Close the read cap panel"
        >
          ×
        </button>
      </div>

      <div className="drawer__body">
        <form className="rcform" onSubmit={onSave}>
          <div className="field">
            <label className="field__label" htmlFor="rc-sql">
              Statement <span className="field__hint">optional</span>
            </label>
            <textarea
              id="rc-sql"
              className="input rcform__sql"
              rows={5}
              spellCheck={false}
              value={draft.sql}
              onChange={(e) => setDraft((d) => ({ ...d, sql: e.target.value }))}
              placeholder="SELECT CHECK_ID, CHECK_NUMBER, CHECK_DATE FROM WCSEXP_AP_CHECKS"
            />
            {cap?.defaultNote && (
              // ★ THE DEFAULT'S OWN REASONING, SHOWN WHERE THE STATEMENT IS. The note
              //   is the one place the traps live — which column is NOT the obvious
              //   name, which table has no date, which join fans out — so a reader
              //   editing the statement meets them before changing it rather than
              //   after a preview fails.
              <p className="rcform__default">{cap.defaultNote}</p>
            )}
            <p className="field__note">
              The statement the app runs for this object. Leave it blank to keep the route’s own
              query and only bound it. <strong>Do not add a row limit here</strong> — the cap is
              appended in this deployment’s dialect, so the same row works on Oracle and SQLite.
            </p>
          </div>

          <div className="rcform__pair">
            <div className="field">
              <label className="field__label" htmlFor="rc-max">
                Row limit
              </label>
              <input
                id="rc-max"
                className="input"
                inputMode="numeric"
                value={draft.maxRows}
                onChange={(e) => setDraft((d) => ({ ...d, maxRows: e.target.value }))}
                placeholder="100000"
                aria-describedby="rc-max-note"
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="rc-order">
                Ordered by
              </label>
              <input
                id="rc-order"
                className="input"
                value={draft.orderBy}
                onChange={(e) => setDraft((d) => ({ ...d, orderBy: e.target.value }))}
                placeholder="CHECK_DATE DESC"
                aria-describedby="rc-order-note"
              />
            </div>
          </div>

          <p className="rcform__rule" id="rc-max-note">
            <strong>Blank limit reads the object whole.</strong> A limit with no ordering is
            refused: it would return whichever rows the database reached first, so every count and
            total built from it would describe an arbitrary subset while looking correct.
          </p>
          <p className="field__note" id="rc-order-note">
            A column name with an optional <code>ASC</code> or <code>DESC</code>, comma-separated
            for several. It is checked against the statement above, so it has to name a column that
            statement mentions.
          </p>

          <div className="field">
            <label className="field__label" htmlFor="rc-note">
              Note <span className="field__hint">optional</span>
            </label>
            <input
              id="rc-note"
              className="input"
              value={draft.note}
              onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
              placeholder="Why this number"
            />
          </div>

          {needsOrder && (
            <div className="notice notice--warn" role="status">
              A limit of {parsed.ok ? parsed.value.maxRows?.toLocaleString('en-US') : ''} needs an
              ordering before it can be saved or previewed.
            </div>
          )}
          {!parsed.ok && <div className="notice notice--err">{parsed.problem}</div>}
          {patchProblem && (
            <div className="notice notice--err" role="alert">
              {patchProblem}
            </div>
          )}
          {saved && (
            <div className="notice notice--ok" role="status">
              Saved — this object is now {saved.toLowerCase()}
            </div>
          )}

          {/* ── the preview ─────────────────────────────────────────────── */}
          <div className="rcprev">
            <div className="rcprev__head">
              <h3 className="rcprev__title">Preview</h3>
              <button
                type="button"
                className="btn"
                onClick={runPreview}
                disabled={busy || previewing || !parsed.ok || needsOrder || draft.sql.trim() === ''}
              >
                {previewing ? 'Running…' : 'Run preview'}
              </button>
            </div>

            {draft.sql.trim() === '' && (
              <p className="rcprev__empty">
                A preview needs a statement. Enter one above to see the rows this cap would return.
              </p>
            )}

            {previewProblem && (
              <div className="notice notice--err" role="alert">
                <strong>The preview did not run.</strong>
                <p>{previewProblem}</p>
              </div>
            )}

            {preview && (
              <>
                <p className="rcprev__meta">
                  {preview.returned === 0
                    ? 'The statement returned no rows.'
                    : `Showing ${preview.rows.length} of ${preview.returned} row${
                        preview.returned === 1 ? '' : 's'
                      }`}
                  {preview.truncated && (
                    <>
                      {' '}
                      — the statement produced more than the {preview.previewRows} this panel shows
                    </>
                  )}
                  {preview.maxRows !== null && (
                    <> · capped at {preview.maxRows.toLocaleString('en-US')}</>
                  )}{' '}
                  · {preview.ms.toLocaleString('en-US')} ms
                </p>

                {stale && (
                  <p className="rcprev__stale" role="status">
                    The form has changed since this preview ran. Run it again to see the current
                    draft.
                  </p>
                )}

                <details className="rcprev__sql">
                  <summary>The statement that ran ({preview.dialect})</summary>
                  <pre>
                    <code>{preview.statement}</code>
                  </pre>
                </details>

                {preview.rows.length > 0 && (
                  <div className="table-wrap rcprev__wrap">
                    <table className="data rcprev__table">
                      <thead>
                        <tr>
                          {preview.columns.map((c) => (
                            <th key={c} scope="col">
                              {c}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {preview.rows.map((row, i) => (
                          <tr key={i}>
                            {preview.columns.map((c) => (
                              <td key={c}>{cell(row[c])}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>
        </form>
      </div>

      <div className="drawer__foot">
        {cap?.capped && (
          <button type="button" className="btn btn--system" onClick={onClear} disabled={busy}>
            Remove cap
          </button>
        )}
        <span className="drawer__spacer" />
        <button type="button" className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn--primary"
          onClick={(e) => void onSave(e as unknown as React.FormEvent)}
          disabled={busy || !parsed.ok || needsOrder || !changed}
          title={changed ? undefined : 'Nothing has changed.'}
        >
          {busy ? 'Saving…' : 'Save cap'}
        </button>
      </div>
    </aside>
  );
}

/** A cell, rendered so a null reads as an absence rather than the word "null". */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
