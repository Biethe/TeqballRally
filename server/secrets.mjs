import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The two secrets an account has, and how they are kept.
 *
 * Neither is stored as it was issued. A database snapshot that leaks — a
 * misconfigured rule, a backup on the wrong bucket — should not hand anybody
 * every account in the game, and there is no reason for the server to be able
 * to read them back. It only ever needs to recognise one.
 *
 *   token         48 hex characters, on the device, sent with every request.
 *                 Stored as a plain SHA-256 because it is also the lookup key
 *                 and has 192 bits behind it — nothing to brute-force.
 *
 *   recovery code 16 Crockford characters in four groups, shown once and
 *                 written down. Salted, because it is short enough to be typed
 *                 by a person and therefore short enough to be attacked in a
 *                 leaked table without one.
 */

/** Crockford base32: no I, L, O or U, so a code survives being read aloud. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Groups of four, separated by hyphens: TEQ1-2ABC-3DEF-4GHJ. */
const RECOVERY_GROUPS = 4;
const RECOVERY_GROUP_SIZE = 4;

export const TOKEN_LENGTH = 48;

export function mintToken() {
  return randomBytes(TOKEN_LENGTH / 2).toString("hex");
}

/** The key a token is found by. Deterministic, so it can index the store. */
export function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

/** A fresh recovery code, and the salted digest to keep instead of it. */
export function mintRecovery() {
  const bytes = randomBytes(RECOVERY_GROUPS * RECOVERY_GROUP_SIZE);
  const groups = [];
  for (let g = 0; g < RECOVERY_GROUPS; g++) {
    let group = "";
    for (let i = 0; i < RECOVERY_GROUP_SIZE; i++) {
      group += ALPHABET[bytes[g * RECOVERY_GROUP_SIZE + i] % ALPHABET.length];
    }
    groups.push(group);
  }
  const code = groups.join("-");
  const salt = randomBytes(16).toString("hex");
  return { code, salt, hash: recoveryHash(code, salt) };
}

/**
 * Normalise a typed recovery code.
 *
 * People will type it in lower case, leave the hyphens out, or put spaces in.
 * None of that should be the difference between getting an account back and
 * not.
 */
export function tidyRecovery(raw) {
  if (typeof raw !== "string") return "";
  // Only the three letters Crockford's own decoder folds: O reads as zero, I
  // and L read as one. Nothing else — Q is *in* the alphabet, and folding it
  // to zero (as an earlier version did) meant any code containing a Q could
  // never be typed back in. U is left alone: it is not in the alphabet, so a
  // code containing one is simply wrong, and quietly turning it into a V would
  // hide that.
  const cleaned = raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  const groups = [];
  for (let i = 0; i < cleaned.length; i += RECOVERY_GROUP_SIZE) {
    groups.push(cleaned.slice(i, i + RECOVERY_GROUP_SIZE));
  }
  return groups.join("-");
}

export function recoveryHash(code, salt) {
  return createHash("sha256").update(`${salt}:${code}`).digest("hex");
}

/** Constant-time comparison of two hex digests. */
export function digestsMatch(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** The shape a typed code has to have before it is worth checking. */
export function looksLikeRecovery(tidied) {
  const groups = tidied.split("-");
  return (
    groups.length === RECOVERY_GROUPS &&
    groups.every((g) => g.length === RECOVERY_GROUP_SIZE && [...g].every((c) => ALPHABET.includes(c)))
  );
}
