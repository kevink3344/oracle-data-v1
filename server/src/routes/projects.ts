import { z } from '../http/z.js';
import type { Api } from '../http/api.js';
import { AppError } from '../http/errors.js';
import { registerResource, type ResourceDescriptor } from './resource.js';
import { columnNumber, one, quoteIdent, rows } from '../db/sql.js';
import { ledgerPlan } from '../db/ledger-shape.js';
import { date, int, intReq, real, realReq, rowObject, text, textReq, writeObject } from '../schemas/columns.js';

/**
 * Projects.
 *
 * ---------------------------------------------------------------------------
 * THE FINDING THIS MODULE IS BUILT AROUND
 * ---------------------------------------------------------------------------
 *
 * **The database holds no project dimension.** Four tables model one —
 * `PA_PROJECTS_ALL`, `PA_TASKS`, `PA_BUDGET_VERSIONS` and the lines below it —
 * and all four are empty in the sample. They are empty *by design*, not by
 * oversight: the schema annotates them "Empty until a source is confirmed. Both
 * doors are kept open; neither is assumed." There is a fifth candidate — the
 * denormalised `EXP_PROJECT_NAME` on the purchase-order header — and it is null
 * on all 749 rows of **both** PO header tables.
 *
 * So this domain does not invent the missing dimension, and it does not
 * conflate two populations that are not the same population:
 *
 *   - The **EBS project tables** are exposed as what they are — real tables with
 *     the right shape and zero rows. When a source is confirmed, these endpoints
 *     start returning rows with no change here.
 *
 *   - The **report's own project figures** live in `X_REPORT_PROJECT_FACTS` and
 *     `X_REPORT_FUNDING_LINES`, and those are *not* empty: seven construction
 *     facts (CCAP, the two GMP packages, GSF, $/SF, the off-site allowance) and
 *     seven funding lines. The schema quarantines them behind the `X_` prefix
 *     precisely because the report's planning block "has NO standard EBS home",
 *     and it says to treat them as decorative until a real source is found. This
 *     module honours that: the endpoints serve them *as the report's
 *     transcription*, named as such in every description, and `/summary` labels
 *     the arithmetic rather than promoting it.
 *
 *   - The **project identity the UI shows** is not in the database at all. The
 *     only place a project name appears in the extract is free text inside a PO
 *     line's `DESCRIPTION` — `"GARNER HS TRACK REPLACEMENT - 0004 - …"` — which
 *     means the project grain is a *reading of prose*, not a key. That reading
 *     belongs to whoever consumes the lines; it is not derivable in SQL without
 *     choosing a regex, and a regex in a reporting view is a decision the
 *     database should not make silently. So the API exposes the material the
 *     reading needs (the lines, through the Procurement domain, and the whole
 *     extract through `/api/extract/current`) and leaves the reading where it is.
 *
 * The one thing this module *does* assert is arithmetic the report itself
 * records, checked in `/summary` against the table rather than hard-coded:
 * `GMP_BUILDING + GMP_SITE = GMP_TOTAL`, and `GMP_TOTAL / GSF = COST_PER_SF`.
 * Both hold on the sample. They are returned as a verdict so a consumer can
 * test the transcription without a second copy of the numbers.
 */

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

const PROJECT_MASTER_COLUMNS = [
  'PROJECT_ID',
  'PROJECT_NUMBER',
  'NAME',
  'PROJECT_TYPE',
  'PROJECT_STATUS_CODE',
  'START_DATE',
  'COMPLETION_DATE',
  'ORG_ID',
  'CARRYING_OUT_ORGANIZATION_ID',
] as const;

const PROJECT_TASK_COLUMNS = [
  'TASK_ID',
  'PROJECT_ID',
  'TASK_NUMBER',
  'TASK_NAME',
  'START_DATE',
  'COMPLETION_DATE',
] as const;

const REPORT_FACT_COLUMNS = ['FACT_NAME', 'FACT_VALUE', 'UNIT', 'NOTE'] as const;

const REPORT_FUNDING_LINE_COLUMNS = [
  'LINE_NUM',
  'DESCRIPTION',
  'AMOUNT',
  'ANNOTATION',
  'EVENT_DATE',
  'FISCAL_YEAR',
  'IS_FORECAST',
  'IN_FUNDING_TOTAL',
] as const;

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

const projectMasterRow = rowObject(
  {
    PROJECT_ID: intReq('EBS project identifier. Primary key.'),
    PROJECT_NUMBER: text('Project number as EBS holds it.'),
    NAME: textReq('Project name. `NOT NULL` in the DDL, so it is required on create.'),
    PROJECT_TYPE: text('EBS project type.'),
    PROJECT_STATUS_CODE: text('EBS project status.'),
    START_DATE: date('Planned or actual start.'),
    COMPLETION_DATE: date('Planned or actual completion.'),
    ORG_ID: int('Operating unit the project belongs to.'),
    CARRYING_OUT_ORGANIZATION_ID: int('The organization carrying the project out.'),
  },
  'A row of `PA_PROJECTS_ALL`.',
);

const projectTaskRow = rowObject(
  {
    TASK_ID: intReq('EBS task identifier. Primary key.'),
    PROJECT_ID: intReq('Owning project. `NOT NULL` in the DDL.'),
    TASK_NUMBER: text('Task number as EBS holds it.'),
    TASK_NAME: text('Task name.'),
    START_DATE: date('Planned or actual start.'),
    COMPLETION_DATE: date('Planned or actual completion.'),
  },
  'A row of `PA_TASKS`.',
);

const reportFactRow = rowObject(
  {
    FACT_NAME: textReq(
      'Fact key. Primary key. In this sample: `GSF`, `CCAP`, `GMP_BUILDING`, `GMP_SITE`, `GMP_TOTAL`, ' +
        '`COST_PER_SF`, `OFF_SITE`.',
    ),
    FACT_VALUE: text(
      'The value, **as text**. Numeric facts are stored as text so one table can hold `"143000"`, `"620.54"` and ' +
        'any future non-numeric fact without changing the column type. Parse it against `UNIT`; do not assume a ' +
        'number, and do not treat a missing row as zero.',
    ),
    UNIT: text('Unit of measure: `USD`, `USD/sq ft`, `sq ft`.'),
    NOTE: text('How the report defines or derives the fact — worth reading before quoting one.'),
  },
  'A row of `X_REPORT_PROJECT_FACTS`. **The report’s transcription, not an EBS measure.**',
);

const reportFundingLineRow = rowObject(
  {
    LINE_NUM: intReq('Line number. Primary key, and the report’s own order.'),
    DESCRIPTION: textReq('The line as the report labels it, e.g. `FY24 Appropriation`.'),
    AMOUNT: realReq('The amount. `NOT NULL` in the DDL.'),
    ANNOTATION: text('Provenance as written: `BOE 7/13/2022` for an appropriation, `Est. 8/20/2026` for a forecast.'),
    EVENT_DATE: date('Parsed from `ANNOTATION`.'),
    FISCAL_YEAR: int(
      'The fiscal year the line belongs to. It follows `LINE_NUM` in this sample, but it is not part of the key — ' +
        'so `LINE_NUM` is what the default order uses.',
    ),
    IS_FORECAST: intReq('`1` for an estimated future year, `0` for an appropriation or a reallocation.'),
    IN_FUNDING_TOTAL: intReq('`1` when the line counts toward the funding total.'),
  },
  'A row of `X_REPORT_FUNDING_LINES`. **The report’s transcription, not an EBS measure.**',
);

const projectMasterWrite = writeObject(projectMasterRow, 'A project to create or update.');
const projectTaskWrite = writeObject(projectTaskRow, 'A project task to create or update.');
const reportFactWrite = writeObject(reportFactRow, 'A report fact to create or update.');
const reportFundingLineWrite = writeObject(reportFundingLineRow, 'A report funding line to create or update.');

// ---------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------

/**
 * The EBS project master. Empty in the sample, and that is the point of exposing
 * it: an empty list from a mounted route is a fact, a 404 is not.
 */
const PROJECT_MASTER: ResourceDescriptor = {
  name: 'projectMaster',
  label: 'Project',
  basePath: '/api/projects/master',
  table: 'PA_PROJECTS_ALL',
  columns: PROJECT_MASTER_COLUMNS,
  pk: 'PROJECT_ID',
  pkKind: 'integer',
  searchable: ['PROJECT_NUMBER', 'NAME'],
  sortable: ['PROJECT_ID', 'PROJECT_NUMBER', 'NAME', 'START_DATE', 'COMPLETION_DATE'],
  filters: [
    { column: 'PROJECT_TYPE', description: 'Exact match on the EBS project type.' },
    { column: 'PROJECT_STATUS_CODE', description: 'Exact match on the EBS project status.' },
    { column: 'ORG_ID', kind: 'integer', description: 'Projects in one operating unit.' },
  ],
  defaultSort: `${quoteIdent('NAME')} ASC`,
  tags: ['Projects'],
  row: projectMasterRow,
  writes: { create: projectMasterWrite, update: projectMasterWrite.partial() },
};

/**
 * `PA_TASKS` is a sibling path, not `/api/projects/master/tasks`.
 *
 * The framework gives every keyed resource a `/{id}` detail route, so a nested
 * path would sit at the same depth as the project's own detail route and be
 * matched by it. Siblings keep both resolvable and are the convention the other
 * domains already use.
 */
const PROJECT_TASK: ResourceDescriptor = {
  name: 'projectTasks',
  label: 'Project task',
  basePath: '/api/projects/tasks',
  table: 'PA_TASKS',
  columns: PROJECT_TASK_COLUMNS,
  pk: 'TASK_ID',
  pkKind: 'integer',
  searchable: ['TASK_NUMBER', 'TASK_NAME'],
  sortable: ['TASK_ID', 'PROJECT_ID', 'TASK_NUMBER', 'START_DATE', 'COMPLETION_DATE'],
  filters: [{ column: 'PROJECT_ID', kind: 'integer', description: 'The tasks of one project.' }],
  defaultSort: `${quoteIdent('PROJECT_ID')} ASC, ${quoteIdent('TASK_ID')} ASC`,
  tags: ['Projects'],
  row: projectTaskRow,
  writes: { create: projectTaskWrite, update: projectTaskWrite.partial() },
};

const REPORT_FACT: ResourceDescriptor = {
  name: 'projectFacts',
  label: 'Report project fact',
  basePath: '/api/projects/facts',
  table: 'X_REPORT_PROJECT_FACTS',
  columns: REPORT_FACT_COLUMNS,
  pk: 'FACT_NAME',
  pkKind: 'text',
  searchable: ['FACT_NAME', 'NOTE'],
  sortable: ['FACT_NAME', 'FACT_VALUE'],
  filters: [{ column: 'UNIT', description: 'Exact match on the unit of measure.' }],
  // Alphabetical, not by value: the values are text that happens to be numeric,
  // so ordering by `FACT_VALUE` is a string order (`'143000'` before `'620.54'`)
  // and would read as if it meant something. Sorting stays available; it is just
  // not what the default pretends to be.
  defaultSort: `${quoteIdent('FACT_NAME')} ASC`,
  tags: ['Projects'],
  row: reportFactRow,
  writes: { create: reportFactWrite, update: reportFactWrite.partial() },
};

const REPORT_FUNDING_LINE: ResourceDescriptor = {
  name: 'projectFundingLines',
  label: 'Report funding line',
  basePath: '/api/projects/funding-lines',
  table: 'X_REPORT_FUNDING_LINES',
  columns: REPORT_FUNDING_LINE_COLUMNS,
  pk: 'LINE_NUM',
  pkKind: 'integer',
  searchable: ['DESCRIPTION', 'ANNOTATION'],
  sortable: ['LINE_NUM', 'FISCAL_YEAR', 'EVENT_DATE', 'AMOUNT'],
  filters: [
    { column: 'FISCAL_YEAR', kind: 'integer', description: 'One fiscal year of the funding story.' },
    { column: 'IS_FORECAST', kind: 'integer', description: '`1` for the estimated future years only.' },
    { column: 'IN_FUNDING_TOTAL', kind: 'integer', description: '`1` for the lines that count toward the total.' },
  ],
  defaultSort: `${quoteIdent('LINE_NUM')} ASC`,
  tags: ['Projects'],
  row: reportFundingLineRow,
  writes: { create: reportFundingLineWrite, update: reportFundingLineWrite.partial() },
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerProjects(api: Api): void {
  registerResource(api, PROJECT_MASTER);
  registerResource(api, PROJECT_TASK);
  registerResource(api, REPORT_FACT);
  registerResource(api, REPORT_FUNDING_LINE);

  registerProjectsSummary(api);
}

/** One arithmetic check the report's own transcription implies. */
interface Identity {
  name: string;
  expression: string;
  computed: number | null;
  stated: number | null;
  holds: boolean;
  unit: string;
}

/**
 * Compare a derived figure against the one the table states.
 *
 * A missing operand yields `computed: null` and `holds: false` — deliberately
 * *not* `0`, and not an exception. `Number(undefined)` would be `NaN` and
 * `Number(null)` is `0`, and both would turn "the fact is not in the table" into
 * a plausible-looking number that agrees with nothing. `null` plus `false` says
 * the check could not be run, which is the truth.
 *
 * The tolerance is a half-cent: the report stores `COST_PER_SF` already rounded
 * to two decimals, so the identity can only be exact to that rounding.
 */
function identity(
  name: string,
  expression: string,
  computed: number | null,
  stated: number | null,
  unit: string,
): Identity {
  return {
    name,
    expression,
    computed,
    stated,
    holds: computed === null || stated === null ? false : Math.abs(computed - stated) < 0.005,
    unit,
  };
}

/**
 * A number, or null when the column is absent or is not a number.
 *
 * Deliberately **not** `columnNumber`, which turns a missing value into `0`:
 * `MIN(FISCAL_YEAR)` over an empty table genuinely has no value, and a fiscal
 * year of `0` is not a year. This is the one place in the module where a null has
 * to survive to the response.
 */
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

/**
 * What this domain actually knows, said plainly.
 *
 * The row counts answer "why is the project list empty?" without the caller
 * having to query four tables to find out, and the identity block answers "is
 * this transcription self-consistent?" without the caller re-deriving figures
 * that only the report can define.
 */
function registerProjectsSummary(api: Api): void {
  api.route({
    method: 'get',
    path: '/api/projects/summary',
    operationId: 'projects_summary',
    summary: 'Why the project tables are empty, and what the report records instead',
    description:
      'Row counts for the EBS project tables and the report’s two project tables, the report’s funding totals, and ' +
      'the arithmetic the report’s own figures imply.\n\n' +
      '**There is no project dimension in this database yet.** `PA_PROJECTS_ALL`, `PA_TASKS` and the project budget ' +
      'tables are empty by design, and `EXP_PROJECT_NAME` is null on every row of `PO_HEADERS_ALL` ' +
      '(`poHeadersWithProjectName` is `0`). The `storage` block reports those counts so the emptiness is ' +
      'visible as data rather than as an empty array a consumer has to interpret.\n\n' +
      'The `identities` block is the useful part. The report records `GMP_BUILDING`, `GMP_SITE`, `GMP_TOTAL`, ' +
      '`GSF` and `COST_PER_SF`; two of those are arithmetic on the others. Each identity is recomputed from the ' +
      'table in the same request and reported against the stated value, so a transcription that stopped adding up ' +
      'is visible here instead of silently quoted downstream.',
    tags: ['Projects'],
    response: z
      .object({
        storage: z
          .object({
            projectMaster: intReq('Rows in `PA_PROJECTS_ALL`.'),
            tasks: intReq('Rows in `PA_TASKS`.'),
            budgetVersions: intReq('Rows in `PA_BUDGET_VERSIONS`.'),
            budgetLines: intReq('Rows in `PA_BUDGET_LINES`.'),
            poHeaders: intReq('Rows in `PO_HEADERS_ALL`.'),
            poHeadersWithProjectName: intReq(
              'Rows of `PO_HEADERS_ALL` whose `EXP_PROJECT_NAME` is non-blank. **Zero in this sample** — the header ' +
                'carries the column and the values are all null.',
            ),
            distinctProjectNames: intReq(
              'Distinct non-blank `EXP_PROJECT_NAME` values in `PO_HEADERS_ALL`. **Zero in this sample.**',
            ),
          })
          .openapi('ProjectStorageCounts'),
        report: z
          .object({
            facts: intReq('Rows in `X_REPORT_PROJECT_FACTS`.'),
            factsByUnit: z.array(
              z
                .object({
                  unit: text('Unit of measure as the fact row records it.'),
                  facts: intReq('Facts carrying that unit.'),
                })
                .openapi('ProjectFactUnit'),
            ),
            fundingLines: intReq('Rows in `X_REPORT_FUNDING_LINES`.'),
            fundingInTotal: realReq('`SUM(AMOUNT)` over the lines flagged `IN_FUNDING_TOTAL = 1`.'),
            fundingForecast: realReq('`SUM(AMOUNT)` over the lines flagged `IS_FORECAST = 1`.'),
            fundingEveryLine: realReq('`SUM(AMOUNT)` over every line, flags ignored. Returned so a consumer can see ' +
              'whether the total differs from it.'),
            fundingFirstYear: int('Lowest `FISCAL_YEAR` present, or null when the table is empty.'),
            fundingLastYear: int('Highest `FISCAL_YEAR` present, or null when the table is empty.'),
          })
          .openapi('ProjectReportTotals'),
        identities: z.array(
          z
            .object({
              name: textReq('The fact the expression is compared against.'),
              expression: textReq('The expression, in the report’s own terms.'),
              computed: real(
                'The expression evaluated against this request’s read of the table. Null when an operand is absent ' +
                  '— which is not the same as zero.',
              ),
              stated: real('The value the table states for `name`.'),
              holds: z.boolean().openapi({
                description: 'True when `computed` and `stated` agree to within half a cent.',
              }),
              unit: text('Unit of measure for both figures.'),
            })
            .openapi('ProjectIdentity'),
        ),
        source: textReq('The tables the figures were read from, named so a consumer can check them.'),
        note: textReq(
          'A plain statement of what is empty, what is transcribed, and where the project identity actually lives.',
        ),
      })
      .openapi('ProjectsSummary'),
    errors: [500],
    handler: async () => {
      /**
       * ★ `EXP_PROJECT_NAME` IS NOT ON `PO_HEADERS_ALL`. IT IS ON `WCSEXP_PO_HEADERS`.
       *
       *   The statements below used to name the column on the table. That works on
       *   the sample store, whose `PO_HEADERS_ALL` is itself extract-shaped, and it
       *   does not work on the live ledger: that object has 213 columns and none of
       *   them is `EXP_PROJECT_NAME`, so this endpoint answered 500 with a bare
       *   `INTERNAL` envelope while the column sat on the view, joined 1:1 on
       *   `PO_HEADER_ID`.
       *
       *   The comment that used to stand here said the WCSEXP view "was a plain
       *   projection of PO_HEADERS_ALL" and had been retired. The retirement was
       *   real; the first half was not, and these column references outlived the
       *   UNION that used to supply them.
       *
       *   So the read source is asked for rather than written down. `ledgerPlan` is
       *   the one place that knows where a declared column actually lives, it
       *   returns the plain quoted table on every dialect but Oracle, and reusing it
       *   is what keeps this route from drifting away from the resource routes
       *   again. The name inside the view is the projected name, so neither the
       *   predicate nor the count needs a dialect branch of its own.
       */
      const poName = await ledgerPlan({
        table: 'PO_HEADERS_ALL',
        columns: ['EXP_PROJECT_NAME'],
      });
      if (!poName.ok) {
        throw AppError.dbUnavailable(
          `A purchase order's project name cannot be read on this deployment: ${poName.reason}`,
          { table: 'PO_HEADERS_ALL' },
        );
      }
      const projectName = quoteIdent('EXP_PROJECT_NAME');
      const namedPo =
        `SELECT * FROM ${poName.from}\n` +
        `    WHERE TRIM(IFNULL(${projectName}, '')) <> ''`;

      const counts = await one<Record<string, unknown>>(
        [
          'SELECT',
          `  (SELECT COUNT(*) FROM ${quoteIdent('PA_PROJECTS_ALL')}) AS project_master,`,
          `  (SELECT COUNT(*) FROM ${quoteIdent('PA_TASKS')}) AS tasks,`,
          `  (SELECT COUNT(*) FROM ${quoteIdent('PA_BUDGET_VERSIONS')}) AS budget_versions,`,
          `  (SELECT COUNT(*) FROM ${quoteIdent('PA_BUDGET_LINES')}) AS budget_lines,`,
          `  (SELECT COUNT(*) FROM ${quoteIdent('PO_HEADERS_ALL')}) AS po_headers,`,
          `  (SELECT COUNT(*) FROM (${namedPo}) po) AS po_named,`,
          `  (SELECT COUNT(DISTINCT ${projectName}) FROM (${namedPo}) po) AS distinct_names`,
        ].join('\n'),
      );

      const reportCounts = await one<Record<string, unknown>>(
        [
          'SELECT',
          `  (SELECT COUNT(*) FROM ${quoteIdent('X_REPORT_PROJECT_FACTS')}) AS facts,`,
          `  (SELECT COUNT(*) FROM ${quoteIdent('X_REPORT_FUNDING_LINES')}) AS funding_lines`,
        ].join('\n'),
      );

      const byUnit = await rows<Record<string, unknown>>(
        [
          `SELECT ${quoteIdent('UNIT')} AS unit,`,
          `       COUNT(*) AS facts`,
          `  FROM ${quoteIdent('X_REPORT_PROJECT_FACTS')}`,
          ` GROUP BY ${quoteIdent('UNIT')}`,
          ` ORDER BY facts DESC, unit ASC`,
        ].join('\n'),
      );

      // The funding totals. `MIN`/`MAX` come back null on an empty table, which
      // is the honest answer and is why the schema is nullable rather than
      // defaulting to 0 — year 0 is not a year.
      const funding = await one<Record<string, unknown>>(
        [
          'SELECT',
          `  COALESCE(SUM(CASE WHEN ${quoteIdent('IN_FUNDING_TOTAL')} = 1 THEN ${quoteIdent('AMOUNT')} ELSE 0 END), 0) AS in_total,`,
          `  COALESCE(SUM(CASE WHEN ${quoteIdent('IS_FORECAST')} = 1 THEN ${quoteIdent('AMOUNT')} ELSE 0 END), 0) AS forecast,`,
          `  COALESCE(SUM(${quoteIdent('AMOUNT')}), 0) AS every_line,`,
          `  MIN(${quoteIdent('FISCAL_YEAR')}) AS first_year,`,
          `  MAX(${quoteIdent('FISCAL_YEAR')}) AS last_year`,
          `  FROM ${quoteIdent('X_REPORT_FUNDING_LINES')}`,
        ].join('\n'),
      );

      // Read the facts once into a map, then evaluate the identities in TypeScript
      // rather than as correlated subqueries. Two reasons: a missing fact is one
      // lookup miss instead of five subqueries returning null, and the arithmetic
      // stays readable — it is a sentence about the report, not a SQL puzzle.
      const factRows = await rows<Record<string, unknown>>(
        `SELECT ${quoteIdent('FACT_NAME')} AS name, ${quoteIdent('FACT_VALUE')} AS value FROM ${quoteIdent('X_REPORT_PROJECT_FACTS')}`,
      );
      const factValue = (name: string): number | null => {
        const row = factRows.find((r) => r.name === name);
        if (!row || typeof row.value !== 'string') return null;
        const n = Number(row.value);
        return Number.isFinite(n) ? n : null;
      };
      const add = (a: number | null, b: number | null): number | null =>
        a === null || b === null ? null : a + b;

      const gsf = factValue('GSF');
      const gmpTotal = factValue('GMP_TOTAL');
      const perSf =
        gsf === null || gmpTotal === null || gsf === 0 ? null : Math.round((gmpTotal / gsf) * 100) / 100;

      const identities: Identity[] = [
        identity('GMP_TOTAL', 'GMP_BUILDING + GMP_SITE', add(factValue('GMP_BUILDING'), factValue('GMP_SITE')), gmpTotal, 'USD'),
        identity('COST_PER_SF', 'GMP_TOTAL / GSF', perSf, factValue('COST_PER_SF'), 'USD/sq ft'),
      ];

      return {
        storage: {
          projectMaster: columnNumber(counts, 'project_master'),
          tasks: columnNumber(counts, 'tasks'),
          budgetVersions: columnNumber(counts, 'budget_versions'),
          budgetLines: columnNumber(counts, 'budget_lines'),
          poHeaders: columnNumber(counts, 'po_headers'),
          poHeadersWithProjectName: columnNumber(counts, 'po_named'),
          distinctProjectNames: columnNumber(counts, 'distinct_names'),
        },
        report: {
          facts: columnNumber(reportCounts, 'facts'),
          factsByUnit: byUnit.map((r) => ({
            unit: typeof r.unit === 'string' ? r.unit : null,
            facts: columnNumber(r, 'facts'),
          })),
          fundingLines: columnNumber(reportCounts, 'funding_lines'),
          fundingInTotal: columnNumber(funding, 'in_total'),
          fundingForecast: columnNumber(funding, 'forecast'),
          fundingEveryLine: columnNumber(funding, 'every_line'),
          // Not `columnNumber`: a null year is a real absence and must survive as
          // null rather than becoming 0.
          fundingFirstYear: numberOrNull(funding?.['first_year']),
          fundingLastYear: numberOrNull(funding?.['last_year']),
        },
        identities,
        source: 'PA_PROJECTS_ALL, PA_TASKS, PA_BUDGET_VERSIONS, PA_BUDGET_LINES, PO_HEADERS_ALL, X_REPORT_PROJECT_FACTS, X_REPORT_FUNDING_LINES',
        note:
          'The EBS project tables are empty until a source is confirmed, and no purchase-order header carries a ' +
          'project name, so there is no project dimension to list. The report’s planning figures (CCAP, the GMP ' +
          'packages, GSF, $/SF) and its forward-year funding rows are transcribed into the two X_REPORT_ tables ' +
          'because the report has no standard EBS home for them; the roles of these figures are defined by the ' +
          'report, not by the general ledger. The project names the UI shows are read from free text inside ' +
          'purchase-order line descriptions and are not stored as keys anywhere.',
      };
    },
  });
}
