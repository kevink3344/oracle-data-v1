import { Router, type Request, type RequestHandler, type Response } from 'express';
import type { ResponseConfig, RouteConfig } from '@asteasolutions/zod-to-openapi';
import { z } from './z.js';
import {
  dataEnvelope,
  errorResponses,
  jsonResponse,
  listEnvelope,
  registry,
  type TagName,
} from './openapi.js';
import { AppError } from './errors.js';
import { sendResult } from './respond.js';

/**
 * One declaration per endpoint: validation, handler, and OpenAPI path.
 *
 * WHY THEY ARE BOUND TOGETHER
 *   A route written as three separate things — a handler here, a Zod schema
 *   there, a YAML stanza somewhere else — drifts. Nothing fails when it does;
 *   the docs simply start lying. Registering all three in the same call makes
 *   that impossible: there is no way to add an endpoint to this server without
 *   also describing it, and no way to describe one that is not mounted.
 *
 * WHY VALIDATED VALUES DO NOT GO BACK ON `req`
 *   Express 5 made `req.query` a prototype getter, so assigning a parsed object
 *   to it either throws or is silently ignored depending on the path. Rather
 *   than depend on that, parsed values live in a WeakMap keyed by the request and
 *   are handed to the handler as a typed context. It also means the handler never
 *   sees a raw, unvalidated value by accident.
 */

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';

type Infer<T> = T extends z.ZodTypeAny ? z.infer<T> : undefined;

export interface Ctx<P, Q, B> {
  req: Request;
  res: Response;
  /** Parsed path parameters. */
  params: P;
  /** Parsed query string, with defaults applied. */
  query: Q;
  /** Parsed JSON body. */
  body: B;
}

export interface RouteSpec<
  P extends z.AnyZodObject | undefined = undefined,
  Q extends z.AnyZodObject | undefined = undefined,
  B extends z.ZodTypeAny | undefined = undefined,
  R extends z.ZodTypeAny = z.ZodTypeAny,
> {
  method: Method;
  /** OpenAPI-style path: `/projects/{id}`. Converted to `:id` for Express. */
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  tags: TagName[];
  params?: P;
  query?: Q;
  body?: B;
  /** The **item** schema. For `paginated` routes this is the element, not the array. */
  response: R;
  /** When true the wire format is `{ data: T[], page }` and the handler returns `page(items, meta)`. */
  paginated?: boolean;
  /**
   * ★ WHEN THE BODY IS NOT THIS API'S ENVELOPE.
   *
   *   Every other route answers `{ data }` (or `{ data, page }`), and `sendResult`
   *   enforces it. One endpoint deliberately does not: `GET /api/extract/current`
   *   reproduces the raw Oracle document, because its entire purpose is to be a
   *   drop-in replacement for the static `/oracle/output.json` the frontend already
   *   fetches — see the header of `respond.ts`, which names it as the reason `raw()`
   *   exists.
   *
   *   Without this flag the document would describe that endpoint as returning
   *   `{ data: <envelope> }` while the server returns `<envelope>`, which breaks the
   *   invariant this file is built around: *the document describes the server*. It
   *   is a documentation flag only — `response` is still just the schema, and the
   *   handler still has to return `raw(...)` for the wire format to match.
   */
  rawBody?: boolean;
  status?: number;
  /** Override the default error set for this route. */
  errors?: number[];
  handler: (ctx: Ctx<Infer<P>, Infer<Q>, Infer<B>>) => Promise<unknown>;
}

export interface Api {
  router: Router;
  route: <
    P extends z.AnyZodObject | undefined = undefined,
    Q extends z.AnyZodObject | undefined = undefined,
    B extends z.ZodTypeAny | undefined = undefined,
    R extends z.ZodTypeAny = z.ZodTypeAny,
  >(
    spec: RouteSpec<P, Q, B, R>,
  ) => void;
}

const validated = new WeakMap<Request, { params: unknown; query: unknown; body: unknown }>();

/** The registry's own parameter type. `RouteParameter` exists in the package but is not re-exported. */
type RouteParameter = NonNullable<RouteConfig['request']>['params'];

/** `/projects/{id}` → `/projects/:id`. OpenAPI uses braces; Express uses colons. */
function toExpressPath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ':$1');
}

const DEFAULT_STATUS: Record<Method, number> = {
  get: 200,
  post: 201,
  patch: 200,
  put: 200,
  delete: 204,
};

/** Registered method+path pairs, so a duplicate is a startup error and not a silent overwrite. */
const claimed = new Set<string>();

/**
 * Every `METHOD /path` this process has mounted, in the OpenAPI brace form.
 *
 * Exported so a test can diff the served surface against the spec. That diff is
 * the only way to check the invariant "the document describes the server":
 * probing the spec's paths over HTTP cannot do it, because a route that exists
 * with no such row and a route that does not exist both answer 404, so the two
 * are indistinguishable from the outside.
 *
 * Process-scoped alongside the OpenAPI `registry`, and `createApi()` is meant to
 * be called once per process. Calling it a second time would raise a duplicate
 * route error rather than merge, which is the intended failure.
 */
export function registeredRoutes(): string[] {
  return [...claimed].sort();
}

export function createApi(): Api {
  const router = Router();

  const route: Api['route'] = (spec) => {
    const key = `${spec.method.toUpperCase()} ${spec.path}`;
    if (claimed.has(key)) {
      throw new Error(
        `Duplicate route ${key}. Two modules are mounting the same path; one would silently shadow the other.`,
      );
    }
    claimed.add(key);

    const expressPath = toExpressPath(spec.path);
    const status = spec.status ?? DEFAULT_STATUS[spec.method];

    // ---- Express -----------------------------------------------------------
    router[spec.method](
      expressPath,
      buildValidator(spec),
      buildHandler(spec, status) as RequestHandler,
    );

    // ---- OpenAPI -----------------------------------------------------------
    const bodySchema =
      status === 204
        ? null
        : spec.rawBody === true
          ? spec.response
          : spec.paginated
            ? listEnvelope(spec.response)
            : dataEnvelope(spec.response);

    const errors = spec.errors ?? (spec.method === 'get' ? [400, 404, 500] : [400, 409, 500]);

    const responses: Record<string, ResponseConfig> = {
      ...(bodySchema === null
        ? { [String(status)]: { description: 'Deleted. No body.' } }
        : { [String(status)]: jsonResponse(bodySchema, successDescription(spec, status)) }),
      ...errorResponses(...errors),
    };

    const request: NonNullable<RouteConfig['request']> = {};
    if (spec.params !== undefined) request.params = spec.params as RouteParameter;
    if (spec.query !== undefined) request.query = spec.query as RouteParameter;
    if (spec.body !== undefined) {
      request.body = {
        required: true,
        content: { 'application/json': { schema: spec.body } },
      };
    }

    const config: RouteConfig = {
      method: spec.method,
      path: spec.path,
      operationId: spec.operationId,
      summary: spec.summary,
      tags: [...spec.tags],
      responses: responses as RouteConfig['responses'],
      ...(spec.description === undefined ? {} : { description: spec.description }),
      ...(Object.keys(request).length === 0 ? {} : { request }),
    };

    registry.registerPath(config);
  };

  return { router, route };
}

function successDescription(spec: { paginated?: boolean }, status: number): string {
  if (status === 201) return 'Created.';
  return spec.paginated ? 'A page of results.' : 'The requested object.';
}

// ---------------------------------------------------------------------------

type AnySpec = RouteSpec<z.AnyZodObject | undefined, z.AnyZodObject | undefined, z.ZodTypeAny | undefined, z.ZodTypeAny>;

/**
 * Parse and replace. The handler only ever sees validated output, which is what
 * makes `limit` a number with a default rather than the string "50" or absent.
 */
function buildValidator(spec: AnySpec): RequestHandler {
  return (req, _res, next) => {
    try {
      validated.set(req, {
        params: spec.params ? spec.params.parse(req.params) : undefined,
        query: spec.query ? spec.query.parse(req.query) : undefined,
        body: spec.body ? spec.body.parse(req.body) : undefined,
      });
      next();
    } catch (e) {
      if (e instanceof z.ZodError) {
        next(
          AppError.validation('The request did not match the expected shape.', {
            issues: e.issues.map((i) => ({
              path: i.path.join('.') || '(root)',
              code: i.code,
              message: i.message,
            })),
          }),
        );
        return;
      }
      next(e);
    }
  };
}

function buildHandler(spec: AnySpec, status: number): RequestHandler {
  return async (req, res, next) => {
    const v = validated.get(req) ?? { params: undefined, query: undefined, body: undefined };
    try {
      const out = await spec.handler({
        req,
        res,
        params: v.params,
        query: v.query,
        body: v.body,
      } as never);
      sendResult(res, out, status);
    } catch (e) {
      next(e);
    }
  };
}
