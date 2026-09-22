import { nextSort, type SortColumn, type SortState } from '../data/sort';

/**
 * The heading row of a sortable table, drawn from the same column list the sort
 * reads.
 *
 * ── WHY THE HEADERS ARE GENERATED RATHER THAN WRITTEN OUT
 *
 * A hand-written `<th>` and a hand-written comparator are two statements about
 * one column, and nothing keeps them in step: add a column to the table and the
 * heading appears with no sort behind it, or rename a heading and the words the
 * page head prints ("sorted by …") go on naming the old one. Here the headings,
 * the alignment and the sort keys all come from one array per page, so a column
 * cannot exist in one of those places and not the others.
 *
 * ── HOW IT IS ANNOUNCED
 *
 * The cell stays a `th` with `scope="col"`, because that is what makes it a
 * column heading when the table is read, and it carries `aria-sort` — the one
 * attribute that says which column the table is ordered by and which way. The
 * control is a real `button` inside it, so it is in the tab order, is announced
 * as something that can be pressed, and is driven by Enter and Space without any
 * key handling of our own. The `th` cannot carry that: it is not focusable and a
 * click on it is not a control.
 *
 * ★ The click handler is on the CELL and not on the button, which is deliberate
 *   and is the opposite of the usual advice. The arrow is positioned just outside
 *   the button's box (see `projects.css`: it has to be, or it would widen the
 *   heading and with it the column — measured, on the invoice table, at 6px taken
 *   away from the account column). A mouse click on those pixels would therefore
 *   land on the cell and do nothing, and the arrow is the single most likely place
 *   to aim at. One handler on the cell catches the label, the arrow, the padding
 *   either side of them and the keyboard alike: pressing the button dispatches a
 *   click that bubbles to the cell, so Enter and Space work through exactly this
 *   path. Putting it on both would be worse than putting it on neither — the
 *   button's click would bubble and sort twice, which is no sort at all.
 *
 * ★ The button's label describes the ACTION, not the state. `aria-sort` already
 *   carries the state, but it is announced when the table is read and not when
 *   the button is focused — so a button labelled only "Vendor" would leave the
 *   reader unable to tell whether pressing it sorts up or down. Worse, a label
 *   that named the current state would be a lie the instant it was pressed. So it
 *   says what the next press will do, and the page also speaks the result into a
 *   live region (`role="status"`) because the label changes to describe the
 *   opposite of what just happened.
 *
 * ★ The arrow is always in the DOM and only its visibility changes, so revealing
 *   it moves nothing — not the label beside it, and not the column it is in. */
interface SortableHeadProps<T> {
  columns: readonly SortColumn<T>[];
  sort: SortState;
  /** The whole next state is passed, not the key: flipping is `sort.ts`'s rule. */
  onSort: (next: SortState) => void;
}

export function SortableHead<T>({ columns, sort, onSort }: SortableHeadProps<T>) {
  return (
    <thead>
      <tr>
        {columns.map((column) => {
          const active = column.key === sort.key;
          const dir = active ? sort.dir : null;
          // A new column starts ascending (`nextSort`), so "ascending" is also
          // what a column that is not sorted would do — which is what the hover
          // arrow shows and what the label promises.
          const action: 'ascending' | 'descending' = dir === 'asc' ? 'descending' : 'ascending';
          // Annotated rather than inferred: `aria-sort` is a union of literals and
          // a widened `string` is not assignable to it.
          const ariaSort: 'ascending' | 'descending' | 'none' =
            dir === null ? 'none' : dir === 'asc' ? 'ascending' : 'descending';
          return (
            <th
              key={column.key}
              scope="col"
              // `none` on every other heading rather than omitting the attribute:
              // only one heading in a table may be sorted, and saying so on the
              // rest is how a reader learns the others are sortable at all.
              aria-sort={ariaSort}
              className={`sortable${column.numeric ? ' n' : ''}`}
              onClick={() => onSort(nextSort(sort, column.key))}
            >
              <button
                type="button"
                className={`thsort${active ? ' is-on' : ''}`}
                aria-label={`${column.label}, sort ${action}`}
              >
                <span>{column.label}</span>
                <span className="thsort__mark" aria-hidden="true">
                  {dir === 'desc' ? '↓' : '↑'}
                </span>
              </button>
            </th>
          );
        })}
      </tr>
    </thead>
  );
}
