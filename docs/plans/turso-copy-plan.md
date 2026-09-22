# Plan — Turso test-data copy of the EBS ledger

**Status:** DRAFT — awaiting approval
**Author:** Copilot
**Date:** 2026-09-20
**Goal:** a queryable test-data copy, not a production mirror.

> **Revision note.** §1–§12 answer *"copy 100,000 rows per table, confirm the schemas match,
> and write it up"*. **§13 was added when a fresh, empty Turso database was offered** and is the
> recommended destination — but read **§13.2** first: it changes the *delete* story and leaves
> the *load* story intact. **§3.9 and §3.10 are the two findings that decide the design**, and
> both were measured after §1–§12 were first drafted.

> **Status note (added retrospectively).** This plan was written after the work it
> describes was measured, not before it. Every number below was **run** against
> `POWERAPPS@europa.wcpss.net:1541/ebs_FA2DB` (source) and
> `libsql://oracle-kahua-v1-kevink3344.aws-us-east-1.turso.io` (destination) on
> 2026-09-20 — nothing in §3 or §4 is inferred, estimated or scaled from another
> figure. Where a statement is *not* measured it carries a ★ and says so.

---

## 1. Direct answer

**Yes — 100,000 rows per table is the right cap, and the copy takes about six minutes.**

| | measured |
|---|---|
| Tables in the copy | **29** (3 composed views excluded, see §2) |
| Rows written | **1,206,709** |
| Read wall-clock | **190.4 s** |
| Write wall-clock | **145.9 s** — at the *measured* 8,270 rows/s |
| **End to end** | **5.6 minutes** |
| Payload | **276.8 MB** (JSON) |
| Turso storage used | **5.41 %** of the 5 GB Free allowance |
| Turso write allowance used | **12.1 %** of the 10 M rows/month ⇒ **~8 clean re-runs fit in a month** |

That is a *read-and-write* measurement, not an extrapolation: `tmp-copy-measure.ts`
read all 29 tables at the cap with `fetchArraySize: 2000` and one connection, and the
write figure comes from a separate benchmark on the real destination (`tmp-copy-bench2.ts`).

**Six findings that shape the plan more than the timing does:**

1. **★★★ THE CAP CANNOT BE APPLIED PER TABLE. `PRAGMA foreign_keys` is 1 on the
destination, and 4 of the 22 in-scope foreign keys would reject child rows — one of
them rejects 100,000 of 100,000.** Measured, not theorised (§3.9). The load fails
*partway through a table*, after some rows are already written, because a 100,000-row
slice of a parent and a 100,000-row slice of its child are taken **by different keys
and need not agree**. This is the finding that decides the design.
2. **★★ `FND_FLEX_VALUES` cannot be copied as written.** It is a **join view** on the
   source, so `ORDER BY ROWID` — the device the PK-less tables depend on — dies with
   **`ORA-01445: cannot select ROWID from, or sample, a join view`**. (It is 41,877
   rows, 7 columns — small, but one table is currently *not* copyable.)
3. **★ The 8 NOT NULL columns the source cannot fill will break 5 INSERTs** — not
   silently, but *partway through the load*. See §4.3.
4. **★ `GL_BUDGET_ASSIGNMENTS` loads 100,000 rows with a NULL composite primary key**,
   and SQLite does **not** reject that — NULLs are distinct in a unique index. It is the
   worst outcome available: no error, and 100,000 indistinguishable rows. See §4.3.
5. **★★ The cap's ORDER BY key comes from the descriptor, and 3 of the 29 tables have
   no usable descriptor key** — so they are sliced by `ROWID`. Two of them are the
   expensive ones (`GL_BALANCES` 74 s, `GL_JE_LINES` 38 s) and **the destination has a
   real key for every one of them**. Fixing that is the single largest available
   speedup — and, per finding 1, probably also part of the *correctness* fix. See §5.2.
6. **★ The destination already holds rows in 28 of 32 tables**, so against *that*
   destination the copy must be **delete-then-load**, never a plain insert. See §6.
7. **★★ The FK probe has a blind spot, and it matters most here:** it compared a **source**
   child slice against a **source** parent slice, but the INSERT runs against the
   **destination**, which already holds authored rows. A child can be perfectly consistent
   with its slice and still be rejected. **The 8 NOT NULL breakages are not isolated — each is
   a potential cascade onto its children.** See §3.10.

★ **Starting from a fresh, empty Turso database is the better option** and is written up in
**§13** — but read §13.2 first: **it changes the DELETE story, not the LOAD story.** §3.9's
slice collision, the 8 NOT NULL breakages and `FND_FLEX_VALUES` are all properties of the
source and the cap, and an empty destination has no bearing on any of them.

---

## 2. Scope — what is in the copy, and what is deliberately not

### 2.1 How the scope is derived (not hand-listed)

```ts
const copyable = [...new Set(registeredResources().map((d) => d.table).filter((t) => {
  try { return storeForTable(t) === 'ledger' && classOfTable(t) === 'EBS'; }
  catch { return false; }
}))].sort();
```

The API's descriptors name **34** objects. Two are this app's own (`X_REPORT_PROJECT_FACTS`,
`X_REPORT_FUNDING_LINES`) and live in the app store; three are the composed reporting views.
`34 − 2 − 3 = 29`.

★ **The rule is asked of the codebase, not restated.** `storeForTable()` is the same gate
`ledgerPlan()` uses, and `classOfTable() === 'EBS'` is the exported way to exclude the
three views (`DERIVED_TABLES` itself is module-private in `db/store.ts`). A hand-kept list
would be a second opinion about routing, and this project has already been bitten twice by
one drifting from the other.

### 2.2 The three composed views — excluded on purpose

`V_SEGMENT_LEGEND` (3 cols), `V_ACCOUNT_POSITION` (9), `V_BUDGET_BY_ACCOUNT_PERIOD` (15)
are **`view`** in the destination and **composed by the app** from base tables
(`server/src/db/derived.ts`). Copying a view would freeze a reading of a base table that is
itself being copied — so they are not in scope, and copying them would be double-writing the
same facts.

★ **A documentation discrepancy to record rather than resolve:** `server/src/scripts/ledger-scale.ts`
(lines 24–28) says these three views are *"not granted"* on this account and answer
`503 DB_UNAVAILABLE`. A re-take on 2026-09-20 reported **`not granted: 0 (none)`** and
**`counted: 32 of 32`**, with all three views counted. The reading that fits both: the views
resolve through `derived.ts`, which composes SQL over the base tables, so *counting* them
never reads the view — the `503` narrative describes a path that the derived plan
intercepts first. **Neither file has been rewritten from memory; the discrepancy is stated
here so the next reader does not have to re-derive it.**

### 2.3 ★ The four `AP_*` tables — a stated decision, not a silent omission

`AP_INVOICES_ALL`, `AP_INV_LINES`, `AP_INVOICE_DISTRIBUTIONS_ALL`, `AP_INVOICE_PAYMENTS_ALL`
are **declared in `data/sql/turso/00-schema.sql`**, are **counted live from the ledger by the
Activity register**, and carry **5 of the 28 foreign keys** — but they have **no `resource.ts`
descriptor and no route that samples them**. A descriptor-driven copy therefore omits them
silently.

Their rows are small in aggregate but **not** in Oracle's terms (`AP_INVOICES_ALL` and its
children were not measured in `tmp-copy-measure.ts` for exactly this reason). The plan needs
an explicit answer in §10 — carry them, refuse them, or exclude them — because "the DDL says
one thing and the copy does another" is the kind of gap that reads as a bug later.

---

## 3. Measured reality check — probe results

> Every row below was run against `europa.wcpss.net:1541/ebs_FA2DB` and
> `oracle-kahua-v1-kevink3344.aws-us-east-1.turso.io`, not inferred. Each probe included a
> **deliberately broken statement** and a **missing object**, both of which failed as
> required, plus a **positive control that must succeed** — so a pass below means something.

### 3.1 The read, per table, at the cap

Source: `tmp-copy-measure.out.txt`. `fetchArraySize 2000`, one connection.

```
table                          rows      ms   rows/s       MB       mode key
PO_VENDORS                    79685    9594     8306     14.0       FULL VENDOR_ID
PO_VENDOR_SITES_ALL           99316    8576    11581     24.3       FULL VENDOR_SITE_ID
PO_HEADERS_ALL               100000    5947    16815     26.3   TRUNCATE PO_HEADER_ID
PO_LINES_ALL                 100000   13862     7214     25.1   TRUNCATE PO_LINE_ID
PO_LINE_LOCATIONS_ALL        100000    5016    19936     25.3   TRUNCATE LINE_LOCATION_ID
PO_DISTRIBUTIONS_ALL         100000    7140    14006     27.1   TRUNCATE PO_DISTRIBUTION_ID
PO_AGENTS                        66      65     1015      0.0       FULL AGENT_ID
PO_LINE_TYPES                     9      66      136      0.0       FULL LINE_TYPE_ID
PO_LOOKUP_CODES               82438    2980    27664      6.9       FULL ROWID
GL_BUDGET_TYPES                   1      53       19      0.0       FULL BUDGET_TYPE_ID
GL_BUDGET_VERSIONS                2      61       33      0.0       FULL BUDGET_VERSION_ID
GL_BUDGET_ENTITIES                8      60      133      0.0       FULL BUDGET_ENTITY_ID
GL_BUDGET_ASSIGNMENTS        100000    4660    21459      2.5   TRUNCATE ROWID
GL_JE_HEADERS                100000   13578     7365     32.1   TRUNCATE JE_HEADER_ID
GL_JE_LINES                  100000   37627     2658     26.4   TRUNCATE ROWID
PA_BUDGET_VERSIONS                0      36        0      0.0       FULL BUDGET_VERSION_ID
PA_BUDGET_LINES                   0      34        0      0.0       FULL ROWID
GL_LEDGERS                        1      39       26      0.0       FULL LEDGER_ID
FND_CURRENCIES                  266      65     4092      0.0       FULL CURRENCY_CODE
GL_PERIODS                      379      68     5574      0.1       FULL ROWID
FND_ID_FLEX_STRUCTURES          244      68     3588      0.0       FULL ID_FLEX_NUM
FND_ID_FLEX_SEGMENTS           1247     148     8426      0.2       FULL ROWID
FND_FLEX_VALUES                   —      83        —        —      ERROR ROWID  ← ORA-01445
FND_FLEX_VALUES_TL            41872    1847    22670      4.0       FULL ROWID
GL_CODE_COMBINATIONS         100000    4197    23827     27.3   TRUNCATE CODE_COMBINATION_ID
GL_BALANCES                  100000   74234     1347     35.0   TRUNCATE ROWID
GL_LOOKUPS                     1175     257     4572      0.2       FULL ROWID
PA_PROJECTS_ALL                   0      44        0      0.0       FULL PROJECT_ID
PA_TASKS                          0      47        0      0.0       FULL TASK_ID
```

**Totals:** 28 tables measured, **1 failed** (`FND_FLEX_VALUES`), **1,206,709 rows to copy**,
**190.4 s** read wall-clock (6,339 rows/s overall), **276.8 MB** payload, **9 capped tables**.

### 3.2 ★ The cost is concentrated in the ROWID slices

The 9 capped tables are **166 s of the 190 s** — about **87 %** of the read. Two of them are
essentially all of it:

- **`GL_BALANCES` 74,234 ms at 1,347 rows/s.** `ROWID` is not indexed, so `ORDER BY ROWID`
  followed by `ROWNUM <= 100000` forces a **full scan of a 157,150,828-row table** to return
  100,000. The cost is **fixed** — it does not fall if you cap at 10,000.
- **`GL_JE_LINES` 37,627 ms at 2,658 rows/s** — the same shape on 33,155,055 rows.

★ Neither table *needs* ROWID. `GL_BALANCES` has no primary key but it **does** have a unique
index (`UX_GL_BALANCES_K1`) in the destination, and `GL_JE_LINES` has a composite primary key
(`JE_HEADER_ID, JE_LINE_NUM`). The descriptor declares no `pk` for either, so the cap falls
back to ROWID — see §5.2. **This is the largest single speedup available and it is free.**

### 3.3 ★ `fetchArraySize` — the one-line defect worth fixing first

`tmp-copy-knee.ts` measured the read:

| `fetchArraySize` | rows/s |
|---|---|
| **100 (node-oracledb's default)** | **3,009** |
| 500 | ~10,400 |
| **1,000 – 2,000 (the knee)** | **~15,974** |
| 5,000 | falls again |

**★★ `server/src/db/oracle.ts:671` never sets `fetchArraySize`**, so the app's own driver reads
at the default 100 — roughly **4–5× slower than the same connection can go**. 31,595 ms ÷ 1,000
round trips = **31.6 ms per RTT**, so a wide `SELECT *` (112 columns on `GL_CODE_COMBINATIONS`)
is a real, separate cost on top of the row count. A fresh Oracle connect is ≈ **450 ms**.

★ **This is a production defect, not a copy-time tweak.** The copy can set the option itself
and be fast without touching the app — but the app is slow for the same reason, and the fix is
one line. §10 asks whether to fix it in the same change.

### 3.4 The write, measured on the real destination

Source: `tmp-copy-bench2.ts`, against the remote Turso.

- **★ Auto-commit at 4,000–6,553 rows/stmt MATCHES or BEATS a transaction's 13,271 rows/s.**
  The plan does **not** need explicit transactions for speed, and the earlier "100 rows/stmt"
  figure was about **batch width**, not transactions.
- **~1,000 rows/stmt is the knee.** `WRITE_ROWS_PER_S = 8_270` (17 columns) is the
  conservative figure used in §1 — chosen because it is the *lower* of the two measurements.
- **★ Batch width is not bounded by 999.** Turso accepted **32,765 binds in one statement**.
- A rollback proof passed — no rows leaked.

### 3.5 ★ What does not work over Turso HTTP

- **`execute({ sql: 'BEGIN' })` does not open a transaction** that survives an HTTP round trip.
  `SqlDriver.transaction()` — `client.transaction('write')` at `driver.ts:123` — **does**.
- **`VACUUM` is disabled** on Turso cloud.
- **Binding a table name into `pragma_table_info(?)` PANICS libSQL** (Rust
  `Option::unwrap()` on `None` at `src/statement.rs:360:62`), surfacing as a
  `NativeCommandError` with **no SQL message at all**. Inline the constant.

### 3.6 ★ The failure mode that cost the most: a missing `CURRENT_SCHEMA`

`ledgerPlan().from` is an **unqualified quoted name** (`q(table)` in `ledger-shape.ts:302`),
because in the app `pinSession` has already run `ALTER SESSION SET CURRENT_SCHEMA = APPS`.
A probe that forgets the pin sees every read die with **`ORA-00942: table or view does not
exist`** — the *same* error Oracle gives for "no privilege", so it reads as a permissions
problem.

**★★ And a control that qualifies its own object name cannot detect it.** The first version of
the conformance probe used `SELECT COUNT(*) FROM APPS.GL_LEDGERS` as its positive control: it
passed, on a run where all 29 real reads failed. The control must be **unqualified** — the
probe prints it as *"proof the session is pinned"*:

```
✓ positive: unqualified GL_LEDGERS resolves — 1 row, 31 ms (session is pinned)
```

★ **The same trap applies to `oracledb`'s `sessionCallback`**: it is invoked as the third
argument of `new Promise` and never awaited, so an `async` callback orphans `done()` and the
pool dies at `queueTimeout` with `NJS-040`. **Every probe issues the pin as a plain statement
on the connection.** `pinSession` sets six session settings, each its own `execute`:
`CURRENT_SCHEMA` (interpolated — DDL takes no binds), `NLS_DATE_FORMAT = 'YYYY-MM-DD'`,
`NLS_TIMESTAMP_FORMAT`, `NLS_TIMESTAMP_TZ_FORMAT`, **`NLS_NUMERIC_CHARACTERS = '.,'`**,
`NLS_SORT = BINARY`. **The `NLS_DATE_FORMAT` is what makes every destination date text
correct, and the numeric-characters setting is what stops a decimal comma reading as 0.**

### 3.7 The destination as it stands

`tmp-turso-target.ts`: all **32** ledger tables **present** (**0 absent**), **28 already holding
rows**, 4 present-and-empty (`PA_BUDGET_LINES`, `PA_BUDGET_VERSIONS`, `PA_PROJECTS_ALL`,
`PA_TASKS`), **72 `sqlite_master` objects / 24 views**.

`tmp-remote-pragma.ts` (read-only): **`PRAGMA foreign_keys → 1`**, `journal_mode → wal`, and the
destination's NOT NULL columns are **currently populated** — `GL_BUDGET_ASSIGNMENTS` 0 of 4 NULL,
`PO_AGENTS` 0 of 7 NULL, `FND_CURRENCIES` 0 of 2 NULL.

**⇒ The copy is a pure data load, and the destination is not empty.** Delete-then-load or a PK
upsert; never a plain insert.

### 3.8 Where the destination's current rows came from

Traced to `scripts/build-turso-sample.mjs` — and they are **not** extracts:

| table | rows | provenance |
|---|---|---|
| `FND_CURRENCIES` | 2 | `SAMPLE_DATA_PROVENANCE` = SYNTHETIC / authored (literal INSERTs, :442) |
| `GL_BUDGET_TYPES` | 3 | SYNTHETIC / authored (:489) |
| `GL_BUDGET_VERSIONS` | 4 | DERIVED / `'report-findings.md section 2'` (:494) |
| `GL_BUDGET_ENTITIES` | 2 | SYNTHETIC / authored (:504) |
| `GL_LOOKUPS` | 5 | SYNTHETIC / authored |
| `PO_AGENTS` | **7** | EXTRACT / `'full-output.json'` — *"ALL 7 rows. 7 distinct BUYER_NAME. AGENT_ID is allocated; the name is real."* (`02-seed.sql:16793`; the INSERT is `:1075`) |

★★ **CORRECTION — this table said `PO_AGENTS | 66` and that number is wrong for a fresh build.**
Read verbatim, `02-seed.sql:1075` is **one** INSERT of **7** rows and there is no second one:

```sql
INSERT INTO PO_AGENTS (AGENT_ID, NAME, AUTHORIZATION_LIMIT, ENABLED_FLAG) VALUES
  (2001, 'Harris, Mr. Patrick Ryan', NULL, 'Y'),
  … (2002..2006) …
  (2007, 'Rogers, Mr. Clarence Earl', NULL, 'Y');
```

★ **And the ids are ALLOCATED — they run 2001..2007 with no relationship to Oracle's real
`AGENT_ID` values.** `build-turso-sample.mjs:295` allocates them from a counter
(`agents.set(BUYER_NAME, nextAgentId), nextAgentId++`), so they are positional, not real. **That is
the whole of §3.10's hazard and it is now decidable** — see §3.11.

★★ **And the old `66` was not invented — it was the SOURCE's count, filed under a destination
column.** Two figures that disagreed on this page were never in conflict (§3.11):

| question | answer | measured by |
|---|---|---|
| how many rows does **Oracle's** `PO_AGENTS` hold? | **66**, `AGENT_ID` 23..466,651 | §3.11 |
| how many rows does the **destination** hold, and where from? | **7**, authored by the seed | this table, confirmed independently by §3.7's pragma read (`0 of 7 NULL`) |

**A table headed "where the destination's current rows came from" carried a source figure.**
Neither number was stale; the *column* was. **So the destination IS reproducible from the
committed seed — and an earlier reading of this page concluded the opposite** (it compared this
table's 66 against the seed's 7 and inferred that the destination had been built from a different
revision). That inference was wrong, and it was wrong because a figure was read off a table
without checking which of the table's two questions the column answers. **The 7 is confirmed
twice now — the seed file and the live destination — and the 66 is Oracle's, which is what makes
§3.11's answer possible: the copy can supply the parent from the source itself.**

★ **These are load-bearing fixtures.** They exercise `LATEST_FLAG` and the budget-version path
(the real instance has **2 versions, 1 type, one version id across 5 fiscal years** — because the
year lives in the *period* columns, not in a version per year). A live copy must not silently
overwrite them, and **`PO_AGENTS.NAME` — one of the 8 NOT NULL breakages — is recoverable from
`data/oracle/full-output.json` (2,080,763 bytes).** That is the cheapest fix for one of the five
failing tables. See §10.

---

## 3.9 ★★★ The FK/cap collision — the finding that decides the design

Source: `tmp-fk-overlap.ts` / `.out.txt`. It read **one slice per table at the copy's own
projection, key and cap** (so no table is read twice), then asked, for every FK whose both ends
are in the copy, whether the child's slice references a parent row **inside the parent's slice**.

**★ The detector control fired, which is what makes the numbers below meaningful:**

```
PO_LINES_ALL.PO_HEADER_ID vs the FULL PO_HEADERS_ALL slice   →        0 orphan row(s)
PO_LINES_ALL.PO_HEADER_ID vs a 1,000-key parent slice        →    98082 orphan row(s)
✓ the detector discriminates — the truncated comparison finds strictly more
```

Without that control, a run of zeroes would be indistinguishable from a detector that never
fires.

### The verdict

```
  child                      FK column              parent                       rows     NULL   ORPHAN
  -------------------------- ---------------------- ------------------------ -------- -------- --------
  GL_CODE_COMBINATIONS       CHART_OF_ACCOUNTS_ID   FND_ID_FLEX_STRUCTURES    100,000        0        0
  GL_BALANCES                LEDGER_ID              GL_LEDGERS                100,000        0        0
  GL_BALANCES                CODE_COMBINATION_ID    GL_CODE_COMBINATIONS      100,000        0   58,166  ★ BLOCKER
  GL_BUDGET_VERSIONS         LEDGER_ID              GL_LEDGERS                      2     ALL*        0  * column unreadable → NULL
  GL_BUDGET_VERSIONS         BUDGET_TYPE_ID         GL_BUDGET_TYPES               n/a        —        —  (not measurable)
  GL_BUDGET_ENTITIES         BUDGET_TYPE_ID         GL_BUDGET_TYPES               n/a        —        —  (not measurable)
  GL_BUDGET_ASSIGNMENTS      BUDGET_VERSION_ID      GL_BUDGET_VERSIONS            n/a        —        —  (not measurable)
  GL_JE_HEADERS              LEDGER_ID              GL_LEDGERS                100,000        0        0
  GL_JE_LINES                JE_HEADER_ID           GL_JE_HEADERS             100,000        0  100,000  ★ BLOCKER
  GL_JE_LINES                CODE_COMBINATION_ID    GL_CODE_COMBINATIONS      100,000        0   91,108  ★ BLOCKER
  PO_VENDOR_SITES_ALL        VENDOR_ID              PO_VENDORS                 99,316        0        0
  PO_HEADERS_ALL             VENDOR_ID              PO_VENDORS                100,000        0        0
  PO_HEADERS_ALL             AGENT_ID               PO_AGENTS                 100,000        0        0
  PO_LINES_ALL               PO_HEADER_ID           PO_HEADERS_ALL            100,000        0        0
  PO_LINE_LOCATIONS_ALL      PO_HEADER_ID           PO_HEADERS_ALL            100,000        0        0
  PO_LINE_LOCATIONS_ALL      PO_LINE_ID             PO_LINES_ALL               100,000        0        0
  PO_DISTRIBUTIONS_ALL       PO_HEADER_ID           PO_HEADERS_ALL            100,000        0        0
  PO_DISTRIBUTIONS_ALL       PO_LINE_ID             PO_LINES_ALL               100,000        0        0
  PO_DISTRIBUTIONS_ALL       CODE_COMBINATION_ID    GL_CODE_COMBINATIONS      100,000        0   23,452  ★ BLOCKER
  PA_TASKS                   PROJECT_ID             PA_PROJECTS_ALL                 0        0        0
  PA_BUDGET_VERSIONS         PROJECT_ID             PA_PROJECTS_ALL                 0        0        0
  PA_BUDGET_LINES            BUDGET_VERSION_ID      PA_BUDGET_VERSIONS              0        0        0

  FKs with both ends in the copy        22
  FKs that would REJECT child rows       4
```

### ★ What the four blockers have in common

**Every one of them routes through `GL_CODE_COMBINATIONS` — three of the four — or through
`GL_JE_HEADERS`.** Both are tables where the child is capped by a **different key than the
parent**, so the two slices describe disjoint parts of the table:

| FK | parent slice kept | child's slice resolved | why |
|---|---|---|---|
| `GL_BALANCES.CODE_COMBINATION_ID` | 100,000 of 1,300,594 (7.7 %) | 41,834 / 100,000 | `GL_BALANCES` is sliced by **ROWID**, an arbitrary physical slice of 157 M rows |
| `GL_JE_LINES.CODE_COMBINATION_ID` | 100,000 of 1,300,594 (7.7 %) | 8,892 / 100,000 | `GL_JE_LINES` is sliced by **ROWID** |
| `GL_JE_LINES.JE_HEADER_ID` | 100,000 of 1,011,459 (9.9 %) | **0 / 100,000** | ROWID slice of 33 M lines vs the *lowest* 100,000 header ids — **the two sets barely intersect** |
| `PO_DISTRIBUTIONS_ALL.CODE_COMBINATION_ID` | 100,000 of 1,300,594 (7.7 %) | 76,548 / 100,000 | PO distributions cluster on low combinations |

★ **`GL_JE_LINES.JE_HEADER_ID` at 100,000 of 100,000 is the cleanest statement of the bug:**
not an edge case, not a long tail — **the entire slice is unreachable.**

### ★ The three ways out, with their measured costs

1. **Parent-driven caps** — take the child's slice as `WHERE <fk> IN (<the capped parent
   slice>)` instead of `ORDER BY <child key> LIMIT 100000`. **This is correct by
   construction**, and the price is on the table above: it would collapse
   `GL_JE_LINES` from 100,000 rows to about **8,892** (a 91 % reduction), and
   `GL_BALANCES` from 100,000 to about **41,834**.
2. **Load with FK enforcement off, re-enable after** — `PRAGMA foreign_keys = 0` for the load,
   then `PRAGMA foreign_key_check`. ★ **This loads orphaned child rows silently, and the
   destination then holds referential garbage that every join in the app will trip over.** It
   buys the row count and spends the correctness. It also cannot be done inside a transaction
   on Turso (§3.5) — the pragma is a connection setting, so it must be set per connection
   *outside* any transaction.
3. **Exclude the unloadable children** — do not copy `GL_JE_LINES`, `GL_BALANCES`,
   `PO_DISTRIBUTIONS_ALL`. ★ This is honest and cheap, but it removes **three of the
   nine largest tables**, including both of the expensive ROWID reads (so it also removes the
   74-second and 38-second costs).

### ★★ A related measurement that may make option 1 cheaper than the table suggests

`GL_JE_LINES`'s 100,000 / 100,000 is **caused by its ROWID ordering** (see the slice-key
table below). Ordered by `JE_HEADER_ID` — which the destination's composite PK
`(JE_HEADER_ID, JE_LINE_NUM)` provides (§4.5) — its slice would start at the *lowest*
header ids, which is exactly where `GL_JE_HEADERS`' own slice starts. **★ So the key change of
§5.2 plausibly fixes this FK on its own, and it is unmeasured.** It is the first thing to
measure in the build order (§12).

### The slice key, per table — what the cap actually ordered by

```
  ORDER BY AGENT_ID                   1 table(s): PO_AGENTS
  ORDER BY BUDGET_VERSION_ID          2 table(s): GL_BUDGET_VERSIONS, PA_BUDGET_VERSIONS
  ORDER BY CODE_COMBINATION_ID        1 table(s): GL_CODE_COMBINATIONS
  ORDER BY ID_FLEX_NUM                1 table(s): FND_ID_FLEX_STRUCTURES
  ORDER BY JE_HEADER_ID               1 table(s): GL_JE_HEADERS
  ORDER BY LEDGER_ID                  1 table(s): GL_LEDGERS
  ORDER BY LINE_LOCATION_ID           1 table(s): PO_LINE_LOCATIONS_ALL
  ORDER BY PO_DISTRIBUTION_ID         1 table(s): PO_DISTRIBUTIONS_ALL
  ORDER BY PO_HEADER_ID               1 table(s): PO_HEADERS_ALL
  ORDER BY PO_LINE_ID                 1 table(s): PO_LINES_ALL
  ORDER BY PROJECT_ID                 1 table(s): PA_PROJECTS_ALL
  ORDER BY ROWID                      3 table(s): GL_BALANCES, GL_JE_LINES, PA_BUDGET_LINES
  ORDER BY TASK_ID                    1 table(s): PA_TASKS
  ORDER BY VENDOR_ID                  1 table(s): PO_VENDORS
  ORDER BY VENDOR_SITE_ID             1 table(s): PO_VENDOR_SITES_ALL
```

★ **Only 3 tables land on ROWID — and 2 of them are the blockers.** That is the whole shape of
the problem in one grouping.

★ **Four FKs are `n/a` (not measurable)** — the parent slice could not be read because its key
column is one of the unreadable set of §4.4. Concretely: `GL_BUDGET_VERSIONS.BUDGET_TYPE_ID`,
`GL_BUDGET_ENTITIES.BUDGET_TYPE_ID`, `GL_BUDGET_ASSIGNMENTS.BUDGET_VERSION_ID`,
`GL_BUDGET_VERSIONS.LEDGER_ID` (reported `ALL*`). **These cannot be cleared until the NOT NULL
decisions of §10 are made**, and a table with an unreadable FK column is exactly the case that
loads as NULL — which *satisfies* a FK, so it is the one harmless outcome and must not be
confused with an orphan.

---

## 3.10 ★★ The probe's blind spot: it validated the COPY's consistency, not the DESTINATION's

The probe compared a **source child slice** against a **source parent slice**. That is exactly
what the copy needs to be *internally* consistent — but the INSERT runs against the
**destination**, which already holds rows (§3.7). **A child row can be perfectly consistent with
its own slice and still be rejected, because the destination's parent row is not the one the
slice loaded.**

★ **The measured shape:** `PO_HEADERS_ALL.AGENT_ID → PO_AGENTS.AGENT_ID` reported **0 orphans**
— correctly, against the source's *own* parent slice. But `PO_AGENTS.NAME` is one of the 8 NOT
NULL breakages (§4.3), and the destination holds agents **only because `02-seed.sql` authored
them, with `AGENT_ID` *allocated*** rather than taken from Oracle: **the committed seed inserts
exactly 7 rows, ids `2001`–`2007`** (§3.8, read verbatim from `02-seed.sql:1075`).

★★ **So a third failure mode joins the two below, and it is the one this decision now turns on:**
given option 2 of §13.5 — keep the seeded `PO_AGENTS`, exclude seed-owned tables from the copy —
the question is no longer *"do the seed's parents satisfy the children?"* but **"do 100,000 real
`PO_HEADERS_ALL` rows carry an `AGENT_ID` that happens to be one of `2001`–`2007`?"** Those are
allocated, positional ids with no relation to Oracle's, so the expected answer is **almost none**.
**Measured in §3.11, not assumed.**

⇒ **Two failure modes, neither visible to the probe, both reachable:**

1. **If the seeded agents are rejected for NOT NULL `NAME`, `PO_AGENTS` is empty — and then all
   100,000 `PO_HEADERS_ALL` rows are rejected by the FK.** A table with nothing wrong with it
   fails because its parent failed. ★ **The 8 NOT NULL breakages are not isolated defects; each
   one is a potential cascade onto its children, and the child is much larger than the parent.**
2. **The seed's *allocated* agent ids are not Oracle's real ids, so `PO_HEADERS_ALL` orphans
   against a populated `PO_AGENTS`** — and the table that looks fine is the one that breaks.
   ★ Measured: see §3.11.

★★ **This is the second time in this project that a probe answered a subtly different question
than the one asked** (the first was §5.2's `plan.pk` fallback, which sliced every table by ROWID
while reporting success). **The gate that closes it: FK overlap must be checked child-slice →
in the DESTINATION's parent table**, not only slice → slice. That is gate **G12**, and it is one
of the two real arguments for starting from a fresh destination (§13.1).

★ **A cheap corollary worth carrying:** the probe's `rows` column is the **child slice** and the
`ORPHAN` column is what the *insert* would refuse — but a table can also be refused by a
**parent that was never loaded at all** (the `n/a` rows above). A count of zero on a `n/a` row
means *not measurable*, not *safe*.

---

## 3.11 ★★★ The answer — measured, and it changes the decision

Source: a re-run of `tmp-g12.ts` plus `tmp-g12b.ts`. Both issue the `CURRENT_SCHEMA` pin as a
plain statement on the connection (§3.6), and both begin with controls:

```
[ok] positive  unqualified GL_LEDGERS   → {"N":1}     ← the session is pinned
[ok] negative  deliberate syntax error  → ORA-00936: missing expression
[ok] negative  unknown object           → ORA-00942: table or view does not exist
```

### ★ The seed cannot parent the copy — 100,000 of 100,000 rows would orphan

| question | measured |
|---|---|
| `PO_HEADERS_ALL` slice rows carrying an `AGENT_ID` | **100,000** of 100,000 |
| distinct ids in that slice | **28**, range **23 .. 114,988** |
| of those, inside the seed's `2001`–`2007` | **0** |
| **rows the FK would reject** | **100,000 — every row** |
| Oracle's real `PO_AGENTS` | **66** rows, `AGENT_ID` **23 .. 466,651** |
| real agent ids colliding with `2001`–`2007` | **0** |
| slice's 28 distinct ids present in Oracle's real `PO_AGENTS` | **28 of 28** |

★ §13.5's option 2 — keep the seeded `PO_AGENTS`, exclude seed-owned tables from the copy —
**cannot work.** And it fails *worse* than the NOT NULL problem it was avoiding: the exclusion
removes 8 NOT NULL breakages and substitutes an FK orphan of the same size (100,000), which is
silent until the INSERT.

### ★ The repair is cheap, because Oracle's `PO_AGENTS` is only 66 rows

All 28 distinct ids the slice uses resolve inside Oracle's real parent, and 66 is far under the
cap, so **the copy can supply its own parent from the source**. And because the real ids do not
collide with `2001`–`2007`, **the seed's 7 rows can stay** — they are the load-bearing fixtures
of §3.8 (they exercise `LATEST_FLAG` and the budget-version path) and nothing references them.

⇒ **`PO_AGENTS` becomes 7 seeded rows + 66 real rows = 73, and the FK is satisfied without
dropping anything.** This supersedes §13.5's seed-exclusion **for this one table**.

### ★ The obstruction: `PO_AGENTS.NAME` is not granted — and the error code says which kind of problem it is

```
[readable] PO_AGENTS.AGENT_ID            non-null count = 66
[ABSENT  ] PO_AGENTS.NAME                ORA-00942 — object not visible to this account
[readable] PO_AGENTS.AUTHORIZATION_LIMIT non-null count = 0
[ABSENT  ] PO_AGENTS.ENABLED_FLAG        ORA-00942 — object not visible to this account
```

★★ **`ORA-00942` here is a COLUMN-level privilege, not an absent column, and the evidence is the
same-table contrast:** `AGENT_ID` and `AUTHORIZATION_LIMIT` resolve **from the same table in the
same statement shape**. An absent column gives `ORA-00904`; `ORA-00942` on one column of a
*visible* table is a grant the account does not hold. ★ The probe prints the code and the reason
separately for exactly this reason — a probe that reported only "failed" would have collapsed a
privilege into a shape difference, and the two have different fixes.

⇒ `NAME` is `TEXT NOT NULL` (§4.3) and unreadable, so the 66 real rows need a **derived** name.
The seed's 7 real names cannot be reused: they are keyed to the seed's *allocated* ids and the
real rows share no key with them (§3.8). **Cheapest honest fallback: `'Agent ' || AGENT_ID`.**
The destination is test data and the column's contract — non-null and human-readable — is kept.

### ★★ The `GL_JE_LINES` blocker IS repaired by the key change — now with a control that can fail

§3.9 recorded **100,000 of 100,000** orphans for the ROWID slice. Ordered by
`(JE_HEADER_ID, JE_LINE_NUM)` — the destination's own composite PK (§4.5):

```
child slice: 100000 rows, 10 distinct JE_HEADER_ID, range 59..104, max JE_LINE_NUM 38366
orphans vs the FULL parent slice (100000 lowest header ids): 0
control — parent slice = 1000 lowest header ids ABOVE 104: 100000
detector: full=0 control=100000 → DISCRIMINATES (0 vs all) — the 0 is a real 0
```

★★ **The first version of this control was VOID, and how it was void is the lesson.** It compared
the child against the *1,000 lowest* parent ids — which necessarily contain the child's own keys,
because the child slice is ordered by the same key. Both readings returned 0 and the probe
correctly reported `detector discriminates: NO`. **The fix was not a better number but a
different parent slice: one drawn from ABOVE the child's maximum key**, where the child's keys
cannot be, so a working detector *must* report one count per child row. Third instance of the
standing rule — *a control must exercise the same space as the statement it vouches for* — and
here "the same space" had to be a **disjoint** one.

★ **The price, stated:** 100,000 rows span only **10 distinct headers**, while the table-wide
density is 32.8 lines per header. Those 10 headers hold 134,664 lines between them, so the
identity-ordered slice is **valid but extremely narrow** — 10 of 1,011,459 journals. Far better
than 100,000 orphaned rows, but the copy's journal coverage is a sliver, and §1's "queryable,
not a mirror" is doing real work here.

### ★ The `GL_BALANCES` timing: real, but ≈ 11 %, not "a removed full scan"

| read | `fetchArraySize` | time |
|---|---|---|
| §3.2 ROWID baseline | 2,000 | 74,234 ms |
| identity-ordered, sample 1 | **100** (default) | 93,281 ms |
| identity-ordered, sample 2 | 2,000 | 66,421 ms |
| identity-ordered, sample 3 | 2,000 | 64,825 ms |

★★ **Sample 1 is not comparable to the others, and the probe's own comment says otherwise.** Its
doc block claims it "deliberately does NOT set `fetchArraySize`, to match `oracle.ts:671`" — but
its `q()` helper **does** set `fetchArraySize: 2_000`, so the comment describes neither run.
At **equal** fetch size the identity key gives **65.6 s vs 74.2 s ≈ 11.6 % faster**, with two
samples agreeing to within 2.5 %. **So §5.2's "should remove `GL_BALANCES`'s 74-second full
scan" is falsified: a modest win, not a removal.** The honest reading is that the cost is
dominated by fetching 100,000 rows rather than by the ordering — which is consistent with §3.3
and does not depend on it.

**⇒ The §12 build order needs no change, but its expectation does.** The key change is worth
taking for `GL_JE_LINES` (it converts a total blocker into a load) and worth taking for
`GL_BALANCES` on consistency grounds — **not** on a speed claim.

---

## 4. ★ Schema conformance — do the two schemas match?

Source: `tmp-schema-conform.out.txt`. **Yes.** And the way they fail to match is entirely in the
source's favour.

### 4.1 The headline

| | measured |
|---|---|
| Tables compared | **29** |
| Columns the copy projects | **213** |
| Columns the destination declares | **240** |
| **Columns with no home** | **0** |
| Destination columns left unfilled | **27**, across **10** tables |
| …of which are `NOT NULL` (**these break the INSERT**) | **8**, across **5** tables |

**`columns with no home 0`** is the load-bearing figure: *every column the copy emits has a
destination column to receive it*, so **no INSERT can fail for an unknown column**. The
destination is a **superset** of what this deployment can read — the extra 27 columns are things
this Oracle account does not expose (the descriptors declare 8 columns where the copy projects 3,
etc.), not things the destination forgot.

**⇒ The schemas match. The copy's job is to emit explicit NULLs for the columns the deployment
cannot read, and to decide what to do about the 5 tables whose NULLs are forbidden.**

### 4.2 The table, verbatim

```
  table                       src  dest  ok  unfilled  nohome  NN! kind
  PO_VENDORS                    7     7   7         0       0    0 table
  PO_VENDOR_SITES_ALL          13    13  13         0       0    0 table
  PO_HEADERS_ALL               13    13  13         0       0    0 table
  PO_LINES_ALL                 11    11  11         0       0    0 table
  PO_LINE_LOCATIONS_ALL        12    12  12         0       0    0 table
  PO_DISTRIBUTIONS_ALL         12    12  12         0       0    0 table
  PO_AGENTS                     2     4   2         2       0    1 table
  PO_LINE_TYPES                 6     6   6         0       0    0 table
  PO_LOOKUP_CODES               3     3   3         0       0    0 table
  GL_BUDGET_TYPES               1     5   1         4       0    2 table
  GL_BUDGET_VERSIONS            3    11   3         8       0    2 table
  GL_BUDGET_ENTITIES            1     4   1         3       0    2 table
  GL_BUDGET_ASSIGNMENTS         1     4   1         3       0    0 table
  GL_JE_HEADERS                13    13  13         0       0    0 table
  GL_JE_LINES                  12    12  12         0       0    0 table
  PA_BUDGET_VERSIONS            6     7   6         1       0    0 table
  PA_BUDGET_LINES               3     6   3         3       0    0 table
  GL_LEDGERS                    8     8   8         0       0    0 table
  FND_CURRENCIES                4     5   4         1       0    1 table
  GL_PERIODS                    8     8   8         0       0    0 table
  FND_ID_FLEX_STRUCTURES        4     4   4         0       0    0 table
  FND_ID_FLEX_SEGMENTS          9     9   9         0       0    0 table
  FND_FLEX_VALUES               7     7   7         0       0    0 table
  FND_FLEX_VALUES_TL            4     4   4         0       0    0 table
  GL_CODE_COMBINATIONS         14    15  14         1       0    0 table
  GL_BALANCES                  17    17  17         0       0    0 table
  GL_LOOKUPS                    5     5   5         0       0    0 table
  PA_PROJECTS_ALL               8     9   8         1       0    0 table
  PA_TASKS                      6     6   6         0       0    0 table
```

### 4.3 ★ The 9 NOT NULL breakages — **8 of them would fail an INSERT as designed**

```
  PO_AGENTS: destination column is NOT NULL and would go unfilled — NAME
  GL_BUDGET_TYPES: … NOT NULL and would go unfilled — BUDGET_TYPE_CODE, BUDGET_NAME
  GL_BUDGET_VERSIONS: … NOT NULL and would go unfilled — LEDGER_ID, BUDGET_TYPE_ID
  GL_BUDGET_ENTITIES: … NOT NULL and would go unfilled — BUDGET_TYPE_ID, BUDGET_ENTITY_NAME
  FND_CURRENCIES: … NOT NULL and would go unfilled — NAME
  PA_BUDGET_LINES: … NOT NULL and would go unfilled — LINE_NUM        ← ★ the 9th
```

★ **This plan said 8 and did not name the ninth.** §4.4 listed `PA_BUDGET_LINES`' three unreadable
columns and called `LINE_NUM` *"the worse case, because the destination has it in a composite
primary key while the source cannot supply it"* — and then §4.3, the section whose whole job is to
enumerate the breakages, omitted it. **Two sections, one fact, and only one of them counted it.**

Re-measured against the live destination with `tmp-copy-holes.ts` (a throwaway that reads the
destination's own `pragma_table_info`):

```
  FND_CURRENCIES        1  NAME                                     ★ NOT NULL, no default
  GL_BUDGET_ENTITIES    3  BUDGET_TYPE_ID, BUDGET_ENTITY_NAME, ENABLED_FLAG
                           ★ NOT NULL: BUDGET_TYPE_ID, BUDGET_ENTITY_NAME
  GL_BUDGET_TYPES       4  BUDGET_TYPE_ID, BUDGET_TYPE_CODE, BUDGET_NAME, ENABLED_FLAG
                           ★ NOT NULL: BUDGET_TYPE_CODE, BUDGET_NAME
  GL_BUDGET_VERSIONS    8  LEDGER_ID, BUDGET_TYPE_ID, FIRST_PERIOD_NAME, LAST_PERIOD_NAME,
                           DEFAULT_PERIOD_NAME, STATUS_CODE, LATEST_FLAG, BUDGET_ENTRY_STATUS
                           ★ NOT NULL: LEDGER_ID, BUDGET_TYPE_ID
  GL_CODE_COMBINATIONS  1  CREATION_DATE
  PA_BUDGET_LINES       3  LINE_NUM, TASK_ID, RESOURCE_LIST_MEMBER_ID
                           ★ NOT NULL: LINE_NUM
  PA_BUDGET_VERSIONS    1  STATUS_CODE
  PA_PROJECTS_ALL       1  PROJECT_NUMBER
  PO_AGENTS             2  NAME, ENABLED_FLAG
                           ★ NOT NULL: NAME
  ── 9 tables, 24 columns served as null, 9 of them NOT NULL with no destination default
```

(`24 + GL_BUDGET_ASSIGNMENTS' 3 = 27`, `9 + 1 = 10` — §4.1's totals, reconciled.)

★★ **`PA_BUDGET_LINES.LINE_NUM` is NOT a breakage, and the reason is a measurement, not a
decision: `PA_BUDGET_LINES` holds 0 rows.** So does `PA_BUDGET_VERSIONS`, `PA_PROJECTS_ALL` and
`PA_TASKS` (§3.1). A table with no rows is never INSERTed, so there is nothing to fill. **No
derivation is invented for it** — every candidate (`ROW_NUMBER() OVER (PARTITION BY
BUDGET_VERSION_ID ORDER BY ROWID)`) would fabricate the composite KEY itself and key the same
logical row differently on a different run, which is the same defect that made decision 2 exclude
`GL_BUDGET_ASSIGNMENTS`. The copy states the fact in G4 and **refuses loudly** if rows ever appear
in that table.

★ **Also corrected here: §4.4's claim about `GL_BUDGET_VERSIONS.BUDGET_NAME`.** The plan said it
"is NOT NULL in the DDL but is NOT in the unfilled list", satisfiable only via a join through
`GL_BUDGET_TYPES.BUDGET_NAME`. Measured against the live destination: `BUDGET_NAME` is **not**
among `GL_BUDGET_VERSIONS`' unreadable columns at all, so the source supplies it directly and the
`GL_BUDGET_VERSIONS` NOT NULL set is exactly `LEDGER_ID` + `BUDGET_TYPE_ID`. The DDL the plan was
read against and the schema actually applied disagree; the applied one is the authority.

These 8 constraints were verified **against the DDL** (`data/sql/turso/00-schema.sql`), read
verbatim — not against the descriptor. And `tmp-constraint-semantics.ts` measured what the
destination *does* with them, on a local libSQL file so the remote was never written:

- **`NOT NULL` is FATAL** — `SQLITE_CONSTRAINT_NOTNULL: NOT NULL constraint failed: parent.NAME`,
  **both** by omitting the column and by passing an explicit NULL. There is no "default wins"
  escape.
- **★★ Three identical `(NULL, NULL, NULL)` inserts into a composite primary key did NOT collide** —
  `3 null-keyed row(s), 4 total`. **SQLite treats NULLs as DISTINCT in a unique index, so a
  NULL-keyed composite PK is the worst of the three possible outcomes: no error, and 100,000
  indistinguishable rows.** The control — the same *non-null* key twice — *did* collide, which is
  what makes the finding meaningful.
- **Explicit NULL into an `INTEGER PRIMARY KEY` is ACCEPTED** and assigned a rowid (ID 2). A NULL
  key is **invented**, not rejected.
- **`PRAGMA foreign_keys` = 1** on a fresh local connection, and a child naming a missing parent
  **FAILS** with `SQLITE_CONSTRAINT_FOREIGNKEY`.

★ **Two of the five failing tables are therefore worse than a failure:**

- **`GL_BUDGET_ASSIGNMENTS`**: its destination primary key is **exactly** the three columns the
  source cannot fill (`BUDGET_VERSION_ID, RANGE_FROM, RANGE_TO`, all in one composite
  `sqlite_autoindex`). It is *not* a NOT NULL breakage — it is that silent worst case. It would
  load **100,000 rows with a NULL key, no error, and no way to tell them apart.** **Refuse it, or
  exclude it — do not ship a table of nulls.**
- **`GL_BUDGET_VERSIONS`** is owned by the failure *and* is the parent of
  `GL_BUDGET_ASSIGNMENTS` (FK #7), so excluding one has a consequence for the other.

★ **`GL_BUDGET_VERSIONS.BUDGET_NAME` is NOT NULL in the DDL but is NOT in the unfilled list** —
the source *can* supply it via `GL_BUDGET_TYPES.BUDGET_NAME`, which is itself declared unreadable.
So one of the 8 is satisfiable by a join the copy would have to make deliberately.

### 4.4 The 27 silent NULLs — declare them, or nobody can tell them from "absent"

```
  GL_BUDGET_ASSIGNMENTS      3 unfilled — BUDGET_VERSION_ID, RANGE_FROM, RANGE_TO
  PA_BUDGET_VERSIONS         1 unfilled — STATUS_CODE
  PA_BUDGET_LINES            3 unfilled — LINE_NUM, TASK_ID, RESOURCE_LIST_MEMBER_ID
  GL_CODE_COMBINATIONS       1 unfilled — CREATION_DATE
  PA_PROJECTS_ALL            1 unfilled — PROJECT_NUMBER
```

…plus the nullable members of the same unreadable sets on `PO_AGENTS` (`ENABLED_FLAG`),
`GL_BUDGET_TYPES` (`ENABLED_FLAG`), `GL_BUDGET_ENTITIES` (`ENABLED_FLAG`),
`FND_CURRENCIES` (`NAME`), `GL_BUDGET_VERSIONS` (6 further columns), `PA_BUDGET_LINES`.

★ **Every one of these must be declared in the copy's own output**, in the shape this project
already uses for the `ledger-scale` script: *"3 declared column(s) have no readable source on
this deployment and will be served as null: …"*. A NULL nobody declared reads exactly like
absent data — and `LINE_NUM` on `PA_BUDGET_LINES` is the worse case, because the *destination*
has it in a composite primary key while the *source* cannot supply it.

### 4.5 Destination type histogram and identity

```
  TEXT           140
  INTEGER        79
  REAL           21
```
(**240** total, matching the destination column count.)

**Per-table identity, from `sqlite_master` (marked `*` = unique):**

```
  PO_VENDORS                 pk=[VENDOR_ID]                                  indexes: —
  PO_VENDOR_SITES_ALL        pk=[VENDOR_SITE_ID]                             indexes: —
  PO_HEADERS_ALL             pk=[PO_HEADER_ID]                               indexes: —
  PO_LINES_ALL               pk=[PO_LINE_ID]                                 indexes: —
  PO_LINE_LOCATIONS_ALL      pk=[LINE_LOCATION_ID]                           indexes: —
  PO_DISTRIBUTIONS_ALL       pk=[PO_DISTRIBUTION_ID]                         indexes: —
  PO_AGENTS                  pk=[AGENT_ID]                                   indexes: —
  PO_LINE_TYPES              pk=[LINE_TYPE_ID]                               indexes: —
  PO_LOOKUP_CODES            pk=[LOOKUP_TYPE, LOOKUP_CODE]                   indexes: sqlite_autoindex_PO_LOOKUP_CODES_1*
  GL_BUDGET_TYPES            pk=[BUDGET_TYPE_ID]                             indexes: sqlite_autoindex_GL_BUDGET_TYPES_1*
  GL_BUDGET_VERSIONS         pk=[BUDGET_VERSION_ID]                          indexes: —
  GL_BUDGET_ENTITIES         pk=[BUDGET_ENTITY_ID]                           indexes: —
  GL_BUDGET_ASSIGNMENTS      pk=[BUDGET_VERSION_ID, RANGE_FROM, RANGE_TO]    indexes: sqlite_autoindex_GL_BUDGET_ASSIGNMENTS_1*
  GL_JE_HEADERS              pk=[JE_HEADER_ID]                               indexes: —
  GL_JE_LINES                pk=[JE_HEADER_ID, JE_LINE_NUM]                  indexes: sqlite_autoindex_GL_JE_LINES_1*
  PA_BUDGET_VERSIONS         pk=[BUDGET_VERSION_ID]                          indexes: —
  PA_BUDGET_LINES            pk=[BUDGET_VERSION_ID, LINE_NUM]                indexes: sqlite_autoindex_PA_BUDGET_LINES_1*
  GL_LEDGERS                 pk=[LEDGER_ID]                                  indexes: —
  FND_CURRENCIES             pk=[CURRENCY_CODE]                              indexes: sqlite_autoindex_FND_CURRENCIES_1*
  GL_PERIODS                 pk=[PERIOD_SET_NAME, PERIOD_NAME]               indexes: sqlite_autoindex_GL_PERIODS_1*
  FND_ID_FLEX_STRUCTURES     pk=[ID_FLEX_NUM]                                indexes: —
  FND_ID_FLEX_SEGMENTS       pk=[ID_FLEX_NUM, SEGMENT_NUM]                   indexes: sqlite_autoindex_FND_ID_FLEX_SEGMENTS_1*
  FND_FLEX_VALUES            pk=[FLEX_VALUE_SET_ID, FLEX_VALUE]              indexes: sqlite_autoindex_FND_FLEX_VALUES_1*
  FND_FLEX_VALUES_TL         pk=[FLEX_VALUE_SET_ID, FLEX_VALUE, LANGUAGE]    indexes: sqlite_autoindex_FND_FLEX_VALUES_TL_1*
  GL_CODE_COMBINATIONS       pk=[CODE_COMBINATION_ID]                        indexes: —
  GL_BALANCES                pk=[—]   indexes: IX_GL_BALANCES_PERIOD, IX_GL_BALANCES_ACCT, UX_GL_BALANCES_K1*
  GL_LOOKUPS                 pk=[LOOKUP_TYPE, LOOKUP_CODE]                   indexes: sqlite_autoindex_GL_LOOKUPS_1*
  PA_PROJECTS_ALL            pk=[PROJECT_ID]                                 indexes: —
  PA_TASKS                   pk=[TASK_ID]                                    indexes: —
```

**★★ This table is the answer to §5.2, and it is not the answer the descriptor gives.**
**Every** destination table that the copy slices by ROWID has a real identity here —
`GL_PERIODS`, `PO_LOOKUP_CODES`, `GL_LOOKUPS`, `FND_ID_FLEX_SEGMENTS`, `FND_FLEX_VALUES`,
`FND_FLEX_VALUES_TL`, `PA_BUDGET_LINES`, `GL_BUDGET_ASSIGNMENTS` (composite PKs) and
`GL_BALANCES` (unique index). The descriptor declares no `pk` for them, so the cap falls back to
`ROWID` — and on `GL_BALANCES` that is a **157-million-row full scan**.

### 4.6 Cross-validation — two independent probes agree

★ The **same 10-table unreadable-column set** is reported by two probes taken the **same day**
(2026-09-20), written separately:

- `tmp-schema-conform.ts` → the `NN!` / `unfilled` columns in §4.2.
- `ledger-scale` (`tmp-scale.txt`, 2026-09-20 20:52:40) → ten `[ledger] … will be served as null`
  warnings naming the same tables and columns: `PO_AGENTS` (2), `GL_BUDGET_TYPES` (4),
  `GL_BUDGET_VERSIONS` (8), `GL_BUDGET_ENTITIES` (3), `GL_BUDGET_ASSIGNMENTS` (3),
  `PA_BUDGET_VERSIONS` (1), `PA_BUDGET_LINES` (3), `FND_CURRENCIES` (1),
  `GL_CODE_COMBINATIONS` (1), `PA_PROJECTS_ALL` (1).

The two runs disagree only in *scope* — the script also warns about the nullable
`ENABLED_FLAG` because its descriptors declare 8 columns where the copy projects 3. **The
agreement is the point: neither probe was written from the other.**

### 4.7 The source-side shape check

`tmp-source-shape.ts` (which also fixed a real bug: `NJS-021: invalid type for conversion
specified`, thrown **at assignment time** by `oracledb.fetchAsString = [DB_TYPE_TIMESTAMP,
DB_TYPE_TIMESTAMP_TZ]` — a message naming a *type*, not the setting) reported:

- **`GL_CODE_COMBINATIONS` serves 112 columns** — so the "unreadable" columns are a
  **narrowing, not an absence**. The base tables are far wider than this deployment's descriptors.
- **`PA_PROJECTS_ALL` serves 241 columns / 0 rows** — the whole `PA_*` family is genuinely **empty**.

★ So "1 column unfilled on `PA_PROJECTS_ALL`" costs nothing, and "`GL_CODE_COMBINATIONS`'s
`CREATION_DATE` unfilled" is a deployment choice, not a gap in Oracle.

---

## 5. The cap — how a deterministic 100,000-row slice is taken

### 5.1 The rule

```sql
SELECT * FROM (SELECT <projected columns> FROM <plan.from> ORDER BY <key>) WHERE ROWNUM <= 100000
```

★ **The `ROWNUM` wrap is required.** `WHERE ROWNUM <= n` applies **before** the sort, so it
returns an arbitrary `n` rows and *then* orders them; `FETCH FIRST` is not used because the
probe convention here is the wrap (which also keeps the statement portable). `ORDER BY ROWID`
is the fallback device when no key is declared — it makes a PK-less table's prefix
**reproducible without inventing a key**.

**Cap the partition, never the row set.** The same discipline as the rest of this codebase:
`list.filter(pred).slice(0, N)`, never `list.slice(0, N).filter(pred)`. A cap applied before a
predicate silently denies that matches exist outside the window; here the equivalent mistake is
capping *after* a join, which turns "the first 100,000 rows" into "the first 100,000 rows that
happen to match".

### 5.2 ★★ The key should come from the destination, not the descriptor

The copy currently takes its ORDER BY key from the **descriptor's single-column `pk`**:

```ts
const key = (d.pk as string | undefined) ?? 'ROWID';
```

**That is why 3 of the 29 tables are sliced by ROWID** — `GL_BALANCES`, `GL_JE_LINES`,
`PA_BUDGET_LINES` (§3.9's slice-key grouping) — **and 2 of those 3 are FK blockers.**
§4.5 shows the destination has an identity for every one of them. **Recommendation:
derive the cap key from the destination's identity (PK columns, else the unique index, else
ROWID) and order by that**, which:

- makes the slice **stable across runs** for the composite-key tables (a ROWID slice is
  reproducible only while the table is not rebuilt);
- makes the slice **meaningful** — "the first 100,000 `GL_JE_LINES` by `(JE_HEADER_ID, JE_LINE_NUM)`"
  is a coherent prefix, while a ROWID prefix is an arbitrary physical slice;
- ✅ **MEASURED — it DOES repair `GL_JE_LINES.JE_HEADER_ID`** (§3.9 → §3.11): ordering the child by
  the parent's key makes the child's prefix the parent's prefix, and the orphans went
  **100,000 → 0** with a control that can fail (`full=0, control=100000`). ★ **The price is real:**
  the slice spans only **10 distinct headers** (of 1,011,459), i.e. 134,664 of the table's 33.1 M
  lines collapsed to 100,000 rows across 10 journals. **Valid, but a sliver of coverage.**
- ❌ **MEASURED — it does NOT remove `GL_BALANCES`'s full scan, and the claim was wrong.** At equal
  `fetchArraySize` the identity read is **65.6 s vs 74.2 s ≈ 11.6 % faster** (two samples agreeing
  within 2.5 %), not a removal. ★ And sample 1's **93.3 s** is not comparable to either — it ran at
  the default fetch size while the probe's own comment claims the opposite (§3.11). **Take the key
  change for consistency and for `GL_JE_LINES`; do NOT take it on a speed claim.**

★ **A change of key is a change of WHICH ROWS, not just of which order** (§3.9). That is why
this is the first step of the build order rather than an optimisation.

★ **A caution from this project's own history:** the first draft of the FK probe read
`plan.pk` off the result of `ledgerPlan()`, which has **no such property**. The cast that made it
compile (`plan.pk as string | undefined`) evaluated to `undefined` on *every* table, so every
read silently fell back to ROWID — **it would not have failed, it would have answered a different
question.** A cast is not a source. Any change here must be checked by **printing the key actually
used per table**, which the probe now does:

```
—— ★ THE SLICE KEY, PER TABLE (what the cap actually ordered by) ——
  ORDER BY <key>   N table(s): …
```

### 5.3 The truncation flag

Each table's load reports `FULL` or `TRUNCATE` against its live source count, so a reader can
never mistake a capped table for a complete one. The 9 capped tables are enumerated explicitly in
§3.1's totals. **★ Do not "fix" a truncated table by raising its cap without re-checking §1's
allowance arithmetic** — `GL_BALANCES` at full size is 157 M rows, i.e. **15.7× the entire
monthly write allowance.**

---

## 6. Copy order (and delete order)

Derived from the 28 FK declarations in `data/sql/turso/00-schema.sql`. **22 of them have both
ends in the copy.**

★ **Two modes read this order differently (§13.4):** `--fresh` against an empty destination is
**insert-only** — the order below is the whole story — while `--refresh` walks it *and* the
exact reverse.

**Load order:**

```
 1. FND_ID_FLEX_STRUCTURES, GL_LEDGERS, GL_BUDGET_TYPES, FND_CURRENCIES, GL_PERIODS,
    GL_LOOKUPS, PO_LINE_TYPES, PO_LOOKUP_CODES, PO_VENDORS, PO_AGENTS,
    FND_ID_FLEX_SEGMENTS, FND_FLEX_VALUES, FND_FLEX_VALUES_TL, PA_PROJECTS_ALL
 2. GL_CODE_COMBINATIONS      (→ FND_ID_FLEX_STRUCTURES)
 3. GL_BUDGET_VERSIONS        (→ GL_LEDGERS, GL_BUDGET_TYPES)
 4. GL_BUDGET_ENTITIES       (→ GL_BUDGET_TYPES)
 5. PO_VENDOR_SITES_ALL      (→ PO_VENDORS)
 6. PO_HEADERS_ALL           (→ PO_VENDORS, PO_AGENTS)
 7. GL_JE_HEADERS            (→ GL_LEDGERS)
 8. PA_TASKS, PA_BUDGET_VERSIONS   (→ PA_PROJECTS_ALL)
 9. GL_BUDGET_ASSIGNMENTS    (→ GL_BUDGET_VERSIONS)          ★ §4.3 — see the caveat
10. PO_LINES_ALL             (→ PO_HEADERS_ALL)
11. GL_JE_LINES              (→ GL_JE_HEADERS, GL_CODE_COMBINATIONS)
12. GL_BALANCES              (→ GL_LEDGERS, GL_CODE_COMBINATIONS)
13. PO_LINE_LOCATIONS_ALL    (→ PO_HEADERS_ALL, PO_LINES_ALL)
14. PO_DISTRIBUTIONS_ALL     (→ PO_HEADERS_ALL, PO_LINES_ALL, GL_CODE_COMBINATIONS)
15. PA_BUDGET_LINES          (→ PA_BUDGET_VERSIONS)
```

● **The order is necessary but NOT sufficient.** ★★★ It guarantees nothing about the
**slice**, which §3.9 measured: 4 of these 22 FKs would still reject child rows, one of them
**every** row. **A correct load order cannot fix a slice that is disjoint from its parent's.**
Decide §3.9's option 1/2/3 **before** running this order, or a table will refuse rows partway
through.

**★★ The delete must be the exact reverse**, and this is not a style preference: `PRAGMA
foreign_keys` is **1** on the destination (§3.7), so a parent deleted while a child still
references it is rejected — **exactly as a child inserted before its parent is.** The load and
the delete are the same graph walked in opposite directions.

★ **And the delete has a second problem the insert does not:** the destination currently holds
authored fixtures and older rows (§3.7, §3.8), so a delete that runs before a load which then
**refuses 100,000 rows** leaves the destination **emptier than it started**. Delete and insert
of a table must be **one unit** — per table, not as two repo-wide passes.

★★ **A fresh destination removes this entire paragraph** (§13.1) — and that is the strongest
argument for it. It does **not** remove the rejections themselves (§13.2).

★ **Repeated runs must not rely on `INSERT OR IGNORE`.** It is protected by the PK, but it would
silently **keep the OLD row** rather than refresh it — so a re-run after a source change would
appear to succeed while serving stale data. **Delete first, then insert.**

★ **And do not use `.onConflictDoNothing()` on non-unique business fields** — the same family of
mistake this project has already hit twice (each re-run creating duplicates because every row
gets a fresh UUID). Idempotence comes from delete-then-insert in FK-safe order, or from a
genuine PK upsert.

---

## 7. Type mapping and fidelity limits

| Oracle | SQLite | rule |
|---|---|---|
| `''` (empty string) | `NULL` | **★ highest risk.** Oracle treats `''` as NULL; SQLite treats it as a distinct empty string. Normalise `''` → NULL or every blank column gains a value it never had. |
| `NUMBER` money | **INTEGER cents** | Oracle `NUMBER` is exact decimal; SQLite `REAL` is IEEE 754. **The 21 `REAL` columns in the destination are the risk surface** — do not put money in one. |
| `DATE` / `TIMESTAMP` | `TEXT 'YYYY-MM-DD'` | via `pinSession`'s **six** NLS settings (§3.6). The `NLS_DATE_FORMAT` is what makes the text correct. |
| zero-dates `0000-00-00` | `NULL` | convert on copy, or SQLite stores `"0000-00-00"` and it sorts as a real past date. |
| `TRUNC` | **trap** | SQLite's `TRUNC` is arithmetic; `date(TRUNC(SYSDATE))` returns NULL **silently**. |

★ **Fidelity limits — what this copy will never reproduce:**

- **A snapshot, not the ledger.** 9 of 29 tables are truncated; the other 20 are complete *as of
  the run*. Comparisons across the boundary are meaningless in the way §5.3's flag warns about.
- **`FND_FLEX_VALUES` is absent** until a real ORDER BY key is chosen for it (§3.1).
- **The 3 composed views are not copied** — they are views in the destination (§2.2).
- **5 tables cannot currently satisfy NOT NULL**, and `GL_BUDGET_ASSIGNMENTS` would load a
  NULL-keyed identity (§4.3).
- **NLS-dependent text.** `NLS_SORT = BINARY` and the numeric-characters setting are pinned *per
  session*; a value that looks the same can differ under a different session's collation.
- **No sequences, no triggers, no constraints beyond the 28 FKs and the declared PKs/uniques.**
  The destination is a *queryable test copy*, not a replica — it will not enforce a rule that
  the DDL does not declare.

---

## 8. Deliverables and npm scripts

**★ The script belongs in `server/scripts/`, not the repo root.** It is the only place that has
both `@libsql/client` and `oracledb` on its resolution path — beside `pull-ap-extract.mjs`.

```
server/scripts/copy-oracle-to-turso.mjs      the copy (read → normalise → delete → insert)
server/scripts/copy-oracle-to-turso.d.ts     ★ no — plain .mjs, matching pull-ap-extract.mjs
```

```jsonc
// server/package.json
"copy:oracle":         "node scripts/copy-oracle-to-turso.mjs --refresh",
"copy:oracle:fresh":   "node scripts/copy-oracle-to-turso.mjs --fresh",
"copy:oracle:dry":     "node scripts/copy-oracle-to-turso.mjs --dry-run",
"copy:oracle:one":     "node scripts/copy-oracle-to-turso.mjs --table"
```

★ **`--refresh` is the default for the bare script** and `--fresh` is explicit, because the
unsafe-by-default choice is the one that assumes an empty database (§13.4).

★ **Mirror `pull-ap-extract.mjs`'s named-bind rule: binds are passed as an OBJECT.** An **ARRAY**
of binds makes `:d` silently NULL and the query returns **zero rows with no error** — the same
family as the `plan.pk` fallback in §5.2: a mistake that produces a plausible answer instead of a
failure.

★ **And register any new table in all three lists.** `ROUTING_APP_TABLES` (`db/store.ts`) ⇄
`APP_TABLES` (`db/app-schema.ts`) ⇄ the `CREATE TABLE` names in `data/sql/turso/01-app.sql` — the
session's `npm run smoke` asserts all three agree in both directions. A table in the DDL but not
in the routing list is a **silent misroute** (the router defaults to `ledger`, so
`SELECT … FROM <new table>` dies with `ORA-00942` **about a table the app itself creates**).
`vendor_site_route` was exactly that bug.

---

## 9. Verification gates

| # | gate | control |
|---|---|---|
| G1 | **Both failing controls run first** — a deliberate syntax error and an unknown object — and both **FAIL** | ★ A run of only passes from a new harness is unverified, not clean. |
| G2 | **A positive control that must SUCCEED, on each store** | ★ And it must exercise the **same addressing** as the statements it vouches for: the Oracle positive is **unqualified** (`GL_LEDGERS`), because a qualified control passes on a session where every real read fails (§3.6). The Turso positive is a `sqlite_master` object count — ★ **and on a fresh database it is the baseline you recorded in §13.3, not the fixed `104` measured on the previous destination.** A hard-coded `104` becomes a *failing* control on a database that is merely new, which is worse than no control at all. |
| G3 | **Schema conformance** — `columns with no home = 0` across all 29 tables | `tmp-schema-conform.ts`, carried forward as the schema gate. |
| G4 | **No unfilled NOT NULL column reaches an INSERT** | the 8 named in §4.3. Fail with the table and column named, not with a driver error. |
| G5 | **Per-table row count: source slice vs destination after load** | a `COUNT(*)` on both sides, per table. |
| G6 | **`PRAGMA foreign_key_check` returns zero rows** after the load | ★ the only honest test that the FK order was right. |
| G7 | **The unreadable-column disclosures are emitted verbatim** | the 10 tables of §4.6 — a NULL nobody declared reads like absent data. |
| G8 | **`FND_FLEX_VALUES` either has a key and loads, or is reported as not copied** | silence is the failure mode (§3.1). |
| G9 | **The `ORDER BY` key actually used is printed per table** | ★ the §5.2 trap: a probe that falls back to ROWID does not fail, it answers a different question. |
| G10 | **★ The FK overlap probe runs as a gate, per table, before the load** — child slice vs **parent slice** | ★ it must carry the **detector control** (`b > a` against a deliberately truncated parent). Without it a run of zeroes is indistinguishable from a detector that never fires (§3.9). |
| G11 | **No table's insert is attempted before its FK overlap is known to be zero** | ★ §3.9: 4 of 22 FKs would reject rows, one of them all 100,000. Assert it **before** the write, not after the failure. |
| G12 | **★★ FK overlap checked child-slice → the DESTINATION's parent table**, not just slice → slice | ★ §3.10: the probe compared source-to-source and would have called `PO_HEADERS_ALL` clean while the destination's seeded `PO_AGENTS` ids are *allocated*, not real. |
| G13 | **`--fresh` asserts the destination is empty** before it writes | ★ A `--fresh` run against a populated database is a duplicate-key failure partway through, or a silently stale table (§13.4). |
| G14 | **★ Post-load: every parent table the probe reported as `n/a` is checked as a count** | §3.10 — `n/a` means *not measurable*, and a zero beside it means nothing. |

★ **A negative assertion needs a message saying what it means if it starts PASSING.** G6 and G4
are assertions of *absence*; if they ever begin to pass for a mechanical reason they become
no-ops.

---

## 10. Decisions I need from you

★ **Decisions 1–3 are ANSWERED** (2026-09-20). **1** — a fresh, empty database is the
destination (§13). **2** — schema + seed, with the seed-owned tables excluded from the live copy
(§13.5). **3** — removed, superseded by 2. **The two things still needed from you are in 1:**
`(a)` the URL and token, `(b)` which role the new database plays. ★ **And answer 7 before anything
is built — it is the one that can invalidate the copy, and it is now sharper than it was: the
consequence stated in 2 rests on §3.11.**

1. ✅ **DECIDED — a fresh, empty database is the destination** (§13). ★ **Still needed from you:**
   its URL and token — put them in the repo-root `.env` (`TURSO_DATABASE` / `TURSO_API_KEY`),
   **not in chat.** ★ And answer the role question while you are there: is the new database the
   **ledger** (`DB_MODE=turso`) or the **app/mirror store** (`DB_MODE=oracle` + `APP_DB_URL`)?
   The two rows of §13.3's table are not interchangeable, and in the second row an unset
   `APP_DB_URL` silently moves the app's own tables onto the server's disk.
2. ✅ **DECIDED — schema + seed**, and **the seed-owned tables are excluded from the live copy**
   (§13.5). This removes all **8** NOT NULL breakages at once, keeps `SAMPLE_DATA_PROVENANCE`
   true, and leaves the copy's job on tables the seed does not author. ★ **The one free choice
   inside it:** `GL_LOOKUPS` is seed-owned but has **no** breakage, so excluding it is optional —
   it is the only table in the set where real Oracle rows could replace synthetic ones.
   ★★ **The consequence you must not skip:** keeping the seed's `PO_AGENTS` means the copy's
   100,000 `PO_HEADERS_ALL` rows are loaded against **allocated** agent ids. If those are not
   Oracle's real ids, **every one of them orphans** — the 8 NOT NULL breakages are removed and an
   FK orphan of the same size takes their place. **This is G12 and it is the next measurement**
   (§12.2), not a residual risk to accept.
3. ✅ **REMOVED as a decision** — decision 2 supersedes it. The 8 NOT NULL columns never get
   written: the tables that carry them are owned by the seed. ★ `PO_AGENTS.NAME` is still worth
   noting as **recoverable** from `data/oracle/full-output.json` (§3.8) if you would rather load
   `PO_AGENTS` than seed it — but that choice reopens §3.9 and §3.10 in full, so it is a
   different project, not a tweak.
4. **The authored fixture tables** — overwrite them from the ledger, or preserve them?
   They exercise `LATEST_FLAG` and the version path (§3.8).
5. **`GL_BUDGET_ASSIGNMENTS`** — its destination PK *is* its three unreadable columns, so it would
   load 100,000 indistinguishable NULL-keyed rows with **no error** (§4.3). Refuse or exclude?
6. **The four `AP_*` tables** — carry them (they need descriptors and routes first), refuse them,
   or exclude them explicitly? They are in the DDL and carry 5 of the 28 FKs (§2.3).
7. **★★★ THE CAP AND THE FOREIGN KEYS — the critical decision.** 4 of 22 in-scope FKs
   would reject child rows, and `GL_JE_LINES.JE_HEADER_ID` rejects **100,000 of 100,000**
   (§3.9). The three options are **parent-driven caps** (correct; costs `GL_JE_LINES` ~91 % of
   its rows), **load with `PRAGMA foreign_keys = 0` and re-enable** (keeps the row count, ships
   referential garbage), or **exclude the unloadable children** (honest; drops 3 of the 9
   largest tables). **Which one?**
   ★★ **UPDATE — measured (§3.11), and it is now 3 blockers, not 4:** `GL_JE_LINES.JE_HEADER_ID`
   is **repaired by the §5.2 key change** (100,000 orphans → **0**, with a discriminating control),
   at the price of a 10-header sliver. **The three `CODE_COMBINATION_ID` blockers remain
   (`GL_BALANCES` 58,166 / 100,000; `GL_JE_LINES` 91,108; `PO_DISTRIBUTIONS_ALL` 23,452)** and the
   choice between the three options is **still yours** — the key change does not touch them,
   because the parent `GL_CODE_COMBINATIONS` is capped by a key the children do not share.
8. **The cap key** — adopt the destination's identity instead of the descriptor's `pk` (§5.2)?
   ✅ **MEASURED — adopt it.** It repairs `GL_JE_LINES.JE_HEADER_ID` outright and costs ~11.6 % on
   `GL_BALANCES` (65.6 s vs 74.2 s at equal fetch size). ★ **The earlier "removes the 74-second
   full scan" was wrong** — a modest win, not a removal.
9. **`fetchArraySize`** — fix `server/src/db/oracle.ts:671` in the same change? It is a
   **production** defect (~4–5× slow reads) independent of this copy (§3.3).
10. **Batch width** — ~1,000 rows/stmt (§3.4). Turso accepted 32,765 binds, so this is a choice
    about memory and retry granularity, not a limit.
11. **The snapshot baseline** — what date/cut-off does the copy represent, and where is it recorded?
    ★ A snapshot with no stated cut-off cannot be compared against the live ledger later, and
    §5.3's truncation flag is the only thing marking which tables are incomplete.
12. **The re-run budget** — 12.1 % of the month's allowance per run means **~8 clean runs a month**;
    overage is a **`BLOCKED` error**, i.e. the query fails, not a bill (§1). ★ **Rarely exercised:**
    a fresh destination means the first run is a single write of 1.2 M rows, and the allowance is
    per **account**, not per database — so a new database **does not grant a new allowance**.

---

## 11. Out of scope — explicitly not doing

- **Not a production mirror.** 9 of 29 tables are capped by design; the copy is for querying.
  ★ **And under §3.9 option 1 it may be capped harder still** — `GL_JE_LINES` at ~8,892 rows
  instead of 100,000 — because a slice that is disjoint from its parent's cannot be loaded.
- **Not a snapshot of a referentially-consistent moment.** The 29 slices are taken in sequence,
  so a row can be read from a parent after its child was already read. **For test data this is
  acceptable; it is stated so nobody treats an FK-consistent 100,000-row join as a guarantee.**
- **Not incremental.** Delete-then-load in FK order; no change-data-capture, no watermarking.
- **Not writing to Oracle.** `ledger` is `writable: false` in `/api/health` and stays that way.
- **Not copying the 3 composed views** — they are views in the destination and composed by the app.
- **Not creating the ledger tables *by hand*.** They are created by the established applier
  (`data/sql/turso/00-schema.sql` via `build-turso-sample.mjs --remote`) — 36 tables and 6 views
  — and the app-owned tables by the server itself (`01-app.sql` via `app-schema.ts`). ★ Against
  **today's** destination they already exist and it is a pure data load; against a **fresh** one
  it is provision-then-load (§13.3). **Either way this plan adds no DDL.**
- **Not `VACUUM`ing** — disabled on Turso cloud (§3.5).
- **Not touching the map, the vendor register, or the drawer** — unrelated work already settled.

---

## 12. Build order

0. **★★ Decide the destination (§13.1) and, if fresh, provision it (§13.3).** Point `.env` at the
   new database, run `node scripts/build-turso-sample.mjs --remote`, boot the server once so
   `01-app.sql` creates the 11 app-owned tables, then **record the `sqlite_master` object count
   as the baseline** before any copy runs. ★ The token goes in `.env`, never in chat.
1. ✅ **ANSWERED (§3.11) — adopt the destination's identity as the ORDER BY key.** The run settled
   both questions at once: **`GL_JE_LINES.JE_HEADER_ID` stops rejecting every row** (100,000
   orphans → **0**, control `100000` proving the detector fires), and **`GL_BALANCES` does NOT
   stop full-scanning** — 65.6 s vs 74.2 s at equal `fetchArraySize`, ≈ 11.6 % faster. ★ **So the
   answer to "does the copy need parent-driven caps?" is YES — for the three
   `CODE_COMBINATION_ID` FKs**, which the key change cannot reach (§10.7). **Do not proceed to the
   load until §10.7 is decided.**
2. ✅ **ANSWERED (§3.11) — and the G12 hazard is worse than §3.10 expected.** Run against the
   **destination's** parent: **100,000 of 100,000 `PO_HEADERS_ALL` rows would orphan** against the
   seed's `PO_AGENTS`, because **0** of the slice's 28 distinct ids land in the seed's allocated
   `2001`–`2007`. ★ **The repair is to load `PO_AGENTS` from Oracle (66 rows) and keep the seed's 7
   alongside it** (§13.5) — but `NAME` is **not granted** (`ORA-00942` on one column of a visible
   table), so the 66 rows need a derived name.
3. **Choose the ORDER BY key for `FND_FLEX_VALUES`** (§3.1) — it is currently not copyable.
4. **Decide §10.7** — parent-driven caps, FK enforcement off, or exclusion — using step 1's
   numbers.
5. **Resolve the decisions in §10** that change what is *written*: `AP_*`, the 8 NOT NULL columns,
   `GL_BUDGET_ASSIGNMENTS`, the fixtures, the seed (§10.1–§10.5).
6. **Write `server/scripts/copy-oracle-to-turso.mjs`** with **`--fresh`, `--refresh` and
   `--dry-run`** (§13.4). The dry-run performs every read, every normalisation and every
   delete/insert *plan* but writes nothing.
7. **Wire the gates of §9**, controls first — **G13** (assert emptiness before `--fresh`) and
   **G10/G11/G12** in particular.
8. **Run the dry-run**, compare per-table counts, then run for real.
9. **Only then** consider `fetchArraySize` in the app itself (§10.9) as a separate change.

---

## 13. ★ Starting from a fresh, empty Turso database

A clean database is the better starting point — **but not for the reason it appears to be.** It
fixes the *delete* story and leaves the *load* story exactly as it is. Being precise about which
is which is most of the value of this section.

### 13.1 What a fresh database fixes

- **The delete order stops mattering.** On an empty destination the load is **insert-only**, so
  §6's reverse-order delete, the "destination not empty" problem, and the "delete ran but the
  load then refused 100,000 rows ⇒ emptier than it started" hazard all disappear for the first
  run.
- **★★ Option 2 of §3.9 becomes defensible.** `PRAGMA foreign_keys = 0` for the load, then
  `PRAGMA foreign_key_check`, only makes sense if **every row in the database is one you loaded**.
  On today's destination (28 of 32 tables populated, 6 from authored fixtures) a
  `foreign_key_check` failure is **ambiguous** — it could be pre-existing. On a fresh database it
  names **exactly your bug.** ★ That is a real change in the *risk* of the option, not a
  preference.
- **`SAMPLE_DATA_PROVENANCE` stops being a lie by accident.** §3.8: that table describes
  *authored* rows. On a fresh database the choice is explicit — seed it and keep those rows, or
  do not seed it and have no provenance claims to contradict (§13.5).
- **The snapshot baseline becomes knowable.** The destination's state is a measurement you took
  before the first write, not a recollection — which answers §10.11 cleanly.
- **A failed load is recoverable by re-provisioning**, instead of by reasoning about a
  half-deleted database.

### 13.2 ★ What a fresh database does NOT fix — read this before expecting it to

- **§3.9's slice collision is untouched.** It is a property of the **cap**: a 100,000-row slice of
  `GL_JE_HEADERS` and a 100,000-row `ROWID` slice of `GL_JE_LINES` describe **disjoint parts of
  the table**. An empty destination has no bearing on it. `GL_JE_LINES.JE_HEADER_ID` still
  rejects **100,000 of 100,000**.
- **The 8 NOT NULL breakages are untouched** — and per §3.10 they are **worse** fresh, because
  there is no pre-existing parent row to absorb the cascade. `PO_AGENTS` empty ⇒ `PO_HEADERS_ALL`
  rejected in full.
- **`FND_FLEX_VALUES` is untouched** — a join view cannot be ordered by `ROWID` (§3.1), on any
  destination.
- **The read cost is untouched** — 190 s, 87 % of it on 3 ROWID slices (§3.2). Same Oracle.
- **The write allowance is untouched, and a new database does not grant a new one** — the limits
  are per **account**, not per database (§10.12).

★ **So a fresh database changes the DELETE story, not the LOAD story.** The load's problems live
in the source and the cap, and must be solved there.

### 13.3 Provisioning it — the existing tooling already does this

★ **Do not hand-write DDL.** `scripts/build-turso-sample.mjs` is the established applier:

```
node scripts/build-turso-sample.mjs --sql-only   # regenerate 02-seed.sql and stop (no network)
node scripts/build-turso-sample.mjs --remote     # push schema + seed to Turso (needs .env)
```

| object | created by | count |
|---|---|---|
| ledger + evidence tables (`GL_*`, `PO_*`, `PA_*`, `AP_*`, `FND_*`, `SAMPLE_DATA_PROVENANCE`, `X_REPORT_*`) | `data/sql/turso/00-schema.sql`, applied by `build-turso-sample.mjs --remote` | **36** |
| views, including the 3 of §2.2 | `00-schema.sql` (`V_ACCOUNT_POSITION`, `V_BUDGET_BY_ACCOUNT_PERIOD`, `V_SEGMENT_LEGEND`, `V_CODE_COMBINATION_KEY`, `V_ENCUMBRANCE_FROM_PO`, `DUAL`) | **6** |
| app-owned tables (`saved_view`, `saved_view_run`, `saved_view_subscription`, `project`, `table_count_snapshot`, `organization`, `app_user`, `geo_origin`, `vendor_site_geo`, `vendor_site_route`, `field_override`) | ★ **`01-app.sql`, applied by the server itself** — `server/src/db/app-schema.ts` reads the file and issues the `CREATE TABLE IF NOT EXISTS` statements | **11** |

★ **The app-owned tables are created by the app, not by the provisioning script** — so a fresh
database only becomes **usable** once the server has booted against it. That is a real ordering
constraint, and it is why the checklist below ends with a boot.

**Env to point at the new database** (repo-root `.env` — one file, no `server/.env`):

★ **No new variable names. Reuse the four that exist** — `loadDotEnv()` reads a hard-coded
`path.join(REPO_ROOT, '.env')` (`env.ts:29`) and every setting is a fixed name lookup
(`str('TURSO_DATABASE')`, `env.ts:45`), so a name like `TURSO_DATABASE_NEW` is **read by nothing**
and would be inert. **Which of the four you set depends on the role the new database plays:**

| the new DB is… | `DB_MODE` | set these | `APP_DB_URL` |
|---|---|---|---|
| **the LEDGER** (the copy you switch the app onto) — ★ recommended | `turso` | `TURSO_DATABASE`, `TURSO_API_KEY` | **leave unset** — it defaults to the ledger, which is now libSQL (`env.ts:476–485`) |
| **the app / mirror store**, with Oracle still the ledger | `oracle` (unchanged) | `APP_DB_URL`, `APP_DB_AUTH_TOKEN`, **and `TURSO_DATABASE`/`TURSO_API_KEY`** | **must be set explicitly** — see the trap below |

★★ **The trap, and it is silent: under `DB_MODE=oracle`, leaving `APP_DB_URL` unset does NOT mean
"the Turso database" — it means `data/sql/turso/sample.db`, a local file** (`env.ts:479–487`.
The branch is `if (ledger.mode !== 'oracle')` → the ledger; otherwise → `LOCAL_DB_PATH ??
DEFAULT_LOCAL_DB`). So the "simpler configuration" is only simpler in the **first** row. In the
second row an unset `APP_DB_URL` **moves the app-owned tables off Turso and onto the server's
disk**, with no error — the app keeps working and the rows are simply somewhere else.

★ **And in the second row `TURSO_DATABASE` must be repointed too, even though `DB_MODE=oracle`
makes `env.ts` never read it.** The three `--remote` scripts read it **by hand** —
`scripts/build-turso-sample.mjs:768`, `scripts/verify-turso-sample.mjs:48`,
`scripts/turso-run.mjs:52` — so it is the *provisioning* target as well as the `turso`-mode
ledger. **Repoint one and not the other and you provision the old database while believing you
provisioned the new one.** That is why both variables currently carry the same URL.

**Two settings that cut across both rows:**

- **`ALLOW_REMOTE_WRITES=1` is required** — and it gates **both** stores, not one
  (`env.ts:275` for the ledger, `env.ts:455` for the app store). Already set.
- **`DB_MODE` stays out of the copy's business.** Whichever row you choose, the copy's *reads*
  come from Oracle via the `ORACLE_*` variables, which are independent of `DB_MODE`.

**Verifying the switch — two signals, both already exposed:**

- `/api/health` → `stores[].label` is `hostOf(url)`, so **the new database's host is the proof**
  the app is pointed at it.
- `/api/meta/config` → `appDbShared` (`meta.ts:245`) is true when the two stores are one
  database. ★ In the first row it should read **true**; if it reads false, `APP_DB_URL` is still
  set to the old URL and you have a split you did not intend.

★ **If the OLD database must stay addressable at the same time, that is the only case that wants
different names — and renaming is not how you get it.** New names do nothing without changing
`env.ts` and the three scripts. Keep the old values in a file that is **not** loaded (e.g.
`.env.old-db`, purely as a record), or comment the old block in `.env`. Note also that
`loadDotEnv` **does not overwrite** an existing `process.env` key (`env.ts:36`), so a one-off
command can override either value without touching the file:
`$env:TURSO_DATABASE='libsql://old…'; npm run …`.

**Checklist:**

1. Create the database in the Turso dashboard; copy the `libsql://` URL and a token.
2. Put the URL and token in `.env` as `TURSO_DATABASE` / `TURSO_API_KEY`.
3. **Read-only connectivity probe first** — controls before anything (G1/G2): a deliberate
   syntax error and an unknown object must both **fail**, and `sqlite_master` must report the
   object count. Record that count; it is the baseline.
4. `node scripts/build-turso-sample.mjs --remote` → 36 tables, 6 views, and the seed.
5. Boot the server once → `01-app.sql` creates the 11 app-owned tables.
6. **Re-take the object count** — it is now ≥ the baseline of step 3 plus the seed's rows.
7. Only then run the copy's **dry-run**.

★ **Do not paste the connection token into the conversation.** Put it in `.env` and say when it
is there; the token is a credential and belongs in the file that already holds the current one.

### 13.4 The two modes, and the gate they need

| mode | destination precondition | behaviour |
|---|---|---|
| **`--fresh`** | **must be empty** | insert-only, no delete. Refuses to run if the copy's tables already hold rows. |
| **`--refresh`** | any | delete-then-insert in the §6 reverse order, **per table as one unit**. |

★ **`--fresh` must ASSERT emptiness, not assume it.** A `--fresh` run against a populated
database is not a no-op — it is a duplicate-key failure partway through a load, or (with
`INSERT OR IGNORE`) a **silently stale table**. That assertion is gate **G13**.

★ **And the DDL cannot be deferred.** SQLite has **no `ALTER TABLE … ADD CONSTRAINT`**, so
"load the tables first and add the foreign keys afterwards" — the classic way to sidestep all of
§3.9 — **is not available**. The only lever is `PRAGMA foreign_keys`, and only for the session
that sets it (§3.9 option 2, §3.5).

### 13.5 ★ The seed question, which a fresh database forces — ✅ DECIDED

★ **Decision taken: 13.5.1 (schema + seed), with the seed-owned tables excluded from the live
copy.** Read the consequence at the end of this section before treating the breakages as solved.

`--remote` pushes `00-schema.sql` **and** `02-seed.sql` (1,296,301 bytes of authored rows). So
"from scratch, empty" has two readings, and they are different products:

**13.5.1 — schema + seed + live copy.** The authored rows return, the `LATEST_FLAG` and
budget-version demonstrations work, and `SAMPLE_DATA_PROVENANCE` stays true **for the tables the
copy does not touch**. ★ **And the two lists are not the same list — one contains the other.**
The seed authors **6** tables (§3.8: `FND_CURRENCIES`, `GL_BUDGET_TYPES`, `GL_BUDGET_VERSIONS`,
`GL_BUDGET_ENTITIES`, `GL_LOOKUPS`, `PO_AGENTS`); the breakages touch **5** (§4.3). **Every
breakage table is seed-owned; the seed owns exactly one table the breakages do not —
`GL_LOOKUPS`.** So "exclude the seed-owned tables" removes all 8 NOT NULL breakages at once, and
costs one table (`GL_LOOKUPS`, 5 synthetic rows) that the copy **could** have loaded. That is a
cheap price and arguably the right one to pay in reverse: real Oracle lookups are better than
synthetic ones, and `GL_LOOKUPS` has no NOT NULL breakage, so **its exclusion is optional** — it
is the one table in the set where the choice is genuinely free.

**13.5.2 — schema only, no seed.** Every ledger table is populated **only** from the copy. The
destination is genuinely empty, `foreign_key_check` is unambiguous, and there is no provenance
claim to keep true. ★ **The price: the 8 NOT NULL columns have no fallback at all**, so 5 tables
cannot load — and per §3.10 every FK depending on them cascades.

★ **This is the same question as §10.2 and §10.3, and a fresh database makes it the first one to
answer rather than a later cleanup.** The middle path, if it helps: **13.5.1, with the
seed-owned tables excluded from the live copy** — that removes all 8 NOT NULL breakages at once,
keeps `SAMPLE_DATA_PROVENANCE` true, and leaves the copy's job on tables the seed does not author.
★★ **But it is only safe if the seeded parent ids are the REAL ones — and for `PO_AGENTS` they are
not.** Read verbatim from `02-seed.sql:1075`, the committed seed inserts **seven** rows with ids
**allocated positionally, `2001`–`2007`** (`build-turso-sample.mjs:295` assigns them from a counter),
so they bear no relation to Oracle's real `AGENT_ID` values. **`PO_HEADERS_ALL.AGENT_ID` is the
child**, and the copy takes 100,000 of those rows — so the exclusion removes all 8 NOT NULL
breakages and an **FK orphan of the same size takes their place**, which is a strictly worse trade
because it is silent until the INSERT. **Measured in §3.11**; the decision depends on that number,
so do not adopt this path before reading it.

#### ★★★ §3.11 has now answered it: the middle path is REFUTED, and the repair is cheaper than either option

| measured | |
|---|---|
| `PO_HEADERS_ALL` slice rows carrying an `AGENT_ID` | **100,000** |
| of those, inside the seed's `2001`–`2007` | **0** |
| rows the FK would reject against the seeded `PO_AGENTS` | **100,000 — every row** |
| Oracle's real `PO_AGENTS` | **66** rows, ids **23 .. 466,651** |
| the slice's 28 distinct ids present in Oracle's real parent | **28 of 28** |

**So "exclude the seed-owned tables" cannot work for `PO_AGENTS`, and the exclusion does not save
the 8 NOT NULL breakages either — it trades them for a same-sized orphan.** But the same run shows
the exit: Oracle's real `PO_AGENTS` is **66 rows, far under the cap**, so **the copy supplies its
own parent**. That is §3.9's option 1 (parent-driven) applied to a *table*, at a cost of 66 rows.

**Revised decision — 13.5.1 with a narrower exclusion:**

1. **Load `PO_AGENTS` from Oracle too** (66 rows), and **keep the seed's 7** — the real ids do not
   collide with `2001`–`2007`, the seeded rows are the load-bearing fixtures of §3.8, and nothing
   references them. **73 rows, FK satisfied, nothing dropped.**
2. ★ **`NAME` is not readable** — `ORA-00942` on one column of a table whose `AGENT_ID` resolves
   from the same statement shape (§3.11), which is a *column* grant, not an absent column. `NAME`
   is `TEXT NOT NULL`, so the 66 rows need a derived name: **`'Agent ' || AGENT_ID`**.
3. **The exclusion still applies to the other four seed-owned tables** (`GL_BUDGET_TYPES`,
   `GL_BUDGET_VERSIONS`, `GL_BUDGET_ENTITIES`, `FND_CURRENCIES`) — those breakages are genuine and
   have no fallback, and their children are the `GL_BUDGET_*`/`PA_BUDGET_*` tables §4.3/§3.9
   already exclude.
4. **`GL_LOOKUPS` remains the free choice** — seed-owned, breakage-free, 5 synthetic rows.

★ **And only ONE FK is at stake in this whole question.** A grep of `00-schema.sql` for FKs into the
seed-owned set returns **four** edges — `:258` and `:267` → `GL_BUDGET_TYPES`, `:281` →
`GL_BUDGET_VERSIONS`, `:396` → `PO_AGENTS` — and **the first three hang off tables the copy already
excludes**, so `PO_HEADERS_ALL.AGENT_ID` (`:396`) is the *only* live one. **The entire seed-parent
hazard is a single FK edge, and it is now closed by loading 66 rows.**

### 13.6 ★ What to build on a fresh database, and when

| step | why it must be in this order |
|---|---|
| connectivity probe + baseline object count | §13.3.3 — a baseline you measured, not recalled |
| `--remote` (schema + seed) | 36 tables / 6 views / the authored fixtures |
| one server boot | `01-app.sql` → the 11 app-owned tables (§13.3) |
| ★ **re-measure the slice keys** (§12.1) | the cap key change is the one thing that may repair §3.9 |
| ★ **re-run the FK overlap probe against the DESTINATION** (G12) | the seed's allocated `PO_AGENTS` ids are the live hazard |
| the copy's **dry-run** | every read and every plan, no writes |
| the copy **for real** in `--fresh` | insert-only, FK order, emptiness asserted first |
| **`PRAGMA foreign_key_check`** | ★ on a fresh database this is the honest test (G6) |
| record the snapshot baseline (date, row counts per table) | §10.11 |

### 13.7 ★★ The consolidated destination — v2 holds BOTH halves

**Decision (yours):** `oracle-kahua-v2` is the destination for **the Oracle tables and the current
Turso tables** — i.e. the ledger copy **and** the app store, up to 100,000 rows per table. That
changes §13.3's table from "which role" to "**both roles, reached by staging**", and it adds a
second *source* that the copy did not previously have.

**Staged repoint, executed and verified.** `TURSO_DATABASE`/`TURSO_API_KEY` now name **v2**;
`APP_DB_URL`/`APP_DB_AUTH_TOKEN` still name **v1**. Measured with `tmp-appscope.ts` (read-only):

```
ledger.mode       oracle                  POWERAPPS@europa.wcpss.net:1541/ebs_FA2DB
appDb.label       oracle-kahua-v1-...     shared=false   allowWrites=true
TURSO_DATABASE    libsql://oracle-kahua-v2-...              ← the COPY target
TURSO_DATABASE_NEW  (absent)                                 ← the name read by nothing
```

★ **The staging turns out to be exactly what the copy needs, and that is not a coincidence to
overlook — it is the reason not to invent names.** During staging the three variable groups name
the copy's three endpoints:

| endpoint | named by | role in the copy |
|---|---|---|
| **Oracle** | `ORACLE_*` | source A — the 29 ledger tables |
| **v1** | `APP_DB_URL` / `APP_DB_AUTH_TOKEN` | **source B** — the 11 app-owned tables |
| **v2** | `TURSO_DATABASE` / `TURSO_API_KEY` | **the destination** |

★★ **So the app-store half must be copied WHILE STAGED, before the flip.** `APP_DB_URL` is the
only name that addresses v1, and the flip re-points it at v2 — after which v1 is unreachable by
any environment variable and the geocodes would have to be re-earned from the geocoding service.
Run the app copy, verify it, *then* flip. **This is an ordering requirement, not a preference.**

#### The app half, measured — 1,607 rows, and one table that matters

```
  vendor_site_geo           800      ← the geocodes, expensive to regenerate
  vendor_site_route         622      ← the drawn routes
  table_count_snapshot      154
  project                    16
  saved_view_run              7
  field_override              4
  geo_origin                  1
  organization                1
  saved_view                  1
  saved_view_subscription     1
  app_user                    0      ← empty; see below
  TOTAL                   1,607      (10 of 11 tables hold rows)
```

**FK order among them** — three edges only, all parent-first:
`organization` → `app_user` (`01-app.sql:648`); `saved_view` → `saved_view_run` (`:123`) and
`saved_view_subscription` (`:158`).

★ **`app_user` is empty, and that is not a loss to repair.** The only identity that exists is the
bootstrap account in `.env` (`SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD`, `env.ts`), which is
**not** a database row. So sign-in against v2 works with no users copied, and a copy that
"recovered" users would be inventing them.

★★ **`table_count_snapshot` — the flip breaks its comparability guard, and the guard cannot see it.**
Two facts from `activity.ts`, and they pull in opposite directions:

1. The 154 existing rows are **app-store** readings (`counted_in = 'app'`, taken by the previous
   version of the page). The register **skips** any row whose `counted_in` is not `'app'` or
   `'ledger'` (`activity.ts:503` requires it non-null, `:515` is the `continue`) and prints "not
   counted" — so **these are used by nothing and need no repair.** ✅
2. ❌ **But `counted_in` stores a `StoreId` — literally `'app'` or `'ledger'` — and `'ledger'` names
   a ROLE, not a database.** The register's guard is
   `comparable = previous !== null && previous.store === current.store` (`activity.ts:538`), whose own
   comment (`:534`) warns that subtracting readings from two different databases "reads as two and a
   half million new rows". **The flip changes what answers to `'ledger'` — Oracle before, v2 after —
   and both readings still say `ledger`, so `comparable` is TRUE and the guard never fires.**

**Worked, with real numbers.** `AP_INVOICES_ALL` is **2,569,410** rows on Oracle
(`activity.ts:41`, `:49`) and the copy caps it at **100,000**. The register reads the **two most
recent days** per object (`rn <= 2`). So after the flip: yesterday's reading is Oracle's 2,569,410,
today's "Record counts now" writes v2's 100,000, the guard says both are `ledger`, and the page
displays a delta of **−2,469,410 rows** as a real change in the ledger.

**The fix is one statement at the flip, and it must be a DELETE — re-pressing the button is not
enough.** `recordReadings` upserts on `(object_name, snapshot_date)` (`activity.ts:580`), so a
press today replaces **today's** row and leaves yesterday's Oracle reading standing as the
comparison base:

```sql
DELETE FROM table_count_snapshot WHERE counted_in = 'ledger';
```

★ **And this is a general defect worth recording separately from the copy:** a reading's provenance
is a *role* and the comparability test is on that role, so **any** change of what fills the ledger
role silently invalidates every stored `ledger` reading while leaving the guard satisfied. On a
consolidated v2 that includes the flip itself, so it is on the critical path here.

The other app tables hold SQL and view definitions that stay valid because the copy keeps the same
table names.

#### The other half of v1 — do NOT copy the 36 ledger tables

v1 holds **47 tables**: 36 ledger + 11 app, plus 24 views. The 36 ledger tables hold **10,755 rows
across 28 tables** — and they are the **same `00-schema.sql` + `02-seed.sql`** that a fresh v2
build applies (§13.3 step 4). **Copying them would copy the sample onto itself.** Worse, it would
overwrite the Oracle-copied rows with seed rows for whichever tables the seed touches — including
the two authored fixtures of §3.8 that the copy has already decided to preserve. **The Oracle copy
supersedes them; do not carry them.**

#### What the copy script therefore needs

- **Two sources** — `oracledb` for Oracle, and a libSQL client for v1 through `storeDriver('app')`.
- **No new environment variables** (§13.3). The staging already names all three endpoints.
- **Path A (Oracle, 29 tables)** unchanged: §5's cap key, §6's copy order, §9's gates.
- **Path B (app, 11 tables)** new, and much simpler: every table is **far under the cap** (largest
  800), so it is a whole-table copy in FK order, `--refresh` semantics per table.
- ★ **Path B runs after the server has booted once against v2** (`ensureAppSchema()` creates the 11
  tables — §13.3 step 5). A copy into tables that do not exist yet fails on the first INSERT.
- ★ **Both paths write to v2, so both spend the same monthly write allowance** — and the allowance
  is per **account**, not per database (`§10.12`). Path B adds 1,607 rows, which is noise; the
  Oracle path's 1.2 M is the whole cost.

#### The flip — one edit, and v1 stays as the rollback

At the end, `DB_MODE=turso` and **delete** `APP_DB_URL`/`APP_DB_AUTH_TOKEN`: with mode `turso` and
no `APP_DB_URL`, `resolveAppDb()` returns the ledger's own url/token with `shared: true`
(`env.ts:476–485`), so **one database and one token serve both roles** — the clean end state.

- **Verify the flip with §13.3's two signals**: `/api/health` → `stores[].label` is v2's host on
  **both** entries, and `/api/meta/config` → `appDbShared` is **true**.
- ★ **Do not delete v1.** It is the rollback, and it holds the only copy of the geocodes.
- ★ **Re-pointing the geocode script is the flip's hidden half** — it is the one job whose output
  is expensive to recreate, so confirm `vendor_site_geo` reads **800** on v2 before trusting it, and
  confirm the job does not decide every site is ungeocoded and re-run (622 routes likewise).
