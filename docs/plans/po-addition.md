# The purchase order on an invoice — the route that returns nothing, the route that works, and the register that holds one school

## What was asked

> I need a plan for adding the PO number to invoices. WCSEXP_AP_INVOICES can link to WCSEXP_PO_HEADERS
> via the same PO_HEADER_ID. WCSEXP_PO_HEADERS has the PO_NUMBER. Please add the plan to
> /docs/plans/po-addition.md for me to review

**This is a plan, not an implementation.** Nothing has been built and no app file has been touched.

It is also not the plan the request implies, and the difference is the whole document. **The join named
in the request cannot be built: `WCSEXP_AP_INVOICES.PO_HEADER_ID` is populated on 0 of 2,569,410 rows.**
The order is on the invoice **line**, one join further out, and that route names an order for **110 of the
126** invoices in scope. Both halves of that sentence are measured against production Oracle, in
*The measurement* §1 and §2 below.

Every open question is answered in [Design §8 Decisions](#8-decisions). The three that shape the build:
the extract ships **`PO_NUMBER` and `PO_COUNT`** and *not* `PO_HEADER_ID`; the register's coverage is
**stamped onto `invoices.json` by the pull script** so the page can say what it is a slice of without
fetching 2 MB; and the per-account orders link **stays**, because it answers a different question than the
new column does (*measurement* §6).

---

## The answer in one line

**The column is cheap, the join is not the one in the request, and the honest version of this feature
ships two numbers rather than one.** `AP_INVOICE_LINES_ALL.PO_HEADER_ID → PO_HEADERS_ALL.SEGMENT1` names
the order this invoice was raised against for **110 of the 126** in-scope invoices — $4,921,015.73 of
$5,650,332.66 — and **never more than one order per invoice**, which is the single fact that makes an
invoice-level column a true statement rather than a guess. The other 16 name no order at all, and they are
recognisably prepaid cards, travel reimbursements and use tax. But the app's own purchase-order register is
**one school's orders** — fund `04`, programme `862`, cost centre **`0840`**, and nothing else — so only
**62 of the 126** invoices name an order that register can show. The 48 that cannot are not a broken link;
they are the register's scope, and the page has to say so at the point of the click.

---

## The measurement that shapes the design

Every figure below is measured against production Oracle (`POWERAPPS@europa.wcpss.net:1541/ebs_FA2DB`)
or against this repo's own served data, and the query behind each one is given where it needs
re-checking. **Every Oracle run carried two controls that must fail** — a deliberate syntax error
(`SELECT FROM WHERE ((` → `ORA-00936`) and an unknown object (`SELECT 1 FROM APPS.NO_SUCH_TABLE_ZZZ` →
`ORA-00942`). Both failed on every run, which is the only reason the PASSes below are worth reading.

### 1. The join in the request returns zero rows, and the column is the reason

`WCSEXP_AP_INVOICES` has **11 columns**: `INVOICE_ID, INVOICE_NUM, INVOICE_DATE, INVOICE_AMOUNT,
AMOUNT_PAID, PAYMENT_STATUS_FLAG, DESCRIPTION, VENDOR_ID, VENDOR_SITE_ID, VENDOR_NAME, PO_HEADER_ID`.
The `PO_HEADER_ID` on it is empty at every scope that matters:

```
whole table    0 populated of 2,569,410
FY2027 window  0 populated of     3,736
in scope       0 populated of       126
```

So `WCSEXP_AP_INVOICES → WCSEXP_PO_HEADERS` on `PO_HEADER_ID` is not a join that returns few rows — it is
a join that returns **none**, at every grain, including the whole table. There is nothing here to build on.

**The repo already knew this**, and §3 of `server/scripts/pull-invoices-extract.mjs`'s doc block says so in
as many words: *"`PO_HEADER_ID` is NULL on every row — 0 of 3,743 populated… So no invoice here can name
its purchase order, and the page must not pretend otherwise."* That finding was right. What was wrong was
the sentence that followed it — *"The purchase-order link is on the invoice LINE, and this extract does not
read the line"* — because the second clause is true of the **extract** while the first is true of the
**account**, and the account can read the line.

### 2. The route that works — and two names that are wrong

The order is on the invoice line, and both halves of the path are base tables:

```
AP_INVOICE_LINES_ALL.PO_HEADER_ID  →  PO_HEADERS_ALL.PO_HEADER_ID
PO_HEADERS_ALL.SEGMENT1            =   the PO number
```

- `AP_INVOICE_LINES_ALL` has **202 columns**; the PO ones are `PO_HEADER_ID, PO_LINE_ID, PO_RELEASE_ID,
  PO_LINE_LOCATION_ID, PO_DISTRIBUTION_ID`.
- `PO_HEADERS_ALL` has **213 columns**; the number is **`SEGMENT1`**. Measured: `INVOICE_ID 12166239`
  (`INVOICE_NUM` `LEASE/JULY26/F44`) → `PO_HEADER_ID 11319922` → `SEGMENT1` **`283929`**.
- **`ATTRIBUTE4` on `PO_HEADERS_ALL` is NULL.** The earlier hypothesis that the PO number lives in an
  attribute column is refuted; if the extract ever wants a second source, this is not it.
- **`WCSEXP_AP_INVOICE_LINES` and `WCSEXP_AP_INVOICE_DISTRIBUTIONS` do not exist** — both answered
  `ORA-00942`, measured in the same run. `WCSEXP_PO_LINES` (10 columns) and `WCSEXP_PO_DISTRIBUTIONS`
  (12 columns) *do* exist. So the view named for exactly this purpose is absent and the base table is the
  only route.
- A **second, corroborating** route agrees exactly: `AP_INVOICE_DISTRIBUTIONS_ALL.PO_DISTRIBUTION_ID →
  PO_DISTRIBUTIONS_ALL.PO_HEADER_ID` resolves the same **110** invoices with the same **0** multi-order
  cases. It is not needed — it is the cross-check, and §Verification uses it as one.

Reachability, with the money:

```
reachable      110 invoices   $4,921,015.73
not reachable   16 invoices     $729,316.93
                              ─────────────
                 126          $5,650,332.66   ← equals scope.inScopeValue on the current file, exactly
```

The two halves summing to `scope.inScopeValue` is the check that this route covers the register rather than
sampling it.

### 3. Never two orders on one invoice — which is why the column may be invoice-level

Histogram of `COUNT(DISTINCT PO_HEADER_ID)` per in-scope invoice:

```
0 orders → 16 invoices
1 order  → 110 invoices
2+       → 0 invoices
```

**This is the load-bearing measurement.** Fifty-three of the 126 invoices span more than one GL *account* —
and that is exactly why the existing per-account orders link exists and belongs on the account row. **Zero**
invoices span more than one *order*. So "the purchase order for this invoice" is a real singular, and an
invoice-level column states a fact. Had one invoice carried two orders, the number would have to live on
the account row instead, and Design §8's first decision would be a different one.

The extract still ships `PO_COUNT` alongside the number (Design §1) precisely so this stays a *proven*
singular rather than an assumption that `MAX()` quietly enforces.

### 4. The 16 that name no order, and what they are

$729,316.93 across 16 invoices, and the list is coherent:

```
REIMB PRC JULY26                    $693,915.13
PCARD JUN 2026 BOND                  $23,839.04
TRAV/071726                           $2,488.42
2997                                  $2,488.20
2998                                  $2,488.20
260722.1                              $1,900.00
USE TAX/05AUG2618:11/F04/7.25           $476.08
NB3V23                                  $473.76
8071560                                 $453.09
859945                                  $445.68
6069231446                              $132.08
REIMB/072826                            $103.99
NA9VU7                                   $98.83
NC1YT0                                   $23.00
74302/EL                                  $0.00
6069507547                                −$8.57
```

**Prepaid cards, travel reimbursements, use tax, standing charges, and one credit.** These are invoices
raised against no purchase order, which is a normal state for exactly this family — and it is the same
family the register's page already names in its own footnote (*"purchase cards, use tax, standing
charges"*). The empty state must name it, because *"no purchase order"* on a $693,915 reimbursement and
*"no purchase order"* on an $8.57 credit are the same sentence and completely different facts.

### 5. ★ The register holds ONE school's orders — measured, with two hypotheses killed first

This is the finding that changes what the feature can promise, and it took three probes because the first
two explanations were plausible and both were **wrong**.

`data/oracle/full-output.json` — the register's source — holds **2,782 lines across 742 orders**, 18
columns, with these value sets:

```
FUND        1 distinct   '04'
PROGRAM     1 distinct   '862'
COST_CENTER 1 distinct   '0840'      ← the one that matters
FUTURE_USE  1 distinct   '000'
PURPOSE     3            '6570','9000','6560'
OBJECT_     9            '527','529','531','526','532','522','523','541','524'
LEVEL_      139 distinct
STATUS      2            'APPROVED','REQUIRES REAPPROVAL'
ORDER_DATE  2025-01-02 … 2026-08-06
```

Of the **88 distinct PO numbers** the 110 invoices name, **49 are on the register and 39 are not.**

**Hypothesis 1 — "the 39 are programmes the register does not carry" — REFUTED.** Measured: of the 39 missing,
**0** lack an `862` account and **39** have one; of the 49 present, **49** have one. Every PO on both sides
touches programme 862. The gap is not the programme.

**Hypothesis 2 — "the 39 were approved outside the register's window" — REFUTED.** `PO_HEADERS_ALL.APPROVED_DATE`
ranges `2025-04-24 … 2026-07-24` for the ones present and `2023-04-27 … 2026-07-21` for the ones absent;
**0 of the 39 were approved after the register's own maximum date.** Both sets sit inside the register's
range, so the register is not a recent slice either.

**The actual cause — cost centre `0840`.** Applied to each reachable PO's own distribution accounts:

| predicate on the PO's distribution accounts | present (of 49) | missing (of 39) |
|---|---|---|
| `Fund 04` + `Program 862` | 49 / 49 | 39 / 39 |
| … **+ `Cost Center 0840`** | 49 / 49 | **only 4 / 39** |
| … + `Purpose ∈ {6570,9000,6560}` | 49 / 49 | **only 4 / 39** |

**35 of the 39 sit on a cost centre other than `0840`** — measured samples include `04/9000/862/541/0520/0434/000`
(CC `0434`), `04/6570/862/529/0742/0830/000` (CC `0830`), `04/9000/862/541/0575/0333/000` (CC `0333`),
`01/6400/015/311/0234/0810/000`, `02/6570/801/327/0318/0940/000`, `04/5130/862/541/0625/0825/000` — other
cost centres, and in three cases **other funds entirely**. Every one of the 49 *present* POs' accounts reads
`…/0840/000` in that segment.

So **`output.json` is one school's purchase orders** — fund 04, programme 862, cost centre 0840 — while the
invoice register is **every school's** fund 04 / programme 861-863 invoices. The two registers are not the
same population, and an invoice charged to another school cannot appear on the orders register no matter how
good the join is. **This is a scope artefact, not a broken join, and the plan must state it rather than
promise a link that lands empty.**

**Side observation, recorded because it will mislead someone:** the register's `ORDER_DATE` is not a creation
date. PO `218566` was created `2019-03-25`, approved `2026-06-05`, and its register `ORDER_DATE` is
`2025-05-20`. `ORDER_DATE` tracks `APPROVED_DATE` / `LAST_UPDATE_DATE` — a re-approval or revision date.
Any "orders this year" reading off that column is a reading of the wrong thing.

**The residue of 4 is UNEXPLAINED, and this plan says so rather than inventing a cause.**

```
230558   248612   258188   265008
```

All four carry the register's full account pattern (fund 04, programme 862, cost centre 0840, purposes
6570/6560) and all four are **absent** from it. Measured about each: `HDR_TYPE = STANDARD`,
`HDR_CANCEL = 'N'`, `AUTHORIZATION_STATUS = APPROVED`, `N_CANCELLED_LINES = 0`, line counts 9 / 8 / 1 / 1,
approved dates 2024-12-18 / 2024-02-23 / 2023-04-27 / 2024-01-22. The comparable **present** orders
(`218566`: 4 lines, approved 2026-06-05; `283833`: 1 line, approved 2026-05-28) do not separate from them on
line count, cancelled lines, type or status. **No distinguishing mechanism was found.** The plan ships the
list, states the count, and does not publish a reason — a plausible mechanism that was not measured is a
guess wearing a diagnosis, and this document would be the worst place to leave one.

### 6. Two relations, two hit rates — and a number in the code that is stale

The page already has an account-level orders link (`Invoices.tsx:1412`), which routes through the **account
combination**. The new column routes through the **invoice line**. They are not the same question, and the
measurement separates them cleanly.

Measured locally against the two served extracts
— no Oracle involved, and the account key is the seven segments joined in order: `invoices.json`'s
`SEGMENT1..7` against the register's `FUND, PURPOSE, PROGRAM, OBJECT_, LEVEL_, COST_CENTER, FUTURE_USE`.
Verification §4 re-runs it.

```
invoices.json Table3      184 rows, 126 invoices, 71 distinct accounts
full-output.json         2,782 lines, 328 distinct accounts

accounts found in the register    46 of 71
invoices with ≥1 such account     57 of 126
```

Both the zero-stripped and verbatim spellings of the 7-segment key give **46 of 71 and 57 of 126**, so the
normalisation is not the variable — which is worth knowing, because it was the obvious suspect.

> ★ **AN EARLIER DRAFT OF THIS TABLE SAID `57 of 71` FOR THE FIRST ROW, AND IT WAS WRONG.** It carried the
> *invoice* figure — 57 of 126 — down onto the *account* row, where the true count is 46. The two being the
> same number in that draft is what made it look confirmed. Both figures are now measured under both key
> spellings and neither moves. If a future edit finds these two rows *agreeing*, suspect a copy, not a
> coincidence.

Against the new route:

```
invoices naming an order                    110 of 126
invoices naming an order the register holds  62 of 126
invoices naming an order the register lacks  48 of 126
```

**Two consequences.**

First, **one claim in the code is stale, and it is not the one an account-level reading would guess.**
`app/src/data/purchaseOrders.ts`, the JSDoc on `ordersForAccountHref`, said *"this filter lands on data for
**37 of the 126** invoices in the register; for the other 89 the account is a combination no purchase-order
line is charged to"*. The measurement says **57** and **69**. That was corrected when this work landed.

**The rest of the account-side prose was already correct, and this is the trap worth recording.**
`Invoices.tsx` cites `46 of the 71` combinations and `57 of the 126` invoices, plus `$4,273,387.04` (the
covered value) and `$1,539,881` (the `DIST_AMOUNT` of the 25 uncovered accounts) — and **every one of those
re-measures correctly against the served files**, as does `budgets.ts`'s `328` accounts and `71` on the
invoice register. The first pass over this work flagged them as stale because they did not match the *line*
figures (110 named, 62 held); they are not supposed to. **Two relations share this page and only one of them
was wrong.** Correcting the correct ones would have been the larger error, so §4 of Verification now
re-measures the account side from scratch rather than diffing prose against prose.

Second, **neither relation subsumes the other, so both stay.** The account link answers *"what else has been
charged to the accounts this invoice touches?"* — it can find orders across an invoice's accounts and it is
the only route to the register for an invoice whose own line names no order. The invoice-level column answers
*"what is this invoice for?"* — it is what a reader assumes the word "purchase order" means on an invoice
row. The 62 and the 57 overlap heavily and for different reasons, so removing either loses a real answer.

**Where each figure actually lives**, so the next reader does not have to re-derive it:

| site | figure | relation | verdict |
|---|---|---|---|
| `data/purchaseOrders.ts` → `ordersForAccountHref` JSDoc | `37 of 126` / `other 89` | account | **stale → 57 / 69**, corrected with this work |
| `Invoices.tsx` → the account-row "Orders ›" link comment | `46 of the 71`, `1`, `69 of the 126` | account | correct, re-measured under both key spellings |
| `Invoices.tsx` → `AccountSection` JSDoc | `71`, `1`, `$5,565,211.86`, `46`, `25`, `328`, `$1,539,881` | account | correct (`$1,539,881.44` is the 25 accounts' own `DIST_AMOUNT`, spread over 87 invoices) |
| `budgets.ts` → the coverage block | `328`, `4`, `71`, `1` | account | correct |
| `Invoices.tsx` → the panel's purchase-order note | `110`, `16`, `62`, `48`, `$4,274,246.05` | **line** | new, read from `po` |
| the panel's removed literal `money(4273387.04)` | — | account | **deleted**, and correctly so: it was the account relation's covered value sitting in a sentence about the line relation. Nothing replaced it with a literal; the note now reads `po.inRegisterValue`. |

The last row is the reason `largestNotNamed` exists: a figure the pull can compute belongs in the pull's
output, where it cannot survive a re-measurement it disagrees with.

### 7. What the vocabulary rule and the Oracle dialect require here

- **Vocabulary.** `WCSEXP_*` is retired for `data/sql/` files — base tables only. Both **pull scripts** still
  query `APPS.WCSEXP_*`, and this change lives in a pull script. That is consistent, with one twist the
  measurement forces: the `WCSEXP_` view that would carry the invoice line **does not exist**, so this is the
  one place a pull script must reach a **base table** — `APPS.AP_INVOICE_LINES_ALL`. That single exception is
  the only reason this section exists at all.
- No `LIMIT` (`ORA-00933`), `COALESCE` not `IFNULL` (`ORA-00904`), no `FETCH FIRST` (blocked by
  `query-guard.ts`'s `DIALECT_RULES`), binds named `:d1`/`:d2` and never `:from`/`:to` (`ORA-01745`),
  `SELECT DISTINCT` must `ORDER BY` positional ordinals (`ORA-01791`), `IN` capped at 1,000 expressions
  (`ORA-01795`), unquoted aliases uppercased so every lowercase alias is quoted **and** quoted again in its
  `ORDER BY`, `INVOICE_DATE` is a real `DATE` so string binds need `TO_DATE(:d1,'YYYY-MM-DD')`, and **no
  `LISTAGG`** here (`ORA-01489`, measured).
- **The one trap this query has that the existing ones do not:** the invoice query already `LEFT JOIN`s
  `WCSEXP_AP_INVOICE_PAYMENTS` to build the check links. Adding a second one-to-many `LEFT JOIN` to the
  invoice **lines** would multiply the two — two lines and one check is two rows, and `links` would inflate
  with no error. The design below therefore puts the order in a **scalar subquery**, which cannot multiply
  rows and cannot disturb `links`. (This is arithmetic on a one-to-many join, not a hypothesis: two such
  joins in one `SELECT` multiply. The design avoids the question entirely rather than measuring it.)

---

## Design

### 1. The extract gains two columns, not one — and not the surrogate

`server/scripts/pull-invoices-extract.mjs`, `Table1`'s projection, gains:

```sql
(SELECT MAX(h.SEGMENT1)
   FROM APPS.AP_INVOICE_LINES_ALL l
   JOIN APPS.PO_HEADERS_ALL h ON h.PO_HEADER_ID = l.PO_HEADER_ID
  WHERE l.INVOICE_ID = i.INVOICE_ID) AS PO_NUMBER,
(SELECT COUNT(DISTINCT l.PO_HEADER_ID)
   FROM APPS.AP_INVOICE_LINES_ALL l
  WHERE l.INVOICE_ID = i.INVOICE_ID
    AND l.PO_HEADER_ID IS NOT NULL)  AS PO_COUNT,
```

`PO_COUNT` is not decoration. `MAX()` is a silent collapse: the day one invoice carries two orders, `MAX`
picks one and nothing anywhere reports that a choice was made. `PO_COUNT` is what turns *"never two orders"*
from something `MAX` assumed into something the pull **proves** — and §Verification asserts on it.

**`PO_HEADER_ID` is deliberately NOT shipped.** It would be an arbitrary pick the moment `PO_COUNT > 1`, and
nothing in the app reads it — the register keys on `ORDER_NUMBER` (`buildOrders` → `OrderRow.number`). A
column whose value is arbitrary under a condition that does not exist today is an invitation to exactly the
silent collapse `PO_COUNT` was added to prevent.

`PO_NUMBER` is `NULL` for the 16, never `''` — absent is not blank.

The `SCOPE` object, the fiscal window from `GL_PERIODS`, the three buckets and `day()` are untouched. The
result-set assembly at lines 674–680 gains nothing (the columns ride in `Table1`), and the write at line 721
does not move.

### 2. A new assertion, because a collapse with no assertion is the failure mode

The pull script's assertion block gains **Assertion 16: no invoice names more than one purchase order.**
(An earlier draft of this plan said 13; the block was already at 15 when this was written, so the new one is
16. Worth recording because a plan that names an assertion number is a plan somebody will grep for.)
It reports `MAX(PO_COUNT)` and the number of invoices with `PO_COUNT > 1`, and it fails loudly on a
non-zero count rather than warning — because a non-zero count means `PO_NUMBER` is now a lie and the column
must move to the account row. It also reports the two coverage figures (`110` / `16`) and the two values
(`$4,921,015.73` / `$729,316.93`), and asserts they sum to `scope.inScopeValue`. That last assertion is the
one that catches a scope change that silently stopped covering the register.

### 3. `invoices.json` gains a `po` coverage block, read from the register beside it

The page must be able to say *"this order is not on the register, and here is why"* **without fetching 2 MB
of register**. So the pull script reads `data/oracle/full-output.json` (a local file, no Oracle) and stamps:

```jsonc
"po": {
  "named": 110, "notNamed": 16,
  "namedValue": 4921015.73, "notNamedValue": 729316.93,
  "maxPerInvoice": 1, "invoicesWithMore": 0,
  "distinctNumbers": 88,
  "inRegister": 62, "notInRegister": 48,
  "inRegisterValue": 4274246.05, "notInRegisterValue": 646769.68,
  "numbersInRegister": 49, "numbersNotInRegister": 39,
  "absentFromRegister": ["283897", "258188", "…39 in total…"],
  "largestNotNamed": { "number": "REIMB PRC JULY26", "value": 693915.13, "invoiceId": 0 },
  "register": { "lines": 2782, "orders": 742, "maxDate": "2026-08-06",
                "fund": ["04"], "program": ["862"], "costCenters": ["0840"] }
}
```

**The register half is an array-per-segment, not a scalar** — `fund: ["04"]` — because the scope is
computed *live* in `PurchaseOrders.tsx` from the served lines rather than read from a constant, and a segment
that turned out to hold two values must render as two rather than have one picked for it. `COST_CENTER` is
not rendered anywhere in `app/src/**` today, so the register's cost-centre scope is a fact this block is the
only place to state.

**★ `largestNotNamed` is carried data, not prose.** The note the panel prints wants to say *"$693,915.13 of
that is on a single invoice"* and it must not hard-code the figure: a number baked into a `.tsx` file is
invisible to the pull that changes it, and this project has already shipped one such literal
(`money(4273387.04)`, since removed). Anything the pull can compute, the pull must stamp.

`datum-absent` — `absentFromRegister` is 39 short strings and it is what lets the UI render a **link** for
the 62 and a **stated reason** for the 48, rather than a link that lands empty 38% of the time. `register.*`
is stamped so a reader can tell whether the block describes the register **on disk now** — the hazard of a
cross-file number is that a re-pull of one without the other leaves it stale, and the block carries its own
fingerprint (line count, max date) so staleness is visible instead of silent.

**Which file is the register?** `data/oracle/full-output.json` is the source the pull reads;
`app/public/oracle/output.json` is **the same file renamed** by `app/scripts/sync-extract.mjs`
(`RENAMES = { 'full-output.json': 'output.json' }`), and that is what `/api/extract/current` serves.
**`full-output.json` carries no `source` block**, so the app's existing ETL-provenance mechanism
(`ExtractSource`) cannot describe it — which is why the register's scope rides in `po.register` instead of
being hung on a provenance stamp that is not there.

`sync-extract.mjs` needs **no** registration: it copies every `.json` in `data/oracle/` with no allow-list.

### 4. The reader

`app/src/data/invoices.ts`:

- The raw-row interface `RawInvoice` (line 124) gains `PO_NUMBER?: string | null` and
  `PO_COUNT?: number | string | null` as **optional** — an extract written before this change has neither and
  must still load. `PO_COUNT` is typed as *either* a number or a string because `outFormat = OUT_FORMAT_OBJECT`
  returns Oracle `COUNT(*)` as a number on some rows and a string on others; the existing `figure()` helper is
  the one place that is reconciled, and a new `Number()` here would be a second, unshared answer.
- `Invoice` (line 332) gains three fields, with a doc comment recording both the singular and its proof:

  ```ts
  /**
   * The purchase order this invoice was raised against, or `null`.
   *
   * `null` is a real answer, not missing data: 16 of the 126 in-scope invoices name no
   * order — prepaid cards, travel reimbursements, use tax, standing charges.
   *
   * An invoice-level order is truthful because it is never ambiguous: measured, every
   * invoice that names one names exactly ONE (110 × 1, 16 × 0, 0 × 2+), even though 53
   * of the 126 span several GL accounts. `poCount` is carried so that a change is
   * visible rather than silently collapsed by the extract's MAX().
   */
  poNumber: string | null;
  /** Distinct orders the invoice names. 0, or 1 today. Asserted upstream. */
  poCount: number;
  /**
   * Whether the register holds this invoice's number — and it is THREE-valued.
   *
   * `true`  the register holds it, so the number may be a link
   * `false` it does not, so the number must be plain text with a reason
   * `null`  the served file carried no `po` block at all, so nothing is known
   *
   * `null` is not `false`. A file written before this change has no coverage block,
   * so every number would read as "not in the register" — 110 rows calling 62 orders
   * absent. `null` collapses neither way; the row says "not yet compared" instead.
   */
  poInRegister: boolean | null;
  ```

  That third field is the one an implementer is most likely to get wrong, because a boolean is the obvious
  type and the obvious type loses the distinction the whole feature depends on: *"the register lacks this"* and
  *"nobody has compared this"* are different claims, and only one of them should ever be printed.
- `InvoiceScope`'s neighbour: a new `PoCoverage` interface mirroring Design §3, and `InvoicesExtract` (line 520)
  gains `po: PoCoverage | null` plus the derivable counts it does **not** duplicate. `PoCoverage.absent` is a
  `ReadonlySet<string>` rather than a `string[]`, because the row asks it once per invoice and 110 `includes()`
  calls over 39 strings is a scan where a set is a lookup; it is held as a set and never spread into the row.
- `loadInvoices` (line 583) maps it, using the existing `figure()` for the numbers and `text()` for the string,
  and the existing convention applies unchanged: *figures never `NaN`, absent is not zero*.
- **The coverage block is re-measured in the reader, not trusted.** The `named` / `notNamed` / value pair /
  `maxPerInvoice` / `distinctNumbers` / `inRegister` / ... counts are recomputed from the rows the loader
  **actually kept**, and only then does the row consult them. If a future filter drops rows, a stamped count
  would describe a set the page is no longer showing — which is the failure mode `InvoiceScope` already
  documents for a scope that is not re-derived.
- **`absent` is deliberately narrowed to the numbers `kept` still holds**, so the set and the rows cannot
  disagree: a number whose invoice was filtered away is not still "absent from the register" on this page.
  This is the one place the two are asymmetric, and it is asymmetric on purpose.
- **A file written before this column existed yields `po: null` and `poNumber: null`**, and the page then
  says nothing about purchase orders rather than inventing — the same rule `InvoiceScope.applied` already
  follows for an unscoped extract.

### 5. Where it renders — five states, replacing the placeholder at `Invoices.tsx:1899`

The current value is `<span className="invrow__none">none on this row — see each account below</span>`, and the
comment above it explains that no invoice-level answer exists. **That is no longer true, and the comment must
be rewritten in the same change** — the file already carries a `★ THIS SENTENCE USED TO BE FALSE` correction
for the previous revision of this idea, and leaving a second stale one in place is how the first one happened.

A `PurchaseOrder` component (`Invoices.tsx:1584`) owns the value; the row passes it `invoice` and `po`, and the
`po === null` case is handled by the *caller* rendering nothing rather than by the component inventing a state.

Five states. **Four are reachable on today's data; the fifth exists for a stale file and is the one an
implementer will not otherwise write.**

1. **Names an order the register holds (62).** The number, linked to `orderHref(poNumber)` →
   `/procurement/purchase-orders?order=…`, `title` naming the order and the destination.
2. **Names an order the register lacks (48).** The number as **plain text**, with the reason stated:
   *"not in this app's order register"*, and the `title` naming the register's fingerprint — fund `04` /
   program `862` / cost centre `0840` — read from `po.register` rather than written into the component. This is
   the state that makes the feature honest; a link here would land empty for 38% of the invoices that have an
   answer at all. **It states the scope, not a guess**: the four numbers that carry the register's own account
   pattern and are absent anyway (`230558`, `248612`, `258188`, `265008`) have **no cause this plan found**, so
   nothing in the UI attributes one to them.
3. **`poCount > 1` (0 today).** Render the count, not a number, saying no single number is the invoice's —
   this branch cannot fire on the current file and exists so that a future one is not silently shown as a
   single order (`MAX()` picks silently; the row must not).
4. **`poNumber === null` (16).** *"none — no order was raised against it"*, in `.invrow__none`'s italics, with
   the `title` carrying the family and the figure read from `po` — so an empty answer on a
   $693,915 reimbursement does not read like an empty answer on an $8.57 credit.
5. **`poInRegister === null` (0 today).** *"not yet compared with the order register"* — the state for a file
   with no `po` block. It is the only state that says nothing about the data and only about the extract, which
   is exactly why it must not be rendered as state 2: *"absent from the register"* is a claim about this
   school's procurement, and 48 rows making it on the strength of a missing JSON key is the bug Verification
   item 5 exists to catch. This is also why `poInRegister` is `boolean | null` rather than `boolean` —
   TypeScript's non-null-checked `strict` mode is the enforcement, not a runtime guard.

**Two classes carry the distinction, and they must exist or the value renders unstyled.**
`.invrow__po` (a link: `var(--link)`, no underline, underline on hover, 3px `var(--tertiary-color)` on
`:focus-visible`) and `.invrow__ponum` + `.invrow__why` (the number with its reason as a footnote — the tail
is small, muted and italic, and deliberately **not** `white-space: nowrap`, because these clauses run to ~35
characters in a cell about 250px wide and would overhang their own row). The grammar across the whole row is
worth stating because the row mixes the two kinds: **italic is a phrase, upright is a figure.**

The invoice row keeps the per-account links below it untouched (*measurement* §6): the new field answers a different
question and the account link is still the only route to the register for an invoice whose own line names no
order.

### 6. The register's arrival must name a miss

`?order=` already exists (`orderHref`). **★ This section's premise as first drafted was FALSE, and the
correction is more useful than the original.** It said that a reader following an order the register does not
hold gets *an empty table with no explanation*. They do not: `PurchaseOrders.tsx` already prints, for
`orderParam && !selected` —

> **Not in the extract** — Order `X` has no lines in this extract, so there is nothing to show for it. One
> order in the database (`276551`) is in that position — it carries no distributions either, which is why the
> extract never saw it.

So the miss exists and this work does not need to build one. It needs to be **sharpened**, because both of its
load-bearing claims are wrong for the arrivals this feature creates:

- **"One order in the database (`276551`) is in that position"** reads as *the only one*. The 39
  register-absent order numbers this feature can now send a reader to are 39 more, so the sentence must not
  present a single exemplar as the population.
- **"it carries no distributions either, which is why the extract never saw it"** is the reason for `276551`
  and is **not** the reason for the 39. Those are absent because the register is one school's — fund `04` /
  program `862` / cost centre **`0840`** — while 35 of the 39 sit on another cost centre (`0434`, `0830`,
  `0333`, `0810`, `0940`, `0825`, plus three other funds; *measurement* §5). A stated reason that is right for
  the example and wrong for the case the reader is actually in is worse than no reason.

Design §5's state 2 removes most of these arrivals before they happen, by printing the number rather than
linking it when the register lacks it; this covers the rest (a hand-typed URL, a stale bookmark, a link built
from an older extract than the register now served).

### 7. What is not touched

The scope, the fiscal window, the three buckets, `Table2`, `Table3`, the per-account orders link, and
`derivedPlan`. `app/src/nav/menu.ts`'s description of the invoices page should gain a clause about the order
column, since it is the sentence a reader meets before the page.

### 8. Decisions

| # | Question | Answer | What it costs |
|---|---|---|---|
| 1 | The join in the request returns nothing. Build the line route instead? | **Yes — `AP_INVOICE_LINES_ALL.PO_HEADER_ID`.** | The base table is used from a *pull script*, which is otherwise `WCSEXP_*`-only, because the `WCSEXP_` view for the line does not exist (*measurement* §7) |
| 2 | Ship the surrogate `PO_HEADER_ID` too? | **No — `PO_NUMBER` + `PO_COUNT` only.** | A future deep-link wants the id; it is cheap to add when something reads it, and arbitrary today whenever `PO_COUNT > 1` |
| 3 | How does the page know which orders the register holds? | **The pull stamps a `po` block on `invoices.json`, read from the sibling register.** | A cross-file number, so the block carries the register's line count and max date to make staleness visible (Design §3) |
| 4 | Link every order number, or only the reachable ones? | **Only the 62. The other 48 render as text with the reason.** | One more state to build and one list (39 numbers) to carry; the alternative lands empty on 38% of invoices with an answer |
| 5 | Keep the per-account orders link? | **Yes. Two different questions, neither subsuming the other (*measurement* §6).** | The page carries two order affordances and the copy must distinguish them |
| 6 | Move the new column onto the account row instead? | **No — measured, no invoice names two orders (110 × 1, 16 × 0, 0 × 2+).** | If that ever changes, `PO_COUNT` fails the pull and the column moves (Design §2) |
| 7 | Widen the register so the 48 land somewhere? | **No. Out of this plan.** The register's scope is a separate decision with its own cost. | 48 invoices keep a number that is not clickable — which is the truthful rendering, not a gap |
| 8 | Explain the 4 absent POs that look reachable? | **No — report them as unexplained.** | Four rows stay unexplained; publishing an untested cause is worse than the gap (*measurement* §5) |

---

## What this plan deliberately does **not** do

- **It does not widen the purchase-order register.** The 39 absent orders are absent because the register is
  one school's orders. Fixing that is a scope decision with a payload cost, and it belongs in its own
  document; this plan states the hit rate and renders the miss honestly instead.
- **It does not add the invoice *lines* to the extract.** `PO_NUMBER` is one value per invoice; the 8,134
  distribution lines and the line list stay out, exactly as the account work already decided.
- **It does not touch `invoices.json`'s scope, window or buckets.** The 16 with no order stay **in** the
  register. An invoice that names no order is not out of scope.
- **It does not add a `PO_HEADER_ID` column** (Decision 2) and **does not add a second extract file**.
- **It does not re-pull anything as part of writing this plan.** The pull must be re-run for the column to
  appear, and §Verification is written to run on a fresh pull.
- **It does not correct the 4 unexplained orders** or claim to know why they are absent.
- **It does not fix the stale `37 of 126` in `purchaseOrders.ts` as a side effect of an unrelated edit** — it
  is corrected **in the same change**, because a comment whose job is to set an expectation before a click
  should not be a separate ticket from the feature that re-measured it.

---

## Verification

1. **The baseline still holds, in both halves of the repo.** `cd server; npm run smoke` → **local 115/115 ·
   oracle 67/103**; `npm run typecheck` in **both** `server/` and `app/` → exit 0; `node
   scripts/verify-turso-sample.mjs` → **22/22**; `node scripts/turso-run.mjs --quiet` → **56/56**. This work
   touches none of those paths, so a change in any total means something was edited that should not have
   been. Run each with `Remove-Item Env:LOCAL_DB_PATH -ErrorAction SilentlyContinue` first.
2. **The pull runs, and its new assertion is the gate.** `Push-Location server; node
   scripts/pull-invoices-extract.mjs; Pop-Location` must report **Assertion 16** with `MAX(PO_COUNT) = 1` and
   **0** invoices above 1, and the coverage pair **110 / 16** with values **$4,921,015.73 / $729,316.93**
   summing to `scope.inScopeValue`. **Assertion 16 failing is a stop, not a warning** — a non-zero count means
   `PO_NUMBER` is a silent pick and the design changes. Assertion 17 prints the register cross-check
   (**62 / 48** invoices, **49 / 39** numbers) and must agree with the stamped block.
3. **A control that must FAIL, so the assertion's PASS means something.** Deliberately inject a second PO onto
   one invoice (a throwaway query naming a second `PO_HEADER_ID` for one invoice, or a probe that counts
   `MAX(PO_COUNT)` over a hand-built two-order set) and confirm **Assertion 16 reports the fault**. An
   assertion that has only ever been seen to pass is not evidence that it can fail.
4. **The cross-file block is re-checkable, not trusted — and it must be re-checked on BOTH relations.**
   Recompute `InRegister` / `NotInRegister` from the served `invoices.json` and `full-output.json` on disk and
   confirm they equal the stamped figures, and that the stamped `register.lines` / `register.orders` equal the
   register file at the same moment. A mismatch means one extract was re-pulled without the other, which is
   the failure the fingerprint exists to expose.
   **Then re-measure the ACCOUNT side from scratch**, because the two relations share this page and only one
   of them was stale (*measurement* §6): against the same two files, the account key is `SEGMENT1..7` joined
   in order versus the register's `FUND, PURPOSE, PROGRAM, OBJECT_, LEVEL_, COST_CENTER, FUTURE_USE`, and the
   result must be **46 of 71 combinations** and **57 of 126 invoices**, under **both** the verbatim and the
   zero-stripped spelling. Anything else means either the account prose in `Invoices.tsx` has gone stale or
   this re-measurement is wrong; **do not resolve a disagreement by preferring the newer number**, which is how
   the `57 of 71` in an earlier draft of this plan came about (`measurement` §6).
5. **The reader tolerates a stale extract.** With a hand-edited `invoices.json` that has no `PO_NUMBER`
   column, the page must load and say **nothing** about purchase orders — not `0`, not `none`. Assert on the
   fixture, because the bug this guards against renders *"0 of 126 name an order"* on a file that simply
   predates the column.
6. **The second route agrees**, as a cross-check rather than a requirement:
   `AP_INVOICE_DISTRIBUTIONS_ALL.PO_DISTRIBUTION_ID → PO_DISTRIBUTIONS_ALL.PO_HEADER_ID` must resolve the
   same **110** invoices and no invoice twice. If the two routes ever disagree, the line route is the one to
   believe and the disagreement is the finding.
7. **Browser, measured not eyeballed** — one pass, on the whole round trip, per the rule that *a
   server-tested feature and a UI-tested feature are not a tested feature*:
   - the invoice row's purchase-order value is present on **110** rows and the *"names no purchase order"*
     state on **16** — count the rendered rows, do not spot-check two;
   - exactly **62** order numbers render as links and **48** as plain text with a stated reason — assert the
     counts, because a conditional that never fires looks exactly like a conditional that works;
   - open `?order=283929` (an invoice-borne order the register does **not** hold) and confirm the destination
     **names the miss**, not an empty table; then open a present one (`218566`) and confirm it loads;
   - follow one of the **account** links and confirm it still lands the way it did before — the new column
     must not have perturbed the existing relation;
   - the 16's empty state names the family (prepaid card / travel reimbursement / use tax) and the figure, so
     *"no order"* on a $693,915 reimbursement does not read like *"no order"* on an $8.57 credit;
   - measure the row in **both themes** — the plain-text state (Design §5 state 2) uses a different colour from the
     link state and must clear AA in each, checked against the ancestor's real background rather than a
     transparent one.
8. **Cross-reference hygiene, on both relations.** After the edit, `grep -n "37 of the 126\|89 the account"
   app/src` returns **nothing** — the stale figure is gone — and the message on that check says what it means if
   it starts passing again: *a doc comment is citing a measurement that this change re-took.*
   **And the converse guard, which an earlier draft of this plan got wrong:** `grep -n "46 of the 71\|57 of the
   126\|4,273,387.04\|1,539,881" app/src` must still return its hits — four account-side figures that were
   *correct* and were nearly "corrected" into error for not matching the line-side ones. A check that only
   hunts for stale numbers will happily preside over the removal of good ones.
