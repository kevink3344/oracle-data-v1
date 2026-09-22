# Natural-language questions over the checks register

## What was asked

> I would like a plan for adding AI to the application. For example, on the Checks page next to the
> search box (or just inside the right edge of the search box) there can be a "brain" icon. When the
> person clicks it, that means they can add natural language to the textbox like "What was the
> hightest check paid in July?", and it would search the invoices and come back with "The highest paid
> invoice was $778,481 from Perfection Equipment Company." Or, "What were the average check price in
> July" and it would take all the checks from 2026-07-01 through 2026-07-30 add them up to find the
> average. Add a placeholder for the AI Model, Endpoint and API Key in the .env file so I can add them.

Answered up front, and binding on everything below:

| Question | Answer |
|---|---|
| Does the model do the arithmetic? | **No, never.** The model returns a *structured intent*; the server executes it and owns every number. |
| Which population does the answer describe? | **The one on screen** — the scoped register — and it says so in the answer. This is not a preference; see §"The measurement". |
| Where does the API key live? | **The server.** `AI_API_KEY` is read in `server/src/config/env.ts` and is **never** `VITE_`-prefixed. |
| Which model/provider? | Any **OpenAI-compatible chat-completions** endpoint. Three settings (`AI_MODEL`, `AI_ENDPOINT`, `AI_API_KEY`) plus an auth-style switch, so Azure OpenAI, OpenAI, Groq, Ollama and LM Studio all work. |
| Does the answer filter the table? | **No.** The answer is *about* the register; the rows stay as they were. It offers a link to the check it names, reusing the page's existing `?check=` arrival. |
| What if no key is configured? | The icon renders **disabled with an explanation**, the route still exists and refuses with a documented code. Never a crash, never a silent no-op. |
| Free-form SQL? | **No.** A closed allowlist of aggregations and filters. The only thing the model may choose is *which* of them, and with what arguments. |
| Which questions are out of scope for v1? | Invoice-subject questions, cross-register joins, and anything outside the extract's date window. Each refuses by name, in words. |

---

## The measurement that shapes the design

This is the part that decides whether the feature works at all, and it was measured before any of it
was designed. The user's own worked example turns out to be a **test of which population the answer is
computed over**, because the same question has two different right answers:

```
source: app/public/oracle/checks.json  ≡  data/oracle/checks.json  (1,753,002 bytes, identical)
        window 2026-07-01 .. 2026-08-11 (22 distinct dates)   rows 4,218   links 9,451

                            checks      sum               average        highest
SCOPED, July only             22   $1,273,946.95      $57,906.68   $778,481.55  63409  2026-07-21  PERFECTION EQUIPMENT CO.
SCOPED, whole window          65   $6,403,331.75      $98,512.80 $2,068,881.16  44407395 2026-08-11 SUPERIOR MECHANICAL SERVICES, INC
UNSCOPED, July only        3,261 $122,212,432.74      $37,476.98 $18,043,056.47 1157473 2026-07-24  WAKE COUNTY PUBLIC SCHOOLS
UNSCOPED, whole window     4,218 $145,478,131.75      $34,489.84 $18,043,056.47 1157473 2026-07-24  WAKE COUNTY PUBLIC SCHOOLS

07-01 .. 07-30 is IDENTICAL to 07-01 .. 07-31 — no check in the extract is dated the 31st
distinct CHECK_NUMBER values 4,218, no duplicates in this extract (see §4.4 — not an identity)
```

**The user's example is right, and it is right only over the scoped register.** Read against the whole
extract, "the highest check paid in July" is `$18,043,056.47` to `WAKE COUNTY PUBLIC SCHOOLS` — the
district paying itself, 197 checks totalling `$77,237,067.46`. Read against the register the Checks
page actually shows, it is **`$778,481.55`, check `63409`, `2026-07-21`, `PERFECTION EQUIPMENT CO.`**
— dollar for dollar the answer the user wrote down by hand. So an implementation that answers over the
raw extract would be *defensible and wrong*: it would produce an $18 M "answer" on a page whose own
stat strip says the largest single check is `$2,068,881`.

Confirmed against the running app, not inferred (`/spend/payments`, polled to completion):

```
page-head__sub : "One payment document per row, newest first — 65 checks issued between 2026-07-01
                  and 2026-08-11. Click a check to see the invoices it paid."
scopenote      : "Scope applied — The checks register is filtered through the linked invoices' account
                  segments for the Fund 04 · program 861/862/863 scope. Showing 65 of 4,218 checks."
CHECKS ISSUED  : 65 | 167 invoices
VALUE          : $6,403,332 | sum of the checks themselves            ← matches the probe to the cent
LARGEST SINGLE CHECK : $2,068,881 | check 44407395 to SUPERIOR MECHANICAL SERVICES, INC
                       ↑ matches the probe's scoped whole-window maximum exactly
```

Four more measured facts the design has to carry:

| Fact | Number | Why it changes the design |
|---|---|---|
| Only 65 of 4,218 checks are reachable through the scope join | 117 invoice→check links, 184 account rows, 126 invoices | The join is **narrow**. A scope-unaware implementation answers over 65× the data and cannot know it. |
| A check is not an invoice | max **13** invoices on a check in the scoped register (reported by the page itself) | "How many invoices…" is a different question from "how many checks…". The intent carries a **subject**. |
| The invoices do not always sum to the check | the page reports **100.0%, 65 of 65 to the cent** *scoped*; the extract's own note says 4,140 of 4,218 unscoped, all 78 falling short | Reconciliation is a **population-dependent** claim. Never state it without naming the population. |
| 274 of the 9,451 invoice links are negative | credit notes, sign carried through | `sum` over invoice amounts can legitimately go down. Check amounts are all positive. |

And one correction this plan owns: `docs/plans/app-scope-filter.md`'s surface table gives
`/spend/payments` the row *"`checks.json` — **no account column** (5 cols) — Scope note only"*. That was
true of the file and false of the page: the page joins through the invoices' account segments, applies
the scope, and prints *"Showing 65 of 4,218 checks"*. **That row is stale and should be corrected in
the same pass**, because it is the sentence a reader would use to decide the AI cannot be scoped.

---

## Design

### 1. The control — a "brain" at the right edge of the search box

Inside the existing `.chkfilter__box`, mirroring the magnifier. Three edits to
`app/src/routes/Checks.tsx` and one block in `app/src/styles/checks.css`.

```tsx
<div className={ai ? 'chkfilter__box chkfilter__box--ai' : 'chkfilter__box'}>
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">…magnifier…</svg>
  <label className="sr" htmlFor="check-filter">{ai ? 'Ask a question about checks' : 'Search checks'}</label>
  <input id="check-filter" type="search" autoComplete="off"
    placeholder={ai ? 'Ask — e.g. What was the highest check paid in July?'
                    : 'Search by check number, vendor or invoice number — e.g. 44407396'}
    value={ai ? question : query}
    onChange={(e) => (ai ? setQuestion(e.target.value) : setQuery(e.target.value))}
    onKeyDown={(e) => {
      if (e.key === 'Escape') { e.preventDefault(); ai && question ? setQuestion('') : ai ? setAi(false) : setQuery(''); }
      if (e.key === 'Enter' && ai && question.trim()) { e.preventDefault(); ask(); }
    }} />
  <button type="button" className="chkfilter__ai" aria-pressed={ai}
    aria-label={ai ? 'Leave ask mode — back to searching' : 'Ask a question in plain English'}
    title={ai ? 'Back to searching' : 'Ask a question in plain English'}
    disabled={!aiStatus?.enabled || asking}
    onClick={() => setAi((v) => !v)}>
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">…brain…</svg>
  </button>
</div>
```

**★ The CSS trap this walks into, measured by reading the sheet rather than the markup.** The existing
rule is

```css
.chkfilter__box svg { position: absolute; left: 9px; top: 50%; width: 12px; height: 12px;
                      transform: translateY(-50%); color: var(--text-faint); pointer-events: none; }
```

which matches **every** `svg` under the box — so a brain icon added naively lands on top of the
magnifier at `left: 9px` and **cannot be clicked at all**, because the same rule sets
`pointer-events: none` (deliberately, so the magnifier does not eat clicks meant for the input). Two
consequences, both required:

1. Narrow the magnifier rule to a **direct child**: `.chkfilter__box > svg`. The button's icon is a
   grandchild and stops matching.
2. Give the button its own rule with its own `pointer-events`.

```css
.chkfilter__box input { padding: 6px 32px 6px 29px; }   /* 10px → 32px: the brain needs the right edge */
.chkfilter__ai { position: absolute; right: 5px; top: 50%; transform: translateY(-50%);
                 width: 22px; height: 22px; display: grid; place-items: center;
                 border: 0; border-radius: var(--radius); background: none;
                 color: var(--text-faint); cursor: pointer; }
.chkfilter__ai:hover:not(:disabled) { color: var(--text-heading); background: var(--surface-sunken, transparent); }
.chkfilter__ai[aria-pressed='true'] { color: var(--primary-color); }
.chkfilter__ai:disabled { opacity: .45; cursor: not-allowed; }
.chkfilter__ai:focus-visible { outline: 3px solid var(--tertiary-color); outline-offset: 1px; }
.chkfilter__ai svg { pointer-events: none; }             /* the glyph, not the target */
```

`32px` is arithmetic, not taste: `5px` inset + `22px` target + `5px` gap = 32, against the magnifier's
`9 + 12 + 8 = 29`. Contrast of the pressed state must be measured in **both** themes at the rendered
size against the **input's own** backdrop (`var(--surface)`), not the page background.

**Behaviour.** On = the same `#check-filter` textbox accepts a question; off = today's `haystack`
filter, unchanged. A question is submitted with **Enter**, never on each keystroke (each submit is a
network call and a model call). Escape leaves ask mode first, clears second — the same key the box
already uses, with one more step, so the muscle memory survives.

### 2. The shape of the exchange — intent, then execution, then figures

Three steps, and the model is in only the first:

```
question ──► [MODEL] ──► intent JSON ──► [ZOD allowlist] ──► [SERVER executes over the scoped rows]
                                                                      │
                                    { value, matched, sample, basis } ◄┘
                                                                      │
                     optional [MODEL] prose (digits rejected) ─────────┘
```

**The model is never asked to compute, count, total or average anything, and it is never asked to write
a number.** Every figure in the answer is produced by the server's own reduction over rows it read
itself. This is the whole design in one sentence: *the model does the understanding, the server does
the truth.*

### 3. The allowlist — a closed vocabulary, not SQL

`server/src/ai/intent.ts`

```ts
export const AGGREGATES = ['max', 'min', 'avg', 'sum', 'count'] as const;

export const IntentSchema = z.discriminatedUnion('supported', [
  z.object({
    supported: z.literal(true),
    subject: z.enum(['check']),                       // 'invoice' is v1.1 — see §4.3
    aggregate: z.enum(AGGREGATES),
    dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    dateTo:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    vendor:   z.string().min(2).max(80).optional(),
    checkNumber: z.string().min(1).max(24).optional(),
    amountMin: z.number().finite().optional(),
    amountMax: z.number().finite().optional(),
    limit:    z.number().int().min(1).max(20).default(1),   // "the top five …" is limit: 5
  }).strict(),
  z.object({ supported: z.literal(false), reason: z.string().min(3).max(200) }).strict(),
]);
```

`.strict()` is load-bearing: an invented field is a **rejection**, not an ignored one, so a model that
hallucinates `groupBy: 'vendor'` gets told no instead of silently answering something else. There is
no `sql`, no `expression`, no `field` — the measure is fixed at the check amount, and every filter is a
typed column of `Check`, not a name the model supplies.

The prompt names the closed lists (`max|min|avg|sum|count`), the extract window, and the fields. It
never sees rows, never sees a total, and never sees a sample of the data that would let it guess an
answer — so it has no route to a number even if it wanted one.

### 4. Execution — over the rows the page is showing

`server/src/ai/run.ts`, pure functions over `Check[]`, no database.

**4.1 The population is derived, not requested.** The page's scope is a *join*: a check is in scope
when an invoice it paid has an account whose segments fall in Fund 04 / program 861-863. The server
reproduces that join from `data/oracle/checks.json` + `data/oracle/invoices.json` (both reachable via
`REPO_ROOT`, the pattern `server/src/routes/extract.ts:430` already uses for `FROZEN_FILE`), and takes
`fund` + `programs` as **validated** request params rather than a check-id list from the client. A
client-supplied id list would let the caller define the answer's basis; the server's own resolution
means the basis line *is* a measurement.

```
invoices.json   Table1 126 invoices · Table2 117 invoice→check links · Table3 184 accounts (IN_SCOPE)
rule            check.id in scope  ⟺  ∃ invoice i, ∃ link (i → check), ∃ account a of i with IN_SCOPE
result          65 of 4,218 checks   ← asserted in the smoke suite, see §7
```

**★ This is the second copy of a rule that lives in `app/src/data/scope.ts`, and repo memory already
records what happens to a hand-copy: it drifts silently and the comment saying "keep in step" does
nothing.** So the copy is not allowed to be a copy in the sense that matters — a gate must read both
oracles and assert they agree (§7.2). The server may own the rule or the client may, but exactly one of
them may be free to change alone.

**4.2 Dates.** "July" is resolved by the model into `2026-07-01 .. 2026-07-31`, and then **validated
against the extract's own window**. A range outside `2026-07-01 .. 2026-08-11` is not answered from
empty data — it is refused in words that name the window:

> The extract covers 2026-07-01 to 2026-08-11. There is no data for July 2025.

This matters because the natural wrong answer (zero rows, "no checks found") is *indistinguishable
from a real empty month*, which is exactly the class of silent wrongness this codebase has been
fixing elsewhere.

**4.3 The subject, and why `invoice` is out of v1.** "How many invoices did we pay in July" and "how
many checks did we issue in July" have answers that differ by an order of magnitude and neither is
wrong. Worse, a check's invoices **do not always sum to it** — the page itself reports 100.0% scoped
but the extract notes 4,140 of 4,218 unscoped with all 78 discrepancies falling short. So v1 answers
`subject: 'check'` only, and an invoice-subject question refuses with a sentence that says why and
points at `/spend/invoices`. Turning on a reconciliation statement without its population is precisely
the failure that produced the row `Difference — invoices no check reached` elsewhere in this app.

**4.4 Identity.** Filtering by check number matches `Check.number` (the human-facing value); every
sample row and every link carries **both** `number` and `id`. The extract happens to hold 4,218
distinct `CHECK_NUMBER`s, but `app/src/data/checks.ts` is explicit that `CHECK_NUMBER` is not unique
across the ledger and `CHECK_ID` is the identity — so nothing may be keyed on the number.

### 5. The sentence — authored from figures, not from prose

The payload is **structured figures only**; the **client** renders the sentence with the app's own
`money` / `num` / `pluralise` from `app/src/data/format`. That keeps one formatter in the project
instead of two, and it means the sentence cannot disagree with the numbers beside it because the
numbers *are* its inputs.

```
"The highest check paid in July was $778,481.55 — check 63409 to PERFECTION EQUIPMENT CO. on 2026-07-21."
[View check 63409 →]     ← ?check=63409, the page's existing arrival; opens the drawer
basis: 22 of 65 checks in scope · checks.json · 2026-07-01 .. 2026-08-11 · extract of 2026-08-11
```

The optional model-written lead-in (`AI_PHRASE=1`) is prose **without digits**: a returned `note` is
rejected and dropped if it matches `/\d/`, logged, and the figures line still renders. A phrasing call
must not be able to disagree with the arithmetic, and the cheapest way to guarantee that is to forbid
it from producing a character it would need in order to disagree.

### 6. Disclosures — unconditional, and two bases kept apart

Every answer carries, and the UI always renders, even when the scope removed nothing:

| Field | Example | Rule |
|---|---|---|
| `basis.considered` | `22` | **Measured** over the payload — never restated from the scope control. |
| `basis.total` | `4,218` | The register before the scope. Rendered as "22 of 4,218". |
| `basis.window` | `2026-07-01 .. 2026-08-11` | The extract's own bounds, read from the file, not from the request. |
| `basis.source` | `checks.json` | Which artefact answered. One fiscal year; not live Oracle. |
| `basis.scopeLabel` | `Fund 04 · program 861/862/863` | The **arrival's** scope, compared against the answer's, never against empty. |
| `basis.matched` | `22` | Rows the *filters* kept, which is not the same as `considered` — the table already states its scope, so the answer must state its own. |

A disclosure gated on "did this cost anything" renders in exactly the case it is not needed. Here it
renders always, and only the *count* is conditional.

### 7. Configuration

`server/src/config/env.ts` — a new `ai: aiConfig()` block, mirroring `viewBuilderConfig()` (the
existing precedent for a feature-gated sub-config), and added to the `Config` interface next to
`viewBuilder`.

```ts
export interface AiConfig {
  enabled: boolean;              // AI_ENABLED, default false — opt in, like VIEW_BUILDER_ENABLED
  model: string | undefined;     // AI_MODEL      — e.g. gpt-4o-mini / llama3.1 / mistral-small
  endpoint: string | undefined;  // AI_ENDPOINT   — OpenAI-compatible base, no trailing slash
  apiKey: string | undefined;    // AI_API_KEY    — server-side only; NEVER VITE_-prefixed
  authStyle: 'bearer' | 'api-key' | 'none';   // AI_AUTH_STYLE, default 'bearer'
  apiVersion: string | undefined;             // AI_API_VERSION — Azure OpenAI only
  timeoutMs: number;             // AI_TIMEOUT_MS, default 8000
  sampleRows: number;            // AI_SAMPLE_ROWS, default 20
  phrase: boolean;               // AI_PHRASE, default false
}
```

`enabled` is derived **and** defaulted off, in the same spirit as `VIEW_BUILDER_ENABLED`: `enabled` is
`bool('AI_ENABLED', false)`, and `aiConfig()` additionally reports `enabled: false` when any of
model/endpoint/key is missing for the chosen auth style — with the *reason* available for the status
route. A capability that spends money and calls a third party should have to be asked for by an
operator who has read the section, not inherited by anyone who starts the server.

`authStyle` exists because the three settings the user asked for are not quite enough for every
provider, and saying so in the config is more honest than failing at the first call: OpenAI, Groq and
LM Studio take `Authorization: Bearer`; **Azure OpenAI** takes an `api-key` header *and* an
`?api-version=` query parameter; **Ollama** takes no key at all, which is why `AI_API_KEY=` blank is
legal when `authStyle=none`.

`AI_ENDPOINT` and `AI_API_KEY` are **never** `VITE_`-prefixed. Vite inlines every `VITE_*` variable
into the browser bundle, so a prefixed key is a key published to every visitor of the page.

**The checks data is JSON, not the database.** This endpoint reads `data/oracle/*.json` and never
touches `db` or `appDb`, so `DB_MODE` is irrelevant to it and it is fully testable with `DB_MODE=local`
— worth stating, because a reader will otherwise assume the active `DB_MODE=turso` is in the path.

### 8. Failure modes, each with a decided behaviour

| Failure | Behaviour |
|---|---|
| No key / `AI_ENABLED=0` | `GET /api/ai/status` → `{ enabled: false, reason }`; icon `disabled` with a `title`; `POST /api/ai/ask` → **503 `AI_UNAVAILABLE`** (new `ErrorCode`), the route still mounted and documented. A vanished route would make the spec disagree with the server; a 404 would read as a client typo. |
| Model unreachable / timeout | `AI_UNAVAILABLE` with the upstream message in `details`; the abort fires at `AI_TIMEOUT_MS`. Never a hang. |
| Model returns malformed JSON, or an intent the schema rejects | **400 `BAD_REQUEST`**, with the rejected intent in `details` so it is diagnosable. This is a *layered* distinction the codebase already makes: `VALIDATION_FAILED` is the request's shape, `BAD_REQUEST` is a handler lookup — and a model's output is a lookup, not a request. |
| Intent says `supported: false` | 200 with `{ refused: reason }` and the kinds of question that *are* answerable. Reading a refusal is a normal outcome, not an error. |
| Filters keep zero rows | 200 with `matched: 0`, an explicit "no checks matched — basis …" and **no model-authored guess**. |
| Question longer than `400` chars, or empty | `VALIDATION_FAILED` before the handler (matching the framework's ordering). |
| A returned `note` contains a digit | `note` dropped, logged, answer still rendered. |
| Same question asked twice | Same figures, bit for bit. The model may vary; the reduction may not. |

### 9. What this deliberately does not do

No SQL generation. No free-form query language. No cross-register joins — the checks↔purchase-order
link is absent from this source and lives on another plan. No invoice-subject questions in v1. No
writes, no streaming, no per-row narration, no multi-turn context: each question is answered from
scratch over the same rows, and the conversation history is the table itself.

---

## Verification

**1. Controls that must FAIL.** The rule is that a harness reporting only passes is unverified. Three
deliberate failures ship with the suite: an empty question (`VALIDATION_FAILED`); an intent carrying an
unknown field (`BAD_REQUEST`, proving `.strict()` bites); and `AI_ENDPOINT` pointed at a black hole,
which must produce `AI_UNAVAILABLE` **within `AI_TIMEOUT_MS`** — a hang there is the bug.

**2. Real fields out of the payload, never `status !== 404`.** A reachability probe cannot tell a
working route from a 500, and this repo has three endpoints that were dead on arrival with a green
suite to prove it. So:

```
"highest check paid in July"  →  rows.sample[0].number === 63409
                                 value === 778481.55
                                 rows.sample[0].vendor === 'PERFECTION EQUIPMENT CO.'
                                 basis.considered === 22
```

**3. The population gate, with the interpretation in the message.** Assert the server's derived scope
gives **65** checks and a whole-window maximum of **`2068881.16` / `44407395`** — both of which the
page's own stat strip prints — and assert that the **unscoped** July maximum is **`18043056.47`**, so
the two populations provably differ. That second assertion is a no-op if the scope join ever breaks,
so its message must say what it means if it starts passing: *"if these two agree, the scope join has
stopped narrowing and every answer is being computed over the wrong register."*

**4. Determinism.** Run one question twice and assert identical figures, and assert the model was
never given a number it could echo: no digit appears in the outbound intent prompt template that is
not a schema constant or a bound read from the extract itself.

**5. Client.** `npm run typecheck` and `npm run build` in `app/`; `npm run typecheck` in `server/`.
Then an embedded-browser pass using the staged-token recipe — **poll, never sleep** (this page's
fan-out ran 8-19 s once already): click `.chkfilter__ai` via `dispatchEvent('click')`, type the
question, and assert the `.sr` live region and the `.chkanswer` block against the polled DOM, then
assert the basis line reads *22 of 4,218*. Check the brain's contrast in both themes at 12 px, and
confirm the magnifier rule was narrowed to `> svg` by clicking the input's left `29px` and getting the
**input** focused, not the icon.

**Baselines not to regress:** `server` `npm run smoke` — 117/117 `DB_MODE=local`, 67/103
`DB_MODE=oracle`; `node scripts/verify-turso-sample.mjs` — 22/22; `node scripts/turso-run.mjs --quiet`
— 56/56 (clear `LOCAL_DB_PATH` first). With no key configured the AI checks must report **SKIP with
the reason printed**, not a silent green.

---

## Build order

1. `server/src/config/env.ts` — the `ai` block + `.env` placeholders. Nothing else depends on a key existing.
2. `server/src/ai/intent.ts` — the allowlist schema, with the control cases as unit assertions.
3. `server/src/ai/scope.ts` — the derived population, plus the gate of §7.2 that pins it to the page's numbers.
4. `server/src/ai/run.ts` — the reductions. Fully testable with no model at all, which is the point.
5. `server/src/routes/ai.ts` + registration in `apiRouter()` — **called explicitly**, and guarded on
   `registeredResources().length === 0`, because a registry populated by a factory call reads empty if
   you only import the module.
6. The Check page control, then the answer block, then the optional phrasing call.
