import { useEffect, useRef, useState } from 'react';

import { num, pluralise } from '../data/format';
import {
  loadVendorSiteRoute,
  type VendorSite,
  type VendorSiteGeo,
  type VendorSiteGeoBlock,
  type VendorSiteGeoCounts,
  type VendorSiteRoute,
} from '../data/vendorSites';

/**
 * The map in a site's detail panel — where this address is, and how far it is by road
 * from the origin every stored distance was measured from.
 *
 * ── ★ WHY THE MAP IS IN THE PANEL AND NOT UNDER A `[Table | Map]` TOGGLE ────
 *
 * A register-wide map was the first design. It was dropped because the number worth
 * showing here is *one site's distance*, and the register's own filters (the Active /
 * Deprecated tab and the search box) already answer "which rows am I looking at" — a
 * second view of the same 800 rows would have needed its own legend explaining that the
 * pins did **not** match the tab, which is a note about the map rather than about the
 * sites. The map belongs where the address is, so it sits between the ADDRESS card and
 * the STATUS card and shows the address rather than a population.
 *
 * ── ★ THE PANEL SHOWS TWO EXTERNAL FACTS AND SAYS WHICH IS WHICH ────────────
 *
 * The geocoding and the road distances were both measured **by the server, once, and
 * stored** (`vendor_site_geo`). Nothing on this component calls an API that needs a
 * credential: the only network traffic opening this panel causes is the basemap's own
 * tiles, and the basemap is **keyless** — OpenFreeMap serves it to anyone who asks.
 * That is deliberate, and it is why the two metered APIs (Batch Geocoding, Matrix) can
 * stay billed per *row* rather than per *view*: a reader opening the same site ten
 * times cannot spend anything, and — unlike a token-scoped basemap — cannot be refused
 * either. The map is still mounted lazily and only when a site actually has a pin,
 * because a basemap nobody looks at is still bandwidth.
 *
 * ── ★ WHY THE BASEMAP IS OpenFreeMap VIA MAPLIBRE, AND NOT MAPBOX ───────────
 *
 * This panel rendered blank for a while, and the cause was neither the geometry, the
 * WebGL context, the container's height, nor the token's *URL restrictions*. The
 * account's public token was **not entitled to the Styles or Tiles APIs at all**.
 * Measured across four endpoints, three tokens and four header combinations,
 * `styles/v1` answered **401 with no `Origin` and no `Referer` sent at all** — and that
 * is the one result a URL restriction cannot produce, because there is no header for it
 * to evaluate. (`geocoding/v5` answered 200 throughout, which is why the server-side
 * geocoding and matrix steps kept working and the symptom read as "only the map is
 * broken".) Adding `localhost:5180` to the token's allowed URLs would never have fixed
 * it.
 *
 * ★ THE FIX IS A BASEMAP THAT NEEDS NO CREDENTIAL, NOT A DIFFERENT TOKEN — AND THAT IS
 *   ALSO WHY NOTHING ELSE HAD TO MOVE. The three mileages, the four status piles and the
 *   route with its turns all come from this app's own store; the basemap only *paints*
 *   them. Swapping the paint layer therefore fixes the blank map without touching a
 *   single figure. MapLibre GL JS is the API-compatible fork of Mapbox GL JS —
 *   `new maplibregl.Map`, `maplibregl.LngLatBounds`, the same style specification — so
 *   every layer defined below is unchanged from the Mapbox version that preceded them.
 *
 * ★ AND THE ROUTING DID NOT MOVE EITHER, DELIBERATELY. The directions a reader wants
 *   from the origin to the destination are **stored**: `vendor_site_route` holds 622
 *   origin→site road routes, each with its polyline and its turn-by-turn steps, and this
 *   component reads them from this app's own `/api/vendor-site-route/{id}`. Neither
 *   OpenFreeMap nor MapLibre routes anything — both are tiles only. That is a feature
 *   here rather than a gap: a stored route keeps rendering after a routing scope is
 *   lost, which is exactly what happened.
 *
 * ── ★ A SITE WITH NO PIN GETS WORDS, NOT AN EMPTY MAP ───────────────────────
 *
 * **173 of the 800 register sites have no coordinate**, and they fall into piles that
 * mean different things: 146 are PO boxes (a permanent property of the address, not a
 * failure of the lookup) and 27 the geocoder spent a request on and could not find. An
 * empty world map with a "no location" chip would flatten those into one thing. Each
 * pile gets its own sentence, and the register-wide tally is printed beside the row's
 * own so "this record has no position" is never confused with "this page has none".
 *
 * ── ★ THE LINE DRAWN IS THE ROAD, AND THE STRAIGHT LINE IS GONE ─────────────
 *
 * This component used to draw a dashed straight line between the two pins. It does not
 * any more: the line is the **road route**, fetched per open panel from this app's own
 * `/api/vendor-site-route/{id}`, which serves a polyline the routing service produced
 * and the turns along it.
 *
 * ★ **AND THE CHANGE IS NOT COSMETIC, WHICH IS WHY THE OLD LINE HAD TO GO RATHER THAN
 *   SIT BESIDE THE NEW ONE.** A straight line on the same map as a road line is not a
 *   second opinion — it is an *invitation to measure the wrong thing*. The two differ
 *   by a factor a reader can see (they are different lengths on the same two points),
 *   so a map showing both asks the reader to work out which one the mileage belongs to;
 *   a map showing only the road answers it. The great-circle figure survives as a
 *   **number** in the caption, where it is a useful contrast with a street name under
 *   it — "as the crow flies, 640 mi; by road, 748 mi" is a fact about the address,
 *   whereas two lines of different lengths on a map is a puzzle.
 *
 * ★ **THE FALLBACK IS THE ONE PLACE A STRAIGHT LINE MAY STILL APPEAR, AND IT SAYS SO.**
 *   A site can have a pin and no stored route — the routing step has not reached it, or
 *   the service answered `NoSegment`. Then the map draws the old dashed connector *and*
 *   the caption names it as a straight line with no road behind it. Drawing nothing
 *   would leave two unlinked pins and read as a rendering fault; drawing the dashed
 *   line unlabelled is the exact lie this section exists to prevent.
 *
 * ── ★ THREE MILEAGES, THREE APIS, AND NONE MAY IMPERSONATE ANOTHER ──────────
 *
 * The panel prints three distances and every one of them is right. They are different
 * questions, so each is labelled with the question it answers:
 *
 *   - **Route (drawn)** — the Directions API's `route.distance`, the length of the line
 *     on the map. Fetched when the panel opens.
 *   - **By road (Matrix)** — the Matrix API's figure, stored on `vendor_site_geo` and
 *     sent with the register. This is the *banded* figure, so it is the one the pin's
 *     colour is about.
 *   - **As the crow flies** — haversine over the two points, computed in this file.
 *
 * ★ **THE FIRST TWO DISAGREE, AND SAYING SO IS PART OF THE DESIGN.** Measured on the
 *   sites carrying both, Matrix and Directions agree within one mile on only **11 of
 *   24** and differ by as much as **34.48 mi**, with Directions running *below* Matrix
 *   on the far sites. A fresh Matrix call reproduces the stored value to **0.0049 mi**,
 *   so that is not staleness: the two endpoints pick different routes between the same
 *   pair of points. Printing one and calling it "the distance" would be a claim the
 *   other API disputes, so the caption states the gap instead of hiding it.
 */

/**
 * The basemap — **keyless**, which is the whole point of choosing it.
 *
 * `liberty` rather than a satellite or terrain style: the question is "where is this and
 * how far", and roads and city labels answer that. It is a *complete* style rather than a
 * bare tile source — it declares its own vector source, its glyph endpoint
 * (`/fonts/{fontstack}/{range}.pbf`) and its sprite sheet — so nothing further has to be
 * specified here for labels and road shields to draw.
 *
 * ★ THE ATTRIBUTION STAYS ON. It is not decoration and not removable under the terms the
 *   tiles are served under: the TileJSON carries "OpenFreeMap · © OpenMapTiles · Data from
 *   OpenStreetMap", and MapLibre's `attributionControl` reads it out of the style rather
 *   than out of any string in this file. It is left at its default rather than turned off
 *   for tidiness.
 *
 * ★ AND THIS URL NEEDS NO TOKEN, NO ACCOUNT AND NO ALLOWED-ORIGIN LIST, so the exact
 *   failure that blanked this panel — a public token that is not entitled to the Styles
 *   API — cannot recur here.
 */
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';

/**
 * The module namespace itself. MapLibre exports `Map`, `LngLatBounds` and everything else
 * as **named** exports and has **no default export** — that is the one shape difference
 * between the two entry points, and it is why this file reads `maplibregl.Map` off the
 * namespace rather than off a `default`.
 */
type MaplibreLib = typeof import('maplibre-gl');

type LibState =
  | { kind: 'loading' }
  | { kind: 'ready'; lib: MaplibreLib }
  | { kind: 'failed'; message: string };

/**
 * ★ THE LIBRARY IS FETCHED ON DEMAND AND THE PROMISE IS HELD AT MODULE SCOPE, SO THE
 *   MAP LIBRARY IS DOWNLOADED ONCE AND ONLY IF A MAP IS EVER DRAWN. A static import at
 *   the top of this file would move that weight into the register's own chunk for every
 *   reader of the page, whether or not they click a row — and this map is reached by
 *   clicking a row. The build keeps the split: the library lands in its own chunk, so the
 *   register pays for it only if a reader opens a pinned site. React 18's development
 *   StrictMode also mounts every effect twice and a reader opening three sites mounts
 *   this component three times, so the promise is shared rather than re-created per
 *   render.
 *
 * ★ A REJECTION IS NOT CACHED. A chunk fetch fails when the network is down, and also
 *   when a deploy replaces the hashed filename under an open tab. Both are conditions a
 *   reload fixes, so holding the rejection would make the map permanently absent for the
 *   life of the page.
 */
let libPromise: Promise<MaplibreLib> | null = null;

/**
 * ★★ MAPLIBRE'S TILE WORKER HAS TO BE POINTED AT A URL THE BUNDLER ACTUALLY SERVES, OR
 *    EVERY VECTOR STYLE STALLS FOREVER — AND IT STALLS *SILENTLY*.
 *
 * Read out of the installed `maplibre-gl@6.10.0` (`dist/maplibre-gl-dev.mjs`):
 *
 *     function defaultWorkerUrl() {
 *       const moduleUrl = import.meta.url;
 *       const workerName = moduleUrl.endsWith('-dev.mjs') ? 'maplibre-gl-worker-dev.mjs'
 *                                                         : 'maplibre-gl-worker.mjs';
 *       return new URL(`./${workerName}`, moduleUrl).href;   // a SIBLING OF THE MODULE
 *     }
 *     ...
 *     const url = config.WORKER_URL || defaultWorkerUrl();
 *
 *   The worker is a sibling of the module the browser loaded. Under Vite that module is
 *   the *pre-bundled dependency* `/node_modules/.vite/deps/maplibre-gl.js`, so the worker
 *   is requested from `/node_modules/.vite/deps/maplibre-gl-worker.mjs` — a path the dep
 *   cache does not contain. `new Worker(…)` then fires its `error` event, and MapLibre
 *   swallows it: no `map.on('error')`, no console message, no failed request for a tile.
 *
 *   The visible symptom is a pale, label-free wash. Vector tiles and glyphs are *parsed in
 *   the worker*, so with a dead worker no `.pbf` request is ever made, no source ever
 *   reaches `loaded`, `map.on('load')` never fires — and therefore none of this file's own
 *   sources and layers are ever added. A **raster** style with an inline `tiles` array is
 *   unaffected, which is what made it look like a style-host problem rather than a worker
 *   problem. It is not: MapLibre's own `demotiles` style stalls here identically, and both
 *   host URLs answer 200 to a plain `fetch` from the page.
 *
 *   `?worker&url` makes Vite bundle the worker and hand back a URL it serves (in dev,
 *   `…/maplibre-gl-worker.mjs?worker_file&type=module`; in a build, an emitted, hashed
 *   asset), and `setWorkerUrl` is preferred over the derived default. This must run before
 *   the first `Map` is constructed, which is why it sits in this promise rather than in an
 *   effect.
 *
 * ★ VERIFIED: with this line the same page reports `isStyleLoaded() true`,
 *   `isSourceLoaded('openmaptiles') true`, `queryRenderedFeatures()` 253, real
 *   `/planet/**.pbf` AND `/fonts/**.pbf` requests, and `load` fires. Without it, both were
 *   zero and `load` never fired — deterministically, over three reloads.
 */
function loadMaplibre(): Promise<MaplibreLib> {
  if (!libPromise) {
    libPromise = import('maplibre-gl')
      .then(async (mod) => {
        // The stylesheet travels with the library rather than with the app, so a reader who
        // never opens a pinned site never downloads the control sprites either.
        await import('maplibre-gl/dist/maplibre-gl.css');
        // See the note above: without this the tile worker is fetched from a URL that does
        // not exist and every vector style stalls with no error of any kind.
        const workerUrl = (await import('maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url'))
          .default;
        mod.setWorkerUrl(workerUrl);
        return mod;
      })
      .catch((err: unknown) => {
        libPromise = null;
        throw err;
      });
  }
  return libPromise;
}

/**
 * The four distance bands, as an ordered ramp rather than four unrelated hues.
 *
 * ★ THE COLOURS ARE NOT THEME TOKENS, AND THAT IS THE ONE PLACE THIS FILE BREAKS THE
 *   RULE. Everywhere else in the app a colour comes from `tokens.css` so it is
 *   re-declared for the dark theme. These sit on map tiles, which do not change with
 *   the app theme, so a token would be answering a question nobody asked. Each is
 *   paired with a white stroke in the layer below, which is what separates a pin from
 *   whatever the basemap happens to be showing underneath it.
 *
 * ★ THE COLOUR IS NEVER THE ONLY CARRIER. The band is named in words in the caption
 *   and in the legend, so a reader who cannot separate the two blues still gets the
 *   figure — and the ordering is light-to-dark as well as blue-to-red, so it survives
 *   a colour-vision difference either way.
 */
interface Band {
  readonly label: string;
  readonly colour: string;
}

const BAND_UNDER_100: Band = { label: 'under 100 miles', colour: '#6aaed6' };
const BAND_TO_300: Band = { label: '100 to 300 miles', colour: '#2f6fa8' };
const BAND_TO_600: Band = { label: '300 to 600 miles', colour: '#d97a2b' };
const BAND_OVER_600: Band = { label: '600 miles and over', colour: '#a8322a' };
/** Pinned, and no road distance will be drawn — a different fact from "far away". */
const BAND_NO_DISTANCE: Band = { label: 'no road distance', colour: '#6b7280' };

const BANDS: readonly Band[] = [
  BAND_UNDER_100,
  BAND_TO_300,
  BAND_TO_600,
  BAND_OVER_600,
];

/** The origin's own mark. Fixed, and not on the ramp — it is not a distance. */
const ORIGIN_COLOUR = '#df6d1c';

/**
 * A distance, or the "none established" band.
 *
 * ★ NULL IS NOT ZERO AND FALLS INTO ITS OWN BAND. `driveMiles: 0` would mean the site
 *   sits at the origin and would print as the nearest band there is; a null means no
 *   distance was established, which is the opposite conclusion. The server already
 *   refuses to send a distance for a site with no pin; this keeps the same refusal on
 *   the drawing side.
 */
function bandOf(miles: number | null): Band {
  if (miles === null || !Number.isFinite(miles)) return BAND_NO_DISTANCE;
  if (miles < 100) return BAND_UNDER_100;
  if (miles < 300) return BAND_TO_300;
  if (miles < 600) return BAND_TO_600;
  return BAND_OVER_600;
}

/**
 * Great-circle miles between two points — a straight-line figure, not a drive.
 *
 * ★ THIS NUMBER NO LONGER DESCRIBES ANYTHING DRAWN. It was the length of the dashed
 *   connector; the connector is now the road, and this figure survives as the third
 *   row of the facts — the one distance that is about the geography rather than the
 *   roads, and the only one this file computes itself.
 *
 * Mean Earth radius, 3958.7613 statute miles. Accurate to a few tenths of a percent at
 * this range, which is far more precision than a "the line is not the road" figure
 * needs.
 */
function directMiles(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 3958.7613;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Whole miles, with a thousands separator, for a distance that has decimal places. */
const miles = (n: number): string => num(Math.round(n));

/** `4 h 12 m` from minutes. Null when the duration is absent, which it can be alone. */
function duration(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes)) return null;
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} m`;
}

/**
 * Why there is no road distance, in words, for each state the server can send.
 *
 * ★ THE FOUR `driveStatus` VALUES ARE FOUR DIFFERENT THINGS AND THREE OF THEM ARE NOT
 *   FAILURES. `outside_us` and `unclassified` are answers — the register deliberately
 *   does not route them — and `null` is the only one that says "not done yet". A
 *   single "no distance" label would make a correct abstention look like a gap, which
 *   is the reading this app spends most of its notes preventing.
 */
function noDistanceReason(row: VendorSiteGeo, originName: string): string {
  switch (row.driveStatus) {
    case 'ok':
      // ★ NAMED AS THE BAND'S FIGURE, BECAUSE IT IS NO LONGER THE ONLY ROAD NUMBER HERE.
      //   "Measured by road" was unambiguous while it was alone; beside a second road
      //   figure it would read as a description of either — and the band's whole job is
      //   to colour the pin from *this* number, not from the drawn route's.
      return (
        `The banded distance was measured from ${originName} by the routing service\u2019s ` +
        'distance-matrix endpoint, which is what the pin\u2019s colour is drawn from. The line on ' +
        'the map comes from its directions endpoint and can differ by a few miles — where they ' +
        'differ, the row above says by how much and why.'
      );
    case 'outside_us':
      return (
        'No road distance: the address on file places this site outside the United States, ' +
        'so no route was requested. The blank is the answer rather than a gap.'
      );
    case 'unclassified':
      return (
        'No road distance: the country could not be established from this site\u2019s state ' +
        'field, so no route was requested. The site is pinned; only the route is withheld.'
      );
    case 'no_route':
      return 'No road distance: the routing service returned no route between the origin and this pin.';
    default:
      return (
        'No road distance has been measured yet. The pin exists, so re-running the distance ' +
        'step is expected to fill this in.'
      );
  }
}

/** Why there is no pin, in words, for each pile the geocoder sorts a row into. */
function noPinReason(row: VendorSiteGeo): string {
  const because = row.geocodeReason ? ` ${row.geocodeReason}` : '';
  switch (row.geocodeStatus) {
    case 'po_box':
      return (
        'This address names a PO box and no street, so it was refused before any request was ' +
        `sent. A PO box has no position to look up, which makes this permanent rather than a gap.${because}`
      );
    case 'no_match':
      return (
        'The geocoder was asked for this address and found no feature for it, so there is no ' +
        `pin to draw.${because}`
      );
    default:
      return `This site carries no usable coordinate.${because}`;
  }
}

/** `a`, `a and b`, `a, b and c` — the list the legend arithmetic is written into. */
function sentenceList(parts: string[]): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * The register-wide tally, and the check that keeps it honest.
 *
 * ★ THE PILES ARE NAMED AND THE UNPLOTTED TOTAL IS DERIVED, SO THE TWO CAN DISAGREE.
 *   `unplotted` is `inScope − matched`; the named piles are `poBox + noMatch +
 *   notCovered`. On a settled store those are the same number and the sentence reads as
 *   one claim. When they are not, the sentence prints both rather than picking one —
 *   because the alternative is a legend that quietly reports a population nothing
 *   accounts for, which is the shape of the bug that put `awaitingDistance` at −3 on
 *   the server.
 */
function RegisterLegend({ counts }: { counts: VendorSiteGeoCounts }) {
  const unplotted = Math.max(0, counts.inScope - counts.matched);
  const piles: string[] = [];
  if (counts.poBox > 0) piles.push(`${num(counts.poBox)} name a PO box and no street`);
  if (counts.noMatch > 0) piles.push(`${num(counts.noMatch)} the geocoder found no address for`);
  if (counts.notCovered > 0) piles.push(`${num(counts.notCovered)} the job has not reached`);
  const accounted = counts.poBox + counts.noMatch + counts.notCovered;

  return (
    <p className="vsmap__legend">
      <strong>Across the register</strong> {num(counts.matched)} of the {num(counts.inScope)}{' '}
      sites have a position.{' '}
      {unplotted > 0 ? (
        <>
          The other {pluralise(unplotted, 'site')} {piles.length > 0 ? 'break down as ' : ''}
          {sentenceList(piles)}.
        </>
      ) : (
        <>Every one of them is plotted.</>
      )}
      {accounted !== unplotted ? (
        <>
          {' '}
          <em>
            Those named piles account for {num(accounted)}, not {num(unplotted)} — a
            disagreement in the store rather than in this panel.
          </em>
        </>
      ) : null}{' '}
      {counts.withDistance > 0 ? (
        <>
          {num(counts.withDistance)} carry a road distance; {num(counts.outsideUs + counts.unclassified)}{' '}
          are pinned with none by rule.
        </>
      ) : null}
    </p>
  );
}

export default function VendorSiteMap({
  site,
  geo,
}: {
  /** The row the panel is open on. Only the site code and the join key are used. */
  site: VendorSite;
  /** The whole geocoding block off the register payload. */
  geo: VendorSiteGeoBlock;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [mapError, setMapError] = useState<string | null>(null);
  const [lib, setLib] = useState<LibState>({ kind: 'loading' });
  const [route, setRoute] = useState<VendorSiteRoute | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [routeLoading, setRouteLoading] = useState(false);

  // ★ THE ROUTE ARRIVES AFTER THE MAP IS BUILT, SO THE TWO ARE BRIDGED BY REFS RATHER
  //   THAN BY ADDING `route` TO THE DRAW EFFECT'S DEPENDENCIES. Keying the draw effect on
  //   the route would tear the whole map down and stand it up again the moment the fetch
  //   returned — a second metered map load per panel, plus the reader's pan and zoom
  //   thrown away, to change one source. Instead the map publishes a *setter* here and
  //   the route effect calls it; the coordinates are also held in a ref so a route that
  //   arrives **before** Mapbox finishes loading is applied in `map.on('load')` rather
  //   than dropped by an `undefined` source.
  const routeSetterRef = useRef<((coords: [number, number][] | null) => void) | null>(null);
  const routeCoordsRef = useRef<[number, number][] | null>(null);

  // ★ THE JOIN IS GUARDED ON THE KEY, NOT ON THE RESULT. `figure()` collapses an absent
  //   number onto 0, so a register row and a geo row that had each lost a key would both
  //   read 0 and `.find()` would return a row that has nothing to do with this site —
  //   and a guard on the *result* would see a real object and pass. `VENDOR_SITE_ID` is a
  //   primary key in both stores, so a 0 is malformed rather than small.
  const key = site.vendorSiteId;
  const keyUsable = Number.isFinite(key) && key > 0;
  const row = keyUsable ? geo.sites.find((s) => s.siteId === key) ?? null : null;
  const origin = geo.origin;
  const lat = row?.latitude ?? null;
  const lng = row?.longitude ?? null;
  const pinned = lat !== null && lng !== null;
  const band = bandOf(row?.driveMiles ?? null);
  const direct = pinned && origin ? directMiles(origin.latitude, origin.longitude, lat, lng) : null;
  const drive = row?.driveMiles ?? null;
  const driven = duration(row?.driveMinutes ?? null);
  const routeGeometry = route?.status === 'ok' && route.geometry ? route.geometry : null;

  /**
   * Fetch the stored road route for the site whose panel is open.
   *
   * ★ ONE REQUEST PER PANEL, AND THAT IS THE POINT OF THE ENDPOINT. A stored route is
   *   ~12.6 KB with 90% of it turns, so it cannot ride on the register payload that
   *   publishes all 800 sites; it is asked for here, once, for one site — and only for a
   *   site that has a pin, since a route is measured from one.
   *
   * ★ AND IT IS *NOT* GATED ON THE MAP LIBRARY. The route is text and numbers that the
   *   caption needs whether or not the basemap ever loads — a tile host that is blocked or
   *   unreachable would otherwise take the mileage, the band and the turns down with it,
   *   and none of those three depends on a tile.
   */
  useEffect(() => {
    if (!keyUsable || !pinned) {
      setRoute(null);
      setRouteError(null);
      setRouteLoading(false);
      return;
    }
    const ctl = new AbortController();
    let alive = true;
    setRouteLoading(true);
    setRouteError(null);
    loadVendorSiteRoute(key, ctl.signal).then(
      (r) => {
        if (!alive) return;
        setRoute(r);
        setRouteLoading(false);
      },
      (err: unknown) => {
        if (!alive) return;
        // An abort is React 18's development double-mount, not a failure — the same
        // contract `loadVendorSites` keeps.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setRoute(null);
        setRouteLoading(false);
        setRouteError(err instanceof Error ? err.message : String(err));
      },
    );
    return () => {
      alive = false;
      ctl.abort();
    };
  }, [key, keyUsable, pinned]);

  /**
   * Hand the route's coordinates to the map — or take them away when there is no line.
   *
   * ★ THIS EFFECT HOLDS NO MAP. It publishes into a ref the draw effect owns, so it is
   *   safe to run before, during or after the map's construction: the setter returns
   *   quietly when the source does not exist yet, and the coordinates stay in the ref for
   *   `map.on('load')` to pick up.
   */
  useEffect(() => {
    routeCoordsRef.current = routeGeometry;
    routeSetterRef.current?.(routeGeometry);
  }, [routeGeometry]);

  /**
   * Fetch the library — **only when there is something to draw.**
   *
   * ★ THE UNPINNED SITES NEVER DOWNLOAD IT, AND NEITHER DOES A READER WHO NEVER OPENS A
   *   PANEL. `pinned` is now the *only* gate: the basemap is keyless, so there is no
   *   credential whose absence should stop the fetch.
   */
  useEffect(() => {
    if (!pinned) return;
    let alive = true;
    setLib({ kind: 'loading' });
    loadMaplibre().then(
      (m) => {
        if (alive) setLib({ kind: 'ready', lib: m });
      },
      (err: unknown) => {
        if (alive) {
          setLib({ kind: 'failed', message: err instanceof Error ? err.message : String(err) });
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [pinned]);

  /**
   * Draw the map.
   *
   * ★ EVERY DEPENDENCY IS A NUMBER OR A NULL, NOT AN OBJECT. The effect keys on the two
   *   coordinate pairs and the band colour rather than on `row` or `site`, both of which
   *   the loader rebuilds on every fetch — an object dependency would tear the map down and
   *   stand it up again on any refetch, spending a metered map load and losing the reader's
   *   pan and zoom for no reason.
   */
  useEffect(() => {
    if (lib.kind !== 'ready') return;
    const container = canvasRef.current;
    if (!container || !origin) return;
    // `pinned` narrows at the call site but not inside the effect body, so the pair is
    // re-checked here rather than asserted.
    const siteLat = lat;
    const siteLng = lng;
    if (siteLat === null || siteLng === null) return;

    const maplibregl = lib.lib;
    // ★ NO `accessToken` LINE HERE, AND ITS ABSENCE IS THE SWAP. Mapbox GL JS required one
    //   before it would request a style; MapLibre GL JS does not carry the property at all,
    //   and the style above is served to anyone who asks. The missing line is also why a
    //   mistyped, expired or unentitled token can no longer blank this panel.

    let map: InstanceType<typeof maplibregl.Map>;
    try {
      map = new maplibregl.Map({
        container,
        style: STYLE_URL,
        center: [siteLng, siteLat],
        zoom: 7,
        // MapLibre cross-fades new tiles in over 300 ms by default. In a panel this small the
        // fade reads as the map still arriving, so it is turned off and tiles land at once.
        fadeDuration: 0,
        // ★ NO SCROLL ZOOM, AND IT IS NOT A PREFERENCE. The map sits inside the panel's
        //   own scroll container, so a wheel over it would zoom the map instead of
        //   scrolling the page — the reader would lose their place and never be told
        //   why. The zoom buttons below are the accessible replacement, and they work
        //   from the keyboard.
        scrollZoom: false,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
      });
    } catch (err) {
      setMapError(err instanceof Error ? err.message : String(err));
      return;
    }

    // ★ A TILE FAILURE IS STILL CAUGHT AND NAMED, BUT IT CAN NO LONGER BE A TOKEN FAULT.
    //   The basemap is keyless, so the cause this handler used to lead with — a `pk.` token
    //   whose allowed-origin list excluded this host — is not reachable any more. What is
    //   left is a host or network problem: the tile host unreachable, a proxy or content
    //   filter refusing it, or the reader offline. Naming Mapbox here would now send the
    //   reader to the wrong place, so the message names what can actually be wrong.
    const onError = (e: unknown) => {
      const status = (e as { error?: { status?: number } })?.error?.status;
      const message = (e as { error?: { message?: string } })?.error?.message;
      if (status === 401 || status === 403) {
        setMapError(
          `The basemap host refused the request with HTTP ${status}. The basemap needs no ` +
            'token, so this is the tile host or something between this browser and it — a ' +
            'proxy, a content filter, or an offline connection — rather than a credential. ' +
            'The positions, the distances and the turns below are stored in this app and are ' +
            'unaffected by whether a tile can be fetched.',
        );
        return;
      }
      if (message) setMapError(message);
    };
    map.on('error', onError);

    /**
     * Frame the marks. Deferred rather than skipped when the container has no size yet,
     * because a drawer still measuring itself would otherwise fit the extent into a
     * zero-width viewport.
     *
     * ★ THE EXTENT IS BUILT FROM WAYPOINTS, NOT FROM TWO POINTS, AND IT IS BUILT FROM THE
     *   ROUTE'S OWN COORDINATES WHEN THERE IS ONE. A road route does not stay inside the
     *   box its two endpoints describe — a route that loops north to cross a river would
     *   be fitted to a frame that cuts the loop off, and the reader would be shown a line
     *   that leaves the map. Both endpoints are already in the stored geometry, so the
     *   route's array is a superset of the two pins and needs no separate handling.
     */
    let fitted = false;
    const fit = (extra: readonly (readonly number[])[] | null) => {
      if (container.clientWidth < 40 || container.clientHeight < 40) return;
      fitted = true;

      const lats = [origin.latitude, siteLat];
      const lngs = [origin.longitude, siteLng];
      for (const p of extra ?? []) {
        const plng = p[0];
        const plat = p[1];
        if (typeof plng !== 'number' || typeof plat !== 'number') continue;
        if (!Number.isFinite(plng) || !Number.isFinite(plat)) continue;
        lngs.push(plng);
        lats.push(plat);
      }

      // ★ A SITE AT THE ORIGIN MAKES A DEGENERATE EXTENT, and `fitBounds` on a zero-area box
      //   asks for infinite zoom. `maxZoom` is the backstop; the spread test is what keeps a
      //   same-city vendor from being shown at a single street.
      const spread =
        Math.max(...lats) - Math.min(...lats) + (Math.max(...lngs) - Math.min(...lngs));
      if (spread < 0.02) {
        const midLat = (Math.max(...lats) + Math.min(...lats)) / 2;
        const midLng = (Math.max(...lngs) + Math.min(...lngs)) / 2;
        map.setCenter([midLng, midLat]);
        map.setZoom(10);
        return;
      }
      const bounds = new maplibregl.LngLatBounds(
        [Math.min(...lngs), Math.min(...lats)],
        [Math.max(...lngs), Math.max(...lats)],
      );
      map.fitBounds(bounds, { padding: 56, maxZoom: 11, duration: 0 });
    };

    map.on('load', () => {
      // ── The road route ─────────────────────────────────────────────────────
      // ★ ADDED EMPTY AND FILLED LATER, BECAUSE THE FETCH AND THE LIBRARY RACE. The
      //   source has to exist for the draw effect to be able to update it, and the route
      //   may already be in memory by now — so the source is created with no coordinates
      //   and `setRoute` below applies whatever is known. Either order works, which is
      //   the point.
      map.addSource('vsmap-route', {
        type: 'geojson',
        data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } },
      });
      // ★ A CASING UNDER THE LINE, NOT A DECORATION. The basemap under a route is a road
      //   map — white, grey, yellow, blue — so a single-stroke line disappears wherever
      //   it crosses something similar. The wider white line beneath gives the route its
      //   own separation the way the pins' haloes do, and it is the reason the route stays
      //   legible over a motorway or a lake without any per-tile tuning.
      map.addLayer({
        id: 'vsmap-route-casing',
        type: 'line',
        source: 'vsmap-route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.85 },
      });
      map.addLayer({
        id: 'vsmap-route',
        type: 'line',
        source: 'vsmap-route',
        layout: { 'line-join': 'round', 'line-cap': 'round' },
        // Solid, and in the app's own primary rather than a map colour — this line is
        // ours, and the one thing on the map a reader must not mistake for map furniture.
        paint: { 'line-color': '#165788', 'line-width': 3.2 },
      });

      // ── The fallback: a straight line, drawn only when there is no road ─────
      // ★ THIS IS THE ONLY PLACE A STRAIGHT LINE MAY APPEAR, AND THE CAPTION NAMES IT.
      //   A pinned site with no stored route would otherwise show two unlinked pins,
      //   which reads as a rendering fault. Shown/hidden by `applyRoute`.
      map.addSource('vsmap-line', {
        type: 'geojson',
        data: {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: [
              [origin.longitude, origin.latitude],
              [siteLng, siteLat],
            ],
          },
        },
      });
      map.addLayer({
        id: 'vsmap-line',
        type: 'line',
        source: 'vsmap-line',
        paint: {
          'line-color': '#8a97a8',
          'line-width': 1.6,
          'line-dasharray': [2, 2],
        },
      });

      // Both pins as one source, because they are drawn by one layer with a data-driven
      // colour — so the white halo and the sizing are declared once and cannot drift
      // apart between the two markers.
      map.addSource('vsmap-pins', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: { kind: 'site', colour: band.colour },
              geometry: { type: 'Point', coordinates: [siteLng, siteLat] },
            },
            {
              type: 'Feature',
              properties: { kind: 'origin', colour: ORIGIN_COLOUR },
              geometry: { type: 'Point', coordinates: [origin.longitude, origin.latitude] },
            },
          ],
        },
      });
      map.addLayer({
        id: 'vsmap-pins',
        type: 'circle',
        source: 'vsmap-pins',
        paint: {
          'circle-radius': ['case', ['==', ['get', 'kind'], 'origin'], 8, 11],
          'circle-color': ['get', 'colour'],
          // The halo, and the reason a light pin is legible: the basemap under it is
          // whatever it happens to be, so the pin carries its own separation.
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2.5,
        },
      });

      // Whatever the route effect already knows, applied now that the sources exist.
      applyRoute(routeCoordsRef.current);
    });

    /**
     * Put the route on the map, or take it off — the one operation the route effect and
     * the load handler share.
     *
     * ★ EVERY CALL IS GUARDED, AND THE GUARD IS NOT PARANOIA: `getSource` returns
     *   `undefined` before `map.on('load')` and after `map.remove()`, and this function is
     *   reachable in both windows (the route can arrive first; a teardown can race a
     *   state update). A throw here would surface as an unhandled error in a React effect
     *   rather than as anything a reader could act on.
     *
     * ★ AND IT SWITCHES THE TWO LINES RATHER THAN DRAWING BOTH. A route and a straight
     *   line on one map is a map asking the reader to pick the right one to measure.
     */
    const applyRoute = (coords: [number, number][] | null): void => {
      try {
        const src = map.getSource('vsmap-route') as { setData?: (d: unknown) => void } | undefined;
        if (typeof src?.setData !== 'function') return;
        const has = coords !== null && coords.length >= 2;
        src.setData({
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: has ? coords : [] },
        });
        map.setLayoutProperty('vsmap-route', 'visibility', has ? 'visible' : 'none');
        map.setLayoutProperty('vsmap-route-casing', 'visibility', has ? 'visible' : 'none');
        map.setLayoutProperty('vsmap-line', 'visibility', has ? 'none' : 'visible');
        // ★ RE-FRAMED ON THE ROUTE, ONCE. The map was fitted to two points before the line
        //   existed; a road that leaves that box would be clipped by the frame it was
        //   fitted to. `fitted` is not reset, so this happens on the route's arrival and
        //   not on every later resize — the reader's pan still survives.
        if (has) fit(coords);
      } catch {
        /* A map already torn down is not a failure to report. */
      }
    };
    routeSetterRef.current = applyRoute;

    // ★ THE PANEL IS RESIZABLE, SO THE CANVAS IS TOO. The library sizes its canvas from
    //   the container at construction and does not watch it; without this, dragging the
    //   panel's grip leaves the map drawn at the old width with a dead strip beside it.
    const observer = new ResizeObserver(() => {
      try {
        map.resize();
        // ★ A MAP CONSTRUCTED BEFORE THE DRAWER HAD A SIZE NEVER GOT ITS FIT, so the first
        //   observation retries it. Only the first — re-fitting on every resize would throw
        //   away the reader's pan. The waypoints are read from the ref so the retry frames
        //   the route too if it has arrived by now.
        if (!fitted) fit(routeCoordsRef.current);
      } catch {
        /* A resize after teardown is not worth reporting. */
      }
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      map.off('error', onError);
      // ★ THE SETTER IS CLEARED BEFORE THE MAP GOES, so a route that resolves during
      //   teardown finds nothing to call rather than a source attached to a removed map.
      if (routeSetterRef.current === applyRoute) routeSetterRef.current = null;
      try {
        map.remove();
      } catch {
        /* Removing a map that already failed to initialise is not an error. */
      }
    };
  }, [lib, lat, lng, origin, band.colour]);

  const heading = (
    <div className="dsec__head">
      <h3 className="dsec__title">Location</h3>
      <span className="dsec__hint">
        {pinned ? `pinned · ${band.label}` : row ? `no position · ${row.geocodeStatus}` : 'no answer'}
      </span>
    </div>
  );

  /**
   * ★ A NOTE WE CANNOT RENDER IS STILL A NOTE WE MUST NOT SWALLOW. The server sends
   *   `note` only when it suppressed something, so it is rare by construction — and when
   *   it is present it is a caveat about the very figures this component is drawing.
   *   Printing it under the map is the only place in the app where it belongs.
   */
  const serverNote = geo.note ? <p className="vsmap__note">{geo.note}</p> : null;

  // ── 1. The app store did not answer ────────────────────────────────────────
  if (!geo.available) {
    return (
      <section className="dsec">
        {heading}
        <p className="vcnote">
          <strong>No positions were readable.</strong>{' '}
          {geo.note ??
            'The app store that holds the geocoded positions did not answer for this request.'}{' '}
          This is a statement about the store, not about this site — the site may well have a pin.
          Nothing is plotted rather than something guessed.
        </p>
      </section>
    );
  }

  // ── 2. The join key itself is unusable ─────────────────────────────────────
  if (!keyUsable) {
    return (
      <section className="dsec">
        {heading}
        <p className="vcnote">
          <strong>This register row carries no usable site id</strong>, so no geocoding row can be
          matched to it and nothing is plotted. That is a defect in the register payload rather
          than anything about the address — the id is a primary key on both sides, so it cannot
          legitimately be absent.
        </p>
      </section>
    );
  }

  // ── 3. The job never reached this site ─────────────────────────────────────
  if (!row) {
    return (
      <section className="dsec">
        {heading}
        <p className="vcnote">
          <strong>No geocoding answer exists for this site.</strong> It has no row in the geo table
          at all, which is a different fact from a lookup that failed: the job has not reached it.
          {geo.counts && geo.counts.notCovered > 0
            ? ` ${num(geo.counts.notCovered)} of the register's ${num(geo.counts.inScope)} sites are in this pile.`
            : ''}
        </p>
        {geo.counts ? <RegisterLegend counts={geo.counts} /> : null}
      </section>
    );
  }

  // ── 4. The site has no pin ─────────────────────────────────────────────────
  if (!pinned) {
    return (
      <section className="dsec">
        {heading}
        <p className="vcnote">{noPinReason(row)}</p>
        <p className="vcnote">
          <strong>What was asked:</strong>{' '}
          {row.queryAddress ? (
            <code>{row.queryAddress}</code>
          ) : (
            'no request was sent for this row'
          )}
          {row.geocodedAt ? ` · answered ${row.geocodedAt}` : ''}
        </p>
        {geo.counts ? <RegisterLegend counts={geo.counts} /> : null}
        {serverNote}
      </section>
    );
  }

  // ── 5. Pinned: the map itself ──────────────────────────────────────────────
  return (
    <section className="dsec">
      {heading}

      <div className="vsmap">
        <div
          ref={canvasRef}
          className="vsmap__canvas"
          // The map is a picture of coordinates that are all repeated in words below it,
          // so it is marked as an image for assistive tech rather than left as a canvas
          // with no name.
          role="img"
          aria-label={
            `Map of ${site.siteCode}` +
            (origin ? ` and ${origin.name}` : '') +
            // ★ THE LABEL NAMES THE LINE THAT IS ACTUALLY DRAWN. It used to say "miles apart
            //   by road" beside a straight line, which made the one description a
            //   screen-reader user gets the one thing the picture was not showing.
            (routeGeometry
              ? `, joined by the road route${route?.miles !== null && route?.miles !== undefined ? `, ${miles(route.miles)} miles` : ''}`
              : drive !== null
                ? `, ${miles(drive)} miles apart by road, with no route drawn`
                : ', with no road distance established')
          }
        />
      </div>

      {mapError ? (
        <p className="vcnote">
          <strong>The basemap did not draw:</strong> {mapError} The positions and the distances
          below are unaffected — they were measured by the server and are stored.
        </p>
      ) : null}

      <DriveFacts
        drive={drive}
        driven={driven}
        direct={direct}
        route={route}
        routeLoading={routeLoading}
        routeError={routeError}
        drawn={mapError === null}
        row={row}
        originName={origin?.name ?? 'the origin'}
      />

      {route?.note ? <p className="vcnote">{route.note}</p> : null}

      {route?.steps && route.steps.length > 0 ? <RouteTurns route={route} /> : null}

      <div className="vsmap__key">
        <span className="vsmap__swatch" style={{ background: ORIGIN_COLOUR }} aria-hidden="true" />
        <span>
          {origin ? origin.name : 'the origin'}
          {origin ? (
            <>
              {' · '}
              <span className="vsmap__coord">
                {origin.latitude.toFixed(4)}, {origin.longitude.toFixed(4)}
              </span>
            </>
          ) : null}
        </span>
        <span className="vsmap__swatch" style={{ background: band.colour }} aria-hidden="true" />
        <span>
          this site · <span className="vsmap__coord">{lat.toFixed(4)}, {lng.toFixed(4)}</span>
        </span>
      </div>

      <p className="vsmap__bands">
        <strong>Bands:</strong>{' '}
        {BANDS.map((b, i) => (
          <span key={b.label}>
            {i > 0 ? ' · ' : ''}
            <span className="vsmap__swatch vsmap__swatch--small" style={{ background: b.colour }} aria-hidden="true" />
            {b.label}
          </span>
        ))}
      </p>

      {geo.counts ? <RegisterLegend counts={geo.counts} /> : null}
      {serverNote}
    </section>
  );
}

/**
 * What the drawn line is, in words — and, when there is no line, why there is not.
 *
 * ★ THIS SENTENCE IS THE ONLY THING THAT CAN TELL A READER WHICH LINE THEY ARE LOOKING
 *   AT, AND THAT IS A DRAWING CONSTRAINT RATHER THAN A COPY CHOICE. A polyline and a
 *   two-point straight line are the same mark on a map; only the words distinguish
 *   them, and only for the case where they differ. So the caption changes with the
 *   route's status rather than sitting there as a fixed disclaimer that a reader learns
 *   to skip — and it says outright, in the fallback case, that the dashes are not a road.
 *
 * ★ `no_route` AND "NOT ASKED YET" GET DIFFERENT SENTENCES, AND THE SECOND ONE IS NOT A
 *   FAILURE. `no_route` is the routing service's own answer about this pair and will not
 *   change; an absent row means the step has not reached the site, and it is the one
 *   state a rerun is expected to move. Saying "no road route exists" for both would turn
 *   "nobody has looked" into a claim about the road.
 *
 * ★ `drawn` IS A PARAMETER BECAUSE ONE CALLER HAS NO MAP AT ALL. The basemap-failed branch
 *   prints these facts beside a canvas that stayed blank, and a caption reading "the line
 *   drawn is the dashed fallback" under a map that drew nothing is exactly the kind of
 *   sentence this whole component is written to avoid: true of the payload, false on the
 *   page.
 */
function routeCaption(
  route: VendorSiteRoute | null,
  loading: boolean,
  error: string | null,
  drawn: boolean,
): string {
  /**
   * The same facts with no reference to a picture. Used wherever no map rendered, so
   * every clause here describes the stored route rather than anything on screen.
   */
  const inWords = (): string => {
    if (error) return `The stored road route could not be read (${error}).`;
    if (loading && route === null) return 'Looking up the stored road route for this site.';
    if (route === null || route.status === null) {
      return (
        'No road route has been looked up for this site yet. That is not a failure — the routing ' +
        'step fills these in a few hundred at a time, and this site has not been reached.'
      );
    }
    const turns =
      route.stepCount !== null && route.stepCount > 0 ? ` and ${pluralise(route.stepCount, 'turn')}` : '';
    switch (route.status) {
      case 'ok':
        return (
          `A road route is stored for this site${route.miles !== null ? `: ${miles(route.miles)} miles` : ''}` +
          `${turns}, plotted by the routing service\u2019s directions endpoint.`
        );
      case 'no_route':
        return (
          'The routing service found no road route between the origin and this pin. This is the ' +
          'service\u2019s own answer and re-running the step will not change it.'
        );
      case 'unpinned':
        return (
          'A road route is stored for this site but the coordinate it was measured from has since ' +
          'been withdrawn, so the route is withheld rather than reported from a point that is no ' +
          'longer there.'
        );
      default:
        return route.reason
          ? `The stored road route could not be used (${route.reason}). Re-running the routing step for this site rewrites it.`
          : 'The stored road route could not be used. Re-running the routing step for this site rewrites it.';
    }
  };

  // ★ A NO-TRANSCRIPT PREFIX, NOT A NO-TRANSCRIPT SUFFIX. Stated first because a reader
  //   who has just been told there is no map should not have to reach the end of a
  //   sentence about a line to find out that there is no line.
  if (!drawn) return `No map is drawn here. ${inWords()}`;

  if (error) {
    return (
      `The stored road route could not be read (${error}), so the line drawn is the dashed ` +
      'fallback: a direct line between the two pins, not a road.'
    );
  }
  if (loading && route === null) {
    return 'Looking up the stored road route for this site — the dashed line shown meanwhile is a direct line between the two pins, not a road.';
  }
  if (route === null || route.status === null) {
    return (
      'No road route has been looked up for this site yet, so the dashed line drawn is a direct ' +
      'line between the two pins — not a road, and not the distance printed above. The routing ' +
      'step fills these in a few hundred at a time.'
    );
  }
  switch (route.status) {
    case 'ok':
      return route.originSlug
        ? `The solid line is the road route, as the routing service plots it, measured from the ` +
            `same origin the stored distance uses (${route.originSlug}).`
        : 'The solid line is the road route, as the routing service plots it.';
    case 'no_route':
      return (
        'The routing service found no road route between the origin and this pin, so the dashed ' +
        'line drawn is a direct line between them, not a road. This is the service\u2019s own answer ' +
        'and re-running the step will not change it.'
      );
    case 'unpinned':
      return (
        'A road route is stored for this site but the coordinate it was measured from has since ' +
        'been withdrawn, so the line is withheld rather than drawn from a point that is no longer ' +
        'there. The dashes are a direct line between the pins this payload does have.'
      );
    default:
      return route.reason
        ? `The stored road route could not be used (${route.reason}), so the dashed line drawn is a direct line between the two pins, not a road. Re-running the routing step for this site rewrites it.`
        : 'The stored road route could not be used, so the dashed line drawn is a direct line between the two pins, not a road.';
  }
}

/**
 * The figures, each tagged with the method that produced it.
 *
 * ★ THREE DISTANCES, THREE APIS, AND NOT ONE OF THEM IS ALLOWED TO IMPERSONATE ANOTHER.
 *   The route's own length comes from **Directions**, stored in `vendor_site_route`; the
 *   banded road figure from **Matrix**, stored in `vendor_site_geo` and sent with the
 *   register; the third is a haversine computed in this file. They answer different
 *   questions — *how long is the line I am drawing*, *how far is it by road*, *as the
 *   crow flies* — and the first two genuinely disagree, by up to 34.48 mi on the sites
 *   measured, agreeing within a mile on only 11 of 24. Printing one and calling it "the
 *   distance" is a claim the other endpoint disputes, so all three are printed and the
 *   caption states the gap. The direct figure keeps its place because "748 by road, 640
 *   as the crow flies" is a fact about the address, whereas two lines of different
 *   lengths on one map is a puzzle.
 */
function DriveFacts({
  drive,
  driven,
  direct,
  route,
  routeLoading,
  routeError,
  drawn,
  row,
  originName,
}: {
  drive: number | null;
  driven: string | null;
  direct: number | null;
  route: VendorSiteRoute | null;
  routeLoading: boolean;
  routeError: string | null;
  /** False wherever no map is on screen, so the caption cannot describe a line. */
  drawn: boolean;
  row: VendorSiteGeo;
  originName: string;
}) {
  const routeMiles = route?.status === 'ok' ? route.miles : null;
  const routeMinutes = route?.status === 'ok' ? duration(route.minutes) : null;
  // ★ THE GAP IS PRINTED, NOT AVERAGED AWAY. It is the tell that the two road figures are
  //   different measurements, and a reader who notices 748 beside a 727-mile line deserves
  //   to be told why rather than left to assume one of them is a bug.
  const gap =
    routeMiles !== null && drive !== null ? Math.abs(Math.round(routeMiles) - Math.round(drive)) : null;

  return (
    <div className="chkrows vsmap__facts">
      <div className="chkrow">
        <span className="chkrow__k">Route (drawn)</span>
        <span className="chkrow__v vc-num">
          {routeMiles !== null ? `${miles(routeMiles)} mi` : routeLoading ? '…' : '—'}
          {routeMinutes ? ` · ${routeMinutes}` : ''}
        </span>
      </div>
      <div className="chkrow">
        <span className="chkrow__k">By road (Matrix)</span>
        <span className="chkrow__v vc-num">
          {drive !== null ? `${miles(drive)} mi` : '—'}
          {driven ? ` · ${driven}` : ''}
        </span>
      </div>
      <div className="chkrow">
        <span className="chkrow__k">As the crow flies</span>
        <span className="chkrow__v vc-num">
          {direct !== null ? `${miles(direct)} mi` : '—'}
        </span>
      </div>
      <div className="chkrow">
        <span className="chkrow__k">From</span>
        <span className="chkrow__v">
          {row.driveOriginSlug ? originName : `${originName} — not named on this row`}
        </span>
      </div>
      {gap !== null && gap > 0 ? (
        <p className="vsmap__legend">
          The two road figures differ by {num(gap)} {gap === 1 ? 'mile' : 'miles'}. That is not a
          stale value: the two routing services behind these figures choose different routes
          between the same pair of points, and a fresh call to the second reproduces the stored
          figure to within a hundredth of a mile. Read each beside the question it answers.
        </p>
      ) : null}
      <p className="vsmap__legend">{noDistanceReason(row, originName)}</p>
      <p className="vsmap__legend">{routeCaption(route, routeLoading, routeError, drawn)}</p>
    </div>
  );
}

/**
 * The turns of the drawn route, in driving order.
 *
 * ★ THE LIST IS FOLDED BEHIND A SUMMARY RATHER THAN PRINTED IN FULL. A stored route here
 *   carries between 5 and 69 turns, and the panel is a 470-pixel drawer holding three
 *   other sections — 69 rows of prose would bury the address and the status card below a
 *   wall of text nobody asked for. The summary states the count and the first and last
 *   sentences, and the rest is one click away.
 *
 * ★ THE ZERO-DISTANCE ARRIVAL STEP IS KEPT AND SHOWN. It reads like a step that has lost
 *   its distance; it is the arrival, and it is the only row that tells the reader they
 *   have got there. The step's own length is printed beside it, which is honest precisely
 *   because the steps sum to the route's own distance to within 0.001 mi.
 *
 * ★ `distanceMiles` IS NULLABLE PER STEP AND RENDERS AS NOTHING RATHER THAN AS ZERO. A
 *   missing length is not a zero-length step — the same distinction the whole map turns on.
 */
function RouteTurns({ route }: { route: VendorSiteRoute }) {
  const steps = route.steps ?? [];
  if (steps.length === 0) return null;

  return (
    <details className="vsmap__turns">
      <summary>
        {pluralise(steps.length, 'turn')}
        {route.stepCount !== null && route.stepCount !== steps.length
          ? ` (the row also carries a count of ${num(route.stepCount)})`
          : ''}
      </summary>
      <ol className="vsmap__turnlist">
        {steps.map((s, i) => (
          <li key={`${i}-${s.instruction}`}>
            <span className="vsmap__turninstruction">{s.instruction}</span>
            {s.name ? <span className="vsmap__turnroad"> · {s.name}</span> : null}
            {s.distanceMiles !== null ? (
              <span className="vsmap__turnmiles vc-num">
                {s.distanceMiles < 0.1 ? '<0.1' : s.distanceMiles.toFixed(1)} mi
              </span>
            ) : null}
          </li>
        ))}
      </ol>
    </details>
  );
}
