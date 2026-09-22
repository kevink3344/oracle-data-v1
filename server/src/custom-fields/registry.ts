/**
 * The fields a reader may give a name of their own.
 *
 * ★ THIS MODULE IS THE ONLY PLACE THE (subject, field) PAIRS ARE DECLARED, AND
 *   THAT IS THE WHOLE POINT OF IT EXISTING.
 *
 * The alternative — letting the route accept any `subject`/`field` pair and
 * writing it to `field_override` — would store rows nothing can ever render. The
 * read side joins these rows onto a register in TypeScript, so an override for a
 * field no component reads is not an error the database can produce: it is a
 * silent no-op that looks like a successful save, and the reader is left believing
 * a name was changed when nothing on screen will ever move. Refusing an unlisted
 * pair at the route is how that becomes a 400 with a message naming what IS
 * overridable, instead of a write that appears to work.
 *
 * The DDL says the same thing from the other end (`data/sql/turso/01-app.sql`):
 * there is no CHECK constraint on `subject_kind` or `field`, deliberately, because
 * SQLite cannot relax a CHECK without rebuilding the table and this set is meant
 * to grow — so the validation lives here, where growing it costs one array entry.
 *
 * ---------------------------------------------------------------------------
 * ADDING ENTRY #2, AND WHY IT IS NOT JUST AN ARRAY PUSH
 * ---------------------------------------------------------------------------
 * The three steps, in order:
 *
 *   1. Add the entry to `OVERRIDABLE` below. Nothing else in this file changes.
 *
 *   2. Decide, for the render site, whether the field is a KEY or a LABEL. This is
 *      the measurement that shaped the whole feature: on the vendor register
 *      `name` is *both*. It is a label (`VendorCompanies.tsx` prints it as the
 *      panel heading) and it is a key — `loadMaster(name, …)` resolves the master
 *      record by an exact match on it, `invoiceHref(i, vendor.name)` puts it in a
 *      link as a query parameter, and `groupVendors` groups on `keyOf(name)`. So a
 *      custom vendor name must reach the LABEL and must never reach the lookup,
 *      and the client carries two fields for that reason (`name` and
 *      `displayName`, documented on `Vendor` in `app/src/data/vendors.ts`).
 *
 *      A field that is only a label needs none of that and is a much smaller
 *      change. Read the render site before assuming which one you have: "replace
 *      the value" and "carry a second label" are different features, and the
 *      difference does not show up in a screenshot.
 *
 *      The entry also carries `keyOf` — the fold of the subject's identity. It is
 *      per-entry and required rather than one shared function, because a subject
 *      whose identity is already a key needs no fold at all and one identified by
 *      something else needs a different one; see the property's own doc block.
 *
 *   3. Add a smoke assertion for the pair — a round trip on a throwaway key, with
 *      a control that must fail. `scripts/smoke.ts` has the block.
 *
 * ---------------------------------------------------------------------------
 * WHAT ENTRY #2 ACTUALLY COST (a vendor site’s email — the first field the ledger
 * does not hold at all)
 * ---------------------------------------------------------------------------
 * The three steps above held. One thing they could not have predicted, because
 * there was no instance of it yet:
 *
 * ★ A FIELD THE LEDGER HAS NO COLUMN FOR IS NOT THE SAME FEATURE AS A FIELD THE
 *   LEDGER HOLDS AND A READER REPLACED. Every sentence the render site prints
 *   about an override was written to supersede something — `Oracle holds “…”`,
 *   `Remove the custom email and show the Oracle value`, `No custom value is set,
 *   so this is the ledger’s own.` With an empty ledger value each of those is a
 *   well-formed lie rather than a missing string: nothing throws, nothing is
 *   undefined, and the reader is told something false about the field in front of
 *   them. So the declaration itself carries `fromLedger`, and the component has a
 *   second form of every one of those sentences.
 *
 * The answer is NOT a new variant or a per-field flag on the render site. The
 * difference is a property of the field, so it is declared here, next to the pair
 * and the fold, and the render site has no way to be wrong about it.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO `subject` UNION AND NO PER-FIELD TYPE
 * ---------------------------------------------------------------------------
 * `subject` is a plain string rather than a union of literals because the route
 * looks subjects up in a Map built from this array, so the type adds nothing the
 * lookup does not already enforce — and a union would have to be widened in two
 * places instead of one. `field` likewise: the pair is the identity here, never
 * the field alone, so two subjects may each have a field called `name` without
 * either colliding.
 */

/** One field a reader may override, and how the UI should describe it. */
export interface OverridableField {
  /**
   * What the override is attached to, as the DDL stores it in `subject_kind`.
   *
   * Singular, and matching the register's own vocabulary — `'vendor'`, not
   * `'vendors'` — because this string is also what the read endpoint takes as a
   * query parameter, and a caller should be able to guess it from the page they
   * are looking at.
   */
  subject: string;

  /**
   * The field's name, as the DDL stores it in `field`.
   *
   * The name of the COLUMN on the register's payload, not a display name: the
   * render site is the thing that has to line the two up, and it should be able to
   * do that by reading this string rather than by reading a comment.
   */
  field: string;

  /**
   * The one-anchor phrase the accessible names are built around — a noun phrase
   * for a single record of this subject, said the way a person would say it.
   *
   * ★ THIS EXISTS BECAUSE TWO OF THE PENCIL'S SENTENCES NAME THE RECORD, AND ON A
   *   FIELD WITH NO LEDGER VALUE THE VALUE IS NOT THERE TO NAME IT WITH. The
   *   vendor name's pencil says `Give “ACME SUPPLY” a custom vendor name` — the
   *   ledger's value is the anchor, and it is a good one because it is exactly
   *   what the reader is looking at. A field the ledger does not hold has no such
   *   value, and `Give “” a custom email` is worse than saying nothing: a quoted
   *   empty string reads as a rendering fault. So the fallback anchor is declared
   *   with the field, in the same words the panel uses (`this vendor site`), and
   *   is used only when there is no value to quote.
   */
  subjectWord: string;

  /**
   * How this subject's identity is folded before it is stored as `subject_key`.
   *
   * ★ A FUNCTION ON THE ENTRY RATHER THAN ONE SHARED FOLD, BECAUSE A SUBJECT'S
   *   IDENTITY IS A PROPERTY OF ITS REGISTER AND NOT OF THIS TABLE.
   *
   * A vendor is identified by its name (`WCSEXP_AP_INVOICE_PAYMENTS` carries
   * `VENDOR_NAME` and no id), and a name needs folding — two spellings of one
   * company must be one row. A subject whose identity is already a key would need
   * no fold at all, and one identified by something else again would need a
   * different one. A single module-level fold would make entry #2 store whatever
   * the vendor fold happened to produce for a value that is not a name, and
   * nothing would fail: the write would succeed, the row would be stored, and the
   * page would simply never match it. That is the same silent no-op the header
   * refuses to allow for the pair itself, one level down — so the fold is part of
   * the declaration and forgetting it is a compile error.
   */
  keyOf(value: string): string;

  /**
   * What a reader is told they are changing. Used in the pencil's accessible name
   * and in the tooltip, so it is written as a noun phrase a person would say —
   * "vendor name", not "name".
   */
  label: string;

  /**
   * The longest value worth accepting, enforced by the schema so the refusal is a
   * `VALIDATION_FAILED` naming the limit rather than a truncation nobody is told
   * about.
   *
   * 120, and it is a judgement rather than a limit of the storage: the longest name
   * already on this ledger is 123 characters (measured, `VENDOR_ID` 10049 —
   * "ARENA PLACE CONDOMINIUM ASSOCIATION, INC C/O LUNDY MANAGEMENT GROUP DBA LEE &
   * ASSOCIATES RALEIGH-DURHAM PROPERTY MANAGEMENT"), and the whole point of the
   * feature is to shorten names like that one. A cap generous enough not to be a
   * nuisance and low enough that the column cannot be used as a scratch pad.
   */
  maxLength: number;

  /**
   * Whether the ledger holds a value for this field at all.
   *
   * ★ `true` FOR EVERY FIELD UNTIL ENTRY #2, WHICH IS WHY IT IS DECLARED HERE NOW
   *   RATHER THAN ASSUMED. `true` means the override supersedes something: the
   *   ledger's value is what a reader sees when no override is stored, the trash
   *   gives it back, and every sentence the component prints can quote it. `false`
   *   means there is nothing underneath — the register carries no such column, the
   *   field is this application's own note, and the honest rendering of "no
   *   override" is an empty value rather than a ledger one.
   *
   * The component reads it and chooses its wording; it is not a UI preference. A
   * field with no ledger value that says `Oracle holds “”` is not merely awkward —
   * it tells the reader the value came from somewhere it did not.
   */
  fromLedger: boolean;

  /**
   * One sentence for the tooltip's second line: what the override does NOT do.
   *
   * Every one of these is a sentence about a lookup, a link or a grouping that
   * keeps using the ledger's value — because that is the fact a reader who has just
   * renamed a company is most likely to be wrong about, and the one whose
   * misunderstanding would show up as a wrong screen rather than an error.
   */
  effect: string;
}

/**
 * A vendor's identity: trimmed, uppercased, every non-alphanumeric removed.
 *
 * ★ THIS IS A SECOND COPY OF `keyOf` IN `app/src/data/vendors.ts`, AND THE COPY IS
 *   UNAVOIDABLE — the two live in different packages with different tsconfigs and
 *   nothing imports across them. What makes it safe is that the two are not
 *   allowed to be *different* folds: the client stores an override against
 *   `keyOf(vendor.name)` and the server stores one against the same fold applied
 *   to the key it is sent, so a drift between them does not throw — it silently
 *   stops every override from matching the row it belongs to, and the page goes
 *   back to the ledger's names while the rows sit in the table. `scripts/smoke.ts`
 *   pins this function's output for named real strings for that reason, and the
 *   client's `keyOf` has its own doc block pointing back here.
 *
 * The trim is not cosmetic and is not redundant with the uppercase: `PO_VENDORS`
 * stores names with leading spaces (the first live row is `"  chickfila"`), and the
 * fold is what makes those one company rather than two. It is applied here even
 * though the caller is asked for a trimmed key, because this is the side that owns
 * the stored bytes.
 *
 * ★ WHAT THE FOLD COSTS, STATED RATHER THAN HIDDEN. Removing every
 *   non-alphanumeric means `A & B Supply` and `AB Supply` fold together, so two
 *   companies could share one override. Measured on the data this page reads: 0 of
 *   157 names on the sample database and 0 of 55 on the FY27 extract fold alike, so
 *   on today's ledger it is injective. The page's master-record lookup has the same
 *   caveat for the same reason — the source carries names, not ids — and both say
 *   so rather than pretending a name is a key.
 */
export function foldVendorKey(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * A vendor site's identity: the ledger's own id, trimmed and nothing else.
 *
 * ★ THERE IS NOTHING HERE TO FOLD, AND ADDING A FOLD WOULD BE THE BUG. This
 *   subject's identity is `VENDOR_SITE_ID` — a number the ledger issues, which the
 *   panel prints in its own eyebrow (`Site · 861598`) and which every order row on
 *   the page names. Two spellings of one site do not exist, so the only case left
 *   is a caller who sends the id with a stray space around it. This is the entry
 *   the `keyOf` doc block above anticipates when it says a subject whose identity
 *   is already a key "needs no fold at all".
 *
 * ★ IT IS NOT `foldVendorKey`, AND REUSING THAT ONE HERE IS EXACTLY THE SILENT
 *   NO-OP THIS WHOLE MODULE EXISTS TO PREVENT — only a quieter one. Vendor site
 *   ids are digits, so `foldVendorKey('861598')` is `'861598'` on every row in the
 *   table today: the wrong fold would be right by coincidence, and it would stay
 *   right until the ledger issued an id with anything else in it, at which point
 *   the stored key and the rendered key stop matching and the page silently shows
 *   the ledger's value while the row sits in the table. A fold that is right for a
 *   name has no business being applied to a number that happens to survive it.
 */
export function foldVendorSiteKey(value: string): string {
  return value.trim();
}

/**
 * Every overridable field, in the order the Admin endpoints report them.
 *
 * Two entries, and the two are deliberately different shapes: one is a field the
 * ledger holds and this application may relabel (`fromLedger: true`), and one is a
 * field the ledger has no column for and this application is the only source of
 * (`fromLedger: false`). The comment above says what adding each one cost.
 */
export const OVERRIDABLE: readonly OverridableField[] = [
  {
    subject: 'vendor',
    field: 'name',
    subjectWord: 'this vendor',
    keyOf: foldVendorKey,
    label: 'vendor name',
    maxLength: 120,
    fromLedger: true,
    effect:
      'The name Oracle holds is still what finds the vendor’s master record and builds its invoice links — only the label changes.',
  },
  {
    /**
     * The site, not the vendor: the field is a property of one vendor-site row
     * (`VENDOR_SITE_ID`), which is where the pencil that offers it sits — in the
     * panel's Address card, beside the ledger's own city and phone. A subject of
     * `vendor` would have made one email cover every site a company has, which is
     * not what a reader looking at one address means by it.
     */
    subject: 'vendor_site',
    field: 'email',
    subjectWord: 'this vendor site',
    keyOf: foldVendorSiteKey,
    label: 'email',
    /**
     * 120, the same as the vendor name, rather than the 254 an address may be
     * under RFC 5321. The cap is a judgement about what belongs in this column:
     * a site's correspondence address is a person's mailbox, and the value that
     * matters is that a reader can see it and edit it, not that every technically
     * legal address fits. It also keeps the pair's schema bound identical to the
     * other field's, so `WIDEST_VALUE` in the route does not move.
     */
    maxLength: 120,
    fromLedger: false,
    effect:
      'Oracle holds no email for a site, so nothing in the ledger looks this one up, nothing mails to it and no extract carries it — this is a note this application keeps, and the ledger is unaffected by it.',
  },
] as const;

/** `${subject}/${field}` — the key the lookups below are built on. */
function pairKey(subject: string, field: string): string {
  return `${subject.toLowerCase()}/${field.toLowerCase()}`;
}

const BY_PAIR: ReadonlyMap<string, OverridableField> = new Map(
  OVERRIDABLE.map((f) => [pairKey(f.subject, f.field), f]),
);

/**
 * The entry for a pair, or `undefined` when the field is not overridable.
 *
 * Case-insensitive on both halves: the pair is an identifier an API caller types
 * by hand, and refusing `Vendor`/`Name` when the registry says `vendor`/`name`
 * would be a 400 about capitalisation. The stored `subject_kind` and `field` are
 * always the registry's own spelling, never the caller's — so the table cannot end
 * up with two rows differing only in case.
 */
export function overridable(subject: string, field: string): OverridableField | undefined {
  return BY_PAIR.get(pairKey(subject, field));
}

/** Every field of one subject, for the read endpoint and for the refusals. */
export function overridableIn(subject: string): OverridableField[] {
  const wanted = subject.trim().toLowerCase();
  return OVERRIDABLE.filter((f) => f.subject.toLowerCase() === wanted);
}

/**
 * The registry's own spelling of a subject kind, or `undefined` if nothing is
 * declared for it.
 *
 * ★ THIS EXISTS BECAUSE A LOOKUP IS CASE-INSENSITIVE AND A **COMPARISON** IS NOT.
 * Read a subject's rows with `WHERE subject_kind = :subject` and the bound value
 * has to be the spelling that was *stored*, which is the registry's — SQLite's `=`
 * on TEXT is case-sensitive, so a caller who wrote `?subject=VENDOR` would get an
 * empty list from a table that holds rows, and an empty list is the one answer this
 * endpoint must never give by accident. Passing the caller's string through would
 * make correctness depend on every subject kind in the registry happening to be
 * lower-case, which is a coincidence rather than a rule.
 */
export function overridableSubject(subject: string): string | undefined {
  return overridableIn(subject)[0]?.subject;
}

/**
 * The subjects that carry at least one overridable field, de-duplicated and in
 * registry order — the list a refusal can print, so a caller who guessed the
 * subject wrong is told which ones exist instead of being left to try again.
 */
export function overridableSubjects(): string[] {
  const out: string[] = [];
  for (const f of OVERRIDABLE) if (!out.includes(f.subject)) out.push(f.subject);
  return out;
}
