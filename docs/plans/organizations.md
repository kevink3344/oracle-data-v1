# Organizations — a tenant for the scope, the fiscal year, and the data behind it

## What was asked

> I would like a plan for Organizations. Only the "Super Admin" can set up an Organization
> (I will put the SUPER ADMIN info in the .env file). When they log in, in the upper left hand
> corner will be a Settings icon. This will take them to the Settings page where the first option
> an expandable accordion labeled "Organizations" Inside is a list with all of the Organization
> names and a "+New" button. When the admin selects "New" the following detail information is
> required: Name of the organization, Fund (single select 01-04), Program (multi-select, say 861,
> 862), and Start FY (text like "2022"). Every user in the system will be associated with one
> Organization, and when they log in the data will be scoped from the Organization configuration
> above. The data will come directly from Oracle starting with the Start FY to present (2022-2026).

**This is a plan, not an implementation.** Nothing has been built, and **nothing is undecided** — every
question in [§8 Decisions](#8-decisions) is answered. The two that shape the data: an organization
**replaces** the hardcoded scope constant, and the picker offers the chart of accounts' **real values**
rather than the literal `01`–`04`. The one that shapes the build order: **the app-owned store comes
first**, and the app store gets its own connection (**`APP_DB_URL`**) independent of `DB_MODE`, so
app-owned tables have a home in every mode including `oracle` (§7). The three that close the loose
ends: Start FY stays **free text**, an organization that selects nothing shows **`No rows found`**, and
a **signed-out visitor still browses** the default organization.

---

## The answer in one line

**An Organization is a tenant whose two properties — *which fund/programmes* and *from which fiscal
year* — are already written down twice in this repo as hardcoded constants, and whose data today
comes from static JSON rather than from Oracle. With "replace" settled, this feature is literally
the **deletion of those constants**: `scope.ts` stops holding a value and starts reading a row, the
pull script stops holding a value and starts reading the same row, and the extract's own `scope` block
— which already exists — is promoted from a curiosity into the check that the two agree. The screen
the request describes is the easy half; the honest half is that a Fund picker offering `01`–`04` and a
Start FY of `2022` both remove **exactly zero rows** from the data this app can actually read, and the
real chart of accounts holds neither the funds nor the pairing the request assumes.**

---

## The measurement that shapes the design

Every figure below is measured from this repo, not assumed. The probe scripts are named where a
number needs re-checking.

### 1. Fund and programme are not the free choices the request assumes — they are coupled, and `01`–`04` is not the value set

`GL_CODE_COMBINATIONS` (`data/sql/turso/sample.db`, 520 rows), the chart of accounts the whole app is
built on:

```
SEGMENT1 (Fund)      00 → 7    01 → 20    04 → 493
SEGMENT3 (Program)  000 → 7   220 → 20   861 → 14   862 → 479

fund/programme pairs that exist:  00/000 (7)   01/220 (20)   04/861 (14)   04/862 (479)
```

Three things follow, and all three are load-bearing:

- **There is no Fund `02` and no Fund `03`.** A single-select offering `01`–`04` offers two values
  that select nothing. Worse, either of them *alone* empties every screen — the same failure
  `app-scope-filter.md` was written to prevent.
- **Fund `01` exists only with Programme `220`; Fund `04` only with `861` and `862`.** Fund and
  programme are **coupled in the data**. A free multi-select on each axis lets a reader author
  `Fund 01` + `Programme 861` — a combination that provably cannot return a row.
- **`00` / `000` are the unresolved placeholder accounts** (the 7 rows with no account of their own).
  They must be excluded from the picker, not offered as a tenant scope.

`FND_FLEX_VALUES` — the obvious place to read a value list from — **cannot supply this**. It holds one
row in this sample (value set `10105` = Level, `0450`). It also has no `SEGMENT_NUM` column at all;
the segment→name→value-set map is `FND_ID_FLEX_SEGMENTS` (`1..7` = Fund, Purpose, Programme, Object,
Level, Cost Center, Future Use). **The picker's values must come from `GL_CODE_COMBINATIONS`.**

### 2. Fiscal years run July–June and the app *already* uses Oracle's convention

`GL_PERIODS.PERIOD_YEAR` is **the fiscal year the period ends in**. FY2022 is `JUL-21 … JUN-22`;
`PERIOD_YEAR 2027` is `2026-07-01 … 2027-06-30`. Confirmed independently on the app side —
`data/oracle/invoices.json`'s own envelope reads:

```json
"window": { "from": "2026-07-01", "to": "2027-06-30", "fiscalYear": 2027 }
```

So a Start-FY floor is `` `${fy - 1}-07-01` ``. **A calendar-year boundary is wrong for every July–December
row** — this is a trap worth stating in the code, because bucketing by `new Date(d).getFullYear()` looks
right and is off by one for half the year.

### 3. Start FY `2022`–`2025` all remove exactly nothing; the PO extract begins in FY2025

`app/public/oracle/output.json` — the 2,782-line PO extract **every** project, object, dashboard and
combination screen reads (`server/tmp-fy2.mjs`):

```
ORDER_DATE  2025-01-02 → 2026-08-06

by fiscal year (the year it ENDS in):
  FY2025  1,544    FY2026  1,173    FY2027  65

half-year split, so the boundary is visible:
  2025-01-01 .. 2025-06-30   1,544
  2025-07-01 .. 2025-12-31     388
  2026-01-01 .. 2026-06-30     785
  2026-07-01 .. 2026-08-06      65

what a Start FY actually removes:
  Start FY 2022  (floor 2021-07-01)   kept 2,782   removed     0
  Start FY 2023  (floor 2022-07-01)   kept 2,782   removed     0
  Start FY 2024  (floor 2023-07-01)   kept 2,782   removed     0
  Start FY 2025  (floor 2024-07-01)   kept 2,782   removed     0
  Start FY 2026  (floor 2025-07-01)   kept 1,238   removed 1,544
  Start FY 2027  (floor 2026-07-01)   kept    65   removed 2,717
```

**Four of the five values in the requested 2022–2026 range are indistinguishable from "everything".**
This is not a reason to drop the field. It is the reason the field must **say what it removed** at
author time, exactly as `ScopeSelect` already does:

> Start FY `2022` — removes 0 of 2,782 rows. The earliest order date in the extract is 2025-01-02.

And the other sources do not agree on a floor at all:

| Source | Window today | Earliest row |
|---|---|---|
| `output.json` (PO lines) | not declared — observed | FY2025 (2025-01-02) |
| `invoices.json` | declared: FY2027 | 2026-07-01 |
| `checks.json` | **derived** from observed min/max | 2026-08-11 |
| `GL_PERIODS` in the sample | FY2022 → FY2029 | 2021-07-01 |
| `GL_BALANCES` in the sample | **FY2023 → FY2027** | — |

So "from Start FY to present" means a **different set of rows for each register**, and for two of them
it is *the same single fiscal year regardless of what you choose*.

### 4. One rule, three hardcoded copies — the feature's real work

The fund/programme scope is written down **three times** today, all to the same value:

| # | Where | Shape |
|---|---|---|
| 1 | `app/src/data/scope.ts` | `SCOPE = { fund: '04', programs: ['861','862','863'] }` — with the comment *"★ THIS IS THE ONLY PLACE THE RULE IS WRITTEN DOWN"* |
| 2 | `server/scripts/pull-invoices-extract.mjs:200` | `const SCOPE = { fund: '04', programs: ['861','862','863'] }` — its own comment says *"★ THE SCOPE MUST BE ABLE TO SAY WHAT IT COST"* |
| 3 | `data/oracle/invoices.json`, in the envelope | `"scope":{"fund":"04","programs":["861","862","863"]}` |

Copy 1 is *wrong* as a statement of ownership — it is the only place the rule is written in the
**frontend**, which is not the same thing. **With "replace" settled, an Organization supersedes all
three**: copy 1 and copy 2 stop holding a value and start reading the row, and copy 3 becomes the check
that the row and the delivered extract agree. Copy 3 needs no change at all — the extract already
declares its own scope and `invoices.ts` already reads it — only a promotion in rank (see §5).

### 5. The extracts pull **one** fiscal year, the latest — not a range

Both pull scripts bound the window with:

```sql
WHERE PERIOD_YEAR = (SELECT MAX(PERIOD_YEAR) FROM APPS.GL_PERIODS)
```

`pull-ap-extract.mjs`'s own header already measured the cost of widening it: *"one fiscal year ≈ 4,200
checks ≈ 2.4 MB"*. **"Start FY to present" is a change to the pull, not a filter applied after it.**

### 6. No authentication exists, and the ledger data is static JSON, not Oracle

> **⚠ SUPERSEDED — read this section as a dated record, not as a description of the code today.**
> The heading and the first two bullets below were true when this plan was written and are now false.
> The plan drove exactly the change they describe, so they are kept rather than deleted — a design
> document that quietly rewrites its own premises cannot be audited.
>
> - **Authentication exists.** `POST /api/auth/sign-in`, `GET /api/auth/session`, the `x-app-session`
>   header, `server/src/auth/session.ts` and `server/src/auth/guard.ts` (`requireActor`,
>   `requireSuperAdmin`) all landed. **Two domains enforce it** — the auth routes and every route
>   under `/api/organizations` — and the rest of the API is still deliberately open.
> - **`SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` are read.** They resolve through
>   `server/src/config/env.ts` (`SuperAdminConfig`), and that account is what signs in first.
> - **`app/src/data/session.ts` is still a constant.** That half of the bullet stands: the server can
>   now resolve an identity and the SPA does not yet ask for one.
> - The **ledger-from-`public/`** bullet below is untouched and still accurate.

- `server/src/**` contains no login, no token, no `Authorization` header handling. `app/src/data/session.ts`
  is a constant (`{ name: 'Dana Whitfield', initials: 'DW' }`) whose doc block already says:
  *"WHEN THE REAL SESSION ARRIVES, EVERYTHING HERE BECOMES A REQUEST."*
- `.env` (gitignored at `.gitignore:2`) **already carries** `SUPER_ADMIN_EMAIL` and
  `SUPER_ADMIN_PASSWORD` — and **nothing in `server/src` or `app/src` reads either key.** They were
  staged, not wired.
- The ledger data is **fetched from the app's own `public/`** (`extract.ts:16` →
  `fetch('/oracle/output.json')`; same for invoices, checks, budgets, encumbrances). Only app-owned
  things (`/api/projects`, `/api/activity`, saved views) go through the API. `extract.ts:12` says
  outright: *"when a real pipeline exists it becomes `fetch('/api/extract/current')`."*
- **★ A correction, because this plan carried the opposite for a while.** `oracledb@^7.0.1` **is**
  installed in `server/`, `resolveDb()` **does** have an `oracle` branch, and
  `server/src/db/oracle.ts` is a **working driver** — `client.ts` selects it. What is still missing is
  everything *around* it: `DB_MODES` is `['local','turso','oracle']` with **no `hybrid`**, `client.ts`
  chooses **one** driver and its doc block asserts that choice is singular, and `ensureAppSchema()`
  returns `state:'skipped'` in oracle mode — so **an app-owned `organization` table is unavailable
  exactly when the ledger is coming from Oracle.** That last clause is the whole reason hybrid moves.

**"The data will come directly from Oracle" is therefore a pipeline replacement, not a configuration
change.** It is the single largest item in this request and it is separable — see
[§7 Phasing](#7-phasing).

### 7. The app-owned-table question is answered — and hybrid is now on the critical path

`docs/plans/hybrid-mode-plan.md` (status: *Agreed, implementation in progress*) settles the design:
**Oracle for EBS reads, Turso for the app's own metadata, routed per statement by an explicit
registry.** Its `APP` class already lists `saved_view*` and the `X_REPORT_*` tables. **An
`organization` table is unambiguously `APP` class.** This plan does not invent an answer; it inherits
one.

**★ Settled: the app-owned store comes forward, because an Organization has to exist in every mode.**
Leaving it where it is means accepting that Organizations are unavailable *exactly when the ledger is
real* — which defeats the feature, since its entire purpose is that *"when they log in the data will
be scoped from the Organization configuration"*. It cannot be scoped from a row there is nowhere to
put. **What moves is the app store, not the mode name** — see the settled decision at the end of this
section.

**But hybrid is not one task, and the app-owned slice is separable — by hybrid's own rule.** That
document's routing rule is *"per statement, never per query-plan"*, and its §3 records the measurement
that makes the rule sufficient: **no statement in this codebase mixes an EBS table with an app-owned
one.** A statement routed to Turso therefore cannot reach Oracle, so the registry, the composite driver
and an app table's storage can all land **without** hybrid's two expensive halves:

| Hybrid build-order step (§9 of that plan) | Needed for an Organization? | Why |
|---|---|---|
| 4 — `store.ts`: registry, statement collector, `storeForTable()` | **Yes** | this *is* the app store |
| 6 — composite driver, dual resolution, `APP_DB_URL` in `env.ts` | **Yes** | same — and **without** the `hybrid` mode literal (below) |
| 5 — Oracle driver `LIMIT` rewrites | **Yes** | already largely built (§ below) |
| 8 — gate `resource.ts` writes on `storeForTable()` | **Yes, and cheap** | derives from the registry; it is what keeps EBS read-only |
| 1 — measure `GL_BALANCES`, time a derived-view subquery | **No** | gates the *view bodies*. Organizations read no EBS table |
| 3 — `derived.ts`, the three bodies, `IFNULL`→`COALESCE` | **No** | same |
| 7 — swap `V_*` uses for fragments, quote ~60 aliases | **No** | same |

**What exists today, measured rather than assumed — the slice is smaller than it looks:**

| Piece | State |
|---|---|
| `server/src/db/oracle.ts` (step 5) | **Exists** — pool, session formats, `DB_TYPE_DATE` fetch handler, `LIMIT` rewrites |
| `server/src/types/oracledb.d.ts` (step 2) | Exists |
| `server/src/db/store.ts` (step 4) | **Absent** |
| `server/src/db/hybrid.ts` (step 6) | **Absent** — `client.ts` picks one driver with `mode === 'oracle' ? … : …` |
| `server/src/db/derived.ts` (step 3) | **Absent** |
| `DB_MODES` (step 6) | `['local','turso','oracle']` — **and Phase 0 leaves it that way**; `APP_DB_URL` carries the app store instead |

**★ The caveat, and the answer to it.** Slicing hybrid does not make `hybrid` a usable mode: EBS reads
routed to Oracle without the view bodies and the alias quoting are *broken*, not merely untested. So an
Organization that exists only under `DB_MODE=hybrid` would be an Organization that exists in a mode
nobody can turn on yet.

**★ Settled: the app store is not tied to the ledger mode.** One setting — **`APP_DB_URL`**,
defaulting to the local sample file — gives app-owned tables a home **regardless of `DB_MODE`**. Under
`DB_MODE=oracle` as it stands today, Organizations work immediately, with EBS reads from Oracle and
EBS writes still refused by the `SELECT`-only grant. `hybrid` then becomes, later and optionally, the
*name* for a configuration this setting already expresses: *"the ledger is Oracle **and** there is an
app store"*.

**Two consequences worth stating, because both make Phase 0 smaller than this section first described:**

- **`DB_MODES` is not touched.** Phase 0 adds no mode literal, so the `['local','turso','oracle']` list
  — and everything that reads it (`meta.ts:30`, `:207`, `smoke.ts:148`) — stays exactly as it is. The
  mode-ordering question, the fourth-mode line, all of it: deferred, not owed.
- **The two workstreams are independent.** Phase 1 can be exercised against **real Oracle** without
  waiting on `derived.ts` or the alias quoting, so the `GL_BALANCES` risk that `hybrid-mode-plan.md`
  §8 calls the largest unknown in that document cannot block an Organization.

**★ Three things that are true in the code today stop being true the moment an app table has a home,
and each one is a comment or a message that would then be a lie:**

1. **`client.ts`'s doc block** — *"★ The driver is chosen HERE, once, from `config.db.mode`. Nothing
   below this line branches on the mode again, so there is exactly one place where the wrong backend
   could be selected."* True today, and exactly what hybrid's router replaces. It must be rewritten to
   describe routing, not selection.
2. **`app-schema.ts`'s "WHY ORACLE MODE IS SKIPPED" block**, its `state: 'skipped'`, and
   `requireAppSchema()`'s 503 text — *"…are stored in app-owned tables, which are SQLite-only. This
   server is pointed at Oracle, where there is no storage for them."* That message becomes false. It is
   one of the few places the app currently tells the truth about its own limitation; it must be
   re-pointed at the *new* limitation rather than deleted, because a store can still be unreachable.
3. **`env.ts`'s `allowWrites`** (*"★ `allowWrites` is hard-coded `false`, not read from an env var"*)
   plus the two readers that assume one store — `client.ts`'s `writable: config.db.allowWrites` and
   `index.ts`'s single `[api] writes ENABLED/disabled` startup line. **Writability becomes a property of
   a store, not of the process**, which is precisely hybrid's §5 rule
   (`writable = d.writes !== undefined && storeForTable(d.table) === 'turso'`). A one-line startup
   banner covering two stores with opposite policies is the kind of signal that reads as correct and
   is not.

**★ And the registry creates a THIRD hand-maintained copy of "the tables this app owns."** The first
lives in `01-app.sql` as `CREATE TABLE` statements, the second in `app-schema.ts`'s `APP_TABLES`, and
`smoke.ts:2072` already asserts those two are equal under the banner *"★ TWO HAND-MAINTAINED LISTS OF
THE SAME THING"*. `store.ts`'s `APP` class becomes the third. **It needs the same gate**, because the
failure it prevents is specific and bad: a table in `APP_TABLES` but not in the registry routes to
Oracle and *fails*, while the reverse routes an EBS table to Turso and returns **zero rows** — a wrong
answer that looks like a right one, which is the single failure hybrid's §2 says the design must not
have. Assert the three sets equal; `APP_TABLES` is already exported for exactly this kind of use.

**One thing that costs nothing, because an earlier fix pays for it now.** `env.ts`'s doc block records
that `meta.ts` once wrote `z.enum(['local', 'turso'])` by hand and **left `oracle` out** — so the
published OpenAPI document told every consumer that the mode the server supports was impossible, *"and
the smoke check asserted the same shortened list, so it would have confirmed the omission rather than
caught it."* Those two sites now read `z.enum(DB_MODES)` (`meta.ts:30`, `:207`), and `smoke.ts:148`
asserts membership against `DB_MODES`. **A fourth mode is therefore one line — not the four edits it
would have cost a year ago.** With `APP_DB_URL` settled as the mechanism (§7), Phase 0 does not spend
that line: `DB_MODES` is left exactly as it is, and `hybrid` stays available as a later convenience.

---

## Design

### 1. Identity first — there is nothing to hang a role on

The Login / role / session work is a prerequisite, and it is small because the seam is already shaped
for it.

**`app/src/data/session.ts` gains a role and an organization, and keeps its existing API.**

```ts
export type Role = 'super_admin' | 'member';

export interface SessionUser {
  name: string;
  initials: string;
  email: string;
  role: Role;
  /** Every user belongs to exactly one organization — the request exempts nobody. */
  organizationId: number;
  /** The tenant's fund, programmes and start FY, copied onto the session. */
  organization: Scope;
}

export function session(): SessionUser | null;
export function currentOwner(): string | null;   // unchanged — the audit string
export function isSuperAdmin(): boolean;
```

`currentOwner()` keeps returning a **name**, because it is written into `saved_view.created_by` and
read back by the View Builder. Changing its meaning would silently re-label every existing row.

**Bootstrap, from `.env`.** `SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` are read by the server, never
by the client. On `POST /api/auth/login`:

1. if the email matches `SUPER_ADMIN_EMAIL` **and** the password matches `SUPER_ADMIN_PASSWORD`, the
   session is `super_admin`, attached to the **default** organization;
2. otherwise the email is looked up in `app_user` and the session carries that row's role and
   organization;
3. anything else is a 401, with the same message for "no such user" and "wrong password".

Two rules worth writing into the code as comments:

- **The `.env` pair is a bootstrap, not an account.** It is gitignored, it is six digits, and it is a
  single point of failure with no lockout. The plan creates it as a *session path*, and the natural
  follow-up (not in this plan) is a hashed `app_user` row that supersedes it. Say so in `.env`'s own
  comment block rather than leaving the next reader to discover it.
- **The super admin belongs to an organization too.** The request says *"Every user in the system will
  be associated with one Organization"* and exempts nobody — and with the scope now *replacing* the old
  constant (see §5) there is no "no scope" state left to fall back to. So the super admin is an
  ordinary member of the **default** organization and sees its data like anyone else; what makes "only
  the Super Admin can set up an Organization" true is a **server-side role check**, not the absence of
  a tenant.

### 2. Data model — two tables, app-owned, in all three places the repo requires

Added to `data/sql/turso/01-app.sql`, to `APP_TABLES` in `server/src/db/app-schema.ts`, and — once
Phase 0 exists — to the **ownership registry's `APP` class** in `server/src/db/store.ts` (§7). The
first pairing is not optional: `server/src/scripts/smoke.ts:2072` asserts `01-app.sql` and
`APP_TABLES` are equal — *"★ TWO HAND-MAINTAINED LISTS OF THE SAME THING"* — and it is the second
list that decides which names `requireAppSchema()` will refuse to serve. The **third** list is the one
that decides which store a statement goes to, and it needs the same assertion for a sharper reason:
a table present in `APP_TABLES` but missing from the registry routes to Oracle and fails loudly, while
the reverse routes an EBS table to the app store and returns **zero rows** — a wrong answer that looks
like a right one.

```sql
CREATE TABLE IF NOT EXISTS organization (
  id             INTEGER PRIMARY KEY,
  slug           TEXT    NOT NULL UNIQUE,
  name           TEXT    NOT NULL,
  -- The metered singleton, matching app/src/data/scope.ts's fund field.
  fund           TEXT    NOT NULL,
  -- JSON text, not a JSON column type: SQLite has no JSON type and libSQL's
  -- JSON functions operate on TEXT anyway. '[]' rather than NULL so every
  -- reader parses unconditionally — the same reasoning as saved_view.params_json.
  programs_json  TEXT    NOT NULL DEFAULT '[]',
  -- Oracle's PERIOD_YEAR convention: the fiscal year the period ENDS in.
  -- FY2022 is 2021-07-01 .. 2022-06-30. Stored as an INTEGER year, never a date.
  start_fy       INTEGER NOT NULL,
  is_default     INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_user (
  id              INTEGER PRIMARY KEY,
  email           TEXT    NOT NULL UNIQUE,
  display_name    TEXT    NOT NULL,
  role            TEXT    NOT NULL DEFAULT 'member'
                          CHECK (role IN ('super_admin','member')),
  organization_id INTEGER REFERENCES organization(id),
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  last_seen_at    TEXT
);
```

`programs_json` rather than a child table. `saved_view.params_json` already records the JSON-as-TEXT
reason (SQLite has no JSON type; libSQL's JSON functions operate on TEXT anyway). The one this table
adds: **the array's order is meaningful.** `scope.ts` keeps the authored `['861','862','863']` order
for *display* precisely because it *"reads as a range, and `862`, `861`, `863` does not"*, while
`normalise()` sorts only for comparison and for the URL. A JSON array preserves that order for free; a
child table would need a `position` column to do the same, and a second thing to keep in step. With
the constant deleted (§5) this column becomes the **only** surviving record of the display order, so it
must not be sorted on write.

**`is_default` does three jobs, and it is worth naming all three because one flag is load-bearing in
three places.** (a) It is the tenant used **when nobody is signed in** — **settled: a signed-out
visitor still browses** — so the app stays browsable exactly as it is today rather than becoming a
login wall. (b) It is the organization the **super admin
belongs to** (§1). (c) It is the organization the **pull scripts** default to when run without
`--org` (§5). The measured default is Fund `04` / programmes `861,862,863` — the scope the extract is
already pulled with — so this plan seeds exactly that row and the first run is a no-op. The flag needs
an index, not merely a convention:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS organization_one_default
  ON organization(is_default) WHERE is_default = 1;
```

**★ `saved_view.created_by`'s comment becomes stale and must be corrected in the same edit.** It reads
*"No FK to a users table. There is no users table and no authentication yet … A FK to a table that does
not exist would be a lie the schema enforces."* That sentence is right today and wrong after this
change. Leaving it is exactly the "document that has drifted out of step with the data" failure this
repo already has a gate for.

> **✅ DONE — and the correction went further than this plan predicted.** `01-app.sql` now carries the
> rewritten comment, and it does **not** say "the table exists now, so here is the FK". It keeps
> `created_by` as TEXT **deliberately**, on the grounds this plan did not consider: the value is the
> *display name* a person is known by, which is also what the audit trail wants if the account is
> later renamed or removed — a FK would **rewrite a historical attribution** whenever a
> `display_name` changed. `app_user` owns identities; this column owns the sentence "who made this",
> frozen at the moment it was made. So the plan's premise ("no users table, therefore TEXT") was
> replaced by a better one rather than merely updated.

### 3. The Settings icon and the Settings page

**The icon goes in `.rail__brand`, which is the actual upper-left corner.** The app's chrome is a
sticky left rail plus a sticky topbar **to the right of it** — so "upper left hand corner" is
`.rail__brand` (the 28×28 `span.brand__mark` and the wordmark), not `.topbar`.

- A gear `<button className="rail__gear">` as the last child of `.rail__brand`, right-aligned inside
  it. It is a **`<button>`, not a `<Link>`**, because it must not participate in the rail's roving
  arrow-key walk (`Rail.tsx` gives every rail item `tabIndex={-1}` except the active leaf).
- **It renders only when `isSuperAdmin()`.** A settings page that refuses you is worse than no gear.
- It carries `aria-label="Settings"`, and a visible focus ring — it is the only icon-only control in a
  rail made of text.

**The page is a new leaf, `Administration › Settings`, at `/settings`,** added as the **first** leaf of
the `admin` block in `app/src/nav/menu.ts` (`built: true`) with a `SCREENS['/settings']` entry in
`App.tsx`. The two must move together — the existing comment at `menu.ts`'s `admin` block already
records the asymmetric failure: a leaf marked `built` with no screen falls through to `Pending` and
looks merely unfinished; a screen with no leaf never gets a `<Route>` at all and throws nothing.

The gear is a **shortcut** to a page that is also in the rail. That is deliberate: a route reachable
only from an icon is unreachable from a deep link, a bookmark, or a screenshot.

**The page is an accordion list, and Organizations is the first accordion.** The other accordions are
the existing `Administration` leaves that are conceptually settings (`Segments`, `Combinations`,
`Overrides`, `Extract runs`, `Users & roles`) — each may be an accordion that says what it is and links
to its leaf, or the leaf itself. **Recommendation: accordions for the settings that are *edited here*
(Organizations, Users & roles) and links for those that are their own screens** (View builder,
Extract runs), so the Settings page does not become a second navigation tree.

### 4. The Organizations accordion — the list and the form

```
┌─ ▾ Organizations                                  [+ New] ─┐
│  Wake County Public Schools        Fund 04 · 861 862       │
│                                     FY 2025 · 2,782 lines  │  ← the default
│  Athens Drive High School          Fund 01 · 220           │
│                                     FY 2026 · 0 lines      │  ← ★ warning
└────────────────────────────────────────────────────────────┘
```

**The list row carries a measurement, not just a configuration.** Each organization shows the number
of rows its own configuration actually selects — so `Fund 01 · 220` displaying **0 lines** is visible
on the list rather than discovered by a user after logging in to an empty app. This is the same rule
`ScopeSelect` follows: a scope that removes everything must say so.

**★ Settled: the register says `No rows found`.** An organization whose configuration selects nothing
renders the ordinary empty state with that string, in the register's own words — not an error, not a
warning banner, and not a blank table that is indistinguishable from a failed query. The count on the
list row above is what stops it being a surprise; the empty state is what stops it looking like a bug.
The distinction the app already draws between *"no rows"* and *"cannot answer"* (§6) holds: `No rows
found` means the query ran and matched nothing, and it is a legitimate state to save, not a
configuration error to refuse — the extract is a sample, so a scope that is empty *today* may not be
empty against live Oracle.

**The `+ New` form, field by field, with the measured constraint on each.** The Fund and Programme
controls are **settled** — the picker offers the chart of accounts' real values, so no option it offers
can select nothing:

| Field | Control | Constraint the measurement imposes |
|---|---|---|
| **Name** | text, required | Free text. A `slug` is derived from it for the URL, matching `project.slug`. |
| **Fund** | **single select** | Populated **from `GL_CODE_COMBINATIONS.SEGMENT1`**, not from the literal `01`–`04` — settled. That yields `00`, `01`, `04`, so the form must drop `00` as well as never offering `02`/`03`: `00` is the unresolved placeholder (all 7 of its rows pair with programme `000`) and is not a tenant anyone can be scoped to. Each remaining option carries its row count. |
| **Programme** | **multi-select** | **Filtered to the programmes the chart of accounts pairs with the selected Fund** — four pairs exist (`00/000`, `01/220`, `04/861`, `04/862`; see §1), and the picker offers the three that are not the `00`/`000` placeholder. Changing the Fund re-filters the list. This is the only guard that makes an unsatisfiable tenant impossible to author rather than possible to author and then sad to use. |
| **Start FY** | **text**, as asked | Accepts `2022`. Validated against the range the source actually holds (`GL_PERIODS` in the sample: **FY2022–FY2029**) and, on every keystroke, states what it removes: *"Start FY 2022 removes 0 of 2,782 rows — the earliest order date is 2025-01-02."* Text is right here: it permits a FUTURE fiscal year, which a `<select>` bounded to the data would forbid. |

Below the three fields, a **live preview of the resulting scope** in the same words the rest of the app
uses — `Fund 04 · programme 861/862/863 · from FY2025` — reusing `scopeLabel()`'s formatter so the
author reads the same sentence the user will.

### 5. The organization **replaces** the scope constant — settled

**`SCOPE` is deleted.** Not kept as a fallback, not renamed. `scope.ts` stops being the place the rule
is *written down* and becomes the place the rule is *implemented* — a library of pure functions over a
`Scope` it no longer owns.

| | Before | After |
|---|---|---|
| The rule | `export const SCOPE: Scope = { fund: '04', programs: ['861','862','863'] }` | a row in `organization` |
| The universe | `ALL_PROGRAMS = SCOPE.programs` | the active organization's programmes |
| "The default" | `ALL_IN_SCOPE = SCOPE`, and `isAuthoredScope()` compares against `SCOPE` | the organization's *full* scope — every programme it holds, none switched off |
| A missing selection | `parseScope()` falls back to `SCOPE` | falls back to the active organization's scope |

```
organization row  ──►  store.scope  ──►  every screen (unchanged)
        ▲
        └── session.organization;  the default organization when there is no session
```

The four functions that survive **unchanged** are the ones that matter: `normalise`, `sameScope`,
`inScope` and `scopeSpoken`. `inScope` stays *the one implementation of the predicate* — the doc
block's central promise, and it is unaffected by where the value came from.

Three signatures change, and each is a real consequence rather than a rename:

1. **`scopeLabel(scope)` → `scopeLabel(scope, programmeOrder)`.** It renders the programme list in
   `ALL_PROGRAMS` order *"so the label does not reorder itself as a reader toggles chips — a heading
   that changes shape under a click is a heading nobody can scan."* `ALL_PROGRAMS` is gone, so the
   order must be passed in — and it comes from the organization's `programs_json`, which is exactly why
   that column preserves author order (§2).
2. **`isAuthoredScope(scope)` → `isFullScope(scope, organization)`.** The old meaning was "the scope
   the app was authored with, and the only one that removes nothing". The new one is "every programme
   this tenant holds, none switched off" — which is the state a reader arrives in.
3. **`parseScope(fund, programs)` gains the tenant.** The comment on that function is emphatic:
   *"★ A HAND-EDITED URL MUST NOT BE ABLE TO EMPTY THE APP BY ACCIDENT."* A tenant adds a second half
   to the same rule: **a hand-edited URL must not be able to escape the tenant either.** `?programs=999`
   is not an error — it is treated as "nothing was asked for" and clamped to the organization, which is
   the existing fall-back-rather-than-fail reasoning applied one level up.

**The two things "replace" does not by itself settle, and my recommendation for each:**

- **May a member *narrow* within their tenant?** Recommended: **yes.** The organization is the ceiling;
  a member may switch programmes off inside it, never on beyond it. The fund becomes a bare label for
  exactly the reason `ScopeSelect` already gives for `04` — *"A dropdown containing one option would
  look like a control and behave like a lie."* This leaves `ScopeSelect` built, verified and useful
  while making it structurally unable to widen the tenant. The alternative — the control disappears for
  members — is a smaller diff and a worse app: the chips are the only place the app says out loud what a
  programme costs, counts included.
- **Which organization does the super admin see?** Recommended: **the default one** (§1). The request
  exempts nobody, and "no scope at all" would be a third meaning of scope in an app that currently has
  one. The super admin's extra power is the *Settings page*, not an unscoped view of the data.

**The pull script becomes a per-tenant pull.** `pull-invoices-extract.mjs:200`'s
`const SCOPE = { fund: '04', programs: ['861','862','863'] }` — whose own comment is *"★ THE SCOPE MUST
BE ABLE TO SAY WHAT IT COST"* — becomes a read of an organization row chosen by a new `--org <slug>`
argument, defaulting to `is_default`. This is not cosmetic: **two tenants with different scopes need two
extracts**, and an argument is what makes that possible without editing a constant.

**And the reconciliation in `invoices.ts` changes rank.** Today the register compares the extract's
declared `.scope` block against what the UI is asking for, and reports a disagreement as a curiosity.
With a tenant the same comparison is a **tenancy check** — *this extract was pulled for organization A
and the session belongs to organization B* — and it has to be loud, because the alternative is a member
of B reading A's rows under a heading that says otherwise. That is precisely the failure `scope.ts`'s
doc block was written to prevent: *"five literals become five chances for the app to disagree with
itself — a page showing 861 rows under a heading that says 862."*

**★ Add a `scope` + `window` envelope to every extract, not just invoices.** Today only
`invoices.json` declares them; `checks.ts` derives its window from observed min/max, and the PO extract
declares nothing at all. With an organization in play the app can no longer *assume* its scope — it has
to be able to **compare the organization's configuration against the extract it is served from and say
so** rather than render an empty table that looks like no data. That comparison is only possible if the
extract states what it was pulled as.

### 6. Start FY — a window on the pull, and an honest sentence per page

**★ Settled: Start FY stays free text** (`text like "2022"`, exactly as the request words it), and the
form prints what each value removes as it is typed. A bounded list of the fiscal years the *current
extract* happens to hold would be a control that lies the moment the extract is re-pulled — and,
measured (§3), every value from `2022` through `2025` removes exactly nothing, so a "valid" list would
offer four options with identical effect and hide that fact behind a tidy dropdown. Free text plus the
running sentence states it instead.

The Start FY is consumed in three places, in this order:

1. **The pull.** `WHERE PERIOD_YEAR = (SELECT MAX(PERIOD_YEAR) …)` becomes
   `WHERE PERIOD_YEAR BETWEEN :startFy AND (SELECT MAX(PERIOD_YEAR) …)` — i.e. **from the organization's
   Start FY to the latest period**, which is literally "starting with the Start FY to present".
   The scripts' own header has the size trade written down; that estimate must be revisited for a
   four-year window before anyone runs it against production.
2. **The envelope.** The pull writes `window: { from, to, fiscalYear }` **and** `scope`, so the app can
   verify rather than assume.
3. **The page.** Every register states the floor it is under, in its own words, and — where it can —
   what the floor removed. Two of the three registers **cannot** answer, and must say so:

| Register | Can it report what Start FY removed? |
|---|---|
| `/spend/invoices` | **Yes** — declares its window; already classifies every row into `in_scope` / `out_of_scope` / `unanswerable` |
| `/`, `/projects`, `/coa/combinations` (PO) | **Only if the envelope is added** (§5). Today: observed dates, so a scope note only |
| `/spend/payments` (checks) | **Window is derived, not declared**, and it carries no account column — scope note only |

A page that cannot answer says *why it cannot* — the pattern `/spend/payments` and `/activity`
already follow for the account scope.

### 7. Phasing

The request is four independent pieces of work wearing one coat. Phasing it lets the visible half land
early and keeps the risky half separable. **Phase 0 is not part of the request** — it is the
prerequisite that makes the request's configuration storable wherever the ledger lives, and it is the
only phase whose contents were decided by a decision about a *different* plan (§7).

| Phase | Deliverable | Depends on | Gives the user |
|---|---|---|---|
| **0** | **The app-owned store** — hybrid's steps 4, 6 and 8, **without** the `hybrid` mode literal: `store.ts`'s registry and `storeForTable()`, the composite driver, dual resolution in `client.ts`, `APP_DB_URL` in `env.ts`, write-gating derived from the registry, and the three-way list gate (`01-app.sql` ≡ `APP_TABLES` ≡ the registry's `APP` class) | nothing — the Oracle driver already exists | App-owned tables have a home **in every mode**, including `oracle` |
| **1** | `organization` + `app_user` tables; login; `super_admin` from `.env`; the gear; `/settings` with the Organizations accordion, list and `+ New` form | **Phase 0** | **Exactly the screen the request describes.** Organizations can be created and listed, and stay available when the ledger is Oracle |
| **2** | **`SCOPE` is deleted** and the organization drives `store.scope`; `ScopeSelect` narrows within the tenant and cannot widen past it; `parseScope` clamps a hand-edited URL to the tenant; the pull script reads the same row via `--org`; a `scope` envelope on every extract; the extract-vs-tenant comparison becomes a loud tenancy check | Phase 1 | **"when they log in the data will be scoped from the Organization configuration"** |
| **3** | Start FY becomes the window on the pull; `window` in every envelope; each page states its floor and what it removed | Phase 1; a re-pull | **"starting with the Start FY to present"** |
| **4** | Ledger data served from Oracle — the SPA reads `/api/extract/current` instead of `public/oracle/*.json`, and the EBS endpoints are ported: `derived.ts`, the `IFNULL`→`COALESCE` view bodies, the ~60 quoted aliases, and `GL_BALANCES` measured **before** any of it | Phase 0; `hybrid-mode-plan.md` §9 steps 1, 3, 7 | **"the data will come directly from Oracle"** |

**Phase 0 is the one genuinely new prerequisite, and it is smaller than it reads** — the Oracle driver,
the type declarations and the `LIMIT` rewrites are already built. It is the only part of hybrid an
Organization needs. **Phase 1 is the whole request as a screen.** Phase 4 now means the **EBS half** of
hybrid rather than the driver, which is the half carrying the `GL_BALANCES` risk that plan's own §8
calls its largest unknown.

### 8. Decisions

**Settled:**

| # | Question | Answer | What it costs |
|---|---|---|---|
| 1 | Does an organization *replace* `scope.ts`'s constant, or *seed* it? | **Replace.** | `SCOPE`, `ALL_PROGRAMS`, `ALL_IN_SCOPE`, and the hardcoded comparison inside `isAuthoredScope` all go; three signatures change (§5) |
| 2 | Where do organization records live, given `DB_MODE=oracle` skips app tables entirely? | **The app-owned store comes forward** — its own connection, not a mode. | A new Phase 0 — the app-owned slice of hybrid (registry, composite driver, `APP_DB_URL`, write gating) — plus three doc blocks and two messages that stop being true (§7) |
| 3 | Fund `01`–`04` literally, or the chart of accounts' real values? | **The real values.** | Any option offering `02` or `03`; `00` is dropped from the picker as the unresolved placeholder |
| 4 | What does a member see while their organization selects 0 rows? | **`No rows found`** — the register's ordinary empty state. | One string per register; the organization may still be saved, because a scope that is empty against the *sample* may not be empty against live Oracle (§4) |
| 5 | Start FY as free text, or bounded to the fiscal years the data holds? | **Free text** (`text like "2022"`). | The form prints what each value removes as it is typed — necessary, because measured (§3) every value from `2022` to `2025` removes exactly nothing |
| 6 | Does the default organization stay browsable to a signed-out visitor? | **Yes — signed-out visitors still browse it.** | The app's behaviour is unchanged for anyone without a session, so Phase 1 breaks no existing page, screenshot or smoke check; the alternative is a login wall on every register |
| 7 | Does the app store hang off the ledger mode, or stand on its own? | **On its own — `APP_DB_URL`.** | App-owned tables get a connection independent of `DB_MODE`, so Organizations work under `DB_MODE=oracle` **today**; `DB_MODES` is untouched and `hybrid` becomes an optional later convenience rather than a prerequisite (§7) |

Two sub-questions that "replace" raised are answered with a recommendation in §5 rather than left
open, since both are one-line differences and neither changes the data model: **a member may narrow
within their tenant but never widen past it** (so `ScopeSelect` survives as a ceiling-bounded control),
and **the super admin sees the default organization** (so there is no tenantless code path).

**Nothing remains open.** Phase 0 is the only prerequisite, it is named and sized in §7, and it does
not depend on a question that is still being decided.

---

## What this plan deliberately does **not** do

- **It does not build the Oracle data path.** That is Phase 4 — and the part of it that is *missing* is
  the **EBS port**, not the driver: `oracledb@^7.0.1` is installed, `resolveDb()` has its `'oracle'`
  branch, and `server/src/db/oracle.ts` works. Phase 4 is still larger than this entire plan. If it is
  the *point* of the request, say so and it becomes its own document.
- **It does not re-pull or widen the extracts.** Phase 3 changes the pull scripts; nothing here runs
  them. A four-year window is ~4× the current payload and must be sized before it is run.
- **It does not add a real password store.** `SUPER_ADMIN_PASSWORD` from `.env` is a bootstrap. Hashing
  and a rotating credential is a stated follow-up, not a silent omission.
- **It does not invent multi-tenant data isolation.** There is one extract; therefore one tenant's
  worth of rows at a time. An organization's scope *selects from* the extract, it does not partition a
  shared one. Two organizations that need different rows need two extracts — which is what §5's scope
  envelope is for.
- **It does not change `currentOwner()`.** It stays a name, because `saved_view.created_by` is a name.
- **It does not keep `SCOPE` as a fallback constant.** "Replace" was read literally: `SCOPE`,
  `ALL_PROGRAMS`, `ALL_IN_SCOPE` and the hardcoded comparison inside `isAuthoredScope` all go. The
  behaviour you get with nobody signed in is preserved by the **default organization row**, not by a
  constant left behind in the module. If you meant *"the organization is authoritative but keep a
  constant as the last resort"*, that is a one-line difference in §5 — say so.
- **It does not touch the existing `Users & roles` leaf's `to`** (`/admin/users`). It is referenced by
  `menu.ts` and by `saved_view`'s comment; the Settings accordion points at it.

---

## Verification

1. `npm run typecheck` and `npm run build` clean in `app/`; `cd server; npm run smoke` still green —
   **in particular the `APP_TABLES` ↔ `01-app.sql` equality gate at `smoke.ts:2072`**, which is the
   check that fails if the two lists are updated separately. Phase 0 adds a **third** list (the
   registry's `APP` class); gate 4 below is what keeps all three in step.
2. **The constant is gone, asserted by grep rather than by memory.** `grep -n "export const SCOPE\|ALL_PROGRAMS =\|ALL_IN_SCOPE" app/src/**` returns **nothing**, and
   `grep -rn "fund: '04'" app/src server` returns nothing but the seed row's own literal. A negative
   assertion like this needs a message saying what it means if it starts passing again: *a constant has
   been reintroduced and the organization is no longer the authority for the scope.*
3. `node scripts/verify-turso-sample.mjs` still **21/21**, and `node scripts/turso-run.mjs --quiet`
   still **56/56, 0 failed** — the new tables live in `01-app.sql`, which those gates do not count, so
   any change in their totals means something was edited that should not have been.
4. **The app store, asserted where it can actually be wrong.** In every mode, from every mode:
   - `/api/health` reports **each** store separately, and *"Oracle up, app store down"* is
     distinguishable from *"app store up, Oracle down"* — one flag for two stores is the report that
     makes an operator troubleshoot the wrong half;
   - an app-owned table is readable and writable under `DB_MODE=oracle`, and an EBS table is still
     read-only there (the `SELECT`-only grant has not been worked around by accident);
   - an **unregistered** table name **throws and names the name** — the registry's hard-error default,
     with a deliberate control that a plausible-looking typo is not silently routed anywhere;
   - the three lists agree: `01-app.sql`'s `CREATE TABLE` names ≡ `APP_TABLES` ≡ the registry's `APP`
     class. A pass here means *an EBS table cannot be routed to the app store and returned as empty*,
     which is the one failure that looks like a correct answer;
   - **under `DB_MODE=oracle` with `APP_DB_URL` set** — the settled configuration, not a `hybrid` mode
     — an app-owned write path is **201** while every EBS write path is refused by the same registry
     lookup. The *pair* is the evidence: the 201 alone would pass with routing removed, and the refusal
     alone would pass with the app store missing. When `hybrid` lands later,
     `hybrid-mode-plan.md` §10's 404/201 pair is added on top and must agree with this one.
5. Browser, measured not eyeballed:
   - the gear appears in `.rail__brand` **only** when the session is `super_admin`, and does not take a
     tab stop in the rail's roving walk (assert `tabIndex === -1` is *not* on it, and that arrow-key
     walking the rail never lands on it);
   - `Administration › Settings` is in the rail and `/settings` deep-links (open the URL directly, not
     by clicking);
   - the Organizations accordion lists every organization with **its row count**, and `+ New` opens the
     form;
   - **Fund options are `01` and `04` — not `00` (the placeholder), `02` or `03`** — and each shows a
     count;
   - **choosing Fund `01` re-filters the programme list to `220`**, and Fund `04` to `861`/`862` —
     the coupling, asserted rather than assumed;
   - Start FY `2022` prints *"removes 0 of 2,782 rows"* and Start FY `2026` prints *"removes 1,544"* —
     the two measured anchors;
   - the same two anchors hold for **free text typed into the field**, including a value no picker
     would ever have offered (`2030`): it saves, and the page says what it removes;
   - an organization whose configuration selects nothing shows **`No rows found`** — and **not** an
     error, a warning, or a blank table. Assert on a real 0-row tenant (`Fund 01 · 220`), because that
     is the only fixture that distinguishes *"the query matched nothing"* from *"the query failed"*;
   - a 401 for a wrong password and for an unknown email returns the **same** message;
   - a signed-in member **cannot reach** `/settings` even by typing the URL (the guard is server-side,
     and the client must not be the only check);
   - **the tenant is a ceiling, asserted three ways**: a member's chips list only their organization's
     programmes; `?programs=999` typed into the URL is clamped rather than honoured; and a session for
     organization A served an extract pulled for organization B reports the **mismatch** instead of
     rendering A's rows under B's heading;
     the same assertions as a signed-in member, run **after logging out** — "signed-out still
     browses" is the one decision here that can silently regress into a login wall, and it regresses
     quietly, so the assertion has to be made from a cleared session rather than inferred;
   - zero console errors.
6. Re-probe the numbers, do not recall them. Every figure in §1–§5 is reproducible from two files
   already in the repo — `app/public/oracle/output.json` (2,782 rows, for the fiscal-year buckets) and
   `data/sql/turso/sample.db` via `GL_CODE_COMBINATIONS` (520 rows, for the fund/programme pairs) —
   with a throwaway script that is **run from a file and then deleted**, never `npx tsx -e`, because
   the shell eats backticks in template-literal SQL. The measured values are recorded in repo memory
   (`/memories/repo/oracle-data-v1.md`, *"The fiscal-year convention, the real fund/program values,
   and where scope already lives"*) so a reader does not need the script to know what the numbers are.
