/**
 * The data dictionary — the client half of `GET /api/meta/dictionary`.
 *
 * ★ WHAT THIS IS FOR: THE SCHEMA TAB OF THE ACTIVITY PANEL. The Activity register
 *   lists every object with a row count; this module answers the *other* question a
 *   reader has about an object — what columns does it actually have. The two are
 *   different questions and they come from different endpoints, which is why this
 *   is a file of its own rather than another field on `ActivityTable`.
 *
 * ★ THE DICTIONARY IS READ FROM `sqlite_master`, SO IT DESCRIBES THE APP STORE.
 *   That is the server's own documented position (`routes/meta.ts`): `sqlite_master`
 *   is a SQLite catalogue, and the app store is the only store guaranteed to be one.
 *   So for a **ledger** object this lists the columns the *sample* declares, which
 *   is the sample's projection of the extract — not Oracle's 213-column shape.
 *   The panel must say so rather than implying it read the live ledger, because the
 *   two disagree for exactly the objects a reader is most likely to look up
 *   (`PO_HEADERS_ALL` is 13 columns here and 213 on Oracle).
 *
 * ★ A COLUMN'S `declaredType` CAN BE AN EMPTY STRING, AND THAT IS NOT A MISSING
 *   FIELD. SQLite is dynamically typed and `sqlite_master` records the declared type
 *   verbatim, so a table created without one reports `''`. Measured on this
 *   deployment: `DUAL`'s two columns both report `''`. So the type cell must render
 *   an explicit "no declared type" rather than an empty cell, which would read as a
 *   parse failure — the same distinction as `rowCount: null` versus `0`.
 *
 * ★ AND THE RESPONSE IS A BARE ARRAY, NOT AN ENVELOPE WITH `items`. Measured:
 *   `{"data":[…]}`. Several other list endpoints in this app wrap their rows in
 *   `{items, meta}`; this one does not, and assuming otherwise yields an empty
 *   list rather than an error — the failure mode that looks like "this table has
 *   no columns".
 */

/** One column, as `pragma_table_info` reports it. */
export interface DictionaryColumn {
  /** Position in the table, 0-based. The server's own field name. */
  ordinal: number;
  name: string;
  /**
   * The type as declared in the DDL, or `''` when none was declared.
   *
   * ★ `''` IS A REAL ANSWER, NOT AN ABSENCE. See the module note: SQLite records the
   *   declared type verbatim and a table may have none.
   */
  declaredType: string;
  notNull: boolean;
  /** The DDL default, or `null` when the column has none. */
  defaultValue: string | null;
  primaryKey: boolean;
}

/** One object in the dictionary. */
export interface DictionaryObject {
  name: string;
  type: 'table' | 'view';
  /** Only populated when `counts=true` was asked for; never requested here. */
  rowCount: number | null;
  columns: DictionaryColumn[];
}

/** How the read is going. Same four-case union the rest of the app uses. */
export type DictionaryState =
  | { status: 'loading' }
  | { status: 'ready'; objects: DictionaryObject[] }
  | { status: 'failed'; message: string };

const API = '/api/meta/dictionary';

/**
 * Narrow one column, or `null` when it is not the documented shape.
 *
 * ★ `declaredType` IS ACCEPTED AS `''` AND REJECTED AS ANYTHING ELSE NON-STRING.
 *   The empty string is the measured answer for a column with no declared type, so
 *   a check that required a non-empty string would drop real columns — and dropping
 *   them silently is how a schema tab would show a table as having fewer columns
 *   than it does.
 */
function asColumn(raw: unknown): DictionaryColumn | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  if (typeof c.ordinal !== 'number' || !Number.isInteger(c.ordinal)) return null;
  if (typeof c.name !== 'string' || c.name === '') return null;
  if (typeof c.declaredType !== 'string') return null;
  if (typeof c.notNull !== 'boolean') return null;
  if (typeof c.primaryKey !== 'boolean') return null;
  const defaultValue = c.defaultValue === null || typeof c.defaultValue === 'string' ? c.defaultValue : null;
  return {
    ordinal: c.ordinal,
    name: c.name,
    declaredType: c.declaredType,
    notNull: c.notNull,
    defaultValue,
    primaryKey: c.primaryKey,
  };
}

function asObject(raw: unknown): DictionaryObject | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== 'string' || o.name === '') return null;
  if (o.type !== 'table' && o.type !== 'view') return null;
  if (!Array.isArray(o.columns)) return null;
  const columns: DictionaryColumn[] = [];
  for (const item of o.columns) {
    const column = asColumn(item);
    if (column === null) return null;
    columns.push(column);
  }
  const rowCount = typeof o.rowCount === 'number' && Number.isInteger(o.rowCount) ? o.rowCount : null;
  return { name: o.name, type: o.type, rowCount, columns };
}

/**
 * The whole dictionary, or `null` when the body is not the documented shape.
 *
 * ★ THE WHOLE DICTIONARY IS FETCHED ONCE AND INDEXED BY NAME, rather than a request
 *   per object. The endpoint has no per-object route, and a panel that fetched on
 *   every open would pay a round trip per click for data that does not change
 *   between clicks. The response is ~54 objects for this deployment, which is small
 *   enough to hold for the life of the page.
 */
export function parseDictionary(body: unknown): DictionaryObject[] | null {
  if (!body || typeof body !== 'object') return null;
  const { data } = body as { data?: unknown };
  if (!Array.isArray(data)) return null;
  const objects: DictionaryObject[] = [];
  for (const item of data) {
    const object = asObject(item);
    if (object === null) return null;
    objects.push(object);
  }
  return objects;
}

/**
 * Read the dictionary once, on mount.
 *
 * ★ THE FAILURE IS A STATE, NOT A THROW, AND THE PANEL STILL RENDERS. The Schema tab
 *   is a *second* tab on a panel whose first tab is the reason the reader opened it;
 *   a dictionary that cannot be read must not take the Details tab down with it. So
 *   this returns a union the caller draws from, and the caller shows the failure
 *   inside the Schema tab only.
 *
 * ★ NO CACHE AND NO RETRY, for the same reason `ledgerSummary` has none: the
 *   dictionary is a fact about the schema, it is cheap, and a remembered copy is the
 *   thing that would go stale without saying so. The cost is one request per mount,
 *   which is one per panel open.
 *
 * ★ AND NO TIMEOUT, DELIBERATELY. This endpoint does not count rows (`counts` is not
 *   sent), so it is a catalogue read — measured in tens of milliseconds. A deadline
 *   here would be a deadline that never fires, and the state it produced would be
 *   indistinguishable from a real failure.
 */
export async function loadDictionary(signal: AbortSignal): Promise<DictionaryState> {
  try {
    const res = await fetch(API, { signal, headers: { accept: 'application/json' } });
    if (!res.ok) {
      return { status: 'failed', message: `HTTP ${res.status} ${res.statusText}` };
    }
    const objects = parseDictionary((await res.json()) as unknown);
    if (objects === null) {
      return { status: 'failed', message: 'the response was not a data dictionary' };
    }
    return { status: 'ready', objects };
  } catch (err: unknown) {
    // ★ AN UNMOUNT IS NOT A FAILURE. The abort fires on cleanup, and a reader who
    //   closed the panel must not be shown an error for it.
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { status: 'loading' };
    }
    return { status: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}
