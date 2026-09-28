import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import cors from 'cors';
import { config } from './config/env.js';
import { docsJsonHandler, docsUiHandlers } from './http/docs.js';
import { errorHandler, notFoundHandler, writesGuard } from './http/middleware.js';
import { resetOpenApiCache } from './http/openapi.js';
import { withSqlTrace } from './http/sql-trace.js';
import { apiRouter } from './routes/index.js';

/**
 * ★ WHERE THE BUILT APP LIVES, AND WHY THE API PROCESS IS WHAT SERVES IT.
 *
 * Every call the app makes is a **relative** `/api/...` path — there are 46 of them and no
 * environment variable anywhere that could point them at another origin. In development that
 * resolves because Vite proxies `/api` to this server. A production build has no proxy, so the
 * only way those 46 call sites keep working is for the built app and the API to share one
 * origin. Serving `app/dist` from here is what makes that true, and it is why this deploys as a
 * single web app rather than as a static host plus an API.
 *
 * `server/public` is the drop point rather than `app/dist` directly, so that the path is the
 * same whether this file is executed from source by `tsx` (`server/src` → `../public`) or
 * compiled (`server/dist` → `../public`). `npm run build:web` fills it; see
 * `server/scripts/copy-web.mjs`.
 */
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const webIndex = path.join(webRoot, 'index.html');

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

  /**
   * ★ STATIC, THEN THE SHELL, THEN THE 404 — IN THAT ORDER, AND IT MATTERS.
   *
   * The API is mounted above, so a real API route is answered before any of this runs. What is
   * left over is either a file the app shipped (`/assets/index-abc123.js`) or a client-side route
   * (`/projects/123`, which is not a file and never will be). The first is `express.static`; the
   * second has to be answered with `index.html` so React Router can take over. Without that
   * fallback every deep link and every refresh outside `/` is a 404 — the classic way an SPA
   * looks perfect in development and broken in production.
   *
   * `/api` is excluded from the fallback deliberately: an unknown API route must stay a JSON 404
   * from `notFoundHandler` below rather than become a 200 carrying the app's HTML. That is also
   * why the fallback sits *above* the not-found handler instead of replacing it.
   *
   * If the app has not been built there is nothing to serve, so neither middleware is mounted and
   * this remains an API-only server — which is what the dev loop and the smoke suite both want.
   */
  if (existsSync(webIndex)) {
    app.use(express.static(webRoot, { index: false }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (req.path.startsWith('/api')) return next();
      res.sendFile(webIndex);
    });
  } else if (config.isProduction) {
    console.warn(
      `[api] no built app at ${webRoot} — serving the API only. ` +
        'Build app/ and then run `npm run build:web` in server/, or the deployed site will load nothing.',
    );
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
