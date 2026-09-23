/**
 * The default statement for each ledger object — what the app reads when nobody
 * has written a read cap for it.
 *
 * ★ WHY THIS IS A REGISTRY AND NOT SEED ROWS IN `01-app.sql`.
 *
 *   A seed row would be a *copy* of a statement that already exists in the code,
 *   and the copy would be the one a reader sees in the panel — so the two would
 *   drift, and the drift would be invisible until somebody compared them by hand.
 *   This project has already paid for that lesson three times over with the
 *   app-table lists (see the ★ block on `ROUTING_APP_TABLES`): a hand-copy of a
 *   machine-readable set is a claim until a gate diffs it, and the fix is to make
 *   the registry the single source rather than to write a better comment.
 *
 *   So the defaults live here, in code, next to the module that consumes them.
 *   `read-cap.ts` serves the stored row when there is one and falls back to this
 *   table when there is not, which means:
 *
 *     - a fresh deployment reads every object with a sensible statement and no
 *       seed step, and
 *     - editing a default is a code change that a reviewer sees, not a data edit
 *       that nobody does.
 *
 * ★ THE STATEMENTS CARRY NO ROW LIMIT, AND THAT IS DELIBERATE. The cap is appended
 *   per dialect by `read-cap.ts` (Oracle spells it a nested `ROWNUM` bound, SQLite
 *   spells it `LIMIT`), so one statement serves both backends. A statement with a
 *   `LIMIT` written into it would be Oracle-syntax-error on one arm and would also
 *   make the cap double up on the other.
 *
 * ★ EVERY STATEMENT NAMES ITS COLUMNS EXPLICITLY — NEVER `SELECT *`. Three reasons,
 *   and each one has already cost this project a round trip:
 *
 *     1. `SELECT *` on Oracle returns 200+ columns for some of these tables
 *        (`AP_INVOICE_LINES_ALL` has 202), which is a payload nobody reads and a
 *        preview table nobody can scan.
 *     2. The preview's column list comes from the result metadata, so `SELECT *`
 *        makes the panel's column set a function of the deployment's schema rather
 *        than of a decision.
 *     3. A named column that does not exist is a loud `ORA-00904` at the first
 *        read; a `SELECT *` that silently omits what a reader expected is not.
 *
 * ★ THE ORDERING IS PART OF THE DEFAULT, NOT A SEPARATE FIELD. A default statement
 *   is what the object reads *as a window*, so the ordering that makes the window
 *   meaningful belongs with it. `read-cap.ts` appends a stored `order_by` on top;
 *   when there is none, the ordering written here is what the cap wraps.
 *
 * ★ AND A DEFAULT IS NOT A CAP. Nothing here bounds anything: an object with no
 *   stored cap and a default statement reads every matching row, exactly as it did
 *   before this feature existed. The defaults exist so the panel has something
 *   real to preview on first open — a cap with no statement to run is a number in
 *   a box, which is the thing the preview was built to avoid.
 */

/** One object's default read. */
export interface LedgerDefault {
  /** The statement, with no row limit in it. */
  sql: string;
  /**
   * The column(s) the window is taken in, as `order_by` spells it.
   *
   * Carried separately from the statement's own `ORDER BY` because a stored cap's
   * `order_by` is validated against the statement's text, and the panel offers
   * this as the starting value for that field.
   */
  orderBy: string;
  /** Why the statement reads what it reads, in one sentence. */
  note: string;
}

/**
 * The defaults, keyed by the object name as the registry spells it.
 *
 * ★ THE LIST IS DELIBERATELY PARTIAL. An object with no entry here has no default
 *   statement, which is a real state: the panel says so and asks for one rather
 *   than inventing a `SELECT *` that nobody chose. Adding an entry is a decision
 *   about what a reader should see, so it is made one object at a time.
 */
const DEFAULTS: Record<string, LedgerDefault> = {
  // ── The chart of accounts ────────────────────────────────────────────────
  GL_CODE_COMBINATIONS: {
    sql:
      'SELECT CODE_COMBINATION_ID, SEGMENT1, SEGMENT2, SEGMENT3, SEGMENT4, ' +
      'SEGMENT5, SEGMENT6, SEGMENT7, ACCOUNT_TYPE, ENABLED_FLAG, SUMMARY_FLAG ' +
      'FROM GL_CODE_COMBINATIONS',
    orderBy: 'CODE_COMBINATION_ID DESC',
    note:
      'The account combinations, with the seven segments projected so a reader can ' +
      'build the dotted key without a second lookup. Both flags are carried because ' +
      'a summary or disabled combination is a real row that a register usually wants ' +
      'to exclude rather than one it should never see.',
  },
  GL_PERIODS: {
    sql:
      'SELECT PERIOD_NAME, PERIOD_NUM, PERIOD_YEAR, START_DATE, END_DATE, ' +
      "TO_CHAR(START_DATE,'YYYY-MM-DD') AS START_DAY, " +
      "TO_CHAR(END_DATE,'YYYY-MM-DD') AS END_DAY " +
      'FROM GL_PERIODS',
    orderBy: 'PERIOD_YEAR DESC, PERIOD_NUM DESC',
    note:
      'The accounting calendar, newest first. This is the table the AP window is ' +
      'derived from, so it is the one a reader checks when a window looks wrong.',
  },
  GL_LEDGERS: {
    sql: 'SELECT LEDGER_ID, NAME, CURRENCY_CODE, CHART_OF_ACCOUNTS_ID, PERIOD_SET_NAME FROM GL_LEDGERS',
    orderBy: 'LEDGER_ID',
    note: 'The ledgers this instance keeps. One row on the live instance, which is why the PRIMARY subquery elsewhere is a no-op.',
  },
  GL_LOOKUPS: {
    sql: 'SELECT LOOKUP_TYPE, LOOKUP_CODE, MEANING, DESCRIPTION, ENABLED_FLAG FROM GL_LOOKUPS',
    orderBy: 'LOOKUP_TYPE, LOOKUP_CODE',
    note: 'The general lookup values. Small, and read whole by every consumer that needs a code spelled out.',
  },
  GL_JE_HEADERS: {
    sql:
      'SELECT JE_HEADER_ID, JE_CATEGORY, PERIOD_NAME, NAME, ' +
      "TO_CHAR(JE_SOURCE,'YYYY-MM-DD') AS SOURCE_DAY, STATUS_CODE " +
      'FROM GL_JE_HEADERS',
    orderBy: 'JE_HEADER_ID DESC',
    note:
      'Journal headers, newest first. The date is projected as text so it arrives in ' +
      'the same shape on both backends — a raw DATE is a JS Date on one driver and a ' +
      'string on the other.',
  },
  GL_JE_LINES: {
    sql:
      'SELECT JE_LINE_NUM, JE_HEADER_ID, CODE_COMBINATION_ID, ' +
      'ENTERED_DR, ENTERED_CR, ACCOUNTED_DR, ACCOUNTED_CR ' +
      'FROM GL_JE_LINES',
    orderBy: 'JE_HEADER_ID DESC, JE_LINE_NUM',
    note:
      'Journal lines. The four amount columns are all carried because which pair is ' +
      'populated depends on the currency, and a register that showed only the ' +
      'accounted pair would read as zero on a foreign-currency line.',
  },

  // ── Budgets ──────────────────────────────────────────────────────────────
  GL_BALANCES: {
    sql:
      'SELECT LEDGER_ID, CODE_COMBINATION_ID, CURRENCY_CODE, PERIOD_NAME, ' +
      'PERIOD_YEAR, PERIOD_NUM, ACTUAL_FLAG, BUDGET_VERSION_ID, ' +
      'ENCUMBRANCE_TYPE_ID, TRANSLATED_FLAG, PERIOD_NET_DR, PERIOD_NET_CR ' +
      'FROM GL_BALANCES',
    orderBy: 'PERIOD_YEAR DESC, PERIOD_NUM DESC',
    note:
      'The balances, newest period first. ★ THIS IS THE 157-MILLION-ROW TABLE, so it ' +
      'is the one a cap exists for — and the ordering matters more here than anywhere: ' +
      'without it a cap would return an arbitrary slice of the ledger rather than the ' +
      'most recent periods.',
  },
  GL_BUDGET_TYPES: {
    sql: 'SELECT BUDGET_TYPE, DESCRIPTION, AUDIT_TRAIL_FLAG FROM GL_BUDGET_TYPES',
    orderBy: 'BUDGET_TYPE',
    note:
      'The budget types. ★ The key column is `BUDGET_TYPE`, a VARCHAR — there is no ' +
      '`BUDGET_TYPE_ID` on this table, which is the mistake an earlier join made.',
  },
  GL_BUDGET_VERSIONS: {
    sql:
      'SELECT BUDGET_VERSION_ID, BUDGET_TYPE, BUDGET_NAME, VERSION_NUM, STATUS, ' +
      'CONTROL_BUDGET_VERSION_ID FROM GL_BUDGET_VERSIONS',
    orderBy: 'BUDGET_VERSION_ID DESC',
    note:
      'The budget versions. Two rows on the live instance, and every scoped balance row ' +
      'carries the same version id — the fiscal-year axis lives in the period columns, ' +
      'not in a version per year.',
  },
  GL_BUDGET_ENTITIES: {
    sql: 'SELECT BUDGET_ENTITY_ID, BUDGET_ENTITY_NAME, BUDGET_TYPE FROM GL_BUDGET_ENTITIES',
    orderBy: 'BUDGET_ENTITY_ID',
    note: 'The budget entities. Eight rows on the live instance.',
  },
  GL_BUDGET_ASSIGNMENTS: {
    sql:
      'SELECT BUDGET_ASSIGNMENT_ID, BUDGET_VERSION_ID, CODE_COMBINATION_ID, ' +
      'FUNDING_BUDGET_VERSION_ID FROM GL_BUDGET_ASSIGNMENTS',
    orderBy: 'BUDGET_ASSIGNMENT_ID DESC',
    note:
      'The account-to-budget assignments. ★ This table has 90 columns, so the four that ' +
      'carry the relationship are named and the rest are deliberately not read — a ' +
      '`SELECT *` here would be a payload nobody could scan.',
  },

  // ── Flexfields ───────────────────────────────────────────────────────────
  FND_ID_FLEX_STRUCTURES: {
    sql: 'SELECT ID_FLEX_NUM, ID_FLEX_CODE, ID_FLEX_STRUCTURE_CODE, APPLICATION_ID FROM FND_ID_FLEX_STRUCTURES',
    orderBy: 'ID_FLEX_NUM',
    note:
      'The key flexfield definitions. ★ `ID_FLEX_NUM = 1` is NOT the accounting structure ' +
      'on this deployment — an earlier reader keyed on it and described the location ' +
      'flexfield instead.',
  },
  FND_ID_FLEX_SEGMENTS: {
    sql:
      'SELECT ID_FLEX_NUM, SEGMENT_NUM, SEGMENT_NAME, APPLICATION_COLUMN, ' +
      'FLEX_VALUE_SET_ID FROM FND_ID_FLEX_SEGMENTS',
    orderBy: 'ID_FLEX_NUM, SEGMENT_NUM',
    note:
      'The name-to-segment map: which of the seven segments is which, and what each is ' +
      'called. This is the table that answers "what is segment 3" without a guess.',
  },
  FND_FLEX_VALUES: {
    sql: 'SELECT FLEX_VALUE_SET_ID, FLEX_VALUE, DESCRIPTION, ENABLED_FLAG, SUMMARY_FLAG FROM FND_FLEX_VALUES',
    orderBy: 'FLEX_VALUE_SET_ID, FLEX_VALUE',
    note:
      'The flexfield values. ★ It holds ONE row on the live instance, and it does not ' +
      'carry the fund or program values — a picklist built from this would be empty, ' +
      'which is why the scope picker reads `GL_CODE_COMBINATIONS` instead.',
  },
  FND_FLEX_VALUES_TL: {
    sql: 'SELECT FLEX_VALUE_ID, LANGUAGE, DESCRIPTION FROM FND_FLEX_VALUES_TL',
    orderBy: 'FLEX_VALUE_ID',
    note: 'The translated flexfield value descriptions. Joined by id, never read alone.',
  },
  FND_CURRENCIES: {
    sql: 'SELECT CURRENCY_CODE, NAME, DESCRIPTION, ENABLED_FLAG FROM FND_CURRENCIES',
    orderBy: 'CURRENCY_CODE',
    note: 'The currency codes. Read to spell a code out, never to filter.',
  },

  // ── Purchasing ───────────────────────────────────────────────────────────
  PO_HEADERS_ALL: {
    sql:
      'SELECT PO_HEADER_ID, SEGMENT1, TYPE_LOOKUP_CODE, VENDOR_ID, VENDOR_SITE_ID, ' +
      "TO_CHAR(APPROVED_DATE,'YYYY-MM-DD') AS APPROVED_DAY, " +
      'AUTHORIZATION_STATUS, CLOSED_CODE, ATTRIBUTE3, ATTRIBUTE4 ' +
      'FROM PO_HEADERS_ALL',
    orderBy: 'PO_HEADER_ID DESC',
    note:
      'Purchase-order headers. ★ `ATTRIBUTE3`/`ATTRIBUTE4` ARE the project name and the ' +
      'external order number on this deployment — `PO_HEADERS_ALL` has no `EXP_*` column ' +
      'at all, and reading one raises ORA-00904. `APPROVED_DATE` is the only usable date ' +
      'on this table.',
  },
  PO_LINES_ALL: {
    sql:
      'SELECT PO_LINE_ID, PO_HEADER_ID, LINE_NUM, LINE_TYPE_ID, ITEM_ID, ' +
      'ITEM_DESCRIPTION, UNIT_PRICE, QUANTITY, UNIT_MEAS_LOOKUP_CODE, CLOSED_CODE ' +
      'FROM PO_LINES_ALL',
    orderBy: 'PO_HEADER_ID DESC, LINE_NUM',
    note:
      'Purchase-order lines. ★ `AMOUNT` IS NOT A COLUMN — the line amount is ' +
      '`UNIT_PRICE * QUANTITY`, and on the extract this deployment ships `UNIT_PRICE` is ' +
      '1.00 on every line, so the amount is the quantity.',
  },
  PO_LINE_LOCATIONS_ALL: {
    sql:
      'SELECT LINE_LOCATION_ID, PO_HEADER_ID, PO_LINE_ID, SHIP_TO_LOCATION_ID, ' +
      'QUANTITY, QUANTITY_RECEIVED, QUANTITY_ACCEPTED, CLOSED_CODE ' +
      'FROM PO_LINE_LOCATIONS_ALL',
    orderBy: 'LINE_LOCATION_ID DESC',
    note:
      'The line shipments. ★ There is no `VENDOR_SITE_ID` here — the site is on the ' +
      'header, and a join that looked for it on this table raised ORA-00904.',
  },
  PO_DISTRIBUTIONS_ALL: {
    sql:
      'SELECT PO_DISTRIBUTION_ID, PO_HEADER_ID, PO_LINE_ID, LINE_LOCATION_ID, ' +
      'CODE_COMBINATION_ID, SET_OF_BOOKS_ID, QUANTITY_ORDERED, ' +
      'AMOUNT_ORDERED, AMOUNT_BILLED, ENCUMBERED_AMOUNT, ENCUMBERED_FLAG ' +
      'FROM PO_DISTRIBUTIONS_ALL',
    orderBy: 'PO_DISTRIBUTION_ID DESC',
    note:
      'The order distributions — the account each order line was charged to. ★ ' +
      '`ENCUMBERED_AMOUNT` EQUALS `AMOUNT_ORDERED` on every row of the shipped scope and ' +
      '`AMOUNT_BILLED` is zero on all of them, so a register calling either column "what ' +
      'is still committed" would be wrong.',
  },
  PO_VENDORS: {
    sql:
      'SELECT VENDOR_ID, SEGMENT1, VENDOR_NAME, VENDOR_NAME_ALT, ENABLED_FLAG, ' +
      'START_DATE_ACTIVE, END_DATE_ACTIVE FROM PO_VENDORS',
    orderBy: 'VENDOR_NAME',
    note:
      'The vendor master. ★ 79,685 rows on the live instance against 157 in the sample, ' +
      'so a count here is a scope question rather than a data one.',
  },
  PO_VENDOR_SITES_ALL: {
    sql:
      'SELECT VENDOR_SITE_ID, VENDOR_ID, VENDOR_SITE_CODE, VENDOR_SITE_CODE_ALT, ' +
      'ADDRESS_LINE1, ADDRESS_LINE2, CITY, STATE, ZIP, COUNTRY, ' +
      'PURCHASING_SITE_FLAG, INACTIVE_DATE FROM PO_VENDOR_SITES_ALL',
    orderBy: 'VENDOR_SITE_ID DESC',
    note:
      'The vendor addresses — 99,316 rows across 79,590 vendors on the live instance. ' +
      'The address columns are carried because the register geocodes from them, and the ' +
      'two retirement signals are carried because a deprecated site is a real row.',
  },
  PO_AGENTS: {
    sql: 'SELECT AGENT_ID, NAME, START_DATE_ACTIVE, END_DATE_ACTIVE FROM PO_AGENTS',
    orderBy: 'NAME',
    note:
      'The buyers. ★ `NAME` is served as null for some rows by the shape resolver while a ' +
      'hand-written query naming `A.NAME` directly raises ORA-00904 — the warning is not ' +
      'a guard.',
  },
  PO_LINE_TYPES: {
    sql: 'SELECT LINE_TYPE_ID, LINE_TYPE_CODE, DESCRIPTION FROM PO_LINE_TYPES',
    orderBy: 'LINE_TYPE_ID',
    note: 'The line types — GOODS, SERVICES and the rest. A lookup, read whole.',
  },
  PO_LOOKUP_CODES: {
    sql: 'SELECT LOOKUP_TYPE, LOOKUP_CODE, MEANING, DESCRIPTION, ENABLED_FLAG FROM PO_LOOKUP_CODES',
    orderBy: 'LOOKUP_TYPE, LOOKUP_CODE',
    note: 'The purchasing lookup values. Three columns of real content on the live instance.',
  },

  // ── Projects ─────────────────────────────────────────────────────────────
  PA_PROJECTS_ALL: {
    sql:
      'SELECT PROJECT_ID, SEGMENT1, NAME, PROJECT_NUMBER, PROJECT_STATUS_CODE, ' +
      'START_DATE, COMPLETION_DATE FROM PA_PROJECTS_ALL',
    orderBy: 'PROJECT_ID DESC',
    note:
      'The projects. ★ ZERO rows on the live instance — the project names this app shows ' +
      'come from the app-owned registry, not from here.',
  },
  PA_TASKS: {
    sql: 'SELECT TASK_ID, PROJECT_ID, TASK_NUMBER, TASK_NAME, START_DATE, COMPLETION_DATE FROM PA_TASKS',
    orderBy: 'TASK_ID DESC',
    note: 'The project tasks. Read with the project, never alone.',
  },
  PA_BUDGET_VERSIONS: {
    sql: 'SELECT BUDGET_VERSION_ID, PROJECT_ID, BUDGET_TYPE_CODE, DESCRIPTION, STATUS_CODE FROM PA_BUDGET_VERSIONS',
    orderBy: 'BUDGET_VERSION_ID DESC',
    note: 'The project budget versions. Zero rows on the live instance, like the projects themselves.',
  },
  PA_BUDGET_LINES: {
    sql: 'SELECT BUDGET_LINE_ID, BUDGET_VERSION_ID, PROJECT_ID, TASK_ID, LINE_CODE, RAW_COST, BURDENED_COST FROM PA_BUDGET_LINES',
    orderBy: 'BUDGET_LINE_ID DESC',
    note: 'The project budget lines. Zero rows on the live instance.',
  },

  // ── The AP base tables ───────────────────────────────────────────────────
  AP_INVOICE_LINES_ALL: {
    sql:
      'SELECT INVOICE_ID, LINE_NUMBER, LINE_TYPE_LOOKUP_CODE, AMOUNT, ' +
      'PO_HEADER_ID, PO_LINE_ID, DEFAULT_DIST_CCID, ITEM_DESCRIPTION ' +
      'FROM AP_INVOICE_LINES_ALL',
    orderBy: 'INVOICE_ID DESC, LINE_NUMBER',
    note:
      'The invoice lines. ★ THE ACCOUNT COLUMN IS `DEFAULT_DIST_CCID`, NOT ' +
      '`DEFAULT_CODE_COMBINATION_ID` — the obvious name raises ORA-00904, and ' +
      '`ALL_TAB_COLUMNS` returns zero rows for this table so the name can only be read ' +
      'from result metadata.',
  },
  AP_INVOICE_DISTRIBUTIONS_ALL: {
    sql:
      'SELECT INVOICE_DISTRIBUTION_ID, INVOICE_ID, DIST_CODE_COMBINATION_ID, ' +
      'LINE_TYPE_LOOKUP_CODE, AMOUNT, BASE_AMOUNT, ACCOUNTING_DATE ' +
      'FROM AP_INVOICE_DISTRIBUTIONS_ALL',
    orderBy: 'INVOICE_DISTRIBUTION_ID DESC',
    note:
      'The invoice distributions — where each invoice was actually charged. ★ THE COLUMN ' +
      'IS `DIST_CODE_COMBINATION_ID`: `CODE_COMBINATION_ID` raises ORA-00904. This is the ' +
      'table the AP scope reads, because the line carries a *default* account that may ' +
      'differ from where the money went.',
  },

  // ── The customer's extract views ─────────────────────────────────────────
  WCSEXP_AP_CHECKS: {
    sql: 'SELECT CHECK_ID, CHECK_NUMBER, TO_CHAR(CHECK_DATE,\'YYYY-MM-DD\') AS CHECK_DATE, AMOUNT FROM WCSEXP_AP_CHECKS',
    orderBy: 'CHECK_DATE DESC',
    note:
      'The payment documents. ★ Four columns — a check carries NO account segment, so ' +
      'there is nothing on it to test a fund or a program against. The scope reaches ' +
      'these rows through the invoice each check settled.',
  },
  WCSEXP_AP_INVOICES: {
    sql:
      'SELECT INVOICE_ID, INVOICE_NUM, TO_CHAR(INVOICE_DATE,\'YYYY-MM-DD\') AS INVOICE_DATE, ' +
      'INVOICE_AMOUNT, AMOUNT_PAID, PAYMENT_STATUS_FLAG, DESCRIPTION, VENDOR_ID, VENDOR_SITE_ID ' +
      'FROM WCSEXP_AP_INVOICES',
    orderBy: 'INVOICE_DATE DESC',
    note:
      'The invoices, with `VENDOR_ID` and `VENDOR_SITE_ID` — the keys that join a row to ' +
      'the vendor-site register on a real foreign key rather than a name match.',
  },
  WCSEXP_AP_INVOICE_PAYMENTS: {
    sql:
      'SELECT INVOICE_PAYMENT_ID, CHECK_ID, INVOICE_ID, AMOUNT, PAYMENT_NUM, ' +
      "TO_CHAR(PAYMENT_DATE,'YYYY-MM-DD') AS PAYMENT_DAY FROM WCSEXP_AP_INVOICE_PAYMENTS",
    orderBy: 'INVOICE_PAYMENT_ID DESC',
    note:
      'The check-to-invoice links. ★ NOT UNIQUE on (CHECK_ID, INVOICE_ID, PAYMENT_NUM), so ' +
      'a join through this view alone returns a check\'s invoices twice over — the AP ' +
      'routes use `SELECT DISTINCT` for exactly that reason.',
  },
  WCSEXP_AP_INV_LINES: {
    sql: 'SELECT INVOICE_ID, LINE_NUMBER, LINE_TYPE_LOOKUP_CODE, AMOUNT, PO_HEADER_ID, ITEM_DESCRIPTION FROM WCSEXP_AP_INV_LINES',
    orderBy: 'INVOICE_ID DESC, LINE_NUMBER',
    note: 'The invoice lines as the extract view exposes them — a column subset of the base table.',
  },
  WCSEXP_AP_INV_DISTRIBUTIONS: {
    sql: 'SELECT INVOICE_ID, DIST_CODE_COMBINATION_ID, LINE_TYPE_LOOKUP_CODE, AMOUNT, ACCOUNTING_DATE FROM WCSEXP_AP_INV_DISTRIBUTIONS',
    orderBy: 'INVOICE_ID DESC',
    note: 'The invoice distributions as the extract view exposes them. The account column keeps its `DIST_` prefix.',
  },
  WCSEXP_PO_HEADERS: {
    sql:
      'SELECT PO_HEADER_ID, PO_NUMBER, VENDOR_ID, VENDOR_SITE_ID, ' +
      "TO_CHAR(APPROVED_DATE,'YYYY-MM-DD') AS APPROVED_DAY, " +
      'AUTHORIZATION_STATUS, EXP_PROJECT_NAME, EXP_PO_NUMBER FROM WCSEXP_PO_HEADERS',
    orderBy: 'PO_HEADER_ID DESC',
    note:
      'The order headers as the extract view exposes them. ★ This view is the ONLY place ' +
      '`EXP_PROJECT_NAME` and `EXP_PO_NUMBER` exist — the base table has no such columns.',
  },
  WCSEXP_PO_LINES: {
    sql: 'SELECT PO_LINE_ID, PO_HEADER_ID, LINE_NUM, LINE_TYPE_ID, ITEM_ID, ITEM_DESCRIPTION, UNIT_PRICE, QUANTITY, CLOSED_CODE FROM WCSEXP_PO_LINES',
    orderBy: 'PO_HEADER_ID DESC, LINE_NUM',
    note: 'The order lines as the extract view exposes them.',
  },
  WCSEXP_PO_DISTRIBUTIONS: {
    sql: 'SELECT PO_DISTRIBUTION_ID, PO_HEADER_ID, PO_LINE_ID, CODE_COMBINATION_ID, QUANTITY_ORDERED, AMOUNT_ORDERED, ENCUMBERED_FLAG FROM WCSEXP_PO_DISTRIBUTIONS',
    orderBy: 'PO_DISTRIBUTION_ID DESC',
    note: 'The order distributions as the extract view exposes them.',
  },
  WCSEXP_PO_LINE_LOCATIONS: {
    sql: 'SELECT LINE_LOCATION_ID, PO_HEADER_ID, PO_LINE_ID, SHIP_TO_LOCATION_ID, QUANTITY, QUANTITY_RECEIVED, CLOSED_CODE FROM WCSEXP_PO_LINE_LOCATIONS',
    orderBy: 'LINE_LOCATION_ID DESC',
    note: 'The line shipments as the extract view exposes them.',
  },
  WCSEXP_PO_VENDORS: {
    sql: 'SELECT VENDOR_ID, SEGMENT1, VENDOR_NAME, VENDOR_NAME_ALT, ENABLED_FLAG FROM WCSEXP_PO_VENDORS',
    orderBy: 'VENDOR_NAME',
    note: 'The vendor master as the extract view exposes it — the narrower projection the AP routes join through.',
  },
  WCSEXP_PO_VENDOR_SITES: {
    sql: 'SELECT VENDOR_SITE_ID, VENDOR_ID, VENDOR_SITE_CODE, ADDRESS_LINE1, CITY, STATE, ZIP, PURCHASING_SITE_FLAG FROM WCSEXP_PO_VENDOR_SITES',
    orderBy: 'VENDOR_SITE_ID DESC',
    note: 'The vendor addresses as the extract view exposes them.',
  },
  WCSEXP_PO_VENDOR_CONTACTS: {
    sql: 'SELECT VENDOR_CONTACT_ID, VENDOR_ID, VENDOR_SITE_ID, FIRST_NAME, LAST_NAME, EMAIL_ADDRESS, PHONE FROM WCSEXP_PO_VENDOR_CONTACTS',
    orderBy: 'VENDOR_CONTACT_ID DESC',
    note: 'The vendor contacts. Read with the site, never alone.',
  },
  WCSEXP_PO_RELEASES: {
    sql: 'SELECT PO_RELEASE_ID, PO_HEADER_ID, RELEASE_NUM, RELEASE_DATE, AUTHORIZATION_STATUS FROM WCSEXP_PO_RELEASES',
    orderBy: 'PO_RELEASE_ID DESC',
    note: 'The blanket-order releases.',
  },
  WCSEXP_PO_LINE_TYPES: {
    sql: 'SELECT LINE_TYPE_ID, LINE_TYPE_CODE, DESCRIPTION FROM WCSEXP_PO_LINE_TYPES',
    orderBy: 'LINE_TYPE_ID',
    note: 'The line types as the extract view exposes them.',
  },
  WCSEXP_PO_LOOKUP_CODES: {
    sql: 'SELECT LOOKUP_TYPE, LOOKUP_CODE, MEANING, DESCRIPTION, ENABLED_FLAG FROM WCSEXP_PO_LOOKUP_CODES',
    orderBy: 'LOOKUP_TYPE, LOOKUP_CODE',
    note: 'The purchasing lookups as the extract view exposes them.',
  },
  WCSEXP_GL_CODE_COMBINATIONS: {
    sql:
      'SELECT CODE_COMBINATION_ID, SEGMENT1, SEGMENT2, SEGMENT3, SEGMENT4, ' +
      'SEGMENT5, SEGMENT6, SEGMENT7, ACCOUNT_TYPE, ENABLED_FLAG, SUMMARY_FLAG ' +
      'FROM WCSEXP_GL_CODE_COMBINATIONS',
    orderBy: 'CODE_COMBINATION_ID DESC',
    note:
      'The account combinations as the extract view exposes them. ★ 13 columns against the ' +
      'base table\'s 112 — and NO date column at all, which is why the extract files carry ' +
      'a `LAST_UPDATE_DATE` this view cannot supply.',
  },
  WCSEXP_FND_ID_FLEX_STRUCTURES: {
    sql: 'SELECT ID_FLEX_NUM, ID_FLEX_CODE, ID_FLEX_STRUCTURE_CODE, APPLICATION_ID FROM WCSEXP_FND_ID_FLEX_STRUCTURES',
    orderBy: 'ID_FLEX_NUM',
    note: 'The flexfield definitions as the extract view exposes them.',
  },
  WCSEXP_MTL_SYSTEM_ITEMS: {
    sql: 'SELECT INVENTORY_ITEM_ID, SEGMENT1, DESCRIPTION, ITEM_TYPE, START_DATE_ACTIVE, END_DATE_ACTIVE FROM WCSEXP_MTL_SYSTEM_ITEMS',
    orderBy: 'INVENTORY_ITEM_ID DESC',
    note: 'The inventory items — the item master behind every order line\'s item id.',
  },
  WCSEXP_HR_LOCATIONS: {
    sql: 'SELECT LOCATION_ID, LOCATION_CODE, DESCRIPTION, ADDRESS_LINE_1, CITY, STATE, POSTAL_CODE, COUNTRY FROM WCSEXP_HR_LOCATIONS',
    orderBy: 'LOCATION_ID DESC',
    note: 'The HR locations — the ship-to addresses behind the line shipments.',
  },
};

/**
 * The default read for an object, or null when none is declared.
 *
 * ★ NULL IS A REAL ANSWER AND THE PANEL RENDERS IT AS ONE. An object with no default
 *   is not an error and not an empty statement: it means nobody has decided what a
 *   reader should see from it, so the panel asks for a statement rather than
 *   inventing one. That is the same distinction the read-cap list makes between
 *   "uncapped" and "missing".
 */
export function defaultReadFor(tableName: string): LedgerDefault | null {
  return DEFAULTS[tableName.trim().toUpperCase()] ?? null;
}

/** Every object that has a default, for a gate that asserts the set is sane. */
export function defaultReadTables(): string[] {
  return Object.keys(DEFAULTS).sort();
}

/**
 * Every default, for the gates that read them.
 *
 * Exported so `smoke.ts` can assert the properties that matter without reaching
 * into the module: that no statement carries a row limit (the cap is appended per
 * dialect), that none is a `SELECT *`, and that every `orderBy` names a column the
 * statement actually mentions — the same rule the write path enforces, checked
 * here against the defaults so a typo fails the suite rather than a reader's first
 * preview.
 */
export function allDefaults(): { table: string; def: LedgerDefault }[] {
  return Object.entries(DEFAULTS).map(([table, def]) => ({ table, def }));
}
