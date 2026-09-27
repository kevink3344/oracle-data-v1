# The Sunburst view — a plan

**Status:** not started. Feasibility confirmed; the reference is portable and the repo is
already shaped for it.
**Ask:** *"a 'sunburst' next to the project network toggle. Look at this page and tell me if it
is possible."* → <https://observablehq.com/@d3/zoomable-sunburst>

---

## 1. The answer

**Yes.** Not "possible with effort" — the app is already built the way this view needs.

The lineage canvas's own header records the decision that makes a sunburst cheap here
(`LineageCanvas.tsx`):

> **`d3-force` and `dagre` are LAYOUT ONLY** — they compute `x`/`y` and nothing else. That is
> exactly the seam wanted: the layout is a pure function and the drawing stays in the app's own
> SVG, following the pattern `TrendChart.tsx` already sets (a `viewBox`, a `ResizeObserver`, a
> `useMemo` geometry block).

A sunburst is precisely that shape: `d3.partition()` computes **angles** where dagre computes
ranks, and the app draws paths. No renderer, no WebGL, no provider context, no stylesheet to
fight — the three reasons `@xyflow/react` and `react-force-graph` were rejected.

Six things already exist that this view would otherwise have to invent:

| Already here | Where | What it saves |
|---|---|---|
| The account colour key | `accountColour()` + `ACCOUNT_COLOURS`, `lineage.ts:594` | The reference spends its colour work on `d3.scaleOrdinal(d3.quantile(d3.interpolateRainbow, …))`. We have a key that matches the legend beside it. |
| A selection detail panel that takes a `LineageNode` | `LineageView.tsx` `.lin__detail` | The sunburst emits `project:0450`, `account:0450:529`, `vendor:<name>`, `po:273069:1` — the **same ids** — so the panel and its `Clear` button work unchanged. |
| The invoice/check link, fetched once per project | `loadLineageLinks` in `LineageView.tsx` | Leaves can carry `N invoices · M checks` with no new request. |
| Lazy loading of a view | `const LineageNetwork = lazy(…)` | A ~250-line sunburst component can be code-split the same way, so the Flowchart does not pay for it. |
| A segmented control's styling, and its contrast already settled | `.lin__switch` / `.lin__switchbtn`, `lineage.css:25–63` | See §7 — the classes exist and **are emitted by nothing**; the file's own comment records that `--link` (7.6:1) was chosen over `--tertiary-color` (2.4:1) for the active state. |
| A checkable total | `derive.ts:258` — `committed = sum(rows.map(r => r.amount))` | A partition's areas are shares of a whole, so the whole must be the number printed above it. §9 G1 asserts exactly that. |

---

## 2. What the reference actually does

Fetched from the page rather than recalled, because the plan's cost estimate depends on it:

```js
// The data is a nested { name, value | children } tree.
const hierarchy = d3.hierarchy(data)
    .sum(d => d.value)
    .sort((a, b) => b.value - a.value);
const root = d3.partition()
    .size([2 * Math.PI, hierarchy.height + 1])(hierarchy);
root.each(d => d.current = d);

const arc = d3.arc()
    .startAngle(d => d.x0)
    .endAngle(d => d.x1)
    .padAngle(d => Math.min((d.x1 - d.x0) / 2, 0.005))
    .padRadius(radius * 1.5)
    .innerRadius(d => d.y0 * radius)
    .outerRadius(d => Math.max(d.y0 * radius, d.y1 * radius - 1));
```

…and the zoom, which is the whole of the interactivity:

```js
// On click: re-express every node's angles relative to the clicked node's span,
// and its depth relative to the clicked node's depth.
root.each(d => d.target = {
  x0: Math.max(0, Math.min(1, (d.x0 - p.x0) / (p.x1 - p.x0))) * 2 * Math.PI,
  x1: Math.max(0, Math.min(1, (d.x1 - p.x0) / (p.x1 - p.x0))) * 2 * Math.PI,
  y0: Math.max(0, d.y0 - p.depth),
  y1: Math.max(0, d.y1 - p.depth)
});
path.transition(t).tween("data", d => {
  const i = d3.interpolate(d.current, d.target);
  return t => d.current = i(t);
}).attrTween("d", d => () => arc(d.current));
```

So the notebook's dependency list is `d3-hierarchy` (the layout), `d3-shape` (the arc),
`d3-interpolate` (the tween), `d3-transition` (the animation), `d3-scale` + `d3-interpolate`
(the rainbow). **Only the first is load-bearing:**

- the tween is **four lerps per node** over ~750 ms — ~20 lines in a `requestAnimationFrame`
  loop, and the app has no `d3-transition` anywhere to be consistent with;
- `arc()` is one annular-sector path — ~15 lines (`M`, two `A` arcs, `Z`);
- the colour scale is unnecessary (§1).

**Therefore: one new dependency, `d3-hierarchy` (~11 KB), plus `@types/d3-hierarchy` as a
devDependency.** Not a renderer, not `d3-shape`, not `d3-transition`.

★ **The one thing hand-rolling the arc gives up is `padAngle`/`padRadius`.** The replacement is
a 1 px stroke in `var(--surface)` on each arc path — the same visual separation, one less
dependency, and *theme-aware* where a hard-coded angular gap is not. The `stroke` also gives
every arc its border for free. If a 1 px stroke proves too heavy at depth 3 (3 px of stroke on a
40 px ring is 7.5 %), `d3-shape` is the documented fallback — but the measurement that decides
it is a render, not a guess.

---

## 3. What the rings are — measured, not chosen

The ask was then narrowed to a specific chain: **project → account → purchase order → invoice →
check** — the Flowchart's chain drawn as a partition. Whether that is buildable is not a matter of
opinion, so it was measured against level 0450, **entirely through SQL Server** (probe: a throwaway
`.mjs` script, deleted after use).

> ★★ **EVERY FIGURE BELOW IS READ FROM SQL SERVER**, either `GET /api/extract/current` under
> `DB_MODE=sqlserver` or `/api/ap/project-lineage`. **No figure here comes from
> `app/public/oracle/output.json`**, which `extract.ts` documents as *"not a stale copy of the same
> dataset — a different, narrower one"*. **An earlier revision of this section was measured off that
> file and is retracted in full** — see the note under the table in §3.1.

> ★ **Three figures have been in this plan that were recalled or measured off the wrong basis, and
> were wrong:** *"~61 PO lines for level 0450"*, *"Ring 2 is ~61 unlabelled slivers"*, and — found
> while checking the constraint — the whole of the earlier §3, which read the frozen extract and so
> reported **14 rows / $4,356,078.25** where SQL Server holds **20 rows / $10,278,516.25**. The
> coincidence of one number naming two different rings was the tell for the first two; the tell for
> the third is that the file it was read from is no longer on any runtime path.

### 3.1 What each ring can be measured in

| Ring | Source | Value | Nests in its parent? |
|---|---|---|---|
| 1 project | `derive.ts` `buildProject` | `committed` = **$10,278,516.25** at 0450 (20 rows) | — |
| 2 account | extract `lines`, `line.object` | Σ `line.amount`; 4 accounts (526, 527, 529, 532) | **yes, exactly** |
| 3 PO line | extract `lines` (`ORDER_NUMBER`/`LINE_NUMBER`) | `line.amount`; **20 lines, 12 orders** | **yes** |
| 4 invoice | `/api/ap/project-lineage` → `links[].amount` | `SUM(AP_INVOICE_LINES_ALL.AMOUNT)` | **no — §3.2** |
| 5 check | same path: `links[].checks` is a **count** | **no check amount exists on this path at all** | **no — §3.3** |

★★ **Read the last two rows' grain before the numbers: rings 4 and 5 are ONE VALUE PER PO LINE.**
`LineageLink` (`lineage.ts:606`) is `{ orderNumber, lineNumber, invoices, checks, amount }` — so the
API hands back, per PO line, the **count** of invoices that named it, the **count** of checks that
paid them, and the Σ invoice-line amount. There is **no per-invoice row and no per-check row**, and
no check money at all. Two things follow, and they decide §3.6's geometry:

1. **Ring 4 has one wedge per ring-3 arc, and it does not subdivide.** It cannot say *"this invoice
   vs that invoice"* — that would be 66 leaves the response never sent.
2. **Ring 5 can only ever be ticks**, one per check, because `checks` is a number and nothing else.

So the two rows' `no` is not a shortcoming to work around — it is the **reading** the picture has to
be built for: ring 4's angular span is a *fraction of its own line* (§3.6 D), and the fraction it
leaves out is the answer.

★ **Ring 1 splits into two PURPOSE buckets, and both nest.** The level's 20 rows carry purposes
**6570** ($10,275,236.25 over 19 lines) and **6560** ($3,280.00 over 1 line, account 529) — so the
page's two "Related budgets" groups each print their own subtotal and neither is the project
total. A sunburst ring 2 taken from `project.accounts` already aggregates across purposes, so it is
the sum of the two (verified: Σ over the four accounts = **$10,278,516.25**, identical to the
headline). **Do not read `$10,275,236.25` as ring 1's total** — it is the 6570 bucket only.

★ **This is the corrected basis.** The earlier revision's table read ring 1 = **$4,356,078.25**,
ring 3 = **14 lines / 11 orders**, and cited *"2,782 rows = 2,782 `(level, order/line)` keys
fund-wide"*. Measured on SQL Server instead: the served document holds **31,670 rows**, level 0450
holds **20**, and **20 distinct `(ORDER_NUMBER|LINE_NUMBER)` keys** — the histogram of rows per key
is `{"1":20}`, so the row identity is still exactly 1:1 with a PO line and ring 3 still has no
collision to guard against. That identity is worth keeping as a probe, because a collision would
double-count money silently.

★ **Σ over objects equals Σ AMOUNT to the cent** ($10,278,516.25 both ways), so **ring 2 nests in
ring 1 exactly**. That is the one property a partition cannot fake, and it is the reason rings 1–3
can be laid out by a single money denominator while rings 4–5 cannot (§3.5 D, §3.6).

### 3.2 Ring 4 is on a different money basis, and it is not a subset

Measured on the **20** level-0450 PO lines the served extract carries, with **both sides read from
SQL Server** (`coverage.poLines = 20, linked = 16`):

- `link.amount` covers a median **93.8 %** of its PO line, spread from **2.7 %** to **112 %**.
- **One line is invoiced to 112 % of its own PO money** — a child arc larger than its parent.
- Across the level, invoice money is **$5,547,095.53** against PO money of **$10,278,516.25** — the
  child ring is **0.540×** its parent, i.e. *less* than half.
- **4 of the 20 lines have no invoice link at all** (Σ $59,027), so ring 3 would carry wedges with
  no children.
- **0 links name a line the served extract does not carry** — so on this basis the two sources
  agree exactly, and there is no orphan set to explain away.

★ **The earlier revision's figures for this paragraph are retracted.** It reported a median of
**87.6 %**, a level ratio of **1.27×**, and *"6 links name lines the extract does not have"*. All
three were artefacts of reading ring 1's denominator off the frozen extract's 14 rows: with the
correct, larger parent the level ratio falls **below 1** (0.540×) and the orphan count goes to
**zero**. Note which half of this survives any parent — **the range still runs past 100 %** — and
that is the part the design depends on.

★ The code already says this in words — `LineageLink.amount` is documented as *"Σ invoice-line
amount, **which is NOT the PO line's amount** — partial invoicing is normal"*. **"Partial"
understates it:** the ratio runs past 100 %, so it is not an under-count that a gap could absorb. A
partition whose children exceed their parent cannot be drawn without misstating one of the two.

★ **Count and money disagree by 17×**, so an arc sized by invoice count would mislead. The clearest
pair on this data: `273173|3` carries **1 invoice at 2.7 %** of its PO line while `280552|1` carries
**1 invoice at 46.3 %** — same count, **17×** the money.

### 3.3 Ring 5 cannot be weighted — and the only amount that exists 1.837× over-counts

`/api/ap/project-lineage` returns `checks` as a **count**; there is no payment amount anywhere on
that path. A second source does carry one — `/api/ap/invoices` `Table2` holds `CHECK_AMOUNT` on
each (invoice, check) link — and it cannot weight a ring:

- Σ `CHECK_AMOUNT` over the **117 links** = **$11,761,032.21**
- Σ `CHECK_AMOUNT` once per **check** (65 of them) = **$6,403,331.75**
- → **it repeats 1.837×**, because **29 of the 65 checks settle more than one invoice** and every
  link carries the whole check.

★ **This finding is robust across both bases, which is why it is the one to trust.** On the frozen
extract it measured **1.84×** with **7 of 28** checks multi-invoice (`7/28 = 0.25`); re-measured on
SQL Server it is **1.837×** with **29 of 65** (`29/117 = 0.248`). The ratio of multi-invoice checks
to links is the same to one decimal place on two different datasets — **so the defect is in how the
register stores a payment, not in which snapshot you read it from.**

> ★ The **`AMOUNT_PAID`** substitution in the previous revision — *"reconciles for 47 of 65 checks
> (±$1), with 9 of 126 invoices carrying no check at all"* — **has not been re-measured on this
> basis.** Treat those two figures as unverified until they are; everything else in this
> subsection was re-derived.

### 3.4 The register is a different subject, not a deeper view of this one

Reaching rings 4–5 means re-basing the whole disc on the register, because the register cannot be
joined at the extract's grain: `Table1.PO_NUMBER` is computed as `MAX(SEGMENT1)` over the invoice's
lines, so an invoice names an **order, never a line**. (`PO_COUNT` is 0-or-1 on all 126 rows, so
nothing collapses *today* — but the line is absent by construction, and an invoice's order ring
would have to be *orders*, not the lines ring 3 draws.) And the register's scope is one calendar
year of AP:

- 126 invoices, **all dated 2026**; 182 invoice×account rows, `IN_SCOPE = 'Y'` on every one.
- **Level 0450 appears in exactly one of those 182 rows: Σ `DIST_AMOUNT` $85,120.80.**

That is **0.83 % of the $10,278,516.25 the page calls this project's committed money**. A sunburst
built on the register would not be a partial view of the project — it would be a different subject
that happens to share a column name.

### 3.5 The constructions — and the one chosen

**★ Decided: the disc carries all five rings, exactly as §3.1 names them** — project → account →
PO line → invoice → check — with each ring measured in the source §3.1 gives it. §3.1's
*"Nests in its parent?"* column is the guide for the **layout**: it says rings 1–3 nest in money and
rings 4–5 do not, so the build uses a **per-depth denominator** (§3.6, construction D) — which is
what makes that `no` drawable without silently re-sizing the rings above it.

| | Rings | Measure | Verdict |
|---|---|---|---|
| **A** | 1–3 money; invoices/checks as **detail** | `line.amount` throughout | The conservative build. Every ring nests, so §9 G1 holds trivially — but it does not draw the two rings the ask names. **Kept as the fallback** if the seam in §3.6 proves unreadable at this ring thickness. |
| **B** | all five, register-based | `DIST_AMOUNT` / `INVOICE_AMOUNT` / `AMOUNT_PAID` | Honest and fully nested — but its root is **invoice money in one calendar year**, its PO ring must be **orders**, and at 0450 it reaches **0.83 %** of the project. A *different page*, not this one's rings 4–5. |
| **C** | all five, one flat `.sum()` | mixed | **Don't.** The inner rings get re-sized by invoice count. §3.6. |
| **D** | all five, **per-depth denominator** | ring 1 `committed`; ring 2 Σ `line.amount`; ring 3 `line.amount`; ring 4 `links[].amount` **as a fraction of its own line**; ring 5 `links[].checks` (equal ticks) | **Chosen.** Each ring keeps its own §3.1 meaning and no ring's total is replaced by its children's. Ring 4's empty wedge is the un-invoiced PO money — the finding, not a gap in the data. Two units on one disc, split at a seam that is labelled in words. §3.6. |

### 3.6 ★★ The mixed encoding, and the one way to have five rings without it

`d3.partition().sum()` propagates value **upward**. So the moment a leaf is worth *1 per invoice*,
every ring above it is sized by **invoice count** — ring 3 stops meaning "money on this PO line" and
the money encoding dies at every ring but the last. Keeping rings 1–3 as money *and* 4–5 as counts
needs a **per-depth value function**, which `.sum()` cannot express: it overwrites every internal
node's own value with its descendants'. That is the failure this repo has recorded twice as *"two
percentages on the same bar is usually two different denominators"* — and it is why **C, a flat
`.sum()` over five rings, is not the build** (§3.5's *Don't*).

The angles it would produce, measured **on SQL Server** (16 links at 0450):

- **66 invoices → 5.45°/wedge**, **65 checks → 5.54°/wedge** — a wedge that thin cannot carry a
  label.
- the widest arc is a **21-invoice** line (`266121|3`) taking **114°** of the ring. Note this is a
  line the **frozen extract did not carry at all** — the earlier revision named `266121|4` at 8 of
  28, which was the frozen file's shape.
- equal counts do **not** mean equal money: `273173|3` carries **1 invoice at 2.7 %** of its PO money
  while `280552|1` carries **1 invoice at 46.3 %** — **the same count, 17× the money.** That pair is
  the argument against ever reading an outer ring as a count.

#### The chosen build (D): five rings where the **shortfall** is the message

`partition` gives a child its slice by dividing its **parent's** span by the parent's `value`
(`x1 = x0 + child.value / parent.value * (parent.x1 - parent.x0)`). So the denominator is not a
detail — **it decides what every outer ring is allowed to say.** C leaves it at the telescoped
`.sum()` value, which is why it re-sizes the inner rings. D fixes it **per depth**, and the
load-bearing choice is that **ring 4 is drawn against the line's own `line.amount`, not against
Σ its own `link.amount`**:

| Ring | Depth | Its angular span | Divided among its children by |
|---|---|---|---|
| 1 project | 0 | full circle | `project.committed` → ring 2 |
| 2 account | 1 | Σ `line.amount` of its lines | its **own** Σ `line.amount` → ring 3 |
| 3 PO line | 2 | `line.amount` | its **own `line.amount`** → ring 4 |
| 4 invoice | 3 | `min(link.amount, line.amount)` — **a share, not a total** | equal ticks — `link.checks` is a count |
| 5 check | 4 | `link.checks` **equal ticks** | — leaf |

★★ **Using the parent's own measure rather than the sum of its children is the whole design**, and
it is the difference between a picture that reports and one that merely renders. With the children's
sum as the denominator, ring 4 always fills its line exactly and says only *"this is the invoicing
of this line"* — a fact the reader already had from ring 3. With the line's own amount, ring 4
answers **"how much of this PO line did an invoice actually reach"**, and **the wedge it leaves
empty is the finding.** Measured at 0450 (§3.2), read off the ring itself:

| Line | PO money | Invoiced | Ring 4 fills | What the reader sees |
|---|---|---|---|---|
| `266121\|3` | $5,288,000.00 | $3,904,218.60 | **73.8 %** | a wedge with a visible gap |
| `273173\|3` | $2,642,699.25 | $71,959.86 | **2.7 %** | almost entirely gap — the stand-out arc |
| `280552\|1` | $6,050.00 | $2,800.00 | **46.3 %** | half full |
| `283847\|1` | $3,280.00 | $3,672.00 | **112 % → clamped** | full, and the detail says why |
| 4 unlinked lines | $59,027.00 | — | **no arc at all** | rings 4–5 absent under that wedge |

**Three consequences, all load-bearing:**

1. **Rings 1–3 are untouched by rings 4–5.** Nothing above ring 3 consults invoice money, so the
   inner three still sum to `committed` (§9 G1, G9). *This is the whole reason D is not C.*
2. **Ring 4 is a share of its own PO line, and ring 5 is counts.** Neither is ever a share of the
   project. A ring-5 tick is **one check** — the data on this path carries no per-check money at all
   (§3.1) — so the legend's ring-by-ring key is the only thing that makes the disc readable, and §9
   G10 is the check that no tooltip claims otherwise.
3. **A line no invoice names draws no ring 4 or 5 arc** — 4 of the 20 lines at 0450, Σ $59,027
   (§3.2). Absence is the honest rendering; it is not a dropped row, and §9 G3 counts exactly this.

★ **One clamp, and it is labelled rather than silent.** `283847|1` carries $3,280.00 of PO money and
is invoiced at **112 %** of it, so its ring-4 arc would run past its own parent's span. It is clamped
to the parent, and the *fact* — invoiced past its own PO money — is stated in its **detail**, where a
sentence can carry it. §9 G13 asserts `x1 − x0 ≤ parent's` on the model for all five rings, so a
future change that removes the clamp fails a check rather than overdrawing a neighbour.

**Ring 3 is PO line, fixed by §3.1.** The vendor alternative is dropped: §3.1 names ring 3 as

**Ring 3 is PO line, fixed by §3.1.** The vendor alternative is dropped: §3.1 names ring 3 as
`ORDER_NUMBER`/`LINE_NUMBER`, and a vendor ring would draw one vendor under two accounts as two
arcs — reading as the Network with areas. If a vendor breakdown is wanted later it is a **detail
panel** question, not a ring.

★ Whichever is chosen, ring 2 is **cross-derived**: built from the level's lines the way
`buildNetwork` does, **and asserted equal to `project.accounts.map(a => a.object)`** (§9 G2).
`project.accounts` is derived the other way (buckets → cost codes → object, `derive.ts`), so if the
two sets disagree that is a finding, not a rounding detail to paper over.

---

## 4. ★★ The trap: the Network's graph is CAPPED, and a sunburst must not reuse it

This is the single most important line in the plan.

`buildNetwork` truncates by design, and says so:

- `PO_LINES_PER_ACCOUNT = 6` — only the six largest vendor-bearing lines per account become
  vendor nodes (`lineage.ts:387+`);
- `INVOICE_CHAINS_DRAWN = 4` — only the four largest linked lines get a drawn invoice→check chain.

★ **This cap is narrower than it reads, and it is worth knowing which parts of the chain it does
*not* touch.** It limits only the *drawn* invoice→check chain on the Network. `buildLineage` builds
its **PO nodes from the raw `lines` with no per-account cap**, so the sunburst's rings 1–3 are not
affected by either constant — those three rings truncate nothing. (`INVOICE_CHAINS_DRAWN` is
likewise a *Network* drawing cap; the sunburst's rings 4–5 read every link in the response. Measured,
§3.1.)

That is *correct* for the Network, because **position tolerates a missing tail** — a reader
compares clusters, not areas, and `hidden.poLines` discloses the count inline.

**A sunburst inverts that.** Arc angle *is* the share, so a capped hierarchy is not merely
incomplete — it is **wrong**: the money on the seventh-largest vendor does not disappear from the
picture, it silently **inflates every other arc's share**. A reader would read a percentage that
is arithmetically false while every count on screen stayed green.

**So `buildSunburstTree` reads the raw `lines` for the level, uncapped**, and its disclosure says
the opposite thing from the Network's. The Network says *"N smaller PO lines not drawn"*; the
sunburst must say *"all N lines"* — and, because the two views sit one toggle apart, it should
name the difference and **read both counts from the data**: *"all 20 lines · the network view
draws only the 6 largest per account."* That sentence is what stops two correct views from looking
like they disagree. ★ Do not type the 20 — §9 G4 exists because this plan already carried two
unmeasured counts.

★ **And it must not copy `buildNetwork`'s vendor filter either.** The Network keeps only lines
where `vendor.trim() !== ''`. In a partition that drops money outright, and the arcs would then
sum to less than the KPI printed above them. **Under §3.5's construction D this bites harder, not
less:** ring 3 is money for **every** line, so a line with no vendor recorded still has to appear —
it is a PO line, not a vendor. Vendor is consequently **not a ring at all**; it is a field on the
PO-line node, shown in the detail panel (where `(no vendor recorded)` is a readable value) and used
by the Network's own builder, which is unaffected.

★ **The Network's cap and the sunburst's cap are therefore the same number of things: zero.** Only
the *drawn chains* are capped there; here nothing is. `hidden.poLines` on the Network and every
count on the sunburst must both stay derived from the same `lines` array, so the two views cannot
disagree about how many lines exist while each is right about how many it draws.

---

## 5. Two things this disc must never claim to show

**1. Connectivity.** A vendor working under three accounts is three separate arcs under three
different ring-2 sectors, and a partition relates none of them — that is what the Network is for.
Vendor is **not a ring here** (§3.5 D), so the disc cannot even imply the hub by adjacency. Where the
reader selects a **PO line** whose vendor appears elsewhere, the detail panel may say so — *"this
vendor also appears under 2 other accounts in this project"*, `project.accounts` ∩ that vendor's
lines, computed from the data rather than looked up — but the disc itself stays a tree, and the tab
the reader switches to is the answer. This is the one place the two tabs genuinely do different work,
so §7 keeps *Network* one click away at all times.

**2. ★ A per-project share for rings 4 and 5.** Measured, §3.2–§3.3: the invoice figure is not a
subset of the PO line's (median **93.8 %**, range **2.7 %–112 %**, and across the level **0.540×**
it), and the check figure that exists at all repeats **1.837×** because 29 of 65 checks settle more
than one invoice. Those two rings therefore cannot share a denominator with rings 1–3 — which is
precisely why §3.6 D gives each depth its **own** denominator instead of dropping the rings. The
consequence is the one thing the UI must say out loud: **a ring-4 arc is a share of its own PO
line** — how much of *that line* an invoice reached — and **a ring-5 tick is one check**, never a
share of anything. The two are the only rings whose unit differs from the three inside them, and a
reader who takes a ring-4 arc for a share of the project is off by whatever `0.540×` times the
line's own weight happens to be. A *sibling* figure would invite the same mistake more openly — the
trap this repo has already recorded twice (line prices $430,613,104.79 vs distribution amounts
$430,580,538.04).

★ **So the legend carries a ring-by-ring key naming each ring's unit** — *rings 1–3 project /
account / PO money · ring 4 the share of **its own line** an invoice reached · ring 5 one tick per
check* — because §3.6's seam is unreadable without it. §8 P4 is that bullet; §9 G10 is the check that no
tooltip ever claims a per-project share for rings 4–5.

---

## 6. Files touched

| File | Change |
|---|---|
| `app/package.json` | `+ "d3-hierarchy"`; `+@types/d3-hierarchy` (dev) |
| `app/src/data/sunburst.ts` | **new** — `buildSunburstTree(project, lines, index)` → the **five rings of §3.1**: project → account → PO line → invoice → check, **uncapped**, returning the nested tree **of `LineageNode`s** (so every arc carries an id the existing panel resolves) plus the per-ring totals and counts the caption reads. Exports the §3.6 per-depth denominator beside the tree it applies to, so the layout rule cannot drift from the data. |
| `app/src/components/lineage/LineageSunburst.tsx` | **new** — the SVG: `partition`, hand-rolled arc, zoom tween, breadcrumb, focus ring, `role="img"` summary, hidden table. Lazy-loaded. |
| `app/src/components/lineage/LineageView.tsx` | a third branch; keep the shared `loadLineageLinks` fetch and the shared `selected` panel; a third legend variant; `mode` widened to `LineageMode` |
| `app/src/components/lineage/LineageCanvas.tsx` | **keep `ViewMode = 'pipeline' \| 'brain'` narrow** and declare `LineageMode` for the view/route — the branch guards `'sunburst'` before the canvas, so TS narrows and the canvas needs no change |
| `app/src/routes/ProjectDetailPage.tsx` | `?view=` becomes three-valued (`graphView` is a boolean today, `:74`); the single flip link at `:353` becomes the **Details / Network / Burst tab bar** (§7) |
| `app/src/styles/lineage.css` | `.lin__canvas--sunburst`, `.lin__arc` (fill/hover/selected/focus-visible), the breadcrumb, and `a.lin__switchbtn { text-decoration: none }` — see §7 |

No server change. No API change. No new fetch.

---

## 7. The toggle, and one thing found while looking

`ProjectDetailPage.tsx:353` is a **two-state link** that flips its own label:

```jsx
<Link to={graphView ? `/projects/${level}` : '?view=brain'}>
  {graphView ? 'Project details' : 'Project network'}
</Link>
```

That shape does not extend to three destinations — a control that has to guess what the reader
came from can only ever offer *the other* one. **Decided:** it becomes a tab bar of three, and the
Burst tab holds the sunburst.

```
[ Details ] [ Network ] [ Burst ]
```

**The three states, and the URL each one carries.** The `view` query param becomes the single
source of truth; `graphView` (`:74`) is a boolean today and cannot express three.

| Tab | `?view=` | Renders | Notes |
|---|---|---|---|
| **Details** | *absent* | `<ProjectDetail project={p} />` | The default. **Absent, not `view=details`** — the page's existing share links omit the param, and the canonical form of the default belongs at the bare URL. |
| **Network** | `brain` | `<LineageView … mode="brain" />` | **The existing value is preserved verbatim.** `?view=brain` is already in the wild (share links, browser history, bookmarks) and `brain` is the string the codebase has always used for this view. Renaming it to `network` would break every one of those silently — the page would just open on Details. Accept `network` as an **alias** if a readable URL is wanted, but keep `brain` working. |
| **Burst** | `burst` | `<LineageSunburst project={p} lines={lines} index={index} />` (§6) | New. Any other value falls back to Details. |

So `:74` becomes something like `const view = searchParams.get('view') === 'brain' || searchParams.get('view') === 'network' ? 'network' : searchParams.get('view') === 'burst' ? 'burst' : 'details';` — a **closed three-value union**, never a truthiness test, so a typo'd param renders Details rather than a blank body.

★ **The tab control is a tab bar, not a set of links styled as one.** Each entry keeps a real
`href` (so it is still openable in a new tab and the URL stays shareable) **and** carries
`role="tablist"` / `role="tab"` / `aria-selected` / `aria-controls`, with the body as
`role="tabpanel"`. Two things this must not do:
- **Do not use `<button onClick={navigate}>`.** A view switch that is not a link cannot be
  middle-clicked, copied, or opened beside another — and the current control is a real `href`.
- **Do not emit three `aria-selected="false"` on a static page.** The active tab needs the
  attribute, and the tab's own accessible name must be the label alone (the visible text), with
  the count/badge, if any, in `aria-label` — a tab named *"Burst 20 lines"* is a worse traversal
  target than *"Burst"*.

★ **Where the tab bar goes is a measurement, not a judgement call.** `:351–356` puts the current
control inside `.projpage__actions`, which **also** holds, in DOM order, the pencil `Link` (an
`.iconbtn` that CSS pulls out of the flex row into the head's corner, 8 px left of the pin),
`PinButton`, "Copy link", "Export CSV" and "Export to PDF". Three tabs are ~3× the current
control's width. **Do not add them to that row and infer the result** — either give the tab bar its
own row (preferred: it is navigation, the rest is actions) or, if it stays, measure
`.projpage__actions` **before and after**: its `getBoundingClientRect().width`, whether
`.iconbtn`'s computed position moved, and `document.documentElement.scrollWidth ===
document.documentElement.clientWidth` at 1280 / 1024 / 900 px. This repo has already paid for
inferring a layout: a 12 px padding "to make room" pushed a button **7 px past its own cell**, and
a declared `width` on a nowrap column cannot shrink content that will not wrap.

★ **`.lin__switch` / `.lin__switchbtn` already exist and are emitted by nobody.** A grep for
`lin__switch` across `app/src/**` returns **five hits, all inside `lineage.css`** — the class set
is there, token-correct, with its active-state contrast already argued in a comment
(`--link` 7.6:1 over `--tertiary-color`'s 2.4:1 at this size). So the styling for this control is
written; it has simply had no markup consumer since the toggle moved into the page header. Two
consequences:

1. **Reuse it** rather than authoring a fourth toggle style.
2. It needs one addition: `.lin__switchbtn` was written for `<button>`, and these must stay
   `<Link>`s (a view switch belongs in the URL, and the current control is a real `href` the
   browser can open in a tab). Add `a.lin__switchbtn { text-decoration: none; }` and verify the
   active `--on` state at the anchor's own font size.

---

## 8. The build, in priority order

### P1 — The tree and the arcs (readable at rest)

- `buildSunburstTree`: level filter → account → **PO line** → **invoice** → **check**, the five rings
  of §3.1, ordered `amount` desc **within the money rings** (and invoices desc by `link.amount`,
  checks desc by amount where known) at every level. That order is not decoration: it is
  `d3.hierarchy().sort((a, b) => b.value - a.value)` from the reference, **and** it is the order
  `project.accounts` is already sorted in (`derive.ts`), so ring 2's clockwise order and the
  legend's colour order agree.
- **Total = Σ ring-1 = Σ ring-2 = Σ ring-3 = `project.committed`** (§9 G1, G9). Rings 4–5 have their
  own measures and are **not** part of that identity — that is §3.6's seam, and the caption says it.
- **Every line becomes a ring-3 arc, including one with no vendor recorded and no invoice link**
  (§4) — the check G3 covers it. A line with no link draws **no ring 4 or 5 arc** (4 of 20 at 0450),
  and that absence is the honest rendering of §3.2's unlinked set, not a dropped row.
- **Ring 4's span is `min(link.amount, line.amount) / line.amount` of its line's wedge** — the
  parent's *own* measure in the denominator, never the sum of its children (§3.6 D). The remainder
  is left empty on purpose: that gap is the un-invoiced money. One clamp, for the 112 % line
  (`283847|1`), and the detail states the reason rather than the picture absorbing it.
- **Ring 5 is `link.checks` equal ticks** across ring 4's arc, one per check — the only encoding the
  data supports, since no per-check money exists on this path (§3.1).
- **Labels by measured width, never by a list.** The reference labels an arc only when it is wide
  enough. Compute it (`(d.x1 - d.x0) * radius > ~24 px`) rather than naming the big ones — a
  hand-picked list is wrong for the next project, the same lesson the **computed** hub flag
  already records.
- Hover/focus label in the canvas bar, reusing `.lin__canvasbar` / `.lin__count` / `.lin__mode`.

### P2 — Zoom (the "zoomable" in the name)

- Click → the clicked arc becomes the new root, angles relative to its span and depth relative to
  its depth (the reference's formula, quoted in §2). Lerp the four values per node over ~600 ms
  in a rAF loop; **jump immediately under `prefers-reduced-motion`**.
- ★ **Add a breadcrumb, which the reference does not have.** Its only route back out is clicking
  the **centre** — a few pixels across at depth 4, and the reason a first-time reader gets stuck
  one level in. `Project › 529 › Smith Mechanical` as a row of buttons is a small deviation and
  the one that makes the reference usable. Escape climbs one level (and puts focus back on the
  arc or breadcrumb that was used).

### P3 — The accessible equivalent (not optional in this app)

A sunburst is the least accessible chart shape there is, and this codebase puts `aria-label`s,
`.sr` spans, `focus-visible` and disclosure sentences everywhere.

- `role="img"` + a **computed** `aria-label` sentence: the total, the account count, the largest
  arc and its share (`ProjectAccount.share` already exists).
- A **visually-hidden table of the same hierarchy** (reuse `.sr`). A partition *is* a table; the
  arcs are a rendering of it. Every arc gets a text row.
- Keyboard: an SVG `<path>` is not focusable, so give each arc `tabindex="0"`, `role="button"`,
  its own `aria-label`, and Enter/Space to zoom — **and** add the `<select>` the Network already
  uses (`.lin__node-select`) as the reliable traversal path.
- ★ **The focus ring goes on the `<path>`, not a wrapper `<g>`.** `network-interaction.md` §P2
  already recorded this defect: *"the `<g>` has `tabindex` but no box, so `:focus-visible` on it
  draws nothing."* Same trap, same fix.

### P4 — The legend and the disclosures

- The legend follows the view (the existing rule, and it matters more here): the four account
  colours on ring 2, then a **ring-by-ring key naming each ring's unit** — *rings 1–3 project /
  account / PO money · ring 4 the share of **its own line** an invoice reached · ring 5 one tick per
  check* — which is the one legend this view needs and the Network does not: §3.6's seam is
  unreadable without it. **It must not carry the Network's `a ringed circle is a hub` note**, which
describes something this view cannot draw.
- Two sentences the Network does not need: *"all <N> lines"* and *"the network view draws only
  the 6 largest per account"* (§4) — each derived from the tree's own counts, never restated.
  ★ The `<N>` is a placeholder on purpose: write it as `treeMeta.lineCount`, not as a literal.

---

## 9. Verification

There is no test runner in `app/` (a workspace-wide search for `*.test.ts`/`*.spec.tsx` returns
nothing), so this follows the repo's own convention: `npm run typecheck`, `npm run build`, and a
throwaway probe that is deleted afterwards.

| # | Check | Why it is the check |
|---|---|---|
| **G1** | Σ ring-2 arcs === Σ ring-3 arcs === `project.committed`, **for every level, not just 0450** | The arcs are shares of the number printed directly above them on the same page. If they differ, the view is telling a second story. Rings 4–5 are deliberately **not** in this identity (§3.6's seam). |
| **G2** | Σ account arcs === Σ PO-line arcs === `committed`; and the account set === `project.accounts.map(a => a.object)` | A partition's levels must each sum to the whole — stated for the **money** rings only, since ring 4 is measured *within each line* (so it has no level-wide total) and ring 5 is a count. The second half is §3's cross-derivation. |
| **G3** | `count(ring-3 arcs) === count(lines where line.level === project.level)` — **including zero-vendor lines** | This is §4 stated as a number: no row may be dropped by the builder. |
| **G4** | The disclosure's `N` is read from the tree, not typed | A restated count drifts out of step with the data; this repo has a plan whose notes are checked by parsing them back out. |
| **G5** | Arc **count** changes after zooming one account (`path.lin__arc` before/after) | Proves the zoom re-partitions rather than merely transforming the viewBox — a difference invisible to a screenshot. |
| **G6** | **A control that must fail, in the same run** | This repo's rule: without a guaranteed-FAIL control, a PASS cannot be distinguished from a harness that matches on nothing. A deliberately bogus selector must return 0. |
| **G7** | Contrast of `ACCOUNT_COLOURS` **as fills on `--surface-sunken`**, measured in **both themes** | The palette was chosen for the Flowchart's *cards*. It has never been a fill on the sunken surface, and this repo has already found one token failing AA at 11 px (`--tertiary-color`, 2.4:1). Measure the arc's own backdrop — walk ancestors to the first non-transparent `background-color`. |
| **G8** | Render it and look at the outermost ring | A 335-row register taught this repo that a clipping bug passes every measurement. Capture the fold — the embedded browser renders the first viewport only, so a probe-only style that collapses the page head is the way to see it. |
| **G9** | Each ring is measured by **its own** §3.1 source, asserted **separately**: ring 1 = ring 2 = ring 3 = `committed`; ring 4's arcs = `min(link.amount, line.amount)` **of their own line**; ring 5's ticks = `links[].checks` | Under D the invariant is no longer "all the totals agree" — it is *each ring is measured by the source §3.1 names for it*. Assert all five **separately**, because a single `===` chain would fail by design (§3.2) and a missing one lets a ring drift unnoticed. |
| **G10** | Rings 4–5 say what they are in **words**: ring 4 = *the share of this PO line an invoice reached*, ring 5 = *one tick per check*, and **no tooltip claims a per-project share** for either | §3.6: ring 4 is a fraction of its own line and ring 5 is counts, so neither is a share of the project. The one failure mode a screenshot cannot show. |
| **G11** | The rows-vs-keys identity holds: `count(lines) === count(distinct level\|order/line)`, **for every level** | §3.1: it is 1:1 today. If it ever stops being, ring 3 double-counts money silently and every total above it is wrong. |
| **G12** | The disclosure's "all N lines" is derived from the tree **and** compared to the level's `lines.length` | A restated count is a claim; §9 G4 covers the first half, and this is the half that catches a builder that drops a row. |
| **G13** | **No arc's `x1 − x0` exceeds its parent's**, computed on the model for all five rings | The 112 % line (`283847\|1`, §3.2) is the case that breaks a flat `.sum()`: its invoice money exceeds its PO money. Under D the ring-4 span is taken against the line's own amount and **clamped** to the parent, so this must hold **arithmetically** — a render check would pass while one sector overdraws its neighbour. |
| **G14** | **The ring-4 gap is not normalised away**: for `273173\|3` the arc is **≈2.7 %** of its line's wedge, `266121\|3` **≈73.8 %**, and the 112 % line is **100 % + flagged** | This is the check that protects the whole design. Using the *children's* sum as the denominator — the obvious "fix" when an arc looks unaccountably short — makes every ring-4 arc exactly fill its line, and the disc silently stops reporting coverage while every other assertion stays green. Assert the three named cases, not "the ring renders". |

---

## 10. Cost and risk

**Cost:** one dependency (~11 KB), one data module (~120 lines), one component (~250 lines),
~60 lines of CSS, three small edits, no server work.

**Risks, in the order they would bite:**

1. **Thin arcs at the leaf ring.** Measured: level 0450 holds **20** PO lines, so the outer ring is
   comfortable *here* — but the widest project is far larger, and the served document holds
   **31,670 rows across 139 levels**. So this is a real risk at other levels even though 0450 looks
   fine, which is exactly the shape of mistake that a single-level measurement invites. Mitigation:
   label by measured width (§P1), which is a rule, not a level-specific fix.
2. **The outer band misread as shares of the project.** D normalises rings 4–5 *within their parent*
   (§3.6), so a ring-4 arc answers *"what share of this line's invoicing"*, never *"what share of
   the project"*. The caption and the tooltips are the whole defence, and G10 is the check.
3. **`padAngle`** may need `d3-shape` after all (§2).
4. **★ The per-depth denominator getting flattened back to `.sum()`.** Rings 4–5 now exist, and the
   tempting simplification is one `d3.hierarchy(data).sum()` over all five — which re-sizes rings
   1–3 by invoice count and count-of-checks, corrupting the three rings that do add up to
   `committed` (§3.6). §9 G9 (each ring = its own source) and G13 (no arc exceeds its parent) exist
   to fail loudly if that happens.

**What I would *not* do:** reuse `buildNetwork` (§4), nest the invoice amount as a ring (§5), label
by a hand-picked list (§P1), or leave the centre as the only way out (§P2).
