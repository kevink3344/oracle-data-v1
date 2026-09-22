import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { PurposeCode } from '../data/types';
import { comboFlag, comboTitle, objectWords, projectCodeFor, type Combo } from '../data/combos';
import { PURPOSE_META, PURPOSE_ORDER } from '../data/taxonomy';
import { money0, num, pluralise } from '../data/format';
import { Chip, PurposeChip } from './Chip';

/**
 * The cost-centre picker.
 *
 * Free text is never a value here. A project binds to a seven-segment account
 * combination, so the only thing that can be chosen is a row from the extract —
 * typing filters the list, it never becomes the answer. That is why the Create
 * button is gated on a chosen row rather than on a non-empty query.
 *
 * Pattern: ARIA 1.2 combobox with `aria-activedescendant`. Focus stays in the
 * input and the arrow keys move a virtual cursor over the options, so a screen
 * reader announces each row without the focus ever leaving the text field. The
 * listbox is deliberately persistent rather than a popup — it is the set to browse
 * as much as it is the answer set — so `aria-expanded` is always true.
 *
 * ★ A COMBINATION ON A TAKEN LEVEL IS NOT IN THIS LIST AT ALL.
 *   `takenLevels` is the set of account levels another project already holds, and
 *   every combination on one of those levels is removed before anything else
 *   happens — before the search, the chips or the count. That ordering matters:
 *   the facet counts are taken off the searched set, so filtering here first is
 *   what stops a chip from promising a row that was never going to be shown.
 *
 *   The alternative — listing them, greyed, with a "Already claimed" tag — was
 *   what this file used to do, and it was the wrong shape. It answered a question
 *   nobody asked ("which combinations can I see?") and buried the one they did:
 *   the reader is choosing from what is still available, and a level a colleague
 *   already holds is not available. A list that shows twelve unusable rows and
 *   four usable ones is not more informative than a list of four; it is a list of
 *   four plus an argument.
 *
 *   The removal is stated, not silent. `withheld` counts what was taken out and
 *   the footer says so, because a list that is quietly shorter than the extract is
 *   how a reader concludes the data is missing.
 */

/** The options rendered at once. 328 combinations is a list to browse, not to dump. */
const LIMIT = 60;
/** Levels offered as chips. 139 levels would be a wall, so the busiest ones only. */
const LEVEL_CHIPS = 8;

const OPTION_PREFIX = 'cc-opt-';
const LISTBOX_PREFIX = 'cc-listbox-';

/**
 * DOM ids are built per instance.
 *
 * ★ THEY USED TO BE CONSTANTS, WHICH WAS ONLY SAFE BECAUSE THERE WAS ONE PICKER.
 *   `id="cost-centre"`, `id="cc-listbox"` and an option id derived from the
 *   combination key are fine for a single picker on a page. This picker now
 *   opens inside the "Recorded, not yet coded" list, where there can be two, and
 *   the moment there are, the second one's `aria-controls` and every
 *   `aria-activedescendant` on screen point at the first one's elements — a
 *   screen reader then announces the wrong list, or nothing, with no error
 *   anywhere. `useId` makes that unrepresentable rather than unlikely.
 */
const domId = (raw: string): string => raw.replace(/[^a-zA-Z0-9]/g, '');

/** Default for `takenLevels`. A module constant so the memo below is not re-run
 * on every render by a fresh empty `Set`. */
const NOTHING_TAKEN: Set<string> = new Set();

interface Reason {
  tier: string;
  detail: string;
  /** Text the query was found in, shown with the match marked. */
  excerpt: string;
}

const trim = (text: string, width = 92): string =>
  text.length > width ? `${text.slice(0, width - 1).trimEnd()}…` : text;

function excerptAround(text: string, q: string, width = 92): string {
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return trim(text, width);
  const start = Math.max(0, i - Math.floor((width - q.length) / 2));
  const end = Math.min(text.length, start + width);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

/**
 * Why this combination is in the results. Most specific first, and only the first
 * hit is reported — the point is to say what the row matched, not to score it.
 *
 * The tier is a stable identifier rather than prose so it reads as a tag on the row;
 * two tiers would otherwise be indistinguishable. When "0523" is typed from a
 * description, the two say which segment answered.
 */
function matchCombo(combo: Combo, q: string): Reason | null {
  if (combo.key.toLowerCase().includes(q)) {
    return { tier: 'key', detail: 'matched inside the combination key', excerpt: '' };
  }
  if (combo.levelName.toLowerCase().includes(q)) {
    return { tier: 'level_name', detail: 'matched the level name', excerpt: combo.levelName };
  }
  if (combo.levelCode.toLowerCase().includes(q)) {
    return { tier: 'level_code', detail: 'matched the project code', excerpt: combo.levelCode };
  }
  if (combo.objectName.toLowerCase().includes(q) || combo.object.includes(q)) {
    return { tier: 'object', detail: 'matched the object', excerpt: combo.objectName };
  }
  if (combo.purposeLabel.toLowerCase().includes(q) || combo.purpose.includes(q)) {
    return { tier: 'purpose', detail: 'matched the purpose', excerpt: combo.purposeLabel };
  }
  if (combo.level.includes(q)) {
    return { tier: 'level_no', detail: 'matched the level number', excerpt: combo.level };
  }
  const row = combo.rows.find((r) => r.description.toLowerCase().includes(q));
  if (row) {
    return {
      tier: 'line_desc',
      detail: `matched a line on PO ${row.orderNumber}`,
      excerpt: excerptAround(row.description, q),
    };
  }
  return null;
}

/** Marks the query inside the text, so a match is visible rather than asserted. */
function Highlight({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

interface ChipDef {
  key: string;
  label: string;
  count: number;
}

/** Chip counts are taken off the *searched* set, never the unfiltered one, so a chip
 * can never promise rows the query already removed. */
function countBy(
  items: { combo: Combo }[],
  pick: (combo: Combo) => string,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const { combo } of items) {
    const key = pick(combo);
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return map;
}

function FacetRow({
  legend,
  none,
  chips,
  value,
  onPick,
}: {
  legend: string;
  none: string;
  chips: ChipDef[];
  value: string | null;
  onPick: (key: string | null) => void;
}) {
  return (
    <div className="filters__row">
      <span className="filters__legend">{legend}</span>
      <button
        type="button"
        className="fchip"
        aria-pressed={value === null}
        onClick={() => onPick(null)}
      >
        {none}
      </button>
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          className="fchip"
          aria-pressed={value === c.key}
          onClick={() => onPick(value === c.key ? null : c.key)}
        >
          {c.label}
          <span className="n">{num(c.count)}</span>
        </button>
      ))}
    </div>
  );
}

interface PickerProps {
  combos: Combo[];
  chosen: Combo | null;
  onChoose: (combo: Combo | null) => void;
  /** The row the cursor is on — the preview follows it, not the choice. */
  onHighlight: (combo: Combo | null) => void;
  /**
   * Account levels another project already holds. Empty when none are taken.
   *
   * A level, not a combination: one account level funds one project at a time, so
   * *every* combination carrying that level is unavailable, not just the one the
   * holder's code names. Passing combinations instead would leave a reader able to
   * pick a second combination on a level that is already spoken for.
   */
  takenLevels?: Set<string>;
  invalid?: boolean;
  describedBy?: string;
  /**
   * The id of the element that names this field.
   *
   * `aria-labelledby` rather than a `<label for>` because the input's own id is
   * generated per instance and is not knowable to the caller. An accessible name
   * has to come from somewhere, and a placeholder is not one.
   */
  labelledBy?: string;
}

export default function CostCentrePicker({
  combos,
  chosen,
  onChoose,
  onHighlight,
  takenLevels = NOTHING_TAKEN,
  invalid = false,
  describedBy,
  labelledBy,
}: PickerProps) {
  const [query, setQuery] = useState('');
  const [purpose, setPurpose] = useState<PurposeCode | null>(null);
  const [level, setLevel] = useState<string | null>(null);
  const [object, setObject] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeRef = useRef<HTMLLIElement | null>(null);

  /** Per-instance ids — see the note on `domId`. */
  const uid = domId(useId());
  const inputId = `cost-centre-${uid}`;
  const listboxId = LISTBOX_PREFIX + uid;
  const optionId = (key: string) => `${OPTION_PREFIX}${uid}-${key.replace(/[^a-z0-9]/gi, '')}`;

  const q = query.trim().toLowerCase();

  /**
   * The extract minus the levels that are spoken for — the only list the rest of
   * this component sees. Everything below counts, filters and ranks `available`.
   */
  const available = useMemo(
    () => (takenLevels.size === 0 ? combos : combos.filter((c) => !takenLevels.has(c.level))),
    [combos, takenLevels],
  );

  /** How many combinations were removed, and why. Counted, not guessed: the
   * footer has to agree with the difference it is explaining. */
  const withheld = combos.length - available.length;

  // Group the options and their match reasons, then counts, then filters — in that
  // order, so a chip can never promise rows the search already removed.
  const searched = useMemo(
    () =>
      available.flatMap((combo) => {
        const reason = q ? matchCombo(combo, q) : null;
        return q && !reason ? [] : [{ combo, reason }];
      }),
    [available, q],
  );

  const purposeChips = useMemo<ChipDef[]>(() => {
    const counts = countBy(searched, (c) => c.purpose);
    return PURPOSE_ORDER.filter((p) => counts.has(p)).map((p) => ({
      key: p,
      label: PURPOSE_META[p].short,
      count: counts.get(p) ?? 0,
    }));
  }, [searched]);

  const levelChips = useMemo<ChipDef[]>(() => {
    const counts = countBy(searched, (c) => c.level);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, LEVEL_CHIPS)
      .map(([key, count]) => ({ key, label: key, count }));
  }, [searched]);

  const objectChips = useMemo<ChipDef[]>(() => {
    const counts = countBy(searched, (c) => c.object);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([key, count]) => ({ key, label: key, count }));
  }, [searched]);

  const filtered = useMemo(
    () =>
      searched.filter(
        ({ combo }) =>
          (!purpose || combo.purpose === purpose) &&
          (!level || combo.level === level) &&
          (!object || combo.object === object),
      ),
    [searched, purpose, level, object],
  );

  const shown = useMemo(() => filtered.slice(0, LIMIT), [filtered]);

  // A new question means a new first answer; keeping the old cursor would point at
  // whatever happened to land in that index.
  useEffect(() => {
    setActive(0);
  }, [q, purpose, level, object]);

  useEffect(() => {
    onHighlight(shown[active]?.combo ?? null);
  }, [shown, active, onHighlight]);

  // Follow the cursor, but only while the reader is actually in the field — an
  // unconditional scrollIntoView here would move the page on load.
  useEffect(() => {
    if (document.activeElement === inputRef.current) {
      activeRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [active]);

  // The cursor lands on the row that was just picked, so the preview panel and the
  // choice cannot disagree — clicking row 3 and having the panel describe row 1 reads
  // as a bug even when each half is right.
  const pick = (combo: Combo, index: number) => {
    setActive(index);
    onChoose(chosen?.key === combo.key ? null : combo);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const last = shown.length - 1;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((i) => Math.min(i + 1, last));
        return;
      case 'ArrowUp':
        e.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
        return;
      case 'PageDown':
        e.preventDefault();
        setActive((i) => Math.min(i + 10, last));
        return;
      case 'PageUp':
        e.preventDefault();
        setActive((i) => Math.max(i - 10, 0));
        return;
      case 'Home':
        e.preventDefault();
        setActive(0);
        return;
      case 'End':
        e.preventDefault();
        setActive(last);
        return;
      case 'Enter': {
        e.preventDefault();
        const combo = shown[active]?.combo;
        if (combo) pick(combo, active);
        return;
      }
      case 'Escape':
        e.preventDefault();
        if (query) {
          setQuery('');
          return;
        }
        if (chosen) onChoose(null);
        inputRef.current?.blur();
        return;
      default:
        return;
    }
  };

  const activeCombo = shown[active]?.combo;
  const clear = () => {
    setQuery('');
    setPurpose(null);
    setLevel(null);
    setObject(null);
    onChoose(null);
  };
  const isFiltered = Boolean(q || purpose || level || object);

  return (
    <div className="combo">
      <div className="combo__control">
        <svg className="combo__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <circle cx="6.6" cy="6.6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M10.2 10.2 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
        <input
          ref={inputRef}
          id={inputId}
          className="combo__input"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeCombo ? optionId(activeCombo.key) : undefined}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder="Search by school, level, object code or line description…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <span className="combo__tail">
          <span className="combo__status" aria-hidden="true">
            {shown.length === filtered.length
              ? pluralise(filtered.length, 'match', 'matches')
              : `${num(shown.length)} of ${num(filtered.length)}`}
          </span>
          {isFiltered ? (
            <button type="button" className="combo__clear" onClick={clear} title="Clear the search">
              ✕<span className="sr">Clear the search</span>
            </button>
          ) : null}
        </span>
      </div>

      <div className="filters" role="group" aria-label="Filter cost centres">
        <FacetRow
          legend="Budget bucket"
          none="All"
          chips={purposeChips}
          value={purpose}
          onPick={(k) => setPurpose(k as PurposeCode | null)}
        />
        <FacetRow
          legend="Level"
          none="All"
          chips={levelChips}
          value={level}
          onPick={setLevel}
        />
        <FacetRow legend="Object" none="All" chips={objectChips} value={object} onPick={setObject} />
      </div>

      <ul className="listbox" id={listboxId} role="listbox" aria-label="Cost centres">
        {shown.length === 0 ? (
          <li className="listbox__empty">
            No combination matches <strong>{query.trim()}</strong>. A project can only bind to a
            combination that already carries orders, so try a school name, a level number or an
            object code — or clear the search.
          </li>
        ) : null}

        {shown.map(({ combo, reason }, i) => {
          const isChosen = chosen?.key === combo.key;
          const flag = comboFlag(combo);
          return (
            <li
              key={combo.key}
              id={optionId(combo.key)}
              ref={i === active ? activeRef : undefined}
              role="option"
              aria-selected={isChosen}
              className={['opt', i === active ? 'opt--active' : ''].filter(Boolean).join(' ')}
              onMouseMove={() => setActive(i)}
              // Keep the caret in the input: a click that moves focus would collapse
              // the browser's own notion of the active option.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(combo, i)}
            >
              <div className="opt__top">
                <span className="opt__id">
                  <code className="opt__key">
                    <Highlight text={combo.key} q={q} />
                  </code>
                  <PurposeChip purpose={combo.purpose} />
                  <Chip variant="neu">L {combo.level}</Chip>
                </span>
                <span className="opt__enter">
                  <span className="kbd">↵</span> Claim
                </span>
              </div>

              <div className="opt__name">
                <Highlight text={comboTitle(combo)} q={q} />
                <span className="opt__obj"> · {objectWords(combo)}</span>
              </div>

              <div className="opt__meta">
                {num(combo.lines)} lines · {money0(combo.amount)} · {num(combo.orders)} POs ·{' '}
                {pluralise(combo.vendors, 'vendor')} · {combo.first} → {combo.last}
              </div>

              {reason ? (
                <p className="opt__match">
                  <span className="tier">{reason.tier}</span>{' '}
                  {reason.detail}
                  {reason.excerpt ? (
                    <>
                      {' — “'}
                      <Highlight text={reason.excerpt} q={q} />
                      {'”'}
                    </>
                  ) : null}
                </p>
              ) : null}

              {flag ? (
                <p className="opt__flag">
                  <strong>The name is not in the lines.</strong> {pluralise(flag.tokens.length, 'word')}{' '}
                  from “{combo.levelName}” ({flag.tokens.join(', ')}) appear in none of this
                  combination’s {num(flag.scanned)} line descriptions. Sample:{' '}
                  {trim(flag.sample, 70)} — check this combination really belongs to that level.
                </p>
              ) : null}

              {/* There is no "already claimed" branch here any more. A combination
                  on a level another project holds is removed from `available`
                  before this list is built, so the situation the branch used to
                  describe cannot reach this point. Saying "already claimed" on a
                  row that is still listed would offer something that cannot be
                  taken. */}

              {isChosen ? (
                <p className="opt__chosen">
                  Chosen — the project code will be <code>{projectCodeFor(combo)}</code>, derived
                  from the level and the object.
                </p>
              ) : null}
            </li>
          );
        })}

        {filtered.length > shown.length ? (
          <li className="listbox__more">
            {num(filtered.length - shown.length)} more match. Narrow with a filter or type more of
            the name.
          </li>
        ) : null}
      </ul>

      {withheld > 0 ? (
        <p className="combo__withheld">
          {pluralise(withheld, 'combination')} on{' '}
          {pluralise(takenLevels.size, 'level')} another project already holds{' '}
          {withheld === 1 ? 'is' : 'are'} not listed — a level funds one project at a time. Release
          the level on the project that holds it first.
        </p>
      ) : null}
    </div>
  );
}
