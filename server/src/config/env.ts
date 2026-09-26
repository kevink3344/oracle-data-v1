import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Configuration, read once at import time.
 *
 * WHY `.env` IS PARSED BY HAND RATHER THAN WITH `dotenv`
 *   Two other scripts in this repo already parse it by hand
 *   (`build-turso-sample.mjs`, `turso-run.mjs`), because the file is CRLF on
 *   Windows and a naive split leaves a trailing `\r` that then breaks the URL
 *   parse. Three readers that behave identically is worth more than one library
 *   call, and the rule they share is simple: **an already-set environment
 *   variable wins**, so a shell or CI can override the file without editing it.
 *
 * WHY `DB_MODE` LIVES HERE
 *   Until this server existed, nothing in the repo read `DB_MODE` — it was set
 *   in `.env` and consumed by nobody. This module is now its only consumer, and
 *   it is the switch that decides whether the API talks to the local sample file
 *   or to Turso.
 */

/** `server/src/config` → repo root. */
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

/** Read the repo-root `.env` into `process.env`, without overwriting it. */
function loadDotEnv(): void {
  const file = path.join(REPO_ROOT, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    // Anchored per line, so a stray `=` inside a value cannot shift the split.
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\r\n]*)/.exec(line);
    if (!m) continue;
    const key = m[1]!;
    if (process.env[key] === undefined) {
      process.env[key] = m[2]!.replace(/^["']|["']$/g, '').trim();
    }
  }
}

loadDotEnv();

const str = (key: string): string | undefined => {
  const v = process.env[key];
  return v === undefined || v.trim() === '' ? undefined : v.trim();
};

const bool = (key: string, fallback: boolean): boolean => {
  const v = str(key)?.toLowerCase();
  if (v === undefined) return fallback;
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
};

/**
 * The three database modes, in one place.
 *
 * ★ THIS IS THE ONLY LIST. The `DB_MODE` validation below, the `DbMode` type, the
 *   OpenAPI enum on `/api/health` and `/api/meta/config`, and the smoke assertion
 *   over that endpoint all derive from it. They previously did not: the two meta
 *   schemas wrote `z.enum(['local', 'turso'])` by hand and left `oracle` out, so the
 *   published document told every consumer that the mode this server in fact
 *   supports was impossible — and the smoke check asserted the same shortened list,
 *   so it would have confirmed the omission rather than caught it.
 *
 *   Nothing failed, because a `response` schema is used to GENERATE the OpenAPI
 *   document and is not applied to the response at runtime. That is exactly what
 *   made it worth fixing: a wrong claim in a spec is not caught by running the
 *   server, and the spec is what an integrator reads.
 *
 * Order is the order the modes are offered in messages and in the generated enum:
 * the zero-config default first, then the remote option, then the extract.
 */
export const DB_MODES = ['local', 'turso', 'oracle', 'sqlserver'] as const;

export type DbMode = (typeof DB_MODES)[number];

/**
 * Connection settings for the EBS Oracle database (`DB_MODE=oracle`).
 *
 * Every value here is optional at the type level because the fields only become
 * meaningful once the mode selects them; `resolveOracle()` is what refuses to
 * return a half-built config.
 */
export interface OracleConfig {
  user: string;
  password: string;
  /** `host:port/service_name` — an EZConnect string, not a TNS alias. */
  connectString: string;
  /** Default schema for unqualified names, e.g. `APPS`. Applied as a session default. */
  schema: string | undefined;
  /** `SYSDBA` / `SYSOPER`, for the rare account that needs it. */
  privilege: string | undefined;
  connectTimeout: number;
  /** Thick mode is required for some EBS character sets and for `ORACLE_THICK_LIB_DIR`. */
  thick: boolean;
  thickLibDir: string | undefined;
  tnsAdmin: string | undefined;
  walletDir: string | undefined;
  walletPassword: string | undefined;
}

/**
 * The one account that exists before any tenant does.
 *
 * ★ WHY A BOOTSTRAP ACCOUNT IS IN A FILE AND NOT IN THE DATABASE.
 *   Creating the first organization is a chicken-and-egg problem: the endpoint
 *   that creates it is super-admin-only, and every super admin is a row inside a
 *   tenant that does not exist yet. Something has to be outside the database, and
 *   the only place that survives a restart without a migration is the environment.
 *
 *   What this is NOT: an authentication mechanism. It is a **credential for one
 *   identity**, so it answers "is this the bootstrap account?" and nothing else.
 *   Every other sign-in in the application is governed by `app_user`, and that
 *   table has no password column — see `auth/session.ts` for what that does and
 *   does not mean.
 */
export interface SuperAdminConfig {
  /** Normalised to lower case. `undefined` when unset, which disables the bootstrap account entirely. */
  email: string | undefined;
  password: string | undefined;
}

export interface DbConfig {
  mode: DbMode;
  /** The libSQL URL actually handed to the client. Empty string in oracle mode. */
  url: string;
  authToken: string | undefined;
  /** Absolute path, present only in `local` mode — used by the schema/health endpoints. */
  filePath: string | undefined;
  /** Human label for logs and the health payload. Never contains a secret. */
  label: string;
  /** Whether non-GET methods are permitted against this target. */
  allowWrites: boolean;
  /** Present only in oracle mode. */
  oracle?: OracleConfig;
  /**
   * Present only in sqlserver mode.
   *
   * ★ THE PASSWORD IS IN HERE, AND THAT IS WHY `label` EXISTS. Every log line and
   *   the health payload use `label`, which is the host plus the database name and
   *   never the credentials. Anything that prints this object whole would leak the
   *   password, so nothing does.
   */
  sqlserver?: SqlServerConfig;
}

/** Connection settings for Azure SQL (`DB_MODE=sqlserver`). */
export interface SqlServerConfig {
  server: string;
  database: string;
  user: string;
  password: string;
}

export interface Config {
  nodeEnv: string;
  isProduction: boolean;
  port: number;
  host: string;
  /** `true` = reflect any origin (dev default). Otherwise an explicit allowlist. */
  corsOrigins: true | string[];
  db: DbConfig;
  /**
   * The app-owned store — where the tables this application authors live.
   *
   * ★ SEPARATE FROM `db` ON PURPOSE. `db` is the *ledger*: the EBS tables, which
   *   under `DB_MODE=oracle` are read out of Oracle. This is where the app's own
   *   rows go (`saved_view*`, `project`, `organization`, `X_REPORT_*`). The two
   *   were the same database for the whole life of the project so far, which is
   *   exactly why conflating them went unnoticed — and why they are now two
   *   settings rather than one.
   *
   *   Why a setting and not a fourth `DB_MODE`: a mode is a *choice of one thing*,
   *   but "the ledger is Oracle and the app store is a local file" is a
   *   configuration, not a mode. Expressing it with a mode would mean `hybrid`
   *   had to ship — with its view bodies and alias quoting — before an
   *   organization could be stored. See `docs/plans/organizations.md` §7.
   */
  appDb: AppDbConfig;
  viewBuilder: ViewBuilderConfig;
  ai: AiConfig;
  superAdmin: SuperAdminConfig;
  /**
   * The half of the ledger scope that is a *deployment* decision rather than a
   * tenant setting. See `LedgerScopeConfig` for the precedence against the
   * `organization` row — it is per field, not per source.
   */
  ledgerScope: LedgerScopeConfig;
}

/**
 * The ledger scope declared in the environment file.
 *
 * ★ WHY THERE ARE TWO SOURCES, AND WHICH ONE WINS.
 *
 *   The scope already existed as a row: `organization.fund`, `.programs_json` and
 *   `.start_fy`, reached by `defaultTenant()`. These variables make a **second**
 *   source for the same three decisions, so the precedence has to be stated rather
 *   than discovered:
 *
 *     a field declared HERE  wins;
 *     a field blank or absent HERE defers to the `organization` row.
 *
 *   Per field, not per source — so an operator can pin the fund without also taking
 *   the programs away from the Organization screen. `db/derived.ts` reports every
 *   disagreement once at startup (`scopeDivergence`), and `src/index.ts` prints it.
 *   That disclosure is the whole point: the failure it prevents is a screen whose
 *   figures depend on which of the two sources a code path happened to consult, and
 *   that is invisible from outside.
 *
 *   ★ `START_YEAR` IS THE ONE FIELD THAT INVERTS THAT RULE, AND IT DOES SO ON
 *     PURPOSE. The organization row's `start_fy` is authoritative and `.env` is only
 *     the fallback, because the floor is the one field a reader can see the effect of
 *     on screen: the SQL shown beside a budget figure prints `PERIOD_YEAR >= <year>`,
 *     so a `.env` value that outranked the row would put a year on the page that no
 *     screen in the app can explain or change. The fund and the programs have no such
 *     surface — they are invisible in the rendered SQL — so they keep the declared
 *     precedence above.
 *
 * ★ `undefined` vs `[]` is load-bearing for `programs`:
 *     `undefined` — this file says nothing; the tenant row decides;
 *     `[]`        — `PROGRAM_CODE=none`: read every program under the funds.
 *   An empty string cannot express the second, because `str()` reads an empty
 *   variable as absent — which is why the sentinel is a word.
 *
 * ★ THE CEILINGS ARE NOT FILTERS. See the `.env` block and
 *   `db/row-budget.ts`: on an aggregate path a breach refuses (there a `ROWNUM`
 *   cap would change the total, not shrink it), and on a detail path it truncates
 *   and the response says by how much.
 */
export interface LedgerScopeConfig {
  /** `SEGMENT1` values. `undefined` = defer to the organization row. */
  funds: string[] | undefined;
  /** `SEGMENT3` values. `undefined` = defer; `[]` = no program filter. */
  programs: string[] | undefined;
  /**
   * Earliest `GL_BALANCES.PERIOD_YEAR` — a FALLBACK, not an override.
   *
   * ★ A FISCAL year, and `PERIOD_YEAR` is the year a period ENDS in, so
   *   `startYear: 2021` admits from `2020-07-01`.
   *
   * ★ THE ORGANIZATION ROW WINS THIS FIELD. See the note on the interface: the floor
   *   is visible in the SQL the app now shows, so it has to be the value the
   *   Organization screen can change. This applies only where no row states one.
   */
  startYear: number | undefined;
  /** Ceiling on `GL_BALANCES` rows one statement may read. */
  glBalancesMaxRecords: number;
  /** Ceiling on all ledger rows one request may read, combined. */
  allMaxRecords: number;
}

/**
 * The View Builder: an endpoint that runs SQL a person typed.
 *
 * ★ `enabled` DEFAULTS TO FALSE, in the same spirit as `ALLOW_REMOTE_WRITES`.
 *   This is the only endpoint in the API whose input is executable, and it is
 *   **unauthenticated** — the server resolves identities now, but no route under
 *   `/api/views` asks for one (see the plan's §5.4 — "admin-only by intent,
 *   unauthenticated in fact", which is still the accurate sentence). A capability
 *   like that should have to be asked for by an operator who has read the section,
 *   not inherited by anyone who starts the server.
 *
 *   When it is off the routes still exist and still appear in the OpenAPI
 *   document, and they refuse with the same 409 the writes guard uses. A route
 *   that vanished would make the spec disagree with the running server, and a
 *   404 would look like a typo in the client rather than a switch that is off.
 */
export interface ViewBuilderConfig {
  enabled: boolean;
  /**
   * Rows returned before the result is cut and reported as truncated.
   *
   * 200 because the screen says "showing 200 of …" — see the plan's §10.2. One
   * extra row is fetched internally so truncation can be *detected* rather than
   * assumed, which is the difference between an honest count and a wrong one.
   */
  maxRows: number;
  /** Wall-clock budget for one statement, in milliseconds. */
  timeoutMs: number;
  /**
   * A second cap, on the serialised response.
   *
   * The row cap bounds how many rows come back; this bounds how big they are.
   * Two hundred rows of a wide `SELECT * FROM GL_BALANCES` is still a large
   * payload, and the timeout does not help once the rows are already in memory.
   */
  maxBytes: number;
}

function viewBuilderConfig(): ViewBuilderConfig {
  const positive = (key: string, fallback: number): number => {
    const raw = Number(str(key));
    if (!Number.isFinite(raw) || raw <= 0) return fallback;
    return Math.trunc(raw);
  };

  return {
    enabled: bool('VIEW_BUILDER_ENABLED', false),
    maxRows: positive('VIEW_BUILDER_MAX_ROWS', 200),
    timeoutMs: positive('VIEW_BUILDER_TIMEOUT_MS', 5000),
    maxBytes: positive('VIEW_BUILDER_MAX_BYTES', 512 * 1024),
  };
}

/**
 * The assistant that answers plain-English questions about the checks register.
 *
 * ── WHAT IS HERE, AND WHAT IS DELIBERATELY NOT
 *
 * This block holds **no data and no logic**. It answers "is the assistant usable,
 * and if not why" plus "how do we talk to the provider". Everything that decides
 * what a question *means* lives in `ai/intent.ts`, and everything that produces a
 * number lives in `ai/run.ts` over the extract's own rows. A config module that
 * grew a query would be the wrong place for it, and more to the point it would
 * make the arithmetic untestable without a model.
 *
 * ── WHY `enabled` IS DERIVED AS WELL AS READ
 *
 * `AI_ENABLED` defaults to **false**, in the same spirit as `VIEW_BUILDER_ENABLED`
 * and `ALLOW_REMOTE_WRITES`: this is the one capability in the server that calls a
 * third party and spends money per request, so it should have to be asked for by
 * an operator who has read the section rather than inherited by whoever starts
 * the server.
 *
 * But a switch is not the whole answer, because a switch flipped on with no key
 * produces an assistant that is enabled and cannot work — the worst of both, since
 * the UI would offer the control and every question would fail. So `enabled` is
 * the switch **and** the settings the chosen auth style actually needs. `reason`
 * carries the missing names, so `/api/ai/status` can say which variable to set
 * instead of leaving an operator to guess.
 *
 * ── WHY THERE IS AN AUTH STYLE AT ALL
 *
 * The three settings a reader expects (model, endpoint, key) are not quite enough
 * for every provider, and saying so here is more honest than failing at the first
 * call: OpenAI, Groq, DeepSeek, LM Studio and Ollama all take
 * `Authorization: Bearer`; **Azure OpenAI** takes an `api-key` header and an
 * `?api-version=` parameter; **Ollama** takes no key at all, which is why a blank
 * `AI_API_KEY` is legal when `authStyle` is `none` and an error otherwise.
 *
 * ── ★ THE KEY IS NEVER `VITE_`-PREFIXED, AND THAT IS NOT STYLE
 *
 * Vite inlines every `VITE_*` variable into the browser bundle at build time. A
 * prefixed key is therefore not "exposed in production" — it is compiled into the
 * JavaScript every visitor downloads, the moment the app is built. The model is
 * called from this server and the browser never sees it, so no variable in this
 * block may carry that prefix. `docs/plans/ai-natural-language.md` §7 states the
 * rule; this comment is the copy that sits next to the code that would break it.
 */
export interface AiConfig {
  /** The switch **and** the settings being present. See the note above. */
  enabled: boolean;
  /** Why it is off, in words an operator can act on. `undefined` when it is on. */
  reason: string | undefined;
  model: string | undefined;
  /** Base URL of an OpenAI-compatible API, trailing slash stripped. */
  endpoint: string | undefined;
  /** Server-side only. Read here, never sent to the browser. */
  apiKey: string | undefined;
  authStyle: 'bearer' | 'api-key' | 'none';
  /** Azure OpenAI only — sent as `?api-version=`. */
  apiVersion: string | undefined;
  /** Wall-clock budget for one model call. On expiry the request is aborted. */
  timeoutMs: number;
  /**
   * ★ A FLOOR AS WELL AS A CAP, AND THE FLOOR IS THE LOAD-BEARING PART.
   *
   * Measured against the model configured in `.env` (DeepSeek `deepseek-flash`,
   * 2026): it is a **reasoning** model, so a call spends its budget on
   * `reasoning_content` *before* producing `content`, and both count against
   * `max_tokens`. At `max_tokens: 8` the response came back **HTTP 200 with
   * `content: ""` and `finish_reason: "length"`** — a success status carrying no
   * answer. The same prompt at 256 tokens returned the intent and used 39 of them
   * on reasoning.
   *
   * So a small budget does not fail loudly, it fails as an empty string that the
   * next line (`JSON.parse`) turns into a syntax error about nothing.
   *
   * ★ AND 512 WAS MEASURED TO BE TOO SMALL FOR ONE OF THE ALLOWLISTED QUESTIONS.
   *   `"What was check 63409 for?"` came back `finish_reason: "length"` with **all 512
   *   tokens spent on reasoning** and no answer, while `"What was the highest check
   *   paid in July?"` answered in the same session on the same budget. The spend is a
   *   property of the question, not of the model or of the code, so no single number is
   *   safe: the floor is 1024, and `ask` retries once at double the budget when — and
   *   only when — the provider reports the budget was exhausted. A retry would double
   *   the latency of an ordinary question, which is why this default still carries the
   *   weight and the retry is the backstop rather than the mechanism.
   */
  maxTokens: number;
  /** Rows returned with an answer as evidence. Never bounds the arithmetic. */
  sampleRows: number;
  /** Whether the model may write an optional lead-in. Digits in it are rejected. */
  phrase: boolean;
  /** Longest question accepted. Enforced by the route's schema, not here. */
  maxQuestionChars: number;
}

function aiConfig(): AiConfig {
  const positive = (key: string, fallback: number): number => {
    const raw = Number(str(key));
    if (!Number.isFinite(raw) || raw <= 0) return fallback;
    return Math.trunc(raw);
  };

  const model = str('AI_MODEL');
  // Trailing slashes stripped rather than forbidden: `https://api.openai.com/v1/`
  // is what a person copies out of a provider's dashboard, and every call site
  // appends `/chat/completions`. Keeping the slash would produce `//chat/...`,
  // which some providers 404 and others quietly normalise — a difference nobody
  // would find by reading the code.
  const endpoint = str('AI_ENDPOINT')?.replace(/\/+$/, '');
  const apiKey = str('AI_API_KEY');

  const style = str('AI_AUTH_STYLE')?.toLowerCase();
  const authStyle: AiConfig['authStyle'] =
    style === 'api-key' || style === 'none' ? style : 'bearer';

  const wanted = bool('AI_ENABLED', false);

  // The key is required by the two styles that send one, and only by those.
  const missing = [
    ...(model === undefined ? ['AI_MODEL'] : []),
    ...(endpoint === undefined ? ['AI_ENDPOINT'] : []),
    ...(authStyle !== 'none' && apiKey === undefined ? ['AI_API_KEY'] : []),
  ];

  const enabled = wanted && missing.length === 0;

  return {
    enabled,
    reason: enabled
      ? undefined
      : wanted
        ? `The assistant is switched on but cannot reach a model: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set in the environment.`
        : 'The assistant is switched off. Set AI_ENABLED=1 in .env to turn it on.',
    model,
    endpoint,
    apiKey,
    authStyle,
    apiVersion: str('AI_API_VERSION'),
    timeoutMs: positive('AI_TIMEOUT_MS', 8000),
    maxTokens: positive('AI_MAX_TOKENS', 512),
    sampleRows: positive('AI_SAMPLE_ROWS', 20),
    phrase: bool('AI_PHRASE', false),
    maxQuestionChars: positive('AI_MAX_QUESTION_CHARS', 400),
  };
}

const DEFAULT_LOCAL_DB = path.join(REPO_ROOT, 'data', 'sql', 'turso', 'sample.db');

/**
 * Resolve `DB_MODE` into a concrete target.
 *
 * ★ An unrecognised mode is now a hard error rather than a warning-plus-fallback.
 *   The previous version mapped anything that was not exactly `turso` onto the
 *   local sample file, justified by "the local file cannot leak anything". That
 *   reasoning covers *disclosure* and misses the failure it actually causes:
 *   `DB_MODE=oracle` resolved to SQLite and the API served the sample database
 *   while every operator-facing signal said Oracle. Wrong data is worse than no
 *   data, and a mode that is silently ignored makes `DB_MODE` a setting that
 *   cannot be trusted to mean what it says. Refusing to guess is the only
 *   behaviour that keeps the mode trustworthy.
 */
function resolveDb(): DbConfig {
  const raw = str('DB_MODE');
  const requested = raw?.toLowerCase();

  if (requested !== undefined && !(DB_MODES as readonly string[]).includes(requested)) {
    throw new Error(
      `DB_MODE="${raw}" is not one of ${DB_MODES.join(', ')}. Refusing to guess which database to use.`,
    );
  }

  // An unset DB_MODE still means the local sample file: that is the zero-config
  // default for a fresh checkout, and it is unambiguous because it is absent
  // rather than misspelled.
  const mode: DbMode = (requested as DbMode | undefined) ?? 'local';

  if (mode === 'oracle') return oracleConfig();
  if (mode === 'sqlserver') return sqlServerConfig();
  if (mode === 'turso') {
    const remoteUrl = str('TURSO_DATABASE');
    if (!remoteUrl) {
      throw new Error(
        'DB_MODE=turso but TURSO_DATABASE is not set. Add it to the repo-root .env, ' +
          'or set DB_MODE=local to use data/sql/turso/sample.db.',
      );
    }
    const authToken = str('TURSO_API_KEY');
    if (!authToken) {
      // Not fatal at boot: libSQL gives a clear 401 on first query, and saying so
      // here as well means one log line explains it rather than a stack trace.
      process.emitWarning('DB_MODE=turso but TURSO_API_KEY is not set; queries will fail auth.');
    }
    return {
      mode,
      url: remoteUrl,
      authToken,
      filePath: undefined,
      label: hostOf(remoteUrl),
      // Remote writes are opt-in. The choice to build CRUD does not imply the
      // right to mutate a networked database on the strength of a typo, and the
      // guard costs one env var to lift.
      allowWrites: bool('ALLOW_REMOTE_WRITES', false),
    };
  }

  const filePath = path.resolve(str('LOCAL_DB_PATH') ?? DEFAULT_LOCAL_DB);
  if (!existsSync(filePath)) {
    throw new Error(
      `Local sample database not found: ${filePath}\n` +
        'Build it with:  node scripts/build-turso-sample.mjs',
    );
  }
  return {
    mode,
    url: pathToFileURL(filePath).href,
    authToken: undefined,
    filePath,
    label: path.relative(REPO_ROOT, filePath).split(path.sep).join('/'),
    allowWrites: true,
  };
}

/** `libsql://abc-def.turso.io` → `abc-def.turso.io`, with any query string dropped. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/\?.*$/, '');
  }
}

/**
 * The Oracle target.
 *
 * ★ `allowWrites` is hard-coded `false`, not read from an env var.
 *   POWERAPPS holds `SELECT` and nothing else — all 51 rows of `USER_TAB_PRIVS`
 *   are `SELECT`, plus one `INHERIT PRIVILEGES`. Offering an `ALLOW_*_WRITES`
 *   switch here would imply a write path exists that the account cannot use, and
 *   a rejected `INSERT` (ORA-01031) surfaces as a 500 at the point of use rather
 *   than as a refusal at the point of intent. If EBS ever grants more, this is
 *   the line to revisit.
 */
function oracleConfig(): DbConfig {
  const user = str('ORACLE_USER');
  const password = str('ORACLE_PASSWORD');
  const connectString = str('ORACLE_CONNECT_STRING');

  // Any one of these missing makes every query fail at connect time with a
  // message that names the driver, not the missing setting. Name them here, all
  // at once, so one boot explains the whole gap.
  //
  // Written as a single `if` over the three values rather than filtering a
  // candidate list, because only this form narrows the types below — a filter
  // produces a plain string[] and leaves the locals `string | undefined`.
  if (user === undefined || password === undefined || connectString === undefined) {
    const missing = [
      user === undefined ? 'ORACLE_USER' : null,
      password === undefined ? 'ORACLE_PASSWORD' : null,
      connectString === undefined ? 'ORACLE_CONNECT_STRING' : null,
    ].filter((k): k is string => k !== null);

    throw new Error(
      `DB_MODE=oracle but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. ` +
        'Add them to the repo-root .env, or set DB_MODE=local to use the sample database.',
    );
  }

  if (!connectString.includes('/')) {
    process.emitWarning(
      `ORACLE_CONNECT_STRING="${connectString}" has no "/service_name". If it is a TNS alias, ` +
        'set ORACLE_TNS_ADMIN as well; Easy Connect needs host:port/service.',
    );
  }

  const thick = bool('ORACLE_THICK', false);
  const thickLibDir = str('ORACLE_THICK_LIB_DIR');
  if (thick && !thickLibDir) {
    // Not fatal: when the Instant Client is on PATH or LD_LIBRARY_PATH, the
    // driver finds it unaided. Worth saying because the failure without it is
    // "DPI-1047: Cannot locate a 64-bit Oracle Client library".
    process.emitWarning('ORACLE_THICK=1 but ORACLE_THICK_LIB_DIR is not set; relying on PATH.');
  }

  return {
    mode: 'oracle',
    url: '',
    authToken: undefined,
    filePath: undefined,
    // Never the password. `user@host/service` is enough to tell two targets
    // apart, and this string is echoed by /api/health.
    label: `${user}@${connectString}`,
    allowWrites: false,
    oracle: {
      user,
      password,
      connectString,
      schema: str('ORACLE_SCHEMA'),
      privilege: str('ORACLE_PRIVILEGE'),
      connectTimeout: Number(str('ORACLE_CONNECT_TIMEOUT') ?? 15) || 15,
      thick,
      thickLibDir,
      tnsAdmin: str('ORACLE_TNS_ADMIN'),
      walletDir: str('ORACLE_WALLET_DIR'),
      walletPassword: str('ORACLE_WALLET_PASSWORD'),
    },
  };
}

/**
 * The Azure SQL target.
 *
 * ★ `allowWrites` IS `true`, AND THAT IS THE DIFFERENCE FROM ORACLE.
 *   The Oracle account holds `SELECT` and nothing else, so its config hard-codes
 *   `false` and offers no switch. This login is a database owner: it created the
 *   tables, and the app's own store lives here. Refusing writes would break
 *   saving a view, creating a project, and stamping `last_seen_at` on sign-in.
 *
 * ★ THE PASSWORD IS NOT IN `label`. Every log line and the health payload use
 *   `label`, which is `server/database` — enough to tell two targets apart and
 *   nothing more. This matters more here than for Oracle because the label is
 *   echoed by `/api/health`, which is unauthenticated.
 */
function sqlServerConfig(): DbConfig {
  const server = str('AZURE_SQL_SERVER');
  const database = str('AZURE_SQL_DATABASE');
  const user = str('AZURE_SQL_USER');
  const password = str('AZURE_SQL_PASSWORD');

  // Any one missing makes every query fail at connect with a message naming the
  // driver rather than the setting. Name them all at once, so one boot explains
  // the whole gap — the same shape `oracleConfig` uses, and for the same reason.
  if (server === undefined || database === undefined || user === undefined || password === undefined) {
    const missing = [
      server === undefined ? 'AZURE_SQL_SERVER' : null,
      database === undefined ? 'AZURE_SQL_DATABASE' : null,
      user === undefined ? 'AZURE_SQL_USER' : null,
      password === undefined ? 'AZURE_SQL_PASSWORD' : null,
    ].filter((k): k is string => k !== null);

    throw new Error(
      `DB_MODE=sqlserver but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. ` +
        'Add them to the repo-root .env, or set DB_MODE=oracle to read the live EBS extract.',
    );
  }

  return {
    mode: 'sqlserver',
    url: '',
    authToken: undefined,
    filePath: undefined,
    label: `${server}/${database}`,
    allowWrites: true,
    sqlserver: { server, database, user, password },
  };
}

/** Where a libSQL-backed store actually is. Enough to open a client against it. */
export interface DbTarget {
  url: string;
  authToken: string | undefined;
  /** Absolute path, present only for a file target. Used by the schema endpoints. */
  filePath: string | undefined;
  /** Human label for logs and the health payload. Never contains a secret. */
  label: string;
  /**
   * Present only for a SQL Server target.
   *
   * ★ A libSQL target is fully described by a URL and a token; a SQL Server one is
   *   described by four separate settings and has no URL at all. So this is a
   *   second, optional shape rather than a field on the first — and `url` stays
   *   `''` for SQL Server, which is what the existing `url === ''` checks in
   *   `client.ts` already expect from a non-libSQL target.
   */
  sqlserver?: SqlServerConfig;
}

/**
 * The app-owned store: a {@link DbTarget} plus whether it is writable and whether
 * it is the same database as the ledger.
 */
export interface AppDbConfig extends DbTarget {
  /**
   * ★ True when the app store resolves to the SAME database as the ledger.
   *
   * This is not an optimisation, it is the flag that decides whether the
   * statement router can be wrong. When the two are one database every routing
   * answer is the same answer, so a mis-classified table cannot change a result;
   * only when they diverge does routing carry consequences. `hybrid.ts` reads it
   * to decide whether a mixed statement is an error or a harmless one.
   */
  shared: boolean;
  /** Whether non-GET requests against app-owned tables are accepted. */
  allowWrites: boolean;
}

/**
 * Resolve `APP_DB_URL` — where the app-owned tables live — against the ledger.
 *
 * ★ THE DEFAULT IS NOT A CONSTANT, IT IS A QUESTION ABOUT THE LEDGER.
 *   With `APP_DB_URL` unset:
 *
 *   - the ledger is already libSQL (`local`, `turso`) → the app store **is that
 *     database**. That is what it has always been, so `APP_DB_URL` defaults to
 *     *no change at all* and a `turso` deployment keeps writing its app rows to
 *     Turso. Defaulting these two cases to a local file would have moved a
 *     deployment's app data onto the server's disk on upgrade, which is the
 *     kind of silent relocation a default must never do.
 *   - the ledger is Oracle (`oracle`) → the local sample file, because Oracle is
 *     where the EBS tables are and has no storage for the app's own tables. This
 *     is the case the setting exists for, and it is why an `organization` table
 *     can be created today in a mode that has no DDL for it.
 *
 * ★ A write policy per store, not per process. `allowWrites` here describes the
 *   app store. A remote target still requires `ALLOW_REMOTE_WRITES`; a file
 *   target is writable, which is the same rule `local` has always had. Under
 *   `DB_MODE=oracle` this is therefore `true` while `config.db.allowWrites` is
 *   `false` — two stores, opposite policies, which is the whole point.
 */
function resolveAppDb(ledger: DbConfig): AppDbConfig {
  const raw = str('APP_DB_URL');

  if (raw !== undefined) {
    // Both spellings are accepted because both are what an operator will type:
    // a `libsql://` URL copied out of the Turso dashboard, or a path to the
    // sample file. Treating a bare path as a URL is the mistake this branch
    // exists to avoid — `libsql://data/...` is not a thing.
    const remote = /^(libsql|https?|wss?):/i.test(raw);

    if (remote) {
      const authToken = str('APP_DB_AUTH_TOKEN');
      if (authToken === undefined && /^libsql:/i.test(raw)) {
        process.emitWarning('APP_DB_URL is a remote libSQL target but APP_DB_AUTH_TOKEN is not set; queries will fail auth.');
      }
      return {
        url: raw,
        authToken,
        filePath: undefined,
        label: hostOf(raw),
        shared: raw === ledger.url,
        allowWrites: bool('ALLOW_REMOTE_WRITES', false),
      };
    }

    const filePath = path.resolve(raw.replace(/^file:/i, ''));
    if (!existsSync(filePath)) {
      throw new Error(
        `APP_DB_URL points at ${filePath}, which does not exist.\n` +
          'Build it with:  node scripts/build-turso-sample.mjs',
      );
    }
    return {
      url: pathToFileURL(filePath).href,
      authToken: undefined,
      filePath,
      label: path.relative(REPO_ROOT, filePath).split(path.sep).join('/'),
      shared: pathToFileURL(filePath).href === ledger.url,
      allowWrites: true,
    };
  }

  // ★ SQL SERVER SHARES ITSELF, LIKE A libSQL LEDGER DOES — but it cannot take
  //   the branch below, because that one hands back `ledger.url` and a SQL Server
  //   target has no URL. Its connection settings live in `ledger.sqlserver`, so
  //   the app store is the same server and the same database, reached by the same
  //   credentials. `shared: true` is what tells `hybrid.ts` that a statement
  //   naming both app and ledger tables is harmless rather than unanswerable.
  if (ledger.mode === 'sqlserver') {
    return {
      url: '',
      authToken: undefined,
      filePath: undefined,
      label: ledger.label,
      shared: true,
      allowWrites: true,
      sqlserver: ledger.sqlserver,
    };
  }

  if (ledger.mode !== 'oracle') {
    return {
      url: ledger.url,
      authToken: ledger.authToken,
      filePath: ledger.filePath,
      label: ledger.label,
      shared: true,
      allowWrites: ledger.allowWrites,
    };
  }

  const filePath = path.resolve(str('LOCAL_DB_PATH') ?? DEFAULT_LOCAL_DB);
  if (!existsSync(filePath)) {
    throw new Error(
      `DB_MODE=oracle needs somewhere to keep this app's own tables, and the local sample ` +
        `database is not there: ${filePath}\n` +
        'Build it with:  node scripts/build-turso-sample.mjs\n' +
        'Or point APP_DB_URL at a libSQL target that holds them.',
    );
  }
  return {
    url: pathToFileURL(filePath).href,
    authToken: undefined,
    filePath,
    label: path.relative(REPO_ROOT, filePath).split(path.sep).join('/'),
    shared: false,
    allowWrites: true,
  };
}

const port = Number(str('PORT') ?? str('API_PORT') ?? 5181);

const corsRaw = str('CORS_ORIGINS');

/**
 * The bootstrap account, read once.
 *
 * `str()` returns `undefined` for an absent or empty variable, which is the
 * documented way to switch the account off — so an unset email is not an error
 * and the server does not refuse to start. That matters because the account is
 * only needed until the first organization exists.
 *
 * The email is lower-cased here rather than at every comparison, because that is
 * the form `app_user.email` is stored in — "the same address" has to mean the
 * same string on both sides of that lookup, or the bootstrap and the table could
 * disagree about a row they both claim.
 */
function superAdminConfig(): SuperAdminConfig {
  const email = str('SUPER_ADMIN_EMAIL')?.trim().toLowerCase();
  return {
    email: email === undefined || email === '' ? undefined : email,
    password: str('SUPER_ADMIN_PASSWORD'),
  };
}

/**
 * The one word that means "filter on nothing".
 *
 * `str()` cannot tell an empty variable from an absent one, so `PROGRAM_CODE=`
 * would arrive as "this file says nothing, ask the tenant row" — the opposite of
 * what an operator blanking it probably means. A sentinel makes the second meaning
 * reachable instead of leaving it unexpressible.
 */
const NO_PROGRAM_FILTER = 'none';

/**
 * Read the declared ledger scope, refusing rather than guessing.
 *
 * ★ THIS THROWS AT IMPORT TIME, WHICH IS DELIBERATE and matches `resolveDb()`'s
 *   "Refusing to guess which database to use". A malformed scope is not a value
 *   that can be defaulted: `FUND_CODE=2` silently becoming fund `02` would read a
 *   *different set of rows* than the operator wrote, and every figure on every
 *   screen would be built on it. A server that will not start is a much cheaper
 *   failure than a server that answers confidently about the wrong money.
 */
function ledgerScopeConfig(): LedgerScopeConfig {
  const codes = (key: string, width: number): string[] | undefined => {
    const raw = str(key);
    if (raw === undefined) return undefined;

    const parts = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '');
    if (parts.length === 0) return undefined;

    const shape = new RegExp(`^\\d{${width}}$`);
    for (const part of parts) {
      if (!shape.test(part)) {
        throw new Error(
          `${key}="${raw}" is not a comma-separated list of ${width}-digit codes ` +
            `("${part}" is not ${width} digits). ` +
            (width === 2
              ? 'Fund values are zero-padded — fund 2 is written "02".'
              : 'Program values are three digits, e.g. "861".') +
            ' Refusing to guess which value was meant.',
        );
      }
    }
    // Deduped and ordered: the fragment is a SQL `IN` list, so a repeated value
    // changes nothing but a stable order keeps generated SQL comparable between
    // runs — which is what makes a cached plan still valid.
    return [...new Set(parts)].sort();
  };

  const ceiling = (key: string, fallback: number): number => {
    const raw = str(key);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
      throw new Error(
        `${key}="${raw}" is not a positive whole number of records. ` +
          'It is a ceiling on rows read, so a fractional or non-positive value ' +
          'would silently read everything or nothing. Refusing to guess.',
      );
    }
    return n;
  };

  const startRaw = str('START_YEAR');
  let startYear: number | undefined;
  if (startRaw !== undefined) {
    const n = Number(startRaw);
    if (!Number.isInteger(n) || n < 1900 || n > 9999) {
      throw new Error(
        `START_YEAR="${startRaw}" is not a four-digit fiscal year. Note what this ` +
          'value is compared against: GL_BALANCES.PERIOD_YEAR, which Oracle defines ' +
          'as the fiscal year a period ENDS in. START_YEAR=2021 therefore reads from ' +
          '2020-07-01, not from 2021-01-01.',
      );
    }
    startYear = n;
  }

  const programRaw = str('PROGRAM_CODE');
  const programs =
    programRaw !== undefined && programRaw.toLowerCase() === NO_PROGRAM_FILTER
      ? []
      : codes('PROGRAM_CODE', 3);

  const glBalancesMaxRecords = ceiling('GL_BALANCES_MAX_RECORDS', 20_000_000);
  const allMaxRecords = ceiling('ALL_MAX_RECORDS', 50_000_000);

  // A ceiling under another ceiling is not a tighter constraint, it is a
  // contradiction: whichever statement breached the smaller one would report the
  // larger one's name, and the message would be about the wrong variable.
  if (allMaxRecords < glBalancesMaxRecords) {
    throw new Error(
      `ALL_MAX_RECORDS (${allMaxRecords}) is below GL_BALANCES_MAX_RECORDS ` +
        `(${glBalancesMaxRecords}). GL_BALANCES is one of the ledger tables counted ` +
        'toward ALL_MAX_RECORDS, so the overall ceiling cannot be the smaller of the ' +
        'two — no statement could ever breach it.',
    );
  }

  return {
    funds: codes('FUND_CODE', 2),
    programs,
    startYear,
    glBalancesMaxRecords,
    allMaxRecords,
  };
}

// Resolved into a local first, because the app store's default is a question
// about the ledger: see `resolveAppDb`.
const db = resolveDb();

export const config: Config = {
  nodeEnv: str('NODE_ENV') ?? 'development',
  isProduction: str('NODE_ENV') === 'production',
  port: Number.isFinite(port) ? port : 5181,
  host: str('HOST') ?? '127.0.0.1',
  corsOrigins:
    corsRaw === undefined
      ? true
      : corsRaw === '*'
        ? true
        : corsRaw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
  db,
  appDb: resolveAppDb(db),
  viewBuilder: viewBuilderConfig(),
  ai: aiConfig(),
  superAdmin: superAdminConfig(),
  ledgerScope: ledgerScopeConfig(),
};
