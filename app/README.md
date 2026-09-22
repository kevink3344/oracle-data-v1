# Oracle Project Tracker — front end

React 18 + Vite 5 + TypeScript SPA. No CSS framework, no chart library — the
styles and the SVG charts are hand-written so they can match the approved
mockups exactly.

Several screens are implemented; the rest of
`../docs/plans/oracle-project-tracker-plan.md` is deliberately deferred.

| Route                   | Screen                                                      |
| ----------------------- | ----------------------------------------------------------- |
| `/`                     | Dashboard — KPI strip, committed-value-by-month chart, committed value by object code, "what the data will not tell you" |
| `/projects`             | Projects — filterable, grouped table of levels              |
| `/projects/new`         | New Project — name + description; a cost centre is bound later, from the project list |
| `/coa/combinations`     | Combination search — 328 combinations, multi-facet chips (`/funding/search` redirects here) |
| `/activity`             | Activity — what changed in the source database on one day   |
| `/objects/:object`      | Object detail — lines under one object code, vendor panel, CSV/PDF export |
| `/spend/payments`       | Payments — the AP **check** register (Oracle-backed)        |
| `/spend/invoices`       | Invoices — the AP **invoice** register (Oracle-backed)      |
| `/admin/views`          | View builder — the app's first screen with a server surface |
| —                       | Detail drawer — slides in over either screen when a level is selected |

The routes are **generated from `src/nav/menu.ts`**, and a leaf in `SCREENS`
(`App.tsx`) that is not a leaf in the menu is a startup error. Every other menu
leaf routes to `Pending`.

## Running it

```powershell
npm install
npm run dev        # http://localhost:5180 (strictPort)
```

> **Start the dev server as the VS Code task `app: dev`, not from a terminal.**
> In this environment any dev server launched from a tool terminal is killed with
> `0xC000013A` (`STATUS_CONTROL_C_EXIT`) once that terminal is disposed — including
> detached windows, WMI launches and scheduled tasks. A VS Code background task
> survives because VS Code owns the terminal. `.vscode/tasks.json` defines
> `app: dev`, `app: typecheck` and `app: build`.

Other scripts:

```powershell
npm run typecheck  # tsc -b --force
npm run build      # sync:extract -> tsc -b -> vite build
npm run sync:extract
```

## Data

`scripts/sync-extract.mjs` copies the Oracle extract from `../data/oracle/*.json`
into `app/public/oracle/` and prints a byte count per file. `npm run build` runs
it first, so a build always serves the current extract. The app fetches those
files over HTTP at runtime — there is no server component.

Two things about it are load-bearing:

- **The pull writes `full-output.json`; the app fetches `/oracle/output.json`.**
  The rename happens in the sync script (`RENAMES`). It has to be there. When it
  was not, `app/public/oracle/output.json` was an unmanaged file — the two
  happened to match, but a refreshed pull would have overwritten the source, the
  build would have printed a byte count and exited 0, and the app would still
  have been serving the previous extract.
- **The served folder is regenerated, not merged.** `sync-extract` writes every
  copied file and then deletes any remaining `.json` in `app/public/oracle/`. That
  is what makes the script's claim — that the served extract is the one on disk —
  actually true, and it is deliberately confined to `.json` so nothing
  hand-maintained in that folder can be caught by it.

The extract is large (`output.json` is ~2 MB), so the client parses it once in
`src/state/store.tsx` and derives every screen from that single in-memory model.

## The account scope

Beside the global search box in the top bar sits the **account scope**: a bare
`04`, three programme chips (`861` `862` `863`), and a caret that opens the same
selection as a list.

```
04  [ 861 ] [ 862 ] [ 863 ]  ∨     2,781 PO lines in scope
```

- **The fund is not a control.** It renders as a `<span>` with no `role` and no
  `tabindex`, because a reader cannot move it: it is the boundary of their
  organization, and widening an organization is a Settings edit rather than a
  chip. It is stated rather than offered, so the chips are not read as
  “programme” in the abstract.
- **The programmes are the active organization's**, in the order that row stores
  them, all on by default. **Editing the organization in Settings changes this
  control** — the panel is a picture of the tenant, not of the bundle.
- **Selecting a programme the extract has no lines for is not an error.** The
  row still appears, with a real `0` and the words *no lines in the extract*, so
  the absence is visibly a property of the data rather than of the control.

### One rule, one implementation, one application point

`src/data/scope.ts` is the only place the rule is written. **The rule is no longer
written into it as a constant**: the configuration — which fund, which
programmes, in what order — is the `organization` row the session arrived with,
reached through `useSession()` in `store.tsx`. What is left in the module is a
library of pure functions over a `Scope` it no longer owns.

| export | what it is |
| --- | --- |
| *(no constant)* | the default is the **organization row**. A `SCOPE` or `ALL_PROGRAMS` reappearing here means the organization has stopped being the authority for the scope |
| `inScope(scope, fund, program)` | **the one implementation of the test** |
| `parseScope(fund, programs, holdings)` | URL ⇄ scope, so the address and the control cannot drift. It **clamps to the organization** — a hand-edited `?programs=999` is dropped, never an error — and it tells `?programs=` (present and empty) apart from an absent parameter |
| `clampToHoldings(scope, holdings)` | the clamp itself: membership within the tenant |
| `scopeParams` | scope ⇒ URL parameters, or an empty list when there is nothing to write |
| `sameScope`, `isFullScope(scope, holdings)` | comparison, and “is this every programme the organization holds?” |
| `scopeLabel(scope, programmeOrder)`, `scopeSpoken` | one written form and one spoken form for every surface. The order is passed in, because order is a property of the tenant rather than of the module |
| `fiscalYearStart`, `rowsInScope` | the FY boundary, and a count for a *stored* scope — what Settings uses to show a row's reach before anyone has navigated to it |

`store.tsx` derives `lines` — the whole extract filtered through `inScope` — and
**every register reads `lines` rather than the extract**. That is why the control
*is* the filter: a screen cannot disagree with it because there is nothing else
to read. **Nothing downstream may hardcode `'04'` or `861-863`**; if a new screen
needs the rule it calls `inScope`, and if it needs the label it calls
`scopeLabel`.

### The scope is in the URL

`?fund=04&programs=861,862`. **The default scope is the bare path**, and it has two
ways in — `resetScope`, and `setScope` with the organization's full selection.
Both delete the parameters rather than writing the defaults out, so toggling `863`
off and back on returns to the address you started from instead of inventing
`?programs=861,862,863`, a URL nobody wrote. `setScope` clamps before it compares,
so the URL and the state can never describe different things.

The scope writes with `replace: true` (unlike the level selection), so arrowing
through programme chips does not build a back-button trail.

### Three ways a page can relate to the scope

| situation | mechanism |
| --- | --- |
| the row is in the extract and out of scope | `lines` — the screen is simply filtered |
| the rows were already filtered, in SQL | `ScopeNotApplied` — *“Scope not applied”* |
| the rows were filtered, in SQL, **by a different scope** | the *“Scope difference”* note |

`/spend/invoices` is the third case and the only one. Every other register is
filtered by `lines`, so the control is the filter and the two cannot disagree.
The invoice register’s rule lives in the extract SQL instead
(`server/scripts/pull-invoices-extract.mjs`) and its JSON carries its own
`.scope` block, so there are **two authorities on one question**. The envelope is
the authority on what the file contains — and the envelope cannot follow the
reader. Rather than re-applying the live scope in JS (which would show a subset
matching neither scope), the page renders the file as it stands and says so,
naming both selections and the command that changes the file. A file with no
`.scope` block produces no note at all: *nothing was applied* is a missing fact,
not a disagreement.

`ScopeNotApplied` has a sibling, `ScopeRemoved`, which states what the scope cost
on a page that cannot honour it — and returns `null` when it cost nothing.

### Two rules the scope may never break

1. **It narrows *which rows are shown*, never *what a row says*.** No count is
   rewritten, no figure silently reduced. Every surface that drops something
   reports **how many** and **how much** — the top-bar tail reads
   `0 of 2,781 PO lines — 2,781 removed by scope`, never just `0`.
2. **It must always be able to say what it cost.** Counts are carried, never
   subtracted on the fly, so “zero because the query found nothing” and “zero
   because the reader filtered everything away” stay distinguishable.

On this extract the second rule is load-bearing rather than theoretical: every
combination key is `04-…-862-…`, so **turning `862` off removes all 2,781 lines
and every figure in the app becomes zero**. That state was unreachable before the
scope existed, which is why the Dashboard has an explicit *scope emptied* branch
that names the scope and the number of lines it removed — and why
`monthLong()` returns `''` rather than letting a month formatter emit
`Orders run Invalid Date to Invalid Date`.

### 2,782 rows in the file, 2,781 lines in the app

`app/public/oracle/output.json` holds **2,782** rows. One is cancelled
(`CANCEL_FLAG = 'Y'` — order 276551, a $0 encumbering-funds placeholder) and is
dropped at `extract.ts`. **Every count in the app is therefore over 2,781 live
lines.** If a number here disagrees with a number taken straight off the JSON,
check that first.

## The AP registers are scoped to Fund 04 · programme 861/862/863

> This is the **extract-level** scope — a `WHERE` clause in the invoice pull. It
> is a different thing from the live account scope above, which filters what is
> already loaded in the browser; see *Three ways a page can relate to the scope*
> for how the two are reconciled on `/spend/invoices`.

`/spend/invoices` shows **one fiscal year of AP invoices restricted to
`SEGMENT1 = '04'` and `SEGMENT3 IN ('861','862','863')`**. The restriction is
applied **in the extract SQL** (`server/scripts/pull-invoices-extract.mjs`), not
in the browser, and the excluded invoices are counted rather than discarded so the
page can report what the scope cost:

| bucket | invoices | value |
| --- | --- | --- |
| in scope | 126 | $5,650,332.66 |
| excluded — booked elsewhere | 3,584 | $94,189,128.88 |
| unanswerable — no distribution at all | 26 | $28,565.26 |
| fiscal year, whole | 3,736 | $99,868,026.80 |

Two consequences worth knowing before changing anything:

- **The scope narrows *which invoices*, never *which of their accounts*.** Two kept
  invoices draw an account outside the scope (`04-1100-000-000-0000-0000-000`,
  $243.15 between them). Those accounts are shown and marked `OUTSIDE SCOPE` — not
  dropped, because removing them would stop an invoice's account list summing to
  its own amount, which reads as a data fault and is not one.
- **Read the scope off `invoices.json`** (`data.scope`) rather than hardcoding
  `'04'` or `861-863` in the UI; the page head, the note and the filter suffix all
  do.

An invoice's GL account lives on its **distribution**, so the page's grain is the
**(invoice, account) pair** — 53 of the 126 in-scope invoices span more than one
account. The Account column shows the largest plus a `+N` chip, the panel lists
them all with amounts, and the CSV export repeats `segment1..7` per account row.

## Layout

```
src/
  main.tsx            entry
  App.tsx             shell: rail + topbar + <Outlet/>, mounts DetailDrawer;
                      routes are generated from nav/menu.ts + the SCREENS map
  nav/menu.ts         the rail, and the single source of the route list
  state/store.tsx     loads the extract, derives projects/rollups, holds selection
  data/               parsing + aggregation + formatting helpers
                      (extract, types, derive, combos, lineProjects, projectMeta,
                       invoices, checks, activity, taxonomy, session, format, scope)
                      scope.ts is the single source of the account-scope rule
  lib/printPanel.ts   clone-into-an-iframe print path used by every export
  routes/             Dashboard  Projects  NewProject  FundingSearch  Activity
                      ObjectDetail  Checks  Invoices  ViewBuilder  Pending
  components/         Rail  TopBar  ProjectTable  DetailDrawer  TrendChart  Bars
                      CostCentrePicker  CostCentreEditor  BucketBlock  HowBlock
                      AttentionList  ResizeGrip  Chip  ErrorNotice
                      ScopeSelect  ScopeNote
  styles/             one sheet per screen plus the shared primitives —
                      tokens  base  components  shell  rail  dashboard  projects
                      panel  newproject  fundingsearch  objectdetail  checks
                      invoices  activity  viewbuilder
```

Theme: `data-theme` on `<html>`, values `light` / `dark`, persisted in
`localStorage` under `projects-theme`. Dark overrides are authored as
`[data-theme='dark'] …` selectors.

## Accessibility notes

- The trend chart is `role="group"`, **not** `role="img"` — the month columns are
  real `role="button"` `<rect>`s and an explicit `img` role would prune the whole
  subtree from the a11y tree.
- Opening the drawer moves focus to its close button and traps Tab; Escape closes
  it and returns focus to the opener. The opener is the project-name `<button>`
  inside the row, so the table is keyboard-reachable even though `<tr>` itself
  only carries a mouse `onClick`.
- Focus is restored via a ref captured at open time. The focus *call* lives in its
  own effect gated on `open && shown !== null`, because on the first open the
  panel has no content yet and the ref would still be unset.
- The scope control is a `role="group"` labelled `Account scope — Fund 04,
  programme 861, 862 or 863`, holding three real `aria-pressed` toggle buttons.
  The `04` is deliberately **outside** the group's reach: no `role`, no
  `tabindex`, so it is provably not a control. The caret is
  `aria-haspopup="dialog"` with a live `aria-expanded`, and the popover is a
  `role="dialog"` that takes focus on open, closes on an outside `mousedown` and
  on Escape. Those two listeners are attached **only while the popover is open**
  — the effect that owns them is gated on the open state rather than filtering
  inside a permanently mounted handler.
- **`ScopeSelect.tsx` holds the only `:focus-visible` rules in the app.** Every
  other control relies on the global ring in `base.css`. If you are looking for a
  focus-style precedent, that is the file, and if you are auditing focus
  visibility, that is the only exception to check.

## Known limitation

Visual comparison against the mockups in `docs/screenshots/` could not be done in
the VS Code embedded browser: its render surface is capped at roughly 660 px no
matter what viewport is emulated, so screenshots of a desktop-width layout come
back clipped even when `getBoundingClientRect` reports the correct geometry.
Layout was therefore verified numerically (element geometry, computed styles,
overflow, breakpoints at 1400/1024/700/375 px). For a true pixel comparison, open
`http://localhost:5180` in a normal browser window.

**The responsive breakpoints have never been exercised.** In the embedded browser
`page.setViewportSize()` is a silent no-op — the page keeps rendering at one width
whatever it is asked for — so the `@media (max-width: 900px)` rule that hides
`.scope__inline`, and the `720px` invoice-layout block, are **written but
unverified**. Do not read them as working. They need a real window, resized.
