import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../state/store';
import { Chip } from '../components/Chip';
import { createProject, type RegistryRow } from '../data/projectMeta';
import { currentOwner } from '../data/session';

/**
 * New project — the record, not the coding.
 *
 * ★ A PROJECT IS NOT A COST CENTRE, AND THIS PAGE IS WHERE THAT IS ENFORCED.
 *   This form used to require a cost centre, which made "create" mean "bind a
 *   level" and left the two level-less rows in the seed table looking like rows
 *   somebody had made a mistake with. They were not. They are what a project
 *   looks like before it is coded, and that is now the ordinary result of this
 *   page rather than an edge case.
 *
 *   The Project table holds a name, a description and an owner. A cost centre is
 *   a *later* edit, made from the project's own panel once somebody knows which
 *   level the job is really funded by. Requiring the choice here put the binding
 *   before the project existed — and it meant the form could not express the
 *   case where nobody has decided yet, which is most of the time a job is first
 *   recorded.
 *
 * ★ TWO FIELDS AND A NAME YOU DO NOT TYPE. The owner is the signed-in user, so
 *   it is shown and not asked for. **The server can resolve a real identity and
 *   this form still does not require one** — `POST /api/auth/sign-in`,
 *   `GET /api/auth/session` and the `x-app-session` header all exist and the
 *   sign-in screen has landed, but no project route requires a session, so the
 *   owner still travels from the client. `data/session.ts` is the one place that
 *   supplies it, and it is deliberately *not* an error for it to be nobody: the
 *   form records the name it is given and the field says so. What changed when
 *   sign-in landed is only that the name can now be a real one.
 *
 * ★ THIS PAGE SAVES. `POST /api/projects` writes the row and hands it back read
 *   from the database, and both the confirmation and every refusal are rendered
 *   in the server's own words — each refusal is a sentence written for a person
 *   to act on, and paraphrasing one here would throw that away.
 *
 * ★ AND IT DOES NOT READ THE EXTRACT. The picker used to make this page wait on
 *   the funding lines; nothing on the form now depends on them, so the loading
 *   state is gone with it.
 */

export default function NewProject() {
  const { reloadRegistry } = useStore();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [touched, setTouched] = useState({ name: false, description: false });
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<RegistryRow | null>(null);

  const owner = currentOwner();

  const nameError = name.trim() ? null : 'A project needs a name. Include the school and the scope.';
  const descriptionError = description.trim()
    ? null
    : 'A description is required, not optional — it is the field the next reader has.';
  const ownerError = owner ? null : 'The session has not been read yet, so there is no owner to record.';
  const ready = !nameError && !descriptionError && !ownerError;

  /**
   * What Create project is still waiting for. The button is `disabled` while
   * anything is missing, so the form can never be submitted to reveal the reason —
   * the note below has to say it up front, and `aria-describedby` needs an element
   * that exists.
   */
  const missing = [
    nameError ? 'a name' : null,
    descriptionError ? 'a description' : null,
    ownerError ? 'a signed-in user' : null,
  ].filter((part): part is string => part !== null);

  const show = (wasTouched: boolean, message: string | null): string | null =>
    message && (wasTouched || attempted) ? message : null;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    if (!ready || !owner) return;
    setBusy(true);
    setProblem(null);
    try {
      const row = await createProject({
        name: name.trim(),
        description: description.trim(),
        owner,
      });
      setRecorded(row);
      // ★ The registry is re-read, never patched locally. The list on /projects is
      //   what this record will be judged against, and a row spliced into the
      //   client's copy would be the client's idea of what was written rather than
      //   the database's answer.
      reloadRegistry();
    } catch (err: unknown) {
      setProblem(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (recorded) {
    return (
      <Recorded
        row={recorded}
        onAnother={() => {
          setRecorded(null);
          setName('');
          setDescription('');
          setTouched({ name: false, description: false });
          setAttempted(false);
        }}
      />
    );
  }

  return (
    <div className="stack">
      <div>
        <div className="accent-rule" />
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link to="/projects">Projects</Link>
          <span aria-hidden="true">›</span>
          <span aria-current="page">New project</span>
        </nav>
        <div className="page-head">
          <div>
            <h1>New project</h1>
            <p className="page-head__sub">
              A name, a description and an owner. No cost centre — a project is recorded first and
              coded afterwards.
            </p>
          </div>
          <div className="page-head__actions">
            <Chip variant="warn">Draft · unsaved</Chip>
            <Link to="/projects" className="btn btn--system">
              Cancel
            </Link>
            <button
              type="submit"
              form="new-project"
              className="btn btn--primary"
              disabled={!ready || busy}
              aria-describedby={ready ? undefined : 'create-blocked'}
            >
              {busy ? 'Recording…' : 'Create project'}
            </button>
          </div>
        </div>
      </div>

      {problem ? (
        <div className="notice notice--err" role="alert">
          <p>
            <strong>The project was not recorded.</strong>
          </p>
          <p>{problem}</p>
        </div>
      ) : null}

      <form id="new-project" className="np-grid" onSubmit={onSubmit} noValidate>
        <section className="panel">
          <div className="panel__head">
            <h2 className="panel__title">The project</h2>
            <span className="panel__sub">
              Three of the Project table&rsquo;s fields. The cost centre is not one of them here.
            </span>
          </div>
          <div className="panel__body">
            <div className={`field${show(touched.name, nameError) ? ' field--bad' : ''}`}>
              <label className="field__label" htmlFor="project-name">
                Project name <span className="field__req">required</span>
              </label>
              <input
                id="project-name"
                className="input"
                type="text"
                value={name}
                autoComplete="off"
                aria-invalid={show(touched.name, nameError) ? true : undefined}
                aria-describedby="project-name-hint"
                placeholder="e.g. Swift Creek ES – Roof replacement"
                onChange={(e) => setName(e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, name: true }))}
              />
              <p className="field__hint" id="project-name-hint">
                Name the site and the scope. The key that identifies the project is derived from
                this name, so a name that already exists is refused rather than merged — and a
                project under the same Oracle level can still be a different project, because
                projects under one level differ by what they buy.
              </p>
              {show(touched.name, nameError) ? <p className="field__err">{nameError}</p> : null}
            </div>

            <div
              className={`field${show(touched.description, descriptionError) ? ' field--bad' : ''}`}
            >
              <label className="field__label" htmlFor="project-description">
                Description <span className="field__req">required</span>
              </label>
              <textarea
                id="project-description"
                className="textarea"
                rows={4}
                value={description}
                aria-invalid={show(touched.description, descriptionError) ? true : undefined}
                aria-describedby="project-description-hint"
                placeholder="What the money is being spent on, and what stage it is at."
                onChange={(e) => setDescription(e.target.value)}
                onBlur={() => setTouched((t) => ({ ...t, description: true }))}
              />
              <p className="field__hint" id="project-description-hint">
                Staff-maintained. Oracle&rsquo;s own description text stays on the PO lines and is
                never overwritten.
              </p>
              {show(touched.description, descriptionError) ? (
                <p className="field__err">{descriptionError}</p>
              ) : null}
            </div>

            <div className={`field${show(attempted, ownerError) ? ' field--bad' : ''}`}>
              <span className="field__label" id="project-owner-label">
                Owner
              </span>
              {/* Not an input, and not disabled — a disabled input implies a value
                  that could be edited if the page were in a different state. This
                  one is read from the session and cannot be typed at all. */}
              <p className="field__value" aria-labelledby="project-owner-label">
                {owner ? <strong>{owner}</strong> : <em>Nobody is signed in</em>}
              </p>
              <p className="field__hint" id="project-owner-hint">
                The signed-in user, taken from the session rather than typed. There is now a sign-in
                screen at <code>/sign-in</code> and <code>data/session.ts</code> reads a real
                identity from <code>GET /api/auth/session</code> — but <b>this page still does not
                require one</b>, and no project route does: a project may be recorded by anybody
                looking at the app, and the name recorded is whatever the browser is holding.
              </p>
              {show(attempted, ownerError) ? <p className="field__err">{ownerError}</p> : null}
            </div>
          </div>
        </section>

        <aside className="np-side" aria-label="What recording a project does">
          <section className="panel">
            <div className="panel__head">
              <h2 className="panel__title">What this records</h2>
            </div>
            <div className="panel__body">
              <p className="chart-note">
                One row in the app&rsquo;s own <code>project</code> table: the name, the description
                and the owner. The key in the URL is derived from the name on the server, so staff
                still never type an identifier.
              </p>
              <p className="chart-note">
                Oracle is not written to. The extract is read-only and stays exactly as it is.
              </p>
            </div>
          </section>

          <section className="panel">
            <div className="panel__head">
              <h2 className="panel__title">What it leaves out</h2>
              <span className="panel__count">no cost centre</span>
            </div>
            <div className="panel__body">
              <p className="chart-note">
                Recording a project does not bind it to an account level, and there is deliberately
                no field for one on this form. A project is a job. A cost centre is the account
                combination the job&rsquo;s money is booked to, and the two are decided at
                different times — often by different people.
              </p>
              <p className="chart-note">
                So a project recorded here carries no level and no code. It appears under{' '}
                <strong>Recorded, not yet coded</strong> on the projects list, and stays there
                until somebody binds a cost centre to it from the list itself.
              </p>
            </div>
          </section>

          <section className="panel">
            <div className="panel__head">
              <h2 className="panel__title">Binding, later</h2>
            </div>
            <div className="panel__body">
              <p className="chart-note">
                Binding chooses an account level, not a whole combination. Levels another project
                already holds are not offered at all — one level funds one project at a time — and
                the display code <code>CC-&#123;level&#125;</code> is derived from the level alone,
                never typed. Every account the level owns comes with it.
              </p>
            </div>
          </section>
        </aside>

        {!ready ? (
          <p className="chart-note" id="create-blocked">
            Create project is disabled until {missing.join(' and ')}{' '}
            {missing.length === 1 ? 'is' : 'are'} present. Nothing else on this form is required,
            because nothing else is decided yet.
          </p>
        ) : (
          <p className="chart-note">
            Create project writes the row to the app&rsquo;s own database. No cost centre is bound,
            no code is derived, and no Oracle data changes — the project appears under{' '}
            <strong>Recorded, not yet coded</strong> on the projects list.
          </p>
        )}
      </form>
    </div>
  );
}

/**
 * The confirmation, and the only place the app tells a person what it wrote.
 *
 * ★ IT SHOWS THE ROW, NOT THE FORM. Every value here was read back out of the
 *   database by the endpoint — the slug included, which the server derived and the
 *   client never sent. Echoing the form would have been a screenshot of the
 *   request; this is the stored answer, and the two differ in exactly the ways
 *   that matter (the key, and the timestamps).
 *
 * ★ IT SAYS WHAT IS STILL MISSING FROM THE PROJECT. "Created" on its own invites
 *   the reader to assume the job is now coded. It is not, and the panel says which
 *   two things are empty and where they get filled in.
 */
function Recorded({ row, onAnother }: { row: RegistryRow; onAnother: () => void }) {
  return (
    <div className="stack">
      <div>
        <div className="accent-rule" />
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link to="/projects">Projects</Link>
          <span aria-hidden="true">›</span>
          <span aria-current="page">New project</span>
        </nav>
        <div className="page-head">
          <div>
            <h1>Project recorded</h1>
            <p className="page-head__sub">
              Written to the app&rsquo;s own database and read back from it. No cost centre is bound
              yet.
            </p>
          </div>
          <div className="page-head__actions">
            <button type="button" className="btn btn--system" onClick={onAnother}>
              Record another
            </button>
            <Link to="/projects" className="btn btn--primary">
              Back to projects
            </Link>
          </div>
        </div>
      </div>

      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">{row.name}</h2>
          <span className="panel__count">recorded</span>
        </div>
        <div className="panel__body">
          <dl className="bind__facts">
            <div>
              <dt>Key</dt>
              <dd>
                <code>{row.slug}</code>
              </dd>
            </div>
            <div>
              <dt>Owner</dt>
              <dd>{row.owner ?? <em>none</em>}</dd>
            </div>
            <div>
              <dt>Level</dt>
              <dd>
                <em>not bound</em>
              </dd>
            </div>
            <div>
              <dt>Code</dt>
              <dd>
                <em>not derived</em>
              </dd>
            </div>
            <div>
              <dt>Recorded</dt>
              <dd>{row.createdAt ?? '—'}</dd>
            </div>
          </dl>

          <p className="subhead">Description</p>
          <p className="chart-note">{row.description ?? <em>No description was stored.</em>}</p>

          <div className="notice notice--info">
            <p>
              <strong>This project has no cost centre.</strong> It appears under{' '}
              <strong>Recorded, not yet coded</strong> on the projects list, with no Oracle level
              and no project code, until a level is bound to it from that list.
            </p>
            <p>
              Binding picks a level that no other project holds and derives the code from the level
              and the object. Releasing it again returns the project to this state: a release keeps
              the row — the name, the note and the owner stay — and Oracle is not touched either
              way. Deleting the project is a separate act on its edit page, and it is the only one
              of the two that removes the record itself.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
