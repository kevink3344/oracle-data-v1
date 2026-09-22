import express, { type Express } from 'express';
import cors from 'cors';
import { config } from './config/env.js';
import { docsJsonHandler, docsUiHandlers } from './http/docs.js';
import { errorHandler, notFoundHandler, writesGuard } from './http/middleware.js';
import { resetOpenApiCache } from './http/openapi.js';
import { apiRouter } from './routes/index.js';

/**
 * The Express application.
 *
 * Order here is load-bearing and is the only place it is expressed:
 *
 *   1. CORS          — so a browser preflight is answered before anything else.
 *   2. body parser   — the only place a limit is set.
 *   3. writes guard  — refuses mutations before they reach a router or the database.
 *   4. /api/docs*    — before the API routers, so `docs.json` is not shadowed.
 *   5. /api routers
 *   6. 404
 *   7. error handler — last, always.
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

  app.use('/api', writesGuard);

  app.get('/api/docs.json', docsJsonHandler());
  app.use('/api/docs', ...docsUiHandlers());

  app.use(api);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
