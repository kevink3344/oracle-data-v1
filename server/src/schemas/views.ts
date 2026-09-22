import { z } from '../http/z.js';
import { ListQuerySchema } from './common.js';

/**
 * Shapes for the View Builder domain.
 *
 * A saved view is three things bolted together, and keeping them in one file
 * rather than in the route is what lets the write path and the OpenAPI document
 * describe the same object:
 *
 *   1. `sql`         — trusted, curated, run as-is. Never rewritten.
 *   2. `params_json` — the declared parameters, compiled to binds server-side.
 *   3. `display_json`— how the result is presented, validated against the
 *                      columns the query actually returned.
 *
 * ★ VALIDATION HAPPENS ON WRITE, NOT ON RUN. A view that cannot run should not be
 *   saved, and a view that was saved should run without a second round of shape
 *   checks. That split is why `display_json` is checked against *real* columns at
 *   write time and merely reconciled at run time (see the drift notice in
 *   `routes/views.ts`).
 */

/* ------------------------------------------------------------------------- *
 * display_json
 * ------------------------------------------------------------------------- */

/**
 * Formats name helpers that already exist in `app/src/data/format.ts`.
 *
 * ★ Deliberately a closed list. A free-text format field would let a view declare
 *   `"currency"` and silently render nothing, and the alternative — a second
 *   formatting implementation server-side — is how a preview and a download start
 *   disagreeing about what a number is.
 *
 * ★ The default is `text`, and for a *nullable money* column that is the right
 *   answer rather than a lazy one: every numeric helper in `format.ts` ends in
 *   `Number(n) || 0`, so a null becomes `$0.00` — an asserted value where the
 *   truth is "not known". `text` renders the null, and the reader can see it.
 */
export const VIEW_FORMATS = [
  'text',
  'money',
  'money0',
  'moneyShort',
  'num',
  'pct',
  'pctSlim',
  'day',
  'month',
  'monthLong',
] as const;

export const ViewFormatSchema = z.enum(VIEW_FORMATS).openapi({
  description:
    'How to render the column. Each value names a helper in `app/src/data/format.ts`.',
  example: 'money',
});

export const ViewColumnDisplaySchema = z
  .object({
    key: z.string().min(1).max(128).openapi({
      description: 'The column name as the query returns it. Matched case-insensitively.',
      example: 'NET_AMOUNT',
    }),
    label: z.string().trim().max(80).optional().openapi({
      description: 'Header text. Defaults to the column name with underscores as spaces.',
    }),
    format: ViewFormatSchema.optional().openapi({ description: 'Defaults to `text`.' }),
  })
  .openapi('ViewColumnDisplay');

export const ViewDisplaySchema = z
  .object({
    columns: z
      .array(ViewColumnDisplaySchema)
      .max(200)
      .optional()
      .openapi({
        description:
          'Per-column presentation, and the column order. Columns the query returns but this ' +
          'list does not name are still shown — the list orders and labels, it does not filter. ' +
          'Use `hidden` to remove one.',
      }),
    hidden: z
      .array(z.string().min(1).max(128))
      .max(200)
      .optional()
      .openapi({
        description:
          'Columns to leave out of the grid. Kept separate from `columns` so hiding a column ' +
          'does not discard its label and format.',
      }),
    sort: z
      .object({
        key: z.string().min(1).max(128),
        dir: z.enum(['asc', 'desc']).default('asc'),
      })
      .optional()
      .openapi({
        description:
          'Initial grid sort. Applied to the returned rows, not pushed into the SQL — the ' +
          'statement is the author’s and is not rewritten.',
      }),
    fingerprint: z
      .object({
        key: z.string().min(1).max(128),
      })
      .optional()
      .openapi({
        description:
          'The column that identifies a row, used to fingerprint a result for change ' +
          'detection (see the subscription endpoints). Without it a view cannot be watched ' +
          'for changes, which is a fact the subscription panel states rather than hides.',
      }),
  })
  .openapi('ViewDisplay');

/* ------------------------------------------------------------------------- *
 * params_json
 * ------------------------------------------------------------------------- */

export const ViewParamTypeSchema = z.enum(['text', 'number', 'date']).openapi({
  description: 'How the value is coerced before binding. `number` becomes a real number, not a string.',
  example: 'text',
});

export const ViewParamSchema = z
  .object({
    name: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'A parameter name is letters, digits and underscore, not starting with a digit.')
      .max(64)
      .openapi({ description: 'The `:name` token as it appears in the SQL, without the colon.', example: 'period' }),
    label: z.string().trim().max(80).optional().openapi({
      description: 'Field label on the run form. Defaults to the name.',
    }),
    type: ViewParamTypeSchema.default('text'),
    default: z
      .union([z.string(), z.number(), z.null()])
      .optional()
      .openapi({ description: 'Used when the caller supplies nothing.', example: '2025-01' }),
    from: z.string().trim().max(128).optional().openapi({
      description:
        'A hint for a future picker, e.g. `cost_center.level_code`. Declared, not enforced — the ' +
        'value is still validated against `type` when it is supplied.',
      example: 'cost_center.level_code',
    }),
  })
  .openapi('ViewParam');

/* ------------------------------------------------------------------------- *
 * Slugs
 * ------------------------------------------------------------------------- */

/**
 * A slug is the view's stable, human-readable identity in a URL.
 *
 * Lowercase, digits and single dashes. Strict because a slug is the one part of a
 * view that other things reference — a subscription target, a bookmark, a link in
 * a message — and normalising it on read ("we'll match despite the case") makes
 * two views that look different resolve to the same URL.
 */
export const ViewSlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    'A slug is lowercase letters, digits and single dashes, e.g. `first-fundings-by-project`.',
  )
  .openapi({ example: 'first-fundings-by-project' });

export const VIEW_STATUSES = ['draft', 'active', 'disabled'] as const;
export const ViewStatusSchema = z.enum(VIEW_STATUSES).openapi({
  description: '`draft` is being written, `active` is meant to be run, `disabled` is kept but not offered.',
  example: 'active',
});

/* ------------------------------------------------------------------------- *
 * The row, as the API returns it
 * ------------------------------------------------------------------------- */

export const ViewRowSchema = z
  .object({
    id: z.number().int(),
    slug: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    sql: z.string(),
    /** Parsed, not a string — the client should never `JSON.parse` an API field. */
    params: z.array(ViewParamSchema),
    display: ViewDisplaySchema,
    created_by: z.string().nullable(),
    status: ViewStatusSchema,
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi('View');

/* ------------------------------------------------------------------------- *
 * Request bodies
 * ------------------------------------------------------------------------- */

export const ViewCreateBodySchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    slug: ViewSlugSchema,
    description: z.string().trim().max(600).optional(),
    sql: z.string().min(1).max(50_000),
    params: z.array(ViewParamSchema).max(50).optional(),
    display: ViewDisplaySchema.optional(),
    created_by: z.string().trim().max(120).optional(),
    status: ViewStatusSchema.optional(),
  })
  .openapi('ViewCreate');

export const ViewUpdateBodySchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    slug: ViewSlugSchema.optional(),
    description: z.string().trim().max(600).nullable().optional(),
    sql: z.string().min(1).max(50_000).optional(),
    params: z.array(ViewParamSchema).max(50).optional(),
    display: ViewDisplaySchema.optional(),
    created_by: z.string().trim().max(120).optional(),
    status: ViewStatusSchema.optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), {
    message: 'Supply at least one field to change.',
  })
  .openapi('ViewUpdate');

/**
 * Preview and run take the same inputs, and that is deliberate.
 *
 * Preview must work on a view that has not been saved, so it cannot be `GET
 * /api/views/{id}/preview` — there is no id yet. It also must not be `GET` with
 * the SQL in a query string, because query strings are what ends up in an access
 * log, and the SQL is the one thing in this feature that is worth not spraying
 * across every log in the path.
 */
export const ViewExecuteBodySchema = z
  .object({
    sql: z.string().min(1).max(50_000).openapi({ description: 'The statement to run.' }),
    params: z
      .array(ViewParamSchema)
      .max(50)
      .optional()
      .openapi({ description: 'The declared parameters. Omitted means none are declared.' }),
    values: z
      .record(z.string(), z.union([z.string(), z.number(), z.null()]))
      .optional()
      .openapi({
        description:
          'Values for the declared parameters, keyed by name. A parameter with no default and ' +
          'no value is refused *before* the query runs.',
        example: { period: '2025-01' },
      }),
    display: ViewDisplaySchema.optional().openapi({
      description: 'Applied to the result. Preview is how a display config is tested before it is saved.',
    }),
    /** Preview only: the saved view this draft came from, so runs can be attributed. */
    viewId: z.number().int().optional(),
  })
  .openapi('ViewExecute');

/* ------------------------------------------------------------------------- *
 * Responses
 * ------------------------------------------------------------------------- */

export const ViewColumnSchema = z
  .object({
    key: z.string().openapi({ description: 'The name the query returned, as the database spelled it.' }),
    label: z.string(),
    format: ViewFormatSchema,
    hidden: z.boolean(),
  })
  .openapi('ViewResultColumn');

/** A cell, which may be a string, a number, or nothing — never a sentinel. */
export const ViewCellSchema = z
  .union([z.string(), z.number(), z.null()])
  .openapi({ description: 'A cell. `null` is a real null, not an empty string.' });

export const ViewDriftSchema = z
  .object({
    key: z.string(),
    message: z.string().openapi({
      example: '`net_amount` is hidden because the query no longer returns it.',
    }),
  })
  .openapi('ViewDrift');

export const ViewResultSchema = z
  .object({
    columns: z.array(ViewColumnSchema).openapi({
      description:
        'Columns in display order, with the display config already reconciled against what the ' +
        'query returned.',
    }),
    rows: z.array(z.array(ViewCellSchema)),
    rowCount: z.number().int().openapi({ description: 'Rows in `rows`.' }),
    /** The cap that applied, so the client can say "showing N of" without guessing. */
    limit: z.number().int(),
    truncated: z.boolean().openapi({
      description:
        'The query had more rows than `limit`. Detected by fetching one extra row, not inferred.',
    }),
    /** Findings worth showing next to a result that *did* run. */
    findings: z.array(
      z.object({
        code: z.string(),
        severity: z.enum(['error', 'warning']),
        construct: z.string(),
        message: z.string(),
        fix: z.string().nullable(),
        index: z.number().int(),
      }),
    ),
    drift: z.array(ViewDriftSchema),
  })
  .openapi('ViewResult');

export const ViewRunResponseSchema = z
  .object({
    result: ViewResultSchema,
    /** Wall-clock duration of the statement, in milliseconds. */
    durationMs: z.number().int(),
    /** Present on `POST /api/views/{id}/run`, absent on a preview of an unsaved draft. */
    runId: z.number().int().nullable(),
    viewId: z.number().int().nullable(),
    fingerprint: z.string().nullable().openapi({
      description:
        'Hash of the declared key column over the returned rows. Null when the view declares no ' +
        '`display.fingerprint.key`, because a change cannot be detected without one.',
    }),
    /** What the compiler did with the declared parameters — shown, not assumed. */
    appliedValues: z.record(z.string(), z.union([z.string(), z.number(), z.null()])),
  })
  .openapi('ViewRun');

export const ViewRunsQuerySchema = ListQuerySchema.openapi('ViewRunsQuery');

export const ViewRunRowSchema = z
  .object({
    id: z.number().int(),
    view_id: z.number().int(),
    ran_at: z.string(),
    duration_ms: z.number().int().nullable(),
    row_count: z.number().int().nullable(),
    /**
     * ★ THREE STATES, AND THE COLUMN WOULD BE WORTHLESS WITH TWO.
     *
     * `true` — the query had more rows than the cap, so `row_count` is a floor and
     * the honest reading is "at least this many". `false` — the count is the whole
     * answer. `null` — the run produced no result at all, so there was no count for
     * a cap to have shortened.
     *
     * The distinction being protected is the one between `200` and `200 or more`.
     * Stored as SQLite's `0`/`1`/NULL and converted at the boundary, because a
     * client handed `0` and `null` as two numbers has to know which means which.
     */
    truncated: z.boolean().nullable().openapi({
      description:
        'The run was capped, so `row_count` is a floor rather than a total. `null` when the run ' +
        'produced no result — a failed run has no count to cap.',
    }),
    fingerprint: z.string().nullable(),
    error: z.string().nullable(),
  })
  .openapi('ViewRun');

/** `GET /api/views` — the shared list query plus the one filter views have. */
export const ViewsQuerySchema = ListQuerySchema.extend({
  status: ViewStatusSchema.optional().openapi({ description: 'Filter by status.' }),
}).openapi('ViewsQuery');

/* ------------------------------------------------------------------------- *
 * Watches — one person's subscriptions, read as rows rather than as records
 * ------------------------------------------------------------------------- */

/**
 * The query behind `GET /api/views/subscriptions`.
 *
 * ★ A REQUIRED `subscriber`, AND NOT READ FROM A SESSION. No route under
 *   `/api/views` authenticates, so the server has no way to know who is asking;
 *   taking the owner as a parameter says that plainly instead of implying a check
 *   that does not exist. The page does not ask the reader either — it sends
 *   `currentOwner()` and *shows* what it sent, so the number on the screen and the
 *   name in the request cannot disagree. §13.
 */
export const ViewWatchQuerySchema = z
  .object({
    subscriber: z.string().trim().min(1).max(200).openapi({
      description: 'Whose subscriptions to return. Not authenticated — see the route description.',
      example: 'A. Reader',
    }),
  })
  .openapi('ViewWatchQuery');

/**
 * One row of the Saved Views page.
 *
 * ★ THIS IS A JOIN, NOT A SUBSCRIPTION WITH EXTRA FIELDS, AND THE DIFFERENCE IS
 *   THE POINT. The page's subject is not "a subscription" — it is "this view, as
 *   I am watching it", which needs the view's name, the count when the watch
 *   began, the count now, and when it last actually changed. Returning the bare
 *   `saved_view_subscription` row would make the client fetch four other things
 *   per row to draw one line of a table.
 */
export const ViewWatchSchema = z
  .object({
    /** `saved_view_subscription.id` — what the Delete button sends. */
    subscription_id: z.number().int(),
    subscriber: z.string(),
    channel: z.enum(['in_app', 'webhook']),
    /** When the watch was created. Also the moment "rows when subscribed" is from. */
    subscribed_at: z.string(),

    view_id: z.number().int(),
    slug: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    status: ViewStatusSchema,

    /**
     * `display.fingerprint.key`, or null when the view declares none.
     *
     * Shown rather than hidden: a view with no key column cannot be watched for
     * changes at all — there is nothing to compare between runs — and a row that
     * silently reported "no change ever" would be reporting a property of the
     * absence of a key as if it were a property of the data.
     */
    fingerprint_key: z.string().nullable(),

    /**
     * The newest run **that produced a result**, and its count and cap flag.
     *
     * ★ `current_ran_at` IS NOT "THE LAST TIME ANYTHING HAPPENED", AND THE PAIR
     *   `last_ran_at` / `last_error` IS WHAT COVERS THAT. These three fields describe
     *   the last time this view *worked*; a failed attempt is newer information that
     *   does not supersede the figure here, because a run that did not finish has no
     *   count to replace it with. Taking the newest run of any kind instead would
     *   blank the count on the first failure and leave the page unable to say what
     *   the view last found.
     */
    current_ran_at: z.string().nullable(),
    current_count: z.number().int().nullable(),
    current_truncated: z.boolean().nullable(),

    /**
     * The newest run's fingerprint — null when the run failed, and also null when
     * it *succeeded* but the query no longer returns `fingerprint_key`.
     *
     * ★ THAT SECOND NULL IS THE ONLY EVIDENCE OF DRIFT, AND IT IS WHY THIS FIELD IS
     *   PUBLIC. A view whose statement stopped selecting the key column records no
     *   error — `fingerprint()` returns null and the run is otherwise fine — so a
     *   row carrying only `last_error` would present a view whose change
     *   detection has quietly stopped working as one that simply has not changed.
     *   The page reads `current_ran_at` set + `last_error` null +
     *   `current_fingerprint` null + `fingerprint_key` set as `Cannot watch`.
     */
    current_fingerprint: z.string().nullable(),

    /** When the newest attempt ran, whether it succeeded or not. */
    last_ran_at: z.string().nullable(),

    /**
     * Why the newest attempt failed, or null when it did not.
     *
     * ★ NON-NULL MEANS THE LAST ATTEMPT FAILED — `recordRun` writes null here for a
     *   run that finished, and the row it writes for one that did not carries null
     *   counts and this message. So this field is also the flag that says the
     *   `current_*` figures above are from an older run than `last_ran_at`.
     */
    last_error: z.string().nullable(),

    /**
     * The newest result at or before `subscribed_at` — the baseline, and its cap flag.
     *
     * ★ `subscribed_truncated` IS NOT DECORATION: IT IS THE OTHER HALF OF THE
     *   COMPARISON THIS SCREEN EXISTS TO MAKE. The two counts on a row are read side
     *   by side, so a baseline that reached the cap has to be labelled a floor
     *   exactly as `current_truncated` labels the current one. Two runs that both
     *   stopped at the cap hold the *same* number — leaving only one of them marked
     *   would print `200` beside `200+` and read as *nothing has changed* about a
     *   view that has been growing the entire time.
     */
    subscribed_ran_at: z.string().nullable(),
    subscribed_count: z.number().int().nullable(),
    subscribed_truncated: z.boolean().nullable(),

    /**
     * The most recent run whose fingerprint differed from the run before it.
     *
     * ★ COMPUTED HERE RATHER THAN BY THE CLIENT, because "the run before it" is a
     *   question about the sequence and a client holding two endpoints' worth of
     *   history would have to reconstruct it. Null means this view has never
     *   changed *within its history* — which is a different sentence from "it has
     *   not changed since you subscribed", and the page says both.
     */
    last_change_at: z.string().nullable(),
  })
  .openapi('ViewWatch');

/* ------------------------------------------------------------------------- *
 * Types
 * ------------------------------------------------------------------------- */

export type ViewParam = z.infer<typeof ViewParamSchema>;
export type ViewDisplay = z.infer<typeof ViewDisplaySchema>;
export type ViewFormat = z.infer<typeof ViewFormatSchema>;
export type ViewStatus = z.infer<typeof ViewStatusSchema>;
export type ViewCreateBody = z.infer<typeof ViewCreateBodySchema>;
export type ViewUpdateBody = z.infer<typeof ViewUpdateBodySchema>;
export type ViewExecuteBody = z.infer<typeof ViewExecuteBodySchema>;
export type ViewRunRow = z.infer<typeof ViewRunRowSchema>;
export type ViewWatch = z.infer<typeof ViewWatchSchema>;
export type ViewWatchQuery = z.infer<typeof ViewWatchQuerySchema>;
