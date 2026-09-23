import { z } from '../http/z.js';
import type { Api } from '../http/api.js';
import { AppError } from '../http/errors.js';
import { execute, one, rows } from '../db/sql.js';
import { requireAppSchema } from '../db/app-schema.js';
import { requireSuperAdmin } from '../auth/guard.js';
import {
  applyReadCap,
  capReadRows,
  forgetReadCap,
  ledgerDialect,
  orderByFragment,
} from '../db/read-cap.js';
import { defaultReadFor } from '../db/ledger-defaults.js';

/**
 * Read caps: how many rows this app reads from a ledger object, and in what order.
 *
 * ---------------------------------------------------------------------------
 * WHAT A READ CAP IS
 * ---------------------------------------------------------------------------
 * One row per ledger object says "read at most N rows, and take them in this
 * order". It exists because the EBS instance holds tables in the hundreds of
 * millions of rows — `GL_BALANCES` is 157 M, the AP surface 1.2 M checks — and a
 * register that reads one of those whole is not slow, it is a request that never
 * returns. The bound is a stored row rather than a constant so it can be changed
 * by whoever operates the deployment, without a redeploy, as the instance grows.
 *
 * ---------------------------------------------------------------------------
 * ★ THE PREVIEW IS THE POINT OF THE SCREEN, AND IT IS WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * A cap is a number in a box, and a number in a box is not checkable. The panel
 * that edits one runs the statement it is about to save and shows the first rows
 * back, so an administrator sees what the window actually contains — which
 * columns, which dates, whether the ordering puts the rows they expect at the
 * top — before saving it. Without that, "100,000 rows ordered by INVOICE_DATE
 * DESC" is a claim; with it, it is a thing that was looked at.
 *
 * ★ THE PREVIEW IS BOUNDED TWICE, AND BOTH BOUNDS ARE STATED IN THE RESPONSE.
 *   The preview asks for at most `PREVIEW_ROWS` (50) rows regardless of the cap,
 *   because a panel cannot show 100,000 and should not try. It also runs through
 *   the *draft* cap, so the administrator sees the effect of the number they are
 *   typing rather than of the number currently stored. The response carries both
 *   the cap that was applied and whether the result was cut, so the panel can say
 *   "showing 50 of the first 100,000" rather than "showing 50".
 *
 * ---------------------------------------------------------------------------
 * ★ THE DIALECT IS REPORTED, NOT ASSUMED
 * ---------------------------------------------------------------------------
 * Oracle spells a row bound `FETCH FIRST n ROWS ONLY` / the nested `ROWNUM` form;
 * SQLite spells it `LIMIT n`. The preview response carries the dialect it ran in
 * and the statement it actually executed, so an administrator can see which form
 * their deployment used — and so a bug report about a cap includes the SQL that
 * was run rather than a description of it.
 *
 * ---------------------------------------------------------------------------
 * WHO MAY CHANGE ONE
 * ---------------------------------------------------------------------------
 * Reading the register needs a session; changing one needs `super_admin`. Same
 * split as the organization register, enforced by `requireSuperAdmin` inside the
 * handler so the refusal is answered where the question is asked.
 */

/** The row, as the client stores it. */
const ReadCapSchema = z
  .object({
    tableName: z.string(),
    sql: z.string().nullable(),
    maxRows: z.number().int().nullable(),
    orderBy: z.string().nullable(),
    note: z.string().nullable(),
    setBy: z.string().nullable(),
    setAt: z.string().nullable(),
    /** True when a cap is in force. Derived, so a reader does not re-derive it. */
    capped: z.boolean(),
    /**
     * The statement the app reads when no cap row stores one, from the registry.
     *
     * ★ IT IS NOT A CAP AND IT IS NOT STORED. It is what a fresh deployment reads
     *   and what the panel offers as the starting point for a draft, so a reader
     *   meets a real statement rather than an empty box. Null means nobody has
     *   decided what this object should read, which the panel says in words.
     */
    defaultSql: z.string().nullable(),
    /** The ordering the default is taken in, offered as the `orderBy` starting value. */
    defaultOrderBy: z.string().nullable(),
    /** Why the default reads what it reads, shown beside the field. */
    defaultNote: z.string().nullable(),
  })
  .openapi('LedgerReadCap');

const ReadCapListSchema = z
  .object({
    items: z.array(ReadCapSchema),
    /** The dialect a cap will be applied in on this deployment. */
    dialect: z.enum(['sqlite', 'oracle']),
    /** The ledger objects the registry knows about, whether or not they have a row. */
    knownTables: z.array(z.string()),
    counts: z.object({
      total: z.number().int(),
      capped: z.number().int(),
    }),
  })
  .openapi('LedgerReadCapList');

const PreviewSchema = z
  .object({
    tableName: z.string(),
    /** The statement that was executed, cap and ordering included. */
    statement: z.string(),
    dialect: z.enum(['sqlite', 'oracle']),
    /** The cap the draft asked for, or null when the draft is uncapped. */
    maxRows: z.number().int().nullable(),
    /** The ordering the window was taken in, or null when uncapped. */
    orderBy: z.string().nullable(),
    /** How many rows the preview asked for — a panel-sized bound, not the cap. */
    previewRows: z.number().int(),
    /** The columns the statement returned, in order. */
    columns: z.array(z.string()),
    /** The rows, at most `previewRows` of them. */
    rows: z.array(z.record(z.unknown())),
    /** How many rows came back before the preview bound was applied. */
    returned: z.number().int(),
    /** True when the statement produced more rows than the preview shows. */
    truncated: z.boolean(),
    /** Milliseconds the statement took, so a slow cap is visible before it is saved. */
    ms: z.number().int(),
  })
  .openapi('LedgerReadCapPreview');

/** How many rows the preview panel shows. A panel cannot render 100,000. */
const PREVIEW_ROWS = 50;

/** A row as the database holds it. */
interface CapDbRow {
  table_name: string;
  sql: string | null;
  max_rows: number | null;
  order_by: string | null;
  note: string | null;
  set_by: string | null;
  set_at: string | null;
}

function toWire(row: CapDbRow) {
  const declared = defaultReadFor(row.table_name);
  return {
    tableName: row.table_name,
    sql: row.sql,
    maxRows: row.max_rows === null ? null : Number(row.max_rows),
    orderBy: row.order_by,
    note: row.note,
    setBy: row.set_by,
    setAt: row.set_at,
    capped: row.max_rows !== null && row.max_rows !== undefined,
    defaultSql: declared?.sql ?? null,
    defaultOrderBy: declared?.orderBy ?? null,
    defaultNote: declared?.note ?? null,
  };
}

/**
 * The ledger objects the registry knows about.
 *
 * ★ THE LIST IS THE REGISTRY'S, NOT A SECOND COPY. `tablesOfClass('ledger')` is
 *   what routing uses to decide a statement reads the ledger, so offering exactly
 *   those names in the panel means a cap can only be written for an object the app
 *   can actually read. A hand-written list here would be a fourth copy of the
 *   registry and would drift the same way the app-table lists did — see the ★ block
 *   on `ROUTING_APP_TABLES`, which is the note that cost this project a table.
 */
async function knownLedgerTables(): Promise<string[]> {
  const { tablesOfClass } = await import('../db/store.js');
  return tablesOfClass('EBS')
    .filter((t) => t !== 'DUAL')
    .sort();
}

export function registerReadCaps(api: Api): void {
  api.route({
    method: 'get',
    path: '/api/read-caps',
    operationId: 'readCapsList',
    summary: 'The per-object row caps, and the objects that could have one',
    description:
      'One row per ledger object this deployment has decided to bound, plus the full list of ' +
      'objects a cap could be written for. An object with no row is **uncapped**, which is the ' +
      'default: adding the table changes no behaviour until a row is written.\n\n' +
      '★ `orderBy` IS REQUIRED WHENEVER `maxRows` IS SET. A cap with no ordering returns ' +
      'whichever rows the database reaches first, so every count and total computed from it ' +
      'would describe an arbitrary subset while looking correct. The write path refuses that ' +
      'combination rather than storing it.\n\n' +
      '★ `dialect` IS THE ONE THIS DEPLOYMENT WILL APPLY THE CAP IN — Oracle spells a bound ' +
      '`FETCH FIRST n ROWS ONLY` (or the nested `ROWNUM` form), SQLite spells it `LIMIT n`. ' +
      'The stored SQL carries no bound; it is appended per dialect at read time.',
    tags: ['Admin'],
    response: ReadCapListSchema,
    errors: [500, 503],
    handler: async () => {
      await requireAppSchema();
      const stored = await rows<CapDbRow>(
        `SELECT table_name, sql, max_rows, order_by, note, set_by, set_at
           FROM ledger_read_cap
          ORDER BY table_name`,
      );
      const known = await knownLedgerTables();

      // ★ EVERY KNOWN OBJECT GETS A ROW, CAPPED OR NOT — AND THAT IS A FIX, NOT A
      //   CONVENIENCE. The first version returned `items` for stored rows only and
      //   `knownTables` as bare strings, so the client had to *synthesise* a row for
      //   an object with no cap — and a synthesised row cannot carry the declared
      //   default, because the client does not have the registry. The panel then
      //   opened with an empty statement for every object nobody had capped yet,
      //   which is every object on a fresh store. The defaults live on the server, so
      //   the row that carries them has to come from the server.
      const byName = new Map(stored.map((r) => [r.table_name.toUpperCase(), r]));
      const items = known.map((name) => {
        const row = byName.get(name.toUpperCase());
        if (row) return toWire(row);
        // An object with no stored row: uncapped, with its default if one is declared.
        const declared = defaultReadFor(name);
        return {
          tableName: name,
          sql: null,
          maxRows: null,
          orderBy: null,
          note: null,
          setBy: null,
          setAt: null,
          capped: false,
          defaultSql: declared?.sql ?? null,
          defaultOrderBy: declared?.orderBy ?? null,
          defaultNote: declared?.note ?? null,
        };
      });

      return {
        items,
        dialect: ledgerDialect(),
        knownTables: known,
        counts: {
          // ★ `capped` COUNTS THE CAPS, NOT THE ROWS. Every object has a row now, so
          //   `items.length` is the registry's size and says nothing about how many
          //   are bounded — the head line needs the second number.
          total: items.filter((i) => i.capped).length,
          capped: items.filter((i) => i.capped).length,
        },
      };
    },
  });

  api.route({
    method: 'get',
    path: '/api/read-caps/{table}',
    operationId: 'readCapGet',
    summary: 'One object\'s read cap',
    description:
      'The cap for one ledger object, or a row describing it as uncapped when none is stored. ' +
      'An object with no row is not a 404: the object exists and is readable, it simply has no ' +
      'bound, and answering 404 would say the object is missing.',
    tags: ['Admin'],
    params: z.object({ table: z.string().min(1) }),
    response: ReadCapSchema,
    errors: [400, 404, 500, 503],
    handler: async ({ params }) => {
      await requireAppSchema();
      const found = await one<CapDbRow>(
        `SELECT table_name, sql, max_rows, order_by, note, set_by, set_at
           FROM ledger_read_cap
          WHERE table_name = :name COLLATE NOCASE
          LIMIT 1`,
        { name: params.table },
      );
      if (found) return toWire(found);
      const declared = defaultReadFor(params.table);
      return {
        tableName: params.table,
        sql: null,
        maxRows: null,
        orderBy: null,
        note: null,
        setBy: null,
        setAt: null,
        capped: false,
        defaultSql: declared?.sql ?? null,
        defaultOrderBy: declared?.orderBy ?? null,
        defaultNote: declared?.note ?? null,
      };
    },
  });

  api.route({
    method: 'put',
    path: '/api/read-caps/{table}',
    operationId: 'readCapPut',
    summary: 'Set or clear one object\'s read cap',
    description:
      'Writes the cap for one ledger object, or clears it. The whole row is sent, matching the ' +
      'organization register\'s PATCH convention in reverse: a cap is a small, whole object and ' +
      'a partial update of it would be a way to leave a limit in place while removing the ' +
      'ordering that makes it honest.\n\n' +
      '★ **A LIMIT WITH NO ORDERING IS REFUSED.** `maxRows` set with a blank `orderBy` is a 400, ' +
      'not a stored row — see the list endpoint. Clearing both is how an object becomes uncapped.\n\n' +
      '★ **THE ORDERING IS CHECKED AGAINST THE STATEMENT.** `orderBy` is interpolated into the ' +
      'SQL, so each token must be a plain column name (optionally ` ASC`/` DESC`) that appears ' +
      'in the statement it will window. A function call, an expression or an unknown column is ' +
      'refused with the token named.',
    tags: ['Admin'],
    params: z.object({ table: z.string().min(1) }),
    body: z.object({
      sql: z.string().nullable().optional(),
      maxRows: z.number().int().nullable().optional(),
      orderBy: z.string().nullable().optional(),
      note: z.string().nullable().optional(),
    }),
    response: ReadCapSchema,
    errors: [400, 403, 500, 503],
    handler: async ({ params, body, req }) => {
      const actor = await requireSuperAdmin(req);
      await requireAppSchema();

      const table = params.table.trim();
      if (table === '') throw AppError.badRequest('The object name is blank.', { table: params.table });

      const sql = body.sql?.trim() ? body.sql.trim() : null;
      const orderBy = body.orderBy?.trim() ? body.orderBy.trim() : null;
      const note = body.note?.trim() ? body.note.trim() : null;
      const maxRows = body.maxRows === undefined || body.maxRows === null ? null : Number(body.maxRows);

      // ★ THE ORDERING FALLS BACK TO THE DECLARED DEFAULT, SO THE SAME DRAFT IS
      //   LEGAL FROM THE PANEL AND FROM A DIRECT CALL. The panel pre-fills the
      //   ordering field from the default, so a client sending a limit and no
      //   ordering means "the default ordering" — and refusing that here would make
      //   the rule depend on which caller asked rather than on the data.
      const declared = defaultReadFor(table);
      const effectiveOrder = orderBy ?? declared?.orderBy ?? null;

      if (maxRows !== null) {
        if (!Number.isFinite(maxRows) || maxRows <= 0) {
          throw AppError.badRequest(
            `maxRows must be a positive whole number, or null to leave the object uncapped. ` +
              `Received ${String(body.maxRows)}.`,
            { maxRows: body.maxRows },
          );
        }
        if (effectiveOrder === null) {
          throw AppError.badRequest(
            `A cap of ${maxRows} rows needs an ordering, and this object has no default ordering ` +
              'to fall back on. Without one the database returns whichever rows it reaches first, ' +
              'so every count and total computed from the capped read would describe an arbitrary ' +
              'subset while looking correct. Set orderBy (for example "INVOICE_DATE DESC"), or ' +
              'clear maxRows to leave the object uncapped.',
            { table, maxRows },
          );
        }
        // ★ VALIDATED NOW, NOT AT READ TIME. The ordering is checked against the
        //   statement it will window, so a token that cannot be used is refused
        //   while the administrator is looking at the form rather than surfacing
        //   later as a failed ledger read on somebody else's screen.
        const basis = sql ?? declared?.sql ?? '';
        if (basis !== '') orderByFragment(effectiveOrder, basis);
      }

      const now = new Date().toISOString().replace('T', ' ').slice(0, 19);

      await execute(
        `INSERT INTO ledger_read_cap (table_name, sql, max_rows, order_by, note, set_by, set_at)
              VALUES (:table, :sql, :maxRows, :orderBy, :note, :setBy, :setAt)
         ON CONFLICT (table_name) DO UPDATE SET
              sql = excluded.sql,
              max_rows = excluded.max_rows,
              order_by = excluded.order_by,
              note = excluded.note,
              set_by = excluded.set_by,
              set_at = excluded.set_at`,
        {
          table,
          sql,
          maxRows,
          // ★ THE EFFECTIVE ORDERING IS WHAT GETS STORED, NOT THE BLANK THAT WAS SENT.
          //   A row holding a limit and no ordering is the one shape the read path
          //   refuses, so storing the fallback keeps the row self-describing: whoever
          //   reads it back sees the window it actually uses rather than a null that
          //   only works because a default happens to exist today. Change the default
          //   later and this row keeps its own answer.
          orderBy: maxRows === null ? orderBy : effectiveOrder,
          note,
          setBy: actor.name,
          setAt: now,
        },
      );

      // ★ THE CACHE IS DROPPED SO THE SAVE TAKES EFFECT AT ONCE. Without this the
      //   next ledger read on this process would use the cap as it was when the
      //   object was first read, and the administrator would save a change, watch
      //   the preview agree with it, and then see the register behave as before.
      forgetReadCap(table);

      const saved = await one<CapDbRow>(
        `SELECT table_name, sql, max_rows, order_by, note, set_by, set_at
           FROM ledger_read_cap
          WHERE table_name = :name COLLATE NOCASE
          LIMIT 1`,
        { name: table },
      );
      if (!saved) {
        throw AppError.dbUnavailable(
          `The read cap for ${table} was written but could not be read back.`,
          { table },
        );
      }
      return toWire(saved);
    },
  });

  api.route({
    method: 'delete',
    path: '/api/read-caps/{table}',
    operationId: 'readCapDelete',
    summary: 'Remove one object\'s read cap',
    description:
      'Deletes the row, leaving the object uncapped. This is the same end state as a `PUT` with ' +
      '`maxRows: null`, and it exists separately because "stop bounding this" and "bound it ' +
      'differently" are different intentions and one of them should not require sending a body.',
    tags: ['Admin'],
    params: z.object({ table: z.string().min(1) }),
    response: z.object({ tableName: z.string(), removed: z.boolean() }).openapi('LedgerReadCapRemoved'),
    // ★ 200, NOT THE 204 A DELETE DEFAULTS TO. This route returns a result — whether
    //   a row was actually removed — and a 204 discards it, so the client would have
    //   to assume the outcome. `removed: false` is a real answer for a row that was
    //   already gone, and the panel says which happened.
    status: 200,
    errors: [403, 500, 503],
    handler: async ({ params, req }) => {
      await requireSuperAdmin(req);
      await requireAppSchema();
      const table = params.table.trim();
      const result = await execute(`DELETE FROM ledger_read_cap WHERE table_name = :name COLLATE NOCASE`, {
        name: table,
      });
      forgetReadCap(table);
      return { tableName: table, removed: result.rowsAffected > 0 };
    },
  });

  api.route({
    method: 'post',
    path: '/api/read-caps/{table}/preview',
    operationId: 'readCapPreview',
    summary: 'Run a draft cap and show the first rows it returns',
    description:
      'Executes the statement with the **draft** cap and ordering applied, and returns at most ' +
      `${PREVIEW_ROWS} rows. This is what makes a cap checkable: the administrator sees which ` +
      'rows the window contains — which columns, which dates, whether the ordering puts what ' +
      'they expect at the top — before saving it.\n\n' +
      '★ **THE PREVIEW IS BOUNDED TWICE AND BOTH BOUNDS ARE REPORTED.** It runs through the ' +
      'draft cap (so the number being typed has a visible effect) and then shows at most ' +
      `${PREVIEW_ROWS} rows (because a panel cannot render 100,000). ` +
      '`maxRows` is the first bound, `previewRows` the second, and `truncated` says whether ' +
      'the statement produced more than the preview shows.\n\n' +
      '★ **THE STATEMENT IS RETURNED.** A cap that misbehaves should be diagnosable from the ' +
      'response alone, so the exact SQL that ran — cap and ordering included, in this ' +
      "deployment's dialect — comes back with the rows.",
    tags: ['Admin'],
    params: z.object({ table: z.string().min(1) }),
    body: z.object({
      sql: z.string().nullable().optional(),
      maxRows: z.number().int().nullable().optional(),
      orderBy: z.string().nullable().optional(),
    }),
    response: PreviewSchema,
    // ★ 200, NOT THE 201 A POST DEFAULTS TO. A preview creates nothing — it runs a
    //   draft statement and reports what came back. A 201 would tell a client a
    //   resource was created at a URL, and there is no such URL.
    status: 200,
    errors: [400, 403, 500, 503],
    handler: async ({ params, body, req }) => {
      await requireSuperAdmin(req);

      const table = params.table.trim();
      const sql = body.sql?.trim() ? body.sql.trim() : null;
      const orderBy = body.orderBy?.trim() ? body.orderBy.trim() : null;
      const maxRows = body.maxRows === undefined || body.maxRows === null ? null : Number(body.maxRows);

      // ★ THE PREVIEW FALLS BACK TO THE DECLARED DEFAULT, so the panel can preview
      //   an object nobody has written a cap for — which is the common first visit.
      //   A preview with nothing to run would be the empty box this feature exists
      //   to replace.
      const declared = defaultReadFor(table);
      const statement = sql ?? declared?.sql ?? null;

      if (statement === null) {
        throw AppError.badRequest(
          'A preview needs a statement to run, and this object has no default. Supply `sql` — ' +
            'the preview runs the draft, not the stored row, so it cannot fall back to what ' +
            'is already saved.',
          { table },
        );
      }

      if (maxRows !== null && (!Number.isFinite(maxRows) || maxRows <= 0)) {
        throw AppError.badRequest(
          `maxRows must be a positive whole number, or null to preview the statement uncapped. ` +
            `Received ${String(body.maxRows)}.`,
          { maxRows: body.maxRows },
        );
      }

      // ★ THE ORDERING FALLS BACK TO THE DEFAULT'S, AND THE CHECK COMES AFTER THAT
      //   FALLBACK — NOT BEFORE IT. The panel pre-fills the ordering field from the
      //   default, so a draft arriving with a limit and no ordering means "the
      //   default ordering, please". Refusing it before consulting the default would
      //   make the same request legal from the panel and illegal from a direct call,
      //   which is a rule that depends on the caller rather than on the data.
      const effectiveOrder = orderBy ?? declared?.orderBy ?? null;

      if (maxRows !== null && effectiveOrder === null) {
        throw AppError.badRequest(
          `A cap of ${maxRows} rows needs an ordering, and this object has no default ordering ` +
            'to fall back on. Without one the database returns whichever rows it reaches first, ' +
            'so every count and total computed from the capped read would describe an arbitrary ' +
            'subset while looking correct. Set orderBy (for example "INVOICE_DATE DESC"), or ' +
            'clear maxRows to read the object uncapped.',
          { table, maxRows },
        );
      }

      const dialect = ledgerDialect();

      // ★ THE PREVIEW CAPS AT `PREVIEW_ROWS`, NOT AT THE DRAFT CAP. Asking the
      //   database for 100,000 rows to show 50 would make the panel as slow as the
      //   thing it is meant to make fast. The draft cap still applies — it is the
      //   *smaller* of the two that wins — so a draft of 10 shows 10 and a draft of
      //   100,000 shows 50.
      const effective = maxRows === null ? PREVIEW_ROWS : Math.min(maxRows, PREVIEW_ROWS);

      // ★ THE DRAFT IS BUILT DIRECTLY, NOT RESOLVED THROUGH THE STORED ROW. The
      //   preview answers "what would this form do", so it must not consult
      //   `ledger_read_cap` at all — a stored cap would leak into a draft that is
      //   about to replace it, and the panel would show the old window while the
      //   administrator edits the new one.
      const built =
        effectiveOrder === null
          ? statement
          : applyReadCap(statement, effective, orderByFragment(effectiveOrder, statement), dialect);

      const started = Date.now();
      let raw: Record<string, unknown>[];
      try {
        raw = await rows<Record<string, unknown>>(built);
      } catch (err: unknown) {
        // ★ A BROKEN DRAFT IS THE PREVIEW'S JOB TO REPORT, NOT A 500. The whole
        //   point of the panel is to try a statement before saving it, so a
        //   statement that does not run has to come back as a readable refusal
        //   naming the driver's own words — the same reasoning `saved_view_run.error`
        //   records an error unstripped.
        throw AppError.badRequest(
          `The statement did not run: ${err instanceof Error ? err.message : String(err)}`,
          { table, statement: built },
        );
      }
      const ms = Date.now() - started;

      const columns = raw.length > 0 ? Object.keys(raw[0]!) : [];
      const { rows: shown, truncated } = capReadRows(raw, PREVIEW_ROWS);

      return {
        tableName: table,
        // ★ THE STATEMENT REPORTED IS THE ONE THAT RAN, not the one that was sent.
        //   The default's ordering may have been applied, and a reader diagnosing a
        //   surprising result needs the SQL the database actually saw.
        statement: built,
        dialect,
        maxRows,
        orderBy: effectiveOrder,
        previewRows: PREVIEW_ROWS,
        columns,
        rows: shown,
        returned: raw.length,
        truncated,
        ms,
      };
    },
  });
}
