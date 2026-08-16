/**
 * Model encryption, in plain JavaScript so Node can run it.
 *
 * **AES-256-GCM**, which is real, authenticated encryption: without the key
 * the ciphertext is indistinguishable from noise, and a single altered byte
 * makes decryption fail rather than yield rubbish. That is a different claim
 * from the keystream XOR this replaced, which anybody could unpick from the
 * file alone by guessing at the glTF header.
 *
 * The honest caveat is unchanged and is about **key distribution, not the
 * cipher**: a packaged game has to decrypt its own models on a device with no
 * network, so the key ships with it. See `src/protected.ts`.
 *
 * The game needs this inside its bundle and the build script needs it before a
 * bundle exists, so the algorithm is written twice. Two copies that drift
 * apart produce a build encrypted with one key and decrypted with another,
 * which fails as *every model in the game refusing to load at once*;
 * `tests/protected.test.ts` holds the two to agreeing.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** The extension an encrypted model wears. Deliberately not `.glb`. */
export const PROTECTED_EXT = ".teq";

/** Bytes of IV and authentication tag on the front of every encrypted file. */
export const IV_BYTES = 12;
export const TAG_BYTES = 16;

/**
 * A 256-bit key from a passphrase of any length.
 *
 * SHA-256 rather than a KDF with a work factor on purpose: a work factor
 * protects a *secret* passphrase from being brute-forced, and this one is not
 * secret — it ships in the bundle. Stretching it would cost startup time on a
 * phone and buy nothing.
 */
export function keyFrom(passphrase) {
  return createHash("sha256").update(String(passphrase), "utf8").digest();
}

/**
 * Encrypt one model. Returns `[IV][ciphertext][tag]`.
 *
 * A fresh random IV per file, which is what GCM requires: the same key with a
 * repeated IV leaks the relationship between the two plaintexts, and every
 * model here begins with the same glTF header.
 */
export function encryptModel(bytes, passphrase) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(passphrase), iv);
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]);
}

/** Decrypt one model, for the test that proves the round trip. Throws if tampered. */
export function decryptModel(bytes, passphrase) {
  const buf = Buffer.from(bytes);
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const body = buf.subarray(IV_BYTES, buf.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(passphrase), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}
