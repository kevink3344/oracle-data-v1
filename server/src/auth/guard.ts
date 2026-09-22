/**
 * Who may do this.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS SEPARATE FROM `session.ts`
 * ---------------------------------------------------------------------------
 * `session.ts` answers *who is asking*. It deliberately does not answer *may
 * they* — apart from `isSuperAdmin`, which is a question about an `Actor` that
 * already exists. Admission is a property of the request, so it lives here, one
 * layer up, and a route reads as the sentence it is:
 *
 *     const actor = await requireSuperAdmin(req);
 *
 * ---------------------------------------------------------------------------
 * ★ WHY EVERY ROUTE CALLS THIS RATHER THAN A MIDDLEWARE ATTACHING THE ACTOR
 * ---------------------------------------------------------------------------
 * `writesGuard` is a middleware because it *refuses* — it has to run before the
 * router to stop a write reaching a handler at all. Attaching an actor refuses
 * nothing, so a middleware would buy one thing only: every request would pay a
 * database read for an identity most routes never ask about.
 *
 * `resolveActor` is cheap when there is no session — it returns `null` without
 * touching the database — but it *is* a query when there is one, and the routes
 * that need an identity are the small minority. So the read happens where the
 * question is asked, and a route that forgets to ask has no actor rather than a
 * stale one.
 */

import type { Request } from 'express';
import { AppError } from '../http/errors.js';
import { isSuperAdmin, resolveActor, type Actor } from './session.js';

/**
 * The caller, or 401.
 *
 * `resolveActor` returns null for six different situations — no header, an
 * unknown token, an expired token, a valid token whose user was deleted, a
 * bootstrap address that is no longer configured, and a user with no
 * organization. The client is told the same thing in all six, on purpose: *"you
 * are not signed in"* and *"that was not you"* are the same instruction, and
 * distinguishing them would tell an attacker which half they got right.
 */
export async function requireActor(req: Request): Promise<Actor> {
  const actor = await resolveActor(req);
  if (actor === null) throw AppError.unauthorized();
  return actor;
}

/**
 * The caller, or 401, or 403.
 *
 * ★ THE TWO FAILURES ARE NOT THE SAME AND THE CLIENT IS TOLD WHICH. A caller with
 *   no session is sent to sign in; a signed-in member who is not a super admin is
 *   not. Collapsing 403 into 401 would put a member in a sign-in loop they
 *   cannot win, because the reason they are refused is not something signing in
 *   again can change.
 *
 * The message names the role and the account, so a refused member can tell the
 * difference between "I am not allowed" and "the server has my role wrong" —
 * which is the only question this error will ever actually raise.
 *
 * ★ AND IT NAMES THE *CAPABILITY*, NOT THE VERB OF THE ROUTE THAT RAISED IT. It
 *   used to read "only a super admin can **change** an organization", which is
 *   the right sentence for `POST` and the wrong one for `GET /api/organizations`
 *   — a member who was only *reading the register* was told they may not change
 *   one, so the message sent them to ask for permission they were not after. The
 *   register is one capability and four routes read it or write it, so the
 *   sentence above names the register.
 */
export async function requireSuperAdmin(req: Request): Promise<Actor> {
  const actor = await requireActor(req);
  if (!isSuperAdmin(actor)) {
    throw AppError.forbidden(
      `"${actor.email}" is signed in as ${actor.role}, and the organization register is ` +
        'restricted to super admins. Ask an administrator to make the change, or to give this ' +
        'account the super_admin role.',
      { role: actor.role },
    );
  }
  return actor;
}
