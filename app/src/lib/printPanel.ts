/* ============================================================================
   Exporting a panel to PDF.

   Every export in the app is CSV, which is the right shape for the data and the
   wrong one for the figures. A CSV of the project drawer throws away the usage
   bar, the chips, the cost-code spine and the layout that makes the numbers
   readable; a CSV of the vendor panel loses the bar that shows the vendor's
   share of the object code. So "Export to PDF" prints the panel as it stands,
   formatting and all.

   The implementation clones the live element into an off-screen iframe carrying
   the app's own stylesheets. The alternative — redrawing the panel with a PDF
   library — would mean a second copy of every figure, bar and table kept in step
   with the first forever, and it still would not match: the clone inherits the
   tokens, the responsive rules and the filter highlights for free. Cloning also
   keeps one source of truth for what the panel contains, so a section added to
   the screen appears in the export without being added twice.

   The browser turns the print into the PDF. That is deliberate: it is the only
   route to a file with selectable, searchable text rather than a picture of a
   page, and it hands the reader the paper size and orientation options instead
   of guessing at them.
   ============================================================================ */

/*
 * ★ THE MASTHEAD CARRIES THE PRODUCT'S NAME AND NOT THE REGISTER'S. A printed sheet
 *   is headed with *what this is*, and what it is is `APP_NAME` — every export already
 *   carries its own register title underneath this line. The string is imported rather
 *   than written out a fourth time, so a rename lands here with the rail, the login
 *   card and the browser tab; `data/brand.ts` is where it is defined.
 */
import { APP_NAME } from '../data/brand';

export type Orientation = 'portrait' | 'landscape';

/**
 * A4 at 96 dpi, less the 12 mm margin the print stylesheet asks for. The frame
 * is laid out at exactly the width the printed page box will give it, because
 * the app's own rules are responsive: a frame of a different width settles on
 * different breakpoints and would print a layout the reader never saw on screen.
 */
const PAGE_WIDTH: Record<Orientation, number> = { portrait: 703, landscape: 1032 };

const FRAME_ID = 'print-frame';

export interface PrintOptions {
  /** The document title, which is the name the save dialog offers as a file. */
  title: string;
  /** One muted line under the masthead saying what is in this document. */
  scope?: string;
  orientation?: Orientation;
  /**
   * Selector for nodes to leave out of the clone.
   *
   * For an export of everything on screen when a *different* panel is open over
   * it: printing the page should print the page, not the page with the vendor
   * slide-out stapled to the end of it. A panel is included by its own export
   * and by an export of something that contains it; this is for the case where
   * it happens to be a descendant of the node being printed without being part
   * of it.
   */
  omit?: string;
}

/**
 * The rules that turn a screen panel into a page.
 *
 * Everything here is print-only, so it lives with the printer rather than in the
 * app's sheets — the app has to keep behaving like an app when someone presses
 * Ctrl+P on the shell.
 */
function printCss(orientation: Orientation): string {
  return `
/* A browser drops backgrounds by default, which would take every bar fill,
   chip tint and status colour with it and print the panel as a grey wireframe
   of itself. */
* {
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}

@page {
  size: A4 ${orientation};
  margin: 12mm;
}

html,
body {
  height: auto;
  /* The app's own page ground is a grey; a document wants white, and an
     edge-to-edge tint would print on every sheet. */
  background: #fff;
}

/* Chrome that only exists to drive the screen: the resize handle, the close
   buttons, the pager, the filter box, and the export buttons themselves —
   without this the panel's foot prints a row of buttons onto the page. */
.drawer__grip,
.drawer__close,
.drawer__foot,
.vdpanel__foot,
.pager,
.filterbar,
.page-head__actions,
.crumbs,
.hbar__go,
.vdproj__go,
.objtable__none button,
.po-more {
  display: none !important;
}

/* Only the panel this document is about prints. A clone can hold another one —
   the project drawer is mounted app-wide, so it is a sibling of every route —
   and the marker is what distinguishes the subject of the document from a
   panel that merely happens to be on screen. Keying this off the open-state
   class instead would lose the export when the reader hits the button while the
   panel is still animating open or closed. */
.drawer:not([data-print]),
.vdpanel:not([data-print]) {
  display: none !important;
}

/* An open panel stops being a viewport-pinned dialog. Left alone it prints one
   clipped screenful, still carrying the transform its slide-out came to rest on,
   with everything past the fold scrolled out of existence. */
.drawer,
.vdpanel {
  position: static !important;
  display: block !important;
  width: auto !important;
  max-width: none !important;
  height: auto !important;
  max-height: none !important;
  padding: 0 !important;
  transform: none !important;
  visibility: visible !important;
  border: 0 !important;
  box-shadow: none !important;
  overflow: visible !important;
}

/* Same reasoning one level in: a scroll box prints what is in view, so the
   drawer's body would end at the bottom of the screen and take the rest of the
   project with it. */
.drawer__body,
.vdpanel__body,
.table-wrap {
  overflow: visible !important;
  height: auto !important;
  max-height: none !important;
  flex: none !important;
}

/* A document header, so a printed page says where it came from. The panel's own
   heading follows immediately below it, which is why this is a masthead and a
   scope line rather than a second title. */
.print-head {
  margin: 0 0 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
}

.print-head__mast {
  font-family: var(--font-mono);
  font-size: 0.625rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-faint);
}

.print-head__scope {
  margin-top: 4px;
  font-size: 0.75rem;
  color: var(--text-muted);
}

/* A heading stranded at the foot of a page is the classic print defect. */
.panel__head,
.dsec__head {
  break-after: avoid;
}

/* Nor does a figure break away from the label that explains it. */
.panel__head,
.dsec__head,
.kpi,
.stat,
.bucket,
.line,
.hbar__row,
.watch__item,
.vdproj > li,
.vdlines > li {
  break-inside: avoid;
}

/* The two-up panels fit a page between them; breaking one in half to save a
   sheet reads worse than the white space. The table cannot be kept whole, so it
   breaks — with its column headings repeated on every page. */
.grid-2 > .panel {
  break-inside: avoid;
}

table.data {
  width: 100%;
}

table.data thead {
  display: table-header-group;
}

table.data tr {
  break-inside: avoid;
}
`;
}

/** A local date and time, because a printed figure has to say when it was true. */
function stamp(): string {
  return new Date().toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function masthead(opts: PrintOptions): HTMLElement {
  const head = document.createElement('header');
  head.className = 'print-head';

  // Built with textContent rather than a template string: the scope line carries
  // the reader's own filter text and vendor names, which are Oracle data.
  const mast = document.createElement('p');
  mast.className = 'print-head__mast';
  mast.textContent = `${APP_NAME} · Oracle extract · printed ${stamp()}`;
  head.appendChild(mast);

  if (opts.scope) {
    const scope = document.createElement('p');
    scope.className = 'print-head__scope';
    scope.textContent = opts.scope;
    head.appendChild(scope);
  }

  return head;
}

/**
 * Prints `source` as it currently stands, styling and all.
 *
 * `source` is a live node — the panel's own root, or the page's — so whatever is
 * on screen is what goes on the page: the current filter, the rows the pager is
 * showing, the collapsed state of anything that is collapsed.
 */
export function printElement(source: HTMLElement, opts: PrintOptions): void {
  const orientation = opts.orientation ?? 'portrait';

  // One frame at a time. A second export while the first dialog is still open
  // replaces the first document rather than leaving two to choose between.
  document.getElementById(FRAME_ID)?.remove();

  const frame = document.createElement('iframe');
  frame.id = FRAME_ID;
  frame.title = opts.title;
  frame.setAttribute('aria-hidden', 'true');
  frame.tabIndex = -1;
  // It has to be laid out — `display: none` gives a frame no layout and it
  // prints nothing — and it has to be laid out at the page's own width. Off
  // screen is the one arrangement that gives both without showing anything.
  frame.style.cssText = [
    'position:fixed',
    'top:0',
    'left:-20000px',
    `width:${PAGE_WIDTH[orientation]}px`,
    'height:1000px',
    'border:0',
    'z-index:-1',
  ].join(';');
  document.body.appendChild(frame);

  const win = frame.contentWindow;
  const doc = frame.contentDocument;
  if (!win || !doc) {
    frame.remove();
    return;
  }

  // The clone is always printed light, whatever the reader's theme. A PDF is a
  // document: it is shared, emailed and put on paper, and the dark theme's
  // ground would print as a page of ink.
  doc.documentElement.setAttribute('lang', 'en');
  doc.documentElement.setAttribute('data-theme', 'light');
  doc.title = opts.title;

  const charset = doc.createElement('meta');
  charset.setAttribute('charset', 'utf-8');
  doc.head.appendChild(charset);

  // The app's own sheets, taken from the document rather than imported: in the
  // build they are one hashed <link> and in dev they are injected <style> tags,
  // and this picks up whichever is there — including the Open Sans link.
  for (const node of document.querySelectorAll('link[rel="stylesheet"], style')) {
    doc.head.appendChild(node.cloneNode(true));
  }

  const rules = doc.createElement('style');
  rules.textContent = printCss(orientation);
  doc.head.appendChild(rules);

  doc.body.appendChild(masthead(opts));

  const body = source.cloneNode(true) as HTMLElement;
  if (opts.omit) {
    for (const el of body.querySelectorAll(opts.omit)) el.remove();
  }

  const panel = body.matches('.drawer, .vdpanel') ? body : body.querySelector('.drawer, .vdpanel');
  // The panel handed to us is the document's subject; anything else that looks
  // like a panel in the clone is not, and the stylesheet hides it.
  panel?.setAttribute('data-print', '');
  // Identity and behaviour, not content. `role="dialog" aria-modal="true"` on a
  // document that contains nothing else announces a modal with no way out, and
  // the closed-state `aria-hidden` and `tabindex` are both screen-only concepts.
  for (const el of [panel, body].filter(Boolean) as HTMLElement[]) {
    el.removeAttribute('role');
    el.removeAttribute('aria-modal');
    el.removeAttribute('aria-hidden');
    el.removeAttribute('tabindex');
  }
  doc.body.appendChild(body);

  // The dialog blocks, so the frame has to outlive the call to print. The
  // browser tells us when the reader is done with `afterprint`; the timer is for
  // the browsers that never send it, and for the case where printing is blocked
  // outright and the frame would otherwise sit in the DOM forever.
  const opener = document.activeElement as HTMLElement | null;

  const teardown = (restoreFocus: boolean) => {
    frame.remove();
    // `focus()` on the frame below is what makes Chrome print the frame rather
    // than the app around it — a frame that is not focused is not the thing
    // window.print() acts on. It takes focus out of the app with it, so putting
    // it back is what keeps the drawer's Tab trap and its Escape-to-close
    // working after an export.
    if (restoreFocus && opener?.isConnected) opener.focus();
  };

  const onAfterPrint = () => {
    win.removeEventListener('afterprint', onAfterPrint);
    teardown(true);
  };
  win.addEventListener('afterprint', onAfterPrint);

  // Fonts are the one thing here that is fetched rather than computed: Open Sans
  // arrives over the network, and printing before it lands gives a PDF in the
  // fallback face. Wait for it, but never let a slow font hold up the dialog.
  const fonts = doc.fonts ? doc.fonts.ready : Promise.resolve();
  const settled = Promise.race([
    fonts,
    new Promise((resolve) => setTimeout(resolve, 1500)),
  ]);

  void settled.then(() => {
    try {
      win.focus();
      win.print();
    } catch {
      // A browser that refuses to open the dialog leaves nothing to clean up
      // beyond the frame itself — and nothing took focus, so nothing to restore.
      teardown(false);
      return;
    }
    setTimeout(() => {
      win.removeEventListener('afterprint', onAfterPrint);
      // Late, and by now the reader is somewhere else in the app; removing the
      // frame is all that is owed here, not a focus jump.
      teardown(false);
    }, 30_000);
  });
}
