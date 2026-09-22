import { config } from '../config/env.js';
import { AppError } from '../http/errors.js';

/**
 * The one place this server talks to a language model.
 *
 * ── WHAT THIS FILE IS RESPONSIBLE FOR, AND WHAT IT IS NOT
 *
 * It sends a prompt and returns text. It does **not** decide what a question means
 * (`intent.ts`) or what a number is (`run.ts`). Keeping the three apart is what makes
 * the arithmetic testable with no network and the prompt testable with no data.
 *
 * ── ★★ THE THREE MEASUREMENTS THIS FILE IS BUILT AROUND
 *
 *   All taken against the provider configured in `.env` (`deepseek-flash`,
 *   OpenAI-compatible), 2026, three samples each.
 *
 *   1. **IT IS A REASONING MODEL, AND A SMALL BUDGET RETURNS AN EMPTY SUCCESS.**
 *      A call spends `max_tokens` on `message.reasoning_content` *before* producing
 *      `message.content`, and both count against the same budget. Measured at
 *      `max_tokens: 8`: **HTTP 200, `content: ""`, `finish_reason: "length"`,
 *      `completion_tokens_details.reasoning_tokens: 8`.** At 256 the same prompt
 *      returned the JSON and used 39 tokens of reasoning.
 *
 *      So the failure mode is not an error — it is a *successful* response carrying
 *      nothing, whose next line (`JSON.parse('')`) throws a syntax error about
 *      nothing at all. Both halves are handled here: a generous default budget
 *      (`AI_MAX_TOKENS`, 512) and an explicit branch on `finish_reason === 'length'`
 *      that says what actually happened.
 *
 *   2. **`response_format: { type: 'json_object' }` IS ACCEPTED BUT IS NOT WHAT
 *      MAKES THE JSON.** The same object came back with and without it (fenced
 *      content was never observed from this provider, but `parseIntent` strips fences
 *      anyway because several OpenAI-compatible providers always add them). It is
 *      sent because it is cheap insurance and some providers honour it strictly.
 *
 *   3. **THE ERROR BODIES ARE USEFUL AND ARE PASSED THROUGH.** A 401 is
 *      `{"error":{"message":"Authentication Fails, Your api key: ****0000 is invalid",…}}`
 *      — which already redacts the key itself, and which names the problem far better
 *      than "the assistant is unavailable". `details` carries it to the operator.
 *
 * ── ★ THE KEY IS READ HERE AND NOWHERE ELSE
 *
 * `config.ai.apiKey` is server-side configuration. It is never returned by a route,
 * never logged, and never appears in an error message: `redact()` scrubs it from
 * anything that leaves this file, so a provider that echoes the key back in an error
 * body cannot leak it to the browser through `details`.
 */

/** One message, in the shape every OpenAI-compatible endpoint takes. */
type Message = { role: 'system' | 'user'; content: string };

/** What `ask` needs to know beyond the text. */
export interface AskOptions {
  /** Passed through to the provider so a bad request is visible in its logs. */
  operationId: string;
}

/**
 * Remove the key from any string or object that is about to leave this file.
 *
 * ★ DEFENSIVE, AND HERE FOR A REASON RATHER THAN AS PARANOIA. A provider's error body
 *   is genuinely useful (`"Authentication Fails, Your api key: ****0000 is invalid"`
 *   is the sentence that tells an operator *which* key is wrong), so the body is
 *   forwarded — which means it is forwarded to a browser. Some providers echo the
 *   submitted key in full on a validation error. Redacting on the way out costs one
 *   pass and removes the whole class of leak, rather than relying on every provider
 *   behaving the way the one tested does.
 */
function redact(value: unknown): unknown {
  const key = config.ai.apiKey;
  if (key === undefined || key === '') return value;
  const scrub = (v: unknown): unknown => {
    if (typeof v === 'string') return v.split(key).join('«redacted»');
    if (Array.isArray(v)) return v.map(scrub);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, scrub(x)]));
    }
    return v;
  };
  return scrub(value);
}

/** The settings an operator can check without calling a provider. */
export interface AiStatus {
  enabled: boolean;
  reason: string | undefined;
  model: string | undefined;
  endpoint: string | undefined;
  /** Whether a key is present. Never the key. */
  hasKey: boolean;
  authStyle: string;
  timeoutMs: number;
  maxTokens: number;
  phrase: boolean;
}

export function aiStatus(): AiStatus {
  const ai = config.ai;
  return {
    enabled: ai.enabled,
    reason: ai.reason,
    model: ai.model,
    endpoint: ai.endpoint,
    hasKey: ai.apiKey !== undefined && ai.apiKey !== '',
    authStyle: ai.authStyle,
    timeoutMs: ai.timeoutMs,
    maxTokens: ai.maxTokens,
    phrase: ai.phrase,
  };
}

/**
 * Refuse before doing anything, when the assistant is not configured.
 *
 * The message is the config's own `reason`, which names the variable to set
 * (`"AI_ENABLED is on but AI_API_KEY is not set in the environment"`). A route that
 * answered a generic 503 instead would leave an operator reading logs to find out
 * which switch they had missed.
 */
function requireConfigured(): void {
  const ai = config.ai;
  if (!ai.enabled) {
    throw AppError.aiUnavailable(
      ai.reason ?? 'The assistant is not configured on this server.',
      { hint: 'Set AI_ENABLED=1, AI_ENDPOINT, AI_MODEL and AI_API_KEY, then restart.' },
    );
  }
}

/** The headers and URL for the configured auth style. */
function requestShape(): { url: string; headers: Record<string, string> } {
  const ai = config.ai;
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  if (ai.authStyle === 'api-key') {
    // Azure OpenAI: the key rides in `api-key`, and the API version is a query
    // parameter rather than a header or a path segment.
    if (ai.apiKey !== undefined) headers['api-key'] = ai.apiKey;
  } else if (ai.authStyle === 'bearer') {
    if (ai.apiKey !== undefined) headers.authorization = `Bearer ${ai.apiKey}`;
  }
  // `none` sends no credential at all — a local Ollama, which is a legitimate
  // deployment and the reason a blank key is only an error for the other two styles.

  const base = `${ai.endpoint}/chat/completions`;
  const url =
    ai.authStyle === 'api-key' && ai.apiVersion !== undefined
      ? `${base}?api-version=${encodeURIComponent(ai.apiVersion)}`
      : base;

  return { url, headers };
}

/** The provider's reply, narrowed to what this file reads. */
interface ChatReply {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: unknown; reasoning_content?: unknown };
  }>;
  usage?: { completion_tokens_details?: { reasoning_tokens?: number } };
  error?: { message?: string };
}

/**
 * Send a prompt, get text back — or throw an `AI_UNAVAILABLE` that says why.
 *
 * ★★ ONE RETRY, AND ONLY FOR THE BUDGET CASE — measured, not defensive.
 *   `deepseek-flash` is a reasoning model: it spends part of `max_tokens` on
 *   `reasoning_content` *before* writing anything into `content`, and how much it
 *   spends varies with the question. The same shape that succeeded at 256 tokens on
 *   one prompt returned `finish_reason: "length"` with 512 spent entirely on reasoning
 *   on another (`"What was check 63409 for?"`). So the budget is not something one
 *   default can get right: a bigger default makes every ordinary question slower and
 *   dearer, and still fails on a harder one.
 *
 *   Hence: try at `AI_MAX_TOKENS`, and if — and only if — the provider says the budget
 *   ran out, ask once more with double it (capped at `RETRY_CEILING`). A refusal, a
 *   401, a timeout or a malformed body are all *final*: retrying them would only double
 *   the wait before the same error, which is the one thing worse than the error.
 *
 * ★ EVERY FAILURE PATH THROWS THE SAME CODE WITH A DIFFERENT MESSAGE, deliberately.
 *   To the client they are one situation ("the assistant did not answer, and this is
 *   not something retrying will fix"). To an operator they are four: not configured,
 *   refused, unreachable/timed out, or answered with nothing usable. The code is
 *   coarse so the UI has one state; the message is specific so the log has an answer.
 */
export async function ask(
  system: string,
  user: string,
  options: AskOptions,
): Promise<{ text: string; usage: unknown; ms: number; attempts: number; maxTokens: number }> {
  requireConfigured();
  const ai = config.ai;

  try {
    const first = await attempt(system, user, ai.maxTokens, options);
    return { ...first, attempts: 1, maxTokens: ai.maxTokens };
  } catch (e) {
    if (!(e instanceof AppError) || !isBudgetExhausted(e)) throw e;
    const bigger = Math.min(ai.maxTokens * 2, RETRY_CEILING);
    if (bigger <= ai.maxTokens) throw e;
    console.warn(
      `[ai] ${options.operationId}: the reasoning used the whole ${ai.maxTokens}-token budget. ` +
        `Asking once more with ${bigger} tokens; set AI_MAX_TOKENS=${bigger} to skip this retry.`,
    );
    const second = await attempt(system, user, bigger, options);
    // ★ THE ATTEMPT COUNT AND THE BUDGET THAT WORKED ARE RETURNED, NOT JUST LOGGED.
    //   Measured for the same question: 2.8 s, 3.4 s and 5.1 s of provider time on three
    //   consecutive runs at `temperature: 0`. Without a count in the response there is no
    //   way to tell a slow reasoning pass from a truncated one that was retried, and
    //   "why did that take nine seconds" is the first question an operator asks.
    return { ...second, attempts: 2, maxTokens: bigger };
  }
}

/** The most the retry will ask for, however `AI_MAX_TOKENS` is set. */
const RETRY_CEILING = 4096;

/**
 * Whether a thrown `AI_UNAVAILABLE` is the "no budget left for an answer" case.
 *
 * ★ THE MARKER IS EXPLICIT RATHER THAN A STRING MATCH. Retrying on a message would
 *   mean the retry policy silently changed every time somebody edited the wording.
 */
function isBudgetExhausted(e: AppError): boolean {
  const details = e.details;
  return (
    details !== null &&
    typeof details === 'object' &&
    (details as Record<string, unknown>)['budgetExhausted'] === true
  );
}

/** One request to the provider, at a stated budget. */
async function attempt(
  system: string,
  user: string,
  maxTokens: number,
  options: AskOptions,
): Promise<{ text: string; usage: unknown; ms: number }> {
  const ai = config.ai;
  const { url, headers } = requestShape();
  const started = Date.now();

  const body = {
    model: config.ai.model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }] satisfies Message[],
    max_tokens: maxTokens,
    // Zero, because the same question must produce the same intent. A register whose
    // answers move between identical questions is worse than one that refuses them.
    //
    // ★ AND ZERO IS NOT A GUARANTEE — MEASURED, IT IS NOT. Three consecutive runs of
    //   `"What was check 63409 for?"` at `temperature: 0` produced different intents: one
    //   returned `count` (a figure of 1) and two returned the amount. So determinism is
    //   enforced downstream, where it can be: the aggregate for a question that names a
    //   specific check is normalised in `routes/ai.ts`, and the gate in `scripts/smoke.ts`
    //   asserts it. `temperature: 0` is still sent — it removes most of the drift — but
    //   nothing depends on it.
    temperature: 0,
    response_format: { type: 'json_object' },
  };

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(ai.timeoutMs),
    });
  } catch (e) {
    // A timeout arrives here as an `AbortError`/`TimeoutError` and is not
    // distinguishable in kind from a DNS failure, so both are reported with the
    // elapsed time — which is what tells an operator which of the two it was.
    const ms = Date.now() - started;
    const name = e instanceof Error ? e.name : 'unknown';
    const timedOut = name === 'TimeoutError' || name === 'AbortError';
    throw AppError.aiUnavailable(
      timedOut
        ? `The assistant did not answer within ${ai.timeoutMs} ms (${options.operationId}). ` +
          'Raise AI_TIMEOUT_MS if the provider is simply slow, or check AI_ENDPOINT.'
        : `The assistant could not be reached at ${ai.endpoint} after ${ms} ms (${options.operationId}). ` +
          'Check AI_ENDPOINT and this server\'s outbound network access.',
      { name, ms, cause: e instanceof Error ? e.message : String(e) },
    );
  }

  const text = await res.text();
  let json: ChatReply | null = null;
  try {
    json = JSON.parse(text) as ChatReply;
  } catch {
    // Deliberately not an error yet: a non-JSON body is only meaningful in
    // combination with the status, and handing both to one branch keeps the message
    // accurate instead of guessing here.
    json = null;
  }

  if (!res.ok) {
    const providerSays = json?.error?.message ?? text.slice(0, 400);
    throw AppError.aiUnavailable(
      `The model provider refused the request (HTTP ${res.status}). ${providerSays}`,
      {
        status: res.status,
        operationId: options.operationId,
        // Redacted on the way out — see `redact`.
        body: redact(json ?? text.slice(0, 400)),
      },
    );
  }

  if (json === null) {
    throw AppError.aiUnavailable(
      `The model provider answered HTTP ${res.status} with a body that is not JSON (${options.operationId}).`,
      { body: redact(text.slice(0, 400)) },
    );
  }

  const choice = json.choices?.[0];
  const content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
  const reasoning = typeof choice?.message?.reasoning_content === 'string' ? choice.message.reasoning_content : '';
  const reasoningTokens = json.usage?.completion_tokens_details?.reasoning_tokens ?? 0;
  const ms = Date.now() - started;

  // ★★ THE BRANCH THIS FILE EXISTS FOR.
  //   Measured: this provider returns HTTP 200 with `content: ""` and
  //   `finish_reason: "length"` when the reasoning consumed the whole budget. Without
  //   this branch the caller's `JSON.parse('')` throws "Unexpected end of JSON input",
  //   which names nothing and points at the parser rather than at the budget.
  if (choice?.finish_reason === 'length') {
    throw AppError.aiUnavailable(
      `The model ran out of output budget before it finished answering (${options.operationId}): ` +
        `${reasoningTokens} of the ${maxTokens} tokens went on reasoning and no answer was produced. ` +
        'Raise AI_MAX_TOKENS.',
      {
        // The marker the caller's retry reads. See `isBudgetExhausted`.
        budgetExhausted: true,
        finishReason: choice.finish_reason,
        reasoningTokens,
        maxTokens,
        reasoningLength: reasoning.length,
      },
    );
  }

  if (content.trim() === '') {
    throw AppError.aiUnavailable(
      `The model returned an empty answer (${options.operationId}, ${ms} ms, ` +
        `finish_reason "${choice?.finish_reason ?? 'absent'}").`,
      {
        budgetExhausted: true,
        finishReason: choice?.finish_reason ?? null,
        reasoningTokens,
        reasoningLength: reasoning.length,
      },
    );
  }

  // ★ THE REASONING IS RETURNED RATHER THAN DISCARDED. It is not an answer and must
  //   never be parsed as one, but when a prompt goes wrong it is the only record of
  //   what the model thought it was doing — the same reason the provider sends it.
  return { text: content, usage: json.usage ?? null, ms };
}
