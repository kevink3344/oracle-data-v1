import { createApp } from './app.js';
import { defaultTenant } from './auth/session.js';
import { config } from './config/env.js';
import { resolvedScope, scopeDivergence } from './db/derived.js';
import { applyPragmas, closeDb, db, startDbProbe } from './db/client.js';
import { checkRegistry } from './db/store.js';

/**
 * Entry point.
 *
 * ★ `listen` happens FIRST and the database probe runs in the background.
 *
 * The reverse order — probe, then listen, and exit on failure — means a cold or
 * briefly unreachable database leaves no port open at all. The operator then sees
 * a connection-refused and has nothing to read. Listening first means the API can
 * always explain itself on `/api/health`, and the probe reports
 * `{ ok: true, dbReady: false }` while it waits.
 */
const app = createApp();

/**
 * ★ THE REGISTRY IS CHECKED BEFORE THE FIRST REQUEST CAN USE IT.
 *
 * `checkRegistry` returns problems rather than throwing, so that the smoke suite
 * can collect them alongside every other failure. Here the choice is the opposite:
 * a problem is printed and the process exits, because every statement after this
 * point is routed by the registry, and a registry that is internally inconsistent
 * routes silently. A server that refuses to start is a two-minute fix; a server
 * that starts and answers the wrong database is a bug hunt.
 */
const registryProblems = checkRegistry();
if (registryProblems.length > 0) {
  console.error('[db] the store registry is inconsistent:');
  for (const p of registryProblems) console.error(`  - ${p}`);
  console.error('[db] refusing to start: every statement is routed by that list.');
  process.exit(1);
}

const server = app.listen(config.port, config.host, () => {
  console.log(`[api] listening on http://${config.host}:${config.port}`);
  console.log(`[api] docs      http://${config.host}:${config.port}/api/docs`);
  console.log(`[api] health    http://${config.host}:${config.port}/api/health`);

  /**
   * ★ ONE STORE OR TWO, SAID OUT LOUD AT STARTUP.
   *
   * The old banner printed one target and one write policy, which was the whole
   * truth while there was one database. It is now a half-truth that reads as a
   * whole one: under `DB_MODE=oracle` with an `APP_DB_URL` file, `writes disabled`
   * would be printed while saved views were perfectly writable — the operator
   * reads the line, believes it, and looks in the wrong place.
   *
   * So each store gets its own line when there are two, and the shared case says
   * so explicitly rather than printing the same target twice and leaving the
   * reader to work out whether that is one database or two with one name.
   */
  const stores = db.stores();
  const one = stores.length === 1 ? stores[0] : undefined;
  if (one !== undefined) {
    console.log(`[api] database  ${config.db.mode} → ${one.label}  (one store: the app tables live here too)`);
    console.log(`[api] writes    ${one.writable ? 'ENABLED' : 'disabled (read-only)'}`);
  } else {
    console.log(`[api] database  ${config.db.mode}, app-owned tables separated by APP_DB_URL`);
    for (const s of stores) {
      console.log(
        `[api]   ${s.id.padEnd(6)} ${s.dialect.padEnd(6)} ${s.writable ? 'writable' : 'read-only'}  ${s.label}`,
      );
    }
    console.log('[api] writes    per store — a 403 names the store that refused');
  }

  if (config.db.allowWrites && config.db.mode === 'turso') {
    console.log('[api] note      the ledger is a remote target and ALLOW_REMOTE_WRITES is set — writes are live');
  }
});

void (async () => {
  await applyPragmas();
  await startDbProbe();
  await reportScope();
})();

/**
 * ★ THE LEDGER SCOPE IS DECLARED IN TWO PLACES, SO STARTUP NAMES BOTH.
 *
 * `.env` and the `organization` row can each state a fund, a program list and a
 * fiscal floor, and precedence is per field — so a disagreement is a supported
 * configuration rather than an error. It is still the most confusing state this
 * server can be in, because the Organization screen shows the *row* while the
 * figures are built from the *declaration*: an operator edits the tenant, nothing
 * moves on screen, and no error is raised anywhere. Printing both here is the only
 * cheap way to make that visible.
 *
 * Runs after the probe, inside the background block, so it never delays the port —
 * a scope read that hangs must not stop the API from answering `/api/health`.
 */
async function reportScope(): Promise<void> {
  if (config.db.mode !== 'oracle') return;
  const caps = config.ledgerScope;
  try {
    const tenant = await defaultTenant();
    const scope = resolvedScope(tenant);
    console.log(
      `[api] scope     fund ${scope.funds.join(',')} · programs ${
        scope.programs.length > 0 ? scope.programs.join(',') : '(all under those funds)'
      } · from fiscal ${scope.startFy}`,
    );

    const divergence = scopeDivergence(tenant);
    if (divergence !== null) {
      console.log(`[api] scope     overridden by .env — ${divergence}`);
      console.log('[api] scope     the Organization screen shows the row, not this.');
    }

    console.log(
      `[api] scope     ceilings ${caps.glBalancesMaxRecords.toLocaleString('en-US')} ` +
        `GL_BALANCES rows, ${caps.allMaxRecords.toLocaleString('en-US')} rows total per request`,
    );
  } catch (err) {
    // A scope that cannot be read is not fatal here for the same reason the probe
    // is not: every route that needs it asks again and can name the failure in its
    // own 503.
    console.log(
      `[api] scope     unavailable — ${(err as { message?: string }).message ?? String(err)}`,
    );
  }
}

/**
 * Shutdown.
 *
 * `server.close()` waits for in-flight requests, which is the point — a write
 * half-applied because the process was killed mid-request is worse than a slow
 * restart. The timeout is the backstop for a connection that never drains.
 */
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[api] ${signal} received — draining.`);

  const forced = setTimeout(() => {
    console.error('[api] drain timed out after 10s — exiting.');
    process.exit(1);
  }, 10_000);
  forced.unref();

  server.close(() => {
    void (async () => {
      await closeDb();
      clearTimeout(forced);
      console.log('[api] closed.');
      process.exit(0);
    })();
  });
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  console.error('[api] unhandled rejection:', reason);
});
