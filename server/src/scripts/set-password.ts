/**
 * Set an account's password — and, with `--create`, create the account it belongs to.
 *
 *     npm run set:password -- --email dana@example.org
 *     npm run set:password -- --email dana@example.org --create --name "Dana Reed"
 *     npm run set:password -- --email dana@example.org --password '…'   (non-interactive)
 *
 * ── ★ WHY THIS SCRIPT IS LOAD-BEARING RATHER THAN A CONVENIENCE
 *
 * `app_user` gained `password_hash`, and `authenticate()` now REFUSES a row whose
 * hash is absent rather than admitting it. That is the safe direction — an absent
 * hash read as "no password required" would be the back door the column was added
 * to close — but it means a row without a hash is an account nobody can sign in to.
 *
 * ── ★ THIS SCRIPT USED TO BE THE ONLY WAY, AND IT IS NOT ANY MORE
 *
 * `POST /api/users/{id}/password` now sets a password, and `POST /api/users`
 * creates an account with one, so an operator signed in as a super admin has a
 * screen for both. What is left here is the case that screen cannot cover: the
 * state where **nobody can sign in yet**. An empty store, an address typed
 * wrong often enough that the way in looks closed, a password nobody recorded for
 * the only administrator. A tool that needed a session to unlock the door it
 * unlocks would be no tool at all.
 *
 * The two are not duplicates and the difference is worth knowing:
 *
 *     screen  who is already inside, acting on somebody else
 *     script  whoever holds the shell and the connection string, acting on anybody
 *
 * Only this file can create an account, set a role, or name an organization with
 * no session in existence. It is the last resort and it is deliberately the one
 * with the longest reach.
 *
 * The bootstrap pair in `.env` is unaffected and still works on an empty store. It
 * is a deployment convenience for the one identity that exists before any tenant
 * does, and it is deliberate that it is *not* in this table.
 *
 * ── ★ WHY THE PASSWORD IS PROMPTED FOR, AND WHY `--password` STILL EXISTS
 *
 * An argument is visible twice over: it is written to the shell's history file and
 * it is readable from the process list by any other user on the machine for as long
 * as this process runs. So the default is a prompt that reads from the terminal and
 * **echoes nothing**, asks twice, and refuses to store a blank.
 *
 * `--password` is kept because a prompt cannot be scripted. When it is used the
 * script says so rather than doing it quietly — an operator who reaches for the flag
 * should be told what it costs, not protected from a decision they have already made.
 *
 * ── ★ WHY `--create` IS A FLAG AND NOT THE DEFAULT BEHAVIOUR
 *
 * An address typed with a typo should fail, not become a second account. So the
 * ordinary run updates exactly one row and **exits non-zero if it matched none**,
 * which is the message an operator needs: the address is wrong, or the account does
 * not exist yet and `--create` is the flag that says you meant that.
 *
 * ── ★ `--create` WRITES TWO TABLES, AND THE SECOND ONE IS NOT OPTIONAL
 *
 * An account's sign-in organization is `app_user.organization_id`, and the set of
 * organizations it belongs to is `app_user_organization`. The sign-in organization
 * is always one of them — that is the invariant the application enforces in
 * `routes/users.ts` — so `--create` writes the membership row as well as the user
 * row. Writing only the first would produce an account that signs in, reads its
 * tenant, and is absent from the register of who belongs where.
 *
 * The ordinary run repairs that too, if it finds it: an account whose sign-in
 * organization has no membership row gets one, and the script says so rather than
 * doing it quietly. That is the one state this file can leave behind on an older
 * store, and leaving it behind a second time would be the tool knowing and not
 * saying.
 *
 * ── ★ WHAT THIS DOES NOT DO
 *
 * No route, no UI, no email, no password-strength policy, no reset flow. It is the
 * operator's tool for a server with one operator. Every one of those is a real thing
 * to build later and none of them is a thing to build by accident here.
 */

import { hashPassword } from '../auth/password.js';
import { config } from '../config/env.js';
import { requireAppSchema } from '../db/app-schema.js';
import { execute, one } from '../db/sql.js';

/**
 * Roles the database's `CK_app_user_role` check constraint will accept.
 *
 * The three names are listed here as well as in `auth/session.ts` and in
 * `routes/users.ts` because this script talks to the database without going through
 * either. A fourth role is a change in all three plus the constraint — the same
 * thing `isRole` says, and the same reason it is worth saying twice.
 */
const ROLES = ['super_admin', 'administrator', 'staff'] as const;
type Role = (typeof ROLES)[number];

interface Options {
  email: string | null;
  password: string | null;
  create: boolean;
  name: string | null;
  role: string | null;
  org: string | null;
}

/**
 * `--flag`, `--key value`, and `--key=value`, and nothing more clever than that.
 *
 * A real parser is a dependency and this script takes five arguments. An unrecognised
 * flag is an error rather than a shrug: a misspelled `--emial` silently ignored would
 * make the script look up the account named by `--email`'s absence and report success.
 */
function parseArgs(argv: readonly string[]): Options {
  const opts: Options = { email: null, password: null, create: false, name: null, role: null, org: null };
  const known = new Set(['--email', '--password', '--name', '--role', '--org']);

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i] ?? '';
    const eq = raw.indexOf('=');
    const flag = eq === -1 ? raw : raw.slice(0, eq);
    let value = eq === -1 ? null : raw.slice(eq + 1);

    if (flag === '--create') {
      opts.create = true;
      continue;
    }
    if (!known.has(flag)) {
      throw new Error(`Unrecognised argument "${raw}". See the header of this file for the accepted flags.`);
    }
    if (value === null) {
      i += 1;
      value = argv[i] ?? null;
    }
    if (value === null || value === '') {
      throw new Error(`${flag} needs a value.`);
    }

    if (flag === '--email') opts.email = value;
    else if (flag === '--password') opts.password = value;
    else if (flag === '--name') opts.name = value;
    else if (flag === '--role') opts.role = value;
    else opts.org = value;
  }

  return opts;
}

/**
 * Read a line from the terminal without echoing it.
 *
 * ★ RAW MODE, NOT `readline`, AND THAT IS A SECURITY CHOICE. `readline` writes what
 *   it receives straight to the output stream; suppressing that means reaching for
 *   the private `_writeToOutput`, which is not part of the API and has changed shape
 *   between Node versions. Handling the keystrokes directly means the characters
 *   never reach a rendering path that could echo them, and Backspace and Ctrl-C
 *   behave the way a password prompt is expected to.
 */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(
        new Error(
          'stdin is not a terminal, so there is nothing to prompt. Pass --password for non-interactive use.',
        ),
      );
      return;
    }

    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let typed = '';
    const finish = (value: string | null): void => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\n');
      if (value === null) reject(new Error('Cancelled.'));
      else resolve(value);
    };

    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish(typed);
        if (ch === '\u0003') return finish(null); // Ctrl-C
        if (ch === '\u007f' || ch === '\b') {
          typed = typed.slice(0, -1);
          continue;
        }
        // Ignore other control characters so a stray Escape cannot become part of
        // the password in a way the operator cannot see.
        if (ch >= ' ') typed += ch;
      }
    };

    stdin.on('data', onData);
  });
}

/**
 * Confirm a password two ways when it comes from a terminal, and not at all when it
 * comes from a flag. A prompt that cannot show you what you typed is exactly where a
 * typo becomes a locked account, so the second ask is not ceremony.
 */
async function readPassword(opts: Options): Promise<string> {
  if (opts.password !== null) {
    console.warn(
      '★ --password was passed on the command line. It is now in this shell\'s history and was ' +
        'readable from the process list while this ran. Omit the flag to be prompted instead.',
    );
    return opts.password;
  }

  const first = await promptHidden('New password: ');
  if (first === '') throw new Error('A blank password is not stored — every account must have a secret.');
  const second = await promptHidden('Again: ');
  if (first !== second) throw new Error('The two entries did not match. Nothing was written.');
  return first;
}

/**
 * The organization an account is being created in, by slug.
 *
 * `organization_id` is what decides which rows a tenant sees, so it is required for a
 * new account: `actorFor()` refuses a NULL with a 403, and creating an account that is
 * guaranteed to be unable to sign in is not a useful thing for this script to do.
 */
async function organizationIdFor(slug: string): Promise<number> {
  const row = await one<{ id: number; name: string }>(
    'SELECT id, name FROM organization WHERE slug = ?',
    [slug],
  );
  if (row === null) {
    throw new Error(
      `No organization has the slug "${slug}". The Organizations panel on the Settings ` +
        'screen lists them, or omit --org to use the default organization.',
    );
  }
  return row.id;
}

/** The default organization — `is_default = 1`, held to one row by a partial unique index. */
async function defaultOrganizationId(): Promise<number> {
  const row = await one<{ id: number; slug: string }>(
    'SELECT id, slug FROM organization WHERE is_default = 1',
  );
  if (row === null) {
    throw new Error(
      'No organization is marked as the default, so there is nothing to attach a new account to. ' +
        'Pass --org <slug>, or re-apply data/sql/sqlserver/01-app.sql which seeds one.',
    );
  }
  return row.id;
}

/**
 * Make sure the sign-in organization is recorded as a membership, and say so if it
 * was not.
 *
 * ★ THE INVARIANT, STATED ONCE. An account's organizations are the rows in
 *   `app_user_organization`; which one it SIGNS IN TO is `app_user.organization_id`;
 *   and the second is always one of the first. No constraint says so — the two are
 *   in different tables and the foreign keys each only prove their own column
 *   points at a real organization — so every writer has to hold it. This file is a
 *   writer, so it holds it here rather than in three places.
 *
 * ★ IT IS IDEMPOTENT AND IT REPORTS ONLY WHEN IT CHANGED SOMETHING. The ordinary
 *   run of this script changes a password and nothing else, and an operator reading
 *   its output should be able to tell those two apart at a glance. So a membership
 *   that is already there prints nothing; one that had to be written prints a line
 *   saying it was missing, which is a fact about the store worth knowing.
 *
 * ★ A NULL SIGN-IN ORGANIZATION IS REPORTED, NOT SKIPPED. There is no membership to
 *   write and the account cannot sign in at all — `actorFor()` refuses it with a 403
 *   — so this is the case where an operator has just set a password on an account
 *   and would otherwise reasonably believe they had finished.
 */
async function recordMembership(
  userId: number,
  organizationId: number | null,
  email: string,
): Promise<void> {
  if (organizationId === null) {
    console.log(
      `\n⚠  "${email}" has no sign-in organization, so it still cannot sign in. The password is set ` +
        'and the account is still locked out. Give it one on the Users & roles screen.',
    );
    return;
  }

  const held = await one<{ user_id: number }>(
    'SELECT user_id FROM app_user_organization WHERE user_id = ? AND organization_id = ?',
    [userId, organizationId],
  );
  if (held !== null) return;

  await execute(
    'INSERT INTO app_user_organization (user_id, organization_id) VALUES (?, ?)',
    [userId, organizationId],
  );
  console.log(
    `\nrecorded: account ${userId} → organization ${organizationId}. The sign-in organization was not ` +
      'in the membership table; it is now.',
  );
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.email === null) {
    throw new Error('--email <address> is required.');
  }
  // The sign-in path lower-cases the address before looking it up, so storing any
  // other case would create a row that can never be found.
  const email = opts.email.trim().toLowerCase();
  if (email === '' || !email.includes('@')) {
    throw new Error(`"${opts.email}" does not look like an email address.`);
  }

  if (opts.role !== null && !ROLES.includes(opts.role as Role)) {
    throw new Error(`--role must be one of ${ROLES.join(', ')} — got "${opts.role}".`);
  }
  if (!opts.create && (opts.name !== null || opts.role !== null || opts.org !== null)) {
    throw new Error(
      '--name, --role and --org only apply when creating an account. Add --create, or drop them.',
    );
  }

  // ★ BEFORE ANY WRITE. `password_hash` is added to an existing store by a lazily
  //   applied migration, so on a store that has never served a sign-in the column
  //   does not exist yet and an UPDATE naming it fails with a missing-column error
  //   rather than anything an operator can act on.
  await requireAppSchema('Set password');

  console.log(`store : ${config.appDb.label}`);
  console.log(`email : ${email}`);

  const password = await readPassword(opts);
  const hash = await hashPassword(password);

  const existing = await one<{ id: number; display_name: string; role: string; organization_id: number | null }>(
    'SELECT id, display_name, role, organization_id FROM app_user WHERE email = ?',
    [email],
  );

  if (opts.create) {
    if (existing !== null) {
      throw new Error(
        `"${email}" already exists (id ${existing.id}, name "${existing.display_name}"). ` +
          'Drop --create to replace its password, or use a different address.',
      );
    }
    const organizationId = opts.org === null ? await defaultOrganizationId() : await organizationIdFor(opts.org);
    // `staff` and not the most capable name: the column's own default is `staff`
    // for the reason `01-app.sql` gives — it is the role that grants least, so a
    // forgotten flag produces the account that can do the least rather than the one
    // that can do everything. An operator who wants more says so.
    const role: Role = (opts.role as Role | null) ?? 'staff';
    const name = opts.name ?? email;

    const result = await execute(
      'INSERT INTO app_user (email, display_name, role, organization_id, password_hash) ' +
        'VALUES (?, ?, ?, ?, ?)',
      [email, name, role, organizationId, hash],
    );
    // ★ THE ID IS READ BACK RATHER THAN TAKEN FROM `lastInsertRowid`, BECAUSE ON
    //   TWO OF THE THREE STORES THAT FIELD IS ALWAYS `null`. libSQL reports it;
    //   `db/sqlserver.ts` and `db/oracle.ts` both return `null` by design, since
    //   T-SQL needs a `SELECT SCOPE_IDENTITY()` and Oracle has no such concept.
    //   The old line printed the literal "?" under either of them — a success
    //   message with a hole in the middle of it, on the flag an operator reaches
    //   for when they are already unsure whether the write happened.
    const created = await one<{ id: number }>('SELECT id FROM app_user WHERE email = ?', [email]);

    // ★ THE INSERT IS NOT TRUSTED TO HAVE PRODUCED AN ID. The address is unique, so
    //   this read either names the row just written or names nothing — and naming
    //   nothing means the insert did not happen, whatever it reported. The old code
    //   printed a "?" here and carried on.
    const createdId = created?.id ?? result.lastInsertRowid ?? null;
    if (createdId === null) {
      throw new Error(
        `The insert reported success but "${email}" cannot be read back, so no membership could be ` +
          'recorded. Nothing is known to have been written.',
      );
    }

    // ★ THE MEMBERSHIP ROW, AND IT IS NOT DECORATION. `organization_id` above is
    //   which organization this account SIGNS IN TO; this table is which ones it
    //   BELONGS TO, and the sign-in organization is always one of them. Leaving it
    //   out would leave a row the Users & roles screen reads as an account with a
    //   sign-in organization and no memberships — a state `PATCH /api/users/{id}`
    //   would refuse to produce, produced here instead.
    await recordMembership(createdId, organizationId, email);

    console.log(
      `\ncreated : id ${createdId} · "${name}" · ${role} · org ${organizationId}`,
    );
    console.log('The password is set. That account can sign in now.');
    return;
  }

  if (existing === null) {
    throw new Error(
      `No account has the address "${email}", so nothing was written. If you meant to create it, add ` +
        '--create (with an optional --name, --role and --org).',
    );
  }

  const result = await execute('UPDATE app_user SET password_hash = ? WHERE email = ?', [hash, email]);
  // Not assumed. An UPDATE that matched nothing returns 0 and would otherwise look
  // exactly like one that worked.
  if (result.rowsAffected === 0) {
    throw new Error(`The UPDATE matched no row for "${email}", though the lookup found one. Nothing changed.`);
  }

  console.log(
    `\nupdated : id ${existing.id} · "${existing.display_name}" · ${existing.role}\n` +
      'The old password, if there was one, no longer works. Sessions already issued are unaffected — ' +
      'they expire on their own twelve hours after they were minted.',
  );

  // A repaired line, or none at all. See `recordMembership`.
  await recordMembership(existing.id, existing.organization_id, email);
}

main().catch((err: unknown) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
