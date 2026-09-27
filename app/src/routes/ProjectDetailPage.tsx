import { useCallback, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useStore } from '../state/store';
import PinButton from '../components/PinButton';
import ProjectDetail, { exportProjectCsv } from '../components/ProjectDetail';
import { Chip, PurposeChip, StatusChip, type ChipVariant } from '../components/Chip';
import { printElement } from '../lib/printPanel';
import { money0, num, pluralise, share } from '../data/format';
import { scopeLabel } from '../data/scope';
import { useProjectBackground } from '../data/projectBackground';
import { backgroundDraw, PROJECT_BACKGROUND_DEFAULT_STRENGTH } from '../data/projectMeta';
import LineageView from '../components/lineage/LineageView';

/**
 * ── ★ THE PENCIL IS DRAWN, NOT TYPED, FOR THE REASON THE PIN IS ──────────────
 * `✎` / `✏` render as a colour glyph on some platforms and a monochrome box on
 * others, so they cannot follow `currentColor` into either theme — and this
 * control's whole feedback on hover *is* a colour change. Drawn the same way as
 * `PushPin` in `PinButton.tsx`: a 16-unit viewBox, `currentColor`, a 1.5 stroke
 * and round caps and joins, so the two icons in the row carry one weight.
 *
 * ★ THE NIB LINE IS NOT DECORATION. Without the segment where the shaft meets
 *   the tip, the outline is a slanted rectangle, which at 14px reads as a knife
 *   or a highlighter — that one line is the whole difference. The shape is one
 *   closed outline (back edge, both long sides, then the tip) plus that line,
 *   and it is drawn on the diagonal because that is the orientation every
 *   pencil icon in software uses.
 */
function PencilIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M10.5 3.3L12.7 5.5L6.7 11.5L4.2 11.8L4.5 9.3Z" />
      <path d="M4.5 9.3L6.7 11.5" />
    </svg>
  );
}

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
  const { projects, lines, constants, scopeStats, status, error: storeError, reload, registry } = useStore();
  const [searchParams] = useSearchParams();
  /**
   * ★★ THE VIEW IS A CLOSED SET OF FOUR, AND THE OLD TEST WAS A BOOLEAN.
   *
   * `searchParams.get('view') === 'brain'` answered one question — "is this the network?"
   * — and a boolean has no room for a fourth answer. Added naively, `?view=burst` would
   * have failed that test and rendered the DETAILS tab, so the one URL that asked for the
   * new view would have been the one that did not get it, and the tab would have looked
   * simply broken. A truthiness test on a route parameter is how a two-state view silently
   * swallows every state added after it, so the parameter is read once, here, into a union
   * that the render below matches exhaustively.
   *
   * ★ EACH NEW TOKEN GETS ITS OWN BRANCH RATHER THAN FOLDING INTO A `!==` GUARD. It is
   *   tempting to write `rawView === 'burst' || rawView === 'icicle' ? rawView : …`, which
   *   reads as one condition — but a route token that is not spelled out is a route token
   *   nobody can find by searching the file for it, and this union is the only place the
   *   page says which addresses exist.
   *
   * ★ `network` IS ACCEPTED AS AN ALIAS, AND `brain` IS STILL WHAT GETS WRITTEN.
   *   The segment is a leftover name for a view the reader now calls Network, so links that
   *   predate the rename have to keep working — but a link THIS PAGE GENERATES must emit
   *   one form only. Emitting the alias would give one view two canonical URLs, which is
   *   how a shared link and a bookmarked link end up as different histories with different
   *   Back behaviour.
   *
   * ★ THE SEGMENT IS A SNAPSHOT OF THE PATH, NOT A STORED PREFERENCE. Switching tabs is a
   *   navigation, so Back leaves the tab you were on — the same way the detail pages do it
   *   everywhere else in this app. Nothing is remembered, so a link to a project opens on
   *   Details for whoever receives it, which is what a reader expects from a shared link.
   */
  const rawView = searchParams.get('view');
  const view: 'details' | 'network' | 'burst' | 'icicle' =
    rawView === 'burst'
      ? 'burst'
      : rawView === 'icicle'
        ? 'icicle'
        : rawView === 'brain' || rawView === 'network'
          ? 'network'
          : 'details';
  const projectHref = `/projects/${encodeURIComponent(level)}`;

  const project = useMemo(
    () => projects.find((p) => p.level === level) ?? null,
    [projects, level],
  );

  /**
   * The picture stored against this project, which is a *second* identity and not a
   * contradiction of the note above.
   *
   * The level is what this page is keyed by, because all 139 levels have to open; the
   * registry row is an annotation that only about ten of them have, and a stored
   * picture belongs to the record rather than to the level. A level with no row has no
   * picture, which is the same answer as a row with no picture — and neither is a fault,
   * so neither is reported. The one case that *is* a fault is a row that says a picture
   * exists on a page that could not read the bytes; see `backgroundError` below.
   *
   * ★ THIS IS ABOVE THE THREE EARLY RETURNS ON PURPOSE, AND IT HAS TO BE. A hook called
   *   after `if (status === 'loading') return` would run on some renders and not others,
   *   which is the one thing React forbids. So the picture is fetched while the extract
   *   is still loading, and a render that takes one of the early branches simply never
   *   places it — the fetch is one request against a 640 KiB ceiling, not a cost worth
   *   holding a page back for.
   */
  const row = useMemo(() => registry.find((r) => r.levelCode === level) ?? null, [registry, level]);
  const { state: background } = useProjectBackground(row?.slug ?? null, row?.hasBackground ?? false);
  const backgroundImage = background.status === 'ready' ? background.image : null;
  /**
   * ★ AN ERROR HERE CAN ONLY MEAN THE PICTURE IS RECORDED AND DID NOT ARRIVE. The hook is
   *   gated on `hasBackground`, so it never fetches for a project without one — which is
   *   why this does not have to ask `hasBackground` a second time, and why the note below
   *   can say "the picture recorded against this project" rather than "the picture we
   *   hoped for". A header that silently draws nothing instead would make a broken picture
   *   indistinguishable from no picture, which is the defect this note exists to prevent.
   */
  const backgroundError = background.status === 'error' ? background.message : null;

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

  /**
   * ★ THE PICTURE AND THE WASH OVER IT ARE WORKED OUT IN ONE PLACE, AND IT IS NOT
   *   THIS COMPONENT.
   *
   *   A header's legibility turns on two opacities — the picture's own and the alpha
   *   of the surface-coloured wash drawn over it — and on a third number that is the
   *   only one any reader asked for: how much of the picture they actually see.
   *   `backgroundDraw` turns the strength the reader chose into the pair, and this
   *   page's whole part in the decision is passing that pair on as custom properties.
   *   The arithmetic and the reason it is not in the stylesheet are recorded on that
   *   function; what belongs here is which *number* it is fed.
   *
   * ★ IT IS FED THE ROW'S OWN STRENGTH, `null` INCLUDED, AND THE `null` IS ANSWERED
   *   WITH THE APPLICATION DEFAULT RATHER THAN WITH A THIRD VALUE. `null` means
   *   nobody moved the control; the default is what the header drew before the
   *   control existed. That distinction is preserved on the wire, where `null` stays
   *   `null` — it is only here, at the last layer that can see it, that the absence
   *   of a choice is resolved into a number, which is what a default is for.
   *
   * ★ A STORED VALUE PAST THE CEILING IS DRAWN AT THE CEILING, NOT AT ITSELF.
   *   `backgroundDraw` clamps, so a project holding 60 draws at 45 and the header is
   *   legible — but 60 is still what the row holds, and the edit page says so in
   *   words when it finds one. A number that is stored, drawn as a different number
   *   and reported as neither would be the worst of the three.
   */
  const headDraw = backgroundDraw(row?.backgroundStrength ?? PROJECT_BACKGROUND_DEFAULT_STRENGTH);

  return (
    <div className="stack projpage">
      {/* ★ THE BACK LINK IS A REAL LINK, NOT A HISTORY CALL. A reader who arrived from a shared
          URL has no history to pop, and `navigate(-1)` would send them off the site. */}
      <nav className="projpage__back" aria-label="Breadcrumb">
        <Link to="/projects" className="linkish">
          ‹ All projects
        </Link>
      </nav>

      {/* ★ THE PICTURE IS HANDED TO THE STYLESHEET AS CUSTOM PROPERTIES RATHER THAN SET
          HERE, AND THERE ARE THREE OF THEM NOW RATHER THAN ONE.

          `background-image`, its `cover` sizing, its focal point and the wash over it
          are one decision about legibility, so this element states the decision's
          *inputs* and nothing else: which picture, and the pair of opacities that
          picture is drawn with. The arithmetic that produced the pair lives in
          `backgroundDraw`, still in exactly one place — it moved out of
          `projectpage.css` only because the stylesheet has to be *told* the pair, for a
          reason recorded there.

          ★ SO THIS COMPONENT DOES NOT KNOW THE WASH'S ALPHA EITHER — it is handed one
            and passes it through. If it were replaced by a literal here, the contrast
            would be got wrong in a second place, which is the thing this arrangement
            exists to prevent.

          The base64 alphabet has no `"` and no `)`, so quoting the URL is sufficient and
          no escaping is needed. */}
      <div
        className={backgroundImage ? 'page-head page-head--image' : 'page-head'}
        style={
          backgroundImage
            ? ({
                '--proj-head-image': `url("${backgroundImage.url}")`,
                '--proj-head-op': String(headDraw.opacity),
                '--proj-head-wash': String(headDraw.wash),
              } as CSSProperties)
            : undefined
        }
      >
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
          {backgroundError ? (
            <p className="projpage__bgnote">
              <strong>The picture recorded against this project could not be drawn.</strong>{' '}
              {backgroundError}
            </p>
          ) : null}
        </div>

        <div className="projpage__actions">
          {/* ★ THE FLIP LINK THAT USED TO SIT HERE IS GONE, NOT DISABLED.

              It was a two-state toggle — "Project network" / "Project details" — and a
              toggle cannot express three views: whichever of the two it named on the Burst
              tab, it would have been lying about one of them. It was ALSO the control that
              looked like navigation but sat among the page's ACTIONS (copy, export, edit,
              pin), which is the wrong company for it: those four act on the project, this
              one changes what you are looking at.

              ★ THE REPLACEMENT IS A ROW OF ITS OWN, BETWEEN THE HEAD AND THE BODY — the
                user's instruction, and the reason is the row it left: `.projpage__actions`
                wraps, and a three-item tab strip spliced into it would reflow the four
                real actions onto a second line at narrower widths. Kept in the head, it
                would also have inherited the head's alignment. A dedicated row sits on
                the seam between the page's identity and its content, which is where a
                view switcher belongs. */}
          {/* ★ EDIT, TO THE LEFT OF THE PIN, RATHER THAN BELOW THE COST-CODE SPINE.

              It used to live in this page's cost-centre section as "Edit project",
              about 2,000px down, under the usage bar, the four budget blocks and the
              spine. The user's report was that this screen therefore had no way to
              reach it: *"Next to the 'Pin' we need an 'Edit' icon so the person can
              edit a project. There is no way to do that since we removed it from the
              project page."* The link was there and unfindable, which is the same
              outcome from the reader's side — so it MOVED rather than multiplied into
              a second one, because two controls offering one form make a reader stop
              and work out whether they differ.

              ★ IT SITS BEFORE THE PIN IN THE DOM, AND TO THE LEFT OF IT ON SCREEN.
                Having found it, the user's follow-up was *"Move it to the left of
                the 'pin' icon."* The first attempt at that reordered these two
                elements in the row below and changed NOTHING AT ALL: `.pin-control`
                is `position: absolute`, so it occupies no space in a flex row and
                this pencil was already the row's second laid-out item either way.
                Measured `x 344.42 / y 296.06` before the reorder and `x 344.42 /
                y 296.1` after — which is what a no-op looks like when you only
                typecheck it. The placement is now done in `projectpage.css`
                (`.projpage__actions .iconbtn`), which takes this control out of the
                row and puts it in the head's corner 8px left of the pin, derived
                from the pin's own offset.

              ★ THE DOM ORDER IS STILL DELIBERATE even though the corner offset no
                longer derives from it: order here is tab order, and the keyboard
                should reach the control that changes stored data before the one
                that only bookmarks. DOM order and paint order agree — pencil left,
                pin right.

              ★ IT IS RENDERED ONLY FOR A LEVEL THIS APP HAS A RECORD FOR, and the
                condition is the same one the cost-centre section used (`held`). The
                page opens on all 139 levels while only about ten carry a registry
                row, and the edit screen is the form for THAT ROW: for a level with
                none it answers "the registry holds 15 projects and none of them is
                X", which is a dead end dressed up as a control. The remedy for an
                unrecorded level is to record it, and that is `/projects/new`.
                Nothing is lost by the absence — an unrecorded level has no name, note
                or owner stored to correct.

              ★ THAT ABSENCE WAS PUT TO THE USER RATHER THAN ASSUMED, and the answer
                was that the model reads correctly as written. Asked whether a level
                with no record should still get a pencil — pointed at `/projects/new`
                — the reply was *"Isn't 'Buffalo Bills Stadium' a project?"* It is,
                and that is the point: a project in this app IS a recorded level. A
                level the registry does not hold is not yet a project, so there is
                nothing here to edit into and no affordance is added.

              ★ THE WRITE NEEDS THE SLUG AND THE PAGE IS KEYED BY THE LEVEL. That is
                the same asymmetry the background picture has, and it is why this asks
                `row` — the registry row found by level — for its own key rather than
                reusing `p.level`. The `encodeURIComponent` is honest for the same
                reason it is on the pin's own `href`: a slug is derived from the name,
                so it can hold a space or a `#`, and `:slug/edit` has to survive that.

              ★ AN ANCHOR, NOT A BUTTON. The destination is a URL, so middle-click,
                "open in a new tab" and the keyboard all have to work — a `<button>`
                with `navigate()` would give up all three. The accessible name carries
                the project because a row of these, elsewhere, would be a row of
                identical controls; `title` is the hover answer the icon cannot give. */}
          {row ? (
            <Link
              className="iconbtn"
              to={`/projects/${encodeURIComponent(row.slug)}/edit`}
              aria-label={`Edit this project — ${p.name}`}
              title="Edit this project — its name, note, site, owner, account level and picture"
            >
              <PencilIcon />
            </Link>
          ) : null}
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

      {/*
       * ── ★ THE THREE VIEWS, IN THEIR OWN ROW, ON THE SEAM ABOVE THE BODY ──────────
       *
       * ★ THESE ARE LINKS, AND THEY ARE NOT `role="tab"` — DELIBERATELY.
       *
       * The pattern that first suggests itself is `tablist`/`tab`/`tabpanel` with
       * `aria-selected`. It is the wrong contract here, and not for a cosmetic reason: a
       * real tablist owes the reader ARROW-KEY navigation and a roving tabindex, and a
       * reader told "tab, two of three" will press Right and expect to move. What this row
       * actually does is navigate to a different URL — each view is its own address, which
       * is why the whole thing can be shared, bookmarked and undone with Back — and the
       * honest description of "one of a set of links, and this is the one you are on" is
       * `aria-current`. `role="tab"` without the arrow-key handling would be a widget that
       * announces a keyboard contract it does not keep, which is worse for the reader than
       * plain navigation correctly described.
       *
       * ★ THE ACTIVE TAB IS MARKED BY `aria-current`, NOT BY A CLASS ALONE. Colour is the
       *   sighted reader's only clue that a tab is selected, so the state has to exist
       *   somewhere a screen reader reads too — otherwise three links read identically and
       *   the page never says which view you are looking at. `aria-current` is on exactly
       *   one link, computed from the same value the render below switches on, so the mark
       *   and the content cannot disagree.
       *
       * ★ IT IS RENDERED FROM AN ARRAY OF THE FOUR, so the set of views and the set of
       *   links are one list. Four hand-written links and one `if` chain over `view` is
       *   two lists that have to be kept in step by the reader, and `?view=icicle` would
       *   render a body no link pointed at.
       *
       * ★ `?view=` IS WRITTEN ON TWO OF THE FOUR. Details is the bare project URL because
       *   it is the default — a canonical address for a project should not carry a
       *   parameter saying "show the normal thing".
       *
       * ★★ BURST AND ICICLE ARE ADJACENT ON PURPOSE, because they are not two questions —
       *   they are one answer read two ways. Distance in a tab row is a claim about
       *   relatedness, so putting Details between them would say they were unrelated views
       *   rather than the same tree seen as a disc and as rows.
       *
       * ★ THE STYLES ARE THE EXISTING VIEW-SWITCH CLASSES, which were in `lineage.css`
       *   already and emitted by nothing. Reusing them keeps one definition of "a segmented
       *   control" rather than a second copy of the same padding, radius and active
       *   treatment. `lineage.css` is imported from `main.tsx`, so they are in the eager
       *   bundle — a tab row styled by a lazily-loaded chunk would render unstyled until the
       *   reader visited the tab that loads it.
       */}
      <nav className="projpage__tabs" aria-label="Project views">
        <div className="lin__switch">
          {([
            { key: 'details', label: 'Details', to: projectHref },
            { key: 'network', label: 'Network', to: `${projectHref}?view=brain` },
            { key: 'burst', label: 'Burst', to: `${projectHref}?view=burst` },
            { key: 'icicle', label: 'Icicle', to: `${projectHref}?view=icicle` },
          ] as const).map((tab) => (
            <Link
              key={tab.key}
              className={`lin__switchbtn${view === tab.key ? ' lin__switchbtn--on' : ''}`}
              to={tab.to}
              aria-current={view === tab.key ? 'true' : undefined}
              title={
                tab.key === 'burst'
                  ? 'Where the project money went — project, account, PO line, invoice, check, as rings of one disc'
                  : tab.key === 'icicle'
                    ? 'The same five levels as Burst, drawn as five columns — each cell as tall as its share of its parent'
                    : undefined
              }
            >
              {tab.label}
            </Link>
          ))}
        </div>
      </nav>

      <div className="projpage__body" ref={bodyRef}>
        {view === 'network' ? (
          <LineageView project={p} lines={lines} mode="brain" />
        ) : view === 'burst' ? (
          <LineageView project={p} lines={lines} mode="sunburst" />
        ) : view === 'icicle' ? (
          <LineageView project={p} lines={lines} mode="icicle" />
        ) : (
          <ProjectDetail project={p} />
        )}
      </div>
    </div>
  );
}
