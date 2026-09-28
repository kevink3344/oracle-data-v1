import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing for `app_user.password_hash`.
 *
 * WHY THIS EXISTS AT ALL
 *   Until now the membership path had no secret to check: an address found in
 *   `app_user` signed in on the strength of being a row in `app_user`. That made
 *   an address an identity *claim* rather than a proof — anybody who typed a
 *   colleague's address was that colleague. This module is the missing half:
 *   a stored, salted, one-way derivative that the typed password is compared
 *   against, so the claim has to be backed.
 *
 * ★ SCRYPT FROM `node:crypto`, NOT A PACKAGE, AND WHY THAT IS THE RIGHT CALL HERE
 *   `argon2id` is the better primitive on paper and it is the one to reach for if
 *   this ever grows a fleet. It is also a native addon, which means a compiler on
 *   every machine that installs this server, a rebuild when Node changes ABI, and
 *   a build step that can fail for reasons unrelated to this application. This
 *   project has one server and one operator. `scrypt` is memory-hard, it is in the
 *   platform, and it is the algorithm Node's own documentation points at for
 *   exactly this. Adding a dependency is a decision to make deliberately later,
 *   not a thing to do because it is fashionable now.
 *
 * ★ THE STORED FORM CARRIES ITS OWN PARAMETERS, AND THAT IS THE WHOLE POINT
 *   The string is `scrypt$N$r$p$<salt>$<key>`. A bare hash would fix the cost
 *   parameters for all time: raising them later would silently invalidate every
 *   existing password, because the old rows could no longer be recomputed. Here
 *   the parameters travel with each row, so a future change can hash new passwords
 *   more expensively while still verifying the ones written today. `verifyPassword`
 *   reads the parameters *out of the stored value* rather than from the constants
 *   below, and that asymmetry is deliberate: the constants are for writing, the
 *   stored value is for reading.
 *
 * ★ A MALFORMED OR ABSENT HASH IS NOT AN ERROR, IT IS A REFUSAL
 *   `verifyPassword` answers `false` for `null`, for `''`, and for anything it
 *   cannot parse. It does not throw and it does not report which part was wrong.
 *   Two reasons. The caller's job on `false` is to refuse the sign-in, and a
 *   thrown error there would have to be caught and translated into the same
 *   refusal — more machinery for the same outcome. And a distinguishable
 *   "your row has no password set" answer is a fact about somebody else's
 *   account, which an unauthenticated caller has no business learning.
 */

/** The only algorithm this module writes. Named in the stored string so it can change. */
const ALGORITHM = 'scrypt';

/**
 * The cost parameters used for *new* passwords.
 *
 * `N` is the CPU/memory cost — 2^14. `r` is the block size and `p` the
 * parallelisation, both at the values Node's documentation uses. Together they
 * ask for roughly 16 MB and a few milliseconds per hash on a developer machine,
 * which is the point: cheap enough that a sign-in does not feel slow, expensive
 * enough that a stolen table is not a wordlist run.
 *
 * ★ THESE ARE READ ONLY WHEN WRITING. Verification uses the values stored in the
 *   string it was handed, so raising these does not lock anybody out.
 */
const N = 16384;
const R = 8;
const P = 1;

/** Length of the derived key, in bytes. 64 is comfortably beyond guessing. */
const KEY_LENGTH = 64;

/** Salt length in bytes. Random per hash, so two identical passwords differ on disk. */
const SALT_LENGTH = 16;

/**
 * The memory ceiling handed to `scrypt`.
 *
 * `scrypt` requires `128 * N * r` bytes and refuses to run if that exceeds
 * `maxmem`, whose default is 32 MB. The requirement at the settings above is
 * 16 MB, so the default would in fact pass — but only just, and the failure mode
 * when it does not is a thrown error at sign-in time rather than anything
 * readable. Twice the requirement makes the headroom explicit.
 */
const MAX_MEM = 128 * N * R * 2;

/** The parameters read back out of a stored string. */
interface StoredHash {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

/**
 * `scrypt` as a promise, written out rather than `promisify`-ed.
 *
 * `promisify` cannot express this function's overloads usefully — it types the
 * options argument away, so the call site would lose the `N`/`r`/`p` names that
 * are the entire reason to call it directly. Fifteen lines of callback plumbing
 * is the cheaper half of that trade.
 */
function derive(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/**
 * Hash a password for storage. Never returns the password, and never returns
 * anything from which it can be recovered.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: MAX_MEM });
  return [ALGORITHM, N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

/**
 * Parse the stored form. `null` means "this is not a hash this module wrote",
 * which is treated as a refusal by `verifyPassword` rather than as a crash.
 */
function parseStored(stored: string): StoredHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6) return null;
  const [algorithm, nRaw, rRaw, pRaw, saltRaw, keyRaw] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (algorithm !== ALGORITHM) return null;

  const n = Number.parseInt(nRaw, 10);
  const r = Number.parseInt(rRaw, 10);
  const p = Number.parseInt(pRaw, 10);
  // Every one of these is fed to `scrypt` as a resource request, so a row is not
  // allowed to ask for an unbounded amount of memory: the ceiling is checked
  // here, against the same constant writing uses, rather than trusted.
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return null;
  if (n < 2 || r < 1 || p < 1 || 128 * n * r > MAX_MEM) return null;

  const salt = Buffer.from(saltRaw, 'base64');
  const key = Buffer.from(keyRaw, 'base64');
  if (salt.length === 0 || key.length === 0) return null;

  return { n, r, p, salt, key };
}

/**
 * Does `password` produce the stored hash?
 *
 * Answers `false` — never throws — for an absent, empty, or malformed stored
 * value. See the header for why that is the contract rather than an oversight.
 */
export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (stored === null || stored === undefined || stored === '') return false;
  const parsed = parseStored(stored);
  if (parsed === null) return false;

  // Key length comes from the *stored* key, not from `KEY_LENGTH`, so a row
  // written under an older setting still verifies.
  const key = await derive(password, parsed.salt, parsed.key.length, {
    N: parsed.n,
    r: parsed.r,
    p: parsed.p,
    maxmem: MAX_MEM,
  });

  // `timingSafeEqual` throws on a length mismatch, so the length is checked
  // first — it is a fixed property of the stored string, not of the secret.
  if (key.length !== parsed.key.length) return false;
  return timingSafeEqual(key, parsed.key);
}

/**
 * A hash standing in for one that does not exist.
 *
 * ★ WHY THE SIGN-IN PATH NEEDS THIS
 *   Verifying a password for a known address costs one `scrypt` run. Refusing an
 *   *unknown* address, with nothing to compare against, costs a database probe
 *   and a string comparison — orders of magnitude less. Left alone, that
 *   difference is measurable from outside and turns the sign-in endpoint into a
 *   way to ask "does this address have an account here?", which is exactly the
 *   question the identical error message exists to refuse. So the unknown-address
 *   path verifies against this, spends the same time, and reveals nothing.
 *
 * Computed once per process, lazily, and never connected to a real account: the
 * password below is a constant, so no typed password can be a match for it in any
 * meaningful sense — the comparison's only purpose is to take the same time.
 */
let standIn: Promise<string> | null = null;

export function standInHash(): Promise<string> {
  standIn ??= hashPassword('not a password for any account');
  return standIn;
}
