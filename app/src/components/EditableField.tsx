import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import {
  deleteOverride,
  overrideFor,
  saveOverride,
  whenLabel,
  type FieldOverride,
  type OverrideState,
  type OverridableField,
} from '../data/customFields';
import { useSession } from '../data/session';

/**
 * One field that a reader may show their own value for, with the pencil that
 * writes one and the trash that gives the ledger's value back.
 *
 * ── WHAT THIS CONTROL IS ───────────────────────────────────────────────────
 *
 * It renders the value — the custom one where there is one, the ledger's where
 * there is not — and it wraps whatever the page was already rendering there. So the
 * register's row opener stays the row opener: the caller passes its own element as
 * `children` and this component adds the changed-value mark, the pencil, the trash and the
 * description around it.
 *
 * ── ★ THE TWO FACTS THAT MUST ALWAYS BE REACHABLE ──────────────────────────
 *
 * A custom value on screen is a claim about a row whose real value this
 * application does not own, so two things must never be more than a hover or a
 * screen reader away from it: **what the ledger holds**, and **who said otherwise
 * and when**. Both are in the DOM at all times — the ledger's value and the
 * attribution in a visually hidden element (`aria-describedby` from the pencil and
 * the trash), and the same sentences again in the tooltip, which is where a sighted
 * reader looks first. The attribution is the reason any signed-in user may write
 * here rather than a super admin only: a name nobody is answerable for would be
 * worse than the ledger's.
 *
 * ── ★ THE TOOLTIP IS NOT A `title` ─────────────────────────────────────────
 *
 * A `title` attribute is shown on mouse hover only, never on keyboard focus, and on
 * a touch screen never at all — so the one sentence explaining that the ledger's
 * value is still what finds this vendor would be unreachable exactly for the
 * readers least able to hunt for it. It is a `::after` on `:hover` **and**
 * `:focus-within`, over text carried in an attribute so it cannot drift from the
 * visually hidden copy (both are built from the same array).
 *
 * ── ★ NO PENCIL UNTIL THE READ HAS ANSWERED ────────────────────────────────
 *
 * The registry entry that says *which* fields may be overridden, and how long a
 * value may be, arrives **on the read** (`fields` on `GET /api/custom-fields`) —
 * deliberately, so this side cannot offer an edit the server would refuse. While the
 * read is out and after it has failed there is therefore no pencil and no trash:
 * the value on screen is the ledger's, and the page says why nothing else is
 * available. {@link CustomNamesNote} is that sentence, and every page using this
 * component must render it — a failed read that renders as "no custom values" is the
 * one failure this feature must not have.
 *
 * ── WHY A BLANK VALUE IS STOPPED HERE AND A LONG ONE IS NOT ────────────────
 *
 * "This is blank" is a fact about the text on screen, and the person is still
 * typing — sending it to be refused would be a round trip to learn something the
 * field already knows. What a blank *means* is also the interesting part: it is not
 * a delete (the route refuses it in those words), so the hint under the input points
 * at the trash instead. Every other limit — the length, whether the key identifies
 * anything once folded — is a fact about the store, and stays with the server, whose
 * sentence is printed verbatim.
 *
 * ── ★ FOCUS: IN ON OPEN, BACK ON WHAT OPENED IT ────────────────────────────
 *
 * Typing is the whole point of opening the editor, so focus lands in the input and
 * selects what is there. On Escape or Save it goes **back to the pencil** rather
 * than to the top of the document: the reader was working on this one field, and
 * losing their place on a 55-row register is how a small edit becomes a chore. A
 * clear moves it to the pencil too, because the trash is gone the moment the row is.
 *
 * ── ★ A FIELD THE LEDGER HAS NO COLUMN FOR ─────────────────────────────────
 *
 * Everything above assumes there is a value being superseded, and until the vendor
 * site's email there always was. `fromLedger: false` on the registry entry says
 * otherwise, and four sentences need a second form because of it: `Oracle holds
 * “”.` is a well-formed lie rather than a missing string, `Give “” a custom email`
 * quotes an empty string, `show the Oracle value again` names something that does
 * not exist, and `this is the ledger’s own` is false of a blank nobody supplied.
 *
 * ★ THE FLAG IS READ FROM THE REGISTRY AND NOT PASSED AS A PROP, WHICH IS THE ONLY
 *   PART OF THIS THAT MATTERS. The fact belongs to the field, so it arrives on the
 *   same payload as the label and the length limit, and a render site cannot get it
 *   wrong by forgetting an argument. It also means the fallback is sound: before the
 *   read answers there is no entry to ask, and an empty `oracleValue` is then the
 *   honest answer to "is this the ledger's" — see {@link heldByLedger}.
 */

/**
 * Where the field sits, which decides which controls it carries.
 *
 * ★ THE REGISTER CELL CARRIES NONE, AND THAT IS A LAYOUT DECISION RATHER THAN A
 *   PRODUCT ONE. A register table sits in a `.table-wrap`, which is
 *   `overflow-x: auto`; CSS computes the other axis from `visible` to `auto` when
 *   one is not visible, so the wrapper clips vertically at its own padding box. A
 *   tooltip anchored to a cell is therefore sliced for the last row or two of the
 *   table — and every arrangement that avoids the clip (containing block outside
 *   the scroller, or `position: fixed`) breaks something worse: the first drops the
 *   tooltip at the table's corner instead of at the row, and the second is measured
 *   in viewport coordinates inside a `transform`ed `.drawer`, which is what the
 *   panel head is. See the head of `app/src/styles/customfields.css`.
 *
 *   So the cell shows the value, the changed-value mark (a small gear) and the
 *   whole disclosure to assistive technology in a visually hidden element — and the
 *   pencil, the trash and the tooltip are in the panel head, which is not a scroller
 *   and is where a reader goes to find out about the row they are looking at. The
 *   row is already a button, so this costs one click on the surface built for it.
 */
export type EditableFieldVariant =
  /** A panel heading: `.drawer__name`. Full controls; the tooltip opens below. */
  | 'heading'
  /** A line of panel meta: `.drawer__meta`. Full controls, small and inline. */
  | 'meta'
  /** A register cell: the value and the changed-value mark, and no controls at all. */
  | 'register';

export interface EditableFieldProps {
  /** The subject's overrides, from `useOverrides`. One per page, not one per row. */
  read: OverrideState;
  /** `'vendor'`, as the registry spells it. */
  subject: string;
  /** `'name'`, as the registry spells it. */
  field: string;
  /**
   * The subject's identity, **folded** — for a vendor, `vendorKeyOf(name)`. This is what
   * the stored override is matched on, and it is the same fold the server applies
   * before it stores one. Nothing here folds anything a second time: see
   * `overrideFor`.
   */
  subjectKey: string;
  /**
   * The identity as the register writes it — for a vendor, the Oracle name itself.
   * Sent on a save and on a clear, and folded by the server. Sent in this spelling
   * rather than the folded one on purpose: the server keeps it as
   * `subject_written`, which is what a reader recognises in an override whose
   * company has since left the register.
   */
  keyWritten: string;
  /**
   * What the ledger holds. Always shown to a reader, in the tooltip and to AT.
   *
   * ★ IT MAY LEGITIMATELY BE EMPTY, AND AN EMPTY ONE IS NOT A MISSING VALUE. A field
   *   the ledger has no column for (the registry's `fromLedger: false`) passes `''`,
   *   and this component then says the ledger holds nothing rather than quoting
   *   nothing — see the note at the head of this file.
   */
  oracleValue: string;
  /** Called after a successful write, so the page re-reads and every row follows. */
  onChanged: () => void;
  /** Where it sits. Defaults to `'register'`. */
  variant?: EditableFieldVariant;
  /**
   * The value as the page renders it — the register's row opener, a span with its
   * own class. Omitted, the display value is printed as bare text.
   *
   * ★ IN A REGISTER CELL, KEEP THE CALLER'S ELEMENT BLOCK-LEVEL. The mark is
   *   rendered after whatever is passed here, so a `display: block` opener puts the
   *   mark on the line below the name — which is where there is room for it. An
   *   inline opener would put the mark beside the name and push it out to the
   *   column's edge.
   */
  children?: ReactNode;
}

/**
 * Whether this field is one the ledger holds a value for.
 *
 * ★ THE REGISTRY ANSWERS IT; THE VALUE IS ONLY THE FALLBACK FOR THE MOMENT BEFORE
 *   THE READ ARRIVES. `fromLedger` comes on the same payload as `label` and
 *   `maxLength`, so while the read is out `spec` is null — and the component still
 *   has one sentence to build. A caller that passes nothing for a field the ledger
 *   *does* hold is passing the ledger's own empty value, and "Oracle holds no value
 *   for this field" is then true of it as well, so the fallback is not wrong in
 *   either direction.
 */
function heldByLedger(spec: OverridableField | null, oracleValue: string): boolean {
  return spec ? spec.fromLedger : oracleValue !== '';
}

/**
 * What the ledger holds, who changed it, and what that does not change.
 *
 * Built once and used for **both** the tooltip and the visually hidden description,
 * so the two cannot disagree — and so the sentence about the lookup is the
 * registry's own (`effect` on the entry), which says in one place what an override
 * does not do.
 *
 * `state` is read here because the *caveat* has to reach a reader whose read
 * failed: this is the element they are looking at, and it is where the note about a
 * name that might be hiding something belongs.
 */
function describe(
  override: FieldOverride | null,
  oracleValue: string,
  spec: OverridableField | null,
  state: OverrideState['state'],
): string[] {
  const lines: string[] = [];
  const held = heldByLedger(spec, oracleValue);

  // ★ The ledger's value leads, always, and in quotes, because every other line is
  //   about it. Even on the caller's own field this is not redundant: the value on
  //   screen is a custom one whenever the second line is present, so the reader has
  //   to be told what it is standing in for.
  //
  // ★ AND WHERE THE LEDGER HAS NO COLUMN, THE LINE IS NOT DROPPED — IT IS WORDED
  //   FOR THE CASE. There is nothing to quote, so it states the absence; the
  //   registry's `effect` sentence follows it and is what explains that nothing
  //   looks the value up, mails to it or exports it. Deleting the line instead
  //   would leave the tooltip's first fact unstated on exactly the field where a
  //   reader is most likely to assume the value came from somewhere official.
  lines.push(held ? `Oracle holds “${oracleValue}”.` : 'Oracle holds no value for this field.');

  if (override) {
    lines.push(
      `The value shown is a custom value set by ${override.setBy} on ${whenLabel(override.setAt)}.`,
    );
  } else if (state === 'failed') {
    lines.push(
      'Custom values could not be read, so there may be one for this row that is not being shown.',
    );
  } else if (spec) {
    lines.push(
      held
        ? 'No custom value is set, so this is the ledger’s own.'
        : 'No custom value is set, so the field is empty.',
    );
  }

  if (spec) lines.push(spec.effect);

  return lines;
}

/** The pencil. Nineteen pixels of path; the button is sized by the stylesheet. */
function PencilIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M11.6 1.6a1.8 1.8 0 0 1 2.5 2.5l-.9.9-2.5-2.5.9-.9ZM9.9 3.3 2.6 10.6 1.6 14.4l3.8-1 7.3-7.3-2.8-2.8Z"
        fill="currentColor"
      />
    </svg>
  );
}

/** The trash — what the route's own refusal calls it: "Use the trash …". */
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
 * The gear — what the mark means: *this value has been changed*.
 *
 * ★ IT REPLACED THE WORD "custom", WHICH WAS THE PROBLEM RATHER THAN THE FIX.
 *   The mark is a footnote to the value and not a status of the row, so the moment
 *   it outweighs the company name it annotates it has failed at its only job: a
 *   bold uppercase pill reading CUSTOM is wider than most of the names it sits
 *   under, and a reader scanning a register reads it before the value.
 *
 *   Nothing is lost by taking the word away. Whoever needs the disclosure has it:
 *   the tooltip in a panel variant, the visually hidden note in every variant, and
 *   the note a page prints when the read failed. The word was there for the reader
 *   who needed none of it — the one who only has to recognise "this is not the
 *   ledger's name", and for whom a mark alone is exactly the right amount.
 *
 * ★ DRAWN AND NOT TYPED (`⚙`, as the rail's settings button uses): a text glyph
 *   has whichever weight and optical size the reader's font supplies, and can
 *   arrive as a colour emoji that ignores `color` — which for a mark whose whole
 *   point is to be quiet is the one failure that matters.
 */
function GearIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {/* Four bars through the centre, each 180°-symmetric, so the eight teeth come
          from one rule instead of eight shapes that could drift out of step. */}
      {[0, 45, 90, 135].map((deg) => (
        <rect
          key={deg}
          x="7"
          y="1.1"
          width="2"
          height="3.2"
          rx="0.9"
          fill="currentColor"
          transform={`rotate(${deg} 8 8)`}
        />
      ))}
      {/* The body is a *stroked* circle so the middle stays open: a filled disc
          would close the hole the shape is made of. */}
      <circle cx="8" cy="8" r="5.05" fill="none" stroke="currentColor" strokeWidth="2.1" />
      {/* The hub, which is what makes an open centre read as a gear's hole rather
          than as a ring. */}
      <circle cx="8" cy="8" r="1.25" fill="currentColor" />
    </svg>
  );
}

export function EditableField({
  read,
  subject,
  field,
  subjectKey,
  keyWritten,
  oracleValue,
  onChanged,
  variant = 'register',
  children,
}: EditableFieldProps) {
  const session = useSession();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const inputId = useId();
  const noteId = useId();
  const pencilRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const wasEditing = useRef(false);

  // A case-insensitive pair match: the registry sends its own spelling and the
  // page passes that same literal, but a comparison that depended on the two
  // happening to agree on case would be a coincidence rather than a rule.
  const spec =
    read.fields.find(
      (f) =>
        f.subject.toLowerCase() === subject.toLowerCase() &&
        f.field.toLowerCase() === field.toLowerCase(),
    ) ?? null;

  const override = overrideFor(read, field, subjectKey);
  const shown = override?.value ?? oracleValue;
  const held = heldByLedger(spec, oracleValue);
  // ★ WHAT THE RECORD IS CALLED WHEN THERE IS NO LEDGER VALUE TO CALL IT BY. The
  //   pencil's labels quote the ledger's value, which is the right anchor on a field
  //   the reader is looking at — and is a quoted empty string on one the ledger does
  //   not hold. The registry's own noun phrase stands in, so the two labels read
  //   "Give this vendor site a custom email" and "Change the custom email for this
  //   vendor site" instead of naming nothing twice.
  const anchor = held ? `“${oracleValue}”` : (spec?.subjectWord ?? 'this record');

  // A pencil is offered only when the read answered, the field is one the registry
  // declares, there is a session to attribute a save to, and the variant has room
  // for a control — see the note on `EditableFieldVariant`. The check is a
  // convenience and not an access control: the route calls `requireActor`, and a
  // stale tab's save is refused with its own sentence, which is printed below.
  const editable =
    read.state === 'ready' && spec !== null && session?.authenticated === true && variant !== 'register';

  const lines = describe(override, oracleValue, spec, read.state);
  const note = lines.join(' ');
  // No tooltip in a register cell, and none while the editor is open or the read is
  // still out — see the stylesheet's note on the clip.
  const tip =
    variant === 'register' || editing || read.state !== 'ready' ? null : lines.join('\n');

  // Focus in on open, and back on the pencil when the editor closes — see the note
  // at the head of the file. `wasEditing` rather than a plain `else`, so the first
  // render of an untouched field does not steal focus from the panel behind it.
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (wasEditing.current) {
      pencilRef.current?.focus();
    }
    wasEditing.current = editing;
  }, [editing]);

  const startEdit = () => {
    setDraft(shown);
    setProblem(null);
    setEditing(true);
  };

  const cancel = () => {
    if (busy) return;
    setProblem(null);
    setEditing(false);
  };

  const commit = async () => {
    const value = draft.trim();
    if (!spec || value === '' || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await saveOverride(subject, field, keyWritten, value);
      setEditing(false);
      onChanged();
    } catch (err: unknown) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (!spec || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await deleteOverride(subject, field, keyWritten);
      onChanged();
      // The trash is about to disappear with the row, so focus goes to the pencil
      // that is still there. After `onChanged` the page keeps its last good read on
      // screen (`useOverrides` does not fall back to 'loading'), so the pencil is
      // mounted by the time this runs.
      pencilRef.current?.focus();
    } catch (err: unknown) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancel();
    }
  };

  const className =
    `cf cf--${variant}` +
    (override ? ' is-custom' : '') +
    (editing ? ' is-editing' : '') +
    (tip ? ' cf--tip' : '');

  if (editing) {
    const blank = draft.trim() === '';
    return (
      <span className={className} data-tip={tip ?? undefined}>
        <label className="sr" htmlFor={inputId}>
          Custom {spec?.label ?? 'value'}
        </label>
        <input
          id={inputId}
          ref={inputRef}
          className="cf__input"
          type="text"
          value={draft}
          maxLength={spec?.maxLength}
          aria-describedby={noteId}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="cf__btn cf__btn--save"
          disabled={busy || blank}
          onClick={() => void commit()}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="cf__btn cf__btn--cancel" disabled={busy} onClick={cancel}>
          Cancel
        </button>
        {blank ? (
          <span className="cf__hint">
            A custom {spec?.label ?? 'value'} cannot be blank.{' '}
            {/* ★ THE HINT POINTS AT THE TRASH, SO IT HAS TO SAY WHAT THE TRASH
                LEAVES. On a field the ledger holds that is the ledger's value; on
                one it does not hold, the trash leaves an empty field — and "the
                value Oracle holds again" would send the reader looking for a value
                that does not exist. */}
            {held
              ? 'The trash shows the value Oracle holds again.'
              : 'The trash leaves the field empty.'}
          </span>
        ) : null}
        <span className="sr" id={noteId}>
          {note}
        </span>
        {problem ? (
          <span className="cf__problem" role="alert">
            {problem}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <span className={className} data-tip={tip ?? undefined}>
      {/* The mark is inside `.cf__value`, after the caller's element. With a
          block-level opener that puts it on the next line — the one place in a
          register cell with room for it — and in a panel it follows the name on the
          same line, which is where a reader expects it. */}
      <span className="cf__value">
        {children ?? shown}
        {override ? (
          <span
            className="cf__mark"
            // `role="img"` with a name, because the mark used to say "custom" in
            // words and now says it in a shape: without this the gear is a picture
            // with no name, and the *fact* it carries would reach AT only through
            // the note below.
            role="img"
            aria-label={spec ? `Custom ${spec.label}` : 'Custom value'}
            // ★ A REGISTER CELL GETS A NATIVE `title`, BECAUSE IT CANNOT HAVE THE
            //   CSS TOOLTIP — `.table-wrap` clips it (see the stylesheet). The one
            //   line a reader who wonders about the gear needs is the value it is
            //   standing in for. In a panel the `.cf--tip` bubble already says this
            //   and more, so a `title` there too would open two tooltips at once.
            //   Where the ledger holds nothing there is no value to name, and the
            //   `title` says that rather than quoting an empty string.
            title={
              variant === 'register'
                ? held
                  ? `Custom value — Oracle holds “${oracleValue}”`
                  : 'Custom value — the ledger holds no value for this field'
                : undefined
            }
          >
            <GearIcon />
          </span>
        ) : null}
      </span>
      {editable ? (
        <span className="cf__actions">
          <button
            type="button"
            ref={pencilRef}
            className="cf__btn cf__btn--edit"
            aria-label={
              override
                ? `Change the custom ${spec.label} for ${anchor}`
                : `Give ${anchor} a custom ${spec.label}`
            }
            aria-describedby={noteId}
            onClick={startEdit}
          >
            <PencilIcon />
          </button>
          {override ? (
            <button
              type="button"
              className="cf__btn cf__btn--clear"
              // ★ THE TRASH'S NAME SAYS WHAT HAPPENS, NOT WHAT IT IS. It is not
              //   "delete": nothing is deleted, in this table or any other — the
              //   row goes away and what is left is the ledger's value, or an empty
              //   field where the ledger never had one. The second form is the
              //   field's own state and not a softer wording of the first.
              aria-label={
                held
                  ? `Remove the custom ${spec.label} and show the Oracle value`
                  : `Remove the custom ${spec.label} and leave the field empty`
              }
              aria-describedby={noteId}
              disabled={busy}
              onClick={() => void clear()}
            >
              <TrashIcon />
            </button>
          ) : null}
        </span>
      ) : null}
      <span className="sr" id={noteId}>
        {note}
      </span>
      {problem ? (
        <span className="cf__problem" role="alert">
          {problem}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The one line a page must render when the overrides could not be read.
 *
 * ★ RENDER THIS ON EVERY PAGE THAT USES {@link EditableField}, UNCONDITIONALLY.
 *   A read that failed renders exactly like a register nobody has renamed anything
 *   on, and those are different facts: the first is hiding a value somebody chose,
 *   and the reader has no way to tell which they are looking at. This note is the
 *   only thing that separates them, and because it is the *absence* of something
 *   that makes the two alike, forgetting to render it fails silently.
 *
 * ★ AND RENDER ONE PER READ, WHICH SINCE THE SECOND SUBJECT IS NOT ONE PER PAGE. A
 *   page that reads two subjects (`/vendors/sites`: `vendor` for the company names,
 *   `vendor_site` for a site's email) holds two independent reads, either of which
 *   can fail on its own. A single note for the whole page would have to speak for
 *   both — it would claim nothing on screen is a custom value while the other read
 *   was still showing one — so each read gets its own, rendered where its values
 *   are. `what` is what tells them apart: the flag is the only part of the note a
 *   reader can use to tell which read failed, and "Custom values unread" twice on
 *   one page is a puzzle rather than a warning.
 *
 * The body is wrapped in `.scopenote__text` for the reason `ScopeNote.tsx` records:
 * `.scopenote` is a flex container with a gap, so a bare text node beside the flag
 * becomes a flex item of its own and the sentence renders as fragments.
 *
 * Renders nothing when the read worked. The count of custom values on a page is the
 * page's business, and each row already carries its own changed-value mark — but a page
 * that wants to state the count has `read.rows` and the rows it is showing.
 */
export function CustomNamesNote({ read, what = 'values' }: { read: OverrideState; what?: string }) {
  if (read.state !== 'failed') return null;

  return (
    <p className="scopenote scopenote--unread" role="note">
      <span className="scopenote__flag">Custom {what} unread</span>
      <span className="scopenote__text">
        {read.problem ??
          `The custom ${what} saved on this register could not be read.`}{' '}
        Nothing below is therefore a custom value, and a custom value saved earlier is not
        lost — it is not being shown.
      </span>
    </p>
  );
}
