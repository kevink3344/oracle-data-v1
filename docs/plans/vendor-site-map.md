# Vendor site pins — a Mapbox map on the register, and the driving distance from Raleigh

## What was asked

> I need a plan for integrating a map into the Vendor sites. First, I need a new table to store the
> Latitude/Longitude location for all Vendor sites in Turso. Then I will use that along with my Mapbox API
> key to generate the map, and mark the driving distance from Raleigh.

…and, on the one open question this raised:

> We can use the Mapbox API to get the geocode if needed.

**This is a plan, not an implementation.** Nothing has been built. No app file, and no `.sql` file, has been
touched. The two throwaway probes under `server/tmp-geocode-*.mjs` are the only files written, and they exist
so the numbers below can be re-run rather than believed.

Every figure comes from production Oracle (`POWERAPPS@europa.wcpss.net:1541/ebs_FA2DB`) or from a live call to
the Mapbox APIs **using the key already in `.env`**. Every Mapbox run carried controls that must fail, and
**one of them failed in a way that reshaped the design** — see *The measurement* §2. That is the most
important section of this document.

---

## The answer in one line

**The table is cheap and the map is the easy half; the whole design turns on the fact that Mapbox will
happily return a confident pin for an address that does not exist.** Asked to geocode `zzzqqq 99999,
Nowhere, NC`, the Geocoding API returned **HTTP 200** with a real coordinate in **Sanford, North Carolina** —
it fell back to geocoding the *place name*. Asked to geocode a **PO box**, it returned a **street called
"Ranleigh Court" in a different ZIP code**. There is no status code, no error, and no null: a request that
must fail silently produces a pin, and a pin drawn on a map is indistinguishable from a correct one. The
single fact that makes this feature safe is that adding one parameter — `types=address` — makes the API
**refuse both** while returning the two real addresses byte-identically. That is verified in §2, in three
shapes, with the good addresses as controls. Everything else here is ordinary.

**The store.** A new app-owned table `vendor_site_geo` in `data/sql/turso/01-app.sql`, keyed on
`VENDOR_SITE_ID`, registered in **three** lists (`01-app.sql`, `app-schema.ts:91`, `store.ts:195`). Under
`DB_MODE=oracle` the app store resolves to a **local libSQL file**, not Oracle and not Turso — so unless
`APP_DB_URL` is pointed at the Turso database, the pins land in one machine's file. That is a decision to make
explicitly, and it is Decision 1.

**The licence question is settled, and it went the good way.** Mapbox only permits *storing* geocoding results
if the request says `permanent=true`, which ordinarily requires a credit card on file. `permanent=true`
**returned HTTP 200, identical coordinates, on this key** — so the requested table is legitimate. It also has
its own free tier: **250,000 permanent geocode requests and 100,000 Matrix elements a month**, against a job
that needs **653 requests and 800 elements**.

---

## The measurement

Two throwaway probes, run against the live APIs with the key from `.env`:

| File | What it answers |
|---|---|
| `server/tmp-geocode-probe.mjs` | token validity, structured input, `permanent=true`, the address shapes the register actually holds, batch, Matrix |
| `server/tmp-geocode-guard.mjs` | which guard actually refuses a non-address result — the question §2 raised |

### 1. The register is 800 sites, and 789 of them have a distinct address

Measured on Oracle through the register's own scope predicate (fund `04`, programs `861`/`862`/`863`, fiscal
floor `2021-07-01`):

```
800 sites · 715 vendors · 5,692 in-scope orders · 31,401 lines · $2,797,825,956.73
     active 761 · deprecated 39
```

Address coverage across those 800:

| | count | |
|---|---|---|
| no `ADDRESS_LINE1` | 0 | |
| no `CITY` | 0 | |
| no `STATE` | **2** | both Canadian (`Vancouver BC`) |
| no `ZIP` | 0 | |
| **distinct addresses** | **789** | so 11 sites share an address with another site |
| United States | 795 | |
| outside the US | **3** | `Rossland BC`, `Rexdale ON`, plus one of the two above |
| ZIP that is not 5 digits | **6** | e.g. `900023` |
| **`PO Box` in line 1** | **136** | |
| **resolves to a street address** | **≤ 653** | 789 distinct − 136 PO boxes |

State histogram, top 15: `NC 431`, `NY 29`, `TX 29`, `IL 28`, `CA 27`, `GA 19`, `OH 18`, `WI 17`, `SC 16`,
`VA 14`, `NJ 13`, `MA 12`, `AZ 11`, `PA 11`, `FL 11`.

**789 distinct addresses is the number that matters, not 800.** The job geocodes each distinct address once and
writes the result to every site that carries it; writing 800 lookups for 789 answers is 11 wasted requests and,
worse, 11 chances for two sites holding the same address to disagree.

★ **`ADDRESS_LINE1` is not actually a street address on every row.** Oracle shops leave the postal line there,
and this register does it 136 times. A PO box has no rooftop, has no driveway, and — measured in §2 — makes the
geocoder answer with a *street*.

The directory is a different and much larger job, and this plan is not about it: `PO_VENDOR_SITES_ALL` holds
**99,316 sites across 79,590 vendors — 57,834 distinct addresses, 39,173 of which are missing at least one
address field**. See Decision 11.

### 2. ★★ The control failed, and that failure is the whole design

A probe that asserts "this works" is worthless without a control that must fail. This one had two, and
**the second did not fail**:

```
=== 0. CONTROLS (these MUST fail or return nothing) ===
dead token            : HTTP 401 — Not Authorized - Invalid Token
nonsense address      : HTTP 200 — "Nowhere" | -79.13054,35.34460 | accuracy=undefined | confidence=undefined
                                     | Sanford, North Carolina 27332, United States
```

The dead-token control behaved. The nonsense-address control was asked for `zzzqqq 99999` in a place called
`Nowhere` and returned **a real point in Sanford, NC, at HTTP 200, with no error of any kind** — because
Mapbox quietly fell back to geocoding the *place name* `Nowhere` and answered (`Nowhere` is an unincorporated
community in North Carolina, or the fallback matched the region `NC`; either way, the coordinate is not the
address and nothing says so).

The same thing happened to a shape the register contains **136 times**:

```
PO box (136 sites)    : HTTP 200 — "Ranleigh Court" | -78.74617,35.92846 | accuracy=undefined | confidence=undefined
                                     | Raleigh, North Carolina 27613, United States
```

`PO Box 9002, Raleigh, NC 27675` was answered with a **street named "Ranleigh Court", in ZIP 27613** — an
eight-mile error in a figure about to be presented as "the site's location". Told to geocode a PO box it
returned a street, and the request succeeded.

**The tell is `accuracy=undefined` and `confidence=undefined`.** A genuine address match carries
`properties.coordinates.accuracy` (`rooftop`/`parcel`/…) and a full `properties.match_code` object; a
non-address feature carries neither. So the response *does* contain the evidence — it is simply not the status
code.

`tmp-geocode-guard.mjs` then asked which guard actually refuses, running the same four inputs — **a good
address and a state-less address as controls that must still succeed, a garbage address and a PO box as the
two that must not**:

```
=== A. NO FILTER (what the first probe did) ===
  good   : ok  35.7527,-78.7368 (rooftop/exact)
  garbage : PINNED but NOT an address — feature_type=street name="Nowhere"
  PO box  : PINNED but NOT an address — feature_type=street name="Ranleigh Court"
  no st   : ok  49.2735,-123.1001 (interpolated/medium)

=== B. types=["address"] — hard filter on the request ===
  good   : ok  35.7527,-78.7368 (rooftop/exact)
  garbage : REFUSED (no feature)
  PO box  : REFUSED (no feature)
  no st   : ok  49.2735,-123.1001 (interpolated/medium)

=== C. batch, types=["address"], limit 1 per item (the real job shape) ===
  good   : ok  35.7527,-78.7368 (rooftop/exact)
  garbage : REFUSED (no feature)
  PO box  : REFUSED (no feature)
  no st   : ok  49.2735,-123.1001 (interpolated/medium)
```

**`types=["address"]` is the guard, it works in the batch endpoint, and it changes nothing about the two
addresses that should succeed** — identical coordinates to five decimal places, identical quality fields. It
is a request-side filter, so it costs nothing and cannot be forgotten on the response side.

★ **The response check is still required as a second line, because `types` is the API's promise, not ours.**
The job asserts `feature_type === 'address'` **and** `coordinates.accuracy` is present before it writes a
latitude. A guard that is only on the request is a guard the next reader can remove without noticing.

### 3. `permanent=true` works — the licence question, settled

Mapbox's terms draw the line this feature cannot ignore:

> Temporary results are not allowed to be cached, while Permanent results are allowed to be cached **and stored
> indefinitely**. […] Temporary results are the default.

Storing latitude and longitude in Turso *is* caching, so the job must ask for permanent results, and the docs
say `permanent=true` "requires that you have a valid credit card on file". The probe asked, and got:

```
=== 2. permanent=true (REQUIRED if we store the result) ===
permanent=true        : HTTP 200 — "110 Corning Road" | -78.73677,35.75265 | accuracy=rooftop | confidence=exact

=== RESULT ===
permanent geocoding : ALLOWED — results may be stored
billing guard       : 1000 req/min
```

**Identical response, one extra parameter.** So the table the request asks for is legitimate — but the
permission is granted per request, not per account, and a run that forgets the parameter produces rows that
are *not* allowed to be in the database. That is why the table stores a `permanent` column (Decision 3): the
licence becomes a fact on the row rather than a property of code somebody might edit later.

★ **Permanent results carry their own restriction**, from the pricing page: *"Results from the Permanent
Geocoding API are only available for your own personal or business use, and **cannot be used for distribution
or sublicense**."* Pins inside this app are fine. An export that hands someone the coordinate set is a
decision, not a display choice — see Decision 9.

### 4. What every shape in the register actually does

Run against addresses in the *shapes the register contains*, not against clean ones:

| Input | Result | Reading |
|---|---|---|
| `110 Corning Road, Cary NC 27518` | `rooftop` / `exact`, all six `match_code` components `matched` | the normal case is excellent |
| `1250 Homer Street, Vancouver BC` | `rooftop` / `exact` | non-US works when `country=ca` |
| `1234 Main Street, Vancouver` (**no state**) | `interpolated` / `medium` | ★ **the 2 no-state sites geocode anyway**, at visibly lower quality |
| same, but `region=CANADA` (the value in `STATE`) | `rooftop` / **`medium`** | ★ a **bogus region value does not fail** — it silently drops confidence from `exact` to `medium` and returns the *same* coordinate. `confidence` is the field that catches it. |
| `1000 Wilshire Blvd, Los Angeles, **900023**` | `parcel` / `high`, corrected to `90017` | ★ all **6** malformed ZIPs are recoverable, and the quality field records the correction |
| `PO Box 9002, Raleigh NC 27675` | **refused** under `types=address` | correct — see Decision 5 |
| garbage | **refused** under `types=address` | correct |

**Two consequences the page must carry.** A site whose `STATE` reads `CANADA` will pin *correctly* while
reporting `medium` confidence, so confidence must be stored and shown rather than used as a pass/fail. And
`accuracy`/`confidence` are the two fields that make a pin honest: `rooftop` is the building, `interpolated`
is a guess along a street, `approximate` is a hint. A map that draws all three the same way is asserting more
than the data says.

### 5. Cost, quota and job size

| | measured / derived | free tier | share |
|---|---|---|---|
| Permanent geocode, register | **653** requests (789 distinct − 136 PO boxes) | 250,000 / month | 0.26 % |
| Permanent geocode, whole directory | **57,834** requests | 250,000 / month | 23 % |
| Matrix elements, register | **800** (1 source × 800 destinations) | 100,000 / month | 0.8 % |
| Mapbox GL JS map loads | 1 per visit to the map view | 50,000 / month | — |
| Geocoding rate limit | **1000 requests/min** per token (measured in the `x-rate-limit-limit` header) | | |
| Matrix rate limit | 60 requests/min | | |
| Batch endpoint | **1000 queries per POST** — 789 addresses is **one request** | | |

The register geocode is **one HTTP POST**. That is worth stating plainly, because it changes the shape of the
job: it is not a queue, not a rate-limited crawl, and it does not need progress reporting. It needs a chunk
loop in case the register grows past 1000 distinct addresses, and nothing else.

★ **Rate limits are counted per access token, not per account.** This token is shared with whatever else uses
it, so a second consumer of the same key competes with this job.

★ A **Commercial Application License** flag sits outside all of the above — see Decision 10.

---

## Design

### 1. The table — `vendor_site_geo`

One row per vendor site, in `data/sql/turso/01-app.sql`, keyed on `VENDOR_SITE_ID`. It stores the pin, what
the pin is worth, where the pin came from, and the driving distance, because the distance is derived from the
pin and a site can only have one.

```sql
CREATE TABLE IF NOT EXISTS vendor_site_geo (
  -- The site, by the identity Oracle already assigns it: `PO_VENDOR_SITES_ALL.VENDOR_SITE_ID`,
  -- the primary key of the vendor-address table. NOT a foreign key — this table lives in the
  -- app store and its subject lives in the ledger (or in the Oracle surrogate, or in neither,
  -- depending on DB_MODE). The app does not own the site row and must not claim to.
  vendor_site_id  INTEGER PRIMARY KEY,

  -- The pin. NULL unless `geocode_status = 'matched'`.
  latitude        REAL,
  longitude       REAL,

  -- ★ WHY A STATUS COLUMN EXISTS AT ALL: ABSENCE IS NOT A RECORD, IT IS A SILENCE.
  --   A missing row means "never attempted". A row with a NULL latitude could mean the site
  --   has no street address, or that the request failed, or that the last run was interrupted —
  --   and those three want three different things done about them. The register already made
  --   this argument for `table_count_snapshot.counted_in`, and it applies here harder, because
  --   the page has to *say* why a site is not on the map:
  --     'matched'  a pin; latitude and longitude are NOT NULL and the quality fields are set.
  --     'no_match' Mapbox answered and the guard refused it. An answer, not a failure.
  --     'po_box'   recognised and never sent — see §4. Also an answer.
  --     'error'    transport, timeout, or a non-200. **Retryable**, and must never be
  --                confused with 'no_match', which is not.
  geocode_status  TEXT    NOT NULL,

  -- The sentence the page shows beside an unmapped site, in words, decided when the row was
  -- written and not reconstructed on the browser. NULL when status is 'matched'.
  geocode_reason  TEXT,

  -- ★ THE QUALITY FIELDS ARE NOT DECORATION. §4 measured a bogus `STATE` value returning the
  --   right coordinate at `medium` instead of `exact`, and a 6-digit ZIP being silently
  --   corrected. Both are invisible without these two columns, and both are worth showing.
  match_confidence TEXT,                       -- exact | high | medium | low
  accuracy         TEXT,                       -- rooftop | parcel | point | interpolated | approximate | intersection
  feature_type     TEXT,                       -- asserted = 'address' before any write. See §4.

  -- Mapbox's stable identifier for the matched feature, so a later question about this pin can
  -- be asked of Mapbox without re-geocoding.
  mapbox_id        TEXT,

  -- What was sent. Kept because it is the only way to reproduce a pin, because the register's
  -- numbers must be reproducible, and because the *address can change* in Oracle afterwards.
  query_address    TEXT,

  -- ★ ADDRESS DRIFT DETECTOR. A hash of the fields that were geocoded (line1|city|state|zip).
  --   Without it the job cannot tell "this address has not changed, skip" from "this address is
  --   different today than when we pinned it", so it either re-geocodes 800 rows every run or it
  --   never notices a site has moved. Same family as `counted_in`: the row records what it is
  --   about, so a stale row is detectable rather than merely old.
  address_hash     TEXT,

  -- ★ THE LICENCE, ON THE ROW. Mapbox permits STORING a result only when the request carried
  --   `permanent=true` — verified working on this key (§3). A row written without it is not
  --   allowed to be here, and this column is what makes that auditable instead of assumed.
  permanent        INTEGER NOT NULL DEFAULT 0,

  geocoded_at      TEXT    NOT NULL DEFAULT (datetime('now')),

  -- ── The driving distance from the configured origin ───────────────────────────────────────
  --   Carried on the same row but with its OWN provenance, because it is a DIFFERENT
  --   measurement taken at a different time from a different API. If the origin is ever moved,
  --   these columns go stale while the pin stays correct, and `drive_origin_slug` is what lets
  --   the app see that instead of comparing two numbers from different questions.
  drive_miles      REAL,
  drive_minutes    REAL,
  drive_status     TEXT,                       -- 'ok' | 'no_route' | NULL = never computed
  drive_origin_slug TEXT,                      -- the `geo_origin.slug` this distance was measured from
  drive_at         TEXT
);
```

**Why one row per site and not one row per distinct address.** 789 distinct addresses across 800 sites means
11 sites share a coordinate with another site, and that is correct rather than duplicated: the register and
the page both key on `VENDOR_SITE_ID`, it is the identity Oracle already guarantees, and an address-keyed
table would need the route to join across two databases on a *string*. It also survives an address edit the
right way — the row becomes stale-but-present, with `address_hash` proving it, rather than vanishing.

**Why `drive_*` is on the same row.** The distance is a function of the pin. A site has one pin, so it has one
distance, and a second table would make every read of the register a join for no gain. The columns are still
separately stamped, which is the part that matters.

**No `CREATE TABLE` change reaches an existing store** — this is a new table, so `apply()` in
`server/src/db/app-schema.ts` creates it on next start with no `ALTER` and no `COLUMN_ADDITIONS` entry. (The
`counted_in` comment in `01-app.sql` documents `COLUMN_ADDITIONS` from the data side; nothing here needs it.)

### 2. The new table must be named in three places

The app-table list is deliberately triplicated, and the smoke suite asserts set equality across the three,
reporting both **missing** and **extra** by name:

| # | Where | Line | Note |
|---|---|---|---|
| 1 | `CREATE TABLE` in `data/sql/turso/01-app.sql` | new | the DDL the applier executes |
| 2 | `APP_TABLES` in `server/src/db/app-schema.ts` | **91** | the applier's own list |
| 3 | `APP_TABLES` in `server/src/db/store.ts` | **195** | the **router's** list |

★ `store.ts` and `app-schema.ts` keep separate copies on purpose — importing one from the other closes a
module cycle (`app-schema` → `client` → driver → `store`). Do not "fix" that.

★ **Omitting copy #3 does not produce a clear error.** `storeForTable` throws on an unregistered name, so the
symptom is a confusing failure one layer away from the omission. Omitting copy #1 or #2 fails the smoke suite
with a message naming the difference.

**The good news, checked:** every count in `server/src/scripts/smoke.ts` that could have hard-coded "7" is
**derived** — `ddlCount(appSql, 'TABLE')` at line 210, `APP_TABLES.length` at 2462, and a sorted-set comparison
at 2529. So adding an eighth table changes the expectations automatically. `scripts/verify-turso-sample.mjs`
asserts the object count of **`00-schema.sql`** (36 tables + 6 views), which this does not touch, so port
verification is unaffected. **Run `npm run smoke` after adding the name**, and expect the activity register's
object list to grow by one.

### 3. Where the coordinates actually live — the decision the request does not make

This is the part of the plan most likely to surprise, so it is stated before anything is built.

```
DB_MODE=oracle, APP_DB_URL unset   →  the app store is LOCAL: LOCAL_DB_PATH (or DEFAULT_LOCAL_DB)
DB_MODE=oracle, APP_DB_URL set     →  the app store is whatever APP_DB_URL names — Turso, if pointed there
DB_MODE=local (every test)         →  one store; the app tables and the ledger are the same file
```

The user asked for the table "in Turso". The table **is** a Turso-shaped table — it is defined in
`01-app.sql`, which is the app schema — but **under the configuration that currently reads live Oracle, it
will be written to a local SQLite file**, because with `DB_MODE=oracle` and `APP_DB_URL` unset that is what the
app store resolves to (`allowWrites: true`, while `config.db.allowWrites` is false for the ledger).

Three consequences, and they are the reason this is a numbered section rather than a footnote:

1. **The pins are per-machine unless `APP_DB_URL` is pointed at Turso.** Two developers geocode independently,
   each gets their own file, and the same site shows a pin on one machine and "not mappable" on the other. That
   reads as a data gap and is a configuration difference.
2. **The join is in the route, not in SQL.** The register's sites come from the **ledger**; the coordinates
   come from the **app store**. They are different databases, and no SQL can join across them. The route reads
   the register from the ledger, reads the geo rows from the app store, and merges on `VENDOR_SITE_ID` in
   TypeScript. This is exactly the arrangement `table_count_snapshot.counted_in` already documents — *"the
   register's object list comes from the app store, but the counts come from whichever store actually holds the
   object"* — and it is the established pattern here, not a new one.
3. ★ **A shared app store makes one feature's state another feature's data.** The smoke suite has already been
   bitten by this: a local run failed inside the *activity* register's checks because of leftover rows a
   different feature's capture had written. Any experiment that writes geo rows goes against a **copy**
   (`LOCAL_DB_PATH=…copy.db`), never the sample the suite runs on.

### 4. The geocoding job

**A script, not a route.** `server/scripts/geocode-vendor-sites.ts`, in the style of
`pull-invoices-extract.mjs`: batched, idempotent, re-runnable, with `--dry-run`, `--refresh`, `--limit`, and
`--sites=` for a single site. It needs no auth surface and no HTTP handler; the register is 653 requests and
**one POST**.

**It reads its population from the register's own scope predicate.** Import `scopeClause()` /
`fiscalFloor` from `routes/extract.ts` — the same import `routes/vendorSites.ts` already uses — so the job's
population cannot drift from the page's. The register's own module doc says the two readers must not *"drift
into describing different populations"*; a geocoding script is a third reader.

#### 4.1 What it sends, per **distinct address**

The API takes **structured input**, and the register already holds the components, so no string assembly:

```jsonc
// POST https://api.mapbox.com/search/geocode/v6/batch?access_token=…
[
  { "address_line1": "110 Corning Road", "place": "Cary", "region": "NC",
    "postcode": "27518", "country": "us",
    "types": ["address"], "limit": 1 },      // ← limit per item, or the batch returns 5 features each
  …
]
```

Three details, each measured:

- **`types: ["address"]`, `limit: 1`, `autocomplete: false`.** `types` is the guard (§2). `limit` is per
  *item*, not per request — the unguarded batch control came back with **5 features** for one nonsense query,
  so a 1000-item chunk without it invites 5000 features in one response body.
- **`country` inferred from `STATE`.** `STATE` is the only country field this data has, and it is usually `NC`.
  A value in the Canadian-province set (`BC`, `ON`, `AB`, …) or the literal `CANADA` ⇒ `country=ca`, else
  `country=us`. Send `region` only when it looks like a region code — `region=CANADA` was measured returning
  the *right* coordinate at *reduced* confidence, which is a silent quality loss rather than an error.
- **Chunk at 900**, under the 1000 cap, so a growing register does not silently truncate.

#### 4.2 What it writes, and only when it may

```
for each response feature:
  if  feature === null                                   → status 'no_match'
  elif feature.properties.feature_type !== 'address'      → status 'no_match'   ← the response-side guard
  elif !feature.properties.coordinates?.accuracy          → status 'no_match'   ← the real signal that §2 found
  else                                                    → status 'matched', lat/lon, quality fields
```

★ **Both guards, always.** The request-side `types` filter is verified to refuse the two bad shapes, and the
response-side assertion costs two lines. A check that lives only on the request is invisible to the next
reader, and a check that lives only here would silently pin a street.

★ **A non-200 is `'error'`, never `'no_match'`.** The distinction is load-bearing: this repo has already been
bitten by `Number(rows[0]?.n ?? 0)` turning a failed query into a confident zero. An `error` row is retried;
a `no_match` row is an answer and is not.

#### 4.3 PO boxes are refused before they are sent

`ADDRESS_LINE1` matching `/^\s*P\.?\s*O\.?\s*BOX/i` ⇒ `status='po_box'`, `reason='PO box — no street address'`,
**and no request**. 136 of 800 sites.

Two reasons, and the second is the one that matters:

1. It saves 136 requests (immaterial — 21 % of 653 — but the endpoint measured that a PO box returns a
   *street*, so sending them is asking a question whose answer is known to be wrong).
2. ★ **Substituting the postcode centroid would be worse than having no pin.** A centroid is a real
   coordinate, so it would pass every guard, draw a marker, and produce a **driving distance that is wrong by
   an unstated amount** — and nothing downstream could tell. A missing pin is honest; a fabricated one is not.
   This is Decision 5.

#### 4.4 Idempotency is keyed on the address hash, not on the row

A site is skipped only when it has `geocode_status IN ('matched','po_box','no_match')` **and**
`address_hash` equals the hash of the address read this run. That means:

- a `no_match` row is not retried forever (it is an answer);
- an `error` row **is** retried;
- a site whose Oracle address changed is re-geocoded, because the stored pin describes an address that is no
  longer there — and `address_hash` is the only thing that can tell those apart.

★ This is the "clean up BEFORE as well as after" lesson in a different costume: a job keyed on *the existence of
a row* passes on a virgin store and quietly stops being correct the moment an address changes.

### 5. Driving distance from Raleigh

**The Matrix API**, one source (Raleigh) against N destinations.

```
GET https://api.mapbox.com/directions-matrix/v1/mapbox/driving/{lon,lat};{lon,lat};…
      ?sources=0&destinations=1,2,3,…&annotations=distance,duration&access_token=…
```

| constraint | value |
|---|---|
| coordinates per request, `mapbox/driving` | **25** (10 for `driving-traffic`) |
| so destinations per request with one source | **24** |
| requests for 800 sites | **34** |
| billed elements | **800** (1 source × 800) — free tier 100,000 |
| rate limit | 60 requests/min |
| returns | `durations` in seconds, `distances` in **metres** |

★ **Set `destinations` explicitly.** The probe left it at its default and got a **`0.0 mi` entry for the origin
itself** in position 0 — `destinations` defaults to *all* coordinates, so the source is echoed back as a
destination and one element per request is billed for a zero that means nothing. `sources=0&destinations=1,…`
fixes it. (Measured output from the probe, with the origin included:
`dest[0]: 0.0 mi / 0 min · dest[1]: 9.6 mi / 19 min · dest[2]: 36.5 mi / 51 min`.)

★ **`null` is not zero.** An unroutable pair returns `null` (or `NoRoute`) and must be written as
`drive_status='no_route'` with NULL miles. A `0` would assert that the site is at the origin, which is a real
and meaningful value — and the two would be indistinguishable on screen. This is the same failure as a failed
count reading as `0`.

★ **Precompute; never call Matrix from the page.** 800 elements per refresh means a page viewed 100 times a day
would spend 80,000 elements a day against a 100,000 monthly tier. Storing the result also makes the number
*stable*: the same site shows the same distance on every visit, which a live call cannot promise and which
matters on a page whose other figures are all frozen readings.

★ **The origin is data, not a constant in a component.** A one-row `geo_origin` table (`slug`, `name`,
`latitude`, `longitude`, `is_default` with a partial unique index exactly like `organization.is_default`), so:
the origin is stated once; a second origin is possible later (a different warehouse, a school); and each
distance row carries `drive_origin_slug` so a number measured from a *different* origin is detectable rather
than silently compared. **`raleigh` at `-78.6382, 35.7796`** is the city centre the probe used — **confirm the
exact point** before the first run, because every distance on the page is relative to it and a change is a
change to all of them.

★ **3 sites are outside the US and their distance is not a delivery figure.** The Matrix API will route
Raleigh → Vancouver BC through the road network and return a number in the thousands of miles. That is a true
answer to the question asked and a misleading one to display unqualified, so the page says *by road* and the
disclosure names the non-US count (Decision 8).

### 6. The map on the page

**Where:** `app/src/routes/VendorSites.tsx`, as a **view toggle over the register** — `[Table | Map]` — not a
replacement for it. The table carries the in-scope order count and the committed dollars, the deprecation
signals and the pagination; the map carries location and distance. Neither is a superset of the other.

**Component:** `mapbox-gl` behind a **dynamic import**, so the 200 KB+ library lands in its own chunk and the
register does not pay for a map nobody opened. `vite.config.ts` already raises `chunkSizeWarningLimit` to 900,
which suggests the bundle is watched; a static import of `mapbox-gl` into the page module would put it in the
initial chunk for every visitor.

★ **★★ The map must draw the whole population, and the register endpoint's `PER_PAGE = 50` is a pagination
device — not a scope.** This is the one place the feature can be *wrong* rather than merely incomplete. If
coordinates ride along on the site rows the page already fetches, the map can only ever draw the first 50 of
761 active sites, and a reader looking at a map with 50 pins has no way to know that 711 are missing — the same
failure as `list.slice(0, N).filter(pred)` reporting "no matches" for a term provably in the data. So:

- the endpoint serves a **`geo` array covering every in-scope site** — `vendor_site_id`, `latitude`,
  `longitude`, `geocode_status`, `geocode_reason`, `accuracy`, `drive_miles`, `drive_minutes` — **independent
  of `PER_PAGE`**, at roughly 120 bytes a site (~95 KB for 800, and the same payload the page already pays for
  its rows);
- the map draws **the active tab's whole population** (761 or 39), because "where is our money going" is a
  population question;
- a marker clicked for a site not on the current page **filters the table to that site** rather than scrolling
  to nothing;
- and the counts in the map's own legend come off the `geo` array, never off the page.

★ **The 503 must not become an empty map.** `app/src/data/vendorSites.ts` has **no frozen fallback** — under a
non-Oracle ledger the endpoint answers `503 DB_UNAVAILABLE` and the page renders `UnavailableError` as an
explanation. An empty Mapbox canvas in that state says "this organization has no vendor sites", which is a
different and false claim about the data rather than a statement about the configuration. **The map is
rendered only when the register payload is present**; otherwise the existing explanation stands, and the map
control is disabled with a reason.

★ **A missing pin must be visible as a gap, not as absence.** 136 PO boxes plus any `no_match` means the map
shows fewer pins than there are sites, and the legend says so unconditionally: *"N of M sites shown · K have no
street address"* — with the count as the conditional part and the sentence always present. The register's own
lesson applies: a disclosure that only appears when something went wrong is invisible exactly where it is
needed.

### 7. The token

The key in `.env` is a **public** token (`pk.`) — designed to be shipped to a browser — but it currently sits
**server-side only**, and **no `VITE_`-prefixed variable exists anywhere in this app** (the only
`import.meta.env` use is `import.meta.env.DEV` in `App.tsx`). So this is a new pattern and deserves a decision
rather than a default.

**Recommended: a dedicated `app/.env` holding only `VITE_MAPBOX_TOKEN`.**

- Vite reads env from the **project root**, which is `app/` — not the repo root — so the existing root `.env`
  is not visible to the client build at all today.
- The alternative, `envDir: '..'` in `vite.config.ts`, would point the client build at the **repo-root `.env`**
  — the file that holds the Oracle password, the database credentials and the Turso token. Vite only inlines
  `VITE_`-prefixed variables, so this would not leak *today*; it would put a credentials file on the client
  build's env surface, where a future `VITE_`-prefix typo is a leak. One small file with one public key is the
  cheaper safety.
- Mapbox supports CORS with **no domain restrictions**, so a browser call to `api.mapbox.com` from
  `localhost:5180` needs no proxy. If one is wanted anyway, `/api` is already proxied to
  `127.0.0.1:5181` by `vite.config.ts` (`changeOrigin: false`), and a Mapbox route would sit under it.

★ **Check the existing token's URL restrictions before wiring the browser map.** The server-side geocode
succeeded, which proves the token is valid — but a public token may be restricted to particular origins, and a
restriction that excludes `localhost:5180` produces a **map that 401s while the geocoding job works perfectly**,
which reads as a front-end bug and is a token setting. Confirm the restriction list, and set it to the app's
origin so a scraped token cannot be reused elsewhere.

### 8. Disclosure

The page already carries address-incompleteness counts — 624 no line 2, 794 no line 3, 373 no phone, 372 no
area code, **2 no state**. A map adds a **new** incompleteness class (sites with no pin) and, per the register's
own history, **every existing vague label about the same quantity has to be re-read in the same pass** once a
precise figure appears beside it. Concretely:

| new figure | the existing label it can make false |
|---|---|
| *"653 of 800 sites have a pin"* | *"2 sites have no state"* — read together, they imply the missing state is why sites are unmapped. **Both no-state sites geocode** (measured, §4). |
| *"136 sites carry a PO box"* | the address-completeness note counts *absent* fields; a PO box is a *present* address that cannot be pinned. Same column, opposite meaning. |
| *"3 sites are outside the US"* | *"driving distance from Raleigh"* — true for all 800, meaningful for 797. |
| *"N sites are `interpolated`"* | no existing note says a coordinate can be approximate. A pin is not a fact until its accuracy is shown. |

So the map legend states, always, in this order: sites shown / sites in scope, then the reasons, then — where
a distance is involved — that it is by road from a named origin, and that `interpolated` and `approximate`
pins place the marker less precisely than `rooftop`. **The counts are the conditional part; the sentence is
not.**

### 9. What the licence permits, and one flag that is not this plan's call

Two clauses from the Mapbox terms and pricing page that a reviewer should see rather than discover:

1. **Storing is permitted only under `permanent=true`, and permanent results "cannot be used for distribution
   or sublicense."** Serving pins and distances inside this app is the intended use. **An export that hands
   the coordinate set to a third party is a licensing decision**, and the register already has an export
   surface — so this is a real boundary, not a hypothetical one. (Decision 9.)
2. ★ **Mapbox requires a Commercial Application License for production use of its services "related to
   business intelligence or analytics"** — and this application is a read-only analytical slice over Oracle
   financials. The free tiers above are *volume* allowances and say nothing about this *licence* requirement.
   **This plan cannot decide it and should not be read as having decided it.** Raise it before the feature is
   used beyond a local review slice (Decision 10).

---

## Decisions

| # | Decision | Why |
|---|---|---|
| **1** | Point `APP_DB_URL` at **Turso** (or accept per-machine pins and say so on the page) | otherwise "in Turso" is not what happens — under `DB_MODE=oracle` the app store is a **local file** |
| **2** | New app-owned table **`vendor_site_geo`**, keyed on `VENDOR_SITE_ID`, one row per **site** | the identity Oracle already guarantees; 789 distinct addresses are written to 800 rows |
| **3** | **`permanent=true` on every geocode**, with a `permanent` column on the row | Mapbox permits storing only permanent results; **verified working on this key**. The column keeps it auditable. |
| **4** | **`types=["address"]` on the request AND a `feature_type==='address'` + `accuracy` check on the response** | ★★ without the first, **a garbage address and all 136 PO boxes return confident pins for streets that are not the address**. Verified in three shapes with passing controls. |
| **5** | **PO boxes are recorded `no_match`/`po_box` and never pin**; no postcode-centroid substitute | a centroid passes every guard and produces a driving distance wrong by an unstated amount. A missing pin is honest. |
| **6** | Geocode **per distinct address** (653 requests, ~one POST); store per site | 789 vs 800; 11 shared addresses must not be able to disagree |
| **7** | Driving distance is **precomputed and stored**, from a **one-row `geo_origin`**, with `sources` *and* `destinations` set explicitly | 800 elements/refresh vs 80,000/day if called per view; the default echoes the origin as a `0.0 mi` element |
| **8** | The map draws the **whole active tab**, from a `geo` array **independent of `PER_PAGE`** | ★ drawing 50 of 761 pins is a *wrong* map, not an incomplete one |
| **9** | Token via a dedicated **`app/.env` → `VITE_MAPBOX_TOKEN`**; leave the repo-root `.env` off the client build's env surface | a public `pk.` token is designed for this; the root `.env` holds the Oracle and Turso credentials |
| **10** | ★ **Raise the Mapbox Commercial Application License question** (BI/analytics use) before this goes past a local review slice | pricing page requires the licence for exactly this kind of application; the free tiers are volume, not licence |
| **11** | **Register only.** `PO_VENDOR_SITES_ALL` (99,316 sites / 57,834 distinct addresses / 39,173 incomplete) is geocodable in a month's free tier but is not what the page is | the register is what money was actually committed to |
| **12** | Under `DB_MODE=local` the page shows the **503 explanation and no map** | an empty canvas asserts "no vendor sites", which is false |

---

## What to do first, in order

1. **Decide 1** (`APP_DB_URL` → Turso?) — it determines where every later step writes, and changing it later
   means re-running the job.
2. Add `vendor_site_geo` + `geo_origin` to `01-app.sql`; add both names to `APP_TABLES` in
   **`app-schema.ts:91`** and **`store.ts:195`**; run `npm run smoke` and expect the activity register's object
   list to grow by two.
3. Seed `geo_origin` with `raleigh` — **confirm the coordinate** before any distance is computed from it.
4. Write `server/scripts/geocode-vendor-sites.ts` with `types`, the response guard, the PO-box pre-filter and
   the `address_hash` skip rule. Run `--dry-run` first: it should report **789 distinct addresses, 136 PO
   boxes, 653 requests, 1 batch POST** — and if those three numbers do not match §1, the population predicate
   has drifted from the register's and that is the bug to fix before any request is sent.
5. Add the Matrix step to the same script.
6. Extend `/api/vendor-site-register` with the `geo` array (all in-scope sites, not the page).
7. Add `[Table | Map]` to `VendorSites.tsx` with `mapbox-gl` on a dynamic import; wire `VITE_MAPBOX_TOKEN`
   from a new `app/.env`; **check the token's URL restrictions** first.
8. Run the smoke suite, then look at the page in a browser — the register's history is that a
   server-tested feature and a UI-tested feature is not a tested feature, and the two halves here (a script that
   writes pins, a page that draws them) are exactly that shape.

## Open questions for you

1. **`APP_DB_URL` → Turso?** If not, the pins are per-machine and the page should say which store it read.
2. **The Raleigh origin** — a specific address rather than the city centre (`-78.6382, 35.7796` was used for
   the probe)? Every distance on the page is relative to it.
3. **The 3 non-US sites** — compute the by-road distance anyway (recommended, labelled) or leave their distance
   blank as a separate category?
4. **Mapbox licence** (Decision 10) — worth asking before this is shown to anyone beyond review?

`server/tmp-geocode-probe.mjs` and `server/tmp-geocode-guard.mjs` (and their `.out.txt` files) are throwaway
evidence, not part of the build. Delete them once §1–§2 have been acted on.
