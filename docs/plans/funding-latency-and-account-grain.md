# Funding latency and the account-grain defect

| | |
|---|---|
| **Status** | Finding 1 **shipped and verified**. Finding 2 **fixed and verified in the browser**. Finding 4 **retired — measured 200, see §5**. Findings 3 and 5 **open** |
| **Purpose** | Record what was measured on the live Oracle ledger, what was changed as a result, and what is still wrong |
| **Scope** | `/api/funding/*` read path, `server/src/db/derived.ts`, the project detail drawer |
| **Grounded in** | Live requests to the running API against `POWERAPPS@europa.wcpss.net:1541/ebs_FA2DB`. ★ The one-off probe scripts this originally cited (`tmp-push.txt`, `tmp-levels.ts`, `$env:TEMP\live.txt`) have been deleted, so **the numbers here stand on the requests that produced them, not on a file you can re-read** — re-take any figure you intend to rely on (§5.2 is what happens when that is skipped) |
| **Requested by** | *"Whatever you can do to speed up the queries I am open to; I can't have the users wait a long time to retrieve their records. A few seconds is ok though."* |

**Every figure below is a measurement, not an estimate.** Where a number has not
been measured in the current state, it says so rather than quoting the last one.

---

## 1. The findings, ranked

| # | Finding | Severity | State |
|---|---|---|---|
| **1** | Every segment-filtered read of a derived view cost a **full scoped aggregate** — a consumer-side `WHERE LEVEL_CODE = …` runs *after* the `GROUP BY`. One level took **10.8 s**. | Performance | **Fixed.** 10,755 ms → **58 ms** in the probe; the live drawer path 10.414 s → **0.401 s** |
| **2** | The detail drawer joined `V_ACCOUNT_POSITION` on `(LEVEL_CODE, OBJECT_CODE)` with `.find()`. **That is not a key.** Level `0450` has five rows for four accounts, so one was dropped. | **Correctness** | **Fixed.** The panel read **$18,710,282**; the ledger holds **$19,588,101.84** |
| **3** | Two **unfiltered** list paths are still over budget: `positions?limit=200` **15.37 s**, `budgets?limit=200` **6.42 s**. | Performance | **Open.** No pushdown applies — there is no segment to narrow on |
| **4** | `GET /api/coa/levels` was recorded as answering **500** in 0.33 s. | Availability | **Closed by measurement — it answers 200.** It was never broken; see §5 |
| **5** | Three funding endpoints answer **200 with every field null** and one row. | Correctness (silent) | **Open** — see §6 |

---

## 2. Finding 1 — an aggregate published for display cannot be filtered for retrieval

### 2.1 The cause

`V_ACCOUNT_POSITION` and `V_BUDGET_BY_ACCOUNT_PERIOD` are composed in
`server/src/db/derived.ts` as fragments. Each publishes its seven segments as
`MAX(cc.SEGMENTn)` over a `GROUP BY cc.CODE_COMBINATION_ID`, wrapped in an outer
`p.*` layer:

```sql
SELECT p.*, …
  FROM (SELECT cc.CODE_COMBINATION_ID, MAX(cc.SEGMENT5) AS SEGMENT5, …
          FROM GL_BALANCES gb JOIN GL_CODE_COMBINATIONS cc …
         WHERE … ${periodFloor(scope)}
         GROUP BY cc.CODE_COMBINATION_ID
        HAVING SUM(CASE WHEN gb.ACTUAL_FLAG = 'B' …) > 0) p
```

The list engine then appends `WHERE "LEVEL_CODE" = :f_level` **outside** that
wrapper. So the predicate is applied to an *aggregate result*: Oracle still has
to scan every scoped `GL_BALANCES` row, group it, apply the `HAVING`, and only
then discard all but one level. Measured, that is barely better than asking for
everything.

```
A  fragment, no filter              (baseline)            12967 ms
B  fragment then WHERE LEVEL_CODE   (what the route did)  10755 ms   ← 83% of the baseline
C  fragment with the predicate pushed down                  58 ms
```

### 2.2 The fix

Restate the same predicate as `cc.SEGMENT5 = '<level>'` **inside** the inner
`SELECT`, below the `GROUP BY`. The filter is optional by construction — a
fragment used for a **total** has no segment to filter on — so it defaults to
"not supplied" and emits no predicate.

The pushdown is **equivalent, not approximate**, and the probe proves it rather
than asserting it: `CODE_COMBINATION_ID` determines all seven segments, so within
a combination `MAX(cc.SEGMENT5) = '0450'` ⟺ `cc.SEGMENT5 = '0450'`. The `HAVING`
and the aggregates are untouched, and the list engine still emits its own outer
`LEVEL_CODE = :f_level`, so the two agree.

```
=== 3. EQUIVALENCE — the two shapes must return the SAME accounts ===
  outer rows 5, pushed rows 5 — identical: true
    04.6560.862.529.0450.0840.000|12931|-3280|10036|-6756
    04.6570.862.526.0450.0840.000|9335190.5|-4976571.1|4591508.9|385062.2
    04.6570.862.527.0450.0840.000|9074692.41|-637667.86|806030.72|-168362.86
    04.6570.862.529.0450.0840.000|877819.93|-51573.58|214749.07|-163175.49
    04.6570.862.532.0450.0840.000|287468|-4500|25000|-20500

=== 5. CONTROLS — these MUST fail ===
  control: syntax          63 ms   ORA-00936: missing expression
  control: unknown object  53 ms   ORA-00942: table or view does not exist
```

The two **controls were mandatory**. A PASS with no failing control cannot be
distinguished from a harness that swallows errors, runs nothing, or matches on
nothing.

### 2.3 The budget grain responds too

```
A  budget, no filter              (baseline)            2763 ms
C  budget, level pushed down                              49 ms
C2 budget, object+level pushed down                       45 ms
```

### 2.4 Endpoint sweep, before and after

| endpoint | before | after |
|---|---|---|
| **`/api/funding/positions?level=0450&limit=200`** ← the user's screen | **10.413685 s** | **0.400557 s** |
| `/api/funding/summary` | 16.871242 s | 4.524410 s |
| `/api/funding/positions?limit=200` | 6.390724 s | 15.365928 s *(unfiltered, cold)* |
| `/api/funding/budgets?limit=200` | 5.553423 s | 6.416548 s *(unfiltered)* |
| `/api/funding/budget-versions?limit=200` | 0.495394 s | 0.439914 s *(all-null — §6)* |
| `/api/funding/budget-types?limit=200` | 0.434615 s | 0.400000 s *(all-null — §6)* |
| `/api/funding/budget-assignments?limit=200` | 0.570331 s | 0.580031 s *(all-null — §6)* |
| `/api/coa/levels` | 500 in 0.330486 s | **200 in ~1.5 s** *(was never broken — §5)* |
| sign-in | 0.317703 s | 0.305771 s |

**★ A caveat on the `summary` row.** It was first read at **16.9 s**, and a probe
that measured the same three statements reported 10,261 ms sequential. On
re-measurement the endpoint was **4.524 s**. The conclusion drawn was that the
anomaly was a *measurement*, not the code — so the row was left alone rather than
"optimised". **That judgement is itself unverified**, and if a re-measure settles
back at ~16 s it is wrong. Either way it is the reason the pushdown was proved by
**key-set equivalence** rather than by a stopwatch alone.

### 2.5 The caching doctrine this changed

`ledgerPlan` caches a composed plan in `planCacheDerived`, **keyed by table
alone**. That is sound only while a table's read source is a property of the
*table*. A filtered request makes it a property of the *request*, so a filtered
plan must never enter that cache — otherwise the next unfiltered caller would
silently read a fragment that only knows about one level. **That failure mode is
a wrong answer that looks fast**, which is the worst kind, so filtered plans are
composed per request and the cache is left for the unfiltered case.

---

## 3. Finding 2 — `V_ACCOUNT_POSITION` is one row per combination, not per level+object

### 3.1 The defect

The drawer joined the ledger's budget onto the project's accounts with a single
lookup:

```ts
const positionFor = (level, object) =>
  (positions ?? []).find((r) => r.LEVEL_CODE === level && r.OBJECT_CODE === object) ?? null;
```

That premise was written down in `ProjectAccount`'s own doc comment — *"Object is
also the grain Oracle's own budget is read at — `V_ACCOUNT_POSITION` holds one
row per level+object"* — and it is **false**. The view is one row per
`CODE_COMBINATION_ID`.

Level `0450` has four accounts (526, 527, 529, 532) across **five** combinations,
because object `529` is booked in two purposes. The endpoint returns five rows:

| combination | WCPSS_BUDGET |
|---|---|
| `04.6560.862.529.0450.0840.000` | **$12,931.00** |
| `04.6570.862.526.0450.0840.000` | $9,335,190.50 |
| `04.6570.862.527.0450.0840.000` | $9,074,692.41 |
| `04.6570.862.529.0450.0840.000` | **$877,819.93** |
| `04.6570.862.532.0450.0840.000` | $287,468.00 |
| | **$19,588,101.84** |

`.find()` returned the first `529` ($12,931) and dropped the second
($877,819.93). The panel therefore read **$18,710,282** against a ledger holding
**$19,588,101.84**, and *nothing on screen suggested a figure was missing* —
`19,588,101.84 − 877,819.93 = 18,710,281.91`, which `money0` renders as
`$18,710,282`.

### 3.2 What exposed it, and why the hint was never wrong

The drawer's hint read **"4 accounts of 4"** while the endpoint returned **5
rows**. That looked like the discrepancy. It was not: the two numbers are
different grains, and both are correct.

- **4** = `ProjectAccount`s — objects 526/527/529/532, the unit the hint counts.
- **5** = `CODE_COMBINATION_ID`s — what Oracle holds.

`ProjectAccount.combinations` exists precisely to record that an account spans
purposes, and `lines`/`orders`/`vendors` are all documented as *"summed over this
account's combinations"*. **Budget had the same grain and was the only column
read on the wrong one.**

### 3.3 The fix

`filter` and sum, not a better key — because summing is already this panel's
convention for a multi-combination account. Anything else makes one column of the
panel count rows while another counts accounts.

`budgetRows` is now a list of **accounts** (so the "n of m" hint's unit and the
money refer to the same thing) and `budgetTotal` sums **every** matching row.

**Verified in the browser** at `/projects?project=0450`:

| | before | after |
|---|---|---|
| usage line | `committed against $18,710,282 WCPSS budget · 54.9% used` | `committed against **$19,588,102** WCPSS budget · **52.5%** used` |
| hint | `Oracle WCPSS budget · 4 accounts of 4` | `Oracle WCPSS budget · 4 accounts of 4` *(unchanged, and correct)* |
| error notice | none | none |

### 3.4 The generalisable lesson

**A column that a view publishes as an aggregate is not a base column, and
neither filtering nor keying on it means what it looks like.**

Findings 1 and 2 are two consequences of that one fact, and they are worth stating
separately because the symptoms have nothing in common:

| | Finding 1 (filter) | Finding 2 (key) |
|---|---|---|
| what the code assumed | `WHERE LEVEL_CODE = …` narrows the read | `(LEVEL_CODE, OBJECT_CODE)` identifies a row |
| what the view does | publishes `MAX(cc.SEGMENTn)` **over** a `GROUP BY CODE_COMBINATION_ID` | — |
| what actually happens | the predicate lands **outside** the wrapper, so the aggregate is computed for every account and then discarded | the row grain is one per **combination**, so the "key" is not unique |
| symptom | **10.8 s** — slow, but *correct* | **$877,819.93 missing** — fast, but *wrong* |
| how it was caught | a stopwatch | a count that disagreed with a count |

**Neither raises an error.** The performance bug returns the right answer, so it
only looks like a bug if you time it; the correctness bug returns a *plausible*
answer, so it only looks like a bug if you check the total against another source.
That asymmetry is why the pushdown was proved by key-set equivalence and not by a
stopwatch alone — 58 ms proves nothing if the five rows are not the same five.

**★ The wrong premise in a comment is what makes such a bug look like a property
of the data.** `ProjectAccount`'s comment was the only reason a single lookup
looked correct; it has been corrected in place, and the same claim removed from
`types.ts` and `DetailDrawer.tsx`.

---

## 4. Finding 3 — the two unfiltered paths are still over budget (OPEN)

`/api/funding/positions?limit=200` (**15.37 s**) and
`/api/funding/budgets?limit=200` (**6.42 s**) are the fan-out calls made by
`app/src/data/budgets.ts:277` and `:276`. Neither supplies `level` or `object`, so
**there is no segment to push down** and SQL is exhausted as a lever.

The adjacent call at `app/src/data/budgets.ts:269` is the **filtered** one
(`/api/funding/positions?${query}`, where `query` carries the level). That is the
drawer's request, and it is the **0.401 s** row in §2.4 — so this file already
demonstrates the difference between the two paths.

**The remaining lever is a TTL cache, not more SQL.** The model already exists in
`server/src/routes/extract.ts`: `EXTRACT_CACHE_MS` (**default 600 000 ms**, `0`
disables), `?refresh=1` to force a rebuild, and the **scope is part of the key** —
`extract.ts:324` records why: *"two organizations with different scopes must not
share a snapshot … a cache keyed on nothing would be a bug the moment a second
one exists."* That reasoning applies verbatim here.

**★ Two constraints to carry into that work:**

1. **Guard the parse with `Number.isFinite`, and test for the blank string
   *before* coercing it.** `extract.ts:333` records the exact defect to avoid:
   `Number(process.env.X ?? '')` reads `''` as a **finite `0`**, so the guard
   *passed* and silently disabled caching. The symptom was not an error — it was
   that every request took ~15 s and carried a fresh `generatedAt`, with nothing
   to follow. **This is the same 15 s as §4's `positions?limit=200`**, which is
   worth ruling in or out before designing anything new.
2. **A cache keyed on a table is only sound while the read source is a property
   of the table** — see §2.5. A scope-keyed cache has the same shape of hazard.

---

## 5. Finding 4 — `GET /api/coa/levels`: CLOSED, THE ENDPOINT ANSWERS 200

**This finding was wrong, and the way it was wrong is worth more than the finding.**
The record said the endpoint answered 500, three times, with the payload below — and
`/api/coa/levels` answers **200** on the live server today. The 500 was real for the
build it was measured on; what was never true is the reading put on it, that the
endpoint was **dead on arrival and had never worked**. It works, and the reason the
record could not see that is the subject of this section.

**The evidence that closed it** — a single request against the running API, with the
row count taken from the payload rather than from the status:

```
GET /api/coa/levels  ->  200  [112,440 bytes]
{"data":{"valueSetId":1002649,"codes":1308,"namedCount":1308,"unnamedCount":0,
         "levels":[{"LEVEL_CODE":"0000","ACCOUNT_COUNT":35728,"LEVEL_NAME":"Blank"}, …]}}
```

`valueSetId 1002649` is exactly the pinned `LEVEL_VALUE_SET` that `db/derived.ts`
computes, so the endpoint is answering about the value set it is supposed to.

### 5.1 The second question in this finding is now answered too

The open question was *"the handler advertises `1 named code of 179`, my notes say
all names present — settle it by VALUE, not by status"*, with the discriminating
check named as *"`COUNT(DISTINCT SEGMENT5)` in use against the number of those values
that resolve to a non-null `DESCRIPTION`"*. That check has now been run, and it is
the `codes` / `namedCount` / `unnamedCount` triple above:

- **`codes: 1308`, `namedCount: 1308`, `unnamedCount: 0`** — **1,308 of 1,308 named.**
- So the handler's *"1 named code of 179"* claim (`coa.ts:876`, recorded at `:856` as
  *"Measured: 1 named of 179 codes, and the view reports 0 of 179"*) is **false on the
  live ledger**. The repository note (`1,308 unscoped / 829 with flags`) is the correct
  one, and the 179 belongs to a different, older value set.
- **A count that is correct by construction deserves a check that can fail.** The
  endpoint computed `namedCount` and `unnamedCount` from the same query that produced
  `codes`, so `namedCount + unnamedCount === codes` is an internal identity and proves
  nothing about the data. What proves something is that `unnamedCount` is **0**: a bug
  in the name lookup would have shown up as unnamed codes, not as a passing total.
  That is the assertion to keep — not "the endpoint answered 200", which is what the
  record relied on and what failed to notice the difference between a 500 and a payload.

### 5.2 Why the record went wrong, which is the durable part

The original 500 carried `{"error":{"code":"INTERNAL", …}}` — the framework's
catch-all for an exception it did not classify. Three hypotheses were written down,
including the right one: *"`ORDER BY (MAX(fv.DESCRIPTION) IS NULL) ASC` — whether
Oracle 19c accepts this spelling is unmeasured."* Oracle does not accept it, the
handler was corrected, and the endpoint has answered 200 since.

**What the record lacked was not a diagnosis but a re-measure.** It kept a red result
from an earlier build in a table whose every other cell said *after*, so a fixed
endpoint sat beside seven measured ones reading as equally current — and the row
labelled *"before"* and the row labelled *"after"* carried **the same 500**, which is
the tell that no re-measurement had happened between them. Two consequences to carry:

1. **A defect record needs a date and a build, or it becomes a claim about today.**
   The stale figure here was not merely old; it was load-bearing, because two other
   sections cited it as *"the endpoint that is dead"* while arguing about something
   else.
2. **A 500 is evidence about one build, not about an endpoint.** *"Never worked in
   this state, so there is no before to compare against"* was inferred from a payload
   and was wrong: the endpoint has a before, it is simply not the payload the record
   kept.

---

## 6. Finding 5 — three endpoints answer 200 with every value null (OPEN)

`/api/funding/budget-types`, `/api/funding/budget-versions` and
`/api/funding/budget-assignments` all return **200** and all take under a second.
That is why a status-only check has never caught them:

```
/api/funding/budget-types?limit=200   ->  200  0.400000 s  [171 bytes]
{"data":[{"BUDGET_TYPE_ID":null,"BUDGET_TYPE_CODE":null,"BUDGET_NAME":null,
          "DESCRIPTION":null,"ENABLED_FLAG":null}],
 "page":{"limit":200,"offset":0,"total":1,"returned":1}}

/api/funding/budget-versions?limit=200  ->  200  [588 bytes]
{"data":[{"BUDGET_VERSION_ID":1001,"LEDGER_ID":null,"BUDGET_TYPE_ID":null,
          "BUDGET_NAME":"WCPSS BUDGET","FIRST_PERIOD_NAME":null, …}]}
```

★ **The mechanism is not established, and this document does not claim one.** The
descriptors read `table: 'GL_BUDGET_TYPES'` with `columns: BUDGET_TYPE_COLUMNS`
(`server/src/routes/funding.ts:79-108`, `:380`), and those constants are the
SELECT, sort *and* filter allowlist — so the query is well-formed by
construction. What is measured is only this: **one row comes back, every column
is null, and the HTTP status is 200.** A non-existent column would raise
`ORA-00904`, not return nulls, so the obvious explanation is probably the wrong
one. Resolving it needs a probe that runs the descriptor's own SQL — it has not
been written.

**★ The lesson here is about the harness, not the endpoint — and its original example
has since been retired, which is why the lesson had to be restated rather than
deleted.** As written it read: *"`/api/coa/levels` is **500 in 0.33 s** and
`budget-types` is **200 in 0.40 s**; a sweep that asserts status codes cannot tell
them apart from working endpoints."* **`/api/coa/levels` answers 200 now (§5)**, so
that sentence names one working endpoint and one broken one and proves nothing — but
the point it was making is intact and better served by these two, both measured on
the current build:

- `budget-types` answers **200 in 0.40 s** with **every column null** — a status check
  passes it.
- `V_ENCUMBRANCE_FROM_PO` answers **503** (via `AppError.dbUnavailable`) with a
  **correct, named explanation** — a status check fails it, and failing it is wrong:
  the refusal is the honest answer.

So status is not merely insufficient, it is **not even monotone with health**: the
worse endpoint has the better code. `server/tmp-live.ps1` must assert **a non-null
field per endpoint**, not merely that it answered, and must treat a documented refusal
as a pass rather than a failure.

---

## 7. What changed in the code

| File | Change |
|---|---|
| `server/src/db/derived.ts` | New `SegmentFilter` type and `segmentEquality()`; `positionFragment(scope, filter)` and `budgetFragment(scope, filter)` gained an optional filter; `DERIVED` and `derivedPlan` take it through |
| `server/src/db/ledger-shape.ts` | `LedgerShapeRequest.filter`; `ledgerPlan` caches unfiltered derived plans and composes filtered ones per request — see §2.5 |
| `server/src/routes/resource.ts` | `ResourceDescriptor.pushdown?`; `readSource(d, query)`; `listRows` passes the query. ★ `findRow` still calls `readSource(d)` with no query — **a by-key lookup cannot benefit from a pushdown until it is taught about one** |
| `server/src/routes/funding.ts` | `segmentPushdown()`; `pushdown: segmentPushdown` declared on `ACCOUNT_POSITION` and `BUDGET_BY_ACCOUNT` |
| `app/src/components/DetailDrawer.tsx` | `positionFor` returns **all** matching rows; `budgetRows` counts accounts; `budgetTotal` sums every row — §3 |
| `app/src/data/types.ts` | Removed the false "one row per level+object" premise from `ProjectAccount` |

`npm run typecheck` in `app/` → **exit 0**.

---

## 8. How to reproduce

```powershell
# The decisive probe — timing AND key-set equivalence, with failing controls
& ".\server\node_modules\.bin\tsx.cmd" "server\tmp-push.ts"   # writes server/tmp-push.txt

# The endpoint sweep (signs in, then times eight URLs into $env:TEMP\live.txt)
& ".\server\tmp-live.ps1"

# Typecheck
Push-Location app; npm run typecheck; Pop-Location
```

**Probe hygiene, learned the hard way in this work:** redirect to a file and read
the file. A long-lived terminal's completion notification **re-emits its entire
scrollback**, which replays stale output and briefly makes old numbers look
current.

**★ Not yet re-run and therefore not claimed:** the smoke baseline. The last
recorded run was **115/115 `local`** and **66/103 `oracle`**, and that was **before**
the pushdown landed. The pushdown and the `derivedPlan` wiring may have moved
several `ORA-00942` assertions on the three derived views, so **oracle smoke needs
a fresh, non-watch run** before any pass/fail claim is repeated. Under
`DB_MODE=oracle` it should now **expect values, not 503s**, on the three `V_*`
assertions — that is the largest expected movement.

---

## 9. What this document does NOT claim

- **It does not claim the funding surface is fast.** Two unfiltered paths are
  15.4 s and 6.4 s (§4) and `/api/funding/summary` at 4.524 s is inside "a few
  seconds" only generously, on a cold read.
- **It does not claim `/api/coa/levels` was ever broken in the way it said.** It
  answers 200, with 1,308 of 1,308 codes named (§5). The claim this document has to
  withdraw is not about the endpoint but about the record: a 500 measured on an older
  build was carried forward as a fact about the current one, and the `before` and
  `after` columns of the sweep table quoted **the same 500**, which is what a missing
  re-measurement looks like. What remains open is narrower — *why* a `namedCount` of
  1,308 sat in a handler whose own description says `1 named code of 179` and nobody
  reconciled the two; that is a documentation defect, not an availability one.
- **It does not claim the smoke suite passes.** See §8.
- **It does not claim the pushdown is the only such defect.** Findings 1 and 2
  were the same mistake — *treating a published aggregate as if it were a base
  column* — found twice on one surface, and nothing was done to sweep for the
  others. The remaining derived-view consumers to check are `coa.ts:1029`,
  `coa.ts:804-826`, and **`spend.ts:320`**, the only unpaged consumer of
  `V_ACCOUNT_POSITION`; `resource.ts:289` (`findRow`) is the known structural gap,
  because it reads its source with **no query at all**.
- **It does not claim the fix is complete on the frontend either.** The drawer was
  corrected; any other consumer that joins `V_ACCOUNT_POSITION` onto a
  level+object list would carry the same silent undercount, and no such sweep was
  run.
