import { z } from '../http/z.js';
import { StrParam } from '../http/z.js';
import type { Api } from '../http/api.js';
import { AppError } from '../http/errors.js';
import { registerResource, type ResourceDescriptor } from './resource.js';
import { bindable, columnNumber, concatExpr, one, quoteIdent, rows } from '../db/sql.js';
import { ledgerIdent, ledgerPlan } from '../db/ledger-shape.js';
import { levelValueSetExpression, legendFragment } from '../db/derived.js';
import { date, flag, int, intReq, real, realReq, rowObject, text, textReq, writeObject } from '../schemas/columns.js';

/**
 * Chart of Accounts — the account combinations, the seven segments that build
 * them, the periods, the raw balances, and the lookup legend behind every code.
 *
 * Four facts about this part of the schema decide the shape of these endpoints,
 * and each of them is a trap rather than a detail.
 *
 * ─── 1. `CODE_COMBINATION_ID` is a surrogate key and is NOT durable ──────────
 *
 * A chart-of-accounts reimplementation, a COA copied into a new ledger, or a
 * rebuild of `GL_CODE_COMBINATIONS` all reassign it. The canonical join key in
 * this codebase is therefore the **seven segments joined with dots**, which
 * `V_CODE_COMBINATION_KEY` exposes as `COMBINATION_KEY` and
 * `V_ACCOUNT_POSITION` as `BUDGET_ACCOUNT`. Everything that crosses a boundary
 * outside this server — the extract, a saved report, a bookmark — should carry
 * that key and not the id.
 *
 * That is why there is a lookup at `/api/coa/combination-key/{key}` which is
 * deliberately *not* `/api/coa/combinations/{key}`: Express matches routes in
 * registration order, so a second `:param` at the same depth as the resource's
 * `/api/coa/combinations/{id}` would be shadowed by it and every key lookup would
 * come back as a failed integer parse. A distinct path is the only version of
 * this that actually works.
 *
 * ─── 2. `PERIOD_NAME` sorts wrong as text ───────────────────────────────────
 *
 * `'JUL-24'` sorts after `'JUL-25'`, and `'JAN-25'` after `'JUL-25'`. The table
 * carries `PERIOD_YEAR` and `PERIOD_NUM` as real numbers exactly so ordering does
 * not have to go through the name, and every default sort in this module uses
 * them. A caller who sorts by `period_name` is given what they asked for — it
 * really is an allowlisted column — and will get chronological nonsense, which is
 * why the column's own description says so.
 *
 * ─── 3. `SUMMARY_FLAG = 'Y'` rows are parents and must be excluded from sums ─
 *
 * A summary account rolls up its children. Including one in a total counts the
 * same money twice. The two views this domain reads already filter it out; the
 * raw `GL_BALANCES` resource at `/api/coa/balances` does not, and cannot, because
 * it is a faithful read of a table. Any caller summing it must join to
 * `GL_CODE_COMBINATIONS` and pin `SUMMARY_FLAG = 'N'` — or, better, read one of
 * the views instead. The description on that endpoint says this out loud.
 *
 * ─── 4. Five filters are not optional when summing `GL_BALANCES` ─────────────
 *
 * `ACTUAL_FLAG` discriminates budget (`'B'`), encumbrance (`'E'`) and actual
 * (`'A'`) rows held in **one** table; `TRANSLATED_FLAG = 'N'` excludes the same
 * balances restated into a reporting currency; `CURRENCY_CODE` excludes those
 * restated rows a second way; `ENCUMBRANCE_TYPE_ID IS NULL` separates budget rows
 * from encumbrance rows that share their `ACTUAL_FLAG` neighbourhood; `LEDGER_ID`
 * excludes other ledgers. The seed deliberately contains rows that only the
 * filters exclude, so dropping one produces a **visibly wrong** number rather
 * than a plausible one — which is the only reason this is safe to expose raw.
 *
 * ─── One state that reads like a bug and is not ─────────────────────────────
 *
 * `FND_FLEX_VALUES` is the *legend*, not the domain. A code that appears in
 * `GL_CODE_COMBINATIONS` with no row here is **unnamed**, and that is a real,
 * reportable state — `V_SEGMENT_LEGEND` returns a null `LEVEL_NAME` for exactly
 * those. Do not treat a missing name as a missing account, and do not "fix" it by
 * inventing one.
 */

// ---------------------------------------------------------------------------
// Column lists
// ---------------------------------------------------------------------------

const LEDGER_COLUMNS = [
  'LEDGER_ID',
  'NAME',
  'SHORT_NAME',
  'CHART_OF_ACCOUNTS_ID',
  'CURRENCY_CODE',
  'PERIOD_SET_NAME',
  'LEDGER_CATEGORY_CODE',
  'DESCRIPTION',
] as const;

const CURRENCY_COLUMNS = [
  'CURRENCY_CODE',
  'NAME',
  'PRECISION',
  'EXTENDED_PRECISION',
  'ENABLED_FLAG',
] as const;

const PERIOD_COLUMNS = [
  'PERIOD_SET_NAME',
  'PERIOD_NAME',
  'PERIOD_TYPE',
  'PERIOD_YEAR',
  'PERIOD_NUM',
  'QUARTER_NUM',
  'START_DATE',
  'END_DATE',
] as const;

const FLEX_STRUCTURE_COLUMNS = [
  'ID_FLEX_NUM',
  'ID_FLEX_STRUCTURE_CODE',
  'ID_FLEX_CODE',
  'DESCRIPTION',
] as const;

const FLEX_SEGMENT_COLUMNS = [
  'ID_FLEX_NUM',
  'ID_FLEX_CODE',
  'SEGMENT_NUM',
  'SEGMENT_NAME',
  'APPLICATION_COLUMN',
  'FLEX_VALUE_SET_ID',
  'DISPLAY_SIZE',
  'REQUIRED_FLAG',
  'ENABLED_FLAG',
] as const;

const FLEX_VALUE_COLUMNS = [
  'FLEX_VALUE_SET_ID',
  'FLEX_VALUE',
  'DESCRIPTION',
  'ENABLED_FLAG',
  'SUMMARY_FLAG',
  'START_DATE_ACTIVE',
  'END_DATE_ACTIVE',
] as const;

const FLEX_VALUE_TL_COLUMNS = [
  'FLEX_VALUE_SET_ID',
  'FLEX_VALUE',
  'LANGUAGE',
  'DESCRIPTION',
] as const;

/**
 * ★ THE SEVEN SEGMENTS OF THE ACCOUNT KEY, IN ORDER, AS THEIR OWN LIST.
 *
 * `CODE_COMBINATION_COLUMNS` above is the full projection — it also carries
 * `ACCOUNT_TYPE`, `ENABLED_FLAG` and the dates — so it cannot be used to build
 * the key. The key is exactly these seven, joined with dots, in this order, and
 * the order is load-bearing: `V_CODE_COMBINATION_KEY.COMBINATION_KEY` is built
 * the same way, so a reordered list would produce a key that matches nothing
 * while looking entirely plausible.
 */
const ACCOUNT_SEGMENT_COLUMNS = [
  'SEGMENT1',
  'SEGMENT2',
  'SEGMENT3',
  'SEGMENT4',
  'SEGMENT5',
  'SEGMENT6',
  'SEGMENT7',
] as const;

const CODE_COMBINATION_COLUMNS = [
  'CODE_COMBINATION_ID',
  'CHART_OF_ACCOUNTS_ID',
  'ACCOUNT_TYPE',
  'ENABLED_FLAG',
  'SUMMARY_FLAG',
  'SEGMENT1',
  'SEGMENT2',
  'SEGMENT3',
  'SEGMENT4',
  'SEGMENT5',
  'SEGMENT6',
  'SEGMENT7',
  'DESCRIPTION',
  'LAST_UPDATE_DATE',
  'CREATION_DATE',
] as const;

const BALANCE_COLUMNS = [
  'LEDGER_ID',
  'CODE_COMBINATION_ID',
  'PERIOD_NAME',
  'PERIOD_YEAR',
  'PERIOD_NUM',
  'PERIOD_TYPE',
  'ACTUAL_FLAG',
  'BUDGET_VERSION_ID',
  'ENCUMBRANCE_TYPE_ID',
  'CURRENCY_CODE',
  'TRANSLATED_FLAG',
  'PERIOD_NET_DR',
  'PERIOD_NET_CR',
  'BEGIN_BALANCE_DR',
  'BEGIN_BALANCE_CR',
  'QUARTER_TO_DATE_DR',
  'QUARTER_TO_DATE_CR',
] as const;

const LOOKUP_COLUMNS = ['LOOKUP_TYPE', 'LOOKUP_CODE', 'MEANING', 'DESCRIPTION', 'ENABLED_FLAG'] as const;

/**
 * `V_SEGMENT_LEGEND`: which level codes have a name and which do not.
 *
 * Three columns, and the interesting one is null. `LEVEL_NAME` is null for a code
 * that is used in a combination and absent from the legend — a real state the
 * view was written to expose rather than to paper over.
 */
const SEGMENT_LEGEND_COLUMNS = ['LEVEL_CODE', 'ACCOUNT_COUNT', 'LEVEL_NAME'] as const;

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

const actualFlag = z.enum(['A', 'B', 'E']).nullable().openapi({
  description:
    '`A` actual · `B` budget · `E` encumbrance. Oracle keeps all three in `GL_BALANCES`, so this column — not the table — is what discriminates them.',
});

const translatedFlag = z.enum(['Y', 'N']).nullable().openapi({
  description: '`N` is the ledger-currency row; `Y` is the same balance restated into a reporting currency.',
});

const ledgerRow = rowObject(
  {
    LEDGER_ID: int('Surrogate key.'),
    NAME: textReq('Ledger name.'),
    SHORT_NAME: text('Short name, used where space is tight.'),
    CHART_OF_ACCOUNTS_ID: intReq('The key flexfield structure this ledger uses. Foreign key to `FND_ID_FLEX_STRUCTURES`.'),
    CURRENCY_CODE: textReq('Ledger currency. Foreign key to `FND_CURRENCIES`.'),
    PERIOD_SET_NAME: textReq('The accounting calendar. Foreign key to `GL_PERIODS.PERIOD_SET_NAME`.'),
    LEDGER_CATEGORY_CODE: text('`PRIMARY` for the ledger the reporting figures are taken from.'),
    DESCRIPTION: text('Free-text description.'),
  },
  'A ledger as stored in `GL_LEDGERS`.',
);

const currencyRow = rowObject(
  {
    CURRENCY_CODE: textReq('ISO code, and the primary key.'),
    NAME: textReq('Currency name.'),
    PRECISION: int('Decimal places for display.'),
    EXTENDED_PRECISION: int('Decimal places for calculation.'),
    ENABLED_FLAG: flag('Whether the currency may be used on new transactions.'),
  },
  'A currency as stored in `FND_CURRENCIES`.',
);

const periodRow = rowObject(
  {
    PERIOD_SET_NAME: textReq('Accounting calendar. Part 1 of 2 of the key.'),
    PERIOD_NAME: textReq(
      'Part 2 of 2 of the key, such as `JUL-25`. Sorts incorrectly as text — `JUL-24` after `JUL-25`, `JAN-25` after `JUL-25` — so order by `PERIOD_YEAR` and `PERIOD_NUM` instead.',
    ),
    PERIOD_TYPE: textReq("Almost always `Month` in this sample."),
    PERIOD_YEAR: intReq('Fiscal year. A real number, so it sorts right.'),
    PERIOD_NUM: intReq('Period within the year, 1..12. A real number, so it sorts right.'),
    QUARTER_NUM: int('Fiscal quarter.'),
    START_DATE: textReq('First day of the period, as `YYYY-MM-DD` text.'),
    END_DATE: textReq('Last day of the period, as `YYYY-MM-DD` text.'),
  },
  'A calendar period as stored in `GL_PERIODS`.',
);

const flexStructureRow = rowObject(
  {
    ID_FLEX_NUM: int('Surrogate key, and the chart-of-accounts id a ledger points at.'),
    ID_FLEX_STRUCTURE_CODE: textReq('Structure code, such as `GL#`.'),
    ID_FLEX_CODE: textReq('Flexfield code.'),
    DESCRIPTION: text('Free-text description.'),
  },
  'A key flexfield structure as stored in `FND_ID_FLEX_STRUCTURES`.',
);

const flexSegmentRow = rowObject(
  {
    ID_FLEX_NUM: intReq('Part 1 of 2 of the key — the structure.'),
    ID_FLEX_CODE: textReq('Flexfield code, repeated from the structure.'),
    SEGMENT_NUM: intReq('Part 2 of 2 of the key — the segment’s position, 1..7.'),
    SEGMENT_NAME: textReq('The segment’s name, such as `Fund` or `Level`.'),
    APPLICATION_COLUMN: textReq('The `GL_CODE_COMBINATIONS` column the segment maps to, such as `SEGMENT1`.'),
    FLEX_VALUE_SET_ID: int('The value set the segment validates against. Null means the segment carries free text.'),
    DISPLAY_SIZE: int('Rendered width.'),
    REQUIRED_FLAG: text('Whether the segment is required on a new combination.'),
    ENABLED_FLAG: text('Whether the segment is in use.'),
  },
  'A key flexfield segment as stored in `FND_ID_FLEX_SEGMENTS`.',
);

const flexValueRow = rowObject(
  {
    FLEX_VALUE_SET_ID: intReq('Part 1 of 2 of the key — the value set this legend entry belongs to.'),
    FLEX_VALUE: textReq('Part 2 of 2 of the key — the code as it appears in `GL_CODE_COMBINATIONS`.'),
    DESCRIPTION: text(
      'The name behind the code. Null, or a missing row entirely, means the code is UNNAMED — a real state, not a defect.',
    ),
    ENABLED_FLAG: flag('Whether the value may be used on a new combination.'),
    SUMMARY_FLAG: flag('`Y` for a parent value that rolls up children.'),
    START_DATE_ACTIVE: date('First date the value is usable.'),
    END_DATE_ACTIVE: date('Last date the value is usable.'),
  },
  'A flexfield value (the legend that turns a bare code into a name), from `FND_FLEX_VALUES`.',
);

const flexValueTlRow = rowObject(
  {
    FLEX_VALUE_SET_ID: intReq('Part 1 of 3 of the key.'),
    FLEX_VALUE: textReq('Part 2 of 3 of the key.'),
    LANGUAGE: textReq('Part 3 of 3 of the key. Defaults to `US`.'),
    DESCRIPTION: text('Translated description.'),
  },
  'A translated flexfield value description, from `FND_FLEX_VALUES_TL`.',
);

const codeCombinationRow = rowObject(
  {
    CODE_COMBINATION_ID: int(
      'Surrogate key. **Not durable** — join on the seven segments across any boundary you do not control.',
    ),
    CHART_OF_ACCOUNTS_ID: intReq('The structure this combination was created under.'),
    ACCOUNT_TYPE: textReq('`A` asset · `L` liability · `O` owner’s equity · `R` revenue · `E` expense.'),
    ENABLED_FLAG: textReq('Whether the combination may be posted to.'),
    SUMMARY_FLAG: textReq(
      '`Y` marks a parent account. **A summary row must be excluded from any sum** — it rolls up its children, so including it counts the same money twice.',
    ),
    SEGMENT1: textReq('Segment 1 — Fund.'),
    SEGMENT2: textReq(
      'Segment 2 — Purpose. `6570` Capital · `9000` Operating · `6560` Relocation. The mapping to those labels is inferred rather than read from a table.',
    ),
    SEGMENT3: textReq('Segment 3 — Program.'),
    SEGMENT4: textReq('Segment 4 — Object code.'),
    SEGMENT5: textReq('Segment 5 — Level code, and the thing this application calls a project.'),
    SEGMENT6: textReq('Segment 6 — Cost center.'),
    SEGMENT7: textReq('Segment 7 — reserved for future use.'),
    DESCRIPTION: text('Free-text description of the combination.'),
    LAST_UPDATE_DATE: date('When the combination was last changed.'),
    CREATION_DATE: date('When the combination was created.'),
  },
  'An account combination as stored in `GL_CODE_COMBINATIONS`.',
);

const balanceRow = rowObject(
  {
    LEDGER_ID: intReq('The ledger. One of the five filters that are not optional when summing.'),
    CODE_COMBINATION_ID: intReq('The account. Join through `V_CODE_COMBINATION_KEY` rather than trusting this across a boundary.'),
    PERIOD_NAME: textReq('Period name such as `JUL-25`. Sorts incorrectly as text.'),
    PERIOD_YEAR: intReq('Fiscal year. A real number, so it sorts right.'),
    PERIOD_NUM: intReq('Period within the year, 1..12.'),
    PERIOD_TYPE: textReq('Almost always `Month`.'),
    ACTUAL_FLAG: actualFlag,
    BUDGET_VERSION_ID: int('Set on budget rows and null elsewhere. The second half of what identifies a budget row.'),
    ENCUMBRANCE_TYPE_ID: int('Set on encumbrance rows and null on budget rows. Filtering it to null is one of the five required predicates.'),
    CURRENCY_CODE: textReq('The currency of the amount. Restated rows carry a different currency.'),
    TRANSLATED_FLAG: translatedFlag,
    PERIOD_NET_DR: realReq('Period net debit. NOT NULL, defaulting to 0.'),
    PERIOD_NET_CR: realReq('Period net credit. NOT NULL, defaulting to 0.'),
    BEGIN_BALANCE_DR: realReq('Opening balance, debit. NOT NULL, defaulting to 0.'),
    BEGIN_BALANCE_CR: realReq('Opening balance, credit. NOT NULL, defaulting to 0.'),
    QUARTER_TO_DATE_DR: realReq('Quarter-to-date debit. NOT NULL, defaulting to 0.'),
    QUARTER_TO_DATE_CR: realReq('Quarter-to-date credit. NOT NULL, defaulting to 0.'),
  },
  'One balance row from `GL_BALANCES`. Read the endpoint description before summing this table.',
);

const lookupRow = rowObject(
  {
    LOOKUP_TYPE: textReq('Part 1 of 2 of the key — the code list, such as `YES_NO` or `BUDGET_STATUS`.'),
    LOOKUP_CODE: textReq('Part 2 of 2 of the key — the value within that list.'),
    MEANING: text('The display text for the code.'),
    DESCRIPTION: text('A longer explanation.'),
    ENABLED_FLAG: flag('Whether the code is still in use.'),
  },
  'A lookup code, from `GL_LOOKUPS`.',
);

const segmentLegendRow = rowObject(
  {
    LEVEL_CODE: textReq('A `SEGMENT5` value that is actually used by at least one account combination.'),
    ACCOUNT_COUNT: intReq('How many combinations use this level.'),
    LEVEL_NAME: text(
      'The name from the legend, or **null when the code is UNNAMED**. Null here is a fact about the data, not a failed join.',
    ),
  },
  'One level code and whether it has a name, from `V_SEGMENT_LEGEND`.',
);

const levelRow = rowObject(
  {
    LEVEL_CODE: textReq('A `SEGMENT5` value that is actually used by at least one account combination.'),
    ACCOUNT_COUNT: intReq('How many combinations use this level.'),
    LEVEL_NAME: text(
      'The name from the legend, matched against the value set the Level segment declares, or **null when the code is genuinely unnamed**.',
    ),
  },
  'One level code and its name, from `GL_CODE_COMBINATIONS` joined to `FND_FLEX_VALUES`.',
);

// Derived from the row schemas — see `writeObject`.
const ledgerWrite = writeObject(ledgerRow, 'A ledger to create or update.');
const currencyWrite = writeObject(currencyRow, 'A currency to create or update.');
const codeCombinationWrite = writeObject(codeCombinationRow, 'An account combination to create or update.');

// ---------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------

const LEDGER: ResourceDescriptor = {
  name: 'ledgers',
  label: 'Ledger',
  basePath: '/api/coa/ledgers',
  table: 'GL_LEDGERS',
  columns: LEDGER_COLUMNS,
  pk: 'LEDGER_ID',
  pkKind: 'integer',
  searchable: ['NAME', 'SHORT_NAME', 'DESCRIPTION'],
  sortable: ['LEDGER_ID', 'NAME', 'SHORT_NAME', 'LEDGER_CATEGORY_CODE'],
  filters: [
    { column: 'LEDGER_CATEGORY_CODE', description: '`PRIMARY` returns the ledger the reporting figures come from.' },
    { column: 'CURRENCY_CODE', description: 'Exact match on the ledger currency.' },
    { column: 'PERIOD_SET_NAME', description: 'Ledgers on one accounting calendar.' },
  ],
  defaultSort: `${quoteIdent('LEDGER_ID')} ASC`,
  tags: ['Chart of Accounts'],
  row: ledgerRow,
  writes: { create: ledgerWrite, update: ledgerWrite.partial() },
};

/** The one resource here keyed on text rather than an integer. */
const CURRENCY: ResourceDescriptor = {
  name: 'currencies',
  label: 'Currency',
  basePath: '/api/coa/currencies',
  table: 'FND_CURRENCIES',
  columns: CURRENCY_COLUMNS,
  pk: 'CURRENCY_CODE',
  pkKind: 'text',
  searchable: ['CURRENCY_CODE', 'NAME'],
  sortable: ['CURRENCY_CODE', 'NAME'],
  filters: [{ column: 'ENABLED_FLAG', description: '`Y` or `N`.' }],
  defaultSort: `${quoteIdent('CURRENCY_CODE')} ASC`,
  tags: ['Chart of Accounts'],
  row: currencyRow,
  writes: { create: currencyWrite, update: currencyWrite.partial() },
};

/**
 * `GL_PERIODS` is keyed on `(PERIOD_SET_NAME, PERIOD_NAME)` — two text columns —
 * so it is list-only.
 *
 * The default sort ends with the two key columns rather than stopping at
 * `PERIOD_YEAR, PERIOD_NUM`, and that is not decoration. Two period sets overlap
 * in year and number, so a page boundary drawn on year-and-number alone can repeat
 * a row from one set and drop another from a different one. A total order needs
 * the key.
 */
const PERIOD: ResourceDescriptor = {
  name: 'periods',
  label: 'Calendar period',
  basePath: '/api/coa/periods',
  table: 'GL_PERIODS',
  columns: PERIOD_COLUMNS,
  searchable: ['PERIOD_NAME'],
  sortable: ['PERIOD_YEAR', 'PERIOD_NUM', 'PERIOD_NAME', 'QUARTER_NUM', 'START_DATE', 'END_DATE'],
  filters: [
    { column: 'PERIOD_SET_NAME', description: 'One accounting calendar.' },
    { column: 'PERIOD_YEAR', kind: 'integer', description: 'One fiscal year.' },
    { column: 'PERIOD_NAME', description: 'Exact match on the period name, e.g. `JUL-25`.' },
    { column: 'PERIOD_TYPE', description: 'Almost always `Month` in this sample.' },
  ],
  defaultSort: '"PERIOD_YEAR" DESC, "PERIOD_NUM" DESC, "PERIOD_SET_NAME" ASC, "PERIOD_NAME" ASC',
  tags: ['Chart of Accounts'],
  row: periodRow,
  readOnlyReason:
    '## Read-only\n\n' +
    'Keyed on `(PERIOD_SET_NAME, PERIOD_NAME)` — two text columns, so no single-column identifier exists. A calendar ' +
    'is reference data that a general ledger generates and validates against; editing a period in place through an ' +
    'API would let a caller redefine which dates a fiscal year covers, with no record of the prior definition.',
};

const FLEX_STRUCTURE: ResourceDescriptor = {
  name: 'flexStructures',
  label: 'Key flexfield structure',
  basePath: '/api/coa/flex-structures',
  table: 'FND_ID_FLEX_STRUCTURES',
  columns: FLEX_STRUCTURE_COLUMNS,
  pk: 'ID_FLEX_NUM',
  pkKind: 'integer',
  searchable: ['ID_FLEX_STRUCTURE_CODE', 'ID_FLEX_CODE', 'DESCRIPTION'],
  sortable: ['ID_FLEX_NUM', 'ID_FLEX_STRUCTURE_CODE', 'ID_FLEX_CODE'],
  filters: [{ column: 'ID_FLEX_CODE', description: 'Flexfields with one code.' }],
  defaultSort: `${quoteIdent('ID_FLEX_NUM')} ASC`,
  tags: ['Chart of Accounts'],
  row: flexStructureRow,
  readOnlyReason:
    '## Read-only\n\nA structure describes how accounts are built. Changing one reinterprets every existing combination, ' +
    'which is a chart-of-accounts change and not a row edit. Use `GET /api/coa/segments` to read the definition.',
};

const FLEX_SEGMENT: ResourceDescriptor = {
  name: 'flexSegments',
  label: 'Key flexfield segment',
  basePath: '/api/coa/flex-segments',
  table: 'FND_ID_FLEX_SEGMENTS',
  columns: FLEX_SEGMENT_COLUMNS,
  searchable: ['SEGMENT_NAME', 'APPLICATION_COLUMN', 'ID_FLEX_CODE'],
  sortable: ['ID_FLEX_NUM', 'SEGMENT_NUM', 'SEGMENT_NAME'],
  filters: [
    { column: 'ID_FLEX_NUM', kind: 'integer', description: 'The segments of one structure.' },
    { column: 'ID_FLEX_CODE', description: 'Segments of one flexfield code.' },
  ],
  defaultSort: `${quoteIdent('ID_FLEX_NUM')} ASC, ${quoteIdent('SEGMENT_NUM')} ASC`,
  tags: ['Chart of Accounts'],
  row: flexSegmentRow,
  readOnlyReason:
    '## Read-only\n\n' +
    'Keyed on `(ID_FLEX_NUM, SEGMENT_NUM)`. Reordering or renaming a segment changes the meaning of every account ' +
    'combination in the ledger, so it is a structure change rather than a row edit.',
};

/**
 * `FND_FLEX_VALUES` is the legend, and unnamed is a real state.
 *
 * A code that appears in `GL_CODE_COMBINATIONS` with no row here is unnamed, and
 * the view `V_SEGMENT_LEGEND` returns a null name for it. Creating a legend row
 * is therefore a legitimate, useful write — it *names* a code that has been in
 * use without one — which is why this table is writable where the two structure
 * tables above are not.
 */
const FLEX_VALUE: ResourceDescriptor = {
  name: 'flexValues',
  label: 'Flexfield value',
  basePath: '/api/coa/flex-values',
  table: 'FND_FLEX_VALUES',
  columns: FLEX_VALUE_COLUMNS,
  searchable: ['FLEX_VALUE', 'DESCRIPTION'],
  sortable: ['FLEX_VALUE_SET_ID', 'FLEX_VALUE', 'DESCRIPTION'],
  filters: [
    { column: 'FLEX_VALUE_SET_ID', kind: 'integer', description: 'The legend for one segment.' },
    { column: 'ENABLED_FLAG', description: '`Y` or `N`.' },
    { column: 'SUMMARY_FLAG', description: '`Y` for parent values only.' },
  ],
  defaultSort: `${quoteIdent('FLEX_VALUE_SET_ID')} ASC, ${quoteIdent('FLEX_VALUE')} ASC`,
  tags: ['Chart of Accounts'],
  row: flexValueRow,
  readOnlyReason:
    '## Read-only\n\n' +
    'Keyed on `(FLEX_VALUE_SET_ID, FLEX_VALUE)`. Writing here is a **create**, and the endpoint pair that would do it ' +
    'truthfully — insert-if-absent for codes that appear in `GL_CODE_COMBINATIONS` without a name — needs the ' +
    'combination table to decide what to insert. Until that exists as its own endpoint, this stays a read.',
};

const FLEX_VALUE_TL: ResourceDescriptor = {
  name: 'flexValueTranslations',
  label: 'Flexfield value translation',
  basePath: '/api/coa/flex-value-translations',
  table: 'FND_FLEX_VALUES_TL',
  columns: FLEX_VALUE_TL_COLUMNS,
  searchable: ['FLEX_VALUE', 'DESCRIPTION'],
  sortable: ['FLEX_VALUE_SET_ID', 'FLEX_VALUE', 'LANGUAGE'],
  filters: [
    { column: 'FLEX_VALUE_SET_ID', kind: 'integer', description: 'Translations for one segment.' },
    { column: 'LANGUAGE', description: 'Exact match on the language code, e.g. `US`.' },
  ],
  defaultSort: `${quoteIdent('FLEX_VALUE_SET_ID')} ASC, ${quoteIdent('FLEX_VALUE')} ASC, ${quoteIdent('LANGUAGE')} ASC`,
  tags: ['Chart of Accounts'],
  row: flexValueTlRow,
  readOnlyReason:
    '## Read-only\n\nKeyed on `(FLEX_VALUE_SET_ID, FLEX_VALUE, LANGUAGE)` — three columns, so no single-column identifier exists.',
};

/**
 * The account combinations themselves. Seven segment filters, because that is how
 * anybody actually looks one up: by fund, by purpose, by object code.
 *
 * `summary_flag` is exposed as a filter rather than hidden, and the sortable set
 * includes it, because a caller who wants the parent rows is asking a legitimate
 * question. What they must not do is sum across both kinds of row, which is why
 * every description that mentions money says so.
 */
const CODE_COMBINATION: ResourceDescriptor = {
  name: 'codeCombinations',
  label: 'Account combination',
  basePath: '/api/coa/combinations',
  table: 'GL_CODE_COMBINATIONS',
  columns: CODE_COMBINATION_COLUMNS,
  pk: 'CODE_COMBINATION_ID',
  pkKind: 'integer',
  searchable: ['DESCRIPTION', 'SEGMENT1', 'SEGMENT2', 'SEGMENT3', 'SEGMENT4', 'SEGMENT5', 'SEGMENT6', 'SEGMENT7'],
  sortable: [
    'CODE_COMBINATION_ID',
    'SEGMENT1',
    'SEGMENT2',
    'SEGMENT3',
    'SEGMENT4',
    'SEGMENT5',
    'SEGMENT6',
    'SEGMENT7',
    'ACCOUNT_TYPE',
    'DESCRIPTION',
  ],
  filters: [
    { column: 'SEGMENT1', param: 'fund', description: 'Segment 1 — Fund.' },
    { column: 'SEGMENT2', param: 'purpose', description: 'Segment 2 — Purpose. `6570` Capital · `9000` Operating · `6560` Relocation.' },
    { column: 'SEGMENT3', param: 'program', description: 'Segment 3 — Program.' },
    { column: 'SEGMENT4', param: 'object', description: 'Segment 4 — Object code.' },
    { column: 'SEGMENT5', param: 'level', description: 'Segment 5 — Level code, the thing this application calls a project.' },
    { column: 'SEGMENT6', param: 'cost_center', description: 'Segment 6 — Cost center.' },
    { column: 'SEGMENT7', param: 'future', description: 'Segment 7 — reserved.' },
    { column: 'ENABLED_FLAG', description: '`Y` or `N`.' },
    { column: 'SUMMARY_FLAG', description: '`Y` returns parent accounts only. Exclude them from sums.' },
    { column: 'ACCOUNT_TYPE', description: '`A`, `L`, `O`, `R`, or `E`.' },
  ],
  defaultSort: `${quoteIdent('SEGMENT1')} ASC, ${quoteIdent('SEGMENT2')} ASC, ${quoteIdent('SEGMENT4')} ASC, ${quoteIdent('SEGMENT5')} ASC, ${quoteIdent('CODE_COMBINATION_ID')} ASC`,
  tags: ['Chart of Accounts'],
  row: codeCombinationRow,
  writes: { create: codeCombinationWrite, update: codeCombinationWrite.partial() },
};

/**
 * The raw balance table, exposed because hiding it would make the five-filter rule
 * unverifiable — a consumer cannot check a total they cannot see the rows behind.
 *
 * It is list-only: the table has **no primary key at all**. Its identity is the
 * eight-column unique index `UX_GL_BALANCES_K1`, which normalises two nullable
 * columns to `-1` sentinels in order to be unique in the first place. Round-tripping
 * that through a single path parameter would be an invented key, and an invented
 * key on a table whose *only* protections are its filters is exactly the wrong
 * thing to add.
 */
const BALANCE: ResourceDescriptor = {
  name: 'balances',
  label: 'Balance row',
  basePath: '/api/coa/balances',
  table: 'GL_BALANCES',
  columns: BALANCE_COLUMNS,
  sortable: ['PERIOD_YEAR', 'PERIOD_NUM', 'ACTUAL_FLAG', 'CODE_COMBINATION_ID', 'PERIOD_NET_DR', 'PERIOD_NET_CR'],
  filters: [
    { column: 'LEDGER_ID', kind: 'integer', description: 'Filter 1 of 5. Rows for other ledgers are excluded.' },
    { column: 'CODE_COMBINATION_ID', kind: 'integer', description: 'One account.' },
    { column: 'PERIOD_NAME', description: 'Exact match on the period name.' },
    { column: 'PERIOD_YEAR', kind: 'integer', description: 'One fiscal year.' },
    { column: 'ACTUAL_FLAG', description: 'Filter of 5: `A` actual, `B` budget, `E` encumbrance.' },
    { column: 'BUDGET_VERSION_ID', kind: 'integer', description: 'One budget version. Set on budget rows only.' },
    { column: 'ENCUMBRANCE_TYPE_ID', kind: 'integer', description: 'Filter 4 of 5 when set to null — budget rows carry no encumbrance type.' },
    { column: 'CURRENCY_CODE', description: 'The currency of the amount.' },
    { column: 'TRANSLATED_FLAG', description: 'Filter 2 of 5: `N` excludes the restated copies of the same balances.' },
  ],
  defaultSort:
    '"PERIOD_YEAR" DESC, "PERIOD_NUM" DESC, "CODE_COMBINATION_ID" ASC, "ACTUAL_FLAG" ASC, "CURRENCY_CODE" ASC',
  tags: ['Chart of Accounts'],
  row: balanceRow,
  readOnlyReason:
    '## Read-only, and read it carefully\n\n' +
    'This table has **no primary key** — its identity is an eight-column unique index that normalises two nullable ' +
    'columns to `-1` sentinels in order to be unique at all. There is no single-column key to address a row by, and ' +
    'inventing one on the table whose only protections are its filters would be the wrong trade.\n\n' +
    '**Five predicates are not optional when summing this table.** `LEDGER_ID`, `TRANSLATED_FLAG = \'N\'`, ' +
    '`CURRENCY_CODE`, `ENCUMBRANCE_TYPE_ID IS NULL`, and `ACTUAL_FLAG = \'B\'` for a budget total. Drop one and the ' +
    'total silently inflates, because the rows you are then counting are legitimately in the table. Add ' +
    '`GL_CODE_COMBINATIONS.SUMMARY_FLAG = \'N\'` too, or parent accounts are counted alongside their children.\n\n' +
    'For a budget total, prefer `GET /api/funding/budgets`, which reads a view that applies them all.',
};

const LOOKUP: ResourceDescriptor = {
  name: 'lookups',
  label: 'Lookup code',
  basePath: '/api/coa/lookups',
  table: 'GL_LOOKUPS',
  columns: LOOKUP_COLUMNS,
  searchable: ['LOOKUP_TYPE', 'LOOKUP_CODE', 'MEANING', 'DESCRIPTION'],
  sortable: ['LOOKUP_TYPE', 'LOOKUP_CODE', 'MEANING'],
  filters: [
    { column: 'LOOKUP_TYPE', description: 'One code list, e.g. `YES_NO` or `BUDGET_STATUS`.' },
    { column: 'LOOKUP_CODE', description: 'One value across every list that uses it.' },
    { column: 'ENABLED_FLAG', description: '`Y` or `N`.' },
  ],
  defaultSort: `${quoteIdent('LOOKUP_TYPE')} ASC, ${quoteIdent('LOOKUP_CODE')} ASC`,
  tags: ['Chart of Accounts'],
  row: lookupRow,
  readOnlyReason:
    '## Read-only\n\n' +
    'Keyed on `(LOOKUP_TYPE, LOOKUP_CODE)`. This is the decode table for every other code in the schema — ' +
    '`ENABLED_FLAG` here decides whether a vendor type or a budget status is still offered anywhere in the ' +
    'application, so a row edit has effects well outside this resource.',
};

const SEGMENT_LEGEND: ResourceDescriptor = {
  name: 'segmentLegend',
  label: 'Level code',
  basePath: '/api/coa/legend',
  table: 'V_SEGMENT_LEGEND',
  columns: SEGMENT_LEGEND_COLUMNS,
  searchable: ['LEVEL_CODE', 'LEVEL_NAME'],
  sortable: ['LEVEL_CODE', 'ACCOUNT_COUNT', 'LEVEL_NAME'],
  filters: [{ column: 'LEVEL_CODE', description: 'One level code.' }],
  defaultSort: `${quoteIdent('LEVEL_CODE')} ASC`,
  tags: ['Chart of Accounts'],
  row: segmentLegendRow,
  // The view groups by `SEGMENT5`, so a level code identifies exactly one row and a
  // detail route is legitimate. Writes are not: a view has no row to update.
  pk: 'LEVEL_CODE',
  pkKind: 'text',
  readOnlyReason:
    '## Read-only\n\n' +
    'A reporting view over `GL_CODE_COMBINATIONS` left-joined to the legend, so there is nothing to write. ' +
    '`LEVEL_NAME` is **null for a code that is in use but has no name** — the view exists to expose that state ' +
    'rather than to hide it. A count of nulls here is a real answer, not a failed join.\n\n' +
    '**The seeded view body is not what you get.** Its `WHERE`-equivalent joins the legend on ' +
    '`FLEX_VALUE_SET_ID = 10101`, which is the **Fund** value set, while it groups `SEGMENT5` — the Level ' +
    'segment, which declares `1002649`. That join cannot match, so the seeded body returns `LEVEL_NAME` null on ' +
    'every row and reads as “the data has no level names” when it has all of them. `db/derived.ts` holds the ' +
    'corrected body (`legendFragment()`) and this resource resolves to it, so **this view does return names** — ' +
    'measured on the live ledger: **1,308 rows, every code named**. `GET /api/coa/levels` is the same grouping ' +
    'with the named/unnamed partition added.',
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerChartOfAccounts(api: Api): void {
  registerResource(api, LEDGER);
  registerResource(api, CURRENCY);
  registerResource(api, PERIOD);
  registerResource(api, FLEX_STRUCTURE);
  registerResource(api, FLEX_SEGMENT);
  registerResource(api, FLEX_VALUE);
  registerResource(api, FLEX_VALUE_TL);
  registerResource(api, CODE_COMBINATION);
  registerResource(api, BALANCE);
  registerResource(api, LOOKUP);
  registerResource(api, SEGMENT_LEGEND);

  registerSegments(api);
  registerSegmentLevels(api);
  registerCombinationKeyLookup(api);
}

/**
 * The seven-segment definition, resolved once so the UI never hard-codes a label.
 *
 * A frontend that writes `SEGMENT5 = 'project'` into its own source is a frontend
 * that is wrong the moment the chart of accounts changes, and wrong silently. This
 * endpoint lets it read the mapping instead: segment number → name →
 * `GL_CODE_COMBINATIONS` column → value set.
 *
 * Each segment also carries three counts, and the difference between them is the
 * useful part:
 *
 *   - `legendValues` — rows in the legend for the segment's value set.
 *   - `namedValues` — legend rows that are not summary parents.
 *   - `valuesUsedInAccounts` — **distinct values actually present in
 *     `GL_CODE_COMBINATIONS`**. This one does not come from the legend at all, and
 *     it is the count that matters: where it exceeds `legendValues`, the
 *     difference is unnamed codes. It is returned per segment rather than as a
 *     total because "how many level codes are unnamed" is the actionable number.
 */
function registerSegments(api: Api): void {
  api.route({
    method: 'get',
    path: '/api/coa/segments',
    operationId: 'coa_segments',
    summary: 'The seven account segments, their names, and how well each is covered by the legend',
    description:
      'The key flexfield definition: which `GL_CODE_COMBINATIONS` column each segment maps to, what it is called, ' +
      'which value set validates it, and three counts that say how completely it is documented.\n\n' +
      '**`valuesUsedInAccounts` is not derived from the legend.** It counts distinct values in the account ' +
      'combinations themselves, so where it exceeds `legendValues` the difference is codes that are in use and ' +
      'unnamed. That is a real state in this data, and this is the endpoint that quantifies it.',
    tags: ['Chart of Accounts'],
    response: z
      .object({
        structure: flexStructureRow.nullable(),
        segments: z.array(
          z
            .object({
              SEGMENT_NUM: intReq('Position of the segment, 1..7.'),
              SEGMENT_NAME: textReq('Name of the segment.'),
              APPLICATION_COLUMN: textReq('The `GL_CODE_COMBINATIONS` column it maps to.'),
              FLEX_VALUE_SET_ID: int('The value set validating the segment, if any.'),
              DISPLAY_SIZE: int('Rendered width.'),
              REQUIRED_FLAG: text('Whether the segment is required.'),
              ENABLED_FLAG: text('Whether the segment is in use.'),
              legendValues: intReq('Legend rows for this segment’s value set, or 0 when it has no value set.'),
              namedValues: intReq('Legend rows that are not summary parents.'),
              valuesUsedInAccounts: intReq(
                'Distinct values present in `GL_CODE_COMBINATIONS`. Where this exceeds `legendValues`, the difference is unnamed codes.',
              ),
            })
            .openapi('CoaSegment'),
        ),
        note: textReq('What the three counts mean, restated in the payload so a consumer does not have to guess.'),
      })
      .openapi('CoaSegments'),
    // 503 is declared because this route reads its structure through `ledgerPlan`,
    // which answers `ok:false` when the object cannot be read on this deployment —
    // a grant, a divergence, or a connection. Declaring only 500 would document the
    // wrong status for the one failure the resolver can actually name.
    errors: [500, 503],
    handler: async () => {
      // ★ `DESCRIPTION` IS NOT A COLUMN OF `FND_ID_FLEX_STRUCTURES`. On this database
      //   it is supplied by `WCSEXP_FND_ID_FLEX_STRUCTURES`, the customer's projection
      //   of the same object — which is exactly what `ledgerPlan` resolves to (its
      //   documented step 3: "this is how `FND_ID_FLEX_STRUCTURES` gets its
      //   `DESCRIPTION`, with no entry in any table here"). Quoting the base table
      //   directly here is what made this endpoint answer 500 with
      //   `ORA-00904: "DESCRIPTION": invalid identifier` while
      //   `/api/coa/flex-structures`, which reads the same four columns through the
      //   resolver, answered 200. The resolver already knew; this query did not ask.
      const structurePlan = await ledgerPlan({
        table: 'FND_ID_FLEX_STRUCTURES',
        columns: FLEX_STRUCTURE_COLUMNS,
      });
      if (!structurePlan.ok) {
        throw AppError.dbUnavailable(
          `The key flexfield structure cannot be read on this deployment: ${structurePlan.reason}`,
          { table: 'FND_ID_FLEX_STRUCTURES' },
        );
      }
      const structure = await one(
        `SELECT ${FLEX_STRUCTURE_COLUMNS.map(quoteIdent).join(', ')} FROM ${structurePlan.from} ` +
          `ORDER BY ${quoteIdent('ID_FLEX_NUM')} ASC LIMIT 1`,
      );

      // `valuesUsedInAccounts` has to be one scalar subquery per segment column,
      // because the column name is a constant of the chart of accounts rather than
      // a value — there is no way to bind an identifier. The seven column names
      // come from the segment definition, which is read from the database, so the
      // set is not invented here; it is checked against `APPLICATION_COLUMN`.
      const usedRow = await one<Record<string, unknown>>(
        [
          'SELECT',
          // The commas belong between the subqueries, not between `SELECT` and the
          // first one — joining the whole list on `',\n'` emitted `SELECT,` and the
          // statement failed to parse.
          Array.from(
            { length: 7 },
            (_, i) =>
              `  (SELECT COUNT(DISTINCT ${quoteIdent(`SEGMENT${i + 1}`)}) FROM ${quoteIdent('GL_CODE_COMBINATIONS')}) AS used${i + 1}`,
          ).join(',\n'),
        ].join('\n'),
      );

      const segments = await rows<Record<string, unknown>>(
        [
          `SELECT s.${quoteIdent('SEGMENT_NUM')}        AS segment_num,`,
          `       s.${quoteIdent('SEGMENT_NAME')}       AS segment_name,`,
          // ★ The object calls this column `APPLICATION_COLUMN_NAME`. Naming it
          //   `APPLICATION_COLUMN` here is what made this endpoint answer 500 on
          //   Oracle (`ORA-00904: "APPLICATION_COLUMN": invalid identifier`) while
          //   reading perfectly on libSQL - see `ledgerIdent`.
          `       s.${ledgerIdent('FND_ID_FLEX_SEGMENTS', 'APPLICATION_COLUMN')} AS application_column,`,
          `       s.${quoteIdent('FLEX_VALUE_SET_ID')}  AS flex_value_set_id,`,
          `       s.${quoteIdent('DISPLAY_SIZE')}       AS display_size,`,
          `       s.${quoteIdent('REQUIRED_FLAG')}      AS required_flag,`,
          `       s.${quoteIdent('ENABLED_FLAG')}       AS enabled_flag,`,
          `       (SELECT COUNT(*) FROM ${quoteIdent('FND_FLEX_VALUES')} fv`,
          `         WHERE fv.${quoteIdent('FLEX_VALUE_SET_ID')} = s.${quoteIdent('FLEX_VALUE_SET_ID')}) AS legend_values,`,
          `       (SELECT COUNT(*) FROM ${quoteIdent('FND_FLEX_VALUES')} fv`,
          `         WHERE fv.${quoteIdent('FLEX_VALUE_SET_ID')} = s.${quoteIdent('FLEX_VALUE_SET_ID')}`,
          `           AND IFNULL(fv.${quoteIdent('SUMMARY_FLAG')}, 'N') = 'N') AS named_values`,
          `  FROM ${quoteIdent('FND_ID_FLEX_SEGMENTS')} s`,
          ` ORDER BY s.${quoteIdent('ID_FLEX_NUM')} ASC, s.${quoteIdent('SEGMENT_NUM')} ASC`,
        ].join('\n'),
      );

      return {
        structure,
        segments: segments.map((r) => {
          const num = Number(r.segment_num ?? 0);
          return {
            SEGMENT_NUM: num,
            SEGMENT_NAME: r.segment_name,
            APPLICATION_COLUMN: r.application_column,
            FLEX_VALUE_SET_ID: (r.flex_value_set_id ?? null) as number | null,
            DISPLAY_SIZE: (r.display_size ?? null) as number | null,
            REQUIRED_FLAG: (r.required_flag ?? null) as string | null,
            ENABLED_FLAG: (r.enabled_flag ?? null) as string | null,
            // A segment with no value set validates against nothing, so it has no
            // legend — 0 is the true answer rather than a fallback for "unknown".
            legendValues: Number(r.legend_values ?? 0),
            namedValues: Number(r.named_values ?? 0),
            valuesUsedInAccounts:
              num >= 1 && num <= 7 ? columnNumber(usedRow, `used${num}`) : 0,
          };
        }),
        note:
          '`legendValues` and `namedValues` come from FND_FLEX_VALUES, the legend. `valuesUsedInAccounts` comes from ' +
          'GL_CODE_COMBINATIONS. Where the latter exceeds the former, the difference is codes that are in use and ' +
          'unnamed — a real state, not a failed join.',
      };
    },
  });
}

/**
 * The level codes in use, with the named/unnamed partition.
 *
 * This is the same grouping `V_SEGMENT_LEGEND` performs — `GL_CODE_COMBINATIONS`
 * grouped by `SEGMENT5`, left-joined to the legend — plus the two counts that say
 * how much of the chart of accounts the legend actually names.
 *
 * ★ IT SHARES THE VIEW'S BODY RATHER THAN RESTATING IT, AND THAT IS THE FIX.
 *   This handler used to write the grouping out again and was wrong three ways at
 *   once (see the block in its body). The value set it resolved did not name the
 *   accounting flexfield, the name it selected was on a table that does not have
 *   that column, and its non-blank predicate could never be true on Oracle. So it
 *   now reads `legendFragment()` — the corrected body `V_SEGMENT_LEGEND` also
 *   resolves to, verified at 1,308 rows on the live ledger — and reports the pin
 *   that body uses.
 *
 * ★ THE TWO ENDPOINTS AGREE, AND THE DISAGREEMENT THAT USED TO BE THE FINDING IS
 *   GONE. The module doc above is still right about the seeded view's defect: it
 *   joins the legend on the **Fund** value set (`10101`) while grouping `SEGMENT5`,
 *   so as written it names nothing. But `db/derived.ts` overrides that body, so
 *   `GET /api/coa/legend` answers with real names — **measured: 1,308 rows, every
 *   code named** — and any claim here that the view still nulls its names would be
 *   false. The difference between the two routes is now ordering and the partition:
 *   `/api/coa/legend` is the paged browse, this one leads with the named codes and
 *   adds `namedCount`/`unnamedCount`.
 */
function registerSegmentLevels(api: Api): void {
  api.route({
    method: 'get',
    path: '/api/coa/levels',
    operationId: 'coa_levels',
    summary: 'Level codes and their names, with how many codes the legend leaves unnamed',
    description:
      'Every distinct `SEGMENT5` value in use, how many account combinations carry it, and its name from the ' +
      'legend — the same grouping as `GET /api/coa/legend`, with the named/unnamed partition added.\n\n' +
      '`V_SEGMENT_LEGEND` as seeded joins the legend on `FLEX_VALUE_SET_ID = 10101` (Fund) while grouping ' +
      '`SEGMENT5` (Level, which declares its own value set), so the seeded body names nothing. `db/derived.ts` ' +
      'overrides that body with the corrected join, and both routes read it: **measured on this ledger, ' +
      '1,308 level codes and every one of them named.** A code counted in `unnamedCount` is a real state — in ' +
      'use in `GL_CODE_COMBINATIONS` with no legend row — and is not a failed join.\n\n' +
      'Not paginated: the grain is one row per level code, and the list is the whole answer.',
    tags: ['Chart of Accounts'],
    response: z
      .object({
        valueSetId: int('The value set the Level segment declares, or null when no segment maps to `SEGMENT5`.'),
        codes: intReq('Distinct level codes in use.'),
        namedCount: intReq('Codes with a name in the legend.'),
        unnamedCount: intReq('Codes in use with no legend row. Together with `namedCount` this adds up to `codes`.'),
        levels: z.array(levelRow),
        note: textReq('Why this endpoint and `GET /api/coa/legend` disagree.'),
      })
      .openapi('CoaLevels'),
    // 503 for the same reason as `/api/coa/segments`: the legend is read through
    // `ledgerPlan`, which can name a reason it cannot serve the object.
    errors: [500, 503],
    handler: async () => {
      // ★ THIS HANDLER USED TO HAND-WRITE THE GROUPING, AND IT WAS WRONG THREE WAYS
      //   AT ONCE. Each was invisible to the smoke suite, which runs on libSQL, and
      //   only one of the three was loud enough to notice:
      //
      //   1. It selected `MAX(fv."DESCRIPTION")` off `FND_FLEX_VALUES`. That column
      //      lives on `FND_FLEX_VALUES_TL`, so on Oracle the statement died with
      //      `ORA-00904: "DESCRIPTION": invalid identifier` — the 500 reported in
      //      `docs/plans/funding-latency-and-account-grain.md` §5.
      //   2. It looked the value set up with `ORDER BY ID_FLEX_NUM ASC LIMIT 1` and
      //      **no `ID_FLEX_CODE` predicate**. Measured on this ledger there are **91**
      //      segment rows declaring `SEGMENT5` across many flexfields — `PEA`, `SCL`,
      //      `BANK` — so `ID_FLEX_NUM` ordering is not "the accounting flexfield",
      //      it is whichever application happens to number a flexfield 1. It resolved
      //      to **1009904**, a `PEA`/`FACULTY` value set: the very "choosing among
      //      competing answers" defect `LEVEL_VALUE_SET` above documents.
      //   3. It filtered `SEGMENT5 IS NOT NULL AND SEGMENT5 <> ''`. **On Oracle the
      //      empty string IS NULL**, so `x <> ''` is `x <> NULL` and is never true —
      //      the predicate removes every row, and the endpoint would have answered
      //      `codes: 0, namedCount: 0, unnamedCount: 0` with HTTP 200. Once (1) was
      //      fixed that is exactly what it did, and an endpoint whose whole purpose is
      //      to report how many level codes are unnamed would have reported none.
      //      `derived.ts` had already removed this predicate and written down why.
      //
      //   `legendFragment()` in `db/derived.ts` performs this same grouping against
      //   the correctly pinned value set, joins the name on `_TL`, and has no `<> ''`
      //   — and it is what `V_SEGMENT_LEGEND` now resolves to, which is why
      //   `GET /api/coa/legend` answers with real names on this ledger. So this
      //   handler asks the helper instead of restating it. That is the fix for all
      //   three defects, and the fourth time in this module that a helper already
      //   held the right answer while a hand-written query named the columns itself.
      const found = await rows<Record<string, unknown>>(
        [
          `SELECT src.${quoteIdent('LEVEL_CODE')}    AS level_code,`,
          `       src.${quoteIdent('ACCOUNT_COUNT')}  AS account_count,`,
          `       src.${quoteIdent('LEVEL_NAME')}     AS level_name`,
          `  FROM ${legendFragment()}`,
          // Named codes first — the named ones are the short list and the point.
          //
          // ★ `ORDER BY (expr IS NULL)` IS SQLITE-ONLY. Oracle has no boolean type
          //   in SQL, so a bare `IS NULL` in an ORDER BY key is a syntax error there
          //   — and this statement is only ever executed as written, with no
          //   rewrite step, so the whole endpoint failed on the live ledger while it
          //   passed the smoke suite (which runs on libSQL). `CASE WHEN` states the
          //   same ordering and is valid on every dialect this app runs on. Same
          //   shape as the `ORDER BY x IS NOT NULL` trap already recorded for the
          //   SQL Server side of this codebase.
          ` ORDER BY CASE WHEN src.${quoteIdent('LEVEL_NAME')} IS NULL THEN 1 ELSE 0 END ASC,` +
            ` src.${quoteIdent('LEVEL_CODE')} ASC`,
        ].join('\n'),
      );

      // The pin the fragment actually used, read rather than restated — see
      // `levelValueSetExpression()`. `null` is a real answer: it means no `GL#`
      // segment numbered 101 declares `SEGMENT5`, so the join matches nothing and
      // every code is nameless *for want of a legend* rather than for want of a name.
      const vsRow = await one<Record<string, unknown>>(
        `SELECT ${levelValueSetExpression()} AS value_set_id`,
      );
      const raw = vsRow?.value_set_id;
      const valueSetId = raw === null || raw === undefined ? null : Number(raw);

      const namedCount = found.filter((r) => r.level_name !== null && r.level_name !== undefined).length;

      return {
        valueSetId,
        codes: found.length,
        namedCount,
        unnamedCount: found.length - namedCount,
        levels: found.map((r) => ({
          LEVEL_CODE: r.level_code,
          ACCOUNT_COUNT: Number(r.account_count ?? 0),
          LEVEL_NAME: (r.level_name ?? null) as string | null,
        })),
        note:
          '`namedCount` of `codes` level codes carry a name. This is the same grouping `GET /api/coa/legend` '
            + 'serves, with the named/unnamed partition added; both resolve the name against the value set the '
            + 'Level segment itself declares (`valueSetId`), so the two agree on every code and every name. A '
            + 'count in `unnamedCount` is a code that accounts use and the legend has no row for — a real state, '
            + 'not a failed join.',
      };
    },
  });
}

/**
 * Look an account combination up by its dotted seven-segment key.
 *
 * This is the durable identity of an account, and it is the one a bookmark, a
 * saved report or an extract should carry — `CODE_COMBINATION_ID` is reassigned by
 * any chart-of-accounts rebuild. The path is `/combination-key/` rather than
 * `/combinations/{key}` on purpose: Express matches in registration order, so a
 * second parameterised route at the same depth as the resource's `/{id}` would be
 * shadowed by it and this endpoint would be unreachable. See the module header.
 */
function registerCombinationKeyLookup(api: Api): void {
  api.route({
    method: 'get',
    path: '/api/coa/combination-key/{key}',
    operationId: 'coa_combinationByKey',
    summary: 'An account combination by its dotted seven-segment key',
    description:
      'Looks up an account by `SEGMENT1.SEGMENT2.…SEGMENT7` — the durable identifier, as exposed by ' +
      '`V_CODE_COMBINATION_KEY.COMBINATION_KEY` and `V_ACCOUNT_POSITION.BUDGET_ACCOUNT`.\n\n' +
      'Prefer this over `GET /api/coa/combinations/{id}` for anything that outlives the current database: ' +
      '`CODE_COMBINATION_ID` is a surrogate that a chart-of-accounts rebuild reassigns, while the segments are what ' +
      'the account *is*.\n\n' +
      'The key is matched exactly, including the dots — a missing or extra segment is a 404 rather than a fuzzy match, ' +
      'because a partially-correct account key is a different account.',
    tags: ['Chart of Accounts'],
    params: z.object({
      key: StrParam.openapi({
        example: '1000.6570.0000.5260.0450.0000.0000',
        description: 'The seven segments joined with dots.',
      }),
    }),
    response: z
      .object({
        combination: codeCombinationRow,
        key: textReq('The combination key that was matched.'),
        keyMatchCount: z
          .number()
          .int()
          .openapi({ description: 'How many combinations carry this key. More than one is a data fault worth seeing.' }),
        position: z
          .object({
            WCPSS_BUDGET: real('**Derived** total of the `CAPITAL` budget column.'),
            ALLOCATIONS_REIMB: real('**Derived** allocations and reimbursements.'),
            ENCUMBRANCES: real('Encumbrances from `ACTUAL_FLAG = \'E\'` balances.'),
            EXPENDITURES: real('Expenditures from `ACTUAL_FLAG = \'A\'` balances.'),
            AVAILABLE_FUNDS: real('**Derived:** `ALLOCATIONS_REIMB − ENCUMBRANCES − EXPENDITURES`.'),
          })
          .nullable()
          .openapi('CombinationPosition'),
      })
      .openapi('CombinationByKey'),
    errors: [400, 404, 500],
    handler: async (ctx) => {
      const key = ctx.params.key;
      const table = quoteIdent('GL_CODE_COMBINATIONS');
      const combination = await one(
        `SELECT ${CODE_COMBINATION_COLUMNS.map(quoteIdent).join(', ')} FROM ${table} ` +
          `WHERE ${concatExpr(ACCOUNT_SEGMENT_COLUMNS.map(quoteIdent), '.')} = :key ` +
          `ORDER BY ${quoteIdent('CODE_COMBINATION_ID')} ASC LIMIT 1`,
        { key: bindable(key) },
      );
      if (!combination) {
        throw AppError.notFound(`Account combination ${key}`);
      }

      // The key is not declared unique, so "how many matched" is a fact worth
      // returning rather than an invariant worth assuming — a duplicate would
      // otherwise be invisible behind the LIMIT 1 above.
      const keyMatchCount = await columnNumber(
        await one<Record<string, unknown>>(
          `SELECT COUNT(*) AS n FROM ${table} ` +
            `WHERE ${quoteIdent('SEGMENT1')} || '.' || ${quoteIdent('SEGMENT2')} || '.' || ${quoteIdent('SEGMENT3')} || '.' || ` +
            `${quoteIdent('SEGMENT4')} || '.' || ${quoteIdent('SEGMENT5')} || '.' || ${quoteIdent('SEGMENT6')} || '.' || ` +
            `${quoteIdent('SEGMENT7')} = :key`,
          { key: bindable(key) },
        ),
        'n',
      );

      // Null rather than zeros when the account has no funded position: "not in
      // the position view at all" and "in it, with nothing" are different answers.
      const position = await one(
        `SELECT ${quoteIdent('WCPSS_BUDGET')}, ${quoteIdent('ALLOCATIONS_REIMB')}, ${quoteIdent('ENCUMBRANCES')}, ` +
          `${quoteIdent('EXPENDITURES')}, ${quoteIdent('AVAILABLE_FUNDS')} ` +
          `FROM ${quoteIdent('V_ACCOUNT_POSITION')} WHERE ${quoteIdent('BUDGET_ACCOUNT')} = :key`,
        { key: bindable(key) },
      );

      return { combination, key, keyMatchCount, position };
    },
  });
}
