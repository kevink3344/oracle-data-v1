/**
 * The user register, over HTTP.
 *
 * ── WHY THIS IS A SEPARATE MODULE FROM `organizations.ts`
 *
 * The two registers are read by the same screen and written by the same role, and
 * they are the same *shape* of problem — a list, a create, a patch, a lookup-based
 * 400. That is exactly why they are two modules: the shape is shared, the subject
 * is not, and merging them would give one file that answers "which tenants exist"
 * and "who is in them" and has to be read in full to change either.
 *
 * `ApiError` is imported from `./organizations` rather than declared here, and the
 * reason is in that module's own note on the class: it carries `code` and
 * `details` beside the message, and a second implementation of it would be a
 * second thing for a reader to learn. `readError` is local, because that is what
 * `savedViews.ts` does and because the message it builds is per-endpoint.
 *
 * ── THE THREE THINGS EVERY CALL HERE HAS TO REMEMBER
 *
 *   1. **`{ data: … }`.** `server/src/http/respond.ts` wraps every success in a
 *      `data` key. A client that reads `body.items` gets `undefined` and a page
 *      that renders "no accounts" — a wrong answer that looks like an empty
 *      register rather than a bug. So the unwrap happens once, here.
 *   2. **`x-app-session`.** Every route here calls `requireSuperAdmin`, so the
 *      header is not optional. It comes from `sessionHeaders()` rather than being
 *      spelled here, so the header name lives in one file on this side.
 *   3. **Two different 400s.** A `VALIDATION_FAILED` came from the Zod schema (the
 *      *shape* was wrong — a name of 0 characters, a password of 7) while a
 *      `BAD_REQUEST` came from a handler check (`organizations` naming an
 *      organization that is not in the register, or a primary that is not among
 *      the memberships). Both carry a message worth showing, and the second
 *      carries `details` describing exactly what was wrong with the set.
 *
 * ── ★ WHAT THIS MODULE CANNOT SEE
 *
 * No password and no password hash. The server's query computes `hasPassword` in
 * SQL and never selects the column, so there is no field here to accidentally
 * render. {@link setUserPassword} takes a password as an argument and gets a user
 * back — the value never appears in a response, on any route, on any path.
 */

import { ApiError } from './organizations';
import { sessionHeaders, type Role } from './session';

/**
 * One organization an account belongs to.
 *
 * ★ `slug` IS HERE BESIDE `id` BECAUSE IT IS THE STABLE KEY. The id is what the
 *   write endpoints take, but the slug is what a link to a tenant is built from,
 *   so it keeps working after somebody renames the organization. Both are sent;
 *   the screen shows the name and links by the slug.
 */
export interface UserOrganization {
  id: number;
  slug: string;
  name: string;
  /**
   * Whether this is the organization the account **signs in to**.
   *
   * Exactly one entry of exactly one account's list carries `true`, and that list
   * is never empty. Neither is a database constraint — `app_user.organization_id`
   * is a column on one table and the set is rows in another, with nothing tying
   * them together — so both are held by the write endpoints, and this flag is the
   * server's answer to "which one is it" rather than something to be derived here
   * by comparing ids.
   */
  isPrimary: boolean;
}

/** One account, exactly as `toWire()` in `routes/users.ts` sends it. */
export interface AppUser {
  id: number;
  /** Lower-cased on write, and the key sign-in looks the row up by. */
  email: string;
  /** The display name — what the header and the avatar show. */
  name: string;
  role: Role;
  /** The organization this account signs in to. See {@link UserOrganization.isPrimary}. */
  primaryOrganizationId: number | null;
  /** Every organization the account belongs to, name-ordered. At least one entry. */
  organizations: UserOrganization[];
  /**
   * Whether `password_hash` holds a value.
   *
   * ★ `false` MEANS THE ACCOUNT CANNOT BE SIGNED IN TO YET, WHATEVER ITS ROLE SAYS.
   *   `authenticate()` refuses a row with no hash rather than treating it as "no
   *   password required" — the safe direction, and the reason this flag is worth
   *   showing. The hash itself is not in this object and cannot be.
   */
  hasPassword: boolean;
  createdAt: string;
  /**
   * When the account was last signed in to, or `null` for never.
   *
   * ★ "NEVER" AND "LONG AGO" ARE DIFFERENT FACTS, which is why this is nullable
   *   rather than defaulted to the creation date. A created account nobody has
   *   used yet is the one an administrator acts on, and asserting it as never-used
   *   is the whole reason the server writes this before sending the reply.
   */
  lastSeenAt: string | null;
}

/**
 * What each role reaches.
 *
 * ★ THIS IS AUTHORED ON THE SERVER AND PRINTED HERE, AND THE DIRECTION MATTERS.
 *   The screen does not decide what a role can do; it renders the sentences the
 *   server sent. A client that wrote its own copy of the rule would be a second
 *   permission model, and the way two permission models drift is that one of them
 *   is wrong on the day somebody asks.
 */
export interface RoleCapability {
  role: Role;
  /** What to call the role on screen. */
  label: string;
  /** One sentence, for the row below the role name. */
  summary: string;
  /** What the role reaches, stated positively. */
  grants: string[];
  /**
   * What it does not reach, stated rather than left to subtraction.
   *
   * ★ "NOT IN THE OTHER LIST" IS A DIFFERENT FACT FROM "WITHHELD", and only one of
   *   them stays true when a role gains a capability. This list is printed under
   *   its own heading so that a reader comparing two roles reads two statements
   *   rather than doing arithmetic on one.
   */
  withholds: string[];
}

/** The figures the endpoint computes rather than leaving to the client. */
export interface UserCounts {
  total: number;
  superAdmins: number;
  /** Recorded, and granting nothing beyond what a staff account already reaches. */
  administrators: number;
  staff: number;
  /**
   * Accounts with no sign-in organization, which **cannot sign in**.
   *
   * A number to act on rather than a statistic. The write endpoints refuse to
   * produce this state; a row can be in it because it predates them, or because
   * `npm run set:password` created it before it wrote memberships.
   */
  unassigned: number;
  /** Accounts with no password. Unable to sign in for the other reason. */
  withoutPassword: number;
}

/** `GET /api/users` — the register, with everything the screen needs to render it. */
export interface UserList {
  items: AppUser[];
  counts: UserCounts;
  /**
   * The address the bootstrap account answers to, or `null` when none is set.
   *
   * ★ IT IS SENT SO THE SCREEN CAN NAME THE ACCOUNT THAT IS NOT IN `items`.
   *   `SUPER_ADMIN_EMAIL` is checked before `app_user` is read, so that address
   *   signs in and has no row — which means the register and the counts both leave
   *   it out. A screen that showed a list and a count without saying why would be
   *   inviting the reader to notice the discrepancy and have nowhere to take it.
   *   `null` is a real answer: with the variable unset there is no bootstrap
   *   account at all, and `POST` stops refusing that address.
   */
  bootstrapEmail: string | null;
  /**
   * The vocabulary, most privileged first.
   *
   * ★ THE ORDER IS THE SERVER'S, NOT THIS CLIENT'S. It is the order a picker should
   *   offer, so that a control which defaults to its first entry defaults to the
   *   most privileged one — a thing to be aware of rather than to accept by
   *   accident. The screen applies the default itself and says what it is.
   */
  roles: Role[];
  capabilities: RoleCapability[];
}

/**
 * What `POST /api/users` accepts.
 *
 * ★ `organizations` IS REQUIRED AND NON-EMPTY, AND `primaryOrganizationId` IS NOT.
 *   An account has to belong to at least one organization — one that belongs to
 *   none could sign in and then have no data to show, which is why the sign-in
 *   path refuses it rather than falling back to the default tenant. With a single
 *   membership there is exactly one organization it could sign in to, so naming it
 *   adds nothing; with several there is no rule that would choose, so it is
 *   required. That is a conditional requirement, which is why the type cannot
 *   express it and the server's 400 does.
 */
export interface UserCreate {
  email: string;
  name: string;
  /** Defaults to `staff` on the server — the role that grants least. */
  role?: Role;
  /** One or more organization ids. The order is not significant. */
  organizations: number[];
  /** Required when more than one organization is named. */
  primaryOrganizationId?: number;
  /** The account's **first** password. 8 characters minimum. Never returned. */
  password: string;
}

/**
 * What `PATCH /api/users/{id}` accepts: **every field optional, and only the ones
 * supplied change.**
 *
 * ★ AN EMPTY PATCH IS REFUSED. The server answers `400 BAD_REQUEST — No fields
 *   were supplied.` with `details.accepts` naming the four fields it would have
 *   taken, because an empty update would otherwise answer `200` with a row the
 *   caller believes it edited. The edit panel sends a **diff** for that reason and
 *   disables Save when the diff is empty, rather than posting `{}` and translating
 *   the 400 back into "nothing changed".
 *
 * ★ THERE IS NO `password` HERE, AND THAT IS NOT AN OMISSION. Setting a password
 *   has its own route because it is a different act: it does not need the old one,
 *   it does not return the row's new state, and it leaves already-issued sessions
 *   working. Folding it into this type would make a name change and a credential
 *   change the same request.
 *
 * ★ `organizations` REPLACES THE WHOLE SET. It is not a merge — the server deletes
 *   and re-inserts, then re-reads and refuses if the store disagrees. A caller
 *   appending one organization has to send the full list it wants to end up with.
 */
export interface UserUpdate {
  name?: string;
  role?: Role;
  /** The complete new membership set. At least one id. */
  organizations?: number[];
  /**
   * The organization the account signs in to.
   *
   * ★ `null` IS REFUSED BY THE SERVER, which is why it is not in this type. An
   *   account with no sign-in organization cannot sign in, so clearing it is not a
   *   thing a PATCH is allowed to do however it is spelled. Omit the field to
   *   leave the current one alone.
   */
  primaryOrganizationId?: number;
}

/* ------------------------------------------------------------------------- *
 * Reads
 * ------------------------------------------------------------------------- */

/**
 * The server's refusal, with its code — or the status line when the body is not
 * the envelope.
 *
 * Flattening the answer to `HTTP 409` would throw away the only part a person
 * needs, and would make two very different conflicts — the bootstrap address and
 * a taken address — look identical. Same helper as `organizations.ts` and
 * `savedViews.ts`.
 */
async function readError(res: Response): Promise<ApiError> {
  let message = `HTTP ${res.status} ${res.statusText}`;
  let code = `HTTP_${res.status}`;
  let details: unknown;
  try {
    const body = (await res.json()) as {
      error?: { code?: string; message?: string; details?: unknown };
    };
    if (body?.error?.message) message = body.error.message;
    if (body?.error?.code) code = body.error.code;
    details = body?.error?.details;
  } catch {
    /* The status line stands. A body that is not JSON is not worth failing over twice. */
  }
  return new ApiError(message, code, details);
}

/**
 * The `data` field of an envelope, or a refusal naming what was missing.
 *
 * A response that arrived with a 200 and no `data` is a shape disagreement between
 * this client and the server, which is worth saying out loud rather than showing as
 * an empty register — an empty register is what "there are no accounts" looks like,
 * and that state is not reachable through this API, because the bootstrap account
 * always exists behind it.
 */
function unwrap<T>(body: unknown, what: string): T {
  const data = (body as { data?: T } | null)?.data;
  if (data === undefined) {
    throw new ApiError(
      `The server answered without a \`data\` field, so there is no ${what} to show.`,
      'MALFORMED_RESPONSE',
    );
  }
  return data;
}

/** `GET /api/users` — every account, name-ordered, with the counts and the capability table. */
export async function loadUsers(signal?: AbortSignal): Promise<UserList> {
  const res = await fetch('/api/users', { headers: sessionHeaders(), signal });
  if (!res.ok) throw await readError(res);
  const data = unwrap<Partial<UserList>>(await res.json(), 'user register');
  if (!Array.isArray(data.items) || !data.counts || !Array.isArray(data.roles)) {
    throw new ApiError(
      'The user register answered without a list, a count or a role vocabulary.',
      'MALFORMED_RESPONSE',
    );
  }
  return {
    items: data.items,
    counts: data.counts,
    // ★ ABSENT BECOMES `null`, WHICH IS THE HONEST READING. A server that predates
    //   this field, and a server with no bootstrap account configured, both mean
    //   "there is no address to name here" — and both are answered by the same
    //   sentence on the screen, so the two do not need to be told apart.
    bootstrapEmail: data.bootstrapEmail ?? null,
    roles: data.roles,
    // ★ A MISSING CAPABILITY TABLE IS NOT REPAIRED HERE. Defaulting it to `[]` would
    //   render a screen that silently explains nothing, which reads as "there is
    //   nothing to say about these roles" rather than as a server this client
    //   disagrees with. The screen prints what it was given, and this at least
    //   names the disagreement.
    capabilities: data.capabilities ?? [],
  };
}

/* ------------------------------------------------------------------------- *
 * Writes
 * ------------------------------------------------------------------------- */

/**
 * `POST /api/users` — create an account, with its password, and read back the
 * **stored** row.
 *
 * The response is the row as the database holds it rather than an echo of what was
 * sent. That matters more here than in the organization register: `email` is
 * lower-cased server-side, `role` defaults when omitted, and the membership set is
 * re-read from the table after being written. A client that rendered its own copy
 * of the request would show an address that cannot be signed in with.
 *
 * ★ A 409 IS A REAL ANSWER AND TWO DIFFERENT ONES. The address is taken, or the
 *   address is the bootstrap account's — which is refused even though no row holds
 *   it, because a row for it would be inert: `.env` is checked before the table, so
 *   the row would never be reached and would only make a second account look as
 *   though it existed. Both messages explain which one happened; this function does
 *   not guess at which by matching on the text.
 */
export async function createUser(input: UserCreate): Promise<AppUser> {
  const res = await fetch('/api/users', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...sessionHeaders() },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await readError(res);
  const user = unwrap<AppUser | undefined>(await res.json(), 'account');
  if (!user || typeof user.id !== 'number') {
    throw new ApiError('The account was created but not read back.', 'MALFORMED_RESPONSE');
  }
  return user;
}

/**
 * `PATCH /api/users/{id}` — change the name, the role, or the organization set,
 * and read back the **stored** row.
 *
 * ★ A 404 IS A REAL ANSWER HERE, NOT JUST A FAILURE. The register is not locked
 *   while a drawer is open, so the row can go between the list being read and the
 *   form being saved. `AppError.notFound('Account ' + id)` answers code `NOT_FOUND`
 *   and the sentence `Account <id> was not found.`, which the panel reports as
 *   "this account is no longer there" rather than as a validation problem with the
 *   form in front of the person. Those are different facts and the panel keeps them
 *   apart.
 */
export async function updateUser(id: number, patch: UserUpdate): Promise<AppUser> {
  const res = await fetch(`/api/users/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...sessionHeaders() },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw await readError(res);
  const user = unwrap<AppUser | undefined>(await res.json(), 'account');
  if (!user || typeof user.id !== 'number') {
    throw new ApiError('The account was saved but not read back.', 'MALFORMED_RESPONSE');
  }
  return user;
}

/**
 * `POST /api/users/{id}/password` — set an account's password.
 *
 * ★ `POST` THAT CREATES NOTHING, AND THE SERVER SAYS SO WITH A 200. A 201 with no
 *   `Location` header is cached wrongly and says a resource appeared. Nothing
 *   appears: one column of one row is overwritten. So the status is 200 here and
 *   the route is a `POST` because setting a secret is not idempotent in the sense a
 *   `PUT` claims — running it twice writes two different hashes of two different
 *   secrets, and the second is the one that works.
 *
 * ★ THE OLD PASSWORD IS NOT NEEDED AND ALREADY-ISSUED SESSIONS ARE NOT AFFECTED.
 *   Both are consequences of the same fact: a session is a signed token with a
 *   twelve-hour life that is not re-validated against the credential on each
 *   request. Changing the password stops the *next* sign-in with the old one and
 *   does not stop anybody who is already inside. The panel says so rather than
 *   implying a revocation that does not happen.
 *
 * ★ THE RESULT IS THE ACCOUNT, NOT THE PASSWORD. `hasPassword` flips to `true`, and
 *   that is the only thing about this request that comes back — the value that was
 *   sent is not echoed, logged or stored in plain, on either side.
 */
export async function setUserPassword(id: number, password: string): Promise<AppUser> {
  const res = await fetch(`/api/users/${id}/password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...sessionHeaders() },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) throw await readError(res);
  const user = unwrap<AppUser | undefined>(await res.json(), 'account');
  if (!user || typeof user.id !== 'number') {
    throw new ApiError('The password was set but the account was not read back.', 'MALFORMED_RESPONSE');
  }
  return user;
}
