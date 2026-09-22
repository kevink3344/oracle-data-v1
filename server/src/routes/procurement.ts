import { z } from '../http/z.js';
import { IntParam } from '../http/z.js';
import type { Api } from '../http/api.js';
import { AppError } from '../http/errors.js';
import { findRow, listRows, queryFor, registerResource, type ResourceDescriptor } from './resource.js';
import { bindable, one, quoteIdent, rows, scalar } from '../db/sql.js';
import { date, flag, int, intReq, real, realReq, rowObject, text, textReq, writeObject } from '../schemas/columns.js';

/**
 * Procurement — the purchase-order chain.
 *
 * Five tables, and they are a chain rather than five independent lists:
 *
 *     PO_HEADERS_ALL  ── PO_LINES_ALL ── PO_LINE_LOCATIONS_ALL
 *              └──────────────────────── PO_DISTRIBUTIONS_ALL
 *
 * The thing worth understanding before reading the descriptors is that **the money
 * is not on the line**. `PO_LINES_ALL` carries `UNIT_PRICE` and `QUANTITY`, which
 * look like money and are not: `PO_DISTRIBUTIONS_ALL` is the only table with both
 * an amount and a `CODE_COMBINATION_ID`, so it is the grain at which "what did this
 * order cost, and which account pays for it" can be answered at all.
 *
 * It is tempting to read that as a warning about splitting, and then to check it
 * and find there is no splitting: measured against the sample, all 2,802
 * distributed lines have **exactly one** distribution each, and three further
 * lines have none. So the grain is not finer — but the two figures are still not
 * interchangeable, which is the part that matters:
 *
 *   - `SUM(UNIT_PRICE * QUANTITY)` over the lines is `430,613,104.79`;
 *     `SUM(AMOUNT_ORDERED)` over the distributions is `430,580,538.04`. The line
 *     prices overstate by `32,566.75`.
 *
 *   - The cause is visible in the histogram rather than in theory: 52 lines carry
 *     `QUANTITY = 0` and a real amount, because they are lump sums (`AMOUNT`
 *     basis, not `QUANTITY`), worth `5,870.25` in total — and on those, the
 *     product is `0`. Three 1:1 line/distribution pairs disagree outright.
 *
 * So every total in this module is taken from the distributions and says so. The
 * alternative is not merely a different rounding of the same answer; it is a
 * different number, and it would be presented to a reader as "the committed
 * amount" without anything on screen admitting which of the two it was.
 *
 * `PO_LOOKUP_CODES` is the reference table for every `*_LOOKUP_CODE` column in the
 * schema, a composite keyed by `(LOOKUP_TYPE, LOOKUP_CODE)`. It gets no detail
 * route and no writes, which is the framework's rule for a table whose identity is
 * not a single column — see the note in `resource.ts`.
 */

const poHeaderColumns = [
  'PO_HEADER_ID',
  'PO_NUMBER',
  'TYPE_LOOKUP_CODE',
  'VENDOR_ID',
  'VENDOR_SITE_ID',
  'AGENT_ID',
  'APPROVED_FLAG',
  'APPROVED_DATE',
  'START_DATE_ACTIVE',
  'ORG_ID',
  'CANCEL_FLAG',
  'EXP_PROJECT_NAME',
  'EXP_PO_NUMBER',
] as const;

const poLineColumns = [
  'PO_LINE_ID',
  'PO_HEADER_ID',
  'LINE_TYPE_ID',
  'LINE_NUM',
  'ITEM_ID',
  'ITEM_DESCRIPTION',
  'UNIT_MEAS_LOOKUP_CODE',
  'UNIT_PRICE',
  'QUANTITY',
  'CLOSED_CODE',
  'CANCEL_FLAG',
] as const;

const poShipmentColumns = [
  'LINE_LOCATION_ID',
  'PO_HEADER_ID',
  'PO_LINE_ID',
  'SHIPMENT_NUM',
  'SHIP_TO_LOCATION_ID',
  'QUANTITY',
  'QUANTITY_RECEIVED',
  'AMOUNT_RECEIVED',
  'UNIT_MEAS_LOOKUP_CODE',
  'PO_RELEASE_ID',
  'APPROVED_FLAG',
  'CLOSED_CODE',
] as const;

const poDistributionColumns = [
  'PO_DISTRIBUTION_ID',
  'PO_HEADER_ID',
  'PO_LINE_ID',
  'LINE_LOCATION_ID',
  'CODE_COMBINATION_ID',
  'DELIVER_TO_LOCATION_ID',
  'DISTRIBUTION_NUM',
  'QUANTITY_ORDERED',
  'AMOUNT_ORDERED',
  'AMOUNT_BILLED',
  'ENCUMBERED_FLAG',
  'ENCUMBERED_AMOUNT',
] as const;

const agentColumns = ['AGENT_ID', 'NAME', 'AUTHORIZATION_LIMIT', 'ENABLED_FLAG'] as const;

const lineTypeColumns = [
  'LINE_TYPE_ID',
  'LINE_TYPE',
  'DESCRIPTION',
  'PURCHASE_BASIS',
  'MATCHING_BASIS',
  'ORDER_TYPE_LOOKUP_CODE',
] as const;

const lookupCodeColumns = ['LOOKUP_TYPE', 'LOOKUP_CODE', 'DESCRIPTION'] as const;

const poHeaderRow = rowObject(
  {
    PO_HEADER_ID: int('Surrogate key. The value a distribution or line points back to.'),
    PO_NUMBER: text('The order number as printed. Text, and not unique in this sample — see `EXP_PO_NUMBER`.'),
    TYPE_LOOKUP_CODE: text(
      "Order type, such as `STANDARD` or `BLANKET`. Values live in `PO_LOOKUP_CODES` under `LOOKUP_TYPE = 'PO TYPE'`.",
    ),
    VENDOR_ID: int('The supplier. Foreign key to `PO_VENDORS`.'),
    VENDOR_SITE_ID: int(
      'The supplier site the order was placed with. Carries no foreign key in this DDL, so it is recorded but not enforced.',
    ),
    AGENT_ID: int('The buyer. Foreign key to `PO_AGENTS`.'),
    APPROVED_FLAG: text('`Y` once the order was approved. Null on orders that never reached approval.'),
    APPROVED_DATE: date('When the order was approved. Null when `APPROVED_FLAG` is not `Y`.'),
    START_DATE_ACTIVE: date('The date the order became live.'),
    ORG_ID: int('Operating unit. Constant across this sample, so it groups nothing.'),
    CANCEL_FLAG: text('`Y` on a cancelled order. Defaults to `N`, and is `N` or null for live orders.'),
    EXP_PROJECT_NAME: text(
      'Project name, from the custom columns the source system exported. This and `EXP_PO_NUMBER` are the ' +
        'only project attribution a purchase order has: there is no project or task id on this table, so a ' +
        'PO cannot be joined to a project except by string.',
    ),
    EXP_PO_NUMBER: text(
      'The order number as the source system labels it, kept alongside `PO_NUMBER` rather than instead of it.',
    ),
  },
  'A purchase-order header as stored in `PO_HEADERS_ALL`.',
);

const poLineRow = rowObject(
  {
    PO_LINE_ID: int('Surrogate key.'),
    PO_HEADER_ID: intReq('The order this line belongs to.'),
    LINE_TYPE_ID: int('Goods, services, or a lump sum. Foreign key to `PO_LINE_TYPES`.'),
    LINE_NUM: intReq(
      'The line number as printed. Only unique within its order, which is why it cannot serve as the key.',
    ),
    ITEM_ID: int('Item id where the line references a catalogue item. Mostly null in this sample.'),
    ITEM_DESCRIPTION: text('Free-text description. The actual content of the order for most lines here.'),
    UNIT_MEAS_LOOKUP_CODE: text("Unit of measure, such as `EA` or `AU` (each, or lump sum). Values live in `PO_LOOKUP_CODES`."),
    UNIT_PRICE: real('Price per unit. Money, but not the amount charged — see the module note and `AMOUNT_ORDERED`.'),
    QUANTITY: real('Quantity ordered. `0` on the lump-sum lines, where the amount is the whole story.'),
    CLOSED_CODE: text('Set when the line was closed, such as `FINALLY CLOSED`. Null while open.'),
    CANCEL_FLAG: text('`Y` on a cancelled line. Defaults to `N`.'),
  },
  'A purchase-order line as stored in `PO_LINES_ALL`.',
);

const poShipmentRow = rowObject(
  {
    LINE_LOCATION_ID: int('Surrogate key.'),
    PO_HEADER_ID: intReq('The order this shipment belongs to.'),
    PO_LINE_ID: intReq('The line being shipped.'),
    SHIPMENT_NUM: int('Shipment number within the line. Lines with a single shipment stay at `1`.'),
    SHIP_TO_LOCATION_ID: int('Destination location id. Carries no foreign key, so it is not enforced.'),
    QUANTITY: real('Quantity on this shipment.'),
    QUANTITY_RECEIVED: real('Quantity received so far. Zero across this sample, so receipt progress cannot be shown.'),
    AMOUNT_RECEIVED: real('Value received so far. Zero for the same reason.'),
    UNIT_MEAS_LOOKUP_CODE: text('Unit of measure for this shipment.'),
    PO_RELEASE_ID: int('The release, on a blanket order. Null on standard orders.'),
    APPROVED_FLAG: text('Whether this shipment is approved.'),
    CLOSED_CODE: text('Set when the shipment was closed. Null while open.'),
  },
  'A purchase-order shipment as stored in `PO_LINE_LOCATIONS_ALL`.',
);

const poDistributionRow = rowObject(
  {
    PO_DISTRIBUTION_ID: int('Surrogate key.'),
    PO_HEADER_ID: intReq('The order this distribution belongs to.'),
    PO_LINE_ID: intReq('The line being charged.'),
    LINE_LOCATION_ID: int('The shipment being charged. Nullable: a distribution can sit on the line without a shipment.'),
    CODE_COMBINATION_ID: intReq(
      'The account this money is charged to. Foreign key to `GL_CODE_COMBINATIONS`, and the reason this table ' +
        'is the bridge between procurement and funding.',
    ),
    DELIVER_TO_LOCATION_ID: int('Destination location id. Carries no foreign key, so it is not enforced.'),
    DISTRIBUTION_NUM: int('Distribution number within the line. Starts at `1`.'),
    QUANTITY_ORDERED: real('Quantity charged to this account, after the split.'),
    AMOUNT_ORDERED: real(
      'The amount ordered against this account. This is the authoritative committed figure — see the module note.',
    ),
    AMOUNT_BILLED: real('How much of this distribution has been invoiced. Zero throughout, because no invoice exists.'),
    ENCUMBERED_FLAG: text('`Y` where the distribution was reserved against the budget.'),
    ENCUMBERED_AMOUNT: real('The reserved amount. Compare against `AMOUNT_ORDERED`, not against the line price.'),
  },
  'A purchase-order distribution as stored in `PO_DISTRIBUTIONS_ALL`.',
);

const agentRow = rowObject(
  {
    AGENT_ID: int('Surrogate key.'),
    NAME: textReq('The buyer\u2019s name as it appears on orders.'),
    AUTHORIZATION_LIMIT: real('Approval limit. Sparse in this sample, so it cannot rank agents.'),
    ENABLED_FLAG: flag('Whether the agent may raise new orders.'),
  },
  'A buyer as stored in `PO_AGENTS`.',
);

const lineTypeRow = rowObject(
  {
    LINE_TYPE_ID: int('Surrogate key.'),
    LINE_TYPE: text('Short code, such as `GOODS` or `AMOUNT`.'),
    DESCRIPTION: text('What the type means.'),
    PURCHASE_BASIS: text('How the line is priced, such as `QUANTITY` or `AMOUNT`.'),
    MATCHING_BASIS: text('How the line is matched against an invoice, such as `QUANTITY` or `AMOUNT`.'),
    ORDER_TYPE_LOOKUP_CODE: text('The order type this line type is valid for.'),
  },
  'A purchase-order line type as stored in `PO_LINE_TYPES`.',
);

const lookupCodeRow = rowObject(
  {
    LOOKUP_TYPE: text('The group, such as `PO TYPE` or `UNIT OF MEASURE`.'),
    LOOKUP_CODE: text('The code stored in the `*_LOOKUP_CODE` columns.'),
    DESCRIPTION: text('The label to display for that code.'),
  },
  'A reference code as stored in `PO_LOOKUP_CODES`.',
);

// Derived from the row schemas, so "nullable" and "optional to supply" cannot
// drift apart — see `writeObject`. `PO_HEADERS_ALL` declares no NOT NULL column
// at all, which is a real property of the DDL and not an oversight here: this
// table comes from an extract and the constraint was never modelled.
const poHeaderWrite = writeObject(poHeaderRow, 'A purchase-order header to create or update.');
const poLineWrite = writeObject(poLineRow, 'A purchase-order line to create or update.');
const poShipmentWrite = writeObject(poShipmentRow, 'A purchase-order shipment to create or update.');
const poDistributionWrite = writeObject(poDistributionRow, 'A purchase-order distribution to create or update.');
const agentWrite = writeObject(agentRow, 'A buyer to create or update.');
const lineTypeWrite = writeObject(lineTypeRow, 'A line type to create or update.');

const PURCHASE_ORDER: ResourceDescriptor = {
  name: 'purchaseOrders',
  label: 'Purchase order',
  basePath: '/api/purchase-orders',
  table: 'PO_HEADERS_ALL',
  columns: poHeaderColumns,
  pk: 'PO_HEADER_ID',
  pkKind: 'integer',
  searchable: ['PO_NUMBER', 'EXP_PO_NUMBER', 'EXP_PROJECT_NAME'],
  sortable: ['PO_NUMBER', 'PO_HEADER_ID', 'APPROVED_DATE', 'START_DATE_ACTIVE'],
  filters: [
    { column: 'VENDOR_ID', kind: 'integer', description: 'Orders placed with one supplier.' },
    { column: 'AGENT_ID', kind: 'integer', description: 'Orders raised by one buyer.' },
    { column: 'TYPE_LOOKUP_CODE', param: 'type', description: 'Exact match on the order type.' },
    { column: 'APPROVED_FLAG', description: '`Y` for approved orders only.' },
    { column: 'CANCEL_FLAG', description: '`Y` for cancelled orders only.' },
    {
      column: 'EXP_PROJECT_NAME',
      param: 'project',
      description: 'Exact match on the project name the extract recorded on the order.',
    },
  ],
  defaultSort: `${quoteIdent('PO_HEADER_ID')} DESC`,
  tags: ['Procurement'],
  row: poHeaderRow,
  writes: { create: poHeaderWrite, update: poHeaderWrite.partial() },
};

const PURCHASE_ORDER_LINE: ResourceDescriptor = {
  name: 'purchaseOrderLines',
  label: 'Purchase-order line',
  basePath: '/api/purchase-order-lines',
  table: 'PO_LINES_ALL',
  columns: poLineColumns,
  pk: 'PO_LINE_ID',
  pkKind: 'integer',
  searchable: ['ITEM_DESCRIPTION', 'CLOSED_CODE'],
  sortable: ['LINE_NUM', 'PO_LINE_ID', 'UNIT_PRICE', 'QUANTITY'],
  filters: [
    { column: 'PO_HEADER_ID', kind: 'integer', description: 'Discouraged here: prefer the `{id}/lines` sub-resource.' },
    { column: 'LINE_TYPE_ID', kind: 'integer', description: 'Goods, services, or lump sum.' },
  ],
  defaultSort: `${quoteIdent('PO_HEADER_ID')} ASC, ${quoteIdent('LINE_NUM')} ASC`,
  tags: ['Procurement'],
  row: poLineRow,
  writes: { create: poLineWrite, update: poLineWrite.partial() },
};

const PURCHASE_ORDER_SHIPMENT: ResourceDescriptor = {
  name: 'purchaseOrderShipments',
  label: 'Purchase-order shipment',
  // The table is `PO_LINE_LOCATIONS_ALL`; the URL says shipment because that is
  // what the row is and what Oracle's own UI calls it. The `table` field above
  // is the link back to the data dictionary.
  basePath: '/api/purchase-order-shipments',
  table: 'PO_LINE_LOCATIONS_ALL',
  columns: poShipmentColumns,
  pk: 'LINE_LOCATION_ID',
  pkKind: 'integer',
  sortable: ['SHIPMENT_NUM', 'LINE_LOCATION_ID', 'QUANTITY'],
  filters: [
    { column: 'PO_HEADER_ID', kind: 'integer', description: 'Discouraged here: prefer the `{id}/shipments` sub-resource.' },
    { column: 'PO_LINE_ID', kind: 'integer', description: 'Every shipment of one line.' },
  ],
  defaultSort: `${quoteIdent('PO_HEADER_ID')} ASC, ${quoteIdent('PO_LINE_ID')} ASC, ${quoteIdent('SHIPMENT_NUM')} ASC`,
  tags: ['Procurement'],
  row: poShipmentRow,
  writes: { create: poShipmentWrite, update: poShipmentWrite.partial() },
};

const PURCHASE_ORDER_DISTRIBUTION: ResourceDescriptor = {
  name: 'purchaseOrderDistributions',
  label: 'Purchase-order distribution',
  basePath: '/api/purchase-order-distributions',
  table: 'PO_DISTRIBUTIONS_ALL',
  columns: poDistributionColumns,
  pk: 'PO_DISTRIBUTION_ID',
  pkKind: 'integer',
  sortable: ['DISTRIBUTION_NUM', 'PO_DISTRIBUTION_ID', 'AMOUNT_ORDERED', 'ENCUMBERED_AMOUNT'],
  filters: [
    { column: 'PO_HEADER_ID', kind: 'integer', description: 'Discouraged here: prefer the `{id}/distributions` sub-resource.' },
    { column: 'CODE_COMBINATION_ID', kind: 'integer', description: 'Every order charged to one account.' },
    { column: 'ENCUMBERED_FLAG', description: '`Y` for distributions reserved against the budget.' },
  ],
  defaultSort: `${quoteIdent('PO_HEADER_ID')} ASC, ${quoteIdent('PO_LINE_ID')} ASC, ${quoteIdent('DISTRIBUTION_NUM')} ASC`,
  tags: ['Procurement'],
  row: poDistributionRow,
  writes: { create: poDistributionWrite, update: poDistributionWrite.partial() },
};

const AGENT: ResourceDescriptor = {
  name: 'agents',
  label: 'Buyer',
  basePath: '/api/agents',
  table: 'PO_AGENTS',
  columns: agentColumns,
  pk: 'AGENT_ID',
  pkKind: 'integer',
  searchable: ['NAME'],
  sortable: ['NAME', 'AGENT_ID', 'AUTHORIZATION_LIMIT'],
  filters: [{ column: 'ENABLED_FLAG', description: '`Y` for agents who may still raise orders.' }],
  defaultSort: `${quoteIdent('NAME')} ASC`,
  tags: ['Procurement'],
  row: agentRow,
  writes: { create: agentWrite, update: agentWrite.partial() },
};

const LINE_TYPE: ResourceDescriptor = {
  name: 'lineTypes',
  label: 'Line type',
  basePath: '/api/line-types',
  table: 'PO_LINE_TYPES',
  columns: lineTypeColumns,
  pk: 'LINE_TYPE_ID',
  pkKind: 'integer',
  searchable: ['LINE_TYPE', 'DESCRIPTION'],
  sortable: ['LINE_TYPE', 'LINE_TYPE_ID'],
  defaultSort: `${quoteIdent('LINE_TYPE')} ASC`,
  tags: ['Procurement'],
  row: lineTypeRow,
  writes: { create: lineTypeWrite, update: lineTypeWrite.partial() },
};

/**
 * A reference table with a composite key: read-only, and deliberately so.
 *
 * `PO_LOOKUP_CODES` genuinely has no writable identity — you cannot address "the
 * row whose type is `PO TYPE` and whose code is `STANDARD`" with a single path
 * segment, and inventing `/api/lookup-codes/PO%20TYPE/STANDARD` would put a
 * composite key into the URL space for one table out of sixty. It is read, it is
 * the join target for every `*_LOOKUP_CODE` column, and that is all it needs to be.
 */
const LOOKUP_CODE: ResourceDescriptor = {
  name: 'lookupCodes',
  label: 'Reference code',
  basePath: '/api/lookup-codes',
  table: 'PO_LOOKUP_CODES',
  columns: lookupCodeColumns,
  pkKind: 'text',
  searchable: ['LOOKUP_CODE', 'DESCRIPTION'],
  sortable: ['LOOKUP_TYPE', 'LOOKUP_CODE'],
  filters: [{ column: 'LOOKUP_TYPE', param: 'type', description: 'One group of codes, such as `PO TYPE`.' }],
  defaultSort: `${quoteIdent('LOOKUP_TYPE')} ASC, ${quoteIdent('LOOKUP_CODE')} ASC`,
  tags: ['Procurement'],
  row: lookupCodeRow,
  readOnlyReason:
    'This table is keyed by `(LOOKUP_TYPE, LOOKUP_CODE)`, so a row cannot be addressed by a single id. ' +
    'Reference codes are read through this endpoint and changed in the database.',
};

export function registerProcurement(api: Api): void {
  registerResource(api, PURCHASE_ORDER);
  registerResource(api, PURCHASE_ORDER_LINE);
  registerResource(api, PURCHASE_ORDER_SHIPMENT);
  registerResource(api, PURCHASE_ORDER_DISTRIBUTION);
  registerResource(api, AGENT);
  registerResource(api, LINE_TYPE);
  registerResource(api, LOOKUP_CODE);

  // Lines of one order. Same reasoning as `/api/vendors/{id}/sites`: the detail
  // panel asks "this order's lines", and a 404 on an unknown order keeps an empty
  // page from meaning two different things.
  api.route({
    method: 'get',
    path: '/api/purchase-orders/{id}/lines',
    operationId: 'purchaseOrders_listLines',
    summary: 'List the lines of one purchase order',
    description:
      'Equivalent to `GET /api/purchase-order-lines?po_header_id={id}`, in line-number order. Returns 404 when ' +
      'the order does not exist, so an empty page means the order has no lines.',
    tags: ['Procurement'],
    params: z.object({ id: IntParam }),
    query: queryFor(PURCHASE_ORDER_LINE),
    response: poLineRow,
    paginated: true,
    errors: [400, 404, 500],
    handler: async (ctx) => {
      await assertPurchaseOrderExists(ctx.params.id);
      return listRows(PURCHASE_ORDER_LINE, ctx.query as Record<string, unknown>, {
        extraWhere: [`${quoteIdent('PO_HEADER_ID')} = :header_id`],
        extraArgs: { header_id: bindable(ctx.params.id) },
      });
    },
  });

  api.route({
    method: 'get',
    path: '/api/purchase-orders/{id}/shipments',
    operationId: 'purchaseOrders_listShipments',
    summary: 'List the shipments of one purchase order',
    description: 'Every `PO_LINE_LOCATIONS_ALL` row under one order, ordered by line then shipment number.',
    tags: ['Procurement'],
    params: z.object({ id: IntParam }),
    query: queryFor(PURCHASE_ORDER_SHIPMENT),
    response: poShipmentRow,
    paginated: true,
    errors: [400, 404, 500],
    handler: async (ctx) => {
      await assertPurchaseOrderExists(ctx.params.id);
      return listRows(PURCHASE_ORDER_SHIPMENT, ctx.query as Record<string, unknown>, {
        extraWhere: [`${quoteIdent('PO_HEADER_ID')} = :header_id`],
        extraArgs: { header_id: bindable(ctx.params.id) },
      });
    },
  });

  api.route({
    method: 'get',
    path: '/api/purchase-orders/{id}/distributions',
    operationId: 'purchaseOrders_listDistributions',
    summary: 'List the account distributions of one purchase order',
    description:
      'The money grain: every `PO_DISTRIBUTIONS_ALL` row under one order, with the `CODE_COMBINATION_ID` each ' +
      'amount is charged to. This is the endpoint to call when the question is "which accounts pay for this order".',
    tags: ['Procurement'],
    params: z.object({ id: IntParam }),
    query: queryFor(PURCHASE_ORDER_DISTRIBUTION),
    response: poDistributionRow,
    paginated: true,
    errors: [400, 404, 500],
    handler: async (ctx) => {
      await assertPurchaseOrderExists(ctx.params.id);
      return listRows(PURCHASE_ORDER_DISTRIBUTION, ctx.query as Record<string, unknown>, {
        extraWhere: [`${quoteIdent('PO_HEADER_ID')} = :header_id`],
        extraArgs: { header_id: bindable(ctx.params.id) },
      });
    },
  });

  // The whole order in one response. A detail panel that fetched the header, then
  // the vendor, then the site, then the lines, then four totals would issue eight
  // round trips and could still render a header whose vendor it had not loaded.
  api.route({
    method: 'get',
    path: '/api/purchase-orders/{id}/detail',
    operationId: 'purchaseOrders_detail',
    summary: 'A purchase order with its parties, lines, and totals',
    description:
      'The header, the vendor and vendor site and buyer it names, every line in line-number order, counts of the ' +
      'lines, shipments, and distributions beneath it, and the ordered, billed, and encumbered totals from the ' +
      'distributions. One request, so the panel cannot show a total that disagrees with the row count beside it.',
    tags: ['Procurement'],
    params: z.object({ id: IntParam }),
    response: z
      .object({
        order: poHeaderRow,
        vendor: z
          .object({ VENDOR_ID: int('Supplier key.'), VENDOR_NAME: textReq('Supplier name.') })
          .openapi('PurchaseOrderVendor')
          .nullable(),
        site: z
          .object({
            VENDOR_SITE_ID: int('Site key.'),
            VENDOR_SITE_CODE: text('Site code as printed on the order.'),
            CITY: text('City.'),
            STATE: text('State or province.'),
          })
          .openapi('PurchaseOrderVendorSite')
          .nullable(),
        agent: z
          .object({ AGENT_ID: int('Buyer key.'), NAME: textReq('Buyer name.') })
          .openapi('PurchaseOrderAgent')
          .nullable(),
        lines: z.array(poLineRow).openapi({ description: 'Every line, in line-number order.' }),
        counts: z
          .object({
            lines: z.number().int().openapi({ description: 'Length of `lines`.' }),
            shipments: z.number().int().openapi({ description: 'Live count from `PO_LINE_LOCATIONS_ALL`.' }),
            distributions: z.number().int().openapi({ description: 'Live count from `PO_DISTRIBUTIONS_ALL`.' }),
          })
          .openapi('PurchaseOrderCounts'),
        totals: z
          .object({
            ordered: realReq('Sum of `AMOUNT_ORDERED` over the distributions.'),
            billed: realReq('Sum of `AMOUNT_BILLED` over the distributions. Zero throughout this sample.'),
            encumbered: realReq('Sum of `ENCUMBERED_AMOUNT` over the distributions.'),
            distinctAccounts: z
              .number()
              .int()
              .openapi({ description: 'Distinct `CODE_COMBINATION_ID` values the order is charged to.' }),
          })
          .openapi('PurchaseOrderTotals'),
      })
      .openapi('PurchaseOrderDetail'),
    errors: [400, 404, 500],
    handler: async (ctx) => {
      const id = bindable(ctx.params.id);
      const order = await findRow(PURCHASE_ORDER, ctx.params.id);

      // The right-hand sides are outer-joined because none of the three carries a
      // foreign key from the header that the DDL enforces: `VENDOR_SITE_ID` has no
      // constraint at all, and a header can name an agent who is not in
      // `PO_AGENTS`. An inner join would drop the order rather than leave a null,
      // which turns "we do not know the site" into "there is no order".
      const party = await one<{
        vendor_name: string | null;
        site_code: string | null;
        site_city: string | null;
        site_state: string | null;
        agent_name: string | null;
      }>(
        `SELECT v.${quoteIdent('VENDOR_NAME')} AS vendor_name, ` +
          `s.${quoteIdent('VENDOR_SITE_CODE')} AS site_code, ` +
          `s.${quoteIdent('CITY')} AS site_city, ` +
          `s.${quoteIdent('STATE')} AS site_state, ` +
          `a.${quoteIdent('NAME')} AS agent_name ` +
          `FROM ${quoteIdent('PO_HEADERS_ALL')} h ` +
          `LEFT JOIN ${quoteIdent('PO_VENDORS')} v ON v.${quoteIdent('VENDOR_ID')} = h.${quoteIdent('VENDOR_ID')} ` +
          `LEFT JOIN ${quoteIdent('PO_VENDOR_SITES_ALL')} s ON s.${quoteIdent('VENDOR_SITE_ID')} = h.${quoteIdent('VENDOR_SITE_ID')} ` +
          `LEFT JOIN ${quoteIdent('PO_AGENTS')} a ON a.${quoteIdent('AGENT_ID')} = h.${quoteIdent('AGENT_ID')} ` +
          `WHERE h.${quoteIdent('PO_HEADER_ID')} = :id`,
        { id },
      );

      const lines = await rows<Record<string, unknown>>(
        `SELECT ${poLineColumns.map(quoteIdent).join(', ')} FROM ${quoteIdent('PO_LINES_ALL')} ` +
          `WHERE ${quoteIdent('PO_HEADER_ID')} = :id ORDER BY ${quoteIdent('LINE_NUM')} ASC`,
        { id },
      );

      const shipmentCount = await scalar(
        `SELECT COUNT(*) AS n FROM ${quoteIdent('PO_LINE_LOCATIONS_ALL')} WHERE ${quoteIdent('PO_HEADER_ID')} = :id`,
        { id },
      );

      // One pass over the distributions for all four figures, rather than four
      // queries that could disagree with each other if a row were inserted between
      // them. `COALESCE` matters: an order with no distributions must report `0`
      // and not `null`, and `SUM` over an empty set is null.
      const money = await one<{ n: number; accounts: number; ordered: number; billed: number; encumbered: number }>(
        `SELECT COUNT(*) AS n, COUNT(DISTINCT ${quoteIdent('CODE_COMBINATION_ID')}) AS accounts, ` +
          `COALESCE(SUM(${quoteIdent('AMOUNT_ORDERED')}), 0) AS ordered, ` +
          `COALESCE(SUM(${quoteIdent('AMOUNT_BILLED')}), 0) AS billed, ` +
          `COALESCE(SUM(${quoteIdent('ENCUMBERED_AMOUNT')}), 0) AS encumbered ` +
          `FROM ${quoteIdent('PO_DISTRIBUTIONS_ALL')} WHERE ${quoteIdent('PO_HEADER_ID')} = :id`,
        { id },
      );

      const vendorId = order.VENDOR_ID;
      const siteId = order.VENDOR_SITE_ID;
      const agentId = order.AGENT_ID;

      return {
        order,
        vendor:
          vendorId === null || vendorId === undefined
            ? null
            : { VENDOR_ID: Number(vendorId), VENDOR_NAME: String(party?.vendor_name ?? '') },
        site:
          siteId === null || siteId === undefined
            ? null
            : {
                VENDOR_SITE_ID: Number(siteId),
                VENDOR_SITE_CODE: party?.site_code ?? null,
                CITY: party?.site_city ?? null,
                STATE: party?.site_state ?? null,
              },
        agent:
          agentId === null || agentId === undefined
            ? null
            : { AGENT_ID: Number(agentId), NAME: String(party?.agent_name ?? '') },
        lines,
        // `lines` is the array that was returned, so this cannot disagree with it.
        counts: { lines: lines.length, shipments: shipmentCount, distributions: money?.n ?? 0 },
        totals: {
          ordered: money?.ordered ?? 0,
          billed: money?.billed ?? 0,
          encumbered: money?.encumbered ?? 0,
          distinctAccounts: money?.accounts ?? 0,
        },
      };
    },
  });

  // A one-call answer to "how big is procurement, and where does the money sit".
  // Deliberately not derived from the list endpoints: summing a page would give a
  // number that changes with `limit`, which is the classic way a dashboard ends up
  // showing a different total from the table beside it.
  api.route({
    method: 'get',
    path: '/api/procurement/summary',
    operationId: 'procurement_summary',
    summary: 'Counts and committed totals across procurement',
    description:
      'Order, line, shipment, and distribution counts, the committed value by order type, and the top accounts ' +
      'by committed amount. Every figure is computed in SQL over the whole table, not over a page.',
    tags: ['Procurement'],
    response: z
      .object({
        counts: z
          .object({
            orders: z.number().int().openapi({ description: 'Rows in `PO_HEADERS_ALL`.' }),
            lines: z.number().int().openapi({ description: 'Rows in `PO_LINES_ALL`.' }),
            shipments: z.number().int().openapi({ description: 'Rows in `PO_LINE_LOCATIONS_ALL`.' }),
            distributions: z.number().int().openapi({ description: 'Rows in `PO_DISTRIBUTIONS_ALL`.' }),
            agents: z.number().int().openapi({ description: 'Rows in `PO_AGENTS`.' }),
            vendors: z.number().int().openapi({ description: 'Rows in `PO_VENDORS`.' }),
          })
          .openapi('ProcurementCounts'),
        committed: z
          .object({
            ordered: realReq('Sum of every `AMOUNT_ORDERED`.'),
            encumbered: realReq('Sum of every `ENCUMBERED_AMOUNT`.'),
            billed: realReq('Sum of every `AMOUNT_BILLED`. Zero throughout this sample.'),
            distinctAccounts: z.number().int().openapi({ description: 'Distinct accounts charged.' }),
          })
          .openapi('ProcurementCommitted'),
        byType: z
          .array(
            z
              .object({
                typeLookupCode: text('`TYPE_LOOKUP_CODE`; null where the extract left it blank.'),
                orders: z.number().int().openapi({ description: 'Orders of this type.' }),
                amountOrdered: realReq('Total ordered across those orders.'),
              })
              .openapi('ProcurementTypeTotal'),
          )
          .openapi({ description: 'Committed value by order type, largest first.' }),
        topAccounts: z
          .array(
            z
              .object({
                codeCombinationId: int('The account key.'),
                distributions: z.number().int().openapi({ description: 'Distributions charged to it.' }),
                amountOrdered: realReq('Total ordered against it.'),
              })
              .openapi('ProcurementAccountTotal'),
          )
          .openapi({ description: 'The eight accounts carrying the most committed value.' }),
      })
      .openapi('ProcurementSummary'),
    errors: [500],
    handler: async () => {
      const counts = await one<Record<string, number>>(
        `SELECT ` +
          `(SELECT COUNT(*) FROM ${quoteIdent('PO_HEADERS_ALL')}) AS orders, ` +
          `(SELECT COUNT(*) FROM ${quoteIdent('PO_LINES_ALL')}) AS lines, ` +
          `(SELECT COUNT(*) FROM ${quoteIdent('PO_LINE_LOCATIONS_ALL')}) AS shipments, ` +
          `(SELECT COUNT(*) FROM ${quoteIdent('PO_DISTRIBUTIONS_ALL')}) AS distributions, ` +
          `(SELECT COUNT(*) FROM ${quoteIdent('PO_AGENTS')}) AS agents, ` +
          `(SELECT COUNT(*) FROM ${quoteIdent('PO_VENDORS')}) AS vendors`,
      );

      const committed = await one<Record<string, number>>(
        `SELECT COALESCE(SUM(${quoteIdent('AMOUNT_ORDERED')}), 0) AS ordered, ` +
          `COALESCE(SUM(${quoteIdent('ENCUMBERED_AMOUNT')}), 0) AS encumbered, ` +
          `COALESCE(SUM(${quoteIdent('AMOUNT_BILLED')}), 0) AS billed, ` +
          `COUNT(DISTINCT ${quoteIdent('CODE_COMBINATION_ID')}) AS accounts ` +
          `FROM ${quoteIdent('PO_DISTRIBUTIONS_ALL')}`,
      );

      // Grouped from the distributions, joined to the header, because the type
      // lives on the header and the money lives on the distribution. Grouping the
      // headers instead would count an order once and lose the amount entirely.
      const byType = await rows<{ type: string | null; orders: number; amount: number }>(
        `SELECT h.${quoteIdent('TYPE_LOOKUP_CODE')} AS type, ` +
          `COUNT(DISTINCT h.${quoteIdent('PO_HEADER_ID')}) AS orders, ` +
          `COALESCE(SUM(d.${quoteIdent('AMOUNT_ORDERED')}), 0) AS amount ` +
          `FROM ${quoteIdent('PO_DISTRIBUTIONS_ALL')} d ` +
          `JOIN ${quoteIdent('PO_HEADERS_ALL')} h ON h.${quoteIdent('PO_HEADER_ID')} = d.${quoteIdent('PO_HEADER_ID')} ` +
          `GROUP BY h.${quoteIdent('TYPE_LOOKUP_CODE')} ORDER BY amount DESC`,
      );

      const topAccounts = await rows<{ ccid: number; n: number; amount: number }>(
        `SELECT ${quoteIdent('CODE_COMBINATION_ID')} AS ccid, COUNT(*) AS n, ` +
          `COALESCE(SUM(${quoteIdent('AMOUNT_ORDERED')}), 0) AS amount ` +
          `FROM ${quoteIdent('PO_DISTRIBUTIONS_ALL')} ` +
          `GROUP BY ${quoteIdent('CODE_COMBINATION_ID')} ORDER BY amount DESC LIMIT 8`,
      );

      return {
        counts: {
          orders: counts?.orders ?? 0,
          lines: counts?.lines ?? 0,
          shipments: counts?.shipments ?? 0,
          distributions: counts?.distributions ?? 0,
          agents: counts?.agents ?? 0,
          vendors: counts?.vendors ?? 0,
        },
        committed: {
          ordered: committed?.ordered ?? 0,
          encumbered: committed?.encumbered ?? 0,
          billed: committed?.billed ?? 0,
          distinctAccounts: committed?.accounts ?? 0,
        },
        byType: byType.map((r) => ({
          typeLookupCode: r.type,
          orders: r.orders,
          amountOrdered: r.amount,
        })),
        topAccounts: topAccounts.map((r) => ({
          codeCombinationId: r.ccid,
          distributions: r.n,
          amountOrdered: r.amount,
        })),
      };
    },
  });
}

async function assertPurchaseOrderExists(id: unknown): Promise<void> {
  const found = await one(
    `SELECT 1 AS ok FROM ${quoteIdent('PO_HEADERS_ALL')} WHERE ${quoteIdent('PO_HEADER_ID')} = :id`,
    { id: bindable(id) },
  );
  if (!found) throw AppError.notFound(`Purchase order ${String(id)}`);
}
