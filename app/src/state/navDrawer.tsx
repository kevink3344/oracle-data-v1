import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

/**
 * Whether the mobile navigation drawer is open.
 *
 * ★ THIS IS A CONTEXT RATHER THAN A PROP, BECAUSE THE TWO ENDS OF THE DRAWER ARE IN
 *   DIFFERENT SUBTREES. The button that opens it lives in the top bar; the panel it
 *   opens is the rail, which is a *sibling* of the top bar's ancestor. Threading a
 *   prop would mean `Shell` owning state it does not otherwise care about and passing
 *   it down two unrelated branches — and the rail is rendered by `Shell` while the
 *   button is rendered by `TopBar`, so there is no common parent short of the shell.
 *
 * ★ THE DRAWER IS ONLY A DRAWER ON A NARROW SCREEN, AND THAT IS DECIDED IN CSS.
 *   Above the breakpoint the rail is a permanent column and this state is inert: the
 *   panel is always visible, the backdrop is `display: none`, and `open` has no
 *   effect on the layout. Keeping one piece of state for both layouts is what stops
 *   the two from disagreeing — a reader who opens the drawer, rotates to a wide
 *   window and rotates back should find it as they left it, and the alternative
 *   (a `matchMedia` subscription driving a second copy of the state) has two sources
 *   of truth for one fact.
 */
interface NavDrawerValue {
  open: boolean;
  setOpen: (next: boolean) => void;
  toggle: () => void;
}

const NavDrawerContext = createContext<NavDrawerValue | null>(null);

export function NavDrawerProvider({ children }: { children: ReactNode }) {
  const [open, setOpenState] = useState(false);
  const { pathname } = useLocation();

  /*
   * ★ NAVIGATION CLOSES THE DRAWER, AND IT HAS TO BE AN EFFECT RATHER THAN AN
   *   `onClick` ON EACH LINK.
   *
   *   The rail holds 27 leaves plus group headers, and every one of them would need
   *   the same call — so the one that was forgotten would leave the drawer covering
   *   the page the reader had just asked for, which reads as a link that did nothing.
   *   Watching the pathname catches every route change regardless of what caused it:
   *   a rail link, the top bar's search redirect, a programmatic `navigate`, or the
   *   browser's back button, which no click handler would see at all.
   *
   *   The first render is skipped by comparing against the pathname this effect last
   *   saw, so mounting does not immediately close a drawer that was never open.
   */
  const [seenPath, setSeenPath] = useState(pathname);
  useEffect(() => {
    if (pathname !== seenPath) {
      setSeenPath(pathname);
      setOpenState(false);
    }
  }, [pathname, seenPath]);

  const setOpen = useCallback((next: boolean) => setOpenState(next), []);
  const toggle = useCallback(() => setOpenState((prev) => !prev), []);

  /*
   * ★ ESCAPE CLOSES IT, AND SO DOES A WIDE WINDOW.
   *
   *   Escape is the expected way out of anything that covers the page, and without it
   *   a keyboard user who tabbed into the drawer would have to reach the toggle again
   *   to get back out — the button is behind the backdrop at that point.
   *
   *   The resize listener exists for one specific trap: a reader opens the drawer on a
   *   narrow window, widens the window past the breakpoint (where the rail becomes a
   *   permanent column and the backdrop disappears), then narrows it again. Without
   *   this, the drawer would reappear open — and the scroll lock below would have been
   *   applied to a layout that no longer has a drawer. `matchMedia` is the same query
   *   the stylesheet uses, so the two cannot drift.
   */
  useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenState(false);
    };
    window.addEventListener('keydown', onKey);

    const wide = window.matchMedia('(min-width: 721px)');
    const onWide = () => {
      if (wide.matches) setOpenState(false);
    };
    wide.addEventListener('change', onWide);

    return () => {
      window.removeEventListener('keydown', onKey);
      wide.removeEventListener('change', onWide);
    };
  }, [open]);

  /*
   * ★ THE PAGE BEHIND THE DRAWER DOES NOT SCROLL WHILE IT IS OPEN.
   *
   *   Without this, a swipe over the backdrop scrolls the register underneath, so the
   *   reader closes the drawer to find they have lost their place — and on iOS the
   *   page can scroll *through* the fixed panel. `overflow: hidden` on the root is the
   *   portable form; the scrollbar's width is given back as padding so the layout does
   *   not jump sideways the moment the drawer opens.
   *
   *   ★ THE PREVIOUS VALUE IS RESTORED RATHER THAN SET TO `''`. Something else may
   *   legitimately own this property — a modal, the print sheet — and writing the empty
   *   string would clear *their* lock as well as this one.
   */
  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    const previousPadding = root.style.paddingRight;
    const gap = window.innerWidth - root.clientWidth;
    root.style.overflow = 'hidden';
    if (gap > 0) root.style.paddingRight = `${gap}px`;
    return () => {
      root.style.overflow = previousOverflow;
      root.style.paddingRight = previousPadding;
    };
  }, [open]);

  return (
    <NavDrawerContext.Provider value={{ open, setOpen, toggle }}>{children}</NavDrawerContext.Provider>
  );
}

/**
 * The drawer's state, or a no-op outside the provider.
 *
 * ★ A MISSING PROVIDER IS NOT AN ERROR, BECAUSE THE RAIL IS RENDERED IN PLACES THAT
 *   HAVE NO DRAWER. The sign-in screen and the session-check card draw the brand and
 *   nothing else, and a test or a story that mounts `TopBar` alone should not have to
 *   wrap it. Returning a closed, inert value keeps those cases working rather than
 *   throwing from a hook — the failure mode of a throw here is a blank screen, which
 *   is a worse answer than a toggle that does nothing in a context that has no rail.
 */
export function useNavDrawer(): NavDrawerValue {
  const value = useContext(NavDrawerContext);
  if (value !== null) return value;
  return { open: false, setOpen: () => {}, toggle: () => {} };
}
