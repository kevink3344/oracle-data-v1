import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { num } from '../data/format';

/**
 * A filter-as-you-type combo box for the register filter bars.
 *
 * ★ WHY THIS EXISTS RATHER THAN A `<select>`.
 *
 *   The Invoices page's Account filter was a native `<select>` listing every
 *   combination the register draws. On this extract that is 71 options, and the
 *   list is ordered busiest-first precisely because nobody reads it — the control
 *   only worked for a reader who already knew the code they wanted. A `<select>`
 *   cannot be typed into: pressing a key jumps to the first option starting with
 *   that character, which is a different feature wearing the same gesture.
 *
 *   So the control is a text field with a filtered list under it. The reader
 *   types `862` and sees the three combinations that carry it; a reader who does
 *   not know the code types a word from the project name and gets there the same
 *   way. That is the whole request: "filter as you type".
 *
 * ★ THE LIST IS PERSISTENT, NOT A POPUP — the house pattern (`LevelPicker`,
 *   `CostCentrePicker`). With an empty field it is the busiest options to browse;
 *   with text typed it is the answer set. A popup would need open/close state, an
 *   outside-click handler and a focus-return path, and every one of those is a
 *   way for the control to be invisible while it holds a value.
 *
 * ★ ARIA 1.2 COMBOBOX OVER A `role="listbox"`. Focus stays in the input and the
 *   arrow keys move a virtual cursor, so a screen reader announces each option
 *   without focus ever leaving the field. `aria-activedescendant` is what points
 *   at the cursor, and it is why the option ids must be per-instance: two combos
 *   on one page with constant ids would have the second one's `aria-controls`
 *   naming the first one's list, silently. `useId` makes that unrepresentable.
 *
 * ★ FILTER, THEN CAP — never the other order. Capping first and filtering the
 *   window silently denies that a match exists outside it, which is how a search
 *   for a term provably in the data reports "no matches". The footer reports the
 *   cap when it bites (`20 of 71`) so a short list is never mistaken for the
 *   whole set.
 */

/** Rows rendered at once. A list to browse, not to dump. */
const LIMIT = 40;

export interface ComboOption {
  /** The value the filter matches on. Must be unique. */
  value: string;
  /** The primary line a reader scans — the code, or the name. */
  label: string;
  /** The secondary line, muted, right-aligned in the row. */
  detail?: string;
  /** Extra text the search matches but does not display. */
  keywords?: string;
  /** How many rows carry this option — shown in the footer's total. */
  count?: number;
}

interface FilterComboProps {
  /** Every option, already in the order they should be offered. */
  options: ComboOption[];
  /** The chosen value, or `''` for "no filter". */
  value: string;
  onChange: (value: string) => void;
  /** The control's accessible name. A placeholder is not a name. */
  label: string;
  /** Shown in the input when nothing is typed and nothing is chosen. */
  placeholder: string;
  /** The leading option that clears the filter — "Any account", "Any project". */
  anyLabel: string;
  /**
   * Rendered as the first real option, for a state that is not a value in
   * `options` — the invoices page's "no account recorded" case. Selecting it
   * sets `value` to `anyValue`, which the caller interprets.
   */
  special?: { value: string; label: string } | null;
  /** The id of an element that names this field, when one exists. */
  labelledBy?: string;
}

/** Marks the typed text inside a label, so a match is visible rather than asserted. */
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

export default function FilterCombo({
  options,
  value,
  onChange,
  label,
  placeholder,
  anyLabel,
  special = null,
  labelledBy,
}: FilterComboProps) {
  const [active, setActive] = useState(0);

  /**
   * Whether the list is showing.
   *
   * ★★ A FILTER BAR NEEDS A DISCLOSURE, NOT A PERSISTENT LIST — and the first
   *   version of this component got that wrong. `LevelPicker` and
   *   `CostCentrePicker` keep their listbox permanently open on purpose: they are
   *   the *only* control on a form, the list is the form's main content, and an
   *   empty field is meant to invite browsing. On a filter bar the opposite is
   *   true. Two of these sit side by side above a table, so two always-open lists
   *   covered the rows the reader was filtering — and a list that never closes
   *   also never looks like it did anything when a choice is made.
   *
   *   So: closed until the reader engages the field, and closed again the moment
   *   the question is answered.
   */
  const [open, setOpen] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeRef = useRef<HTMLLIElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const uid = useId().replace(/[^a-zA-Z0-9]/g, '');
  const listboxId = `combo-listbox-${uid}`;
  const optionId = (v: string) => `combo-opt-${uid}-${v}`;

  /**
   * What the reader has typed.
   *
   * ★ SEPARATE FROM `value`, AND THAT IS THE POINT. The field has to be typeable
   *   while a filter is applied — a reader narrowing from one account to another
   *   types over the current one rather than clearing it first. If the input's
   *   text were `value`, every keystroke would have to be a valid option or the
   *   filter would break mid-word. So typing edits `draft`, and only a committed
   *   choice (a click, or Enter on the cursor) calls `onChange`.
   *
   * ★ IT RE-SEEDS WHENEVER `value` CHANGES FROM OUTSIDE — a Clear button, an
   *   arrival from another page. Without this the field would keep showing the
   *   old text after the filter was reset, which reads as a filter still applied.
   */
  const [draft, setDraft] = useState('');
  useEffect(() => {
    setDraft('');
  }, [value]);

  const q = draft.trim().toLowerCase();

  const searched = useMemo(() => {
    if (!q) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        o.value.toLowerCase().includes(q) ||
        (o.keywords ?? '').toLowerCase().includes(q),
    );
  }, [options, q]);

  // Filter, THEN cap. See the header.
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

  /**
   * Close on a click anywhere outside, and on Tab out of the field.
   *
   * ★ `pointerdown` RATHER THAN `click`, AND THE DIFFERENCE IS NOT COSMETIC. A
   *   `click` listener fires *after* the option's own `onClick`, so choosing a row
   *   would close the list on the same gesture that opened it in some orderings —
   *   and worse, a click that began inside the list and ended outside it would
   *   close a list the reader never left. `pointerdown` fires before the option
   *   handler, so the guard below can tell "this press is inside my own wrapper"
   *   from "this press is somewhere else", and only the latter closes.
   *
   * ★ THE WRAPPER, NOT THE INPUT. The listbox is a sibling of the input, so a
   *   containment check against the input alone would close the list the instant
   *   the reader pressed an option — the option's own click would never land.
   */
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const choose = (next: string, index: number) => {
    setActive(index);
    setDraft('');
    // The question is answered, so the list goes. Leaving it open over the rows
    // the choice just filtered is the failure this whole change fixes.
    setOpen(false);
    onChange(next);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const last = shown.length - 1;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        // On a closed field the first press opens the list rather than moving a
        // cursor nobody can see.
        if (!open) setOpen(true);
        else setActive((i) => Math.min(i + 1, last));
        return;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) setOpen(true);
        else setActive((i) => Math.max(i - 1, 0));
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
        if (hit && open) choose(hit.value, active);
        return;
      }
      case 'Escape':
        e.preventDefault();
        // Escape does NOT clear the filter: the reader asked out of the list, not
        // out of the question they were answering. It only releases the field.
        setDraft('');
        setOpen(false);
        inputRef.current?.blur();
        return;
      case 'Tab':
        // Not prevented — Tab must still move focus, and the list goes with it.
        // ★ Nothing has to be recorded here: the field being ENTERED works out
        //   that the focus came from a keyboard by looking at `relatedTarget`.
        //   See the note on the input.
        setOpen(false);
        return;
      default:
        return;
    }
  };

  const activeOption = shown[active];
  const chosen = options.find((o) => o.value === value) ?? null;
  const specialChosen = special !== null && special.value === value;

  // What the field shows when the reader is not typing: the chosen option's own
  // label, so the control states the filter rather than an empty box beside a
  // list. A `special` choice shows its own label for the same reason.
  const resting = specialChosen ? (special?.label ?? '') : (chosen?.label ?? '');

  return (
    <div className="fcombo" ref={wrapRef}>
      <div className="combo__control">
        <svg className="combo__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <circle cx="6.6" cy="6.6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M10.2 10.2 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
        <input
          ref={inputRef}
          id={`combo-input-${uid}`}
          className="combo__input combo__input--filter"
          type="text"
          role="combobox"
          // ★ THE STATE, SPOKEN. It was hard-coded `true` while the list was
          //   permanent; now it is the real state, which is what tells a screen
          //   reader whether the list below is there at all.
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={open && activeOption ? optionId(activeOption.value) : undefined}
          aria-label={labelledBy ? undefined : label}
          aria-labelledby={labelledBy}
          autoComplete="off"
          spellCheck={false}
          placeholder={value === '' ? placeholder : resting}
          value={draft}
          /**
           * ★ FOCUS OPENS — EXCEPT WHEN THE FOCUS ARRIVED FROM A TAB.
           *
           *   Opening on focus is what makes this one gesture instead of two: a
           *   reader clicks the field and the options are there, the same way a
           *   type-ahead works. But Tab also focuses a field, and a reader walking
           *   the filter bar with the keyboard would then have every combo spring
           *   open behind them — measured: Tab out of the project field landed on
           *   the account field, which opened its own list, so the bar became two
           *   open lists the moment anybody tabbed through it.
           *
           * ★ `:focus-visible` WAS THE OBVIOUS ANSWER AND IT IS THE WRONG ONE.
           *   It is meant to be false for a mouse click and true for Tab, but the
           *   embedded browser reports it TRUE after a click on this field too, so
           *   gating on it made a mouse click stop opening the list — a worse bug
           *   than the one it fixed. The signal is unreliable, so the component
           *   tracks the thing it actually cares about instead: whether the last
           *   key pressed was Tab.
           */
          /**
           * ★★ THE LIST OPENS ON A CLICK, ON A TYPED CHARACTER, OR ON ARROWDOWN —
           *    AND NOT ON FOCUS. That is the whole rule, and three attempts to
           *    refine "focus, but not from a Tab" all failed, which is the argument
           *    for not having the rule at all:
           *
           *    1. `:focus-visible` — meant to be false for a mouse click, but this
           *       browser reports it TRUE after a click here, so gating on it made
           *       a mouse click stop opening the list.
           *    2. A per-instance `useRef` flag set on the Tab keydown — per-instance
           *       by definition, so the field being LEFT set its own flag and the
           *       field being ENTERED read its own (still false). Tab still opened
           *       the next list.
           *    3. The same flag at module scope — Tab stopped opening the next list,
           *       but the flag outlived the traversal it described and ArrowDown
           *       stopped working.
           *    4. `relatedTarget` on focus — the cleanest-sounding of the four, and
           *       it broke the mouse click, because the origin of a click on the
           *       input is the input.
           *
           *    ★ EVERY ONE OF THOSE WAS A RULE ABOUT *FOCUS*, AND FOCUS IS THE WRONG
           *      EVENT. A reader who wants the list does something — clicks the
           *      field, types, or presses a key — and a reader merely tabbing past
           *      does none of those. `onClick` is unambiguous in a way `onFocus`
           *      never is: it fires for a press and not for a traversal, with no
           *      flag, no `relatedTarget` and no browser-dependent pseudo-class.
           *
           *    ★ THE COST, STATED: a keyboard reader who Tabs to the field sees no
           *      list until they press ArrowDown. That is one extra keystroke, it is
           *      the standard behaviour of a select-style combobox, and `aria-expanded`
           *      plus the visible border tell them the list is closed. The alternative
           *      was a bar that unfolds itself whenever somebody tabs through it.
           */
          onClick={() => setOpen(true)}
          // Typing narrows AND opens, because a reader who types is looking for
          // something in the list whether or not it was showing.
          onChange={(e) => {
            setDraft(e.target.value);
            setOpen(true);
          }}
          onKeyDown={onKeyDown}
        />
        <span className="combo__tail">
          <span className="combo__status" aria-hidden="true">
            {shown.length === searched.length
              ? num(searched.length)
              : `${num(shown.length)} of ${num(searched.length)}`}
          </span>
          {value !== '' ? (
            <button
              type="button"
              className="combo__clear"
              onClick={() => {
                setDraft('');
                onChange('');
              }}
              title={anyLabel}
            >
              ✕<span className="sr">{anyLabel}</span>
            </button>
          ) : null}
        </span>
      </div>

      {/* ★ THE LIST IS RENDERED ONLY WHILE OPEN — not hidden with CSS. A
          `display: none` listbox is still in the accessibility tree's DOM and
          still holds 40 focusable-by-`aria-activedescendant` options, and the
          `aria-controls` on the input would point at an element that is present
          but invisible. Unmounting it makes `aria-expanded="false"` true in fact
          as well as in the attribute. */}
      {open ? (
        <ul className="listbox listbox--filter" id={listboxId} role="listbox" aria-label={label}>
          {/* The clearing option is a real row rather than a reset button, because
              "Any account" is a value of the filter and not the absence of one —
              it is what the control reads when nothing is chosen, and a reader who
              has narrowed the list needs to see the way back at the top of it. */}
          <li
            className={`opt opt--any${value === '' ? ' opt--chosen' : ''}`}
            role="option"
            aria-selected={value === ''}
            onClick={() => {
              setDraft('');
              setOpen(false);
              onChange('');
            }}
          >
            {anyLabel}
          </li>

          {special ? (
            <li
              className={`opt opt--any${specialChosen ? ' opt--chosen' : ''}`}
              role="option"
              aria-selected={specialChosen}
              onClick={() => {
                setDraft('');
                setOpen(false);
                onChange(special.value);
              }}
            >
              {special.label}
            </li>
          ) : null}

          {shown.length === 0 ? (
            <li className="listbox__empty">
              {options.length === 0 ? (
                <>This register draws no options to filter by.</>
              ) : (
                <>
                  Nothing matches <strong>{draft.trim()}</strong>. The filter matches the code, the
                  name and the number of rows carrying it.
                </>
              )}
            </li>
          ) : (
            shown.map((o, i) => (
              <li
                key={o.value}
                id={optionId(o.value)}
                ref={i === active ? activeRef : null}
                className={
                  'opt opt--row' +
                  (i === active ? ' opt--active' : '') +
                  (o.value === value ? ' opt--chosen' : '')
                }
                role="option"
                aria-selected={o.value === value}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(o.value, i)}
              >
                <span className="opt__label">
                  <Highlight text={o.label} q={q} />
                </span>
                {o.detail ? <span className="opt__detail">{o.detail}</span> : null}
              </li>
            ))
          )}

          {/* The cap, stated. A list quietly shorter than the set is how a reader
              concludes the data is missing. */}
          {shown.length < searched.length ? (
            <li className="listbox__more" aria-hidden="true">
              {num(searched.length - shown.length)} more — keep typing to narrow
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
