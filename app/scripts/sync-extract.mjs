// Copies the Oracle extract — and the logo — into the Vite public folder so the app
// can fetch them at runtime. Keeps app source free of a 2 MB JSON module import, and
// guarantees the served extract is the one on disk (this runs automatically before dev
// and build).
//
// ★ THE LOGO IS SYNCED FOR THE SAME REASON THE EXTRACT IS, RATHER THAN CHECKED IN A
//   SECOND TIME. `data/` is where the art lives and `app/public/` is what the browser
//   is served, and the only way those two stay equal is for one to be produced from the
//   other. A copy pasted into `app/public/images/` would be a second source of truth
//   that no build step and no gate can compare against the first — which is exactly the
//   drift this script exists to prevent for the eight JSON files beside it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../../data/oracle');
const dest = path.resolve(here, '../public/oracle');

if (!fs.existsSync(src)) {
  console.error(`[sync-extract] source folder not found: ${src}`);
  process.exit(1);
}

fs.mkdirSync(dest, { recursive: true });

const files = fs
  .readdirSync(src)
  .filter((f) => f.endsWith('.json'))
  .sort();

if (files.length === 0) {
  console.error(`[sync-extract] no .json files in ${src}`);
  process.exit(1);
}

// The pull writes `full-output.json`; the app fetches `/oracle/output.json`. Doing the rename
// here is what keeps the two names in step. Shipping both would put a 2 MB duplicate in the
// public folder that nothing reads, and `extract.ts` would go on reading an unmanaged file.
const RENAMES = { 'full-output.json': 'output.json' };
const written = new Set();

for (const f of files) {
  const out = RENAMES[f] ?? f;
  const to = path.join(dest, out);
  fs.copyFileSync(path.join(src, f), to);
  const { size } = fs.statSync(to);
  const label = out === f ? f : `${f} -> ${out}`;
  console.log(`  ${label.padEnd(26)} ${(size / 1024).toFixed(0).padStart(6)} KB`);
  written.add(out);
}

// The app fetches `/oracle/output.json`. Anything else in the served folder is either a
// leftover from an earlier layout or a file nothing reads, and leaving those behind is how
// the served extract silently drifts from the one on disk: a refreshed pull would overwrite
// the source, the build would print a byte count and exit 0, and the app would still be
// fetching the previous extract. So this folder is regenerated, not merged.
for (const stale of fs.readdirSync(dest).filter((f) => f.endsWith('.json') && !written.has(f))) {
  fs.rmSync(path.join(dest, stale));
  console.log(`  ${stale.padEnd(26)} ${'removed (stale)'.padStart(15)}`);
}

console.log(`[sync-extract] ${files.length} file(s) -> app/public/oracle`);

// ---------------------------------------------------------------------------
// The logo.
// ---------------------------------------------------------------------------

/**
 * `data/images/` → `app/public/images/`, by the same rule as the folder above:
 * regenerated, not merged.
 *
 * ★ ANY EXTENSION, NOT JUST `.json`. The source folder is art, so the filter that
 *   makes sense for an extract would be wrong here — but the *stale sweep* has to
 *   keep the same narrow scope it has above, or the first PNG added to this folder
 *   would delete every SVG the previous build wrote. Files this run did not write
 *   are removed; files it cannot account for are not.
 *
 * ★ THE FOLDER IS NOT CREATED WHEN THE SOURCE IS MISSING. `data/images/` absent is
 *   a checkout without the art, and an empty `app/public/images/` would turn that
 *   into a broken image on the login screen at run time instead of a missing folder
 *   now. The app's `AppBrand` decides what to show when the fetch fails; this script
 *   does not pretend a folder it never saw is empty on purpose.
 */
const imageSrc = path.resolve(here, '../../data/images');
const imageDest = path.resolve(here, '../public/images');

if (!fs.existsSync(imageSrc)) {
  console.log(`[sync-extract] no ${imageSrc} — skipping the logo`);
} else {
  fs.mkdirSync(imageDest, { recursive: true });

  const images = fs.readdirSync(imageSrc).filter((f) => !f.startsWith('.')).sort();
  const imageWritten = new Set();

  for (const f of images) {
    const to = path.join(imageDest, f);
    fs.copyFileSync(path.join(imageSrc, f), to);
    const { size } = fs.statSync(to);
    console.log(`  images/${f.padEnd(18)} ${(size / 1024).toFixed(0).padStart(6)} KB`);
    imageWritten.add(f);
  }

  for (const stale of fs.readdirSync(imageDest).filter((f) => !imageWritten.has(f))) {
    fs.rmSync(path.join(imageDest, stale));
    console.log(`  images/${stale.padEnd(18)} ${'removed (stale)'.padStart(15)}`);
  }

  console.log(`[sync-extract] ${images.length} image(s) -> app/public/images`);
}
