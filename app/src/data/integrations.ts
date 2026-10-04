/**
 * Integrations — the external endpoints this deployment is wired to.
 *
 * ── WHAT THIS IS ─────────────────────────────────────────────────────────────
 *
 * One row per outbound endpoint: a title, what it is for, the URL, and whether it
 * is meant to be live. The client half is deliberately thin — list, create,
 * update, delete, and nothing else — because the register holds four fields and
 * there is no server-side computation for a screen to re-derive.
 *
 * ── ★ WHAT THIS MODULE MUST NOT IMPLY ────────────────────────────────────────
 *
 * Nothing here calls any of these URLs, and the app has no outbound HTTP client.
 * So this module never reports whether an endpoint *works*: there is no field for
 * it and no request that could produce one. What it does carry is
 * `urlWellFormed`, which is a fact about the stored string and is computed by the
 * server, and `active`, which is what somebody decided. The screen's URL hint
 * says so in as many words.
 *
 * ★ `urlWellFormed` IS NOT RE-DERIVED HERE. The server computes it with the same
 *   function its write path validates with, so the badge and a successful save
 *   cannot disagree. A `new URL()` in this file would be a second implementation
 *   of the rule, and it would drift the first time the allowlist changed — which
 *   is exactly the failure the shared implementation exists to prevent.
 *
 * ── ★ NO SHARED FETCH HELPER, DELIBERATELY ───────────────────────────────────
 *
 * Every `data/*.ts` module in this app carries its own `request<T>`, and this one
 * matches `readCaps.ts` rather than unifying them. The duplication is real and
 * known; consolidating four dozen call sites into one helper is a change with its
 * own risk and its own review, and folding it into this feature would make an
 * integrations bug report and a transport bug report arrive as one diff.
 */

const BASE = '/api';

/** One integration, as the server stores and returns it. */
export interface Integration {
  id: number;
  title: string;
  description: string;
  url: string;
  /**
   * The stored string parses as an absolute `http`/`https` URL.
   *
   * ★ THIS IS NOT A STATUS. It says a string is well-formed, not that anything
   *   answers at the other end — see the module header. The name is the warning.
   */
  urlWellFormed: boolean;
  /** What somebody decided. On means "meant to be live", which is an intention. */
  active: boolean;
  /** The account that last wrote the row. */
  setBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface IntegrationList {
  items: Integration[];
  /** Derived by the server from the same rows, so the two cannot disagree. */
  counts: { total: number; active: number };
}

/** A refusal from the server, carrying the sentence it wrote. */
export class IntegrationError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly details: Record<string, unknown> | null;

  constructor(
    message: string,
    status: number,
    code: string | null,
    details: Record<string, unknown> | null,
  ) {
    super(message);
    this.name = 'IntegrationError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/**
 * The session token, read the way every other module here reads it.
 *
 * ★ WRAPPED, BECAUSE `localStorage` THROWS RATHER THAN RETURNS NULL when the page
 *   is loaded in a context that denies storage access. A throw here would surface
 *   as a blank screen instead of the 401 the server is about to send, which is the
 *   answer that names the problem.
 */
function token(): string | null {
  try {
    return localStorage.getItem('projects-session-token');
  } catch {
    return null;
  }
}

/**
 * One request, with the error envelope unwrapped.
 *
 * ★ THE BODY IS READ ONCE, HERE. A response body can be consumed exactly once, so
 *   reading it inside an assertion or a log and then again for the payload fails
 *   with "Body has already been used" on a request that in fact succeeded. One
 *   read, one parse, and both branches below use the same value.
 *
 * ★ A NON-JSON BODY IS NOT AN ERROR HERE. A proxy or a 502 answers HTML, and
 *   `JSON.parse` on it throws a message naming nothing about the request — so the
 *   raw text becomes the message instead, truncated because an HTML error page
 *   makes an unreadable notice.
 */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const t = token();
  if (t) headers['x-app-session'] = t;

  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers ?? {}) },
  });

  const text = await res.text();
  let payload: unknown;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }

  if (!res.ok) {
    const err = (
      payload as { error?: { message?: string; code?: string; details?: Record<string, unknown> } } | null
    )?.error;
    throw new IntegrationError(
      err?.message ?? (text.slice(0, 400) || `The request failed with ${res.status}.`),
      res.status,
      err?.code ?? null,
      err?.details ?? null,
    );
  }

  return payload as T;
}

/** Every row, newest first, with the counts. */
export async function loadIntegrations(): Promise<IntegrationList> {
  const body = await request<{ data: IntegrationList }>('/integrations');
  return body.data;
}

/** The fields a caller may write. `active` is a full replacement, never a patch. */
export interface IntegrationDraft {
  title: string;
  description: string;
  url: string;
  active: boolean;
}

export async function createIntegration(draft: IntegrationDraft): Promise<Integration> {
  const body = await request<{ data: Integration }>('/integrations', {
    method: 'POST',
    body: JSON.stringify(draft),
  });
  return body.data;
}

export async function updateIntegration(id: number, draft: IntegrationDraft): Promise<Integration> {
  const body = await request<{ data: Integration }>(`/integrations/${id}`, {
    method: 'PUT',
    body: JSON.stringify(draft),
  });
  return body.data;
}

/**
 * Remove a row.
 *
 * ★ THE ROUTE ANSWERS 200 WITH A BODY, NOT 204, AND THE REASON IS THE CLIENT. A
 *   204 has nothing to read, so a caller cannot distinguish "deleted" from
 *   "there was nothing there" — and `removed` is the field that tells them apart.
 *   `readCaps.ts` records the same choice for the same reason. The fallback below
 *   is for a deployment still on the older 204 behaviour: the delete was accepted,
 *   so `removed: true` is the honest reading.
 */
export async function deleteIntegration(id: number): Promise<{ id: number; removed: boolean }> {
  const body = await request<{ data: { id: number; removed: boolean } } | null>(
    `/integrations/${id}`,
    { method: 'DELETE' },
  );
  return body?.data ?? { id, removed: true };
}

/**
 * How a row's state reads on screen.
 *
 * ★ A WORD, NOT A COLOURED DOT. A dot is a status indicator, and this page must
 *   not render one — "Active" is the *value of a field*, which is what a register
 *   of intentions can honestly show. The server sends a boolean and this returns
 *   the word, so the two words live in one place rather than in the list, the
 *   panel and the counts line separately.
 */
export function activeWord(active: boolean): string {
  return active ? 'Active' : 'Inactive';
}

/**
 * Whether a row matches a filter term.
 *
 * ★ TITLE, DESCRIPTION AND URL — URL INCLUDED BECAUSE THAT IS WHAT PEOPLE
 *   REMEMBER. An administrator looking for the endpoint their invoice job posts
 *   to often knows the host and not the title somebody gave it, so searching the
 *   URL is the case that makes the filter useful rather than decorative.
 */
export function matchesFilter(row: Integration, term: string): boolean {
  const needle = term.trim().toLowerCase();
  if (needle === '') return true;
  return (
    row.title.toLowerCase().includes(needle) ||
    row.description.toLowerCase().includes(needle) ||
    row.url.toLowerCase().includes(needle)
  );
}
