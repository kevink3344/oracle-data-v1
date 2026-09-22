import type { Bucket } from '../data/types';
import { ALLOC_RULE, accountPrefix, allocate } from '../data/derive';
import { money, num, pluralise } from '../data/format';
import { objectTitle } from '../data/taxonomy';

/**
 * The audit trail for one budget group: how the committed figure was assembled
 * from Oracle, and where the approved figure comes from.
 *
 * Steps 1-4 describe real extraction. Step 5 is flagged because the approved
 * budget is a placeholder, not Oracle data.
 */
export default function HowBlock({ bucket }: { bucket: Bucket }) {
  const objects = bucket.costCodes.map((c) => c.object);

  /**
   * ★ BOTH OF THESE USED TO BE TEMPLATES — `` `04-${bucket.purpose}-862-…` `` and
   *   `` `04-${bucket.purpose}-862-` `` — which is a claim about segments that were written into the
   *   source rather than read from the rows. The step below tells a reader "we matched lines beginning
   *   with *this* account", and the whole value of that sentence is that it is what was actually done.
   *   A key copied off the first cost code cannot describe a segment the data does not have, so the
   *   audit trail and the figures it is auditing come from the same place.
   *
   * `accountPrefix` returns `''` only for a key with fewer than three segments, which cannot happen
   * for a bucket that has cost codes at all — and the sentence falls back to naming the project's own
   * level rather than to an invented prefix.
   */
  const example = bucket.costCodes[0]?.combination ?? '';
  const account = accountPrefix(example);

  return (
    <div className="how">
      <div className="how__title">How we arrived at the {bucket.meta.label.toLowerCase()}</div>
      <ol className="how__steps">
        <li>
          Match every purchase-order line booked to an account beginning{' '}
          <strong>{account || `${bucket.purpose} · ${bucket.meta.label}`}</strong> that carries this
          project&rsquo;s level.
          <code className="how__acct">{example}</code>
        </li>
        <li>
          Add the amounts. {pluralise(bucket.costCodes.length, 'cost code')} under this account:{' '}
          {pluralise(bucket.lines, 'line')} totalling <strong>{money(bucket.committed)}</strong>.
        </li>
        <li>
          Split by object code — {pluralise(objects.length, 'object code')} inside this account:{' '}
          {objects.map(objectTitle).join(' · ')}.
        </li>
        <li>
          Count the lines inside each code, then add. That gives {pluralise(bucket.lines, 'line')},{' '}
          {num(bucket.orders)} order links and {num(bucket.vendors)} vendor links. Counting inside
          each code and then adding means these can exceed the project&rsquo;s distinct counts.
        </li>
        <li>
          Derive the approved budget: {money(bucket.committed)} × 1.10, rounded up to the next
          $10,000 = <strong>{money(allocate(bucket.committed))}</strong>.
        </li>
      </ol>
      <div className="how__foot">
        Steps 1&ndash;4 are computed from the extract. <strong>Step 5 is not Oracle data.</strong>{' '}
        {ALLOC_RULE}
      </div>
    </div>
  );
}
