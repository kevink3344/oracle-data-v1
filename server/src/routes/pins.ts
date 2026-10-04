import { z } from '../http/z.js';
import type { Api } from '../http/api.js';
import { requireActor } from '../auth/guard.js';
import { requireAppSchema } from '../db/app-schema.js';
import { AppError } from '../http/errors.js';
import { storeDriver } from '../db/client.js';
import { execute, rows } from '../db/sql.js';

const categories = ['project', 'invoice', 'check', 'purchase-order'] as const;
type Category = (typeof categories)[number];

const PinSchema = z
  .object({
    id: z.number().int(),
    category: z.enum(categories),
    entityKey: z.string(),
    title: z.string(),
    subtitle: z.string(),
    href: z.string(),
    createdAt: z.string(),
  })
  .openapi('UserPin');

interface PinRow {
  id: number;
  category: Category;
  entity_key: string;
  title: string;
  subtitle: string;
  href: string;
  created_at: string;
}

const toWire = (row: PinRow) => ({
  id: row.id,
  category: row.category,
  entityKey: row.entity_key,
  title: row.title,
  subtitle: row.subtitle,
  href: row.href,
  createdAt: row.created_at,
});

const BodySchema = z
  .object({
    category: z.enum(categories),
    entityKey: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(300),
    subtitle: z.string().trim().max(500).default(''),
    href: z.string().trim().regex(/^\//).max(1000),
  })
  .openapi('UserPinCreate');

export function registerPins(api: Api): void {
  api.route({
    method: 'get',
    path: '/api/pins',
    operationId: 'pins_list',
    summary: 'List the signed-in user’s private pins',
    tags: ['Admin'],
    response: z.array(PinSchema),
    errors: [401, 503],
    handler: async (ctx) => {
      const actor = await requireActor(ctx.req);
      await requireAppSchema('Pins');
      const result = await rows<PinRow>(
        'SELECT id, category, entity_key, title, subtitle, href, created_at FROM user_pin ' +
          'WHERE owner_email = ? ORDER BY category, created_at DESC, id DESC',
        [actor.email],
      );
      return result.map(toWire);
    },
  });

  api.route({
    method: 'put',
    path: '/api/pins',
    operationId: 'pins_upsert',
    summary: 'Create or keep one private pin for the signed-in user',
    tags: ['Admin'],
    body: BodySchema,
    response: PinSchema,
    errors: [400, 401, 503],
    handler: async (ctx) => {
      const actor = await requireActor(ctx.req);
      await requireAppSchema('Pins');
      const body = ctx.body as z.infer<typeof BodySchema>;
      // ★ `ON CONFLICT` IS SQLITE'S, NOT SQL — MySQL answers it with a parse error, so
      //   the upsert is spelled per dialect exactly as `routes/readCaps.ts` and
      //   `routes/customFields.ts` spell theirs. MySQL's `VALUES(col)` is the value the
      //   INSERT proposed, which is SQLite's `excluded.col`.
      //
      // ★ AND T-SQL HAS NO `ON CONFLICT` EITHER, SO THE TWO-ARM VERSION FAILED THE SAME
      //   WAY ON SQL SERVER. A pin on a SQL Server app store reached the SQLite arm and
      //   answered 500 with `Incorrect syntax near the keyword 'ON'` — the identical
      //   defect `routes/customFields.ts` carried, on the same kind of write. The third
      //   arm is an UPDATE and then an INSERT when nothing was updated, as `meta.ts`
      //   and `readCaps.ts` do; `MERGE` is avoided there for needing a `HOLDLOCK` to be
      //   safe under concurrency.
      const pinInsert =
        'INSERT INTO user_pin (owner_email, category, entity_key, title, subtitle, href) VALUES (?, ?, ?, ?, ?, ?) ';
      const pinBinds = [actor.email, body.category, body.entityKey, body.title, body.subtitle, body.href];
      const appDialect = storeDriver('app').dialect;
      if (appDialect === 'mysql') {
        await execute(
          pinInsert +
            'ON DUPLICATE KEY UPDATE title = VALUES(title), subtitle = VALUES(subtitle), href = VALUES(href)',
          pinBinds,
        );
      } else if (appDialect === 'sqlserver') {
        // SQL Server counts rows *matched*, so re-pinning an unchanged pin still
        // reports > 0 and no duplicate row is attempted.
        const updated = await execute(
          'UPDATE user_pin SET title = ?, subtitle = ?, href = ? ' +
            'WHERE owner_email = ? AND category = ? AND entity_key = ?',
          [body.title, body.subtitle, body.href, actor.email, body.category, body.entityKey],
        );
        if (updated.rowsAffected === 0) await execute(pinInsert, pinBinds);
      } else {
        await execute(
          pinInsert +
            'ON CONFLICT(owner_email, category, entity_key) DO UPDATE SET title = excluded.title, subtitle = excluded.subtitle, href = excluded.href',
          pinBinds,
        );
      }
      const result = await rows<PinRow>(
        'SELECT id, category, entity_key, title, subtitle, href, created_at FROM user_pin ' +
          'WHERE owner_email = ? AND category = ? AND entity_key = ?',
        [actor.email, body.category, body.entityKey],
      );
      if (!result[0]) throw new AppError(500, 'INTERNAL', 'The pin was saved but could not be read back.');
      return toWire(result[0]);
    },
  });

  api.route({
    method: 'delete',
    path: '/api/pins/{category}/{entityKey}',
    operationId: 'pins_delete',
    summary: 'Delete one private pin',
    tags: ['Admin'],
    params: z.object({ category: z.enum(categories), entityKey: z.string().min(1) }),
    response: z.undefined(),
    errors: [401, 404, 503],
    handler: async (ctx) => {
      const actor = await requireActor(ctx.req);
      await requireAppSchema('Pins');
      const params = ctx.params as { category: Category; entityKey: string };
      const result = await execute(
        'DELETE FROM user_pin WHERE owner_email = ? AND category = ? AND entity_key = ?',
        [actor.email, params.category, params.entityKey],
      );
      if (result.rowsAffected === 0) throw AppError.notFound('That pin does not exist for this user.');
      return undefined;
    },
  });
}