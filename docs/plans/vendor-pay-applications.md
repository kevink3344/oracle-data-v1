# Pay applications — a "Summary" block per vendor contract

## What was asked

> I've uploaded a summary image for the Vendor: Balfour Beatty Contruction Co. Please describe what you
> see in the image and provide a plan that I can show on the Vendor page like this for each vendor. Ask
> any clarifying questions as needed.

…and, on the five questions that raised:

| Question | Answer |
|---|---|
| Is this document the source of the `$2,254,217.75` recorded as absent from Oracle? | **Yes — this is that document** |
| Which screen carries the block? | **Vendor panel on `/vendors/companies`** |
| One block per contract, or per vendor? | **Per contract, listed under the vendor** |
| Where do the figures come from? | **New app-owned tables, fed by manual entry or an upload** |
| First version covers which vendors? | **Balfour Beatty only, as a pilot** |

**This is a plan, not an implementation.** Nothing has been built. No app file and no `.sql` file has been
touched. One throwaway probe (`tmp-balfour-check.mjs`) was written and has been deleted; the numbers below
come from the frozen extracts, from `data/reports/report-findings.md`, and from reading the code, and each
one names its source so it can be re-run rather than believed.

---

## The answer in one line

**The nine lines cannot be computed from anything this app can read — so the block has to be *stored*, and
the only figure the app can independently check is line 7, where it checks out to the cent.**
`576,844.86` is on the document as *Less Previous Certificate For Payment* and is also, separately, the
ledger's FY expenditure on Balfour's CMAR account `04.6570.862.527.0450.0840.000`. Lines 1, 2, 4 and 5 —
contract sum, change orders, completed-and-stored, retainage — exist in no table the app can reach, so they
must be entered or imported. And there is a placement problem that has to be settled before any of this is
built: **Balfour Beatty is not on `/vendors/companies`**, the page chosen for the pilot, and cannot be until
something changes. See §3.

---

## 1. What the image is

The summary page of a **pay application** — an AIA G702-style *Application and Certificate for Payment* —
for one vendor, Balfour Beatty Construction Co., covering one contract.

| # | Line | Amount |
|---|---|---|
| 1 | Original Contract Sum | $197,659.00 |
| 2 | Net Change By Change Orders | $307,226.00 |
| 3 | Contract Sum To Date (Line 1 +/− 2) | $504,885.00 |
| 4 | Total Completed & Stored To Date (Column G of Continuation Sheet) | $2,937,572.76 |
| 5 | Retainage (Column I of Continuation Sheet) | $106,510.15 |
| 6 | Total Earned Less Retainage (Line 4 less Line 5) | $2,831,062.61 |
| 7 | Less Previous Certificate For Payment | $576,844.86 |
| 8 | **Current Payment Due** — highlighted | **$2,254,217.75** |
| 9 | Balance To Finish Including Retainage (Line 3 less Line 6) | $(2,326,177.61) |

Three things about the image itself, before anything is designed around it:

1. **Every derived line reconciles exactly.** $197,659.00 + $307,226.00 = $504,885.00 · $2,937,572.76 −
   $106,510.15 = $2,831,062.61 · $2,831,062.61 − $576,844.86 = $2,254,217.75 · $504,885.00 −
   $2,831,062.61 = −$2,326,177.61. So this is not a document with an arithmetic error in it, and treating
   a future discrepancy as "probably a typo in the source" would be the wrong default.
2. **Two lines reference a continuation sheet that is not in the image.** Line 4 is *Column G* of it and
   line 5 is *Column I*. The continuation sheet is the detail schedule the two biggest figures are summed
   from, so the image is a summary of a document the app has never seen.
3. **Line 9 is negative, and that is the document's own alarm.** Balance to finish of minus $2,326,177.61
   is not a meaningful "balance". It follows from line 3 ($504,885.00) being far *below* line 6
   ($2,831,062.61): completed-and-stored is **5.8×** the contract sum to date. Every line adds up, so this
   is not an error in the block — it means the contract-sum lines (1–3) and the continuation-derived lines
   (4–6) describe different scopes, or different contracts. **Any screen that prints line 8 without this
   context is printing a number that the same document contradicts.**

---

## 2. The document reconciles to this repo in two places, and disagrees in a third

**Line 7 matches the ledger exactly.** `data/reports/report-findings.md:77` carries the report's own
performance grid:

| Budget Description | Budget Account | WCPSS Budget | Allocations/ Reimb. | Encumbrances | Expenditures | Available Funds |
|---|---|---|---|---|---|---|
| CMAR Contracts- Balfour Beatty | `04.6570.862.527.0450.0840.000` | 89,828,010.00 | 87,448,714.00 | 2,570,739.39 | **576,844.86** | 84,301,129.75 |

`report-findings.md:159` independently confirms the report-to-extract link on vendor and object:
**BALFOUR BEATTY CONSTRUCTION, PO 273173 · $2,739,102.25**. So `576,844.86` is a figure this repo already
holds, from a source it already trusts, and the pay application's line 7 is the same number to the cent.
*That is the whole payoff of the feature* — "the register holds the previous certificate; this is the next
one" becomes something the page can show rather than something a reader has to know.

**Line 8 is the amount that was recorded as absent.** `$2,254,217.75` is the figure an earlier live-Oracle
investigation could not find as any invoice, distribution, check or purchase order for any vendor. The user
has confirmed this document is the explanation: it is a **requested** payment on a pay application, not a
posted AP transaction. That investigation can now be closed rather than re-run.

**Line 3 disagrees with the commitment, and the disagreement is large.** The image's *Contract Sum To Date*
is `$504,885.00`. The ledger's commitment for the same vendor, object and level (PO 273173, object `527`,
level `0450`) is `$2,739,102.25` — **5.4× larger**. Line 4's `$2,937,572.76` is nearer the commitment but
still different by `$198,470.51` (7.2%). These are not equal, and nothing in the repo explains the gap. It
is worth naming now because the natural first instinct on seeing the block — "check the contract sum against
the PO" — does not currently yield a match, and a screen that silently showed one or the other as "the
contract" would be inventing a reconciliation that does not exist.

For completeness, Balfour holds **two** contracts in this data, not one:

| PO | Level | Object | Lines | Committed |
|---|---|---|---|---|
| 273173 | `0450` | `527` | $96,403.00 + $2,642,699.25 | **$2,739,102.25** |
| 274015 | `0452` | `527` | $418,805.00 + $345,218.00 + $7,940,350.00 | **$8,704,373.00** |

---

## 3. The placement problem, which is the first thing to settle

**Measured, live. `BALFOUR BEATTY CONSTRUCTION` is not on `/vendors/companies` — because of one day.**

This was diagnosed against the running API, not the frozen extract. The cause is the **fiscal window**, and
it is a narrower problem than "the register does not know this vendor".

- The page's default window is **FY2027: `2026-07-01` → `2027-06-30`**, the newest year `GL_PERIODS`
  carries. It is derived, never a literal and never caller-supplied by default.
- Balfour's most recent in-scope invoice is **`PAYAPP4`, dated `2026-06-30`** — **one day before the window
  opens**. Its `VENDOR_ID` is **75064**, on **PO 273173**, with `PAYMENT_STATUS_FLAG = 'Y'`.
- `server/src/routes/ap.ts` rejects it at the **first** predicate of the invoices query —
  `WHERE i.INVOICE_DATE >= TO_DATE(:since,'YYYY-MM-DD') AND i.INVOICE_DATE <= TO_DATE(:until,'YYYY-MM-DD')` —
  before the account scope is ever evaluated. The register holds **126 invoices and not one dated before
  2026-07-01**; its earliest row is exactly 2026-07-01.
- **It is not the scope filter.** The route's own scope block reports `windowInvoices: 126`,
  `inScope: 126`, **`excluded: 0`**, `excludedValue: 0`. The Fund 04 / 861-862-863 predicate excludes
  nothing at all.

**Confirmed by widening the window**, which the route already accepts (`?fyStart=` / `?fyEnd=`):

| Request | Window | Invoices | Vendors | BALFOUR rows |
|---|---|---|---|---|
| default | 2026-07-01 → 2027-06-30 | 126 | 55 | **0** |
| `?fyStart=2026&fyEnd=2027` | 2025-07-01 → 2027-06-30 | 4,106 | 359 | **12** |
| `?fyStart=2020&fyEnd=2027` | 2019-07-01 → 2027-06-30 | 30,799 | 987 | **125** |

So Balfour is not unknown to the ledger — it has **125 pay-application invoices** going back to 2020-05-31,
$1.5M–$4.5M each. It is one day outside the one year the page opens on.

**Why the user cannot widen it themselves on that page.** `/invoices` and `/checks` both carry fiscal-year
pickers (`loadFiscalYears` feeding `FY{year}` options). **`/vendors/companies` has no fiscal control at
all** — and `loadVendors` (`app/src/data/vendors.ts`) delegates to `loadInvoices(signal)` with **no window
argument**, so the page always receives the newest-year default. The gap is in the page, not the route: the
route already supports the range.

**And the asymmetry worth naming.** Balfour's check `44407353` is dated **2026-07-28** — inside FY2027 — so
it *does* appear on `/api/ap/checks`, while the invoice it settled (2026-06-30) is outside and appears
nowhere. A check in the window whose invoice is not.

**Two instruments that must not be used to look for it.** `VENDOR_ID` 75064 is on **0** of the register's
126 rows, so an id match is decisive — but a **name** is not (5 vendors match BALFOUR) and an **invoice
number** is not either: `PAYAPP4` is drawn twice *inside* the window by other vendors — SUPERIOR MECHANICAL
(vid 3667648, $630,201.16) and NATIONWIDE ELECTRICAL (vid 1446331, $60,562.50).

`groupVendors` (`app/src/data/vendors.ts:326`) builds its map from `extract.invoices` only — "A row with no
vendor cannot be placed on a page of vendors" — so with no in-window invoice, no row is created. Balfour
*is* visible on the **commitments** side (`data/oracle/full-output.json` PO grain, `PO_VENDORS`), which is
why the page could print a master record for it while never listing it.

### Three ways out

1. **Give the vendors page the window control the other two registers already have (recommended first
   step — it is a diagnostic as much as a fix).** The route is done; this is a picker on the page. At
   `FY2026–2027` Balfour simply appears with 12 invoices and the pilot renders where it was proposed.
   **Cost:** the page's printed measurements — "55 vendors … 126 invoices" — become conditional, and that
   string is load-bearing (`app/src/nav/menu.ts:513` repeats it). So the figure must be reworded to name
   its window rather than left to be read as absolute. Worth doing anyway: a register that cannot show a
   vendor who was paid *one day* outside the year it opens on is a trap for the next reader.

   > **BUILT.** The picker and the window disclosure are on
   > `/vendors/companies` (`app/src/routes/VendorCompanies.tsx`), modelled on `/invoices` and `/checks`.
   > Verified against the live API, not by eye:
   >
   > | window | invoices | vendor rows | Balfour |
   > |---|---|---|---|
   > | server default, FY2027 (`2026-07-01 → 2027-06-30`) | 126 | **55** | absent |
   > | `fyStart=2026&fyEnd=2027` | 4,106 | 359 | **present**, 12 invoices |
   > | `fyStart=2022&fyEnd=2027` (Start FY) | 21,037 | **762** | **present**, 70 invoices, $96,566,412.20 |
   >
   > **The question §3 said option 1 answers is answered, and the answer is neither of the two
   > possibilities offered.** `PAYAPP4` is not a lone near-boundary invoice, and there is no pattern of
   > Balfour invoices *just outside* FY2027 either — there is a **complete absence**: Balfour has **no**
   > invoice dated inside `2026-07-01 → 2027-06-30` at all. His newest invoice is dated **2026-06-30**, the
   > last day of FY2026. And he is emphatically a FY2027 payee: check **`44407353`**, **$229,185.86**,
   > dated **2026-07-28**, settles exactly that 2026-06-30 invoice, and he has **58 checks** in the Start-FY
   > window. **The bound this register applies is the invoice date, so the page was hiding a company that
   > was paid inside the year it opened on.** That is the real finding — option 1 fixes it by widening the
   > window, and the `Window` line is what keeps the widened window from becoming a new silent slice.
   >
   > ★ **Two figures corrected by measurement.** (a) The Start-FY row count is **762**, not 764: the fold is
   > `vendorKeyOf` = `toUpperCase().replace(/[^A-Z0-9]/g, '')` (`app/src/data/vendors.ts:308`), and two pairs
   > of names collide under it — `RATIO USA LLC  DBA RATIO USA PLLC` vs the single-space spelling (63 rows)
   > and `EMPIRE  MUSIC` vs `EMPIRE MUSIC` (10 rows). 764 distinct spellings − 2 collisions = 762 rows.
   > (b) The 125 invoices cited below are the count at a **wider** window than Start FY; at `FY2022–2027`
   > Balfour has **70**. The series and the date range in that paragraph should be read as measured at that
   > wider window.
   >
   > ★ **The default is the open product question.** The page opens at Start FY (`2021-07-01 → 2027-06-30`)
   > because the tenant's `start_fy` is 2022 and a latch would fetch the register twice — once at the server
   > default and again at Start FY — showing 55 vendors and then replacing them with 762. That payload is
   > **19.6 MB / ~2.1–3.3 s** against 112 KB / ~0.5 s for the default. Correct and honest, but expensive; if
   > the cost is judged too high the fix is a narrower default start, not a silent one.
2. **Keep the register frozen, add a reachability path.** The block mounts in the vendor panel keyed on
   `VENDOR_ID` as chosen; separately the page gains an entry point for vendors with a pay application but no
   in-window invoice — a second list, sourced from the new table, opening the same panel. The register's
   figures stay exactly true. Use this if the FY2027-only measurement is deliberate.
3. **Put the pilot on `/vendors/sites`.** Balfour has in-scope PO activity at levels 0450 and 0452, so it
   should be a row there. Cheapest visible pilot, but not the page asked for.

**Recommended order: 1, then 2 if the window turns out to be deliberate.** Option 1 is the only one that
answers the real question — whether `PAYAPP4` is Balfour's *only* near-boundary invoice or whether a
pattern of them sits just outside FY2027 — and it needs no new tables.

---

## 4. What the app already has, versus what the block needs

| Line | Needed | In the app today? |
|---|---|---|
| 1 Original contract sum | Contract value | ✗ — the commitment is there (PO lines), but §2 shows it is not this figure |
| 2 Net change by change orders | Change-order register | ✗ — `CHANGE ORDER` appears only inside PO line `DESCRIPTION`s |
| 3 Contract sum to date | derived (1+2) | ✗ |
| 4 Completed & stored to date | Continuation sheet, Column G | ✗ — no such table; no field on any view |
| 5 Retainage | Continuation sheet, Column I | ✗ — no retainage column anywhere |
| 6 Total earned less retainage | derived (4−5) | ✗ |
| 7 Less previous certificate | Certificates already issued | ✓ — as the account's expenditures (`576,844.86`), by way of the report |
| 8 Current payment due | derived (6−7) | ✗ |
| 9 Balance to finish | derived (3−6) | ✗ |

**Six of the nine are storage, one is a reconciliation, two are arithmetic.** No amount of work on the
existing extracts changes this: the AP surface is invoices, checks and links; the PO surface is orders,
lines and sites. Neither carries a contract sum, a change order, a retainage figure or a certificate.

**One refinement, found while diagnosing §3 — and it narrows the gap rather than closing it.** Balfour's AP
history *is* in the ledger: the widened window returns **125 invoices for `VENDOR_ID` 75064**, one per
certificate, `PAY APP 30`–`33`, `PAY APP 4`, `PAY APP 5A`–`29A`, `PAY APP# 1`–`57` and `PAY APP PRECON#01`–`04`,
running 2020-05-31 → 2026-06-30 at $1.5M–$4.5M each. So for each application the ledger holds an **amount
and a date** — a certificate series. What it still does not hold is the contract sum (line 1), the change
orders (line 2), the retainage (line 5) or the continuation-sheet columns (lines 4 and 5), so §4's verdict
stands unchanged. It also sharpens two figures: **line 8's `$2,254,217.75` matches none of those 125 rows**,
which is consistent with it being a requested rather than posted payment; and **line 7's `$576,844.86` is not
a single invoice either** — it is the account's expenditure total, as the table above shows. Neither line can
therefore be recovered by reading invoices, which is the point of storing the document.

---

## 5. Design

### Decision 1 — Where the block lives, and how Balfour is reached

Per §3: **option 1 first** — give `/vendors/companies` the fiscal-year control `/invoices` and `/checks`
already have, and reword the printed "55 vendors … 126 invoices" so it names its window instead of reading
as absolute. Then **option 2** if a FY2027-only register turns out to be deliberate: keep the register
frozen and add a reachability path for vendors with pay applications but no in-window invoice, mounting the
block in the vendor panel keyed on `VENDOR_ID`. **This must be settled before building**, because the two
options edit different components. Option 3 changes the page. Option 1 needs no new tables.

**Status: option 1 is BUILT and verified (§3). The choice between 1 and 2 is now made and the answer is in**
— the register is *not* deliberately FY2027-only, it was applying the invoice date as the bound and thereby
excluding a vendor paid inside the year. Option 2 is therefore **not needed for Balfour**, and its
generalisation (a pay-application with no in-window invoice) remains open only for the FY2027-vs-contract
grain question. Balfour's absence was never about identity, scope or `PARENT_VENDOR_ID`; it was a fiscal
boundary, and it is now reachable by widening the window on the page itself.

### Decision 2 — Grain: `(vendor, contract)`, never `(vendor)`

Confirmed as *per contract, listed under the vendor*. This is not a presentational preference, it is the
thing the page's own header already warns about — *"a vendor-level aggregate hides a row-level fact"* — and
Balfour is the worked example: one vendor, two contracts (`0450` and `0452`), and a `$2,254,217.75`
"current payment due" that belongs to exactly one of them. A rolled-up vendor block would sum two unrelated
contracts and would be wrong on every line.

The key should be the **`VENDOR_ID`** (Balfour is `75064`), not a name match. There are five vendors whose
name contains BALFOUR on this tenant, and the repo has already recorded the cost of matching on a name
instead of an id.

### Decision 3 — Storage: two app-owned tables

Following the pattern the vendor-site map plan established for `vendor_site_geo` — and repeating its
warning, because it applies identically here:

- `vendor_pay_application` — one row per application: `VENDOR_ID`, a contract key (`PO_NUMBER` and/or
  `LEVEL_` + `OBJECT_`, since Balfour's contracts are identified by PO), the period it covers, an
  application/certificate number, the date, the nine stored figures where they are stored rather than
  derived, and **provenance** (source document, as-of date, who entered it).
- `vendor_pay_application_line` — the continuation-sheet detail, absent from the image and therefore
  optional in v1, but the table the image's lines 4 and 5 are *actually* summed from. Without it the two
  largest figures on the page have no supporting detail and cannot be checked at all.

A row must be registered in **three** lists, as `vendor_site_geo` was (`01-app.sql`, `app-schema.ts`,
`store.ts`) — they are separate copies and a table added to one and not the others fails in a way that
looks like missing data. Under `DB_MODE=oracle` the store resolves to a **local libSQL file**, so unless
`APP_DB_URL` points at Turso the pay applications land in one machine's file. That decision is inherited
from the map plan and is worth making explicitly again.

### Decision 4 — The derived lines are computed and checked, not copied

Lines 3, 6, 8 and 9 are arithmetic on the other five. The server derives them and **compares against what
the document stated, flagging a mismatch rather than trusting it or silently correcting it**. The image
demonstrates why the check earns its place: it reconciles perfectly, so any future application that does not
is a fact about that document and not noise to be smoothed over.

### Decision 5 — Line 7 is reconciled against the ledger, and the account is named

Line 7 against the account's expenditures, with the account printed beside it
(`04.6570.862.527.0450.0840.000` for the 0450 contract). This is the feature's justification: it is the one
line where the page can say *"the source document says X and the ledger says X"* rather than *"the source
document says X"*. It must be presented as a **check that can fail**, not decoration.

### Decision 6 — What the block must not do

- **Do not reuse the word "due" or "unpaid".** The page already carries an `unpaid` label for something
  entirely different: an invoice no check reaches, `9` rows worth `$23,020.84`. Line 8 is called *Current
  Payment Due* on the source document, and it is **not** an unpaid invoice — it is a payment requested on a
  contract. Letting the two share a word would repeat the `.vc-unpaid` label bug exactly: a reader would
  have no way to tell which "due" they were looking at.
- **Do not print a blank line as `$0.00`.** An unentered retainage is *not recorded*, not zero. The whole
  page is built on this distinction already (`paid: number | null` — "Never coerced to 0").
- **Do not print line 8 without the line-9 context.** §1.3: the document contradicts itself, and the page
  must carry that contradiction rather than a single confident number.
- **Do not render an empty block.** Balfour is the pilot; a block that renders for vendors with no
  application is 54 empty boxes on a 55-row page.

---

## 6. The block, as it would look

A fifth `.dsec` section in the vendor panel, after *Total* and before *Master record*, headed with the
contract it belongs to (`PO 273173 · level 0450`) rather than with the vendor name — the section above it is
already about the vendor, and the distinguishing fact here is *which contract*.

The nine lines render as a labelled table in the document's own order and with the document's own wording,
so a reader holding the PDF can go line by line. Lines 3, 6, 8 and 9 are marked as derived. Line 7 carries
the reconciliation against the account, side by side. Line 9 is not a figure in a row, it is a flagged
anomaly with the contradiction named — *completed and stored exceeds the contract sum to date by 5.8×*.

For the pilot, the honest scope of the section is: **one contract, nine lines, one line verified, one
document self-contradiction surfaced.**

---

## 7. How this gets verified

1. **Before building:** confirm whether Balfour appears on `/vendors/companies` with the app running (§3).
   This decides Decision 1 and nothing else in the plan depends on it.
2. **The nine lines** — recompute 3, 6, 8 and 9 from the stored values and assert the source document's own
   figures; the image is the fixture and all four already reconcile.
3. **Line 7** — assert `576,844.86` against the account's expenditures, and assert the *negative* control: a
   contract whose certificate does not match its account must render as a mismatch, not as agreement.
4. **Grain** — assert that Balfour's two contracts (`0450`, `0452`) produce two blocks and that no figure
   is ever summed across them.
5. **Reachability** — the pilot only passes if a user can open Balfour's panel, which is the one thing the
   current page cannot do.

---

## 8. Open questions

1. **Is the 0450 contract's `$504,885.00` the same contract as PO 273173's `$2,739,102.25`?** The 5.4× gap
   is the largest unexplained thing in this document and it decides what "contract sum" means on the page.
2. **Do the continuation sheets exist as files?** Lines 4 and 5 are their Columns G and I. If those sheets
   are available, the block can be complete; if not, the two biggest figures are transcribed numbers with
   no supporting detail, and the page must say so.
3. **Should each period be recorded, or only the latest?** *Less Previous Certificate* and retainage are
   both series over time. Recording every period makes the block a history; keeping only the latest makes
   line 7 a value that cannot be re-derived.
4. **Does this extend to Object `527` across all vendors?** Balfour is one CMAR contract on one level, but
   object `527` is the construction-contract object generally (`report-findings.md:145` shows `527` holding
   $2,739,102.25 across 2 lines while `526` holds $1,243,914.00 for Moseley). If pay applications are a
   property of construction contracts, the second vendor is Moseley, not "whatever comes next".
