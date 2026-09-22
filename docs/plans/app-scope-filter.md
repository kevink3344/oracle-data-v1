# The app-wide account scope — Fund 04 · programme 861/862/863

## What was asked

> Next to the Search box, there should be a Selector (drop-down arrow) that opens the account
> combinations. ALL Funds will start with "04". ALL Programs will include "861","862" and "863".
> Please implement this and filter all data based on this information.

Answered up front, and binding on everything below:

| Question | Answer |
|---|---|
| Programme `863` | **Three chips — `861`, `862`, `863`.** The sketch showed two; the prose says three. |
| The fund control | **A fixed label `04`** — a stated constant, not a dropdown. |
| Selection | **Multi-select, all three on by default** — the default is the scope the extract already carries. |
| What the caret opens | **The segment values** — the fund and the three programmes. Not a list of combinations. |
| Persistence | **The URL, as query params** — shareable and deep-linkable. |
| Relation to `/spend/invoices` | **One scope, one source.** The selector governs the same rule the invoices extract was narrowed by, and a programme is in scope if it is *any* of the three. |
| Screens that cannot filter | **Say so on the page.** A scope note, not silence. |

---

## The measurement that shapes the design

Before designing a filter, the obvious question is what it would remove. Measured against
`app/public/oracle/output.json` — the 2,782-line PO extract **every** project, object, dashboard and
combination screen reads:

```
FUND         1 distinct   04
PROGRAM      1 distinct   862
COST_CENTER  1 distinct   0840
FUTURE_USE   1 distinct   000
PURPOSE      3 distinct   6560 | 6570 | 9000
OBJECT_      9 distinct
LEVEL_     139 distinct

rows failing  FUND='04' AND PROGRAM IN ('861','862','863')   →   0 of 2782
```

**Zero.** Four of the seven segments are single-valued, and the two the scope tests are among them.
So a scope selector pointed at the PO register removes nothing today — and, worse, the chip the
sketch showed selected (`861`, alone) removes *everything*: every one of the combination keys on
`/coa/combinations` is `04-…-862-…`, so one chip would empty the app. That is not a reason not to
build the control. It is the reason the control has to **say what it removed** rather than merely
remove it.

The rest of the surfaces, measured the same way:

| Screen | Source | Fund/programme available? | What the scope can do |
|---|---|---|---|
| `/`, `/projects`, `/projects/new`, `/objects/:object`, `/coa/combinations` | `output.json` | yes, per row — but constant | Filter correctly, **report 0 removed** |
| `/spend/invoices` | `invoices.json` | yes — the rule lives in the extract SQL | Driven by the selector; reconciles against it |
| `/spend/payments` | `checks.json` **+** `invoices.json` | **not on the check row** — the page joins through the invoices' account segments | Filters correctly; the page reports *"Showing 65 of 4,218 checks"* |
| `/activity` | `/api/activity` | **no account column** — counts are per *table* | Scope note only |
| `/admin/views` | live SQL | only if the query selects the segments | Out of reach by construction |
| `/funding/*` (6 leaves) | not built | — | — |

The Dashboard already makes this point in its own words, and the plan keeps it:

> *"FUND, PROGRAM, COST_CENTER and FUTURE_USE hold a single value on all 2,782 rows … Filtering on a
> fixed segment is a no-op that looks like a real filter."*

That note is **correct and stays** — rewritten to describe the filter we are deliberately adding, and
the count it removes.

---

## Design

### 1. One authored scope — `app/src/data/scope.ts`

```ts
export interface Scope { fund: string; programs: string[] }
export const SCOPE: Scope = { fund: '04', programs: ['861', '862', '863'] };
```

This is the **only** place those literals are written in the app. Everything else reads it or reads
the selected value off the store. The rule already stands from the invoices work — *nothing
downstream may hardcode `'04'` or `861-863`* — and this file is where "upstream" now is.

Helpers beside it:

- `scopeLabel(scope)` → `Fund 04 · programme 861/862/863`, with the programme list always sorted so
  two orderings of the same selection label identically.
- `scopeInScope(scope, fund, program)` → the predicate. One implementation, so the register and the
  PO rows cannot disagree about the rule.
- `parseScope(fund, programs)` → a `Scope` from URL text, falling back to `SCOPE` on anything
  unparseable, so a hand-edited URL cannot produce an empty app by accident.
- `isAuthoredScope(scope)` → whether the current selection is the default three.

### 2. State in the store, in the URL

`store.tsx` already owns `params`/`setParams` for `?project=`. The scope joins it:

- Reads `?fund=04&programs=861,862,863`, defaulting to `SCOPE`.
- `setScope` writes back with `replace: true` — the same treatment the search box gives its own
  navigation — and **preserves every other param**, so toggling a chip never drops `?project=`.
- A canonical ordering means `861,862,863` and `862,861,863` are the same URL.

### 3. `lines` becomes the scoped set — nothing downstream can forget

The store's `lines` is what every consumer already reads. Applying the scope **there** rather than in
each page means a screen cannot be added later that silently ignores the scope. Alongside it:

```ts
scope: Scope;            // the live selection
setScope: (s: Scope) => void;
scopeAll: number;        // rows before the scope — 2,782
scopeExcluded: number;   // rows the scope removed — 0 today
scopeExcludedValue: number;
```

The two counts are **carried, never subtracted**, per the standing rule the invoices register already
follows: a page must be able to say what the scope cost without doing arithmetic that could hide a
third bucket.

### 4. `ScopeSelect` — the control, as drawn

A new component, `app/src/components/ScopeSelect.tsx`, mounted immediately right of the search input
in `TopBar.tsx`:

```
[🔍 Search projects, vendors, buyers, descriptions, orders…]   04 │ (861)(862)(863)  ∨
```

- `04` is a **bare label**, not a button — it is a stated constant and must not look clickable.
- The three programmes are a **segmented multi-select**; the selected ones carry the accent outline,
  matching the sketch's blue `861`.
- The caret opens a **popover** naming the scope in full (`Fund 04 · programme 861/862/863`), listing
  the three programmes with a row count each, and offering **Reset to all three**. It opens on click,
  closes on `Escape` and on outside click, and is a real dialog-like panel (`aria-haspopup="dialog"`,
  `aria-expanded`).
- Keyboard: the chips are `<button aria-pressed>`, so the whole control is reachable and the state is
  spoken.

Below ~900px the inline chips give way to the caret alone, so the control degrades to the dropdown
the sketch's arrow already promises rather than overflowing the bar.

### 5. Every surface that *can* answer, answers

- **PO register** — filtered in the store, so `/`, `/projects`, `/projects/new`, `/objects/:object`
  and `/coa/combinations` all follow without an edit each.
- **Empty state** — when the scope removes every row, the page says **why** in the data's own terms:
  *"No purchase-order lines fall inside Fund 04 · programme 861/863. All 2,782 lines in the extract
  are programme 862."* An empty table with no explanation is the failure this sentence prevents.
- **`/spend/invoices`** — the register is already narrowed in SQL. The page now **reconciles** the
  envelope's `scope` block against the live selection and reports disagreement rather than quietly
  showing rows the selector says are out of scope.
- **`/spend/payments` and `/activity`** — a scope note: *"This register carries no account code, so the
  Fund 04 · programme 861/862/863 scope cannot be applied here."* On the page, not in a comment.
- **`/admin/views`** — the note goes on the View Builder, since a hand-written query is out of the
  scope's reach by construction.

### 6. The hardcoded constants become derived

The single most important consequence. Today `04` and `862` are written as literals in five places:

| File | Today | After |
|---|---|---|
| `data/taxonomy.ts` | `CONSTANT_SEGMENTS = { FUND: '04', PROGRAM: '862', … }` | **derived** from the store's lines, so it stops being a claim that breaks when the extract widens |
| `data/derive.ts` | `` combination: `04-${purpose}-862-${object}-${level}-0840-000` `` | built from the row's own segments |
| `components/HowBlock.tsx` | `` `04-${bucket.purpose}-862-` `` ×2 | from the scope |
| `components/DetailDrawer.tsx` | Chip: *"Fund 04 · 0840"*, *"single-valued across the extract"* | from the data |
| `routes/Dashboard.tsx` | *"FUND, PROGRAM, COST_CENTER and FUTURE_USE hold a single value on all N rows"* | measured, and paired with what the scope removed |

Without this step the selector would be reading a constant and the Dashboard sentence would be false
the moment a non-862 row arrived.

---

## What this plan deliberately does **not** do

- **It does not touch the extract SQL.** The invoices scope is already applied there and verified; the
  selector drives which programmes are in scope, not a re-pull.
- **It does not invent a filter for checks or activity.** Neither has an account column. A control that
  appears to filter them would be the exact lie the Dashboard note warns about.
- **It does not hide the rows the scope catches inside a kept invoice.** Two invoices in the register
  draw an account outside the scope (2 rows, $243.15). They stay, marked — the scope narrows *which
  invoices*, never *which of their accounts*, because dropping them would stop the accounts summing to
  the invoice.
- **It does not add a fourth bucket.** `in scope` / `excluded` / `unanswerable` is the shape the
  register already reports and the selector adds nothing to it.

---

## Verification

1. `npm run typecheck` and `npm run build` clean.
2. Browser, measured not eyeballed:
   - the control renders with three chips and `04` as a label;
   - `?programs=861,862` round-trips through the URL and survives a reload;
   - toggling a chip preserves `?project=`;
   - with all three on, every page's row count is unchanged from today (**2,782** lines) and the
     removed count is **0**;
   - with `862` removed, the empty state names the reason rather than showing a blank table;
   - `/spend/payments` and `/activity` carry the scope note;
   - zero console errors.
3. Memory and `app/README.md` updated with the measured numbers.
