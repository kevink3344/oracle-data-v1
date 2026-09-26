import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { startSession } from './data/session';

import './styles/tokens.css';
import './styles/base.css';
import './styles/components.css';
import './styles/shell.css';
import './styles/projects.css';
import './styles/panel.css';
import './styles/dashboard.css';
import './styles/newproject.css';
import './styles/objectdetail.css';
// After newproject.css on purpose: the search page extends the picker's classes.
import './styles/fundingsearch.css';
// The check register and its invoice panel. Unlike every other feature sheet this
// one brings its own search box rather than borrowing objectdetail's, so it does
// not have to come after any particular file.
import './styles/checks.css';
// The invoice register and its check panel — the same relation read from the other
// end. Independently loaded: it copies checks.css's search box and inherits only
// `.pager__gap`, which is global either way, so the order between the two does not
// matter.
import './styles/invoices.css';
// The activity register. Extends the drawer and combo classes rather than
// redeclaring them, so it has to come after panel.css and fundingsearch.css.
import './styles/activity.css';
// The budgeted accounts and their versions. The only sheet here that adds rules
// for a `tbody th`: the account is the *name* of its row, so the first column is a
// row header and inherits neither `padding` nor the `:first-child` wrap exception
// that `table.data td` gets. Coming after projects.css is what lets it say so.
import './styles/budgets.css';
// The view builder's editor and column picker. Before rail.css, which is the
// last word on the shell.
import './styles/viewbuilder.css';
// Saved Views: the watch table and its subscribe row. It is the *reader's* half of
// viewbuilder.css — the same `table.data` with a different set of columns — and it
// reuses `.vb-inline`, `.vb-pick`, `.vb-empty`, `.vb-null` and `.vb-table__key`
// from it without redeclaring any of them, so it comes immediately after it and
// before rail.css, which is the last word on the shell.
import './styles/savedviews.css';
// The purchase-order register and its order panel. Extends the same primitives
// checks.css does — it is the same table with a different set of columns — so it
// comes after it. Before rail.css, which is the last word on the shell.
import './styles/purchaseorders.css';
// The encumbrances register. Extends `table.data` and the panel primitives, and
// reuses `.scopenote__text` from budgets.css — so it comes after both. Before
// rail.css, which is the last word on the shell.
import './styles/encumbrances.css';
// Editing a project: the level picker (`LevelPicker`) and the budgets a level
// already carries. It extends `.combo*` / `.listbox*` / `.opt*` from
// newproject.css and `.field*` from the same file, so it has to come after it.
// Before rail.css, which is the last word on the shell.
import './styles/editproject.css';
// Settings: the organization accordion, its rows and its form. It owns the whole
// page, so it extends nothing and nothing extends it — but it still comes before
// rail.css, which is the last word on the shell.
import './styles/settings.css';
// Vendor companies: the payee register and its check panel. Extends `table.data`,
// `.panel`, `.filterbar`, `.pager`, `.dsec` and the `.drawer` primitive from
// projects.css / panel.css / components.css, and reuses `.chkstats`/`.chkstat*`,
// `.chkrows`/`.chkrow*`, `.chkempty` and `.chknote` from checks.css — so it comes
// after every one of them, and it redeclares none of them. Before rail.css, which
// is the last word on the shell.
import './styles/vendors.css';
// Custom field values: the pencil, the trash and the changed-value gear mark, on a
// vendor's name wherever it is shown. It decorates `.drawer__name` from panel.css
// (overridden
// per panel in vendors.css) and a cell inside `table.data.vctable` / `.vstable`, and
// it reuses `.sr` from base.css and `.scopenote` from shell.css, which it adds one
// variant to — so it comes after all four. Before rail.css, which is the last word
// on the shell.
import './styles/customfields.css';
// The read-cap register and its panel. Reuses `.drawer` from panel.css, `.field` /
// `.input` / `.btn` from components.css and `.table-wrap` from base.css, so it only
// adds the parts with no ancestor to inherit from — the register rows, the form and
// the preview. It follows customfields.css because it also uses `.sr`.
import './styles/readcaps.css';
// The SQL annotation shown when a reader turns the trace on in Settings: the note
// beside a scope line, the compact form under a stat card, and the page-level
// disclosure. It extends nothing and is extended by nothing — it introduces
// `--sql-fg` (defined in tokens.css) and three independent class families — so its
// position is free. Placed here rather than earlier because it is a *reading aid*
// layered over whatever page it appears on, and it must not be the sheet that
// decides anything about a table or a panel.
import './styles/sql.css';
// One project as a page. It reuses `.dsec`, `.spine`, `.usage-head`, `.stats` and
// `.legend` from panel.css and `.drawer__eyebrow`/`__meta`/`__chips` from the same
// file, so it has to come after panel.css — and it redeclares none of them. It only
// adds the page frame: the head, the action row and the reading measure.
import './styles/projectpage.css';
import './styles/lineage.css';
// Last, and after shell.css in particular: it expands the rail into a tree, so it
// has to be able to override the rail's own rules.
import './styles/rail.css';
// The login screen and its brand block. Imported after everything above for two
// reasons: it reuses `.idcard` and `.idcard__actions` from settings.css, and it is
// the one page that is *not* inside the shell — so wherever it and a shell sheet
// disagree about the same element, this one is the page being looked at. It never
// disagrees without saying so in a comment.
import './styles/signin.css';

const container = document.getElementById('root');
if (!container) throw new Error('index.html is missing #root.');

/**
 * Ask the server who this browser is, once, before anything renders.
 *
 * ★ CALLED BEFORE `render`, AND DELIBERATELY NOT FROM AN EFFECT. A stored token
 *   means the answer is a round trip, and a request started in an effect would
 *   paint the signed-out shell first and then correct itself — the rail would grow
 *   a gear and the avatar would change name a beat after load. Starting the fetch
 *   here means the store already holds `null` (the one honest "not known yet")
 *   when the first paint happens, and the rail renders the gear only once the answer
 *   says it should.
 *
 * ★ NOTHING AWAITS IT. With no stored token — the common case — it returns without
 *   a request at all, so there is nothing to wait for; with one, the app is usable
 *   while the answer is in flight and a failure leaves it signed out rather than
 *   stuck. The rejection is caught inside `startSession`.
 */
void startSession();

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
