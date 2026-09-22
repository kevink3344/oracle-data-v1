import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../state/store';
import { updateProject, type RegistryRow } from '../data/projectMeta';

/**
 * What the app says about the cost centre a project holds, and the control that
 * lets it go.
 *
 * ★ THE CONTROL THAT SETS A LEVEL IS ON THE EDIT PAGE, NOT HERE.
 *   Setting a level is not a separate act from naming a project — it is the same
 *   write to the same row, and treating it as its own mode produced a button
 *   reading "Bind a cost centre" beside projects that already had a name, a note
 *   and an owner. Recording, naming and coding are now one form: `EditProject`,
 *   reached from the `Edit` link on every project row and in the panel below. That
 *   page is also the only place a level can be *changed*, which the old control
 *   could never do — it could only fill an empty one.
 *
 * ★ RELEASE STAYS HERE, AND THAT IS NOT AN OVERSIGHT.
 *   Release is the one action whose subject is a level rather than a name, and the
 *   only rows that hold a level are the ones the level table can show — so it
 *   belongs on the panel that opens from that table, right underneath the level it
 *   acts on. Duplicating it on the edit page would put two controls for one
 *   irreversible-looking act at different distances from their subject.
 *
 * ★ A RELEASE IS A WRITE, AND THIS FILE KEEPS SAYING SO.
 *   Nothing is written back to Oracle here. A reader who thinks `Release` edits
 *   the ledger would be badly wrong about the only destructive-looking button in
 *   the product.
 */

/**
 * The state the release control needs: busy, the refusal if there was one, and
 * the registry re-read after a success.
 *
 * ★ THE REFUSAL IS SHOWN IN THE SERVER'S OWN WORDS. Every rejection this API
 *   produces is a sentence — "Level 0454 is already held by …" — and it is the
 *   only place that value appears. Replacing it with "Something went wrong"
 *   would throw away the one thing the reader can act on.
 */
function useWrite() {
  const { reloadRegistry } = useStore();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setProblem(null);
    try {
      await fn();
      reloadRegistry();
      return true;
    } catch (err: unknown) {
      setProblem(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return { busy, problem, run };
}

/**
 * Releases the level a project holds, on the project's own detail panel.
 *
 * The panel is addressed by level — `?project=0454` — so the row that holds the
 * level is found from the registry, and after a release there is no such row.
 * That is why the caller passes what it found and this component never looks it
 * up: the panel keeps its own record of the project it is showing, and the
 * section below says what the level is now rather than vanishing.
 */
export function CostCentreRelease({
  row,
  onDone,
}: {
  row: RegistryRow;
  onDone: (message: string) => void;
}) {
  const { busy, problem, run } = useWrite();

  const release = async () => {
    // `levelCode: null` is a release, not a delete — the row stays, with no
    // level. The API makes the same distinction; this is the only caller of it.
    const ok = await run(() => updateProject(row.slug, { levelCode: null }));
    if (ok) {
      onDone(
        `Level ${row.levelCode} released. “${row.name}” is recorded with no cost centre and now appears under “Recorded, not yet coded” on the projects list, where its Edit page can give it a level again.`,
      );
    }
  };

  return (
    <>
      <dl className="bind__facts">
        <div>
          <dt>Project</dt>
          <dd>{row.name}</dd>
        </div>
        <div>
          <dt>Level</dt>
          <dd>
            <code>{row.levelCode}</code>
          </dd>
        </div>
        <div>
          <dt>Code</dt>
          <dd>{row.code ? <code>{row.code}</code> : <em>not set</em>}</dd>
        </div>
        <div>
          <dt>Recorded</dt>
          <dd>{row.createdAt ?? '—'}</dd>
        </div>
      </dl>

      <p className="watch__d">
        This level is bound to the project above. Releasing removes the binding and leaves the
        project recorded without one — the row is not deleted, and nothing in Oracle changes:
        the extract still carries every line, every order and every amount on this level.
      </p>

      {problem ? (
        <p className="field__err" role="alert">
          {problem}
        </p>
      ) : null}

      {/* `btn--system`, not a danger variant. Releasing deletes nothing and the
          API can put the level straight back, so styling it as destructive would
          be the styling telling a bigger lie than the copy does. */}
      <button type="button" className="btn btn--system btn--sm" disabled={busy} onClick={release}>
        {busy ? 'Releasing…' : `Release level ${row.levelCode}`}
      </button>
    </>
  );
}

/**
 * What the cost-centre section says when no project holds the level on screen.
 *
 * Not an error and not an empty state: 129 of the extract's 139 levels are in
 * exactly this position, and so is a level that has just been released. The
 * sentence says what would have to exist for the control to be here, and links to
 * the one page that creates it.
 */
export function CostCentreUnheld({ level }: { level: string }) {
  return (
    <p className="watch__d">
      No project in this app holds level <code>{level}</code>. A level is set on a project, never on
      its own — <Link to="/projects/new">record the project</Link> first, then open it with{' '}
      <strong>Edit</strong> and type this level in.
    </p>
  );
}
