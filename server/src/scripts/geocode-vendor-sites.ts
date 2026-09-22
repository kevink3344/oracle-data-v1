/**
 * Geocode the vendor-site register, and measure each pinned site's driving
 * distance from the origin in `geo_origin`.
 *
 * ── WHAT THIS IS ────────────────────────────────────────────────────────────
 *
 * Two jobs in one file, in this order, because the second is a function of the
 * first and a reader should not have to find two scripts to answer "where did
 * these pins come from":
 *
 *   1. **Geocode.** Read the register's own population from the ledger, geocode
 *      each DISTINCT address once through Mapbox Geocoding v6, and write one row
 *      per SITE into `vendor_site_geo`.
 *   2. **Distance.** Read the pins back, ask Mapbox Matrix for the road distance
 *      from the default `geo_origin` to each, and stamp `drive_*` on the row.
 *
 * ── WHERE THIS FILE LIVES, AND WHY IT IS NOT `server/scripts/` ──────────────
 *
 * `docs/plans/vendor-site-map.md` §4 names `server/scripts/geocode-vendor-sites.ts`,
 * beside the two `pull-*-extract.mjs` scripts. It is here instead because
 * `server/tsconfig.json` sets `rootDir: src` and its `include` list covers only
 * `src/`, so a `.ts` file outside `src/` is **not typechecked by
 * `npm run typecheck`** — and this is the one script in the repository that
 * imports a *typed route module* (`scopeClause`, below). An untypechecked script
 * calling a typed module is exactly where a `strict` violation hides, and the
 * repo already keeps a typed script at `src/scripts/smoke.ts`. The deviation is
 * this paragraph.
 *
 * ── THE POPULATION IS THE REGISTER'S, AND THAT IS ENFORCED, NOT DOCUMENTED ───
 *
 * `scopeClause()` is imported from `routes/extract.ts` — the same import
 * `routes/vendorSites.ts` uses — so the fund / program / fiscal-floor predicate
 * has one definition in the repository. The register's own module doc warns that
 * the extract and the register must not "drift into describing different
 * populations"; a geocoding script is a *third* reader, and it is the one whose
 * drift would be invisible, because a pin set for the wrong scope still draws a
 * perfectly convincing map.
 *
 * ── THE THREE THINGS THE PROBE MEASURED, AND WHY EACH IS IN THE CODE ────────
 *
 * ★★ 1. **A geocode request WITHOUT `types: ["address"]` returns a confident pin
 *       for a street that is not the address.** Measured: `zzzqqq 99999` in
 *       "Nowhere" came back HTTP 200 with a real point in Sanford, NC, and
 *       `PO Box 9002, Raleigh, NC 27675` came back as a street called "Ranleigh
 *       Court" **in a different ZIP** — an eight-mile error in a figure about to
 *       be presented as "the site's location", with no status code saying so.
 *       So the filter is on the request AND asserted on the response, and the
 *       assertion is the `accuracy` field: a genuine address match carries
 *       `properties.coordinates.accuracy` (`rooftop`/`parcel`/…) and a non-address
 *       feature carries no accuracy and no `match_code`.
 *
 * ★★ 2. **136 of 800 sites hold a PO box in `ADDRESS_LINE1`.** They are refused
 *       *before* they are sent — not to save requests, but because the answer is
 *       known to be wrong. **A postcode centroid would be worse than no pin**: a
 *       centroid is a real coordinate, so it passes every guard, draws a marker,
 *       and yields a driving distance wrong by an unstated amount that nothing
 *       downstream could detect. A missing pin is honest; a fabricated one is not.
 *
 * ★ 3. **Idempotency must key on the address, not on the row.** A site is skipped
 *       only when its stored answer is final (`matched`/`no_match`/`po_box`) *and*
 *       its `address_hash` matches the address read this run. Keyed on the row's
 *       existence instead, the job passes on a virgin store and then quietly stops
 *       being correct the moment an address changes in Oracle — the pin would
 *       describe an address that is no longer there. `address_hash` is the only
 *       thing that can tell those apart.
 *
 * `error` is deliberately NOT final: a non-200 or a transport failure is retried
 * on the next run, while a `no_match` is an *answer* and is not. This repo has
 * already been bitten by `Number(rows[0]?.n ?? 0)` turning a failed query into a
 * confident zero, and `no_match` is that mistake wearing a status name.
 *
 * ── ONE ROW PER SITE, ONE GEOCODE PER ADDRESS ───────────────────────────────
 *
 * 800 sites hold 789 distinct addresses, so 11 sites share a coordinate with
 * another site. The geocode is per **distinct address** — 11 wasted requests and,
 * worse, 11 chances for two sites holding the same address to disagree — and the
 * WRITE is per **site**, which is the identity Oracle already guarantees and the
 * key the register keys on. A consequence worth stating: when an address is
 * fetched because *one* of its sites drifted, the result is written to **every**
 * site carrying it, so two sites can never hold different answers for one address.
 *
 * ── THE ORIGIN IS DATA ──────────────────────────────────────────────────────
 *
 * Distances are measured from the row in `geo_origin` with `is_default = 1`, never
 * from a constant here, and each row carries `drive_origin_slug` — so a number
 * measured from a *different* origin is detectable rather than silently compared.
 * `MAPBOX_START_LATITUDE` / `MAPBOX_START_LONGITUDE` in `.env` are read only to
 * report a disagreement with the table: two sources for one load-bearing number is
 * exactly the shape that produces a map where every distance is wrong together.
 *
 * ── FLAGS ───────────────────────────────────────────────────────────────────
 *
 *   --dry-run        plan, print and stop. No request, no write. **Run this first.**
 *   --refresh        ignore stored answers and re-fetch every address
 *   --limit=N        cap the addresses fetched this run (a live smoke)
 *   --sites=1,2,3    restrict the population to these sites
 *   --geocode-only   skip the Matrix step and the Directions step
 *   --distance-only  skip the geocode step and the Directions step
 *   --route-only     skip the geocode step and the Matrix step
 *
 * ── THREE STEPS, AND THE THIRD IS NOT LIKE THE OTHER TWO ─────────────────────
 *
 *   1. geocode      one batch POST per 900 addresses
 *   2. distance     one Matrix request per 24 pairs
 *   3. route        one Directions request per SITE — the geometry and the turns
 *
 * Step 3 exists because Matrix answers "how far" and cannot answer "which way".
 * It is 24x the request count of step 2 for the same population, so it runs on
 * demand (`--route-only`) rather than on every run, and it skips any site whose
 * stored route is still current (`pin_hash`). Read the header of
 * `data/sql/turso/01-app.sql` on `vendor_site_route` before changing it: in
 * particular, step 3's mileage is deliberately NOT written back to
 * `vendor_site_geo.drive_miles`, because the two services disagree and the
 * register's figure is the reproducible one.
 */

import { createHash } from 'node:crypto';
import { closeDb, db, storeDriver } from '../db/client.js';
import type { Row } from '../db/driver.js';
import { defaultTenant } from '../auth/session.js';
import { fiscalFloor, scopeClause } from '../routes/extract.js';

// ---------------------------------------------------------------------------
// Constants.
// ---------------------------------------------------------------------------

const GEOCODE_URL = 'https://api.mapbox.com/search/geocode/v6/batch';
const MATRIX_URL = 'https://api.mapbox.com/directions-matrix/v1/mapbox/driving';

/**
 * The Directions API takes two coordinates and returns one route, with its own
 * geometry and its manoeuvres — which is the thing Matrix cannot give.
 *
 * ★ IT IS ONE REQUEST PER SITE, NOT ONE PER 24, AND THAT IS THE COST OF THE
 *   FEATURE. Matrix answers 24 pairs per request; Directions answers exactly one
 *   pair, so the route step makes ~622 requests where the distance step makes 26.
 *   At Mapbox's documented rate that is minutes, not seconds, and it is why this
 *   step is a flag of its own (`--route-only`) rather than something a routine
 *   geocode run does by accident. It is also why the step SKIPS what it already
 *   holds — see `pin_hash` on `vendor_site_route`.
 */
const DIRECTIONS_URL = 'https://api.mapbox.com/directions/v5/mapbox/driving';

/**
 * Attempts per route, and the backoff between them.
 *
 * ★ A 429 IS EXPECTED HERE AND IS NOT A FAILURE. The first full run of this step
 *   asks for ~622 routes in a burst, and a rate limiter answering 429 partway
 *   through is the endpoint working as documented. Without a retry the run would
 *   mark every remaining site `error` and need a second pass to finish; with it,
 *   the run slows down and completes. Three attempts, 1s then 4s — quadratic
 *   rather than linear, because the limiter refills on a window boundary and
 *   doubling is not enough to clear it.
 */
const ROUTE_ATTEMPTS = 3;
const ROUTE_BACKOFF_MS = 1_000;

/**
 * ★ A STALENESS HASH MUST COVER THE PROCEDURE, NOT ONLY THE INPUTS.
 *
 * `pin_hash` answers "have the inputs changed?" — the pin and the origin. That is
 * most of the question and it is not all of it, because a stored route can also be
 * out of date with respect to the CODE THAT DERIVED IT. This constant is the other
 * half: bump it whenever the derivation changes — the unit conversions, the
 * geometry simplification, the step projection — and every stored row is treated
 * as stale and re-fetched.
 *
 * ★ THIS IS NOT HYPOTHETICAL, WHICH IS WHY IT IS HERE RATHER THAN PLANNED FOR.
 *   The first live run stored `route_miles` in METRES (a 748-mile drive recorded as
 *   1203677.50) on three sites, and because `pin_hash` was written correctly from
 *   an unchanged pin, the next run would have SKIPPED those rows and kept the wrong
 *   figure for as long as the pins stayed put. A hash over the inputs alone cannot
 *   tell "current" from "written by a version of this script that was wrong".
 *
 *   Bump on: unit or rounding changes, `overview=` changes, step-field changes, or
 *   any change to what a step's numbers mean. Not on: retry constants, logging,
 *   or anything that cannot alter a stored value.
 */
const ROUTE_EXTRACT_VERSION = 'v1';

/**
 * 900, under the documented 1000-item cap.
 *
 * ★ A chunk size AT the cap is a latent truncation, and the register is already
 *   large enough to test the reasoning: 655 requests today fit one POST, and the
 *   day this grows past the cap the failure is not an error — it is a silently
 *   short batch, i.e. a site with no pin and nothing saying why.
 */
const CHUNK = 900;

/**
 * 24 destinations per request = 25 coordinates, the `mapbox/driving` limit.
 *
 * ★ `destinations` IS SET EXPLICITLY, ALWAYS. The probe left it at its default and
 *   got a `0.0 mi` entry for the ORIGIN ITSELF in position 0: `destinations`
 *   defaults to *all* coordinates, so the source is echoed back as a destination
 *   and one element per request is billed for a zero that means nothing.
 */
const DESTINATIONS_PER_REQUEST = 24;

/**
 * ★ ON `ADDRESS_LINE1`, MATCHED AT A TOKEN BOUNDARY RATHER THAN AT THE START.
 *
 * The plan's §4.3 states this rule as `/^\s*P\.?\s*O\.?\s*BOX/i` — anchored to the
 * line's first character — and that anchor is wrong by exactly one row of this
 * register. Measured against the plan's own §1 figure (136) with a probe that
 * printed the disagreement:
 *
 *   site 148658  `EP-POBOX7488 OR`   ADDRESS_LINE1 = "EP-PO BOX 7488"   MADISON
 *
 * The vendor prefixes its box with `EP-`, so an anchored pattern calls it a street
 * address and sends it to Mapbox, which (correctly, per §2) finds no street and
 * returns either nothing or a street that is not this one. The site is in 136's
 * population and not 135's, so the plan's *figure* was right and its *rule* was
 * one row too narrow — and the two disagreeing is the whole reason `--dry-run`
 * compares them instead of printing one of them.
 *
 * The boundary form still refuses a value where `PO BOX` is part of a longer
 * word, and it does **not** widen to the loose SQL the figure was measured with
 * (`LIKE '%PO BOX%' OR LIKE 'P.O.%'`), whose second arm matches any line beginning
 * `P.O.` whatever follows — that is not a rule about boxes.
 *
 * ★ KNOWN UNCOVERED FORM: `P.O. DRAWER 12`. No row of this register carries it, so
 *   it is not in the rule; a future one would be sent to Mapbox, come back as a
 *   non-address feature, and be listed as unmapped with that reason. Naming the
 *   gap is the point — a rule that quietly grew a second alternative would be
 *   asserting something no measurement here supports.
 */
const PO_BOX_RE = /(?:^|[^A-Za-z0-9])P\.?\s*O\.?\s*BOX\b/i;

/**
 * A line that names a street, as opposed to a vendor name, a department, or a box.
 *
 * ★ MEASURED, NOT GUESSED — and the measurement is the whole reason this exists.
 *   Of the 58 sites the first full run could not pin, **24 named their street in
 *   `ADDRESS_LINE2` or `ADDRESS_LINE3`** while `ADDRESS_LINE1` held a name:
 *
 *     100285  `MUSEUM OF SCIENCE`                        / `1 SCIENCE PARK`
 *     12415   `STATE SURPLUS PROPERTY`                   / `1310 MAIL SERVICE CENTER`
 *     12098   `COLLEGE BUSINESS OFFICE`                  / `9101 FAYETTEVILLE RD`
 *     56724   `RALEIGH PARKS & RECREATION, ATTN: …`      / … / `2401 WADE AVENUE`
 *
 *   The request sent line 1 only, so those were misses **by construction**, and the
 *   reason stored against them — "Mapbox returned no feature for this address" —
 *   blamed Mapbox for a field choice of ours. Sending the other line rescued 22 of
 *   them; the third line rescued 2 more. Both figures are from a triage that sent
 *   every candidate for all 58 sites and carried a control that had to MISS.
 *
 * ★★ THE TEST IS "DOES THE LINE OPEN WITH A NUMBER", AND A SPELLED-OUT NUMBER
 *    COUNTS. `ONE`/`TWO`/… are building numbers in this register (`ONE VANDERBILT
 *    AVENUE`, `ONE GLENWOOD AVE STE 1010`, `ONE EXCHANGE PLAZA`), so an ordinal word
 *    opens a street exactly as a digit does. Widening to ordinals costs nothing:
 *    no vendor or department name in the register opens with one.
 *
 * ★ THE BOX TEST IS APPLIED FIRST, ALWAYS. `PO BOX 543` opens with `P` and so is not
 *   street-shaped anyway — but a rule that leaned on that would be reading an
 *   accident of the alphabet as a guarantee, and site `148658`'s `EP-PO BOX 7488`
 *   shows this register will prefix a box with anything.
 */
const STREET_START_RE = /^(?:\d|ONE\b|TWO\b|THREE\b|FOUR\b|FIVE\b|SIX\b|SEVEN\b|EIGHT\b|NINE\b|TEN\b)/i;

/**
 * A unit or suite prefix standing between the start of the line and the address.
 *
 * ★★ THE ANCHOR ALONE CLASSIFIED A MAPPABLE SITE AS UNMAPPABLE, AND THE AUDIT
 *    ABOVE IS WHAT FOUND IT. Of the 14 box sites whose only other line the street
 *    test refused, 13 are correct refusals — vendor names (`NASCO HEALTHCARE INC`,
 *    `DBA LETTERLAND INTERNATIONAL`), departments (`ORDER SERVICES`, `OFFICE OF
 *    SPONSORED RESEARCH`) and one accounting code (`ACCT #28494774`). The fourteenth
 *    read `SUITE E - 1990 COLUMBIA AVE`: a numbered street behind a unit prefix, so
 *    the site was withdrawn from the map behind a reason that blamed the data.
 *
 *    A predicate of the form "the line opens with a number" cannot see this, and the
 *    tempting repair — accept a digit ANYWHERE in the line — is worse than the bug:
 *    every `ACCT #28494774`, every `CB# 3330 …` and every `PO BOX 543` carries a
 *    digit, so it would stop refusing the 13 correct cases to rescue the one wrong
 *    one. Stripping a known prefix is narrow, and it lists exactly what it strips.
 *
 * ★ `STANBURY INDUSTRIAL DRIVE` IS DELIBERATELY STILL REFUSED, AND IT IS NOT AN
 *   OVERSIGHT. It names a real street with no building number, and the request asks
 *   for `types: ['address']` — there is no address on that line to return, so a
 *   query would spend a request to learn nothing. It is recorded as a box site with
 *   a reason that says a numbered street was not named, which is the true statement.
 *   A future reader wanting a road-level pin for it should widen `types`, not this.
 */
const SUITE_PREFIX_RE =
  /^(?:SUITE|STE|UNIT|BLDG|BUILDING|APT|RM|ROOM|OFFICE|OFC|DIV|DIVISION)\b[^,]{0,24}?[-–—,]\s*/i;

/** Does this one line name a street?, with a unit prefix allowed in front of the number. */
function looksLikeStreet(line: string): boolean {
  const text = line.trim();
  if (text === '' || PO_BOX_RE.test(text)) return false;
  if (STREET_START_RE.test(text)) return true;
  const prefix = SUITE_PREFIX_RE.exec(text);
  return prefix !== null && STREET_START_RE.test(text.slice(prefix[0].length).trim());
}

/** An answer, as opposed to `error`. A final answer is not retried while its address is unchanged. */
const FINAL_STATUSES: ReadonlySet<string> = new Set(['matched', 'no_match', 'po_box']);

const METRES_PER_MILE = 1609.344;

/**
 * ★ THE US AND CANADIAN REGION SETS EXIST TO CLASSIFY, NOT TO VALIDATE, AND THE
 *   DEFAULT IS "NOT US". A state that names a Canadian province — or the literal
 *   string `CANADA`, which one row of this register carries where a two-letter
 *   code belongs — is `ca`; a value in the US set is `us`; **anything else
 *   (including blank) is neither**, and its `country` is OMITTED from the request
 *   rather than asserted as `us`.
 *
 *   The tempting shortcut — `country: 'us'` whenever the state is not Canadian —
 *   is a claim, and it is measurably false here: two sites have a blank `STATE`
 *   and both are Canadian. Telling Mapbox an address is in the US when its own
 *   `postcode` says otherwise is a silent quality loss, not an error. Omitting the
 *   country lets the postcode and city decide, which is what the probe's
 *   state-less control did when it correctly resolved to Vancouver, BC.
 *
 *   The same classification drives the distance step: "outside the US" here means
 *   `country !== 'us'`, which is the honest reading of *we could not place this
 *   site in the United States*.
 */
const US_REGIONS: ReadonlySet<string> = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
  'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC',
  'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
  'PR', 'VI', 'GU', 'AS', 'MP',
]);
const CA_REGIONS: ReadonlySet<string> = new Set([
  'AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT',
]);

/**
 * The shipped tenant's scope, with the figures this script's own `--dry-run` measured
 * under it.
 *
 * ★ THE GATE IS CONDITIONAL ON THE SCOPE, NOT ON THE NUMBER. `routes/extract.ts`
 *   records the lesson: a figure here is a function of the tenant's `start_fy` and
 *   program list, which a user can edit in Settings, so quoting it as a constant
 *   makes it wrong the day somebody does. If this scope is not the shipped one the
 *   figures are printed as *this tenant's* and are not compared to anything.
 *
 * ★★ THESE ARE NOT §1'S FIGURES, AND THE TWO SETS MEASURE DIFFERENT **RULES** — so a
 *    reader diffing the plan against this output is diffing two rules rather than two
 *    runs of one. §1 recorded `789 distinct / 136 PO boxes / 653 requests` from two
 *    readings the implementation deliberately does not share:
 *
 *    ① `136` counts a box **in `ADDRESS_LINE1` only** — §1's own table says
 *       "`PO Box` in line 1", and §4.3 names the predicate `/^\s*P\.?\s*O\.?\s*BOX/i`.
 *       This script tests all three lines, because line 1 of this register is very
 *       often a department name, and the rule's own note measured what the narrow read
 *       costs: it "missed the box on **10 more** whose line 1 is a department name".
 *       `136 + 10 = 146`, which is what a run prints. Those 10 are not drift; they are
 *       the boxes §4.3's predicate would have sent to Mapbox as if they were addresses.
 *    ② §1's `653 = 789 − 136` is **arithmetic, not a measurement** — the geocode is per
 *       distinct *address*, and a count of box *sites* is not a count of box addresses.
 *       Measured, the 146 box sites hold **144** distinct addresses, so the request
 *       count is `788 − 144 = 644`. Both operands are printed on the line above the
 *       gate, and the block prints the subtraction **and compares it** to the number of
 *       addresses actually queried, so the reader never has to take this on trust.
 *    ③ `distinct` reads 788 where §1 recorded 789, because `streetOf` now prefers a
 *       street-shaped line 2/3 over a name on line 1: one more pair of sites sends a
 *       byte-identical query. That is a duplicate removed, not a classifier collapse —
 *       a shared hash can only mean one address, since the hash is over the same four
 *       fields the request is built from, and the "addresses held by >1 site" audit
 *       prints the group count and how many sites sit in them.
 *
 * ★ SO A FAIL HERE MEANS ONE OF TWO DIFFERENT THINGS, and they are not the same fix:
 *   either a predicate has drifted from the register's — the bug this gate exists for —
 *   or a rule was changed on purpose and these five numbers are the record of it. The
 *   second case is resolved by re-deriving each figure from the run's own output and
 *   writing down **which rule moved it**; pasting the new number in is what makes this
 *   gate worthless, because a bump cannot be told from a drift afterwards.
 */
const PLAN_SCOPE = { fund: '04', programs: ['861', '862', '863'], startFy: 2022 };
const PLAN_FIGURES = { sites: 800, distinct: 788, poBoxes: 146, requests: 644, posts: 1 };

// ---------------------------------------------------------------------------
// Arguments and output.
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const has = (name: string): boolean => argv.includes(`--${name}`);
const arg = (name: string): string | null => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 3);
};

const DRY_RUN = has('dry-run');
const REFRESH = has('refresh');
const GEOCODE_ONLY = has('geocode-only');
const DISTANCE_ONLY = has('distance-only');
const ROUTE_ONLY = has('route-only');
const LIMIT = Number(arg('limit') ?? '') || 0;
const SITES_ONLY = (arg('sites') ?? '')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

const say = (s = ''): void => {
  process.stdout.write(s + '\n');
};
/** Grouped thousands, so a four-figure count is readable at a glance. */
const N = (n: number): string => n.toLocaleString('en-US');

/** Failures that must stop the run before anything is written. */
const fatal: string[] = [];
/** Figures that disagree with the plan under the plan's own scope. */
const gateFailures: string[] = [];

// ---------------------------------------------------------------------------
// Addresses.
// ---------------------------------------------------------------------------

interface Site {
  siteId: number;
  siteCode: string;
  vendorName: string;
  line1: string;
  line2: string;
  line3: string;
  city: string;
  state: string;
  zip: string;
  /**
   * ★ THE LINE THE REQUEST PUTS IN `address_line1` — WHICH IS NOT ALWAYS `line1`.
   *
   * Oracle keeps the vendor's address as it was captured, and this register often
   * puts a name on the first line and the street on the second. `streetOf` picks the
   * line worth asking about and every consumer of *the request* reads this field
   * instead of `line1`: the SHA-256 identity, the stored `query_address`, and the
   * batch payload. `line1`/`line2`/`line3` stay exactly as Oracle wrote them, so the
   * row can still be shown to a reader as the vendor has it.
   */
  street: string;
}

/** Trim, collapse internal runs of whitespace, upper-case. Used for *comparison* only. */
const norm = (v: string): string => v.trim().replace(/\s+/g, ' ').toUpperCase();

/** Just the three lines, so a caller can ask about a row before a `Site` exists. */
type AddressLines = Pick<Site, 'line1' | 'line2' | 'line3'>;

/** The address lines that hold something, in the order Oracle keeps them. */
const linesOf = (a: AddressLines): string[] => [a.line1, a.line2, a.line3].filter((l) => l !== '');

/** True when any line names a post-office box. */
const namesABox = (a: AddressLines): boolean => linesOf(a).some((l) => PO_BOX_RE.test(l));

/**
 * True when some line can be handed to the geocoder as a street — the test for
 * "there is something here to ask about", as distinct from "the address is a box".
 */
const namesAStreet = (a: AddressLines): boolean => linesOf(a).some((l) => looksLikeStreet(l));

/**
 * The line the request sends as `address_line1`.
 *
 * ★ FIRST STREET-SHAPED, NON-BOX LINE WINS; FALLING BACK TO THE FIRST NON-BOX LINE.
 *   The preference order is what rescues the 24 sites in `STREET_START_RE`'s note
 *   without disturbing the 600-odd sites whose `ADDRESS_LINE1` is already a street:
 *   for those the first candidate *is* line 1, so the request is byte-identical to
 *   the one the previous run sent.
 *
 * ★ THE FALLBACK EXISTS SO THIS FUNCTION NEVER WITHHOLDS AN ASK. A site whose first
 *   non-box line is a name with no street anywhere (`BUSINESS OFFICE` /
 *   `CB# 3330 KNAPP-SANDERS BUILDING`) still gets sent, comes back `no_match`, and
 *   is recorded as a genuine gap in Mapbox's coverage — which is a different, and
 *   true, statement from "we never asked".
 *
 * ★★ THE LAST RESORT IS A BOX LINE, AND WITHOUT IT THIS BECAME A DEFECT. A site whose
 *    every line is a box has no non-box line at all, so the first two rules returned
 *    nothing and the hash collapsed to `|CITY|STATE|ZIP` — one value for every box
 *    site in a city. Measured, that turned "120 distinct box addresses" into a
 *    count of empty strings wearing an address's name, and it broke the identity
 *    `distinct − box addresses = requests` that the population block prints. A box
 *    is a real address even when it is not a mappable one: it identifies the site,
 *    and it is what a change to the row should be measured against.
 *
 * ★ AND IT CAN CORRECT A WRONG CITY. `100285`'s mailing city is BOSTON while its
 *   street sits in Cambridge, so the pin lands in Cambridge. That is right for a map
 *   and is a visible change from the address Oracle prints beside it; the register
 *   shows the vendor's own city, so the two will disagree for exactly these sites.
 */
function streetOf(a: AddressLines): string {
  const lines = linesOf(a);
  const usable = lines.filter((l) => !PO_BOX_RE.test(l));
  const street = usable.find((l) => looksLikeStreet(l));
  return (street ?? usable[0] ?? lines[0] ?? '').trim();
}

/**
 * `street|city|state|zip` — the same four fields the request is built from, and the
 * same four the plan's DDL comment names.
 *
 * ★ `street`, NOT `line1`, AND THE DIFFERENCE IS THE POINT OF THE COLUMN. This is a
 *   *change detector for the request*: two runs must produce the same hash exactly
 *   when they would send the same query. Hashing `line1` would call a site unchanged
 *   on the day somebody moved a name onto the first line and the street onto the
 *   second — the request would change while the identity did not, and the site would
 *   be skipped rather than re-asked.
 *
 * ★ `line2`/`line3` ARE DELIBERATELY ABSENT BEYOND THEIR ROLE IN CHOOSING `street`.
 *   They are absent on 624 and 794 of 800 sites respectively, and a field that is
 *   blank on three quarters of the rows in a *change detector* would make a site
 *   look changed the day somebody filled in a suite number.
 *
 * The full SHA-256 digest, not a prefix: 800 rows fit in no meaningful budget, and
 * a truncation is a collision risk taken for no gain.
 */
function hashOf(a: Site): string {
  return createHash('sha256')
    .update([norm(a.street), norm(a.city), norm(a.state), norm(a.zip)].join('|'))
    .digest('hex');
}

/**
 * The address **as queried** — `street, city, state zip`.
 *
 * ★ IT IS NOT THE VENDOR'S ADDRESS AS WRITTEN, AND IT SHOULD NOT BE. This value is
 *   stored in `query_address` to make a pin reproducible: a reader pasting it back
 *   into the geocoder must get the answer this row records. Rendering the name line
 *   first (`MUSEUM OF SCIENCE, 1 SCIENCE PARK, BOSTON`) would reproduce nothing —
 *   and `BOSTON` is not even the city the pin is in. The vendor's own lines are on
 *   the register page, which reads them from the ledger; this column's one job is
 *   "what did we ask".
 */
function renderAddress(a: Site): string {
  const cityLine = [a.city.trim(), [a.state.trim(), a.zip.trim()].filter((s) => s !== '').join(' ')]
    .filter((s) => s !== '')
    .join(', ');
  return [a.street, cityLine].filter((s) => s !== '').join(', ');
}

/** A two-letter region code, or `null`. `CANADA` is six letters and is not one. */
function regionOf(a: Site): string | null {
  const t = norm(a.state);
  return /^[A-Z]{2}$/.test(t) ? t : null;
}

/** `'ca'`, `'us'`, or `null` meaning "omit it and let the postcode decide". */
function countryOf(a: Site): 'us' | 'ca' | null {
  const t = norm(a.state);
  if (t === 'CANADA' || CA_REGIONS.has(t)) return 'ca';
  if (US_REGIONS.has(t)) return 'us';
  return null;
}

// ---------------------------------------------------------------------------
// The response shapes we depend on, and only those.
// ---------------------------------------------------------------------------

interface GeoFeature {
  properties?: {
    feature_type?: string;
    mapbox_id?: string;
    full_address?: string;
    coordinates?: { longitude?: number; latitude?: number; accuracy?: string };
    match_code?: { confidence?: string };
  };
  geometry?: { coordinates?: number[] };
}

/**
 * ★ THE BATCH ENDPOINT RETURNS AN ARRAY OF FEATURE**COLLECTIONS**, NOT OF FEATURES.
 *
 * `POST /search/geocode/v6/batch` answers
 *
 *   { batch: [ { type: 'FeatureCollection', features: [ { type: 'Feature', … } ] }, … ] }
 *
 * — one collection per query, holding 0 or 1 feature under `limit: 1`. Reading
 * `entry.properties` (i.e. treating the entry as a Feature) is therefore
 * **undefined on every entry, for every address**, and the single-address
 * `/forward` endpoint the probe used has the opposite shape (`{ features: [...] }`
 * at the top level), so a reader who checked the probe's output sees nothing
 * wrong.
 *
 * ★★ THIS COST A RUN, AND THE SYMPTOM WAS A MISLEADING *REASON*, NOT AN ERROR. The
 *    unwrap was wrong, so the response-side guard fired — correctly, on a value it
 *    could not verify — and wrote 27 real street addresses as `no_match` with the
 *    reason *"the match is a feature with no type, not an address"*. That sentence
 *    names the **feature**, so it sends a reader to inspect what Mapbox returned,
 *    when the fault is one level up in how the answer was unpacked. **A guard that
 *    refuses to believe a value must name the level it could not believe**, which
 *    is why `unpackBatch` below asserts the collection shape separately and says so
 *    in its own words.
 */
interface GeoFeatureCollection {
  features?: (GeoFeature | null)[];
}

interface GeoAnswer {
  /**
   * `po_box` is produced locally, never by Mapbox.
   *
   * ★ IT IS NOT `no_match`, AND THE DIFFERENCE IS THE POINT. `no_match` says
   *   "Mapbox was asked and had nothing"; `po_box` says "nothing was asked, because
   *   the line names no street". Collapsing them would make the 136 sites whose
   *   situation is *understood and permanent* indistinguishable from the sites
   *   whose absence of a pin is a puzzle — and the page's legend has to tell a
   *   reader which of the two they are looking at.
   */
  status: 'matched' | 'no_match' | 'po_box';
  /** Why, when the answer is not a match. Null on a match. */
  reason: string | null;
  latitude: number | null;
  longitude: number | null;
  accuracy: string | null;
  confidence: string | null;
  featureType: string | null;
  mapboxId: string | null;
}

// ---------------------------------------------------------------------------
// Reading the register's population from the ledger.
// ---------------------------------------------------------------------------

/**
 * One row per in-scope SITE, with the address fields the geocoder needs.
 *
 * ★ THE PREDICATE IS THE REGISTER'S, VERBATIM. The site grain is `DISTINCT
 *   VENDOR_SITE_ID` over the same four-table join `routes/vendorSites.ts` uses, so
 *   a site is in this set exactly when it names an in-scope order. Read at
 *   (site, order) grain this would be 5,692 rows of the same 800 addresses.
 *
 * ★ THE JOIN NAMES `APPS.WCSEXP_PO_DISTRIBUTIONS` AND THAT IS NOT A PREFERENCE.
 *   It is the only object carrying a computed `AMOUNT_ORDERED` on Oracle; the base
 *   table's column is NULL there. Do not repoint it at `PO_DISTRIBUTIONS_ALL` — on
 *   the sample that is a no-op (the ports are pass-throughs) and on Oracle it reads
 *   NULL. docs/implementation/wcsexp-view-names.md.
 */
async function readSites(programs: readonly string[], fund: string, since: string): Promise<Site[]> {
  const { where, binds } = scopeClause(programs);

  const sql = `
    SELECT s.VENDOR_SITE_ID, s.VENDOR_SITE_CODE,
           s.ADDRESS_LINE1, s.ADDRESS_LINE2, s.ADDRESS_LINE3,
           s.CITY, s.STATE, s.ZIP,
           v.VENDOR_NAME
      FROM ( SELECT DISTINCT h.VENDOR_SITE_ID
               FROM PO_HEADERS_ALL h
               JOIN PO_LINES_ALL l
                 ON l.PO_HEADER_ID = h.PO_HEADER_ID
               JOIN APPS.WCSEXP_PO_DISTRIBUTIONS wd
                 ON wd.PO_LINE_ID = l.PO_LINE_ID
               JOIN GL_CODE_COMBINATIONS g
                 ON g.CODE_COMBINATION_ID = wd.CODE_COMBINATION_ID
               ${where} ) sc
      JOIN PO_VENDOR_SITES_ALL s
        ON s.VENDOR_SITE_ID = sc.VENDOR_SITE_ID
 LEFT JOIN APPS.PO_VENDORS v
        ON v.VENDOR_ID = s.VENDOR_ID
     ORDER BY s.VENDOR_SITE_ID`;

  const res = await storeDriver('ledger').execute({ sql, args: { ...binds, fund, since } });

  const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

  return res.rows.map((row: Row) => {
    const lines = {
      line1: text(row.ADDRESS_LINE1),
      line2: text(row.ADDRESS_LINE2),
      line3: text(row.ADDRESS_LINE3),
    };
    return {
      siteId: Number(row.VENDOR_SITE_ID),
      siteCode: text(row.VENDOR_SITE_CODE),
      vendorName: text(row.VENDOR_NAME),
      ...lines,
      city: text(row.CITY),
      state: text(row.STATE),
      zip: text(row.ZIP),
      street: streetOf(lines),
    };
  });
}

// ---------------------------------------------------------------------------
// The app store: what is already pinned, and the origin.
// ---------------------------------------------------------------------------

interface StoredPin {
  status: string;
  hash: string | null;
  latitude: number | null;
  longitude: number | null;
  driveStatus: string | null;
  driveOriginSlug: string | null;
}

async function readStoredPins(): Promise<Map<number, StoredPin>> {
  const res = await storeDriver('app').execute({
    sql:
      `SELECT vendor_site_id, geocode_status, address_hash, latitude, longitude,
              drive_status, drive_origin_slug
         FROM vendor_site_geo`,
    args: [],
  });

  const num = (v: unknown): number | null => {
    const n = Number(v);
    return v === null || v === undefined || !Number.isFinite(n) ? null : n;
  };
  const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

  const map = new Map<number, StoredPin>();
  for (const row of res.rows as Row[]) {
    map.set(Number(row.vendor_site_id), {
      status: String(row.geocode_status ?? ''),
      hash: str(row.address_hash),
      latitude: num(row.latitude),
      longitude: num(row.longitude),
      driveStatus: str(row.drive_status),
      driveOriginSlug: str(row.drive_origin_slug),
    });
  }
  return map;
}

interface Origin {
  slug: string;
  name: string;
  latitude: number;
  longitude: number;
}

async function readOrigin(): Promise<Origin> {
  const res = await storeDriver('app').execute({
    sql: 'SELECT slug, name, latitude, longitude FROM geo_origin WHERE is_default = 1',
    args: [],
  });
  const row = res.rows[0] as Row | undefined;
  if (row === undefined) {
    throw new Error(
      'No `geo_origin` row is marked as the default, so there is nothing to measure a distance from. ' +
        'Re-apply data/sql/turso/01-app.sql, which seeds `raleigh`, or add one.',
    );
  }
  return {
    slug: String(row.slug),
    name: String(row.name),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
  };
}

// ---------------------------------------------------------------------------
// Mapbox.
// ---------------------------------------------------------------------------

const token = (): string => {
  const t = process.env.MAPBOX_API_KEY?.trim();
  if (t === undefined || t === '') {
    throw new Error('MAPBOX_API_KEY is not set, so no geocode can be made. Add it to the repo-root .env.');
  }
  return t;
};

interface ItemResult {
  body: unknown;
  status: number;
  error: string | null;
}

/**
 * POST a batch, with one retry on a 429 or a 5xx.
 *
 * A failure is returned, never thrown, and never converted into a `no_match`:
 * `error` is retryable and `no_match` is an answer, and conflating them is how a
 * broken run becomes a page that says these sites have no location.
 */
async function postBatch(items: unknown[]): Promise<ItemResult> {
  const url = `${GEOCODE_URL}?access_token=${encodeURIComponent(token())}&permanent=true`;
  const body = JSON.stringify(items);

  let lastError = 'no attempt was made';
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(120_000),
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = `HTTP ${res.status}`;
        if (attempt === 1) continue;
        return { body: null, status: res.status, error: lastError };
      }
      if (!res.ok) {
        const text = await res.text();
        return { body: null, status: res.status, error: `HTTP ${res.status} — ${text.slice(0, 300)}` };
      }
      return { body: (await res.json()) as unknown, status: res.status, error: null };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt === 1) continue;
    }
  }
  return { body: null, status: 0, error: lastError };
}

/**
 * Turn one batch item's feature into an answer.
 *
 * ★ BOTH RESPONSE-SIDE GUARDS, AND THE SECOND IS THE ONE THAT MATTERS.
 *   `feature_type !== 'address'` catches a returned street, and the missing
 *   `accuracy` is the real signal the probe found: a genuine address match carries
 *   `properties.coordinates.accuracy` and a full `match_code`, a non-address
 *   feature carries neither. Asserting only the request-side filter would put the
 *   safety somewhere the next reader cannot see it.
 */
function answerFrom(feature: GeoFeature | null | undefined): GeoAnswer {
  const blank: GeoAnswer = {
    status: 'no_match',
    reason: null,
    latitude: null,
    longitude: null,
    accuracy: null,
    confidence: null,
    featureType: null,
    mapboxId: null,
  };

  if (feature === null || feature === undefined) {
    return { ...blank, reason: 'Mapbox returned no feature for this address' };
  }

  const props = feature.properties;
  const featureType = props?.feature_type ?? null;

  if (featureType !== 'address') {
    return {
      ...blank,
      reason: `the match is a ${featureType ?? 'feature with no type'}, not an address`,
      featureType,
    };
  }

  const accuracy = props?.coordinates?.accuracy ?? null;
  if (accuracy === null || accuracy === '') {
    return {
      ...blank,
      reason: 'the match carries no coordinates.accuracy, so it is not a street address',
      featureType,
    };
  }

  const lon = props?.coordinates?.longitude ?? feature.geometry?.coordinates?.[0];
  const lat = props?.coordinates?.latitude ?? feature.geometry?.coordinates?.[1];
  if (typeof lon !== 'number' || typeof lat !== 'number') {
    return { ...blank, reason: 'the match carries no coordinate', featureType, accuracy };
  }

  return {
    status: 'matched',
    reason: null,
    latitude: lat,
    longitude: lon,
    accuracy,
    confidence: props?.match_code?.confidence ?? null,
    featureType,
    mapboxId: props?.mapbox_id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Writing.
// ---------------------------------------------------------------------------

/**
 * The geocode columns — plus an invalidation of the distance when there is no longer a pin.
 *
 * ★ THE `SET` LIST IS THE POINT. A geocode run must not touch `drive_*` and a
 *   distance run must not touch the pin: they are different measurements, taken
 *   from different APIs at different times, and a shared "update the row" helper
 *   would let a re-geocode silently blank a distance it never measured.
 *
 * ★ AND A RE-GEOCODE THAT FAILS TO MATCH MUST CLEAR THE COORDINATE. `latitude` is
 *   written from the new answer, `null` included: leaving the old pin behind would
 *   pair a `no_match` status with a coordinate, which is the one state the page
 *   cannot render honestly.
 *
 * ★★ AND THE SAME ARGUMENT APPLIES TO THE DISTANCE — WHICH THE FIRST VERSION OF THIS
 *    FILE DID NOT HONOUR, AND THE OMISSION WAS INVISIBLE UNTIL IT WAS COUNTED. The
 *    rule above was written for the coordinate and stopped there, so a site that
 *    stops being `matched` kept its old `drive_miles`, `drive_minutes`,
 *    `drive_status` and `drive_origin_slug`. Measured on the shipped sample after a
 *    full `--refresh`: **three rows carried `drive_miles` values of 565.19, 288.56
 *    and 626.31** with `drive_status = 'ok'` and coordinates correctly nulled — i.e.
 *    a distance to a place the same row says no longer exists.
 *
 *    The count that exposed it was not a count of this at all. The register's
 *    `awaitingDistance` came out at **−3**, and a negative count is the tell: it is
 *    computed as `matched − withDistance − outsideUs − unclassified − noRoute`, so
 *    any row in two piles at once makes it go below zero. No amount of reading the
 *    response could say *which* rows were in two piles; a `GROUP BY
 *    geocode_status, drive_status` said it in one line (`po_box | ok | 3`).
 *
 *    ★ THE RULE, STATED ONCE: **a distance is a property of a pin.** Remove the pin
 *      and the distance goes with it. That is why the invalidation lives in the
 *      geocode writer rather than the distance writer — it is the geocode run that
 *      withdraws the basis, so it is the geocode run that must withdraw the
 *      conclusion. The `CASE` preserves the distance verbatim when the new status
 *      *is* `matched`, so an ordinary re-run still measures nothing it did not
 *      measure, which is what the paragraph above was protecting.
 *
 *    ★ Known limitation, deliberately not fixed here: a site that stays `matched` but
 *      is **re-pinned to different coordinates** keeps its old distance too. Closing
 *      that needs the pin's coordinates recorded *at measurement time* — a column the
 *      table does not have — and a rule for how much coordinate drift invalidates a
 *      measurement. Whether that drift even occurs is a measurement this file has not
 *      taken, so adding a sweeping invalidation on a guess would risk clearing 622
 *      correct distances on every refresh. Recorded, not assumed away.
 */
async function writeGeocode(siteId: number, a: Site, answer: GeoAnswer, hash: string): Promise<void> {
  await storeDriver('app').execute({
    sql:
      `INSERT INTO vendor_site_geo
         (vendor_site_id, latitude, longitude, geocode_status, geocode_reason,
          match_confidence, accuracy, feature_type, mapbox_id, query_address,
          address_hash, permanent, geocoded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (vendor_site_id) DO UPDATE SET
         latitude         = excluded.latitude,
         longitude        = excluded.longitude,
         geocode_status   = excluded.geocode_status,
         geocode_reason   = excluded.geocode_reason,
         match_confidence = excluded.match_confidence,
         accuracy         = excluded.accuracy,
         feature_type     = excluded.feature_type,
         mapbox_id        = excluded.mapbox_id,
         query_address    = excluded.query_address,
         address_hash     = excluded.address_hash,
         permanent        = excluded.permanent,
         geocoded_at      = excluded.geocoded_at,
         drive_miles       = CASE WHEN excluded.geocode_status = 'matched' THEN drive_miles       ELSE NULL END,
         drive_minutes     = CASE WHEN excluded.geocode_status = 'matched' THEN drive_minutes     ELSE NULL END,
         drive_status      = CASE WHEN excluded.geocode_status = 'matched' THEN drive_status      ELSE NULL END,
         drive_origin_slug = CASE WHEN excluded.geocode_status = 'matched' THEN drive_origin_slug ELSE NULL END`,
    args: [
      siteId,
      answer.latitude,
      answer.longitude,
      answer.status,
      answer.reason,
      answer.confidence,
      answer.accuracy,
      answer.featureType,
      answer.mapboxId,
      renderAddress(a),
      hash,
      // ★ `permanent` records that this row HOLDS a permanently-licensed Mapbox
      //   result, not that a request carried the flag — a `no_match` row holds no
      //   Mapbox content at all. A row that carries something without it is the
      //   one the licence column exists to catch.
      answer.status === 'matched' ? 1 : 0,
    ],
  });
}

/**
 * The distance columns only, on a row that already exists.
 *
 * ★ ★ IT IS AN `UPDATE`, NOT AN UPSERT — AND THE UPSERT IT REPLACES WAS BROKEN ON
 *     EVERY SINGLE ROW.
 *
 * The original statement was `INSERT (vendor_site_id, drive_*) … ON CONFLICT
 * (vendor_site_id) DO UPDATE SET drive_*`, on the reasoning that the conflict would
 * always fire because a distance exists only for a pinned site, so the INSERT branch
 * was unreachable. Measured, the opposite is true: **SQLite enforces NOT NULL
 * before it resolves the `ON CONFLICT` target.** The INSERT branch therefore builds a
 * row with no `geocode_status` — a NOT NULL column — and the statement fails with
 *
 *   SQLITE_CONSTRAINT: NOT NULL constraint failed: vendor_site_geo.geocode_status
 *
 * *on every row, whether or not the row exists*, because the conflict is never
 * reached. The failure was indistinguishable from a missing row and sent the reader
 * hunting for one: a probe confirmed site 7650 read back `status=matched` with real
 * coordinates **on the same connection**, while the same INSERT for it still failed
 * on the not-null. One statement, two contradictory accounts of the same table.
 *
 * ★ The lesson generalises past this file: **an upsert whose INSERT branch cannot
 *   legally succeed is not an upsert.** It is an UPDATE carrying an error path that
 *   describes a situation which cannot occur, so the message names the one cause it
 *   can never have. (The geocode writer next door has the same `ON CONFLICT` shape
 *   and works, because it *does* supply every NOT NULL column — the pattern is not
 *   wrong in itself; omitting a NOT NULL column is.)
 *
 * So the invariant the old comment merely asserted is now CHECKED instead: exactly
 * one row must be affected, and zero is reported as the real fault it is — the
 * geocode row for this site is absent, which means the step that writes it did not
 * run or did not finish. A silent zero-row UPDATE would leave `drive_status` NULL,
 * which reads as "not computed yet" and would be retried forever without ever
 * explaining itself.
 *
 * ★ The failure is REPORTED WITH THE SITE ID: the bare libSQL message named the
 *   column and not one useful thing about which of 800 rows it was.
 */
async function writeDistance(
  siteId: number,
  miles: number | null,
  minutes: number | null,
  status: 'ok' | 'no_route' | 'outside_us' | 'unclassified',
  originSlug: string,
): Promise<void> {
  const res = await storeDriver('app')
    .execute({
      sql:
        `UPDATE vendor_site_geo
            SET drive_miles       = ?,
                drive_minutes     = ?,
                drive_status      = ?,
                drive_origin_slug = ?,
                drive_at          = datetime('now')
          WHERE vendor_site_id = ?`,
      args: [miles, minutes, status, originSlug, siteId],
    })
    .catch((err: unknown) => {
      throw new Error(
        `writeDistance(${siteId}, ${status}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

  if (res.rowsAffected !== 1) {
    throw new Error(
      `writeDistance(${siteId}, ${status}) matched ${res.rowsAffected} row(s) in vendor_site_geo, expected 1. ` +
        'A distance belongs to a site that has a geocode row, so the geocode step must have written it — ' +
        'run the geocode step (without --distance-only) for this site before the distance step.',
    );
  }
}

// ---------------------------------------------------------------------------
// The Matrix step.
// ---------------------------------------------------------------------------

interface MatrixRequest {
  destinations: { siteId: number; latitude: number; longitude: number }[];
}

/**
 * Split the pinned, in-country sites into requests of at most 24 destinations.
 *
 * ★ ★ A REQUEST WITH EXACTLY ONE DESTINATION IS REFUSED, AND 601 DESTINATIONS
 *     PRODUCES ONE. The Matrix API answers a 1-element request with
 *
 *   HTTP 422 — Not enough input sources and destinations given, resulting in only
 *              1 matrix element; minimum number of matrix elements is 2
 *
 * measured on the live run: 601 destinations planned as 25×24 + 1, so the 26th
 * request carried a single site and was rejected, leaving that site NULL while every
 * other request succeeded. The arithmetic is the tell — any pin count that is `1 mod
 * 24` lands here, which for a register this size is roughly a one-in-twenty-four
 * chance of a failure nobody would notice, because 25 of 26 requests succeed.
 *
 * So the second-to-last request gives one destination back: 601 becomes 24×24 + 23 +
 * 2 rather than 24×25 + 1. Same number of requests, same total, and no request below
 * the API's floor.
 *
 * (A single pinned site in the whole register is still exactly one destination, with
 * nothing to take from; `matrixRow` doubles the destination index for that case and
 * reads one answer.)
 */
function planMatrix(pins: { siteId: number; latitude: number; longitude: number }[]): MatrixRequest[] {
  const chunks: { siteId: number; latitude: number; longitude: number }[][] = [];
  for (let i = 0; i < pins.length; i += DESTINATIONS_PER_REQUEST) {
    chunks.push(pins.slice(i, i + DESTINATIONS_PER_REQUEST));
  }

  const last = chunks[chunks.length - 1];
  const prev = chunks[chunks.length - 2];
  if (last !== undefined && prev !== undefined && last.length === 1) {
    const moved = prev.pop();
    if (moved !== undefined) last.unshift(moved);
  }

  return chunks.map((destinations) => ({ destinations }));
}

/**
 * One Matrix request: source at index 0, destinations 1..k.
 *
 * `null` is NOT zero. An unroutable pair returns `null`, and writing `0` would
 * assert the site sits at the origin — a real and meaningful value — so the two
 * would be indistinguishable on screen. Same failure as a failed count reading 0.
 */
async function matrixRow(
  origin: Origin,
  req: MatrixRequest,
): Promise<{ ok: true; miles: number[]; minutes: number[] } | { ok: false; error: string }> {
  const coords = [
    `${origin.longitude.toFixed(6)},${origin.latitude.toFixed(6)}`,
    ...req.destinations.map((d) => `${d.longitude.toFixed(6)},${d.latitude.toFixed(6)}`),
  ].join(';');

  /**
   * ★ ★ `;` HERE, NOT `,` — AND THE FIRST LIVE RUN IS HOW THIS WAS FOUND.
   *
   * The coordinate list is `;`-separated and `sources`/`destinations` take **their
   * own** separators, which are also `;` but which a reader naturally writes as
   * commas because that is how a list of indices reads. Sending `destinations=1,2,…`
   * is answered with:
   *
   *   HTTP 422 — destinations may be "all" or semicolon-separated list of 0-based
   *              integer indices
   *
   * — a message that names the parameter and the accepted syntax, which is the one
   * thing that made this a two-line fix rather than an afternoon. Nothing was
   * written: the failure path stores no distance, so the rows stayed NULL, which
   * is exactly "not computed" and is retried.
   *
   * (`sources=0` is a single index and is unaffected either way.)
   *
   * ★ AND A SINGLE DESTINATION IS SENT TWICE. `planMatrix` rebalances so a chunk of
   *   exactly 1 is normally avoided, but when the register holds exactly one pinned
   *   site there is nothing to borrow from and the API's "minimum number of matrix
   *   elements is 2" would reject the only request. Sending the same index twice
   *   satisfies the floor; the second answer is the origin paired with itself and is
   *   discarded below, so the extra element costs nothing and decides nothing.
   */
  const indices = req.destinations.map((_, i) => i + 1);
  const destinations = (indices.length === 1 ? [indices[0] as number, indices[0] as number] : indices).join(';');
  const url =
    `${MATRIX_URL}/${coords}?sources=0&destinations=${destinations}` +
    `&annotations=distance,duration&access_token=${encodeURIComponent(token())}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} — ${(await res.text()).slice(0, 300)}` };
    }
    const body = (await res.json()) as {
      code?: string;
      distances?: (number | null)[][];
      durations?: (number | null)[][];
    };
    if (body.code !== undefined && body.code !== 'Ok') {
      return { ok: false, error: `Mapbox code ${body.code}` };
    }
    const dist = body.distances?.[0]?.slice(0, req.destinations.length);
    const dur = body.durations?.[0]?.slice(0, req.destinations.length);
    if (!Array.isArray(dist) || !Array.isArray(dur) || dist.length !== req.destinations.length) {
      return {
        ok: false,
        error: `expected ${req.destinations.length} distances, got ${dist?.length ?? 'none'}`,
      };
    }
    return {
      ok: true,
      miles: dist.map((m) => (typeof m === 'number' && Number.isFinite(m) ? m / METRES_PER_MILE : NaN)),
      minutes: dur.map((s) => (typeof s === 'number' && Number.isFinite(s) ? s / 60 : NaN)),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// The Directions step.
// ---------------------------------------------------------------------------
//
//  Matrix says HOW FAR. Directions says WHICH WAY, and it is the only one of the
//  two that will. This step asks for the road between the origin and each pinned,
//  routable site and stores the simplified line plus the turns along it.
//
//  ★ IT DOES NOT TOUCH `vendor_site_geo.drive_miles`, AND THAT IS NOT AN
//    OVERSIGHT. The two endpoints disagree — the same 24-site sample that
//    reproduced the stored Matrix figure to within 0.0049 mi agreed with
//    Directions on only 11 of 24 rows and differed by as much as 34.48 mi. So the
//    register keeps the figure that is reproducible, and this step's mileage is
//    stored beside it, named, as the length of the line it drew.

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Five decimal places of a degree, which is about 1.1 m — far below one pixel at
 * any zoom this map offers, and enough to stop two runs differing in the last
 * digit for float noise alone.
 */
const round5 = (n: number): number => Math.round(n * 1e5) / 1e5;

/**
 * ★ WHAT MAKES A STORED ROUTE STALE — AND WHY IT IS NOT THE PIN ALONE.
 *
 * The same job `address_hash` does for a geocode, for the same reason: without
 * it a re-run cannot tell "this is current, skip it" from "this site was
 * re-geocoded and this line now starts somewhere else", so it either re-fetches
 * every route every run — ~622 metered calls to learn nothing — or it never
 * notices a moved pin.
 *
 * It covers the ORIGIN as well as the pin, because a route is a function of both.
 * Moving the default origin invalidates every row in this table, and that must
 * not require any pin to have changed: between the two points the origin is the
 * one that moves in a way nobody would think to check.
 *
 * It also covers `ROUTE_EXTRACT_VERSION` — the derivation, not just the inputs.
 * See that constant: a row can be stale with respect to the code that wrote it.
 */
function pinHashOf(latitude: number, longitude: number, originSlug: string): string {
  return createHash('sha256')
    .update([round5(latitude), round5(longitude), originSlug, ROUTE_EXTRACT_VERSION].join('|'))
    .digest('hex');
}

/** A step of the route, trimmed to the fields the panel renders or may later need. */
interface RouteStep {
  instruction: string;
  name: string | null;
  distance_miles: number;
  duration_minutes: number;
  type: string | null;
  modifier: string | null;
  longitude: number | null;
  latitude: number | null;
}

interface RouteAnswer {
  status: 'ok' | 'no_route' | 'error';
  reason: string | null;
  miles: number | null;
  minutes: number | null;
  geometry: string | null;
  steps: string | null;
  stepCount: number | null;
}

/** The shape Directions returns, as `unknown` throughout — every field below is guarded. */
interface DirectionsStep {
  distance?: unknown;
  duration?: unknown;
  name?: unknown;
  maneuver?: { instruction?: unknown; type?: unknown; modifier?: unknown; location?: unknown };
}

interface DirectionsRoute {
  distance?: unknown;
  duration?: unknown;
  geometry?: { coordinates?: unknown };
  legs?: { steps?: unknown }[];
}

const asString = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const asNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/**
 * Ask Directions for the road between the origin and one site.
 *
 * `overview=simplified` AND NOT `full`, measured:
 *
 *     overview=full        130 / 6,289 / 15,136 coordinates = 2.9 / 139.9 / 336.7 KB
 *     overview=simplified   14 /    33 /     49 coordinates = 0.3 /   0.7 /   1.1 KB
 *
 * `full` is road geometry at roughly one point every few metres — about 100 MB
 * across 622 sites, for detail that is invisible in a 220-pixel-tall panel.
 * `simplified` is the same road simplified to display resolution, 50x smaller, and
 * it draws the same line at this size.
 *
 * Never throws: a failure comes back as `status: 'error'`, which is retryable and
 * is NOT the same answer as `no_route`.
 */
async function directionsRoute(origin: Origin, latitude: number, longitude: number): Promise<RouteAnswer> {
  /**
   * ★ MAPBOX TAKES `{longitude},{latitude}` — AND GETTING THAT BACKWARDS COSTS AN
   *   HOUR, BECAUSE THE FAILURE LOOKS LIKE SOMETHING ELSE ENTIRELY.
   *
   *   The origin is read from a row that names its fields (`origin.longitude`,
   *   `origin.latitude`) so it cannot be transposed by accident. The site arrives
   *   as two positional numbers, and the order every human reads a coordinate in —
   *   latitude first — puts `42.727580` where a longitude belongs. Mapbox accepts
   *   it, because 42 is a valid longitude, and reads the point as latitude -70.86:
   *   the Southern Ocean. The route it is then asked for exceeds the driving
   *   profile's maximum length, and the answer is a perfectly reasonable-looking
   *
   *       HTTP 422  { code: 'InvalidInput',
   *                   message: 'Route exceeds maximum distance limitation' }
   *
   *   about a limit that was never the problem. Nothing about the request looks
   *   malformed, and the same URL with the pair the right way round returns 200.
   *   So: longitude first, and keep the two `toFixed` calls adjacent so a swap is
   *   visible in a diff.
   */
  const coords =
    `${origin.longitude.toFixed(6)},${origin.latitude.toFixed(6)};` +
    `${longitude.toFixed(6)},${latitude.toFixed(6)}`;
  const url =
    `${DIRECTIONS_URL}/${coords}` +
    `?alternatives=false&geometries=geojson&overview=simplified&steps=true` +
    `&access_token=${encodeURIComponent(token())}`;

  const noRoute = (code: string): RouteAnswer => ({
    status: 'no_route',
    reason: `no road route — the routing service answered ${code} for this pair`,
    miles: null,
    minutes: null,
    geometry: null,
    steps: null,
    stepCount: null,
  });

  let lastError = 'no attempt was made';

  for (let attempt = 1; attempt <= ROUTE_ATTEMPTS; attempt += 1) {
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < ROUTE_ATTEMPTS) {
        await sleep(ROUTE_BACKOFF_MS * attempt * attempt);
        continue;
      }
      break;
    }

    /**
     * ★ A 429 IS THE RATE LIMITER, NOT A BROKEN REQUEST, AND IT IS EXPECTED ON A
     *   FULL RUN. Without a retry the first burst would mark every remaining site
     *   `error` — a status that says "we could not ask" — and the run would need a
     *   second pass to finish work it had already been given the answer to. 5xx is
     *   retried for the same reason; a 4xx that is not 429 is not, because it will
     *   not change.
     */
    if (res.status === 429 || res.status >= 500) {
      lastError = `HTTP ${res.status}`;
      if (attempt < ROUTE_ATTEMPTS) {
        await sleep(ROUTE_BACKOFF_MS * attempt * attempt);
        continue;
      }
      break;
    }

    if (!res.ok) {
      /**
       * ★ THE BODY IS READ, NOT DISCARDED, BECAUSE IT IS THE ONLY THING THAT SAYS
       *   WHAT IS WRONG. A bare `HTTP 422` is a status, not a diagnosis. Mapbox
       *   puts a sentence in the body — `Route exceeds maximum distance limitation`,
       *   `Not Authorized - Invalid Token` — and it is the whole difference between
       *   a five-minute fix and an afternoon of guessing. Read as text and parsed
       *   defensively, because an error response is exactly where the shape is not
       *   guaranteed.
       */
      const detail = await res.text().catch(() => '');
      let note = `HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(detail) as { code?: unknown; message?: unknown };
        const parts = [asString(parsed.code), asString(parsed.message)].filter(
          (part): part is string => part !== null,
        );
        if (parts.length > 0) note = `HTTP ${res.status} ${parts.join(' — ')}`;
      } catch {
        const trimmed = detail.trim();
        if (trimmed !== '') note = `HTTP ${res.status} — ${trimmed.slice(0, 200)}`;
      }
      return {
        status: 'error',
        reason: `could not be measured — ${note}`,
        miles: null,
        minutes: null,
        geometry: null,
        steps: null,
        stepCount: null,
      };
    }

    let body: { code?: unknown; routes?: unknown };
    try {
      body = (await res.json()) as { code?: unknown; routes?: unknown };
    } catch (err) {
      lastError = `the response was not JSON (${err instanceof Error ? err.message : String(err)})`;
      break;
    }

    const code = asString(body.code);
    if (code === null) {
      // An envelope with no `code` is not an answer we understand, and treating it
      // as `no_route` would report a broken response as a fact about the road.
      lastError = 'the response carried no `code`';
      break;
    }
    if (code !== 'Ok') return noRoute(code);

    const routes = Array.isArray(body.routes) ? (body.routes as DirectionsRoute[]) : [];
    const route = routes[0];
    if (route === undefined) return noRoute(code);

    /**
     * ★ THE SHAPE IS ASSERTED, NOT ASSUMED — the same lesson the geocode step's
     *   envelope check records. Without it a future change to the response would
     *   arrive as `no_route` on every site: a page reporting that nothing in the
     *   register has a road to it, with no error anywhere to say why.
     */
    const rawSteps = route.legs?.[0]?.steps;
    const coordinates = route.geometry?.coordinates;
    if (!Array.isArray(rawSteps) || !Array.isArray(coordinates)) {
      lastError =
        `the route carries no ${Array.isArray(rawSteps) ? 'coordinates' : 'steps'} array — ` +
        "the endpoint's response shape has changed, so nothing was written";
      break;
    }

    const routeMiles = asNumber(route.distance);
    const routeMinutes = asNumber(route.duration);
    if (routeMiles === null || routeMinutes === null) {
      lastError = 'the route carries no distance or duration';
      break;
    }

    /**
     * ★ THE COORDINATE LIST IS VALIDATED BEFORE IT IS STORED. A LineString needs
     *   two points, and a one-point "line" would draw nothing while the panel
     *   claimed a route exists — a blank map under a cheerful caption. It is
     *   treated as a broken response here rather than defended against in the UI,
     *   because the UI cannot tell it apart from a route that is genuinely short.
     */
    const points: number[][] = [];
    for (const pair of coordinates) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      const lng = asNumber(pair[0]);
      const lat = asNumber(pair[1]);
      if (lng === null || lat === null) continue;
      points.push([round5(lng), round5(lat)]);
    }
    if (points.length < 2) {
      lastError = `the route geometry holds ${points.length} usable point(s), fewer than the 2 a line needs`;
      break;
    }

    /**
     * ★ EVERY STEP IS KEPT, INCLUDING THE LAST — WHICH IS THE ARRIVAL AND CARRIES
     *   ZERO DISTANCE. Dropping zero-distance steps looks tidy and silently removes
     *   the sentence that tells the reader they have arrived, leaving a list that
     *   ends mid-journey. Measured on six routes, the steps sum to the route's own
     *   distance to `0.000 mi` with all of them present; that identity is what
     *   makes it honest to print a step's length beside a route total, so the list
     *   is stored whole.
     */
    const steps: RouteStep[] = rawSteps.map((raw) => {
      const s = raw as DirectionsStep;
      const location = Array.isArray(s.maneuver?.location) ? (s.maneuver?.location as unknown[]) : null;
      const lng = location === null ? null : asNumber(location[0]);
      const lat = location === null ? null : asNumber(location[1]);
      const metres = asNumber(s.distance) ?? 0;
      const seconds = asNumber(s.duration) ?? 0;
      return {
        // The service's own sentence, used VERBATIM. Rephrasing it would mean
        // inventing text about real roads.
        instruction: asString(s.maneuver?.instruction) ?? 'Continue',
        name: asString(s.name),
        distance_miles: Math.round((metres / METRES_PER_MILE) * 100) / 100,
        duration_minutes: Math.round((seconds / 60) * 10) / 10,
        type: asString(s.maneuver?.type),
        modifier: asString(s.maneuver?.modifier),
        longitude: lng === null ? null : round5(lng),
        latitude: lat === null ? null : round5(lat),
      };
    });

    if (steps.length === 0) {
      lastError = 'the route carries an empty step list';
      break;
    }

    const routeMilesOut = Math.round((routeMiles / METRES_PER_MILE) * 100) / 100;
    const stepsMilesOut = steps.reduce((acc, s) => acc + s.distance_miles, 0);

    /**
     * ★ ASSERTED HERE, AT THE SOURCE, BECAUSE IT IS THE ONLY CROSS-CHECK THIS TABLE
     *   HAS — AND IT IS THE ONE THAT CAUGHT A UNIT ERROR.
     *
     *   Every step's distance is converted from metres individually; the route's own
     *   total is converted separately, from a field that does not say what it is in.
     *   The first version of this function converted the steps and forgot the total,
     *   so a 748-mile drive was stored as `route_miles = 1203677.50` — a value that
     *   looks like a plausible number in a column, is 1,609 times too large, and
     *   would have been written for all 622 sites without a single error. What
     *   exposed it was this identity: the steps summed to 747.94 and the total
     *   claimed 1,203,677.50.
     *
     *   So it is not a probe's afterthought — it is a precondition of writing. A
     *   route whose own steps do not add up to its own length is a response we do not
     *   understand, and it is refused rather than stored. Measured agreement on real
     *   routes is 0.000–0.001 mi; the tolerance below is 50x that and still catches
     *   any unit or arithmetic mistake by three orders of magnitude.
     *
     *   (A static "a drive is never more than N miles" guard would be the wrong tool:
     *   it encodes a guess about geography. This encodes a fact about the response.)
     */
    const stepsGap = Math.abs(routeMilesOut - stepsMilesOut);
    if (stepsGap > 0.05) {
      lastError =
        `the route's own distance (${routeMilesOut} mi) disagrees with its ${steps.length} step(s) ` +
        `summing ${stepsMilesOut.toFixed(2)} mi — ${stepsGap.toFixed(2)} mi apart, which is a unit or ` +
        'arithmetic fault, not a road';
      break;
    }

    return {
      status: 'ok',
      reason: null,
      /**
       * ★ THE ROUTE TOTALS ARE CONVERTED, AND THE FIELDS THEY COME FROM DO NOT SAY
       *   WHAT THEY ARE IN. Directions names them `distance` and `duration` —
       *   metres and seconds, per the API — and nothing in the JSON says so. The
       *   steps below convert individually; these two lines are the same conversion
       *   for the total, which is the one that was missed. Keep them adjacent.
       */
      miles: routeMilesOut,
      minutes: Math.round((routeMinutes / 60) * 10) / 10,
      geometry: JSON.stringify(points),
      steps: JSON.stringify(steps),
      stepCount: steps.length,
    };
  }

  return {
    status: 'error',
    reason: `could not be measured — ${lastError}`,
    miles: null,
    minutes: null,
    geometry: null,
    steps: null,
    stepCount: null,
  };
}

/**
 * Write one site's route.
 *
 * ★ AN UPSERT IS LEGAL HERE, AND THE CONTRAST WITH `writeDistance` IS THE POINT.
 *   That one had to be UPDATE-only because SQLite checks NOT NULL *before* it
 *   resolves `ON CONFLICT`, so the statement's insert branch was rejected on
 *   every row even when a matching row existed to update. Here every column is
 *   either supplied by the caller or defaulted, and `route_status` is NOT NULL and
 *   always written — so one statement covers a new row and a rewritten one alike.
 *
 * `rowsAffected` is checked rather than assumed: an upsert on a primary key
 * affects exactly one row, so anything else means the statement did not do what
 * this function believes it did.
 */
async function writeRoute(
  siteId: number,
  answer: RouteAnswer,
  originSlug: string,
  pinHash: string,
): Promise<void> {
  const res = await storeDriver('app')
    .execute({
      sql:
        `INSERT INTO vendor_site_route
           (vendor_site_id, route_status, route_reason, route_miles, route_minutes,
            route_origin_slug, pin_hash, geometry, steps, step_count, route_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(vendor_site_id) DO UPDATE SET
           route_status      = excluded.route_status,
           route_reason      = excluded.route_reason,
           route_miles       = excluded.route_miles,
           route_minutes     = excluded.route_minutes,
           route_origin_slug = excluded.route_origin_slug,
           pin_hash          = excluded.pin_hash,
           geometry          = excluded.geometry,
           steps             = excluded.steps,
           step_count        = excluded.step_count,
           route_at          = datetime('now')`,
      args: [
        siteId,
        answer.status,
        answer.reason,
        answer.miles,
        answer.minutes,
        originSlug,
        pinHash,
        answer.geometry,
        answer.steps,
        answer.stepCount,
      ],
    })
    .catch((err: unknown) => {
      throw new Error(
        `writeRoute(${siteId}, ${answer.status}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });

  if (res.rowsAffected !== 1) {
    throw new Error(
      `writeRoute(${siteId}, ${answer.status}) affected ${res.rowsAffected} row(s) in vendor_site_route, expected 1.`,
    );
  }
}

/**
 * What is already stored, so a run can skip what is still current.
 *
 * Only the two columns the decision needs are read. The geometry is deliberately
 * not: pulling ~3.8 KB of geometry a row across every site to answer a question
 * about a hash is the cost this function exists to avoid.
 */
async function readStoredRoutes(): Promise<Map<number, string>> {
  const res = await storeDriver('app').execute({
    sql: 'SELECT vendor_site_id, route_status, pin_hash FROM vendor_site_route',
    args: [],
  });
  const map = new Map<number, string>();
  for (const row of res.rows as Row[]) {
    // Only an `ok` row can be current. `no_route` and `error` are always re-asked:
    // one is cheap to reconfirm and the other is the entire reason a retryable
    // status exists. A successful route is the expensive thing to re-fetch, so
    // that is the one `pin_hash` protects.
    if (String(row.route_status) !== 'ok') continue;
    map.set(Number(row.vendor_site_id), String(row.pin_hash ?? ''));
  }
  return map;
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  say('Vendor-site geocoding and driving distance');
  say('==========================================');

  // ── Guard: this job reads the ledger, and only Oracle has a register ──────
  const ledger = db.stores().find((s) => s.id === 'ledger');
  if (ledger === undefined) throw new Error('No ledger store is configured.');
  if (ledger.dialect !== 'oracle') {
    throw new Error(
      `The register is built from the ledger's purchase orders and the ledger is ${ledger.dialect} ` +
        `(${ledger.label}) — so there is no site to geocode. Point the server at Oracle ` +
        '(DB_MODE=oracle, ORACLE_THICK=1).',
    );
  }
  const app = db.stores().find((s) => s.id === 'app');
  say(`ledger : ${ledger.label} (${ledger.dialect})`);
  say(`app    : ${app?.label ?? 'unknown'} — pins are written here`);

  // ── Scope, from the tenant, the same way the register gets it ────────────
  const tenant = await defaultTenant();
  const since = fiscalFloor(tenant.startFy);
  const scopeIsShipped =
    tenant.fund === PLAN_SCOPE.fund &&
    tenant.startFy === PLAN_SCOPE.startFy &&
    tenant.programs.length === PLAN_SCOPE.programs.length &&
    PLAN_SCOPE.programs.every((p) => tenant.programs.includes(p));

  say(`scope  : fund ${tenant.fund} · programs ${tenant.programs.join('/')} · floor ${since} (start_fy ${tenant.startFy})`);
  say(
    scopeIsShipped
      ? '         this is the scope the plan measured under, so its figures apply'
      : '         ★ NOT the scope the plan measured under — its figures do not apply, only this run’s do',
  );
  say('');

  // ── The population ───────────────────────────────────────────────────────
  let sites = await readSites(tenant.programs, tenant.fund, since);
  if (SITES_ONLY.length > 0) {
    const keep = new Set(SITES_ONLY);
    sites = sites.filter((s) => keep.has(s.siteId));
  }

  const paths = sites.map((s) => ({ site: s, hash: hashOf(s) }));
  const distinctHashes = new Set(paths.map((p) => p.hash));

  /**
   * ★ `distinct addresses` IS ONLY READABLE AGAINST THE NUMBER OF SITES THAT SHARE
   *   ONE, so it is measured and printed beside it rather than left as a subtraction
   *   the reader has to perform. `sites − distinct` is the count of sites beyond the
   *   first in each group, which is NOT the group count and not the number of sites in
   *   the groups; the two are printed separately for that reason.
   *
   * ★ AND A SHARED GROUP IS NEVER A DEFECT. `hashOf` is over the same four fields the
   *   request is built from, so two sites in one group send a byte-identical query and
   *   one answer belongs to both — which is the whole point of geocoding per address.
   *   The figure that WOULD be a defect is `distinct` falling because `streetOf`
   *   collapsed *different* addresses onto one hash; that is what the street test's
   *   suite rule caused (see `SUITE_PREFIX_RE`), and it shows up here as an implausibly
   *   large group rather than as a plausible small one.
   */
  const sitesPerHash = new Map<string, number>();
  for (const p of paths) sitesPerHash.set(p.hash, (sitesPerHash.get(p.hash) ?? 0) + 1);
  const sharedGroups = [...sitesPerHash.values()].filter((n) => n > 1);

  // ── What is already stored, and what each site's plan is ─────────────────
  const stored = DISTANCE_ONLY ? new Map<number, StoredPin>() : await readStoredPins();

  type Action = 'skip' | 'po_box' | 'geocode';
  const plans = paths.map((p) => {
    const prior = stored.get(p.site.siteId);
    const answered = prior !== undefined && FINAL_STATUSES.has(prior.status) && prior.hash === p.hash;

    let action: Action;
    if (!REFRESH && answered) action = 'skip';
    /**
     * ★ THE BOX TEST IS OVER ALL THREE LINES, AND THE STREET TEST DECIDES IT. A site
     *   is a box only when it names a box **and** no line offers a street: `ORDER
     *   SERVICES` / `PO BOX 543` is a box (nothing to ask), while `4985 Lower Blue
     *   Mountain Rd.` / `PO Box 4227` still names a real street and is therefore
     *   sent. Reading line 1 alone filed 8 such sites as `no_match` with a reason
     *   that blamed Mapbox for their box, and the same narrow read missed the box on
     *   10 more whose line 1 is a department name.
     */
    else if (namesABox(p.site) && !namesAStreet(p.site)) action = 'po_box';
    else action = 'geocode';

    return { ...p, prior, action };
  });

  const poBoxPlans = plans.filter((p) => p.action === 'po_box');
  const geocodePlans = plans.filter((p) => p.action === 'geocode');
  const skipped = plans.filter((p) => p.action === 'skip');

  /**
   * ★★ A `geocode` PLAN MUST CARRY A STREET, AND THIS IS CHECKED RATHER THAN TRUSTED.
   *    `hashOf` keys on four fields, so a blank street makes the hash `|CITY|ST|ZIP` —
   *    one value shared by every streetless site in that city. A run in which the
   *    street test is one shape too wide therefore does not fail loudly: it collapses
   *    N sites onto a single degenerate query (`address_line1: ''`, city and postcode
   *    only), which Mapbox will happily answer, so a pin lands on a site that never
   *    named a street and the row records an address nobody asked about. This happened
   *    once already — 13 sites, and the only symptom was `distinct addresses` reading
   *    776 where the plan says 789. A request with no street is not a weaker query,
   *    it is a different one, so it throws before anything is sent.
   */
  const streetless = geocodePlans.filter((p) => p.site.street === '');
  if (streetless.length > 0) {
    const ids = streetless.slice(0, 5).map((p) => p.site.siteId);
    throw new Error(
      `${N(streetless.length)} site(s) are planned for geocoding with no street at all: ` +
        `${ids.join(', ')}${streetless.length > ids.length ? ', …' : ''}. They would share one ` +
        'degenerate query and one pin. Fix the street classifier — do not relax this check.',
    );
  }

  /** The distinct addresses that need a fetch, keyed by hash, carrying one address as the query. */
  const needByHash = new Map<string, Site>();
  for (const p of geocodePlans) if (!needByHash.has(p.hash)) needByHash.set(p.hash, p.site);

  const addresses = [...needByHash.entries()];
  const capped = LIMIT > 0 ? addresses.slice(0, LIMIT) : addresses;
  const posts = Math.ceil(capped.length / CHUNK);

  /**
   * ★ THE PO-BOX ADDRESS COUNT IS PRINTED, NOT JUST THE SITE COUNT. The request
   *   total is `distinct addresses − distinct PO-box addresses`, and the two
   *   differ whenever two box sites hold one box (here: 136 sites, 134 addresses).
   *   Printing only the site count makes the subtraction look like it should come
   *   out at 653 when it is really 655 — which is exactly the confusion the plan's
   *   own §1 figure records, and the reason this pair is on the same screen.
   */
  const poBoxAddresses = new Set(poBoxPlans.map((p) => p.hash)).size;

  /**
   * ★ HOW MANY REQUESTS DO NOT USE `ADDRESS_LINE1`, PRINTED BESIDE THE COUNTS THAT
   *   DEPEND ON IT. 24 sites name their street on a later line, and for those the
   *   query differs from the address printed on the register — so a reader comparing
   *   the two needs to know the rule was applied and how often. A silent field swap
   *   would make the stored `query_address` look like a transcription error.
   */
  const fromLaterLine = sites.filter((s) => s.street !== '' && s.street !== s.line1.trim()).length;

  /**
   * ★★ WHAT THE `po_box` VERDICT RESTED ON — PRINTED, BECAUSE IT WITHHOLDS A SITE.
   *    A box site is never sent, so a rule that is one shape too eager removes the
   *    site from the map behind a reason that sounds like the data's fault. The
   *    records split cleanly in two: sites naming only a box (nothing to send, the
   *    verdict is forced), and sites that ALSO carry a non-box line the street test
   *    refused (the verdict was a judgement, and only this group can be wrong).
   *    So it is the refused lines that are listed — a department name is a correct
   *    refusal, an unnumbered street (`STANBURY INDUSTRIAL DRIVE`) is a rule that is
   *    too narrow and a site withheld wrongly. Counting them without naming them
   *    would leave the reader able to see that 11 sites moved into the box pile and
   *    unable to see whether that was right.
   */
  const boxRefusals = new Map<string, number>();
  for (const p of poBoxPlans) {
    for (const l of linesOf(p.site)) {
      if (PO_BOX_RE.test(l)) continue;
      const key = l.trim();
      boxRefusals.set(key, (boxRefusals.get(key) ?? 0) + 1);
    }
  }
  const boxSitesWithOtherLine = poBoxPlans.filter((p) =>
    linesOf(p.site).some((l) => !PO_BOX_RE.test(l)),
  ).length;
  const boxSitesOnlyBoxes = poBoxPlans.length - boxSitesWithOtherLine;

  // ── The gate ─────────────────────────────────────────────────────────────
  say('Population');
  say(`  sites in scope            ${N(sites.length)}`);
  say(`  street from line 2 or 3   ${N(fromLaterLine)}   (line 1 is a name, not a street)`);
  say(`  distinct addresses        ${N(distinctHashes.size)}`);
  say(
    `  addresses held by >1 site ${N(sharedGroups.length)}` +
      `   (${N(sharedGroups.reduce((a, b) => a + b, 0))} sites; largest ${N(sharedGroups.length > 0 ? Math.max(...sharedGroups) : 0)})`,
  );
  say(`  PO box sites              ${N(poBoxPlans.length)}   (${N(poBoxAddresses)} distinct address(es) — never sent)`);
  say(`  already answered, skipped ${N(skipped.length)}`);
  say(`  geocode requests          ${N(addresses.length)}${LIMIT > 0 ? ` (limited to ${N(capped.length)})` : ''}`);
  say(`  batch POSTs               ${N(posts)}`);
  if (poBoxPlans.length > 0) {
    say(`  box verdict rests on      ${N(boxSitesOnlyBoxes)} naming only a box`);
    if (boxSitesWithOtherLine > 0) {
      say(`                            ${N(boxSitesWithOtherLine)} also naming a line the street test refused:`);
      for (const [line, n] of [...boxRefusals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 20)) {
        say(`                              ×${N(n)}  ${line}`);
      }
      if (boxRefusals.size > 20) say(`                              … and ${N(boxRefusals.size - 20)} more distinct line(s)`);
    }
  }
  say('');
  if (LIMIT === 0 && SITES_ONLY.length === 0) {
    /**
     * ★ THE IDENTITY IS COMPUTED AND COMPARED, NOT PRINTED AS ARITHMETIC. The
     *   subtraction `distinct − box addresses` equals the number of addresses
     *   actually queried only when the two hash sets are DISJOINT — when no site we
     *   will ask about carries the same four fields as a site we will not. Printing
     *   the subtraction makes that equality look like a fact the code knows; checking
     *   it makes a collision show up as a FAIL here rather than as one site quietly
     *   inheriting another's pin, or a box answer landing on a mappable site.
     */
    const expected = distinctHashes.size - poBoxAddresses;
    const agrees = expected === addresses.length;
    say(
      `  distinct − box addresses  ${N(distinctHashes.size)} − ${N(poBoxAddresses)} = ${N(expected)}` +
        `, against ${N(addresses.length)} actually queried ${agrees ? '(they agree)' : '(★ THEY DISAGREE)'}`,
    );
    if (!agrees) {
      gateFailures.push(
        `a PO-box site and a geocoded site share an address hash: the subtraction expects ${N(expected)} ` +
          `queried addresses and the plan holds ${N(addresses.length)}. Two sites with one address must not ` +
          'hold two answers, and a box must not be sent, so resolve this before any request is sent.',
      );
    }
    say('');
  }

  if (scopeIsShipped && SITES_ONLY.length === 0 && LIMIT === 0) {
    const checks: [string, number, number][] = [
      ['sites', sites.length, PLAN_FIGURES.sites],
      ['distinct addresses', distinctHashes.size, PLAN_FIGURES.distinct],
      ['PO boxes', poBoxPlans.length, PLAN_FIGURES.poBoxes],
      ['geocode requests', addresses.length, PLAN_FIGURES.requests],
      ['batch POSTs', posts, PLAN_FIGURES.posts],
    ];
    say('Gate against the plan (§1, shipped scope)');
    for (const [label, got, want] of checks) {
      const ok = got === want;
      say(`  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(20)} ${N(got).padStart(6)}  expected ${N(want)}`);
      if (!ok) {
        gateFailures.push(
          `${label}: this run reads ${N(got)}, the plan measured ${N(want)} — the population predicate ` +
            'has drifted from the register’s and THAT is the bug to fix before any request is sent.',
        );
      }
    }
    say('');
  }

  // ── Country classification, printed rather than asserted ─────────────────
  //
  // ★ NOT GATED, AND THE MEASUREMENT HERE SETTLES WHAT §1 COULD NOT. §1 lists 795
  //   United States + 3 outside the US + 2 with no STATE against a population of
  //   800, and 795 + 3 + 2 = 800 only if the two state-less sites are inside one of
  //   the other columns — which the table does not say. Measured, they are
  //   `VANCOUVER BRITISH COLUMBIA` / `V5X3M3` and `VANCOUVER` / `V6Z 0C8`, i.e. both
  //   Canadian, so all five non-US sites are in Canada and §1's "3" counts the ones
  //   that carry a province code or the literal `CANADA`.
  //
  // ★ AND THEY STAY `unknown` HERE, ON PURPOSE. Both carry a Canadian postal code
  //   (`V…`), which is enough for a reader and NOT enough for this classifier: it
  //   reads `STATE` and nothing else, because the whole reason it exists is that §2
  //   proved a guess about the country is what produces a confident wrong pin. So
  //   the honest output is 795 / 3 / 2 and the two unclassified sites are named
  //   with both their columns printed. §1's "3" and this "3" measure different
  //   sets, which is exactly why nothing is gated on the country.
  //
  // The consequence of `unknown` is the safe direction: `countryOf() !== 'us'`
  // means no Matrix call, so a site we cannot place is left blank rather than
  // routed from a fleet depot to a guess.
  const byCountry = { us: 0, ca: 0, unknown: 0 };
  const oddStates: Site[] = [];
  for (const s of sites) {
    const c = countryOf(s);
    if (c === 'us') byCountry.us += 1;
    else if (c === 'ca') byCountry.ca += 1;
    else byCountry.unknown += 1;
    if (c !== 'us') oddStates.push(s);
  }

  say('Country, inferred from STATE');
  say(`  United States   ${N(byCountry.us)}`);
  say(`  Canada          ${N(byCountry.ca)}`);
  say(`  not classified  ${N(byCountry.unknown)}   ← country omitted from the request; not sent a distance`);
  for (const s of oddStates) {
    say(
      `    site ${String(s.siteId).padStart(6)}  STATE=${JSON.stringify(s.state)}  CITY=${JSON.stringify(s.city)}` +
        `  ZIP=${JSON.stringify(s.zip)}  → ${countryOf(s) ?? 'unknown'}`,
    );
  }
  say('');

  if (fatal.length > 0) {
    say('Refusing to run:');
    for (const f of fatal) say(`  ${f}`);
    process.exitCode = 1;
    return;
  }

  // ── Dry run ──────────────────────────────────────────────────────────────
  if (DRY_RUN) {
    const pins = [...stored.values()].filter((p) => p.status === 'matched' && p.latitude !== null).length;
    const unroutable = byCountry.ca + byCountry.unknown;

    say('DRY RUN — no request was made and nothing was written.');
    say(`  pins stored now           ${N(pins)}`);

    // ★ ON A FIRST RUN THERE IS NOTHING TO PLAN, AND SAYING "0 destinations" WOULD
    //   READ AS A BROKEN MATRIX STEP. The destinations are the pins the geocode has
    //   not created yet, so the line says which step produces them instead of
    //   printing a zero that describes the order of the two steps and nothing else.
    if (pins === 0 && addresses.length > 0) {
      say(`  Matrix destinations       none yet — the ${N(addresses.length)} answer(s) above are what create them.`);
      say(`                            The distance step runs after the geocode and re-reads the store.`);
    } else {
      say(
        `  Matrix destinations       ${N(pins)} → ${N(Math.ceil(pins / DESTINATIONS_PER_REQUEST))} request(s), ` +
          `${N(pins)} billed element(s)`,
      );
    }
    say(`  never routed              ${N(unroutable)} of ${N(sites.length)} — ${N(byCountry.ca)} in Canada by province code`);
    say(`                            (or the literal "CANADA"), ${N(byCountry.unknown)} whose STATE is blank (both Canadian by postcode)`);
    say('');
    if (gateFailures.length > 0) {
      say('GATE FAILED — the plan’s figures do not match this population:');
      for (const g of gateFailures) say(`  ${g}`);
      process.exitCode = 1;
      return;
    }
    say('GATE PASSED.');
    return;
  }

  // ── Step 1: geocode ──────────────────────────────────────────────────────
  let fetched = new Map<string, GeoAnswer>();
  let requestError: string | null = null;

  if (!DISTANCE_ONLY && !ROUTE_ONLY && capped.length > 0) {
    say(`Geocoding ${N(capped.length)} address(es) in ${N(posts)} POST(s)…`);
    for (let i = 0; i < capped.length; i += CHUNK) {
      const chunk = capped.slice(i, i + CHUNK);
      const items = chunk.map(([, a]) => {
        const item: Record<string, unknown> = {
          address_line1: a.street,
          place: a.city.trim(),
          postcode: a.zip.trim(),
          types: ['address'],
          limit: 1,
          autocomplete: false,
        };
        const region = regionOf(a);
        if (region !== null) item.region = region;
        const country = countryOf(a);
        if (country !== null) item.country = country;
        return item;
      });

      const res = await postBatch(items);
      if (res.error !== null) {
        // ★ A failed request is NOT an answer. Nothing is written for this chunk,
        //   so the next run retries it, and the exit code says the run was partial.
        requestError = `geocode batch failed: ${res.error}`;
        say(`  ✗ ${requestError}`);
        break;
      }

      const body = res.body as { batch?: (GeoFeatureCollection | null)[] } | null;
      const batch = body?.batch;
      if (!Array.isArray(batch) || batch.length !== chunk.length) {
        requestError = `geocode batch returned ${batch?.length ?? 'no'} entries for ${chunk.length} items`;
        say(`  ✗ ${requestError}`);
        break;
      }

      // ★ THE COLLECTION SHAPE IS ASSERTED, NOT ASSUMED. Without this, a future
      //   change to the endpoint's envelope would arrive as an answer of `no_match`
      //   on every site in the batch — a page reporting that nothing in the
      //   register has a location, with no request error anywhere to say why.
      const badEnvelope = batch.findIndex(
        (e) => e !== null && (typeof e !== 'object' || !Array.isArray(e.features)),
      );
      if (badEnvelope >= 0) {
        requestError =
          `geocode batch entry ${badEnvelope} is not a FeatureCollection with a \`features\` array. ` +
          'The endpoint\'s response envelope has changed — nothing was written for this chunk.';
        say(`  ✗ ${requestError}`);
        break;
      }

      chunk.forEach(([hash], j) => {
        // The entry is a collection; the answer is inside it. `limit: 1` means at
        // most one feature, and an empty `features` is the honest "nothing here".
        fetched.set(hash, answerFrom(batch[j]?.features?.[0]));
      });
      say(`  ✓ ${N(Math.min(i + CHUNK, capped.length))} of ${N(capped.length)}`);
    }
  }

  // ── Step 1b: write the geocode results ───────────────────────────────────
  let geocodeWrites = 0;

  // PO boxes: decided locally, no request, and written for every plan that needs one.
  for (const p of poBoxPlans) {
    await writeGeocode(
      p.site.siteId,
      p.site,
      {
        status: 'po_box',
        /**
         * ★ TWO SENTENCES, BECAUSE THERE ARE TWO FACTS. One reason for both would
         *   assert "there is no street on this record" over 13 sites that do carry
         *   another line — `ORDER SERVICES`, `NASCO HEALTHCARE INC`, `STANBURY
         *   INDUSTRIAL DRIVE` — and the legend's whole job is to say why a site has
         *   no pin. Both wordings name the street test as the thing that decided,
         *   and the second says only what was measured: the line named no NUMBERED
         *   street, which is true of a department, a vendor name and an unnumbered
         *   avenue alike, and is the reason a `types: ['address']` query would have
         *   had nothing to return.
         */
        reason: linesOf(p.site).some((l) => !PO_BOX_RE.test(l))
          ? 'PO box — its other line names no numbered street'
          : 'PO box — no street among its address lines',
        latitude: null,
        longitude: null,
        accuracy: null,
        confidence: null,
        featureType: null,
        mapboxId: null,
      },
      p.hash,
    );
    geocodeWrites += 1;
  }

  // Every site whose address was fetched this run — which includes sites that were
  // skipped, because two sites sharing an address must never hold two answers.
  for (const p of plans) {
    const answer = fetched.get(p.hash);
    if (answer === undefined) continue;
    await writeGeocode(p.site.siteId, p.site, answer, p.hash);
    geocodeWrites += 1;
    if (geocodeWrites % 100 === 0) say(`  … ${N(geocodeWrites)} row(s) written`);
  }

  if (!DISTANCE_ONLY && geocodeWrites > 0) say(`  ${N(geocodeWrites)} geocode row(s) written`);
  say('');

  // ── Step 2: driving distance ─────────────────────────────────────────────
  if (!GEOCODE_ONLY && !ROUTE_ONLY) {
    const origin = await readOrigin();
    say(`Origin: ${origin.name} (${origin.slug}) at ${origin.latitude}, ${origin.longitude}`);

    // Two sources for one load-bearing number: the seeded row and `.env`. The row
    // wins, but a disagreement is printed, because every distance on the page is
    // relative to this point and a silent change is a change to all of them.
    const envLat = Number(process.env.MAPBOX_START_LATITUDE ?? '');
    const envLon = Number(process.env.MAPBOX_START_LONGITUDE ?? '');
    if (Number.isFinite(envLat) && Number.isFinite(envLon) && (envLat !== origin.latitude || envLon !== origin.longitude)) {
      say(
        `  ★ MAPBOX_START_LATITUDE/LONGITUDE in .env is ${envLat}, ${envLon} — ` +
          `different from the geo_origin row. The row wins: distances are measured from ${origin.slug}.`,
      );
    }

    const pins = await readStoredPins();
    const candidates = sites
      .map((s) => {
        const pin = pins.get(s.siteId);
        if (pin === undefined || pin.status !== 'matched' || pin.latitude === null || pin.longitude === null) return null;
        return { site: s, latitude: pin.latitude, longitude: pin.longitude, country: countryOf(s) };
      })
      .filter(
        (c): c is { site: Site; latitude: number; longitude: number; country: 'us' | 'ca' | null } => c !== null,
      );

    // ★ THE NON-US PINS ARE STAMPED, NOT SILENTLY BLANK — AND THE STAMP IS TWO
    //   VALUES, NOT ONE. A NULL `drive_status` means "never computed", which is what
    //   the DDL says it means, so writing NULL here would make "outside the US"
    //   indistinguishable from "not run yet" and the page could not tell a reader
    //   why the distance is missing.
    //
    // ★ AND `outside_us` IS NOT THE HONEST STAMP FOR A SITE WHOSE STATE IS BLANK.
    //   Three sites carry a province code or the literal `CANADA`, so "outside the
    //   US" is a fact about them; two carry nothing, so it would be a claim this
    //   script cannot make — they are outside the US *by postcode*, which is a
    //   reader's inference, not ours. `unclassified` says exactly what happened and
    //   leaves the reader the columns (`V5X3M3`, `V6Z 0C8`, city VANCOUVER) that
    //   settle it. Both statuses store no distance; neither claims a route.
    const notRoutable = candidates.filter((c) => c.country !== 'us');
    const routable = candidates.filter((c) => c.country === 'us');

    say(`  pinned sites              ${N(candidates.length)} of ${N(sites.length)} in scope`);
    say(`  outside the US, no route  ${N(notRoutable.filter((c) => c.country === 'ca').length)}`);
    say(`  country unclassified      ${N(notRoutable.filter((c) => c.country === null).length)}   ← also not routed`);
    say(`  destinations              ${N(routable.length)} in ${N(Math.ceil(routable.length / DESTINATIONS_PER_REQUEST))} request(s)`);

    for (const c of notRoutable) {
      await writeDistance(c.site.siteId, null, null, c.country === 'ca' ? 'outside_us' : 'unclassified', origin.slug);
    }

    const requests = planMatrix(routable.map((c) => ({ siteId: c.site.siteId, latitude: c.latitude, longitude: c.longitude })));
    let done = 0;
    let noRoute = 0;
    let failures = 0;

    for (let i = 0; i < requests.length; i += 1) {
      const req = requests[i] as MatrixRequest;
      const res = await matrixRow(origin, req);
      if (!res.ok) {
        failures += 1;
        say(`  ✗ request ${i + 1} of ${N(requests.length)}: ${res.error}`);
        // A failed request leaves `drive_status` NULL for its destinations, which
        // is exactly "not computed" — the honest state, and retried next run.
        continue;
      }
      for (let j = 0; j < req.destinations.length; j += 1) {
        const dest = req.destinations[j] as { siteId: number };
        const miles = res.miles[j] as number;
        const minutes = res.minutes[j] as number;
        if (!Number.isFinite(miles) || !Number.isFinite(minutes)) {
          noRoute += 1;
          await writeDistance(dest.siteId, null, null, 'no_route', origin.slug);
          continue;
        }
        // Rounded AT THE POINT OF STORAGE, so the number the page prints is the
        // number the row holds. Two decimals of a mile is ~16 m — far below the
        // accuracy of a road-network match, and above the noise a reader notices.
        await writeDistance(
          dest.siteId,
          Math.round(miles * 100) / 100,
          Math.round(minutes * 10) / 10,
          'ok',
          origin.slug,
        );
        done += 1;
      }
      say(`  ✓ request ${i + 1} of ${N(requests.length)} — ${N(done)} distance(s) written`);
    }

    say('');
    say(`Distances written         ${N(done)}`);
    say(`No route (null, not 0)    ${N(noRoute)}`);
    say(`Outside the US (blank)    ${N(notRoutable.filter((c) => c.country === 'ca').length)}`);
    say(`Country unclassified      ${N(notRoutable.filter((c) => c.country === null).length)}`);
    if (failures > 0) say(`Failed requests           ${N(failures)} — rerun to retry them`);
    say('');
  }

  // ── Step 3: the road itself — geometry and turns ─────────────────────────
  //
  //  ★ ONE REQUEST PER SITE, WHICH IS 24x THE COST OF THE DISTANCE STEP. Matrix
  //    answers 24 pairs in one call; Directions answers one. That, plus the fact
  //    that this data is read by exactly one open panel and never by the register,
  //    is why it is a separate step behind its own flag rather than something a
  //    routine geocode run does without being asked.
  if (!GEOCODE_ONLY && !DISTANCE_ONLY) {
    const origin = await readOrigin();
    const pins = await readStoredPins();
    const held = REFRESH ? new Map<number, string>() : await readStoredRoutes();

    /**
     * ★ THE CANDIDATES ARE EXACTLY THE PAIRS `drive_status = 'ok'`.
     *
     * Not "every pinned site". `drive_status = 'ok'` is the distance step's
     * assertion that this pair HAS a road between it, so routing precisely those
     * keeps the two tables from disagreeing: this table can never claim a route for
     * a site the register says is unreachable, and a site outside the United States
     * gets no row here for the same reason it got no distance — there is nothing to
     * draw. The geo row is where a reader finds that reason; see the DDL header on
     * why it is deliberately not copied into this table.
     */
    const routable: { siteId: number; latitude: number; longitude: number }[] = [];
    for (const [siteId, pin] of pins) {
      if (pin.status !== 'matched' || pin.latitude === null || pin.longitude === null) continue;
      if (pin.driveStatus !== 'ok') continue;
      routable.push({ siteId, latitude: pin.latitude, longitude: pin.longitude });
    }
    // Sorted, so two runs print the same list in the same order and a diff of the
    // output is about the data rather than about Map iteration order.
    routable.sort((a, b) => a.siteId - b.siteId);

    const currentRoute: typeof routable = [];
    const movedPin: typeof routable = [];
    const neverMeasured: typeof routable = [];
    for (const c of routable) {
      const stored = held.get(c.siteId);
      if (stored === undefined) neverMeasured.push(c);
      else if (stored === pinHashOf(c.latitude, c.longitude, origin.slug)) currentRoute.push(c);
      else movedPin.push(c);
    }

    const todo = [...movedPin, ...neverMeasured];
    const cappedTodos = LIMIT > 0 ? todo.slice(0, LIMIT) : todo;

    say(`Origin for routes: ${origin.name} (${origin.slug})`);
    say(`  pinned, with a road      ${N(routable.length)} of ${N(pins.size)} stored pin(s)`);
    say(`  route already current    ${N(currentRoute.length)}   ← pin AND origin unchanged, not re-fetched`);
    if (movedPin.length > 0) say(`  pin or origin moved      ${N(movedPin.length)}   ← the stored line starts somewhere else now`);
    say(`  never routed             ${N(neverMeasured.length)}`);
    say(`  routes to fetch          ${N(cappedTodos.length)}${LIMIT > 0 ? ` (limited from ${N(todo.length)})` : ''}   ← one request each`);
    say('');

    let ok = 0;
    let noRoute = 0;
    let failures = 0;
    let geometryBytes = 0;
    let stepBytes = 0;
    let stepsStored = 0;

    for (let i = 0; i < cappedTodos.length; i += 1) {
      const c = cappedTodos[i] as { siteId: number; latitude: number; longitude: number };
      const answer = await directionsRoute(origin, c.latitude, c.longitude);
      await writeRoute(c.siteId, answer, origin.slug, pinHashOf(c.latitude, c.longitude, origin.slug));

      if (answer.status === 'ok') {
        ok += 1;
        geometryBytes += answer.geometry?.length ?? 0;
        stepBytes += answer.steps?.length ?? 0;
        stepsStored += answer.stepCount ?? 0;
      } else if (answer.status === 'no_route') {
        noRoute += 1;
      } else {
        failures += 1;
        say(`  ✗ site ${c.siteId}: ${answer.reason ?? 'unknown'}`);
      }

      if ((i + 1) % 25 === 0 || i + 1 === cappedTodos.length) {
        say(`  … ${N(i + 1)} of ${N(cappedTodos.length)} — ${N(ok)} route(s), ${N(noRoute)} with no road, ${N(failures)} failed`);
      }
    }

    say('');
    say(`Routes stored             ${N(ok)}`);
    say(`No road route (no row)    ${N(noRoute)}   ← an answer, and not the same as an error`);
    say(`Skipped, already current  ${N(currentRoute.length)}`);
    if (ok > 0) {
      say(
        `  geometry + steps        ${N(Math.round(geometryBytes / 1024))} KB + ${N(Math.round(stepBytes / 1024))} KB ` +
          `for ${N(ok)} route(s), ${N(stepsStored)} step(s) total (mean ${N(Math.round(stepsStored / ok))} a route)`,
      );
    }
    /**
     * ★ A FAILED REQUEST IS REPORTED AND DOES NOT FAIL THE RUN, MATCHING THE
     *   DISTANCE STEP — deliberately, and because on a first full pass this is
     *   the NORMAL outcome rather than a fault: 622 routes in a burst will meet a
     *   rate limiter, and `error` rows are retried by re-running, which the
     *   `pin_hash` skip makes cheap and idempotent. Exiting non-zero here would
     *   flag an ordinary operational state as a broken build.
     */
    if (failures > 0) say(`Failed requests           ${N(failures)} — rerun to retry them (the rest are skipped)`);
    say('');
  }

  // ── Result ───────────────────────────────────────────────────────────────
  const problems: string[] = [...gateFailures];
  if (requestError !== null) problems.push(requestError);

  if (problems.length > 0) {
    say('Finished with problems:');
    for (const p of problems) say(`  ${p}`);
    process.exitCode = 1;
  } else {
    say('Done.');
  }
}

main()
  .catch((err: unknown) => {
    say('');
    say(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack !== undefined && process.env.DEBUG === '1') say(err.stack);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeDb().catch(() => undefined);
  });
