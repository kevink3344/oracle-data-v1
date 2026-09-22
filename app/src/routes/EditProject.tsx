import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useStore } from '../state/store';
import {
  deleteProject,
  updateProject,
  type ProjectUpdate,
  type RegistryRow,
} from '../data/projectMeta';
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

      <form id="edit-project" className="np-grid" onSubmit={onSubmit} noValidate>
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

        <aside className="np-side" aria-label="What editing a project does">
          <section className="panel">
            <div className="panel__head">
              <h2 className="panel__title">This row</h2>
              <span className="panel__count">{row.slug}</span>
            </div>
            <div className="panel__body">
              <dl className="bind__facts">
                <div>
                  <dt>Name</dt>
                  <dd>{row.name}</dd>
                </div>
                <div>
                  <dt>Level</dt>
                  <dd>
                    {heldLevel === '' ? <em>none</em> : <code>{heldLevel}</code>}
                  </dd>
                </div>
                <div>
                  <dt>Code (stored)</dt>
                  <dd>{row.code ? <code>{row.code}</code> : <em>not set</em>}</dd>
                </div>
                <div>
                  <dt>Recorded</dt>
                  <dd>{row.createdAt ?? '—'}</dd>
                </div>
                <div>
                  <dt>Last written</dt>
                  <dd>{row.updatedAt ?? '—'}</dd>
                </div>
              </dl>
              <p className="chart-note">
                The row as the server has it, not as the form has it. Saving re-reads this panel, so
                it always shows what was stored. The display code is the level&rsquo;s —{' '}
                <code>CC-0450</code> — and any <code>-527</code> suffix still on a row is the old
                rule&rsquo;s, cleared the next time that row is saved.
              </p>
            </div>
          </section>

          <section className="panel">
            <div className="panel__head">
              <h2 className="panel__title">What Save does</h2>
              <span className="panel__count">PATCH</span>
            </div>
            <div className="panel__body">
              <p className="chart-note">
                Writes the name, the note and the level to the app&rsquo;s own{' '}
                <code>project</code> table. Only the fields that changed are sent, so a save that
                touches the level cannot disturb the owner, and a save that touches the name cannot
                disturb the level.
              </p>
              <p className="chart-note">
                Releasing is <code>levelCode: null</code> and it is not a delete: the row keeps its
                name and its note and goes back into the recorded queue. Emptying the level field
                does exactly that.
              </p>
            </div>
          </section>

          <section className="panel">
            <div className="panel__head">
              <h2 className="panel__title">What it leaves out</h2>
              <span className="panel__count">Oracle</span>
            </div>
            <div className="panel__body">
              <p className="chart-note">
                Nothing in the ledger changes. Every line, order and amount on the level was already
                there and stays theirs — the project is a name the app puts on them.
              </p>
              <p className="chart-note">
                The display code is derived from the level and nothing else, and is never typed:
                level <code>0454</code> is named <code>CC-0454</code>. It used to carry the object
                code holding most of the level&rsquo;s money, which made one account look like the
                whole project — the accounts a level owns are listed on its detail panel instead,
                and every one of them counts towards the level.
              </p>
            </div>
          </section>
        </aside>

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
