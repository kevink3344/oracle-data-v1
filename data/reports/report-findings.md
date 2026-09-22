# Report Findings — `PROJECT BUDGET SUMMARY REPORT`

**Question asked:** staff supplied an image of a report generated from Oracle 12.2 — which Oracle tables does this data live in?

**Investigated:** 2026-09-17
**Investigated against:** the extract files in `data/oracle/` and `app/public/oracle/` (not a live query — see [§8 Verification method](#8-verification-method))

> **Reading note on object names.** This is a dated record of what was found in the extract
> environment, and it names objects as that environment presented them: `WCSEXP_*` views over the
> real EBS tables. It is **not** updated to the new vocabulary, on purpose — the finding "only 20
> `WCSEXP_`-style objects were reachable" (§11.4) and the DDL in §12 are evidence about *that*
> environment and would be falsified by a find-and-replace.
>
> The `WCSEXP_*` views are **retired** for all current work: `data/sql/`, `data/sql/turso/queries/`
> and the API read the base tables directly. For the mapping, see the banner at the top of
> [`../oracle/db-schema.md`](../oracle/db-schema.md). Where this document says "our extract:
> `WCSEXP_X`", read it as "our extract: the table behind `WCSEXP_X`".

---

## 1. Bottom line

The report is a **custom report** running against an Oracle EBS 12.2 database. It is not a
standard EBS report and it does not map onto one table or one module.

It blends **four different sources**, only two of which are standard EBS:

| Layer | Content | Where it plausibly lives |
|---|---|---|
| Accounting | Budget Account strings, encumbrances, expenditures | **Standard EBS** — GL + PO + AP |
| Project master | Project name, Level, Cost Center, schedule | **Standard EBS** — `PA_PROJECTS_ALL` + DFFs, or carried in `GL_CODE_COMBINATIONS` segments |
| Funding | FY23/FY24 appropriations, reallocations, BOE dates | **Standard-ish EBS** — GL budget (appropriation) or GMS awards; the forward FY27/FY28 rows are planning, so probably custom |
| Construction planning | `CCAP`, `GMP-Building`, `GMP-Site`, `GSF`, `$/SF`, Bid/NTP/SC/FC | **No standard EBS home** — custom table or project DFFs |

Everything in the last row is why this cannot be reproduced from standard EBS tables alone.

---

## 2. The report, transcribed from the image

```
PROJECT BUDGET SUMMARY REPORT

Project:    Athens Drive HS          Report Date:  9/17/2026
Level Code: 0450                     Project Schedule
Cost Center: 0318                      Bid        : Oct-26
                                       Const. NTP : Mar-27
GSF          143,000                   SC         : Oct-30
$/SF         $620.54                   FC         : Dec-30
CCAP         $81,732,376.00            Caption    : Renovation- Swing on Site
GMP-Building $77,052,929.00   (BBC 100% CD Estimate)
GMP-Site     $11,684,967.00   (BBC 100% CD Estimate)
GMP-Total    $88,737,896.00   (BBC 100% CD Estimate)
Off-Site        $750,000.00
```

### Allocations / Funding / Reimbursements

| # | Line | Amount | Annotation |
|---|---|---|---|
| 1 | FY23 Appropriation | 1,000,000 | BOE 7/13/2022 |
| 2 | FY24 Appropriation | 5,000,000 | BOE 7/27/2023 |
| 3 | Reallocation- FY24 Program Contingency | 1,251,965 | BOE 1/7/2025 |
| 4 | Reallocation-Project Savings | 6,790,125 | BOE 10/7/2025 |
| 5 | Future FY27 | 74,798,947 | Est. 8/20/2026 |
| 6 | Reallocation- NCDOT, FY 25-26 Prog. Cont | 9,500,000 | Est. 8/20/2027 |
| 7 | Future FY28 | 2,198,947 | Est. 9/1/2027 |
| | **Funding (total)** | **100,539,984** | |

### Main grid

Columns: `Budget Description | Budget Account | WCPSS Budget | Allocations/Reimb. | Encumbrances | Expenditures | Available Funds | Comments`

| Budget Description | Budget Account | WCPSS Budget | Allocations/ Reimb. | Encumbrances | Expenditures | Available Funds | Comments |
|---|---|---|---|---|---|---|---|
| Design Contracts- Moseley Architects | `04.6570.862.526.0450.0840.000` | 6,738,830.00 | 6,738,830.00 | 2,329,280.40 | 4,409,549.60 | 0.00 | Fully Funded |
| CMAR Contracts- Balfour Beatty | `04.6570.862.527.0450.0840.000` | 89,828,010.00 | 87,448,714.00 | 2,570,739.39 | 576,844.86 | 84,301,129.75 | *Est. $5.33M over budget* |
| Misc. Contracts | `04.6570.862.529.0450.0840.000` | 936,025.00 | 626,290.00 | 149,072.93 | 214,749.07 | 262,468.00 | |
| Offsite Improvements | `04.6570.862.532.0450.0840.000` | 287,468.00 | 541,624.93 | 149,072.93 | 25,000.00 | 367,552.00 | |
| School Programming | *cut off below frame* | | | | | | |

The image is a PDF viewer at 100% zoom — the last row is clipped, so the grid is incomplete.

---

## 3. What the report's own arithmetic proves

All four checks reconcile, so the numbers are self-consistent and the report computes them rather than reading them:

| Check | Formula | Result |
|---|---|---|
| Available Funds | `Allocations − Encumbrances − Expenditures` | Holds on **all 4 rows** (Design: 6,738,830 − 2,329,280.40 − 4,409,549.60 = **0.00** ✓) |
| `$/SF` | `GMP-Total ÷ GSF` | 88,737,896 ÷ 143,000 = **620.545** ✓ |
| `GMP-Total` | `GMP-Building + GMP-Site` | 77,052,929 + 11,684,967 = **88,737,896** ✓ |
| Funding | `Σ 7 funding lines` | 1,000,000 + 5,000,000 + 1,251,965 + 6,790,125 + 74,798,947 + 9,500,000 + 2,198,947 = **100,539,984** ✓ |

**Consequence:** `Available Funds`, `GMP-Total`, `$/SF` and `Funding` are **derived in the report**, not stored columns. Do not go looking for them in a table.

⚠️ **Anomaly worth raising with staff:** rows 3 and 4 show an **identical** Encumbrances value, `149,072.93`, to the cent. Either one PO genuinely spans both objects, or the custom report has a copy bug. Worth confirming before anyone builds on this.

---

## 4. The account number decodes against our data — verified

`04.6570.862.526.0450.0840.000` in the *Budget Account* column is the standard 7-segment GL
account combination. It matches the `SEGMENT1..SEGMENT7` columns of our
`json-output.json` / `WCSEXP_GL_CODE_COMBINATIONS` extract in order:

| Pos | Value | Extract column | Extract's name | Present in extract? |
|---|---|---|---|---|
| 1 | `04` | `SEGMENT1` | Fund | ✅ only `04` exists |
| 2 | `6570` | `SEGMENT2` | Purpose | ✅ (of `6400, 6560, 6570, 9000`) |
| 3 | `862` | `SEGMENT3` | Program | ✅ (of `861, 862`) |
| 4 | `526` | `SEGMENT4` | **Object** | ✅ (11 objects) |
| 5 | `0450` | `SEGMENT5` | **Level** | ✅ (of 146) |
| 6 | `0840` | `SEGMENT6` | Cost Center | ✅ (constant for fund 04) |
| 7 | `000` | `SEGMENT7` | Future use | ✅ (constant) |

**Key result: the header's "Level Code 0450" is `SEGMENT5`.** The four budget lines are
distinguished by the **object** (segment 4), not the level — all four share level `0450`.

Two independent confirmations from the extracts:

1. The `04xx` level series in `json-output.json` `SEGMENT5` is exactly `0450, 0451, 0452, 0453, 0454` — a low-numbered level-code list, consistent with "Level Code".
2. The 14 purchase-order lines carrying `LEVEL_ = 0450` carry exactly `OBJECT_ ∈ {526, 527, 529, 532}` — the report's four object suffixes, no others.

---

## 5. Level 0450 is Athens Drive HS — verified, not assumed

From `data/oracle/full-output.json` (the PO-line extract):

- **14 lines** on `LEVEL_ = 0450`, totalling **$4,356,078.25**
- Order dates **2025-01-13 → 2026-07-02**
- Descriptions name the project outright:
  - `ATHENS DRIVE HS-RENO - DESIGN SERVICES-ADDITIONAL DESIGN S…`
  - `ATHENS DRIVE HS-RENO-0005  MISC COSTS-BOUNDARY SURVEY`
  - `ATHENS DRIVE HS-RENO-0013 - FF&E INSTALLATION LABOR`
  - `CMAR-GMP #1 ADDED PER J. BEAVIN - DH - 5/7/26`
- Money by object:

| Object | Lines | Amount |
|---|---|---|
| `526` | 1 | $1,243,914.00 |
| `527` | 2 | $2,739,102.25 |
| `529` | 10 | $358,062.00 |
| `532` | 1 | $15,000.00 |
| **Total** | **14** | **$4,356,078.25** |

- Vendors on those lines: `MOSELEY ARCHITECTS PC`, `BALFOUR BEATTY CONSTRUCTION`, `STANTEC CONSULTING SERVICES INC`, `MCKIM & CREED INC`, `TERRACON CONSULTANTS INC`, `RMF ENGINEERING INC`, `MATRIX HEALTH & SAFETY CONSULTANTS, LLC`, `ALL AMERICAN RELOCATION INC`
- Buyers: `Harris, Mr. Patrick Ryan`, `Gooding, Mrs. Petra Schoeppler`
- `PURPOSE` values on these lines: `6570` (capital) and `6560`

### Report line ↔ extract line match

| Report budget line | Object | Extract evidence |
|---|---|---|
| Design Contracts- Moseley Architects | `526` | **MOSELEY ARCHITECTS PC**, PO 266121 · $1,243,914 |
| CMAR Contracts- Balfour Beatty | `527` | **BALFOUR BEATTY CONSTRUCTION**, PO 273173 · $2,739,102.25 |
| Misc. Contracts | `529` | 9 lines · $354,782 — McKim & Creed, Terracon, RMF, Matrix |
| Offsite Improvements | `532` | **STANTEC**, PO 273062 · $15,000 (traffic impact analysis) |

This is a confirmed report ↔ extract link on the *vendor and object*, which is why the account
decode in §4 can be trusted.

⚠️ **Caveat:** a whole-extract search finds **21 rows mentioning "ATHENS"**, spread across
`LEVEL_` values `0450, 0576, 0521, 0575, 0524, 0523`. The free-text project name is **not**
confined to level 0450. **Use the `LEVEL_` code as the project identifier, never the description text.**

---

## 6. Column-by-column → Oracle table mapping

| Report column / block | Where it comes from | Notes |
|---|---|---|
| **Budget Account** | `GL.GL_CODE_COMBINATIONS` (`CODE_COMBINATION_ID`, `SEGMENT1..7`) | Our extract: `WCSEXP_GL_CODE_COMBINATIONS`, 320 rows |
| **Budget Description** | `PO.PO_LINES_ALL.ITEM_DESCRIPTION` / `PO_HEADERS_ALL`. If budget-driven: `PA.PA_BUDGET_LINES.DESCRIPTION` | Free text either way |
| **Encumbrances** | `PO.PO_DISTRIBUTIONS_ALL` → `ENCUMBERED_FLAG`, `ENCUMBERED_AMOUNT`; link via `CODE_COMBINATION_ID`. Alternative: `GL_BALANCES` w/ `GL_ENCUMBRANCE_TYPES` | Our extract: `WCSEXP_PO_DISTRIBUTIONS` |
| **Expenditures** | `AP.AP_INVOICE_DISTRIBUTIONS_ALL.AMOUNT` via `DIST_CODE_COMBINATION_ID` (+ `POSTED_FLAG`); GL actuals in `GL_JE_LINES` / `GL_BALANCES`. If project-driven: `PA_COST_DISTRIBUTION_LINES_ALL` | Our extract: `WCSEXP_AP_INV_DISTRIBUTIONS` (**structure only — no data extracted**) |
| **Vendors** | `PO.PO_VENDORS`, `PO.PO_VENDOR_SITES_ALL` | Our extract: `WCSEXP_PO_VENDORS`, `WCSEXP_PO_VENDOR_SITES` |
| **Allocations / Reimb.** | **GL appropriation budget** — see [§11](#11-finding-the-first-budget-allocation-fy23-appropriation) for the exact chain | **Not in our extract** |
| **WCPSS Budget** | Same as above (`GL_BALANCES` `ACTUAL_FLAG='B'` for the account) — see [§11](#11-finding-the-first-budget-allocation-fy23-appropriation) | **Not in our extract** |
| **Available Funds** | **Derived** = Allocations − Encumbrances − Expenditures | Verified in §3 — stored nowhere |
| **Comments** ("Fully Funded", "Est. $5.33M over budget") | Report-authored / human | Not an Oracle field |
| **Project: Athens Drive HS** | `PA_PROJECTS_ALL` (`PROJECT_ID`, `SEGMENT1` = project number, `NAME`) / `PA_PROJECTS_VL`. In *this* chart it also comes from `GL_CODE_COMBINATIONS.SEGMENT5` | Our extract has **no project table** |
| **Level Code 0450** | `GL_CODE_COMBINATIONS.SEGMENT5` | ✅ verified |
| **Cost Center 0318** | See §7 — **unmapped** | |
| **GSF, $/SF, CCAP, GMP-*** | **No standard EBS column.** Candidates: project DFFs on `PA_PROJECTS_ALL`, a custom WCPSS table, or an external construction system | Not in EBS standard schema |
| **Project Schedule (Bid / Const. NTP / SC / FC)** | No standard columns. `PA_PROJECTS_ALL.START_DATE` / `COMPLETION_DATE` cover only 2 of the 4 | Needs project DFFs or `PA_TASKS`, or custom |
| **Segment / value descriptions** | `FND_FLEX_VALUES_VL`, `FND_FLEX_VALUES_TL`, `FND_ID_FLEX_SEGMENTS`, `FND_ID_FLEX_STRUCTURES` | Our extract: `WCSEXP_FND_ID_FLEX_STRUCTURES`, `WCSEXP_GL_LOOKUPS` |

---

## 7. Two things that do not fit

### 7.1 "Cost Center 0318" matches no segment value anywhere

`0318` does not appear as a value in **any** segment of **any** extract file:

- not in fund 04's segment 6 (which is `0840`)
- not in `cost-center.json` (which is fund **01**, segments `01.7200.220.211.0140.*`)
- not in the PO-line extract's `COST_CENTER` column

`0318`'s shape (4 digits, leading zero) matches the **fund-01 cost-centre scheme** in
`cost-center.json`, which uses varying 4-digit segment 6 values (`0600…0980`). So it is
probably a legitimate code from a *different* fund's chart, or a school/facility number,
or a value from a system other than EBS. **Unmapped — needs a question to staff.**

### 7.2 The chart-of-accounts extract cannot resolve this report's accounts

| Fact | Value |
|---|---|
| Combinations in the PO extract | **328** |
| Of those, present in the COA extract (`json-output.json`) | **196** |
| **Missing from the COA extract** | **132 (~40%)** |
| COA extract rows | 320 (320 distinct combinations) |
| `json-output-v2.json` | 192 rows / 192 combinations — a *different* chart (different purposes) |

**None of the report's four accounts is present in the COA extract.** The one level-0450
combination that *does* exist in the COA extract is a different account entirely:

```
04.6560.862.529.0450.0840.000   CODE_COMBINATION_ID = 9680025   DESCRIPTION = null
LAST_UPDATE_DATE = 2026-05-13
```

So any join from the PO extract to the account master **fails on ~40% of combinations today**,
including every account on this report. That is a data-coverage gap, not a modelling error.

### 7.3 Related gap in the extract set

`data/oracle/db-schema.md` documents three GL views that **do not exist live** (`ORA-00942`):

- `WCSEXP_GL_JE_HEADERS`
- `WCSEXP_GL_JE_LINES`
- `WCSEXP_GL_BALANCES`

These are exactly the views the Expenditures and Encumbrances-from-GL columns would need.
They are also the only documented views with a period/balance grain. **They are unavailable.**

---

## 8. Verification method

Verified with throwaway Node probes, in two separate ways:

**(a) Static analysis of the JSON extracts** in `data/oracle/` and `app/public/oracle/`.
These probes never touched the database. This is how §4–§7 and the ACCOUNT_TYPE finding in
§11.3 were established.

**(b) Live dictionary probes** against the Oracle instance over VPN (two throwaway probes).
These were dictionary-only — `ALL_VIEWS`, `ALL_SYNONYMS`, `ALL_TABLES`, `ALL_TAB_COLUMNS` —
plus `SELECT 1 … WHERE ROWNUM=1` reachability pings. **No business data was read.** Both probes
carried positive *and* negative controls (`SELECT 1 FROM DUAL` must succeed; a deliberate syntax
error and a non-existent object must fail), and all controls behaved correctly, so the results
below can be trusted. This is how §12 was established.

So:

- **Verified against data:** the account decode, the segment positions, the 14 level-0450 lines,
  their amounts, vendors and objects, the COA/PO coverage gap (196 of 328), the absence of `0318`,
  and the all-expense ACCOUNT_TYPE finding.
- **Verified against the live dictionary:** that only 20 `WCSEXP_`-style objects are reachable,
  that they contain no budget column, and that the three views in `db-schema.md` do not exist.
- **Inferred, not verified:** the exact EBS table chain in §11 for the appropriation. The
  *shape* of the answer is strongly evidenced (§11.3–§11.4), but the specific tables must be
  confirmed once access exists — see the version caveat below.

**Version caveat.** The report is stated to come from **Oracle 12.2**, but our live instance is
**Oracle Database 19c** (`FA2DB`, non-CDB EBS). Table and column names should be validated on the
actual 12.2 instance; in particular EBS uses `_ALL` suffixed tables
(`PO_DISTRIBUTIONS_ALL`, `PO_LINES_ALL`) which are sometimes hidden behind `APPS` synonyms.

**Note on the report date.** The report is dated **9/17/2026**; the extract's cut-off is
**2026-08-06** — about six weeks apart. Figures will not match to the cent even once the
tables are identified.

---

## 9. What we would need to reproduce this report

Ranked by how much of the report each item unblocks.

| # | Need | Unblocks | Status |
|---|---|---|---|
| 1 | The **three views `db-schema.md` already documents but that do not exist live**: `WCSEXP_GL_JE_HEADERS`, `WCSEXP_GL_JE_LINES`, `WCSEXP_GL_BALANCES` (see §11.4) | **WCPSS Budget**, **Allocations/Reimb.**, the whole funding block | ❌ raise `ORA-00942` |
| 2 | `AP_INVOICES_ALL` + `AP_INVOICE_DISTRIBUTIONS_ALL` **data** (views exist in docs, nothing extracted) | **Expenditures** | ❌ structure only |
| 3 | The **full** `GL_CODE_COMBINATIONS` extract (again, 132 of 328 combinations are missing) | every account↔PO join | ⚠️ partial |
| 4 | `PO_DISTRIBUTIONS` carrying `CODE_COMBINATION_ID` through into the PO-line extract | linking encumbrances to accounts in one pass | ⚠️ partial |
| 5 | Whatever holds `CCAP`, `GMP-*`, `GSF`, `$/SF`, Bid/NTP/SC/FC | the entire cost-and-schedule block | ❌ **custom — needs identifying** |
| 6 | Whatever holds the forward `Future FY27` / `Future FY28` planning rows | 2 of 7 funding lines | ❌ **custom — needs identifying** |
| 7 | `PA_PROJECTS_ALL` (or the DFF that replaces it) | `Project: Athens Drive HS` as a real entity | ❌ not extracted |
| 8 | Definition of **"Cost Center 0318"** | the header block | ❌ **unknown** |

### Concrete ask for staff

> Please provide, or confirm the names of, the following:
>
> 1. The **appropriation / budget** source — see [§11](#11-finding-the-first-budget-allocation-fy23-appropriation) and [§12.4](#124-what-the-dba-should-be-asked-for). Specifically: does `GL_BUDGET_VERSIONS` / `GL_BUDGET_TYPES` / `GL_BUDGET_ENTITIES` / `GL_BUDGET_ASSIGNMENTS` / `GL_BALANCES` exist on this instance, and if so can `POWERAPPS` be granted `SELECT` on it? (A DBA can settle this with one query — see §12.3.)
> 2. The **funding / award** source behind the Allocations/Funding/Reimbursements block, including the **BOE date** and the forward `Future FY27` / `Future FY28` planning rows.
> 3. The **data** for `AP_INVOICES_ALL` and `AP_INVOICE_DISTRIBUTIONS_ALL` (the views are documented but nothing has been extracted).
> 4. A **complete** `GL_CODE_COMBINATIONS` extract — the current one omits 132 of the 328 combinations that appear in the PO extract.
> 5. The object holding **`CCAP`, `GMP-Building`, `GMP-Site`, `GSF`, `$/SF`** and the **Bid / Const. NTP / SC / FC** schedule dates, and confirmation of whether they are project DFFs or a custom table.
> 6. The definition of **"Cost Center 0318"** — it is not a value in any EBS segment we have.
> 7. Confirmation of whether `WCSEXP_GL_JE_HEADERS`, `WCSEXP_GL_JE_LINES` and `WCSEXP_GL_BALANCES` can be restored to the extract environment (they currently raise `ORA-00942`).

---

## 10. Open questions for staff

1. What is **Cost Center 0318**? (§7.1)
2. Are the identical Encumbrances of `149,072.93` on the *Misc. Contracts* and *Offsite Improvements* rows real, or a report bug? (§3)
3. Is `CCAP` a WCPSS-specific acronym? It is not an EBS term.
4. Where do the **Bid / Const. NTP / SC / FC** dates come from — a construction system outside Oracle?
5. Is **"School Programming"** (the clipped bottom row) a fifth account under level 0450? Our extract shows only four objects on level 0450, so if it is, the extract is incomplete.

---

## 11. Finding the first budget Allocation (FY23 Appropriation)

> Target: the report's first funding row — **FY23 Appropriation `1,000,000`** (BOE 7/13/2022).

### 11.1 The answer

The appropriation is an **Oracle General Ledger appropriation budget**. It is *not* in any of the
19 views currently extracted, because a budget is not a purchasing document. The chain is:

```
GL_BUDGET_ENTITIES        which budget entity           e.g. "WCPSS"
        │
GL_BUDGET_TYPES           which budget type             e.g. "Appropriation"
        │
GL_BUDGET_VERSIONS        which named version   <---    *** "FY23 Appropriation" ***
        │
GL_BUDGET_ASSIGNMENTS     which account RANGES are budgetable
        │                 (range-based, NOT a per-code list — see §11.7.5)
GL_BALANCES               *** the AMOUNTS ***
        ACTUAL_FLAG = 'B'          B = Budget
        BUDGET_VERSION_ID          -> the FY23 version
        PERIOD_NET_DR / NET_CR     -> the 1,000,000
```

**The pivotal table is `GL_BALANCES`.** EBS stores *all three* of the report's money columns in
that one table, discriminated by `ACTUAL_FLAG`:

| Report column | `GL_BALANCES` filter |
|---|---|
| **WCPSS Budget** / **Allocations-Reimb.** | `ACTUAL_FLAG = 'B'` + `BUDGET_VERSION_ID` |
| **Encumbrances** | `ACTUAL_FLAG = 'E'` + `ENCUMBRANCE_TYPE_ID` |
| **Expenditures** | `ACTUAL_FLAG = 'A'` |

Common keys: `LEDGER_ID`, `CODE_COMBINATION_ID`, `PERIOD_NAME`, `PERIOD_YEAR`, `PERIOD_NUM`.
`PERIOD_YEAR` / `PERIOD_NUM` are what let you slice "FY23" out of the balance rows.

**To find the *first* one specifically:** `GL_BUDGET_VERSIONS` ordered by `FIRST_PERIOD_NAME` (or
`CREATION_DATE`) — the earliest appropriation version is the FY23 one.

### 11.2 Why GL, not Oracle Projects

The report expresses budget **per 7-segment account combination**, not per project/task. That is
the signature of **GL appropriation budgeting**. If WCPSS budgeted through Oracle Projects, the
rows would be keyed by `PROJECT_ID` / `TASK_ID` with the account derived — and the report would
show a project/task column, which it does not. `PA_BUDGET_VERSIONS` / `PA_BUDGET_LINES` remain a
secondary candidate but fit the report's shape less well.

### 11.3 New evidence: the extract contains **only expense accounts**

A static scan of every extract row (no database access):

| Extract | Rows | `ACCOUNT_TYPE` values |
|---|---|---|
| `json-output.json` | 320 | **`E` × 320** |
| `json-output-v2.json` | 192 | **`E` × 192** |
| `cost-center.json` | 20 | **`E` × 20** |

**Every one of the 532 account rows is `ACCOUNT_TYPE = 'E'` (Expense).** There is not a single
Asset, Liability, Equity or Revenue account in anything we hold. `SUMMARY_FLAG` is `N` on all
320, so there are no roll-up parents either.

This is the structural reason the funding block cannot be reproduced. An appropriation is a
*source of funds* — it books to a fund-balance / budgetary account, not to an expense account.
Our extract is scoped entirely to expenditure detail, so it excludes exactly the accounts the
appropriation would live on. The per-object breakdown confirms the scoping:

| Report object | Accounts in extract | `ACCOUNT_TYPE` |
|---|---|---|
| `526` (Design Contracts) | 54 | all `E` |
| `527` (CMAR) | 3 | all `E` |
| `529` (Misc.) | 79 | all `E` |
| `532` (Offsite) | 2 | all `E` |

**Practical consequence for sign convention:** `GL_BALANCES` stores amounts as DR and CR. Because
these are expense accounts, budget amounts for them land in `PERIOD_NET_DR`. Sum
`PERIOD_NET_DR − PERIOD_NET_CR` to get a positive budget figure. (For the appropriation account —
whichever non-expense account it is — the sign will be the opposite. Confirm via
`GL_CODE_COMBINATIONS.ACCOUNT_TYPE`.)

### 11.4 The convergence: the three missing views are exactly the three needed

`data/oracle/db-schema.md` documents three views that **do not exist live** (`ORA-00942`):

| Documented view | Real EBS object | Why it matters here |
|---|---|---|
| `WCSEXP_GL_JE_HEADERS` | `GL_JE_HEADERS` | Budget journals. Columns include `JE_CATEGORY`, `JE_SOURCE`, `NAME`, `DESCRIPTION`, `ACTUAL_FLAG`, `DEFAULT_EFFECTIVE_DATE`, `POSTED_DATE` |
| `WCSEXP_GL_JE_LINES` | `GL_JE_LINES` | Budget journal amounts: `ENTERED_DR`, `ENTERED_CR`, `CODE_COMBINATION_ID`, `EFFECTIVE_DATE` |
| `WCSEXP_GL_BALANCES` | `GL_BALANCES` | **The budget balances** — `ACTUAL_FLAG`, `BUDGET_VERSION_ID`, `ENCUMBRANCE_TYPE_ID`, `PERIOD_NET_DR/CR`, `PERIOD_YEAR/NUM` |

Three observations, each independently meaningful:

1. **The documented column lists are accurate.** `WCSEXP_GL_BALANCES` is documented with
   `ACTUAL_FLAG`, `BUDGET_VERSION_ID`, `ENCUMBRANCE_TYPE_ID`, `PERIOD_TYPE`, `PERIOD_YEAR`,
   `PERIOD_NUM`, `PERIOD_NET_DR/NET_CR`, `QUARTER_TO_DATE_DR/CR`, `BEGIN_BALANCE_DR/CR` — that is
   the real `GL_BALANCES` column set, too exact to have been invented. **Whoever wrote
   `db-schema.md` was reading the real view.** It therefore existed.
2. **Those three views are precisely the objects needed** for the WCPSS Budget, Allocations, and
   Expenditures columns. The gap is not random — it is exact.
3. **The report's funding-line names read like budget journal names.**
   `Reallocation-Project Savings`, `Reallocation- FY24 Program Contingency`,
   `Reallocation- NCDOT, FY 25-26 Prog. Cont` map naturally onto
   `GL_JE_HEADERS.NAME` / `DESCRIPTION` with `ACTUAL_FLAG = 'B'`.

**This reframes the request to the DBA.** It is not "please grant me access to something new" —
it is "the three views your own extract documentation lists do not currently exist; can they be
restored (or re-created)?" That is a much stronger and more specific ask.

### 11.5 Where the BOE date lives

`BOE 7/13/2022` is a **Board of Education approval date**. **No standard Oracle EBS table stores
this.** Candidates, best first:

1. **`GL_JE_HEADERS.DEFAULT_EFFECTIVE_DATE` or `.POSTED_DATE`** — if each appropriation /
   reallocation was entered as a separate budget journal. This is the most likely home, and it
   explains why the four approved rows have four *distinct* dates while the two "Future" rows are
   marked **`Est.`** rather than `BOE` — the estimated rows are not yet posted journals.
2. **`GL_BUDGET_VERSIONS.CREATION_DATE`** — if the BOE date is simply when the version was set up.
3. **A custom WCPSS table** — an appropriation register keyed by fiscal year, holding amount +
   BOE date + description. Use this if neither of the above lines up.

Note the sequencing clue: the two original appropriations are approved in **July** of consecutive
years (7/13/2022, 7/27/2023) — an annual board cycle — while the later rows are dated
**January and October**, consistent with mid-year reallocations rather than new appropriations.

### 11.6 The SQL to run once access exists

Two identifiers are now known **from the local extract** (no database needed), so the SQL below
can use real literals instead of guesses:

| Fact | Value | Source |
|---|---|---|
| `CHART_OF_ACCOUNTS_ID` | **101** (single value, all rows) | `json-output.json`, `-v2`, `cost-center.json` |
| Report's Level `0450` → account | `04.6560.862.529.0450.0840.000`, **`CODE_COMBINATION_ID = 9680025`** | same files |
| Distinct `CODE_COMBINATION_ID` held | 380 | same files |
| Functional currency | USD (every report amount is `$`) | report image |

#### Query 0 — confirm the column names first

The budget tables have never been observed on this instance (§12), so their exact column names
are unverified. This settles it before anything else:

```sql
SELECT table_name, column_name, data_type, column_id
  FROM all_tab_columns
 WHERE table_name IN ('GL_LEDGERS','GL_BUDGET_ENTITIES','GL_BUDGET_TYPES',
                      'GL_BUDGET_VERSIONS','GL_BUDGET_ASSIGNMENTS','GL_BALANCES',
                      'GL_JE_HEADERS','GL_JE_LINES')
 ORDER BY table_name, column_id;
```

#### Query 1 — the allocation amount *(this is the one the question asks for)*

```sql
WITH versions AS (
  SELECT bv.budget_version_id,
         bv.budget_name,
         bv.budget_type_id,
         bv.first_period_name,
         bv.last_period_name,
         bv.creation_date,
         ROW_NUMBER() OVER (PARTITION BY bv.budget_type_id
                            ORDER BY bv.first_period_name, bv.creation_date) AS rn
    FROM gl_budget_versions bv
   WHERE bv.ledger_id = :ledger_id
)
SELECT v.budget_version_id,
       v.budget_name,
       v.budget_type_id,
       v.first_period_name                      AS version_starts,
       v.last_period_name                       AS version_ends,
       COUNT(DISTINCT gb.code_combination_id)   AS accounts_touched,
       MIN(gb.period_name)                      AS earliest_period_with_amount,
       SUM(gb.period_net_dr)                    AS sum_net_dr,
       SUM(gb.period_net_cr)                    AS sum_net_cr,
       SUM(gb.period_net_dr - gb.period_net_cr) AS allocation_amount
  FROM versions v
  JOIN gl_balances gb
    ON  gb.budget_version_id  = v.budget_version_id
   AND gb.ledger_id           = :ledger_id
   AND gb.actual_flag         = 'B'         -- B = Budget
   AND gb.translated_flag     = 'N'         -- original amounts only
   AND gb.currency_code       = :ledger_currency_code
   AND gb.encumbrance_type_id IS NULL       -- 'E' rows set this; 'B' rows do not
 WHERE v.rn = 1                             -- rn = 1 -> the EARLIEST version per type
 GROUP BY v.budget_version_id, v.budget_name, v.budget_type_id,
          v.first_period_name, v.last_period_name
 ORDER BY v.first_period_name;
```

`rn = 1` is the "earliest row of `GL_BUDGET_VERSIONS`". Partitioning by `budget_type_id` gives the
earliest version **per budget type**, which is what you want when the ledger carries more than one
type (Appropriation, Original, Revised…). Drop the partition and use a plain
`ORDER BY first_period_name` + `FETCH FIRST 1 ROW ONLY` if you want only the single earliest row in
the ledger.

**The four `GL_BALANCES` filters are not optional.** `GL_BALANCES` holds one row per
*account × period × currency × translated-flag × (budget version or encumbrance type)*. Omit
`currency_code` / `translated_flag` and the same budget is counted once per reporting currency and
once more per translation — the single most common way to get a wrong number out of this table.
`encumbrance_type_id IS NULL` stops budget rows being repeated across encumbrance types.

**Read both `SUM(net_dr)` and `SUM(net_cr)`; do not assume the sign.** Every account in the extract
is `ACCOUNT_TYPE = 'E'` (§11.3), so for *those* accounts the budget lands in `PERIOD_NET_DR` and the
figure comes out positive. The appropriation itself sits on a **non-expense** account with the
opposite natural balance, so if `allocation_amount` returns **−1,000,000**, the right expression is
`PERIOD_NET_CR − PERIOD_NET_DR` (or `ABS()`). Selecting the two `SUM` columns separately makes the
sign observable rather than assumed.

#### Query 2 — resolve the ledger

Avoids hard-coding `:ledger_id`; the chart of accounts is known to be 101:

```sql
SELECT l.ledger_id, l.name, l.currency_code, l.period_set_name, l.chart_of_accounts_id
  FROM gl_ledgers l
 WHERE l.chart_of_accounts_id = 101
 ORDER BY l.ledger_id;
```

Use the returned `currency_code` as `:ledger_currency_code`. On 12.2 / 19c `GL_LEDGERS` is the base
table (`GL_SETS_OF_BOOKS` is the legacy view). If `GL_LEDGERS` is not reachable, the same rows sit
behind `FND_GL_LEDGERS_V`.

#### Query 3 — one account, all three report columns

The single most informative query: pin to the report's Level 0450 account and let the three
`ACTUAL_FLAG` values show Budget, Encumbrance and Actual side by side.

```sql
SELECT gb.actual_flag,                  -- B = Budget, E = Encumbrance, A = Actual
       gb.budget_version_id,
       gb.encumbrance_type_id,
       gb.period_name, gb.period_year, gb.period_num,
       gb.currency_code, gb.translated_flag,
       gb.period_net_dr, gb.period_net_cr
  FROM gl_balances gb
 WHERE gb.ledger_id           = :ledger_id
   AND gb.code_combination_id = 9680025   -- 04.6560.862.529.0450.0840.000
   AND gb.actual_flag        IN ('B','E','A')
 ORDER BY gb.actual_flag, gb.period_year, gb.period_num, gb.currency_code;
```

#### Query 4 — the per-account breakdown of that version

Reconciles the single `1,000,000` back to the accounts it was allocated across, and is the direct
test of §11.3:

```sql
SELECT cc.segment1||'.'||cc.segment2||'.'||cc.segment3||'.'||cc.segment4||'.'||
       cc.segment5||'.'||cc.segment6||'.'||cc.segment7   AS full_account,
       cc.segment4                                        AS object_code,
       cc.segment5                                        AS level_code,
       cc.account_type,
       gb.period_name, gb.period_year, gb.period_num,
       SUM(gb.period_net_dr)                              AS net_dr,
       SUM(gb.period_net_cr)                              AS net_cr,
       SUM(gb.period_net_dr - gb.period_net_cr)           AS amount
  FROM gl_balances          gb
  JOIN gl_code_combinations cc ON cc.code_combination_id = gb.code_combination_id
 WHERE gb.ledger_id           = :ledger_id
   AND gb.actual_flag         = 'B'
   AND gb.budget_version_id   = :fy23_version_id
   AND gb.translated_flag     = 'N'
   AND gb.currency_code       = :ledger_currency_code
   AND gb.encumbrance_type_id IS NULL
 GROUP BY cc.segment1, cc.segment2, cc.segment3, cc.segment4,
          cc.segment5, cc.segment6, cc.segment7, cc.account_type,
          gb.period_name, gb.period_year, gb.period_num
 ORDER BY cc.account_type, cc.segment5, cc.segment4, gb.period_year, gb.period_num;
```

**Prediction to check:** if the appropriation really is a source of funds, the rows this returns
carry `cc.account_type <> 'E'` — and those account types are exactly what the current extract cannot
produce. Add `AND cc.segment5 = '0450'` to restrict to the report's Level.

#### Queries 5+ — the longer way round, and the budget-journal fallback

```sql
-- A. Which budget type is the appropriation?
SELECT bty.budget_type_id, bty.budget_name, bty.encumbrance_type_id,
       ent.name AS budget_entity
  FROM gl_budget_types      bty
  JOIN gl_budget_entities   ent ON ent.budget_entity_id = bty.budget_entity_id
 WHERE bty.ledger_id = :ledger_id
 ORDER BY bty.budget_name;

-- B. The versions, OLDEST FIRST -- the first row is the FY23 appropriation
SELECT bv.budget_version_id, bv.budget_name, bv.budget_type_id,
       bv.first_period_name, bv.last_period_name, bv.creation_date
  FROM gl_budget_versions bv
 WHERE bv.ledger_id      = :ledger_id
   AND bv.budget_type_id = :appropriation_type_id
 ORDER BY bv.first_period_name, bv.creation_date;

-- C. Alternative if each line is a posted budget journal (also gives the BOE date)
SELECT h.je_header_id, h.name, h.description, h.je_category, h.je_source,
       h.period_name, h.default_effective_date, h.posted_date, h.status,
       l.code_combination_id, l.entered_dr, l.entered_cr
  FROM gl_je_headers h
  JOIN gl_je_lines   l ON l.je_header_id = h.je_header_id
 WHERE h.ledger_id     = :ledger_id
   AND h.actual_flag   = 'B'                -- B = Budget
   AND h.status        = 'P'
 ORDER BY h.default_effective_date, l.code_combination_id;
```

#### Controls — run these before trusting any result above

A query returning 0 rows is **not** proof the appropriation does not exist; it may equally mean a
wrong `:ledger_id` or a wrong currency filter. So bracket every run:

| Control | Expected | Meaning if it fails |
|---|---|---|
| `SELECT 1 FROM dual;` | 1 row | the connection/session is broken — ignore everything else |
| `SELECT 1 FROM gl_zzz_no_such_object;` | `ORA-00942` | if this *succeeds*, the script is not actually running the SQL you think |
| Query 0 returns rows | ≥ 1 | the budget objects are reachable at all |
| Query 2 returns exactly 1 ledger | 1 row | `chart_of_accounts_id = 101` is not unique — pick from the list |
| Query 1 `sum_net_dr` + `sum_net_cr` ≠ 0 | non-zero | the currency/translated-flag filters are wrong |
| Query 1 `allocation_amount` | **should be 1,000,000** (or −1,000,000) | matches the report's first funding line |

**Still required to run any of the above:** the reachability result in §12 means none of these
objects is currently visible to the `POWERAPPS` account, so the DBA must act first.

### 11.7 Getting the first allocation for a **newly added** budget code

Query 1 above does **not** answer this, and it is worth being explicit about why. Query 1 is keyed
on the **budget version**: it picks the earliest version in the ledger, then sums every account in
it. That is right for "the first allocation" read as *the first funding event of the fiscal year*.
It is wrong for *"a code finance added last month"*, because that code was never in the FY23
version. Run as written it returns no rows for the new code — or, worse, if the code does appear in
some later version, the `FIRST_PERIOD_NAME` ordering reports a misleading "first".

#### 11.7.1 The change: invert the grain

| | Query 1 (existing) | New code (this section) |
|---|---|---|
| Driven by | `gl_budget_versions` | `gl_code_combinations` |
| Partitioned by | `budget_type_id` | **`code_combination_id`** |
| Ordered by | version `first_period_name` | **`period_year`, `period_num`** |
| Answers | "the ledger's first version, and what it funded" | "**this code's** first funding, whenever it happened" |

#### 11.7.2 "First" means two different things — and for a new code they disagree

This is the crux, and it is exactly where a new code differs from an old one:

| Definition | Lives in | A code added mid-year |
|---|---|---|
| **First version that covers the code** | `GL_BUDGET_VERSIONS.FIRST_PERIOD_NAME` | The *existing* FY version — starts `JUL-22` |
| **First period the code actually received money** | `GL_BALANCES.PERIOD_YEAR` / `PERIOD_NUM` | `NOV-22` or later |

A new code is normally added to the **already-running** budget version. Its version's
`FIRST_PERIOD_NAME` is the start of the fiscal year, but its first *allocation* is months later.
So ordering by the version's first period tells finance the code was funded in July when it was
funded in November. **Order by `PERIOD_YEAR`, `PERIOD_NUM` instead** — that is the query below.

A third, stricter definition exists: the first **budget journal line** posted against the code,
from `GL_JE_LINES`. That is the only one that carries a real date (and therefore the BOE date) —
see 11.7.5.

#### 11.7.3 New evidence: codes really are added in batches over time

`LAST_UPDATE_DATE` in `json-output.json` is **not** constant, which rules out a single mass load:

| Measure | Value |
|---|---|
| Rows carrying `LAST_UPDATE_DATE` | 512 of 532 (the 20 `cost-center.json` rows have no such column) |
| Distinct timestamps | **234** |
| Range | `2024-10-04` → `2026-07-27` |
| Rows by year | 2024: 20 · 2025: 326 · 2026: 166 |
| Largest single days | `2025-09-04`: 66 · `2025-10-22`: 45 · `2025-11-21`: 22 · `2026-03-09`: 16 |

Those clusters are batch adds — 66 codes touched within a few minutes on one day, then quiet for a
week. **The scenario in this section is real and recurring, not hypothetical.**

> **Caveat — do not use `LAST_UPDATE_DATE` as "when the code was created".** It moves on *any*
edit (enable, disable, description change, attribute change), so an old code edited last week looks
new. The extract does not carry `CREATION_DATE` at all. **Add `CREATION_DATE` to the extract** if
"which codes are new?" needs to be answerable reliably — it is a one-column change to an existing
query.

#### 11.7.4 The SQL — first allocation for one new code

```sql
WITH code_period AS (
  SELECT gb.budget_version_id,
         gb.period_year,
         gb.period_num,
         gb.period_name,
         SUM(gb.period_net_dr)                    AS net_dr,
         SUM(gb.period_net_cr)                    AS net_cr,
         SUM(gb.period_net_dr - gb.period_net_cr) AS net_amount
    FROM gl_balances gb
   WHERE gb.ledger_id           = :ledger_id
     AND gb.code_combination_id = :new_ccid      -- <-- the new code
     AND gb.actual_flag         = 'B'            -- B = Budget only
     AND gb.translated_flag     = 'N'
     AND gb.currency_code       = :ledger_currency_code
     AND gb.encumbrance_type_id IS NULL
   GROUP BY gb.budget_version_id, gb.period_year, gb.period_num, gb.period_name
  HAVING SUM(gb.period_net_dr - gb.period_net_cr) <> 0   -- skip assigned-but-unfunded periods
)
SELECT cp.period_name        AS first_allocation_period,
       cp.period_year,
       cp.period_num,
       cp.net_dr,
       cp.net_cr,
       cp.net_amount         AS first_allocation_amount,
       bv.budget_name,
       bv.budget_type_id,
       bv.first_period_name  AS version_first_period,   -- note: earlier than the allocation
       bv.last_period_name   AS version_last_period,
       bv.creation_date      AS version_created
  FROM code_period cp
  JOIN gl_budget_versions bv ON bv.budget_version_id = cp.budget_version_id
 ORDER BY cp.period_year, cp.period_num, cp.period_name,
          cp.budget_version_id          -- deterministic when two versions share a period
 FETCH FIRST 1 ROW ONLY;      -- Oracle 12c+; use ROWNUM <= 1 on older
```

`version_first_period` vs `first_allocation_period` is the 11.7.2 distinction made visible in one
row. If they differ, that is the mid-year add, working as expected.

> **Why the version is in the `ORDER BY`.** A code can carry balances in **two versions covering
the same period** (an Original and a Revised for the same fiscal year). Without the version in the
sort key the tie breaks arbitrarily and the query returns a different row on different runs. If you
want a *specific* version rather than the earliest across all of them, add
`AND bv.latest_flag = 'Y'` (the current version) or an explicit `AND gb.budget_version_id = :v`.
> **See 11.7.9 before treating this as "the first funding".**

**Every code at once** — the plural reading of "any new code". Note `ROW_NUMBER()` runs *after*
`GROUP BY`, so it partitions correctly over the grouped rows:

```sql
WITH codes AS (
  SELECT cc.code_combination_id,
         cc.segment1||'.'||cc.segment2||'.'||cc.segment3||'.'||cc.segment4||'.'||
         cc.segment5||'.'||cc.segment6||'.'||cc.segment7 AS full_account
    FROM gl_code_combinations cc
   WHERE cc.chart_of_accounts_id = 101
     AND cc.creation_date      >= :since_date      -- the "new codes" window
),
code_period AS (
  SELECT gb.code_combination_id,
         gb.budget_version_id,
         gb.period_year,
         gb.period_num,
         gb.period_name,
         SUM(gb.period_net_dr - gb.period_net_cr) AS net_amount,
         ROW_NUMBER() OVER (PARTITION BY gb.code_combination_id
                            ORDER BY gb.period_year, gb.period_num,
                                     gb.period_name, gb.budget_version_id) AS rn
    FROM gl_balances gb
    JOIN codes c ON c.code_combination_id = gb.code_combination_id   -- bounds the scan
   WHERE gb.ledger_id           = :ledger_id
     AND gb.actual_flag         = 'B'
     AND gb.translated_flag     = 'N'
     AND gb.currency_code       = :ledger_currency_code
     AND gb.encumbrance_type_id IS NULL
   GROUP BY gb.code_combination_id, gb.budget_version_id,
            gb.period_year, gb.period_num, gb.period_name
)
SELECT c.full_account,
       cp.period_name   AS first_allocation_period,
       cp.period_year, cp.period_num,
       cp.net_amount    AS first_allocation_amount,
       bv.budget_name, bv.first_period_name AS version_first_period
  FROM code_period cp
  JOIN codes c   ON c.code_combination_id = cp.code_combination_id
  JOIN gl_budget_versions bv ON bv.budget_version_id = cp.budget_version_id
 WHERE cp.rn = 1
 ORDER BY c.full_account;
```

> **Do not run the batch version without the `codes` join.** `GL_BALANCES` is one of the largest
tables in EBS; an unfiltered aggregate over it will not return in a reasonable time. The
`JOIN codes` is what keeps the access path on the index — treat it as mandatory, not an
optimisation. (A silent, never-returning query is the failure mode here, not an error.)

#### 11.7.5 First allocation that carries a real date (and the BOE date)

```sql
SELECT h.je_header_id, h.name, h.description, h.je_category, h.je_source,
       h.period_name, h.default_effective_date, h.posted_date, h.status,
       h.currency_code, l.code_combination_id,
       l.entered_dr, l.entered_cr
  FROM gl_je_headers h
  JOIN gl_je_lines   l ON l.je_header_id = h.je_header_id
 WHERE h.ledger_id           = :ledger_id
   AND h.actual_flag         = 'B'              -- B = Budget
   AND l.code_combination_id = :new_ccid
 ORDER BY h.default_effective_date, h.je_header_id
 FETCH FIRST 1 ROW ONLY;
```

This is the query that returns the **BOE date** (§11.5): `default_effective_date` on the earliest
budget journal touching the code. `GL_JE_HEADERS` also carries `budget_version_id` and
`encumbrance_type_id`, which join the journal back to Query 1 — verify with Query 0 before relying
on them.

#### 11.7.6 Is the code even budgetable?

A newly created code can exist and still be impossible to fund. Check the two flags:

```sql
SELECT cc.code_combination_id,
       cc.segment1||'.'||cc.segment2||'.'||cc.segment3||'.'||cc.segment4||'.'||
       cc.segment5||'.'||cc.segment6||'.'||cc.segment7 AS full_account,
       cc.account_type, cc.enabled_flag, cc.summary_flag,
       cc.detail_posting_allowed_flag,
       cc.detail_budgeting_allowed_flag,      -- must be 'Y' to receive budget
       cc.creation_date, cc.last_update_date,
       cc.created_by, cc.last_updated_by
  FROM gl_code_combinations cc
 WHERE cc.chart_of_accounts_id = 101
   AND cc.segment5 = :level                 -- or cc.code_combination_id = :new_ccid
 ORDER BY cc.creation_date DESC;
```

- `detail_budgeting_allowed_flag = 'N'` → the code cannot take budget at all. Money would go to a
  different code, and this section's queries correctly return nothing.
- `summary_flag = 'Y'` → it is a roll-up parent and holds no balances. Every code in our extract is
  `N` (§11.3), but a *new* one might not be.
- `enabled_flag = 'N'` → created but not usable yet.

`GL_BUDGET_ASSIGNMENTS` is the other check, but read §11.1's correction: it stores **account
ranges** (`RANGE_FROM` / `RANGE_TO` as concatenated account strings), not a list of codes. It
answers "is this code inside a budgetable range?", and the range comparison has to match how EBS
concatenates segments for that chart of accounts — so retrieve the assignment rows and test
membership rather than relying on a plain `BETWEEN`.

#### 11.7.7 If the account is spoken as segments, not a CCID

Finance will say *"the new budget code 04.6560.862.529.0450.0840.000"*, not `9680025`. Resolve it
first — and note that a code can be **created** by simply posting to a new valid combination, so
this lookup may find a code the extract has never seen:

```sql
SELECT cc.code_combination_id, cc.account_type, cc.summary_flag,
       cc.creation_date, cc.last_update_date
  FROM gl_code_combinations cc
 WHERE cc.chart_of_accounts_id = 101
   AND cc.segment1 = '04'      AND cc.segment2 = '6560'
   AND cc.segment3 = '862'     AND cc.segment4 = '529'
   AND cc.segment5 = '0450'    AND cc.segment6 = '0840'
   AND cc.segment7 = '000';
```

A blank `code_combination_id` means those segments are not a valid EBS combination — an entirely
different problem from "no budget yet".

#### 11.7.8 Added controls for this section

| Control | Expected | Meaning if it fails |
|---|---|---|
| 11.7.6 returns the code | 1 row | the code does not exist → stop, do not read a zero-row amount as "unfunded" |
| 11.7.6 `detail_budgeting_allowed_flag` | `Y` | the code cannot be budgeted; the absence of an allocation is correct |
| 11.7.4 `first_allocation_period` ≥ version `first_period_name` | always | if the allocation **precedes** the version start, the version filter is wrong |
| 11.7.4 `first_allocation_period` ≠ version `first_period_name` | usually | equal is fine, but for a genuinely new code it should differ — if it never differs, check that `:new_ccid` is the new code and not an old one |
| Same query with `:new_ccid` = `9680025` | returns a row | proves the query shape works on a code known to carry budget. **Run this first** — it is the positive control the new code cannot provide |

That last one matters most. A new code with no budget returns zero rows, which is indistinguishable
from a broken filter. Running the identical SQL against `9680025` (Level 0450, known to be in the
extract) separates "query wrong" from "code unfunded".

#### 11.7.9 "Will this return the first *funding*?" — three ways it can mislead

**Short answer: yes in the ordinary case**, because of the `HAVING SUM(...) <> 0`. Drop that clause
and you get the first period the code *appears at all* — which for a code assigned to a running
version is the version's start period, months before any money arrived. The `HAVING` is what turns
"first period it existed" into "first period it was funded".

But "first" is only as good as the evidence in the table being read. Three caveats, in order of
how likely they are to bite:

**(a) A period where funding nets to zero is skipped.** `GL_BALANCES` stores the *net* debit and
credit for a period — it keeps no record of gross activity. So a code that was budgeted and then
reversed inside the same period is **indistinguishable from a code never funded**: both show net 0,
both are excluded by the `HAVING`, and the query reports the *next* period as "first". No
filter on `GL_BALANCES` can see this. Only `GL_JE_LINES` retains the gross lines.

**(b) The returned period is an accounting period, not a date.** This is the big one. Budget
journals are typically posted to the **start of the fiscal year** so the budget applies for the whole
year — so a code finance funded in **March 2026** can legitimately come back as
`first_allocation_period = JUL-25`. That is not a bug; it is how GL budgeting works. The period
tells you *when the money takes effect*, not *when finance acted*. Only the journal's
`POSTED_DATE` / `CREATION_DATE` answers "when did finance do this?"

**(c) Two versions can share a period** — handled above by the version tiebreak, but be aware the
answer may be a revised version rather than the original.

| The question | Which query answers it |
|---|---|
| When does the budget first take **effect**? | §11.7.4 (`PERIOD_YEAR`/`PERIOD_NUM`) |
| When did finance first **act**? | §11.7.9 below (`POSTED_DATE`) |
| What were the gross amounts, including reversals? | §11.7.9 below (`ENTERED_DR`/`CR`) |
| Which code combination is it? | §11.7.6 / §11.7.7 |

**The authoritative query.** Journal level, so it sees gross activity and carries real dates:

```sql
SELECT h.je_header_id,
       h.name                       AS journal_name,
       h.je_category, h.je_source,
       h.period_name                AS accounting_period,   -- what GL_BALANCES reports
       h.posted_date                AS finance_acted,       -- real chronology
       h.default_effective_date,
       h.currency_code, h.status,
       l.entered_dr, l.entered_cr,
       l.entered_dr - l.entered_cr  AS line_amount
  FROM gl_je_headers h
  JOIN gl_je_lines   l ON l.je_header_id = h.je_header_id
 WHERE h.ledger_id           = :ledger_id
   AND h.actual_flag         = 'B'                     -- B = Budget
   AND h.status              = 'P'                     -- posted only
   AND l.code_combination_id = :new_ccid
   AND (l.entered_dr <> 0 OR l.entered_cr <> 0)        -- gross activity, not net
 ORDER BY h.posted_date, h.je_header_id
 FETCH FIRST 1 ROW ONLY;
```

Run this **alongside** §11.7.4 for the same code and compare the two dates. If the balance query
says `JUL-25` while the journal says `MAR-26`, both are correct — they answer different questions,
and the pair is the clearest possible demonstration of why the distinction matters.

**(d) "Created but not funded yet" is a real, readable answer.** This is the case in the question,
and it needs no special SQL — it needs the two queries read together:

| §11.7.6 (code exists?) | §11.7.4 (funded?) | Meaning |
|---|---|---|
| no row | *(don't run)* | Code does not exist — the segments are not a valid combination |
| row, `detail_budgeting_allowed_flag='N'` | 0 rows | Cannot be budgeted at all; absence of allocation is correct |
| row, `enabled_flag='Y'`, budgeting allowed | **0 rows** | **Created but not yet funded** — the expected, correct answer |
| row | 1 row | Funded; the row gives the period, amount and version |

So a zero-row result from §11.7.4 does **not** mean "no data" — paired with §11.7.6 it means
"exists, nothing yet", which is a legitimate state that finance will be in for weeks or months.

> **Practical consequence for an app.** If this feeds a UI, show **"Budget code created — no
> allocation yet"** rather than a blank or a zero. `0` and `no row` are different facts, and only
> the second is true here. The same trap as §11.3's all-expense finding: an absent value read as a
> zero produces a confidently wrong number.

#### 11.7.10 You do not need `ledger_id` or `new_ccid` — derive them

Both are internal EBS identifiers that finance neither knows nor should be asked for. Each can be
derived from something already known, so the **only inputs are the segment values** — which is
exactly how finance speaks about the code.

| Value the SQL needs | Where it comes from | Derivable? |
|---|---|---|
| `new_ccid` | `GL_CODE_COMBINATIONS` | **Yes** — from `segment1..7` + `chart_of_accounts_id` |
| `ledger_id` | `GL_LEDGERS` | **Yes** — from `chart_of_accounts_id = 101`, already known |
| `ledger_currency_code` | `GL_LEDGERS.CURRENCY_CODE` | **Yes** — joined from the ledger row |
| `chart_of_accounts_id` | **Known: 101** (§11.6) | Already have it |
| `segment1..7` | finance | **No — the real inputs.** Everything else follows |

**The self-contained query.** Bind the seven segments; nothing else:

```sql
WITH acct AS (                      -- replaces :new_ccid
  SELECT cc.code_combination_id
    FROM gl_code_combinations cc
   WHERE cc.chart_of_accounts_id = 101
     AND cc.segment1 = :s1
     AND cc.segment2 = :s2
     AND cc.segment3 = :s3
     AND cc.segment4 = :s4
     AND cc.segment5 = :s5
     AND cc.segment6 = :s6
     AND cc.segment7 = :s7
),
code_period AS (
  SELECT gb.budget_version_id, gb.period_year, gb.period_num, gb.period_name,
         SUM(gb.period_net_dr)                    AS net_dr,
         SUM(gb.period_net_cr)                    AS net_cr,
         SUM(gb.period_net_dr - gb.period_net_cr) AS net_amount
    FROM gl_balances  gb
    JOIN acct        a ON a.code_combination_id = gb.code_combination_id
    JOIN gl_ledgers  l ON l.ledger_id           = gb.ledger_id
   WHERE gb.actual_flag         = 'B'                    -- B = Budget
     AND gb.translated_flag     = 'N'
     AND gb.encumbrance_type_id IS NULL
     AND gb.currency_code       = l.currency_code         -- derived, not supplied
   GROUP BY gb.budget_version_id, gb.period_year, gb.period_num, gb.period_name
  HAVING SUM(gb.period_net_dr - gb.period_net_cr) <> 0
)
SELECT cp.period_name        AS first_allocation_period,
       cp.period_year,
       cp.period_num,
       cp.net_dr, cp.net_cr,
       cp.net_amount         AS first_allocation_amount,
       bv.budget_name,
       bv.budget_type_id,
       bv.first_period_name  AS version_first_period
  FROM code_period cp
  JOIN gl_budget_versions bv ON bv.budget_version_id = cp.budget_version_id
 ORDER BY cp.period_year, cp.period_num, cp.period_name, cp.budget_version_id
 FETCH FIRST 1 ROW ONLY;
```

The `gl_ledgers` join is on `ledger_id`, so it is 1:1 and cannot multiply the balance rows. Its only
job is to hand over the ledger's own currency, which is what makes `:ledger_currency_code`
unnecessary.

**Single-ledger shortcut.** Most EBS instances run one primary ledger, in which case the whole
`gl_ledgers` join can be dropped. One query tells you — and returns the value if there is only one,
because `MIN` over a single row *is* that row:

```sql
SELECT COUNT(*)           AS ledger_count,
       MIN(ledger_id)     AS only_ledger_id,
       MIN(currency_code) AS only_currency
  FROM gl_ledgers
 WHERE chart_of_accounts_id = 101;
```

`ledger_count = 1` → drop the join and the ledger filter entirely; the query is then driven purely
by the segment values. `> 1` → keep the join, because the same account exists once per ledger.

#### 11.7.11 Do not store the `CODE_COMBINATION_ID`

This is the practical reason to prefer segments even when the CCID is already in hand — and it
affects our own extracts, which carry CCIDs in every file.

`CODE_COMBINATION_ID` is an internal **surrogate key**. It is preserved by a physical clone (RMAN,
TTS, export/import), but it is **not** preserved by:

- a chart-of-accounts **reimplementation or upgrade** (values are recreated),
- **creating or copying a chart of accounts** into a new ledger — the copied combinations get **new**
  CCIDs, which is the common case people get caught by,
- any rebuild of `GL_CODE_COMBINATIONS`.

So `9680025` is valid for *this* instance *today* and nothing more.

| Practice | Verdict |
|---|---|
| Pass `segment1..7` + `chart_of_accounts_id` | **Durable.** Survives every kind of refresh |
| Persist a CCID in a table, config, or URL | **Fragile.** Silently wrong after a COA change |
| Join two *extract files* on CCID within one snapshot | Acceptable — same snapshot, same values |
| Join stored data to live `GL_CODE_COMBINATIONS` on CCID | **Fragile** — breaks across a refresh |

That last row is the one to watch in this project: `data/oracle/*.json` is keyed by CCID and is
loaded from a snapshot, while the budget queries run live. If a chart-of-accounts change ever
happens between the extract and a live run, CCID joins between them will silently return nothing
rather than error. **Use `segment1..7` as the cross-boundary key**, and let the CCID be local to each
query.

**Controls for the derived version:**

| Control | Expected | Meaning if it fails |
|---|---|---|
| `acct` CTE returns rows | exactly **1** | 0 = the segments are not a valid combination. **2+** = the same segments exist under more than one `chart_of_accounts_id`; the filter is too loose, and the amount will be doubled |
| `ledger_count` | 1, or a short list | > 1 with the join dropped means balances from several ledgers are being summed together |
| Drop `currency_code` and re-run | total **inflates** | confirms the currency filter is doing real work (a translated copy is being counted). If it does *not* change, the ledger has one currency and the filter is merely defensive |
| Same query on `0450` segments | 1 row | positive control — proves the derived-ledger version works before trusting a new code's result |

The `acct` row-count assertion matters most. A segment filter that matches two chart-of-accounts
rows returns **double** the amount with no error at all.

---

## 12. Live reachability test — what the account can actually see

Run over VPN on 2026-09-17. Dictionary-only; no business data read. Both controls behaved
correctly (a positive `DUAL`/`GL_CODE_COMBINATIONS` ping succeeded; a syntax error and a
non-existent object both failed), so these results are meaningful.

**The account is `POWERAPPS`; current schema is `POWERAPPS`.**

### 12.1 The extract is a curated set of 19 views — and none is budget-related

```
WCSEXP_AP_CHECKS              WCSEXP_GL_CODE_COMBINATIONS     WCSEXP_PO_LINE_LOCATIONS
WCSEXP_AP_INVOICES            WCSEXP_HR_LOCATIONS             WCSEXP_PO_LINE_TYPES
WCSEXP_AP_INVOICE_PAYMENTS    WCSEXP_MTL_SYSTEM_ITEMS         WCSEXP_PO_LOOKUP_CODES
WCSEXP_AP_INV_DISTRIBUTIONS   WCSEXP_PO_DISTRIBUTIONS         WCSEXP_PO_RELEASES
WCSEXP_AP_INV_LINES           WCSEXP_PO_HEADERS               WCSEXP_PO_VENDORS
WCSEXP_FND_ID_FLEX_STRUCTURES WCSEXP_PO_LINES                 WCSEXP_PO_VENDOR_CONTACTS
                                                              WCSEXP_PO_VENDOR_SITES
```

- Views whose name matches BUDGET / APPROP / FUND / ALLOC / GRANT / AWARD → **`NONE`**
- Views carrying any column matching BUDGET / APPROP / ALLOC / BOE / FUND → **`0 rows`**

The set is a **purchasing/invoicing extract**. Budget data was never in scope for it.

### 12.2 No standard budget object is reachable

All of the following returned `ORA-00942 table or view does not exist` via `APPS.`:

`GL_BUDGET_ENTITIES` · `GL_BUDGET_TYPES` · `GL_BUDGET_VERSIONS` · `GL_BUDGET_ASSIGNMENTS` ·
`GL_BUDGET_INTERFACE` · `GL_BALANCES` · `GL_JE_HEADERS` · `GL_JE_LINES` · `PA_PROJECTS_ALL` ·
`PA_BUDGET_VERSIONS` · `PA_BUDGET_LINES` · `GMS_AWARD_HEADERS_ALL` · `GMS_AWARD_BUDGET_LINES` ·
`FND_FLEX_VALUES_VL`

Also failed directly as `GL.<obj>`, `APPS.<obj>` and `SYSADMIN.<obj>` for `GL_BUDGET_VERSIONS`,
`GL_BUDGET_TYPES` and `GL_BALANCES`.

### 12.3 Rights or genuinely absent? Mixed — and the distinction matters

| Test | Result | Interpretation |
|---|---|---|
| `ALL_TABLES WHERE TABLE_NAME LIKE 'GL_BUDGET%'` | `0 rows` | Inconclusive on its own — `ALL_TABLES` is privilege-filtered |
| `ALL_VIEWS WHERE VIEW_NAME LIKE 'GL_BUDGET%'` | `0 rows` | Same caveat |
| `ALL_TAB_PRIVS WHERE GRANTEE = USER` | **20 privileges total** | Very narrow, purpose-built grant |
| Schemas visible in `ALL_TABLES` | only **14** owners; `APPS` visible with just **1** table | Consistent with a hand-made grant list |
| `ALL_SYNONYMS` for the budget objects | only `GL_CODE_COMBINATIONS` returned | **Suggests the others have no synonym at all** |

So the picture is **both**: the `POWERAPPS` grant is deliberately tiny (20 privileges), *and* the
budget views appear never to have been created. The decisive tell is §11.4 — a view documented
with accurate real column names but which does not now exist was either **dropped**, or the
document was written against a **different environment** that has since diverged.

**Honest scope limit:** `ALL_SYNONYMS` and `ALL_TABLES` are privilege-filtered, so absence from
them is not proof of non-existence. I did not enumerate the 20 privileges individually, and I did
not query `DBA_*` views (they would settle it, but require elevated rights). **The single cheap
test that would resolve this definitively is for someone with DBA rights to run:**

```sql
SELECT owner, object_name, object_type, status
  FROM dba_objects
 WHERE object_name IN ('GL_BUDGET_VERSIONS','GL_BUDGET_TYPES','GL_BUDGET_ENTITIES',
                       'GL_BUDGET_ASSIGNMENTS','GL_BALANCES','GL_JE_HEADERS','GL_JE_LINES',
                       'WCSEXP_GL_BALANCES','WCSEXP_GL_JE_HEADERS','WCSEXP_GL_JE_LINES')
 ORDER BY object_name, owner;
```

If rows come back → it is purely a **grant** problem, and the fix is a `GRANT SELECT`.
If they do not → the **data was never exposed**, and new views must be built.

### 12.4 What the DBA should be asked for

Either of these unblocks the funding block:

```sql
-- Option A: the objects already exist, just not granted
GRANT SELECT ON gl_budget_entities     TO powerapps;
GRANT SELECT ON gl_budget_types        TO powerapps;
GRANT SELECT ON gl_budget_versions     TO powerapps;
GRANT SELECT ON gl_budget_assignments  TO powerapps;
GRANT SELECT ON gl_balances            TO powerapps;
GRANT SELECT ON gl_je_headers          TO powerapps;
GRANT SELECT ON gl_je_lines            TO powerapps;

-- Option B: build the three missing extract views (same pattern as the existing 19)
CREATE OR REPLACE VIEW apps.wcsexp_gl_balances     AS SELECT ... FROM gl.gl_balances#;
CREATE OR REPLACE VIEW apps.wcsexp_gl_je_headers   AS SELECT ... FROM gl.gl_je_headers#;
CREATE OR REPLACE VIEW apps.wcsexp_gl_je_lines     AS SELECT ... FROM gl.gl_je_lines#;
GRANT SELECT ON apps.wcsexp_gl_balances   TO powerapps;
GRANT SELECT ON apps.wcsexp_gl_je_headers TO powerapps;
GRANT SELECT ON apps.wcsexp_gl_je_lines   TO powerapps;
```

(Option B mirrors the convention already proven in this instance: `APPS.GL_CODE_COMBINATIONS` is a
synonym over `GL.GL_CODE_COMBINATIONS#` — the EBS `#` shadow-table pattern.)
