/**
 * Who is asking, and which organization they see.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS
 * ---------------------------------------------------------------------------
 * One identity type (`Actor`), two ways to reach it, and one place that decides
 * whether a caller may do a thing:
 *
 *   authenticate(email, password)   sign-in. Verifies the bootstrap credential
 *                                   or looks the address up in `app_user`, then
 *                                   binds the result to a tenant.
 *   resolveActor(req)               every other request. Turns the session token
 *                                   back into an `Actor`, or `null`.
 *
 * Both funnel into the same shape, so a route never learns whether the caller
 * signed in with a password or a token — and a role check written once holds for
 * both.
 *
 * ---------------------------------------------------------------------------
 * ★ WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 * It is not authentication, and calling it that would be the single most
 * misleading thing this file could do. Three facts, all of them load-bearing:
 *
 *   1. A PASSWORD IS NOW CHECKED, AND THIS POINT USED TO SAY THE OPPOSITE.
 *      `app_user` gained `password_hash` (see `auth/password.ts`), so a member
 *      signing in supplies an address *and* a secret, and the secret is compared
 *      against a salted `scrypt` derivative instead of against nothing. Until
 *      that column existed a member was looked up by address and admitted on the
 *      strength of being a row, which made an address an identity *claim* rather
 *      than a proof — "signed in as Dana" meant "typed Dana's address". It now
 *      means "typed Dana's address and Dana's password".
 *
 *   2. TWO KINDS OF SECRET, DELIBERATELY KEPT IN DIFFERENT PLACES. The bootstrap
 *      account's password is compared against `.env` — a gitignored file, no
 *      lockout, no rotation. That is a deployment convenience for the one
 *      identity that exists before any tenant does. Every other account is a
 *      hash in the database, so an account can be created, re-set, and revoked
 *      without a redeploy. The bootstrap pair is still the reason the session
 *      token below exists at all: a bare email header would make that credential
 *      decorative, because anyone who read the address out of the deployment
 *      could claim super admin without ever typing the password.
 *
 *   3. THE TOKEN IS A RANDOM STRING IN A PROCESS-LOCAL MAP. Not signed, not
 *      persisted, not shared between processes. Restarting the server signs
 *      everybody out, and running two replicas means a token minted by one is
 *      unknown to the other. Both are acceptable *today* — the API has exactly
 *      one process and no session-dependent data is stored server-side.
 *
 * The mitigation that actually matters while the above is true is elsewhere: no
 * endpoint here leans on the session for data safety. Role is checked only where
 * a role is the question being answered — who may read the organization register,
 * and who may read and write the user register.
 *
 * ---------------------------------------------------------------------------
 * WHY A TOKEN AND NOT A COOKIE OR A JWT
 * ---------------------------------------------------------------------------
 * A cookie would need `cookie-parser` and a CSRF story for a client that is
 * same-origin behind the Vite proxy. A JWT would need signing and verification —
 * i.e. a real auth implementation — to protect a store that holds no user data.
 * A random string with a TTL is the smallest thing that (a) can be revoked by
 * clearing the map, and (b) is honest about its own lifetime.
 */

import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { config } from '../config/env.js';
import { execute, one, stampNow } from '../db/sql.js';
import { requireAppSchema } from '../db/app-schema.js';
import { AppError } from '../http/errors.js';
import { standInHash, verifyPassword } from './password.js';

/** Transport for the token. A header, not a cookie — see the header note. */
export const SESSION_HEADER = 'x-app-session';

/**
 * How long a token lasts. Twelve hours: a working day.
 *
 * Short enough that a token abandoned in a browser's `localStorage` stops working
 * on its own, long enough that nobody is asked to sign in mid-task.
 */
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * ★ WHY THERE ARE THREE ROLES AND ONLY ONE OF THEM IS A PRIVILEGE
 *
 * `super_admin` is the only role this server consults: it is the one
 * `requireSuperAdmin` tests for. `administrator` is recorded, displayed, and
 * **grants nothing whatever** — not because it is unimplemented by oversight, but
 * because the register that hands roles out is the register that has to be able to
 * name them, and the authority to grant a capability is itself a capability.
 *
 * The alternative was considered and refused: inventing behaviour for
 * `administrator` so it *looked* like a middle tier would be this server deciding a
 * permission model nobody asked it to decide. The role is in the vocabulary so an
 * operator can record intent. The screen states, per role and in as many words,
 * exactly what it reaches — including the sentence that an `administrator` reaches
 * nothing a `staff` account does not. See `ROLE_CAPABILITIES` in `routes/users.ts`,
 * which is the one place that answer lives, and which travels to the client rather
 * than being restated in the interface.
 *
 * `staff` is the default, here and in the DDL, because it is the role that grants
 * least.
 */
export type Role = 'super_admin' | 'administrator' | 'staff';

/**
 * Is this string one of the roles?
 *
 * ★ THE DOOR FOR ANYTHING READ OUT OF THE DATABASE. `role` is `TEXT` in the store
 *   and `string` in `UserRow`, so every actor is built from a value the type system
 *   has not checked. This is where that stops being true, and it is the one place
 *   the three names are listed on this side — a fourth role is a change to this
 *   function, the CHECK constraint, and nothing else.
 */
export function isRole(value: string): value is Role {
  return value === 'super_admin' || value === 'administrator' || value === 'staff';
}

/**
 * An organization's *scope* — the three settings that decide which rows exist
 * from this tenant's point of view.
 *
 * `fund` and `programs` are the ledger-side filter; `startFy` opens the fiscal
 * window. They travel with the session rather than being re-read per request,
 * because they are needed to compose almost every query and re-reading them would
 * mean a database round-trip before each one.
 */
export interface Tenant {
  id: number;
  slug: string;
  name: string;
  fund: string;
  programs: string[];
  startFy: number;
}

/**
 * An identified caller.
 *
 * `id` is nullable because the bootstrap account is a `.env` pair and not a row —
 * see the note above. Everything that needs an owner uses `name`, so only a route
 * that wants to write a foreign key into `app_user` has to care.
 */
export interface Actor {
  id: number | null;
  email: string;
  name: string;
  role: Role;
  organization: Tenant;
}

/** The shape the client keeps in `localStorage`. Mirrors `SessionUser` in `app/src/session/`. */
export interface SessionUser {
  name: string;
  /** Derived here so the avatar is drawn from one implementation, not two. */
  initials: string;
  email: string;
  role: Role;
  organizationId: number;
  organizationName: string;
  organization: {
    fund: string;
    programs: string[];
    startFy: number;
  };
}

export interface SessionPayload {
  token: string;
  user: SessionUser;
}

/** An answer that is identical whether the address is unknown or the password is wrong. */
const NOT_RECOGNISED = 'Those sign-in details were not recognised.';

/** What the bootstrap account is called when it has no row to name it. */
const BOOTSTRAP_NAME = 'Super Admin';

// ---------------------------------------------------------------------------
// The store.
// ---------------------------------------------------------------------------

interface StoredSession {
  email: string;
  expiresAt: number;
}

/**
 * Process-local. Keyed by the opaque token; holds only an email, because
 * everything that *describes* the actor is re-read from the database on each
 * request — so a role change or a re-tenanting takes effect at once instead of at
 * the next sign-in, and the map cannot go stale about anything that matters.
 */
const sessions = new Map<string, StoredSession>();

/**
 * 64 hex characters with no structure in them.
 *
 * Two UUIDs rather than one: a UUIDv4 carries 122 bits of randomness and the
 * version/variant nibbles are fixed, so a single one is a perfectly good token —
 * but the token is the *only* thing standing between a caller and the bootstrap
 * account, and the second UUID costs nothing and removes the question.
 *
 * `node:crypto` rather than the bare global, matching `routes/views.ts`. The
 * global exists in Node 20 and is the same object; the explicit import is what
 * makes the dependency visible in the file's import list.
 */
function mintToken(): string {
  return randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
}

// ---------------------------------------------------------------------------
// Reading the tenant.
// ---------------------------------------------------------------------------

/** Column list for `organization`, in the order `tenantFromRow` reads it. */
export const TENANT_COLUMNS = 'id, slug, name, fund, programs_json, start_fy';

/**
 * The stored row behind a `Tenant`.
 *
 * Exported because `routes/organizations.ts` extends it with the three columns a
 * `Tenant` has no use for (`is_default`, `created_at`, `updated_at`) and must not
 * retype the six it shares — a second copy of this list would be free to fall out
 * of step with `TENANT_COLUMNS`, and the failure would be a silently dropped
 * column rather than an error.
 */
export interface OrganizationRow {
  id: number;
  slug: string;
  name: string;
  fund: string;
  programs_json: string;
  start_fy: number;
}

/**
 * `programs_json` → `string[]`.
 *
 * ★ THIS THROWS RATHER THAN RETURNING `[]`. An empty program list is a *legal
 *   configuration* — it selects no rows and the screens then show their ordinary
 *   "No rows found" (see the column note in `01-app.sql`). So a corrupt column
 *   silently read as `[]` would be indistinguishable from a tenant that
 *   deliberately selects nothing, which is the "wrong data presented as a
 *   legitimate zero" failure this project has been bitten by before. A 500 naming
 *   the slug is the only answer that cannot be mistaken for a real result.
 */
function parsePrograms(raw: unknown, slug: string): string[] {
  if (typeof raw !== 'string') {
    throw new AppError(500, 'INTERNAL', `Organization "${slug}" has no programs column.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AppError(
      500,
      'INTERNAL',
      `Organization "${slug}" has an unreadable programs list, so its scope cannot be trusted.`,
    );
  }
  if (!Array.isArray(parsed) || parsed.some((p) => typeof p !== 'string')) {
    throw new AppError(
      500,
      'INTERNAL',
      `Organization "${slug}" has a programs list that is not a list of strings.`,
    );
  }
  return parsed as string[];
}

/** Row → `Tenant`. Shared so the tenant list route and the session agree. */
export function tenantFromRow(row: OrganizationRow): Tenant {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    fund: row.fund,
    programs: parsePrograms(row.programs_json, row.slug),
    startFy: row.start_fy,
  };
}

/** One organization by id. */
export async function loadTenant(id: number): Promise<Tenant> {
  const row = await one<OrganizationRow>(
    `SELECT ${TENANT_COLUMNS} FROM organization WHERE id = ?`,
    [id],
  );
  if (row === null) {
    throw new AppError(500, 'INTERNAL', `Organization ${id} is referenced but does not exist.`);
  }
  return tenantFromRow(row);
}

/**
 * The organization the bootstrap account belongs to.
 *
 * `is_default = 1`, held to exactly one row by the partial unique index in
 * `01-app.sql`, so this cannot return a row chosen at random.
 */
export async function defaultTenant(): Promise<Tenant> {
  const row = await one<OrganizationRow>(
    `SELECT ${TENANT_COLUMNS} FROM organization WHERE is_default = 1`,
  );
  if (row === null) {
    throw new AppError(
      500,
      'INTERNAL',
      'No organization is marked as the default, so the bootstrap account has no tenant. ' +
        'Re-apply data/sql/turso/01-app.sql, which seeds one.',
    );
  }
  return tenantFromRow(row);
}

// ---------------------------------------------------------------------------
// Sign-in.
// ---------------------------------------------------------------------------

interface UserRow {
  id: number;
  email: string;
  display_name: string;
  role: string;
  organization_id: number | null;
  /**
   * The stored `scrypt$N$r$p$salt$key` string. Nullable because rows created
   * before the column existed have none — and a row with no hash is *refused*,
   * not admitted. See `authenticate`.
   */
  password_hash: string | null;
}

function notRecognised(): AppError {
  return new AppError(401, 'UNAUTHORIZED', NOT_RECOGNISED);
}

/**
 * Is this address the bootstrap account, and is the password right?
 *
 * ★ NO DATABASE CALL ON THIS PATH, AND THAT IS THE POINT. `.env` is the authority
 *   for this one identity, so a row in `app_user` sharing the address can neither
 *   downgrade it nor move it to another tenant — an operator who set
 *   `SUPER_ADMIN_EMAIL` gets exactly the account they asked for, and the address
 *   is `UNIQUE` so a collision has to be deliberate. The alternative, letting the
 *   table win, would mean a row that happened to have no role set could silently
 *   demote the only account able to create tenants.
 *
 * Returns `undefined` when the address is not the bootstrap account at all, which
 * is a different answer from "it is, and the password was wrong" — the caller
 * collapses both into one 401, but only the second is a credential failure.
 *
 * ★ COMPARED IN PLAIN TEXT, ON PURPOSE. This is one password read out of
 *   `process.env` at boot, not a stored hash, so there is nothing to derive and
 *   no timing signal to smooth: an attacker who can time a `===` against a
 *   value they do not know is an attacker who already has the process image. The
 *   database path is the one that needs `scrypt` and a constant-time compare.
 */
function checkBootstrap(email: string, password: string): boolean | undefined {
  const configured = config.superAdmin.email;
  if (configured === undefined || email !== configured) return undefined;

  // An unset or empty `SUPER_ADMIN_PASSWORD` refuses rather than admitting
  // everybody. `.env` is the only authority for this identity, so a missing
  // setting has to be a locked door and not an open one.
  const expected = config.superAdmin.password;
  if (expected === undefined || expected === '') return false;

  return password === expected;
}

/**
 * Turn a verified identity into its actor.
 *
 * `organization_id IS NULL` is refused rather than defaulted. The column is
 * nullable because "belongs to an organization" and "has not been given one yet"
 * are different states, and `01-app.sql` is explicit that the sign-in path is
 * what must decide this — silently granting the default tenant would mean an
 * unassigned user could read an organization nobody put them in.
 */
async function actorFor(row: UserRow): Promise<Actor> {
  if (!isRole(row.role)) {
    throw new AppError(
      500,
      'INTERNAL',
      `User ${row.email} has role "${row.role}", which is not a role this server knows.`,
    );
  }
  if (row.organization_id === null) {
    throw new AppError(
      403,
      'FORBIDDEN',
      `${row.display_name} has not been assigned to an organization yet, so there is no data ` +
        'to show. A super admin assigns one on the Users & roles screen.',
    );
  }
  return {
    id: row.id,
    email: row.email,
    name: row.display_name,
    role: row.role,
    organization: await loadTenant(row.organization_id),
  };
}

/**
 * Sign in.
 *
 * Two paths and one answer shape:
 *
 *   the bootstrap address   the `.env` password decides, the default organization
 *                           is the tenant, and there is no `app_user` row.
 *   anything else           looked up in `app_user` by lower-cased email, and the
 *                           password is checked against that row's `password_hash`.
 *
 * ★ EVERY REFUSAL COMES BACK THE SAME WAY, AND EACH ONE PAYS FOR IT. An unknown
 *   address, a wrong password, and a row with no password set are three different
 *   facts that must produce one 401 with one message, because the endpoint must
 *   not be usable to ask which addresses have accounts. The consequence is that
 *   they must also take the same *time*: a real row costs one `scrypt` run, and a
 *   lookup that finds nothing has no hash to run, so it would answer in
 *   microseconds and the timing would say what the message refused to. Hence
 *   `standInHash()` on the paths that have nothing to compare against — they
 *   verify against a hash no typed password can match, and the three cases end up
 *   costing about the same.
 *
 * ★ A ROW WITH NO PASSWORD IS REFUSED, NOT ADMITTED. `password_hash` is nullable
 *   because rows can predate the column. A null there must not fall through to
 *   "there is no secret to check, so let them in" — that is precisely the hole
 *   the column was added to close. The refusal is logged, because "this account
 *   has no password" is an operator problem the caller cannot act on, and
 *   `npm run set:password -- --email <address>` is the fix.
 */
export async function authenticate(emailRaw: string, password: string): Promise<SessionPayload> {
  const email = emailRaw.trim().toLowerCase();

  const bootstrap = checkBootstrap(email, password);
  if (bootstrap === false) throw notRecognised();

  let identity: Actor;
  if (bootstrap === true) {
    identity = {
      id: null,
      email,
      name: BOOTSTRAP_NAME,
      role: 'super_admin',
      organization: await defaultTenant(),
    };
  } else {
    await requireAppSchema('Sign-in');
    const row = await one<UserRow>(
      'SELECT id, email, display_name, role, organization_id, password_hash ' +
        'FROM app_user WHERE email = ?',
      [email],
    );

    // ★ ONE `scrypt` RUN WHICHEVER WAY THIS GOES. `row === null` means there is no
    //   hash to compare against, so the stand-in is used to spend the same time
    //   and to give the comparison something real to do. A row whose hash is null
    //   or unparseable is handled by `verifyPassword` answering `false`, which
    //   also costs one run — so "no such address" and "address with no password"
    //   are indistinguishable in both wording and duration.
    const stored = row?.password_hash ?? null;
    const ok = await verifyPassword(password, stored === null ? await standInHash() : stored);

    if (row === null || !ok) {
      // The caller is told nothing extra. The log is where the operator finds out
      // that an account exists and simply cannot be signed in to yet.
      if (row !== null && (stored === null || stored === '')) {
        console.warn(
          `[auth] "${email}" has no password set, so the sign-in was refused. ` +
            `Set one with: npm run set:password -- --email ${email}`,
        );
      }
      throw notRecognised();
    }

    identity = await actorFor(row);
    // Written *before* the reply is sent: see the note on `last_seen_at` below.
    await stampLastSeen(row.id);
  }

  const token = mintToken();
  sessions.set(token, { email: identity.email, expiresAt: Date.now() + SESSION_TTL_MS });

  return { token, user: sessionUserFor(identity) };
}

/**
 * Record that the account was used.
 *
 * ★ AWAITED BEFORE THE REPLY, NOT FIRE-AND-FORGET AFTER IT. `last_seen_at` is the
 *   signal an administrator uses to answer "has this person ever signed in?", and
 *   a write that lands after the response leaves a window where the client
 *   already holds a session and a refreshed Users screen still shows the account
 *   as never used — flaky, and wrong in the direction that gets someone's access
 *   revoked. Failures are swallowed: a stamp is not worth refusing a valid
 *   sign-in over.
 */
async function stampLastSeen(userId: number): Promise<void> {
  try {
    await execute(`UPDATE app_user SET last_seen_at = ${stampNow()} WHERE id = ?`, [userId]);
  } catch (err) {
    console.warn(`[auth] could not stamp last_seen_at for user ${userId}:`, err);
  }
}

/**
 * First letter of the first and last word. `'Wake County Public Schools'` → `'WS'`.
 *
 * Exported because the sign-in response and `GET /api/auth/session` both carry
 * this value, and two copies of an initial-deriving rule is exactly the kind of
 * duplication that ends with the avatar disagreeing with the name beside it.
 */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter((p) => p !== '');
  const first = parts.at(0);
  if (first === undefined) return '?';
  const last = parts.length > 1 ? parts.at(-1) : undefined;
  const head = first.charAt(0);
  return (last === undefined ? head : head + last.charAt(0)).toUpperCase();
}

/**
 * The actor as the client stores it.
 *
 * ★ ONE MAPPING, TWO CALLERS. `authenticate` has an `Actor` in hand the moment it
 *   has decided the identity, and `GET /api/auth/session` reads one back — so both
 *   build `SessionUser` here rather than each carrying a copy. The alternative
 *   failed the only way it can: the two copies existed, and the sign-in response
 *   and the session response were free to disagree about `initials` without
 *   anything failing.
 *
 * Takes a structural subset rather than `Actor` itself so that the pre-actor
 * identity `authenticate` builds can be passed without a cast.
 */
export function sessionUserFor(identity: {
  name: string;
  email: string;
  role: Role;
  organization: Tenant;
}): SessionUser {
  return {
    name: identity.name,
    initials: initialsOf(identity.name),
    email: identity.email,
    role: identity.role,
    organizationId: identity.organization.id,
    organizationName: identity.organization.name,
    organization: {
      fund: identity.organization.fund,
      programs: identity.organization.programs,
      startFy: identity.organization.startFy,
    },
  };
}

// ---------------------------------------------------------------------------
// Every other request.
// ---------------------------------------------------------------------------

/**
 * Turn a request's session token into an `Actor`.
 *
 * `null` for absent, unknown, and expired alike: to a caller the three are the
 * same situation, and a route that wanted to distinguish them would be
 * distinguishing something it cannot act on differently.
 *
 * The database is re-read on every call, which is the deliberate cost of never
 * holding a stale role. It is one indexed lookup and this API's queries are
 * measured in tens of milliseconds.
 */
export async function resolveActor(req: Pick<Request, 'header'>): Promise<Actor | null> {
  const token = req.header(SESSION_HEADER)?.trim();
  if (token === undefined || token === '') return null;

  const session = sessions.get(token);
  if (session === undefined) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }

  const email = session.email;

  // A signed-in bootstrap account. Re-checked against the configuration rather
  // than trusted from the token, so unsetting `SUPER_ADMIN_EMAIL` and restarting
  // cannot leave an old token claiming to be super admin.
  if (config.superAdmin.email !== undefined && email === config.superAdmin.email) {
    return {
      id: null,
      email,
      name: BOOTSTRAP_NAME,
      role: 'super_admin',
      organization: await defaultTenant(),
    };
  }

  await requireAppSchema('Sign-in');
  const row = await one<UserRow>(
    'SELECT id, email, display_name, role, organization_id FROM app_user WHERE email = ?',
    [email],
  );
  // The account was deleted out from under a live token.
  if (row === null) {
    sessions.delete(token);
    return null;
  }
  return actorFor(row);
}

/** `super_admin` is the role that may create and edit organizations. */
export function isSuperAdmin(actor: Actor | null): boolean {
  return actor?.role === 'super_admin';
}
