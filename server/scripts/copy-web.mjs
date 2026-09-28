// Copies the app's build output into the API's public folder, so that one process can serve
// both the app and the API on a single origin.
//
// ★ THIS COPY EXISTS BECAUSE THE TWO HALVES ARE SEPARATE PACKAGES THAT NEVER IMPORT EACH OTHER.
//
//   `app/` is a Vite build and `server/` is a Node process, and neither knows the other exists
//   — which is deliberate, because the database credentials must never reach the browser
//   bundle. What they *do* share is an origin: every request the app makes is a relative
//   `/api/...` path, so in production the built app has to be served by the API process or
//   none of those requests resolve. Development papers over this with the Vite proxy in
//   `app/vite.config.ts`; a built app has no proxy and no configured base URL.
//
//   See the static block in `server/src/app.ts` for the serving half of this arrangement.
//
// ★ `server/public` IS GENERATED, NEVER EDITED. It is git-ignored, wiped on every run and
//   rebuilt from scratch. A copy-into would leave a deleted asset sitting in the deployed site
//   forever, which is the same class of drift that `app/scripts/sync-extract.mjs` exists to
//   prevent for the Oracle extract one folder over.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..', '..', 'app', 'dist');
const dest = path.resolve(here, '..', 'public');

// `index.html` is the app shell and the one file whose absence means "this is not a build".
// Checking it rather than the folder catches an interrupted or empty `vite build`.
if (!fs.existsSync(path.join(src, 'index.html'))) {
  console.error(`[copy-web] no app build found at ${src}`);
  console.error('[copy-web] build it first:  cd app && npm run build');
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });

const entries = fs.readdirSync(dest).length;
console.log(`[copy-web] app build copied to ${path.relative(process.cwd(), dest)} (${entries} top-level entries)`);
