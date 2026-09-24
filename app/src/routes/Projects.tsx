import { Link } from 'react-router-dom';
import { FACETS, FACET_LABEL, useStore } from '../state/store';
import ProjectTable from '../components/ProjectTable';
import ErrorNotice from '../components/ErrorNotice';
import { ScopeRemoved } from '../components/ScopeNote';
import { addedToday } from '../data/projectMeta';
import { num } from '../data/format';

export default function Projects() {
  const {
    status,
    error,
    reload,
    facet,
    setFacet,
    facetCounts,
    query,
    setQuery,
    searched,
    visible,
    lines,
    registry,
    uncodedShown,
  } = useStore();

  const named = facetCounts.named;
  const unclaimed = searched.length - named;

  /**
   * The same instant `ProjectTable` measures its badges against, and the same rule —
   * `addedToday` from `data/projectMeta`. Two lists on one page cannot disagree about
   * what "new" means if there is only one function that decides it.
   */
  const now = new Date();

  return (
    <div className="stack">
      <div>
        <div className="accent-rule" />
        <div className="page-head">
          <div>
            <h1>Projects</h1>
          </div>
          <div className="page-head__actions">
            {/* Navigation, not an action — so it is a link styled as a button, and the
                plus is decoration rather than part of the name. */}
            <Link className="btn btn--primary" to="/projects/new">
              <span aria-hidden="true">+</span> New Project
            </Link>
          </div>
        </div>
      </div>

      {status === 'error' && error ? <ErrorNotice error={error} reload={reload} /> : null}

      {/* Renders nothing unless the scope in the TopBar actually removed lines — on this extract it
          never does, which is exactly why the note must not appear. A permanent "0 removed" banner
          is what teaches a reader to stop reading the one place the number is not zero. */}
      <ScopeRemoved />

      <section className="panel">
        <div className="panel__head">
          <div>
            <h2 className="panel__title">All levels</h2>
            <p className="panel__sub">
              {query
                ? `Matching “${query}” across projects and the purchase-order lines beneath them — ${num(unclaimed)} with no project record.`
                : `${num(unclaimed)} of ${num(searched.length)} levels have no project record in the app.`}
            </p>
          </div>
          <span className="panel__count">{num(visible.length)} shown</span>
        </div>

        <div className="filterbar" role="group" aria-label="Filter projects">
          {FACETS.map((f) => (
            <button
              key={f}
              type="button"
              className="fchip"
              aria-pressed={facet === f}
              onClick={() => setFacet(f)}
            >
              {FACET_LABEL[f]}
              <span className="n">{num(facetCounts[f])}</span>
            </button>
          ))}

          {query ? (
            <button
              type="button"
              className="fchip"
              onClick={() => setQuery('')}
              title="Clear the search filter"
            >
              Clear “{query}”
            </button>
          ) : null}
        </div>

        <div className="panel__body">
          <ProjectTable />
        </div>

        {status === 'ready' && visible.length > 0 ? (
          <p className="chart-note" style={{ padding: '0 16px 12px' }}>
            Capital, operating and relocation are the three <code>PURPOSE_</code> values in the
            extract — they are budget groups, not cost codes. The percentages under each figure are
            that slice of the level&rsquo;s own committed value; the figure under Committed is the
            level&rsquo;s modelled approved budget — the app&rsquo;s placeholder, not Oracle&rsquo;s.
            A project&rsquo;s own panel measures usage against Oracle&rsquo;s WCPSS budget instead.{' '}
            {num(lines.length)} purchase-order lines in scope.
          </p>
        ) : null}
      </section>

      {/*
        A second list, not a second set of rows in the first one. These projects are
        recorded in the app's own master but carry no Oracle account level, so they
        have no level code, no purchase-order lines and no money: every column in the
        table above would be empty for them, and their zeroes would dilute the totals
        that table prints. Keeping them apart is what lets the table keep saying "one
        row per Oracle account level" and stay true.

        They are shown rather than withheld because "recorded but not yet placed" is
        a real state of the work, announced to the user when the rows were added. A
        project that exists in the master and appears nowhere is the one outcome that
        is unambiguously a defect — the reader cannot tell it from a project that was
        never entered at all.
      */}
      {status === 'ready' && uncodedShown.length > 0 ? (
        <section className="panel">
          <div className="panel__head">
            <div>
              <h2 className="panel__title">Recorded, not yet coded</h2>
              <p className="panel__sub">
                {query
                  ? `Recorded projects matching “${query}” that have no Oracle account level, so they cannot appear in the table above.`
                  : `${num(uncodedShown.length)} of ${num(registry.length)} recorded projects have no Oracle account level yet, so they cannot appear in the table above.`}{' '}
                Give one a level and it moves into the table.
              </p>
            </div>
            <span className="panel__count">{num(uncodedShown.length)} shown</span>
          </div>
          <div className="panel__body">
            <ul className="unplaced">
              {uncodedShown.map((r) => (
                <li key={r.slug} className="unplaced__row">
                  <span className="unplaced__name">{r.name}</span>
                  {/*
                    ★ THE MARK BELONGS HERE MOST OF ALL. A project recorded today that
                      nobody has coded yet exists ONLY in this list — it has no level, so
                      it cannot be a row in the table above. Putting the mark on the
                      table alone would mean the newest project in the app was the one
                      place the mark never appeared.

                    A flex item, not something nested inside the name: `.unplaced__row`
                    is already `display:flex` with a gap, so it takes its own column and
                    `margin-left:auto` still pins the slug to the right. The gap is also
                    why `.newmark` carries no margin of its own — here the container
                    spaces it, in the table a plain space does. `flex: none` on the class
                    is what stops that gap squeezing the circle to nothing.

                    Same `role="img"` + `aria-label` as the table: a dot has no text,
                    and a list of uncoded projects is exactly where a reader who cannot
                    see it would otherwise have no way to know which ones are recent.
                  */}
                  {addedToday(r, now) ? (
                    <span
                      className="newmark"
                      role="img"
                      aria-label="New project"
                      title="Recorded in this app today"
                    />
                  ) : null}
                  <span className="unplaced__meta">
                    <span className="unplaced__flag">No account level</span>
                    {r.description ? <span>{r.description}</span> : null}
                    {r.site ? <span>Site: {r.site}</span> : null}
                    {r.owner ? <span>Owner: {r.owner}</span> : null}
                  </span>
                  <code className="unplaced__slug">{r.slug}</code>
                  {/* ★ THE ONLY WAY TO REACH AN UNCODED PROJECT. A project with no
                      level cannot appear as a row in the level table above — that
                      table is keyed by level — so the drawer, which opens from those
                      rows, can never be reached for it. This link is the whole of
                      the route in: the name and note are corrected here, and the
                      four digits that move the row into the table are typed on the
                      page it opens. */}
                  <Link className="btn btn--system btn--sm" to={`/projects/${r.slug}/edit`}>
                    Edit
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}
    </div>
  );
}
