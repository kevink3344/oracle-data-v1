import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import ViewResultGrid, {
  NUMERIC_FORMATS,
  VIEW_FORMATS,
  type Cell,
  type ResultColumn,
  type ViewFormat,
  type ViewResult,
} from '../components/ViewResultGrid';
import { viewBlockers, type ViewBlocker } from '../data/savedViews';
import { pluralise } from '../data/format';

/**
 * `Administration › View builder` — the screen from §10 of
 * `docs/plans/view-builder.md`.
 *
 * WHAT THIS SCREEN IS, AND IS NOT
 *   A saved view is three things bolted together: **trusted SQL**, a **declared
 *   parameter list**, and a **display configuration**. This screen edits all
 *   three and runs the result. It is deliberately *not* a drag-and-drop query
 *   generator — §16 puts that out of scope, and §2 explains why: the question
 *   this feature exists to answer (first fundings per account) has no form in
 *   this schema that a builder could offer, so a generator would be a worse
 *   editor for the one query it was built for.
 *
 * WHY THE EDITOR IS A `<textarea>`
 *   `app/package.json` has three runtime dependencies. Monaco is 2 MB and
 *   CodeMirror 6 is a new dependency tree, for a field that holds one statement.
 *   §10.2 asks for the proportionate choice: monospace, a tab key that inserts
 *   two spaces, and a line-number gutter. All three are here.
 *
 * ★ THE GUARD IS NOT IN THIS FILE, AND MUST NOT BE. Every rule that decides
 *   whether a statement may run — one statement, `SELECT`/`WITH` only, no
 *   `ATTACH`/`PRAGMA`/writes, the Oracle-dialect lint, the row cap, the timeout —
 *   lives in `server/src/db/query-guard.ts` and runs on the server. This file
 *   has no allowlist, no keyword scan and no rewrite, because a client-side guard
 *   is one an attacker skips by not using the client. What this file does have is
 *   a *convenience* splitter, used only to list the statements inside the ported
 *   query files so a reader can load one; a bad split produces a verbatim refusal
 *   from the server, never a statement that runs when it should not.
 *
 * ★ WHY EVERY FAILURE IS SHOWN VERBATIM, IN A PANE OF ITS OWN. §10.3: a builder
 *   fails in two ways, and both are silent. A statement that will not run must
 *   say *why* in the driver's own words — `near "FETCH": syntax error` names the
 *   construct to look at, while "the query could not be run" names nothing — and
 *   a statement that runs but answers a different question than the author
 *   intended must have somewhere to say so. The named dialect fix sits under the
 *   message rather than replacing it.
 *
 * ★ THE TWO HONEST STATES THAT ARE EASY TO GET WRONG:
 *   - **"Not run yet"**, never `0 rows`. A view that has not been run has no row
 *     count; rendering `0` asserts the query returned nothing, which is a
 *     different and much more alarming claim. Same principle as the rail
 *     rendering `—` for a count that has not loaded.
 *   - **The cap is reported without a total.** The plan's §10.5 copy reads
 *     "showing 200 of 4,812", and the total is deliberately not available: §5.3
 *     forbids a `COUNT` before the `SELECT`, so the only way to learn it is a
 *     second full query — the cost this whole feature exists to bound. The
 *     server fetches one row past the cap to *detect* truncation, and this screen
 *     says the cap stopped there rather than inventing a denominator.
 *
 * ★ A NULL IS RENDERED AS `—`, NOT AS AN EMPTY CELL, AND NEVER AS `$0.00`.
 *   `format.ts`'s numeric helpers all end in `Number(n) || 0`, which is right for
 *   a chart and wrong for a funding column: a null amount means "no funding row",
 *   and `$0.00` means "funded zero dollars". Those are the two answers the
 *   first-funding question is actually about, so the default format for a
 *   nullable money column is `text` (§7.3) and a null always renders as `—`.
 *
 * ★ THE RESULT IS NO LONGER DRAWN HERE. `components/ViewResultGrid.tsx` owns the
 *   `—` rule above, the cap sentence, the drift notices and the format dispatch,
 *   because this is no longer the only screen that shows a view's result —
 *   `Views` (`routes/SavedViews.tsx`) opens one in a panel. A second table would
 *   be a second place for the first fix to miss, and this file's whole history is
 *   a list of rules that were right in one place and absent in the other. What
 *   stays here is the editor, the column picker's *controls* and the display
 *   config; the grid draws the picker row inside its own `<thead>` so it keeps
 *   the columns' widths.
 */

/* ------------------------------------------------------------------------- *
 * The API's shapes, restated for the client.
 *
 * The app has no generated client and no shared types package — the server's
 * types live in `server/src/`, a separate tsconfig and a separate runtime. These
 * interfaces are the contract written down a second time, which is a real cost
 * and the reason they are narrow: every field here is one this screen reads.
 * ------------------------------------------------------------------------- */

type ParamType = 'text' | 'number' | 'date';
type ViewStatus = 'draft' | 'active' | 'disabled';

interface RunResponse {
  result: ViewResult;
  durationMs: number;
  runId: number | null;
  viewId: number | null;
  fingerprint: string | null;
  appliedValues: Record<string, Cell>;
}

interface ParamDecl {
  name: string;
  label?: string;
  type: ParamType;
  default?: string | number | null;
  from?: string;
}

interface ColumnDecl {
  key: string;
  label?: string;
  format?: ViewFormat;
}

interface DisplayState {
  columns: ColumnDecl[];
  hidden: string[];
  sort: { key: string; dir: 'asc' | 'desc' } | null;
  fingerprint: { key: string } | null;
}

interface SavedView {
  id: number;
  slug: string;
  title: string;
  description: string | null;
  sql: string;
  params: ParamDecl[];
  display: DisplayState;
  created_by: string | null;
  status: ViewStatus;
  created_at: string;
  updated_at: string;
}

interface BuilderConfig {
  enabled: boolean;
  maxRows: number;
  timeoutMs: number;
}

interface ServerConfig {
  dbMode: string;
  dbTarget: string;
  viewBuilder: BuilderConfig;
}

/** A refusal the server sent, kept as it arrived so the pane can quote it. */
interface ApiFailure {
  status: number;
  code: string;
  message: string;
  hint?: string;
  details: Record<string, unknown>;
}

type Outcome =
  | { kind: 'nothing' }
  | { kind: 'unrun' }
  | { kind: 'running' }
  | { kind: 'result'; run: RunResponse; recorded: boolean }
  | { kind: 'failed'; failure: ApiFailure };

/* ------------------------------------------------------------------------- *
 * Talking to the API
 * ------------------------------------------------------------------------- */

/**
 * One call, with both failure modes the browser actually has.
 *
 * The two interesting cases are not HTTP statuses:
 *
 *   - **A network error** — the API is not running. `fetch` rejects, and the
 *     message is the browser's own, which is the useful one to show.
 *   - **A 200 that is not JSON.** This is §10.6's failure and it is the one worth
 *     naming: if the Vite proxy is missing, `/api/views/preview` reaches the dev
 *     server, which answers the SPA — `index.html`, with a 200. A builder that
 *     assumed JSON then reports `Unexpected token '<'`, which sends the reader
 *     into the editor looking for a SQL bug that is not there. So a non-JSON
 *     response is refused by name, with the proxy as the diagnosis.
 */
async function call<T>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; failure: ApiFailure }> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (e) {
    return {
      ok: false,
      failure: {
        status: 0,
        code: 'UNREACHABLE',
        message: e instanceof Error ? e.message : String(e),
        details: {},
      },
    };
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text === '' ? null : JSON.parse(text);
  } catch {
    return {
      ok: false,
      failure: {
        status: res.status,
        code: 'NOT_JSON',
        message:
          `${path} answered HTTP ${res.status} with ${res.headers.get('content-type') ?? 'no content type'}, ` +
          'not JSON. If the status is 200, the request reached the Vite dev server instead of the API — ' +
          'check the `/api` proxy in `app/vite.config.ts` and that the API is listening on 127.0.0.1:5181. ' +
          'See docs/plans/view-builder.md §10.6.',
        details: {},
      },
    };
  }

  if (!res.ok) {
    const envelope = asRecord(parsed);
    const error = asRecord(envelope?.['error']);
    const details = asRecord(error?.['details']) ?? {};
    const message = str(error?.['message']);
    return {
      ok: false,
      failure: {
        status: res.status,
        code: str(error?.['code']) ?? `HTTP_${res.status}`,
        message: message ?? `${path} answered HTTP ${res.status} with no error message.`,
        ...(str(details['hint']) !== null ? { hint: str(details['hint']) as string } : {}),
        details,
      },
    };
  }

  // Every success in this API is one of two envelopes: `{data: T}` for a single
  // value, `{data: T[], page}` for a list. Both unwrap to `data`, so the two call
  // sites that need the page metadata read it off `envelope` themselves.
  const envelope = asRecord(parsed);
  return { ok: true, data: (envelope ? envelope['data'] : parsed) as T };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * The **domain** code of a refusal, which is not the same thing as its HTTP code.
 *
 * ★ THE SERVER PUTS ITS SPECIFIC CODE INSIDE `details`. `AppError.badRequest(msg,{…})`
 *   takes the envelope's `code` from the status — every 400 in this API carries
 *   `BAD_REQUEST` there — and puts the code that says *what happened* in the
 *   details: `UNDECLARED_PARAM`, `MISSING_PARAM_VALUE`, `PARAM_TYPE`, `TIMEOUT`, and
 *   for a driver failure the driver's own `SQLITE_ERROR`. So `failure.code` answers
 *   "how did the transport classify this" and this answers "what is this".
 *
 * ★ WHY IT MATTERS AND NOT JUST FOR LABELS. The screen offers to fix one refusal by
 *   clicking: an undeclared `:token` can be declared in one move, and that offer is
 *   keyed on the code. Reading the envelope code there made the button dead code —
 *   it compiled, it never rendered, and the pane's own copy promised an offer that
 *   could not appear. Falling back to the envelope code keeps an ordinary refusal
 *   (a denied keyword, a stray `;`) labelled exactly as it was before.
 */
function failureCode(failure: ApiFailure): string {
  return str(failure.details['code']) ?? failure.code;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

/** POST a body as JSON. Every write in this domain takes JSON and answers JSON. */
function post<T>(path: string, body: unknown): Promise<{ ok: true; data: T } | { ok: false; failure: ApiFailure }> {
  return call<T>(path, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });
}

/* ------------------------------------------------------------------------- *
 * The schema's own commentary, reused rather than restated
 * ------------------------------------------------------------------------- */

/**
 * §10.3 asks the error pane to "surface the schema's own commentary where it
 * applies", and names two examples — the `GL_BUDGET_VERSIONS` note and the
 * `DEFAULT_EFFECTIVE_DATE` note. Both already exist, as OpenAPI `description`
 * strings on the row objects in `server/src/routes/`, and are served at
 * `GET /api/docs.json`. So nothing is copied into this file: the document is
 * fetched once, lazily, and indexed.
 *
 * The index is built from two places, and the ambiguity rule matters:
 *
 *   - every `components.schemas[*].properties[NAME].description` → keyed `NAME`;
 *   - every ALL-CAPS identifier in backticks inside a schema's own description →
 *     keyed by that identifier. This is how an object's note is found, because
 *     the schema *name* is a client-side label (`WcpssBudgetVersion`) while the
 *     sentence inside it names the table (`… as stored in `GL_BUDGET_VERSIONS``).
 *
 * ★ A NAME WITH TWO DIFFERENT DESCRIPTIONS IS DROPPED RATHER THAN GUESSED AT.
 *   `CREATION_DATE` means something different on a journal than on a budget
 *   version, and showing one of the two under an error about the other would be a
 *   confident wrong answer — worse than no note, in a pane whose whole purpose is
 *   to be trustworthy. The cost is a missing note, which is visible as absence.
 */
let docNotesPromise: Promise<Map<string, string>> | null = null;

function loadDocNotes(): Promise<Map<string, string>> {
  if (docNotesPromise) return docNotesPromise;
  docNotesPromise = (async () => {
    const result = await call<unknown>('/api/docs.json');
    if (!result.ok) return new Map<string, string>();
    return harvestNotes(result.data);
  })();
  return docNotesPromise;
}

function harvestNotes(doc: unknown): Map<string, string> {
  const buckets = new Map<string, Set<string>>();
  const bump = (key: string, text: unknown): void => {
    const note = str(text)?.trim();
    if (!key || !note) return;
    const set = buckets.get(key) ?? new Set<string>();
    set.add(note);
    buckets.set(key, set);
  };

  const schemas = asRecord(asRecord(doc)?.['components'])?.['schemas'];
  const schemaMap = asRecord(schemas);
  if (schemaMap) {
    for (const schema of Object.values(schemaMap)) {
      const node = asRecord(schema);
      if (!node) continue;
      const properties = asRecord(node['properties']);
      if (properties) {
        for (const [name, property] of Object.entries(properties)) {
          bump(name, asRecord(property)?.['description']);
        }
      }
      const own = str(node['description']);
      if (own) {
        for (const match of own.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)) {
          bump(match[1] as string, own);
        }
      }
    }
  }

  const out = new Map<string, string>();
  for (const [key, set] of buckets) {
    if (set.size === 1) out.set(key, [...set][0] as string);
  }
  return out;
}

/**
 * Notes that apply to a piece of text.
 *
 * Identifiers are matched case-insensitively against the index, so both
 * `no such table: GL_BUDGET_VERSIONS` and a statement naming the same table in
 * lower case find the same note. A note shown where it did not quite apply is a
 * small cost; a note hidden where it did is the failure this exists to prevent.
 */
function notesFor(text: string, notes: Map<string, string>, limit = 4): { key: string; note: string }[] {
  const found: { key: string; note: string }[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const key = (match[0] as string).toUpperCase();
    if (seen.has(key)) continue;
    const note = notes.get(key);
    if (note === undefined) continue;
    seen.add(key);
    found.push({ key, note });
    if (found.length >= limit) break;
  }
  return found;
}

/* ------------------------------------------------------------------------- *
 * Ported queries as starting points
 * ------------------------------------------------------------------------- */

/**
 * Every ported query in `data/sql/turso/queries/`, loaded on demand.
 *
 * §10.5 asks the empty state for "a link to the five ported queries … as starting
 * points". ★ THERE ARE SIX, AND THE COUNT IS NOT WRITTEN DOWN ANYWHERE. The plan
 * predates `queries/05-first-fundings.sql`, so its "five" was right when it was
 * written and is wrong now — and the empty state used to repeat the number in its
 * own sentence, directly above a list the glob built, so the screen said five and
 * offered six. A count that restates a directory listing is a count that goes stale
 * the moment the directory changes, which is the one thing this list exists to
 * survive. So the figure is read off `STARTING_POINTS` wherever it is shown, and a
 * seventh file needs no edit here at all.
 *
 * They are SQL files in the repository, not assets the dev server serves, so they
 * are imported as raw text — lazily, through `import.meta.glob`, so the SQL becomes
 * its own chunk per file and is fetched only when a reader opens one.
 * `app/vite.config.ts` allows exactly that directory for the dev server; without it
 * Vite refuses to serve a file outside the app root.
 *
 * ★ THEY ARE NOT PASTED IN WHOLE, AND THAT IS THE POINT. Each file holds 7 to 22
 *   statements, and the builder runs one statement at a time — `analyzeSql`
 *   refuses anything else, and it should. So clicking a file lists its statements
 *   and clicking a statement loads that one.
 */
const QUERY_FILES = import.meta.glob<string>('../../../data/sql/turso/queries/*.sql', {
  query: '?raw',
  import: 'default',
});

interface StartingPoint {
  file: string;
  load: () => Promise<string>;
}

const STARTING_POINTS: StartingPoint[] = Object.keys(QUERY_FILES)
  .sort()
  .map((key) => ({
    file: key.split('/').pop() ?? key,
    load: QUERY_FILES[key] as () => Promise<string>,
  }));

/**
 * Split a script into statements, for listing only.
 *
 * Handles the two things that make a naive `split(';')` wrong on these files:
 * a `;` inside a string literal, and a `;` inside a comment (the headers are
 * full of prose). Neither is a security boundary — see the note at the top of
 * this file — but a wrong split that produced a fragment of prose would make the
 * picker useless, so it is worth the twenty lines.
 */
function splitStatements(source: string): { label: string; sql: string }[] {
  const chunks: string[] = [];
  let buffer = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i] as string;
    const next = source[i + 1];

    if (inLineComment) {
      buffer += ch;
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      buffer += ch;
      if (ch === '*' && next === '/') {
        buffer += '/';
        i += 1;
        inBlockComment = false;
      }
      continue;
    }
    if (inString) {
      buffer += ch;
      if (ch === "'") {
        if (next === "'") {
          buffer += "'";
          i += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      buffer += ch;
      continue;
    }
    if (ch === '-' && next === '-') {
      inLineComment = true;
      buffer += '--';
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      buffer += '/*';
      i += 1;
      continue;
    }
    if (ch === ';') {
      chunks.push(buffer);
      buffer = '';
      continue;
    }
    buffer += ch;
  }
  chunks.push(buffer);

  const out: { label: string; sql: string }[] = [];
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (trimmed === '') continue;
    const lines = trimmed.split('\n');
    const firstCode = lines.findIndex((line) => {
      const t = line.trim();
      return t !== '' && !t.startsWith('--');
    });
    if (firstCode < 0) continue; // A comment-only chunk is not a statement.
    out.push({ label: labelFor(lines, firstCode), sql: `${trimmed};` });
  }
  return out;
}

/**
 * A statement's name, taken from the banner comment the ported files already
 * carry (`B1.`, `FF2.`, …) rather than invented here — those labels are pinned by
 * other documents, so reusing them keeps the picker and the file in agreement.
 */
function labelFor(lines: string[], firstCode: number): string {
  const comments: string[] = [];
  for (let i = firstCode - 1; i >= 0; i -= 1) {
    const t = (lines[i] as string).trim();
    if (t === '') {
      if (comments.length > 0) break;
      continue;
    }
    if (!t.startsWith('--')) break;
    comments.unshift(t.replace(/^-+/, '').trim().replace(/-+$/, '').trim());
  }
  const meaningful = comments.filter((c) => c !== '' && !/^=+$/.test(c));
  const banner =
    meaningful.find((c) => /^[A-Z0-9]+(?:\.[0-9]+)*\.\s/.test(c)) ??
    meaningful.find((c) => c.length > 12) ??
    meaningful[0];
  const fallback = (lines[firstCode] as string).trim();
  const text = banner ?? fallback;
  return text.length > 88 ? `${text.slice(0, 85)}…` : text;
}

/* ------------------------------------------------------------------------- *
 * The definition, canonicalised
 * ------------------------------------------------------------------------- */

const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The display config in one fixed key order, with empty pieces omitted.
 *
 * Both the loaded view's `display_json` and the panel's state go through this, so
 * "has this been edited?" is a string comparison rather than a deep equality on
 * objects that differ only in which optional keys they carry. That comparison
 * decides whether `[Run]` previews or records a run, so it has to be honest.
 */
function canonicalDisplay(display: DisplayState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const columns = display.columns
    .filter((c) => c.key !== '')
    .map((c) => {
      const entry: Record<string, unknown> = { key: c.key };
      if (c.label) entry['label'] = c.label;
      if (c.format) entry['format'] = c.format;
      return entry;
    });
  if (columns.length > 0) out['columns'] = columns;
  if (display.hidden.length > 0) out['hidden'] = display.hidden;
  if (display.sort) out['sort'] = { key: display.sort.key, dir: display.sort.dir };
  if (display.fingerprint) out['fingerprint'] = { key: display.fingerprint.key };
  return out;
}

function sameParams(a: ParamDecl[], b: ParamDecl[]): boolean {
  const shape = (list: ParamDecl[]): string =>
    JSON.stringify(
      list.map((p) => ({ name: p.name, type: p.type, label: p.label ?? null, default: p.default ?? null })),
    );
  return shape(a) === shape(b);
}

/* ------------------------------------------------------------------------- *
 * The screen
 * ------------------------------------------------------------------------- */

const EMPTY_DISPLAY: DisplayState = { columns: [], hidden: [], sort: null, fingerprint: null };

export default function ViewBuilder() {
  const [search, setSearch] = useSearchParams();

  /* --- the server's own answer about itself ---------------------------- */
  const [server, setServer] = useState<ServerConfig | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  /* --- the definition -------------------------------------------------- */
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [sql, setSql] = useState('');
  const [params, setParams] = useState<ParamDecl[]>([]);
  const [display, setDisplay] = useState<DisplayState>(EMPTY_DISPLAY);
  const [values, setValues] = useState<Record<string, string>>({});

  /* --- where the draft came from, and what it looked like there --------- */
  const [saved, setSaved] = useState<SavedView | null>(null);
  const [savedList, setSavedList] = useState<SavedView[]>([]);
  const [savedError, setSavedError] = useState<string | null>(null);

  /* --- the result ------------------------------------------------------ */
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'nothing' });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [notes, setNotes] = useState<Map<string, string> | null>(null);

  /* --- who is watching this view --------------------------------------- */
  /**
   * ★ THIS SCREEN NO LONGER ASKS.
   *
   *   It used to hold a subscriber name, a note about one, and the watchers
   *   themselves, because it also held the control that made them. That control
   *   is `Views`' now, and the honest boundary is that the whole question went
   *   with it: whether anybody watches a view is a fact that page renders in its
   *   own table, and it is the table rather than a sentence here that a reader
   *   checks.
   *
   * ★ THE COUNT WAS TRIED AND REMOVED, WHICH IS WORTH RECORDING. The readiness
   *   line below wanted to say “already watched by N”, and fetching N is not as
   *   easy as it looks: `GET /api/views/{id}/subscriptions` is paginated, so the
   *   length of a page is **not** the number of watches, and this file's own
   *   `call<T>` unwraps the envelope to `data` — it never returns `page` at all.
   *   The first attempt read `result.data.page.total`, which typechecks against
   *   the type argument and is `undefined` at runtime, so a view two people watch
   *   reported zero and said so with no sign of error. A count that is wrong is
   *   worse than no count: this line now states what publishing does
   *   unconditionally, and `Views` owns the number.
   */

  const builder = server?.viewBuilder ?? null;
  const enabled = builder?.enabled ?? false;

  /* --- loading --------------------------------------------------------- */

  /**
   * The server config first, because it decides what the rest of the screen may
   * do. A disabled builder is a *configuration*, and §10 asks for it to be
   * reported as one: the screen renders in full with the run buttons off and a
   * notice naming `VIEW_BUILDER_ENABLED=1`, rather than being missing or looking
   * broken. Read from the server rather than duplicated in the client, so the
   * cap shown here and the cap that actually applied cannot disagree.
   */
  useEffect(() => {
    let live = true;
    void (async () => {
      const result = await call<ServerConfig>('/api/meta/config');
      if (!live) return;
      if (result.ok) setServer(result.data);
      else setServerError(result.failure.message);
    })();
    return () => {
      live = false;
    };
  }, []);

  const loadSavedList = useCallback(async () => {
    const result = await call<SavedView[]>('/api/views?limit=100');
    if (result.ok) {
      setSavedList(result.data);
      setSavedError(null);
      return;
    }
    // Not fatal, and on an Oracle-mode server it is the *expected* answer:
    // `requireAppSchema` refuses the saved-view tables with a 503 whose message
    // explains that they are SQLite-only. Preview does not need them, so the
    // builder still works — it just has nowhere to save.
    setSavedList([]);
    setSavedError(result.failure.message);
  }, []);

  useEffect(() => {
    void loadSavedList();
  }, [loadSavedList]);

  const openSaved = useCallback(
    async (id: number) => {
      const result = await call<SavedView>(`/api/views/${id}`);
      if (!result.ok) {
        setOutcome({ kind: 'failed', failure: result.failure });
        return;
      }
      const view = result.data;
      setSaved(view);
      setTitle(view.title);
      setSlug(view.slug);
      setDescription(view.description ?? '');
      setSql(view.sql);
      setParams(view.params);
      setDisplay({
        columns: view.display.columns ?? [],
        hidden: view.display.hidden ?? [],
        sort: view.display.sort ?? null,
        fingerprint: view.display.fingerprint ?? null,
      });
      setValues({});
      setOutcome({ kind: 'unrun' });
      setSearch({ view: String(view.id) }, { replace: true });
    },
    [setSearch],
  );

  /**
   * The `?view=` parameter is honoured once, on mount.
   *
   * Not re-read on every change of the search string: this screen *writes* that
   * parameter when it opens a saved view, and a load-on-change effect would then
   * be racing its own writes. `menu.ts` and `Pending.tsx` make the same point in
   * the other direction — a URL should be a linkable address, not a second copy
   * of the state machine.
   */
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
    const wanted = search.get('view');
    if (wanted !== null && /^\d+$/.test(wanted)) void openSaved(Number(wanted));
  }, [search, openSaved]);

  const newDraft = useCallback(() => {
    setSaved(null);
    setTitle('');
    setSlug('');
    setDescription('');
    setSql('');
    setParams([]);
    setDisplay(EMPTY_DISPLAY);
    setValues({});
    setOutcome({ kind: 'nothing' });
    setSearch({}, { replace: true });
  }, [setSearch]);

  /* --- running --------------------------------------------------------- */

  /** The body both preview and a comparison use, built in one place. */
  const executeBody = useMemo(() => {
    const supplied: Record<string, string | number> = {};
    for (const [name, raw] of Object.entries(values)) {
      if (raw === '') continue;
      const declared = params.find((p) => p.name === name);
      // A `number` parameter is sent as a number so the server's finite-number
      // check is the thing that validates it, rather than this file guessing at
      // the string's shape and the server then re-checking parses of it.
      supplied[name] = declared?.type === 'number' ? Number(raw) : raw;
    }
    return {
      sql,
      params,
      values: supplied,
      display: canonicalDisplay(display),
      ...(saved ? { viewId: saved.id } : {}),
    };
  }, [sql, params, values, display, saved]);

  /**
   * Whether the draft still matches the saved view it came from.
   *
   * This decides which endpoint `[Run]` uses, and it is a real distinction rather
   * than an optimisation: `POST /api/views/{id}/run` records a history row (and
   * the fingerprint a subscription compares against), while a preview records
   * nothing. Recording a run of a draft that no longer matches the saved view
   * would put a fingerprint in the history for SQL that is not the view's SQL —
   * which is exactly the kind of quietly wrong row that makes a change
   * notification untrustworthy later.
   */
  const matchesSaved =
    saved !== null &&
    saved.sql.trim() === sql.trim() &&
    sameParams(params, saved.params) &&
    JSON.stringify(canonicalDisplay(display)) ===
      JSON.stringify(
        canonicalDisplay({
          columns: saved.display.columns ?? [],
          hidden: saved.display.hidden ?? [],
          sort: saved.display.sort ?? null,
          fingerprint: saved.display.fingerprint ?? null,
        }),
      );

  /**
   * Whether the **stored** view is offered on `Views` — not whether the draft is.
   *
   * ★ THE STORED ROW IS WHAT THE QUESTION IS ABOUT, AND THE DRAFT IS A TRAP HERE.
   *   Views reads `saved_view` over the API and has never seen this screen, so a
   *   readiness line computed from the draft's `display.fingerprint` would tell an
   *   author their unsaved change had made the view watchable while the row the
   *   dropdown actually reads still declares no key — the same class of confident
   *   wrong answer as the two the server's watch payload already had to be
   *   corrected for. The saved definition plus the saved status are the whole
   *   answer, which is why this reads `saved` and nothing else.
   */
  const blockers = saved === null ? [] : viewBlockers(saved);

  const run = useCallback(async () => {
    if (sql.trim() === '') {
      setOutcome({ kind: 'nothing' });
      return;
    }
    setOutcome({ kind: 'running' });

    const useSavedRun = matchesSaved && saved !== null;
    const result = useSavedRun
      ? await post<RunResponse>(`/api/views/${saved.id}/run`, { values: executeBody.values })
      : await post<RunResponse>('/api/views/preview', executeBody);

    if (result.ok) {
      setOutcome({ kind: 'result', run: result.data, recorded: useSavedRun });
      return;
    }
    setOutcome({ kind: 'failed', failure: result.failure });
  }, [sql, matchesSaved, saved, executeBody]);

  /* --- the schema's notes, only once something has gone wrong ----------- */
  useEffect(() => {
    if (outcome.kind !== 'failed' || notes !== null) return;
    let live = true;
    void loadDocNotes().then((map) => {
      if (live) setNotes(map);
    });
    return () => {
      live = false;
    };
  }, [outcome, notes]);

  /* --- saving ---------------------------------------------------------- */

  const [saveState, setSaveState] = useState<
    { kind: 'idle' } | { kind: 'busy' } | { kind: 'ok'; message: string } | { kind: 'error'; failure: ApiFailure }
  >({ kind: 'idle' });

  /* --- publishing ------------------------------------------------------ */

  const [publishState, setPublishState] = useState<
    { kind: 'idle' } | { kind: 'busy' } | { kind: 'ok'; message: string } | { kind: 'error'; failure: ApiFailure }
  >({ kind: 'idle' });

  const publish = useCallback(
    async (next: ViewStatus) => {
      if (saved === null) return;
      setPublishState({ kind: 'busy' });

      // ★ ONLY `status` IS SENT, AND THAT IS A SAFETY DECISION RATHER THAN A SAVING
      //   ONE. `PATCH /api/views/{id}` accepts every field a save does, so sending
      //   the whole body would be the obvious code — and it would mean that pressing
      //   *Publish* silently discarded any edit the panel was still holding, or worse,
      //   published a statement the reader had half-rewritten. Publishing changes who
      //   may watch a view; it must not be able to change what the view says. The
      //   caller therefore requires the draft to match the saved view first (see the
      //   button's `disabled`), so there is never a moment where the thing published
      //   is not the thing on screen.
      const result = await call<SavedView>(`/api/views/${saved.id}`, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ status: next }),
      });

      if (!result.ok) {
        setPublishState({ kind: 'error', failure: result.failure });
        return;
      }
      // The response is the whole updated row, so `saved` is replaced rather than
      // patched: the status the button reads next is the server's, not a guess.
      setSaved(result.data);
      setPublishState({
        kind: 'ok',
        message:
          next === 'active'
            ? `“${result.data.title}” is published. Views now offers it under “Watch a view”.`
            : `“${result.data.title}” is back to draft, so Views no longer offers it to new watchers. ` +
              'Subscriptions already in place are kept — this does not delete them.',
      });
      await loadSavedList();
    },
    [saved, loadSavedList],
  );

  const save = useCallback(async () => {
    setSaveState({ kind: 'busy' });
    // A publish outcome describes the status that a save may have just changed the
    // shape of, so it stops being a statement about the current draft the moment
    // the definition changes. Cleared rather than left to go stale.
    setPublishState({ kind: 'idle' });
    const body = {
      title,
      slug,
      ...(description.trim() !== '' ? { description } : {}),
      sql,
      params,
      display: canonicalDisplay(display),
    };
    const result = saved
      ? await call<SavedView>(`/api/views/${saved.id}`, {
          method: 'PATCH',
          headers: JSON_HEADERS,
          body: JSON.stringify({ ...body, description: description.trim() === '' ? null : description }),
        })
      : await call<SavedView>('/api/views', {
          method: 'POST',
          headers: JSON_HEADERS,
          body: JSON.stringify(body),
        });

    if (!result.ok) {
      setSaveState({ kind: 'error', failure: result.failure });
      return;
    }
    const view = result.data;
    setSaved(view);
    setSaveState({
      kind: 'ok',
      message: saved ? `Saved “${view.title}”.` : `Saved “${view.title}” as a new view.`,
    });
    setSearch({ view: String(view.id) }, { replace: true });
    await loadSavedList();
  }, [title, slug, description, sql, params, display, saved, setSearch, loadSavedList]);

  /* --- the column picker's view of the columns ------------------------- */

  /**
   * The columns the picker offers.
   *
   * Taken from the last run when there is one, because that is the only place the
   * *real* column names appear — the declared display config is a wish, and §7.3
   * is explicit that the wish is reconciled against reality rather than trusted.
   * Before any run, the declared list is all there is to show, and it is labelled
   * as such.
   */
  const pickerColumns: ResultColumn[] = useMemo(() => {
    if (outcome.kind === 'result') {
      return outcome.run.result.columns;
    }
    const byKey = new Map(display.columns.map((c) => [c.key.toLowerCase(), c]));
    const declared: ResultColumn[] = display.columns.map((c) => ({
      key: c.key,
      label: c.label ?? humanise(c.key),
      format: c.format ?? 'text',
      hidden: display.hidden.some((h) => h.toLowerCase() === c.key.toLowerCase()),
    }));
    const hiddenOnly: ResultColumn[] = display.hidden
      .filter((h) => !byKey.has(h.toLowerCase()))
      .map((h) => ({ key: h, label: humanise(h), format: 'text', hidden: true }));
    return [...declared, ...hiddenOnly];
  }, [outcome, display.columns, display.hidden]);

  const result = outcome.kind === 'result' ? outcome.run.result : null;
  const activeRun = outcome.kind === 'result' ? outcome.run : null;
  const visibleColumns = result ? result.columns.filter((c) => !c.hidden) : [];

  /* --- editing helpers ------------------------------------------------- */

  const patchColumn = useCallback((key: string, patch: Partial<ColumnDecl>) => {
    setDisplay((current) => patchColumnDecl(current, key, patch));
  }, []);

  const moveColumn = useCallback(
    (key: string, delta: number) => {
      setDisplay((current) => {
        const columns = declareOrder(current, pickerColumns);
        const from = columns.findIndex((c) => c.key.toLowerCase() === key.toLowerCase());
        const to = from + delta;
        if (from < 0 || to < 0 || to >= columns.length) return current;
        const next = columns.slice();
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved as ColumnDecl);
        return { ...current, columns: next };
      });
    },
    [pickerColumns],
  );

  const toggleHidden = useCallback((key: string) => {
    setDisplay((current) => {
      const lower = key.toLowerCase();
      const hidden = current.hidden.some((h) => h.toLowerCase() === lower)
        ? current.hidden.filter((h) => h.toLowerCase() !== lower)
        : [...current.hidden, key];
      return { ...current, hidden };
    });
  }, []);

  /* --- the undeclared-parameter fix, offered as a button ---------------- */
  const failure = outcome.kind === 'failed' ? outcome.failure : null;
  const undeclaredToken =
    failure !== null && failureCode(failure) === 'UNDECLARED_PARAM' ? str(failure.details['token']) : null;

  const declareToken = useCallback(
    (token: string) => {
      setParams((current) =>
        current.some((p) => p.name === token)
          ? current
          : [...current, { name: token, type: 'text', default: null }],
      );
      setOutcome({ kind: 'unrun' });
    },
    [],
  );

  const notesToShow = failure !== null && notes !== null
    ? notesFor(`${failure.message}\n${failure.hint ?? ''}\n${sql}`, notes)
    : [];

  /* --- render ---------------------------------------------------------- */

  const editorId = useId();
  const busy = outcome.kind === 'running';

  return (
    <div className="stack">
      <div>
        <div className="accent-rule" />
        <div className="page-head">
          <div>
            <h1>View builder</h1>
          </div>
          <div className="page-head__actions">
            <select
              className="input vb-pick"
              aria-label="Open a saved view"
              value={saved?.id ?? ''}
              onChange={(e) => {
                if (e.target.value === '') newDraft();
                else void openSaved(Number(e.target.value));
              }}
            >
              <option value="">— New, unsaved view —</option>
              {savedList.map((view) => (
                <option key={view.id} value={view.id}>
                  {view.title}
                  {view.status === 'active' ? '' : ` (${view.status})`}
                </option>
              ))}
            </select>
            <button type="button" className="btn btn--system" onClick={newDraft}>
              New view
            </button>
          </div>
        </div>
      </div>

      {/* Server state, in the order it matters: cannot reach it, switched off,
          storage missing. Each is named rather than left to show up as a
          failed request later. */}
      {serverError !== null && (
        <div className="notice notice--err" role="alert">
          <div>
            <p>
              <strong>The API did not answer.</strong> {serverError}
            </p>
            <p>
              This screen runs SQL through <code>/api</code>, so it needs the server up on{' '}
              <code>127.0.0.1:5181</code> and the <code>/api</code> proxy the app declares in{' '}
              <code>app/vite.config.ts</code>.
            </p>
          </div>
        </div>
      )}

      {server !== null && !enabled && (
        <div className="notice notice--warn" role="alert">
          <div>
            <p>
              <strong>This server has the view builder switched off.</strong> Every endpoint in the domain
              answers <code>409 WRITES_DISABLED</code>, so nothing here will run.
            </p>
            <p>
              It is off by default and gated on purpose (§5.4): this endpoint runs SQL a person typed, no
              route in this domain checks a session, and it belongs on loopback only. Start the server
              with{' '}<code>VIEW_BUILDER_ENABLED=1</code> to turn it on.
            </p>
          </div>
        </div>
      )}

      {savedError !== null && (
        <div className="notice notice--info">
          <div>
            <p>
              <strong>Saved views are unavailable.</strong> {savedError}
            </p>
            <p>
              Running a statement is unaffected — preview needs no app tables. Only saving, run history and
              subscriptions do.
            </p>
          </div>
        </div>
      )}

      <div className="grid-2">
        {/* ---------------------------------------------------------- *
            Left: the definition
            * ---------------------------------------------------------- */}
        <div className="panel">
          <div className="panel__head">
            <h2 className="panel__title">Definition</h2>
            {saved !== null && (
              <span className="panel__sub">
                {saved.slug} · updated {saved.updated_at}
              </span>
            )}
            <span className="panel__count">{matchesSaved ? 'saved' : 'edited'}</span>
          </div>
          <div className="panel__body">
            <div className="vb-fields">
              <div className="field">
                <label className="field__label" htmlFor="vb-title">
                  Title
                </label>
                <input
                  id="vb-title"
                  className="input"
                  value={title}
                  maxLength={120}
                  placeholder="First fundings by project"
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>
              <div className="field">
                <label className="field__label" htmlFor="vb-slug">
                  Slug
                </label>
                <input
                  id="vb-slug"
                  className="input"
                  value={slug}
                  maxLength={120}
                  placeholder="first-fundings-by-project"
                  onChange={(e) => setSlug(e.target.value)}
                />
                <p className="field__hint">
                  Lower case, joined with hyphens. It is the view's identity — the title can change, the
                  slug is what a link points at.
                </p>
              </div>
            </div>

            <div className="field">
              <label className="field__label" htmlFor="vb-description">
                Description
              </label>
              <textarea
                id="vb-description"
                className="textarea"
                value={description}
                maxLength={600}
                rows={2}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>

            <SqlEditor
              id={editorId}
              value={sql}
              disabled={!enabled}
              onChange={(next) => {
                setSql(next);
                // The previous result belongs to the previous statement. Keeping
                // it on screen while the text changes is how a reader ends up
                // reading one query's rows under another query's SQL.
                setOutcome(next.trim() === '' ? { kind: 'nothing' } : { kind: 'unrun' });
              }}
              onRun={() => {
                if (enabled && !busy) void run();
              }}
            />

            <ParamsPanel
              params={params}
              values={values}
              enabled={enabled}
              onChange={setParams}
              onValue={(name, value) => setValues((current) => ({ ...current, [name]: value }))}
            />

            <DisplayPanel
              display={display}
              columns={pickerColumns}
              columnsAreDeclared={outcome.kind !== 'result'}
              maxSort={pickerColumns}
              onChange={setDisplay}
            />

            <div className="vb-actions">
              <button
                type="button"
                className="btn btn--primary"
                disabled={!enabled || busy || sql.trim() === ''}
                onClick={() => void run()}
                title={
                  !enabled
                    ? 'The server has the view builder switched off (VIEW_BUILDER_ENABLED=1).'
                    : sql.trim() === ''
                      ? 'Write a statement first.'
                      : matchesSaved
                        ? 'Runs the saved view and records the run.'
                        : 'Runs the statement without saving or recording anything.'
                }
              >
                {busy ? 'Running…' : 'Run'}
              </button>
              <button
                type="button"
                className="btn btn--system"
                disabled={!enabled || title.trim() === '' || slug.trim() === '' || sql.trim() === '' || savedError !== null}
                onClick={() => void save()}
                title={
                  savedError !== null
                    ? 'This server has nowhere to save a view — see the notice above.'
                    : saved
                      ? 'Saves over the view this draft came from.'
                      : 'Saves this draft as a new view. A slug that is taken is refused, not overwritten.'
                }
              >
                {saved ? 'Save' : 'Save as new'}
              </button>
              <button
                type="button"
                className={saved?.status === 'active' ? 'btn btn--ghost' : 'btn btn--system'}
                disabled={
                  !enabled ||
                  saved === null ||
                  !matchesSaved ||
                  savedError !== null ||
                  publishState.kind === 'busy'
                }
                onClick={() => void publish(saved?.status === 'active' ? 'draft' : 'active')}
                title={
                  savedError !== null
                    ? 'This server has nowhere to record a status change — see the notice above.'
                    : saved === null
                      ? 'Save the view first — publishing is a change to a stored view, and an unsaved draft has no row to change.'
                      : !matchesSaved
                        ? 'Publish records the saved statement, not the draft on screen. Save your changes first.'
                        : saved.status === 'active'
                          ? 'Takes it back to draft. Views stops offering it to new watchers; existing subscriptions are kept.'
                          : 'Makes this view active, which is the state Views offers for watching. It records the saved statement — it does not run it.'
                }
              >
                {publishState.kind === 'busy'
                  ? 'Recording…'
                  : saved?.status === 'active'
                    ? 'Unpublish'
                    : 'Publish'}
              </button>
            </div>

            <p className="field__hint vb-runhint">
              {matchesSaved ? (
                <>
                  Running records a history row and a result fingerprint, which is what a watch on{' '}
                  <Link to="/views">Views</Link> compares against.
                </>
              ) : (
                <>
                  Running previews only: the draft differs from the saved view, so nothing is recorded. A
                  run recorded here would be a fingerprint for SQL the view does not hold.
                </>
              )}
            </p>

            <PublishReadiness saved={saved} blockers={blockers} />

            {/* The save outcome, next to the button that produced it. A slug
                collision is the interesting one: the server refuses it with the
                holder's name rather than overwriting, because a slug is the
                view's identity and a shared link must keep resolving to the
                same query. */}
            {saveState.kind === 'ok' && <p className="field__hint vb-note">{saveState.message}</p>}
            {saveState.kind === 'error' && (
              <div className="notice notice--err" role="alert">
                <div>
                  <p>
                    <strong>Not saved.</strong> <code>{saveState.failure.code}</code>
                  </p>
                  <pre className="vb-error__message">{saveState.failure.message}</pre>
                </div>
              </div>
            )}

            {publishState.kind === 'ok' && <p className="field__hint vb-note">{publishState.message}</p>}
            {publishState.kind === 'error' && (
              <div className="notice notice--err" role="alert">
                <div>
                  <p>
                    <strong>The status was not changed.</strong>{' '}
                    <code>{publishState.failure.code}</code>
                  </p>
                  <pre className="vb-error__message">{publishState.failure.message}</pre>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ---------------------------------------------------------- *
            Right: the result
            * ---------------------------------------------------------- */}
        <div className="stack">
          {failure !== null && <ErrorPane failure={failure} notes={notesToShow} token={undeclaredToken} onDeclare={declareToken} />}

          <div className="panel">
            <div className="panel__head">
              <h2 className="panel__title">Result</h2>
              {result !== null && (
                <span className="panel__sub">
                  {pluralise(result.rowCount, 'row')} · {activeRun === null ? '' : `${activeRun.durationMs} ms`}
                  {activeRun !== null && activeRun.runId !== null ? ' · recorded' : ''}
                </span>
              )}
              {result !== null && (
                <button
                  type="button"
                  className="btn btn--system btn--sm"
                  aria-pressed={pickerOpen}
                  onClick={() => setPickerOpen((open) => !open)}
                >
                  {pickerOpen ? 'Done' : 'Columns'}
                </button>
              )}
            </div>

            <ResultBody
              outcome={outcome}
              visibleColumns={visibleColumns}
              pickerColumns={pickerColumns}
              pickerOpen={pickerOpen}
              enabled={enabled}
              db={server === null ? null : { mode: server.dbMode, target: server.dbTarget }}
              onToggleHidden={toggleHidden}
              onPatchColumn={patchColumn}
              onMoveColumn={moveColumn}
              onLoadStatement={(statement) => {
                setSql(statement);
                setOutcome({ kind: 'unrun' });
              }}
            />
          </div>

        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- *
 * The editor
 * ------------------------------------------------------------------------- */

interface SqlEditorProps {
  id: string;
  value: string;
  disabled: boolean;
  onChange: (next: string) => void;
  onRun: () => void;
}

/**
 * A monospace `<textarea>` with a line-number gutter — §10.2's proportionate
 * choice, and one of only two things on this page that need CSS of their own.
 *
 * Two details are not decoration:
 *
 *   - **Tab inserts two spaces** rather than moving focus. In a field that holds
 *     nothing but a SQL statement, tabbing out is not what Tab means, and a
 *     keyboard user who cannot indent cannot format a query.
 *   - **`wrap="off"`.** Wrapping would break the correspondence between the
 *     gutter and the text, because one visual row would span two logical lines
 *     and the numbers would drift. A long `SELECT` scrolls sideways instead,
 *     which is how a SQL editor behaves.
 */
function SqlEditor({ id, value, disabled, onChange, onRun }: SqlEditorProps) {
  const area = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const lineCount = value === '' ? 1 : value.split('\n').length;

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        SQL
        <span className="vb-editor__hint"> one statement · Ctrl/⌘ + Enter runs</span>
      </label>
      <div className="vb-editor">
        <div className="vb-editor__gutter" ref={gutter} aria-hidden="true">
          {Array.from({ length: lineCount }, (_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>
        <textarea
          id={id}
          ref={area}
          className="vb-editor__area"
          value={value}
          disabled={disabled}
          spellCheck={false}
          wrap="off"
          rows={16}
          placeholder={'SELECT 1 AS one'}
          onScroll={(e) => {
            if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Tab' && !e.shiftKey) {
              e.preventDefault();
              const el = e.currentTarget;
              const start = el.selectionStart;
              const end = el.selectionEnd;
              onChange(`${value.slice(0, start)}  ${value.slice(end)}`);
              requestAnimationFrame(() => {
                el.selectionStart = start + 2;
                el.selectionEnd = start + 2;
              });
              return;
            }
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              onRun();
            }
          }}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- *
 * Parameters
 * ------------------------------------------------------------------------- */

interface ParamsPanelProps {
  params: ParamDecl[];
  values: Record<string, string>;
  enabled: boolean;
  onChange: (next: ParamDecl[]) => void;
  onValue: (name: string, value: string) => void;
}

/**
 * The declared parameter list, and the values to bind.
 *
 * §7.2's three rules are enforced on the server, and this panel is written so
 * that the server's answers land somewhere the author can act on:
 *
 *   - a `:token` with no declaration is a 400 naming the token, and the error
 *     pane offers to declare it — one click, no retyping;
 *   - a declaration the SQL does not use is a *warning*, shown next to the
 *     result rather than blocking it, because the author is mid-edit;
 *   - a parameter with no value and no default is refused **before** the query
 *     runs, so an empty value is sent as absent rather than as an empty string.
 *     That distinction is the whole point: an empty string binds, and the query
 *     then returns a plausibly empty result instead of saying it needs an input.
 */
function ParamsPanel({ params, values, enabled, onChange, onValue }: ParamsPanelProps) {
  const update = (index: number, patch: Partial<ParamDecl>): void => {
    onChange(params.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  };

  return (
    <div className="field">
      <div className="vb-subhead">
        <span className="field__label">Parameters</span>
        <button
          type="button"
          className="btn btn--system btn--sm"
          disabled={!enabled}
          onClick={() => onChange([...params, { name: '', type: 'text', default: null }])}
        >
          Add
        </button>
      </div>

      {params.length === 0 ? (
        <p className="field__hint">
          None declared. A <code>:token</code> in the SQL has to be declared before it can be bound — the
          server refuses an undeclared one by name, and offers to declare it.
        </p>
      ) : (
        <div className="vb-params">
          <div className="vb-params__head">
            <span>Name</span>
            <span>Label</span>
            <span>Type</span>
            <span>Default</span>
            <span>Value</span>
            <span />
          </div>
          {params.map((param, index) => {
            const bad = param.name !== '' && !PARAM_NAME.test(param.name);
            const value = values[param.name] ?? '';
            return (
              <div className="vb-params__row" key={`${param.name}-${index}`}>
                <input
                  className={`input${bad ? ' vb-input--err' : ''}`}
                  value={param.name}
                  placeholder="s1"
                  aria-label={`Parameter ${index + 1} name`}
                  onChange={(e) => update(index, { name: e.target.value })}
                />
                <input
                  className="input"
                  value={param.label ?? ''}
                  placeholder="Fund"
                  aria-label={`Parameter ${index + 1} label`}
                  onChange={(e) => update(index, { label: e.target.value })}
                />
                <select
                  className="input"
                  value={param.type}
                  aria-label={`Parameter ${index + 1} type`}
                  onChange={(e) => update(index, { type: e.target.value as ParamType })}
                >
                  <option value="text">text</option>
                  <option value="number">number</option>
                  <option value="date">date</option>
                </select>
                <input
                  className="input"
                  value={param.default === null || param.default === undefined ? '' : String(param.default)}
                  placeholder="—"
                  aria-label={`Parameter ${index + 1} default`}
                  onChange={(e) => update(index, { default: e.target.value === '' ? null : e.target.value })}
                />
                <input
                  className="input"
                  value={value}
                  placeholder="—"
                  aria-label={`Parameter ${index + 1} value`}
                  onChange={(e) => onValue(param.name, e.target.value)}
                />
                <button
                  type="button"
                  className="btn btn--system btn--sm"
                  aria-label={`Remove parameter ${param.name || index + 1}`}
                  onClick={() => onChange(params.filter((_, i) => i !== index))}
                >
                  ✕
                </button>
                {bad && <p className="field__err">A parameter name is letters, digits and underscores, and cannot start with a digit.</p>}
                {param.from !== undefined && <p className="field__hint">Offered from {param.from}.</p>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------- *
 * Display
 * ------------------------------------------------------------------------- */

interface DisplayPanelProps {
  display: DisplayState;
  columns: ResultColumn[];
  columnsAreDeclared: boolean;
  maxSort: ResultColumn[];
  onChange: (next: DisplayState) => void;
}

/**
 * Column order, labels, formats, sort and the fingerprint key.
 *
 * §7.3's drift rule is why this panel never refuses to render a saved view whose
 * query changed: the config is *reconciled* against the columns that came back,
 * and a column the query no longer returns becomes a named notice on the result
 * rather than an empty table. The panel therefore edits a wish, and the grid
 * below shows what that wish turned into.
 */
function DisplayPanel({ display, columns, columnsAreDeclared, maxSort, onChange }: DisplayPanelProps) {
  const hidden = new Set(display.hidden.map((h) => h.toLowerCase()));

  return (
    <div className="field">
      <span className="field__label">Display</span>

      {columns.length === 0 ? (
        <p className="field__hint">
          {columnsAreDeclared
            ? 'No columns yet. The picker is filled from the first run, because the real column names only exist once the query has returned them.'
            : 'The picker is filled from the run above.'}
        </p>
      ) : (
        <ul className="vb-columns">
          {columns.map((column) => (
            <li key={column.key} className="vb-columns__row">
              <label className="vb-columns__show">
                <input
                  type="checkbox"
                  checked={!hidden.has(column.key.toLowerCase())}
                  onChange={() =>
                    onChange({
                      ...display,
                      hidden: hidden.has(column.key.toLowerCase())
                        ? display.hidden.filter((h) => h.toLowerCase() !== column.key.toLowerCase())
                        : [...display.hidden, column.key],
                    })
                  }
                />
                <code>{column.key}</code>
              </label>
              <input
                className="input"
                value={display.columns.find((c) => c.key.toLowerCase() === column.key.toLowerCase())?.label ?? ''}
                placeholder={column.label}
                aria-label={`Label for ${column.key}`}
                onChange={(e) => onChange(patchColumnDecl(display, column.key, { label: e.target.value }))}
              />
              <select
                className="input"
                value={display.columns.find((c) => c.key.toLowerCase() === column.key.toLowerCase())?.format ?? 'text'}
                aria-label={`Format for ${column.key}`}
                onChange={(e) =>
                  onChange(patchColumnDecl(display, column.key, { format: e.target.value as ViewFormat }))
                }
              >
                {VIEW_FORMATS.map((format) => (
                  <option key={format} value={format}>
                    {format}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      )}

      <div className="vb-fields">
        <div className="field">
          <label className="field__label" htmlFor="vb-sort">
            Default sort
          </label>
          <div className="vb-inline">
            <select
              id="vb-sort"
              className="input"
              value={display.sort?.key ?? ''}
              onChange={(e) =>
                onChange({
                  ...display,
                  sort: e.target.value === '' ? null : { key: e.target.value, dir: display.sort?.dir ?? 'asc' },
                })
              }
            >
              <option value="">— none —</option>
              {maxSort.map((column) => (
                <option key={column.key} value={column.key}>
                  {column.label}
                </option>
              ))}
            </select>
            <select
              className="input vb-inline__narrow"
              aria-label="Sort direction"
              value={display.sort?.dir ?? 'asc'}
              disabled={display.sort === null}
              onChange={(e) =>
                onChange({
                  ...display,
                  sort: display.sort === null ? null : { key: display.sort.key, dir: e.target.value as 'asc' | 'desc' },
                })
              }
            >
              <option value="asc">asc</option>
              <option value="desc">desc</option>
            </select>
          </div>
        </div>

        <div className="field">
          <label className="field__label" htmlFor="vb-fingerprint">
            Fingerprint key
          </label>
          <select
            id="vb-fingerprint"
            className="input"
            value={display.fingerprint?.key ?? ''}
            onChange={(e) => onChange({ ...display, fingerprint: e.target.value === '' ? null : { key: e.target.value } })}
          >
            <option value="">— none —</option>
            {maxSort.map((column) => (
              <option key={column.key} value={column.key}>
                {column.label}
              </option>
            ))}
          </select>
          <p className="field__hint">
            The column that identifies a row of <em>this</em> view. Change detection hashes the row count
            and the values of this column in order, so it needs one — and it cannot see a change that
            preserves both. <strong>Used by <Link to="/views">Views</Link>, where somebody subscribes to
            this view:</strong> a view that declares no key cannot be watched at all, so this is required
            in practice even though the row treats it as optional.
          </p>
        </div>
      </div>

      <p className="field__hint">
        Formats name helpers in <code>app/src/data/format.ts</code>. The default is <code>text</code>, and
        for a nullable money column that is deliberate: every numeric helper coerces through{' '}
        <code>Number(n) || 0</code>, so a null under <code>money</code> would read <code>$0.00</code> — a
        funded zero — where the truth is that there is no funding row.
      </p>
    </div>
  );
}

/** Materialise one column into `display.columns`, if it is not declared yet. */
function declare(display: DisplayState, key: string): DisplayState {
  if (display.columns.some((c) => c.key.toLowerCase() === key.toLowerCase())) return display;
  return { ...display, columns: [...display.columns, { key }] };
}

function patchColumnDecl(display: DisplayState, key: string, patch: Partial<ColumnDecl>): DisplayState {
  const next = declare(display, key);
  return {
    ...next,
    columns: next.columns.map((c) => (c.key.toLowerCase() === key.toLowerCase() ? { ...c, ...patch } : c)),
  };
}

/**
 * The full column list, in the order currently on screen.
 *
 * ★ REORDERING REQUIRES DECLARING EVERY COLUMN, NOT JUST THE TWO THAT MOVED. The
 *   server orders by `display.columns` and *appends* anything the query returned
 *   that the list does not name (§7.3 — the list orders and labels, it does not
 *   filter). So a column that is not in the list has no position to move from:
 *   swapping two undeclared columns would be a no-op, silently. Materialising the
 *   whole order first is what makes a move mean something.
 */
function declareOrder(display: DisplayState, columns: ResultColumn[]): ColumnDecl[] {
  const byKey = new Map(display.columns.map((c) => [c.key.toLowerCase(), c]));
  const ordered: ColumnDecl[] = [];
  for (const column of display.columns) {
    if (columns.some((c) => c.key.toLowerCase() === column.key.toLowerCase())) ordered.push(column);
  }
  for (const column of columns) {
    if (!byKey.has(column.key.toLowerCase())) ordered.push({ key: column.key });
  }
  return ordered;
}

/* ------------------------------------------------------------------------- *
 * The error pane
 * ------------------------------------------------------------------------- */

interface ErrorPaneProps {
  failure: ApiFailure;
  notes: { key: string; note: string }[];
  token: string | null;
  onDeclare: (token: string) => void;
}

/**
 * The driver's message, verbatim, plus the named fix and the schema's own note.
 *
 * §10.3 is emphatic that this is a feature and not a message, and the reason is
 * that the two failure modes of a SQL builder are both silent. A statement that
 * will not run has to say what the parse choked on — `near "FETCH": syntax error`
 * names the construct, "invalid query" names nothing and sends the author to the
 * wrong place. So:
 *
 *   - the **message is the server's string, unedited**, in a `<pre>` so that
 *     whitespace and the exact token survive;
 *   - the **finding** the guard attached to it names the Oracle-only construct
 *     and its `LIMIT`/`COALESCE`/`CASE` port from the §4 table;
 *   - **the schema's notes** (fetched from the OpenAPI document, never restated
 *     here) put the object's own commentary next to the error that mentions it.
 */
function ErrorPane({ failure, notes, token, onDeclare }: ErrorPaneProps) {
  const statement = str(failure.details['statement']);
  const findings = Array.isArray(failure.details['findings']) ? failure.details['findings'] : [];

  return (
    <div className="notice notice--err vb-error" role="alert">
      <div>
        <p className="vb-error__code">
          <strong>{failure.status === 0 ? 'No answer' : `HTTP ${failure.status}`}</strong>{' '}
          {/* The domain code, not the envelope's. `HTTP 400 BAD_REQUEST` says the same
              thing twice and buries the part that tells you what to do — the code is
              what routes the reader to a fix, and `SQLITE_ERROR` is also the first
              hint that the driver, not the server, refused the statement. */}
          <code>{failureCode(failure)}</code>
        </p>
        <pre className="vb-error__message">{failure.message}</pre>

        {findings.map((raw, index) => {
          const finding = asRecord(raw);
          if (!finding) return null;
          return (
            <p key={index} className="vb-error__fix">
              <strong>{str(finding['construct']) ?? str(finding['code'])}</strong>{' '}
              {str(finding['message'])}
              {str(finding['fix']) !== null && (
                <>
                  {' '}
                  <span className="vb-error__lead">Fix:</span> <code>{str(finding['fix'])}</code>
                </>
              )}
            </p>
          );
        })}

        {token !== null && (
          <p>
            <button type="button" className="btn btn--system btn--sm" onClick={() => onDeclare(token)}>
              Declare <code>:{token}</code>
            </button>
          </p>
        )}

        {failure.hint !== undefined && <p className="vb-error__hint">{failure.hint}</p>}

        {notes.length > 0 && (
          <div className="vb-error__notes">
            <p className="subhead">From the schema’s own notes</p>
            <ul>
              {notes.map((entry) => (
                <li key={entry.key}>
                  <code>{entry.key}</code> — {entry.note}
                </li>
              ))}
            </ul>
          </div>
        )}

        {statement !== null && statement.trim() !== '' && (
          <details className="vb-error__statement">
            <summary>The statement that was sent</summary>
            <pre>{statement}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------- *
 * The result
 * ------------------------------------------------------------------------- */

interface ResultBodyProps {
  outcome: Outcome;
  visibleColumns: ResultColumn[];
  pickerColumns: ResultColumn[];
  pickerOpen: boolean;
  enabled: boolean;
  /**
   * Which database the server is actually reading.
   *
   * ★ IT IS PASSED IN RATHER THAN ASSUMED, because the panel used to assert
   *   unconditionally that the starting points "already run on
   *   `data/sql/turso/sample.db`". That is true under `DB_MODE=local` and false under
   *   `DB_MODE=oracle`, where those files are SQLite ports and the connection is the
   *   real extract — so the sentence would have promised six statements that fail on
   *   the first one, which the folder's own README calls worse than having no picker.
   *   The endpoint that answers this already existed and was already being fetched;
   *   `dbMode` and `dbTarget` were simply dropped on the floor rather than rendered.
   */
  db: { mode: string; target: string } | null;
  onToggleHidden: (key: string) => void;
  onPatchColumn: (key: string, patch: Partial<ColumnDecl>) => void;
  onMoveColumn: (key: string, delta: number) => void;
  onLoadStatement: (statement: string) => void;
}

/**
 * The grid, and every state that is not a grid.
 *
 * §10.5's honest states are the reason this is a switch rather than a conditional
 * around a table. In particular **"Not run yet"** is its own state: a view that
 * has not been run has no row count, and rendering `0 rows` would assert that the
 * query returned nothing. The rail makes the same distinction by rendering `—`
 * for a count that has not loaded.
 */
function ResultBody({
  outcome,
  visibleColumns,
  pickerColumns,
  pickerOpen,
  enabled,
  db,
  onToggleHidden,
  onPatchColumn,
  onMoveColumn,
  onLoadStatement,
}: ResultBodyProps) {
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [statements, setStatements] = useState<{ label: string; sql: string }[] | null>(null);

  if (outcome.kind === 'nothing') {
    return (
      <div className="panel__body">
        <p className="vb-empty">
          <strong>Nothing to preview.</strong> Write a statement above, or load one of the{' '}
          {pluralise(STARTING_POINTS.length, 'ported query', 'ported queries')} in{' '}
          <code>data/sql/turso/queries/</code>.
        </p>
        <ul className="vb-starts">
          {STARTING_POINTS.map((point) => (
            <li key={point.file}>
              <button
                type="button"
                className="linkish"
                aria-expanded={openFile === point.file}
                onClick={() => {
                  if (openFile === point.file) {
                    setOpenFile(null);
                    setStatements(null);
                    return;
                  }
                  setOpenFile(point.file);
                  setStatements(null);
                  void point.load().then((text) => setStatements(splitStatements(text)));
                }}
              >
                {point.file}
              </button>
              {openFile === point.file && (
                <div className="vb-starts__body">
                  {statements === null ? (
                    <p className="field__hint">Reading…</p>
                  ) : statements.length === 0 ? (
                    <p className="field__hint">
                      No statements found. The splitter is a convenience, not a parser — open the file
                      itself if this looks wrong.
                    </p>
                  ) : (
                    <>
                      <p className="field__hint">
                        {pluralise(statements.length, 'statement')} in this file. The builder runs one at a
                        time, which is why these are listed rather than pasted in whole.
                      </p>
                      <ul className="vb-starts__list">
                        {statements.map((statement, index) => (
                          <li key={index}>
                            <button
                              type="button"
                              className="linkish linkish--muted"
                              onClick={() => onLoadStatement(statement.sql)}
                            >
                              {statement.label}
                            </button>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
        <p className="field__hint">
          {db !== null && db.mode !== 'local' && db.mode !== 'turso' ? (
            <>
              These are the <strong>SQLite ports</strong> of the analysis queries, written against the
              sample. This server is reading{' '}
              <code>{db.target}</code>, where they will not run as written — §4 of{' '}
              <code>docs/plans/view-builder.md</code> is the dialect table that says what changes.
            </>
          ) : (
            <>
              These are the ported, read-only queries from the sample — each one already runs on{' '}
              <code>{db?.target ?? 'data/sql/turso/sample.db'}</code>. The port notes at the top of each
              file are the dialect table in §4 of <code>docs/plans/view-builder.md</code>, applied.
            </>
          )}
        </p>
      </div>
    );
  }

  if (outcome.kind === 'unrun') {
    return (
      <div className="panel__body">
        <p className="vb-empty">
          <strong>Not run yet.</strong> Press Run — or Ctrl/⌘ + Enter in the editor — to see what this
          statement returns. Nothing has been recorded and no row count exists until it has.
        </p>
      </div>
    );
  }

  if (outcome.kind === 'running') {
    return (
      <div className="panel__body">
        <p className="vb-empty vb-empty--quiet">Running…</p>
      </div>
    );
  }

  if (outcome.kind === 'failed') {
    return (
      <div className="panel__body">
        {/* Deliberately not `0 rows`. A statement that failed returned no result
            at all, and a count would be a claim about a query that never ran. */}
        <p className="vb-empty vb-empty--quiet">
          No result — the statement did not run. The reason is in the pane above, in the driver’s own
          words.
        </p>
      </div>
    );
  }

  const { result } = outcome.run;
  const recorded = outcome.recorded;

  return (
    <ViewResultGrid
      result={result}
      columns={visibleColumns}
      /**
       * ★ THE PICKER IS PASSED IN RATHER THAN DRAWN BY THE GRID, because it is
       *   this screen's editing surface and the grid must not learn what a label
       *   input is. It still has to be the **first row of the grid's own
       *   `<thead>`** — its cells align to the same columns as the labels, and a
       *   picker outside the table would drift from the column widths the moment
       *   a label wrapped.
       */
      picker={
        pickerOpen ? (
          <tr className="vb-picker">
            {visibleColumns.map((column) => {
              const index = pickerColumns.findIndex((c) => c.key === column.key);
              return (
                <th key={column.key} className={NUMERIC_FORMATS.has(column.format) ? 'n' : undefined}>
                  <div className="vb-picker__controls">
                    <label className="vb-picker__hide" title="Hide this column">
                      <input type="checkbox" checked={!column.hidden} onChange={() => onToggleHidden(column.key)} />
                      <span className="sr">Show {column.label}</span>
                    </label>
                    <input
                      className="input vb-picker__label"
                      value={column.label}
                      aria-label={`Label for ${column.key}`}
                      onChange={(e) => onPatchColumn(column.key, { label: e.target.value })}
                    />
                    <select
                      className="input vb-picker__format"
                      value={column.format}
                      aria-label={`Format for ${column.key}`}
                      onChange={(e) => onPatchColumn(column.key, { format: e.target.value as ViewFormat })}
                    >
                      {VIEW_FORMATS.map((format) => (
                        <option key={format} value={format}>
                          {format}
                        </option>
                      ))}
                    </select>
                    <span className="vb-picker__move">
                      <button
                        type="button"
                        className="btn btn--system btn--sm"
                        aria-label={`Move ${column.key} left`}
                        disabled={index <= 0}
                        onClick={() => onMoveColumn(column.key, -1)}
                      >
                        ‹
                      </button>
                      <button
                        type="button"
                        className="btn btn--system btn--sm"
                        aria-label={`Move ${column.key} right`}
                        disabled={index < 0 || index >= pickerColumns.length - 1}
                        onClick={() => onMoveColumn(column.key, 1)}
                      >
                        ›
                      </button>
                    </span>
                  </div>
                </th>
              );
            })}
          </tr>
        ) : null
      }
      /**
       * ★ THE META NAMES WHICH OF THE TWO KINDS OF RUN THIS WAS, AND THAT IS NOT
       *   DECORATION. The same screen makes both: a run of the saved SQL is
       *   recorded, and a preview of an edited draft is not — because recording
       *   the draft would store a fingerprint for SQL the view does not hold. A
       *   footer that showed the duration without saying which of the two happened
       *   would leave the reader unable to tell whether the figure above it went
       *   into the run history the panel on the left is showing.
       */
      meta={
        <>
          {outcome.run.durationMs} ms
          {recorded ? ' · recorded in run history' : ' · preview, nothing recorded'}
          {outcome.run.fingerprint !== null && <> · fingerprint {outcome.run.fingerprint}</>}
        </>
      }
      emptyHint="Every column is hidden. Turn one back on under Columns."
      /**
       * What the server actually compiled, after defaults and type coercion —
       * shown rather than assumed. It belongs under the result, so it goes in the
       * grid's footnote slot rather than beside it: the grid's root is a grid with
       * a gap, and a paragraph appended outside it would take the panel's padding
       * a second time and read as an unrelated block.
       */
      footnote={
        enabled && Object.keys(outcome.run.appliedValues).length > 0 ? (
          <p className="field__hint">
            Bound:{' '}
            {Object.entries(outcome.run.appliedValues).map(([name, value], index) => (
              <span key={name}>
                {index > 0 && ', '}
                <code>
                  :{name} = {value === null ? 'NULL' : String(value)}
                </code>
              </span>
            ))}
            . Shown rather than assumed — this is what the server actually compiled, after defaults and
            type coercion.
          </p>
        ) : null
      }
    />
  );
}

/* ------------------------------------------------------------------------- *
 * Publishing
 * ------------------------------------------------------------------------- */

/**
 * One sentence per obstacle that publishing cannot clear, each naming the panel
 * on this screen that can.
 *
 * ★ `needs-value` IS AN `undefined` TEST, NOT A FALSY ONE. A parameter whose
 *   default is `null` has a default — the server's `compileParams` refuses only on
 *   `undefined` — so a view that declares `default: null` is one this panel *can*
 *   run and must not be accused of being unfillable.
 *
 * `not-active` has no entry because it is not a thing publishing cannot clear: it is
 * the thing publishing clears, so it is the heading of its own branch above rather
 * than a clause in here.
 */
const BLOCKER_SENTENCE: Record<Exclude<ViewBlocker, 'not-active'>, string> = {
  'no-key':
    'It declares no fingerprint key, and change detection compares the values of one column across ' +
    'runs — so with no key there is nothing to compare. Pick one under Display › Fingerprint key.',
  'needs-value':
    'It declares a parameter with no default, and the panel on that page has nowhere to type a value, ' +
    'so it is withheld rather than offered as a query nobody can fill in. Give the parameter a default.',
};

/**
 * Whether this view will actually be offered on `Views`, said plainly — because
 * *published* and *offered* are two different facts and only one of them is
 * something a button can change.
 *
 * ★ WHY THIS IS A SENTENCE AND NOT A TICK. The status column is the one the
 *   dropdown filters on, so it is tempting to stop there and print "Published ✓".
 *   But `Views` withholds an active view for two further reasons that publishing
 *   cannot touch: it declares no fingerprint key (nothing for change detection to
 *   compare, and the watch endpoint refuses it outright), or it declares a
 *   parameter with no default (the dropdown offers nowhere to type one). A control
 *   that announced success and left the author staring at a dropdown that still
 *   refuses their view is precisely the confident-wrong-answer failure this
 *   feature has already produced twice, in the watch payload's missing cap flag
 *   and in its count-then-truncated pair. So the readiness line reports all three
 *   states, and the two that publishing cannot fix name the panel that can.
 *
 * ★ IT TAKES THE WHOLE LIST, NOT THE FIRST OBSTACLE, AND THAT IS A FIX RATHER THAN
 *   A FLOURISH. A view can be published, keyless *and* carrying an unfilled
 *   parameter; naming only the key would have the author fix one thing, re-read the
 *   line, and discover the second — which was knowable all along, because this
 *   screen is looking straight at both. The list is read out in full.
 *
 * The rule itself lives in `viewBlockers`, shared with `SavedViews`, so the
 * dropdown's answer and this line's answer cannot drift apart.
 */
function PublishReadiness({ saved, blockers }: { saved: SavedView | null; blockers: ViewBlocker[] }) {
  const viewsLink = <Link to="/views">Views</Link>;

  // `not-active` is not an obstacle *in addition to* the status — it is the status,
  // and it heads the second branch. Everything left is an obstacle publishing
  // cannot clear, which is what the sentence map below is for.
  const hard = blockers.filter(
    (b): b is Exclude<ViewBlocker, 'not-active'> => b !== 'not-active',
  );

  // Nothing to publish yet. Said here rather than only in the button's title,
  // because a title needs a hover and the fact that a view is invisible until it
  // is published is not something to leave to a tooltip.
  if (saved === null) {
    return (
      <p className="field__hint vb-readiness">
        <strong>Not published.</strong> A view is offered on {viewsLink} only once it is active, and
        publishing is a change to a stored view — so this draft has to be saved first. The status is read
        from the row; nothing about it is inferred from whether the query has run.
      </p>
    );
  }

  if (saved.status !== 'active') {
    return (
      <p className="field__hint vb-readiness">
        <strong>{saved.status === 'disabled' ? 'Disabled' : 'Draft'} — not offered on {viewsLink}.</strong>{' '}
        {saved.status === 'disabled'
          ? 'This view was disabled deliberately, so it stays withheld until it is published again.'
          : 'The dropdown on that page offers a view once it is active, so this one is in nobody’s list.'}{' '}
        Press <strong>Publish</strong> to make it active — but that will not be enough on its own.
        {hard.length > 0 && <> {hard.map((b) => BLOCKER_SENTENCE[b]).join(' ')}</>}
      </p>
    );
  }

  if (hard.length > 0) {
    return (
      <p className="field__hint vb-readiness">
        <strong>Published, but {hard.length > 1 ? 'two things still stop' : 'one thing still stops'}{' '}
        it being offered.</strong> {viewsLink} holds back an active view for reasons publishing cannot
        touch, and it withholds rather than offering a view that would fail once somebody picked it.{' '}
        {hard.map((b) => BLOCKER_SENTENCE[b]).join(' ')}
      </p>
    );
  }

  return (
    <p className="field__hint vb-readiness">
      <strong>Published.</strong> It is offered under “Watch a view” on {viewsLink}, and it joins that
      page’s table once somebody watches it. A watch records a change the next time this view runs and
      sends nothing: there is no scheduler and no sender on this server, so a view nobody runs shows “Not
      run yet” rather than a figure.
    </p>
  );
}

/* ------------------------------------------------------------------------- *
 * Small helpers
 * ------------------------------------------------------------------------- */

/** `NET_AMOUNT` → `Net amount`, used only as a placeholder for an unset label. */
function humanise(key: string): string {
  const spaced = key.replace(/_/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}
