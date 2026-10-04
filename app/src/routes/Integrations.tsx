import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import ResizeGrip, {
  clampWidth,
  readStoredWidth,
  storeWidth,
} from '../components/ResizeGrip';
import {
  activeWord,
  createIntegration,
  deleteIntegration,
  loadIntegrations,
  matchesFilter,
  updateIntegration,
  type Integration,
  type IntegrationDraft,
  type IntegrationList,
} from '../data/integrations';
import { num, pluralise } from '../data/format';
import { isSuperAdmin, useSession } from '../data/session';
import '../styles/integrations.css';

/**
 * Integrations — the external endpoints this deployment intends to call.
 *
 * ── ★ THE PAGE PRINTS AN INTENTION, AND SAYS SO
 *
 * There is no outbound HTTP client in this app. Nothing here calls any of these
 * URLs, and nothing could report whether one answers. So every screen that shows a
 * URL on this page shows it as **text**, and the one word that could be mistaken
 * for a status — `Active` — is a checkbox somebody ticked. The panel's URL hint and
 * the page's own sub-line both state that in as many words, because a reader who
 * sees a green-looking "Active" beside a URL will otherwise supply the meaning the
 * page cannot support.
 *
 * ── ★ READS ARE OPEN; WRITES ARE NOT, AND THE PAGE SHOWS THAT RATHER THAN EXPLAINING IT
 *
 * `GET /api/integrations` takes any signed-in account, because whether the payroll
 * webhook is switched on is not a secret and a member asked to check a figure needs
 * the answer. Every write is `requireSuperAdmin`. That split is the same one
 * `/settings` draws, so it is drawn the same way here: the register loads for
 * everybody, the write affordances appear only for a super admin, and a member can
 * still open a row to read the URL and description in full — which is the useful
 * half of the panel when the list has had to truncate both.
 *
 * ── ★ THE LAYOUT IS `ReadCaps.tsx`'s, BECAUSE IT IS THE SAME PROBLEM
 *
 * A flat register, a filter, and a slide-in editor with Save and Remove. Reusing
 * that structure means the drawer behaviour a reader has already learned — the
 * resize grip, the Escape key, the focus hand-back, the scroll lock — is identical
 * rather than merely similar, and it is why the CSS file that goes with this screen
 * only carries what no ancestor already provides.
 *
 * ── ★ NO ROW CAP, AND THE ABSENCE IS DELIBERATE
 *
 * `ReadCaps.tsx` warns that a filter must run before any cap, never after. This
 * register has no cap to get the order wrong against: it holds one row per outbound
 * endpoint a deployment is wired to, which is tens and not millions. Adding a cap
 * here would be the thing that creates the trap that warning is about.
 */

/** The panel's focus trap reads the same set the other drawers use. */
const FOCUSABLE =
  'a[href], button:not([disabled]), summary, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Where the dragged width is remembered. Per panel, like the other drawers. */
const PANEL_WIDTH_KEY = 'integrations-panel-w';

/** The columns' declared widths, so the panel can refuse before the server does. */
const TITLE_MAX = 200;
const DESC_MAX = 1000;

/** The draft, as the form holds it. */
interface Draft {
  title: string;
  description: string;
  url: string;
  active: boolean;
}

const BLANK: Draft = { title: '', description: '', url: '', active: false };

function draftOf(row: Integration): Draft {
  return { title: row.title, description: row.description, url: row.url, active: row.active };
}

/**
 * True when the draft differs from the draft it was **seeded** with.
 *
 * ★ ONE FUNCTION FOR BOTH MODES, AND THE CREATE CASE IS WHY. An edit is seeded from
 *   the stored row and a create from `BLANK`, so passing the seed in means "has
 *   anything changed" is one comparison rather than two — and a create that has had
 *   nothing typed into it is correctly *not* changed, which is what keeps a blank
 *   Save button from being enabled the moment the panel opens.
 */
function differs(seed: Draft, draft: Draft): boolean {
  return (
    seed.title !== draft.title.trim() ||
    seed.description !== draft.description.trim() ||
    seed.url !== draft.url.trim() ||
    seed.active !== draft.active
  );
}

/**
 * The seeded draft for the panel's current subject.
 *
 * ★ COMPARED AGAINST THE SEED, NOT AGAINST THE RAW ROW. The seed is trimmed and the
 *   draft is trimmed by `differs`, so a title stored with no padding but typed with
 *   a trailing space is still "unchanged" — otherwise Save would light up for a
 *   value the server would store identically.
 */
const SEED_NEW: Draft = BLANK;

/** The panel's subject. A create has no row, so it cannot be a row or a boolean. */
type Subject = { mode: 'new' } | { mode: 'edit'; row: Integration };

export default function Integrations() {
  const user = useSession();
  const may = isSuperAdmin(user);

  const [list, setList] = useState<IntegrationList | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [filter, setFilter] = useState('');

  /**
   * The result of the last write, announced above the register.
   *
   * ★ IT LIVES HERE RATHER THAN IN THE PANEL, AND THAT IS WHAT MAKES IT VISIBLE. A
   *   save answers with the stored row, so the panel is re-seeded from it and any
   *   notice the panel was holding is cleared in the same commit — a success
   *   sentence would be written and then erased before it was ever painted. Held by
   *   the route, it survives the re-seed, and the panel clears it through `onEdit`
   *   when the reader changes something again.
   */
  const [notice, setNotice] = useState<string | null>(null);

  const [subject, setSubject] = useState<Subject | null>(null);

  useEffect(() => {
    let alive = true;
    setProblem(null);
    loadIntegrations()
      .then((next) => {
        if (!alive) return;
        setList(next);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setProblem(err instanceof Error ? err.message : 'The integrations could not be read.');
      });
    return () => {
      alive = false;
    };
  }, [reloadKey]);

  /** Newest first, which is the order the endpoint answered in. */
  const rows = useMemo(() => (list ? list.items : []), [list]);

  const shown = useMemo(() => rows.filter((row) => matchesFilter(row, filter)), [rows, filter]);

  const editing = subject?.mode === 'edit' ? subject.row : null;

  /** Every write clears the last one's notice: a stale "Saved" beside a new edit lies. */
  function openPanel(next: Subject) {
    setNotice(null);
    setSubject(next);
  }

  function closePanel() {
    setSubject(null);
  }

  /**
   * The register is re-read after every write.
   *
   * ★ THE ROW IS REPLACED **AND** THE LIST IS RE-READ, WHICH LOOKS LIKE DOING IT TWICE
   *   AND IS NOT. The replacement is so the panel and the table agree in the frame
   *   the save returns; the re-read is because `counts` is derived by the **server** —
   *   §4.2 — and recomputing it here would be a second implementation of it, free to
   *   disagree with the list the moment either changed. `Settings.tsx` makes exactly
   *   this pair of moves for exactly this reason.
   */
  function onCreated(next: Integration) {
    setList((current) => (current ? { ...current, items: [next, ...current.items] } : current));
    setReloadKey((k) => k + 1);
    closePanel();
  }

  function onSaved(next: Integration) {
    setSubject({ mode: 'edit', row: next });
    setList((current) =>
      current ? { ...current, items: current.items.map((r) => (r.id === next.id ? next : r)) } : current,
    );
    setReloadKey((k) => k + 1);
  }

  function onRemoved() {
    setReloadKey((k) => k + 1);
    closePanel();
  }

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1 className="page-head__title">Integrations</h1>
          <p className="page-head__sub">
            The external endpoints this deployment intends to call — what each one is for, and
            where it lives. The app stores and shows these URLs; it does not call them, so{' '}
            <strong>Active</strong> records an intention rather than a working connection.
          </p>
        </div>
        {/* ★ `pluralise` ALREADY PRINTS THE NUMBER — "2 endpoints". Interpolating a count
            in front of it therefore rendered "2 2 integrations". The number is emphasised
            here, so it is written out and the noun chosen beside it, as `Settings.tsx`
            does for its own counts. */}
        {list && (
          <p className="intcounts">
            <strong>{num(list.counts.total)}</strong>{' '}
            {list.counts.total === 1 ? 'integration' : 'integrations'}
            {' · '}
            <strong>{num(list.counts.active)}</strong> active
          </p>
        )}
        {may && (
          <div className="page-head__actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => openPanel({ mode: 'new' })}
            >
              Add integration
            </button>
          </div>
        )}
      </div>

      {problem && (
        <div className="notice notice--err" role="alert">
          <strong>The integrations could not be read.</strong>
          <p>{problem}</p>
          <button type="button" className="btn" onClick={() => setReloadKey((k) => k + 1)}>
            Try again
          </button>
        </div>
      )}

      {notice && (
        <div className="notice notice--ok" role="status">
          {notice}
        </div>
      )}

      {/* `list === null` renders nothing below the head, as `ReadCaps.tsx` does: a
          spinner for a request that usually answers in one frame is worse than a
          page that arrives a frame late. */}
      {list && (
        <section className="panel">
          <div className="panel__head">
            <h2 className="panel__title">Outbound endpoints</h2>
            {/* `pluralise` is the whole phrase, so it stands alone here — see the note on
                the page-head counts. */}
            <span className="panel__count">
              {shown.length === rows.length
                ? pluralise(rows.length, 'endpoint')
                : `${shown.length} of ${pluralise(rows.length, 'endpoint')}`}
            </span>
          </div>

          <div className="intfilter">
            <input
              className="input intfilter__input"
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by title, description or URL"
              aria-label="Filter integrations by title, description or URL"
            />
            {filter !== '' && (
              <button type="button" className="btn btn--system" onClick={() => setFilter('')}>
                Clear
              </button>
            )}
          </div>

          <div className="table-wrap">
            <table className="data inttable">
              <thead>
                <tr>
                  <th scope="col">Title</th>
                  <th scope="col">Description</th>
                  <th scope="col">Integration URL</th>
                  <th scope="col">Active</th>
                  <th scope="col">Set by</th>
                  <th scope="col">
                    <span className="sr">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => {
                  const isOpen = editing !== null && editing.id === row.id;
                  return (
                    <tr
                      key={row.id}
                      className="introw"
                      onClick={() => openPanel({ mode: 'edit', row })}
                    >
                      <th scope="row" className="introw__title">
                        {row.title}
                      </th>
                      {/* `title` carries the whole value: the cell truncates, and a
                          truncated description with no way to read it is a row that
                          cannot be reviewed from the register. */}
                      <td className="introw__desc" title={row.description}>
                        {row.description}
                      </td>
                      {/* ★ TEXT, NEVER AN `<a href>`. A link invites a click that goes
                          somewhere the reader did not intend, and an `href` assigned
                          from a database column is the shape of a stored-XSS bug. The
                          server's scheme allowlist is what would make turning this
                          into a link a small change rather than a dangerous one. */}
                      <td className="introw__url" title={row.url}>
                        <code>{row.url}</code>
                      </td>
                      <td className="introw__state">
                        {/* §5.2: a word, not a coloured dot. A dot reads as a status
                            light, and this page has no status to report. */}
                        <span className={row.active ? 'intstate intstate--on' : 'intstate'}>
                          {activeWord(row.active)}
                        </span>
                        {!row.urlWellFormed && (
                          // A stored row whose URL no longer parses — the allowlist
                          // tightened, or a row predates it. Saying so is the only
                          // honest thing the register can add about the string.
                          <span className="introw__warn" title="The stored URL is not a well-formed http/https URL.">
                            {' '}
                            ⚠
                          </span>
                        )}
                      </td>
                      <td className="introw__by">
                        {row.setBy ? (
                          <>
                            {row.setBy}
                            {/* ★ SLICED, NOT PARSED. `new Date(...)` on an ISO string
                                reads it as UTC and renders it in the browser's zone,
                                moving every timestamp before 05:00 to the day before.
                                The first ten characters of ISO 8601 are the day and
                                nothing has to be interpreted to get them. */}
                            <span className="introw__date"> · {row.updatedAt.slice(0, 10)}</span>
                          </>
                        ) : (
                          <span className="introw__none">—</span>
                        )}
                      </td>
                      <td className="introw__act">
                        <button
                          type="button"
                          className="btn introw__open"
                          aria-haspopup="dialog"
                          aria-expanded={isOpen}
                          aria-controls="integration-panel"
                          onClick={(e) => {
                            e.stopPropagation();
                            openPanel({ mode: 'edit', row });
                          }}
                        >
                          {may ? 'Edit ›' : 'View ›'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={6} className="introw__empty">
                      {rows.length === 0
                        ? 'No integrations yet. Add the first one.'
                        : `No integration matches “${filter}”.`}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <IntegrationPanel
        subject={subject}
        may={may}
        onClose={closePanel}
        onEdit={() => setNotice(null)}
        onCreated={onCreated}
        onSaved={onSaved}
        onRemoved={onRemoved}
        onNotice={setNotice}
      />
    </div>
  );
}

/**
 * One integration, edited in a panel that slides in from the right.
 *
 * ★ SAVE IS DISABLED WHEN NOTHING CHANGED, and the reason is the audit trail rather
 *   than politeness. `updated_at` and `set_by` are the only record of who last
 *   touched a row, and a save that rewrites an identical value moves both — so the
 *   register would say the endpoint was reviewed on a day nobody reviewed it. The
 *   footer names what it would send.
 *
 * ★ THE FIELD LIMITS ARE ENFORCED HERE BEFORE THE SERVER SEES THEM, AND STATED. Every
 *   string column is bounded (`VARCHAR(200)`, `VARCHAR(1000)`), and a value over the
 *   bound is an error on SQL Server and a silent truncation on MySQL — so the widths
 *   are the server's rule, printed as a counter beside the field, rather than a
 *   refusal the reader meets after pressing Save.
 */
function IntegrationPanel({
  subject,
  may,
  onClose,
  onEdit,
  onCreated,
  onSaved,
  onRemoved,
  onNotice,
}: {
  subject: Subject | null;
  may: boolean;
  onClose: () => void;
  onEdit: () => void;
  onCreated: (row: Integration) => void;
  onSaved: (row: Integration) => void;
  onRemoved: () => void;
  onNotice: (text: string | null) => void;
}) {
  const open = subject !== null;

  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const [width, setWidth] = useState<number | null>(() => readStoredWidth(PANEL_WIDTH_KEY));
  const [resizing, setResizing] = useState(false);
  const [rendered, setRendered] = useState(0);

  const [draft, setDraft] = useState<Draft>(BLANK);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const seed = subject?.mode === 'edit' ? draftOf(subject.row) : SEED_NEW;

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

  // Re-seed whenever the panel's subject changes. A save answers with the stored row
  // and the route hands that row back as the new subject, so this is what makes
  // "nothing has changed" true again the instant a save lands — without it Save would
  // stay lit and a second press would rewrite `updated_at` for no reason.
  useEffect(() => {
    if (!subject) return;
    setDraft(subject.mode === 'edit' ? draftOf(subject.row) : BLANK);
    setProblem(null);
  }, [subject]);

  // ★ FOCUS HAS TO WAIT FOR THE CONTENT. On the first open the close button is not
  //   rendered yet, so focusing in the same commit silently does nothing.
  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open, subject]);

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

  /**
   * Every field change goes through here.
   *
   * ★ IT CLEARS THE ROUTE'S SUCCESS NOTICE, WHICH IS WHAT "clears on the next edit"
   *   MEANS. The notice survives the re-seed that follows a save (that is why it is
   *   held above), so the only thing left that can retire it is the reader typing —
   *   and a "Saved" sentence still on screen beside an edited form is the page
   *   describing a row that is no longer the one in the fields.
   */
  function setField<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    onEdit();
  }

  const title = draft.title.trim();
  const description = draft.description.trim();
  const url = draft.url.trim();

  const over =
    title.length > TITLE_MAX || description.length > DESC_MAX
      ? title.length > TITLE_MAX
        ? `The title is ${title.length} characters; the most a title holds is ${TITLE_MAX}.`
        : `The description is ${description.length} characters; the most a description holds is ${DESC_MAX}.`
      : null;

  const missing =
    title === ''
      ? 'A title is required — it is what identifies the row, so two integrations cannot share one.'
      : description === ''
        ? 'A description is required — it is what a reader gets instead of calling the endpoint.'
        : url === ''
          ? 'A URL is required.'
          : null;

  const changed = differs(seed, draft);
  const canSave = may && !busy && missing === null && over === null && changed;

  async function onSave(event: React.FormEvent) {
    event.preventDefault();
    if (!canSave || !subject) return;
    setBusy(true);
    setProblem(null);
    onNotice(null);
    const payload: IntegrationDraft = { title, description, url, active: draft.active };
    try {
      if (subject.mode === 'new') {
        const next = await createIntegration(payload);
        onCreated(next);
        onNotice(`Added “${next.title}”.`);
      } else {
        const next = await updateIntegration(subject.row.id, payload);
        onSaved(next);
        onNotice(`Saved — the register now reads “${next.title}”.`);
      }
    } catch (err: unknown) {
      // ★ THE SERVER'S OWN SENTENCE, PRINTED VERBATIM. A duplicate title answers 409
      //   with the name of the row it collided with and the fix; replacing that with
      //   "could not save" would throw away the only part of the answer that helps.
      setProblem(err instanceof Error ? err.message : 'The integration was not saved.');
    } finally {
      setBusy(false);
    }
  }

  async function onRemove() {
    if (busy || !subject || subject.mode !== 'edit') return;
    setBusy(true);
    setProblem(null);
    onNotice(null);
    const row = subject.row;
    try {
      const result = await deleteIntegration(row.id);
      onRemoved();
      onNotice(
        result.removed
          ? `Removed “${row.title}”.`
          : `“${row.title}” was already gone — nothing was removed.`,
      );
    } catch (err: unknown) {
      setProblem(err instanceof Error ? err.message : 'The integration was not removed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside
      ref={panelRef}
      id="integration-panel"
      className={`drawer intpanel${open ? ' is-open' : ''}${resizing ? ' is-resizing' : ''}`}
      style={width === null ? undefined : ({ '--drawer-w': `${width}px` } as CSSProperties)}
      role="dialog"
      aria-modal="true"
      aria-label={
        subject?.mode === 'edit' ? `${subject.row.title} — integration` : 'New integration'
      }
      aria-hidden={!open}
      tabIndex={-1}
    >
      <ResizeGrip
        value={width ?? rendered}
        onChange={(next) => {
          const clamped = clampWidth(next);
          setWidth(clamped);
          storeWidth(PANEL_WIDTH_KEY, clamped);
        }}
        onReset={() => {
          setWidth(null);
          storeWidth(PANEL_WIDTH_KEY, null);
        }}
        onDraggingChange={setResizing}
        controls="integration-panel"
        label="Resize the integration panel"
      />

      <div className="drawer__head">
        <div className="drawer__eyebrow">
          {subject?.mode === 'new' ? 'New integration' : 'Integration · outbound endpoint'}
        </div>
        <h2 className="drawer__name">
          {subject?.mode === 'edit' ? subject.row.title : 'An endpoint this deployment is wired to'}
        </h2>
        <div className="drawer__meta">
          {subject?.mode === 'edit' ? (
            <>
              {activeWord(subject.row.active)} · set by {subject.row.setBy || '—'}
              {' · added '}
              {subject.row.createdAt.slice(0, 10)}
            </>
          ) : (
            <>
              A title, what it is for, and the URL. Nothing is called when you save — the row is
              recorded, and the page keeps saying so.
            </>
          )}
        </div>
      </div>

      <div className="drawer__body">
        <form className="intform" id="integration-form" onSubmit={onSave} noValidate>
          <div className="field">
            <label className="field__label" htmlFor="int-title">
              Title <span className="field__req">required</span>
            </label>
            <input
              id="int-title"
              className="input"
              value={draft.title}
              maxLength={TITLE_MAX}
              disabled={!may}
              onChange={(e) => setField('title', e.target.value)}
              placeholder="Payroll webhook"
              aria-describedby="int-title-note"
            />
            <p className="field__hint" id="int-title-note">
              How the endpoint is named in this register. <strong>It is unique</strong> — two
              integrations cannot share a title, because the title is what identifies the row to
              everybody reading it.
              <span className="intcount">
                {title.length}/{TITLE_MAX}
              </span>
            </p>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="int-desc">
              Description <span className="field__req">required</span>
            </label>
            <textarea
              id="int-desc"
              className="input intform__desc"
              rows={3}
              value={draft.description}
              maxLength={DESC_MAX}
              disabled={!may}
              onChange={(e) => setField('description', e.target.value)}
              placeholder="What this endpoint receives, and which job posts to it"
              aria-describedby="int-desc-note"
            />
            <p className="field__hint" id="int-desc-note">
              What it is for. A reader has this sentence instead of the endpoint, so it is the part
              that says why the row exists at all.
              <span className="intcount">
                {description.length}/{DESC_MAX}
              </span>
            </p>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="int-url">
              Integration URL <span className="field__req">required</span>
            </label>
            <input
              id="int-url"
              className="input intform__url"
              value={draft.url}
              disabled={!may}
              onChange={(e) => setField('url', e.target.value)}
              placeholder="https://host/path"
              spellCheck={false}
              aria-describedby="int-url-note"
            />
            {/* ★ THE HONESTY HINT, AND IT BELONGS ON THIS FIELD. This is where a reader
                forms the belief that the URL is a live connection, so this is where the
                page has to say it is not. §4.3 rules out a `status` field because the
                app cannot know one; this sentence is what stands in its place. */}
            <p className="field__hint" id="int-url-note">
              <strong>Stored and shown. This app does not call it</strong> — Active records an
              intention, not a working connection. <code>https</code> is preferred;{' '}
              <code>http</code> is allowed for an endpoint on a private network. Other schemes are
              refused, so a stored row can never become a link to somewhere this app did not mean
              to send you.
            </p>
          </div>

          <div className="field intform__active">
            <label className="intactive" htmlFor="int-active">
              <input
                id="int-active"
                type="checkbox"
                checked={draft.active}
                disabled={!may}
                onChange={(e) => setField('active', e.target.checked)}
              />
              <span className="intactive__label">Active</span>
            </label>
            <p className="field__hint">
              Whether this endpoint is meant to be in use. It is a note to the next reader, not a
              switch — nothing in this app reads it, and nothing stops working when it is off.
            </p>
          </div>

          {!may && (
            <div className="notice notice--info" role="status">
              <strong>Read only.</strong> The register is open to any signed-in account, but only a
              super admin may change it. Ask one of them to make this edit.
            </div>
          )}
          {over && (
            <div className="notice notice--warn" role="status">
              {over}
            </div>
          )}
          {missing && may && <div className="notice notice--warn" role="status">{missing}</div>}
          {problem && (
            <div className="notice notice--err" role="alert">
              <strong>That was not saved.</strong>
              <p>{problem}</p>
            </div>
          )}
        </form>
      </div>

      <div className="drawer__foot">
        {may && subject?.mode === 'edit' && (
          <button type="button" className="btn btn--danger" onClick={onRemove} disabled={busy}>
            {busy ? 'Working…' : 'Remove'}
          </button>
        )}
        {/* No spacer element: `.drawer__foot` is `display: flex` with no
            `justify-content`, and `.drawer__spacer` is not a rule any stylesheet
            defines — so the filler span other drawers render is a no-op and the
            buttons already sit left. Remove stays left, the confirming pair right. */}
        <button type="button" className="btn intfoot__end" onClick={onClose} disabled={busy}>
          {may ? 'Cancel' : 'Close'}
        </button>
        {may && (
          <button
            type="button"
            className="btn btn--primary"
            onClick={(e) => void onSave(e as unknown as React.FormEvent)}
            disabled={!canSave}
            title={
              !changed
                ? 'Nothing has changed.'
                : missing ?? over ?? undefined
            }
          >
            {busy ? 'Saving…' : subject?.mode === 'new' ? 'Add integration' : 'Save'}
          </button>
        )}
      </div>
    </aside>
  );
}
