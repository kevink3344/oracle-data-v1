import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { loadChecks, type Check, type CheckInvoice, type ChecksExtract } from '../data/checks';
import { loadInvoices, type InvoiceAccount } from '../data/invoices';
import {
  askAssistant,
  loadAssistantStatus,
  type AssistantAnswer,
  type AssistantIntent,
  type AssistantStatus,
} from '../data/assistant';
import ErrorNotice from '../components/ErrorNotice';
import PinButton from '../components/PinButton';
import { ScopeApplied } from '../components/ScopeNote';
import ResizeGrip, { clampWidth, readStoredWidth, storeWidth } from '../components/ResizeGrip';
import { SortableHead } from '../components/SortHeader';
import ZoomImage from '../components/ZoomImage';
import { money, money0, num, pctSlim, pluralise, share } from '../data/format';
import { inScope } from '../data/scope';
import { useStore } from '../state/store';
import {
  CHRONO_ORDER,
  NEWEST_FIRST,
  describeOrder,
  sortRows,
  type SortColumn,
  type SortState,
} from '../data/sort';

/**
 * Checks — one payment document per row, with the invoices it paid.
 *
 * ── WHAT THIS SCREEN IS FOR ──────────────────────────────────────────────────
 *
 * Every other page in this app answers "what was committed and to whom". This one
 * answers "what actually left the bank, against what". A check is the end of the
 * chain — purchase order, receipt, invoice, payment — and it is the first place
 * the chain can be read backwards from a real number.
 *
 * ── THE TWO THINGS IT MUST NOT GET WRONG ─────────────────────────────────────
 *
 * 1. A check is NOT an invoice. 3,172 of the 4,218 checks in this window carry
 *    exactly one invoice and the largest carries 269, so the count is a column of
 *    its own rather than something a reader infers from a row per invoice.
 *
 * 2. The invoices do NOT always sum to the check. They do on 4,140 of 4,218
 *    (98.2%), and the 78 that disagree are real — credits, discounts,
 *    withholding. Every one of the 78 falls short and none is over, which is the
 *    direction a part-paid invoice predicts. So the panel prints both figures and
 *    the difference between them. Showing one in place of the other would be a
 *    confident lie about seventy-eight checks.
 */

const WIDTH_KEY = 'checks-panel-w';

/** Rows per page. The window is ~4,200 checks, so the table is always paged. */
const PER_PAGE = 50;

/**
 * How many invoices the panel lists inline.
 *
 * 100 covers every check in the window but five (they carry 269, 268, 261, 258
 * and 110 invoices). The CSV behind the button holds all of them, so the cap
 * costs a reader nothing and saves a panel that would otherwise render a
 * 269-row list on every open.
 */
const INVOICE_CAP = 100;

/** The panel's focus trap reads the same set the other two drawers use. */
const FOCUSABLE =
  'a[href], button:not([disabled]), summary, input, select, textarea, [tabindex]:not([tabindex="-1"])';

type ChecksPageData = ChecksExtract & { accountsByCheck: Map<number, InvoiceAccount[]> };

const termsOf = (q: string): string[] =>
  q
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

/**
 * Everything one check can be found by, flattened once at load.
 *
 * The invoice numbers are in here on purpose: a reader holding an invoice knows
 * its number long before they know which check paid it, and that lookup is the
 * one this page makes possible that nothing else in the app does.
 */
function haystack(c: Check): string {
  return [
    c.number,
    c.date,
    c.vendor,
    c.amount.toFixed(2),
    ...c.invoices.map((i) => `${i.number} ${i.date}`),
  ]
    .join(' ')
    .toLowerCase();
}

/**
 * The five columns, in the order they are shown.
 *
 * One list drives the headings, their alignment and the sort, so a column cannot
 * appear in the table without a heading or gain a heading with no order behind
 * it. `value` is what the column is *ordered by* and not what the cell says — the
 * amount cell renders `$1,020.00` and the amount column orders on 1020, because a
 * `$` sorts before every digit and a comma does not.
 *
 * ★ The check number is held as text and compared with `numeric: true`, so 9999
 *   stays before 10000. Plain string order files every five-digit check after
 *   every four-digit one and puts the column in an order no reader can use.
 */
const COLUMNS: SortColumn<Check>[] = [
  { key: 'check', label: 'Check', value: (c) => c.number },
  { key: 'date', label: 'Date', value: (c) => c.date, order: CHRONO_ORDER },
  { key: 'amount', label: 'Amount', numeric: true, value: (c) => c.amount },
  { key: 'invoices', label: 'Invoices', numeric: true, value: (c) => c.invoices.length },
  { key: 'vendor', label: 'Vendor', value: (c) => c.vendor },
];

/** A page list with gaps, so 85 pages does not become 85 buttons. */
function pageWindow(current: number, total: number): (number | null)[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out: (number | null)[] = [];
  const push = (n: number | null) => {
    if (out[out.length - 1] !== n) out.push(n);
  };
  push(1);
  if (current - 2 > 2) push(null);
  for (let n = Math.max(2, current - 2); n <= Math.min(total - 1, current + 2); n += 1) push(n);
  if (current + 2 < total - 1) push(null);
  push(total);
  return out;
}

const csvCell = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * Where an invoice number in the panel goes.
 *
 * ★ THE NUMBER ALONE IS NOT AN IDENTITY, and this relation is where it shows
 *   worst: `PAYAPP4` names four different documents in the invoices register, so
 *   a link carrying only the number would open the wrong one and look certain
 *   while doing it. The link therefore carries everything a check row knows
 *   about the invoice it paid — the number, the vendor the check paid, the date
 *   and the amount the link recorded — and the register narrows on them in that
 *   order. Against the current extracts that lands on exactly one row for 136 of
 *   the 141 links whose number is in the register; the five that stay ambiguous
 *   are `PAYAPP4`s that several vendors shared, and the register says so rather
 *   than picking silently.
 *
 * ★ Most of these links land on nothing, and that is a fact about the register's
 *   scope, not a broken link: 9,310 of the 9,451 links name an invoice outside
 *   the fund and programs the register covers. It is still worth linking —
 *   when it hits it is the fastest way to the invoice, and when it misses the
 *   register says which invoice it was looking for and why it is not there,
 *   which is a better answer than no link at all.
 */
function invoiceHref(i: CheckInvoice, vendor: string): string {
  const q = new URLSearchParams({
    invoice: i.number,
    vendor,
    date: i.date,
    amount: String(i.amount),
  });
  return `/spend/invoices?${q.toString()}`;
}

/**
 * The check's own invoices, as a file.
 *
 * This is the thing that makes the panel's 100-row cap honest: the list on screen
 * may be abbreviated, but the checkout never is. A check with 269 invoices hands
 * over 269 rows.
 */
function exportInvoices(check: Check, ordersMeasured: boolean) {
  const header = ['check_number', 'check_date', 'check_amount', 'invoice_number'];
  // ★ The PO column is written only when the extract has it. A column the source
  //   cannot fill must not appear as a column of blanks — and it must not appear
  //   as `none` either, which would be a claim about the ledger rather than about
  //   the file. The same rule the panel's own cells follow, for the same reason:
  //   a stale extract would otherwise hand a spreadsheet 8,025 invented absences.
  if (ordersMeasured) header.push('po_number');
  header.push('invoice_date', 'invoice_amount', 'accounted');
  const body = check.invoices.map((i) => {
    const row = [check.number, check.date, check.amount.toFixed(2), i.number];
    if (ordersMeasured) row.push(i.po ?? '');
    row.push(i.date, i.amount.toFixed(2), i.accounted ? 'Y' : 'N');
    return row;
  });
  const csv = [header, ...body].map((row) => row.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `check-${check.number}-invoices.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * ── THE ASSISTANT'S ANSWER ────────────────────────────────────────────────────
 *
 * ★ NOTHING IN THIS BLOCK COMPUTES A FIGURE. Every number came from the server,
 *   which reduced the register's own rows, and the sentence below is a template
 *   filled with those integers and with the app's own formatters. That is why the
 *   sentence and the number beside it cannot disagree: the number *is* its input.
 *
 * ★ AND THAT IS WHY THE AGGREGATE IS NAMED AND THE UNIT IS PRINTED. `value: 1` is
 *   a fine count and a nonsense check amount, and `temperature: 0` does **not**
 *   pin which reduction the model chose — measured, the same question came back
 *   as `count` once and `max` twice. So a bare figure is unreadable: the block
 *   always says *which* reduction produced it and *what* the figure is a count of.
 */

/** The five reductions, as a reader would name them above a figure. */
const ASSISTANT_WORD: Record<string, string> = {
  max: 'Highest',
  min: 'Lowest',
  avg: 'Average',
  sum: 'Total',
  count: 'How many',
};

/** The filters the model read, as a clause that can follow "The highest check". */
function assistantWhere(intent: AssistantIntent | null): string {
  if (!intent) return '';
  const parts: string[] = [];
  if (intent.dateFrom && intent.dateTo) parts.push(`dated ${intent.dateFrom} to ${intent.dateTo}`);
  else if (intent.dateFrom) parts.push(`dated from ${intent.dateFrom}`);
  else if (intent.dateTo) parts.push(`dated up to ${intent.dateTo}`);
  if (intent.vendor) parts.push(`to ${intent.vendor}`);
  if (intent.checkNumber) parts.push(`numbered ${intent.checkNumber}`);
  if (intent.amountMin !== null && intent.amountMax !== null) {
    parts.push(`between ${money(intent.amountMin)} and ${money(intent.amountMax)}`);
  } else if (intent.amountMin !== null) {
    parts.push(`of at least ${money(intent.amountMin)}`);
  } else if (intent.amountMax !== null) {
    parts.push(`of at most ${money(intent.amountMax)}`);
  }
  return parts.length > 0 ? ` ${parts.join(', ')}` : '';
}

/**
 * The answer, in one sentence, built from the server's figures.
 *
 * A `null` value is *not* a zero: the average of no checks is not `$0.00`, and
 * rendering one would be a claim about the data. A `sum` or `count` over no rows
 * is genuinely `0` and arrives as one, which is why the two are told apart here
 * by the value rather than by the row count.
 */
function assistantSentence(answer: AssistantAnswer): string {
  const { intent, unit, value, rows } = answer;
  const aggregate = intent?.aggregate ?? '';
  const where = assistantWhere(intent);
  const spread = ` across ${num(rows.matched)} ${pluralise(rows.matched, 'check')}`;

  if (value === null) {
    return `No check in the register matches that, so there is no figure to report.`;
  }
  if (unit === 'count') {
    return `${num(value)} ${pluralise(value, 'check')}${where} match.`;
  }

  const top = rows.sample[0] ?? null;
  const tail =
    top && (aggregate === 'max' || aggregate === 'min')
      ? ` — check ${top.number}${top.vendor ? ` to ${top.vendor}` : ''}${top.date ? ` on ${top.date}` : ''}.`
      : '.';

  switch (aggregate) {
    case 'max':
      return `The highest check${where} was ${money(value)}${tail}`;
    case 'min':
      return `The lowest check${where} was ${money(value)}${tail}`;
    case 'avg':
      return `The average check${where} was ${money(value)}${spread}.`;
    case 'sum':
      return `The checks${where} came to ${money(value)}${spread}.`;
    default:
      return `The figures${where} come to ${money(value)}${spread}.`;
  }
}

/** The sentence, for the live region that speaks the answer. */
function assistantSpoken(answer: AssistantAnswer): string {
  if (answer.kind === 'refused') return `The assistant refused that question. ${answer.refused?.reason ?? ''}`;
  const basis = answer.basis ? ` ${answer.basis.message}` : '';
  return `${assistantSentence(answer)}${basis}`;
}

/** The link that opens a check through the register's own `?check=` arrival. */
function checkHref(id: number): string {
  return `/spend/payments?check=${encodeURIComponent(String(id))}`;
}

/**
 * The answer panel under the search box.
 *
 * Four states, four renders — asking, the question could not be put (a `503` from
 * an unconfigured or unreachable assistant, or a `400`), a refusal, and an answer
 * with figures. A refusal is a **`200`** and is not an error: the data or the
 * vocabulary genuinely cannot answer, and the sentence says which.
 */
function AssistantAnswerBlock({
  answer,
  problem,
  question,
  asking,
  onDismiss,
}: {
  answer: AssistantAnswer | null;
  problem: string | null;
  question: string;
  asking: boolean;
  onDismiss: () => void;
}) {
  if (asking) {
    return (
      <div className="chkanswer chkanswer--busy">
        <p className="chkanswer__lead">
          Reading the register for <strong>{question}</strong>…
        </p>
        <p className="chkanswer__note">
          A model reads the question; this server computes the figure from the register&rsquo;s own rows.
        </p>
      </div>
    );
  }

  if (problem) {
    return (
      <div className="chkanswer chkanswer--problem" role="alert">
        <p className="chkanswer__lead">The assistant could not answer that.</p>
        <p className="chkanswer__note">{problem}</p>
        <button type="button" className="btn btn--system btn--sm" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    );
  }

  if (!answer) return null;

  if (answer.kind === 'refused') {
    return (
      <div className="chkanswer chkanswer--refused">
        <p className="chkanswer__lead">{answer.refused?.reason}</p>
        {answer.refused && answer.refused.answerable.length > 0 ? (
          <>
            <p className="chkanswer__note">Questions this assistant can answer:</p>
            <ul className="chkanswer__asks">
              {answer.refused.answerable.map((q) => (
                <li key={q}>{q}</li>
              ))}
            </ul>
          </>
        ) : null}
        <button type="button" className="btn btn--system btn--sm" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    );
  }

  const { basis, intent, model, rows, unit, value } = answer;
  const aggregate = intent?.aggregate ?? '';
  const word = ASSISTANT_WORD[aggregate] ?? 'Figure';
  /** The unit, said out loud beside the figure. See the block note. */
  const unitText = unit === 'count' ? pluralise(value ?? 0, 'check') : unit === 'money' ? 'paid' : 'no unit';
  const top = rows.sample[0] ?? null;

  return (
    <div className="chkanswer">
      <div className="chkanswer__figure">
        <span className="chkanswer__agg">{word}</span>
        <strong className="chkanswer__num">
          {value === null ? 'No figure' : unit === 'count' ? num(value) : money(value)}
        </strong>
        <span className="chkanswer__unit">{value === null ? 'for these filters' : unitText}</span>
      </div>

      {model?.note ? <p className="chkanswer__note">{model.note}</p> : null}

      <p className="chkanswer__lead">{assistantSentence(answer)}</p>

      {top ? (
        <p className="chkanswer__link">
          <Link to={checkHref(top.id)}>View check {top.number} →</Link>
        </p>
      ) : null}

      {rows.sample.length > 1 ? (
        <>
          <ul className="chkanswer__rows">
            {rows.sample.map((r) => (
              <li key={r.id}>
                <Link to={checkHref(r.id)}>check {r.number}</Link>
                <span className="chkanswer__rowmeta">
                  {' '}
                  {r.date ?? 'no date'} · {r.amount === null ? 'no amount' : money(r.amount)}
                  {r.vendor ? ` · ${r.vendor}` : ''}
                </span>
              </li>
            ))}
          </ul>
          {rows.matched > rows.sample.length ? (
            <p className="chkanswer__note">
              Showing {num(rows.sample.length)} of the {num(rows.matched)} checks that match — the figure
              above is over all {num(rows.matched)} of them, not over this list.
            </p>
          ) : null}
        </>
      ) : null}

      {/* ★ THE BASIS RENDERS UNCONDITIONALLY — only the count is the conditional
          part. A disclosure gated on "did this cost anything" is invisible in
          exactly the case it is needed. */}
      <p className="chkanswer__basis">{basis?.message ?? ''}</p>
      {/* ★ WHAT THE MESSAGE ABOVE CANNOT SAY, AND NOTHING ELSE. The message already
          names the scope, the source and the window; a second sentence repeating
          `Fund … · program … · source · window` under it tells the reader nothing and
          makes them hunt for a difference between two lines describing one thing.
          These two counts are the part the message has no room for — and unlike the
          message they ARE the conditional part, so the line appears only when one of
          them has something to report. */}
      {basis && (basis.excluded > 0 || basis.withoutAccounts > 0) ? (
        <p className="chkanswer__note">
          {[
            basis.excluded > 0 ? `${num(basis.excluded)} checks outside the scope were removed` : null,
            basis.withoutAccounts > 0
              ? `${num(basis.withoutAccounts)} of the ${num(basis.total)} read carry no account for the scope to test`
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      ) : null}
      {/* The question is answered over the register, never over the rows on screen
          — said here, because the search box above narrows the table and a reader
          would reasonably expect the question to apply to what they are looking at. */}
      <p className="chkanswer__note">
        The question is answered over the register, not over the rows the table is currently
        showing.
      </p>
      <div className="chkanswer__foot">
        {model ? (
          <span className="chkanswer__model">
            {model.name} · {num(model.ms)} ms
            {model.attempts > 1 ? ` · ${num(model.attempts)} attempts at ${num(model.maxTokens)} tokens` : ''}
          </span>
        ) : null}
        <button type="button" className="btn btn--system btn--sm" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

/** One labelled figure on the strip above the table. */
function Stat({ label, value, note }: { label: string; value: string; note?: ReactNode }) {
  return (
    <div className="chkstat">
      <div className="chkstat__k">{label}</div>
      <div className="chkstat__v">{value}</div>
      {note ? <div className="chkstat__n">{note}</div> : null}
    </div>
  );
}

export default function Checks() {
  const { scope, scopeTenant } = useStore();
  const [data, setData] = useState<ChecksPageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const [query, setQueryRaw] = useState('');
  const [page, setPage] = useState(1);

  // The order the table is in. Always a real column rather than a "no sort"
  // state: the register is always in some order, and the one it opens in is Date
  // descending — the order the file is written in. See `data/sort.ts`.
  const [sort, setSort] = useState<SortState>(NEWEST_FIRST);

  /**
   * The sort, said out loud, and this is not belt-and-braces.
   *
   * The heading's button is labelled with the NEXT action, so the moment it is
   * pressed its label describes the opposite of what just happened, and
   * `aria-sort` lives on the cell — which is not announced while the focus is on
   * the button inside it. Without this, the only feedback a screen reader gets
   * from sorting is a button that looks like it has relabelled itself. It is held
   * in state rather than derived from `sort` so that typing in the search box
   * does not re-announce the order on every keystroke.
   */
  const [sortNote, setSortNote] = useState('');

  // Content and visibility are separate: the selected check is kept while the
  // panel slides out, so it reads as a panel closing rather than emptying first.
  const [selected, setSelected] = useState<Check | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    Promise.all([loadChecks(controller.signal), loadInvoices(controller.signal)])
      .then(([checks, invoices]) => {
        const accountsByCheck = new Map<number, InvoiceAccount[]>();
        for (const invoice of invoices.invoices) {
          for (const check of invoice.checks) {
            const accounts = accountsByCheck.get(check.id);
            if (accounts) accounts.push(...invoice.accounts);
            else accountsByCheck.set(check.id, [...invoice.accounts]);
          }
        }
        setData({ ...checks, accountsByCheck });
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      });
    return () => controller.abort();
  }, [attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  // ── The assistant ───────────────────────────────────────────────────────────
  /**
   * Ask mode, the one question the page can put to the assistant, and its answer.
   *
   * ★ THREE STATES THAT MUST NOT RENDER ALIKE, and the reason the status read is
   *   held in an object rather than as a `AssistantStatus | null`:
   *
   *     • `done: false`                      — nobody has asked the server yet;
   *     • `done: true, value: null`          — the status read **failed**;
   *     • `done: true, value: { enabled:… }` — the server answered.
   *
   *   The control is disabled only for a server that said `enabled: false`. A
   *   failed read leaves it live, because the alternative is a disabled button
   *   whose tooltip states a reason the server never gave — and a working
   *   assistant hidden behind a broken request. Unknown means "try it, and get
   *   the server's own sentence".
   */
  const [aiStatus, setAiStatus] = useState<{ done: boolean; value: AssistantStatus | null }>({
    done: false,
    value: null,
  });
  const [ai, setAi] = useState(false);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<AssistantAnswer | null>(null);
  const [askProblem, setAskProblem] = useState<string | null>(null);
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    loadAssistantStatus(controller.signal)
      .then((value) => setAiStatus({ done: true, value }))
      .catch(() => {
        /* An aborted status read has no result to report. */
      });
    return () => controller.abort();
  }, []);

  // Unmount, or leaving the page, abandons a question in flight rather than
  // setting state on a component that is gone.
  useEffect(() => () => inFlight.current?.abort(), []);

  /** The server said the assistant is off. Unknown is *not* off — see above. */
  const assistantOff = aiStatus.value !== null && !aiStatus.value.enabled;
  const aiTitle = assistantOff
    ? aiStatus.value?.reason ?? 'The assistant is switched off on this server.'
    : ai
      ? 'Leave ask mode — back to searching'
      : 'Ask a question in plain English';

  /**
   * One question. Never on a keystroke: each submission is a network call and a
   * model call, which is why this is bound to Enter and to nothing else.
   */
  const ask = useCallback(async () => {
    const text = question.trim();
    if (text === '' || asking) return;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setAsking(true);
    setAskProblem(null);
    setAnswer(null);
    try {
      const result = await askAssistant(text, controller.signal);
      if (!controller.signal.aborted) setAnswer(result);
    } catch (err) {
      if (controller.signal.aborted) return;
      setAskProblem(err instanceof Error ? err.message : String(err));
    } finally {
      if (!controller.signal.aborted) setAsking(false);
    }
  }, [question, asking]);

  const dismissAnswer = useCallback(() => {
    inFlight.current?.abort();
    setAsking(false);
    setAnswer(null);
    setAskProblem(null);
  }, []);

  const scopedChecks = useMemo(() => {
    if (!data) return [];
    if (!scopeTenant) return data.checks;
    return data.checks.filter((check) =>
      (data.accountsByCheck.get(check.id) ?? []).some((account) =>
        inScope(scope, account.segments[0] ?? '', account.segments[2] ?? ''),
      ),
    );
  }, [data, scope, scopeTenant]);

  // One flattened haystack per check, built once, not once per keystroke.
  const index = useMemo(
    () => scopedChecks.map((check) => ({ check, hay: haystack(check) })),
    [scopedChecks],
  );

  const terms = useMemo(() => termsOf(query), [query]);
  const matches = useMemo(
    () => (terms.length === 0 ? index : index.filter((r) => terms.every((t) => r.hay.includes(t)))),
    [index, terms],
  );

  const setQuery = (next: string) => {
    setQueryRaw(next);
    setPage(1);
  };

  const totalPages = Math.max(1, Math.ceil(matches.length / PER_PAGE));
  // Clamped rather than reset: a filter that shrinks the list while the reader is
  // on page 40 should land them on the last page, not on an empty one.
  const current = Math.min(page, totalPages);

  // ★ Sorted from `matches`, never from the previous sort's result: `sortRows`
  // reads the tie order off the array it is given, so a sort applied to an
  // already-sorted array would break ties by the previous column and a row could
  // move between pages for no reason the reader can see. `matches` is in the
  // register's own order on every render, which is what makes ties stable.
  const sorted = useMemo(() => sortRows(matches.map((r) => r.check), COLUMNS, sort), [matches, sort]);
  const shown = sorted.slice((current - 1) * PER_PAGE, current * PER_PAGE);

  /** What a click on a heading means, for the sort, the page and the announcement. */
  const applySort = (next: SortState) => {
    setSort(next);
    // Back to the first page. A filter clamps the page instead, deliberately — it
    // narrows the list without reordering it, so page 40 is still the
    // neighbourhood the reader was in. Sorting moves every row they were looking
    // at somewhere else, and they clicked something at the top of the table.
    setPage(1);
    // Sorting does not change how many rows match, so this count is the same
    // before and after and is safe to read from the state being replaced.
    setSortNote(`${pluralise(sorted.length, 'check')}, ${describeOrder(COLUMNS, next)}.`);
  };

  // The words for the order the table is in, used by the sentence above it and by
  // its caption, so neither can describe an order the table is not in.
  const order = describeOrder(COLUMNS, sort);

  const totals = useMemo(() => {
    // Empty as well as absent: `biggest` and `widest` are seeded with
    // `checks[0]`, and on an empty list that is `undefined` rather than a row, so
    // every reader of these four numbers would have to test for it separately.
    if (!data || scopedChecks.length === 0) return null;
    const value = scopedChecks.reduce((s, c) => s + c.amount, 0);
    const multi = scopedChecks.filter((c) => c.invoices.length > 1).length;
    const biggest = scopedChecks.reduce((m, c) => (c.amount > m.amount ? c : m), scopedChecks[0]);
    const widest = scopedChecks.reduce((m, c) => (c.invoices.length > m.invoices.length ? c : m), scopedChecks[0]);
    return { value, multi, biggest, widest };
  }, [data, scopedChecks]);

  const openCheck = useCallback((c: Check) => {
    setSelected(c);
    setOpen(true);
  }, []);

  /**
   * ★ A CLICK FROM THE INVOICES PANEL SETTLES HERE — the mirror of the link this
   *   page sends to the invoices register, and a much simpler one.
   *
   * The check is the parent of the relation: a check pays many invoices, so this
   * file keys its link table on `CHECK_ID`. The invoice side carries the same
   * `CHECK_ID` on every link row, which means the arrival needs no search and no
   * narrowing — the parameter IS the key, and a check that is in the window is
   * found exactly. When the invoice side offered the link, all 117 of its links
   * that point at an invoice in the register resolved to a check in this file,
   * so a miss here means something changed rather than something was guessed.
   *
   * The register is filtered to the check's number as well as opening the panel,
   * for the same reason the other direction filters: the panel is modal and the
   * table behind it is what the reader compares the panel against. Check numbers
   * are unique in this extract — 4,218 distinct across 4,218 checks — so that
   * filter can only ever leave one row standing.
   */
  const [params] = useSearchParams();
  const wantedCheck = (params.get('check') ?? '').trim();
  const [missing, setMissing] = useState<string | null>(null);
  const arrived = useRef<string | null>(null);
  /**
   * What the filter held when the link was followed, so the note can tell the
   * reader having typed something from the arrival's own filtering. Comparing
   * against a bare "is the query empty" cannot: a hit sets the filter itself, and
   * a miss can arrive over a register someone had already searched.
   */
  const arrivalQuery = useRef('');

  useEffect(() => {
    if (!data || !wantedCheck || arrived.current === wantedCheck) return;
    arrived.current = wantedCheck;
    const found = scopedChecks.find((c) => String(c.id) === wantedCheck);
    if (!found) {
      // Leave the register exactly as the reader had it; the note carries the reason.
      arrivalQuery.current = query;
      setMissing(wantedCheck);
      return;
    }
    setMissing(null);
    arrivalQuery.current = found.number;
    setQueryRaw(found.number);
    setPage(1);
    openCheck(found);
  }, [data, scopedChecks, wantedCheck, openCheck, query]);

  /**
   * The note is a statement about the filter the arrival applied, so it belongs
   * to that filter: the moment the search holds anything else, the reader has
   * moved on and the note is answering a question nobody asked.
   */
  useEffect(() => {
    if (missing && query !== arrivalQuery.current) setMissing(null);
  }, [missing, query]);

  return (
    <div className="stack">
      <div>
        <div className="accent-rule" />
        <div className="page-head">
          <div>
            <h1>Checks</h1>
            <p className="page-head__sub">
              {data
                ? `One payment document per row, ${order} — ${num(scopedChecks.length)} checks issued between ${data.window.from} and ${data.window.to}. Click a check to see the invoices it paid.`
                : `One payment document per row, ${order}, with the invoices each check paid.`}
            </p>
          </div>
        </div>
      </div>

      <ScopeApplied register="The checks register" shown={scopedChecks.length} total={data?.checks.length ?? 0} />

      {/*
        ★ A LINK FROM AN INVOICE ARRIVED WITH A CHECK THAT IS NOT IN THIS WINDOW.

        It should not be reachable: the invoices register only offers the link for tells its own
        links carry, and every one of those resolved to a check in this file when the two extracts
        were last pulled. So this note is a guard on the extract staying in step rather than an
        everyday state — and it says which check and why, because a click that lands on an
        unfiltered register with no explanation reads as a broken link, not as a window that moved.
      */}
      {data && missing ? (
        <p className="scopenote" role="note">
          <span className="scopenote__flag">Not in this window</span>
          No check in this register has the identity <strong>{missing}</strong>. The invoices
          register only links a check it holds a payment link for, so this is the two extracts
          having been pulled at different times — re-run{' '}
          <code>node server/scripts/pull-ap-extract.mjs</code> to bring them back into step. The
          whole register is below.
        </p>
      ) : null}

      {error ? (
        <ErrorNotice
          error={error}
          reload={reload}
          heading="The checks extract could not be read."
          hint={
            <>
              <p>
                The app fetches <code>oracle/checks.json</code> from the dev server. Run{' '}
                <code>npm run sync:extract</code> to copy it out of <code>data/oracle/</code>.
              </p>
              <p className="chkstat__n">
                That file is generated from Oracle, not transcribed —{' '}
                <code>node server/scripts/pull-ap-extract.mjs</code> rebuilds it for the current
                fiscal year.
              </p>
            </>
          }
        />
      ) : null}

      {data && totals ? (
        <div className="chkstats">
          <Stat
            label="Checks issued"
            value={num(scopedChecks.length)}
            note={pluralise(scopedChecks.reduce((n, check) => n + check.invoices.length, 0), 'invoice')}
          />
          <Stat label="Value" value={money0(totals.value)} note="sum of the checks themselves" />
          <Stat
            label="Reconciled by their invoices"
            value={pctSlim(share(scopedChecks.filter((check) => Math.abs(check.invoiced - check.amount) < 0.005).length, scopedChecks.length))}
            note={`${num(scopedChecks.filter((check) => Math.abs(check.invoiced - check.amount) < 0.005).length)} of ${num(scopedChecks.length)} to the cent`}
          />
          <Stat
            label="Paying more than one invoice"
            value={num(totals.multi)}
            note={`largest is ${num(totals.widest.invoices.length)}`}
          />
          <Stat
            label="Largest single check"
            value={money0(totals.biggest.amount)}
            note={`check ${totals.biggest.number} to ${totals.biggest.vendor}`}
          />
        </div>
      ) : null}

      <section className="panel">
        <div className="panel__head">
          <div>
            <h2 className="panel__title">All checks</h2>
            <p className="panel__sub">
              {terms.length > 0
                ? `${num(matches.length)} of ${num(index.length)} checks match “${query.trim()}”, searched across check number, vendor, amount, date and every invoice number paid.`
                : 'Searchable by check number, vendor, amount, date, or the number of any invoice the check paid.'}
            </p>
          </div>
          <span className="panel__count">
            {matches.length === 0 ? '—' : `${num((current - 1) * PER_PAGE + 1)}–${num((current - 1) * PER_PAGE + shown.length)} of ${num(matches.length)}`}
          </span>
        </div>

        <div className="filterbar chkfilter" role="group" aria-label={ai ? 'Ask a question about checks' : 'Filter checks'}>
          <div className={ai ? 'chkfilter__box chkfilter__box--ai' : 'chkfilter__box'}>
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.6" />
              <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <label className="sr" htmlFor="check-filter">
              {ai ? 'Ask a question about checks' : 'Search checks'}
            </label>
            <input
              id="check-filter"
              type="search"
              autoComplete="off"
              placeholder={
                ai
                  ? 'Ask — e.g. What was the highest check paid in July?'
                  : 'Search by check number, vendor or invoice number — e.g. 44407396'
              }
              value={ai ? question : query}
              onChange={(e) => (ai ? setQuestion(e.target.value) : setQuery(e.target.value))}
              onKeyDown={(e) => {
                // ★ A QUESTION IS SUBMITTED, NOT TYPED AT. Every keystroke that
                //   reached the server would be a model call, so Enter is the only
                //   thing that asks, and the button is there for a reader who does
                //   not know that.
                if (e.key === 'Enter' && ai) {
                  e.preventDefault();
                  if (question.trim()) void ask();
                  return;
                }
                if (e.key === 'Escape') {
                  // Escape leaves ask mode first and clears second — the same key
                  // the box already used, with one more step, so the muscle memory
                  // of "Escape empties this box" survives the second mode.
                  if (ai && question) {
                    e.preventDefault();
                    setQuestion('');
                  } else if (ai) {
                    e.preventDefault();
                    setAi(false);
                  } else if (query) {
                    e.preventDefault();
                    setQuery('');
                  }
                }
              }}
            />
            <button
              type="button"
              className="chkfilter__ai"
              aria-pressed={ai}
              aria-label={ai ? 'Leave ask mode — back to searching' : 'Ask a question in plain English'}
              title={aiTitle}
              disabled={assistantOff || asking}
              onClick={() => setAi((v) => !v)}
            >
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M7.7 3.2C7 2.3 5.8 2 4.9 2.7c-.8-.1-1.6.4-1.8 1.2-.7.4-1 1.2-.8 2-.5.5-.5 1.4 0 1.9-.2.6 0 1.3.6 1.7.1.9.9 1.7 1.8 1.7.5.5 1.3.6 1.9.2.4.4 1 .5 1.5.3V3.4c-.1 0-.3-.1-.4-.2Z"
                  stroke="currentColor"
                  strokeWidth="1.1"
                  strokeLinejoin="round"
                />
                <path
                  d="M8.3 3.2c.7-.9 1.9-1.2 2.8-.5.8-.1 1.6.4 1.8 1.2.7.4 1 1.2.8 2 .5.5.5 1.4 0 1.9.2.6 0 1.3-.6 1.7-.1.9-.9 1.7-1.8 1.7-.5.5-1.3.6-1.9.2-.4.4-1 .5-1.5.3V3.4c.1 0 .3-.1.4-.2Z"
                  stroke="currentColor"
                  strokeWidth="1.1"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>

          {ai ? (
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => void ask()}
              disabled={asking || question.trim() === ''}
            >
              {asking ? 'Asking…' : 'Ask'}
            </button>
          ) : null}

          {!ai && query ? (
            <button type="button" className="fchip" onClick={() => setQuery('')} title="Clear the search filter">
              Clear “{query.trim()}”
            </button>
          ) : null}
        </div>

        <AssistantAnswerBlock
          answer={answer}
          problem={askProblem}
          question={question.trim()}
          asking={asking}
          onDismiss={dismissAnswer}
        />

        {/* The answer, spoken. A third live region rather than a longer first one:
            the filter sentence is rebuilt on every keystroke, and an answer
            stapled to it would be re-read in full each time. */}
        <p className="sr" role="status">
          {asking
            ? 'Asking the assistant.'
            : answer
              ? assistantSpoken(answer)
              : ''}
        </p>

        {/* A filter changes the row count silently; the same sentence in a live
            region is how a screen reader learns it did anything. */}
        <p className="sr" role="status">
          {terms.length > 0
            ? `${num(matches.length)} of ${num(index.length)} checks match ${query.trim()}.`
            : ''}
        </p>

        {/* The sort, spoken. A second live region rather than a longer first one:
            the filter sentence is rebuilt on every keystroke, and an order
            announcement stapled to it would be re-read in full each time. */}
        <p className="sr" role="status">
          {sortNote}
        </p>

        {!data ? (
          <div className="panel__body">
            <p className="chkempty">Reading the checks extract…</p>
          </div>
        ) : shown.length === 0 ? (
          <div className="chkempty">
            <p>
              No check of the {num(index.length)} in this window matches <strong>{query.trim()}</strong>.
            </p>
            <p className="chkempty__hint">
              Every word has to appear somewhere in the check or in one of its invoices, so a
              two-word search is an &ldquo;and&rdquo;, not a phrase. Check numbers match on their
              digits, and an invoice number finds the check that paid it.
            </p>
            <button type="button" className="btn btn--system btn--sm" onClick={() => setQuery('')}>
              Clear the search
            </button>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data chktable">
              <caption className="sr">
                Payment documents issued this fiscal year, {order}, with the number of invoices
                each one paid. Click a column heading to reorder the table.
              </caption>
              <colgroup>
                <col className="c-check" />
                <col className="c-date" />
                <col className="c-amount" />
                <col className="c-inv" />
                <col className="c-vendor" />
              </colgroup>
              <SortableHead columns={COLUMNS} sort={sort} onSort={applySort} />
              <tbody>
                {shown.map((check) => (
                  <tr
                    key={check.id}
                    className={`chktable__row${check.id === selected?.id && open ? ' is-open' : ''}`}
                    onClick={() => openCheck(check)}
                  >
                    <td className="chk-num">
                      {/* The row is clickable for the mouse; this button is what
                          makes it reachable by keyboard and what gives the row a
                          name. Both do the same thing. */}
                      <button
                        type="button"
                        className="chk-link"
                        aria-expanded={check.id === selected?.id && open}
                        aria-controls="check-detail"
                        onClick={(e) => {
                          e.stopPropagation();
                          openCheck(check);
                        }}
                      >
                        {check.number}
                      </button>
                    </td>
                    <td className="chk-num">{check.date}</td>
                    <td className="n chk-num">{money(check.amount)}</td>
                    <td className="n">
                      <span className={`chkinv${check.invoices.length > 1 ? ' chkinv--many' : ''}`}>
                        {num(check.invoices.length)}
                      </span>
                    </td>
                    <td>{check.vendor}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {shown.length > 0 ? (
          <div className="pager">
            <button
              type="button"
              className="btn btn--system btn--sm"
              disabled={current === 1}
              onClick={() => setPage(current - 1)}
            >
              Previous
            </button>

            <span className="pager__pages">
              {pageWindow(current, totalPages).map((n, i) =>
                n === null ? (
                  <span key={`gap-${i}`} className="pager__gap">
                    …
                  </span>
                ) : (
                  <button
                    key={n}
                    type="button"
                    className="pager__n"
                    aria-current={n === current ? 'page' : undefined}
                    aria-label={`Page ${n} of ${totalPages}`}
                    onClick={() => setPage(n)}
                  >
                    {n}
                  </button>
                ),
              )}
            </span>

            <button
              type="button"
              className="btn btn--system btn--sm"
              disabled={current === totalPages}
              onClick={() => setPage(current + 1)}
            >
              Next
            </button>
          </div>
        ) : null}

        {data && totals && shown.length > 0 ? (
          <p className="chart-note" style={{ padding: '0 16px 12px' }}>
            A check is not an invoice. {num(totals.multi)} of the {num(data.checks.length)} checks
            here pay more than one, and the largest pays {num(totals.widest.invoices.length)} — so
            the count is a column rather than a row per invoice. The invoices sum exactly to the
            check on {num(data.reconciled)} of them; the remaining{' '}
            {num(data.checks.length - data.reconciled)} differ by a credit, a discount or a
            withholding, and the panel shows both figures rather than choosing one.
          </p>
        ) : null}
      </section>

      <CheckPanel
        check={selected}
        open={open}
        onClose={() => setOpen(false)}
        poCoverage={{
          measured: data?.ordersMeasured ?? false,
          named: data?.orders?.named ?? 0,
          links: data?.orders?.links ?? 0,
        }}
      />
    </div>
  );
}

/**
 * The check's invoices, in a panel that slides in from the right.
 *
 * It keeps the shared `.drawer` primitive's geometry and close button, and its
 * own body, because what goes in it — a list of invoices and the arithmetic that
 * ties them to the check — exists nowhere else in the app.
 */
function CheckPanel({
  check,
  open,
  onClose,
  poCoverage,
}: {
  check: Check | null;
  open: boolean;
  onClose: () => void;
  /**
   * What the extract can say about purchase orders, and how far it reaches.
   *
   * ★ IT ARRIVES AS A PROP RATHER THAN OFF `check` BECAUSE IT IS A FACT ABOUT THE
   *   FILE, NOT ABOUT THE CHECK. `measured` is false when the extract was written
   *   before the `PO_NUMBER` column existed, and the panel must then say *not
   *   measured* rather than *none* — an absent source is not an absent order.
   *   `named` and `links` are the extract's own coverage counts, carried so the
   *   note can put this check's figure beside the ordinary case.
   */
  poCoverage: { measured: boolean; named: number; links: number };
}) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // The same three-state width contract as the other two panels: null lets the
  // stylesheet own it until the reader resizes.
  const [width, setWidth] = useState<number | null>(() => readStoredWidth(WIDTH_KEY));
  const [resizing, setResizing] = useState(false);
  const [rendered, setRendered] = useState(0);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement as HTMLElement | null;
    document.body.classList.add('is-locked');
    return () => {
      document.body.classList.remove('is-locked');
      openerRef.current?.focus?.();
    };
  }, [open]);

  // Focus has to wait for the content: on the first open the close button is not
  // rendered yet, so focusing in the same commit silently does nothing.
  useEffect(() => {
    if (open && check) closeRef.current?.focus();
  }, [open, check]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
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
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const measure = () => {
      const el = panelRef.current;
      if (el) setRendered(Math.round(el.getBoundingClientRect().width));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

  useEffect(() => {
    document.body.classList.toggle('is-resizing', resizing);
    return () => {
      if (!resizing) return;
      document.body.classList.remove('is-resizing');
    };
  }, [resizing]);

  const setUserWidth = (w: number) => {
    const next = clampWidth(w);
    setWidth(next);
    storeWidth(WIDTH_KEY, next);
  };
  const resetWidth = () => {
    setWidth(null);
    storeWidth(WIDTH_KEY, null);
  };

  const invoices = check?.invoices ?? [];
  const listed = invoices.slice(0, INVOICE_CAP);
  const credited = invoices.filter((i) => i.amount < 0).length;
  // Counted off the rows, never off a figure the extract also computed: the two
  // would then agree by construction instead of by being right.
  const ordered = invoices.filter((i) => i.po).length;
  const unordered = invoices.length - ordered;
  const difference = check ? check.invoiced - check.amount : 0;
  const agrees = Math.abs(difference) < 0.005;
  const style = width === null ? undefined : ({ '--drawer-w': `${width}px` } as CSSProperties);

  return (
    <aside
      ref={panelRef}
      id="check-detail"
      className={`drawer chkpanel${open ? ' is-open' : ''}${resizing ? ' is-resizing' : ''}`}
      style={style}
      role="dialog"
      aria-modal="true"
      aria-label={check ? `Check ${check.number} — invoices paid` : 'Check details'}
      aria-hidden={!open}
      tabIndex={-1}
    >
      <ResizeGrip
        value={width ?? rendered}
        onChange={setUserWidth}
        onReset={resetWidth}
        onDraggingChange={setResizing}
        controls="check-detail"
        label="Resize the check details panel"
      />

      <div className="drawer__head">
        <div className="drawer__eyebrow">
          Check · {pluralise(invoices.length, 'invoice')}
        </div>
        <h2 className="drawer__name">{check?.number ?? ''}</h2>
        <div className="drawer__meta">
          <b>{check?.date ?? ''}</b> · <b>{money(check?.amount ?? 0)}</b>
          <br />
          {check?.vendor || 'No vendor named on the invoices'}
        </div>
        {check ? (
          <PinButton
            category="check"
            entityKey={String(check.id)}
            title={check.number || `Check ${check.id}`}
            subtitle={`${check.vendor} · ${check.date}`}
            href={`/spend/payments?check=${encodeURIComponent(String(check.id))}`}
          />
        ) : null}
        <button
          ref={closeRef}
          type="button"
          className="drawer__close"
          onClick={onClose}
          aria-label="Close the check details panel"
        >
          <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      <div className="drawer__body">
        <section className="dsec">
          <div className="dsec__head">
            <h3 className="dsec__title">What the check paid</h3>
            {invoices.length > INVOICE_CAP ? (
              <span className="dsec__hint">
                {num(INVOICE_CAP)} of {num(invoices.length)} shown
              </span>
            ) : null}
          </div>

          <div className="chkinvoices">
            <table className="chkinvtable">
              <caption className="sr">
                Invoices paid by this check, with the purchase order each names, if any.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Invoice</th>
                  <th scope="col">
                    <abbr title="Purchase order">PO</abbr>
                  </th>
                  <th scope="col">Date</th>
                  <th scope="col" className="n">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {listed.map((i, n) => (
                  <tr key={`${i.number}-${n}`}>
                    <td className="chk-num">
                      <Link
                        className="chk-invlink"
                        to={invoiceHref(i, check?.vendor ?? '')}
                        title="Open this invoice in the invoices register"
                      >
                        {i.number}
                      </Link>
                    </td>
                    {/* Three states, kept apart on purpose — see `CheckInvoice.po`.
                        `not measured` is a fact about the file and `none` is a fact
                        about the ledger; rendering the first as the second would
                        invent 8,025 absences in a stale extract. */}
                    {!poCoverage.measured ? (
                      <td className="chk-po chk-po--absent">not measured</td>
                    ) : i.po ? (
                      <td className="chk-po">{i.po}</td>
                    ) : (
                      <td className="chk-po chk-po--none">none</td>
                    )}
                    <td className="chk-num">{i.date}</td>
                    <td className={`n chk-num${i.amount < 0 ? ' chkinvoices__credit' : ''}`}>
                      {money(i.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row" colSpan={3}>
                    {invoices.length > INVOICE_CAP ? 'All invoices, total' : 'Total'}
                  </th>
                  <td className="n chk-num">{money(check?.invoiced ?? 0)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* ★ The PO column is mostly its own absence — measured, 1,426 of the
              extract's 9,451 invoice payments name an order — so the note is the
              thing that keeps it from reading as broken.

              ★ TWO GRAINS SIT IN THIS PARAGRAPH AND EACH ONE IS NAMED. The first
                count is over *this check's invoices*; the extract-wide count is
                over *invoice payments*, which is a different population (a
                payment is one invoice settled by one check, and the extract holds
                more payments than invoices). Printing them side by side without
                their units is the shape that turns two true numbers into one
                wrong comparison.

              ★ The second paragraph states no number the panel cannot derive.
                The evidence it cites is the *content* of the unnamed links,
                measured on this window: their invoice numbers read TRAV/063026,
                PARENT STIPEND 06.24.26 and LOCAL/ March 2026ADJ, and their largest
                vendors are utilities, standing services and account-based office
                supply (Verizon Wireless, the City of Raleigh, Duke Energy, the
                towns of Apex and Cary, Staples Advantage, ODP Business Solutions)
                — 8,025 links across 2,408 vendors. A count that no gate can check
                is deliberately left in this comment rather than in the copy. */}
          {!poCoverage.measured ? (
            <p className="chknote">
              This extract was written before the purchase-order column existed, so the panel
              cannot say which of these invoices names an order. That is not a claim that none
              does — re-pull the extract (<code>node server/scripts/pull-ap-extract.mjs</code>){' '}
              to fill the column in.
            </p>
          ) : unordered > 0 ? (
            <p className="chknote">
              {ordered === 0
                ? 'No invoice on this check names a purchase order. '
                : `${num(ordered)} of this check's ${num(invoices.length)} invoices name a purchase order. `}
              Across the whole extract {num(poCoverage.named)} of its {num(poCoverage.links)}{' '}
              invoice payments do ({pctSlim(share(poCoverage.named, poCoverage.links))}), so an
              empty PO cell is the ordinary case rather than a gap — and those invoices are not
              purchases with an order left off. Their numbers name travel, stipends and journal
              adjustments, and their largest vendors are utilities, standing services and
              account-based office supply, none of which is raised against an order.
            </p>
          ) : null}

          {invoices.length > INVOICE_CAP ? (
            <p className="chknote">
              The list is capped at {num(INVOICE_CAP)} rows so the panel opens quickly. The total
              above is over all {num(invoices.length)} — download them to see the rest.
            </p>
          ) : null}

          {credited > 0 ? (
            <p className="chknote">
              {credited === 1 ? 'One invoice is a credit' : `${num(credited)} invoices are credits`}{' '}
              — negative amounts, which is why some rows below the total are signed.
            </p>
          ) : null}

          <p className="chknote">
            Each invoice number opens that invoice in the invoices register, which covers a
            narrower scope than this window does. Most of the invoices a check paid are outside
            it, so the register will often have no row for the number it was handed — it says
            which number it was looking for, rather than opening on a different invoice.
          </p>
        </section>

        {/* The viewer is the real control; the artwork inside it is a stand-in, and
            the hint says so rather than letting a zoomed-in sample read as a real
            check. It resets to fit on `check.id`, so the next check always opens
            whole instead of inheriting this one's pan. */}
        <section className="dsec" aria-labelledby="check-image-title">
          <div className="dsec__head">
            <h3 id="check-image-title" className="dsec__title">Check image</h3>
            <span className="dsec__hint">Sample image, not a real check</span>
          </div>
          <ZoomImage
            src="/images/sample-check-cover.png"
            alt="Sample check image placeholder — not a real check"
            label={check ? `Check image viewer for check ${check.number}` : 'Check image viewer'}
            resetKey={check?.id ?? null}
          />
        </section>

        <section className="dsec">
          <div className="dsec__head">
            <h3 className="dsec__title">Check against invoices</h3>
            <span className="dsec__hint">{agrees ? 'agrees to the cent' : 'does not balance'}</span>
          </div>

          <div className="chkrows">
            <div className="chkrow">
              <span className="chkrow__k">Check amount</span>
              <span className="chkrow__v">{money(check?.amount ?? 0)}</span>
            </div>
            <div className="chkrow">
              <span className="chkrow__k">
                Invoices paid{invoices.length > 1 ? ` (${num(invoices.length)})` : ''}
              </span>
              <span className="chkrow__v">{money(check?.invoiced ?? 0)}</span>
            </div>
            <div className={`chkrow chkrow--sum${agrees ? '' : ' chkrow--off'}`}>
              <span className="chkrow__k">{agrees ? 'Difference' : 'Unexplained difference'}</span>
              <span className="chkrow__v">{agrees ? money(0) : money(difference)}</span>
            </div>
          </div>

          <p className="chknote">
            {agrees
              ? 'Every checked figure in this window is expected to land here. It does on 4,140 of the 4,218 checks — a credit note, a discount or a withholding accounts for the rest.'
              : 'The invoices do not add up to the check exactly. That is a real state, not a rendering fault: a credit, a discount or a withholding sits between the two figures, and neither has been adjusted to hide it.'}
          </p>
        </section>
      </div>

      <div className="drawer__foot">
        <button
          type="button"
          className="btn btn--system btn--sm"
          onClick={() => check && exportInvoices(check, poCoverage.measured)}
          disabled={!check || invoices.length === 0}
          title="Every invoice this check paid, including any past the panel's own list"
        >
          Download {pluralise(invoices.length, 'invoice')} (CSV)
        </button>
        <button type="button" className="btn btn--system btn--sm" onClick={onClose}>
          Close
        </button>
      </div>
    </aside>
  );
}
