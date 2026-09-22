import { useStore } from '../state/store';
import { scopeLabel } from '../data/scope';
import { money0, num } from '../data/format';

/**
 * The scope, said in prose on the pages it cannot reach.
 *
 * ── WHY THIS FILE EXISTS AT ALL
 *
 * The account scope is applied in exactly one place — the store's `lines` — so every screen that
 * reads `lines` obeys it without knowing it exists. Screens that read a different source either
 * apply the same rule at their own join boundary or say why they cannot.
 *
 * ★ THE ALTERNATIVE IS THE FAILURE THIS PREVENTS. A page showing an unfiltered table underneath a
 *   selector that is filtering everything else reads as *broken* or, worse, as *filtered*. Somebody
 *   comparing the totals on `/spend/payments` with the totals on `/projects` would find they disagree
 *   and have no way to know why. Three lines of prose are strictly better than a silent disagreement
 *   between two registers.
 *
 * Both components read the live scope rather than printing `04` and `861/862/863`, so the sentence
 * stays true when the selection moves — and `ScopeNotApplied` is explicit that a register is
 * *unfiltered* rather than merely unscoped, which is the part a reader needs in order to trust the
 * totals they are looking at.
 */

/**
 * For a register the scope cannot be tested against: activity.
 *
 * ★ THE BODY IS WRAPPED, AND THAT IS NOT DECORATION. `.scopenote` is a flex container with
 *   an 8px gap, so each *element* beside the flag becomes a flex item of its own and takes
 *   a gap with it. This note holds a `<strong>` and an `<em>` inside one sentence, so the
 *   unwrapped version rendered as five fragments with 8px of space knocked into the middle
 *   of the sentence — and, because the line breaks fall between flex items, with ragged
 *   right edges no amount of `text-align` would fix. `.scopenote__text` (`flex: 1 1 auto`)
 *   makes the prose one item, which is what it reads as.
 */
export function ScopeNotApplied({ register }: { register: string }) {
  const { scope, scopeTenant } = useStore();

  return (
    <p className="scopenote" role="note">
      <span className="scopenote__flag">Scope not applied</span>
      <span className="scopenote__text">
        {register} carries no account segment, so the{' '}
        <strong>{scopeLabel(scope, scopeTenant?.programs ?? [])}</strong> scope cannot be tested
        against these rows. The figures below are the register <em>in full</em>, not a filtered view
        — they will not reconcile line-for-line with the pages that are scoped.
      </span>
    </p>
  );
}

export function ScopeApplied({ register, shown, total }: { register: string; shown: number; total: number }) {
  const { scope, scopeTenant } = useStore();

  return (
    <p className="scopenote scopenote--removed" role="note">
      <span className="scopenote__flag">Scope applied</span>
      <span className="scopenote__text">
        {register} is filtered through the linked invoices' account segments for the{' '}
        <strong>{scopeLabel(scope, scopeTenant?.programs ?? [])}</strong> scope. Showing{' '}
        <strong>{num(shown)}</strong> of {num(total)} checks.
      </span>
    </p>
  );
}

/**
 * What the scope cost, on the pages it does apply to. Renders nothing when it costs nothing.
 *
 * ★ RENDERING NOTHING IS THE POINT OF THE GUARD, NOT AN OPTIMISATION. On the served extract the
 *   scope removes 0 of 2,782 rows, so a note that announced "0 rows removed" on every page would be
 *   noise — and noise is how a reader learns to skip the one place the number is not zero. The count
 *   still travels on the TopBar, where it is always visible and always the same number the pages
 *   were built from.
 */
export function ScopeRemoved() {
  const { scope, scopeTenant, scopeStats } = useStore();

  if (scopeStats.excluded === 0) return null;

  return (
    <p className="scopenote scopenote--removed" role="note">
      <span className="scopenote__flag">{num(scopeStats.excluded)} lines removed</span> The{' '}
      <strong>{scopeLabel(scope, scopeTenant?.programs ?? [])}</strong> scope removed{' '}
      {num(scopeStats.excluded)} of{' '}
      {num(scopeStats.all)} purchase-order lines ({money0(scopeStats.excludedValue)} committed) before
      this page was built. Everything shown, and every total on it, describes the remaining{' '}
      {num(scopeStats.shown)} lines.
    </p>
  );
}
