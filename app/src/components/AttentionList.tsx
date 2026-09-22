import type { Project } from '../data/types';
import { ACTIVE_WINDOW_DAYS } from '../data/derive';
import { money0, num, pct, pctSlim, pluralise, share } from '../data/format';

interface Finding {
  tone: 'warn' | 'info';
  title: string;
  detail: string;
}

/** Every finding is derived from this project's own rows — nothing is hard-coded per level. */
function findings(p: Project): Finding[] {
  const rows = p.buckets.flatMap((b) => b.costCodes.flatMap((c) => c.rows));
  const out: Finding[] = [];

  if (p.unclaimed) {
    out.push({
      tone: 'info',
      title: 'This level has no name in the app yet',
      detail:
        'Oracle supplies the account level but has no project table, so the name, site and owner ' +
        'come from staff. Nothing above has been confirmed by a person.',
    });
  }

  if (p.status === 'dormant') {
    out.push({
      tone: 'warn',
      title: `No order for ${p.quietDays} days`,
      detail:
        `The last order in this level is dated ${p.last}, which is ${p.quietDays} days before the ` +
        `extract cut-off — outside the ${ACTIVE_WINDOW_DAYS}-day active window.`,
    });
  }

  const largestCode = p.buckets
    .flatMap((b) => b.costCodes)
    .reduce<{ object: string; amount: number } | null>(
      (best, c) => (best === null || c.amount > best.amount ? { object: c.object, amount: c.amount } : best),
      null,
    );

  if (largestCode && share(largestCode.amount, p.committed) > 0.5) {
    out.push({
      tone: 'info',
      title: `Cost code ${largestCode.object} carries ${pctSlim(share(largestCode.amount, p.committed))} of the level`,
      detail:
        `${money0(largestCode.amount)} of ${money0(p.committed)} sits in a single object code. ` +
        'Treating the level as one number hides that concentration.',
    });
  }

  const topOrder = rows.reduce(
    (best, r) => (r.amount > best ? r.amount : best),
    0,
  );

  if (topOrder > 0 && share(topOrder, p.committed) > 0.25) {
    out.push({
      tone: 'info',
      title: `One purchase-order line carries ${pctSlim(share(topOrder, p.committed))} of the level`,
      detail: `${money0(topOrder)} is committed on a single line. A change to it moves the whole project.`,
    });
  }

  // Line count and dollar value disagreeing is the signal that a level is doing
  // two jobs at once — usually a capital build with an operating tail.
  const operatingLines = rows.filter((r) => r.purpose === '9000').length;
  const operatingLineShare = share(operatingLines, rows.length);
  const operatingValueShare = share(p.operating, p.committed);

  if (operatingLineShare > 0.4 && operatingValueShare < 0.1) {
    out.push({
      tone: 'info',
      title: 'Line count and dollar value point in opposite directions',
      detail:
        `${pct(operatingLineShare)} of this level's lines are operating, but operating is only ` +
        `${pctSlim(operatingValueShare)} of its value. Counting rows would rank this project ` +
        'by its smallest part.',
    });
  }

  if (p.buckets.length > 1) {
    out.push({
      tone: 'info',
      title: `Split across ${pluralise(p.buckets.length, 'budget group')}`,
      detail:
        'One level code, more than one purpose. Anything that treats the level as a single budget ' +
        'will add a capital scope to an operating one.',
    });
  }

  const unlabelled = new Set(
    p.buckets.flatMap((b) => b.costCodes.filter((c) => c.label === null).map((c) => c.object)),
  );

  if (unlabelled.size > 0) {
    out.push({
      tone: 'info',
      title: `${pluralise(unlabelled.size, 'object code')} with no description`,
      detail:
        `Object ${[...unlabelled].join(', ')} appears in this project but has no friendly name in ` +
        'the app. Oracle supplies the code only; the descriptions are maintained by staff.',
    });
  }

  if (out.length === 0) {
    out.push({
      tone: 'info',
      title: 'Nothing unusual in this level',
      detail: `${num(rows.length)} purchase-order lines, no concentration, no split budget and no dormancy.`,
    });
  }

  return out;
}

export default function AttentionList({ project }: { project: Project }) {
  const items = findings(project);
  return (
    <div className="watch">
      {items.map((f, i) => (
        <div key={i} className={`watch__item${f.tone === 'warn' ? ' watch__item--warn' : ''}`}>
          <div className="watch__t">{f.title}</div>
          <div className="watch__d">{f.detail}</div>
        </div>
      ))}
    </div>
  );
}
