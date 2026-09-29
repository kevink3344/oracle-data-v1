# Users & roles — who may sign in, which organization they sign in to, and what the role buys

## What was asked

> I would like to build out the users and roles page. This should sit in Settings underneath
> 'Organizations'. Please implement this feature. Ask any clarifying questions as needed.
> Keep in mind every user will belong to at least one organization.

Five questions were asked before anything was built. **All five answers are binding** and each
one changed the design, so they are recorded verbatim rather than paraphrased.

| # | Question | Answer |
|---|---|---|
| 1 | Where does the screen live? | **A section inside Settings, beneath the Organizations panel** — no new route, no `/admin/users` |
| 2 | One organization per user, or many? | **One or many — a membership join table** |
| 3 | What is the role vocabulary? | **`super_admin`, `administrator`, `staff`** |
| 4 | May the page create accounts, or only change existing ones? | **Also create accounts — the admin sets a first password** |
| 5 | Who may open it? | **`super_admin` only, consistent with Organizations** |

---

## The answer in one line

**`organization_id` on `app_user` was a good column for a question this feature changes the answer
to.** It holds one organization and `01-app.sql` argues in a header note that the column is nullable
only to mean *"not assigned yet"*, because every user belongs to exactly one tenant. Answer 2 makes
that false: a person can belong to two tenants. So the feature adds a **membership join table**, keeps
`organization_id` as *the organization the account signs in to*, and — this is the part that costs
something — has to **change a `CHECK` constraint on a table that already exists**, which SQLite cannot
do in place. The screen is the easy half. The honest half is that the third thing the user asked for,
a third role, is a schema migration, and `01-app.sql`'s own comment predicted exactly this:
*"there are two roles and a third would be a decision, not a migration."* The decision has been made.

---

## The measurement that shapes the design

Everything below is measured from this repo. Nothing is assumed.

### 1. The store the agent runs against carries the old CHECK, so the migration is not hypothetical

```
server/tmp-probe-app-user.mjs → data/sql/turso/sample.db

  app_user rows            0
  stored role column       role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('super_admin','member'))
  app_user_organization    (absent)
  PRAGMA foreign_keys      1
  PRAGMA legacy_alter_table 0
  sqlite_version           3.45.1
```

Three consequences, and the third is the one that bites:

- **The rebuild will actually execute** the first time the new code boots against the shipped sample.
  It is verifiable locally, so it is not a migration shipped on faith.
- **There are zero `app_user` rows to convert**, so the row-copy step is a no-op on the local store —
  which means the *data* half of the migration (`member` → `staff`) is **not** exercised locally.
  The Azure SQL mirror, which has live rows, is where it matters. The smoke suite inserts a row with
  the old value on purpose so the mapping is exercised somewhere.
- **`PRAGMA foreign_keys` is 1** (`server/src/db/driver.ts:143`), so a table rebuild cannot ignore
  referential integrity. This is load-bearing: SQLite's modern `ALTER TABLE ... RENAME TO` **rewrites
  the `REFERENCES` clauses in other tables** to point at the new name. The moment
  `app_user_organization` exists and references `app_user`, a naive rename to `app_user_legacy`
  silently repoints the child at a table that is about to be dropped. Two mitigations, both cheap:
  the migration runs **before** the DDL statements in `apply()` (so the child table does not exist
  yet on the run that rebuilds), **and** `PRAGMA legacy_alter_table = ON` is set around the rename
  (so a clause can never be rewritten even if the ordering were ever changed by someone else).

### 2. ★ THE LIVE TARGET IS SQL SERVER, SO THE *T-SQL* ARM IS THE ONE THAT RUNS

`DB_MODE=sqlserver` against `wcpsssqlelasticpool.database.windows.net / wcpss-oracle-sync`, and
`APP_DB_URL` is unset — so `resolveAppDb` returns the ledger's own connection with **`shared: true`**
(`server/src/config/env.ts:822`). One database holds both the mirrored ledger and the app's own tables.

`apply()` chooses the DDL by the **store's dialect, not by `DB_MODE`** (`app-schema.ts:265`):

```ts
const isSqlServer = store.dialect === 'sqlserver';
const schemaFile = findSchemaFile(isSqlServer ? 'sqlserver' : 'turso');
```

So **`data/sql/sqlserver/01-app.sql` is the file that actually executes.** Editing only the Turso arm
would ship a feature that works locally and does nothing in the environment anyone uses. A read-only
probe of the live database:

```
tables present   app_user, organization          ← no app_user_organization
rows             users 0, organizations 1
roles in use     (none — the table is empty)
CK_app_user_role ([role]='member' OR [role]='super_admin')      ← the OLD definition
```

**Two things follow, and the second is the one that would have been missed:**

- `dbo.app_user` is created inside `IF OBJECT_ID(...) IS NULL`, so a widened `CHECK` in the DDL body
  reaches a **fresh** store and **never revisits this one**. And `applyPinCategoryMigration` is
  skipped for SQL Server by name (`app-schema.ts:296`), so the SQLite precedent cannot cover it. The
  SQL Server arm needs **its own** migration — the same gap `applyColumnAdditionsSqlServer` exists to
  close.
- **The `DEFAULT` has to move with the `CHECK`.** `role NVARCHAR(20) NOT NULL DEFAULT 'member'` plus a
  constraint that no longer admits `'member'` means any `INSERT` that omits the column writes a value
  the table now forbids. The default is an unnamed constraint, so it has to be found through
  `sys.default_constraints` rather than dropped by a literal name.

### 3. Changing a `CHECK` is a table rebuild, and this repo has already done it once

`applyPinCategoryMigration` (`server/src/db/app-schema.ts:329`) exists for exactly one reason: it had
to widen `user_pin.category` from four values to five. Its shape is the shape this feature copies —
read `sqlite_master.sql` for the table, return early if the stored definition already contains the new
value, otherwise rename → create → copy → drop → recreate the index — and it is **non-fatal**: it
catches, `console.warn`s, and returns `false` rather than throwing, because a failed migration must not
stop the process. The four steps are unchanged here. What is new is the child table.

### 4. `app_user` is written in exactly two places, and neither is a route

`server/src/scripts/set-password.ts` says so itself:

> There is currently **no other way to give an account a password.** … there is no `/api/users`, and
> `/admin/users` is declared `built: false` in `app/src/nav/menu.ts`. So the only paths that write
> `app_user` at all are the smoke suite and this file.

That docstring is a gate. Answer 4 makes it false, and it has to be rewritten rather than left to
rot — the same discipline the codebase applies to the 400-vs-401 note in `smoke.ts`.

### 5. `member` is load-bearing in the smoke suite in five places

`member` is not just a string in a CHECK. It is the *lower* role, and the suite uses it to prove the
403/401 distinction:

| Gate | What it asserts about `member` |
|---|---|
| anonymous control | four routes → 401 `UNAUTHORIZED` |
| malformed anonymous POST | 400 `VALIDATION_FAILED` — **schema runs before the guard** |
| member with a valid session | four routes → 403 `FORBIDDEN`, `details.role === 'member'`, message includes the email and `organization register`, and does **not** include `can change an organization` |
| member sign-in | `data.user.role === 'member'` |
| cleanup | zero rows left in `organization` and `app_user` |

Renaming `member` to `staff` therefore **breaks these on purpose**. They are updated deliberately,
not deleted — the same way `smoke.ts` says about the 400/401 ordering check: *"If this ever becomes
401 the vulnerability is closed and this check should be inverted — not deleted."*

---

## The design

### Roles, and one table that says what they buy

```
super_admin     read the register · create and edit organizations · read the user register ·
                create accounts · set passwords · change a role, a primary organization, memberships
administrator   nothing a staff account does not already have
staff           read what the app shows
```

**★★ `administrator` IS RECORDED, AND TODAY IT GRANTS NOTHING EXTRA. THIS IS DELIBERATE AND IT IS
PRINTED ON THE SCREEN.**

The user named three roles and answered question 5 "`super_admin` only". Both are honoured literally,
and the consequence is that `administrator` and `staff` are indistinguishable to the server. Two
wrong ways to handle that were available and both are refused:

- **Invent a capability** so the role means something — e.g. let an administrator edit users. That
  contradicts answer 5, which is a decision the user made, not a gap they left.
- **Quietly render the two identically**, so an operator grants `administrator` expecting authority
  and is never told there is none. That is the failure that gets someone's access reviewed a year
  late.

So the role is a **recorded fact with a stated consequence**: `ROLE_CAPABILITIES` is one table on the
server, it is sent to the client inside the list payload, and the screen prints, per role, the exact
sentences of what it may do — including the sentence that says `administrator` may do nothing a staff
account may not. The client cannot hold a second opinion about a role, because it never holds one:
it renders what the server sent. And the table is **gated**: a smoke check walks every
`METHOD /api/users…` route against every role and fails if the reachable set changes, so granting
`administrator` anything later is a deliberate edit to the table plus a deliberate edit to the gate.

### Membership — the join table, and what `organization_id` becomes

```sql
CREATE TABLE IF NOT EXISTS app_user_organization (
  user_id         INTEGER NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  organization_id INTEGER NOT NULL REFERENCES organization(id),
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, organization_id)
);
```

- **`user_id → CASCADE`.** A membership is a statement *about a user*; there is nothing to keep when
  the user is gone. (Nothing deletes a user today — see non-goals — so this is a correctness
  statement, not a behaviour anyone can reach yet.)
- **`organization_id` → no action**, matching `app_user.organization_id`'s existing choice: deleting
  an organization people belong to must **fail**, not silently detach them.
- **`app_user.organization_id` keeps its meaning and gains precision: it is the organization the
  account signs in to.** It stays nullable so that "not assigned" and "belongs" remain different
  states, and `actorFor` keeps refusing a null with its existing 403 — which already says *"A super
  admin assigns one on the Users & roles screen."* That sentence was written before the screen
  existed. Now it is true.

**★ EVERY USER BELONGS TO AT LEAST ONE ORGANIZATION, AND THE DATABASE CANNOT SAY SO.**
SQLite has no cross-table `CHECK`, so "at least one membership" is not expressible as a constraint.
It is enforced in **one place on the server** (the write path, for both create and patch) and asserted
by smoke. The rule is threefold and stated rather than implied:

1. memberships may not be empty;
2. the primary organization (`organization_id`) must be a member of the set;
3. the primary may **not be removed** from its own set by a patch — the server refuses and says why.

A second membership does **not** change what that person sees. The session resolves one tenant, and
the tenant is the primary. That limit is printed on the screen, because a screen that accepts a second
organization and behaves as though it had not is worse than one that refuses.

### Routes — `server/src/routes/users.ts`, tag `Users`

| Route | Purpose |
|---|---|
| `GET /api/users` | the register: every account, its role, its primary organization, its full membership set, whether it has a password, whether it has ever signed in, and whether it is you |
| `POST /api/users` | create an account — email, name, role, **first password**, primary organization, memberships |
| `PATCH /api/users/{id}` | change name, role, primary organization, memberships. **Never a password** |
| `POST /api/users/{id}/password` | set a password for someone else |

Every one of them calls `requireSuperAdmin(ctx.req, 'the user register')`. That second argument is new
and it exists because of a note already in `guard.ts`: the refusal names the **capability, not the verb**
— it used to say *"only a super admin can change an organization"* for a `GET`, which sent a reading
member to ask for permission they were not after. Reusing that message verbatim on a users route would
repeat the mistake, one register over, so the register is a parameter with the old string as its
default. The four existing org routes are unchanged and their smoke assertions still hold.

Passwords never appear in a response, in either direction. `hashPassword` runs before the write; the
SQL Server and SQLite arms both store `scrypt$N$r$p$salt$key`.

---

## Guardrails

- **Three hand-copied table lists must move together**, and a miss is silent: `APP_TABLES`
  (`db/app-schema.ts`), `ROUTING_APP_TABLES` (`db/store.ts`) — an unregistered app table falls through
  to the ledger and dies `ORA-00942` with nothing naming the registry — and `APP_OWNED_TABLES`
  (`scripts/verify-turso-sample.mjs`), which gate **G13a** diffs against the `CREATE TABLE` names in
  `01-app.sql` in both directions.
- **Both DDL arms move together.** `data/sql/turso/01-app.sql` and `data/sql/sqlserver/01-app.sql` are
  hand-mirrored; the SQL Server arm names the constraint `CK_app_user_role` and T-SQL *can* drop and
  re-add a CHECK, so that arm does not need a table rebuild — and the reason it does not is recorded
  where the difference lives.
- **A route named `/api/users/password` would be captured by `/api/users/{id}`.** Not a problem for
  the four routes above (they differ in segment count), but the discipline is the one that already
  bit `/api/views/subscriptions`.
- **`POST /api/users` is a genuine write**, so it gets **no** `READ_ONLY_POSTS` entry — `writesGuard`
  already refuses every non-`GET` when the store is not writable, which is the correct behaviour.
- **The framework wraps a handler's return in `{ data }`** — handlers return the bare payload.
- **`requireSuperAdmin` returns the `Actor`**, so it must be awaited into a variable when used.

---

## Non-goals, stated so they are not mistaken for gaps

- **No delete.** Removing an account raises "what happens to the last super admin", which is a
  question with a real answer that nobody has asked for yet. The `ON DELETE CASCADE` above is
  correctness for a path that does not exist.
- **No self-service password change.** The page sets *someone else's* password, which is what answer 4
  asked for. Changing your own is a different screen with a different threat model (it needs the old
  password).
- **`/admin/users` is retired, not repointed.** It is `built: false` today. Repointing it at
  `/settings` would put two nav leaves on one address, and the second one would be dead. The leaf is
  removed with a note, because a rail entry reading *"Users & roles — not built"* beside a built
  Users & roles section is worse than no entry at all.
- **No `Users` route of its own.** Answer 1 put the screen in Settings, and a second address for one
  screen is a second place to fix.

---

## Verification

| Gate | What it proves |
|---|---|
| `npx tsc -b --force` + `npm run build` (app) | the new section compiles against the new data module |
| `npx tsc -b` (server) | the widened `Role` union is exhaustive at every use site |
| `npm run smoke` (server) | the gates below |
| `scripts/verify-turso-sample.mjs` | G13a: the DDL and `APP_OWNED_TABLES` agree |
| browser, via the `app: dev` task | the section renders under Organizations and the drawer still works |

New smoke gates:

1. **the role vocabulary is three, and a fourth is refused** — by the database, not by Zod alone.
2. **the migration left the store usable** — `app_user`'s stored `sqlite_master.sql` names all three
   roles (i.e. the rebuild ran), and a row written with the **old** value `'member'` was converted.
3. **every users route refuses an anonymous caller 401 and a non-super-admin 403**, the 403 naming
   *the user register* and not *the organization register*.
4. **a create with no membership is refused 400** — the "at least one organization" rule.
5. **a create whose primary is not among its memberships is refused 400.**
6. **a patch that removes the primary from its own set is refused 400.**
7. **a created account can sign in** with the password the admin set, and its session lands in the
   primary organization — the credential round-trips through `hashPassword`, and #2's mapping is
   exercised end to end.
8. **no response body anywhere contains the substring `password`** other than the field names on the
   request side — asserted over the serialized payload of every users route.
9. **the capability table is gated**: the reachable route set per role equals the set the table claims.
10. **cleanup**: no account, membership or organization left behind.
