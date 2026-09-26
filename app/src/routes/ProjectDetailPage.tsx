import { useCallback, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useStore } from '../state/store';
import PinButton from '../components/PinButton';
import ProjectDetail, { exportProjectCsv } from '../components/ProjectDetail';
import { Chip, PurposeChip, StatusChip, type ChipVariant } from '../components/Chip';
import { printElement } from '../lib/printPanel';
import { money0, num, pluralise, share } from '../data/format';
import { scopeLabel } from '../data/scope';
import LineageView from '../components/lineage/LineageView';

/**
 * One project, as a page.
 *
 * ★★ THIS REPLACES A SLIDING PANEL, AT THE USER'S REQUEST: *"Clicking on a Project should open the
 *    details, but instead of a sliding panel it should go to a page."* The content is unchanged —
 *    it is `ProjectDetail`, extracted from the drawer's body — so what changed is the frame:
 *
 *      · the URL carries the project (`/projects/0450`), so it can be shared, bookmarked and
 *        reached with Back;
 *      · the rail and the topbar stay usable, because a page is not modal;
 *      · there is no focus trap and no Escape handler, for the same reason.
 *
 * ★ THE LEVEL IS THE KEY, AND IT IS THE ONLY ONE THAT WORKS. A project in this app is a *level* —
 *   `SEGMENT5`, the thing a project is named after — and the level is what the projects table is
 *   keyed by. The registry slug is a different identity: it exists only for the ~10 levels somebody
 *   has recorded, while this page has to open on all 139, because most of what it shows is about
 *   the extract rather than the registry.
 *
 * ★ A LEVEL WITH NO PROJECT IS NOT A 404, AND THAT IS DELIBERATE. 129 of the 139 levels in the
 *   sample belong to no recorded project. Their rows are still clickable — the table offers every
 *   level — so a 404 here would turn an ordinary click into an error page. What the reader gets
 *   instead is the page with an unheld cost-centre section, which is the truth.
 */
export default function ProjectDetailPage() {
  const { level = '' } = useParams<{ level: string }>();
  const { projects, lines, constants, scopeStats, status, error: storeError, reload } = useStore();
  const [searchParams] = useSearchParams();
  const graphView = searchParams.get('view') === 'brain';

  const project = useMemo(
    () => projects.find((p) => p.level === level) ?? null,
    [projects, level],
  );

  const bodyRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  /**
   * The export, which is the same two the panel had.
   *
   * ★ THE PDF PRINTS THE PAGE'S OWN BODY, NOT A CLONE OF A PANEL. `printElement` takes the element
   *   and lays it out for paper; the drawer passed its `<aside>`, and this passes the content
   *   column. The scope line names the level because a printed page has no URL to say which
   *   project it is about.
   */
  const exportPdf = useCallback(() => {
    const el = bodyRef.current;
    if (!el || !project) return;
    printElement(el, {
      title: `${project.name} — project ${project.code}`,
      scope: `Project ${project.code} · level ${project.level} · ${project.site}`,
      orientation: 'portrait',
    });
  }, [project]);

  const copyLink = useCallback(() => {
    void navigator.clipboard?.writeText(window.location.href).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      },
      () => setCopied(false),
    );
  }, []);

  // The extract is still loading. The store reports its own status, so this is a state
  // rather than an error — the same distinction the Dashboard makes.
  if (status === 'loading') {
    return (
      <div className="stack">
        <div className="page-head">
          <div>
            <h1 className="page-head__title">Project</h1>
            <p className="page-head__sub">Reading the Oracle extract…</p>
          </div>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="stack">
        <div className="page-head">
          <div>
            <h1 className="page-head__title">Project</h1>
          </div>
        </div>
        <div className="notice notice--err">
          <p>
            <strong>The extract could not be read, so this project cannot be shown.</strong>{' '}
            {storeError}
          </p>
          <div className="bind__actions">
            <button type="button" className="btn btn--system btn--sm" onClick={reload}>
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }

  /**
   * ★ THE LEVEL IS NOT IN THE EXTRACT, AND THAT IS A DIFFERENT ANSWER FROM "NOT FOUND".
   *
   *   A level can exist in the chart of accounts and carry no purchase-order lines inside the
   *   current scope — the scope is a control, so a reader who narrows to one program can make a
   *   project's own rows disappear. Saying "no such project" there would be false: the project
   *   exists, it is the *view* that has nothing. So the page says which it is and offers the way
   *   back, rather than 404ing on a level the reader just clicked.
   */
  if (!project) {
    return (
      <div className="stack">
        <div className="page-head">
          <div>
            <h1 className="page-head__title">Level {level}</h1>
            <p className="page-head__sub">
              No purchase-order lines in the current scope
            </p>
          </div>
        </div>
        <div className="notice notice--info">
          <p>
            <strong>Level {level} carries no PO lines under the current scope.</strong>{' '}
            {scopeLabel({ fund: constants.FUND ?? '', programs: [] }, [])} The level can still exist
            in the chart of accounts — the scope is a control, so narrowing it removes rows from
            this view without removing the account. Widen the scope, or go back to the project list.
          </p>
          <div className="bind__actions">
            <Link className="btn btn--ghost btn--sm" to="/projects">
              All projects
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const p = project;
  const top = [...p.buckets].sort((a, b) => b.committed - a.committed)[0];
  const concentration = top ? share(top.committed, p.committed) : 0;
  const composition = top
    ? concentration >= 0.995
      ? `All ${top.meta.short.toLowerCase()}`
      : `Mostly ${top.meta.short.toLowerCase()}`
    : 'No committed value';

  return (
    <div className="stack projpage">
      {/* ★ THE BACK LINK IS A REAL LINK, NOT A HISTORY CALL. A reader who arrived from a shared
          URL has no history to pop, and `navigate(-1)` would send them off the site. */}
      <nav className="projpage__back" aria-label="Breadcrumb">
        <Link to="/projects" className="linkish">
          ‹ All projects
        </Link>
      </nav>

      <div className="page-head">
        <div className="projpage__id">
          <div className="drawer__eyebrow">
            {p.code} · {pluralise(p.accounts.length, 'account')}
          </div>
          <h1 className="page-head__title">{p.name}</h1>
          <div className="drawer__meta">
            {p.site}
            <br />
            <b>{num(p.lines)}</b> lines · <b>{num(p.orders)}</b> orders · <b>{num(p.vendors)}</b>{' '}
            vendors · <b>{num(p.buckets.reduce((s, b) => s + b.costCodes.length, 0))}</b> cost codes
            <br />
            {p.first && p.last ? (
              <>
                Orders <b>{p.first}</b> to <b>{p.last}</b> ·{' '}
              </>
            ) : null}
            {p.owner ? <>owner {p.owner}</> : <em>unassigned</em>}
          </div>
          <div className="drawer__chips">
            <StatusChip status={p.status} quietDays={p.quietDays} />
            <Chip variant={(top?.meta.chip ?? 'neu') as ChipVariant} dot>
              {composition}
            </Chip>
            {p.buckets.map((b) => (
              <PurposeChip
                key={b.purpose}
                purpose={b.purpose}
                title={`${b.meta.label} — ${money0(b.committed)} committed`}
              />
            ))}
            {/* ★ WAS A LITERAL: `Fund 04 · 0840`, titled "FUND and COST_CENTER are single-valued
                across the extract". Both halves of that were statements about one dataset, in a
                component that had no way to check either — so under a scope that admitted another
                fund, the chip would still have read `04` and still have claimed it was
                single-valued. It now reads whatever the store measured, and disappears rather than
                guessing if the segments are not fixed. */}
            {constants.FUND || constants.COST_CENTER ? (
              <Chip
                variant="neu"
                title={
                  `FUND and COST_CENTER hold one value across all ${num(scopeStats.shown)} PO lines ` +
                  `in the current scope${scopeStats.excluded === 0 ? ', which is the whole extract' : ''}.`
                }
              >
                Fund {constants.FUND ?? '—'} · {constants.COST_CENTER ?? '—'}
              </Chip>
            ) : null}
          </div>
        </div>

        <div className="projpage__actions">
          <Link
            className="btn btn--ghost btn--sm"
            to={graphView ? `/projects/${encodeURIComponent(p.level)}` : '?view=brain'}
          >
            {graphView ? 'Project details' : 'Project network'}
          </Link>
          <PinButton
            category="project"
            entityKey={p.level}
            title={p.name}
            subtitle={`${p.code} · ${p.site}`}
            href={`/projects/${encodeURIComponent(p.level)}`}
          />
          <button type="button" className="btn btn--ghost btn--sm" onClick={copyLink}>
            {copied ? 'Link copied' : 'Copy link'}
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => exportProjectCsv(p)}
          >
            Export CSV
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={exportPdf}
            title="Prints this page as it looks — the usage bar, the cost-code spine and the derived findings, none of which the CSV carries"
          >
            Export to PDF
          </button>
        </div>
      </div>

      <div className="projpage__body" ref={bodyRef}>
        {graphView ? <LineageView project={p} lines={lines} mode="brain" /> : <ProjectDetail project={p} />}
      </div>
    </div>
  );
}
