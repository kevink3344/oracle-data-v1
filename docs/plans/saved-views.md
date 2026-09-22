# Saved Views — Implementation Plan

**Status:** DRAFT — for review · **Created:** 2026-09-21 · **Revision:** 1

| | |
|---|---|
| **Purpose** | Define the reader-facing half of the View Builder: what a *subscribed* view is, where a person subscribes, what the Subscribed Views table counts, and what a subscription does and does not promise |
| **Scope** | A new screen (`Views`, `/views`), one new read endpoint, one column on `saved_view_run`, the extraction of the result grid out of `/admin/views`, and the **removal** of the View Builder's own Subscribe control. **Not** scheduling, delivery or webhook transport — those are yours (§7) |
| **Grounded in** | The note in §0, [`view-builder.md`](./view-builder.md) (whose phases 1–3 are built), and the code as it stands on 2026-09-21: [`views.ts`](../../server/src/routes/views.ts), [`01-app.sql`](../../data/sql/turso/01-app.sql), [`query-guard.ts`](../../server/src/db/query-guard.ts) |
| **Depends on** | `VIEW_BUILDER_ENABLED=1` and at least one saved view with a declared fingerprint key. The three tables and all eleven `/api/views` routes already exist, so this is a client-and-one-query plan, not a from-scratch one |
| **Supersedes** | The View Builder's own Subscribe button and Subscribe panel, by the note's own instruction (§4) |

---

## 0. The note, kept verbatim

Replaced by this document, so it is quoted here in full to keep the original diffable. Note the
trailing heading.

```text
## Save Views concept

# View link
Beneath "Pinned" there should be a link to a view. A user can select a view from a drop-down "First fundings by combination" and click "SUBSCRIBE". The view is added to "Subscribed Views" table that appears like so:

View Name | Current Count | Total Count | Last Change | Status
First fundings by combination | 10 | 10 | 9/21/2022 | [trash icon]
My View | 5 | 5 | 8/21/2022 | [trash icon]

# View entry
When the person clicks on the "View Name", a panel slides in from the right that displays the SQL results of the view (see "View Builder").

# Notes
The "View Builder" Subscribe feature is deprecated.

# Notifications
```

---

## 1. The answer in one line

**A subscribed view is a saved view plus a person's name, and the only thing that can be said about it
is what the last runs recorded — so the screen must count what it can see and say what it cannot.**

The note asks for two counts and a status, and this plan spends most of its length on those three
cells, because they are the only place where this feature can tell a comfortable lie. The note's
example rows read `10 | 10` and a status, and the code as it stands can produce **neither count
honestly** without one extra column (§6) and cannot produce a status of `Active` at all without
promising a delivery that does not exist (§7).

Everything else in the note is a browsing surface over data that is already stored.

---

## 2. What already exists — and what this plan therefore may not re-propose

This plan was written *after* checking, because the temptation here is to re-specify work that is on
disk. `view-builder.md` §6.2 proposed three tables and §9 proposed eleven routes; both are now fact.

| The note implies | State on disk | Where |
|---|---|---|
| a place to store a view | **built** | `saved_view` — [`01-app.sql:67`](../../data/sql/turso/01-app.sql) |
| a place to store that a view ran | **built** | `saved_view_run` — [`01-app.sql:121`](../../data/sql/turso/01-app.sql) |
| a place to store who is watching | **built** | `saved_view_subscription` — [`01-app.sql:156`](../../data/sql/turso/01-app.sql) |
| run a view, record a run, list runs | **built** | `POST /api/views/{id}/run`, `GET /api/views/{id}/runs` |
| subscribe and unsubscribe | **built** | `POST`/`DELETE /api/views/{id}/subscriptions` |
| author and edit a view | **built** | `/admin/views` — [`ViewBuilder.tsx`](../../app/src/routes/ViewBuilder.tsx) |
| **a way to ask "what is *this person* watching?"** | ❌ **missing** | §2.1 |
| the screen the note describes | ❌ **not built** | — |
| the rail leaf beneath Pinned | ❌ **not built** | — |
| the slide-in result panel | ❌ **not built** | — |

### 2.1 ★★ The one thing that is genuinely missing on the server

`GET /api/views/{id}/subscriptions` answers *"who watches this view"*. Nothing answers **"which views
does this person watch"**, and that is the only query the note's table needs.

It cannot be assembled from the client, either. Not cheaply, and not correctly:

- **N+1 is not the problem; the columns are.** `Current Count`, `Last Change` and `Status` all come
  from `saved_view_run`, so a client-side solution is *N requests for subscriptions, plus N requests
  for run history*, and then it still has to decide which run counts as "last change" from a paginated
  history — a decision that belongs in one `ORDER BY`, not in a browser.
- **The unique key hides a real limitation.** `saved_view_subscription` is
  `UNIQUE (view_id, subscriber, channel)` ([`01-app.sql:168`](../../data/sql/turso/01-app.sql)). Two
  people who sign in as the same name collapse into one row, and re-subscribing returns the *existing*
  row rather than an error ([`views.ts:1204`](../../server/src/routes/views.ts)). That is the right
  behaviour, and it makes the subscriber string the identity — which the page has to say out loud
  (§8.3).

So phase 1 is **one read endpoint**, and nothing else on the server changes except one column.

---

## 3. The note's six elements, and what each becomes

| # | The note says | This plan | Source of truth |
|---|---|---|---|
| 1 | *"Beneath 'Pinned' there should be a link to a view"* | A new leaf **`Views`** in the **Overview** block, immediately after `Pinned`, at `/views` | `Pinned` is [`menu.ts:151`](../../app/src/nav/menu.ts); the rail groups by block |
| 2 | *"select a view from a drop-down"* | A `<select>` on the new page listing only **subscribable** views | `GET /api/views` already returns `status`, `params` and `display` |
| 3 | *"click 'SUBSCRIBE'"* | A button beside it, subscribing **the signed-in name** | `POST /api/views/{id}/subscriptions` |
| 4 | *"added to 'Subscribed Views' table"* | The page's table, five columns + trash | the new endpoint (§5) |
| 5 | *"clicking on the View Name … a panel slides in from the right"* | A local `.drawer` rendering the extracted result grid, **previewing and not recording** | `POST /api/views/preview` |
| 6 | *"[trash icon]"* | Unsubscribe, no confirmation dialog | `DELETE /api/views/{id}/subscriptions/{subscriptionId}` |

### 3.1 Why the leaf goes in Overview and not in Administration

The note's mockup is a **sidebar**, and its "Pinned" is a rail leaf — so the port is a rail order, not
a page layout. `Pinned` and `Views` are both *your stuff* rather than *the data*: Pinned is your
shortcuts, Views is your watches. Administration is where views are **authored**, and it currently
carries six `built: false` leaves; a reader's page does not belong among them.

★ **The leaf and the route change in one edit, or not at all.** `App.tsx` generates a route per
`ALL_LEAVES` entry, so a leaf with no `SCREENS` entry is *silent* — it renders `Pending`, which reads
as "not written yet" rather than "misspelled". The asymmetry is recorded in `menu.ts`'s Administration
comment and in `App.tsx`'s dev warning, and it is the one failure in this area that does not throw.

### 3.2 What "subscribable" means, and why the dropdown must not show everything

`GET /api/views` returns **every** view, including `draft` and `disabled`. The subscribe route refuses
only two things: a `webhook` channel ([`views.ts:1186`](../../server/src/routes/views.ts)) and a view
with no `display.fingerprint.key` ([`views.ts:1196`](../../server/src/routes/views.ts)). It does **not**
check `status`.

| Filter | Where it belongs | Why |
|---|---|---|
| `status = 'active'` | the dropdown | a draft is somebody's work in progress and a disabled view is one its author retired; offering either invites a subscription to something nobody maintains |
| `display.fingerprint.key` declared | the dropdown | the server 400s it with `NO_FINGERPRINT_KEY`, so offering it is offering a button that refuses |
| the seven-bind parameter problem | the dropdown, phase 1 | §3.3 |

Both facts are already in the list response, so phase 1 filters on the client and adds no server work.
★ That filter is a **convenience only**: the server stays the authority, and the page renders its
refusal verbatim if the filter is ever wrong.

### 3.3 ★ The note's dropdown has nowhere to put parameters

The note's own example, *First fundings by combination*, is the seven-bind query in
[`docs/ideas/view-builder.md`](../ideas/view-builder.md) — `:s1`…`:s7`, one per segment. A view like
that **cannot run without values**, and `compileParams` refuses a declared parameter with no default
and no value *before* the query runs (`view-builder.md` §7.2).

So the panel from element 5 needs a parameter form that the note never draws. Two options for phase 1:

- **(a, recommended)** The dropdown offers only views **whose declared parameters all have defaults**,
  and the page states why the others are absent: *"3 views are not listed because they need values the
  panel cannot yet ask for."* That sentence is the honest version of hiding them.
- **(b)** Build the parameter form now by extracting the View Builder's too — a second extraction in
  the same phase as the grid's.

Recommend **(a)**: one extraction instead of two, the limitation is visible rather than silent, and
it is the version whose copy is true on the day it ships.

---

## 4. "Deprecated" has to mean something specific

The note says *"The 'View Builder' Subscribe feature is deprecated."* That word has four meanings in
practice and only one of them is not misleading, so this section pins it down.

### 4.1 What is removed, exactly

In [`ViewBuilder.tsx`](../../app/src/routes/ViewBuilder.tsx):

| Removed | Anchor |
|---|---|
| the **Subscribe** button in the run toolbar | the action bar's third control |
| `SubscribePanel` | `:2290` |
| `subscribe()` and `unsubscribe()` | `:959`, `:988` |
| `subscribeNote` state and its render site | `:718`, `:1408` |
| the `Subscription` interface | `:187` |
| `localStorage['viewbuilder-subscriber']` — read at `:715`, written at `:962` and `:1412` | ★ **deleted, not left behind** |

★ On the `localStorage` key: a key that nothing writes is a key the next person reads and adopts,
because it still has a value in it. Removing the control and leaving the key is the shape of a
deprecation that comes back.

### 4.2 What is *not* deprecated, and gets louder

- **`Display › Fingerprint key`.** A view with no declared key cannot be subscribed to at all
  ([`views.ts:1196`](../../server/src/routes/views.ts)). Removing the Subscribe button from the builder
  removes the only *in-screen* reason to declare one — so the field's helper text must now say where it
  is used: *"Used by `Views`, where somebody subscribes to this view."* Otherwise this deprecation
  makes the one required field look optional.
- **`POST`/`DELETE …/subscriptions`.** The note deprecates a **control**, not an endpoint. Both routes
  are used by the new page; one of them by nothing else.
- **The Runs history.** It is where `Last Change` is derived from, and where a reader goes to see what
  actually moved.

### 4.3 ★ The ordering constraint

**The new page (§11 phase 2) must land before, or with, the removal (§11 phase 4).** For any interval
where both subscribe controls exist, two controls write the same `UNIQUE (view_id, subscriber,
channel)` row and neither is authoritative — and because re-subscribing is deliberately not an error
([`views.ts:1204`](../../server/src/routes/views.ts)), the second one *succeeds quietly* and the two
screens can disagree about who is watching.

---

## 5. The Subscribed Views table, column by column

The note's header is `View Name | Current Count | Total Count | Last Change | Status`, and each row
ends with a trash icon. Here is each cell with its source named, and — where the note's word has no
faithful source — what this plan proposes instead.

| Column | Source | Honest today? |
|---|---|---|
| **View Name** | `saved_view.title`; links to the panel. `saved_view.slug` goes in the row's sub-line, because two views may share a title and the slug is the identity | yes |
| **Current Count** | `row_count` of the **newest successful** run: `SELECT row_count, truncated FROM saved_view_run WHERE view_id = ? AND fingerprint IS NOT NULL ORDER BY ran_at DESC, id DESC LIMIT 1` | ★ **only after §6.1** |
| **Total Count** | ★ **no faithful source — see §5.1** | no |
| **Last Change** | `ran_at` of the newest run whose `fingerprint` differs from the run immediately before it. If nothing has changed since subscribing, show the **subscription's** `created_at`, labelled *"unchanged since you subscribed"* and never as a change | yes, derived |
| **Status** | ★ **not a delivery state — see §5.2** | no |
| **trash** | `DELETE /api/views/{id}/subscriptions/{subscriptionId}` — which requires the list to return **`saved_view_subscription.id`**, not just the view id | yes |

### 5.1 ★ `Total Count` has nothing to be the total of

Under the architecture `view-builder.md` §2 adopted, **a view is trusted SQL, not a saved filter**. A
saved filter has a natural numerator and denominator — *"these 10 of 41,877 rows"* — and that is almost
certainly what the mockup's `10 | 10` was drawn from. Here there is no filter, so there is no "all
rows" set to divide by and a column headed `Total Count` has no query behind it.

Two readings are available, and both are facts:

| Reading | Definition | Character |
|---|---|---|
| **(a) now vs before** | the **previous** successful run's `row_count` | moves on every change, so the pair reads as noise on a quiet view |
| **(b) now vs when you asked** | the count at the moment of subscribing, locatable as the newest successful run at or before `saved_view_subscription.created_at` | stable, derivable, and answers the question a watcher actually has: *"is it more than when I started watching?"* |

**Recommendation: (b), and rename the column `Rows when subscribed`.**

★ **The rename is not a nicety.** A column headed `Total Count` holding a *previous* count, or a
*subscribing* count, is a column whose header describes a different query than the one that fills it —
the specific failure this repository has already paid for once, named in the schema's own comment about
a *"fictitious -100% delta"* ([`01-app.sql:130`](../../data/sql/turso/01-app.sql)). If (a) is chosen
instead, the header must read `Previous` and the tooltip must say *previous successful run*.

### 5.2 ★ `Status` cannot read `Active`

`saved_view_subscription` stores intent and nothing consumes it. `01-app.sql` says so in as many words —
*"There is no delivery mechanism in this phase … nothing here is scheduled and nothing fires"*
([`:146`](../../data/sql/turso/01-app.sql)) — and the subscribe route repeats it to the caller when it
refuses a webhook: *"a subscription that looks active and can never fire"*
([`views.ts:1183`](../../server/src/routes/views.ts)).

The honest vocabulary, all derivable from `saved_view_run` plus `display.fingerprint.key`:

| Status | When |
|---|---|
| `Not run yet` | no successful run recorded — never `0 rows` (§10.8) |
| `Ran · unchanged` | a successful run, same fingerprint as the one before |
| `Changed` + date | the newest adjacent pair differs; the date is the `ran_at` |
| `Failed last run` | the newest run has an `error` and no fingerprint |
| `Capped` | the newest run was truncated at the row cap (§6.1) |
| `Cannot watch` | the view no longer returns the declared key column — drift, not an error |

★ Note what is **absent** from that list: any word meaning *"you will be told"*. That is §7.

### 5.3 The trash has no confirmation dialog, and that is deliberate

`Pinned.tsx` unpins on one click with no modal. The justification for doing the same here is stronger
than symmetry: **the server already treats re-subscribing as the same request twice rather than an
error** ([`views.ts:1204`](../../server/src/routes/views.ts)) — so an accidental unsubscribe is undone
by pressing SUBSCRIBE again, and a modal would be a dialog guarding a reversible action. The row
disappears; nothing else happens.

---

## 6. ★★ The two ways a count column lies, both measured in the code

This is the part of the plan that earns its length. Both findings are in the code as it stands.

### 6.1 `saved_view_run.row_count` records the **capped** count, and nothing records that it was capped

The chain, with the anchors:

1. `maxRows` defaults to **200** ([`env.ts:215`](../../server/src/config/env.ts), `VIEW_BUILDER_MAX_ROWS`).
2. `wrapForRowCap` wraps the author's statement as `SELECT * FROM (\n…\n) LIMIT 201` — one past the cap
   on purpose, so truncation can be **detected** ([`query-guard.ts:675`](../../server/src/db/query-guard.ts)).
3. `capResult` slices to 200 and returns `truncated: true` ([`query-guard.ts:695`](../../server/src/db/query-guard.ts)).
4. `shapeResult` sets `rowCount: rows.length` **after** that slice — [`views.ts:1325`](../../server/src/routes/views.ts) — while separately returning the truthful `truncated` at `:1327`.
5. `recordRun` writes that `rowCount` into `saved_view_run.row_count`
   ([`views.ts:1348`](../../server/src/routes/views.ts)) and does **not** write `truncated`.
6. `saved_view_run` has no column for it ([`01-app.sql:121`](../../data/sql/turso/01-app.sql)).

So a view returning 4,812 rows stores `200`, and **no reader of the history can tell `200` from `200 or
more`**. A table whose second column is headed *Count* is precisely where that matters.

**Fix:** add `truncated INTEGER` (0/1, nullable) to `saved_view_run`, write `executed.truncated`
alongside `row_count`, and render `200+` when it is set. The schema change follows the pattern the repo
already uses for a column added to a table that may exist — declared in `01-app.sql` **and** listed in
`COLUMN_ADDITIONS` in [`app-schema.ts`](../../server/src/db/app-schema.ts), because
`CREATE TABLE IF NOT EXISTS` is a no-op on every store built before the change.

### 6.2 The fingerprint cannot see past the cap either — so a subscription on a capped view is nearly blind

`fingerprint()` hashes **`executed.rows.length`** — the capped length — plus the values of the declared
key column **of the capped rows, in the statement's order**
([`views.ts:666`](../../server/src/routes/views.ts)). Two consequences the note's promise cannot survive
unqualified:

- **The count term saturates.** On a view over the cap the first term of the hash is `200` on every run;
  growth from 4,812 to 40,000 rows does not move it.
- **The sample is fixed.** Only the first 200 rows are compared, so a change entirely beyond the cap is
  invisible — including a row *deleted* beyond the cap.

And a third that is worse because it can fire **with no change at all**: `sortRows` applies
`display.sort` *after* the fingerprint is computed, so the watched order is the statement's own. A
statement with **no `ORDER BY`** has no guaranteed order, so the sampled rows can differ between runs
for reasons that are not changes, and the subscription would report one.

**What the plan does about it:**

1. **State it, on screen, in the reader's words** — not in a comment. Panel caveat copy:
   > Watches the first 200 rows of this view. A change that keeps those rows and their values the same
   > is not seen, and neither is anything past the 200th row.
   plus, only when the statement has no `ORDER BY`:
   > This view has no `ORDER BY`, so its row order is not guaranteed and a reordering can read as a change.
2. **Mark the counts** `200+` (§6.1), so the table never presents a capped number as a total.
3. **Recommend** in the fingerprint field's helper text that a view meant to be watched should select
   the column it is watched *for* and `ORDER BY` something stable.

★ What is **not** proposed: hashing the whole result, or running a `COUNT(*)` first.
`view-builder.md` §5.3 forbids the second for a real reason — it doubles the cost of every run to
produce a number this screen does not need — and the first defeats the reason the sample is a sample.
The honest answer to an imperfect detector is a stated blind spot, not a bigger hash.

---

## 7. Filling the note's empty "Notifications"

The note ends with a heading and no content. What belongs under it is a **prerequisite list**, not a
design, because the feature as sketched cannot notify anything yet:

| Step | State |
|---|---|
| 1. Something runs the views on a schedule | ❌ does not exist. A view runs only when a person presses **Run** in `/admin/views` |
| 2. The scheduled run writes a `saved_view_run` row | ✅ `recordRun` does this — but only on `POST /api/views/{id}/run` |
| 3. Something compares fingerprints and decides "changed" | ✅ stored per run; the comparison is available (§5) |
| 4. A delivery channel exists | ❌ `channel` is `CHECK (channel IN ('in_app','webhook'))` and `webhook` is refused with `CHANNEL_NOT_IMPLEMENTED` ([`views.ts:1186`](../../server/src/routes/views.ts)) |

**So phase 1's copy must not contain the words *notify*, *notification* or *alert*.** The truthful
sentence for a subscribe action is:

> **Watching.** A change is recorded the next time this view runs. Nothing is sent yet — this server
> has no scheduler and no sender.

★ **`target` stays a plain string and the page never asks for one.** The schema already says why:
*"`target` is deliberately a plain string rather than a URL: the app has no webhook sender, so
describing it as a URL would promise a delivery that cannot happen"*
([`01-app.sql:150`](../../data/sql/turso/01-app.sql)). The webhook half is explicitly yours (*"NOTE: I
will handle the webhook part"*, [`docs/ideas/view-builder.md`](../ideas/view-builder.md)), so this plan
leaves a **seam**, not a stub: when a sender exists, it widens `channel`, lifts the 400, and starts
reading `target` — and no column changes for it.

---

## 8. Three things about the current server this page must be built around

### 8.1 The gate is checked by the *reads*, and it is a builder's flag

`assertEnabled()` guards **every** route in the domain, including the plain reads: `GET /api/views`
([`views.ts:856`](../../server/src/routes/views.ts)) and `GET /api/views/{id}`
([`:894`](../../server/src/routes/views.ts)). That is deliberate, and the route list's own comment
explains the reasoning — a screen that lists saved views but cannot run one is not partially available,
it is confusing.

That reasoning is right for the builder and wrong for this page. A **reader** surface that goes dark
whenever the **authoring** flag is off reads as a broken page, and it is what anybody would see if
`VIEW_BUILDER_ENABLED` is ever turned off — which it should be, since the flag's own refusal message
calls the domain **unauthenticated** and enabling it *"is a decision about who can reach the server at
all"*.

**Recommendation:** split the gate. Keep `VIEW_BUILDER_ENABLED` on `POST /api/views`,
`PATCH`/`DELETE /api/views/{id}` and `POST …/run`; let `GET /api/views`, `GET /api/views/{id}` and the
subscription reads answer without it. **Decision needed** (§13.3) — the cheap version is to drop
`assertEnabled()` from those three read handlers and nothing else.

★ Whatever is decided, the **off-state must name its cause** the way `ViewBuilder.tsx` does — not render
an empty table. A gate refusal and a fetch failure look identical in a list of rows.

### 8.2 `.env` describes behaviour the code does not have

[`.env:41`](../../.env) says of `VIEW_BUILDER_ENABLED`: *"Without this the screen has no rail leaf and
the routes are not registered."* Neither half is true: `registerViewBuilder(api)` is called
unconditionally ([`routes/index.ts`](../../server/src/routes/index.ts)) and the `View builder` leaf is
unconditional in `menu.ts` ([`:667`](../../app/src/nav/menu.ts)). The gate is a per-request 409, not an
absence.

Worth correcting in the same commit, because this page's gate decision (§8.1) rests on knowing which of
the two it is.

### 8.3 No route under `/api/views` checks a session, and the subscriber is therefore a label

`saved_view_subscription.subscriber` is a free-text string held together by
`UNIQUE (view_id, subscriber, channel)`, and `01-app.sql` records that the global app tables carry **no**
per-user foreign key. So **"Kevin is watching this" is a label, not an identity** — two people typing
the same name share one row, by design and silently.

The View Builder's deprecated control got this wrong twice: it *asked* for the name in a text box, and
it remembered it in `localStorage`, which is empty on any other browser.

This page does it the other way:

- the subscriber is **`currentOwner()`** ([`session.ts:284`](../../app/src/data/session.ts)) — the same
  function that fills `saved_view.created_by`, documented there as deliberately *a name, not an
  address*, because changing it would change what an existing row means;
- the page **shows** it rather than asking: *"You watch as **Kevin K.**"*;
- `sessionHeaders()` is sent on every call even though nothing checks it
  ([`session.ts:319`](../../app/src/data/session.ts)) — so the day `/api/views` starts requiring a
  session, the client is already telling it who is asking;
- and the screen says the limitation in one line, because it is a fact about the rows: *subscriptions
  are labelled by name, not owned by an account.*

---

## 9. The screen

### 9.1 Layout

```
Views                                              [ page-head + accent-rule ]
Saved queries you watch. 3 watching · 1 changed.   [ page-head sub ]

┌ panel ─────────────────────────────────────────────────────────────────────┐
│ Watch a view                                            panel__head         │
│ [ First fundings by combination   ▾ ]   [ SUBSCRIBE ]   [ note / refusal ]  │
└────────────────────────────────────────────────────────────────────────────┘

┌ panel ─────────────────────────────────────────────────────────────────────┐
│ Subscribed Views           3 watching                             panel__head│
│ View Name               │ Current │ When subscribed │ Last Change │         │
│ First fundings by comb… │  10     │  10             │ 21 Sep 2026 │  [🗑]   │
│ My View                 │  5      │  —              │ unchanged…  │  [🗑]   │
└────────────────────────────────────────────────────────────────────────────┘
```

Reuse: `.page-head`, `.accent-rule`, `.stack`, `.panel`, `.panel__head`, `table.data`
([`projects.css:104`](../../app/src/styles/projects.css) — used by `ViewBuilder.tsx:2129` as
`className="data vb-table"`), `.notice`, and `ErrorNotice`
([`ErrorNotice.tsx`](../../app/src/components/ErrorNotice.tsx)).

**New CSS is limited to what is genuinely new** — the inline `<select>` + button alignment and the
count column's right alignment. One stylesheet, `app/src/styles/savedviews.css`, imported in
`main.tsx` after `viewbuilder.css` ([`main.tsx:37`](../../app/src/main.tsx)).

### 9.2 The five states, and the two that must not be faked

| State | Render |
|---|---|
| loading | *"Reading subscriptions…"* — the phrasing `Pinned.tsx` uses, not a spinner |
| empty | *"Nothing is being watched yet. Pick a view above."* |
| **gate off** | the **named cause** — `VIEW_BUILDER_ENABLED=1` — never an empty table (§8.1) |
| fetch failed | `ErrorNotice` with the server's own message |
| rows | the table |

★ **Empty and switched-off are different sentences and must not share one.** This is the distinction
`Pinned.tsx` already draws between "Nothing pinned yet" and a load error, and the one the rail's badge
draws between `0` and `—`.

### 9.3 The panel, and ★ why it **previews** rather than runs

Clicking **View Name** opens a right-hand drawer — `.drawer` + `.drawer__head` + `.drawer__body`, plus
`ResizeGrip` and the `printPanel` handling, the same four pieces every other panel in this app uses.
Model it on a **local** drawer such as the ones in `Checks.tsx` or `FundingSearch.tsx`, not on
`DetailDrawer`, which is bound to the global store's selected *project*. Inside it: the view's result
grid, and the caveat copy from §6.2.

★ **The panel calls `POST /api/views/preview`, not `POST /api/views/{id}/run`, and the reason is not
cost — it is correctness.**

`runSavedView` records a history row unconditionally, and the fingerprint it records is **the value a
subscription is compared against**. So if opening the panel recorded a run, then:

1. **a reader could swallow a change** — the reader's own look advances the fingerprint, so the "last
   change" the table shows becomes *their own scroll*, and the change they came to look at is now the
   baseline;
2. **the table's own counts would chase the act of reading them**, because `Current Count` and
   `Last Change` are computed from runs the page itself generates;
3. **it would fail on a read-only target**, where a run is refused as a write and a preview is not.

The preview route takes the SQL in the body, so the panel needs `GET /api/views/{id}` first — two
requests, the second carrying SQL that came **from the server**, run under the same guards. That is the
price of not mutating history by looking at it.

★ The alternative — adding `record: false` to `POST /api/views/{id}/run` — would also have to be added
to `READ_ONLY_POSTS` in [`middleware.ts:60`](../../server/src/http/middleware.ts) by exact
method-and-path, because that guard runs *before* routing; the preview route is already in that set.

### 9.4 The one extraction

The result grid and the projection/formatting around it live inside `ViewBuilder.tsx` (~2,300 lines) and
are **not exported**. Two screens now need to render a view's result, so it moves once:

`app/src/components/ViewResultGrid.tsx` — the grid, the `—`-for-null rendering, the drift notices, the
truncation line, and the format dispatch. The View Builder keeps the editor and the column picker and
imports the grid.

★ The rules that must survive the move, because they are the ones that break silently: a null renders as
`—` and never `$0.00` (every helper in `format.ts` ends in `Number(n) || 0`); a truncated result says the
preview is capped and **invents no denominator**; and "not run yet" is never `0 rows`.

---

## 10. What breaks if this is built naïvely

A checklist, because every item is a plausible reading of the note as written.

1. Counting rounds from `saved_view_run.row_count` → `200` for a view of 4,812, with no sign it is a cap
   (§6.1).
2. Having the panel call `run` → the act of looking changes what is watched (§9.3).
3. A `Status` pill reading `Active` → a guarantee nothing delivers (§5.2).
4. A free-text subscriber field → two people with the same name silently share one row (§8.3).
5. Offering every view in `GET /api/views` → the dropdown lists drafts and views the button refuses
   (§3.2).
6. Leaving `localStorage['viewbuilder-subscriber']` behind → the control returns (§4.1).
7. Deriving `Last Change` from the newest run rather than the newest **differing** run → every run reads
   as a change.
8. Rendering `0` for a view that has never run → indistinguishable from "ran and found nothing", the
   exact confusion the schema's own comment documents on the nullable columns
   ([`01-app.sql:127`](../../data/sql/turso/01-app.sql)).
9. Naming the new endpoint `GET /api/views/subscriptions` without checking registration order —
   `toExpressPath` turns `/api/views/{id}` into `/api/views/:id`
   ([`api.ts:109`](../../server/src/http/api.ts)), which then **captures** it and 400s on
   `'subscriptions'` not being a number. **Declare the new route before `GET /api/views/{id}`**, or give
   it a path that cannot collide.
10. Adding `truncated` to `01-app.sql` only → every store built before today keeps the old shape, because
    `CREATE TABLE IF NOT EXISTS` is a no-op (§6.1).

---

## 11. Phases

### Phase 1 — the one missing query, and the capped count

| # | File | Change |
|---|---|---|
| 1 | `data/sql/turso/01-app.sql` | `truncated INTEGER` on `saved_view_run` (§6.1) |
| 2 | `server/src/db/app-schema.ts` | the same column in `COLUMN_ADDITIONS`, or an existing store keeps the old shape |
| 3 | `server/src/routes/views.ts` | `recordRun` writes `executed.truncated`; a subscriber-scoped list — `GET /api/views/subscriptions?subscriber=…`, **declared before `/api/views/{id}`** — returning view title/slug/status, the subscription's `id` and `created_at`, and the newest successful run plus the one before it (§5) |
| 4 | `server/src/routes/views.ts` | the gate decision from §8.1 |

No client work. Verifiable with the local Turso and `curl`.

### Phase 2 — the screen

| # | File | Change |
|---|---|---|
| 5 | `app/src/nav/menu.ts` | the `Views` leaf in Overview, after Pinned |
| 6 | `app/src/App.tsx` | `/views` in `SCREENS` — **same edit as 5** |
| 7 | `app/src/data/savedViews.ts` | new module: `useSubscribedViews()`, `subscribe()`, `unsubscribe()`, `useSubscribableViews()` |
| 8 | `app/src/routes/SavedViews.tsx` | the page, the subscribe row, the table, the states |
| 9 | `app/src/styles/savedviews.css` | the new styles only; import in `main.tsx` |

### Phase 3 — the panel

| # | File | Change |
|---|---|---|
| 10 | `app/src/components/ViewResultGrid.tsx` | extract from `ViewBuilder.tsx` |
| 11 | `app/src/routes/SavedViews.tsx` | the drawer, the preview call, the §6.2 caveat |
| 12 | — | the parameter rule from §3.3, with the sentence that says what is not listed |

### Phase 4 — deprecate the old control

| # | File | Change |
|---|---|---|
| 13 | `app/src/routes/ViewBuilder.tsx` | remove the button, `SubscribePanel`, `subscribe`/`unsubscribe`, `subscribeNote`, `Subscription`, and the `localStorage` key (§4.1) |
| 14 | `app/src/routes/ViewBuilder.tsx` | the fingerprint field's helper text points at `Views` (§4.2) |
| 15 | `.env` | correct the rail-leaf / routes comment (§8.2) |

**Order is load-bearing.** 1–4 before 5–9 (or the table has no endpoint), 5–9 before 13–15 (or there is
no subscribe control anywhere), and 13–15 in one commit (§4.3).

### Explicitly out of scope

Scheduling; delivery of any kind; webhook transport and `target`; widening `channel`; per-user
subscriptions; and requiring a session on `/api/views`. Each is a separate feature, and §7 lists them so
the empty Notifications heading is not mistaken for a promise.

---

## 12. Gates

Each is walkable, and each is a thing that can be *wrong* rather than a thing that can be *done*.

| # | Gate |
|---|---|
| G1 | `Views` leaf and `SCREENS` entry change in one commit; `/views` renders the page and not `Pending` |
| G2 | With `VIEW_BUILDER_ENABLED` unset, `/views` names `VIEW_BUILDER_ENABLED=1` — it does **not** render an empty table |
| G3 | A view whose result exceeds the cap renders `200+`, and `saved_view_run.truncated = 1` for that run |
| G4 | **Opening the panel adds no `saved_view_run` row.** Count rows for the view before and after |
| G5 | A view with no `display.fingerprint.key` cannot be selected in the dropdown |
| G6 | `webhook` is never offered, and the subscribe copy contains none of *notify*, *notification*, *alert* |
| G7 | A never-run view renders `—`, never `0` |
| G8 | Unsubscribe leaves zero `saved_view_subscription` rows for that pair, and the table's count drops by exactly one |
| G9 | Re-subscribing the same name returns the existing row and creates no second one |
| G10 | `cd server; npx tsc -p tsconfig.json --noEmit` and `cd app; npx tsc -p tsconfig.json --noEmit` both exit 0 |
| G11 | `/admin/views` no longer contains a Subscribe control **and** no longer reads `viewbuilder-subscriber` from `localStorage` |

★ G4 and G9 are the two a green typecheck cannot catch, and both are cheap to run by hand.

---

## 13. Decisions needed

| # | Question | Recommendation |
|---|---|---|
| 1 | Where does the page live? | Overview, immediately after `Pinned` (§3.1) |
| 2 | What does `Total Count` mean? | "now vs when you asked", **renamed** `Rows when subscribed` (§5.1) |
| 3 | Do the read routes stay behind `VIEW_BUILDER_ENABLED`? | **No** — drop `assertEnabled()` from the three reads (§8.1) |
| 4 | Does the panel record a run? | **No** — preview (§9.3) |
| 5 | Where does `subscriber` come from? | `currentOwner()`, shown and not asked for (§8.3) |
| 6 | Is a subscription per-user? | Not until `/api/views` requires a session; say so on screen (§8.3) |
| 7 | Parameter entry in phase 1? | Restrict the dropdown to all-defaults views, and state how many were withheld (§3.3) |
| 8 | Does `Status` show a delivery state? | **No** — watching state only (§5.2) |
| 9 | Lint for a missing `ORDER BY`? | Not in phase 1; state the caveat in the panel and decide later (§6.2) |
| 10 | A signed-out visitor? | The subscribe row is disabled with a link to `/sign-in`; a null owner must never become `null` in a row |

---

## 14. What I would do first

**Phase 1, items 1–3, before writing a line of the screen.**

Same reason `view-builder.md` §18 gives for its own first steps: the two things this feature will get
wrong are both invisible in the UI. A capped count that reads `200` looks exactly like a view of 200
rows, and an endpoint that does not exist turns into a design — usually an N+1 loop in a browser that
nobody notices until the eighth view. Build the column and the query, read both against a view that is
genuinely over the cap, and *then* draw the table.




