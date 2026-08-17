/**
 * Asset encryption, in plain JavaScript so Node can run it.
 *
 * **AES-256-GCM**, which is real, authenticated encryption: without the key
 * the ciphertext is indistinguishable from noise, and a single altered byte
 * makes decryption fail rather than yield rubbish. That is a different claim
 * from the keystream XOR this replaced, which anybody could unpick from the
 * file alone by guessing at the glTF header.
 *
 * This covers every shipped asset — models, textures, venue cards, audio and
 * the intro clip — rather than the `.glb` files alone. Encrypting the models
 * while serving the textures and the music beside them protected the most
 * expensive third of a build and left the rest in a folder.
 *
 * The honest caveat is unchanged and is about **key distribution, not the
 * cipher**: a packaged game has to decrypt its own assets on a device with no
 * network, so the key ships with it. See `src/protected.ts`. What the key
 * *cannot* do any more is come out of this repository, because the plaintext
 * art is no longer in it — see `scripts/fetch-assets.mjs`.
 *
 * The game needs this inside its bundle and the build script needs it before a
 * bundle exists, so the algorithm is written twice. Two copies that drift
 * apart produce a build encrypted with one key and decrypted with another,
 * which fails as *every asset in the game refusing to load at once*;
 * `tests/protected.test.ts` holds the two to agreeing.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** The extension an encrypted asset wears. Deliberately not `.glb`. */
export const PROTECTED_EXT = ".teq";

/** Bytes of IV and authentication tag on the front of every encrypted file. */
export const IV_BYTES = 12;
export const TAG_BYTES = 16;

/**
 * Which files are encrypted, by extension.
 *
 * The build walks `dist/` with this list and the game consults it before every
 * fetch, so a file either appears in both or in neither. Anything protected on
 * disk but not recognised at runtime is a 404 in a release build and nowhere
 * else — the exact failure `src/main.ts` was already shipping before this list
 * existed. `tests/protected.test.ts` holds the two copies to agreeing.
 *
 * Not everything under `assets/` belongs here:
 *
 * - `.woff2` and `OFL.txt` are Exo 2, under the Open Font Licence, which is
 *   redistributable by design. Encrypting them would break `@font-face`, since
 *   CSS `url()` cannot be handed a decrypted blob without JavaScript rewriting
 *   the stylesheet.
 * - `meshopt_decoder.js` is a third-party decoder Babylon fetches by URL and
 *   evaluates; it is public, and it has to stay a script.
 * - `.fbx` never reaches `dist/` at all — see `ART_SOURCE_DIR`.
 */
export const PROTECTED_EXTENSIONS = [
  ".glb",
  ".vat",
  ".webp",
  ".jpg",
  ".mp3",
  ".wav",
  ".mp4",
];

/**
 * Directories under `dist/` whose contents are encrypted, relative to the
 * build output root.
 *
 * A list rather than a walk of all of `dist/`, because `dist/assets/` is
 * Vite's bundle directory — the hashed JS and CSS, plus any image imported
 * from `src/`. Encrypting those would break the page before a line of game
 * code ran, and they are referenced by hashed URLs nothing here rewrites.
 */
export const PROTECTED_DIRS = ["models", "textures", "venues", "video", "audio"];

/**
 * Where the raw art lives, outside `assets/` on purpose.
 *
 * Vite copies all of `publicDir` to the root of `dist/`, with no way to
 * exclude a subdirectory. While the Mixamo `.fbx` rigs sat in
 * `assets/source-animations/`, every deployed build served them at
 * `/source-animations/crowd/Idle.fbx` — unencrypted, and the most directly
 * reusable files in the project. Keeping them outside `publicDir` is what
 * stops that, not a rule in this file.
 */
export const ART_SOURCE_DIR = "art-source";

/** Whether this path is one the build encrypts and the game must decrypt. */
export function isProtectedAsset(path) {
  const dot = path.lastIndexOf(".");
  return dot !== -1 && PROTECTED_EXTENSIONS.includes(path.slice(dot).toLowerCase());
}

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
 * Encrypt one asset. Returns `[IV][ciphertext][tag]`.
 *
 * A fresh random IV per file, which is what GCM requires: the same key with a
 * repeated IV leaks the relationship between the two plaintexts, and these
 * files come in groups that share a header byte for byte — every model opens
 * with the glTF magic, every texture with the WebP one.
 */
export function encryptAsset(bytes, passphrase) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(passphrase), iv);
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]);
}

/** Decrypt one asset, for the test that proves the round trip. Throws if tampered. */
export function decryptAsset(bytes, passphrase) {
  const buf = Buffer.from(bytes);
  const iv = buf.subarray(0, IV_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const body = buf.subarray(IV_BYTES, buf.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(passphrase), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}
