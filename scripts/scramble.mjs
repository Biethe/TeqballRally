/**
 * The model scrambler, in plain JavaScript so Node can run it.
 *
 * The game needs this inside its bundle (`src/protected.ts`) and the build
 * script needs it before a bundle exists, which is two copies of one
 * algorithm — and two copies that drift apart produce a build scrambled with
 * one keystream and unscrambled with another, which fails as *every model in
 * the game refusing to load at once*. This is the copy Node uses;
 * `tests/protected.test.ts` holds the two to producing identical bytes.
 */

/** A 32-bit hash of the key and the file's own name. Never zero. */
export function seedFor(key, name) {
  let h = 2166136261;
  for (const text of [key, name]) {
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
  }
  return h >>> 0 || 1;
}

/**
 * XOR a buffer with the keystream for `name`, in place. Its own inverse.
 *
 * xorshift32, with `Math.imul` and `>>> 0` keeping the arithmetic exact in
 * both Node and a WebView.
 */
export function scramble(bytes, key, name) {
  let state = seedFor(key, name);
  for (let i = 0; i < bytes.length; i++) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    bytes[i] ^= state & 0xff;
  }
  return bytes;
}

/** The extension a scrambled model wears. Deliberately not `.glb`. */
export const PROTECTED_EXT = ".teq";
