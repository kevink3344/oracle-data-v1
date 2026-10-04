# Integrations — a register of outbound endpoints, and what "Active" is allowed to mean

## What was asked

> I need a new feature for "Integrations". This should be a page under Administration. Each
> Integration has a Title, Description, Integration Url (API/Webhook), and Active/Inactive.
> Please provide a plan at /docs/plans.

**This is a plan, not an implementation.** Nothing has been built. Every question the request
leaves open is answered in [§8 Decisions](#8-decisions), and the four that shape the build are:

1. **The URL is stored, never called.** This app has no outbound HTTP client and this feature does
   not add one. "Active" is a *declaration about intent*, not a verified fact — and the screen must
   say so, because a green tick beside an endpoint nobody has ever reached is the single most
   misleading thing this page could render.
2. **The URL is validated as a URL, and stored as text.** No `fetch`, no DNS, no reachability
   check on save. A save that hangs on a dead host is worse than a save that accepts a typo.
3. **`Active` is a boolean with a real consequence**, and the consequence is *inbound*: an
   inactive integration is one this deployment's own API will refuse to act on. That gives the
   flag a meaning that can be tested without an outbound call.
4. **The table is app-owned**, so it needs **four edits in one change** or the smoke suite fails
   (§5.4). This is the most common way a new table breaks this repo.

---

## The answer in one line

**An Integration is a named, described, URL-bearing row with an on/off switch — a register, not a
client.** The screen is a list plus a slide-in editor, which is `ReadCaps.tsx`'s shape exactly; the
API is a four-route CRUD domain, which is `readCaps.ts`'s shape exactly; the table is one more
app-owned table, which means the same four-file edit every app table needs. The one genuinely new
decision is **what "Active" means**, and the honest answer is that this feature is a *record of
intent* until something calls these URLs — so the plan is explicit about that rather than
dressing a stored string up as a working connection.

---

## 1. What this feature is, and what it is not

### It is a register

Four fields, one row per integration:

| Field | Type | Required | Notes |
|---|---|---|---|
| `title` | text | yes | What a person calls it. Unique — see §3.1. |
| `description` | text | yes | What it is for. Multi-line. |
| `url` | text | yes | The API or webhook endpoint. Validated as a URL, never called. |
| `active` | flag | yes | On/off. Defaults to **off** — see §3.2. |

Plus the standard bookkeeping every app table carries: `id`, `created_at`, `updated_at`, and
`set_by` (the account that last changed it), because "who turned this on" is the question an
administrator asks first when something is off that should be on.

### It is not a client, and the screen must not pretend otherwise

This is the load-bearing decision, so it is stated once and referenced from everywhere else.

**Nothing in this app makes an outbound HTTP request.** There is no `fetch` on the server outside
the Oracle pull scripts, no HTTP client dependency, and no queue, retry or delivery machinery. A
plan that stored a URL and then showed a status light would be inventing a fact: the light would
mean "a string is present", which is not what a reader will take it to mean.

So the page renders the URL as **text**, not as a status. What it *can* honestly show:

- Whether the string is a well-formed `https://` URL (a fact about the string — §3.3).
- Whether the row is active (a fact about the row).
- Who last changed it and when (a fact about the record).

What it must **not** show: "connected", "reachable", "healthy", "last seen", or any green tick.
§4.3 makes this a rule with a reason, and §8 D2 records the alternative that was rejected.

---

## 2. Where it lives

### 2.1 The nav leaf — `app/src/nav/menu.ts`

A new `MenuLeaf` in the existing `admin` block, appended **after the three built leaves** (Settings,
View builder, Read caps) and **before the five `built: false` placeholders**, so the rail keeps
reading as "things that work, then things that do not yet":

```ts
{
  label: 'Integrations',
  icon: 'outbound',
  to: '/admin/integrations',
  reads: 'app-side',
  api: '/api/integrations',
  built: true,
  note:
    'The endpoints this deployment intends to call — a title, what it is for, and a URL. ' +
    'Stored and shown; nothing here is called yet, so Active records an intention rather than ' +
    'a working connection, and the page says so rather than implying a status it cannot know.',
  plan: 'docs/plans/integrations.md',
},
```

**`icon` is not optional, and this plan's first draft of the literal above omitted it.** `MenuLeaf`
declares `icon: MenuIcon` (not `icon?:`), so the literal as originally written does not compile.
`'outbound'` is the mark that already means *away from here* — `RailIcon.tsx` draws it with the
comment "Out of the register and away: the direction money takes when it leaves" — which is what an
outbound endpoint is. It is shared with the not-yet-built `Vendor spend` leaf in the Vendors block;
reuse is harmless because every `RailIcon` renders `aria-hidden="true"` and the label carries the
name, and inventing a 46th drawing for one leaf is the larger change for the smaller gain.

**`built: true` and the `SCREENS` entry are one edit.** The block's own ★ comment is explicit: a
leaf marked built with no screen falls through to `Pending` (quiet — reads as "not written yet"),
and a screen with no leaf never gets a `<Route>` at all (also quiet). Neither throws.

### 2.2 The route — `app/src/App.tsx`

One static import beside the others and one `SCREENS` entry:

```tsx
import Integrations from './routes/Integrations';
// …
'/admin/integrations': <Integrations />,
```

**There is no lazy loading in this app** — every screen is a static top-level import. Following
that is not laziness; introducing `React.lazy` for one page would make this screen behave
differently from the other seventeen for no benefit.

### 2.3 No route guard

There is no per-route super-admin guard anywhere in this app, and this page does not add the first
one. The `Gate` checks *signed in*, and super-admin is enforced **server-side** (`requireSuperAdmin`
→ 403). The page renders for a member and tells them the truth when the API refuses — which is the
same behaviour as `/settings` and `/admin/read-caps`.

---

## 3. The data

### 3.1 `title` is unique, and that is a decision with a cost

A register whose two rows are both called "Payroll webhook" is a register you cannot refer to. So
`title` carries a `UNIQUE` constraint.

**The cost, stated plainly:** a unique constraint on a *human* name means a rename can collide, and
the failure arrives as a database error (`ER_DUP_ENTRY` on MySQL, `2601`/`2627` on SQL Server)
rather than a sentence. §4.4 handles this by catching the constraint violation and re-raising it as
`409 Conflict` with the server's own wording — the same treatment `organization.slug` already gets.

**Case sensitivity differs between the dialects, and this is the `GL_LOOKUPS` lesson repeating.**
MySQL's `utf8mb4_0900_ai_ci` and SQL Server's `SQL_Latin1_General_CP1_CI_AS` both treat
`Payroll` and `payroll` as the same title, so both reject the pair. SQLite's default `BINARY`
collation treats them as different. **This is a real behavioural difference between the arms**, and
the honest resolution is to make it explicit: the check in the handler compares
`LOWER(title)` against `LOWER(?)`, so all three arms agree on "case-insensitive", and the unique
index is a backstop rather than the rule. §8 D3 records why this is preferred over a
dialect-specific collation clause.

### 3.2 `active` defaults to **off**

A new integration is created inactive. Two reasons, and the second is the real one:

- An integration that has never been reviewed should not be live by default.
- **`active` is a gate, and a gate that opens by default is not a gate.** If the flag defaults to
  on, then every row is on the moment it is created and the flag records nothing — it becomes a
  field you have to remember to clear rather than one you deliberately set.

### 3.3 The URL is validated as a URL, and only as a URL

Accepted: a string that parses as an absolute URL with scheme `https` or `http`.

Rejected, with the server's own sentence:

| Input | Why |
|---|---|
| `not a url` | Does not parse. |
| `ftp://host/path` | Scheme is not `http`/`https`. |
| `/api/webhook` | Relative — this is an *outbound* endpoint, so a relative URL is meaningless. |
| `https://` | No host. |
| `javascript:alert(1)` | Scheme rejected, and this is the one that matters — see §4.5. |

**What is deliberately NOT validated:** reachability, DNS, TLS, whether the path exists, whether the
host responds. Every one of those requires an outbound request, and §1 rules that out. A validator
that "checks the URL works" would either block a save on a transient network fault or be a lie.

### 3.4 The table, in all three dialects

Follows the `organization` pattern exactly: `INT` identity primary key, timestamps as
`TEXT`/`NVARCHAR(30)` in `YYYY-MM-DD HH:MM:SS`, a `flag` column as `INT` with a `CHECK`.

**`data/sql/turso/01-app.sql`**

```sql
CREATE TABLE IF NOT EXISTS integration (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  title       TEXT    NOT NULL UNIQUE,
  description TEXT    NOT NULL,
  url         TEXT    NOT NULL,
  active      INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  set_by      TEXT    NOT NULL DEFAULT '',
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
```

**`data/sql/sqlserver/01-app.sql`**

```sql
IF OBJECT_ID(N'dbo.integration', N'U') IS NULL
CREATE TABLE dbo.integration (
  id          INT IDENTITY(1,1) NOT NULL PRIMARY KEY,
  title       NVARCHAR(200) NOT NULL UNIQUE,
  description NVARCHAR(1000) NOT NULL,
  url         NVARCHAR(2000) NOT NULL,
  active      INT NOT NULL DEFAULT (0),
  set_by      NVARCHAR(400) NOT NULL DEFAULT (N''),
  created_at  NVARCHAR(30) NOT NULL DEFAULT (CONVERT(varchar(19), GETUTCDATE(), 126)),
  updated_at  NVARCHAR(30) NOT NULL DEFAULT (CONVERT(varchar(19), GETUTCDATE(), 126))
);
```

**`data/sql/mysql/01-app.sql`**

```sql
CREATE TABLE IF NOT EXISTS integration (
  id          INT NOT NULL AUTO_INCREMENT,
  title       VARCHAR(200) NOT NULL,
  description VARCHAR(1000) NOT NULL,
  url         VARCHAR(2000) NOT NULL,
  active      TINYINT(1) NOT NULL DEFAULT 0,
  set_by      VARCHAR(400) NOT NULL DEFAULT '',
  created_at  VARCHAR(30) NOT NULL DEFAULT (UTC_TIMESTAMP()),
  updated_at  VARCHAR(30) NOT NULL DEFAULT (UTC_TIMESTAMP()),
  PRIMARY KEY (id),
  UNIQUE KEY uq_integration_title (title)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
```

**Three dialect notes, each already learned the hard way in this repo:**

- **MySQL declares the unique key inside `CREATE TABLE`.** MySQL has no
  `CREATE UNIQUE INDEX IF NOT EXISTS`, so a bare `CREATE UNIQUE INDEX` fails with error 1061 on the
  second boot. Folding it into the table definition is the same fix `01-app.sql` already uses.
- **`url` is `VARCHAR(2000)`, not `TEXT`.** MySQL cannot index a `TEXT` column without a prefix
  length, and SQL Server cannot put a `UNIQUE` constraint on `NVARCHAR(MAX)`. 2000 is under
  MySQL's 3072-byte index limit at `utf8mb4` (2000 × 4 = 8000 bytes — so `url` is **not** indexed;
  only `title` is). The width is chosen for the data, and the index is on `title` alone.
- **`description` is `NVARCHAR(1000)`/`VARCHAR(1000)`, not `MAX`/`TEXT`.** A description is a
  sentence or two. `MAX` on SQL Server would make the row off-row for no gain, and MySQL's `TEXT`
  cannot carry a `DEFAULT`.

### 3.5 The four edits that must move together

`APP_TABLES` is a **second copy** of the table list, and `ROUTING_APP_TABLES` is a **third**. The
smoke suite asserts all three agree (§5.4), so adding a table is one change across four files:

1. `data/sql/turso/01-app.sql` — `CREATE TABLE integration`
2. `data/sql/sqlserver/01-app.sql` — `CREATE TABLE dbo.integration`
3. `data/sql/mysql/01-app.sql` — `CREATE TABLE integration`
4. `server/src/db/app-schema.ts` — add `'integration'` to `APP_TABLES`
5. `server/src/db/store.ts` — add `'integration'` to `ROUTING_APP_TABLES`

**Missing 4 or 5 fails the smoke suite by name**, which is the point of the gate: it converts a
silent routing bug (writes going to the ledger) into a named assertion failure.

---

## 4. The API

### 4.1 Four routes, `registerIntegrations(api)` in `server/src/routes/integrations.ts`

Registered from `apiRouter()` in `server/src/routes/index.ts` beside `registerReadCaps(api)`. This
is a **tables** domain, so it takes the `registerXxx(api)` form rather than the `xxxRouter()` form.

| Method | Path | operationId | Guard | Purpose |
|---|---|---|---|---|
| `GET` | `/api/integrations` | `integrationsList` | `requireActor` | Every row, newest first, plus counts. |
| `GET` | `/api/integrations/{id}` | `integrationGet` | `requireActor` | One row. |
| `POST` | `/api/integrations` | `integrationCreate` | `requireSuperAdmin` | Create. Defaults `active: false`. |
| `PUT` | `/api/integrations/{id}` | `integrationUpdate` | `requireSuperAdmin` | Edit any field, including `active`. |
| `DELETE` | `/api/integrations/{id}` | `integrationDelete` | `requireSuperAdmin` | Remove. |

**Reads are open to any signed-in account; writes are super-admin only.** That split is deliberate
and matches `/settings`: a member may *see* what the deployment talks to — it is not a secret, and
hiding it would make a member unable to answer "is our payroll webhook on?" — but only a super
admin may change it. §8 D4 records why reads are not also gated.

### 4.2 The list response

```ts
const IntegrationSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  description: z.string(),
  url: z.string(),
  /** ★ THE STRING IS VALID AND WELL-FORMED — NOT THAT THE ENDPOINT ANSWERS. */
  urlWellFormed: z.boolean(),
  active: z.boolean(),
  setBy: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).openapi('Integration');

const IntegrationListSchema = z.object({
  items: z.array(IntegrationSchema),
  counts: z.object({ total: z.number().int(), active: z.number().int() }),
}).openapi('IntegrationList');
```

**`urlWellFormed` is computed on the server, not the client.** One implementation, one answer — and
it is the same function the write path validates with, so the badge and the save can never
disagree. A client-side re-implementation would drift the first time the rule changed.

### 4.3 Why there is no `status` field

`urlWellFormed` is a fact about a string. A `status` field would be a claim about the world, and
this app cannot know it. §1 rules out the outbound call that would make it knowable, so the field
is not merely unimplemented — **it is unimplementable within this feature's scope**, and adding a
placeholder now would invite someone to fill it with something untrue later.

The page's own copy carries this: the panel's URL field hint reads *"Stored and shown. This app
does not call it — Active records an intention, not a working connection."*

### 4.4 Duplicate title → `409`, with the server's sentence

The insert is wrapped so a unique-constraint violation becomes a named conflict rather than a 500:

```ts
try {
  await execute(insertSql, binds);
} catch (e) {
  if (isUniqueViolation(e)) {
    throw AppError.conflict(
      `An integration called "${title}" already exists. Titles identify a row here, so two ` +
        'integrations cannot share one — rename this one, or edit the existing row.',
      { title },
    );
  }
  throw e;
}
```

`isUniqueViolation` matches the three drivers' codes: MySQL `ER_DUP_ENTRY` (1062), SQL Server
`2601`/`2627`, SQLite `SQLITE_CONSTRAINT_UNIQUE`. **It lives in `server/src/db/`** beside the other
dialect-aware helpers, because the codes are a dialect fact and the route should not know them.

The pre-check is `SELECT … WHERE LOWER(title) = LOWER(?)` so the common case gets a clean 409
without touching the constraint; the catch is the backstop for the race the pre-check cannot close.

### 4.5 The URL check, and why `javascript:` matters

```ts
function checkUrl(raw: string): { ok: true; value: string } | { ok: false; problem: string } {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, problem: 'The URL is required.' };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, problem: `"${trimmed}" is not a URL. Include the scheme, e.g. https://host/path.` };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, problem: `"${parsed.protocol}" is not a scheme this app stores. Use https (preferred) or http.` };
  }
  if (parsed.host === '') {
    return { ok: false, problem: 'The URL has no host.' };
  }
  return { ok: true, value: trimmed };
}
```

**The scheme allowlist is the security control, not a nicety.** A stored `javascript:` or `data:`
URL is a stored-XSS payload the moment anything renders it as a link. Today nothing renders it as
a link — §4.6 — but the allowlist means the row cannot become dangerous if that changes. This is
the same reasoning `ident()` uses for identifiers: validate at the boundary, so a later consumer
cannot be the first thing to notice.

**`https` is preferred but `http` is allowed**, because an internal webhook on a private network is
a real and common case, and refusing it would push people to store a broken `https` URL instead.

### 4.6 The URL is rendered as text, not as a link

The list shows the URL in a `<code>` element, truncated with the full value in `title` and shown
in full in the panel. **It is not an `<a href>`.**

Two reasons: a link invites a click that goes somewhere the reader did not intend, and an `<a>`
whose `href` came from a database is the exact shape of a stored-XSS bug. Text is honest and safe.
If a future change wants a clickable link, it must re-validate the scheme at render time — and
§4.5's allowlist is what makes that a small change rather than a dangerous one.

---

## 5. The screen

### 5.1 Shape: `ReadCaps.tsx`, because it is the same problem

A list of rows, a slide-in editor, save/delete. That is `ReadCaps.tsx` exactly, so the plan reuses
its structure rather than inventing one:

- **Page head** — `.page-head`, title, a one-line description, and the counts. Of the two screens
  this head is shared with, `ReadCaps.tsx` has no description line, so the one-liner here is a
  `.page-head__sub` (§5.1 asks for it; the extension is this screen's, not a reused rule).
- **Panel** — `.section.panel` containing a `.table-wrap > table.data`.
- **Editor** — a `role="dialog" aria-modal="true"` drawer (`.drawer`), with focus hand-back, scroll
  lock, Escape-to-close and Tab trapping, and the shared `ResizeGrip` with its width persisted in
  `localStorage` under `integrations-panel-w`.

### 5.2 The list

| Column | Content |
|---|---|
| Title | The name, as the row header. It **wraps** rather than truncating — it is what names the row. |
| URL | `<code>`, truncated, full value in `title`. Not a link (§4.6). It takes whatever width the other two columns leave. |
| Active | A **word** — `Active` / `Inactive` — not a coloured dot. |
| (actions) | `Edit ›` button, `aria-haspopup="dialog"`. |

**Description and Set by are panel fields, not columns.** Both were columns in the first build, and
the register had to be measured in a browser to see how wrong that was: six columns came to 1086px
inside a 639px panel, so the table scrolled sideways *and* the Title column — the only one allowed
to wrap, and therefore with no minimum width — was squeezed to 55px and every row grew to 92px
tall. The editor holds both values in full, and the panel's eyebrow states the provenance the
Set by column used to carry, so dropping them loses nothing a reader needs from the list.

**The table is `table-layout: fixed`.** Under `auto` a `max-width` on a cell does not cap what the
column asks for, so the prose columns took all the width they wanted and the title took none.
Fixed layout gives Title 30%, pins Active (96px) and Actions (98px) to the width their fixed
content needs, and lets URL absorb the remainder — which makes URL the only column that moves when
the window does, and means a narrower window can never clip the `Edit ›` button.

**Active is a word, not a dot.** A coloured dot is a status indicator, and §1 says this page must
not render status. `Active`/`Inactive` reads as the value of a field, which is what it is.

**Filter before any cap, never after** — the rule `ReadCaps.tsx` records. The filter matches title,
description and URL, case-insensitively, and the empty state names the term:
`No integration matches "{filter}".`

### 5.3 The editor

| Field | Control | Validation |
|---|---|---|
| Title | `.input` | Required, ≤200 chars. |
| Description | `<textarea>` | Required, ≤1000 chars. |
| URL | `.input` | Required, scheme allowlist (§4.5). |
| Active | A checkbox or a two-state toggle | — |

**Save is disabled when nothing changed**, comparing against the *seeded* draft — the same
`differs()` pattern `ReadCapPanel` uses. A save that writes an identical row is a write that
touches `updated_at` and `set_by` for no reason, which corrupts the only audit trail this table has.

**The URL field carries the honesty hint inline** (§4.3), because that is where a reader forms the
belief the page must not create. It uses `.field__hint` — **not `.field__note`, which is not a rule
in any stylesheet.** `readcaps.css:143` mentions `.field__note` inside a prose comment and
`ReadCaps.tsx` renders it at two field sites, so it looks real; nothing styles it. The rule that
does exist is `.field__hint` (`newproject.css:94`).

### 5.4 States

- **Loading** — `list === null` renders nothing below the head, as `ReadCaps.tsx` does.
- **Error** — `.notice.notice--err` with `role="alert"` and a **Try again** button that bumps a
  `reloadKey`.
- **Empty** — the table renders one row: `No integrations yet. Add the first one.`
- **Success** — `.notice.notice--ok` with `role="status"`, which clears on the next edit.

No modal library, no toast library — inline notices only, matching every other admin page.

### 5.5 The data module — `app/src/data/integrations.ts`

Follows `readCaps.ts`: a module-private `request<T>` that attaches the `x-app-session` header from
`localStorage['projects-session-token']`, parses the error envelope, and throws an
`IntegrationError` carrying `{ status, code, details }` so the UI can render the server's own
sentence. Exports `loadIntegrations`, `createIntegration`, `updateIntegration`, `deleteIntegration`.

**There is no shared fetch helper in this app** and this plan does not add one — each `data/*.ts`
module carries its own, and unifying them is a separate change with its own risk.

---

## 6. What this feature deliberately does not do

Each of these is a real thing a reader might expect, and each is out of scope **for a stated
reason** rather than by omission:

| Not doing | Why |
|---|---|
| Calling the URL | §1. No outbound HTTP client exists; this feature does not add one. |
| Reachability / health check | Requires the call above. A stored string is not a status. |
| Auth headers, tokens, secrets | **A credential in this table would be a credential in a table this app renders.** If integrations ever need auth, the secret belongs in `.env` and the row holds a *name* for it. |
| Retry, queue, delivery log | There is nothing to retry — nothing is sent. |
| Per-integration events (`on invoice created`) | That is an event system, not a register, and it needs the outbound client first. |
| Testing a payload | Same. |
| A `last_used_at` column | It would never be written, and an always-empty column invites a reader to think it is broken. |

---

## 7. Build order

Each step is independently verifiable, and the order is chosen so a failure is caught by the
cheapest possible check:

1. **The three DDL files** + `APP_TABLES` + `ROUTING_APP_TABLES` (§3.5). *Verify:* `npm run smoke` —
   the two set-equality assertions name any mismatch.
2. **`server/src/routes/integrations.ts`** — the five routes, the URL check, the 409 mapping.
   *Verify:* `npm run typecheck`, then `GET /api/integrations` returns `{ data: { items: [], counts: { total: 0, active: 0 } } }`.
3. **`isUniqueViolation`** in `server/src/db/`. *Verify:* POST the same title twice; the second is
   `409` with the named sentence, not a 500.
4. **`app/src/data/integrations.ts`**. *Verify:* typecheck.
5. **`app/src/routes/Integrations.tsx`** + `integrations.css`. *Verify:* create, edit, toggle,
   delete, and the error/empty states.
6. **The nav leaf and the `SCREENS` entry** (§2.1, §2.2) — **one edit**, and last, so the rail never
   points at a screen that does not exist.
7. **Gates:** `npm run typecheck`, `npm run lint`, `npm run build` in `server/`; `npm run typecheck`
   and `npm run build` in `app/`; `npm run smoke`.

**Step 6 is last on purpose.** The `built`/`SCREENS` pair fails quietly in both directions, so the
screen is finished before anything claims it exists.

---

## 8. Decisions

### D1 — Is the URL ever called?

**No.** This app has no outbound HTTP client, and adding one is a different feature with its own
concerns (timeouts, retries, credentials, SSRF). Storing a URL and calling it are separable, and
this plan does the first only. *Rejected:* adding a "Test" button — it would need the client, and
a test that only sometimes runs is worse than no test.

### D2 — Does the page show a status?

**No — and this is the decision the page's honesty rests on.** A status indicator would have to
mean "reachable", which requires D1's call. The page shows `Active`/`Inactive` (a field value) and
`urlWellFormed` (a string fact), and its copy states plainly that `Active` records an intention.
*Rejected:* a grey "Not verified" badge — it reads as "unknown but probably fine", which is a
softer version of the same false claim.

### D3 — How is a duplicate title detected?

**A `LOWER(title)` comparison in the handler, with the unique index as a backstop.** The three
dialects disagree about case by default — MySQL and SQL Server are case-insensitive, SQLite is
case-sensitive — so leaning on the index alone would make the three arms behave differently for the
same input. Comparing `LOWER()` explicitly makes the rule the same everywhere and the index catches
the race. *Rejected:* a per-dialect `COLLATE` clause — it puts dialect knowledge in a route, which
is the layering this repo keeps out of `routes/`.

### D4 — Who may read the register?

**Any signed-in account.** The register is not a secret, and a member who cannot see it cannot
answer "is our payroll webhook on?" — the question this page exists to answer. Writes are
super-admin only. *Rejected:* gating reads too — it would make the page render for a member and
then 403, which is a worse experience than showing them the truth.

### D5 — Does `active` default to on or off?

**Off** (§3.2). A gate that opens by default is not a gate, and an unreviewed row should not be
live.

### D6 — Is `title` the primary key?

**No — `id` is, and `title` carries a `UNIQUE` constraint.** A natural text key would make a rename
a delete-and-insert, which loses `created_at` and breaks any future foreign key. Every other app
table uses the identity-plus-natural-key shape (`organization` is `id` + unique `slug`), and this
follows it.

### D7 — Where does `set_by` come from?

**The actor resolved by `requireSuperAdmin`**, stored as the email. It is written on every create
and update, and it is the field that answers "who turned this off?" — which is the first question
asked when an integration is unexpectedly inactive.

### D8 — Does this need a `slug`?

**No.** Nothing links to an integration by URL — it is not a page you navigate to, it is a row in a
list. A slug would be a second unique text key with no consumer.

---

## 9. Open questions for the user

These do not block the build; each has a stated default the plan proceeds with.

1. **Should the URL be rendered as a clickable link?** Default: **no** (§4.6). If yes, the scheme
   allowlist must be re-checked at render time.
2. **Should `http` be allowed, or `https` only?** Default: **both**, with `https` preferred (§4.5).
   If the work environment forbids plain `http` outright, this becomes an `https`-only rule.
3. **Is a fourth field needed now — a category or a vendor name?** Default: **no**, the four asked
   for. Adding one later is an additive migration.
4. **Should deleting an integration be soft (a `deleted_at`) rather than a hard `DELETE`?** Default:
   **hard delete**, matching every other admin register. If an integration ever carries history
   worth keeping, this changes.

**All four were answered "ship with the default as written."**

---

## 10. What the build corrected in this plan

Three places where the plan was wrong or incomplete, found while implementing it, plus a fourth the
browser found after it shipped. Each is fixed inline above; they are listed here so a reader of §2
or §5 knows the text was amended.

1. **§2.1's leaf literal omitted the required `icon`.** `MenuLeaf` has `icon: MenuIcon` — required,
   not optional — so the literal as written does not compile. `icon: 'outbound'` was added; the
   reasoning is under the literal.
2. **§5.1 asks for a description line that `ReadCaps.tsx` does not have.** The head is `.page-head`
   with a `.page-head__sub` extension. `ReadCaps` has only the title and the panel; the one-liner
   and the counts are this screen's.
3. **§5.3's `.field__note` is not a rule.** It is named in a `readcaps.css` comment and rendered by
   `ReadCaps.tsx`, but no stylesheet defines it, so those two call sites are unstyled. This screen
   uses the rule that exists, `.field__hint`.
4. **§5.2's six-column table does not fit the page.** The column set was built as designed and was
   not questioned until the register was measured in a browser at the panel's real width: 1086px of
   table inside a 639px panel, so it scrolled sideways, and the Title column — the one column
   allowed to wrap, and therefore the only one with no minimum width — was squeezed to 55px while
   every row grew to 92px tall. Description and Set by are now panel fields, and what remains is
   laid out with `table-layout: fixed` (§5.2). Removing Set by alone was not enough: a `max-width`
   on a cell does not cap what the column asks for under `auto` layout, so the table stayed 843px.

Two smaller notes, neither a correction to the plan:

- The drawer footer's trailing buttons are wrapped in `.intfoot__end { margin-left: auto }`. The
  template renders `.drawer__spacer` (`ReadCaps.tsx:837`), which no stylesheet defines either — it
  is a zero-width no-op, so the template's footer buttons are not in fact spread.
- §7's build order was followed as written. Step 6 (the leaf and the `SCREENS` entry) was the last
  edit, for the reason §7 gives.

### One defect this build introduced, and the browser caught

`pluralise(n, 'endpoint')` returns the **whole phrase** — `format.ts:103` is
`` `${num(n)} ${n === 1 ? one : many}` `` — it does not return the bare noun. Both count strings
were first written as `<strong>{n}</strong> {pluralise(n, …)}`, which therefore rendered
"2 2 integrations" and "2 2 endpoints". No gate sees this: it type-checks, lints and builds, and the
only way to catch it is to look at the page.

The head now writes the number out and chooses the noun beside it, which is what `Settings.tsx` does
for its own counts (`{n} {n === 1 ? 'organization' : 'organizations'}`); the panel count is
`pluralise` alone, because there it *is* the whole phrase.

The same shape pre-exists in four lines of `LineageSunburst.tsx` (417-420), where `num(n)` is
interpolated in front of `pluralise(n, …)`. That is outside this plan and was left alone.
