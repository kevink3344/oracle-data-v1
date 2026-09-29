import { z, IntParam } from '../http/z.js';
import type { Api } from '../http/api.js';
import { AppError } from '../http/errors.js';
import { columnNumber, execute, one, rows, type Args, type Binds } from '../db/sql.js';
import { requireAppSchema } from '../db/app-schema.js';
import { intReq, textReq } from '../schemas/columns.js';
import { requireSuperAdmin } from '../auth/guard.js';
import { isRole, type Role } from '../auth/session.js';
import { hashPassword } from '../auth/password.js';
import { config } from '../config/env.js';

/**
 * Users & roles: the accounts on this application, the organizations each one
 * belongs to, and the role each one holds.
 *
 * ---------------------------------------------------------------------------
 * WHAT A USER IS, IN THREE SEPARATE FACTS
 * ---------------------------------------------------------------------------
 *   `email` + `password_hash`   HOW THEY PROVE IT IS THEM.
 *   `role`                      WHAT THEY MAY DO. Read out of the vocabulary in
 *                               `auth/session.ts`; this file is not its author.
 *   `organization_id`           WHICH ORGANIZATION THEY SIGN IN TO — exactly one.
 *   `app_user_organization`     WHICH ORGANIZATIONS THEY BELONG TO — one, or many.
 *
 * The last two look like a duplicate and are not. With two memberships nothing
 * says which one a sign-in should land in, so "pick the first" would be a silent
 * guess deciding every query the person runs for the rest of the session. Naming
 * the primary turns the guess into an answer somebody gave. `01-app.sql` argues
 * this at length at the two tables; this file is where it is enforced.
 *
 * ---------------------------------------------------------------------------
 * ★ THE MEMBERSHIP RULE IS ENFORCED HERE BECAUSE THE DATABASE CANNOT HOLD IT
 * ---------------------------------------------------------------------------
 * Three facts are true of every account, and two of the three cannot be
 * expressed as a constraint:
 *
 *   **One and only one membership is the primary.** Expressible, one column.
 *   **There is at least one membership.** NOT expressible — a `CHECK` cannot
 *     count rows in another table, in either dialect.
 *   **The primary is one of them.** NOT expressible — the same reason.
 *
 * So they are checked in `assertSignInOrganization`, once, and every write in
 * this file goes through it. The row that reaches the store has been checked;
 * a row written by `npm run set:password -- --create` is checked there too.
 *
 * ★ THE THIRD RULE COVERS THE ONE CASE THAT LOOKS LIKE A CORNER AND IS NOT.
 *   Removing an account's *last* membership would leave it able to sign in and
 *   with no data to show — the state `actorFor` refuses with "has not been
 *   assigned to an organization yet". This endpoint will not create that state,
 *   so the honest fix for "this person has moved tenant" is to name the new one,
 *   not to empty the old set and fill it in a second request that may never come.
 *
 * ---------------------------------------------------------------------------
 * ★ THE CAPABILITY TABLE IS HERE, IS SENT TO THE CLIENT, AND IS NOT REPEATED
 * ---------------------------------------------------------------------------
 * `ROLE_CAPABILITIES` is the one place this project states what a role reaches,
 * and it travels to the browser inside `GET /api/users` rather than being written
 * out again in the Settings screen. The screen prints it. If the two were
 * separate, the screen would be free to describe a permission model the server
 * does not implement — and there is a specific sentence here that a second copy
 * would be most likely to get wrong, which is the one saying that an
 * `administrator` reaches **nothing a staff account does not**. That is not an
 * oversight; see the note on `Role` in `auth/session.ts`.
 *
 * ---------------------------------------------------------------------------
 * WHO MAY READ ANY OF THIS
 * ---------------------------------------------------------------------------
 * `super_admin`, and nothing else — the same rule as `/api/organizations`, and
 * for the same reason: a register that lists who exists is itself a thing worth
 * restricting. The refusal is answered by `requireSuperAdmin` inside each handler
 * rather than by a middleware, so a route that forgot to ask has no actor rather
 * than a stale one. The register it names is **the user register**, because a
 * caller told they were refused from the organization register while asking about
 * users would go and check the wrong thing.
 *
 * ★ A CONSEQUENCE WORTH STATING: `administrator` and `staff` cannot read this
 *   register. A signed-in account knows its own organization — it is in the
 *   session payload — but it cannot list the tenants it is not in, and it cannot
 *   see who else exists at all.
 *
 * ---------------------------------------------------------------------------
 * ★ NO PASSWORD OR HASH LEAVES THIS FILE, BY CONSTRUCTION
 * ---------------------------------------------------------------------------
 * `USER_SQL` never names `password_hash`. It selects
 * `CASE WHEN password_hash IS NULL OR password_hash = '' THEN 0 ELSE 1 END AS
 * has_password`, so the column is not in a row this file ever holds and there is
 * no field to forget to strip. A response that carried a hash would be a
 * credential-store disclosure with a `200` on it, and "remember to delete it
 * before returning" is a rule that survives exactly until the second caller.
 */

// ---------------------------------------------------------------------------
// The vocabulary.
// ---------------------------------------------------------------------------

/**
 * The three roles, in the order they are offered.
 *
 * ★ THIS IS THE ORDER THE CLIENT RENDERS, SO IT IS DECIDED HERE. Most privileged
 *   first, because a picker that puts the least privileged role first is a picker
 *   whose default is the one somebody accidentally accepts.
 */
const ROLE_ORDER = ['super_admin', 'administrator', 'staff'] as const;

const RoleSchema = z.enum(['super_admin', 'administrator', 'staff']).openapi({
  description:
    '`super_admin` may read and write both registers. `administrator` and `staff` may do neither, ' +
    'and **an administrator reaches nothing a staff account does not** — see `capabilities` in the ' +
    'list response, which is the server saying so rather than the screen.',
});

/**
 * What each role reaches.
 *
 * ★ THE WITHHOLDS ARE AS IMPORTANT AS THE GRANTS, AND ARE LISTED RATHER THAN
 *   DERIVED. A screen built by subtracting one role's grants from another's would
 *   read correctly today and read *wrongly* the first time a role gains a
 *   capability that only one of them has — because "not in the other list" is not
 *   the same fact as "withheld". Both lists are authored.
 */
const ROLE_CAPABILITIES: Record<
  Role,
  { label: string; summary: string; grants: string[]; withholds: string[] }
> = {
  super_admin: {
    label: 'Super admin',
    summary: 'Everything, including the two registers that decide who and what else exists.',
    grants: [
      'Read and write the organization register: add a tenant, change its fund, its programs or the ' +
        'fiscal year it starts at.',
      'Read and write this register: create an account, set its first password, change its role, and ' +
        'change which organizations it belongs to.',
      'Read every ledger, procurement, vendor, chart-of-accounts, funding and analysis endpoint.',
    ],
    withholds: [
      'Nothing. This is the role the server tests for, and the **only** role it tests for.',
    ],
  },
  administrator: {
    label: 'Administrator',
    summary: 'Reads what a staff account reads, and reaches nothing further.',
    grants: [
      'Read every ledger, procurement, vendor, chart-of-accounts, funding and analysis endpoint.',
      'See the organization its own account signs in to, in the session payload.',
    ],
    withholds: [
      'Reading or writing the organization register — a signed-in account cannot list the tenants it ' +
        'is not in.',
      'Reading or writing this register: an administrator cannot create accounts, set passwords, ' +
        'change roles, or change memberships.',
      '**In fact an administrator reaches nothing at all that a staff account does not already ' +
        'reach.** The role is recorded so an operator can say what somebody is; the server does not ' +
        'test for it anywhere. That is a decision rather than an unfinished middle tier — inventing ' +
        'behaviour for it would be this server deciding a permission model nobody asked it to decide.',
    ],
  },
  staff: {
    label: 'Staff',
    summary: 'The default role, here and in the schema, because it grants least.',
    grants: [
      'Read every ledger, procurement, vendor, chart-of-accounts, funding and analysis endpoint — ' +
        'all of which are readable without a session at all, so this is a fact about the endpoints ' +
        'rather than something the role confers.',
      'See the organization its own account signs in to, in the session payload.',
    ],
    withholds: [
      'Reading or writing the organization register.',
      'Reading or writing this register.',
    ],
  },
};

/** The table above, in `ROLE_ORDER`, as the client receives it. */
function capabilities(): { role: Role; label: string; summary: string; grants: string[]; withholds: string[] }[] {
  return ROLE_ORDER.map((role) => ({ role, ...ROLE_CAPABILITIES[role] }));
}

// ---------------------------------------------------------------------------
// Response shapes.
// ---------------------------------------------------------------------------

const UserOrganizationSchema = z
  .object({
    id: intReq('`organization.id`.'),
    slug: textReq(
      '`organization.slug` — carried beside the id because it is the stable key, so a link to a ' +
        'tenant keeps working after somebody renames it.',
    ),
    name: textReq('`organization.name`.'),
    isPrimary: z.boolean().openapi({
      description:
        'Whether this is the organization the account **signs in to**. Exactly one membership of ' +
        'exactly one account ... in short: exactly one row in this list is `true`, and the list is ' +
        'never empty. Neither is a database constraint; both are held by `POST` and `PATCH` here.',
    }),
  })
  .openapi('UserOrganization');

const UserSchema = z
  .object({
    id: intReq('`app_user.id`.'),
    email: textReq(
      'Lower-cased on write, and the address sign-in looks up. Unique in the store, so two rows ' +
        'cannot disagree about an address.',
    ),
    name: textReq('`display_name` — what the header and the avatar show.'),
    role: RoleSchema,
    primaryOrganizationId: intReq('The organization this account signs in to.').nullable().openapi({
      description:
        '`app_user.organization_id`. **`null` is legal in the store and unreachable through this ' +
        'API** — an account with no sign-in organization is refused at sign-in rather than given ' +
        'the default tenant, so a write here always leaves a value. A `null` in a response means ' +
        'the row predates this endpoint or was written by `npm run set:password`, and `PATCH` is ' +
        'how it is brought into line.',
    }),
    organizations: z
      .array(UserOrganizationSchema)
      .openapi({
        description:
          'Every organization the account belongs to, name-ordered, with the sign-in one flagged. ' +
          'At least one entry — an account with none could sign in and then have no data to show.',
      }),
    hasPassword: z.boolean().openapi({
      description:
        'Whether `password_hash` holds a value. **The hash itself is never selected**, let alone ' +
        'returned — this boolean is computed by the query, so the column is not in a row this ' +
        'endpoint holds and there is no field to forget to strip. `false` means the account cannot ' +
        'be signed in to yet, whatever its role says.',
    }),
    createdAt: textReq('When the row was written.'),
    lastSeenAt: textReq('When the account was last signed in to.').nullable().openapi({
      description:
        'Written at sign-in, before the reply is sent, so a refreshed screen cannot show a session ' +
        'the client already holds as never used. `null` means never used — a different fact from ' +
        '"used long ago", and the one an administrator acts on.',
    }),
  })
  .openapi('AppUser');

const CapabilitySchema = z
  .object({
    role: RoleSchema,
    label: textReq('What to call the role on screen.'),
    summary: textReq('One sentence, for the row below the role name.'),
    grants: z.array(z.string()).openapi({ description: 'What the role reaches, stated positively.' }),
    withholds: z
      .array(z.string())
      .openapi({
        description:
          'What it does not reach, stated rather than derived by subtraction — "not in the other ' +
          'list" is a different fact from "withheld", and only one of them stays true when a role ' +
          'gains a capability.',
      }),
  })
  .openapi('RoleCapability');

// ---------------------------------------------------------------------------
// Request shapes.
// ---------------------------------------------------------------------------

/**
 * ★ THE ADDRESS IS TRIMMED AND LOWER-CASED IN THE HANDLER, NOT IN THE SCHEMA.
 *
 * Zod can rewrite as well as validate (`z.string().trim().toLowerCase()`), and
 * doing it there would be one fewer line. It is done in the handler because
 * `authenticate()` normalises the address it was given the same way, and the two
 * have to agree: a schema that lower-cased on write and a sign-in that lower-cased
 * on read would be two implementations of one rule, which is how `Dana@x.gov`
 * comes to be a second account that nobody can sign in to.
 */
const EmailSchema = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .regex(
    /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
    'An email address, e.g. dana@example.org. It has to look like one because it is the key ' +
      'sign-in looks the row up by.',
  )
  .openapi({
    example: 'dana@example.org',
    description: 'The address the account signs in with. Lower-cased on write; unique in the store.',
  });

/**
 * ★ A LENGTH FLOOR, AND IT DOES NOT PRETEND TO BE A STRENGTH POLICY.
 *
 * This project has no password policy — no dictionary check, no breach list, no
 * rotation, no expiry. Saying otherwise by validating an uppercase and a symbol
 * would be theatre: it would make a weak password *look* checked. What is refused
 * is the empty string and the obviously accidental short one, and the description
 * says so plainly so an operator does not read the floor as a guarantee.
 */
const PasswordSchema = z
  .string()
  .min(8, 'A first password has to be at least 8 characters.')
  .max(200)
  .openapi({
    example: 'correct horse battery staple',
    description:
      'The account\'s **first** password, set by the administrator creating it. 8 characters ' +
      'minimum — a length floor and not a strength policy; this project has none, and this ' +
      'endpoint does not pretend to be one. The account can be given a different one later ' +
      'without knowing this one. Nothing here or anywhere in this API returns it back.',
  });

/**
 * ★ `IntParam.nullable()` AND NOT `IntParam`, BECAUSE `z.coerce.number()` TURNS A
 *   NULL INTO A ZERO.
 *
 * `primaryOrganizationId: null` is a request this API refuses, and it refuses it
 * in `assertSignInOrganization` — "This account would have no sign-in organization"
 * — because a null sign-in organization is precisely the state the sign-in path
 * rejects, so no endpoint here will store one.
 *
 * Validating with plain `IntParam` would never let that sentence be reached.
 * `z.coerce.number()` is `Number(value)`, and `Number(null)` is `0`, which is an
 * integer, so the null would arrive in the handler as an organization id of **0**
 * and the caller would be told *"Organization 0 is this account's sign-in
 * organization and is not among the organizations it belongs to [1, 2]"* — a
 * refusal about an id nobody sent, naming an organization that does not exist.
 * (The same coercion is what makes `""` and `false` arrive as 0; a non-numeric
 * string still fails, because `Number('abc')` is `NaN`.)
 *
 * `.nullable()` is applied *outside* the coercion, and Zod checks nullability
 * before it runs the inner schema, so the null survives to the handler intact and
 * the domain's own message is the one that speaks. Widening the shape here is not
 * a loosening: the field is still refused, just with the sentence that explains
 * it.
 */
const PrimaryAskSchema = IntParam.nullable().openapi({
  description:
    'Which organization the account **signs in to**. `null` is **refused** — it is the state the ' +
    'sign-in path rejects, so this endpoint will not create it. Moving an account means naming a ' +
    'different organization, not un-naming the one it has.',
});

// ---------------------------------------------------------------------------
// Reading.
// ---------------------------------------------------------------------------

type UserDbRow = {
  id: number;
  email: string;
  display_name: string;
  role: string;
  organization_id: number | null;
  created_at: string;
  last_seen_at: string | null;
  has_password: number;
};

type MembershipRow = {
  user_id: number;
  organization_id: number;
  slug: string;
  name: string;
};

/**
 * ★ `password_hash` IS NOT IN THIS SELECT, DELIBERATELY AND PERMANENTLY.
 *
 * `has_password` is derived in SQL so the column never enters the process. This
 * is the second-best version of "never return a credential": the best is not to
 * hold it. `CASE WHEN ... IS NULL OR ... = ''` covers both spellings of "no
 * password" — the store documents `NULL` as the meaning, and an empty string is
 * what a bad migration would write.
 */
const USER_SQL =
  'SELECT u.id, u.email, u.display_name, u.role, u.organization_id, u.created_at, u.last_seen_at, ' +
  "CASE WHEN u.password_hash IS NULL OR u.password_hash = '' THEN 0 ELSE 1 END AS has_password " +
  'FROM app_user u';

const MEMBERSHIP_SQL =
  'SELECT m.user_id, m.organization_id, o.slug, o.name ' +
  'FROM app_user_organization m JOIN organization o ON o.id = m.organization_id';

/**
 * Turn a stored role string into a `Role`, or refuse loudly.
 *
 * The store holds `TEXT` and the type system has not checked it, so this is the
 * door. It is a 500 and not a 400 because the caller cannot fix it: a role name
 * this build does not know is a row written by a different build, or a constraint
 * somebody dropped.
 */
function roleOf(value: string, email: string): Role {
  if (!isRole(value)) {
    throw new AppError(
      500,
      'INTERNAL',
      `Account ${email} holds role "${value}", which is not a role this server knows. The ` +
        'vocabulary is checked in `auth/session.ts` and constrained by `CK_app_user_role`; a value ' +
        'outside it means the constraint is gone or this row came from another build.',
    );
  }
  return value;
}

/**
 * Row → wire. The one place an `app_user` row becomes a response.
 *
 * ★ THE SIGN-IN ORGANIZATION IS EXPECTED TO BE ONE OF THE MEMBERSHIPS, AND NOTHING
 *   IN THE DATABASE SAYS SO. `organization_id` is a column on `app_user`; the set
 *   lives in `app_user_organization`; the foreign keys prove each of them points at
 *   a real organization and prove nothing about whether they agree with each other.
 *   Every writer in this repository writes both at once — `createUser`, `updateUser`
 *   and `scripts/set-password.ts` — so the state below is one nobody can reach by
 *   using this application.
 *
 *   It is not repaired here. Filling `organizations` from `organization_id` would
 *   need the organization's slug and name, which are a query this function does not
 *   have and cannot honestly pretend to have; and a read path that silently invents
 *   a membership row is a read path that hides a broken write. So an account in that
 *   state is *shown* in that state — a sign-in organization and no memberships —
 *   rather than being tidied into looking consistent.
 */
function toWire(row: UserDbRow, memberships: MembershipRow[]) {
  const primary = row.organization_id === null ? null : columnNumber(row, 'organization_id');
  return {
    id: columnNumber(row, 'id'),
    email: row.email,
    name: row.display_name,
    role: roleOf(row.role, row.email),
    primaryOrganizationId: primary,
    organizations: memberships.map((m) => ({
      id: columnNumber(m, 'organization_id'),
      slug: m.slug,
      name: m.name,
      isPrimary: columnNumber(m, 'organization_id') === primary,
    })),
    // `1` and not `true`: the dialect returns what it returns, and comparing to
    // the number keeps this the same expression on both arms.
    hasPassword: columnNumber(row, 'has_password') === 1,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

/** Every account, name-ordered. */
async function allUsers(): Promise<UserDbRow[]> {
  return rows<UserDbRow>(`${USER_SQL} ORDER BY u.display_name, u.email`);
}

/** One account by id, or null. */
async function findById(id: number): Promise<UserDbRow | null> {
  return one<UserDbRow>(`${USER_SQL} WHERE u.id = :id`, { id });
}

/** One account by address, or null. The address is unique, so this is a row or nothing. */
async function findByEmail(email: string): Promise<UserDbRow | null> {
  return one<UserDbRow>(`${USER_SQL} WHERE u.email = :email`, { email });
}

/** The memberships of one account, name-ordered. */
async function membershipsFor(id: number): Promise<MembershipRow[]> {
  return rows<MembershipRow>(`${MEMBERSHIP_SQL} WHERE m.user_id = :id ORDER BY o.name`, { id });
}

/** Every membership, for the list — one query rather than one per row. */
async function allMemberships(): Promise<MembershipRow[]> {
  return rows<MembershipRow>(`${MEMBERSHIP_SQL} ORDER BY o.name`);
}

/**
 * Re-read after a write, or fail loudly.
 *
 * A write that cannot be read back is not a success, and echoing what the caller
 * sent would hide it — and would show a membership set the store might not hold,
 * since replacing memberships is a delete followed by inserts.
 */
async function readBack(id: number) {
  const stored = await findById(id);
  if (stored === null) {
    throw new AppError(500, 'INTERNAL', `Wrote account ${id} but could not read it back.`);
  }
  return toWire(stored, await membershipsFor(id));
}

/**
 * Re-read by address. Used straight after a create, and the reason is worth
 * stating: **`lastInsertRowid` is null on SQL Server**, so the identity of a row
 * just inserted cannot be read off the write. `scripts/set-password.ts` reached
 * the same conclusion for the same reason. The address is `UNIQUE`, so re-reading
 * by it names exactly the row that was written.
 */
async function readBackByEmail(email: string) {
  const stored = await findByEmail(email);
  if (stored === null) {
    throw new AppError(
      500,
      'INTERNAL',
      `Created account "${email}" but could not read it back. The address is unique, so this ` +
        'means the row is not there rather than that it is ambiguous.',
    );
  }
  return stored;
}

// ---------------------------------------------------------------------------
// The membership rule.
// ---------------------------------------------------------------------------

/** The requested ids, in order, once each. */
function distinct(ids: number[]): number[] {
  return [...new Set(ids)];
}

/**
 * Refuse an organization id the register does not hold, naming the ones it does.
 *
 * ★ A MISSING ORGANIZATION IS 400, NOT 409. This is the same call `assertFund`
 *   makes in `organizations.ts` and for the same reason: nothing is in conflict —
 *   the id is simply not in the vocabulary, and a 409 would tell the caller to go
 *   and change the *other* thing.
 */
async function assertOrganizationsExist(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const known = await rows<{ id: number }>(
    `SELECT id FROM organization WHERE id IN (${ids.map(() => '?').join(', ')}) ORDER BY id`,
    ids as Args,
  );
  const have = new Set(known.map((r) => columnNumber(r, 'id')));
  const missing = ids.filter((id) => !have.has(id));
  if (missing.length > 0) {
    throw AppError.badRequest(
      missing.length === 1
        ? `Organization ${missing[0]} does not exist, so no account can belong to it.`
        : `Organizations ${missing.join(', ')} do not exist, so no account can belong to them.`,
      { unknown: missing, accepts: [...have] },
    );
  }
}

/**
 * Which organization the account signs in to, once the request has been read.
 *
 * ★ THIS IS NOT A DEFAULT, IT IS AN INFERENCE, AND THE DIFFERENCE IS WHETHER THE
 *   ANSWER IS UNIQUE. With **one** membership there is exactly one organization
 *   the account could sign in to, so filling the column from it is not a choice
 *   being made on the caller's behalf. With two there is no rule that would
 *   choose, and this returns `null` so `assertSignInOrganization` refuses rather
 *   than picking. That is the whole argument at the top of `01-app.sql`, applied
 *   to a request body.
 *
 * ★ AN UNCHANGED PRIMARY SURVIVES. If the caller sends a new membership set that
 *   still contains the current primary and says nothing about the primary, the
 *   current one is kept — even when the set has several entries. Re-deciding it
 *   would move an account somebody deliberately put somewhere.
 */
function resolvePrimary(
  asked: number | null | undefined,
  organizations: number[],
  current: number | null,
): number | null {
  if (asked !== undefined) return asked;
  if (current !== null && organizations.includes(current)) return current;
  if (organizations.length === 1) {
    // `?? null` is here for the compiler, not for the reader: the length check on
    // the line above is what makes the element exist. It is written out rather than
    // cast away so that an edit which loses the length check fails here instead of
    // returning `undefined` as though it were an organization.
    return organizations[0] ?? null;
  }
  // `current` is either null or not among the new memberships. Returning it lets
  // the check below produce the message that explains exactly that, rather than a
  // branch here producing a second, worse one.
  return current;
}

/**
 * The three facts, checked in one place, on every write in this file.
 *
 * The order of the checks is the order a reader would ask them, so the first
 * message a caller gets is the most fundamental thing wrong with the request.
 */
function assertSignInOrganization(primary: number | null, organizations: number[]): void {
  if (organizations.length === 0) {
    throw AppError.badRequest(
      'An account has to belong to at least one organization. An account that belongs to none ' +
        'could sign in and would then have no data to show, which is why the sign-in path refuses ' +
        'it. To move somebody between tenants, name the new organization instead of clearing the ' +
        'old list first.',
      { organizations: [], primaryOrganizationId: primary },
    );
  }

  if (primary === null) {
    throw AppError.badRequest(
      'This account would have no sign-in organization. `app_user.organization_id` is which ' +
        'organization the account signs in to, and the sign-in path REFUSES an account without ' +
        'one rather than choosing a membership for it. Name it in `primaryOrganizationId` — with ' +
        'a single membership it may be left out, because then there is only one possible answer, ' +
        'but with several there is no rule that would choose and so this endpoint will not choose ' +
        'either.',
      { primaryOrganizationId: null, organizations },
    );
  }

  if (!organizations.includes(primary)) {
    throw AppError.badRequest(
      `Organization ${primary} is this account's sign-in organization and is not among the ` +
        `organizations it belongs to [${organizations.join(', ')}]. An account signs in to an ` +
        'organization it is a member of, so either add it to the list or point ' +
        '`primaryOrganizationId` at one that is already in it.',
      { primaryOrganizationId: primary, organizations },
    );
  }
}

/**
 * Replace an account's memberships.
 *
 * ★ DELETE THEN INSERT, AND THE SET IS VERIFIED AFTERWARDS BECAUSE IT IS NOT
 *   ATOMIC. `withTransaction` exists in `db/sql.ts` and has no callers; making
 *   this its first one would be an unmeasured claim about a helper that has never
 *   been run against SQL Server. So the replacement is two statements and the
 *   read-back below compares the set that landed with the set that was asked for,
 *   refusing to report success for a state the store did not reach. The window
 *   that leaves is real, and it is one a second request closes: a PATCH naming
 *   the memberships again.
 */
async function replaceMemberships(userId: number, organizations: number[]): Promise<void> {
  await execute('DELETE FROM app_user_organization WHERE user_id = :id', { id: userId });
  for (const organizationId of organizations) {
    await execute(
      'INSERT INTO app_user_organization (user_id, organization_id) VALUES (:userId, :orgId)',
      { userId, orgId: organizationId },
    );
  }
}

/** The two sets, compared as sets. Order is the store's business, not this check's. */
function sameSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort((x, y) => x - y);
  const right = [...b].sort((x, y) => x - y);
  return left.every((value, i) => value === right[i]);
}

/** Write the memberships and prove they landed, or refuse. */
async function writeMemberships(
  userId: number,
  email: string,
  organizations: number[],
): Promise<MembershipRow[]> {
  await replaceMemberships(userId, organizations);
  const stored = await membershipsFor(userId);
  const landed = stored.map((m) => columnNumber(m, 'organization_id'));
  if (!sameSet(landed, organizations)) {
    throw new AppError(
      500,
      'INTERNAL',
      `The membership change on ${email} did not land: asked for [${organizations.join(', ')}], ` +
        `the store now holds [${landed.join(', ')}]. The replacement is a delete followed by ` +
        'inserts and is not atomic, so a failure between them leaves a smaller set — naming the ' +
        'memberships again writes them back.',
      { asked: organizations, stored: landed },
    );
  }
  return stored;
}

// ---------------------------------------------------------------------------
// Routes.
// ---------------------------------------------------------------------------

export function registerUsers(api: Api): void {
  // -------------------------------------------------------------------------
  // The register.
  // -------------------------------------------------------------------------
  api.route({
    method: 'get',
    path: '/api/users',
    operationId: 'users_list',
    summary: 'Every account, the organizations each belongs to, and what each role may do',
    description:
      'The register, name-ordered, plus the two things a screen needs in order to be a screen ' +
      'rather than a form: the **role vocabulary in the order it should be offered**, and the ' +
      '**capability table** saying what each role reaches.\n\n' +
      '**The capability table is served, not restated.** It is authored once, in `ROLE_CAPABILITIES` ' +
      'in `routes/users.ts`, and travels inside this response. A second copy in the browser would be ' +
      'free to describe a permission model this server does not implement — and the sentence a ' +
      'second copy is most likely to lose is the one saying that an `administrator` reaches ' +
      '**nothing a staff account does not**. That is a decision, not an unfinished middle tier.\n\n' +
      '**No response from this file contains a password or a password hash.** The query does not ' +
      'select `password_hash` at all; `hasPassword` is a boolean computed in SQL. An account with ' +
      '`hasPassword: false` cannot be signed in to yet, whatever its role says.\n\n' +
      '**The bootstrap account is not in this list and cannot be.** It is synthesised from ' +
      '`SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` in `.env`, has no `app_user` row, and is ' +
      'checked before the table — so `POST` refuses to create a row for that address rather than ' +
      'letting a second, unreachable account appear to exist.\n\n' +
      '**`counts.unassigned` and `counts.withoutPassword` are the operator\'s queue.** They are the ' +
      'two states a signed-in account cannot be in, and each is a different reason: no sign-in ' +
      'organization, or no credential. They are counted here rather than left for a reader to ' +
      'derive from the rows, because "derived on the client" is where two screens start disagreeing.',
    tags: ['Users'],
    response: z
      .object({
        items: z.array(UserSchema).openapi({ description: 'Every account, name-ordered.' }),
        counts: z
          .object({
            total: intReq('Rows in the register, the bootstrap account excluded.'),
            superAdmins: intReq('Accounts holding `super_admin`.'),
            administrators: intReq('Accounts holding `administrator` — recorded, and granting nothing.'),
            staff: intReq('Accounts holding `staff`.'),
            unassigned: intReq(
              'Accounts with no sign-in organization. **These accounts cannot sign in** — the ' +
                'sign-in path refuses a null rather than falling back to the default tenant — so ' +
                'this is a number to act on, not a statistic.',
            ),
            withoutPassword: intReq(
              'Accounts with no `password_hash`. Also unable to sign in, for the other reason. ' +
                '`npm run set:password -- --email <address>` fixes one of these; `PATCH` here does not.',
            ),
          })
          .openapi('UserListCounts'),
        bootstrapEmail: z
          .string()
          .nullable()
          .openapi({
            description:
              'The address the bootstrap account answers to, or `null` when none is configured. ' +
              '**Sent so that a screen can name the one account it cannot list.** `.env` is ' +
              'checked before the table, so this address signs in and has no row here; a list ' +
              'that silently omitted it while the counts excluded it would leave a reader to ' +
              'work out why the register does not add up to what they can see. It is not a ' +
              'secret — it is the address a super admin already knows — and it is `null` rather ' +
              'than absent so that "no bootstrap account" is distinguishable from "this server ' +
              'predates the field".',
          }),
        roles: z
          .array(RoleSchema)
          .openapi({
            description:
              'The vocabulary, in the order it should be offered: most privileged first, so a ' +
              'picker\'s first entry is not the one somebody accidentally accepts.',
          }),
        capabilities: z
          .array(CapabilitySchema)
          .openapi({
            description:
              'What each role reaches, authored on the server. The screen prints this; it does ' +
              'not decide it.',
          }),
      })
      .openapi('UserListResponse'),
    errors: [401, 403, 500, 503],
    handler: async (ctx) => {
      await requireSuperAdmin(ctx.req, 'the user register');
      await requireAppSchema('The user register');

      const accounts = await allUsers();
      const memberships = await allMemberships();

      const roleCount = (role: Role): number =>
        accounts.filter((row) => roleOf(row.role, row.email) === role).length;

      return {
        items: accounts.map((row) =>
          toWire(
            row,
            memberships.filter((m) => columnNumber(m, 'user_id') === columnNumber(row, 'id')),
          ),
        ),
        counts: {
          total: accounts.length,
          superAdmins: roleCount('super_admin'),
          administrators: roleCount('administrator'),
          staff: roleCount('staff'),
          unassigned: accounts.filter((row) => row.organization_id === null).length,
          withoutPassword: accounts.filter((row) => columnNumber(row, 'has_password') !== 1).length,
        },
        bootstrapEmail: config.superAdmin.email ?? null,
        roles: [...ROLE_ORDER],
        capabilities: capabilities(),
      };
    },
  });

  // -------------------------------------------------------------------------
  // Creating one.
  // -------------------------------------------------------------------------
  api.route({
    method: 'post',
    path: '/api/users',
    operationId: 'users_create',
    summary: 'Create an account and set its first password',
    description:
      'Creates one account — address, display name, role, the organizations it belongs to, and the ' +
      '**first password**, which the administrator chooses and tells the person out of band. ' +
      '**Super admin only**, for the same reason as the organization register: the register that ' +
      'hands out access is itself an access question. A caller without the role is refused **403** ' +
      'rather than 401, so they are not sent round a sign-in loop that cannot help them.\n\n' +
      '**The membership rule is checked here and could not be checked by the database.** At least ' +
      'one membership is required, and the sign-in organization has to be one of them. Neither is ' +
      'expressible as a constraint — a `CHECK` cannot count rows in another table — so both live in ' +
      '`assertSignInOrganization` and every write in this file goes through it. `{"organizations": ' +
      '[]}` is refused rather than creating an account that can sign in and then has nothing to show.\n\n' +
      '**`primaryOrganizationId` may be left out when there is exactly one membership**, because ' +
      'then there is only one possible answer. With several it is required: nothing says which of ' +
      'two organizations a sign-in should land in, so "pick the first" would be a silent guess ' +
      'deciding every query the person runs. Naming it turns the guess into an answer somebody gave.\n\n' +
      '**The address is lower-cased and must be unique.** `Dana@x.gov` and `dana@x.gov` are one ' +
      'account, and a second row for an address that already exists is **409** naming the clash ' +
      'rather than a 500 from the unique index.\n\n' +
      '**The bootstrap address cannot be created here.** A row for `SUPER_ADMIN_EMAIL` would be ' +
      'inert — `.env` is checked before the table, so the row could never sign in and its role could ' +
      'never apply — and its presence would suggest an account that does not exist. The request is ' +
      'refused **409** with that explanation.\n\n' +
      '**`role` defaults to `staff`**, which is also the column\'s default and its `CHECK`\'s least ' +
      'privileged value. An account created as an `administrator` reaches exactly what it would have ' +
      'reached as `staff`; the role is recorded so an operator can say what somebody is.',
    tags: ['Users'],
    body: z
      .object({
        email: EmailSchema,
        name: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .openapi({ example: 'Dana Reed', description: 'What to call the person. Required.' }),
        role: RoleSchema.optional().openapi({
          description: 'Defaults to `staff`, the least privileged role.',
        }),
        organizations: z
          .array(IntParam)
          .min(1)
          .openapi({
            example: [1],
            description:
              'The organizations this account belongs to. **At least one, and it is enforced here ' +
              'because the database cannot enforce it.** Duplicates are collapsed — a repeated id ' +
              'names the same membership, and the composite primary key would refuse it anyway.',
          }),
        primaryOrganizationId: PrimaryAskSchema.optional().openapi({
          description:
            'Which of them the account **signs in to**. Optional when `organizations` holds exactly ' +
              'one id, required when it holds more — see the route description.',
        }),
        password: PasswordSchema,
      })
      .openapi('UserCreate'),
    response: UserSchema,
    errors: [400, 401, 403, 409, 500, 503],
    handler: async (ctx) => {
      await requireSuperAdmin(ctx.req, 'the user register');
      await requireAppSchema('The user register');

      const body = ctx.body as {
        email: string;
        name: string;
        role?: Role;
        organizations: number[];
        primaryOrganizationId?: number | null;
        password: string;
      };

      const email = body.email.trim().toLowerCase();
      const name = body.name.trim();
      const role: Role = body.role ?? 'staff';
      const organizations = distinct(body.organizations);

      // ★ THE BOOTSTRAP ADDRESS IS REFUSED BEFORE ANY WORK, INCLUDING BEFORE THE
      //   MEMBERSHIP CHECKS, because no membership set makes this request valid.
      if (email === config.superAdmin.email) {
        throw AppError.conflict(
          `"${email}" is the bootstrap super admin address, configured in \`.env\`. The sign-in ` +
            'path checks that setting BEFORE it reads this table, so a row here could never sign ' +
            'in and its role could never apply — it would be an account that appears to exist and ' +
            'does not. To change the bootstrap account, change `SUPER_ADMIN_EMAIL` and ' +
            '`SUPER_ADMIN_PASSWORD`; to create a real second super admin, use a different address.',
          { email },
        );
      }

      const clash = await findByEmail(email);
      if (clash) {
        throw AppError.conflict(
          `An account already exists for "${email}" — ${clash.display_name}. The address is how ` +
            'sign-in finds the row, so two cannot share one. Edit that account, or give this one a ' +
            'different address; if the two are really the same person, there is nothing to add.',
          { email, existing: clash.display_name },
        );
      }

      await assertOrganizationsExist(organizations);
      const primary = resolvePrimary(body.primaryOrganizationId, organizations, null);
      assertSignInOrganization(primary, organizations);

      // Hashing before the insert, so a password that cannot be derived refuses
      // the request rather than leaving a half-written row behind.
      const hash = await hashPassword(body.password);

      await execute(
        'INSERT INTO app_user (email, display_name, role, organization_id, password_hash) ' +
          'VALUES (:email, :name, :role, :primary, :hash)',
        { email, name, role, primary, hash },
      );

      // The id is read back rather than taken from the write: `lastInsertRowid` is
      // null on SQL Server. The address is unique, so this names one row.
      const created = await readBackByEmail(email);
      const userId = columnNumber(created, 'id');

      await writeMemberships(userId, email, organizations);

      return readBack(userId);
    },
  });

  // -------------------------------------------------------------------------
  // Editing one.
  // -------------------------------------------------------------------------
  api.route({
    method: 'patch',
    path: '/api/users/{id}',
    operationId: 'users_update',
    summary: 'Change an account\'s name, role, or the organizations it belongs to',
    description:
      'Partial update: only the supplied fields change. Super admin only, for the same reason as ' +
      '`POST`.\n\n' +
      '**The password is not here.** It has its own route, `POST /api/users/{id}/password`, because ' +
      'setting a credential and editing a record are different acts with different consequences — ' +
      'one invalidates what somebody knows and the other does not — and a `PATCH` that quietly ' +
      'accepted a `password` field would make "did this change their password?" a question about ' +
      'which fields happened to be in the body.\n\n' +
      '**`organizations` replaces the whole set, and the three membership facts are re-checked on ' +
      'the result.** The set may not be emptied, and the sign-in organization has to be a member of ' +
      'it. `PATCH {"organizations": []}` is refused **400** rather than detaching the account: it ' +
      'would leave somebody able to sign in with nothing to see. To move a person between tenants, ' +
      'name the new set — the request either names the state it wants or it changes nothing.\n\n' +
      '**A `PATCH` that names neither `organizations` nor `primaryOrganizationId` does not touch ' +
      'either**, and does not re-check them. That is deliberate: an account created outside this ' +
      'API with no sign-in organization is a state a role change cannot fix, and silently filling ' +
      'the column from a membership would be a write the caller did not ask for. Such a row comes ' +
      'back with `primaryOrganizationId: null`, the screen shows it as unable to sign in, and the ' +
      'fix is a `PATCH` that names both.\n\n' +
      '**`primaryOrganizationId: null` is refused.** A null sign-in organization is precisely the ' +
      'state the sign-in path rejects, so this endpoint will not create it. Moving an account means ' +
      'naming a different organization, not un-naming the one it has.\n\n' +
      '**There is no last-super-admin guard, and the reason is checkable rather than optimistic.** ' +
      'An operator who demoted the only `super_admin` row would still be able to sign in as the ' +
      'bootstrap account, because that identity is `SUPER_ADMIN_EMAIL` and ' +
      '`SUPER_ADMIN_PASSWORD` in `.env` and is not a row at all. No `PATCH` in this file can reach ' +
      'it, so the way back in cannot be removed by the register.',
    tags: ['Users'],
    params: z
      .object({ id: IntParam })
      .openapi({ description: 'The account id.', example: { id: 2 } }),
    body: z
      .object({
        name: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .openapi({ description: 'A new display name.' }),
        role: RoleSchema.optional().openapi({
          description:
            'A new role. Setting `administrator` on an account that is already `staff` records a ' +
            'fact and grants nothing — see `capabilities` in the list response.',
        }),
        organizations: z
          .array(IntParam)
          .optional()
          .openapi({
            description:
              'The complete new membership set, replacing what is stored. **Not a set of additions ' +
              'or removals** — `PATCH` is a state, and a set of deltas would need a second endpoint ' +
              'to answer "what is the state now?". At least one id, always; the primary must be ' +
              'among them.',
          }),
        primaryOrganizationId: PrimaryAskSchema.optional().openapi({
          description:
            'Which organization the account signs in to from now on. Must be one of the resulting ' +
              'memberships. Omit it and the current one is kept when it is still a member.',
        }),
      })
      .openapi('UserUpdate'),
    response: UserSchema,
    errors: [400, 401, 403, 404, 500, 503],
    handler: async (ctx) => {
      await requireSuperAdmin(ctx.req, 'the user register');
      await requireAppSchema('The user register');

      const { id } = ctx.params as { id: number };
      const body = ctx.body as {
        name?: string;
        role?: Role;
        organizations?: number[];
        primaryOrganizationId?: number | null;
      };

      /**
       * ★ NOTHING NAMED IS A MISTAKE IN THE REQUEST, NOT A NO-OP TO SWALLOW —
       *   the same rule `PATCH /api/organizations/{slug}` applies. It would
       *   otherwise return 200 and a row the caller believes it edited. Note that
       *   a request that names a field and *repeats its current value* is not this
       *   case: that is a real request with nothing to do, and it is answered with
       *   the row rather than refused.
       */
      const supplied =
        body.name !== undefined ||
        body.role !== undefined ||
        body.organizations !== undefined ||
        body.primaryOrganizationId !== undefined;

      if (!supplied) {
        throw AppError.badRequest('No fields were supplied.', {
          accepts: ['name', 'role', 'organizations', 'primaryOrganizationId'],
        });
      }

      const existing = await findById(id);
      if (existing === null) throw AppError.notFound(`Account ${id}`);

      const currentPrimary =
        existing.organization_id === null ? null : columnNumber(existing, 'organization_id');
      const currentMemberships = (await membershipsFor(id)).map((m) =>
        columnNumber(m, 'organization_id'),
      );

      const sets: string[] = [];
      const args: Binds = { id };

      if (body.name !== undefined) {
        sets.push('display_name = :name');
        args.name = body.name.trim();
      }

      if (body.role !== undefined) {
        sets.push('role = :role');
        args.role = body.role;
      }

      // ★ WHETHER THE MEMBERSHIP RULE APPLIES IS DECIDED BY WHAT WAS ASKED, NOT BY
      //   WHAT IS STORED. A PATCH that names neither field touches neither, and
      //   re-checking an untouched state would refuse a role change on a row this
      //   API did not write — a refusal the caller could not act on.
      const touchesMembership =
        body.organizations !== undefined || body.primaryOrganizationId !== undefined;

      let resulting = currentMemberships;
      let primary = currentPrimary;

      if (touchesMembership) {
        resulting =
          body.organizations === undefined ? currentMemberships : distinct(body.organizations);
        await assertOrganizationsExist(resulting);
        primary = resolvePrimary(body.primaryOrganizationId, resulting, currentPrimary);
        assertSignInOrganization(primary, resulting);

        if (primary !== currentPrimary) {
          sets.push('organization_id = :primary');
          args.primary = primary;
        }
      }

      // No second "nothing to do" check here, and the absence is deliberate.
      // `supplied` above already refused a request that named nothing; a request
      // that named a field and repeated its current value is a real request that
      // happens to change nothing, and refusing it would be telling the caller off
      // for agreeing with the store.
      if (sets.length > 0) {
        await execute(`UPDATE app_user SET ${sets.join(', ')} WHERE id = :id`, args);
      }

      if (body.organizations !== undefined) {
        await writeMemberships(id, existing.email, resulting);
      }

      return readBack(id);
    },
  });

  // -------------------------------------------------------------------------
  // Setting a password.
  // -------------------------------------------------------------------------
  api.route({
    method: 'post',
    path: '/api/users/{id}/password',
    operationId: 'users_set_password',
    summary: 'Set an account\'s password',
    description:
      'Replaces the stored `scrypt` derivative for one account, and returns the account. Super ' +
      'admin only.\n\n' +
      '**The old password is not needed and is not supplied.** This is an administrator setting a ' +
      'credential, not a person changing their own — there is no self-service password change in ' +
      'this project, and pretending there is by requiring the old value would be a check that only ' +
      'appears to protect something, since the caller is already a super admin.\n\n' +
      '**Sessions already issued keep working.** They are random tokens with a fixed twelve-hour ' +
      'lifetime and are not re-validated against the credential, so this closes the door for the ' +
      'next sign-in rather than ending the current one. That is a real property of the design ' +
      'rather than a bug to be surprised by, and it is stated here because an operator resetting a ' +
      'password because of a suspected compromise needs to know it.\n\n' +
      '**The password is never returned, and neither is the hash.** The response is the account row ' +
      'in the same shape the list uses, with `hasPassword` now `true`.\n\n' +
      '**A length floor, and no strength policy.** Eight characters minimum. This project has no ' +
      'dictionary check, no breach list and no rotation; validating an uppercase letter and a ' +
      'symbol would make a weak password look checked, which is worse than saying plainly that the ' +
      'floor is all there is.',
    tags: ['Users'],
    params: z
      .object({ id: IntParam })
      .openapi({ description: 'The account id.', example: { id: 2 } }),
    body: z.object({ password: PasswordSchema }).openapi('UserPasswordSet'),
    // ★ 200, NOT THE 201 A POST DEFAULTS TO. Nothing is created — a derivative that
    //   was already there is replaced — and a 201 with no `Location` is the kind of
    //   answer a client caches wrongly. The default would have to be overridden
    //   here even if it were only a cosmetic choice, because `POST` means "submit"
    //   as often as it means "create".
    status: 200,
    response: UserSchema,
    errors: [400, 401, 403, 404, 500, 503],
    handler: async (ctx) => {
      await requireSuperAdmin(ctx.req, 'the user register');
      await requireAppSchema('The user register');

      const { id } = ctx.params as { id: number };
      const body = ctx.body as { password: string };

      const existing = await findById(id);
      if (existing === null) throw AppError.notFound(`Account ${id}`);

      const hash = await hashPassword(body.password);

      await execute('UPDATE app_user SET password_hash = :hash WHERE id = :id', { id, hash });

      return readBack(id);
    },
  });
}
