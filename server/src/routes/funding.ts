import { z } from '../http/z.js';
import { IntParam } from '../http/z.js';
import type { Api } from '../http/api.js';
import { AppError } from '../http/errors.js';
import { findRow, listRows, queryFor, registerResource, type ResourceDescriptor, type SegmentFilter } from './resource.js';
import { bindable, columnNumber, one, quoteIdent, rows } from '../db/sql.js';
import { defaultTenant } from '../auth/session.js';
import { derivedPlan } from '../db/derived.js';
import { storeDriver } from '../db/client.js';
import { date, flag, int, intReq, real, realReq, rowObject, text, textReq, writeObject } from '../schemas/columns.js';

/**
 * Funding — budgets, budget journals, and the two derived money measures.
 *
 * This is the domain the report is actually about, and three things about the
 * source shape decide how the endpoints are built.
 *
 * ─── 1. Money is never summed straight off `GL_BALANCES` ──────────────────────
 *
 * `GL_BALANCES` holds actuals, budgets and encumbrances in ONE table,
 * discriminated by `ACTUAL_FLAG` (`'A'` / `'B'` / `'E'`), and it also holds
 * translated copies and per-encumbrance-type splits. Summing the table without
 * narrowing it is wrong by a large factor rather than by a rounding: five columns
 * have to be pinned before a budget total means anything, and the seed
 * deliberately includes rows that only the filters exclude.
 *
 * So no endpoint here computes a total itself. Both money measures are read from
 * the reporting views (`V_BUDGET_BY_ACCOUNT_PERIOD`, `V_ACCOUNT_POSITION`), which
 * the schema already defines with all five predicates written down:
 *
 *     ACTUAL_FLAG = 'B'  ·  TRANSLATED_FLAG = 'N'  ·  ENCUMBRANCE_TYPE_ID IS NULL
 *     LEDGER.CATEGORY_CODE = 'PRIMARY'  ·  CODE_COMBINATION.SUMMARY_FLAG = 'N'
 *
 * Registering the view as a resource is what makes that structural rather than
 * aspirational: there is no query string a caller can send that drops a filter,
 * because the filters live in the view's definition and not in a request parser.
 * A hand-written `SUM` in a handler is one refactor away from losing one of them.
 *
 * ─── 2. Allocations is a derived measure, not a table ────────────────────────
 *
 * There is no `ALLOCATIONS` object in this schema, and there should not be.
 * `Available Funds = Allocations − Encumbrances − Expenditures`, per account, is
 * the report's own formula and the report *computes* it. `V_ACCOUNT_POSITION`
 * reproduces that. Labelling it "derived" everywhere it appears is not hedging —
 * it is the difference between a consumer trusting the number and a consumer
 * needing to know that it will move when the formula does.
 *
 * One consequence is worth stating plainly: the split between "WCPSS Budget" and
 * "Allocations/Reimb." is modelled by BUDGET TYPE (`CAPITAL` vs `APPROP`) because
 * that is the only version-scoped axis the objects offer. The view's own
 * docblock calls that an interpretation rather than a verified fact, and this
 * module keeps that label on it.
 *
 * ─── 3. The journals here are budget journals ────────────────────────────────
 *
 * `JE_CATEGORY` in this sample is only ever `'Budget'` and `JE_SOURCE` only ever
 * `'WCPSS BUDGET'`. That is why journal entries belong under Funding and not
 * under Spend: there is no payables journal in the slice. The journal is also the
 * only object that keeps an *action date* — `GL_BALANCES` is a per-period rollup
 * and has lost it, while `GL_JE_HEADERS.DEFAULT_EFFECTIVE_DATE` still holds the
 * BOE date. "When was this funded?" is a journal question and cannot be answered
 * from the balances.
 *
 * ─── Composite keys ─────────────────────────────────────────────────────────
 *
 * Four of the eight tables are keyed on more than one column
 * (`GL_BUDGET_ASSIGNMENTS`, `GL_JE_LINES`, `PA_BUDGET_LINES`, and — for the
 * purposes of a single-column detail route — none of the rest). A resource with
 * no `pk` gets no detail route and no writes, which is the framework's rule and
 * the right one here: see the note on `GL_BUDGET_ASSIGNMENTS` below for why a
 * range row in particular must not be PATCH-able.
 */

// ---------------------------------------------------------------------------
// Column lists. These are the SELECT allowlist AND the sort allowlist AND the
// filter allowlist — `resource.ts` validates filters against them, so a filter
// naming a column that is not selected fails at request time.
// ---------------------------------------------------------------------------

const BUDGET_TYPE_COLUMNS = [
  'BUDGET_TYPE_ID',
  'BUDGET_TYPE_CODE',
  'BUDGET_NAME',
  'DESCRIPTION',
  'ENABLED_FLAG',
] as const;

const BUDGET_VERSION_COLUMNS = [
  'BUDGET_VERSION_ID',
  'LEDGER_ID',
  'BUDGET_TYPE_ID',
  'BUDGET_NAME',
  'FIRST_PERIOD_NAME',
  'LAST_PERIOD_NAME',
  'DEFAULT_PERIOD_NAME',
  'STATUS_CODE',
  'LATEST_FLAG',
  'BUDGET_ENTRY_STATUS',
  'CREATION_DATE',
] as const;

const BUDGET_ENTITY_COLUMNS = [
  'BUDGET_ENTITY_ID',
  'BUDGET_TYPE_ID',
  'BUDGET_ENTITY_NAME',
  'ENABLED_FLAG',
] as const;

const BUDGET_ASSIGNMENT_COLUMNS = [
  'BUDGET_VERSION_ID',
  'RANGE_FROM',
  'RANGE_TO',
  'BUDGET_ENTITY_ID',
] as const;

const JE_HEADER_COLUMNS = [
  'JE_HEADER_ID',
  'LEDGER_ID',
  'JE_CATEGORY',
  'JE_SOURCE',
  'PERIOD_NAME',
  'NAME',
  'STATUS',
  'DATE_CREATED',
  'ACTUAL_FLAG',
  'DEFAULT_EFFECTIVE_DATE',
  'ENCUMBRANCE_TYPE_ID',
  'POSTED_DATE',
  'DESCRIPTION',
] as const;

const JE_LINE_COLUMNS = [
  'JE_HEADER_ID',
  'JE_LINE_NUM',
  'LEDGER_ID',
  'EFFECTIVE_DATE',
  'CODE_COMBINATION_ID',
  'STATUS',
  'ENTERED_DR',
  'ENTERED_CR',
  'DESCRIPTION',
  'LINE_TYPE_CODE',
  'INVOICE_IDENTIFIER',
  'INVOICE_AMOUNT',
] as const;

const PA_BUDGET_VERSION_COLUMNS = [
  'BUDGET_VERSION_ID',
  'PROJECT_ID',
  'VERSION_NUMBER',
  'VERSION_NAME',
  'CURRENT_FLAG',
  'STATUS_CODE',
  'CREATION_DATE',
] as const;

const PA_BUDGET_LINE_COLUMNS = [
  'BUDGET_VERSION_ID',
  'LINE_NUM',
  'TASK_ID',
  'RESOURCE_LIST_MEMBER_ID',
  'RAW_COST',
  'BURDENED_COST',
] as const;

// --- The two reporting views, narrowed to the columns this domain exposes. ---

const BUDGET_BY_ACCOUNT_COLUMNS = [
  'LEDGER_ID',
  'CODE_COMBINATION_ID',
  'SEGMENT1',
  'SEGMENT2',
  'SEGMENT3',
  'SEGMENT4',
  'SEGMENT5',
  'SEGMENT6',
  'SEGMENT7',
  'BUDGET_VERSION_ID',
  'PERIOD_YEAR',
  'PERIOD_NUM',
  'PERIOD_NAME',
  'NET_AMOUNT',
  'BALANCE_ROWS',
] as const;

const ACCOUNT_POSITION_COLUMNS = [
  'CODE_COMBINATION_ID',
  'OBJECT_CODE',
  'LEVEL_CODE',
  'BUDGET_ACCOUNT',
  'WCPSS_BUDGET',
  'ALLOCATIONS_REIMB',
  'ENCUMBRANCES',
  'EXPENDITURES',
  'AVAILABLE_FUNDS',
] as const;

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

/**
 * `ACTUAL_FLAG` is not a `Y`/`N` flag, so it cannot use the `flag()` helper.
 *
 * Oracle keeps three different ledgers of truth in one table and this column is
 * the only thing that says which one a row belongs to. It is documented at the
 * top of every endpoint that touches `GL_BALANCES` because reading it as a
 * yes/no flag is the single easiest way to produce a wrong total.
 */
const actualFlag = z.enum(['A', 'B', 'E']).nullable().openapi({
  description:
    '`A` actual · `B` budget · `E` encumbrance. Oracle stores all three in `GL_BALANCES`, so this column — not the table — is what discriminates them.',
});

const budgetTypeRow = rowObject(
  {
    BUDGET_TYPE_ID: int('Surrogate key.'),
    BUDGET_TYPE_CODE: textReq("Short code, unique. In this sample: `APPROP` and `CAPITAL`."),
    BUDGET_NAME: textReq('Display name for the budget type.'),
    DESCRIPTION: text('Free-text description.'),
    ENABLED_FLAG: flag('Whether new budget versions may be created under this type.'),
  },
  'A budget type as stored in `GL_BUDGET_TYPES`.',
);

const budgetVersionRow = rowObject(
  {
    BUDGET_VERSION_ID: int('Surrogate key.'),
    LEDGER_ID: intReq('The ledger the version belongs to. Foreign key to `GL_LEDGERS`.'),
    BUDGET_TYPE_ID: intReq('The budget type. Foreign key to `GL_BUDGET_TYPES`.'),
    BUDGET_NAME: textReq('Name of this version of the budget.'),
    FIRST_PERIOD_NAME: text('First period the version spans.'),
    LAST_PERIOD_NAME: text('Last period the version spans.'),
    DEFAULT_PERIOD_NAME: text('The period used when a journal does not name one.'),
    STATUS_CODE: text("`OPEN`, `CURRENT`, or `FROZEN`."),
    LATEST_FLAG: flag('`Y` on exactly one version per budget type.'),
    BUDGET_ENTRY_STATUS: text('Whether budget entry is still permitted on the version.'),
    CREATION_DATE: date('When the version was created.'),
  },
  'A budget version as stored in `GL_BUDGET_VERSIONS`.',
);

const budgetEntityRow = rowObject(
  {
    BUDGET_ENTITY_ID: int('Surrogate key.'),
    BUDGET_TYPE_ID: intReq('The budget type this entity belongs to.'),
    BUDGET_ENTITY_NAME: textReq('What the budget is kept against.'),
    ENABLED_FLAG: flag('Whether the entity is in use.'),
  },
  'A budget entity as stored in `GL_BUDGET_ENTITIES`.',
);

const budgetAssignmentRow = rowObject(
  {
    BUDGET_VERSION_ID: intReq('Part 1 of 3 of the key — the version the range belongs to.'),
    RANGE_FROM: text('Part 2 of 3 of the key — the low end of the account range, as a concatenated segment string.'),
    RANGE_TO: text('Part 3 of 3 of the key — the high end of the same range.'),
    BUDGET_ENTITY_ID: int('The entity the range is assigned to.'),
  },
  'An account range assigned to a budget version, from `GL_BUDGET_ASSIGNMENTS`.',
);

const jeHeaderRow = rowObject(
  {
    JE_HEADER_ID: int('Surrogate key.'),
    LEDGER_ID: intReq('The ledger. Foreign key to `GL_LEDGERS`.'),
    JE_CATEGORY: textReq("Journal category. Only `Budget` appears in this sample."),
    JE_SOURCE: textReq("Journal source. Only `WCPSS BUDGET` appears in this sample."),
    PERIOD_NAME: textReq('The accounting period the journal posts to.'),
    NAME: text('Free-text journal name.'),
    STATUS: text('`U` unposted · `P` posted.'),
    DATE_CREATED: date('When the journal was created.'),
    ACTUAL_FLAG: actualFlag,
    DEFAULT_EFFECTIVE_DATE: date(
      'The action date — the Budget Obligation or Entry date. This is the authoritative answer to "when was this funded?", and it is the one date `GL_BALANCES` does not keep.',
    ),
    ENCUMBRANCE_TYPE_ID: int('Set only on an encumbrance journal; null on a budget journal.'),
    POSTED_DATE: date('When the journal was posted.'),
    DESCRIPTION: text('Free-text description.'),
  },
  'A journal header as stored in `GL_JE_HEADERS`.',
);

const jeLineRow = rowObject(
  {
    JE_HEADER_ID: intReq('Part 1 of 2 of the key — the header this line belongs to.'),
    JE_LINE_NUM: intReq('Part 2 of 2 of the key — the line number within the header.'),
    LEDGER_ID: intReq('The ledger, repeated from the header.'),
    EFFECTIVE_DATE: date('The line’s effective date.'),
    CODE_COMBINATION_ID: intReq(
      'The account the line hits. Not durable across a chart-of-accounts change — join on the seven segments when crossing a boundary you do not control.',
    ),
    STATUS: text('`U` unposted · `P` posted.'),
    ENTERED_DR: realReq('Debit entered in the ledger currency. NOT NULL, defaulting to 0.'),
    ENTERED_CR: realReq('Credit entered in the ledger currency. NOT NULL, defaulting to 0.'),
    DESCRIPTION: text('Free-text line description.'),
    LINE_TYPE_CODE: text("Line type. Only `BUDGET` appears in this sample."),
    INVOICE_IDENTIFIER: text('Invoice reference, on a line that carries one.'),
    INVOICE_AMOUNT: real('Invoice amount, on a line that carries one.'),
  },
  'A journal line as stored in `GL_JE_LINES`.',
);

const paBudgetVersionRow = rowObject(
  {
    BUDGET_VERSION_ID: int('Surrogate key. A separate sequence from the GL one.'),
    PROJECT_ID: intReq('The project this version budgets.'),
    VERSION_NUMBER: int('Ordinal of the version within the project.'),
    VERSION_NAME: text('Name of the version.'),
    CURRENT_FLAG: flag('`Y` on the version the project is currently measured against.'),
    STATUS_CODE: text('Version status.'),
    CREATION_DATE: date('When the version was created.'),
  },
  'A project budget version as stored in `PA_BUDGET_VERSIONS`.',
);

const paBudgetLineRow = rowObject(
  {
    BUDGET_VERSION_ID: intReq('Part 1 of 2 of the key — the project budget version.'),
    LINE_NUM: intReq('Part 2 of 2 of the key — the line number within the version.'),
    TASK_ID: int('The task the amount is budgeted to.'),
    RESOURCE_LIST_MEMBER_ID: int('The resource the amount is budgeted for.'),
    RAW_COST: realReq('Raw cost. NOT NULL, defaulting to 0.'),
    BURDENED_COST: realReq('Bundened cost — raw cost plus burden. NOT NULL, defaulting to 0.'),
  },
  'A project budget line as stored in `PA_BUDGET_LINES`.',
);

const budgetByAccountRow = rowObject(
  {
    LEDGER_ID: intReq('The ledger.'),
    CODE_COMBINATION_ID: intReq('The account.'),
    SEGMENT1: text('Fund.'),
    SEGMENT2: text('Purpose.'),
    SEGMENT3: text('Program.'),
    SEGMENT4: text('Object code.'),
    SEGMENT5: text('Level code.'),
    SEGMENT6: text('Cost center.'),
    SEGMENT7: text('Future segment.'),
    BUDGET_VERSION_ID: intReq('The budget version the amount sits under.'),
    PERIOD_YEAR: intReq('Fiscal year.'),
    PERIOD_NUM: intReq('Period number within the year. Sort on this, never on `PERIOD_NAME`.'),
    PERIOD_NAME: text('Period name such as `JUL-25`. This sorts incorrectly as text — `JUL-24` > `JUL-25` — which is why the sort keys are the year and the number.'),
    NET_AMOUNT: real('Net budget for this account, version and period: debits less credits.'),
    BALANCE_ROWS: int('How many `GL_BALANCES` rows were rolled up into `NET_AMOUNT`.'),
  },
  'One budgeted account for one period, from the `V_BUDGET_BY_ACCOUNT_PERIOD` view.',
);

const accountPositionRow = rowObject(
  {
    CODE_COMBINATION_ID: intReq('The account.'),
    OBJECT_CODE: text('Segment 4, the object code.'),
    LEVEL_CODE: text('Segment 5, the level code.'),
    BUDGET_ACCOUNT: text('The full account as a dotted seven-segment string.'),
    WCPSS_BUDGET: real('The `CAPITAL` budget for this account.'),
    ALLOCATIONS_REIMB: real(
      '**Derived.** The `APPROP` budget for this account, read as allocations and reimbursements. The mapping from budget type to this label is an interpretation, not a verified fact — see the view’s own note.',
    ),
    ENCUMBRANCES: real('Sum of `ACTUAL_FLAG = \'E\'` balances for this account.'),
    EXPENDITURES: real('Sum of `ACTUAL_FLAG = \'A\'` balances for this account.'),
    AVAILABLE_FUNDS: real(
      '**Derived:** `ALLOCATIONS_REIMB − ENCUMBRANCES − EXPENDITURES`. Computed by the view, never stored.',
    ),
  },
  'Per-account funding position, from the `V_ACCOUNT_POSITION` view.',
);

// Derived from the row schemas — see `writeObject`. Only the columns the DDL
// makes NOT NULL stay required, and only because they reject an explicit null.
const budgetTypeWrite = writeObject(budgetTypeRow, 'A budget type to create or update.');
const budgetVersionWrite = writeObject(budgetVersionRow, 'A budget version to create or update.');
const budgetEntityWrite = writeObject(budgetEntityRow, 'A budget entity to create or update.');
const jeHeaderWrite = writeObject(jeHeaderRow, 'A journal header to create or update.');
const paBudgetVersionWrite = writeObject(paBudgetVersionRow, 'A project budget version to create or update.');

// ---------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------

const BUDGET_TYPE: ResourceDescriptor = {
  name: 'budgetTypes',
  label: 'Budget type',
  basePath: '/api/funding/budget-types',
  table: 'GL_BUDGET_TYPES',
  columns: BUDGET_TYPE_COLUMNS,
  pk: 'BUDGET_TYPE_ID',
  pkKind: 'integer',
  searchable: ['BUDGET_TYPE_CODE', 'BUDGET_NAME', 'DESCRIPTION'],
  sortable: ['BUDGET_TYPE_CODE', 'BUDGET_NAME', 'BUDGET_TYPE_ID'],
  filters: [{ column: 'ENABLED_FLAG', description: '`Y` or `N`.' }],
  defaultSort: `${quoteIdent('BUDGET_TYPE_CODE')} ASC`,
  tags: ['Funding'],
  row: budgetTypeRow,
  writes: { create: budgetTypeWrite, update: budgetTypeWrite.partial() },
};

const BUDGET_VERSION: ResourceDescriptor = {
  name: 'budgetVersions',
  label: 'Budget version',
  basePath: '/api/funding/budget-versions',
  table: 'GL_BUDGET_VERSIONS',
  columns: BUDGET_VERSION_COLUMNS,
  pk: 'BUDGET_VERSION_ID',
  pkKind: 'integer',
  searchable: ['BUDGET_NAME', 'FIRST_PERIOD_NAME', 'LAST_PERIOD_NAME'],
  sortable: ['BUDGET_VERSION_ID', 'BUDGET_NAME', 'STATUS_CODE', 'CREATION_DATE'],
  filters: [
    { column: 'LEDGER_ID', kind: 'integer', description: 'Versions of one ledger.' },
    { column: 'BUDGET_TYPE_ID', kind: 'integer', description: 'Versions of one budget type.' },
    { column: 'STATUS_CODE', description: 'Exact match on `OPEN`, `CURRENT`, or `FROZEN`.' },
    { column: 'LATEST_FLAG', description: '`Y` returns only the current version of each budget type.' },
  ],
  defaultSort: `${quoteIdent('BUDGET_VERSION_ID')} DESC`,
  tags: ['Funding'],
  row: budgetVersionRow,
  writes: { create: budgetVersionWrite, update: budgetVersionWrite.partial() },
};

const BUDGET_ENTITY: ResourceDescriptor = {
  name: 'budgetEntities',
  label: 'Budget entity',
  basePath: '/api/funding/budget-entities',
  table: 'GL_BUDGET_ENTITIES',
  columns: BUDGET_ENTITY_COLUMNS,
  pk: 'BUDGET_ENTITY_ID',
  pkKind: 'integer',
  searchable: ['BUDGET_ENTITY_NAME'],
  sortable: ['BUDGET_ENTITY_NAME', 'BUDGET_ENTITY_ID'],
  filters: [
    { column: 'BUDGET_TYPE_ID', kind: 'integer', description: 'Entities of one budget type.' },
    { column: 'ENABLED_FLAG', description: '`Y` or `N`.' },
  ],
  defaultSort: `${quoteIdent('BUDGET_ENTITY_NAME')} ASC`,
  tags: ['Funding'],
  row: budgetEntityRow,
  writes: { create: budgetEntityWrite, update: budgetEntityWrite.partial() },
};

/**
 * `GL_BUDGET_ASSIGNMENTS` is list-only, and the reason is worth more than the
 * missing PATCH route.
 *
 * The key is `(BUDGET_VERSION_ID, RANGE_FROM, RANGE_TO)` and the two range ends
 * are *nullable* — SQLite permits null in a primary key. So the row has no
 * dependable single identifier: `RANGE_FROM` can be null and two rows can then
 * differ only in `RANGE_TO`. More importantly, a range is a *claim about a set of
 * accounts*, and editing one in place silently changes which accounts a version
 * covers — a change with no audit trail and no way to see what it used to be.
 * Read it, and create a new assignment instead.
 *
 * One further caution for whoever builds the UI: `RANGE_FROM`/`RANGE_TO` are
 * concatenated segment strings. Test membership by retrieving the rows and
 * comparing against the same concatenation EBS uses (`V_CODE_COMBINATION_KEY`
 * exposes `COMBINATION_KEY`); do not assume a plain `BETWEEN` matches.
 */
const BUDGET_ASSIGNMENT: ResourceDescriptor = {
  name: 'budgetAssignments',
  label: 'Budget assignment',
  basePath: '/api/funding/budget-assignments',
  table: 'GL_BUDGET_ASSIGNMENTS',
  columns: BUDGET_ASSIGNMENT_COLUMNS,
  searchable: ['RANGE_FROM', 'RANGE_TO'],
  sortable: ['BUDGET_VERSION_ID', 'RANGE_FROM', 'RANGE_TO'],
  filters: [
    { column: 'BUDGET_VERSION_ID', kind: 'integer', description: 'The ranges of one version.' },
    { column: 'BUDGET_ENTITY_ID', kind: 'integer', description: 'Ranges assigned to one entity.' },
  ],
  defaultSort: `${quoteIdent('BUDGET_VERSION_ID')} ASC, ${quoteIdent('RANGE_FROM')} ASC`,
  tags: ['Funding'],
  row: budgetAssignmentRow,
  readOnlyReason:
    '## Read-only\n\n' +
    'This table is keyed on `(BUDGET_VERSION_ID, RANGE_FROM, RANGE_TO)`, and both ends of the range are nullable, ' +
    'so no single column identifies a row. Beyond the mechanics, an assignment is a claim about which accounts a ' +
    'version covers — editing one in place would change that claim with no record of what it was. Create a new row instead.',
};

const JE_HEADER: ResourceDescriptor = {
  name: 'journalHeaders',
  label: 'Journal header',
  basePath: '/api/funding/journals',
  table: 'GL_JE_HEADERS',
  columns: JE_HEADER_COLUMNS,
  pk: 'JE_HEADER_ID',
  pkKind: 'integer',
  searchable: ['NAME', 'DESCRIPTION', 'PERIOD_NAME', 'JE_CATEGORY', 'JE_SOURCE'],
  sortable: ['JE_HEADER_ID', 'DEFAULT_EFFECTIVE_DATE', 'DATE_CREATED', 'PERIOD_NAME', 'JE_CATEGORY'],
  filters: [
    { column: 'LEDGER_ID', kind: 'integer', description: 'Journals in one ledger.' },
    { column: 'JE_CATEGORY', description: 'Exact match. Only `Budget` exists in this sample.' },
    { column: 'JE_SOURCE', description: 'Exact match. Only `WCPSS BUDGET` exists in this sample.' },
    { column: 'PERIOD_NAME', description: 'Exact match on the period name, e.g. `JUL-25`.' },
    { column: 'STATUS', description: '`U` unposted or `P` posted.' },
    { column: 'ACTUAL_FLAG', description: '`A`, `B`, or `E`.' },
  ],
  // The action date, descending: newest funding decision first. Not the
  // surrogate key, which happens to agree with it here and would not in general.
  defaultSort: `${quoteIdent('DEFAULT_EFFECTIVE_DATE')} DESC`,
  tags: ['Funding'],
  row: jeHeaderRow,
  writes: { create: jeHeaderWrite, update: jeHeaderWrite.partial() },
};

/**
 * `GL_JE_LINES` is list-only: its key is `(JE_HEADER_ID, JE_LINE_NUM)`.
 *
 * On a posted journal, editing a line is not an edit — it is a restatement. The
 * sample's lines are all posted, so there is nothing legitimate for a PATCH here
 * to do that a new journal would not do more honestly.
 */
const JE_LINE: ResourceDescriptor = {
  name: 'journalLines',
  label: 'Journal line',
  basePath: '/api/funding/journal-lines',
  table: 'GL_JE_LINES',
  columns: JE_LINE_COLUMNS,
  searchable: ['DESCRIPTION', 'INVOICE_IDENTIFIER', 'LINE_TYPE_CODE'],
  sortable: ['JE_HEADER_ID', 'JE_LINE_NUM', 'EFFECTIVE_DATE', 'ENTERED_DR', 'ENTERED_CR'],
  filters: [
    { column: 'JE_HEADER_ID', kind: 'integer', description: 'Every line of one journal.' },
    { column: 'CODE_COMBINATION_ID', kind: 'integer', description: 'Every line hitting one account.' },
    { column: 'STATUS', description: '`U` unposted or `P` posted.' },
  ],
  defaultSort: `${quoteIdent('JE_HEADER_ID')} DESC, ${quoteIdent('JE_LINE_NUM')} ASC`,
  tags: ['Funding'],
  row: jeLineRow,
  readOnlyReason:
    '## Read-only\n\n' +
    'Keyed on `(JE_HEADER_ID, JE_LINE_NUM)`, so there is no single-column identifier to address a row by. ' +
    'Every line in this sample belongs to a posted journal, and editing a posted line restates history rather than ' +
    'correcting it — post a new journal instead.',
};

const PA_BUDGET_VERSION: ResourceDescriptor = {
  name: 'projectBudgetVersions',
  label: 'Project budget version',
  basePath: '/api/funding/project-budget-versions',
  table: 'PA_BUDGET_VERSIONS',
  columns: PA_BUDGET_VERSION_COLUMNS,
  pk: 'BUDGET_VERSION_ID',
  pkKind: 'integer',
  searchable: ['VERSION_NAME', 'STATUS_CODE'],
  sortable: ['BUDGET_VERSION_ID', 'PROJECT_ID', 'VERSION_NUMBER', 'CREATION_DATE'],
  filters: [
    { column: 'PROJECT_ID', kind: 'integer', description: 'Versions of one project.' },
    { column: 'CURRENT_FLAG', description: '`Y` returns the version each project is measured against.' },
    { column: 'STATUS_CODE', description: 'Exact match on the version status.' },
  ],
  defaultSort: `${quoteIdent('PROJECT_ID')} ASC, ${quoteIdent('VERSION_NUMBER')} ASC`,
  tags: ['Funding'],
  row: paBudgetVersionRow,
  writes: { create: paBudgetVersionWrite, update: paBudgetVersionWrite.partial() },
};

/** Keyed on `(BUDGET_VERSION_ID, LINE_NUM)` — list-only, same reasoning as the GL lines. */
const PA_BUDGET_LINE: ResourceDescriptor = {
  name: 'projectBudgetLines',
  label: 'Project budget line',
  basePath: '/api/funding/project-budget-lines',
  table: 'PA_BUDGET_LINES',
  columns: PA_BUDGET_LINE_COLUMNS,
  sortable: ['BUDGET_VERSION_ID', 'LINE_NUM', 'RAW_COST', 'BURDENED_COST'],
  filters: [
    { column: 'BUDGET_VERSION_ID', kind: 'integer', description: 'The lines of one project budget version.' },
    { column: 'TASK_ID', kind: 'integer', description: 'Lines budgeted to one task.' },
  ],
  defaultSort: `${quoteIdent('BUDGET_VERSION_ID')} ASC, ${quoteIdent('LINE_NUM')} ASC`,
  tags: ['Funding'],
  row: paBudgetLineRow,
  readOnlyReason:
    '## Read-only\n\nKeyed on `(BUDGET_VERSION_ID, LINE_NUM)`. Create a new budget version rather than editing a line in place.',
};

/**
 * The budget measure, as a resource over a view.
 *
 * This is the endpoint the plan calls "Budgets", and the reason it is a view
 * rather than a filtered read of `GL_BALANCES` is in this module's header: the
 * five predicates that make a budget total correct are part of the view's SQL, so
 * they cannot be omitted by a caller.
 *
 * It has no primary key — the grain is (account, version, period) and the view
 * exposes no surrogate — so it is list-only, which is exactly right for a measure.
 */
/**
 * The `level`/`object` parameters, restated for the composed fragments.
 *
 * ★ THE FILTER IS THE SAME FILTER; ONLY ITS POSITION CHANGES.
 *
 * Both composed views publish their segments as `MAX(cc.SEGMENTn)` over
 * `GROUP BY cc.CODE_COMBINATION_ID`, so `WHERE LEVEL_CODE = :f_level` is applied
 * to a column the database has already computed. It therefore cannot remove any
 * work: the scoped aggregate over `GL_BALANCES` runs in full and the predicate
 * then throws almost all of it away. Measured against the live ledger, the
 * endpoint behind the project-details drawer —
 * `/api/funding/positions?level=0450` — answered in **10,755 ms**, no faster than
 * the unfiltered read, and the user saw that as a page that had stopped loading.
 *
 * Restating `cc.SEGMENT5 = '0450'` inside the fragment is **equivalent, not
 * approximate**: `CODE_COMBINATION_ID` determines all seven segments, so within a
 * combination `SEGMENT5` has one value and `MAX(cc.SEGMENT5) = '0450'` holds iff
 * `cc.SEGMENT5 = '0450'` holds. The same five accounts come back either way
 * (verified as a key-set comparison, not a row count); only the rows read change.
 * **58 ms**, and the drawer opens.
 *
 * ★ EMPTY MEANS "NOT SUPPLIED", AND THE OMISSION IS WHAT MATTERS. A total must
 *   filter on nothing: `/api/funding/summary` sums every account in scope, and
 *   handing it a level would turn a total into a subtotal that still called
 *   itself one. So blank and absent both yield no predicate.
 */
function segmentPushdown(query: Record<string, unknown>): SegmentFilter {
  const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v : undefined);
  return { object: str(query.object), level: str(query.level) };
}

const BUDGET_BY_ACCOUNT: ResourceDescriptor = {
  name: 'budgetByAccount',
  label: 'Budgeted account',
  basePath: '/api/funding/budgets',
  table: 'V_BUDGET_BY_ACCOUNT_PERIOD',
  columns: BUDGET_BY_ACCOUNT_COLUMNS,
  searchable: ['PERIOD_NAME'],
  sortable: ['PERIOD_YEAR', 'PERIOD_NUM', 'NET_AMOUNT', 'CODE_COMBINATION_ID', 'SEGMENT4', 'SEGMENT5'],
  filters: [
    { column: 'CODE_COMBINATION_ID', kind: 'integer', description: 'One account across every period and version.' },
    { column: 'BUDGET_VERSION_ID', kind: 'integer', description: 'One version of the budget.' },
    { column: 'PERIOD_NAME', description: 'Exact match on the period name.' },
    { column: 'PERIOD_YEAR', kind: 'integer', description: 'One fiscal year.' },
    { column: 'SEGMENT4', param: 'object', description: 'Object code — segment 4.' },
    { column: 'SEGMENT5', param: 'level', description: 'Level code — segment 5.' },
  ],
  // ★ Both parameters are restated inside the composed fragment so the ledger can
  //   drop accounts before it joins `GL_BALANCES`, not after it has aggregated
  //   them. Measured with `?level=0450`: 10,755 ms → 58 ms, identical rows.
  pushdown: segmentPushdown,
  // Year and number, never `PERIOD_NAME`: the names sort wrong as text.
  defaultSort: `${quoteIdent('PERIOD_YEAR')} DESC, ${quoteIdent('PERIOD_NUM')} DESC, ${quoteIdent('CODE_COMBINATION_ID')} ASC`,
  tags: ['Funding'],
  row: budgetByAccountRow,
  readOnlyReason:
    '## Read-only\n\n' +
    '`V_BUDGET_BY_ACCOUNT_PERIOD` is a reporting view, not a table, and it is **derived**: `NET_AMOUNT` is ' +
    '`SUM(PERIOD_NET_DR - PERIOD_NET_CR)` over the budget rows of `GL_BALANCES`. There is nothing here to write to. ' +
    'The five predicates that make the sum correct (`ACTUAL_FLAG = \'B\'`, `TRANSLATED_FLAG = \'N\'`, ' +
    '`ENCUMBRANCE_TYPE_ID IS NULL`, a primary ledger, and a non-summary enabled account) are part of the view, ' +
    'which is why this endpoint cannot return a total that forgot one.',
};

/**
 * The per-account position, as a resource over a view.
 *
 * Four money columns, two of which are derived. `AVAILABLE_FUNDS` in particular
 * is the report's formula rather than a stored figure — see the module header.
 */
const ACCOUNT_POSITION: ResourceDescriptor = {
  name: 'accountPositions',
  label: 'Account position',
  basePath: '/api/funding/positions',
  table: 'V_ACCOUNT_POSITION',
  columns: ACCOUNT_POSITION_COLUMNS,
  searchable: ['BUDGET_ACCOUNT', 'OBJECT_CODE', 'LEVEL_CODE'],
  sortable: [
    'CODE_COMBINATION_ID',
    'OBJECT_CODE',
    'LEVEL_CODE',
    'WCPSS_BUDGET',
    'ALLOCATIONS_REIMB',
    'ENCUMBRANCES',
    'EXPENDITURES',
    'AVAILABLE_FUNDS',
  ],
  filters: [
    { column: 'CODE_COMBINATION_ID', kind: 'integer', description: 'One account.' },
    { column: 'OBJECT_CODE', param: 'object', description: 'Object code — segment 4.' },
    { column: 'LEVEL_CODE', param: 'level', description: 'Level code — segment 5.' },
  ],
  // ★ See `segmentPushdown`. Without it an outer `LEVEL_CODE` predicate costs a
  //   full scoped aggregate — measured 10,755 ms for one level — because the
  //   fragment publishes its segments as `MAX()` over a `GROUP BY`.
  pushdown: segmentPushdown,
  defaultSort: `${quoteIdent('BUDGET_ACCOUNT')} ASC`,
  tags: ['Funding'],
  row: accountPositionRow,
  readOnlyReason:
    '## Read-only\n\n' +
    'A reporting view. `ALLOCATIONS_REIMB` and `AVAILABLE_FUNDS` are **derived** — `Available Funds = ' +
    'Allocations − Encumbrances − Expenditures` is the report’s formula and is computed rather than stored. ' +
    'The budget-type-to-label mapping that produces "Allocations" is an interpretation, not a verified fact.',
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerFunding(api: Api): void {
  registerResource(api, BUDGET_TYPE);
  registerResource(api, BUDGET_VERSION);
  registerResource(api, BUDGET_ENTITY);
  registerResource(api, BUDGET_ASSIGNMENT);
  registerResource(api, JE_HEADER);
  registerResource(api, JE_LINE);
  registerResource(api, PA_BUDGET_VERSION);
  registerResource(api, PA_BUDGET_LINE);
  registerResource(api, BUDGET_BY_ACCOUNT);
  registerResource(api, ACCOUNT_POSITION);

  registerBudgetVersionDetail(api);
  registerJournalDetail(api);
  registerFundingSummary(api);
}

/**
 * A budget version with its type, its ledger, and the account ranges it covers.
 *
 * The header question a version page asks first is "what is this, and what does
 * it cover", and both halves are one join away. `assignments` is the same rows
 * the flat route returns.
 */
function registerBudgetVersionDetail(api: Api): void {
  api.route({
    method: 'get',
    path: '/api/funding/budget-versions/{id}/detail',
    operationId: 'funding_budgetVersionDetail',
    summary: 'A budget version with its type, ledger, and account ranges',
    description:
      'The version row, the budget type it belongs to, the ledger it posts to, and every account range ' +
      'assigned to it. Four things in one request so a version page does not have to reconcile three of them ' +
      'on the client.\n\n' +
      'A caution that belongs with the data rather than the endpoint: a version spans a **budget type**, while ' +
      'funding is held per **account** and per period. The version’s `FIRST_PERIOD_NAME` is therefore not the ' +
      'first period in which any particular account was funded. Ask the budget measure ' +
      '(`GET /api/funding/budgets?code_combination_id=…`) for that.',
    tags: ['Funding'],
    params: z.object({ id: IntParam }),
    response: z
      .object({
        version: budgetVersionRow,
        budgetType: budgetTypeRow.nullable(),
        ledger: z
          .object({
            LEDGER_ID: int('Surrogate key.'),
            NAME: text('Ledger name.'),
            SHORT_NAME: text('Short ledger name.'),
            CURRENCY_CODE: text('Ledger currency.'),
            PERIOD_SET_NAME: text('The accounting calendar the ledger uses.'),
            LEDGER_CATEGORY_CODE: text('`PRIMARY` for the ledger this reporting reads from.'),
          })
          .openapi('FundingLedgerRef'),
        assignments: z.array(budgetAssignmentRow),
        assignmentCount: z.number().int().openapi({ description: 'Length of `assignments`.' }),
      })
      .openapi('BudgetVersionDetail'),
    errors: [400, 404, 500],
    handler: async (ctx) => {
      const id = bindable(ctx.params.id);
      const version = await findRow(BUDGET_VERSION, ctx.params.id);

      // LEFT JOIN semantics via separate lookups: the foreign keys exist, so a
      // missing parent is a broken database rather than a state worth 404-ing on,
      // but returning null is still better than a 500 on a detail page.
      const budgetType = await one(
        `SELECT ${BUDGET_TYPE_COLUMNS.map(quoteIdent).join(', ')} FROM ${quoteIdent('GL_BUDGET_TYPES')} ` +
          `WHERE ${quoteIdent('BUDGET_TYPE_ID')} = :id`,
        { id: bindable((version as Record<string, unknown>).BUDGET_TYPE_ID) },
      );
      const ledger = await one(
        `SELECT ${quoteIdent('LEDGER_ID')}, ${quoteIdent('NAME')}, ${quoteIdent('SHORT_NAME')}, ` +
          `${quoteIdent('CURRENCY_CODE')}, ${quoteIdent('PERIOD_SET_NAME')}, ${quoteIdent('LEDGER_CATEGORY_CODE')} ` +
          `FROM ${quoteIdent('GL_LEDGERS')} WHERE ${quoteIdent('LEDGER_ID')} = :ledger`,
        { ledger: bindable((version as Record<string, unknown>).LEDGER_ID) },
      );

      const assignments = await rows(
        `SELECT ${BUDGET_ASSIGNMENT_COLUMNS.map(quoteIdent).join(', ')} FROM ${quoteIdent('GL_BUDGET_ASSIGNMENTS')} ` +
          `WHERE ${quoteIdent('BUDGET_VERSION_ID')} = :id ` +
          `ORDER BY ${quoteIdent('RANGE_FROM')} ASC, ${quoteIdent('RANGE_TO')} ASC`,
        { id },
      );

      // Not a separate COUNT — this is the length of the array actually returned,
      // so the two can never disagree.
      return { version, budgetType, ledger, assignments, assignmentCount: assignments.length };
    },
  });
}

/**
 * One journal, its lines, and its own control total.
 *
 * The interesting part is `balanced`. A journal that does not balance is a real
 * defect in the source data and the sort of thing a detail panel should surface
 * rather than compute and hide, so the endpoint reports the difference as a
 * number anyone can read instead of asserting it away.
 */
function registerJournalDetail(api: Api): void {
  api.route({
    method: 'get',
    path: '/api/funding/journals/{id}/detail',
    operationId: 'funding_journalDetail',
    summary: 'A journal header with its lines and totals',
    description:
      'The header, every line in line-number order, and the journal’s own totals: debits, credits, their ' +
      'difference, and the number of lines.\n\n' +
      '`totals.difference` is `debits − credits`. It is reported rather than asserted because a non-zero value ' +
      'is a fact about the source data, and a detail panel that cannot show it cannot tell a reader that the ' +
      'journal does not balance.',
    tags: ['Funding'],
    params: z.object({ id: IntParam }),
    response: z
      .object({
        journal: jeHeaderRow,
        lines: z.array(jeLineRow),
        lineCount: z.number().int().openapi({ description: 'Lines on this journal, counted live.' }),
        totals: z
          .object({
            debits: realReq('Sum of `ENTERED_DR`.'),
            credits: realReq('Sum of `ENTERED_CR`.'),
            difference: realReq('`debits − credits`. Non-zero means the journal does not balance.'),
          })
          .openapi('JournalTotals'),
      })
      .openapi('JournalDetail'),
    errors: [400, 404, 500],
    handler: async (ctx) => {
      const id = bindable(ctx.params.id);
      const journal = await findRow(JE_HEADER, ctx.params.id);

      const lines = await rows(
        `SELECT ${JE_LINE_COLUMNS.map(quoteIdent).join(', ')} FROM ${quoteIdent('GL_JE_LINES')} ` +
          `WHERE ${quoteIdent('JE_HEADER_ID')} = :id ORDER BY ${quoteIdent('JE_LINE_NUM')} ASC`,
        { id },
      );

      // One pass over the lines, not two aggregate queries: the lines are already
      // in hand, so a second round trip could only disagree with them.
      const agg = (await one<Record<string, unknown>>(
        `SELECT COUNT(*) AS n, COALESCE(SUM(${quoteIdent('ENTERED_DR')}), 0) AS debits, ` +
          `COALESCE(SUM(${quoteIdent('ENTERED_CR')}), 0) AS credits ` +
          `FROM ${quoteIdent('GL_JE_LINES')} WHERE ${quoteIdent('JE_HEADER_ID')} = :id`,
        { id },
      )) as Record<string, unknown> | null;

      const debits = columnNumber(agg, 'debits');
      const credits = columnNumber(agg, 'credits');

      return {
        journal,
        lines,
        lineCount: columnNumber(agg, 'n'),
        totals: { debits, credits, difference: debits - credits },
      };
    },
  });

  // The lines of one journal as a page of the line resource — the same rows the
  // flat route returns at `?je_header_id=`, with the same sort allowlist and
  // pagination. 404 on an unknown journal so an empty page means "this journal has
  // no lines" and never "there is no such journal".
  api.route({
    method: 'get',
    path: '/api/funding/journals/{id}/lines',
    operationId: 'funding_journalLines',
    summary: 'The lines of one journal, paginated',
    description:
      'The same rows as `GET /api/funding/journal-lines?je_header_id={id}`. Returns 404 when the journal ' +
      'itself does not exist, so an empty page here means the journal has no lines.',
    tags: ['Funding'],
    params: z.object({ id: IntParam }),
    query: queryFor(JE_LINE),
    response: jeLineRow,
    paginated: true,
    errors: [400, 404, 500],
    handler: async (ctx) => {
      const id = ctx.params.id;
      await assertJournalExists(id);
      return listRows(JE_LINE, ctx.query as Record<string, unknown>, {
        extraWhere: [`${quoteIdent('JE_HEADER_ID')} = :parent_id`],
        extraArgs: { parent_id: bindable(id) },
      });
    },
  });
}

/**
 * The funding answer, in one request.
 *
 * Three groups, and the split between them is the point:
 *
 *   - `counts` — row counts. Honest, cheap, and only meaningful alongside the
 *     empty-state notes elsewhere.
 *   - `budget` — totals **from the view**, so the five filters are applied. The
 *     `sources` note says so explicitly, because a reader who sums
 *     `GL_BALANCES` themselves will get a different and wrong number.
 *   - `position` — the derived projection. `availableFunds` here is
 *     `allocations − encumbrances − expenditures` summed across accounts, which
 *     equals the sum of the view's own `AVAILABLE_FUNDS` column. The smoke test
 *     asserts that identity rather than trusting it.
 *
 *   ★ `allocations` IS A STRUCTURAL ZERO, NOT A MEASURED ONE. The bundled view derives
 *     `ALLOCATIONS_REIMB` from a budget **type** the ledger does not have: `GL_BUDGET_TYPES`
 *     holds one row (`STANDARD`) and no `BUDGET_TYPE_ID`, so no `CAPITAL`-typed row can ever
 *     be selected and the column sums to 0. `availableFunds` therefore reduces to
 *     `−(encumbrances) − (expenditures)`, which measured **362,752,507.60** — a sensible,
 *     positive figure, so the sign convention in the formula is right even though one of its
 *     terms is always zero. Reported as measured; not "fixed", because there is nothing in
 *     the ledger to fix.
 *
 * `byType` and `byPeriod` are ordered by type and by period respectively. Note
 * that `byPeriod` orders on `PERIOD_YEAR, PERIOD_NUM` and not on `PERIOD_NAME`,
 * which sorts incorrectly as text.
 *
 * ★ LATENCY. Both heavy statements aggregate `GL_BALANCES` (157,150,828 rows) and each
 *    measured 3.2–4.3 s scoped. They are issued **concurrently** and never in sequence:
 *    the same three statements cost **4,658 ms together** and **10,261 ms one after the
 *    other**. That is the difference between a screen that answers and one a reader
 *    abandons — and it is why this endpoint issues three statements and not five: three
 *    concurrent connections were what the pool held when the consolidation was made
 *    (`poolMax: 4` then; now 8, sized for the five requests `/funding/budgets` fires at
 *    once). The consolidation is kept — three scans are fewer than five whatever the
 *    ceiling, and this endpoint does not need the figures the other two produced.
 */
function registerFundingSummary(api: Api): void {
  api.route({
    method: 'get',
    path: '/api/funding/summary',
    operationId: 'funding_summary',
    summary: 'Funding totals, by type and by period',
    description:
      'Row counts, the budget total with its breakdown by budget type and by period, and the derived ' +
      'per-account position.\n\n' +
      '**Every money figure here comes from a reporting view, not from `GL_BALANCES` directly.** A budget total ' +
      'read straight off `GL_BALANCES` is wrong by a large factor rather than by a rounding, because that table ' +
      'also holds actuals, encumbrances, translated copies and per-encumbrance-type splits. The views apply all ' +
      'five narrowing predicates; this endpoint cannot forget one.',
    tags: ['Funding'],
    response: z
      .object({
        counts: z
          .object({
            budgetTypes: intReq('Rows in `GL_BUDGET_TYPES`.'),
            budgetVersions: intReq('Rows in `GL_BUDGET_VERSIONS`.'),
            budgetEntities: intReq('Rows in `GL_BUDGET_ENTITIES`.'),
            budgetAssignments: intReq('Rows in `GL_BUDGET_ASSIGNMENTS`.'),
            journalHeaders: intReq('Rows in `GL_JE_HEADERS`.'),
            journalLines: intReq('Rows in `GL_JE_LINES`.'),
            budgetedAccounts: intReq('Distinct accounts appearing in the budget view.'),
            positionAccounts: intReq(
              'Accounts in `V_ACCOUNT_POSITION` — accounts carrying a budget row, which the view ' +
                'requires. Not “accounts with a budget or an allocation”: the allocation term is ' +
                'always zero against this ledger.',
            ),
          })
          .openapi('FundingCounts'),
        budget: z
          .object({
            netAmount: realReq('Total `NET_AMOUNT` across the budget view. Budget rows only, primary ledger, untranslated.'),
            byType: z.array(
              z
                .object({
                  budgetTypeCode: textReq(
                    'The budget type as the ledger stores it — the name, not a code. Measured: this ' +
                      'ledger holds exactly one value, `STANDARD`. The `APPROP`/`CAPITAL` split a ' +
                      'capital-budgeting reading of this screen would expect does not exist here.',
                  ),
                  budgetName: textReq(
                    'Display name of the budget type, falling back to the type itself when ' +
                      '`GL_BUDGET_TYPES.DESCRIPTION` is null — which it is for the single row in this ledger.',
                  ),
                  versions: intReq('Budget versions of this type.'),
                  netAmount: realReq('Total net budget of this type.'),
                })
                .openapi('FundingByType'),
            ),
            byPeriod: z.array(
              z
                .object({
                  periodYear: intReq('Fiscal year.'),
                  periodNum: intReq('Period number within the year.'),
                  periodName: textReq('Period name such as `JUL-25`.'),
                  netAmount: realReq('Total net budget for the period.'),
                  accounts: intReq('Distinct accounts with budget in the period.'),
                })
                .openapi('FundingByPeriod'),
            ),
            source: textReq('The view the figures were read from, named so a consumer can check them.'),
          })
          .openapi('FundingBudgetTotals'),
        position: z
          .object({
            accounts: intReq('Accounts in `V_ACCOUNT_POSITION`.'),
            wcpssBudget: realReq(
              '**Derived** total of the budget column, taken from the view\u2019s own `WCPSS_BUDGET` ' +
                'sum — the whole scoped budget, not a `CAPITAL`-typed slice of it (see `counts.byType`).',
            ),
            allocations: realReq('**Derived** total allocations and reimbursements.'),
            encumbrances: realReq('Total encumbrances, from `ACTUAL_FLAG = \'E\'` balances.'),
            expenditures: realReq('Total expenditures, from `ACTUAL_FLAG = \'A\'` balances.'),
            availableFunds: realReq('**Derived:** `allocations − encumbrances − expenditures`.'),
            source: textReq('The view the figures were read from.'),
          })
          .openapi('FundingPositionTotals'),
      })
      .openapi('FundingSummary'),
    errors: [500, 503],
    handler: async () => {
      /**
       * ★ THE LEDGER SCOPE, RESOLVED ONCE FOR ALL THREE STATEMENTS BELOW.
       *
       *   `V_ACCOUNT_POSITION` and `V_BUDGET_BY_ACCOUNT_PERIOD` exist only in the
       *   bundled store. On Oracle the same answers are composed as predicates over
       *   `GL_CODE_COMBINATIONS` / `GL_BALANCES` (`db/derived.ts`), and the composition
       *   is scoped to the organization's fund, programs and fiscal floor — which is
       *   mandatory, not a preference: unscoped, the position view **never returns** and
       *   the budget grain returns 3,423,238 rows in 17 seconds.
       *
       *   Resolved once, here, so every figure on the screen is measured against the same
       *   population. A total and a breakdown that disagreed about scope would be a worse
       *   defect than either being merely slow.
       *
       * ★★ AND IT IS RESOLVED THROUGH `derivedPlan`, WHICH IS THE ONLY THING ALLOWED TO
       *    DECIDE WHICH OF THE TWO FORMS IS IN PLAY.
       *
       *   This handler used to read
       *
       *     const positionFrom = positionFragment(scope);
       *     const budgetFrom   = budgetFragment(scope);
       *
       *   — the Oracle compositions themselves, unconditionally. They are Oracle-only, and
       *   the way they are Oracle-only is a colour a type-checker cannot see: each one
       *   filters `gb.LEDGER_ID = 1` as a **literal** (`db/derived.ts`, `const LEDGER_ID = 1`),
       *   because on the live ledger that is the primary ledger. The bundled sample writes its
       *   balances with `LEDGER_ID = 1001`. So under `DB_MODE=local` the composed FROM clause
       *   was **valid SQL that matches nothing**: no error, no empty-result signal, just two
       *   views reported as empty and every figure read from them as 0.
       *
       *   Measured on the local arm before this change: `budgetedAccounts: 0`,
       *   `positionAccounts: 0`, `budget.netAmount: 0` — while the base-table counts in the
       *   *same* response were correct (`budgetTypes: 3`, `budgetVersions: 4`,
       *   `journalHeaders: 9`), because those statements name their tables literally and
       *   compose nothing. Meanwhile the sibling smoke check that reads
       *   `V_BUDGET_BY_ACCOUNT_PERIOD` **by name** printed a real number out of the same
       *   database. The seam, not the data — and nothing in the response said so.
       *
       *   `derivedPlan` exists for exactly this and says as much: its first line is
       *   `if (config.db.mode !== 'oracle') return null;`, on the grounds that *"under
       *   `local`/`turso` these views exist and resolve to the plain quoted name, so this
       *   module never runs and the SQL these routes emit is byte-identical to before."*
       *   It is deliberately **not** `async` — the type is `Promise<LedgerResolution> | null`,
       *   so that `plan !== null` narrows the promise itself — and its `ok: false` arm is
       *   this deployment's own answer, `503 DB_UNAVAILABLE` (declared below), which is what
       *   `resource.ts` already serves for these three descriptors.
       *
       *   Both forms fit the slots they are handed, which is why the substitution is only
       *   this much: `positionFragment` returns an already-aliased `( … ) src` and the
       *   statement reads `FROM ${positionFrom}`, so a bare quoted view name is equally
       *   valid there; `budgetSource` wraps its argument as `(SELECT * FROM …) v`, which is
       *   valid around either. `funding.ts` was the only route composing these directly —
       *   every other reader goes through `ledger-shape.ts`.
       *
       *   ★ `storeDriver('ledger').dialect === 'oracle'` further down is NOT a second,
       *     competing decision. `db/client.ts` builds the ledger driver as
       *     `config.db.mode === 'oracle' ? createOracleDriver() : createLibsqlDriver()`, so
       *     that test and this one are the same fact, evaluated once at load and never able
       *     to disagree. Each site asks it in its own vocabulary — the relation by mode, the
       *     syntax by dialect — which is what `db/derived.ts` and `db/views.ts` already do.
       */
      const scope = await defaultTenant();
      const positionPlan = derivedPlan('V_ACCOUNT_POSITION', scope);
      const budgetPlan = derivedPlan('V_BUDGET_BY_ACCOUNT_PERIOD', scope);

      /**
       * The relation, from whichever of the two sources is in play.
       *
       * `null` from `derivedPlan` means "not Oracle, and the real view is present" — the two
       * cases its own doc block describes as indistinguishable on purpose. Here there is
       * nothing to choose between them, so both take the view's own name.
       */
      const composedFrom = async (
        table: string,
        plan: ReturnType<typeof derivedPlan>,
      ): Promise<string> => {
        if (plan === null) return quoteIdent(table);
        const resolved = await plan;
        if (!resolved.ok) {
          throw AppError.dbUnavailable(
            `the ledger view ${table} cannot be composed on this deployment — ${resolved.reason}`,
          );
        }
        return resolved.from;
      };

      const positionFrom = await composedFrom('V_ACCOUNT_POSITION', positionPlan);
      const budgetFrom = await composedFrom('V_BUDGET_BY_ACCOUNT_PERIOD', budgetPlan);

      /**
       * ★ THREE STATEMENTS, NOT FIVE — AND THE REASON IS MEASURED, NOT STYLISTIC.
       *
       *   This handler used to issue five statements, four of them separate scans of the
       *   budget fragment, and the live endpoint answered
       *   `NJS-040: connection request timeout. Request exceeded "queueTimeout" of 15000`
       *   in 15.3 s (measured; HTTP 500). The pool was then `poolMax: 4` /
       *   `queueTimeout: 15_000` (`db/oracle.ts`; now 8 / 45 s, sized for the five requests
       *   the Budgets page fires together), so a fifth concurrent connection could never be
       *   granted and the request sat in the queue until it died. The consolidation is what
       *   removed the queueing from *this* handler.
       *
       *   Measured, and the whole point of the shape below:
       *
       *     all three issued together         4,658 ms
       *     the same three strictly sequential 10,261 ms
       *
       *   The concurrency is load-bearing twice over: it is faster, and it stays under the
       *   number of connections the pool will ever hand out.
       *
       *   ★ `COUNT(DISTINCT CODE_COMBINATION_ID)` AND `COUNT(*)` USED TO LIVE HERE, and they
       *     were the non-obvious cost: bundling two full fragment scans into a statement
       *     that also counts 33,155,055 `GL_JE_LINES` rows made it the slowest thing on the
       *     screen. Both figures now come off the statements that had to scan anyway — the
       *     budget total carries `accounts`, the position view carries `count(*)` — so the
       *     answer is unchanged and two scans disappear.
       */
      const cheapPromise = one<Record<string, unknown>>(
        [
          `SELECT`,
          `  (SELECT COUNT(*) FROM ${quoteIdent('GL_BUDGET_TYPES')}) AS budget_types,`,
          `  (SELECT COUNT(*) FROM ${quoteIdent('GL_BUDGET_VERSIONS')}) AS budget_versions,`,
          `  (SELECT COUNT(*) FROM ${quoteIdent('GL_BUDGET_ENTITIES')}) AS budget_entities,`,
          `  (SELECT COUNT(*) FROM ${quoteIdent('GL_BUDGET_ASSIGNMENTS')}) AS budget_assignments,`,
          `  (SELECT COUNT(*) FROM ${quoteIdent('GL_JE_HEADERS')}) AS journal_headers,`,
          `  (SELECT COUNT(*) FROM ${quoteIdent('GL_JE_LINES')}) AS journal_lines`,
        ].join('\n'),
      );

      const positionPromise = one<Record<string, unknown>>(
        [
          `SELECT`,
          `  COUNT(*) AS accounts,`,
          `  COALESCE(SUM(${quoteIdent('WCPSS_BUDGET')}), 0)      AS wcpss_budget,`,
          `  COALESCE(SUM(${quoteIdent('ALLOCATIONS_REIMB')}), 0) AS allocations,`,
          `  COALESCE(SUM(${quoteIdent('ENCUMBRANCES')}), 0)      AS encumbrances,`,
          `  COALESCE(SUM(${quoteIdent('EXPENDITURES')}), 0)      AS expenditures,`,
          `  COALESCE(SUM(${quoteIdent('AVAILABLE_FUNDS')}), 0)   AS available_funds`,
          `FROM ${positionFrom}`,
        ].join('\n'),
      );

      /**
       * ★ ONE SCAN OF THE BUDGET FRAGMENT, THREE ANSWERS — ON ORACLE.
       *
       *   ★★ SQLITE RUNS A DIFFERENT STATEMENT, NOT THIS ONE. `GROUPING SETS` is Oracle
       *     syntax and this route may not speak it; see the `sqliteBudgetSql` note below.
       *
       *   The grand total, the period breakdown and the type breakdown are three different
       *   groupings of **the same 3.4 M-row grain**. Read separately they cost three passes
       *   of it; `GROUPING SETS` computes all of them in one, and `GROUPING()` labels which
       *   grain each returned row belongs to, so one result set carries all three.
       *
       *   ★ THE TYPE AXIS IS REBUILT ON THE KEY THAT EXISTS.
       *     This statement used to join `GL_BUDGET_TYPES` to `GL_BUDGET_VERSIONS` on
       *     `BUDGET_TYPE_ID` and select `BUDGET_TYPE_CODE` / `BUDGET_NAME`. Measured against
       *     Oracle, **not one of those four columns exists**: `GL_BUDGET_TYPES` is 11 columns
       *     (`BUDGET_TYPE`, `DESCRIPTION`, five `ATTRIBUTE`s, audit, `CONTEXT`) and
       *     `GL_BUDGET_VERSIONS` is 25 with no `BUDGET_TYPE_ID` either. The join key is the
       *     **name** `BUDGET_TYPE`, which both tables carry, and it holds exactly one value —
       *     `STANDARD` — which is why the CAPITAL/APPROP split this screen once expected can
       *     never come from this ledger. There is nothing to configure, and no grant would
       *     have changed it.
       *
       *   ★ `SELECT DISTINCT` ON EACH JOIN SIDE IS WHAT MAKES THIS FAN-OUT-PROOF.
       *     `GL_BUDGET_VERSIONS` holds 2 rows and the fragment holds one distinct
       *     `BUDGET_VERSION_ID`, so a plain join happens to be safe today. Writing the
       *     deduplication down means the answer no longer depends on that: a join that
       *     multiplied fragment rows would inflate the SUM, and it would do so silently —
       *     the total would still look like a total.
       *
       *   ★ THE FRAGMENT ALREADY ENDS IN `) src`, so it cannot take a second alias.
       *     `(SELECT * FROM ${budgetFrom}) v` is how a new alias is introduced; Oracle merges
       *     the extra layer, so it is not an extra pass.
       *
       *   ★ THE TOTAL ROW IS THE RECONCILIATION, and it is checked by construction. The
       *     measurement of record is that `SUM(byPeriod)` equals this ROLLUP total equals the
       *     position view's own `WCPSS_BUDGET` sum, at **1,882,099,069.36**. Three
       *     independently shaped reads of the same ledger, one number. If the periods ever
       *     stopped partitioning the grain, two rows of this statement would disagree.
       */
      const budgetSource = `(SELECT * FROM ${budgetFrom}) v`;

      /**
       * ★★ THE TWO LEDGERS NAME THE BUDGET TYPE DIFFERENTLY, SO THE JOINS DIFFER WITH THEM.
       *
       *   The view carries no type at all — `V_BUDGET_BY_ACCOUNT_PERIOD` is
       *   `LEDGER_ID, CODE_COMBINATION_ID, SEGMENT1..7, BUDGET_VERSION_ID, PERIOD_YEAR,
       *   PERIOD_NUM, PERIOD_NAME, NET_AMOUNT, BALANCE_ROWS` in the bundled sample and the
       *   same fifteen columns composed on Oracle — so the type axis has to come from a join
       *   on both. The join is where they part:
       *
       *     the bundled sample   GL_BUDGET_VERSIONS.BUDGET_TYPE_ID -> GL_BUDGET_TYPES.BUDGET_TYPE_ID
       *                          code `BUDGET_TYPE_CODE`, display name `BUDGET_NAME`
       *     the live instance    GL_BUDGET_VERSIONS.BUDGET_TYPE    -> GL_BUDGET_TYPES.BUDGET_TYPE
       *                          code `BUDGET_TYPE`, display name `DESCRIPTION`
       *
       *   ★ THE LIVE COLUMN NAMES ARE THE MEASURED ONES, and they are the reason this statement
       *     was rewritten in the first place: `GL_BUDGET_TYPES` on the instance is 11 columns
       *     (`BUDGET_TYPE`, `DESCRIPTION`, five `ATTRIBUTE`s, audit, `CONTEXT`) and
       *     `GL_BUDGET_VERSIONS` is 25 with no `BUDGET_TYPE_ID` either. A query written against
       *     the sample's `BUDGET_TYPE_CODE` / `BUDGET_NAME` answers `ORA-00904` there.
       *
       *   ★ THE SAMPLE'S SHAPE IS NOT A MISTAKE EITHER — IT IS AUTHORED. Its whole budget-type
       *     model exists to reproduce the report's TWO budget columns, which nothing in the
       *     extract explains: `data/sql/turso/00-schema.sql` models `CAPITAL` as the WCPSS
       *     Budget and `APPROP` as Allocations/Reimb., and `03-notes.sql` records that reading
       *     as an interpretation rather than a fact. A three-row `GL_BUDGET_TYPES` with an ID
       *     key is what that model needs; the live instance has one row, `STANDARD`, and no
       *     id-keyed path to it.
       *
       *   ★ SO THIS IS TWO STATEMENTS RATHER THAN ONE, AND THAT IS THE HONEST FORM. Neither arm
       *     is a translation of the other — they read different columns. What they agree on is
       *     the CONTRACT: nine columns, three `grain` labels, and the same three figures, which
       *     is what lets the assembly below stay unbranched (see the note on the SQLite arm).
       *     The `SELECT DISTINCT` on each join side is kept in both arms for the reason the
       *     Oracle note gives: it is what makes the join fan-out-proof rather than
       *     today-safe.
       */
      const oracleVersionJoin = [
        `  LEFT JOIN (SELECT DISTINCT ${quoteIdent('BUDGET_VERSION_ID')}, ${quoteIdent('BUDGET_TYPE')}`,
        `               FROM ${quoteIdent('GL_BUDGET_VERSIONS')}`,
        `              WHERE ${quoteIdent('BUDGET_VERSION_ID')} IS NOT NULL) bv`,
        `    ON bv.${quoteIdent('BUDGET_VERSION_ID')} = v.${quoteIdent('BUDGET_VERSION_ID')}`,
      ].join('\n');
      const oracleTypeJoin = [
        `  LEFT JOIN (SELECT DISTINCT ${quoteIdent('BUDGET_TYPE')}, ${quoteIdent('DESCRIPTION')}`,
        `               FROM ${quoteIdent('GL_BUDGET_TYPES')}) bt`,
        `    ON bt.${quoteIdent('BUDGET_TYPE')} = bv.${quoteIdent('BUDGET_TYPE')}`,
      ].join('\n');
      const sampleVersionJoin = [
        `  LEFT JOIN (SELECT DISTINCT ${quoteIdent('BUDGET_VERSION_ID')}, ${quoteIdent('BUDGET_TYPE_ID')}`,
        `               FROM ${quoteIdent('GL_BUDGET_VERSIONS')}`,
        `              WHERE ${quoteIdent('BUDGET_VERSION_ID')} IS NOT NULL) bv`,
        `    ON bv.${quoteIdent('BUDGET_VERSION_ID')} = v.${quoteIdent('BUDGET_VERSION_ID')}`,
      ].join('\n');
      const sampleTypeJoin = [
        `  LEFT JOIN (SELECT DISTINCT ${quoteIdent('BUDGET_TYPE_ID')}, ${quoteIdent('BUDGET_TYPE_CODE')},`,
        `                               ${quoteIdent('BUDGET_NAME')}`,
        `               FROM ${quoteIdent('GL_BUDGET_TYPES')}) bt`,
        `    ON bt.${quoteIdent('BUDGET_TYPE_ID')} = bv.${quoteIdent('BUDGET_TYPE_ID')}`,
      ].join('\n');

      const oracleBudgetSql = [
        `SELECT`,
        `  CASE`,
        `    WHEN GROUPING(v.${quoteIdent('PERIOD_YEAR')}) = 0 THEN 'period'`,
        `    WHEN GROUPING(bv.${quoteIdent('BUDGET_TYPE')})  = 0 THEN 'type'`,
        `    ELSE 'total'`,
        `  END AS grain,`,
        `  v.${quoteIdent('PERIOD_YEAR')}  AS period_year,`,
        `  v.${quoteIdent('PERIOD_NUM')}   AS period_num,`,
        `  v.${quoteIdent('PERIOD_NAME')}  AS period_name,`,
        `  bv.${quoteIdent('BUDGET_TYPE')} AS budget_type_code,`,
        `  COALESCE(bt.${quoteIdent('DESCRIPTION')}, bv.${quoteIdent('BUDGET_TYPE')}) AS budget_name,`,
        `  COUNT(DISTINCT v.${quoteIdent('CODE_COMBINATION_ID')}) AS accounts,`,
        `  COUNT(DISTINCT v.${quoteIdent('BUDGET_VERSION_ID')})   AS versions,`,
        `  COALESCE(SUM(v.${quoteIdent('NET_AMOUNT')}), 0)        AS net_amount`,
        `  FROM ${budgetSource}`,
        oracleVersionJoin,
        oracleTypeJoin,
        ` GROUP BY GROUPING SETS (`,
        `   (v.${quoteIdent('PERIOD_YEAR')}, v.${quoteIdent('PERIOD_NUM')}, v.${quoteIdent('PERIOD_NAME')}),`,
        `   (bv.${quoteIdent('BUDGET_TYPE')}, bt.${quoteIdent('DESCRIPTION')}),`,
        `   ()`,
        ` )`,
        // Periods first, then the type row, then the total — and within the periods, year
        // and number, never the name: `JUL-24` sorts after `JUL-25` as text.
        ` ORDER BY CASE WHEN GROUPING(v.${quoteIdent('PERIOD_YEAR')}) = 0 THEN 0`,
        `              WHEN GROUPING(bv.${quoteIdent('BUDGET_TYPE')})  = 0 THEN 1`,
        `              ELSE 2 END ASC,`,
        `          v.${quoteIdent('PERIOD_YEAR')} ASC, v.${quoteIdent('PERIOD_NUM')} ASC,`,
        `          bv.${quoteIdent('BUDGET_TYPE')} ASC`,
      ].join('\n');

      /**
       * ★★ THE SAME THREE GRAINS IN SQLITE, WHERE `GROUPING SETS` DOES NOT EXIST.
       *
       *   The statement above was written straight into this route, so `GROUP BY GROUPING
       *   SETS (…)` reached SQLite on every `DB_MODE=local` run and the endpoint answered
       *   `SQLITE_ERROR: near "SETS": syntax error`. Three checks went red with it — `the
       *   funding summary budget total is the view's own total, not a sum of GL_BALANCES`,
       *   `…not what any of the four naive GL_BALANCES sums produce`, and `available funds is
       *   allocations minus encumbrances minus expenditures` — while the Oracle arm, which
       *   nothing had changed, stayed green. A dialect failure that only shows in one arm is
       *   exactly what the two-arm smoke run exists to catch.
       *
       *   ★ THE `toOracleDialect` SEAM CANNOT ABSORB THIS ONE, AND THE REASON MATTERS.
       *     Every other dialect gap here has a dialect-neutral rewrite that the driver
       *     performs: `LIMIT n OFFSET m` *means* "page through these rows", `IFNULL(x, y)`
       *     *means* "substitute for a null", and neither is a claim about the engine. "Three
       *     groupings of one scan" is a claim about the engine. SQLite has no `GROUPING
       *     SETS`, no `ROLLUP` and no `CUBE`, so a translation would have to invent syntax
       *     that no engine reads — and the portable equivalent, `UNION ALL`, is *also* not a
       *     rewrite the driver may perform, because it changes how many times the fragment is
       *     read on Oracle (3.4 M rows per pass; see the measurement in the note above). The
       *     branch is therefore deliberate, and this is the one place in the file where the
       *     dialect is a property of the feature rather than of the statement text.
       *
       *   ★ THE ORACLE ARM IS THE SAME STATEMENT IT WAS. The punctuation, the grouping sets and
       *     the `GROUPING()`-based ordering are unchanged, and its two joins say what they said
       *     before — they are only given a name so the SQLite arm can be read beside them; the
       *     two ledgers' budget-type vocabularies are the subject of the note above.
       *
       *   ★ THE SQLITE ARM IS ONE `UNION ALL` OF ONE BRANCH PER GRAIN, EACH CARRYING ITS
       *     GRAIN AS A LITERAL. It costs three passes of the fragment where Oracle pays one,
       *     which is affordable because the local ledger is the bundled sample rather than
       *     the 3.4 M-row instance — and because the alternative is a 500.
       *
       *     The three branches project the same nine columns in the same order, and only the
       *     first names them: a compound takes its result column names from its first branch,
       *     so repeating the aliases on branches two and three would be dead text that reads
       *     like decoration. That is also why the branch-two and branch-three axes are bare
       *     `NULL`s rather than `NULL AS period_year` — the position is the contract.
       *
       *   ★ `SELECT * FROM (…) budget_rows` IS WRAPPED RATHER THAN ORDERED DIRECTLY, AND
       *     THAT IS THE WHOLE REASON IT IS ONE LINE LONGER. In a compound, `ORDER BY` belongs
       *     to the compound: an `ORDER BY` on an individual branch is `ORDER BY clause should
       *     come after UNION not before`. It also cannot be written against the branch
       *     aliases from inside a `CASE` without asking whether the engine resolves an output
       *     name there — and the wrapper removes the question, because inside it `grain`,
       *     `period_year` and `budget_type_code` are ordinary *input* columns of a plain
       *     `SELECT`. The alias on the derived table is required by Oracle and accepted by
       *     SQLite, so it costs nothing and leaves the statement readable by either reader.
       *
       *   ★ THE ASSEMBLY BELOW IS NOT BRANCHED, WHICH IS THE POINT. Both arms return the same
       *     nine columns and the same three `grain` labels, so `atGrain`, `totalRow` and every
       *     mapper are shared — and the reconciliation the note above depends on (`SUM(byPeriod)`
       *     = the total row = the position view's own sum) is checked on whichever arm ran.
       */
      const sqliteBudgetSql = [
        `SELECT * FROM (`,
        // ---- the period grain ----
        `  SELECT`,
        `    'period' AS grain,`,
        `    v.${quoteIdent('PERIOD_YEAR')}  AS period_year,`,
        `    v.${quoteIdent('PERIOD_NUM')}   AS period_num,`,
        `    v.${quoteIdent('PERIOD_NAME')}  AS period_name,`,
        `    NULL AS budget_type_code,`,
        `    NULL AS budget_name,`,
        `    COUNT(DISTINCT v.${quoteIdent('CODE_COMBINATION_ID')}) AS accounts,`,
        `    COUNT(DISTINCT v.${quoteIdent('BUDGET_VERSION_ID')})   AS versions,`,
        `    COALESCE(SUM(v.${quoteIdent('NET_AMOUNT')}), 0)        AS net_amount`,
        `    FROM ${budgetSource}`,
        `   GROUP BY v.${quoteIdent('PERIOD_YEAR')}, v.${quoteIdent('PERIOD_NUM')},`,
        `            v.${quoteIdent('PERIOD_NAME')}`,
        `  UNION ALL`,
        // ---- the budget-type grain ----
        `  SELECT`,
        `    'type' AS grain,`,
        `    NULL, NULL, NULL,`,
        `    bt.${quoteIdent('BUDGET_TYPE_CODE')} AS budget_type_code,`,
        `    COALESCE(bt.${quoteIdent('BUDGET_NAME')}, bt.${quoteIdent('BUDGET_TYPE_CODE')}) AS budget_name,`,
        `    COUNT(DISTINCT v.${quoteIdent('CODE_COMBINATION_ID')}) AS accounts,`,
        `    COUNT(DISTINCT v.${quoteIdent('BUDGET_VERSION_ID')})   AS versions,`,
        `    COALESCE(SUM(v.${quoteIdent('NET_AMOUNT')}), 0)        AS net_amount`,
        `    FROM ${budgetSource}`,
        sampleVersionJoin,
        sampleTypeJoin,
        `   GROUP BY bt.${quoteIdent('BUDGET_TYPE_CODE')}, bt.${quoteIdent('BUDGET_NAME')}`,
        `  UNION ALL`,
        // ---- the grand total, and the row the reconciliation reads ----
        `  SELECT`,
        `    'total' AS grain,`,
        `    NULL, NULL, NULL, NULL, NULL,`,
        `    COUNT(DISTINCT v.${quoteIdent('CODE_COMBINATION_ID')}) AS accounts,`,
        `    COUNT(DISTINCT v.${quoteIdent('BUDGET_VERSION_ID')})   AS versions,`,
        `    COALESCE(SUM(v.${quoteIdent('NET_AMOUNT')}), 0)        AS net_amount`,
        `    FROM ${budgetSource}`,
        `) budget_rows`,
        // Periods first, then the type row, then the total — and within the periods, year
        // and number, never the name: `JUL-24` sorts after `JUL-25` as text.
        ` ORDER BY CASE WHEN grain = 'period' THEN 0`,
        `              WHEN grain = 'type'   THEN 1`,
        `              ELSE 2 END ASC,`,
        `          period_year ASC, period_num ASC, budget_type_code ASC`,
      ].join('\n');

      const budgetPromise = rows<Record<string, unknown>>(
        storeDriver('ledger').dialect === 'oracle' ? oracleBudgetSql : sqliteBudgetSql,
      );

      const [countRow, positionRow, budgetRows] = await Promise.all([
        cheapPromise,
        positionPromise,
        budgetPromise,
      ]);

      /** One grouping set of the statement above, selected by its own `GROUPING()` label. */
      const atGrain = (name: string) => budgetRows.filter((r) => String(r.grain) === name);
      const totalRow = atGrain('total')[0] ?? {};

      return {
        counts: {
          budgetTypes: columnNumber(countRow, 'budget_types'),
          budgetVersions: columnNumber(countRow, 'budget_versions'),
          budgetEntities: columnNumber(countRow, 'budget_entities'),
          budgetAssignments: columnNumber(countRow, 'budget_assignments'),
          journalHeaders: columnNumber(countRow, 'journal_headers'),
          journalLines: columnNumber(countRow, 'journal_lines'),
          // Both read off the statement that already had to scan for them: the budget
          // total's own `COUNT(DISTINCT CODE_COMBINATION_ID)` and the position view's
          // `COUNT(*)`. Counting them separately would have cost two more connections.
          budgetedAccounts: columnNumber(totalRow, 'accounts'),
          positionAccounts: columnNumber(positionRow, 'accounts'),
        },
        budget: {
          netAmount: columnNumber(totalRow, 'net_amount'),
          byType: atGrain('type').map((r) => ({
            budgetTypeCode: r.budget_type_code,
            budgetName: r.budget_name,
            versions: Number(r.versions ?? 0),
            netAmount: Number(r.net_amount ?? 0),
          })),
          byPeriod: atGrain('period').map((r) => ({
            periodYear: Number(r.period_year ?? 0),
            periodNum: Number(r.period_num ?? 0),
            periodName: r.period_name,
            netAmount: Number(r.net_amount ?? 0),
            accounts: Number(r.accounts ?? 0),
          })),
          source: 'V_BUDGET_BY_ACCOUNT_PERIOD',
        },
        position: {
          accounts: columnNumber(positionRow, 'accounts'),
          wcpssBudget: columnNumber(positionRow, 'wcpss_budget'),
          allocations: columnNumber(positionRow, 'allocations'),
          encumbrances: columnNumber(positionRow, 'encumbrances'),
          expenditures: columnNumber(positionRow, 'expenditures'),
          availableFunds: columnNumber(positionRow, 'available_funds'),
          source: 'V_ACCOUNT_POSITION',
        },
      };
    },
  });
}

async function assertJournalExists(id: unknown): Promise<void> {
  const found = await one(
    `SELECT 1 AS ok FROM ${quoteIdent('GL_JE_HEADERS')} WHERE ${quoteIdent('JE_HEADER_ID')} = :id`,
    { id: bindable(id) },
  );
  if (!found) throw AppError.notFound(`Journal ${String(id)}`);
}
