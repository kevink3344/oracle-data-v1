import { Router } from 'express';
import { metaRouter } from './meta.js';
import { extractRouter } from './extract.js';
import { apRouter } from './ap.js';
import { vendorSitesRouter } from './vendorSites.js';
import { createApi } from '../http/api.js';
import { registerActivity } from './activity.js';
import { registerAuth } from './auth.js';
import { registerChartOfAccounts } from './coa.js';
import { registerCustomFields } from './customFields.js';
import { registerFunding } from './funding.js';
import { registerOrganizations } from './organizations.js';
import { registerProcurement } from './procurement.js';
import { registerProjectRegistry } from './projectRegistry.js';
import { registerProjects } from './projects.js';
import { registerSpend } from './spend.js';
import { registerVendors } from './vendors.js';
import { registerViewBuilder } from './views.js';
import { registerPins } from './pins.js';
import { registerReadCaps } from './readCaps.js';
import { registerAi } from './ai.js';
import { registry } from '../http/openapi.js';

/**
 * Every router, combined into one.
 *
 * Mounted with **no** path prefix, and each route declares its own full path
 * (`/api/...`). That is deliberate: the same string is then the Express path and
 * the OpenAPI path, so the spec cannot describe an address the server does not
 * serve. Registering `/health` here and mounting at `/api` looks tidier and is
 * exactly how Swagger UI ends up with a "Try it out" button that 404s.
 *
 * TWO REGISTRATION STYLES, DELIBERATELY
 *
 *   - `registerXxx(api)` — for a domain that is tables. The endpoints are
 *     list/detail/create/update/delete over one table, so the descriptor is the
 *     whole definition and there is nothing per-endpoint to write.
 *
 *   - `xxxRouter()` — for a domain that is logic. `/api/health` probes the
 *     database, the analysis endpoints run aggregation SQL, the extract endpoint
 *     re-emits a document. There is no table to describe.
 *
 * Both end up in the same router, and the duplicate check in `createApi` means a
 * path claimed twice is a startup error rather than one silently shadowing the
 * other.
 *
 * The View Builder is the third shape and it is neither: it is table-shaped for
 * saved views and logic-shaped for running one. It gets `registerXxx(api)`, like
 * the table domains, because below the routes it is still just a descriptor per
 * endpoint — the fact that one of them executes SQL is a property of a handler,
 * not of the registration.
 */
export function apiRouter(): Router {
  const api = createApi();

  registerVendors(api);
  registerProcurement(api);
  registerFunding(api);
  registerSpend(api);
  registerChartOfAccounts(api);
  registerProjects(api);
  registerProjectRegistry(api);

  // The other app-owned write domain, next to the project registry because the
  // two have the same shape: a table this application owns, read and written
  // through here rather than through the ledger. Like the registry it insists on
  // a session — a custom value carries the name of whoever set it, and an
  // unattributed one would be worth nothing — but unlike identity and tenancy
  // below, *who may write* is not its subject; the value is.
  registerCustomFields(api);

  registerViewBuilder(api);
  registerPins(api);
  registerActivity(api);

  // Identity and tenancy are registered last and deliberately so: they are the
  // two domains whose *subject* is who may reach the data, and keeping them last
  // means the block a reader scrolls to after every data endpoint is the one
  // that says so. (`registerCustomFields` above also admits a caller, so "who
  // can refuse one" is not the test — what the domain is *about* is.)
  // Registration order does not affect routing — `createApi` collects the
  // descriptors and Express matches on the path — so this is ordering for the
  // reader, not for the server.
  registerAuth(api);
  registerOrganizations(api);

  // ★ `registerAi` IS CALLED, NOT IMPORTED FOR ITS SIDE EFFECT — and the difference
  //   is the whole reason this note exists. Every `registerResource(...)` in this
  //   codebase lives *inside* a `registerXxx` function, so a bare
  //   `import './ai.js'` would register nothing and report nothing: the module would
  //   have been loaded, its exports unused, and the assistant's two endpoints would
  //   simply not exist while the process started cleanly and exited 0. The guard at
  //   the bottom of this function exists so that failure mode cannot pass silently.
  registerAi(api);

  // ── ★ THE GUARD. A registry populated by factory calls reads EMPTY if a factory is
  //      never invoked, and every derived-scope consumer downstream would then do no
  //      work and exit successfully. Counting the registered routes — rather than
  //      comparing against a hard-coded figure, which would be a hand-copied number of
  //      exactly the kind this codebase has already been bitten by twice — turns that
  //      into a startup failure that names itself.
  const routeCount = registry.definitions.filter((d) => d.type === 'route').length;
  if (routeCount === 0) {
    throw new Error(
      'No API routes were registered. `apiRouter()` calls the `registerXxx(api)` functions; ' +
        'if this fires, one of them was replaced by a side-effect import, or the module was ' +
        'loaded for its exports rather than called. The OpenAPI document would otherwise be ' +
        'published while the server served nothing.',
    );
  }

  api.router.use(metaRouter());
  api.router.use(extractRouter());

  // ★ THE PAYABLES SURFACE, LIVE — the replacement for two frozen files that three
  //   screens read. It is logic-shaped rather than table-shaped: each endpoint
  //   re-emits the extract's own envelope (`body.ResultSets.Table1…`), so the three
  //   client parsers keep working and the repoint is a URL change rather than a
  //   reshape. That is why it is a router and not a `registerXxx(api)`.
  //
  //   It sits beside `extractRouter` deliberately: both read the ledger live, both
  //   derive their window from configuration rather than a parameter, and both
  //   import `scopeClause` so there is one definition of what "in scope" means.
  api.router.use(apRouter());

  // The per-object read caps. Logic-shaped rather than table-shaped: the CRUD is
  // ordinary, but the preview endpoint runs a draft statement against the ledger
  // and returns the rows it produced, which no resource descriptor can express.
  // It is also the only admin surface whose subject is *how much the app reads*
  // rather than what is in the data.
  registerReadCaps(api);

  // The vendor-site register is a logic domain, not a table: it is an aggregate
  // over purchase orders with a scope imported from the extract, so it declares
  // its own route rather than describing one. `registerVendors` above still owns
  // `/api/vendor-sites` — that resource serves the 99,316-row directory, while
  // this serves the 704 sites the organization's money actually went to, and the
  // two paths are siblings so neither shadows the other.
  api.router.use(vendorSitesRouter());

  return api.router;
}
