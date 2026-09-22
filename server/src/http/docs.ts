import type { RequestHandler } from 'express';
import swaggerUi from 'swagger-ui-express';
import { buildOpenApiDocument, registry } from './openapi.js';
import { z } from './z.js';

/**
 * Swagger UI and the generated spec.
 *
 * These two paths are mounted by hand rather than through `defineRoute`, because
 * they serve the specification that `defineRoute` builds — a route cannot
 * describe the document it is part of being generated from. They are still
 * registered in the registry so the spec is complete about itself.
 */

registry.registerPath({
  method: 'get',
  path: '/api/docs.json',
  operationId: 'getOpenApiDocument',
  summary: 'The OpenAPI 3.0 document for this API',
  tags: ['Meta'],
  responses: {
    200: {
      description: 'The spec, as consumed by Swagger UI and any generated client.',
      content: { 'application/json': { schema: z.object({}).passthrough() } },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/api/docs',
  operationId: 'getApiDocs',
  summary: 'Swagger UI',
  description: 'Interactive documentation. Every endpoint below can be called from this page.',
  tags: ['Meta'],
  responses: { 200: { description: 'The Swagger UI HTML page.' } },
});

export function docsJsonHandler(): RequestHandler {
  return (_req, res) => {
    res.json(buildOpenApiDocument());
  };
}

export function docsUiHandlers(): RequestHandler[] {
  return [
    ...(swaggerUi.serve as unknown as RequestHandler[]),
    swaggerUi.setup(buildOpenApiDocument(), {
      customSiteTitle: 'Oracle Projects API',
      swaggerOptions: {
        // ★ THIS FLAG HAS NOTHING TO ACT ON, AND THE OLD COMMENT HERE SAID IT WOULD.
        // It used to read "persist the (absent, for now) auth across reloads so adding
        // it later needs no change here" — and authentication did arrive, in a shape
        // this flag cannot persist. `persistAuthorization` remembers credentials for a
        // **security scheme declared in the document**, and this document declares
        // none: the session is the custom `x-app-session` header, and `api.ts` binds
        // only `params`/`query`/`body` into a route's `request`, so there is no way to
        // declare a header parameter either. Swagger UI will therefore offer no input
        // box and persist nothing, and the reader is told the header name in the
        // frontmatter instead (see `documentIdentity()` in `openapi.ts`).
        //
        // Left `true` rather than removed: it is correct and free, and it starts
        // working the day a `securityScheme` is registered — that is a real change to
        // `api.ts`, not a tweak to this object, and it is what would give the two
        // authenticated domains a Try-it-out field.
        persistAuthorization: true,
        displayRequestDuration: true,
        filter: true,
        tryItOutEnabled: true,
        // Models are reference material, not the main event — collapsed by default.
        defaultModelsExpandDepth: 0,
        docExpansion: 'list',
        // Keep the tag order declared in TAGS rather than alphabetical: it is
        // arranged to mirror the application's menu, not to be sorted.
        tagsSorter: undefined,
        operationsSorter: undefined,
      },
    }),
  ];
}
