# Plan — Turso Sample Oracle-EBS Schema

**Status:** DRAFT — awaiting approval
**Author:** Copilot
**Date:** 2026-09-17
**Goal:** a stand-in Oracle EBS 12.2 schema you can actually query, seeded with several rows of sample data, so the report SQL and the app can be tested without Oracle privileges.

> **Status note (added retrospectively):** the plan below was executed, and its object lists name
> the `WCSEXP_*` views as they stood at the time. Those views are **retired** — the sample now
> defines 36 base tables named as EBS names them (`PO_HEADERS_ALL`, `GL_BALANCES`, ...) and the
> queries read those directly. Strip the `WCSEXP_` prefix from any object named below, and check
> the `_ALL` suffix on the PO and AP tables. See the banner in
> [`../../data/oracle/db-schema.md`](../../data/oracle/db-schema.md) for the full map.

---

## 1. Direct answer

**Yes, this is possible — with one honesty caveat that shapes every decision below.**

This is a **surrogate, not a replica**. It reproduces the *shape and semantics* of the standard EBS objects — the column names, the `ACTUAL_FLAG` discriminator, the segment layout, the join keys — but not Oracle's internals. A query that works here will almost certainly work on Oracle; a query that works on Oracle will need translation to run here. That asymmetry is the whole point, and §3 is where it bites.

**Second caveat, more important than the first:** Turso is SQLite. SQLite **cannot define SQL functions in SQL** — they can only be registered by the client that opens the database. That single fact forks the plan in two (§4).

---

## 2. What "standard Oracle 12.2 tables" means here

Two tiers. Keeping them separate matters, because the tiers have very different reliability.

### Tier 1 — extract-proven (fidelity you can trust)

These column lists came out of real extracts in `data/oracle/`, and `data/oracle/db-schema.md` documents them. They are ground truth.

| Object | Rows available | Source file |
|---|---|---|
| `WCSEXP_GL_CODE_COMBINATIONS` | 320 + 192 + 20 → **380 distinct CCIDs** | `json-output.json`, `json-output-v2.json`, `cost-center.json` |
| `WCSEXP_GL_BALANCES` | **none extracted** — see §5 | — |
| `WCSEXP_GL_JE_HEADERS` / `WCSEXP_GL_JE_LINES` | **none extracted** | — |
| `WCSEXP_GL_LOOKUPS` | none | — |
| `WCSEXP_FND_ID_FLEX_STRUCTURES` | none | — |
| `WCSEXP_PO_HEADERS`, `WCSEXP_PO_LINES` | **2,782 lines** | `full-output.json` |
| `WCSEXP_PO_DISTRIBUTIONS` | 20 | `inv-distributions.json` |
| `WCSEXP_PO_LINE_LOCATIONS`, `WCSEXP_PO_VENDORS`, `WCSEXP_PO_AGENTS` | derived | `full-output.json` |
| `WCSEXP_AP_INVOICES`, `WCSEXP_AP_INV_LINES` | none extracted | — |

### Tier 2 — standard objects, authored from EBS knowledge

No extract exists, so these are built from the published EBS 12.2 definitions. They are **structurally accurate but not verified against your instance.**

```
GL   GL_LEDGERS, GL_CODE_COMBINATIONS, GL_BALANCES, GL_PERIODS, GL_PERIOD_SETS,
     GL_CURRENCIES, GL_JE_HEADERS, GL_JE_LINES,
     GL_BUDGET_ENTITIES, GL_BUDGET_TYPES, GL_BUDGET_VERSIONS, GL_BUDGET_ASSIGNMENTS
FND  FND_CURRENCIES, FND_ID_FLEX_STRUCTURES, FND_ID_FLEX_SEGMENTS,
     FND_SEGMENT_ATTRIBUTE_VALUES, FND_FLEX_VALUES, FND_FLEX_VALUES_TL
PO   PO_HEADERS_ALL, PO_LINES_ALL, PO_LINE_LOCATIONS_ALL, PO_DISTRIBUTIONS_ALL,
     PO_VENDORS, PO_VENDOR_SITES_ALL, PO_AGENTS, PO_LINE_TYPES
AP   AP_INVOICES_ALL, AP_INVOICE_DISTRIBUTIONS_ALL, AP_INVOICE_PAYMENTS_ALL
PA   PA_PROJECTS_ALL, PA_TASKS, PA_BUDGET_VERSIONS, PA_BUDGET_LINES
```

`PA_*` is included because the report's *Project* reading (§1 of `report-findings.md`) may resolve there rather than in GL. It costs four tables to keep both doors open; the plan does not assume which one wins.

### Naming

Tier 2 tables get their **real Oracle names**, because the report SQL in `report-findings.md` §11.6/§11.7 is written against them (`GL_BALANCES`, `GL_CODE_COMBINATIONS`, …). The `WCSEXP_` views are the extracts' own names; they get created as **views over the real tables** so both spellings resolve. The EBS `#` shadow-table distinction (`APPS.X` → `X.X#`) is represented by a `shadow_` prefix convention documented in the schema header — it is a synonym mechanism, not a data difference, so it does not need real tables.

---

## 3. Dialect reality check — probe results

I ran two throwaway probes against `node:sqlite` before writing this. These are **measured**, not assumed. Both probes included a deliberately broken statement and a missing object, both of which failed as required — so a pass below means something.

### 3.1 Shimmed successfully ✅

| Oracle construct | Mechanism | Verified result |
|---|---|---|
| `NVL(a, b)` | `db.function('nvl', {varargs:true}, …)` | `nvl(NULL,0)+1` → `1` |
| `DECODE(expr, k, v, …, default)` | `db.function('decode', {varargs:true}, …)` | `decode('B','A','actual','B','budget','other')` → `budget`; `'Z'` → `other` |
| `TO_CHAR(n, 'FM999,999,990.00')` | `db.function('to_char', {varargs:true}, …)` | `to_char(1234.5,'FM999,999,990.00')` → `1,234.50` |
| `LPAD(x, n, '0')` | `db.function('lpad', …)` | `lpad(7,2,'0')` → `07` |
| `FROM dual` | `CREATE VIEW dual AS SELECT 'X' AS dummy, datetime('now') AS sysdate` | `SELECT 1 FROM dual` → `1` |
| `SYSDATE` | **a real column on the `dual` view** | `SELECT SYSDATE FROM dual` → `2026-09-18 02:58:27` |

### 3.2 Native already — no shim needed ✅

`SUBSTR`, `INSTR`, `LENGTH`, `ROUND`, `ABS`, `MOD`, **`TRUNC`**, `||` concatenation, `CASE WHEN`, `WITH` CTEs, `ROW_NUMBER() OVER (…)`, `SUM(…) OVER (…)`, `GROUP BY … HAVING`, `COUNT(DISTINCT …)`.

`TRUNC` was the surprise — SQLite's math functions are compiled in (`pi()` returns `3.14159…`), so `TRUNC(1.9)` → `1` and `TRUNC(-1.9)` → `-1` with no shim at all.

> ⚠️ **But `TRUNC` is a trap.** The built-in is arithmetic, not date-aware. `date(TRUNC(SYSDATE))` **returns NULL silently** — no error, no warning. Any Oracle query using `TRUNC(SYSDATE)` for "today at midnight" must use a registered date-aware `trunc` shim instead, or it will quietly produce a null date. This is exactly the kind of silent-wrong-answer the whole exercise is supposed to prevent.

### 3.3 Cannot be shimmed — must be rewritten ❌

| Oracle construct | Why it fails | Fix |
|---|---|---|
| **`ROWNUM`** | Not a column, not a function. `SELECT ROWNUM FROM dual` → `no such column: ROWNUM`. A scalar `rownum()` function exists but **returns 1 for every row** — it cannot see its position. | Rewrite to subquery + `LIMIT n`. **This affects 4 of the 6 files in `data/sql/`.** |
| `CONNECT BY` | Parse error. Hierarchical query support is engine-level. | Recursive CTE, or flatten in the seed. |
| `(+)` outer join | Parse error. | `LEFT JOIN`. |
| `SYS_CONTEXT(...)` | No such function. | Substitute the literal value (e.g. the schema/user name). |
| `FETCH FIRST n ROWS ONLY` | Not SQLite syntax. | `LIMIT n`. |
| `MERGE` | Not SQLite syntax. | `INSERT … ON CONFLICT DO UPDATE`. |

**Controls confirmed:** `SELECT FROM WHERE ((` and `SELECT 1 FROM dbo.no_such_table` both error as required.

### 3.4 The `ROWNUM` rewrite is safe, and here is why

Oracle's `WHERE ROWNUM <= n` is applied **before** the sort. The `data/sql/` files already wrap an ordered subquery, so `SELECT * FROM (SELECT … ORDER BY …) WHERE ROWNUM <= 5` ports **exactly** to `SELECT * FROM (SELECT … ORDER BY …) LIMIT 5`. Verified: ordering is preserved (returns `10, 20, 30`, not insertion order).

`data/sql/README.md` states the top-N convention is a `ROWNUM` wrap deliberately, because Oracle 11g lacks `FETCH FIRST`. That policy is **correct for the Oracle files and wrong for the Turso copies** — so the port is a mechanical, auditable substitution rather than a semantic change. (Note this also means the `FETCH FIRST 1 ROW ONLY` used in `report-findings.md` §11.6/§11.7 contradicts the README's own policy; flagged as a separate open item, not fixed here.)

### 3.5 Client availability — measured

| Package | Status |
|---|---|
| `node:sqlite` | **FOUND** — `DatabaseSync`, `.function()`, `.aggregate()`, `.prepare()` all present |
| `@libsql/client` | not installed |
| `libsql` | not installed |
| `better-sqlite3` | not installed |
| `turso` CLI | not installed (`Get-Command` empty) |
| `sqlite3` CLI | not installed |

`node:sqlite` is enough to build and verify everything locally **with zero installs**. It emits an `ExperimentalWarning`, which is cosmetic. The `turso` CLI is only needed for the optional remote-push step.

---

## 4. The fork: two query dialects, on purpose

Because shims live in client code, **the compat dialect only works through our own runner.** Typing the same SQL into the Turso dashboard or `turso db shell` would fail on `NVL`. So the plan ships both dialects rather than pretending one covers everything.

| | **A — Compat mode** | **B — Portable mode** |
|---|---|---|
| File | `data/sql/*.sql` (copied, mechanically de-`ROWNUM`ed) | `data/turso/queries/*.sql` |
| Runs via | `scripts/turso-run.mjs` (registers shims first) | anywhere — local, Turso shell, dashboard |
| Uses | `NVL`, `DECODE`, `TO_CHAR`, `FROM dual` | `COALESCE`, `CASE`, `printf`, `strftime` |
| Value | **proves the existing Oracle SQL is correct** against known data | becomes the app's real query set |
| Limit | not usable outside our runner | no longer portable back to Oracle |

Mode A is the validation harness. Mode B is the product. `db/ORACLE_NOTES.md` holds the side-by-side mapping so either can be reconstructed from the other.

The `GL_BALANCES` correctness rules carry into **both** modes as real constraints, not comments — the five non-optional filters (`ledger_id`, `actual_flag='B'`, `translated_flag='N'`, `currency_code`, `encumbrance_type_id IS NULL`) exist in the seed data as rows that would *wrongly* satisfy a sloppy query. A query missing a filter must return a visibly wrong number here, exactly as it would on Oracle.

---

## 5. Sample data — sourced from `data/oracle/`

You asked for several rows of sample data based on the extracts. Here is every source and exactly what comes from it.

### 5.1 Real values, straight from the extracts

| Target | Source | Rows | Notes |
|---|---|---|---|
| `GL_CODE_COMBINATIONS` | `json-output.json` (320) + `json-output-v2.json` (192) + `cost-center.json` (20) | **380 distinct CCIDs** (532 rows, some CCIDs repeat) | Dedup on `CODE_COMBINATION_ID`. All `ACCOUNT_TYPE='E'`, `SUMMARY_FLAG='N'`, `ENABLED_FLAG='Y'` — so **there is no budget account in the extract**, which is why §5.3 exists. |
| `PO_LINES_ALL` | `full-output.json` (2,782) + `inv-lines.json` | ~2,782 | Real PO numbers, line numbers, items, quantities, amounts, `CANCEL_FLAG`. |
| `PO_VENDORS` / `PO_VENDOR_SITES_ALL` | `full-output.json` `VENDOR_NAME` (interned) | **157** | `VENDOR_ID` is synthesized (the extract carries names only). |
| `PO_AGENTS` | `full-output.json` `BUYER_NAME` (interned) | **7** | |
| `PO_DISTRIBUTIONS_ALL` | `inv-distributions.json` | 20 | Real `CODE_COMBINATION_ID`, `AMOUNT_ORDERED`, `AMOUNT_BILLED`, `ENCUMBERED_AMOUNT`. |
| `PO_HEADERS_ALL` | derived from `full-output.json` | distinct `ORDER_NUMBER` | `ORDER_DATE`, `VENDOR_ID`, `APPROVED_FLAG='Y'`. |
| `PO_LINE_LOCATIONS_ALL` | derived | 1 per line | |

### 5.2 Derived — computed from real extract values, not invented

| Target | Derivation |
|---|---|
| `PO_LINE_LOCATIONS_ALL` | one shipment per PO line, `QUANTITY`/`AMOUNT_RECEIVED` split per `STATUS` |
| `AP_INVOICES_ALL` | grouped `inv-distributions.json` by `PO_HEADER_ID`; `AMOUNT_BILLED` becomes `INVOICE_AMOUNT` |
| `GL_BALANCES` where `ACTUAL_FLAG='E'` | PO line amounts grouped by resolved CCID × period — **the encumbrance side, computed from the real PO extract** |
| `GL_BALANCES` where `ACTUAL_FLAG='A'` | `AMOUNT_BILLED` grouped by CCID × period — **the expenditure side** |
| `GL_JE_HEADERS` / `GL_JE_LINES` | the 7 funding lines, `JE_SOURCE='Budget'`, dated by their BOE/Est. dates |
| `GL_PERIODS` | generated FY22→FY28 monthly, `period_num` 1–12, `period_name` formatted Oracle-style (`JUL-25`) |
| `PA_PROJECTS_ALL` | the **146 levels** in `SEGMENT5`, named from PO descriptions where derivable, blank where not |

Two of the three `ACTUAL_FLAG` values therefore come from **real data**. Only the budget side is transcribed.

### 5.3 The budget side — the only hand-authored numbers, and why

`GL_BALANCES` with `ACTUAL_FLAG='B'` has **no extract source at all**. But it does have a better source than invention: **the report itself**, transcribed in `report-findings.md` §2, with its arithmetic independently proven in §3.

| Funding line | Amount | Date | FY |
|---|---:|---|---|
| FY23 Appropriation | 1,000,000 | 7/13/2022 | 2023 |
| FY24 Appropriation | 5,000,000 | 7/27/2023 | 2024 |
| Reallocation – FY24 Program Contingency | 1,251,965 | 1/7/2025 | 2025 |
| Reallocation – Project Savings | 6,790,125 | 10/7/2025 | 2025 |
| Future FY27 | 74,798,947 | 8/20/2026 | 2027 |
| Reallocation – NCDOT, FY 25-26 Prog. Cont | 9,500,000 | 8/20/2027 | 2027 |
| Future FY28 | 2,198,947 | 9/1/2027 | 2028 |
| **Total** | **100,539,984** | | |

Plus the four main-grid rows, seeded exactly as printed:

| Object | Budget Account | WCPSS Budget | Allocations | Encumbrances | Expenditures | Available |
|---|---|---:|---:|---:|---:|---:|
| `526` | `04.6570.862.526.0450.0840.000` | 6,738,830.00 | 6,738,830.00 | 2,329,280.40 | 4,409,549.60 | 0.00 |
| `527` | `04.6570.862.527.0450.0840.000` | 89,828,010.00 | 87,448,714.00 | 2,570,739.39 | 576,844.86 | 84,301,129.75 |
| `529` | `04.6570.862.529.0450.0840.000` | 936,025.00 | 626,290.00 | 149,072.93 | 214,749.07 | 262,468.00 |
| `532` | `04.6570.862.532.0450.0840.000` | 287,468.00 | 541,624.93 | 149,072.93 | 25,000.00 | 367,552.00 |

Anchor rows so the decoded chain is testable end-to-end:

```
Level 0450 (Athens Drive HS)
  → SEGMENT5 = '0450'  →  CODE_COMBINATION_ID = 9680025
  → '04.6560.862.529.0450.0840.000'
```

Every non-derived row gets `DATA_ORIGIN` ∈ `'extract' | 'derived' | 'transcribed' | 'synthetic'` on a sidecar `SAMPLE_DATA_PROVENANCE` table. Nothing is unlabelled, and one query answers "what in here is real?"

### 5.4 Known non-reconciliation — stating it up front

The extract is a **partial slice** (532 COA rows, 2,782 PO lines, filtered). It does **not** contain every transaction behind the report. Concretely:

- Row `526` shows **Encumbrances 2,329,280.40**, but the extract's single `526` PO line is **1,243,914.00**. The difference is real activity outside the slice.
- `report-findings.md` §3 already flags rows 3 and 4 carrying an **identical** `149,072.93` — possibly a copy bug in the custom report.

**So: do not expect the seeded encumbrances to reconcile to the extract's PO lines.** The plan seeds the report's figures as the budgeting truth (§5.3) and the extract's data as the transactional truth (§5.1), and records the gap rather than papering over it. Making them agree would require inventing ~1.09M of PO lines, which would destroy the extract's reliability.

---

## 6. Deliverables

```
data/turso/
  00-schema.sql          SQLite DDL, real Oracle names, source-object comment per table
  01-compat.sql          `dual` view + the ROWNUM→LIMIT note (functions cannot live here)
  02-seed.sql            GENERATED — reproducible from the script, committed for review
  03-provenance.sql      the DATA_ORIGIN sidecar + "what is real?" query
  queries/               Mode B portable SQL, mirroring data/sql/00→04
  ORACLE_NOTES.md        side-by-side Oracle ⇄ SQLite construct map
  README.md              what this is, how to rebuild, what it cannot do
  sample.db              GENERATED, gitignored

scripts/
  build-turso-sample.mjs   data/oracle/*.json + report figures → 02-seed.sql
  turso-run.mjs            opens sample.db WITH shims registered; runs Mode A SQL
  verify-turso-sample.mjs  the gate in §7; exits non-zero on any failure
```

`data/turso/` mirrors `data/sql/` deliberately — same numbering, same run order, so the Oracle files and their ports sit side by side and can be diffed. **`data/sql/*.sql` is not modified** (you said "No this is fine for now"); the compat copies are what get de-`ROWNUM`ed.

### npm scripts (repo root `package.json`, created if absent)

```
sample:build    node scripts/build-turso-sample.mjs
sample:verify   node scripts/verify-turso-sample.mjs
sample:sql      node scripts/turso-run.mjs <file.sql>
```

---

## 7. Verification gates

Each gate needs a **control that is guaranteed to fail**, or a pass proves nothing. The controls from the probes carry forward.

| # | Gate | Control |
|---|---|---|
| 1 | `dual` resolves | `SELECT 1 FROM dual` → 1 row |
| 2 | Every shim evaluates | `nvl(NULL,0)+1`=1 · `decode('Z',…)`='other' · `lpad(7,2,'0')`='07' |
| 3 | **`TRUNC(SYSDATE)` returns a date, not NULL** | the silent-NULL trap from §3.2 |
| 4 | Seed counts match plan | 380 CCIDs, 157 vendors, 7 buyers, 2,782 PO lines |
| 5 | Level `0450` resolves to CCID `9680025` | must be exactly **1** row |
| 6 | Report figures reproduce | `1,000,000 + 5,000,000 + … = 100,539,984` exactly |
| 7 | `Available = Allocations − Enc − Expend` | holds on all 4 grid rows to the cent |
| 8 | **`translated_flag='Y'` row is excluded** | remove the filter → total changes. Proves the filter is load-bearing |
| 9 | **Mode A vs Mode B agree** | same numbers from both dialects on the same seed |
| 10 | A subtly wrong query returns a *different* number | drop `currency_code` → total shifts |
| 11 | Missing object fails | `SELECT 1 FROM gl_zzz_no_such_object` must error |
| 12 | Syntax error fails | `SELECT FROM WHERE ((` must error |

**Gate 1 of the harness runs gates 11 and 12 first.** If the controls don't fail, the harness is broken and nothing else is trusted.

---

## 8. Fidelity limits — what this will never reproduce

Documented, not hidden, because each one is a way to get a confident wrong answer:

| Oracle | SQLite | Risk |
|---|---|---|
| **`''` is NULL** | `''` is **a distinct empty string** | ⚠️ **Highest risk here.** `DESCRIPTION` is NULL in the extract and segments are fixed-width strings — `WHERE description IS NULL` behaves differently. Mitigated by normalizing `''`→NULL on load. |
| `NUMBER` exact precision, round-half-up | IEEE 754 `REAL` half-even | Cent-level drift on large sums. Mitigated by storing money as **integer cents**. |
| `DATE` = second precision, `TIMESTAMP` = fraction | text / numeric | `julianday` arithmetic only. |
| `CHAR` blank-padding, `'B'` sort order | no padding, binary collation | Sorting and `=` comparisons on fixed-width columns differ. |
| `ROWNUM` before sort | `LIMIT` after sort | Only equivalent when a subquery preserves the order — see §3.4. |
| Oracle exceptions, `RAISE_APPLICATION_ERROR` | no equivalent | Constraints enforce what they can; the rest is a comment. |
| `(+)`, `MERGE`, `CONNECT BY`, `SYS_CONTEXT`, PL/SQL | absent | Rewrite or omit. |
| Optimizer, indexes, `EXPLAIN PLAN`, hints | entirely different | **No performance conclusion drawn here transfers to Oracle.** Let me be blunt: this schema can prove a query is *correct*, never that it is *fast*. |

---

## 9. Decisions I need from you

1. **Scope — report or app?** Does this surrogate serve the **report** (`report-findings.md` §11: budgets, appropriations, the four-object grid) or the **app** (Dashboard / Projects / Details, the scope that has governed this session)? The two need overlapping but different tables. *Recommendation: build the reported-data core either way — it is the shared need — and pick the peripheral tables once you answer.*

2. **Local file or Turso cloud?** A local `sample.db` needs **zero installs** and works today via `node:sqlite`. A hosted Turso DB needs `@libsql/client` (or the `turso` CLI, not installed) plus a token. *Recommendation: local first — it is a test fixture, not a shared service — then push if you want it reachable from elsewhere.*

3. **Which dialect is the keeper?** Mode A (compat, validates your existing Oracle SQL) or Mode B (portable, becomes the app's queries)? I intend to build **both** because they answer different questions, but tell me if you only want one.

4. **Money as integer cents, or as `REAL` for readability?** Cents is correct for accounting; `REAL` is easier to eyeball in a SQL shell. *Recommendation: integer cents, with a `v_money` view that formats.*

5. **How many rows is "several"?** The plan assumes **all** extract rows (380 CCIDs, 2,782 PO lines) — a few MB in SQLite, and more useful than a truncated sample. Say the word if you want a smaller, hand-picked fixture instead.

---

## 10. Out of scope — explicitly not doing

- **Not** rewriting `data/sql/01..04-*.sql` — you said "No this is fine for now". The compat copies are separate files.
- **Not** emulating PL/SQL, Oracle AQ, or EBS concurrent-manager/queue behaviour.
- **Not** making the optimizer behave like Oracle, or drawing any performance conclusion.
- **Not** reconciling the seeded encumbrances to the extract's PO lines (§5.4 explains why that would require inventing data).
- **Not** guessing the custom-table columns behind `CCAP`, `GMP-Building`, `GMP-Site`, `GSF`, `$/SF` or the Bid/NTP/SC/FC schedule. `report-findings.md` §1 establishes these have **no standard EBS home**. They stay out of the schema until source is found — adding invented columns would make the surrogate lie about coverage.

---

## 11. Build order

1. `00-schema.sql` — DDL, verified by loading into an empty `sample.db`
2. `01-compat.sql` + the shim module — re-run gates 1–3
3. `build-turso-sample.mjs` → `02-seed.sql` — re-run gates 4–5
4. Transcribe the report figures (§5.3) — re-run gates 6–7
5. `queries/` Mode B, then the Mode A copies — re-run gates 8–10
6. `verify-turso-sample.mjs` as one command — full gate run, controls first
7. `ORACLE_NOTES.md` + `README.md`

Steps 1–4 produce a database you can query. Steps 5–7 make it a fixture the project can rely on.
