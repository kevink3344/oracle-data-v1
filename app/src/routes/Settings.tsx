/**
 * Settings — the organization register.
 *
 * ── WHAT THIS PAGE IS
 *
 * One accordion, holding the list of tenants and the form that makes another. It is
 * the whole of Phase 1's screen: the tables, the sign-in, the gear and this page. A
 * tenant is a **fund, a set of programs and a start fiscal year** applied to the
 * ledger, and this is the only place the tuple is written down.
 *
 * ── ★ THE ROW CARRIES A MEASUREMENT, NOT JUST A CONFIGURATION
 *
 * A list of three tuples would let a person configure something that selects nothing
 * and still look satisfied. So every row says how many rows of the extract it
 * actually selects, and a tenant that selects none says **`No rows found`** rather
 * than `0`. That sentence is the difference between "this is empty today" and "this
 * is wrong", and only one of them is worth acting on.
 *
 * ── ★ THE COUNT IS TAKEN HERE, ON THE CLIENT, AND THAT WAS THE SERVER'S DECISION
 *
 * `routes/organizations.ts` deliberately does **not** send a per-row line count, and
 * its header says why: the count that matters is "rows of the extract this scope
 * selects", and the tables that carry the fund and the program are not the tables a
 * per-organization query would naturally reach. A second implementation of the scope
 * rule inside the API would be a second answer to a question this app already answers
 * in exactly one place. So the count comes from `rowsInScope`, the same function the
 * PO register is filtered by, over the lines the store already fetched. One rule,
 * one answer, no round trip.
 *
 * ── ★ THE SENTENCE THE FORM PRINTS IS ABOUT THE SELECTION, NOT ABOUT THE WHOLE FILE
 *
 * "removes 0 of 2,781 rows" means 0 of the rows *this fund and these programs
 * select*. For the seeded tenant that is all of them, so the two readings agree
 * today — which is exactly why the wording says "here" and the denominator is
 * printed. The plan quotes 2,782; the app counts 2,781, because it counts live lines
 * and one extract row carries `CANCEL_FLAG = 'Y'`. That difference is stated in
 * `data/scope.ts` at length and is not a bug in this page.
 *
 * ── ★ A ROW IS EDITED IN THE DRAWER, AND THE DRAWER SENDS A DIFF
 *
 * `Edit` on a row slides `OrgPanel` in from the right — the same `.drawer` primitive
 * the check details, the PO detail and the funding combination panels use, with the
 * same Escape-to-close, Tab trap, focus hand-back and drag-to-resize. It reuses
 * `ScopeFields`, so the four controls in the panel are literally the controls in the
 * create form rather than a second implementation of them, and the sentence under the
 * start year is the same `startFyEffect`.
 *
 * ── ★ AND MAKING AN ACCOUNT IS THE SAME GESTURE IN THE SAME PLACE
 *
 * `+ New` on the account register slides `NewUserPanel` in from the right, with the
 * same shell and the same Escape, trap and resize — and, deliberately, the same
 * remembered width, because it asks the account panel's own six questions and nothing
 * else. It began as a form that opened inside the accordion underneath the list, and
 * the reason it is not one now is not that a drawer looks better: the fields were
 * pushed further down the page by every row the register gained, so the act of adding
 * an account scrolled the fields for it out of reach. Only one of the two account
 * panels is ever open, which is the rule the organization pair already follows.
 *
 * The panel does **not** post the four fields. It posts only the ones that differ,
 * because `PATCH /api/organizations/{slug}` refuses a body that names no fields with
 * `400 BAD_REQUEST` — deliberately, so an empty update cannot answer `200` and let a
 * caller believe it edited something. "Nothing has changed" is therefore a state this
 * page has to work out for itself, which is what `diffOf` returning `null` is for.
 *
 * ── ★ AND A SECOND REGISTER, BECAUSE "WHO ELSE EXISTS" IS TWO QUESTIONS
 *
 * The page holds two accordions: the tenants, and the accounts and the roles they
 * hold, read from `GET /api/users`. They belong on one page because they are one
 * decision seen from two sides — an account has to belong to at least one
 * organization, so the second register means nothing without the first, and the first
 * is a list of tenants nobody can sign in to until the second names somebody. The
 * rail's `/admin/users` leaf, which pointed at a screen of its own, is **retired
 * rather than repointed**: the feature lives here, and a second address for it would
 * be a second thing to keep true.
 *
 * ★ NOTHING HERE DELETES, DISABLES OR UN-ROLES ANYBODY, AND THAT IS A DECISION
 *   RATHER THAN AN UNFINISHED HALF. A register like this is the natural place to put a
 *   `Remove` button, and the reason there is not one is that none of the three things
 *   it would do is reversible from this screen: `app_user` rows are referenced by the
 *   writes those accounts made, and nothing in this app can un-read a ledger somebody
 *   has already read. The write endpoints offer create, patch and set-password; this
 *   page offers exactly that and says so where the button would have been.
 *
 * ── ★ TWO STATES ARE SHOWN AND NOT REPAIRED, AND THE SERVER COUNTS THEM
 *
 * An account can hold no organization, or no password. **Both cannot sign in**, for
 * two different reasons, and `counts.unassigned` and `counts.withoutPassword` are the
 * server's queue rather than something derived here from the rows — "derived on the
 * client" is where two screens start disagreeing about the same account. They are
 * printed as a queue with the action named, because a register that listed both as
 * ordinary rows would show a person an account that looks fine and is not.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Chip } from '../components/Chip';
import ResizeGrip, { clampWidth, readStoredWidth, storeWidth } from '../components/ResizeGrip';
import {
  ApiError,
  acceptedValues,
  createOrganization,
  loadOrganizationOptions,
  loadOrganizations,
  scopeOf,
  updateOrganization,
  type Organization,
  type OrganizationList,
  type OrganizationOptions,
  type OrganizationUpdate,
  type ProgramOption,
} from '../data/organizations';
import { fiscalYearStart, rowsInScope, scopeSpoken, type Scope } from '../data/scope';
import { isSuperAdmin, refreshSession, roleLabel, useSession, type Role } from '../data/session';
import { useShowSql } from '../data/showSql';
import {
  createUser,
  loadUsers,
  setUserPassword,
  updateUser,
  type AppUser,
  type RoleCapability,
  type UserList,
  type UserUpdate,
} from '../data/users';
import { useStore } from '../state/store';

/** The program pairs the chart of accounts offers under one fund. */
function programsFor(options: OrganizationOptions | null, fund: string): ProgramOption[] {
  if (!options) return [];
  return options.programs.filter((pair) => pair.fund === fund);
}

/**
 * The start-FY sentence, and the arithmetic behind it.
 *
 * ★ IT IS ONE FUNCTION AND NOT TWO. The sentence and the number it prints have to be
 *   the same number, so the count is returned alongside the words rather than
 *   recomputed by the caller — a page that says "removes 1,544" beside a preview that
 *   says "1,543 rows" is the kind of disagreement this app keeps finding in itself.
 */
function startFyEffect(
  startFy: number,
  scope: Scope,
  lines: readonly { orderDate: string; fund: string; program: string }[],
): { sentence: string; removed: number; matched: number } {
  const mine = rowsInScope(scope, lines);
  if (mine.length === 0) {
    return {
      sentence: `Start FY ${startFy} has nothing to remove: this fund and these programs match no rows in the extract.`,
      removed: 0,
      matched: 0,
    };
  }

  const opens = fiscalYearStart(startFy);
  const removed = mine.filter((line) => line.orderDate < opens).length;
  const earliest = mine.reduce(
    (min, line) => (line.orderDate < min ? line.orderDate : min),
    mine[0]!.orderDate,
  );

  return {
    sentence: `Start FY ${startFy} removes ${removed.toLocaleString()} of ${mine.length.toLocaleString()} rows — the earliest order date here is ${earliest}.`,
    removed,
    matched: mine.length,
  };
}

// ---------------------------------------------------------------------------
// The four values, as a form holds them.
// ---------------------------------------------------------------------------

/**
 * One organization's four fields, all as **strings**.
 *
 * ★ THE FORM'S FLAT COPY, AND EVERYTHING THAT READS IT GOES THROUGH HERE. Both the
 *   create form and the edit panel work on this, and so does `diffOf` — which is what
 *   makes "the panel posts only what changed" checkable rather than a claim. Typing
 *   the four values twice (once per caller) is how a create form and an edit form
 *   drift apart, and the start year is the field where that shows: it is a number on
 *   the wire and a string in an `<input>`, so a second implementation would be a
 *   second place to get the conversion wrong.
 */
interface Draft {
  name: string;
  fund: string;
  programs: string[];
  startFy: string;
}

const BLANK: Draft = { name: '', fund: '', programs: [], startFy: '' };

/**
 * How the start-year box reads, in one place.
 *
 * ★ `shaped` AND `outside` ARE KEPT APART BECAUSE THE TWO MISTAKES HAVE DIFFERENT
 *   FIXES. `20x4` is not a year and the answer is "type four digits"; `2019` is a
 *   year the ledger holds no period for and the answer is "pick one between FY2022
 *   and FY2028". Collapsing them into one `valid` flag produced a message that told a
 *   person their typo was outside a range it was never inside.
 *
 * ★ AND `ok` IS TRUE WHEN THERE ARE NO BOUNDS, WHICH IS NOT A LICENCE. `fiscalYears`
 *   is `null` when the ledger states no periods at all — the server is explicit that
 *   this is "the ledger has no opinion" rather than "no year is allowed", and its own
 *   `assertStartFy` returns early in that case. A client that refused every year here
 *   would block a write the server would accept.
 */
function fyState(
  startFy: string,
  options: OrganizationOptions | null,
): { ok: boolean; year: number; shaped: boolean; outside: boolean } {
  const text = startFy.trim();
  const year = Number(text);
  const shaped = /^[0-9]{4}$/.test(text) && Number.isFinite(year);
  const years = options?.fiscalYears ?? null;
  const outside = shaped && years !== null && (year < years.earliest || year > years.latest);
  return { ok: shaped && !outside, year, shaped, outside };
}

/** Whether a draft carries everything the server requires. Used by both forms. */
function draftComplete(draft: Draft, options: OrganizationOptions | null): boolean {
  if (draft.name.trim() === '') return false;
  if (draft.fund === '') return false;
  return fyState(draft.startFy, options).ok;
}

/** Two program selections compared as sets. See `diffOf`. */
function samePrograms(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((code, i) => code === right[i]);
}

/**
 * The fields that actually differ, or `null` when none do.
 *
 * ★ `null` AND NOT `{}`. The server refuses a patch that names no fields with
 *   `400 BAD_REQUEST — No fields were supplied.`, and its note says why: an empty
 *   update would otherwise answer `200` with a row the caller believes it edited.
 *   So "nothing has changed" has to be a state the panel recognises **before**
 *   sending, which is what `null` is for — it disables Save and says why, instead of
 *   posting `{}` and then having to explain a 400 nobody asked for.
 *
 * ★ `programs` IS COMPARED AS A SET, AND THE SERVER IS RIGHT NOT TO SORT IT. The
 *   `ProgramsSchema` note is explicit that the order is preserved on write and never
 *   sorted there, because it is the order the programs are offered to a reader. But
 *   this panel's picker is a list of checkboxes, so the order it can produce is only
 *   ever `.sort()`ed — **a re-ordered selection is not a change a person can make in
 *   this panel**, and comparing the arrays positionally would invent one, send a patch
 *   that alters nothing, and leave Save enabled forever after a save.
 */
function diffOf(row: Organization, draft: Draft): OrganizationUpdate | null {
  const patch: OrganizationUpdate = {};

  const name = draft.name.trim();
  if (name !== row.name) patch.name = name;
  if (draft.fund !== row.fund) patch.fund = draft.fund;
  if (!samePrograms(draft.programs, row.programs)) patch.programs = [...draft.programs];

  const year = Number(draft.startFy);
  if (Number.isFinite(year) && year !== row.startFy) patch.startFy = year;

  return Object.keys(patch).length > 0 ? patch : null;
}

/** `a` · `a and b` · `a, b and c`. */
function sentenceList(parts: string[]): string {
  if (parts.length === 0) return 'nothing';
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** What a patch touched, as words, for the panel's success notice. */
function describePatch(patch: OrganizationUpdate): string {
  const parts: string[] = [];
  if (patch.name !== undefined) parts.push('the name');
  if (patch.fund !== undefined) parts.push('the fund');
  if (patch.programs !== undefined) {
    parts.push(patch.programs.length === 0 ? 'the programs, now none' : 'the programs');
  }
  if (patch.startFy !== undefined) parts.push('the start fiscal year');
  return sentenceList(parts);
}

// ---------------------------------------------------------------------------
// The account register — a second set of helpers, for a second record.
// ---------------------------------------------------------------------------

/** The draft the account form works on, in the create form and the edit panel both. */
interface UserDraft {
  name: string;
  email: string;
  role: Role;
  /** The organization ids this account belongs to. Never empty on a saveable draft. */
  memberships: number[];
  /** Which of those it signs in to, or `null` while that is still unanswered. */
  primary: number | null;
  /** Create only. Changing an existing account's password is a separate request. */
  password: string;
}

/**
 * ★ `staff` AND NOT `roles[0]`, AND THAT IS THE WHOLE REASON THIS CONSTANT EXISTS.
 *
 * `roles` arrives most-privileged-first *deliberately* — `routes/users.ts` says so
 * where it builds it, so that a picker which simply binds to its first entry is a
 * picker whose default is `super_admin`, "a thing to be aware of rather than to accept
 * by accident". This screen is that picker, so it applies the default itself: the
 * least privileged role is preselected while the list stays in the server's order.
 */
const BLANK_USER: UserDraft = {
  name: '',
  email: '',
  role: 'staff',
  memberships: [],
  primary: null,
  password: '',
};

/** The server's own minimum, which the form checks so the refusal is not the first news. */
const PASSWORD_MIN = 8;

/**
 * The three roles, for the one place a `<select>` has to get a `string` back.
 *
 * ★ THIS IS NOT A SECOND VOCABULARY. The options are rendered from `register.roles` —
 *   the server's list, in the server's order — and this array exists only so that
 *   `event.target.value`, which is a `string` by construction, can be narrowed to
 *   `Role` without a cast. A fourth role on the wire renders as an option and then
 *   fails to narrow here, which is a visible bug rather than a silent one.
 */
const ROLE_VALUES: readonly Role[] = ['super_admin', 'administrator', 'staff'];

function asRole(value: string): Role | null {
  return ROLE_VALUES.some((role) => role === value) ? (value as Role) : null;
}

/** The server's capability entry for one role, or `null` when it sent no table. */
function capabilityFor(register: UserList | null, role: Role): RoleCapability | null {
  if (!register) return null;
  return register.capabilities.find((entry) => entry.role === role) ?? null;
}

/**
 * The day part of a server timestamp.
 *
 * ★ IT SLICES AND DOES NOT PARSE. `new Date(...)` on an ISO string reads it as UTC and
 *   then renders it in the browser's zone, which moves every timestamp before 05:00
 *   local to the day before — a drawer confidently saying somebody signed in on the
 *   12th when the register says the 13th. The first ten characters of an ISO 8601
 *   string are the day and nothing has to be interpreted to get them.
 */
function dayPart(value: string): string {
  return value.slice(0, 10);
}

/** Two id lists compared as sets — the same argument `samePrograms` makes. */
function sameIds(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort((x, y) => x - y);
  const right = [...b].sort((x, y) => x - y);
  return left.every((id, i) => id === right[i]);
}

/**
 * Whether a draft carries everything the server requires of an account.
 *
 * ★ THE SIGN-IN ORGANIZATION IS REQUIRED ONLY WHEN THERE IS A CHOICE. `resolvePrimary`
 *   in `routes/users.ts` insists on an explicit `primaryOrganizationId` when more than
 *   one organization is named, and *infers* it when exactly one is — because with one
 *   membership there is only one possible answer, so filling it in is not a choice
 *   being made on the caller's behalf. Requiring it always would refuse a save the
 *   server would accept; never requiring it would post a two-membership body the
 *   server refuses with a 400 about a field the form never showed.
 *
 * ★ `create` IS A PARAMETER BECAUSE OF THE ADDRESS. A new account is named by its
 *   email, and `PATCH` cannot change one — `UserUpdate` has no `email` field at all —
 *   so the address is required in one form and read-only in the other.
 */
function userDraftComplete(draft: UserDraft, create: boolean): boolean {
  if (draft.name.trim() === '') return false;
  if (create && draft.email.trim() === '') return false;
  if (draft.memberships.length === 0) return false;
  if (draft.memberships.length > 1 && draft.primary === null) return false;
  if (create && draft.password.length < PASSWORD_MIN) return false;
  return true;
}

/**
 * The fields of an account that actually differ, or `null` when none do.
 *
 * ★ `organizations` IS SENT WHENEVER THE SET MOVED, EVEN IF THE SIGN-IN ANSWER DID
 *   NOT — and the primary rides along with it. The patch **replaces** the set rather
 *   than merging into it, so a set sent without its primary is how a patch removes an
 *   account's way in without saying so: the server's `resolvePrimary` keeps the current
 *   primary when the new set still contains it, infers it when the set has one entry,
 *   and refuses otherwise. Sending it explicitly whenever the set is touched means the
 *   request says which organization the account signs in to instead of leaving the
 *   server to work it out from a set this form just rewrote.
 *
 * ★ AND `primaryOrganizationId: null` IS NOT REPRESENTABLE, WHICH IS NOT AN OVERSIGHT.
 *   `UserUpdate` has no `null` in it, because the server refuses one: an account with
 *   no sign-in organization cannot sign in, so clearing it is not a thing a patch is
 *   allowed to do however it is spelled.
 */
function diffOfUser(row: AppUser, draft: UserDraft): UserUpdate | null {
  const patch: UserUpdate = {};

  const name = draft.name.trim();
  if (name !== row.name) patch.name = name;
  if (draft.role !== row.role) patch.role = draft.role;

  const held = row.organizations.map((org) => org.id);
  const moved = !sameIds(draft.memberships, held);
  if (moved) patch.organizations = [...draft.memberships].sort((x, y) => x - y);
  if (draft.primary !== null && (moved || draft.primary !== row.primaryOrganizationId)) {
    patch.primaryOrganizationId = draft.primary;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

/** What a patch touched, as words, for the panel's success notice. */
function describeUserPatch(patch: UserUpdate): string {
  const parts: string[] = [];
  if (patch.name !== undefined) parts.push('the name');
  if (patch.role !== undefined) parts.push('the role');
  if (patch.organizations !== undefined) parts.push('the organizations');
  if (patch.primaryOrganizationId !== undefined) parts.push('the sign-in organization');
  return sentenceList(parts);
}

/**
 * A password worth handing to somebody, for when the administrator has none in mind.
 *
 * ★ REJECTION SAMPLING, NOT `n % alphabet.length`. The modulo is what everybody writes
 *   and it is quietly biased: 256 is not a multiple of 56, so the first 32 characters
 *   come up marginally more often than the last 24. The bias is around one part in
 *   10^7 per character, nobody would ever measure it, and that is exactly the argument
 *   for spending three lines so that it is not there — a generator that is *nearly*
 *   uniform is a thing a reviewer has to check rather than a thing they can read.
 *
 * ★ THE ALPHABET DROPS `l`, `I`, `O` AND `0`. A generated password is read off one
 *   screen and typed into another, and those four are the pairs people get wrong.
 *   Length is bought instead: sixteen characters over fifty-six symbols.
 */
const PASSWORD_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** The largest multiple of the alphabet length that fits in a byte — the accept floor. */
const PASSWORD_CEILING = 224;

function suggestPassword(length = 16): string {
  const out: string[] = [];
  const byte = new Uint8Array(1);
  while (out.length < length) {
    crypto.getRandomValues(byte);
    const n = byte[0] ?? 0;
    if (n >= PASSWORD_CEILING) continue;
    out.push(PASSWORD_ALPHABET[n % PASSWORD_ALPHABET.length]!);
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// The four controls, written once for both the create form and the edit panel.
// ---------------------------------------------------------------------------

/**
 * Name, fund, programs and start fiscal year — the whole record.
 *
 * ★ IT RENDERS A FRAGMENT, NOT A `<form>`, AND THAT IS WHAT LETS IT BE SHARED. The
 *   create form posts and the edit panel patches; the fields are identical and the
 *   submit is not. So the caller owns the `<form>`, the ids are built from an
 *   `idPrefix` the caller supplies, and `nameHint` is the one sentence that genuinely
 *   differs — the create form previews a slug that does not exist yet, the panel says
 *   the slug will not move.
 */
function ScopeFields({
  idPrefix,
  draft,
  onChange,
  options,
  lines,
  nameHint,
}: {
  idPrefix: string;
  draft: Draft;
  onChange: (patch: Partial<Draft>) => void;
  options: OrganizationOptions | null;
  lines: readonly { orderDate: string; fund: string; program: string }[];
  nameHint: ReactNode;
}) {
  const offered = programsFor(options, draft.fund);
  const offeredCodes = offered.map((pair) => pair.program);
  // ★ SHOWN, NOT DROPPED. A program the current fund does not pair with is kept in
  //   the selection and labelled "not paired", because dropping it would silently
  //   narrow the record: a person switching funds to look at one would lose the codes
  //   they never touched, and the save that followed would be a save they did not ask
  //   for. The list says what is inconsistent; it does not tidy it away.
  const unpaired = draft.programs.filter((code) => !offeredCodes.includes(code));
  const scope: Scope = { fund: draft.fund, programs: draft.programs };

  const fy = fyState(draft.startFy, options);
  const effect = fy.ok
    ? startFyEffect(fy.year, scope, lines)
    : { sentence: 'A start year makes the difference exact.', removed: 0, matched: 0 };
  const reached = rowsInScope(scope, lines).length;
  const years = options?.fiscalYears ?? null;

  const toggle = (code: string) =>
    onChange({
      programs: draft.programs.includes(code)
        ? draft.programs.filter((other) => other !== code)
        : [...draft.programs, code].sort(),
    });

  return (
    <>
      <div className="field">
        <label className="field__label" htmlFor={`${idPrefix}-name`}>
          Name <span className="field__req">required</span>
        </label>
        <input
          id={`${idPrefix}-name`}
          className="input"
          type="text"
          autoComplete="off"
          value={draft.name}
          placeholder="e.g. Athens Drive High School"
          onChange={(event) => onChange({ name: event.target.value })}
        />
        <p className="field__hint">{nameHint}</p>
      </div>

      <div className="field">
        <label className="field__label" htmlFor={`${idPrefix}-fund`}>
          Fund <span className="field__req">required</span>
        </label>
        <select
          id={`${idPrefix}-fund`}
          className="input"
          value={draft.fund}
          onChange={(event) => onChange({ fund: event.target.value })}
        >
          <option value="">Choose a fund…</option>
          {(options?.funds ?? []).map((option) => (
            <option key={option.fund} value={option.fund}>
              {option.fund} · {option.combinations.toLocaleString()} account combinations
            </option>
          ))}
        </select>
        <p className="field__hint">
          Read from the chart of accounts. Fund <code>00</code> is not offered — it is the unresolved
          placeholder, and a tenant scoped to it would select nothing while looking configured.
        </p>
      </div>

      <div className="field">
        <span className="field__label" id={`${idPrefix}-programs-label`}>
          Programs
        </span>
        <div className="picklist" role="group" aria-labelledby={`${idPrefix}-programs-label`}>
          {draft.fund === '' ? (
            <p className="field__hint">Choose a fund first — programs belong to one.</p>
          ) : offered.length === 0 && unpaired.length === 0 ? (
            <p className="field__hint">
              The chart of accounts pairs no program with Fund {draft.fund}. Leaving the selection
              empty makes the fund alone the rule.
            </p>
          ) : (
            <>
              {offered.map((pair) => (
                <label className="opt" key={pair.program}>
                  <input
                    type="checkbox"
                    checked={draft.programs.includes(pair.program)}
                    onChange={() => toggle(pair.program)}
                  />
                  <span className="opt__code">{pair.program}</span>
                  <span className="opt__meta">
                    {pair.combinations.toLocaleString()}{' '}
                    {pair.combinations === 1 ? 'combination' : 'combinations'}
                  </span>
                </label>
              ))}
              {unpaired.map((code) => (
                <label className="opt opt--loose" key={code}>
                  <input type="checkbox" checked onChange={() => toggle(code)} />
                  <span className="opt__code">{code}</span>
                  <span className="opt__meta">not paired with Fund {draft.fund} in the chart</span>
                </label>
              ))}
            </>
          )}
        </div>
        <p className="field__hint">
          More than one may be chosen. The server checks a program for shape and not for membership of
          this list, so a code the chart does not pair with the fund is a legitimate configuration
          rather than an error — which is why one kept above says so instead of vanishing.
        </p>
      </div>

      <div className={`field${draft.startFy.trim() !== '' && !fy.ok ? ' field--bad' : ''}`}>
        <label className="field__label" htmlFor={`${idPrefix}-fy`}>
          Start FY <span className="field__req">required</span>
        </label>
        <input
          id={`${idPrefix}-fy`}
          className="input input--short"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={draft.startFy}
          placeholder="2022"
          onChange={(event) => onChange({ startFy: event.target.value })}
          aria-describedby={`${idPrefix}-fy-effect`}
        />
        <p className="field__hint" id={`${idPrefix}-fy-effect`}>
          {effect.sentence}
          {years && fy.outside ? (
            <>
              {' '}
              This ledger&rsquo;s periods run FY {years.earliest} to FY {years.latest}, so{' '}
              {draft.startFy.trim()} is outside them.
            </>
          ) : null}
        </p>
      </div>

      <div className="preview" aria-live="polite">
        <span className="preview__label">Reads as</span>
        <p className="preview__scope">
          {draft.fund === '' ? 'Nothing chosen yet' : scopeSpoken(scope)} · from FY{' '}
          {fy.ok ? fy.year : '…'}
        </p>
        <p className="preview__rows">
          {draft.fund === ''
            ? 'A fund and its programs decide which rows this organization sees.'
            : reached === 0
              ? 'No rows of the extract match this selection.'
              : `${reached.toLocaleString()} of ${lines.length.toLocaleString()} rows in the extract, less ${effect.removed.toLocaleString()} before the fiscal year opens.`}
        </p>
      </div>
    </>
  );
}

/**
 * The switch that shows the SQL behind the figures.
 *
 * ── WHY IT IS ON THIS PAGE AND NOT A PAGE-LEVEL CONTROL
 *
 * It is a *reading* preference rather than a property of any one screen: turning it on changes a
 * dozen pages at once, so the control belongs where the other deployment-wide settings live. It is
 * deliberately **not** behind `requireSuperAdmin` — staff checking a figure are exactly the people
 * who need it, and the panel below the register is reachable by a member while the register itself
 * is not.
 *
 * ── ★ THE WORKED EXAMPLE IS THE POINT OF THE PANEL
 *
 * A checkbox labelled "show SQL" asks a person to switch on something they cannot see. The demo
 * statement below it is inert — it is a literal, not a request — and it shows the *shape* of what
 * will appear: a real statement, in the annotation colour, at the size it will be. Somebody who
 * does not want that on every page can decide before they turn it on, which is the difference
 * between a preference and a surprise.
 */
function SqlPreferencePanel() {
  const [on, setOn] = useShowSql();

  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">Show the SQL behind the figures</h2>
        <span className="panel__count">{on ? 'on' : 'off'}</span>
      </div>
      <div className="panel__body">
        <div className="sqlpref">
          <div className="sqlpref__row">
            <input
              type="checkbox"
              id="show-sql"
              checked={on}
              onChange={(event) => setOn(event.target.checked)}
            />
            <div className="sqlpref__text">
              <label className="sqlpref__label" htmlFor="show-sql">
                Show the statement each figure was computed from
              </label>
              <span className="sqlpref__hint">
                Adds the SQL to the scope note beside a register, under each stat card, and once at
                the foot of the page — in red, with the time and row count each statement returned.
                The statement is the one the server actually ran, not a copy written here, so what
                you read is what produced the number.
              </span>
            </div>
          </div>

          <div className="sqlpref__demo" aria-hidden="true">
            <code>
              SELECT COUNT(*) AS n FROM ( SELECT "BUDGET_VERSION_ID", "BUDGET_NAME" FROM
              "GL_BUDGET_VERSIONS" ) src
            </code>
          </div>

          <span className="sqlpref__hint">
            A preference on this browser, like the theme — it is remembered between visits and does
            not change what anyone else sees. With it off, the server does not send the statements at
            all, so the pages are exactly as they were.
          </span>
        </div>
      </div>
    </section>
  );
}

export default function Settings() {
  const user = useSession();
  const { lines } = useStore();
  const may = isSuperAdmin(user);

  const [open, setOpen] = useState(true);
  const [list, setList] = useState<OrganizationList | null>(null);
  const [options, setOptions] = useState<OrganizationOptions | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // The create form. Its four fields are a `Draft` — the same shape the edit panel
  // works on, so `draftComplete` and `diffOf` are the only implementation of "is this
  // finished" and "what changed" in the file.
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(BLANK);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Organization | null>(null);
  const [formProblem, setFormProblem] = useState<string | null>(null);
  const [formAccepts, setFormAccepts] = useState<string[]>([]);

  /**
   * The row whose panel is open, or `null` when none is.
   *
   * ★ `null` RATHER THAN A BOOLEAN, AND THE PANEL IS WHAT NEEDS THAT. Every other
   *   drawer in the app is shaped this way (`DetailDrawer`'s `selected !== null`, the
   *   check panel's `check`). Holding the row itself means the panel has the values it
   *   is editing without looking them up again, and it means "the row was deleted
   *   underneath us" is impossible to represent — a panel cannot be open on nothing.
   */
  const [editing, setEditing] = useState<Organization | null>(null);

  /* ── The account register, which is a second read of a second thing ───────── */

  const [usersOpen, setUsersOpen] = useState(true);
  const [users, setUsers] = useState<UserList | null>(null);
  const [userProblem, setUserProblem] = useState<string | null>(null);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersReloadKey, setUsersReloadKey] = useState(0);

  // ★ THE CREATE PANEL'S OPEN/CLOSED STATE IS ALL THIS PAGE KEEPS OF IT. The draft,
  //   the busy flag, the refusal and the accepted-field list moved into the panel
  //   with the form, which is where `UserPanel` has always kept its own — the route
  //   answers one question (`userCreated`) about a create, and that answer is a
  //   notice in the register rather than a field in a form.
  const [userFormOpen, setUserFormOpen] = useState(false);
  const [userCreated, setUserCreated] = useState<AppUser | null>(null);

  /** The account whose panel is open, or `null`. A row, not a boolean — see `editing`. */
  const [editingUser, setEditingUser] = useState<AppUser | null>(null);

  // The register is a super-admin screen, so a session that may not read it never
  // sends the request. The server would answer 403 anyway — this is the polite half,
  // not the control.
  useEffect(() => {
    if (!may) return;
    const controller = new AbortController();
    let live = true;
    setLoading(true);

    Promise.all([loadOrganizations(controller.signal), loadOrganizationOptions(controller.signal)])
      .then(([orgs, opts]) => {
        if (!live) return;
        setList(orgs);
        setOptions(opts);
        setProblem(null);
      })
      .catch((err: unknown) => {
        if (!live || controller.signal.aborted) return;
        setProblem(err instanceof Error ? err.message : 'The register could not be read.');
      })
      .finally(() => {
        if (live) setLoading(false);
      });

    return () => {
      live = false;
      controller.abort();
    };
  }, [may, reloadKey]);

  /**
   * ★ A SECOND EFFECT RATHER THAN A THIRD PROMISE IN THE FIRST ONE.
   *
   * The two registers are independent reads of independent endpoints. Folding them
   * into one `Promise.all` would make a failure of either blank the whole page — a 403
   * or a 500 on `/api/users` would take the organization list down with it, and the
   * organization list is the half that still works. Kept apart, each panel reports what
   * it could not read while the other renders, which is the same argument `data/users.ts`
   * makes for not being `organizations.ts`.
   *
   * They share nothing but the route. Each has its own reload key, so a new account does
   * not re-read the tenants and a new tenant does not re-read the accounts.
   */
  useEffect(() => {
    if (!may) return;
    const controller = new AbortController();
    let live = true;
    setUsersLoading(true);

    loadUsers(controller.signal)
      .then((payload) => {
        if (!live) return;
        setUsers(payload);
        setUserProblem(null);
      })
      .catch((err: unknown) => {
        if (!live || controller.signal.aborted) return;
        setUserProblem(err instanceof Error ? err.message : 'The register could not be read.');
      })
      .finally(() => {
        if (live) setUsersLoading(false);
      });

    return () => {
      live = false;
      controller.abort();
    };
  }, [may, usersReloadKey]);

  /**
   * Seed the form from the tenant this session is *in*, once.
   *
   * ★ ONCE, AND NOT ON EVERY RENDER. The session arrives asynchronously, so this
   *   cannot be initial state — and re-seeding it whenever the session object
   *   changes would wipe a half-typed name the moment anything re-rendered. The ref
   *   makes it a first-fill rather than a binding.
   */
  const seeded = useRef(false);
  useEffect(() => {
    const org = user?.organization;
    if (seeded.current || !org) return;
    seeded.current = true;
    setDraft((current) => ({
      ...current,
      fund: org.fund,
      programs: [...org.programs],
      startFy: String(org.startFy),
    }));
  }, [user]);

  const ready = draftComplete(draft, options);

  /**
   * A keystroke in the create form.
   *
   * ★ IT CLEARS A PREVIOUS REFUSAL, INCLUDING FOR THE NAME. The old handlers cleared
   *   the error for the fund and the programs but not for the name, because the
   *   name's handler was written first and separately. An error notice that stays put
   *   while the field it is about is being corrected reads as "still broken", and the
   *   `unpaired` rule below means a fund change does *not* necessarily mean the
   *   selection changed — so clearing on any edit is both simpler and more truthful.
   */
  function editDraft(patch: Partial<Draft>) {
    setFormProblem(null);
    setDraft((current) => ({ ...current, ...patch }));
  }

  async function onCreate(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setFormProblem(null);
    setFormAccepts([]);
    try {
      const row = await createOrganization({
        name: draft.name.trim(),
        fund: draft.fund,
        programs: draft.programs,
        startFy: Number(draft.startFy),
      });
      setCreated(row);
      setFormOpen(false);
      // ★ ONLY THE NAME IS CLEARED. The fund, the programs and the year describe the
      //   tenant this session is in, so they are the most likely starting point for the
      //   next one; emptying them would make a person re-choose what the app already
      //   knows. `seeded` is what stops the session from filling them back in.
      setDraft((current) => ({ ...current, name: '' }));
      setFormProblem(null);
      setReloadKey((k) => k + 1);
    } catch (err: unknown) {
      setFormProblem(err instanceof Error ? err.message : 'The organization was not recorded.');
      setFormAccepts(acceptedValues(err));
    } finally {
      setBusy(false);
    }
  }

  /* ── The head, which is the same whether or not there is a list to show ────── */

  const head = (
    <div className="stack">
      <div>
        <div className="accent-rule" />
        <div className="page-head">
          <div>
            <h1>Settings</h1>
          </div>
          <div className="page-head__actions">
            <Link className="btn btn--ghost" to="/">
              Dashboard
            </Link>
          </div>
        </div>
      </div>
    </div>
  );

  if (!may) {
    return (
      <div className="stack">
        {head}
        <section className="panel">
          <div className="panel__head">
            <h2 className="panel__title">Not this session</h2>
            <span className="panel__count">
              {user?.authenticated ? roleLabel(user.role) : 'session not read yet'}
            </span>
          </div>
          <div className="panel__body">
            <p className="chart-note">
              Both registers on this page are super-admin screens. A staff account may read every
              other register in the app; the endpoints behind this page —{' '}
              <code>/api/organizations</code> and <code>/api/users</code> — call{' '}
              <code>requireSuperAdmin</code> and answer <strong>403</strong> whatever the rail
              happens to be showing, so this panel is the polite half of the refusal and not the
              refusal itself.
            </p>
            <p className="chart-note">
              {user?.authenticated
                ? `${user.name} is signed in as ${roleLabel(user.role)}, so this stays closed until the role on the account changes. The role is re-read from the database on every session request, so a change shows up on the next page load rather than needing a new sign-in.`
                : /*
                   * ★ UNREACHABLE, AND THE SENTENCE THAT USED TO BE HERE WAS WORSE THAN DEAD CODE.
                   *
                   *   It read "Signing in is the only way to reach this page" — advice to a visitor
                   *   who cannot be here. `App.tsx` refuses to draw this route without a session, so
                   *   the only way to see this panel at all is to be signed in already. A stale string
                   *   in an unreachable branch does not fail anything, which is why it is worth
                   *   removing by hand: nothing will ever tell you it is wrong.
                   *
                   *   The branch itself stays, because `useSession()` can be `null` for one frame
                   *   (a token is held and the boot request is in flight), and this says what is
                   *   true of that frame and asserts nothing about the app.
                   */
                  'The session has not been read yet, so the role on it is not known.'}
            </p>
            <div className="idcard__actions">
              <Link className="btn btn--primary" to="/sign-in">
                {user?.authenticated ? 'Sign in as somebody else' : 'Sign in'}
              </Link>
            </div>
          </div>
        </section>
      </div>
    );
  }

  /* ── The register ──────────────────────────────────────────────────────────── */

  return (
    <div className="stack">
      {head}

      {created ? (
        <div className="notice notice--ok" role="status">
          <p>
            <strong>{created.name} was recorded.</strong>
          </p>
          <p>
            <code>{created.slug}</code> — {created.scopeLabel}, from FY {created.startFy}.
          </p>
        </div>
      ) : null}

      {problem ? (
        <div className="notice notice--err" role="alert">
          <p>
            <strong>The register could not be read.</strong>
          </p>
          <p>{problem}</p>
          <p>
            If the session has expired this is a <strong>401</strong> rather than a 403 — sessions
            last twelve hours and the server keeps them in memory, so a restart or an expiry is
            enough. <Link to="/sign-in">Sign in again</Link>.
          </p>
        </div>
      ) : null}

      <section className="panel acc">
        <div className="panel__head">
          <button
            type="button"
            className="acc__toggle"
            aria-expanded={open}
            aria-controls="org-body"
            onClick={() => setOpen((v) => !v)}
          >
            <span className="acc__caret" aria-hidden="true">
              {open ? '▾' : '▸'}
            </span>
            Organizations
          </button>
          <div className="acc__actions">
            {list ? (
              <span className="panel__count">
                {list.counts.total} {list.counts.total === 1 ? 'organization' : 'organizations'}
              </span>
            ) : null}
            <button
              type="button"
              className="btn btn--primary btn--sm"
              aria-expanded={formOpen}
              aria-controls="org-new"
              onClick={() => {
                setFormOpen((v) => !v);
                setCreated(null);
                setFormProblem(null);
                // ★ THE TWO ARE NOT ALLOWED BOTH OPEN. One is a form for a record that
                //   does not exist and the other is a panel for a record that does, and
                //   having them on screen together invites a person to type into the
                //   wrong one. The panel is the one that closes, because the inline form
                //   is where a new tenant starts and the panel is over the top of it.
                setEditing(null);
              }}
            >
              + New
            </button>
          </div>
        </div>

        <div className="panel__body" id="org-body" hidden={!open}>
          {loading && !list ? <p className="chart-note">Reading the register…</p> : null}

          {list && list.counts.programs > 0 ? (
            <p className="chart-note acc__warn">
              {list.counts.programs} of {list.counts.total}{' '}
              {list.counts.programs === 1 ? 'organization names' : 'organizations name'} no program
              at all, which means the fund alone is the rule and the tenant selects every program
              in it. That is legal, and it is worth seeing rather than being refused.
            </p>
          ) : null}

          {list && list.items.length === 0 ? (
            <p className="chart-note">
              No organizations are recorded. The one this session is in came from the bootstrap
              account, so this list being empty would mean the bootstrap row has gone.
            </p>
          ) : null}

          {list && list.items.length > 0 ? (
            <ul className="orglist">
              {list.items.map((org) => {
                const mine = rowsInScope(scopeOf(org), lines);
                return (
                  <li key={org.slug} className={`orgrow${org.isDefault ? ' orgrow--default' : ''}`}>
                    <div className="orgrow__name">
                      <span className="orgrow__title">{org.name}</span>
                      {org.isDefault ? <Chip variant="info">default</Chip> : null}
                    </div>
                    <div className="orgrow__scope">{org.scopeLabel}</div>
                    <div className="orgrow__count">
                      FY {org.startFy} ·{' '}
                      {mine.length === 0 ? (
                        <strong className="orgrow__none">No rows found</strong>
                      ) : (
                        `${mine.length.toLocaleString()} ${mine.length === 1 ? 'line' : 'lines'}`
                      )}
                    </div>
                    <div className="orgrow__slug">
                      <code>{org.slug}</code>
                    </div>
                    {/*
                     * ★ A REAL `<button>`, NOT A CLICKABLE ROW. A row-level `onClick`
                     *   is never reachable from the keyboard, and the rule this project
                     *   has settled on is to put the control in the row and let the row
                     *   itself stay inert. `aria-label` names the organization because
                     *   six buttons reading "Edit" in a list is six identical entries to
                     *   a screen reader, and `aria-haspopup="dialog"` says what the
                     *   press will do before it is pressed.
                     */}
                    <div className="orgrow__act">
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm orgrow__edit"
                        aria-haspopup="dialog"
                        aria-label={`Edit ${org.name}`}
                        onClick={() => {
                          setCreated(null);
                          setEditing(org);
                        }}
                      >
                        Edit
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {formOpen ? (
            <form className="orgform" id="org-new" onSubmit={onCreate} noValidate>
              <h3 className="orgform__title">New organization</h3>
              <p className="chart-note">
                The key in the URL is derived from the name, so it is never typed — the same rule the
                projects register uses. A name that already exists is refused rather than merged.
              </p>

              {formProblem ? (
                <div className="notice notice--err" role="alert">
                  <p>
                    <strong>That was refused.</strong>
                  </p>
                  <p>{formProblem}</p>
                  {formAccepts.length ? (
                    <p>
                      This ledger accepts {formAccepts.map((v) => `“${v}”`).join(', ')} here.
                    </p>
                  ) : null}
                </div>
              ) : null}

              <ScopeFields
                idPrefix="org-new"
                draft={draft}
                onChange={editDraft}
                options={options}
                lines={lines}
                nameHint={
                  <>
                    The slug is <code>{draft.name.trim() ? slugPreview(draft.name) : '…'}</code>. Two
                    organizations cannot share one.
                  </>
                }
              />

              <div className="idcard__actions">
                <button type="submit" className="btn btn--primary" disabled={!ready || busy}>
                  {busy ? 'Recording…' : 'Create organization'}
                </button>
                <p className="field__hint">
                  {ready
                    ? 'The name, the fund, the programs and the start year are the whole record. Nothing is written to Oracle.'
                    : 'A name, a fund and a start year inside the ledger’s periods are required. The programs are optional.'}
                </p>
              </div>
            </form>
          ) : null}
        </div>
      </section>

      {/* ── The account register: who may sign in, and what the role buys ────── */}

      <section className="panel acc">
        <div className="panel__head">
          <button
            type="button"
            className="acc__toggle"
            aria-expanded={usersOpen}
            aria-controls="user-body"
            onClick={() => setUsersOpen((v) => !v)}
          >
            <span className="acc__caret" aria-hidden="true">
              {usersOpen ? '▾' : '▸'}
            </span>
            Users &amp; roles
          </button>
          <div className="acc__actions">
            {users ? (
              <span className="panel__count">
                {users.counts.total} {users.counts.total === 1 ? 'account' : 'accounts'}
              </span>
            ) : null}
            {/*
              ★ IT OPENS A DIALOG RATHER THAN DISCLOSING A FORM, WHICH IS WHY IT NO
                LONGER CARRIES `aria-expanded`. The thing it controls is not a region
                that appears beside the button — it is a panel that takes the screen, so
                it is announced as a dialog and `aria-haspopup` is the truthful
                attribute. The row's own `Edit` button already says it this way, and two
                buttons opening two drawers should not describe themselves differently.
            */}
            <button
              type="button"
              className="btn btn--primary btn--sm"
              aria-haspopup="dialog"
              aria-controls="user-new-panel"
              onClick={() => {
                setUserCreated(null);
                setUserFormOpen(true);
                // The same rule the organization panel follows: a form for a record that
                // does not exist and a panel for one that does are not allowed both open,
                // because being on screen together invites typing into the wrong one.
                setEditingUser(null);
              }}
            >
              + New
            </button>
          </div>
        </div>

        <div className="panel__body" id="user-body" hidden={!usersOpen}>
          {usersLoading && !users ? <p className="chart-note">Reading the register…</p> : null}

          {userCreated ? (
            <div className="notice notice--ok" role="status">
              <p>
                <strong>{userCreated.name} was recorded.</strong>
              </p>
              <p>
                <code>{userCreated.email}</code> — {roleLabel(userCreated.role)}, belongs to{' '}
                {sentenceList(userCreated.organizations.map((org) => org.name))}
                {userCreated.hasPassword
                  ? ', and can sign in with the password that was set.'
                  : ', but no password was stored, so it cannot sign in yet.'}
              </p>
            </div>
          ) : null}

          {userProblem ? (
            <div className="notice notice--err" role="alert">
              <p>
                <strong>The account register could not be read.</strong>
              </p>
              <p>{userProblem}</p>
              <p>
                The organization register above is a separate read and is not affected by this. If
                the session has expired this is a <strong>401</strong> rather than a 403 — sessions
                last twelve hours and the server keeps them in memory, so a restart or an expiry is
                enough. <Link to="/sign-in">Sign in again</Link>.
              </p>
            </div>
          ) : null}

          {/*
            ★ THE TWO QUEUES, AND WHY THEY ARE SENTENCES RATHER THAN NUMBERS IN A CHIP.
              Each is a state a signed-in account cannot be in, and each has a different
              fix — so the note names the fix instead of leaving the reader to work out
              which one this is. `unassigned` is repaired in this page's panel;
              `withoutPassword` too, by the password box in it.
          */}
          {users && users.counts.unassigned > 0 ? (
            <p className="chart-note acc__warn">
              <strong>
                {users.counts.unassigned} of {users.counts.total}{' '}
                {users.counts.unassigned === 1 ? 'account belongs' : 'accounts belong'} to no
                organization
              </strong>{' '}
              and no account in that state can sign in — the sign-in path refuses a missing
              organization rather than choosing a tenant for it. Open the account and tick the
              organizations it belongs to.
            </p>
          ) : null}

          {users && users.counts.withoutPassword > 0 ? (
            <p className="chart-note acc__warn">
              <strong>
                {users.counts.withoutPassword} of {users.counts.total}{' '}
                {users.counts.withoutPassword === 1 ? 'account has' : 'accounts have'} no password
              </strong>
              , which is the other reason a row cannot sign in. An account that has never been given
              one is not broken — it is one somebody made and has not finished — and{' '}
              <em>Set a password</em> in the account&rsquo;s own panel is where it is finished.
            </p>
          ) : null}

          {users ? (
            <p className="chart-note">
              {users.bootstrapEmail ? (
                <>
                  <code>{users.bootstrapEmail}</code> is not in this list and cannot be: it is the
                  bootstrap account, synthesised from <code>SUPER_ADMIN_EMAIL</code> and{' '}
                  <code>SUPER_ADMIN_PASSWORD</code> in <code>.env</code> and checked{' '}
                  <em>before</em> the table is read. So it signs in with a credential no row holds,
                  it is excluded from the count above, and <strong>+ New</strong> refuses the address
                  rather than writing a row that would never be reached.
                </>
              ) : (
                <>
                  No bootstrap account is configured — <code>SUPER_ADMIN_EMAIL</code> is unset — so
                  every account that can sign in is a row in this list, and there is no credential
                  in <code>.env</code> behind it.
                </>
              )}
            </p>
          ) : null}

          {users && users.items.length === 0 ? (
            <p className="chart-note">
              No accounts are recorded here. Whether that leaves anybody able to sign in depends
              entirely on the bootstrap address above and on nothing in this table.
            </p>
          ) : null}

          {users && users.items.length > 0 ? (
            <ul className="userlist">
              {users.items.map((row) => (
                <li key={row.id} className="userrow">
                  <div className="userrow__who">
                    <span className="userrow__name">{row.name}</span>
                    <Chip
                      variant={row.role === 'super_admin' ? 'warn' : 'neu'}
                      title={capabilityFor(users, row.role)?.summary}
                    >
                      {roleLabel(row.role)}
                    </Chip>
                    {/* ★ VISIBLE ON THE ROW, NOT ONLY IN THE PANEL. An account that cannot
                        sign in is the one an administrator is looking for, and a list
                        that showed it as an ordinary row would make them open every
                        drawer to find it. */}
                    {!row.hasPassword ? <Chip variant="warn">no password</Chip> : null}
                  </div>
                  <div className="userrow__mail">
                    <code>{row.email}</code>
                  </div>
                  <div className="userrow__orgs">
                    {row.organizations.length === 0 ? (
                      <strong className="userrow__none">No organization — cannot sign in</strong>
                    ) : (
                      row.organizations.map((org) => (
                        <span className="userrow__org" key={org.id}>
                          {org.name}
                          {org.isPrimary ? <span className="userrow__pin">signs in</span> : null}
                        </span>
                      ))
                    )}
                  </div>
                  <div className="userrow__seen">
                    {row.lastSeenAt === null ? (
                      <span className="userrow__never">never signed in</span>
                    ) : (
                      <>last signed in {dayPart(row.lastSeenAt)}</>
                    )}
                  </div>
                  {/* A real `<button>`, for the reason the organization row gives. */}
                  <div className="userrow__act">
                    <button
                      type="button"
                      className="btn btn--ghost btn--sm userrow__edit"
                      aria-haspopup="dialog"
                      aria-label={`Edit ${row.name}`}
                      onClick={() => {
                        setUserCreated(null);
                        // ★ THE SAME RULE, FROM THE OTHER SIDE. Whichever of the two
                        //   panels is opened last is the only one open — `+ New` above
                        //   closes this one, and this one closes `+ New`.
                        setUserFormOpen(false);
                        setEditingUser(row);
                      }}
                    >
                      Edit
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          ) : null}

          {/*
            ★ A NATIVE `<details>`, NOT THE `.acc` ACCORDION THE PANELS USE. `.acc` is a
              panel header: it holds a count, a button and a whole body, and it exists
              because those panels are the page. This is a footnote a person opens
              deliberately, and `<details>` gives that — keyboard-operable, announced as
              expandable, no state of its own to keep in step with the register.
          */}
          {users && users.capabilities.length > 0 ? (
            <details className="roledocs">
              <summary>What each role reaches</summary>
              <p className="chart-note">
                Printed from the server&rsquo;s own capability table rather than decided here. A role
                that gained a capability changes the sentence in one place; a second copy in this
                browser would be free to keep describing a permission model the API does not
                implement.
              </p>
              {users.capabilities.map((entry) => (
                <RoleDoctrine key={entry.role} entry={entry} />
              ))}
            </details>
          ) : null}

        </div>
      </section>

      <SqlPreferencePanel />

      <OrgPanel
        row={editing}
        options={options}
        lines={lines}
        onClose={() => setEditing(null)}
        onSaved={(next) => {
          // ★ THE ROW IS REPLACED BY SLUG, NOT RE-FETCHED. Two reasons, and either
          //   alone would be enough: the server already answered with the **stored**
          //   row (`readBack`), so a second GET would re-read a row this page is
          //   holding; and `slug` never moves — the route's own note says a rename
          //   leaves the key alone — so it is the stable identity to match on.
          //
          //   `setEditing(next)` IS NOT OPTIONAL. Without it the panel keeps the row it
          //   opened on, `diffOf` keeps finding a difference against a row that is no
          //   longer stored, and Save stays enabled after a save so a second press
          //   re-sends a patch that changes nothing.
          setEditing(next);
          setList((current) =>
            current
              ? { ...current, items: current.items.map((org) => (org.slug === next.slug ? next : org)) }
              : current,
          );
        }}
      />

      <UserPanel
        row={editingUser}
        orgs={list?.items ?? []}
        register={users}
        onClose={() => setEditingUser(null)}
        onSaved={(next) => {
          // ★ THE SAME THREE MOVES THE ORGANIZATION PANEL MAKES, for the same reasons.
          //   The key here is the numeric id: `PATCH /api/users/{id}` answers with the
          //   stored row, so a second GET would re-read what this page is holding — and
          //   the capability table and the counts came with the list, not the row, so
          //   re-reading them per save would be a second request for a table that has
          //   not changed.

          //   And `setEditingUser(next)` is again not optional: without it the panel
          //   keeps the row it opened on, `diffOfUser` keeps finding a difference
          //   against a row that is no longer stored, and Save stays lit after a save.
          setEditingUser(next);

          //   ★ THE ROW IS REPLACED HERE AND THE REGISTER IS RE-READ, WHICH LOOKS LIKE
          //     DOING IT TWICE AND IS NOT. The replacement is so the list agrees with the
          //     panel in the frame the save returns; the re-read is because `counts` is
          //     four numbers the **server** derived — `unassigned`, `withoutPassword` and
          //     the role tallies — and this page's own header says why they must not be
          //     recomputed here. A row that just gained a password while the warning
          //     directly above it still counted an account without one is exactly the
          //     disagreement that warning exists to prevent. One extra GET buys the
          //     count coming from the same place every other count comes from.
          setEditingUser(next);
          setUsers((current) =>
            current
              ? {
                  ...current,
                  items: current.items.map((user) => (user.id === next.id ? next : user)),
                }
              : current,
          );
          setUsersReloadKey((k) => k + 1);
        }}
      />

      {/*
        ★ BESIDE THE EDIT PANEL, NOT INSIDE THE ACCORDION. `+ New` slides this in from
          the right exactly as `Edit` slides that one in, so the two acts are the same
          gesture in the same place — and the register behind it is left alone while an
          account is being composed.

        ★ `onCreated` DOES NOT CLOSE THIS PANEL ITSELF. The panel closes on its own
          successful write, because it is the only thing that knows the write landed and
          the only thing holding a draft that is now stale. This callback is the page's
          half: the notice in the register, and the re-read that brings the counts back
          from the server that derived them.
      */}
      <NewUserPanel
        open={userFormOpen}
        orgs={list?.items ?? []}
        register={users}
        onClose={() => setUserFormOpen(false)}
        onCreated={(row) => {
          setUserCreated(row);
          // ★ THE REGISTER IS RE-READ RATHER THAN APPENDED TO, for the reason the edit
          //   panel's save gives: `counts` is four numbers the **server** derived, and a
          //   page that pushed the new row into its own array would leave the header
          //   counting one fewer account than the list is showing.
          setUsersReloadKey((k) => k + 1);
        }}
      />
    </div>
  );
}

/**
 * The slug the server will derive, for the hint under the name field.
 *
 * ★ IT IS A PREVIEW AND IT SAYS SO. The server's `slugFor()` is the authority; this
 *   repeats its rule only to put a value in front of the person typing, and a
 *   mismatch costs a hint that was wrong rather than a record that is. The rules the
 *   server applies are the same three — lower-case, non-alphanumerics to hyphens,
 *   collapse runs and trim the ends — and the read-back after a create is what
 *   actually proves the result.
 */
function slugPreview(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The panel's focus trap reads the same set the other four drawers use. */
const FOCUSABLE =
  'a[href], button:not([disabled]), summary, input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Where the dragged width is remembered. Per panel, like `checks-panel-w`. */
const ORG_PANEL_WIDTH_KEY = 'settings-org-panel-w';

/**
 * ★ TWO ACCOUNT PANELS, ONE WIDTH, AND THE ORGANIZATION PANEL DELIBERATELY NOT ON IT.
 *   The organization panel holds a name, a fund, a program list and a start year —
 *   four fields and a preview. The account panels hold a name, an address, a role, a
 *   checkbox list, a radio group and a password box. Sharing a key across *that*
 *   boundary would mean widening the account panel to read an email moves the
 *   organization panel underneath it, which is a settings page rearranging itself
 *   while nobody asked it to.
 *
 * ★ BUT `UserPanel` AND `NewUserPanel` DO SHARE ONE, AND THE FIELDS ARE WHY. They ask
 *   the same six questions in the same order — the only difference is that one is
 *   filled from a row and one is empty — so two keys would mean a person who widened
 *   the register's panel to read a long address has to widen the other panel to read
 *   the address they are typing.
 */
const USER_PANEL_WIDTH_KEY = 'settings-user-panel-w';

/**
 * One organization, edited in a panel that slides in from the right.
 *
 * ── ★ IT PATCHES A DIFF, AND SAVE IS DISABLED WHEN THE DIFF IS EMPTY
 *
 * `PATCH /api/organizations/{slug}` refuses a body naming no fields with `400
 * BAD_REQUEST`. That refusal is a design decision, not a sharp edge — the note on the
 * route says an empty update would otherwise answer `200` with a row the caller
 * believes it edited. So the panel works out what changed locally (`diffOf`) and
 * disables Save when nothing has, rather than posting `{}` and translating a 400 into
 * a success message. The footer says which fields would be sent, before they are.
 *
 * ── ★ IT REUSES `ScopeFields`, SO THERE IS NO SECOND SET OF CONTROLS
 *
 * The four inputs in this panel are the four inputs in the create form — the same
 * component, the same `startFyEffect` sentence, the same `unpaired` rule, the same
 * `"Reads as"` preview. A hand-written second copy is how an edit form and a create
 * form come to disagree about what a valid start year is, and the field they would
 * disagree about is the one with two representations (a number on the wire, a string
 * in the box).
 *
 * ── ★ THE HEAD SHOWS THE STORED ROW; THE PREVIEW SHOWS THE DRAFT
 *
 * The head reads "currently reads … — 2,781 lines" and does **not** move while the
 * form is edited, because it is a statement about the row as stored. The preview
 * inside `ScopeFields` moves on every keystroke, because it is a statement about what
 * is about to be saved. Two readings, two labels, and neither pretends to be the
 * other — which is the same distinction the funding screens make between the approved
 * and the committed total.
 */
function OrgPanel({
  row,
  options,
  lines,
  onClose,
  onSaved,
}: {
  row: Organization | null;
  options: OrganizationOptions | null;
  lines: readonly { orderDate: string; fund: string; program: string }[];
  onClose: () => void;
  onSaved: (row: Organization) => void;
}) {
  const open = row !== null;

  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const [width, setWidth] = useState<number | null>(() => readStoredWidth(ORG_PANEL_WIDTH_KEY));
  const [resizing, setResizing] = useState(false);
  const [rendered, setRendered] = useState(0);

  const [draft, setDraft] = useState<Draft>(BLANK);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [patchProblem, setPatchProblem] = useState<string | null>(null);
  const [patchAccepts, setPatchAccepts] = useState<string[]>([]);

  // Who opened the panel, and the scroll lock. Restoring focus to the Edit button is
  // the half of "it is a dialog" that is easy to skip and obvious when missing.
  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement as HTMLElement | null;
    document.body.classList.add('is-locked');
    return () => {
      document.body.classList.remove('is-locked');
      openerRef.current?.focus?.();
    };
  }, [open]);

  /**
   * Fill the form from the row.
   *
   * ★ KEYED ON THE ROW, AND RE-RUN ON PURPOSE AFTER A SAVE. `onSaved` hands back the
   *   **stored** row, so re-seeding here is what makes the diff empty and Save
   *   disabled again the moment a save succeeds. Keying on the row object rather than
   *   on its slug is deliberate: the parent replaces the object, which is exactly the
   *   event this effect exists to notice.
   */
  useEffect(() => {
    if (!row) return;
    setDraft({
      name: row.name,
      fund: row.fund,
      programs: [...row.programs],
      startFy: String(row.startFy),
    });
    setSaved(null);
    setPatchProblem(null);
    setPatchAccepts([]);
  }, [row]);

  // ★ FOCUS HAS TO WAIT FOR THE CONTENT. On the first open the close button is not
  //   rendered yet, so focusing in the same commit silently does nothing — the panel
  //   opens with focus still on the Edit button behind it and the Tab trap is the only
  //   thing keeping a keyboard user in the drawer.
  useEffect(() => {
    if (open && row) closeRef.current?.focus();
  }, [open, row]);

  // Escape closes; Tab is trapped inside. Both only while open, so a closed panel
  // cannot swallow a keystroke meant for the register behind it.
  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // What the panel is actually drawn at, so the grip has a sensible value before the
  // first drag (the width may come from storage, or from `--drawer-w`).
  useEffect(() => {
    if (!open) return;
    const measure = () => setRendered(panelRef.current?.getBoundingClientRect().width ?? 0);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

  useEffect(() => {
    document.body.classList.toggle('is-resizing', resizing);
    return () => document.body.classList.remove('is-resizing');
  }, [resizing]);

  // ★ ★ THIS COUNT IS OVER THE LIVE LEDGER. It reads `lines` from the store, which
  //   now comes from `GET /api/extract/current` → Oracle (`DB_MODE=oracle`), and
  //   only falls back to the frozen file when the ledger is unreachable.
  //
  //   The number moves as a result, and it should: the file holds 2,782 rows
  //   (2,781 after the cancel-flag filter), while the live tenant scope returns
  //   **31,670 rows / 31,401 distinct lines / 5,692 orders / $2,797,825,956.73**.
  //   Program 861 alone goes from "no lines in the extract" to 1,472 rows /
  //   $213,059,950.60 — it was never empty, the file simply predates it.
  //
  //   Program 863 remains genuinely empty: it is absent from the ledger too, so the
  //   "no lines" copy is still correct for that one case and must be kept.
  //
  //   See the ★★ block on `loadExtract` for the row-level evidence.
  const storedCount = row ? rowsInScope(scopeOf(row), lines).length : 0;
  const patch = row ? diffOf(row, draft) : null;
  const complete = draftComplete(draft, options);

  function edit(patchFields: Partial<Draft>) {
    setPatchProblem(null);
    setDraft((current) => ({ ...current, ...patchFields }));
  }

  async function onSave(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !row || !patch || !complete) return;
    setBusy(true);
    setPatchProblem(null);
    setPatchAccepts([]);
    try {
      const next = await updateOrganization(row.slug, patch);

      // ★ ★ THE ONE THING THAT MAKES "the chips above follow it" TRUE. Every
      //   request the server answers re-resolves the organization, so the
      //   registers would be filtered by the new scope on their very next call
      //   — but the tenant the *store* filters by is read out of the session in
      //   this browser, and that copy is only rewritten by a sign-in or by the
      //   boot check. Without this line a saved fund leaves the top bar, the
      //   drawer and every count describing the organization as it was, until
      //   somebody reloads the page: the app contradicting the screen that just
      //   wrote the change. Verified the hard way — setting the fund to 01 here
      //   left the chip reading `Fund 04` and the extract at 2,781 lines, and
      //   only a reload moved it.
      //
      //   Not gated on "did it change my own organization". The session carries
      //   the tenant's name and not its slug, so recognising "mine" would mean
      //   guessing from a label, and the call is one GET that the server answers
      //   from data it has already loaded.
      await refreshSession();

      setSaved(describePatch(patch));
      onSaved(next);
    } catch (err: unknown) {
      setPatchProblem(err instanceof Error ? err.message : 'The organization was not saved.');
      setPatchAccepts(acceptedValues(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside
      ref={panelRef}
      id="org-edit-panel"
      className={`drawer orgpanel${open ? ' is-open' : ''}${resizing ? ' is-resizing' : ''}`}
      style={width === null ? undefined : ({ '--drawer-w': `${width}px` } as CSSProperties)}
      role="dialog"
      aria-modal="true"
      aria-label={row ? `${row.name} — organization settings` : 'Organization settings'}
      aria-hidden={!open}
      tabIndex={-1}
    >
      <ResizeGrip
        value={width ?? rendered}
        onChange={(next) => {
          const clamped = clampWidth(next);
          setWidth(clamped);
          storeWidth(ORG_PANEL_WIDTH_KEY, clamped);
        }}
        onReset={() => {
          setWidth(null);
          storeWidth(ORG_PANEL_WIDTH_KEY, null);
        }}
        onDraggingChange={setResizing}
        controls="org-edit-panel"
        label="Resize the organization panel"
      />

      <div className="drawer__head">
        <div className="drawer__eyebrow">
          Organization · <code>{row?.slug ?? ''}</code>
        </div>
        <h2 className="drawer__name">{row?.name ?? ''}</h2>
        <div className="drawer__meta">
          {/*
           * ★ THE ZERO CASE IS A SENTENCE, NOT A NUMBER AND A NOUN SLOT. It used
           *   to render the count and the unit in two conditional slots, which is
           *   fine for "2,781 lines" and produced "— **No rows found** of the
           *   extract, as stored." for a scope that selects nothing. A
           *   configuration that matches no rows is an ordinary, legal state here
           *   — the drawer even recomputes it live as the fund changes value — so
           *   it says what it means instead of leaving a dangling preposition.
           *
           *   ★ "IN THE LEDGER", NOT "OF THE EXTRACT, AS STORED". The count is now
           *   taken over the rows the API read from Oracle, so naming an extract
           *   would name a file this number no longer comes from. When the ledger
           *   is unreachable the seam silently falls back to the frozen file and
           *   logs a warning, so this sentence stays true either way — it describes
           *   the data the app is holding, not where the bytes came from.
           */}
          {storedCount === 0 ? (
            <>
              Reads <b>{row?.scopeLabel ?? ''}</b> from FY <b>{row?.startFy ?? ''}</b> —{' '}
              <strong className="orgrow__none">no matching lines in the ledger</strong>.
            </>
          ) : (
            <>
              Reads <b>{row?.scopeLabel ?? ''}</b> from FY <b>{row?.startFy ?? ''}</b> —{' '}
              <b>{storedCount.toLocaleString()}</b> {storedCount === 1 ? 'line' : 'lines'} in the
              ledger.
            </>
          )}
        </div>
        <div className="drawer__chips">
          {row?.isDefault ? <Chip variant="info">default</Chip> : null}
          <Chip variant="neu">updated {row?.updatedAt ?? ''}</Chip>
        </div>
        <button
          ref={closeRef}
          type="button"
          className="drawer__close"
          onClick={onClose}
          aria-label="Close the organization panel"
        >
          <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M1 1l10 10M11 1L1 11"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <div className="drawer__body">
        <form id="org-edit" onSubmit={onSave} noValidate>
          {row?.isDefault ? (
            <p className="chart-note acc__warn">
              <strong>This is the default organization.</strong> A visitor with no session reads it, so
              changing its fund, its programs or its start year changes what an anonymous reader sees
              — immediately, and for everyone. There is no confirmation step and no undo.
            </p>
          ) : null}

          {saved ? (
            <div className="notice notice--ok" role="status">
              <p>
                <strong>Saved.</strong> {saved.charAt(0).toUpperCase() + saved.slice(1)} changed in the
                register.
              </p>
            </div>
          ) : null}

          {patchProblem ? (
            <div className="notice notice--err" role="alert">
              <p>
                <strong>That was refused.</strong>
              </p>
              <p>{patchProblem}</p>
              {patchAccepts.length ? (
                <p>This ledger accepts {patchAccepts.map((v) => `“${v}”`).join(', ')} here.</p>
              ) : null}
            </div>
          ) : null}

          <ScopeFields
            idPrefix="org-edit"
            draft={draft}
            onChange={edit}
            options={options}
            lines={lines}
            nameHint={
              <>
                The key stays <code>{row?.slug ?? ''}</code>. A slug is derived once, when the
                organization is created, and a rename leaves it alone — so a stored link keeps working
                and this cannot be used to change it.
              </>
            }
          />
        </form>
      </div>

      <div className="drawer__foot">
        <button
          type="submit"
          className="btn btn--primary"
          form="org-edit"
          disabled={!complete || patch === null || busy}
        >
          {busy ? 'Saving…' : saved && patch === null ? 'Saved' : 'Save changes'}
        </button>
        <button type="button" className="btn btn--system" onClick={onClose}>
          Close
        </button>
        <p className="orgpanel__note">
          {!complete
            ? 'A name, a fund and a start year inside the ledger’s periods are required. The programs are optional.'
            : patch === null
              ? 'Nothing has changed yet, so there is nothing to send. An update that names no fields is refused rather than treated as a no-op.'
              : `Sends only what differs — ${describePatch(patch)}. Nothing is written to Oracle.`}
        </p>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// The account register's controls, shared by the create form and the panel.
// ---------------------------------------------------------------------------

/**
 * One role's doctrine, as the server stated it.
 *
 * ★ `withholds` IS PRINTED, NEVER DERIVED BY SUBTRACTION. The obvious shortcut is to
 *   list what a role reaches and let a reader conclude the rest, or to compute "what
 *   this role cannot do" from the union of what others can. Both are wrong for the
 *   same reason: the server's table is a statement in prose about a permission model,
 *   and one has to read it to know it. `administrator` is the whole proof — it appears
 *   nowhere in the server's `requireSuperAdmin` checks, so its honest description is
 *   not "a reduced super admin" but "a staff account with a title", and that sentence
 *   exists only because somebody wrote it down.
 */
function RoleDoctrine({ entry }: { entry: RoleCapability }) {
  return (
    <div className="roledoc">
      <div className="roledoc__head">
        <span className="roledoc__label">{entry.label}</span>
        <code className="roledoc__code">{entry.role}</code>
      </div>
      <p className="chart-note">{entry.summary}</p>
      <div className="roledoc__grid">
        <div className="roledoc__col">
          <h4 className="roledoc__heading">May reach</h4>
          <ul className="roledoc__list">
            {entry.grants.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
        <div className="roledoc__col roledoc__col--no">
          <h4 className="roledoc__heading">May not reach</h4>
          <ul className="roledoc__list">
            {entry.withholds.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/**
 * The role control, in the create form and the panel both.
 *
 * ★ THE OPTIONS COME FROM THE SERVER AND THE DEFAULT DOES NOT. `register.roles` arrives
 *   most-privileged-first on purpose, so this renders it in that order and takes its
 *   labels from the same capability table the doctrine is printed from — an option and
 *   a paragraph that disagreed about what `administrator` is called would be two names
 *   for one role. The **selected** value never comes from that list; it comes from the
 *   draft, and `BLANK_USER` makes it `staff`. Binding the default to `roles[0]` is the
 *   accident `routes/users.ts` says the order exists to make visible.
 */
function RoleField({
  idPrefix,
  value,
  register,
  onChange,
}: {
  idPrefix: string;
  value: Role;
  register: UserList | null;
  onChange: (role: Role) => void;
}) {
  const id = `${idPrefix}-role`;
  const roles = register?.roles ?? [...ROLE_VALUES];
  const chosen = capabilityFor(register, value);

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        Role
      </label>
      <select
        id={id}
        className="input"
        value={value}
        onChange={(event) => {
          const next = asRole(event.target.value);
          if (next) onChange(next);
        }}
      >
        {roles.map((role) => (
          <option key={role} value={role}>
            {capabilityFor(register, role)?.label ?? roleLabel(role)}
          </option>
        ))}
      </select>
      {chosen ? <p className="chart-note rolefield__summary">{chosen.summary}</p> : null}
      <p className="field__hint">
        Listed most privileged first, and <strong>Staff</strong> is what a new account gets unless
        this is changed — the wrong default in this one field grants more than somebody meant to
        grant, and that is the direction the mistake hurts.
      </p>
    </div>
  );
}

/**
 * Which organizations an account belongs to, and which of them it signs in to.
 *
 * ── ★ THE TWO QUESTIONS ARE DRAWN AS TWO CONTROLS, AND THAT IS THE POINT
 *
 * Membership and the sign-in organization are one field apart in the request body and
 * completely different in meaning. Drawn as one list they are indistinguishable: a
 * checkbox next to a name says "this account is in this organization", and the second
 * question — of the organizations it is in, which one does it *arrive* in — has no
 * place to live. So the checkboxes are `.picklist` (the same control the program list
 * uses), and the radios sit in a recessed group underneath, drawn only when the
 * checkboxes have produced a genuine choice. When exactly one organization is ticked
 * there is no question to ask and the group is replaced by the sentence that says so,
 * which is `resolvePrimary`'s rule on the server stated in the same place a person
 * could otherwise wonder whether they had missed a control.
 *
 * ── ★ UNTICKING THE SIGN-IN ORGANIZATION CLEARS THE ANSWER RATHER THAN KEEPING IT
 *
 * A `primary` that names an organization the account no longer belongs to is the exact
 * state `assertSignInOrganization` refuses with a 400. Clearing it here means the form
 * cannot post that body in the first place, and the refusal stays where it belongs —
 * on a client that did something else.
 */
function MembershipPicker({
  idPrefix,
  orgs,
  memberships,
  primary,
  onChange,
}: {
  idPrefix: string;
  orgs: readonly Organization[];
  memberships: number[];
  primary: number | null;
  onChange: (patch: Partial<UserDraft>) => void;
}) {
  const chosen = orgs.filter((org) => memberships.includes(org.id));
  const nameOf = (id: number) => orgs.find((org) => org.id === id)?.name ?? `#${id}`;

  function toggle(id: number, on: boolean) {
    const next = on
      ? [...memberships, id].sort((a, b) => a - b)
      : memberships.filter((held) => held !== id);
    const patch: Partial<UserDraft> = { memberships: next };
    // One membership answers the second question by itself; a stale answer that is no
    // longer among the ticked ones has to go, or the save carries a contradiction.
    if (next.length === 1) patch.primary = next[0]!;
    else if (primary !== null && !next.includes(primary)) patch.primary = null;
    onChange(patch);
  }

  if (orgs.length === 0) {
    return (
      <div className="field">
        <p className="field__label">Organizations</p>
        <p className="chart-note acc__warn">
          <strong>There are no organizations to belong to.</strong> Every account has to belong to at
          least one, so an account cannot be created until the register above has a tenant in it.
        </p>
      </div>
    );
  }

  return (
    <div className="field">
      <p className="field__label" id={`${idPrefix}-orgs-label`}>
        Organizations <span className="field__req">at least one</span>
      </p>
      <div className="picklist" role="group" aria-labelledby={`${idPrefix}-orgs-label`}>
        {orgs.map((org) => (
          <label className="opt" key={org.id}>
            <input
              type="checkbox"
              checked={memberships.includes(org.id)}
              onChange={(event) => toggle(org.id, event.target.checked)}
            />
            <span className="opt__name">{org.name}</span>
            <span className="opt__meta">
              <code>{org.slug}</code>
            </span>
          </label>
        ))}
      </div>

      {chosen.length > 1 ? (
        <fieldset className="userform__primary">
          <legend className="field__label">Signs in to</legend>
          <p className="field__hint">
            A session belongs to one organization at a time, so an account with several has to say
            which one it arrives in. The rail, the counts and every register are read through it.
          </p>
          {chosen.map((org) => (
            <label className="opt" key={org.id}>
              <input
                type="radio"
                name={`${idPrefix}-primary`}
                checked={primary === org.id}
                onChange={() => onChange({ primary: org.id })}
              />
              <span className="opt__name">{org.name}</span>
              <span className="opt__meta">
                <code>{org.slug}</code>
              </span>
            </label>
          ))}
          {primary === null ? (
            <p className="field__hint userform__pause">
              Not chosen yet — one of the ticked organizations has to be picked.
            </p>
          ) : null}
        </fieldset>
      ) : null}

      {chosen.length === 1 ? (
        <p className="field__hint">
          Signs in to <strong>{chosen[0]!.name}</strong> — the only organization ticked. There is no
          second question to ask until another one is.
        </p>
      ) : null}

      {chosen.length === 0 ? (
        <p className="field__hint userform__pause">
          None ticked. An account with no organization cannot sign in, so the save stays disabled
          until at least one is.
        </p>
      ) : null}

      {/* ★ AND WHEN THE ANSWER NAMES SOMETHING NO LONGER TICKED — which `toggle` above
          prevents, so this can only be reached by a draft built some other way. It is
          here because the cost of the guard is one comparison and the cost of its
          absence is a 400 about a field the form appears to have filled in. */}
      {primary !== null && !memberships.includes(primary) ? (
        <p className="field__hint userform__pause">
          The sign-in organization is set to <strong>{nameOf(primary)}</strong>, which is no longer
          ticked.
        </p>
      ) : null}
    </div>
  );
}

/**
 * A password box, with the two things this screen has to offer around it.
 *
 * ★ `autoComplete="new-password"` AND NOT `"off"`. This is a field where a password
 *   manager offering to generate and store is *useful* — the admin is setting a
 *   credential for somebody else and has to transmit it somehow — and `new-password` is
 *   how a browser is told that this particular box is a value being created rather than
 *   a value being recalled. `off` makes some browsers ignore the hint entirely and some
 *   offer the *admin's own* saved passwords, which is worse than either.
 *
 * ★ THE REVEAL BUTTON IS A TOGGLE WITH `aria-pressed`, NOT TWO ICONS. The value is
 *   being typed for somebody else to read off the screen, so seeing it is the ordinary
 *   case and hiding it is the exception; a button that changes what it says and
 *   announces its own state is the honest control for that.
 */
function PasswordField({
  idPrefix,
  value,
  onChange,
  label,
  hint,
}: {
  idPrefix: string;
  value: string;
  onChange: (password: string) => void;
  label: string;
  hint: string;
}) {
  const id = `${idPrefix}-password`;
  const [shown, setShown] = useState(false);

  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <div className="userform__pw">
        <input
          id={id}
          className="input"
          type={shown ? 'text' : 'password'}
          autoComplete="new-password"
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          aria-pressed={shown}
          aria-controls={id}
          onClick={() => setShown((v) => !v)}
        >
          {shown ? 'Hide' : 'Show'}
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => {
            onChange(suggestPassword());
            setShown(true);
          }}
        >
          Generate
        </button>
      </div>
      <p className="field__hint">
        {hint}
        {value.length > 0 && value.length < PASSWORD_MIN ? (
          <strong className="userform__pause"> {PASSWORD_MIN - value.length} more characters.</strong>
        ) : null}
      </p>
    </div>
  );
}

/**
 * One account, edited in a panel that slides in from the right.
 *
 * ── ★ IT IS `OrgPanel` A SECOND TIME, AND THE REPETITION IS THE POINT
 *
 * Escape closes, Tab is trapped, focus goes back to the button that opened it, the body
 * is locked while it is open, the width is dragged and remembered. None of that is
 * optional and none of it is negotiable per panel — a drawer that traps focus and a
 * drawer that does not are two things a keyboard user has to learn separately. The
 * markup is repeated rather than extracted because the fields inside it share nothing:
 * one is four scope inputs, the other is a role, a set of memberships and a password.
 * Extracting the shell would mean a component taking `children` and passing the
 * lifecycle down, which is more machinery than the two uses justify.
 *
 * ── ★ THE PASSWORD IS A SECOND FORM, AND IT IS NOT PART OF THE DIFF
 *
 * Everything else in this panel is a `PATCH` to `/api/users/{id}` that sends only what
 * changed. The password is neither: it is a `POST` to a route of its own, it is not
 * read back, and sending it inside a patch would mean every save of a name re-sent a
 * credential. So it sits in its own `<form>`, with its own button, its own busy state
 * and its own notice.
 *
 * ★ AND ITS SUCCESS NOTICE SAYS WHAT IT DOES NOT DO. A session is a signed token with
 *   an expiry, not a pointer at a credential: the server does not re-read the password
 *   on each request, so changing one stops the **next** sign-in and leaves every
 *   session already issued working until it expires. An administrator who believes
 *   they have just cut somebody off has been told something this app cannot deliver,
 *   and the sentence next to the button is where that gets corrected.
 *
 * ── ★ THE EMAIL IS SHOWN AND CANNOT BE EDITED
 *
 * `UserUpdate` has no `email` field and `PATCH` has no case for one, because the
 * address is the key sign-in looks the account up by. A form field that silently did
 * nothing would be worse than an input that is visibly disabled — so it is a disabled
 * input with the reason underneath, rather than a read-only line the reader might take
 * for a rendering bug.
 */
function UserPanel({
  row,
  orgs,
  register,
  onClose,
  onSaved,
}: {
  row: AppUser | null;
  orgs: readonly Organization[];
  register: UserList | null;
  onClose: () => void;
  onSaved: (row: AppUser) => void;
}) {
  const open = row !== null;

  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const [width, setWidth] = useState<number | null>(() => readStoredWidth(USER_PANEL_WIDTH_KEY));
  const [resizing, setResizing] = useState(false);
  const [rendered, setRendered] = useState(0);

  const [draft, setDraft] = useState<UserDraft>(BLANK_USER);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [patchProblem, setPatchProblem] = useState<string | null>(null);
  const [patchAccepts, setPatchAccepts] = useState<string[]>([]);
  /** ★ `NOT_FOUND` IS NOT A VALIDATION ERROR, SO IT IS NOT HELD IN `patchProblem`. */
  const [missing, setMissing] = useState(false);

  // The password form's own four states. Separate because it is a separate request —
  // see the header. A save of the name must not clear a password refusal and a password
  // refusal must not disable the Save button above it.
  const [password, setPassword] = useState('');
  const [pwBusy, setPwBusy] = useState(false);
  const [pwSaved, setPwSaved] = useState(false);
  const [pwProblem, setPwProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement as HTMLElement | null;
    document.body.classList.add('is-locked');
    return () => {
      document.body.classList.remove('is-locked');
      openerRef.current?.focus?.();
    };
  }, [open]);

  /**
   * Fill the form from the row — keyed on the row, so a save that hands back the stored
   * account re-seeds the draft and empties the diff, exactly as `OrgPanel` does.
   *
   * ★ THE PASSWORD BOX IS CLEARED HERE TOO, and it is the one line in this effect that
   *   is not a copy of the row. Re-opening a different account with the previous
   *   account's generated password still in the box is a credential typed into the
   *   wrong record, one keystroke from being saved.
   */
  useEffect(() => {
    if (!row) return;
    setDraft({
      name: row.name,
      email: row.email,
      role: row.role,
      memberships: row.organizations.map((org) => org.id),
      primary: row.primaryOrganizationId,
      password: '',
    });
    setSaved(null);
    setPatchProblem(null);
    setPatchAccepts([]);
    setMissing(false);
    setPassword('');
    setPwSaved(false);
    setPwProblem(null);
  }, [row]);

  useEffect(() => {
    if (open && row) closeRef.current?.focus();
  }, [open, row]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const measure = () => setRendered(panelRef.current?.getBoundingClientRect().width ?? 0);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

  useEffect(() => {
    document.body.classList.toggle('is-resizing', resizing);
    return () => document.body.classList.remove('is-resizing');
  }, [resizing]);

  const patch = row ? diffOfUser(row, draft) : null;
  const complete = userDraftComplete(draft, false);

  function edit(patchFields: Partial<UserDraft>) {
    setPatchProblem(null);
    setMissing(false);
    setDraft((current) => ({ ...current, ...patchFields }));
  }

  async function onSave(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !row || !patch || !complete) return;
    setBusy(true);
    setPatchProblem(null);
    setPatchAccepts([]);
    try {
      const next = await updateUser(row.id, patch);
      setSaved(describeUserPatch(patch));
      onSaved(next);
    } catch (err: unknown) {
      // ★ A 404 ON A PATCH MEANS SOMEBODY DELETED THE ROW BEHIND THIS PANEL — or that
      //   the panel is holding an id from a register that has since been rewritten.
      //   Neither is a thing the form can fix, so it does not go into the validation
      //   notice beside fields that are all perfectly valid. It gets its own, and its
      //   own way out: re-read the register.
      if (err instanceof ApiError && err.code === 'NOT_FOUND') setMissing(true);
      else {
        setPatchProblem(err instanceof Error ? err.message : 'The account was not saved.');
        setPatchAccepts(acceptedValues(err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function onSetPassword(event: React.FormEvent) {
    event.preventDefault();
    if (pwBusy || !row || password.length < PASSWORD_MIN) return;
    setPwBusy(true);
    setPwProblem(null);
    setPwSaved(false);
    try {
      const next = await setUserPassword(row.id, password);
      setPwSaved(true);
      setPassword('');
      onSaved(next);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.code === 'NOT_FOUND') setMissing(true);
      else setPwProblem(err instanceof Error ? err.message : 'The password was not stored.');
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <aside
      ref={panelRef}
      id="user-edit-panel"
      className={`drawer userpanel${open ? ' is-open' : ''}${resizing ? ' is-resizing' : ''}`}
      style={width === null ? undefined : ({ '--drawer-w': `${width}px` } as CSSProperties)}
      role="dialog"
      aria-modal="true"
      aria-label={row ? `${row.name} — account settings` : 'Account settings'}
      aria-hidden={!open}
      tabIndex={-1}
    >
      <ResizeGrip
        value={width ?? rendered}
        onChange={(next) => {
          const clamped = clampWidth(next);
          setWidth(clamped);
          storeWidth(USER_PANEL_WIDTH_KEY, clamped);
        }}
        onReset={() => {
          setWidth(null);
          storeWidth(USER_PANEL_WIDTH_KEY, null);
        }}
        onDraggingChange={setResizing}
        controls="user-edit-panel"
        label="Resize the account panel"
      />

      <div className="drawer__head">
        <div className="drawer__eyebrow">
          Account · <code>{row?.email ?? ''}</code>
        </div>
        <h2 className="drawer__name">{row?.name ?? ''}</h2>
        <div className="drawer__meta">
          {/*
           * ★ THIS LINE DESCRIBES THE STORED ROW AND NOT THE DRAFT, like the
           *   organization panel's. It is a statement about what the account *is* —
           *   which organization it signs in to right now — and having it move while
           *   the radios are being clicked would be a second, less honest answer to a
           *   question the form is already showing the answer to.
           */}
          {row ? (
            row.primaryOrganizationId === null ? (
              <>
                Belongs to{' '}
                <b>{sentenceList(row.organizations.map((org) => org.name)) || 'nothing'}</b> and{' '}
                <strong className="userrow__never has no sign-in organization">cannot sign in</strong>.
              </>
            ) : (
              <>
                Signs in to{' '}
                <b>
                  {row.organizations.find((org) => org.id === row.primaryOrganizationId)?.name ??
                    `#${row.primaryOrganizationId}`}
                </b>{' '}
                — {sentenceList(row.organizations.map((org) => org.name))}.
              </>
            )
          ) : null}
        </div>
        <div className="drawer__chips">
          <Chip variant={row?.role === 'super_admin' ? 'warn' : 'neu'}>
            {row ? roleLabel(row.role) : ''}
          </Chip>
          <Chip variant="neu">joined {row ? dayPart(row.createdAt) : ''}</Chip>
        </div>
        <button
          ref={closeRef}
          type="button"
          className="drawer__close"
          onClick={onClose}
          aria-label="Close the account panel"
        >
          <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M1 1l10 10M11 1L1 11"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <div className="drawer__body">
        {/*
          ★ THE ROW IS GONE, SO THE FORM IS GONE. A panel that kept its fields on screen
            after a 404 would be inviting an edit that cannot land, and the Save button
            is disabled by the same condition — this is the visible half of it.
        */}
        {missing ? (
          <div className="notice notice--err" role="alert">
            <p>
              <strong>That account is no longer in the register.</strong>
            </p>
            <p>
              The server answered <code>404</code> for id <code>{row?.id ?? ''}</code>. Nothing here
              is wrong with the form — the row it was opened on is gone, or the register has been
              rewritten since this page read it. Read it again to see what is actually stored.
            </p>
            <p>
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={() => {
                  setMissing(false);
                  onClose();
                }}
              >
                Close and re-read the register
              </button>
            </p>
          </div>
        ) : null}

        <form id="user-edit" onSubmit={onSave} noValidate>
          {saved ? (
            <div className="notice notice--ok" role="status">
              <p>
                <strong>Saved.</strong>{' '}
                {saved.charAt(0).toUpperCase() + saved.slice(1)} changed in the register.
              </p>
            </div>
          ) : null}

          {patchProblem ? (
            <div className="notice notice--err" role="alert">
              <p>
                <strong>That was refused.</strong>
              </p>
              <p>{patchProblem}</p>
              {patchAccepts.length ? (
                <p>This register accepts {patchAccepts.map((v) => `“${v}”`).join(', ')} here.</p>
              ) : null}
            </div>
          ) : null}

          <div className="field">
            <label className="field__label" htmlFor="user-edit-name">
              Name
            </label>
            <input
              id="user-edit-name"
              className="input"
              type="text"
              autoComplete="off"
              value={draft.name}
              onChange={(event) => edit({ name: event.target.value })}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="user-edit-email">
              Email
            </label>
            <input
              id="user-edit-email"
              className="input"
              type="email"
              value={draft.email}
              disabled
              readOnly
            />
            <p className="field__hint">
              Read-only, and not by omission: <code>PATCH /api/users/{'{id}'}</code> has no case for
              an address, because the address is the key sign-in looks the account up by. Changing
              one means creating an account and giving the old one no password.
            </p>
          </div>

          <RoleField
            idPrefix="user-edit"
            value={draft.role}
            register={register}
            onChange={(role) => edit({ role })}
          />

          <MembershipPicker
            idPrefix="user-edit"
            orgs={orgs}
            memberships={draft.memberships}
            primary={draft.primary}
            onChange={edit}
          />

          {/*
            ★ SAID WHERE THE FIELDS ARE, NOT IN A FOOTNOTE SOMEWHERE ELSE. Removing an
              account is the first thing somebody opens a register like this to do, and
              the answer is that this one does not — so the answer is here rather than
              in a note beside a button that does not exist.
          */}
          <p className="chart-note userpanel__no-delete">
            <strong>There is no Remove, and that is deliberate.</strong> An account can be created,
            renamed, re-roled, moved between organizations and given a new password; nothing here
            deletes one, disables one or takes a role away. The rows are referenced by the writes
            those accounts made, and this app has no way to un-read a ledger somebody has already
            read.
          </p>
        </form>

        {/*
          ★ A FORM OF ITS OWN, INSIDE THE DRAWER BODY BUT OUTSIDE THE PATCH FORM. It
            cannot be inside `#user-edit` — nested forms are invalid markup and a submit
            button inside one posts to the other — and it must not be, because these are
            two requests with two answers.
        */}
        <form id="user-password" className="userpanel__pw" onSubmit={onSetPassword} noValidate>
          <h3 className="userform__title">Password</h3>

          {pwSaved ? (
            <div className="notice notice--ok" role="status">
              <p>
                <strong>Stored.</strong> The next sign-in uses it — and only the next one. Sessions
                already issued keep working until they expire, because the server checks a signature
                rather than the credential.
              </p>
            </div>
          ) : null}

          {pwProblem ? (
            <div className="notice notice--err" role="alert">
              <p>
                <strong>That was refused.</strong>
              </p>
              <p>{pwProblem}</p>
            </div>
          ) : null}

          {row ? (
            <p className="chart-note">
              {row.hasPassword
                ? 'This account has a password. Setting another replaces it immediately — there is no confirmation step and no history, so the previous value stops working the moment this is stored.'
                : 'This account has never had a password, so it cannot sign in. Storing one here is what finishes it.'}
            </p>
          ) : null}

          <PasswordField
            idPrefix="user-edit"
            value={password}
            onChange={(next) => {
              setPwProblem(null);
              setPwSaved(false);
              setPassword(next);
            }}
            label="New password"
            hint="Eight characters minimum, hashed on arrival and never returned. Issued sessions are not ended by this."
          />

          <div className="idcard__actions">
            <button
              type="submit"
              className="btn btn--primary"
              disabled={password.length < PASSWORD_MIN || pwBusy}
            >
              {pwBusy ? 'Storing…' : row?.hasPassword ? 'Replace password' : 'Set password'}
            </button>
            <p className="field__hint">
              {password.length < PASSWORD_MIN
                ? 'Generate a value, or type one at least eight characters long.'
                : 'Stops the next sign-in and no existing session. Anybody already signed in stays signed in until the token expires.'}
            </p>
          </div>
        </form>
      </div>

      <div className="drawer__foot">
        <button
          type="submit"
          className="btn btn--primary"
          form="user-edit"
          disabled={!complete || patch === null || busy || missing}
        >
          {busy ? 'Saving…' : saved && patch === null ? 'Saved' : 'Save changes'}
        </button>
        <button type="button" className="btn btn--system" onClick={onClose}>
          Close
        </button>
        <p className="userpanel__note">
          {!complete
            ? 'A name and at least one organization are required. An account with a choice of them also has to say which one it signs in to. The role is always one of the three.'
            : patch === null
              ? 'Nothing has changed yet, so there is nothing to send. An update that names no fields is refused rather than treated as a no-op.'
              : `Sends only what differs — ${describeUserPatch(patch)}. Nothing is written to Oracle, and no password is sent by this button.`}
        </p>
      </div>
    </aside>
  );
}

/**
 * A new account, composed in a panel that slides in from the right.
 *
 * ── ★ IT IS THE THIRD DRAWER ON THIS PAGE, AND THE SHELL IS THE SAME ON PURPOSE
 *
 * Escape closes, Tab is trapped, focus goes back to the `+ New` button, the body is
 * locked while it is open, the width is dragged and remembered. The markup is repeated
 * rather than extracted for the reason `UserPanel` gives: the fields inside share
 * nothing with the organization panel's, and pulling the shell out would mean a
 * component taking `children` and passing the whole lifecycle down — more machinery
 * than three uses justify. The part that must not diverge is the behaviour, and it is
 * copied exactly.
 *
 * ── ★ BUT IT SHARES THE ACCOUNT PANEL'S WIDTH, WHERE THE OTHER TWO DO NOT SHARE ONE
 *
 * `USER_PANEL_WIDTH_KEY` is used by both account panels and `ORG_PANEL_WIDTH_KEY` by
 * neither of them, and the distinction is the fields rather than the count. These two
 * panels ask the same six questions in the same order, so two widths would mean a
 * person who widened the register's panel to read a long address has to widen the
 * create panel to read the address they are typing. The organization panel holds four
 * scope inputs and is genuinely a different shape, which is the case its own note
 * makes.
 *
 * ── ★ IT WAS AN INLINE FORM, AND THE REASON IT STOPPED BEING ONE IS NOT AESTHETIC
 *
 * It used to open inside the accordion, under the list. That works while the register
 * is short and stops working as soon as it is not: the fields appeared below however
 * far the list had grown, so the act of adding an account pushed the fields for that
 * account off the screen. A drawer has its own scroll and its own position, and it does
 * not move because the register behind it grew a row.
 *
 * ── ★ THE DRAFT SURVIVES A CLOSE AND IS EMPTIED ONLY BY A SUCCESSFUL CREATE
 *
 * Escape on a half-typed account is far more often a mis-press than a decision to throw
 * the work away, so what was typed stays typed and re-opening the panel shows it again.
 * The one thing that clears it is the write landing, where every field is stale by
 * definition. That reset is **whole, including the role**, unlike the organization
 * form which deliberately keeps the fund, the programs and the year: those describe the
 * tenant the administrator is *in*, and there is no equivalent here — the last
 * account's role describes the last account, and carrying `super_admin` forward as a
 * pre-filled default is a mistake one keystroke from being made.
 */
function NewUserPanel({
  open,
  orgs,
  register,
  onClose,
  onCreated,
}: {
  open: boolean;
  orgs: readonly Organization[];
  register: UserList | null;
  onClose: () => void;
  onCreated: (row: AppUser) => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  // ★ THE SAME TWO REASONS `UserPanel` HAS THESE, AND THE SAME KEY.
  const [width, setWidth] = useState<number | null>(() => readStoredWidth(USER_PANEL_WIDTH_KEY));
  const [resizing, setResizing] = useState(false);
  const [rendered, setRendered] = useState(0);

  const [draft, setDraft] = useState<UserDraft>(BLANK_USER);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [accepts, setAccepts] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement as HTMLElement | null;
    document.body.classList.add('is-locked');
    return () => {
      document.body.classList.remove('is-locked');
      openerRef.current?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (open) closeRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const measure = () => setRendered(panelRef.current?.getBoundingClientRect().width ?? 0);
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

  useEffect(() => {
    document.body.classList.toggle('is-resizing', resizing);
    return () => document.body.classList.remove('is-resizing');
  }, [resizing]);

  const ready = userDraftComplete(draft, true);

  /** A keystroke. Clears the refusal, for the reason the organization form's `editDraft` gives. */
  function edit(patch: Partial<UserDraft>) {
    setProblem(null);
    setDraft((current) => ({ ...current, ...patch }));
  }

  async function onCreate(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setProblem(null);
    setAccepts([]);
    try {
      const row = await createUser({
        email: draft.email.trim(),
        name: draft.name.trim(),
        role: draft.role,
        organizations: [...draft.memberships].sort((a, b) => a - b),
        // ★ OMITTED, NOT `null`, WHEN THE ANSWER WAS NEVER NEEDED. The server infers
        //   the sign-in organization from a single membership and refuses a stated
        //   `null` outright — so "there is no answer" and "the answer is nothing" are
        //   two different requests and only one of them is legal.
        ...(draft.primary === null ? {} : { primaryOrganizationId: draft.primary }),
        password: draft.password,
      });
      setDraft(BLANK_USER);
      onCreated(row);
      onClose();
    } catch (err: unknown) {
      setProblem(err instanceof Error ? err.message : 'The account was not recorded.');
      setAccepts(acceptedValues(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside
      ref={panelRef}
      id="user-new-panel"
      className={`drawer userpanel newuserpanel${open ? ' is-open' : ''}${resizing ? ' is-resizing' : ''}`}
      style={width === null ? undefined : ({ '--drawer-w': `${width}px` } as CSSProperties)}
      role="dialog"
      aria-modal="true"
      aria-label="New account"
      aria-hidden={!open}
      tabIndex={-1}
    >
      <ResizeGrip
        value={width ?? rendered}
        onChange={(next) => {
          const clamped = clampWidth(next);
          setWidth(clamped);
          storeWidth(USER_PANEL_WIDTH_KEY, clamped);
        }}
        onReset={() => {
          setWidth(null);
          storeWidth(USER_PANEL_WIDTH_KEY, null);
        }}
        onDraggingChange={setResizing}
        controls="user-new-panel"
        label="Resize the new-account panel"
      />

      <div className="drawer__head">
        <div className="drawer__eyebrow">
          Users &amp; roles · <code>new</code>
        </div>
        <h2 className="drawer__name">New account</h2>
        <div className="drawer__meta">
          {/*
           * ★ A STATEMENT ABOUT WHAT THE PANEL WILL MAKE, NOT A PREVIEW OF IT.
           *   `UserPanel`'s head describes the stored row and says why; this panel has
           *   no stored row, and inventing a live reading of the draft here would be a
           *   second, weaker answer to a question the fields below already answer. So
           *   the line states the rule the form is built on instead.
           */}
          A name, an address, a role, the organizations it belongs to and a first password — and
          every account belongs to <b>at least one organization</b>, because that is what it signs
          in to.
        </div>
        <button
          ref={closeRef}
          type="button"
          className="drawer__close"
          onClick={onClose}
          aria-label="Close the new-account panel"
        >
          <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M1 1l10 10M11 1L1 11"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      <div className="drawer__body">
        <form className="userform" id="user-new" onSubmit={onCreate} noValidate>
          {problem ? (
            <div className="notice notice--err" role="alert">
              <p>
                <strong>That was refused.</strong>
              </p>
              <p>{problem}</p>
              {accepts.length ? (
                <p>This register accepts {accepts.map((v) => `“${v}”`).join(', ')} here.</p>
              ) : null}
            </div>
          ) : null}

          <p className="chart-note">
            The address is the key sign-in looks the row up by, and it is lower-cased on write — so
            it is the one field that cannot be changed afterwards. A name and a role can be patched
            later, which is why <strong>Edit</strong> on the row shows the address and will not let
            it be typed into; this is the only screen that can choose one.
          </p>

          <div className="field">
            <label className="field__label" htmlFor="user-new-name">
              Name <span className="field__req">required</span>
            </label>
            <input
              id="user-new-name"
              className="input"
              type="text"
              autoComplete="off"
              value={draft.name}
              placeholder="e.g. A. Person"
              onChange={(event) => edit({ name: event.target.value })}
            />
            <p className="field__hint">
              What the header and the avatar show. Nothing in the ledger is keyed by it.
            </p>
          </div>

          <div className="field">
            <label className="field__label" htmlFor="user-new-email">
              Email <span className="field__req">required</span>
            </label>
            <input
              id="user-new-email"
              className="input"
              type="email"
              autoComplete="off"
              value={draft.email}
              placeholder="e.g. a.person@wcpss.net"
              onChange={(event) => edit({ email: event.target.value })}
            />
            <p className="field__hint">
              Stored lower-cased, and refused if another account already holds it.
              {register?.bootstrapEmail ? (
                <>
                  {' '}
                  The bootstrap address <code>{register.bootstrapEmail}</code> is refused here as
                  well — a row for it would never be reached, because <code>.env</code> answers
                  first.
                </>
              ) : null}
            </p>
          </div>

          <RoleField
            idPrefix="user-new"
            value={draft.role}
            register={register}
            onChange={(role) => edit({ role })}
          />

          <MembershipPicker
            idPrefix="user-new"
            orgs={orgs}
            memberships={draft.memberships}
            primary={draft.primary}
            onChange={edit}
          />

          <PasswordField
            idPrefix="user-new"
            value={draft.password}
            onChange={(password) => edit({ password })}
            label="First password"
            hint="Eight characters minimum. It is hashed on arrival and never returned — no route on this server can read one back — so it is worth copying down now."
          />
        </form>
      </div>

      <div className="drawer__foot">
        <button type="submit" className="btn btn--primary" form="user-new" disabled={!ready || busy}>
          {busy ? 'Recording…' : 'Create account'}
        </button>
        <button type="button" className="btn btn--system" onClick={onClose}>
          Close
        </button>
        <p className="userpanel__note">
          {ready
            ? 'The name, the address, the role, the organizations and the first password are the whole record. Nothing is written to Oracle. Closing this panel without creating keeps what has been typed.'
            : 'A name, an address, at least one organization and a password of eight characters are required. An account with a choice of organizations also has to say which one it signs in to.'}
        </p>
      </div>
    </aside>
  );
}
