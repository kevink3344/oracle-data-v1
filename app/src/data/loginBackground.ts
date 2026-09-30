import { useCallback, useEffect, useState } from 'react';

/**
 * The picture on the sign-in screen, as a reader preference.
 *
 * ── WHY THIS IS A PREFERENCE AND NOT A CONSTANT
 *
 * The sign-in screen is the only screen a signed-out visitor ever sees, and it is the one screen in
 * this app with no data on it. What belongs behind it is a matter of taste, and taste differs between
 * the people who use it — so it ships as a choice with a default, exactly like the theme.
 *
 * ── WHY A STRING AND NOT A BOOLEAN
 *
 * `showSql.ts` stores `'1'` or nothing. This cannot: "None" is one of the choices, and a preference
 * whose *value* is "nothing" cannot be told apart from a preference that was never set. So the id is
 * always written verbatim — including `'none'` — and the default is written on first save like any
 * other value.
 *
 * ── WHERE THE PICTURES LIVE
 *
 * `app/public/login-bg/*.jpg`, named once each in `signin.css` as `/login-bg/<id>.jpg`.
 *
 * ★ NOT `public/images/`. That folder is regenerated from `data/images/` by `scripts/sync-extract.mjs`
 *   on every `npm run dev` and `npm run build`, and the script sweeps anything it did not write — a
 *   subfolder there makes it throw (`ERR_FS_EISDIR`) and takes both commands down with it. A sibling
 *   folder is not managed by the script and is the correct home for an asset the build does not view.
 */

/** One choice on the Settings picker, and the class that draws it. */
export interface LoginBgOption {
  /** The stored value. Also the `bgopt--` suffix of the class in `signin.css`. */
  id: string;
  /** Plain text. This goes inside an `<option>` and a `<label>`, both of which take no markup. */
  label: string;
  /** One clause saying what the option is. The licence note rides here when one applies. */
  hint: string;
  /**
   * The class carrying this option's background, read by `signin.css` for the screen itself and by
   * the picker's swatch for its thumbnail. Both read the same `--bg-layer` custom property — so a
   * picture is named once and drawn in two places, rather than a thumbnail list kept quietly in
   * step with a stylesheet.
   *
   * ★ THE FIVE PHOTOGRAPHS ALSO CARRY `bgopt--photo`, the treatment they have in common: the scrim
   *   and the light card. A drawn background needs neither, and five copies of those rules is five
   *   places to forget.
   */
  className: string;
  /**
   * The attribution line, when the licence requires one.
   *
   * ★ ONLY TWO OF THE EIGHT NEED THIS, AND THEY ARE THE TWO THAT KEEP THE FEATURE HONEST. Toronto,
   *   Boston and Ho Chi Minh City are CC0 or public domain, so a credit line would be noise; Raleigh
   *   and Office are CC BY, where the licence *requires* the attribution wherever the picture is
   *   shown. Carrying the string here rather than in the markup means an option cannot be added
   *   without its licence being visible at the point the option is defined.
   */
  credit?: string;
}

/**
 * The eight choices.
 *
 * ★ THE PHOTOS ARE FULL-BLEED ONLY — there is no split or pale variant of any of them. Each is
 *   `background-size: cover` on the whole screen, so the same picture at a narrow window is a
 *   different crop of the same thing rather than a second design to maintain.
 *
 * ★ `hint` IS PLAIN TEXT BECAUSE IT IS DESTINED FOR AN `<option>`. A `<b>` inside an option is not
 *   rendered by every browser and truncates the label silently in the ones that drop it.
 */
export const LOGIN_BG_OPTIONS: LoginBgOption[] = [
  {
    id: 'none',
    label: 'None',
    hint: 'The plain application background — what this screen has always looked like.',
    className: 'bgopt--none',
  },
  {
    id: 'toronto',
    label: 'Toronto skyline',
    hint: 'Night skyline. Public domain — no credit needed.',
    className: 'bgopt--toronto bgopt--photo',
  },
  {
    id: 'boston',
    label: 'Boston',
    hint: 'Financial district skyline. Public domain — no credit needed.',
    className: 'bgopt--boston bgopt--photo',
  },
  {
    id: 'hcmc',
    label: 'Ho Chi Minh City',
    hint: 'Night skyline. CC0 — no credit needed.',
    className: 'bgopt--hcmc bgopt--photo',
  },
  {
    id: 'raleigh',
    label: 'Raleigh',
    hint: 'Downtown Raleigh, North Carolina. CC BY 4.0 — the credit line is shown on the screen.',
    className: 'bgopt--raleigh bgopt--photo',
    credit: 'Photo: Raskuly, CC BY 4.0, via Wikimedia Commons',
  },
  {
    id: 'office',
    label: 'Office building',
    hint: 'A generic business address. CC BY 3.0 — the credit line is shown on the screen.',
    className: 'bgopt--office bgopt--photo',
    credit: 'Photo: Kehan Chen, CC BY 3.0, via Wikimedia Commons',
  },
  {
    id: 'mesh',
    label: 'Brand mesh',
    hint: 'Drawn in CSS from the brand colours — no image, no bytes, follows the theme.',
    className: 'bgopt--mesh',
  },
  {
    id: 'band',
    label: 'Brand band',
    hint: 'The brand colours as one stripe — drawn in CSS, no image, no bytes.',
    className: 'bgopt--band',
  },
];

/**
 * ★ TORONTO IS THE SHIPPED DEFAULT, AND ALSO THE FALLBACK FOR A DEFECTIVE STORE.
 *
 *   The two are the same value on purpose. A private-mode browser, a blocked storage API or a
 *   hand-edited value must all land where a first visit lands, and having one answer for "what this
 *   screen shows when nobody has said otherwise" is what stops those three cases drifting apart.
 */
export const DEFAULT_LOGIN_BG = 'toronto';

const STORAGE_KEY = 'projects-login-bg';
const CHANGE_EVENT = 'projects-login-bg-changed';

/**
 * The option for an id, defaulting when the id is not one we know.
 *
 * ★ THE VALIDATION IS THE POINT, AND IT RETURNS THE OPTION RATHER THAN THE ID. A caller that gets an
 *   option object back cannot accidentally apply `bgopt--undefined` — a class name built from an
 *   unrecognised string is exactly the silent failure this file exists to prevent: the class matches
 *   no rule, so the screen renders the default background while the preference *says* something else.
 */
export function loginBgOption(id: string | null | undefined): LoginBgOption {
  const found = LOGIN_BG_OPTIONS.find((option) => option.id === id);
  return found ?? LOGIN_BG_OPTIONS.find((option) => option.id === DEFAULT_LOGIN_BG)!;
}

/** Read the stored preference, falling back to the default for anything unrecognised. */
export function readLoginBg(): string {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw && LOGIN_BG_OPTIONS.some((option) => option.id === raw)) return raw;
  } catch {
    /* storage unavailable — the default below is the answer either way */
  }
  return DEFAULT_LOGIN_BG;
}

/** Write the preference and tell every mounted consumer. */
export function writeLoginBg(id: string): void {
  // ★ NORMALISED BEFORE STORING, so an id this build does not know cannot be written into the store
  //   and survive to be read back by one that does. The value written is always one of ours.
  const next = loginBgOption(id).id;
  try {
    window.localStorage.setItem(STORAGE_KEY, next);
  } catch {
    /* storage unavailable; the preference then just does not persist */
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: next }));
}

/**
 * The preference, subscribed, resolved to its option.
 *
 * Follows `useShowSql` exactly, including the two subscriptions: the custom event is what makes the
 * change land without a reload, and the `storage` event is what makes it land in a second tab —
 * which matters more here than for the SQL preference, because the screen being changed is the one
 * on the *other* side of the gate.
 */
export function useLoginBg(): [LoginBgOption, (next: string) => void] {
  const [id, setId] = useState<string>(readLoginBg);

  useEffect(() => {
    const sync = () => setId(readLoginBg());
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const set = useCallback((next: string) => {
    writeLoginBg(next);
    setId(loginBgOption(next).id);
  }, []);

  return [loginBgOption(id), set];
}
