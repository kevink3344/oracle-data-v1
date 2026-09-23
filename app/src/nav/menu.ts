import type { ExtractLine, Project } from '../data/types';

/**
 * The application menu, as one tree.
 *
 * This file is the single source of truth for navigation, and it is deliberately
 * data rather than markup. `App.tsx` builds one route per leaf from it, `Rail.tsx`
 * renders it, and `Pending.tsx` reads a leaf back out of it — so a leaf cannot
 * appear in the rail without a URL, and cannot have a URL that the rail does not
 * show. Before this file, the rail listed eight disabled placeholders and the
 * router listed five paths, and the two had no way to disagree loudly.
 *
 * THE SHAPE IS `docs/plans/menu-groups.md` §4.1/§4.2, VARIANT B (§§10.3, 12-Q2)
 *
 *   - Six question-shaped blocks are visible: Overview, Projects, Funding,
 *     Commitments & Spend, Procurement, Vendors.
 *   - `Chart of Accounts` is *not* a seventh block: `Account combinations` moves
 *     under Projects, where a reader actually wants it, and the rest of the
 *     segment vocabulary joins Administration in the utility section pinned above
 *     the rail's provenance stamp. Both are reference and setup, visited rarely.
 *
 * THREE DECISIONS FROM §12 ARE ENCODED HERE, NOT IN PROSE
 *
 *   - **Q3 = no: there is no `Vendor contacts` leaf.** The object is real in
 *     production but absent from this sample, so it cannot be verified here (§8).
 *   - **Q1 = filter: there is no `Invoice Adjustments` leaf.** It is a chip on
 *     Invoices — credit memos, non-item lines and budget adjustments are three
 *     views of one list, not three destinations.
 *   - **Q4 = yes: `Vendor spend` is a leaf.** Companies and sites are reference
 *     data; "who are we paying, and how much" is the question (§5.3).
 *
 * WHAT `built` MEANS
 *
 * `built: true` means **a screen exists**. It does not mean the data exists —
 * §4.2's own "Backed today?" column is a statement about the database, and this
 * one is a statement about the client. They are not the same claim and conflating
 * them is how a menu ends up promising screens that are not there. Every leaf with
 * `built: false` routes to `Pending`, which names the reason instead of rendering
 * a blank page: §8's recommended option 1. Option 3 — hiding an empty leaf — is
 * the only one the plan rules out, and it is ruled out because it hides a real gap
 * instead of framing it.
 */

/**
 * The rail badges.
 *
 * Only figures the client already holds can appear here. There is deliberately no
 * `budgets` or `encumbrances` member: those live behind the API, are not fetched
 * yet, and a badge reading `0` for "not loaded" is the always-zero trap this app
 * has already been bitten by once. §10.2 asks for exactly this — *"only render a
 * count where the number is real"* — and `Rail` renders `—` rather than `0` while
 * the extract is still loading.
 *
 * ★ Still true after `/funding/budgets` was built, and worth stating because the
 *   obvious next move is wrong. That screen **does** fetch the budgeted-account
 *   count (four), so the figure is no longer merely theoretical — but it is
 *   fetched *by that screen*, and the store does not hold it. A badge is rendered
 *   by the rail on every page, so badging it would mean either a second fetch of
 *   the budget views on every navigation, or a number that is real only while you
 *   are already looking at it. The rule is not "is this figure knowable" but "does
 *   the client already hold it", and the answer is still no.
 */
export type RailCount =
  | 'projects'
  | 'unclaimed'
  | 'combinations'
  | 'vendors'
  | 'orders'
  | 'lines'
  | 'activity';

/** Spelled out so the rail's badge can carry a `title` that says what it counts. */
export const COUNT_OF: Record<RailCount, string> = {
  projects: 'account levels in the extract',
  unclaimed: 'levels with no project record in the app',
  combinations: 'distinct account combinations',
  vendors: 'distinct vendors named on the extract',
  orders: 'distinct purchase orders',
  lines: 'purchase-order lines',
  activity: 'objects whose row count moved since the previous reading',
};

export interface MenuLeaf {
  /** The name in the rail. */
  label: string;
  /** Every leaf owns a real URL; **groups do not** (§10.1). */
  to: string;
  /** The Oracle object, view or SQL file this screen reads. */
  reads: string;
  /** A screen exists behind this URL. See the note at the top on what this is not. */
  built: boolean;
  /**
   * A `GET` the server already serves for this leaf, when one exists. Written out
   * in full because it is the same string as the OpenAPI path — the server is
   * mounted with no prefix for exactly that reason.
   */
  api?: string;
  /** Why there is no screen, or no rows. Rendered in full by `Pending`. */
  note: string;
  /** Where in `docs/plans/menu-groups.md` this leaf comes from. */
  plan: string;
  /** Set only where the number is real. See `RailCount`. */
  count?: RailCount;
  /**
   * A computed measure rather than an extracted one. §5.2 is emphatic that
   * *Allocations* is derived arithmetic — `Allocations − Encumbrances −
   * Expenditures` — and labelling it as an extract would be a lie about
   * provenance, which is the one thing this app is careful about everywhere else.
   */
  derived?: boolean;
}

export interface MenuBlock {
  id: string;
  title: string;
  leaves: MenuLeaf[];
}

/* -------------------------------------------------------------------------- */
/* Overview                                                                    */
/* -------------------------------------------------------------------------- */

const OVERVIEW: MenuBlock = {
  id: 'overview',
  title: 'Overview',
  leaves: [
    {
      label: 'Dashboard',
      to: '/',
      reads: 'derived from the extract',
      built: true,
      note: 'Built.',
      plan: '§9.1, §4.2',
    },
    {
      label: 'Activity',
      to: '/activity',
      reads: 'sqlite_master, pragma_table_info',
      built: true,
      api: 'GET /api/activity',
      count: 'activity',
      note:
        'What changed in this database on one day, table by table, read from the catalogue rather ' +
        'than from any one table. Read this before believing a number elsewhere on the site: it is ' +
        'the only screen that says which tables can date their own rows at all. Most cannot — the ' +
        'extract carries no timestamp on PO_LINES_ALL, so a line count is a total and never a ' +
        'change. The badge is the count for the server’s own today, so it agrees with the page.',
      plan: '§9.1',
    },
    {
      label: 'Pinned',
      to: '/pinned',
      reads: 'user_pin',
      built: true,
      api: 'GET /api/pins',
      note: 'Your private shortcuts to projects, invoices, checks and purchase orders.',
      plan: '§9.1',
    },
    {
      label: 'Views',
      to: '/views',
      reads: 'saved_view, saved_view_subscription, saved_view_run',
      built: true,
      api: 'GET /api/views/subscriptions',
      note:
        'The saved views you watch. Every count on this screen is a `row_count` from a run, and ' +
        'every run is capped at 200 rows — so a figure that reached the cap is a floor and is ' +
        'printed as `200+`, never as a total. A view that has never run shows a dash, which is a ' +
        'different thing from a view that ran and found nothing. Nothing is sent yet: this server ' +
        'has no scheduler and no sender, so watching records what you asked to keep an eye on and ' +
        'shows the change the next run finds, rather than claiming anyone is told about it.',
      plan: 'docs/plans/saved-views.md §9.1',
    },
  ],
};

/* -------------------------------------------------------------------------- */
/* Projects                                                                    */
/* -------------------------------------------------------------------------- */

const PROJECTS: MenuBlock = {
  id: 'projects',
  title: 'Projects',
  leaves: [
    {
      label: 'All projects',
      to: '/projects',
      reads: 'ExtractLine[]',
      built: true,
      count: 'projects',
      note: 'Built.',
      plan: '§4.2',
    },
    {
      label: 'Portfolios',
      to: '/portfolios',
      reads: 'app-side',
      built: false,
      note:
        'Portfolios are a set of levels a person groups and names. The extract has no portfolio ' +
        'column and never will, so this is a local overlay kept beside the extract rather than ' +
        'read out of it — and nothing writes to that overlay yet.',
      plan: '§9.5',
    },
    {
      label: 'Unclaimed combinations',
      to: '/projects/unclaimed',
      reads: 'combinationKey',
      built: false,
      count: 'unclaimed',
      note:
        'The count is real and the rail badges it: these are the levels the extract carries that ' +
        'no project record names. The dedicated queue is not built — today they are the part of ' +
        'All projects that a facet removes rather than a list in their own right.',
      plan: '§9.4',
    },
    {
      // Moved here by §12-Q2. A combination is what a project *binds*, so it reads
      // as part of this block even though the vocabulary it comes from is the CoA.
      label: 'Account combinations',
      to: '/coa/combinations',
      reads: 'GL_CODE_COMBINATIONS',
      api: '/api/coa/combinations',
      built: true,
      count: 'combinations',
      note: 'Built — this is the search page, still at /funding/search as a redirect.',
      plan: '§4.2, §10.4',
    },
  ],
};

/* -------------------------------------------------------------------------- */
/* Funding                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The block whose name had to be freed first.
 *
 * §7 found the collision: the *old* rail's "Funding" group held `Capital`,
 * `Operating` and `Relocation`, which are purpose-code filters on the projects
 * list — three buttons whose handler called `setFacet` and then navigated to
 * `/projects`. A control that always goes to `/projects` is a filter **on**
 * `/projects`, not a destination, and it has moved to the chip row on that page.
 * The name is then free for what it should have meant all along: the budget.
 */
const FUNDING: MenuBlock = {
  id: 'funding',
  title: 'Funding',
  leaves: [
    {
      label: 'Budgets',
      to: '/funding/budgets',
      reads: "GL_BALANCES where ACTUAL_FLAG = 'B'",
      api: '/api/funding/budgets',
      built: true,
      note:
        'Built. The one screen in the app that reads no extract at all: the eight files in ' +
        '`public/oracle/` are every one of them commitments or spend, and not one carries a ' +
        'budget position, so this reads `V_BUDGET_BY_ACCOUNT_PERIOD` and `V_ACCOUNT_POSITION` ' +
        'over the API instead. ★ Which makes its near-emptiness load-bearing rather than a bug: ' +
        'the views answer, and they hold **4 budgeted accounts** against the 71 the invoice ' +
        'register books against. The screen is built around that answer, and an account with no ' +
        'budget row says so instead of rendering an empty table.',
      plan: '§6 — 01-budgets.sql',
    },
    {
      label: 'Budget adjustments',
      to: '/funding/adjustments',
      reads: 'GL_JE_HEADERS + GL_JE_LINES',
      api: '/api/funding/journals',
      built: false,
      note:
        'The adjustment log. Journals are served; the screen is not built, and the split between ' +
        'an adjustment and an ordinary journal is a classification the screen has to make, not ' +
        'one the table carries.',
      plan: '§6 — 02-budget-adjustments.sql',
    },
    {
      label: 'Budget changes',
      to: '/funding/changes',
      reads: 'GL_JE_LINES (trend)',
      api: '/api/funding/journal-lines',
      built: false,
      note:
        'Budget movement over time — the same journal lines as adjustments, read as a series ' +
        'rather than as a log. Served, not built.',
      plan: '§6 — 03-budget-changes.sql',
    },
    {
      label: 'Journal entries',
      to: '/funding/journals',
      reads: 'GL_JE_HEADERS, GL_JE_LINES',
      api: '/api/funding/journals',
      built: false,
      note:
        'The unfiltered journal. Adjustments and Changes are two readings of this list; this leaf ' +
        'is the list itself, with a per-journal detail route already served.',
      plan: '§4.2',
    },
    {
      label: 'Allocations & available funds',
      to: '/funding/allocations',
      reads: 'GL_BUDGET_VERSIONS + GL_BALANCES',
      api: '/api/funding/positions',
      built: false,
      derived: true,
      note:
        'Derived, not extracted. §5.2: there is no allocations table. Available funds is ' +
        'Allocations − Encumbrances − Expenditures per account, where allocations sit on the ' +
        'APPROP side of the budget. The API computes it; the screen must label it as arithmetic, ' +
        'because every other figure in this app is read straight out of a column.',
      plan: '§5.2',
    },
    {
      label: 'Budget setup',
      to: '/funding/setup',
      reads: 'GL_BUDGET_TYPES, _VERSIONS, _ENTITIES, _ASSIGNMENTS',
      api: '/api/funding/budget-versions',
      built: false,
      note:
        'The four setup tables behind the figures above — types, versions, entities and their ' +
        'assignments. Vocabulary rather than questions, which is why it sits at the bottom of ' +
        'this block. All four are served.',
      plan: '§4.2',
    },
  ],
};

/* -------------------------------------------------------------------------- */
/* Commitments & Spend                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Included, with both halves of the AP chain now carrying a real leaf.
 *
 * §12-Q5 answers *no* to "does the Spending block ship before the AP tables are
 * seeded", and that answer has since been overtaken by events rather than
 * argued away: the WCSEXP_* views were opened up, so checks and invoices can be
 * pulled from Oracle directly and do not need the sample's empty payables tables
 * at all.
 *
 * So the two leaves that read the payables chain are both built, and each states
 * its own window on its own page. They are the same relation read from either
 * end, and they do not agree on a link count — deliberately, because the checks
 * page counts checks and this one counts invoices.
 */
const SPEND: MenuBlock = {
  id: 'spend',
  title: 'Commitments & Spend',
  leaves: [
    {
      label: 'Encumbrances',
      to: '/spend/encumbrances',
      reads: 'V_ENCUMBRANCE_FROM_PO',
      built: true,
      note:
        'Built. ★ The only screen in the app that reads two populations and refuses to add them ' +
        'up: the purchasing extract holds a commitment against 335 account combinations and the ' +
        'custom report\'s ledger side holds four, and the schema says the two will not agree — ' +
        '"the disagreement is a fact about the data rather than a bug". So the four accounts both ' +
        'sides hold carry the only difference computed, there is no combined total, and the page ' +
        'says in prose that its purchasing figure mirrors the ordered amount and that a blank GL ' +
        'cell means "not in the extract" rather than "zero". Two footnotes are the answers it was ' +
        'built to give: the report prints $149,072.93 twice and the distributions say the two are ' +
        'not the same money, and seven combinations resolving to no project total $11,511.12, ' +
        'which is exactly the extract-vs-distributions difference. An encumbrance is a commitment, ' +
        'not a cost — nothing on the page is summed into an expenditure total.',
      plan: '§4.2',
    },
    {
      label: 'Invoices',
      to: '/spend/invoices',
      reads: 'AP_INVOICES + AP_INVOICE_PAYMENTS',
      built: true,
      note:
        'Built. One fiscal year of invoices pulled into data/oracle/invoices.json, the mirror of ' +
        'the checks page — same columns, axes swapped. It needs its own extract rather than the ' +
        'check register reversed, because INVOICE_NUM is not a key: 142 invoices here share the ' +
        'number 30JUN-2026SES, one per vendor. A credit memo is a row with a negative amount — ' +
        'this view has no invoice-type column, so the chip §12-Q1 wanted splits what it can.',
      plan: '§8, §12-Q1/Q5',
    },
    {
      label: 'Checks',
      to: '/spend/payments',
      reads: 'AP_CHECKS + AP_INVOICE_PAYMENTS',
      built: true,
      note:
        'Built. One fiscal year of checks pulled straight from the WCSEXP_* view into ' +
        'data/oracle/checks.json, because the app has no Oracle connection at runtime — the window ' +
        'is a fiscal year, not the ledger, so the page states its own bounds. A check is not an ' +
        'invoice: the largest here paid 269 of them.',
      plan: '§4.2, §8',
    },
    {
      label: 'Commitments vs actuals',
      to: '/spend/vs-budget',
      reads: '04-spend-and-actuals.sql',
      built: false,
      note:
        'The question the fourth analysis query asks — is "committed" the same as "spent"? — and ' +
        'the one screen where encumbrances, budget and expenditure have to appear side by side ' +
        'without being summed into each other.',
      plan: '§6 — 04-spend-and-actuals.sql',
    },
  ],
};

/* -------------------------------------------------------------------------- */
/* Procurement                                                                 */
/* -------------------------------------------------------------------------- */

const PROCUREMENT: MenuBlock = {
  id: 'procurement',
  title: 'Procurement',
  leaves: [
    {
      label: 'Purchase orders',
      to: '/procurement/purchase-orders',
      reads: 'PO_HEADERS_ALL',
      api: '/api/purchase-orders',
      built: true,
      count: 'orders',
      note:
        'Built, and §3 is satisfied — but not the way the plan expected. The order carries no ' +
        'project: EXP_PROJECT_NAME is null on all 749 rows of PO_HEADERS_ALL. So every row names ' +
        'the project its account charges it to, which is SEGMENT5 of the combination on the line. ' +
        'Measured over the extract, 739 of the 741 orders sit on exactly one level, 2 sit on two ' +
        'and each says so, and none is unattributed. It reads the extract rather than the API: the ' +
        'extract sums to $430,569,026.92, the figure the projects page reports, where ' +
        'PO_DISTRIBUTIONS_ALL sums the same orders to $430,580,538.04.',
      plan: '§4.2, §3',
    },
    {
      label: 'Line items',
      to: '/procurement/lines',
      reads: 'PO_LINES_ALL',
      api: '/api/purchase-order-lines',
      built: false,
      count: 'lines',
      note:
        'Served, not built. These are the rows the whole app is derived from — a project exists ' +
        'here only because a line in this table names one in its free-text description.',
      plan: '§4.2',
    },
    {
      label: 'Shipments',
      to: '/procurement/shipments',
      reads: 'PO_LINE_LOCATIONS_ALL',
      api: '/api/purchase-order-shipments',
      built: false,
      note: 'Served, not built. Shipments are the scheduled and actual dates behind a line.',
      plan: '§4.2',
    },
    {
      label: 'Distributions',
      to: '/procurement/distributions',
      reads: 'PO_DISTRIBUTIONS_ALL',
      api: '/api/purchase-order-distributions',
      built: false,
      note:
        'Served, not built. A distribution is where a line lands in the accounting — one line can ' +
        'split across several — so this table and the line table disagree on their own row counts ' +
        'and neither number is wrong.',
      plan: '§4.2',
    },
    {
      label: 'Line types & lookups',
      to: '/procurement/reference',
      reads: 'PO_LINE_TYPES, PO_LOOKUP_CODES',
      api: '/api/line-types',
      built: false,
      note: 'The controlled vocabularies the two tables above speak in. Served, not built.',
      plan: '§4.2',
    },
  ],
};

/* -------------------------------------------------------------------------- */
/* Vendors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Three leaves, not four.
 *
 * §5.3 argued for the Nest — companies → sites → contacts, which is Oracle's own
 * structure and what `PARENT_VENDOR_ID` exists for — and §12-Q3 then took contacts
 * out of v1 because the object is absent from this sample (§8). So the block is
 * companies and sites as reference, plus the one leaf that turns the block from a
 * directory into a question. Contacts leaves no gap in the tree: when the object
 * arrives it is a child of a site, not a sibling.
 */
const VENDORS: MenuBlock = {
  id: 'vendors',
  title: 'Vendors',
  leaves: [
    {
      label: 'Vendor companies',
      to: '/vendors/companies',
      reads: 'PO_VENDORS',
      api: '/api/vendors',
      built: true,
      count: 'vendors',
      note:
        'Built. ★ The two figures this leaf used to carry are both wrong and are replaced with ' +
        'measured ones: `PO_VENDORS` holds **79,685 rows** for this tenant, not 749, and ' +
        '`PARENT_VENDOR_ID` is **null on every row** the app has seen — so no parent → subsidiary ' +
        'tree exists to build, and §5.3’s Nest is a plan rather than a shape the data has. ' +
        'The screen reads its two halves from two places on purpose: the payments come from the ' +
        'scoped AP extract (nothing else records who was paid), the master row is looked up live ' +
        'one company at a time. **55 vendors** on the Fund 04 / 861-862 register, across 126 ' +
        'invoices and 65 checks — the largest payee on 15 invoices, the busiest on 5 checks.',
      plan: '§5.3',
    },
    {
      label: 'Vendor sites',
      to: '/vendors/sites',
      reads: 'PO_VENDOR_SITES_ALL',
      api: '/api/vendor-site-register',
      built: true,
      note:
        'Built. ★ Still the address level under a company — one vendor, many sites, and a purchase ' +
        'order names the site rather than the company — and now the only screen whose rows are ' +
        '**sites** rather than documents or companies. **800 sites across 715 vendors**, named by ' +
        'an in-scope order at Fund 04 / programs 861-863 from FY2022: **5,692 orders**, 31,401 ' +
        'lines, **$2,797,825,956.73** committed. ★ It partitions itself rather than filtering: ' +
        '`Active` (761) and `Deprecated` (39, $38,567,580.12) are two views of one register and ' +
        'every figure on the page counts both. **`Deprecated` is not "inactive"** — the obvious ' +
        'rule, a site code reading `DO NOT USE`, matches **none of the 800 rows** (the directory ' +
        'holds 669 such codes and 342 are named by some purchase order, but not one by an in-scope ' +
        'order), so each row names which of three signals put it there: not a purchasing site, a ' +
        'non-null `INACTIVE_DATE`, or a vendor whose name carries `DONOTUSE`. The signals overlap ' +
        '(37 rows carry one, 1 carries two, 1 carries all three), so the tab is not the sum of the ' +
        'three counts — and the page says so. ★ **No badge**, deliberately: the register is ' +
        'fetched by this screen, not held in the store, so a rail count would be a second fetch on ' +
        'every navigation or a number real only while you are looking at it — the same rule the ' +
        'other leaves follow.',
      plan: '§5.3',
    },
    {
      label: 'Vendor spend',
      to: '/vendors/spend',
      reads: 'PO_HEADERS_ALL + AP_INVOICES',
      built: false,
      note:
        'Approved for v1 (§12-Q4) and not built. It is the only leaf in this block that answers a ' +
        'question rather than listing reference data — what was ordered from a vendor, and what ' +
        'was actually paid. The second half of that join has no rows in this extract, so the ' +
        'screen would report ordered-and-unpaid for every vendor until payables is seeded.',
      plan: '§5.3, §12-Q4',
    },
  ],
};

/**
 * The six question-shaped blocks, in the order a reader meets them.
 *
 * Overview first because it is the entry point; Vendors last because it is the
 * least like the others — the rest of the blocks are about money moving through
 * projects and commitments, and this one is about who is on the other side.
 */
export const WORK_BLOCKS: MenuBlock[] = [
  OVERVIEW,
  PROJECTS,
  FUNDING,
  SPEND,
  PROCUREMENT,
  VENDORS,
];

/* -------------------------------------------------------------------------- */
/* Reference and setup                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The rest of `Chart of Accounts`, and all of `Administration`.
 *
 * Both were blocks in Variant A and are one utility section in Variant B. §10.3
 * draws the line the split follows: the six work blocks are *questions*, and these
 * two are *vocabulary and configuration* — the things you go to in order to fix a
 * name or re-run a load, not the things you go to in order to find something out.
 *
 * `Chart of Accounts` loses `Account combinations` to the Projects block. It is
 * the one leaf in this group a reader wants mid-task, because a combination is
 * what a project binds.
 *
 * The old rail's `Oracle data` group splits across all of this, and none of its
 * three items survive under their old names: `Levels` is `Segments & values`,
 * because LEVEL_ is a segment like any other; `Cost codes` is `Account
 * combinations`, which is the page it was always pointing at; and `Vendors` is the
 * Vendors block. All three were disabled spans with no URL, so no link is lost.
 */
export const UTILITY_BLOCKS: MenuBlock[] = [
  {
    id: 'coa',
    title: 'Chart of Accounts',
    leaves: [
      {
        label: 'Segments & values',
        to: '/coa/segments',
        reads: 'FND_ID_FLEX_*, FND_FLEX_VALUES',
        api: '/api/coa/segments',
        built: false,
        note:
          'The key flexfield and the values each of its seven segments may take — including ' +
          'LEVEL_, which is why this leaf absorbs the old rail’s disabled `Levels` item. Served ' +
          'as both a summary and a per-segment list; not built.',
        plan: '§4.2, §10.4',
      },
      {
        label: 'Balances by period',
        to: '/coa/balances',
        reads: 'GL_BALANCES (all flags)',
        api: '/api/coa/balances',
        built: false,
        note:
          'Every flag, not just the budgeted one: actuals, budget and encumbrance are three ' +
          'different rows for the same account and period. Populated in this sample, served, ' +
          'not built.',
        plan: '§4.2',
      },
      {
        label: 'Periods',
        to: '/coa/periods',
        reads: 'GL_PERIODS',
        api: '/api/coa/periods',
        built: false,
        note:
          'The accounting calendar the periods above are named against. Populated, served, not ' +
          'built — and worth one screen because a period name in this ledger does not decode ' +
          'itself the way a date does.',
        plan: '§4.2',
      },
      {
        label: 'Lookups',
        to: '/coa/lookups',
        reads: 'GL_LOOKUPS, PO_LOOKUP_CODES',
        api: '/api/coa/lookups',
        built: false,
        note: 'The generic code-and-meaning tables both halves of the ledger share. Served, not built.',
        plan: '§4.2',
      },
    ],
  },
  {
    id: 'admin',
    title: 'Administration',
    leaves: [
      // ★ THE TWO BUILT LEAVES COME FIRST, BEFORE THE LEAVES THE DESIGN PLAN
      //   NUMBERS §9.7–§9.11. The other five are all `built: false`, so the rail
      //   would otherwise open on a list of five Pending rows and bury the entries
      //   in this block that actually go somewhere. Order here is the rail's order,
      //   and the useful thing to lead with is the thing that works.
      //
      //   ★ `built` AND `App.tsx`'s `SCREENS` MUST MOVE TOGETHER. The failure mode
      //   is asymmetric and quiet: a leaf marked built with no screen falls through
      //   to `Pending`, which reads as a screen that simply has not been written
      //   yet; a screen in `SCREENS` with no leaf never gets a `<Route>` at all.
      //   Neither throws, so the pair is changed in one edit or not at all — and
      //   `App.tsx` warns in dev when the first half of that pair is wrong.
      //
      //   ★ SETTINGS IS FIRST AND ALSO HAS A GEAR IN THE RAIL. The two are the same
      //     screen reached two ways, which is not duplication: the gear is the
      //     super-admin affordance (it renders only for a super admin), and this
      //     leaf is the *address* — the thing a person can be sent, bookmarked and
      //     found by when the gear is hidden from them. Removing either would leave
      //     one of those two jobs undone.
      {
        label: 'Settings',
        to: '/settings',
        reads: 'app-side',
        api: '/api/organizations',
        built: true,
        note:
          'The organization register: the fund, the programs and the start fiscal year that ' +
          'decide which rows this deployment reads, and how many rows each organization actually ' +
          'selects. Super-admin only — a member may read every register in the app, but the four ' +
          'endpoints behind this page answer 403.',
        plan: 'docs/plans/organizations.md',
      },
      {
        label: 'View builder',
        to: '/admin/views',
        reads: 'app-side, plus whatever its queries read',
        built: true,
        note:
          'Saved queries with a declared parameter list and a chosen set of columns. The SQL is ' +
          'authored, not generated — the schema has no form that can express the first-funding ' +
          'question. Reads whatever it is pointed at, which is why the capability is gated.',
        plan: 'docs/plans/view-builder.md',
      },
      {
        label: 'Read caps',
        to: '/admin/read-caps',
        reads: 'app-side, plus a preview of whatever statement it is given',
        api: '/api/read-caps',
        built: true,
        note:
          'How many rows the app reads from each ledger object, and in what order. The ledger ' +
          'holds tables in the hundreds of millions of rows, so an unbounded read is a request ' +
          'that never returns — this is where the bound is set, per object, without a deploy. ' +
          'The panel runs the statement before saving it, so a cap is something that was looked ' +
          'at rather than a number in a box.',
        plan: 'docs/plans/read-caps.md',
      },
      {
        label: 'Segments',
        to: '/admin/segments',
        reads: 'app-side',
        built: false,
        note:
          'Which of the seven segments identify a project, and what each one is called in words a ' +
          'person uses. App-side: the ledger’s own names stay in the ledger.',
        plan: '§9.7',
      },
      {
        label: 'Combinations',
        to: '/admin/combinations',
        reads: 'app-side overlay',
        built: false,
        note:
          'The overlay that lets a combination carry a label the extract does not have. Nothing ' +
          'writes to it yet, which is also why the combination search page opens read-only — this ' +
          'overlay in particular has no writer. The app does write now, but only its own queries: ' +
          'see View builder, which stores them app-side and writes nothing back to the extract.',
        plan: '§9.8',
      },
      {
        label: 'Overrides',
        to: '/admin/overrides',
        reads: 'app-side',
        built: false,
        note: 'Where a figure read from the extract is deliberately replaced, and who replaced it.',
        plan: '§9.9',
      },
      {
        label: 'Extract runs',
        to: '/admin/extract-runs',
        reads: 'app-side, plus 00-discover.sql',
        built: false,
        note:
          'Run history — and the reason `00-discover.sql` is not a leaf. §6: that query is a ' +
          'precondition, not a destination, so its verdict belongs here beside the run that ' +
          'needed it, saying why a load came back empty instead of leaving you to guess.',
        plan: '§6, §9.10',
      },
      {
        label: 'Users & roles',
        to: '/admin/users',
        reads: 'app-side',
        built: false,
        note: 'Who may see and change what. App-side; the extract carries no identity at all.',
        plan: '§9.11',
      },
    ],
  },
];

/** Everything, work blocks first — the order the rail renders and the router declares. */
export const ALL_BLOCKS: MenuBlock[] = [...WORK_BLOCKS, ...UTILITY_BLOCKS];

/** Every leaf, flat. `App.tsx` turns this into one route per leaf. */
export const ALL_LEAVES: MenuLeaf[] = ALL_BLOCKS.flatMap((b) => b.leaves);

const BLOCK_OF = new Map<string, MenuBlock>();
for (const block of ALL_BLOCKS) {
  for (const leaf of block.leaves) BLOCK_OF.set(leaf.to, block);
}

/** The block a leaf belongs to — for `Pending`'s breadcrumb and the rail's own highlight. */
export function blockFor(to: string): MenuBlock | undefined {
  return BLOCK_OF.get(to);
}

export function blockIdFor(to: string): string | undefined {
  return BLOCK_OF.get(to)?.id;
}

/**
 * The one leaf a location names, or `null`.
 *
 * **Longest match wins**, and that is the whole point of the function. A plain
 * `pathname.startsWith(to)` lights up `/projects` *and* `/projects/unclaimed` at
 * once, because one path is a prefix of the other — two rows highlighted, one
 * destination. Comparing every candidate and keeping the longest is what makes
 * `/projects` stop claiming to be the page you are on the moment you open its
 * unclaimed queue.
 *
 * `end` on the `NavLink` is not enough on its own: it fixes the equal-length case
 * and says nothing about a leaf nested inside another.
 */
export function activeLeaf(pathname: string): MenuLeaf | null {
  const path = pathname.replace(/\/+$/, '') || '/';
  let best: MenuLeaf | null = null;

  for (const leaf of ALL_LEAVES) {
    const hit = leaf.to === '/' ? path === '/' : path === leaf.to || path.startsWith(`${leaf.to}/`);
    if (!hit) continue;
    if (best === null || leaf.to.length > best.to.length) best = leaf;
  }

  return best;
}

/** The same rule the rail badges: a level with no project record is unclaimed. */
export function unclaimedOf(projects: Project[]): number {
  return projects.filter((p) => p.unclaimed).length;
}

/**
 * Distinct order numbers, blanks excluded.
 *
 * A blank is not an order number. Counting `new Set(rows.map(r => r.orderNumber))`
 * includes `''` exactly once, so the badge reads one higher than the number of
 * orders — a small lie, and the same family as rendering `0` for "not loaded".
 */
export function distinctOrders(lines: ExtractLine[]): number {
  const seen = new Set<string>();
  for (const l of lines) if (l.orderNumber) seen.add(l.orderNumber);
  return seen.size;
}
