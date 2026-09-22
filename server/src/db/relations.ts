import { AppError } from '../http/errors.js';
import { bindable, quoteIdent, rows, scalar } from './sql.js';
import { config } from '../config/env.js';

/**
 * Referential integrity, checked explicitly.
 *
 * WHY THIS EXISTS AT ALL
 *   The schema declares foreign keys, but SQLite only *enforces* them when
 *   `PRAGMA foreign_keys = ON` — and that pragma is per-connection, while the
 *   libSQL client may serve a write over a different connection than the one the
 *   pragma was set on. Worse, a remote libSQL endpoint may reject the pragma
 *   outright. So "the database will catch it" is not a guarantee this server can
 *   rely on, and the alternative to checking here is silent orphan rows.
 *
 * The relationship map is read once from `pragma_foreign_key_list` for every
 * table and cached for the process. That is 36 pragmas at startup, after which
 * every check is a single indexed existence query.
 */

interface FkEdge {
  /** Child (referencing) table. */
  child: string;
  parent: string;
  fromColumn: string;
  /** Parent column; `null` in the pragma means "the parent's primary key". */
  toColumn: string | null;
  onDelete: string;
}

interface Relations {
  byChild: Map<string, FkEdge[]>;
  byParent: Map<string, FkEdge[]>;
  /** Primary-key column names per table, in key order. */
  primaryKeys: Map<string, string[]>;
}

interface FkRow {
  child: string;
  parent: string;
  from_column: string;
  to_column: string | null;
  on_delete: string;
  fk_id: number;
  seq: number;
}

interface PkRow {
  table_name: string;
  column_name: string;
  pk: number;
}

let cached: Relations | null = null;
let inFlight: Promise<Relations> | null = null;
let enforced: boolean | null = null;

async function load(): Promise<Relations> {
  if (cached) return cached;
  // Coalesce concurrent callers onto one load rather than issuing 36 pragmas per
  // request arriving during the first one.
  if (inFlight) return inFlight;

  inFlight = (async (): Promise<Relations> => {
    const edges = await rows<FkRow>(
      `SELECT m.name        AS child,
              f."table"     AS parent,
              f."from"      AS from_column,
              f."to"        AS to_column,
              f.on_delete   AS on_delete,
              f.id          AS fk_id,
              f.seq         AS seq
         FROM sqlite_master m
         JOIN pragma_foreign_key_list(m.name) f
        WHERE m.type = 'table'
          AND m.name NOT LIKE 'sqlite_%'
        ORDER BY m.name, f.id, f.seq`,
    );

    const pkRows = await rows<PkRow>(
      `SELECT m.name AS table_name, p.name AS column_name, p.pk AS pk
         FROM sqlite_master m
         JOIN pragma_table_info(m.name) p
        WHERE m.type = 'table'
          AND m.name NOT LIKE 'sqlite_%'
          AND p.pk > 0
        ORDER BY m.name, p.pk`,
    );

    const byChild = new Map<string, FkEdge[]>();
    const byParent = new Map<string, FkEdge[]>();
    const seen = new Set<string>();

    for (const e of edges) {
      const key = `${e.child}->${e.parent}:${e.fk_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const edge: FkEdge = {
        child: e.child,
        parent: e.parent,
        fromColumn: e.from_column,
        toColumn: e.to_column,
        onDelete: e.on_delete.toUpperCase(),
      };
      push(byChild, e.child, edge);
      push(byParent, e.parent, edge);
    }

    const primaryKeys = new Map<string, string[]>();
    for (const p of pkRows) push(primaryKeys, p.table_name, p.column_name);

    const result: Relations = { byChild, byParent, primaryKeys };
    cached = result;
    return result;
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * Whether the database is actually enforcing foreign keys.
 *
 * Probed rather than assumed, because the answer decides whether a delete is
 * allowed to rely on `ON DELETE CASCADE` or has to be blocked here.
 */
export async function foreignKeysEnforced(): Promise<boolean> {
  if (enforced !== null) return enforced;
  try {
    const value = await scalar('PRAGMA foreign_keys');
    enforced = value === 1;
  } catch {
    enforced = false;
  }
  return enforced;
}

/** Forget the caches. Used by tests after a schema change. */
export function resetRelationsCache(): void {
  cached = null;
  inFlight = null;
  enforced = null;
}

/**
 * Every foreign key in the supplied values must point at a row that exists.
 *
 * Called before an INSERT or UPDATE so the caller gets a 409 naming the missing
 * parent, rather than an opaque constraint failure — or, if the pragma is off, no
 * failure at all.
 */
export async function assertParentsExist(child: string, values: Record<string, unknown>): Promise<void> {
  const relations = await load();
  const edges = relations.byChild.get(child) ?? [];
  if (edges.length === 0) return;

  for (const edge of edges) {
    const value = values[edge.fromColumn];
    if (value === undefined || value === null) continue;

    const parentColumn = edge.toColumn ?? relations.primaryKeys.get(edge.parent)?.[0];
    if (!parentColumn) continue;

    const found = await scalar(
      `SELECT COUNT(*) AS n FROM ${quoteIdent(edge.parent)} WHERE ${quoteIdent(parentColumn)} = :value`,
      { value: bindable(value) },
    );

    if (found === 0) {
      throw AppError.conflict(
        `${child}.${edge.fromColumn} = ${String(value)} refers to a row that does not exist in ` +
          `${edge.parent}.${parentColumn}.`,
        {
          reason: 'MISSING_PARENT',
          column: edge.fromColumn,
          value,
          parent: { table: edge.parent, column: parentColumn },
        },
      );
    }
  }
}

/**
 * Refuse a delete that would orphan rows.
 *
 * A cascade is honoured only when the database is genuinely enforcing the
 * pragma — otherwise the "cascade" would silently not happen and the child rows
 * would be left pointing at a parent that no longer exists. When nothing enforces
 * it, blocking is the only safe answer, and the message says which rule would
 * have applied so the intent is not lost.
 */
export async function assertNoDependents(table: string, id: unknown): Promise<void> {
  const relations = await load();
  const edges = relations.byParent.get(table) ?? [];
  if (edges.length === 0) return;

  const enforcing = await foreignKeysEnforced();
  const blockers: { table: string; column: string; rows: number; onDelete: string }[] = [];

  for (const edge of edges) {
    const parentColumn = edge.toColumn ?? relations.primaryKeys.get(edge.parent)?.[0];
    if (!parentColumn) continue;

    const count = await scalar(
      `SELECT COUNT(*) AS n FROM ${quoteIdent(edge.child)} WHERE ${quoteIdent(edge.fromColumn)} = :id`,
      { id: bindable(id) },
    );
    if (count === 0) continue;

    const cascades = edge.onDelete === 'CASCADE' || edge.onDelete === 'SET NULL';
    if (cascades && enforcing) continue;

    blockers.push({
      table: edge.child,
      column: edge.fromColumn,
      rows: count,
      // Surface the declared rule either way: if it says CASCADE and the row is
      // still blocked, the caller needs to know *why* the cascade did not run.
      onDelete: enforcing ? edge.onDelete : `${edge.onDelete} (not enforced)`,
    });
  }

  if (blockers.length > 0) {
    const summary = blockers.map((b) => `${b.table}.${b.column} (${b.rows} row${b.rows === 1 ? '' : 's'})`).join(', ');
    const details = {
      reason: 'HAS_DEPENDENTS',
      foreignKeysEnforced: enforcing,
      dependents: blockers,
      ...(enforcing ? {} : { hint: 'PRAGMA foreign_keys could not be enabled on this target, so ON DELETE rules are not applied by the database.' }),
    };
    throw AppError.conflict(
      `Cannot delete: ${summary} still reference this row. Delete or reassign them first.`,
      details,
    );
  }
}

/** The declared relationships, for the meta endpoints. Read-only view. */
export async function describeRelations(): Promise<{
  edges: { child: string; parent: string; column: string; references: string; onDelete: string }[];
  enforced: boolean;
  target: string;
}> {
  const relations = await load();
  const edges: { child: string; parent: string; column: string; references: string; onDelete: string }[] = [];
  for (const [child, list] of relations.byChild) {
    for (const e of list) {
      edges.push({
        child,
        parent: e.parent,
        column: e.fromColumn,
        references: e.toColumn ?? relations.primaryKeys.get(e.parent)?.[0] ?? '(primary key)',
        onDelete: e.onDelete,
      });
    }
  }
  edges.sort((a, b) => a.child.localeCompare(b.child) || a.column.localeCompare(b.column));
  // ★ THE EDGES COME FROM THE APP STORE, SO THE LABEL HAS TO AS WELL. Every query
  //   above reads `sqlite_master`, `pragma_foreign_key_list` and
  //   `pragma_table_info` — introspection, which the registry routes to the app
  //   store — so in a divergent configuration this endpoint describes the app
  //   store's schema while `config.db.label` named the ledger. An operator
  //   comparing this endpoint's target with another's saw one database named by two
  //   endpoints and could not tell that the referential map belonged to neither.
  //   `foreignKeysEnforced()` probes the pragma on the same store, so `enforced` has
  //   always answered about the app store too.
  //
  //   In a shared configuration `config.appDb.label` IS `config.db.label` — the
  //   label is copied from the ledger when the store is shared — so this changes
  //   nothing there and is only visibly different where it was wrong.
  return { edges, enforced: await foreignKeysEnforced(), target: config.appDb.label };
}
