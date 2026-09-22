import { z } from '../http/z.js';
import { IntParam } from '../http/z.js';
import type { Api } from '../http/api.js';
import { AppError } from '../http/errors.js';
import { findRow, listRows, queryFor, registerResource, type ResourceDescriptor } from './resource.js';
import { bindable, one, quoteIdent, rows, scalar } from '../db/sql.js';
import { date, flag, int, intReq, rowObject, text, textReq, writeObject } from '../schemas/columns.js';

/**
 * Vendors — `PO_VENDORS` and `PO_VENDOR_SITES_ALL`.
 *
 * The first registered domain, so it is also the worked example for the
 * `ResourceDescriptor` shape. Two things about these tables set the pattern:
 *
 *   - `PO_VENDORS.ENABLED_FLAG` defaults to `'Y'` and is the only "is this active"
 *     signal in the schema. There is no inactivation date, so a disabled vendor is
 *     a flag and not a timestamp, and the endpoint exposes it as a filter rather
 *     than inventing a lifecycle that the data cannot support.
 *
 *   - `PO_VENDOR_SITES_ALL` is a real child table with a declared foreign key,
 *     which makes it the case that justifies the checks in `db/relations.ts`:
 *     deleting a vendor that still has sites must be a 409, not a cascade nobody
 *     asked for and not silent orphans.
 */

const VENDOR_COLUMNS = [
  'VENDOR_ID',
  'VENDOR_NAME',
  'VENDOR_TYPE_LOOKUP_CODE',
  'CUSTOMER_NUM',
  'PARENT_VENDOR_ID',
  'ENABLED_FLAG',
  'CREATION_DATE',
] as const;

const VENDOR_SITE_COLUMNS = [
  'VENDOR_SITE_ID',
  'VENDOR_ID',
  'VENDOR_SITE_CODE',
  'ADDRESS_LINE1',
  'ADDRESS_LINE2',
  'ADDRESS_LINE3',
  'CITY',
  'STATE',
  'ZIP',
  'AREA_CODE',
  'PHONE',
  'CUSTOMER_NUM',
  'ORG_ID',
] as const;

const vendorRow = rowObject(
  {
    VENDOR_ID: int('Surrogate key.'),
    VENDOR_NAME: textReq('The vendor name as it appears on the purchase order.'),
    VENDOR_TYPE_LOOKUP_CODE: text(
      "Classification such as `SUPPLIER` or `CONTRACTOR`. Values live in `PO_LOOKUP_CODES` under `LOOKUP_TYPE = 'VENDOR TYPE'`.",
    ),
    CUSTOMER_NUM: text(
      'The legacy accounting system\u2019s vendor number. This is the field that ties a row back to the source extract.',
    ),
    PARENT_VENDOR_ID: int(
      'Parent company. Null for a top-level vendor. Note that this column declares no foreign key, so it is not enforced.',
    ),
    ENABLED_FLAG: flag('Whether the vendor may be used on new orders.'),
    CREATION_DATE: date('When the vendor record was created.'),
  },
  'A vendor as stored in `PO_VENDORS`.',
);

const vendorSiteRow = rowObject(
  {
    VENDOR_SITE_ID: int('Surrogate key.'),
    VENDOR_ID: intReq('The vendor this site belongs to.'),
    VENDOR_SITE_CODE: text('Short site code; appears on purchase orders to identify the ship-from address.'),
    ADDRESS_LINE1: text('Address line 1.'),
    ADDRESS_LINE2: text('Address line 2. Largely null in this sample.'),
    ADDRESS_LINE3: text('Address line 3. Largely null in this sample.'),
    CITY: text('City.'),
    STATE: text('State or province, a two-letter code where present.'),
    ZIP: text('Postal code. Text, so leading zeros survive.'),
    AREA_CODE: text('Telephone area code.'),
    PHONE: text('Telephone number, without the area code.'),
    CUSTOMER_NUM: text('The vendor number repeated on the site, as Oracle stores it.'),
    ORG_ID: int('Operating unit. Constant across this sample.'),
  },
  'A vendor site (remit-to or ship-from address) as stored in `PO_VENDOR_SITES_ALL`.',
);

// Derived from the row schemas above rather than written out again — see
// `writeObject`. Only `VENDOR_NAME` is required to create a vendor, because it is
// the only column the DDL makes NOT NULL.
const vendorWrite = writeObject(vendorRow, 'A vendor to create or update.');
const vendorSiteWrite = writeObject(vendorSiteRow, 'A vendor site to create or update.');

const VENDOR: ResourceDescriptor = {
  name: 'vendors',
  label: 'Vendor',
  basePath: '/api/vendors',
  table: 'PO_VENDORS',
  columns: VENDOR_COLUMNS,
  pk: 'VENDOR_ID',
  pkKind: 'integer',
  searchable: ['VENDOR_NAME', 'CUSTOMER_NUM'],
  sortable: ['VENDOR_NAME', 'VENDOR_ID', 'CREATION_DATE', 'VENDOR_TYPE_LOOKUP_CODE'],
  filters: [
    { column: 'ENABLED_FLAG', description: '`Y` or `N`.' },
    { column: 'VENDOR_TYPE_LOOKUP_CODE', param: 'type', description: 'Exact match on the vendor type.' },
    { column: 'PARENT_VENDOR_ID', kind: 'integer', description: 'Sites of one parent company.' },
  ],
  defaultSort: `${quoteIdent('VENDOR_NAME')} ASC`,
  tags: ['Vendors'],
  row: vendorRow,
  writes: { create: vendorWrite, update: vendorWrite.partial() },
};

const VENDOR_SITE: ResourceDescriptor = {
  name: 'vendorSites',
  label: 'Vendor site',
  // Not `/api/vendors/sites`: that would sit underneath `/api/vendors/{id}`, and
  // whether it resolves as a collection or as a failed integer id would depend on
  // the order the routers happen to be mounted in. A sibling path is unambiguous.
  basePath: '/api/vendor-sites',
  table: 'PO_VENDOR_SITES_ALL',
  columns: VENDOR_SITE_COLUMNS,
  pk: 'VENDOR_SITE_ID',
  pkKind: 'integer',
  searchable: ['VENDOR_SITE_CODE', 'CITY', 'ZIP'],
  sortable: ['VENDOR_SITE_CODE', 'CITY', 'STATE', 'VENDOR_SITE_ID'],
  filters: [{ column: 'VENDOR_ID', kind: 'integer', description: 'Every site of one vendor.' }],
  defaultSort: `${quoteIdent('VENDOR_SITE_CODE')} ASC`,
  tags: ['Vendors'],
  row: vendorSiteRow,
  writes: { create: vendorSiteWrite, update: vendorSiteWrite.partial() },
};

export function registerVendors(api: Api): void {
  registerResource(api, VENDOR);
  registerResource(api, VENDOR_SITE);

  // A sub-collection, because "the sites of this vendor" is the question a detail
  // panel actually asks. It reuses `listRows` so it inherits the count, the sort
  // allowlist and the pagination tiebreaker rather than growing a second paging
  // implementation that would eventually disagree with the flat one.
  api.route({
    method: 'get',
    path: '/api/vendors/{id}/sites',
    operationId: 'vendors_listSites',
    summary: 'List the sites of one vendor',
    description:
      'The same rows as `GET /api/vendor-sites?vendor_id={id}`, as a sub-resource. Returns 404 when ' +
      'the vendor itself does not exist, so an empty page here means "this vendor has no sites" and ' +
      'never "no such vendor".',
    tags: ['Vendors'],
    params: z.object({ id: IntParam }),
    query: queryFor(VENDOR_SITE),
    response: vendorSiteRow,
    paginated: true,
    errors: [400, 404, 500],
    handler: async (ctx) => {
      const id = ctx.params.id;
      await assertVendorExists(id);
      return listRows(VENDOR_SITE, ctx.query as Record<string, unknown>, {
        extraWhere: [`${quoteIdent('VENDOR_ID')} = :parent_id`],
        extraArgs: { parent_id: bindable(id) },
      });
    },
  });

  // Vendor plus sites in one response, so the detail panel does not have to issue
  // two requests and then reconcile them.
  api.route({
    method: 'get',
    path: '/api/vendors/{id}/detail',
    operationId: 'vendors_detail',
    summary: 'A vendor with its sites and order count',
    description:
      'The vendor row, every site it has in site-code order, and a live count of the purchase orders ' +
      'raised against it. Three things the detail panel needs, in one request.',
    tags: ['Vendors'],
    params: z.object({ id: IntParam }),
    response: z
      .object({
        vendor: vendorRow,
        sites: z.array(vendorSiteRow),
        siteCount: z.number().int().openapi({ description: 'Length of `sites`.' }),
        poCount: z
          .number()
          .int()
          .openapi({ description: 'Purchase orders raised against this vendor, counted live.' }),
      })
      .openapi('VendorDetail'),
    errors: [400, 404, 500],
    handler: async (ctx) => {
      const id = bindable(ctx.params.id);
      const vendor = await findRow(VENDOR, ctx.params.id);

      const sites = await rows(
        `SELECT ${VENDOR_SITE_COLUMNS.map(quoteIdent).join(', ')} FROM ${quoteIdent('PO_VENDOR_SITES_ALL')} ` +
          `WHERE ${quoteIdent('VENDOR_ID')} = :id ORDER BY ${quoteIdent('VENDOR_SITE_CODE')} ASC`,
        { id },
      );
      // `siteCount` is the length of the array that was actually returned, not a
      // separate COUNT — the two can never disagree, which is the point.
      const poCount = await scalar(
        `SELECT COUNT(*) AS n FROM ${quoteIdent('PO_HEADERS_ALL')} WHERE ${quoteIdent('VENDOR_ID')} = :id`,
        { id },
      );

      return { vendor, sites, siteCount: sites.length, poCount };
    },
  });
}

async function assertVendorExists(id: unknown): Promise<void> {
  const found = await one(
    `SELECT 1 AS ok FROM ${quoteIdent('PO_VENDORS')} WHERE ${quoteIdent('VENDOR_ID')} = :id`,
    { id: bindable(id) },
  );
  if (!found) throw AppError.notFound(`Vendor ${String(id)}`);
}
