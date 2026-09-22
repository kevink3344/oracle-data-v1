import { z } from '../http/z.js';
import type { Api } from '../http/api.js';
import { int, real, text, textReq } from '../schemas/columns.js';
import { AppError } from '../http/errors.js';
import { config } from '../config/env.js';
import { requireActor } from '../auth/guard.js';
import { parseIntent, buildSystemPrompt, type SupportedIntent } from '../ai/intent.js';
import { aiStatus, ask } from '../ai/model.js';
import { narrow, type AiScope } from '../ai/scope.js';
import { run } from '../ai/run.js';

/**
 * The assistant's two endpoints.
 *
 * ── ★ WHY THE ANSWER IS BUILT HERE AND NOT BY THE MODEL
 *
 *   The split, in one sentence: **the model chooses what to measure, this server
 *   performs the measurement.** `ai/intent.ts` holds the closed vocabulary the model
 *   may speak, `ai/run.ts` performs the reduction, and the figure the reader sees was
 *   computed from the same integers the register renders. The model never receives a
 *   row, a total, or a sample that would let it guess one — so it has no route to a
 *   number even if it wanted one, and a wrong figure is a bug in arithmetic that can
 *   be tested rather than a plausibility that cannot.
 *
 * ── ★ WHAT THIS ROUTE REFUSES, AND WHY EVERY REFUSAL IS AN ANSWER
 *
 *   Four situations produce a refusal rather than a figure, and each is a *sentence*
 *   rather than an error, because each is something the data or the vocabulary
 *   genuinely cannot answer — not something that went wrong:
 *
 *     1. The model reads the question as not being about this register.
 *     2. The question asks about invoices rather than checks (see §4.3 of the plan:
 *        a check's invoices do not always sum to it — 4,140 of 4,218 do, and all 78
 *        disagreements fall short — so an invoice-subject answer would be a
 *        reconciliation statement missing its population).
 *     3. The date range lies wholly outside the extract's own window. This one
 *        matters most: answering it would produce **zero rows, "no checks found"**,
 *        which is indistinguishable from a real empty month. The refusal names the
 *        window instead.
 *     4. The filters kept no rows. That is a legitimate answer — a month with no
 *        spend is a fact — so it is an answer with `value: null` and a stated basis,
 *        never a model-authored guess.
 *
 * ── ★ THE KEY IS NOT IN THIS FILE, AND MUST NEVER BE
 *
 *   `AI_API_KEY` is read only by `ai/model.ts`, and it is never returned, logged, or
 *   prefixed with `VITE_` — a `VITE_`-prefixed name is inlined into the browser
 *   bundle at build time, which would publish the key to every reader of the app.
 *   `GET /api/ai/status` exists so the client can decide whether to enable the
 *   control without ever seeing the credential.
 */

/** What the model is told is *not* about this register, when it says so. */
const ANSWERABLE = [
  'How many checks were paid in July?',
  'What was the highest check paid in July?',
  'What was the average check paid in July?',
  'What did we pay PERFECTION EQUIPMENT CO.?',
  'What was check 63409 for?',
];

/** `CHECK_ID` — the only durable identity this register has. */
const checkId = z.number().int().openapi({
  description:
    '`CHECK_ID` — **the identity.** `CHECK_NUMBER` is not unique across the ledger, so every link and ' +
    'every sample row carries the id, and the `?check=` arrival on the register takes *this* value, ' +
    'not the number it prints.',
});

/** The evidence rows a reader can click through to the register. */
const sampleRow = z
  .object({
    id: checkId,
    number: textReq('`CHECK_NUMBER` — what is printed on the check and shown in the table. Not an identity.'),
    date: text('`CHECK_DATE`, as `YYYY-MM-DD`.'),
    amount: real('The payment amount. The figure every reduction here is taken over.'),
    vendor: text('`VENDOR_NAME` — the payee as the ledger spells it.'),
  })
  .openapi('AiSampleRow');

export function registerAi(api: Api): void {
  /**
   * Whether the assistant is usable, so the control can be rendered disabled with a
   * reason rather than appearing to work and then failing.
   *
   * Guards on a session like every other register route. It discloses configuration,
   * and while none of it is secret, an anonymous caller has no business enumerating a
   * deployment's model and endpoint.
   */
  api.route({
    method: 'get',
    path: '/api/ai/status',
    operationId: 'ai_status',
    summary: 'Whether the natural-language assistant is configured, and on what',
    description:
      'Reports whether a model is configured and reachable-by-configuration, so the client can render the ' +
      'control disabled with a reason instead of offering a feature that will fail.\n\n' +
      '**The API key is never returned** — only whether one is present (`hasKey`). The key is server-side ' +
      'configuration and is never exposed to a browser.\n\n' +
      'When `enabled` is false, `reason` names the environment variable that is missing or the switch that ' +
      'is off, so an operator does not have to read server logs to find out which one.\n\n' +
      'This endpoint does **not** call the provider. A configured assistant that is unreachable today still ' +
      'reports `enabled: true`, and the failure surfaces on the first question as `503 AI_UNAVAILABLE`. ' +
      'Making this endpoint probe the provider would mean a status check that costs money and can time out.',
    tags: ['AI'],
    response: z
      .object({
        enabled: z.boolean().openapi({
          description:
            'Whether every setting the assistant needs is present. **Configuration, not reachability** — ' +
              'see the note above.',
        }),
        reason: text(
          'Why the assistant is disabled: the missing variable names, or that `AI_ENABLED` is off. ' +
            '`null` when `enabled` is true.',
        ),
        model: text('The configured model name. Null when unset.'),
        endpoint: text('The configured base URL. Null when unset. Never contains the key.'),
        hasKey: z.boolean().openapi({ description: 'Whether a key is configured. **Never the key itself.**' }),
        authStyle: textReq('How the credential is sent: `bearer`, `api-key`, or `none`.'),
        timeoutMs: z.number().int().openapi({ description: 'How long a question may take before `503`.' }),
        maxTokens: z.number().int().openapi({
          description:
            'The output budget sent to the provider. **This matters more than it looks:** the configured ' +
              'model is a *reasoning* model, and it spends this budget on reasoning before producing an ' +
              'answer. Too small a budget returns HTTP 200 with an empty answer rather than an error.',
        }),
        phrase: z.boolean().openapi({
          description:
            'Whether a second, optional call writes a lead-in sentence in prose. A phrasing that contains ' +
              'any digit is discarded, so the prose can never disagree with the arithmetic.',
        }),
      })
      .openapi('AiStatus'),
    errors: [401, 500],
    handler: async (ctx) => {
      await requireActor(ctx.req);
      const s = aiStatus();
      return {
        enabled: s.enabled,
        reason: s.reason ?? null,
        model: s.model ?? null,
        endpoint: s.endpoint ?? null,
        hasKey: s.hasKey,
        authStyle: s.authStyle,
        timeoutMs: s.timeoutMs,
        maxTokens: s.maxTokens,
        phrase: s.phrase,
      };
    },
  });

  /**
   * One question, answered from the scoped checks register.
   *
   * ★ THE SCOPE IS THE CALLER'S OWN, TAKEN FROM THEIR SESSION — never from the
   *   request body. A client-supplied id list would let the caller define the
   *   answer's basis, and the basis line would then be a restatement of something
   *   the caller said rather than a measurement. Because the server derives the
   *   population from the session's organization, the basis it reports *is* the
   *   population it used.
   */
  api.route({
    method: 'post',
    path: '/api/ai/ask',
    operationId: 'ai_ask',
    summary: 'Ask a question about the checks register in plain English',
    description:
      'A natural-language question is turned into a **closed-vocabulary intent** — one subject, one ' +
      'aggregate, and a handful of filters — which is then executed server-side over the register.\n\n' +
      '**The model does not do arithmetic and is never shown a row.** It chooses which reduction to ' +
      'perform; this server performs it. That is deliberate: a language model summing dollar figures is ' +
      'usually right, so a demo passes and a wrong answer is indistinguishable from a right one.\n\n' +
      '**The population is the caller\'s own scope, applied server-side.** This matters enormously here. ' +
      'Measured on this extract, for *"the highest check paid in July"*:\n\n' +
      '| population | July checks | highest |\n' +
      '|---|---|---|\n' +
      '| every check in the file | 3,261 | $18,043,056.47 |\n' +
      '| **the scope this caller sees** | **22** | **$778,481.55** |\n\n' +
      'Both are correct answers to what was typed, and they differ by 23×. So every answer states its ' +
      'basis and the UI always renders it — the count is the conditional part, never the disclosure.\n\n' +
      '**The population is *not* filtered on the page before the question is asked.** The page\'s search ' +
      'box narrows the table, and a reader can reasonably expect their question to apply to what they ' +
      'are looking at. It does not: it applies to the register. The basis line says the register\'s own ' +
      'counts, so the two can be told apart, and the answer never claims the table\'s rows.\n\n' +
      '**Refusals are answers.** A question about invoices, a date range outside the extract, or a ' +
      'question that is not about this register returns `200` with `kind: "refused"` and a sentence ' +
      'saying why. An empty result is likewise a `200` with `value: null` and a stated basis — a month ' +
      'with no spend is a fact about the data, not a failure.\n\n' +
      '`503 AI_UNAVAILABLE` means the assistant itself failed: unconfigured, refused by the provider, ' +
      'unreachable, timed out, or answered with something that is not a usable intent. It is deliberately ' +
      'distinct from `503 DB_UNAVAILABLE` so an operator knows which dependency to look at.',
    tags: ['AI'],
    // ★ THE DEFAULT FOR A POST IS 201, AND THIS ROUTE MUST BE 200. It creates
    //   nothing; it reads the register and answers. Left at the default, the document
    //   would describe a creation and a client would reasonably treat a re-ask as a
    //   duplicate submission.
    status: 200,
    body: z
      .object({
        question: z
          .string()
          .min(1)
          .max(2000)
          .openapi({
            description:
              'The reader\'s question, verbatim. **Not parsed here:** this bound is an abuse guard at a ' +
              'generous absolute limit, and the assistant\'s own, tighter limit (`AI_MAX_QUESTION_CHARS`) ' +
              'is checked in the handler so the refusal can name the actual figure. A schema bound set to ' +
              'the real limit would answer first and the handler\'s message would be dead code.',
          }),
      })
      .strict()
      .openapi('AiAskBody'),
    response: z
      .object({
        kind: z.enum(['answer', 'refused']).openapi({
          description:
            '`answer` carries a computed figure (which may be `null` when the filters kept no rows, ' +
              'or the reduction has no answer over an empty set). `refused` carries a reason and no ' +
              'figure at all.',
        }),
        question: textReq('The question as received, echoed back so a screenshot is self-contained.'),
        refused: z
          .object({
            reason: textReq(
              'Why this cannot be answered, in a sentence written for the reader — naming the extract\'s ' +
                'window, or why invoices are out of scope, rather than a code.',
            ),
            answerable: z.array(z.string()).openapi({
              description: 'Examples of questions this assistant *can* answer, so a refusal is a way forward.',
            }),
          })
          // Named, then made nullable, so the component keeps the name and the
          // `null` is a wrapper around the reference rather than an anonymous inline.
          .openapi('AiRefusal')
          .nullable(),
        intent: z
          .object({
            subject: textReq('Always `check` in v1.'),
            aggregate: textReq('One of `max`, `min`, `avg`, `sum`, `count`.'),
            dateFrom: text('The inclusive lower bound the model read, as `YYYY-MM-DD`.'),
            dateTo: text('The inclusive upper bound.'),
            vendor: text('A payee name to match, as a case-insensitive substring.'),
            checkNumber: text('A check number to match exactly.'),
            amountMin: real('A lower bound on the amount.'),
            amountMax: real('An upper bound on the amount.'),
            limit: int('How many rows the question asked to see. Bounds display only — never the reduction.'),
          })
          .nullable()
          .openapi({
            description:
              'The intent the model produced, returned for transparency so a surprising answer can be ' +
              'traced to the reading that produced it. This object contains **no figure** — the vocabulary ' +
              'has no numeric field for one that is not a filter bound.',
          }),
        unit: text('`money` or `count`. A bare number cannot say which, so the client is told.'),
        value: real(
          'The computed figure: money for `max`/`min`/`avg`/`sum`, a count for `count`. **`null` means the ' +
            'question cannot be answered over this set** — the average of no checks is not `$0.00`, and ' +
            'rendering a zero would be a claim about the data. A `sum` or `count` of no rows *is* genuinely ' +
            '`0`, and is returned as one.',
        ),
        rows: z
          .object({
            matched: z.number().int().openapi({
              description:
                'How many scoped checks the filters kept. **Not** the population the reduction ran over — ' +
                  'that is `basis.considered` — and not the register, which is `basis.total`.',
            }),
            sample: z.array(sampleRow).openapi({
              description:
                'The rows to show, ordered by the aggregate the question asked for: largest first for a ' +
                  '`max`, smallest first for a `min`, newest first otherwise. **Bounded by `AI_SAMPLE_ROWS` ' +
                  'and never the basis of `value`** — the reduction ran over every matched row.',
            }),
          })
          .openapi('AiRows'),
        basis: z
          .object({
            considered: z.number().int().openapi({
              description:
                '**The rows the figure was computed over.** Measured from the payload, never restated from ' +
                  'the scope control. This is the number the answer is actually about.',
            }),
            inScope: z.number().int().openapi({
              description:
                'The caller\'s scoped population, before the question\'s own filters. The middle ' +
                  'denominator: `considered` of `inScope` of `total`.',
            }),
            total: z.number().int().openapi({
              description: 'Every check in the extract, before the scope narrowed it. The register\'s own size.',
            }),
            withoutAccounts: z.number().int().openapi({
              description:
                'Checks carrying no account at all, so the scope could not be evaluated against them. ' +
                  '**Not the same as `excluded`**: these are rows the scope cannot speak about, not rows it ' +
                  'removed. Kept apart because collapsing them would invent a rule that deleted rows the ' +
                  'scope never saw — the distinction `invoices.json`\'s own `.scope` block already makes.',
            }),
            excluded: z.number().int().openapi({
              description: 'Checks that had an account to test and failed the scope.',
            }),
            scope: z
              .object({
                fund: textReq('The fund the answer was restricted to. The caller\'s own, from their session.'),
                programs: z.array(z.string()).openapi({
                  description:
                    'The programs the answer was restricted to. **Empty means the fund alone is the rule** ' +
                      '— not "no programs" — which is the same reading the register\'s own scope control takes.',
                }),
              })
              .openapi('AiBasisScope'),
            window: z
              .object({ from: textReq('The earliest check date in the extract.'), to: textReq('The latest.') })
              .openapi({
                description:
                  'The extract\'s own bounds, read from the file rather than from the request, so the ' +
                  'disclosure cannot describe a window the data does not have.',
              }),
            source: textReq('Which artefact answered. One fiscal year of an extract — not live Oracle.'),
            filters: z.array(z.string()).openapi({
              description:
                'The filters that were actually applied, named. Built in the same place as the predicate ' +
                  'that applied them, so the answer cannot state a filter it did not use.',
            }),
            message: textReq(
              'The basis line, already composed — *"22 of 65 checks in scope · of 4,218 read · ' +
                'checks.json · 2026-07-01 .. 2026-08-11"*. Rendered unconditionally, because a disclosure ' +
                'gated on "did this cost anything" is invisible in exactly the case it is needed. The ' +
                'client may render it as-is or rebuild it from the figures above.',
            ),
          })
          .openapi('AiBasis'),
        model: z
          .object({
            name: textReq('The model that produced the intent.'),
            ms: z.number().int().openapi({ description: 'How long the intent call took, and the phrasing call with it.' }),
            attempts: z.number().int().openapi({
              description:
                'How many times the provider was asked. **Always 1 or 2.** The model configured in ' +
                '`.env` is a reasoning model, so it can spend the whole budget on reasoning and return ' +
                '`finish_reason: "length"` with no answer; `ask` retries once at double the budget and ' +
                'only for that case. A figure of 2 is the explanation for an unusually slow answer.',
            }),
            maxTokens: z.number().int().openapi({
              description: 'The budget the answer was finally produced under — `AI_MAX_TOKENS`, or double it after a retry.',
            }),
            note: text(
              'An optional prose lead-in, when `AI_PHRASE=1`. **Guaranteed to contain no digit** — a ' +
                'phrasing that contains one is discarded and logged, because a sentence able to state a ' +
                'figure is a sentence able to contradict the figures beside it. Null when off, absent, or ' +
                'discarded.',
            ),
          })
          .openapi('AiModelUsage')
          .nullable(),
      })
      .openapi('AiAnswer'),
    errors: [400, 401, 503],
    handler: async (ctx) => {
      const actor = await requireActor(ctx.req);
      const question = ctx.body.question.trim();
      const ai = config.ai;

      const refused = (reason: string) => ({
        kind: 'refused' as const,
        question,
        refused: { reason, answerable: ANSWERABLE },
        intent: null,
        unit: null,
        value: null,
        rows: { matched: 0, sample: [] },
        basis: null,
        model: null,
      });

      // ★ AN EMPTY QUESTION IS REFUSED IN WORDS, NOT ANSWERED WITH A GUESS.
      //   Whitespace passes `min(1)` on the wire and is empty to a reader. Sending it
      //   to the model spends money to be told the model cannot help.
      if (question === '') throw AppError.badRequest('Ask a question about the checks register.');

      // The assistant's own limit, checked here rather than in the schema so the
      // message can name the real figure — see the body description.
      if (question.length > ai.maxQuestionChars) {
        throw AppError.badRequest(
          `That question is ${question.length} characters, and the assistant accepts up to ` +
            `${ai.maxQuestionChars}. Shorten it, or ask it in two parts.`,
          { length: question.length, limit: ai.maxQuestionChars },
        );
      }

      // The caller's own tenant scope. Never from the body.
      const scope: AiScope = {
        fund: actor.organization.fund,
        programs: actor.organization.programs,
      };
      const population = narrow(scope);

      // ── 1. Ask the model for an intent. The prompt carries the extract's window
      //      (so the model can resolve "July" against the right year) and nothing
      //      else about the data: no rows, no totals, no sample.
      const reply = await ask(buildSystemPrompt(population.window), question, { operationId: 'ai_ask' });

      const parsed = parseIntent(reply.text);
      if (!parsed.ok) {
        // ★ 503 RATHER THAN 400, AND THAT IS A DELIBERATE READING OF THE TWO.
        //   The caller's request was well formed; what failed is the assistant's
        //   answer. Answering 400 would tell a reader with a perfectly reasonable
        //   question that their question was bad, and would send them off rewriting
        //   it to fix a prompt bug on this side. `VALIDATION_FAILED` describes a body
        //   the schema refused, and this body was fine.
        throw AppError.aiUnavailable(
          `The assistant answered, but not in a shape this register can act on. ${parsed.problem}`,
          { ...(typeof parsed.detail === 'object' && parsed.detail !== null ? parsed.detail : {}), operationId: 'ai_ask' },
        );
      }

      const intent = parsed.intent;

      // ── 2. A refusal the model can state outright.
      if (!intent.supported) return refused(intent.reason);

      // ── 3. Invoices are out of v1, and the refusal says why rather than "unsupported".
      if (intent.subject !== 'check') {
        return refused(
          'This assistant answers questions about checks. It cannot answer questions about invoices: a ' +
            'check\'s invoices do not always add up to it — on this extract 4,140 of 4,218 do, and all 78 ' +
            'that do not fall short — so an invoice count and a check count describe different things. ' +
            'The invoices register is at /spend/invoices.',
        );
      }

      // ── 4. A range wholly outside the extract is refused in words naming the window.
      //      ★ THIS IS THE REFUSAL THAT MATTERS. Answering it would return zero rows and
      //        "no checks found", which is indistinguishable from a genuinely empty
      //        month — the class of silent wrongness this codebase keeps fixing.
      const outside = describeOutsideWindow(intent, population.window);
      if (outside !== null) return refused(outside);

      // ── ★ 4b. ONE NORMALISATION, MEASURED RATHER THAN ASSUMED.
      //        `"What was check 63409 for?"` asked three times at `temperature: 0` came
      //        back as `count` once (a figure of 1) and as the amount twice. The prompt
      //        now states the rule, and this is the rule *enforced* — because the whole
      //        point of the split is that the model's answer is an input this server
      //        validates, not an output it repeats. A `count` over a single named check
      //        is a legible answer to a slightly different question; an amount is the
      //        answer to the question asked. `sum` over one row is that row's amount, so
      //        the substitution is exact rather than approximate.
      const effective = normaliseAggregate(intent);
      const result = run(population, effective.aggregate, effective, intent.limit);

      // ── ★ TWO BASES, AND THEY ARE NOT INTERCHANGEABLE.
      //        `considered` is measured **over the returned payload** — the rows the
      //        filters kept, which is what the figure is actually about. `scopeKept` is
      //        what the *scope* kept, and it is the second half of "22 of 65". Reporting
      //        the scope count as the considered count would print "65 checks matched"
      //        over a reduction taken on 22 of them: two aggregates, different rows,
      //        one of them silently wrong. Neither is restated from the caller's scope
      //        control — the scope arrives from the session, and both counts are
      //        measured off `run`'s own output.
      const considered = result.matched;
      const scopeKept = result.considered;
      const sample = result.rows.slice(0, Math.max(1, ai.sampleRows));

      // ── 6. The optional prose lead-in. ★ A failure here must never fail the answer:
      //      the figures are already computed and correct, and losing them because a
      //      cosmetic second call timed out would be trading the answer for the trimmings.
      let note: string | null = null;
      let ms = reply.ms;
      if (ai.phrase && result.matched > 0) {
        try {
          const phrase = await ask(
            buildPhrasePrompt(),
            // ★ THE FILTER LABELS, NOT A HAND-WRITTEN DESCRIPTION OF THEM. Passing three
            //   booleans ("a date range was applied", "a payee was matched") told the
            //   model nothing about a check-number filter, and it wrote "with no payee or
            //   period filters applied" over a question that had one. The labels come off
            //   the same fused object the predicate used, so a filter added to `Filters`
            //   reaches this prompt without anybody remembering to add a flag.
            phraseQuestion(question, effective.aggregate, result.applied),
            { operationId: 'ai_ask_phrase' },
          );
          ms += phrase.ms;
          // ★ PARSE THE SENTENCE OUT, THEN GUARD IT. `ask` sends
          //   `response_format: { type: 'json_object' }` unconditionally, so the reply is
          //   an envelope and the sentence is one member of it. The digit rule is checked
          //   against the sentence itself rather than the raw reply, because the raw reply
          //   is mostly punctuation and a key — and it is the member a reader would see.
          const sentence = readSentence(phrase.text);
          if (sentence === null) {
            console.warn(
              '[ai] the phrasing call returned no `sentence` member; the figures line still renders. ' +
                `Received: ${JSON.stringify(phrase.text.slice(0, 200))}`,
            );
          } else if (/\d/.test(sentence)) {
            // ★ THE GUARANTEE, ENFORCED RATHER THAN ASKED FOR. A phrasing call that
            //   writes "the highest was about $780,000" would be a second, unaudited
            //   source for a figure the sentence beside it states exactly. Forbidding
            //   digits is the cheapest way to make disagreement impossible: the model
            //   cannot contradict a number it is unable to write.
            console.warn(
              '[ai] discarded a phrasing that contained a digit; the figures line still renders. ' +
                `Received: ${JSON.stringify(sentence.slice(0, 200))}`,
            );
          } else if (sentence.trim() !== '') {
            note = sentence.trim().slice(0, 240);
          }
        } catch (e) {
          console.warn(`[ai] the phrasing call failed and was skipped: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      const window = `${population.window.from} .. ${population.window.to}`;
      const scopeText =
        scope.programs.length === 0
          ? `Fund ${scope.fund} · all programs`
          : `Fund ${scope.fund} · program ${scope.programs.join('/')}`;

      return {
        kind: 'answer' as const,
        question,
        refused: null,
        intent: {
          subject: intent.subject,
          aggregate: effective.aggregate,
          dateFrom: intent.dateFrom ?? null,
          dateTo: intent.dateTo ?? null,
          vendor: intent.vendor ?? null,
          checkNumber: intent.checkNumber ?? null,
          amountMin: intent.amountMin ?? null,
          amountMax: intent.amountMax ?? null,
          limit: intent.limit,
        },
        unit: result.aggregate === 'count' ? 'count' : 'money',
        value: result.value,
        rows: { matched: result.matched, sample },
        basis: {
          considered,
          inScope: scopeKept,
          total: population.read,
          withoutAccounts: population.withoutAccounts,
          excluded: population.excluded,
          scope: { fund: scope.fund, programs: scope.programs },
          window: { from: population.window.from, to: population.window.to },
          source: 'checks.json',
          filters: result.applied,
          // ★ COMPOSED HERE RATHER THAN IN THE CLIENT. The count is the conditional
          //   part of this sentence; the sentence itself is not. A disclosure that
          //   renders only when something was removed is invisible in exactly the case
          //   it is needed — and because the narrowing happened upstream of the answer,
          //   "something was removed" is not this route's to report.
          message:
            `${considered.toLocaleString('en-US')} ${considered === 1 ? 'check' : 'checks'} matched · ` +
            `of ${scopeKept.toLocaleString('en-US')} in scope (${scopeText}) · ` +
            `of ${population.read.toLocaleString('en-US')} read · ` +
            `checks.json · ${window}`,
        },
        model: { name: ai.model ?? 'unknown', ms, attempts: reply.attempts, maxTokens: reply.maxTokens, note },
      };
    },
  });
}

/**
 * The aggregate actually run, when the model's choice is one this register will not run.
 *
 * ★ MEASURED, NOT DEFENSIVE. Asked `"What was check 63409 for?"` three times at
 *   `temperature: 0`, the model chose `count` once — yielding a figure of **1** — and the
 *   amount twice. That is a real answer to a slightly different question, and a register
 *   whose answer to the same question moves between runs is worse than one that refuses.
 *
 *   `sum` over a single matched row *is* that row's amount, so the substitution is exact.
 *   The cost is that "how many checks carry number 63409" would be answered with the
 *   amount — a question nobody asks, and one the plural filters (payee, dates) exist for.
 *
 *   The rule is also stated in the prompt. Stating it and enforcing it are different jobs:
 *   the prompt is asked for, this is what happens.
 */
function normaliseAggregate(intent: SupportedIntent): SupportedIntent {
  if (intent.checkNumber !== undefined && intent.aggregate === 'count') {
    console.warn(
      `[ai] the model chose "count" for a question naming check ${intent.checkNumber}. ` +
        'Running it as "sum", which is that check\'s amount.',
    );
    return { ...intent, aggregate: 'sum' };
  }
  return intent;
}

/**
 * A sentence naming the window, when the question's range cannot intersect it.
 *
 * ★ ONLY A WHOLLY-OUTSIDE RANGE IS REFUSED. A range that straddles the window's edge
 *   is a legitimate filter — the reader asked for "the last 90 days" and the extract
 *   covers part of it — so it is answered, and the basis line's window is what tells
 *   the reader which part. Returning a refusal there would withhold an answer the
 *   data supports; returning nothing about it would let a clipped answer look whole.
 */
function describeOutsideWindow(
  intent: SupportedIntent,
  window: { from: string; to: string },
): string | null {
  const from = intent.dateFrom;
  const to = intent.dateTo;
  if (from === undefined && to === undefined) return null;

  // An unbounded end cannot be outside on that side.
  const endsBefore = to !== undefined && window.from !== '' && to < window.from;
  const startsAfter = from !== undefined && window.to !== '' && from > window.to;
  if (!endsBefore && !startsAfter) return null;

  const asked = from === to ? `${from}` : `${from ?? 'the beginning'} to ${to ?? 'now'}`;
  return (
    `The extract covers ${window.from} to ${window.to}, so there is nothing for ${asked}. ` +
    `That is a bound on the data rather than a finding about it — ask within the window and this ` +
    `register can answer.`
  );
}

/**
 * The prompt for the optional prose lead-in.
 *
 * ★ ITS OWN PROMPT, WITH THE DIGIT RULE STATED. Asking the intent call for prose as
 *   well would put a sentence in the same reply as the JSON, and a model that
 *   editorialises is a model that has started writing figures.
 */
function buildPhrasePrompt(): string {
  return [
    'You are writing ONE short lead-in sentence for a financial register screen.',
    '',
    'Rules, all of them absolute:',
    '- Write no digits at all. Not one. No numerals, no "$", no percentages, no years.',
    '- Do not state, estimate, round, or characterise any amount, count, or date.',
    '- One sentence, at most 18 words.',
    '- An empty string is a valid answer when the rule above cannot be met.',
    '',
    'This call is in JSON mode, so reply with exactly one object and nothing else:',
    '{ "sentence": "<your sentence>" }',
    '',
    'The figures are already printed beside your sentence by the application. Your only job is to',
    'introduce them in words. If you cannot write the sentence without a digit, return an empty',
    '`sentence`.',
  ].join('\n');
}

/**
 * The `sentence` member of the phrasing reply, or `null` when there is not one.
 *
 * ★ ONE LOOSE PARSE, NO SCHEMA. This runs on the cosmetic half of the response: a
 *   shape the model got wrong should cost the reader a lead-in sentence, never the
 *   answer beside it. Anything that is not a usable string is `null`, which the caller
 *   treats as "no prose" rather than as an error.
 */
function readSentence(reply: string): string | null {
  const first = reply.indexOf('{');
  const last = reply.lastIndexOf('}');
  if (first === -1 || last <= first) return null;
  try {
    const parsed: unknown = JSON.parse(reply.slice(first, last + 1));
    if (parsed === null || typeof parsed !== 'object') return null;
    const value = (parsed as Record<string, unknown>)['sentence'];
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/** What the phrasing call is asked about — still no rows and no figures. */
function phraseQuestion(question: string, aggregate: string, applied: string[]): string {
  return [
    `The reader asked: ${question}`,
    `What was measured: the ${aggregate} over a set of payment checks.`,
    applied.length === 0
      ? 'Filters applied to the set: none.'
      : `Filters applied to the set: ${applied.join('; ')}.`,
    '',
    'Write the lead-in sentence.',
  ].join('\n');
}
