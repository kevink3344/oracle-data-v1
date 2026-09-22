import { z } from '../http/z.js';

/**
 * The whole vocabulary the model is allowed to speak.
 *
 * ── WHY THIS FILE IS THE SAFETY ARGUMENT, NOT A VALIDATION DETAIL
 *
 * The tempting design is to let the model write SQL, or a filter expression, and
 * run it. Everything here exists to make that impossible by construction rather
 * than by review:
 *
 *   - There is **no** `sql`, `expression`, `field` or `groupBy`. The measure is
 *     fixed at the check amount and every filter is a typed member of `Check`.
 *     A model that invents a field name has invented nothing; the schema rejects
 *     the whole object.
 *   - `.strict()` is load-bearing, not tidiness. Without it an unrecognised key is
 *     *dropped*, so a model that hallucinates `{ aggregate: 'max', groupBy: 'vendor' }`
 *     would be silently answered as though `groupBy` had never been asked — the
 *     reader gets a single highest check when they asked for a league table, and
 *     nothing anywhere says a word. Rejecting is the only outcome that tells the
 *     truth about what happened.
 *   - The model is never shown rows, a total, or a sample. It has no route to a
 *     number even if it wanted one, because the numbers it could echo do not exist
 *     on its side of the wire.
 *
 * ── THE ONE THING IT MAY CHOOSE
 *
 * *Which* aggregation, over *which* filters. That is the entire surface. The
 * model does the understanding; `run.ts` does the truth.
 */

/** The closed set of reductions. Anything else is not a question about a register. */
export const AGGREGATES = ['max', 'min', 'avg', 'sum', 'count'] as const;

export type Aggregate = (typeof AGGREGATES)[number];

/**
 * What the question is *about*.
 *
 * ★ `invoice` IS ACCEPTED AND THEN REFUSED, RATHER THAN DISALLOWED.
 *
 *   "How many invoices did we pay in July" is a completely reasonable question and
 *   a reader will ask it. The choice is between the model answering
 *   `supported: false` with a generic shrug, or naming the subject and letting the
 *   server refuse with a sentence that says *why* and points somewhere useful.
 *
 *   The reason v1 does not answer it is in the plan §4.3 and it is a measurement
 *   rather than a scope decision: a check's invoices **do not always sum to it**
 *   (4,140 of 4,218 unscoped, all 78 falling short), so a reconciliation statement
 *   computed without naming its population is exactly the defect this codebase has
 *   fixed twice already. Accepting the word and refusing it in words is honest;
 *   pretending the model could not understand it would be a lie in the schema.
 */
export const SUBJECTS = ['check', 'invoice'] as const;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A supported question.
 *
 * Every optional filter is a **typed column of `Check`** — `vendor` matches part of
 * the vendor name, `checkNumber` the human-facing number, the amount bounds the
 * value. None of them is a name the model supplies for something to look up.
 *
 * ★ `limit` IS A ROW COUNT, NOT A THRESHOLD. "The top five July checks" is
 *   `limit: 5` and the same reduction; it is not a filter and must not be modelled
 *   as one, or "five highest" would come back as "every check over the fifth
 *   highest", which is a different set the moment two checks tie.
 */
export const SupportedIntent = z
  .object({
    supported: z.literal(true),
    subject: z.enum(SUBJECTS),
    aggregate: z.enum(AGGREGATES),
    dateFrom: z.string().regex(ISO_DATE).optional(),
    dateTo: z.string().regex(ISO_DATE).optional(),
    vendor: z.string().min(2).max(80).optional(),
    checkNumber: z.string().min(1).max(24).optional(),
    amountMin: z.number().finite().optional(),
    amountMax: z.number().finite().optional(),
    /** Top-N. `1` (the default) answers "the highest", `5` answers "the five highest". */
    limit: z.number().int().min(1).max(20).default(1),
  })
  .strict();

/** A question the model understood and the server will decline, in words. */
export const RefusedIntent = z
  .object({
    supported: z.literal(false),
    reason: z.string().min(3).max(200),
  })
  .strict();

export const Intent = z.discriminatedUnion('supported', [SupportedIntent, RefusedIntent]);

export type Intent = z.infer<typeof Intent>;
export type SupportedIntent = z.infer<typeof SupportedIntent>;

/**
 * The system prompt, built from the extract's own bounds.
 *
 * ★ NO DATE IS WRITTEN HERE. The window comes in as an argument and is the one
 *   measured off the file the answer will be computed from. A hard-coded
 *   "the data covers 2026-07-01 to 2026-08-11" would go stale the first time the
 *   extract is re-pulled, and the failure mode is a model confidently refusing to
 *   answer about a month that is in the file — or resolving "August" to a range
 *   that is half empty and reporting the half-full result as the answer.
 *
 * The prompt also carries the one instruction the whole design rests on: return an
 * intent, never a number. It is enforced by there being no field to put a number
 * in, but saying it costs one line and removes the ambiguity for the model.
 */
export function buildSystemPrompt(window: { from: string; to: string }): string {
  return [
    'You translate a question about a checks register (payment documents) into a JSON intent.',
    'Answer with ONE JSON object and nothing else. No prose, no markdown fences.',
    '',
    'When the question is answerable, emit:',
    '  supported    true',
    '  subject      "check", or "invoice" when the question is about invoices rather than checks',
    `  aggregate    one of ${AGGREGATES.join(' | ')}`,
    '  dateFrom     optional, YYYY-MM-DD',
    '  dateTo       optional, YYYY-MM-DD',
    '  vendor       optional, part of a vendor name',
    '  checkNumber  optional, a check number',
    '  amountMin    optional, a dollar amount',
    '  amountMax    optional, a dollar amount',
    '  limit        how many rows the reader asked for in a "top N" question, otherwise 1',
    '',
    'When the question is not about this register at all, emit:',
    '  supported    false',
    '  reason       one short sentence saying what is missing',
    '',
    `The register covers ${window.from} to ${window.to}.`,
    `"July" means dateFrom ${window.from.split('-')[0]}-07-01 and dateTo ${window.from.split('-')[0]}-07-31.`,
    'Use max for "highest", "largest", "biggest", "most expensive". Use avg for "average" or "mean".',
    'Use count for "how many". Use sum for "total" or "in total". Use min for "lowest" or "smallest".',
    // ★ MEASURED, AND THE REASON THIS SENTENCE EXISTS. Asked "What was check 63409 for?"
    //   three times at temperature 0, the model returned `count` once — a figure of 1 —
    //   and the amount twice. The question is genuinely ambiguous in English and the
    //   stable reading is the one a reader wants: a question naming a check asks what it
    //   was for. Counting the checks carrying a number is what a payee or date filter is
    //   for, so `sum` is stated here and normalised in `routes/ai.ts` rather than hoped
    //   for.
    'A question that names a specific check number asks what that check was for: use sum.',
    'A question about a month with no data in the window is still supported: emit the dates asked for.',
    '',
    'NEVER compute, estimate, guess or state a number. You are choosing which reduction to run, not running it.',
    'Do not include any field that is not in the list. Do not add commentary.',
  ].join('\n');
}

/** What `parseIntent` returns — a result rather than a throw, so the caller decides the HTTP shape. */
export type ParsedIntent =
  | { ok: true; intent: Intent }
  | { ok: false; problem: string; detail: unknown };

/**
 * Read the model's reply as an intent.
 *
 * ── ★ THE EMPTY-CONTENT CASE IS THE ONE THAT MATTERS, AND IT IS NOT HYPOTHETICAL
 *
 *   Measured against the model in `.env` (a reasoning model), at a small
 *   `max_tokens`: **HTTP 200, `content: ""`, `finish_reason: "length"`**. The
 *   reasoning consumed the budget before any answer was produced, and the status
 *   code says success. An implementation that goes straight to `JSON.parse` on that
 *   throws `SyntaxError: Unexpected end of JSON input` — an error naming nothing
 *   about the actual problem, on a check that "succeeded".
 *
 *   So the empty case is named here, before parsing, in words that say what to do
 *   about it. `model.ts` owns the `finish_reason === 'length'` half of the same
 *   problem.
 *
 * The fence-and-prose stripping below is not defensive clutter: a JSON-mode request
 * is honoured by this provider but was observed to be an *optional* framing, and
 * several OpenAI-compatible providers wrap output in ```json fences regardless.
 * Fences are stripped, then the outermost braces are taken. Nothing is repaired or
 * guessed — a reply with no braces is still a failure, and every rejection carries
 * the raw text so it is diagnosable rather than mysterious.
 */
export function parseIntent(reply: string): ParsedIntent {
  const text = reply.trim();

  if (text === '') {
    return {
      ok: false,
      problem:
        'The model returned an empty answer. This happens when the reasoning budget is ' +
        'exhausted before any content is produced; raise AI_MAX_TOKENS.',
      detail: { replyLength: 0 },
    };
  }

  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(text);
  const body = fenced?.[1] ?? text;
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');

  if (first === -1 || last <= first) {
    return {
      ok: false,
      problem: 'The model did not return a JSON object.',
      detail: { reply: text.slice(0, 500) },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(first, last + 1));
  } catch (e) {
    return {
      ok: false,
      problem: 'The model returned text that is not valid JSON.',
      detail: { message: e instanceof Error ? e.message : String(e), reply: text.slice(0, 500) },
    };
  }

  const result = Intent.safeParse(parsed);

  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }));

    // ★ `unrecognized_keys` IS CALLED OUT BY NAME because it is the specific
    //   failure `.strict()` exists for, and "Invalid input" would read as a
    //   malformed request rather than a model inventing a field. The reinterpretation
    //   has to be in the message, because whoever reads this is deciding whether to
    //   widen the allowlist.
    const invented = result.error.issues.filter((i) => i.code === 'unrecognized_keys');
    const problem =
      invented.length > 0
        ? 'The model asked for something outside the supported vocabulary: ' +
          invented.flatMap((i) => (i as { keys: string[] }).keys ?? []).join(', ') +
          '. The intent was rejected rather than answered with those fields ignored.'
        : 'The model returned an intent this server does not accept.';

    return { ok: false, problem, detail: { issues, intent: parsed } };
  }

  return { ok: true, intent: result.data };
}
