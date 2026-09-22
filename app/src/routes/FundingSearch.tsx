import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useStore } from '../state/store';
import ErrorNotice from '../components/ErrorNotice';
import { Chip, PurposeChip } from '../components/Chip';
import { buildCombos, comboTitle, objectWords, type Combo } from '../data/combos';
import {
  PURPOSE_META,
  PURPOSE_ORDER,
  SEGMENT_ORDER,
  SEGMENT_ROLE,
  objectTitle,
} from '../data/taxonomy';
import { money, money0, num, pluralise } from '../data/format';

/**
 * Combination search.
 *
 * The New-project picker asks one question — *which combination does this project
 * bind* — so it offers three facets and marks every row claimable. This page asks a
 * different one: *where does the money actually sit*. It filters on all seven
 * segments rather than the three that vary, and it opens a combination read-only.
 *
 * Two decisions carry the page:
 *
 *   - **A facet's chips are counted after the *other* facets**, not after nothing.
 *     Pick PURPOSE 6560 and the LEVEL row stops offering levels that only ever used
 *     6570, so no chip on the page can promise a row the current filter has already
 *     removed. The row's own selection is excluded from its own count, or it would
 *     collapse to one chip the moment it was used.
 *   - **Nothing binds.** There is no "Already bound" tag and no Claim button: the
 *     page reads the extract, it never writes to it. Where a project already holds a
 *     combination that is stated as a fact, in prose, next to no action at all.
 */

/**
 * Values a row can hold before it scrolls and offers a find box of its own. LEVEL_ runs
 * to 139 here; anything under this is a shelf you can read without help.
 */
const LONG_ROW = 12;
/** Result cards rendered at once. 328 keys is a list to page through, not to dump. */
const PAGE = 40;

const FOCUSABLE =
  'a[href], button:not([disabled]), summary, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Segment name → value, for the six segments a reader can be filtering on. */
type Picks = Partial<Record<string, string>>;

interface FacetValue {
  value: string;
  count: number;
  /** The value in words — a level's name, an object's description. */
  label: string;
}

const PURPOSE_LABELS = new Map<string, string>(
  PURPOSE_ORDER.map((purpose) => [purpose, PURPOSE_META[purpose].label]),
);

const termsOf = (query: string): string[] =>
  query.trim().toLowerCase().split(/\s+/).filter(Boolean);

/** Every term has to appear somewhere on the combination, as on every other search. */
const matchesTerms = (combo: Combo, terms: string[]): boolean =>
  terms.every((term) => combo.haystack.includes(term));

/**
 * `skip` leaves one segment out of the test, so that segment's own chips stay
 * switchable — a row that filtered itself would only ever offer the value already
 * chosen.
 */
const matchesPicks = (combo: Combo, picks: Picks, skip?: string): boolean =>
  SEGMENT_ORDER.every(
    (name, i) =>
      name === skip || !picks[name] || combo.key.split('-')[i] === picks[name],
  );

/** Marks the term inside the text, so a match is visible rather than asserted. */
function Highlight({ text, term }: { text: string; term: string }) {
  const i = term ? text.toLowerCase().indexOf(term) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + term.length)}</mark>
      {text.slice(i + term.length)}
    </>
  );
}

/** ±`width` characters of description around the term, so the mark has context. */
function excerptAround(text: string, term: string, width = 96): string {
  const i = text.toLowerCase().indexOf(term);
  if (i < 0) return text.length > width ? `${text.slice(0, width - 1).trimEnd()}…` : text;
  const start = Math.max(0, i - Math.floor((width - term.length) / 2));
  const end = Math.min(text.length, start + width);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

/**
 * Why this combination is in the list.
 *
 * A term usually answers in a purchase-order line description, which the card does not
 * otherwise show — and a match nobody can see is a match the reader has to take on
 * trust. The first line answering any unmet term is quoted with that term marked.
 *
 * Deliberately not the picker's `matchCombo`, which ranks one query string against the
 * fields in priority order; this page has a term set, and has to satisfy all of it.
 */
function lineMatch(
  combo: Combo,
  terms: string[],
): { detail: string; text: string; term: string } | null {
  for (const term of terms) {
    const row = combo.rows.find((r) => r.description.toLowerCase().includes(term));
    if (row) {
      return {
        detail: `matched a line on PO ${row.orderNumber}`,
        text: excerptAround(row.description, term),
        term,
      };
    }
  }
  return null;
}

/**
 * One segment's row: what the segment is for, how many values it still takes, and the
 * whole shelf of value chips. Nothing is folded away — a long row scrolls and gains a
 * find box instead. LEVEL_ is 139 values in this extract, and the seven-chip fold this
 * used to show meant the level a reader was hunting sat behind a "+132 more" they never
 * saw. Sorting still puts the busiest values first, so the scroll starts where it should.
 */
function FacetRow({
  name,
  values,
  picked,
  onPick,
}: {
  name: string;
  values: FacetValue[];
  picked: string | undefined;
  onPick: (value: string | null) => void;
}) {
  const [find, setFind] = useState('');

  const total = values.length;
  const long = total > LONG_ROW;
  const needle = find.trim().toLowerCase();

  const visible = useMemo(
    () =>
      needle
        ? values.filter(
            (v) => v.value.toLowerCase().includes(needle) || v.label.toLowerCase().includes(needle),
          )
        : values,
    [values, needle],
  );

  const label = name.replace('_', '');

  return (
    <div className="segf">
      <div className="segf__label">
        <span className="segf__name">{label}</span>
        <span className="segf__role">{SEGMENT_ROLE[name]}</span>
        <span className="segf__count">
          {total === 1 ? '1 value' : `${num(total)} values`}
          {needle && long ? ` · ${num(visible.length)} shown` : ''}
        </span>
      </div>

      <div className="segf__body">
        {long ? (
          <input
            className="segf__find"
            type="text"
            value={find}
            aria-label={`Find a value in ${label}`}
            placeholder={`Find a value in ${label.toLowerCase()}…`}
            onChange={(e) => setFind(e.target.value)}
          />
        ) : null}

        <div className={`segf__row${long ? ' segf__row--scroll' : ''}`}>
          <button
            type="button"
            className="fchip"
            aria-pressed={picked === undefined}
            onClick={() => onPick(null)}
          >
            All
          </button>

          {visible.length === 0 ? (
            <span className="segf__none">No value in {label} contains “{find.trim()}”.</span>
          ) : null}

          {visible.map((v) => (
            <button
              key={v.value}
              type="button"
              className="fchip"
              aria-pressed={picked === v.value}
              title={`${v.label} — ${pluralise(v.count, 'combination')}`}
              onClick={() => onPick(picked === v.value ? null : v.value)}
            >
              {v.value}
              <span className="n">{num(v.count)}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function FundingSearch() {
  const { lines, projects, status, error, reload } = useStore();
  const combos = useMemo(() => buildCombos(lines, projects), [lines, projects]);

  const [query, setQuery] = useState('');
  const [picks, setPicks] = useState<Picks>({});
  const [cap, setCap] = useState(PAGE);
  const [opened, setOpened] = useState<Combo | null>(null);

  /**
   * ★ THE COMBINATION A LINK ASKED FOR, AND WHY THIS PAGE HAS TO ANSWER FOR KEYS
   *   IT DOES NOT HOLD.
   *
   * The invoices register links here from each account row with the code it names,
   * and the two sides are built from different extracts — that page reads AP
   * *distributions*, this one holds one *purchase order* per combination. Measured
   * over the served data: 71 combinations carry an invoice distribution, 46 appear
   * among the 328 below, and the missing 25 hold $1,539,881 of that register's
   * $5,650,333. So an empty result here is an ordinary outcome of the link, not a
   * broken one, and it is the reason for the block rendered below.
   *
   * `combos` is the scoped key set, so a match also depends on the TopBar's
   * program filter — one more reason the miss has to be stated rather than shown
   * as a filtered-to-nothing list that blames the filters.
   */
  const [params, setParams] = useSearchParams();
  const wanted = (params.get('combo') ?? '').trim();
  const requested = useMemo(
    () => (wanted ? combos.find((combo) => combo.key === wanted) ?? null : null),
    [combos, wanted],
  );

  const terms = useMemo(() => termsOf(query), [query]);

  const results = useMemo(
    () => combos.filter((combo) => matchesTerms(combo, terms) && matchesPicks(combo, picks)),
    [combos, terms, picks],
  );

  /** How many distinct values each segment still takes *within the results*. */
  const distinct = useMemo(
    () => SEGMENT_ORDER.map((_name, i) => new Set(results.map((c) => c.key.split('-')[i])).size),
    [results],
  );

  /** A level's own name, so the LEVEL chip can say what a code refers to. */
  const levelNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const combo of combos) if (!map.has(combo.level)) map.set(combo.level, combo.levelName);
    return map;
  }, [combos]);

  const facets = useMemo(
    () =>
      SEGMENT_ORDER.map((name, i) => {
        const counts = new Map<string, number>();
        for (const combo of combos) {
          if (!matchesTerms(combo, terms)) continue;
          if (!matchesPicks(combo, picks, name)) continue;
          const value = combo.key.split('-')[i];
          counts.set(value, (counts.get(value) ?? 0) + 1);
        }
        // A selection the other facets have excluded from the results still has to
        // be on the page, or there is no way to switch it off.
        const chosen = picks[name];
        if (chosen && !counts.has(chosen)) counts.set(chosen, 0);

        const values: FacetValue[] = [...counts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([value, count]) => ({
            value,
            count,
            label:
              name === 'LEVEL_'
                ? levelNames.get(value) ?? value
                : name === 'OBJECT_'
                  ? objectTitle(value)
                  : name === 'PURPOSE'
                    ? PURPOSE_LABELS.get(value) ?? value
                    : value,
          }));

        return { name, values };
      }),
    [combos, terms, picks, levelNames],
  );

  // A narrowed question deserves a fresh first page: keeping the old depth would
  // drop the reader into the middle of a list they have not seen the top of.
  useEffect(() => {
    setCap(PAGE);
  }, [terms, picks]);

  const pick = (name: string, value: string | null) =>
    setPicks((current) => {
      const next = { ...current };
      if (value === null) delete next[name];
      else next[name] = value;
      return next;
    });

  const clear = () => {
    setQuery('');
    setPicks({});
  };

  /**
   * A link opens its own combination, once.
   *
   * The guard is set only when a match is found, so a link that arrives before the
   * extract has loaded still opens its panel when the combinations appear — whereas
   * a guard set on the first render would burn the one attempt on an empty `combos`.
   * Closing the panel must not reopen it, and the address is cleared on close, so
   * the value never comes back to re-trigger this either.
   */
  const autoOpened = useRef<string | null>(null);
  useEffect(() => {
    if (!requested || autoOpened.current === wanted) return;
    autoOpened.current = wanted;
    setQuery(wanted);
    setOpened(requested);
  }, [requested, wanted]);

  /**
   * `?combo=` *is* the panel being open, so closing it clears the address.
   *
   * `replace` and not a push: the reader arrived here from the register, and Back
   * has to take them back to it rather than reopen a panel they just dismissed.
   */
  const closePanel = useCallback(() => {
    setOpened(null);
    if (!params.has('combo')) return;
    const next = new URLSearchParams(params);
    next.delete('combo');
    setParams(next, { replace: true });
  }, [params, setParams]);

  const activeCount = Object.keys(picks).length + (query.trim() ? 1 : 0);
  const shown = results.slice(0, cap);
  const combinations = new Set(lines.map((l) => l.combinationKey)).size;
  /** The longest term, which is the one worth marking in a card. */
  const mark = terms.reduce((a, b) => (b.length > a.length ? b : a), '');

  return (
    <div className="stack">
      <div>
        <div className="accent-rule" />
        <nav className="crumbs" aria-label="Breadcrumb">
          <span>Funding</span>
          <span aria-hidden="true">›</span>
          <span aria-current="page">Search</span>
        </nav>
        <div className="page-head">
          <div>
            <h1>Search combinations</h1>
            <p className="page-head__sub">
              Filter the extract on any of the seven segments and open a combination to read what
              is booked to it. Read-only — nothing on this page binds a combination to a project.
            </p>
          </div>
          <div className="page-head__actions">
            <Chip variant="info">
              {num(results.length)} of {num(combos.length)}
            </Chip>
            <Link to="/projects" className="btn btn--system">
              Projects
            </Link>
            <button type="button" className="btn btn--system" onClick={clear} disabled={!activeCount}>
              Clear filters
            </button>
          </div>
        </div>
      </div>

      {status === 'error' && error ? <ErrorNotice error={error} reload={reload} /> : null}

      {/* Only once the extract is in: before that every key is absent, and saying so
          would be a statement about the loading state dressed as a statement about
          the account. */}
      {status !== 'loading' && wanted && !requested ? (
        <UnopenedCombination
          code={wanted}
          combinations={combos.length}
          example={combos[0]?.key ?? ''}
        />
      ) : null}

      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">Segments</h2>
          <span className="panel__sub">
            A chip's count is taken after the other filters, so no chip can offer a combination the
            current filter has already removed.
          </span>
        </div>
        <div className="panel__body">
          <div className="combo__control">
            <svg className="combo__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <circle cx="6.6" cy="6.6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path d="M10.2 10.2 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" />
            </svg>
            <input
              id="combination-search"
              className="combo__input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              aria-describedby="combination-search-hint"
              placeholder="Search by combination, school, level, object or line description…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <span className="combo__tail">
              {/* Deliberately terse — the tail has a fixed 108px reserve, and the panel
                  below states the same count in full. */}
              <span className="combo__status" aria-hidden="true">
                {num(shown.length)} / {num(results.length)}
              </span>
              {query ? (
                <button
                  type="button"
                  className="combo__clear"
                  onClick={() => setQuery('')}
                  title="Clear the search"
                >
                  ✕<span className="sr">Clear the search</span>
                </button>
              ) : null}
            </span>
          </div>
          <p className="chart-note" id="combination-search-hint">
            Every word you type has to appear somewhere on the combination — in its key, its level,
            its object or one of its purchase-order line descriptions. {num(combinations)}{' '}
            combinations carry orders in this extract; the search covers those.
          </p>

          <div className="segf-list">
            {facets.map((facet) => (
              <FacetRow
                key={facet.name}
                name={facet.name}
                values={facet.values}
                picked={picks[facet.name]}
                onPick={(value) => pick(facet.name, value)}
              />
            ))}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">Combinations</h2>
          <span className="panel__count">
            {results.length === combos.length
              ? `all ${num(combos.length)}`
              : `${num(results.length)} of ${num(combos.length)}`}
          </span>
        </div>
        <div className="panel__body">
          {status === 'loading' ? (
            <p className="chart-note">Loading the extract — the combinations come from it.</p>
          ) : results.length === 0 ? (
            <p className="chart-note">
              Nothing matches the current filters. Every segment has to be true of the same
              combination, so a level and an object that never met will return nothing — clear one
              of them and the list comes back.
            </p>
          ) : (
            <>
              <ul className="results">
                {shown.map((combo) => {
                  const isOpen = opened?.key === combo.key;
                  // Only worth quoting a line for a term the card cannot already show.
                  const elsewhere = `${combo.key} ${combo.levelName} ${combo.levelCode} ${combo.level} ${combo.objectName} ${combo.holder}`.toLowerCase();
                  const unmet = terms.filter((term) => !elsewhere.includes(term));
                  const reason = unmet.length ? lineMatch(combo, unmet) : null;
                  return (
                    <li key={combo.key}>
                      <button
                        type="button"
                        className="rcard"
                        aria-current={isOpen ? 'true' : undefined}
                        aria-haspopup="dialog"
                        onClick={() => setOpened(combo)}
                      >
                        <span className="opt__top">
                          <span className="opt__id">
                            <code className="opt__key">
                              <Highlight text={combo.key} term={mark} />
                            </code>
                            <PurposeChip purpose={combo.purpose} />
                            <Chip variant="neu">L {combo.level}</Chip>
                          </span>
                          <span className="rcard__cue">
                            {isOpen ? 'Open' : 'Details'}
                            <span aria-hidden="true">›</span>
                          </span>
                        </span>

                        <span className="opt__name">
                          <Highlight text={comboTitle(combo)} term={mark} />
                          <span className="opt__obj"> · {objectWords(combo)}</span>
                        </span>

                        <span className="opt__meta">
                          {pluralise(combo.lines, 'line')} · {money0(combo.amount)} ·{' '}
                          {pluralise(combo.orders, 'PO')} · {pluralise(combo.vendors, 'vendor')} ·{' '}
                          {combo.first === combo.last
                            ? combo.first
                            : `${combo.first} → ${combo.last}`}
                        </span>

                        {reason ? (
                          <span className="opt__match">
                            <span className="tier">{reason.detail}</span>{' '}
                            <Highlight text={reason.text} term={reason.term} />
                          </span>
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>

              {results.length > shown.length ? (
                <button
                  type="button"
                  className="btn btn--system btn--sm rmore"
                  onClick={() => setCap((n) => n + PAGE)}
                >
                  Show {num(Math.min(PAGE, results.length - shown.length))} more
                </button>
              ) : null}
            </>
          )}
        </div>
      </section>

      <CombinationPanel
        combo={opened}
        distinct={distinct}
        scope={results.length}
        onClose={closePanel}
      />
    </div>
  );
}

/**
 * The combination a link named that this page does not hold.
 *
 * Reachable from the invoices register, whose accounts sit on the ledger's own
 * distributions — so a code can perfectly well carry money with no purchase order
 * behind it. Rendering the ordinary empty result would say *nothing matches the
 * current filters*, which blames the filters for something they did not do, sends
 * the reader off to clear chips that were never the problem, and reads as a broken
 * link rather than as a fact about the extract.
 *
 * Two misses are said differently, because they are different facts. A key that is
 * not seven numeric segments is a mangled link — a typo, not a finding. A well-formed
 * key that is simply absent is a real combination with no purchase order against it,
 * which is worth a sentence and a way onward. The example key in the second branch is
 * read off the extract rather than written into the copy, so it cannot drift.
 */
function UnopenedCombination({
  code,
  combinations,
  example,
}: {
  code: string;
  combinations: number;
  /** A real key from this extract, so the shape is shown rather than asserted. */
  example: string;
}) {
  const parts = code.split('-');
  const wellFormed = parts.length === 7 && parts.every((part) => /^\d+$/.test(part));

  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">
          {wellFormed ? 'Not a combination here' : 'Not a combination key'}
        </h2>
        <span className="panel__sub">
          {wellFormed
            ? `no purchase order in the extract is booked to ${code}`
            : 'this address does not name a combination'}
        </span>
      </div>
      <div className="panel__body">
        {wellFormed ? (
          <>
            <p className="chart-note">
              <code>{code}</code> is seven numeric segments, so it is a well-formed key — but
              nothing in this extract is booked to it. This page is built from the purchase-order
              extract and holds {num(combinations)} combinations, and this is not one of them.
            </p>
            <p className="chart-note">
              That is a statement about the extract rather than about the account. An account can
              carry money with no purchase order behind it at all: a purchase order is only one of
              the ways a charge reaches the ledger, and the codes that appear here are the ones
              something was ordered against. The register that reads accounts off the ledger&rsquo;s
              own distributions is{' '}
              <Link to="/spend/invoices">Invoices</Link> — filter it to this code and it will hold
              every invoice booked to it.
            </p>
          </>
        ) : (
          <p className="chart-note">
            <code>{code}</code> is not a combination key. A key is seven segments of digits joined
            by hyphens
            {example ? (
              <>
                {' '}
                — <code>{example}</code> is one
              </>
            ) : null}
            . Check the link, or use the segment chips below for the parts of it you know.
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * The details panel.
 *
 * Same choreography as the project drawer — fixed to the right, the body locked
 * behind it, Escape to close, focus moved in and handed back to the card that opened
 * it — but the subject is a combination rather than a project, and the panel holds no
 * actions at all beyond the two that leave it.
 */
function CombinationPanel({
  combo,
  distinct,
  scope,
  onClose,
}: {
  combo: Combo | null;
  distinct: number[];
  scope: number;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  // Kept after closing so the exit transition has something to animate.
  const [shown, setShown] = useState<Combo | null>(null);

  const open = combo !== null;
  useEffect(() => {
    if (combo) setShown(combo);
  }, [combo]);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement as HTMLElement | null;
    document.body.classList.add('is-locked');
    return () => {
      document.body.classList.remove('is-locked');
      openerRef.current?.focus?.();
    };
  }, [open]);

  // Focus has to wait for the content: on the very first open `shown` is still null
  // in this commit and there is no close button to focus yet.
  const hasContent = shown !== null;
  useEffect(() => {
    if (!open || !hasContent) return;
    closeRef.current?.focus();
  }, [open, hasContent]);

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
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el.tagName === 'SUMMARY',
      );
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

  if (!shown) return <aside ref={panelRef} className="drawer" aria-hidden="true" />;

  const c = shown;
  const segments = c.key.split('-');
  /*
    ★ WAS `CONSTANT_SEGMENTS` — a literal in `taxonomy.ts` naming the four segments that happened to
      be single-valued in one extract. Both the count below and the "fixed" tag on each row of the
      table were read off it, which made them statements about a dataset this panel cannot see. The
      account scope in the TopBar is now a control, so the segment table would have kept tagging
      FUND and PROGRAM as fixed while the reader was looking at two funds and three programs.
      `constants` comes from the store, measured against the lines actually being shown.
  */
  const { constants, scopeStats } = useStore();
  const fixedNames = SEGMENT_ORDER.filter((s) => constants[s]);
  const movingNames = SEGMENT_ORDER.filter((s) => !constants[s]);
  const fixedCount = fixedNames.length;
  const rows = [...c.rows].sort((a, b) =>
    a.orderDate < b.orderDate ? 1 : a.orderDate > b.orderDate ? -1 : 0,
  );

  return (
    <aside
      ref={panelRef}
      id="combination-detail"
      className={`drawer${open ? ' is-open' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={`${c.key} — combination details`}
      aria-hidden={!open}
      tabIndex={-1}
    >
      <div className="drawer__head">
        <div className="drawer__eyebrow">Account combination</div>
        <h2 className="drawer__name">
          {comboTitle(c)} · {objectWords(c)}
        </h2>
        <p className="drawer__key">
          <code>{c.key}</code>
        </p>
        {/* Lines, orders and vendors are all listed again, labelled, in Activity a
            few lines below — the head states only what Activity does not. */}
        <div className="drawer__meta">
          <b>{money0(c.amount)}</b> committed over {pluralise(c.orders, 'order')}
          <br />
          {c.first === c.last ? (
            <>
              Ordered <b>{c.first}</b>
            </>
          ) : (
            <>
              Ordered <b>{c.first}</b> to <b>{c.last}</b>
            </>
          )}
        </div>
        <div className="drawer__chips">
          <PurposeChip
            purpose={c.purpose}
            title={`${c.purposeLabel} — ${money0(c.amount)} committed`}
          />
          <Chip variant="neu">Object {c.object}</Chip>
          <Chip variant="neu">Level {c.level}</Chip>
        </div>
        <button
          ref={closeRef}
          type="button"
          className="drawer__close"
          onClick={onClose}
          aria-label="Close the combination details panel"
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

      <div className="drawer__body">
        <section className="dsec">
          <div className="dsec__head">
            <h3 className="dsec__title">Segments</h3>
            <span className="dsec__hint">one row per segment of the key</span>
          </div>
          <table className="segs">
            <caption className="sr">
              The seven segments of this account combination, their values here, and how many
              distinct values each still takes across the combinations matching the current
              filters.
            </caption>
            <thead>
              <tr>
                <th scope="col">Segment</th>
                <th scope="col">Value</th>
                <th scope="col" className="n">
                  Distinct
                </th>
              </tr>
            </thead>
            <tbody>
              {SEGMENT_ORDER.map((name, i) => (
                <tr key={name}>
                  <th scope="row">
                    {name.replace('_', '')}
                    <span className="segs__role">{SEGMENT_ROLE[name]}</span>
                  </th>
                  <td>
                    <code>{segments[i]}</code>
                    {constants[name] ? <span className="segs__const">fixed</span> : null}
                  </td>
                  <td className="n">{num(distinct[i])}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="chart-note">
            {fixedCount} of the seven segments hold one value across{' '}
            {scopeStats.excluded === 0
              ? 'the whole extract'
              : `the current scope (${num(scopeStats.shown)} of ${num(scopeStats.all)} lines)`}
            , so the key varies only in{' '}
            {movingNames.map((s, i) => (
              <span key={s}>
                {i > 0 ? (i === movingNames.length - 1 ? ' and ' : ', ') : ''}
                <code>{s}</code>
              </span>
            ))}
            . “Distinct” is measured across the {num(scope)} combinations matching the current filters,
            not across this combination — it is how much room is left to narrow.
          </p>
        </section>

        <section className="dsec">
          <div className="dsec__head">
            <h3 className="dsec__title">Activity</h3>
            <span className="dsec__hint">read off the extract</span>
          </div>
          <dl className="bind__facts">
            <div>
              <dt>Committed</dt>
              <dd>{money0(c.amount)}</dd>
            </div>
            <div>
              <dt>Lines</dt>
              <dd>{num(c.lines)}</dd>
            </div>
            <div>
              <dt>Purchase orders</dt>
              <dd>{num(c.orders)}</dd>
            </div>
            <div>
              <dt>Vendors</dt>
              <dd>{num(c.vendors)}</dd>
            </div>
            <div>
              <dt>First order</dt>
              <dd>{c.first}</dd>
            </div>
            <div>
              <dt>Last order</dt>
              <dd>{c.last}</dd>
            </div>
          </dl>
          {c.vendors > 1 ? (
            <p className="chart-note">
              Largest vendor <strong>{c.topVendor}</strong> at {money0(c.topVendorAmount)}.
            </p>
          ) : null}
        </section>

        <section className="dsec">
          <div className="dsec__head">
            <h3 className="dsec__title">Projects</h3>
            <span className="dsec__hint">
              {c.holders.length === 0
                ? 'none named'
                : c.holders.length === 1
                  ? 'read off these lines'
                  : `${num(c.holders.length)} on this combination`}
            </span>
          </div>
          {c.holders.length === 0 ? (
            <p className="chart-note">
              No purchase-order line on this combination names a job. That is ordinary —{' '}
              {num(scope)} of the extract's combinations are like this — and it means the
              combination is the only thing the extract says about this money.
            </p>
          ) : (
            <ul className="holds">
              {c.holders.map((holder) => (
                <li className="hold" key={holder.canon}>
                  <div className="hold__top">
                    <span className="hold__name">{holder.name}</span>
                    <span className="hold__amt">{money0(holder.amount)}</span>
                  </div>
                  <div className="hold__chips">
                    <code className="hold__code">{holder.code}</code>
                    <Chip variant="neu">
                      {holder.source === 'level'
                        ? 'Named level'
                        : holder.source === 'both'
                          ? 'Name agrees with the level'
                          : 'From the line text'}
                    </Chip>
                    {holder.packages.length > 0 ? (
                      <Chip variant="neu">
                        {holder.packages.length === 1
                          ? `Package ${holder.packages[0]}`
                          : `Packages ${holder.packages.join(', ')}`}
                      </Chip>
                    ) : null}
                  </div>
                  <p className="hold__meta">
                    {pluralise(holder.lines, 'line')} here
                    {holder.total > holder.amount + 1 ? (
                      <>
                        {' · '}
                        <b>{money0(holder.total)}</b> across {pluralise(holder.spread, 'combination')}
                      </>
                    ) : null}
                  </p>
                </li>
              ))}
            </ul>
          )}
          {c.holders.length > 1 ? (
            <p className="chart-note">
              A combination is not a project boundary. These are separate jobs that happen to be
              booked to the same seven segments — the lines are what name them, and Oracle has no
              project field to hold that name.
            </p>
          ) : null}
          {c.levelClaimed ? (
            <p className="chart-note">
              Level <code>{c.level}</code> is held in this app by <b>{c.levelName}</b>, under the
              code <code>{c.levelCode}</code>. That binds the level rather than this one
              combination, so every account the level owns is inside the claim. Stated for
              context only — the search page reads the extract and never writes to it.
            </p>
          ) : null}
        </section>

        <section className="dsec">
          <div className="dsec__head">
            <h3 className="dsec__title">Purchase-order lines</h3>
            <span className="dsec__hint">{pluralise(c.lines, 'line')}</span>
          </div>
          <ul className="lines">
            {rows.map((line) => (
              <li className="line" key={`${line.orderNumber}-${line.lineNumber}`}>
                <div className="line__top">
                  <span className="line__po">
                    PO {line.orderNumber} · line {line.lineNumber}
                  </span>
                  <span className="line__amt">{money(line.amount)}</span>
                </div>
                <p className="line__desc">{line.description}</p>
                <p className="line__meta">
                  {line.orderDate} · {line.vendor} · buyer {line.buyer}
                  {line.itemNumber ? ` · item ${line.itemNumber}` : ''}
                  {/* Oracle repeats the amount in QUANTITY on lump-sum lines — 589 of
                      the 2,782 rows, 21% of them, holding 97% of the money (gates
                      G16/G17). A unit count means nothing there, so showing it reads
                      as a second, duplicate figure. Note ITEM_NUMBER is the
                      discriminator, not quantity === amount: 107 item lines happen to
                      have the two equal as well. */}
                  {line.quantity && line.quantity !== line.amount
                    ? ` · quantity ${num(line.quantity)}`
                    : ''}
                </p>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <div className="drawer__foot">
        <Link to={`/objects/${c.object}`} className="btn btn--primary btn--sm">
          Object {c.object}
        </Link>
        <button type="button" className="btn btn--system btn--sm" onClick={onClose}>
          Close
        </button>
      </div>
    </aside>
  );
}
