import { type KeyboardEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useStore } from '../state/store';
import { isSuperAdmin, useSession } from '../data/session';
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

/**
 * The rail.
 *
 * `nav/menu.ts` owns what the menu *is*; this file owns how it behaves. §10.2
 * fixed the behaviour, and each of its five rows is a decision rather than a
 * default:
 *
 *   - **Expanded by default: only the group holding the current route.** Opening
 *     every group turns a 27-leaf rail back into the 40-row list §10.3 went to the
 *     trouble of avoiding. Opening *none* of them hides the page you are on, so
 *     exactly one group starts open and it is the one you are looking at.
 *   - **Not an accordion.** Several groups may be open at once. Funding and Spend
 *     are the two a reader compares constantly, and making that two clicks is the
 *     part of an accordion nobody notices until they have used it.
 *   - **Expansion is remembered**, in `localStorage`, keyed per group — so a
 *     reader's own arrangement survives navigation. A remembered map wins over the
 *     default; a route change only ever *adds* the group it lands in, and never
 *     closes anything the reader opened.
 *   - **The group header is a `<button>`, not a `div` with an `onClick`.** It
 *     carries `aria-expanded` and `aria-controls`, and the panel it controls is
 *     always in the DOM and merely `hidden` — which is what keeps that reference
 *     valid when the group is shut.
 *   - **One tab stop, arrows inside it.** Every item is `tabIndex={-1}` except the
 *     leaf you are on, so Tab steps past the rail instead of through 27 rows, and
 *     ↑ ↓ ← → Home End walk it.
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
  const navigate = useNavigate();
  // ★ SUBSCRIBED, NOT MERELY READ. `isSuperAdmin()` on its own would answer
  //   correctly and never cause a re-render, because the session store notifies only
  //   what subscribed to it — so a gear that appeared on a full page load would stay
  //   hidden through a sign-in, which is exactly when it is wanted. `useSession()`
  //   is the subscription; the role decision is still made in one place.
  const mayOpenSettings = isSuperAdmin(useSession());

  const ready = status === 'ready';
  const active = activeLeaf(pathname);
  const activeBlock = active ? blockIdFor(active.to) : undefined;

  const [open, setOpen] = useState<OpenMap>(() => {
    const saved = readOpen();
    if (Object.keys(saved).length > 0) return saved;
    return { [activeBlock ?? 'overview']: true };
  });

  /**
   * Landing on a leaf always reveals it, even if the reader had shut that group
   * earlier. Nothing is ever closed here: a route change that silently collapsed a
   * group the reader had opened would undo their arrangement on the way past.
   */
  useEffect(() => {
    if (!activeBlock) return;
    setOpen((prev) => {
      if (prev[activeBlock] === true) return prev;
      const next: OpenMap = { ...prev, [activeBlock]: true };
      writeOpen(next);
      return next;
    });
  }, [activeBlock]);

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

    return (
      <Link
        key={leaf.to}
        to={leaf.to}
        className="rail__link"
        aria-current={current ? 'page' : undefined}
        data-rail-item="leaf"
        tabIndex={leaf.to === rovingTo ? 0 : -1}
        title={leaf.built ? `${leaf.label} — reads ${leaf.reads}` : leaf.note}
      >
        {leaf.label}
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
        <button
          type="button"
          className={`rail__title${holds ? ' rail__title--here' : ''}`}
          data-rail-item="group"
          data-group={block.id}
          tabIndex={-1}
          aria-expanded={isOpen}
          aria-controls={panelId}
          onClick={() => setGroup(block.id)}
        >
          <span className="rail__chev" aria-hidden="true">
            {isOpen ? '▾' : '▸'}
          </span>
          {block.title}
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
        <span className="brand__mark" aria-hidden="true">
          WC
        </span>
        {/*
          ★ THE WORDS SIT ON THEIR OWN ROW UNDER THE MARK, WHICH IS A MEASUREMENT
            AND NOT A PREFERENCE.

          They used to share the row with the mark, and on a 208px rail that row is
          151px of content box: the mark takes 32, the settings gear takes 22, and the
          gaps take 20 — which leaves 77px for a name that needs about 210. "Oracle
          Projects" survived that only by breaking over two lines, and when the name
          became "Oracle Projects & Accounts" it broke over three, one word per line,
          with the mark floating in the middle of a five-line block it no longer lined
          up with. The row is a real constraint, so the fix is to stop putting the words
          in it.

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
            doubles its mark and its name (see `signin.css`); a 36px wordmark in a
            208px column would stand three lines deep over the navigation, so here the
            name stays 13px and the tagline 10px, and only the mark grows (28 → 32).

            ★ AND THE BLOCK GETS SHORTER, NOT TALLER, BECAUSE THE WORDS STOP WRAPPING
            SO HARD. Measured after the change: at the full 151px the name sets in two
            lines and the tagline in one, so the block is three lines where the old one
            was five and the mark has a row of its own to sit in.
        */}
        <div className="brand__words">
          <div className="brand__name">{APP_NAME}</div>
          <div className="brand__sub">{APP_TAGLINE}</div>
        </div>
        {/**
         * ★ THE GEAR IS LAST IN THE BRAND ROW, AND IT CARRIES NO `data-rail-item`.
         *
         * The arrow-key walk in `onKeyDown` collects every `[data-rail-item]` in the
         * rail and moves focus through them. A settings button inside the brand is
         * outside that tree — it is not a destination in the menu, and ↑↓ walking
         * into the brand would let the walk leave the list it is a walk *of*, with no
         * way to tell where it had gone. Omitting the attribute is what excludes it,
         * and the omission is the whole mechanism, so it is written down here rather
         * than left as an absence somebody would helpfully "fix".
         *
         * ★ RENDERED ONLY FOR A SUPER ADMIN, WHICH IS A CONVENIENCE AND NOT A
         * CONTROL. The four endpoints behind `/settings` call `requireSuperAdmin`
         * and answer 403 regardless of what is on screen, and the page itself says so
         * when a member reaches it by typing the URL. A hidden button is not an
         * access control; this file does not pretend otherwise.
         *
         * ★ A `button` AND NOT A `Link`. It is the same markup contract the rest of
         * this component's interactive parts keep: a control that is *acting* on the
         * app calls `navigate`, and a `<Link>` is for somewhere a person is being
         * sent. This is the affordance the request describes, and it is a button.
         */}
        {mayOpenSettings ? (
          <button
            type="button"
            className="rail__gear"
            aria-label="Settings"
            title="Settings — the organization register"
            onClick={() => navigate('/settings')}
          >
            <span aria-hidden="true">⚙</span>
          </button>
        ) : null}
      </div>

      {WORK_BLOCKS.map((block) => renderGroup(block, false))}

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
