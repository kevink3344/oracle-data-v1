import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../state/store';
import { scopeLabel, scopeSpoken } from '../data/scope';
import { money0, num } from '../data/format';

/**
 * The account scope, sitting beside the global search box.
 *
 *   [ search… ]  04  ( 861 ) ( 862 ) ( 863 )  ∨
 *
 * ★ WHERE THE CHIPS COME FROM, WHICH IS NEITHER THIS FILE NOR A CONSTANT. The fund and the programs
 *   are the `organization` row the session arrived with — the same row the Settings page edits. They
 *   used to be `ALL_PROGRAMS`, a literal in `data/scope.ts`, which made this panel a picture of the
 *   *bundle*: editing the organization changed nothing here, and there was nothing here to change. A
 *   program list belongs to a tenant, so it is read from the tenant.
 *
 * ★ THE SHAPE OF THIS CONTROL IS AN ARGUMENT ABOUT WHAT THE DATA IS, so it is worth stating before
 *   the markup. The fund is a **bare label, not a button**, because a reader cannot move it from here:
 *   it is the boundary of their organization, and widening an organization is a Settings edit rather
 *   than a chip. A dropdown offering one option would look like a control and behave like a lie,
 *   which is what it was when the option came from a literal. The programs *are* buttons, because
 *   they are the part a reader can actually move — within the tenant, never beyond it.
 *
 * ★ EVERY CHIP CARRIES ITS COUNT, AND THE COUNT IS THE UNFILTERED ONE. Measured against
 *   `app/public/oracle/output.json`, program 862 holds all 2,782 lines and 861 and 863 hold none —
 *   so the default selection removes nothing and switching 862 off empties the app. Both of those are
 *   things the control has to say out loud, because a filter that appears to do nothing and a filter
 *   that appears to have broken look identical from the outside. Hence: the count on a chip describes
 *   what the *extract* holds under that program, never what is currently shown, so a switched-off
 *   chip reads "0 lines" only when the data really has none — and "hidden, 2,782 lines" is never
 *   mistakable for "empty".
 *
 * ★ IT DOES NOT OWN THE RULE. `inScope` in `data/scope.ts` decides what is in and the store applies it
 *   to `lines` once, above every page. This component only writes the selection into the URL — and
 *   `parseScope` clamps whatever it writes back to the organization, so a chip cannot be a way to
 *   escape the tenant even if a future edit lets one name a program the tenant does not hold.
 */
export default function ScopeSelect() {
  const { scope, scopeTenant, scopeIsFull, toggleProgram, resetScope, setScope, scopeStats, status } =
    useStore();

  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);

  const busy = status === 'loading';
  const held = scopeTenant?.programs ?? [];
  const full = scopeIsFull;
  /**
   * ★ "REMOVES NOTHING" IS MEASURED, NOT ASSUMED. This used to be `isAuthoredScope(scope)` — a
   *   comparison against the constant — which answered the same thing only because the default scope
   *   was the extract's own boundary. The note below describes what the selection is doing *to the
   *   rows*, so it is asked of the rows: zero excluded is the fact behind the sentence, and it is true
   *   both for an organization whose programs hold everything and for a narrowed selection that
   *   happens to exclude nothing. `full` above is the other question — configuration, not effect — and
   *   it is what makes Reset idle.
   */
  const whole = scopeStats.excluded === 0;
  const totalLines = scopeStats.all;

  /**
   * Close on Escape and on a click outside, which are the two ways a reader expects to dismiss
   * something they opened with a caret. Both are attached only while it is open — a document-level
   * listener that exists for the life of the page is a listener that runs on every click everywhere.
   *
   * `mousedown` rather than `click` for the outside test, so the popover closes on the press that
   * starts a selection elsewhere rather than waiting for the release.
   */
  useEffect(() => {
    if (!open) return;

    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Move focus into the popover when it opens, so Escape and Tab both start from inside it.
  useEffect(() => {
    if (open) dialog.current?.focus();
  }, [open]);

  /**
   * Switch a program on or off.
   *
   * `stopPropagation` is not needed — the popover is inside `wrap`, and the outside-click test asks
   * whether the press was inside `wrap`, which it was.
   */
  const onChip = useCallback(
    (program: string) => {
      toggleProgram(program);
    },
    [toggleProgram],
  );

  return (
    <div className="scope" ref={wrap}>
      <div
        className="scope__inline"
        role="group"
        aria-label={`Account scope — ${scopeSpoken(scope)}`}
      >
        <span
          className="scope__fund"
          title={
            scopeTenant
              ? `Fund ${scope.fund} — the fund ${scopeTenant.name} is scoped to. Widening it is a Settings change, not a choice here.`
              : `Fund ${scope.fund}.`
          }
        >
          {scope.fund}
        </span>

        {/* The organization's programs, in the order the organization stores them. Each is a real
            toggle with a real count, including any that hold nothing today. */}
        {held.map((program) => {
          const on = scope.programs.includes(program);
          const held = scopeStats.programTotals.find((t) => t.program === program);
          const lines = held?.lines ?? 0;
          // ★ "IN THE LEDGER", NOT "IN THE EXTRACT". These counts come from the rows
          //   the API read live from Oracle, so naming the extract would name a file
          //   they no longer come from. Keep the empty case as its own sentence —
          //   program 863 is genuinely absent from the ledger and reads 0 honestly,
          //   whereas 861 was only missing from the *file*.
          const title = !on
            ? `Program ${program} — ${num(lines)} purchase-order lines in the ledger, currently hidden.`
            : lines === 0
              ? `Program ${program} — no purchase-order lines in the ledger carry this program.`
              : `Program ${program} — ${num(lines)} purchase-order lines, ${money0(held?.value ?? 0)} committed.`;

          return (
            <button
              key={program}
              type="button"
              className={`scope__chip${on ? ' is-on' : ''}${lines === 0 ? ' is-empty' : ''}`}
              aria-pressed={on}
              title={title}
              onClick={() => onChip(program)}
            >
              {program}
            </button>
          );
        })}
      </div>

      <button
        type="button"
        className="scope__caret"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Account scope: ${scopeSpoken(scope)}. Open the scope panel.`}
        title={scopeLabel(scope, held)}
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 12 12" fill="none" aria-hidden="true" focusable="false">
          <path
            d="M2.5 4.5 6 8l3.5-3.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open ? (
        <div
          className="scope__pop"
          role="dialog"
          aria-label="Account scope"
          tabIndex={-1}
          ref={dialog}
        >
          {scopeTenant ? (
            <p className="scope__pophead">
              <strong>{scopeTenant.name}</strong> · {scopeLabel(scope, held)}
            </p>
          ) : (
            <p className="scope__pophead">
              <strong>No organization</strong> · nothing is being filtered
            </p>
          )}

          <p className="scope__popnote">
            {whole ? (
              <>
                All {num(totalLines)} purchase-order lines in the ledger fall inside this scope, so it
                is currently removing nothing. It is still applied — the programs below are what a
                different selection would be tested against.
              </>
            ) : (
              <>
                <strong>
                  {num(scopeStats.excluded)} of {num(scopeStats.all)} lines removed
                </strong>{' '}
                — {money0(scopeStats.excludedValue)} committed. The remaining {num(scopeStats.shown)}{' '}
                lines are what every page in the app is showing.
              </>
            )}
          </p>

          <ul className="scope__list">
            {scopeStats.programTotals.map((t) => {
              const on = scope.programs.includes(t.program);
              return (
                <li key={t.program}>
                  <button
                    type="button"
                    className={`scope__row${on ? ' is-on' : ''}`}
                    aria-pressed={on}
                    onClick={() => onChip(t.program)}
                  >
                    <span className="scope__code">{t.program}</span>
                    <span className="scope__count">
                      {t.lines === 0 ? (
                        <em>no lines in the ledger</em>
                      ) : (
                        <>
                          {num(t.lines)} line{t.lines === 1 ? '' : 's'} · {money0(t.value)}
                        </>
                      )}
                    </span>
                    <span className="scope__tick" aria-hidden="true">
                      {on ? '✓' : ''}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {/* ★ THE FUND IS REPORTED, NOT OFFERED, AND THE SENTENCE SAYS WHY IN TERMS OF THE TENANT.
              It used to read "Fund is a stated constant, not a choice, because the extract carries
              exactly one" — true of a bundle with `04` written into it, and a non-answer the moment
              the fund is a field on the Settings form. `04` here is `GL_CODE_COMBINATIONS.SEGMENT1` for
              *this* organization, which is a reason a reader can check. */}
          <p className="scope__popfoot">
            {scopeTenant ? (
              <>
                {scopeTenant.name} is scoped to fund <strong>{scope.fund}</strong> —{' '}
                {held.length === 0 ? (
                  <>with no programs selected, so the fund alone is the rule.</>
                ) : (
                  <>
                    program <strong>{held.join('/')}</strong>.
                  </>
                )}{' '}
                {scopeStats.fundsPresent.length > 1 && (
                  <>
                    The extract holds funds {scopeStats.fundsPresent.join(', ')}.{' '}
                  </>
                )}
                Change it on the Settings page; the chips above follow it.
              </>
            ) : (
              <>
                No organization is loaded, so no scope is being applied — every line in the extract is
                shown. The fund is not a choice here because there is no tenant to take it from.
              </>
            )}
          </p>

          <div className="scope__actions">
            <button
              type="button"
              className="scope__reset"
              disabled={full}
              onClick={() => {
                resetScope();
                setOpen(false);
              }}
              title={
                full
                  ? `Already showing every program ${scopeTenant?.name ?? 'the organization'} holds.`
                  : `Show all ${held.length} program${held.length === 1 ? '' : 's'} ${scopeTenant?.name ?? 'the organization'} holds again — this also clears the scope from the URL.`
              }
            >
              Reset to all {held.length}
              {held.length === 1 ? ' program' : ' programs'}
            </button>

            <button
              type="button"
              className="scope__close"
              disabled={busy}
              onClick={() => setScope({ fund: scope.fund, programs: [] })}
              title={
                'Clear every program, so the fund alone is the rule. On this extract that keeps ' +
                'every line rather than removing them — the count above updates before you leave the ' +
                'panel, which is where you check it.'
              }
            >
              Clear programs
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
