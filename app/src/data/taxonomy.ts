import type { PurposeCode, PurposeMeta } from './types';

/**
 * PURPOSE_ is the budget bucket. Confirmed against the extract: three values, and
 * the 6,560 bucket only ever uses OBJECT_ 529 while 9,000 only ever uses 541.
 * OBJECT_ is *not* a clean child of PURPOSE_ — 529 and 541 each appear under two
 * purposes — which is exactly why the bucket is PURPOSE_ and the line is OBJECT_,
 * not the other way round.
 */
export const PURPOSE_ORDER: PurposeCode[] = ['6570', '9000', '6560'];

export const PURPOSE_META: Record<PurposeCode, PurposeMeta> = {
  '6570': {
    code: '6570',
    label: 'Capital budget',
    short: 'Capital',
    mark: 'b-mark',
    chip: 'cap',
    series: 'cap',
  },
  '9000': {
    code: '9000',
    label: 'Operating budget',
    short: 'Operating',
    mark: 'o-mark',
    chip: 'ope',
    series: 'ope',
  },
  '6560': {
    code: '6560',
    label: 'Relocation budget',
    short: 'Relocation',
    mark: 'x-mark',
    chip: 'oth',
    series: 'oth',
  },
};

/**
 * Friendly OBJECT_ labels. Oracle supplies the code only — these strings are
 * app-native. The extract carries **nine** object codes; the source mockup named
 * seven, so `524` and `531` deliberately have no entry. The UI renders an
 * unlabelled code as a bare code rather than inventing a name, and the dashboard
 * lists them as a coverage gap.
 */
export const OBJECT_LABELS: Record<string, string> = {
  '522': 'Construction, non-CMAR / direct award',
  '523': 'Mechanical & HVAC contracts',
  '526': 'Design & professional services',
  '527': 'Construction, CMAR / GMP',
  '529': 'Testing, inspection & survey',
  '532': 'Advertising, legal & offsite',
  '541': 'Furniture, fixtures & equipment',
};

export const objectLabel = (code: string): string | null => OBJECT_LABELS[code] ?? null;

/** `529 · Testing, inspection & survey`, or just `524` when the code is unlabelled. */
export const objectTitle = (code: string): string => {
  const label = objectLabel(code);
  return label ? `${code} · ${label}` : code;
};

/** The seven segments, in the order they appear in the combination key. */
export const SEGMENT_ORDER = [
  'FUND',
  'PURPOSE',
  'PROGRAM',
  'OBJECT_',
  'LEVEL_',
  'COST_CENTER',
  'FUTURE_USE',
] as const;

/**
 * Segments that never vary — **now measured, not stated.** See `constantSegments()` in `derive.ts`.
 *
 * ★ THE MAP THAT USED TO LIVE HERE IS GONE, AND WHY IT WENT IS WORTH KEEPING. It read
 *   `{ FUND: '04', PROGRAM: '862', COST_CENTER: '0840', FUTURE_USE: '000' }` — a description of the
 *   single extract the app happened to be reading. Its own comment already warned that the chart of
 *   accounts reaches **ten funds, 58 programs and 228 cost centres**, and that `861` appears on 746
 *   combinations chart-wide. Three screens rendered the map and the Dashboard counted its keys.
 *
 *   That was survivable while the app could only ever show one fund and one program. It stopped
 *   being survivable when the account scope became a control a reader can move: four screens would
 *   have gone on asserting "single-valued across the extract" about a set it was no longer describing,
 *   silently, with nothing to make the claim fail loudly.
 *
 *   `constantSegments(lines)` answers the same question against the lines actually being shown, in
 *   `SEGMENT_ORDER`, and returns only the segments that really do hold one value. On the 2,782-line
 *   served extract under the default scope it returns exactly those four — so nothing on screen moves
 *   today, and the moment a scope admits something else, everything that says "fixed" changes with it.
 */

/**
 * What each of the seven segments is for. Oracle supplies codes, not meaning, so
 * these strings are app-native and are the only place a reader is told what a
 * segment holds. Three screens render them — the New-project preview, the
 * combination search and the invoice panel — and they must not drift apart.
 */
export const SEGMENT_ROLE: Record<string, string> = {
  FUND: 'Funding source',
  PURPOSE: 'Budget bucket',
  PROGRAM: 'Program',
  OBJECT_: 'What is bought',
  LEVEL_: 'The level — the thing a project is named after',
  COST_CENTER: 'Cost centre',
  FUTURE_USE: 'Reserved by Oracle',
};

/**
 * `GL_CODE_COMBINATIONS.ACCOUNT_TYPE` — Oracle's own fixed lookup, not an
 * app-native vocabulary: `A` asset, `L` liability, `O` owners' equity, `R`
 * revenue, `E` expense. Only the code travels in the extract.
 *
 * ★ The invoice distributions carry three of the five. Expense dominates by
 *   count, but **asset and liability are not typos**: 1,003 and 1,150 of the
 *   window's 5,347 (invoice, account) rows are one or the other, and the second
 *   most-drawn single account in the window is an asset. So a screen that
 *   assumed "expense" and printed it unqualified would be wrong about roughly
 *   two rows in five, which is why the type is read from the row and shown.
 */
export const ACCOUNT_TYPE_LABEL: Record<string, string> = {
  A: 'Asset',
  L: 'Liability',
  O: "Owners' equity",
  R: 'Revenue',
  E: 'Expense',
};

/** The account's type in words, or the bare code for one this list does not know. */
export const accountTypeLabel = (code: string): string =>
  ACCOUNT_TYPE_LABEL[code] ?? (code || 'Type not recorded');
