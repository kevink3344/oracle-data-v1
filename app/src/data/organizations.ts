/**
 * The organization register, over HTTP.
 *
 * ── WHY THIS MODULE EXISTS SEPARATELY FROM `session.ts`
 *
 * The session answers "who am I and which tenant am I in". This answers "which
 * tenants are there", and the two are deliberately different questions: a tenant is
 * readable by a super admin and writable by one, while the session a caller is
 * *in* is true of every caller. Folding the register into `session.ts` would make
 * one module that both every page depends on and only one page uses.
 *
 * ── THE THREE THINGS EVERY CALL HERE HAS TO REMEMBER
 *
 *   1. **`{ data: … }`.** `server/src/http/respond.ts` wraps every success in a
 *      `data` key. A client that reads `body.items` gets `undefined` and a page
 *      that renders "no organizations" — a wrong answer that looks like an empty
 *      table rather than a bug. So the unwrap happens once, here.
 *   2. **`x-app-session`.** All four endpoints call `requireSuperAdmin`, so the
 *      header is not optional. It comes from `sessionHeaders()` rather than being
 *      spelled here, so the header name lives in one file on this side.
 *   3. **Two different 400s.** A `VALIDATION_FAILED` came from the Zod schema
 *      (the *shape* was wrong) while a `BAD_REQUEST` came from a handler lookup
 *      (`assertFund` / `assertStartFy`, whose values are checked against
 *      `GL_CODE_COMBINATIONS` and `GL_PERIODS`). Both carry a message worth
 *      showing, and the second carries `details.accepts` — the list of values the
 *      field would have taken. `ApiError` keeps both, because "Fund 99 is not one
 *      this ledger carries" reads very differently from "expected a 2-digit
 *      string", and a form that flattens them cannot tell a person which mistake
 *      they made.
 */

import { sessionHeaders } from './session';
import type { Scope } from './scope';

/** One organization row, exactly as `toWire()` in `routes/organizations.ts` sends it. */
export interface Organization {
  id: number;
  slug: string;
  name: string;
  fund: string;
  /** The programs this tenant holds. **An empty list is legal** — see `counts.programs`. */
  programs: string[];
  startFy: number;
  /** The row marked `is_default = 1`. At most one organization has this. */
  isDefault: boolean;
  /** `Fund 04 · program 861/862/863`, formatted by the server. */
  scopeLabel: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * The list, with the two figures the endpoint computes rather than leaving to the
 * client.
 *
 * `programs` counts the organizations whose selection is empty, and it is a warning
 * rather than an error: an organization with no programs selects nothing, which
 * is a state an extract's sample data can legitimately produce. The Settings page
 * prints it for that reason and not as a validation failure.
 */
export interface OrganizationList {
  items: Organization[];
  counts: { total: number; programs: number };
}

export interface FundOption {
  fund: string;
  /** How many account combinations in the chart of accounts carry this fund. */
  combinations: number;
}

export interface ProgramOption {
  fund: string;
  program: string;
  /** How many account combinations carry this pair. */
  combinations: number;
}

export interface OrganizationOptions {
  /** Code-ordered. `00` is not among them — the endpoint drops the unresolved placeholder. */
  funds: FundOption[];
  /**
   * Every pair the chart of accounts uses. A pair is a **suggestion, not a
   * restriction**: the server validates a program for shape and not for
   * membership, so a value absent here can still be saved.
   */
  programs: ProgramOption[];
  /**
   * The range `GL_PERIODS` carries, or `null` when it holds no periods at all.
   * `null` means "the ledger has no opinion", which is why the start-FY check is
   * skipped rather than failed in that case.
   */
  fiscalYears: { earliest: number; latest: number } | null;
}

/** What `POST /api/organizations` accepts. */
export interface OrganizationCreate {
  name: string;
  fund: string;
  programs?: string[];
  startFy: number;
}

/**
 * What `PATCH /api/organizations/{slug}` accepts: **every field optional, and only
 * the ones supplied change.**
 *
 * ★ AN EMPTY PATCH IS REFUSED, AND THE SERVER IS RIGHT TO REFUSE IT. `sets.length
 *   === 0` reaches the route as `400 BAD_REQUEST — No fields were supplied.`, and
 *   the note there gives the reason: an empty update would otherwise answer `200`
 *   with a row the caller believes it edited. There is no way to express "save
 *   nothing" and no reason to want one, so the edit panel sends a **diff** and
 *   disables Save when the diff is empty rather than posting an object with no keys
 *   in it and translating the 400 back into "nothing changed".
 *
 * ★ THERE IS NO `isDefault` HERE, AND THAT IS NOT AN OMISSION. The handler only
 *   ever adds `name`, `fund`, `programs_json` and `start_fy` to its `SET` list, so
 *   a request that asked to move the default flag would change nothing and be told
 *   nothing — the worst of both. Moving the flag means clearing one row and setting
 *   another in one transaction, which the design has no control for, so the field
 *   is left out of the type rather than offered and ignored.
 */
export interface OrganizationUpdate {
  name?: string;
  fund?: string;
  programs?: string[];
  startFy?: number;
}

/**
 * A refusal with its code and details kept.
 *
 * `details` is the whole reason this is a class: `assertFund` answers
 * `{ fund: '99', accepts: ['01', '04'] }`, which is what lets the form list the
 * values that would have worked. Reading only `message` throws that away and the
 * form can then only say "no".
 */
export class ApiError extends Error {
  readonly code: string;
  readonly details: unknown;

  constructor(message: string, code: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
  }
}

/** The server's envelope, as far as this module reads it. */
interface ErrorEnvelope {
  error?: { code?: string; message?: string; details?: unknown };
}

/**
 * The envelope's message, code and details — or a status line when the body is not
 * the envelope at all (a proxy error page, a dropped connection).
 *
 * Flattening the answer to `HTTP 409` would throw away the only part a person
 * needs, and would make two very different conflicts — a duplicate name and a
 * taken level — look identical. This is the same helper `projectMeta.ts` carries,
 * widened by two fields.
 */
async function readError(res: Response): Promise<ApiError> {
  let message = `HTTP ${res.status} ${res.statusText}`;
  let code = 'HTTP_' + res.status;
  let details: unknown;
  try {
    const body = (await res.json()) as ErrorEnvelope;
    if (body?.error?.message) message = body.error.message;
    if (body?.error?.code) code = body.error.code;
    details = body?.error?.details;
  } catch {
    /* The status line stands. A body that is not JSON is not worth failing over twice. */
  }
  return new ApiError(message, code, details);
}

/** The values a lookup-based 400 says it would have accepted, if it said. */
export function acceptedValues(error: unknown): string[] {
  if (!(error instanceof ApiError)) return [];
  const details = error.details as { accepts?: unknown } | undefined;
  return Array.isArray(details?.accepts) ? details.accepts.map(String) : [];
}

/** `GET /api/organizations` — every tenant, the default first. */
export async function loadOrganizations(signal?: AbortSignal): Promise<OrganizationList> {
  const res = await fetch('/api/organizations', { headers: sessionHeaders(), signal });
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as { data?: Partial<OrganizationList> };
  const items = body?.data?.items;
  const counts = body?.data?.counts;
  if (!Array.isArray(items) || !counts) {
    throw new ApiError('The organization list answered without a list.', 'MALFORMED_RESPONSE');
  }
  return { items, counts };
}

/**
 * `GET /api/organizations/options` — the vocabulary the `+ New` form is built from.
 *
 * ★ THE SERVER SORTS AND FILTERS; THIS DOES NOT. The funds arrive code-ordered with
 *   `00` already dropped, and the pairs arrive ordered by fund then program. The
 *   form filters the pairs by the selected fund because that is a *presentation*
 *   question that changes as the user types, but it does not re-sort or re-derive
 *   anything the endpoint decided — a second implementation of "which funds are
 *   real" is how the form and the database come to disagree.
 */
export async function loadOrganizationOptions(signal?: AbortSignal): Promise<OrganizationOptions> {
  const res = await fetch('/api/organizations/options', { headers: sessionHeaders(), signal });
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as { data?: Partial<OrganizationOptions> };
  const data = body?.data;
  if (!data || !Array.isArray(data.funds) || !Array.isArray(data.programs)) {
    throw new ApiError('The options endpoint answered without a vocabulary.', 'MALFORMED_RESPONSE');
  }
  return {
    funds: data.funds,
    programs: data.programs,
    fiscalYears: data.fiscalYears ?? null,
  };
}

/**
 * `POST /api/organizations` — create one, and read back the **stored** row.
 *
 * The response is the row as the database holds it rather than an echo of what was
 * sent, which is the point: `slug` is derived server-side from the name, and a
 * client that rendered its own copy of an echo would show a URL that does not
 * exist. So the caller replaces its optimistic idea of the row with this one.
 */
export async function createOrganization(input: OrganizationCreate): Promise<Organization> {
  const res = await fetch('/api/organizations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...sessionHeaders() },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as { data?: Organization };
  if (!body?.data?.slug) {
    throw new ApiError('The organization was created but not read back.', 'MALFORMED_RESPONSE');
  }
  return body.data;
}

/**
 * `PATCH /api/organizations/{slug}` — reconfigure one, and read back the **stored** row.
 *
 * ★ `encodeURIComponent` ON A SLUG THAT IS ALREADY SAFE, AND IT STAYS. A slug is
 *   derived from a name a person typed, so it is user-influenced data even though
 *   `slugFor()` currently emits nothing but `[a-z0-9-]`. The cost of the call is
 *   nothing and it means the rule here does not depend on a regex in another file
 *   continuing to be that strict.
 *
 * ★ A 404 IS A REAL ANSWER HERE, NOT JUST A FAILURE. The row can go between the
 *   list being read and the panel being saved in — the register is not locked while
 *   a drawer is open. `AppError.notFound('Organization ' + slug)` answers code
 *   `NOT_FOUND` and the sentence `Organization <slug> was not found.`, which the
 *   panel reports as "this row is no longer there" rather than as a validation
 *   problem with the form a person is looking at. Those two are different facts and
 *   the panel keeps them apart.
 */
export async function updateOrganization(
  slug: string,
  patch: OrganizationUpdate,
): Promise<Organization> {
  const res = await fetch(`/api/organizations/${encodeURIComponent(slug)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...sessionHeaders() },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as { data?: Organization };
  if (!body?.data?.slug) {
    throw new ApiError('The organization was saved but not read back.', 'MALFORMED_RESPONSE');
  }
  return body.data;
}

/**
 * The scope a row stands for, in the shape `inScope` tests.
 *
 * The server sends `fund` and `programs` as separate fields and also a formatted
 * `scopeLabel`, and this rebuilds the first pair into the `Scope` the rest of the
 * app filters with. Rebuilding is deliberate: `scopeLabel` is prose for a reader,
 * and a label is not a predicate.
 */
export function scopeOf(organization: Organization): Scope {
  return { fund: organization.fund, programs: organization.programs };
}
