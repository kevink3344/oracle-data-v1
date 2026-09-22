import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useStore } from '../state/store';
import { useSession } from '../data/session';
import { scopeLabel } from '../data/scope';
import { num } from '../data/format';
import ScopeSelect from './ScopeSelect';
import { useNavDrawer } from '../state/navDrawer';

/**
 * The width at which the rail stops being a column and becomes a drawer.
 *
 * ★ THE SAME NUMBER AS THE STYLESHEET'S MEDIA QUERY, AND IT HAS TO BE. The button is
 *   rendered from this value while the drawer's behaviour comes from CSS, so if the
 *   two disagree the result is a button that opens nothing (CSS still a column) or a
 *   drawer with no way to open it (CSS off-canvas, no button). `shell.css` carries the
 *   matching `@media (max-width: 720px)` and names this constant in a comment.
 */
const NAV_DRAWER_MAX_PX = 720;

/**
 * Shown only while the rail is off canvas.
 *
 * ★ THE QUERY IS SUBSCRIBED TO RATHER THAN SAMPLED ONCE. A window resized past the
 *   breakpoint — which is exactly what happens when a reader drags the browser edge or
 *   rotates a tablet — must add or remove this button, and a one-time read of
 *   `innerWidth` would leave the bar in whichever state it was mounted in.
 */
function NavToggle() {
  const { open, toggle } = useNavDrawer();
  const [narrow, setNarrow] = useState(
    () => window.matchMedia(`(max-width: ${NAV_DRAWER_MAX_PX}px)`).matches,
  );

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${NAV_DRAWER_MAX_PX}px)`);
    const onChange = () => setNarrow(query.matches);
    onChange();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  if (!narrow) return null;

  return (
    <button
      type="button"
      className="topbar__nav"
      aria-label="Menu"
      aria-expanded={open}
      aria-controls="app-rail"
      title={open ? 'Hide the menu' : 'Show the menu'}
      onClick={toggle}
    >
      {/* Three rules, the shape every hamburger has trained people to read. Drawn
          rather than typed, so it cannot pick up a font's idea of their weight. */}
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
        <path
          d="M3.5 6.5h17M3.5 12h17M3.5 17.5h17"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}

const STORAGE_KEY = 'projects-theme';
type Theme = 'light' | 'dark';

/* The icon shows the theme a click would move you to, not the one you are on, and
   the label says the same thing out loud. A checkbox-style `aria-pressed` toggle
   would have to name the state instead, which leaves the icon and the name
   disagreeing about whether it is the button or its effect you are looking at. */
const TOGGLE_LABEL: Record<Theme, string> = {
  light: 'Switch to dark theme',
  dark: 'Switch to light theme',
};

/** Reads the value `index.html` already applied before the bundle ran. */
function currentTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

export default function TopBar() {
  const { query, setQuery, status, scope, scopeStats, scopeTenant } = useStore();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [theme, setTheme] = useState<Theme>(currentTheme);
  /*
   * ★ SUBSCRIBED, NOT READ ONCE — the avatar and the owner a project is recorded
   *   against must be the same name, and the session arrives *after* the first paint
   *   whenever a stored token is being validated. `session()` on its own would answer
   *   correctly and never re-render, so the avatar would sit on the signed-out
   *   placeholder until something else happened to repaint the bar.
   */
  const signedIn = useSession();

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* storage can be unavailable; the preference then just does not persist */
    }
  }, [theme]);

  // Typing in the search box on any other screen takes you to the list, once —
  // `replace` so a search does not bury the previous page under history entries.
  const onSearch = useCallback(
    (value: string) => {
      setQuery(value);
      if (value && pathname !== '/projects') navigate('/projects', { replace: true });
    },
    [navigate, pathname, setQuery],
  );

  const busy = status === 'loading';

  return (
    <header className="topbar">
      {/*
        ★ THE MENU TOGGLE IS FIRST IN THE BAR AND HIDDEN ABOVE THE BREAKPOINT.

          Below 720px the rail is no longer a column — it is an off-canvas drawer — so
          something has to open it, and the top bar is the only chrome every screen
          has. It sits before the search box because that is where the leftmost control
          belongs once the rail has left the layout, and the reading order then matches
          the visual order for a screen reader walking the bar.

          ★ `aria-expanded` AND `aria-controls` RATHER THAN A LABEL THAT CHANGES.
            The button always means "the menu", and the two attributes say whether it
            is currently showing and which element it shows. A label that flipped to
            "Close menu" would be a second source of truth for the same fact, and it
            would have to be right in both layouts — including the wide one, where the
            button is not rendered at all and the drawer is permanently open.

          ★ IT IS NOT RENDERED ABOVE THE BREAKPOINT RATHER THAN MERELY HIDDEN. A
            `display: none` button is still in the accessibility tree in some
            browsers' older behaviour and is always in the DOM for tests to find; not
            rendering it means there is no control anywhere that cannot do anything.
            The cost is that this component needs to know the breakpoint, which is why
            the query is written once here and read by the stylesheet as the same
            number — see `.topbar__nav` in `shell.css`.
      */}
      <NavToggle />

      <div className="search">
        <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.6" />
          <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <label className="sr" htmlFor="project-search">
          Search projects by name, level code, site or owner, and their purchase-order lines by
          vendor, buyer, description or order number
        </label>
        <input
          id="project-search"
          type="search"
          autoComplete="off"
          placeholder="Search projects, vendors, buyers, descriptions, orders…"
          value={query}
          disabled={busy}
          onChange={(e) => onSearch(e.target.value)}
        />
      </div>

      {/*
        The account scope, immediately right of the search box.

        ★ HERE RATHER THAN IN A SIDEBAR, AND THE POSITION IS THE STATEMENT. The scope applies to
          every screen, so its control belongs somewhere every screen has — the search box is the one
          field the whole app shares, and putting the scope beside it makes "what am I looking at,
          and how is it narrowed" a single glance rather than a trip to a settings page. It also
          keeps the scope visible while the reader scrolls a register, because the TopBar is sticky.
      */}
      <ScopeSelect />

      <div className="topbar__tail">
        {busy ? (
          <span className="panel__sub" role="status">
            Reading extract…
          </span>
        ) : (
          /*
            "N PO lines in scope" used to be a fixed sentence around a live number, which read as a
            claim that something had been filtered when nothing had. It now reports both figures the
            moment they differ, so the two states — the scope caught nothing, the scope caught
            something — cannot be mistaken for one another from the top of the page.
          */
          <span className="panel__sub" title={`Account scope: ${scopeLabel(scope, scopeTenant?.programs ?? [])}`}>
            {scopeStats.excluded === 0
              ? `${num(scopeStats.all)} PO lines in scope`
              : `${num(scopeStats.shown)} of ${num(scopeStats.all)} PO lines — ${num(scopeStats.excluded)} removed by scope`}
          </span>
        )}

        <button
          type="button"
          className="themeswitch"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          aria-label={TOGGLE_LABEL[theme]}
          title={TOGGLE_LABEL[theme]}
        >
          {theme === 'dark' ? (
            /* Sun: 8 rays and a disc, the shape every theme switch has trained
               people to read as "go light". */
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
              <circle cx="12" cy="12" r="4.6" stroke="currentColor" strokeWidth="1.8" />
              <path
                d="M12 1.4v2.4M12 20.2v2.4M1.4 12h2.4M20.2 12h2.4M4.5 4.5l1.7 1.7M17.8 17.8l1.7 1.7M19.5 4.5l-1.7 1.7M6.2 17.8l-1.7 1.7"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
            </svg>
          ) : (
            /* Moon: a disc with a second one bitten out of it. */
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
              <path
                d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </svg>
          )}
        </button>

        {/*
          ★ THE AVATAR IS NOW THE WAY IN AND THE WAY OUT, RATHER THAN A DECORATION
            THAT ADMITTED IT WAS ONE.

          It used to carry `aria-hidden="true"` and a tooltip whose second clause was
          "authentication is not part of this slice" — an honest label on a control
          that did nothing, which was right while there was nothing to do. There is
          now, so the same element is a link: signed out it goes to the sign-in
          screen, and signed in it goes to the page that says who you are and offers
          to sign you out. Both are the *same* destination, because the two states
          are two halves of one screen.

          ★ IT IS NO LONGER `aria-hidden`, AND THAT MATTERS MORE THAN THE TOOLTIP. A
            hidden element is not merely unread: it is unfocusable and unclickable by
            assistive technology, so a screen-reader user would have had no route to
            the sign-in screen at all — there is no menu leaf for it. The tooltip is
            the convenience; the removal of `aria-hidden` is the fix.

          ★ THE SIGNED-OUT HALF OF THESE TWO TERNARIES IS NOW UNREACHABLE, AND THE
            WORDS IN IT WERE THE WORST PART OF BEING WRONG ABOUT THAT.

          This header is rendered by `Shell`, which is inside the gate, so by the time
          anybody sees this avatar the session is known and authenticated. The labels
          used to explain the opposite — "Every register is readable without a session"
          — which was true when they were written and is not true now, and a tooltip is
          exactly the sort of place a stale sentence survives for years because nobody
          reads it twice.

          The branch stays because `useSession()` really can be `null` for one paint
          (a token is held and the request is in flight — `Gate` waits, but this
          component would still be handed the `null` if it ever rendered on that
          frame), and a `null` deref here would take the whole shell down. So it says
          what is actually true of that moment and nothing about the app.
        */}
        <Link
          className="avatar"
          to="/sign-in"
          aria-label={
            signedIn?.authenticated
              ? `Signed in as ${signedIn.name} — open the session`
              : 'Sign in'
          }
          title={
            signedIn?.authenticated
              ? `Signed in as ${signedIn.name}${signedIn.organizationName ? ` · ${signedIn.organizationName}` : ''}`
              : 'The session is not known yet.'
          }
        >
          {signedIn?.initials ?? '—'}
        </Link>
      </div>
    </header>
  );
}
