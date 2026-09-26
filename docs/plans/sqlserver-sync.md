# Copying the ledger and the app store into Azure SQL

**Status:** plan. Scope and shape decided (see §0); not started.
**Question this answers:** how to sync the most recent data into a SQL Server
database, how long 1,000,000 rows takes, and what switching `DB_MODE=sqlserver`
afterwards actually involves.

---

## 0. Decisions taken

These four answers fix the shape of the work. Everything below is written against
them.

| # | Question | Decision |
|---|---|---|
| 1 | **Scope** | **Fund 04, FY2022 → current** |
| 2 | **What SQL Server is** | **A cache.** Oracle remains the source of truth. |
| 3 | **The app store** | **Moves off Turso** — the 13 app-owned tables come with it |
| 4 | **Refresh** | **Daily sync.** Each day, check the tables for new fund-04 data and copy what is new. |

**What decision 2 buys, and what it costs.** Because SQL Server is a cache, the
partial-read gap in §3 stops being a correctness problem: a column Oracle cannot
serve is null in the cache too, and that is the honest answer rather than a
divergence between two sources of truth. It also means **the copy is disposable** —
it can be dropped and rebuilt, so a failed sync is an inconvenience rather than
data loss. The cost is that the cache must never be written to as if it were
authoritative, and the app must not treat a cache miss as an absence.

**What decision 4 forces.** A daily incremental sync needs a watermark, and the
watermark question is answered in §6 — it is the single most important open
technical item in this plan, because `GL_BALANCES` has **no readable timestamp
column** on this deployment.

---

## 1. The headline: 1,000,000 rows is not the unit of work

The question assumes 1M rows is the thing being copied. It is not, and the
measurements below are what make that clear.

**Measured on the live ledger (this session):**

| Object | Rows |
|---|---|
| `GL_BALANCES` | **157,150,828** |
| `GL_CODE_COMBINATIONS` | 1,300,594 |
| `PO_LINES_ALL` | 1,141,923 |
| `PO_DISTRIBUTIONS_ALL` | 1,159,998 |
| `PO_HEADERS_ALL` | 288,056 |
| `PO_VENDORS` | 79,685 |
| `GL_PERIODS` | 379 |
| `GL_BUDGET_VERSIONS` | 2 |
| `GL_LEDGERS` | 1 |

`GL_BALANCES` alone is **157× larger** than the 1M rows in the question. Any plan
that copies "the ledger" is a 160M-row plan, not a 1M-row plan.

**But the app does not read all of it.** It scopes to fund 04, and that population
is much smaller:

```
fund 04 in GL_BALANCES:  1999-2027, ~4.6M rows total
  2027 alone:              208,739 rows / 7,604 combinations
  2026 alone:              268,071 rows / 7,589 combinations
```

So the real choice is **which population**, and that decision is worth more than
any tuning of the copy itself.

---

## 2. How long 1,000,000 rows takes — measured, not estimated

I timed real fetches from the ledger at known widths. These are rows/sec **as
delivered by the Oracle driver into this process**, which is the first half of the
copy; the SQL Server insert is the second half.

| Population | Bytes/row | Rows/sec | **1M rows** |
|---|---|---|---|
| fund-04 `GL_BALANCES` | 902 | 1,412 | **11.8 min** |
| `PO_LINES_ALL` | 4,572 | 2,203 | **7.6 min** |
| `GL_CODE_COMBINATIONS` | 2,539 | 2,847 | **5.9 min** |

**Read the width column, not the row count.** `PO_LINES_ALL` moves 5× the bytes
per row of a balance row and finishes *faster* in rows/sec terms, because the cost
is bytes and round-trips, not rows. A 1M-row estimate that ignores width is wrong
by up to 5×.

**So: 1,000,000 rows is roughly 6–12 minutes of extraction**, before the insert.

### What the insert adds

The insert is the part I have **not** measured, because no SQL Server exists yet.
What is known:

- `mssql` is **not currently a dependency** (`server/package.json` has no
  `mssql`, `tedious`, or `sqlserver` entry). It would be a new dependency.
- Batching dominates. Row-by-row insert over a WAN is ~100× slower than batched;
  the practical shape is `bulk` (the `mssql` driver's bulk-load) or multi-row
  `INSERT` in batches of 1,000–10,000.
- The existing copy path (`server/scripts/copy-oracle-to-turso.ts`) is the
  precedent to follow: it already does Oracle → another store in batches.

**Estimate for the whole 1M-row copy, extraction plus insert: 15–30 minutes**,
with the wide table at the top of that range. That is an estimate for the insert
half only, and it should be replaced with a measurement on the first real table
before committing to a total.

### The network is not the constraint

9836 KB/sec on the widest table is ~10 MB/s, which is ordinary for a VPN. The
constraints are Oracle's read rate and the insert path.

---

## 2b. The decided scope, sized

**Fund 04, FY2022 → current (FY2027).** Measured per year, fund 04 only:

| Fiscal year | Rows | Combinations |
|---|---|---|
| 2022 | 227,714 | 6,750 |
| 2023 | 239,064 | 6,960 |
| 2024 | 247,386 | 7,159 |
| 2025 | 257,802 | 7,412 |
| 2026 | 268,071 | 7,589 |
| 2027 (current, part-year) | 208,739 | 7,604 |
| **Total** | **~1,448,776** | ~7,600 distinct |

**~1.45M balance rows.** At the measured 1,412 rows/sec that is **~17 minutes of
extraction**, or **~40–70 minutes including the insert** at the 2–4× allowance.

**★ BUT THE BALANCES ARE NOT THE WHOLE COPY.** The PO and COA tables carry no fund
column, so they cannot be scoped by fund 04 without a join:

| Table | Rows | Fund-scopable? |
|---|---|---|
| `GL_CODE_COMBINATIONS` | 1,300,594 | the fund lives here, so this is the scope's own table |
| `PO_LINES_ALL` | 1,141,923 | only via `PO_DISTRIBUTIONS_ALL.CODE_COMBINATION_ID` |
| `PO_DISTRIBUTIONS_ALL` | 1,159,998 | yes — it carries the combination |
| `PO_HEADERS_ALL` | 288,056 | only via its lines |
| `PO_VENDORS` | 79,685 | no — vendors are not fund-specific |

**So the honest total is ~4.0M rows if the PO side comes across whole, or ~1.9M if
it is scoped through the distributions.** That is the difference between roughly
**1.5–2.5 hours and 45–90 minutes**, and it is worth measuring the scoped PO count
before choosing.

**★ A CAUTION ON SCOPING THE PO SIDE.** The join is
`PO_DISTRIBUTIONS_ALL.CODE_COMBINATION_ID` → `GL_CODE_COMBINATIONS.SEGMENT1`, which
is exactly the shape of the AP link query that was silently leaking 5,174 rows
earlier in this session (5,358 returned against 184 correct). Scope it with a
`COUNT(*)` you have checked, not with a `WHERE` you have assumed.

### What a daily sync costs

This is the number that matters most for decision 4, and it is **not** the full
copy. See §6.

---

## 2c. The daily sync — and the watermark problem

**Decision 4 says: each day, check the tables for new fund-04 data and copy what
is new.** That is an *incremental* sync, and an incremental sync needs a column
that answers "which rows changed since yesterday".

**★ MEASURED: `GL_BALANCES` HAS NO READABLE TIMESTAMP COLUMN.** A query against
`ALL_TAB_COLUMNS` for `DATE`/`TIMESTAMP` columns on `GL_BALANCES` returned **zero
rows** on this deployment. So there is no `LAST_UPDATE_DATE` to compare against,
and the obvious daily-sync design — `WHERE last_update_date > :watermark` — **is
not available**.

This is the same class of gap as the partial reads in §3: the account can read the
table's *values* but not its *metadata*, so a column may exist in Oracle and simply
be invisible here. **Confirm with a DBA whether `GL_BALANCES` has an update
timestamp** before designing around its absence — that single answer decides
between the two designs below.

### Design A — if a timestamp exists (preferred)

```
WHERE last_update_date > :last_synced_at
```

Cheap, exact, and the daily job is minutes regardless of table size. Requires the
DBA answer above.

### Design B — if no timestamp exists (the fallback)

**Key on `PERIOD_YEAR` / `PERIOD_NUM`, and treat the sync as period-granular.**
This works because of how the ledger actually behaves:

- A closed period's rows do not change. Once FY2022's July is posted, its balances
  are stable — that is what a ledger means.
- Therefore the daily job only needs to re-read **the open period** (and the
  adjustment period, if one is open), plus any period whose row count has moved.
- The cheap detector is a **row count per `(period_year, period_num)`**, stored
  from the last sync. A period whose count changed is re-copied whole; a period
  whose count is unchanged is skipped.

**★ THE COUNT IS THE WATERMARK, AND IT IS A REAL MEASUREMENT.** A period that is
still open gains rows daily; a closed one does not. So the daily job is:

1. Read `COUNT(*)` per `(period_year, period_num)` for fund 04 — the same query
   that took 19 s earlier in this session.
2. Diff against the stored counts.
3. Re-copy only the periods whose count changed, replacing their rows.

**★ THIS IS A REPLACE, NOT AN APPEND, AND THAT IS DELIBERATE.** Periods are the
unit because a row can be *restated* (a correction changes an amount without
changing the row count), and an append-only sync would keep the old value forever.
Deleting the period's rows and re-inserting is idempotent, which is what makes the
job safe to re-run after a failure.

**The cost of Design B:** the daily job re-reads the open period, which is
~20–30k rows — **under a minute**. The full 1.45M-row copy is a *one-off backfill*,
not the daily cost.

### What the daily sync needs that does not exist yet

- **A watermark store.** `table_count_snapshot` exists in the app-owned set and is
  the natural home, but it currently snapshots table counts, not period counts.
- **A job runner.** There is no scheduler in this repo (the watch feature's own
  docs say so: *"there is no scheduler and no sender on this server"*). The daily
  job is therefore an external trigger — a GitHub Actions schedule, an Azure
  Function timer, or `az containerapp job` — calling a script.
- **A delete-then-insert path per period,** which is a *write* to SQL Server and
  must not be reachable from the read-only API surface.

---

## 3. What "all READ tables from Oracle" means concretely

The API serves 55 tables. The ones the app actually reads, with the divergence
caveats already recorded in `db/ledger-shape.ts`:

| Table | Readable? | Note |
|---|---|---|
| `GL_BALANCES` | yes | a **view** (`GL.GL_BALANCES#`), 157M rows |
| `GL_CODE_COMBINATIONS` | yes | |
| `GL_LEDGERS`, `GL_PERIODS` | yes | tiny |
| `PO_VENDORS`, `PO_HEADERS_ALL`, `PO_LINES_ALL`, `PO_DISTRIBUTIONS_ALL` | yes | |
| `AP_INVOICES_ALL` | yes | 2.5M rows |
| `GL_BUDGET_VERSIONS` | **partially** | 5 declared columns have no readable source; served as null |
| `GL_BUDGET_TYPES` | **partially** | 2 declared columns have no readable source |
| `GL_BUDGET_ASSIGNMENTS` | **partially** | 3 declared columns have no readable source |

**★ The partial reads, and why decision 2 resolves them.** The account cannot read
those columns on this deployment (`db/ledger-shape.ts` records it, and the API
discloses it per response). Copying the tables copies the *nulls*, so the cache
inherits the gap.

**Because SQL Server is a cache of Oracle (§0), that is now the correct answer
rather than a problem.** A cache that says null where its source says null is
faithful. The two things that follow from it:

- **The cache must never be written to as if authoritative.** A null in the cache
  means "Oracle did not give us this", not "this is empty". A screen that treats
  the two as the same will be wrong in a way the cache cannot detect.
- **If a DBA later grants the missing columns, the cache needs a re-backfill** —
  those columns will stay null until the affected tables are copied again. Worth
  noting in the sync job's output rather than discovering later.

**The scope is decided** (§0): fund 04, FY2022 → current. Sized in §2b.

---

## 4. The app store moves off Turso

**Decision 3.** The app-owned tables — 13 of them, all in
`data/sql/turso/01-app.sql` — come to SQL Server with the ledger:

```
saved_view             saved_view_run         saved_view_subscription
project                organization           app_user
user_pin               geo_origin             vendor_site_geo
vendor_site_route      field_override         ledger_read_cap
table_count_snapshot
```

These are **small** — the sample is 1.4 MB total. The copy is trivial; the
problems are not size:

- **`01-app.sql` is SQLite DDL.** `AUTOINCREMENT`, `datetime('now')`, `CHECK`.
  It cannot be applied to SQL Server. **A second DDL file is needed**, and
  `db/app-schema.ts` currently *refuses* a non-SQLite app store by design
  (`if (store.dialect !== 'sqlite')` → error, with a message naming the store and
  its dialect). That guard is the gate to revisit — it is not a bug, it is a
  deliberate refusal that the new dialect invalidates.
- **`saved_view_subscription` is not recreatable.** Nothing records who watched
  what except these rows. Copy them, do not regenerate them.
- **`vendor_site_geo` / `vendor_site_route` are expensive to recreate** — the
  geocoding and 622 stored routes. Same: copy, do not rebuild.
- **★ THE APP STORE IS A DIFFERENT KIND OF DATA FROM THE LEDGER.** The ledger half
  is a *cache* (decision 2) and can be dropped and rebuilt at will. The app store
  is **not** — `saved_view_subscription` and the geocoded routes exist nowhere
  else. So the "cache" framing covers the ledger copy only, and the app-store
  migration needs a backup and a verification step that the ledger copy does not.
- **★ `sample.db` IS TRACKED IN GIT AND A REBUILD DROPS EVERY TABLE.** The `.env`
  says so in capitals, and it happened earlier in this session: rebuilding the
  sample erased the saved views and organizations, and view 74 became view 1. Once
  the app store moves to SQL Server, `build-turso-sample.mjs` stops being the
  thing that owns those rows — but until then, **any sample rebuild destroys the
  app data that decision 3 says must be preserved.** Take the copy before the next
  rebuild, not after.

---

## 5. What switching `DB_MODE=sqlserver` actually involves

**This is the part that is much larger than it looks.** `DB_MODE` is not a
connection string; it is a mode that selects a *driver*, and the driver interface
is a two-member union.

```ts
// server/src/db/driver.ts
export interface SqlDriver {
  readonly dialect: 'sqlite' | 'oracle';   // ← two members
```

```ts
// server/src/config/env.ts
export const DB_MODES = ['local', 'turso', 'oracle'] as const;  // ← three modes
```

`'sqlserver'` is in **neither**. Adding it means:

| File | What changes |
|---|---|
| `db/driver.ts` | `dialect` union gains `'sqlserver'`; a `createMssqlDriver()` |
| `config/env.ts` | `DB_MODES` gains `'sqlserver'`; connection settings; `resolveAppDb` |
| `db/client.ts` | a third driver branch |
| `db/hybrid.ts` | routing + the `dialect` property |
| `db/query-guard.ts` | `DIALECT_RULES` for T-SQL; `analyzeSql` signature |
| `db/read-cap.ts` | `applyReadCap` per dialect — SQL Server uses `TOP`/`OFFSET`, not `LIMIT`/`ROWNUM` |
| `db/ledger-shape.ts` | divergence resolution per dialect |
| `db/app-schema.ts` | the `dialect !== 'sqlite'` refusal |
| `db/derived.ts`, `db/sql.ts` | dialect-specific SQL |
| `routes/meta.ts` | the OpenAPI enum (derives from `DB_MODES`) |

**Two things make this more than mechanical:**

1. **The View Builder's dialect guard.** `query-guard.ts` refuses Oracle-isms on
   the SQLite path and vice versa. T-SQL has its own vocabulary (`TOP`, `+` for
   concatenation, `ISNULL`, no `LIMIT`). Every saved view becomes a statement that
   must parse on the new dialect, or be refused with a message saying why.

2. **`||` is the concatenation operator on both current engines.** The
   first-fundings view builds its key with `||`. **T-SQL has no `||`** — it uses
   `+`. So at minimum that view needs a dialect-aware rewrite, and the same is
   true of anything else composing strings.

**A cheaper alternative worth considering:** keep `DB_MODE=oracle` and point only
the **app store** at SQL Server via `APP_DB_URL`. That is the seam that already
exists for exactly this purpose — but note it currently requires the app store to
be SQLite, and the ledger account is read-only with no `CREATE TABLE` privilege
(measured: `CREATE SESSION` only, 0 objects, 0 quotas), so the app tables would
need creating by someone else.

---

## 6. Suggested sequence

Each step is independently verifiable, and the copy is proven on a small table
before any large one is attempted. Steps 1–2 are **done** (§0).

1. ~~**Decide the scope**~~ — **done: fund 04, FY2022 → current.**
2. ~~**Decide what SQL Server is**~~ — **done: a cache of Oracle.**
3. **★ ASK THE DBA WHETHER `GL_BALANCES` HAS AN UPDATE TIMESTAMP.** This is the
   highest-value question in the plan and it costs one email. It decides between
   Design A and Design B in §2c, and therefore whether the daily sync is a
   `WHERE` clause or a period-diff.
4. **Measure the fund-scoped PO count** (§2b). Decides ~1.9M rows against ~4.0M,
   and therefore ~45 min against ~2.5 hours.
5. **Take a backup of the app store before anything else.** `saved_view_subscription`
   and the geocoded routes exist nowhere else, and a sample rebuild destroys them.
6. **Create the SQL Server database**, plus a T-SQL DDL file for the 13 app tables.
7. **Add the `mssql` dependency** and a `createMssqlDriver()` behind the existing
   `SqlDriver` interface.
8. **Prove the copy on `GL_PERIODS` (379 rows).** Small enough to eyeball, real
   enough to exercise the whole path.
9. **Measure the insert rate**, then re-derive the §2 estimate from it.
10. **Copy the app tables from Turso** (small; before the ledger, so a failure
    costs nothing).
11. **Backfill the ledger scope** (§2b), table by table, largest last.
12. **Build the daily sync** (§2c) — watermark store, period-diff, replace-per-period.
13. **Add `'sqlserver'` to `DB_MODES`** and the dialect rules.
14. **Switch `DB_MODE=sqlserver`** and run the smoke suite.

**Do not do step 13 before step 8.** The mode switch is the thing that makes the
whole app depend on the new dialect; proving the copy first means a copy bug and a
dialect bug are never debugged at the same time.

**Do not do step 12 before step 11.** An incremental sync built on top of an
incomplete backfill will report "nothing new" forever, because the watermark will
already be past the rows that were never copied.

---

## 7. Open questions

Three of the four are now answered (§0). What remains:

- **★ Does `GL_BALANCES` have an update timestamp Oracle is not showing us?**
  Measured: **0 date/timestamp columns visible** to this account. The account can
  read the table's values but not its metadata, so a column may exist and simply be
  invisible here. This single answer decides the daily-sync design (§2c), and it is
  the only question that blocks step 12.
- **Is the PO side fund-scoped or whole?** (§2b) — ~1.9M rows against ~4.0M.
- **What triggers the daily job?** There is no scheduler in this repo. The options
  are a GitHub Actions schedule, an Azure Function timer, or a container job —
  and the choice interacts with where the SQL Server credentials live.

**No longer open:** scope (fund 04, FY2022+), the cache-vs-source question (cache),
and whether the app store moves (it does).
