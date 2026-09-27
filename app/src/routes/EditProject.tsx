import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useStore } from '../state/store';
import {
  clampBackgroundStrength,
  clearProjectBackground,
  deleteProject,
  listProjectBackgroundTypes,
  readProjectBackgroundFile,
  updateProject,
  uploadProjectBackground,
  PROJECT_BACKGROUND_DEFAULT_STRENGTH,
  PROJECT_BACKGROUND_MAX_BYTES,
  PROJECT_BACKGROUND_MAX_STRENGTH,
  PROJECT_BACKGROUND_TYPES,
  type ProjectUpdate,
  type RegistryRow,
} from '../data/projectMeta';
import { useProjectBackground } from '../data/projectBackground';
import type { Project } from '../data/types';
import LevelPicker from '../components/LevelPicker';
import ErrorNotice from '../components/ErrorNotice';
import { Chip, PurposeChip } from '../components/Chip';
import { money0, num, pluralise, pctSlim, share } from '../data/format';

/**
 * The edit page: a project's name, its note, and the account level it is funded by.
 *
 * ★ ONE FORM, BECAUSE IT IS ONE WRITE.
 *   Coded and uncoded projects were two different screens with two different verbs —
 *   a name was *recorded*, a level was *bound* — and the split cost more than it
 *   bought. The row is the same row, the endpoint is the same `PATCH`, and the
 *   thing that differed is only whether `level_code` was null when the reader
 *   arrived. So there is one page, reached by one link labelled `Edit`, and this is
 *   the only place in the app where a level can be *changed* rather than merely
 *   filled in for the first time.
 *
 * ★ THE LEVEL IS THE IDENTITY, AND THAT IS WHY THE PREVIEW IS HERE.
 *   A project does not gather ledger rows by its name, its note or its code — it
 *   gathers them because some account combination carries its `SEGMENT5` value. The
 *   moment the four digits are in the field, the budgets Oracle already holds
 *   against that level are visible underneath, before anything is saved. That
 *   preview is a *read*: it is `deriveProjects` over the extract the whole app is
 *   already reading, found by level. **Saving imports nothing.** The budgets were
 *   always there; binding the level is what makes this project's table show them.
 *   Saying so is not pedantry — a reader who believes Save copied rows into the app
 *   will believe the figures are stale the next time Oracle changes.
 *
 * ★ THE LEVEL IS OFFERED AS A LIST AND ACCEPTED AS FOUR DIGITS.
 *   `LevelPicker` is the combination picker narrowed to levels: the field's value
 *   *is* the level, so a code the extract has no money on is still saveable — the
 *   registry checks a level against `GL_CODE_COMBINATIONS`, not against this
 *   extract, and those are different populations. What the page must not do is
 *   assert a reason for the silence, so the empty state separates "the extract has
 *   no rows on this level" from "this level is not a level at all" — the second of
 *   which only the server knows, and it answers with a sentence.
 *
 * ★ ONLY CHANGED FIELDS ARE SENT, AND `undefined` IS NOT `null`.
 *   `PATCH /api/projects/{slug}` treats an absent field as "leave this column
 *   alone" and `null` as "clear it", so the difference between "the reader did not
 *   mention the level" and "the reader removed the level" has to survive into the
 *   request body. Building the body from `undefined` and asserting `!== undefined`
 *   keeps that distinction; a spread that collapsed the two would make every save
 *   release the project. Sending only what changed also means `updated_at` moves
 *   when the row moved and not when the page was merely opened and saved.
 *
 * ★ THE REFUSAL IS THE SERVER'S SENTENCE, NOT A PARAPHRASE.
 *   `Level 0453 is already held by "…"`, `Level 9999 is not a Level code any
 *   account combination carries` — each of those names the value that is wrong, and
 *   this page is the only place it appears. Replacing one with "that level is
 *   unavailable" would throw away the thing the reader can act on.
 *
 * ★ THE SUBMIT BUTTON IS OUTSIDE THE `<form>` AND JOINED BY `form="edit-project"`.
 *   That is how `NewProject` does it and it is kept deliberately: the button has to
 *   sit in the page head, above the panel it submits. It also means a test that
 *   selects `form button[type=submit]` matches **nothing** — the selector to use is
 *   `button[form="edit-project"]`.
 *
 * ★ DELETING IS ON THIS PAGE, AND IT IS DELIBERATELY THE LAST THING ON IT.
 *   The delete is the only irreversible act in the app, so it is not in the page
 *   head beside `Save changes`. It is a panel of its own below the form, and it
 *   asks a second time before it does anything. Two properties are worth naming
 *   because a later refactor could drop either without anything failing:
 *
 *     - **Focus moves to Cancel when the confirmation opens.** A confirmation
 *       that leaves focus on the trigger is one Enter away from deleting the
 *       project, which is the accident it exists to prevent.
 *     - **The panel says what it does NOT do.** Deleting a project does not touch
 *       Oracle, and it does not remove the account level — it releases it. A
 *       reader who has to guess which of those "delete" meant will guess wrong
 *       about half the time, and the expensive wrong guess is the one that thinks
 *       the level went with the row.
 *
 * ★ THE PAGE SURVIVES ITS OWN DELETION, AND THAT IS WHY `deleted` IS A STATE.
 *   `reloadRegistry()` on success takes the row out of the registry, so the row
 *   this page is built from stops existing one render later. Everything the
 *   success panel needs — the name, the level, the key — is captured *before* the
 *   re-read; taken afterwards it would be `undefined`, which reads as a bug in the
 *   panel rather than as a variable read a moment too late.
 */

/**
 * The budgets that already exist on a level.
 *
 * Not an importer and not a form field: this is the answer to "what does binding
 * this level actually gather?", printed before the reader commits to it. The figures
 * are the same ones the projects table shows after saving, because both come from
 * `deriveProjects` — so the preview cannot promise a project the table will not
 * produce.
 */
function LevelBudgets({ level, anchor }: { level: string | null; anchor: Project | null }) {
  if (level === null) {
    return (
      <p className="lb__none">
        No level is set, so this project gathers nothing. It sits in the recorded queue, its name
        appears in no ledger figure, and no cost centre is attached to it. Four digits above is what
        changes that.
      </p>
    );
  }

  if (level.length !== 4) {
    return (
      <p className="lb__none">
        A level is exactly four digits — <strong>{level.length}</strong> typed so far. Nothing is
        looked up until all four are in: a three-digit prefix matches levels from `0400` upwards and
        guessing which one was meant is how a wrong level gets saved.
      </p>
    );
  }

  if (!anchor) {
    return (
      <>
        <p className="lb__none">
          <strong>No purchase-order line in the extract carries level {level}.</strong> That does not
          make the level wrong — the registry checks it against <code>GL_CODE_COMBINATIONS</code>,
          which is the ledger, not this extract — so it can still be saved. Two things follow, and
          both are visible rather than silent: no budget is brought in, because there are no rows to
          bring, and the account list is empty — a level is four digits and its code <code>CC-{level}</code>{' '}
          follows from those four digits, so nothing has to be invented to write it down.
        </p>
        <p className="lb__none">
          If this level <em>should</em> carry money, the extract is the thing to check — elsewhere on
          this page the ledger is not consulted, so a level the extract has never seen and a level
          the ledger has never heard of look identical from here. The registry tells them apart on
          save, and says which one it was.
        </p>
      </>
    );
  }

  const { buckets } = anchor;
  const top = buckets.reduce((a, b) => (b.committed > a.committed ? b : a), buckets[0]);

  return (
    <>
      <p className="lb__lead">
        <strong>{anchor.name}</strong>
        {anchor.unclaimed ? (
          <span className="lb__tag">named from its own cost codes, not by a claim</span>
        ) : null}
      </p>

      <dl className="lb__facts">
        <div>
          <dt>Display code</dt>
          <dd>
            <code>{anchor.code}</code>
          </dd>
        </div>
        <div>
          <dt>Committed</dt>
          <dd>{money0(anchor.committed)}</dd>
        </div>
        <div>
          <dt>Budget groups</dt>
          <dd>{pluralise(buckets.length, 'group')}</dd>
        </div>
        <div>
          <dt>Lines</dt>
          <dd>{num(anchor.lines)}</dd>
        </div>
        <div>
          <dt>Orders</dt>
          <dd>{num(anchor.orders)}</dd>
        </div>
        <div>
          <dt>Vendors</dt>
          <dd>{num(anchor.vendors)}</dd>
        </div>
        <div>
          <dt>Accounts</dt>
          <dd>{num(anchor.accounts.length)}</dd>
        </div>
        <div>
          <dt>Cost codes</dt>
          <dd>{num(anchor.buckets.reduce((n, b) => n + b.costCodes.length, 0))}</dd>
        </div>
        <div>
          <dt>Activity</dt>
          <dd>
            {anchor.first} → {anchor.last}
          </dd>
        </div>
      </dl>

      {/*
        ★ A LIST, NOT A TABLE, AND NOT BECAUSE IT IS SHORTER.
          `table.data` is this app's table: tabular numerals, a hover row, and cells
          that do not wrap. Every one of those is wrong here — there are at most a
          handful of groups, this is a preview of money rather than a set of records
          to scan, and the group label is three pieces of text that must be allowed
          to wrap in a column a third of the page wide. Reusing the class would have
          meant fighting its `white-space` with a more specific selector, which is a
          layout decided by CSS specificity instead of by what the content is.
      */}
      <ul className="lb__groups">
        {buckets.map((b) => (
          <li className="lb__group" key={b.purpose}>
            <div className="lb__gtop">
              <PurposeChip purpose={b.purpose} />
              <span className="lb__glabel">{b.meta.label}</span>
            </div>
            <p className="lb__gmeta">
              {num(b.costCodes.length)} object {b.costCodes.length === 1 ? 'code' : 'codes'} ·{' '}
              {num(b.lines)} {b.lines === 1 ? 'line' : 'lines'} · {num(b.orders)}{' '}
              {b.orders === 1 ? 'order' : 'orders'} · {num(b.vendors)}{' '}
              {b.vendors === 1 ? 'vendor' : 'vendors'}
            </p>
            <p className="lb__gfig">
              <span className="lb__gamt">{money0(b.committed)}</span>
              <span className="lb__gshare">{pctSlim(share(b.committed, anchor.committed))}</span>
            </p>
          </li>
        ))}
      </ul>

      <p className="lb__total">
        Level {level}
        {top && top.committed !== anchor.committed ? (
          <> — mostly {top.meta.label.toLowerCase()}</>
        ) : null}{' '}
        <span className="lb__gamt">{money0(anchor.committed)}</span> committed across{' '}
        {pluralise(buckets.length, 'budget group')}
      </p>

      <p className="lb__foot">
        <strong>Nothing is imported by saving.</strong> These {pluralise(buckets.length, 'budget')}{' '}
        already exist on level {level} — they are the rows every screen in the app already reads,
        gathered by the level rather than by this project&rsquo;s name. Binding the level is what
        puts them under this project&rsquo;s label; the money stays Oracle&rsquo;s.
      </p>
    </>
  );
}

export default function EditProject() {
  const { slug = '' } = useParams();
  const {
    status,
    error,
    reload,
    registry,
    registryError,
    projects,
    takenLevels,
    reloadRegistry,
  } = useStore();

  const row = useMemo(
    () => registry.find((r) => r.slug === slug) ?? null,
    [registry, slug],
  );

  /**
   * The picture stored against this row, read for the same reason the form reads
   * the row at all: a reader about to replace or remove something should be able
   * to see what is there first.
   *
   * ★ THE SAME HOOK THE PROJECT'S OWN PAGE USES, AND THE GATE IS THE REASON.
   *   `expected` is the registry's `hasBackground`, so a project with no picture
   *   costs no request and gets no error — and a *successful* upload flips that
   *   flag, which re-runs the effect and puts the new picture on screen without a
   *   manual refresh. Re-implementing the fetch here instead would be a second
   *   place for that gating to be got wrong.
   */
  const { state: background, reload: reloadBackground } = useProjectBackground(
    row?.slug ?? null,
    row?.hasBackground ?? false,
  );

  /**
   * The picture's own three states: the write in flight, the refusal, and what
   * was stored or removed.
   *
   * Kept apart from the form's `busy`/`problem`/`saved` on purpose. The two writes
   * are different verbs on the same row — `PATCH /api/projects/{slug}` for the
   * fields, `PUT /api/projects/{slug}/background` for the bytes — and a picture
   * that failed to store must not appear as "the change was not saved" above a
   * form whose fields were never sent.
   */
  const [bgBusy, setBgBusy] = useState(false);
  const [bgProblem, setBgProblem] = useState<string | null>(null);
  const [bgNotice, setBgNotice] = useState<string | null>(null);
  const bgFileRef = useRef<HTMLInputElement | null>(null);

  /**
   * How strongly the header draws the picture, and the write that stores it.
   *
   * ★ A FOURTH STATE TRIO, FOR THE SAME REASON THERE IS A THIRD. The comment
   *   above already says the picture's write is not the form's; this is a third
   *   verb on the same row — `PATCH /api/projects/{slug}` with one field in it,
   *   sent by the slider rather than by the Save button. Sharing `bgBusy` would
   *   make dragging the slider grey out the *upload* buttons, which is a claim
   *   that a file is being read when nothing is being read.
   *
   * ★ `strength` IS THE READER'S HAND AND `strengthStoredRef` IS THE SERVER'S
   *   ROW, AND THEY ARE TWO VARIABLES BECAUSE THEY ARE TWO THINGS. A drag fires
   *   `change` on every pixel of travel — the number under the reader's thumb has
   *   to follow instantly, or the control feels broken — while the write happens
   *   once, on release. So `strength` moves freely and the ref records only what
   *   the server has confirmed, which is also what stops a release at the value
   *   that is already stored from spending a request to store it again.
   */
  const [strength, setStrength] = useState<number>(PROJECT_BACKGROUND_DEFAULT_STRENGTH);
  const [strengthBusy, setStrengthBusy] = useState(false);
  const [strengthProblem, setStrengthProblem] = useState<string | null>(null);
  const strengthStoredRef = useRef<number | null>(null);
  const strengthPendingRef = useRef<number | null>(null);
  /**
   * ★ THE WRITES ARE NUMBERED BECAUSE A DRAG CAN OUTRUN ITSELF.
   *   Release, release again a moment later, and two `PATCH`es are in the air at
   *   once; responses can arrive out of order, and a slow first response landing
   *   last would put the reader's *earlier* number back on the control. The
   *   counter makes the newest write the only one allowed to write state.
   */
  const strengthSeqRef = useRef(0);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [level, setLevel] = useState('');
  const [touchedName, setTouchedName] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<RegistryRow | null>(null);

  /**
   * Delete: the question, the request in flight, the refusal, and the row that went.
   *
   * `deleted` holds a *copy* of the three things the success panel prints rather
   * than the row itself — see the note at the top of this file. `cancelDeleteRef`
   * exists so the confirmation can open with focus on the safe control.
   */
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteProblem, setDeleteProblem] = useState<string | null>(null);
  const [deleted, setDeleted] = useState<{ slug: string; name: string; level: string } | null>(
    null,
  );
  const cancelDeleteRef = useRef<HTMLButtonElement | null>(null);

  /**
   * ★ SEEDED ONCE PER PROJECT, NOT ON EVERY REGISTRY READ.
   *
   *   Saving re-reads the registry so the table behind this page shows what the
   *   server stored. If the form re-seeded from that read it would also throw away
   *   whatever the reader had typed since — and the reader who types while a save
   *   is in flight is exactly the reader this page exists for. So the seed is
   *   keyed on the slug: it runs when the row first arrives, and never again for
   *   that project.
   */
  const [seeded, setSeeded] = useState<string | null>(null);
  useEffect(() => {
    if (!row || seeded === row.slug) return;
    setName(row.name);
    setDescription(row.description ?? '');
    setLevel((row.levelCode ?? '').trim());
    setSeeded(row.slug);
  }, [row, seeded]);

  /**
   * The strength, parked where the header is actually drawing.
   *
   * ★ SEPARATE FROM THE FORM'S SEED ABOVE, FOR ONE REASON THAT MATTERS: this one
   *   has to record the server's value as well as show it. `strengthStoredRef` is
   *   what makes a release at the stored number a no-op, and there is no
   *   equivalent in the form because the form has a Save button to decide that for
   *   it. Both effects are keyed on the slug and so both run once per project —
   *   the registry re-read after a save does not move the slider back.
   *
   * ★ `?? DEFAULT` IS THE DRAWING'S OWN ANSWER, RESTATED. `null` means nobody has
   *   chosen, and the header answers that with 33 — so the control has to *begin*
   *   at 33, otherwise the reader's first glance at the page would show a slider
   *   parked somewhere the picture demonstrably is not.
   */
  const [strengthSeeded, setStrengthSeeded] = useState<string | null>(null);
  useEffect(() => {
    if (!row || strengthSeeded === row.slug) return;
    setStrength(clampBackgroundStrength(row.backgroundStrength ?? PROJECT_BACKGROUND_DEFAULT_STRENGTH));
    strengthStoredRef.current = row.backgroundStrength;
    setStrengthSeeded(row.slug);
  }, [row, strengthSeeded]);

  /**
   * Stores the strength, on release rather than on every pixel of travel.
   *
   * ★ `next` IS TAKEN FROM THE EVENT, NOT FROM `strength`. The reader can release
   *   the thumb before a re-render has caught up with the last `change`, so the
   *   state variable is one render behind the control that was let go of. Reading
   *   the number off the input is reading what the reader actually left it at.
   *
   * ★ THE ROW THAT COMES BACK IS THE SERVER'S, AND THE CONTROL TAKES ITS NUMBER
   *   FROM IT. `next` is what was *asked* for; `updated.backgroundStrength` is
   *   what was *stored*. Seeding from the response is what keeps the page from
   *   showing a number the database does not hold — the same reason the form
   *   above calls `setSaved(next)` with the returned row rather than with its own
   *   request body.
   *
   * ★ 409 IS A REAL ANSWER HERE AND IT IS SHOWN. The server refuses a strength
   *   with no picture to strengthen, and this control is rendered only while a
   *   picture is held — so reaching that refusal means the row changed underneath
   *   (removed in another tab, or the registry is stale). Printing the server's
   *   sentence is better than a client-side silence that would leave the slider
   *   showing a setting nothing accepted.
   */
  const commitStrength = async (next: number) => {
    if (!row) return;
    if (next === strengthStoredRef.current || next === strengthPendingRef.current) return;

    const seq = strengthSeqRef.current + 1;
    strengthSeqRef.current = seq;
    strengthPendingRef.current = next;

    setStrengthBusy(true);
    setStrengthProblem(null);
    try {
      const updated = await updateProject(row.slug, { backgroundStrength: next });
      if (seq !== strengthSeqRef.current) return;
      strengthStoredRef.current = updated.backgroundStrength;
      setStrength(
        clampBackgroundStrength(updated.backgroundStrength ?? PROJECT_BACKGROUND_DEFAULT_STRENGTH),
      );
      reloadRegistry();
    } catch (err: unknown) {
      if (seq !== strengthSeqRef.current) return;
      setStrengthProblem(err instanceof Error ? err.message : String(err));
    } finally {
      // ★ ONLY THE NEWEST WRITE CLEARS THE FLAG. A superseded response finishing
      //   later must not report "not working" while the write that replaced it is
      //   still in flight — the same counting that guards the state above.
      if (seq === strengthSeqRef.current) {
        strengthPendingRef.current = null;
        setStrengthBusy(false);
      }
    }
  };

  /**
   * ★ THE CONFIRMATION OPENS WITH FOCUS ON CANCEL.
   *   Without this, focus stays on the button that opened the confirmation, so a
   *   reader pressing Enter again — or a keyboard repeating a keystroke — deletes
   *   the project on the second press and never reads the question. The safe
   *   control takes the focus and the destructive one has to be reached for.
   */
  useEffect(() => {
    if (confirming) cancelDeleteRef.current?.focus();
  }, [confirming]);

  const trimmedName = name.trim();
  const trimmedDesc = description.trim();
  const nextLevel = level.trim();

  const nameError =
    trimmedName === ''
      ? 'A project needs a name. It is what every screen calls the row, and it is what the key in the URL was derived from.'
      : trimmedName.length > 200
        ? 'A name is capped at 200 characters.'
        : null;
  const levelError =
    nextLevel !== '' && !/^[0-9]{4}$/.test(nextLevel)
      ? `A level is exactly four digits — ${nextLevel.length} typed so far.`
      : null;

  /**
   * A level another project holds.
   *
   * The picker removes these from its list, so the only way to reach this is to
   * type four digits by hand — which is allowed, because a code the extract has
   * never seen must be typeable. The server refuses it with a sentence naming the
   * holder; this is the same refusal said before the round trip, because a form
   * that can predict a refusal should not spend a save finding out.
   */
  const holder = useMemo(() => {
    if (!/^[0-9]{4}$/.test(nextLevel)) return null;
    return registry.find((r) => r.slug !== slug && (r.levelCode ?? '').trim() === nextLevel) ?? null;
  }, [registry, nextLevel, slug]);

  /**
   * The extract's own entry for the typed level — the whole basis of the preview.
   *
   * Found by level and nothing else, because level is the key the ledger uses. A
   * `Project` here is not a project record; it is what the extract adds up to on
   * that level, whether or not anybody has claimed it.
   */
  const anchor = useMemo(
    () => (nextLevel.length === 4 ? (projects.find((p) => p.level === nextLevel) ?? null) : null),
    [projects, nextLevel],
  );

  /**
   * The levels spoken for, minus this project's own.
   *
   * A project always still holds the level it holds, so leaving its own claim in
   * would hide the value the field is already showing. A plain `delete` is enough
   * because the server enforces one holder per level — the set cannot contain the
   * level twice, and it cannot belong to anybody else. If that rule ever weakened,
   * this line would quietly release a level that was not this project's, so the
   * comment is the guard.
   */
  const takenForEdit = useMemo(() => {
    const held = (row?.levelCode ?? '').trim();
    if (!held) return takenLevels;
    const next = new Set(takenLevels);
    next.delete(held);
    return next;
  }, [takenLevels, row?.levelCode]);

  const heldLevel = (row?.levelCode ?? '').trim();
  const levelChanged = row !== null && nextLevel !== heldLevel;
  const nameChanged = row !== null && trimmedName !== row.name;
  const noteChanged = row !== null && trimmedDesc !== (row.description ?? '').trim();
  const dirty = nameChanged || noteChanged || levelChanged;

  const canSave = row !== null && dirty && !busy && !nameError && !levelError && !holder;

  /** `field--bad` and `aria-invalid` follow the error, not a blur. There is no
   * blur to wait for on a combobox whose value is complete at four digits. */
  const nameBad = touchedName && nameError !== null;
  const levelBad = levelError !== null || holder !== null;

  /**
   * The number the slider shows, and whether the stored one is past its end.
   *
   * ★ THE READOUT SAYS THE STORED NUMBER AND NOT THE STORED NUMBER-CLAMPED, WHEN
   *   THE TWO DIFFER. `strengthShown` is what the control can express; if the row
   *   holds a larger value, the panel adds a sentence naming it rather than
   *   letting a 45 stand for a 60. A control that silently reports a smaller number
   *   than the database holds is the same class of lie as a count that omits a
   *   page — see the note on `clampBackgroundStrength`.
   */
  const strengthShown = clampBackgroundStrength(strength);
  const strengthOverCeiling =
    row !== null && row.backgroundStrength !== null && row.backgroundStrength > strengthShown;

  /**
   * ★ THE STRENGTH IS NOT IN `dirty` AND IS NOT IN `canSave`, DELIBERATELY.
   *   It has no Save button because it needs none: the write happens on release,
   *   which is the moment the reader finished choosing. Folding it into the form
   *   would mean a slider that appeared to need saving, a Save button that lit up
   *   for a change already stored, and a reader who drags the slider and walks away
   *   believing they saved when the value was never sent. The form above is name,
   *   note and level; this control is one number and it is its own submit.
   */

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouchedName(true);
    if (!row || !canSave) return;

    const body: ProjectUpdate = {};
    if (nameChanged) body.name = trimmedName;
    if (noteChanged) body.description = trimmedDesc === '' ? null : trimmedDesc;
    if (levelChanged) {
      if (nextLevel === '') {
        // `null`, not `''`: releasing is a clearing, and the server clears the
        // display code with the level it was derived from.
        body.levelCode = null;
      } else {
        body.levelCode = nextLevel;
        // ★ THE CODE NAMES THE LEVEL AND NOTHING ELSE, SO IT IS DERIVED HERE.
        //   It used to be read off the extract's largest object code and stored as
        //   `CC-<level>-<object>`, which put one of the level's accounts into a
        //   field every screen reads as the level's own name — and `0450` then
        //   looked like a claim on `527` alone. A level is four digits, so there
        //   is nothing to look up: writing the level's code also replaces any
        //   `-<object>` suffix an earlier save left on the row.
        body.code = `CC-${nextLevel}`;
      }
    }

    if (Object.keys(body).length === 0) return;

    setBusy(true);
    setProblem(null);
    setSaved(null);
    try {
      const next = await updateProject(row.slug, body);
      // Re-read rather than patch locally: the row that comes back is the server's,
      // and a local guess is what makes a table disagree with its own database.
      reloadRegistry();
      setSaved(next);
    } catch (err: unknown) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Stores a chosen picture.
   *
   * ★ THE INPUT IS CLEARED BEFORE THE `await`, AND THAT IS NOT HOUSEKEEPING. A
   *   file input does not fire `change` when the reader picks the same file a
   *   second time. So without this, retrying the very file that failed the first
   *   time — the one case where retrying is the obvious next move — does nothing
   *   at all, silently.
   */
  const onPickBackground = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0] ?? null;
    input.value = '';
    if (!file || !row) return;

    setBgBusy(true);
    setBgProblem(null);
    setBgNotice(null);
    try {
      const upload = await readProjectBackgroundFile(file);
      await uploadProjectBackground(row.slug, upload);
      reloadRegistry();
      // ★ THIS RE-READ IS FOR THE REPLACE CASE ONLY, AND SAYING SO IS THE POINT.
      //   On a *first* upload the registry carry above flips `hasBackground`
      //   false→true, the hook's `expected` input changes and the effect re-runs
      //   by itself — so this call adds nothing there. On a *replace* the flag
      //   stays true, nothing the effect depends on has changed, and without this
      //   the reader would be looking at the picture they just overwrote. One
      //   call covering the case the other cannot is not redundancy.
      reloadBackground();
      setBgNotice(
        `${upload.name} was stored. It is drawn behind this project\u2019s header at the strength set below.`,
      );
    } catch (err: unknown) {
      setBgProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBgBusy(false);
    }
  };

  /**
   * Removes a picture.
   *
   * ★ NO CONFIRMATION, AND THAT IS A DELIBERATE DIFFERENCE FROM THE DELETE. The
   *   picture is replaceable by picking the file again, so the cost of a mistaken
   *   click is one re-upload rather than a lost record — and a second ask on a
   *   reversible act is how a reader learns to click through second asks.
   */
  const onClearBackground = async () => {
    if (!row) return;
    setBgBusy(true);
    setBgProblem(null);
    setBgNotice(null);
    try {
      await clearProjectBackground(row.slug);
      reloadRegistry();
      reloadBackground();
      setBgNotice(
        'The picture was removed. The header is back to the plain surface, and the strength setting ' +
          'went with the picture — a picture chosen later starts from the app\u2019s default.',
      );
    } catch (err: unknown) {
      setBgProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBgBusy(false);
    }
  };

  const edit =
    (fn: (v: string) => void) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      setSaved(null);
      fn(e.target.value);
    };

  /**
   * Delete, on the second ask.
   *
   * ★ THE ROW IS READ BEFORE THE RE-READ, BECAUSE THE RE-READ IS WHAT REMOVES IT.
   *   `reloadRegistry()` refetches the registry, so on the next render `registry`
   *   no longer holds this project and `row` is null. Taking the name and the level
   *   out of `row` *after* that would capture nothing, and the failure would show
   *   up as a success panel printing `undefined` — which reads as a data problem
   *   rather than as a variable read one render too late.
   *
   * ★ ON FAILURE THE CONFIRMATION CLOSES. A refused delete (503 when the target
   *   refuses writes) leaves the reader with the sentence saying why; keeping the
   *   red button armed underneath it would suggest the attempt is still running.
   *
   * ★ NO NAVIGATION. The page reports its own outcome instead of returning to the
   *   list and leaving the reader to infer what happened from a row that is no
   *   longer there. The row that is gone is named, the level that was freed is
   *   named, and the way back to the list is a link — which is the same shape as
   *   every other conclusion this app draws, and it keeps the fact that a *specific*
   *   project was deleted attached to the evidence that it was.
   */
  const onDelete = async () => {
    if (!row || deleting) return;

    // Captured first: after the reload this is the only record of what went.
    const gone = { slug: row.slug, name: row.name, level: (row.levelCode ?? '').trim() };

    setDeleting(true);
    setDeleteProblem(null);
    setSaved(null);
    try {
      await deleteProject(gone.slug);
      setDeleted(gone);
      reloadRegistry();
    } catch (err: unknown) {
      setDeleteProblem(err instanceof Error ? err.message : String(err));
      setConfirming(false);
    } finally {
      setDeleting(false);
    }
  };

  const crumbs = (
    <nav className="crumbs" aria-label="Breadcrumb">
      <Link to="/projects">Projects</Link>
      <span aria-hidden="true">›</span>
      <span aria-current="page">Edit project</span>
    </nav>
  );

  // ── Guards ────────────────────────────────────────────────────────────────
  // Each one answers the question the reader is about to ask, in the order they
  // would ask it: the extract, then the registry, then the row.

  if (status === 'error') {
    return (
      <div className="stack">
        <div>
          <div className="accent-rule" />
          {crumbs}
        </div>
        <ErrorNotice error={error ?? 'The extract could not be read.'} reload={reload} />
        <p className="chart-note">
          Editing needs the extract twice over: once to offer the levels, and once to show the
          budgets a level already carries. Without it this page could only rename a row, and it
          would have to say nothing about the level — which is the half that matters.
        </p>
      </div>
    );
  }

  if (status === 'loading') {
    return (
      <div className="stack">
        <div>
          <div className="accent-rule" />
          {crumbs}
        </div>
        <p className="chart-note" role="status">
          Reading the purchase-order extract…
        </p>
      </div>
    );
  }

  if (registryError) {
    return (
      <div className="stack">
        <div>
          <div className="accent-rule" />
          {crumbs}
        </div>
        <ErrorNotice
          error={registryError}
          reload={reloadRegistry}
          heading="The project registry could not be read."
          hint={
            <p>
              The extract loaded, but the app&rsquo;s own <code>project</code> table did not — and
              that table is the only place a project&rsquo;s name, note and level live. There is
              nothing to edit without it.
            </p>
          }
        />
      </div>
    );
  }

  // An empty registry with no error means the first read is still in flight. It
  // cannot mean "no projects": the table is seeded, so a genuinely empty one comes
  // back from a server that would have said so.
  if (registry.length === 0) {
    return (
      <div className="stack">
        <div>
          <div className="accent-rule" />
          {crumbs}
        </div>
        <p className="chart-note" role="status">
          Reading the project registry…
        </p>
      </div>
    );
  }

  // ★ BEFORE THE `!row` GUARD, AND AFTER THE REGISTRY-ERROR ONE.
  //   After `!row`, because a successful delete is precisely the case where `row`
  //   has just stopped existing — the two guards are the same condition with
  //   opposite explanations, and the success panel has to win. Before the
  //   registry-error guard would be wrong the other way: if the re-read after the
  //   delete failed, this panel's "the list has been re-read" would be a claim the
  //   page cannot support, and the failure to read the registry is the more urgent
  //   fact. It also has to come before the empty-registry guard, so deleting the
  //   last project cannot land on "Reading the project registry…" forever.
  if (deleted) {
    return (
      <div className="stack">
        <div>
          <div className="accent-rule" />
          {crumbs}
        </div>
        <div className="panel">
          <div className="panel__head">
            <div>
              <h2 className="panel__title">Project deleted</h2>
              <p className="panel__sub">
                {deleted.level === '' ? (
                  <>
                    <strong>{deleted.name}</strong> is no longer recorded in this app.
                  </>
                ) : (
                  <>
                    <strong>{deleted.name}</strong> is no longer recorded in this app, and level{' '}
                    <code>{deleted.level}</code> is free again.
                  </>
                )}
              </p>
            </div>
            <span className="panel__count">{deleted.slug}</span>
          </div>
          <div className="panel__body">
            <p className="chart-note">
              The row is gone from the app&rsquo;s own <code>project</code> table, and the projects
              list has been re-read so the table behind this page agrees with it.
            </p>
            <p className="chart-note">
              {deleted.level === '' ? (
                <>
                  A project with no account level never appeared as a row in the level table — it
                  was only ever in &ldquo;Recorded, not yet coded&rdquo; — so the list is where the
                  change is visible.
                </>
              ) : (
                <>
                  Level <code>{deleted.level}</code> is no longer claimed by anything, so the
                  level table shows it as an unclaimed level again, named from its own
                  purchase-order lines where those lines name anything at all. Any project can be
                  associated with it now, and nothing on it was touched to make that true.
                </>
              )}
            </p>
            <p className="chart-note">
              <strong>Oracle was not written to.</strong> Every order, line, budget and amount on
              the level is exactly where it was — a project is a name the app puts on a level, not
              a record the ledger holds, which is why deleting one changes no figure anywhere.
              Nothing was archived either: restoring this project means recording it again.
            </p>
            <p>
              <Link className="btn btn--system btn--sm" to="/projects">
                Back to projects
              </Link>
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!row) {
    return (
      <div className="stack">
        <div>
          <div className="accent-rule" />
          {crumbs}
        </div>
        <div className="panel">
          <div className="panel__head">
            <h2 className="panel__title">No project with that key</h2>
            <span className="panel__count">{slug}</span>
          </div>
          <div className="panel__body">
            <p className="chart-note">
              The registry holds {pluralise(registry.length, 'project')} and none of them is{' '}
              <code>{slug}</code>. The key is derived from the name when a project is recorded, so a
              link that has outlived a name change lands here rather than on somebody else&rsquo;s
              row.
            </p>
            <p>
              <Link className="btn btn--system btn--sm" to="/projects">
                Back to projects
              </Link>
            </p>
          </div>
        </div>
      </div>
    );
  }

  // ── The form ──────────────────────────────────────────────────────────────

  /**
   * ★ ONE COLUMN, BECAUSE THE RIGHT-HAND COLUMN IS GONE.
   *
   *   This page was a `.np-grid`: the form on the left and an `<aside>` of three
   *   explainer cards on the right — the row as stored, what Save writes, and
   *   what it leaves alone. They were removed at the reader's request, and
   *   narrowing this element with them is the part that is easy to miss: left as
   *   a grid, the form would keep the *first* track of a two-column layout and
   *   every field would sit in 1.5fr of the page with an empty column beside it.
   *
   *   `np-grid` stays in the stylesheet because `NewProject` still uses it.
   */

  const levelLabelId = `edit-level-label-${row.slug}`;
  const levelHintId = `edit-level-hint-${row.slug}`;

  return (
    <div className="stack">
      <div>
        <div className="accent-rule" />
        {crumbs}
        <div className="page-head">
          <div>
            <h1>Edit project</h1>
            <p className="page-head__sub">
              The name, the note and the account level. This is the app&rsquo;s own record — the
              level decides which ledger rows the project gathers, and nothing here writes to
              Oracle.
            </p>
          </div>
          <div className="page-head__actions">
            {dirty ? (
              <Chip variant="warn">Unsaved changes</Chip>
            ) : (
              <Chip variant="ok">No changes</Chip>
            )}
            <Link to="/projects" className="btn btn--system">
              Cancel
            </Link>
            <button
              type="submit"
              form="edit-project"
              className="btn btn--primary"
              disabled={!canSave}
              aria-describedby={canSave ? undefined : 'edit-blocked'}
            >
              {busy ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>

      {problem ? (
        <div className="notice notice--err" role="alert">
          <p>
            <strong>The change was not saved.</strong>
          </p>
          <p>{problem}</p>
        </div>
      ) : null}

      {saved ? (
        <div className="notice notice--info" role="status">
          <p>
            <strong>Saved.</strong> The server returned{' '}
            {saved.levelCode ? (
              <>
                <code>{`CC-${saved.levelCode}`}</code> on level <code>{saved.levelCode}</code>
                {saved.code && saved.code !== `CC-${saved.levelCode}` ? (
                  <>
                    {' '}
                    — stored as <code>{saved.code}</code>, the old rule&rsquo;s form, which the next
                    save of this row replaces
                  </>
                ) : null}
              </>
            ) : (
              <>a project with no level</>
            )}
            , and the projects list has been re-read.
          </p>
          <p>
            <Link to="/projects">See the row in the level table</Link>
          </p>
        </div>
      ) : null}

      <form id="edit-project" className="stack" onSubmit={onSubmit} noValidate>
        <section className="panel">
          <div className="panel__head">
            <h2 className="panel__title">The project</h2>
            <span className="panel__sub">
              Name and note are the app&rsquo;s words for this row. The level is Oracle&rsquo;s.
            </span>
          </div>
          <div className="panel__body">
            <div className={`field${nameBad ? ' field--bad' : ''}`}>
              <label className="field__label" htmlFor="project-name">
                Name <span className="field__req">required</span>
              </label>
              <input
                id="project-name"
                className="input"
                type="text"
                value={name}
                onChange={edit(setName)}
                onBlur={() => setTouchedName(true)}
                maxLength={200}
                autoComplete="off"
                aria-invalid={nameBad || undefined}
                aria-describedby="project-name-hint"
              />
              <p className="field__hint" id="project-name-hint">
                Changing the name does not change the key in the URL — <code>{row.slug}</code> is
                already derived and already linked to from the projects list, so renaming here
                relabels the row rather than moving it.
              </p>
              {nameError && touchedName ? (
                <p className="field__err" role="alert">
                  {nameError}
                </p>
              ) : null}
            </div>

            <div className="field">
              <label className="field__label" htmlFor="project-description">
                Description
              </label>
              <textarea
                id="project-description"
                className="textarea"
                rows={4}
                value={description}
                onChange={edit(setDescription)}
                maxLength={4000}
                aria-describedby="project-description-hint"
              />
              <p className="field__hint" id="project-description-hint">
                What the project is, in a sentence somebody who has never seen the account codes can
                read. Clearing it removes the note rather than storing a blank one.
              </p>
            </div>

            <div className={`field${levelBad ? ' field--bad' : ''}`}>
              <span className="field__label" id={levelLabelId}>
                Account level{' '}
                <span className="field__req">
                  {heldLevel === '' ? 'none set' : 'four digits'}
                </span>
              </span>

              <LevelPicker
                levels={projects}
                value={level}
                onChange={(v) => {
                  setSaved(null);
                  setLevel(v);
                }}
                takenLevels={takenForEdit}
                invalid={levelBad}
                labelledBy={levelLabelId}
                describedBy={levelHintId}
              />

              <p className="field__hint" id={levelHintId}>
                The 4-digit <code>SEGMENT5</code> this project is funded by. It is the only key the
                ledger carries, which is why a project is named after one: level{' '}
                <code>0454</code> is the same project whether its money lands on object{' '}
                <code>527</code> or <code>529</code>. Leaving it empty is allowed and means this
                project holds no cost centre.
              </p>

              {levelError ? (
                <p className="field__err" role="alert">
                  {levelError}
                </p>
              ) : null}

              {holder ? (
                <p className="field__err" role="alert">
                  Level <code>{nextLevel}</code> is already held by <strong>{holder.name}</strong>. A
                  level funds one project at a time, so saving this would be refused —{' '}
                  <Link to={`/projects/${holder.slug}/edit`}>open that project</Link> and release the
                  level first, or leave the level here as it is.
                </p>
              ) : null}
            </div>

            <div className="field">
              <span className="field__label">
                Budgets on this level{' '}
                <span className="field__req">
                  {nextLevel.length === 4 ? 'from the extract' : 'none yet'}
                </span>
              </span>
              <LevelBudgets level={nextLevel === '' ? null : nextLevel} anchor={anchor} />
            </div>
          </div>
        </section>

        <p className="chart-note" id="edit-blocked">
          {nameError && touchedName
            ? nameError
            : levelError
              ? levelError
              : holder
                ? `Level ${nextLevel} is held by “${holder.name}”, so Save is not offered until it is released.`
                : !dirty
                  ? 'Nothing has changed yet. Save is enabled once a field differs from what the server holds.'
                  : busy
                    ? 'Saving…'
                    : 'Save writes only the fields that changed, then re-reads the registry so every table behind this page agrees with it.'}
        </p>
      </form>

      {/*
        ★ THE PICTURE IS ITS OWN PANEL, OUTSIDE THE FORM, FOR THE SAME REASON THE
          DANGER ZONE IS.

          It is not a field of the PATCH: the fields are text that the server can
          merge into the row as a partial update, and the picture is bytes that
          replace a whole column. Inside `<form>` this control would also be one
          omitted `type="button"` away from submitting the form beside it, which
          is a defect nobody would see until a reader lost a name they had typed.

        ★ THE FILE INPUT IS THE ONE CONTROL AND IT IS `display:none`. "Choose a
          file" is the button, the button is what a keyboard reaches and what a
          screen reader reads out, and the input's own rendering (a native
          filename box that cannot be styled to match anything else on the page)
          is not worth the inconsistency. It stays in the DOM rather than being
          created on demand so that its `change` handler is the one React bound.

        ★ A READER WHO CAN SEE THE PICTURE IS A READER WHO CAN JUDGE IT. The
          preview is drawn at full opacity, not at the strength the header is set
          to — its job is to show which file is stored, and a preview that imitated
          the header's wash would be a preview of nothing. The strength slider below
          changes the header, so a preview that followed it would also make the
          control look like a filter applied to this image rather than to the page.
      */}
      <section className="panel" aria-labelledby="edit-background-title">
        <div className="panel__head">
          <div>
            <h2 className="panel__title" id="edit-background-title">
              Background image
            </h2>
            <p className="panel__sub">
              Drawn behind this project&rsquo;s header so it is recognisable at a glance, at a
              strength you choose. It is part of the app&rsquo;s own <code>project</code> row —
              Oracle holds no image and is not written to either way.
            </p>
          </div>
          <span className="panel__count">IMAGE</span>
        </div>

        <div className="panel__body bgfield">
          {bgProblem ? (
            <p className="field__err" role="alert">
              <strong>Nothing was stored.</strong> {bgProblem}
            </p>
          ) : null}
          {bgNotice ? (
            <p className="chart-note" role="status">
              {bgNotice}
            </p>
          ) : null}

          {background.status === 'ready' ? (
            <figure className="bgfield__figure">
              <img
                className="bgfield__preview"
                src={background.image.url}
                alt={`The picture stored against ${row.name}`}
              />
              <figcaption className="bgfield__facts">
                <b>{background.image.name ?? 'picture'}</b> ·{' '}
                <b>{num(background.image.bytes)}</b> bytes ·{' '}
                {background.image.updatedAt ? (
                  <>stored {background.image.updatedAt}</>
                ) : (
                  <>stored</>
                )}
              </figcaption>
            </figure>
          ) : background.status === 'error' ? (
            <p className="field__err" role="alert">
              {/* ★ A FAILURE TO DRAW IS NOT A FAILURE TO STORE. The row still says a
                  picture is held and the remove control stays available, because
                  "the bytes would not load" and "there is nothing there" are two
                  different answers and only one of them can be fixed by removing. */}
              <strong>The picture is stored but could not be read.</strong>{' '}
              {background.message}
            </p>
          ) : row.hasBackground ? (
            <p className="bgfield__none" role="status">
              Reading the stored picture&hellip;
            </p>
          ) : (
            <p className="bgfield__none">
              No picture is stored against this project. The header shows the plain surface, which
              is a perfectly good answer — nothing here is required.
            </p>
          )}

          <div className="bgfield__row">
            <button
              type="button"
              className="btn btn--system btn--sm"
              onClick={() => bgFileRef.current?.click()}
              disabled={bgBusy}
            >
              {bgBusy
                ? 'Working…'
                : row.hasBackground
                  ? 'Replace the picture'
                  : 'Choose a picture'}
            </button>
            {row.hasBackground ? (
              <button
                type="button"
                className="btn btn--danger btn--sm"
                onClick={onClearBackground}
                disabled={bgBusy}
              >
                Remove the picture
              </button>
            ) : null}
            <input
              ref={bgFileRef}
              type="file"
              className="bgfield__file"
              accept={PROJECT_BACKGROUND_TYPES.join(',')}
              onChange={onPickBackground}
            />
          </div>

          {/*
            ★ THE STRENGTH CONTROL EXISTS ONLY WHILE A PICTURE IS HELD, AND THE
              SERVER AGREES. A strength with nothing to strengthen is a number no
              screen can show, and `PATCH` refuses it 409 — so rendering the slider
              on a project with no picture would be offering a control whose every
              use is an error. It appears with the picture and goes with it.

            ★ IT IS A SIBLING OF `.bgfield__row`, NOT A CHILD, AND THAT IS A LAYOUT
              DECISION. `.bgfield__row` is a flex row of buttons at their natural
              width; a range input stretched into it would take whatever the two
              buttons left and be a different width on a project whose picture is
              held than on one whose picture is not. `.bgfield` is already the grid
              that owns this panel's rhythm, so a full-width row of its own is the
              shape that needs no new spacing rules.

            ★ THE RELEASE EVENTS ARE THREE BECAUSE THE READER'S THREE WAYS IN ARE
              THREE. A mouse or touch drag ends at `pointerup`; arrow keys fire
              `keyup`; and a value typed or a control left by Tab ends at the
              input's `blur`, which is also what catches a drag that ended
              somewhere the pointer events did not report. All three call the same
              function, and the identical-value guard inside it makes the overlap
              free — a `keyup` immediately after a `blur` for the same number
              spends nothing.
          */}
          {row.hasBackground ? (
            <div className="bgstrength">
              <div className="bgstrength__head">
                <label className="bgstrength__label" htmlFor="edit-background-strength">
                  Picture strength
                </label>
                <output className="bgstrength__value" htmlFor="edit-background-strength">
                  {strengthShown}%
                </output>
              </div>
              <input
                id="edit-background-strength"
                className="bgstrength__range"
                type="range"
                min={0}
                max={PROJECT_BACKGROUND_MAX_STRENGTH}
                /*
                  ★ `step` IS 1 SO THE DEFAULT IS REACHABLE. The app draws an
                    unchosen picture at 33%, and a step of 5 cannot express 33 —
                    the thumb would sit at a number the scale does not contain and
                    the first arrow key would jump to 35, moving the control
                    without the reader having asked. One step per percent also
                    makes the keyboard exact, which matters more here than the
                    coarser stops a 0–100 slider might want.
                */
                step={1}
                value={strengthShown}
                onChange={(e) => setStrength(Number(e.target.value))}
                onPointerUp={(e) => void commitStrength(Number(e.currentTarget.value))}
                onKeyUp={(e) => void commitStrength(Number(e.currentTarget.value))}
                onBlur={(e) => void commitStrength(Number(e.currentTarget.value))}
                disabled={strengthBusy}
                aria-describedby="edit-background-strength-note"
              />
              {strengthProblem ? (
                <p className="field__err" role="alert">
                  <strong>The strength was not changed.</strong> {strengthProblem}
                </p>
              ) : null}
              {strengthOverCeiling ? (
                <p className="chart-note">
                  This project holds a strength of <b>{row.backgroundStrength}%</b>, which is past
                  the end of this slider — its header draws the strongest setting the slider can
                  reach, and the stored number is left as it was set rather than quietly rewritten.
                </p>
              ) : null}
              <p className="bgstrength__note" id="edit-background-strength-note">
                How much of the picture is allowed to show through. <b>It saves as you let go</b>
                — the Save button above is for the name and the level, and this is a write of its
                own, so there is nothing to submit here. The pale wash over the picture thickens
                as the strength rises, which is what keeps the header&rsquo;s text legible at every
                setting; the slider therefore stops at {
                  PROJECT_BACKGROUND_MAX_STRENGTH
                }%, the strongest the text survives. A header in the dark theme draws less of it
                than a light one, by the same rule. At <b>0%</b> the picture is held and deliberately not
                drawn — which is a choice, and is not the same as having no picture.
              </p>
            </div>
          ) : null}

          <p className="chart-note">
            <strong>{listProjectBackgroundTypes()}</strong>, up to{' '}
            <b>{num(PROJECT_BACKGROUND_MAX_BYTES / 1024)} KB</b> each. The type is checked twice —
            here, so a 12 MB photo is refused before it crosses the wire, and again on the server,
            which reads the file&rsquo;s own bytes rather than trusting what the browser called it.
            There is no SVG in the list: an SVG is a document that can carry script, and this one
            would be script served from this app&rsquo;s own origin.
          </p>
          <p className="chart-note">
            A picture is stored as the bytes that were chosen, never re-encoded, so what the header
            draws is the file that was picked. Downscale it first if it is large: even at the
            strongest setting the wash thins it, and detail that survives the wash is detail nothing
            in this app reads. It appears on the project&rsquo;s page the next time that page is
            opened — the strength control above is what decides how much of it you see there, and a
            busy or bright image reads as texture at a low setting and as a photograph at a high one.
          </p>
        </div>
      </section>

      {/*
        ★ THE DANGER ZONE, OUTSIDE THE FORM AND LAST ON THE PAGE.

          Outside the form for the same reason the level picker's footer is: this
          control has nothing to do with Save, and inside `<form>` a `type="button"`
          that has to be written defensively is a control one edit away from
          submitting the form beside it. Last, because a destructive act placed
          above the save button is a destructive act read before the form it lives
          under — and because a reader who scrolled past everything else has read
          the page by then.

        ★ THE COPY LEADS WITH WHAT IS REMOVED AND WHAT IS NOT. "Delete" is the
          request; the panel's job is to say exactly how far it reaches, because
          the honest answer here is unusual — a project *is* a row in this app and
          is *not* anything at all in the ledger, so a delete removes the record
          and leaves every dollar.

        ★ `.notice` IS A ROW FLEX (`display:flex; gap:8px` with no `flex-direction`),
          so the whole body of each notice is wrapped in one `.del__confirm` child —
          a second bare child would become a second column with an 8px gap beside
          it. The wrapper also carries the internal spacing.
      */}
      <section className="panel" aria-labelledby="edit-delete-title">
        <div className="panel__head">
          <div>
            <h2 className="panel__title" id="edit-delete-title">
              Delete this project
            </h2>
            <p className="panel__sub">
              Removes the app&rsquo;s own record. Oracle is not written to either way.
            </p>
          </div>
          <span className="panel__count">DELETE</span>
        </div>

        <div className="panel__body del">
          <p className="del__lead">
            <strong>{row.name}</strong> is one row in the app&rsquo;s own <code>project</code>{' '}
            table — a name, a note, an owner and{' '}
            {heldLevel === '' ? (
              <>no account level.</>
            ) : (
              <>
                the account level <code>{heldLevel}</code>.
              </>
            )}{' '}
            Deleting removes them:
          </p>

          <ul className="del__list">
            <li>
              {heldLevel === '' ? (
                <>
                  The row leaves the &ldquo;Recorded, not yet coded&rdquo; list on the projects
                  screen, which was the only place it appeared — a project with no level is not a
                  row in the level table, because that table is keyed by level.
                </>
              ) : (
                <>
                  Level <code>{heldLevel}</code> stops being claimed. It goes back to being an
                  unclaimed level read from its own purchase-order lines, and any project can be
                  associated with it again — including a project recorded later.
                </>
              )}
            </li>
            <li>
              <strong>Nothing in Oracle changes.</strong> Every order, line and amount on the level
              was already there and stays theirs; a project is a name the app puts on them.
            </li>
            <li>
              <strong>Nothing is archived.</strong> The row is not kept anywhere, so restoring this
              project means recording it again from the beginning. Releasing the level instead —
              clearing the account level field above and saving — keeps the name, the note and the
              owner.
            </li>
          </ul>

          {deleteProblem ? (
            <div className="notice notice--err" role="alert">
              <div className="del__confirm">
                <p>
                  <strong>The project was not deleted.</strong>
                </p>
                <p>{deleteProblem}</p>
              </div>
            </div>
          ) : null}

          {confirming ? (
            <div className="notice notice--err">
              <div className="del__confirm">
                <p>
                  <strong>Delete &ldquo;{row.name}&rdquo;?</strong>
                </p>
                <p>
                  {heldLevel === '' ? (
                    <>The row disappears from the app. </>
                  ) : (
                    <>
                      Level <code>{heldLevel}</code> becomes free and goes back to being an
                      unclaimed level.{' '}
                    </>
                  )}
                  Nothing in Oracle changes, and nothing here is kept.
                </p>
                <div className="del__actions">
                  <button
                    type="button"
                    ref={cancelDeleteRef}
                    className="btn btn--system btn--sm"
                    onClick={() => setConfirming(false)}
                    disabled={deleting}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn--danger btn--sm"
                    onClick={onDelete}
                    disabled={deleting}
                  >
                    {deleting ? 'Deleting…' : 'Delete permanently'}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="del__go">
              <button
                type="button"
                className="btn btn--danger"
                onClick={() => {
                  setDeleteProblem(null);
                  setConfirming(true);
                }}
              >
                Delete this project
              </button>
              <span className="del__hint">
                It asks once more before it does anything, because this cannot be undone.
              </span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
