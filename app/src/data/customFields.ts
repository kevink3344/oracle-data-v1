import { useCallback, useEffect, useState } from 'react';
import { sessionHeaders } from './session';

/**
 * Custom values for the fields a reader may override, and the two writes that set
 * and clear one.
 *
 * ── WHAT THIS IS, IN ONE PARAGRAPH ─────────────────────────────────────────
 *
 * The ledger is read-only, and some of the values in it are worse than useless to
 * a person trying to find a row: `PO_VENDORS` holds a company whose name runs to
 * 123 characters and one that begins with two spaces and a lowercase `c`. So the
 * application keeps its own table of *labels* — one value per field of one subject —
 * and this module is the client's whole view of it. An override is a **label**,
 * never a key: the ledger's value still finds the row, still groups it and still
 * builds its links, which is why the two live side by side on the payload rather
 * than one replacing the other.
 *
 * ── ★ THE TWO ANSWERS THIS MODULE MUST NEVER CONFUSE ───────────────────────
 *
 * "Nothing is overridden" and "I could not find out" are different facts, and the
 * read endpoint is built to keep them apart: a subject with no rows answers `200`
 * with an empty list, deliberately — *"an empty-subject read is an empty list, not a
 * 404"* (`docs/plans/custom-table-fields.md`). This module keeps that apart one
 * level up. {@link loadOverrides} answers `null` when the **read failed** and a
 * `CustomFieldRead` with `overrides: []` when the server said there are none, and
 * {@link useOverrides} reports the difference as `state`, because a page that
 * rendered a failed read as "no custom names" would show the ledger's value for a
 * company somebody had renamed — and the reader would have no way to tell that from
 * a name nobody had touched.
 *
 * ★ WHICH IS WHY THE FALLBACK IS NOT AN EMPTY LIST, THE WAY `loadMaster`'s IS.
 *   `loadMaster` answering `null` for "not found" is right because its caller prints
 *   the absence — *"no master record on this tenant under that exact name"*. The same
 *   shape here would be a lie of omission: the caller does not print "no custom
 *   value", it prints the ledger's value, which is exactly what the override exists
 *   to replace. So `null` means "cannot say", and a page carrying it must say so in
 *   words. Both pages that read this do.
 */

/**
 * One stored override, as the read and write endpoints report it.
 *
 * `value` is the custom value and `setBy`/`setAt` are the attribution — who set it
 * and when, in the database's own words. The attribution is not decoration: it is
 * the entire reason any signed-in user may write here rather than a super admin
 * only, because a custom name nobody is answerable for is worse than the ledger's.
 */
export interface FieldOverride {
  /** `'vendor'` today. The registry's own spelling, never the caller's. */
  subject: string;
  /** `'name'` today. The column on the register's payload, not a display name. */
  field: string;
  /**
   * The subject's identity, folded — for a vendor, the name uppercased with every
   * non-alphanumeric character removed. **This is what a row is matched on**, and it
   * is the same fold the client's `vendorKeyOf` produces, which is the only reason an
   * override can be found at all.
   */
  key: string;
  /**
   * The key as the person wrote it into the register, kept by the server so an
   * override whose company has left the register can still be shown as something a
   * reader recognises rather than as `ARENAPLACECONDOMINIUM…`. `null` on a row
   * stored before that column existed; the folded `key` is then all there is.
   */
  written: string | null;
  value: string;
  setBy: string;
  /**
   * When, as `YYYY-MM-DD HH:MM:SS` in **UTC** — `datetime('now')` on the database,
   * never a timestamp this application computed. Read it through
   * {@link whenLabel}, which says the zone out loud.
   */
  setAt: string;
}

/**
 * One field a reader may override, as the registry declares it.
 *
 * ★ THIS ARRIVES FROM THE SERVER RATHER THAN BEING DECLARED HERE, AND THAT IS THE
 *   POINT OF THE READ CARRYING IT. The set of overridable fields, their labels and
 *   their limits live in exactly one place (`server/src/custom-fields/registry.ts`),
 *   and a second copy in the client is how the two come to disagree — the pencil
 *   would offer an edit the route refuses, or refuse a value the route would take.
 *   So the component reads this and offers no pencil at all when the read failed,
 *   which is also the only honest thing it could do: it cannot know the limit.
 */
export interface OverridableField {
  subject: string;
  field: string;
  /** A noun phrase for one record of this subject: "this vendor site". */
  subjectWord: string;
  /** A noun phrase a person would say: "vendor name". */
  label: string;
  maxLength: number;
  /**
   * Whether the register carries a column for this field at all.
   *
   * ★ THIS IS WHAT SEPARATES "THE LEDGER HAS A VALUE AND YOU REPLACED IT" FROM
   *   "THERE IS NO LEDGER VALUE". {@link EditableField} prints a different
   *   sentence for each, and the empty string is a real value in the second case
   *   rather than a missing one — so the fact cannot be inferred from the value.
   */
  fromLedger: boolean;
  /** One sentence for the tooltip: what the override does *not* do. */
  effect: string;
}

/** What `GET /api/custom-fields` answers, once `{ data: … }` is stripped. */
export interface CustomFieldRead {
  overrides: FieldOverride[];
  fields: OverridableField[];
  subjects: string[];
}

const API = '/api/custom-fields';

/**
 * The reason a request was refused, in the words the server chose.
 *
 * The same flattening `projectMeta.ts` and `vendorSites.ts` do, and for the same
 * reason: every refusal this API produces is a sentence written for a reader — *"A
 * custom vendor name may be at most 120 characters, and this one is 143."* — and it
 * is the only place that number appears. Replacing it with `HTTP 400` would throw
 * away the one thing the person can act on.
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

/** `${subject}/${field}`, escaped for a path. The pair is the route's identity. */
function pairPath(subject: string, field: string): string {
  return `${API}/${encodeURIComponent(subject)}/${encodeURIComponent(field)}`;
}

/**
 * Every override this server holds for one subject, plus the registry entries that
 * say which fields of it may carry one.
 *
 * **`null` means the read failed, and an empty `overrides` array means the server
 * holds none.** The two are not interchangeable — see the module note — and the
 * caller that cannot tell them apart will print a ledger value for a company that
 * has a custom name.
 *
 * An abort rethrows rather than answering `null`: an aborted request has no result,
 * and reporting it as a failure to read would have the page announce a problem that
 * was only the user navigating away.
 */
export async function loadOverrides(
  subject: string,
  signal?: AbortSignal,
): Promise<CustomFieldRead | null> {
  const url = `${API}?subject=${encodeURIComponent(subject)}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: sessionHeaders(), signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
  if (!res.ok) return null;
  let payload: unknown;
  try {
    const body = (await res.json()) as { data?: Partial<CustomFieldRead> };
    payload = body?.data;
  } catch {
    return null;
  }
  if (!payload || !Array.isArray((payload as CustomFieldRead).overrides)) return null;
  const read = payload as CustomFieldRead;
  return {
    overrides: read.overrides,
    fields: Array.isArray(read.fields) ? read.fields : [],
    subjects: Array.isArray(read.subjects) ? read.subjects : [],
  };
}

/**
 * Set or replace one custom value, and answer the stored row.
 *
 * ★ `PUT`, AND THE CLIENT COULD NOT HAVE CHOSEN BETWEEN A CREATE AND A REPLACE.
 *   Whether this pair already has a value is a fact the server holds and this side
 *   does not reliably know — the panel may have been open across another reader's
 *   save. A `POST` that turned out to be the second save would either duplicate the
 *   row or answer `409`, so the route is a `PUT` and the database decides. Nothing
 *   here reads a `404`, because a `PUT` has none.
 *
 * The row that comes back is read from the database after the write, not echoed
 * from the request, so `setBy` and `setAt` are the ones actually stored.
 */
export async function saveOverride(
  subject: string,
  field: string,
  key: string,
  value: string,
): Promise<FieldOverride> {
  const res = await fetch(pairPath(subject, field), {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...sessionHeaders() },
    body: JSON.stringify({ key, value }),
  });
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as { data?: FieldOverride };
  const row = body?.data;
  if (!row || typeof row.value !== 'string') {
    throw new Error('The server saved the custom value, but its response did not contain the row.');
  }
  return row;
}

/**
 * Drop one custom value, so the register shows what the ledger holds again.
 *
 * ★ `res.ok` ONLY — THERE IS NO BODY TO READ. A `204` has no content, and
 *   `res.json()` on it rejects with `SyntaxError: Unexpected end of JSON input`
 *   *after* a successful delete — an error raised by the confirmation rather than by
 *   the act. `projectMeta.ts` records the same thing about `deleteProject`.
 *
 * A missing row is a `404`, and it is not swallowed: two readers clearing the same
 * name is a real thing to be told about, and the message names the company.
 */
export async function deleteOverride(
  subject: string,
  field: string,
  key: string,
): Promise<void> {
  const res = await fetch(`${pairPath(subject, field)}?key=${encodeURIComponent(key)}`, {
    method: 'DELETE',
    headers: sessionHeaders(),
  });
  if (!res.ok) throw await readError(res);
}

/** One subject's overrides, and whether the read that produced them worked. */
export interface OverrideState {
  /** Every override the server holds for this subject. Empty is a real answer. */
  rows: FieldOverride[];
  /** The registry entries for the subject — which fields may carry an override. */
  fields: OverridableField[];
  /**
   * `'loading'` before the first answer, `'ready'` when the server answered,
   * `'failed'` when it did not. **A page must render something different for
   * `'failed'` than for `'ready'` with no rows** — see the module note.
   */
  state: 'loading' | 'ready' | 'failed';
  /** Why the read failed, in words a reader can act on. `null` unless `'failed'`. */
  problem: string | null;
  /** Re-read the subject. Called after a write, so the screen shows stored values. */
  reload: () => void;
}

/**
 * One subject's overrides, read once and re-read on demand.
 *
 * ★ THE WRITES DO NOT UPDATE LOCAL STATE; THEY RE-READ. Everything here is a
 *   *label*, and a label that is wrong is worse than one that is missing: a screen
 *   that showed a custom name from a local guess would agree with itself and
 *   disagree with the next page the reader opened. `reload` after every successful
 *   save and clear, and the display follows the server — including when the write
 *   was accepted and a *later* read disagrees, which is the one case a local update
 *   could never show.
 *
 * ★ AND IT DOES NOT RE-READ ON A TIMER OR ON FOCUS. The override table is written by
 *   the people reading the same page; nothing else changes it, so a background poll
 *   would buy nothing and cost a request per open panel. A stale value is possible —
 *   two readers with the same company open — and the answer to that is that the
 *   second save wins and the first reader sees it on their next write, not that the
 *   page polls.
 */
export function useOverrides(subject: string): OverrideState {
  const [rows, setRows] = useState<FieldOverride[]>([]);
  const [fields, setFields] = useState<OverridableField[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [problem, setProblem] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    // ★ ONLY THE FIRST READ GOES BACK TO 'loading'. A re-read happens on every write,
    //   and blanking the page for the duration of a request would remove the pencil
    //   that was just pressed — so the focus its handler restores would have nowhere
    //   to land, and every custom name on the page would flicker back to the
    //   ledger's for as long as the request took. The last good read stays up until
    //   the new one arrives; a failure still replaces it with nothing, below.
    if (attempt === 0) setState('loading');
    loadOverrides(subject, controller.signal)
      .then((read) => {
        if (controller.signal.aborted) return;
        if (!read) {
          // ★ THE ROWS ARE CLEARED AS WELL AS THE STATE. Leaving the last good read in
          //   place beside a "could not be re-read" notice would put values on screen
          //   the page can no longer vouch for.
          setRows([]);
          setFields([]);
          setState('failed');
          setProblem(
            'Custom values could not be read, so nothing below is a custom value — what is ' +
              'shown is the ledger’s own, or blank. A custom value saved earlier is not lost; ' +
              'it is not being shown.',
          );
          return;
        }
        setRows(read.overrides);
        setFields(read.fields);
        setState('ready');
        setProblem(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setRows([]);
        setFields([]);
        setState('failed');
        setProblem(err instanceof Error ? err.message : String(err));
      });
    return () => controller.abort();
  }, [subject, attempt]);

  return { rows, fields, state, problem, reload };
}

/**
 * The override for one field of one subject, or `null`.
 *
 * The lookup is on the **folded key**, matched exactly against the stored
 * `subject_key` — never by re-folding the stored or the displayed value here. The
 * fold is applied once, by whoever wrote the row, and this side only compares;
 * a second fold on the read path is how a row stops matching the thing it was
 * written for, silently, with the override still sitting in the table.
 *
 * Reads only when the state is `'ready'`: while loading and after a failure the
 * honest answer is "there is nothing to show", and the page says why.
 */
export function overrideFor(
  read: OverrideState,
  field: string,
  key: string,
): FieldOverride | null {
  if (read.state !== 'ready') return null;
  return read.rows.find((o) => o.field === field && o.key === key) ?? null;
}

/**
 * Every custom value for one field, keyed by the folded subject key.
 *
 * For a page that shows a *list* of subjects: the alternative is a lookup per row
 * inside a render, which is the same `find` over the same array 55 times. Hand this
 * to a decorator in the register's own data module (`applyCustomNames` in
 * `vendors.ts`), which is where the decision about what the value replaces belongs.
 */
export function customLabels(read: OverrideState, field: string): Map<string, string> {
  const out = new Map<string, string>();
  if (read.state !== 'ready') return out;
  for (const o of read.rows) if (o.field === field) out.set(o.key, o.value);
  return out;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * `2026-09-20 16:12:09` read as **`20 Sep 2026, 16:12 UTC`**.
 *
 * ★ THE ZONE IS PRINTED BECAUSE IT IS NOT THE READER'S. `datetime('now')` on the
 *   database is UTC and the string carries no offset, so `new Date(…)` on it — or
 *   `new Date('2026-09-20 16:12:09')` — would read it in whatever zone the browser
 *   happens to be in and print a time four or five hours away from the one stored,
 *   with nothing on screen to say which. The string is therefore cut up rather than
 *   parsed: no zone is applied because none was stored.
 *
 * A stamp of any other shape is returned unchanged, which is honest — it says what it
 * is — rather than being rendered into a wrong time that looks right.
 */
export function whenLabel(setAt: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(setAt ?? '');
  if (!m) return setAt ?? '';
  const month = MONTHS[Number(m[2]) - 1] ?? m[2];
  return `${Number(m[3])} ${month} ${m[1]}, ${m[4]}:${m[5]} UTC`;
}
