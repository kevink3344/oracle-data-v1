/**
 * The application's mark: the logo, the product's name and its tagline.
 *
 * ── WHY THIS IS A COMPONENT AND NOT TWO LINES OF JSX ON THE LOGIN SCREEN
 *
 * The sign-in screen is where the mark matters most, but it is not the only place
 * that has to say what this app is called: the gate renders the same block while it
 * waits for the session, and a reader who reloads a deep link sees it too. Three
 * copies of an `<img src>` and a name is how the name ends up spelt two ways, which
 * is the failure `data/session.ts` was written to fix for a *person's* name — the
 * same argument applies to the product's.
 *
 * ── WHY THE IMAGE IS NOT ALLOWED TO FAIL SILENTLY
 *
 * `scripts/sync-extract.mjs` copies `data/images/` into `app/public/images/` before
 * every dev run and every build, so in a normal checkout the file is there. It is
 * deliberately skipped when `data/images/` is absent — a checkout without the art is
 * a real state and the sync script says so rather than creating an empty folder that
 * would *look* synced. The consequence lands here: on such a checkout `/images/oracle.png`
 * is a 404 and the browser renders a broken-image box. So the failure is caught and
 * the mark is *drawn* instead.
 *
 * ★ THE FALLBACK IS THE SAME MARK, NOT A MONOGRAM. Substituting `OP` on a coloured
 *   square would put a different logo where the logo should be — a reader cannot tell
 *   "the logo is missing" from "the logo has changed", and the second reading is the
 *   wrong one. The Oracle oval is four numbers in an SVG, so the honest fallback is
 *   cheap: `stroke` on a pill-shaped `rect` is the same shape the PNG holds.
 *
 * ── THE PLATE, AND WHY IT IS WHITE IN BOTH THEMES
 *
 * The PNG has an opaque near-white background rather than transparency, so on the
 * dark theme's `--surface` (#131e33) it would paint a bright rectangle with hard
 * corners. It therefore sits on a small fixed-white plate with a hairline edge. That
 * plate is **not** theme-aware on purpose: tinting it with `--surface` would show as a
 * visible seam around an image that still has its own background, which reads as a
 * rendering bug rather than as a frame.
 */

import { useState } from 'react';
import { APP_NAME, APP_TAGLINE } from '../data/brand';

/** Where the sync script puts the art, served from `app/public/`. */
const LOGO_SRC = '/images/oracle.png';

/** The Oracle oval, drawn — the fallback when the PNG cannot be fetched. */
function OracleOval() {
  return (
    <svg className="appbrand__oval" viewBox="0 0 100 84" aria-hidden="true" focusable="false">
      <rect
        x="8"
        y="16"
        width="84"
        height="52"
        rx="26"
        fill="none"
        stroke="#c74634"
        strokeWidth="16"
      />
    </svg>
  );
}

export default function AppBrand({
  /*
   * ★ THE TAGLINE IS THIS PROP'S DEFAULT RATHER THAN SOMETHING THE CALLERS PASS.
   *   Both screens that render this block want the product's own tagline, so the
   *   prop written at each call site would be two copies of one string waiting to
   *   drift — the thing `data/brand.ts` was created to stop. It stays a prop so a
   *   future screen can say something else about itself without a second component.
   */
  sub = APP_TAGLINE,
  heading = false,
}: {
  sub?: string;
  heading?: boolean;
}) {
  const [broken, setBroken] = useState(false);

  /*
   * ★ THE NAME IS A HEADING ONLY WHERE IT IS THE NAME OF THE PAGE.

   *   On the login screen the app's name *is* the title of the screen, so it is the
   *   `<h1>` and the form's own label is a level below it. Inside the shell it is a
   *   wordmark beside the navigation and a heading there would put a second `<h1>` on
   *   every page in the app, competing with the page's own. `heading` is the one bit of
   *   context this component cannot work out for itself.
   */
  const Name = heading ? 'h1' : 'span';

  return (
    <div className="appbrand">
      <span className="appbrand__plate">
        {broken ? (
          <OracleOval />
        ) : (
          /*
            ★ `alt=""` BECAUSE THE NAME IS THE NEXT THING IN THE BLOCK. The mark and
              the name under it are one lockup; a screen reader that read the image as
              well would say the product name twice, once as an unreadable filename.

            ★ THE NUMBERS ARE THE ART'S OWN RATIO AND NOT A SIZE TO RENDER AT.
              `.appbrand__logo` is sized by the plate (100% of its content box), so
              these two attributes govern nothing about the final layout — what they
              do is give the browser the aspect ratio *before* the PNG has arrived, so
              the mark does not jump when it loads. `oracle.png` is 360×325, so these
              are that ratio at about a seventh scale; the pair that was here before
              (34×28) was not the art's ratio at all, which is the sort of thing
              nothing would ever have reported.
          */
          <img
            className="appbrand__logo"
            src={LOGO_SRC}
            alt=""
            width={51}
            height={46}
            onError={() => setBroken(true)}
          />
        )}
      </span>
      <div className="appbrand__words">
        <Name className="appbrand__name">{APP_NAME}</Name>
        {sub ? <div className="appbrand__sub">{sub}</div> : null}
      </div>
    </div>
  );
}
