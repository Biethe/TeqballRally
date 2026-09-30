import { describe, expect, it } from "vitest";
import {
  decryptAsset as browserDecrypt,
  isProtectedAsset,
  IV_BYTES,
  PROTECTED_EXT,
  PROTECTED_EXTENSIONS,
  assetCacheToken,
  sourceUrl,
  TAG_BYTES,
} from "../src/protected";
import {
  decryptAsset,
  encryptAsset,
  keyFrom,
  isProtectedAsset as nodeIsProtected,
  IV_BYTES as NODE_IV,
  PROTECTED_EXT as NODE_EXT,
  PROTECTED_EXTENSIONS as NODE_EXTENSIONS,
  TAG_BYTES as NODE_TAG,
} from "../scripts/scramble.mjs";

/**
 * Asset encryption.
 *
 * Two properties carry it, and both fail silently: a cipher that does not
 * round-trip ships a game whose assets will not load, and one that leaves the
 * glTF header recognisable ships models anybody can open by renaming the file.
 * Neither shows up in a build log.
 *
 * The scheme is written twice — `scripts/scramble.mjs` for the build, which
 * runs before a bundle exists, and `src/protected.ts` for the game — and
 * *both* halves of it are duplicated: the cipher, and the list of which
 * extensions get encrypted. Drift in the cipher fails as every asset refusing
 * to load at once. Drift in the list is worse, because it is partial: an
 * extension the build encrypts and the game does not is a 404 for those files
 * only, in release builds only, with nothing in any log to say why. That is
 * precisely how the `.glb` prefetches went unnoticed.
 *
 * The round trip below crosses the boundary for real: Node encrypts, WebCrypto
 * decrypts.
 */

// `globalThis.crypto` is WebCrypto in Node 18+, which is the same API the
// browser gives `src/protected.ts` — so this round trip is the real one.

// An arbitrary passphrase for the round trip. Deliberately not a default the
// build could fall back to — `scripts/protect-assets.mjs` refuses to run
// without `VITE_ASSET_KEY`, precisely so no shipped build is encrypted with a
// string written in this repository.
const KEY = "a-passphrase-for-the-tests";
const model = (n = 512) =>
  Uint8Array.from({ length: n }, (_, i) => (i < 4 ? [0x67, 0x6c, 0x54, 0x46][i] : (i * 37) % 256));

describe("encrypting an asset", () => {
  it("round-trips through its own decryption", () => {
    const original = model();
    const back = decryptAsset(encryptAsset(original, KEY), KEY);

    expect([...back]).toEqual([...original]);
  });

  it("what Node encrypts, the game decrypts", async () => {
    // The claim the whole scheme rests on, checked across the real boundary
    // rather than against a second copy of the same code.
    const original = model();
    const sealed = encryptAsset(original, KEY);
    const opened = await browserDecrypt(
      sealed.buffer.slice(sealed.byteOffset, sealed.byteOffset + sealed.byteLength) as ArrayBuffer
    );

    expect([...new Uint8Array(opened)]).toEqual([...original]);
  });

  it("names a failed decrypt instead of a bare OperationError", async () => {
    const sealed = encryptAsset(model(), "not-the-test-key");
    await expect(
      browserDecrypt(
        sealed.buffer.slice(sealed.byteOffset, sealed.byteOffset + sealed.byteLength) as ArrayBuffer
      )
    ).rejects.toThrow(/cached from an older build/i);
  });

  it("leaves nothing of the glTF header to recognise", () => {
    // "glTF" in the first four bytes is what every tool sniffs for, and what
    // makes an extracted file worth extracting.
    const sealed = encryptAsset(model(), KEY);
    const header = [...sealed.subarray(IV_BYTES, IV_BYTES + 4)];

    expect(header).not.toEqual([0x67, 0x6c, 0x54, 0x46]);
  });

  it("encrypts the same model differently every time", () => {
    // A fresh IV per file. Reusing one under a shared key leaks the
    // relationship between two plaintexts, and every model here opens with the
    // same header — which is exactly the pair an attacker would want.
    const a = encryptAsset(model(), KEY);
    const b = encryptAsset(model(), KEY);

    expect([...a]).not.toEqual([...b]);
  });

  it("refuses a file that has been tampered with", () => {
    // Authenticated encryption: a flipped byte fails rather than decrypting to
    // plausible rubbish that Babylon would then try to parse.
    const sealed = encryptAsset(model(), KEY);
    sealed[IV_BYTES + 10] ^= 0xff;

    expect(() => decryptAsset(sealed, KEY)).toThrow();
  });

  it("refuses the wrong key", () => {
    expect(() => decryptAsset(encryptAsset(model(), KEY), "not-the-key")).toThrow();
  });

  it("derives a 256-bit key from a passphrase of any length", () => {
    for (const passphrase of ["", "k", "a much longer passphrase than that one"]) {
      expect(keyFrom(passphrase), passphrase).toHaveLength(32);
    }
  });

  it("costs a fixed, small overhead per file", () => {
    // The IV and the tag, and nothing else: the download budget is the reason
    // these models were compressed in the first place.
    const original = model(4096);
    expect(encryptAsset(original, KEY).length).toBe(original.length + IV_BYTES + TAG_BYTES);
  });

  it("handles an empty file without throwing", () => {
    expect([...decryptAsset(encryptAsset(new Uint8Array(0), KEY), KEY)]).toEqual([]);
  });
});

describe("the two copies of the format", () => {
  it("agree on the layout", () => {
    expect(NODE_IV).toBe(IV_BYTES);
    expect(NODE_TAG).toBe(TAG_BYTES);
    expect(NODE_EXT).toBe(PROTECTED_EXT);
  });

  it("agree on which files are encrypted", () => {
    // The list the build walks and the list the game consults. One entry in
    // one of them and not the other ships a release where that file type 404s
    // and nothing else does.
    expect([...NODE_EXTENSIONS].sort()).toEqual([...PROTECTED_EXTENSIONS].sort());
  });

  it("agree file by file, including on what stays plain", () => {
    const cases = [
      // Protected: every category of shipped art.
      "/models/characters/FrenchPlayer.glb",
      "/models/Crowd/Caleb.vat",
      "/textures/grass.webp",
      "/venues/tennis.jpg",
      "/audio/music/music_loop_1.mp3",
      "/audio/sfx/kick.wav",
      "/video/intro.mp4",
      // Plain, and deliberately so: an OFL font Vite reaches through
      // `@font-face`, the licence beside it, and the third-party decoder
      // Babylon fetches and evaluates as a script.
      "/fonts/exo2-latin.woff2",
      "/fonts/OFL.txt",
      "/meshopt_decoder.js",
    ];
    for (const path of cases) {
      expect(nodeIsProtected(path), path).toBe(isProtectedAsset(path));
    }
  });

  it("recognises an extension whatever its case", () => {
    // Windows exports arrive as `.JPG` more often than anyone expects, and one
    // that slips the list ships in the clear next to the encrypted files.
    expect(isProtectedAsset("/venues/Gym.JPG")).toBe(true);
    expect(nodeIsProtected("/venues/Gym.JPG")).toBe(true);
  });

  it("does not mistake a query string for an extension", () => {
    expect(isProtectedAsset("/models/x.glb?v=2")).toBe(true);
    expect(isProtectedAsset("/api/thing?f=.glb")).toBe(false);
  });
});

describe("resolving an asset path", () => {
  // Vitest leaves `VITE_PROTECTED_ASSETS` unset, so this is the plain-build
  // path: the dev server serves `assets/` directly and nothing is rewritten.
  it("leaves every path alone in an unprotected build", () => {
    for (const path of ["/models/x.glb", "/textures/grass.webp", "/fonts/exo2-latin.woff2"]) {
      expect(sourceUrl(path)).toBe(path);
    }
  });

  it("stamps two passphrases as different cache tokens", () => {
    // Same path, new key: the query string must change, or a browser that
    // cached yesterday's .teq feeds it to today's decrypt and throws
    // OperationError with no message.
    expect(assetCacheToken("one-key")).not.toBe(assetCacheToken("another-key"));
    expect(assetCacheToken("one-key")).toBe(assetCacheToken("one-key"));
  });
});
