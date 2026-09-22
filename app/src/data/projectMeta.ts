/**
 * App-native project metadata — the fields Oracle does not have.
 *
 * Oracle has no project table, so a Project in this app is a *named* account
 * level. Everything numeric about a project (lines, orders, vendors, amounts,
 * dates, status) is **derived from the extract**, never taken from here — see
 * `derive.ts`.
 *
 * ★ THIS FILE USED TO BE THE PROJECT MASTER. IT IS NOW A READER OF IT.
 *   Ten names, sites, owners and notes were transcribed into a constant here,
 *   because there was nowhere else to put them: four EBS tables model a project
 *   dimension and all four are empty, and `PROJECT_ID`/`TASK_ID` are NULL on all
 *   1,141,913 `PO_LINES_ALL` rows, so there was no link to recover either. The
 *   owner's decision of record (`00-schema.sql` section 4) is that the project
 *   master is *supplied as a separate SQLite table*, and that table now exists —
 *   `project`, created and seeded by `data/sql/turso/01-app.sql`, served by
 *   `GET /api/projects/registry`.
 *
 *   The constant was removed rather than kept as a fallback. A second copy of ten
 *   names is a second copy that goes out of step with the first, and that failure
 *   is silent: a project renamed in one place keeps its old name in the other and
 *   nothing reports it. There is now one project master, and it is a database row.
 *
 * ★ THE FALLBACK IS THE EXTRACT, NOT A CONSTANT. If the registry cannot be read
 *   the app does not lose its projects — `derive.ts` still names each level from
 *   the `DESCRIPTION` text on its own purchase-order lines, and still shows the
 *   level code. What is lost is the human annotation: the site, the owner, the
 *   note. That is the right thing to lose, and it degrades visibly, because every
 *   level's `unclaimed` flag flips to true and the table says so.
 *
 *   A level with no row in the registry is a level nobody has claimed yet. That is
 *   why `unclaimed` is a first-class state rather than a missing value: the extract
 *   has 139 levels and only ten are named.
 */

export interface ProjectMeta {
  code: string;
  name: string;
  site: string;
  owner: string;
  note: string;
}

/**
 * One row of `GET /api/projects/registry`.
 *
 * Every nullable field is nullable for one specific reason, and none of them is an
 * error. `levelCode` is null when the project has been recorded but not yet
 * associated with an account level — a first-class state, because the name arrives
 * before the coding does, and the two projects at the foot of `01-app.sql` are
 * exactly that case. `code`, `site`, `owner` and `description` are null for those
 * same rows, because nothing has been written for them yet; leaving them empty is
 * the honest rendering, and inventing a site would produce a row no reader could
 * tell from a fact.
 */
export interface RegistryRow {
  slug: string;
  name: string;
  description: string | null;
  levelCode: string | null;
  code: string | null;
  site: string | null;
  owner: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface ProjectRegistry {
  items: RegistryRow[];
  counts: { total: number; associated: number; unassociated: number };
}

/**
 * Reads the project master.
 *
 * Returns the whole envelope — `items` plus `counts` — rather than just the rows,
 * because `counts.unassociated` is a number the UI needs and recomputing it from
 * `items` would be a second definition of the same thing, free to disagree with
 * the first.
 *
 * The caller is expected to treat a rejection as survivable: see the note on
 * fallback above. The reason is lifted out of the error envelope when there is one,
 * because `DB_UNAVAILABLE` carries a written sentence saying *why* the tables are
 * absent, and "HTTP 503 Service Unavailable" does not.
 */
export async function loadProjectRegistry(signal?: AbortSignal): Promise<ProjectRegistry> {
  const res = await fetch('/api/projects/registry', { signal });
  if (!res.ok) throw await readError(res);

  const body = (await res.json()) as { data?: ProjectRegistry };
  const payload = body?.data;
  if (!payload || !Array.isArray(payload.items)) {
    throw new Error('The project registry response did not contain a list of projects.');
  }
  return payload;
}

/**
 * The project master, keyed by the account level each row claims.
 *
 * Rows with no `levelCode` are dropped, and that is the point of the two
 * unassociated projects being in the table at all: they are recorded and they are
 * visible over the API, but they claim no level, so they cannot make a level look
 * named when it is not. An empty string counts as no level, because a supplied
 * table is written by hand and `''` is what a hand-written blank looks like.
 *
 * ★ DROPPED HERE IS NOT DROPPED FROM THE PAGE. `unassociated` below returns exactly
 *   the rows this loop skips, and the Projects screen prints them in a panel of
 *   their own. This function's job is only to keep them out of the *level*-keyed
 *   maps — it is not a filter on what the user gets to see.
 *
 * Missing strings become empty strings rather than staying null so that `derive.ts`
 * can use `||` to fall through to the extract. A null would fall through too; an
 * empty string would not, and `site: null` is exactly the case the two new rows
 * are — so this is a live path, not a defensive one.
 */
export function metaByLevel(items: RegistryRow[]): Record<string, ProjectMeta> {
  const map: Record<string, ProjectMeta> = {};
  for (const row of items) {
    const level = (row.levelCode ?? '').trim();
    if (level === '') continue;
    map[level] = {
      code: row.code ?? '',
      name: row.name,
      site: row.site ?? '',
      owner: row.owner ?? '',
      note: row.description ?? '',
    };
  }
  return map;
}

/**
 * The rows with no account level yet — recorded but not coded.
 *
 * Kept apart from the rows `metaByLevel` drops on purpose. Those are not the same
 * population as the extract's unclaimed levels: an unclaimed level is a level
 * nobody has *named*, whereas one of these is a project nobody has *placed*. The
 * level-keyed views cannot represent the second state at all, which is why it needs
 * its own reader.
 *
 * ★ THE READER IS `uncodedShown` IN `state/store.tsx`, RENDERED BY THE "Recorded,
 *   not yet coded" PANEL IN `routes/Projects.tsx`. Before that panel existed this
 *   function had no caller and the two projects it returns were fetched, stored,
 *   served and displayed nowhere — a reader who was told the project existed could
 *   search for it and be shown an empty table. Removing the panel without removing
 *   this function is the same defect coming back, so the two belong together.
 */
export function unassociated(items: RegistryRow[]): RegistryRow[] {
  return items.filter((r) => (r.levelCode ?? '').trim() === '');
}

/**
 * Whether a project was recorded in this app today — the whole of the "New" badge.
 *
 * ★ IT IS A CALENDAR DAY RATHER THAN A ROLLING WINDOW, AND THAT IS THE FEATURE, NOT AN
 *   OVERSIGHT. Against this data, the twelve seeded projects were created at 18:28 UTC
 *   on the 18th and the two added since at 13:05 and 13:50 UTC on the 19th. Every
 *   window long enough to be a plausible "recently" — 24 hours, seven days — is long
 *   enough to hold both groups, so it marks all fourteen rows and stops carrying any
 *   information. Only a day boundary separates them. A badge is a claim that a row is
 *   unlike the rows around it, and a badge on every row claims nothing.
 *
 * ★ THE TIMESTAMP IS UTC; THE COMPARISON IS THE READER'S DAY. `created_at` is written
 *   by SQLite's `datetime('now')`, which is UTC, and its format carries no zone marker
 *   of its own — so one is supplied rather than assumed away. Reading the string as
 *   local (`new Date('2026-09-19 13:05:47')`), which is what a bare `new Date` does,
 *   shifts it by the reader's offset: four hours here, which is enough to move a UTC
 *   instant late in the evening onto the following calendar day and so badge rows that
 *   were created yesterday. `toDateString()` compares both instants through the same
 *   zone, so "today" means today where the reader is.
 *
 * A row with no `createdAt` is not new. It is not a row created moments ago and left
 * unstamped — it is a row whose creation was never recorded, and a badge is the last
 * thing that should be invented for it.
 */
export function addedToday(row: RegistryRow, now: Date): boolean {
  const raw = (row.createdAt ?? '').trim();
  if (raw === '') return false;
  // Already carries a zone (an ISO string from a different driver)? Trust it as it is.
  const iso = /(Z|[+-]\d{2}:?\d{2})$/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return false;
  return at.toDateString() === now.toDateString();
}

/* ---------------------------------------------------------------------------
 * Writing.
 *
 * Recording a project and coding it are two separate writes, and the client
 * mirrors that split rather than offering one form that does both. `create`
 * never sends a level — the field is not in its body at all, and the API
 * rejects nothing because there is nothing to reject. `update` is where a level
 * is attached, changed or released, and it is only ever called from the detail
 * panel of a project that already exists.
 *
 * Both return the stored row, read back from the database rather than echoed
 * from the request. That is the whole reason they return anything: the server
 * derives `slug`, trims the name, stamps `updatedAt` and nulls `code` when a
 * level is released, so an optimistic local guess would be a slightly different
 * row — and the difference would only show up on a later reload.
 * ------------------------------------------------------------------------- */

/**
 * The reason a write was refused, in the words the server chose.
 *
 * Every refusal from this API is a sentence written for a reader — "Level 0454 is
 * already held by …", "A project already exists with the key …" — and each
 * carries the offending value in `details`. The sentence already names those
 * values in prose, so `details` is not read here: appending it would print
 * "0454" twice, once inside the sentence and once after it.
 *
 * Flattening the answer to `HTTP 409` would throw away the only part a person
 * needs, and would make two very different conflicts — a duplicate name and a
 * taken level — look identical.
 *
 * A rejection that is not JSON at all (a proxy error page, a dropped connection)
 * keeps its status line, so the message is never empty.
 */
async function readError(res: Response): Promise<Error> {
  let detail = `HTTP ${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (body?.error?.message) detail = body.error.message;
  } catch {
    /* The status line stands. A body that is not JSON is not worth failing over twice. */
  }
  return new Error(detail);
}

/** What `POST /api/projects` accepts. No level, by design — see the note above. */
export interface ProjectCreate {
  name: string;
  description?: string | null;
  owner?: string | null;
}

/**
 * What `PATCH /api/projects/{slug}` accepts.
 *
 * Every field is optional because the endpoint is a partial update, and the
 * distinction `undefined` versus `null` is load-bearing: `undefined` means "do
 * not touch this column" while `levelCode: null` means "release the level". A
 * spread that collapsed the two would make every save release the project.
 */
export interface ProjectUpdate {
  name?: string;
  description?: string | null;
  site?: string | null;
  owner?: string | null;
  levelCode?: string | null;
  code?: string | null;
}

async function readRow(res: Response, what: string): Promise<RegistryRow> {
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as { data?: RegistryRow };
  const row = body?.data;
  if (!row || typeof row.slug !== 'string') {
    throw new Error(`The server ${what}, but its response did not contain the project row.`);
  }
  return row;
}

/**
 * Records a project. It has no account level when this returns, and that is the
 * expected outcome rather than an incomplete one.
 *
 * Deliberately does not send a slug: the server derives one from the name so that
 * the rule lives in one place. Two projects whose names differ only in punctuation
 * therefore collide on the server, which answers 409 naming the existing project —
 * a message this function passes through untouched.
 */
export async function createProject(body: ProjectCreate): Promise<RegistryRow> {
  return readRow(
    await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    'was asked to record a project',
  );
}

/**
 * Edits a project — including attaching or releasing its account level.
 *
 * `slug` is the identifier, never the name: a rename would otherwise move the row
 * out from under the caller, and the two projects in the registry with no level
 * have nothing else to be addressed by.
 */
export async function updateProject(slug: string, body: ProjectUpdate): Promise<RegistryRow> {
  return readRow(
    await fetch(`/api/projects/${encodeURIComponent(slug)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    'was asked to update a project',
  );
}

/**
 * Deletes a project. Removes the app's own row — and with it the project's claim
 * on an account level. Oracle is not written to, so no figure in the ledger moves.
 *
 * ★ THIS DOES NOT GO THROUGH `readRow`, AND THAT IS THE POINT OF IT BEING A
 *   FUNCTION RATHER THAN TWO LINES AT THE CALL SITE. `DELETE /api/projects/{slug}`
 *   answers 204 with no body, and `res.json()` on a 204 rejects with
 *   `SyntaxError: Unexpected end of JSON input` — a failure that arrives *after* a
 *   successful delete, so the row is gone and the screen reports an error. The
 *   check that matters is `res.ok`, and the only body worth reading is the one on
 *   the failure path.
 *
 * Returns nothing, because there is nothing to return: the row that would have
 * been handed back is the row that was just removed. The caller must re-read the
 * registry — `reloadRegistry()` — rather than dropping the row locally, for the
 * same reason every other write in this module re-reads: a local guess is what
 * makes a list disagree with its own database.
 */
export async function deleteProject(slug: string): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(slug)}`, { method: 'DELETE' });
  if (!res.ok) throw await readError(res);
}


