/**
 * A human name turned into a stable URL key.
 *
 * `North Garner MS – Renovation` → `north-garner-ms-renovation`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A FILE AND NOT TWO COPIES
 * ---------------------------------------------------------------------------
 * The rule was written inside `routes/projectRegistry.ts`, where it read the
 * convention back out of the project seed. Organizations need the same rule for
 * the same reason — a name is what a person types, and a name is not a key —
 * so it moved here rather than being typed a second time.
 *
 * The failure a second copy produces is specific and quiet: the two slugs stop
 * being predictable from each other the moment one of them is improved, and
 * nothing fails. A key that is *nearly* the same rule is still a different key.
 *
 * ---------------------------------------------------------------------------
 * ★ THE ACCENT FOLDING IS LOAD-BEARING, NOT DECORATIVE
 * ---------------------------------------------------------------------------
 * The seeds use en dashes — `Fuquay-Varina ES – Renovation`. Without the NFKD
 * pass and the combining-mark strip, `–` survives into the key of some names and
 * not others depending on which half of the pipeline caught it first, and the
 * keys stop being predictable from the names.
 *
 * Slicing to 72 characters and re-trimming the trailing hyphen afterwards is
 * deliberate: three seeded projects would otherwise have keys ending in a dash,
 * because the slice can land in the middle of a word boundary.
 */
export function slugFor(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72)
    .replace(/-+$/g, '');
}
