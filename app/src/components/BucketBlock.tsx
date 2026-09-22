import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Bucket, CostCode } from '../data/types';
import { money, num, pctSlim, pluralise, share } from '../data/format';
import { objectTitle } from '../data/taxonomy';
import { ShareBar } from './Bars';
import HowBlock from './HowBlock';

const PAGE = 25;

function PoLines({ code }: { code: CostCode }) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? code.rows : code.rows.slice(0, PAGE);
  const hidden = code.rows.length - shown.length;

  return (
    <>
      <table className="polines">
        <thead>
          <tr>
            <th scope="col">Order</th>
            <th scope="col">Date</th>
            <th scope="col">Line</th>
            <th scope="col">Vendor</th>
            <th scope="col">Description</th>
            <th scope="col" className="n">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {shown.map((row, i) => (
            <tr key={`${row.orderNumber}-${row.lineNumber}-${i}`}>
              <td className="po-num">{row.orderNumber}</td>
              <td className="po-num">{row.orderDate}</td>
              <td className="po-num">{row.lineNumber}</td>
              <td className="po-vendor" title={row.vendor}>
                {row.vendor || '—'}
              </td>
              <td className="po-desc" title={row.description}>
                {row.description || '—'}
              </td>
              <td className="n">{money(row.amount)}</td>
            </tr>
          ))}
          {hidden > 0 ? (
            <tr className="po-rest">
              <td colSpan={5}>{num(hidden)} further lines not shown</td>
              <td className="n">
                {money(shown.reduce((s, r) => s + r.amount, 0))} shown
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {hidden > 0 ? (
        <div className="po-more">
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setExpanded(true)}>
            Show all {num(code.rows.length)} lines
          </button>
        </div>
      ) : null}
    </>
  );
}

function Line({
  code,
  index,
  bucket,
}: {
  code: CostCode;
  index: number;
  bucket: Bucket;
}) {
  const portion = share(code.amount, bucket.committed);
  const series = bucket.meta.series;
  // Each line carries its own budget group's order count, so the group total can
  // legitimately exceed the project's distinct order count.
  const detailRule = code.rows.length === 1 ? '1 purchase-order line' : `${num(code.rows.length)} purchase-order lines`;

  return (
    <div className="line">
      <div className="line__top">
        <span className="line__no">{String(index + 1).padStart(4, '0')}</span>
        <span className="line__obj">{objectTitle(code.object)}</span>
        <span className="line__amt">{money(code.amount)}</span>
      </div>

      {/*
        ★ THE COMBINATION IS THE WAY INTO THE BUDGET, AND THIS IS THE ONE PLACE
          THE TWO GRAINS MEET.

        This drawer reads a *project*, down to its cost codes; the budget detail
        page reads an *account*. `code.combination` is the string that is both —
        the full seven segments, which is exactly the key the budget page parses
        out of `?account=`. So the code printed here is not decoration, it is the
        address, and it is already what the reader is looking at when they want
        to ask what Oracle has budgeted against it.

        **The anchor sits INSIDE the `<code>`, and that is a layout decision, not
        a semantic one.** `.line__key` is `display: block` with its own
        `margin-top`; an anchor that *was* `.line__key` would have made the whole
        width of the drawer a click target while only the code's own left edge
        looked like one. Inline keeps the target the size of its text and leaves
        the mono font, the `margin-top` and the `word-break` untouched.

        **It links unconditionally, and that was a real choice.** The drawer
        knows which of these accounts has a budget row (`positions`, the same
        lookup behind the "n accounts of m" hint), so it could hide the link
        where there is nothing to land on — and that would be worse. The budget
        page's absence notice names the account that was asked for, says the
        absence is a property of the extract rather than of the account, with the
        counts to check it, and offers the chart of accounts instead. An
        affordance that comes and goes with a fetch is harder to trust than one
        that always leads somewhere that explains itself.
      */}
      <code className="line__key">
        <Link
          className="line__budget"
          to={`/funding/budgets?account=${encodeURIComponent(code.combination)}`}
          title="Open this account on the budget detail page — what Oracle has budgeted against it, and what is left of it"
        >
          {code.combination}
          <span className="line__go">Budget detail ›</span>
        </Link>
      </code>

      <div className="line__meta">
        {pluralise(code.lines, 'line')} · {pluralise(code.orders, 'order')} ·{' '}
        {pluralise(code.vendors, 'vendor')} · {pctSlim(portion)} of this budget
      </div>

      {code.topVendor ? (
        <div className="line__vendor" title={`Largest vendor in this cost code: ${code.topVendor}`}>
          Largest: {code.topVendor} <b>{money(code.topVendorAmount)}</b>
        </div>
      ) : null}

      <ShareBar value={portion} series={series} />

      <details className="line__more">
        <summary>{detailRule}</summary>
        <PoLines code={code} />
      </details>
    </div>
  );
}

export default function BucketBlock({ bucket }: { bucket: Bucket }) {
  const cards = bucket.costCodes.length;
  const sub =
    `${pctSlim(share(bucket.committed, bucket.approved))} committed · ` +
    `${pluralise(bucket.lines, 'line')} · ${pluralise(bucket.orders, 'order')} · ` +
    `${num(bucket.vendors)} vendor links · ${pluralise(cards, 'cost code')}`;

  return (
    <details className="bucket" open>
      <summary>
        <span className={`bucket__dot ${bucket.meta.mark}`} aria-hidden="true" />
        <span className="bucket__name">{bucket.meta.label}</span>
        <span className="bucket__code">purpose {bucket.purpose}</span>
        <span className="bucket__amt">{money(bucket.committed)}</span>
      </summary>

      <div className="bucket__inner">
        <div className="line__meta" style={{ marginTop: 0 }}>
          {sub}
        </div>

        {bucket.costCodes.map((code, i) => (
          <Line key={code.combination} code={code} index={i} bucket={bucket} />
        ))}

        <HowBlock bucket={bucket} />
      </div>
    </details>
  );
}
