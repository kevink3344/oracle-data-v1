# Purchase orders on invoices — implementation

**Status:** implemented, verified in the browser against the live ledger, gates green.
**Plan of record:** `docs/plans/po-addition.md` (the plan; this file is what was built).
**Date:** 2026-09-19.

---

## 1. What was added

The invoice detail panel now shows the **purchase order an invoice names**, as a link that
opens that order in the app's own purchase-order register — or a sentence saying why there
is no link.

Three things had to be true for that to be honest, and each one is a separate piece of work:

1. **The relation had to be found.** It is not where the panel was reading. `PO_HEADER_ID`
   is null on every invoice *header*; the order is named on the invoice's **lines**.
2. **The register had to be the register the links open.** The old shipped list of "not in
   the register" was measured against a frozen file on disk while the link beside it opened
   the live ledger. Fixing that is the larger half of this change.
3. **The comparison had to be computed where the register is known**, not copied out of a
   file that cannot move. That is the design decision (§5.2).

---

## 2. The route (where the data actually is)

```
AP_INVOICE_LINES_ALL.PO_HEADER_ID  →  PO_HEADERS_ALL.PO_HEADER_ID
                                       PO_HEADERS_ALL.SEGMENT1 = the order number
```

`SEGMENT1` is the number a person recognises (`283409`, not a `PO_HEADER_ID`), and it is what
the register page matches on.

★ **The header is the wrong table, and it looks like the right one.** The invoice panel
already read `PO_HEADER_ID` off the header — where it is null on all 126 rows in scope — and
that absence was read as *nothing carries this*, when it meant *this row does not carry it*.
The two are not the same claim, and the difference is one table.

★ **Both directions of this relation are real and neither is wrong.** The panel also links
**account rows** to orders, on the invoice's seven account segments. That answers a different
question — *which orders are charged to this combination* — and it is legitimately narrower:

| question | answer |
| --- | --- |
| does the invoice **name** an order? (line side) | **110 of 126**, and the served register holds every one |
| is the invoice's **account combination** charged to a register line? (account side) | **57 of 126** (46 of 71 combinations) |

An invoice can name an order whose lines are booked to another account, so the second figure
is correctly the smaller one. **Do not "fix" one to match the other.** The panel carries this
warning in a comment so the next reader does not try.

---

## 3. The endpoint

`GET /api/extract/order-numbers` — `server/src/routes/extract.ts`, route at ~line 691,
schema `OrderNumbersSchema` (219), helper `distinctOrderNumbers` (904).

```jsonc
{ "data": { "source": { … }, "count": 5692, "numbers": ["218566", …] } }
```

* `numbers` — every distinct non-empty `ORDER_NUMBER` in the extract, sorted as strings.
* `count` — its length, sent because a count is what a reader checks first.
* `source` — **the identical provenance block `/api/extract/current` returns**, field for
  field (`kind`, `label`, `generatedAt`, `cached`, `rows`, `orders`, `lines`, `observed.*`).

★ **It is a projection of the same read, not a second one.** `buildExtract(forced)` is the one
place the document is built, cached and fallen back from, and both routes call it. Two
independent reads could not promise the same ledger over the same scope: a scope changed in
Settings between the two would leave the invoice page comparing against a register the order
page does not show. Sharing the provenance *schema object* rather than a field that happens to
hold similar words is what makes that structural rather than aspirational.

★ **Why not a field on `/current`.** `/current` is ~11 MB of rows (31,670 rows). The client
needs one column. The list is ~60 KB, so the invoice page does not have to download a document
it will not read.

★ **Why the envelope is worth a named type.** Everything in this API is wrapped in `{ data }`
except `/api/extract/current`, which opts out to reproduce the frozen export's
`body.ResultSets` byte for byte. A reader that looks at the top level of *this* route sees a
body with no `numbers` and no `source`, answers `null`, and the page reports **every** order as
"not yet compared" while holding HTTP 200. That is a total, silent loss of the feature behind a
green status — see §5.1.

---

## 4. The client

`app/src/data/invoices.ts`

| symbol | line | role |
| --- | --- | --- |
| `REGISTER_URL` | 644 | `/api/extract/order-numbers` |
| `RawOrderNumbers` | 681 | the payload, every field optional (it is a network type) |
| `OrderNumbersEnvelope` | 702 | the framework envelope, **named** so `.data` is not a bare cast |
| `OrderRegisterLookup` | 707 | `{ numbers: ReadonlySet<string>, register: PoRegister }` |
| `readRegister` | — | the register's self-description out of `source`; `null` if `source` is absent |
| `loadOrderRegister` | 768 | fetches it; returns `null` on any failure, rethrows an abort |
| `loadInvoices` | 791 | `Promise.all([extract, register])` — both start together |
| `poInRegister` | 949 | `lookup !== null && poNumber !== null ? lookup.numbers.has(poNumber) : null` |
| coverage block | ~1010–1075 | every panel aggregate, counted from the rows |

★ **`poInRegister` is three-valued, and that is the whole safety property.**

```
true   the register holds it      → render a link
false  the register does not      → render the number, no link, and say so
null   nothing was compared       → render the number, no link, and claim nothing
```

`null` is not a nicety. A register fetch that fails degrades **every** row to `null`, so
the page prints each order with no link and no claim — instead of reporting every order as
missing, which is the same lie in the opposite direction. `false` may only be said by code
that has actually held the register.

★ **Blanks are dropped** when the set is built, so `has('')` can never be true. That makes the
set's size a floor on the endpoint's `count`, which counts distinct `ORDER_NUMBER` values
including a blank if the ledger has one.

★ **An abort is rethrown, not swallowed.** Returning `null` on abort would let the loader
resolve a half-built extract after unmount.

---

## 5. The two defects this closed

### 5.1 The envelope (found by a control, not by review)

The register fetch read the payload at the top level. The route is enveloped, so
`numbers` was `undefined`, `readRegister` returned `null`, and `loadOrderRegister` answered
`null` — **every** row degraded to "not yet compared", with HTTP 200 and no error anywhere.

It was caught because the probe for the route carried a **positive control**: `"218566"` must
be *found* in the returned list. A probe asserting only "the endpoint answered" would have
passed while the feature was 100% dead. The envelope is now a named type with the reason
written next to it.

### 5.2 The wrong register (why the fix is Option B — compute at render time)

The extract carried `absentFromRegister`: the numbers its **own frozen register** did not hold.

* the frozen file (`data/oracle/full-output.json`): **2,782 lines, 742 orders, program 862**
* the live ledger the links open: **31,670 rows, 31,401 lines, 5,692 orders, fund 04, programs 861/862**

Measured against the register the app actually serves:

| | shipped claim | measured |
| --- | --- | --- |
| invoices shown as naming an order | 62 | **110** |
| invoices shown as **not** in the register | 48 | **0** |
| the 39 numbers that list called absent | — | **39 present, 0 genuinely absent** |

★ **Not one number was mis-summed, and the page still lied.** The list was a true statement
about a document the reader could not open. That is why the fix is not "correct the list": any
list baked into a file is measured against whatever register existed when the file was written,
and the register moves.

**Option B — compute at render time.** The page fetches the register's numbers and decides each
invoice against them. Properties this buys:

* the comparison is against the register the row's own link opens, **by construction**;
* the panel's aggregates are counted from the invoices it is displaying, so they cannot
  disagree with the rows beside them;
* the extract's `po` block may be stale, wrong or absent without affecting the rendered claim.

`loadInvoices` filters **then** counts: `kept.filter(...)`, from the same rows it renders. A
count taken from a differently-filtered list is the classic way for the sentence and the table
to disagree.

---

## 6. The UI states

`app/src/routes/Invoices.tsx`, the `PurchaseOrder` block (~1584) and its render (~1899).

| state | condition | markup |
| --- | --- | --- |
| several numbers, no single one | `poCount > 1` | `invrow__ponum` + `invrow__why` — *"— no single number is this invoice's"* |
| no order named | `poNumber === null` | `invrow__none` — *"No purchase order is named on any line of this invoice — N of the M invoices in scope are in the same position, and they are not small change."* |
| named and in the register | `poInRegister === true` | `invrow__po` → `<Link>` to the order |
| named, not in the register | `poInRegister === false` | `invrow__ponum` + `invrow__why` — *"— not in this app's order register"* |
| named, never compared | `poInRegister === null` | `invrow__ponum` + `invrow__why` — *"— not yet compared with the order register"* |

★ **Only the panel it is in can reach any of this.** The invoice **list** table has six columns
(`Invoice, Date, Amount, Checks, Vendor, Account`) and **no PO column** — a decision made
earlier and not revisited here. PO state lives in `#invoice-detail` / `aside.drawer.invpanel`,
which is deep-linkable (`?invoice=`, `?vendor=`, `?date=`, `?amount=`).

★ **The "names none" case is an answer, not a gap.** Prepaid cards, travel reimbursements, use
tax and standing charges spend money without raising an order; the panel says so in words and
gives the total they carry, because a bare "16 invoices have no order" reads like missing data.

**Contrast** (measured in both themes, against the row's inherited backdrop):

| class | light | dark |
| --- | --- | --- |
| `invrow__po` (link) | `#165788` — 7.63:1 | `#6cb6e8` — 7.53:1 |
| `invrow__why` (aside) | `rgb(114,114,114)` — 4.81:1 | `rgb(147,164,192)` — 6.59:1 |

---

## 7. Verification

### 7.1 Server probe (against the live ledger, exit 0)

```
top-level keys                     data
count                              5692   numbers 5692
source.rows / lines / orders       31670 / 31401 / 5692
of the 39 the old list called absent   present: 39   genuinely absent: 0
control: "218566"                     found
control: "999999999"                  not found
control: /api/extract/no-such-route   404
panel aggregates                      110 in $4,921,015.73  /  0 not $0.00
```

Three controls, two of which are **negative** (a plausible but absent number must not be
found; an unknown route must 404). Without them, "110 in" cannot be distinguished from a
comparison that always says yes.

### 7.2 Browser pass (whole round trip, live data)

Every sample invoice in scope was opened and read:

| invoice | names | link lands |
| --- | --- | --- |
| `PCARD-4772598-05-AUG-26` | `284960` | yes — `/procurement/purchase-orders?order=284960` → 33 rows by account, "Committed $3,000.00" |
| `PCARD-4772556-05-AUG-26` | `284622` | yes |
| `PCARD-4772543-05-AUG-26` | `284691` | yes |
| `PCARD-4772542-05-AUG-26` | `284335` | yes |
| `USE TAX/05AUG2618:11/F04/7.25` | none | correct — "names no order" |
| `NC1YT0` | none | correct |
| `REIMB PRC JULY26` | none | correct |

Panel note as rendered (client-computed, so these are the ledger's figures on that day):
*"110 of them name an order — $4,921,015.73 of the $5,650,332.66 in scope — and 16 name none …
5,692 orders over 31,401 lines — and it holds every one of those 110 invoices, and all 88 of
their order numbers."*

**Zero** occurrences of either failure string (`— not in this app's order register`,
`— not yet compared with the order register`). Screenshot:
`docs/screenshots/invoices-po-link.png` (130,743 bytes).

★ **A value the source itself names is the strongest link evidence.** One invoice's description
read `PO#283409` and its account link landed on order **283409** — far better evidence than
"the destination rendered some rows".

### 7.3 Degradation

With the register fetch forced to fail, every row renders `invrow__ponum` with *"— not yet
compared with the order register"*, no links, and the invoices still load. Verified in the
browser, not only in the type system.

---

## 8. What is not covered

* **No automated gate exercises this feature.** The consumer gates
  (`scripts/verify-turso-sample.mjs` 22/22, `scripts/turso-run.mjs` 56/56) cover the SQLite
  sample database, not this path. The evidence above is a probe and a browser pass.
* **The panel's figures move.** Every count and total is computed from the live ledger at
  render time; a screenshot is a point in time. That is the intended trade — the alternative
  is a number nothing can keep true.
* **The account-side relation is narrower by nature** (§2). 57 of 126, not 110 of 126.
* **`data/oracle/full-output.json` and `scripts/pull-invoices-extract.mjs` still carry the old
  list.** Deliberately not edited: the file is a frozen snapshot of record, and its
  `absentFromRegister` is a true statement about *it*. The page simply no longer believes it.

---

## 9. How to re-verify

```powershell
# the register endpoint, and the two controls, from a server-side probe
Push-Location server; npm run typecheck; npm run dev        # port 5181

# the page
Push-Location app; npm run dev                              # port 5180, proxies /api → 5181
#   open an invoice in scope and read the PO row; then follow the link
```

* Register payload: `GET http://127.0.0.1:5181/api/extract/order-numbers` — expect
  `data.count === data.numbers.length` and a non-zero `data.source.rows`.
* `GET /api/extract/current` remains **un**enveloped (it reproduces the frozen export);
  anything else that starts returning the other shape is a regression, not a fix.
* The three-valued field: search for `poInRegister === false` and confirm the only place that
  value is *produced* is the line that has just held the register's numbers.

---

## 10. Files touched

| file | change |
| --- | --- |
| `server/src/routes/extract.ts` | `OrderNumbersSchema`, `distinctOrderNumbers`, the route; `buildExtract` shared by both routes |
| `app/src/data/invoices.ts` | `REGISTER_URL`, `RawOrderNumbers`, `OrderNumbersEnvelope`, `OrderRegisterLookup`, `readRegister`, `loadOrderRegister`; `poInRegister` three-valued; coverage block counted from rows |
| `app/src/routes/Invoices.tsx` | the `PurchaseOrder` body and the panel note |
| `app/src/styles/invoices.css` | `invrow__po`, `invrow__ponum`, `invrow__why`, `invrow__none` — reconciled against the markup that emits them |
| `docs/plans/po-addition.md` | the plan, corrected |
| `docs/screenshots/invoices-po-link.png` | the browser-pass capture |
