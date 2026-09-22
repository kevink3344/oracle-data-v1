/**
 * The vendor sites register — the address level under a vendor company, as the
 * places this tenant's money was actually sent.
 *
 * ── ★ WHERE THE CONTENT COMES FROM, AND WHY IT IS NOT THE SITES DIRECTORY ────
 *
 * **Oracle, live.** Not the Turso sample, not a fixture, and not the frozen extract.
 *
 * The obvious source for a page at this leaf is `PO_VENDOR_SITES_ALL`, which is what
 * §5.3 names and what the menu's `reads` field says. That table holds **99,316 rows
 * across 79,590 vendors** on this instance — every address any vendor has ever
 * registered, including the ones nothing was ever bought from. Listing it is not a
 * page; it is a dump. So this module reads `/api/vendor-site-register` instead,
 * which returns the sites **named by an in-scope purchase order**: one row per site,
 * with its address and its vendor, how many in-scope orders named it, and the
 * committed dollars on those orders.
 *
 * ★ THE DIRECTORY IS STILL SERVED, AT `/api/vendor-sites`, AND IT IS A DIFFERENT
 *   THING. That is the generic resource registered in `routes/vendors.ts`; it
 *   answers a site by id and a site search. This page is the register. The two paths
 *   are literal siblings because `/api/vendor-sites/register` would be answered by
 *   the resource's **id** route as a 400 about integer ids.
 *
 * ── ★ NO FROZEN FALLBACK EXISTS, SO THE 503 IS A STATE AND NOT A BUG ────────
 *
 * `data/oracle/full-output.json` carries no `VENDOR_ID` and no `VENDOR_SITE_ID`, so
 * it holds no site to group by and no vendor to name. Under a non-Oracle ledger —
 * `DB_MODE=local`, the configuration every test runs under — the endpoint answers
 * **503 `DB_UNAVAILABLE`**. That is not a failure to report and not a spinner to
 * leave standing: it is the honest answer to a question this configuration cannot
 * be asked, and `UnavailableError` below exists so the page can render it as an
 * explanation rather than as an error. Nothing is broken; there is no ledger.
 *
 * ── THE REGISTER, MEASURED THROUGH THE EXTRACT'S OWN SCOPE PREDICATE ────────
 *
 * The fund / program / fiscal-floor rule is imported from `scopeClause()` on the
 * server, which is the predicate `routes/extract.ts` builds for its own query — so
 * the two readers cannot drift into describing different populations. On the
 * shipped organization that is **fund `04`, programs `861`/`862`/`863`, fiscal floor
 * `2021-07-01`** (`start_fy = 2022`):
 *
 *     **800 sites · 715 vendors · 5,692 in-scope orders · 31,401 lines**
 *     **$2,797,825,956.73 committed**
 *
 * ★ THOSE FIGURES ARE A FUNCTION OF THE TENANT, NOT CONSTANTS, AND THE PAGE SAYS SO.
 *   Move `start_fy` in Settings and the population moves with it — the identical
 *   query at the previous floor gives 704 sites, 4,206 orders and
 *   $2,697,813,470.53. They are read off the payload's `scope` block and quoted with
 *   it, never written into a sentence. (Program `863` holds no rows in this scope —
 *   the extract reports it as a `scopeMismatch` — so the floor is the whole of the
 *   difference.)
 *
 * ── ★ THE OBVIOUS RULE FOR "DEPRECATED" MATCHES NOTHING, AND THAT IS THE FINDING ──
 *
 * The natural reading of *deprecated* is the site code: Oracle shops park the literal
 * text `DO NOT USE` in `VENDOR_SITE_CODE`. Measured against this register it matches
 * **zero of the 800 rows**, before or after stripping spaces, dashes and underscores.
 * That is a property of the data rather than of the query — the directory holds
 * **669** such codes across **567** vendors and **342** of them are named by *some*
 * purchase order, but **not one** is named by an in-scope order. The fiscal floor and
 * the program filter between them exclude the entire class. **A scope narrow enough to
 * be useful is also narrow enough to exclude a whole kind of row.**
 *
 * So the predicate is a union of three other signals, each of which is evidence
 * carried by the row:
 *
 *     `PURCHASING_SITE_FLAG = 'N'`        6 sites ·  108 orders ·  $4,829,603.18
 *     `INACTIVE_DATE IS NOT NULL`        35 sites ·  219 orders · $38,199,948.83
 *     the vendor is named `DO NOT USE`    1 site  ·   81 orders ·  $4,433,380.94
 *     ─────────────────────────────────────────────────────────────────────────
 *     union                              39 sites ·  243 orders · $38,567,580.12
 *     active                            761 sites · 5,449 orders · $2,759,258,376.61
 *
 * The signals sum to 42 sites and 408 orders against a union of 39 and 243 because
 * they overlap: 37 deprecated rows carry exactly one reason, one carries two (site
 * `651458`) and one carries all three (site `12364`). **`VendorSite.deprecatedReasons`
 * is therefore a list and not a flag, and every row names the ones that fired.** A
 * `retired` reason carries its date — `retired 2026-09-19` — because the date is the
 * evidence and the signal is the category.
 *
 * ── ★ DEPRECATED IS A DESCRIPTION, NOT AN EXCLUSION ─────────────────────────
 *
 * The 39 deprecated sites carry **243 real orders and $38,567,580.12** — 1.38% of
 * everything this register returns — and they span **2021-07-06 → 2026-07-02**, so
 * the tab is not a list of old activity either. Site `12364`, whose vendor is
 * literally named `DO NOT USE - PERFECTION EQUIPMENT CO INC` and the only row where
 * all three signals coincide, carries **81 orders worth $4,433,380.94**. The tabs
 * separate these rows for readability; they are included in every total the endpoint
 * returns, and the page prints both the tab's own total and the register's.
 *
 * ── ★ A `$0.00` ROW BESIDE A REAL ORDER COUNT IS TRUE, NOT MISSING ──────────
 *
 * A site's `amount` sums the **in-scope** lines of its orders. **26 of the 800 sites**
 * carry orders and no in-scope money at all (215 of the 5,692 order rows are `0`),
 * because every line on those orders was charged outside the scope. That is a
 * statement about where the lines were booked, and the page says it rather than
 * rendering an empty cell.
 *
 * ★ AND THE SCOPE CUTS THE OTHER WAY TOO: **139 of the 5,692** in-scope orders also
 *   carry lines charged outside the scope, so the register total is strictly less
 *   than "the sum of these orders" would be. That is the scope working.
 *
 * ── ★ ADDRESSES ARE SPARSE, AND THE SPARSENESS IS ON THE PAGE ───────────────
 *
 * The address is this leaf's whole reason to exist, and on this register it is
 * frequently absent: **624 of 800** sites have no `ADDRESS_LINE2` and **794** have no
 * `ADDRESS_LINE3`; **373** have no phone and **372** no area code; **2** have no state
 * and **1** more carries the literal string `CANADA` where a two-letter code belongs.
 * `vendorName`, `addressLine1`, `city` and `zip` are present on all 800 — checked, not
 * assumed. A page that rendered a missing line as an empty row would read as broken
 * when it is merely a record nobody finished; the panel names what is missing.
 *
 * Cities measure **351 distinct pairs and 342 after upper-casing** — 9 groups differ
 * only by case (`Hanover Park` against `HANOVER PARK`), which is why a city filter on
 * this page is described as approximate rather than offered as complete. Keyed on
 * `city|state`, because a city name in two states is two cities.
 *
 * ── ★ THE ROW KEY IS (vendor, site code), NOT THE CODE ──────────────────────
 *
 * **5 codes in this register are drawn by two different vendors each, which is 10
 * sites.** A lookup keyed on the code alone would silently merge two sites, so the
 * page's React key is the `vendorSiteId` and the search box matches the code *and*
 * the vendor name together. `counts.sitesSharingACodeWithAnotherVendor` reports the
 * site count — 10, not 5 — because that is what the field's name promises.
 *
 * `counts.sitesWhoseOrderVendorDiffers` is the same discipline applied to the join:
 * a site records its own `VENDOR_ID` and its orders record theirs on the header, and
 * the endpoint takes the *site's* answer and counts the rows where the two disagree
 * rather than trusting that they match. Measured: **0**.
 */

// The vendor fold, imported rather than re-derived: this page shows the same vendors
// the company register does, and a custom name must follow them here. A second local
// copy of `toUpperCase().replace(/[^A-Z0-9]/g, '')` would stop matching the moment
// either side changed, and it would stop matching *silently* — the only symptom being
// a custom name that does not appear on this page.
import { vendorKeyOf } from './vendors';

/**
 * ★ A 503 FROM THIS ENDPOINT IS A STATE, NOT A FAILURE.
 *
 * `DB_UNAVAILABLE` means *the register cannot be served here*, and the frozen extract
 * carries no site id at all, so there is nothing to fall back to and nothing partial to
 * serve. Kept as its own class so the page can tell it apart from a genuine error
 * without re-reading a status code.
 *
 * ★ THE SAME CODE COVERS TWO DIFFERENT FACTS, AND THE PAGE MUST NOT BLEND THEM.
 *
 * `DB_UNAVAILABLE` is answered in two places and they are not the same news:
 *
 *   - `routes/vendorSites.ts` refuses a ledger that is **not Oracle**. The ledger is
 *     answering; it simply holds no purchase order to fold. Nothing changes until the
 *     server is pointed elsewhere, so no reload button can help.
 *   - The error middleware answers for a database it **could not reach**. The ledger is
 *     configured correctly and is *down* — the same request succeeds the moment it
 *     comes back, so a retry is exactly the right thing to offer.
 *
 * The wire distinguishes them without a new field: the route names the store it looked
 * in (`details.store`), and the middleware's answer carries no `details` at all. That is
 * what `kind` reads. It exists because printing "the configured ledger has none" over an
 * unreachable ledger is not loose wording — it is a false statement about the data, and
 * it sends the reader to change a configuration that was never wrong.
 *
 * ★ NOTHING READS `kind` TODAY, AND THE SILENCE IS DELIBERATE (2026-09-21). The vendor
 *   site register prints one plain-language "database unavailable" message for any 503,
 *   so `kind`, `remedy` and the server's own `message` are all carried and not shown —
 *   see the box note in `routes/VendorSites.tsx`. The distinction stays computed here
 *   rather than deleted because it is a fact about the response, not a presentation
 *   choice, and the next surface that wants to tell the two apart should read it instead
 *   of re-deriving it from `details.store`. Do not mistake the silence for an oversight.
 */
export type UnavailableKind = 'configuration' | 'unreachable';

export class UnavailableError extends Error {
  readonly code: string;
  readonly remedy: string;
  readonly kind: UnavailableKind;
  constructor(message: string, kind: UnavailableKind, code = 'DB_UNAVAILABLE', remedy = '') {
    super(message);
    this.name = 'UnavailableError';
    this.kind = kind;
    this.code = code;
    this.remedy = remedy;
  }
}

/** Anything else the endpoint can say no with, carrying the server's own code. */
export class VendorSitesError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'VendorSitesError';
    this.code = code;
  }
}

/** The envelope the framework wraps every route's return value in. */
interface ErrorEnvelope {
  error?: { message?: string; code?: string; details?: unknown };
}

/** One purchase order, as it named a site. */
export interface VendorSiteOrder {
  /** The site the order named. Every order row points at a row in `sites`. */
  vendorSiteId: number;
  orderNumber: string;
  /** `APPROVED_DATE`, `YYYY-MM-DD`. */
  approvedDate: string;
  /** Distinct in-scope PO lines on this order. 31,401 across the register. */
  lineCount: number;
  /**
   * The order's **in-scope** committed dollars.
   *
   * ★ `0` ON 215 OF THE 5,692 ORDER ROWS, and that is not a gap — those orders carry
   *   lines and every line was charged outside the scope.
   */
  amount: number;
}

/** One site, and what this tenant committed at it. */
export interface VendorSite {
  /** `VENDOR_SITE_ID`. The row key — the **code is not**, see the module note. */
  vendorSiteId: number;
  /**
   * `VENDOR_SITE_CODE`, shown exactly as the ledger holds it.
   *
   * ★ NEVER PADDED AND NEVER NORMALISED. Measured across the 800: 9–15 characters,
   *   none space-padded, with **503** ending ` OP`, **83** ` OPE`, **188** ` OR` and
   *   **9** ` PY`; **94** start `EP-` and **550** begin with a digit. The trailing
   *   space-then-suffix is Oracle's site-purpose convention and it is load-bearing for
   *   a reader trying to match a row against the ledger.
   */
  siteCode: string;
  vendorId: number;
  /** `PO_VENDORS.VENDOR_NAME`, trimmed. Present on all 800 rows. */
  vendorName: string;
  /**
   * What the page shows: `vendorName`, unless a reader has saved a custom one.
   *
   * ★ THE SAME TWO-NAME SPLIT THE VENDOR REGISTER KEEPS, FOR THE SAME REASON. The
   *   site code and the vendor name are how a reader matches a row against the
   *   ledger, so `vendorName` stays exactly as Oracle holds it and anything that
   *   *finds* a site or a vendor keeps using it; `displayName` is only ever printed.
   *   {@link applyCustomNames} is its only writer.
   */
  displayName: string;
  /**
   * Whether `displayName` is a stored custom value — see the note on
   * `Vendor.custom`. Not `displayName !== vendorName`, because a reader may save the
   * ledger's own spelling and that is still their choice, with their name on it.
   */
  custom: boolean;
  /** Present on all 800, which is why the address is printed from it. */
  addressLine1: string | null;
  /** Absent on 624 of 800 — the commonest gap on the page. */
  addressLine2: string | null;
  /** Absent on 794 of 800. */
  addressLine3: string | null;
  city: string | null;
  /** Absent on 2 of 800, one of which reads `CANADA` rather than a code. */
  state: string | null;
  zip: string | null;
  /** Absent on 372 of 800. Printed beside the phone, because it is dialled with it. */
  areaCode: string | null;
  /** Absent on 373 of 800. */
  phone: string | null;
  /** `'N'` on 6 sites, which is one of the three deprecation signals. */
  purchasingSiteFlag: 'Y' | 'N' | null;
  /** Set on the 35 retired sites. The date is the evidence, not the category. */
  inactiveDate: string | null;
  /** In-scope orders that named this site. Max 271, on site `34088`. */
  orders: number;
  /**
   * Committed dollars: the sum of this site's orders' **in-scope** lines.
   *
   * ★ MAY BE `0` BESIDE A NON-ZERO `orders` — 26 sites, each of which does carry
   *   orders. A true statement about where the lines were booked.
   */
  amount: number;
  /** Which tab this row belongs on. The server's verdict, not the page's. */
  status: 'active' | 'deprecated';
  /**
   * ★ WHY, IN THE SERVER'S OWN WORDS, AND ALWAYS NON-EMPTY WHEN `status` IS
   *   `deprecated`. A list, because the signals overlap — 37 deprecated rows carry
   *   one reason, one carries two, and one carries all three. Never re-derived here:
   *   a second implementation of "is this site deprecated" is how the marker and the
   *   tab come to disagree.
   */
  deprecatedReasons: string[];
}

/** One of the three deprecation signals, with what it reaches. */
export interface VendorSiteSignal {
  /** The bare signal. A `retired` reason's date is evidence, not a category. */
  signal: string;
  sites: number;
  orders: number;
  amount: number;
}

/**
 * The same `DO NOT USE` rule applied to the **whole directory**, which is the only
 * place it matches anything.
 *
 * ★ THIS EXISTS SO AN EMPTY LIST IS EXPLAINED RATHER THAN SHOWN. A reader who knows
 *   Oracle's convention expects a DO NOT USE section; this block is the answer — the
 *   codes exist, in quantity, and not one of them is reachable from this page's
 *   scope.
 */
export interface VendorSiteDirectoryRule {
  /** The rule, spelled out by the server so the page does not restate it. */
  rule: string;
  /** Sites in `PO_VENDOR_SITES_ALL` whose code carries the token. 669. */
  sites: number;
  /** Distinct vendors holding one. 567. */
  vendors: number;
  /** Of those 669, the ones *some* purchase order names at all. 342. */
  withAnyOrder: number;
  /** ★ And the ones an **in-scope** order names: **0**. The finding, in a field. */
  namedByAnInScopeOrder: number;
}

/** The scope the endpoint applied, read off the request rather than assumed. */
export interface VendorSiteScope {
  slug: string;
  /** The organization whose configuration this is, so an unexpected fund is traceable. */
  name: string;
  fund: string;
  /** In the order the tenant holds them. `863` is here and holds no rows. */
  programs: string[];
  startFy: number;
  /** The fiscal floor, `YYYY-MM-DD`, derived from `startFy`. `2021-07-01` today. */
  from: string;
}

/** Every count the page needs, all folded from the same array as the rows. */
export interface VendorSiteCounts {
  /** 800 at the shipped scope. */
  sites: number;
  /** 761. */
  activeSites: number;
  /** 39 — a real tab with 243 real orders behind it. */
  deprecatedSites: number;
  /** 5,692 in-scope orders, each naming one of the sites above. */
  orders: number;
  activeOrders: number;
  /**
   * 243. **Not zero**, which is the answer to "is the deprecated tab a list of
   * nothing".
   */
  deprecatedOrders: number;
  /** Distinct in-scope PO lines behind those orders. 31,401 of 31,670 distributions. */
  lines: number;
  /** Distinct vendors on the register. 715. */
  vendors: number;
  /** Measured `0` — the join takes the site's vendor and this checks the header's. */
  sitesWhoseOrderVendorDiffers: number;
  /** ★ Sites — 10 — not codes. 5 codes are drawn by 2 vendors each. */
  sitesSharingACodeWithAnotherVendor: number;
}

/** The register's money, at both grains and on both tabs. */
export interface VendorSiteTotals {
  /** $2,797,825,956.73 — the sum of the sites' rounded amounts. */
  amount: number;
  activeAmount: number;
  deprecatedAmount: number;
  /**
   * The same money summed at the order grain before rounding.
   *
   * ★ CARRIED SO THE TWO GRAINS CANNOT DISAGREE UNSEEN. The endpoint rounds each
   *   site and then sums, so a column that adds up on screen has a footer that
   *   matches it; this is the unrounded figure beside it. They are equal today, and
   *   a page that showed only one of them would have no way to notice if they stopped
   *   being.
   */
  orderRowAmountTotal: number;
}

/** Dates and gaps, measured over the rows rather than asserted over the scope. */
export interface VendorSiteObserved {
  firstOrderDate: string | null;
  lastOrderDate: string | null;
  activeFirstOrderDate: string | null;
  activeLastOrderDate: string | null;
  deprecatedFirstOrderDate: string | null;
  deprecatedLastOrderDate: string | null;
  /** Distinct vendors on the Active tab only. 695 against the register's 715. */
  activeVendors: number;
  /** 271, on site `34088`. The page's ink is a consequence of this number. */
  maxOrdersOnOneSite: number;
  sitesWithoutPhone: number;
  sitesWithoutAreaCode: number;
  sitesWithoutAddressLine2: number;
  sitesWithoutAddressLine3: number;
  sitesWithoutState: number;
  sitesWithNonCodeState: number;
  sitesWithZeroAmount: number;
  ordersWithZeroAmount: number;
  sitesWithReusedCode: number;
  /** Keyed on `city|state`, so a city name in two states is two cities. 351. */
  distinctCities: number;
  /** 342 — 9 groups differ only by case. */
  distinctCitiesUpperCased: number;
  /** 46, of which 1 is not a two-letter code. */
  distinctStates: number;
}

/**
 * The origin every stored driving distance is measured from. One row, so a pair.
 *
 * ★ IT IS A ROW AND NOT A CONSTANT. Raleigh's coordinates live in `geo_origin` in the
 *   app store, seeded from the environment — see `MAPBOX_START_LATITUDE`. Keeping them
 *   in the store rather than in this module is what lets the map say *where* the
 *   distances were measured from instead of naming a city in a sentence.
 */
export interface VendorSiteGeoOrigin {
  slug: string;
  name: string;
  latitude: number;
  longitude: number;
}

/**
 * One site's position, and the road distance from the origin to it.
 *
 * ── ★ TWO AXES, DELIBERATELY NOT ONE STATUS ─────────────────────────────────
 *
 * `latitude`/`longitude` answer *where is this site*. `driveMiles` answers *how far is
 * it by road*. They are reported by two separate steps against two separate APIs and
 * they fail independently, so one field cannot carry both:
 *
 *     geocodeStatus  driveStatus   means
 *     matched        ok            a pin, and a distance measured from it
 *     matched        outside_us    a pin; no distance, by rule (not by failure)
 *     matched        unclassified  a pin; no distance, because the origin has none
 *     po_box         null          no pin, permanently — the address is a PO box
 *     no_match       null          no pin; the geocoder found no feature
 *
 * ★ `null` IS NOT `0` ON EITHER AXIS, AND THAT IS THE WHOLE POINT OF THIS TYPE.
 *   `driveMiles: 0` would mean the site sits at the origin. `latitude: 0` is the Gulf
 *   of Guinea. Both are printable and both would be lies; the map renders a missing
 *   distance as a blank with a reason.
 */
export interface VendorSiteGeo {
  /** `VENDOR_SITE_ID` — the join back to `VendorSite.vendorSiteId`. */
  siteId: number;
  /** `null` unless the row is `matched` **and** carries both halves of a pair. */
  latitude: number | null;
  longitude: number | null;
  /** `matched` | `po_box` | `no_match` — the server's enum, as text for safety. */
  geocodeStatus: string;
  /** The server's prose for why this row landed in its pile. */
  geocodeReason: string | null;
  matchConfidence: string | null;
  accuracy: string | null;
  featureType: string | null;
  /** The address string actually sent to the geocoder — the evidence, not the input. */
  queryAddress: string | null;
  geocodedAt: string | null;
  /**
   * Road miles from the origin, from the Matrix API. `null` on 178 of the 800.
   *
   * ★ GATED ON THE PIN BY THE SERVER, so a row here cannot hold a distance that has
   *   lost the pin it was measured from — three rows did, before that guard.
   */
  driveMiles: number | null;
  driveMinutes: number | null;
  /** `ok` | `outside_us` | `unclassified` — and `null` on every un-pinned row. */
  driveStatus: string | null;
  /** Which origin the distance was measured from. Ties a figure to a row. */
  driveOriginSlug: string | null;
}

/**
 * The register-wide tallies, straight off the payload.
 *
 * ★ `awaitingDistance` IS AN EQUALITY THE SERVER COMPUTES FROM ITS OWN DEFINITION,
 *   not a restatement of a number it also sent: `matched − withDistance − outsideUs −
 *   unclassified − noRoute`, which is 0 on a settled store. It read **−3** once, and
 *   that impossible value is what found three rows carrying a distance with no pin.
 */
export interface VendorSiteGeoCounts {
  inScope: number;
  covered: number;
  notCovered: number;
  matched: number;
  poBox: number;
  noMatch: number;
  withDistance: number;
  outsideUs: number;
  unclassified: number;
  noRoute: number;
  awaitingDistance: number;
}

/**
 * The whole geocoding block.
 *
 * ★ `counts: null` MEANS *THE STORE DID NOT ANSWER*, AND IT MUST NOT BECOME ZEROS.
 *   `available: false` is the server saying the app store threw — a different fact from
 *   "the register has no positions", and the second one is unprintable when the first
 *   is true. The map renders the note and no markers rather than an empty world map.
 */
export interface VendorSiteGeoBlock {
  available: boolean;
  /** The server's own words for anything it suppressed. `null` when there is none. */
  note: string | null;
  origin: VendorSiteGeoOrigin | null;
  sites: VendorSiteGeo[];
  counts: VendorSiteGeoCounts | null;
}

/** The whole register. */
export interface VendorSiteRegister {
  /** Every site the scope named. The page's universe before filtering. */
  sites: VendorSite[];
  /** Every (site, order) pair **for the same rows**. A site's figures are their fold. */
  orders: VendorSiteOrder[];
  counts: VendorSiteCounts;
  totals: VendorSiteTotals;
  /** Always three entries, in the server's fixed order. */
  deprecatedSignals: VendorSiteSignal[];
  directory: VendorSiteDirectoryRule;
  scope: VendorSiteScope;
  observed: VendorSiteObserved;
  /** Where each site is, and how far it is by road. Keyed by `siteId`. */
  geo: VendorSiteGeoBlock;
}

/** Where the register lives. A literal sibling of the `/api/vendor-sites` resource. */
export const VENDOR_SITES_URL = '/api/vendor-site-register';

/**
 * Put the custom names on the site register.
 *
 * ★ IT DECORATES `sites` AND NOTHING ELSE, WHICH IS A CLAIM WORTH CHECKING RATHER
 *   THAN ASSUMING. Every count, total and observed figure in this register is folded
 *   from `status`, `orders` and `amount` — `counts.vendors` counts **distinct vendor
 *   ids**, not names, and `directory.vendors` is the server's own count. So no
 *   figure on the page changes when a name does, and a reader comparing the two
 *   registers still sees the same companies in the same number. If a count here ever
 *   starts folding a name, this decorator becomes wrong in a way nothing reports.
 */
export function applyCustomNames(
  register: VendorSiteRegister,
  labels: ReadonlyMap<string, string>,
): VendorSiteRegister {
  if (labels.size === 0) return register;

  const sites = register.sites.map((s) => {
    const custom = labels.get(vendorKeyOf(s.vendorName));
    if (custom === undefined) return s;
    return { ...s, displayName: custom, custom: true };
  });

  return { ...register, sites };
}

/**
 * Where one site's road route lives. Built from the id, so there is no route to typo.
 *
 * ★ A LITERAL SIBLING OF `VENDOR_SITES_URL`, FOR THE REASON THAT CONSTANT IS NOT
 *   `/api/vendor-sites/register`: the `/api/vendor-sites/{id}` resource takes an
 *   integer, so a nested `/route` would be answered by that resource's id route.
 */
export function vendorSiteRouteUrl(siteId: number): string {
  return `/api/vendor-site-route/${siteId}`;
}

/** One turn of the route, as the server projects it. */
export interface VendorSiteRouteStep {
  /** The routing service's sentence, verbatim. Never empty — the server substitutes. */
  instruction: string;
  /** The road this step runs along; `null` where the service names none. */
  name: string | null;
  /** This step's own length in miles. The arrival step carries `0`. */
  distanceMiles: number | null;
  durationMinutes: number | null;
  /** `turn` | `depart` | `arrive` | `merge` | `roundabout` | … */
  type: string | null;
  /** `left` | `slight right` | `uturn` | … `null` where the class has no side. */
  modifier: string | null;
  /** Longitude first, which is the order the service reports coordinates in. */
  longitude: number | null;
  latitude: number | null;
}

/**
 * One site's road route — the line to draw and the turns to read.
 *
 * ★ `status: null` IS NOT `'no_route'`, AND THIS TYPE IS WHERE THAT MATTERS MOST. A
 *   component that switches on `status` and treats anything not `'ok'` as "no road"
 *   will print the service's permanent `NoSegment` answer and "the step has not
 *   reached this site" as the same sentence — telling the reader there is no road to
 *   a place nobody has looked up. `null` is the one that shrinks; `no_route` never
 *   will. `'unpinned'` is a third: a row exists but its site lost the coordinate the
 *   route was measured from, so the line is withheld rather than drawn from a point
 *   that is no longer there.
 *
 * ★ AND `miles` HERE IS NOT `VendorSiteGeo.driveMiles`. Different API, different
 *   measurement, and they agree within a mile on only 11 of the 24 sites carrying
 *   both — disagreeing by up to 34.48 mi. Neither is wrong. Print each beside what it
 *   measures; never let one stand in for the other.
 */
export interface VendorSiteRoute {
  siteId: number;
  /** `'ok'` | `'no_route'` | `'error'` | `'unpinned'` | `null` (not asked yet). */
  status: string | null;
  /** The server's words for any status that is not `'ok'`. */
  reason: string | null;
  /** Distance in **statute miles**, from the Directions API — the drawn line's length. */
  miles: number | null;
  minutes: number | null;
  originSlug: string | null;
  /** `[longitude, latitude]` pairs in driving order, both endpoints included. */
  geometry: [number, number][] | null;
  steps: VendorSiteRouteStep[] | null;
  stepCount: number | null;
  routeAt: string | null;
  /** A caveat the server attached — e.g. a stale step count. Printed, never dropped. */
  note: string | null;
}

/**
 * Read one site's stored route.
 *
 * ★ FETCHED PER OPEN PANEL, NOT WITH THE REGISTER, AND THAT IS THE WHOLE REASON THIS
 *   ENDPOINT EXISTS. A stored route is ~12.6 KB and 90% of it is the turns; the
 *   register publishes 800 sites' worth of positions on every page load, so carrying
 *   lines there would add megabytes to the first paint of a page whose map is usually
 *   closed. The distance rides on the register because the caption needs one number;
 *   the line and its turns are asked for once.
 *
 * ★ AN ABORT RETHROWS RATHER THAN BECOMING A FAILURE — same contract as
 *   `loadVendorSites`. React 18 unmounts an effect twice in development, so the first
 *   request is aborted on purpose and turning that into an error state would report a
 *   failure for a request nobody wanted.
 */
export async function loadVendorSiteRoute(
  siteId: number,
  signal?: AbortSignal,
): Promise<VendorSiteRoute> {
  const res = await fetch(vendorSiteRouteUrl(siteId), { signal });
  if (!res.ok) throw await readError(res);

  const body = (await res.json()) as { data?: Record<string, unknown> };
  const data = body?.data;
  // ★ A `null` GEOMETRY IS A WELL-FORMED ANSWER, AND THIS GUARD USED TO CALL IT MALFORMED.
  //   `Array.isArray(null)` is false, so the old `!Array.isArray(data.geometry ?? null)` threw
  //   for `status: null` — the step has not reached this site — and for `'unpinned'`, the row
  //   exists but its coordinate was withdrawn. Those are precisely the two statuses whose
  //   geometry is null by design, and both are declared `[number, number][] | null` on the
  //   type above. The effect was that 619 of 622 sites rendered "the route endpoint answered
  //   without a site id …" — a false claim about a good payload, standing in the panel exactly
  //   where the server's honest note ("it has not reached this site yet") should have been.
  //   What is malformed is a geometry that is PRESENT and not an array; an absent one is how a
  //   route with no line is supposed to look.
  if (
    !data ||
    realOrNull(data.siteId) === null ||
    !('status' in data) ||
    !(data.geometry === null || data.geometry === undefined || Array.isArray(data.geometry))
  ) {
    throw new VendorSitesError(
      'The route endpoint answered without a site id, a status, or a geometry that is an array ' +
        'or absent — so this payload cannot be told apart from a route with no line.',
      'MALFORMED_RESPONSE',
    );
  }

  // ★ `geometry` IS VALIDATED PAIR BY PAIR AND A SHORT LINE IS REJECTED HERE TOO. A
  //   one-point line draws nothing while the caption says a route was measured, and a
  //   blank map under a confident caption is worse than a stated failure. The server
  //   checks this as well; a client that trusts a shape it cannot see is one payload
  //   change away from drawing nothing and calling it success.
  let geometry: [number, number][] | null = null;
  if (Array.isArray(data.geometry)) {
    const pairs: [number, number][] = [];
    for (const pair of data.geometry) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const lng = realOrNull(pair[0]);
      const lat = realOrNull(pair[1]);
      if (lng === null || lat === null) continue;
      pairs.push([lng, lat]);
    }
    if (pairs.length < 2) {
      throw new VendorSitesError(
        `The route for site ${siteId} carries ${pairs.length} usable coordinate pair(s), which is ` +
          'fewer than the two a line needs — so nothing can be drawn for a route that was measured.',
        'MALFORMED_RESPONSE',
      );
    }
    geometry = pairs;
  }

  const steps = Array.isArray(data.steps)
    ? data.steps.map((raw) => {
        const s = (raw ?? {}) as Record<string, unknown>;
        return {
          instruction: text(s.instruction),
          name: nullable(s.name),
          distanceMiles: realOrNull(s.distanceMiles),
          durationMinutes: realOrNull(s.durationMinutes),
          type: nullable(s.type),
          modifier: nullable(s.modifier),
          longitude: realOrNull(s.longitude),
          latitude: realOrNull(s.latitude),
        };
      })
    : null;

  return {
    siteId: figure(data.siteId),
    status: nullable(data.status),
    reason: nullable(data.reason),
    miles: realOrNull(data.miles),
    minutes: realOrNull(data.minutes),
    originSlug: nullable(data.originSlug),
    geometry,
    steps,
    stepCount: realOrNull(data.stepCount),
    routeAt: nullable(data.routeAt),
    note: nullable(data.note),
  };
}

/** A figure, or 0 — never `NaN`. One bad row must not poison a whole column. */
const figure = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Trimmed text, or `''`. */
const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

/** Nullable trimmed text — `null` stays `null`, because "absent" is the fact here. */
const nullable = (v: unknown): string | null => {
  const s = text(v);
  return s === '' ? null : s;
};

/**
 * A number, or `null` — never `NaN`, and never `0` standing in for an absent value.
 *
 * ★ `figure()` IS THE WRONG HELPER FOR A COORDINATE, A DISTANCE OR A COUNT OF THEM.
 *   It collapses "absent" onto 0, which is right for a money column that is genuinely
 *   zero and wrong for everything on this block: `driveMiles: 0` says the site sits at
 *   the origin and `latitude: 0` is the Gulf of Guinea. Both would print, and neither
 *   would look like a bug — which is exactly the failure a map cannot recover from,
 *   because a wrong pin is still a plausible-looking pin.
 */
const realOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** `'retired'` — the signal whose reason carries a date beside it. */
export const RETIRED = 'retired';

/** The three signals, in the order the server reports them. Used only as a fallback. */
export const SIGNAL_ORDER = [
  'not a purchasing site',
  RETIRED,
  'the vendor is named DO NOT USE',
] as const;

/**
 * The bare signal behind a reason, so `retired 2024-11-05` and `retired 2026-09-19`
 * group together.
 *
 * ★ THE SERVER'S RULE, MIRRORED — AND THE ONLY PLACE IT IS MIRRORED. The payload
 *   already sends `deprecatedSignals` with the bare signal names, and the page's
 *   per-signal legend reads *those*. This exists only so a row's own reason chips can
 *   be counted the same way; if the two ever disagree the server's numbers are the
 *   ones to trust.
 */
export function signalOf(reason: string): string {
  const bare = text(reason);
  return bare.startsWith(RETIRED) ? RETIRED : bare;
}

/**
 * A site's address as the lines that exist, in order.
 *
 * ★ `addrLine2`/`addrLine3` ARE OMITTED WHEN ABSENT RATHER THAN PLACEHOLDERED. 624 and
 *   794 of the 800 rows respectively, so a placeholder would be the commonest thing
 *   on the page. `addressLine1` is present on all 800 — verified, not assumed.
 */
export function addressLines(site: VendorSite): string[] {
  return [site.addressLine1, site.addressLine2, site.addressLine3]
    .map(nullable)
    .filter((v): v is string => v !== null);
}

/** `CITY, ST` — either half omitted when it is the one that is missing. */
export function cityLine(site: VendorSite): string {
  const city = text(site.city);
  const state = text(site.state);
  if (city && state) return `${city}, ${state}`;
  return city || state;
}

/**
 * The phone as printed, with its area code in parentheses.
 *
 * `phone` on this register holds an extension-shaped fragment (`800`, `0000`) for the
 * rows that carry one at all, so the two fields are printed as the ledger stores them
 * and joined here rather than reformatted into something that would imply a national
 * number the data does not contain.
 */
export function phoneLine(site: VendorSite): string {
  const phone = text(site.phone);
  const area = text(site.areaCode);
  if (!phone) return '';
  return area ? `(${area}) ${phone}` : phone;
}

/**
 * Which of the fields the leaf exists to show are absent, named for the reader.
 *
 * ★ THE SPARSENESS IS REPORTED PER ROW AND NOT ONLY IN A STATISTIC. A panel that
 *   prints three address lines of which two are blank reads as a rendering bug; this
 *   is what lets it say "no second or third address line on this record" instead.
 */
export function missingFields(site: VendorSite): string[] {
  const gaps: string[] = [];
  if (site.addressLine2 === null) gaps.push('second address line');
  if (site.addressLine3 === null) gaps.push('third address line');
  if (site.city === null) gaps.push('city');
  if (site.state === null) gaps.push('state');
  if (site.zip === null) gaps.push('ZIP');
  if (site.phone === null) gaps.push('phone');
  else if (site.areaCode === null) gaps.push('area code');
  return gaps;
}

/** Normalise a site row off the wire, so no consumer sees a `undefined`-shaped object. */
function toSite(raw: Record<string, unknown>): VendorSite {
  const flag = text(raw.purchasingSiteFlag);
  return {
    vendorSiteId: figure(raw.vendorSiteId),
    siteCode: text(raw.siteCode),
    vendorId: figure(raw.vendorId),
    vendorName: text(raw.vendorName),
    displayName: text(raw.vendorName),
    custom: false,
    addressLine1: nullable(raw.addressLine1),
    addressLine2: nullable(raw.addressLine2),
    addressLine3: nullable(raw.addressLine3),
    city: nullable(raw.city),
    state: nullable(raw.state),
    zip: nullable(raw.zip),
    areaCode: nullable(raw.areaCode),
    phone: nullable(raw.phone),
    purchasingSiteFlag: flag === 'Y' || flag === 'N' ? flag : null,
    inactiveDate: nullable(raw.inactiveDate),
    orders: figure(raw.orders),
    amount: figure(raw.amount),
    status: raw.status === 'deprecated' ? 'deprecated' : 'active',
    deprecatedReasons: Array.isArray(raw.deprecatedReasons)
      ? raw.deprecatedReasons.map((r) => text(r)).filter(Boolean)
      : [],
  };
}

/** Normalise an order row off the wire. */
function toOrder(raw: Record<string, unknown>): VendorSiteOrder {
  return {
    vendorSiteId: figure(raw.vendorSiteId),
    orderNumber: text(raw.orderNumber),
    approvedDate: text(raw.approvedDate),
    lineCount: figure(raw.lineCount),
    amount: figure(raw.amount),
  };
}

/** Normalise one site's position and distance off the wire. */
function toGeo(raw: Record<string, unknown>): VendorSiteGeo {
  return {
    siteId: figure(raw.siteId),
    latitude: realOrNull(raw.latitude),
    longitude: realOrNull(raw.longitude),
    geocodeStatus: text(raw.geocodeStatus),
    geocodeReason: nullable(raw.geocodeReason),
    matchConfidence: nullable(raw.matchConfidence),
    accuracy: nullable(raw.accuracy),
    featureType: nullable(raw.featureType),
    queryAddress: nullable(raw.queryAddress),
    geocodedAt: nullable(raw.geocodedAt),
    driveMiles: realOrNull(raw.driveMiles),
    driveMinutes: realOrNull(raw.driveMinutes),
    driveStatus: nullable(raw.driveStatus),
    driveOriginSlug: nullable(raw.driveOriginSlug),
  };
}

/**
 * Normalise the geocoding block.
 *
 * ★ THE COUNTS ARE THE ONE PLACE THIS DOES NOT FILL A GAP, AND IT IS DELIBERATE.
 *   Everywhere else a missing number becomes 0 by way of `figure()`; here the whole
 *   `counts` object is `VendorSiteGeoCounts | null`. The server sends `null` when the
 *   app store threw, and that is a different statement from "the register contains no
 *   positions" — the map's legend would print "0 of 800 sites have a position" and be
 *   describing a database outage. `null` survives, and the caller renders the note.
 */
function toGeoBlock(raw: Record<string, unknown>): VendorSiteGeoBlock {
  const origin = raw.origin as Record<string, unknown> | null | undefined;
  const counts = raw.counts as Record<string, unknown> | null | undefined;
  const sites = Array.isArray(raw.sites) ? raw.sites : [];
  return {
    available: raw.available === true,
    note: nullable(raw.note),
    origin:
      origin && typeof origin === 'object'
        ? {
            slug: text(origin.slug),
            name: text(origin.name),
            // Not `figure()`: an origin at (0, 0) would put every distance in the wrong
            // ocean, and the reader would have no way to tell.
            latitude: realOrNull(origin.latitude) ?? 0,
            longitude: realOrNull(origin.longitude) ?? 0,
          }
        : null,
    sites: sites.map((s) => toGeo(s as Record<string, unknown>)),
    counts: counts && typeof counts === 'object'
      ? {
          inScope: figure(counts.inScope),
          covered: figure(counts.covered),
          notCovered: figure(counts.notCovered),
          matched: figure(counts.matched),
          poBox: figure(counts.poBox),
          noMatch: figure(counts.noMatch),
          withDistance: figure(counts.withDistance),
          outsideUs: figure(counts.outsideUs),
          unclassified: figure(counts.unclassified),
          noRoute: figure(counts.noRoute),
          awaitingDistance: figure(counts.awaitingDistance),
        }
      : null,
  };
}

/** Read the error body, keeping the server's own code rather than inventing one. */
async function readError(res: Response): Promise<Error> {
  let message = `HTTP ${res.status} ${res.statusText}`;
  let code = `HTTP_${res.status}`;
  let details: unknown;
  try {
    const body = (await res.json()) as ErrorEnvelope;
    if (body?.error?.message) message = body.error.message;
    if (body?.error?.code) code = body.error.code;
    details = body?.error?.details;
  } catch {
    /* The status line stands. A body that is not JSON is not worth failing over twice. */
  }
  if (res.status === 503 || code === 'DB_UNAVAILABLE') {
    // A named store is the route refusing a ledger it read; no store at all is the
    // middleware answering for one it could not open. See `UnavailableError`.
    const store = (details as { store?: unknown } | undefined)?.store;
    const named = typeof store === 'string' && store !== '';
    return new UnavailableError(
      message,
      named ? 'configuration' : 'unreachable',
      code,
      named ? store : '',
    );
  }
  return new VendorSitesError(message, code);
}

/**
 * `GET /api/vendor-site-register` — the register, live from the ledger.
 *
 * ★ THE RESPONSE IS CHECKED FOR SHAPE, NOT TRUSTED. A route that answers 200 with no
 *   `sites` array would otherwise render as an empty page with a confident "0 sites"
 *   summary — the failure mode this app keeps finding, where a missing value and a
 *   real zero are indistinguishable. The counts, the scope block and the site array
 *   are all required; anything else throws.
 *
 * ★ AN ABORT RETHROWS RATHER THAN BECOMING A FAILURE. React 18 unmounts an effect
 *   twice in development, so the first request is aborted on purpose; turning that
 *   into an error state would show a failure for a request nobody wanted.
 */
export async function loadVendorSites(signal?: AbortSignal): Promise<VendorSiteRegister> {
  const res = await fetch(VENDOR_SITES_URL, { signal });
  if (!res.ok) throw await readError(res);

  const body = (await res.json()) as { data?: Record<string, unknown> };
  const data = body?.data;
  if (!data) {
    throw new VendorSitesError(
      'The vendor site register answered without a payload.',
      'MALFORMED_RESPONSE',
    );
  }

  const sites = data.sites;
  const orders = data.orders;
  const counts = data.counts as Record<string, unknown> | undefined;
  const totals = data.totals as Record<string, unknown> | undefined;
  const scope = data.scope as Record<string, unknown> | undefined;
  const observed = data.observed as Record<string, unknown> | undefined;
  const geo = data.geo as Record<string, unknown> | undefined;
  if (
    !Array.isArray(sites) ||
    !Array.isArray(orders) ||
    !counts ||
    !totals ||
    !scope ||
    !observed ||
    !geo ||
    typeof geo !== 'object'
  ) {
    throw new VendorSitesError(
      'The vendor site register answered without sites, orders, counts, totals, a scope, the ' +
        'observed block or the geocoding block — so nothing on this page could be trusted even ' +
        'where it had a value.',
      'MALFORMED_RESPONSE',
    );
  }

  const directory = (data.directory ?? {}) as Record<string, unknown>;
  const signals = Array.isArray(data.deprecatedSignals) ? data.deprecatedSignals : [];

  return {
    sites: sites.map((s) => toSite(s as Record<string, unknown>)),
    orders: orders.map((o) => toOrder(o as Record<string, unknown>)),
    counts: {
      sites: figure(counts.sites),
      activeSites: figure(counts.activeSites),
      deprecatedSites: figure(counts.deprecatedSites),
      orders: figure(counts.orders),
      activeOrders: figure(counts.activeOrders),
      deprecatedOrders: figure(counts.deprecatedOrders),
      lines: figure(counts.lines),
      vendors: figure(counts.vendors),
      sitesWhoseOrderVendorDiffers: figure(counts.sitesWhoseOrderVendorDiffers),
      sitesSharingACodeWithAnotherVendor: figure(counts.sitesSharingACodeWithAnotherVendor),
    },
    totals: {
      amount: figure(totals.amount),
      activeAmount: figure(totals.activeAmount),
      deprecatedAmount: figure(totals.deprecatedAmount),
      orderRowAmountTotal: figure(totals.orderRowAmountTotal),
    },
    deprecatedSignals: signals.map((s) => {
      const row = s as Record<string, unknown>;
      return {
        signal: text(row.signal),
        sites: figure(row.sites),
        orders: figure(row.orders),
        amount: figure(row.amount),
      };
    }),
    directory: {
      rule: text(directory.rule),
      sites: figure(directory.sites),
      vendors: figure(directory.vendors),
      withAnyOrder: figure(directory.withAnyOrder),
      namedByAnInScopeOrder: figure(directory.namedByAnInScopeOrder),
    },
    scope: {
      slug: text(scope.slug),
      name: text(scope.name),
      fund: text(scope.fund),
      programs: Array.isArray(scope.programs) ? scope.programs.map((p) => text(p)) : [],
      startFy: figure(scope.startFy),
      from: text(scope.from),
    },
    observed: {
      firstOrderDate: nullable(observed.firstOrderDate),
      lastOrderDate: nullable(observed.lastOrderDate),
      activeFirstOrderDate: nullable(observed.activeFirstOrderDate),
      activeLastOrderDate: nullable(observed.activeLastOrderDate),
      deprecatedFirstOrderDate: nullable(observed.deprecatedFirstOrderDate),
      deprecatedLastOrderDate: nullable(observed.deprecatedLastOrderDate),
      activeVendors: figure(observed.activeVendors),
      maxOrdersOnOneSite: figure(observed.maxOrdersOnOneSite),
      sitesWithoutPhone: figure(observed.sitesWithoutPhone),
      sitesWithoutAreaCode: figure(observed.sitesWithoutAreaCode),
      sitesWithoutAddressLine2: figure(observed.sitesWithoutAddressLine2),
      sitesWithoutAddressLine3: figure(observed.sitesWithoutAddressLine3),
      sitesWithoutState: figure(observed.sitesWithoutState),
      sitesWithNonCodeState: figure(observed.sitesWithNonCodeState),
      sitesWithZeroAmount: figure(observed.sitesWithZeroAmount),
      ordersWithZeroAmount: figure(observed.ordersWithZeroAmount),
      sitesWithReusedCode: figure(observed.sitesWithReusedCode),
      distinctCities: figure(observed.distinctCities),
      distinctCitiesUpperCased: figure(observed.distinctCitiesUpperCased),
      distinctStates: figure(observed.distinctStates),
    },
    geo: toGeoBlock(geo),
  };
}
