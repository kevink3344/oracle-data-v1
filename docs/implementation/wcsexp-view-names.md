# The `WCSEXP_*` view names — two databases, one name

**Status:** resolved. There was never a factual disagreement — the two statements describe two
**different objects** that happen to share a name. Both are locally true and neither generalises.
**Date:** 2026-09-22.
**Evidence:** the Oracle half of §2, §3 and §4 was read from the **live database** on 2026-09-22
(`server/tmp-oracle-wcsexp.mjs`, `SELECT`s only, two full runs). **No cell of §4's table is asserted
any more.** The nullness of `PO_DISTRIBUTIONS_ALL.AMOUNT_ORDERED`, the presence of the formula inputs
on Oracle's `PO_LINE_LOCATIONS_ALL`, and the 213-column `PO_HEADERS_ALL` were all measured on the
second run, which also produced a fact the first run's error had been hiding: **the view returns more
rows than the table it reads** (§4).
**Supersedes:** the "plain pass-through" reading of `server/tmp-wcsexp-views.out.txt` (see §3, note
★). That reading used "the view has no `WHERE` clause" as a test for pass-through-ness, which is a
test for **row selection**, not for projection. A view can rename a column or invent one without
any `WHERE` clause at all. Thirteen of the eighteen do exactly that — see §3.

---

## 1. The contradiction, as written

Two comments, both in code, both confident, mutually exclusive on their face.

`data/sql/turso/00-schema.sql` §5 — a tombstone for the views:

> An earlier revision of this schema defined 18 `WCSEXP_*` views over the real tables […] They have
> been **REMOVED**, deliberately. […] Keeping the views would give every object two names and let
> the two halves drift apart — and **the views were never a pure pass-through**, so a query could
> behave differently depending on which name it used.

`app/src/data/extract.ts:20` — an argument *against* retiring them:

> ★ ★ **THE `APPS.WCSEXP_*` VIEW FAMILY IS NOT RETIRED.** All nineteen views are in the account's
> grant list. `WCSEXP_PO_DISTRIBUTIONS.AMOUNT_ORDERED` is a *computed* column […] reading the price
> from `PO_LINE_LOCATIONS_ALL`, and it reproduces this file's `AMOUNT` on every row probed […]
> Plain `PO_DISTRIBUTIONS_ALL.AMOUNT_ORDERED` is **NULL**.

Read naively, one of these is wrong. Neither is.

---

## 2. They are about different objects

`WCSEXP_PO_DISTRIBUTIONS` names **three** distinct things in this repository, and the two comments
each describe a different one:

| # | what | where it lives | who defines it |
| --- | --- | --- | --- |
| 1 | **Oracle's originals** — 19 granted views, **counted on the live database** | the live EBS account | Oracle. Grant catalogue. |
| 2 | **The sample's ports** — 18 hand-written SQLite views | the Turso sample (removed in v2) | `/workspace` — authored here |
| 3 | **The sample's base tables**, which already carry the extract's shape | the Turso sample, both versions | `scripts/build-turso-sample.mjs` |

So `00-schema.sql` §5 is a statement about **(2)** and `extract.ts:20` is a statement about **(1)**.
The reason they sound contradictory is that **(3) was doing the ports' job already**, which is what
made (2) removable — and neither comment mentions (3).

★ **Measured, and it is the load-bearing fact:** `PO_HEADERS_ALL.PO_NUMBER` **exists** on both
databases. `store.ts:110` says `WCSEXP_PO_HEADERS` is *"the **only** place the extract-shaped
columns exist on the live database"* — that is true of **Oracle**, where `APPS.PO_HEADERS_ALL` has
213 columns and no `PO_NUMBER`. It is **false of the sample**, which loaded the extract shape under
the base-table names (`ledger-shape.ts:5`). The sample therefore had two names for one shape, which
is exactly the drift `00-schema.sql` §5 gives as its reason for removing one of them.

---

## 3. What the eighteen actually are

Read from `sqlite_master` on the database that has them, not from the tombstone:

```
v1 (the old app store) : WCSEXP_* objects: 18  (views 18, tables 0)
v2 (the one database)  : WCSEXP_* objects:  0
```

Classified by the **live select list**, where a view stops being a pass-through either by renaming
a column (`AS`) or by inventing one (`NULL`):

```
pure pass-through : 13   WCSEXP_AP_INVOICES, WCSEXP_FND_ID_FLEX_STRUCTURES,
                         WCSEXP_GL_CODE_COMBINATIONS, WCSEXP_GL_JE_HEADERS,
                         WCSEXP_GL_JE_LINES, WCSEXP_GL_LOOKUPS, WCSEXP_PO_DISTRIBUTIONS,
                         WCSEXP_PO_HEADERS, WCSEXP_PO_LINES, WCSEXP_PO_LINE_LOCATIONS,
                         WCSEXP_PO_LINE_TYPES, WCSEXP_PO_VENDORS, WCSEXP_PO_VENDOR_SITES
differ (AS/NULL)  :  5   WCSEXP_AP_CHECKS, WCSEXP_AP_INVOICE_PAYMENTS,
                         WCSEXP_AP_INV_DISTRIBUTIONS, WCSEXP_AP_INV_LINES, WCSEXP_GL_BALANCES
```

★ **So `00-schema.sql` §5's "never a pure pass-through" is false for thirteen of the eighteen —
the majority.** The five that differ are real and are the reason the sentence was written: three
rename a column (`GL_BALANCES.LEDGER_ID AS SET_OF_BOOKS_ID`, `AP_INV_DISTRIBUTIONS.
CODE_COMBINATION_ID AS DIST_CODE_COMBINATION_ID`, `AP_CHECKS.PAYMENT_DATE AS CHECK_DATE`), one
re-labels a payment (`CHECK_NUMBER AS PAYMENT_NUM`, `INVOICE_PAYMENT_ID AS CHECK_ID`), and one
invents five columns outright:

```sql
CREATE VIEW WCSEXP_AP_INV_LINES AS
  SELECT LINE_NUMBER, INVOICE_ID, LINE_TYPE_LOOKUP_CODE, MATCH_TYPE,
         NULL AS DEFAULT_DIST_CCID, AMOUNT, NULL AS PO_HEADER_ID,
         NULL AS PO_LINE_ID, NULL AS PO_LINE_LOCATION_ID,
         NULL AS PO_DISTRIBUTION_ID
    FROM AP_INV_LINES
```

The justification for retiring them is sound **about those five**. It is not sound about the other
thirteen, and the distinction matters because of which one is in the other thirteen — see §4.

The two lists were never the same list, either. `store.ts:116-134` registers **19** names as the
account's granted set; the sample defined **18**; **14 are common**, 5 are registered with no sample
view (`HR_LOCATIONS`, `MTL_SYSTEM_ITEMS`, `PO_LOOKUP_CODES`, `PO_RELEASES`, `PO_VENDOR_CONTACTS`)
and 4 are sample views nothing routes (`GL_BALANCES`, `GL_JE_HEADERS`, `GL_JE_LINES`,
`GL_LOOKUPS`). Independently maintained, so not a subset of one another.

★ **And Oracle settles it: the live database has exactly nineteen `WCSEXP_*` objects, all of them
views, and they are exactly the nineteen `store.ts` names.** `SELECT object_type, COUNT(*) FROM
all_objects WHERE object_name LIKE 'WCSEXP\_%' ESCAPE '\' GROUP BY object_type` returns one row —
`{VIEW, 19}`. So three consequences follow, and each replaces a hedge with a number:

- `store.ts:116-134`'s comment — *"The list is the granted set from the account's own grant
  catalogue, not a guess"* — is **verified, not asserted**. The list is exactly the catalogue.
- The union is **exactly 23**, not *"at least twenty-three"*: 14 common + 4 sample-only + 5
  Oracle-only. Both of the two partial observations were correct; neither was a census, and now one
  of them is.
- The sample's **four** views with no Oracle counterpart are `GL_BALANCES`, `GL_JE_HEADERS`,
  `GL_JE_LINES`, `GL_LOOKUPS` — and those are **exactly the four that were never registered in
  `store.ts`**. So `18 − 4 = 14` and *"four sample views nothing routes"* are the same four, which
  is why the census gap in §6 is exactly 14. Two observations, one fact.

★ **And the two databases' views are not the same views.** Three more bodies read from Oracle —
`WCSEXP_PO_HEADERS`, `WCSEXP_AP_INV_LINES`, `WCSEXP_AP_CHECKS` — disagree with their sample ports on
exactly the axis §3 classifies:

| Oracle view | Oracle's body | the sample's port | verdict |
| --- | --- | --- | --- |
| `WCSEXP_PO_HEADERS` | `SEGMENT1 "PO_NUMBER"`, `ATTRIBUTE3 "EXP_PROJECT_NAME"`, `ATTRIBUTE4 "EXP_PO_NUMBER"` — column **renames**, in Oracle's `expr "ALIAS"` form, with no `AS` | the same three renames, written with `AS` | **both differ from the base** — the one case where the port was faithful |
| `WCSEXP_AP_INV_LINES` | every column a plain reference — **a pure pass-through** | `NULL AS DEFAULT_DIST_CCID` and four more invented NULLs | Oracle passes through; **the port diverged** |
| `WCSEXP_AP_CHECKS` | `CHECK_ID, CHECK_NUMBER, CHECK_DATE, AMOUNT` — plain | `CHECK_NUMBER AS PAYMENT_NUM`, `INVOICE_PAYMENT_ID AS CHECK_ID` | Oracle passes through; **the port diverged** |

So the *ports* were not transcriptions of the *views*. The port of `AP_INV_LINES` invents five columns
Oracle's does not — which means `00-schema.sql` §5's "never a pure pass-through", a claim about the
ports, is true of the ports and is **not a description of the Oracle views it names**. The two
families were independently authored and have drifted, which is the drift §2 diagnosed, arriving a
second time.

★ **And one of the sample's views has no Oracle counterpart under that name at all.**
`WCSEXP_GL_BALANCES` is in the sample's port set, but `SELECT owner, view_name FROM all_views WHERE
view_name IN (…)` returns only **three** rows for the four names probed — `WCSEXP_AP_CHECKS`,
`WCSEXP_AP_INV_LINES`, `WCSEXP_PO_HEADERS`. `WCSEXP_GL_BALANCES` is **absent from Oracle**, and it is
not among the nineteen of the census, which carries `WCSEXP_GL_CODE_COMBINATIONS` and no
`WCSEXP_GL_BALANCES`. Its empty body on the first run was not a failed read — **there was nothing to
read.** It is one of the four sample-only views, confirmed from the other side.

---

## 4. ★ The one name where "pass-through" is true, and why that is the dangerous one

`WCSEXP_PO_DISTRIBUTIONS` is **in the thirteen**. Its live body on the sample, verbatim:

```sql
CREATE VIEW WCSEXP_PO_DISTRIBUTIONS AS
  SELECT PO_DISTRIBUTION_ID, PO_HEADER_ID, PO_LINE_ID, LINE_LOCATION_ID,
         CODE_COMBINATION_ID, QUANTITY_ORDERED, AMOUNT_BILLED, ENCUMBERED_FLAG,
         ENCUMBERED_AMOUNT, DISTRIBUTION_NUM, AMOUNT_ORDERED
    FROM PO_DISTRIBUTIONS_ALL
```

Every column is a plain reference. No alias, no `NULL`, no expression. On the sample this view is
the base table.

**On Oracle it is not, and this is now measured rather than inferred.** Its body, read from
`all_views.text` on the live database, verbatim:

```sql
SELECT PD.PO_DISTRIBUTION_ID, PD.PO_HEADER_ID, PD.PO_LINE_ID, PD.LINE_LOCATION_ID,
       PD.CODE_COMBINATION_ID,
-- PO25897
       PD.DELIVER_TO_LOCATION_ID,
--
       PD.QUANTITY_ORDERED,
       ROUND( DECODE(PLL.QUANTITY, NULL, (PLL.AMOUNT - NVL(PLL.AMOUNT_CANCELLED,0)),
           (PLL.QUANTITY - NVL(PLL.QUANTITY_CANCELLED,0)) * NVL(PLL.PRICE_OVERRIDE,0) ) ,2 ) AMOUNT_ORDERED,
       PD.AMOUNT_BILLED, PD.ENCUMBERED_FLAG, PD.ENCUMBERED_AMOUNT, PD.DISTRIBUTION_NUM
FROM PO_DISTRIBUTIONS_ALL PD, PO_LINE_LOCATIONS_ALL PLL
WHERE PLL.PO_HEADER_ID = PD.PO_HEADER_ID
AND   PLL.PO_LINE_ID    = PD.PO_LINE_ID
```

Three things fall out of it, and the first one is stronger than the argument this document was
written to make:

- ★ **The view never reads `PD.AMOUNT_ORDERED` at all.** The base column is not consulted — it is
  *defined out* of the select list and replaced by the expression. So the repoint is not "reads a
  populated column instead of a NULL one"; it is **reads a column the view deliberately stopped
  using**. The conclusion no longer depends on the base column being NULL. That nullness only
  explains *why* someone wrote the view this way — and the answer is the same trap one step back:
  the column is unreliable, so the amount was recomputed from the line location.
- **It is a hand-customisation, not EBS standard.** The `-- PO25897` and bare `--` markers are a
  local patch inside a customer-owned view. That is *why* the `WCSEXP_*` family exists at all, and
  why its shape cannot be derived from EBS's own dictionary.
- ★★ **The join key is `(PO_HEADER_ID, PO_LINE_ID)` — and that is the key that fans out. Measured,
  and the opposite way round from the first reading of this body.** Sampling 2,000 distributions:
  joining `PO_LINE_LOCATIONS_ALL` on the view's own key returns **2,011** rows (`+11`), while joining
  on `LINE_LOCATION_ID` — the column name that *looks* like the distribution's key — returns
  **exactly 2,000**, one for one. So **`PO_DISTRIBUTION_ID` is not unique in the view**: over the same
  sample **1,993 of 2,000** distributions have exactly one view row and **7 have more than one** (up
  to 4). The view is not a per-distribution projection, and the obvious correlation
  `WHERE wd.PO_DISTRIBUTION_ID = d.PO_DISTRIBUTION_ID` — the one this document's own first probe used
  — fails outright with **`ORA-01427: single-row subquery returns more than one row`**. Anything
  re-deriving the view has to reproduce the fan-out, not avoid it.

That would make repointing a query from the view to the base table look free — and
`server/src/routes/vendorSites.ts:331` joins `APPS.WCSEXP_PO_DISTRIBUTIONS`, which is the view a
reader would be tempted to delete from the query. Measured, on **both** databases:

| | sample (Turso) | Oracle |
| --- | --- | --- |
| `WCSEXP_PO_DISTRIBUTIONS` exists | **no** — retired | **yes — an `APPS`-owned VIEW** (measured) |
| its `AMOUNT_ORDERED` | n/a | **computed** from `PO_LINE_LOCATIONS_ALL` (measured — see the body above) |
| `PO_DISTRIBUTIONS_ALL.AMOUNT_ORDERED` | **populated** — 2,802 rows, **0 NULL** | **NULL** — **0 of 2,000** sampled rows carry a value (measured) |
| the formula's inputs (`QUANTITY`, `AMOUNT`, `AMOUNT_CANCELLED`, `QUANTITY_CANCELLED`, `PRICE_OVERRIDE`) | **all absent** from `PO_LINE_LOCATIONS_ALL` | **all five present** (measured) — but `AMOUNT` and `AMOUNT_CANCELLED` are themselves **0 of 2,000 populated**, so the `DECODE`'s *first* branch never fires (measured) |
| rows per distribution in the view | **1** — the view *is* the table | **1,993 of 2,000 exactly one; 7 with up to 4** (measured) |
| does `/api/vendor-site-register` serve here? | **no** — the `dialect` guard answers 503 | yes |

★ **Both of the cells that were asserted are now measured, and the first is stronger than the motive
it was standing in for.** `PO_DISTRIBUTIONS_ALL.AMOUNT_ORDERED` is NULL on **2,000 of 2,000** sampled
rows while the view supplies a value for **every one of them** — `base_null_view_has = 2000`,
`no_view_row = 0`. So the view is not a convenience over a nullable column; it is the *only* source of
the amount. And the four inputs are not merely present: the reimplemented formula agrees with the
view on **2,030 of 2,030** joined rows (`agree = 2030`, `view_null = 0`, `formula_null = 0`), which
makes `extract.ts:20`'s transcription **verified**, not merely faithful. The measured discriminating
row is order **275678** line **3**: `QUANTITY = 3`, `QUANTITY_CANCELLED = 0`, `PRICE_OVERRIDE =
24.61`, base amount `null`, view amount **73.83** — and $3 \times 24.61 = 73.83$.

★ **The two cells that were asserted are now measured.** The view's text already showed the formula
is authoritative and the base column unused, which is the whole of what the repoint argument needs;
the null count and the input columns confirm the *motive*. They are kept as rows rather than folded
into the prose because a reader should be able to see which half of this table was read off the wire
on which run.

So the same edit has opposite values on the two databases:

- **on the sample** `wd.AMOUNT_ORDERED` → `d.AMOUNT_ORDERED` is a **no-op** — identical by
  construction, because the view *is* the column. It reads correctly here and proves nothing.
- **on Oracle** the same edit reads a **base column the view deliberately stopped using** — one that
  its `extract.ts:20` reading reports as NULL — in place of the amount the view computes from the
  line location. A regression that looks like a fix, on the only store where the route actually
  answers.

★ **And the Oracle formula cannot be evaluated on the sample at all.** `extract.ts:20`'s
`ROUND(DECODE(PLL.QUANTITY, NULL, PLL.AMOUNT - NVL(PLL.AMOUNT_CANCELLED,0), …))` — which the body
above confirms is Oracle's formula **word for word**, so that comment is a faithful transcription —
needs `AMOUNT`, `AMOUNT_CANCELLED`, `QUANTITY_CANCELLED` and `PRICE_OVERRIDE` on
`PO_LINE_LOCATIONS_ALL`. **None of the four exists on either database's sample table.** So an inline
port of the formula is writable only for Oracle and **cannot be validated here** — the columns it
needs are not present to test against.

**This is the substance of the entry at `vendorSites.ts:113`** — *"It does not read
`PO_DISTRIBUTIONS_ALL`. `AMOUNT_ORDERED` is NULL on these rows; the amount comes from
`APPS.WCSEXP_PO_DISTRIBUTIONS`, which computes it from `PO_LINE_LOCATIONS_ALL`."* That comment is
**correct about Oracle**, which is the only store the endpoint serves, and it is the reason the
repoint is not the mechanical substitution it reads as. The comment's scope is what needs fixing,
not its content: it states an Oracle fact without saying so, so on the sample it looks like a
preference rather than a requirement.

---

## 5. What changed for the code

Nothing here is a call to edit `00-schema.sql`. That file is **read-only by convention** — two plan
documents say so in three places (`custom-table-fields.md:128` *"read-only and is not touched"*,
`:420` *"Never touched […] (read-only)"*, `view-builder.md:254` *"is not to be modified"*) — and
`build-turso-sample.mjs:831` only ever *reads* it. §5's tombstone stands as written; the correction
in §3 above is recorded here instead, beside it rather than inside it.

Two consequences are worth stating once:

- **`ledger-shape.ts` still resolves on both databases**, and by design. Its order is declared
  divergence → base table → `WCSEXP_<table>` view → base table with absent columns projected as
  `NULL`. On v2 step (3) never matches for the 18 removed names and step (4) answers; on Oracle
  step (3) does. That is the intended shape and it is why the removal did not break the routes.
- **The route's 503 is not caused by the missing view.** `vendorSites.ts:1557` refuses whenever
  `ledger.dialect !== 'oracle'`, before the SQL is built. On the consolidated store the register
  answers 503 whether or not the query names the view, so the repoint changes **Oracle behaviour
  only**. (Its message interpolates `DB_MODE=local` from the dialect without consulting `DB_MODE`,
  which is `turso` here — a separate, pre-existing message defect.)

---

## 6. The activity register's object list, and why the drop is correct

The eighteen sample views were also why the two databases disagree about *how much there is*:

| | v1 (split) | v2 (consolidated) |
| --- | --- | --- |
| objects the census sees | **71** | **53** |
| `readings.comparable` | **56** | **34** |
| views on the database | 24 = 6 + 18 | 6 |

The 18 removed from the count are exactly the 18 retired ones, and `comparable` falls by 22. **The
lower number is the correct one.** v2's 53 is what `00-schema.sql` deliberately defines; v1's 71
counted eighteen objects the schema had decided should not exist. A register that lists them is
listing a port's scaffolding, not a data source. This is a fix in the numbers, not a regression.

★ **And it is the same event seen twice.** `readings.read` is `readings.size` — every object name
with a reading **on or before** the day — while the assertion compares it against the rows in the
*current* list that carry a reading. Measured on the consolidated store
(`GET /api/activity?date=2026-09-22`): `tables = 53`, `counted = 67`, `readings.read = 67`, and
**all 53 rows carry a reading** — so the summary reported **67 counts over a table of 53 rows**,
and the gap was **exactly 14**.

**14 is 18 minus 4.** Four of the eighteen retired views — `WCSEXP_GL_BALANCES`, `_GL_JE_HEADERS`,
`_GL_JE_LINES`, `_GL_LOOKUPS` — were never registered in `store.ts` (see §3), so they were never
in the object list and never had a reading taken. The **other fourteen** were both present *and*
registered: they had readings, and when the list moved to v2 those readings stayed behind in
`table_count_snapshot`, the one table the consolidation never touched. **So the census gap is the
retirement, not a second defect** — and the fix belongs in the route, which now derives `counted`
and `readings.read` from the object list rather than from the readings table.

★ **The same substitution is already in the plans.** `view-builder.md:9` grounds itself in *"the
36 tables / **24 views** in `00-schema.sql`"*. The file creates **6** views. **24** is the v1
*database's* count — 6 plus the 18 retired ports. A document that reads a database's inventory and
attributes it to the schema file is precisely the conflation diagnosed in §2, and it is what made
the eighteen look permanent rather than provisional. Corrected here rather than in that file, which
is a plan of record.

---

## 7. The rule for a future reader

> **`WCSEXP_X` in this repository names two different things, and a comment that does not say
> which is the one you cannot trust.**
>
> If a comment says *"the view computes it"*, that is a claim about **Oracle**, where the views are
> live and some columns are derived.
> If a comment says *"these views were removed"*, that is a claim about the **sample**, where the
> extract shape lives under the base-table names instead.
>
> Neither is wrong. Neither generalises. And a query repointed from one name to the other is
> correct on exactly one of the two databases — **the one it is not tested on.**

---

## 8. How the Oracle half was measured

`server/tmp-oracle-wcsexp.mjs` — **`SELECT`s only**, no DDL, no DML, nothing written. It prints its
own log (`tmp-oracle-wcsexp.out.txt`), flushed per line, because a buffered pipe makes a run that is
making progress indistinguishable from one that has hung.

Four attempts were lost before one returned data, and every loss was a design fault rather than bad
luck — worth recording, because the same shape will recur:

- **A dead socket hangs; it does not throw.** `ORA-03113` mid-run left the next `execute` blocked
  forever with no timeout. Every step now races a clock — **including the connect and the
  `ALTER SESSION`**, which the first fix had left outside the race and where the hang actually lived.
- **One connection, reused.** Reconnecting per query was a coin flip on this VPN: roughly half the
  sockets opened and then blackholed. One connection is opened, the schema set once, and a failure
  drops *that* connection and opens exactly one replacement.
- ★ **`all_synonyms` hung reproducibly, on two independent runs, at the same statement** — which is
  what identified it as a property of the query and not of the link. It was belt-and-braces (the
  `all_objects` lookup already answers the same question), so it was deleted rather than debugged.
  **A probe that keeps a redundant statement keeps a redundant failure.**
- ★ **A partial result is still a result.** The final run died on `ORA-12262 Cannot resolve hostname`
  — the VPN dropped — *after* completing sections 1–4. Those sections answered the census and the
  body, which is the whole of what was outstanding. Sections 5–10 are still unread, and §4 marks the
  cells that depend on them. The instinct to discard a run that ended in an error would have thrown
  away the answer.

The three `ALTER SESSION` statements the probe issues are not optional. `CURRENT_SCHEMA = APPS` is
the load-bearing one: without it an unqualified `from` resolves against `POWERAPPS`, every real read
returns `ORA-00942`, and the `FROM DUAL` connectivity check still passes — a green light over a
broken probe.

### 8.1 The second run — sections 5–10, and three more design faults

The rerun returned all of 5–10, and every new fault was again in the probe rather than in the data:

- **`ORA-01427: single-row subquery returns more than one row`**, raised on *both* the base-vs-view
  comparison and the formula comparison. The obvious correlation `(SELECT wd.AMOUNT_ORDERED … WHERE
  wd.PO_DISTRIBUTION_ID = d.PO_DISTRIBUTION_ID)` assumes a uniqueness the view does not have.
  Replaced with an aggregate that **reports** the multiplicity instead of dying on it — and the
  multiplicity turned out to be the finding (§4). **An error that looks like a bad probe can be the
  answer.**
- ★ **`all_tab_columns` lists `PO_LINE_LOCATIONS_ALL#`, not `PO_LINE_LOCATIONS_ALL`.** The synonym's
  real table carries a `#`, so a dictionary lookup by the name used in the code returns **nothing** —
  and *nothing* reads as *"the column does not exist"* at the very moment section 7 was selecting
  all five of them successfully. This is the **same trap** `ledger-shape.ts:5` describes for
  `ORA-00942`: on a table-backed synonym the miss is reported against the *object*, never the
  column. Both names are now queried, so the false negative shows in the output instead of being
  inferred from it. **The first run reported `PO_HEADERS_ALL` as having 0 columns; it has 213.**
- **`LENGTH(text)` on `all_views.text` raises `ORA-00932: inconsistent datatypes: expected CHAR got
  LONG`** and killed the whole of section 10 before a single body was read — `text` is a `LONG`, and
  almost no function accepts one. Dropped; the owner listing that replaced it is what showed
  `WCSEXP_GL_BALANCES` is absent from Oracle altogether.

★ **And the lesson that keeps recurring: a test for one property is not a test for another.** Two of
the three faults above returned a *positive-looking* answer — a row count, a column count — to a
question nobody had asked. §4's first version was one edit away from recording `0 columns` and a
non-existent fan-out as measured fact.
