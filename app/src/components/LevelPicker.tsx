import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Project } from '../data/types';
import { money0, num, pluralise } from '../data/format';

/**
 * The level picker.
 *
 * ★ THE COST-CENTRE PICKER, NARROWED TO LEVELS — AND THE NARROWING IS THE POINT.
 *
 *   `CostCentrePicker` offers the extract's 328 seven-segment account
 *   combinations. That list answers "which combination can be claimed?", and it is
 *   the wrong question here, because what a project *is* is the 4-digit `SEGMENT5`
 *   level rather than the combination it stores. Level `0450` is Athens Drive
 *   HS-Reno whether its money lands on object `527`, `526`, `529` or `532` — five
 *   combinations, one project. So the thing being chosen is a level, and the
 *   accounts it owns arrive with it rather than being chosen: `0450` is four of
 *   them — 526, 527, 529, 532 — and the display code names the level alone,
 *   `CC-0450`, singling out nothing inside it.
 *
 * ★ FREE TEXT IS THE VALUE HERE, WHICH IS THE OPPOSITE OF THE COMBINATION PICKER.
 *   There, typing only filtered and the answer had to be a row, because a
 *   combination is a seven-part string nobody can type. A level is four digits read
 *   off a report, so this field *is* the answer: `0454` becomes a valid value the
 *   moment it is typed, and the list below is what makes that easy rather than what
 *   makes it legal. The digits are enforced in the field — `[0-9]`, four of them —
 *   because the API validates `^[0-9]{4}$`, and a field that accepts what the server
 *   refuses is a form that fails on save for a reason it could have shown on the
 *   first keystroke.
 *
 * ★ SO A LEVEL THE EXTRACT HAS NO MONEY ON IS STILL SAVEABLE. That is deliberate.
 *   The registry checks a level against `GL_CODE_COMBINATIONS`, not against the
 *   purchase-order extract, and those are different populations: a level can carry
 *   account combinations in the ledger and no commitment yet. Saving one is honest —
 *   the row is coded, the display code is null, and nothing is brought in. What is
 *   not allowed is pretending it brought something in, so the empty state says which
 *   of the two silences the reader is looking at.
 *
 * ★ A LEVEL ANOTHER PROJECT HOLDS IS NOT IN THIS LIST AT ALL. Same rule as the
 *   combination picker, for the same reason: one level funds one project at a time,
 *   and a list of rows that cannot be used is a list plus an argument. The removal
 *   is counted and stated, because a list quietly shorter than the extract is how a
 *   reader concludes the data is missing. The caller passes the set with the project
 *   being edited already taken out of it — a project always still holds the level it
 *   holds, and excluding it would hide the value the field is already showing.
 *
 * Pattern: ARIA 1.2 combobox over a persistent, scrollable listbox. Focus stays in
 * the input and the arrow keys move a virtual cursor over the options, so a screen
 * reader announces each level without the focus ever leaving the field. The listbox
 * is deliberately persistent rather than a popup — with an empty field it is the
 * biggest levels to browse, and with a school name typed it is the answer set.
 */

/** Rows rendered at once. 139 levels is a list to browse, not to dump. */
const LIMIT = 40;

/** Default for `takenLevels`. A module constant so the filter memo below is not
 * re-run on every render by a fresh empty `Set`. */
const NOTHING_TAKEN: Set<string> = new Set();

interface LevelPickerProps {
  /**
   * One entry per level the extract carries, largest commitment first. The whole
   * `Project` rather than a stripped option, because the row has to show the money
   * the level carries — that is the thing a reader is checking when they pick one.
   */
  levels: Project[];
  /** The 4-digit level, or `''` for "this project holds no level". */
  value: string;
  onChange: (level: string) => void;
  /** Levels another project already holds, minus the project being edited. */
  takenLevels?: Set<string>;
  invalid?: boolean;
  describedBy?: string;
  /** The id of the element that names this field — a placeholder is not a name. */
  labelledBy?: string;
}

/** Marks the typed digits inside the text, so a match is visible rather than asserted. */
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

export default function LevelPicker({
  levels,
  value,
  onChange,
  takenLevels = NOTHING_TAKEN,
  invalid = false,
  describedBy,
  labelledBy,
}: LevelPickerProps) {
  const [active, setActive] = useState(0);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeRef = useRef<HTMLLIElement | null>(null);

  /**
   * Per-instance DOM ids.
   *
   * The combination picker learned this the hard way: constant ids are only safe
   * while there is exactly one picker on a page, and the moment there are two the
   * second one's `aria-controls` points at the first one's list — a screen reader
   * announces the wrong list, or nothing, with no error anywhere. `useId` makes
   * that unrepresentable rather than unlikely.
   */
  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const listboxId = `level-listbox-${uid}`;
  const optionId = (level: string) => `level-opt-${uid}-${level}`;

  const q = value.trim().toLowerCase();

  /** The extract minus the levels that are spoken for — the only list below sees. */
  const available = useMemo(
    () => (takenLevels.size === 0 ? levels : levels.filter((p) => !takenLevels.has(p.level))),
    [levels, takenLevels],
  );

  /** How many levels were removed, and why. Counted, not guessed: the footer has
   * to agree with the difference it is explaining. */
  const withheld = levels.length - available.length;

  const searched = useMemo(() => {
    if (!q) return available;
    return available.filter(
      (p) =>
        p.level.includes(q) ||
        p.name.toLowerCase().includes(q) ||
        p.code.toLowerCase().includes(q),
    );
  }, [available, q]);

  // ★ FILTER, THEN CAP. The other order — cap the list, then filter it — silently
  //   denies that a match exists outside the window, which is how a search for a
  //   term that is provably in the data reports no matches.
  const shown = useMemo(() => searched.slice(0, LIMIT), [searched]);

  // A new question means a new first answer; keeping the cursor would point it at
  // whatever happened to land in that index.
  useEffect(() => {
    setActive(0);
  }, [q]);

  // Follow the cursor, but only while the reader is actually in the field — an
  // unconditional scrollIntoView here would move the page on load.
  useEffect(() => {
    if (document.activeElement === inputRef.current) {
      activeRef.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [active]);

  const choose = (level: string, index: number) => {
    setActive(index);
    onChange(level);
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
        const hit = shown[active];
        if (hit) choose(hit.level, active);
        return;
      }
      case 'Escape':
        e.preventDefault();
        // Escape does NOT clear the value: the typed digits are the answer and
        // wiping them because the reader wanted out of the list is a data-entry
        // trap. It only releases the field.
        inputRef.current?.blur();
        return;
      default:
        return;
    }
  };

  const activeLevel = shown[active];
  const isFiltered = q !== '';

  return (
    <div className="lvl">
      <div className="combo__control">
        <svg className="combo__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <circle cx="6.6" cy="6.6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M10.2 10.2 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
        <input
          ref={inputRef}
          id={`level-input-${uid}`}
          className="combo__input combo__input--code"
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={activeLevel ? optionId(activeLevel.level) : undefined}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          // `numeric`, not `tel`: this is a code, and the numeric keypad is the one
          // a person at a desk reaches for.
          inputMode="numeric"
          pattern="[0-9]{4}"
          maxLength={4}
          autoComplete="off"
          spellCheck={false}
          placeholder="Type a 4-digit level, or search a school name…"
          value={value}
          // ★ THE FILTER IS THE ENFORCEMENT. Pasted text, a stray hyphen and a
          //   fifth keystroke all land in the same place, so the field cannot hold
          //   a value the API would reject.
          onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))}
          onKeyDown={onKeyDown}
        />
        <span className="combo__tail">
          <span className="combo__status" aria-hidden="true">
            {shown.length === searched.length
              ? pluralise(searched.length, 'level')
              : `${num(shown.length)} of ${num(searched.length)}`}
          </span>
          {isFiltered ? (
            <button
              type="button"
              className="combo__clear"
              onClick={() => onChange('')}
              title="Clear the level"
            >
              ✕<span className="sr">Clear the level</span>
            </button>
          ) : null}
        </span>
      </div>

      <ul className="listbox listbox--levels" id={listboxId} role="listbox" aria-label="Levels">
        {shown.length === 0 ? (
          <li className="listbox__empty">
            {isFiltered ? (
              /* ★ TWO REASONS A TYPED FOUR-DIGIT CODE IS NOT IN THIS LIST, AND THEY
                 HAVE OPPOSITE CONSEQUENCES. A code the extract does not carry is
                 still saveable — the registry checks `GL_CODE_COMBINATIONS` — and it
                 simply gathers nothing. A code another project holds is refused by
                 the server, so promising "a project can still be saved against it"
                 there would be a lie the very next click exposes. `takenLevels` is
                 the only thing that can tell the two apart, because the held levels
                 are filtered out of `available` before this branch is reached. */
              takenLevels.has(value) ? (
                <>
                  <strong>{value}</strong> is already held by another project, so it is not
                  offered here. One level funds one project at a time — release it on the
                  project that holds it and it comes back to this list.
                </>
              ) : (
                <>
                  No level in the extract matches <strong>{value}</strong>. A project can still
                  be saved against it — the <strong>ledger</strong> decides whether a code is a
                  level, not this list — but no purchase-order money will be brought in, and the
                  display code will be left unset.
                </>
              )
            ) : levels.length === 0 ? (
              <>
                The extract carries no levels at all, so there is nothing to offer. The field still
                accepts four digits — the registry checks a level against{' '}
                <code>GL_CODE_COMBINATIONS</code>, not against this extract — but no budget will be
                brought in, because there are no rows to bring.
              </>
            ) : available.length === 0 ? (
              <>
                Every one of the extract&rsquo;s {num(levels.length)} levels is already held by
                another project, so none can be offered here. Releasing one on its own project puts
                it back in this list.
              </>
            ) : null}
          </li>
        ) : null}

        {shown.map((p, i) => {
          const isChosen = value === p.level;
          return (
            <li
              key={p.level}
              id={optionId(p.level)}
              ref={i === active ? activeRef : undefined}
              role="option"
              aria-selected={isChosen}
              className={[
                'opt',
                i === active ? 'opt--active' : '',
                isChosen ? 'opt--chosen' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onMouseMove={() => setActive(i)}
              // Keep the caret in the input: a click that moves focus would collapse
              // the browser's own notion of the active option.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => choose(p.level, i)}
            >
              <div className="opt__top">
                <span className="opt__id">
                  <code className="opt__lvl">
                    <Highlight text={p.level} q={q} />
                  </code>
                  <span className="opt__levelname">
                    <Highlight text={p.name} q={q} />
                  </span>
                </span>
                <span className="opt__enter">
                  <span className="kbd">↵</span> Use
                </span>
              </div>

              <div className="opt__meta">
                <code>{p.code}</code> · {pluralise(p.buckets.length, 'budget group')} ·{' '}
                {num(p.lines)} lines · {money0(p.committed)} · {p.first} → {p.last}
              </div>
            </li>
          );
        })}

        {searched.length > shown.length ? (
          <li className="listbox__more">
            {num(searched.length - shown.length)} more match — type another digit or a school name
            to narrow the list.
          </li>
        ) : null}
      </ul>

      <p className="lvl__foot">
        {withheld > 0 ? (
          <>
            <strong>{num(withheld)}</strong> of the extract&rsquo;s {num(levels.length)} levels are
            not listed because another project already holds them. One level funds one project at a
            time.{' '}
          </>
        ) : null}
        {isFiltered ? (
          <>
            Type all four digits to set a level the extract does not carry; every level in the
            ledger is accepted whether or not it has orders against it.
          </>
        ) : (
          <>Choose a level to see the budgets Oracle has on it before anything is saved.</>
        )}
      </p>
    </div>
  );
}
