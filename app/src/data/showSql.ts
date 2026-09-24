import { useCallback, useEffect, useState } from 'react';

/**
 * Whether the reader wants to see the SQL behind the figures.
 *
 * ── WHY A PREFERENCE AND NOT A PAGE STATE
 *
 * Staff asked for this as a *review* aid: turn it on, check that a number is arrived at the way they
 * expect, turn it off. That is a mode a person sits in for a while and moves between pages in, so it
 * has to outlive a navigation — a per-page `useState` would switch itself off every time a link was
 * followed, which is precisely when the reader is comparing two figures.
 *
 * It persists in `localStorage` under the same convention the theme uses (`projects-*`), reads
 * defensively (a corrupt or blocked store falls back to off rather than throwing), and is broadcast
 * on a custom event so every mounted consumer re-renders together. The event matters: the toggle
 * lives on Settings and the readers live on a dozen other pages, so without it a reader would have
 * to reload after flipping the switch.
 */

const STORAGE_KEY = 'projects-show-sql';
const CHANGE_EVENT = 'projects-show-sql-changed';

/**
 * Read the stored preference.
 *
 * ★ OFF IS THE DEFAULT AND ALSO THE FALLBACK, DELIBERATELY. A private-mode browser, a blocked
 *   storage API or a hand-edited value must all land on the same answer as a first visit, because
 *   the alternative is a page that renders SQL for a reader who never asked for it — which is
 *   noise at best and a leak of query text at worst.
 */
export function readShowSql(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Write the preference and tell every mounted consumer. */
export function writeShowSql(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(STORAGE_KEY, '1');
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage unavailable; the preference then just does not persist */
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: on }));
}

/**
 * The preference, subscribed.
 *
 * Uses `useSyncExternalStore`'s shape by hand rather than the hook itself, because the value lives
 * in `localStorage` and the hook needs a stable snapshot function — which for a storage-backed value
 * is a subscription plus a getter, i.e. exactly what this is.
 */
export function useShowSql(): [boolean, (next: boolean) => void] {
  const [on, setOn] = useState<boolean>(readShowSql);

  useEffect(() => {
    const sync = () => setOn(readShowSql());
    window.addEventListener(CHANGE_EVENT, sync);
    // Another tab flipping the switch is a real case for a preference, and `storage` is the only
    // event that crosses tabs.
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const set = useCallback((next: boolean) => {
    writeShowSql(next);
    setOn(next);
  }, []);

  return [on, set];
}

/**
 * Append `?sql=1` to a request URL while the preference is on.
 *
 * ★ IT IS A FUNCTION OF THE PREFERENCE, READ AT CALL TIME, AND NOT A MODULE CONSTANT. A fetching
 *   module that captured the flag once at import would keep sending it — or keep omitting it —
 *   for the life of the tab, because the toggle changes a value in storage rather than reloading
 *   the bundle. Reading it here means the next request obeys the switch, which is what a reader
 *   expects after flipping it.
 *
 * It preserves any query string already present, so a call site does not have to know whether it is
 * the first parameter.
 */
export function withSqlFlag(url: string): string {
  if (!readShowSql()) return url;
  return url.includes('?') ? `${url}&sql=1` : `${url}?sql=1`;
}
