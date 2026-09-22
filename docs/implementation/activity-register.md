# The activity register — implementation

**Status:** implemented, verified in the browser against the live configuration (`DB_MODE=oracle`).
All three routes answer; the page renders 48 objects with real counts.
**Date:** 2026-09-19.

---

## 1. What was broken

The Activity page has three routes, and all three failed:

| route | before | after |
| --- | --- | --- |
| `GET /api/activity` | 500 | **200**, 48 objects, 0 uncounted |
| `GET /api/activity/today` | 500 | **200** |
| `POST /api/activity/snapshot` | 500 | **201**, `written: 48, failed: []` |

Two **independent** defects were stacked on top of each other. The first one *hid* the second:
a blanket refusal is the only thing that was keeping the 500 out of sight.

---

## 2. Defect 1 — a refusal about the wrong database

`activity.ts` answered `AppError(503, 'DB_UNAVAILABLE', …)` whenever
`dbStatus().mode === 'oracle'`.

That is a statement about the **ledger**. But every statement this feature issues is addressed
to the **app store**, and under the live configuration those are two different databases:

| store | under `DB_MODE=oracle`, `APP_DB_URL` unset | holds |
| --- | --- | --- |
| **ledger** | Oracle, `POWERAPPS@europa.wcpss.net:1541/ebs_FA2DB` | the extracted `WCSEXP_*` / EBS views |
| **app** | `data/sql/turso/sample.db` (local SQLite) | `table_count_snapshot` — the only table this feature writes |

So the mode of one store was used to refuse a request served entirely by the other. Proven
with a throwaway probe that asked **both** stores the same questions, with the ledger as the
control (`server/tmp-activity-store.ts`, output `server/tmp-activity-store.out.txt`):

- ledger — `ORA-00942` (correct: the app's table is not there);
- app store — `sqlite_master` 49 rows, `pragma_table_info` 382, `SELECT date(?)` → `2026-09-19`,
  `table_count_snapshot` 92 rows, `ensureAppSchema()` ready.

**Fix.** The refusal is now keyed on the dialect of the store that *answers*, in one place
(`requireSqliteCatalogue()`), and the response publishes which store it read so the page can
say so (`ActivitySource` → `source` in the payload, rendered by `RegisterSource`).

---

## 3. Defect 2 — two silent mis-routings

`routeStatement()` classifies a statement by the table names in it, and falls back to the
**ledger** when it recognises none:

> *A statement that names nothing registered goes to the ledger. It has to go somewhere, and
> the ledger is the primary store.*

That rule is correct for DDL, pragmas and connection checks. It fails for **any statement whose
object is chosen at runtime**, and this file builds two kinds of those.

### 2a. Bare clock statements → Oracle

`SELECT date('now','localtime') AS d`, `SELECT date(:d) AS ok` and
`SELECT … datetime('now') AS now` name no table at all, so all three went to **Oracle**, which
has no `date()`:

```
ORA-00936: missing expression        errorNum 936, offset 7
oracle.ts:651 ← sql.ts:26 ← activity.ts (the /api/activity/today handler)
```

`offset 7` is the character after `SELECT` — the function it could not name. Reproduced in
isolation by `server/tmp-activity-throw.ts` (output `server/tmp-activity-throw.out.txt`), which
runs the same statement against each store in turn. These statements had **never once executed**
under `DB_MODE=oracle`: the 503 threw first, every time.
*Removing a false refusal is how you find out whether anything behind it ever worked.*

### 2b. Runtime table names → Oracle

`measure()` builds ``FROM "<name read out of sqlite_master>"``. The register lists 41 extract
objects, and names such as `AP_INVOICES_ALL` are registered **nowhere** in `store.ts`, so they
matched nothing, fell to the same ledger default, and asked Oracle to count a table that exists
only as a copy in the sample. `IFNULL` and `date()` are not Oracle functions, so each statement
died — and `measure()`'s bare `catch`, written to tolerate a view depending on an absent object,
turned every one of them into *"cannot be counted"*.

**The signature is the tell, and it is unmistakable:**

```
40 objects reported rowCount: null
 1 object  (X_REPORT_FUNDING_LINES) came back correct — because it IS registered
```

A failure that correlates perfectly with one variable is not a data problem.

### The fix

One helper, `appRows<T>()`, issues every read against the store the catalogue came from:

```ts
async function appRows<T>(sql: string, args: Binds = {}): Promise<T[]> {
  const res = await storeDriver('app').execute({ sql, args });
  return res.rows as T[];
}
```

Four call sites switched from the routed `rows()` to it: the date round-trip, the snapshot's
clock, `/api/activity/today`, and `measure()`'s read.

`measure()` now **returns** its failure instead of swallowing it, and `activityFor()` collects
them and warns once per register build:

```ts
if (unreadable.length > 0) {
  console.warn(
    `[activity] ${unreadable.length} of ${objects.length} objects could not be counted from the app store:`,
    unreadable.map((u) => `${u.name}: ${u.error}`).join(' | '),
  );
}
```

★ A `catch` written for one honest reason will absorb a different, dishonest one. Tolerating a
failure is fine; **tolerating it silently is how it lives for the whole life of a feature.**

---

## 4. Why the registry was *not* edited

The tempting fix is to add the 41 extract names to `store.ts`'s `APP_EXTRACT_TABLES` so the
router sends them to the app store by name. It was rejected, for three reasons:

1. **The register already carries three different meanings of "app"**, and conflating them
   would force `ActivityTable.owner` into an absurd `'app' | 'app'`:
   - `owner: 'app'` — a presentation fact: this object is one of the **7** tables the app owns
     (`isAppTable`), as opposed to the ledger's extract;
   - the store whose **catalogue** listed the object (where the list came from);
   - the store holding the **data** (where the count came from).
2. It would change the **dictionary**, the **relationship map** and the **smoke suite's
   set-equality checks** — all to fix one page.
3. Declaring *by name* that a table lives where a *file* decides it lives recreates exactly the
   class of silent wrong answer the registry exists to prevent.

An `owner` label is a presentation fact. It is not a store identifier.

---

## 5. What the page shows now

Measured from the live configuration (not recalled):

```json
summary: { "tables": 48, "app": 7, "dated": 10, "undated": 31, "total": 56 }
snapshot: { "latest": "2026-09-19", "read": 48, "comparable": 44, "moved": 2, "recorded": 48, "failed": [] }
source:   { "store": "app", "label": "data/sql/turso/sample.db", "dialect": "sqlite",
            "ledgerLabel": "POWERAPPS@europa.wcpss.net:1541/ebs_FA2DB", "sharedWithLedger": false }
```

- `rowCount: null` on **0 of 48** objects (was **40**).
- states `dated=10, undated=31, app=7` (was `dated=1, undated=40, app=7`).
- `unanswerable` names **31** objects — the tables the extract carries no change timestamp for,
  which read *"cannot say"* rather than `0`. A zero there would mean *nothing changed*, which
  is not what the extract knows.
- `skipped`: one, `SAMPLE_DATA_PROVENANCE` — bookkeeping for the sample build, not ledger data.

### Browser pass (whole round trip, since a server-tested feature is not a tested feature)

`docs/screenshots/activity-register-light.png` / `-dark.png` — the top of the register in both
themes. Visible in both: the **Source** note naming `sample.db` against the ledger, the **Scope
not applied** note, the panel head *"Activity for Saturday, September 19, 2026 — this is the
server's today"*, the date control, the three tabs, and real counts (`0 rows`, not a blank)
against every object.

- register renders **48** rows, `Table / Count / Activity / Details`, **no**
  `"The activity register could not be read."`;
- the `Source` note names `data/sql/turso/sample.db` **and** the ledger, and says the EBS-shaped
  rows below are that store's *copies*;
- `PO_HEADERS_ALL` reads **749** rows — the decisive figure, `null` before the fix;
- date driven to **2026-08-06** through the page's own date input: title moves to
  *"Activity for Thursday, August 6, 2026"*, `PO_HEADERS_ALL` shows **2 created / 2 approved**,
  tabs read `Created 1 / Updated 0`, and the comparison note honestly says *"No row counts have
  been recorded yet… the first reading is taken when the register is opened on the current
  date"* instead of inventing a zero;
- **Record counts now** → *"48 readings recorded for 2026-09-19."*

★ **Today's `created`/`updated`/`total` are not stable while the register is being read.**
`GET /api/activity` records today's readings as it reads them (that is the design — a count has
to be taken on the day it describes or it is gone), so **a read is a write**: every page load
upserts 48 rows into `table_count_snapshot`, and today's write totals therefore include the
register's own traffic. Measured across two calls a few minutes apart with the page open:
`created` read **70** and later **54**. The rail badge and the panel always agree because both
come from the server (`/api/activity/today` against `/api/activity`), but a figure read before a
page load and one read after are legitimately different numbers.

The likely cause of a *decrease* is that `recordReadings` **replaces** the day's rows (delete the
day, then insert 48) rather than merging them, so two overlapping reads can each remove rows the
other had just counted. **That mechanism is not proven** — what is measured is only that the
number moved by 16 over two calls. Treat "today's total" as informational, not as a ledger
figure, and do not assert an exact value for it in a test.

---

## 6. Found on the way, deliberately left alone

**The page ignores a `date` query parameter.** `Activity.tsx` reads no search params, so
`/activity?date=2026-08-06` silently shows **today** — the date lives in component state and is
driven by the date input and the ‹ › buttons. Nothing in the app links to `/activity` with a
query string (grepped: no hits), so this is a missing feature rather than a broken link — but a
reader following a hand-written URL will be shown a different day than they asked for and will
have no way to tell. Worth wiring up if any page ever wants to link into the register at a date.

**`capturedAt` is UTC while `snapshot_date` is local.** `snapshot_date` is written from
`date('now','localtime')` (deliberately — the reader's day is the local day), but `captured_at`
is written by `datetime('now')`, which SQLite evaluates in **UTC**, so the two disagree by the
zone offset and, near midnight, by a whole day:

```
date: "2026-09-19"      capturedAt: "2026-09-20 01:02:38"      (local time 2026-09-19 21:02, UTC-04:00)
```

The DDL default in `data/sql/turso/01-app.sql` is `DEFAULT (datetime('now'))` — the **local-wall-clock
reading in the comment above `today()` is wrong**: `datetime('now')` is UTC. Nothing computed
from these two is wrong today (the count comparisons key on `snapshot_date`), but the drawer
renders `read at 2026-09-20 …` under a page headed 2026-09-19, which reads as a snapshot taken
tomorrow. Left as-is because changing it means either editing a read-only DDL or diverging from
its convention; the fix is one word (`datetime('now','localtime')`) in both branches of the
upsert in `recordReadings`, and it should be made deliberately, with the existing 92 rows in
mind.

---

## 7. Re-checking it

```powershell
curl.exe -s "http://127.0.0.1:5181/api/activity"          | ConvertFrom-Json   # summary, 48 tables
curl.exe -s "http://127.0.0.1:5181/api/activity/today"    | ConvertFrom-Json
curl.exe -s -X POST "http://127.0.0.1:5181/api/activity/snapshot" -H "Content-Type: application/json"
curl.exe -s "http://127.0.0.1:5181/api/activity?date=2026-02-31"                # -> 400, "not a real date"
```

The date control is worth exercising: `?date=2026-02-31` answers **400** with
`"2026-02-31" is not a real date — the closest one is 2026-03-03.` — the server normalises
through the store's own `date()` rather than trusting the string.

Any probe that asserts these routes work should include a **control that must fail** (an
unknown route, or `?date=2026-02-31`); otherwise a pass cannot be told apart from a harness
that executes nothing.
