import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useStore } from '../state/store';
import ErrorNotice from '../components/ErrorNotice';
import ResizeGrip, { clampWidth, readStoredWidth, storeWidth } from '../components/ResizeGrip';
import { money, money0, num, pctSlim, pluralise, share } from '../data/format';
import { PURPOSE_META, PURPOSE_ORDER, objectLabel, objectTitle } from '../data/taxonomy';
import { printElement } from '../lib/printPanel';
import type { ExtractLine, PurposeCode } from '../data/types';

/**
 * The extract's largest object code — 541, furniture and equipment — carries
 * 2,156 of the 2,782 lines. Rendering them all puts a 2,000-row table in the DOM
 * to serve a reader who scans the first screen, so the table is capped and paged
 * and the CSV export is the route to the remainder.
 */
const CAP = 500;
const PER_PAGE = 50;

/** Ranked bar charts show a top slice; the count beside each says how many exist. */
const TOP = 12;

/**
 * Where the vendor panel's width is remembered. Separate from the project
 * drawer's key because the two panels hold different things and a width that
 * suits one rarely suits the other.
 */
const WIDTH_KEY = 'projects-vendor-w';

const quote = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

interface Group {
  key: string;
  amount: number;
  lines: number;
  orders: number;
}

/** Totals for one value of a column, largest first. */
function groupBy(rows: ExtractLine[], pick: (l: ExtractLine) => string): Group[] {
  const map = new Map<string, Group & { seen: Set<string> }>();
  for (const r of rows) {
    const key = pick(r);
    let entry = map.get(key);
    if (!entry) {
      entry = { key, amount: 0, lines: 0, orders: 0, seen: new Set() };
      map.set(key, entry);
    }
    entry.amount += r.amount;
    entry.lines += 1;
    entry.seen.add(r.orderNumber);
  }
  return [...map.values()]
    .map(({ seen, ...g }) => ({ ...g, orders: seen.size }))
    .sort((a, b) => b.amount - a.amount || a.key.localeCompare(b.key));
}

/**
 * The filter's terms. Every word has to appear somewhere in the line, which is
 * what a reader expects of a table filter and needs no syntax to explain —
 * "hvac columbia" is two independent conditions, not one phrase.
 */
function termsOf(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

/** Escapes a term so it matches literally inside a RegExp. */
const literal = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Marks the search terms inside a cell, so why a row survived the filter is
 * visible rather than asserted. This matters more than it looks: the terms are
 * matched against the vendor, the order number and the project name as well as
 * the description, and a reader looking at an unmarked description would have
 * no way to tell that the row matched on something else.
 */
function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!text || terms.length === 0) return <>{text}</>;
  // split() with exactly one capture group interleaves the matches at the odd
  // indices, which is exact. Testing each part against the /g regex instead
  // would carry lastIndex across calls and mark the wrong parts.
  const parts = text.split(new RegExp(`(${terms.map(literal).join('|')})`, 'gi'));
  return (
    <>
      {parts.map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part))}
    </>
  );
}

/** One ranked bar. `series` is the usage-bar token — `cap`, `ope` or `oth`. */
function Bar({
  name,
  title,
  amount,
  detail,
  series,
  peak,
  onSelect,
  selectLabel,
}: {
  name: string;
  title?: string;
  amount: number;
  detail: string;
  series: string;
  peak: number;
  /** Present only where the row opens something; the row becomes a button. */
  onSelect?: () => void;
  /** The button's accessible name — its text content is a whole row of figures. */
  selectLabel?: string;
}) {
  const body = (
    <>
      <span className="hbar__name" title={title}>
        {name}
      </span>
      <span className="hbar__val">{money0(amount)}</span>
      <span className="hbar__track">
        <span
          className={`hbar__fill hbar__fill--${series}`}
          style={{ width: `${(share(amount, peak) * 100).toFixed(2)}%` }}
        />
      </span>
      <span className="chart-note" style={{ marginTop: 0 }}>
        {detail}
        {onSelect ? (
          // The separator travels with the label rather than sitting beside it in
          // its own text node, so the whole "· View detail ›" drops out together
          // when the row is printed and a row with nothing to open has no
          // trailing punctuation left over.
          <span className="hbar__go">{' · '}View detail ›</span>
        ) : null}
      </span>
    </>
  );

  // A div cannot be focused or activated, so an interactive row is a real
  // button carrying the row's own grid. The flat styling that makes a button
  // read as a row lives in objectdetail.css.
  if (onSelect) {
    return (
      <button
        type="button"
        className="hbar__row hbar__row--btn"
        onClick={onSelect}
        aria-label={selectLabel}
      >
        {body}
      </button>
    );
  }
  return <div className="hbar__row">{body}</div>;
}

/**
 * The same focusable set the project drawer's trap uses. A panel that traps Tab
 * has to count every focusable thing inside it, and an `<a href>` is one.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), summary, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * The vendor side panel. Object code and vendor are two cuts of the same lines,
 * so everything here is derived from the page's own rows rather than fetched,
 * and the panel is route-local state: it names one vendor of one object code
 * and cannot survive a move to a different code.
 *
 * The link back out is the projects section. A vendor's commitment under an
 * object code is spread over the levels it was booked to, and each of those is
 * a project the reader can open — which is the thing a vendor name alone never
 * tells you.
 */
function VendorPanel({
  open,
  vendor,
  object,
  objectHeading,
  rows,
  levels,
  wide,
  total,
  rank,
  vendorCount,
  projectName,
  onClose,
  onExport,
}: {
  open: boolean;
  vendor: string | null;
  object: string;
  objectHeading: string;
  /** This vendor's lines under this object code, newest first. */
  rows: ExtractLine[];
  levels: Group[];
  wide: { amount: number; lines: number; objects: number } | null;
  total: number;
  rank: number;
  vendorCount: number;
  projectName: (level: string) => string;
  onClose: () => void;
  onExport: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // Same three-state width contract as the project drawer: null lets the
  // stylesheet own it, so the responsive default survives until the reader
  // resizes, and the stored value is then always their own choice.
  const [width, setWidth] = useState<number | null>(() => readStoredWidth(WIDTH_KEY));
  const [resizing, setResizing] = useState(false);
  const [rendered, setRendered] = useState(0);

  // The body lock and the focus restore are one effect because the element to
  // return focus to is only knowable while the panel is open.
  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement as HTMLElement | null;
    document.body.classList.add('is-locked');
    return () => {
      document.body.classList.remove('is-locked');
      openerRef.current?.focus?.();
    };
  }, [open]);

  // Focus has to wait for the content to exist: on the very first open `vendor`
  // is still null in this commit and the close button is not rendered yet, so
  // focusing here would silently do nothing and leave focus behind the panel.
  useEffect(() => {
    if (open && vendor) closeRef.current?.focus();
  }, [open, vendor]);

  useEffect(() => {
    if (!open) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const panel = panelRef.current;
      if (!panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const amount = rows.reduce((s, r) => s + r.amount, 0);
  const orders = new Set(rows.map((r) => r.orderNumber)).size;
  const dates = rows.map((r) => r.orderDate).sort();
  const first = dates[0] ?? '';
  const last = dates[dates.length - 1] ?? '';
  // The panel lists the newest few; the CSV behind it holds all of them.
  const listCap = 8;
  const shown = rows.slice(0, listCap);

  // The grip reads and nudges from the width actually on screen, because the
  // stylesheet's value is responsive. Measured while open, and re-measured on
  // viewport change so the keyboard nudge never starts from a stale number.
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

  // The pointer leaves the 10px grip constantly while dragging, so the cursor
  // and the no-select rule have to live on the body for the duration.
  useEffect(() => {
    document.body.classList.toggle('is-resizing', resizing);
    return () => {
      // Only clear it if this panel is the one that set it — the project drawer
      // owns the same flag, and both are mounted at once on this route.
      if (!resizing) return;
      document.body.classList.remove('is-resizing');
    };
  }, [resizing]);

  const setUserWidth = (w: number) => {
    const next = clampWidth(w);
    setWidth(next);
    storeWidth(WIDTH_KEY, next);
  };

  // Reset clears the override rather than pinning today's default, so the panel
  // goes back to following the viewport.
  const resetWidth = () => {
    setWidth(null);
    storeWidth(WIDTH_KEY, null);
  };

  const panelStyle = width === null ? undefined : ({ '--vdpanel-w': `${width}px` } as CSSProperties);

  /**
   * The panel prints itself, from its own node: the figures, the projects it is
   * booked to and its lines are what the CSV flattens away, and the scope line
   * has to name both the vendor and the object code because a printed page has
   * no URL to say which of the sixty-one vendors it is about.
   */
  const exportPdf = () => {
    const panel = panelRef.current;
    if (!panel) return;
    printElement(panel, {
      title: `${vendor ?? 'Vendor'} — object code ${object}`,
      scope: `Vendor panel · object code ${object} · ${pluralise(rows.length, 'line')} under this code`,
      orientation: 'portrait',
    });
  };

  return (
    <aside
      ref={panelRef}
      id="vendor-detail"
      className={`vdpanel${open ? ' is-open' : ''}${resizing ? ' is-resizing' : ''}`}
      style={panelStyle}
      role="dialog"
      aria-modal="true"
      aria-label={vendor ? `${vendor} — vendor details` : 'Vendor details'}
      aria-hidden={!open}
      tabIndex={-1}
    >
      <ResizeGrip
        value={width ?? rendered}
        onChange={setUserWidth}
        onReset={resetWidth}
        onDraggingChange={setResizing}
        controls="vendor-detail"
        label="Resize the vendor details panel"
      />

      <div className="vdpanel__head">
        <div className="vdpanel__eyebrow">Vendor · object code {object}</div>
        <h2 className="vdpanel__name">{vendor}</h2>
        <div className="vdpanel__meta">
          <b>{num(rows.length)}</b> {rows.length === 1 ? 'line' : 'lines'} · <b>{num(orders)}</b>{' '}
          {orders === 1 ? 'order' : 'orders'} · <b>{num(levels.length)}</b>{' '}
          {levels.length === 1 ? 'project' : 'projects'}
          <br />
          {first
            ? first === last
              ? `Order dated ${first}`
              : `Orders ${first} to ${last}`
            : 'No lines'}
        </div>
        <button
          ref={closeRef}
          type="button"
          className="drawer__close"
          onClick={onClose}
          aria-label="Close the vendor details panel"
        >
          <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M1 1l10 10M11 1L1 11"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <div className="vdpanel__body">
        <section className="dsec">
          <div className="dsec__head">
            <h3 className="dsec__title">Under this object code</h3>
            <span className="dsec__hint">
              rank {num(rank)} of {num(vendorCount)} by value
            </span>
          </div>
          <div className="vdfigure">{money0(amount)}</div>
          <p className="vdnote">
            {pctSlim(share(amount, total))} of the {money0(total)} booked to {objectHeading}.
          </p>
          <div className="hbar vdbar">
            <Bar
              name={vendor ?? ''}
              amount={amount}
              detail={`${pluralise(rows.length, 'line')} under this object code`}
              series="oth"
              peak={total}
            />
          </div>
        </section>

        <section className="dsec">
          <div className="dsec__head">
            <h3 className="dsec__title">Projects it is booked to</h3>
            <span className="dsec__hint">{pluralise(levels.length, 'project')}</span>
          </div>
          <ul className="vdproj">
            {levels.map((g) => (
              <li key={g.key}>
                <Link
                  className="vdproj__row"
                  to={`/projects?project=${g.key}`}
                  title={`Open ${projectName(g.key)}`}
                >
                  <span className="vdproj__name">{projectName(g.key)}</span>
                  <span className="vdproj__val">{money0(g.amount)}</span>
                  <span className="vdproj__meta">
                    Level {g.key} · {pluralise(g.lines, 'line')} ·{' '}
                    {pluralise(g.orders, 'order')}
                    <span className="vdproj__go">{' · '}Open project ›</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          <p className="vdnote">
            Each row opens that project&rsquo;s own page, where the whole project is shown — every
            object code it carries, not just {object}.
          </p>
        </section>

        <section className="dsec">
          <div className="dsec__head">
            <h3 className="dsec__title">Its lines under this object code</h3>
            <span className="dsec__hint">
              {rows.length > listCap
                ? `newest ${listCap} of ${num(rows.length)}`
                : num(rows.length)}
            </span>
          </div>
          <ul className="vdlines">
            {shown.map((l) => (
              <li key={`${l.orderNumber}-${l.lineNumber}-${l.level}`}>
                <div className="vdlines__top">
                  <span className="vdlines__order">{l.orderNumber}</span>
                  <span className="vdlines__date">{l.orderDate}</span>
                  <span className="vdlines__amt">{money(l.amount)}</span>
                </div>
                <div className="vdlines__desc" title={l.description || undefined}>
                  {l.description || '—'}
                </div>
                <div className="vdlines__meta">
                  Level {l.level} · {projectName(l.level)}
                </div>
              </li>
            ))}
          </ul>
        </section>

        {wide && wide.objects > 1 ? (
          <section className="dsec">
            <div className="dsec__head">
              <h3 className="dsec__title">Beyond this object code</h3>
            </div>
            <p className="vdnote">
              {vendor} also holds <b>{money0(wide.amount)}</b> on <b>{num(wide.lines)}</b>{' '}
              {wide.lines === 1 ? 'line' : 'lines'} across <b>{num(wide.objects)}</b> object codes
              elsewhere in the extract, so the figure above is this code&rsquo;s share of the
              vendor rather than the vendor&rsquo;s whole footprint.
            </p>
          </section>
        ) : null}
      </div>

      <div className="vdpanel__foot">
        <button type="button" className="btn btn--system btn--sm" onClick={onExport}>
          Download {rows.length === 1 ? 'this line' : `these ${num(rows.length)} lines`} (CSV)
        </button>
        <button
          type="button"
          className="btn btn--system btn--sm"
          onClick={exportPdf}
          title="Prints this panel as it looks — the figures, the projects it is booked to and its lines, none of which the CSV lays out"
        >
          Export to PDF
        </button>
        <button type="button" className="btn btn--sm" onClick={onClose}>
          Close
        </button>
      </div>
    </aside>
  );
}

export default function ObjectDetail() {
  const { object = '' } = useParams();
  const { status, error, reload, lines, projects, summary } = useStore();
  const [page, setPage] = useState(1);
  const [query, setQuery] = useState('');
  // Two pieces of state because the panel has an exit transition: `vendorOpen`
  // is the selection, `vendor` is what is currently on screen. Keeping the last
  // vendor after the selection clears is what gives the slide-out something to
  // animate instead of blinking its content away first.
  const [vendorOpen, setVendorOpen] = useState<string | null>(null);
  const [vendor, setVendor] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // The whole route, for the export that prints what is on screen rather than
  // one panel of it.
  const pageRef = useRef<HTMLDivElement>(null);

  // React Router reuses this component when only the parameter changes, so the
  // page number has to be reset explicitly or the second object opens mid-table.
  // The filter resets it for the same reason — page 7 of an unfiltered table is
  // almost always past the end of a filtered one.
  useEffect(() => setPage(1), [object, query]);

  useEffect(() => {
    if (vendorOpen) setVendor(vendorOpen);
  }, [vendorOpen]);

  // The panel names one vendor of one object code, so it cannot survive a move
  // to a different code — the name may not appear there at all, and leaving it
  // open would show the previous object's figures under the new heading.
  useEffect(() => {
    setVendorOpen(null);
    setVendor(null);
  }, [object]);

  const rows = useMemo(() => lines.filter((l) => l.object === object), [lines, object]);

  const projectName = useCallback(
    (level: string) => projects.find((p) => p.level === level)?.name ?? `Unclaimed level ${level}`,
    [projects],
  );

  const byPurpose = useMemo(() => {
    const all = groupBy(rows, (l) => l.purpose);
    return PURPOSE_ORDER.map((p) => all.find((g) => g.key === p)).filter(
      (g): g is Group => Boolean(g),
    );
  }, [rows]);

  const byLevel = useMemo(() => groupBy(rows, (l) => l.level), [rows]);
  const byVendor = useMemo(() => groupBy(rows, (l) => l.vendor), [rows]);

  // The vendor panel's own cut of the same lines: newest first, then largest,
  // which is the order the PO-line table below uses. Sorted here rather than in
  // the panel so the CSV export hands back the order the reader just scanned.
  const vendorRows = useMemo(() => {
    if (vendor === null) return [];
    return rows
      .filter((l) => l.vendor === vendor)
      .sort((a, b) => b.orderDate.localeCompare(a.orderDate) || b.amount - a.amount);
  }, [rows, vendor]);

  const vendorLevels = useMemo(() => groupBy(vendorRows, (l) => l.level), [vendorRows]);

  const vendorRank = vendor === null ? 0 : byVendor.findIndex((g) => g.key === vendor) + 1;

  /**
   * A firm is usually paid from more than one object code, so the figure under
   * this code is this code's share of the vendor, not the vendor. Computing the
   * extract-wide total lets the panel say so instead of leaving the reader to
   * assume the smaller number is the whole relationship — which is exactly the
   * misreading a vendor name invites. Null when there is nothing to add.
   */
  const vendorWide = useMemo(() => {
    if (vendor === null) return null;
    const mine = lines.filter((l) => l.vendor === vendor);
    if (mine.length === vendorRows.length) return null;
    return {
      amount: mine.reduce((s, l) => s + l.amount, 0),
      lines: mine.length,
      objects: new Set(mine.map((l) => l.object)).size,
    };
  }, [lines, vendor, vendorRows]);

  // An object code can sit under two purposes at once, so the level chart uses
  // whichever purpose carries most of that level's value — the same rule the
  // dashboard's "by object code" chart uses.
  const seriesByLevel = useMemo(() => {
    const inner = new Map<string, Map<string, number>>();
    for (const r of rows) {
      const m = inner.get(r.level) ?? new Map<string, number>();
      m.set(r.purpose, (m.get(r.purpose) ?? 0) + r.amount);
      inner.set(r.level, m);
    }
    const out = new Map<string, string>();
    for (const [level, totals] of inner) {
      let best = '';
      let bestAmount = -1;
      for (const [purpose, amount] of totals) {
        if (amount > bestAmount) {
          best = purpose;
          bestAmount = amount;
        }
      }
      out.set(level, PURPOSE_META[best as PurposeCode]?.series ?? 'oth');
    }
    return out;
  }, [rows]);

  // Newest first, then largest — the order the detail drawer uses.
  const sorted = useMemo(
    () => [...rows].sort((a, b) => b.orderDate.localeCompare(a.orderDate) || b.amount - a.amount),
    [rows],
  );

  const terms = useMemo(() => termsOf(query), [query]);

  /**
   * Each line's lower-cased searchable text, keyed by the line object itself so
   * the filtered list stays a plain ExtractLine[] and nothing downstream — the
   * table, the paging counts, the CSV — needs to know a filter exists. The
   * project name is part of the text because a reader thinks in project names,
   * not LEVEL_ codes: searching "kepler" should find the level that carries
   * that name, and the name is not stored on the line.
   */
  const haystack = useMemo(() => {
    const map = new Map<ExtractLine, string>();
    for (const r of sorted) {
      map.set(
        r,
        [
          r.orderNumber,
          r.orderDate,
          r.lineNumber,
          r.level,
          projectName(r.level),
          r.vendor,
          r.description,
          r.status,
        ]
          .join(' ')
          .toLowerCase(),
      );
    }
    return map;
  }, [sorted, projectName]);

  /**
   * The filter runs over all of the object code's lines, before the cap — not
   * over the first 500. Filtering the capped slice would be quietly wrong:
   * object 541 has 2,156 lines, so a match that happens to sit at line 700 would
   * report "no matches" for text that is really there.
   */
  const filtered = useMemo(() => {
    if (terms.length === 0) return sorted;
    return sorted.filter((r) => {
      const text = haystack.get(r) ?? '';
      return terms.every((t) => text.includes(t));
    });
  }, [sorted, haystack, terms]);

  const capped = filtered.slice(0, CAP);
  const totalPages = Math.max(1, Math.ceil(capped.length / PER_PAGE));
  const current = Math.min(page, totalPages);
  const offset = (current - 1) * PER_PAGE;
  const shown = capped.slice(offset, offset + PER_PAGE);

  const go = (n: number) => {
    setPage(n);
    panelRef.current?.scrollIntoView({ block: 'start' });
  };

  /** RFC-4180 CSV of the given lines, with the project name resolved onto each row. */
  const csvOf = (list: ExtractLine[]): string => {
    const header = [
      'order',
      'date',
      'line',
      'level',
      'project',
      'purpose',
      'object',
      'vendor',
      'description',
      'quantity',
      'amount',
      'status',
    ];
    const body = list.map((r) => [
      r.orderNumber,
      r.orderDate,
      r.lineNumber,
      r.level,
      projectName(r.level),
      PURPOSE_META[r.purpose as PurposeCode]?.label ?? r.purpose,
      r.object,
      r.vendor,
      r.description,
      String(r.quantity),
      r.amount.toFixed(2),
      r.status,
    ]);
    return [header, ...body].map((row) => row.map(quote).join(',')).join('\r\n');
  };

  const download = (csv: string, filename: string) => {
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // The page-head export deliberately stays "all lines": the panel's copy
  // promises it, and a reader who filtered to 43 rows still expects the complete
  // set from that button. The filtered export is a second, separate action that
  // sits with the filter that produces it.
  const exportAll = () => download(csvOf(sorted), `object-${object}-po-lines.csv`);
  const exportMatches = () =>
    download(csvOf(filtered), `object-${object}-po-lines-filtered.csv`);

  /**
   * The page as a document: the charts, the notes and the table's current page.
   *
   * It prints the page and not the object code, and says so — the table is
   * capped and paged, so page 1 of 11 is what is on screen and the CSV beside
   * this button is the route to the rest. That division is the point: the CSV is
   * the data, this is the view.
   *
   * The vendor panel is omitted rather than hidden by CSS, because if it happens
   * to be open it is a descendant of what is being printed without being part of
   * it — page 2 of the PDF would otherwise be a vendor's slide-out stapled to the
   * object code's own page.
   */
  const pdfPage = () => {
    const page = pageRef.current;
    if (!page) return;
    printElement(page, {
      title: heading,
      scope: `${heading} — every panel on this page. ${num(sorted.length)} lines in all;` +
        ` this document holds the table as paged. The CSV holds every line.`,
      orientation: 'landscape',
      omit: '.vdpanel',
    });
  };

  /** The lines panel exactly as filtered and paged on screen. */
  const pdfLines = () => {
    const panel = panelRef.current;
    if (!panel) return;
    const trimmed = query.trim();
    printElement(panel, {
      title: `Object ${object} — purchase-order lines${searching ? ` matching ${trimmed}` : ''}`,
      scope: searching
        ? `${num(filtered.length)} of ${num(sorted.length)} lines match “${trimmed}” ·` +
          ` this document holds page ${current} of ${totalPages}.`
        : `${num(sorted.length)} lines carry this object code ·` +
          ` this document holds page ${current} of ${totalPages}.`,
      orientation: 'landscape',
    });
  };

  if (status === 'loading') {
    return (
      <div className="stack">
        <div className="accent-rule" />
        <div className="page-head">
          <div>
            <h1>Object code {object}</h1>
            <p className="page-head__sub">Reading the Oracle extract…</p>
          </div>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="stack">
        <div className="accent-rule" />
        <div className="page-head">
          <h1>Object code {object}</h1>
        </div>
        <ErrorNotice error={error ?? 'Unknown error'} reload={reload} />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="stack">
        <div className="accent-rule" />
        <div className="page-head">
          <h1>Object code {object}</h1>
        </div>
        <div className="panel">
          <div className="panel__body">
            <div className="empty">
              No purchase-order line in the extract is booked to object code <strong>{object}</strong>
              . The nine codes that do appear are listed on{' '}
              <Link to="/">the dashboard</Link>.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const total = rows.reduce((s, r) => s + r.amount, 0);
  const label = objectLabel(object);
  // objectTitle() already prefixes the code ("527 · Construction, CMAR / GMP"),
  // so a labelled code reads as a name and an unlabelled one falls back to the
  // number alone.
  const heading = label ? objectTitle(object) : `Object code ${object}`;
  const levelPeak = byLevel[0]?.amount ?? 1;
  const vendorPeak = byVendor[0]?.amount ?? 1;
  const truncated = filtered.length > capped.length;
  const searching = terms.length > 0;

  // The panel's own account of what the table is showing. A filter narrows the
  // set and the cap truncates it — two independent things — so the cases are
  // spelled out rather than composed from fragments.
  const linesNote = (() => {
    if (filtered.length === 0) {
      return `None of the ${num(sorted.length)} lines booked to this object code match the filter.`;
    }
    if (!truncated) {
      return searching
        ? `${num(filtered.length)} of ${num(sorted.length)} lines match, newest order first.`
        : `${num(sorted.length)} lines carry this object code, newest order first.`;
    }
    return searching
      ? `${num(filtered.length)} of ${num(sorted.length)} lines match — the table shows the first ${num(CAP)} in pages of ${PER_PAGE}. The download beside the filter has all ${num(filtered.length)}.`
      : `${num(sorted.length)} lines carry this object code — the table shows the first ${num(CAP)} in pages of ${PER_PAGE}. The CSV export above has all of them.`;
  })();

  return (
    <div className="stack" ref={pageRef}>
      <div>
        <div className="accent-rule" />
        <div className="page-head">
          <div>
            <nav className="crumbs" aria-label="Breadcrumb">
              <Link to="/">Dashboard</Link>
              <span aria-hidden="true">›</span>
              <span aria-current="page">Object code {object}</span>
            </nav>
            <h1>{heading}</h1>
          </div>
          <div className="page-head__actions">
            <button type="button" className="btn btn--system" onClick={exportAll}>
              Download all {num(sorted.length)} lines (CSV)
            </button>
            <button
              type="button"
              className="btn btn--system"
              onClick={pdfPage}
              title="Prints the page as it looks — the charts, the notes and the table's current page. The CSV beside it is the route to every line."
            >
              Export to PDF
            </button>
          </div>
        </div>
      </div>

      {/*
        ★ THE FOUR KPI CARDS ARE GONE, ON STAFF'S INSTRUCTION. They read: committed, purchase-order
        lines, vendors and project levels — all totals over the two tables below, which carry the
        per-level and per-vendor rows they summed.
      */}

      <div className="grid-2">
        <section className="panel">
          <div className="panel__head">
            <div>
              <h2 className="panel__title">Budget groups</h2>
              <p className="panel__sub">
                The <code>PURPOSE_</code> segments this object code is committed under.
              </p>
            </div>
            <span className="panel__count">{pluralise(byPurpose.length, 'group')}</span>
          </div>
          <div className="panel__body">
            <div className="hbar">
              {byPurpose.map((g) => (
                <Bar
                  key={g.key}
                  name={PURPOSE_META[g.key as PurposeCode]?.label ?? g.key}
                  amount={g.amount}
                  detail={`${pluralise(g.lines, 'line')} · ${pctSlim(share(g.amount, total))} of this object code`}
                  series={PURPOSE_META[g.key as PurposeCode]?.series ?? 'oth'}
                  peak={total}
                />
              ))}
            </div>
            <p className="chart-note">
              {byPurpose.length > 1
                ? 'This object code is not owned by one budget group — it appears under more than one purpose, which is why the bucket is PURPOSE_ and the line is OBJECT_, not the other way round.'
                : 'This object code appears under a single budget group in the extract.'}
            </p>
          </div>
        </section>

        <section className="panel">
          <div className="panel__head">
            <div>
              <h2 className="panel__title">Largest vendors</h2>
              <p className="panel__sub">By committed value against this object code.</p>
            </div>
            <span className="panel__count">
              {byVendor.length > TOP ? `top ${TOP} of ${num(byVendor.length)}` : num(byVendor.length)}
            </span>
          </div>
          <div className="panel__body">
            <div className="hbar hbar--btns">
              {byVendor.slice(0, TOP).map((g) => (
                <Bar
                  key={g.key}
                  name={g.key}
                  title={g.key}
                  amount={g.amount}
                  detail={`${pluralise(g.lines, 'line')} · ${pctSlim(share(g.amount, total))} of this object code`}
                  series="oth"
                  peak={vendorPeak}
                  onSelect={() => setVendorOpen(g.key)}
                  selectLabel={`${g.key} — details, and the projects it is booked to under object code ${object}`}
                />
              ))}
            </div>
            <p className="chart-note">
              {byVendor.length > TOP
                ? `Top ${TOP} of ${num(byVendor.length)} vendors — select one for its projects. `
                : 'Select a vendor for its projects and its lines. '}
              Vendor names come from Oracle verbatim and are not de-duplicated — the same firm can
              appear under more than one spelling.
            </p>
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel__head">
          <div>
            <h2 className="panel__title">Where it is committed, by project level</h2>
            <p className="panel__sub">
              The <code>LEVEL_</code> segment — the app&rsquo;s project dimension.
            </p>
          </div>
          <span className="panel__count">
            {byLevel.length > TOP ? `top ${TOP} of ${num(byLevel.length)}` : num(byLevel.length)}
          </span>
        </div>
        <div className="panel__body">
          <div className="hbar">
            {byLevel.slice(0, TOP).map((g) => (
              <Bar
                key={g.key}
                name={projectName(g.key)}
                title={`Level ${g.key}`}
                amount={g.amount}
                detail={`Level ${g.key} · ${pluralise(g.lines, 'line')} · ${pctSlim(share(g.amount, total))} of this object code`}
                series={seriesByLevel.get(g.key) ?? 'oth'}
                peak={levelPeak}
              />
            ))}
          </div>
          <p className="chart-note">
            {byLevel.length > TOP
              ? `Top ${TOP} of ${num(byLevel.length)} levels by committed value. `
              : ''}
            An object code is not confined to one project — {num(byLevel.length)} of the extract&rsquo;s{' '}
            {num(summary?.projects ?? 0)} levels carry this one, so its total is never a single
            project&rsquo;s budget.
          </p>
        </div>
      </section>

      <section className="panel objdetail__lines" ref={panelRef}>
        <div className="panel__head">
          <div>
            <h2 className="panel__title">Purchase-order lines</h2>
            <p className="panel__sub">{linesNote}</p>
          </div>
          <span className="panel__count">
            {capped.length === 0
              ? '—'
              : `${num(offset + 1)}–${num(offset + shown.length)} of ${num(capped.length)}`}
          </span>
        </div>

        <div className="filterbar objfilter" role="group" aria-label="Filter purchase-order lines">
          <div className="objfilter__box">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.6" />
              <path
                d="M10.5 10.5L14 14"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
            <label className="sr" htmlFor="po-filter">
              Filter purchase-order lines
            </label>
            <input
              id="po-filter"
              type="search"
              autoComplete="off"
              placeholder="Filter by description, vendor, order or project — e.g. HVAC"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) {
                  e.preventDefault();
                  setQuery('');
                }
              }}
            />
          </div>

          {searching ? (
            <>
              <button
                type="button"
                className="fchip"
                onClick={() => setQuery('')}
                title="Clear the filter"
              >
                Clear “{query.trim()}”
              </button>
              {filtered.length > 0 ? (
                <button
                  type="button"
                  className="btn btn--system btn--sm"
                  onClick={exportMatches}
                  title="Exports the lines this filter keeps, in the same order as the table"
                >
                  Download {num(filtered.length)} matching (CSV)
                </button>
              ) : null}
              {shown.length > 0 ? (
                <button
                  type="button"
                  className="btn btn--system btn--sm"
                  onClick={pdfLines}
                  title="Prints the lines panel as it is filtered and paged on screen. The CSV holds every matching row; this holds the page."
                >
                  Export to PDF
                </button>
              ) : null}
            </>
          ) : null}
        </div>

        {/* Changing a filter changes the row count silently; the same sentence in
            a live region is how a screen reader learns the filter did anything. */}
        <p className="sr" role="status">
          {searching
            ? `${num(filtered.length)} of ${num(sorted.length)} lines match ${query.trim()}.`
            : ''}
        </p>

        {shown.length === 0 ? (
          <div className="objtable__none">
            <p>
              No line of the {num(sorted.length)} booked to object code <strong>{object}</strong>{' '}
              contains <strong>{query.trim()}</strong>.
            </p>
            <p className="objtable__nonehint">
              Every word has to appear in the line, and the line&rsquo;s vendor, order number and
              project name are searched as well as its description — so a two-word filter is an
              &ldquo;and&rdquo;, not a phrase. Fewer words will match more.
            </p>
            <button type="button" className="btn btn--system btn--sm" onClick={() => setQuery('')}>
              Clear the filter
            </button>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data objtable">
              <caption className="sr">Purchase-order lines booked to this object code.</caption>
              <colgroup>
                <col className="c-order" />
                <col className="c-date" />
                <col className="c-line" />
                <col className="c-level" />
                <col className="c-vendor" />
                <col className="c-desc" />
                <col className="c-amount" />
              </colgroup>
              <thead>
                <tr>
                  <th scope="col">Order</th>
                  <th scope="col">Date</th>
                  <th scope="col">Line</th>
                  <th scope="col">Level / project</th>
                  <th scope="col">Vendor</th>
                  <th scope="col">Description</th>
                  <th scope="col" className="n">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={`${r.orderNumber}-${r.lineNumber}-${r.object}-${r.level}`}>
                    <td className="po-num">{r.orderNumber}</td>
                    <td className="po-num">{r.orderDate}</td>
                    <td className="po-num">{r.lineNumber}</td>
                    <td>
                      <div className="objtable__level">{r.level}</div>
                      <div className="objtable__proj">
                        <Highlight text={projectName(r.level)} terms={terms} />
                      </div>
                    </td>
                    <td>
                      <Highlight text={r.vendor} terms={terms} />
                    </td>
                    <td>{r.description ? <Highlight text={r.description} terms={terms} /> : '—'}</td>
                    <td className="n">{money(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {shown.length > 0 ? (
          <div className="pager">
            <button
              type="button"
              className="btn btn--system btn--sm"
              disabled={current === 1}
              onClick={() => go(current - 1)}
            >
              Previous
            </button>

            <span className="pager__pages">
              {Array.from({ length: totalPages }, (_, i) => i + 1).map((n) => (
                <button
                  key={n}
                  type="button"
                  className="pager__n"
                  aria-current={n === current ? 'page' : undefined}
                  aria-label={`Page ${n} of ${totalPages}`}
                  onClick={() => go(n)}
                >
                  {n}
                </button>
              ))}
            </span>

            <button
              type="button"
              className="btn btn--system btn--sm"
              disabled={current === totalPages}
              onClick={() => go(current + 1)}
            >
              Next
            </button>
          </div>
        ) : null}

        <p className="chart-note" style={{ padding: '0 16px 12px' }}>
          {shown.length === 0
            ? `Nothing to page through — the filter kept none of the ${num(sorted.length)} lines.`
            : truncated
              ? `Showing ${num(capped.length)} of ${num(filtered.length)} ${searching ? 'matching ' : ''}lines. The remaining ${num(filtered.length - capped.length)} are in the CSV export — the table is capped so a 2,000-row page does not have to be rendered to read the first screen.`
              : `All ${num(filtered.length)} ${searching ? 'matching ' : ''}lines are shown.`}
        </p>
      </section>

      <VendorPanel
        open={vendorOpen !== null}
        vendor={vendor}
        object={object}
        objectHeading={heading}
        rows={vendorRows}
        levels={vendorLevels}
        wide={vendorWide}
        total={total}
        rank={vendorRank}
        vendorCount={byVendor.length}
        projectName={projectName}
        onClose={() => setVendorOpen(null)}
        onExport={() =>
          download(
            csvOf(vendorRows),
            `object-${object}-vendor-${(vendor ?? 'unknown')
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '-')
              .replace(/^-|-$/g, '')}-lines.csv`,
          )
        }
      />
    </div>
  );
}
