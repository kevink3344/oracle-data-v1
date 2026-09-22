# The vendor-site location map — implementation

**Status:** implemented, verified in the browser against the live stores; the basemap needs no
credential of any kind, and that is the point of the design.
**Plan of record:** none — this was a repair, and the diagnosis *is* the design (§3, §5).
**Date:** 2026-09-20.

---

## 1. What this is

The Location section of a vendor-site drawer draws three things and states a fourth:

1. **where the site is**, on a basemap;
2. **the road line** from the drive-from origin to that site, stored in this app's own database;
3. **two mileages** — the length of the line being drawn, and the distance the stored `drive_*`
   figure measured — plus a third, the straight-line distance, computed in the browser;
4. **the turns**, folded behind a `<details>`, because a stored route here is 5–69 steps.

Two things make it worth writing down. The basemap is **keyless**, so nothing in the browser can
blank the panel by being mistyped, expired or unentitled. And under Vite, MapLibre GL JS has a
failure mode that produces **no error anywhere** — not in the console, not in the library's own
error event, not even as a failed request — which costs an afternoon unless you know it exists
(§5).

---

## 2. The symptom, and the three things it was not

The panel showed an empty frame: the `.vsmap` border, the sunken background, nothing drawn. No
thrown error, no 404, no message — which is the whole difficulty, because **a blank map has three
independent failure classes and they render identically**:

| class | what is wrong | who reports it |
| --- | --- | --- |
| **no style** | the credential is missing or not entitled | nobody — 401 on a request the code does not await |
| **no worker** | the bundler broke the tile worker's URL | **nobody at all** (§5b) |
| **no data** | the row has no coordinate | this component, in words (§7h) |

Everything that *could* have been the cause was excluded by measurement, not by reading the code:

| candidate | how it was excluded |
| --- | --- |
| container height 0 | the canvas box measured **571 × 220** — a real box |
| WebGL unavailable or context lost | canvas context created, `glContextLost` false |
| CSS hiding the panel | computed `display`/`visibility` normal on the canvas and its wrapper |
| bad coordinates | the register rows carried real `latitude`/`longitude` |
| the map was never constructed | the control container was in the DOM, with Mapbox's own controls |

★ **A screenshot is what found the fault, and no numeric probe would have.** Every element was
present, correctly sized and correctly classed; only looking at the render showed a **pale,
label-free wash** — the style's background colour with no roads and no place names on it.

---

## 3. The entitlement: a 401 that no URL restriction can explain

This is the reusable half of the diagnosis, so it is written as a procedure rather than as history.

The suspect was a public `pk.` token. Four endpoints × three tokens × four header combinations
were measured. What matters is one column of that table:

| request | `Origin` sent | `Referer` sent | answer |
| --- | --- | --- | --- |
| `api.mapbox.com/styles/v1/mapbox/…` | **none** | **none** | **401** |
| `api.mapbox.com/tiles/v4/…` | none | none | 401 |
| `api.mapbox.com/geocoding/v5/…` | none | none | **200** |
| `api.mapbox.com/geocoding/v5/…` | `http://localhost:5180` | the page URL | 200 |

★ **THE TELL: THE FAILING REQUEST CARRIED NO `Origin` AND NO `Referer` AT ALL.** A token restricted
to a list of allowed URLs is judged *by those headers*. A request that sends neither cannot be
refused by that rule, because there is no header for the server to evaluate. So this 401 is an
**entitlement** answer — the token's scopes do not include the Styles or Tiles APIs — and adding
`http://localhost:5180` to the allowed-URL list would never have brought the map back. Two
sessions can be spent on the allowed-URL list for want of that one observation.

★ **AND THE SECOND TELL IS WHY IT READ AS "ONLY THE MAP IS BROKEN".** `geocoding/v5` answered
**200 the whole time**, with and without the headers. The geocoding, the driving Matrix and the
Directions calls all go through the server, in Node — so they kept working while the one thing
that needs a *style*, in the browser, failed. The symptom's shape (everything but the map) was
itself evidence that the fault was an API **entitlement** and not a network or a browser problem.

**Reusable rule:** test each API of a provider separately. "The token is fine — the geocoder
works" is not a fact about the token; it is a fact about the geocoder.

---

## 4. The swap: MapLibre GL JS over a keyless style

```ts
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
```

Chosen over re-scoping the credential because:

- **the fix is credential-free**, so nothing else in the panel had to move — the routing, the
  distances and the turns were never fetched from a map API in the browser (§10);
- a mistyped, expired, rate-limited or unentitled key **can no longer blank the panel**;
- the style is **complete**: it declares its own vector source, its own glyph endpoint
  (`/fonts/{fontstack}/{range}.pbf`), its own sprite sheet and its own attribution. This
  component supplies a container, a centre, a zoom and the app's own layers — nothing else.
- MapLibre GL JS is the API-compatible fork of Mapbox GL JS, so `new Map(...)`, `LngLatBounds`
  and the style spec are unchanged and the app's own sources and layers needed no edit.

The differences that did bite:

| Mapbox GL JS | MapLibre GL JS |
| --- | --- |
| `import mapboxgl from 'mapbox-gl'` — a **default** export | **named exports only**: `{ Map, LngLatBounds, setWorkerUrl }`. The component carries `type MaplibreLib = typeof import('maplibre-gl')` for the same reason — there is no default to type |
| `accessToken` is required before a style is fetched | **no such property exists.** There is no `accessToken` line in the construction, and its absence *is* the fix |
| DOM classes are `mapboxgl-*` | DOM classes are `maplibregl-*` (§8 — a stylesheet rule that outlives the fork matches nothing) |
| stylesheet imported by the app | still imported by the app (`maplibre-gl/dist/maplibre-gl.css`), but **inside the lazy load**, so a register page where nobody opens a panel downloads none of it |
| attribution string supplied by the app | **read out of the style** by `attributionControl`; measured live: `MapLibre \| OpenFreeMap © OpenMapTiles Data from OpenStreetMap` |

The attribution is left switched on deliberately. A keyless tile host is not a licence-free one.

---

## 5. ★ The defect the swap exposed: the tile worker

This is the single most reusable thing in this document. It is a **bundler** defect that looks
exactly like a **hosting** defect, and it reports nothing.

### 5a. The mechanism, quoted from the library's own source

`maplibre-gl@6.10.0`, `dist/maplibre-gl-dev.mjs`, lines 2069–2095:

```js
function defaultWorkerUrl() {
  const moduleUrl = import.meta.url;
  const workerName = moduleUrl.endsWith("-dev.mjs") ? "maplibre-gl-worker-dev.mjs"
                                                    : "maplibre-gl-worker.mjs";
  return new URL(`./${workerName}`, moduleUrl).href;      // ← A SIBLING OF THE LOADED MODULE
}
...
const url = config.WORKER_URL || defaultWorkerUrl();
```

The worker is resolved as a **sibling of whichever module is executing**. Under Vite the module
that executes is the **pre-bundled dependency** — `/node_modules/.vite/deps/maplibre-gl.js` — so
the worker is requested from `/node_modules/.vite/deps/maplibre-gl-worker.mjs`, **a path the
dependency cache does not contain**. `new Worker(...)` fires an `error` event on the worker
object, and MapLibre does not surface it.

### 5b. Why it is silent, and what it looks like

Measured, on a panel whose map had not drawn:

- **no `map.on('error')` callback** — the library's own error path is never reached;
- **no console message** of any kind;
- **no failed request** in the network panel, because no request is ever made;
- the visible symptom is a **pale, label-free wash**.

The reason it is that empty is worth stating, because it explains every downstream observation:
**vector tiles and glyphs are parsed in the worker.** With no worker there is no tile to hand back,
so no source ever reaches `loaded`, so `map.on('load')` **never fires** — and therefore none of
this component's own sources, layers or pins are ever added. It is not a map with missing layers.
It is a map that never finished starting.

### 5c. Two false leads it produced, and how to recognize them

- **A raster style is unaffected.** A raster tile needs no worker. So an inline `tiles: [...]`
  style drew *fine*, and the failure read as "this vector style host is wrong" — a hosting theory
  that no amount of host-swapping could satisfy.
- **MapLibre's own `demotiles` style stalls identically, while both hosts answer 200 to a plain
  `fetch` from the page.** Two independent hosts appearing to fail the same way is the tell that
  the fault is **local to the bundle**, not remote.

### 5d. The fix

```ts
libPromise = import('maplibre-gl')
  .then(async (mod) => {
    await import('maplibre-gl/dist/maplibre-gl.css');
    const workerUrl = (await import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url')).default;
    mod.setWorkerUrl(workerUrl);
    return mod;
  })
  .catch((err: unknown) => { libPromise = null; throw err; });
```

`?worker&url` makes Vite bundle the worker file and hand back a URL **Vite itself serves**. Both
halves of that are visible in the page's own resource list, measured:

| dev | build |
| --- | --- |
| `/node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url` | an emitted, hashed asset beside the app's chunks |
| `/node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs?worker_file&type=module` (what the first resolves to) | — |

★ **`setWorkerUrl` must run before the first `Map` is constructed.** It writes module-level config
that the constructor reads. That is why the call lives in this promise and not in an effect: an
effect runs after render, and the map is built inside an effect too.

---

## 6. The lazy-load pattern: one promise, at module scope

```ts
let libPromise: Promise<MaplibreLib> | null = null;
```

Three decisions are packed into those seven words, and each has a reason:

1. **It is a dynamic `import()`, not a static one.** The register page publishes **800** sites and a
   reader opens **one** panel. A static import would put the whole rendering library in the first
   paint of a page whose map is closed almost every time it is opened.
2. **The promise is at module scope, not in the component.** Panel one downloads the chunks; panel
   two and every panel after it reuse them, instead of re-fetching the library per drawer.
3. **A rejection is deliberately not cached** (`libPromise = null` before rethrowing). The two
   ordinary ways a chunk load fails are both fixed by a reload — the reader is offline, or a deploy
   replaced the hashed filename under a tab that is still open — and caching the rejection would
   leave the panel permanently dead in a tab that had already succeeded once.

The component's `lib` state is a three-way discriminated union (`loading` / `ready` / `failed`) so
that "still arriving" and "will never arrive" are different renders, not the same falsy value.

---

## 7. The shape of the component (the parts worth copying)

### 7a. One map per panel, bridged to late data by **refs**, not by deps

The route is fetched after the map is built (§7c), so the two have to meet. The obvious mechanism
— add `route` to the draw effect's dependency array — is the wrong one: it tears the whole map down
and stands it up again on every route arrival, which means **a second metered map load per panel**
and the loss of the reader's pan and zoom. A ref carries the geometry across instead
(`routeCoordsRef` plus a setter ref that the map effect installs), so the map is built exactly once
per panel.

### 7b. Every dependency of the construction effect is a number or a null — never an object

The draw effect depends on `[lib, lat, lng, origin, band.colour]`. Objects and arrays are
re-created on every render, so a dependency array holding one would rebuild the map on every
keystroke elsewhere in the drawer. This is not a style preference; it is the difference between
one map and forty.

### 7c. The route is one request, for one site, only when there is a pin to start from

A stored route is **12.6 KB**, and **90% of it is the turns** (11,291 bytes of steps against 1,319
bytes of geometry, measured). It cannot ride the 800-site register payload. So:

- fetched **once**, for the one site whose panel a reader opened;
- **not gated on the map library** — the route is text and numbers the caption needs whether or
  not the basemap ever arrives, so a tile failure must not take the sentence with it;
- carried by an `AbortController`, and an `AbortError` is treated as **React 18 StrictMode's
  double-mount, not a failure**.

### 7d. `load` adds the sources **empty**, and fills the route afterwards

The tile fetch and the library's load race in either order, so the route source is added with no
data and filled when the geometry exists. Two layers matter:

- **a casing under the line.** A white 7px line at 85% under a 3.2px `#165788` line at full
  opacity. This is not decoration: a single three-pixel line over a motorway or a lake is
  illegible, and a casing is what keeps it readable on every backdrop the basemap can produce.
- **both pins are one source with a data-driven colour** — origin `#df6d1c`, site by distance band.
  One source means the white halo (`circle-stroke-color #ffffff`, `circle-stroke-width 2.5`) and
  the sizing (`['case', ['==', ['get','kind'],'origin'], 8, 11]`) cannot drift apart between the two
  marks.

### 7e. `applyRoute` **switches** two lines rather than drawing both

There is always exactly one line on the map: the stored road route, or — when there is no route —
a dashed straight line between the two pins. Drawing both, or drawing the straight line while the
road line is still arriving, is an invitation to measure the wrong thing, because a polyline and a
two-point line are the same mark. Every call is guarded (`getSource` returns `undefined` before
`load` and after `remove`), and the first route re-frames the map **once** — `fitted` is not reset,
so a later resize does not throw away the reader's own pan.

### 7f. `ResizeObserver`, and only the first observation re-frames

The drawer is resizable and the library does not watch its container, so the observer calls
`map.resize()`. It re-frames **only on the first observation** (`if (!fitted) fit(...)`), because
re-framing on every resize is exactly the "the map jumped while I was looking at it" defect.

### 7g. Teardown order

`observer.disconnect()` → `map.off('error', onError)` → clear the setter **if it is still
`applyRoute`** (so a teardown that races a re-mount cannot clear the new map's setter) →
`map.remove()` inside a `try`/`catch`, because a `remove()` on a partially constructed map throws
and that must not become the error the reader sees.

### 7h. Four early-return branches, four different sentences

The panel refuses to draw in four cases, and **each one says a different thing**, because they are
different facts:

| branch | what happened | what the panel says |
| --- | --- | --- |
| `!geo.available` | the store did not answer | a statement about **the store**, not about this site |
| `!keyUsable` | the register row carries no usable site id | a **payload defect** — the id is a primary key on both sides |
| `!row` | the geocoding job never reached this site | a different fact from a failed lookup, with `notCovered of inScope` |
| `!pinned` | the site has no coordinate | `noPinReason(row)` — PO box, geocoder miss, etc. — plus "What was asked:" and the date it was answered |

★ **the join is guarded on the KEY, not on the result**:

```ts
const key = site.vendorSiteId;
const keyUsable = Number.isFinite(key) && key > 0;
const row = keyUsable ? geo.sites.find((s) => s.siteId === key) ?? null : null;
```

A guard on the *result* cannot catch a collision on the *key*. `Number(undefined)` collapses an
absent id onto `0`, so a register row and a geo row that had each lost their key would both read
`0`, `.find()` would return an **unrelated row**, and a truthiness guard on that result would see a
real object and pass — drawing one site's pin at another site's address.

---

## 8. The CSS contract, and one rule that outlived the fork

Two rules matter, and one of them is a trap.

```css
.vsmap__canvas {
  position: relative;
  height: 220px;          /* 180px below 720px — the address outranks the map */
}
```

★ **THE CONTAINER MUST HAVE A HEIGHT OF ITS OWN.** The library measures this element's box **once,
at construction**, and sizes its canvas to it. A container whose height comes from its content is
zero tall at that moment, so the canvas comes out **0 × 0** and the panel shows an empty frame with
no error anywhere — the same silent collapse as an inline element given a percentage size.
`position: relative` is required for a second reason: the library positions its own controls
(attribution, logo) absolutely against this box, and an absolutely positioned child escapes any
ancestor scroller that is not its containing block.

★ **AND THE CONTROL CLASS PREFIX MOVED WITH THE FORK — MEASURED, NOT ASSUMED.** On the live panel
the attribution element's exact class list is:

```
maplibregl-ctrl maplibregl-ctrl-attrib maplibregl-compact maplibregl-compact-show
```

and MapLibre's own stylesheet carries no `.mapboxgl-*` rule at all. The panel's stylesheet still
contains

```css
.vsmap__canvas .mapboxgl-ctrl-attrib { font-size: 0.625rem; }   /* vendors.css:979 — matches nothing */
```

so the attribution renders at MapLibre's own **12px** (computed, measured) rather than the 10px the
sheet asks for. **An unused selector produces no diagnostic** — not from `tsc`, not from the linter,
not from the browser. The sheet has to be reconciled against the markup by reading both (§12).

---

## 9. The verification recipe (the part that proves it)

The map instance is module-scoped and deliberately **not** on `window`, so a probe reaches it
through the DOM and the network. This is the whole recipe, and it is what was run:

| what | how | live value |
| --- | --- | --- |
| the style parsed | `isStyleLoaded()` | **true** |
| the basemap's own source is ready | `isSourceLoaded('openmaptiles')` | **true** |
| something is actually drawn | `queryRenderedFeatures().length` | **253** |
| vector tiles were fetched | **not readable from the page's timeline** — tile fetches are issued by the worker; take this from the two source-state rows above, or from the Network panel (★ below) | — |
| the style's glyphs were fetched | page resource entries matching `/fonts/**` | **2** (`Noto Sans Italic/0-255.pbf`, `Noto Sans Regular/0-255.pbf`) |
| the app's own layers were added | `map.on('load')` fired | **yes** |
| the required attribution is on screen | `document.querySelector('[class*="ctrl-attrib-inner"]').textContent` | `MapLibre \| OpenFreeMap © OpenMapTiles Data from OpenStreetMap` |
| the panel is the one for this site | the canvas `aria-label` | *"Map of 406SMCDOWE OPE and Raleigh, North Carolina, joined by the road route, 11 miles"* |

**Without `setWorkerUrl`, measured over three reloads:** `isStyleLoaded()` and
`isSourceLoaded()` both **false**, `queryRenderedFeatures()` **0**, **no glyph `.pbf` request**
(the only kind the page's own timeline can see — see the ★ note below), and `load` **never fires**.
Two runs of the same probe, one line apart in the source.

Four notes that each cost time:

- **★ COUNTING TILE REQUESTS IN THE PAGE'S OWN TIMELINE IS A PROBE THAT CANNOT WORK — AND IT
  MISREPORTS IN BOTH DIRECTIONS.** `performance.getEntriesByType('resource')` on this panel ends in
  **2** `.pbf` entries: the glyphs, `/fonts/Noto Sans …/0-255.pbf`. There is **no tile entry at all**,
  because the vector-tile fetches are issued **from the worker** and are not reported into the page's
  performance timeline. So a filter testing `/planet/` returns **0** on a perfectly healthy map (an
  earlier pass of this recipe did exactly that and the zero read as a missing tile), while a filter
  testing the tile *host* counts the **glyphs** as tiles (the earlier pass's `planet` count was this).
  Add the timeline's own ceiling — **250 entries by default**, which a 60-row register page can
  approach — and *absence from this list proves nothing*. **Prove the tiles with source state**
  (`isSourceLoaded('openmaptiles')` and a non-zero `queryRenderedFeatures()`, both in the table
  above) **or with the Network panel**; use the timeline probe only for the glyphs, the attribution
  and which library bundle is running.
- **`document.querySelectorAll('.maplibregl-marker').length === 0` is expected, not a failure.**
  The pins are **layers**, not `Marker` instances. A probe asserting markers exist would report a
  broken map on a perfect one.
- **An empty attribution control is a diagnostic.** It goes `*-attrib-empty` when the style never
  loaded. On the pre-fix build that was the *only* DOM evidence that anything was wrong — and it is
  a one-line check that needs no map instance.
- **★ A TAB OPENED BEFORE THE SWAP KEEPS RUNNING THE OLD BUILD, AND ITS DOM LOOKS LIKE A NEW BUG.**
  This was lived: a long-lived tab was probed and reported `mapboxgl-*` classes, a
  `https://www.mapbox.com/` logo link and an **empty** attribution — apparently a fresh defect in
  the new code. Its own resource list settled it:
  `/node_modules/.vite/deps/mapbox-gl.js?v=35d6d661` and `/node_modules/mapbox-gl/dist/mapbox-gl.css`.
  It was executing the **pre-swap Mapbox bundle** (still rendering the broken map), while a fresh
  tab held `.vite/deps/maplibre-gl.js?v=dd10c957` plus both worker URLs. **Hard-reload, in a new
  tab, before believing any probe of a library swap** — and check the resource list rather than
  inferring which library is running from the class prefix alone.

### 9a. The probe, as run in the browser console

```js
// DOM + network only: no map instance is reachable, and none is needed.
const c = document.querySelector('.vsmap__canvas');
const names = performance.getEntriesByType('resource').map((r) => r.name.replace(/^https?:\/\/[^/]+/, ''));
({
  canvas: c && `${c.clientWidth}×${c.clientHeight}`,
  attrib: c?.querySelector('[class*="ctrl-attrib-inner"]')?.textContent ?? null,
  attribEmpty: !!c?.querySelector('[class*="attrib-empty"]'),
  // ★ glyphs only — vector tiles are fetched by the worker and never appear in this list, so a
  // missing tile entry is NOT evidence of a broken map. See the ★ note in §9.
  glyphPbf: names.filter((n) => /fonts\/.*\.pbf$/.test(n)).length,
  anyPbf: names.filter((n) => /\.pbf$/.test(n)).length,
  timelineEntries: names.length,   // the buffer caps at 250; absence in here is weak evidence
  library: names.filter((n) => /maplibre|mapbox/.test(n)),
});
```

An empty `attrib` or a non-zero `attribEmpty` means the style never loaded and the library is the
first thing to look at, not the coordinates.

---

## 10. What deliberately did not move

- **Routing stayed stored and server-side.** 622 routes with `route_status = 'ok'` are held in the
  app's own store and served by `GET /api/vendor-site-route/{id}`. Neither OpenFreeMap nor MapLibre
  routes anything; the swap is a basemap, and it cannot affect a stored line.
- **The three mileages keep three labels, because they answer three questions.**

  | figure | source | answers |
  | --- | --- | --- |
  | *Route (drawn)* | Directions v5, `route.distance` | how long is the line I am looking at |
  | *By road (Matrix)* | Matrix v1, stored per site | how far is it by road |
  | *As the crow flies* | haversine, computed in the browser | the straight-line distance |

  They genuinely disagree, and it is **not staleness**: Matrix and Directions agree within one mile
  on only **11 of 24** sites carrying both figures and differ by as much as **34.48 mi**; a fresh
  Matrix call reproduces the stored value to **0.0049 mi**.

- **The straight line was removed from the drawing** and survives in exactly one place: the dashed
  fallback when a site has no stored route. A straight line beside a road line is an invitation to
  measure the wrong thing, so the caption names which of the two the reader is looking at
  (`drawn` is a parameter of the caption, because the basemap-failed branch has no line at all).
- **173 of 800 sites have no coordinate** — 146 PO boxes (there is nothing to geocode) and 27
  geocoder misses. The panel gives the reason per site rather than a generic "no location".

---

## 11. Found on the way

Two of these were applied after the fact, on request; two are deliberately left alone.

**Applied.**

- **The mileage caption no longer names Mapbox** (`VendorSiteMap.tsx`, the `gap` legend). It read
  *"…the two **Mapbox** endpoints choose different routes…"* — accurate about *provenance*
  (both stored figures were measured server-side by Mapbox APIs) but misleading about *what the
  reader is comparing*. It now reads *"the two **routing services** behind these figures"*, which
  says what the two numbers are without naming a vendor the reader has no reason to know about.
  ★ The tell that it needed the change: the two rows beside it are labelled *Route (drawn)* and
  *By road (Matrix)* — neither label mentions Mapbox — so the caption introduced a third name for
  things the reader was already being shown under other names.
- **`fadeDuration: 0` is now set on the `Map`.** MapLibre cross-fades new tiles in over 300 ms by
  default, which on a 220-pixel panel reads as the map still arriving. No measurement needed: it is
  a canvas fade, so no probe can see it — one look at two reloads is the whole test.

**Deliberately left alone.**

1. **`app/src/styles/vendors.css:979` — `.vsmap__canvas .mapboxgl-ctrl-attrib` matches nothing**
   (measured: the element is `maplibregl-ctrl-attrib`, the computed size is MapLibre's 12px, not
   the sheet's 10px). Left alone: it is a type size on an attribution line, and renaming the
   selector is a one-line change that deserves to be made deliberately rather than inside this pass.
   Note the sheet still carries a **`mapboxgl-`** class, so this file is now the only place in the
   panel where the old library's name survives — a future reader grepping for it will find this.
2. **The geocode script's row-versus-`.env` advisory guard is dead.**
   `server/src/scripts/geocode-vendor-sites.ts` reads `process.env.MAPBOX_START_LATITUDE` /
   `MAPBOX_START_LONGITUDE`, names that appear **nowhere** in `.env` (which holds `START_LATITUDE` /
   `START_LONGITUDE`). `Number('')` is `0` and `Number.isFinite(0)` is true, so the guard "warns" by
   comparing the stored origin against **0, 0** — it can fire on nothing and can never fire on the
   thing it was written for. Left alone: it is advisory, and it is inside the geocoding script, which
   this change is not about.

**Not a defect** (recorded so it is not re-opened): the origin row stored as *"Raleigh, North
Carolina"* reverse-geocodes to **605 Kildaire Farm Road, Cary, NC 27511** — 8.01 mi west of
downtown Raleigh. Every stored route departs that point and its first step says so (*"Drive
northeast on Kildaire Farm Road"*, identical on sites 95834, 7650 and 828535), the basemap prints
"Cary" under the origin pin, and that coordinate **is** the intended drive-from origin. The name is
a business label; the coordinate is the datum. Both stay, and the per-site distances are unaffected.

---

## 12. How to reuse this elsewhere

1. `npm i maplibre-gl` — nothing else. Remove `mapbox-gl` and `@types/mapbox-gl` if they were there.
2. Find a **keyless, complete** style (`<host>/styles/<name>`) and put it in one constant.
3. Give the map container a **height of its own** and `position: relative`.
4. Write `loadMaplibre()` exactly as in §5d, with **`setWorkerUrl` before any `Map`**.
5. **Never pass an `accessToken`.** If a style genuinely needs one, test that API's entitlement
   separately first (§3), and keep the token server-side so it cannot be blanked by a browser
   restriction.
6. Keep the construction effect's dependencies to numbers and nulls, and carry late-arriving data
   in refs (§7a, §7b).
7. Reconcile the stylesheet against the markup — **grep every class the sheet invents and check the
   markup emits it** — and re-check the control class prefix after any library swap (§8).
8. Verify with the probes in §9, **on a freshly opened tab**, and look at one render.

---

## 13. How to re-verify

```
GET  /api/health                      → { ok: true, dbReady: true, db: { mode: 'oracle', … } }
GET  /api/vendor-site-register        → geo.origin, geo.sites[800], geo.counts
GET  /api/vendor-site-route/95834     → status 'ok', geometry[], steps[]
open  /vendors/sites?site=95834       → the Location panel: basemap, two pins, the road line,
                                        three mileages, and the turns behind `Details`
```

Then run the probe in §9a in that tab and compare against the table in §9. The two checks that matter
most, in this order: **`isSourceLoaded('openmaptiles')` true with a non-zero `queryRenderedFeatures()`**
(the worker resolved and tiles are drawing — the §9a probe *cannot* see this) and **`attribEmpty`
false with real attribution text** (the style loaded). `glyphPbf` non-zero corroborates it.

---

## 14. Files touched

| file | what changed |
| --- | --- |
| `app/package.json` | `maplibre-gl ^6.10.0` added (line 17); `mapbox-gl` / `@types/mapbox-gl` removed |
| `app/src/components/VendorSiteMap.tsx` | the whole panel: `STYLE_URL`, `loadMaplibre()` with `setWorkerUrl`, the construction with **no `accessToken`** (`fadeDuration: 0` added later, §11), the route refs and effects, the load-time sources and layers, `applyRoute`, `ResizeObserver`, teardown, and the tile-failure copy (which no longer names a token — it names the tile host, a proxy, a content filter or being offline). The mileage caption no longer names Mapbox either (§11) |
| `app/src/styles/vendors.css` | the `.vsmap*` block, lines 957–1116: frame, canvas height (`220px`, `180px` under 720px), key and swatches, coordinate line, band ramp, fact rows, turns. Line 979 still carries a **`mapboxgl-`** class that matches nothing (§8, §11) |
| `app/.env`, `app/.env.example` | `VITE_MAPBOX_TOKEN` **removed**, with comment blocks kept explaining why this folder holds no browser credential — and that the same token is still required, server-side, as the root `.env`'s `MAPBOX_API_KEY` |
| **not touched, deliberately** | the root `.env` (`MAPBOX_API_KEY` is still used by the server-side geocoding step; `START_LATITUDE` / `START_LONGITUDE` are the seed's recorded provenance — the app reads the origin out of `geo_origin`, not out of the environment), `server/src/scripts/geocode-vendor-sites.ts`, and `data/sql/turso/01-app.sql` |
