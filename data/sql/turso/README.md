# Turso / libSQL sample database

A **surrogate** Oracle EBS budget schema, not a replica. It is built from the shapes and the
value ranges described in [`db-schema.md`](../../oracle/db-schema.md) and the aggregates in
[`../json-output.json`](../json-output.json) — it is *not* a copy of the production instance,
and its row counts are illustrative, not authoritative.

Its purpose is to let the analysis SQL in [`../`](../) run somewhere the queries can actually be
executed, so the ports can be tested end to end.

---

## Files

| File | What it is |
|---|---|
| `00-schema.sql` | The DDL — **36 tables, 6 views**. Idempotent (`IF NOT EXISTS` throughout). |
| `01-app.sql` | **The app's own tables** — `saved_view`, `saved_view_run`, `saved_view_subscription`, `project`. Not part of the surrogate schema. See below. |
| `02-seed.sql` | Synthetic rows in the shape of the real data. Deterministic, not random. |
| `03-notes.sql` | Read-only diagnostic queries that describe what was seeded and how it maps back to the extract. |
| `build-manifest.json` | Counts written by the builder, so the seed can be checked without querying. |
| `sample.db` | The built local SQLite database. Generated — safe to delete and rebuild. |
| `queries/` | **The ported analysis SQL.** See below. |

### The object count, measured

`36 tables, 6 views` is what `sqlite_master` reports for `00-schema.sql` alone. The count was
`24 views` before section 5 of that file was retired: it used to define 18 `WCSEXP_*`
compatibility views, whose removal is what took the number to 6. The database as a whole
reports **41 tables** — the 36, the four app-side tables from `01-app.sql`, and
`sqlite_sequence`, which SQLite creates for the app tables' `AUTOINCREMENT` keys. Of those 41,
**36 are the Oracle surrogate** (the 35 base/report tables and `SAMPLE_DATA_PROVENANCE`) and the
other five belong to SQLite or to the application. Measured, not derived: gate **G19** asserts
the surrogate count is exactly 36.

---

## `01-app.sql` — the app's tables, not the surrogate's

`00-schema.sql` describes **Oracle**. `01-app.sql` describes **this application**: the saved
queries the View Builder authors, the history of the runs it performed, the subscriptions that
say who wants to be told when one changes, and the project master that names the account levels.

Keeping them in one file would be a category error, so they are in two. The rule is which side
the object belongs to:

| | `00-schema.sql` | `01-app.sql` |
|---|---|---|
| Describes | the ledger being read | the reader |
| Rebuilt by | `build-turso-sample.mjs` | applied lazily by the server at startup |
| Exists on Oracle | as if it were real | never |
| Checked by | `verify-turso-sample.mjs` (G13, G19) | excluded from G13, G19 |

### ★ The four app tables live in `sample.db`, and that is a real coupling

`DB_MODE=local` opens **this folder's `sample.db` directly** — the same file
`verify-turso-sample.mjs` inspects — because the local mode is the writable mode. It is the only
mode where the app's tables can be written at all: `turso` gates writes behind
`ALLOW_REMOTE_WRITES`, and `oracle` skips the app schema entirely.

So the first time anybody opens the View Builder against a local server, four tables appear in a
tracked binary that the builder script never creates. Nothing is corrupt — the tables are
additive and their DDL is idempotent — but **the verifier's result then depends on what the
server has been asked to do on that machine, not on what the repository contains.** A fresh
clone of `sample.db` has no app tables at all.

Two consequences, both deliberate:

- **G13 and G19 exclude the four tables by name.** `SAMPLE_DATA_PROVENANCE` answers "where did
  this row of the *Oracle surrogate* come from"; the app's tables have no such answer, and G19's
  table count is an assertion about the surrogate's shape. Listing the four names is the claim,
  so a fifth app table has to be added to that list on purpose.
- **`LOCAL_DB_PATH` moves the whole database, not just the app tables.** Setting it to a scratch
  copy is the way to develop without touching the verified file:
  `$env:LOCAL_DB_PATH='..\data\sql\turso\scratch.db'`. There is no separate app-side file;
  splitting one database into two clients is a larger change than the coupling currently costs.

### How it is applied, and what happens when it cannot be

**It is applied lazily, on the first request that needs it**, by
[`server/src/db/app-schema.ts`](../../../server/src/db/app-schema.ts) — memoised on success only,
so a failure is retried rather than cached.

**It is skipped entirely under `DB_MODE=oracle`.** The production connection has no business
creating app tables beside the ledger, so when the extract is the data source those endpoints
answer `503 DB_UNAVAILABLE` with a written sentence rather than by accident. That refusal names
*which* thing was asked for — "The project registry is stored in app-owned tables, which are
SQLite-only" — because a caller who asked for projects should not be told about saved views.

---

## `queries/` — the ported analysis SQL

The five files in [`../`](../) (`00-discover.sql` … `04-spend-and-actuals.sql`) are written for
Oracle. This folder holds their **SQLite / libSQL ports**, deliberately keeping the
**same filenames** so the mapping is 1:1 and machine-checkable:

| Oracle original | Port |
|---|---|
| `../00-discover.sql` | [`queries/00-discover.sql`](queries/00-discover.sql) |
| `../01-budgets.sql` | [`queries/01-budgets.sql`](queries/01-budgets.sql) |
| `../02-budget-adjustments.sql` | [`queries/02-budget-adjustments.sql`](queries/02-budget-adjustments.sql) |
| `../03-budget-changes.sql` | [`queries/03-budget-changes.sql`](queries/03-budget-changes.sql) |
| `../04-spend-and-actuals.sql` | [`queries/04-spend-and-actuals.sql`](queries/04-spend-and-actuals.sql) |

**The originals are frozen.** They remain the artefacts of record for the production instance.
Nothing in this folder modifies them, and they should not be edited to match this folder — the
port is what changes.

The ports are **read-only** (`SELECT` / `WITH` only), **1:1 in statement count** with their
originals (54 statements across the five of them), and preserve **every comment verbatim**,
including every section label (`A1.`, `B6.1`, `S3.3`, `H.2`, …) and every `-- Expect N`
assertion, because the other documents cross-reference them. Each ported file carries a
`PORT NOTES` header documenting every place the translation was not mechanical.

### The sixth file is not a port

[`queries/05-first-fundings.sql`](queries/05-first-fundings.sql) has **no `../05-*.sql`
original**, and there must not be one — the originals are frozen, and that query has no Oracle
form to port. It is analysis written directly against this schema for the View Builder — the
[original idea](../../../docs/ideas/view-builder.md), now implemented from the
[plan](../../../docs/plans/view-builder.md) — and it lives here because `queries/` is where the
runnable analysis SQL lives. Its header carries an `ORIGIN` section saying so, and it names the
Oracle spelling of each construct it uses at the site, so nothing has to be re-derived if it is
ever hand-ported.

### These files are also the View Builder's starting points

All six are offered in the app's View Builder as statements to begin from — each is split at the
semicolons and listed with its section labels. They are read with `import.meta.glob` and
**not** eagerly, so they cost the bundle nothing until the picker is opened; each becomes its own
chunk. See [`docs/plans/view-builder.md`](../../../docs/plans/view-builder.md) §10.5.

That is a reason to keep them runnable. A file listed in the picker that fails on the first
statement it offers is worse than no picker, and `turso-run.mjs` below is the check that keeps
them honest.

So the folder is **6 files / 56 statements**, of which **5 files / 54 statements are ports**.
The 1:1 table above covers those five, and only those five.

### Running them

```bash
node ../../scripts/turso-run.mjs            # local sample.db, splits and runs every statement
node ../../scripts/turso-run.mjs --remote   # the remote Turso database
node ../../scripts/turso-run.mjs 01-budgets.sql   # just one file
```

It reports each statement with its source line number and exits non-zero on any failure. Current
state: **56/56 statements execute, 0 failed, on both targets** (SQLite 3.45.1 on the local
sample, 3.47.0 on Turso).

The script sets `process.exitCode` rather than calling `process.exit()`. That is deliberate:
`@libsql/client`'s native module still has a worker thread signalling when `process.exit()`
tears the runtime down, and on Windows that aborts with
`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` (`uv_async.c:76`), exit code
`0xC0000409`. No SQL causes it — two `SELECT 1` statements against Turso reproduce it and ten do
not — but it would make a clean run report a failure by exit code, so it is avoided.

### `01-compat.sql` is not needed

An earlier plan called for a compatibility-shim file that renamed the `WCSEXP_*` objects into
something the queries could use. **It is unnecessary**, and for a reason that changed.

An earlier revision of this note said the shim was unnecessary because `00-schema.sql` defined
`WCSEXP_*` views over the real tables. Those views have since been **retired** — section 5 of
`00-schema.sql` is now a tombstone explaining why. The conclusion stands and is now stronger:
every query names the base tables directly, so the port needs only to **drop the `apps.` prefix**
— no object renaming, no shim, and nothing to keep in sync.

★ **Which `WCSEXP_*`?** The retirement above is about the **sample's ports** of those names, not
about Oracle's originals, which are live and granted. The two are different objects and only one
of them is gone, so a comment saying "the views were removed" and one saying "the views compute
it" can both be true. The distinction is load-bearing for `WCSEXP_PO_DISTRIBUTIONS` — a plain
pass-through in the sample, a *computed* column on Oracle — where a query repointed from one name
to the other is correct on exactly one of the two databases, and not the one it is tested on.
Measured on both: [`docs/implementation/wcsexp-view-names.md`](../../docs/implementation/wcsexp-view-names.md).

That retirement is also what removed the last reason to rename an object in the port. The three
places the extract's vocabulary differed from the tables are recorded as comments beside the
query that hits them rather than being papered over by a view:

| Extractor vocabulary | Base table column | Where |
|---|---|---|
| `SET_OF_BOOKS_ID` | `GL_BALANCES.LEDGER_ID` | `00-discover.sql`, `05-first-fundings.sql` |
| `DIST_CODE_COMBINATION_ID` | `AP_INVOICE_DISTRIBUTIONS_ALL.CODE_COMBINATION_ID` | `04-spend-and-actuals.sql` |
| `CHECK_DATE` | `AP_INVOICE_PAYMENTS_ALL.PAYMENT_DATE` | `04-spend-and-actuals.sql` |

Two columns the views synthesised as `NULL` — `POSTED_FLAG` on a distribution and
`PO_DISTRIBUTION_ID` on an AP invoice line — have no base-table counterpart at all.
`04-spend-and-actuals.sql` documents what replaces each in place.

---

## Translation rules used

| Oracle | SQLite | Note |
|---|---|---|
| `apps.` prefix | dropped | One schema — there is no owner to qualify with. |
| `NVL(a,b)` | `COALESCE(a,b)` | |
| `DECODE(x, k1,v1, …, default)` | `CASE x WHEN … THEN … ELSE … END` | |
| `TO_CHAR(<num>, 'FM999,…,990.00')` | `printf('%.2f', ROUND(<num>,2))` | **The thousands separator cannot be reproduced** — SQLite's `printf` has no grouping flag. Amounts print ungrouped (`4356078.25`). Rounding is preserved exactly. |
| `TO_CHAR(<date>, 'YYYY-MM')` / `'YYYY'` | `strftime('%Y-%m', …)` / `strftime('%Y', …)` | |
| `LPAD(<num>, 2, '0')` | `printf('%02d', <num>)` | |
| `TRUNC(SYSDATE)` / `SYSDATE` | `date('now')` / `datetime('now')` | |
| `FROM dual` | `FROM DUAL` | `DUAL` is a real view here. |
| `WHERE ROWNUM <= n` | `LIMIT n` | 6 sites. Each one wraps an *ordered* inline view, so the row set is identical — noted individually in the ports. |
| `ALL_TABLES` / `ALL_VIEWS` / `ALL_TAB_COLUMNS` | `pragma_table_list()` / `pragma_table_info('<T>')` | Function forms. Oracle-only columns (`OWNER`, `DATA_LENGTH`, `NULLABLE`, …) are **dropped rather than faked**. |
| `NULLS LAST`, `ROW_NUMBER() OVER`, `SUM() OVER (ORDER BY …)`, `\|\|`, `SUBSTR`, `INSTR`, `COUNT(DISTINCT)` | unchanged | Native on SQLite 3.45.1. |

### Two things worth knowing about the results

1. **Amounts are ungrouped** in the ported queries' output. That is a presentation difference
   only; the values are identical. Use `printf` formatting in the app layer if grouping is wanted.
2. **`00-discover.sql` section F was already broken on Oracle.** It asks `GL_BUDGET_VERSIONS` for
   `START_PERIOD_NAME` / `END_PERIOD_NAME` / `STATUS` / `DATE_CREATED`; stock EBS (and this
   surrogate) names those `FIRST_PERIOD_NAME` / `LAST_PERIOD_NAME` / `STATUS_CODE` /
   `CREATION_DATE`. The original's own comment says *"adjust the SELECT list below if they
   differ"*, so the port adjusted it. Section A.4 is the discovery query that proves which names
   exist.

---

## Verify

```bash
node ../../scripts/verify-turso-sample.mjs            # local
node ../../scripts/verify-turso-sample.mjs --remote   # remote
```

21 gates. **G18** is the one that protects this folder: it scrapes every `FROM` / `JOIN` target
out of both the Oracle originals and the ports, subtracts CTE names, and asserts every remaining
object resolves — naming any typo by file and line. It also fails if an Oracle-only dictionary
view (`ALL_TABLES`, `ALL_VIEWS`, …) survives into `queries/`. Current state: **21/21 passed,
15 distinct objects over 236 references in 11 files.**

**G13 and G19 skip the four app-owned tables.** They are created by the *server*, not by
`build-turso-sample.mjs`, and in `DB_MODE=local` they are created in this folder's `sample.db` —
so on a machine where the app has been run they are present and on a fresh clone they are not.
Excluding them by name is what keeps these gates about the surrogate rather than about runtime
history. See the app-tables section above.

---

## Rebuilding

```bash
node ../../scripts/build-turso-sample.mjs            # local only
node ../../scripts/build-turso-sample.mjs --remote   # also drops and rebuilds the remote database
```

The `--remote` run **drops** every table and view first, so it is destructive to the remote
database by design. Credentials come from `TURSO_DATABASE` / `TURSO_API_KEY`; the scripts read
them from `.env` directly. The variable is **`TURSO_API_KEY`** — that is what `turso-run.mjs`,
`build-turso-sample.mjs` and `verify-turso-sample.mjs` all read, and what `.env` defines. An
earlier revision of this page called it `TURSO_AUTH_TOKEN`; nothing reads that name.
**No application code reads either variable** — the app only reads `DB_MODE`.
