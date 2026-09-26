import type { ReactElement } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { StoreProvider } from './state/store';
import AppBrand from './components/AppBrand';
import Rail from './components/Rail';
import TopBar from './components/TopBar';
import Dashboard from './routes/Dashboard';
import Projects from './routes/Projects';
import ProjectDetailPage from './routes/ProjectDetailPage';
import NewProject from './routes/NewProject';
import EditProject from './routes/EditProject';
import FundingSearch from './routes/FundingSearch';
import ObjectDetail from './routes/ObjectDetail';
import Activity from './routes/Activity';
import Pinned from './routes/Pinned';
import SavedViews from './routes/SavedViews';
import Checks from './routes/Checks';
import Invoices from './routes/Invoices';
import ViewBuilder from './routes/ViewBuilder';
import ViewResultWindow from './routes/ViewResultWindow';
import Settings from './routes/Settings';
import ReadCaps from './routes/ReadCaps';
import SignIn from './routes/SignIn';
import Budgets from './routes/Budgets';
import PurchaseOrders from './routes/PurchaseOrders';
import Encumbrances from './routes/Encumbrances';
import VendorCompanies from './routes/VendorCompanies';
import VendorSites from './routes/VendorSites';
import Pending from './routes/Pending';
import { ALL_LEAVES } from './nav/menu';
import { useSession } from './data/session';
import { NavDrawerProvider, useNavDrawer } from './state/navDrawer';

/**
 * The routes are generated from the menu, not written beside it.
 *
 * That is the whole point of `nav/menu.ts` being data. When the rail and the
 * router were two hand-maintained lists, they disagreed in the one direction
 * that fails quietly: the rail offered eight destinations that had no `<Route>`,
 * each of which fell through to `path="*"` and landed back on the Dashboard
 * looking like a click that did nothing. Here a leaf cannot exist without a URL,
 * and a URL cannot exist without a route — the only thing left to get wrong is a
 * screen that is genuinely not built, and that case is explicit (see `SCREENS`)
 * and lands on `Pending`, which names the reason.
 */

/**
 * The leaves that have a screen, by URL. Everything else in the menu routes to
 * `Pending`.
 *
 * Written as a map rather than a `built` flag consulted at render time so that
 * *which* component serves a leaf is readable in one place. The menu's `built`
 * flag is set from this same knowledge, in `menu.ts`, and the two are kept honest
 * by the check below. (Deliberately no count of built leaves here: it was wrong
 * twice, and a number nobody can verify is worse than no number.)
 */
const SCREENS: Record<string, ReactElement> = {
  '/': <Dashboard />,
  '/projects': <Projects />,
  // What changed in the database on one day, table by table. The only screen here
  // that reads the catalogue rather than the contents, and the only one that can
  // say which tables cannot date their own rows at all.
  '/activity': <Activity />,
  '/pinned': <Pinned />,
  // ★ The reader's side of the View Builder: the views this person watches, with the count when
  // they subscribed beside the count now. It is here, next to Pinned, because both leaves are
  // *your stuff* rather than *the data* — Pinned is your shortcuts, Views is your watches —
  // whereas `/admin/views` is where a view is **authored**. The two are one leaf apart in the
  // rail and they read the same tables, which is exactly why the distinction has to be drawn in
  // the rail rather than in the URL: only one of them runs SQL.
  '/views': <SavedViews />,
  // The combination search page. Still served at `/funding/search`, which now
  // redirects here: §10.1 wants the URL to say what the page searches, and a
  // combination belongs to the chart of accounts rather than to funding.
  '/coa/combinations': <FundingSearch />,
  // The payments register. The only screen that reads the AP extract rather than
  // the purchase-order one, and the only one whose rows are payment documents
  // rather than commitments — which is why its panel can say what actually left
  // the bank. Built on the WCSEXP_* views being opened up.
  '/spend/payments': <Checks />,
  // The invoice register — the same relation as the payments page, read from the
  // other end, and deliberately the same table shape with the axes swapped. It
  // reads its own extract rather than inverting the checks one, because
  // `INVOICE_NUM` is not a key: 142 invoices in this window share one number.
  '/spend/invoices': <Invoices />,
  // The first screen in the app that writes. It is here rather than beside the
  // other admin leaves because it is the only one with a server surface behind
  // it — `docs/plans/view-builder.md` §17, items 1–7, are that surface, and they
  // were built before this line existed.
  '/admin/views': <ViewBuilder />,
  // The organization register. ★ The first screen in the app that is refused
  // rather than merely hidden: a member can reach this URL and the page tells them
  // so, because the four endpoints behind it call `requireSuperAdmin` and a hidden
  // gear in the rail is not an access control. It is also the first screen whose
  // subject is *which rows the app reads* rather than what is in them.
  '/settings': <Settings />,
  // The per-object read caps. ★ The only screen in the app whose subject is **how
  // much the app reads** rather than what is in the data: the EBS instance holds
  // tables in the hundreds of millions of rows, and a register that reads one of
  // those whole is a request that never returns. An administrator bounds each
  // object here, and the panel runs the statement before saving it so a cap is
  // something that was looked at rather than a number in a box.
  '/admin/read-caps': <ReadCaps />,
  // The budgeted accounts. ★ The only screen in the app that reads **no extract
  // at all** — the eight files in `public/oracle/` are every one of them
  // commitments or spend, and not one carries a budget position. `V_BUDGET_BY_ACCOUNT_PERIOD`
  // and `V_ACCOUNT_POSITION` are served straight off the database instead, which
  // makes this the first page whose data can be absent for a reason other than a
  // failed fetch: the view answers, and it is nearly empty. The screen is built
  // around that answer rather than despite it.
  '/funding/budgets': <Budgets />,
  // The commitments register. ★ The only screen whose *columns* come from the
  // account rather than from the document: a purchase order has no project of its
  // own — `EXP_PROJECT_NAME` is null on all 749 rows of `PO_HEADERS_ALL` — so the
  // project column is `SEGMENT5` of the account each line is charged to, where 739
  // of 741 orders sit on exactly one level. It reads the same extract the projects
  // page sums, deliberately: the database's distributions total the same orders
  // $11,511.12 differently, and two figures for one thing is the failure this app
  // is built to avoid.
  '/procurement/purchase-orders': <PurchaseOrders />,
  // ★ The only screen in the app that reads two populations and refuses to add
  // them up. The purchasing extract carries a commitment against 335 account
  // combinations and the custom report's ledger side carries four, and the schema
  // says in as many words that the two will not agree *“and the disagreement is a
  // fact about the data rather than a bug”*. So the four accounts both sides hold
  // carry the only difference computed here, no combined total exists, and the
  // page states in prose that its purchasing figure is a mirror of the ordered
  // amount and its blank GL cells mean *not in the extract* rather than *zero*.
  '/spend/encumbrances': <Encumbrances />,
  // The payees. ★ The only screen in the app whose rows are **companies rather than
  // documents**, and the only one that reads its two halves from two different
  // places on purpose: the payments come from the AP extract (nothing else records
  // who was paid), and the master record is looked up live in `PO_VENDORS` one
  // company at a time, because that table holds 79,685 rows for this tenant and
  // downloading it to show four fields per vendor would be 160 requests for
  // nothing. It is also the only screen that groups payments by the **document
  // that settled them** — a check can pay several vendors and the ledger does not
  // record the split, so the panel shows the check's own amount and the invoices
  // it reached side by side and derives neither from the other.
  '/vendors/companies': <VendorCompanies />,
  // The address level under a company — one vendor, many sites, and a purchase order
  // names the site rather than the company. ★ The only screen in the app whose rows
  // are **sites** rather than documents or companies, and the only one that partitions
  // its population on a judgement rather than a filter: `Active` and `Deprecated` are
  // two views of one register, both counted in every total on the page, and the
  // Deprecated tab names the evidence that put each row there because the obvious
  // rule — a site code reading `DO NOT USE` — matches none of the 800 rows here.
  '/vendors/sites': <VendorSites />,
};

// A key here that is not a leaf would never be routed to — the screen would exist
// and be unreachable, with nothing failing. Two lines to make that loud in dev,
// given the entire reason this file is generated.
if (import.meta.env.DEV) {
  const known = new Set(ALL_LEAVES.map((leaf) => leaf.to));
  for (const to of Object.keys(SCREENS)) {
    if (!known.has(to)) {
      console.warn(
        `[routes] "${to}" has a screen in SCREENS but is not a leaf in nav/menu.ts, ` +
          `so no <Route> was generated for it and nothing links to it.`,
      );
    }
  }
}

export default function App() {
  return (
    <Routes>
      {/*
        ★ THE ONE ROUTE OUTSIDE THE GATE, AND IT IS WRITTEN FIRST ON PURPOSE.

        It is a sibling of the gate rather than a path the gate allows through, so
        "is this screen reachable signed out?" is answered by *where the line is* in
        this file rather than by a condition inside `Gate` that a later change could
        widen by accident. There is exactly one such line and one screen above it.
      */}
      <Route path="/sign-in" element={<SignIn />} />

      {/*
        ★ EVERYTHING ELSE IS BEHIND THE SESSION, INCLUDING THE ROUTES THAT DO NOT
          APPEAR IN ANY MENU.

        The gate is a pathless layout route, so it wraps the whole inner tree rather
        than a list of paths somebody has to keep complete — `/projects/new`,
        `/objects/:object`, `/projects/:slug/edit` and the `*` fallback are all
        inside it. A gate written as a list of protected paths is a gate that is
        correct until the next route is added, and adding a route is the one thing
        this file is *for* (see the note on `SCREENS`).
      */}
      <Route element={<Gate />}>
        {/*
          ★ THE RESULT WINDOW IS INSIDE THE GATE BUT OUTSIDE THE SHELL, AND BOTH
            HALVES OF THAT ARE DELIBERATE.

            Inside the gate, because it runs a saved view and a view is a row the
            server guards — an unauthenticated reader gets the sign-in screen, which
            is the same answer every other guarded read gives.

            Outside the shell, because the shell is a rail and a topbar, and the
            whole point of this page is to be the result and nothing else. Rendered
            inside it the table was letterboxed between the nav and the page
            padding, which is the layout the page exists to escape.

            It sits between the two `<Route>` elements rather than inside either,
            so "is this chrome-free?" is answered by where the line is in this file
            rather than by a conditional a later change could widen.
        */}
        <Route path="/admin/views/:id/result" element={<ViewResultWindow />} />

        <Route element={<Shell />}>
          {ALL_LEAVES.map((leaf) => (
            <Route key={leaf.to} path={leaf.to} element={SCREENS[leaf.to] ?? <Pending />} />
          ))}

          {/* Reachable but deliberately not a menu leaf: it is a step in a task,
              not a destination a reader would look for in a tree. §10.1. */}
          <Route path="/projects/new" element={<NewProject />} />

          {/* ★ ONE PROJECT, AS A PAGE — `/projects/0450`. It replaced a sliding panel at the
              user's request. The key is the LEVEL rather than the registry slug, because a
              project in this app IS a level and this page has to open on all 139 of them,
              while only ~10 have a registry row. `:slug/edit` below keeps the slug, because
              a write needs the row that carries it. */}
          <Route path="/projects/:level" element={<ProjectDetailPage />} />

          {/* The same argument as `/projects/new`, and the same shape of URL: the
              key is derived from the name, so it can be any string and it comes
              from a row rather than from the menu. Reachable from two places —
              the recorded rows' Edit button on the projects list, and the Edit
              link in the detail drawer's cost-centre section — which is why it
              has to cope with a key the registry no longer holds. §10.1. */}
          <Route path="/projects/:slug/edit" element={<EditProject />} />

          {/* The generic row detail view. Every leaf's row links here rather than
              each block growing its own detail screen. §10.1. */}
          <Route path="/objects/:object" element={<ObjectDetail />} />

          {/* The old address of the combination search page. Kept so a bookmark
              and a link in a conversation both still land somewhere. */}
          <Route path="/funding/search" element={<Navigate to="/coa/combinations" replace />} />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Route>
    </Routes>
  );
}

/**
 * The session gate.
 *
 * ── ★ THREE STATES, AND CONFLATING TWO OF THEM IS THE WHOLE BUG THIS AVOIDS
 *
 * `useSession()` answers `null` in exactly one situation: a token is held and the
 * server has not been asked yet. `authenticated: false` is a different sentence —
 * the question was put and the answer was no.
 *
 * So `null` must **not** redirect. A signed-in reader who reloads `/projects` has no
 * session for the first paint and a valid one a few hundred milliseconds later; a gate
 * that treated "not known yet" as "not signed in" would send them to the login screen,
 * where the boot request would then succeed and leave them signed in, on a page they
 * did not ask for, having been bounced out of the one they did. Waiting is the correct
 * answer to not knowing, and the wait is one round trip that usually does not happen
 * at all `startSession` returns without a request when no token is stored.
 *
 * ── ★ WHY `state.from` AND NOT A FIXED LANDING PAGE
 *
 * A gated app turns every deep link into a two-step journey, so the second step has to
 * remember the first. The location is handed to `/sign-in` in router state — not in a
 * query string, which would leave a URL in the address bar that looks shareable and is
 * not — and the sign-in screen prefers it over its own role-based default.
 */
function Gate() {
  const user = useSession();
  const location = useLocation();

  if (user === null) return <CheckingSession />;

  if (!user.authenticated) {
    return <Navigate to="/sign-in" replace state={{ from: location }} />;
  }

  return <Outlet />;
}

/**
 * What the gate shows while it waits for the answer.
 *
 * ★ IT IS BRANDED, AND IT IS NOT A SPINNER. The wait is one request against a server
 *   on the same machine and is usually not visible at all, so this is not a loading
 *   *experience* — it exists so that the moment is not a white flash between the brand
 *   and the app. A spinner would announce a delay that mostly is not there; the same
 *   mark and one sentence do not.
 *
 * `role="status"` because it is a polite announcement of a state, and the state is the
 * only thing on the screen.
 */
function CheckingSession() {
  return (
    <div className="signin">
      <div className="signin__card">
        <AppBrand />
        <p className="signin__status" role="status">
          Checking your session…
        </p>
      </div>
    </div>
  );
}

/**
 * The application, once somebody is signed in: the rail, the top bar and the page.
 *
 * ★ `StoreProvider` LIVES HERE RATHER THAN ABOVE THE GATE, AND THAT IS A CHANGE OF
 *   BEHAVIOUR RATHER THAN TIDYING. The provider is what fetches the extract — two
 *   megabytes of JSON that every register is built from. Mounted above the gate it was
 *   fetched before anything rendered, including for a reader whose only business was
 *   the login screen. A session is now the precondition for wanting the ledger, so the
 *   ledger is not fetched until there is one.
 *
 * Nothing outside this component reads the store: every consumer is inside the shell.
 */
function Shell() {
  return (
    <StoreProvider>
      <NavDrawerProvider>
        <a className="skip" href="#main">
          Skip to content
        </a>
        <ShellFrame />
      </NavDrawerProvider>
    </StoreProvider>
  );
}

/**
 * The shell's markup, inside the drawer provider so the backdrop can read its state.
 *
 * ★ THE BACKDROP IS A SIBLING OF `.shell` RATHER THAN A CHILD, AND THE REASON IS
 *   STACKING. `.shell` is a flex row; a child of it would be a flex item, laid out
 *   beside the rail instead of over the page, and giving it `position: fixed` to
 *   escape that would still leave it inside `.shell`'s stacking context — so a rail
 *   with a `z-index` would paint above it. Outside, both are positioned against the
 *   viewport and their order is decided by one number each.
 *
 *   It is rendered only while the drawer is open, so a closed drawer leaves no
 *   full-screen element in the tab order for a keyboard user to walk into.
 */
function ShellFrame() {
  const { open, setOpen } = useNavDrawer();
  return (
    <>
      <div className={`shell${open ? ' shell--nav-open' : ''}`}>
        <Rail />
        <div className="main">
          <TopBar />
          <main id="main" className="page">
            <Outlet />
          </main>
        </div>
      </div>
      {open ? (
        <button
          type="button"
          className="navbackdrop"
          aria-label="Close the menu"
          tabIndex={-1}
          onClick={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
