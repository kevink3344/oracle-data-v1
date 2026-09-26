import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useStore, FACET_LABEL, PROJECT_COLUMNS, type LineMatch } from '../state/store';
import { StatusChip } from './Chip';
import { MixBar } from './Bars';
import { SortableHead } from './SortHeader';
import { describeOrder, type SortState } from '../data/sort';
import { addedToday } from '../data/projectMeta';
import { money0, moneyShort, num, pctSlim, pluralise, share } from '../data/format';
import type { Project } from '../data/types';

function Meta({ project }: { project: Project }) {
  const sep = <span className="sep">·</span>;
  return (
    <div className="pcell__meta">
      Level {project.level}
      {sep}
      {pluralise(project.buckets.length, 'budget group')}
      {sep}
      {pluralise(project.lines, 'line')}
      {sep}
      {pluralise(project.orders, 'order')}
      {sep}
      {project.owner ? `Owner: ${project.owner}` : 'Owner: unassigned'}
    </div>
  );
}

function Cell({ value, total }: { value: number; total: number }) {
  if (value <= 0) {
    return <span className="money--zero">—</span>;
  }
  return (
    <>
      <span className="money num">{money0(value)}</span>
      <span className="share num">{pctSlim(share(value, total))}</span>
    </>
  );
}

/**
 * The lines behind a match the row cannot explain by itself.
 *
 * A reader who typed an order number sees a project whose name has nothing to
 * do with it, so the row has to hand the number back rather than assert the
 * hit. The first line is shown in full because it is the evidence; the rest are
 * counted, and the complete set is one click away in the details panel.
 */
function MatchReason({ match }: { match: LineMatch }) {
  const first = match.lines[0];
  if (!first) return null;
  return (
    <div className="pcell__why">
      <span className="pcell__why-lead">
        {match.exact
          ? match.lines.length === 1
            ? '1 line matches'
            : `${num(match.lines.length)} lines match`
          : `${num(match.lines.length)} lines carry your terms`}
      </span>
      <span className="pcell__why-line">
        <span className="num">#{first.orderNumber}</span> {first.vendor}
      </span>
      <span className="pcell__why-desc" title={first.description}>
        {first.description}
      </span>
    </div>
  );
}

export default function ProjectTable() {
  const navigate = useNavigate();
  const {
    visible,
    searched,
    facet,
    setFacet,
    matchReasons,
    status,
    uncodedShown,
    registry,
    projectSort,
    setProjectSort,
  } = useStore();

  /**
   * The order, said out loud — held in state rather than recomputed at render, and
   * that is not belt-and-braces.
   *
   * `aria-sort` lives on the heading cell, and a reader who has just pressed the
   * button inside it is no longer focused on it, so the only thing that reports the
   * result is a live region. `describeOrder` returns the SAME string for two
   * different states often enough — press Committed twice and the table is back in
   * the order it opened in — that a value derived at render would be set to what it
   * already says and announced not at all.
   *
   * ★ DECLARED ABOVE THE EARLY RETURNS BELOW, BECAUSE IT HAS TO BE. The three empty
   *   states return before the table exists, so a hook written beside the table would
   *   run on some renders and not others. That is the rules-of-hooks error, not a
   *   style preference.
   */
  const [sortNote, setSortNote] = useState('');

  if (status === 'loading') {
    return <div className="empty">Reading the Oracle extract…</div>;
  }

  if (visible.length === 0) {
    // Two different failures wear the same empty table. Saying "no match" when
    // the search did match — but the chip above hides every row it found — would
    // send a reader off to rewrite a search that was already right. Searching an
    // order number is exactly how this happens: the line is found, and the level
    // carrying it has no name, which the default chip drops.
    if (searched.length > 0) {
      return (
        <div className="empty">
          The search found {pluralise(searched.length, 'level')}, but the{' '}
          <strong>{FACET_LABEL[facet]}</strong> filter hides{' '}
          {searched.length === 1 ? 'it' : 'them'}.{' '}
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setFacet('all')}>
            Show {num(searched.length)} matched
          </button>
        </div>
      );
    }
    // ★ A THIRD CASE, AND IT IS THE ONE THAT LOOKS LIKE A BUG. A recorded project
    //   with no account level is in the master but cannot be a row here, so a
    //   search for its name finds nothing in this table while the list below is
    //   showing exactly that project. Falling through to "Nothing matches" would
    //   contradict the block on the same screen, so the table says which of the
    //   two it is and points at the answer.
    if (uncodedShown.length > 0) {
      return (
        <div className="empty">
          No account level matches. {pluralise(uncodedShown.length, 'recorded project')} below{' '}
          {uncodedShown.length === 1 ? 'does' : 'do'} — {uncodedShown.length === 1 ? 'it has' : 'they have'}{' '}
          no Oracle account level yet, so there is no level row to show.
        </div>
      );
    }
    return (
      <div className="empty">
        Nothing matches. The search reads project names, level codes, sites and owners, and the
        purchase-order lines underneath each one — vendor, buyer, description and order number.
        Try <strong>All levels</strong> — the extract carries 139 and only ten are named.
      </div>
    );
  }

  const capital = visible.reduce((s, p) => s + p.capital, 0);
  const operating = visible.reduce((s, p) => s + p.operating, 0);
  const relocation = visible.reduce((s, p) => s + p.relocation, 0);
  const committed = visible.reduce((s, p) => s + p.committed, 0);
  const lines = visible.reduce((s, p) => s + p.lines, 0);

  /** The words for the order the table is in, for its caption and its announcement. */
  const order = describeOrder(PROJECT_COLUMNS, projectSort);

  /**
   * The instant the "New" badges are judged against — read once here rather than once
   * per row, so two rows created either side of midnight cannot be measured against
   * two different todays in the same table.
   */
  const now = new Date();

  /**
   * What a click on a heading means, for the order, the caption and the announcement.
   *
   * ★ THE SELECTION SURVIVES THE SORT, DELIBERATELY. The open panel is addressed by
   *   level — `?project=0450` — and not by row position, so reordering the table
   *   cannot point the drawer at a different project. Shutting it would be an
   *   interruption nobody asked for: sorting is another way of looking at the same
   *   list, not a move to a different one.
   *
   * ★ THE TOTALS IN THE FOOTER ARE OVER `visible`, AND `visible` IS THE SORTED LIST,
   *   so they are the totals of the rows on screen in the order the reader chose.
   *   Sorting is a permutation; it cannot change a sum, and it does not.
   */
  const applySort = (next: SortState) => {
    setProjectSort(next);
    setSortNote(`${pluralise(visible.length, 'level')}, ${describeOrder(PROJECT_COLUMNS, next)}.`);
  };

  return (
    <>
      {/* The order, spoken. A live region of its own rather than a longer caption:
          a caption is read when a reader enters the table, not when it changes. */}
      <p className="sr" role="status">
        {sortNote}
      </p>

      <div className="table-wrap">
        <table className="data">
          <caption className="sr">
            Projects, one row per Oracle account level, {order}. Selecting a row opens that
            project's detail page; the project's name opens the page that edits it. Click a column
            heading to reorder the table.
          </caption>
          <colgroup>
            <col />
            <col style={{ width: 104 }} />
            <col style={{ width: 118 }} />
            <col style={{ width: 122 }} />
            <col style={{ width: 134 }} />
          </colgroup>
          <SortableHead columns={PROJECT_COLUMNS} sort={projectSort} onSort={applySort} />
          <tbody>
            {visible.map((p) => {
              const reason = matchReasons.get(p.level);
              /* ★ THE ROW IS A LINK NOW, NOT A DRAWER TRIGGER — AND THE CHANGE IS THE POINT.
                 It used to call `selectLevel(p.level)`, which wrote `?project=<level>` and opened
                 the sliding panel. The user's instruction was that a project should open a PAGE,
                 so the row navigates to `/projects/<level>`.

                 ★ A `<tr onClick>` IS NOT KEYBOARD-REACHABLE, WHICH IS WHY THE NAME IS ALSO A
                   LINK. The row click is a mouse convenience; the name carries the real anchor, so
                   Tab reaches it, Enter follows it, and a screen reader announces a link rather
                   than a row that happens to respond to a click. This was already true of the
                   claimed-name branch below; the unclaimed branch was a `<button>` that opened the
                   panel and is now the same link.

                 ★ THE NAME'S LINK GOES TO THE EDIT PAGE WHEN THERE IS SOMETHING TO EDIT, AND TO
                   THE DETAIL PAGE WHEN THERE IS NOT. A claimed level has an app record, so
                   `/projects/:slug/edit` is the more useful destination — it is the one screen that
                   can change the name, the note or the level. An unclaimed level has no registry
                   row, so there is no slug to give and the detail page is the only destination. */
              const claimed = registry.find((r) => (r.levelCode ?? '').trim() === p.level);
              /* ★ NO CLAIMED ROW, NO BADGE — AND THAT IS NOT A GAP. The badge says a
                 project was recorded in this app today, so a level nobody has recorded
                 cannot wear it. The 127 unclaimed levels are not new; they are unowned. */
              const isNew = claimed ? addedToday(claimed, now) : false;
              const detailHref = `/projects/${encodeURIComponent(p.level)}`;
              return (
                <tr
                  key={p.level}
                  className="prow"
                  onClick={() => navigate(detailHref)}
                >
                  <td>
                    <div className="pcell__code">{p.code}</div>
                    <div className="pcell__name">
                      {claimed ? (
                        <Link
                          className="linkish"
                          to={`/projects/${claimed.slug}/edit`}
                          title={`Edit ${p.name}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {p.name}
                        </Link>
                      ) : (
                        <Link
                          className={`linkish${p.unclaimed ? ' linkish--muted' : ''}`}
                          to={detailHref}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {p.name}
                        </Link>
                      )}
                      {/*
                        ★ THE MARK IS ON THE NAME BECAUSE IT IS A FACT ABOUT THE PROJECT.
                          A level can be years old and its project recorded this morning;
                          the name is the project, the row is the level.

                        ★ IT IS A DOT, AND THE STATUS CHIP'S DOT IS STILL THE STATUS ONE.
                          `StatusChip` sits one cell to the right and states a condition
                          with a coloured dot, which is why an earlier revision of this
                          mark was deliberately dot-free. The dot is here because the user
                          asked for it and it is the right weight — but it reads as a mark
                          on the *name*, not a second status, only because of how much it
                          differs from that chip: it is bare where the chip is a tinted
                          pill, it is at the other end of the row in a different column,
                          and it is lime where ACTIVE is teal `--info-fg` and DORMANT grey
                          `--neu-fg`. Move it, or recolour it towards either of those, and
                          the distinction it depends on is gone.

                        ★ NO VISIBLE WORD, SO THE WORD MOVES TO `aria-label`. The dot is a
                          picture (`role="img"`) rather than bare decoration, because it
                          carries meaning nothing else on the row carries; without the
                          label a screen reader reads the row as though the project were
                          merely newer than its neighbours by luck. The `title` stays for
                          sighted readers, and carries the rule, since "new" on its own
                          does not say new *as of when* — the answer, today, is what makes
                          it true.

                        ★ AND NO SPACE BEFORE IT EITHER. This used to be a `{' '}` plus
                          the span — a 3px gap the font decided, fine for the word it
                          was written for, too tight for a circle. The gap is
                          `.pcell__name .newmark { margin-left: 8px }` now, so there is
                          one thing that sets it and it is 8px wherever the name ends.
                      */}
                      {isNew ? (
                        <span
                          className="newmark"
                          role="img"
                          aria-label="New project"
                          title="Recorded in this app today"
                        />
                      ) : null}
                    </div>
                    {/*
                      ★ THE LEVEL'S ACCOUNTS, ON THE ROW THAT IS THE LEVEL.

                        A row here is an account level, and a level is not one account:
                        0450 is four. The code above used to name the largest of them
                        (`CC-0450-527`), so three accounts were invisible unless the
                        panel was opened. They are the level's own accounts, so they
                        belong on its row — as codes with the money in the `title`,
                        because the row is a summary and four money lines would push
                        the numbers a reader is comparing off the screen.

                        Ordered as `Project.accounts` is: largest committed first, so
                        the account the level is anchored on leads.
                    */}
                    <div className="pcell__accts">
                      <span className="pcell__acctsk">Accounts</span>
                      {p.accounts.map((a) => (
                        <span
                          className="pacct"
                          key={a.object}
                          title={
                            `${a.label} — ${money0(a.committed)} committed (${pctSlim(a.share)} ` +
                            `of this level), ${pluralise(a.lines, 'PO line')} across ` +
                            `${pluralise(a.combinations.length, 'cost code')}`
                          }
                        >
                          {a.object}
                        </span>
                      ))}
                    </div>
                    <Meta project={p} />
                    {reason ? <MatchReason match={reason} /> : null}
                    <MixBar
                      capital={p.capital}
                      operating={p.operating}
                      relocation={p.relocation}
                      committed={p.committed}
                    />
                  </td>
                  <td>
                    <StatusChip status={p.status} quietDays={p.quietDays} />
                  </td>
                  <td className="n">
                    <Cell value={p.capital} total={p.committed} />
                  </td>
                  <td className="n">
                    <Cell value={p.operating} total={p.committed} />
                  </td>
                  <td className="n">
                    <span className="money num">{money0(p.committed)}</span>
                    {/*
                      ★ STILL THE MODELLED FIGURE, AND THE TITLE NOW SAYS WHICH ONE THE PANEL USES.
                        The panel measures usage against Oracle's own `WCPSS_BUDGET`, which for a
                        level like 0450 is an order of magnitude larger; the two must not be read as
                        the same number, so the tooltip names the difference rather than pointing at
                        a panel that would print something else.
                    */}
                    <span
                      className="share num"
                      title={
                        'Modelled approved budget — the app derives it as committed × 1.10, ' +
                        'rounded up. The panel measures usage against Oracle’s own WCPSS budget ' +
                        'instead, which is a different and usually larger figure.'
                      }
                    >
                      of {moneyShort(p.approved)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="tfoot">
        <span>
          {pluralise(visible.length, 'level')} · <b>{num(lines)}</b> PO lines
        </span>
        <span>
          Capital <b>{money0(capital)}</b>
        </span>
        <span>
          Operating <b>{money0(operating)}</b>
        </span>
        <span>
          Relocation <b>{money0(relocation)}</b>
        </span>
        <span>
          Committed <b>{money0(committed)}</b>
        </span>
      </div>
    </>
  );
}
