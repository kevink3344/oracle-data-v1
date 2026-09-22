/**
 * The product's identity — its name and its tagline — in one place.
 *
 * ── WHY THIS IS A MODULE AND NOT A CONSTANT INSIDE THE MARK'S COMPONENT
 *
 * Four things write this product's name, and they must not disagree: the brand
 * block on the sign-in screen, the same block on the card the session gate shows
 * while it waits, the wordmark at the top of the rail, and the masthead of a
 * printed export. `AppBrand` used to own the string and the other three each held
 * a copy of it, which is how a product ends up with two names — the same failure
 * `data/session.ts` exists to fix for a *person's* name, and the reason a rename
 * is one edit here rather than four edits that have to agree by hand. The
 * browser tab in `index.html` carries the fourth copy, and a `.html` file cannot
 * import: that one is written out, and this comment is what points at it.
 *
 * ★ IT IS NOT A THEME TOKEN AND SO IT IS NOT IN `styles/`. Nothing here is a
 *   colour or a measurement; it is the text. `tokens.css` is a stylesheet, and a
 *   name is not a token.
 */

/** The name of the product, as it is written everywhere. */
export const APP_NAME = 'Oracle Projects & Accounts';

/**
 * The line under the name.
 *
 * ★ IT IS NOT A DESCRIPTION OF THE REGISTER, AND THE ONE IT REPLACED WAS. The
 *   line used to read "Chart of accounts" — a *screen* — sitting under the
 *   product's name on the sign-in card and in the rail as though the product
 *   were that screen. A tagline says something about the whole thing, which is
 *   what makes it a tagline; this one says what the reader gets rather than what
 *   the software contains.
 */
export const APP_TAGLINE = 'Live data. Clear insight.';
