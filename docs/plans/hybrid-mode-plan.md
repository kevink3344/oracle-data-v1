# Hybrid mode — Oracle for reads, Turso for the app's own metadata

| | |
|---|---|
| **Status** | Agreed. Implementation in progress |
| **Purpose** | Serve every read-only EBS table from Oracle, and the app's own metadata from Turso, from one process |
| **Scope** | `DB_MODE=hybrid`, the driver seam (`server/src/db/`), the derived views, and the write policy |
| **Supersedes** | The "repoint every table at Oracle" shape of `oracle-project-tracker-plan.md` §7 |
| **Grounded in** | The live Oracle 19c probes recorded in §7, the 36 tables in [`00-schema.sql`](../../data/sql/turso/00-schema.sql), and `oracle-project-tracker-plan.md` §"Writing back to Oracle" — *"Extract is read-only. The app is a read model plus its own metadata."* |

This document is the design for a mode the project already described but had not
built. `oracle-project-tracker-plan.md` line 60 says the app *is* a read model
plus its own metadata; `view-builder.md` §5.4 notes the app's only persistence
today is `localStorage`. Hybrid is that sentence made executable.

---

## 1. The decisions

Three questions gate the whole design. All three are now answered.

| # | Question | Decision |
|---|---|---|
| **D1** | Where do `V_ACCOUNT_POSITION`, `V_BUDGET_BY_ACCOUNT_PERIOD`, `V_SEGMENT_LEGEND` live? | **Inlined as subqueries in the app's SQL.** No DBA dependency, data stays live from Oracle. See §4. |
| **D2** | What happens to writes against EBS-owned tables? | **Those endpoints are not registered in hybrid mode.** Not refused at runtime — absent. See §5. |
| **D3** | Which modes must keep working? | **`hybrid`, `oracle`, `turso`.** `local` is retiring; it is left working but is out of the verification matrix. |

---

## 2. The ownership registry

The registry is an **explicit allowlist**. A name that is not in it is a **hard
error**, never a guess — a mis-routed read is a wrong answer that looks right,
which is the one failure this design must not have.

| Class | Store | Members |
|---|---|---|
| **EBS** | Oracle | The 33 DBA-listed tables, resolving via `APPS` synonyms to `owner.TABLE#` — `GL_LEDGERS`, `GL_PERIODS`, `GL_BALANCES`, `GL_CODE_COMBINATIONS`, `GL_BUDGET_TYPES`/`_VERSIONS`/`_ENTITIES`/`_ASSIGNMENTS`, `GL_JE_HEADERS`/`_LINES`, `GL_LOOKUPS`, `FND_CURRENCIES`, `FND_ID_FLEX_STRUCTURES`/`_SEGMENTS`, `FND_FLEX_VALUES`, `FND_FLEX_VALUES_TL`, `PO_VENDORS`, `PO_VENDOR_SITES_ALL`, `PO_AGENTS`, `PO_LINE_TYPES`, `PO_HEADERS_ALL`, `PO_LINES_ALL`, `PO_LINE_LOCATIONS_ALL`, `PO_DISTRIBUTIONS_ALL`, `PO_LOOKUP_CODES`, `PA_PROJECTS_ALL`, `PA_TASKS`, `PA_BUDGET_VERSIONS`, `PA_BUDGET_LINES`, plus `DUAL` |
| **DERIVED** | Oracle, inlined | The three views, as subqueries — §4 |
| **APP** | Turso | `X_REPORT_PROJECT_FACTS`, `X_REPORT_FUNDING_LINES`, `SAMPLE_DATA_PROVENANCE`, and the `saved_view*` tables planned in `view-builder.md` §6.2 |
| **INTROSPECTION** | Turso | `sqlite_master`, `pragma_table_info(*)` |

**★ Introspection is the reason the Turso database keeps the full DDL.** `meta.ts`
and `relations.ts` read `sqlite_master` and `pragma_table_info` to build the data
dictionary and the relationship graph. Those are Turso reads, and they are
correct — in hybrid mode the Turso database is the **schema mirror plus the
app's metadata**, not a data store. That is why `00-schema.sql`'s 36 tables stay
even though their rows come from Oracle: the *schema* is metadata, the *data* is
EBS. `relations.ts`'s foreign-key graph is therefore the logical schema, which is
what it was always documenting.

---

## 3. Routing rule

**Routing is per statement, never per query-plan.** One statement may only touch
one store.

```
statement → collect every table name it references (FROM / JOIN / DML target)
          → map each through the registry
          → all one store        → that store's driver
          → mixed                → throw at statement time, naming both sides
          → an unregistered name → throw, naming the name
```

**Why per statement is enough — measured, not assumed.** The one place the app
could have needed a cross-store join already avoids one. `projects.ts:414–480`
issues the EBS counts and the `X_*` counts as **two separate statements** and
does the identity arithmetic in TypeScript, with the reason written down:

> *"Read the facts once into a map, then evaluate the identities in TypeScript
> rather than as correlated subqueries."*

`funding.ts:935–955` and `procurement.ts:688–693` are likewise single-store sets
of correlated scalar subqueries. So there is **no statement in the codebase that
mixes an EBS table with an app-owned one**, and hybrid needs no SQLite-on-Oracle
virtualization. The rule exists to keep it that way as the code grows.

`funding.ts:968` joins `V_BUDGET_BY_ACCOUNT_PERIOD` to `GL_BUDGET_TYPES`. Under
D1 both sides inline to EBS tables, so this stays a single Oracle statement —
which is the specific reason D1 is the choice that avoids a rewrite.

---

## 4. The derived views

Moved from `00-schema.sql` §6 into a module, `server/src/db/derived.ts`, as
portable `SELECT` fragments used as subqueries:

```sql
-- before, a view that only exists in the sample database
FROM V_ACCOUNT_POSITION
-- after, one text for every mode
FROM (<V_ACCOUNT_POSITION_SQL>) position
```

Three changes to the bodies on the way:

1. **`IFNULL(x, 0)` → `COALESCE(x, 0)`.** Measured: Oracle answers `ORA-00904:
   "IFNULL": invalid identifier`. Seven occurrences — five in `V_ACCOUNT_POSITION`,
   two in `V_ENCUMBRANCE_FROM_PO`. `COALESCE` is valid on both engines.
2. **`ROWNUM` is not used** in any body, which is expected — there is no
   `LIMIT` in a set-returning view body.
3. **`V_ENCUMBRANCE_FROM_PO` and `V_CODE_COMBINATION_KEY` are not ported.** No
   route references either (`V_CODE_COMBINATION_KEY` appears only in doc prose at
   `coa.ts:21,962`). They are listed in §6 as deliberately unconverted.

The `||` concatenation in `V_ACCOUNT_POSITION`'s `BUDGET_ACCOUNT` is already
valid Oracle and valid SQLite, so it stays.

**★ Drift is the risk this decision buys.** The bodies now exist twice — once as
a Turso `CREATE VIEW` in `00-schema.sql`, once as a fragment here. A smoke
assertion compares the two column-name lists and fails on divergence, so the
duplication is checked rather than trusted.

---

## 5. Write policy

**In hybrid mode a resource is writable only if its table routes to Turso.**
Applied where the routes are registered, not per request:

```ts
const writable = d.writes !== undefined && storeForTable(d.table) === 'turso';
```

That is the whole rule, and it derives the outcome without a hand-maintained
list. Applied to today's descriptors it disables writes on 18 resources and
leaves exactly two standing:

| Keeps writes (Turso) | Loses writes in hybrid (EBS → Oracle) |
|---|---|
| `projectFacts` — `X_REPORT_PROJECT_FACTS`<br>`projectFundingLines` — `X_REPORT_FUNDING_LINES` | `coa.ts`: ledgers, currencies, codeCombinations<br>`funding.ts`: budgetTypes, budgetVersions, budgetEntities, journalHeaders, projectBudgetVersions<br>`procurement.ts`: purchaseOrders, purchaseOrderLines, purchaseOrderShipments, purchaseOrderDistributions, agents, lineTypes<br>`projects.ts`: projectMaster, projectTasks<br>`vendors.ts`: vendors, vendorSites |

**Why disabled rather than refused.** Oracle holds a `SELECT`-only grant (51 of
51 privileges) and cannot accept a write. A refused write at least tells the
caller; a *silently accepted* one is worse than either, because a write landing
in Turso against a table read from Oracle returns `201` and then never appears in
any subsequent read. Removing the route makes the endpoint's absence visible in
the OpenAPI document, which is where a client looks before calling.

The two surviving writes are the honest shape of the architecture: the app's own
transcribed report data is the only thing it may author.

---

## 6. Driver changes

The router lives **inside the driver**, because `sql.ts:19-23` states the seam
exists so a backend change is *"a change in one factory rather than in every
route"*. `sql.ts` and every route are therefore untouched by hybrid.

| Change | Where | Why |
|---|---|---|
| `LIMIT :limit OFFSET :offset` → `OFFSET :offset ROWS FETCH NEXT :limit ROWS ONLY` | Oracle driver | Measured `ORA-00933`. Named binds survive reordering, so the rewrite is textual and safe. Covers `resource.ts:200`. |
| literal `LIMIT n` → `FETCH FIRST n ROWS ONLY` | Oracle driver | Measured. Covers `coa.ts:777,897,1003`, `procurement.ts:720`. |
| `?` → `:n` | already present | Unchanged |
| `fetchTypeHandler` for `DB_TYPE_DATE` → `STRING` | already present | §7 |
| `probe()` — cumulative readiness across both pools | new, optional on the interface | `/api/health` must not report one store's health as the whole answer |

`dialect` is currently declared on `SqlDriver` and **read by nothing**, so
extending it costs no call sites. `withTransaction` likewise **has no callers**
(`oracle.ts:412` says so), so hybrid's `transaction()` routes to Turso and needs
no SQLite-on-Oracle equivalent.

---

## 7. Measured Oracle behaviour the design depends on

Every row below was run against `europa.wcpss.net:1541/ebs_FA2DB`, not inferred.

| Construct | Result | Consequence |
|---|---|---|
| `LIMIT 1` | `ORA-00933` | driver rewrite, §6 |
| `IFNULL` | `ORA-00904` | `COALESCE`, §4 |
| `(1 IS NULL)` / `ORDER BY (x IS NULL)` | `ORA-00907` | `CASE WHEN` / `NULLS LAST` |
| quoted alias + **unquoted** `ORDER BY` naming it | `ORA-00904` | quote both places, §8 |
| unquoted alias | property arrives **uppercased** | ~60 lowercase aliases must be quoted |
| `ORDER BY <alias>`, `ORDER BY 1` | works | — |
| `\|\|`, `COUNT(DISTINCT x)`, `:bind`, `LIKE … ESCAPE` | works | — |
| `WHERE ROWNUM <= n` **before** an aggregate | filters first — `COUNT(*)` returned `50` of 288,054 with no error | never bound a count this way |
| DATE as JS `Date` | encodes the **client's** wall clock; `toISOString()` wrong ~0.55% of rows | `fetchTypeHandler` + `NLS_DATE_FORMAT='YYYY-MM-DD'` |
| `fetchAsString=[DATE]` | `NJS-021` — the `DATE` constant is `DB_TYPE_TIMESTAMP` (2012), and it rejects `DB_TYPE_DATE` (2011) | cannot stringify a DATE this way |
| `sessionCallback` | **callback-style only** | an `async` callback hangs the pool → `NJS-040` |

**Alias quoting is the largest mechanical task.** ~60 aliases are read back as
lowercase JS properties across `coa.ts`, `funding.ts`, `procurement.ts`,
`projects.ts`, `relations.ts`, `meta.ts`, `vendors.ts`, `client.ts`, `sql.ts`.
Each needs quoting **and** every `ORDER BY` that names it. Genuine bare-column
reads (`order.VENDOR_ID`, `order.AGENT_ID` in `procurement.ts`) already match
Oracle and must be left alone.

---

## 8. Known risks

| Risk | Detail | Response |
|---|---|---|
| **★★ The derived views have never run against real `GL_BALANCES`** | Their bodies aggregate *all* of `GL_BALANCES` filtered only by `ACTUAL_FLAG`/`TRANSLATED_FLAG`. That table's Oracle row count was **never measured** — the probe exceeded a 25 s budget on all four GL tables. The sample has 31 rows. | **Measure before building.** Bounded probe of `GL_BALANCES` size and one timed `V_ACCOUNT_POSITION` subquery. If it does not return in seconds the views need a narrower predicate, and that is a design change, not a tuning task. |
| **Alias quoting done by find-and-replace** | A missed alias returns `undefined` where a number was read, which serializes as `null` rather than failing | Quote from the measured inventory; then compare each endpoint's response shape before and after |
| **`FND_FLEX_VALUES_TL` existence unconfirmed** | Referenced by `coa.ts:535`; not among the names confirmed live | Fails as `ORA-00942` on first call — the registry's hard-error default surfaces it rather than hiding it |
| **`GL_BUDGET_TYPES.BUDGET_TYPE_CODE`** | Probed `ORA-00904: "BT"."BUDGET_TYPE_CODE": invalid identifier`; `V_ACCOUNT_POSITION`'s body joins this column | Must be resolved before the view is ported, or the body is unbuildable |
| **`PA_PROJECTS_ALL` returns 0 rows** | Measured | Reported honestly as 0; a DBA question, not a bug |
| **`WE8ISO8859P1`** | Single-byte charset — non-Latin1 names would be mangled | DBA question |
| **Turso drift from the inline fragments** | §4 | Column-name comparison in smoke |

---

## 9. Build order

Each step is independently verifiable, and the order is chosen so the expensive
unknowns come first.

| # | Step | Gate |
|---|---|---|
| 1 | **Measure `GL_BALANCES` on Oracle** and time one derived-view subquery | §8 risk closed or the view bodies redesigned |
| 2 | Correct `types/oracledb.d.ts` — 4 wrong declarations, 8 missing | `tsc -b --force` clean |
| 3 | `derived.ts` — the three bodies, `IFNULL`→`COALESCE` | Fragment returns the same column names as the Turso view |
| 4 | `store.ts` — registry, statement table-collector, `storeForTable()` | Unknown name throws; a mixed statement throws |
| 5 | Oracle driver `LIMIT` rewrites | Both forms measured green on the live DB |
| 6 | `hybrid.ts` — composite driver; `client.ts` lazy dual resolution; `env.ts` `hybrid` validating **both** credential sets | `/api/health` truthful for both stores |
| 7 | Replace `V_*` uses with fragments; quote aliases | `turso` mode still returns identical payloads |
| 8 | Gate `resource.ts` writes on `storeForTable` | OpenAPI in hybrid omits the 18 write paths |
| 9 | `projects.ts` / `smoke.ts` `EXP_PROJECT_NAME` → `ATTRIBUTE3` (`ATTRIBUTE4` for the PO number) | `po_named` = **2,626** |
| 10 | Verify | §10 |

**Do not proceed past step 1 on an assumption.** Steps 3–7 all touch the derived
views or the tables they read, so their cost is decided by step 1's answer.

---

## 10. Verification

A clean build is not evidence. The gates, in order:

1. `npx tsc -b --force` → `npm run build`
2. `grep -r WCSEXP server/dist` → **empty**
3. `npm run smoke` — 47 checks, plus the new registry and drift assertions
4. **`turso` mode**: `node scripts/verify-turso-sample.mjs` → 21/21, and the
   `V_*` endpoints return the same payloads as before the fragment swap
5. **`hybrid` mode**: live against `europa` — one EBS list endpoint, one `X_*`
   endpoint, `/api/health`, and one attempt to reach a disabled write path
   expecting **404**
6. `storeForTable` on every name in the registry, asserting the Oracle set and
   the Turso set are disjoint and together cover the registry

---

## 11. Open items for the DBA

Revised now that D1 removes the biggest ask. The `CREATE VIEW` question is
withdrawn — the views are inlined instead.

1. **`GL_BUDGET_TYPES.BUDGET_TYPE_CODE`** — what is the real column name? The
   live probe returned `ORA-00904: "BT"."BUDGET_TYPE_CODE": invalid identifier`.
   `V_ACCOUNT_POSITION` cannot be ported until this is known.
2. **Column-level grants.** The retired `WCSEXP_*` views exposed about 13 of
   `GL_CODE_COMBINATIONS`'s 112 columns. A table grant is not a column grant —
   confirm every column the new SQL reads is covered, including
   `PO_HEADERS_ALL.ATTRIBUTE3` / `ATTRIBUTE4`.
3. **`EXP_PROJECT_NAME` / `EXP_PO_NUMBER` = `ATTRIBUTE3` / `ATTRIBUTE4`** —
   confirm these are the live DFF positions. Probed: `ATTRIBUTE3 IS NOT NULL` →
   2,626 rows, `ATTRIBUTE4 IS NOT NULL` → 2,224.
4. **`CURRENT_SCHEMA`** — is `ALTER SESSION SET CURRENT_SCHEMA = APPS` the
   sanctioned access path, or should every table be `APPS.`-qualified?
5. **DATE handling** — `fetchAsString` cannot stringify a DATE column. Is
   driver-side `fetchTypeHandler` plus `NLS_DATE_FORMAT='YYYY-MM-DD'` acceptable?
6. **`GL_BALANCES` scale and index** — row count, and whether the
   `ACTUAL_FLAG`/`LEDGER_ID` predicates are indexed. Decides §8's top risk.
7. **`PA_PROJECTS_ALL` returned 0 rows** — is the PA module populated here, or is
   this the wrong environment for it?
8. **`WE8ISO8859P1`** — confirm the single-byte charset is expected.
9. **Is write access ever coming?** If `SELECT`-only is permanent, Turso is the
   only store that can ever hold an authored row, and §5 is the final shape
   rather than a phase.
