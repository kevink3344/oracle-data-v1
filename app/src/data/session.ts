/**
 * Who is signed in.
 *
 * ★ THIS EXISTS BECAUSE A NAME WAS TYPED TWICE.
 *   The avatar in the top bar carried `Dana Whitfield` and the initials `DW` as
 *   two string literals, and nowhere else in the app knew there was a user at
 *   all. Recording a project needs an owner, and the owner is "whoever is signed
 *   in" — so the moment that field appeared there were two places that had to
 *   agree about a name and no mechanism making them. A project created by `Dana
 *   Whitfield` while the avatar says `D. Whitfield` is a small lie in a system
 *   whose whole subject is which row says what.
 *
 * ★ THE SERVER NOW ANSWERS, AND THIS MODULE ASKS IT.
 *   Until Phase 1 of `docs/plans/organizations.md` landed, the server half of this
 *   was a constant with a comment saying so. It now signs in against
 *   `POST /api/auth/sign-in`, holds the token, re-checks it against
 *   `GET /api/auth/session` on boot, and sends it back in the `x-app-session`
 *   header. The header name and the user's shape are the server's; nothing here
 *   invents either.
 *
 * ★ WHY THE SIGNED-OUT STATE IS A PLACEHOLDER USER AND NOT `null` — AND WHAT CHANGED
 *   WHEN THE GATE LANDED.
 *
 *   The placeholder was introduced for a decision in `docs/plans/organizations.md` §8
 *   — *a signed-out visitor still browses the default tenant* — and the argument was
 *   about a page rather than about permissions: this module has two callers, and
 *   returning `null` for a visitor would have left the avatar as a dash (fine) and
 *   would have disabled **Create** on the new-project form, which worked signed out
 *   and had not been asked to stop.
 *
 *   ★ THAT DECISION HAS SINCE BEEN REVERSED, ON PURPOSE, AND THIS COMMENT IS THE
 *     PLACE IT HAD TO BE RECORDED. `App.tsx` now gates every route except `/sign-in`
 *     on `authenticated`, so a visitor with no session sees no register at all, never
 *     reaches that form, and never meets the placeholder as a *browsing identity*.
 *     There is no such identity any more.
 *
 *     The object survives because of the second thing it does, which the reversal did
 *     not touch: it gives the gate a value to test and gives the form an owner to
 *     refuse. Deleting it would not simplify anything — `Gate` reads `authenticated`
 *     off it, `NewProject` reads the absence of a name off it, and both of those are
 *     the checks the rest of this file and that route already justify. What was wrong
 *     was only the claim about what a reader may then browse, and that claim lived in
 *     prose rather than in code, which is exactly how it outlived the behaviour it
 *     described.
 *
 *   So the guest state is `SIGNED_OUT` below: an ordinary `member` with a name, no
 *   email, and **no organization**. It is not an account and it is not a tenant — it
 *   cannot unlock anything, because every guarded route wants a token this object does
 *   not have, and since the gate it cannot even reach a request. What it is, precisely,
 *   is the state the gate refuses to draw the app in, and `authenticated: false` is how
 *   a reader tells it apart from a real session.
 *
 * ★ TWO DEVIATIONS FROM THE SHAPE IN THE PLAN, BOTH FOR THE PLACEHOLDER.
 *   §1 gives `organizationId: number` and `organization: Scope`. A guest has
 *   neither, so both are nullable here and are non-null on every session that came
 *   from `POST /api/auth/sign-in` — the server's `SessionUserSchema` makes
 *   `organizationId` required, so the null case is reachable only through
 *   `SIGNED_OUT`. Phase 2, which reads the scope off the tenant instead of off
 *   `data/scope.ts`, is where the guest's organization gets filled in; today the
 *   scope still comes from the extract's constant and a guest has no tenant.
 *
 * ★ `session()` RETURNS `null` ONLY WHILE THE FIRST REQUEST IS IN FLIGHT.
 *   That is the one moment where "we do not know yet" is different from "nobody".
 *   It is also why the boot request is skipped entirely when there is no stored
 *   token: the common case is a browser that is not signed in, and that case must
 *   not flicker through an unknown state on every load.
 *
 * ★ THE TOKEN IS NOT A CREDENTIAL IN THE USUAL SENSE, AND THIS FILE SAYS SO.
 *   The server keeps sessions in a process-local `Map`, so the token is gone on
 *   restart, unknown to a second replica, and expires after twelve hours. There is
 *   no sign-out endpoint to call and no way to refresh, so signing out is
 *   `signOut()` — dropping the browser's copy — and the server's copy expires on
 *   its own. Storing it in `localStorage` rather than a cookie therefore makes no
 *   security difference here: the server set no cookie, and this token has no
 *   `HttpOnly` protection to lose.
 */

import { useSyncExternalStore } from 'react';
import type { Scope } from './scope';

/** The header the server reads. Mirrors `SESSION_HEADER` in `server/src/auth/session.ts`. */
export const SESSION_HEADER = 'x-app-session';

/** Where the browser keeps its copy of the token. */
const TOKEN_KEY = 'projects-session-token';

export type Role = 'super_admin' | 'member';

/**
 * The tenant a session is in — the scope, plus the fiscal year it starts reading at.
 *
 * ★ IT EXTENDS `Scope` RATHER THAN REPEATING IT. Everything that narrows rows takes
 *   a `Scope`, and a tenant *is* one, so this widens the local type instead of
 *   introducing a second shape that has to be converted at every call. What it
 *   adds is `startFy`: the server sends it on the sign-in payload
 *   (`SessionOrganizationSchema`) and the organization register stores it, and it is
 *   the third half of what a tenant is — fund, programs, start FY.
 *
 * ★ `startFy` IS NOT IN `Scope`, AND THAT IS NOT AN OVERSIGHT. The extract's own
 *   envelope carries the window it was pulled for. `Scope` answers "which rows",
 *   and the year answers "from when" — the two are reconciled in Phase 2 rather
 *   than merged here.
 */
export interface SessionOrganization extends Scope {
  /** The first fiscal year this tenant reads. Fiscal years run July–June. */
  startFy: number;
}

export interface SessionUser {
  /** Full display name — what a project row stores as its owner. */
  name: string;
  /** What the avatar shows. Derived by the server, never typed separately. */
  initials: string;
  /** Lower-cased address. Empty for the signed-out placeholder. */
  email: string;
  role: Role;
  /**
   * `organization.id`, or `null` for the signed-out placeholder — see the note at
   * the head of this file. Every session the server issued has one.
   */
  organizationId: number | null;
  /** `organization.name`, for the Settings header. Empty when signed out. */
  organizationName: string;
  /** The tenant's fund, programs and start FY. `null` when signed out. */
  organization: SessionOrganization | null;
  /**
   * False for the placeholder. The one field that says "this is a name, not a login".
   *
   * ★ THE SERVER DOES NOT SEND THIS, AND THIS TYPE USED TO CLAIM IT DID.
   *   `SessionUserSchema` in `server/src/routes/auth.ts` has seven fields and
   *   `authenticated` is not among them — it is not a fact about an account, it is
   *   a fact about *where the object came from*, which only the client knows. The
   *   payload used to be cast straight to this type, so TypeScript had no reason to
   *   object and every real session carried `undefined`: initials `SA` beside a
   *   tooltip *denying* a sign-in that had just happened, and — because the login
   *   screen gates its whole signed-in card on this one flag — **no way to sign out**,
   *   since the card holding the Sign out button was the thing never rendered. That
   *   flag is what the gate in `App.tsx` now branches on, so a second `undefined` here
   *   would lock the app behind a login screen that could not be passed.
   *
   *   So it is stamped in {@link asSignedIn}, at the two places a server-issued
   *   user arrives, and the wire shape is {@link WireUser} — the cast now names a
   *   type that does *not* have the field, which is what forces the stamping rather
   *   than merely remembering to do it.
   */
  authenticated: boolean;
}

/**
 * A user as the server sends it: everything above except the field the server has
 * never heard of.
 */
type WireUser = Omit<SessionUser, 'authenticated'>;

/** A user and the token that stands for them. The token is the caller's copy. */
export interface Session {
  user: SessionUser;
  /** `null` when there is no token — a placeholder, not a session. */
  token: string | null;
}

/**
 * Stamp a server-issued user as authenticated.
 *
 * The one place that knows the difference between the seven fields the server
 * sends and the eight a session has. Takes `WireUser` and returns `SessionUser`, so
 * the conversion cannot be skipped by a caller that has the wire object in hand —
 * the compiler asks for it.
 */
function asSignedIn(wire: WireUser): SessionUser {
  return { ...wire, authenticated: true };
}

/** `Dana Whitfield` → `DW`. Two letters, or one when there is one word. */
function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  return words
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

/**
 * The signed-out browsing identity.
 *
 * ★ IT KEEPS THE NAME THE MODULE ALWAYS HAD. Every screenshot and every stored
 *   project owner in this sample reads `Dana Whitfield`, so the placeholder is the
 *   same string rather than a new one — the point of this change is to make the
 *   signed-out state *visible*, not to rename it.
 *
 *   It is a `member`, which is why the Settings gear is hidden for it, and it has
 *   no organization, which is why it cannot be sent to a guarded route.
 */
const SIGNED_OUT: SessionUser = {
  name: 'Dana Whitfield',
  initials: initialsOf('Dana Whitfield'),
  email: '',
  role: 'member',
  organizationId: null,
  organizationName: '',
  organization: null,
  authenticated: false,
};
// ---------------------------------------------------------------------------
// The store.
// ---------------------------------------------------------------------------

/**
 * `loading` is "a token is held and the server has not answered yet".
 *
 * It is never a state the app sits in: the boot request resolves to `ready`
 * whatever happens, because a server that cannot be reached must leave the app in
 * its ordinary signed-out shape rather than on a spinner.
 */
type Status = 'loading' | 'ready';

interface State {
  status: Status;
  session: Session | null;
}

/** The stored token, or null. A browser with storage disabled answers null rather than throwing. */
function readToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(token: string | null): void {
  try {
    if (token === null) window.localStorage.removeItem(TOKEN_KEY);
    else window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* A browser that refuses storage still gets a working session for this tab. */
  }
}

let state: State = { status: 'ready', session: { user: SIGNED_OUT, token: null } };

const listeners = new Set<() => void>();

function setState(next: State): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// Reading.
// ---------------------------------------------------------------------------

/**
 * The signed-in user, the placeholder, or `null` while the boot request is out.
 *
 * Returns `null` rather than throwing so the two things that might want a user can
 * each decide for themselves what to show. The avatar renders a dash; the form
 * disables Create rather than inventing an owner.
 */
export function session(): SessionUser | null {
  return state.session?.user ?? null;
}

/**
 * The owner a new project should be recorded against, or `null`.
 *
 * Named separately from `session()` because this is the one field a caller
 * stores, and a caller storing `session()!.name` would need the non-null
 * assertion that this function exists to remove.
 *
 * ★ It returns a **name**, not an address, and it keeps doing so now that there is
 *   a real session: the value is written into `saved_view.created_by` and read
 *   back by the View Builder's "saved by" column. Changing it to an address would
 *   change what an existing row means.
 *
 * Takes the user it should read, optionally, for the same reason {@link isSuperAdmin}
 * does: a component that already holds one from `useSession()` must ask about *that*
 * object rather than about whatever the module is holding one tick later. The Saved
 * Views page sends this name to the server as `subscriber` and prints it above the
 * table, and those two have to be the same string or the page misattributes its own
 * request.
 */
export function currentOwner(user?: SessionUser | null): string | null {
  return (user ?? session())?.name ?? null;
}

/**
 * Whether the session may configure organizations.
 *
 * ★ THE GEAR READS THIS, AND THE SERVER DECIDES IT. `role` is re-read from the
 *   database on every `GET /api/auth/session`, so a promotion shows up on the next
 *   load without a new sign-in. The check is a *convenience* — the four
 *   organization endpoints call `requireSuperAdmin` and answer 403 regardless of
 *   what this returns. A hidden button is not an access control and this file does
 *   not claim to be one.
 *
 * Takes the user it should judge, optionally, so a component that already holds one
 * from {@link useSession} asks about *that* object rather than about whatever the
 * module happens to be holding one tick later. Called with no argument it answers
 * for the current session, which is what an event handler wants.
 */
export function isSuperAdmin(user?: SessionUser | null): boolean {
  return (user ?? session())?.role === 'super_admin';
}

/** Whether a token is held. False for the placeholder and while loading. */
export function isAuthenticated(): boolean {
  return state.session?.user.authenticated === true;
}

/**
 * Headers for a request that may be made as this session.
 *
 * Spread into a `fetch` init rather than written per call site, so the header name
 * appears once in the client. Signed out this is `{}` — the guarded endpoints
 * answer 401, which is the answer the caller should be showing.
 */
export function sessionHeaders(): Record<string, string> {
  const token = state.session?.token;
  return token ? { [SESSION_HEADER]: token } : {};
}

/**
 * A component that re-renders when the session changes.
 *
 * `useSyncExternalStore` rather than a context provider: the session is read by
 * two components that are not arranged as ancestor and descendant — the rail's
 * gear and the top bar's avatar — and threading a provider through the shell to
 * reach both would be prop-drilling for one object.
 */
export function useSession(): SessionUser | null {
  return useSyncExternalStore(subscribe, session, session);
}

// ---------------------------------------------------------------------------
// Writing.
// ---------------------------------------------------------------------------

/** What `POST /api/auth/sign-in` answers, once `{ data: … }` is stripped. */
interface SessionPayload {
  token: string;
  user: WireUser;
}

/** The server's error envelope, as far as this module reads it. */
interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

/** The envelope's message, or a status line when the body is not the envelope. */
async function readError(res: Response): Promise<Error> {
  let detail = `HTTP ${res.status} ${res.statusText}`;
  try {
    const body = (await res.json()) as ErrorEnvelope;
    if (body?.error?.message) detail = body.error.message;
  } catch {
    /* The status line stands. A body that is not JSON is not worth failing over twice. */
  }
  return new Error(detail);
}

/** Settle into the signed-out shape, dropping the token. */
function fail(): void {
  writeToken(null);
  setState({ status: 'ready', session: { user: SIGNED_OUT, token: null } });
}

/**
 * Check the stored token, and settle into `ready` either way.
 *
 * ★ A 401 DROPS THE TOKEN; ANY OTHER FAILURE KEEPS IT. The two are different
 *   facts: 401 means the server looked and refused — expired, unknown, or the
 *   account was deleted since — while a network error means nobody was asked.
 *   Destroying a valid token because the server was briefly unreachable would sign
 *   the user out for the rest of the day. So a network failure below leaves the
 *   stored token alone and starts again, signed out, on the next load.
 *
 * The endpoint is not a refresher — it deliberately omits the token — so the
 * client keeps the one it has and this call cannot extend its life.
 */
export async function startSession(): Promise<void> {
  const token = readToken();
  if (token === null) return;

  setState({ status: 'loading', session: null });
  let res: Response;
  try {
    res = await fetch('/api/auth/session', { headers: { [SESSION_HEADER]: token } });
  } catch {
    setState({ status: 'ready', session: { user: SIGNED_OUT, token: null } });
    return;
  }

  if (res.status === 401) {
    fail();
    return;
  }
  if (!res.ok) {
    fail();
    return;
  }

  try {
    const body = (await res.json()) as { data?: { user?: WireUser } };
    const user = body?.data?.user;
    if (!user) {
      fail();
      return;
    }
    setState({ status: 'ready', session: { user: asSignedIn(user), token } });
  } catch {
    fail();
  }
}

/**
 * Re-read the session from the server, **staying signed in while it happens**.
 *
 * ★ EVERY REQUEST THE SERVER ANSWERS RE-RESOLVES THE TENANT. `organization` is not
 *   baked into the token — `resolveActor` loads the organization row on each call
 *   — so editing an organization the caller is in changes what the *server* will
 *   send back on the very next request, with no new sign-in. What does not change
 *   is the copy of the session this module is holding, and the store reads the
 *   scope out of exactly that copy (`data/session.ts` is the only source of the
 *   tenant — see the ★ in `state/store.tsx`). So a Settings edit used to leave the
 *   app filtering by the organization's *old* scope until the next page load,
 *   while the panel's own footer promised "the chips above follow it".
 *
 * ★ IT DOES NOT GO THROUGH `loading`, WHICH IS THE WHOLE REASON IT EXISTS.
 *   `startSession` sets `session: null` first, and `null` is the one value the
 *   login gate reads as "still checking" — so reusing it here would unmount the
 *   entire shell behind the gate, taking the Settings drawer, its unsaved draft,
 *   the scroll position and the focus with it. On boot there is nothing to
 *   destroy, which is why the same blank step is right there and wrong here.
 *
 * ★ A FAILURE LEAVES THE SESSION ALONE, EXCEPT A 401. The two are different
 *   facts, the same way they are in `startSession`: 401 means the server looked
 *   and refused, while a network error means nobody was asked — and this call
 *   happens *after* a write has already succeeded, so throwing the session away
 *   over a blip would sign a reader out in the middle of a task they just
 *   completed. It returns rather than throwing for the same reason: the write is
 *   done, the notice belongs on screen, and the caller has nothing to do about a
 *   refresh that could not happen.
 */
export async function refreshSession(): Promise<void> {
  const token = state.session?.token;
  if (token === null || token === undefined) return;

  let res: Response;
  try {
    res = await fetch('/api/auth/session', { headers: { [SESSION_HEADER]: token } });
  } catch {
    return;
  }

  if (res.status === 401) {
    fail();
    return;
  }
  if (!res.ok) return;

  try {
    const body = (await res.json()) as { data?: { user?: WireUser } };
    const user = body?.data?.user;
    if (!user) return;
    setState({ status: 'ready', session: { user: asSignedIn(user), token } });
  } catch {
    /* Not JSON. The session it already has stands. */
  }
}

/**
 * Exchange credentials for a session, and keep it.
 *
 * Throws with the server's message, which is the same sentence for a wrong
 * password and for an unknown address on purpose — the endpoint's own note
 * explains why, and a client that added detail here would undo it.
 */
export async function signIn(email: string, password?: string): Promise<SessionUser> {
  const body: { email: string; password?: string } = { email };
  if (password) body.password = password;

  const res = await fetch('/api/auth/sign-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await readError(res);

  const payload = (await res.json()) as { data?: SessionPayload };
  const token = payload?.data?.token;
  const user = payload?.data?.user;
  if (!token || !user) throw new Error('The server accepted the sign-in but sent no session.');

  // Once, and stored as the same object it returns: two calls to `asSignedIn`
  // would give the caller a user that is `!==` the one in the store, and a caller
  // holding one while the avatar holds the other is the disagreement this file
  // exists to prevent.
  const who = asSignedIn(user);
  writeToken(token);
  setState({ status: 'ready', session: { user: who, token } });
  return who;
}

/**
 * Drop the browser's copy of the token.
 *
 * ★ THERE IS NO SERVER CALL, AND THAT IS THE SERVER'S DESIGN RATHER THAN A GAP
 *   HERE: sessions live in a process-local map with a twelve-hour TTL and there is
 *   no revoke endpoint. So this ends the session in this browser and the server's
 *   copy runs out on its own. A button saying "signed out everywhere" would be
 *   false, so the page says what actually happened instead.
 */
export function signOut(): void {
  writeToken(null);
  setState({ status: 'ready', session: { user: SIGNED_OUT, token: null } });
}
