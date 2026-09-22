# Custom fields on Oracle-backed rows

**Status:** built and verified live (vendor name; then a vendor site's email, the first field the ledger has no column for). See *Entry #2* below.
**Feature name as asked for:** "Custom Table Fields"

---

## What was asked

> I need a plan for 'Custom Table Fields'. While we cannot edit the Oracle data, it would be nice
> that a person could update certain field values.

with this behaviour as the specification:

> if a person hovers over it, a pencil would show up and they could edit, enter a Custom value and
> click 'save'. The name and value of the field would be saved and shown when the page is loaded.
> Hovering again would show a 'trash' icon and if deleted would just show the field from Oracle.

The example given was a vendor-site title — `J E DUNN CONSTRUCTION COMPANY & T A LOVING A JOINT
VENTURE` — too long to read in a table cell, and something a person would like to shorten without
touching Oracle.

---

## Answered up front, and binding on everything below

| Question | Answer |
| --- | --- |
| Which fields may be overridden? | **A declared registry of overridable fields, starting with the vendor name.** A server-side list names the `(table, field)` pairs that may be overridden; they are added deliberately, one at a time, with a reason. Vendor name is entry #1. Everything not in the list is refused. |
| Who may save and delete? | **Any signed-in user.** Not super-admin. The override records who set it and when, so a curious reader can see whose judgement is on screen. |
| How does a custom value read on the page? | **The custom value, marked as custom, with the Oracle value and the attribution in a tooltip.** Nothing is hidden and nothing is silently substituted — a reader can always see that what they are looking at is not what Oracle holds. |

---

## The measurements that shape the design

Three facts were measured before designing anything, and the first one changes the shape of the
feature.

### 1. The name is a KEY on this page, not a label

This is the finding that constrains everything else. `VendorCompanies.tsx` uses the vendor name for
three things that are not display:

| Line | Use | If it received a custom name |
| --- | --- | --- |
| `919` | `loadMaster(name, …)` — `app/src/data/vendors.ts:507` looks the master record up with `?q=` and keeps only rows whose `VENDOR_NAME === wanted` | Zero rows match, `loadMaster` returns `null`, and the panel states **"the master record could not be read"** about a vendor whose master record is perfectly readable. A working feature would produce a confident false statement. |
| `1032` | `invoiceHref(i, vendor?.name ?? '')` — the vendor name is a **query parameter** on the link to `/spend/invoices`, which narrows the register on it | The link lands on an empty register, and the reader concludes the invoices are gone. |
| `data/vendors.ts:336` | `keyOf(name)` — the register **groups into vendors** on the squashed name | Grouping would change as a display decision changed. |

So the feature cannot be "replace the name". It has to be **two names carried together**:

- `name` — the Oracle name. Every lookup, every link, every grouping key. Never displayed as the
  custom value, never replaced.
- `displayName` — the custom value when one exists, otherwise the Oracle name. Every **label**.

That split is the whole design. A plan that stored a custom name and rendered it into `vendor.name`
would pass every test that only looked at the screen.

### 2. The register carries no vendor id, so the subject key is derived from the name — and that is
   the same key the page already groups by

`app/public/oracle/invoices.json` rows carry `INVOICE_ID, INVOICE_NUM, INVOICE_DATE, INVOICE_AMOUNT,
AMOUNT_PAID, PAYMENT_STATUS_FLAG, DESCRIPTION, VENDOR_NAME, PO_NUMBER, PO_COUNT` — **no `VENDOR_ID`**,
measured (`'VENDOR_ID' in row === false`). `PO_VENDORS` *does* have `VENDOR_ID`, and `VendorMaster`
receives it, but the register never sees it: reaching it would mean one live Oracle lookup per row on
screen, and reading `PO_VENDORS` whole is 160 paged requests.

So the override is keyed on **`keyOf(name)`** — uppercased, non-alphanumerics removed — which is
exactly `Vendor.key`, already documented in the source as *"a stable React key"*.

The important consequence is a defensive one: **if two Oracle names squash to the same key, the page
today already merges them into one vendor row and one detail panel.** An override keyed on that same
key is therefore exactly as ambiguous as the page already is — the feature introduces no new
ambiguity, and must not claim a precision the register does not have.

### 3. That key is not ambiguous in the data we can measure — but the live check is still owed

| Population | Rows | Distinct names | Distinct squashed keys | Keys with 2+ names |
| --- | --- | --- | --- | --- |
| `data/sql/turso/sample.db` → `PO_VENDORS` | 157 | 157 | 157 | **0** |
| `app/public/oracle/invoices.json` (FY2027, fund 04, programs 861/862/863) | 126 | 55 | 55 | **0** |

Both runs carried a control that must pass (a name read out of the table itself was found in the key
set) and one that must fail (`keyOf('ZZZ NO SUCH VENDOR QQQ')` was not), so a green result means the
harness executed and matched rather than silently counting nothing.

⚠️ **Still owed before this ships:** the same check against the live `PO_VENDORS` (79,685 rows), not a
157-row sample, because an override is stored globally and two vendors that collide need not appear in
the same fiscal window:

```sql
SELECT COUNT(*) AS colliding_keys FROM (
  SELECT UPPER(REPLACE(REPLACE(REPLACE(VENDOR_NAME,' ',''),'.',''),',','')) AS k
  FROM PO_VENDORS GROUP BY k HAVING COUNT(DISTINCT VENDOR_NAME) > 1
);
```

If that is non-zero the finding is **not** a blocker — per measurement 2, the page already merges
those vendors — but the number belongs in the table's comment and in the Admin view described below.

### 4. The shape of the problem, from the real data

The register the user is looking at contains a **123-character** vendor name:

```
ARENA PLACE CONDOMINIUM ASSOCIATION, INC C/O LUNDY MANAGEMENT GROUP DBA LEE & ASSOCIATES RALEIGH-DURHAM PROPERTY MANAGEMENT
```

and the joint-venture shape they described:

```
CLANCY & THEYS - THE DANIELE COMPANY - A JOINT VENTURE E-53     (59 chars)
BARNHILL / D A EVERETTE, A JOINT VENTURE                        (40 chars)
```

⚠️ **The literal string from the request is not in this data.** `J E DUNN CONSTRUCTION` (id 10014) and
`T.A. LOVING COMPANY` (id 10008) are **two separate vendors** in `PO_VENDORS`, and the FY2027 window
holds no joint-venture name at all. The example describes the *shape* worth shortening, not a row.
The worked example in this plan uses the 123-character row above, which is real.

---

## The shape

### Storage — one table, `field_override`

Added to `data/sql/turso/01-app.sql` (`00-schema.sql` is read-only and is not touched). It mirrors
`vendor_site_geo`, the closest precedent: an app-owned table keyed on a ledger identity, with no
foreign key because its subject does not live in this database.

```sql
CREATE TABLE IF NOT EXISTS field_override (
  subject_kind TEXT NOT NULL,
  subject_key  TEXT NOT NULL,
  field        TEXT NOT NULL,
  value        TEXT NOT NULL,
  set_by       TEXT NOT NULL,
  set_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (subject_kind, subject_key, field)
);
```

with comments in the file's established voice. The decisions worth recording in the DDL itself:

- **A composite natural primary key, not a surrogate id.** One row per `(subject, field)` is the
  invariant, and a natural key makes it the database's job rather than the handler's. Save-twice is
  an upsert, not a duplicate. Same discipline as `vendor_site_geo`'s `vendor_site_id INTEGER PRIMARY
  KEY`.
- **No foreign key anywhere.** The subject lives in the ledger; there is no table to point at. The
  register is joined to this table **in TypeScript**, not in SQL — the arrangement `vendor_site_geo`
  already documents, and the reason `storeDriver('app')` (not a cross-store join) is what reads it.
- **`set_by` is `TEXT`, deliberately not an FK to `app_user`** — the same reasoning
  `saved_view.created_by` records: attribution has to outlive the row it names, and a removed user
  must not rewrite who made a change.
- **Only the custom value is stored — not a copy of the Oracle value.** The page already holds the
  Oracle value at render time, because it came from the register. A cached copy would drift the first
  time Oracle changed the name and would be a second answer to a question that already has one. It
  also makes *delete* honest: deleting removes the only copy, so what appears afterwards is Oracle's
  current value rather than a snapshot taken when the override was saved.
- **No `organization_id`.** `project`, `geo_origin`, `vendor_site_geo` and `vendor_site_route` are all
  global; only `app_user` is tenant-scoped. A display label over an extract the tenant already sees in
  full is not tenant data, and a per-tenant label would mean the same vendor read two ways on the same
  installation. Recorded in the DDL so the next person does not read its absence as an oversight.
- **No index beyond the primary key**, for the same reason `vendor_site_geo` states: reads are "the
  overrides for one subject", which is a primary-key prefix scan over a table holding a handful of
  rows a person chose to rename.

**No `COLUMN_ADDITIONS` entry is needed.** That list in `app-schema.ts` exists for columns added to
tables that already exist; a new `CREATE TABLE IF NOT EXISTS` is applied by `01-app.sql` on the next
`ensureAppSchema()`. Worth stating, because a reader who knows about `COLUMN_ADDITIONS` will otherwise
reasonably reach for it.

### Three registration points, and the two gates that catch a miss

| # | Where | What |
| --- | --- | --- |
| 1 | `data/sql/turso/01-app.sql` | the `CREATE TABLE` statement |
| 2 | `server/src/db/app-schema.ts` → `APP_TABLES` | the applier's list |
| 3 | `server/src/db/store.ts` → `ROUTING_APP_TABLES` | the list that decides routing |

★ This is the exact drift that cost a session before. `vendor_site_route` reached (1) and (2) and
missed (3), a `SELECT` naming it fell through to **Oracle**, and the router's error was
`ORA-00942: table or view does not exist` — a message saying a table does not exist, about a table this
app creates. **In a router with a default, an unregistered name is not an error; it is a silent
misroute.**

Two gates in `server/src/scripts/smoke.ts` already exist and will fail on a miss, reporting both
directions:

- `…/smoke.ts:2530` — *"APP_TABLES and the CREATE TABLE statements in 01-app.sql are different sets"*
- `…/smoke.ts:2556` — *"the routing list in db/store.ts and APP_TABLES in db/app-schema.ts are
  different sets: in APP_TABLES but not routed to the app store […]; routed but not declared an app
  table […]"*

So there is nothing new to write for this — but the plan must not pretend the arrangement is
self-enforcing, because `APP_TABLES.length` also feeds the Activity register's counts
(`…/smoke.ts:2463`) and its owner classification (`…/smoke.ts:2323`). Registering the table changes
the numbers on the Activity page, and that is expected, not a regression.

### The declared registry of overridable fields

A new module, `server/src/custom-fields/registry.ts`:

```ts
export interface OverridableField {
  /** The kind of subject the override hangs off. */
  subject: 'vendor';
  /** The field to override, as the app names it. */
  field: 'name';
  /** Short label for the pencil's form. */
  label: string;
  /** Enforced on the server; the client uses it only to set `maxlength`. */
  maxLength: number;
  /** One sentence shown in the editor, saying what the override does not change. */
  help: string;
}

export const OVERRIDABLE: readonly OverridableField[] = [
  {
    subject: 'vendor',
    field: 'name',
    label: 'Vendor name',
    maxLength: 120,
    help: 'Shown on this page instead of the Oracle name. Oracle is not changed, and links and lookups still use the Oracle name.',
  },
];
```

**The rule for adding one, written into the module:** a new entry is only added once the field's
render site has been split into a *label* use and a *lookup/key* use. A field that is used as a key
anywhere — grouped on, passed to a query, or put in a link — cannot be overridden by substitution;
it needs the two-name treatment first. That rule is the thing that keeps entry #1 from being a
one-off and entry #5 from being a bug.

The registry is a **server-side** list, so an override naming an unlisted field is refused by the
server even if a client asks for it. The client is not the guard.

### The API

Three endpoints in a new `server/src/routes/customFields.ts`, registered under the existing **Admin**
tag (`openapi.ts`), which is already described as *"App-owned tables: projects, overrides,
portfolios, extract runs, users, and saved views"*.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/custom-fields?subject=vendor` | every override for one subject |
| `PUT` | `/api/custom-fields/{subject}/{field}` · body `{ key, value }` | set/replace one field on one subject |
| `DELETE` | `/api/custom-fields/{subject}/{field}?key=…` | remove it — 204, no body |

Decisions and their reasons:

- **`GET` returns the whole subject, not the keys a page asked about.** Overrides are a handful of
  rows a person bothered to write; a 55-vendor register would otherwise put 55 keys in a query string
  to fetch zero or three rows. This is the same "hundreds, not millions" reasoning that justifies the
  missing index. It also **lets the client detect overrides that no longer match anything** (see
  orphans, below), which a key-filtered read cannot.
- **The subject key is in the body, not the path.** The real key for the worked example is 123
  characters (`ARENAPLACECONDOMINIUMASSOCIATIONINCCOLUNDYMANAGEMENTGROUPDBALEEASSOCIATESRALEIGHDURHAMPROPERTYMANAGEMENT`);
  `{subject}` and `{field}` are short and bounded, so they take the path and the long key does not.
- **`PUT`, not `POST` + `PATCH`.** The client cannot know whether Save is a create or a replace —
  that is a fact about the store, and making the browser guess would produce a 409 on the second save
  of the same field. One idempotent `PUT` keyed on the row's natural key is the honest verb. This is a
  deliberate departure from the `POST`/`PATCH`/`DELETE` trio in `projectRegistry.ts`, and the reason
  belongs in the route's comment so the next reader does not "fix" it.
- **`set_by` comes from the session, never the body.** Any body field claiming an author is ignored.
- **Blank is refused, not treated as a delete** — `400 BAD_REQUEST`: *"A blank custom name is not a
  delete; use the trash to show the Oracle value again."* Otherwise the store holds an empty string as
  a third state that reads as a missing name, which is neither of the two things a reader can act on.
  Trimming happens server-side, so `"   "` is blank too.

**Per the house convention on the two 400s:** the zod schema rejecting a malformed body is
`VALIDATION_FAILED`, and the handler refusing a field that is not in the registry is `BAD_REQUEST`,
because whether a field is overridable is a rule whose answer is the registry, not a fact about the
shape of the request. `404` is reserved for DELETE of an override that is not there, and it is
returned for a never-existing key exactly as for an already-deleted one — the `DELETE
/api/projects/{slug}` discipline.

Authorization is `requireActor(req)` (401 when signed out) — **not** `requireSuperAdmin`, per the
answer that any signed-in user may write. `requireAppSchema('Custom fields')` is called first, so a
missing store is a `503 DB_UNAVAILABLE` naming the store, and never a 500.

### The client

**`app/src/data/customFields.ts`** — the data module, following the pattern of its neighbours:

```ts
export interface FieldOverride {
  subject: string;
  key: string;      // keyOf(oracleName)
  field: string;
  value: string;
  setBy: string;
  setAt: string;
}

loadOverrides(subject: string, signal?: AbortSignal): Promise<FieldOverride[]>   // [] on failure, never throws for a page
saveOverride(subject, field, key, value): Promise<FieldOverride>
deleteOverride(subject, field, key): Promise<void>                                // checks res.ok only; a 204 has no body to parse
```

`loadOverrides` returning `[]` rather than throwing is a deliberate copy of `loadMaster`'s documented
behaviour: the register is complete without the overrides, so a dead override store must degrade to
*"the Oracle names"*, not to a broken page. The corollary is the honest one — the page must **say** it
could not read them rather than quietly showing Oracle names as though nothing were saved.

**`app/src/components/EditableField.tsx`** — the affordance. Rendered as:

```
  Arey Jones Educational Solutions ⚙              ← custom, marked
  ─────────────────────────────────────────
  ARENA PLACE CONDOMINIUM ASSOCIATION, INC …       ← Oracle, on hover/focus
  Set by Dana Whitfield · 2026-09-18
                                    [pencil] [trash]
```

- **The Oracle value and the attribution are always in the DOM**, in a visually-hidden element
  referenced by `aria-describedby`, and the visual tooltip is a CSS `::after` on `:hover` **and
  `:focus-visible`**. A `title` attribute would be invisible to keyboard and screen-reader users, and
  this app cares about that elsewhere (every action already carries an `aria-label`, and the drawers
  restore focus to their opener).
- **The pencil appears on hover AND on keyboard focus**, and a marked value always shows its mark.
  A control that only exists under a mouse is unreachable; the **two controls** (pencil and trash) are
  real `<button>`s with labels, so tabbing reaches them.
  ★ **The mark is not one of them, and the sketch above says otherwise.** It is a
  `<span class="cf__mark" role="img">` whose accessible name is the field — *"Custom vendor name"* —
  because it is a *statement about the value*, not an action. An earlier draft of this document called
  it "a real `<button>` with a label"; it never was one, and making it a button would put a third
  stop in every tab path to announce nothing a reader can do.
- **Editing is in place**: Enter or Save commits, Escape or Cancel restores. On commit the value is
  re-read from the server rather than optimistically swapped, for the reason `projectMeta.ts` records
  about its own writes — *"a local guess is what makes a list disagree with its own database"*.
- **Focus returns to the pencil** after save, cancel and delete, using the same
  capture-the-opener discipline the drawers use.
- **Delete confirms nothing, and says what it will do instead**: the trash's accessible name is
  *"Remove the custom vendor name and show the Oracle value"*. Deleting is reversible by typing it
  again, so a modal would be friction over a two-click undo. ★ The sentence branches on the field —
  on a field the ledger has no value for it reads *"…and leave the field empty"*, because "show the
  Oracle value" would promise something that does not exist (see *Entry #2*).
- **The mark is a small gear, not the word "custom"** — changed after the mark was first built as an
  info pill reading `CUSTOM`. The pill was wider than most of the names it sat under, so on the rows a
  reader had renamed it became the loudest thing in the cell and the value came second. The mark's job
  is *"this is not the ledger's name"*, which a shape carries and a bold word over-carries; the
  disclosure it used to imply is still carried by the `title` in a register, the tooltip in a panel,
  the visually hidden note in every variant, and `CustomNamesNote` when the read failed. It is drawn as
  inline SVG rather than typed as `⚙` so its weight and colour are ours and it cannot arrive as a
  colour emoji that ignores `color`.

### Entry #2 — a vendor site's email, and the field the ledger does not have

The registry's own header states the three steps for adding a field. Entry #2 (`vendor_site` /
`email`) is the first that is **not** a field the ledger holds and a reader replaced, and the
consequences are worth writing down because the code differs from entry #1 in exactly one declared
fact.

- **Why a second subject at all.** A site's email belongs to the *site* (`VENDOR_SITE_ID`); the name
  above it belongs to the *company*. One email covering every site a vendor has is not what a reader
  looking at one address means by it, so they are two subjects, two keys, and — because
  `GET /api/custom-fields?subject=…` answers one subject at a time — **two reads on the page**. Each
  read fails on its own, which is why the panel renders its own unread note instead of leaning on the
  register's. (Verified as a control: aborting only `?subject=vendor_site` renders *"Custom emails
  unread"* in the panel and leaves the register's names alone.)
- **`fromLedger: false` is declared, not inferred.** The value is blank, and blank is also what a
  field with *no* override looks like — so the fact cannot be read off the value. The declaration
  carries it, and it decides four sentences: the tooltip's *"Oracle holds no value for this field"*
  (instead of *"Oracle holds “”"*, which names a source for something that has none), the
  no-override line, the blank-draft hint (*"the trash leaves the field empty"*), and both
  `aria-label`s on a field with nothing underneath.
- **`foldVendorSiteKey` is a `trim()` and is deliberately not `foldVendorKey`.** Site ids are digits,
  so reusing the vendor fold — which uppercases and strips punctuation — would *work* on every real
  input and silently fold two ids together the day one carried a hyphen. The smoke check proves the
  two folds differ using a hyphenated synthetic key, because a real id cannot tell them apart.
- **The blank refusal branches on the same flag.** PUT answers *"…show the value the ledger holds
  again"* for entry #1 and *"…leave the field empty again"* for entry #2; the check asserts the
  second does **not** match the first's wording.
- **The panel's hint is scoped to the exception.** The Address card reads *"as the ledger holds it —
  email excepted"*, because a precise neighbour had turned the old unqualified hint into a false
  claim about the one row it did not describe.

### The render sites, and the two-name split

| File | Line | Today | After |
| --- | --- | --- | --- |
| `app/src/routes/VendorCompanies.tsx` | `1070` | `{vendor?.name ?? ''}` in `drawer__name` | `displayName`, as an `<EditableField>` |
| " | `884` | `const name = vendor?.name ?? ''` | keep `name` (Oracle); add `displayName`, `customName` |
| " | `919` | `loadMaster(name, …)` | **unchanged — Oracle name. This is the line that must not be touched.** |
| " | `1032` | `invoiceHref(i, vendor?.name ?? '')` | **unchanged — Oracle name** |
| " | `1052` | `aria-label` from `vendor.name` | `displayName`, and say when it is custom |
| " | `268` | CSV filename from `vendor.name` | `displayName`, sanitised |
| `app/src/routes/VendorSites.tsx` | `1061` | `<span className="vs-vendor">{s.vendorName}</span>` in the register cell | `displayName` — **this is the cell the 123-character name overflows** |
| " | `1373` | `{site?.vendorName}` in the site drawer | `displayName` |
| " | `1354`, label | `aria-label` naming the vendor | `displayName` |
| vendor-payments CSV body | — | one `Vendor` column | **two columns**: `Vendor` (`displayName`) and `Vendor name (Oracle)` (`name`) |

★ That last row is a deliberate exception to "labels show the custom value". An export is a document
that leaves the app and gets reconciled against Oracle by somebody who cannot see the pencil. A
renamed vendor in an exported file with no way back to the Oracle string is worse than a wide column,
so the export carries both — and the header says which is which.

---

## Every file that changes

| Kind | File |
| --- | --- |
| new | `data/sql/turso/01-app.sql` → one table appended (with its comment block) |
| edit | `server/src/db/app-schema.ts` → `APP_TABLES` |
| edit | `server/src/db/store.ts` → `ROUTING_APP_TABLES` |
| new | `server/src/custom-fields/registry.ts` |
| new | `server/src/routes/customFields.ts` |
| edit | `server/src/routes/index.ts` → `registerCustomFields(api)` in `apiRouter()`, alongside `registerProjectRegistry(api)` |
| edit | `server/src/http/openapi.ts` → the descriptors (Admin tag) |
| new | `app/src/data/customFields.ts` |
| new | `app/src/components/EditableField.tsx` |
| edit | `app/src/routes/VendorCompanies.tsx` · `app/src/routes/VendorSites.tsx` |
| edit | `app/src/data/vendors.ts` → `displayName` / `customName` on `Vendor` or a join helper |
| edit | `server/src/scripts/smoke.ts` → the new gates below |
| edit | `docs/features/*.md` or `docs/plans/` index, if the house keeps one |

**Never touched:** `data/sql/turso/00-schema.sql` (read-only), and every Oracle object. The app has no
write path to the ledger at all, and this feature does not add one.

---

## Edge cases the design has to answer

**An override whose vendor is gone.** If Oracle renames a vendor, `keyOf(newName)` no longer matches
the stored `subject_key`, and the override silently stops applying. `GET` returning the whole subject
is what makes this visible: the client knows which keys it could match and which it could not, so the
register can carry a note — *"2 saved vendor names no longer match a vendor in this register"* — the
same distinction `vendor_site_geo` draws between *"never attempted"* and *"attempted, and this is what
happened"*. **Silence is the failure mode to avoid**, not a stale value.

**Two names squashing to the same key.** Already true of the register's own grouping (measurement 2),
so the override inherits it rather than creating it. The live collision count belongs in the DDL
comment, and the Admin view below is where a reader can see the affected names.

**A custom value that is longer than what it replaces.** The pencil's input carries
`maxlength={maxLength}` and the server enforces the same number; a custom name longer than the
Oracle one would defeat the point of the feature and would break the very cell it was meant to fix.

**The override store is unreachable.** `requireAppSchema` answers 503 naming the store; on the client
`loadOverrides` yields `[]` and the register renders Oracle names with the pencil **disabled and
explained**, not hidden. Hiding it would make a broken feature indistinguishable from an unbuilt one.

**A signed-out reader.** Overrides still *render* (they are page content, and the register is readable
signed out in the modes that allow it); the pencil and trash are absent. Reading a custom value must
not require a session, or the page would show different names to different readers for no stated
reason.

---

## Non-goals

- **No writing to Oracle, ever.** The override is a display label in the app's own store.
- **No overriding of figures.** Amounts, counts, dates and statuses are not in scope: a renamed
  vendor is a label a reader reads, a changed amount is a fact a reader relies on. Nothing in this
  design should be reused to edit a number, and the registry's `help` sentence says so on screen.
- **No per-tenant overrides** (see the DDL note).
- **No history.** One `set_by`/`set_at` per row is the record. An audit trail of every rename is a
  different feature with a different table, and pretending the current columns provide it would be
  worse than not having it.
- **No global rename propagation.** Overriding a name in the register does not rewrite the same name
  in an extract, an export or a chart; the two-name rule is applied where a reader reads a label.

---

## Verification

Nothing here is new machinery — the repo's pattern is executable gates in `server/src/scripts/smoke.ts`
plus a probe on the real write path. The gates this feature needs:

1. **The two existing set-equality gates** (`smoke.ts:2530`, `smoke.ts:2556`). They fail on a miss and
   name the table in both directions. Nothing to write; say in the plan that the smoke suite is the
   reason the three registration points are not a matter of memory.
2. **Round trip on a throwaway key.** `PUT` a value for a key that cannot be a real vendor
   (`ZZZ-PROBE-CUSTOM-FIELD`), `GET` and assert it is present with the value and the `set_by` from the
   session; `DELETE`, assert 204 and that the `GET` no longer carries it. A throwaway key, never a real
   vendor — a previous session overwrote a production row while believing a `finally` would roll it
   back.
3. **A failing control beside it.** `PUT` naming `field=no_such_field` → 400 `BAD_REQUEST`, and a
   `PUT` with a body missing `value` → 400 `VALIDATION_FAILED`. Without these, gate 2 cannot
   distinguish a working guard from a harness that never consults the registry.
4. **An empty-subject read is an empty list, not a 404.** `GET /api/custom-fields?subject=vendor` with
   nothing stored answers `{ data: { overrides: [] } }`. A 404 would make "nobody has renamed anything"
   indistinguishable from "this endpoint is broken".
5. **A blank value is refused**, and the message names the trash as the way to revert.
6. **The one that matters most, and it is not a server gate.** After an override is saved, assert the
   page still called `/api/vendors?q=<ORACLE NAME>`. Every other check here passes a design that
   renders the custom name into the lookup key and leaves the master record showing *"could not be
   read"*. This is a Playwright probe, and it is the single check that would have caught the failure
   this whole plan is arranged around.
7. **A reachability check per endpoint, reading a real field out of each payload** — not a
   `status !== 404` check. A path that is merely *routed* is not a path that works; this repo has
   already shipped three dead-on-arrival endpoints behind exactly that assertion.

**A pre-flight measurement, before any of the above:** the live `PO_VENDORS` collision count from
measurement 3, run once and recorded in the DDL comment.

---

## Build order

1. Measure the live collision count; record it.
2. The table in `01-app.sql`, with its comment block, plus the three registration points. Run
   `npm run smoke` — the existing gates either pass or name the table you forgot.
3. The registry module, with the rule for adding an entry written into it.
4. The three endpoints, following `projectRegistry.ts` for the partial-write and 404/409 discipline,
   `vendorSites.ts` for reading an app table through `storeDriver('app')`, and `guard.ts` for
   `requireActor`.
5. Gates 2–5 in the smoke suite.
6. `app/src/data/customFields.ts`, with `loadOverrides` degrading to `[]` and the page saying so.
7. `EditableField.tsx`, then the render sites — **`VendorCompanies.tsx:1070` first**, with
   `919` and `1032` re-read and asserted unchanged in the same pass.
8. The register cell at `VendorSites.tsx:1061` and the export's second column.
9. Gate 6, the browser probe.
10. The Admin view of unmatched overrides, if it is wanted at all — the register's own note (edge case
    1) covers the important half of it.

---

## The one-sentence summary

The register has no vendor id and uses the vendor name as a **lookup key and link parameter**, so a
custom field cannot replace the name — it has to ride beside it: Oracle's name for every lookup and
every link, the custom value for every label, a marked value with Oracle's name and the author in the
tooltip, and one small app-owned table storing only the difference.
