import { sessionHeaders } from './session';

/**
 * The assistant's two endpoints: whether it is configured, and one question
 * answered from the checks register.
 *
 * ── WHAT THIS MODULE IS NOT ALLOWED TO DO
 *
 * It does not compute anything. Every figure in an answer — the value, the count
 * of rows the filters kept, the population the reduction ran over — arrives
 * already computed, from a server that read the rows itself. This module's whole
 * job is to carry those integers to the component and to keep three facts apart:
 *
 *   1. **The value**, which is `null` when the question cannot be answered over
 *      the set (the average of no checks is not `$0.00`), and which means
 *      something different for a count than for money — hence {@link unit}.
 *   2. **`rows.matched`**, the scoped checks the question's own filters kept.
 *   3. **`basis`**, the population the reduction actually ran over. `considered`
 *      of `inScope` of `total` — three denominators, and the answer is only
 *      honest if the reader can see all three.
 *
 * ── ★ WHY `null` AND `0` ARE KEPT APART ON THE STATUS READ
 *
 * {@link loadAssistantStatus} answers `null` when the read **failed** and an
 * object with `enabled: false` when the server said the assistant is off. A
 * component that rendered a failed read as "the assistant is switched off" would
 * disable the control and put a reason in its tooltip that the server never gave
 * — and the reader would have no way to tell a missing configuration from a
 * broken request. The caller is required to say which, in words.
 */

/** `GET /api/ai/status`, once `{ data: … }` is stripped. */
export interface AssistantStatus {
  /** Every setting the assistant needs is present. **Configuration, not reachability.** */
  enabled: boolean;
  /** Why not, naming the variable. `null` when enabled. */
  reason: string | null;
  model: string | null;
  /** Base URL only. The key is never sent to a browser, and never can be. */
  endpoint: string | null;
  hasKey: boolean;
  authStyle: string;
  /** How long a question may take before the server answers `503`. */
  timeoutMs: number;
  /**
   * The provider's output budget. Worth surfacing: the configured model is a
   * *reasoning* model, so it can spend the whole budget thinking and return an
   * empty answer rather than an error.
   */
  maxTokens: number;
  /** Whether a second call writes a prose lead-in. Guaranteed digit-free. */
  phrase: boolean;
}

/** One evidence row, linkable to the register by its identity. */
export interface AssistantSample {
  /** `CHECK_ID` — **the identity**, and what `?check=` on the register takes. */
  id: number;
  /** What is printed on the check. Shown, matched on, never used as a key. */
  number: string;
  date: string | null;
  amount: number | null;
  vendor: string | null;
}

/**
 * The population the figure was computed over, in the server's own words.
 *
 * Three denominators, kept apart on purpose: `total` is the register before the
 * scope, `inScope` after it, `considered` after the question's own filters. The
 * scope is a *join* (a check is in scope when an invoice it paid has an account
 * in the caller's fund and programs), so `withoutAccounts` names the checks the
 * scope could not speak about at all — which is not the same as `excluded`, the
 * checks it tested and removed.
 */
export interface AssistantBasis {
  considered: number;
  inScope: number;
  total: number;
  withoutAccounts: number;
  excluded: number;
  scope: { fund: string; programs: string[] };
  /** Read from the extract, never from the request. */
  window: { from: string; to: string };
  source: string;
  /** The filters actually applied, named where they were applied. */
  filters: string[];
  /** The basis line, already composed by the server. Rendered unconditionally. */
  message: string;
}

/**
 * What the model understood — returned for transparency, and carrying **no
 * figure**, because the vocabulary has no numeric field for one that is not a
 * filter bound.
 */
export interface AssistantIntent {
  subject: string;
  aggregate: string;
  dateFrom: string | null;
  dateTo: string | null;
  vendor: string | null;
  checkNumber: string | null;
  amountMin: number | null;
  amountMax: number | null;
  limit: number | null;
}

/** How the answer was produced, so a slow one is explainable. */
export interface AssistantModel {
  name: string;
  ms: number;
  /** Always 1 or 2. A `2` is a retry after the reasoning model exhausted its budget. */
  attempts: number;
  maxTokens: number;
  /** Prose lead-in, when `AI_PHRASE=1`. **Guaranteed to contain no digit.** */
  note: string | null;
}

/**
 * One answer.
 *
 * `kind: 'refused'` is a real outcome and not an error: the data or the
 * vocabulary genuinely cannot answer the question — it is about invoices, or a
 * date range outside the extract, or not about this register at all — and the
 * refusal is a sentence naming which.
 */
export interface AssistantAnswer {
  kind: 'answer' | 'refused';
  question: string;
  refused: { reason: string; answerable: string[] } | null;
  intent: AssistantIntent | null;
  /**
   * `'money'` or `'count'`. **A bare number cannot say which** — `1` is a fine
   * count and a nonsense check amount — so the unit is always rendered beside the
   * value.
   */
  unit: 'money' | 'count' | null;
  /**
   * The figure. **`null` means the question cannot be answered over this set** —
   * the average of no checks is not `$0.00`. A `sum` or `count` over no rows *is*
   * genuinely `0`, and arrives as one.
   */
  value: number | null;
  rows: { matched: number; sample: AssistantSample[] };
  /** `null` only on a refusal. Never conditionally absent on an answer. */
  basis: AssistantBasis | null;
  model: AssistantModel | null;
}

const API = '/api/ai';

/** The reason a request was refused, in the words the server chose. */
async function readError(res: Response): Promise<Error> {
  let detail = `HTTP ${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    if (body?.error?.message) detail = body.error.message;
  } catch {
    /* The status line stands. A body that is not JSON is not worth failing over twice. */
  }
  return new Error(detail);
}

/**
 * Whether the assistant is configured, so the control can be rendered with a
 * reason rather than appearing to work and then failing.
 *
 * **`null` means the read failed, and `enabled: false` means the server said the
 * assistant is off.** They are not interchangeable — see the module note.
 */
export async function loadAssistantStatus(signal?: AbortSignal): Promise<AssistantStatus | null> {
  let res: Response;
  try {
    res = await fetch(`${API}/status`, { headers: sessionHeaders(), signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
  if (!res.ok) return null;
  try {
    const body = (await res.json()) as { data?: AssistantStatus };
    const status = body?.data;
    return status && typeof status.enabled === 'boolean' ? status : null;
  } catch {
    return null;
  }
}

/**
 * Ask one question, and answer the parsed payload.
 *
 * A non-2xx **throws** rather than answering a shape the component would have to
 * invent a meaning for: `503` means the assistant itself failed (unconfigured,
 * unreachable, timed out, or answered with something that is not a usable
 * intent), and the server's own sentence is the only useful thing to show. A
 * `400` says the question was rejected before any model call. Neither is a
 * refusal — a refusal is a `200`.
 */
export async function askAssistant(
  question: string,
  signal?: AbortSignal,
): Promise<AssistantAnswer> {
  const res = await fetch(`${API}/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...sessionHeaders() },
    body: JSON.stringify({ question }),
    signal,
  });
  if (!res.ok) throw await readError(res);
  const body = (await res.json()) as { data?: AssistantAnswer };
  const answer = body?.data;
  if (!answer || (answer.kind !== 'answer' && answer.kind !== 'refused')) {
    throw new Error('The assistant answered, but its response did not contain an answer.');
  }
  return answer;
}
