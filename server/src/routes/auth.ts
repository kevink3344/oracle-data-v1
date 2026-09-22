import { z } from '../http/z.js';
import type { Api } from '../http/api.js';
import { AppError } from '../http/errors.js';
import { intReq, textReq } from '../schemas/columns.js';
import {
  SESSION_HEADER,
  authenticate,
  resolveActor,
  sessionUserFor,
  type SessionUser,
} from '../auth/session.js';

/**
 * The two endpoints that turn an identity into a session, and a session back into
 * an identity.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS THIN, AND SHOULD STAY THIN
 * ---------------------------------------------------------------------------
 * Everything that decides *who* a caller is lives in `auth/session.ts`: the token
 * store, the bootstrap credential, the tenant lookup, the role. These two routes
 * are the wire around it — a body schema, a response schema, and one call each.
 *
 * The temptation is to put policy here: "only super admins may sign in with a
 * password", "a member from organization 3 may not read organization 4". Both are
 * real questions and neither belongs in a route, because a route is reached once
 * and a rule written once holds everywhere only if it lives where every caller
 * passes. `/api/auth/session` and `/api/auth/sign-in` therefore do no checks of
 * their own beyond "is this request shaped like a sign-in".
 *
 * ---------------------------------------------------------------------------
 * ★ TWO ROUTES, AND WHY NEITHER IS A `GET`-WITH-A-TOKEN
 * ---------------------------------------------------------------------------
 * `POST /api/auth/sign-in`   credentials in, token out.
 * `GET  /api/auth/session`   token in, current user out.
 *
 * The second exists because the client keeps the session in `localStorage` and
 * `localStorage` outlives the server. A stored token is a claim, not a fact: the
 * process may have restarted (the store is a `Map` — see `session.ts`), the
 * account may have been re-tenanted, or the bootstrap address may have been
 * removed from `.env`. The client calls this on boot and keeps the answer, so the
 * role and the organization it is displaying came from the server a moment ago
 * rather than from a string a previous version of the app wrote.
 *
 * It is deliberately not a *refresher*. The response omits the token, so a client
 * that has lost it cannot recover one here — the TTL is fixed at sign-in and the
 * only way to a new token is to sign in again. See the note on `SessionPayload`.
 */

const RoleSchema = z
  .enum(['super_admin', 'member'])
  .openapi({ description: '`super_admin` may create and edit organizations. `member` may read.' });

/**
 * The organization, as a session carries it.
 *
 * ★ These three fields are a *configuration*, not a permission. They decide which
 *   rows exist from this tenant's point of view — the fund and programs that
 *   filter the ledger, and the fiscal year the window opens on. Nothing here says
 *   what the account may do; that is `role`.
 */
const SessionOrganizationSchema = z
  .object({
    fund: textReq('`GL_CODE_COMBINATIONS.SEGMENT1` — the fund this tenant is scoped to.'),
    programs: z
      .array(z.string())
      .openapi({
        description:
          '`GL_CODE_COMBINATIONS.SEGMENT3` values in scope. **An empty list is legal and means the ' +
          'configuration selects no rows** — it is not an error, and the screens it feeds render their ' +
          'ordinary empty state rather than a warning. The extract is a sample, so "matches nothing today" ' +
          'is a state an organization can legitimately be in.',
        example: ['861', '862', '863'],
      }),
    startFy: intReq(
      'The fiscal year the window opens on. Fiscal years run July–June, so FY 2022 is 2021-07-01 onward.',
    ),
  })
  .openapi('SessionOrganization');

/**
 * ★ THE TOKEN IS THE CALLER'S COPY, NOT A REFRESHABLE CREDENTIAL.
 *
 * `initials` is computed on the server rather than in the browser so the avatar
 * cannot disagree with the name beside it — one implementation, one answer.
 */
const SessionUserSchema = z
  .object({
    name: textReq('Display name. The bootstrap account has none of its own, so it is `Super Admin`.'),
    initials: textReq('Derived from `name`: first letter of the first and last word.'),
    email: textReq('Normalised to lower case — the form `app_user.email` is stored in.'),
    role: RoleSchema,
    organizationId: intReq('`organization.id`.'),
    organizationName: textReq('`organization.name`, for the header and the Settings screen.'),
    organization: SessionOrganizationSchema,
  })
  .openapi('SessionUser');

const SessionPayloadSchema = z
  .object({
    token: textReq(
      `Opaque session token. Send it back in the \`${SESSION_HEADER}\` header on every request. ` +
        'It is a random string in a process-local store: not signed, not persisted, gone on restart, ' +
        'and unknown to a second replica.',
    ),
    user: SessionUserSchema,
  })
  .openapi('SessionPayload');

/** The wire shape of `{ data: … }`, so the handler and the spec cannot drift. */
interface SessionResponse {
  token: string;
  user: SessionUser;
}

export function registerAuth(api: Api): void {
  api.route({
    method: 'post',
    path: '/api/auth/sign-in',
    operationId: 'auth_sign_in',
    summary: 'Sign in',
    description:
      'Exchanges credentials for a session token and the identity the token stands for.\n\n' +
      '**The credentials are checked differently depending on who the address belongs to**, and the ' +
      'difference is the honest state of this server rather than an oversight:\n\n' +
      '  - **The bootstrap account** (`SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` in `.env`) is checked ' +
      'against the configured password. It is a credential for *one identity* — the account that exists ' +
      'before any tenant does — and answers "is this the bootstrap account?" and nothing else. It is ' +
      'bound to the organization marked `is_default = 1`.\n\n' +
      '  - **Any other address** is looked up in `app_user` and, if found, signed in. **There is no password ' +
      'to check**: `app_user` has no password column on purpose — see the schema in `data/sql/turso/01-app.sql`. ' +
      'A password sent with such an address is ignored rather than compared against nothing and reported ' +
      'as wrong. This means an address in `app_user` is an identity *claim*, not a proof, and the API does ' +
      'not pretend otherwise.\n\n' +
      'An address that is in neither place and one whose bootstrap password is wrong get the **same** ' +
      '401, with the same message, so this endpoint cannot be asked which addresses are configured. ' +
      'That said, the member path has no secret to protect — an `app_user` row signs in on its address ' +
      'alone — so the 401 protects the *bootstrap* address, not the user directory.\n\n' +
      '**403 is returned when the account exists but has no organization.** `app_user.organization_id` is ' +
      'nullable, and "belongs to an organization" and "has not been given one yet" are deliberately ' +
      'different states: an unassigned account cannot be shown the default tenant\'s data, because nobody ' +
      'put it there. The account is refused and told why.\n\n' +
      '**Body writes are the only writes.** If the account has a row, `last_seen_at` is stamped before ' +
      'this reply is sent, so "has this person ever signed in?" is answerable the moment it becomes true. ' +
      'That stamp is bookkeeping and is allowed to fail: it is swallowed and logged, so signing in works ' +
      'against a read-only target (this route is one of the few `POST`s that pass the write guard).',
    tags: ['Auth'],
    body: z
      .object({
        email: z
          .string()
          .trim()
          .min(1)
          .max(320)
          .openapi({
            description: 'The address to sign in as. Compared lower-cased.',
            example: 'admin@oracleinsights.local',
          }),
        password: z
          .string()
          .max(200)
          .optional()
          .openapi({
            description:
              'Only meaningful for the bootstrap account. Optional because most accounts have no password ' +
              'to supply — see the endpoint description. An empty string is *not* treated as a match for a ' +
              'configured password; an unset `SUPER_ADMIN_PASSWORD` refuses the sign-in rather than letting ' +
              'an empty field through.',
          }),
      })
      .openapi('SignInBody'),
    response: SessionPayloadSchema,
    // ★ 200, NOT THE POST DEFAULT OF 201.
    //   A session is created, so 201 is arguable — but this response is not the
    //   address of a new resource. There is no URL that returns this token again
    //   (`GET /api/auth/session` deliberately omits it), so a `Location`-style
    //   reading of 201 would point nowhere. 200 says "here is the answer to what
    //   you asked", which is what happened.
    status: 200,
    errors: [400, 401, 403, 500, 503],
    handler: async ({ body }) => {
      const { email, password } = body as { email: string; password?: string };
      // `authenticate` trims and lower-cases; passing the raw value through is
      // deliberate, so there is one place that decides what "the same address" means.
      return (await authenticate(email, password)) as SessionResponse;
    },
  });

  api.route({
    method: 'get',
    path: '/api/auth/session',
    operationId: 'auth_session',
    summary: 'Who the caller is',
    description:
      'Resolves the `' +
      SESSION_HEADER +
      '` header and returns the identity it stands for. The client calls this on boot to find out whether ' +
      'a token it was holding is still good, and what that token now means.\n\n' +
      '**The role and the organization are re-read from the database on every call** rather than being ' +
      'read out of the token, because the token does not carry them. A token is an opaque string that ' +
      'names an email; everything else is looked up fresh. So a user moved to another organization, or ' +
      'promoted, sees the change on their next request instead of at their next sign-in — and the session ' +
      'store cannot go stale about anything that matters.\n\n' +
      '**The response omits the token.** This is a validator, not a refresher: a client that has lost its ' +
      'token cannot recover one here, and the TTL set at sign-in is not extended by calling this. Renewing ' +
      'means signing in again.\n\n' +
      '**401 covers four situations that the caller cannot act on differently** — no header, an unknown ' +
      'token, an expired token, and an account deleted since the token was minted. They produce one ' +
      'message, and the client\'s response to all four is the same: show the sign-in form.',
    tags: ['Auth'],
    response: z
      .object({
        user: SessionUserSchema,
      })
      .openapi('SessionResponse'),
    errors: [401, 500, 503],
    handler: async ({ req }) => {
      const actor = await resolveActor(req);
      if (actor === null) throw AppError.unauthorized();
      return { user: sessionUserFor(actor) };
    },
  });
}
