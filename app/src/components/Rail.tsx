import { type KeyboardEvent, useCallback, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useStore } from '../state/store';
import { num } from '../data/format';
import { APP_NAME, APP_TAGLINE } from '../data/brand';
import {
  ALL_LEAVES,
  COUNT_OF,
  UTILITY_BLOCKS,
  WORK_BLOCKS,
  activeLeaf,
  blockIdFor,
  distinctOrders,
  unclaimedOf,
  type MenuBlock,
  type MenuLeaf,
  type RailCount,
} from '../nav/menu';
import RailIcon from './RailIcon';

/**
 * The rail.
 *
 * `nav/menu.ts` owns what the menu *is*; this file owns how it behaves. §10.2
 * fixed the behaviour, and each of its five rows is a decision rather than a
 * default:
 *
 *   - **Shut by default: every group starts closed.** Opening all of them turns a
 *     27-leaf rail back into the 40-row list §10.3 went to the trouble of avoiding.
 *     Opening *the current group* alone — which is what this did first — is only a
 *     static version of that: it spends 3 to 7 rows nobody asked for, and the rows
 *     it spends are the ones below it. The rail now opens as eight headers and
 *     nothing else, and shows where you are by brightening the header that holds
 *     the current route rather than by unfolding it. There is no control that opens
 *     all eight at once any more: the brand row used to carry one, and the brand row
 *     is the wordmark alone. A group opens from its own header — a click, or ← →
 *     when the header has focus.
 *
 *     ★ WHICH IS WHY THE ROUTE-CHANGE EFFECT IS GONE. It was added when the default
 *     was "the current group is open", where it cost nothing — it only ever
 *     re-opened what the default had already opened, so a reader could shut the
 *     group they were standing in and it would stay shut. Under a shut default the
 *     same effect would undo the default on every navigation, and the rail would be
 *     back to one group open at all times with the only difference being *which*
 *     one. Nothing here opens a group on the reader's behalf: a group is open
 *     because a reader opened it.
 *   - **Not an accordion.** Several groups may be open at once. Funding and Spend
 *     are the two a reader compares constantly, and making that two clicks is the
 *     part of an accordion nobody notices until they have used it.
 *   - **Expansion is remembered**, in `localStorage`, keyed per group — so a
 *     reader's own arrangement survives navigation, and survives a reload. A
 *     remembered map wins over the shut default, in both directions: a reader who
 *     opens Funding and comes back tomorrow gets Funding open and the rest shut.
 *   - **The group header is a `<button>`, not a `div` with an `onClick`.** It
 *     carries `aria-expanded` and `aria-controls`, and the panel it controls is
 *     always in the DOM and merely `hidden` — which is what keeps that reference
 *     valid when the group is shut.
 *   - **One tab stop, arrows inside it.** Every item is `tabIndex={-1}` except the
 *     leaf you are on, so Tab steps past the rail instead of through 27 rows, and
 *     ↑ ↓ ← → Home End walk it.
 *
 * ★ SHORTER TEXT IN THE RAIL, AND ONLY IN THE RAIL. `MenuLeaf.short` and
 *   `MenuBlock.short` exist because this column is the wrong place for the full
 *   name: measured with an icon and a badge beside it, a row has room for about 12
 *   characters of label, and `Allocations & available funds` needs 27. The full name
 *   is what `Pending.tsx` prints as the page's `<h1>`, so the rail renders
 *   `short ?? label` and puts the full name in the tooltip — the short one is a
 *   label for a column, not a rename. Same for the group headers, where
 *   `Commitments & Spend` is the one that had to give.
 */

const OPEN_KEY = 'projects-rail-open';

/** Which groups the reader has open. Absent means "the default, not yet touched". */
type OpenMap = Record<string, boolean>;

function readOpen(): OpenMap {
  try {
    const raw = localStorage.getItem(OPEN_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: OpenMap = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'boolean') out[id] = value;
    }
    return out;
  } catch {
    // Storage can be unavailable — a private window, a locked profile. The
    // computed default below is still correct; only the memory is lost.
    return {};
  }
}

function writeOpen(map: OpenMap): void {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(map));
  } catch {
    /* same: the preference just does not persist */
  }
}

/**
 * The count badge.
 *
 * `—` rather than `0` while the extract is still loading, which is the whole
 * reason this is a function rather than an inline expression. "Not loaded" and
 * "none" are different answers, and this app has already shipped one figure that
 * read `0` on every page view because the value never reached the response — and
 * it looked exactly like a table with no rows.
 */
function Badge({
  count,
  ready,
  counts,
}: {
  count?: RailCount;
  ready: boolean;
  counts: Record<RailCount, number>;
}) {
  if (!count) return null;
  return (
    <span className="cnt" title={COUNT_OF[count]}>
      {ready ? num(counts[count]) : '—'}
    </span>
  );
}

export default function Rail() {
  const { status, lines, projects, summary, activity } = useStore();
  const { pathname } = useLocation();

  const ready = status === 'ready';
  const active = activeLeaf(pathname);
  const activeBlock = active ? blockIdFor(active.to) : undefined;

  const [open, setOpen] = useState<OpenMap>(() => readOpen());

  const setGroup = useCallback((id: string, value?: boolean) => {
    setOpen((prev) => {
      const next: OpenMap = { ...prev, [id]: value ?? prev[id] !== true };
      writeOpen(next);
      return next;
    });
  }, []);

  /**
   * ↑ ↓ Home End walk the visible rail; ← → shut and open the group you are on.
   *
   * The walk is computed from the DOM rather than from state because the DOM is
   * the only thing that already knows the truth about *visibility*: a collapsed
   * panel is `hidden`, so its leaves have no client rects and drop out of the list
   * for free. Rebuilding that ordering from `open` and `WORK_BLOCKS` would be a
   * second implementation of the render, and the two would drift.
   */
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const key = event.key;
      if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(key)) return;

      const items = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement>('[data-rail-item]'),
      ).filter((el) => el.getClientRects().length > 0);
      if (items.length === 0) return;

      const here = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const at = here ? items.indexOf(here) : -1;

      const move = (to: number) => {
        const next = items[to < 0 ? items.length - 1 : to % items.length];
        if (!next) return;
        event.preventDefault();
        next.focus();
      };

      if (key === 'ArrowDown') return move(at < 0 ? 0 : at + 1);
      if (key === 'ArrowUp') return move(at <= 0 ? items.length - 1 : at - 1);
      if (key === 'Home') return move(0);
      if (key === 'End') return move(items.length - 1);

      // Opening and closing applies to a group header only. On a leaf, ← and →
      // are left to the browser so they keep meaning back and forward.
      const group = here?.dataset.group;
      if (!group) return;
      event.preventDefault();
      setGroup(group, key === 'ArrowRight');
    },
    [setGroup],
  );

  const counts = useMemo<Record<RailCount, number>>(
    () => ({
      projects: projects.length,
      unclaimed: unclaimedOf(projects),
      // Blanks are filtered out of both sets. `new Set(rows.map(r => r.vendor))`
      // counts `''` once, so a badge built that way reads one higher than the
      // number of vendors — which the rail that this replaces did.
      combinations: new Set(lines.map((l) => l.combinationKey).filter(Boolean)).size,
      vendors: new Set(lines.map((l) => l.vendor).filter(Boolean)).size,
      orders: distinctOrders(lines),
      lines: lines.length,
      // ★ ARRIVES BY A DIFFERENT ROUTE FROM EVERY OTHER MEMBER HERE. The rest are
      //   counts over `lines` and `projects`, which the store already holds. This
      //   one is an API answer, and it is `?? 0` only because the record is typed
      //   `number` — the render below does not consult it unless `activity` is
      //   non-null, so the zero is never printed.
      //
      // ★ `moved`, NOT `counted`. The register reports both, and only one of them
      //   belongs on a badge: `counted` is how many objects have a reading at all,
      //   which sits at the size of the register and says nothing on a day when
      //   nothing happened, while `moved` is how many counts differ from the reading
      //   before — the only sense in which anything here has changed. `counted` is on
      //   the page, where the coverage question is worth asking.
      activity: activity?.moved ?? 0,
    }),
    [projects, lines, activity],
  );

  /** The single tab stop: the leaf you are on, or the first if the route is not in the menu. */
  const rovingTo = active?.to ?? ALL_LEAVES[0]?.to;

  /**
   * The highlight is set here rather than left to `NavLink`, and that is a fix
   * rather than a preference.
   *
   * `NavLink` matches by prefix unless it is given `end`, and `end` only fixes the
   * equal-length case — so `to="/projects"` stayed lit while the URL was
   * `/projects/unclaimed`, and two rows claimed to be the page you were on. The
   * menu already owns this question (`activeLeaf`, longest match wins), and asking
   * a second implementation is how the two answers diverge. `current` is therefore
   * an equality test against that one answer, so at most one leaf can light up.
   *
   * What that gives for the two routes that no leaf names, both deliberate:
   * `/projects/new` still highlights **All projects**, because that leaf's path is
   * the prefix you are standing on — you are in the Projects block, and a rail with
   * nothing lit would read as "you are nowhere". `/objects/:object` highlights
   * nothing, because that path has no menu ancestor at all; the detail drawer is a
   * view *over* whatever list you came from, not a place in the tree.
   */
  const renderLeaf = (leaf: MenuLeaf) => {
    const current = active?.to === leaf.to;

    /**
     * ★ `ready` IS PER LEAF, NOT PER PAGE, AND IT HAS TO BE. Every other badge is a
     *   count over data the store already holds, so it becomes real the moment the
     *   extract loads. The activity badge is a separate request that can still be
     *   in flight, or can have failed, after the extract is on screen — and the
     *   difference between "cannot say" and "nothing happened" is the whole reason
     *   this badge is rendered by a function instead of an expression.
     */
    const badgeReady = leaf.count === 'activity' ? activity !== null : ready;

    /**
     * ★ THE FULL NAME LEADS THE TOOLTIP WHENEVER THE ROW SHOWS AN ABBREVIATION.
     *   A reader hovering "Combinations" is asking what it is short for, and the
     *   long name is not otherwise reachable from this rail. Leaves without a
     *   `short` keep exactly the title they had.
     */
    const title = leaf.built
      ? `${leaf.label} — reads ${leaf.reads}`
      : leaf.short
        ? `${leaf.label} — ${leaf.note}`
        : leaf.note;

    return (
      <Link
        key={leaf.to}
        to={leaf.to}
        className="rail__link"
        aria-current={current ? 'page' : undefined}
        data-rail-item="leaf"
        tabIndex={leaf.to === rovingTo ? 0 : -1}
        title={title}
      >
        <RailIcon name={leaf.icon} />
        {leaf.short ?? leaf.label}
        {leaf.derived ? (
          <span className="rail__tag" title="Computed from other figures, not read from a column">
            calc
          </span>
        ) : null}
        {leaf.built ? null : (
          <>
            <span className="rail__soon" aria-hidden="true" />
            <span className="sr"> — screen not built yet</span>
          </>
        )}
        <Badge count={leaf.count} ready={badgeReady} counts={counts} />
      </Link>
    );
  };

  const renderGroup = (block: MenuBlock, utility: boolean) => {
    const isOpen = open[block.id] === true;
    const holds = activeBlock === block.id;
    const panelId = `rail-panel-${block.id}`;

    return (
      <div key={block.id} className={`rail__group${utility ? ' rail__group--util' : ''}`}>
        {/*
          ★ THE VISIBLE TEXT CAN BE SHORT; THE ACCESSIBLE NAME IS NEVER SHORT.
            `aria-label` and `title` carry the full section name for the one header
            that has to abbreviate, and they are deliberately the *same* string: the
            tooltip is read by people who can see the abbreviation and are asking
            what it stands for, and the accessible name is read by people who were
            never shown the abbreviation at all. Two strings would answer one
            question two ways.

            There is no `aria-label` for the other seven headers, because the
            default — the button's own text — is already the full name, and an
            `aria-label` that repeats visible text is one more thing to keep in sync.
        */}
        <button
          type="button"
          className={`rail__title${holds ? ' rail__title--here' : ''}`}
          data-rail-item="group"
          data-group={block.id}
          tabIndex={-1}
          aria-expanded={isOpen}
          aria-controls={panelId}
          aria-label={block.short ? block.title : undefined}
          title={block.short ? block.title : undefined}
          onClick={() => setGroup(block.id)}
        >
          <span className="rail__chev" aria-hidden="true">
            {isOpen ? '▾' : '▸'}
          </span>
          <RailIcon name={block.icon} />
          {block.short ?? block.title}
        </button>
        {/* Always mounted, only hidden: `aria-controls` has to name something that
            exists, and `hidden` is also what the arrow-key walk reads to know which
            rows are on screen. */}
        <div className="rail__panel" id={panelId} hidden={!isOpen}>
          {block.leaves.map(renderLeaf)}
        </div>
      </div>
    );
  };

  return (
    /*
     * ★ THE `id` IS THE TOGGLE'S `aria-controls` TARGET, AND IT IS ON THE `<nav>` ITSELF.
     *   The mobile toggle in the top bar points at it, so the two are one control and
     *   one panel rather than two components that happen to be on the same screen. It
     *   is a static string because there is exactly one rail per document; a generated
     *   id would be a second thing for the top bar to be told.
     */
    <nav className="rail" id="app-rail" aria-label="Primary" onKeyDown={onKeyDown}>
      <div className="rail__brand">
        {/*
          ★ THE BRAND ROW IS THE WORDMARK AND NOTHING ELSE, WHICH IT WAS NOT BEFORE.
            It carried three things: a 32px monogram, the name over the tagline, and
            — for a super admin — a settings gear, with a fold-all control beside the
            gear once the rail gained one. All three are gone at the request that
            asked for them. `/settings` did not lose an entrance with the gear: it is
            a leaf in the Administration block, which is where a destination belongs
            and where it can be found by reading rather than by knowing.

          ★ WHICH IS WHY THE TWO-ROW GRID IS GONE WITH THEM. `.rail__brand` was a
            grid of `auto 1fr auto` because the mark and the two controls shared a row
            the name could not fit into — on a 208px rail that row is 151px of content
            box, the mark took 32, the gear 22 and the gaps 20, leaving 77px for a
            name that needs about 210. The words had a row of their own for that
            reason alone; with no mark and no controls there is one item left, and a
            grid of one is a block. `shell.css` lays it out as one.

          ★ THE PRODUCT IS NAMED FIRST AND THE REGISTER SECOND, WHICH IS THE
            OPPOSITE OF WHAT THIS SAID BEFORE.

          It read "Chart of Accounts" over "Oracle Projects" — the register over the
          product, which is the order a *page* is titled in, not a *rail*. The rail
          is the app's identity and it is the thing beside the login screen's brand
          block, so the two had better agree.

          ★ THE TWO STRINGS NOW COME FROM `data/brand.ts` INSTEAD OF BEING WRITTEN
            HERE. This file and `AppBrand` used to hold a copy each, and the two
            agreed only because somebody kept them agreeing. Renaming the product to
            "Oracle Projects & Accounts" was the first change that had to land in
            four places at once — this rail, the login card, the session gate's card
            and the printed masthead — so the name and the tagline have one
            definition and no copies. Change the name there and this rail follows.

          ★ THE RAIL KEEPS ITS OWN SCALE, WHICH IS NOT THE LOGIN CARD'S. The card
            doubles its name (see `signin.css`); a 36px wordmark in a 208px column
            would stand three lines deep over the navigation, so here the name stays
            13px and the tagline 10px. With the mark gone the block is exactly those
            two lines.
        */}
        <div className="brand__name">{APP_NAME}</div>
        <div className="brand__sub">{APP_TAGLINE}</div>
      </div>

      {/*
        ★ THE SIX WORK BLOCKS ARE ONE LIST, SO THEY GET ONE PARENT.

        They were direct children of `nav.rail` and therefore took the rail's 20px
        gap, which is a section break — right for the brand, Reference & setup and
        the provenance stamp, wrong between two group headers. The three other
        boundaries keep that gap because they are still `.rail`'s own children;
        only the six move into `.rail__work`, whose gap is the row rhythm the leaves
        below them use. See `rail.css`.
      */}
      <div className="rail__work">
        {WORK_BLOCKS.map((block) => renderGroup(block, false))}
      </div>

      <div className="rail__util">
        <div className="rail__util-title">Reference &amp; setup</div>
        {UTILITY_BLOCKS.map((block) => renderGroup(block, true))}
      </div>

      <div className="rail__foot">
        {summary ? (
          <>
            Extract cut-off {summary.cutoff}
            <br />
            {num(summary.rows)} PO lines · {num(summary.projects)} levels
          </>
        ) : (
          'Reading extract…'
        )}
      </div>
    </nav>
  );
}
