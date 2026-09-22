# `server/` — the API

An Express 5 + TypeScript (ESM) service over the Oracle extract, with a libSQL/SQLite
sample beside it so the analysis SQL can be run somewhere it is safe to run.

```bash
npm run dev        # tsx watch, http://127.0.0.1:5181
npm run build      # tsc -b
npm run start      # node dist/index.js
npm run smoke      # the gate suite — 74 checks
```

`HOST` defaults to `127.0.0.1` and `PORT` to `5181`. `DB_MODE` picks the data source:
`local` (the sample database, writable) · `turso` (remote, writes gated by
`ALLOW_REMOTE_WRITES`) · `oracle` (the real ledger — **app-owned tables are skipped**, so
`/api/views*` answers `503 DB_UNAVAILABLE` while everything read-only keeps working).

This file covers the **View Builder** domain, because it is the one domain that runs text a
person typed. Everything else is table-shaped and is best read from the live OpenAPI document —
Swagger UI at `/api/docs`, the spec itself at `/api/docs.json` — which is generated from the Zod
schemas, so it cannot drift from the code.

---

## 1. The `views` domain

`registerViewBuilder(api)` in [`src/routes/views.ts`](src/routes/views.ts). Eleven routes, all
tagged `Admin`, all under `/api/views`:

| Method | Path | `operationId` | What it does |
|---|---|---|---|
| `POST` | `/api/views/preview` | `views_preview` | Run ad-hoc SQL. **Writes nothing** but a run row. |
| `GET` | `/api/views` | `views_list` | List saved views. |
| `POST` | `/api/views` | `views_create` | Save a view, validating its declaration. |
| `GET` | `/api/views/{id}` | `views_detail` | One saved view. |
| `PATCH` | `/api/views/{id}` | `views_update` | Rename, re-SQL, re-declare, re-display. |
| `DELETE` | `/api/views/{id}` | `views_delete` | Remove it. |
| `POST` | `/api/views/{id}/run` | `views_run` | Run a **saved** view against stored parameter values. |
| `GET` | `/api/views/{id}/runs` | `views_runs` | Run history — what it returned and how long it took. |
| `GET` | `/api/views/{id}/subscriptions` | `views_subscriptions_list` | Who wants telling. |
| `POST` | `/api/views/{id}/subscriptions` | `views_subscribe` | Add a subscriber. |
| `DELETE` | `/api/views/{id}/subscriptions/{subscriptionId}` | `views_unsubscribe` | Remove one. |

**`preview` and `run` are two routes on purpose.** They look alike and behave differently, and
the difference is what gets recorded. `preview` executes SQL that was never validated — it is the
editor's Run button, and its whole job is to let you see what your text does *before* you commit
to it. `run` executes a view that passed validation on save, with parameter values substituted
through the declared types, and it is the only one of the two that records a run belonging to a
view. Collapsing them would mean either validating on every keystroke-driven preview, or running
unvalidated SQL under a saved view's name.

**Validation happens on write, not on run.** `views_create` and `views_update` are where the SQL
is analyzed, the parameters are reconciled against the declared list, and the display is checked
for columns the statement does not return. A run assumes all of that already holds — which is why
a saved view can be run without the guard re-deriving a verdict it has already issued. The one
thing a run *does* re-check is the row cap, because that is a property of the result, not of the
text.

### Error codes the screen reads

| Code | Status | When |
|---|---|---|
| `UNDECLARED_PARAM` | 400 | SQL uses `:token` with no declaration. `details: {token, declared}` |
| `MISSING_PARAM_VALUE` | 400 | A declared parameter was not given. `details: {param, type}` |
| `PARAM_TYPE` | 400 | A value does not fit its declared type. `details: {param, type}` |
| `TIMEOUT` | 400 | Statement exceeded `VIEW_BUILDER_TIMEOUT_MS`. `details: {statement}` |
| `EMPTY_UPDATE` | 400 | `PATCH` with no fields. |
| `NO_FINGERPRINT_KEY` | 409 | The display can't be reconciled — no column to key on. |
| `CHANNEL_NOT_IMPLEMENTED` | 400 | A subscription channel that has no sender yet. |
| `WRITES_DISABLED` | 409 | The whole domain is switched off (`VIEW_BUILDER_ENABLED` unset), **or** the target refuses writes. The caller cannot fix either by changing the request, which is why they share a code. |
| `DB_UNAVAILABLE` | 503 | No database, or the app tables cannot be applied. |

The guard's own findings are returned as **`findings`**, not as errors: a rejected statement gets a
message that names the line, the token, and what to do about it. A dialect mismatch is reported as
a fix, not as a failure — *"The sample database is SQLite, not Oracle"* — because the SQL is not
wrong, the target is.

---

## 2. The guard

[`src/db/query-guard.ts`](src/db/query-guard.ts) — **no imports, pure, and unit-testable without a
database.** That is deliberate: it is the part that has to be right, so it is the part with no
dependencies to work around.

| Layer | What it is | Honest strength |
|---|---|---|
| 1. The token | A read-only scoped token for the query path | **The only layer that cannot be bypassed.** A dashboard setting, not code |
| 2. `prepare()`, never `exec()` | `exec()` runs smuggled statements; `prepare()` compiles only the first | Strong, and free |
| 3. Statement allowlist | Single statement; first token ∈ `{SELECT, WITH}`; `ATTACH`/`DETACH`/`PRAGMA`/`load_extension` and every write verb denied | Required — **the driver does not refuse writes on its own** |
| 4. `PRAGMA query_only = ON` | Blocks table and temp writes | Real locally. **Does not cover `ATTACH`**, and has no session affinity over remote HTTP — treat as local-only |
| 5. Reject `;` outright | The second statement is dropped **silently** by the driver | Not security — a UX guard, so half of what you typed is never quietly discarded |

Layers 3–5 are in `analyzeSql` / `dialectFindings` / `capResult`. Two details that are load-bearing:

- **Masking comes before scanning.** `maskLiterals` and `maskComments` run first, so a denied keyword
  inside a string literal (`WHERE note = 'DROP'`) or inside a comment does not false-positive. The
  masks are length-preserving, so every offset reported back to the user still points at their line.
- **The row cap fetches `n+1`.** `wrapForRowCap` emits `LIMIT n+1` (SQLite) or `WHERE ROWNUM <= n+1`
  (Oracle) precisely so truncation can be **detected** rather than assumed — which is also why no
  `COUNT` is ever issued before a `SELECT`: a count doubles the cost of every preview to learn
  something the extra row already told us.

### ⚠ The timeout does not bound a local statement

`withTimeout` races the execute call against a `setTimeout`. That works over remote HTTP. **In local
mode it does not work at all**, because `@libsql/client`'s `file:` driver runs the statement inside a
synchronous native call that blocks Node's event loop — so the timer callback cannot run until the
statement has already returned. Measured: the statement won in 2686 ms, the timer never fired, wall
time 2688 ms. Semantics were left exactly as the plan specified; what changed is the claim. The
timeout is a real cap on a networked database and a **no-op on a local file**. Smoke gate **V11**
asserts the dialect in play so this can never quietly become a false claim.

The same section of the plan warns that the abandoned promise needs `.catch(() => {})` attached
immediately, or a late rejection becomes an unhandled exception that takes the process with it. That
is done.

---

## 3. The posture, stated plainly

**This server now has authentication, and almost nothing requires it.** `POST /api/auth/sign-in`
and `GET /api/auth/session` exist, sessions travel in the `x-app-session` header, and
`src/auth/guard.ts` exposes `requireActor` / `requireSuperAdmin`. **Two domains call them**: the two
auth routes, and every route under `/api/organizations`, which additionally requires the
`super_admin` role. Everything else — the entire ledger surface, the View Builder, the project
registry — is **still unauthenticated**, deliberately, for the same reason it always was: the
extract is read-only public data. There is no auth middleware, on purpose; admission is a function
each handler calls, so a route that never asks about identity never pays for the lookup.

There is now a `users` table (`app_user`), but session validity was never the reason the View
Builder was risky.

So the honest description of the run endpoint is still **"admin-only by intent, unauthenticated in
fact."** The View Builder multiplies that: a view is a **data-exposure object** — sharing one shares
whatever it reads, and there is no row-level security anywhere in this stack. A session would not
change that; `/api/views/{id}/run` does not check one and is not meant to.

What that implies, all of it cheap:

- **Keep `HOST=127.0.0.1`** (the default). Do not expose `/api/views/{id}/run` on a public origin
  until auth lands.
- **`VIEW_BUILDER_ENABLED` defaults to `false`.** The capability is gated in the same spirit as
  `ALLOW_REMOTE_WRITES`: the choice to build an editor does not imply the right to point it at a
  production ledger on the strength of a typo. With it off **every route in this domain answers
  `409 WRITES_DISABLED`** — the whole domain, not just the executing endpoints, because a screen
  that lists saved views but cannot run one is not a partial feature, it is a confusing one. The
  rest of the API is unaffected.

| Variable | Default | Meaning |
|---|---|---|
| `VIEW_BUILDER_ENABLED` | `false` | The whole domain. Off means `409 WRITES_DISABLED` on every route. |
| `VIEW_BUILDER_MAX_ROWS` | `200` | Row cap. One extra row is fetched to detect truncation. |
| `VIEW_BUILDER_TIMEOUT_MS` | `5000` | Statement timeout. See the caveat above. |
| `VIEW_BUILDER_MAX_BYTES` | `524288` | Response ceiling. Protects the browser, not the database. |

All four are reported by `GET /api/meta/config` under `viewBuilder`, so a client can tell what it is
talking to rather than guessing.

---

## 4. The app's own tables

`data/sql/turso/01-app.sql` — `saved_view`, `saved_view_run`, `saved_view_subscription`. Applied
lazily on first use by [`src/db/app-schema.ts`](src/db/app-schema.ts), memoised **on success only**
so a failure is retried rather than cached, and **skipped entirely under `DB_MODE=oracle`** — the
production connection has no business creating app tables beside the ledger. When it is skipped, the
endpoints it backs answer `503 DB_UNAVAILABLE` by design, while preview keeps working.

The three tables are why this domain could not be built as a `registerXxx(api)` resource: nothing
about a saved view is table-shaped, its SQL is text, and its behaviour depends on a guard that has to
run *before* the database is involved at all.
