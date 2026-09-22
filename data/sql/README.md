# Oracle budget queries — Budgets, Budget Adjustments, Budget Changes

**Read-only.** Every statement in every file here is a `SELECT`. There is no `INSERT`,
`UPDATE`, `DELETE`, `MERGE`, or DDL anywhere in this folder. Nothing here can change your data.

Written against the **EBS base tables** listed in [`../oracle/db-schema.md`](../oracle/db-schema.md).

These files read the base tables directly — `APPS.GL_BALANCES`, `APPS.PO_HEADERS_ALL`,
`APPS.PO_DISTRIBUTIONS_ALL` and so on. An earlier revision named the `WCSEXP_*`
compatibility views instead; those are **retired**, and no statement in this folder or in
[`turso/queries/`](turso/queries/) reads one.

**Do not read that as "the `WCSEXP_*` names are better".** Two of the three column differences
an earlier revision praised were wrong, and one of them was wrong in the direction that hides a
bug:

| Older claim | Measured |
|---|---|
| `GL_BALANCES.LEDGER_ID` is an improvement over `SET_OF_BOOKS_ID` | Correct. The table has `LEDGER_ID`. |
| `AP_INVOICE_PAYMENTS_ALL.PAYMENT_DATE` is an improvement over `CHECK_DATE` | **Wrong.** The table has no `PAYMENT_DATE`. It has `ACCOUNTING_DATE` and `CREATION_DATE`; the check date is `WCSEXP_AP_CHECKS.CHECK_DATE`. |
| `AP_INVOICE_DISTRIBUTIONS_ALL.CODE_COMBINATION_ID` | Unconfirmable — that table is **not granted**. The view calls it `DIST_CODE_COMBINATION_ID`. |

**Retired is a description of these files, not of the database.** Measured on `europa` by
reading `USER_TAB_PRIVS`, the `POWERAPPS` account still holds `SELECT` on all eighteen `WCSEXP_*`
views — and the grant list is **51 rows**, every one of them `SELECT`. That matters for one
family only: **invoice lines and invoice distributions have no base table route.**
`AP_INVOICE_LINES_ALL` and `AP_INVOICE_DISTRIBUTIONS_ALL` return `ORA-00942`,
while `WCSEXP_AP_INV_LINES` and `WCSEXP_AP_INV_DISTRIBUTIONS` read normally — so an invoice
query that has to reach its purchase order, or an accounting combination per invoice line, has
to use the view.

The consequence is recorded rather than worked around: **the AP half of `04-spend-and-actuals.sql`
is parked.** Eight of its fifteen statements do not compile, and the parked note at the top of
that file lists each one with its cause. The ask, if it is ever wanted, is `SELECT` on two
objects: `AP.AP_INVOICE_LINES_ALL#` and `AP.AP_INVOICE_DISTRIBUTIONS_ALL#`. Everything else in
this folder runs against grants that already exist.

Every table reference is qualified with the **`APPS.`** schema (e.g. `APPS.GL_BALANCES`),
because that is the owner the extract objects resolve under. Oracle's data-dictionary views
(`ALL_TABLES`, `ALL_VIEWS`, `ALL_TAB_COLUMNS`) are deliberately left **unqualified** — they are
`SYS`-owned and are always referenced bare.

---

## SQLite / libSQL ports

The five files below are written for Oracle against the production instance. Ports of them that
run against the sample database in [`turso/`](turso/) — same filenames, same statement count,
same comment section labels — live in [`turso/queries/`](turso/queries/). See
[`turso/README.md`](turso/README.md) for the translation rules and the two places where the
output differs.

**The files here are the artefacts of record.** They are not edited to match the ports — with
one deliberate exception: the `WCSEXP_*` → base-table repoint was applied to **both** the files
here and their ports, because leaving the originals on retired object names would have made the
pair disagree about what the database contains. That was a one-off correction, not a policy.

---

## Run order

| # | File | What it answers | Windowed? | Run it? |
|---|---|---|---|---|
| 1 | `00-discover.sql` | **Does this instance hold budget data at all?** | Only C, and the `B.windowed` companion. Deliberate — see below. | **Yes — always run this first.** |
| 2 | `01-budgets.sql` | The budget figures themselves | Yes, except the extent and per-version queries | Only if discovery B found `ACTUAL_FLAG='B'` |
| 3 | `02-budget-adjustments.sql` | Budget journals = the adjustment log | Yes, except A0 (the size check) | Only if discovery D found `'B'` journals |
| 4 | `03-budget-changes.sql` | Budget movement over time | Yes, all of it | Only if 01 or 02 returned data |
| 5 | `04-spend-and-actuals.sql` | Billed / paid — is "committed" the same as "spent"? | GL queries only. The PO and AP queries are all-time on purpose. | Independent — run any time. **The AP half is parked — 8 statements do not compile against the base tables.** |

**On the parked AP half — the asymmetry is the whole story.** The eight statements that will not
compile address `AP_INVOICE_LINES_ALL` and `AP_INVOICE_DISTRIBUTIONS_ALL`, and both raise
`ORA-00942`. The `WCSEXP_*` AP views, reading the same data, answer normally — 19 of them, under
this login. So "the AP half is parked" is a statement about two unreadable base tables, **not**
about AP being unavailable; anything the parked statements were reaching for is reachable through
`WCSEXP_AP_INVOICES`, `WCSEXP_AP_INV_LINES`, `WCSEXP_AP_INV_DISTRIBUTIONS`,
`WCSEXP_AP_INVOICE_PAYMENTS` and `WCSEXP_AP_CHECKS`. Read the grain warning under
[AP access](#ap-access) before joining the payments view.

The AP checks extract is pulled by a script rather than a SQL file, because it writes JSON the app
reads: `npm run pull:ap` in `server/` runs `server/scripts/pull-ap-extract.mjs`, which derives its
window from `GL_PERIODS`, asserts four invariants, and writes `data/oracle/checks.json`.

**If `00-discover.sql` section B shows no `ACTUAL_FLAG = 'B'` rows, stop there.** Sections 2–4
would return nothing, and the discovery output is then the complete and useful answer.

**`SEGMENT5` is now confirmed from the data dictionary, not inferred.** Every project-level
query in files 01–03 assumes `SEGMENT5` is the project identifier. That was originally inferred
from `DESCRIPTION` text in the purchase-order extract. `00-discover.sql` section G now reads it
directly: the accounting flexfield (`GL#`, structure `ACCOUNTING_FLEXFIELD`) has seven segments
and the fifth is named **`Level`**, with value set `1002649`. The delimiter is `.`, which
matches the concatenated combination strings these files see. Section H remains the empirical
cross-check on real rows — if H ever shows `SEGMENT5` is constant, the identifier is a different
segment and the `GROUP BY` clauses in 01–03 must change before the results mean anything.

Sections within each file are independent. You can run them one at a time, and you can stop
at any point.

---

## Reporting window — FY2025 to FY2027

Every GL query in `01`–`04` is restricted to the **newest three fiscal years**, expressed as:

```sql
period_year >= (SELECT MAX (period_year) - 2 FROM apps.gl_periods)
```

**The window is DERIVED, never a literal.** An earlier revision of these files carried
`period_year >= 2023` as a hard-coded floor. That was correct for exactly one fiscal year and
then silently widened: as new periods accumulated it became a four-year window, then five. The
subquery cannot go stale, because it moves with the ledger.

**The fiscal calendar is July–June with thirteen periods.** `PERIOD_YEAR` is a *fiscal* year, so
the window is:

| Fiscal year | Dates | Periods |
|---|---|---|
| FY2025 | 2024-07-01 → 2025-06-30 | 13 |
| FY2026 | 2025-07-01 → 2026-06-30 | 13 |
| FY2027 | 2026-07-01 → 2027-06-30 | 13 |

39 periods. On the measured instance that is `2024-07-01 .. 2027-07-01` exclusive.

**Note the count.** "The last three years" is three fiscal years here, not two. The distinction
is not pedantic: on `GL_BALANCES` the two-year window keeps 15,711,625 rows and the three-year
window keeps 26,214,388 — about 10.5 million rows more, or 16.7% of the table against 10.0%.

### Where it is applied, and where it deliberately is not

| | Windowed? | Why |
|---|---|---|
| GL queries (`01`, `02`, `03`, and `04` S5/S6) | Yes | A GL balance carries `PERIOD_YEAR`, so a window narrows a time series |
| `04` S1–S4, S7 (PO and AP) | **No** | A purchase order has no period. Money accrues against it long after creation: of the 8,870,249,782 billed dollars in `PO_DISTRIBUTIONS_ALL`, only **548,258,765 — 6.2%** — sit on orders created inside the window. A `CREATION_DATE` cut would report that almost nothing has been spent. |
| `01` B5.2/B5.3/B6, `02` A0, `04` S0 | **No** | These measure *extent* — how big the ledger is, how many years it spans, whether a table holds anything. A windowed extent query answers a question about the window while appearing to answer one about the ledger |
| `00` A–B, D–H | **No** | Same reason, and it is the whole point of that file. A windowed section B would report "no budget" for a ledger whose budget is simply older than the window, and everything downstream is gated on B. `00` C and the `B.windowed` companion are the exceptions and are marked as such |

`B.windowed` is a **companion to B, not a correction of it**. B sizes the ledger; `B.windowed`
sizes the window inside it. Running both is what tells you whether the window is a filter or a
truncation: if `'B'` appears in B and not in `B.windowed`, there *is* a budget and it ends
before FY2025.

### Why the SQLite ports are not windowed

The ports in [`turso/queries/`](turso/queries/) must **not** be given this predicate. The sample
database's budget rows sit in fiscal 2023 across twelve *calendar* periods — the sample is a
calendar ledger, the instance is a July–June one, and the seeded figures exist only outside the
window. Applying the window there would empty the queries and break the gates that verify the
sample. The divergence is intentional and permanent.

---

## Why `ACTUAL_FLAG` is the whole question

Oracle GL keeps **all three balance types in one table** — `GL_BALANCES` — discriminated by
`ACTUAL_FLAG`:

| `ACTUAL_FLAG` | Meaning |
|---|---|
| `A` | Actuals (posted actual activity) |
| `B` | **Budget.** This is Oracle's budget storage. |
| `E` | Encumbrance (purchase-order commitments) |

So "is there a budget in Oracle?" is literally "are there rows where `ACTUAL_FLAG = 'B'`?".
That is section B of `00-discover.sql`, and it is the only question that must be answered
before the rest is worth running.

The schema doc also lists `BUDGET_VERSION_ID` **as part of `GL_BALANCES`' composite key** —
which is what a version-scoped budget table looks like. It is not a stray column.

---

## What to send back

Raw output is fine — paste it as-is. If you'd rather trim, the useful parts are:

| From | Keep |
|---|---|
| `00-discover.sql` A | Every row. This is small and tells us what exists. |
| `00-discover.sql` B and `B.windowed` | Every row. **The single most important result** — and the pair is what separates a filtered window from a truncated one. |
| `00-discover.sql` C | Every row. Now windowed, so it answers "which versions does the picker offer?" rather than "which versions exist?" — B has the second answer. |
| `00-discover.sql` F, G, H | Every row. G is now the authority on the seven segments; H cross-checks it against real rows. |
| `01-budgets.sql` | All of B1, B2, B3, B5, B6. For B4 (per project) the top ~40 rows by amount. |
| `02-budget-adjustments.sql` | All of A1, A3, A4, A5.2, A6. For A2 (raw journals) the first ~30 rows. |
| `03-budget-changes.sql` | All of it — every query here is already aggregated and small. C5 now derives its three fiscal-year columns from the ledger rather than naming them. C2 returns no rows when there is only one budget version; that is expected, not a failure. |
| `04-spend-and-actuals.sql` | The GL and PO statements in full; they are small. **Skip S0's invoice legs, S3, S3.3, S4, S4.2 and S7.2 — they cannot run without a grant.** |

If a statement errors, **send the error text** — it is a result. `ORA-00942` in particular
means that object doesn't exist, which is exactly what discovery is trying to find out.

---

## Known traps in this schema

**`ORA-00942: table or view does not exist`** — every table here is already written as
`APPS.<TABLE>`. If a statement still fails, the owner is something else: try
`WCS.GL_BALANCES`, or run section A first and use the `OWNER` it prints. Note that section A
inspects `ALL_TABLES` **and** `ALL_VIEWS`, so it will also say whether any `WCSEXP_*` view is
still reachable in your instance — useful if you ever need the old vocabulary back.

**★ Section A under-reports on `europa`, so do not stop on its answer.** Measured: section A
returns **0 rows** for both `ALL_TABLES WHERE table_name = 'GL_BALANCES'` and
`ALL_TABLES WHERE table_name LIKE 'GL_%'`, and 0 rows from `ALL_TAB_COLUMNS`, on an instance
where `SELECT COUNT(*) FROM APPS.GL_BALANCES` succeeds. The cause is vocabulary, not absence:
`APPS.GL_BALANCES`, `APPS.PO_HEADERS_ALL` and `APPS.AP_INVOICES_ALL` are **synonyms** owned by
`APPS` that resolve to `#`-suffixed objects in the product schemas (`GL.GL_BALANCES#`,
`PO.PO_HEADERS_ALL#`, `AP.AP_INVOICES_ALL#`), and that is the name the grant is recorded under —
`USER_TAB_PRIVS` lists `GL_BALANCES#`, not `GL_BALANCES`. Synonyms are not surfaced by
`ALL_OBJECTS` either. So on this instance the two dictionary views that *do* describe what you
can actually read are **`USER_TAB_PRIVS`** (51 rows, the real granted list) and
**`ALL_SYNONYMS`** (which resolves each name to its target). A "no budget tables" answer from
section A alone can be wrong; cross-check it against those two before concluding anything.

**Top-N is done with a `ROWNUM` wrap, not `FETCH FIRST`.** Oracle 11g (still common on EBS)
does not support `FETCH FIRST n ROWS ONLY`. Every capped query here wraps an ordered subquery
and filters `WHERE ROWNUM <= n`, which works on every version:

```sql
SELECT * FROM ( SELECT ... ORDER BY x DESC ) WHERE ROWNUM <= 50;
```

**`PERIOD_NAME` is a string like `Jul-26-FY-27`, and this README used to say `JAN-25`.** That
example was wrong, and it was wrong in a way that would have led to a broken filter: the format
is `<Mon>-<YY>-FY-<YY>`, the period set is July–June, and the year component is the fiscal year,
not the calendar one. Minor trap: everything here orders by `PERIOD_YEAR, PERIOD_NUM`, which are
real numbers, and matches periods through a subquery on `GL_PERIODS` rather than by string.

**`SUMMARY_FLAG`.** Rollups join `GL_CODE_COMBINATIONS` and filter `SUMMARY_FLAG = 'N'` so
summary (parent) accounts cannot double-count against their detail children. If that column
turns out to be all-`N` the filter is harmless; if it isn't, it prevents inflated totals.

**`AMOUNT_ORDERED` is not in the schema doc** but *is* present in the sample
`inv-distributions.json`. Where a query could use it, the documented columns are used instead
and the alternative is noted in a comment.

**Row caps.** `GL_BALANCES` and `PO_DISTRIBUTIONS` can be large. Counts come before sums in
each file so you can see the size before committing to the big query.

---

## Two things this is testing beyond "the number"

**1. Coverage.** The sample extract already shows a real defect: only **196 of 328**
purchase-order account combinations had a matching `GL_CODE_COMBINATIONS` row, and the
unmatched 132 carry **80% of the money**. `01-budgets.sql` section B5 tests whether the same
gap exists on the budget side. If it does, per-project budgets will be incomplete and the
missing share needs to be surfaced in the UI rather than silently dropped by the join.

**2. Whether "committed" means "spent".** The app currently tells users that Oracle supplies
no invoice or payment figure. The schema disagrees — `AP_INVOICES` carries `INVOICE_AMOUNT`,
`AMOUNT_PAID` and `PAYMENT_STATUS_FLAG`, and `PO_DISTRIBUTIONS` carries `AMOUNT_BILLED`
alongside `ENCUMBERED_AMOUNT`. `04-spend-and-actuals.sql` settles it.

---

## Interpreting what comes back

| Result | Conclusion |
|---|---|
| `00` B shows no `'B'` rows | No budget in Oracle for this ledger. Approved-budget figures must be entered in the app. |
| `00` B shows `'B'` rows | The budget is real and extractable. `01` yields it. |
| `00` C shows **one** `BUDGET_VERSION_ID` | A single budget — no version picker needed. |
| `00` C shows **several** | Version-to-version comparison is available; that is `03-budget-changes.sql` C1. |
| `00` D shows `'B'` journals | Adjustments are recoverable as documents, with dates and amounts. |
| `00` D shows `'B'` headers but **no** lines | Adjustments are only visible as period movement, not as individual entries. |
| `01` B5 `unmatched_amount` is non-zero | Budget cannot be attributed to every project. Report the gap; do not drop it. |
| `04` S1/S2 show non-zero billed/paid | The "committed is not spent" notice in the UI is wrong and must be rewritten. |
| `00` A finds no `GL_BUDGET_VERSIONS` | **Not a finding — section A under-reports.** The table exists and section F reads it (2 rows on the measured instance). See the `★` trap above before concluding anything from A. |
| `00` F shows the budget versions are all old | The ledger has budget versions but none recent. `00` C, being windowed, will show nothing — that is truncation, not absence. |
| `00` G names segment 5 `Level` | Confirms the project identifier from the dictionary. Matches every `GROUP BY` in 01–03. |
| `00` `B.windowed` is empty but B is not | The budget exists and predates FY2025. Every windowed measure in `01`–`04` will read zero; use B's all-time figures instead. |
| `00` H **confirms** `SEGMENT5` holds the project | The mapping is right and the project queries in 01–03 are valid as written. |
| `00` H shows `SEGMENT5` is **constant** | The project identifier is another segment. Every `GROUP BY` in 01–03 must change first. |
| `00` H.3 shows more than one `CHART_OF_ACCOUNTS_ID` | A combination id is unique only within its chart; the joins need that column added. |
| `01` B1 shows movement in many periods | The budget is period-phased, not a lump sum — the UI has no column for that yet. |
| `01` B2's two columns differ | Same cause: the budget is phased. Use `sum_of_period_movement`, not `sum_of_begin_balances`. |
| `02` A4 shows **increases only** | The budget is append-only; the UI needs no signed display. |
| `02` A6's two totals **disagree** | One of the two views is incomplete. Compare against `01` B5.1 to see which. |
| `02` A5.2 returns rows | A budget journal does not balance — the export is partial, not the data. |

---

## AP access

The invoice half of `04` is parked behind a grant. Two objects are needed and are not held:

| Needed | For |
|---|---|
| `SELECT` on `AP.AP_INVOICE_LINES_ALL#` | Invoice line detail — the PO bridge at line level |
| `SELECT` on `AP.AP_INVOICE_DISTRIBUTIONS_ALL#` | The accounting combination per invoice line — the only route from an invoice to a project |

Five granted `WCSEXP_*` AP views already answer most of this and are the substitutes until the
grant arrives: `WCSEXP_AP_INVOICES` (2,569,410 rows), `WCSEXP_AP_INV_LINES` (6,239,904),
`WCSEXP_AP_INV_DISTRIBUTIONS` (6,928,672), `WCSEXP_AP_INVOICE_PAYMENTS` (2,653,590) and
`WCSEXP_AP_CHECKS` (1,246,676). The views are the *workaround*, not the goal — a view is
somebody else's opinion about a table, and `04` is a file about what the tables actually hold.

**One defect does not need the grant.** `04` S4 and S4.2 read `AP_INVOICE_PAYMENTS_ALL`, which
*is* granted, and reference `k.payment_date`, which does not exist. The column is either
`ACCOUNTING_DATE` (when Payables accounted for the payment) or `WCSEXP_AP_CHECKS.CHECK_DATE`
(when the cheque was cut). Which one "payments actually made" means is a question about the
report, so it is left open in the file rather than settled by a substitution.

### The grain of `WCSEXP_AP_INVOICE_PAYMENTS` — check it before joining

`WCSEXP_AP_INVOICE_PAYMENTS` has four columns and no amount:

```
INVOICE_PAYMENT_ID   NUMBER   -- the only unique column
INVOICE_ID           NUMBER
PAYMENT_NUM          NUMBER
CHECK_ID             NUMBER
```

It is a **surrogate-keyed link table, not payment detail**. It carries no `AMOUNT` and no
`PAYMENT_STATUS_FLAG` (that flag is on `WCSEXP_AP_INVOICES`), and it is **not unique on
`(CHECK_ID, INVOICE_ID, PAYMENT_NUM)`**:

| Measure | Count |
|---|---|
| Rows | 2,653,590 |
| Distinct `(CHECK_ID, INVOICE_ID)` | 2,565,822 |
| Duplicate rows | **87,768** |
| Distinct `PAYMENT_NUM` values | `1` → 2,653,579, `2` → 11 |

So `PAYMENT_NUM` cannot discriminate and two rows for one check and one invoice differ **only**
in `INVOICE_PAYMENT_ID` — both are real payment records for the same check paying the same
invoice, and the invoice still appears on that check once.

The cost of joining it raw, measured on the FY2026 AP extract: the link list came out at 10,388
rows instead of 9,451, and the invoice total on the affected checks came out at roughly double.
Check `1063608` (VERIZON WIRELESS, `2026-07-15`, `$58,028.79`) reported **522** invoices summing
to `$115,980.90` — a `$57,952.11` "unexplained difference" that was pure double counting. 937 of
the 4,218 checks in the window carried at least one such duplicate.

Collapsing to distinct `(CHECK_ID, INVOICE_ID)` is the fix, and it is corroborated rather than
merely plausible: checks whose invoices sum to the check exactly rise from **4,113 of 4,218** to
**4,140**, and every one of the 78 that still disagree falls *short*, never over. Check `1063608`
settles at 261 invoices, `$57,990.45`, and a residual of `$38.34`.

`COUNT(*)` against `COUNT(DISTINCT natural_key)` is the one query that catches this class of
error, and it belongs **before** any aggregate is trusted. A total that reconciles *approximately*
is not evidence the join is right: 97.5% looked like a plausible real-world figure and was an
artefact of the fan-out.

---

## Scope note

These queries target the **GL** budget mechanism only, because that is what the schema
supports. A "Schedule of Values" is still not buildable: `db-schema.md` contains no contract
table and no `CONTRACT_ID`, so there is nothing to schedule values against. Budget
*adjustment approval workflow* is likewise app-side — the extract has no approval trail.

**Projects are not in Oracle.** `PA_PROJECTS_ALL`, `PA_TASKS`, `PA_BUDGET_VERSIONS` and
`PA_BUDGET_LINES` are all granted and all return **zero rows**: the Projects module has not been
implemented on this instance. `PROJECT_ID` and `TASK_ID` are `NULL` on every one of the
1,141,913 `PO_LINES_ALL` rows and all 1,159,988 `PO_DISTRIBUTIONS_ALL` rows. So a project is
identified by its **account level — `GL_CODE_COMBINATIONS.SEGMENT5`**, confirmed by section G
to be the segment named `Level` — and by nothing else. The master list of those levels is an
application table, not an extract, and lives in
[`turso/01-app.sql`](turso/01-app.sql) as `project`.
