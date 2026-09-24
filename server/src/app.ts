import express, { type Express } from 'express';
import cors from 'cors';
import { config } from './config/env.js';
import { docsJsonHandler, docsUiHandlers } from './http/docs.js';
import { errorHandler, notFoundHandler, writesGuard } from './http/middleware.js';
import { resetOpenApiCache } from './http/openapi.js';
import { withSqlTrace } from './http/sql-trace.js';
import { apiRouter } from './routes/index.js';

/**
 * The Express application.
 *
 * Order here is load-bearing and is the only place it is expressed:
 *
 *   1. CORS          — so a browser preflight is answered before anything else.
 *   2. body parser   — the only place a limit is set.
 *   3. SQL trace     — binds a per-request collector, so any statement a handler runs is attributed
 *                      to the request that caused it. Above the writes guard so a refused write
 *                      still reports what ran before the refusal.
 *   4. writes guard  — refuses mutations before they reach a router or the database.
 *   5. /api/docs*    — before the API routers, so `docs.json` is not shadowed.
 *   6. /api routers
 *   7. 404
 *   8. error handler — last, always.
 *
 * ★ `apiRouter()` is called before the docs are mounted, and the document cache is
 *   cleared in between. `buildOpenApiDocument()` memoises, and the Swagger UI
 *   middleware needs the document at *mount* time — so mounting the docs first
 *   freezes a spec that does not yet contain a single router path. Swagger UI then
 *   renders a complete-looking page with an empty path list, which is a confusing
 *   way to find out. Registering the routers first makes the order irrelevant;
 *   the reset makes it *stay* irrelevant if a router is ever added above.
 */
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');

  const api = apiRouter();
  resetOpenApiCache();

  app.use(
    cors({
      origin: config.corsOrigins,
      credentials: false,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    }),
  );

  // A JSON API only. `1mb` is generous for a single row and small enough that a
  // runaway client cannot exhaust memory before the handler runs.
  app.use(express.json({ limit: '1mb' }));

  /**
   * ★ THE SQL TRACE IS BOUND HERE, BEFORE ANY ROUTE RUNS, AND IT WRAPS `next()`.
   *
   *   `withSqlTrace` opens an `AsyncLocalStorage` scope for the whole request, so a statement run
   *   anywhere inside a handler — however deep the call chain — is recorded against this request
   *   without a single query helper being told about it. Mounted above `/api` so it also covers the
   *   docs routes, which costs nothing: a request that runs no statement records nothing.
   *
   *   It is deliberately above the writes guard: a refused write should still show the statements
   *   that ran before the refusal, which is often the whole question when a save fails.
   */
  app.use((_req, _res, next) => withSqlTrace(next));

  app.use('/api', writesGuard);

  app.get('/api/docs.json', docsJsonHandler());
  app.use('/api/docs', ...docsUiHandlers());

  app.use(api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
