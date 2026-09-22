import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { useStore } from '../state/store';
import { Chip } from '../components/Chip';
import ErrorNotice from '../components/ErrorNotice';
import { num } from '../data/format';
import {
  captureReadings,
  loadActivity,
  type ActivityDay,
  type ActivityReading,
  type ActivitySource,
  type ActivityTable,
} from '../data/activity';

/**
 * Activity — an inventory of the database, and how much is in it.
 *
 * ★ WHAT THIS PAGE IS, AND WHAT IT IS NOT. It used to answer "what changed on one
 *   day", by reading six timestamp columns across forty-eight objects — of which
 *   thirty-one have no usable timestamp at all, so for most of the register the
 *   answer was a fact about the extract rather than about the ledger. What is left
 *   is the question every object can answer: *how many rows are in it*, narrowed to
 *   this application's own account scope wherever an object carries an account. The
 *   page is therefore an inventory, and the ordering is the register's own list
 *   rather than anything about movement.
 *
 * ★ TWO TABS, BECAUSE THE REGISTER HOLDS TWO KINDS OF OBJECT. The ledger's tables
 *   are read-only source; this application's seven are ours. They are counted in
 *   different databases, they fail for different reasons, and a reader looking for
 *   one is not looking for the other. The default is "System tables" because that is
 *   the larger set and the one a reader comes here for.
 *
 * ★ A COUNT IS A RECORDED READING, NOT A LIVE NUMBER, AND THE PAGE SAYS SO TWICE.
 *   Counting the ledger means scanning tables of millions of rows — measured at 13.4
 *   seconds for one full pass — so it happens when somebody presses "Record counts
 *   now" and the figure then stands still until somebody presses it again. Every row
 *   carries the date its figure was read and the figure before it, so a stale number
 *   cannot be mistaken for a live one.
 *
 * ★ `null` IS NOT `0`, AND IT IS STILL THE MOST IMPORTANT DISTINCTION HERE. An
 *   object the ledger will not expose to this account, and an object nobody has
 *   counted yet, both read "not counted" — never "0". A zero is a fact about the
 *   database; this is a fact about this application, and the two must not look the
 *   same. The reason travels with the row and is printed in the panel.
 *
 * ★ THE SOURCE IS NAMED FROM CONFIGURATION, IN TWO PLACES, AND THEY CAN DIFFER. The
 *   object list is a catalogue read from the app store; the counts for everything
 *   the app does not own are read from the ledger. Both labels arrive on the
 *   response, so the page names the database the *figures* came from without typing
 *   a host name it has no way to check.
 *
 * ★ THE SCOPE IS THE REGISTER'S OWN, NOT THE READER'S, AND THAT HAS TO BE SAID. The
 *   server narrows counts to a fixed fund and program set. A reader with a different
 *   selection in the top bar must be told that these numbers obey another rule, or
 *   the page looks like it is ignoring them.
 */

type Tab = 'system' | 'application';

/** The panel's focus trap reads the same set every other drawer in the app uses. */
const FOCUSABLE =
  'a[href], button:not([disabled]), summary, input, select, textarea, [tabindex]:not([tabindex="-1"])';

const TAB_LABEL: Record<Tab, string> = {
  system: 'System tables',
  application: 'Application tables',
};

const TAB_ORDER: Tab[] = ['system', 'application'];

/** Which `owner` a tab shows. The register's own vocabulary, mapped once. */
const OWNER_OF: Record<Tab, ActivityTable['owner']> = {
  system: 'extract',
  application: 'app',
};

/** `2026-09-18` as `Friday, September 18, 2026`. */
function longDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  // Built from parts so it is local midnight, not UTC midnight — the same
  // reasoning as `dayOf` in the data module. A UTC-midnight date formatted in a
  // western time zone prints the day before the one in the string.
  return new Date(y ?? 0, (m ?? 1) - 1, d ?? 1).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

/** The scope, in the words the page and the panel both use. */
function scopeWords(scope: { fund: string; programs: string[] }): string {
  return `fund ${scope.fund} and program ${scope.programs.join('/')}`;
}

/**
 * The difference between a reading and the one before it.
 *
 * ★ `null` IS NOT `0`, IN TWO WAYS HERE. A first reading is the words "first
 *   reading", because there is nothing to subtract yet; a difference of zero is
 *   `±0`, because two readings were taken and they agree. Collapsing the first into
 *   the second would tell a reader that the count was checked twice and did not
 *   move, on the day the app first looked at it.
 *
 * ★ THE MINUS SIGN IS U+2212, NOT A HYPHEN, for the same reason it always is: `-4`
 *   is narrower than the `+` beside it, so a column of differences set in tabular
 *   figures would not line up.
 */
function Movement({ snapshot }: { snapshot: ActivityReading }) {
  if (snapshot.delta === null) {
    return (
      <span className="act__delta act__delta--first" title="No earlier reading to compare with yet">
        first reading
      </span>
    );
  }
  const dir = snapshot.delta > 0 ? 'up' : snapshot.delta < 0 ? 'down' : 'flat';
  const sign = snapshot.delta > 0 ? '+' : snapshot.delta < 0 ? '\u2212' : '\u00b1';
  return (
    <span className={`act__delta act__delta--${dir}`}>
      {sign}
      {num(Math.abs(snapshot.delta))}
    </span>
  );
}

/**
 * How long the stretch between two readings is, in words.
 *
 * ★ COMPUTED FROM THE PARTS, NOT FROM `Date.parse` OF THE STRING. `new Date('2026-09-17')`
 *   is midnight UTC, so subtracting two of them is safe — both share the offset and
 *   it cancels — but a reader of this code cannot see that without working it out,
 *   and the same expression written with a mixed local date would be off by a day
 *   west of Greenwich. Building both as local dates makes the subtraction obviously
 *   a subtraction of calendar days.
 *
 * ★ SAID IN WORDS BECAUSE IT IS THE LOAD-BEARING PART OF THE NUMBER. `+4` over a day
 *   and `+4` over a fortnight are the same figure and not the same claim, and this
 *   page's whole honesty about a difference rests on the reader being able to tell
 *   which one they are looking at.
 */
function gapLine(snapshot: ActivityReading): string {
  const delta = snapshot.delta ?? 0;
  const sign = delta > 0 ? '+' : delta < 0 ? '\u2212' : '\u00b1';
  const size = `${sign}${num(Math.abs(delta))}`;

  if (!snapshot.previousDate) return `${size} across an unknown stretch`;

  const [y1, m1, d1] = snapshot.previousDate.split('-').map(Number);
  const [y2, m2, d2] = snapshot.date.split('-').map(Number);
  const from = new Date(y1 ?? 0, (m1 ?? 1) - 1, d1 ?? 1);
  const to = new Date(y2 ?? 0, (m2 ?? 1) - 1, d2 ?? 1);
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000);

  if (days === 0) return `${size} across two readings taken on the same day`;
  if (days === 1) return `${size} across the one day between the two readings`;
  return `${size} across the ${num(days)} days between the two readings`;
}

/**
 * The slide-in.
 *
 * Reuses the `.drawer` classes the project details panel already uses, so the
 * panel that slides in here behaves and looks like the one that slides in there —
 * one panel idiom in the app rather than two that drift.
 *
 * ★ THE PANEL IS WHERE THE REASON IS SAID IN FULL. The table has room for a figure
 *   and a date; *why* an object has no figure, *how* its count was narrowed, and
 *   *which database* answered are all sentences, and they belong somewhere with
 *   room to be read.
 */
function ActivityPanel({
  table,
  day,
  scope,
  source,
  onClose,
}: {
  table: ActivityTable;
  day: string;
  scope: { fund: string; programs: string[] };
  source: ActivitySource;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // ★ THE PANEL OWES THE OPENER ITS FOCUS BACK, and every other drawer in this app
  //   already pays it (`Checks`, `Invoices`, `PurchaseOrders`, `Budgets`, …). This
  //   one was the exception: `role="dialog" aria-modal="true"` with the opener
  //   captured nowhere, so Escape left `document.activeElement` on `BODY` — a
  //   keyboard reader was dropped at the top of the document, having to tab back
  //   through the rail and the whole 48-row register to reach the row they were on.
  //   The capture is in an effect rather than in the row's click handler because a
  //   mouse click focuses the button *before* React mounts the panel, so
  //   `document.activeElement` at mount IS the opener.
  useEffect(() => {
    openerRef.current = document.activeElement as HTMLElement | null;
    document.body.classList.add('is-locked');
    return () => {
      document.body.classList.remove('is-locked');
      openerRef.current?.focus?.();
    };
  }, []);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      // ★ `aria-modal="true"` IS A PROMISE THAT THE REST OF THE PAGE IS INERT, and
      //   without a trap it is a promise the panel does not keep: Tab walks out of
      //   the dialog and into the register behind it, which is still scrollable and
      //   still clickable. The trap is the same one the sibling drawers use, read
      //   off the live DOM so it needs no list of the panel's own controls.
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const owned = table.owner === 'app';
  const s = table.snapshot;
  const countedIn = source.sharedWithLedger ? source.countLabel : source.label;

  return (
    <aside
      ref={panelRef}
      id="activity-detail"
      className="drawer is-open"
      role="dialog"
      aria-modal="true"
      aria-label={`${table.name} — row count details`}
      tabIndex={-1}
    >
      <div className="drawer__head">
        <div className="drawer__eyebrow">
          {owned ? 'app table' : 'extract'} · {table.kind}
        </div>
        <h2 className="drawer__name">
          <code>{table.name}</code>
        </h2>
        <div className="drawer__meta">
          {table.rowCount === null ? (
            <>This object has no recorded row count yet.</>
          ) : (
            <>
              <b>{num(table.rowCount)}</b> {table.rowCount === 1 ? 'row' : 'rows'} in this object.
            </>
          )}
          {s ? (
            <>
              <br />
              Counted <time dateTime={s.date}>{longDay(s.date)}</time> at{' '}
              <time dateTime={s.capturedAt.replace(' ', 'T')}>{s.capturedAt}</time>.
            </>
          ) : null}
        </div>
        <div className="drawer__chips">
          {table.rowCount === null ? (
            <Chip variant="warn">not counted</Chip>
          ) : (
            <Chip variant="ok" dot>
              {num(table.rowCount)} rows
            </Chip>
          )}
          {/*
            ★ TWO CHIPS, NOT ONE, AND THEY DO NOT CONTRADICT EACH OTHER. "Not
              counted" and "four rows more than last time" are both true of the
              same object at the same moment — one is about whether a reading
              exists, the other about the interval between two readings that do.
          */}
          {s ? (
            s.delta === null ? (
              <Chip variant="neu">one reading so far</Chip>
            ) : s.delta === 0 ? (
              <Chip variant="neu">unchanged since {s.previousDate}</Chip>
            ) : (
              <Chip variant={s.delta > 0 ? 'ok' : 'warn'} dot>
                {s.delta > 0 ? '+' : '\u2212'}
                {num(Math.abs(s.delta))} row{Math.abs(s.delta) === 1 ? '' : 's'} since{' '}
                {s.previousDate}
              </Chip>
            )
          ) : null}
          {table.scoped ? (
            <Chip variant="info">counted within the scope</Chip>
          ) : (
            <Chip variant="neu">whole-object count</Chip>
          )}
          {owned ? <Chip variant="info">owned by this app</Chip> : null}
        </div>
        <button
          ref={closeRef}
          type="button"
          className="drawer__close"
          onClick={onClose}
          aria-label="Close the row count details panel"
        >
          <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M1 1l10 10M11 1L1 11"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <div className="drawer__body">
        {s ? (
          <section className="dsec">
            <div className="dsec__head">
              <h3 className="dsec__title">The recorded count</h3>
              <span className="dsec__hint">a reading, not a live figure</span>
            </div>
            <dl className="ax">
              <dt>
                Rows at the last reading <time dateTime={s.date}>{s.date}</time>
              </dt>
              <dd>
                <b className="ax__n">{num(s.rowCount)}</b>
                <br />
                <span className="ax__span">read at {s.capturedAt}</span>
              </dd>
              <dt>Against the reading before it</dt>
              <dd>
                {s.previousCount === null ? (
                  <span className="ax__span">
                    There is none. This is the first reading of this object, so there is nothing to
                    subtract from it yet — a difference appears once a second reading has been taken
                    on a later day.
                  </span>
                ) : (
                  <>
                    <b className="ax__n">{num(s.previousCount)}</b> on{' '}
                    <time dateTime={s.previousDate ?? ''}>{s.previousDate}</time>
                    <br />
                    <span className="ax__span">{gapLine(s)}</span>
                  </>
                )}
              </dd>
            </dl>
          </section>
        ) : null}

        {s && s.previousCount !== null ? (
          <section className="dsec">
            <div className="dsec__head">
              <h3 className="dsec__title">What a difference of counts can and cannot say</h3>
              <span className="dsec__hint">a net figure</span>
            </div>
            <p className="chart-note">
              A difference of counts is a <b>net</b> figure: four more rows can be six inserted and
              two deleted, and this object cannot tell those apart — it never sees a delete, only the
              arithmetic that survives one. It is also not a count of anything that happened on{' '}
              {longDay(day)}: the two readings may be a fortnight apart, which is why both dates are
              printed above.
            </p>
          </section>
        ) : null}

        <section className="dsec">
          <div className="dsec__head">
            <h3 className="dsec__title">How this count was narrowed</h3>
            <span className="dsec__hint">
              {table.scoped ? 'the scope applies' : 'nothing to narrow by'}
            </span>
          </div>
          {table.scopeMode === 'segments' ? (
            <p className="chart-note">
              This object carries the account's own columns, so the count is a filter on them:{' '}
              <code>SEGMENT1</code> for the fund and <code>SEGMENT3</code> for the program, testing{' '}
              <b>{scopeWords(scope)}</b>. Those are the only rows in it this application is about.
            </p>
          ) : table.scopeMode === 'lookup' ? (
            <p className="chart-note">
              This object carries an account only as a code-combination id, so the fund and program
              cannot be tested on it directly. The count resolves the id through{' '}
              <code>GL_CODE_COMBINATIONS</code> — testing <b>{scopeWords(scope)}</b> there — and
              counts the rows whose combination is in that set.
            </p>
          ) : (
            <p className="chart-note">
              This object has neither an account column nor a code-combination id, so{' '}
              <b>{scopeWords(scope)}</b> has nothing to test on it. Its count is the whole object,
              and it is marked as such on the list rather than being quietly left out.
            </p>
          )}
        </section>

        {table.reason ? (
          <section className="dsec">
            <div className="dsec__head">
              <h3 className="dsec__title">Why there is no count here</h3>
            </div>
            <p className="chart-note">{table.reason}</p>
          </section>
        ) : null}

        <section className="dsec">
          <div className="dsec__head">
            <h3 className="dsec__title">Where this comes from</h3>
            <span className="dsec__hint">{table.store === 'app' ? 'the app store' : 'the ledger'}</span>
          </div>
          {table.store === 'app' ? (
            <p className="chart-note">
              This is one of this application's own tables. The ledger holds no copy of it, so its
              count is taken in the app store at <code>{countedIn}</code>.
              {owned
                ? ' Its rows move when a project is recorded or bound, and the next reading will show that.'
                : ''}
            </p>
          ) : (
            <p className="chart-note">
              This is a ledger object. Its count is taken over the connection at{' '}
              <code>{source.countLabel}</code>
              {source.sharedWithLedger ? (
                <>
                  {' '}
                  — which is the app store as well, so the object list and its counts come from the
                  same database.
                </>
              ) : (
                <>
                  . The reading itself is stored in the app store at <code>{source.label}</code>, so
                  that a count taken today survives until the next one is taken.
                </>
              )}
            </p>
          )}
          {table.store === 'ledger' ? (
            <p className="chart-note">
              The list of names is the sample's declared inventory rather than Oracle's dictionary,
              so an object on this list that the account cannot read answers with its own error
              instead of a count. Pressing “Record counts now” is what reports that.
            </p>
          ) : null}
          <p className="chart-note">
            Open the raw object in{' '}
            <Link to={`/objects/${encodeURIComponent(table.name)}`}>the object browser</Link> to read
            its rows.
          </p>
        </section>
      </div>
    </aside>
  );
}

/**
 * Which database the counts came from.
 *
 * ★ THE PAGE HAD NO ANSWER TO THIS AND IT READ AS A LIE. Under `DB_MODE=oracle` the
 *   register was serving counts taken from a local SQLite sample while every other
 *   page on the site read Oracle, and the screen said nothing about it. The counts now
 *   come from the ledger; the sentence that says so is built from configuration
 *   rather than typed, so it stays true if either connection moves.
 *
 * ★ BOTH LABELS, BECAUSE THE TWO HALVES CAN DIFFER. The object list is a catalogue
 *   read from the app store and the counts for everything the app does not own come
 *   from the ledger, so the page names the one the *figures* came from and says where
 *   the names came from in the same breath — printed, never typed.
 */
function RegisterSource({ source }: { source: ActivitySource }) {
  return (
    <p className="scopenote scopenote--source" role="note">
      <span className="scopenote__flag">Source</span>
      <span className="scopenote__text">
        {source.sharedWithLedger ? (
          <>
            The row counts below are read from <code>{source.countLabel}</code> — the ledger and the
            app store are the same database, so these are its own objects and its own counts.
          </>
        ) : source.countStore === 'ledger' ? (
          <>
            The row counts below are read from the <strong>Oracle ledger</strong>,{' '}
            <code>{source.countLabel}</code>. The list of object names, and the readings themselves,
            are kept in the app store at <code>{source.label}</code> — so the names come from there
            and the counts from the ledger, and an object the ledger will not expose to this account
            still appears on the list and says so rather than disappearing.
          </>
        ) : (
          <>
            The row counts below are read from the <strong>app store</strong>,{' '}
            <code>{source.countLabel}</code> — not from the ledger,{' '}
            <code>{source.ledgerLabel}</code>. The object list and the recorded counts all come from
            there, so the EBS-shaped objects below are that store's <em>copies</em> of the ledger's
            objects and their counts are the copies' counts.
          </>
        )}
      </span>
    </p>
  );
}

/**
 * The scope, said on a page the top bar's selection does not reach.
 *
 * ★ THIS REPLACES A NOTE THAT SAID THE OPPOSITE, AND THE OPPOSITE WAS TRUE UNTIL THIS
 *   WEEK. The register used to count rows per table with no account in the answer, so
 *   it carried `ScopeNotApplied` — a sentence whose whole job was to admit that the
 *   figures above it were the database in full. The counts are now narrowed wherever
 *   an object carries an account, so that note would be exactly wrong: a reader would
 *   be told the totals were unfiltered while looking at filtered ones.
 *
 * ★ AND IT NAMES THE SCOPE THE SERVER USED, WHICH IS NOT THE READER'S. The register
 *   narrows to a fixed fund and program set of its own rather than following the top
 *   bar. A reader who has selected something else must be told, by name, which rule
 *   these numbers obey — otherwise the page looks like it ignored their selection, and
 *   the two figures that disagree will have no explanation anywhere on the screen.
 */
function RegisterScope({
  scope,
  tables,
  scoped,
  unscoped,
}: {
  scope: { fund: string; programs: string[] };
  tables: number;
  scoped: number;
  unscoped: number;
}) {
  return (
    <p className="scopenote" role="note">
      <span className="scopenote__flag">Scope applied</span>
      <span className="scopenote__text">
        Every count is narrowed to <strong>{scopeWords(scope)}</strong> wherever the object carries an
        account — {num(scoped)} of the {num(tables)} objects here, matched on the segments directly
        or through the code-combination lookup. This is the register's <em>own</em> scope and not the
        one selected in the bar above: it is fixed on the server, so changing the selection does not
        change these figures. The other {num(unscoped)} objects carry no account at all, so their
        count is the whole object; every row says which of the two it is.
      </span>
    </p>
  );
}

export default function Activity() {
  const { reloadActivity } = useStore();

  const [data, setData] = useState<ActivityDay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [tab, setTab] = useState<Tab>('system');
  const [filter, setFilter] = useState('');
  const [opened, setOpened] = useState<ActivityTable | null>(null);

  /**
   * ★ NO DATE, ON PURPOSE, AND THE RESPONSE SAYS WHICH DAY IT ANSWERED FOR. The page
   *   reports today's readings and nothing else, so it does not ask a question with a
   *   date in it: the server's own clock decides, and `data.date` is what the screen
   *   prints. That removes the whole family of disagreements a date input brings with
   *   it — a browser in another time zone, a day the server calls tomorrow, a stepper
   *   walked back to a date nobody ever took a reading on.
   */
  useEffect(() => {
    const controller = new AbortController();
    let alive = true;

    setLoading(true);
    setError(null);

    loadActivity(undefined, controller.signal)
      .then((payload) => {
        if (!alive) return;
        setData(payload);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (!alive || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });

    return () => {
      alive = false;
      controller.abort();
    };
  }, [attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  /**
   * Take a reading of every object, deliberately.
   *
   * ★ THE BUTTON IS THE ONLY WAY A READING IS EVER TAKEN. Nothing counts a table on
   *   page load: against the ledger that would be a set of full table scans on every
   *   visit, to measure something that had not changed since the last one — and the
   *   figures would move under a reader who had just read them. A load reads what a
   *   previous press recorded; the press is what writes.
   *
   * ★ IT RELOADS RATHER THAN PATCHING THE LOCAL ROWS. Taking a reading can change
   *   every row's difference at once and the whole summary with it, so the register is
   *   fetched again — one request, and no chance of two parts of the screen describing
   *   different states of the database.
   */
  const [capturing, setCapturing] = useState(false);
  const [captureNote, setCaptureNote] = useState<{ text: string; bad: boolean } | null>(null);
  const [captureFailures, setCaptureFailures] = useState<{ name: string; error: string }[]>([]);

  const capture = useCallback(async () => {
    setCapturing(true);
    setCaptureNote(null);
    setCaptureFailures([]);
    try {
      const result = await captureReadings();
      const missed = result.failed.length;
      setCaptureFailures(result.failed);
      setCaptureNote({
        text:
          `${num(result.written)} reading${result.written === 1 ? '' : 's'} recorded for ` +
          `${result.date}, at ${result.capturedAt}.` +
          (missed > 0
            ? ` ${num(missed)} object${missed === 1 ? '' : 's'} could not be counted, so ` +
              `${missed === 1 ? 'its reading is missing' : 'their readings are missing'} rather ` +
              `than zero — each one is named below.`
            : ''),
        bad: missed > 0,
      });
      setAttempt((n) => n + 1);
      // The rail badge reads this endpoint too, and it would otherwise still be
      // showing the state from before the press.
      reloadActivity();
    } catch (err: unknown) {
      // The common refusal is the 409 a read-only target gives, and its message
      // already says so. Nothing is broken; the target will not take writes, and
      // that is what the reader needs to be told rather than an HTTP code.
      setCaptureNote({ text: err instanceof Error ? err.message : String(err), bad: true });
    } finally {
      setCapturing(false);
    }
  }, [reloadActivity]);

  const terms = useMemo(() => filter.trim().toLowerCase(), [filter]);

  /**
   * The rows, filtered in the browser rather than by the server.
   *
   * ★ THE SERVER HAS NO FILTER PARAMETER, AND THAT IS DELIBERATE. The whole register
   *   is already in memory — forty-eight rows of a dozen fields — so filtering here is
   *   instant and cannot get out of step with the counts above it. A `?q=` on the
   *   server would mean the caption's figures described a different set of rows from
   *   the table's, which is the kind of bug that takes an afternoon to see.
   *
   * ★ ORDER IS FILTER, THEN TAB, THEN COUNT — NEVER A COUNT OF THE WHOLE SET. Nothing
   *   here is capped, but the tab figures are taken from the *filtered* set for the
   *   same reason: a count that includes rows the search removed is a claim about rows
   *   nobody can see.
   */
  const visible = useMemo(() => {
    const all = data?.tables ?? [];
    return terms ? all.filter((t) => t.name.toLowerCase().includes(terms)) : all;
  }, [data, terms]);

  const rows = useMemo(() => visible.filter((t) => t.owner === OWNER_OF[tab]), [visible, tab]);

  /** The tab counts the *filtered* set, so no tab offers rows the search removed. */
  const tabCounts = useMemo(
    () => ({
      system: visible.filter((t) => t.owner === 'extract').length,
      application: visible.filter((t) => t.owner === 'app').length,
    }),
    [visible],
  );

  /**
   * An object whose count could not be taken, named with the driver's own reason.
   *
   * ★ THE LIST IS FROM THE BUTTON, NOT FROM THE LOAD, AND IT HAS TO BE. The server
   *   only knows which counts failed while it is taking them, so the reload that
   *   follows answers with an empty list — the failures would vanish at exactly the
   *   moment the refreshed table appeared. They are therefore held from the capture's
   *   own response, falling back to the envelope for a server that one day reports
   *   them on a read as well.
   */
  const failures = captureFailures.length > 0 ? captureFailures : (data?.summary.readings.failed ?? []);

  const summary = data?.summary;

  /** The roving focus the tab pattern asks for: one tab stop for the whole group. */
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const onTabKey = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const at = TAB_ORDER.indexOf(tab);
      const step = e.key === 'ArrowRight' ? 1 : TAB_ORDER.length - 1;
      const next = TAB_ORDER[(at + step) % TAB_ORDER.length];
      if (!next) return;
      setTab(next);
      tabRefs.current[TAB_ORDER.indexOf(next)]?.focus();
    },
    [tab],
  );

  return (
    <div className="stack">
      <div>
        <div className="accent-rule" />
        <nav className="crumbs" aria-label="Breadcrumb">
          <span>Overview</span>
          <span aria-hidden="true">›</span>
          <span aria-current="page">Activity</span>
        </nav>
        <div className="page-head">
          <div>
            <h1>Activity</h1>
            <p className="page-head__sub">
              Every object in this database, listed A–Z, with the number of rows recorded in it. A
              count is a <em>reading</em> taken when someone pressed “Record counts now”, not a live
              figure, so each row carries the date it was read and how it moved since the reading
              before. Counts are narrowed to the register's own account scope wherever an object
              carries an account, and an object that cannot be counted says so rather than reading
              zero.
            </p>
          </div>
          <div className="page-head__actions">
            {summary ? (
              <Chip variant={summary.counted > 0 ? 'info' : 'neu'}>
                {num(summary.counted)} of {num(summary.tables)} objects counted
              </Chip>
            ) : null}
            <Link to="/projects" className="btn btn--system">
              Projects
            </Link>
          </div>
        </div>
      </div>

      {data?.source ? <RegisterSource source={data.source} /> : null}

      {summary && data ? (
        <RegisterScope
          scope={data.scope}
          tables={summary.tables}
          scoped={summary.scoped}
          unscoped={summary.unscoped}
        />
      ) : null}

      {/*
        ★ NOT THE COMPONENT'S DEFAULT PROSE. `ErrorNotice` assumes a page fed by
        `oracle/output.json` and offers `npm run sync:extract` as the remedy — which is
        the right instruction on most pages and a wrong one here: nothing on this screen
        is read from the extract's JSON. The object list is a catalogue read from the app
        store, and the counts are taken in the app store and the ledger, so its failure
        modes are "a database is unreachable" and "there is no catalogue", and a reader
        sent to re-run the extract would spend the afternoon on the wrong problem.
      */}
      {error ? (
        <ErrorNotice
          error={error}
          reload={reload}
          heading="The activity register could not be read."
          hint={
            <>
              This register reads a catalogue of objects and a set of recorded row counts — the
              catalogue from the <strong>app store</strong>, the counts from whichever database each
              figure is named as coming from — so re-running <code>npm run sync:extract</code> will
              not change what you see here. Reloading is worth a try if the server has just
              restarted.
            </>
          }
        />
      ) : null}

      <section className="panel">
        <div className="panel__head">
          <h2 className="panel__title">
            {data ? (
              <>
                Row counts for <time dateTime={data.date}>{longDay(data.date)}</time>
              </>
            ) : (
              'Row counts'
            )}
          </h2>
          {data?.isToday ? <span className="panel__sub">this is the server's today</span> : null}
        </div>

        <div className="panel__body">
          <div className="act__controls">
            <div className="act__buttons">
              {/*
                ★ ONLY ON TODAY, BECAUSE A READING IS A READING OF A DAY. There is no
                  way to take one for a past date — the counts are gone — so this guard
                  is a statement of the invariant rather than a branch that is ever
                  taken: the page only ever asks for the server's today.
              */}
              {data?.isToday ? (
                <button
                  type="button"
                  className="btn btn--system"
                  onClick={capture}
                  disabled={capturing}
                  title="Read every object's row count now and store it as today's reading"
                >
                  {capturing ? 'Recording…' : 'Record counts now'}
                </button>
              ) : null}
              <span className="act__stamp">
                {summary?.readings.capturedAt ? (
                  <>
                    last read <code>{summary.readings.capturedAt}</code>
                  </>
                ) : (
                  <>nothing recorded yet</>
                )}
              </span>
            </div>

            <div className="act__search">
              <svg className="combo__icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <circle cx="6.6" cy="6.6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
                <path d="M10.2 10.2 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" />
              </svg>
              <input
                id="activity-filter"
                className="combo__input"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder="Filter objects…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                aria-describedby="activity-hint"
              />
              {filter ? (
                <button
                  type="button"
                  className="combo__clear"
                  onClick={() => setFilter('')}
                  title="Clear the filter"
                >
                  ✕<span className="sr">Clear the object filter</span>
                </button>
              ) : null}
            </div>
          </div>

          {/*
            ★ A READING TAKES ABOUT FIFTEEN SECONDS AND THE PAGE SAYS SO WHILE IT RUNS.
              The counts are full scans of tables holding millions of rows; a button that
              simply greyed out for a quarter of a minute would read as a broken button.
          */}
          {capturing ? (
            <p className="chart-note" role="status">
              Reading the row count of every object. This scans the largest tables in full, so it
              takes about fifteen seconds — the page refreshes itself when it is done.
            </p>
          ) : null}

          {/*
            ★ TWO TABS, AND A REAL TABLIST. These are not filters over one list: the
              register's objects belong to two different databases and the two sets are
              counted, scoped and fail separately. `role="tablist"` with `aria-selected`
              and a shared panel is what tells a screen reader that, and the arrow keys
              move between them as the pattern requires.
          */}
          <div
            className="act__tabs"
            role="tablist"
            aria-label="Which objects to show"
            onKeyDown={onTabKey}
          >
            {TAB_ORDER.map((t, i) => (
              <button
                key={t}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                id={`activity-tab-${t}`}
                type="button"
                role="tab"
                className={`act__tab${tab === t ? ' is-on' : ''}`}
                aria-selected={tab === t}
                aria-controls="activity-tabpanel"
                tabIndex={tab === t ? 0 : -1}
                onClick={() => setTab(t)}
              >
                {TAB_LABEL[t]}
                <span className="act__tabn">{num(tabCounts[t])}</span>
              </button>
            ))}
          </div>

          <div
            id="activity-tabpanel"
            role="tabpanel"
            aria-labelledby={`activity-tab-${tab}`}
            tabIndex={0}
          >
            {captureNote ? (
              <p className="chart-note" role="status">
                {captureNote.bad ? (
                  <span className="act__bad">{captureNote.text}</span>
                ) : (
                  captureNote.text
                )}
              </p>
            ) : null}

            {failures.length > 0 ? (
              <p className="chart-note">
                <span className="act__bad">Could not be counted:</span>{' '}
                {failures.map((f, i) => (
                  <span key={f.name}>
                    {i > 0 ? ' · ' : ''}
                    <code title={f.error}>{f.name}</code>
                  </span>
                ))}
                {' — '}
                this is the plain answer those objects give when asked for a count, and hovering a
                name shows the driver's own words. They keep their place on the list and read “not
                counted” rather than zero.
              </p>
            ) : null}

            <p className="chart-note" id="activity-hint">
              A count here is the number of rows in the object, read at the date shown on its row —
              not a live figure, and not a count of anything that happened.{' '}
              {summary && summary.counted < summary.tables
                ? `${num(summary.tables - summary.counted)} of ${num(
                    summary.tables,
                  )} objects have no reading yet.`
                : null}
            </p>

            {loading && !data ? (
              <p className="chart-note">Reading the database catalogue…</p>
            ) : (
              <table className="act__table">
                <caption className="sr">
                  {TAB_LABEL[tab]} in this database, with the number of rows recorded in each.
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Object</th>
                    <th scope="col" className="act__countcol">
                      Rows
                    </th>
                    <th scope="col" className="act__actcol">
                      Details
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((t) => {
                    // ★ MOVEMENT COLOURS THE FIGURE, IN EITHER DIRECTION. A count that
                    //   rose is not "nothing happened"; nor is one that fell. `!== 0` and
                    //   not `> 0`, because a tint that appeared only for rises would be
                    //   an invisible claim that deletions do not matter — and the type
                    //   test comes first, because a first reading's delta is `null` and
                    //   `null !== 0` is true, which would paint every object on the day
                    //   the register was first counted.
                    const moved = t.snapshot?.delta;
                    const busy = typeof moved === 'number' && moved !== 0;
                    return (
                      <tr key={t.name} className={busy ? 'act__row--busy' : undefined}>
                        <th scope="row">
                          <span className="act__name">
                            <code>{t.name}</code>
                            {t.kind === 'view' ? (
                              <span className="act__tag" title="A view, not a table">
                                view
                              </span>
                            ) : null}
                            {t.owner === 'app' ? (
                              <span className="act__tag act__tag--app" title="Written by this app">
                                app
                              </span>
                            ) : null}
                            {t.scoped && data ? (
                              <span
                                className="act__tag act__tag--scope"
                                title={`Counted within ${scopeWords(data.scope)}`}
                              >
                                scoped
                              </span>
                            ) : null}
                          </span>
                        </th>

                        <td className="act__countcol">
                          {t.rowCount === null ? (
                            /*
                              ★ "NOT COUNTED", NEVER "0". A zero is a fact about the
                                database; this is a fact about this application, and the
                                title carries the whole reason for a reader who hovers.
                            */
                            <span className="act__cannot" title={t.reason ?? undefined}>
                              not counted
                            </span>
                          ) : (
                            <>
                              <span className={`act__count${busy ? ' act__count--some' : ''}`}>
                                {num(t.rowCount)}
                              </span>
                              {t.snapshot ? (
                                <span className="act__axes">
                                  <Movement snapshot={t.snapshot} />
                                  {t.snapshot.delta !== null && t.snapshot.previousDate ? (
                                    <> since {t.snapshot.previousDate}</>
                                  ) : null}
                                </span>
                              ) : null}
                            </>
                          )}
                        </td>

                        <td className="act__actcol">
                          <button
                            type="button"
                            className="btn btn--system"
                            aria-haspopup="dialog"
                            onClick={() => setOpened(t)}
                          >
                            view
                            <span className="sr"> details for {t.name}</span>
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {!loading && rows.length === 0 ? (
              <p className="chart-note">
                {terms ? (
                  <>
                    Nothing matches “{filter}”. {num(visible.length)} of{' '}
                    {num((data?.tables ?? []).length)} objects survive the filter, and the{' '}
                    {TAB_LABEL[tab].toLowerCase()} tab shows {num(tabCounts[tab])} of them.
                  </>
                ) : tab === 'application' ? (
                  <>
                    No object here is owned by this application. Its own tables are created by the
                    server on first use, so an empty tab means the app store's schema has not been
                    applied — which is worth knowing rather than a quiet nothing.
                  </>
                ) : (
                  <>
                    The register lists no system objects at all. That is the app store's catalogue
                    coming back empty, not a database with nothing in it.
                  </>
                )}
              </p>
            ) : null}
          </div>
        </div>
      </section>

      {summary && data ? (
        <section className="panel">
          <div className="panel__head">
            <h2 className="panel__title">What these counts cover</h2>
            <span className="panel__count">
              {num(summary.counted)} of {num(summary.tables)} objects have a recorded count
            </span>
          </div>
          <div className="panel__body">
            {data.note ? <p className="chart-note">{data.note}</p> : null}
            <div className="act__facts">
              <div>
                <b>{num(summary.tables)}</b>
                <span>objects in the register</span>
              </div>
              <div>
                <b>{num(summary.system)}</b>
                <span>read from the ledger's schema</span>
              </div>
              <div>
                <b>{num(summary.application)}</b>
                <span>tables this app owns</span>
              </div>
              <div>
                <b>{num(summary.scoped)}</b>
                <span>counts narrowed to {scopeWords(data.scope)}</span>
              </div>
              <div>
                <b>{num(summary.unscoped)}</b>
                <span>whole-object counts — no account to narrow by</span>
              </div>
              {/*
                ★ `summary.readings.recorded` IS DELIBERATELY ABSENT. It is non-zero only
                  on the request that takes the readings, and this panel is drawn from the
                  load that follows — so a figure here would be a permanent zero beside a
                  sentence that never fired. The capture note above the table is where
                  "what this press recorded" belongs, and it is read from the response
                  that actually recorded it.
              */}
              <div>
                <b>{num(summary.readings.read)}</b>
                <span>
                  {summary.readings.latest
                    ? `counts recorded, newest ${summary.readings.latest}`
                    : 'counts recorded'}
                </span>
              </div>
              <div>
                <b>{num(summary.readings.moved)}</b>
                <span>
                  {num(summary.readings.comparable)} have two readings to compare; the rest have one
                </span>
              </div>
            </div>

            {data.isToday ? (
              <p className="chart-note">
                Nothing on this page is a live count. Pressing <b>Record counts now</b> reads the row
                count of every object and stores it as today's reading; taking a reading again on a
                day that already has one replaces it rather than adding a second, which is what makes
                the difference on each row an interval rather than a coincidence.
              </p>
            ) : null}

            {summary.skipped.length > 0 ? (
              <>
                <div className="dsec__head">
                  <h3 className="dsec__title">Left out of the register entirely</h3>
                  <span className="dsec__hint">
                    {num(summary.skipped.length)} object
                    {summary.skipped.length === 1 ? '' : 's'}
                  </span>
                </div>
                {summary.skipped.map((s) => (
                  <p className="chart-note" key={s.name}>
                    <code>{s.name}</code> — {s.reason}
                  </p>
                ))}
              </>
            ) : null}
          </div>
        </section>
      ) : null}

      {opened && data ? (
        <ActivityPanel
          table={opened}
          day={data.date}
          scope={data.scope}
          source={data.source}
          onClose={() => setOpened(null)}
        />
      ) : null}
    </div>
  );
}
