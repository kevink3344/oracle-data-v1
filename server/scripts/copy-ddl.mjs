// Copies the app-store DDL into the server package, so the deployed process can find it.
//
// ★ THIS COPY EXISTS BECAUSE THE DDL IS READ AT REQUEST TIME FROM A REPO-ROOT PATH.
//
//   `db/app-schema.ts` applies `01-app.sql` lazily, on the first call to an app-owned
//   endpoint, and it used to resolve that file through `REPO_ROOT` — `server/src/config`
//   → `..`, `..`, `..`. That is correct in a checkout and wrong in a deployment:
//   the workflow publishes `server/` alone (`package: server`), so on App Service
//   everything above it is missing and `REPO_ROOT` resolves to `/home/site` while the
//   code sits in `/home/site/wwwroot`.
//
//   Measured on the dev slot, before this script existed:
//
//       [db] app schema failed: could not read /home/site/data/sql/sqlserver/01-app.sql:
//       ENOENT: no such file or directory
//
//   `apply()` throws, `ensureAppSchema()` records `failed`, and `requireAppSchema()`
//   answers 503 `DB_UNAVAILABLE` — which took out *every* app-owned endpoint at once
//   (the project registry, saved views, read caps, pins, organizations). The extract
//   kept serving, so the site looked alive and simply showed no projects: the register
//   is what annotates the 266 levels, and the register could not be read.
//
//   The fix is to make the file part of the package rather than a sibling of it, which
//   is what this script does. `db/app-schema.ts` now looks in `server/ddl/` first and
//   keeps `REPO_ROOT/data/sql` as a development fallback, so running `src/` through tsx
//   (`npm run dev`, `npm run smoke`) still works without a build.
//
// ★ `server/ddl` IS GENERATED, NEVER EDITED — the same rule as `server/public`. It is
//   wiped on every run and rebuilt from `data/sql/`, which stays the single source of
//   truth, because a copy-into would leave an edited file in place and the deployed
//   schema would silently stop matching the committed one.
//
// ★ IT FAILS THE BUILD RATHER THAN COPYING NOTHING. A missing source directory, or a
//   dialect folder without `01-app.sql`, means the package would deploy with no DDL —
//   which is precisely the outage this script was written to end. Exiting non-zero here
//   turns a 503 discovered in production into a red build step that names the file.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..', '..', 'data', 'sql');
const dest = path.resolve(here, '..', 'ddl');

// ★ THE DIALECT FOLDERS ARE NOT COPIED — ONLY THE ONE FILE THE APPLIER READS.
//
//   `data/sql/turso/` also holds `sample.db` and `app.db` (multi-megabyte SQLite
//   files), `queries`, a README and other `.sql` scripts. None of them is read by
//   `db/app-schema.ts`, which opens exactly one path and only ever `01-app.sql`.
//   Copying the folder wholesale put a binary sample database into the deployment
//   package — weight the API process never opens, and a second copy of a file that
//   already has a home. A build step should ship what the process reads.
//
//   So the copy is per-file and named, which also makes the failure mode obvious:
//   the thing that must exist is the thing listed, not whatever a glob happened to
//   match on the machine that ran the build.
const DIALECTS = ['turso', 'sqlserver'];

// The DDL file, and the only file copied. Its absence caused the outage, so it is
// checked by name rather than inferred from a folder listing.
const REQUIRED = '01-app.sql';

if (!fs.existsSync(src)) {
  console.error(`[copy-ddl] no DDL source found at ${src}`);
  console.error('[copy-ddl] this script expects the repo layout: data/sql/<dialect>/01-app.sql');
  process.exit(1);
}

for (const dialect of DIALECTS) {
  const file = path.join(src, dialect, REQUIRED);
  if (!fs.existsSync(file)) {
    console.error(`[copy-ddl] missing ${file}`);
    console.error('[copy-ddl] the deployed API cannot create its own tables without it.');
    process.exit(1);
  }
}

fs.rmSync(dest, { recursive: true, force: true });

const copied = [];
for (const dialect of DIALECTS) {
  const to = path.join(dest, dialect);
  fs.mkdirSync(to, { recursive: true });
  fs.copyFileSync(path.join(src, dialect, REQUIRED), path.join(to, REQUIRED));
  copied.push(`${dialect}/${REQUIRED}`);
}

console.log(
  `[copy-ddl] DDL copied to ${path.relative(process.cwd(), dest)} (${copied.length} file(s)): ${copied.join(', ')}`,
);
