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
 *
 * ★ THE THREE BACKGROUND FIELDS ARE THE ROW'S, NOT THE IMAGE'S. A list that
 * carried the bytes would be 640 KiB per row of `SELECT *` — so the list carries
 * `hasBackground`, and the bytes come from their own endpoint on the one page that
 * draws them. `hasBackground` is a boolean and not a truthy string because the
 * server projects it as `CASE WHEN background_image IS NULL THEN 0 ELSE 1 END`;
 * nothing here may test it with `=== 1`.
 */
export interface RegistryRow {
  slug: string;
  name: string;
  description: string | null;
  levelCode: string | null;
  code: string | null;
  site: string | null;
  owner: string | null;
  /** True when this project has a picture stored against it. Never the bytes. */
  hasBackground: boolean;
  /** The uploaded file's own name, or null. Shown beside the remove control. */
  backgroundName: string | null;
  backgroundUpdatedAt: string | null;
  /**
   * How strongly the header draws the picture, as a percent 0–100, or `null`.
   *
   * ★ `null` IS NOT `0`, AND NOTHING HERE MAY COLLAPSE THEM. `0` is a choice a
   *   reader made and kept — the picture stored and deliberately not drawn. `null`
   *   is the absence of a choice, and the *drawing* answers it with the application
   *   default (`PROJECT_BACKGROUND_DEFAULT_STRENGTH`, 33, applied by `backgroundDraw`
   *   at the moment the header is drawn). The server passes the
   *   stored value through untouched for exactly this reason: a read path that
   *   answered `33` would make "never chosen" and "chosen 33" the same answer here,
   *   and a later change of default would then silently rewrite every project
   *   nobody had touched, with nothing left in the payload to say it had happened.
   */
  backgroundStrength: number | null;
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
  /**
   * How strongly the header draws this project's picture, as a percent 0–100, or
   * `null` for the application default.
   *
   * The `undefined`-versus-`null` distinction documented above is load-bearing
   * here in the same way, and with the same consequence if it is lost: absent
   * leaves the reader's choice alone where `null` discards it. `0` is a third
   * answer again — the picture held and deliberately not drawn — which is why the
   * field is not a plain `number` defaulted to 33 on the way out.
   */
  backgroundStrength?: number | null;
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

/* ===== The project's background image ===================================== */

/**
 * The four types the server will store, and the same four in the same order as
 * `BACKGROUND_TYPES` in `server/src/routes/projectRegistry.ts`.
 *
 * ★ THERE IS NO SVG, AND THAT IS NOT AN OVERSIGHT. An SVG is a document: it can
 * carry `<script>` and external references, so a stored one is stored script
 * served from this origin. Every type here is a raster format with no scripting
 * model, and the server re-checks the bytes rather than trusting this list — a
 * file renamed `.png` that is really something else is rejected by sniffing.
 */
export const PROJECT_BACKGROUND_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export type ProjectBackgroundMime = (typeof PROJECT_BACKGROUND_TYPES)[number];

/**
 * 640 KiB of **decoded** bytes — the server's `BACKGROUND_MAX_BYTES`, restated
 * here so the ceiling can be explained to a reader who has just picked a 4 MB
 * photo, rather than only after the bytes have crossed the wire.
 *
 * The number is small on purpose. This picture is a backdrop behind one header —
 * and it is drawn *through* a wash whatever strength it is set to, so there is no
 * setting at which its finest detail is what the reader is looking at. At 640 KiB
 * it is already several times more data than the whole rest of the page, and a
 * project is not a photo library. A reader who wants to keep a large picture should
 * downscale it first, and that is a thing they can do — silently re-encoding their
 * file for them is not, because the result would be a picture they did not choose.
 *
 * ★ THE TWO CEILINGS ARE NOT THE SAME NUMBER AND BOTH ARE REAL. This one is
 * measured on the file. `BACKGROUND_MAX_BASE64` on the server is 880,000 and is
 * measured on the string, because base64 costs four characters for every three
 * bytes and the body parser has to bound the *string* before it can decode it.
 */
export const PROJECT_BACKGROUND_MAX_BYTES = 640 * 1024;

/**
 * How strongly a picture is drawn when nobody has chosen — 33 percent, which is
 * what every header drew before there was a control.
 *
 * ★ IT IS A PERCENT AND NOT A FRACTION, because that is what the slider shows and
 *   what the column stores; the division into the two opacities the header actually
 *   draws happens once, in `backgroundDraw` below. A constant here holding `0.33`
 *   would be the same number in a different notation, and the rounding from one to
 *   the other is the kind of thing that turns a "default" into a "default, roughly".
 *
 * ★ THERE IS NO "NOBODY HAS CHOSEN" STATE IN THE DRAWING, AND THAT IS DELIBERATE.
 *   A `null` in the column means the reader never moved the control, and this
 *   number is the answer for that case — but the answer is applied by the *client*
 *   as it hands the stylesheet its two opacities, not on the wire. So a `null` stays
 *   a `null` in every payload that crosses the API and a later change to this
 *   constant moves every project nobody had touched, which is what a default is
 *   supposed to do. (The stylesheet keeps the same two opacities as the fallback for
 *   its custom properties; that copy exists so an unset property still draws, and
 *   `backgroundDraw` is the one that decides.)
 */
export const PROJECT_BACKGROUND_DEFAULT_STRENGTH = 33;

/**
 * The strongest a picture may be drawn — 45 percent, in the **light** theme.
 *
 * ★ THE CEILING IS NOT A TASTE JUDGEMENT, IT IS THE CONTRAST FLOOR. The picture
 *   and the wash between it and the header's text are two opacities chosen
 *   together, and the measured result is that the header's heading colour holds
 *   4.5:1 up to a visible strength of 0.45 and not beyond. This constant is that
 *   number restated as a percent so the *control* stops where the contrast does,
 *   rather than letting a reader drag past a limit the stylesheet would silently
 *   apply anyway. A control that can be moved to a position with no effect is a
 *   control that lies about what it did.
 *
 * ★ THE DARK THEME'S CEILING IS LOWER — 38 — and it is applied in the stylesheet
 *   rather than here, because it cannot be expressed as a maximum on this slider:
 *   the control is one scale, the theme is a property of the page it is drawn on,
 *   and a slider whose range changed when the theme changed would move under the
 *   reader's hand. So the reader may choose 45 and the dark header draws 38, which
 *   is the strongest dark-mode-safe value. The derivation of both numbers is in
 *   `projectpage.css`, beside the arithmetic it belongs to.
 *
 * ★ A STORED VALUE ABOVE THIS IS NOT AN ERROR AND IS NOT "CORRECTED". The API
 *   accepts 0–100, so a value of 60 is storable by any client; it simply draws the
 *   same as 45. See the note on `backgroundStrength` in `RegistryRow` for why the
 *   stored number is left as it was chosen.
 */
export const PROJECT_BACKGROUND_MAX_STRENGTH = 45;

/**
 * Puts a strength back inside the range the control can express.
 *
 * ★ THE CONTROL'S BOUND IS THE **LIGHT** THEME'S CEILING, AND THE DARK THEME'S IS
 *   NOT APPLIED HERE. Both ceilings exist (45 light, 38 dark) but only one of them
 *   can be a bound on a control: the slider is one scale and the theme is a
 *   property of the page it happens to be drawn on, so a range that changed when
 *   the reader switched themes would move under their hand. The honest split is
 *   that the reader chooses a strength and the *stylesheet* draws `min(chosen,
 *   what the surface allows)` — which is also what keeps this function free of any
 *   knowledge of theming, and therefore testable without a page.
 *
 * ★ IT CLAMPS RATHER THAN REJECTS, AND THE VALUE IT GETS MAY NOT BE ONE THE READER
 *   CHOSE. The API accepts 0–100, so a row written by a script or an earlier build
 *   can hold 60. That number is not an error and is not corrected in the row — it
 *   simply cannot be *shown* on a control that stops at 45, so it is shown as the
 *   strongest setting the control can reach, and the panel says so when it happens.
 *   (See the note in `EditProject.tsx`: the reader is told, because a readout
 *   printing 45 for a stored 60 would be the page stating a number it knows is not
 *   the one in the database.)
 */
export function clampBackgroundStrength(value: number): number {
  if (!Number.isFinite(value)) return PROJECT_BACKGROUND_DEFAULT_STRENGTH;
  return Math.min(Math.max(Math.round(value), 0), PROJECT_BACKGROUND_MAX_STRENGTH);
}

/**
 * The two opacities the header draws a picture at.
 *
 * ★ WHY THIS IS HERE AND NOT IN THE STYLESHEET, SINCE THE STYLESHEET IS WHERE IT
 *   USED TO BE. The header's legibility is governed by two numbers — the picture's
 *   own `opacity` and the alpha of the wash drawn over it — and by a third that is
 *   the only one a reader cares about: how much of the picture they actually see,
 *   which is `opacity × (1 − wash)`. The old stylesheet held the pair as two
 *   literals, so the *third* number existed nowhere and could not be moved.
 *
 *   Making the slider set that visible strength means solving `opacity = u ÷
 *   (1 − wash)` — a **division by an expression** — and CSS `calc()` cannot divide
 *   by anything but a literal. That is the whole reason the arithmetic is not in
 *   CSS: not a preference about where code belongs, a limit of the language. So one
 *   function computes the pair and the stylesheet receives it as two custom
 *   properties. The reader-facing sentence still holds — the two numbers are still
 *   chosen in exactly one place — that place has merely moved to the file that can
 *   do the sum.
 *
 * ★ THE NUMBERS, AND WHERE THEY COME FROM. The wash cannot be a constant: the
 *   picture and the wash sit *between* the header's text and the surface, so
 *   drawing the picture more strongly pushes the backdrop further from the surface
 *   and eats the text's contrast. Measured on the light theme over the stored
 *   picture — every pixel of the header box composited as the browser composites
 *   it, worst one reported — the heading colour holds 4.5:1 up to a visible
 *   strength of 0.45, where it measures 4.55:1, and holding it there takes a wash
 *   of 0.55. Two points are therefore known exactly:
 *
 *       strength 0.33 → wash 0.34, picture opacity 0.50   (what every header drew
 *                                                          before this control)
 *       strength 0.45 → wash 0.55, picture opacity 1.00   (the ceiling: the wash
 *                                                          alone is carrying the
 *                                                          text, the picture is
 *                                                          fully opaque and can go
 *                                                          no further)
 *
 *   The wash is interpolated linearly between them, which is the shape the
 *   measurement traced, and the picture's opacity is solved from it so that the
 *   reader gets exactly the strength they asked for at every position rather than
 *   approximately it. At the ceiling the solution is 1.00 — that is not a
 *   coincidence and it is why 45 is the ceiling: past it the sum demands a picture
 *   more opaque than one, and a wash past 0.55 leaves nothing to see.
 *
 * ★ BELOW 0.33 THE WASH FALLS AWAY, AND IT IS SAFE THAT IT DOES. Interpolating
 *   backwards gives a wash under 0.34, reaching 0 at a strength of about 0.14 and
 *   clamped there. A weaker picture needs less cover, not more — at zero the wash
 *   and the opacity are both zero and the header is the plain surface, which is the
 *   most legible state it has. So the floor is not a risk in the direction that
 *   matters.
 *
 * ★ THE DARK THEME IS CORRECTED IN THE STYLESHEET, BECAUSE ITS CEILING IS LOWER.
 *   The same light-toned text is being read against a darker surface, where the
 *   wash removes contrast instead of adding it, and the measured crossover is
 *   between 36 and 37: drawn raw, the dark header holds 4.64:1 at 36 and 4.47:1 at
 *   37, and only 3.35:1 at this function's ceiling of 45. The control cannot
 *   express that as a different range — it is one scale, and a slider whose end
 *   moved when the theme changed would move under the reader's hand — so the
 *   stylesheet compresses the opacity's excess above 0.5 by 45% for a dark header.
 *   That correction is zero at the default and can only ever *reduce* the picture,
 *   so it cannot push a dark header past the ceiling this function keeps it under;
 *   it restores 4.70:1 at the far end and leaves no part of the range inert.
 *   See the measured table and the arithmetic note in `projectpage.css`.
 */
export interface ProjectBackgroundDraw {
  /** `opacity` for the picture layer, 0–1. */
  opacity: number;
  /** The alpha of the surface-coloured wash drawn over it, 0–1. */
  wash: number;
}

/** The visible strength at which today's pair was measured — the calibration point. */
const WASH_CALIBRATION_STRENGTH = PROJECT_BACKGROUND_DEFAULT_STRENGTH / 100;
/** The wash measured at that point, and at the ceiling. */
const WASH_AT_CALIBRATION = 0.34;
const WASH_AT_CEILING = 0.55;
const STRENGTH_AT_CEILING = PROJECT_BACKGROUND_MAX_STRENGTH / 100;

export function backgroundDraw(percent: number): ProjectBackgroundDraw {
  const u = clampBackgroundStrength(percent) / 100;

  // The wash the measurement requires at this strength, as a straight line through
  // the two measured points, floored at zero because a negative alpha is not a wash.
  const slope = (WASH_AT_CEILING - WASH_AT_CALIBRATION) / (STRENGTH_AT_CEILING - WASH_CALIBRATION_STRENGTH);
  const wash = Math.min(Math.max(WASH_AT_CALIBRATION + (u - WASH_CALIBRATION_STRENGTH) * slope, 0), WASH_AT_CEILING);

  // ★ SOLVED, NOT GUESSED. `u = opacity × (1 − wash)` rearranged; the `min` at 1 is
  //   unreachable for any strength this function accepts and is here so that a
  //   future change to either constant cannot produce an opacity above 1, which
  //   would clamp silently in the browser and make the drawn strength a number
  //   neither of these constants says.
  const opacity = Math.min(u / (1 - wash), 1);

  return { opacity, wash };
}

/** The bytes and type of one uploaded picture, ready to be sent. */
export interface ProjectBackgroundUpload {
  /** Base64 of the decoded file, with no `data:` prefix and no line breaks. */
  data: string;
  mime: ProjectBackgroundMime;
  name: string;
}

/** One stored picture, as the endpoint that serves the bytes returns it. */
export interface ProjectBackgroundImage {
  /** A `data:` URL, ready to be assigned to a CSS `background-image`. */
  url: string;
  mime: string;
  name: string | null;
  updatedAt: string | null;
  /** The decoded size the server actually holds. */
  bytes: number;
}

/**
 * Turns a chosen file into the payload the upload endpoint wants, or explains why
 * it cannot.
 *
 * ★ THE BYTE CEILING IS CHECKED HERE AND AGAIN ON THE SERVER, AND NEITHER CHECK
 * IS REDUNDANT. This one exists so a 12 MB photo is refused in the time it takes
 * to read it rather than by a request that carries it to Azure first; the
 * server's exists because this code runs on a machine the server cannot see, and
 * a browser is not a policy.
 *
 * ★ THE DECODED LENGTH IS MEASURED FROM THE BASE64, NOT FROM `file.size`. They
 * are the same number when the round trip is honest, so checking the base64 is
 * what proves the round trip was — `file.size` only says what was *offered*. The
 * server re-decodes and bounds the same payload, so the two agree by construction
 * rather than by assumption.
 */
export async function readProjectBackgroundFile(file: File): Promise<ProjectBackgroundUpload> {
  const mime = file.type;
  if (!isProjectBackgroundMime(mime)) {
    throw new Error(
      `${file.name || 'That file'} is ${mime || 'of an unknown type'}. ` +
        `A project picture has to be ${listProjectBackgroundTypes()} — an SVG is a ` +
        `document that can run script, so it is not accepted.`,
    );
  }
  if (file.size > PROJECT_BACKGROUND_MAX_BYTES) {
    throw new Error(
      `${file.name || 'That file'} is ${formatKiB(file.size)}, over the ` +
        `${formatKiB(PROJECT_BACKGROUND_MAX_BYTES)} ceiling. Downscale it and try again — ` +
        `the picture is a faint wash behind one header, so nothing is gained by sending more.`,
    );
  }

  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error(`${file.name || 'That file'} could not be read.`));
    reader.readAsDataURL(file);
  });

  const comma = url.indexOf(',');
  const data = comma >= 0 ? url.slice(comma + 1) : '';
  if (!data) throw new Error(`${file.name || 'That file'} read back empty.`);

  const decoded = atob(data).length;
  if (decoded === 0) {
    throw new Error(`${file.name || 'That file'} is empty — there is nothing to store.`);
  }
  if (decoded > PROJECT_BACKGROUND_MAX_BYTES) {
    throw new Error(
      `${file.name || 'That file'} decodes to ${formatKiB(decoded)}, over the ` +
        `${formatKiB(PROJECT_BACKGROUND_MAX_BYTES)} ceiling.`,
    );
  }

  return { data, mime, name: (file.name || 'picture').slice(0, 200) };
}

export function isProjectBackgroundMime(value: string): value is ProjectBackgroundMime {
  return (PROJECT_BACKGROUND_TYPES as readonly string[]).includes(value);
}

/** The accepted types as prose, so a message and a control cannot list different ones. */
export function listProjectBackgroundTypes(): string {
  return PROJECT_BACKGROUND_TYPES.map((t) => t.slice('image/'.length).toUpperCase()).join(', ');
}

function formatKiB(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/**
 * Stores a picture against a project.
 *
 * PUT, not POST: a project has at most one background, so naming the resource and
 * replacing it is the honest verb. The reply is the project row itself, so the
 * caller can re-read the registry rather than guess what changed.
 *
 * Like every other write in this module the caller is expected to reload from the
 * server afterwards — see the note on `updateProject`.
 */
export async function uploadProjectBackground(
  slug: string,
  upload: ProjectBackgroundUpload,
): Promise<RegistryRow> {
  const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/background`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(upload),
  });
  return readRow(res, 'was asked to store a project picture');
}

/**
 * Removes a project's picture.
 *
 * ★ THIS RETURNS `void` AND NEVER CALLS `res.json()`, for the same measured
 * reason as `deleteProject` above: the endpoint answers 204 with no body, and
 * reading the body of a successful delete throws `SyntaxError: Unexpected end of
 * JSON input` — a failure reported *after* the write has already happened.
 */
export async function clearProjectBackground(slug: string): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/background`, { method: 'DELETE' });
  if (!res.ok) throw await readError(res);
}

/**
 * Reads a project's stored picture.
 *
 * The bytes travel as base64 inside JSON rather than as `image/png`, because the
 * row also carries the name and the timestamp and a browser cannot read headers
 * off a `background-image`. The ceiling is 640 KiB, so the cost of the encoding
 * is bounded by construction.
 */
export async function loadProjectBackground(slug: string, signal?: AbortSignal): Promise<ProjectBackgroundImage> {
  const res = await fetch(`/api/projects/${encodeURIComponent(slug)}/background`, { signal });
  if (!res.ok) throw await readError(res);

  const body = (await res.json()) as {
    data?: { mime?: string; name?: string | null; updatedAt?: string | null; bytes?: number; data?: string };
  };
  const payload = body?.data;
  if (!payload || typeof payload.data !== 'string' || typeof payload.mime !== 'string') {
    throw new Error('The project picture response did not contain an image.');
  }
  return {
    url: `data:${payload.mime};base64,${payload.data}`,
    mime: payload.mime,
    name: payload.name ?? null,
    updatedAt: payload.updatedAt ?? null,
    bytes: Number.isFinite(payload.bytes) ? Number(payload.bytes) : 0,
  };
}


